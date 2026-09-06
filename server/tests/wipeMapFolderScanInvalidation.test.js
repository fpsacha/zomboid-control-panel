import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn(),
  getActiveServer: vi.fn(),
}));

const { invalidateMapFolderScanMock } = vi.hoisted(() => ({
  invalidateMapFolderScanMock: vi.fn(),
}));
vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: invalidateMapFolderScanMock,
}));

const { default: router } = await import("../routes/server.js");
const { getActiveServer } = await import("../database/init.js");

const SERVER_NAME = "servertest";

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

let root;
let savePath;
let saveDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-wipe-"));
  savePath = root;
  saveDir = path.join(savePath, "Saves", "Multiplayer", SERVER_NAME);
  fs.mkdirSync(path.join(saveDir, "map"), { recursive: true });
  fs.writeFileSync(path.join(saveDir, "map", "0_0.bin"), "chunk");
  invalidateMapFolderScanMock.mockClear();
  // path-resolution sweep, 2026-09-06: /wipe now derives its target from a
  // fresh getActiveServer() read instead of serverManager's cache -- see
  // wipeStaleServerManagerDerivation.test.js. Kept consistent with this
  // file's own serverManager stubs below (same savePath/serverName).
  getActiveServer.mockResolvedValue({
    zomboidDataPath: savePath,
    serverName: SERVER_NAME,
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("POST /api/server/wipe invalidates chunks.js's cached map/ folder scan", () => {
  it("invalidates the map/ scan cache after wiping the map target", async () => {
    // Regression: chunks.js's /chunks and /stats routes cache a scan of a
    // save's map/ folder for a few seconds (getMapFolderScan()'s TTL
    // backstop). /wipe deletes map/ outright but has no path to call into
    // chunks.js's own explicit invalidation -- without this, a page reload
    // within the TTL window after a wipe would show chunk counts for a
    // map/ folder that no longer exists.
    const serverManager = {
      loadConfig: async () => {},
      reloadConfig: async () => {},
      getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
      savePath,
      serverName: SERVER_NAME,
    };

    const handler = getWipeHandler();
    const response = createResponse();
    await handler(
      {
        app: { get: () => serverManager },
        // createBackup: false -- this test is about the map/ scan cache,
        // not about the pre-wipe backup step; the shared `app.get` mock
        // above has no real backupService to hand back, and reaching that
        // code here would just be testing a different route's plumbing.
        body: { targets: ["map"], confirm: true, createBackup: false },
      },
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(invalidateMapFolderScanMock).toHaveBeenCalledWith(
      path.join(saveDir, "map"),
    );
  });

  it("does not invalidate the map/ scan cache when only non-map targets are wiped", async () => {
    const serverManager = {
      loadConfig: async () => {},
      reloadConfig: async () => {},
      getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
      savePath,
      serverName: SERVER_NAME,
    };

    const handler = getWipeHandler();
    const response = createResponse();
    await handler(
      {
        app: { get: () => serverManager },
        body: { targets: ["players"], confirm: true, createBackup: false },
      },
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(invalidateMapFolderScanMock).not.toHaveBeenCalled();
  });
});
