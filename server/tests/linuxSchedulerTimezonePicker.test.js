import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// TIMEZONE PICKER (2026-08-29, hunt-wave5 follow-up to card 9fe76d): the
// operator ruled "build the timezone picker" after the visibility-only fix
// (a2eb5ea8) shipped. THE HARD HALF, per the card, is migration: every
// existing schedule on every existing install was created under the
// implicit assumption of "whatever the process default is" -- the moment a
// timezone SETTING exists, an existing "30 2 * * *" needs an answer to "in
// which zone?", and getting that wrong silently moves someone's 3am backup
// to a different real time without telling them.
//
// This file proves, with REAL node-cron (not a mock of the scheduling
// math -- only the settings store is mocked), that:
//   1. MIGRATION: an install with no schedulerTimezone setting yet resolves
//      to -- and PERSISTS -- exactly the zone it was already implicitly
//      using, so a schedule's real-world fire time is provably IDENTICAL
//      before and after the setting starts existing. This is the specific
//      assertion the card names as the one a picker-focused test would
//      skip.
//   2. VALIDATION: an invalid IANA name is refused at save time, never
//      persisted, never silently accepted to throw at fire time.
//   3. FALLBACK: a stored zone that stops being valid (tzdata removed it,
//      or db.json was restored from a different machine) fails LOUDLY
//      (logged, surfaced on timezoneFallback) and keeps scheduling under
//      the process default -- never refuses to start, never silently
//      substitutes without saying so.
//   4. ALL THREE cron.schedule() call sites (user tasks, the backup job,
//      AUTO_RESTART_CRON) resolve to the SAME timezone -- a setting that
//      covered only some of them would leave the UI confidently wrong
//      about the others, per the card's explicit closing question.
//   5. Changing the timezone reschedules everything immediately, under the
//      new zone, not just future task creations.

const settingsStore = new Map();
const getSetting = vi.fn(async (key) => (settingsStore.has(key) ? settingsStore.get(key) : null));
const setSetting = vi.fn(async (key, value) => {
  settingsStore.set(key, value);
});

const logError = vi.fn();
const logWarn = vi.fn();
const logInfo = vi.fn();

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    info: (...args) => logInfo(...args),
    warn: (...args) => logWarn(...args),
    error: (...args) => logError(...args),
    debug: vi.fn(),
  }),
}));

vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn(async () => []),
  updateTaskLastRun: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  logScheduleExecution: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(async () => null),
  getSetting: (...args) => getSetting(...args),
  setSetting: (...args) => setSetting(...args),
}));

const { Scheduler } = await import("../services/scheduler.js");
const { getScheduledTasks } = await import("../database/init.js");

function makeScheduler() {
  return new Scheduler({}, {});
}

beforeEach(() => {
  settingsStore.clear();
  getSetting.mockClear();
  setSetting.mockClear();
  logError.mockClear();
  logWarn.mockClear();
  logInfo.mockClear();
});

describe("Scheduler timezone migration: an install with no prior setting keeps EXACTLY its old behavior", () => {
  it("resolves to, and PERSISTS, the process's own currently-effective zone -- not a hardcoded default", async () => {
    const scheduler = makeScheduler();
    const processDefault = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const resolved = await scheduler.resolveTimezone();

    expect(resolved).toBe(processDefault);
    expect(scheduler.effectiveTimezone).toBe(processDefault);
    expect(scheduler.configuredTimezone).toBe(processDefault);
    expect(scheduler.timezoneFallback).toBeNull();
    // Persisted, not just derived-and-forgotten -- a later change to the
    // process's OWN environment (a redeployed container with a different
    // host TZ) must never retroactively alter what an already-migrated
    // install resolves to.
    expect(setSetting).toHaveBeenCalledWith("schedulerTimezone", processDefault);
    expect(settingsStore.get("schedulerTimezone")).toBe(processDefault);
  });

  it("THE CARD'S OWN DEFINITION OF DONE: a schedule created before the setting existed fires at the IDENTICAL real-world instant after migration as it would have with no timezone option at all", async () => {
    // Simulate "before this feature existed": schedule directly with no
    // timezone option, exactly what every cron.schedule() call in this
    // file did prior to this card.
    const cron = (await import("node-cron")).default;
    const preMigrationTask = cron.schedule("30 2 * * *", () => {});
    preMigrationTask.stop();
    const preMigrationNext = preMigrationTask.timeMatcher.getNextMatch(new Date("2026-09-01T00:00:00Z"));

    // Now run the actual migration path (no prior setting) and schedule
    // the SAME expression through the real Scheduler.scheduleTask(), which
    // is what an upgraded install would do.
    const scheduler = makeScheduler();
    await scheduler.resolveTimezone();
    const scheduled = scheduler.scheduleTask({
      id: 1,
      name: "Legacy nightly task",
      cron_expression: "30 2 * * *",
      command: "save",
    });
    expect(scheduled).not.toBe(false);
    const job = scheduler.jobs.get(1);
    const postMigrationNext = job.timeMatcher.getNextMatch(new Date("2026-09-01T00:00:00Z"));
    job.stop();

    // The assertion the card explicitly says a picker-focused test would
    // skip: identical real-world fire instant, not just "a timezone got
    // set to something."
    expect(postMigrationNext.toISOString()).toBe(preMigrationNext.toISOString());
  });

  it("is idempotent -- a second resolveTimezone() call does not re-derive or re-persist, it reads back what migration already wrote", async () => {
    const scheduler = makeScheduler();
    await scheduler.resolveTimezone();
    setSetting.mockClear();

    const secondResolve = await scheduler.resolveTimezone();

    expect(setSetting).not.toHaveBeenCalled();
    expect(secondResolve).toBe(scheduler.effectiveTimezone);
  });
});

