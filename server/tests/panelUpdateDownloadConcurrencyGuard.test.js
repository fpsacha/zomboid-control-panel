import { afterEach, describe, expect, it } from "vitest";

// Hunt dispatch, 2026-09-08 (god: "call the five update routes' handlers
// directly, drive them through failure paths, assume there are siblings of
// the isApplying stuck-flag bug"): downloadUpdate()'s own isDownloading
// guard has the SAME check-then-act shape as that bug, just inverted --
// instead of forgetting to RESET the flag on a failure path, it forgot to
// SET the flag before the first await. The guard (`if (this.isDownloading)
// return already_downloading`) runs synchronously at the top, but the flag
// wasn't actually set to true until AFTER `await this.preflight()` --
// preflight() does real disk/permission checks, so that's a real, not just
// theoretical, window. A second downloadUpdate() call arriving during that
// window sees isDownloading still false and passes the same guard the first
// call just passed. Confirmed reachable with a scratch repro before fixing:
// two concurrent calls both got past the guard and both proceeded into
// asset lookup. With the same process pid, two concurrent REAL downloads
// would target the identical `${stagedPath}.partial.${process.pid}` temp
// path and interleave writes into one corrupted file.

process.pkg = {};

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");

function makeChecker({ preflightDelayMs = 10 } = {}) {
  const checker = new PanelUpdateChecker({ emit: () => {} });
  checker.currentVersion = "1.0.0";
  checker.updateAvailable = true;
  checker.latestRelease = { version: "9.9.9", assets: [] };
  // Real preflight() does real fs/network-ish awaits; a deliberate async gap
  // here reproduces the same shape without needing the real filesystem.
  checker.preflight = async () => {
    await new Promise((resolve) => setTimeout(resolve, preflightDelayMs));
    return { ok: true, blockers: [], warnings: [] };
  };
  return checker;
}

afterEach(() => {
  delete process.pkg;
  process.pkg = {};
});

describe("downloadUpdate(): the isDownloading guard must hold across its own await, not just before it", () => {
  it("rejects a second concurrent call with already_downloading instead of letting both proceed", async () => {
    const checker = makeChecker();

    const [first, second] = await Promise.all([
      checker.downloadUpdate(),
      checker.downloadUpdate(),
    ]);

    const codes = [first.code, second.code].sort();
    // One call proceeds (and fails downstream on the empty assets list --
    // irrelevant to this test, just needs a deterministic non-crashing
    // outcome); the other must be rejected by the guard, not also proceed.
    expect(codes).toContain("already_downloading");
    expect(
      [first, second].filter((r) => r.code === "already_downloading"),
    ).toHaveLength(1);
  });

  it("resets isDownloading (and lets a later call through) when preflight reports a blocker", async () => {
    const checker = makeChecker();
    checker.preflight = async () => ({
      ok: false,
      blockers: ["Disk is full"],
      warnings: [],
    });

    const result = await checker.downloadUpdate();

    expect(result.success).toBe(false);
    expect(result.error).toBe("Disk is full");
    expect(checker.isDownloading).toBe(false);
  });

  it("resets isDownloading when no matching release asset exists", async () => {
    const checker = makeChecker();
    checker.latestRelease.assets = []; // no Windows/Linux binary in the release

    const result = await checker.downloadUpdate();

    expect(result.success).toBe(false);
    expect(checker.isDownloading).toBe(false);
  });

  it("still reports already_downloading synchronously for a call made while a real download is in flight", async () => {
    const checker = makeChecker({ preflightDelayMs: 5 });
    const inFlight = checker.downloadUpdate();

    // Give the first call a moment to clear its own guard and claim the flag.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(checker.isDownloading).toBe(true);

    const rejected = await checker.downloadUpdate();
    expect(rejected.code).toBe("already_downloading");

    await inFlight;
  });
});
