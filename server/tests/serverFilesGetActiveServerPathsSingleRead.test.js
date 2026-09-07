import { describe, expect, it, vi } from "vitest";

// split-derivation sweep, 2026-09-07 (same class as /wipe's pre-fix bug,
// 5c2e73e9): serverFiles.js had getServerConfigPath() and getServerName()
// as two separate functions, each making its own getActiveServer() call.
// 17 call sites in this file (PUT /ini, GET/PUT /sandbox, /spawnpoints,
// /spawnregions, /raw/:type, POST /templates, persistSandboxValues(), etc.)
// need both values together -- a concurrent setActiveServer() landing
// between the two separate awaited calls could produce e.g.
// serverConfigPath from server A + serverName from server B.
//
// getServerConfigPath()/getServerName() themselves are kept byte-identical
// (getServerConfigPath()'s own remote branch depends on getServerName()
// internally, and eagerly deriving both for every caller would change the
// router.use() gate's behavior for a local server with a fine configPath
// but no configured name). getActiveServerPaths() is a NEW function used
// only by the 17 multi-call sites, replicating both originals' exact
// fallback/throw behavior from a single read.
//
// This test FORCES the interleaving rather than hoping for it: the mocked
// getActiveServer() returns server A on its first call and server B on any
// subsequent call, modeling a concurrent switch. A test that merely calls
// getActiveServerPaths() once and checks the happy path proves nothing --
// the pre-fix code (two separate functions) would also pass that.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getAllSettings: vi.fn(async () => ({})),
}));

vi.mock("../services/remoteConfigFiles.js", () => ({
  SFTP_CONFIG_PATH_KEY: "panelBridgeSftpConfigPath",
  acquireMirrorLock: vi.fn(),
  beginRemoteConfigSession: vi.fn(),
  getMirrorPath: vi.fn(),
  isRemoteConfigConfigured: vi.fn(() => false),
  pushRemoteConfigFiles: vi.fn(),
  validateRemoteConfigTransport: vi.fn(),
}));

const { getActiveServerPaths } = await import("../routes/serverFiles.js");
const { getActiveServer } = await import("../database/init.js");

const SERVER_A = {
  serverConfigPath: "/data/serverA/Server",
  serverName: "serverA",
};
const SERVER_B = {
  serverConfigPath: "/data/serverB/Server",
  serverName: "serverB",
};

describe("serverFiles.js getActiveServerPaths() reads the active server exactly once", () => {
  it("does not observe a concurrent active-server switch across configPath/name derivation", async () => {
    let calls = 0;
    getActiveServer.mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? SERVER_A : SERVER_B;
    });

    const { serverConfigPath, serverName } = await getActiveServerPaths();

    expect(getActiveServer).toHaveBeenCalledTimes(1);
    expect(serverConfigPath).toBe(SERVER_A.serverConfigPath);
    expect(serverName).toBe(SERVER_A.serverName);
  });

  it("rejects an invalid server name the same way getServerName() does", async () => {
    getActiveServer.mockResolvedValue({
      serverConfigPath: "/data/serverA/Server",
      serverName: "../escape",
    });

    await expect(getActiveServerPaths()).rejects.toThrow(
      "Configured server name contains invalid path characters",
    );
  });

  it("throws ServerNotConfiguredError when no server name is available anywhere", async () => {
    getActiveServer.mockResolvedValue({ serverConfigPath: "/data/serverA/Server" });
    const { getAllSettings } = await import("../database/init.js");
    getAllSettings.mockResolvedValue({});

    await expect(getActiveServerPaths()).rejects.toMatchObject({
      code: "SERVER_NOT_CONFIGURED",
    });
  });
});
