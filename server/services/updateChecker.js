import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { createLogger } from "../utils/logger.js";
const log = createLogger("Updates");
import { getSetting, setSetting, getActiveServer } from "../database/init.js";

async function getSteamLoginArgs() {
  const account = String((await getSetting("steamUpdateAccount")) || "").trim();
  return ["+login", account || "anonymous"];
}

/**
 * Service to check for PZ server updates via Steam
 */
export class UpdateChecker {
  constructor(io, { rconService, serverManager } = {}) {
    this.io = io;
    this.rconService = rconService;
    this.serverManager = serverManager;
    this.checkInterval = null;
    this.lastCheck = null;
    this.updateAvailable = null;
    this.gameVersion = null;
    this.isChecking = false;
    this.autoUpdateTimer = null;
    this.autoUpdateRunning = false;

    // Default check interval: 30 minutes
    this.intervalMs = 30 * 60 * 1000;
  }

  /**
   * Start periodic update checking
   */
  async start() {
    // Load saved interval from settings
    const interval = await getSetting("updateCheckInterval");
    if (interval && interval > 0) {
      this.intervalMs = interval * 60 * 1000; // Convert minutes to ms
    }

    // Do initial check after 1 minute (let server fully start)
    this.initialTimeout = setTimeout(() => this.checkForUpdates(), 60 * 1000);

    // Start periodic checks
    this.checkInterval = setInterval(() => {
      this.checkForUpdates();
    }, this.intervalMs);

    log.info(`started (checking every ${this.intervalMs / 60000} minutes)`);
  }

  /**
   * Stop update checking
   */
  stop() {
    if (this.initialTimeout) {
      clearTimeout(this.initialTimeout);
      this.initialTimeout = null;
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.autoUpdateTimer) {
      clearTimeout(this.autoUpdateTimer);
      this.autoUpdateTimer = null;
    }
    log.info("stopped");
  }

  /**
   * Set check interval in minutes
   */
  async setInterval(minutes) {
    if (minutes < 5) minutes = 5; // Minimum 5 minutes
    if (minutes > 1440) minutes = 1440; // Maximum 24 hours

    this.intervalMs = minutes * 60 * 1000;
    await setSetting("updateCheckInterval", minutes);

    // Restart the interval
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = setInterval(() => {
        this.checkForUpdates();
      }, this.intervalMs);
    }

