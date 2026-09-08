import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// steamcmd-routes-running-check card, third finding: /wipe never checked
// for an in-progress SteamCMD operation before deleting the save tree. A
// default install keeps zomboidDataPath OUTSIDE installPath (resolveZomboidPaths
// defaults it to a sibling `<installPath>_Data`), so this is normally a
// non-issue -- but nothing stops an operator from nesting zomboidDataPath
// INSIDE installPath instead, and when that's the configuration, a wipe
// running while POST /install or POST /steam-update is actively writing
// into that same tree deletes/recreates files SteamCMD has open. Same guard
// those two routes already claim before spawning, reused here (Convention
// already established for /delete-files, the sibling/sharper instance of
// this same gap) rather than a new lock -- activeSteamOperations is already
// scoped per install path.
//
// activeSteamOperations is the real, unmocked module here (module-level
// Map) -- these tests populate/clear it directly rather than mocking
// hasActiveSteamOperation(), so the real liveness/claim semantics are what's
// under test.

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn(),
  getActiveServer: vi.fn(),
}));

const { getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/server.js");
const { getActiveSteamOperations } = await import(
  "../services/activeSteamOperations.js"
);

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getWipeHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/wipe" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

const SERVER_NAME = "servertest";
let root;
let installPath;
let savePath;
let saveDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-wipe-steam-op-"));
  installPath = path.join(root, "install");
  // The dangerous, non-default configuration this guard exists for:
  // zomboidDataPath nested INSIDE installPath.
  savePath = path.join(installPath, "Data");
  saveDir = path.join(savePath, "Saves", "Multiplayer", SERVER_NAME);
  fs.mkdirSync(path.join(saveDir, "map"), { recursive: true });
  fs.writeFileSync(path.join(saveDir, "map", "0_0.bin"), "chunk");
  getActiveServer.mockResolvedValue({
    name: SERVER_NAME,
    serverName: SERVER_NAME,
    installPath,
    zomboidDataPath: savePath,
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  getActiveSteamOperations().clear();
});

function buildRequest() {
  const serverManager = {
    loadConfig: async () => {},
    reloadConfig: async () => {},
    getServerProcessDetails: async () => ({
      running: false,
      scanFailed: false,
    }),
    savePath,
    serverName: SERVER_NAME,
  };
  const backupService = {
    createBackup: async () => ({ success: true, skippedFiles: [] }),
    getBackupsPath: async () => path.join(root, "backups"),
  };
  return {
    app: {
      get: (key) =>
        key === "serverManager"
          ? serverManager
          : key === "backupService"
            ? backupService
            : undefined,
    },
    body: { targets: ["map"], confirm: true, createBackup: false },
  };
}

describe("POST /api/server/wipe refuses while a SteamCMD operation is active for the active server's install path", () => {
  it("refuses with 409 when POST /install or /steam-update has already claimed this path, and does not delete anything", async () => {
    const normalizedPath = path.normalize(installPath).toLowerCase();
    // No `pid` yet -- the real early-claim window, set before the child's
    // pid is known. hasActiveSteamOperation() must treat this as active
    // without needing a liveness probe.
    getActiveSteamOperations().set(normalizedPath, {
      type: "install",
      startTime: Date.now(),
    });

    const handler = getWipeHandler();
    const response = createResponse();
    await handler(buildRequest(), response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "STEAM_OPERATION_IN_PROGRESS_PATH" }),
    );
    expect(fs.existsSync(path.join(saveDir, "map", "0_0.bin"))).toBe(true);
  });

  it("refuses with 409 once a real pid is recorded and still alive", async () => {
    const normalizedPath = path.normalize(installPath).toLowerCase();
    getActiveSteamOperations().set(normalizedPath, {
      type: "steam-update",
      startTime: Date.now(),
      pid: process.pid,
    });

    const handler = getWipeHandler();
    const response = createResponse();
    await handler(buildRequest(), response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(fs.existsSync(path.join(saveDir, "map", "0_0.bin"))).toBe(true);
  });

  it("does not refuse once the operation has cleared -- proceeds normally", async () => {
    const normalizedPath = path.normalize(installPath).toLowerCase();
    getActiveSteamOperations().set(normalizedPath, {
      type: "install",
      startTime: Date.now(),
    });
    getActiveSteamOperations().delete(normalizedPath);

    const handler = getWipeHandler();
    const response = createResponse();
    await handler(buildRequest(), response);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("an active operation for a DIFFERENT path (the default, non-nested configuration) does not block the wipe", async () => {
    getActiveSteamOperations().set("z:\\some\\other\\unrelated\\path", {
      type: "install",
      startTime: Date.now(),
    });

    const handler = getWipeHandler();
    const response = createResponse();
    await handler(buildRequest(), response);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("a server with no installPath configured at all skips the check rather than throwing", async () => {
    getActiveServer.mockResolvedValue({
      name: SERVER_NAME,
      serverName: SERVER_NAME,
      installPath: null,
      zomboidDataPath: savePath,
    });

    const handler = getWipeHandler();
    const response = createResponse();
    await handler(buildRequest(), response);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });
});
