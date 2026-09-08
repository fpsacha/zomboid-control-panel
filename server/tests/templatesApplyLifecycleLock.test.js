import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// lifecycle-lock-set sweep, 2026-09-07: POST /:id/apply's active-server
// branch checks getServerProcessDetails() once, then applyTemplate() does
// real config-file I/O with no lock held. A /start landing in that window
// launches the JVM reading a partially-written config. Same fix as /wipe,
// /delete-files, and chunks.js's delete-chunks/delete-region: take the
// process-wide lifecycleCoordinator lock for the whole handler.

const getActiveServer = vi.fn();
const getServer = vi.fn();
const applyTemplate = vi.fn();

import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getServer,
  getRoleByName: mockGetRoleByName,
}));

// checkSpecificServerStopped() (routes/server.js, now imported by
// routes/templates.js for the non-active-server branch below) does a
// real host-wide process scan via ServerManager.scanHostForServerProcesses()
// -- mocked here the same way serversStatusListProcessAttribution.test.js
// mocks it, so these lock-focused tests don't touch a real OS process list.
const scanHostForServerProcesses = vi.fn().mockResolvedValue({ matched: [] });
vi.mock("../services/serverManager.js", async () => {
  const actual = await vi.importActual("../services/serverManager.js");
  return {
    ...actual,
    ServerManager: vi.fn().mockImplementation(function () {
      this.scanHostForServerProcesses = scanHostForServerProcesses;
    }),
  };
});

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
  applyTemplate,
}));

const { default: router } = await import("../routes/templates.js");
const {
  acquireLifecycleLock,
  isLifecycleLocked,
  lifecycleInProgressResponse,
  setServerDisplayNameResolver,
} = await import("../services/lifecycleCoordinator.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getApplyHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/:id/apply" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function buildRequest(body) {
  return {
    params: { id: "template-1" },
    body: { serverId: "server-1", ...body },
    user: { role: "admin" },
    app: {
      get: () => ({
        reloadConfig: vi.fn(async () => {}),
        getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: false })),
      }),
    },
  };
}

describe("POST /api/templates/:id/apply holds the shared lifecycle lock across its stopped-check + apply window", () => {
  beforeEach(() => {
    getActiveServer.mockReset().mockResolvedValue({ id: "server-1" });
    getServer.mockReset();
    applyTemplate.mockReset();
    scanHostForServerProcesses.mockReset().mockResolvedValue({ matched: [] });
  });

  afterEach(() => {
    // Best-effort: don't let a failed assertion mid-test leak a stuck lock.
    const stray = acquireLifecycleLock("test-cleanup");
    if (stray) stray.release();
  });

  it("refuses a concurrent /start-shaped lock acquisition until the apply finishes, then allows one, then releases on success", async () => {
    let releaseApply;
    let applyEntered;
    const applyReached = new Promise((r) => {
      applyEntered = r;
    });
    applyTemplate.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseApply = () => resolve({ success: true });
          applyEntered();
        }),
    );

    const handler = getApplyHandler();
    const response = createResponse();

    const handlerCall = handler(buildRequest({}), response);

    await applyReached;
    expect(isLifecycleLocked()).toBe(true);

    const startAttempt = acquireLifecycleLock("start", "servertest");
    expect(startAttempt).toBeNull();

    releaseApply();
    await handlerCall;

    expect(isLifecycleLocked()).toBe(false);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );

    const startAfterApply = acquireLifecycleLock("start", "servertest");
    expect(startAfterApply).not.toBeNull();
    startAfterApply.release();
  });

  // normalize-lifecycle-lock-server-identifier, 2026-09-08: this route used
  // to acquire the lock with no second argument at all (acquireLifecycleLock
  // ("template-apply") -- see the lifecycleCoordinator sweep this fixed).
  // req.body.serverId is fully available the instant the handler starts
  // (Express has already parsed the body), so unlike /delete-files this
  // route has no excuse to leave it null. Proven here by wiring a resolver
  // that only recognizes "server-1" (this request's exact serverId) and
  // reading it back out of the held lock's own refusal message -- a
  // read call, since lifecycleInProgressResponse()'s follow-up fix
  // (message-build-time id -> display-name resolution) means the message no
  // longer echoes a raw id directly.
  it("acquires the lock with the request's own server DB id (req.body.serverId), not null", async () => {
    setServerDisplayNameResolver((id) => (id === "server-1" ? "Resolved-server-1" : null));
    let releaseApply;
    let applyEntered;
    const applyReached = new Promise((r) => {
      applyEntered = r;
    });
    applyTemplate.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseApply = () => resolve({ success: true });
          applyEntered();
        }),
    );

    const handler = getApplyHandler();
    const response = createResponse();

    const handlerCall = handler(buildRequest({ serverId: "server-1" }), response);

    try {
      await applyReached;
      expect(lifecycleInProgressResponse().error).toContain("Resolved-server-1");
    } finally {
      setServerDisplayNameResolver(null);
      releaseApply();
      await handlerCall;
    }
  });

  it("refuses with 409 when another lifecycle operation already holds the lock, before any validation or apply", async () => {
    const held = acquireLifecycleLock("start", "servertest");
    expect(held).not.toBeNull();

    const handler = getApplyHandler();
    const response = createResponse();

    await handler(buildRequest({}), response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(getActiveServer).not.toHaveBeenCalled();
    expect(applyTemplate).not.toHaveBeenCalled();

    held.release();
  });

  it("releases the lock even when applyTemplate() rejects", async () => {
    applyTemplate.mockRejectedValue(new Error("boom"));

    const handler = getApplyHandler();
    const response = createResponse();

    await handler(buildRequest({}), response);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(isLifecycleLocked()).toBe(false);
  });

  // is-running-enumeration sweep, 2026-09-08: the non-active-server branch
  // used to refuse unconditionally (no cross-server detection existed yet);
  // it now runs checkSpecificServerStopped() for real, so lock release must
  // hold under BOTH outcomes that branch can now reach, not just the one
  // refusal path that used to be the only option.
  it("releases the lock on the non-active-server branch when the check confirms it's running", async () => {
    getServer.mockResolvedValue({
      id: "server-2",
      serverName: "Server2",
      zomboidDataPath: "C:\\Zomboid\\Server2",
      serverPath: "C:\\Servers\\Server2",
    });
    scanHostForServerProcesses.mockResolvedValue({
      matched: [{ pid: "1", cmd: '"C:\\Servers\\Server2\\java.exe" -servername "Server2"' }],
    });
    const handler = getApplyHandler();
    const response = createResponse();

    await handler(buildRequest({ serverId: "server-2" }), response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(applyTemplate).not.toHaveBeenCalled();
    expect(isLifecycleLocked()).toBe(false);
  });

  it("releases the lock on the non-active-server branch when the check confirms it's stopped, and proceeds to apply", async () => {
    getServer.mockResolvedValue({
      id: "server-2",
      serverName: "Server2",
      zomboidDataPath: "C:\\Zomboid\\Server2",
      serverPath: "C:\\Servers\\Server2",
    });
    scanHostForServerProcesses.mockResolvedValue({ matched: [] });
    applyTemplate.mockResolvedValue({ success: true });
    const handler = getApplyHandler();
    const response = createResponse();

    await handler(buildRequest({ serverId: "server-2" }), response);

    expect(applyTemplate).toHaveBeenCalled();
    expect(isLifecycleLocked()).toBe(false);
  });
});
