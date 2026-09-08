import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// lifecycle-lock-set sweep, 2026-09-07: /delete-chunks and /delete-region
// unlinked real chunk files with no lock a concurrent /start could also
// see -- only their own stopped-check, which only proves the server was
// stopped at the moment it ran, not for the rest of the (potentially
// multi-second, backup-then-delete) handler. Same shape as pre-bfc0e515
// /wipe and pre-dd1e44f1 /delete-files; same fix: take the process-wide
// lifecycleCoordinator lock for the whole handler.
//
// These tests suspend the handler mid-flight at its own backup-directory
// creation (a real fs.promises.mkdir call, intercepted once) and prove a
// concurrent lock acquisition shaped exactly like /start's own first action
// is refused for the whole suspension, then succeeds once the handler
// finishes -- the same "start A, assert B is refused" shape as
// wipeVsStartLifecycleLock.test.js, not a test that merely calls the route
// once and checks the happy path (which the pre-fix code would also pass).

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async () => undefined),
  setSetting: vi.fn(),
  getActiveServer: vi.fn(async () => null),
  updateServer: vi.fn(),
  getServers: vi.fn(async () => []),
}));

vi.mock("../utils/zomboidPaths.js", () => ({
  normalizeUserPath: (p) => p,
  getCandidateZomboidPaths: () => [],
  invalidateCandidatePathsCache: () => {},
  inspectZomboidPath: () => ({ ok: true }),
}));

const { getServers, getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/chunks.js");
const { acquireLifecycleLock, isLifecycleLocked, lifecycleInProgressResponse, setServerDisplayNameResolver } =
  await import("../services/lifecycleCoordinator.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(routePath) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

const SAVE_NAME = "TestSave";
let root;
let savePath;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-chunks-lock-"));
  savePath = path.join(root, "Saves", "Multiplayer", SAVE_NAME, "map");
  fs.mkdirSync(savePath, { recursive: true });
  fs.writeFileSync(path.join(savePath, "0_0.bin"), "chunk");
  getServers.mockResolvedValue([{ zomboidDataPath: root }]);
  getActiveServer.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  // Best-effort: don't let a failed assertion mid-test leak a stuck lock
  // into a later test in this file or another.
  const stray = acquireLifecycleLock("test-cleanup");
  if (stray) stray.release();
});

function buildRequest(body) {
  const serverManager = {
    getServerProcessDetails: vi.fn(async () => ({
      running: false,
      scanFailed: false,
    })),
  };
  return {
    app: { get: (key) => (key === "serverManager" ? serverManager : undefined) },
    body,
  };
}

