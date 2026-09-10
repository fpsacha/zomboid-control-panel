import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// fire-and-forget sweep, 2026-09-10 (god-dispatched, conversation
// fire-and-forget-sweep). POST /steamcmd/download had NO re-entrancy guard
// at all -- unlike every other async write owner in this file
// (activeSteamOperations for /steam-update and /install,
// panelUpdateChecker.js's isDownloading for the panel's own self-update).
// Two overlapping calls for the same installPath each open their own
// fs.createWriteStream(zipPath) (Windows) or shell out their own
// curl/wget to the same tarPath (Linux) -- the second write silently
// corrupts the first. Fixed by claiming a module-level
// steamcmdDownloadInProgress flag SYNCHRONOUSLY, before this route's first
// `await`, mirroring panelUpdateChecker.js's isDownloading (see that
// file's own comment on downloadUpdate() for the double-click corruption
// bug that exact ordering already exists to prevent once).
//
// Proven here through the REAL route handler (not a reimplementation),
// same technique steamUpdateConcurrency.test.js already established for
// the sibling /steam-update guard in this same file. Exercises the LINUX
// branch specifically, via a forced process.platform override (same
// convention as linuxScanExcludesOwnProcess.test.js/swapInfo.test.js in
// this directory) rather than an isWindows-skip: the guard variable and
// its claim/release points are identical on both platforms (only the
// underlying write primitive differs, fs.createWriteStream vs a shelled
// curl/wget) -- forcing the branch makes this test run, and its result
// mean the same thing, on every host this suite is authored/verified on,
// instead of silently doing nothing on a Windows dev box (the exact trap
// this file's own CI workflow has bitten on before -- see ci.yml's
// windows-packaged-updater job comment on win32-gated tests never wired
// into a job that runs on that platform).
const originalPlatform = process.platform;
Object.defineProperty(process, "platform", {
  value: "linux",
  configurable: true,
});

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, exec: (...args) => execMock(...args) };
});

const { getSettingMock, setSettingMock } = vi.hoisted(() => ({
  getSettingMock: vi.fn(async () => null),
  setSettingMock: vi.fn(async () => {}),
}));
vi.mock("../database/init.js", () => ({
  getSetting: (...args) => getSettingMock(...args),
  setSetting: (...args) => setSettingMock(...args),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
}));

afterAll(() => {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  });
});

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getDownloadHandler(router) {
  const layer = router.stack.find(
    (entry) =>
      entry.route?.path === "/steamcmd/download" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

// steamcmdDownloadInProgress (the flag under test) is module-level state in
// server.js -- a fresh import per test (vi.resetModules(), not the single
// top-level import linuxScanExcludesOwnProcess.test.js uses for a stateless
// module) is what keeps one test's deliberately-never-released guard
// (the "still downloading" test below) from leaking into the next.
async function freshRouter() {
  vi.resetModules();
  const { default: router } = await import("../routes/server.js");
  return router;
}

describe("POST /api/server/steamcmd/download concurrency guard", () => {
  it("a second overlapping call for the same installPath is refused with 409 while the first is still downloading, and never shells out its own curl/wget", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pz-steamcmd-download-race-"),
    );
    const installPath = path.join(root, "steamcmd");
    const io = { emit: vi.fn() };
    const app = { get: (key) => (key === "io" ? io : undefined) };

    try {
      getSettingMock.mockResolvedValue(null);
      setSettingMock.mockResolvedValue(undefined);
      // Never invokes its callback -- request A's curl attempt hangs
      // forever, exactly like a real multi-second download in flight.
      // Nothing in the route awaits execCb() itself (it's the classic
      // fire-and-forget shape this whole sweep is about), so callA below
      // still resolves once the route finishes kicking it off.
      execMock.mockImplementation(() => {});

      const handler = getDownloadHandler(await freshRouter());
      const buildRequest = () => ({ app, body: { installPath } });

      const responseA = createResponse();
      const responseB = createResponse();

      // No suspend-and-release dance needed here, unlike
      // steamUpdateConcurrency.test.js's /steam-update case: the guard is
      // claimed synchronously before this route's very first `await`, so
      // by the time this line returns control, request A has already
      // claimed it -- request B, called next, sees it live immediately.
      const callA = handler(buildRequest(), responseA);
      const callB = handler(buildRequest(), responseB);
      await Promise.all([callA, callB]);

      expect(responseA.status).not.toHaveBeenCalledWith(409);
      expect(responseA.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );

      expect(responseB.status).toHaveBeenCalledWith(409);
      expect(responseB.json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS",
        }),
      );

      // The actual property under test: B was refused BEFORE it ever
      // reached its own download step. Pre-fix, both A and B would have
      // called exec() with their own curl command against the same
      // tarPath -- this proves only A's ever ran.
      expect(execMock).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the guard releases once the in-flight download finishes (fails), so a later call is no longer refused", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pz-steamcmd-download-race2-"),
    );
    const installPath = path.join(root, "steamcmd");
    const io = { emit: vi.fn() };
    const app = { get: (key) => (key === "io" ? io : undefined) };

    try {
      getSettingMock.mockResolvedValue(null);
      setSettingMock.mockResolvedValue(undefined);

      const callbacks = [];
      execMock.mockImplementation((_cmd, _opts, cb) => {
        callbacks.push(cb);
      });

      const handler = getDownloadHandler(await freshRouter());
      const buildRequest = () => ({ app, body: { installPath } });

      const responseA = createResponse();
      await handler(buildRequest(), responseA);

      // curl (callbacks[0]) fails -> tryDownload() retries with wget
      // synchronously, registering a second exec() call in the same
      // stack -> wget (callbacks[1]) also fails, with no further
      // fallback, which is the route's own "give up" branch that
      // releases the guard.
      expect(callbacks).toHaveLength(1);
      callbacks[0](new Error("curl: command not found"));
      expect(callbacks).toHaveLength(2);
      callbacks[1](new Error("wget: command not found"));

      const responseC = createResponse();
      await handler(buildRequest(), responseC);

      expect(responseC.status).not.toHaveBeenCalledWith(409);
      expect(responseC.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
