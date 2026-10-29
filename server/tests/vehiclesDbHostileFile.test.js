import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { pathToFileURL } from "url";
import initSqlJs from "sql.js";
import {
  countVehiclesInBoxes,
  deleteVehiclesInBoxes,
  listPersistedVehicles,
} from "../utils/vehiclesDb.js";
import { withGameDbLoadSlot } from "../utils/gameSqliteFile.js";

// vehicles audit (2026-10-28): vehicles.db is the game server's file, in a
// folder a game server outside the panel's trust domain can write, and real
// saves hold 100k+ vehicles. R2-18 (one load per concurrent request), R2-19
// (one full-table DELETE per chunk), R2-20 (copies and rewrites through a
// symlink), R2-21 (a VIEW that never ends), R2-22 (a FIFO), R2-24 (a hot
// journal), R2-25 (temp files left behind).

const IS_WIN = process.platform === "win32";
const MODULE_URL = pathToFileURL(path.resolve("server/utils/vehiclesDb.js")).href;

let SQL;
let tmpDir;

beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: () => path.resolve(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm"),
  });
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-vdb-hostile-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const PZ_SCHEMA = `CREATE TABLE vehicles (id INTEGER PRIMARY KEY AUTOINCREMENT, wx INTEGER, wy INTEGER,
  x FLOAT, y FLOAT, worldversion INTEGER, data BLOB);
  CREATE INDEX ivwx ON vehicles (wx); CREATE INDEX ivwy ON vehicles (wy);`;

// rows: [id, wx, wy, x, y]
function buildDb(rows, extraSql = "") {
  const db = new SQL.Database();
  db.exec(PZ_SCHEMA);
  const stmt = db.prepare("INSERT INTO vehicles (id, wx, wy, x, y, worldversion, data) VALUES (?, ?, ?, ?, ?, 240, ?)");
  for (const row of rows) stmt.run([...row, new Uint8Array([1, 2, 3])]);
  stmt.free();
  if (extraSql) db.exec(extraSql);
  const bytes = Buffer.from(db.export());
  db.close();
  return bytes;
}

function makeSave(name, bytes) {
  const save = path.join(tmpDir, name);
  fs.mkdirSync(save, { recursive: true });
  if (bytes) fs.writeFileSync(path.join(save, "vehicles.db"), bytes);
  return save;
}

function idsIn(file) {
  const db = new SQL.Database(fs.readFileSync(file));
  try {
    return db.exec("SELECT id FROM vehicles ORDER BY id")[0]?.values.map((r) => r[0]) ?? [];
  } finally {
    db.close();
  }
}

// Reads of `file` through either fs.promises.readFile or fs.promises.open.
function countReadsOf(file) {
  const target = path.resolve(file);
  const counter = { reads: 0 };
  const readFile = fs.promises.readFile;
  const open = fs.promises.open;
  vi.spyOn(fs.promises, "readFile").mockImplementation(function (p, ...rest) {
    if (typeof p === "string" && path.resolve(p) === target) counter.reads++;
    return readFile.call(this, p, ...rest);
  });
  vi.spyOn(fs.promises, "open").mockImplementation(function (p, ...rest) {
    if (typeof p === "string" && path.resolve(p) === target) counter.reads++;
    return open.call(this, p, ...rest);
  });
  return counter;
}

// A synchronous sql.js loop can't be interrupted inside this worker, so a
// file that could hang the panel is opened in a child process with a timeout.
function inChild(fnName, ...args) {
  const script = path.join(tmpDir, "probe.mjs");
  fs.writeFileSync(
    script,
    `import * as m from ${JSON.stringify(MODULE_URL)};
     let out;
     try { out = { ok: await m[${JSON.stringify(fnName)}](...JSON.parse(process.argv[2])) }; }
     catch (err) { out = { error: String(err && err.message) }; }
     process.stdout.write("\\nRESULT:" + JSON.stringify(out) + "\\n");
     process.exit(0);`,
  );
  const result = spawnSync(process.execPath, [script, JSON.stringify(args)], {
    encoding: "utf8",
    timeout: 20000,
  });
  const line = (result.stdout || "").split("\n").find((l) => l.startsWith("RESULT:"));
  return { timedOut: !line, ...(line ? JSON.parse(line.slice(7)) : {}) };
}