describe("POST /api/chunks/delete-chunks holds the shared lifecycle lock across its backup+delete window", () => {
  it("refuses a concurrent /start-shaped lock acquisition until the delete finishes, then allows one, then releases on success", async () => {
    const realMkdir = fs.promises.mkdir.bind(fs.promises);
    let releaseMkdir;
    const mkdirGate = new Promise((resolve) => {
      releaseMkdir = resolve;
    });
    const mkdirSpy = vi
      .spyOn(fs.promises, "mkdir")
      .mockImplementationOnce((...args) => mkdirGate.then(() => realMkdir(...args)));

    const handler = getHandler("/delete-chunks");
    const response = createResponse();
    const request = buildRequest({
      saveName: SAVE_NAME,
      chunks: [{ file: "0_0.bin", x: 0, y: 0 }],
      createBackup: true,
      customPath: root,
      expectedServerId: undefined,
    });

    const handlerCall = handler(request, response);

    // Let the handler run through the stopped-check, validation, and path
    // resolution up to its own backup-directory creation (which is now
    // suspended on mkdirGate).
    await vi.waitFor(() => expect(mkdirSpy).toHaveBeenCalled());
    expect(isLifecycleLocked()).toBe(true);

    // This is exactly what /start's own handler does as its very first
    // action, before touching anything else.
    const startAttempt = acquireLifecycleLock("start", "servertest");
    expect(startAttempt).toBeNull();

    releaseMkdir();
    await handlerCall;

    expect(isLifecycleLocked()).toBe(false);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, deleted: 1 }),
    );

    const startAfterDelete = acquireLifecycleLock("start", "servertest");
    expect(startAfterDelete).not.toBeNull();
    startAfterDelete.release();
  });

  it("refuses with 409 when another lifecycle operation already holds the lock, without deleting anything", async () => {
    const held = acquireLifecycleLock("start", "servertest");
    expect(held).not.toBeNull();

    const handler = getHandler("/delete-chunks");
    const response = createResponse();
    const request = buildRequest({
      saveName: SAVE_NAME,
      chunks: [{ file: "0_0.bin", x: 0, y: 0 }],
      createBackup: true,
      customPath: root,
      expectedServerId: undefined,
    });

    await handler(request, response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(fs.existsSync(path.join(savePath, "0_0.bin"))).toBe(true);

    held.release();
  });

  // normalize-lifecycle-lock-server-identifier, 2026-09-08: this route used
  // to acquire the lock with req.body.saveName -- a save name, not a server
  // DB id, a distinct scheme from every other call site. Fixed to use the
  // active server's DB id (getActiveServerId(), the same helper the
  // stale-scan check just below already uses) when the delete is
  // server-scoped, and null for a customPath delete (see that branch's own
  // comment: no server identity applies to it). Proven here by reading the
  // held lock's own refusal message.
  it("acquires the lock with the active server's DB id, not the saveName, when the delete is server-scoped (no customPath)", async () => {
    // Resolver recognizes ONLY the real server id -- if the route ever
    // regressed to passing the saveName instead, this wouldn't resolve and
    // the message would fall back to the fully generic wording instead of
    // naming "Resolved-server-1".
    setServerDisplayNameResolver((id) => (id === "server-1" ? "Resolved-server-1" : null));
    getActiveServer.mockResolvedValue({ id: "server-1", zomboidDataPath: root });

    const realMkdir = fs.promises.mkdir.bind(fs.promises);
    let releaseMkdir;
    const mkdirGate = new Promise((resolve) => {
      releaseMkdir = resolve;
    });
    const mkdirSpy = vi
      .spyOn(fs.promises, "mkdir")
      .mockImplementationOnce((...args) => mkdirGate.then(() => realMkdir(...args)));

    const handler = getHandler("/delete-chunks");
    const response = createResponse();
    const request = buildRequest({
      saveName: SAVE_NAME,
      chunks: [{ file: "0_0.bin", x: 0, y: 0 }],
      createBackup: true,
      expectedServerId: "server-1",
    });

    const handlerCall = handler(request, response);

    try {
      await vi.waitFor(() => expect(mkdirSpy).toHaveBeenCalled());
      const message = lifecycleInProgressResponse().error;
      expect(message).toContain("Resolved-server-1");
      expect(message).not.toContain(SAVE_NAME);
    } finally {
      setServerDisplayNameResolver(null);
      releaseMkdir();
      await handlerCall;
    }
  });

  it("acquires the lock with no server id (not the saveName) when a customPath delete has no applicable server identity", async () => {
    const realMkdir = fs.promises.mkdir.bind(fs.promises);
    let releaseMkdir;
    const mkdirGate = new Promise((resolve) => {
      releaseMkdir = resolve;
    });
    const mkdirSpy = vi
      .spyOn(fs.promises, "mkdir")
      .mockImplementationOnce((...args) => mkdirGate.then(() => realMkdir(...args)));

    const handler = getHandler("/delete-chunks");
    const response = createResponse();
    const request = buildRequest({
      saveName: SAVE_NAME,
      chunks: [{ file: "0_0.bin", x: 0, y: 0 }],
      createBackup: true,
      customPath: root,
      expectedServerId: undefined,
    });

    const handlerCall = handler(request, response);

    await vi.waitFor(() => expect(mkdirSpy).toHaveBeenCalled());
    const message = lifecycleInProgressResponse().error;
    expect(message).not.toContain(SAVE_NAME);
    expect(message).toBe("A 'delete-chunks' operation is already in progress");

    releaseMkdir();
    await handlerCall;
  });
});

describe("POST /api/chunks/delete-region holds the shared lifecycle lock across its backup+delete window", () => {
  it("refuses a concurrent /start-shaped lock acquisition until the delete finishes, then allows one", async () => {
    const realMkdir = fs.promises.mkdir.bind(fs.promises);
    let releaseMkdir;
    const mkdirGate = new Promise((resolve) => {
      releaseMkdir = resolve;
    });
    const mkdirSpy = vi
      .spyOn(fs.promises, "mkdir")
      .mockImplementationOnce((...args) => mkdirGate.then(() => realMkdir(...args)));

    const handler = getHandler("/delete-region");
    const response = createResponse();
    const request = buildRequest({
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
      createBackup: true,
      customPath: root,
      expectedServerId: undefined,
    });

    const handlerCall = handler(request, response);

    await vi.waitFor(() => expect(mkdirSpy).toHaveBeenCalled());
    expect(isLifecycleLocked()).toBe(true);

    const startAttempt = acquireLifecycleLock("start", "servertest");
    expect(startAttempt).toBeNull();

    releaseMkdir();
    await handlerCall;

    expect(isLifecycleLocked()).toBe(false);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("refuses with 409 when another lifecycle operation already holds the lock, without deleting anything", async () => {
    const held = acquireLifecycleLock("start", "servertest");
    expect(held).not.toBeNull();

    const handler = getHandler("/delete-region");
    const response = createResponse();
    const request = buildRequest({
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
      createBackup: true,
      customPath: root,
      expectedServerId: undefined,
    });

    await handler(request, response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(fs.existsSync(path.join(savePath, "0_0.bin"))).toBe(true);

    held.release();
  });
});
