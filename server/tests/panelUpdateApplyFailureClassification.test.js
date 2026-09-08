import { describe, expect, it } from "vitest";

// 2026-09-04, Dwight's live finding + god's follow-up: classifyApplyFailure()
// had never been directly tested before this file. readMostRecentApplyLog()
// prefers supervisor.log (build.js's generateStartBat(), "Supervisor v2")
// whenever it exists, and grepping build.js for every prose phrase the
// classifier matches on turns up zero occurrences of any of them -- so on a
// real current install, none of those branches could ever fire, and every
// real apply failure classified as "unknown" no matter what actually
// happened. Only the [pre-spawn]/"apply helper started" pair genuinely
// matches spawnWindowsApplyHelper()'s wording (dead in production, kept for
// an un-upgraded pre-v1.0.21 install); the rest of the prose predates even
// that -- `git log -S"quarantined by av"` shows it was introduced once, at
// v1.0.14, and never touched since, through two later apply-mechanism
// rewrites. Fixed by matching Supervisor v2's own stamped bracket codes
// (build.js's `:apply_update`/`:rollback_update` labels) as the primary
// signal, ahead of the legacy fallbacks.

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");

describe("classifyApplyFailure() recognises Supervisor v2's real, current wording", () => {
  it("Dwight's exact case: supervisor.log's actual av_quarantine line resolves correctly, not 'unknown'", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-04 10:00:00] Supervisor v2 starting\n" +
      "[2026-09-04 10:00:05] Apply: marker present, beginning swap\n" +
      "[2026-09-04 10:00:05] Apply: staged binary missing or quarantined [av_quarantine]\n";

    expect(checker.classifyApplyFailure(log, false)).toBe("av_quarantine");
  });

  it("binary_swap_failed with no discriminating cmd.exe text nearby still defaults to rename_locked -- unchanged behaviour for the shape this bucket has always covered", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-04 10:00:00] Supervisor v2 starting\n" +
      "[2026-09-04 10:00:05] Apply: marker present, beginning swap\n" +
      "[2026-09-04 10:00:05] Apply: backing up ZomboidControlPanel.exe to ZomboidControlPanel.exe.bundle-previous\n" +
      "[2026-09-04 10:00:05] Apply: could not back up running executable [binary_swap_failed]\n";

    expect(checker.classifyApplyFailure(log, true)).toBe("rename_locked");
  });

  // 2026-09-08, god-dispatched follow-up: classifyApplyFailure() returned
  // "rename_locked" for EVERY binary_swap_failed log, even when 8f939c1b's
  // raw cmd.exe error text (now captured on the line right before the
  // bracket tag, via build.js's `>>"%LOG_FILE%" 2>&1` redirect on the `ren`
  // command itself) said "Access is denied" -- a permissions problem, not a
  // lock. The bracket-first return short-circuited past the very prose
  // checks (~2726) that would have caught this. classifyBinarySwapFailure()
  // adds a secondary check, scoped to this one tag, mirroring
  // isRollbackRetryLikely()'s established pattern below.
  it("2026-09-08: binary_swap_failed + a real 'Access is denied' on the preceding line now sub-classifies as permission, not rename_locked", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-08 10:00:00] Supervisor v2 starting\n" +
      "[2026-09-08 10:00:05] Apply: marker present, beginning swap\n" +
      "Access is denied.\n" +
      "[2026-09-08 10:00:05] Apply: could not back up running executable [binary_swap_failed]\n";

    expect(checker.classifyApplyFailure(log, true)).toBe("permission");
  });

  it("2026-09-08: binary_swap_failed + 'being used by another process' on the preceding line still classifies as rename_locked -- the regression guard", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-08 10:00:00] Supervisor v2 starting\n" +
      "[2026-09-08 10:00:05] Apply: marker present, beginning swap\n" +
      "The process cannot access the file because it is being used by another process.\n" +
      "[2026-09-08 10:00:05] Apply: could not back up running executable [binary_swap_failed]\n";

    expect(checker.classifyApplyFailure(log, true)).toBe("rename_locked");
  });

  it("2026-09-08: only the LAST binary_swap_failed occurrence's preceding text decides -- an earlier attempt's 'Access is denied' must not leak into a later, differently-caused failure", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-08 09:00:00] Apply: marker present, beginning swap\n" +
      "Access is denied.\n" +
      "[2026-09-08 09:00:00] Apply: could not back up running executable [binary_swap_failed]\n" +
      "[2026-09-08 09:05:00] Apply: retrying after rollback\n" +
      "The process cannot access the file because it is being used by another process.\n" +
      "[2026-09-08 09:05:05] Apply: could not back up running executable [binary_swap_failed]\n";

    expect(checker.classifyApplyFailure(log, true)).toBe("rename_locked");
  });

  it("2026-09-08: frontend_swap_failed already discriminates permission vs rename_locked on its own, via the legacy whole-log prose fallback -- confirms only binary_swap_failed needed the fix, not both", () => {
    const checker = new PanelUpdateChecker();
    const deniedLog =
      "[2026-09-08 10:00:05] Apply: marker present, beginning swap\n" +
      "Access is denied.\n" +
      "[2026-09-08 10:00:05] Apply: could not activate staged frontend [frontend_swap_failed]\n";
    const lockedLog =
      "[2026-09-08 10:00:05] Apply: marker present, beginning swap\n" +
      "The process cannot access the file because it is being used by another process.\n" +
      "[2026-09-08 10:00:05] Apply: could not activate staged frontend [frontend_swap_failed]\n";

    expect(checker.classifyApplyFailure(deniedLog, true)).toBe("permission");
    expect(checker.classifyApplyFailure(lockedLog, true)).toBe("rename_locked");
  });

  it("only the LAST bracket tag decides -- an earlier unrelated tag from a prior step must not win", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-04 10:00:00] Supervisor v2 starting\n" +
      "[2026-09-04 09:59:00] Apply: update-bundle.json missing [version_mismatch]\n" +
      "[2026-09-04 10:00:05] Apply: staged binary missing or quarantined [av_quarantine]\n";

    expect(checker.classifyApplyFailure(log, false)).toBe("av_quarantine");
  });

  it("2026-09-08, god-dispatched fix: powershell_unavailable (a hash check that got no output, and a follow-up probe confirmed PowerShell itself won't run) maps to its own bucket, not av_quarantine", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-08 10:00:00] Supervisor v2 starting\n" +
      "[2026-09-08 10:00:05] Apply: marker present, beginning swap\n" +
      "[2026-09-08 10:00:06] Apply: staged binary hash check produced no output, and a trivial PowerShell probe ALSO produced none -- PowerShell itself appears blocked (execution policy / AppLocker / Group Policy) -- refusing to apply [powershell_unavailable]\n";

    expect(checker.classifyApplyFailure(log, false)).toBe("powershell_unavailable");
  });

  it("the SAME empty-hash-output case, but the follow-up probe found PowerShell working, still stamps av_quarantine (inconclusive, not a guess)", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-08 10:00:00] Supervisor v2 starting\n" +
      "[2026-09-08 10:00:05] Apply: marker present, beginning swap\n" +
      "[2026-09-08 10:00:06] Apply: staged binary hash check produced no output; a trivial PowerShell probe succeeded, so the cause is inconclusive -- refusing to apply [av_quarantine]\n";

    expect(checker.classifyApplyFailure(log, false)).toBe("av_quarantine");
  });

  it("a Supervisor v2 code with no existing client-recognised bucket still falls through to 'unknown' -- a named gap, not a regression", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-04 10:00:00] Supervisor v2 starting\n" +
      "[2026-09-04 10:00:05] Apply: staged frontend missing index.html [frontend_swap_failed]\n";

    expect(checker.classifyApplyFailure(log, false)).toBe("unknown");
  });

  // GH#149, 2026-09-08 (god-dispatched): startup_handshake_failed is the tag
  // Start.bat stamps whenever the newly-launched binary exits for ANY reason
  // while the applying marker is still present -- the swap itself (exe +
  // client dist) had already succeeded. This used to fall through to the
  // same "unknown" bucket as the other three still-deliberately-unmapped
  // codes (see the test above), which is exactly what cost a real reporter
  // three redundant 70MB re-downloads: the console said "cause: unknown"
  // while the log named this tag three lines away.
  it("2026-09-08 (GH#149): startup_handshake_failed now gets its own bucket, not 'unknown'", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-08 17:06:50] Apply: marker present, beginning swap\n" +
      "[2026-09-08 17:06:51] Apply: backing up ZomboidControlPanel.exe to ZomboidControlPanel.exe.bundle-previous\n" +
      "[2026-09-08 17:06:51] Apply: renaming ZomboidControlPanel.exe.new to ZomboidControlPanel.exe\n" +
      "[2026-09-08 17:06:52] Apply: bundle activated; waiting for backend startup acknowledgement\n" +
      "[2026-09-08 17:06:52] Apply: Launching ZomboidControlPanel.exe\n" +
      "[2026-09-08 17:07:02] Panel exited with code 76\n" +
      "[2026-09-08 17:07:02] Apply: startup handshake failed; rolling back bundle [startup_handshake_failed]\n" +
      "[2026-09-08 17:07:03] Apply: rollback complete\n";

    expect(checker.classifyApplyFailure(log, false)).toBe("startup_handshake_failed");
  });

  it("only the LAST startup_handshake_failed occurrence decides, same convention as every other tag", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-08 17:07:02] Apply: startup handshake failed; rolling back bundle, retry 1 of 2 [startup_handshake_failed]\n" +
      "[2026-09-08 17:07:10] Apply: staged binary missing or quarantined [av_quarantine]\n";

    expect(checker.classifyApplyFailure(log, false)).toBe("av_quarantine");
  });

  it("rollback_failed (2026-09-04, god's approval after the retry-risk case) maps to its own bucket", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-04 10:00:00] Supervisor v2 starting\n" +
      "[2026-09-04 10:00:05] Apply: rolling back bundle\n" +
      "[2026-09-04 10:00:06] Apply: rollback incomplete; journal retained for recovery [rollback_failed]\n";

    expect(checker.classifyApplyFailure(log, false)).toBe("rollback_failed");
  });

  it("the legacy [pre-spawn]-blocked path (spawnWindowsApplyHelper's format) still works for an un-upgraded pre-v1.0.21 install", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-04T10:00:00.000Z] [PRE-SPAWN] Panel is about to spawn apply helper: C:\\panel\\.panel-helpers\\apply-update-1.cmd\n" +
      "[2026-09-04T10:00:00.000Z] [PRE-SPAWN] If no further lines appear below, the helper was blocked from running (AV / ASR / policy).\n" +
      "[2026-09-04T10:00:00.000Z] [PRE-SPAWN] Recovery: close any running panel, then double-click Start.bat in C:\\panel\n";

    expect(checker.classifyApplyFailure(log, false)).toBe("helper_blocked");
  });

  it("the legacy av_quarantine prose pattern itself still classifies correctly -- pins the matcher even though nothing currently in this repo writes it (git log -S shows it dates to v1.0.14 and was never touched across two later apply-mechanism rewrites)", () => {
    const checker = new PanelUpdateChecker();
    const log = "Staged file quarantined by av before it could be placed.\n";

    expect(checker.classifyApplyFailure(log, false)).toBe("av_quarantine");
  });

  it("no log at all still reports no_helper_log", () => {
    const checker = new PanelUpdateChecker();
    expect(checker.classifyApplyFailure(null, false)).toBe("no_helper_log");
  });

  it("a log matching no known pattern, legacy or current, still reports unknown", () => {
    const checker = new PanelUpdateChecker();
    expect(checker.classifyApplyFailure("some unrelated log content", false)).toBe("unknown");
  });
});

