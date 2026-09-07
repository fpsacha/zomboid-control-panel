import { afterEach, describe, expect, it, vi } from "vitest";

const logServerEventMock = vi.fn(async () => ({}));
vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, logServerEvent: logServerEventMock };
});

const { checkServerStatusNow, io } = await import("../index.js");
const { ServerManager } = await import("../services/serverManager.js");
const { onLog } = await import("../utils/logger.js");

// Bug hunt 2026-08-31 (consolidation, carded by Pam's completeness-claims
// audit): checkServerStatusNow() gained an optional `detectionReason`
// parameter so the rconService "disconnected" handler (index.js:1219) can
// route through this ONE function instead of independently reading,
// comparing, mutating and emitting `lastKnownRunning` itself -- the
// duplicated-logic gap Pam's audit found in the function's own "no second
// copy" claim. This locks in that the reason reaches BOTH message sites
// (the shared "state changed" log line, and -- for a stop specifically --
// the persisted logServerEvent() message), which is the one thing that's
// genuinely new here: the transition logic itself (compare, mutate, emit,
// notify) is unchanged, pre-existing, and already exercised by the live
// watchdog interval in production.
//
// Drives the observed running-state deterministically by spying on
// ServerManager.prototype.getServerProcessDetails() -- a real prototype
// method shared by every instance including index.js's own module-level
// `serverManager`, so this reaches the same object index.js already
// constructed without needing index.js to export it. This machine has a
// REAL PZ server process running during this session (confirmed via a
// direct scan: ServerManager's real, unmocked getServerProcessDetails()
// finds it), which is exactly why the process-scan signal is what needs
// controlling here, not panelBridge/rcon -- those two are already `false`
// by default in a fresh test module and don't need touching.
//
// Log capture uses onLog() (utils/logger.js), the same real winston
// callback-transport mechanism index.js itself uses to stream log entries
// to the "logs" socket room -- not a console.log spy, which would miss
// winston's actual output path entirely.
describe("checkServerStatusNow(detectionReason) -- the reason reaches both transition messages", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("interpolates a custom detectionReason into both the 'state changed' log line and the persisted stop event, on a real stop transition", async () => {
    const emitSpy = vi.spyOn(io, "emit").mockImplementation(() => {});
    const logEntries = [];
    const unsubscribe = onLog((entry) => logEntries.push(entry));
    const flush = () => new Promise((resolve) => setImmediate(resolve)); // CallbackTransport dispatches via setImmediate

    const scanSpy = vi.spyOn(ServerManager.prototype, "getServerProcessDetails");

    try {
      // First call: process scan confirms running. This is the FIRST
      // observation this module-level watchdog state has ever seen in this
      // test file, so it only seeds `lastKnownRunning = true` -- no emit
      // yet (checkServerStatusNow's own `lastKnownRunning !== null` guard).
      scanSpy.mockResolvedValue({ running: true, scanFailed: false });
      await checkServerStatusNow("seed");
      await flush();
      expect(emitSpy).not.toHaveBeenCalled();

      // Second call: process scan now confirms NOT running (scanFailed
      // explicitly false, a definitive negative, not "couldn't tell") -- a
      // genuine stop transition. This is what should reach both the log
      // line and the persisted server_stop event with the custom reason.
      emitSpy.mockClear();
      logEntries.length = 0;
      logServerEventMock.mockClear();
      scanSpy.mockResolvedValue({ running: false, scanFailed: false });
      await checkServerStatusNow("integration-test-reason");
      await flush();

      // 2026-09-07 STARTING-state fix: checkServerStatusNow now also emits
      // a display-only `phase` (resolveServerPhase(), server/utils/serverStatus.js)
      // alongside the pre-existing `running` boolean -- running:false always
      // resolves to phase:'stopped' regardless of RCON/serverStarting state.
      expect(emitSpy).toHaveBeenCalledWith("server:status", { running: false, phase: "stopped" });
      const stateChangedLog = logEntries.find((e) =>
        e.message.includes("Server state changed"),
      );
      expect(stateChangedLog).toBeDefined();
      expect(stateChangedLog.message).toContain("(detected by integration-test-reason)");

      expect(logServerEventMock).toHaveBeenCalledWith(
        "server_stop",
        expect.stringContaining("(detected by integration-test-reason)"),
      );
    } finally {
      unsubscribe();
    }
  });
});
