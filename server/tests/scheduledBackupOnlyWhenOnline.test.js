import { beforeEach, describe, expect, it, vi } from "vitest";

// "Only back up while the server is running" (backupOnlyWhenOnline): the
// scheduled backup skips a server seen stopped, without a Schedule History
// row, and still backs up one whose state can't be told. The active server
// gets the panel's usual verdict (resolveObservedServerRunning), another one
// only its own host signal.

const logScheduleExecution = vi.fn().mockResolvedValue();
const getActiveServer = vi.fn();
const resolveObservedServerRunning = vi.fn();
const resolveDockerHostSignal = vi.fn();
const getServerProcessDetails = vi.fn();

vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn().mockResolvedValue([]),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: (...args) => logScheduleExecution(...args),
  getActiveServer: (...args) => getActiveServer(...args),
  getServer: vi.fn(),
  getServers: vi.fn().mockResolvedValue([]),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("../utils/serverStatus.js", () => ({
  resolveObservedServerRunning: (...args) => resolveObservedServerRunning(...args),
  resolveServerPhase: vi.fn(),
}));

vi.mock("../services/managedContainer.js", () => ({
  resolveDockerHostSignal: (...args) => resolveDockerHostSignal(...args),
  runManagedLifecycle: vi.fn(),
}));

vi.mock("../services/serverManager.js", () => ({
  ServerManager: class {
    async loadConfig() {}
    getServerProcessDetails() {
      return getServerProcessDetails();
    }
  },
}));

const { Scheduler } = await import("../services/scheduler.js");

function makeScheduler() {
  const scheduler = new Scheduler({}, {});
  const createBackup = vi.fn().mockResolvedValue({ success: true, backup: { name: "b.zip" } });
  scheduler.backupService = { createBackup };
  return { scheduler, createBackup };
}

beforeEach(() => {
  vi.clearAllMocks();
  getActiveServer.mockResolvedValue({ id: 1 });
});

describe("scheduled backup: only when the server is online", () => {
  it("skips the active server when it is stopped, with no Schedule History row", async () => {
    resolveObservedServerRunning.mockResolvedValue(false);
    const { scheduler, createBackup } = makeScheduler();
    await scheduler._runScheduledBackupOf(null, { onlyWhenOnline: true }, "");
    expect(createBackup).not.toHaveBeenCalled();
    expect(logScheduleExecution).not.toHaveBeenCalled();
  });

  it("backs up the active server when it is running", async () => {
    resolveObservedServerRunning.mockResolvedValue(true);
    const { scheduler, createBackup } = makeScheduler();
    await scheduler._runScheduledBackupOf({ id: 1 }, { onlyWhenOnline: true }, "");
    expect(createBackup).toHaveBeenCalledTimes(1);
  });

  it("backs up when the state can't be told", async () => {
    resolveObservedServerRunning.mockResolvedValue(null);
    const { scheduler, createBackup } = makeScheduler();
    await scheduler._runScheduledBackupOf(null, { onlyWhenOnline: true }, "");
    expect(createBackup).toHaveBeenCalledTimes(1);
  });

  it("backs up a stopped server when the option is off, without checking", async () => {
    const { scheduler, createBackup } = makeScheduler();
    await scheduler._runScheduledBackupOf(null, { onlyWhenOnline: false }, "");
    expect(resolveObservedServerRunning).not.toHaveBeenCalled();
    expect(createBackup).toHaveBeenCalledTimes(1);
  });

  it("judges another native server by its own process scan", async () => {
    getServerProcessDetails.mockResolvedValue({ running: false, scanFailed: false });
    const { scheduler, createBackup } = makeScheduler();
    await scheduler._runScheduledBackupOf({ id: 2, name: "Other" }, { onlyWhenOnline: true }, "");
    expect(resolveObservedServerRunning).not.toHaveBeenCalled();
    expect(createBackup).not.toHaveBeenCalled();

    getServerProcessDetails.mockResolvedValue({ running: false, scanFailed: true });
    await scheduler._runScheduledBackupOf({ id: 2, name: "Other" }, { onlyWhenOnline: true }, "");
    expect(createBackup).toHaveBeenCalledTimes(1);
  });

  it("judges another Docker server by its container", async () => {
    resolveDockerHostSignal.mockResolvedValue({ running: true, scanFailed: false });
    const { scheduler, createBackup } = makeScheduler();
    await scheduler._runScheduledBackupOf(
      { id: 3, provider: "docker-managed" },
      { onlyWhenOnline: true },
      "",
    );
    expect(getServerProcessDetails).not.toHaveBeenCalled();
    expect(createBackup).toHaveBeenCalledTimes(1);
  });
});
