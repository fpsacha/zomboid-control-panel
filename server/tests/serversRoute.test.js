import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const createServer = vi.fn();
const updateServer = vi.fn();
const getServers = vi.fn();
const getSetting = vi.fn();
const getAllSettings = vi.fn();
const testRconConnection = vi.fn();

import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

vi.mock("../database/init.js", () => ({
  getServers,
  getSetting,
  getAllSettings,
  getServer: vi.fn(),
  getActiveServer: vi.fn(),
  createServer,
  updateServer,
  deleteServer: vi.fn(),
  setActiveServer: vi.fn(),
  getRoleByName: mockGetRoleByName,
}));

vi.mock("../services/rcon.js", () => ({
  normalizeRconHost: (host) => host.trim(),
  testRconConnection,
}));

const {
  default: router,
  parseDiscoveredPort,
  parseServerId,
} = await import("../routes/servers.js");
const { getServer, getActiveServer, deleteServer, setActiveServer } = await import("../database/init.js");
const {
  getSteamLoginArgs,
  hasSteamManifestAccessDeniedState,
} = await import(
  "../routes/server.js"
);
// Moved out of routes/server.js into its own module (hunt-wave5-2026-08-29)
// so serverManager.js can check the same tracked state before spawning the
// PZ JVM -- see services/activeSteamOperations.js's header comment.
const { isSteamOperationIdle } = await import("../services/activeSteamOperations.js");

function createResponse() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
}

