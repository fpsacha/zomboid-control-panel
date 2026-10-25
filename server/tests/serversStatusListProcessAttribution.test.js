import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression coverage for GET /api/servers/status (the multi-server list
// page's running/stopped badges). Two independent bugs lived here together,
// both found by tracing where this route's process-identity answer could
// diverge from serverManager.js's own answer about the same host:
//
// 1. This route used to reuse serverManager.getServerProcessDetails()
//    (the ACTIVE server's own scan result -- already filtered down to
//    processes attributed to THAT server, capped to 3 entries, cmd
//    truncated to 240 chars) as the candidate list for judging EVERY
//    configured server, active or not. On a host running more than one
//    configured server, a genuinely running NON-active server's process
//    was invisible to this list -- it was never in the active server's own
//    filtered `matched` -- so it rendered "stopped" while actually running.
// 2. The per-server match itself was a bare String.includes() on the
//    normalized install path, with no path-boundary check -- so a
//    genuinely stopped server named e.g. "MyServer" would render as
//    "running" merely because a sibling server "MyServer2" (a real,
//    different install) was the one actually running, since
//    ".../MyServer2/..." contains ".../MyServer" as a raw substring.
//
// The fix: scan the whole host (ServerManager.scanHostForServerProcesses(),
// unfiltered by any one server) and attribute each candidate to a specific
// configured server via the same scoreServerProcessOwnership() rules
// serverManager.js's own detection uses (-servername/-cachedir first,
// install path only as a boundary-safe fallback).

const getServers = vi.fn();
const getActiveServer = vi.fn();

vi.mock("../database/init.js", () => ({
  getServers,
  getActiveServer,
}));

const scanHostForServerProcesses = vi.fn();

vi.mock("../services/serverManager.js", async () => {
  const actual = await vi.importActual("../services/serverManager.js");
  return {
    ...actual,
    ServerManager: vi.fn().mockImplementation(function () {
      this.scanHostForServerProcesses = scanHostForServerProcesses;
    }),
  };
});

// Real implementation unless a test swaps in its own managed lifecycle.
const createLinuxServiceLifecycle = vi.fn();
vi.mock("../services/linuxServiceLifecycle.js", async () => {
  const actual = await vi.importActual("../services/linuxServiceLifecycle.js");
  createLinuxServiceLifecycle.mockImplementation(actual.createLinuxServiceLifecycle);
  return { ...actual, createLinuxServiceLifecycle };
});

// What Docker says about a container-run server; real unless a test sets it.
const resolveDockerHostSignal = vi.fn();
vi.mock("../services/managedContainer.js", async () => {
  const actual = await vi.importActual("../services/managedContainer.js");
  resolveDockerHostSignal.mockImplementation(actual.resolveDockerHostSignal);
  return { ...actual, resolveDockerHostSignal };
});

const { default: router } = await import("../routes/servers.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getStatusHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/status" && entry.route.methods.get,
  );
  return layer.route.stack[0].handle;
}

function fakeApp(overrides = {}) {
  const services = { serverManager: { isRunning: false }, ...overrides };
  return { get: (key) => services[key] };
}

