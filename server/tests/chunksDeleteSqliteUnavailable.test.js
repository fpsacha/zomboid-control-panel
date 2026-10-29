import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// With deleteVehicles, /delete-chunks and /delete-region clean vehicles.db
// last (Pass 3), through sql.js. If the panel's SQLite engine can't start
// (utils/sqlJs.js), they now refuse before deleting anything: deleting the
// chunks and then failing on vehicles.db left those vehicles to come back.
//
// Same harness as chunksDeleteErrorRedaction.test.js: real temp folders,
// the route's own permission gate and handler.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getRoleByName: mockGetRoleByName,
  getServers: vi.fn(),
  getSetting: vi.fn(),
}));

vi.mock("../utils/vehiclesDb.js", () => ({
  deleteVehiclesInBoxes: vi.fn(),
  vehiclesDbHasUnfinishedTransaction: vi.fn(async () => false),
}));

vi.mock("../utils/sqlJs.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getSqlJs: vi.fn() };
});

const { getActiveServer, getServers, getSetting } = await import("../database/init.js");
const { deleteVehiclesInBoxes } = await import("../utils/vehiclesDb.js");
const { getSqlJs, SqlJsUnavailableError } = await import("../utils/sqlJs.js");
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
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods.post,
  );
  const handlers = layer.route.stack.map((s) => s.handle);
  const res = createResponse();
  const req = {
    user: { role: "technician" },
    body: {
      force: true,
      createBackup: false,
      deleteVehicles: false,
      expectedServerId: "server-1",
      ...body,
    },
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

function writeFileDeep(p, content = "x") {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const SAVE_NAME = "TestSave";
let dataRoot;
let savePath;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-chunks-sqlite-"));
  savePath = path.join(dataRoot, "Saves", "Multiplayer", SAVE_NAME);
  fs.mkdirSync(savePath, { recursive: true });
  getActiveServer.mockReset().mockResolvedValue({
    id: "server-1",
    zomboidDataPath: dataRoot,
    isRemote: false,
  });
  getServers.mockReset().mockResolvedValue([]);
  getSetting.mockReset().mockResolvedValue(null);
  deleteVehiclesInBoxes.mockReset().mockResolvedValue({ deleted: 0, skipped: false });
  getSqlJs.mockReset().mockRejectedValue(
    new SqlJsUnavailableError("SQLite engine unavailable: sql-wasm.wasm is not a valid WebAssembly module"),
  );
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe("chunk deletion when the SQLite engine can't start", () => {
  it("delete-chunks with deleteVehicles refuses before deleting anything", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk);

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "0/0.bin", x: 0, y: 0 }],
      deleteVehicles: true,
    });

    expect(res.getStatusCode()).toBe(503);
    expect(res.getBody().code).toBe("SQLITE_ENGINE_UNAVAILABLE");
    expect(fs.existsSync(chunk)).toBe(true);
    expect(deleteVehiclesInBoxes).not.toHaveBeenCalled();
  });

  it("delete-region with deleteVehicles refuses before deleting anything", async () => {
    const chunk = path.join(savePath, "map", "2", "2.bin");
    writeFileDeep(chunk);

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 5,
      minY: 0,
      maxY: 5,
      deleteVehicles: true,
    });

    expect(res.getStatusCode()).toBe(503);
    expect(res.getBody().code).toBe("SQLITE_ENGINE_UNAVAILABLE");
    expect(fs.existsSync(chunk)).toBe(true);
    expect(deleteVehiclesInBoxes).not.toHaveBeenCalled();
  });

  // The harness request has no req.app, so reaching the running-server check
  // (which reads req.app.get("serverManager")) would end in a 500 instead.
  it("refuses before the running-server check, so no force override is asked for first", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk);

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "0/0.bin", x: 0, y: 0 }],
      deleteVehicles: true,
      force: false,
    });

    expect(res.getStatusCode()).toBe(503);
    expect(res.getBody().code).toBe("SQLITE_ENGINE_UNAVAILABLE");
    expect(fs.existsSync(chunk)).toBe(true);
  });

  it("without deleteVehicles the engine isn't needed, so the delete goes ahead", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk);

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "0/0.bin", x: 0, y: 0 }],
    });

    expect(res.getBody()).toMatchObject({ success: true, deleted: 1 });
    expect(fs.existsSync(chunk)).toBe(false);
    expect(getSqlJs).not.toHaveBeenCalled();
  });

  it("with a working engine, deleteVehicles still cleans vehicles.db", async () => {
    getSqlJs.mockResolvedValue({});
    writeFileDeep(path.join(savePath, "map", "0", "0.bin"));

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "0/0.bin", x: 0, y: 0 }],
      deleteVehicles: true,
    });

    expect(res.getBody()).toMatchObject({ success: true, deleted: 1 });
    expect(deleteVehiclesInBoxes).toHaveBeenCalledTimes(1);
  });
});