describe("Scheduler timezone validation: an invalid IANA name is refused at save time", () => {
  it("setTimezone() throws and does NOT persist an invalid zone", async () => {
    const scheduler = makeScheduler();
    await scheduler.resolveTimezone();
    const before = settingsStore.get("schedulerTimezone");
    setSetting.mockClear();

    await expect(scheduler.setTimezone("Not/AZone")).rejects.toThrow(/not a valid/i);

    expect(setSetting).not.toHaveBeenCalled();
    expect(settingsStore.get("schedulerTimezone")).toBe(before);
  });

  it("positive control: setTimezone() accepts a real IANA zone and persists it", async () => {
    const scheduler = makeScheduler();
    await scheduler.resolveTimezone();

    await scheduler.setTimezone("Europe/Berlin");

    expect(settingsStore.get("schedulerTimezone")).toBe("Europe/Berlin");
    expect(scheduler.effectiveTimezone).toBe("Europe/Berlin");
  });
});

describe("Scheduler restart warning settings", () => {
  it("persists a valid custom template and makes it effective immediately", async () => {
    const scheduler = makeScheduler();
    const restartWarning = await scheduler.setRestartWarning({
      locale: "zh-CN",
      template: "请在 {count}{unit} 内到安全地点",
    });

    expect(restartWarning).toEqual({
      locale: "zh-CN",
      template: "请在 {count}{unit} 内到安全地点",
    });
    expect(settingsStore.get("restartWarning")).toEqual(restartWarning);
    expect(scheduler.getStatus().restartWarning).toEqual(restartWarning);
  });

  it("rejects invalid settings without overwriting the current warning", async () => {
    const scheduler = makeScheduler();
    await scheduler.setRestartWarning({ locale: "en", template: "Restart in {count} {unit}" });
    setSetting.mockClear();

    await expect(
      scheduler.setRestartWarning({ locale: "en", template: "Restart in {minutes}" }),
    ).rejects.toThrow(/placeholders/i);

    expect(setSetting).not.toHaveBeenCalled();
    expect(scheduler.getStatus().restartWarning.template).toBe("Restart in {count} {unit}");
  });
});

