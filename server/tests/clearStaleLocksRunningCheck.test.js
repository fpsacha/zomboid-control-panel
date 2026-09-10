import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// POST /debug/clear-stale-locks deletes *.lock files from the active save
// folder. Its own comment: "Refuses to run while the server is still alive
// so we don't yank a lock the JVM still holds open." It gated on
// serverManager.checkServerRunning() (and, if that itself threw, on an
// unrelated serverManager.isRunning flag) -- both discard the scan's own
// scanFailed distinction, so a scan that completed but couldn't determine
// the server's state came back indistinguishable from "confirmed stopped"
// and the delete proceeded. Same fail-open class already fixed at /wipe,
// /delete-files, chunks.js's delete-chunks/delete-region, backup.js's
// restore, and templates.js's apply.
//
// re-entrancy sweep, 2026-09-10: this route now ALSO takes the process-wide
// lifecycleCoordinator lock for the whole handler -- the fail-open class
// above was never this route's only gap; it also had no guard at all
// against a concurrent /start racing its own unlink loop, unlike those same
// five sibling routes (server/tests/clearStaleLocksConcurrency.test.js
// covers that race directly). Acquiring that lock needs a server identity
// for its 409 message, so getActiveServer() is now called ONCE, before the
// running-check, purely for the lock -- the same shape /wipe already uses
// (see server.js's own comment: "the lifecycle lock now held for the rest
// of this request guarantees the active server can't change under us").
// The three assertions below were written when getActiveServer() was only
// ever reached AFTER a passing running-check; updated to reflect that it's
// now called once for the lock regardless of what the running-check
// decides. The actual fail-closed BEHAVIOR under test -- 503/409, refused
// before the delete loop -- is unchanged and still asserted via statusCode.

const getActiveServer = vi.fn();
vi.mock("../database/init.js", async () => {
  const actual = await vi.importActual("../database/init.js");
  return { ...actual, getRoleByName: mockGetRoleByName, getActiveServer };
});

const { default: router } = await import("../routes/debug.js");

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getRouteHandlers(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(routePath, method, req) {
  const handlers = getRouteHandlers(routePath, method);
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

function postClearStaleLocks(serverManager) {
  return runRoute("/clear-stale-locks", "post", {
    user: { role: "admin" },
    body: {},
    app: { get: (key) => (key === "serverManager" ? serverManager : null) },
  });
}

beforeEach(() => {
  getActiveServer.mockReset().mockResolvedValue(null);
});

describe("debug.js POST /clear-stale-locks: an undetermined server state must refuse, not be read as 'stopped'", () => {
  it("refuses (503) and never reaches the delete loop when the running-scan itself failed (scanFailed:true)", async () => {
    const res = await postClearStaleLocks({
      // Old method the route used to call directly -- collapses the failed
      // scan into a plain `false`, which is exactly the bug.
      checkServerRunning: async () => false,
      getServerProcessDetails: async () => ({ running: false, scanFailed: true }),
    });

    expect(res.getStatusCode()).toBe(503);
    // Called once, for the lifecycle lock's identity -- not the two-call
    // shape the "proceeds past" test below exercises, since this path
    // never reaches the second, deeper lookup.
    expect(getActiveServer).toHaveBeenCalledTimes(1);
  });

  it("refuses (503) rather than falling back to the unrelated isRunning flag when the running-check itself throws", async () => {
    const res = await postClearStaleLocks({
      isRunning: false, // the old fallback would have read this as "stopped, proceed"
      checkServerRunning: async () => {
        throw new Error("boom-process-scan");
      },
      getServerProcessDetails: async () => {
        throw new Error("boom-process-scan");
      },
    });

    expect(res.getStatusCode()).toBe(503);
    expect(getActiveServer).toHaveBeenCalledTimes(1);
  });

  it("still refuses (409) on a confirmed-running server", async () => {
    const res = await postClearStaleLocks({
      checkServerRunning: async () => true,
      getServerProcessDetails: async () => ({ running: true, scanFailed: false }),
    });

    expect(res.getStatusCode()).toBe(409);
    expect(getActiveServer).toHaveBeenCalledTimes(1);
  });

  it("proceeds past the running-check when the scan confirms the server is stopped", async () => {
    const res = await postClearStaleLocks({
      checkServerRunning: async () => false,
      getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
    });

    // Called twice: once before the running-check (lock identity, resolves
    // null -> the lock is taken with no server id, same "no id available"
    // shape lifecycleCoordinator.js's own comment documents for a genuinely
    // unresolved target) and once more past it, where the route's own
    // "no active server" 400 stops it -- proving it got PAST the
    // running-check without needing a full save-folder fixture.
    expect(getActiveServer).toHaveBeenCalledTimes(2);
    expect(res.getStatusCode()).toBe(400);
  });
});
