import { describe, expect, it, vi } from "vitest";

// split-derivation sweep, 2026-09-07 (same class as /wipe's pre-fix bug,
// 5c2e73e9): server.js used to have getServerConfigPath() and
// getServerName() as two SEPARATE functions, each making its own
// getActiveServer() call. Both call sites in this file need both values --
// a concurrent setActiveServer() landing between the two calls could
// produce serverConfigPath from server A and serverName from server B.
//
// This test FORCES that exact interleaving rather than hoping for it: the
// mocked getActiveServer() returns server A on its first call and server B
// on any subsequent call, modeling "a concurrent request switched the
// active server between two reads." A test that merely calls
// getActiveServerPaths() once and checks the happy path proves nothing --
// the pre-fix code would also pass that. What actually discriminates is
// whether getActiveServer() was called ONCE (proving there is no window for
// a second call to observe a different server) and whether both derived
// values name server A specifically, not a mix of A and B.

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn(async () => null),
  getActiveServer: vi.fn(),
}));

const { getActiveServerPaths } = await import("../routes/server.js");
const { getActiveServer } = await import("../database/init.js");

const SERVER_A = { serverConfigPath: "/data/serverA/Server", serverName: "serverA" };
const SERVER_B = { serverConfigPath: "/data/serverB/Server", serverName: "serverB" };

describe("getActiveServerPaths() reads the active server exactly once", () => {
  it("does not observe a concurrent active-server switch between deriving configPath and name", async () => {
    let calls = 0;
    getActiveServer.mockImplementation(async () => {
      calls += 1;
      // First read sees server A (the request's own view of "the active
      // server" at the moment it started). A concurrent switch lands
      // immediately after -- if the code were still calling
      // getActiveServer() twice, the SECOND call would observe server B.
      return calls === 1 ? SERVER_A : SERVER_B;
    });

    const { serverConfigPath, serverName } = await getActiveServerPaths();

    expect(getActiveServer).toHaveBeenCalledTimes(1);
    // Both values must name the SAME server -- server A, the one observed
    // by the single read -- never a mix of A's configPath and B's name.
    expect(serverConfigPath).toBe(SERVER_A.serverConfigPath);
    expect(serverName).toBe(SERVER_A.serverName);
  });

  it("falls back to legacy settings independently when the active server provides neither field", async () => {
    getActiveServer.mockResolvedValue(null);
    const { getSetting } = await import("../database/init.js");
    getSetting.mockImplementation(async (key) => {
      if (key === "serverConfigPath") return "/legacy/Server";
      if (key === "serverName") return "legacy-name";
      return null;
    });

    const { serverConfigPath, serverName } = await getActiveServerPaths();

    expect(serverConfigPath).toBe("/legacy/Server");
    expect(serverName).toBe("legacy-name");
  });
});
