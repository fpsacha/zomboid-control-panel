import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { setSetting } from "../database/init.js";

// 2026-08-26 install-failure hunt findings #6 and #1. #6: the game files
// installing is the expensive, hard-to-redo part -- a failure in an
// auxiliary write AFTER that (the RCON .ini pre-create, the startup
// script) used to only log.warn() server-side while install:complete still
// said success:true with no trace of it anywhere the operator could see.
// Now collected into a `warnings` array on the same success:true payload
// instead of either a false flat failure or silence. #1: a watchdog-killed
// SteamCMD process reports code=null to Node's close handler, which used
// to render the literal word "null" in "Installation failed with exit code
// null" -- now its own distinct, accurate message.
//
// spawn() is mocked at module scope, matching unvalidatedPathFixes.test.js's
// established pattern -- server.js binds it as a live import at load time.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
}));

// steamcmd-routes-running-check, 2026-09-08: POST /install now calls
// checkSpecificServerStopped() (via resolveTargetServerForRunningCheck),
// which scans the whole host for real via a throwaway ServerManager
// instance. Keep scoreServerProcessOwnership() real (importActual) and only
// replace the host scan, same pattern as deleteFilesGuards.test.js -- these
// tests are about install-warnings/watchdog behavior, not this guard, so
// default to "no PZ processes anywhere" (the check passes through) rather
// than hitting a real OS process scan on every test.
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

// Real writeFileAtomic by default (writes to real temp-directory paths
// below) -- each test overrides it only for the one call it wants to fail,
// by inspecting the target path, rather than mocking the whole filesystem.
// `realHolder` is populated from the mock factory's own importOriginal(),
// the only way to reach the real implementation once the module is mocked.
const { writeFileAtomicMock, realHolder } = vi.hoisted(() => ({
  writeFileAtomicMock: vi.fn(),
  realHolder: { fn: null },
}));
vi.mock("../utils/fileWriteQueue.js", async (importOriginal) => {
  const actual = await importOriginal();
  realHolder.fn = actual.writeFileAtomic;
  return {
    ...actual,
    writeFileAtomic: (...args) => writeFileAtomicMock(...args),
  };
});

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

