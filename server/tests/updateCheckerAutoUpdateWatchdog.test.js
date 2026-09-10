import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";

// timeout-handling-consistency-sweep, 2026-09-10 (god's fix #4, the worst
// finding for a real user): runAutoUpdate()'s own `+app_update ... validate`
// spawn -- the UNATTENDED nightly path, run with the game server already
// stopped and nobody watching -- had no idle watchdog at all, while the
// manual /install and /steam-update routes (routes/server.js) attach
// STEAM_OPERATION_IDLE_TIMEOUT_MS to the identical action. A stalled
// SteamCMD here used to hang forever; this proves the watchdog now fires,
// kills the real process, and reports a distinct STEAMCMD_STALLED reason
// instead of the generic "exited with code null" STEAMCMD_EXIT_CODE would
// give a signal-killed process.
//
// spawn() mocked at module scope with fake timers, matching
// installWarningsAndWatchdog.test.js's own established pattern for the
// sibling watchdog at routes/server.js -- a fake process that never closes
// on its own, only the watchdog's kill() ends it.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

// Real temp dir + a real (empty, never executed -- spawn is mocked) exe
// file so updateChecker.js's own fs.existsSync resolution finds it, rather
// than mocking fs itself (fs's default-export interop under vitest makes
// that fragile; a real fixture is what updateCheckerSteamOperationGuard.
// test.js already does for this same resolution step).
const steamcmdPath = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-updatechecker-watchdog-"));
const steamcmdExeName = process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh";
fs.writeFileSync(path.join(steamcmdPath, steamcmdExeName), "");

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async (key) => {
    if (key === "serverAutoUpdate") return true;
    if (key === "steamcmdPath") return steamcmdPath;
    return null;
  }),
  setSetting: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
}));

vi.mock("../services/managedContainer.js", () => ({
  resolveManagedContainer: vi.fn(async () => ({ handled: false })),
}));

const { UpdateChecker } = await import("../services/updateChecker.js");
const { getActiveSteamOperations, clearActiveSteamOperation } = await import(
  "../services/activeSteamOperations.js"
);
const dbModule = await import("../database/init.js");

function buildChecker() {
  const io = { emit: vi.fn() };
  const rconService = {
    connected: true,
    save: vi.fn(async () => ({ success: true })),
    quit: vi.fn(async () => ({ success: true })),
  };
  const serverManager = {
    getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: false })),
    startServer: vi.fn(async () => ({ success: true })),
  };
  return { checker: new UpdateChecker(io, { rconService, serverManager }), io, rconService, serverManager };
}

const installPath = path.join(os.tmpdir(), "pz-install-watchdog-test");
const normalized = path.normalize(installPath).toLowerCase();

beforeEach(() => {
  spawnMock.mockReset();
  vi.mocked(dbModule.getActiveServer).mockResolvedValue({ id: "s1", installPath });
});

afterEach(() => {
  vi.useRealTimers();
  clearActiveSteamOperation(normalized);
});

describe("UpdateChecker.runAutoUpdate(): idle watchdog on the unattended SteamCMD spawn", () => {
  it("kills a stalled process after the idle timeout and reports STEAMCMD_STALLED, not a generic exit-code failure", async () => {
    vi.useFakeTimers();
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    // Real child_process behavior: a signal-killed process reports code=null
    // to the close handler, not an exit code.
    fakeProc.kill = vi.fn(() => {
      queueMicrotask(() => fakeProc.emit("close", null));
    });
    spawnMock.mockImplementation(() => fakeProc); // never closes on its own

    const { checker } = buildChecker();

    const runPromise = expect(
      checker.runAutoUpdate({ installed: { branch: "stable", buildId: "1" } }),
    ).rejects.toMatchObject({
      autoUpdateReason: "STEAMCMD_STALLED",
      autoUpdateParams: { minutes: 10 },
    });

    // Past the 10-minute idle threshold plus one 30s watchdog tick, with the
    // fake process never having produced any stdout/stderr in between.
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    await runPromise;

    expect(fakeProc.kill).toHaveBeenCalled();
    expect(getActiveSteamOperations().has(normalized)).toBe(false); // claim released
  });

  it("does NOT fire the watchdog when the process keeps producing output", async () => {
    vi.useFakeTimers();
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    fakeProc.kill = vi.fn();
    spawnMock.mockImplementation(() => fakeProc);

    const { checker } = buildChecker();
    const runPromise = checker.runAutoUpdate({ installed: { branch: "stable", buildId: "1" } }).catch((e) => e);

    // Advance in smaller steps than the idle window, refreshing output each
    // time -- 4 x 5 minutes = 20 minutes of wall time, always under the
    // rolling 10-minute idle ceiling because output never actually stops.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      fakeProc.stdout.emit("data", Buffer.from("still working\n"));
    }
    expect(fakeProc.kill).not.toHaveBeenCalled();

    // Let it actually finish so the test doesn't leak a pending promise.
    fakeProc.emit("close", 0);
    await runPromise;
  });
});
