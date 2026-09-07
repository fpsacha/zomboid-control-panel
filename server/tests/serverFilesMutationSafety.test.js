import { beforeEach, describe, expect, it, vi } from "vitest";

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

const {
  isLocalConfigMutation,
  isLocalConfigEdit,
  isLocalConfigOverwrite,
} = await import("../routes/serverFiles.js");
const { requireStoppedForLocalConfigMutation, warnRunningForLocalConfigEdit } =
  await import("../services/configMutationGuard.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function createRequest(method, path, running = false) {
  return {
    method,
    path,
    app: {
      get: () => ({
        checkServerRunning: vi.fn(async () => running),
        getServerProcessDetails: vi.fn(async () => ({ running, scanFailed: false })),
        // split-derivation sweep, 2026-09-07: both guards now force a real
        // reload before trusting getServerProcessDetails() -- see
        // configMutationGuardReloadBeforeTrust.test.js for the fix's own
        // dedicated regression coverage. A no-op stub here keeps every
        // OTHER test in this file exercising what it always exercised.
        reloadConfig: vi.fn(async () => {}),
      }),
    },
  };
}

describe("local config mutation safety", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    getActiveServer.mockResolvedValue({ isRemote: false });
  });

  it("recognizes file and template config mutations but not metadata routes", () => {
    expect(isLocalConfigMutation(createRequest("PUT", "/ini"))).toBe(true);
    expect(isLocalConfigMutation(createRequest("POST", "/restore/world.bak"))).toBe(true);
    expect(isLocalConfigMutation(createRequest("POST", "/templates/demo/apply"))).toBe(true);
    expect(isLocalConfigMutation(createRequest("POST", "/templates"))).toBe(false);
    expect(isLocalConfigMutation(createRequest("POST", "/save-and-reload"))).toBe(false);
  });

  // The 2026-08-23 operator ruling split isLocalConfigMutation's old
  // one-guard-fits-all into two disjoint classes with different behavior
  // while the server runs: ordinary edits are now WARNED, not blocked;
  // wholesale overwrites (restore, template-apply) are still blocked. These
  // two tests pin that split itself, independent of which middleware each
  // class is routed to below.
  it("classifies the nine edit routes as edits, not overwrites", () => {
    for (const routeKey of [
      "PUT /ini",
      "PUT /sandbox",
      "POST /sandbox/repair",
      "PUT /spawnpoints",
      "PUT /spawnregions",
      "PUT /raw/ini",
      "PUT /raw/sandbox",
      "PUT /raw/spawnpoints",
      "PUT /raw/spawnregions",
    ]) {
      const [method, path] = routeKey.split(" ");
      const req = createRequest(method, path);
      expect(isLocalConfigEdit(req), routeKey).toBe(true);
      expect(isLocalConfigOverwrite(req), routeKey).toBe(false);
    }
  });

  it("classifies restore and template-apply as overwrites, not edits", () => {
    const restore = createRequest("POST", "/restore/world.bak");
    const apply = createRequest("POST", "/templates/demo/apply");
    expect(isLocalConfigOverwrite(restore)).toBe(true);
    expect(isLocalConfigEdit(restore)).toBe(false);
    expect(isLocalConfigOverwrite(apply)).toBe(true);
    expect(isLocalConfigEdit(apply)).toBe(false);
  });

  // Pins the part of the operator's ruling that changed: restore and
  // template-apply are wholesale file overwrites, not edits, and stay
  // refused while the server runs regardless of the edit ruling above.
  it("still rejects restore and template-apply while the local server is running", async () => {
    for (const [method, path] of [
      ["POST", "/restore/world.bak"],
      ["POST", "/templates/demo/apply"],
    ]) {
      const response = createResponse();
      const next = vi.fn();

      await requireStoppedForLocalConfigMutation(
        createRequest(method, path, true),
        response,
        next,
      );

      expect(response.status, `${method} ${path}`).toHaveBeenCalledWith(409);
      expect(response.json, `${method} ${path}`).toHaveBeenCalledWith({
        code: "SERVER_RUNNING",
        error: "Stop the server before editing configuration.",
      });
      expect(next, `${method} ${path}`).not.toHaveBeenCalled();
    }
  });

  // Regression: this guard used serverManager.checkServerRunning(), which
  // internally discards getServerProcessDetails()'s scanFailed flag and
  // returns a bare boolean -- a FAILED detection scan (running: false,
  // scanFailed: true) came back indistinguishable from a confirmed stop, so
  // this guard fell through to next() and let a wholesale file overwrite
  // (restore, template-apply) proceed against a server it simply failed to
  // see was running. Same bug class already fixed at /wipe, backup restore,
  // and chunks.js -- this guard was the one sibling still fail-OPEN instead
  // of fail-closed on scanFailed.
  it("fails closed on a failed detection scan, not just a missing serverManager (restore/template-apply path)", async () => {
    for (const [method, path] of [
      ["POST", "/restore/world.bak"],
      ["POST", "/templates/demo/apply"],
    ]) {
      const response = createResponse();
      const next = vi.fn();
      const request = {
        method,
        path,
        app: {
          get: () => ({
            // checkServerRunning() would collapse this failed scan into a
            // bare `false`, same as a confirmed stop -- present here so a
            // fix that still calls it accidentally passes for the wrong
            // reason instead of genuinely fixing the scanFailed blindness.
            checkServerRunning: vi.fn(async () => false),
            getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: true })),
            reloadConfig: vi.fn(async () => {}),
          }),
        },
      };

      await requireStoppedForLocalConfigMutation(request, response, next);

      expect(response.status, `${method} ${path}`).toHaveBeenCalledWith(503);
      expect(response.json, `${method} ${path}`).toHaveBeenCalledWith(
        expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
      );
      expect(next, `${method} ${path}`).not.toHaveBeenCalled();
    }
  });

  it("fails closed when local server state cannot be checked (restore/template-apply path)", async () => {
    const response = createResponse();
    const next = vi.fn();
    const request = createRequest("POST", "/restore/world.bak");
    request.app.get = () => ({});

    await requireStoppedForLocalConfigMutation(request, response, next);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("allows stopped and remote restore/template-apply through requireStoppedForLocalConfigMutation", async () => {
    const stoppedResponse = createResponse();
    const stoppedNext = vi.fn();
    await requireStoppedForLocalConfigMutation(
      createRequest("POST", "/restore/world.bak", false),
      stoppedResponse,
      stoppedNext,
    );
    expect(stoppedNext).toHaveBeenCalledOnce();

    getActiveServer.mockResolvedValue({ isRemote: true });
    const remoteResponse = createResponse();
    const remoteNext = vi.fn();
    await requireStoppedForLocalConfigMutation(
      createRequest("POST", "/restore/world.bak", true),
      remoteResponse,
      remoteNext,
    );
    expect(remoteNext).toHaveBeenCalledOnce();
  });

  // The new behavior: warnRunningForLocalConfigEdit never refuses. It only
  // ever sets req.configEditRestartWarning so the route handler knows
  // whether to say the write won't reach the running game yet.
  describe("warnRunningForLocalConfigEdit (the nine edit routes)", () => {
    it("allows the write through and flags a restart warning while running", async () => {
      const response = createResponse();
      const next = vi.fn();
      const request = createRequest("PUT", "/sandbox", true);

      await warnRunningForLocalConfigEdit(request, response, next);

      expect(next).toHaveBeenCalledOnce();
      expect(response.status).not.toHaveBeenCalled();
      expect(request.configEditRestartWarning).toBe(true);
    });

    it("allows the write through with no restart warning when confirmed stopped", async () => {
      const response = createResponse();
      const next = vi.fn();
      const request = createRequest("PUT", "/ini", false);

      await warnRunningForLocalConfigEdit(request, response, next);

      expect(next).toHaveBeenCalledOnce();
      expect(request.configEditRestartWarning).toBe(false);
    });

    it("warns rather than silently assuming stopped when server state can't be checked", async () => {
      const response = createResponse();
      const next = vi.fn();
      const request = createRequest("PUT", "/ini");
      request.app.get = () => ({});

      await warnRunningForLocalConfigEdit(request, response, next);

      expect(next).toHaveBeenCalledOnce();
      expect(response.status).not.toHaveBeenCalled();
      expect(request.configEditRestartWarning).toBe(true);
    });

    it("warns rather than silently assuming stopped when getServerProcessDetails itself throws", async () => {
      const response = createResponse();
      const next = vi.fn();
      const request = {
        method: "PUT",
        path: "/ini",
        app: {
          get: () => ({
            reloadConfig: vi.fn(async () => {}),
            getServerProcessDetails: vi.fn(async () => {
              throw new Error("boom");
            }),
          }),
        },
      };

      await warnRunningForLocalConfigEdit(request, response, next);

      expect(next).toHaveBeenCalledOnce();
      expect(request.configEditRestartWarning).toBe(true);
    });

    // Regression: this guard used to call serverManager.checkServerRunning(),
    // which internally discards getServerProcessDetails()'s own scanFailed
    // flag and resolves a plain `false` for a scan that failed outright --
    // indistinguishable from a confirmed-stopped server. `running !== false`
    // then evaluated to `false`, so NO warning was shown on an undetermined
    // server state, the exact opposite of this function's documented policy
    // (2026-08-26 bug hunt finding 2). Only getServerProcessDetails() is
    // consulted now, so a manager that still exposes checkServerRunning
    // alongside it must not influence the result at all.
    it("warns on scanFailed even when checkServerRunning would have reported false", async () => {
      const response = createResponse();
      const next = vi.fn();
      const request = {
        method: "PUT",
        path: "/ini",
        app: {
          get: () => ({
            checkServerRunning: vi.fn(async () => false),
            reloadConfig: vi.fn(async () => {}),
            getServerProcessDetails: vi.fn(async () => ({
              running: false,
              scanFailed: true,
            })),
          }),
        },
      };

      await warnRunningForLocalConfigEdit(request, response, next);

      expect(next).toHaveBeenCalledOnce();
      expect(request.configEditRestartWarning).toBe(true);
    });

    it("skips the warning check entirely for a remote server", async () => {
      getActiveServer.mockResolvedValue({ isRemote: true });
      const response = createResponse();
      const next = vi.fn();
      const request = createRequest("PUT", "/ini", true);

      await warnRunningForLocalConfigEdit(request, response, next);

      expect(next).toHaveBeenCalledOnce();
      expect(request.configEditRestartWarning).toBeUndefined();
    });

    // Regression (2026-08-31 services sweep): this function's sibling,
    // requireStoppedForLocalConfigMutation, was hardened so a CONFIGURED but
    // currently-unreachable local path (network mount dropped, slow drive,
    // AV lock) isn't trusted as isRemote:true just because it self-healed
    // that way -- this guard never got the same treatment, so the exact
    // same ambiguous state silently skipped the warning check entirely.
    it("warns (does not treat as remote) when a configured local path is currently unreachable", async () => {
      getActiveServer.mockResolvedValue({ isRemote: true, installPath: "/nonexistent/pz-server" });
      const response = createResponse();
      const next = vi.fn();
      const request = createRequest("PUT", "/ini", true);

      await warnRunningForLocalConfigEdit(request, response, next);

      expect(next).toHaveBeenCalledOnce();
      expect(response.status).not.toHaveBeenCalled();
      expect(request.configEditRestartWarning).toBe(true);
    });
  });
});

