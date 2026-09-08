import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Third instance of the same gap: gracefulShutdown() (SIGTERM/SIGINT) and
// the Windows Supervisor restart path (60f4de4f, see
// panelRestartWindowsSupervisorHandler.test.js) both close out every open
// player session via panelBridge.stop() -> trackPlayerActivity([]) before
// the process exits. fatalExit() -- the uncaughtException/unhandledRejection
// crash path -- did not, until now. Same mock shape as the Supervisor test:
// index.js registers panelBridge.on(...) listeners at module scope, so the
// fake has to be a real EventEmitter, not a plain object.
vi.mock("../services/panelBridge.js", async () => {
  const { EventEmitter } = await import("events");
  const { vi: vitest } = await import("vitest");
  const fake = new EventEmitter();
  fake.isRunning = true;
  fake.stop = vitest.fn();
  return { default: fake };
});

const { fatalExit } = await import("../index.js");
const panelBridge = (await import("../services/panelBridge.js")).default;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, "exit").mockImplementation(() => {});
  panelBridge.isRunning = true;
  panelBridge.stop.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fatalExit (uncaughtException / unhandledRejection crash path)", () => {
  it("stops the bridge (closing every open player session) before exiting", async () => {
    fatalExit("Uncaught Exception", new Error("boom"));

    expect(panelBridge.stop).toHaveBeenCalledTimes(1);
    expect(process.exit).not.toHaveBeenCalled();

    // fatalExit races flushWrites() against a 3s timeout before exiting.
    await vi.advanceTimersByTimeAsync(3000);

    expect(process.exit).toHaveBeenCalledWith(1);
    const stopOrder = panelBridge.stop.mock.invocationCallOrder[0];
    const exitOrder = process.exit.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(exitOrder);
  });

  it("does not stop the bridge when it isn't running", async () => {
    panelBridge.isRunning = false;

    fatalExit("Uncaught Exception", new Error("boom"));
    await vi.advanceTimersByTimeAsync(3000);

    expect(panelBridge.stop).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("still exits even if closing the bridge throws", async () => {
    panelBridge.stop.mockImplementation(() => {
      throw new Error("stop() blew up");
    });

    fatalExit("Uncaught Exception", new Error("boom"));
    await vi.advanceTimersByTimeAsync(3000);

    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