describe("R2-18: World Map loads of vehicles.db", () => {
  it("concurrent requests share one load of the file", async () => {
    const save = makeSave("burst", buildDb([[1, 100, 100, 800.5, 800.5]]));
    const counter = countReadsOf(path.join(save, "vehicles.db"));

    const results = await Promise.all(Array.from({ length: 12 }, () => listPersistedVehicles(save)));

    expect(counter.reads).toBe(1);
    for (const r of results) expect(r).toEqual([{ id: 1, x: 800.5, y: 800.5 }]);
  });

  it("an unchanged file is not loaded again, and a changed one is", async () => {
    const save = makeSave("cached", buildDb([[1, 100, 100, 800.5, 800.5]]));
    const dbPath = path.join(save, "vehicles.db");
    await listPersistedVehicles(save);
    const counter = countReadsOf(dbPath);

    expect(await listPersistedVehicles(save)).toEqual([{ id: 1, x: 800.5, y: 800.5 }]);
    expect(counter.reads).toBe(0);

    // The game saves again: a different file (size and mtime change).
    fs.writeFileSync(dbPath, buildDb([[1, 100, 100, 800.5, 800.5], [2, 101, 100, 812, 803]]));
    expect(await listPersistedVehicles(save)).toHaveLength(2);
    expect(counter.reads).toBe(1);
  });

  // Adversary: a file that keeps changing defeats the cache, so the load
  // slots are what bound memory. Six saves at once: two loads at a time.
  it("loads of different files run at most two at a time", async () => {
    const saves = Array.from({ length: 6 }, (_, i) => makeSave(`many${i}`, buildDb([[1, 1, 1, 8, 8]])));
    const open = fs.promises.open;
    let inside = 0;
    let peak = 0;
    const gates = [];
    vi.spyOn(fs.promises, "open").mockImplementation(async function (p, ...rest) {
      if (typeof p === "string" && p.endsWith("vehicles.db")) {
        inside++;
        peak = Math.max(peak, inside);
        await new Promise((resolve) => gates.push(resolve));
        inside--;
      }
      return open.call(this, p, ...rest);
    });

    const state = { finished: false };
    const all = Promise.all(saves.map((s) => listPersistedVehicles(s))).finally(() => {
      state.finished = true;
    });
    while (!state.finished) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      while (gates.length) gates.shift()();
    }
    const results = await all;

    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
    for (const r of results) expect(r).toHaveLength(1);
  });

  it("the load slots queue callers instead of refusing them", async () => {
    let active = 0;
    let peak = 0;
    const done = await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        withGameDbLoadSlot(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          return i;
        }),
      ),
    );
    expect(done).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(peak).toBe(2);
  });
});

