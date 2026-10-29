// The game's own SQLite files that the panel opens with sql.js (sqlJs.js):
// <save>/vehicles.db (World Map, Map Cleanup) and db/<server>.db (Players).
//
// SECURITY (2026-10-28, vehicles audit R2-18/R2-20/R2-21/R2-22): these live
// in the game's folder, which a game server outside the panel's trust domain
// can write (Docker Path B/D: PZ on the host or in its own container, the
// Zomboid folder bind-mounted into the panel). So every load here:
//   - opens the file without following a symlink and without blocking on a
//     FIFO (O_NOFOLLOW|O_NONBLOCK, then fstat: a regular file, the one lstat
//     saw), and only takes it when it starts with SQLite's header. A link to
//     the panel's own jwt.secret is never copied into a backup or written
//     back into the save, and a FIFO never pins a libuv threadpool thread;
//   - runs inside one of MAX_CONCURRENT_LOADS process-wide slots: sql.js
//     holds the whole file in memory, so a burst of requests must not
//     multiply a large vehicles.db by the request count;
//   - can check that the tables the panel queries are plain tables
//     (assertPlainTables): a crafted file can define `vehicles` as a VIEW
//     over an endless recursive CTE, and sql.js can't be interrupted, so the
//     panel would hang for good.
// Rewrites go through a fresh temp file (O_EXCL|O_NOFOLLOW, random name)
// that is fsynced, renamed over the original only if that is still the file
// that was read, and removed when anything fails (R2-25).

import fs from "fs";
import path from "path";
import crypto from "crypto";

const IS_WIN = process.platform === "win32";

const READ_FLAGS =
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
const CREATE_EXCL_FLAGS =
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");

// Two loads at once: a Map Cleanup and a World Map refresh can overlap, but
// memory stays bounded by two copies of the largest file whatever the
// request rate. Callers queue for a slot; nobody is refused.
const MAX_CONCURRENT_LOADS = 2;
let activeLoads = 0;
const waitingForSlot = [];

export class GameDbFileError extends Error {
  constructor(message) {
    super(message);
    this.name = "GameDbFileError";
  }
}

/** Run fn while holding one of the process-wide whole-file load slots. */
export async function withGameDbLoadSlot(fn) {
  if (activeLoads < MAX_CONCURRENT_LOADS) {
    activeLoads++;
  } else {
    await new Promise((resolve) => waitingForSlot.push(resolve));
  }
  try {
    return await fn();
  } finally {
    const next = waitingForSlot.shift();
    if (next) next();
    else activeLoads--;
  }
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Read a game SQLite file whole, safely (see the header). Throws ENOENT as
 * fs does, and GameDbFileError when the path is not a plain SQLite file.
 *
 * @param {string} dbPath
 * @returns {Promise<{buffer: Buffer, stat: import('fs').BigIntStats}>}
 */
export async function readGameDbFile(dbPath) {
  const label = path.basename(dbPath);
  const linkStat = await fs.promises.lstat(dbPath, { bigint: true });
  if (!linkStat.isFile()) {
    throw new GameDbFileError(`${label} is not a regular file`);
  }
  let handle;
  try {
    handle = await fs.promises.open(dbPath, READ_FLAGS);
  } catch (err) {
    if (err?.code === "ELOOP" || err?.code === "EMLINK") {
      throw new GameDbFileError(`${label} is not a regular file`);
    }
    throw err;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || !sameFile(stat, linkStat)) {
      throw new GameDbFileError(`${label} is not a regular file`);
    }
    const buffer = await handle.readFile();
    if (buffer.length < SQLITE_HEADER.length || !buffer.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
      throw new GameDbFileError(`${label} is not an SQLite database`);
    }
    return { buffer, stat };
  } finally {
    await handle.close();
  }
}

/**
 * Refuse a database whose queried names are anything but plain tables: a
 * view (endless recursive CTE), a virtual table, or a table with a virtual
 * generated column all run schema-defined SQL when the panel reads them.
 * Names that are missing are left to the caller's own query to report.
 * With noTriggers, a trigger on one of them is refused too (for writers).
 *
 * @param {import('sql.js').Database} db
 * @param {string} label File name for the error message
 * @param {string[]} names
 * @param {{noTriggers?: boolean}} [opts]
 */
