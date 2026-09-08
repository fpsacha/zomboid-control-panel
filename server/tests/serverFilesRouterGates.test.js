import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// conv-mods-thumbnails follow-up (the "one-gate-per-router blindness" card):
// routeRoleSweep.test.js's runFirstUseLayer() (and every router.stack.find()
// -based helper in that suite) only ever reaches the FIRST router.use()
// layer of any router. serverFiles.js has FOUR: the requirePermission gate
// routeRoleSweep.test.js covers (line 36), then three more.
//
// CORRECTION to the card as dispatched, found while building this file --
// worth recording plainly rather than silently patching around it: line 72
// (the unconfigured-panel 404) is NOT actually uncovered. It's already
// reached by serverFilesUnconfiguredGate.test.js, which does the same
// nonRouteLayers[1]-by-index trick this file uses -- routeRoleSweep.test.js
// can't see it, but a different, dedicated file already can and does, in
// both directions (404 when unconfigured, passes through when configured).
// Line 238's underlying guard functions (requireStoppedForLocalConfigMutation,
// warnRunningForLocalConfigEdit) are ALSO already thoroughly covered --
// serverFilesMutationSafety.test.js imports and calls them directly from
// services/configMutationGuard.js, including the exact 92d2772
// fail-open/scanFailed case. What neither existing file tests is the
// DISPATCH itself -- the anonymous middleware actually sitting at
// router.stack's non-route index 3, whose only job is deciding which guard
// function a given (method, path) pair gets routed to (or neither). That
// wiring, and the line-88 remote-mirror gate (genuinely zero coverage
// anywhere, confirmed by grepping the whole suite for its response codes),
// are this file's actual job -- line 72 is left to its existing owner
// rather than duplicated here.
//
// Line 238's dispatch sits in front of a guard with fail-open history --
// this file is coverage only, per the boundary: if any assertion here
// reveals the WIRING doing something the underlying (already-verified)
// guard functions wouldn't, that's a finding to report, not something to
// fix in this pass.

const getActiveServer = vi.fn();
const getAllSettings = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings,
}));

// Deliberately mocked rather than imported for real: services/
// remoteConfigFiles.js pulls in ssh2-sftp-client, and none of the cases
// below need an actual SFTP round trip -- the "remote but not configured"
// case only needs isRemoteConfigConfigured() to say no, same principle as
// this suite's existing discordBot.js stub (a gate test has no legitimate
// reason to load a real network client).
const isRemoteConfigConfigured = vi.fn(() => false);
vi.mock("../services/remoteConfigFiles.js", () => ({
  SFTP_CONFIG_PATH_KEY: "panelBridgeSftpConfigPath",
  acquireMirrorLock: vi.fn(async () => () => {}),
  beginRemoteConfigSession: vi.fn(async () => ({})),
  getMirrorPath: vi.fn(async () => "/tmp/mirror"),
  isRemoteConfigConfigured,
  pushRemoteConfigFiles: vi.fn(async () => {}),
  validateRemoteConfigTransport: vi.fn(() => null),
}));

const { default: router } = await import("../routes/serverFiles.js");

// Verified empirically: router.stack has exactly 4 non-route layers, in
// source order -- [0] line 36 requirePermission("serverfiles.manage")
// (already covered by routeRoleSweep.test.js), [1] line 72, [2] line 88,
// [3] line 238. Grabbed by index, not "first", since that's precisely the
// blindness this file exists to remove.
function getUseLayers() {
  return router.stack.filter((entry) => !entry.route).map((entry) => entry.handle);
}

function fakeReq(overrides = {}) {
  return { path: "/", url: "/", method: "GET", app: { get: () => undefined }, ...overrides };
}

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = null;
  let jsonBody = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (body) => {
    jsonBody = body;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getJson = () => jsonBody;
  return response;
}

