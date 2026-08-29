import { describe, expect, it, vi } from "vitest";

// 2026-08-26 bug hunt: POST /stop's graceful (RCON) path used to report
// success:true and broadcast server:status {running:false} the instant
// rconService.quit() returned -- which only proves PZ accepted the "quit"
// command (a reset RCON connection is the NORMAL symptom of a real
// shutdown), not that the process has actually exited or that its
// save-and-exit sequence has finished. An operator who read "Stopped" and
// then acted outside the panel (copied the save folder, edited an ini,
// pulled a Docker volume) could be acting against a process still writing.
//
// Fixed: the graceful path now reports the request was ACCEPTED
// (confirmed:false), does NOT emit server:status itself, and asks the
// status watchdog's checkServerStatusNow (server/index.js, registered on
// `app`) for a prompt re-check instead -- the SAME function the watchdog's
// own 10s interval calls, so there is exactly one place that ever decides
// "did the running state actually change" and emits server:status for it.
// The managed (Docker) path is untouched: Docker's own stop API already
// blocks until the container is confirmed stopped before returning
// success, so that claim was never blind.

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
    rconService: { connected: true, save: vi.fn().mockResolvedValue({ success: true }) },
    serverManager: { markServerStopped: vi.fn() },
    io: { emit: vi.fn() },
    discordBot: { sendEventNotification: vi.fn().mockResolvedValue() },
    checkServerStatusNow: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { get: (key) => values[key] };
}

describe("POST /stop -- graceful RCON path no longer claims a confirmed stop", () => {
  it("reports confirmed:false and does not emit server:status when quit() only confirms acceptance", async () => {
    const rconService = {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: true }),
      quit: vi.fn().mockResolvedValue({ success: true, response: "Server shutting down" }),
    };
    const io = { emit: vi.fn() };
    const checkServerStatusNow = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({ rconService, io, checkServerStatusNow });
    const response = createResponse();

    await getHandler("/stop", "post")({ app, body: {} }, response);

    expect(response.status).not.toHaveBeenCalledWith(502);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        confirmed: false,
        message: "Server shutting down",
      }),
    );
    // The route itself must not assert the running:false claim anymore --
    // that's the exact thing that used to desync from reality.
    expect(io.emit).not.toHaveBeenCalledWith("server:status", expect.anything());
  });

  it("asks the status watchdog for a prompt re-check instead of emitting its own claim", async () => {
    const rconService = {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: true }),
      quit: vi.fn().mockResolvedValue({ success: true, response: "Server shutting down" }),
    };
    const checkServerStatusNow = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({ rconService, checkServerStatusNow });
    const response = createResponse();

    await getHandler("/stop", "post")({ app, body: {} }, response);

    expect(checkServerStatusNow).toHaveBeenCalledTimes(1);
  });

  it("does not call markServerStopped for the unconfirmed graceful path -- serverManager's own next real scan clears run state once actually confirmed", async () => {
    const rconService = {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: true }),
      quit: vi.fn().mockResolvedValue({ success: true, response: "Server shutting down" }),
    };
    const serverManager = { markServerStopped: vi.fn() };
    const app = makeApp({ rconService, serverManager });
    const response = createResponse();

    await getHandler("/stop", "post")({ app, body: {} }, response);

    expect(serverManager.markServerStopped).not.toHaveBeenCalled();
  });

  it("does not throw when checkServerStatusNow is missing from app.get (defends against a simplified test mock or a registration gap)", async () => {
    const rconService = {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: true }),
      quit: vi.fn().mockResolvedValue({ success: true, response: "Server shutting down" }),
    };
    const app = makeApp({ rconService, checkServerStatusNow: undefined });
    const response = createResponse();

    await expect(
      getHandler("/stop", "post")({ app, body: {} }, response),
    ).resolves.not.toThrow();
  });

  it("still fails closed (502) when quit() itself fails -- the pre-existing confirmed-failure gate is untouched", async () => {
    const rconService = {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: true }),
      quit: vi.fn().mockResolvedValue({ success: false, error: "RCON error" }),
    };
    const app = makeApp({ rconService });
    const response = createResponse();

    await getHandler("/stop", "post")({ app, body: {} }, response);

    expect(response.status).toHaveBeenCalledWith(502);
  });
});

describe("POST /stop -- managed (Docker) path is unchanged, since it was never blind", () => {
  it("still emits server:status, marks stopped, and notifies Discord immediately -- Docker's own stop API already confirms before returning success", async () => {
    runManagedLifecycleMock.mockResolvedValueOnce({
      handled: true,
      success: true,
      message: "Container stopping",
    });
    const rconService = { connected: true, save: vi.fn().mockResolvedValue({ success: true }) };
    const serverManager = { markServerStopped: vi.fn() };
    const io = { emit: vi.fn() };
    const discordBot = { sendEventNotification: vi.fn().mockResolvedValue() };
    const checkServerStatusNow = vi.fn();
    const app = makeApp({ rconService, serverManager, io, discordBot, checkServerStatusNow });
    const response = createResponse();

    await getHandler("/stop", "post")({ app, body: {} }, response);

    expect(serverManager.markServerStopped).toHaveBeenCalledTimes(1);
    expect(io.emit).toHaveBeenCalledWith("server:status", { running: false });
    expect(discordBot.sendEventNotification).toHaveBeenCalledWith("serverStop", {});
    // The managed path is confirmed, not a request -- it must not go through
    // the RCON path's "ask the watchdog" nudge.
    expect(checkServerStatusNow).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, message: "Container stopping" }),
    );
  });
});

describe("POST /stop -- managed Linux service", () => {
  it("saves through RCON, then stops the service instead of sending RCON quit", async () => {
    const rconService = {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: true }),
      quit: vi.fn(),
    };
    const serverManager = {
      loadConfig: vi.fn().mockResolvedValue(undefined),
      usesManagedServiceLifecycle: vi.fn().mockReturnValue(true),
      stopServer: vi.fn().mockResolvedValue({
        success: true,
        confirmed: true,
        message: "Server stop completed through systemd",
      }),
      markServerStopped: vi.fn(),
      lifecycleProvider: "systemd",
    };
    const io = { emit: vi.fn() };
    const app = makeApp({ rconService, serverManager, io });
    const response = createResponse();

    await getHandler("/stop", "post")({ app, body: {} }, response);

    expect(rconService.save).toHaveBeenCalledOnce();
    expect(rconService.quit).not.toHaveBeenCalled();
    expect(serverManager.stopServer).toHaveBeenCalledWith(false);
    expect(io.emit).toHaveBeenCalledWith("server:status", { running: false });
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, confirmed: true }),
    );
  });
});
