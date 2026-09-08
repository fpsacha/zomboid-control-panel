import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// GH #147, second symptom: a real user's SteamCMD install failed because
// SteamCMD writes its own client state ($HOME/Steam) separately from the
// game files, and the bundled systemd unit's ProtectHome=read-only blocks
// that write unconditionally (see buildLinuxSteamCmdEnv in routes/server.js
// for the full mechanism, verified for real on a systemd host). A separate
// Discord report -- a workshop folder SteamCMD "never produced," with the
// base server already working -- is the same root from the other end:
// Project Zomboid's dedicated server shells out to its OWN SteamCMD
// internally at startup to sync WorkshopItems=, and that child inherits
// whatever env the JVM itself was spawned with. This test proves the ACTUAL
// spawned process sees the redirected HOME, not just that the helper
// function computes the right string -- a real script inherits the child's
// real environment and writes it to a file this test then reads back.
//
// Only mocks database/init.js (loadConfig()'s data source) and the logger;
// everything else -- fs, real chmod, a real child_process.spawn -- runs for
// real, same posture as linuxLaunchExtensionlessCustomCommand.test.js.

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
  "startServer() redirects HOME for the spawned PZ process, not just SteamCMD's own calls",
  () => {
    let tmpDir;
    let scriptPath;
    let homeProbePath;
    let spawnedPid;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "pz-linux-home-override-"),
      );
      homeProbePath = path.join(tmpDir, "home_seen_by_child.txt");
      // A real launcher that records the $HOME it was actually started
      // with, then sleeps well past the immediate-crash detection window.
      scriptPath = path.join(tmpDir, "start-server.sh");
      fs.writeFileSync(
        scriptPath,
        `#!/bin/sh\necho "$HOME" > "${homeProbePath}"\nsleep 30\n`,
        "utf8",
      );
      fs.chmodSync(scriptPath, 0o750);

      getActiveServer.mockResolvedValue({
        serverName: "LinuxHomeOverrideServer",
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

    it("the spawned process sees HOME redirected to .steamhome inside its own server directory, not the real ambient $HOME", async () => {
      const manager = new ServerManager();
      const result = await manager.startServer({ skipRunningCheck: true });
      spawnedPid = manager.serverProcess?.pid;

      expect(result.success).toBe(true);

      // Give the launcher a moment to write the probe file.
      for (let i = 0; i < 50 && !fs.existsSync(homeProbePath); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(fs.existsSync(homeProbePath)).toBe(true);
      const homeSeenByChild = fs.readFileSync(homeProbePath, "utf8").trim();
      const expectedHome = path.join(tmpDir, ".steamhome");
      expect(homeSeenByChild).toBe(expectedHome);
      expect(homeSeenByChild).not.toBe(process.env.HOME);
      // The redirected directory must actually exist -- SteamCMD (or the
      // JVM's own internal SteamCMD call) needs somewhere to write into,
      // not just an env var pointing at nothing.
      expect(fs.existsSync(expectedHome)).toBe(true);
    });
  },
);
