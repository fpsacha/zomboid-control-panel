import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression coverage for 60f4de4f and 45d9674d, both found by comparing
// this handler's Windows Supervisor v2 branch against its Linux sibling
// directly below it and neither one could be tested before now: index.js's
// own Express `app` was never exported, so nothing could dispatch into any
// route registered directly on it (see the 2026-09-08 index.js coverage
// measurement -- god approved exporting `app` for exactly this).
//
// Same technique as server/tests/oidcRoutes.test.js's getHandler(): walk the
// exported app's own route table (an Express Application's routes live on
// `app.router.stack` in Express 5, the same shape a Router's `.stack` is) to
// find the registered handler and call it directly with hand-built req/res.
// No real HTTP server, no supertest -- this codebase deliberately doesn't
// use it (see oidcRoutes.test.js's own comment).
// index.js registers several panelBridge.on(...) listeners at module scope,
// so the mock has to behave like the real EventEmitter-based singleton, not
// just expose isRunning/stop.
vi.mock("../services/panelBridge.js", async () => {
  const { EventEmitter } = await import("events");
  const { vi: vitest } = await import("vitest");
  const fake = new EventEmitter();
  fake.isRunning = true;
  fake.stop = vitest.fn();
  return { default: fake };
});

const { app } = await import("../index.js");
const panelBridge = (await import("../services/panelBridge.js")).default;

function getRestartHandler() {
  const router = app.router;
  const layer = router.stack.find(
    (l) => l.route?.path === "/api/panel/restart" && l.route.methods.post,
  );
  if (!layer) throw new Error("No POST /api/panel/restart route registered");
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRes() {
  const res = { statusCode: 200, jsonBody: undefined };
  res.status = vi.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body) => {
    res.jsonBody = body;
    return res;
  });
  return res;
}

function makeChecker(overrides = {}) {
  return {
    isApplying: false,
    getStagedUpdate: vi.fn(() => ({ version: "1.2.19" })),
    isSupervisorAvailable: vi.fn(() => true),
    writeSupervisorMarker: vi.fn(() => "/fake/exe/dir/.update-pending"),
    ...overrides,
  };
}

function makeReq(checker) {
  return {
    app: { get: (key) => (key === "panelUpdateChecker" ? checker : undefined) },
  };
}

let originalPkg;
let originalPlatform;

beforeEach(() => {
  vi.useFakeTimers();
  originalPkg = process.pkg;
  originalPlatform = process.platform;
  process.pkg = {};
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  vi.spyOn(process, "exit").mockImplementation(() => {});
  panelBridge.isRunning = true;
  panelBridge.stop.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  process.pkg = originalPkg;
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  vi.restoreAllMocks();
});

describe("POST /api/panel/restart -- Windows Supervisor v2 branch", () => {
  // 60f4de4f: this branch used to exit the process without ever closing out
  // an in-flight player session (panelBridge.stop() is the only thing that
  // does, via trackPlayerActivity([])) -- the next status poll after
  // relaunch would then read still-connected players as brand-new joins and
  // silently overwrite their still-open prior session.
  it("stops the bridge (closing every open player session) before exiting", async () => {
    const checker = makeChecker();
    const handler = getRestartHandler();

    await handler(makeReq(checker), makeRes());

    expect(panelBridge.stop).toHaveBeenCalledTimes(1);
    expect(process.exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(process.exit).toHaveBeenCalledWith(75);
    // Order matters: the session must close before the process that could
    // still be watching it goes down.
    const stopOrder = panelBridge.stop.mock.invocationCallOrder[0];
    const exitOrder = process.exit.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(exitOrder);
  });

  it("does not stop the bridge when it isn't running", async () => {
    panelBridge.isRunning = false;
    const checker = makeChecker();
    const handler = getRestartHandler();

    await handler(makeReq(checker), makeRes());

    expect(panelBridge.stop).not.toHaveBeenCalled();
  });

  // 45d9674d: a failure writing the marker (or any await above it) used to
  // leave checker.isApplying stuck true forever in this still-running
  // process, since only process.exit(75) -- never reached on this path --
  // would have made the flag moot. Every later restart attempt then hit the
  // 409 guard with a claim that stopped being true.
  describe("when the marker write fails", () => {
    it("resets isApplying instead of leaving it stuck true", async () => {
      const checker = makeChecker({
        writeSupervisorMarker: vi.fn(() => {
          throw new Error("EACCES: permission denied");
        }),
      });
      const handler = getRestartHandler();
      const res = makeRes();

      await handler(makeReq(checker), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(checker.isApplying).toBe(false);
      expect(process.exit).not.toHaveBeenCalled();
    });

    it("lets a subsequent restart attempt through instead of permanently reporting apply_in_progress", async () => {
      const checker = makeChecker({
        writeSupervisorMarker: vi.fn(() => {
          throw new Error("EACCES: permission denied");
        }),
      });
      const handler = getRestartHandler();

      // First attempt fails and (per the fix) resets isApplying.
      await handler(makeReq(checker), makeRes());
      expect(checker.isApplying).toBe(false);

      // Second attempt, marker write now succeeds -- must not be rejected by
      // the "already in progress" guard, because nothing actually is.
      checker.writeSupervisorMarker = vi.fn(() => "/fake/exe/dir/.update-pending");
      const secondRes = makeRes();
      await handler(makeReq(checker), secondRes);

      expect(secondRes.status).not.toHaveBeenCalledWith(409);
      expect(secondRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, supervisor: true }),
      );
    });
  });
});
