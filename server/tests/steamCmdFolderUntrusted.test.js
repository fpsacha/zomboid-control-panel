import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// SECURITY (2026-10-28): SteamCMD is a program the panel runs from whatever
// folder the steamcmdPath setting names, and server.install (technician)
// sets it -- straight off GET /branches' query string included. Pointed at
// a downloaded Workshop item (anyone who owns the game can publish one with
// a steamcmd.exe/steamcmd.sh in it, and mods.manage downloads it) or at a
// Windows network share, the panel ran the attacker's binary. Such a folder
// is refused where a request names it, and a saved one is never run.
// launchFolderUntrusted.test.js covers the same rule for a server's launch
// folder.

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

const settingsStore = {};
vi.mock("../database/init.js", () => ({
  getAllSettings: vi.fn(async () => ({ ...settingsStore })),
  getSetting: vi.fn(async (key) => settingsStore[key] ?? null),
  setSetting: vi.fn(async (key, value) => {
    settingsStore[key] = value;
  }),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
  getRoleByName: vi.fn(async () => ({ capabilities: ["panel.settings", "server.install"] })),
}));

const { ErrorCode } = await import("../utils/errorCodes.js");
const { downloadWorkshopItem, WorkshopDownloadReason } = await import("../services/workshopDownload.js");

const isWindows = process.platform === "win32";
const binaryName = isWindows ? "steamcmd.exe" : "steamcmd.sh";

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

function lastHandler(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function getBranches(query) {
  const { default: router } = await import("../routes/server.js");
  const res = createResponse();
  await lastHandler(router, "/branches", "get")({ query, app: { get: () => undefined } }, res);
  return res;
}

let root;
let workshopItem;
let installDir;

beforeEach(() => {
  spawnMock.mockReset();
  for (const key of Object.keys(settingsStore)) delete settingsStore[key];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-steamcmd-folder-"));
  installDir = path.join(root, "pz");
  workshopItem = path.join(installDir, "steamapps", "workshop", "content", "108600", "3000000002");
  fs.mkdirSync(workshopItem, { recursive: true });
  fs.writeFileSync(path.join(workshopItem, binaryName), "");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GET /api/server/branches -- SteamCMD from a Workshop item", () => {
  it("refuses a Workshop item named in the query: nothing saved, nothing run", async () => {
    const res = await getBranches({ steamcmdPath: workshopItem });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe(ErrorCode.STEAMCMD_FOLDER_REFUSED);
    expect(settingsStore.steamcmdPath).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("never runs a Workshop item saved as the SteamCMD folder before the check", async () => {
    settingsStore.steamcmdPath = workshopItem;
    const res = await getBranches({});
    expect(res.getStatusCode()).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.skipIf(!isWindows)("refuses a network share named in the query (adversary pass)", async () => {
    const res = await getBranches({ steamcmdPath: "\\\\127.0.0.1\\zcp-no-such-share" });
    expect(res.getStatusCode()).toBe(400);
    // isValidPath() refuses a network path first (uncPathsNeverTouched.test.js).
    expect([ErrorCode.STEAMCMD_PATH_INVALID, ErrorCode.STEAMCMD_FOLDER_REFUSED]).toContain(res.getBody().code);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("PUT /api/config/app-settings -- steamcmdPath", () => {
  it("refuses a Workshop item as the SteamCMD folder", async () => {
    const { default: router } = await import("../routes/config.js");
    const res = createResponse();
    await lastHandler(router, "/app-settings", "put")(
      { body: { settings: { steamcmdPath: workshopItem } }, user: { role: "admin" }, app: { get: () => undefined } },
      res,
    );
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe(ErrorCode.STEAMCMD_FOLDER_REFUSED);
    expect(settingsStore.steamcmdPath).toBeUndefined();
  });
});

describe("downloadWorkshopItem() -- a saved Workshop SteamCMD folder counts as missing", () => {
  it("does not run SteamCMD from a Workshop item", async () => {
    const spawn = vi.fn();
    const result = await downloadWorkshopItem("3000000003", {
      serverPath: installDir,
      spawn,
      readSetting: async () => workshopItem,
    });
    expect(result.reason).toBe(WorkshopDownloadReason.STEAMCMD_NOT_FOUND);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("UpdateChecker -- a saved Workshop SteamCMD folder is never run", () => {
  it("getLatestBuildInfo() refuses it without spawning SteamCMD", async () => {
    const { UpdateChecker } = await import("../services/updateChecker.js");
    const checker = new UpdateChecker(null, {});
    await expect(checker.getLatestBuildInfo(workshopItem, "public", installDir)).rejects.toThrow(/Workshop/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
