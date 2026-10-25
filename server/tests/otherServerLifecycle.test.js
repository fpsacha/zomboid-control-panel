import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, deleteServer } from "../database/init.js";
import {
  resolveOtherServer,
  restartOtherServer,
  startOtherServer,
  stopOtherServer,
} from "../services/otherServerLifecycle.js";

// Start, Stop and Restart for a server other than the active one, from the
// Dashboard's list of servers: the Dashboard's own controls reach the active
// server only, so running several meant switching to each one first. These
// go through the server's own ServerManager and RCON connection, with the
// Dashboard's rules -- the lifecycle lock, a save before a stop, a kill a
// minute after a quit that never finished, Docker for a managed container.

const { default: serversRouter } = await import("../routes/servers.js");

const server = { id: "s2", name: "Second", serverName: "Second" };

function fakeLock() {
  const lock = { release: vi.fn() };
  return { lock, acquireLock: vi.fn(() => lock) };
}

function fakeManager(states) {
  const queue = [...states];
  return {
    getServerProcessDetails: vi.fn(async () => {
      const state = queue.length > 1 ? queue.shift() : queue[0];
      return state === "unknown" ? { running: false, scanFailed: true } : { running: state === "running", scanFailed: false };
    }),
    startServer: vi.fn(async () => ({ success: true, message: "Server starting" })),
    stopServer: vi.fn(async () => ({ success: true })),
    usesManagedServiceLifecycle: () => false,
  };
}

function fakeRcon({ connects = true, saves = true } = {}) {
  const rcon = {
    connected: false,
    connect: vi.fn(async () => {
      if (connects) rcon.connected = true;
      else throw new Error("ECONNREFUSED");
    }),
    save: vi.fn(async () => (saves ? { success: true } : { success: false, error: "save timed out" })),
    quit: vi.fn(async () => ({ success: true })),
    disconnect: vi.fn(async () => {
      rcon.connected = false;
    }),
  };
  return rcon;
}

// A clock each sleep moves a second, so the waits run out without waiting.
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: vi.fn(async (ms) => { t += ms; }) };
}

const notManaged = vi.fn(async () => ({ handled: false }));

async function settle() {
  for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("resolveOtherServer()", () => {
  const find = (record) => ({ findServer: async () => record, findActiveServer: async () => ({ id: "active" }) });

  it("finds the server", async () => {
    expect(await resolveOtherServer("s2", find(server))).toEqual({ server });
  });

  it("refuses a server that doesn't exist", async () => {
    const { refused } = await resolveOtherServer("nope", find(null));
    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe("SERVER_PROFILE_NOT_FOUND");
  });

  it("sends the active server to the Dashboard's own controls", async () => {
    const { refused } = await resolveOtherServer("active", find({ id: "active", name: "Main" }));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "SERVERS_ACTION_ACTIVE_SERVER", params: { name: "Main" } });
  });

  it("refuses a remote server", async () => {
    const { refused } = await resolveOtherServer("far", find({ id: "far", name: "Far", isRemote: true }));
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: "SERVERS_ACTION_REMOTE_REFUSED", params: { name: "Far" } });
  });
});

describe("startOtherServer()", () => {
  it("launches it through a ServerManager of its own and holds the lock until its process shows up", async () => {
    const { lock, acquireLock } = fakeLock();
    const manager = fakeManager(["stopped", "stopped", "running"]);
    const onSettled = vi.fn();
    const logEvent = vi.fn();

    const outcome = await startOtherServer(server, {
      createManager: async (id) => (id === "s2" ? manager : null),
      acquireLock, runManaged: notManaged, logEvent, onSettled, ...fakeClock(),
    });

    expect(outcome).toMatchObject({ status: 200, body: { success: true } });
    expect(acquireLock).toHaveBeenCalledWith("start", "s2");
    expect(manager.startServer).toHaveBeenCalledWith({ serverId: "s2" });
    expect(logEvent).toHaveBeenCalledWith("server_start", "Second started via web UI", { serverId: "s2" });
    await settle();
    expect(lock.release).toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalled();
  });

  it("leaves a running server alone", async () => {
    const { lock, acquireLock } = fakeLock();
    const manager = fakeManager(["running"]);
    const outcome = await startOtherServer(server, {
      createManager: async () => manager, acquireLock, runManaged: notManaged, logEvent: vi.fn(),
    });

    expect(outcome.body).toEqual({ success: true, alreadyRunning: true });
    expect(manager.startServer).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalled();
  });

  it("does nothing when the scan can't say whether it runs", async () => {
    const { lock, acquireLock } = fakeLock();
    const manager = fakeManager(["unknown"]);
    const outcome = await startOtherServer(server, {
      createManager: async () => manager, acquireLock, runManaged: notManaged, logEvent: vi.fn(),
    });

    expect(outcome.status).toBe(409);
    expect(outcome.body.code).toBe("SERVERS_ACTION_STATE_UNKNOWN");
    expect(manager.startServer).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalled();
  });

  it("answers 409 while another lifecycle operation holds the lock", async () => {
    const outcome = await startOtherServer(server, { acquireLock: () => null });
    expect(outcome.status).toBe(409);
    expect(outcome.body.code).toBe("SERVER_LIFECYCLE_IN_PROGRESS");
  });

  it("starts a Docker-managed server through Docker", async () => {
    const { acquireLock } = fakeLock();
    const manager = fakeManager(["stopped"]);
    const runManaged = vi.fn(async () => ({ handled: true, success: true, message: "Container starting" }));
    const outcome = await startOtherServer(server, {
      createManager: async () => manager, acquireLock, runManaged, logEvent: vi.fn(),
    });

    expect(runManaged).toHaveBeenCalledWith("start", { serverId: "s2" });
    expect(manager.startServer).not.toHaveBeenCalled();
    expect(outcome.body).toMatchObject({ success: true, message: "Container starting" });
  });

  it("refuses a server that never started and has no admin password, as the Dashboard's Start does", async () => {
    const { acquireLock } = fakeLock();
    const manager = fakeManager(["stopped"]);
    const fresh = { ...server, zomboidDataPath: "/nonexistent/zomboid-data-for-this-test", adminPassword: "" };
    const outcome = await startOtherServer(fresh, {
      createManager: async () => manager, acquireLock, runManaged: notManaged, logEvent: vi.fn(),
    });

    expect(outcome.status).toBe(400);
    expect(outcome.body).toMatchObject({ code: "SERVERS_START_ADMIN_PASSWORD_MISSING", params: { name: "Second" } });
    expect(manager.startServer).not.toHaveBeenCalled();
  });
});