describe("GET /api/servers/status", () => {
  beforeEach(() => {
    getServers.mockReset();
    getActiveServer.mockReset().mockResolvedValue({ id: 1 });
    scanHostForServerProcesses.mockReset();
  });

  // The game runs in a container of its own, which the panel's process scan
  // can't see: Docker's answer is the row's, as for the active server.
  it("reads a container-run server's state from Docker", async () => {
    getServers.mockResolvedValue([
      { id: 1, name: "Active", installPath: "C:\\Servers\\Active" },
      { id: 2, name: "Boxed", dockerContainerName: "pz-boxed" },
      { id: 3, name: "Unreachable", dockerContainerName: "pz-gone" },
    ]);
    scanHostForServerProcesses.mockResolvedValue({ matched: [] });
    resolveDockerHostSignal.mockImplementation(async (server) =>
      server.id === 2
        ? { running: true, scanFailed: false, startedAt: "2026-10-25T10:00:00.123456789Z" }
        : { running: false, scanFailed: true },
    );
    const response = createResponse();

    await getStatusHandler()({ app: fakeApp() }, response);

    const rows = response.json.mock.calls[0][0].servers;
    expect(rows.find((s) => s.id === 2)).toMatchObject({
      running: true,
      stateUnknown: false,
      provider: "docker-local",
      startedAt: "2026-10-25T10:00:00.123Z",
    });
    expect(rows.find((s) => s.id === 3)).toMatchObject({ running: false, stateUnknown: true });
  });

  it("reports a genuinely running NON-active server as running, not just the active one", async () => {
    getServers.mockResolvedValue([
      { id: 1, name: "Active", installPath: "C:\\Servers\\Active" },
      { id: 2, name: "Other", installPath: "C:\\Servers\\Other" },
    ]);
    getActiveServer.mockResolvedValue({ id: 1 });
    // Only the NON-active server actually has a live process -- the active
    // server's own configured install has nothing running.
    scanHostForServerProcesses.mockResolvedValue({
      matched: [{ pid: "222", cmd: '"C:\\Servers\\Other\\java.exe" -cp pz.jar zombie.network.GameServer' }],
    });
    const response = createResponse();

    await getStatusHandler()({ app: fakeApp() }, response);

    const payload = response.json.mock.calls[0][0];
    const other = payload.servers.find((s) => s.id === 2);
    expect(other.running).toBe(true);
    expect(other.pid).toBe("222");
    const active = payload.servers.find((s) => s.id === 1);
    expect(active.running).toBe(false);
  });

  it("does not report a stopped server as running just because a sibling install shares its name as a prefix", async () => {
    getServers.mockResolvedValue([
      { id: 1, name: "MyServer", installPath: "C:\\Servers\\MyServer" },
      { id: 2, name: "MyServer2", installPath: "C:\\Servers\\MyServer2" },
    ]);
    getActiveServer.mockResolvedValue({ id: 2 });
    // Only MyServer2 is actually running.
    scanHostForServerProcesses.mockResolvedValue({
      matched: [{ pid: "333", cmd: '"C:\\Servers\\MyServer2\\java.exe" -cp pz.jar zombie.network.GameServer' }],
    });
    const response = createResponse();

    await getStatusHandler()({ app: fakeApp() }, response);

    const payload = response.json.mock.calls[0][0];
    expect(payload.servers.find((s) => s.id === 1).running).toBe(false);
    expect(payload.servers.find((s) => s.id === 2).running).toBe(true);
  });

  it("still uses -servername to disambiguate two servers whose install paths are unrelated", async () => {
    getServers.mockResolvedValue([
      { id: 1, name: "A", serverName: "ServerA", installPath: "C:\\pz\\a" },
      { id: 2, name: "B", serverName: "ServerB", installPath: "C:\\pz\\b" },
    ]);
    getActiveServer.mockResolvedValue({ id: 1 });
    scanHostForServerProcesses.mockResolvedValue({
      matched: [
        { pid: "111", cmd: 'java zombie.network.GameServer -servername "ServerA" -cachedir="C:\\Zomboid\\A"' },
      ],
    });
    const response = createResponse();

    await getStatusHandler()({ app: fakeApp() }, response);

    const payload = response.json.mock.calls[0][0];
    expect(payload.servers.find((s) => s.id === 1).running).toBe(true);
    expect(payload.servers.find((s) => s.id === 2).running).toBe(false);
  });

  // Review finding (2026-10-02): Windows can also list processes whose
  // command line the panel may not read; a server none of the readable
  // ones belongs to may be one of them, so it isn't confidently "stopped".
  it("marks a server with no process of its own unknown when the scan also lists processes it can't read", async () => {
    getServers.mockResolvedValue([
      { id: 1, name: "A", serverName: "ServerA", installPath: "C:\\pz\\a" },
      { id: 2, name: "B", serverName: "ServerB", installPath: "C:\\pz\\b" },
    ]);
    getActiveServer.mockResolvedValue({ id: 1 });
    scanHostForServerProcesses.mockResolvedValue({
      running: true,
      matched: [
        { pid: "111", cmd: 'java zombie.network.GameServer -servername "ServerA" -cachedir="C:\\Zomboid\\A"' },
      ],
      unreadable: [{ pid: "7000", startedMs: 1790964741863 }],
    });
    const response = createResponse();

    await getStatusHandler()({ app: fakeApp() }, response);

    const payload = response.json.mock.calls[0][0];
    expect(payload.servers.find((s) => s.id === 1)).toMatchObject({ running: true, stateUnknown: false });
    expect(payload.servers.find((s) => s.id === 2)).toMatchObject({ running: false, stateUnknown: true });
  });
});

