import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// bug hunt 2026-09-07 (Date.now()-for-elapsed-time sweep, panelBridge.js
// tryResyncOutboxCursor's mirror finding in this file): acquireScanLock()'s
// stuck-mutex auto-reset ("Auto-reset if stuck for more than 5 minutes")
// used to compare Date.now() against a Date.now()-recorded start time. A
// wall-clock step BACKWARD (NTP correction, DST, a manual clock change)
// landing between conflictScanStartedAt being recorded and a later
// acquireScanLock() call means `Date.now() - conflictScanStartedAt` may
// never exceed SCAN_MUTEX_TIMEOUT_MS again -- a genuinely crashed/stuck
// conflict scan's mutex would never auto-release, rejecting every
// subsequent scan as "already running" until real wall-clock time closed
// whatever gap the step introduced. This is a stuck-state auto-recovery
// that can silently stop being able to run -- the exact class named in
// tonight's "is the remedy reachable from the state it remedies?" floor
// broadcast. Fixed with performance.now() (monotonic, cannot step
// backward). Each test gets its own fresh module instance (vi.resetModules
// + a dynamic re-import) since acquireScanLock/releaseScanLock hold
// mutable module-level lock state that would otherwise leak between tests.

describe("mods.js conflict-scan mutex: stuck-gate must be immune to a wall-clock backward jump", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("auto-resets a stuck lock once real (monotonic) time exceeds the 5-minute timeout, even if Date.now() has stepped backward", async () => {
    let mockPerfNow = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => mockPerfNow);
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const { acquireScanLock } = await import("../routes/mods.js");

    // First scan acquires the lock and "crashes" -- never calls
    // releaseScanLock, leaving conflictScanInFlight stuck true.
    const firstToken = acquireScanLock();
    expect(firstToken).not.toBeNull();

    // A second scan request right away is correctly rejected -- the lock
    // is legitimately held.
    expect(acquireScanLock()).toBeNull();

    // Wall clock steps backward by a huge amount (the exact scenario a
    // Date.now()-based gate cannot survive) while real, monotonic time
    // advances past SCAN_MUTEX_TIMEOUT_MS (5 minutes = 300000ms).
    Date.now.mockReturnValue(-1_000_000_000);
    mockPerfNow += 300_001;

    const recoveredToken = acquireScanLock();

    expect(recoveredToken).not.toBeNull();
    expect(recoveredToken).not.toBe(firstToken);
  });

  it("does not auto-reset a lock that has genuinely been held for under 5 minutes", async () => {
    let mockPerfNow = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => mockPerfNow);

    const { acquireScanLock } = await import("../routes/mods.js");

    const firstToken = acquireScanLock();
    expect(firstToken).not.toBeNull();

    mockPerfNow += 60_000; // 1 minute -- well under the 5-minute timeout

    expect(acquireScanLock()).toBeNull();
  });
});
