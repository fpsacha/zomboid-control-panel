import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// sweep6-lifecycle-lock-completeness: POST /restore/:name never checked for
// an in-progress SteamCMD operation before extracting an archive over
// zomboidDataPath. A default install keeps zomboidDataPath OUTSIDE
// installPath, so this is normally a non-issue -- but nothing stops an
// operator from nesting zomboidDataPath INSIDE installPath instead, and when
// that's the configuration, a restore running while POST /install or POST
// /steam-update is actively writing into that same tree extracts over files
// SteamCMD has open. Identical shape to the /wipe gap fixed in 2cb3ac75 --
// same guard, same convention, just never extended to this route.
//
// activeSteamOperations is the real, unmocked module here (module-level Map)
// -- these tests populate/clear it directly rather than mocking
// hasActiveSteamOperation(), so the real liveness/claim semantics are what's
// under test.

let activeServer;

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => activeServer),
  getRoleByName: mockGetRoleByName,
}));

const { default: router } = await import("../routes/backup.js");
const { getActiveSteamOperations } = await import(
  "../services/activeSteamOperations.js"
);

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

const SERVER_NAME = "servertest";
const installPath = "C:\\pz\\install";
// The dangerous, non-default configuration this guard exists for:
// zomboidDataPath nested INSIDE installPath.
const zomboidDataPath = path.join(installPath, "Data");

let restoreBackup;
let services;

beforeEach(() => {
  activeServer = {
    isRemote: false,
    name: SERVER_NAME,
    serverName: SERVER_NAME,
    installPath,
    zomboidDataPath,
  };
  restoreBackup = vi.fn(async () => ({ success: true }));
  services = {
    backupService: { restoreBackup },
    io: { emit: vi.fn() },
    serverManager: {
      checkServerRunning: async () => false,
      getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
    },
  };
});

afterEach(() => {
  getActiveSteamOperations().clear();
});

function postRestore() {
  return runRoute("/restore/:name", "post", {
    user: { role: "admin" },
    params: { name: "good.zip" },
    body: {},
    app: { get: (key) => services[key] },
  });
}

describe("backup.js POST /restore/:name refuses while a SteamCMD operation is active for the active server's install path", () => {
  it("refuses with 409 when POST /install or /steam-update has already claimed this path, and never calls restoreBackup", async () => {
    const normalizedPath = path.normalize(installPath).toLowerCase();
    // No `pid` yet -- the real early-claim window, set before the child's
    // pid is known. hasActiveSteamOperation() must treat this as active
    // without needing a liveness probe.
    getActiveSteamOperations().set(normalizedPath, {
      type: "install",
      startTime: Date.now(),
    });

    const res = await postRestore();

    expect(res.getStatusCode()).toBe(409);
    expect(res.getBody()).toMatchObject({ code: "STEAM_OPERATION_IN_PROGRESS_PATH" });
    expect(restoreBackup).not.toHaveBeenCalled();
  });

  it("refuses with 409 once a real pid is recorded and still alive", async () => {
    const normalizedPath = path.normalize(installPath).toLowerCase();
    getActiveSteamOperations().set(normalizedPath, {
      type: "steam-update",
      startTime: Date.now(),
      pid: process.pid,
    });

    const res = await postRestore();

    expect(res.getStatusCode()).toBe(409);
    expect(restoreBackup).not.toHaveBeenCalled();
  });

  it("does not refuse once the operation has cleared -- proceeds normally", async () => {
    const normalizedPath = path.normalize(installPath).toLowerCase();
    getActiveSteamOperations().set(normalizedPath, {
      type: "install",
      startTime: Date.now(),
    });
    getActiveSteamOperations().delete(normalizedPath);

    const res = await postRestore();

    expect(res.getStatusCode()).toBe(200);
    expect(restoreBackup).toHaveBeenCalledWith("good.zip", expect.anything());
  });

  it("an active operation for a DIFFERENT path (the default, non-nested configuration) does not block the restore", async () => {
    getActiveSteamOperations().set("z:\\some\\other\\unrelated\\path", {
      type: "install",
      startTime: Date.now(),
    });

    const res = await postRestore();

    expect(res.getStatusCode()).toBe(200);
    expect(restoreBackup).toHaveBeenCalled();
  });

  it("a server with no installPath configured at all skips the check rather than throwing", async () => {
    activeServer = {
      isRemote: false,
      name: SERVER_NAME,
      serverName: SERVER_NAME,
      installPath: null,
      zomboidDataPath,
    };

    const res = await postRestore();

    expect(res.getStatusCode()).toBe(200);
    expect(restoreBackup).toHaveBeenCalled();
  });
});
