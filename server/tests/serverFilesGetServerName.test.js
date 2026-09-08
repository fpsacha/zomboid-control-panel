import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

const getActiveServer = vi.fn();
const getAllSettings = vi.fn();
const isRemoteConfigConfigured = vi.fn();
const validateRemoteConfigTransport = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings,
}));

vi.mock("../services/remoteConfigFiles.js", () => ({
  SFTP_CONFIG_PATH_KEY: "panelBridgeSftpConfigPath",
  acquireMirrorLock: vi.fn(),
  beginRemoteConfigSession: vi.fn(),
  getMirrorPath: (transport, serverName) => `/mirror/${serverName}`,
  isRemoteConfigConfigured,
  pushRemoteConfigFiles: vi.fn(),
  validateRemoteConfigTransport,
}));

const {
  __testOnlyDirectReads,
  ServerNotConfiguredError,
  RemoteConfigNotConfiguredError,
  parseIni,
  toIni,
} = await import("../routes/serverFiles.js");
// getServerName()/getServerConfigPath() are no longer exported directly
// (2026-09-08 quadruple-read sweep -- every real caller now reads
// req.activeServerContext, populated once per request by the router's own
// gate) -- __testOnlyDirectReads is the explicit, test-only back door that
// keeps this file's existing isolated-fallback-chain coverage working
// without re-deriving it through a full router request.
const { getServerName, getServerConfigPath } = __testOnlyDirectReads;

// Finding 2: serverName is interpolated straight into filesystem paths
// (`${serverName}.ini`, `${serverName}_SandboxVars.lua`, ...) throughout
// serverFiles.js. A serverName containing "../" must never reach those
// path.join() calls.
describe("getServerName (Finding 2: path traversal via serverName)", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
  });

  it("returns the active server's serverName unchanged when it is safe", async () => {
    getActiveServer.mockResolvedValue({ serverName: "MyServer" });
    await expect(getServerName()).resolves.toBe("MyServer");
  });

  it("throws instead of returning a traversal payload from the active server", async () => {
    getActiveServer.mockResolvedValue({ serverName: "../../etc/passwd" });
    await expect(getServerName()).rejects.toThrow(/invalid path characters/i);
  });

  it("throws instead of returning a traversal payload from legacy settings", async () => {
    getActiveServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({ serverName: "../../secrets" });
    await expect(getServerName()).rejects.toThrow(/invalid path characters/i);
  });

  it("falls back to legacy settings.serverName when there is no active server", async () => {
    getActiveServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({ serverName: "LegacyServer" });
    await expect(getServerName()).resolves.toBe("LegacyServer");
  });

  it("throws ServerNotConfiguredError instead of inventing 'servertest' when nothing is configured", async () => {
    getActiveServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({});
    await expect(getServerName()).rejects.toThrow(ServerNotConfiguredError);
  });
});

