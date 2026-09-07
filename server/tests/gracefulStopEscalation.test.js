import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 2026-09-07 lifecycle-actions hardening: POST /stop's background monitor
// (monitorGracefulStop) used to just poll for up to
// GRACEFUL_STOP_CONFIRMATION_TIMEOUT_MS (5 minutes) and then give up silently
// -- the game process could still be running, the lifecycle lock would
// release, and nothing had ever actually tried to kill it. That is exactly
// the failure shape god's hardening request named directly: "a graceful
// shutdown that hangs forever with no escalation to a hard kill is a hung
// panel." scheduler.js's performRestart() already escalates its own
// stop-phase to a force-kill after 60 failed 1s polls following its RCON
// quit -- this brings plain /stop's monitor in line with that same bound and
// the same mechanism (serverManager.stopServer(false, ...)).
//
// These tests exercise the real setTimeout-based poll loop with fake timers
// (not just asserting about it), the same discipline forceStopSaveOutcome.test.js
// used for the force-stop save timeout.

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
}));

const { runManagedLifecycleMock } = vi.hoisted(() => ({
  runManagedLifecycleMock: vi.fn(async () => ({ handled: false })),
}));
vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: (...args) => runManagedLifecycleMock(...args),
}));

const { default: router } = await import("../routes/server.js");
const { isLifecycleLocked } = await import("../services/lifecycleCoordinator.js");

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function makeApp(overrides = {}) {
  const values = {
    rconService: {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: true }),
      quit: vi.fn().mockResolvedValue({ success: true, response: "Server shutting down" }),
    },
    io: { emit: vi.fn() },
    discordBot: { sendEventNotification: vi.fn().mockResolvedValue() },
    checkServerStatusNow: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { get: (key) => values[key] };
}

describe("POST /stop -- graceful stop escalates to force-stop instead of hanging forever", () => {
  beforeEach(() => {
    runManagedLifecycleMock.mockReset().mockResolvedValue({ handled: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("force-stops after 60s if the process still hasn't confirmed stopped, then releases the lock", async () => {
    vi.useFakeTimers();
    try {
      let killed = false;
      const serverManager = {
        getServerProcessDetails: vi.fn(async () => ({
          scanFailed: false,
          running: !killed,
        })),
        stopServer: vi.fn(async () => {
          killed = true;
          return { success: true, confirmed: true };
        }),
        markServerStopped: vi.fn(),
      };
      const discordBot = { sendEventNotification: vi.fn().mockResolvedValue() };
      const checkServerStatusNow = vi.fn().mockResolvedValue(undefined);
      const app = makeApp({ serverManager, discordBot, checkServerStatusNow });
      const response = createResponse();

      await getHandler("/stop", "post")({ app, body: {} }, response);
      expect(isLifecycleLocked()).toBe(true);

      // Just under the 60s escalation bound: still locked, no force-stop yet.
      await vi.advanceTimersByTimeAsync(55_000);
      expect(serverManager.stopServer).not.toHaveBeenCalled();
      expect(isLifecycleLocked()).toBe(true);

      // Cross the bound: escalation fires, kills the process, confirms, releases.
      await vi.advanceTimersByTimeAsync(10_000);

      expect(serverManager.stopServer).toHaveBeenCalledWith(false, { serverId: null });
      expect(serverManager.markServerStopped).toHaveBeenCalledTimes(1);
      expect(checkServerStatusNow).toHaveBeenCalledWith("graceful-stop-escalated");
      expect(discordBot.sendEventNotification).toHaveBeenCalledWith("serverStop", {});
      expect(isLifecycleLocked()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never escalates when the process confirms stopped on its own before the bound", async () => {
    vi.useFakeTimers();
    try {
      const serverManager = {
        getServerProcessDetails: vi.fn().mockResolvedValue({
          scanFailed: false,
          running: false,
        }),
        stopServer: vi.fn(),
        markServerStopped: vi.fn(),
      };
      const app = makeApp({ serverManager });
      const response = createResponse();

      await getHandler("/stop", "post")({ app, body: {} }, response);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(serverManager.stopServer).not.toHaveBeenCalled();
      expect(isLifecycleLocked()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("escalates exactly once even if the process is still unconfirmed afterward, and eventually still releases the lock at the outer bound", async () => {
    vi.useFakeTimers();
    try {
      const serverManager = {
        // Force-stop is attempted but never actually confirms (e.g. a wedged
        // kernel-level hang) -- the escalation must not be retried every
        // subsequent poll tick, and the outer 5-minute bound must still be
        // the thing that eventually gives up.
        getServerProcessDetails: vi.fn().mockResolvedValue({
          scanFailed: false,
          running: true,
        }),
        stopServer: vi.fn().mockResolvedValue({
          success: false,
          confirmed: false,
          error: "kill signal not acknowledged",
        }),
        markServerStopped: vi.fn(),
      };
      const app = makeApp({ serverManager });
      const response = createResponse();

      await getHandler("/stop", "post")({ app, body: {} }, response);

      await vi.advanceTimersByTimeAsync(65_000);
      expect(serverManager.stopServer).toHaveBeenCalledTimes(1);
      expect(isLifecycleLocked()).toBe(true);

      // Advance well past escalation but still short of the outer 5-minute
      // confirmation deadline -- must not have called stopServer again.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(serverManager.stopServer).toHaveBeenCalledTimes(1);
      expect(isLifecycleLocked()).toBe(true);

      // Cross the outer 5-minute deadline -- gives up and releases regardless.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(serverManager.stopServer).toHaveBeenCalledTimes(1);
      expect(isLifecycleLocked()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not escalate on the managed (Docker) or service-managed path -- those are already confirmed synchronously before this monitor would ever run", async () => {
    vi.useFakeTimers();
    try {
      runManagedLifecycleMock.mockResolvedValueOnce({
        handled: true,
        success: true,
        message: "Container stopping",
      });
      const serverManager = { markServerStopped: vi.fn(), stopServer: vi.fn() };
      const app = makeApp({ serverManager });
      const response = createResponse();

      await getHandler("/stop", "post")({ app, body: {} }, response);
      expect(isLifecycleLocked()).toBe(false); // synchronous path releases immediately

      await vi.advanceTimersByTimeAsync(120_000);
      expect(serverManager.stopServer).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
