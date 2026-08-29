import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// LINUX BUG HUNT (2026-08-29, linux-bug-hunt-2026-08-29): the custom-start-
// command path (ServerManager.startServer()'s `this.startCommand` branch)
// deliberately allows a no-extension command on Linux --
// ALLOWED_CMD_EXTENSIONS is `[".sh", ""]` there, specifically because a
// compiled/extensionless launcher binary is common on Linux. But unlike the
// ".sh" branch right next to it (which does `fs.chmodSync(resolvedCmd,
// 0o750)` before spawning), the no-extension branch spawned resolvedCmd
// DIRECTLY with no chmod at all -- and a direct (non-bash-wrapped) spawn
// requires the OS execute bit to already be set. A freshly downloaded,
// SteamCMD-installed, or scp/rsync-copied file commonly does NOT have that
// bit set, so every such launcher failed with EACCES on Linux, 100% of the
// time, regardless of what the operator configured -- the exact "worked on
// my Windows dev box, dead on Linux" class this hunt exists to catch.
//
// Only mocks database/init.js (loadConfig()'s data source) and the logger
// (keep test output quiet); everything else -- fs, real chmod, a real
// child_process.spawn -- runs for real against a real extensionless file on
// disk, so this is a genuine EACCES repro, not a mocked simulation of one.

const isLinux = process.platform !== "win32";

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer: (...args) => getActiveServer(...args),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { ServerManager } = await import("../services/serverManager.js");

(isLinux ? describe : describe.skip)(
  "startServer() with a no-extension custom command on Linux",
  () => {
    let tmpDir;
    let scriptPath;
    let spawnedPid;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "pz-linux-launch-noext-"),
      );
      // A real, valid, extensionless launcher: sleeps well past the 4s
      // immediate-crash detection window instead of exiting right away, so
      // a genuine start is distinguishable from "exited immediately", which
      // startServer() (correctly) treats as a startup failure on its own.
      scriptPath = path.join(tmpDir, "launcher");
      fs.writeFileSync(scriptPath, "#!/bin/sh\nsleep 30\n", "utf8");
      // Deliberately NOT chmod'd -- 0o644 is what a plain file write leaves
      // behind, and is exactly what a copy/download commonly leaves behind
      // too. This is the precondition the bug needs.
      fs.chmodSync(scriptPath, 0o644);

      getActiveServer.mockResolvedValue({
        serverName: "LinuxNoExtLauncher",
        serverPath: tmpDir,
        startCommand: scriptPath,
      });
    });

    afterEach(() => {
      if (spawnedPid) {
        try {
          process.kill(spawnedPid, "SIGKILL");
        } catch {
          /* already gone */
        }
        spawnedPid = undefined;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("chmods the extensionless command before spawning it, so a non-executable file still starts", async () => {
      expect(fs.statSync(scriptPath).mode & 0o111).toBe(0);

      const manager = new ServerManager();
      const result = await manager.startServer({ skipRunningCheck: true });
      spawnedPid = manager.serverProcess?.pid;

      expect(result.success).toBe(true);
      // The fix's own observable effect: chmodSync actually ran.
      expect(fs.statSync(scriptPath).mode & 0o100).not.toBe(0);
    });

    it("fails with a permission error if the exec bit is never set (proves the test can detect the bug)", async () => {
      // Positive control: simulate the pre-fix code by pointing at a
      // command this test process itself cannot chmod (chmod to 0 perms and
      // drop the ability to fix it up isn't reliable as root in CI, so
      // instead assert the DIRECT mechanism -- spawning an un-executable
      // file throws EACCES -- independently of ServerManager, proving the
      // scenario is real and the earlier assertion isn't a false pass).
      const { spawn } = await import("child_process");
      await new Promise((resolve) => {
        const proc = spawn(scriptPath, [], { stdio: "ignore" });
        proc.once("error", (err) => {
          expect(err.code).toBe("EACCES");
          resolve();
        });
        proc.once("exit", () => {
          throw new Error(
            "expected EACCES on a non-executable file, but spawn succeeded -- positive control is broken",
          );
        });
      });
    });
  },
);
