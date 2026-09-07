import { describe, expect, it } from "vitest";
import { isServerObservedRunning, resolveServerPhase } from "../utils/serverStatus.js";

describe("isServerObservedRunning", () => {
  it("reports stopped when every signal is absent", () => {
    expect(isServerObservedRunning()).toBe(false);
  });

  it("accepts each direct running signal", () => {
    expect(isServerObservedRunning({ processRunning: true })).toBe(true);
    expect(isServerObservedRunning({ rconConnected: true })).toBe(true);
    expect(isServerObservedRunning({ bridgeConnected: true })).toBe(true);
  });

  it("keeps a systemd-hosted server online when strict process attribution fails", () => {
    expect(
      isServerObservedRunning({
        processRunning: false,
        rconConnected: true,
        bridgeConnected: true,
      }),
    ).toBe(true);
  });

  it("preserves an unknown state when process detection fails without another live signal", () => {
    expect(
      isServerObservedRunning({
        processRunning: false,
        processScanFailed: true,
      }),
    ).toBeNull();
  });

  it("trusts a completed host check over stale connector flags", () => {
    expect(
      isServerObservedRunning({
        processRunning: false,
        rconConnected: true,
        bridgeConnected: true,
        hostStateAuthoritative: true,
      }),
    ).toBe(false);
  });
});

// 2026-09-07 STARTING-state fix: a bare running:true used to fire the moment
// the host process/container was detected, seconds after POST /start spawns
// it, while RCON can take 60-180+s to come up on a real world load --
// Layout.tsx's sidebar dot read that raw boolean and went green during the
// exact window a connection attempt would fail. This is display-only and
// never gates anything (checkServerStatusNow's `running` comparisons are
// unchanged) -- it only refines what phase a client renders for the same
// `running: true`.
describe("resolveServerPhase", () => {
  it("is 'stopped' whenever running is false, regardless of the other signals", () => {
    expect(
      resolveServerPhase({ running: false, serverStarting: true, rconConnected: true }),
    ).toBe("stopped");
  });

  it("is 'unknown' when running itself could not be determined", () => {
    expect(resolveServerPhase({ running: null })).toBe("unknown");
    expect(resolveServerPhase({})).toBe("unknown");
  });

  it("is 'running' once RCON is connected, even if serverStarting hasn't been cleared yet", () => {
    expect(
      resolveServerPhase({ running: true, serverStarting: true, rconConnected: true }),
    ).toBe("running");
  });

  it("is 'starting' when the host is up, RCON isn't connected, and we're still inside the startup grace window", () => {
    expect(
      resolveServerPhase({ running: true, serverStarting: true, rconConnected: false }),
    ).toBe("starting");
  });

  it("is 'unresponsive' when the host is up, RCON never connected, and the grace window has closed -- 'starting forever' is not an acceptable answer", () => {
    expect(
      resolveServerPhase({ running: true, serverStarting: false, rconConnected: false }),
    ).toBe("unresponsive");
  });
});