export function assertPlainTables(db, label, names, { noTriggers = false } = {}) {
  const wanted = names.map((name) => name.toLowerCase());
  const marks = wanted.map(() => "?").join(", ");
  const stmt = db.prepare(
    `SELECT type, lower(name), lower(tbl_name), sql FROM sqlite_master
      WHERE lower(name) IN (${marks}) OR (type = 'trigger' AND lower(tbl_name) IN (${marks}))`,
  );
  const tables = [];
  try {
    stmt.bind([...wanted, ...wanted]);
    while (stmt.step()) {
      const [type, name, tblName, sql] = stmt.get();
      if (type === "trigger") {
        if (noTriggers && wanted.includes(tblName)) {
          throw new GameDbFileError(`${label} has a trigger on "${tblName}"`);
        }
        continue;
      }
      // SQLite builds the object from the sql text, not from `type`.
      if (type !== "table" || typeof sql !== "string" || !/^\s*CREATE\s+TABLE\b/i.test(sql)) {
        throw new GameDbFileError(`${label}: "${name}" is not a plain table`);
      }
      tables.push(name);
    }
  } finally {
    stmt.free();
  }
  for (const name of tables) {
    const info = db.exec(`PRAGMA table_xinfo("${name.replace(/"/g, '""')}")`);
    const columns = info[0]?.columns || [];
    const hiddenAt = columns.indexOf("hidden");
    for (const row of info[0]?.values || []) {
      if (hiddenAt >= 0 && (row[hiddenAt] === 2 || row[hiddenAt] === 3)) {
        throw new GameDbFileError(`${label}: "${name}" has a generated column`);
      }
    }
  }
}

/**
 * Create a new file holding bytes, never through an existing file or link.
 *
 * @param {string} destPath
 * @param {Uint8Array} bytes
 * @param {number} [mode]
 */
export async function writeNewFile(destPath, bytes, mode = 0o600) {
  const handle = await fs.promises.open(destPath, CREATE_EXCL_FLAGS, mode);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

/** A read stat's permission bits, still writable by the panel. */
export function fileModeOf(stat) {
  return (Number(stat.mode) & 0o777) | 0o600;
}

/**
 * Replace dbPath with bytes: temp file, fsync, rename. Refused when dbPath
 * is no longer the file readGameDbFile() read (readStat). The temp file is
 * removed whenever the rename did not happen.
 *
 * @param {string} dbPath
 * @param {Uint8Array} bytes
 * @param {import('fs').BigIntStats} readStat
 */
export async function replaceGameDbFile(dbPath, bytes, readStat) {
  const label = path.basename(dbPath);
  const tmp = `${dbPath}.tmp-${crypto.randomBytes(8).toString("hex")}`;
  let renamed = false;
  try {
    const handle = await fs.promises.open(tmp, CREATE_EXCL_FLAGS, fileModeOf(readStat));
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const current = await fs.promises.lstat(dbPath, { bigint: true });
    if (!current.isFile() || !sameFile(current, readStat)) {
      throw new GameDbFileError(`${label} was replaced while the panel was editing it; nothing was written`);
    }
    await fs.promises.rename(tmp, dbPath);
    renamed = true;
  } finally {
    if (!renamed) await fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
  if (!IS_WIN) {
    // Make the rename itself durable. Best effort: some filesystems refuse
    // fsync on a directory.
    try {
      const dir = await fs.promises.open(path.dirname(dbPath), fs.constants.O_RDONLY);
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      /* not supported here */
    }
  }
}

/**
 * True when dbPath has an unfinished transaction next to it: a hot rollback
 * journal (non-empty, first byte not zero: SQLite's own test; PZ commits in
 * TRUNCATE mode, so a 0-byte journal is the normal state) or a non-empty
 * WAL. Editing the main file alone would then be undone or mixed with stale
 * pages the next time the game opens it. Anything there that can't be
 * checked counts as unfinished.
 *
 * @param {string} dbPath
 */
export async function hasUnfinishedTransaction(dbPath) {
  let handle = null;
  try {
    handle = await fs.promises.open(`${dbPath}-journal`, READ_FLAGS);
  } catch (err) {
    if (err?.code !== "ENOENT") return true;
  }
  if (handle) {
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return true;
      if (stat.size > 0) {
        const first = Buffer.alloc(1);
        const { bytesRead } = await handle.read(first, 0, 1, 0);
        if (bytesRead === 1 && first[0] !== 0) return true;
      }
    } finally {
      await handle.close();
    }
  }
  try {
    const wal = await fs.promises.lstat(`${dbPath}-wal`);
    if (!wal.isFile() || wal.size > 0) return true;
  } catch (err) {
    if (err?.code !== "ENOENT") return true;
  }
  return false;
}
