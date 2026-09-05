import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 2026-09-05, host-suspend-resume audit: node-cron 4.6.0 already detects a
// missed tick (Runner.planBeat/beat in node_modules/node-cron/dist/
// _shared.js) -- exactly what a host suspend/resume, or any sustained
// blocking I/O/CPU stall, produces (one or more scheduled slots pass while
// nothing was running to notice). Its own default reaction is a bare
// `console.warn` through node-cron's OWN internal logger -- verified by
// reading _shared.js's defaultLogger, which is never routed through this
// app's winston logger. On a packaged, console-less install (a Windows
// service, a process manager with no attached terminal) that message is
// very likely never seen by anyone: a missed scheduled restart or backup
// was, before this fix, indistinguishable from total silence.
//
// Attaching an 'execution:missed' listener on the returned task object
// SUPPRESSES node-cron's own default warning (InlineScheduledTask checks
// `emitter.listenerCount('execution:missed') > 0` before logging its own)
// and hands the responsibility entirely to onScheduleMissed() -- these
// tests prove that handler logs specifically AND records a Schedule
// History entry an operator can actually see in the Scheduler UI, for all
// three schedule kinds this file manages (user tasks, auto-restart, the
// backup job).
//
// TESTING NOTE, stated rather than glossed over: this does NOT attempt to
// reproduce a genuine missed execution by fast-forwarding fake timers
// through node-cron's own internal heartbeat. Tried it, and it doesn't
// work for a fundamental reason, not a fake-timer skill issue: vi.
// advanceTimersByTimeAsync() simulates "the event loop kept running,
// just very fast" -- every intermediate self-rearmed heartbeat still gets
// its turn to fire in order, so node-cron correctly sees nothing as
// missed (confirmed: advancing 65 virtual minutes past a once-a-minute
// job produced 65 real callback runs and zero missed events). That is the
// opposite of what a real OS suspend does (the process does not run AT
// ALL for the gap), and there is no supported way to make a *repeating*,
// self-rearming fake timer skip its own intermediate rearms to simulate
// that. So instead: node-cron's own detection is trusted on the strength
// of reading its actual algorithm and its own documented behavior (both
// cited above), and these tests exercise exactly the part that IS fully
// under this codebase's control and fully fake-timer-free to verify --
// what OUR code does once node-cron emits 'execution:missed', for
// whichever of its real, documented causes actually triggers it (a
// suspend, but just as validly sustained CPU/IO load in production).

const logError = vi.fn();
const logWarn = vi.fn();
const logInfo = vi.fn();
const logDebug = vi.fn();

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    info: (...args) => logInfo(...args),
    warn: (...args) => logWarn(...args),
    error: (...args) => logError(...args),
    debug: (...args) => logDebug(...args),
  }),
}));

const logScheduleExecution = vi.fn(async () => {});

vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn(async () => []),
  updateTaskLastRun: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  logScheduleExecution: (...args) => logScheduleExecution(...args),
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(async () => null),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

const { Scheduler } = await import("../services/scheduler.js");

function makeScheduler() {
  const scheduler = new Scheduler({}, {});
  scheduler.effectiveTimezone = "UTC";
  return scheduler;
}

beforeEach(() => {
  logError.mockClear();
  logWarn.mockClear();
  logInfo.mockClear();
  logDebug.mockClear();
  logScheduleExecution.mockClear();
});

