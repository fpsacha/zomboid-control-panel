import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";

// 2026-09-03, updater-sweep: runAutoUpdate() used to declare success purely
// because SteamCMD's own process exited with code 0 -- it never re-read the
// appmanifest it had just asked SteamCMD to rewrite. SteamCMD CAN exit 0
// without the install actually changing (a stale/corrupt local manifest
// cache, a branch that silently resolves to what's already installed).
// reconcilePendingUpdate() (panelUpdateChecker.js) already gets this right
// for the panel's own binary updater -- it re-checks the running version
// rather than trusting that staging happened. These tests pin the same
// discipline here: a success is only reported once the buildId on disk has
// actually advanced, and the persisted `appliedVersion` reflects what was
// verified, not the two `.version` lookups (`updateInfo.latest.version` /
// `updateInfo.installed.version`) that never existed on either object and
// silently evaluated to `null` on every real run before this fix.

let spawnImpl;
vi.mock("child_process", () => ({
  spawn: (...args) => spawnImpl(...args),
}));

vi.mock("../services/managedContainer.js", () => ({
  resolveManagedContainer: vi.fn(async () => ({ handled: false })),
}));

let steamcmdDir;
let installDir;
vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async (key) => {
    if (key === "serverAutoUpdate") return true;
    if (key === "steamcmdPath") return steamcmdDir;
    return null;
  }),
  setSetting: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => ({
    id: "server-1",
    installPath: installDir,
  })),
}));

const { UpdateChecker } = await import("../services/updateChecker.js");

// timeout-handling-consistency-sweep, 2026-09-10: runAutoUpdate() now
// attaches an idle watchdog to this spawn (fix #4, mirrors routes/server.js's
// own install/update watchdog), which unconditionally listens on
// child.stdout/child.stderr to track output activity -- a real
// child_process.spawn() result always has these (unless stdio is
// overridden), so the fixture needs them too, not just `once()`/`_fireClose`.
function fakeChild(code) {
  const handlers = {};
  return {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    once(event, cb) {
      handlers[event] = cb;
      return this;
    },
    kill: vi.fn(),
    _fireClose: () => handlers.close?.(code),
  };
}

function manifestPath(dir) {
  return path.join(dir, "steamapps", "appmanifest_380870.acf");
}

function writeManifest(dir, buildId) {
  fs.mkdirSync(path.join(dir, "steamapps"), { recursive: true });
  fs.writeFileSync(
    manifestPath(dir),
    `"AppState"\n{\n\t"appid"\t\t"380870"\n\t"buildid"\t\t"${buildId}"\n}\n`,
  );
}

function buildChecker() {
  const io = { emit: vi.fn() };
  const serverManager = {
    getServerProcessDetails: vi.fn(async () => ({
      running: false,
      scanFailed: false,
    })),
    startServer: vi.fn(async () => ({ success: true })),
  };
  const rconService = { connected: false };
  return {
    checker: new UpdateChecker(io, { rconService, serverManager }),
    io,
  };
}

describe("runAutoUpdate build-id verification", () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-autoupdate-verify-"));
    steamcmdDir = path.join(root, "steamcmd");
    installDir = path.join(root, "install");
    fs.mkdirSync(steamcmdDir, { recursive: true });
    fs.mkdirSync(installDir, { recursive: true });
    const steamcmdExe =
      process.platform === "win32"
        ? path.join(steamcmdDir, "steamcmd.exe")
        : path.join(steamcmdDir, "steamcmd.sh");
    fs.writeFileSync(steamcmdExe, "");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports failure (not success) when SteamCMD exits 0 but the installed buildId did not change", async () => {
    writeManifest(installDir, "1000");
    spawnImpl = () => {
      // Simulates the real-world failure mode: SteamCMD exits cleanly
      // without touching the manifest at all.
      const child = fakeChild(0);
      setImmediate(() => child._fireClose());
      return child;
    };

    const { checker, io } = buildChecker();
    await expect(
      checker.runAutoUpdate({
        installed: { branch: "stable", buildId: "1000" },
        latest: { buildId: "1050" },
      }),
    ).rejects.toThrow(/did not change/i);

    expect(io.emit).toHaveBeenCalledWith(
      "server:autoUpdateComplete",
      expect.objectContaining({ success: false }),
    );
    const status = await checker.getStatus();
    expect(status.lastAutoUpdateResult).toMatchObject({
      status: "failed",
      reason: "BUILD_DID_NOT_ADVANCE",
    });
  });

  it("reports success with the verified new buildId once the manifest actually advances", async () => {
    writeManifest(installDir, "1000");
    spawnImpl = () => {
      const child = fakeChild(0);
      setImmediate(() => {
        // Simulates SteamCMD actually rewriting the manifest before exiting.
        writeManifest(installDir, "1050");
        child._fireClose();
      });
      return child;
    };

    const { checker, io } = buildChecker();
    await checker.runAutoUpdate({
      installed: { branch: "stable", buildId: "1000" },
      latest: { buildId: "1050" },
    });

    expect(io.emit).toHaveBeenCalledWith(
      "server:autoUpdateComplete",
      expect.objectContaining({ success: true }),
    );
    const status = await checker.getStatus();
    expect(status.lastAutoUpdateResult).toMatchObject({
      status: "success",
      appliedVersion: "1050",
    });
  });

  it("treats an unreadable post-update manifest as a failure rather than a silent success", async () => {
    writeManifest(installDir, "1000");
    spawnImpl = () => {
      const child = fakeChild(0);
      setImmediate(() => {
        // Manifest vanishes instead of being rewritten (corrupt write, disk
        // issue) -- must not be read as "build advanced".
        fs.rmSync(manifestPath(installDir), { force: true });
        child._fireClose();
      });
      return child;
    };

    const { checker } = buildChecker();
    await expect(
      checker.runAutoUpdate({
        installed: { branch: "stable", buildId: "1000" },
        latest: { buildId: "1050" },
      }),
    ).rejects.toThrow(/did not change/i);

    const status = await checker.getStatus();
    expect(status.lastAutoUpdateResult.reason).toBe("BUILD_DID_NOT_ADVANCE");
  });
});
