import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getServer, connect, save, disconnect } = vi.hoisted(() => ({
  getServer: vi.fn(),
  connect: vi.fn(),
  save: vi.fn(),
  disconnect: vi.fn(),
}));

import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// docker.js now gates with requirePermission("docker.manage") (DB-backed
// capability lookup) instead of requireRole -- getRoleByName needs mocking
// alongside getServer. The old hand-rolled requireRole mock (admin-only) is
// gone: docker.js doesn't import from services/auth.js at all anymore.
vi.mock("../database/init.js", () => ({ getServer, getRoleByName: mockGetRoleByName }));
vi.mock("../services/rcon.js", () => ({
  RconService: class {
    connected = false;
    async loadConfig() {}
    async connect() {
      this.connected = await connect();
      return this.connected;
    }
    save = save;
    disconnect = disconnect;
  },
}));

const { default: router } = await import("../routes/docker.js");
const { acquireLifecycleLock, lifecycleInProgressResponse } = await import(
  "../services/lifecycleCoordinator.js"
);

beforeEach(() => {
  getServer.mockReset();
  connect.mockReset();
  save.mockReset();
  disconnect.mockReset();
  disconnect.mockResolvedValue(undefined);
});

afterEach(() => {
  // Best-effort: don't let a failed assertion mid-test leak a stuck lock
  // into a later test in this file or another (real, unmocked
  // lifecycleCoordinator -- same convention as the other *LifecycleLock
  // test files).
  const stray = acquireLifecycleLock("test-cleanup");
  if (stray) stray.release();
});

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function runRoute(routePath, method, request, response) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const handlers = layer.route.stack.map((entry) => entry.handle);
  let index = -1;
  const next = async (error) => {
    index += 1;
    if (error) throw error;
    if (index < handlers.length) await handlers[index](request, response, next);
  };
  await next();
}

