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
});