// is-running-enumeration sweep, 2026-09-08: the active server's own
// grace-window fallback (below the host-wide scan, for a stock launch with
// no -servername/-cachedir the scan above can't attribute) used to read
// serverManager.isRunning directly -- a cached field with no bound on its
// own age. Servers.tsx's waitForActionState() polls this exact endpoint to
// confirm both Start and Stop, so a stale-true cached flag broke both
// directions. Fixed by calling serverManager.getServerProcessDetails()
// fresh instead of reading the field, giving this fallback the same
// scanFailed-style "don't know yet" signal (surfaced here as stateUnknown)
// every other convention-A site already has.
describe("GET /api/servers/status -- active-server fallback freshness", () => {
  beforeEach(() => {
    getServers.mockReset();
    getActiveServer.mockReset().mockResolvedValue({ id: 1 });
    scanHostForServerProcesses.mockReset();
  });

  it("confirms the active server running via a FRESH scan when the host-wide scan can't attribute it (stock launch, no identifying args)", async () => {
    getServers.mockResolvedValue([
      { id: 1, name: "Active", installPath: "C:\\Servers\\Active" },
    ]);
    getActiveServer.mockResolvedValue({ id: 1 });
    // Host-wide scan finds nothing it can attribute to server 1 at all.
    scanHostForServerProcesses.mockResolvedValue({ matched: [] });
    const getServerProcessDetails = vi.fn().mockResolvedValue({ running: true, scanFailed: false });
    const response = createResponse();

    await getStatusHandler()(
      { app: fakeApp({ serverManager: { getServerProcessDetails } }) },
      response,
    );

    expect(getServerProcessDetails).toHaveBeenCalledTimes(1);
    const payload = response.json.mock.calls[0][0];
    const active = payload.servers.find((s) => s.id === 1);
    expect(active.running).toBe(true);
    expect(active.stateUnknown).toBe(false);
  });

  it("does NOT force the active server running off a real stop -- a fresh scan reporting running:false is trusted, not overridden", async () => {
    getServers.mockResolvedValue([
      { id: 1, name: "Active", installPath: "C:\\Servers\\Active" },
    ]);
    getActiveServer.mockResolvedValue({ id: 1 });
    scanHostForServerProcesses.mockResolvedValue({ matched: [] });
    // The server genuinely stopped -- a fresh scan confirms no process.
    const getServerProcessDetails = vi.fn().mockResolvedValue({ running: false, scanFailed: false });
    const response = createResponse();

    await getStatusHandler()(
      { app: fakeApp({ serverManager: { getServerProcessDetails } }) },
      response,
    );

    const payload = response.json.mock.calls[0][0];
    expect(payload.servers.find((s) => s.id === 1).running).toBe(false);
  });

  it("reports stateUnknown, not a confident guess, when the fallback's own fresh scan fails", async () => {
    getServers.mockResolvedValue([
      { id: 1, name: "Active", installPath: "C:\\Servers\\Active" },
    ]);
    getActiveServer.mockResolvedValue({ id: 1 });
    scanHostForServerProcesses.mockResolvedValue({ matched: [] });
    const getServerProcessDetails = vi.fn().mockResolvedValue({ running: false, scanFailed: true });
    const response = createResponse();

    await getStatusHandler()(
      { app: fakeApp({ serverManager: { getServerProcessDetails } }) },
      response,
    );

    const payload = response.json.mock.calls[0][0];
    const active = payload.servers.find((s) => s.id === 1);
    expect(active.running).toBe(false);
    expect(active.stateUnknown).toBe(true);
  });

  it("only applies the grace window to the active server's own row, never to a non-active sibling", async () => {
    getServers.mockResolvedValue([
      { id: 1, name: "Active", installPath: "C:\\Servers\\Active" },
      { id: 2, name: "Other", installPath: "C:\\Servers\\Other" },
    ]);
    getActiveServer.mockResolvedValue({ id: 1 });
    scanHostForServerProcesses.mockResolvedValue({ matched: [] });
    const getServerProcessDetails = vi.fn().mockResolvedValue({ running: true, scanFailed: false });
    const response = createResponse();

    await getStatusHandler()(
      { app: fakeApp({ serverManager: { getServerProcessDetails } }) },
      response,
    );

    // Called exactly once -- only for server 1 (active), never for server 2.
    expect(getServerProcessDetails).toHaveBeenCalledTimes(1);
    const payload = response.json.mock.calls[0][0];
    expect(payload.servers.find((s) => s.id === 1).running).toBe(true);
    expect(payload.servers.find((s) => s.id === 2).running).toBe(false);
  });
});