describe("Scheduler.scheduleTask() -- 'execution:missed' visibility for a user task", () => {
  let scheduler;

  afterEach(() => {
    for (const job of scheduler?.jobs?.values() || []) job.stop();
  });

  it("logs a specific warning and records Schedule History when node-cron reports a missed run", () => {
    scheduler = makeScheduler();
    const result = scheduler.scheduleTask({
      id: 42,
      name: "Nightly save",
      cron_expression: "0 3 * * *",
      command: "save",
    });
    expect(result.scheduled).toBe(true);
    const job = scheduler.jobs.get(42);

    // Simulate exactly what node-cron's Runner emits on a real miss --
    // the same shape createContext() produces (see _shared.js).
    job.emit("execution:missed", {
      date: new Date("2026-09-05T03:00:00.000Z"),
      dateLocalIso: "2026-09-05T03:00:00.000Z",
      triggeredAt: new Date("2026-09-05T04:05:00.000Z"),
      task: job,
    });

    expect(logWarn).toHaveBeenCalledWith(
      expect.stringMatching(/"Nightly save".*\(save\).*missed its run at 2026-09-05T03:00:00\.000Z/),
    );
    expect(logScheduleExecution).toHaveBeenCalledWith(
      42,
      "Nightly save",
      "save",
      false,
      expect.stringMatching(/Missed scheduled run at 2026-09-05T03:00:00\.000Z/),
      0,
    );
  });

  it("does not fire the missed-execution handler for a normal scheduling call with no miss", () => {
    scheduler = makeScheduler();
    scheduler.scheduleTask({
      id: 43,
      name: "Untouched",
      cron_expression: "0 4 * * *",
      command: "save",
    });
    expect(logWarn).not.toHaveBeenCalled();
    expect(logScheduleExecution).not.toHaveBeenCalled();
  });
});

describe("Scheduler.setupBackupSchedule() -- 'execution:missed' visibility for the backup job", () => {
  let scheduler;

  afterEach(() => {
    if (scheduler?.backupJob) scheduler.backupJob.stop();
  });

  it("logs and records history with taskId=null, matching the convention its own real-run logging already uses", async () => {
    scheduler = makeScheduler();
    scheduler.backupService = {
      getSettings: vi.fn(async () => ({
        enabled: true,
        schedule: "0 2 * * *",
        includeDb: true,
      })),
    };

    await scheduler.setupBackupSchedule();
    expect(scheduler.backupJob).toBeTruthy();

    scheduler.backupJob.emit("execution:missed", {
      date: new Date("2026-09-05T02:00:00.000Z"),
      dateLocalIso: "2026-09-05T02:00:00.000Z",
      triggeredAt: new Date("2026-09-05T03:10:00.000Z"),
      task: scheduler.backupJob,
    });

    expect(logWarn).toHaveBeenCalledWith(
      expect.stringMatching(/"Scheduled Backup".*\(backup\).*missed its run at 2026-09-05T02:00:00\.000Z/),
    );
    expect(logScheduleExecution).toHaveBeenCalledWith(
      null,
      "Scheduled Backup",
      "backup",
      false,
      expect.stringMatching(/Missed scheduled run/),
      0,
    );
  });
});

describe("Scheduler.setupAutoRestart() -- 'execution:missed' visibility for the auto-restart job", () => {
  let scheduler;
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.AUTO_RESTART_ENABLED = "true";
    process.env.AUTO_RESTART_CRON = "0 5 * * *";
  });

  afterEach(() => {
    if (scheduler?.autoRestartJob) scheduler.autoRestartJob.stop();
    process.env = originalEnv;
  });

  it("logs and records history with taskId=null, labeled 'Auto Restart'", () => {
    scheduler = makeScheduler();
    scheduler.setupAutoRestart();
    expect(scheduler.autoRestartJob).toBeTruthy();

    scheduler.autoRestartJob.emit("execution:missed", {
      date: new Date("2026-09-05T05:00:00.000Z"),
      dateLocalIso: "2026-09-05T05:00:00.000Z",
      triggeredAt: new Date("2026-09-05T06:15:00.000Z"),
      task: scheduler.autoRestartJob,
    });

    expect(logWarn).toHaveBeenCalledWith(
      expect.stringMatching(/"Auto Restart".*\(restart\).*missed its run at 2026-09-05T05:00:00\.000Z/),
    );
    expect(logScheduleExecution).toHaveBeenCalledWith(
      null,
      "Auto Restart",
      "restart",
      false,
      expect.stringMatching(/Missed scheduled run/),
      0,
    );
  });
});
