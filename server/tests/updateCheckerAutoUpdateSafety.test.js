import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async (key) => {
    if (key === "serverAutoUpdate") return true;
    if (key === "steamcmdPath") return "/opt/steamcmd";
    return null;
  }),
  setSetting: vi.fn(),
  getActiveServer: vi.fn(async () => ({
    id: "server-1",
    installPath: "/opt/pzserver",
  })),
}));

vi.mock("../services/managedContainer.js", () => ({
  resolveManagedContainer: vi.fn(async () => ({ handled: false })),
}));

const { UpdateChecker } = await import("../services/updateChecker.js");
const dbModule = await import("../database/init.js");

// runAutoUpdate() used to call serverManager.checkServerRunning(), which
// collapses a failed process-detection scan into `false` -- the same value
// as a confirmed-stopped server. This is the unattended auto-update path
// (no human reviewing the result before SteamCMD runs), so a silent scan
// failure here used to skip the RCON save+quit sequence entirely and run
// `steamcmd ... validate` straight against a possibly-live install.
describe("UpdateChecker.runAutoUpdate fails closed when process detection can't confirm the server is stopped", () => {
  function buildChecker({ getServerProcessDetails, startServer }) {
    const io = { emit: vi.fn() };
    const rconService = {
      connected: true,
      save: vi.fn(async () => ({ success: true })),
      quit: vi.fn(async () => ({ success: true })),
    };
    const serverManager = {
      getServerProcessDetails,
      startServer: startServer || vi.fn(async () => ({ success: true })),
    };
    const checker = new UpdateChecker(io, { rconService, serverManager });
    return { checker, io, rconService, serverManager };
  }

  it("abandons the update instead of assuming the server is stopped (scanFailed)", async () => {
    const { checker, io, serverManager } = buildChecker({
      getServerProcessDetails: vi.fn(async () => ({
        running: false,
        scanFailed: true,
      })),
    });

    await expect(
      checker.runAutoUpdate({ installed: { branch: "stable" } }),
    ).rejects.toThrow(/could not verify whether the server is running/i);

    expect(io.emit).toHaveBeenCalledWith(
      "server:autoUpdateComplete",
      expect.objectContaining({ success: false }),
    );
    // Never reached the "was running, needs restart after update" path.
    expect(serverManager.startServer).not.toHaveBeenCalled();
  });

  it("aborts if detection breaks again mid-wait for the server to stop", async () => {
    let call = 0;
    const { checker, io } = buildChecker({
      getServerProcessDetails: vi.fn(async () => {
        call += 1;
        // First call: confirmed running (enters the stop sequence).
        if (call === 1) return { running: true, scanFailed: false };
        // Second call (inside the "wait for stop" loop): detection breaks.
        return { running: false, scanFailed: true };
      }),
    });

    await expect(
      checker.runAutoUpdate({ installed: { branch: "stable" } }),
    ).rejects.toThrow(/lost the ability to verify/i);

    expect(io.emit).toHaveBeenCalledWith(
      "server:autoUpdateComplete",
      expect.objectContaining({ success: false }),
    );
  });
});

