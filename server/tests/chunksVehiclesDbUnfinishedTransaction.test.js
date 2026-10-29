import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import initSqlJs from "sql.js";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// vehicles audit (2026-10-28, R2-24): PZ commits vehicles.db with a TRUNCATE
// rollback journal. After an unclean stop a hot vehicles.db-journal can be
// left next to it, and the game plays it back on its next start -- over
// whatever the panel wrote. With deleteVehicles, both delete routes now
// refuse before deleting anything. Same harness as
// chunksDeleteSqliteUnavailable.test.js, with the real vehiclesDb.js.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getRoleByName: mockGetRoleByName,
  getServers: vi.fn(),
  getSetting: vi.fn(),
}));

const { getActiveServer, getServers, getSetting } = await import("../database/init.js");
const { default: router } = await import("../routes/chunks.js");

function createResponse() {
  let statusCode = 200;
  let body = null;
  const response = {
    status: (code) => {
      statusCode = code;
      return response;
    },
    json: (payload) => {
      body = payload;
      return response;
    },
    getStatusCode: () => statusCode,
    getBody: () => body,
  };
  return response;
}

async function postAs(routePath, body) {
  const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods.post);
  const handlers = layer.route.stack.map((s) => s.handle);
  const res = createResponse();
  const req = {
    user: { role: "technician" },
    body: { force: true, createBackup: false, deleteVehicles: true, expectedServerId: "server-1", ...body },
  };
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

const SAVE_NAME = "JournalSave";
const HOT_JOURNAL = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7, 0, 0, 0, 1]);
let SQL;
let dataRoot;
let savePath;
let dbBytes;

beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: () => path.resolve(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm"),
  });
});

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-chunks-journal-"));
  savePath = path.join(dataRoot, "Saves", "Multiplayer", SAVE_NAME);
  // A B42 chunk at (2, 2) and a vehicle parked in it (tiles 16..24).
  fs.mkdirSync(path.join(savePath, "map", "2"), { recursive: true });
  fs.writeFileSync(path.join(savePath, "map", "2", "2.bin"), "chunk");
  const db = new SQL.Database();
  db.exec(`CREATE TABLE vehicles (id INTEGER PRIMARY KEY AUTOINCREMENT, wx INTEGER, wy INTEGER,
    x FLOAT, y FLOAT, worldversion INTEGER, data BLOB)`);
  db.run("INSERT INTO vehicles (id, wx, wy, x, y, worldversion) VALUES (1, 2, 2, 20.5, 20.5, 240)");
  dbBytes = Buffer.from(db.export());
  db.close();
  fs.writeFileSync(path.join(savePath, "vehicles.db"), dbBytes);
  getActiveServer.mockReset().mockResolvedValue({ id: "server-1", zomboidDataPath: dataRoot, isRemote: false });
  getServers.mockReset().mockResolvedValue([]);
  getSetting.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

const chunkFile = () => path.join(savePath, "map", "2", "2.bin");
const vehiclesDb = () => path.join(savePath, "vehicles.db");
const deleteChunk = (extra = {}) =>
  postAs("/delete-chunks", { saveName: SAVE_NAME, chunks: [{ file: "2/2.bin", x: 2, y: 2 }], ...extra });
const deleteRegion = (extra = {}) =>
  postAs("/delete-region", { saveName: SAVE_NAME, minX: 0, maxX: 5, minY: 0, maxY: 5, ...extra });

describe("Map Cleanup with a hot vehicles.db journal", () => {
  it("delete-chunks refuses before deleting anything", async () => {
    fs.writeFileSync(`${vehiclesDb()}-journal`, HOT_JOURNAL);

    const res = await deleteChunk();

    expect(res.getStatusCode()).toBe(409);
    expect(res.getBody().code).toBe("VEHICLES_DB_UNFINISHED_TRANSACTION");
    expect(fs.existsSync(chunkFile())).toBe(true);
    expect(fs.readFileSync(vehiclesDb()).equals(dbBytes)).toBe(true);
  });

  it("delete-region refuses before deleting anything", async () => {
    fs.writeFileSync(`${vehiclesDb()}-journal`, HOT_JOURNAL);

    const res = await deleteRegion();

    expect(res.getStatusCode()).toBe(409);
    expect(res.getBody().code).toBe("VEHICLES_DB_UNFINISHED_TRANSACTION");
    expect(fs.existsSync(chunkFile())).toBe(true);
    expect(fs.readFileSync(vehiclesDb()).equals(dbBytes)).toBe(true);
  });

  // Adversary: a WAL instead of a journal holds commits too.
  it("a non-empty vehicles.db-wal is refused the same way", async () => {
    fs.writeFileSync(`${vehiclesDb()}-wal`, Buffer.from([0x37, 0x7f, 0x06, 0x82, 0, 0, 0, 1]));

    const res = await deleteChunk();

    expect(res.getStatusCode()).toBe(409);
    expect(fs.existsSync(chunkFile())).toBe(true);
  });

  it("legit: PZ's normal empty journal does not block, and the vehicle goes with its chunk", async () => {
    fs.writeFileSync(`${vehiclesDb()}-journal`, "");

    const res = await deleteChunk();

    expect(res.getBody()).toMatchObject({ success: true, deleted: 1, vehiclesDeleted: 1 });
    expect(fs.existsSync(chunkFile())).toBe(false);
  });

  it("legit: without deleteVehicles vehicles.db is not involved", async () => {
    fs.writeFileSync(`${vehiclesDb()}-journal`, HOT_JOURNAL);

    const res = await deleteRegion({ deleteVehicles: false });

    expect(res.getBody()).toMatchObject({ success: true, deleted: 1 });
    expect(fs.existsSync(chunkFile())).toBe(false);
    expect(fs.readFileSync(vehiclesDb()).equals(dbBytes)).toBe(true);
  });
});