describe("Scheduler timezone fallback: a stored zone that stops being valid fails LOUDLY and keeps running", () => {
  it("falls back to the process default, logs an error, and surfaces the mismatch on timezoneFallback -- does not refuse to start, does not silently substitute", async () => {
    // Simulates a restored db.json from a different machine, or tzdata
    // dropping a deprecated name -- the stored value is corrupt/invalid,
    // not absent (that's the migration case above).
    settingsStore.set("schedulerTimezone", "Not/AZone");
    const scheduler = makeScheduler();
    const processDefault = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const resolved = await scheduler.resolveTimezone();

    expect(resolved).toBe(processDefault);
    expect(scheduler.effectiveTimezone).toBe(processDefault);
    expect(scheduler.configuredTimezone).toBe("Not/AZone");
    expect(scheduler.timezoneFallback).toEqual({
      configured: "Not/AZone",
      effective: processDefault,
    });
    expect(logError).toHaveBeenCalledWith(expect.stringMatching(/not a valid IANA zone/i));

    // Never silently overwritten -- the operator's own (currently broken)
    // choice stays on record so getStatus() can keep reporting it verbatim,
    // and fixing it is a deliberate act, not an accidental one triggered
    // by a routine restart.
    expect(settingsStore.get("schedulerTimezone")).toBe("Not/AZone");

    // Scheduling still WORKS under the fallback -- the whole point of
    // "fail loudly and keep running" instead of refusing to start.
    const scheduled = scheduler.scheduleTask({
      id: 7,
      name: "Still works",
      cron_expression: "0 3 * * *",
      command: "save",
    });
    expect(scheduled).not.toBe(false);
    scheduler.jobs.get(7).stop();
  });

  // 2026-09-05, scheduler-time-audit: a bare offset ("-05:00") used to pass
  // isValidIanaTimezone() and get kept forever -- it never becomes invalid
  // on its own (no tzdata entry to remove), so an install that already had
  // one saved would silently drift by an hour every DST transition with no
  // warning at all. Now that the validator rejects it, this hits the SAME
  // fallback path as the corrupted-name case above, but must say something
  // specific to a raw offset -- "tzdata removed a deprecated name" would be
  // actively misleading here, since nothing was ever a real name to begin
  // with.
  it("names the specific raw-offset problem, not the generic 'invalid zone' message, when an install already saved one", async () => {
    settingsStore.set("schedulerTimezone", "-05:00");
    const scheduler = makeScheduler();
    const processDefault = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const resolved = await scheduler.resolveTimezone();

    expect(resolved).toBe(processDefault);
    expect(scheduler.timezoneFallback).toEqual({
      configured: "-05:00",
      effective: processDefault,
    });
    expect(logError).toHaveBeenCalledWith(
      expect.stringMatching(/fixed UTC offset, not a real timezone/i),
    );
    expect(logError).not.toHaveBeenCalledWith(
      expect.stringMatching(/deprecated name|restored from a different machine/i),
    );
  });
});

describe("Scheduler timezone: ALL THREE schedule kinds resolve to the SAME zone", () => {
  it("a user task, the backup job, and AUTO_RESTART_CRON all receive the identical effectiveTimezone", async () => {
    const originalEnv = { ...process.env };
    process.env.AUTO_RESTART_ENABLED = "true";
    process.env.AUTO_RESTART_CRON = "0 */6 * * *";

    try {
      const scheduler = makeScheduler();
      await scheduler.resolveTimezone();
      scheduler.setBackupService({
        getSettings: vi.fn(async () => ({ enabled: true, schedule: "0 */12 * * *", includeDb: false })),
        createBackup: vi.fn(),
      });

      const scheduledOk = scheduler.scheduleTask({
        id: 42,
        name: "Task",
        cron_expression: "0 4 * * *",
        command: "save",
      });
      expect(scheduledOk).not.toBe(false);
      scheduler.setupAutoRestart();
      await scheduler.setupBackupSchedule();

      const taskZone = scheduler.jobs.get(42).timeMatcher.timezone;
      const backupZone = scheduler.backupJob.timeMatcher.timezone;
      const autoRestartZone = scheduler.autoRestartJob.timeMatcher.timezone;

      expect(taskZone).toBe(scheduler.effectiveTimezone);
      expect(backupZone).toBe(scheduler.effectiveTimezone);
      expect(autoRestartZone).toBe(scheduler.effectiveTimezone);

      scheduler.jobs.get(42).stop();
      scheduler.backupJob.stop();
      scheduler.autoRestartJob.stop();
    } finally {
      process.env = originalEnv;
    }
  });
});

describe("Scheduler.setTimezone(): changing the zone reschedules everything immediately, not just future task creations", () => {
  it("re-registers an already-enabled task, the backup job, and auto-restart under the new zone", async () => {
    const originalEnv = { ...process.env };
    process.env.AUTO_RESTART_ENABLED = "true";
    process.env.AUTO_RESTART_CRON = "0 */6 * * *";

    getScheduledTasks.mockResolvedValueOnce([
      { id: 99, name: "Existing task", cron_expression: "0 5 * * *", command: "save", enabled: 1 },
    ]);

    try {
      const scheduler = makeScheduler();
      await scheduler.resolveTimezone();
      scheduler.setBackupService({
        getSettings: vi.fn(async () => ({ enabled: true, schedule: "0 */12 * * *", includeDb: false })),
        createBackup: vi.fn(),
      });
      scheduler.setupAutoRestart();
      await scheduler.setupBackupSchedule();

      await scheduler.setTimezone("Asia/Tokyo");

      expect(scheduler.effectiveTimezone).toBe("Asia/Tokyo");
      expect(scheduler.jobs.get(99).timeMatcher.timezone).toBe("Asia/Tokyo");
      expect(scheduler.backupJob.timeMatcher.timezone).toBe("Asia/Tokyo");
      expect(scheduler.autoRestartJob.timeMatcher.timezone).toBe("Asia/Tokyo");

      scheduler.jobs.get(99).stop();
      scheduler.backupJob.stop();
      scheduler.autoRestartJob.stop();
    } finally {
      process.env = originalEnv;
    }
  });
});
