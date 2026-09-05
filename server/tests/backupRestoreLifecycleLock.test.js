import { afterEach, describe, expect, it, vi } from "vitest";

// bug hunt 2026-09-05 (backup-restore-round-trip sweep, item #2): restoring
// a backup used to take no lock at all against a Start happening in
// parallel. This route now takes the same process-wide lifecycleCoordinator
// lock /start, /stop, /force-stop and /restart already use, held for the
// entire restore -- not just the initial stopped-check restoreBackup() (and
// this route) still also perform on their own.

vi.mock("../database/init.js", () => ({ getActiveServer: vi.fn() }));

const { getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/backup.js");
const {
  acquireLifecycleLock,
  isLifecycleLocked,
} = await import("../services/lifecycleCoordinator.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getRestoreHandler() {
  const layer = router.stack.find((entry) => entry.route?.path === "/restore/:name");
  return layer.route.stack.at(-1).handle;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  // Best-effort: if a test left the process-wide lock held (a failed
  // assertion mid-test), later tests in this file or others must not
  // inherit a stuck lock.
  const stray = acquireLifecycleLock("test-cleanup");
  if (stray) stray.release();
});

describe("POST /restore/:name takes the process-wide lifecycle lock", () => {
  it("holds the lock for the duration of the restore and releases it on success", async () => {
    getActiveServer.mockResolvedValue({ name: "TestServer", isRemote: false });
    const restoreGate = deferred();
    const backupService = {
      restoreBackup: vi.fn(() => restoreGate.promise),
    };
    const serverManager = {
      getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: false })),
    };
    const app = {
      get: (key) =>
        key === "backupService" ? backupService : key === "serverManager" ? serverManager : {},
    };

    const handler = getRestoreHandler();
    const response = createResponse();

    expect(isLifecycleLocked()).toBe(false);
    const handlerPromise = handler(
      { params: { name: "good.zip" }, body: {}, app },
      response,
    );

    // Let the handler run up through acquiring the lock and calling into
    // restoreBackup() (which is now blocked on restoreGate).
    await vi.waitFor(() => expect(backupService.restoreBackup).toHaveBeenCalled());
    expect(isLifecycleLocked()).toBe(true);

    // A concurrent lifecycle operation (what /start would do) must be
    // refused while the restore is still in flight.
    const concurrent = acquireLifecycleLock("start", "TestServer");
    expect(concurrent).toBeNull();

    restoreGate.resolve({ success: true, message: "Restored" });
    await handlerPromise;

    expect(isLifecycleLocked()).toBe(false);
    expect(response.json).toHaveBeenCalledWith({ success: true, message: "Restored" });
  });

  it("refuses with 409 when another lifecycle operation already holds the lock, without ever calling restoreBackup()", async () => {
    getActiveServer.mockResolvedValue({ name: "TestServer", isRemote: false });
    const backupService = { restoreBackup: vi.fn() };
    const serverManager = {
      getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: false })),
    };
    const app = {
      get: (key) =>
        key === "backupService" ? backupService : key === "serverManager" ? serverManager : {},
    };

    const held = acquireLifecycleLock("start", "TestServer");
    expect(held).not.toBeNull();

    const handler = getRestoreHandler();
    const response = createResponse();
    await handler({ params: { name: "good.zip" }, body: {}, app }, response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(backupService.restoreBackup).not.toHaveBeenCalled();

    held.release();
  });

  it("releases the lock even when restoreBackup() throws", async () => {
    getActiveServer.mockResolvedValue({ name: "TestServer", isRemote: false });
    const backupService = {
      restoreBackup: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const serverManager = {
      getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: false })),
    };
    const app = {
      get: (key) =>
        key === "backupService" ? backupService : key === "serverManager" ? serverManager : {},
    };

    const handler = getRestoreHandler();
    const response = createResponse();
    await handler({ params: { name: "good.zip" }, body: {}, app }, response);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(isLifecycleLocked()).toBe(false);
  });
});
