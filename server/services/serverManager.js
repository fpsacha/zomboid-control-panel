import { spawn, exec, execFile } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import net from "net";
import { createLogger } from "../utils/logger.js";
const log = createLogger("Server");
import {
  logServerEvent,
  getSetting,
  setSetting,
  getActiveServer,
  getServer,
  getServers,
} from "../database/init.js";
import { withFileLock, writeFileAtomic } from "../utils/fileWriteQueue.js";
import { escapeRegExp } from "../utils/regex.js";
import { getDataPaths } from "../utils/paths.js";

const isWindows = process.platform === "win32";
// How long a live-looked-up public IP is trusted before re-checking.
// Residential ISPs rotate dynamic WAN IPs periodically; without a TTL the
// dashboard would show a stale, no-longer-yours address indefinitely.
const PUBLIC_IP_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function getConfiguredIpv4Address(variableName) {
  const address = process.env[variableName]?.trim();
  return address && net.isIP(address) === 4 ? address : null;
}

// Build LD_LIBRARY_PATH from server directory, filtering to only existing paths
function buildLdLibraryPath(serverDir) {
  log.debug(
    `buildLdLibraryPath: scanning candidates for serverDir=${serverDir}`,
  );
  const candidates = [
    path.join(serverDir, "linux64"),
    path.join(serverDir, "natives", "linux64"),
    path.join(serverDir, "natives"),
    serverDir,
    path.join(serverDir, "jre64", "lib", "amd64"),
    path.join(serverDir, "jre64", "lib", "x86_64"), // CentOS uses x86_64 instead of amd64
    "/usr/lib64", // CentOS system 64-bit libs
  ];
  const existing = candidates.filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  const extra = process.env.LD_LIBRARY_PATH || "";
  const result = [...existing, extra].filter(Boolean).join(":");
  log.debug(
    `buildLdLibraryPath: ${existing.length}/${candidates.length} dirs exist → LD_LIBRARY_PATH=${result}`,
  );
  return result;
}

// Allowed extensions for custom start commands
const ALLOWED_CMD_EXTENSIONS = isWindows
  ? [".bat", ".cmd", ".exe"]
  : [".sh", ""];

// Validate a custom start command string for safety
function validateStartCommand(cmd) {
  if (!cmd || typeof cmd !== "string")
    return { valid: false, reason: "Command is empty" };
  if (cmd.length > 1024)
    return { valid: false, reason: "Command exceeds 1024 characters" };
  // Block obvious shell metacharacters that enable chaining/injection
  // Allow quotes, spaces, hyphens, equals, slashes, dots, colons (drive letters)
  if (/[&|;<>`${}()!\[\]\n\r]/.test(cmd)) {
    return {
      valid: false,
      reason:
        "Command contains disallowed shell characters: & | ; < > ` $ { } ( ) ! [ ]",
    };
  }
  return { valid: true };
}

// Get the default startup script name for the current platform
function getDefaultStartupScript() {
  return isWindows ? "StartServer64.bat" : "start-server.sh";
}

export function isWindowsDedicatedServerCommandLine(commandLine) {
  const normalized =
    typeof commandLine === "string" ? commandLine.toLowerCase() : "";
  if (!normalized) return false;

  // 1. Direct Java execution
  if (normalized.includes("zombie.network.gameserver")) {
    return true;
  }

  // 2. Native Launcher (Wrappers like WinGSM often call these with specific flags)
  if (
    normalized.includes("projectzomboid64.exe") ||
    normalized.includes("projectzomboid32.exe")
  ) {
    if (
      normalized.includes("-server") ||
      normalized.includes("startserver") ||
      normalized.includes("-servername")
    ) {
      return true;
    }
  }

  // 3. Fallback for custom generic setups (must explicitly name Zomboid)
  if (
    normalized.includes("zomboid") &&
    (normalized.includes("-server") || normalized.includes("startserver"))
  ) {
    return true;
  }

  return false;
}

