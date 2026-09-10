import { describe, expect, it } from "vitest";

// panel-update-download-temp-path-is-per-process-not-per-call, 2026-09-10.
//
// tmpDownloadPath/tmpClientArchivePath (downloadAndStageUpdate(), around
// line 726 before this fix) were built from `process.pid` alone -- stable
// for the whole process lifetime, not per call. A failed download followed
// by an operator retry (same process, no restart) reused the exact same
// path. downloadFile()'s own fail() defers its cleanup unlink until the
// destroyed write stream's "close" event actually fires (see its comment
// for why: an immediate unlink can race a still-open Windows handle) --
// that deferred unlink is fire-and-forget, so if it happens to land AFTER
// a retry has already reopened the identical path for a fresh write, the
// first attempt's ghost cleanup deletes the second attempt's active file.
//
// The fix (nextPartialCallId(), panelUpdateChecker.js): a monotonic
// per-process counter appended to process.pid, incremented once per
// downloadAndStageUpdate() call, so every attempt -- retry or not -- gets
// its own temp path and the two attempts' cleanups can never cross wires.
// NOT a bare timestamp: two calls landing in the same millisecond is real
// on this codebase's own dev disk (see the log-tailer tie-break work the
// same night), not a theoretical concern to wave off.
process.pkg = {};

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");

describe("PanelUpdateChecker.nextPartialCallId(): per-call, not per-process", () => {
  it("returns a DIFFERENT id on each call from the same instance, both still tagged with this process's pid", () => {
    const checker = new PanelUpdateChecker();

    const first = checker.nextPartialCallId();
    const second = checker.nextPartialCallId();
    const third = checker.nextPartialCallId();

    expect(new Set([first, second, third]).size).toBe(3);
    for (const id of [first, second, third]) {
      expect(id).toMatch(new RegExp(`^${process.pid}-\\d+$`));
    }
  });

  it("is NOT a bare pid -- the exact shape the shipped bug had, which made a retry within the same process collide with the attempt before it", () => {
    const checker = new PanelUpdateChecker();
    const id = checker.nextPartialCallId();

    // A bare pid alone (the pre-fix shape) would be reused by every call
    // in this same process -- asserting it's more specific than that is
    // the actual regression this card exists to close.
    expect(id).not.toBe(String(process.pid));
    expect(id.startsWith(`${process.pid}-`)).toBe(true);
  });

  it("starts a fresh counter per PanelUpdateChecker instance (matches a fresh process, since the checker is a process-lifetime singleton in production)", () => {
    const checkerA = new PanelUpdateChecker();
    const checkerB = new PanelUpdateChecker();

    expect(checkerA.nextPartialCallId()).toBe(`${process.pid}-1`);
    expect(checkerB.nextPartialCallId()).toBe(`${process.pid}-1`);
    expect(checkerA.nextPartialCallId()).toBe(`${process.pid}-2`);
  });
});