function getLayer(routePath, method) {
  return router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

// POST / and PUT /:id (below) both have requirePermission("servers.manage")
// ahead of the real handler -- grab the last stack entry rather than the
// first, so this keeps working regardless of how many gating middlewares
// precede the handler. This intentionally SKIPS that gate: it's testing the
// handler's own business logic, not authorization. The stale claim that
// used to sit here ("see roles.test.js for coverage of that gate itself")
// was WRONG -- roles.test.js only ever imported routes/auth.js and
// routes/docker.js, never routes/servers.js -- so nothing tested the
// servers.manage gate on these two routes (or POST /:id/activate) at all
// until server/tests/serversManageGateCoverage.test.js was added
// (bug-hunt-2026-08-27, if-your-change-is-in-middleware-a-handler-only-
// test-is-blind-to-it): confirmed by break-verify that stripping
// requirePermission from all three routes left every test in THIS file
// green, while that dedicated file caught it immediately. See that file
// for the actual gate coverage.
function getCreateHandler() {
  const layer = getLayer("/", "post");
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getUpdateHandler() {
  const layer = getLayer("/:id", "put");
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

// Runs every middleware in a route's stack (in order), so admin-gating
// middleware like requireRole is exercised too, not just the final handler.
async function runRoute(routePath, method, req, res) {
  const layer = getLayer(routePath, method);
  const handlers = layer.route.stack.map((s) => s.handle);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
}

describe("POST /api/servers", () => {
  beforeEach(() => {
    createServer.mockReset();
    getSetting.mockReset();
    getSetting.mockResolvedValue("");
    createServer.mockResolvedValue({ id: "server-id", name: "Test Server" });
  });

  it("persists the setup admin password for first server startup", async () => {
    const response = createResponse();

    await getCreateHandler()(
      {
        body: {
          name: "Test Server",
          installPath: "C:\\PZ",
          rconHost: "127.0.0.1",
          rconPort: 27015,
          rconPassword: "rcon-password",
          adminPassword: "first-boot-password",
        },
      },
      response,
    );

    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({ adminPassword: "first-boot-password" }),
    );
    expect(response.status).toHaveBeenCalledWith(201);
  });

  it("rejects a serverName containing a path traversal sequence", async () => {
    const response = createResponse();

    await getCreateHandler()(
      {
        body: {
          name: "Test Server",
          installPath: "C:\\PZ",
          rconHost: "127.0.0.1",
          rconPort: 27015,
          rconPassword: "rcon-password",
          serverName: "../../etc/passwd",
        },
      },
      response,
    );

    expect(createServer).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
  });

  it("rejects a non-string serverName instead of converting it to text", async () => {
    const response = createResponse();

    await getUpdateHandler()(
      { params: { id: "1" }, body: { serverName: null } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(updateServer).not.toHaveBeenCalled();
  });

  it("rejects a non-string display name instead of persisting it", async () => {
    const response = createResponse();

    await getUpdateHandler()(
      { params: { id: "1" }, body: { name: { value: "Test Server" } } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(updateServer).not.toHaveBeenCalled();
  });

  it("rejects an unsafe Docker container mapping on creation", async () => {
    const response = createResponse();

    await getCreateHandler()({
      body: {
        name: "Test Server",
        installPath: "C:\\PZ",
        rconHost: "127.0.0.1",
        rconPort: 27015,
        rconPassword: "rcon-password",
        dockerContainerName: "../other-container",
      },
    }, response);

    expect(createServer).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
  });

  it("masks rconPassword in the create response", async () => {
    createServer.mockResolvedValue({
      id: "server-id",
      name: "Test Server",
      rconPassword: "rcon-password",
    });
    const response = createResponse();

    await getCreateHandler()(
      {
        body: {
          name: "Test Server",
          installPath: "C:\\PZ",
          rconHost: "127.0.0.1",
          rconPort: 27015,
          rconPassword: "rcon-password",
        },
      },
      response,
    );

    const payload = response.json.mock.calls[0][0];
    expect(payload.server.rconPassword).not.toBe("rcon-password");
  });

  it("rejects a prefixed RCON port instead of truncating it", async () => {
    const response = createResponse();

    await getCreateHandler()(
      {
        body: {
          name: "Test Server",
          installPath: "C:\\PZ",
          rconHost: "127.0.0.1",
          rconPort: "27015junk",
          rconPassword: "rcon-password",
        },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("rejects a malformed RCON host instead of defaulting to localhost", async () => {
    const response = createResponse();

    await getCreateHandler()(
      {
        body: {
          name: "Test Server",
          installPath: "C:\\PZ",
          rconHost: { host: "not-a-host" },
          rconPort: 27015,
          rconPassword: "rcon-password",
        },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("rejects string booleans instead of turning false into true", async () => {
    const response = createResponse();

    await getCreateHandler()(
      {
        body: {
          name: "Test Server",
          installPath: "C:\\PZ",
          rconHost: "127.0.0.1",
          rconPort: 27015,
          rconPassword: "rcon-password",
          useDebug: "false",
        },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("returns a client error instead of throwing on an empty request body", async () => {
    const response = createResponse();

    await getCreateHandler()({ body: null }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(createServer).not.toHaveBeenCalled();
  });
});

describe("server discovery port parsing", () => {
  it("uses defaults only when an INI port is absent", () => {
    expect(parseDiscoveredPort(undefined, 27015)).toBe(27015);
    expect(parseDiscoveredPort("  ", 16261)).toBe(16261);
  });

  it.each(["27015junk", "16261.5", "0", "65536"])(
    "rejects malformed explicit port %s",
    (value) => {
      expect(parseDiscoveredPort(value, 27015)).toBeNull();
    },
  );

  it("agrees with mountDiscovery.js's readServerIniSettings on a signed port -- the real bug this proves", async () => {
    // 2026-08-27, two-implementations-of-server-ini-parsing: on
    // "RCONPort=+27015", pre-fix parseDiscoveredPort returned 27015 (a
    // valid server) while mountDiscovery.js's parsePort -- reading the
    // exact same ini field for create-from-discovery -- rejected it,
    // because parseBoundedInteger's regex allows a leading sign and
    // parsePort's does not. This test fails on the pre-fix code (asserts
    // null, would have received 27015) and cross-checks against the real
    // readServerIniSettings function (not a copy) on a real temp ini, so
    // it can't drift back out of sync with mountDiscovery.js's actual
    // behaviour the way a hand-copied fixture could.
    expect(parseDiscoveredPort("+27015", 27015)).toBeNull();

    const { readServerIniSettings } = await import("../services/mountDiscovery.js");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "auto-scan-port-sign-"));
    try {
      const serverDir = path.join(tmpRoot, "Server");
      fs.mkdirSync(serverDir, { recursive: true });
      fs.writeFileSync(
        path.join(serverDir, "signedport.ini"),
        ["RCONPort=+27015", "RCONPassword=secret", "DefaultPort=16261", "PublicName=Test"].join("\n"),
      );
      expect(readServerIniSettings(tmpRoot, "signedport")).toBeNull();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("server ID parsing", () => {
  it("keeps opaque IDs opaque instead of truncating numeric prefixes", () => {
    expect(parseServerId("123xyz")).toBe("123xyz");
    expect(parseServerId("1.2")).toBeNull();
  });

  it("preserves legacy numeric IDs as numbers", () => {
    expect(parseServerId(" 123 ")).toBe(123);
  });
});

describe("PUT /api/servers/:id", () => {
  beforeEach(() => {
    updateServer.mockReset();
    getSetting.mockReset();
    getSetting.mockResolvedValue("");
    updateServer.mockResolvedValue({ id: 1, name: "Test Server" });
  });

  it("rejects a serverName containing a path traversal sequence", async () => {
    const response = createResponse();

    await getUpdateHandler()(
      { params: { id: "1" }, body: { serverName: "../../etc" } },
      response,
    );

    expect(updateServer).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
  });

  it("accepts a valid serverName", async () => {
    const response = createResponse();

    await getUpdateHandler()(
      { params: { id: "1" }, body: { serverName: "My-Server_2" } },
      response,
    );

    expect(updateServer).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ serverName: "My-Server_2" }),
    );
  });

  it("rejects a prefixed game port instead of truncating it", async () => {
    const response = createResponse();

    await getUpdateHandler()(
      { params: { id: "1" }, body: { serverPort: "16261junk" } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(updateServer).not.toHaveBeenCalled();
  });

  it("rejects a non-string RCON password instead of persisting it", async () => {
    const response = createResponse();

    await getUpdateHandler()(
      { params: { id: "1" }, body: { rconPassword: 12345 } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(updateServer).not.toHaveBeenCalled();
  });

  it("returns a client error instead of throwing on an empty update body", async () => {
    const response = createResponse();

    await getUpdateHandler()({ params: { id: "1" }, body: null }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(updateServer).not.toHaveBeenCalled();
  });

  it("reports when an active server profile was saved but its live manager could not reload", async () => {
    updateServer.mockResolvedValue({ id: 1, name: "Test Server", isActive: true });
    const response = createResponse();
    const serverManager = {
      reloadConfig: vi.fn(async () => {
        throw new Error("manager unavailable");
      }),
    };

    await getUpdateHandler()(
      {
        params: { id: "1" },
        body: { serverPort: 16262 },
        app: { get: (key) => (key === "serverManager" ? serverManager : undefined) },
      },
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Server updated successfully",
        warnings: [expect.stringMatching(/manager failed to reload/i)],
      }),
    );
  });

  it("reports when an active server profile reconnect returns false", async () => {
    updateServer.mockResolvedValue({ id: 1, name: "Test Server", isActive: true });
    const response = createResponse();
    const rconService = {
      isConnected: vi.fn(() => false),
      reloadConfig: vi.fn(async () => {}),
      connect: vi.fn(async () => false),
    };

    await getUpdateHandler()(
      {
        params: { id: "1" },
        body: { rconPort: 27016 },
        app: { get: (key) => (key === "rconService" ? rconService : undefined) },
      },
      response,
    );

    expect(rconService.connect).toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Server updated successfully",
        warnings: [expect.stringMatching(/could not reconnect/i)],
      }),
    );
  });

  it("persists a custom start command when updating a server", async () => {
    const response = createResponse();
    const startCommand = "start-server.sh -servername DoomerZ";

    await getUpdateHandler()(
      { params: { id: "1" }, body: { startCommand } },
      response,
    );

    expect(updateServer).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ startCommand }),
    );
  });

  it("drops a masked rconPassword instead of overwriting the stored secret", async () => {
    const response = createResponse();

    await getUpdateHandler()(
      { params: { id: "1" }, body: { rconPassword: "••••••••ab12" } },
      response,
    );

    expect(updateServer).toHaveBeenCalledWith(
      1,
      expect.not.objectContaining({ rconPassword: expect.anything() }),
    );
  });

  // 2026-08-29 backlog card savepath-needs-existence-validation-at-set-time:
  // this was the SECOND, unguarded setter for zomboidDataPath -- POST
  // /save-path (chunks.js) already required existence + directory +
  // inspectZomboidPath() for the exact same DB column via
  // resolveCustomOrDefaultDataPath(), but this route wrote it straight
  // through with zero checks. A wrong-but-structurally-valid value saved
  // here while the server is stopped could later misdirect POST /wipe
  // (server.js), which only checks fs.existsSync on
  // path.join(savePath, "Saves", "Multiplayer", serverName) -- silently
  // passing if the wrong path happens to have a matching subtree.
  describe("zomboidDataPath existence validation", () => {
    let realDataDir;
    let installLikeDir;
    let emptyDir;

    beforeEach(() => {
      getServer.mockReset();
      getServer.mockResolvedValue({ id: 1, isRemote: false });

      const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-savepath-"));
      realDataDir = path.join(root, "RealZomboidData");
      fs.mkdirSync(path.join(realDataDir, "Saves", "Multiplayer"), { recursive: true });

      installLikeDir = path.join(root, "ServerInstall");
      fs.mkdirSync(installLikeDir, { recursive: true });
      fs.writeFileSync(path.join(installLikeDir, "ProjectZomboid64.exe"), "");

      emptyDir = path.join(root, "JustSomeEmptyFolder");
      fs.mkdirSync(emptyDir, { recursive: true });
    });

    it("rejects a nonexistent zomboidDataPath instead of persisting it", async () => {
      const response = createResponse();
      const missing = path.join(os.tmpdir(), "zcp-savepath-does-not-exist-12345");

      await getUpdateHandler()(
        { params: { id: "1" }, body: { zomboidDataPath: missing } },
        response,
      );

      expect(response.status).toHaveBeenCalledWith(400);
      expect(updateServer).not.toHaveBeenCalled();
    });

    // SECURITY (2026-09-05, env-var-expansion-oracle): zomboidDataPath goes
    // through normalizeUserPath(), which expands %VAR%/${VAR}/$VAR from
    // process.env. Before the fix, the 400's error string embedded that
    // EXPANDED value -- any caller who can PUT a server (no admin needed)
    // could read a process-environment secret one request at a time via
    // zomboidDataPath="%SOME_SECRET%". The error must echo the caller's raw
    // literal instead.
    it("an env-var-shaped zomboidDataPath never echoes the EXPANDED secret back in the error", async () => {
      process.env.ZCP_TEST_LEAK_SECRET = "super-secret-value-should-not-leak";
      try {
        const response = createResponse();
        await getUpdateHandler()(
          { params: { id: "1" }, body: { zomboidDataPath: "%ZCP_TEST_LEAK_SECRET%" } },
          response,
        );

        expect(response.status).toHaveBeenCalledWith(400);
        expect(updateServer).not.toHaveBeenCalled();
        const [[body]] = response.json.mock.calls;
        expect(body.error).toContain("%ZCP_TEST_LEAK_SECRET%");
        expect(body.error).not.toContain("super-secret-value-should-not-leak");
      } finally {
        delete process.env.ZCP_TEST_LEAK_SECRET;
      }
    });

    it("rejects a real directory that does not look like a Zomboid data folder (the exact 'structurally valid but wrong' case the card describes)", async () => {
      const response = createResponse();

      await getUpdateHandler()(
        { params: { id: "1" }, body: { zomboidDataPath: emptyDir } },
        response,
      );

      expect(response.status).toHaveBeenCalledWith(400);
      expect(updateServer).not.toHaveBeenCalled();
    });

    it("rejects a server install folder pointed at by mistake, with a specific error", async () => {
      const response = createResponse();

      await getUpdateHandler()(
        { params: { id: "1" }, body: { zomboidDataPath: installLikeDir } },
        response,
      );

      expect(response.status).toHaveBeenCalledWith(400);
      expect(updateServer).not.toHaveBeenCalled();
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringMatching(/server install/i) }),
      );
    });

    it("accepts a real Zomboid data folder (has Saves/Multiplayer)", async () => {
      const response = createResponse();

      await getUpdateHandler()(
        { params: { id: "1" }, body: { zomboidDataPath: realDataDir } },
        response,
      );

      expect(updateServer).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ zomboidDataPath: path.resolve(realDataDir) }),
      );
    });

    it("skips validation entirely for a remote server (isRemote:true in the SAME request) -- a local fs check would always incorrectly fail for a path that lives on a different host", async () => {
      const response = createResponse();
      const remotePath = "/mnt/remote/does/not/exist/locally";

      await getUpdateHandler()(
        {
          params: { id: "1" },
          body: { isRemote: true, zomboidDataPath: remotePath },
        },
        response,
      );

      expect(updateServer).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ zomboidDataPath: remotePath, isRemote: true }),
      );
    });

    it("skips validation for an already-remote server even when isRemote isn't in THIS request", async () => {
      getServer.mockResolvedValue({ id: 1, isRemote: true });
      const response = createResponse();
      const remotePath = "/mnt/remote/does/not/exist/locally";

      await getUpdateHandler()(
        { params: { id: "1" }, body: { zomboidDataPath: remotePath } },
        response,
      );

      expect(updateServer).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ zomboidDataPath: remotePath }),
      );
    });

    it("still allows clearing zomboidDataPath to an empty string without validation", async () => {
      const response = createResponse();

      await getUpdateHandler()(
        { params: { id: "1" }, body: { zomboidDataPath: "" } },
        response,
      );

      expect(updateServer).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ zomboidDataPath: "" }),
      );
    });
  });
});

describe("Steam operation watchdog", () => {
  it("recognizes an operation that has stopped producing output", () => {
    const now = Date.now();

    expect(isSteamOperationIdle({ lastOutputAt: now - 9 * 60 * 1000 }, now)).toBe(false);
    expect(isSteamOperationIdle({ lastOutputAt: now - 10 * 60 * 1000 }, now)).toBe(true);
  });
});

describe("SteamCMD update login", () => {
  it("uses anonymous login instead of an account that would need interaction", async () => {
    getSetting.mockResolvedValue("configured-account");

    expect(await getSteamLoginArgs()).toEqual(["+login", "anonymous"]);
  });
});

describe("SteamCMD manifest recovery", () => {
  it("recognizes Steam's access-denied manifest state", () => {
    expect(
      hasSteamManifestAccessDeniedState('"StateFlags" "6"'),
    ).toBe(true);
    expect(
      hasSteamManifestAccessDeniedState('"StateFlags" "4"'),
    ).toBe(false);
  });
});

describe("GET /api/servers/rcon-status", () => {
  beforeEach(() => {
    getServers.mockReset();
    testRconConnection.mockReset();
  });

  it("reports per-server RCON status without exposing credentials", async () => {
    getServers.mockResolvedValue([
      { id: "one", rconHost: " 127.0.0.1 ", rconPort: 27015, rconPassword: "secret" },
      { id: "two", rconHost: "example.test", rconPort: 27016, rconPassword: "other" },
      { id: "three" },
    ]);
    testRconConnection
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: "auth_failed" });
    const response = createResponse();

    await runRoute("/rcon-status", "get", {}, response);

    expect(testRconConnection).toHaveBeenCalledWith(expect.objectContaining({
      host: "127.0.0.1",
      port: 27015,
      timeoutMs: 3000,
    }));
    expect(response.json).toHaveBeenCalledWith({
      servers: [
        { id: "one", status: "connected" },
        { id: "two", status: "auth_failed" },
        { id: "three", status: "unconfigured" },
      ],
    });
    expect(JSON.stringify(response.json.mock.calls[0][0])).not.toMatch(/secret|other/);
  });

  it("marks a malformed persisted port unavailable without failing every server status", async () => {
    getServers.mockResolvedValue([
      { id: "bad", rconHost: "127.0.0.1", rconPort: "27015junk" },
      { id: "good", rconHost: "127.0.0.1", rconPort: 27015 },
    ]);
    testRconConnection.mockResolvedValue({ success: true });
    const response = createResponse();

    await runRoute("/rcon-status", "get", {}, response);

    expect(response.json).toHaveBeenCalledWith({
      servers: [
        { id: "bad", status: "unavailable" },
        { id: "good", status: "connected" },
      ],
    });
    expect(testRconConnection).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/servers", () => {
  beforeEach(() => {
    getAllSettings.mockReset().mockResolvedValue({});
  });

  it("masks rconPassword/adminPassword for every server in the list", async () => {
    getServers.mockResolvedValue([
      { id: 1, name: "A", rconPassword: "secret-a", adminPassword: "admin-a" },
      { id: 2, name: "B", rconPassword: "secret-b" },
    ]);
    const response = createResponse();
    const layer = getLayer("/", "get");

    await layer.route.stack[0].handle({}, response);

    const payload = response.json.mock.calls[0][0];
    expect(payload.servers[0].rconPassword).not.toBe("secret-a");
    expect(payload.servers[0].adminPassword).not.toBe("admin-a");
    expect(payload.servers[1].rconPassword).not.toBe("secret-b");
  });

  // The Layout.tsx sidebar nav only ever reads remoteConfigConfigured off
  // the entry it finds in THIS list's response (see GET /active, which sets
  // the same field, is a dead end for that consumer -- nothing calls it).
  // A regression here silently re-locks Server Configuration/Templates for
  // every remote-server operator, with no error and no failed request.
  it("marks a remote server as remoteConfigConfigured when SFTP-based remote config is set up", async () => {
    getAllSettings.mockResolvedValue({
      panelBridgeSftpHost: "192.168.1.50",
      panelBridgeSftpConfigPath: "/home/pz/Server",
    });
    getServers.mockResolvedValue([
      { id: 1, name: "Remote", isRemote: true },
    ]);
    const response = createResponse();
    const layer = getLayer("/", "get");

    await layer.route.stack[0].handle({}, response);

    const payload = response.json.mock.calls[0][0];
    expect(payload.servers[0].remoteConfigConfigured).toBe(true);
  });

  it("does NOT mark a remote server as remoteConfigConfigured when SFTP is not set up", async () => {
    getServers.mockResolvedValue([
      { id: 1, name: "Remote", isRemote: true },
    ]);
    const response = createResponse();
    const layer = getLayer("/", "get");

    await layer.route.stack[0].handle({}, response);

    const payload = response.json.mock.calls[0][0];
    expect(payload.servers[0].remoteConfigConfigured).toBe(false);
  });

  it("does NOT mark a local server as remoteConfigConfigured even when SFTP is set up (unused for local servers)", async () => {
    getAllSettings.mockResolvedValue({
      panelBridgeSftpHost: "192.168.1.50",
      panelBridgeSftpConfigPath: "/home/pz/Server",
    });
    getServers.mockResolvedValue([
      { id: 1, name: "Local", isRemote: false },
    ]);
    const response = createResponse();
    const layer = getLayer("/", "get");

    await layer.route.stack[0].handle({}, response);

    const payload = response.json.mock.calls[0][0];
    expect(payload.servers[0].remoteConfigConfigured).toBe(false);
  });
});

describe("Admin-gated server discovery routes", () => {
  it("rejects POST /auto-scan for a non-admin authenticated user", async () => {
    const response = createResponse();
    await runRoute(
      "/auto-scan",
      "post",
      { body: {}, user: { role: "viewer" } },
      response,
    );
    expect(response.status).toHaveBeenCalledWith(403);
  });

  it("rejects POST /detect for a non-admin authenticated user", async () => {
    const response = createResponse();
    await runRoute(
      "/detect",
      "post",
      { body: {}, user: { role: "viewer" } },
      response,
    );
    expect(response.status).toHaveBeenCalledWith(403);
  });
});

// DELETE /:id silently reassigns which server the DATABASE calls active
// (deleteServer()'s own fallback: promote db.data.servers[0]) when the
// deleted server was active. Unlike the sibling POST /:id/activate route,
// which explicitly reloads serverManager, disconnects/reconnects RCON, and
// re-installs PanelBridge for the newly-active server, DELETE /:id used to
// do none of that -- the live in-memory services stayed pointed at the
// just-deleted server's stale config (old paths, old RCON credentials)
// until something else happened to reload them.
describe("DELETE /api/servers/:id: deleting the active server must reload live services for whichever server becomes active, same as POST /:id/activate does", () => {
  let serverManager;
  let rconService;
  let io;

  function buildReq(id, overrides = {}) {
    return {
      params: { id },
      user: { role: "admin" },
      app: {
        get: (key) => ({ serverManager, rconService, io, modChecker: null })[key],
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    getServer.mockReset();
    getActiveServer.mockReset();
    deleteServer.mockReset();
    serverManager = { reloadConfig: vi.fn(async () => {}) };
    rconService = {
      isConnected: vi.fn(() => false),
      disconnect: vi.fn(async () => {}),
      reloadConfig: vi.fn(async () => {}),
      connect: vi.fn(async () => {}),
    };
    io = { emit: vi.fn() };
  });

  it("reloads serverManager and RCON for the newly-active server after deleting the active one", async () => {
    getServer.mockResolvedValue({ id: "deleted-1", name: "Deleted", isActive: true });
    deleteServer.mockResolvedValue(true);
    getActiveServer.mockResolvedValue({
      id: "promoted-2",
      name: "Promoted",
      isActive: true,
      rconPassword: "secret",
    });

    const response = createResponse();
    await runRoute("/:id", "delete", buildReq("deleted-1"), response);

    expect(serverManager.reloadConfig).toHaveBeenCalled();
    expect(rconService.reloadConfig).toHaveBeenCalled();
    expect(rconService.connect).toHaveBeenCalled();
    // The client-facing event must carry the NEW active server, same shape
    // POST /:id/activate emits -- not the old {deleted: id}-only payload,
    // which told listeners nothing about who is active now.
    expect(io.emit).toHaveBeenCalledWith(
      "activeServerChanged",
      expect.objectContaining({ server: expect.objectContaining({ id: "promoted-2" }) }),
    );
  });

  it("does NOT reload services when the deleted server was not the active one", async () => {
    getServer.mockResolvedValue({ id: "deleted-1", name: "Deleted", isActive: false });
    deleteServer.mockResolvedValue(true);

    const response = createResponse();
    await runRoute("/:id", "delete", buildReq("deleted-1"), response);

    expect(serverManager.reloadConfig).not.toHaveBeenCalled();
    expect(rconService.reloadConfig).not.toHaveBeenCalled();
    expect(io.emit).toHaveBeenCalledWith("activeServerChanged", { deleted: "deleted-1" });
  });

  it("still succeeds (no reload attempted) when deleting the last remaining server leaves nothing active", async () => {
    getServer.mockResolvedValue({ id: "deleted-1", name: "Deleted", isActive: true });
    deleteServer.mockResolvedValue(true);
    getActiveServer.mockResolvedValue(null);

    const response = createResponse();
    await runRoute("/:id", "delete", buildReq("deleted-1"), response);

    expect(serverManager.reloadConfig).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });
});

// POST /:id/activate's HTTP response correctly runs the server record
// through sanitizeServerResponse() before res.json() -- but the Socket.IO
// broadcast a few lines earlier emitted the raw `server` object instead,
// leaking rconPassword (and any other SENSITIVE_FIELD_RE-matching field) to
// every connected socket, not just the requester. activeServerChanged is
// subscribed app-shell-wide (Layout.tsx) for every logged-in role, so a
// moderator with no servers.manage capability received an admin's plaintext
// RCON password the instant anyone else activated a server.
describe("POST /api/servers/:id/activate: the activeServerChanged broadcast must not leak credentials", () => {
  let io;

  function buildReq(id) {
    return {
      params: { id },
      user: { role: "admin" },
      app: {
        get: (key) => ({ io, modChecker: null })[key],
      },
    };
  }

  beforeEach(() => {
    setActiveServer.mockReset();
    io = { emit: vi.fn() };
  });

  it("sanitizes the server payload on the Socket.IO broadcast, not just the HTTP response", async () => {
    setActiveServer.mockResolvedValue({
      id: "1",
      name: "Active One",
      rconPassword: "top-secret",
    });

    const response = createResponse();
    await runRoute("/:id/activate", "post", buildReq("1"), response);

    expect(io.emit).toHaveBeenCalledWith(
      "activeServerChanged",
      expect.objectContaining({
        server: expect.not.objectContaining({ rconPassword: "top-secret" }),
      }),
    );
  });
});

// setActiveServer() already succeeded (the database record IS active) by
// the time reloadServicesForNewActiveServer() runs -- a failure in that
// best-effort reload must not turn a successful activation into a 500, the
// same posture DELETE /:id already has for this exact shared function (see
// that describe block above). Before this fix, POST /:id/activate called
// it unguarded: a throw there skipped both the success response AND the
// activeServerChanged broadcast, even though the server was already active
// in the database -- a client watching for that event would never learn
// the active server changed at all.
describe("POST /api/servers/:id/activate: a live-service reload failure must not turn a successful activation into an error", () => {
  let serverManager;
  let rconService;
  let io;

  function buildReq(id) {
    return {
      params: { id },
      user: { role: "admin" },
      app: {
        get: (key) => ({ serverManager, rconService, io, modChecker: null })[key],
      },
    };
  }

  beforeEach(() => {
    setActiveServer.mockReset();
    io = { emit: vi.fn() };
    rconService = {
      isConnected: vi.fn(() => false),
      disconnect: vi.fn(async () => {}),
      reloadConfig: vi.fn(async () => {}),
      connect: vi.fn(async () => {}),
    };
  });

  it("still reports success and still broadcasts activeServerChanged when serverManager.reloadConfig throws", async () => {
    setActiveServer.mockResolvedValue({
      id: "1",
      name: "Active One",
      rconPassword: "secret",
    });
    serverManager = {
      reloadConfig: vi.fn(async () => {
        throw new Error("reload exploded");
      }),
    };

    const response = createResponse();
    await runRoute("/:id/activate", "post", buildReq("1"), response);

    expect(response.status).not.toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        server: expect.objectContaining({ id: "1" }),
        warnings: expect.arrayContaining([expect.stringMatching(/could not be fully reloaded/i)]),
      }),
    );
    expect(io.emit).toHaveBeenCalledWith(
      "activeServerChanged",
      expect.objectContaining({ server: expect.objectContaining({ id: "1" }) }),
    );
  });

  it("reports success with no warnings when the reload succeeds normally (control)", async () => {
    setActiveServer.mockResolvedValue({ id: "1", name: "Active One" });
    serverManager = { reloadConfig: vi.fn(async () => {}) };

    const response = createResponse();
    await runRoute("/:id/activate", "post", buildReq("1"), response);

    expect(response.status).not.toHaveBeenCalledWith(500);
    const [payload] = response.json.mock.calls[0];
    expect(payload.warnings).toBeUndefined();
  });
});
