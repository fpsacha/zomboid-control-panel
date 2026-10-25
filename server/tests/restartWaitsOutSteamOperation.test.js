import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GH #269 (Windows, native launch): a mod-update restart saved and stopped
// the server, then startServer() refused the relaunch because a Steam
// install/update was registered on the install folder. The restart failed at
// once, and the next mod check took the stopped server for one left offline
// on purpose ("no restart needed"), so it stayed down until a manual Start.
// The guard stays; a restart that already stopped the server now waits the
// operation out (bounded, cancellable), re-checks nothing started meanwhile,
// and starts it -- and the mod checker retries a server a failed restart
// left stopped instead of skipping it.

vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn().mockResolvedValue([]),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: vi.fn().mockResolvedValue(),
  getActiveServer: vi.fn().mockResolvedValue({ id: 1, name: "One" }),
  getServer: vi.fn().mockResolvedValue(null),
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(),
  getTrackedMods: vi.fn().mockResolvedValue([]),
  updateModTimestamp: vi.fn().mockResolvedValue(),
  addTrackedMod: vi.fn().mockResolvedValue(),
  isModIgnored: vi.fn().mockResolvedValue(false),
  markModsChecked: vi.fn().mockResolvedValue(),
}));

const runManagedLifecycle = vi.fn();
vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: (...args) => runManagedLifecycle(...args),
}));

const {
  Scheduler,
  RESTART_STEAM_OPERATION_WAIT_MS,
} = await import("../services/scheduler.js");
const { ModChecker } = await import("../services/modChecker.js");
const {
  getActiveSteamOperations,
  clearActiveSteamOperation,
  getStartBlockingSteamOperation,
} = await import("../services/activeSteamOperations.js");
const { isLifecycleLocked, prepareForLaunch } = await import(
  "../services/lifecycleCoordinator.js"
);

const INSTALL = "c:\\pzserver";
const REFUSAL =
  "A Steam install or update is currently in progress for this server's install directory. Wait for it to finish before starting the server.";

// The server: running until the restart's quit, then stopped. startServer()
// refuses like the real one while a start-blocking operation is registered.
function makeServer() {
  const state = { running: true, scanFailed: false };
  const rconService = {
    connected: true,
    execute: vi.fn().mockResolvedValue({ success: true }),
    save: vi.fn().mockResolvedValue({ success: true }),
    serverMessage: vi.fn().mockResolvedValue({ success: true }),
    quit: vi.fn(async () => {
      state.running = false;
      return { success: true };
    }),
    connect: vi.fn().mockResolvedValue(),
  };
  const serverManager = {
    _serverId: 1,
    stopIntent: null,
    getServerProcessDetails: vi.fn(async () => ({
      running: state.running,
      scanFailed: state.scanFailed,
    })),
    startServer: vi.fn(async () => {
      const operation = getStartBlockingSteamOperation(INSTALL);
      if (operation) {
        throw Object.assign(new Error(REFUSAL), { steamOperation: operation });
      }
      state.running = true;
      return { success: true };
    }),
    stopServer: vi.fn().mockResolvedValue({ success: true, confirmed: true }),
  };
  return { state, rconService, serverManager };
}

function registerInstall() {
  getActiveSteamOperations().set(INSTALL, {
    type: "install",
    startTime: Date.now(),
    lastOutputAt: Date.now(),
  });
}

async function advanceUntil(predicate, stepMs = 1000, maxMs = 30 * 60 * 1000) {
  for (let spent = 0; spent < maxMs && !predicate(); spent += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  expect(predicate()).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
  runManagedLifecycle.mockResolvedValue({ handled: false });
});

afterEach(() => {
  clearActiveSteamOperation(INSTALL);
  runManagedLifecycle.mockReset();
  vi.useRealTimers();
});

