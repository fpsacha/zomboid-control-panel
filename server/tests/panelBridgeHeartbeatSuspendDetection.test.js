import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-09-06, host-suspend-resume sweep (operator-decided shape): PanelBridge
// runs a periodic heartbeat (checkHeartbeat(), wired into start()/stop()
// alongside pollInterval/statusInterval) whose only job is to notice when
// the wall-clock gap between its own ticks is much larger than the interval
// it was scheduled at -- setInterval callbacks simply do not fire while the
// host is suspended, so the next tick after resume sees Date.now() jump by
// the FULL real elapsed time. See database/init.js's
// applySuspendGapToInFlightSessions() for what happens to playtime once a
// gap is detected; this file tests the detection + wiring in isolation from
// that logic (mocked here).

const applySuspendGapToInFlightSessions = vi.fn(async () => ({ adjustedPlayers: [] }));
const logServerEvent = vi.fn(async () => {});
vi.mock("../database/init.js", () => ({
  logPlayerAction: vi.fn(async () => {}),
  recordPlayerSession: vi.fn(async () => {}),
  logServerEvent: (...args) => logServerEvent(...args),
  applySuspendGapToInFlightSessions: (...args) => applySuspendGapToInFlightSessions(...args),
}));

const { PanelBridge } = await import("../services/panelBridge.js");

beforeEach(() => {
  applySuspendGapToInFlightSessions.mockClear();
  logServerEvent.mockClear();
});

describe("PanelBridge.checkHeartbeat(): host-suspend detection", () => {
  it("does nothing on an ordinary on-time tick (no false alarm on routine jitter)", async () => {
    const bridge = new PanelBridge();
    bridge.lastHeartbeatAt = Date.now() - bridge.config.heartbeatIntervalMs; // exactly on schedule

    await bridge.checkHeartbeat();

    expect(applySuspendGapToInFlightSessions).not.toHaveBeenCalled();
    expect(logServerEvent).not.toHaveBeenCalled();
  });

  it("does nothing for a small jitter well under the suspend threshold", async () => {
    const bridge = new PanelBridge();
    // 2s late is well within GC-pause/event-loop-jitter territory.
    bridge.lastHeartbeatAt = Date.now() - bridge.config.heartbeatIntervalMs - 2000;

    await bridge.checkHeartbeat();

    expect(applySuspendGapToInFlightSessions).not.toHaveBeenCalled();
    expect(logServerEvent).not.toHaveBeenCalled();
  });

  it("detects a large gap, subtracts it from in-flight sessions, and logs a diagnostic event (regression guard)", async () => {
    const bridge = new PanelBridge();
    // Simulate a ~2 hour host suspend: the last heartbeat was set long ago,
    // far beyond heartbeatIntervalMs + the suspend threshold.
    const twoHoursMs = 2 * 60 * 60 * 1000;
    bridge.lastHeartbeatAt = Date.now() - twoHoursMs;
    applySuspendGapToInFlightSessions.mockResolvedValueOnce({ adjustedPlayers: ["Alice", "Bob"] });

    await bridge.checkHeartbeat();

    expect(applySuspendGapToInFlightSessions).toHaveBeenCalledTimes(1);
    const gapArg = applySuspendGapToInFlightSessions.mock.calls[0][0];
    // The reported gap should be close to the simulated suspend duration
    // (minus one heartbeatIntervalMs, which is the "expected" portion of
    // the wait) -- allow generous slack for real test execution time.
    expect(gapArg).toBeGreaterThan(twoHoursMs - bridge.config.heartbeatIntervalMs - 5000);

    expect(logServerEvent).toHaveBeenCalledTimes(1);
    expect(logServerEvent.mock.calls[0][0]).toBe("host_suspend_detected");
    expect(logServerEvent.mock.calls[0][1]).toMatch(/Alice, Bob/);
  });

  it("still logs the diagnostic event even when nobody was online (adjustedPlayers empty)", async () => {
    const bridge = new PanelBridge();
    bridge.lastHeartbeatAt = Date.now() - 60_000; // 1 minute gap, well over threshold
    applySuspendGapToInFlightSessions.mockResolvedValueOnce({ adjustedPlayers: [] });

    await bridge.checkHeartbeat();

    expect(applySuspendGapToInFlightSessions).toHaveBeenCalledTimes(1);
    expect(logServerEvent).toHaveBeenCalledTimes(1);
    expect(logServerEvent.mock.calls[0][1]).toMatch(/no players were online/);
  });

  it("start() initializes the heartbeat and stop() tears it down cleanly", () => {
    const bridge = new PanelBridge();
    bridge.bridgePath = "/tmp/fake-bridge";
    bridge.ensureQueueProtocol = vi.fn();
    bridge.setupFileWatcher = vi.fn();
    bridge.checkModStatus = vi.fn();

    bridge.start();
    expect(bridge.heartbeatInterval).not.toBeNull();
    expect(bridge.lastHeartbeatAt).not.toBeNull();

    bridge.stop();
    expect(bridge.heartbeatInterval).toBeNull();
    expect(bridge.lastHeartbeatAt).toBeNull();
  });
});
