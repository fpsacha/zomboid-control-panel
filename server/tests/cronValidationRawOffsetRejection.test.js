import { describe, expect, it } from "vitest";
import {
  isValidIanaTimezone,
  isRawOffsetTimezone,
} from "../utils/cronValidation.js";

// 2026-09-05, scheduler-time-audit: isValidIanaTimezone() used to accept a
// bare numeric UTC offset ("-05:00") because it only checked whether
// `new Intl.DateTimeFormat(..., { timeZone: tz })` throws -- true for
// offsets too, not just real zone names. fd346578 (the timezone-picker
// feature) deliberately chose that constructor-throws check over the
// narrower Intl.supportedValuesOf() list specifically to keep accepting
// legacy ALIAS NAMES a real install might already have saved ("PST", etc.)
// -- that reasoning never covered a bare offset, which isn't an alias for a
// place and observes no DST at all. A schedule pinned to one would silently
// and permanently drift by an hour from the operator's real local time
// across every DST transition, with nothing to notice it by.
//
// These tests prove the fix rejects only the offset shapes, not the alias
// leniency fd346578 chose on purpose.
describe("isValidIanaTimezone() / isRawOffsetTimezone() -- reject bare offsets, keep everything else", () => {
  it.each([
    ["-05:00", true],
    ["+0530", true],
    ["-0500", true],
    ["UTC+2", true],
    ["utc-05:00", true],
    ["GMT-5", true],
    ["gmt+05:00", true],
  ])("rejects the bare-offset shape %s", (tz, expectedRawOffset) => {
    expect(isRawOffsetTimezone(tz)).toBe(expectedRawOffset);
    expect(isValidIanaTimezone(tz)).toBe(false);
  });

  it.each([
    "America/New_York",
    "UTC",
    "PST", // legacy alias -- exactly what fd346578's leniency exists to keep accepting
    "Europe/London",
    "Asia/Tokyo",
  ])("still accepts %s (not a bare offset)", (tz) => {
    expect(isRawOffsetTimezone(tz)).toBe(false);
    expect(isValidIanaTimezone(tz)).toBe(true);
  });

  it("rejects non-string and empty input the same as before (unrelated to this fix)", () => {
    expect(isValidIanaTimezone("")).toBe(false);
    expect(isValidIanaTimezone(null)).toBe(false);
    expect(isValidIanaTimezone(undefined)).toBe(false);
    expect(isValidIanaTimezone("Not/A/Real/Zone")).toBe(false);
  });
});
