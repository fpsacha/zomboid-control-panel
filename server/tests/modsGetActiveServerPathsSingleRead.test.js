import { describe, expect, it, vi } from "vitest";

// split-derivation sweep, 2026-09-07 (same class as /wipe's pre-fix bug,
// 5c2e73e9): mods.js used to have getServerConfigPath(), getServerName()
// and getServerPath() as three separate functions, each making its own
// getActiveServer() call. ~26 handlers in this file need two or three of
// these values together (write-to-ini, save-order, batch-remove, etc.) --
// a concurrent setActiveServer() landing between two or three separate
// awaited calls could produce e.g. serverConfigPath from server A mixed
// with serverName from server B, matching neither server's real INI.
//
// This test FORCES that exact interleaving rather than hoping for it: the
// mocked getActiveServer() returns server A on its first call and server B
// on any subsequent call, modeling "a concurrent request switched the
// active server between reads." A test that merely calls
// getActiveServerPaths() once and checks the happy path proves nothing --
// the pre-fix code would also pass that. What discriminates is whether
// getActiveServer() was called ONCE and whether all three derived values
// name server A specifically, not some mix of A and B.

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn(async () => null),
  getActiveServer: vi.fn(),
  getTrackedMods: vi.fn(async () => []),
}));

const { getActiveServerPaths } = await import("../routes/mods.js");
const { getActiveServer } = await import("../database/init.js");

const SERVER_A = {
  serverConfigPath: "/data/serverA/Server",
  serverName: "serverA",
  installPath: "/install/serverA",
};
const SERVER_B = {
  serverConfigPath: "/data/serverB/Server",
  serverName: "serverB",
  installPath: "/install/serverB",
};

describe("mods.js getActiveServerPaths() reads the active server exactly once", () => {
  it("does not observe a concurrent active-server switch across configPath/name/path derivation", async () => {
    let calls = 0;
    getActiveServer.mockImplementation(async () => {
      calls += 1;
      // First read sees server A. A concurrent switch lands immediately
      // after -- if the code still called getActiveServer() 2-3 times, a
      // later call would observe server B instead.
      return calls === 1 ? SERVER_A : SERVER_B;
    });

    const { serverConfigPath, serverName, serverPath } = await getActiveServerPaths();

    expect(getActiveServer).toHaveBeenCalledTimes(1);
    // All three values must name the SAME server -- server A, the one
    // observed by the single read -- never a mix of A and B.
    expect(serverConfigPath).toBe(SERVER_A.serverConfigPath);
    expect(serverName).toBe(SERVER_A.serverName);
    expect(serverPath).toBe(SERVER_A.installPath);
  });

  it("falls back to legacy settings independently when the active server provides none of the three fields", async () => {
    getActiveServer.mockResolvedValue(null);
    const { getSetting } = await import("../database/init.js");
    getSetting.mockImplementation(async (key) => {
      if (key === "serverConfigPath") return "/legacy/Server";
      if (key === "serverName") return "legacy-name";
      if (key === "serverPath") return "/legacy/install";
      return null;
    });

    const { serverConfigPath, serverName, serverPath } = await getActiveServerPaths();

    expect(serverConfigPath).toBe("/legacy/Server");
    expect(serverName).toBe("legacy-name");
    expect(serverPath).toBe("/legacy/install");
  });

  it("falls back configPath to zomboidDataPath + Server when serverConfigPath itself is not set", async () => {
    getActiveServer.mockResolvedValue({
      zomboidDataPath: "/data/serverA",
      serverName: "serverA",
      installPath: "/install/serverA",
    });

    const { serverConfigPath } = await getActiveServerPaths();

    expect(serverConfigPath).toMatch(/[/\\]data[/\\]serverA[/\\]Server$/);
  });
});