describe("R2-19: vehicle removal is one pass over the table", () => {
  // 20,000 chunk boxes against 8,000 vehicles. The old per-box DELETE
  // scanned the whole table once per box (minutes on a real save); one pass
  // is milliseconds. The bound is loose on purpose (slow CI machines).
  it("removes 20,000 chunks' vehicles quickly and exactly", async () => {
    let seed = 7;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) & 0x7fffffff) / 0x7fffffff;
    const rows = [];
    for (let id = 1; id <= 8000; id++) {
      const x = rnd() * 4000;
      const y = rnd() * 4000;
      rows.push([id, Math.floor(x / 8), Math.floor(y / 8), x, y]);
    }
    // A vehicle whose tile coords drifted out of its chunk (caught by wx/wy).
    rows.push([8001, 10, 10, 9000.5, 9000.5]);
    const save = makeSave("big", buildDb(rows));

    const boxes = [];
    for (let cx = 0; cx < 500 && boxes.length < 20000; cx += 2) {
      for (let cy = 0; cy < 500 && boxes.length < 20000; cy += 6) {
        boxes.push({ x0: cx * 8, x1: cx * 8 + 8, y0: cy * 8, y1: cy * 8 + 8, wx0: cx, wx1: cx + 1, wy0: cy, wy1: cy + 1 });
      }
    }
    boxes.push({ x0: 80, x1: 88, y0: 80, y1: 88, wx0: 10, wx1: 11, wy0: 10, wy1: 11 });
    // Every box is one whole chunk, so a set of chunk keys is the reference.
    const chunkKeys = new Set(boxes.map((b) => `${b.wx0},${b.wy0}`));
    const inBox = (r) =>
      chunkKeys.has(`${Math.floor(r[3] / 8)},${Math.floor(r[4] / 8)}`) || chunkKeys.has(`${r[1]},${r[2]}`);
    const expectedLeft = rows.filter((r) => !inBox(r)).map((r) => r[0]);

    const started = Date.now();
    const result = await deleteVehiclesInBoxes(save, boxes);
    const elapsed = Date.now() - started;

    expect(result.deleted).toBe(rows.length - expectedLeft.length);
    expect(idsIn(path.join(save, "vehicles.db"))).toEqual(expectedLeft);
    expect(expectedLeft).not.toContain(8001);
    expect(elapsed).toBeLessThan(2500);
  });

  it("matches exactly what the SQL ranges matched: half-open, numbers only, overlaps once", async () => {
    const db = new SQL.Database();
    db.exec(PZ_SCHEMA);
    db.run("INSERT INTO vehicles (id, wx, wy, x, y) VALUES (1, 100, 100, 800, 800)");
    db.run("INSERT INTO vehicles (id, wx, wy, x, y) VALUES (2, 101, 100, 808, 800)"); // x1 is exclusive
    db.run("INSERT INTO vehicles (id, wx, wy, x, y) VALUES (3, NULL, NULL, NULL, 801)");
    db.run("INSERT INTO vehicles (id, wx, wy, x, y) VALUES (4, 'a', 'b', 'abc', 'def')");
    db.run("INSERT INTO vehicles (id, wx, wy, x, y) VALUES (5, 3, 3, 30, 30)"); // inside a whole-cell box
    db.run("INSERT INTO vehicles (id, wx, wy, x, y) VALUES (6, -1, -1, -0.5, -0.5)"); // negative coords
    db.run("INSERT INTO vehicles (id, wx, wy, x, y) VALUES (7, 500, 500, 4000, 4000)"); // untouched
    const save = makeSave("exact", Buffer.from(db.export()));
    db.close();

    const result = await deleteVehiclesInBoxes(save, [
      { x0: 800, x1: 808, y0: 800, y1: 808, wx0: 100, wx1: 101, wy0: 100, wy1: 101 },
      { x0: 800, x1: 808, y0: 800, y1: 808 }, // overlap: still one row
      { x0: 0, x1: 256, y0: 0, y1: 256, wx0: 0, wx1: 32, wy0: 0, wy1: 32 },
      { x0: -8, x1: 0, y0: -8, y1: 0 },
      { x0: -1e9, x1: 1e9, y0: 5000, y1: 5001 }, // huge box: checked without a grid
    ]);

    expect(result).toEqual({ deleted: 3, skipped: false });
    expect(idsIn(path.join(save, "vehicles.db"))).toEqual([2, 3, 4, 7]);
  });
});

