import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { createLogger } from "../utils/logger.js";
const log = createLogger("Updates");
import { getSetting, setSetting, getActiveServer } from "../database/init.js";
import { resolveManagedContainer } from "./managedContainer.js";
import { sanitizeError } from "../utils/sanitize.js";
import {
  hasActiveSteamOperation,
  getActiveSteamOperations,
  clearActiveSteamOperation,
  recordActiveSteamOperationPid,
} from "./activeSteamOperations.js";
import { acquireLifecycleLock } from "./lifecycleCoordinator.js";

export function parseAutoUpdateWarningMinutes(value) {
  if (value === null || value === undefined) return 15;
  if (typeof value === "string" && value.trim() === "") return 15;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 15;
  return Math.min(60, Math.max(0, Math.floor(parsed)));
}

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
    // wrapper-bypass/sibling-instrumentation class sweep, 2026-09-08:
    // panelUpdateChecker.js (the panel's own self-update checker, doing the
    // structurally identical "fetch, compare, report" operation) already has
    // this exact field for its own check flow. This class never adopted it,
    // so checkForUpdates() ran unattended (an initial post-boot check, then
    // an unconditional setInterval forever, both fire-and-forget) with every
    // failure path logging server-side and returning null -- no signal ever
    // reached an operator who wasn't the one person who happened to click
    // "Check Now" at the exact moment it failed. Same clearing discipline as
    // dockerClient.js's lastError: cleared on any check that reached a real
    // answer (available or not), set only when the check itself couldn't
    // produce one.
    this.lastError = null;
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
   * Get latest build info from Steam for a specific branch. `installPath`
   * is optional (defensive, matching serverManager.js's own
   * `if (installPathForSteamCheck)` shape for the same check) -- every
   * real caller (checkForUpdates()) always has it, since it already
   * bails out earlier when serverPath is unset.
   */
  async getLatestBuildInfo(steamcmdPath, branch = "public", installPath = null) {
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

    // Guard against racing a manual POST /install or POST /steam-update
    // (routes/server.js), or the automatic update job's own real
    // +app_update spawn below in runAutoUpdate() -- this query doesn't
    // touch +force_install_dir, but it shares SteamCMD's own session/cache
    // state under steamcmdPath with whichever of those IS writing, and two
    // concurrent SteamCMD invocations against that shared state is exactly
    // the class of bug activeSteamOperations.js exists to prevent (hunt-
    // wave6, 2026-08-29 -- this and runAutoUpdate's spawn were the two
    // remaining SteamCMD call sites that ran without going through it at
    // all). No await between the check and the claim below -- a gap there
    // is how two requests slip past each other and both spawn (see
    // routes/server.js's own comment on steamUpdateConcurrency.test.js).
    // Plain Error, no ErrorCode: matches this function's own sibling
    // throws immediately above ("SteamCMD not found") rather than being
    // the one throw in this function that departs from their shape.
    let normalizedInstallPath = null;
    if (installPath) {
      normalizedInstallPath = path.normalize(installPath).toLowerCase();
      if (hasActiveSteamOperation(normalizedInstallPath)) {
        throw new Error(
          "A Steam install or update is already in progress for this server's install directory. Skipping this version check until it finishes.",
        );
      }
      getActiveSteamOperations().set(normalizedInstallPath, {
        type: "version-check",
        startTime: Date.now(),
        lastOutputAt: Date.now(),
      });
    }

    try {
      return await new Promise((resolve, reject) => {
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
    } finally {
      // Release as soon as this query is actually done, success or
      // failure or timeout -- a thrown error above (including the refusal
      // itself, which never reaches here since it throws before the
      // claim) must never leave a permanent claim.
      if (normalizedInstallPath) clearActiveSteamOperation(normalizedInstallPath);
    }
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
        this.lastError = "steamcmdPath or serverPath is not configured";
        this.io.emit("server:updateCheckFailed", { lastError: this.lastError });
        this.isChecking = false;
        return null;
      }

      // Get installed build info
      const installed = await this.getInstalledBuildInfo(serverPath);
      if (!installed || !installed.buildId) {
        log.debug("UpdateChecker: Could not determine installed build");
        this.lastError = "Could not determine the installed build (missing or unreadable appmanifest)";
        this.io.emit("server:updateCheckFailed", { lastError: this.lastError });
        this.isChecking = false;
        return null;
      }

      // Get game version from console log
      this.gameVersion = await this.getGameVersion();

      // Get latest build info from Steam
      const latest = await this.getLatestBuildInfo(
        steamcmdPath,
        installed.branch,
        serverPath,
      );
      if (!latest || !latest.buildId) {
        log.debug("UpdateChecker: Could not get latest build info from Steam");
        this.lastError = "Could not get the latest build info from Steam (steamcmd query failed)";
        this.io.emit("server:updateCheckFailed", { lastError: this.lastError });
        this.isChecking = false;
        return null;
      }

      this.lastCheck = new Date().toISOString();
      this.lastError = null;

      // Compare build IDs (ensure base 10 parsing)
      const installedBuild = parseInt(installed.buildId, 10);
      const latestBuild = parseInt(latest.buildId, 10);

      // Guard against NaN from invalid build IDs
      if (isNaN(installedBuild) || isNaN(latestBuild)) {
        log.warn("UpdateChecker: Invalid build ID format");
        this.lastError = "Installed or latest build ID was not a valid number";
        this.io.emit("server:updateCheckFailed", { lastError: this.lastError });
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
        // Deliberately NOT gated on !wasAvailable (unlike the emit above,
        // which is purely about notification spam). scheduleAutoUpdate()
        // itself is the re-entrancy guard (this.autoUpdateRunning ||
        // this.autoUpdateTimer, both reset once a warning/run cycle
        // finishes), so calling it on every periodic check while an update
        // is outstanding is a safe no-op once one is already scheduled or
        // running -- but it's what actually lets two real cases work:
        // (1) the operator enables serverAutoUpdate AFTER an update was
        // already detected while it was off (previously silently ignored
        // that update forever, since wasAvailable was already true by the
        // time the setting flipped on); (2) a scheduled auto-update FAILS
        // (SteamCMD error, stop timeout, build didn't advance) -- the old
        // once-per-availability-episode gate meant it never retried until
        // a NEWER build shipped, indistinguishable from "auto-update is
        // silently broken" to an operator watching it happen once and never
        // again.
        await this.scheduleAutoUpdate(updateInfo);
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
      this.lastError = err.message;
      this.io.emit("server:updateCheckFailed", { lastError: this.lastError });
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

    const warningMinutes = parseAutoUpdateWarningMinutes(
      await getSetting("serverAutoUpdateWarningMinutes"),
    );
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
    const lifecycleLock = acquireLifecycleLock("automatic-update", this.serverManager?.serverName || null);
    if (!lifecycleLock) {
      this.autoUpdateRunning = false;
      log.warn("Automatic update skipped because another lifecycle operation is in progress");
      return { success: false, message: "Another server lifecycle operation is in progress" };
    }

    let shouldRestart = false;
    // Set right before the SteamCMD spawn below claims activeSteamOperations
    // for this path; the outer finally() releases it defensively too (a
    // no-op if the inner try/finally around the spawn already did) so a
    // thrown error can never leave a permanent claim, per the same
    // requirement as every other guarded spawn site.
    let normalizedInstallPath = null;
    let targetServerId = null;
    // Tracks how far the job got, recorded on failure alongside a stable
    // reason key -- see the class doc comment on _recordAutoUpdateResult()
    // for why phase (not a per-reason serverUp guess) is the source of
    // truth for whether the operator's server is still up.
    //   "not-started": nothing has been touched yet (pre-flight checks,
    //     including the initial running-scan itself failing) -- the
    //     server's own state is exactly whatever it was before this ran.
    //   "before-stop": server was confirmed running and this job has not
    //     yet confirmed it stopped -- it is still (or again) running.
    //   "updating": server is confirmed stopped (or was never running) and
    //     SteamCMD is what failed -- the server is down until the finally
    //     block's restart attempt below runs.
    let phase = "not-started";
    // Throws with a STABLE reason key (never a raw message) so the client
    // can translate it -- see errorMessage.ts's whole workstream tonight
    // for why a raw string reaching the UI is the thing to avoid. `params`
    // carries the one piece of dynamic detail a couple of these need,
    // sanitized the same way an HTTP error response would be.
    const fail = (reason, message, params) => {
      const err = new Error(message);
      err.autoUpdateReason = reason;
      if (params) err.autoUpdateParams = params;
      throw err;
    };
    try {
      const enabled = await getSetting("serverAutoUpdate");
      if (enabled !== true && enabled !== "true") {
        log.info("Automatic server update cancelled because the setting was disabled");
        return;
      }
      const activeServer = await getActiveServer();
      targetServerId = activeServer?.id ?? null;
      const steamcmdPath = await getSetting("steamcmdPath");
      // Refuse a container-managed server outright. Its image owns the game
      // install, and the stop below would RCON-quit a process the container's
      // restart policy immediately brings back — turning this into a silent
      // five-minute wait that ends in a misleading timeout.
      const managed = await resolveManagedContainer({ serverId: activeServer?.id });
      if (managed.handled) {
        fail("MANAGED_CONTAINER", "This server runs in a panel-managed Docker container. Update the container image instead — the panel does not run SteamCMD against a managed container.");
      }
      if (!activeServer?.installPath || !steamcmdPath) fail("NOT_CONFIGURED", "SteamCMD path or server install path is not configured");

      // checkServerRunning() collapses a failed detection scan into `false`
      // -- indistinguishable from a confirmed-stopped server. This path is
      // unattended (no human reviewing the result), so a silent scan
      // failure here would skip the RCON save+quit entirely and run
      // SteamCMD's `validate` straight against a possibly-live install.
      // Use getServerProcessDetails() and fail closed on scanFailed instead.
      const initialDetails = await this.serverManager.getServerProcessDetails();
      if (initialDetails.scanFailed) fail("INITIAL_SCAN_FAILED", "Could not verify whether the server is running, so the automatic update was abandoned for safety");
      if (initialDetails.running) {
        shouldRestart = true;
        phase = "before-stop";
        if (!this.rconService.connected) fail("RCON_NOT_CONNECTED", "RCON is not connected, so the server cannot be stopped safely");
        // scheduleAutoUpdate()'s own warning announcement only fires ONCE,
        // at the moment the update was first detected -- if RCON happened
        // to be disconnected at that exact instant (a transient blip, not a
        // sustained outage), the warning is silently skipped there (best-
        // effort, matching this same "log and continue" posture) while the
        // timer still runs to completion. If RCON has since reconnected by
        // the time this line runs, the check above passes and the server
        // gets stopped with players never having been warned at all --
        // "silently drops connected players mid-session" is exactly the
        // failure mode this whole feature exists to avoid. A second,
        // immediate announcement right here, right before the actual save
        // + quit, closes that gap regardless of what happened minutes ago,
        // and also gives a final heads-up to anyone who missed or ignored
        // the original N-minute warning. Best-effort, same as the other
        // one -- a failed announcement must not abort an update that is
        // otherwise safe to run.
        try {
          const announced = await this.rconService.serverMessage(
            "Server is restarting now for an update.",
            { skipLog: true },
          );
          if (!announced?.success) log.warn(`Could not announce imminent automatic update: ${announced?.error || "unknown error"}`);
        } catch (error) {
          log.warn(`Could not announce imminent automatic update: ${error.message}`);
        }
        const saved = await this.rconService.save({ skipLog: true });
        if (!saved?.success) fail("SAVE_FAILED", `The world could not be saved (${saved?.error || "unknown error"}), so the update was abandoned rather than lose progress`, { reason: sanitizeError(saved?.error || "unknown error") });
        const quit = await this.rconService.quit();
        if (!quit?.success) log.warn(`Quit command failed (${quit?.error || "unknown error"}); waiting to see whether the server stops anyway`);
        const deadline = Date.now() + 5 * 60 * 1000;
        while (true) {
          const details = await this.serverManager.getServerProcessDetails();
          if (details.scanFailed) fail("STOP_SCAN_FAILED", "Lost the ability to verify the server had stopped, so the automatic update was abandoned for safety");
          if (!details.running) break;
          if (Date.now() >= deadline) fail("STOP_TIMEOUT", "Server did not stop within 5 minutes");
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }

      phase = "updating";
      const steamcmdExe = process.platform === "win32"
        ? path.join(steamcmdPath, "steamcmd.exe")
        : fs.existsSync(path.join(steamcmdPath, "steamcmd.sh"))
          ? path.join(steamcmdPath, "steamcmd.sh")
          : path.join(steamcmdPath, "steamcmd");
      if (!fs.existsSync(steamcmdExe)) fail("STEAMCMD_NOT_FOUND", `SteamCMD not found at ${steamcmdExe}`, { path: sanitizeError(steamcmdExe) });
      const branch = ["public", "stable"].includes(updateInfo.installed.branch) ? [] : ["-beta", updateInfo.installed.branch];
      const loginArgs = await getSteamLoginArgs();

      // Guard against racing a manual POST /install or POST /steam-update
      // (routes/server.js) writing into the SAME install directory -- this
      // unattended job is the other remaining SteamCMD call site that ran
      // without going through activeSteamOperations.js at all (hunt-wave6,
      // 2026-08-29, the direct continuation of the startServer() guard in
      // serverManager.js). No await between the check and the claim below,
      // same discipline as routes/server.js's own check (see its comment
      // on steamUpdateConcurrency.test.js) -- a gap there is exactly how
      // two SteamCMD processes end up racing the same install path.
      //
      // This is the unattended case the card cares about most: a manual
      // operation refusing is fine (a human sees the message and retries),
      // but this one must not silently skip. It doesn't invent a new
      // "deferred" mechanism -- it reuses this function's OWN existing
      // fail()/_recordAutoUpdateResult() pattern, the exact same one every
      // other pre-flight refusal in this function already uses (RCON not
      // connected, world save failed, SteamCMD missing, ...), so this
      // refusal is visible the same way theirs already are: persisted via
      // getStatus().lastAutoUpdateResult for any page to read cold, and
      // emitted live via server:autoUpdateComplete.
      // A candidate, not yet assigned to the outer normalizedInstallPath --
      // that variable is what BOTH finally blocks release, so it must only
      // become non-null once we have actually claimed the path ourselves.
      // Assigning it before the check (and before fail() can throw) would
      // make a blocked refusal here clear the OTHER operation's claim out
      // from under it in the outer finally below, exactly backwards from
      // what "release in a finally-equivalent" is supposed to guarantee.
      const candidateInstallPath = path.normalize(activeServer.installPath).toLowerCase();
      if (hasActiveSteamOperation(candidateInstallPath)) {
        fail(
          "STEAM_OPERATION_IN_PROGRESS",
          "A Steam install or update is already in progress for this server's install directory, so this automatic update was abandoned rather than race it. Retry manually from Server > Update once the other Steam operation finishes.",
          { path: sanitizeError(candidateInstallPath) },
        );
      }
      getActiveSteamOperations().set(candidateInstallPath, {
        type: "auto-update",
        startTime: Date.now(),
        lastOutputAt: Date.now(),
      });
      normalizedInstallPath = candidateInstallPath;

      let code;
      try {
        const child = spawn(steamcmdExe, ["+force_install_dir", activeServer.installPath, ...loginArgs, "+app_update", "380870", ...branch, "validate", "+quit"], { cwd: steamcmdPath });
        // Listeners attached synchronously, in the same tick as spawn --
        // 'error'/'close' can fire on any subsequent macrotask, so an
        // await between spawn() and .once() here (e.g. persisting the pid
        // first) risks losing an event that fires in that gap: an
        // EventEmitter never buffers an event for a listener that wasn't
        // there yet. The persistence write below runs concurrently with
        // this promise instead, not before it.
        const exitPromise = new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        await recordActiveSteamOperationPid(candidateInstallPath, child.pid);
        code = await exitPromise;
      } finally {
        // Released as soon as SteamCMD itself is done, not tied to the
        // OUTER finally below -- that one also covers the (possibly slow)
        // restart-the-server step that follows, which has nothing to do
        // with whether SteamCMD is still touching the install directory
        // and shouldn't hold a manual /install or /steam-update queued
        // any longer than necessary.
        clearActiveSteamOperation(normalizedInstallPath);
      }
      if (code !== 0) fail("STEAMCMD_EXIT_CODE", `SteamCMD exited with code ${code}`, { code });

      // SteamCMD's own exit code is not proof the install actually changed --
      // it can exit 0 on a no-op (stale/corrupt local manifest cache, a
      // branch that silently resolved to what's already installed, etc).
      // Re-read the manifest we just asked SteamCMD to rewrite and confirm
      // the buildId actually advanced before declaring success, the same
      // "observe the effect, don't trust the exit code" discipline
      // reconcilePendingUpdate() already applies to the panel's own binary
      // updater (it re-checks the running version rather than trusting that
      // staging happened).
      const postUpdate = await this.getInstalledBuildInfo(
        activeServer.installPath,
      );
      const postBuildId = postUpdate?.buildId
        ? parseInt(postUpdate.buildId, 10)
        : NaN;
      const preBuildId = parseInt(updateInfo.installed.buildId, 10);
      if (isNaN(postBuildId) || postBuildId <= preBuildId) {
        fail(
          "BUILD_DID_NOT_ADVANCE",
          `SteamCMD exited successfully but the installed build did not change (still ${postUpdate?.buildId ?? "unreadable"}, expected newer than ${updateInfo.installed.buildId})`,
          {
            installedBuildId: sanitizeError(postUpdate?.buildId ?? "unknown"),
            previousBuildId: sanitizeError(updateInfo.installed.buildId),
          },
        );
      }

      this.io.emit("server:autoUpdateComplete", { success: true });
      await this._recordAutoUpdateResult({
        status: "success",
        at: new Date().toISOString(),
        // `updateInfo.latest`/`.installed` only ever carry `.buildId`, never
        // a `.version` field -- the old `?.version` lookups here always
        // evaluated to undefined, so this was silently `null` on every real
        // success. Report the build ID we just verified actually landed.
        appliedVersion: postUpdate?.buildId ?? null,
      });
    } catch (error) {
      this.io.emit("server:autoUpdateComplete", { success: false, error: error.message });
      await this._recordAutoUpdateResult({
        status: "failed",
        at: new Date().toISOString(),
        reason: error.autoUpdateReason || "UNKNOWN",
        params: error.autoUpdateParams || null,
        phase,
        // Provisional -- "before-stop" means still running, "updating"
        // means confirmed stopped and not yet restarted, "not-started"
        // means nothing was touched (unknown/unaffected). The finally
        // block below corrects this to the REAL outcome once it knows
        // whether its own restart attempt succeeded.
        serverUp: phase === "before-stop" ? true : phase === "not-started" ? null : false,
      });
      throw error;
    } finally {
      this.autoUpdateRunning = false;
      // Defensive, idempotent second release (the inner try/finally around
      // the SteamCMD spawn above already releases this in the normal
      // case) -- clearActiveSteamOperation() is a safe no-op if it's
      // already gone. Guarantees a thrown error can never leave a
      // permanent claim even if a future edit adds code between the claim
      // and that inner try without noticing it needs to stay inside it.
      if (normalizedInstallPath) clearActiveSteamOperation(normalizedInstallPath);
      // shouldRestart alone is not enough: it is set true the moment the
      // server is found running AT THE START, before anything has
      // attempted to stop it. Every failure in the "before-stop" phase
      // (RCON not connected, world save failed, quit/stop never confirmed)
      // means the server was NEVER ACTUALLY STOPPED -- so this call would
      // be guaranteed to throw "Server is already running" (harmless,
      // since startServer()'s own guard refuses rather than double-launch —
      // see the class comment above runAutoUpdate for the trace), but its
      // log line ("could not restart the server: Server is already
      // running") reads as a failed restart that was never actually
      // needed, the same wrong-attribution shape as the banner this
      // feature exists to fix, just one layer down in a log file. phase
      // having advanced past "before-stop" IS "the stop-confirmation loop
      // completed" -- the same predicate, no new state.
      if (shouldRestart && phase !== "before-stop") {
        try {
          const started = await this.serverManager.startServer({
            serverId: targetServerId,
          });
          if (started?.success) {
            await this._patchAutoUpdateResultServerUp(true);
          } else {
            log.error(`Automatic update could not restart the server: ${started?.error || started?.message || "unknown error"}`);
            await this._patchAutoUpdateResultServerUp(false);
          }
        } catch (error) {
          log.error(`Automatic update could not restart the server: ${error.message}`);
          await this._patchAutoUpdateResultServerUp(false);
        }
      }
      lifecycleLock.release();
    }
  }

  // Persists the outcome of an unattended run so ANY page can read it cold,
  // long after the event fired -- a live socket notification only reaches
  // whoever happens to be watching at that instant, which is never the
  // operator this feature is for (they enabled it and walked away). Cached
  // on the instance too so getStatus() stays cheap for repeated polling.
  async _recordAutoUpdateResult(result) {
    // dismissed starts false on every NEW run's result -- a fresh failure
    // (or success) always re-arms the banner even if the previous one was
    // acknowledged.
    this.lastAutoUpdateResult = { ...result, dismissed: false };
    await setSetting("lastAutoUpdateResult", this.lastAutoUpdateResult);
  }

  // The finally block's own restart attempt resolves AFTER the failure
  // result above was already recorded (its outcome isn't known until now),
  // so it patches serverUp in place rather than re-deriving the whole
  // record.
  async _patchAutoUpdateResultServerUp(serverUp) {
    if (!this.lastAutoUpdateResult || this.lastAutoUpdateResult.status !== "failed") return;
    this.lastAutoUpdateResult = { ...this.lastAutoUpdateResult, serverUp };
    await setSetting("lastAutoUpdateResult", this.lastAutoUpdateResult);
  }

  // Shared, server-side acknowledgement (see the dismiss route's own
  // comment for why this is not per-browser localStorage).
  async dismissAutoUpdateResult() {
    if (this.lastAutoUpdateResult === undefined) {
      this.lastAutoUpdateResult = (await getSetting("lastAutoUpdateResult")) || null;
    }
    if (!this.lastAutoUpdateResult) return;
    this.lastAutoUpdateResult = { ...this.lastAutoUpdateResult, dismissed: true };
    await setSetting("lastAutoUpdateResult", this.lastAutoUpdateResult);
  }

  /**
   * Get current update status without checking
   */
  async getStatus() {
    // Falls back to the persisted setting on a cold instance (this process
    // has not run an auto-update yet, but a previous one did before a panel
    // restart) rather than reporting a false "nothing has ever run".
    if (this.lastAutoUpdateResult === undefined) {
      this.lastAutoUpdateResult = (await getSetting("lastAutoUpdateResult")) || null;
    }
    return {
      updateAvailable: this.updateAvailable,
      gameVersion: this.gameVersion,
      lastCheck: this.lastCheck,
      lastError: this.lastError,
      intervalMinutes: this.intervalMs / 60000,
      isChecking: this.isChecking,
      lastAutoUpdateResult: this.lastAutoUpdateResult,
    };
  }
}