function getRouteHandler(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

// Resolves with the install:complete payload the route handler eventually
// emits, however many ticks that takes -- deterministic, no arbitrary waits.
function fakeIoCapturingComplete() {
  let resolveComplete;
  const completePromise = new Promise((resolve) => {
    resolveComplete = resolve;
  });
  const emitted = [];
  const io = {
    emit: vi.fn((event, payload) => {
      emitted.push({ event, payload });
      if (event === "install:complete") resolveComplete(payload);
    }),
  };
  return { io, completePromise, emitted };
}

describe("POST /api/server/install -- warnings array (finding #6) and watchdog message (finding #1)", () => {
  let tmpRoot;
  let installPath;
  let zomboidDataPath;
  let steamcmdPath;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-install-test-"));
    installPath = path.join(tmpRoot, "server");
    zomboidDataPath = path.join(tmpRoot, "data");
    steamcmdPath = path.join(tmpRoot, "steamcmd");
    fs.mkdirSync(installPath, { recursive: true });
    fs.mkdirSync(zomboidDataPath, { recursive: true });
    fs.mkdirSync(steamcmdPath, { recursive: true });
    // getSteamCmdExe() does a real fs.existsSync check -- give it a real
    // file rather than mocking fs globally (ensureWritableDirectory below
    // needs real fs behavior against the real temp dirs above).
    const steamcmdExeName = process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh";
    fs.writeFileSync(path.join(steamcmdPath, steamcmdExeName), "");
    // spawnMock below fakes a successful SteamCMD run by firing close(0)
    // directly -- it never actually writes game files into installPath the
    // way a real steamcmd process would. Since 2026-08-26's
    // INSTALL_MISSING_GAME_FILES check, a "successful" install with none of
    // the real PZ markers present would otherwise (correctly) collect that
    // warning in every test in this file, including the ones deliberately
    // testing a DIFFERENT warning. Writing one marker here is what a real
    // install would have left behind at this point.
    fs.writeFileSync(path.join(installPath, "ProjectZomboid64.json"), "{}");

    spawnMock.mockReset();
    writeFileAtomicMock.mockReset();
    writeFileAtomicMock.mockImplementation((...args) => realHolder.fn(...args));
    // Reset to the shared no-op default before each test -- individual
    // tests below override this with a key-conditional implementation to
    // fail one specific setSetting call; without a reset here, that
    // override would leak into whichever test runs next.
    vi.mocked(setSetting).mockReset();
    vi.mocked(setSetting).mockImplementation(async () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function baseBody(overrides = {}) {
    return {
      steamcmdPath,
      installPath,
      serverName: "TestServer",
      branch: "public",
      zomboidDataPath,
      adminPassword: "adminpw",
      rconPassword: "rconpassword123",
      rconPort: 27015,
      serverPort: 16261,
      minMemory: 2,
      maxMemory: 4,
      ...overrides,
    };
  }

  it("reports success with an EMPTY warnings array when nothing fails (baseline, proves the plumbing didn't change normal behavior)", async () => {
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });

    const { default: router } = await import("../routes/server.js");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(true);
    expect(payload.warnings).toEqual([]);
  });

  // docker-unraid-onboarding, 2026-09-09: this route hardcoded
  // setSetting("rconHost", "127.0.0.1") unconditionally even after
  // discovery.js's create-from-discovery got RCON_HOST-aware -- a fresh
  // install on the exact two-container Unraid topology the other route was
  // fixed for still wrote an address that could never connect.
  it("resolves rconHost from RCON_HOST for the two-container Unraid topology, not a hardcoded 127.0.0.1", async () => {
    vi.stubEnv("RCON_HOST", "projectzomboid");
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });

    const { default: router } = await import("../routes/server.js");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    await completePromise;
    expect(setSetting).toHaveBeenCalledWith("rconHost", "projectzomboid");
    vi.unstubAllEnvs();
  });

  // 2026-08-26 partial-failure-state hunt: these setSetting() calls were
  // bare awaits with nothing catching a throw, and this app's
  // process.on("unhandledRejection") handler (server/index.js) calls
  // fatalExit(), which exits the WHOLE PANEL PROCESS. Before the fix, a
  // rejection here would never resolve completePromise at all -- this test
  // would time out (or the real process would simply die) rather than see
  // an install:complete event. Reaching the assertions below is itself
  // proof the crash path is closed, independent of what they check.
  it("collects an INSTALL_SETTINGS_SAVE_FAILED warning instead of crashing the panel when saving settings throws, and still reports success:true", async () => {
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });
    // Keyed on "serverPath" rather than "the next call regardless of args":
    // saveAndResolveSteamCmdExe() (CodeQL js/command-line-injection fix,
    // 2026-08-27) now saves steamcmdPath earlier in this same route, before
    // this block's own setSetting calls even start -- a bare
    // mockRejectedValueOnce() would silently reject THAT call instead of
    // the one this test is actually about, the same fragility a call-count
    // assumption always has once an earlier call is added upstream.
    vi.mocked(setSetting).mockImplementation(async (key) => {
      if (key === "serverPath") throw new Error("EBUSY: database locked");
    });

    const { default: router } = await import("../routes/server.js");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(true);
    expect(payload.warnings).toContainEqual(
      expect.objectContaining({
        progressCode: "INSTALL_SETTINGS_SAVE_FAILED",
        params: expect.objectContaining({ reason: expect.stringContaining("database locked") }),
      }),
    );
  });

  it("collects an INSTALL_SETTINGS_SAVE_FAILED warning when saving the RCON settings throws, and still reports success:true", async () => {
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });
    // Keyed on "rconPassword" rather than a call-count sequence -- a count
    // assumption breaks the moment any earlier setSetting call is added
    // upstream (as saveAndResolveSteamCmdExe's steamcmdPath save now is,
    // CodeQL js/command-line-injection fix 2026-08-27), and would then
    // silently fail a DIFFERENT settings block while this test still passes
    // (both blocks report the same INSTALL_SETTINGS_SAVE_FAILED
    // progressCode, so a wrong-block failure isn't even visible here).
    vi.mocked(setSetting).mockImplementation(async (key) => {
      if (key === "rconPassword") throw new Error("EBUSY: database locked");
    });

    const { default: router } = await import("../routes/server.js");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(true);
    expect(payload.warnings).toContainEqual(
      expect.objectContaining({ progressCode: "INSTALL_SETTINGS_SAVE_FAILED" }),
    );
  });

  it("collects an INSTALL_RCON_INI_PRECREATE_FAILED warning instead of silently swallowing the failure, and still reports success:true", async () => {
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });
    writeFileAtomicMock.mockImplementation((targetPath, ...rest) => {
      if (String(targetPath).endsWith(".ini")) {
        throw new Error("EACCES: permission denied");
      }
      return realHolder.fn(targetPath, ...rest);
    });

    const { default: router } = await import("../routes/server.js");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(true);
    expect(payload.warnings).toHaveLength(1);
    expect(payload.warnings[0]).toMatchObject({
      progressCode: "INSTALL_RCON_INI_PRECREATE_FAILED",
      params: { reason: expect.stringContaining("permission denied") },
    });
  });

  it("collects an INSTALL_STARTUP_SCRIPT_FAILED warning instead of silently swallowing the failure, and still reports success:true", async () => {
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });
    writeFileAtomicMock.mockImplementation((targetPath, ...rest) => {
      if (String(targetPath).endsWith(".bat") || String(targetPath).endsWith(".sh")) {
        throw new Error("ENOSPC: no space left on device");
      }
      return realHolder.fn(targetPath, ...rest);
    });

    const { default: router } = await import("../routes/server.js");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(true);
    expect(payload.warnings).toHaveLength(1);
    expect(payload.warnings[0]).toMatchObject({
      progressCode: "INSTALL_STARTUP_SCRIPT_FAILED",
      params: { reason: expect.stringContaining("no space left") },
    });
  });

  // 2026-08-26 bug hunt: SteamCMD exiting 0 was trusted as sufficient proof
  // the game files were actually installed -- it can exit 0 after a
  // rate-limited, interrupted, or otherwise incomplete download. This test
  // removes the marker beforeEach wrote (simulating exactly that: SteamCMD
  // "succeeded" but the install directory has no real PZ files in it) and
  // proves the gap that report was about no longer exists.
  it("collects an INSTALL_MISSING_GAME_FILES warning when SteamCMD exits 0 but no PZ marker file exists at the install path", async () => {
    fs.rmSync(path.join(installPath, "ProjectZomboid64.json"));

    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });

    const { default: router } = await import("../routes/server.js");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    // Still success:true -- the marker check is a warning, not a hard
    // failure, matching the sibling INI/startup-script checks above rather
    // than inventing a new, harsher failure mode for this one.
    expect(payload.success).toBe(true);
    expect(payload.warnings).toHaveLength(1);
    expect(payload.warnings[0]).toMatchObject({
      progressCode: "INSTALL_MISSING_GAME_FILES",
    });
  });

  it("does NOT warn when a different PZ marker (not ProjectZomboid64.json) is what's actually present -- any one marker is enough", async () => {
    fs.rmSync(path.join(installPath, "ProjectZomboid64.json"));
    fs.writeFileSync(path.join(installPath, "StartServer64.bat"), "");

    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });

    const { default: router } = await import("../routes/server.js");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(true);
    expect(payload.warnings).toEqual([]);
  });

  it("a watchdog-killed process reports INSTALL_WATCHDOG_KILLED with a real minute count, never the literal word \"null\"", async () => {
    vi.useFakeTimers();
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    // Real child_process behavior: a signal-killed process reports
    // code=null to the close handler, not an exit code.
    fakeProc.kill = vi.fn(() => {
      queueMicrotask(() => fakeProc.emit("close", null));
    });
    spawnMock.mockImplementation(() => fakeProc); // never emits close on its own -- only the watchdog's kill() does

    const { default: router } = await import("../routes/server.js");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    const handlerDone = getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    // Past the 10-minute idle threshold plus one 30s watchdog tick, with the
    // fake process never having produced any stdout/stderr in between.
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    await handlerDone;

    const payload = await completePromise;
    expect(fakeProc.kill).toHaveBeenCalled();
    expect(payload.success).toBe(false);
    expect(payload.progressCode).toBe("INSTALL_WATCHDOG_KILLED");
    expect(payload.message).not.toContain("exit code null");
    expect(payload.params).toEqual({ minutes: 10 });
  });
});