describe("performRestart() waits out a Steam operation that holds the relaunch", () => {
  it("keeps the relaunch pending until the install finishes, then starts the server", async () => {
    const scheduler = new Scheduler({}, {});
    const { rconService, serverManager } = makeServer();
    registerInstall();
    let settled = false;
    const restart = scheduler
      .performRestart(0, { rconService, serverManager })
      .finally(() => {
        settled = true;
      });

    await advanceUntil(() => serverManager.startServer.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    // Still waiting: not failed, not started over the install.
    expect(settled).toBe(false);
    expect(serverManager.startServer).toHaveBeenCalledTimes(1);
    expect(isLifecycleLocked()).toBe(true);

    clearActiveSteamOperation(INSTALL);
    await advanceUntil(() => serverManager.startServer.mock.calls.length === 2);
    await advanceUntil(() => settled);
    const result = await restart;

    expect(result).toMatchObject({ success: true, wasRunning: true });
    expect(scheduler.getInterruptedRestart(1)).toBeNull();
    expect(isLifecycleLocked()).toBe(false);
  });

  it("fails clearly after the bounded wait and records the server as left stopped", async () => {
    const scheduler = new Scheduler({}, {});
    const { rconService, serverManager } = makeServer();
    registerInstall();
    let outcome = null;
    const restart = scheduler
      .performRestart(0, { rconService, serverManager })
      .then(
        (value) => (outcome = { value }),
        (error) => (outcome = { error }),
      );

    await advanceUntil(() => serverManager.startServer.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(RESTART_STEAM_OPERATION_WAIT_MS - 60 * 1000);
    expect(outcome).toBeNull();
    await advanceUntil(() => outcome !== null);
    await restart;

    expect(outcome.error?.message).toMatch(/still running after 15 minutes/);
    expect(serverManager.startServer).toHaveBeenCalledTimes(1);
    expect(scheduler.getInterruptedRestart(1)).toMatchObject({ serverId: "1" });
    expect(isLifecycleLocked()).toBe(false);
  });

  it("ends at once when the restart is cancelled while it waits", async () => {
    const scheduler = new Scheduler({}, {});
    const { rconService, serverManager } = makeServer();
    registerInstall();
    let settled = false;
    const restart = scheduler
      .performRestart(0, { rconService, serverManager })
      .finally(() => {
        settled = true;
      });

    await advanceUntil(() => serverManager.startServer.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    scheduler.cancelRestart();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    const result = await restart;

    expect(result).toMatchObject({ success: false, message: "Restart cancelled" });
    expect(serverManager.startServer).toHaveBeenCalledTimes(1);
    expect(scheduler.getInterruptedRestart(1)).toBeNull();
  });

  it("does not start a second server when one was started while it waited", async () => {
    const scheduler = new Scheduler({}, {});
    const { state, rconService, serverManager } = makeServer();
    registerInstall();
    let outcome = null;
    const restart = scheduler
      .performRestart(0, { rconService, serverManager })
      .then(
        (value) => (outcome = { value }),
        (error) => (outcome = { error }),
      );

    await advanceUntil(() => serverManager.startServer.mock.calls.length === 1);
    state.running = true; // started on the host meanwhile
    clearActiveSteamOperation(INSTALL);
    await advanceUntil(() => outcome !== null);
    await restart;

    expect(outcome.error?.message).toMatch(/did not start a second one/);
    expect(serverManager.startServer).toHaveBeenCalledTimes(1);
  });

  it("does not start when process detection can't answer after the wait", async () => {
    const scheduler = new Scheduler({}, {});
    const { state, rconService, serverManager } = makeServer();
    registerInstall();
    let outcome = null;
    const restart = scheduler
      .performRestart(0, { rconService, serverManager })
      .then(
        (value) => (outcome = { value }),
        (error) => (outcome = { error }),
      );

    await advanceUntil(() => serverManager.startServer.mock.calls.length === 1);
    state.scanFailed = true;
    clearActiveSteamOperation(INSTALL);
    await advanceUntil(() => outcome !== null);
    await restart;

    expect(outcome.error?.message).toMatch(/process detection failed/);
    expect(serverManager.startServer).toHaveBeenCalledTimes(1);
  });

  it("starts when the stopped evidence settles a scan that can't answer after the wait", async () => {
    const scheduler = new Scheduler({}, {});
    const { state, rconService, serverManager } = makeServer();
    serverManager.checkStoppedEvidence = vi.fn(async () => ({
      stopped: true,
      reason: "the RCON port refuses connections and the game's console log ends with \"Shutdown handling finished\"",
    }));
    registerInstall();
    let settled = false;
    const restart = scheduler
      .performRestart(0, { rconService, serverManager })
      .finally(() => {
        settled = true;
      });

    await advanceUntil(() => serverManager.startServer.mock.calls.length === 1);
    state.scanFailed = true;
    clearActiveSteamOperation(INSTALL);
    await advanceUntil(() => serverManager.startServer.mock.calls.length === 2);
    state.scanFailed = false;
    await advanceUntil(() => settled);

    expect(await restart).toMatchObject({ success: true, wasRunning: true });
    expect(serverManager.checkStoppedEvidence).toHaveBeenCalledWith({ serverId: 1 });
  });

  // rcon.js clears serverStarting by itself 5 minutes after it was set: a
  // relaunch held longer than that booted as "unresponsive", with
  // auto-reconnect racing the restart's own RCON wait.
  it("relaunches as 'starting' after a wait longer than serverStarting's 5-minute failsafe", async () => {
    const scheduler = new Scheduler({}, {});
    const { rconService, serverManager } = makeServer();
    let failsafe = null;
    rconService.serverStarting = false;
    rconService.setServerStarting = vi.fn((value) => {
      rconService.serverStarting = value;
      clearTimeout(failsafe);
      if (value) failsafe = setTimeout(() => (rconService.serverStarting = false), 5 * 60 * 1000);
    });
    registerInstall();
    let startingAtRelaunch = null;
    const start = serverManager.startServer.getMockImplementation();
    serverManager.startServer.mockImplementation(async (...args) => {
      startingAtRelaunch = rconService.serverStarting;
      return start(...args);
    });
    let settled = false;
    const restart = scheduler
      .performRestart(0, { rconService, serverManager })
      .finally(() => {
        settled = true;
      });

    await advanceUntil(() => serverManager.startServer.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
    clearActiveSteamOperation(INSTALL);
    await advanceUntil(() => serverManager.startServer.mock.calls.length === 2);

    expect(startingAtRelaunch).toBe(true);
    await advanceUntil(() => settled);
    await restart;
  });

  it("relaunches at once over a hung update-check version lookup, which writes nothing", async () => {
    const scheduler = new Scheduler({}, {});
    const { rconService, serverManager } = makeServer();
    getActiveSteamOperations().set(INSTALL, {
      type: "version-check",
      startTime: Date.now() - 30 * 60 * 1000,
      lastOutputAt: Date.now() - 30 * 60 * 1000,
    });
    let settled = false;
    const restart = scheduler
      .performRestart(0, { rconService, serverManager })
      .finally(() => {
        settled = true;
      });

    await advanceUntil(() => settled);
    const result = await restart;

    expect(result).toMatchObject({ success: true, wasRunning: true });
    expect(serverManager.startServer).toHaveBeenCalledTimes(1);
  });

  it("still fails at once on any other launch error", async () => {
    const scheduler = new Scheduler({}, {});
    const { rconService, serverManager } = makeServer();
    serverManager.startServer.mockRejectedValueOnce(new Error("RCON port 27015 is in use"));
    let outcome = null;
    const restart = scheduler
      .performRestart(0, { rconService, serverManager })
      .then(
        (value) => (outcome = { value }),
        (error) => (outcome = { error }),
      );

    await advanceUntil(() => outcome !== null);
    await restart;

    expect(outcome.error?.message).toBe("RCON port 27015 is in use");
    expect(serverManager.startServer).toHaveBeenCalledTimes(1);
    expect(scheduler.getInterruptedRestart(1)).toMatchObject({ serverId: "1" });
  });
});

// A scheduled backup that came due during such a restart waits for it, but
// gives up (and writes "the restart looked stuck ... restart the panel")
// once the restart outlasts its countdown plus a 20-minute budget sized
// before this wait existed. A restart that waited ~15 min for the install
// and then ~5 min for RCON passed it, and the advice would have meant
// restarting the panel under a restart that was about to finish.
describe("a scheduled backup held back by a restart that waits out a Steam operation", () => {
  it("is not written off as a stuck restart; it runs once the restart ends", async () => {
    const { logScheduleExecution } = await import("../database/init.js");
    logScheduleExecution.mockClear();
    const scheduler = new Scheduler({}, {});
    const createBackup = vi.fn().mockResolvedValue({ success: true, backup: { name: "One.zip" } });
    scheduler.setBackupService({
      getSettings: vi.fn(async () => ({ enabled: true, includeDb: false })),
      createBackup,
    });
    const { rconService, serverManager } = makeServer();
    // RCON never answers the new server: the restart's full RCON wait.
    const quit = rconService.quit;
    rconService.quit = vi.fn(async () => {
      rconService.connected = false;
      return quit();
    });
    rconService.connect = vi.fn(() => new Promise(() => {}));
    registerInstall();
    let settled = false;
    const restart = scheduler
      .performRestart(0, { rconService, serverManager })
      .finally(() => {
        settled = true;
      });
    const backup = scheduler._onScheduledBackupTick({ enabled: true, includeDb: false });

    await advanceUntil(() => serverManager.startServer.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(RESTART_STEAM_OPERATION_WAIT_MS - 30 * 1000);
    clearActiveSteamOperation(INSTALL);
    await advanceUntil(() => settled, 1000, 40 * 60 * 1000);
    await restart;
    await advanceUntil(() => createBackup.mock.calls.length === 1, 1000, 60 * 1000);
    await backup;

    const backupRows = logScheduleExecution.mock.calls.filter((call) => call[2] === "backup");
    expect(backupRows).toHaveLength(1);
    expect(backupRows[0][3]).toBe(true);
    expect(backupRows[0][4]).toMatch(/^Created: One\.zip -- held back until a server restart/);
  });
});

describe("the mod checker and a server a failed restart left stopped", () => {
  function makeChecker(scheduler) {
    const checker = new ModChecker();
    checker.restartWarningMinutes = 5;
    scheduler.rconService = { connected: false, serverMessage: vi.fn() };
    scheduler.performRestart = vi.fn().mockResolvedValue({ success: true, wasRunning: false });
    checker.scheduler = scheduler;
    checker.serverManager = {
      getServerProcessDetails: vi.fn().mockResolvedValue({ running: false, scanFailed: false }),
    };
    return checker;
  }
  const MODS = [{ workshopId: "2503622437", name: "Skill Recovery Journal" }];

  it("starts the server again instead of treating it as offline on purpose", async () => {
    const scheduler = new Scheduler({}, {});
    scheduler._noteInterruptedRestart(1, REFUSAL);
    const checker = makeChecker(scheduler);

    const result = await checker.triggerModRestart(MODS);

    expect(scheduler.performRestart).toHaveBeenCalledWith(0);
    expect(scheduler.rconService.serverMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, reason: "restart_complete" });
  });

  it("keeps the updates pending when that start fails too", async () => {
    const scheduler = new Scheduler({}, {});
    scheduler._noteInterruptedRestart(1, REFUSAL);
    const checker = makeChecker(scheduler);
    checker.processedUpdates.set("2503622437", Date.now());
    scheduler.performRestart.mockResolvedValue({ success: false, message: "Server was offline - failed to start" });

    const result = await checker.triggerModRestart(MODS);

    expect(result).toMatchObject({ success: false, retry: true });
    expect(checker.processedUpdates.has("2503622437")).toBe(false);
  });

  it("leaves a server alone once anything launched a server after the failure", async () => {
    const scheduler = new Scheduler({}, {});
    scheduler._noteInterruptedRestart(1, REFUSAL);
    await prepareForLaunch(null);
    const checker = makeChecker(scheduler);

    const result = await checker.triggerModRestart(MODS);

    expect(scheduler.performRestart).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true, reason: "server_offline" });
  });
});
