import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Concurrency hunt 2026-08-29 (conversation hunt-wave5-2026-08-29). god's
// brief named "an update-apply racing anything" as an angle to check.
// server.js's /wipe route (see wipeConcurrency.test.js, same describe-block
// style reused below) already fixed exactly this shape once: its own
// comment reads "Claim the guard before the first await: awaiting between
// the check and the assignment lets a second concurrent request pass the
// check and run a parallel destructive [operation]." backupService.js's
// restoreBackup() carries the identical fix with the identical reasoning
// (2026-08-27, see backupRestoreSafety.test.js).
//
// POST /server/steam-update (and /server/install, same shape) used to
// depart from that pattern: `hasActiveSteamOperation(normalizedPath)` was
// checked at server.js ~3641, but the actual claim --
// `activeSteamOperations.set(normalizedPath, ...)` -- didn't happen until
// ~3703, with a real `await saveAndResolveSteamCmdExe(steamcmdPath)` (which
// itself awaits `getSetting`/`setSetting`) sitting in between. Two
// steam-update requests for the SAME installPath arriving close together
// (a double-click, a retried request, two admin sessions) could both pass
// the check before either claimed, and both go on to spawn SteamCMD
// against the same install directory concurrently -- SteamCMD is not
// designed for two instances writing the same install dir at once
// (manifest lock contention, partial/interleaved file writes), so this was
// the "genuinely unsafe, not merely untidy" category god asked to
// identify, not the "untidy" one.
//
// FIXED by moving the check-and-claim block to AFTER
// saveAndResolveSteamCmdExe's await (and the two synchronous manifest-
// recovery try/catches that follow it) -- matching POST /install, whose
// own check-and-claim pair was ALREADY in the correct position the whole
// time (same helper, called before its own check). Nothing awaited now
// sits between the check and the claim in either route.
//
// Proven here through the REAL route handler (not a reimplementation),
// using the same "suspend one call inside its own async gap, let the other
// run to completion first" technique wipeConcurrency.test.js already
// established for the exact same defect shape in the same file.

const getSettingMock = vi.fn(async () => null);
const setSettingMock = vi.fn(async () => {});

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(async () => {}),
  setSetting: (...args) => setSettingMock(...args),
  getSetting: (...args) => getSettingMock(...args),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
}));

// steamcmd-routes-running-check, 2026-09-08: /steam-update's running-check
// no longer reads `req.app.get("serverManager")` (that was the wrong-target
// Convention A this card fixed) -- it now calls checkSpecificServerStopped()
// via a throwaway ServerManager instance's real host scan. Default to "no PZ
// processes anywhere" so this file's own concurrency race (unrelated to the
// running-check) is what's actually under test, not a real OS scan.
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

const { default: router } = await import("../routes/server.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getSteamUpdateHandler() {
  const layer = router.stack.find(
    (entry) =>
      entry.route?.path === "/steam-update" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

let root;
let steamcmdPath;
let installPath;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-steamupdate-race-"));
  steamcmdPath = path.join(root, "steamcmd");
  installPath = path.join(root, "install");
  fs.mkdirSync(steamcmdPath, { recursive: true });
  fs.mkdirSync(installPath, { recursive: true });
  // A real, harmless, instantly-exiting fake steamcmd.sh -- getSteamCmdExe()
  // resolves this exact path via fs.existsSync, and the route really does
  // spawn() it. Exits immediately, so nothing lingers past the test.
  const fakeSteamcmd = path.join(steamcmdPath, "steamcmd.sh");
  fs.writeFileSync(fakeSteamcmd, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(fakeSteamcmd, 0o755);

  getSettingMock.mockReset();
  setSettingMock.mockReset();
  setSettingMock.mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Found while verifying an unrelated build-packaging card (hunt-wave6):
// fails outright on Windows, not by design. The fake fixture above is a
// steamcmd.sh -- but the route's own SteamCmd resolution
// (server.js getSteamCmdExe(), win32 ? "steamcmd.exe" : "steamcmd.sh") never
// even finds it there, so the request fails during resolution with a
// different status before the concurrency guard under test is ever
// reached. There's no cheap way to make a fixture that resolves on both
// platforms (a real Windows steamcmd.exe can't be a shebang script), so
// this is a genuine "cannot be tested here", matching the convention
// linuxServiceLifecycle.test.js established -- skipIf, not describe.skip,
// per that convention (this file only has the one test, but the point is
// the mechanism, not the count).
const isWindows = process.platform === "win32";

describe("POST /api/server/steam-update concurrency guard", () => {
  it.skipIf(isWindows)("a second update for the SAME install path, suspended inside saveAndResolveSteamCmdExe while the first claims and spawns, is refused with 409 once it resumes", async () => {
    const serverManager = {
      getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
    };
    const io = { emit: vi.fn() };
    const app = {
      get: (key) => (key === "serverManager" ? serverManager : key === "io" ? io : undefined),
    };

    let getSettingCalls = 0;
    let releaseSuspended;
    getSettingMock.mockImplementation(async (key) => {
      if (key !== "steamcmdPath") return null;
      getSettingCalls += 1;
      if (getSettingCalls === 1) {
        // Suspend request A inside saveAndResolveSteamCmdExe(), i.e. BEFORE
        // it ever reaches hasActiveSteamOperation() -- the check now sits
        // AFTER this await (post-fix), so A hasn't checked anything yet.
        return new Promise((resolve) => {
          releaseSuspended = () => resolve(steamcmdPath);
        });
      }
      return steamcmdPath;
    });

    const handler = getSteamUpdateHandler();
    const buildRequest = () => ({
      app,
      body: { steamcmdPath, installPath, branch: "stable" },
    });

    const responseA = createResponse();
    const responseB = createResponse();

    const callA = handler(buildRequest(), responseA);
    // Let A run into the mocked getSetting() await, where it's now suspended
    // (before its own check-and-claim, which post-fix sits AFTER this call).
    await Promise.resolve();
    await Promise.resolve();

    // B runs uninterrupted: resolves getSetting immediately, then its own
    // check-and-claim (now adjacent, no await between them) executes in one
    // synchronous stretch, claiming the path and spawning before A ever gets
    // a chance to check anything.
    const callB = handler(buildRequest(), responseB);
    await callB;

    // A resumes now and reaches its own (post-fix) check for the first
    // time -- B's claim is still live (its fake steamcmd.sh process hasn't
    // had time to exit and fire the 'close' handler that clears it yet), so
    // A must be refused instead of racing B's still-running operation.
    releaseSuspended();
    await callA;

    expect(responseB.status).not.toHaveBeenCalledWith(409);
    expect(responseA.status).toHaveBeenCalledWith(409);
    expect(responseA.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "STEAM_OPERATION_IN_PROGRESS_SERVER" }),
    );

    // B's fake steamcmd.sh process exits almost instantly, but its 'close'
    // handler (which calls the real logServerEvent, mocked above) fires on
    // a later tick, after this test's own assertions -- give it one to
    // settle so it doesn't surface as unhandled-rejection noise on an
    // unrelated later test.
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
});
