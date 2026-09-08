import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// lifecycle-lock-set sweep, 2026-09-07: dd1e44f1's own comment on
// checkSpecificServerStopped() named this exact gap as "out of scope" for
// that lane ("narrows the check-then-act TOCTOU window as far as it can go
// without a shared lock with /start") -- this lane is that lock. Same shape
// and same fix as /wipe (bfc0e515): take the process-wide lifecycleCoordinator
// lock for the whole handler, not just the stopped-check, so a /start landing
// between the check and the (synchronous) rmSync() is refused instead of
// racing a live JVM against files being deleted out from under it.

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn(),
  getActiveServer: vi.fn(),
  getServers: vi.fn(),
}));

// checkSpecificServerStopped() (server.js) scans the whole host via a
// throwaway ServerManager instance -- keep scoreServerProcessOwnership real
// (importActual) and only replace the host scan itself, same pattern as
// deleteFilesGuards.test.js.
const scanHostForServerProcesses = vi.fn();

vi.mock("../services/serverManager.js", async () => {
  const actual = await vi.importActual("../services/serverManager.js");
  return {
    ...actual,
    ServerManager: vi.fn().mockImplementation(function () {
      this.scanHostForServerProcesses = scanHostForServerProcesses;
    }),
  };
});

const { default: router } = await import("../routes/server.js");
const { getServers } = await import("../database/init.js");
const { acquireLifecycleLock, isLifecycleLocked, lifecycleInProgressResponse } = await import(
  "../services/lifecycleCoordinator.js"
);

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getDeleteFilesHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/delete-files" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

describe("POST /api/server/delete-files holds the shared lifecycle lock across its stopped-check + delete window", () => {
  let installDir;

  beforeEach(() => {
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-delete-files-lock-"));
    fs.writeFileSync(path.join(installDir, "ProjectZomboid64.json"), "{}");
    getServers.mockReset();
    getServers.mockResolvedValue([{ id: 1, installPath: installDir }]);
    scanHostForServerProcesses.mockReset();
  });

  afterEach(() => {
    fs.rmSync(installDir, { recursive: true, force: true });
    // Best-effort: don't let a failed assertion mid-test leak a stuck lock.
    const stray = acquireLifecycleLock("test-cleanup");
    if (stray) stray.release();
  });

  const buildRequest = (body) => ({
    body: { path: installDir, confirm: true, ...body },
  });

  it("refuses a concurrent /start-shaped lock acquisition until the delete finishes, then allows one, then releases on success", async () => {
    let releaseCheck;
    let checkEntered;
    const checkReached = new Promise((r) => {
      checkEntered = r;
    });
    scanHostForServerProcesses.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCheck = () => resolve({ scanFailed: false, matched: [] });
          checkEntered();
        }),
    );

    const handler = getDeleteFilesHandler();
    const response = createResponse();

    const handlerCall = handler(buildRequest({}), response);

    // Let the handler run through confirm/path/marker/configured-server
    // validation up to the (suspended) stopped-check.
    await checkReached;
    expect(isLifecycleLocked()).toBe(true);

    // Exactly what /start's own handler does as its very first action.
    const startAttempt = acquireLifecycleLock("start", "servertest");
    expect(startAttempt).toBeNull();

    releaseCheck();
    await handlerCall;

    expect(isLifecycleLocked()).toBe(false);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(fs.existsSync(installDir)).toBe(false);

    const startAfterDelete = acquireLifecycleLock("start", "servertest");
    expect(startAfterDelete).not.toBeNull();
    startAfterDelete.release();
  });

  // normalize-lifecycle-lock-server-identifier, 2026-09-08: /delete-files is
  // one of two sites that sweep found still passing no server id at all, and
  // deliberately left that way (see the route's own comment on this exact
  // line) -- the lock is acquired before deletePath is even parsed, and
  // getServers()/the installPath match that WOULD resolve a real server DB
  // id doesn't run until deep inside the try block, well after the lock is
  // already held. Regression guard: proves the lock is still generic (no id)
  // even though this exact test's own fixture (installDir matches a
  // configured server, getServers() would resolve target.id === 1) COULD
  // supply one if fetched early -- catches a future "fix" that resolves the
  // id after the lock is acquired without actually closing the TOCTOU
  // window the null is protecting.
  it("still acquires the lock with no server id (generic refusal message), even though this fixture's server WOULD resolve one later in the handler", async () => {
    let releaseCheck;
    let checkEntered;
    const checkReached = new Promise((r) => {
      checkEntered = r;
    });
    scanHostForServerProcesses.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCheck = () => resolve({ scanFailed: false, matched: [] });
          checkEntered();
        }),
    );

    const handler = getDeleteFilesHandler();
    const response = createResponse();

    const handlerCall = handler(buildRequest({}), response);

    await checkReached;
    expect(lifecycleInProgressResponse().error).toBe(
      "A 'delete-files' operation is already in progress",
    );

    releaseCheck();
    await handlerCall;
  });

  it("refuses with 409 when another lifecycle operation already holds the lock, before any validation or deletion", async () => {
    scanHostForServerProcesses.mockResolvedValue({ scanFailed: false, matched: [] });
    const held = acquireLifecycleLock("start", "servertest");
    expect(held).not.toBeNull();

    const handler = getDeleteFilesHandler();
    const response = createResponse();

    await handler(buildRequest({}), response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(getServers).not.toHaveBeenCalled();
    expect(scanHostForServerProcesses).not.toHaveBeenCalled();
    expect(fs.existsSync(installDir)).toBe(true);

    held.release();
  });

  it("releases the lock even when the delete fails after the stopped-check passes", async () => {
    scanHostForServerProcesses.mockResolvedValue({ scanFailed: false, matched: [] });
    // Delete a path that will vanish out from under fs.rmSync -- force is
    // true so this doesn't throw ENOENT, but exercises the finally on a
    // non-throwing-but-unusual path. To actually exercise the catch branch,
    // make the target server's own installPath resolution collide with an
    // over-broad nested-data-path check instead: point zomboidDataPath AT
    // the install dir so the route returns its own 400 before ever reaching
    // rmSync -- proving the lock still releases on an early guarded return,
    // not only on the happy path.
    getServers.mockResolvedValue([
      { id: 1, installPath: installDir, zomboidDataPath: installDir },
    ]);

    const handler = getDeleteFilesHandler();
    const response = createResponse();

    await handler(buildRequest({}), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "DELETE_FILES_DATA_PATH_NESTED" }),
    );
    expect(isLifecycleLocked()).toBe(false);
    expect(fs.existsSync(installDir)).toBe(true);
  });
});
