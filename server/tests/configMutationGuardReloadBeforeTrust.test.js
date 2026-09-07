import { beforeEach, describe, expect, it, vi } from "vitest";

// split-derivation sweep, 2026-09-07 (same class as /wipe's pre-fix bug,
// 5c2e73e9): requireStoppedForLocalConfigMutation, warnRunningForLocalConfigEdit
// (services/configMutationGuard.js) and templates.js's POST /:id/apply all
// read `activeServer` fresh via getActiveServer(), then trusted
// serverManager.getServerProcessDetails() as verifying THAT SAME server --
// but getServerProcessDetails() internally calls the GUARDED loadConfig()
// (a no-op once serverManager has loaded any server's config at all), not a
// real reload. Passing the freshly-read activeServer's identity check does
// not guarantee serverManager's own cached config actually matches it yet
// (e.g. immediately after an /activate switch to a different server).
//
// These tests prove the mechanism directly: reloadConfig() must be called,
// and it must be called BEFORE getServerProcessDetails() is trusted, on
// every one of the three call sites -- not just that the final answer
// happens to come out right in the common case, which the pre-fix code
// would also do whenever serverManager's cache already happened to agree.

const getActiveServer = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getSetting: vi.fn(),
  getRoleByName: vi.fn(async () => null),
}));

vi.mock("../services/templateService.js", () => ({
  listTemplates: vi.fn(),
  listHiddenBuiltinTemplates: vi.fn(),
  getTemplate: vi.fn(),
  saveTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  unhideTemplate: vi.fn(),
  exportTemplate: vi.fn(),
  importTemplate: vi.fn(),
  previewTemplate: vi.fn(),
  applyTemplate: vi.fn(),
}));

const { requireStoppedForLocalConfigMutation, warnRunningForLocalConfigEdit } =
  await import("../services/configMutationGuard.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

// Records call order so a test can assert reloadConfig ran BEFORE
// getServerProcessDetails, not merely that both ran at some point.
function buildOrderedServerManager({ reloadThrows = false } = {}) {
  const callOrder = [];
  return {
    callOrder,
    serverManager: {
      reloadConfig: vi.fn(async () => {
        callOrder.push("reloadConfig");
        if (reloadThrows) throw new Error("reload failed: DB unreachable");
      }),
      getServerProcessDetails: vi.fn(async () => {
        callOrder.push("getServerProcessDetails");
        return { running: false, scanFailed: false };
      }),
    },
  };
}

describe("configMutationGuard forces a real reload before trusting the process check", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    getActiveServer.mockResolvedValue({ isRemote: false });
  });

  describe("requireStoppedForLocalConfigMutation", () => {
    it("calls reloadConfig() before getServerProcessDetails(), not after or instead of it", async () => {
      const { callOrder, serverManager } = buildOrderedServerManager();
      const req = { app: { get: () => serverManager } };
      const res = createResponse();
      const next = vi.fn();

      await requireStoppedForLocalConfigMutation(req, res, next);

      expect(callOrder).toEqual(["reloadConfig", "getServerProcessDetails"]);
      expect(next).toHaveBeenCalledOnce();
    });

    it("fails closed (503, does not call getServerProcessDetails at all) when reloadConfig() itself fails", async () => {
      const { callOrder, serverManager } = buildOrderedServerManager({ reloadThrows: true });
      const req = { app: { get: () => serverManager } };
      const res = createResponse();
      const next = vi.fn();

      await requireStoppedForLocalConfigMutation(req, res, next);

      expect(callOrder).toEqual(["reloadConfig"]);
      expect(serverManager.getServerProcessDetails).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("warnRunningForLocalConfigEdit", () => {
    it("calls reloadConfig() before getServerProcessDetails(), not after or instead of it", async () => {
      const { callOrder, serverManager } = buildOrderedServerManager();
      const req = { app: { get: () => serverManager } };
      const res = createResponse();
      const next = vi.fn();

      await warnRunningForLocalConfigEdit(req, res, next);

      expect(callOrder).toEqual(["reloadConfig", "getServerProcessDetails"]);
      expect(next).toHaveBeenCalledOnce();
    });

    // This function's documented policy is "never block, cannot-verify
    // means warn" -- a reloadConfig() failure must follow that same policy,
    // not the sibling guard's fail-closed-and-refuse behavior.
    it("warns (does not block) rather than refusing when reloadConfig() itself fails", async () => {
      const { callOrder, serverManager } = buildOrderedServerManager({ reloadThrows: true });
      const req = { app: { get: () => serverManager } };
      const res = createResponse();
      const next = vi.fn();

      await warnRunningForLocalConfigEdit(req, res, next);

      expect(callOrder).toEqual(["reloadConfig"]);
      expect(serverManager.getServerProcessDetails).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledOnce();
      expect(req.configEditRestartWarning).toBe(true);
    });
  });
});

describe("POST /templates/:id/apply forces a real reload before trusting the process check", () => {
  let router;
  let templateService;

  beforeEach(async () => {
    getActiveServer.mockReset();
    ({ default: router } = await import("../routes/templates.js"));
    templateService = await import("../services/templateService.js");
    templateService.applyTemplate.mockReset();
    templateService.applyTemplate.mockResolvedValue({ success: true });
  });

  function getApplyHandler() {
    const layer = router.stack.find(
      (entry) => entry.route?.path === "/:id/apply" && entry.route.methods.post,
    );
    const stack = layer.route.stack;
    return stack[stack.length - 1].handle;
  }

  it("calls reloadConfig() before getServerProcessDetails() when applying to the active server", async () => {
    getActiveServer.mockResolvedValue({ id: "server-1" });
    const { callOrder, serverManager } = buildOrderedServerManager();
    const handler = getApplyHandler();
    const res = createResponse();

    await handler(
      {
        params: { id: "template-1" },
        body: { serverId: "server-1" },
        app: { get: () => serverManager },
      },
      res,
    );

    expect(callOrder).toEqual(["reloadConfig", "getServerProcessDetails"]);
  });

  it("fails closed (503, does not call getServerProcessDetails at all) when reloadConfig() itself fails", async () => {
    getActiveServer.mockResolvedValue({ id: "server-1" });
    const { callOrder, serverManager } = buildOrderedServerManager({ reloadThrows: true });
    const handler = getApplyHandler();
    const res = createResponse();

    await handler(
      {
        params: { id: "template-1" },
        body: { serverId: "server-1" },
        app: { get: () => serverManager },
      },
      res,
    );

    expect(callOrder).toEqual(["reloadConfig"]);
    expect(serverManager.getServerProcessDetails).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(templateService.applyTemplate).not.toHaveBeenCalled();
  });
});
