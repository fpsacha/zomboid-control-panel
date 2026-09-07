import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// lifecycle-lock-set sweep, 2026-09-07: POST /:id/apply's active-server
// branch checks getServerProcessDetails() once, then applyTemplate() does
// real config-file I/O with no lock held. A /start landing in that window
// launches the JVM reading a partially-written config. Same fix as /wipe,
// /delete-files, and chunks.js's delete-chunks/delete-region: take the
// process-wide lifecycleCoordinator lock for the whole handler.

const getActiveServer = vi.fn();
const applyTemplate = vi.fn();

import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

vi.mock("../database/init.js", () => ({ getActiveServer, getRoleByName: mockGetRoleByName }));
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
const { acquireLifecycleLock, isLifecycleLocked } = await import(
  "../services/lifecycleCoordinator.js"
);

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
    applyTemplate.mockReset();
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

  it("releases the lock on the non-active-server branch's unconditional refusal too", async () => {
    const handler = getApplyHandler();
    const response = createResponse();

    await handler(buildRequest({ serverId: "server-2" }), response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(applyTemplate).not.toHaveBeenCalled();
    expect(isLifecycleLocked()).toBe(false);
  });
});
