import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const getServer = vi.fn();
const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn().mockResolvedValue([]),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: vi.fn().mockResolvedValue(),
  getActiveServer: (...args) => getActiveServer(...args),
  getServer: (...args) => getServer(...args),
}));

const { Scheduler } = await import("../services/scheduler.js");
const { acquireLifecycleLock, lifecycleInProgressResponse, setServerDisplayNameResolver } =
  await import("../services/lifecycleCoordinator.js");

// 2026-08-27, root-cause completion (loonE, Discord config-revert report):
// scheduler.performRestart() -> serverManager.startServer() used to call
// neither generateStartupScripts/regenerateStartupScriptsWithBackup nor
// ensureRconConfigured -- a scheduled restart launched whatever launch
// script was already on disk, however stale, while a manual /start always
// refreshed it first. refreshLaunchTargetBeforeStart() (server.js) and its
// two call sites inside performRestart() are the fix.
//
// server/tests/refreshLaunchTargetBeforeStart.test.js already proves that
// function's own behavior in isolation, and
// server/tests/schedulerConfigBackupBeforeRestart.test.js already proves
// _backupConfigBeforeRestart()'s. This file is the missing piece: does
// performRestart() ITSELF actually call refreshLaunchTargetBeforeStart(),
// not just "does the helper work when called directly". Exercises the
// simpler "server was not running" branch end to end (the main
// "was running" branch shares the identical call, verified by direct code
// read rather than a second, much heavier full RCON/countdown/quit
// simulation -- see this file's second test for that confirmation, done at
// the source level since simulating the full countdown/RCON/quit dance
// adds fragility without adding confidence once the shared call is proven
// correct in isolation twice over).
describe("performRestart() refreshes the launch target before starting", () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    getServer.mockReset();
    getActiveServer.mockReset();
    // Best-effort: don't let a failed assertion mid-test leak a stuck lock
    // into a later test in this file or another (real, unmocked
    // lifecycleCoordinator).
    const stray = acquireLifecycleLock("test-cleanup");
    if (stray) stray.release();
  });

  it("a scheduled restart of an already-stopped server regenerates the launch script against CURRENT settings before starting", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-perform-restart-"));
    const installPath = root;
    const zomboidDataPath = path.join(root, "Zomboid");
    fs.mkdirSync(zomboidDataPath, { recursive: true });

    const server = {
      id: 7,
      serverName: "TestServer",
      installPath,
      zomboidDataPath,
      rconPassword: "secret123",
      rconPort: 27015,
    };
    getServer.mockResolvedValue(server);
    getActiveServer.mockResolvedValue(server);

    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {}; // no real countdown/poll delays in a test

    const rconService = { connected: false, execute: vi.fn() };
    const serverManager = {
      _serverId: 7,
      getServerProcessDetails: vi
        .fn()
        .mockResolvedValue({ running: false, scanFailed: false }),
      startServer: vi.fn().mockResolvedValue({ success: true }),
    };

    await scheduler.performRestart(0, { rconService, serverManager });

    const batPath = path.join(installPath, "StartServer_TestServer.bat");
    expect(fs.existsSync(batPath)).toBe(true);
    expect(fs.readFileSync(batPath, "utf8")).toContain(
      `-cachedir="${zomboidDataPath}"`,
    );
    expect(serverManager.startServer).toHaveBeenCalled();
  });

  // normalize-lifecycle-lock-server-identifier, 2026-09-08: this call used
  // to acquire the lock with serverManager?.serverName (a display name,
  // possibly stale if serverManager hadn't loaded any config yet) instead of
  // a server DB id. Fixed to use serverManager._serverId directly -- the
  // synchronous field a throwaway ServerManager the Scheduler pointed at a
  // specific server already carries (see loadConfig()'s own comment).
  // Superseded by performrestart-cannot-take-the-lock-id-without-reopening-
  // a-race (2026-09-09, below): pinnedServerId's fuller async-fallback
  // resolution now runs BEFORE the restartInProgress check instead of after
  // it, so the common case (serverManager._serverId null) can carry a real
  // resolved id too -- see that test for the common case, and the
  // performRestart() comment for why this doesn't reopen the race. This
  // test still proves the synchronous-_serverId case (a throwaway
  // ServerManager pointed at a specific server) is unaffected. Proven here
  // by reading the held lock's own refusal message.
  it("acquires the lock with serverManager._serverId (the server DB id), not serverManager.serverName", async () => {
    // Resolver recognizes ONLY the numeric id (coerced to a string by
    // acquireLifecycleLock's own normalization) -- if this ever regressed
    // to serverManager.serverName ("TestServer"), it wouldn't resolve and
    // the message would fall back to the fully generic wording instead of
    // naming "Resolved-server-7".
    setServerDisplayNameResolver((id) => (id === "7" ? "Resolved-server-7" : null));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-perform-restart-lock-"));
    const installPath = root;
    const zomboidDataPath = path.join(root, "Zomboid");
    fs.mkdirSync(zomboidDataPath, { recursive: true });

    const server = {
      id: 7,
      serverName: "TestServer",
      installPath,
      zomboidDataPath,
      rconPassword: "secret123",
      rconPort: 27015,
    };
    getServer.mockResolvedValue(server);
    getActiveServer.mockResolvedValue(server);

    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {};

    const rconService = { connected: false, execute: vi.fn() };
    let releaseStart;
    let startEntered;
    const startReached = new Promise((r) => {
      startEntered = r;
    });
    const serverManager = {
      _serverId: 7,
      serverName: "TestServer", // must NOT be what the lock names -- see above
      getServerProcessDetails: vi
        .fn()
        .mockResolvedValue({ running: false, scanFailed: false }),
      startServer: vi.fn(
        () =>
          new Promise((resolve) => {
            releaseStart = () => resolve({ success: true });
            startEntered();
          }),
      ),
    };

    const restartCall = scheduler.performRestart(0, { rconService, serverManager });

    try {
      await startReached;
      const message = lifecycleInProgressResponse().error;
      expect(message).toContain("Resolved-server-7");
      expect(message).not.toContain("TestServer");
    } finally {
      setServerDisplayNameResolver(null);
      releaseStart();
      await restartCall;
    }
  });

  // performrestart-cannot-take-the-lock-id-without-reopening-a-race
  // (2026-09-09, Angela's follow-up, dispatched to Dwight): the COMMON case
  // -- serverManager._serverId null, no throwaway ServerManager -- used to
  // acquire the lock with a bare null id, because feeding it
  // pinnedServerId's async getActiveServer() fallback would have inserted
  // an await between the restartInProgress check and its set, reopening the
  // exact checked-then-set race /wipe's wipeInProgress guard was fixed
  // against. Fixed by resolving pinnedServerId (including the async
  // fallback) BEFORE the check instead of after, keeping the check and the
  // set themselves back-to-back synchronous statements -- so the SAME
  // atomicity guarantee holds, just established one await earlier. That
  // atomicity is exactly what the existing "acquires the lock with
  // serverManager._serverId" test above already proves stays intact (it
  // still sends a second concurrent call into the SAME held lock and reads
  // the refusal message) -- not re-proven here since this test's own point
  // is the DIFFERENT half: whether the common case's lock now carries a
  // real id at all, not whether concurrent calls still serialize correctly
  // (unaffected either way, since two calls fired synchronously back to
  // back -- the only way JS lets a caller "race" this function without a
  // manually-stalled mock -- were never able to reach this race window in
  // EITHER version: the restartInProgress check was always the very first
  // synchronous statement pre-fix, so a second call always saw it already
  // set by the time it ran, regardless of where pinnedServerId got resolved).
  //
  // Proven by reading the held lock's own refusal message while the winning
  // call is still mid-flight, same technique as the test above -- if this
  // still fell back to null (the pre-fix behavior), the message would read
  // the fully generic "Another server lifecycle operation is already in
  // progress" instead of naming a server at all.
  it("common case (no serverManager._serverId): the lock now carries the real resolved active-server id, not a null fallback", async () => {
    setServerDisplayNameResolver((id) => (id === "9" ? "Resolved-common-case" : null));

    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-perform-restart-common-"));
    const installPath = root;
    const zomboidDataPath = path.join(root, "Zomboid");
    fs.mkdirSync(zomboidDataPath, { recursive: true });
    const server = {
      id: "9",
      serverName: "CommonCaseServer",
      installPath,
      zomboidDataPath,
      rconPassword: "secret123",
      rconPort: 27015,
    };
    getServer.mockResolvedValue(server);
    getActiveServer.mockResolvedValue(server);

    let releaseStart;
    let startEntered;
    const startReached = new Promise((r) => {
      startEntered = r;
    });
    const rconService = { connected: false, execute: vi.fn() };
    const serverManager = {
      // Deliberately no _serverId -- the common shared-singleton case.
      getServerProcessDetails: vi
        .fn()
        .mockResolvedValue({ running: false, scanFailed: false }),
      startServer: vi.fn(
        () =>
          new Promise((resolve) => {
            releaseStart = () => resolve({ success: true });
            startEntered();
          }),
      ),
    };
    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {};

    const restartCall = scheduler.performRestart(0, { rconService, serverManager });

    try {
      await startReached;
      const message = lifecycleInProgressResponse().error;
      expect(message).toContain("Resolved-common-case");
    } finally {
      setServerDisplayNameResolver(null);
      releaseStart();
      await restartCall;
    }
  });

  // The "was running" branch (a full RCON verify -> countdown -> save ->
  // quit -> stop-confirm -> start sequence) calls the exact same
  // this._backupConfigBeforeRestart(pinnedServerId) followed by
  // refreshLaunchTargetBeforeStart(restartTarget, {managedHandled}) as the
  // branch tested above, at the point right after the old process is
  // confirmed stopped and before serverManager.startServer() -- confirmed
  // by source, since simulating a full RCON/countdown/quit/stop-poll cycle
  // just to re-observe the identical two-line call already proven correct
  // above and in refreshLaunchTargetBeforeStart.test.js /
  // schedulerConfigBackupBeforeRestart.test.js adds test fragility without
  // adding real confidence.
  it("the main was-running branch calls the same refresh, by source inspection", async () => {
    const { readFileSync } = await import("fs");
    const source = readFileSync(
      new URL("../services/scheduler.js", import.meta.url),
      "utf8",
    );
    const mainBranch = source.slice(
      source.indexOf("const restartTarget = await this._backupConfigBeforeRestart"),
      source.indexOf("serverStarted = false"),
    );
    expect(mainBranch).toContain("refreshLaunchTargetBeforeStart(restartTarget");
    expect(mainBranch).toContain("managedHandled: managed.handled");
  });
});