describe("R2-20: vehicles.db that is not a plain SQLite file", () => {
  it("a file holding something else (a panel secret behind a hard link) is never copied or rewritten", async () => {
    const save = makeSave("secret", null);
    const dbPath = path.join(save, "vehicles.db");
    fs.writeFileSync(dbPath, "jwt-signing-secret-0123456789abcdef");
    const backupPath = path.join(tmpDir, "backups", "x", "vehicles.db.bak");

    await expect(
      deleteVehiclesInBoxes(save, [{ x0: 0, x1: 8, y0: 0, y1: 8 }], { backupPath }),
    ).rejects.toThrow(/not an SQLite database/);

    expect(fs.existsSync(backupPath)).toBe(false);
    expect(fs.readFileSync(dbPath, "utf8")).toBe("jwt-signing-secret-0123456789abcdef");
    expect(fs.readdirSync(save)).toEqual(["vehicles.db"]);
  });

  it("the backup goes to a new file only, never over one already there", async () => {
    const save = makeSave("bak", buildDb([[1, 100, 100, 800.5, 800.5]]));
    const backupPath = path.join(tmpDir, "planted.bak");
    fs.writeFileSync(backupPath, "panel file");

    const result = await deleteVehiclesInBoxes(save, [{ x0: 800, x1: 808, y0: 800, y1: 808 }], { backupPath });

    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/^backup failed/);
    expect(fs.readFileSync(backupPath, "utf8")).toBe("panel file");
    expect(idsIn(path.join(save, "vehicles.db"))).toEqual([1]);
  });

  it("legit: the backup holds the bytes that were edited", async () => {
    const bytes = buildDb([[1, 100, 100, 800.5, 800.5], [2, 200, 200, 1600, 1600]]);
    const save = makeSave("bakok", bytes);
    const backupPath = path.join(tmpDir, "backups", "y", "vehicles.db.bak");

    const result = await deleteVehiclesInBoxes(save, [{ x0: 800, x1: 808, y0: 800, y1: 808 }], { backupPath });

    expect(result).toEqual({ deleted: 1, skipped: false });
    expect(fs.readFileSync(backupPath).equals(bytes)).toBe(true);
    expect(idsIn(path.join(save, "vehicles.db"))).toEqual([2]);
  });

  it.skipIf(IS_WIN)("a symlink to a panel file is refused: nothing is copied, read back or replaced", async () => {
    const secret = path.join(tmpDir, "jwt.secret");
    fs.writeFileSync(secret, "jwt-signing-secret");
    const save = makeSave("link", null);
    const dbPath = path.join(save, "vehicles.db");
    fs.symlinkSync(secret, dbPath);
    const backupPath = path.join(tmpDir, "backups", "z", "vehicles.db.bak");

    await expect(
      deleteVehiclesInBoxes(save, [{ x0: 0, x1: 8, y0: 0, y1: 8 }], { backupPath }),
    ).rejects.toThrow(/not a regular file/);
    expect(await listPersistedVehicles(save)).toEqual([]);

    expect(fs.existsSync(backupPath)).toBe(false);
    expect(fs.lstatSync(dbPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(secret, "utf8")).toBe("jwt-signing-secret");
  });

  it.skipIf(IS_WIN)("a symlink planted at the backup path is not followed", async () => {
    const target = path.join(tmpDir, "panel-file");
    fs.writeFileSync(target, "panel file");
    const save = makeSave("baklink", buildDb([[1, 100, 100, 800.5, 800.5]]));
    const backupPath = path.join(tmpDir, "planted-link.bak");
    fs.symlinkSync(target, backupPath);

    const result = await deleteVehiclesInBoxes(save, [{ x0: 800, x1: 808, y0: 800, y1: 808 }], { backupPath });

    expect(result.skipped).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("panel file");
  });

  // Adversary: swap the checked file for another between the read and the
  // write-back. The edit must not land on whatever is there now.
  it("a vehicles.db replaced while it is being edited is left alone", async () => {
    const save = makeSave("swap", buildDb([[1, 100, 100, 800.5, 800.5]]));
    const dbPath = path.join(save, "vehicles.db");
    const other = buildDb([[9, 1, 1, 8, 8]]);
    const lstat = fs.promises.lstat;
    let calls = 0;
    vi.spyOn(fs.promises, "lstat").mockImplementation(async function (p, ...rest) {
      if (typeof p === "string" && path.resolve(p) === path.resolve(dbPath) && ++calls === 2) {
        const fresh = path.join(save, "fresh.db");
        fs.writeFileSync(fresh, other);
        fs.renameSync(fresh, dbPath);
      }
      return lstat.call(this, p, ...rest);
    });

    await expect(
      deleteVehiclesInBoxes(save, [{ x0: 800, x1: 808, y0: 800, y1: 808 }]),
    ).rejects.toThrow(/replaced/);
    expect(idsIn(dbPath)).toEqual([9]);
    expect(fs.readdirSync(save)).toEqual(["vehicles.db"]);
  });
});

