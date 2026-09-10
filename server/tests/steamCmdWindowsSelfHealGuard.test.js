import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";

// windows-steamcmd-selfheal, 2026-09-10 (god-dispatched, finding #2 from the
// platform-divergence-sweep, built after god's own review surfaced a NEW,
// more important finding mid-plan): before this card, POST /install and
// POST /steam-update hard-failed with a 400 on Windows when steamcmdPath
// didn't resolve to a real executable ("Windows is intentionally out of
// scope here") while Linux self-healed via ensureSteamCmdLinux(). Windows
// now self-heals too via the same ensureSteamCmdInstalled() dispatcher.
//
// The MORE IMPORTANT finding this card closes: ensureSteamCmdLinux() never
// checked or claimed Kevin's steamcmdDownloadInProgress guard (POST
// /steamcmd/download, the manual-download button's own re-entrancy guard,
// shipped the night before this card) -- a manual download and a concurrent
// auto-heal attempt wrote to the SAME file (installPath/
// steamcmd_linux.tar.gz on Linux, installPath/steamcmd.zip on Windows) with
// zero coordination, the exact corruption shape the guard was built to
// prevent, just never extended to this second call path. Building a Windows
// equivalent without closing this would have planted the identical gap on
// Windows too. ensureSteamCmdInstalled() (server.js) is the fix: the one
// place that claims the guard for BOTH platforms' auto-heal path, refusing
// with the same 409 STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS the manual route
// itself already returns to a second manual click.
//
// This suite proves that guard-conflict shape directly: a manual download
// left in flight (https.get mocked to never call back, simulating a real
// multi-second download still running), then /install called while that
// guard is held -- proving /install's own self-heal attempt is REFUSED
// (409, not a second, colliding download) rather than racing it. Also
// proves Windows now ATTEMPTS self-heal at all (instead of the old
// deterministic 400) via a separate, unguarded scenario where the mocked
// download fails fast, surfacing the new 500 STEAMCMD_AUTO_DOWNLOAD_FAILED
// shape Linux already had.
//
// Forces the WINDOWS branch via a process.platform override + fresh
// re-import (same convention as steamcmdDownloadConcurrency.test.js /
// browseFolderWindowsTimeout.test.js in this directory, not an
// isWindows-skip) since server.js reads process.platform at module load
// time (`const isWindows = process.platform === "win32"`).

const originalPlatform = process.platform;
Object.defineProperty(process, "platform", {
  value: "win32",
  configurable: true,
});

afterAll(() => {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  });
});

const { httpsGetMock } = vi.hoisted(() => ({ httpsGetMock: vi.fn() }));
vi.mock("https", () => ({
  default: { get: (...args) => httpsGetMock(...args) },
}));

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

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

// windows-steamcmd-selfheal red-gate fix, 2026-09-10: /install's own
// PRE-EXISTING running-check (resolveTargetServerForRunningCheck ->
// checkSpecificServerStopped) runs BEFORE the self-heal code this file
// tests, and its non-managed branch does a REAL host-wide process scan via
// ServerManager.scanHostForServerProcesses() -- on Windows that shells out
// to a REAL powershell.exe. Forcing process.platform to "win32" (below)
// makes server.js's OWN isWindows branch into self-heal follow that
// override correctly, but it ALSO makes this UNRELATED, earlier code
// believe it's on Windows and attempt that same real spawn -- which
// ENOENTs on any host that doesn't actually have powershell.exe (i.e. real
// Linux, and CI), and getServerProcessDetails() turns a failed scan into
// scanFailed:true, which checkSpecificServerStopped() turns into a 503
// returned BEFORE this file's own self-heal/guard code ever runs. Verified
// via a real WSL Linux run reproducing exactly this: log line
// "getServerProcessDetails: Windows process scan failed (spawn
// .../powershell.exe ENOENT), cannot determine server state" fired ahead of
// either test's own assertions. Mocked here to "nothing running anywhere"
// -- same technique and same reasoning as
// steamcmdRoutesLifecycleLockGuard.test.js's own identical mock in this
// directory -- so this suite is deterministic on every host, not just one
// that happens to have a real powershell.exe on PATH.
const scanHostForServerProcesses = vi.fn(async () => ({
  scanFailed: false,
  matched: [],
}));
vi.mock("../services/serverManager.js", async () => {
  const actual = await vi.importActual("../services/serverManager.js");
  return {
    ...actual,
    ServerManager: vi.fn().mockImplementation(function () {
      this.scanHostForServerProcesses = scanHostForServerProcesses;
    }),
  };
});

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(router, routePath) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

async function freshRouter() {
  vi.resetModules();
  const { default: router } = await import("../routes/server.js");
  return router;
}