// Runs ONE middleware layer directly (not the whole router), matching
// routeRoleSweep.test.js's runFirstUseLayer -- these are router.use()
// layers with no path of their own, so there's no route-matching to
// faithfully reproduce, just the (req, res, next) contract.
async function runLayer(handle, req) {
  const res = createResponse();
  let nextCalledWith = "not-called";
  await handle(req, res, (err) => {
    nextCalledWith = err ?? "called";
  });
  return { res, nextCalledWith };
}

describe("serverFiles.js router.use layers beyond the requirePermission gate", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    getAllSettings.mockReset().mockResolvedValue({});
    isRemoteConfigConfigured.mockReset().mockReturnValue(false);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("layer[2] (line 88): remote-mirror gate", () => {
    // 2026-09-08 quadruple-read sweep: layer[2] now reads req.activeServerContext
    // instead of calling getActiveServer() itself -- populated once by layer[1]
    // (the unconfigured-server gate, now also the single per-request read
    // point). Run layer[1] first, on the SAME req, exactly as Express's real
    // chain would, rather than hand-building the context here.
    async function runLayer1Then2(req) {
      const [, layer1, layer2] = getUseLayers();
      await layer1(req, createResponse(), () => {});
      return runLayer(layer2, req);
    }

    it("a local active server -- passes straight through, no SFTP anything touched", async () => {
      getActiveServer.mockResolvedValue({ isRemote: false, serverName: "S", serverConfigPath: "/srv/S" });
      const { nextCalledWith } = await runLayer1Then2(fakeReq());
      expect(nextCalledWith).toBe("called");
    });

    it("a remote active server on a local-filesystem-only path (/browse-files) -- refused, not mirrored", async () => {
      getActiveServer.mockResolvedValue({ isRemote: true, serverName: "S", serverConfigPath: "/srv/S" });
      const { res, nextCalledWith } = await runLayer1Then2(
        fakeReq({ path: "/browse-files" }),
      );
      expect(res.getStatusCode()).toBe(400);
      expect(res.getJson()).toMatchObject({ code: "REMOTE_BROWSE_NOT_AVAILABLE" });
      expect(nextCalledWith).toBe("not-called");
    });

    it("a remote active server with SFTP not configured -- refused with REMOTE_CONFIG_NOT_CONFIGURED, no mirror session attempted", async () => {
      getActiveServer.mockResolvedValue({ isRemote: true, serverName: "S", serverConfigPath: "/srv/S" });
      isRemoteConfigConfigured.mockReturnValue(false);
      const { res, nextCalledWith } = await runLayer1Then2(fakeReq({ path: "/ini" }));
      expect(res.getStatusCode()).toBe(400);
      expect(res.getJson()).toMatchObject({ code: "REMOTE_CONFIG_NOT_CONFIGURED" });
      expect(nextCalledWith).toBe("not-called");
    });
  });

  describe("layer[3] (line 238): wholesale-overwrite vs ordinary-edit routing -- 238's requireStoppedForLocalConfigMutation branch has fail-open history (92d2772)", () => {
    function stubManager(details) {
      return {
        get: (key) =>
          key === "serverManager"
            ? {
                // split-derivation sweep, 2026-09-07: both guards now force
                // a real reload before trusting getServerProcessDetails().
                reloadConfig: async () => {},
                getServerProcessDetails: async () => details,
              }
            : undefined,
      };
    }
    // getServerProcessDetails(), not checkServerRunning() -- matching the
    // 2026-08-26 fix to warnRunningForLocalConfigEdit itself (finding 2):
    // that guard now only ever consults getServerProcessDetails(), so a
    // stub exposing just checkServerRunning would (correctly, post-fix)
    // always warn regardless of `running`, breaking the "passes through
    // with no warning while stopped" case below for the wrong reason.
    function stubEditManager(running) {
      return {
        get: (key) =>
          key === "serverManager"
            ? {
                reloadConfig: async () => {},
                getServerProcessDetails: async () => ({ running, scanFailed: false }),
              }
            : undefined,
      };
    }

    it("POST /restore/:name (overwrite) while the server IS running -- 409 SERVER_RUNNING, refused", async () => {
      getActiveServer.mockResolvedValue({ isRemote: false });
      const [, , , layer238] = getUseLayers();
      const { res, nextCalledWith } = await runLayer(
        layer238,
        fakeReq({
          method: "POST",
          path: "/restore/mysave",
          app: stubManager({ running: true, scanFailed: false }),
        }),
      );
      expect(res.getStatusCode()).toBe(409);
      expect(res.getJson()).toMatchObject({ code: "SERVER_RUNNING" });
      expect(nextCalledWith).toBe("not-called");
    });

    it("POST /restore/:name while the server is confirmed stopped -- passes through", async () => {
      getActiveServer.mockResolvedValue({ isRemote: false });
      const [, , , layer238] = getUseLayers();
      const { nextCalledWith } = await runLayer(
        layer238,
        fakeReq({
          method: "POST",
          path: "/restore/mysave",
          app: stubManager({ running: false, scanFailed: false }),
        }),
      );
      expect(nextCalledWith).toBe("called");
    });

    it("POST /restore/:name when the process-detection scan itself fails -- 503 SERVER_STATE_UNKNOWN, refused (fail-closed, the 92d2772 fix)", async () => {
      getActiveServer.mockResolvedValue({ isRemote: false });
      const [, , , layer238] = getUseLayers();
      const { res, nextCalledWith } = await runLayer(
        layer238,
        fakeReq({
          method: "POST",
          path: "/restore/mysave",
          app: stubManager({ running: false, scanFailed: true }),
        }),
      );
      expect(res.getStatusCode()).toBe(503);
      expect(res.getJson()).toMatchObject({ code: "SERVER_STATE_UNKNOWN" });
      expect(nextCalledWith).toBe("not-called");
    });

    it("POST /templates/:name/apply (also a wholesale overwrite) while running -- same 409 refusal as /restore", async () => {
      getActiveServer.mockResolvedValue({ isRemote: false });
      const [, , , layer238] = getUseLayers();
      const { res } = await runLayer(
        layer238,
        fakeReq({
          method: "POST",
          path: "/templates/vanilla/apply",
          app: stubManager({ running: true, scanFailed: false }),
        }),
      );
      expect(res.getStatusCode()).toBe(409);
    });

    it("an overwrite on a remote server skips the local process check entirely -- passes through", async () => {
      getActiveServer.mockResolvedValue({ isRemote: true });
      const [, , , layer238] = getUseLayers();
      const { nextCalledWith } = await runLayer(
        layer238,
        fakeReq({ method: "POST", path: "/restore/mysave" }),
      );
      expect(nextCalledWith).toBe("called");
    });

    it("PUT /ini (an ordinary edit, not an overwrite) while running -- never blocks, but flags the restart warning", async () => {
      getActiveServer.mockResolvedValue({ isRemote: false });
      const [, , , layer238] = getUseLayers();
      const req = fakeReq({ method: "PUT", path: "/ini", app: stubEditManager(true) });
      const { nextCalledWith } = await runLayer(layer238, req);
      expect(nextCalledWith).toBe("called");
      expect(req.configEditRestartWarning).toBe(true);
    });

    it("PUT /ini while stopped -- passes through with no restart warning", async () => {
      getActiveServer.mockResolvedValue({ isRemote: false });
      const [, , , layer238] = getUseLayers();
      const req = fakeReq({ method: "PUT", path: "/ini", app: stubEditManager(false) });
      const { nextCalledWith } = await runLayer(layer238, req);
      expect(nextCalledWith).toBe("called");
      expect(req.configEditRestartWarning).toBe(false);
    });

    it("a route that is neither an overwrite nor a tracked edit (e.g. GET /ini) -- passes straight through untouched", async () => {
      const [, , , layer238] = getUseLayers();
      const { nextCalledWith } = await runLayer(
        layer238,
        fakeReq({ method: "GET", path: "/ini" }),
      );
      expect(nextCalledWith).toBe("called");
      // Neither branch's server-state check should have run for a path this
      // gate doesn't even classify as a mutation.
      expect(getActiveServer).not.toHaveBeenCalled();
    });
  });
});