describe("stopOtherServer()", () => {
  it("saves over its own RCON connection, quits, and holds the lock until the process is gone", async () => {
    const { lock, acquireLock } = fakeLock();
    const manager = fakeManager(["running", "running", "stopped"]);
    const rcon = fakeRcon();
    const onSettled = vi.fn();

    const outcome = await stopOtherServer(server, {
      createManager: async () => manager, createRcon: async (id) => (id === "s2" ? rcon : null),
      acquireLock, runManaged: notManaged, logEvent: vi.fn(), onSettled, ...fakeClock(),
    });

    expect(outcome).toMatchObject({ status: 200, body: { success: true, confirmed: false } });
    expect(rcon.save).toHaveBeenCalledBefore(rcon.quit);
    expect(rcon.disconnect).toHaveBeenCalled();
    await settle();
    expect(manager.stopServer).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalled();
  });

  it("kills it when it is still up a minute after the quit", async () => {
    const { lock, acquireLock } = fakeLock();
    const manager = fakeManager(["running"]);
    const outcome = await stopOtherServer(server, {
      createManager: async () => manager, createRcon: async () => fakeRcon(),
      acquireLock, runManaged: notManaged, logEvent: vi.fn(), ...fakeClock(),
    });

    expect(outcome.status).toBe(200);
    await settle();
    expect(manager.stopServer).toHaveBeenCalledWith({ serverId: "s2" });
    expect(lock.release).toHaveBeenCalled();
  });

  it("stops nothing when RCON doesn't answer", async () => {
    const { lock, acquireLock } = fakeLock();
    const manager = fakeManager(["running"]);
    const rcon = fakeRcon({ connects: false });
    const outcome = await stopOtherServer(server, {
      createManager: async () => manager, createRcon: async () => rcon,
      acquireLock, runManaged: notManaged, logEvent: vi.fn(),
    });

    expect(outcome.status).toBe(400);
    expect(outcome.body).toMatchObject({ code: "SERVERS_STOP_RCON_UNAVAILABLE", params: { name: "Second" } });
    expect(rcon.quit).not.toHaveBeenCalled();
    expect(manager.stopServer).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalled();
  });

  it("leaves it running when the save fails", async () => {
    const { acquireLock } = fakeLock();
    const rcon = fakeRcon({ saves: false });
    const outcome = await stopOtherServer(server, {
      createManager: async () => fakeManager(["running"]), createRcon: async () => rcon,
      acquireLock, runManaged: notManaged, logEvent: vi.fn(),
    });

    expect(outcome.status).toBe(502);
    expect(outcome.body).toMatchObject({
      code: "SERVERS_STOP_SAVE_FAILED",
      params: { name: "Second", reason: "save timed out" },
    });
    expect(rcon.quit).not.toHaveBeenCalled();
  });

  it("answers at once for a server that is already down", async () => {
    const createRcon = vi.fn();
    const outcome = await stopOtherServer(server, {
      createManager: async () => fakeManager(["stopped"]), createRcon,
      acquireLock: fakeLock().acquireLock, runManaged: notManaged, logEvent: vi.fn(),
    });

    expect(outcome.body).toEqual({ success: true, alreadyStopped: true });
    expect(createRcon).not.toHaveBeenCalled();
  });

  it("stops a Docker-managed server through Docker after the save", async () => {
    const rcon = fakeRcon();
    const runManaged = vi.fn(async () => ({ handled: true, success: true }));
    const outcome = await stopOtherServer(server, {
      createManager: async () => fakeManager(["running"]), createRcon: async () => rcon,
      acquireLock: fakeLock().acquireLock, runManaged, logEvent: vi.fn(),
    });

    expect(rcon.save).toHaveBeenCalled();
    expect(runManaged).toHaveBeenCalledWith("stop", { serverId: "s2" });
    expect(rcon.quit).not.toHaveBeenCalled();
    expect(outcome.body).toEqual({ success: true, confirmed: true });
  });

  // The game runs in another container: the panel's process scan never
  // sees it, and Stop used to answer "already stopped" for a running one.
  it("asks Docker, not the process scan, whether a container's server runs", async () => {
    const containerServer = { ...server, dockerContainerName: "pz-second" };
    const rcon = fakeRcon();
    const runManaged = vi.fn(async () => ({ handled: true, success: true }));
    const dockerSignal = vi.fn(async () => ({ running: true, scanFailed: false }));
    const outcome = await stopOtherServer(containerServer, {
      createManager: async () => fakeManager(["stopped"]), createRcon: async () => rcon,
      acquireLock: fakeLock().acquireLock, runManaged, dockerSignal, logEvent: vi.fn(),
    });

    expect(dockerSignal).toHaveBeenCalledWith(containerServer);
    expect(runManaged).toHaveBeenCalledWith("stop", { serverId: "s2" });
    expect(outcome.body).toEqual({ success: true, confirmed: true });

    const started = await startOtherServer(containerServer, {
      createManager: async () => fakeManager(["stopped"]),
      acquireLock: fakeLock().acquireLock,
      runManaged,
      dockerSignal: vi.fn(async () => ({ running: true, scanFailed: false })),
      logEvent: vi.fn(),
    });
    expect(started.body).toEqual({ success: true, alreadyRunning: true });
  });
});

