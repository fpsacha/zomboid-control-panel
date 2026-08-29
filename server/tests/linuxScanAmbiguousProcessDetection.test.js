import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// LINUX BUG HUNT follow-up (2026-08-29, linux-bug-hunt-2026-08-29): the live
// Discord report (Stop/Force Stop/Restart stuck disabled while RCON works)
// had TWO separate real bugs. The first (a client-side "false ?? X" JS
// defect, fixed in ffd8aaf) explains why the UI ignored RCON evidence. This
// covers the second, deeper one god asked to be fixed directly: WHY the
// Linux process scan itself can confidently, wrongly, report a genuinely
// running server as not running in the first place.
//
// isLinuxDedicatedServerCommandLine() requires a specific launch shape
// (zombie.network.GameServer, or ProjectZomboid64/32 + a -server-ish flag).
// A real PZ server invoked a different way -- proven here with a -jar-style
// launcher, plausible for Build 42's shaded jar per buildClasspathEntries()'s
// own comment -- produces a command line that shape doesn't recognize, and
// the OLD code returned {running:false, scanFailed:false}: a CONFIDENT wrong
// answer that routes around every downstream fallback written to trigger on
// doubt (composeServerStatus/buildHostSignal already render scanFailed:true
// as "unknown", not "stopped" -- they just never used to receive it here).
//
// The fix does NOT try to make isLinuxDedicatedServerCommandLine() cover
// every possible launch shape (per god's framing: that can never be
// complete, and each new shape would fail exactly as silently). Instead,
// the scan searches a DELIBERATELY BROADER net ("zomboid"/"zombie.network"
// anywhere) purely to detect its own uncertainty -- a candidate the broad
// net catches that the narrow shape-matcher rejects means real, positive
// evidence exists that we cannot rule out, so the scan reports
// scanFailed:true instead of a confident false. A genuinely idle host
// (nothing matching even the broad net) still resolves to a confident,
// correct "stopped" -- this must NOT make a real "not running" server
// report unknown forever.
//
// Only mocks database/init.js (loadConfig()'s data source) and the logger
// (keep output quiet); pgrep/ps/spawn are all real, run against real
// background processes, matching this hunt's established pattern
// (linuxLaunchExtensionlessCustomCommand.test.js).

const isLinux = process.platform !== "win32";

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(async () => null),
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

function makeManager(overrides) {
  const manager = new ServerManager();
  Object.assign(manager, { configLoaded: true, ...overrides });
  return manager;
}

(isLinux ? describe : describe.skip)(
  "getServerProcessDetails(): honest about scan uncertainty on Linux",
  () => {
    let tmpDir;
    let fakeJava;
    const spawnedPids = [];

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-scan-ambiguous-"));
      fakeJava = path.join(tmpDir, "fake_java");
      fs.writeFileSync(fakeJava, "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
    });

    afterEach(() => {
      while (spawnedPids.length) {
        const pid = spawnedPids.pop();
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function spawnBg(args) {
      const proc = spawn(fakeJava, args, { detached: true, stdio: "ignore" });
      proc.unref();
      spawnedPids.push(proc.pid);
      return proc.pid;
    }

    it("THE LIVE BUG: a -jar-style launch (a real, running PZ server the narrow matcher doesn't recognize) reports scanFailed:true, not a confident running:false", async () => {
      spawnBg(["-jar", "projectzomboid.jar"]);
      await new Promise((r) => setTimeout(r, 300));

      const manager = makeManager({
        serverName: "NewServer",
        savePath: "/tmp/NewServerZomboid",
        serverPath: "/opt/NewServer",
      });
      const details = await manager.getServerProcessDetails();

      expect(details.running).toBe(false);
      expect(details.scanFailed).toBe(true); // honest "unknown", not a confident wrong answer
    });

    it("positive control: the panel's own generated-script shape is still confirmed normally (proves the fix didn't weaken real detection)", async () => {
      spawnBg([
        "-Djava.library.path=natives/",
        "-cp",
        "java/.",
        "zombie.network.GameServer",
        "-servername",
        "GoodServer",
        "-cachedir=/tmp/GoodServerZomboid",
      ]);
      await new Promise((r) => setTimeout(r, 300));

      const manager = makeManager({
        serverName: "GoodServer",
        savePath: "/tmp/GoodServerZomboid",
        serverPath: "/opt/GoodServer",
      });
      const details = await manager.getServerProcessDetails();

      expect(details.running).toBe(true);
      expect(details.scanFailed).toBe(false);
      expect(details.owned).toHaveLength(1);
    });

    it("a genuinely idle host (no matching process at all, confirmed or ambiguous) still reports confidently stopped -- the fix must not make every check say unknown", async () => {
      // Deliberately spawn nothing. If the fix over-broadened detection to
      // catch unrelated processes, or self-matched its own scan invocation,
      // this would flip to scanFailed:true and every stopped server would
      // become permanently un-restartable-from-confidence, which is exactly
      // what god's caution warned against.
      const manager = makeManager({
        serverName: "IdleServer",
        savePath: "/tmp/IdleServerZomboid",
        serverPath: "/opt/IdleServer",
      });
      const details = await manager.getServerProcessDetails();

      expect(details.running).toBe(false);
      expect(details.scanFailed).toBe(false);
    });
  },
);
