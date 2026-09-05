import { describe, expect, it, afterEach } from "vitest";
import {
  subHourlyIntervalMinutes,
  timezoneObservesDst,
  dstFallBackWarning,
} from "../utils/cronValidation.js";
import { Scheduler } from "../services/scheduler.js";

// 2026-09-05, scheduler-time-audit: node-cron's own README states its DST
// model verbatim: "Across a daylight-saving fall-back the repeated hour
// runs once, so a sub-hourly schedule (for example */15) can pause for up
// to the length of the DST shift during that hour." Nothing in the panel
// told an operator this could happen. dstFallBackWarning() (and the two
// functions it composes) surface it, server-side, at schedule-create/update
// time -- for a schedule in the 15-60 minute band in a DST-observing
// timezone. See cronValidation.js's own comment for why 15-60 specifically
// (isCronTooFrequent already floors every schedule at 5 minutes; losing one
// of many sub-5-14-minute fires is far less noticeable than losing one of
// only 1-4).

describe("subHourlyIntervalMinutes() -- the 'more than one fire per hour' shape node-cron's DST note is about", () => {
  it.each([
    ["*/15 * * * *", 15],
    ["*/20 * * * *", 20],
    ["*/30 * * * *", 30],
    ["0,30 * * * *", 30],
    ["0,20,40 * * * *", 20],
  ])("%s -> %s minute average interval", (expr, expected) => {
    expect(subHourlyIntervalMinutes(expr)).toBe(expected);
  });

  it("returns null for an exactly-hourly schedule (fires once per listed hour -- safe per node-cron's own doc)", () => {
    expect(subHourlyIntervalMinutes("30 * * * *")).toBeNull();
  });

  it("returns null for a malformed expression", () => {
    expect(subHourlyIntervalMinutes("not a cron")).toBeNull();
  });
});

describe("timezoneObservesDst()", () => {
  it("is true for a real DST-observing zone", () => {
    expect(timezoneObservesDst("America/New_York")).toBe(true);
  });

  it.each(["UTC", "Asia/Tokyo", "America/Phoenix"])(
    "is false for %s (no DST)",
    (zone) => {
      expect(timezoneObservesDst(zone)).toBe(false);
    },
  );
});

describe("dstFallBackWarning() -- composes the two checks above into the operator-facing message", () => {
  it("warns for a sub-hourly schedule in a DST-observing zone, naming the interval and the zone", () => {
    const warning = dstFallBackWarning(
      "*/15 * * * *",
      "America/New_York",
      "Nightly ping",
    );
    expect(warning).toContain("Nightly ping");
    expect(warning).toContain("15 minute");
    expect(warning).toContain("America/New_York");
    expect(warning).toContain("node-cron");
  });

  it("is null in a zone with no DST, even for the same sub-hourly schedule", () => {
    expect(dstFallBackWarning("*/15 * * * *", "UTC", "Nightly ping")).toBeNull();
  });

  it("is null for an exactly-hourly schedule, even in a DST zone", () => {
    expect(
      dstFallBackWarning("30 * * * *", "America/New_York", "Hourly"),
    ).toBeNull();
  });

  it("is null below the 15-minute floor (a 5-minute schedule fires often enough that losing one occurrence is a different concern)", () => {
    expect(
      dstFallBackWarning("*/5 * * * *", "America/New_York", "Very frequent"),
    ).toBeNull();
  });

  it("works with no label (auto-restart / backup callers don't pass a task name)", () => {
    const warning = dstFallBackWarning("*/20 * * * *", "America/New_York");
    expect(warning).not.toContain('""');
    expect(warning).toContain("20 minute");
  });
});

describe("Scheduler.scheduleTask() -- logs and returns the DST warning, doesn't break existing callers", () => {
  let scheduler;

  afterEach(() => {
    // cron.schedule() starts a real (if inert-until-fired) timer-driven job;
    // stop it so it doesn't outlive the test.
    for (const job of scheduler?.jobs?.values() || []) job.stop();
  });

  it("returns a truthy, non-false object on success (existing `=== false` and truthy checks both still work)", () => {
    scheduler = new Scheduler(null, null);
    scheduler.effectiveTimezone = "UTC";
    const result = scheduler.scheduleTask({
      id: "t1",
      name: "Hourly UTC task",
      cron_expression: "30 * * * *",
    });
    expect(result).not.toBe(false);
    expect(Boolean(result)).toBe(true);
    expect(result.scheduled).toBe(true);
    expect(result.dstWarning).toBeNull();
  });

  it("still returns exactly false on an invalid cron expression (unchanged failure shape)", () => {
    scheduler = new Scheduler(null, null);
    const result = scheduler.scheduleTask({
      id: "t2",
      name: "Bad task",
      cron_expression: "not a cron",
    });
    expect(result).toBe(false);
  });

  it("returns a non-null dstWarning for a sub-hourly task in a DST-observing timezone", () => {
    scheduler = new Scheduler(null, null);
    scheduler.effectiveTimezone = "America/New_York";
    const result = scheduler.scheduleTask({
      id: "t3",
      name: "Every 15",
      cron_expression: "*/15 * * * *",
    });
    expect(result.scheduled).toBe(true);
    expect(result.dstWarning).toContain("Every 15");
    expect(result.dstWarning).toContain("America/New_York");
  });

  it("returns a null dstWarning for the same sub-hourly cadence when the zone is UTC", () => {
    scheduler = new Scheduler(null, null);
    scheduler.effectiveTimezone = "UTC";
    const result = scheduler.scheduleTask({
      id: "t4",
      name: "Every 15 UTC",
      cron_expression: "*/15 * * * *",
    });
    expect(result.dstWarning).toBeNull();
  });
});