// 2026-08-26: a live socket event only reaches whoever happens to be
// watching at the moment it fires -- exactly the operator this unattended
// feature is for is guaranteed not to be. These pin the persisted
// lastAutoUpdateResult (phase + a stable reason key, never a raw message)
// that any page can read cold, long after the run finished.
describe("UpdateChecker persists lastAutoUpdateResult so it survives past the live event", () => {
  function buildChecker({ getServerProcessDetails, startServer, rconOverrides } = {}) {
    const io = { emit: vi.fn() };
    const rconService = {
      connected: true,
      save: vi.fn(async () => ({ success: true })),
      quit: vi.fn(async () => ({ success: true })),
      ...rconOverrides,
    };
    const serverManager = {
      getServerProcessDetails,
      startServer: startServer || vi.fn(async () => ({ success: true })),
    };
    const checker = new UpdateChecker(io, { rconService, serverManager });
    return { checker, io, rconService, serverManager };
  }

  afterEach(() => {
    vi.mocked(dbModule.setSetting).mockClear();
  });

  it("records phase 'not-started' and serverUp:null for a pre-flight failure (initial scan failed) -- nothing was ever touched", async () => {
    const { checker } = buildChecker({
      getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: true })),
    });

    await expect(checker.runAutoUpdate({ installed: { branch: "stable" } })).rejects.toThrow();

    const status = await checker.getStatus();
    expect(status.lastAutoUpdateResult).toMatchObject({
      status: "failed",
      reason: "INITIAL_SCAN_FAILED",
      phase: "not-started",
      serverUp: null,
      dismissed: false,
    });
  });

  it("records phase 'before-stop' and serverUp:true for a failure before the server was ever stopped (RCON not connected)", async () => {
    const { checker } = buildChecker({
      getServerProcessDetails: vi.fn(async () => ({ running: true, scanFailed: false })),
      rconOverrides: { connected: false },
    });

    await expect(checker.runAutoUpdate({ installed: { branch: "stable" } })).rejects.toThrow();

    const status = await checker.getStatus();
    expect(status.lastAutoUpdateResult).toMatchObject({
      status: "failed",
      reason: "RCON_NOT_CONNECTED",
      phase: "before-stop",
      serverUp: true,
    });
  });

  it("does NOT attempt the finally-block restart for a before-stop failure -- the server was never actually stopped, so a restart is not just unneeded but guaranteed to throw", async () => {
    const { checker, serverManager } = buildChecker({
      getServerProcessDetails: vi.fn(async () => ({ running: true, scanFailed: false })),
      rconOverrides: { connected: false },
    });

    await expect(checker.runAutoUpdate({ installed: { branch: "stable" } })).rejects.toThrow();

    expect(serverManager.startServer).not.toHaveBeenCalled();
  });

  // 2026-09-08, god's four questions applied to this state machine: can a
  // scheduled auto-update interrupt an active game with no notice at all?
  // scheduleAutoUpdate()'s own warning announcement fires exactly once, at
  // detection time -- if RCON happened to be disconnected at that instant
  // (a transient blip, not this test's concern), the warning is silently
  // skipped there while the timer still runs to completion, and if RCON
  // reconnects before the timer fires, runAutoUpdate() would previously
  // stop the server with players never having been told anything. A second,
  // immediate announcement right before save+quit closes that gap
  // regardless of what happened minutes earlier.
  it("announces to connected players immediately before stopping the server, in addition to scheduleAutoUpdate()'s own earlier warning", async () => {
    const calls = [];
    let call = 0;
    const { checker, rconService } = buildChecker({
      // First call: confirmed running (enters the stop sequence). Second
      // call (inside the "wait for stop" loop): confirmed stopped, so the
      // run proceeds to the natural STEAMCMD_NOT_FOUND failure below
      // instead of looping for the real 5-minute stop-wait deadline.
      getServerProcessDetails: vi.fn(async () => {
        call += 1;
        return { running: call === 1, scanFailed: false };
      }),
      rconOverrides: {
        serverMessage: vi.fn(async (message) => {
          calls.push(message);
          return { success: true };
        }),
        save: vi.fn(async () => {
          calls.push("save");
          return { success: true };
        }),
      },
    });

    await expect(
      checker.runAutoUpdate({ installed: { branch: "stable" } }),
    ).rejects.toThrow(/steamcmd not found/i);

    expect(rconService.serverMessage).toHaveBeenCalledWith(
      expect.stringMatching(/restarting now/i),
      expect.objectContaining({ skipLog: true }),
    );
    // Announced BEFORE the world is saved and the server is quit -- a
    // player needs the message before the kick, not logged alongside it.
    expect(calls).toEqual([expect.stringMatching(/restarting now/i), "save"]);
  });

  it("does not abort the update when the imminent-announcement itself fails -- best-effort, same posture as scheduleAutoUpdate()'s own warning", async () => {
    let call = 0;
    const { checker, rconService } = buildChecker({
      // First call: confirmed running (enters the stop sequence). Second
      // call (inside the "wait for stop" loop): confirmed stopped, so the
      // run proceeds past save+quit to the STEAMCMD_NOT_FOUND failure
      // below -- steamcmdPath is mocked to a path that doesn't exist on
      // this test runner, so this reaches a real, natural failure point
      // without needing to mock child_process.
      getServerProcessDetails: vi.fn(async () => {
        call += 1;
        return { running: call === 1, scanFailed: false };
      }),
      rconOverrides: {
        serverMessage: vi.fn(async () => {
          throw new Error("rcon socket reset");
        }),
      },
    });

    await expect(
      checker.runAutoUpdate({ installed: { branch: "stable" } }),
    ).rejects.toThrow(/steamcmd not found/i);

    // The failure came from STEAMCMD_NOT_FOUND, well past the announcement
    // -- proof the thrown announcement error was swallowed (best-effort)
    // rather than aborting the update on its own.
    expect(rconService.save).toHaveBeenCalled();
    expect(rconService.quit).toHaveBeenCalled();
  });

  it("carries the world-save failure's own detail as a translatable param, not a raw message baked into `reason`", async () => {
    const { checker } = buildChecker({
      getServerProcessDetails: vi.fn(async () => ({ running: true, scanFailed: false })),
      rconOverrides: { save: vi.fn(async () => ({ success: false, error: "disk full" })) },
    });

    await expect(checker.runAutoUpdate({ installed: { branch: "stable" } })).rejects.toThrow();

    const status = await checker.getStatus();
    expect(status.lastAutoUpdateResult.reason).toBe("SAVE_FAILED");
    expect(status.lastAutoUpdateResult.params).toEqual({ reason: "disk full" });
  });

  it("records phase 'updating' and corrects serverUp to true once the finally-block restart succeeds (SteamCMD failed after a clean stop)", async () => {
    let scanCall = 0;
    const { checker } = buildChecker({
      getServerProcessDetails: vi.fn(async () => {
        scanCall += 1;
        if (scanCall === 1) return { running: true, scanFailed: false }; // initial: running
        return { running: false, scanFailed: false }; // stop-wait loop: confirmed stopped
      }),
      startServer: vi.fn(async () => ({ success: true })),
    });
    // steamcmdPath resolves to /opt/steamcmd, whose steamcmd.sh/steamcmd
    // binaries won't exist in a test sandbox -- that's fine, it's still a
    // failure reached AFTER the server was confirmed stopped, which is
    // exactly the phase this test targets.

    await expect(checker.runAutoUpdate({ installed: { branch: "stable" } })).rejects.toThrow(/steamcmd not found/i);

    const status = await checker.getStatus();
    expect(status.lastAutoUpdateResult).toMatchObject({
      status: "failed",
      reason: "STEAMCMD_NOT_FOUND",
      phase: "updating",
      serverUp: true, // corrected by the finally block's successful restart
    });
  });

  it("corrects serverUp to false when the finally-block restart itself fails -- the server is actually down", async () => {
    let scanCall = 0;
    const { checker } = buildChecker({
      getServerProcessDetails: vi.fn(async () => {
        scanCall += 1;
        if (scanCall === 1) return { running: true, scanFailed: false };
        return { running: false, scanFailed: false };
      }),
      startServer: vi.fn(async () => ({ success: false, error: "port already in use" })),
    });

    await expect(checker.runAutoUpdate({ installed: { branch: "stable" } })).rejects.toThrow();

    const status = await checker.getStatus();
    expect(status.lastAutoUpdateResult.serverUp).toBe(false);
  });

  it("records a success result with the applied version, not just a bare success flag", async () => {
    // A real success run needs an actual steamcmd binary on disk to spawn,
    // which this unit test sandbox doesn't have -- exercises
    // _recordAutoUpdateResult() directly instead, the exact call
    // runAutoUpdate()'s own success branch makes.
    const { checker } = buildChecker({
      getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: false })),
    });
    await checker._recordAutoUpdateResult({ status: "success", at: "2026-08-26T00:00:00.000Z", appliedVersion: "42.13.0" });

    const status = await checker.getStatus();
    expect(status.lastAutoUpdateResult).toMatchObject({
      status: "success",
      appliedVersion: "42.13.0",
      dismissed: false,
    });
  });

  it("a fresh run's result always re-arms dismissed:false, even if the previous one was dismissed", async () => {
    const { checker } = buildChecker({
      getServerProcessDetails: vi.fn(async () => ({ running: true, scanFailed: false })),
      rconOverrides: { connected: false },
    });

    await expect(checker.runAutoUpdate({ installed: { branch: "stable" } })).rejects.toThrow();
    await checker.dismissAutoUpdateResult();
    expect((await checker.getStatus()).lastAutoUpdateResult.dismissed).toBe(true);

    await expect(checker.runAutoUpdate({ installed: { branch: "stable" } })).rejects.toThrow();
    expect((await checker.getStatus()).lastAutoUpdateResult.dismissed).toBe(false);
  });

  it("getStatus() falls back to the persisted setting on a cold instance that has not run an auto-update yet this process", async () => {
    const persisted = { status: "failed", reason: "STOP_TIMEOUT", phase: "before-stop", serverUp: true, dismissed: false, at: "2026-08-26T00:00:00.000Z" };
    vi.mocked(dbModule.getSetting).mockImplementationOnce(async (key) =>
      key === "lastAutoUpdateResult" ? persisted : null,
    );
    const io = { emit: vi.fn() };
    const checker = new UpdateChecker(io, { rconService: {}, serverManager: {} });

    const status = await checker.getStatus();
    expect(status.lastAutoUpdateResult).toEqual(persisted);
  });
});