describe("restartOtherServer()", () => {
  it("runs the scheduler's restart against the server's own connections and reports the outcome", async () => {
    const { lock, acquireLock } = fakeLock();
    const rcon = fakeRcon();
    const manager = fakeManager(["running"]);
    const scheduler = { restartInProgress: false, performRestart: vi.fn(async () => ({ success: true, message: "done" })) };
    const onResult = vi.fn();

    const outcome = await restartOtherServer(server, {
      scheduler, warningMinutes: 2, createManager: async () => manager, createRcon: async () => rcon,
      acquireLock, onResult,
    });

    expect(outcome.body).toMatchObject({ success: true, message: expect.stringContaining("2 minute") });
    expect(scheduler.performRestart).toHaveBeenCalledWith(2, {
      rconService: rcon, serverManager: manager, label: "Manual restart", lifecycleLock: lock,
    });
    await settle();
    expect(onResult).toHaveBeenCalledWith({ success: true, message: "done" });
    expect(lock.release).toHaveBeenCalled();
  });

  it("passes on a coded failure the restart throws", async () => {
    const error = Object.assign(new Error("script missing"), { code: "SERVER_RESTART_SCRIPT_MISSING", params: { script: "x" } });
    const scheduler = { restartInProgress: false, performRestart: vi.fn(async () => { throw error; }) };
    const onResult = vi.fn();
    await restartOtherServer(server, {
      scheduler, createManager: async () => fakeManager(["running"]), createRcon: async () => fakeRcon(),
      acquireLock: fakeLock().acquireLock, onResult,
    });
    await settle();

    expect(onResult).toHaveBeenCalledWith({
      success: false, message: "script missing", code: "SERVER_RESTART_SCRIPT_MISSING", params: { script: "x" },
    });
  });

  it("answers 409 while a restart is already running", async () => {
    const { lock, acquireLock } = fakeLock();
    const scheduler = { restartInProgress: true, performRestart: vi.fn() };
    const outcome = await restartOtherServer(server, { scheduler, acquireLock });

    expect(outcome.status).toBe(409);
    expect(scheduler.performRestart).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalled();
  });
});

describe("POST /api/servers/:id/start|stop|restart", () => {
  const created = [];
  afterEach(async () => {
    for (const id of created.splice(0)) await deleteServer(id).catch(() => {});
  });

  function handlerFor(path) {
    const layer = serversRouter.stack.find((entry) => entry.route?.path === path && entry.route.methods.post);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }

  async function post(path, id) {
    let statusCode = 200;
    let body = null;
    const res = {
      status(code) { statusCode = code; return res; },
      json(payload) { body = payload; return res; },
    };
    await handlerFor(path)({ params: { id }, body: {}, app: { get: () => undefined } }, res);
    return { statusCode, body };
  }

  it("refuses a remote server, and a server that doesn't exist, on every action", async () => {
    // A local one first: the first server created becomes the active one.
    const local = await createServer({ name: "OtherLocal", serverName: "OtherLocal" });
    const remote = await createServer({ name: "OtherRemote", serverName: "OtherRemote", isRemote: true });
    created.push(local.id, remote.id);

    for (const path of ["/:id/start", "/:id/stop", "/:id/restart"]) {
      const far = await post(path, String(remote.id));
      expect(far.statusCode).toBe(400);
      expect(far.body.code).toBe("SERVERS_ACTION_REMOTE_REFUSED");

      const missing = await post(path, "no-such-server");
      expect(missing.statusCode).toBe(404);
    }
  });
});