    log.info(`interval set to ${minutes} minutes`);
  }

  /**
   * Get game version from server-console.txt first line (e.g. "version=42.13.0 ...")
   */
  async getGameVersion() {
    // Hoisted so the catch block can reference it even if an earlier step
    // (e.g. getActiveServer / getSetting) threw before assignment.
    let consolePath = null;
    try {
      const activeServer = await getActiveServer();
      const dataPath =
        activeServer?.zomboidDataPath || (await getSetting("zomboidDataPath"));
      if (!dataPath) return null;

      consolePath = path.join(dataPath, "server-console.txt");
      await fs.promises.access(consolePath);

      // Read only the first 512 bytes — version is on the first line
      const fd = await fs.promises.open(consolePath, "r");
      const buf = Buffer.alloc(512);
      await fd.read(buf, 0, 512, 0);
      await fd.close();

      const firstLine = buf.toString("utf8").split(/\r?\n/)[0];
      const match = firstLine.match(/version=(\d+\.\d+(?:\.\d+)?)/);
      return match ? match[1] : null;
    } catch (e) {
      log.debug(
        `Failed to read PZ version from ${consolePath || "(unset)"}: ${e.message}`,
      );
      return null;
    }
  }

  /**
   * Get the currently installed build info from appmanifest
   */
  async getInstalledBuildInfo(serverPath) {
    const manifestPath = path.join(
      serverPath,
      "steamapps",
      "appmanifest_380870.acf",
    );

    try {
      await fs.promises.access(manifestPath);
    } catch (e) {
      return null;
    }

    try {
      const content = await fs.promises.readFile(manifestPath, "utf8");

      const buildIdMatch = content.match(/"buildid"\s+"(\d+)"/);
      const betaKeyMatch = content.match(/"BetaKey"\s+"([^"]+)"/);
      const lastUpdatedMatch = content.match(/"LastUpdated"\s+"(\d+)"/);

      return {
        buildId: buildIdMatch ? buildIdMatch[1] : null,
        branch: betaKeyMatch ? betaKeyMatch[1] : "public",
        lastUpdated: lastUpdatedMatch
          ? new Date(parseInt(lastUpdatedMatch[1], 10) * 1000).toISOString()
          : null,
      };
    } catch (err) {
      log.error(`Failed to read appmanifest: ${err.message}`);
      return null;
    }
  }

  /**
   * Get latest build info from Steam for a specific branch
   */
  async getLatestBuildInfo(steamcmdPath, branch = "public") {
    let steamcmdExe;
    if (process.platform === "win32") {
      steamcmdExe = path.join(steamcmdPath, "steamcmd.exe");
    } else {
      // Try steamcmd.sh first (tar.gz extract), then plain steamcmd (package-manager install),
      // then system-wide paths (CentOS/Ubuntu package manager installs to /usr/games/)
      const shPath = path.join(steamcmdPath, "steamcmd.sh");
      const binPath = path.join(steamcmdPath, "steamcmd");
      try {
        await fs.promises.access(shPath);
        steamcmdExe = shPath;
      } catch (e1) {
        log.debug(`SteamCMD not at ${shPath}: ${e1.message}`);
        try {
          await fs.promises.access(binPath);
          steamcmdExe = binPath;
        } catch (e2) {
          log.debug(`SteamCMD not at ${binPath}: ${e2.message}`);
          // Try system-wide locations
          for (const sysPath of [
            "/usr/games/steamcmd",
            "/usr/bin/steamcmd",
            "/usr/local/bin/steamcmd",
          ]) {
            try {
              await fs.promises.access(sysPath);
              steamcmdExe = sysPath;
              break;
            } catch (e3) {
              log.debug(`SteamCMD not at ${sysPath}: ${e3.message}`);
            }
          }
          if (!steamcmdExe) {
            log.warn(
              `SteamCMD not found at: ${shPath}, ${binPath}, /usr/games/steamcmd`,
            );
            throw new Error("SteamCMD not found");
          }
        }
      }
      log.debug(`Using SteamCMD executable: ${steamcmdExe}`);
    }

    try {
      await fs.promises.access(steamcmdExe);
    } catch (e) {
      throw new Error("SteamCMD not found");
    }

    return new Promise((resolve, reject) => {
      const args = [
        "+login",
        "anonymous",
        "+app_info_update",
        "1",
        "+app_info_print",
        "380870",
        "+quit",
      ];

      // On Linux, set LD_LIBRARY_PATH for SteamCMD's 32-bit libraries
      const spawnOpts = { cwd: steamcmdPath };
      if (process.platform !== "win32") {
        const ldPaths = [
          path.join(steamcmdPath, "linux32"),
          path.join(steamcmdPath, "linux64"),
          steamcmdPath,
          "/usr/lib64",
          process.env.LD_LIBRARY_PATH || "",
        ]
          .filter(Boolean)
          .join(":");
        spawnOpts.env = { ...process.env, LD_LIBRARY_PATH: ldPaths };
        log.debug(
          `SteamCMD spawn: exe=${steamcmdExe}, LD_LIBRARY_PATH=${ldPaths}`,
        );
      }

      const steamcmd = spawn(steamcmdExe, args, spawnOpts);

      let output = "";
      const timeout = setTimeout(() => {
        steamcmd.kill();
        reject(new Error("SteamCMD timeout"));
      }, 60000); // 60 second timeout

      steamcmd.stdout.on("data", (data) => {
        output += data.toString();
      });

      steamcmd.stderr.on("data", (data) => {
        output += data.toString();
      });

      steamcmd.on("close", (code) => {
        clearTimeout(timeout);

        if (code !== 0) {
          return reject(new Error(`SteamCMD exited with code ${code}`));
        }

        // Parse the branch info
        const branchInfo = this.parseBranchFromOutput(output, branch);
        resolve(branchInfo);
      });

      steamcmd.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Parse Steam app_info output to get build info for a specific branch
   */
  parseBranchFromOutput(output, targetBranch) {
    try {
      // Normalize branch name
      const branch = targetBranch === "stable" ? "public" : targetBranch;

      // Find the branches section
      const branchesMatch = output.match(/"branches"\s*\{([^]*?)\n\t\t\}/);
      if (!branchesMatch) {
        return null;
      }

      const branchesSection = branchesMatch[1];

      // Find the specific branch - improved regex
      const branchRegex = new RegExp(
        `"${branch}"\\s*\\{([^{}]*(?:\\{[^{}]*\\}[^{}]*)*)\\}`,
        "i",
      );
      const branchMatch = branchesSection.match(branchRegex);

      if (!branchMatch) {
        return null;
      }

      const branchContent = branchMatch[1];

      const buildIdMatch = branchContent.match(/"buildid"\s+"(\d+)"/);
      const timeUpdatedMatch = branchContent.match(/"timeupdated"\s+"(\d+)"/);
      const descMatch = branchContent.match(/"description"\s+"([^"]+)"/);

      return {
        branch: targetBranch,
        buildId: buildIdMatch ? buildIdMatch[1] : null,
        timeUpdated: timeUpdatedMatch
          ? new Date(parseInt(timeUpdatedMatch[1], 10) * 1000).toISOString()
          : null,
        description: descMatch ? descMatch[1] : null,
      };
    } catch (err) {
      log.error(`Failed to parse Steam output: ${err.message}`);
      return null;
    }
  }

  /**
   * Check for updates
   */
  async checkForUpdates(forceEmit = false) {
    if (this.isChecking) {
      // Add staleness check - if check has been running for more than 2 minutes, reset
      if (this.checkStartTime && Date.now() - this.checkStartTime > 120000) {
        log.warn(
          "UpdateChecker: Previous update check appears stuck, resetting",
        );
        this.isChecking = false;
      } else {
        log.debug("Update check already in progress, skipping");
        return this.updateAvailable;
      }
    }

    this.isChecking = true;
    this.checkStartTime = Date.now();

    try {
      // Get paths from settings
      const steamcmdPath = await getSetting("steamcmdPath");
      const serverPath = await getSetting("serverPath");

      if (!steamcmdPath || !serverPath) {
        log.debug("UpdateChecker: steamcmdPath or serverPath not configured");
        this.isChecking = false;
        return null;
      }

      // Get installed build info
      const installed = await this.getInstalledBuildInfo(serverPath);
      if (!installed || !installed.buildId) {
        log.debug("UpdateChecker: Could not determine installed build");
        this.isChecking = false;
        return null;
      }

      // Get game version from console log
      this.gameVersion = await this.getGameVersion();

      // Get latest build info from Steam
      const latest = await this.getLatestBuildInfo(
        steamcmdPath,
        installed.branch,
      );
      if (!latest || !latest.buildId) {
        log.debug("UpdateChecker: Could not get latest build info from Steam");
        this.isChecking = false;
        return null;
      }

      this.lastCheck = new Date().toISOString();

      // Compare build IDs (ensure base 10 parsing)
      const installedBuild = parseInt(installed.buildId, 10);
      const latestBuild = parseInt(latest.buildId, 10);

      // Guard against NaN from invalid build IDs
      if (isNaN(installedBuild) || isNaN(latestBuild)) {
        log.warn("UpdateChecker: Invalid build ID format");
        this.isChecking = false;
        return null;
      }

      const updateInfo = {
        updateAvailable: latestBuild > installedBuild,
        installed: {
          buildId: installed.buildId,
          branch: installed.branch,
          lastUpdated: installed.lastUpdated,
        },
        latest: {
          buildId: latest.buildId,
          branch: latest.branch,
          timeUpdated: latest.timeUpdated,
          description: latest.description,
        },
        lastCheck: this.lastCheck,
      };

      // Only emit if update status changed or force emit
      const wasAvailable = this.updateAvailable?.updateAvailable;
      this.updateAvailable = updateInfo;

      if (updateInfo.updateAvailable) {
        log.info(
          `Server update available! Installed: ${installed.buildId}, Latest: ${latest.buildId} (${installed.branch} branch)`,
        );

        if (!wasAvailable || forceEmit) {
          // Emit to all connected clients
          this.io.emit("server:updateAvailable", updateInfo);
        }
        if (!wasAvailable) {
          await this.scheduleAutoUpdate(updateInfo);
        }
      } else {
        log.debug(
          `Server is up to date (build ${installed.buildId}, ${installed.branch} branch)`,
        );

        if (forceEmit) {
          this.io.emit("server:updateCheck", updateInfo);
        }
      }

      return updateInfo;
    } catch (err) {
      log.error(`Update check failed: ${err.message}`);
      this.isChecking = false;
      return null;
    } finally {
      this.isChecking = false;
    }
  }

  async scheduleAutoUpdate(updateInfo) {
    if (this.autoUpdateRunning || this.autoUpdateTimer || !this.rconService || !this.serverManager) return;

    const enabled = await getSetting("serverAutoUpdate");
    if (enabled !== true && enabled !== "true") return;

    const rawWarning = Number(await getSetting("serverAutoUpdateWarningMinutes"));
    const warningMinutes = Number.isFinite(rawWarning)
      ? Math.min(60, Math.max(0, Math.floor(rawWarning)))
      : 15;
    const activeServer = await getActiveServer();
    if (!activeServer?.installPath || activeServer.isRemote) {
      log.warn("Auto-update skipped: the active server is remote or has no local install path");
      return;
    }

    this.autoUpdateRunning = true;
    const message = warningMinutes > 0
      ? `A server update was detected. The server will restart in ${warningMinutes} minute${warningMinutes === 1 ? "" : "s"}.`
      : "A server update was detected. The server is restarting now.";
    try {
      if (this.rconService.connected) {
        const announced = await this.rconService.serverMessage(message, { skipLog: true });
        if (!announced?.success) log.warn(`Could not announce automatic update: ${announced?.error || "unknown error"}`);
      }
    } catch (error) {
      log.warn(`Could not announce automatic update: ${error.message}`);
    }
    this.io.emit("server:autoUpdateScheduled", { warningMinutes, updateInfo });
    this.autoUpdateTimer = setTimeout(() => {
      this.autoUpdateTimer = null;
      this.runAutoUpdate(updateInfo).catch((error) => log.error(`Automatic update failed: ${error.message}`));
    }, warningMinutes * 60 * 1000);
  }

  async runAutoUpdate(updateInfo) {
    let shouldRestart = false;
    try {
      const enabled = await getSetting("serverAutoUpdate");
      if (enabled !== true && enabled !== "true") {
        log.info("Automatic server update cancelled because the setting was disabled");
        return;
      }
      const activeServer = await getActiveServer();
      const steamcmdPath = await getSetting("steamcmdPath");
      if (!activeServer?.installPath || !steamcmdPath) throw new Error("SteamCMD path or server install path is not configured");

      if (await this.serverManager.checkServerRunning()) {
        shouldRestart = true;
        if (!this.rconService.connected) throw new Error("RCON is not connected, so the server cannot be stopped safely");
        const saved = await this.rconService.save({ skipLog: true });
        if (!saved?.success) throw new Error(`The world could not be saved (${saved?.error || "unknown error"}), so the update was abandoned rather than lose progress`);
        const quit = await this.rconService.quit();
        if (!quit?.success) log.warn(`Quit command failed (${quit?.error || "unknown error"}); waiting to see whether the server stops anyway`);
        const deadline = Date.now() + 5 * 60 * 1000;
        while (await this.serverManager.checkServerRunning()) {
          if (Date.now() >= deadline) throw new Error("Server did not stop within 5 minutes");
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }

      const steamcmdExe = process.platform === "win32"
        ? path.join(steamcmdPath, "steamcmd.exe")
        : fs.existsSync(path.join(steamcmdPath, "steamcmd.sh"))
          ? path.join(steamcmdPath, "steamcmd.sh")
          : path.join(steamcmdPath, "steamcmd");
      if (!fs.existsSync(steamcmdExe)) throw new Error(`SteamCMD not found at ${steamcmdExe}`);
      const branch = ["public", "stable"].includes(updateInfo.installed.branch) ? [] : ["-beta", updateInfo.installed.branch];
      const loginArgs = await getSteamLoginArgs();
      const code = await new Promise((resolve, reject) => {
        const child = spawn(steamcmdExe, ["+force_install_dir", activeServer.installPath, ...loginArgs, "+app_update", "380870", ...branch, "validate", "+quit"], { cwd: steamcmdPath });
        child.once("error", reject);
        child.once("close", resolve);
      });
      if (code !== 0) throw new Error(`SteamCMD exited with code ${code}`);
      this.io.emit("server:autoUpdateComplete", { success: true });
    } catch (error) {
      this.io.emit("server:autoUpdateComplete", { success: false, error: error.message });
      throw error;
    } finally {
      this.autoUpdateRunning = false;
      if (shouldRestart) {
        try {
          const started = await this.serverManager.startServer();
          if (!started?.success) log.error(`Automatic update could not restart the server: ${started?.error || started?.message || "unknown error"}`);
        } catch (error) {
          log.error(`Automatic update could not restart the server: ${error.message}`);
        }
      }
    }
  }

  /**
   * Get current update status without checking
   */
  getStatus() {
    return {
      updateAvailable: this.updateAvailable,
      gameVersion: this.gameVersion,
      lastCheck: this.lastCheck,
      intervalMinutes: this.intervalMs / 60000,
      isChecking: this.isChecking,
    };
  }
}
