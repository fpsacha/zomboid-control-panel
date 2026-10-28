import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import initSqlJs from "sql.js";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// R2-26 (2026-10-28): with deleteVehicles, delete-chunks and delete-region
// removed the vehicles.db rows of EVERY requested chunk as soon as one chunk
// file was deleted, so a chunk whose file failed to delete (EPERM, EBUSY)
// stayed on disk with its cars gone for good (B42 keeps them only in
// vehicles.db). Only chunks whose file is gone lose their vehicles now; a
// chunk that was already missing still does, as before.
//
// A directory where the route expects a chunk file is the deterministic way
// to force a real (non-ENOENT) unlink failure (chunksDeletionLogic.test.js).

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getRoleByName: mockGetRoleByName,
  getServers: vi.fn(),
  getSetting: vi.fn(),
}));

const { getActiveServer, getServers, getSetting } = await import("../database/init.js");
const { default: router } = await import("../routes/chunks.js");

let sqlPromise = null;
function getSQL() {
  sqlPromise ??= initSqlJs({
    locateFile: () => path.resolve(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm"),
  });
  return sqlPromise;
}

async function createVehiclesDb(dbPath, rows) {
  const SQL = await getSQL();
  const db = new SQL.Database();
  db.run(
    "CREATE TABLE vehicles (id INTEGER PRIMARY KEY AUTOINCREMENT, wx INTEGER, wy INTEGER, x FLOAT, y FLOAT, worldversion INTEGER, data BLOB)",
  );
  for (const r of rows) {
    db.run("INSERT INTO vehicles (wx, wy, x, y, worldversion, data) VALUES (?, ?, ?, ?, 1, NULL)", [
      r.wx,
      r.wy,
      r.x,
      r.y,
    ]);
  }
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

async function remainingVehicles(dbPath) {
  const SQL = await getSQL();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const result = db.exec("SELECT wx, wy FROM vehicles ORDER BY id");
  db.close();
  return (result[0]?.values ?? []).map(([wx, wy]) => `${wx},${wy}`);
}

function createResponse() {
  const response = {};
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

async function postAs(routePath, body) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods.post,
  );
  const handlers = layer.route.stack.map((s) => s.handle);
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  const req = {
    user: { role: "technician" },
    app: { get: () => null },
    body: {
      force: true,
      createBackup: false,
      deleteVehicles: true,
      expectedServerId: "server-1",
      saveName: "TestSave",
      ...body,
    },
  };
  await next();
  return res;
}

let dataRoot;
let savePath;
let dbPath;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-gone-vehicles-"));
  savePath = path.join(dataRoot, "Saves", "Multiplayer", "TestSave");
  dbPath = path.join(savePath, "vehicles.db");
  fs.mkdirSync(savePath, { recursive: true });
  getActiveServer.mockReset().mockResolvedValue({
    id: "server-1",
    zomboidDataPath: dataRoot,
    isRemote: false,
  });
  getServers.mockReset().mockResolvedValue([]);
  getSetting.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

function chunkPath(x, y) {
  return path.join(savePath, "map", String(x), `${y}.bin`);
}

function writeChunk(x, y) {
  fs.mkdirSync(path.dirname(chunkPath(x, y)), { recursive: true });
  fs.writeFileSync(chunkPath(x, y), "chunk");
}

function lockChunk(x, y) {
  fs.mkdirSync(chunkPath(x, y), { recursive: true });
}

// B42: 8 tiles per chunk, so chunk (cx, cy) holds tiles [8cx, 8cx+8).
const vehicleIn = (cx, cy) => ({ wx: cx, wy: cy, x: cx * 8 + 3, y: cy * 8 + 3 });

describe("delete-chunks with deleteVehicles", () => {
  it("keeps the vehicles of a chunk whose file failed to delete, and removes those of the deleted and the already-missing chunk", async () => {
    writeChunk(0, 0);
    lockChunk(40, 0);
    await createVehiclesDb(dbPath, [vehicleIn(0, 0), vehicleIn(40, 0), vehicleIn(5, 5)]);

    const res = await postAs("/delete-chunks", {
      chunks: [
        { file: "0/0.bin", x: 0, y: 0 },
        { file: "40/0.bin", x: 40, y: 0 },
        { file: "5/5.bin", x: 5, y: 5 },
      ],
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toMatchObject({ deleted: 1 });
    expect(res.getBody().errors).toEqual(expect.arrayContaining([expect.stringContaining("40/0.bin")]));
    expect(fs.existsSync(chunkPath(40, 0))).toBe(true);
    expect(await remainingVehicles(dbPath)).toEqual(["40,0"]);
  });

  // A chunkdata entry stands for a whole cell (32x32 chunks). When its file
  // fails to delete, the cell's vehicles stay: here no map chunk is left in
  // cell (1, 0), so nothing else would keep the cell's box from applying.
  it("keeps the cell's vehicles when a chunkdata file fails to delete", async () => {
    writeChunk(0, 0);
    fs.mkdirSync(path.join(savePath, "chunkdata", "chunkdata_1_0.bin"), { recursive: true });
    await createVehiclesDb(dbPath, [vehicleIn(0, 0), vehicleIn(40, 0)]);

    const res = await postAs("/delete-chunks", {
      chunks: [
        { file: "0/0.bin", x: 0, y: 0 },
        { source: "chunkdata", file: "chunkdata_1_0.bin", x: 32, y: 0 },
      ],
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toMatchObject({ deleted: 1 });
    expect(fs.existsSync(path.join(savePath, "chunkdata", "chunkdata_1_0.bin"))).toBe(true);
    expect(await remainingVehicles(dbPath)).toEqual(["40,0"]);
  });

  // Guards the cell survivor check (chunkFiles.js createCellSurvivorCheck):
  // an already-missing chunkdata entry of the failed chunk's cell counts as
  // gone and stands for the whole cell, but the failed map chunk still on
  // disk in that cell keeps the cell's box from sweeping its vehicles.
  it("survivor check: an already-missing chunkdata entry of the failed chunk's cell doesn't take its vehicles", async () => {
    writeChunk(0, 0);
    lockChunk(40, 0); // cell (1, 0) at 32 chunks per cell
    await createVehiclesDb(dbPath, [vehicleIn(0, 0), vehicleIn(40, 0)]);

    const res = await postAs("/delete-chunks", {
      chunks: [
        { file: "0/0.bin", x: 0, y: 0 },
        { file: "40/0.bin", x: 40, y: 0 },
        { source: "chunkdata", file: "chunkdata_1_0.bin", x: 32, y: 0 },
      ],
    });

    expect(res.getStatusCode()).toBe(200);
    expect(await remainingVehicles(dbPath)).toEqual(["40,0"]);
  });
});

describe("delete-region with deleteVehicles", () => {
  it("keeps the vehicles of a chunk whose file failed to delete", async () => {
    writeChunk(2, 2);
    lockChunk(2, 3);
    await createVehiclesDb(dbPath, [vehicleIn(2, 2), vehicleIn(2, 3), vehicleIn(30, 30)]);

    const res = await postAs("/delete-region", { minX: 0, maxX: 5, minY: 0, maxY: 5 });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toMatchObject({ deleted: 1 });
    expect(fs.existsSync(chunkPath(2, 3))).toBe(true);
    expect(await remainingVehicles(dbPath)).toEqual(["2,3", "30,30"]);
  });
});
