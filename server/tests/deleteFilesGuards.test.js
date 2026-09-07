import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn(),
  getActiveServer: vi.fn(),
  getServers: vi.fn(),
}));

const { default: router } = await import("../routes/server.js");
const { getServers } = await import("../database/init.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getDeleteFilesHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/delete-files" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

// Same guard shape POST /wipe already has: refuse without confirm, refuse
// while the server is running, and fail closed (not open) when detection
// itself can't tell whether the server is running -- see d85fd42, where
// checkServerRunning() collapsing a failed scan into `false` let several
// callers treat "cannot tell" as "stopped".
describe("POST /api/server/delete-files safety guards", () => {
  let installDir;
  let serverManager;

  beforeEach(() => {
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-delete-files-"));
    // A PZ marker file, so the existing "is this really a PZ install"
    // check passes and the guards under test are the only thing left
    // that could refuse the request.
    fs.writeFileSync(path.join(installDir, "ProjectZomboid64.json"), "{}");
    serverManager = {
      loadConfig: async () => {},
      // split-derivation sweep, 2026-09-07: the route no longer trusts a
      // flat `running` field (that was serverManager's own ambient
      // active-server state, not necessarily the server being deleted) --
      // it matches the TARGET server's installPath against `matched`, the
      // same system-wide process list servers.js's per-server-status route
      // already keys off of. Default: no processes found at all.
      getServerProcessDetails: async () => ({ scanFailed: false, matched: [] }),
    };
    // bug-hunt-2026-08-27: deletePath must now also match a configured
    // server's own installPath -- the marker-file check alone was
    // trivially satisfiable. Default every test to a configured server
    // pointing at installDir, so the existing guard tests (which exercise
    // everything ELSE about this route) keep exercising just that, not
    // this new check too; the new check gets its own tests below.
    getServers.mockReset();
    getServers.mockResolvedValue([{ id: 1, installPath: installDir }]);
  });

  afterEach(() => {
    fs.rmSync(installDir, { recursive: true, force: true });
  });

  const buildRequest = (body) => ({
    app: { get: () => serverManager },
    body: { path: installDir, ...body },
  });

  it("refuses without confirm: true", async () => {
    const handler = getDeleteFilesHandler();
    const response = createResponse();

    await handler(buildRequest({}), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      // Own code as of 2026-08-26 bug hunt round 2 -- used to share
      // WIPE_CONFIRM_REQUIRED with /wipe; split out, see errorCodes.js.
      expect.objectContaining({ code: "DELETE_FILES_CONFIRM_REQUIRED" }),
    );
    // Refusal must be real, not just the wrong status code with the delete
    // happening anyway.
    expect(fs.existsSync(installDir)).toBe(true);
  });

  it("refuses while the server is running", async () => {
    serverManager.getServerProcessDetails = async () => ({
      scanFailed: false,
      matched: [{ cmd: installDir, pid: 111 }],
    });
    const handler = getDeleteFilesHandler();
    const response = createResponse();

    await handler(buildRequest({ confirm: true }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      // Same code /wipe uses for the same gap -- see errorCodes.js.
      expect.objectContaining({ code: "WIPE_SERVER_RUNNING" }),
    );
    expect(fs.existsSync(installDir)).toBe(true);
  });

  // split-derivation sweep, 2026-09-07 (the actual bug this route had):
  // before the fix, "is it running" was answered from serverManager's own
  // ambient state -- whichever server the panel currently has
  // active/loaded, NOT necessarily installDir's owner. This simulates the
  // exact wrong-pairing scenario: the ACTIVE server (id 2, a different
  // install path, tracked by serverManager) is stopped, while the TARGET
  // of this delete (id 1, installDir, not active) is actually running.
  // Pre-fix, this would have sailed through -- serverManager.running would
  // have reported the ACTIVE server's (stopped) state, not installDir's.
  it("refuses to delete a NON-active configured server's files while THAT server is running, even though the active server (tracked by serverManager) is stopped", async () => {
    const otherInstallDir = path.join(os.tmpdir(), "pz-other-active-server");
    getServers.mockResolvedValue([
      { id: 1, installPath: installDir },
      { id: 2, installPath: otherInstallDir },
    ]);
    // serverManager's own process-detection reports the ACTIVE server
    // (id 2) is stopped -- but the scan itself is system-wide, so its
    // `matched` list still surfaces installDir's (id 1's) real process.
    serverManager.getServerProcessDetails = async () => ({
      scanFailed: false,
      matched: [{ cmd: installDir, pid: 222 }],
    });

    const handler = getDeleteFilesHandler();
    const response = createResponse();

    await handler(buildRequest({ confirm: true }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "WIPE_SERVER_RUNNING" }),
    );
    expect(fs.existsSync(installDir)).toBe(true);
  });

  it("refuses when it cannot be determined whether the server is running (fails closed)", async () => {
    serverManager.getServerProcessDetails = async () => ({
      matched: [],
      scanFailed: true,
    });
    const handler = getDeleteFilesHandler();
    const response = createResponse();

    await handler(buildRequest({ confirm: true }), response);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
    );
    expect(fs.existsSync(installDir)).toBe(true);
  });

  it("still deletes on the happy path: stopped, confirmed, a real PZ install", async () => {
    const handler = getDeleteFilesHandler();
    const response = createResponse();

    await handler(buildRequest({ confirm: true }), response);

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(fs.existsSync(installDir)).toBe(false);
  });

  // bug-hunt-2026-08-27: hasPzInstallMarker() only checked whether a
  // marker FILENAME exists in the target directory -- trivially satisfied
  // by creating an empty file with that name anywhere on the host. This
  // was never an authorization check, just a "does this look like a PZ
  // folder" sanity check. deletePath must now also exactly match a
  // configured server's own installPath.
  describe("refuses a directory with real PZ markers that isn't a configured server's installPath", () => {
    it("refuses when no configured server points at this path (the marker file alone is not enough)", async () => {
      getServers.mockResolvedValue([]);
      const handler = getDeleteFilesHandler();
      const response = createResponse();

      await handler(buildRequest({ confirm: true }), response);

      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "DELETE_FILES_NOT_CONFIGURED_SERVER" }),
      );
      // The whole point: a real PZ marker file was present (see beforeEach)
      // and it must not be enough on its own -- the install must survive.
      expect(fs.existsSync(installDir)).toBe(true);
    });

    it("refuses when configured servers exist but none of them point at this exact path", async () => {
      getServers.mockResolvedValue([
        { id: 1, installPath: path.join(os.tmpdir(), "some-other-server") },
      ]);
      const handler = getDeleteFilesHandler();
      const response = createResponse();

      await handler(buildRequest({ confirm: true }), response);

      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "DELETE_FILES_NOT_CONFIGURED_SERVER" }),
      );
      expect(fs.existsSync(installDir)).toBe(true);
    });

    it("refuses when the only configured server has no installPath set", async () => {
      getServers.mockResolvedValue([{ id: 1, installPath: null }]);
      const handler = getDeleteFilesHandler();
      const response = createResponse();

      await handler(buildRequest({ confirm: true }), response);

      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "DELETE_FILES_NOT_CONFIGURED_SERVER" }),
      );
      expect(fs.existsSync(installDir)).toBe(true);
    });

    it("still deletes when a DIFFERENT configured server's installPath happens to also match, not just the first one", async () => {
      getServers.mockResolvedValue([
        { id: 1, installPath: path.join(os.tmpdir(), "some-other-server") },
        { id: 2, installPath: installDir },
      ]);
      const handler = getDeleteFilesHandler();
      const response = createResponse();

      await handler(buildRequest({ confirm: true }), response);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
      expect(fs.existsSync(installDir)).toBe(false);
    });
  });

  // 2026-08-26 bug hunt round 2, Pam's finding 2 (original shape): the
  // entry check happened once, then everything after it (path/marker
  // validation) was synchronous, so a server that started DURING that
  // first scan would sail through the second check undetected -- fixed by
  // re-checking immediately before the delete too.
  //
  // split-derivation sweep, 2026-09-07: that "first" check is GONE now, not
  // just fixed -- it ran before deletePath was even parsed, so it was
  // structurally checking the wrong server's state by construction (see
  // server.js's comment on checkSpecificServerStopped). There is only one
  // check left, and it is positioned exactly where the old "second" check
  // was: immediately before the delete. This test now guards against that
  // redundant premature check ever coming back, rather than simulating a
  // race between two checks that no longer both exist.
  it("checks the target server's process state exactly once, immediately before the delete -- not a stale entry check", async () => {
    let calls = 0;
    serverManager.getServerProcessDetails = async () => {
      calls += 1;
      return { scanFailed: false, matched: [] };
    };
    const handler = getDeleteFilesHandler();
    const response = createResponse();

    await handler(buildRequest({ confirm: true }), response);

    expect(calls).toBe(1);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  // 2026-08-26 bug hunt round 2 follow-up, Michelle's UX audit: "Delete
  // Everything" in Servers.tsx uses this exact endpoint on installPath, with
  // only a checkbox and one click -- fine for the DEFAULT layout, where
  // resolveZomboidPaths keeps the Zomboid data folder at a sibling
  // `<installPath>_Data`, so this delete only costs a SteamCMD reinstall.
  // But nothing stopped an operator from pointing zomboidDataPath INSIDE the
  // install folder, in which case this same one-click delete also destroys
  // the world save with no separate copy -- the actual "delete that doesn't
  // look like one." These simulate that configuration directly.
  describe("refuses when the TARGET server's Zomboid data folder is inside the folder being deleted", () => {
    // split-derivation sweep, 2026-09-07: this check now reads
    // targetServer.zomboidDataPath (the matched getServers() record) instead
    // of serverManager.savePath -- the latter reflects whichever server is
    // currently active/loaded, not necessarily the server whose files are
    // being deleted (see the delete-files-targets-a-non-active-server test
    // above for the same class of bug on the stopped-check).
    it("refuses when zomboidDataPath is a subfolder of the install path being deleted", async () => {
      const dataDir = path.join(installDir, "ZomboidData");
      fs.mkdirSync(dataDir, { recursive: true });
      getServers.mockResolvedValue([
        { id: 1, installPath: installDir, zomboidDataPath: dataDir },
      ]);

      const handler = getDeleteFilesHandler();
      const response = createResponse();

      await handler(buildRequest({ confirm: true }), response);

      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "DELETE_FILES_DATA_PATH_NESTED" }),
      );
      expect(fs.existsSync(installDir)).toBe(true);
    });

    it("refuses when zomboidDataPath equals the install path being deleted", async () => {
      getServers.mockResolvedValue([
        { id: 1, installPath: installDir, zomboidDataPath: installDir },
      ]);

      const handler = getDeleteFilesHandler();
      const response = createResponse();

      await handler(buildRequest({ confirm: true }), response);

      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "DELETE_FILES_DATA_PATH_NESTED" }),
      );
      expect(fs.existsSync(installDir)).toBe(true);
    });

    it("still deletes when zomboidDataPath is a sibling, not nested (the default layout)", async () => {
      const siblingDataDir = `${installDir}_Data`;
      fs.mkdirSync(siblingDataDir, { recursive: true });
      getServers.mockResolvedValue([
        { id: 1, installPath: installDir, zomboidDataPath: siblingDataDir },
      ]);

      const handler = getDeleteFilesHandler();
      const response = createResponse();

      try {
        await handler(buildRequest({ confirm: true }), response);

        expect(response.json).toHaveBeenCalledWith(
          expect.objectContaining({ success: true }),
        );
        expect(fs.existsSync(installDir)).toBe(false);
        expect(fs.existsSync(siblingDataDir)).toBe(true);
      } finally {
        fs.rmSync(siblingDataDir, { recursive: true, force: true });
      }
    });

    it("still deletes when the target server has no zomboidDataPath configured at all", async () => {
      getServers.mockResolvedValue([
        { id: 1, installPath: installDir, zomboidDataPath: null },
      ]);

      const handler = getDeleteFilesHandler();
      const response = createResponse();

      await handler(buildRequest({ confirm: true }), response);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
      expect(fs.existsSync(installDir)).toBe(false);
    });
  });
});
