import { describe, it, expect, beforeEach } from "vitest";

// 2026-09-06, host-suspend-resume sweep (operator-decided shape): before this
// fix, recordPlayerSession() computed a session's duration as pure wall
// clock (`sessionEnd - sessionStart`), so a host suspend (laptop sleep, VM
// pause) while a player was connected got the whole suspended window
// credited to them as playtime on their next real disconnect. Real module
// (not mocked) -- getDataPaths() resolves to this file's own isolated temp
// root via vitest.perFileDataDir.setup.mjs, never the real repo data/
// directory.
const { recordPlayerSession, applySuspendGapToInFlightSessions, getPlayerStat } =
  await import("../database/init.js");

describe("applySuspendGapToInFlightSessions()", () => {
  it("shifts an in-flight session's start forward so its eventual duration excludes the suspended gap (regression guard)", async () => {
    await recordPlayerSession("Alice", "connect");
    const beforeGap = await getPlayerStat("Alice");
    const startBeforeGap = new Date(beforeGap.last_session_start).getTime();

    // Simulate a 2-hour host suspend detected by the heartbeat.
    const gapMs = 2 * 60 * 60 * 1000;
    const { adjustedPlayers } = await applySuspendGapToInFlightSessions(gapMs);
    expect(adjustedPlayers).toEqual(["Alice"]);

    const afterGap = await getPlayerStat("Alice");
    const startAfterGap = new Date(afterGap.last_session_start).getTime();
    // Pre-fix behaviour (regression guard): without this shift, last_session_start
    // stays exactly where "connect" left it, and the eventual disconnect's
    // sessionEnd - sessionStart credits the full suspended window as playtime.
    expect(startAfterGap - startBeforeGap).toBe(gapMs);

    await recordPlayerSession("Alice", "disconnect");
    const finalStat = await getPlayerStat("Alice");
    // The real elapsed wall-clock time here is ~gapMs (this test runs in
    // milliseconds), so if the gap had NOT been subtracted, duration_seconds
    // would be within a couple seconds of gapMs/1000 (7200s). With the shift
    // applied, the shifted start is ~now, so duration is near zero.
    expect(finalStat.sessions[0].duration_seconds).toBeLessThan(5);
    expect(finalStat.sessions[0].suspended_seconds).toBe(Math.round(gapMs / 1000));
    // total_playtime_seconds must not have absorbed the suspended window either.
    expect(finalStat.total_playtime_seconds).toBeLessThan(5);
  });

  it("adjusts EVERY in-flight session at once, not just one", async () => {
    await recordPlayerSession("Bob", "connect");
    await recordPlayerSession("Carol", "connect");

    const gapMs = 30 * 60 * 1000;
    const { adjustedPlayers } = await applySuspendGapToInFlightSessions(gapMs);

    expect(adjustedPlayers.sort()).toEqual(["Bob", "Carol"]);

    await recordPlayerSession("Bob", "disconnect");
    await recordPlayerSession("Carol", "disconnect");

    const bob = await getPlayerStat("Bob");
    const carol = await getPlayerStat("Carol");
    expect(bob.sessions[0].duration_seconds).toBeLessThan(5);
    expect(carol.sessions[0].duration_seconds).toBeLessThan(5);
  });

  it("leaves a player with no in-flight session untouched", async () => {
    await recordPlayerSession("Dave", "connect");
    await recordPlayerSession("Dave", "disconnect");
    const beforeGap = await getPlayerStat("Dave");

    const { adjustedPlayers } = await applySuspendGapToInFlightSessions(60_000);

    expect(adjustedPlayers).toEqual([]);
    const afterGap = await getPlayerStat("Dave");
    expect(afterGap.last_session_start).toBeNull();
    expect(afterGap.sessions[0]).toEqual(beforeGap.sessions[0]);
  });

  it("keeps the session as ONE contiguous row -- no split, only the duration is corrected", async () => {
    await recordPlayerSession("Eve", "connect");
    await applySuspendGapToInFlightSessions(45 * 60 * 1000);
    await recordPlayerSession("Eve", "disconnect");

    const stat = await getPlayerStat("Eve");
    expect(stat.sessions).toHaveLength(1);
    expect(stat.session_count).toBe(1);
  });

  it("is a no-op for a zero or negative gap", async () => {
    const zero = await applySuspendGapToInFlightSessions(0);
    const negative = await applySuspendGapToInFlightSessions(-5000);
    expect(zero.adjustedPlayers).toEqual([]);
    expect(negative.adjustedPlayers).toEqual([]);
  });
});

describe("recordPlayerSession(): pending_suspend_adjustment_seconds bookkeeping", () => {
  beforeEach(async () => {
    // Fresh player per test in this describe to avoid cross-test leakage of
    // pending_suspend_adjustment_seconds via a shared name.
  });

  it("resets pending_suspend_adjustment_seconds on a fresh connect", async () => {
    await recordPlayerSession("Frank", "connect");
    await applySuspendGapToInFlightSessions(10 * 60 * 1000);
    await recordPlayerSession("Frank", "disconnect");
    let stat = await getPlayerStat("Frank");
    expect(stat.sessions[0].suspended_seconds).toBe(600);

    // A brand new session must not inherit the previous session's adjustment.
    await recordPlayerSession("Frank", "connect");
    await recordPlayerSession("Frank", "disconnect");
    stat = await getPlayerStat("Frank");
    expect(stat.sessions[0].suspended_seconds).toBeUndefined();
  });

  it("omits suspended_seconds entirely for an ordinary session with no detected gap", async () => {
    await recordPlayerSession("Grace", "connect");
    await recordPlayerSession("Grace", "disconnect");
    const stat = await getPlayerStat("Grace");
    expect(stat.sessions[0]).not.toHaveProperty("suspended_seconds");
  });
});
