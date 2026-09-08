import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { getActiveServer } = vi.hoisted(() => ({
  getActiveServer: vi.fn(),
}));

vi.mock("../database/init.js", () => ({
  getActiveServer,
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

const { default: router } = await import("../routes/serverFiles.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

// The unconfigured-server gate is the SECOND router.use() in the file, not
// the first: requireRole("admin", "technician") (role sweep) now runs
// ahead of it, deliberately — authorization has to happen before any data-
// availability check, so a role that has no business touching server files
// at all gets a 403 rather than a 404 that would still confirm whether a
// server is configured. The gate itself must still run before anything
// else FOR AN ALLOWED ROLE, including the existing remote-mirror
// middleware, so an unconfigured panel never reaches a handler that could
// invent data.
function getGateMiddleware() {
  const nonRouteLayers = router.stack.filter((entry) => !entry.route);
  return nonRouteLayers[1].handle;
}

function getRouteHandler(method, routePath) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

// End-to-end reproduction of Angela's finding: with the database genuinely
// empty, GET /api/server-files/paths (and every sibling route — they all
// share the same two path/name resolvers) must say nothing is configured,
// not present a fabricated "servertest" server as if it were real.
describe("server-files router: unconfigured-server gate", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
  });

  it("returns 404 'No active server configured' — same shape as GET /api/servers/active — instead of calling next()", async () => {
    getActiveServer.mockResolvedValue(null);
    const response = createResponse();
    const next = vi.fn();

    await getGateMiddleware()({ path: "/paths", method: "GET" }, response, next);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      error: "No active server configured",
      code: "SERVER_NOT_CONFIGURED",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() with no error when a server is genuinely configured", async () => {
    // 2026-09-08 quadruple-read sweep: this gate now derives via
    // getActiveServerPaths() (needs serverName too, not just serverConfigPath)
    // since it hangs the FULL context every downstream handler uses on req --
    // every real handler in this router already needed both, so a row with a
    // configPath but no name could never have succeeded past THIS gate's old,
    // narrower check either, just later and less clearly. A real configured
    // server row always has both.
    getActiveServer.mockResolvedValue({
      serverName: "RealServer",
      serverConfigPath: "/srv/pz/Server",
    });
    const response = createResponse();
    const req = { path: "/paths", method: "GET" };
    const next = vi.fn();

    await getGateMiddleware()(req, response, next);

    expect(next).toHaveBeenCalledWith();
    expect(response.status).not.toHaveBeenCalled();
    expect(req.activeServerContext).toEqual(
      expect.objectContaining({
        serverConfigPath: "/srv/pz/Server",
        serverName: "RealServer",
      }),
    );
  });

  it("the gate never even reaches the file the route handler would read — GET /paths itself would invent nothing anyway, but the gate stops it first", async () => {
    // Regression guard for the exact repro: an active server row that
    // exists but resolves to nothing real (the "Ghost" case) must not let
    // a route handler run and report fabricated paths.
    getActiveServer.mockResolvedValue(null);
    const response = createResponse();
    const next = vi.fn();

    await getGateMiddleware()({ path: "/paths", method: "GET" }, response, next);

    expect(response.json).not.toHaveBeenCalledWith(
      expect.objectContaining({ serverName: "servertest" }),
    );
  });
});

describe("server-files router: a configured server still resolves and reads real data", () => {
  let configDir;

  beforeEach(() => {
    getActiveServer.mockReset();
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "serverfiles-configured-"));
    fs.writeFileSync(
      path.join(configDir, "RealServer_spawnpoints.lua"),
      "-- real file",
    );
    getActiveServer.mockResolvedValue({
      serverName: "RealServer",
      serverConfigPath: configDir,
    });
  });

  it("GET /paths reports the real configured server's real paths, not an invented one", async () => {
    const response = createResponse();
    // 2026-09-08 quadruple-read sweep: every handler now reads
    // req.activeServerContext instead of re-deriving it -- run the real gate
    // first, on the same req, exactly as Express's own middleware chain
    // would, rather than hand-building the context here.
    const req = { path: "/paths", method: "GET" };
    await getGateMiddleware()(req, response, () => {});
    await getRouteHandler("get", "/paths")(req, response);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: configDir,
        serverName: "RealServer",
        exists: expect.objectContaining({ spawnpoints: true }),
      }),
    );
  });
});
