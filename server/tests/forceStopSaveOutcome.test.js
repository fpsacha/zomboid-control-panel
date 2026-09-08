import { beforeEach, describe, expect, it, vi } from "vitest";

// Force Stop is the escape hatch for a wedged server -- unlike /stop,
// /restart (scheduler.performRestart) and docker.js's own dedicated
// container-action route, which all fail CLOSED (a failed save blocks the
// stop entirely), a failed or slow save here must never block the stop, or
// the escape hatch stops working. Previously /force-stop attempted no save
// at all, on either the Docker-managed or native branch -- for a
// Docker-managed server this meant discarding the world save for zero
// benefit, since dockerClient.runManagedAction() only ever accepts
// start/stop/restart (no separate "kill") and Docker's own stop API already
// escalates SIGTERM to SIGKILL internally regardless of which button was
// pressed, so Force Stop and Stop issued the identical call to Docker.
//
// Fix: attempt a bounded (3s) save on BOTH branches before proceeding,
// FAIL OPEN regardless of the outcome, and report which of
// saved/failed/timedOut/skipped happened in the response.
//
// These tests prove all four outcomes still let the stop proceed, that the
// same behaviour applies on both branches (not a smaller version of the
// same "one button, two meanings" defect), and -- the one that matters
// most, the same reason the ENOSPC-induced test on the earlier backup work
// mattered -- that the timeout path is exercised for real with fake timers
// against a save that genuinely never resolves, not just asserted about.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => ({ isRemote: false })),
}));

vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: vi.fn(),
}));

const { runManagedLifecycle } = await import("../services/managedContainer.js");
const { default: router } = await import("../routes/server.js");

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  // requirePermission is applied inline per-route in server.js, so the real
  // handler is the LAST entry in this route's middleware stack.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function makeApp({ rconService, serverManager, io }) {
  return {
    get: (key) => {
      if (key === "rconService") return rconService;
      if (key === "serverManager") return serverManager;
      if (key === "io") return io;
      return null;
    },
  };
}

describe("POST /server/force-stop -- bounded, fail-open pre-stop save", () => {
  beforeEach(() => {
    runManagedLifecycle.mockReset();
  });

  it("saves successfully, then proceeds with the Docker stop (saveOutcome: 'saved')", async () => {
    runManagedLifecycle.mockResolvedValue({
      handled: true,
      success: true,
      message: "Container stopped",
    });
    const rconService = {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: true }),
    };
    const response = createResponse();

    await getHandler("/force-stop", "post")(
      { app: makeApp({ rconService, serverManager: {}, io: { emit: vi.fn() } }) },
      response,
    );

    expect(rconService.save).toHaveBeenCalledWith({ retryOnConnectionError: false });
    expect(runManagedLifecycle).toHaveBeenCalledWith("stop", { serverId: null });
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, saveOutcome: "saved" }),
    );
  });

  it("proceeds with the stop even when the save fails -- NOT blocked (saveOutcome: 'failed')", async () => {
    runManagedLifecycle.mockResolvedValue({
      handled: true,
      success: true,
      message: "Container stopped",
    });
    const rconService = {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: false, error: "disk full" }),
    };
    const response = createResponse();

    await getHandler("/force-stop", "post")(
      { app: makeApp({ rconService, serverManager: {}, io: { emit: vi.fn() } }) },
      response,
    );

    expect(runManagedLifecycle).toHaveBeenCalledWith("stop", { serverId: null });
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, saveOutcome: "failed" }),
    );
  });

  it("does not attempt a save when RCON isn't connected, and still proceeds (saveOutcome: 'skipped')", async () => {
    runManagedLifecycle.mockResolvedValue({
      handled: true,
      success: true,
      message: "Container stopped",
    });
    const rconService = { connected: false, save: vi.fn() };
    const response = createResponse();

    await getHandler("/force-stop", "post")(
      { app: makeApp({ rconService, serverManager: {}, io: { emit: vi.fn() } }) },
      response,
    );

    expect(rconService.save).not.toHaveBeenCalled();
    expect(runManagedLifecycle).toHaveBeenCalledWith("stop", { serverId: null });
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, saveOutcome: "skipped" }),
    );
  });

  it("proceeds with the stop when the save never resolves -- the timeout path, exercised for real (saveOutcome: 'timedOut')", async () => {
    vi.useFakeTimers();
    try {
      runManagedLifecycle.mockResolvedValue({
        handled: true,
        success: true,
        message: "Container stopped",
      });
      const rconService = {
        connected: true,
        // A save that hangs forever -- the exact case the bounded timeout
        // exists for. If the route waited on this, the test itself would
        // hang; advancing fake time past the bound proves it doesn't.
        save: vi.fn(() => new Promise(() => {})),
      };
      const response = createResponse();

      const handlerPromise = getHandler("/force-stop", "post")(
        { app: makeApp({ rconService, serverManager: {}, io: { emit: vi.fn() } }) },
        response,
      );

      await vi.advanceTimersByTimeAsync(3100); // past the 3s bound
      await handlerPromise;

      expect(runManagedLifecycle).toHaveBeenCalledWith("stop", { serverId: null });
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, saveOutcome: "timedOut" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports saveOutcome even when the stop itself subsequently fails", async () => {
    runManagedLifecycle.mockResolvedValue({
      handled: true,
      success: false,
      error: "docker socket unreachable",
    });
    const rconService = {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: true }),
    };
    const response = createResponse();

    await getHandler("/force-stop", "post")(
      { app: makeApp({ rconService, serverManager: {}, io: { emit: vi.fn() } }) },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(502);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ saveOutcome: "saved" }),
    );
  });

  it("applies the same bounded save to the native (non-Docker) branch too -- not a smaller version of the divergence this fixes", async () => {
    runManagedLifecycle.mockResolvedValue({ handled: false });
    const rconService = {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: true }),
    };
    const serverManager = {
      stopServer: vi.fn().mockResolvedValue({ success: true, confirmed: true }),
    };
    const response = createResponse();

    await getHandler("/force-stop", "post")(
      { app: makeApp({ rconService, serverManager, io: { emit: vi.fn() } }) },
      response,
    );

    expect(rconService.save).toHaveBeenCalled();
    expect(serverManager.stopServer).toHaveBeenCalledWith({ serverId: null });
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, saveOutcome: "saved" }),
    );
  });
});