describe("R2-21: a crafted schema can't hang the panel", () => {
  const endlessView = (name = "vehicles") =>
    `CREATE VIEW ${name} AS WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c)
     SELECT n AS id, CASE WHEN n > 0 THEN NULL ELSE 1 END AS x, n AS y, n AS wx, n AS wy FROM c`;

  function viewDb(sql) {
    const db = new SQL.Database();
    db.exec(sql);
    const bytes = Buffer.from(db.export());
    db.close();
    return bytes;
  }

  it("a `vehicles` VIEW over an endless recursive CTE is refused, not run", () => {
    const save = makeSave("view", viewDb(endlessView()));
    const out = inChild("listPersistedVehicles", save);
    expect(out.timedOut).toBe(false);
    expect(out.ok).toEqual([]);
  });

  // Adversary: the name in another case, and the sqlite_master row's type
  // rewritten to 'table' (SQLite builds the object from the sql text).
  it("the same view under VEHICLES, or with its schema row relabelled 'table', is refused too", () => {
    const upper = makeSave("upper", viewDb(endlessView("VEHICLES")));
    expect(inChild("listPersistedVehicles", upper)).toEqual({ timedOut: false, ok: [] });

    const db = new SQL.Database();
    db.exec(endlessView());
    db.exec("PRAGMA writable_schema = ON");
    db.exec("UPDATE sqlite_master SET type = 'table' WHERE name = 'vehicles'");
    db.exec("PRAGMA writable_schema = OFF");
    const relabelled = makeSave("relabel", Buffer.from(db.export()));
    db.close();
    expect(inChild("listPersistedVehicles", relabelled)).toEqual({ timedOut: false, ok: [] });
  });

  it("a trigger on vehicles is refused before any DELETE fires it", () => {
    const bytes = buildDb(
      [[1, 100, 100, 800.5, 800.5]],
      `CREATE TABLE t(n); CREATE TRIGGER spin AFTER DELETE ON vehicles BEGIN
         INSERT INTO t WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT n FROM c WHERE n < 0; END;`,
    );
    const save = makeSave("trigger", bytes);
    const out = inChild("deleteVehiclesInBoxes", save, [{ x0: 800, x1: 808, y0: 800, y1: 808 }]);
    expect(out.timedOut).toBe(false);
    expect(out.error).toMatch(/trigger/);
    expect(idsIn(path.join(save, "vehicles.db"))).toEqual([1]);
  });

  // A generated column runs its expression on every read; real saves have none.
  it("a virtual generated column is refused", async () => {
    const db = new SQL.Database();
    db.exec(`CREATE TABLE vehicles (id INTEGER PRIMARY KEY, wx INTEGER, wy INTEGER, y FLOAT,
      x FLOAT GENERATED ALWAYS AS (wx * 8) VIRTUAL)`);
    db.run("INSERT INTO vehicles (id, wx, wy, y) VALUES (1, 1, 1, 8)");
    const save = makeSave("generated", Buffer.from(db.export()));
    db.close();
    expect(await listPersistedVehicles(save)).toEqual([]);
  });

  it("legit: a real PZ vehicles.db (with sqlite_sequence) still reads and edits", async () => {
    const save = makeSave("legit", buildDb([[1, 100, 100, 800.5, 800.5], [2, 200, 200, 1600, 1600]]));
    expect(await listPersistedVehicles(save)).toHaveLength(2);
    expect(await countVehiclesInBoxes(save, [{ x0: 800, x1: 808, y0: 800, y1: 808 }])).toBe(1);
    expect(await deleteVehiclesInBoxes(save, [{ x0: 800, x1: 808, y0: 800, y1: 808 }])).toEqual({ deleted: 1, skipped: false });
  });
});

describe("R2-22: a FIFO in place of vehicles.db", () => {
  it.skipIf(IS_WIN)("is skipped without blocking a threadpool thread", async () => {
    const save = makeSave("fifo", null);
    const dbPath = path.join(save, "vehicles.db");
    const made = spawnSync("mkfifo", [dbPath]);
    expect(made.status).toBe(0);

    const results = await Promise.all(Array.from({ length: 6 }, () => listPersistedVehicles(save)));
    for (const r of results) expect(r).toEqual([]);
    await expect(deleteVehiclesInBoxes(save, [{ x0: 0, x1: 8, y0: 0, y1: 8 }])).rejects.toThrow(/not a regular file/);
    // The threadpool still answers.
    await fs.promises.readFile(path.resolve("package.json"));
  }, 10000);
});

