import { describe, expect, it, vi } from "vitest";

// re-entrancy sweep, 2026-09-10 (god-dispatched, HIGH #2): this route's own
// comment named five sibling routes (wipe, delete-files, chunks.js's
// delete-chunks/delete-region, backup.js's restore, templates.js's apply)
// already fixed for the "checked-then-race" shape -- an async running-check
// followed, well after it resolves, by a real unlink loop over the live
// save directory -- but didn't include itself. Fixed the same way: take the
// process-wide lifecycleCoordinator lock for the whole handler, acquired
// before the running-check.
//
// Proven here through the REAL route handler (grabbed off router.stack,
// same technique server/tests/wipeConcurrency.test.js already established
// for this exact lock in the sibling route) with the identical
// suspend-inside-the-running-check technique: a second request arriving
// while the first is still mid-scan must be refused by the ALREADY-HELD
// lock, not just at some later point.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
}));

const { default: router } = await import("../routes/debug.js");
const { getActiveServer } = await import("../database/init.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler() {
  const layer = router.stack.find(
    (entry) =>
      entry.route?.path === "/clear-stale-locks" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

describe("POST /api/debug/clear-stale-locks concurrency guard", () => {
  it("rejects a second call that arrives while the first is still mid running-check", async () => {
    getActiveServer.mockResolvedValue({
      id: "server-1",
      zomboidDataPath: null, // no save dir found downstream -- fine, first call never gets that far while suspended
      serverName: "servertest",
    });

    let checkCalls = 0;
    let releaseRunningCheck;
    let checkEnteredResolve;
    const checkEntered = new Promise((r) => {
      checkEnteredResolve = r;
    });

    const serverManager = {
      getServerProcessDetails: () => {
        checkCalls += 1;
        checkEnteredResolve();
        if (checkCalls === 1) {
          // Suspend the first request inside its own running-check --
          // this is AFTER the lifecycle lock is already held (it's
          // acquired before this call), so a second request arriving now
          // must be refused by the lock itself, not by anything the
          // running-check decides.
          return new Promise((resolve) => {
            releaseRunningCheck = () => resolve({ running: false, scanFailed: false });
          });
        }
        return Promise.resolve({ running: false, scanFailed: false });
      },
    };

    const handler = getHandler();
    const buildRequest = () => ({ app: { get: () => serverManager } });

    const firstResponse = createResponse();
    const secondResponse = createResponse();

    const firstCall = handler(buildRequest(), firstResponse);
    await checkEntered;

    await handler(buildRequest(), secondResponse);

    expect(secondResponse.status).toHaveBeenCalledWith(409);
    expect(secondResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SERVER_LIFECYCLE_IN_PROGRESS" }),
    );

    releaseRunningCheck();
    await firstCall;
  });

  it("releases the guard so a later call is not blocked forever", async () => {
    getActiveServer.mockResolvedValue(null); // fails fast (400) either time, doesn't matter for this assertion

    const serverManager = {
      getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
    };

    const handler = getHandler();
    const request = () => ({ app: { get: () => serverManager } });

    const first = createResponse();
    await handler(request(), first);

    const second = createResponse();
    await handler(request(), second);

    // Both refused for "no active server configured" (400), never 409 from
    // a guard stuck held by the first call.
    expect(second.status).toHaveBeenCalledWith(400);
    expect(second.status).not.toHaveBeenCalledWith(409);
  });
});