// Managed Servers cards show each running server's uptime, so every row
// carries the start time of the process it was attributed -- asked through
// the SAME serverManager.startTimeOf() the dashboard's own status uses, so
// the two can't disagree. Unknown is null, never a guess.
describe("GET /api/servers/status -- per-server start time", () => {
  beforeEach(() => {
    getServers.mockReset();
    getActiveServer.mockReset().mockResolvedValue({ id: 1 });
    scanHostForServerProcesses.mockReset();
  });

  it("reports each running row's start time for the process it was attributed, and none for a stopped row", async () => {
    getServers.mockResolvedValue([
      { id: 1, name: "Active", installPath: "C:\\Servers\\Active" },
      { id: 2, name: "Other", installPath: "C:\\Servers\\Other" },
    ]);
    // On Windows the scan row itself carries the start time, so the whole
    // row goes to startTimeOf(), not just its pid.
    const row = {
      pid: "222",
      cmd: '"C:\\Servers\\Other\\java.exe" -cp pz.jar zombie.network.GameServer',
      startedMs: Date.UTC(2026, 8, 27, 7, 0, 0),
    };
    scanHostForServerProcesses.mockResolvedValue({ matched: [row] });
    const startTimeOf = vi.fn(async (entry) => entry.startedMs);
    const getServerProcessDetails = vi.fn(async () => ({ running: false, scanFailed: false }));
    const response = createResponse();

    await getStatusHandler()(
      { app: fakeApp({ serverManager: { getServerProcessDetails, startTimeOf } }) },
      response,
    );

    const payload = response.json.mock.calls[0][0];
    expect(startTimeOf).toHaveBeenCalledTimes(1);
    expect(startTimeOf).toHaveBeenCalledWith(row);
    expect(payload.servers.find((s) => s.id === 2).startedAt).toBe("2026-09-27T07:00:00.000Z");
    expect(payload.servers.find((s) => s.id === 1).startedAt).toBeNull();
    // This host's clock as it answered, for the client's skew correction.
    expect(payload.serverTime).toEqual(expect.any(Number));
  });

  it("reports null when the OS can't say", async () => {
    getServers.mockResolvedValue([{ id: 2, name: "Other", installPath: "C:\\Servers\\Other" }]);
    scanHostForServerProcesses.mockResolvedValue({
      matched: [{ pid: "222", cmd: '"C:\\Servers\\Other\\java.exe" -cp pz.jar zombie.network.GameServer' }],
    });
    const response = createResponse();

    await getStatusHandler()(
      { app: fakeApp({ serverManager: { startTimeOf: async () => null } }) },
      response,
    );

    const row = response.json.mock.calls[0][0].servers[0];
    expect(row.running).toBe(true);
    expect(row.startedAt).toBeNull();
  });

  it("asks about a systemd-managed row's MainPID -- it has no scanned PID", async () => {
    getServers.mockResolvedValue([
      { id: 3, name: "Managed", installPath: "/opt/pz", lifecycleProvider: "systemd" },
    ]);
    getActiveServer.mockResolvedValue({ id: 3 });
    scanHostForServerProcesses.mockResolvedValue({ matched: [] });
    createLinuxServiceLifecycle.mockReturnValueOnce({
      status: async () => ({ running: true, scanFailed: false, activeState: "active", mainPid: "31337" }),
    });
    const startTimeOf = vi.fn(async () => Date.UTC(2026, 8, 27, 7, 0, 0));
    const response = createResponse();

    await getStatusHandler()(
      { app: fakeApp({ serverManager: { startTimeOf } }) },
      response,
    );

    const row = response.json.mock.calls[0][0].servers[0];
    expect(startTimeOf).toHaveBeenCalledWith({ pid: "31337" });
    expect(row).toMatchObject({ running: true, pid: null, startedAt: "2026-09-27T07:00:00.000Z" });
  });
});
