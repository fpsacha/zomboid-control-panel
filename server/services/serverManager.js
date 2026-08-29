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
import { parseBoundedInteger } from "../utils/queryNumbers.js";

const isWindows = process.platform === "win32";
// How long a live-looked-up public IP is trusted before re-checking.
// Residential ISPs rotate dynamic WAN IPs periodically; without a TTL the
// dashboard would show a stale, no-longer-yours address indefinitely.
const PUBLIC_IP_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Matches the timeout already used by the process-scan exec calls in
// _scanDedicatedServerProcesses below. taskkill/kill/pkill must never be
// allowed to hang indefinitely (AV interference, a wedged syscall): if they
// do, the awaiting stopServer() never returns, so its `finally` never runs,
// so this._stopping never clears, and the server becomes permanently
// un-start/stop/restartable until the whole panel is restarted. See
// stopServer()'s handling of the { timedOut } result below.
const KILL_EXEC_TIMEOUT_MS = 8000;

export function resolveConfiguredRconPort(value, fallback = 27015) {
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return fallback;
  }
  return parseBoundedInteger(value, null, 1, 65535);
}

function getConfiguredIpv4Address(variableName) {
  const address = process.env[variableName]?.trim();
  return address && net.isIP(address) === 4 ? address : null;
}

export function classifyProcessKillError(error) {
  if (!error) return "success";
  if (error?.killed) return "timedOut";

  const message = `${error?.message || ""} ${error?.stderr || ""}`.toLowerCase();
  if (
    error?.code === "ESRCH" ||
    /no such process|not found|no matching process|no instances|not running/.test(
      message,
    ) ||
    (error?.code === 1 && !String(error?.stderr || "").trim())
  ) {
    return "alreadyGone";
  }

  return "failed";
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
  // `$` (POSIX variable expansion) was already blocked here; `%` is its
  // cmd.exe equivalent and was missing -- on the one spawn target this
  // guard actually protects (Windows .bat/.cmd via cmd.exe /c), an
  // unblocked `%VAR%` still expands into the resolved command line, which
  // is then visible in a process listing. Not chaining on its own (that
  // still needs & | ; or a newline, all blocked below), but the same
  // author-intent that blocked `$` clearly meant to block this too.
  if (/[&|;<>`${}()!%\[\]\n\r]/.test(cmd)) {
    return {
      valid: false,
      reason:
        "Command contains disallowed shell characters: & | ; < > ` $ { } ( ) ! % [ ]",
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

// Linux/macOS equivalent of isWindowsDedicatedServerCommandLine above. Kept
// as a standalone module-level function (not just inline in the scan) so
// the pidfile fast path can classify a single live command line with the
// exact same rule the full OS scan uses, instead of a second copy that
// could drift out of sync.
function isLinuxDedicatedServerCommandLine(commandLine) {
  const lower = String(commandLine || "").toLowerCase();
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
}

// Deliberately BROADER than isLinuxDedicatedServerCommandLine above, and used
// for a different purpose: not to decide ownership, but to decide whether a
// zero-match scan is entitled to claim "definitely not running" at all.
//
// isLinuxDedicatedServerCommandLine requires a specific launch shape
// (zombie.network.GameServer, or ProjectZomboid64/32 combined with a
// -server-ish flag). A REAL dedicated server invoked a different way -- a
// -jar launcher (plausible for Build 42's shaded jar, see
// buildClasspathEntries()'s own comment), a wrapper script, a renamed
// binary -- produces a command line this function would confidently (and
// wrongly) call "not a dedicated server", and the scan around it returns
// `{running:false, scanFailed:false}`: a CONFIDENT wrong answer that skips
// every downstream fallback written to trigger on doubt (2026-08-29 Linux
// bug hunt, live Discord report -- verified false negative:
// isLinuxDedicatedServerCommandLine("... -jar projectzomboid.jar") is false
// even though the process is genuinely a running PZ server).
//
// This can never be made "complete" by adding more shapes to the narrow
// matcher -- there will always be one more shape nobody thought of, failing
// exactly as silently. Instead, the scan casts THIS wider, looser net
// (just "zomboid" or "zombie.network" appearing anywhere) purely to detect
// its own uncertainty: a candidate this catches that the narrow matcher
// rejects is real, positive evidence that we do not have enough
// information to call the server confirmed-stopped -- see
// _scanDedicatedServerProcesses's ambiguous-candidate handling, which turns
// that into scanFailed:true (renders as "unknown", not "stopped" --
// buildHostSignal in serverStatusModel.js already handles that
// distinction correctly; it just never used to receive it here). A
// genuinely idle host -- nothing matching even this loose a pattern --
// still resolves to a confident, correct "stopped", so this does not make
// an actually-stopped server report unknown forever.
function looksZomboidAdjacent(commandLine) {
  const lower = String(commandLine || "").toLowerCase();
  return lower.includes("zomboid") || lower.includes("zombie.network");
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

// Two supported ways to point the panel at a server -- an operator ruling,
// not an accident (2026-08-27, user-report-servertest-ini-and-sandbox-
// reverted-to-default-after-restart): MANAGED (a directory -- the panel
// generates, owns, and regenerates StartServer_<name>.bat/.sh, baking
// -cachedir/-servername into it) or CUSTOM LAUNCHER (a path ending in
// .bat/.sh/.exe -- the operator's own script; the panel launches it as-is
// and never regenerates or manages it). ONE predicate, asked by every
// caller that needs to know which: loadConfig() below (to resolve
// serverBat), server.js's refreshLaunchTargetBeforeStart() (to decide
// whether to regenerate the launch script before a start/restart), and
// servers.js's PUT/POST validation (to decide which shape rule a saved
// installPath/serverPath must satisfy). An existing file-shaped value must
// keep resolving as CUSTOM LAUNCHER -- this codifies behavior loadConfig()
// already had, it does not change it.
export function resolveLaunchMode(server) {
  const raw = server?.serverPath || server?.installPath;
  if (!raw || typeof raw !== "string") {
    return { mode: "managed", launcherPath: null };
  }
  const lower = raw.toLowerCase();
  if (lower.endsWith(".bat") || lower.endsWith(".sh") || lower.endsWith(".exe")) {
    return { mode: "custom", launcherPath: raw };
  }
  return { mode: "managed", launcherPath: null };
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
    this.serverName = null;
    this.startCommand = "";
    this.rconHost = null;
    this.rconPort = null;
    this.isRunning = false;
    this.startTime = null;
    this.configLoaded = false;
    // "managed" (the panel owns and regenerates the launch script) or
    // "custom" (the operator's own .bat/.sh/.exe -- see resolveLaunchMode()).
    this.launchMode = "managed";
    // Which server this instance's currently-loaded config belongs to (null
    // = "the active server", the shared-singleton default). Recorded so
    // internal reload points (e.g. startServer()'s "settings may have
    // changed" refresh) reload the SAME target instead of silently
    // snapping a throwaway instance back to whatever is active.
    this._serverId = null;
    this.publicIp = null;
    this.gamePort = null;
    this.fetchingIp = false;
    // Instance field (not just the module constant) so tests can exercise
    // the real timeout wiring in _killPids/_genericForceStop without
    // waiting out the full production value.
    this._killTimeoutMs = KILL_EXEC_TIMEOUT_MS;
  }

  // Reload config (called when active server changes)
  async reloadConfig(serverId = null) {
    // Reset all config to defaults before reloading
    this.serverPath = process.env.PZ_SERVER_PATH || "";
    this.serverBat = process.env.PZ_SERVER_BAT || getDefaultStartupScript();
    this.savePath = process.env.PZ_SAVE_PATH || "";
    this.serverName = null;
    this.startCommand = "";
    this.rconHost = null;
    this.rconPort = null;
    this.launchMode = "managed";
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

        // CUSTOM LAUNCHER mode: the stored path points at the operator's own
        // .bat/.sh/.exe, not a directory the panel manages. Extract the
        // directory to run in and the launcher file to run.
        const launchMode = resolveLaunchMode(activeServer);
        this.launchMode = launchMode.mode;
        if (launchMode.mode === "custom") {
          const batchFileName = path.basename(launchMode.launcherPath);
          serverDir = path.dirname(launchMode.launcherPath);
          this.serverBat = batchFileName;
          log.debug(`Using custom launcher: ${batchFileName}`);
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
        // Defense in depth: config.js's PUT /app-settings now rejects an
        // unsafe serverName before it can be stored (the real fix), but an
        // install that already has one saved from before that validation
        // existed would otherwise carry it straight into this.serverName /
        // this.serverBat, which getServerConfig()/saveServerConfig() below
        // and the .bat/.sh launch path both interpolate into a filesystem
        // path unguarded. path.basename() unchanged is the same "safe or
        // reject" test serverFiles.js's getServerName() uses -- here a
        // reject just means "treat as if no legacy name were configured"
        // (this.serverName/this.serverBat stay at their prior/default
        // values, exactly like the `if (dbServerName)` false case already
        // did) rather than throwing, since this is a broad state-loading
        // method with many non-request callers, not a single-purpose
        // accessor a route handler can turn straight into a 400.
        if (dbServerName) {
          const safeServerName = path.basename(dbServerName);
          if (safeServerName === dbServerName && safeServerName) {
            this.serverName = dbServerName;
            // Use custom startup script if server was set up through the app
            if (isWindows) {
              this.serverBat = `StartServer_${dbServerName}.bat`;
            } else {
              this.serverBat = `start-server_${dbServerName}.sh`;
            }
          } else {
            log.warn(
              `Ignoring legacy settings.serverName "${dbServerName}" -- contains path-unsafe characters. Re-save the server name in Settings to clear this.`,
            );
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

    // Fast path: if we recorded the PID we spawned and it's still alive
    // with a command line that still looks like (and is attributable to)
    // this server, skip the full host-wide OS scan. On ANY doubt at all —
    // no pidfile, dead PID, or a live PID whose command line no longer
    // matches (including PID reuse by an unrelated process) — this
    // resolves to null and falls through to the exact same scan as before,
    // which remains the ground truth for every uncertain case.
    const fastPath = await this._tryPidFileFastPath();
    if (fastPath) return fastPath;

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

    // A failed scan always resolves to an empty `matched` list, so
    // `resolved.length > 0` is unconditionally false here whenever
    // scanFailed is true -- writing it into the cached this.isRunning would
    // silently overwrite the last known-good state with a confident "not
    // running" the moment detection starts failing, which is exactly the
    // false confidence scanFailed exists to prevent elsewhere. Every reader
    // of this cached field (server/routes/serverStatus.js, the dashboard's
    // host signal) gets the SAME wrong "stopped" a failed detection scan
    // gives it, instead of "we don't know." Leave it at its previous value
    // when the scan couldn't tell.
    if (!scan.scanFailed) {
      this.isRunning = resolved.length > 0;
    }
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
          "getServerProcessDetails: process detection timed out, cannot determine server state",
        );
        resolve({ running: false, matched: [], scanFailed: true });
      }, 10000);

      if (isWindows) {
        const powershellPath = path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        );
        const powershellScript =
          "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(java\\.exe|ProjectZomboid64\\.exe|ProjectZomboid32\\.exe)$' } | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation";
        execFile(
          powershellPath,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            powershellScript,
          ],
          { timeout: 8000 },
          (psError, psStdout, psStderr) => {
            clearTimeout(timeout);
            const stderr = String(psStderr || "").trim();
            if (psError || stderr) {
              const detail = [
                psError?.message,
                stderr,
              ]
                .filter(Boolean)
                .join(": ");
              log.warn(
                `getServerProcessDetails: Windows process scan failed (${detail}), cannot determine server state`,
              );
              resolve({ running: false, matched: [], scanFailed: true });
              return;
            }

            // Empty stdout with NO error is a legitimate, successful result,
            // not a failure: ConvertTo-Csv derives its header from the first
            // object it receives, so an empty filtered Win32_Process pipeline
            // (the normal, expected shape when no PZ server process exists)
            // produces NO output at all -- not even a header row. Confirmed
            // empirically on a real Windows host (2026-08-23): psError is
            // null, exit code 0, psStdout is "". Treating that identically to
            // a real exec failure meant a genuinely STOPPED Windows server
            // could never be confirmed stopped -- deterministically, on every
            // check -- which is exactly the state every fail-closed guard
            // (/wipe included) exists to detect. This is what a real user hit.
            if (!psStdout) {
              this.isRunning = false;
              resolve({ running: false, matched: [] });
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
          },
        );
      } else {
        // Linux/macOS: pgrep first (faster, more reliable), fall back to ps aux -ww.
        // Use the same dedicated-server heuristics as Windows (module-level
        // isLinuxDedicatedServerCommandLine above) so a player running the
        // *game* (ProjectZomboid64) on the same box doesn't false-positive
        // as a running dedicated server. Direct `zombie.network.GameServer`
        // java invocations always qualify.
        //
        // The search itself is deliberately BROADER than
        // isLinuxDedicatedServerCommandLine ("zomboid"/"zombie.network"
        // instead of the narrow launch-shape patterns) -- see
        // looksZomboidAdjacent's own comment. Every candidate this turns up
        // is then classified as CONFIRMED (matches the narrow shape --
        // pushed into `matched`, unchanged behavior) or AMBIGUOUS (matches
        // only the broad net -- something zomboid-related exists that we
        // can't positively identify). Zero confirmed AND zero ambiguous
        // candidates is a genuinely idle host: confidently not running,
        // exactly as before. Zero confirmed but at least one ambiguous
        // candidate is the case this fix exists for: real evidence we
        // can't rule out, so the scan reports scanFailed:true (renders as
        // "unknown" downstream) instead of a confident, possibly wrong,
        // "not running".
        log.debug("getServerProcessDetails: trying pgrep -af first...");
        const ambiguous = [];
        const pushAmbiguous = (cmd) => {
          ambiguous.push(String(cmd || "").slice(0, 240));
        };
        // Bracket-obfuscated (matches the narrow pattern's own existing
        // convention below, NOT a plain -i flag) for the same reason the
        // narrow pattern already relies on it: exec() runs this through
        // `sh -c "<command>"`, and that wrapper's OWN argv, read back by
        // this very scan, literally contains the pattern text -- a plain
        // "zomboid|zombie.network" search string self-matches its own
        // invocation (confirmed empirically: pgrep -afi "zomboid|zombie.
        // network" finds the shell that ran it), which would poison every
        // idle-host check with a permanent false "ambiguous" candidate.
        // "[Zz]omboid" in the wrapper's own argv does not contain the bare
        // substring "zomboid", so it doesn't self-trigger.
        exec(
          'pgrep -af "[Zz]omboid|[Zz]ombie\\.network"',
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
                // Exclude the panel's own process. Unlike the pattern-text
                // self-leak above, this is a REAL, independent process --
                // this panel is very plausibly installed in a path like
                // /opt/zomboid-control-panel/, so its own `node
                // server/index.js` command line genuinely contains
                // "zomboid" and would otherwise show up as a permanent
                // ambiguous candidate on every single scan, on every host
                // running the panel from such a path -- confirmed
                // empirically against this very repo's own scratch path.
                if (pid && Number(pid) === process.pid) continue;
                if (!isLinuxDedicatedServerCommandLine(cmd)) {
                  log.debug(
                    `getServerProcessDetails: pgrep candidate ignored (not a recognized dedicated-server shape, treating as ambiguous): ${cmd.substring(0, 200)}`,
                  );
                  pushAmbiguous(cmd);
                  continue;
                }
                pushMatch(cmd, pid);
              }
              log.debug(
                `getServerProcessDetails: pgrep matched ${matched.length} confirmed / ${ambiguous.length} ambiguous process(es)`,
              );
              clearTimeout(timeout);
              if (matched.length === 0 && ambiguous.length > 0) {
                // Leave this.isRunning at its previous value -- exactly the
                // same "a scan that couldn't tell must not overwrite the
                // last known-good state" rule getServerProcessDetails()
                // already applies via scanFailed for every OTHER uncertain
                // case (see its own comment). Only a scan that ran clean
                // and found nothing at all is entitled to claim false.
                log.warn(
                  `getServerProcessDetails: found ${ambiguous.length} process(es) mentioning zomboid/zombie.network that don't match a known dedicated-server launch shape -- cannot confirm the server is stopped (first: ${ambiguous[0]})`,
                );
                resolve({ running: false, matched: [], scanFailed: true });
                return;
              }
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
                log.warn(
                  `getServerProcessDetails: ps aux scan failed (${err ? err.message : "empty output"}), cannot determine server state`,
                );
                resolve({ running: false, matched: [], scanFailed: true });
                return;
              }
              for (const line of stdout.split(/\r?\n/)) {
                const lower = line.toLowerCase();
                if (!looksZomboidAdjacent(lower)) continue;
                // Skip our own grep / pgrep / ps invocations
                if (
                  /\b(ps|pgrep|grep)\b.*\b(zombie|zomboid|projectzomboid)/.test(
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
                // Exclude the panel's own process -- see the identical
                // exclusion (and its comment) in the pgrep branch above.
                if (pid && Number(pid) === process.pid) continue;
                if (!isLinuxDedicatedServerCommandLine(cmd)) {
                  pushAmbiguous(cmd);
                  continue;
                }
                pushMatch(cmd, pid);
              }
              if (matched.length === 0 && ambiguous.length > 0) {
                log.warn(
                  `getServerProcessDetails: found ${ambiguous.length} process(es) mentioning zomboid/zombie.network that don't match a known dedicated-server launch shape -- cannot confirm the server is stopped (first: ${ambiguous[0]})`,
                );
                resolve({ running: false, matched: [], scanFailed: true });
                return;
              }
              this.isRunning = matched.length > 0;
              resolve({ running: matched.length > 0, matched });
            });
          },
        );
      }
    });
  }

  // Pidfile path is scoped by server name, not a single shared file — this
  // host can run several dedicated servers (see the two-server tests above),
  // and a shared pidfile would let one server's start/stop clobber another's
  // fast-path record. Sanitized because serverName can come from user-edited
  // settings.
  _pidFilePath() {
    const safeName = String(this.serverName || "default").replace(
      /[^a-zA-Z0-9_-]/g,
      "_",
    );
    return path.join(getDataPaths().dataDir, `server-process-${safeName}.json`);
  }

  // Best-effort — a failure to persist the pidfile never blocks a start; it
  // only means the next reacquisition falls through to the full OS scan,
  // which is the existing, already-safe behavior.
  _writePidFile(pid) {
    try {
      const data = {
        pid: String(pid),
        serverName: this.serverName,
        writtenAt: Date.now(),
      };
      fs.writeFileSync(this._pidFilePath(), JSON.stringify(data), "utf-8");
    } catch (e) {
      log.debug(`Could not write server pidfile: ${e.message}`);
    }
  }

  _readPidFile() {
    try {
      const raw = fs.readFileSync(this._pidFilePath(), "utf-8");
      const data = JSON.parse(raw);
      if (!data || !/^\d+$/.test(String(data.pid))) return null;
      return data;
    } catch {
      return null; // Missing, corrupt, or unreadable — treated the same as "no pidfile".
    }
  }

  _deletePidFile() {
    try {
      fs.unlinkSync(this._pidFilePath());
    } catch {
      /* already absent — fine, this is best-effort cleanup */
    }
  }

  // Single-PID command-line lookup used only by the pidfile fast path — far
  // cheaper than the full host-wide scan. Resolves to null (never throws)
  // when the PID isn't alive or the lookup fails/times out, which the fast
  // path treats identically to "no usable pidfile".
  _getLiveCommandLine(pid) {
    if (!/^\d+$/.test(String(pid || ""))) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timeout = setTimeout(() => finish(null), 3000);

      if (isWindows) {
        // Single quotes inside -Filter avoid the nested-double-quote
        // escaping the full scan's exec calls need elsewhere; pid is
        // pre-validated as digits-only above so this interpolation is safe.
        const psCmd = `powershell -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object -ExpandProperty CommandLine"`;
        exec(psCmd, { timeout: 2500 }, (err, stdout) => {
          clearTimeout(timeout);
          finish(err ? null : String(stdout || "").trim() || null);
        });
      } else {
        execFile(
          "ps",
          ["-ww", "-o", "cmd=", "-p", String(pid)],
          { timeout: 2500 },
          (err, stdout) => {
            clearTimeout(timeout);
            finish(err ? null : String(stdout || "").trim() || null);
          },
        );
      }
    });
  }

  // Resolves to a getServerProcessDetails()-shaped result if the recorded
  // pidfile checks out, or null on any doubt (caller then runs the full
  // scan). Deliberately reuses the SAME classification
  // (isWindowsDedicatedServerCommandLine / isLinuxDedicatedServerCommandLine)
  // and the SAME ownership scoring (scoreServerProcessOwnership) as the full
  // scan, rather than a second set of rules — a live PID whose command line
  // no longer matches (e.g. reused by an unrelated process, or now belongs
  // to a different configured server) is exactly the case this must not
  // trust, which is why it falls through instead of reporting "not running".
  async _tryPidFileFastPath() {
    const recorded = this._readPidFile();
    if (!recorded) return null;

    const cmd = await this._getLiveCommandLine(recorded.pid);
    if (!cmd) return null;

    const looksLikeDedicatedServer = isWindows
      ? isWindowsDedicatedServerCommandLine(cmd)
      : isLinuxDedicatedServerCommandLine(cmd);
    if (!looksLikeDedicatedServer) return null;

    const score = scoreServerProcessOwnership(
      cmd,
      this._getOwnershipDescriptor(),
    );
    if (score === -1) return null; // Cmdline now proves this PID belongs to a different server.

    log.debug(
      `getServerProcessDetails: pidfile fast path hit for pid=${recorded.pid}, skipping full scan`,
    );
    this.isRunning = true;
    const entry = { pid: String(recorded.pid), cmd: String(cmd) };
    return {
      running: true,
      matched: [{ pid: entry.pid, cmd: entry.cmd.slice(0, 240) }],
      owned: [entry],
      scanFailed: false,
    };
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
        const processDetails = await this.getServerProcessDetails();
        if (!processDetails || processDetails.scanFailed) {
          throw new Error(
            "Could not confirm the server is stopped because process detection failed",
          );
        }
        if (processDetails.running) {
          throw new Error("Server is already running");
        }

        // Defense in depth: even if process detection failed (WMI timeout),
        // check if the RCON port is already occupied. If something is listening
        // on it, a PZ server is almost certainly running and starting another
        // would crash on port conflict (RakNet Code 5).
        // Uses THIS server's RCON port — checking the global default would
        // abort a second server's start just because the first one is up.
        const configuredRconPort =
          this.rconPort ?? (await getSetting("rconPort"));
        const rconPort = resolveConfiguredRconPort(configuredRconPort);
        if (rconPort === null) {
          throw new Error("Invalid RCON port configuration");
        }
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
          // Reached on Linux only for a no-extension custom command (the
          // other allowed non-Windows extension besides .sh -- a compiled
          // launcher binary or extensionless wrapper script, both common on
          // Linux). Unlike the ".sh" branch above, this spawns resolvedCmd
          // DIRECTLY rather than via `bash`, so the OS itself enforces the
          // execute bit -- a freshly downloaded/copied/SteamCMD-installed
          // file commonly lacks it, and without this chmod the spawn fails
          // with EACCES every time, exactly the class of "worked on my
          // Windows box, dead on Linux" bug this hunt exists to catch.
          if (!isWindows) {
            try {
              fs.chmodSync(resolvedCmd, 0o750);
            } catch (e) {
              log.debug(`chmod on custom command failed: ${e.message}`);
            }
          }
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
        this._writePidFile(this.serverProcess.pid);

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
      this._writePidFile(this.serverProcess.pid);

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
        const killResult = await this._killPids(pids);
        const { timedOut, failed, errors = [] } = killResult;
        if (timedOut) {
          log.warn(
            `stopServer: kill command for "${this.serverName}" (PIDs: ${pids.join(", ")}) did not finish within ${this._killTimeoutMs}ms — could not confirm the process actually exited`,
          );
          await logServerEvent(
            "server_stop",
            `Server stop timed out waiting for kill confirmation (PIDs: ${pids.join(", ")})`,
          ).catch((e) => log.warn(`Failed to log event: ${e.message}`));
          return {
            success: true,
            confirmed: false,
            timedOut: true,
            message:
              "Stop signal sent, but confirmation timed out — check whether the server actually exited before starting it again",
          };
        }
        if (failed) {
          const errorMessage = errors.join("; ") || "kill command failed";
          log.error(
            `stopServer: could not stop "${this.serverName}": ${errorMessage}`,
          );
          return {
            success: false,
            confirmed: false,
            error: errorMessage,
            message: "The server could not be stopped.",
          };
        }
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
      const forceResult = await this._genericForceStop();
      const { timedOut, failed, errors = [] } = forceResult;
      if (timedOut) {
        log.warn(
          `stopServer: generic force stop did not finish within ${this._killTimeoutMs}ms — could not confirm the process actually exited`,
        );
        await logServerEvent(
          "server_stop",
          "Server stop timed out waiting for kill confirmation (generic fallback)",
        ).catch((e) => log.warn(`Failed to log event: ${e.message}`));
        return {
          success: true,
          confirmed: false,
          timedOut: true,
          message:
            "Stop signal sent, but confirmation timed out — check whether the server actually exited before starting it again",
        };
      }
      if (failed) {
        const errorMessage = errors.join("; ") || "force-stop command failed";
        log.error(`stopServer: generic force stop failed: ${errorMessage}`);
        return {
          success: false,
          confirmed: false,
          error: errorMessage,
          message: "The server could not be force-stopped.",
        };
      }
      this._clearRunState();
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
  markServerStopped() {
    this._clearRunState();
  }

  _clearRunState() {
    this.isRunning = false;
    this.serverProcess = null;
    this.startTime = null;
    this._deletePidFile();
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

  // Resolves to { timedOut }. `timedOut` is true when at least one
  // taskkill/kill call didn't finish on its own and had to be aborted by
  // the exec timeout below -- meaning we could NOT confirm the process
  // actually exited, only that we stopped waiting. Distinguished from an
  // ordinary fast kill error (e.g. "process already exited", already
  // treated as harmless) via killErr.killed, which Node sets specifically
  // when its own timeout is what ended the child -- not on a normal
  // nonzero-exit failure.
  _killPids(pids) {
    return new Promise((resolve) => {
      if (isWindows) {
        let remaining = pids.length;
        let timedOut = false;
        const errors = [];
        for (const pid of pids) {
          execFile(
            "taskkill",
            ["/PID", pid, "/F"],
            { timeout: this._killTimeoutMs },
            (killErr) => {
              if (killErr) {
                const outcome = classifyProcessKillError(killErr);
                if (outcome === "timedOut") timedOut = true;
                if (outcome === "failed") errors.push(`PID ${pid}: ${killErr.message}`);
                log.debug(`taskkill ${pid}: ${killErr.message}`);
              }
                if (--remaining === 0) {
                  resolve({ timedOut, failed: errors.length > 0, errors });
                }
            },
          );
        }
        return;
      }

      execFile(
        "kill",
        ["-9", ...pids],
        { timeout: this._killTimeoutMs },
        (killErr) => {
          const outcome = classifyProcessKillError(killErr);
          if (killErr && outcome !== "alreadyGone") {
            log.warn(
              `Kill returned error (may be normal if process already exited): ${killErr.message}`,
            );
          }
          resolve({
            timedOut: outcome === "timedOut",
            failed: outcome === "failed",
            errors: outcome === "failed" ? [killErr.message] : [],
          });
        },
      );
    });
  }

  // Resolves to { timedOut }, same meaning as _killPids above.
  _genericForceStop() {
    return new Promise((resolve) => {
      if (isWindows) {
        let timedOut = false;
        const errors = [];
        exec(
          "taskkill /IM ProjectZomboid64.exe /F",
          { timeout: this._killTimeoutMs },
          (err1) => {
            const outcome1 = classifyProcessKillError(err1);
            if (outcome1 === "timedOut") timedOut = true;
            if (outcome1 === "failed") errors.push(`ProjectZomboid64.exe: ${err1.message}`);
            exec(
              "powershell -Command \"Get-CimInstance Win32_Process -Filter \\\"Name='java.exe'\\\" | Where-Object { $_.CommandLine -like '*zombie.network.gameserver*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\"",
              { timeout: this._killTimeoutMs },
              (err2) => {
                const outcome2 = classifyProcessKillError(err2);
                if (outcome2 === "timedOut") timedOut = true;
                if (outcome2 === "failed") errors.push(`java.exe: ${err2.message}`);
                resolve({ timedOut, failed: errors.length > 0, errors });
              },
            );
          },
        );
        return;
      }

      exec(
        "pkill -9 -f 'zombie.network.[Gg]ame[Ss]erver|[Pp]roject[Zz]omboid64|[Pp]roject[Zz]omboid32'",
        { timeout: this._killTimeoutMs },
        (err) => {
          const outcome = classifyProcessKillError(err);
          resolve({
            timedOut: outcome === "timedOut",
            failed: outcome === "failed",
            errors: outcome === "failed" ? [err.message] : [],
          });
        },
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
        const saveResult = await Promise.race([rconService.save(), saveTimeout]);
        clearTimeout(saveTimeoutId);
        if (!saveResult?.success) {
          throw new Error(
            `Save before restart failed: ${saveResult?.error || "unknown error"}`,
          );
        }
      } catch (e) {
        throw new Error(`Save before restart failed: ${e.message}`);
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
      let processDetails = await this.getServerProcessDetails();
      if (!processDetails || processDetails.scanFailed) {
        throw new Error(
          "Could not confirm the old server stopped because process detection failed",
        );
      }
      let attempts = 0;
      while (processDetails.running && attempts < 30) {
        await this.sleep(1000);
        attempts++;
        processDetails = await this.getServerProcessDetails();
        if (!processDetails || processDetails.scanFailed) {
          throw new Error(
            "Could not confirm the old server stopped because process detection failed",
          );
        }
      }

      // Force stop if still running
      if (processDetails.running) {
        const forced = await this.stopServer(false);
        if (!forced?.success || forced.confirmed === false) {
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
    if (!isRunning && !processDetails.scanFailed) {
      this._clearRunState();
    }
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
      // Distinguishes a confirmed-stopped server from "the process scan
      // itself failed" -- both used to collapse to running: false here,
      // so a hung/erroring OS scan (AV interference, WMI timeout,
      // ps/pgrep unavailable) looked identical to a real stop. Callers
      // that only checked .running had no way to tell.
      scanFailed: Boolean(processDetails.scanFailed),
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
