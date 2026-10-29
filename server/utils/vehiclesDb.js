// Vehicle database helper for the chunk cleaner.
// PZ saves store all persisted vehicles in <save>/vehicles.db (SQLite).
// Schema (B41 & B42 identical):
//   CREATE TABLE vehicles (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     wx INTEGER,        -- world chunk X
//     wy INTEGER,        -- world chunk Y
//     x  FLOAT,          -- world tile X (absolute)
//     y  FLOAT,          -- world tile Y (absolute)
//     worldversion INTEGER,
//     data BLOB          -- serialized vehicle state
//   )
// with indexes on wx and wy only, committed with PRAGMA JOURNAL_MODE=TRUNCATE.
//
// We must operate on the DB directly because the PanelBridge runtime path only
// removes vehicles that are currently *loaded* in memory. Vehicles in cells not
// actively streamed by any player stay untouched in vehicles.db and re-materialize
// as soon as a player re-enters the cell — even if map/X/Y.bin was deleted.
//
// Uses sql.js (pure-JS WASM SQLite, started by sqlJs.js) so it works inside pkg
// binaries without any native build toolchain or per-platform prebuilds. The
// file is read, checked and rewritten through gameSqliteFile.js (the game's
// folder is not the panel's to trust; see that file's header).

import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';
import { getSqlJs } from './sqlJs.js';
import {
  assertPlainTables,
  fileModeOf,
  GameDbFileError,
  hasUnfinishedTransaction,
  readGameDbFile,
  replaceGameDbFile,
  withGameDbLoadSlot,
  writeNewFile,
} from './gameSqliteFile.js';

const log = createLogger('VehiclesDB');

const VEHICLES_DB = 'vehicles.db';
const UNFINISHED_TRANSACTION_REASON =
  'vehicles.db has an unfinished transaction from an unclean server stop. Start the server and stop it once so the game can recover it, then try again.';

// Rows deleted per `DELETE ... WHERE rowid IN (...)` statement.
const DELETE_BATCH = 500;
// Temp files an older panel left behind when a rewrite failed (R2-25),
// removed when a cleanup starts once they are clearly not in use.
const STALE_TMP_RE = /^vehicles\.db\.tmp-[A-Za-z0-9-]+$/;
const STALE_TMP_AGE_MS = 60 * 60 * 1000;

/**
 * Load vehicles.db (safely, inside a load slot), check that `vehicles` is a
 * plain table, and run fn on it. Nothing is written back.
 */
async function withVehiclesDb(dbPath, fn, { noTriggers = false } = {}) {
  const SQL = await getSqlJs();
  return withGameDbLoadSlot(async () => {
    const file = await readGameDbFile(dbPath);
    const db = new SQL.Database(file.buffer);
    try {
      assertPlainTables(db, VEHICLES_DB, ['vehicles'], { noTriggers });
      return await fn(db, file);
    } finally {
      db.close();
    }
  });
}

// Result cache for listPersistedVehicles, keyed by the file's identity, size
// and mtime: an unchanged vehicles.db is never loaded again, and concurrent
// callers share one load (R2-18). A few saves at most.
const persistedCache = new Map();
const persistedInFlight = new Map();
const PERSISTED_CACHE_MAX = 4;

function rememberPersisted(dbPath, key, vehicles) {
  persistedCache.delete(dbPath);
  persistedCache.set(dbPath, { key, vehicles });
  while (persistedCache.size > PERSISTED_CACHE_MAX) {
    persistedCache.delete(persistedCache.keys().next().value);
  }
}

async function readPersistedVehicles(dbPath, safeLimit) {
  return withVehiclesDb(dbPath, (db) => {
    const stmt = db.prepare(
      'SELECT id, x, y FROM vehicles WHERE x IS NOT NULL AND y IS NOT NULL LIMIT ?'
    );
    const vehicles = [];
    try {
      stmt.bind([safeLimit]);
      while (stmt.step()) {
        const row = stmt.getAsObject();
        const id = Number(row.id);
        const x = Number(row.x);
        const y = Number(row.y);
        if (Number.isFinite(id) && Number.isFinite(x) && Number.isFinite(y)) {
          vehicles.push({ id, x, y });
        }
      }
    } finally {
      stmt.free();
    }
    return vehicles;
  });
}