let root;
let installPath;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-steamcmd-selfheal-"));
  installPath = path.join(root, "steamcmd");
  fs.mkdirSync(installPath, { recursive: true });
  getSettingMock.mockReset().mockResolvedValue(null);
  setSettingMock.mockReset().mockResolvedValue(undefined);
  httpsGetMock.mockReset();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Windows SteamCMD self-heal shares one download guard with the manual download button", () => {
  it("refuses /install's auto-heal with 409 STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS while a manual /steamcmd/download is still running -- and does NOT start a second, colliding download", async () => {
    // Never calls back -- simulates a real download still in flight, the
    // same shape a genuine multi-second SteamCMD download has for as long
    // as this test needs the guard held.
    // Captures the in-flight request so this test can settle it explicitly
    // before finishing -- provisionSteamCmdWindows() is fire-and-forget from
    // the manual route's own perspective (its first await, `import
    // ("unzipper")`, is a genuine async module load, so control already
    // returns to this test before https.get() is reached), and leaving it
    // truly unsettled past this test's own end would race afterEach's
    // fs.rmSync(root) against this chain's later fs.createWriteStream(),
    // an ENOENT that belongs to test hygiene, not the fix under test.
    let inFlightRequest;
    httpsGetMock.mockImplementation(() => {
      const req = new EventEmitter();
      req.destroy = vi.fn();
      inFlightRequest = req;
      return req;
    });

    const router = await freshRouter();
    const downloadHandler = getHandler(router, "/steamcmd/download");
    const installHandler = getHandler(router, "/install");

    const io = { emit: vi.fn() };
    const app = { get: (key) => (key === "io" ? io : undefined) };

    // Claims steamcmdDownloadInProgress synchronously before its own first
    // await (server.js's own documented guarantee) -- by the time this
    // resolves, the guard is already held even though the download itself
    // (provisionSteamCmdWindows, fire-and-forget from this route) hasn't
    // reached https.get() yet.
    const manualResponse = createResponse();
    await downloadHandler({ app, body: { installPath } }, manualResponse);
    expect(manualResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    // Give provisionSteamCmdWindows's own `await import("unzipper")` real
    // event-loop turns to resolve and reach https.get() before relying on
    // the guard alone -- the guard check itself doesn't need this (it's
    // synchronous), but the "did NOT start a second download" assertion
    // below does.
    await vi.waitFor(() => expect(httpsGetMock).toHaveBeenCalledTimes(1));

    const installResponse = createResponse();
    await installHandler(
      {
        app,
        body: {
          steamcmdPath: installPath,
          installPath: path.join(root, "server"),
          serverName: "TestServer",
        },
      },
      installResponse,
    );

    expect(installResponse.status).toHaveBeenCalledWith(409);
    expect(installResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS",
      }),
    );
    // The actual property under test: /install's own self-heal attempt
    // never reached its own download step. Pre-fix, ensureSteamCmdLinux
    // (and a naively-built ensureSteamCmdWindows) claimed nothing here, so
    // this second call would have started its OWN https.get() against the
    // same installPath/steamcmd.zip the manual download above is still
    // writing to.
    expect(httpsGetMock).toHaveBeenCalledTimes(1);

    // Settle the manual download's own in-flight request so its
    // fire-and-forget chain (release the guard, clean up its own zip file)
    // finishes before this test's afterEach deletes root -- provisions
    // Windows's own download-failure path emits a "error" steamcmd:status
    // as its last observable act before the guard-release .finally() runs,
    // a direct signal that chain has actually settled (not a proxy).
    io.emit.mockClear();
    inFlightRequest.emit("error", new Error("test cleanup"));
    await vi.waitFor(() =>
      expect(io.emit).toHaveBeenCalledWith(
        "steamcmd:status",
        expect.objectContaining({ status: "error" }),
      ),
    );
  });

  it("Windows now ATTEMPTS self-heal instead of hard-failing 400 -- surfaces the shared 500 STEAMCMD_AUTO_DOWNLOAD_FAILED shape when the attempt itself fails", async () => {
    httpsGetMock.mockImplementation(() => {
      const req = new EventEmitter();
      req.destroy = vi.fn();
      queueMicrotask(() =>
        req.emit("error", new Error("mock network unavailable")),
      );
      return req;
    });

    const router = await freshRouter();
    const installHandler = getHandler(router, "/install");
    const io = { emit: vi.fn() };
    const app = { get: (key) => (key === "io" ? io : undefined) };

    const response = createResponse();
    await installHandler(
      {
        app,
        body: {
          steamcmdPath: installPath,
          installPath: path.join(root, "server"),
          serverName: "TestServer",
        },
      },
      response,
    );

    // Pre-fix: deterministic 400 STEAMCMD_NOT_FOUND_AT_PATH, https.get never
    // called at all. Post-fix: self-heal is attempted (proven by the mocked
    // https.get actually firing) and its failure surfaces as the same 500
    // STEAMCMD_AUTO_DOWNLOAD_FAILED shape Linux already used.
    expect(httpsGetMock).toHaveBeenCalledTimes(1);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "STEAMCMD_AUTO_DOWNLOAD_FAILED" }),
    );
    expect(response.status).not.toHaveBeenCalledWith(400);
  });
});
