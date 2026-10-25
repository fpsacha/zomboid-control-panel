import { describe, expect, it, vi } from "vitest";
import {
  CRASH_RESTART_LIMIT,
  PANEL_STOP_WINDOW_MS,
  ServerWatch,
  restartOnCrashChosen,
} from "../services/serverWatch.js";

// The status watchdog follows the active server only. A server started
// alongside it -- the boot auto-start's others, or one started from the
// Dashboard's list -- went down unnoticed, and nothing started it again. The
// server watch reads every server's state from GET /servers/status's scan:
// a stop the panel didn't make is recorded under that server, pushed to the
// Dashboard, and, for a server in restartOnCrashServerIds, followed by a
// restart. Each case drives the watch's own tick() with injected state.

function setup({
  servers = [
    { id: "active", name: "Main" },
    { id: "s2", name: "Second" },
  ],
  activeId = "active",
  chosen = ["s2"],
  covers = () => false,
  stopped = true,
  restartResult = { success: true },
} = {}) {
  const state = { rows: [], servers, activeId, chosen, stopped };
  const deps = {
    readStatuses: vi.fn(async () => state.rows),
    getServers: vi.fn(async () => state.servers),
    getActiveServer: vi.fn(async () =>
      state.activeId === null ? null : state.servers.find((s) => s.id === state.activeId),
    ),
    getSetting: vi.fn(async (key) => (key === "restartOnCrashServerIds" ? state.chosen : undefined)),
    restartServer: vi.fn(async () => restartResult),
    isStopped: vi.fn(async () => state.stopped),
    logEvent: vi.fn(async () => {}),
    emit: vi.fn(),
    activityCovers: vi.fn(covers),
    now: () => 1_000_000,
    sleep: vi.fn(async () => {}),
  };
  const watch = new ServerWatch(deps);
  const look = async (rows) => {
    state.rows = rows;
    await watch.tick();
    await watch.lastRestart;
  };
  return { watch, deps, state, look };
}

const row = (id, running, extra = {}) => ({ id, running, stateUnknown: false, ...extra });

describe("restartOnCrashChosen()", () => {
  it("matches an id in the list, numeric or not, and nothing without a list", () => {
    expect(restartOnCrashChosen(["a", "7"], 7)).toBe(true);
    expect(restartOnCrashChosen(["a"], "b")).toBe(false);
    expect(restartOnCrashChosen(undefined, "a")).toBe(false);
    expect(restartOnCrashChosen(["a"], null)).toBe(false);
  });
});