describe("GET /api/docker/status", () => {
  it("rejects non-admin callers", async () => {
    const response = createResponse();
    const listManagedContainers = vi.fn();

    await runRoute("/status", "get",
      { user: { role: "viewer" }, app: { get: () => ({ enabled: true, listManagedContainers }) } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(listManagedContainers).not.toHaveBeenCalled();
  });

  it("reports only the managed containers supplied by the client", async () => {
    const response = createResponse();
    await runRoute("/status", "get",
      {
        user: { role: "admin" },
        app: {
          get: () => ({
            enabled: true,
            available: true,
            listManagedContainers: vi.fn(async () => [{
              Id: "managed-id",
              Names: ["/pz-managed"],
              Image: "custom/pz",
              State: "running",
              Status: "Up 2 minutes",
            }]),
          }),
        },
      },
      response,
    );

    expect(response.json).toHaveBeenCalledWith({
      enabled: true,
      available: true,
      containers: [{
        id: "managed-id",
        name: "pz-managed",
        image: "custom/pz",
        state: "running",
        status: "Up 2 minutes",
      }],
    });
  });
});

describe("POST /api/docker/containers/:id/:action", () => {
  it("rejects a non-admin caller before invoking Docker", async () => {
    const response = createResponse();
    const runManagedAction = vi.fn();

    await runRoute("/containers/:id/:action", "post", {
      user: { role: "viewer" },
      params: { id: "managed", action: "restart" },
      app: { get: () => ({ enabled: true, available: true, runManagedAction }) },
    }, response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(runManagedAction).not.toHaveBeenCalled();
  });

  it("only runs an action through the managed-container client", async () => {
    const response = createResponse();
    const runManagedAction = vi.fn(async () => ({ success: true }));
    const inspectManagedContainer = vi.fn(async () => ({ State: { Running: true } }));
    getServer.mockResolvedValue({ id: "server-1", dockerContainerName: "managed" });
    connect.mockResolvedValue(true);
    save.mockResolvedValue({ success: true });

    await runRoute("/containers/:id/:action", "post", {
      user: { role: "admin" },
      params: { id: "managed", action: "restart" },
      body: { serverId: "server-1" },
      app: { get: () => ({ enabled: true, available: true, inspectManagedContainer, runManagedAction }) },
    }, response);

    expect(runManagedAction).toHaveBeenCalledWith("managed", "restart");
    expect(response.json).toHaveBeenCalledWith({ success: true });
  });

  it("does not stop a container when the world save fails", async () => {
    const response = createResponse();
    const runManagedAction = vi.fn();
    const inspectManagedContainer = vi.fn(async () => ({ State: { Running: true } }));
    getServer.mockResolvedValue({ id: "server-1", dockerContainerName: "managed" });
    connect.mockResolvedValue(true);
    save.mockResolvedValue({ success: false, error: "timeout" });

    await runRoute("/containers/:id/:action", "post", {
      user: { role: "admin" },
      params: { id: "managed", action: "stop" },
      body: { serverId: "server-1" },
      app: { get: () => ({ enabled: true, available: true, inspectManagedContainer, runManagedAction }) },
    }, response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(runManagedAction).not.toHaveBeenCalled();
  });

  it("restarts a stopped managed container without requiring RCON", async () => {
    const response = createResponse();
    const runManagedAction = vi.fn(async () => ({ success: true }));
    getServer.mockResolvedValue({ id: "server-1", dockerContainerName: "managed" });

    await runRoute("/containers/:id/:action", "post", {
      user: { role: "admin" },
      params: { id: "managed", action: "restart" },
      body: { serverId: "server-1" },
      app: { get: () => ({
        enabled: true,
        available: true,
        inspectManagedContainer: vi.fn(async () => ({ State: { Running: false } })),
        runManagedAction,
      }) },
    }, response);

    expect(connect).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(runManagedAction).toHaveBeenCalledWith("managed", "restart");
  });

  // normalize-lifecycle-lock-server-identifier, 2026-09-08: this route used
  // to acquire the lock with req.params.id -- the Docker CONTAINER id
  // ("managed" below), a third, unrelated namespace from the server DB id
  // every other lock call site standardizes on. Fixed to use
  // req.body.serverId (verified against this exact container a few lines
  // above the lock's own guard, but read for the lock before that
  // verification runs -- see the route's own comment). Proven here by
  // reading the held lock's own refusal message: it must name the server id
  // ("server-1"), never the container id ("managed").
  it("acquires the lock with the request's server DB id (req.body.serverId), not the Docker container id (req.params.id)", async () => {
    const response = createResponse();
    let releaseAction;
    let actionEntered;
    const actionReached = new Promise((r) => {
      actionEntered = r;
    });
    const runManagedAction = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseAction = () => resolve({ success: true });
          actionEntered();
        }),
    );
    getServer.mockResolvedValue({ id: "server-1", dockerContainerName: "managed" });

    const handlerCall = runRoute("/containers/:id/:action", "post", {
      user: { role: "admin" },
      params: { id: "managed", action: "restart" },
      body: { serverId: "server-1" },
      app: { get: () => ({
        enabled: true,
        available: true,
        inspectManagedContainer: vi.fn(async () => ({ State: { Running: false } })),
        runManagedAction,
      }) },
    }, response);

    await actionReached;
    const message = lifecycleInProgressResponse().error;
    expect(message).toContain("server-1");
    expect(message).not.toContain("managed");

    releaseAction();
    await handlerCall;
  });

  // wrapper-bypass class sweep, 2026-09-08: the route used to call
  // inspectManagedContainer() directly and treat ANY null as "not managed"
  // -- a transient Docker API failure and a genuine unlabeled container both
  // produced the identical response, so an operator hitting a daemon hiccup
  // was told to fix a mapping that was never broken. dockerClient.lastError
  // (set by inspectManagedContainer itself, mirroring listManagedContainers'
  // existing convention) now distinguishes them.
  it("reports 'could not verify' (503, retry-worthy) rather than 'not managed' when the inspect call itself failed", async () => {
    const response = createResponse();
    const runManagedAction = vi.fn();
    getServer.mockResolvedValue({ id: "server-1", dockerContainerName: "managed" });
    const dockerClient = {
      enabled: true,
      available: true,
      lastError: null,
      inspectManagedContainer: vi.fn(async () => {
        dockerClient.lastError = "socket hang up";
        return null;
      }),
      runManagedAction,
    };

    await runRoute("/containers/:id/:action", "post", {
      user: { role: "admin" },
      params: { id: "managed", action: "restart" },
      body: { serverId: "server-1" },
      app: { get: () => dockerClient },
    }, response);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
    );
    expect(runManagedAction).not.toHaveBeenCalled();
  });

  it("still reports 'not managed' (403) when the inspect call succeeds but the container isn't labeled", async () => {
    const response = createResponse();
    const runManagedAction = vi.fn();
    getServer.mockResolvedValue({ id: "server-1", dockerContainerName: "managed" });
    const dockerClient = {
      enabled: true,
      available: true,
      lastError: null,
      inspectManagedContainer: vi.fn(async () => {
        dockerClient.lastError = null;
        return null;
      }),
      runManagedAction,
    };

    await runRoute("/containers/:id/:action", "post", {
      user: { role: "admin" },
      params: { id: "managed", action: "restart" },
      body: { serverId: "server-1" },
      app: { get: () => dockerClient },
    }, response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "CONTAINER_NOT_MANAGED" }),
    );
    expect(runManagedAction).not.toHaveBeenCalled();
  });

  it("passes through the real Docker error instead of a generic message, with any path redacted", async () => {
    const response = createResponse();
    const runManagedAction = vi.fn(async () => ({
      success: false,
      error: "connect EACCES /var/run/docker.sock",
    }));
    getServer.mockResolvedValue({ id: "server-1", dockerContainerName: "managed" });

    await runRoute("/containers/:id/:action", "post", {
      user: { role: "admin" },
      params: { id: "managed", action: "start" },
      body: { serverId: "server-1" },
      app: { get: () => ({
        enabled: true,
        available: true,
        inspectManagedContainer: vi.fn(async () => ({ State: { Running: false } })),
        runManagedAction,
      }) },
    }, response);

    expect(response.status).toHaveBeenCalledWith(403);
    const payload = response.json.mock.calls[0][0];
    expect(payload.error).toMatch(/EACCES/);
    expect(payload.error).not.toContain("/var/run/docker.sock");
  });
});

describe("GET /api/docker/stats", () => {
  it("samples only managed containers returned by the Docker client", async () => {
    const response = createResponse();
    const getContainerStats = vi.fn(async () => ({ cpuPercent: 12.5 }));

    await runRoute("/stats", "get", {
      user: { role: "admin" },
      app: {
        get: () => ({
          enabled: true,
          available: true,
          listManagedContainers: vi.fn(async () => [{ Id: "managed", Names: ["/managed"] }]),
          getContainerStats,
        }),
      },
    }, response);

    expect(getContainerStats).toHaveBeenCalledWith("managed");
    expect(response.json).toHaveBeenCalledWith({
      containers: {
        managed: { cpuPercent: 12.5 },
      },
    });
  });
});
