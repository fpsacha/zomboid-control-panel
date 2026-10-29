import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// Security sweep 2026-10-05, M3: /delete-chunks and /delete-region put two
// raw fs messages in their response -- a chunkdata file that wouldn't
// delete ("chunkdata: EPERM: operation not permitted, unlink 'C:\...'")
// and a vehicles.db cleanup failure ("vehicles.db: EBUSY: ... open '...'")
// -- in `errors`, and the first of them in `error` too, so the save's full
// path reached the caller. They now go through sanitizeError(), with the
// configured folders, as the map-file failures next to them already did.
//
// Same harness as chunksDeletionLogic.test.js: real temp folders, the
// route's own permission gate and handler. A directory where a chunk file
// should be makes unlink fail for real; vehicles.db's cleanup is faked to
// throw the shape of error a locked database gives.

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

const { getActiveServer, getServers, getSetting } = await import("../database/init.js");
const { deleteVehiclesInBoxes } = await import("../utils/vehiclesDb.js");
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

// Every way the save's folder could show in the response: as written, with
// the other slash, and the distinctive part of the temp folder's name.
function expectNoFolderIn(body) {
  const text = JSON.stringify(body);
  for (const form of [dataRoot, dataRoot.replace(/\\/g, "/"), path.basename(dataRoot)]) {
    expect(text).not.toContain(form);
    expect(text).not.toContain(JSON.stringify(form).slice(1, -1));
  }
  expect(text).toContain("[path]");
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp m3 redaction-"));
  savePath = path.join(dataRoot, "Saves", "Multiplayer", SAVE_NAME);
  fs.mkdirSync(savePath, { recursive: true });
  getActiveServer.mockReset().mockResolvedValue({
    id: "server-1",
    zomboidDataPath: dataRoot,
    isRemote: false,
  });
  getServers.mockReset().mockResolvedValue([]);
  getSetting.mockReset().mockResolvedValue(null);
  deleteVehiclesInBoxes.mockReset().mockImplementation(async (save) => {
    const dbPath = path.join(save, "vehicles.db");
    throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${dbPath}'`), { code: "EBUSY" });
  });
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe("M3: chunk deletion failures name no folder", () => {
  it("delete-chunks: a chunkdata file that won't delete is reported without its path, in errors, error and params", async () => {
    fs.mkdirSync(path.join(savePath, "chunkdata", "0_0.bin"), { recursive: true });

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "0_0.bin", source: "chunkdata", x: 0, y: 0 }],
    });

    const body = res.getBody();
    expect(body.success).toBe(false);
    expect(body.code).toBe("DELETE_CHUNKS_ALL_FAILED");
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatch(/^0_0\.bin: chunkdata: /);
    expectNoFolderIn(body);
    // Still on disk: nothing was deleted.
    expect(fs.existsSync(path.join(savePath, "chunkdata", "0_0.bin"))).toBe(true);
  });

  it("delete-chunks: a vehicles.db cleanup failure is reported without its path", async () => {
    writeFileDeep(path.join(savePath, "map", "0", "0.bin"));

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "0/0.bin", x: 0, y: 0 }],
      deleteVehicles: true,
    });

    const body = res.getBody();
    expect(deleteVehiclesInBoxes).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ success: true, deleted: 1 });
    expect(body.errors).toEqual([expect.stringMatching(/^vehicles\.db: EBUSY: resource busy or locked, open /)]);
    expectNoFolderIn(body);
  });

  it("delete-region: a vehicles.db cleanup failure is reported without its path", async () => {
    writeFileDeep(path.join(savePath, "map", "2", "2.bin"));

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 5,
      minY: 0,
      maxY: 5,
      deleteVehicles: true,
    });

    const body = res.getBody();
    expect(deleteVehiclesInBoxes).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ success: true, deleted: 1 });
    expect(body.errors).toEqual([expect.stringMatching(/^vehicles\.db: EBUSY: resource busy or locked, open /)]);
    expectNoFolderIn(body);
  });

  it("legit: a clean delete reports no errors, and a failure still says which file and why", async () => {
    writeFileDeep(path.join(savePath, "map", "0", "0.bin"));
    deleteVehiclesInBoxes.mockResolvedValue({ deleted: 2, skipped: false });

    const clean = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "0/0.bin", x: 0, y: 0 }],
      deleteVehicles: true,
    });
    expect(clean.getBody()).toMatchObject({ success: true, deleted: 1, vehiclesDeleted: 2 });
    expect(clean.getBody().errors).toBeUndefined();

    fs.mkdirSync(path.join(savePath, "chunkdata", "1_1.bin"), { recursive: true });
    const failed = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "1_1.bin", source: "chunkdata", x: 32, y: 32 }],
    });
    // The code and the file are kept; only the folder goes.
    expect(failed.getBody().errors[0]).toMatch(/^1_1\.bin: chunkdata: E[A-Z]+: .*unlink/);
  });
});
