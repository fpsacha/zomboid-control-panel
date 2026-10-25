import { describe, expect, it, afterEach } from "vitest";
import path from "path";
import { ServerManager } from "../services/serverManager.js";
import {
  getActiveSteamOperations,
  clearActiveSteamOperation,
} from "../services/activeSteamOperations.js";

// Concurrency hunt hunt-wave6-2026-08-29, landing "item 4" (update-apply
// racing Start/Restart) from the hunt-wave5 table. god's own review of the
// evidence agreed the finding was real and structural (activeSteamOperations
// was a module-private Map in routes/server.js, referenced ONLY by
// /install and /steam-update -- zero hits anywhere in serverManager.js),
// but flagged the subtlety that decides the fix's actual shape: a guard at
// POST /start protects the human clicking Start. It does NOT protect a
// restart nobody clicked -- the scheduler's auto-restart, a mod-update-
// triggered restart, the panel's own auto-start-on-boot, the Discord bot's
// /start command, or updateChecker.js's restart-after-update. Enumerated
// every real production call site of serverManager.startServer() before
// writing this test (server/routes/server.js POST /start,
// server/services/scheduler.js's two performRestart() start steps,
// server/services/discordBot.js's /start command, server/index.js's
// auto-start-on-panel-boot, server/services/updateChecker.js's restart-
// after-auto-update -- ServerManager.restartServer() itself is dead code,
// no callers anywhere, not counted as a real path) -- every one of them
// funnels through this ONE function, so the guard lives here, not
// duplicated at each caller.
//
// This test exercises the shared choke point directly: any caller that
// reaches startServer() while activeSteamOperations reports the target
// install path as live must be refused, regardless of which of those six
// callers it came from.

const server = {
  installPath: "/opt/pz server",
};

function makeManager() {
  const manager = new ServerManager();
  Object.assign(manager, {
    configLoaded: true,
    serverName: "SteamRaceTest",
    serverPath: server.installPath,
    startCommand: null,
  });
  return manager;
}

const normalizedInstallPath = path.normalize(server.installPath).toLowerCase();

describe("startServer(): refuses to spawn the PZ JVM while SteamCMD is active for this server's install path", () => {
  afterEach(() => {
    clearActiveSteamOperation(normalizedInstallPath);
  });

  it("throws a clear, specific error instead of launching against a mid-write install directory", async () => {
    const manager = makeManager();
    getActiveSteamOperations().set(normalizedInstallPath, {
      type: "update",
      // process.pid: a genuinely live PID (the test runner's own), so
      // hasActiveSteamOperation()'s liveness probe reports it as active
      // rather than self-healing it away as stale.
      pid: process.pid,
    });

    await expect(manager.startServer({ skipRunningCheck: true })).rejects.toThrow(
      /steam install or update is currently in progress/i,
    );
    // GH #269: the refusal names the operation, for a restart to wait out.
    await expect(manager.startServer({ skipRunningCheck: true })).rejects.toMatchObject({
      steamOperation: { type: "update", pid: process.pid, path: normalizedInstallPath },
    });
  });

  it("proceeds normally once the tracked operation is cleared -- this is not a permanent lockout", async () => {
    const manager = makeManager();
    getActiveSteamOperations().set(normalizedInstallPath, {
      type: "update",
      pid: process.pid,
    });
    clearActiveSteamOperation(normalizedInstallPath);

    // Reaches past the new guard and into the real spawn attempt, which
    // fails for an unrelated reason (no real steamcmd-installed PZ server
    // at this fake path) -- proving the new check specifically is not
    // what's blocking it anymore.
    await expect(manager.startServer({ skipRunningCheck: true })).rejects.not.toThrow(
      /steam install or update is currently in progress/i,
    );
  });

  // A mod download (workshopDownload.js) only writes under
  // steamapps/workshop: a restart during one used to be refused and left
  // the server down.
  it("does not block on a Workshop item download for the same install path", async () => {
    const manager = makeManager();
    getActiveSteamOperations().set(normalizedInstallPath, {
      type: "workshop-download",
      pid: process.pid,
    });

    await expect(manager.startServer({ skipRunningCheck: true })).rejects.not.toThrow(
      /steam install or update is currently in progress/i,
    );
  });

  it.each(["install", "update", "verification", "auto-update", "unknown"])(
    "still blocks on a %s operation",
    async (type) => {
      const manager = makeManager();
      getActiveSteamOperations().set(normalizedInstallPath, { type, pid: process.pid });

      await expect(manager.startServer({ skipRunningCheck: true })).rejects.toThrow(
        /steam install or update is currently in progress/i,
      );
    },
  );

  it("is unaffected by an operation tracked for a DIFFERENT install path", async () => {
    const manager = makeManager();
    const otherPath = path.normalize("/opt/some-other-server").toLowerCase();
    getActiveSteamOperations().set(otherPath, {
      type: "update",
      pid: process.pid,
    });

    try {
      await expect(
        manager.startServer({ skipRunningCheck: true }),
      ).rejects.not.toThrow(/steam install or update is currently in progress/i);
    } finally {
      clearActiveSteamOperation(otherPath);
    }
  });
});
