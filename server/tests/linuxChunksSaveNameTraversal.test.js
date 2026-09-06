import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// hunt-wave10-2026-08-29, suspect #3 (path construction / containment).
//
// Every destructive/read route in chunks.js used to sanitize saveName with
// just:
//
//   const sanitizedSaveName = path.basename(saveName);
//   if (!sanitizedSaveName || sanitizedSaveName !== saveName) { reject }
//
// That DOES block every traversal payload that contains a path separator
// ("../x", "a/../../b", "x/") -- path.basename() strips everything up to
// the last separator, so the sanitized value never matches the original and
// the request is rejected. It did NOT block the two special dot-segments
// "." and ".." on their own, with no separator anywhere in the string:
// path.basename(".") === "." and path.basename("..") === ".." (both are
// already "just a basename" by Node's own definition), so the equality
// check that catches every other traversal payload was a no-op for these
// two specific inputs -- proven directly against Node's path module, not
// just asserted:
//   path.basename("..") === ".."   (was NOT rejected, pre-fix)
//   path.basename(".")  === "."    (was NOT rejected, pre-fix)
//
// Proven real end-to-end BEFORE the fix (this file, pre-fix commit): a
// decoy chunk-shaped file placed directly under Saves/ (outside any actual
// save's own directory, unreachable through the normal saveName-scoped UI)
// was deleted by POST /delete-region given saveName:"..", and GET
// /stats/:saveName given saveName:".." returned an aggregate size across
// every sibling save instead of the one the caller asked for -- on a route
// that carries no permission check at all (see item 6). Fixed by adding an
// explicit "." / ".." rejection alongside the existing basename check at
// all four call sites. This file now asserts the FIXED (rejecting)
// behavior; see the fix commit's diff for the pre-fix red state this was
// break-verified against.
vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getRoleByName: mockGetRoleByName,
  getServers: vi.fn(),
  getSetting: vi.fn(),
}));

const { getActiveServer, getServers, getSetting } = await import("../database/init.js");
const { default: router } = await import("../routes/chunks.js");

function createResponse() {
  const response = { status: () => response, json: () => response };
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

function getRouteHandlers(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(routePath, method, req) {
  const handlers = getRouteHandlers(routePath, method);
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

// expectedServerId defaults to "server-1" to match beforeEach's own
// getActiveServer mock -- bug-hunt-2026-09-06: delete-chunks/delete-region
// now refuse (CHUNKS_STALE_SERVER_SCAN) without it.
function postAs(routePath, body) {
  return runRoute(routePath, "post", {
    user: { role: "technician" },
    body: {
      force: true,
      createBackup: false,
      deleteVehicles: false,
      expectedServerId: "server-1",
      ...body,
    },
  });
}

function getAs(routePath, params, query = {}) {
  return runRoute(routePath, "get", {
    user: { role: "technician" },
    params,
    query,
    app: { get: () => null },
  });
}

function writeFileDeep(p, content = "x") {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

let dataRoot;
let multiplayerPath; // <dataRoot>/Saves/Multiplayer
let savesPath; // <dataRoot>/Saves
const SAVE_NAME = "TestSave";

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-traversal-"));
  savesPath = path.join(dataRoot, "Saves");
  multiplayerPath = path.join(savesPath, "Multiplayer");
  fs.mkdirSync(path.join(multiplayerPath, SAVE_NAME), { recursive: true });
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

describe("saveName sanitization: '.' and '..' must be rejected even though path.basename() leaves them unchanged", () => {
  it("path.basename leaves '..' and '.' byte-for-byte unchanged (ground truth this whole file's fix relies on)", () => {
    expect(path.basename("..")).toBe("..");
    expect(path.basename(".")).toBe(".");
    // Contrast: every OTHER traversal shape is genuinely caught by the
    // basename-changed check alone -- no fix was needed for these.
    expect(path.basename("../etc")).not.toBe("../etc");
    expect(path.basename("a/../../b")).not.toBe("a/../../b");
  });

  it("POST /delete-region rejects saveName:'..' as an invalid save name", async () => {
    const res = await postAs("/delete-region", {
      saveName: "..",
      minX: 0,
      maxX: 100,
      minY: 0,
      maxY: 100,
    });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()?.code).toBe("CHUNKS_INVALID_SAVE_NAME");
  });

  it("POST /delete-region rejects saveName:'..' BEFORE ever touching the filesystem -- a decoy chunk-shaped file living outside any save survives untouched", async () => {
    const decoy = path.join(savesPath, "map_5_5.bin");
    writeFileDeep(decoy, "decoy");
    const realSaveMarker = path.join(multiplayerPath, SAVE_NAME, "players.db");
    writeFileDeep(realSaveMarker, "real save data");

    const res = await postAs("/delete-region", {
      saveName: "..",
      minX: 0,
      maxX: 10,
      minY: 0,
      maxY: 10,
    });

    expect(res.getStatusCode()).toBe(400);
    expect(fs.existsSync(decoy)).toBe(true); // never reached -- rejected before any fs write
    expect(fs.existsSync(realSaveMarker)).toBe(true);
  });

  it("POST /delete-chunks rejects saveName:'..' the same way", async () => {
    const res = await postAs("/delete-chunks", {
      saveName: "..",
      chunks: [{ file: "0/0.bin", x: 0, y: 0 }],
    });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()?.code).toBe("CHUNKS_INVALID_SAVE_NAME");
  });

  it("GET /stats/:saveName rejects saveName:'..' -- no aggregate-size leak across sibling saves", async () => {
    writeFileDeep(path.join(multiplayerPath, "OtherSaveA", "map", "0", "0.bin"), "aaaaaaaaaa");
    writeFileDeep(path.join(multiplayerPath, SAVE_NAME, "map", "0", "0.bin"), "z");

    const res = await getAs("/stats/:saveName", { saveName: ".." });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()?.code).toBe("CHUNKS_INVALID_SAVE_NAME");
  });

  it("GET /chunks/:saveName rejects saveName:'..' the same way", async () => {
    const res = await getAs("/chunks/:saveName", { saveName: ".." });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()?.code).toBe("CHUNKS_INVALID_SAVE_NAME");
  });

  it("saveName:'.' is rejected the same way on POST /delete-region", async () => {
    const res = await postAs("/delete-region", {
      saveName: ".",
      minX: 0,
      maxX: 100,
      minY: 0,
      maxY: 100,
    });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()?.code).toBe("CHUNKS_INVALID_SAVE_NAME");
  });

  it("legitimate save names unaffected by the fix -- a normal name and a name that happens to start with a dot both still work", async () => {
    fs.mkdirSync(path.join(multiplayerPath, ".hidden-ish-name"), { recursive: true });
    const normal = await getAs("/stats/:saveName", { saveName: SAVE_NAME });
    const dotPrefixed = await getAs("/stats/:saveName", { saveName: ".hidden-ish-name" });
    expect(normal.getStatusCode()).toBe(200);
    expect(dotPrefixed.getStatusCode()).toBe(200);
  });
});
