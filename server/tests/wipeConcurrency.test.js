import { describe, expect, it, vi } from "vitest";

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn(),
  getActiveServer: vi.fn(),
}));

const { default: router } = await import("../routes/server.js");
const { getActiveServer } = await import("../database/init.js");
getActiveServer.mockResolvedValue({
  zomboidDataPath: null,
  serverName: "servertest",
});

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getWipeHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/wipe" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function getSteamUpdateHandler() {
  const layer = router.stack.find(
    (entry) =>
      entry.route?.path === "/steam-update" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

describe("POST /api/server/wipe concurrency guard", () => {
  it("rejects a second wipe that arrives while the first is still validating", async () => {
    let releaseRunningCheck;
    let checkCalls = 0;
    // Signal, don't poll (f30b7558's fix for the sibling
    // wipeVsStartLifecycleLock.test.js, same class): a `while` loop here
    // would spin the microtask queue forever and hang the whole suite if a
    // future await ever lands ahead of this suspension point without
    // incrementing checkCalls -- with no indication in the trace of where it
    // got stuck. An unresolved `await checkEntered` instead fails at the
    // suite's timeout with `checkEntered` named, pointing straight at the
    // precondition that stopped holding.
    let checkEnteredResolve;
    const checkEntered = new Promise((r) => {
      checkEnteredResolve = r;
    });

    const serverManager = {
      loadConfig: async () => {},
      reloadConfig: async () => {},
      getServerProcessDetails: () => {
        checkCalls += 1;
        checkEnteredResolve();
        // Suspend the first request inside its validation phase.
        if (checkCalls === 1) {
          return new Promise((resolve) => {
            releaseRunningCheck = () =>
              resolve({ running: true, scanFailed: false });
          });
        }
        return Promise.resolve({ running: true, scanFailed: false });
      },
      savePath: null,
      serverName: "servertest",
    };

    const handler = getWipeHandler();
    const buildRequest = () => ({
      app: { get: () => serverManager },
      body: { targets: ["map"], confirm: true },
    });

    const firstResponse = createResponse();
    const secondResponse = createResponse();

    const firstCall = handler(buildRequest(), firstResponse);
    // Let the first request reach its suspension point inside
    // getServerProcessDetails() before firing the second.
    await checkEntered;

    await handler(buildRequest(), secondResponse);

    expect(secondResponse.status).toHaveBeenCalledWith(409);

    releaseRunningCheck();
    await firstCall;
  });

  it("releases the guard so a later wipe is not blocked forever", async () => {
    const serverManager = {
      loadConfig: async () => {},
      reloadConfig: async () => {},
      getServerProcessDetails: async () => ({
        running: true,
        scanFailed: false,
      }),
      savePath: null,
      serverName: "servertest",
    };

    const handler = getWipeHandler();
    const request = () => ({
      app: { get: () => serverManager },
      body: { targets: ["map"], confirm: true },
    });

    const first = createResponse();
    await handler(request(), first);

    const second = createResponse();
    await handler(request(), second);

    // Both are rejected for "server running", never 409 from a stuck guard.
    expect(second.status).toHaveBeenCalledWith(400);
    expect(second.status).not.toHaveBeenCalledWith(409);
  });
});

describe("POST /api/server/wipe fails closed when detection can't confirm the server is stopped", () => {
  it("refuses the wipe instead of assuming the server is stopped", async () => {
    const serverManager = {
      loadConfig: async () => {},
      reloadConfig: async () => {},
      getServerProcessDetails: async () => ({
        running: false,
        scanFailed: true,
      }),
      savePath: null,
      serverName: "servertest",
    };

    const handler = getWipeHandler();
    const response = createResponse();
    await handler(
      {
        app: { get: () => serverManager },
        body: { targets: ["map"], confirm: true },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
    );
  });
});

describe("POST /api/server/steam-update fails closed when detection can't confirm the server is stopped", () => {
  const baseRequest = (serverManager) => ({
    app: { get: (key) => (key === "serverManager" ? serverManager : undefined) },
    body: { steamcmdPath: "/opt/steamcmd", installPath: "/opt/pzserver" },
  });

  it("refuses the update when scanFailed is true, instead of assuming the server is stopped", async () => {
    const serverManager = {
      getServerProcessDetails: async () => ({
        running: false,
        scanFailed: true,
      }),
    };

    const handler = getSteamUpdateHandler();
    const response = createResponse();
    await handler(baseRequest(serverManager), response);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
    );
  });

  it("refuses the update when the detection call throws, instead of continuing anyway", async () => {
    const serverManager = {
      getServerProcessDetails: async () => {
        throw new Error("ps failed");
      },
    };

    const handler = getSteamUpdateHandler();
    const response = createResponse();
    await handler(baseRequest(serverManager), response);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
    );
  });
});