describe("ServerWatch.tick()", () => {
  it("takes the first look at a server as where it stands, not as a change", async () => {
    const { deps, look } = setup();
    await look([row("s2", false)]);

    expect(deps.emit).not.toHaveBeenCalled();
    expect(deps.logEvent).not.toHaveBeenCalled();
    expect(deps.restartServer).not.toHaveBeenCalled();
  });

  it("records a stop the panel didn't make under that server and starts a chosen server again", async () => {
    const { deps, look } = setup();
    await look([row("s2", true)]);
    await look([row("s2", false)]);

    expect(deps.emit).toHaveBeenCalledWith({ serverId: "s2", running: false });
    expect(deps.logEvent).toHaveBeenCalledWith(
      "server_stop",
      expect.stringContaining("Second stopped without the panel asking"),
      "s2",
    );
    // After its delay, and only once the server is confirmed still down.
    expect(deps.sleep).toHaveBeenCalled();
    expect(deps.isStopped).toHaveBeenCalledWith(expect.objectContaining({ id: "s2" }), { isActive: false });
    expect(deps.restartServer).toHaveBeenCalledWith(expect.objectContaining({ id: "s2" }), { isActive: false });
    expect(deps.logEvent).toHaveBeenCalledWith("crash_restart", expect.any(String), "s2");
  });

  it("records the stop but leaves a server that isn't chosen down", async () => {
    const { deps, look } = setup({ chosen: [] });
    await look([row("s2", true)]);
    await look([row("s2", false)]);

    expect(deps.logEvent).toHaveBeenCalledWith("server_stop", expect.any(String), "s2");
    expect(deps.restartServer).not.toHaveBeenCalled();
  });

  it("leaves a stop the panel made alone: no event, no restart, just the push", async () => {
    const { deps, look } = setup({ covers: () => true });
    await look([row("s2", true)]);
    await look([row("s2", false)]);

    expect(deps.activityCovers).toHaveBeenCalledWith("s2", PANEL_STOP_WINDOW_MS, 1_000_000);
    expect(deps.emit).toHaveBeenCalledWith({ serverId: "s2", running: false });
    expect(deps.logEvent).not.toHaveBeenCalled();
    expect(deps.restartServer).not.toHaveBeenCalled();
  });

  it("pushes a start too, and records nothing for it", async () => {
    const { deps, look } = setup();
    await look([row("s2", false)]);
    await look([row("s2", true)]);

    expect(deps.emit).toHaveBeenCalledWith({ serverId: "s2", running: true });
    expect(deps.logEvent).not.toHaveBeenCalled();
  });

  it("keeps the last confident state through a scan that can't answer", async () => {
    const { deps, look } = setup();
    await look([row("s2", true)]);
    await look([row("s2", false, { stateUnknown: true })]);
    expect(deps.emit).not.toHaveBeenCalled();

    await look([row("s2", false)]);
    expect(deps.emit).toHaveBeenCalledWith({ serverId: "s2", running: false });
  });

  it("leaves the active server to the status watchdog, and a remote server to its host", async () => {
    const { deps, look } = setup({
      servers: [
        { id: "active", name: "Main" },
        { id: "far", name: "Far", isRemote: true },
      ],
    });
    await look([row("active", true), row("far", true)]);
    await look([row("active", false), row("far", false)]);

    expect(deps.emit).not.toHaveBeenCalled();
  });

  it("doesn't scan at all with no server to watch", async () => {
    const { deps, look } = setup({ servers: [{ id: "active", name: "Main" }] });
    await look([]);

    expect(deps.readStatuses).not.toHaveBeenCalled();
  });

  it("starts over for a server that was the active one in between", async () => {
    const { deps, state, look } = setup();
    await look([row("s2", true)]);
    state.activeId = "s2";
    await look([row("s2", true)]);
    state.activeId = "active";
    // Stopped while it was active: a first look again, not a change.
    await look([row("s2", false)]);

    expect(deps.emit).not.toHaveBeenCalled();
  });

  it("doesn't restart a server that is up again by the time its delay ends", async () => {
    const { deps, look } = setup({ stopped: false });
    await look([row("s2", true)]);
    await look([row("s2", false)]);

    expect(deps.restartServer).not.toHaveBeenCalled();
  });

  it("doesn't restart a server it can't confirm is still down", async () => {
    const { deps, look } = setup({ stopped: null });
    await look([row("s2", true)]);
    await look([row("s2", false)]);

    expect(deps.restartServer).not.toHaveBeenCalled();
  });

  it(`leaves a server that keeps going down after ${CRASH_RESTART_LIMIT} restarts`, async () => {
    const { deps, look } = setup();
    for (let i = 0; i < CRASH_RESTART_LIMIT + 1; i += 1) {
      await look([row("s2", true)]);
      await look([row("s2", false)]);
    }

    expect(deps.restartServer).toHaveBeenCalledTimes(CRASH_RESTART_LIMIT);
    expect(deps.logEvent).toHaveBeenCalledWith("crash_restart_gave_up", expect.any(String), "s2");
  });

  // Two servers that go down together: the second one's restart is refused
  // while the first one's runs (one restart at a time, the lifecycle lock).
  it("waits out another server's restart, then starts it", async () => {
    const { deps, look } = setup();
    deps.restartServer
      .mockResolvedValueOnce({ success: false, busy: true, message: "Restart already in progress" })
      .mockResolvedValueOnce({ success: false, code: "SERVER_LIFECYCLE_IN_PROGRESS", error: "busy" })
      .mockResolvedValueOnce({ success: true });
    await look([row("s2", true)]);
    await look([row("s2", false)]);

    expect(deps.restartServer).toHaveBeenCalledTimes(3);
    expect(deps.logEvent.mock.calls.filter(([type]) => type === "crash_restart")).toHaveLength(1);
    expect(deps.logEvent).not.toHaveBeenCalledWith("crash_restart_error", expect.any(String), "s2");
  });

  it("gives up on a restart the panel stays too busy for, and says so", async () => {
    const { watch, deps, look } = setup({
      restartResult: { success: false, busy: true, message: "Restart already in progress" },
    });
    let clock = 0;
    watch.now = () => clock;
    deps.sleep.mockImplementation(async (ms) => {
      clock += ms;
    });
    await look([row("s2", true)]);
    await look([row("s2", false)]);

    expect(deps.logEvent).toHaveBeenCalledWith(
      "crash_restart_error",
      expect.stringContaining("busy"),
      "s2",
    );
  });

  it("leaves a server down when restart-if-down is unticked during the wait", async () => {
    const { deps, state, look } = setup();
    deps.sleep.mockImplementation(async () => {
      state.chosen = [];
    });
    await look([row("s2", true)]);
    await look([row("s2", false)]);

    expect(deps.restartServer).not.toHaveBeenCalled();
  });

  it("records a restart that failed", async () => {
    const { deps, look } = setup({ restartResult: { success: false, message: "port in use" } });
    await look([row("s2", true)]);
    await look([row("s2", false)]);

    expect(deps.logEvent).toHaveBeenCalledWith(
      "crash_restart_error",
      expect.stringContaining("port in use"),
      "s2",
    );
  });
});

describe("ServerWatch.onActiveServerStopped()", () => {
  async function stop(options, event) {
    const { watch, deps } = setup(options);
    await watch.onActiveServerStopped(event);
    await watch.lastRestart;
    return deps;
  }

  it("starts a chosen active server again after a crash or an unexplained stop", async () => {
    for (const reason of ["crash", "unknown"]) {
      const deps = await stop({ chosen: ["active"] }, { serverId: "active", reason });
      expect(deps.restartServer).toHaveBeenCalledWith(expect.objectContaining({ id: "active" }), { isActive: true });
    }
  });

  it("leaves a stop or restart the panel made alone", async () => {
    for (const reason of ["stop", "restart"]) {
      const deps = await stop({ chosen: ["active"] }, { serverId: "active", reason });
      expect(deps.restartServer).not.toHaveBeenCalled();
    }
  });

  it("leaves it down while a panel operation accounts for the stop, or when it isn't chosen", async () => {
    expect(
      (await stop({ chosen: ["active"], covers: () => true }, { serverId: "active", reason: "unknown" }))
        .restartServer,
    ).not.toHaveBeenCalled();
    expect(
      (await stop({ chosen: [] }, { serverId: "active", reason: "crash" })).restartServer,
    ).not.toHaveBeenCalled();
  });
});