// Pull the value of a PZ launch argument (`-servername X`, `-cachedir="Y"`)
// out of a raw command line.
function extractLaunchArgValue(commandLine, flag) {
  const pattern = new RegExp(
    `(?:^|\\s)-${flag}(?:\\s*=\\s*|\\s+)("[^"]*"|'[^']*'|\\S+)`,
    "i",
  );
  const match = String(commandLine || "").match(pattern);
  if (!match) return null;
  const value = match[1].replace(/^["']|["']$/g, "").trim();
  return value || null;
}

function normalizePathForCompare(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "");
  return isWindows ? normalized.toLowerCase() : normalized;
}

/**
 * How strongly a running process looks like it belongs to a given server.
 * Returns -1 when a launch argument proves it belongs to a DIFFERENT server,
 * 0 when the command line carries no identifying argument at all (so it
 * can't be attributed either way), and a positive score when it matches.
 *
 * This is what lets one host run several dedicated servers: the panel writes
 * `-servername` (and usually `-cachedir`) into every startup script it
 * generates, so each process names the server it belongs to.
 */
export function scoreServerProcessOwnership(commandLine, descriptor = {}) {
  const cmd = String(commandLine || "");
  if (!cmd) return 0;

  let score = 0;

  const nameArg = extractLaunchArgValue(cmd, "servername");
  if (nameArg && descriptor.serverName) {
    if (nameArg.toLowerCase() !== String(descriptor.serverName).toLowerCase()) {
      return -1;
    }
    score += 3;
  }

  const cacheArg = extractLaunchArgValue(cmd, "cachedir");
  if (cacheArg && descriptor.savePath) {
    if (
      normalizePathForCompare(cacheArg) !==
      normalizePathForCompare(descriptor.savePath)
    ) {
      return -1;
    }
    score += 2;
  }

  const installPath = normalizePathForCompare(descriptor.serverPath);
  if (installPath && normalizePathForCompare(cmd).includes(installPath)) {
    score += 1;
  }

  return score;
}

export class ServerManager {
  constructor() {
    this.serverProcess = null;
    this.serverPath = process.env.PZ_SERVER_PATH || "";
    this.serverBat = process.env.PZ_SERVER_BAT || getDefaultStartupScript();
    this.savePath = process.env.PZ_SAVE_PATH || "";
    this.serverName = "servertest";
    this.startCommand = "";
    this.rconHost = null;
    this.rconPort = null;
    this.isRunning = false;
    this.startTime = null;
    this.configLoaded = false;
    // Which server this instance's currently-loaded config belongs to (null
    // = "the active server", the shared-singleton default). Recorded so
    // internal reload points (e.g. startServer()'s "settings may have
    // changed" refresh) reload the SAME target instead of silently
    // snapping a throwaway instance back to whatever is active.
    this._serverId = null;
    this.publicIp = null;
    this.gamePort = null;
    this.fetchingIp = false;
  }

  // Reload config (called when active server changes)
  async reloadConfig(serverId = null) {
    // Reset all config to defaults before reloading
    this.serverPath = process.env.PZ_SERVER_PATH || "";
    this.serverBat = process.env.PZ_SERVER_BAT || getDefaultStartupScript();
    this.savePath = process.env.PZ_SAVE_PATH || "";
    this.serverName = "servertest";
    this.startCommand = "";
    this.rconHost = null;
    this.rconPort = null;
    this.configLoaded = false;
    await this.loadConfig(serverId);
  }

  // Load settings from a specific server (serverId), the active server, or
  // legacy database settings. `serverId` lets the Scheduler point a
  // throwaway ServerManager instance at a server that isn't the
  // currently-active one — the shared singleton (called with no args, as
  // everywhere else in the app) keeps following the active server exactly
  // as before.
  async loadConfig(serverId = null) {
    if (this.configLoaded) return;
    this._serverId = serverId;
    try {
      // First, try to load from a specific server or the active server
      // (multi-server support)
      const activeServer = serverId
        ? await getServer(serverId)
        : await getActiveServer();
      if (activeServer) {
        // Use serverPath if available, otherwise extract from installPath
        let serverDir = activeServer.serverPath || activeServer.installPath;

        // If path points to a file (e.g., .bat), extract the directory
        if (serverDir) {
          const serverDirLower = serverDir.toLowerCase();
          if (
            serverDirLower.endsWith(".bat") ||
            serverDirLower.endsWith(".sh") ||
            serverDirLower.endsWith(".exe")
          ) {
            // Extract the batch file name before getting directory
            const batchFileName = path.basename(serverDir);
            serverDir = path.dirname(serverDir);
            // Use the specified batch file
            this.serverBat = batchFileName;
            log.debug(`Using batch file from installPath: ${batchFileName}`);
          }
        }

        if (serverDir) {
          this.serverPath = serverDir;
          log.debug(`Loaded serverPath: ${serverDir}`);
        }

        if (activeServer.serverName) {
          this.serverName = activeServer.serverName;
          // Only look for custom batch file if we didn't already get one from installPath
          if (!this.serverBat || this.serverBat === getDefaultStartupScript()) {
            if (isWindows) {
              const customBat = `StartServer_${activeServer.serverName}.bat`;
              const customBatPath = path.join(this.serverPath, customBat);
              if (fs.existsSync(customBatPath)) {
                this.serverBat = customBat;
              } else if (activeServer.useNoSteam) {
                this.serverBat = "StartServer64_nosteam.bat";
              } else {
                this.serverBat = "StartServer64.bat";
              }
            } else {
              const customSh = `start-server_${activeServer.serverName}.sh`;
              const customShPath = path.join(this.serverPath, customSh);
              if (fs.existsSync(customShPath)) {
                this.serverBat = customSh;
              } else if (activeServer.useNoSteam) {
                this.serverBat = "start-server.sh";
              } else {
                this.serverBat = "start-server.sh";
              }
            }
          }
        }
        if (activeServer.zomboidDataPath) {
          this.savePath = activeServer.zomboidDataPath;
        }
        if (activeServer.startCommand) {
          this.startCommand = activeServer.startCommand;
          log.debug(`Using custom start command: ${this.startCommand}`);
        }
        // Kept per-server so the "is the port already taken?" preflight can
        // check THIS server's port instead of the global default.
        this.rconHost = activeServer.rconHost || this.rconHost;
        this.rconPort = activeServer.rconPort || this.rconPort;
        this.configLoaded = true;
        log.debug(`Loaded config from active server: ${activeServer.name}`);
        return;
      }

      // Fallback: load from legacy (global) settings — only meaningful when
      // no specific serverId was requested. Falling back to the global
      // settings for a targeted serverId lookup would silently point at
      // the wrong server instead of failing loudly on a bad/deleted id.
      if (!serverId) {
        const dbServerPath = await getSetting("serverPath");
        const dbServerName = await getSetting("serverName");
        const dbZomboidPath = await getSetting("zomboidDataPath");

        if (dbServerPath) {
          this.serverPath = dbServerPath;
          log.debug(`Loaded serverPath from database: ${dbServerPath}`);
        }
        if (dbServerName) {
          this.serverName = dbServerName;
          // Use custom startup script if server was set up through the app
          if (isWindows) {
            this.serverBat = `StartServer_${dbServerName}.bat`;
          } else {
            this.serverBat = `start-server_${dbServerName}.sh`;
          }
        }
        if (dbZomboidPath) {
          this.savePath = dbZomboidPath;
        }
        this.rconHost = (await getSetting("rconHost")) || this.rconHost;
        this.rconPort = (await getSetting("rconPort")) || this.rconPort;
      } else {
        log.warn(`No server config found for server ${serverId}`);
      }
      this.configLoaded = true;
    } catch (error) {
      log.debug(`Could not load server config from database: ${error.message}`);
    }
  }

  async checkServerRunning() {
    const details = await this.getServerProcessDetails();
    return details.running;
  }

  // The identifying traits of the server this instance represents.
  _getOwnershipDescriptor() {
    return {
      serverName: this.serverName,
      savePath: this.savePath,
      serverPath: this.serverPath,
    };
  }

  /**
   * Like `checkServerRunning` but returns *which* processes the OS scan
   * matched, narrowed to the processes belonging to THIS server. Used by
   * chunk-cleanup endpoints (issue #5) so the UI can show the user exactly
   * which process the panel thinks is the dedicated server, and offer a
   * "force delete anyway" override when the detection is a false positive
   * (e.g. an unrelated java process matched, or a custom launcher script the
   * panel doesn't recognise).
   *
   * Resolves to `{ running, matched, owned, scanFailed }`. `matched` is
   * truncated to the first 3 entries with each cmd capped at 240 chars to
   * keep the JSON payload sane; `owned` is the untruncated list force-stop
   * uses to pick which PIDs it may kill.
   */
  async getServerProcessDetails() {
    await this.loadConfig(this._serverId);
    const scan = await this._scanDedicatedServerProcesses();
    const descriptor = this._getOwnershipDescriptor();

    const owned = [];
    const unattributable = [];
    for (const candidate of scan.matched) {
      const score = scoreServerProcessOwnership(candidate.cmd, descriptor);
      if (score > 0) owned.push(candidate);
      else if (score === 0) unattributable.push(candidate);
    }

    // A command line carrying no -servername/-cachedir can't be attributed to
    // any particular server, so only claim those when nothing positively
    // matched this one — that keeps detection working for single-server
    // installs launched from a stock StartServer64.bat.
    const resolved = owned.length > 0 ? owned : unattributable;
    if (scan.matched.length !== resolved.length) {
      log.debug(
        `getServerProcessDetails: ${scan.matched.length} PZ server process(es) on this host, ${resolved.length} belong to "${this.serverName}"`,
      );
    }

    this.isRunning = resolved.length > 0;
    return {
      running: resolved.length > 0,
      matched: resolved.slice(0, 3).map((entry) => ({
        ...(entry.pid ? { pid: String(entry.pid) } : {}),
        cmd: String(entry.cmd || "").slice(0, 240),
      })),
      owned: resolved,
      scanFailed: Boolean(scan.scanFailed),
    };
  }

  // Raw OS scan: every Project Zomboid dedicated server process on this host,
  // regardless of which configured server it belongs to.
  async _scanDedicatedServerProcesses() {
    return new Promise((resolve) => {
      log.debug(
        `getServerProcessDetails: starting detection (platform=${process.platform})`,
      );
      const matched = [];
      const pushMatch = (cmd, pid) => {
        // Keep the command line intact: ownership matching needs the
        // -servername / -cachedir arguments, which sit well past 240 chars.
        const full = String(cmd || "");
        matched.push(pid ? { pid: String(pid), cmd: full } : { cmd: full });
      };

      const timeout = setTimeout(() => {
        log.warn(
          "getServerProcessDetails: process detection timed out, assuming server is not running",
        );
        resolve({ running: false, matched: [], scanFailed: true });
      }, 10000);

      if (isWindows) {
        const psCmd =
          "powershell -Command \"Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(java\\.exe|ProjectZomboid64\\.exe|ProjectZomboid32\\.exe)$' } | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation\"";
        exec(psCmd, { timeout: 8000 }, (psError, psStdout) => {
          clearTimeout(timeout);
          if (psError || !psStdout) {
            this.isRunning = false;
            resolve({ running: false, matched: [], scanFailed: true });
            return;
          }

          const lines = psStdout.split(/\r?\n/);
          for (let raw of lines) {
            raw = raw.trim();
            if (!raw || raw.startsWith('"ProcessId"')) continue;
            // CSV: "<pid>","<cmd>" — strip outer quotes / un-double internal "" pairs.
            const csvMatch = raw.match(/^"([^"]*)","((?:[^"]|"")*)"$/);
            if (!csvMatch) continue;
            const pid = csvMatch[1];
            const cmd = csvMatch[2].replace(/""/g, '"');
            if (!cmd) continue;
            if (isWindowsDedicatedServerCommandLine(cmd)) {
              log.debug(
                `getServerProcessDetails: matched PZ server process pid=${pid}: ${cmd.substring(0, 200)}`,
              );
              pushMatch(cmd, pid);
            }
          }

          this.isRunning = matched.length > 0;
          resolve({ running: matched.length > 0, matched });
        });
      } else {
        // Linux/macOS: pgrep first (faster, more reliable), fall back to ps aux -ww.
        // Use the same dedicated-server heuristics as Windows so a player
        // running the *game* (ProjectZomboid64) on the same box doesn't
        // false-positive as a running dedicated server. Direct
        // `zombie.network.GameServer` java invocations always qualify.
        const isLinuxDedicatedServerCommandLine = (cmd) => {
          const lower = String(cmd || "").toLowerCase();
          if (!lower) return false;
          if (lower.includes("zombie.network.gameserver")) return true;
          if (
            lower.includes("projectzomboid64") ||
            lower.includes("projectzomboid32")
          ) {
            if (
              lower.includes("-server") ||
              lower.includes("startserver") ||
              lower.includes("-servername")
            ) {
              return true;
            }
            return false;
          }
          if (
            lower.includes("zomboid") &&
            (lower.includes("-server") || lower.includes("startserver"))
          ) {
            return true;
          }
          return false;
        };

        log.debug("getServerProcessDetails: trying pgrep -af first...");
        exec(
          'pgrep -af "zombie.network.[Gg]ame[Ss]erver|[Pp]roject[Zz]omboid64|[Pp]roject[Zz]omboid32"',
          { timeout: 8000 },
          (pgrepErr, pgrepOut) => {
            if (!pgrepErr && pgrepOut && pgrepOut.trim()) {
              for (const line of pgrepOut.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                // pgrep -af format: "<pid> <cmdline>"
                const m = trimmed.match(/^(\d+)\s+(.*)$/);
                const pid = m ? m[1] : undefined;
                const cmd = m ? m[2] : trimmed;
                if (!isLinuxDedicatedServerCommandLine(cmd)) {
                  log.debug(
                    `getServerProcessDetails: pgrep candidate ignored (not a dedicated server): ${cmd.substring(0, 200)}`,
                  );
                  continue;
                }
                pushMatch(cmd, pid);
              }
              log.debug(
                `getServerProcessDetails: pgrep matched ${matched.length} process(es)`,
              );
              clearTimeout(timeout);
              this.isRunning = matched.length > 0;
              resolve({ running: matched.length > 0, matched });
              return;
            }
            // Fallback: ps aux
            log.debug(
              "getServerProcessDetails: pgrep failed or empty, falling back to ps aux -ww",
            );
            exec("ps aux -ww", { timeout: 8000 }, (err, stdout) => {
              clearTimeout(timeout);
              if (err || !stdout) {
                this.isRunning = false;
                resolve({ running: false, matched: [], scanFailed: true });
                return;
              }
              for (const line of stdout.split(/\r?\n/)) {
                const lower = line.toLowerCase();
                if (
                  !lower.includes("zombie.network.gameserver") &&
                  !lower.includes("projectzomboid64") &&
                  !lower.includes("projectzomboid32")
                ) {
                  continue;
                }
                // Skip our own grep / pgrep / ps invocations
                if (
                  /\b(ps|pgrep|grep)\b.*\b(zombie|projectzomboid)/.test(
                    lower,
                  ) &&
                  !lower.includes("java") &&
                  !lower.includes("-server")
                ) {
                  continue;
                }
                // ps aux columns: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
                const m = line
                  .trim()
                  .match(
                    /^\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/,
                  );
                const pid = m ? m[1] : undefined;
                const cmd = m ? m[2] : line.trim();
                if (!isLinuxDedicatedServerCommandLine(cmd)) continue;
                pushMatch(cmd, pid);
              }
              this.isRunning = matched.length > 0;
              resolve({ running: matched.length > 0, matched });
            });
          },
        );
      }
    });
  }

  async getProcessUptimeSeconds(pid) {
    if (isWindows || !/^\d+$/.test(String(pid || ""))) return null;

    return new Promise((resolve) => {
      execFile(
        "ps",
        ["-o", "etimes=", "-p", String(pid)],
        { timeout: 3000 },
        (error, stdout) => {
          if (error) return resolve(null);
          const seconds = Number.parseInt(stdout.trim(), 10);
          resolve(Number.isFinite(seconds) && seconds >= 0 ? seconds : null);
        },
      );
    });
  }

  async startServer({ skipRunningCheck = false } = {}) {
    // Prevent concurrent start attempts
    if (this._starting) {
      throw new Error("Server start already in progress");
    }
    // Prevent start while a stop is still in flight. Without this guard, a
    // start() during a 1-second stop window can have its freshly-set state
    // wiped by the pending stop-timeout callback, leaving a live process
    // orphaned while the manager reports running:false.
    if (this._stopping) {
      throw new Error("Server stop in progress, try again in a moment");
    }
    this._starting = true;

    try {
      // Force reload config from database before starting (settings may have
      // changed). Reload the SAME server this instance was scoped to
      // (this._serverId — null means "the active server", unchanged from
      // before) instead of always snapping back to whichever server is
      // active, which would break a throwaway instance mid-restart.
      this.configLoaded = false;
      await this.loadConfig(this._serverId);

      if (!this.startCommand && !this.serverPath) {
        throw new Error("Server path not configured");
      }

      if (!skipRunningCheck) {
        const isRunning = await this.checkServerRunning();
        if (isRunning) {
          throw new Error("Server is already running");
        }

        // Defense in depth: even if process detection failed (WMI timeout),
        // check if the RCON port is already occupied. If something is listening
        // on it, a PZ server is almost certainly running and starting another
        // would crash on port conflict (RakNet Code 5).
        // Uses THIS server's RCON port — checking the global default would
        // abort a second server's start just because the first one is up.
        const rconPort =
          parseInt(this.rconPort, 10) ||
          parseInt(await getSetting("rconPort"), 10) ||
          27015;
        const rconHost =
          this.rconHost || (await getSetting("rconHost")) || "127.0.0.1";
        const portInUse = await new Promise((resolve) => {
          const socket = new net.Socket();
          socket.setTimeout(2000);
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("timeout", () => {
            socket.destroy();
            resolve(false);
          });
          socket.once("error", () => {
            socket.destroy();
            resolve(false);
          });
          try {
            socket.connect(rconPort, rconHost);
          } catch {
            resolve(false);
          }
        });
        if (portInUse) {
          throw new Error(
            `RCON port ${rconHost}:${rconPort} is already in use — a server may be running that process detection missed. Aborting start to prevent port conflict.`,
          );
        }
      }

      // Start the server process
      log.info(
        `Starting server process (platform=${process.platform}, serverPath=${this.serverPath}, startCommand=${this.startCommand || "none"}, serverBat=${this.serverBat})`,
      );

      if (this.startCommand) {
        // Validate the custom command before executing
        const validation = validateStartCommand(this.startCommand);
        if (!validation.valid) {
          throw new Error(`Invalid start command: ${validation.reason}`);
        }

        // Custom start command — split into command and arguments
        const parts = this.startCommand.match(/(?:[^\s"]+|"[^"]*")+/g) || [
          this.startCommand,
        ];
        const cmd = parts[0].replace(/^"|"$/g, "");
        const args = parts.slice(1).map((a) => a.replace(/^"|"$/g, ""));
        const cwd = this.serverPath || path.dirname(path.resolve(cmd));

        // Validate the command file extension is allowed
        const ext = path.extname(cmd).toLowerCase();
        if (!ALLOWED_CMD_EXTENSIONS.includes(ext)) {
          throw new Error(
            `Start command has disallowed extension '${ext}'. Allowed: ${ALLOWED_CMD_EXTENSIONS.join(", ")}`,
          );
        }

        // Resolve to absolute path and verify it exists
        const resolvedCmd = path.isAbsolute(cmd) ? cmd : path.resolve(cwd, cmd);
        if (!fs.existsSync(resolvedCmd)) {
          throw new Error(`Start command not found: ${resolvedCmd}`);
        }

        log.info(
          `Using custom start command: ${resolvedCmd} ${args.join(" ")} (ext=${ext}, cwd=${cwd})`,
        );

        // Redirect stdout/stderr to a log file (instead of discarding them)
        // so an immediate startup failure can be captured and reported right
        // away, rather than only surfacing as an opaque 30s "polling timed
        // out" (see GitHub issue #14). A file descriptor keeps the child
        // fully detached from this process's own stdio.
        const launchLogPath = this._openLaunchLog();
        const launchStdio = ["ignore", this._launchLogFd, this._launchLogFd];

        if (isWindows && (ext === ".bat" || ext === ".cmd")) {
          this.serverProcess = spawn("cmd.exe", ["/c", resolvedCmd, ...args], {
            cwd,
            detached: true,
            stdio: launchStdio,
          });
        } else if (!isWindows && ext === ".sh") {
          try {
            fs.chmodSync(resolvedCmd, 0o750);
          } catch (e) {
            log.debug(`chmod on custom .sh failed: ${e.message}`);
          }
          const serverAbsPath = path.resolve(cwd);
          const ldPath = buildLdLibraryPath(serverAbsPath);
          log.debug(
            `Spawning custom .sh: bash ${resolvedCmd} ${args.join(" ")} (cwd=${cwd}, LD_LIBRARY_PATH=${ldPath})`,
          );
          this.serverProcess = spawn("bash", [resolvedCmd, ...args], {
            cwd,
            detached: true,
            stdio: launchStdio,
            env: { ...process.env, LD_LIBRARY_PATH: ldPath },
          });
        } else {
          const spawnEnv = isWindows
            ? process.env
            : (() => {
                const serverAbsPath = path.resolve(cwd);
                return {
                  ...process.env,
                  LD_LIBRARY_PATH: buildLdLibraryPath(serverAbsPath),
                };
              })();
          this.serverProcess = spawn(resolvedCmd, args, {
            cwd,
            detached: true,
            stdio: launchStdio,
            env: spawnEnv,
          });
        }
        this._closeLaunchLogFd();

        // Handle spawn errors (e.g., invalid path, permissions)
        this.serverProcess.on("error", (error) => {
          log.error(`Server process error: ${error.message}`);
          this.isRunning = false;
          this.serverProcess = null;
        });

        this.serverProcess.unref();
        this.isRunning = true;
        this.startTime = new Date();

        const crash = await this._waitForImmediateCrash(launchLogPath);
        if (crash) {
          this.isRunning = false;
          this.serverProcess = null;
          throw new Error(
            `Server process exited immediately after starting (code=${crash.exitCode}, signal=${crash.signal || "none"}) — startup failed.${crash.tail ? `\n${crash.tail}` : ""}`,
          );
        }

        await logServerEvent("server_start", "Server started via manager");
        log.info("Server start command executed");

        return { success: true, message: "Server start command executed" };
      }

      const batPath = path.join(this.serverPath, this.serverBat);

      if (!fs.existsSync(batPath)) {
        throw new Error(`Server startup script not found: ${batPath}`);
      }

      const launchLogPath = this._openLaunchLog();
      const launchStdio = ["ignore", this._launchLogFd, this._launchLogFd];

      if (isWindows) {
        this.serverProcess = spawn("cmd.exe", ["/c", this.serverBat], {
          cwd: this.serverPath,
          detached: true,
          stdio: launchStdio,
        });
      } else {
        // Ensure the script is executable
        try {
          fs.chmodSync(batPath, 0o750);
        } catch (e) {
          log.warn(`Could not chmod startup script: ${e.message}`);
        }
        // On Linux, ensure LD_LIBRARY_PATH includes the server's native library dirs
        // so the JVM can find libsteam_api.so and its transitive dependencies.
        // Without this, services/non-login shells won't have the paths set.
        const serverAbsPath = path.resolve(this.serverPath);
        const ldPath = buildLdLibraryPath(serverAbsPath);
        log.debug(
          `Spawning default .sh: bash ${this.serverBat} (cwd=${this.serverPath}, LD_LIBRARY_PATH=${ldPath})`,
        );

        this.serverProcess = spawn("bash", [this.serverBat], {
          cwd: this.serverPath,
          detached: true,
          stdio: launchStdio,
          env: { ...process.env, LD_LIBRARY_PATH: ldPath },
        });
      }
      this._closeLaunchLogFd();

      // Handle spawn errors (e.g., invalid path, permissions)
      this.serverProcess.on("error", (error) => {
        log.error(`Server process error: ${error.message}`);
        this.isRunning = false;
        this.serverProcess = null;
      });

      this.serverProcess.unref();
      this.isRunning = true;
      this.startTime = new Date();

      // Give the process a brief grace period to catch immediate startup
      // failures (bad classpath, missing native libs, etc.) so we can report
      // the real error instead of a generic 30s "polling timed out" (see
      // GitHub issue #14). This also keeps `_starting` true for the duration,
      // which naturally rejects duplicate start requests (e.g. auto-start
      // racing a manual click) that would otherwise slip through before OS
      // process-detection catches up.
      const crash = await this._waitForImmediateCrash(launchLogPath);
      if (crash) {
        this.isRunning = false;
        this.serverProcess = null;
        throw new Error(
          `Server process exited immediately after starting (code=${crash.exitCode}, signal=${crash.signal || "none"}) — startup failed.${crash.tail ? `\n${crash.tail}` : ""}`,
        );
      }

      await logServerEvent("server_start", "Server started via manager");
      log.info("Server start command executed");

      return { success: true, message: "Server start command executed" };
    } finally {
      this._starting = false;
    }
  }

  // Open a fresh launch log file and stash its fd on `this._launchLogFd` for
  // use as spawn() stdio. Returns the log file path (or null if it couldn't
  // be opened, in which case stdio falls back to "ignore" via the fd value).
  _openLaunchLog() {
    const launchLogPath = path.join(
      getDataPaths().logsDir,
      "server-launch.log",
    );
    try {
      this._launchLogFd = fs.openSync(launchLogPath, "w");
      return launchLogPath;
    } catch (e) {
      log.debug(`Could not open launch log file: ${e.message}`);
      this._launchLogFd = "ignore";
      return null;
    }
  }

  // Close our copy of the launch-log fd. The child keeps its own duplicated
  // handle to the file (passed via stdio), so this doesn't affect it.
  _closeLaunchLogFd() {
    if (typeof this._launchLogFd === "number") {
      try {
        fs.closeSync(this._launchLogFd);
      } catch {
        /* already closed */
      }
    }
    this._launchLogFd = null;
  }

  // Wait briefly to see if the just-spawned process exits immediately
  // (crash on startup). Resolves to `{ exitCode, signal, tail }` if it did,
  // or `null` if it's still alive after the grace period.
  _waitForImmediateCrash(launchLogPath) {
    const proc = this.serverProcess;
    if (!proc) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      let graceTimer;
      const readTail = () => {
        try {
          if (launchLogPath && fs.existsSync(launchLogPath)) {
            return fs.readFileSync(launchLogPath, "utf-8").slice(-2000).trim();
          }
        } catch {
          /* best effort */
        }
        return "";
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(graceTimer);
        proc.removeListener("exit", onExit);
        proc.removeListener("error", onError);
        resolve(result);
      };
      const onExit = (exitCode, signal) => {
        finish({ exitCode, signal, tail: readTail() });
      };
      const onError = (error) => {
        finish({
          exitCode: null,
          signal: null,
          tail: `spawn error: ${error.message}`,
        });
      };
      proc.once("exit", onExit);
      proc.once("error", onError);
      graceTimer = setTimeout(() => finish(null), 4000);
    });
  }

  async stopServer(graceful = true) {
    if (graceful) {
      // This should be done via RCON 'quit' command
      // This method is for force stopping
      log.info("Graceful stop requested - use RCON quit command");
      return {
        success: true,
        message: "Use RCON quit command for graceful shutdown",
      };
    }

    // Block overlapping starts while kill/state-clear is pending.
    this._stopping = true;
    try {
      // Only PIDs this server owns: a host can run several dedicated servers
      // and killing every PZ process would take the others down with it.
      const details = await this.getServerProcessDetails();
      const pids = (details.owned || [])
        .map((entry) => entry.pid)
        .filter((pid) => /^\d+$/.test(String(pid ?? "")))
        .map(String);

      if (pids.length > 0) {
        log.info(
          `stopServer: force killing PID(s) for "${this.serverName}": ${pids.join(", ")}`,
        );
        await this._killPids(pids);
        this._clearRunState();
        await logServerEvent(
          "server_stop",
          `Server force stopped (killed PIDs: ${pids.join(", ")})`,
        ).catch((e) => log.warn(`Failed to log event: ${e.message}`));
        return { success: true, message: "Server stopped" };
      }

      if (!details.scanFailed) {
        log.debug(
          `stopServer: no running process belongs to "${this.serverName}"`,
        );
        this._clearRunState();
        return { success: true, message: "Server was not running" };
      }

      // Detection itself failed, so this server's process can't be told apart
      // from any other. Only fall back to the blunt kill-everything path when
      // there is no other local server that could be caught in the blast.
      if (!(await this._isOnlyLocalServer())) {
        throw new Error(
          "Process detection failed and more than one server is configured on this host — force stop aborted rather than risk killing the wrong server. Stop it from its own console window.",
        );
      }

      log.warn(
        "stopServer: process detection failed. Falling back to generic force stop.",
      );
      this._clearRunState();
      await this._genericForceStop();
      await logServerEvent("server_stop", "Server force stopped").catch((e) =>
        log.warn(`Failed to log event: ${e.message}`),
      );
      return { success: true, message: "Forced fallback kill executed" };
    } finally {
      this._stopping = false;
    }
  }

  // Clear state fields so getServerStatus doesn't report a stale startTime /
  // old serverProcess handle after a kill.
  _clearRunState() {
    this.isRunning = false;
    this.serverProcess = null;
    this.startTime = null;
  }

  async _isOnlyLocalServer() {
    try {
      const servers = await getServers();
      return (servers || []).filter((entry) => !entry.isRemote).length <= 1;
    } catch (error) {
      log.debug(`Could not count configured servers: ${error.message}`);
      return false;
    }
  }

  _killPids(pids) {
    return new Promise((resolve) => {
      if (isWindows) {
        let remaining = pids.length;
        for (const pid of pids) {
          execFile("taskkill", ["/PID", pid, "/F"], (killErr) => {
            if (killErr) log.debug(`taskkill ${pid}: ${killErr.message}`);
            if (--remaining === 0) resolve();
          });
        }
        return;
      }

      execFile("kill", ["-9", ...pids], (killErr) => {
        if (killErr) {
          log.warn(
            `Kill returned error (may be normal if process already exited): ${killErr.message}`,
          );
        }
        resolve();
      });
    });
  }

  _genericForceStop() {
    return new Promise((resolve) => {
      if (isWindows) {
        exec("taskkill /IM ProjectZomboid64.exe /F", () => {
          exec(
            "powershell -Command \"Get-CimInstance Win32_Process -Filter \\\"Name='java.exe'\\\" | Where-Object { $_.CommandLine -like '*zombie.network.gameserver*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\"",
            () => resolve(),
          );
        });
        return;
      }

      exec(
        "pkill -9 -f 'zombie.network.[Gg]ame[Ss]erver|[Pp]roject[Zz]omboid64|[Pp]roject[Zz]omboid32'",
        () => resolve(),
      );
    });
  }

  async restartServer(rconService, warningMinutes = 5) {
    try {
      // Helper to send message with timeout (don't let RCON failures block restart)
      const sendWarning = async (msg) => {
        try {
          let timeoutId;
          const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error("RCON timeout")),
              5000,
            );
          });
          await Promise.race([rconService.serverMessage(msg), timeoutPromise]);
          clearTimeout(timeoutId);
        } catch (e) {
          log.warn(`Failed to send restart warning: ${e.message}`);
        }
      };

      // Send warning messages
      const warnings = [5, 4, 3, 2, 1];
      for (const minutes of warnings) {
        if (minutes <= warningMinutes) {
          await sendWarning(`Server restarting in ${minutes} minute(s)!`);
          await this.sleep(60000); // Wait 1 minute between each warning
        }
      }

      // Final warning
      await sendWarning("Server restarting NOW!");
      await this.sleep(5000);

      // Save the world (with timeout)
      try {
        let saveTimeoutId;
        const saveTimeout = new Promise((_, reject) => {
          saveTimeoutId = setTimeout(
            () => reject(new Error("Save timeout")),
            10000,
          );
        });
        await Promise.race([rconService.save(), saveTimeout]);
        clearTimeout(saveTimeoutId);
      } catch (e) {
        log.warn(`Save before restart failed: ${e.message}`);
      }
      await this.sleep(3000);

      // Quit the server (with timeout)
      try {
        let quitTimeoutId;
        const quitTimeout = new Promise((_, reject) => {
          quitTimeoutId = setTimeout(
            () => reject(new Error("Quit timeout")),
            10000,
          );
        });
        await Promise.race([rconService.quit(), quitTimeout]);
        clearTimeout(quitTimeoutId);
      } catch (e) {
        log.warn(`RCON quit failed, will force stop: ${e.message}`);
      }
      await this.sleep(10000);

      // Wait for server to fully stop
      let attempts = 0;
      while ((await this.checkServerRunning()) && attempts < 30) {
        await this.sleep(1000);
        attempts++;
      }

      // Force stop if still running
      if (await this.checkServerRunning()) {
        const forced = await this.stopServer(false);
        if (!forced?.success) {
          throw new Error(
            `The old server process could not be stopped (${forced?.error || "unknown error"}), so it was not restarted`,
          );
        }
        await this.sleep(5000);
      }

      // Extra delay to let OS reap the process
      await this.sleep(3000);

      // Start the server — skip running check, we just confirmed it stopped
      const started = await this.startServer({ skipRunningCheck: true });
      if (!started?.success) {
        return {
          success: false,
          message: `Server stopped but did not start again: ${started?.error || started?.message || "unknown error"}`,
        };
      }

      await logServerEvent("server_restart", "Server restarted");
      return { success: true, message: "Server restarted successfully" };
    } catch (error) {
      log.error(`Restart failed: ${error.message}`);
      throw error;
    }
  }

  async getServerStatus() {
    // Ensure config is loaded before returning status
    await this.loadConfig();

    // Lazy load port and IP
    if (!this.gamePort) {
      this.loadGamePort().catch((err) =>
        log.debug(`Failed to load game port: ${err.message}`),
      );
    }
    const configuredWanIp = getConfiguredIpv4Address("PANEL_WAN_IP");
    if (configuredWanIp) {
      this.publicIp = configuredWanIp;
    } else if (!this.fetchingIp) {
      // Opt-in only: this used to unconditionally call out to a third party
      // (api.ipify.org) on every status check for a LAN-only panel, which is
      // an unnecessary external dependency and a small privacy leak
      // (announces the panel to ipify) for installs that never display or
      // need their public IP. Requires `enablePublicIpLookup` to be set to
      // true (e.g. via a future Settings toggle, or directly in the DB).
      //
      // The cache has a TTL (PUBLIC_IP_CACHE_TTL_MS) so a residential ISP
      // rotating the WAN IP gets picked up automatically instead of the
      // dashboard silently showing a stale, no-longer-yours address forever.
      try {
        const enabled = await getSetting("enablePublicIpLookup");
        if (enabled === true || enabled === "true") {
          const cached = await getSetting("cachedPublicIp");
          const cachedAt = Number(await getSetting("cachedPublicIpAt")) || 0;
          const isStale = Date.now() - cachedAt > PUBLIC_IP_CACHE_TTL_MS;
          if (cached && !isStale) {
            this.publicIp = cached;
          } else {
            this.fetchPublicIp().catch((err) =>
              log.debug(`Failed to fetch public IP: ${err.message}`),
            );
          }
        }
      } catch (err) {
        log.debug(`Public IP lookup setting check failed: ${err.message}`);
      }
    }

    const processDetails = await this.getServerProcessDetails();
    const isRunning = processDetails.running;
    if (isRunning && !this.startTime) {
      const detectedUptime = await this.getProcessUptimeSeconds(
        processDetails.matched[0]?.pid,
      );
      if (detectedUptime != null) {
        this.startTime = new Date(Date.now() - detectedUptime * 1000);
      }
    }

    // Calculate uptime in seconds (not milliseconds)
    const uptimeMs = this.startTime ? Date.now() - this.startTime.getTime() : 0;
    const uptimeSeconds = Math.floor(uptimeMs / 1000);

    return {
      running: isRunning,
      startTime: this.startTime,
      uptime: uptimeSeconds,
      serverPath: this.serverPath,
      configured: !!this.serverPath,
      publicIp: this.publicIp,
      localIp: await this.getLocalIp(),
      port: this.gamePort,
    };
  }

  // All non-internal IPv4 addresses currently present on the host, e.g. one
  // per VPN mesh (Tailscale, ZeroTier) plus the real LAN adapter — so the
  // Settings UI can offer a choice instead of the panel guessing.
  listNetworkInterfaces() {
    const interfaces = os.networkInterfaces();
    const result = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          result.push({ name, address: iface.address });
        }
      }
    }
    return result;
  }

  async getLocalIp() {
    const interfaces = this.listNetworkInterfaces();

    // A user-picked interface (Settings > Network) wins over the env var:
    // it's the more recent, explicit choice. But only while that address is
    // still actually present, so an unplugged VPN doesn't leave the
    // dashboard stuck showing a dead IP forever.
    try {
      const selected = await getSetting("lanIpAddress");
      if (selected && interfaces.some((iface) => iface.address === selected)) {
        return selected;
      }
    } catch (err) {
      log.debug(`lanIpAddress setting lookup failed: ${err.message}`);
    }

    const configuredLanIp = getConfiguredIpv4Address("PANEL_LAN_IP");
    if (configuredLanIp) return configuredLanIp;

    return interfaces[0]?.address || "127.0.0.1";
  }

  async loadGamePort() {
    try {
      const config = await this.getServerConfig();
      if (config && config.DefaultPort) {
        this.gamePort = parseInt(config.DefaultPort, 10);
      }
    } catch (e) {
      // ignore
    }
  }

  async fetchPublicIp() {
    if (this.fetchingIp) return;
    this.fetchingIp = true;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch("https://api.ipify.org?format=json", {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        this.publicIp = data.ip;
        // Cache to DB so we don't need to call out to ipify again on every
        // restart — only when the cached value is missing or stale (see
        // getServerStatus's PUBLIC_IP_CACHE_TTL_MS check).
        try {
          await setSetting("cachedPublicIp", data.ip);
          await setSetting("cachedPublicIpAt", String(Date.now()));
        } catch (_) {
          /* best effort */
        }
      }
    } catch (e) {
      // silent fail
    } finally {
      this.fetchingIp = false;
    }
  }

  async getServerConfig() {
    await this.loadConfig(); // Ensure config is loaded

    if (!this.savePath) {
      return null;
    }

    // Try the actual server name first (proper path: savePath/Server/{serverName}.ini)
    const serverConfigDir = path.join(this.savePath, "Server");
    const serverNameIniPath = path.join(
      serverConfigDir,
      `${this.serverName}.ini`,
    );

    if (fs.existsSync(serverNameIniPath)) {
      log.debug(`Reading config from ${serverNameIniPath}`);
      return this.parseIniFile(serverNameIniPath);
    }

    // Fallback: try old path directly in savePath (for backwards compatibility)
    const configPath = path.join(this.savePath, `${this.serverName}.ini`);
    if (fs.existsSync(configPath)) {
      log.debug(`Reading config from fallback ${configPath}`);
      return this.parseIniFile(configPath);
    }

    // Legacy fallback: servertest.ini
    const legacyPath = path.join(this.savePath, "servertest.ini");
    if (fs.existsSync(legacyPath)) {
      log.debug(`Reading config from legacy ${legacyPath}`);
      return this.parseIniFile(legacyPath);
    }

    // Try alternative path
    const altPath = path.join(this.savePath, "serveroptions.ini");
    if (fs.existsSync(altPath)) {
      return this.parseIniFile(altPath);
    }

    log.warn(
      `No config file found. Tried: ${serverNameIniPath}, ${configPath}, ${legacyPath}`,
    );
    return null;
  }

  parseIniFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const config = {};
      const lines = content.split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith(";")) {
          const [key, ...valueParts] = trimmed.split("=");
          if (key && valueParts.length > 0) {
            config[key.trim()] = valueParts.join("=").trim();
          }
        }
      }

      return config;
    } catch (error) {
      log.error(`Failed to parse config file: ${error.message}`);
      return null;
    }
  }

  async saveServerConfig(config) {
    if (!this.savePath) {
      throw new Error("Save path not configured");
    }

    // Match getServerConfig logic: check Server/ subdirectory first, then fallback paths
    const serverIni = this.serverName
      ? `${this.serverName}.ini`
      : "servertest.ini";
    const serverSubdirPath = path.join(this.savePath, "Server", serverIni);
    let configPath;
    if (fs.existsSync(serverSubdirPath)) {
      configPath = serverSubdirPath;
    } else {
      configPath = path.join(this.savePath, serverIni);
      if (!fs.existsSync(configPath)) {
        configPath = path.join(this.savePath, "servertest.ini");
      }
    }

    try {
      // Read existing file to preserve comments and structure. Locked per-path
      // so an overlapping save can't interleave its read-modify-write with
      // this one and clobber part of the change.
      await withFileLock(configPath, async () => {
        let content = "";
        if (fs.existsSync(configPath)) {
          content = fs.readFileSync(configPath, "utf-8");
        }

        // Update values
        for (const [key, value] of Object.entries(config)) {
          // Validate key is a valid identifier (alphanumeric and underscore only)
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
            log.warn(`Invalid config key skipped: ${key}`);
            continue;
          }
          const escapedKey = escapeRegExp(key);
          const regex = new RegExp(`^${escapedKey}=.*$`, "m");
          // Strip newlines from values to prevent INI injection
          const safeValue = String(value).replace(/[\r\n]/g, "");
          if (content.match(regex)) {
            content = content.replace(regex, `${key}=${safeValue}`);
          } else {
            content += `\n${key}=${safeValue}`;
          }
        }

        writeFileAtomic(configPath, content, "utf-8");
      });
      log.info("Server config saved");
      return { success: true };
    } catch (error) {
      log.error(`Failed to save config: ${error.message}`);
      throw error;
    }
  }

  async getModList() {
    if (!this.savePath) {
      return [];
    }

    try {
      const config = await this.getServerConfig();
      if (!config || !config.Mods) {
        return [];
      }

      const mods = config.Mods.split(";").filter((m) => m.trim());
      const workshopIds = config.WorkshopItems
        ? config.WorkshopItems.split(";").filter((m) => m.trim())
        : [];

      return mods.map((mod, index) => ({
        name: mod,
        workshopId: workshopIds[index] || null,
      }));
    } catch (error) {
      log.error(`Failed to get mod list: ${error.message}`);
      return [];
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  updatePaths(serverPath, savePath) {
    this.serverPath = serverPath || this.serverPath;
    this.savePath = savePath || this.savePath;
  }
}