// 2026-09-04, god's approval of the rollback_failed value: one likelyCause
// must not lie in any of its eight build.js trigger lines. 7 of the 8 leave
// a pending-update marker file behind (either .update-pending, re-triggering
// a fresh swap via run_loop's own check, or .update-applying, re-triggering
// the rollback itself via the startup-handshake check -- two different
// retry mechanisms, same operator-facing symptom). Only the 8th
// ("...could not remove journal") is reached with both marker files already
// cleared -- cosmetic, no retry risk, and the only one of the eight this
// must say false for.
describe("isRollbackRetryLikely() -- the one distinction rollback_failed's single likelyCause value must not blur", () => {
  it("restore itself failed (the most common shape -- covers all six specific binary/frontend sub-reasons, since build.js always stamps this summary line last when either restore fails)", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-04 10:00:00] Apply: binary restore failed; backup could not be activated [rollback_failed]\n" +
      "[2026-09-04 10:00:00] Apply: rollback incomplete; journal retained for recovery [rollback_failed]\n";

    expect(checker.isRollbackRetryLikely(log)).toBe(true);
  });

  it("restore succeeded but the pending marker itself could not be deleted -- still retry-likely", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-04 10:00:00] Apply: rollback cleanup incomplete; pending marker remains, journal retained [rollback_failed]\n";

    expect(checker.isRollbackRetryLikely(log)).toBe(true);
  });

  it("restore succeeded, pending marker cleared, but the applying marker could not be deleted -- still retry-likely", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-04 10:00:00] Apply: rollback cleanup incomplete; applying marker remains, journal retained [rollback_failed]\n";

    expect(checker.isRollbackRetryLikely(log)).toBe(true);
  });

  it("both marker files cleared, only the journal leftover -- cosmetic, NOT retry-likely (the one case that must not carry the warning)", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-04 10:00:00] Apply: rollback restored artifacts but could not remove journal [rollback_failed]\n";

    expect(checker.isRollbackRetryLikely(log)).toBe(false);
  });

  it("only the LAST rollback_failed line decides -- an earlier retry-risk line followed by the terminal journal-only line must read as NOT retry-likely", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-04 10:00:00] Apply: rollback cleanup incomplete; pending marker remains, journal retained [rollback_failed]\n" +
      "[2026-09-04 10:05:00] Apply: rollback restored artifacts but could not remove journal [rollback_failed]\n";

    expect(checker.isRollbackRetryLikely(log)).toBe(false);
  });

  it("no rollback_failed tag anywhere in the log -- not retry-likely (nothing to warn about)", () => {
    const checker = new PanelUpdateChecker();
    expect(checker.isRollbackRetryLikely("Apply: staged binary missing or quarantined [av_quarantine]\n")).toBe(false);
  });

  it("no log at all -- not retry-likely", () => {
    const checker = new PanelUpdateChecker();
    expect(checker.isRollbackRetryLikely(null)).toBe(false);
  });
});
