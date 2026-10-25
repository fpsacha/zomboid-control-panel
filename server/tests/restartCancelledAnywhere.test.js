import { afterEach, describe, expect, it, vi } from "vitest";

// Stop and Force stop were refused with "A 'restart' operation for ... is
// already in progress" for as long as a restart ran -- a countdown of up to an
// hour, then the stop, the start and the wait for RCON -- because the restart
// holds the one lifecycle lock and cancelRestart() only acted during the
// countdown (and only at the next per-minute tick). A restart now ends at
// once when it is cancelled, at any of its steps, and takes no step after it.

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

const runManagedLifecycle = vi.fn();
vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: (...args) => runManagedLifecycle(...args),
}));

const { Scheduler } = await import("../services/scheduler.js");
const { isLifecycleLocked } = await import("../services/lifecycleCoordinator.js");

function makeRconService(overrides = {}) {
  return {
    connected: true,
    execute: vi.fn().mockResolvedValue({ success: true }),
    save: vi.fn().mockResolvedValue({ success: true }),
    serverMessage: vi.fn().mockResolvedValue({ success: true }),
    quit: vi.fn().mockResolvedValue({ success: true }),
    connect: vi.fn().mockResolvedValue(),
    ...overrides,
  };
}

function makeServerManager() {
  return {
    _serverId: 1,
    stopIntent: null,
    getServerProcessDetails: vi
      .fn()
      .mockResolvedValueOnce({ running: true, scanFailed: false })
      .mockResolvedValue({ running: false, scanFailed: false }),
    startServer: vi.fn().mockResolvedValue({ success: true }),
    stopServer: vi.fn().mockResolvedValue({ success: true, confirmed: true }),
  };
}

afterEach(() => {
  getServer.mockReset();
  getActiveServer.mockReset();
  runManagedLifecycle.mockReset();
  vi.useRealTimers();
});

function setUp() {
  getServer.mockResolvedValue(null);
  getActiveServer.mockResolvedValue(null);
  runManagedLifecycle.mockResolvedValue({ handled: false });
}

describe("performRestart() ends the moment it is cancelled", () => {
  it("a cancel during a long countdown returns at once, not at the next tick, and frees the lock", async () => {
    setUp();
    const scheduler = new Scheduler({}, {});
    const rconService = makeRconService();
    const serverManager = makeServerManager();

    const restart = scheduler.performRestart(30, { rconService, serverManager });
    await vi.waitFor(() => expect(rconService.serverMessage).toHaveBeenCalled());
    expect(isLifecycleLocked()).toBe(true);

    const startedAt = Date.now();
    scheduler.cancelRestart();
    const result = await restart;

    expect(Date.now() - startedAt).toBeLessThan(2000); // not the 60 s between warnings
    expect(result).toMatchObject({ success: false, message: "Restart cancelled" });
    expect(rconService.save).not.toHaveBeenCalled();
    expect(rconService.quit).not.toHaveBeenCalled();
    expect(serverManager.startServer).not.toHaveBeenCalled();
    expect(scheduler.restartInProgress).toBe(false);
    expect(isLifecycleLocked()).toBe(false);
  });

  it("a cancel after the countdown stops it before the save, so nothing is saved, quit or started", async () => {
    setUp();
    const scheduler = new Scheduler({}, {});
    const rconService = makeRconService();
    const serverManager = makeServerManager();
    // The immediate restart's only wait is the pause after "restarting now".
    scheduler.sleep = async () => {
      scheduler.cancelRestart();
    };

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result).toMatchObject({ success: false, message: "Restart cancelled" });
    expect(rconService.save).not.toHaveBeenCalled();
    expect(rconService.quit).not.toHaveBeenCalled();
    expect(serverManager.startServer).not.toHaveBeenCalled();
    expect(serverManager.stopIntent).toBeNull();
    expect(isLifecycleLocked()).toBe(false);
  });

  it("a cancel while the new server starts leaves it alone and does not wait for RCON", async () => {
    setUp();
    const scheduler = new Scheduler({}, {});
    const rconService = makeRconService({ connected: false, serverStarting: false });
    const serverManager = makeServerManager();
    // Cancel once the start has been issued, i.e. during the waits that follow.
    let connectCallsAtCancel = null;
    scheduler.sleep = async () => {
      if (serverManager.startServer.mock.calls.length > 0 && connectCallsAtCancel === null) {
        connectCallsAtCancel = rconService.connect.mock.calls.length;
        scheduler.cancelRestart();
      }
    };

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(serverManager.startServer).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: false, message: "Restart cancelled" });
    expect(connectCallsAtCancel).not.toBeNull();
    expect(rconService.connect).toHaveBeenCalledTimes(connectCallsAtCancel); // no RCON attempt after the cancel
    expect(rconService.serverStarting).toBe(false);
    expect(isLifecycleLocked()).toBe(false);
  });
});

// The restart's stopIntent ("restart") outlived a restart that never stopped
// the server, so the watchdog took the next stop -- a crash days later -- for
// that restart, and restart-on-crash (serverWatch.onActiveServerStopped)
// left the server down.
describe("a restart that never stopped the server leaves no restart pending", () => {
  it("a countdown cancelled by an operator", async () => {
    setUp();
    const scheduler = new Scheduler({}, {});
    const rconService = makeRconService();
    const serverManager = makeServerManager();

    const restart = scheduler.performRestart(30, { rconService, serverManager });
    await vi.waitFor(() => expect(rconService.serverMessage).toHaveBeenCalled());
    expect(serverManager.stopIntent).toBe("restart");
    scheduler.cancelRestart();
    await restart;

    expect(rconService.quit).not.toHaveBeenCalled();
    expect(serverManager.stopIntent).toBeNull();
  });

  it("a save that failed, so the server was left running", async () => {
    setUp();
    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {};
    const rconService = makeRconService({
      save: vi.fn().mockResolvedValue({ success: false, error: "timed out" }),
    });
    const serverManager = makeServerManager();

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result).toMatchObject({ success: false, code: "SERVER_RESTART_SAVE_FAILED" });
    expect(rconService.quit).not.toHaveBeenCalled();
    expect(serverManager.stopIntent).toBeNull();
  });

  it("keeps it once the quit was sent, for the watchdog to see the stop", async () => {
    setUp();
    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {};
    const rconService = makeRconService();
    const serverManager = makeServerManager();
    // Still running after the quit and the forced stop does not confirm.
    serverManager.getServerProcessDetails = vi
      .fn()
      .mockResolvedValue({ running: true, scanFailed: false });
    serverManager.stopServer = vi
      .fn()
      .mockResolvedValue({ success: false, error: "still running" });

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result.success).toBe(false);
    expect(rconService.quit).toHaveBeenCalled();
    expect(serverManager.stopIntent).toBe("restart");
  });
});

describe("sleep() keeps waiting while a restart is being cancelled", () => {
  it("other loops that wait out a restart are not turned into a busy loop", async () => {
    vi.useFakeTimers();
    const scheduler = new Scheduler({}, {});
    scheduler.restartInProgress = true;
    scheduler.restartCancelled = true;

    let done = false;
    const waiting = scheduler.sleep(1000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    await waiting;
    expect(done).toBe(true);
  });
});
