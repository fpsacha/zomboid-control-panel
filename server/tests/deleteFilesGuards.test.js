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

// checkSpecificServerStopped() (server.js) scans the whole host and
// attributes candidates via the REAL scoreServerProcessOwnership() -- keep
// that real (importActual) and only replace ServerManager's host scan, so
// these tests exercise the actual attribution logic, not a re-description
// of it.
const scanHostForServerProcesses = vi.fn();

vi.mock("../services/serverManager.js", async () => {
  const actual = await vi.importActual("../services/serverManager.js");
  return {
    ...actual,
    ServerManager: vi.fn().mockImplementation(function () {
      this.scanHostForServerProcesses = scanHostForServerProcesses;
    }),
  };
});

const { default: router } = await import("../routes/server.js");
const { getServers } = await import("../database/init.js");
const { getActiveSteamOperations } = await import(
  "../services/activeSteamOperations.js"
);

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

  beforeEach(() => {
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-delete-files-"));
    // A PZ marker file, so the existing "is this really a PZ install"
    // check passes and the guards under test are the only thing left
    // that could refuse the request.
    fs.writeFileSync(path.join(installDir, "ProjectZomboid64.json"), "{}");
    // Default: no PZ processes anywhere on the host at all.
    scanHostForServerProcesses.mockReset().mockResolvedValue({ scanFailed: false, matched: [] });
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
    scanHostForServerProcesses.mockResolvedValue({
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

  // state-detection lane, 2026-09-07 (round 2 -- the exact scenario god
  // asked to be reproduced as a destructive-path test, not just a scoring
  // assertion): Server A is the target of THIS delete and is genuinely
  // stopped. Server B is a completely different, unrelated configured
  // server, and IS running, launched with its own -servername. Before this
  // fix, checkSpecificServerStopped asked the shared, ACTIVE-server-scoped
  // serverManager singleton "are you running" instead of scanning the host
  // and attributing by TARGET identity -- so this scenario's real danger
  // (a genuinely running non-active server) never even entered the
  // decision. Now: scoreServerProcessOwnership disqualifies Server B's
  // process against Server A's descriptor (mismatched -servername), so it
  // correctly contributes nothing to Server A's own verdict, and Server A
  // is correctly confirmed stopped -- proving the fix answers "is THIS ONE
  // stopped", not "is anything on the host running".
  it("still deletes a genuinely stopped target even while a completely different configured server is running", async () => {
    const otherInstallDir = path.join(os.tmpdir(), "pz-other-running-server");
    getServers.mockResolvedValue([
      { id: 1, installPath: installDir, serverName: "ServerA" },
      { id: 2, installPath: otherInstallDir, serverName: "ServerB" },
    ]);
    scanHostForServerProcesses.mockResolvedValue({
      scanFailed: false,
      matched: [
        {
          pid: 222,
          cmd: `java zombie.network.GameServer -servername "ServerB" -cachedir="${otherInstallDir}"`,
        },
      ],
    });

    const handler = getDeleteFilesHandler();
    const response = createResponse();

    await handler(buildRequest({ confirm: true }), response);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(fs.existsSync(installDir)).toBe(false);
  });

  // The actual destructive-path regression this round exists to close:
  // Server A (the delete target) is genuinely RUNNING but is not the
  // active/loaded server. Pre-fix, checkSpecificServerStopped asked the
  // shared serverManager singleton (scoped to whichever OTHER server was
  // active) whether IT was running -- so it could answer "not running"
  // while Server A's own real process sat right there in a host-wide scan
  // it never looked at. Assert the REFUSAL and that the install directory
  // survives -- the value of this finding is the deterministic destructive
  // path, not merely that a score changed.
  it("refuses to delete a target server's files while THAT target is running, even though it is not the active/loaded server", async () => {
    getServers.mockResolvedValue([
      { id: 1, installPath: installDir, serverName: "ServerA" },
    ]);
    scanHostForServerProcesses.mockResolvedValue({
      scanFailed: false,
      matched: [
        {
          pid: 111,
          cmd: `java zombie.network.GameServer -servername "ServerA" -cachedir="C:\\Zomboid\\A"`,
        },
      ],
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
    scanHostForServerProcesses.mockResolvedValue({
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

  // god's ruling, 2026-09-07: a recursive fs.rmSync against a live install
  // must not proceed on "probably stopped". A real PZ-server-shaped process
  // that scoreServerProcessOwnership can't attribute to this target OR rule
  // out (no -servername/-cachedir, install path doesn't match either) must
  // read the same as a failed scan -- refuse -- not as "safe to delete".
  it("refuses (fails closed) when a PZ-shaped process exists that can't be confirmed to belong to a different server", async () => {
    scanHostForServerProcesses.mockResolvedValue({
      scanFailed: false,
      matched: [
        // No -servername/-cachedir, and this cmd doesn't mention installDir
        // at all -- scoreServerProcessOwnership returns 0 (unattributable),
        // not -1 (positively someone else's).
        { pid: 999, cmd: "java -cp pz.jar zombie.network.GameServer" },
      ],
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

  // Review finding (2026-10-02): Windows can list a java.exe whose command
  // line the panel may not read (started as administrator or by another
  // user). With another server recognized next to it, that row used to be
  // dropped, and this target read as stopped although it may be that very
  // process.
  it("refuses (fails closed) when another server runs next to a process the panel can't read", async () => {
    const otherInstallDir = path.join(os.tmpdir(), "pz-other-running-server");
    getServers.mockResolvedValue([
      { id: 1, installPath: installDir, serverName: "ServerA" },
      { id: 2, installPath: otherInstallDir, serverName: "ServerB" },
    ]);
    scanHostForServerProcesses.mockResolvedValue({
      scanFailed: false,
      running: true,
      matched: [
        {
          pid: "222",
          cmd: `java zombie.network.GameServer -servername "ServerB" -cachedir="${otherInstallDir}"`,
        },
      ],
      unreadable: [{ pid: "7000", startedMs: 1790964741863 }],
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
    const handler = getDeleteFilesHandler();
    const response = createResponse();

    await handler(buildRequest({ confirm: true }), response);

    expect(scanHostForServerProcesses).toHaveBeenCalledTimes(1);
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

  // Quick Setup reuses the active server's install folder on purpose, so two
  // profiles can share one game folder. This route used to check only the
  // first profile with the path: with A stopped and B (same folder) running,
  // "Delete files" on A passed and rmSync wiped B's game files.
  describe("another profile uses the same game folder", () => {
    const runningB = () => ({
      scanFailed: false,
      matched: [
        {
          pid: 222,
          cmd: `java zombie.network.GameServer -servername "ServerB" -cachedir="${installDir}_B"`,
        },
      ],
    });

    it("refuses with a named 409 while that other profile is running, even with confirmShared", async () => {
      getServers.mockResolvedValue([
        { id: 1, name: "Alpha", installPath: installDir, serverName: "ServerA" },
        { id: 2, name: "Bravo", installPath: installDir, serverName: "ServerB" },
      ]);
      scanHostForServerProcesses.mockResolvedValue(runningB());

      const response = createResponse();
      await getDeleteFilesHandler()(buildRequest({ confirm: true, confirmShared: true }), response);

      expect(response.status).toHaveBeenCalledWith(409);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "INSTALL_FOLDER_SHARED_SERVER_RUNNING",
          params: { name: "Bravo" },
        }),
      );
      expect(fs.existsSync(installDir)).toBe(true);
    });

    // Adversary pass: the other profile reaches the same folder by another
    // spelling -- a trailing separator, other letter case (Windows), or a
    // launcher file inside it.
    it.each([
      ["a trailing separator", () => `${installDir}${path.sep}`],
      ["a launcher file inside the folder", () => path.join(installDir, "StartServer64.bat")],
      ...(process.platform === "win32" ? [["other letter case", () => installDir.toUpperCase()]] : []),
    ])("still finds a running profile whose path is written with %s", async (_label, spelling) => {
      getServers.mockResolvedValue([
        { id: 1, name: "Alpha", installPath: installDir, serverName: "ServerA" },
        { id: 2, name: "Bravo", installPath: spelling(), serverName: "ServerB" },
      ]);
      scanHostForServerProcesses.mockResolvedValue(runningB());

      const response = createResponse();
      await getDeleteFilesHandler()(buildRequest({ confirm: true, confirmShared: true }), response);

      expect(response.status).toHaveBeenCalledWith(409);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "INSTALL_FOLDER_SHARED_SERVER_RUNNING" }),
      );
      expect(fs.existsSync(installDir)).toBe(true);
    });

    it("still finds a running profile that reaches the folder through a junction/symlink", async () => {
      const link = `${installDir}-link`;
      fs.symlinkSync(installDir, link, "junction");
      try {
        getServers.mockResolvedValue([
          { id: 1, name: "Alpha", installPath: installDir, serverName: "ServerA" },
          { id: 2, name: "Bravo", installPath: link, serverName: "ServerB" },
        ]);
        scanHostForServerProcesses.mockResolvedValue(runningB());

        const response = createResponse();
        await getDeleteFilesHandler()(buildRequest({ confirm: true, confirmShared: true }), response);

        expect(response.status).toHaveBeenCalledWith(409);
        expect(response.json).toHaveBeenCalledWith(
          expect.objectContaining({ code: "INSTALL_FOLDER_SHARED_SERVER_RUNNING" }),
        );
        expect(fs.existsSync(installDir)).toBe(true);
      } finally {
        // The link only, never what it points at.
        try {
          fs.unlinkSync(link);
        } catch {
          fs.rmdirSync(link);
        }
      }
    });

    it("asks for confirmShared, naming the other profiles, when they are stopped", async () => {
      getServers.mockResolvedValue([
        { id: 1, name: "Alpha", installPath: installDir, serverName: "ServerA" },
        { id: 2, name: "Bravo", installPath: installDir, serverName: "ServerB" },
      ]);

      const response = createResponse();
      await getDeleteFilesHandler()(buildRequest({ confirm: true }), response);

      expect(response.status).toHaveBeenCalledWith(409);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "DELETE_FILES_FOLDER_SHARED",
          params: { names: "Bravo" },
          sharedWith: [{ id: 2, name: "Bravo" }],
        }),
      );
      expect(fs.existsSync(installDir)).toBe(true);
    });

    it("deletes with confirmShared once every profile using the folder is stopped", async () => {
      getServers.mockResolvedValue([
        { id: 1, name: "Alpha", installPath: installDir, serverName: "ServerA" },
        { id: 2, name: "Bravo", installPath: installDir, serverName: "ServerB" },
      ]);

      const response = createResponse();
      await getDeleteFilesHandler()(buildRequest({ confirm: true, confirmShared: true }), response);

      expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      expect(fs.existsSync(installDir)).toBe(false);
      // One host scan, shared by every profile using the folder.
      expect(scanHostForServerProcesses).toHaveBeenCalledTimes(1);
    });

    it("refuses when the other profile's world save is inside the folder, even with confirmShared", async () => {
      const dataDir = path.join(installDir, "Zomboid");
      fs.mkdirSync(dataDir, { recursive: true });
      getServers.mockResolvedValue([
        { id: 1, name: "Alpha", installPath: installDir, serverName: "ServerA" },
        { id: 2, name: "Bravo", installPath: installDir, serverName: "ServerB", zomboidDataPath: dataDir },
      ]);

      const response = createResponse();
      await getDeleteFilesHandler()(buildRequest({ confirm: true, confirmShared: true }), response);

      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "DELETE_FILES_DATA_PATH_NESTED" }),
      );
      expect(fs.existsSync(installDir)).toBe(true);
    });

    it("does not count a remote (SFTP) profile whose path happens to be the same", async () => {
      getServers.mockResolvedValue([
        { id: 1, name: "Alpha", installPath: installDir, serverName: "ServerA" },
        { id: 2, name: "Remote", installPath: installDir, serverName: "ServerB", isRemote: true },
      ]);

      const response = createResponse();
      await getDeleteFilesHandler()(buildRequest({ confirm: true }), response);

      expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      expect(fs.existsSync(installDir)).toBe(false);
    });
  });

  // steamcmd-routes-running-check card, second finding: this route did a
  // recursive rmSync directly on installPath with no check for an
  // in-progress SteamCMD operation at all -- unconditional, unlike /wipe's
  // version of the same gap (only reachable if zomboidDataPath nests inside
  // installPath). activeSteamOperations is the real, unmocked module here
  // (module-level Map) -- these tests populate/clear it directly rather
  // than mocking hasActiveSteamOperation(), so the real liveness/claim
  // semantics are what's under test, not a description of them.
  describe("refuses while a SteamCMD operation is active for this exact install path", () => {
    afterEach(() => {
      getActiveSteamOperations().clear();
    });

    it("refuses with 409 when POST /install or /steam-update has already claimed this path, and does not delete anything", async () => {
      const normalizedPath = path.normalize(installDir).toLowerCase();
      // No `pid` yet -- the real early-claim window, set before the child's
      // pid is known (see activeSteamOperations.js's own comment on
      // recordActiveSteamOperationPid). hasActiveSteamOperation() must
      // treat this as active without needing a liveness probe.
      getActiveSteamOperations().set(normalizedPath, {
        type: "install",
        startTime: Date.now(),
      });

      const handler = getDeleteFilesHandler();
      const response = createResponse();
      await handler(buildRequest({ confirm: true }), response);

      expect(response.status).toHaveBeenCalledWith(409);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "STEAM_OPERATION_IN_PROGRESS_PATH" }),
      );
      expect(fs.existsSync(installDir)).toBe(true);
    });

    it("refuses with 409 once a real pid is recorded and still alive, not just during the pid-less claim window", async () => {
      const normalizedPath = path.normalize(installDir).toLowerCase();
      // This test process's own pid -- guaranteed alive, so
      // hasActiveSteamOperation()'s process.kill(pid, 0) liveness probe
      // reports it as genuinely still running rather than self-healing it
      // away as stale.
      getActiveSteamOperations().set(normalizedPath, {
        type: "steam-update",
        startTime: Date.now(),
        pid: process.pid,
      });

      const handler = getDeleteFilesHandler();
      const response = createResponse();
      await handler(buildRequest({ confirm: true }), response);

      expect(response.status).toHaveBeenCalledWith(409);
      expect(fs.existsSync(installDir)).toBe(true);
    });

    it("does not refuse once the operation has cleared -- proceeds normally", async () => {
      const normalizedPath = path.normalize(installDir).toLowerCase();
      getActiveSteamOperations().set(normalizedPath, {
        type: "install",
        startTime: Date.now(),
      });
      getActiveSteamOperations().delete(normalizedPath);

      const handler = getDeleteFilesHandler();
      const response = createResponse();
      await handler(buildRequest({ confirm: true }), response);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
      expect(fs.existsSync(installDir)).toBe(false);
    });

    it("an active operation for a DIFFERENT path does not block deleting this one", async () => {
      getActiveSteamOperations().set("z:\\some\\other\\unrelated\\path", {
        type: "install",
        startTime: Date.now(),
      });

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

// CodeQL js/path-injection 307: the existence and PZ-marker checks ran on
// any absolute path before the configured-server match, so their different
// answers (404, NOT_PZ_INSTALL, NOT_CONFIGURED_SERVER) told a server.wipe
// role whether any folder or file on the host existed. The match now comes
// first, and nothing touches the disk for a path that isn't a server's.
describe("POST /api/server/delete-files does not probe paths that aren't a server's", () => {
  let probeRoot;

  beforeEach(() => {
    probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pz-delete-probe-"));
    scanHostForServerProcesses.mockReset().mockResolvedValue({ scanFailed: false, matched: [] });
    getServers.mockReset().mockResolvedValue([{ id: 1, installPath: path.join(probeRoot, "configured") }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(probeRoot, { recursive: true, force: true });
  });

  async function answerFor(target) {
    const response = createResponse();
    await getDeleteFilesHandler()({ body: { path: target, confirm: true } }, response);
    return {
      status: response.status.mock.calls[0]?.[0],
      code: response.json.mock.calls[0]?.[0]?.code,
    };
  }

  it("answers a missing path, a plain folder and a folder with a PZ marker the same way", async () => {
    const plain = path.join(probeRoot, "plain");
    fs.mkdirSync(plain);
    const marked = path.join(probeRoot, "marked");
    fs.mkdirSync(marked);
    fs.writeFileSync(path.join(marked, "ProjectZomboid64.json"), "{}");

    const answers = [
      await answerFor(path.join(probeRoot, "missing")),
      await answerFor(plain),
      await answerFor(marked),
    ];
    for (const answer of answers) {
      expect(answer).toEqual({ status: 400, code: "DELETE_FILES_NOT_CONFIGURED_SERVER" });
    }
    expect(fs.existsSync(marked)).toBe(true);
  });

  it("never touches the disk for a path no server is configured at", async () => {
    const target = path.join(probeRoot, "elsewhere");
    const touched = [];
    for (const name of ["existsSync", "statSync", "lstatSync", "readdirSync", "accessSync"]) {
      const real = fs[name];
      vi.spyOn(fs, name).mockImplementation((p, ...rest) => {
        if (typeof p === "string" && p.startsWith(target)) touched.push(`${name} ${p}`);
        return real.call(fs, p, ...rest);
      });
    }
    const answer = await answerFor(target);
    expect(answer.code).toBe("DELETE_FILES_NOT_CONFIGURED_SERVER");
    expect(touched).toEqual([]);
  });

  it("still reaches the existence check for the configured server's own folder, spelled with a trailing separator", async () => {
    const answer = await answerFor(path.join(probeRoot, "configured") + path.sep);
    expect(answer).toEqual({ status: 404, code: "PATH_NOT_FOUND" });
  });
});