// 2026-08-26, same-night follow-up: the wizard's UPnP checkbox saved a
// global legacy setting (setSetting("useUpnp", ...)) that nothing ever
// read -- the actual mechanism, a real UPnP= line in the server's own
// .ini, only ever got written by the separate /configure-network endpoint,
// which /install never called. Fixed by decoupling the ini pre-create from
// rconPassword (previously the whole block, ini included, was gated on a
// password being set) so a server's UPnP choice reaches its .ini
// regardless of whether RCON was configured at install time.
describe("POST /api/server/install -- UPnP reaches the server's own .ini, not just a global setting nothing reads", () => {
  let tmpRoot;
  let installPath;
  let zomboidDataPath;
  let steamcmdPath;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-install-upnp-test-"));
    installPath = path.join(tmpRoot, "server");
    zomboidDataPath = path.join(tmpRoot, "data");
    steamcmdPath = path.join(tmpRoot, "steamcmd");
    fs.mkdirSync(installPath, { recursive: true });
    fs.mkdirSync(zomboidDataPath, { recursive: true });
    fs.mkdirSync(steamcmdPath, { recursive: true });
    const steamcmdExeName = process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh";
    fs.writeFileSync(path.join(steamcmdPath, steamcmdExeName), "");

    spawnMock.mockReset();
    writeFileAtomicMock.mockReset();
    writeFileAtomicMock.mockImplementation((...args) => realHolder.fn(...args));
    // See the sibling describe block's beforeEach for why this reset is
    // needed now that saveAndResolveSteamCmdExe() also calls setSetting.
    vi.mocked(setSetting).mockReset();
    vi.mocked(setSetting).mockImplementation(async () => {});
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function baseBody(overrides = {}) {
    return {
      steamcmdPath,
      installPath,
      serverName: "UpnpTestServer",
      branch: "public",
      zomboidDataPath,
      serverPort: 16261,
      minMemory: 2,
      maxMemory: 4,
      ...overrides,
    };
  }

  function iniPath() {
    return path.join(zomboidDataPath, "Server", "UpnpTestServer.ini");
  }

  it("writes UPnP=false into the pre-created ini even with NO rcon password given -- previously the whole ini pre-create was skipped in this case", async () => {
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });

    const { default: router } = await import("../routes/server.js");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody({ useUpnp: false }), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(true);
    const content = fs.readFileSync(iniPath(), "utf-8");
    expect(content).toContain("UPnP=false");
    expect(content).not.toContain("RCONPassword=");
  });

  it("writes UPnP=true and the RCON credentials together into the SAME pre-created ini when both are given", async () => {
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });

    const { default: router } = await import("../routes/server.js");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      {
        body: baseBody({ useUpnp: true, rconPassword: "rconpw123", rconPort: 27015 }),
        app: { get: (k) => (k === "io" ? io : undefined) },
      },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(true);
    const content = fs.readFileSync(iniPath(), "utf-8");
    expect(content).toContain("UPnP=true");
    expect(content).toContain("RCONPassword=rconpw123");
    expect(content).toContain("RCONPort=27015");
  });
});