/**
 * List persisted vehicle positions without modifying the live save database.
 * Runtime bridge data only includes currently loaded cells; this covers parked
 * vehicles while no player is near them.
 *
 * @param {string} savePath Absolute path to the save directory
 * @param {number} [limit]
 * @returns {Promise<Array<{id:number,x:number,y:number}>>}
 */
export async function listPersistedVehicles(savePath, limit = 10000) {
  const dbPath = path.join(savePath, VEHICLES_DB);
  const safeLimit = Math.max(1, Math.min(50000, Math.floor(limit) || 10000));
  let stat;
  try {
    stat = await fs.promises.lstat(dbPath, { bigint: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') log.warn(`listPersistedVehicles failed on ${dbPath}: ${err.message}`);
    return [];
  }
  if (!stat.isFile()) {
    log.warn(`listPersistedVehicles skipped ${dbPath}: not a regular file`);
    return [];
  }
  const key = `${safeLimit}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  const cached = persistedCache.get(dbPath);
  if (cached && cached.key === key) return cached.vehicles;

  const flightKey = `${dbPath}\0${key}`;
  let flight = persistedInFlight.get(flightKey);
  if (!flight) {
    flight = readPersistedVehicles(dbPath, safeLimit)
      .then((vehicles) => {
        rememberPersisted(dbPath, key, vehicles);
        return vehicles;
      })
      .catch((err) => {
        log.warn(`listPersistedVehicles failed on ${dbPath}: ${err.message}`);
        return [];
      })
      .finally(() => {
        persistedInFlight.delete(flightKey);
      });
    persistedInFlight.set(flightKey, flight);
  }
  return flight;
}

/**
 * Index tile (or chunk) boxes on a uniform grid so each row is tested
 * against the few boxes near it: one pass over the table instead of one
 * full-table scan per box (R2-19; x and y have no index). Half-open boxes:
 * [x0, x1) × [y0, y1). Only numbers match, as in SQLite, where NULL, text
 * and blobs never fall inside a numeric range.
 */
function createBoxMatcher(boxes, gridSize) {
  const MAX_GRID_CELLS_PER_BOX = 4096;
  const grid = new Map();
  const wide = [];
  for (const b of boxes) {
    const gx0 = Math.floor(b.x0 / gridSize);
    const gx1 = Math.ceil(b.x1 / gridSize) - 1;
    const gy0 = Math.floor(b.y0 / gridSize);
    const gy1 = Math.ceil(b.y1 / gridSize) - 1;
    if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > MAX_GRID_CELLS_PER_BOX) {
      wide.push(b);
      continue;
    }
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const key = `${gx},${gy}`;
        const list = grid.get(key);
        if (list) list.push(b);
        else grid.set(key, [b]);
      }
    }
  }
  const inside = (b, x, y) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1;
  return (x, y) => {
    if (typeof x !== 'number' || typeof y !== 'number') return false;
    const list = grid.get(`${Math.floor(x / gridSize)},${Math.floor(y / gridSize)}`);
    if (list) {
      for (const b of list) if (inside(b, x, y)) return true;
    }
    for (const b of wide) if (inside(b, x, y)) return true;
    return false;
  };
}

function hasChunkBounds(b) {
  return Number.isFinite(b.wx0) && Number.isFinite(b.wx1)
    && Number.isFinite(b.wy0) && Number.isFinite(b.wy1)
    && b.wx1 > b.wx0 && b.wy1 > b.wy0;
}

function hasWxColumns(db) {
  // Should exist on all PZ versions, but be defensive — some early B42
  // builds/modded schemas may differ.
  try {
    const probe = db.prepare('SELECT wx, wy FROM vehicles LIMIT 1');
    probe.free();
    return true;
  } catch {
    return false;
  }
}

/** Row ids whose tile coords fall in a box, or whose chunk coords do. */
function findVehiclesInBoxes(db, boxes, { chunkPass }) {
  const inTileBox = createBoxMatcher(boxes, 64);
  const chunkBoxes = chunkPass
    ? boxes.filter(hasChunkBounds).map((b) => ({ x0: b.wx0, x1: b.wx1, y0: b.wy0, y1: b.wy1 }))
    : [];
  const inChunkBox = chunkBoxes.length > 0 ? createBoxMatcher(chunkBoxes, 8) : null;
  const stmt = db.prepare(
    inChunkBox ? 'SELECT rowid, x, y, wx, wy FROM vehicles' : 'SELECT rowid, x, y FROM vehicles'
  );
  const ids = [];
  try {
    while (stmt.step()) {
      const row = stmt.get();
      if (inTileBox(row[1], row[2]) || (inChunkBox && inChunkBox(row[3], row[4]))) {
        ids.push(row[0]);
      }
    }
  } finally {
    stmt.free();
  }
  return ids;
}

/**
 * Count vehicles in vehicles.db whose tile coords fall inside any of the
 * provided tile bounding boxes. Read-only.
 *
 * @param {string} savePath Absolute path to the save directory
 * @param {Array<{x0:number,y0:number,x1:number,y1:number}>} boxes Tile bboxes (half-open: [x0,x1))
 * @returns {Promise<number>} count (0 if vehicles.db missing)
 */
export async function countVehiclesInBoxes(savePath, boxes) {
  const dbPath = path.join(savePath, VEHICLES_DB);
  if (!fs.existsSync(dbPath)) return 0;
  if (!Array.isArray(boxes) || boxes.length === 0) return 0;
  try {
    return await withVehiclesDb(dbPath, (db) => findVehiclesInBoxes(db, boxes, { chunkPass: false }).length);
  } catch (err) {
    log.warn(`countVehiclesInBoxes failed on ${dbPath}: ${err.message}`);
    return 0;
  }
}

async function sweepStaleTempFiles(savePath) {
  let names;
  try {
    names = await fs.promises.readdir(savePath);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TMP_AGE_MS;
  for (const name of names) {
    if (!STALE_TMP_RE.test(name)) continue;
    const full = path.join(savePath, name);
    try {
      const stat = await fs.promises.lstat(full);
      if (stat.isFile() && stat.mtimeMs < cutoff) await fs.promises.unlink(full);
    } catch (err) {
      log.debug(`Could not remove stale ${name}: ${err.message}`);
    }
  }
}

/**
 * True when vehicles.db has an unfinished transaction next to it (a hot
 * journal or a WAL) that the game would play over an edited file. Map
 * Cleanup checks this before it deletes anything.
 *
 * @param {string} savePath Absolute path to the save directory
 */
export async function vehiclesDbHasUnfinishedTransaction(savePath) {
  return hasUnfinishedTransaction(path.join(savePath, VEHICLES_DB));
}

/**
 * Delete rows from vehicles.db for every vehicle whose tile coordinates fall
 * inside any of the provided tile bounding boxes.
 *
 * If a box also provides wx0/wx1/wy0/wy1 (chunk-coord bounds), those are
 * OR'd into the match. PZ stores both tile (x,y) and chunk (wx,wy)
 * coords on each vehicle row, and there are rare cases where a vehicle mid-
 * move has drifted tile coords out of sync with its chunk coords. Matching
 * on BOTH guarantees we catch everything the chunk file represented.
 *
 * This works whether the server is stopped or running, but the caller SHOULD
 * stop the server first — otherwise the running process may hold the DB file
 * open (on Windows) or write back stale state when it shuts down.
 *
 * @param {string} savePath Absolute path to the save directory
 * @param {Array<{x0:number,y0:number,x1:number,y1:number,wx0?:number,wx1?:number,wy0?:number,wy1?:number}>} boxes Tile bboxes (half-open: [x0,x1)), optionally with chunk-coord bboxes
 * @param {object}   [opts]
 * @param {string}   [opts.backupPath]  If set, a new file there gets vehicles.db's bytes before mutation
 * @returns {Promise<{deleted:number, skipped:boolean, reason?:string}>}
 */
export async function deleteVehiclesInBoxes(savePath, boxes, opts = {}) {
  const dbPath = path.join(savePath, VEHICLES_DB);
  if (!fs.existsSync(dbPath)) {
    return { deleted: 0, skipped: true, reason: 'vehicles.db not found (no persisted vehicles)' };
  }
  if (!Array.isArray(boxes) || boxes.length === 0) {
    return { deleted: 0, skipped: true, reason: 'no boxes provided' };
  }
  // Validate boxes — refuse NaN/Infinity that would match everything or nothing.
  for (const b of boxes) {
    if (!b
      || !Number.isFinite(b.x0) || !Number.isFinite(b.x1)
      || !Number.isFinite(b.y0) || !Number.isFinite(b.y1)
      || b.x1 <= b.x0 || b.y1 <= b.y0) {
      return { deleted: 0, skipped: true, reason: 'invalid bounding box' };
    }
  }

  try {
    // R2-24: the game would roll its journal back over our rewritten file.
    if (await hasUnfinishedTransaction(dbPath)) {
      throw new GameDbFileError(UNFINISHED_TRANSACTION_REASON);
    }
    await sweepStaleTempFiles(savePath);

    return await withVehiclesDb(dbPath, async (db, file) => {
      // Backup BEFORE any mutation so rollback is always possible. Written
      // from the bytes just read (the same ones edited below), into a new
      // file only.
      if (opts.backupPath) {
        try {
          await fs.promises.mkdir(path.dirname(opts.backupPath), { recursive: true });
          await writeNewFile(opts.backupPath, file.buffer, fileModeOf(file.stat));
        } catch (err) {
          log.warn(`Failed to backup vehicles.db to ${opts.backupPath}: ${err.message}`);
          return { deleted: 0, skipped: true, reason: `backup failed: ${err.message}` };
        }
      }

      // Verify table exists. Rather than poke sqlite_master (whose exact
      // layout differs between sql.js builds) we simply try to compile a
      // statement against the table — missing table throws SQLITE_ERROR.
      let hasTable = false;
      try {
        const probe = db.prepare('SELECT 1 FROM vehicles LIMIT 1');
        probe.free();
        hasTable = true;
      } catch (e) {
        log.warn(`vehicles.db at ${dbPath} has no 'vehicles' table (${e.message}) — skipping`);
      }
      if (!hasTable) {
        return { deleted: 0, skipped: true, reason: 'no vehicles table' };
      }

      const ids = findVehiclesInBoxes(db, boxes, { chunkPass: hasWxColumns(db) });
      if (ids.length === 0) return { deleted: 0, skipped: false };

      let deleted = 0;
      db.exec('BEGIN');
      try {
        let batchStmt = null;
        try {
          for (let i = 0; i < ids.length; i += DELETE_BATCH) {
            const batch = ids.slice(i, i + DELETE_BATCH);
            const sql = `DELETE FROM vehicles WHERE rowid IN (${batch.map(() => '?').join(',')})`;
            if (batch.length === DELETE_BATCH) {
              batchStmt ??= db.prepare(sql);
              batchStmt.run(batch);
            } else {
              db.run(sql, batch);
            }
            deleted += db.getRowsModified();
          }
        } finally {
          batchStmt?.free();
        }
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }

      // Persist atomically; nothing is written when nothing was deleted.
      await replaceGameDbFile(dbPath, db.export(), file.stat);
      return { deleted, skipped: false };
    }, { noTriggers: true });
  } catch (err) {
    log.error(`deleteVehiclesInBoxes failed on ${dbPath}: ${err.message}`);
    throw err;
  }
}

/**
 * Convenience wrapper: convert per-chunk coords to tile bboxes and delegate.
 * Use deleteVehiclesInBoxes directly for multi-chunk (cell) spans.
 *
 * @param {string} savePath
 * @param {Array<{x:number,y:number}>} chunks Chunk coords
 * @param {number} tilesPerChunk 8 (B42) or 10 (B41)
 * @param {object} [opts]
 */
export async function deleteVehiclesInChunks(savePath, chunks, tilesPerChunk, opts = {}) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { deleted: 0, skipped: true, reason: 'no chunks provided' };
  }
  if (!Number.isFinite(tilesPerChunk) || tilesPerChunk <= 0) {
    return { deleted: 0, skipped: true, reason: 'invalid tilesPerChunk' };
  }
  const boxes = chunks.map(c => ({
    x0: c.x * tilesPerChunk,
    x1: c.x * tilesPerChunk + tilesPerChunk,
    y0: c.y * tilesPerChunk,
    y1: c.y * tilesPerChunk + tilesPerChunk,
    wx0: c.x,
    wx1: c.x + 1,
    wy0: c.y,
    wy1: c.y + 1,
  }));
  return deleteVehiclesInBoxes(savePath, boxes, opts);
}