describe("R2-24: an unfinished transaction next to vehicles.db", () => {
  const box = [{ x0: 800, x1: 808, y0: 800, y1: 808 }];

  it("a hot journal stops the edit", async () => {
    const bytes = buildDb([[1, 100, 100, 800.5, 800.5]]);
    const save = makeSave("hot", bytes);
    fs.writeFileSync(path.join(save, "vehicles.db-journal"), Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]));

    await expect(deleteVehiclesInBoxes(save, box)).rejects.toThrow(/unfinished transaction/);
    expect(fs.readFileSync(path.join(save, "vehicles.db")).equals(bytes)).toBe(true);
  });

  it("a non-empty WAL stops it too", async () => {
    const save = makeSave("wal", buildDb([[1, 100, 100, 800.5, 800.5]]));
    fs.writeFileSync(path.join(save, "vehicles.db-wal"), Buffer.from([0x37, 0x7f, 0x06, 0x82]));
    await expect(deleteVehiclesInBoxes(save, box)).rejects.toThrow(/unfinished transaction/);
  });

  it("legit: an empty journal (PZ's normal TRUNCATE state) or a zeroed header does not", async () => {
    const save = makeSave("cold", buildDb([[1, 100, 100, 800.5, 800.5], [2, 200, 200, 1600, 1600]]));
    const journal = path.join(save, "vehicles.db-journal");
    fs.writeFileSync(journal, "");
    expect(await deleteVehiclesInBoxes(save, box)).toEqual({ deleted: 1, skipped: false });
    fs.writeFileSync(journal, Buffer.alloc(512));
    expect(await deleteVehiclesInBoxes(save, [{ x0: 1600, x1: 1608, y0: 1600, y1: 1608 }])).toEqual({ deleted: 1, skipped: false });
  });
});

describe("R2-25: the rewrite leaves nothing behind", () => {
  it("a failed rename removes its temp file and keeps vehicles.db", async () => {
    const bytes = buildDb([[1, 100, 100, 800.5, 800.5]]);
    const save = makeSave("eperm", bytes);
    vi.spyOn(fs.promises, "rename").mockRejectedValue(Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }));

    await expect(deleteVehiclesInBoxes(save, [{ x0: 800, x1: 808, y0: 800, y1: 808 }])).rejects.toThrow(/EPERM/);

    expect(fs.readdirSync(save)).toEqual(["vehicles.db"]);
    expect(fs.readFileSync(path.join(save, "vehicles.db")).equals(bytes)).toBe(true);
  });

  // Adversary: the write itself fails part-way (a full disk).
  it("a failed write removes its partial temp file", async () => {
    const save = makeSave("enospc", buildDb([[1, 100, 100, 800.5, 800.5]]));
    const open = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementation(async function (p, ...rest) {
      const handle = await open.call(this, p, ...rest);
      if (typeof p === "string" && p.includes(".tmp-")) {
        handle.writeFile = async () => {
          await handle.write(Buffer.from("partial"));
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        };
      }
      return handle;
    });

    await expect(deleteVehiclesInBoxes(save, [{ x0: 800, x1: 808, y0: 800, y1: 808 }])).rejects.toThrow(/ENOSPC/);
    expect(fs.readdirSync(save)).toEqual(["vehicles.db"]);
  });

  it("stale temp files an older panel left are swept, recent ones kept", async () => {
    const save = makeSave("stale", buildDb([[1, 100, 100, 800.5, 800.5]]));
    const old = path.join(save, "vehicles.db.tmp-4242-1700000000000");
    const recent = path.join(save, "vehicles.db.tmp-4242-1800000000000");
    fs.writeFileSync(old, "x");
    fs.writeFileSync(recent, "x");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(old, twoHoursAgo, twoHoursAgo);

    await deleteVehiclesInBoxes(save, [{ x0: 800, x1: 808, y0: 800, y1: 808 }]);

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it("nothing is rewritten when nothing matched", async () => {
    const save = makeSave("nochange", buildDb([[1, 100, 100, 800.5, 800.5]]));
    const dbPath = path.join(save, "vehicles.db");
    const before = fs.statSync(dbPath, { bigint: true });

    expect(await deleteVehiclesInBoxes(save, [{ x0: 0, x1: 8, y0: 0, y1: 8 }])).toEqual({ deleted: 0, skipped: false });
    const after = fs.statSync(dbPath, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  });
});