// The panel used to invent a fully-populated "servertest" server pointing at
// ~/Zomboid/Server (Project Zomboid's own default install location) whenever
// nothing had actually been configured through Server Setup / My Servers. On
// a machine that happens to have a real PZ install at that vanilla path, the
// panel presented ITS real data as the panel's own "active server" -- data
// the panel has no record of ever being told about.
describe("getServerConfigPath (no server configured must not invent one)", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    isRemoteConfigConfigured.mockReset().mockReturnValue(false);
    validateRemoteConfigTransport.mockReset();
  });

  it("throws ServerNotConfiguredError rather than defaulting to ~/Zomboid/Server when nothing is configured", async () => {
    getActiveServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({});
    await expect(getServerConfigPath()).rejects.toThrow(ServerNotConfiguredError);
  });

  it("throws even when an active server row exists but has no path anywhere and no legacy fallback either", async () => {
    // A server that is "configured" in name only (e.g. a corrupt/partial
    // profile) is exactly as unresolvable as no server at all -- there is
    // still nothing real to point at.
    getActiveServer.mockResolvedValue({ id: "1", serverName: "Ghost" });
    getAllSettings.mockResolvedValue({});
    await expect(getServerConfigPath()).rejects.toThrow(ServerNotConfiguredError);
  });

  // The bug was the fall-through PAST "nothing configured" to a default --
  // not the legacy-settings fallback chain itself, which real upgrades from
  // older installs depend on. Every tier of that chain must keep resolving
  // exactly as before.
  it("resolves the active server's explicit serverConfigPath when set", async () => {
    getActiveServer.mockResolvedValue({ serverConfigPath: "/srv/pz/Server" });
    getAllSettings.mockResolvedValue({});
    await expect(getServerConfigPath()).resolves.toBe("/srv/pz/Server");
  });

  it("falls back to the active server's zomboidDataPath + Server when no explicit config path is set", async () => {
    getActiveServer.mockResolvedValue({ zomboidDataPath: "/data/zomboid" });
    getAllSettings.mockResolvedValue({});
    const result = await getServerConfigPath();
    expect(result).toBe(path.join("/data/zomboid", "Server"));
  });

  it("falls back to legacy settings.serverConfigPath when there is no active server", async () => {
    getActiveServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({ serverConfigPath: "/legacy/Server" });
    await expect(getServerConfigPath()).resolves.toBe("/legacy/Server");
  });

  it("falls back to legacy settings.zomboidDataPath + Server when there is no active server", async () => {
    getActiveServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({ zomboidDataPath: "/legacy/zomboid" });
    const result = await getServerConfigPath();
    expect(result).toBe(path.join("/legacy/zomboid", "Server"));
  });
});

// Finding (quality-pass 2026-08-31, Angela): a remote server whose SFTP
// transport isn't configured yet fell all the way through getServerConfigPath()
// to the generic ServerNotConfiguredError -- the SAME 404 a genuinely
// unconfigured panel gets -- even though the router's second gate
// (serverFiles.js's remote-mirror middleware) has its own correct
// REMOTE_CONFIG_NOT_CONFIGURED 400 response for exactly this case. That gate
// could never run: this function's own fallthrough already answered first.
describe("getServerConfigPath (remote server, SFTP transport not configured)", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    isRemoteConfigConfigured.mockReset().mockReturnValue(false);
    validateRemoteConfigTransport.mockReset();
  });

  it("throws RemoteConfigNotConfiguredError, not ServerNotConfiguredError, when the server is remote and no local/legacy path exists either", async () => {
    getActiveServer.mockResolvedValue({ id: "1", serverName: "Ashenwood", isRemote: true });
    await expect(getServerConfigPath()).rejects.toThrow(RemoteConfigNotConfiguredError);
    await expect(getServerConfigPath()).rejects.not.toThrow(ServerNotConfiguredError);
  });

  it("still resolves the mirror path when the remote transport IS configured (unaffected by the fix)", async () => {
    getActiveServer.mockResolvedValue({ id: "1", serverName: "Ashenwood", isRemote: true });
    isRemoteConfigConfigured.mockReturnValue(true);
    validateRemoteConfigTransport.mockReturnValue({ host: "pz.example.net" });
    await expect(getServerConfigPath()).resolves.toBe("/mirror/Ashenwood");
  });

  it("still falls back to the active server's own serverConfigPath for a remote row that happens to have one (fallback chain unchanged, only the final error type changed)", async () => {
    getActiveServer.mockResolvedValue({
      id: "1",
      serverName: "Ashenwood",
      isRemote: true,
      serverConfigPath: "/legacy-local/Server",
    });
    await expect(getServerConfigPath()).resolves.toBe("/legacy-local/Server");
  });
});

describe("INI round-trip helpers", () => {
  it("writes a changed value back to the same key while preserving comments", () => {
    const original = "; server config\nMinutesPerPage=2\nPublic=true\n";
    const settings = { ...parseIni(original), MinutesPerPage: "3" };
    const written = toIni(settings, original);

    expect(written).toContain("; server config");
    expect(parseIni(written).MinutesPerPage).toBe("3");
    expect(parseIni(written).Public).toBe("true");
  });

  it("does not add empty values for keys absent from a new INI", () => {
    const written = toIni({ MinutesPerPage: "", Public: "true" });

    expect(written).toBe("Public=true");
  });
});
