import express from "express";
import { spawn, exec } from "child_process";
import { promisify } from "util";
import https from "https";
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { createLogger } from "../utils/logger.js";
const log = createLogger("API:Server");
import {
  logServerEvent,
  setSetting,
  getSetting,
  getActiveServer,
  getServers,
} from "../database/init.js";
import { sanitizeError, sanitizeIniValue } from "../utils/sanitize.js";
import { hasIniKeyValue, setIniKeyLine } from "../utils/iniKeyWrite.js";
import { resolveLaunchMode } from "../services/serverManager.js";
import {
  isSteamOperationIdle,
  getActiveSteamOperations,
  clearActiveSteamOperation,
  hasActiveSteamOperation,
  STEAM_OPERATION_IDLE_TIMEOUT_MS,
} from "../services/activeSteamOperations.js";
import { normalizeMemoryGb } from "../utils/memory.js";
import { withFileLock, writeFileAtomic } from "../utils/fileWriteQueue.js";
import { requirePermission } from "../services/permissions.js";
import { runManagedLifecycle } from "../services/managedContainer.js";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
} from "../services/lifecycleCoordinator.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { ProgressCode } from "../utils/progressCodes.js";
import { invalidateMapFolderScan } from "./chunks.js";
import { emitActionResult } from "./scheduler.js";
import { autoInstallBridgeIfNeeded } from "../services/panelBridgeInstaller.js";
import { parseBoundedInteger } from "../utils/queryNumbers.js";
import { confineToRoots } from "../utils/browseRoots.js";
import { isContainerized } from "../utils/dockerDetect.js";

const router = express.Router();

const isWindows = process.platform === "win32";
const execAsync = promisify(exec);

export async function logServerEventBestEffort(...args) {
  try {
    await logServerEvent(...args);
  } catch (error) {
    log.warn(`Could not record server event: ${error.message}`);
  }
}

// Files that only exist in a real PZ server install -- used both to guard
// against deleting the wrong folder (DELETE /delete-files) and, since
// 2026-08-26, to confirm SteamCMD's app_update actually produced a usable
// install rather than just exiting 0 (POST /install). Shared so the two
// checks can't drift apart into two different ideas of "this looks like a
// PZ server."
const PZ_INSTALL_MARKERS = [
  "ProjectZomboid64.json",
  "ProjectZomboid32.json",
  "StartServer64.bat",
  "StartServer32.bat",
  "start-server.sh",
];

function hasPzInstallMarker(dirPath) {
  return PZ_INSTALL_MARKERS.some((marker) => fs.existsSync(path.join(dirPath, marker)));
}

// Get the SteamCMD executable name for the current platform
function getSteamCmdExe(steamcmdPath) {
  const primary = path.join(
    steamcmdPath,
    isWindows ? "steamcmd.exe" : "steamcmd.sh",
  );
  if (fs.existsSync(primary)) return primary;
  // Fallback: plain 'steamcmd' binary (package-manager installs on Linux)
  const fallback = path.join(steamcmdPath, "steamcmd");
  if (!isWindows && fs.existsSync(fallback)) return fallback;
  // System-wide fallback (CentOS/Ubuntu package manager installs)
  if (!isWindows) {
    for (const sysPath of [
      "/usr/games/steamcmd",
      "/usr/bin/steamcmd",
      "/usr/local/bin/steamcmd",
    ]) {
      if (fs.existsSync(sysPath)) return sysPath;
    }
  }
  return primary; // Return primary path even if not found — let caller handle the error
}

// CodeQL js/command-line-injection #10,11,12,13,297 (2026-08-27 triage,
// operator-ruled fix): every call site used to resolve steamcmdExe from a
// per-request steamcmdPath/installPath value, checked only for absoluteness
// and no traversal (isValidPath) -- the DIRECTORY a binary got spawned from
// was fully caller-chosen within one request, with no persistent record of
// intent. Operator's own reasoning for choosing this over a stronger
// capability gate: "a gate on top of a per-request executable path still
// leaves a per-request executable path -- it relies on that gate being
// right forever."
//
// THE RULE, not a count of call sites: no spawn() of a SteamCMD-family
// executable may ever resolve steamcmdExe from a path that wasn't
// persisted as the saved steamcmdPath setting first. Calling this function
// is how an async call site does that. A synchronous context that can't
// await it (see runFirstTimeSetup() below) may resolve via the lower-level
// getSteamCmdExe() directly instead, but ONLY when reusing a path this
// function already persisted earlier in the SAME request -- runFirstTimeSetup
// documents exactly that at its own call. "The single point every spawn()
// goes through" was asserted here once (bughunt-2026-08-31-b,
// completeness-claims audit) and was already false the day it was written;
// check a given spawn() against the rule above, not against this comment's
// name for itself, since a future exception won't update this count either.
//
// candidatePath, when the caller has one (the operator typed/browsed to it
// in THIS request, already passed through isValidPath by the caller), gets
// PERSISTED before this function ever reads the setting back -- so "saved"
// and "used" can never observably diverge, even within the same request
// that just picked the path. Browsing to preview a not-yet-installed path
// still works exactly as before; the difference is that path is now saved
// as a side effect of being previewed/used, not read back from the request
// object a second time for the actual spawn. Omitting candidatePath is the
// steady-state case: resolve whatever is already saved.
async function saveAndResolveSteamCmdExe(candidatePath) {
  if (candidatePath) {
    const current = await getSetting("steamcmdPath");
    if (current !== candidatePath) {
      await setSetting("steamcmdPath", candidatePath);
    }
    // Resolve from candidatePath directly rather than reading the setting
    // back a second time: setSetting() has already been awaited to
    // completion above, so "saved" and "used" can't diverge within this
    // request regardless of it. Re-reading would only add a redundant round
    // trip with no extra safety -- it can't protect against a genuinely
    // concurrent writer from a DIFFERENT request either.
    return getSteamCmdExe(candidatePath);
  }
  const configuredPath = await getSetting("steamcmdPath");
  return configuredPath ? getSteamCmdExe(configuredPath) : null;
}

// Emits one line of SteamCMD's OWN stdout/stderr, forwarded verbatim, with
// no `progressCode` field and no way to attach one. This is the ONLY
// function in this file allowed to emit install:log, steam:log or
// steamcmd:log for a raw passthrough line -- every other emit of those
// three events is an authored line and must carry a progressCode instead.
// That split used to be enforced only by which event name a call site
// picked, and it was violated exactly once (the 32-bit-library warning
// below, our own text going out through steamcmd:log) before anyone was
// even trying to maintain the rule -- see ProgressCode's file header. Going
// through this helper (or not) is what makes "raw" and "authored" mutually
// exclusive now, not a comment.
function emitRawSteamCmdLine(io, event, type, text) {
  io?.emit(event, { type, text });
}

// Self-heal "SteamCMD not found": downloads, extracts and first-time
// initializes SteamCMD into `installPath` on Linux, mirroring the same
// steps as POST /steamcmd/download. Called from /install and /update when
// the configured steamcmdPath is empty — e.g. a fresh volume, or a
// previous install attempt that never finished (permission error, network
// blip, container restarted mid-download, etc.) instead of hard-failing
// with a 400 and making the user manually re-run the setup wizard.
// Windows is intentionally out of scope here (existing callers already
// keep their own hard-fail for isWindows before calling this).
async function ensureSteamCmdLinux(installPath, io) {
  // Persist installPath as the configured steamcmdPath before resolving
  // anything from it -- see saveAndResolveSteamCmdExe's header comment.
  // Both real callers (POST /install, POST /steam-update) already validate
  // installPath with isValidPath() before reaching here.
  const steamcmdExe = await saveAndResolveSteamCmdExe(installPath);
  if (steamcmdExe && fs.existsSync(steamcmdExe)) return steamcmdExe;

  const emit = (event, payload) => {
    try {
      io?.emit(event, payload);
    } catch {
      /* best effort */
    }
  };

  log.warn(
    `SteamCMD not found at ${steamcmdExe}; auto-downloading to ${installPath}...`,
  );
  emit("steamcmd:status", {
    status: "downloading",
    message: "SteamCMD missing — downloading it now...",
    progressCode: ProgressCode.STEAMCMD_LINUX_AUTO_DOWNLOAD_START,
  });

  if (!fs.existsSync(installPath)) {
    fs.mkdirSync(installPath, { recursive: true });
  }

  const tarUrl =
    "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz";
  const tarPath = path.join(installPath, "steamcmd_linux.tar.gz");
  const safeTarPath = tarPath.replace(/'/g, "'\\''");
  const safeTarUrl = tarUrl.replace(/'/g, "'\\''");
  const safeInstallPath = installPath.replace(/'/g, "'\\''");

  try {
    await execAsync(`curl -sSL -o '${safeTarPath}' '${safeTarUrl}'`, {
      timeout: 120000,
    });
  } catch (curlErr) {
    log.warn(`curl download failed (${curlErr.message}), trying wget...`);
    await execAsync(`wget -q -O '${safeTarPath}' '${safeTarUrl}'`, {
      timeout: 120000,
    });
  }

  emit("steamcmd:status", {
    status: "extracting",
    message: "Extracting SteamCMD...",
    progressCode: ProgressCode.STEAMCMD_EXTRACTING,
  });
  await execAsync(`tar -xzf '${safeTarPath}' -C '${safeInstallPath}'`, {
    timeout: 30000,
  });
  try {
    fs.unlinkSync(tarPath);
  } catch {
    /* ignore */
  }
  try {
    fs.chmodSync(path.join(installPath, "steamcmd.sh"), 0o755);
  } catch {
    /* ignore */
  }
  try {
    fs.chmodSync(path.join(installPath, "steamcmd"), 0o755);
  } catch {
    /* ignore */
  }

  emit("steamcmd:status", {
    status: "initializing",
    message: "Initializing SteamCMD (first run)...",
    progressCode: ProgressCode.STEAMCMD_INITIALIZING,
  });
  const ldPaths = [
    path.join(installPath, "linux32"),
    path.join(installPath, "linux64"),
    installPath,
    process.env.LD_LIBRARY_PATH || "",
  ]
    .filter(Boolean)
    .join(":");

  await new Promise((resolve, reject) => {
    const proc = spawn(steamcmdExe, ["+quit"], {
      cwd: installPath,
      env: { ...process.env, LD_LIBRARY_PATH: ldPaths },
    });
    proc.stdout.on("data", (d) =>
      emitRawSteamCmdLine(io, "steamcmd:log", "stdout", d.toString()),
    );
    proc.stderr.on("data", (d) =>
      emitRawSteamCmdLine(io, "steamcmd:log", "stderr", d.toString()),
    );
    proc.on("close", (code) => {
      if (code === 0 || code === 7) {
        resolve();
      } else {
        reject(new Error(`SteamCMD first-run setup exited with code ${code}`));
      }
    });
    proc.on("error", reject);
  });

  if (!fs.existsSync(steamcmdExe)) {
    throw new Error(
      `SteamCMD download completed but ${steamcmdExe} still missing`,
    );
  }

  emit("steamcmd:status", {
    status: "complete",
    message: "SteamCMD installed successfully!",
    path: installPath,
    progressCode: ProgressCode.STEAMCMD_INSTALL_COMPLETE,
  });
  log.info(`SteamCMD auto-installed to ${installPath}`);
  return steamcmdExe;
}

function normalizeSteamBranch(branch) {
  return !branch || branch === "stable" || branch === "public"
    ? "public"
    : branch;
}

function recoverMismatchedSteamBranchManifest(installPath, selectedBranch) {
  const manifestPath = path.join(
    installPath,
    "steamapps",
    "appmanifest_380870.acf",
  );
  if (!fs.existsSync(manifestPath)) return null;

  const manifest = fs.readFileSync(manifestPath, "utf-8");
  const mountedBranch = manifest.match(
    /"MountedConfig"\s*\{[\s\S]*?"BetaKey"\s*"([^"]+)"/,
  )?.[1];
  const targetBranch = normalizeSteamBranch(selectedBranch);
  if (!mountedBranch || mountedBranch === targetBranch) return null;

  const backupPath = `${manifestPath}.bak-${Date.now()}`;
  fs.copyFileSync(manifestPath, backupPath);
  fs.unlinkSync(manifestPath);
  return { mountedBranch, targetBranch, backupPath };
}

export function hasSteamManifestAccessDeniedState(manifest) {
  return /"StateFlags"\s*"6"/.test(manifest);
}

function recoverBlockedSteamManifest(installPath) {
  const manifestPath = path.join(
    installPath,
    "steamapps",
    "appmanifest_380870.acf",
  );
  if (!fs.existsSync(manifestPath)) return null;

  const manifest = fs.readFileSync(manifestPath, "utf-8");
  if (!hasSteamManifestAccessDeniedState(manifest)) return null;

  const backupPath = `${manifestPath}.bak-0x6-${Date.now()}`;
  fs.copyFileSync(manifestPath, backupPath);
  fs.unlinkSync(manifestPath);
  return { backupPath };
}

async function findSteamCmdPath() {
  const configuredPath = await getSetting("steamcmdPath");
  const candidates = [
    configuredPath,
    process.env.STEAMCMD_PATH,
    "/home/steam/steamcmd",
    "/home/steam/Steam/steamcmd",
    "/opt/steamcmd",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(getSteamCmdExe(candidate))) return candidate;
  }

  return null;
}

// activeSteamOperations itself, isSteamOperationIdle, clearActiveSteamOperation
// and hasActiveSteamOperation now live in ../services/activeSteamOperations.js
// (hunt-wave5-2026-08-29) so serverManager.js's startServer() can check the
// same tracked state before spawning the PZ JVM -- see that module's header
// comment for why this couldn't just be a reverse import instead.
const activeSteamOperations = getActiveSteamOperations();

// True only for the exact shape that crashes PZ on first boot: no admin
// password configured AND this server has never actually started (its
// world-save directory doesn't exist yet, so PZ has no admin account and
// would fall back to an interactive stdin prompt the panel can't answer).
// Deliberately narrower than "no admin password" alone -- an
// already-booted server has an admin account regardless of what's
// currently configured, and refusing to start THAT server over an empty
// field would be a new, unrelated regression, not a fix.
export function isFirstBootMissingAdminPassword(activeServer) {
  if (
    !activeServer ||
    activeServer.isRemote ||
    !activeServer.serverName ||
    !activeServer.zomboidDataPath ||
    activeServer.adminPassword
  ) {
    return false;
  }
  const saveDir = path.join(
    activeServer.zomboidDataPath,
    "Saves",
    "Multiplayer",
    activeServer.serverName,
  );
  return !fs.existsSync(saveDir);
}

// Every location serverManager.js's getServerConfig() will accept as "the"
// INI for a server, in the same preference order, given a config directory
// (the Server/ subdirectory a modern PZ install uses) and its parent data
// directory (the legacy layout some installs still have the real file
// under). ensureRconConfigured() below used to check ONLY the first of
// these -- if a particular install's real, fully-configured INI happened to
// live at one of the others, that ini "didn't exist" as far as this
// function could tell, and it would pre-create a bare RCON-only stub AT THE
// WRONG PATH with no backup, discarding every other setting the moment PZ
// picked that file up (2026-08-27 user report: "ini and sandbox settings
// reverted to default" after a restart). Mirrors getServerConfig()'s own
// fallback chain exactly so both halves of the panel agree on where a
// server's real INI is.
export function candidateIniPaths(serverConfigPath, zomboidDataPath, serverName) {
  const candidates = [];
  if (serverConfigPath) {
    candidates.push(path.join(serverConfigPath, `${serverName}.ini`));
  }
  if (zomboidDataPath) {
    candidates.push(path.join(zomboidDataPath, `${serverName}.ini`));
    candidates.push(path.join(zomboidDataPath, "servertest.ini"));
    candidates.push(path.join(zomboidDataPath, "serveroptions.ini"));
  }
  return candidates;
}

// Helper to auto-configure RCON in the server's .ini file
// Called BEFORE server starts to ensure PZ reads the correct RCON credentials on boot.
// If the INI file doesn't exist yet (first run), creates the directory + a minimal INI
// so PZ will merge its defaults with our RCON settings instead of generating a blank password.
export async function ensureRconConfigured() {
  // Declared ahead of the try block, not inside it, so the outer catch
  // below can still reach them to build EACCES guidance -- which of the two
  // configured paths serverConfigPath actually derives from decides only
  // formatWritablePathError()'s label ("install" vs "data"); the write
  // target and the remediation are identical either way, just the noun
  // differs.
  let serverConfigPathKind = "install";
  let serverConfigPath = null;
  try {
    const activeServer = await getActiveServer();
    if (!activeServer) {
      log.debug("ensureRconConfigured: No active server");
      return false;
    }

    serverConfigPathKind = activeServer.serverConfigPath ? "install" : "data";
    serverConfigPath =
      activeServer.serverConfigPath ||
      (activeServer.zomboidDataPath
        ? path.join(activeServer.zomboidDataPath, "Server")
        : null);
    const serverName = activeServer.serverName;
    const rconPassword = activeServer.rconPassword;
    const rconPort = activeServer.rconPort || 27015;

    if (!serverConfigPath || !serverName) {
      log.debug("ensureRconConfigured: Missing serverConfigPath or serverName");
      return false;
    }

    if (!rconPassword) {
      log.debug("ensureRconConfigured: No RCON password configured");
      return false;
    }

    // Prefer an INI that actually exists at any recognized location over
    // the default Server/ path -- see candidateIniPaths()'s comment. Falls
    // back to the default path (unchanged from before) only when none of
    // the candidates exist, which is the genuine "first run" case.
    const iniPath =
      candidateIniPaths(
        serverConfigPath,
        activeServer.zomboidDataPath,
        serverName,
      ).find((candidate) => fs.existsSync(candidate)) ||
      path.join(serverConfigPath, `${serverName}.ini`);

    // Locked per-path: two overlapping calls (e.g. a start request racing a
    // settings save) must not interleave their read-modify-write of the INI.
    return await withFileLock(iniPath, async () => {
      // If the INI doesn't exist, pre-create it with RCON settings so PZ reads them on first boot
      if (!fs.existsSync(iniPath)) {
        log.info(
          `ensureRconConfigured: INI not found — pre-creating ${iniPath} with RCON settings`,
        );
        try {
          // Ensure the Server/ directory exists
          if (!fs.existsSync(serverConfigPath)) {
            fs.mkdirSync(serverConfigPath, { recursive: true });
            log.info(`Created server config directory: ${serverConfigPath}`);
          }
          const safePassword = sanitizeIniValue(rconPassword);
          // Create minimal INI — PZ will fill in all other defaults on first boot
          const minimalIni = `# Auto-generated by Zomboid Control Panel\n# PZ will add remaining default settings on first server start\nRCONPort=${rconPort}\nRCONPassword=${safePassword}\n`;
          writeFileAtomic(iniPath, minimalIni, {
            encoding: "utf-8",
            mode: 0o600,
          });
          log.info(`Pre-created INI with RCON settings (port: ${rconPort})`);
          return true;
        } catch (createError) {
          // Keep the raw errno in the log alongside the friendly guidance --
          // someone debugging still needs the real error, not just the
          // translation of it.
          if (createError.code === "EACCES" && serverConfigPath) {
            const guidance = formatWritablePathError(
              serverConfigPathKind,
              serverConfigPath,
            );
            log.error(
              `Failed to pre-create INI file: ${createError.message} -- ${guidance.message}`,
            );
          } else {
            log.error(`Failed to pre-create INI file: ${createError.message}`);
          }
          return false;
        }
      }

      // INI exists — check if RCON is already configured correctly
      let content = fs.readFileSync(iniPath, "utf-8").replace(/\r\n/g, "\n");
      const hasCorrectPassword = hasIniKeyValue(content, "RCONPassword", rconPassword);
      const hasCorrectPort = hasIniKeyValue(content, "RCONPort", rconPort);

      if (hasCorrectPassword && hasCorrectPort) {
        log.debug("ensureRconConfigured: RCON already configured correctly");
        return true;
      }

      // Update RCON settings in the .ini file
      log.info(`Auto-configuring RCON in ${iniPath}`);

      // Update RCONPassword (sanitize to prevent INI injection via newlines)
      const safePassword = sanitizeIniValue(rconPassword);
      content = setIniKeyLine(content, "RCONPassword", safePassword);
      content = setIniKeyLine(content, "RCONPort", rconPort);

      writeFileAtomic(iniPath, content, { encoding: "utf-8", mode: 0o600 });
      log.info("RCON auto-configured successfully in server .ini file");
      return true;
    });
  } catch (error) {
    if (error.code === "EACCES" && serverConfigPath) {
      const guidance = formatWritablePathError(
        serverConfigPathKind,
        serverConfigPath,
      );
      log.error(
        `ensureRconConfigured error: ${error.message} -- ${guidance.message}`,
      );
    } else {
      log.error(`ensureRconConfigured error: ${error.message}`);
    }
    return false;
  }
}

// Helper functions for multi-server support
async function getServerConfigPath() {
  const activeServer = await getActiveServer();
  if (activeServer?.serverConfigPath) {
    return activeServer.serverConfigPath;
  }
  const legacyPath = await getSetting("serverConfigPath");
  return legacyPath || null;
}

async function getServerName() {
  const activeServer = await getActiveServer();
  if (activeServer?.serverName) {
    return activeServer.serverName;
  }
  const legacyName = await getSetting("serverName");
  // No active server and no legacy settings name either -- "servertest" used
  // to fill in here, which is Project Zomboid's own vanilla single-player/
  // test-server name. On a machine with a real, unrelated PZ install at the
  // default path, an unconfigured panel would silently target its
  // Server/servertest.ini. Callers already gate on `!serverConfigPath`;
  // returning null lets the same gate also catch "no server name configured".
  return legacyName || null;
}

// Security: Sanitize string for use in batch files/commands
function sanitizeForBatch(str) {
  if (!str) return "";
  // Remove or escape dangerous characters for batch files
  return String(str)
    .replace(/[\x00-\x1F\x7F]/g, "") // Remove control chars (CR/LF included --
    // a newline here closes out the current script line early and starts a
    // new one that the supervisor then executes as its own command)
    .replace(/[&|<>^%"`;$(){}[\]!]/g, "") // Remove shell metacharacters
    .replace(/\.\./g, "") // Remove path traversal
    .trim();
}

// Security: Validate server name (alphanumeric, underscore, hyphen, space allowed)
// Spaces are permitted mid-name to match PZ server names like "The Gang Goes To Louisville".
// Leading/trailing spaces are trimmed before validation.
function isValidServerName(name) {
  if (!name || typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 64) return false;
  // Must start and end with alphanumeric/underscore/hyphen; spaces allowed in the middle.
  return /^[a-zA-Z0-9_-][a-zA-Z0-9_\- ]*[a-zA-Z0-9_-]$|^[a-zA-Z0-9_-]$/.test(
    trimmed,
  );
}

// Security: Validate path is safe (no traversal, absolute path)
export function isValidPath(inputPath) {
  if (!inputPath || typeof inputPath !== "string") return false;
  if (inputPath.includes("..")) return false;
  const normalized = path.normalize(inputPath);
  // Check for path traversal attempts
  if (normalized.includes("..")) return false;
  // Must be absolute path
  if (!path.isAbsolute(normalized)) return false;
  return true;
}

function resolveZomboidPaths(installPath, zomboidDataPath) {
  const defaultZomboidDataPath =
    process.env.PZ_SAVE_PATH || `${installPath}_Data`;
  const zomboidPath = zomboidDataPath || defaultZomboidDataPath;

  return {
    zomboidPath,
    serverConfigPath: path.join(zomboidPath, "Server"),
    usesEnvironmentDataPath:
      !zomboidDataPath && Boolean(process.env.PZ_SAVE_PATH),
  };
}

function ensureWritableDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
  fs.accessSync(directoryPath, fs.constants.W_OK);
}

// `kind` selects which of the 4 WRITABLE_PATH_* codes applies -- "install"
// vs "data" is a label word choice, isContainer is a full alternate
// remediation sentence, and neither is a value to interpolate (2026-08-22
// variant-vs-params correction). Returns {message, code, params} rather
// than just the string so every call site can pass `code` and `params`
// straight through to res.json() without recomputing isContainer itself --
// the params-survive-the-formatter check this was built to satisfy.
// platformIsWindows defaults to the module's own isWindows -- container
// detection is Linux-only by design (containers aren't a Windows concept
// for this app), so a real call site never overrides it; a test does, to
// exercise the container branch on a Windows dev machine.
const WRITABLE_PATH_LABELS = Object.freeze({
  install: "Installation path",
  data: "Zomboid data folder",
});

export function formatWritablePathError(
  kind,
  directoryPath,
  platformIsWindows = isWindows,
) {
  const label = WRITABLE_PATH_LABELS[kind];
  const isContainer = !platformIsWindows && isContainerized();
  const baseMessage = `${label} is not writable: ${directoryPath}.`;

  // Wording sharpened 2026-08-29 (Linux bug hunt, "raw EACCES with no
  // pointer to the fix" card): both branches used to correctly detect the
  // problem and then explain it vaguely -- "choose a writable folder" for
  // bare metal (never says WHY this one isn't, or how to fix it in place)
  // and "make it owned by the panel container UID/GID" for Docker (never
  // names the ACTUAL knob, docker-compose.yml's own PUID/PGID env vars,
  // right above the bind-mount lines it documents). Same defect class as
  // "run as Administrator" on Linux and "pull the latest code with git" for
  // a Docker image: the refusal was correct, the instruction was not.
  if (isContainer) {
    return {
      message:
        `${baseMessage} Set PUID/PGID in your .env file to match the owner ` +
        `of this bind-mounted host folder (see docker-compose.yml's Quick ` +
        `Start), then recreate the container.`,
      code:
        kind === "install"
          ? ErrorCode.WRITABLE_PATH_INSTALL_CONTAINER
          : ErrorCode.WRITABLE_PATH_DATA_CONTAINER,
      params: { path: directoryPath },
    };
  }

  return {
    message:
      `${baseMessage} The user running the panel does not own this folder ` +
      `or lacks write permission to it -- fix it with chown/chmod, or ` +
      `choose a folder the panel can already write to.`,
    code:
      kind === "install"
        ? ErrorCode.WRITABLE_PATH_INSTALL_BAREMETAL
        : ErrorCode.WRITABLE_PATH_DATA_BAREMETAL,
    params: { path: directoryPath },
  };
}

// isWindows picks a full alternate remediation sentence, not a value to
// interpolate -- same reasoning/shape as formatWritablePathError's
// isContainer split (2026-08-22 variant-vs-params correction). Platform is
// an explicit param (defaulting to the module's own isWindows) rather than
// read from process.platform inline, so a test can exercise both branches
// without mocking the platform for the whole module.
export function formatDirectoryReadError(
  directoryPath,
  osCode,
  platformIsWindows = isWindows,
) {
  return {
    message: platformIsWindows
      ? `Cannot read ${directoryPath} (${osCode}). Run the panel as an account that can read this folder.`
      : `Cannot read ${directoryPath} (${osCode}). The panel service account needs read and execute permission on this folder and every parent folder.`,
    code: platformIsWindows
      ? ErrorCode.DIRECTORY_READ_FAILED_WINDOWS
      : ErrorCode.DIRECTORY_READ_FAILED_POSIX,
    params: { path: directoryPath, code: osCode },
  };
}

// Security: INI sanitization imported from shared util
// sanitizeIniValue strips \r\n;= to prevent injection

// Shared range constants for the requireIntInRange call sites below AND in
// config.js's PUT /app-settings (which imports these rather than retyping
// the numbers). Exporting these was the actual fix for a claim made in the
// 2026-08-23 validateInt-coerces audit that turned out false: "no
// disagreement possible by construction" was said of two files with sixteen
// hand-typed literal copies of these five numbers and no shared constant
// anywhere -- true only of the FUNCTION (requireIntInRange itself,
// imported), not the ranges. A future range change is one edit here instead
// of a grep-and-hope across both files.
//
// THE PORT SPLIT, AND THE IRONY OF THIS COMMENT (GitHub #118): the fix above
// then asserted its own false claim in the very next sentence -- the
// original version of this comment said game port, RCON port and panel
// port "all mean a bindable TCP port outside the well-known range," so they
// shared one PORT_MIN/PORT_MAX pair. That is a claim about what BINDS a
// socket, and RCON does not inherently belong in it: 1024 is a bind
// constraint (opening a listening socket below it needs root on Linux), and
// nothing here about "is this port bindable" follows from a field being
// named rconPort or sftpPort. The real rule is bind vs. destination, not
// field name:
//   - BIND: a port this PANEL PROCESS itself opens and listens on -- the
//     panel's own HTTP(S) port, or the game port when the panel writes it
//     into the .ini file of a PZ server it is installing/launching on THIS
//     machine. These need BIND_PORT_MIN (1024): who's listening is us.
//   - DESTINATION: a port on someone ELSE's socket that the panel only
//     connects OUT to. SFTP is always this -- its standard port, 22, is
//     the exact value that broke here, because a destination port has no
//     reason to respect a floor that exists only to keep unprivileged
//     processes from binding low ports. DESTINATION_PORT_MIN (1) is correct
//     for it.
// RCON is conceptually a destination too (servers.js's per-server RCON
// config already treats it that way, floor 1, for the multi-server/remote
// case) -- but every RCON call site IN THIS FILE and in config.js's
// app-settings route is specifically the single legacy/locally-managed
// server's own RCON target, never a remote one: /configure-rcon below
// hardcodes rconHost to 127.0.0.1 on every save, and rcon.js's loadConfig()
// documents the global rconHost/rconPort settings this route shares as the
// "legacy" fallback used only when no active multi-server row exists. That
// target is always this machine, so these specific call sites correctly
// stay on BIND_PORT_MIN -- not because "RCON is bindable" as a category
// (it isn't, and servers.js's remote RCON proves it), but because this
// file's RCON fields happen to always target something local. Decide by
// what a field actually points at, not by what it's called -- that
// shortcut is what let a wrong comment stand in as a decision for two
// audits in a row.
export const BIND_PORT_MIN = 1024;
export const BIND_PORT_MAX = 65535;
export const GAME_PORT_MAX = BIND_PORT_MAX - 1;
export const DESTINATION_PORT_MIN = 1;
export const DESTINATION_PORT_MAX = 65535;
export const MEMORY_GB_MIN = 1;
export const MIN_MEMORY_GB_MAX = 64;
export const MAX_MEMORY_GB_MAX = 128;

// Coerces `value` to an integer in [min, max], silently substituting
// defaultVal on NaN or out-of-range input. Despite the old name this
// function replaced ("validateInt"), it does not validate -- it never
// refuses a bad value or tells anyone it was replaced. Only use this for a
// machine-supplied or optional parameter where the substituted default IS
// the designed behaviour (e.g. a listing limit nobody typed deliberately).
// A value a human typed into a field belongs in requireIntInRange below
// instead -- see 2026-08-23 validateInt-coerces audit (server.js call sites
// were split between the two on a case-by-case basis, not a blanket switch).
function coerceIntInRange(value, min, max, defaultVal) {
  const num = parseInt(value, 10);
  if (isNaN(num) || num < min || num > max) return defaultVal;
  return num;
}

// Parses `value` as an integer in [min, max]. Returns { ok: true, value }
// on success, or { ok: false, message } naming the field and the valid
// range on failure -- for a value a human typed into a field, where
// silently substituting something else would leave them believing they set
// something they didn't (a port they typed being silently swapped is the
// motivating case: their firewall rule and port forward end up pointing at
// a number nothing is listening on, with nothing telling them why).
export function requireIntInRange(value, min, max, fieldLabel) {
  const textValue = typeof value === "string" ? value.trim() : null;
  const num =
    typeof value === "number"
      ? value
      : textValue && /^[+-]?\d+$/.test(textValue)
        ? Number(textValue)
        : Number.NaN;
  if (!Number.isInteger(num) || num < min || num > max) {
    return {
      ok: false,
      message: `${fieldLabel} must be a whole number between ${min} and ${max}.`,
    };
  }
  return { ok: true, value: num };
}

// Build the Java classpath entries for launching the dedicated server.
// PZ's required classpath varies significantly by build/version — Build 41
// needs ~15 separate library jars listed individually under java/ (guava,
// lwjgl, javacord, sqlite-jdbc, etc.), while Build 42's shaded jar only
// needs projectzomboid.jar. Hardcoding either list breaks the other build
// with a NoClassDefFoundError (see GitHub issue #14). Instead, scan the
// java/ folder that SteamCMD actually downloaded and include every jar
// present, so the classpath always matches the installed build.
function buildClasspathEntries(installPath) {
  const entries = ["java/."];
  try {
    const javaDir = path.join(installPath, "java");
    if (fs.existsSync(javaDir)) {
      const jars = fs
        .readdirSync(javaDir)
        .filter((f) => f.toLowerCase().endsWith(".jar"))
        .sort();
      for (const jar of jars) {
        entries.push(`java/${jar}`);
      }
    }
  } catch (e) {
    log.warn(`Could not enumerate java/ jars for classpath: ${e.message}`);
  }
  // Fallback if the java/ folder wasn't found/readable (e.g. install not
  // finished yet) — matches the previous hardcoded behavior.
  if (entries.length === 1) {
    entries.push("java/projectzomboid.jar");
  }
  return entries;
}

// Generate a custom startup script with configured options
// Returns { bat: string, sh: string } with both Windows and Linux scripts
export function generateStartupScripts(options) {
  const {
    installPath,
    serverName,
    minMemory = 4,
    maxMemory = 8,
    zomboidDataPath,
    adminPassword,
    serverPort = 16261,
    useNoSteam = false,
    useDebug = false,
  } = options;

  // Sanitize inputs
  const safeServerName = sanitizeForBatch(serverName);
  const safeAdminPassword = adminPassword
    ? sanitizeForBatch(adminPassword)
    : "";
  const safeZomboidDataPath = zomboidDataPath
    ? sanitizeForBatch(zomboidDataPath)
    : "";
  const normalizedMinMemory = normalizeMemoryGb(minMemory, 4);
  const normalizedMaxMemory = normalizeMemoryGb(maxMemory, 8);

  // ZGC grows the heap to -Xmx and is in no hurry to give it back, so a
  // generous max quietly turns into the resident set. SoftMaxHeapSize is the
  // pressure valve: GC aims to stay under it and only spends the rest of -Xmx
  // on real spikes, which keeps PZ from crowding out everything else on the
  // host. 60% of max leaves a wide burst margin.
  const softMaxMemory = Math.max(1, Math.round(normalizedMaxMemory * 0.6));

  // Build JVM arguments (shared between both platforms)
  // IgnoreUnrecognizedVMOptions first: the Linux script falls back to a system
  // JVM when jre64/ is missing, and the newer flags below are fatal on older
  // JVMs unless they're allowed to no-op.
  const jvmArgs = [
    "-XX:+IgnoreUnrecognizedVMOptions",
    "-Djava.awt.headless=true",
    useNoSteam ? "-Dzomboid.steam=0" : "-Dzomboid.steam=1",
    "-Dzomboid.znetlog=1",
    "-XX:+UseZGC",
    `-XX:SoftMaxHeapSize=${softMaxMemory}g`,
    // Return freed heap to the OS in 2 minutes instead of the 5-minute default.
    "-XX:ZUncommitDelay=120",
    // JDK 25+: 8-byte object headers. PZ's heap is millions of small objects
    // (grid squares, tile properties, items), so this is a real footprint win.
    "-XX:+UseCompactObjectHeaders",
    // Scripts/tiles/item names load a lot of duplicate strings.
    "-XX:+UseStringDeduplication",
    "-XX:-CreateCoredumpOnCrash",
    "-XX:-OmitStackTraceInFastThrow",
    `-Xms${normalizedMinMemory}g`,
    `-Xmx${normalizedMaxMemory}g`,
  ];

  if (useDebug) {
    jvmArgs.push("-Ddebug");
  }

  // Linux-only additions. THP cuts TLB misses on ZGC's large heap; it needs the
  // host's transparent_hugepage set to "madvise" or "always" to do anything, and
  // just logs a notice otherwise. urandom keeps startup from blocking on entropy.
  const linuxJvmArgs = [
    ...jvmArgs,
    "-XX:+UseTransparentHugePages",
    "-Djava.security.egd=file:/dev/urandom",
  ];

  // Build game arguments (shared)
  const gameArgs = [`-servername "${safeServerName}"`];

  if (safeZomboidDataPath) {
    gameArgs.push(`-cachedir="${safeZomboidDataPath}"`);
  }

  if (safeAdminPassword) {
    gameArgs.push(`-adminpassword "${safeAdminPassword}"`);
  }

  if (serverPort !== 16261) {
    gameArgs.push(`-port ${serverPort}`);
  }

  if (useNoSteam) {
    gameArgs.push("-nosteam");
  }

  const classpathEntries = buildClasspathEntries(installPath);

  // Windows batch file
  const batchContent = `@echo off
@setlocal enableextensions
@cd /d "%~dp0"

REM =====================================================
REM Project Zomboid Server Startup Script
REM Generated by PZ Server Manager
REM Server Name: ${safeServerName}
REM Memory: ${normalizedMinMemory}GB - ${normalizedMaxMemory}GB
REM =====================================================

SET PZ_CLASSPATH=${classpathEntries.join(";")}

".\\jre64\\bin\\java.exe" ${jvmArgs.join(" ")} -Djava.library.path=natives/;natives/win64/;. -cp %PZ_CLASSPATH% zombie.network.GameServer ${gameArgs.join(" ")}

PAUSE
`;

  // Linux shell script
  const shellContent = `#!/bin/bash
cd "\$(dirname "\$0")"

# =====================================================
# Project Zomboid Server Startup Script
# Generated by PZ Server Manager
# Server Name: ${safeServerName}
# Memory: ${normalizedMinMemory}GB - ${normalizedMaxMemory}GB
# =====================================================

PZ_CLASSPATH="${classpathEntries.join(":")}"

JAVA_CMD="./jre64/bin/java"
if [ ! -f "$JAVA_CMD" ]; then
  # Try common system Java locations (CentOS, Ubuntu, etc.)
  for JPATH in /usr/bin/java /usr/local/bin/java /usr/lib/jvm/jre/bin/java; do
    if [ -f "$JPATH" ]; then
      JAVA_CMD="$JPATH"
      break
    fi
  done
  if [ ! -f "$JAVA_CMD" ]; then
    JAVA_CMD="java"
  fi
fi

# Verify Java is actually available
if ! command -v "$JAVA_CMD" >/dev/null 2>&1; then
  echo "ERROR: Java not found. Install OpenJDK: sudo yum install java-17-openjdk (CentOS) or sudo apt install openjdk-17-jre (Ubuntu)"
  exit 1
fi

INSTDIR="$(dirname "$0")"
export LD_LIBRARY_PATH="\${INSTDIR}/natives/:\${INSTDIR}/natives/linux64/:\${INSTDIR}/linux64/:\${INSTDIR}:\${INSTDIR}/jre64/lib/amd64:\${INSTDIR}/jre64/lib/x86_64:/usr/lib64:\${LD_LIBRARY_PATH}"

"$JAVA_CMD" ${linuxJvmArgs.join(" ")} -Djava.library.path=natives/:natives/linux64/:linux64/:. -cp "$PZ_CLASSPATH" zombie.network.GameServer ${gameArgs.join(" ")}
`;

  return { bat: batchContent, sh: shellContent };
}

// Filename for the per-install sidecar that records the hash of the content
// THIS PANEL last wrote to each startup script. Kept next to the scripts
// rather than a new DB column -- no migration, and it travels naturally with
// a moved/copied install directory the same way the scripts themselves do.
const SCRIPT_FINGERPRINT_FILE = ".pz-panel-scripts.json";

function hashScriptContent(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Regenerate the panel-managed startup script(s), but never let a
 * regeneration silently discard content the panel didn't itself last write.
 *
 * `files` is `[{ path, content }, ...]`. For each: if a file already exists
 * at that path AND its current on-disk hash doesn't match the fingerprint
 * recorded the last time THIS function wrote it, the existing file is backed
 * up (timestamped, alongside the original) before being overwritten. Config
 * changes still always take effect -- every file is written through
 * regardless -- only the decision to back up first depends on provenance.
 *
 * A MISSING fingerprint (no sidecar at all -- true for every install that
 * predates this fix, i.e. the entire upgrade population) is deliberately
 * treated the same as a mismatch, not as "assume unmodified": we cannot
 * prove a pre-fingerprint file is still the panel's own untouched output, so
 * the safe default is one harmless backup on the first post-upgrade start
 * rather than risking a silent clobber of a real hand-edit. A backup nobody
 * needed is a small, one-time cost; treating unknown provenance as safe is
 * exactly the bug this exists to fix.
 *
 * Backups are never pruned -- an unbounded folder of .bak files is a smaller
 * problem than data loss, and every install already has an operator who can
 * clean them up manually. Deliberate choice, not an oversight.
 *
 * Returns an array of human-readable messages, one per file that was backed
 * up (empty if none were). Never throws for a single file's backup/read
 * failure -- that file's regeneration still proceeds and a warning is logged
 * server-side, since "config changes take effect" must not depend on the
 * backup step succeeding.
 */
export function regenerateStartupScriptsWithBackup(installPath, files) {
  const fingerprintPath = path.join(installPath, SCRIPT_FINGERPRINT_FILE);
  let fingerprints = {};
  try {
    fingerprints = JSON.parse(fs.readFileSync(fingerprintPath, "utf8"));
  } catch {
    fingerprints = {}; // missing/corrupt sidecar -- treated as "no known-good fingerprints" below
  }

  const backupMessages = [];
  for (const { path: filePath, content } of files) {
    const fileName = path.basename(filePath);
    let existingContent = null;
    try {
      existingContent = fs.readFileSync(filePath, "utf8");
    } catch {
      existingContent = null; // no prior file -- first-ever generation, nothing to protect
    }

    if (existingContent !== null) {
      const knownHash = fingerprints[fileName];
      const currentHash = hashScriptContent(existingContent);
      if (!knownHash || knownHash !== currentHash) {
        // toISOString() is millisecond-resolution, and two regenerations detected close
        // together (e.g. two hand-edits regenerated back to back in the same test, or two
        // rapid Starts) can land in the same millisecond -- especially on a fast filesystem
        // -- which would make the second backup silently overwrite the first. Disambiguate
        // with a counter suffix so two backups from the same tick never collide.
        let backupPath = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        if (fs.existsSync(backupPath)) {
          let suffix = 2;
          while (fs.existsSync(`${backupPath}-${suffix}`)) suffix++;
          backupPath = `${backupPath}-${suffix}`;
        }
        try {
          fs.copyFileSync(filePath, backupPath);
          backupMessages.push(
            `${fileName} had content the panel didn't last write (a hand-edit, or an install from before this backup existed) -- your version was saved to ${path.basename(backupPath)} before regenerating.`,
          );
        } catch (backupErr) {
          log.warn(
            `Could not back up ${filePath} before regenerating: ${backupErr.message}`,
          );
        }
      }
    }

    try {
      writeFileAtomic(
        filePath,
        content,
        filePath.endsWith(".sh") ? { encoding: "utf8", mode: 0o750 } : "utf8",
      );
      fingerprints[fileName] = hashScriptContent(content);
    } catch (writeErr) {
      log.warn(`Could not write ${filePath}: ${writeErr.message}`);
    }
  }

  try {
    writeFileAtomic(
      fingerprintPath,
      JSON.stringify(fingerprints, null, 2),
      "utf8",
    );
  } catch (fpErr) {
    log.warn(`Could not persist script fingerprint file: ${fpErr.message}`);
  }

  return backupMessages;
}

// Role sweep for this file: routes below are grouped into what's actually
// operational duty (start/stop/restart/save the running process, install or
// update the game, edit its .ini config, browse the filesystem to set that
// up) vs. what's read-only status/info or in-game/GM authority that every
// role legitimately uses. Wipe and delete-files stay admin-only, unchanged.
//
// UPDATE: the weather/events/alarm/message/removezombies/releasesafehouse
// group below, previously left open with no gate at all (every signed-in
// role reached them, same as any other GM tool), is now
// requirePermission("server.world_events") -- folded into the matrix and
// granted to admin+technician+moderator by default, so this is a zero-
// behaviour-change addition, not a restriction (adding a capability isn't
// narrowing anything). Only /status and /network-interfaces stay
// deliberately outside the matrix entirely: dashboard-wide reads that
// protect nothing if gated and can break a screen for a role if mis-set.
// Everything left unguarded below is that deliberate exception, not an
// oversight.

// Get server status
router.get("/status", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    const rconService = req.app.get("rconService");
    log.debug("GET /status");

    const status = await serverManager.getServerStatus();
    const rconStatus = rconService.getConfig();

    res.json({
      ...status,
      rcon: rconStatus,
    });
  } catch (error) {
    log.error(`Failed to get server status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// List every non-internal IPv4 address the host currently has (one per
// network adapter/VPN mesh) so Settings can offer a picker instead of the
// dashboard guessing which one to show.
router.get("/network-interfaces", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    res.json({ interfaces: serverManager.listNetworkInterfaces() });
  } catch (error) {
    log.error(`Failed to list network interfaces: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Refresh everything PZ needs to launch correctly against this server's
// CURRENT settings: RCON credentials in the ini, and the generated launch
// script (which bakes -cachedir/-servername/memory/admin-password as
// literal text at generation time -- see generateStartupScripts()). Shared
// by the manual /start route below AND scheduler.js's performRestart(), so
// a scheduled restart launches the server exactly the way a manual start
// does instead of silently diverging on this. Before this existed, a
// Settings-UI edit to zomboidDataPath/serverName updated the database
// immediately but left the already-written launch script untouched until
// the next MANUAL start regenerated it -- the next SCHEDULED restart in
// between launched PZ against the OLD baked cachedir, PZ found no ini at
// that (now-wrong) location, and generated itself a fresh default one
// (2026-08-27, user-report-servertest-ini-and-sandbox-reverted-to-default-
// after-restart, loonE/Discord -- root cause confirmed by Jim's
// scheduledRestartStaleLaunchScript.test.js reproduction).
//
// `managedHandled` mirrors the /start route's own `managed.handled` check:
// a container-managed server's image owns the launch command, so there is
// no local script to regenerate.
//
// Operator ruling 2026-08-27 (custom-launcher-as-a-real-supported-mode-not-
// an-accident): a stored serverPath/installPath ending in .bat/.sh/.exe is
// CUSTOM LAUNCHER mode, not an error -- resolveLaunchMode() (serverManager.js)
// is the one predicate both this function AND scheduler.js's performRestart()
// (via this same function) ask, so the two agree on what "managed" means
// without either growing its own notion of it.
export async function refreshLaunchTargetBeforeStart(
  activeServer,
  { managedHandled = false } = {},
) {
  try {
    const rconReady = await ensureRconConfigured();
    if (rconReady) {
      log.info("RCON pre-configured in INI before server start");
    } else {
      log.warn(
        "Could not pre-configure RCON — will retry during startup polling",
      );
    }
  } catch (rconErr) {
    log.warn(`RCON pre-configuration failed: ${rconErr.message}`);
  }

  let scriptBackupWarnings = [];
  const launchMode = resolveLaunchMode(activeServer);
  if (
    !managedHandled &&
    activeServer &&
    !activeServer.startCommand &&
    activeServer.installPath &&
    launchMode.mode === "custom"
  ) {
    // CUSTOM LAUNCHER mode (operator ruling 2026-08-27): the panel does not
    // manage this script. Regenerating would join a filename onto the
    // launcher PATH itself (installPath here is a file, not a directory)
    // and either write into a broken nested path or silently do nothing --
    // neither is "not regenerating," so this must not even attempt the
    // write, unlike before this feature existed.
    log.info(
      `Custom launcher mode active (${launchMode.launcherPath}) — not regenerating; the panel does not manage this script.`,
    );
  } else if (
    !managedHandled &&
    activeServer &&
    !activeServer.startCommand &&
    activeServer.installPath
  ) {
    try {
      const scripts = generateStartupScripts({
        installPath: activeServer.installPath,
        serverName: activeServer.serverName,
        minMemory: activeServer.minMemory || 4,
        maxMemory: activeServer.maxMemory || 8,
        zomboidDataPath: activeServer.zomboidDataPath || "",
        adminPassword: activeServer.adminPassword || "",
        serverPort: activeServer.serverPort || 16261,
        useNoSteam: activeServer.useNoSteam || false,
        useDebug: activeServer.useDebug || false,
      });
      const batPath = path.join(
        activeServer.installPath,
        `StartServer_${activeServer.serverName}.bat`,
      );
      const shPath = path.join(
        activeServer.installPath,
        `start-server_${activeServer.serverName}.sh`,
      );
      scriptBackupWarnings = regenerateStartupScriptsWithBackup(
        activeServer.installPath,
        [
          { path: batPath, content: scripts.bat },
          { path: shPath, content: scripts.sh.replace(/\r\n/g, "\n") },
        ],
      );
      if (scriptBackupWarnings.length > 0) {
        log.warn(
          `Startup script regeneration backed up existing content: ${scriptBackupWarnings.join(" ")}`,
        );
      }
      log.info("Regenerated startup scripts with current server config");
    } catch (scriptErr) {
      log.warn(`Could not regenerate startup scripts: ${scriptErr.message}`);
    }
  }
  return { scriptBackupWarnings };
}

// Once the process/container is confirmed running, wait for RCON to come up
// (PZ takes 60-180s to fully start) by polling for the port rather than
// blindly waiting, and clear serverStarting when done either way. Shared by
// both the native/managed-lifecycle path (called once the 1s scan-poll below
// confirms isRunning) and the Docker path (called immediately, since Docker's
// own start action already confirms the container is up -- see the /start
// handler's own comment).
async function waitForRconAfterStart({ rconService, discordBot }) {
  log.info("Waiting for RCON to be ready - starting port polling...");

  await rconService.loadConfig(); // Ensure clean config
  const rconHost = rconService.config.host || "127.0.0.1";
  const rconPort = rconService.config.port || 27015;
  log.info(`Monitoring TCP port ${rconHost}:${rconPort} for activity...`);

  let rconConnected = false;
  let rconConfigured = false;
  let portOpen = false;

  // Poll port for up to 5 minutes (300 seconds) - checking every 5 seconds
  const maxPollAttempts = 60;

  for (let i = 0; i < maxPollAttempts; i++) {
    // 1. Check if port is open (if not already found)
    if (!portOpen) {
      portOpen = await rconService.checkPortOpen(rconHost, rconPort);

      if (!portOpen) {
        log.debug(
          `RCON startup: Port ${rconHost}:${rconPort} not yet open (poll ${i + 1}/${maxPollAttempts})...`,
        );
        // Wait 5 seconds before next check
        await new Promise((r) => setTimeout(r, 5000));

        // Periodically try to configure RCON (Wait for .ini to appear)
        if (!rconConfigured && i % 3 === 0) {
          // Every 15s (3 * 5s)
          rconConfigured = await ensureRconConfigured();
          if (rconConfigured) {
            log.info(
              "RCON settings auto-configured in server .ini file during startup wait",
            );
          }
        }
        continue;
      }
      log.info(
        `RCON port ${rconHost}:${rconPort} is now open! Initiating connection...`,
      );
    }

    // 2. Port is open, try to connect
    // Reset connection state before attempt to clear any stalled state
    if (rconService.forceResetConnectionState) {
      rconService.forceResetConnectionState();
    }

    try {
      // Attempt connection with a 15s timeout
      const connectPromise = rconService.connect();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Connection attempt timed out after 15s")),
          15000,
        ),
      );

      await Promise.race([connectPromise, timeoutPromise]);

      if (rconService.connected) {
        log.info("RCON connected successfully after server startup");
        rconConnected = true;
        break;
      } else {
        log.warn(
          `RCON connected to port but authentication/handshake failed. Retrying...`,
        );
        // Wait a bit before retry if port is open but auth fails (service might be starting up)
        await new Promise((r) => setTimeout(r, 5000));
      }
    } catch (e) {
      log.warn(`RCON connection attempt failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // Log completion status
  if (rconConnected) {
    log.info("RCON startup sequence completed - connected");
    discordBot
      ?.sendEventNotification("serverStart", {})
      .catch((err) =>
        log.debug(`Discord serverStart notification failed: ${err.message}`),
      );
  } else {
    log.warn(
      "RCON startup sequence completed - NOT connected (auto-reconnect will keep trying every 30s)",
    );
  }

  // Clear the flag when done - now auto-reconnect can take over
  if (rconService.setServerStarting) {
    rconService.setServerStarting(false);
  } else {
    rconService.serverStarting = false;
  }
}

// Start server
router.post("/start", requirePermission("server.control"), async (req, res) => {
  // Fetched before acquiring the lock (a pure DB read, no lock needed for
  // it) purely so a refusal from a concurrent operation can name which
  // server it's for -- see lifecycleCoordinator.js's comment.
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = acquireLifecycleLock(
    "start",
    activeServerForLock?.name || activeServerForLock?.serverName || null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  let lifecycleLockTransferred = false;
  let lifecycleLockReleased = false;
  const releaseLifecycleLock = () => {
    if (lifecycleLockReleased) return;
    lifecycleLockReleased = true;
    lifecycleLock.release();
  };
  try {
    const activeServer = activeServerForLock;
    log.info(
      `POST /start (server=${activeServer?.name || "unknown"}, remote=${activeServer?.isRemote || false})`,
    );
    if (activeServer?.isRemote) {
      return res.status(400).json({
        error:
          "Cannot start a remote server. Remote servers are managed externally — use RCON to interact.",
        code: ErrorCode.SERVER_START_REMOTE_REFUSED,
      });
    }

    const serverManager = req.app.get("serverManager");
    const rconService = req.app.get("rconService");

    // Keep PanelBridge.lua current on disk before anything spawns -- PZ
    // loads Lua at Java-process startup, so this is the last moment a write
    // here can reach the launch that's about to happen. Must run before
    // BOTH branches below: runManagedLifecycle() below is itself the spawn
    // for a docker-local (bind-mounted) server, and serverManager.startServer()
    // further down is the spawn for a native one. Best-effort and silent by
    // design (autoInstallBridgeIfNeeded's own comment) -- a failed install
    // must never block starting the server (2026-09-02 bridge-enforcement).
    autoInstallBridgeIfNeeded(activeServer);

    // A container-managed server is started through Docker: the panel has no
    // process to spawn, and after a `docker stop` there is nothing left running
    // for it to reattach to.
    const managed = await runManagedLifecycle("start", {
      serverId: activeServer?.id ?? null,
    });
    if (managed.handled && !managed.success) {
      return res.status(502).json({ error: sanitizeError(managed.error) });
    }
    if (managed.alreadyRunning) {
      return res.json(managed);
    }

    // A server that has never booted has no world database and no admin
    // account yet -- PZ creates the admin account interactively on exactly
    // that first boot, prompting on stdin if -adminpassword isn't set. The
    // panel spawns it with no interactive stdin, so it hangs on
    // Scanner.nextLine() and dies with an unreadable
    // java.util.NoSuchElementException, well after this response is long
    // gone (2026-08-26, two independent real-user reports: a server created
    // through the setup wizard could not start at all, because
    // createServer() silently dropped adminPassword on create -- fixed
    // separately in database/init.js -- and nothing here ever refused to
    // launch a server it knew was about to hit this). Scoped to first boot
    // specifically (world save directory absent), not every start with an
    // empty admin password: an already-booted server already has an admin
    // account and genuinely doesn't need this flag to start cleanly.
    if (!managed.handled && isFirstBootMissingAdminPassword(activeServer)) {
      return res.status(400).json({
        error:
          `${activeServer.name || activeServer.serverName} has never started before and has no admin password set. ` +
          `Project Zomboid needs one to create the admin account on first boot, or the server process hangs waiting ` +
          `for console input that will never come and crashes. Set an admin password for this server (My Servers → ` +
          `${activeServer.name || activeServer.serverName} → Admin Password), then try starting again.`,
      });
    }

    // Pre-configure RCON in the INI and regenerate the launch script against
    // this server's CURRENT settings BEFORE starting the process -- see
    // refreshLaunchTargetBeforeStart()'s own comment. Skipped for a managed
    // container: its image owns the launch command.
    const { scriptBackupWarnings } = await refreshLaunchTargetBeforeStart(
      activeServer,
      { managedHandled: managed.handled },
    );

    const result = managed.handled
      ? { success: true, message: managed.message || "Container starting" }
      : await serverManager.startServer({
          serverId: activeServer?.id ?? null,
        });
    if (scriptBackupWarnings.length > 0) {
      result.scriptWarnings = scriptBackupWarnings;
    }

    // Emit status update via Socket.IO
    const io = req.app.get("io");

    // Set flag to prevent RCON reconnect attempts during startup
    // Use setServerStarting which has a 5-minute failsafe timeout
    if (rconService.setServerStarting) {
      rconService.setServerStarting(true);
    } else {
      rconService.serverStarting = true;
    }

    // Docker's own start action already confirms the container is up before
    // runManagedLifecycle() returns (dockerClient.js's lifecycleTimeoutMs
    // comment: "Docker answers only once the action completes") -- unlike
    // the native path below, there is nothing further to poll for. The
    // scan-poll below is ALSO a local host process scan, which for a
    // container-managed server can never see PZ running as PID 1 of a
    // *different* container (GH#114) -- polling it here would just run 30
    // times and always time out, exactly the gap this fix closes. Emit
    // immediately and go straight to waiting for RCON, skipping the poll
    // entirely for this path.
    if (managed.handled) {
      if (io) io.emit("server:status", { running: true });
      log.info("Container start confirmed by Docker; skipping local process poll");
      lifecycleLockTransferred = true;
      void waitForRconAfterStart({
        rconService,
        discordBot: req.app.get("discordBot"),
      })
        .catch((err) =>
          log.error(`Post-start RCON wait failed: ${err.message}`),
        )
        .finally(() => releaseLifecycleLock());
      res.json(result);
      return;
    }

    // Poll for server to actually be running (takes a few seconds to start)
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds max
    let pollCleared = false;

    const pollInterval = setInterval(async () => {
      if (pollCleared) return; // Safety check
      try {
        attempts++;
        // checkServerRunning() collapses a failed detection scan into a
        // bare `false`, indistinguishable from "confirmed not yet running"
        // -- hardcoding scanFailed: false here made that same mistake one
        // layer up, by asserting a clean result the check never actually
        // produced. getServerProcessDetails() is unconditionally present on
        // the real ServerManager, so this branch is currently unreachable;
        // treat "no richer check available" as its own scan failure so a
        // lighter serverManager wired up later still keeps polling/times
        // out with a warning instead of the poll declaring the server never
        // came up while it may simply be unable to tell (2026-08-26 bug
        // hunt finding 3 -- same class already fixed at lines 2901, 3516,
        // 4608 in this file).
        const processDetails =
          typeof serverManager.getServerProcessDetails === "function"
            ? await serverManager.getServerProcessDetails()
            : { running: false, scanFailed: true };

        if (!processDetails || processDetails.scanFailed) {
          if (attempts >= maxAttempts) {
            pollCleared = true;
            clearInterval(pollInterval);
            releaseLifecycleLock();
            if (rconService.setServerStarting) {
              rconService.setServerStarting(false);
            } else {
              rconService.serverStarting = false;
            }
            log.warn(
              "Server start polling timed out without confirming process state",
            );
          }
          return;
        }

        const isRunning = Boolean(processDetails.running);

        if (isRunning) {
          pollCleared = true;
          clearInterval(pollInterval);
          if (io) io.emit("server:status", { running: true });
          log.info("Server detected as running");
          await waitForRconAfterStart({ rconService, discordBot: req.app.get("discordBot") });
          releaseLifecycleLock();
        } else if (attempts >= maxAttempts) {
          pollCleared = true;
          clearInterval(pollInterval);
          releaseLifecycleLock();
          if (rconService.setServerStarting) {
            rconService.setServerStarting(false);
          } else {
            rconService.serverStarting = false;
          }
          log.warn("Server start polling timed out");
        }
      } catch (err) {
        // Clear interval on error to prevent memory leak
        pollCleared = true;
        clearInterval(pollInterval);
        releaseLifecycleLock();
        if (rconService.setServerStarting) {
          rconService.setServerStarting(false);
        } else {
          rconService.serverStarting = false;
        }
        log.error(`Server status poll failed: ${err.message}`);
      }
    }, 1000);
    lifecycleLockTransferred = true;

    // Send immediate response
    res.json(result);
  } catch (error) {
    log.error(`Failed to start server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    if (!lifecycleLockTransferred) releaseLifecycleLock();
  }
});

// Stop server (graceful via RCON)
router.post("/stop", requirePermission("server.control"), async (req, res) => {
  // See /start's comment above for why this is fetched before the lock.
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = acquireLifecycleLock(
    "stop",
    activeServerForLock?.name || activeServerForLock?.serverName || null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  let lifecycleLockTransferred = false;
  let lifecycleLockReleased = false;
  const releaseLifecycleLock = () => {
    if (lifecycleLockReleased) return;
    lifecycleLockReleased = true;
    lifecycleLock.release();
  };
  try {
    const activeServer = activeServerForLock;
    const rconService = req.app.get("rconService");
    const serverManager = req.app.get("serverManager");
    log.info("POST /stop — graceful shutdown requested");

    // Check if RCON is connected first
    if (!rconService.connected) {
      return res
        .status(400)
        .json({
          error: "RCON not connected. Cannot gracefully stop server.",
          code: ErrorCode.SERVER_STOP_RCON_NOT_CONNECTED,
        });
    }

    // Save first — quitting after a failed save discards everything since
    // the last one.
    const saved = await rconService.save({ retryOnConnectionError: false });
    if (!saved?.success) {
      return res.status(502).json({
        error: `Save failed, so the server was left running: ${sanitizeError(saved?.error)}`,
        code: ErrorCode.SERVER_STOP_SAVE_FAILED,
      });
    }

    // A container-managed server must go down through Docker. RCON quit kills
    // PID 1 inside the container, which exits the container and lets its
    // restart policy bring the world straight back up.
    const managed = await runManagedLifecycle("stop", {
      serverId: activeServer?.id ?? null,
    });
    if (managed.handled && !managed.success) {
      return res.status(502).json({
        error: `The world was saved, but the container could not be stopped: ${sanitizeError(managed.error)}`,
        code: ErrorCode.SERVER_STOP_CONTAINER_STOP_FAILED,
      });
    }

    if (!managed.handled && serverManager.loadConfig) {
      await serverManager.loadConfig(activeServer?.id ?? null);
    }
    const serviceManaged = Boolean(
      !managed.handled && serverManager.usesManagedServiceLifecycle?.(),
    );
    const result = managed.handled
      ? { success: true, message: managed.message || "Container stopping" }
      : serviceManaged
        ? await serverManager.stopServer(false, {
            serverId: activeServer?.id ?? null,
          })
        : await rconService.quit({ retryOnConnectionError: false });

    if (!result?.success || result.confirmed === false) {
      return res.status(502).json({
        ...result,
        success: false,
        error: result?.error || result?.message || "Server stop failed",
      });
    }

    if (managed.handled || serviceManaged) {
      // Docker's own stop API blocks until the container actually stops (or
      // it force-kills after its timeout) before ever returning success --
      // unlike RCON quit() below, "success" here already means confirmed,
      // not just accepted, so this claim (including clearing serverManager's
      // cached run state) is honest as-is.
      serverManager?.markServerStopped?.();
      const io = req.app.get("io");
      const checkServerStatusNow = req.app.get("checkServerStatusNow");
      if (typeof checkServerStatusNow === "function") {
        Promise.resolve(checkServerStatusNow("managed-stop")).catch((err) =>
          log.debug(`Post-stop status re-check failed: ${err.message}`),
        );
      } else if (io) {
        io.emit("server:status", { running: false });
      }
      await logServerEventBestEffort(
        "server_stop",
        serviceManaged
          ? `Server stopped through ${serverManager.lifecycleProvider}`
          : "Server stopped via web UI",
      );
      req.app
        .get("discordBot")
        ?.sendEventNotification("serverStop", {})
        .catch((err) =>
          log.debug(`Discord serverStop notification failed: ${err.message}`),
        );
    } else {
      // rconService.quit() only proves the RCON command was accepted -- a
      // reset connection is the normal symptom of a real shutdown, but PZ's
      // own save-and-exit can still be running for a while after (longer on
      // a large world). Reporting this as a confirmed stop -- both over the
      // socket and to Schedule/Discord -- is exactly the "confident label
      // over a blind source" shape this floor has been hunting all night:
      // an operator who reads "Stopped" and acts outside the panel (copies
      // the save folder, edits an ini, pulls a Docker volume) may be acting
      // against a process that is still writing.
      //
      // So: this only asserts the request was ACCEPTED. The real
      // confirmation rides the status watchdog (server/index.js) once it
      // genuinely observes the process gone -- nudged here for a faster
      // signal than waiting out its 10s interval, but the interval is what
      // actually guarantees this resolves even if the nudge is lost.
      // checkServerStatusNow is the SOLE place that decides whether the
      // observed state changed and emits server:status for it; calling it
      // here instead of emitting our own claim is what keeps it from ever
      // going stale the way it did before this fix (2026-08-26 bug hunt).
      const checkServerStatusNow = req.app.get("checkServerStatusNow");
      if (typeof checkServerStatusNow === "function") {
        Promise.resolve(checkServerStatusNow("graceful-stop")).catch((err) =>
          log.debug(`Post-stop status re-check failed: ${err.message}`),
        );
      }
      await logServerEventBestEffort(
        "server_stop",
        "Graceful shutdown requested via web UI",
      );
      result.message =
        result.message || result.response || "Shutdown requested";
      result.confirmed = false;
      monitorGracefulStop(serverManager, releaseLifecycleLock);
      lifecycleLockTransferred = true;
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to stop server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    if (!lifecycleLockTransferred) releaseLifecycleLock();
  }
});

// Force Stop is the escape hatch for when the normal Stop has already
// failed or the server is wedged -- so unlike /stop, /restart and
// docker.js's own action route (which all fail CLOSED: a failed save
// blocks the stop entirely), a failed or slow save here must NEVER block
// the stop, or this stops being an escape hatch and becomes a second way
// to get stuck. But "must never block" doesn't mean "must never try": the
// common case is RCON answers fine and the world gets saved anyway, and
// skipping the attempt outright would throw that away for every operator,
// not just the genuinely wedged one. Bounded to a few seconds -- shorter
// than RconService's own 10s per-command timeout (this.commandTimeout in
// rcon.js), because an operator reaching for Force Stop has already told
// us something is wrong and a slow save is exactly the symptom, not
// something worth waiting out to its normal limit.
const FORCE_STOP_SAVE_TIMEOUT_MS = 3000;
const GRACEFUL_STOP_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;

function monitorGracefulStop(serverManager, releaseLifecycleLock) {
  if (typeof serverManager?.getServerProcessDetails !== "function") {
    releaseLifecycleLock();
    return;
  }

  const deadline = Date.now() + GRACEFUL_STOP_CONFIRMATION_TIMEOUT_MS;
  const poll = async () => {
    try {
      const details = await serverManager.getServerProcessDetails();
      if (details && !details.scanFailed && details.running === false) {
        releaseLifecycleLock();
        return;
      }
    } catch (error) {
      log.debug(`Graceful stop confirmation failed: ${error.message}`);
    }

    if (Date.now() >= deadline) {
      log.warn("Graceful stop confirmation timed out; releasing lifecycle lock");
      releaseLifecycleLock();
      return;
    }

    const timer = setTimeout(() => {
      void poll();
    }, 1000);
    timer.unref?.();
  };

  void poll();
}

// Attempts a save before a force-stop, bounded and FAIL-OPEN: the caller
// gets `saveOutcome` ("saved" | "failed" | "timedOut" | "skipped") but the
// force-stop itself must proceed regardless of what this returns. Applies
// identically on both the Docker-managed and native branches -- the RCON
// save doesn't care how the process gets killed afterwards, and giving the
// two branches different save behaviour would just be a smaller version of
// the same "one button, two meanings depending on a deployment detail"
// defect this whole fix exists to remove.
async function attemptBoundedSaveBeforeForceStop(rconService) {
  if (!rconService?.connected) return "skipped";
  try {
    const saveResult = await Promise.race([
      rconService.save({ retryOnConnectionError: false }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Force-stop save timed out")),
          FORCE_STOP_SAVE_TIMEOUT_MS,
        ),
      ),
    ]);
    return saveResult?.success ? "saved" : "failed";
  } catch {
    // Either our own timeout above fired, or -- belt and braces, not an
    // expected path -- rconService.save() itself rejected (it shouldn't:
    // execute()'s own try/catch never rethrows). Either way this is the
    // "did not get a confirmed save in time" outcome, not a real failure
    // reason to report separately.
    return "timedOut";
  }
}

// Force stop server
router.post("/force-stop", requirePermission("server.control"), async (req, res) => {
  // See /start's comment above for why this is fetched before the lock.
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = acquireLifecycleLock(
    "force-stop",
    activeServerForLock?.name || activeServerForLock?.serverName || null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  try {
    log.info("POST /force-stop — force kill requested");
    const activeServer = activeServerForLock;
    if (activeServer?.isRemote) {
      return res.status(400).json({
        error:
          "Cannot force-stop a remote server. The process is not managed by this panel.",
        code: ErrorCode.SERVER_FORCE_STOP_REMOTE_REFUSED,
      });
    }

    const rconService = req.app.get("rconService");
    const saveOutcome = await attemptBoundedSaveBeforeForceStop(rconService);
    log.info(`POST /force-stop — pre-stop save attempt: ${saveOutcome}`);

    // Killing the PID of a containerized server just triggers its restart
    // policy. Docker's stop escalates SIGTERM to SIGKILL on its own and, unlike
    // a process kill, keeps the container down afterwards.
    const managed = await runManagedLifecycle("stop", {
      serverId: activeServer?.id ?? null,
    });
    if (managed.handled && !managed.success) {
      return res
        .status(502)
        .json({ error: sanitizeError(managed.error), saveOutcome });
    }

    const serverManager = req.app.get("serverManager");
    const result = managed.handled
      ? {
          success: true,
          message: managed.message || "Container stopped.",
        }
      : await serverManager.stopServer(false, {
          serverId: activeServer?.id ?? null,
        });

    if (!result?.success || result.confirmed === false) {
      return res.status(502).json({
        ...result,
        success: false,
        error: result?.error || result?.message || "Force stop failed",
        saveOutcome,
      });
    }

    serverManager?.markServerStopped?.();

    const io = req.app.get("io");
    const checkServerStatusNow = req.app.get("checkServerStatusNow");
    if (typeof checkServerStatusNow === "function") {
      Promise.resolve(checkServerStatusNow("force-stop")).catch((err) =>
        log.debug(`Post-stop status re-check failed: ${err.message}`),
      );
    } else if (io) {
      io.emit("server:status", { running: false });
    }

    res.json({ ...result, saveOutcome });
  } catch (error) {
    log.error(`Failed to force stop server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    lifecycleLock.release();
  }
});

// Restart server
router.post("/restart", requirePermission("server.control"), async (req, res) => {
  // See /start's comment above for why this is fetched before the lock.
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = acquireLifecycleLock(
    "restart",
    activeServerForLock?.name || activeServerForLock?.serverName || null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  let lifecycleLockTransferred = false;
  try {
    const activeServer = activeServerForLock;
    if (activeServer?.isRemote) {
      return res.status(400).json({
        error:
          "Cannot restart a remote server. The process is not managed by this panel.",
        code: ErrorCode.SERVER_RESTART_REMOTE_REFUSED,
      });
    }

    const scheduler = req.app.get("scheduler");
    if (scheduler.restartInProgress) {
      lifecycleLock.release();
      return res.status(409).json(lifecycleInProgressResponse());
    }
    // Parse and clamp warningMinutes to 0-60 (matches /api/scheduler/restart-now)
    let warningMinutes = parseBoundedInteger(
      req.body?.warningMinutes,
      5,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (warningMinutes > 60) {
      warningMinutes = 60; // Cap at 60 minutes
    }

    // Run restart in background with specified warning time. The HTTP
    // response below only confirms the restart was ACCEPTED -- the
    // countdown + graceful shutdown can take minutes, and performRestart()
    // already computes a real {success, message} on every path. This is a
    // second, independent entry point to the exact same call as scheduler.js's
    // POST /restart-now (Dashboard's Restart/Restart Now buttons hit this
    // route; the Scheduler page's own restart control hits that one) --
    // it had the identical blind-success shape that route used to have
    // before the 2026-08-26 bug hunt fixed it there, just never fixed here.
    const io = req.app.get("io");

    // Same reasoning as POST /start: this must run before performRestart()
    // actually respawns the process, not after. A restart can carry a
    // multi-minute warning countdown, so doing this now (synchronously,
    // before performRestart is even invoked) is strictly earlier than
    // necessary, not just early enough (2026-09-02 bridge-enforcement).
    autoInstallBridgeIfNeeded(activeServer);

    const restartPromise = Promise.resolve(
      scheduler.performRestart(warningMinutes, {
        label: "Manual restart",
        lifecycleLock,
      }),
    );
    lifecycleLockTransferred = true;
    void restartPromise
      .then((result) => {
        emitActionResult(io, {
          kind: "restart",
          success: !!result?.success,
          message: result?.message || (result?.success ? "Restart completed" : "Restart failed"),
        });
      })
      .catch((err) => {
        log.error(`Restart failed: ${err.message}`);
        emitActionResult(io, {
          kind: "restart",
          success: false,
          message: err.message,
        });
      })
      .finally(() => lifecycleLock.release());

    res.json({
      success: true,
      message:
        warningMinutes > 0
          ? `Restart initiated with ${warningMinutes} minute warning`
          : "Immediate restart initiated",
    });
  } catch (error) {
    log.error(`Failed to restart server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    if (!lifecycleLockTransferred) lifecycleLock.release();
  }
});

// Save world
router.post("/save", requirePermission("server.control"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.save();
    res.json(result);
  } catch (error) {
    log.error(`Failed to save world: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Message/weather/alarm/removezombies/releasesafehouse below: open to every
// role, deliberately -- these are in-game/GM authority (broadcast a message,
// run a weather or zombie event, release an inactive player's safehouse),
// the same territory as players.js, not server operation.
//
// events/lightning, events/thunder and events/horde are the exception: they
// take an optional username and can strike or spawn a horde AT a named
// player, not just somewhere in the world, so as of 2026-08-27 (operator
// ruling on ranked-bug #5) they are gated on players.endanger_or_impersonate
// instead -- admin-only by default, not open to every role like their
// untargeted siblings above and below.

// Send server message
router.post("/message", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { message } = req.body || {};

    if (!message) {
      return res.status(400).json({ error: "Message is required", code: ErrorCode.SERVER_MESSAGE_REQUIRED });
    }

    if (typeof message !== "string" || message.length > 1000) {
      return res
        .status(400)
        .json({ error: "Message must be a string under 1000 characters", code: ErrorCode.SERVER_MESSAGE_TOO_LONG });
    }

    // Strip newlines/carriage returns to prevent RCON protocol injection
    const safeMessage = message.replace(/[\r\n]/g, " ");

    const result = await rconService.serverMessage(safeMessage);
    res.json(result);
  } catch (error) {
    log.error(`Failed to send message: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Weather controls
router.post("/weather/start-rain", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { intensity } = req.body || {};
    const result = await rconService.startRain(intensity);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/stop-rain", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.stopRain();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/start-storm", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { duration } = req.body || {};
    const result = await rconService.startStorm(duration);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/stop", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.stopWeather();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Events
router.post("/events/chopper", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.triggerChopper();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/events/gunshot", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.triggerGunshot();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/events/lightning", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { username } = req.body || {};
    if (username && (typeof username !== "string" || username.length > 64)) {
      return res.status(400).json({ error: "Invalid username", code: ErrorCode.EVENTS_INVALID_USERNAME });
    }
    const result = await rconService.triggerLightning(username);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/events/thunder", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { username } = req.body || {};
    if (username && (typeof username !== "string" || username.length > 64)) {
      return res.status(400).json({ error: "Invalid username", code: ErrorCode.EVENTS_INVALID_USERNAME });
    }
    const result = await rconService.triggerThunder(username);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/events/horde", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { count, username } = req.body || {};
    // Coerced, not refused: the UI's slider already clamps to [10, 500], so
    // an out-of-range value here only reaches this route via a direct API
    // call, and a smaller-than-asked horde is not a "your setting was
    // silently ignored" story the way a swapped port is -- see
    // 2026-08-23 validateInt-coerces audit.
    const safeCount = coerceIntInRange(count, 1, 500, 50);
    if (username && (typeof username !== "string" || username.length > 64)) {
      return res.status(400).json({ error: "Invalid username", code: ErrorCode.EVENTS_INVALID_USERNAME });
    }
    const result = await rconService.createHorde(safeCount, username);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Fallback branches if dynamic fetch fails
// These are the known valid Steam branches for PZ Dedicated Server (App ID 380870)
const FALLBACK_BRANCHES = [
  { name: "public", description: "Current stable release. Recommended for most servers." },
  { name: "unstable", description: "Build 42 testing branch, including multiplayer. Back up saves and expect mod incompatibilities." },
  { name: "iwbums", description: "Experimental testing branch. Back up saves before switching." },
  { name: "legacy41", description: "Legacy Build 41 branch for older worlds and mods." },
];

router.get("/steamcmd/detect", requirePermission("server.world_events"), async (_req, res) => {
  try {
    const steamcmdPath = await findSteamCmdPath();
    if (!steamcmdPath) {
      return res.json({ found: false, message: "SteamCMD was not found automatically" });
    }

    const configuredPath = await getSetting("steamcmdPath");
    if (configuredPath !== steamcmdPath) {
      await setSetting("steamcmdPath", steamcmdPath);
    }

    res.json({
      found: true,
      path: steamcmdPath,
      executable: getSteamCmdExe(steamcmdPath),
      message: "SteamCMD found automatically",
    });
  } catch (error) {
    log.warn(`Failed to detect SteamCMD: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get available Steam branches for PZ Dedicated Server (App ID 380870)
router.get("/branches", requirePermission("server.install"), async (req, res) => {
  try {
    const steamcmdPath =
      req.query.steamcmdPath || (await getSetting("steamcmdPath"));
    log.info(
      `GET /branches (steamcmdPath=${steamcmdPath || "not configured"})`,
    );

    if (!steamcmdPath) {
      // Return fallback branches if no SteamCMD configured
      return res.json({
        branches: FALLBACK_BRANCHES,
        source: "fallback",
        message: "SteamCMD path not configured, using fallback branches",
      });
    }

    // Unlike every other route in this file that derives an executable path
    // from user input, this one skipped isValidPath() -- steamcmdPath comes
    // straight off the query string, and getSteamCmdExe() + spawn() below
    // would run whatever binary exists at the caller-chosen path. Validate
    // it the same way /install and /steam-update do before it's ever used.
    if (!isValidPath(steamcmdPath)) {
      return res.status(400).json({ error: "Invalid SteamCMD path", code: ErrorCode.STEAMCMD_PATH_INVALID });
    }

    // Persist a query-string candidate before resolving it into something
    // spawn() runs -- see saveAndResolveSteamCmdExe's header comment
    // (CodeQL js/command-line-injection #11). Browsing/previewing a
    // not-yet-saved path still works exactly as before; it's saved as a
    // side effect of being previewed, rather than trusted straight off the
    // query string for the spawn below.
    const steamcmdExe = await saveAndResolveSteamCmdExe(steamcmdPath);
    if (!steamcmdExe || !fs.existsSync(steamcmdExe)) {
      return res.json({
        branches: FALLBACK_BRANCHES,
        source: "fallback",
        message: "SteamCMD not found, using fallback branches",
      });
    }

    // Run SteamCMD to get app info
    const steamcmdArgs = [
      "+login",
      "anonymous",
      "+app_info_update",
      "1",
      "+app_info_print",
      "380870",
      "+quit",
    ];

    const result = await new Promise((resolve, reject) => {
      // On Linux, set LD_LIBRARY_PATH for SteamCMD's 32-bit libraries
      const branchSpawnOpts = { cwd: steamcmdPath, timeout: 60000 };
      if (!isWindows) {
        const ldPaths = [
          path.join(steamcmdPath, "linux32"),
          path.join(steamcmdPath, "linux64"),
          steamcmdPath,
          process.env.LD_LIBRARY_PATH || "",
        ]
          .filter(Boolean)
          .join(":");
        branchSpawnOpts.env = { ...process.env, LD_LIBRARY_PATH: ldPaths };
      }
      const steamcmd = spawn(steamcmdExe, steamcmdArgs, branchSpawnOpts);

      let stdout = "";
      let stderr = "";
      let completed = false;

      // Timeout after 30 seconds
      const timeoutId = setTimeout(() => {
        if (!completed) {
          completed = true;
          steamcmd.kill();
          reject(new Error("SteamCMD timed out"));
        }
      }, 30000);

      steamcmd.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      steamcmd.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      steamcmd.on("close", (code) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);
          resolve({ code, stdout, stderr });
        }
      });

      steamcmd.on("error", (err) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
    });

    // Parse the output to find branches
    const branches = parseSteamBranches(result.stdout);

    if (branches.length === 0) {
      return res.json({
        branches: FALLBACK_BRANCHES,
        source: "fallback",
        message: "Could not parse branches from SteamCMD output",
      });
    }

    res.json({
      branches,
      source: "steam",
      message: "Branches fetched from Steam",
    });
  } catch (error) {
    log.warn(`Failed to fetch Steam branches: ${error.message}`);
    res.json({
      branches: FALLBACK_BRANCHES,
      source: "fallback",
      message: `Error: ${sanitizeError(error.message)}`,
    });
  }
});

// Parse Steam app_info output to extract branches
function parseSteamBranches(output) {
  const branches = [];

  try {
    // Look for the "branches" section in VDF format
    // Format is like:
    // "branches"
    // {
    //   "public"
    //   {
    //     "buildid" "12345"
    //     "timeupdated" "1234567890"
    //   }
    //   "unstable"
    //   {
    //     "buildid" "12346"
    //     "description" "Build 42"
    //     ...
    //   }
    // }

    const branchesMatch = output.match(/"branches"\s*\{([^]*?)\n\t\t\}/);
    const altMatch = !branchesMatch
      ? output.match(/"branches"\s*\{([^]*?)\}\s*"installedrepots"/i)
      : null;

    if (!branchesMatch && !altMatch) {
      return branches;
    }

    const branchesSection = (branchesMatch || altMatch)[1];

    // Extract individual branch names and their properties
    // Match pattern: "branchname" followed by { ... }
    const branchRegex = /^\s*"([^"]+)"\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/gm;
    let match;

    while ((match = branchRegex.exec(branchesSection)) !== null) {
      const branchName = match[1];
      const branchContent = match[2];

      // Skip password-protected branches
      if (
        branchContent.includes('"pwdrequired"') &&
        branchContent.includes('"1"')
      ) {
        continue;
      }

      // Extract description if available
      const descMatch = branchContent.match(/"description"\s+"([^"]+)"/);
      const description = descMatch
        ? descMatch[1]
        : branchName === "public"
          ? "Default stable branch"
          : "";

      // Extract buildid for reference
      const buildMatch = branchContent.match(/"buildid"\s+"(\d+)"/);
      const buildId = buildMatch ? buildMatch[1] : null;

      // Extract time updated
      const timeMatch = branchContent.match(/"timeupdated"\s+"(\d+)"/);
      const timeUpdated = timeMatch
        ? new Date(parseInt(timeMatch[1], 10) * 1000).toISOString()
        : null;

      branches.push({
        name: branchName,
        description: description || branchName,
        buildId,
        timeUpdated,
      });
    }

    // Sort: public first, then alphabetically
    branches.sort((a, b) => {
      if (a.name === "public") return -1;
      if (b.name === "public") return 1;
      return a.name.localeCompare(b.name);
    });
  } catch (err) {
    log.warn(`Failed to parse Steam branches: ${err.message}`);
  }

  return branches;
}

// Helper to build Steam beta arguments as array
function getBetaArgs(branch) {
  if (!branch || branch === "stable" || branch === "public") return [];
  // Backwards compatibility: treat boolean true as 'unstable'
  if (branch === true) return ["-beta", "unstable"];
  // Allow any branch name - Steam will validate it
  return ["-beta", branch];
}

export async function getSteamLoginArgs() {
  const account = String((await getSetting("steamUpdateAccount")) || "").trim();
  if (account) {
    log.warn(
      "Ignoring steamUpdateAccount for SteamCMD updates: the panel cannot complete an interactive password or Steam Guard prompt",
    );
  }
  return ["+login", "anonymous"];
}

// SteamCMD Installation endpoint
router.post("/install", requirePermission("server.install"), async (req, res) => {
  let activeOperationPath = null;
  try {
    const {
      steamcmdPath,
      installPath,
      serverName,
      branch,
      useUnstable, // Legacy support
      // New options
      zomboidDataPath,
      minMemory = 4,
      maxMemory = 8,
      adminPassword,
      serverPort = 16261,
      useUpnp = true,
      useNoSteam = false,
      useDebug = false,
      // RCON settings
      rconPassword,
      rconPort = 27015,
    } = req.body;

    // Determine branch - support both new 'branch' param and legacy 'useUnstable'
    const selectedBranch = branch || (useUnstable ? "unstable" : "stable");
    log.info(
      `POST /install (steamcmd=${steamcmdPath}, install=${installPath}, server=${serverName}, branch=${selectedBranch}, noSteam=${useNoSteam}, debug=${useDebug})`,
    );

    // Validate paths - Security check for path traversal
    if (!steamcmdPath || !installPath || !serverName) {
      return res.status(400).json({
        error: "Missing required fields: steamcmdPath, installPath, serverName",
        code: ErrorCode.INSTALL_MISSING_FIELDS,
      });
    }

    if (!isValidPath(steamcmdPath)) {
      return res.status(400).json({ error: "Invalid SteamCMD path", code: ErrorCode.STEAMCMD_PATH_INVALID });
    }

    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: "Invalid install path", code: ErrorCode.INSTALL_PATH_INVALID });
    }

    if (!isValidServerName(serverName)) {
      return res.status(400).json({
        error:
          "Invalid server name. Use only letters, numbers, underscores, hyphens, and spaces (max 64 chars)",
        code: ErrorCode.SERVER_NAME_FORMAT_INVALID,
      });
    }

    if (zomboidDataPath && !isValidPath(zomboidDataPath)) {
      return res.status(400).json({ error: "Invalid Zomboid data path", code: ErrorCode.ZOMBOID_DATA_PATH_INVALID });
    }

    const { zomboidPath, serverConfigPath, usesEnvironmentDataPath } =
      resolveZomboidPaths(installPath, zomboidDataPath);

    try {
      ensureWritableDirectory(installPath);
    } catch (directoryError) {
      const writableError = formatWritablePathError("install", installPath);
      return res.status(400).json({
        error: writableError.message,
        code: writableError.code,
        params: writableError.params,
      });
    }

    try {
      ensureWritableDirectory(serverConfigPath);
    } catch (directoryError) {
      const writableError = formatWritablePathError("data", zomboidPath);
      return res.status(400).json({
        error: writableError.message,
        code: writableError.code,
        params: writableError.params,
      });
    }

    // Validate numeric inputs -- each of these was explicitly typed into a
    // field by the operator, so an out-of-range value is refused (with a
    // named field + range) rather than silently swapped for a default they
    // never chose. See 2026-08-23 validateInt-coerces audit.
    const minMemoryCheck = requireIntInRange(minMemory, MEMORY_GB_MIN, MIN_MEMORY_GB_MAX, "Minimum memory (GB)");
    if (!minMemoryCheck.ok) {
      return res.status(400).json({ error: minMemoryCheck.message, code: ErrorCode.INVALID_MIN_MEMORY });
    }
    const maxMemoryCheck = requireIntInRange(maxMemory, MEMORY_GB_MIN, MAX_MEMORY_GB_MAX, "Maximum memory (GB)");
    if (!maxMemoryCheck.ok) {
      return res.status(400).json({ error: maxMemoryCheck.message, code: ErrorCode.INVALID_MAX_MEMORY });
    }
    const serverPortCheck = requireIntInRange(serverPort, BIND_PORT_MIN, GAME_PORT_MAX, "Game port");
    if (!serverPortCheck.ok) {
      return res.status(400).json({ error: serverPortCheck.message, code: ErrorCode.INVALID_SERVER_PORT });
    }
    const rconPortCheck = requireIntInRange(rconPort, BIND_PORT_MIN, BIND_PORT_MAX, "RCON port");
    if (!rconPortCheck.ok) {
      return res.status(400).json({ error: rconPortCheck.message, code: ErrorCode.INVALID_RCON_PORT });
    }
    const safeMinMemory = minMemoryCheck.value;
    const safeMaxMemory = maxMemoryCheck.value;
    const safeServerPort = serverPortCheck.value;
    const safeRconPort = rconPortCheck.value;

    // Sanitize string inputs for batch file
    const safeAdminPassword = sanitizeForBatch(adminPassword);

    // Check if steamcmd exists — auto-download it on Linux instead of
    // hard-failing (see ensureSteamCmdLinux for why: fresh volumes, or a
    // previous install that never finished, shouldn't force a manual
    // re-run of the setup wizard).
    // Persist steamcmdPath as the configured setting before resolving an
    // executable from it -- see saveAndResolveSteamCmdExe's header comment
    // (CodeQL js/command-line-injection #12).
    let steamcmdExe = await saveAndResolveSteamCmdExe(steamcmdPath);
    if (!steamcmdExe || !fs.existsSync(steamcmdExe)) {
      if (isWindows) {
        return res
          .status(400)
          .json({ error: `SteamCMD not found at: ${steamcmdExe}`, code: ErrorCode.STEAMCMD_NOT_FOUND_AT_PATH });
      }
      try {
        steamcmdExe = await ensureSteamCmdLinux(
          steamcmdPath,
          req.app.get("io"),
        );
      } catch (dlErr) {
        return res.status(500).json({
          error: `SteamCMD not found and auto-download failed: ${sanitizeError(dlErr.message)}`,
          code: ErrorCode.STEAMCMD_AUTO_DOWNLOAD_FAILED,
        });
      }
    }

    // Prevent concurrent operations on the same install path
    const normalizedPath = path.normalize(installPath).toLowerCase();
    if (hasActiveSteamOperation(normalizedPath)) {
      return res.status(409).json({
        error:
          "A Steam operation is already in progress for this path. Please wait for it to complete.",
        code: ErrorCode.STEAM_OPERATION_IN_PROGRESS_PATH,
      });
    }

    log.info(
      `Starting PZ server installation to ${installPath} (branch: ${selectedBranch})`,
    );

    // Mark operation as active
    activeSteamOperations.set(normalizedPath, {
      type: "install",
      startTime: Date.now(),
      lastOutputAt: Date.now(),
      branch: selectedBranch,
      serverName,
    });
    activeOperationPath = normalizedPath;

    // Build SteamCMD command
    // App ID 380870 is Project Zomboid Dedicated Server
    const betaArgs = getBetaArgs(selectedBranch);
    const loginArgs = await getSteamLoginArgs();
    const steamcmdArgs = [
      "+force_install_dir",
      installPath,
      ...loginArgs,
      "+app_update",
      "380870",
      ...betaArgs,
      "validate",
      "+quit",
    ];

    const io = req.app.get("io");

    // Spawn SteamCMD process
    // On Linux, set LD_LIBRARY_PATH so SteamCMD can find its 32-bit libraries
    const spawnOpts = { cwd: steamcmdPath };
    if (!isWindows) {
      const ldPaths = [
        path.join(steamcmdPath, "linux32"),
        path.join(steamcmdPath, "linux64"),
        steamcmdPath,
        process.env.LD_LIBRARY_PATH || "",
      ]
        .filter(Boolean)
        .join(":");
      spawnOpts.env = { ...process.env, LD_LIBRARY_PATH: ldPaths };
    }
    const steamcmd = spawn(steamcmdExe, steamcmdArgs, spawnOpts);
    activeSteamOperations.get(normalizedPath).pid = steamcmd.pid;
    // A signal-killed process reports code=null to the close handler below,
    // not the exit code INSTALL_FAILED_EXIT_CODE's message names -- tracked
    // so that branch can say "stalled and was stopped" instead of the
    // literal word "null" (2026-08-26 install-failure hunt finding #1).
    let killedByWatchdog = false;
    activeSteamOperations.get(normalizedPath).watchdog = setInterval(() => {
      const activeOperation = activeSteamOperations.get(normalizedPath);
      if (!activeOperation) return;
      if (!isSteamOperationIdle(activeOperation)) return;

      log.error(
        `SteamCMD ${activeOperation.type} produced no output for ${STEAM_OPERATION_IDLE_TIMEOUT_MS / 60000} minutes; terminating the stalled process`,
      );
      killedByWatchdog = true;
      steamcmd.kill();
    }, 30_000);
    activeSteamOperations.get(normalizedPath).watchdog.unref?.();

    let output = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";

    steamcmd.stdout.on("data", (data) => {
      const operation = activeSteamOperations.get(normalizedPath);
      if (operation) operation.lastOutputAt = Date.now();
      const text = data.toString();
      output += text;
      stdoutBuffer += text;

      // Split by newlines and emit each line for real-time streaming
      const lines = stdoutBuffer.split(/\r?\n/);
      // Keep the last incomplete line in the buffer
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          emitRawSteamCmdLine(io, "install:log", "stdout", line);
          log.info(`SteamCMD: ${line}`);
        }
      }
    });

    steamcmd.stderr.on("data", (data) => {
      const operation = activeSteamOperations.get(normalizedPath);
      if (operation) operation.lastOutputAt = Date.now();
      const text = data.toString();
      output += text;
      stderrBuffer += text;

      // Split by newlines and emit each line for real-time streaming
      const lines = stderrBuffer.split(/\r?\n/);
      // Keep the last incomplete line in the buffer
      stderrBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          emitRawSteamCmdLine(io, "install:log", "stderr", line);
          log.warn(`SteamCMD stderr: ${line}`);
        }
      }
    });

    steamcmd.on("close", async (code) => {
      // Flush any remaining buffered output
      if (stdoutBuffer.trim()) {
        emitRawSteamCmdLine(io, "install:log", "stdout", stdoutBuffer.trim());
        log.info(`SteamCMD: ${stdoutBuffer.trim()}`);
      }
      if (stderrBuffer.trim()) {
        emitRawSteamCmdLine(io, "install:log", "stderr", stderrBuffer.trim());
        log.warn(`SteamCMD stderr: ${stderrBuffer.trim()}`);
      }

      if (code === 0) {
        log.info("PZ server installation completed successfully");

        // The game files installed -- that part is done and expensive to
        // redo, so success:false is never used for a failure past this
        // point (2026-08-26 install-failure hunt finding #6). A step below
        // that fails but self-heals on the next POST /server/start (the INI
        // pre-create, the startup script) is instead collected here and
        // sent as a `warnings` array alongside success:true, so the
        // operator sees it without being told to reinstall over it.
        const warnings = [];

        // Auto-update settings with new paths. Wrapped: these were bare
        // awaits with nothing catching a throw, and this app's
        // unhandledRejection handler (server/index.js) kills the whole
        // panel process on an uncaught rejection -- so a transient
        // settings-write failure here used to take the panel down mid-
        // install instead of just leaving a setting unsaved. The game
        // files already installed successfully at this point, so this
        // follows the same warnings-array convention as the other
        // self-healing failures below rather than reporting success:false.
        try {
          await setSetting("serverPath", installPath);
          await setSetting("serverName", serverName);
          await setSetting("minMemory", minMemory);
          await setSetting("maxMemory", maxMemory);
          await setSetting("serverPort", serverPort);
          await setSetting("useUpnp", useUpnp);

          if (zomboidDataPath) {
            await setSetting("zomboidDataPath", zomboidDataPath);
          } else {
            await setSetting("zomboidDataPath", zomboidPath);
            io.emit("install:log", {
              type: "stdout",
              text: `Using ${usesEnvironmentDataPath ? "configured" : "isolated"} data folder: ${zomboidPath}`,
              progressCode: usesEnvironmentDataPath
                ? ProgressCode.DATA_FOLDER_USING_CONFIGURED
                : ProgressCode.DATA_FOLDER_USING_ISOLATED,
              params: { path: zomboidPath },
            });
          }

          await setSetting("serverConfigPath", serverConfigPath);
        } catch (settingsError) {
          log.error(`Failed to save install settings: ${settingsError.message}`);
          warnings.push({
            progressCode: ProgressCode.INSTALL_SETTINGS_SAVE_FAILED,
            message: `Server files installed, but some install settings could not be saved (${sanitizeError(settingsError.message)}). Re-check them under Settings once the panel is back up.`,
            params: { fields: "serverPath, serverName, memory, port, UPnP, data paths", reason: sanitizeError(settingsError.message) },
          });
        }

        // Re-check after the download in case a mounted path changed while
        // SteamCMD was running.
        try {
          ensureWritableDirectory(serverConfigPath);
        } catch (dirError) {
          // Keep the raw errno in the log even though the operator-facing
          // text below is friendlier -- someone debugging still needs it.
          log.error(
            `Data folder is not writable: ${zomboidPath} (${dirError.message})`,
          );
          // Reuses formatWritablePathError -- the SAME container-aware
          // guidance the pre-download check above already gives, instead of
          // this "re-check after the download" duplicate growing its own,
          // Linux-only message that never checked isContainer (found
          // 2026-08-29, "raw EACCES with no pointer to the fix" hunt: it
          // told a Docker operator to run a command inside the ephemeral
          // container that can't fix a host-side bind-mount ownership
          // mismatch at all). The concrete `sudo install -d` example is
          // still worth keeping for bare metal specifically -- more
          // actionable than the shared message's generic chown/chmod
          // pointer -- so it rides along as an extra param rather than
          // being lost.
          const writableError = formatWritablePathError("data", zomboidPath);
          const bareMetalCommand =
            writableError.code === ErrorCode.WRITABLE_PATH_DATA_BAREMETAL
              ? `sudo install -d -m 0755 -o "$(whoami)" -g "$(whoami)" "${zomboidPath}"`
              : null;
          io.emit("install:complete", {
            success: false,
            message: bareMetalCommand
              ? `${writableError.message} For example: ${bareMetalCommand}`
              : writableError.message,
            installPath,
            serverName,
            progressCode: writableError.code,
            params: {
              ...writableError.params,
              reason: dirError.code || dirError.message,
              ...(bareMetalCommand ? { command: bareMetalCommand } : {}),
            },
          });
          activeSteamOperations.delete(normalizedPath);
          return;
        }

        // Save RCON settings for later use. Same crash exposure and same
        // fix as the settings block above -- a bare await here previously
        // meant a failed RCON settings write could take the whole panel
        // down instead of just leaving RCON unconfigured.
        if (rconPassword) {
          try {
            await setSetting("rconPassword", rconPassword);
            await setSetting("rconPort", rconPort);
            await setSetting("rconHost", "127.0.0.1");
            io.emit("install:log", {
              type: "stdout",
              text: `RCON settings saved (port: ${rconPort})`,
              progressCode: ProgressCode.RCON_SETTINGS_SAVED,
              params: { port: rconPort },
            });
          } catch (rconSettingsError) {
            log.error(`Failed to save RCON settings: ${rconSettingsError.message}`);
            warnings.push({
              progressCode: ProgressCode.INSTALL_SETTINGS_SAVE_FAILED,
              message: `Server files installed, but the RCON password/port could not be saved (${sanitizeError(rconSettingsError.message)}). Re-check them under Settings once the panel is back up.`,
              params: { fields: "RCON password, port, host", reason: sanitizeError(rconSettingsError.message) },
            });
          }
        }

        // Pre-create the INI with RCON + UPnP settings so PZ reads them on
        // first boot (PZ reads the INI at startup -- if we wait until
        // after, they won't take effect). Previously this whole block only
        // ran `if (rconPassword)`, which meant a server installed without
        // an RCON password never got its UPnP choice written either, even
        // though the two have nothing to do with each other -- the
        // wizard's UPnP checkbox saved a global legacy setting nothing
        // ever read, and never touched this server's own .ini at all
        // (2026-08-26, same-night audit alongside the adminPassword fix:
        // "wire it, don't remove it"). Decoupled from rconPassword so a
        // server's UPnP choice reaches its .ini regardless.
        try {
          const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
          if (!fs.existsSync(iniPath)) {
            if (!fs.existsSync(serverConfigPath)) {
              fs.mkdirSync(serverConfigPath, { recursive: true });
            }
            const lines = [
              "# Auto-generated by Zomboid Control Panel",
              "# PZ will add remaining default settings on first server start",
              `UPnP=${useUpnp ? "true" : "false"}`,
            ];
            if (rconPassword) {
              const safeRconPw = sanitizeIniValue(rconPassword);
              lines.push(`RCONPort=${safeRconPort}`, `RCONPassword=${safeRconPw}`);
            }
            writeFileAtomic(iniPath, lines.join("\n") + "\n", {
              encoding: "utf-8",
              mode: 0o600,
            });
            log.info(
              `Pre-created INI at ${iniPath} (UPnP=${useUpnp}${rconPassword ? ", RCON configured" : ""})`,
            );
            io.emit("install:log", rconPassword
              ? {
                  type: "stdout",
                  text: "Pre-created server INI with RCON credentials",
                  progressCode: ProgressCode.INI_PRECREATED_WITH_RCON,
                }
              : {
                  type: "stdout",
                  text: "Pre-created server INI with UPnP setting",
                  progressCode: ProgressCode.INI_PRECREATED_WITH_UPNP,
                });
          }
        } catch (iniError) {
          log.warn(`Failed to pre-create INI: ${iniError.message}`);
          const permissionHint =
            iniError.code === "EACCES"
              ? ` ${formatWritablePathError("data", serverConfigPath).message}`
              : "";
          warnings.push({
            progressCode: ProgressCode.INSTALL_RCON_INI_PRECREATE_FAILED,
            message: `Could not pre-write ${rconPassword ? "the RCON password" : "the UPnP setting"} into the server config (${sanitizeError(iniError.message)}).${permissionHint} This is retried automatically the next time you start the server.`,
            params: { reason: sanitizeError(iniError.message) },
          });
        }

        // Generate custom startup scripts (both .bat and .sh)
        try {
          const scripts = generateStartupScripts({
            installPath,
            serverName,
            minMemory: safeMinMemory,
            maxMemory: safeMaxMemory,
            zomboidDataPath: zomboidPath,
            adminPassword: safeAdminPassword,
            serverPort: safeServerPort,
            useNoSteam,
            useDebug,
          });

          const batchPath = path.join(
            installPath,
            `StartServer_${serverName}.bat`,
          );
          writeFileAtomic(batchPath, scripts.bat, "utf8");
          log.info(`Created custom startup batch: ${batchPath}`);

          const shellPath = path.join(
            installPath,
            `start-server_${serverName}.sh`,
          );
          writeFileAtomic(shellPath, scripts.sh.replace(/\r\n/g, "\n"), {
            encoding: "utf8",
            mode: 0o750,
          });
          log.info(`Created custom startup script: ${shellPath}`);

          const scriptName =
            process.platform === "win32"
              ? `StartServer_${serverName}.bat`
              : `start-server_${serverName}.sh`;
          io.emit("install:log", {
            type: "stdout",
            text: `Created custom startup script: ${scriptName}`,
            progressCode: ProgressCode.STARTUP_SCRIPT_CREATED,
            params: { scriptName },
          });
        } catch (batchError) {
          log.warn(`Failed to create startup scripts: ${batchError.message}`);
          warnings.push({
            progressCode: ProgressCode.INSTALL_STARTUP_SCRIPT_FAILED,
            message: `Could not generate this server's custom startup script (${sanitizeError(batchError.message)}). The server can still be started -- it will use the default script until this regenerates, which also happens automatically on the next start.`,
            params: { reason: sanitizeError(batchError.message) },
          });
        }

        logServerEvent(
          "server_install",
          `Installed PZ server to ${installPath} (${selectedBranch} branch)`,
        );

        // 2026-08-26 bug hunt: exit code 0 was trusted as sufficient proof
        // the game files were actually installed -- SteamCMD can exit 0
        // after a rate-limited, interrupted, or otherwise incomplete
        // download. The self-install-steamcmd-itself step above already
        // does an existsSync check on its own output for exactly this
        // reason; this carries that same habit to the install that
        // actually matters. Same PZ_INSTALL_MARKERS list DELETE
        // /delete-files uses to confirm a folder is a real PZ install --
        // one marker present is enough to call this usable, not a deep
        // validation.
        if (!hasPzInstallMarker(installPath)) {
          log.warn(
            `SteamCMD exited 0 but no recognizable PZ server files were found at ${installPath}`,
          );
          warnings.push({
            progressCode: ProgressCode.INSTALL_MISSING_GAME_FILES,
            message:
              "SteamCMD reported success, but no recognizable game files were found at the install path. Check the SteamCMD log above for a hidden error (a rate limit or an interrupted download can still exit 0), and verify the install path before starting this server.",
          });
        }

        // Auto-install PanelBridge mod to the server
        try {
          const possibleModPaths = [
            path.join(process.cwd(), "pz-mod", "PanelBridge"),
            path.join(path.dirname(process.execPath), "pz-mod", "PanelBridge"),
          ];

          let modSourcePath = null;
          for (const p of possibleModPaths) {
            if (fs.existsSync(p)) {
              modSourcePath = p;
              break;
            }
          }

          if (modSourcePath) {
            const sourceLuaFile = path.join(
              modSourcePath,
              "media",
              "lua",
              "server",
              "PanelBridge.lua",
            );
            const destLuaDir = path.join(installPath, "media", "lua", "server");
            const destLuaFile = path.join(destLuaDir, "PanelBridge.lua");

            if (fs.existsSync(sourceLuaFile)) {
              if (!fs.existsSync(destLuaDir)) {
                fs.mkdirSync(destLuaDir, { recursive: true });
              }
              fs.copyFileSync(sourceLuaFile, destLuaFile);
              io.emit("install:log", {
                type: "stdout",
                text: "PanelBridge mod installed automatically",
                progressCode: ProgressCode.PANELBRIDGE_AUTO_INSTALLED,
              });
              log.info("PanelBridge mod auto-installed to server");
            }
          }
        } catch (modError) {
          log.warn(
            `Failed to auto-install PanelBridge mod: ${modError.message}`,
          );
        }

        io.emit("install:complete", {
          success: true,
          message: "Server installed successfully",
          installPath,
          serverName,
          zomboidDataPath: zomboidPath, // Send back the computed data path
          serverConfigPath,
          branch: selectedBranch,
          rconPort: safeRconPort,
          hasRconPassword: !!rconPassword,
          serverPort: safeServerPort,
          minMemory: safeMinMemory,
          maxMemory: safeMaxMemory,
          progressCode: ProgressCode.INSTALL_COMPLETE_SUCCESS,
          warnings,
        });
      } else if (killedByWatchdog) {
        const idleMinutes = STEAM_OPERATION_IDLE_TIMEOUT_MS / 60000;
        log.error(
          `SteamCMD produced no output for ${idleMinutes} minutes and was stopped`,
        );
        io.emit("install:complete", {
          success: false,
          message: `Installation was stopped after ${idleMinutes} minutes with no output from SteamCMD -- it may have stalled or lost its connection. Try again.`,
          output,
          progressCode: ProgressCode.INSTALL_WATCHDOG_KILLED,
          params: { minutes: idleMinutes },
        });
      } else {
        log.error(`SteamCMD exited with code ${code}`);
        io.emit("install:complete", {
          success: false,
          message: `Installation failed with exit code ${code}`,
          output,
          progressCode: ProgressCode.INSTALL_FAILED_EXIT_CODE,
          params: { code },
        });
      }

      // Clear active operation
      clearActiveSteamOperation(normalizedPath);
    });

    steamcmd.on("error", (error) => {
      // Clear active operation on error
      clearActiveSteamOperation(normalizedPath);

      log.error(`SteamCMD error: ${error.message}`);
      io.emit("install:complete", {
        success: false,
        message: `Failed to run SteamCMD: ${sanitizeError(error.message)}`,
        progressCode: ProgressCode.STEAMCMD_RUN_FAILED,
        params: { reason: sanitizeError(error.message) },
      });
    });

    // Return immediately - progress is sent via Socket.IO
    res.json({
      success: true,
      message: "Installation started. Check the log for progress.",
      installPath,
      branch: selectedBranch,
    });
  } catch (error) {
    if (activeOperationPath) {
      activeSteamOperations.delete(activeOperationPath);
    }
    log.error(`Installation error: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Quick Setup - Create new server config using existing files (no SteamCMD download)
router.post("/quick-setup", requirePermission("server.install"), async (req, res) => {
  try {
    const {
      installPath,
      serverName,
      zomboidDataPath,
      minMemory = 4,
      maxMemory = 8,
      adminPassword,
      serverPort = 16261,
      useUpnp = true,
      useNoSteam = false,
      useDebug = false,
      rconPassword,
      rconPort = 27015,
    } = req.body;

    // Validate inputs
    if (!installPath || !serverName) {
      return res
        .status(400)
        .json({ error: "Missing required fields: installPath, serverName", code: ErrorCode.QUICK_SETUP_MISSING_FIELDS });
    }

    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: "Invalid install path", code: ErrorCode.INSTALL_PATH_INVALID });
    }

    if (!isValidServerName(serverName)) {
      return res.status(400).json({
        error:
          "Invalid server name. Use only letters, numbers, underscores, hyphens, and spaces (max 64 chars)",
        code: ErrorCode.SERVER_NAME_FORMAT_INVALID,
      });
    }

    if (zomboidDataPath && !isValidPath(zomboidDataPath)) {
      return res.status(400).json({ error: "Invalid Zomboid data path", code: ErrorCode.ZOMBOID_DATA_PATH_INVALID });
    }

    const { zomboidPath, serverConfigPath, usesEnvironmentDataPath } =
      resolveZomboidPaths(installPath, zomboidDataPath);

    // Check if server files exist
    const startServerBat = path.join(installPath, "StartServer64.bat");
    const startServerSh = path.join(installPath, "start-server.sh");
    const javaFolder = path.join(installPath, "jre64");

    if (
      !fs.existsSync(startServerBat) &&
      !fs.existsSync(startServerSh) &&
      !fs.existsSync(javaFolder)
    ) {
      return res.status(400).json({
        error:
          "Server files not found. Make sure the path contains Project Zomboid dedicated server files.",
        code: ErrorCode.QUICK_SETUP_SERVER_FILES_NOT_FOUND,
      });
    }

    try {
      ensureWritableDirectory(installPath);
    } catch (directoryError) {
      const writableError = formatWritablePathError("install", installPath);
      return res.status(400).json({
        error: writableError.message,
        code: writableError.code,
        params: writableError.params,
      });
    }

    try {
      ensureWritableDirectory(serverConfigPath);
    } catch (directoryError) {
      const writableError = formatWritablePathError("data", zomboidPath);
      return res.status(400).json({
        error: writableError.message,
        code: writableError.code,
        params: writableError.params,
      });
    }

    // Validate numeric inputs -- same refuse-don't-coerce reasoning as
    // /install above. See 2026-08-23 validateInt-coerces audit.
    const minMemoryCheck = requireIntInRange(minMemory, MEMORY_GB_MIN, MIN_MEMORY_GB_MAX, "Minimum memory (GB)");
    if (!minMemoryCheck.ok) {
      return res.status(400).json({ error: minMemoryCheck.message, code: ErrorCode.INVALID_MIN_MEMORY });
    }
    const maxMemoryCheck = requireIntInRange(maxMemory, MEMORY_GB_MIN, MAX_MEMORY_GB_MAX, "Maximum memory (GB)");
    if (!maxMemoryCheck.ok) {
      return res.status(400).json({ error: maxMemoryCheck.message, code: ErrorCode.INVALID_MAX_MEMORY });
    }
    const serverPortCheck = requireIntInRange(serverPort, BIND_PORT_MIN, GAME_PORT_MAX, "Game port");
    if (!serverPortCheck.ok) {
      return res.status(400).json({ error: serverPortCheck.message, code: ErrorCode.INVALID_SERVER_PORT });
    }
    const rconPortCheck = requireIntInRange(rconPort, BIND_PORT_MIN, BIND_PORT_MAX, "RCON port");
    if (!rconPortCheck.ok) {
      return res.status(400).json({ error: rconPortCheck.message, code: ErrorCode.INVALID_RCON_PORT });
    }
    const safeMinMemory = minMemoryCheck.value;
    const safeMaxMemory = maxMemoryCheck.value;
    const safeServerPort = serverPortCheck.value;
    const safeRconPort = rconPortCheck.value;
    const safeAdminPassword = sanitizeForBatch(adminPassword);

    log.info(
      `Quick setup: Creating server config for ${serverName} using files from ${installPath}`,
    );

    // Same reasoning as /install above (2026-08-26 install-failure hunt
    // finding #6): the server files already exist (checked above), so a
    // failure past this point that self-heals on the next POST
    // /server/start (the INI pre-create) is reported as a warning, not a
    // flat failure that would send the operator looking for a problem in
    // files that are actually fine.
    const warnings = [];

    // Update settings
    await setSetting("serverPath", installPath);
    await setSetting("serverName", serverName);
    await setSetting("minMemory", safeMinMemory);
    await setSetting("maxMemory", safeMaxMemory);
    await setSetting("serverPort", safeServerPort);
    await setSetting("useUpnp", useUpnp);

    if (zomboidDataPath) {
      await setSetting("zomboidDataPath", zomboidDataPath);
    } else {
      await setSetting("zomboidDataPath", zomboidPath);
      log.info(
        `Using ${usesEnvironmentDataPath ? "configured" : "isolated"} data folder: ${zomboidPath}`,
      );
    }

    await setSetting("serverConfigPath", serverConfigPath);

    // Re-check immediately before creating configuration files in case the
    // selected mount changed during setup.
    try {
      ensureWritableDirectory(serverConfigPath);
    } catch (dirError) {
      // Keep the raw errno in the log even though the operator-facing text
      // below is friendlier -- someone debugging still needs it. See the
      // /install route's identical fix above for why this reuses
      // formatWritablePathError instead of the Linux-only, non-container-
      // aware message this used to hand-roll.
      log.error(
        `Data folder is not writable: ${zomboidPath} (${dirError.message})`,
      );
      const writableError = formatWritablePathError("data", zomboidPath);
      const bareMetalCommand =
        writableError.code === ErrorCode.WRITABLE_PATH_DATA_BAREMETAL
          ? `sudo install -d -m 0755 -o "$(whoami)" -g "$(whoami)" "${zomboidPath}"`
          : null;
      throw new Error(
        bareMetalCommand
          ? `${writableError.message} For example: ${bareMetalCommand}`
          : writableError.message,
      );
    }

    // Save RCON settings
    if (rconPassword) {
      await setSetting("rconPassword", rconPassword);
      await setSetting("rconPort", safeRconPort);
      await setSetting("rconHost", "127.0.0.1");

      // Pre-create INI with RCON settings so PZ reads them on first boot
      try {
        const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
        if (!fs.existsSync(iniPath)) {
          if (!fs.existsSync(serverConfigPath)) {
            fs.mkdirSync(serverConfigPath, { recursive: true });
          }
          const safeRconPw = sanitizeIniValue(rconPassword);
          const minimalIni = `# Auto-generated by Zomboid Control Panel\n# PZ will add remaining default settings on first server start\nRCONPort=${safeRconPort}\nRCONPassword=${safeRconPw}\n`;
          writeFileAtomic(iniPath, minimalIni, {
            encoding: "utf-8",
            mode: 0o600,
          });
          log.info(`Pre-created INI with RCON settings at ${iniPath}`);
        }
      } catch (iniError) {
        log.warn(`Failed to pre-create INI: ${iniError.message}`);
        const permissionHint =
          iniError.code === "EACCES"
            ? ` ${formatWritablePathError("data", serverConfigPath).message}`
            : "";
        warnings.push({
          progressCode: ProgressCode.INSTALL_RCON_INI_PRECREATE_FAILED,
          message: `Could not pre-write the RCON password into the server config (${sanitizeError(iniError.message)}).${permissionHint} This is retried automatically the next time you start the server.`,
          params: { reason: sanitizeError(iniError.message) },
        });
      }
    }

    // Generate custom startup scripts
    const scripts = generateStartupScripts({
      installPath,
      serverName,
      minMemory: safeMinMemory,
      maxMemory: safeMaxMemory,
      zomboidDataPath: zomboidPath,
      adminPassword: safeAdminPassword,
      serverPort: safeServerPort,
      useNoSteam,
      useDebug,
    });

    const batchPath = path.join(installPath, `StartServer_${serverName}.bat`);
    writeFileAtomic(batchPath, scripts.bat, "utf8");
    log.info(`Created custom startup batch: ${batchPath}`);

    const shellPath = path.join(installPath, `start-server_${serverName}.sh`);
    writeFileAtomic(shellPath, scripts.sh.replace(/\r\n/g, "\n"), {
      encoding: "utf8",
      mode: 0o750,
    });
    log.info(`Created custom startup script: ${shellPath}`);

    const startupScript =
      process.platform === "win32"
        ? `StartServer_${serverName}.bat`
        : `start-server_${serverName}.sh`;

    // Auto-install PanelBridge mod to the server
    let panelBridgeInstalled = false;
    try {
      const possibleModPaths = [
        path.join(process.cwd(), "pz-mod", "PanelBridge"),
        path.join(path.dirname(process.execPath), "pz-mod", "PanelBridge"),
      ];

      let modSourcePath = null;
      for (const p of possibleModPaths) {
        if (fs.existsSync(p)) {
          modSourcePath = p;
          break;
        }
      }

      if (modSourcePath) {
        const sourceLuaFile = path.join(
          modSourcePath,
          "media",
          "lua",
          "server",
          "PanelBridge.lua",
        );
        const destLuaDir = path.join(installPath, "media", "lua", "server");
        const destLuaFile = path.join(destLuaDir, "PanelBridge.lua");

        if (fs.existsSync(sourceLuaFile)) {
          if (!fs.existsSync(destLuaDir)) {
            fs.mkdirSync(destLuaDir, { recursive: true });
          }
          fs.copyFileSync(sourceLuaFile, destLuaFile);
          panelBridgeInstalled = true;
          log.info("PanelBridge mod auto-installed to server");
        }
      }
    } catch (modError) {
      log.warn(`Failed to auto-install PanelBridge mod: ${modError.message}`);
    }

    await logServerEventBestEffort(
      "server_quick_setup",
      `Created server config for ${serverName} using existing files at ${installPath}`,
    );

    res.json({
      success: true,
      message: "Server configuration created successfully",
      installPath,
      serverName,
      zomboidDataPath: zomboidPath, // Send back the computed data path
      serverConfigPath,
      batchFile: startupScript,
      rconPort: safeRconPort,
      hasRconPassword: !!rconPassword,
      serverPort: safeServerPort,
      minMemory: safeMinMemory,
      maxMemory: safeMaxMemory,
      panelBridgeInstalled,
      warnings,
    });
  } catch (error) {
    log.error(`Quick setup error: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Configure RCON in server's .ini file
router.post("/configure-rcon", requirePermission("server.configure"), async (req, res) => {
  try {
    const { rconPassword, rconPort: rawRconPort = 27015 } = req.body || {};
    // Refused, not coerced: see 2026-08-23 validateInt-coerces audit.
    const rconPortCheck = requireIntInRange(rawRconPort, BIND_PORT_MIN, BIND_PORT_MAX, "RCON port");
    if (!rconPortCheck.ok) {
      return res.status(400).json({ error: rconPortCheck.message, code: ErrorCode.INVALID_RCON_PORT });
    }
    const rconPort = rconPortCheck.value;

    if (!rconPassword) {
      return res.status(400).json({ error: "RCON password is required", code: ErrorCode.CONFIGURE_RCON_PASSWORD_REQUIRED });
    }

    // Get the server config path from active server or settings
    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json({
        error: "Server config path not set. Please run installation first.",
        code: ErrorCode.SERVER_CONFIG_PATH_NOT_SET,
      });
    }

    const iniPath = path.join(serverConfigPath, `${serverName}.ini`);

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: `Server config not found at ${iniPath}. Start the server once first to generate the config file.`,
        code: ErrorCode.SERVER_CONFIG_FILE_NOT_FOUND,
      });
    }

    // Read and update the ini file. Locked per-path so this can't interleave
    // with ensureRconConfigured() or another config-save racing the same file.
    await withFileLock(iniPath, async () => {
      let content = fs.readFileSync(iniPath, "utf-8").replace(/\r\n/g, "\n");

      // Update RCONPassword (sanitize to prevent INI injection via newlines)
      const safePassword = sanitizeIniValue(rconPassword);
      content = setIniKeyLine(content, "RCONPassword", safePassword);
      content = setIniKeyLine(content, "RCONPort", rconPort);

      writeFileAtomic(iniPath, content, { encoding: "utf-8", mode: 0o600 });
    });

    // Also save to app settings
    await setSetting("rconPassword", rconPassword);
    await setSetting("rconPort", rconPort);
    await setSetting("rconHost", "127.0.0.1");

    log.info(`RCON configured in ${iniPath}`);
    res.json({
      success: true,
      message: `RCON configured successfully. Restart the server for changes to take effect.`,
      iniPath,
    });
  } catch (error) {
    log.error(`Failed to configure RCON: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Configure server network settings (port, UPnP) in .ini file
// Writes just the UPnP= line into an existing server .ini. Extracted from
// /configure-network's own UPnP handling (below) so PUT /:id (server edit,
// servers.js) can reuse it instead of duplicating the read/replace/write
// logic -- deliberately narrow: does NOT touch DefaultPort/UDPPort, which
// stay /configure-network's own concern, so calling this from a second
// site never triggers a port change as a side effect. Returns
// {applied:false, reason} rather than throwing when the ini doesn't exist
// yet (a server that has never booted has no ini to edit) -- the caller
// decides whether that's worth surfacing to the operator.
export async function applyUpnpToIni(serverConfigPath, serverName, useUpnp) {
  const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
  if (!fs.existsSync(iniPath)) {
    return { applied: false, reason: `Server config not found at ${iniPath}` };
  }
  try {
    await withFileLock(iniPath, async () => {
      let content = fs.readFileSync(iniPath, "utf-8").replace(/\r\n/g, "\n");
      const upnpValue = useUpnp ? "true" : "false";
      content = setIniKeyLine(content, "UPnP", upnpValue);
      writeFileAtomic(iniPath, content, { encoding: "utf-8", mode: 0o600 });
    });
    return { applied: true };
  } catch (error) {
    return { applied: false, reason: sanitizeError(error.message) };
  }
}

router.post("/configure-network", requirePermission("server.configure"), async (req, res) => {
  try {
    const { serverPort: rawServerPort = 16261, useUpnp = true } = req.body || {};
    // Refused, not coerced: see 2026-08-23 validateInt-coerces audit.
    const serverPortCheck = requireIntInRange(rawServerPort, BIND_PORT_MIN, GAME_PORT_MAX, "Game port");
    if (!serverPortCheck.ok) {
      return res.status(400).json({ error: serverPortCheck.message, code: ErrorCode.INVALID_SERVER_PORT });
    }
    const serverPort = serverPortCheck.value;
    if (typeof useUpnp !== "boolean") {
      return res.status(400).json({
        error: "useUpnp must be a boolean",
      });
    }

    // Get the server config path from active server or settings
    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json({
        error: "Server config path not set. Please run installation first.",
        code: ErrorCode.SERVER_CONFIG_PATH_NOT_SET,
      });
    }

    const iniPath = path.join(serverConfigPath, `${serverName}.ini`);

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: `Server config not found at ${iniPath}. Start the server once first to generate the config file.`,
        code: ErrorCode.SERVER_CONFIG_FILE_NOT_FOUND,
      });
    }

    // Read and update the ini file. Locked per-path for the same reason as
    // the RCON-config endpoint above.
    await withFileLock(iniPath, async () => {
      let content = fs.readFileSync(iniPath, "utf-8").replace(/\r\n/g, "\n");

      // Update DefaultPort, then UDPPort (DefaultPort + 1)
      content = setIniKeyLine(content, "DefaultPort", serverPort);
      content = setIniKeyLine(content, "UDPPort", serverPort + 1);

      writeFileAtomic(iniPath, content, { encoding: "utf-8", mode: 0o600 });
    });

    // UPnP itself is applyUpnpToIni()'s own concern now -- shared with
    // PUT /:id (servers.js) so a server's UPnP choice takes effect there
    // too, not only when re-saved through this page. withFileLock's
    // per-path promise queue (fileWriteQueue.js) serializes this against
    // the port write above; both still land, just as two writes instead of
    // one, and never interleaved.
    await applyUpnpToIni(serverConfigPath, serverName, useUpnp);

    // Also save to app settings
    await setSetting("serverPort", serverPort);
    await setSetting("useUpnp", useUpnp);

    log.info(
      `Network settings configured in ${iniPath}: port=${serverPort}, UPnP=${useUpnp ? "true" : "false"}`,
    );
    res.json({
      success: true,
      message: `Network settings configured successfully. Restart the server for changes to take effect.`,
      iniPath,
      settings: {
        defaultPort: serverPort,
        udpPort: serverPort + 1,
        upnp: useUpnp,
      },
    });
  } catch (error) {
    log.error(`Failed to configure network settings: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Alarm - sound building alarm
router.post("/alarm", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.alarm();
    await logServerEventBestEffort("alarm");
    res.json(result);
  } catch (error) {
    log.error(`Failed to trigger alarm: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Remove zombies
router.post("/removezombies", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.removeZombies();
    await logServerEventBestEffort("removezombies");
    res.json(result);
  } catch (error) {
    log.error(`Failed to remove zombies: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Reload Lua script
router.post("/reloadlua", requirePermission("server.configure"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { filename } = req.body || {};

    if (!filename) {
      return res.status(400).json({ error: "Filename is required", code: ErrorCode.RELOAD_LUA_FILENAME_REQUIRED });
    }

    // Validate filename - allow alphanumeric, underscores, dots, and forward slashes only
    // Block backslashes and '..' to prevent path traversal
    if (!/^[a-zA-Z0-9_/.\-]+\.lua$/.test(filename) || filename.includes("..")) {
      return res.status(400).json({ error: "Invalid filename format", code: ErrorCode.RELOAD_LUA_INVALID_FILENAME });
    }

    const result = await rconService.reloadLua(filename);
    await logServerEventBestEffort("reloadlua", filename);
    res.json(result);
  } catch (error) {
    log.error(`Failed to reload Lua: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set log level
router.post("/log", requirePermission("server.configure"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { type, level } = req.body || {};

    if (!type || !level) {
      return res.status(400).json({ error: "Type and level are required", code: ErrorCode.LOG_TYPE_LEVEL_REQUIRED });
    }

    const validTypes = [
      "General",
      "Network",
      "Multiplayer",
      "Voice",
      "Packet",
      "NetworkFileDebug",
      "Lua",
      "Mod",
      "Sound",
      "Zombie",
      "Combat",
      "Objects",
      "Fireplace",
      "Radio",
      "MapLoading",
      "Clothing",
      "Animation",
      "Asset",
      "Script",
      "Shader",
      "Input",
      "Recipe",
      "ActionSystem",
      "IsoRegion",
      "UniTests",
      "FileIO",
      "Ownership",
      "Death",
      "Damage",
      "Statistic",
      "Vehicle",
      "Checksum",
    ];

    const validLevels = ["Trace", "Debug", "General", "Warning", "Error"];

    if (!validTypes.includes(type)) {
      return res
        .status(400)
        .json({ error: `Invalid log type. Valid: ${validTypes.join(", ")}`, code: ErrorCode.LOG_INVALID_TYPE });
    }

    if (!validLevels.includes(level)) {
      return res
        .status(400)
        .json({ error: `Invalid log level. Valid: ${validLevels.join(", ")}`, code: ErrorCode.LOG_INVALID_LEVEL });
    }

    const result = await rconService.setLogLevel(type, level);
    res.json(result);
  } catch (error) {
    log.error(`Failed to set log level: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Server statistics
router.post("/stats", requirePermission("server.configure"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { mode, period } = req.body || {};

    if (!mode) {
      return res.status(400).json({ error: "Mode is required", code: ErrorCode.STATS_MODE_REQUIRED });
    }

    const validModes = ["none", "file", "console", "all"];
    if (!validModes.includes(mode.toLowerCase())) {
      return res
        .status(400)
        .json({ error: `Invalid mode. Valid: ${validModes.join(", ")}`, code: ErrorCode.STATS_INVALID_MODE });
    }

    // Coerced, not refused: no client caller sets this today (unused API
    // surface), and an out-of-range value already falls back to `null`
    // (stats reporting off) rather than a plausible-looking wrong number --
    // see 2026-08-23 validateInt-coerces audit.
    const validPeriod = period ? coerceIntInRange(period, 1, 3600, null) : null;

    const result = await rconService.setStats(mode, validPeriod);
    res.json(result);
  } catch (error) {
    log.error(`Failed to set stats: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Release safehouse
router.post("/releasesafehouse", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.releaseSafehouse();
    res.json(result);
  } catch (error) {
    log.error(`Failed to release safehouse: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Update server using SteamCMD
router.post("/steam-update", requirePermission("server.install"), async (req, res) => {
  let activeOperationPath = null;
  try {
    let {
      steamcmdPath,
      installPath,
      branch,
      useUnstable = false,
      validateFiles = false,
    } = req.body;

    // Determine branch - support both new 'branch' param and legacy 'useUnstable'
    const selectedBranch = branch || (useUnstable ? "unstable" : "stable");

    // Auto-load steamcmdPath from settings if not provided
    if (!steamcmdPath) {
      steamcmdPath = await getSetting("steamcmdPath");
    }

    if (!steamcmdPath || !installPath) {
      return res
        .status(400)
        .json({ error: "Missing required fields: steamcmdPath, installPath", code: ErrorCode.STEAM_UPDATE_MISSING_FIELDS });
    }

    if (!isValidPath(steamcmdPath)) {
      return res.status(400).json({ error: "Invalid SteamCMD path", code: ErrorCode.STEAMCMD_PATH_INVALID });
    }

    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: "Invalid install path", code: ErrorCode.INSTALL_PATH_INVALID });
    }

    // Check if server is running - cannot update while running. Fail closed:
    // this used to swallow a failed detection scan and continue as if the
    // server were stopped ("user may be updating a different server"), but
    // checkServerRunning() throwing (or resolving scanFailed) means we
    // genuinely don't know the process state — and running SteamCMD
    // `validate` against a live install's files is exactly what this check
    // exists to prevent. Same doctrine as configMutationGuard.js's
    // SERVER_STATE_UNKNOWN response.
    const serverManager = req.app.get("serverManager");
    try {
      const processDetails = await serverManager.getServerProcessDetails();
      if (processDetails.scanFailed) {
        return res.status(503).json({
          error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
          code: ErrorCode.SERVER_STATE_UNKNOWN,
        });
      }
      if (processDetails.running) {
        return res.status(400).json({
          error:
            "Server is currently running. Please stop the server before updating.",
          code: ErrorCode.STEAM_UPDATE_SERVER_RUNNING,
        });
      }
    } catch (e) {
      log.warn(`Could not verify server status before update: ${e.message}`);
      return res.status(503).json({
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      });
    }

    // Auto-download SteamCMD on Linux instead of hard-failing — see
    // ensureSteamCmdLinux.
    // Persist steamcmdPath as the configured setting before resolving an
    // executable from it -- see saveAndResolveSteamCmdExe's header comment
    // (CodeQL js/command-line-injection #13).
    let steamcmdExe = await saveAndResolveSteamCmdExe(steamcmdPath);
    if (!steamcmdExe || !fs.existsSync(steamcmdExe)) {
      if (isWindows) {
        return res
          .status(400)
          .json({ error: `SteamCMD not found at: ${steamcmdExe}`, code: ErrorCode.STEAMCMD_NOT_FOUND_AT_PATH });
      }
      try {
        steamcmdExe = await ensureSteamCmdLinux(
          steamcmdPath,
          req.app.get("io"),
        );
      } catch (dlErr) {
        return res.status(500).json({
          error: `SteamCMD not found and auto-download failed: ${sanitizeError(dlErr.message)}`,
          code: ErrorCode.STEAMCMD_AUTO_DOWNLOAD_FAILED,
        });
      }
    }

    try {
      const recovery = recoverMismatchedSteamBranchManifest(
        installPath,
        selectedBranch,
      );
      if (recovery) {
        log.warn(
          `Reset stale SteamCMD branch manifest (${recovery.mountedBranch} -> ${recovery.targetBranch}); backup: ${recovery.backupPath}`,
        );
      }
    } catch (error) {
      log.warn(`Could not inspect SteamCMD branch manifest: ${error.message}`);
    }

    try {
      const recovery = recoverBlockedSteamManifest(installPath);
      if (recovery) {
        log.warn(
          `Reset SteamCMD manifest stuck in access-denied state 0x6; backup: ${recovery.backupPath}`,
        );
      }
    } catch (error) {
      log.warn(`Could not reset blocked SteamCMD manifest: ${error.message}`);
    }

    // Prevent concurrent operations on the same install path. Deliberately
    // placed HERE -- after every await above (saveAndResolveSteamCmdExe,
    // ensureSteamCmdLinux), not before them -- matching POST /install's
    // check/claim placement (which does it in this same order, right before
    // its own activeSteamOperations.set()). This check used to sit BEFORE
    // saveAndResolveSteamCmdExe's await, which meant two concurrent
    // steam-update requests for the same installPath could both pass this
    // check before either claimed the path, then both spawn SteamCMD
    // against it concurrently (manifest lock contention / interleaved
    // writes) -- proven via
    // server/tests/steamUpdateConcurrency.test.js. Nothing between this
    // check and the claim below is awaited, so there is no gap left for a
    // second request to slip through.
    const normalizedPath = path.normalize(installPath).toLowerCase();
    if (hasActiveSteamOperation(normalizedPath)) {
      return res.status(409).json({
        error:
          "A Steam operation is already in progress for this server. Please wait for it to complete.",
        code: ErrorCode.STEAM_OPERATION_IN_PROGRESS_SERVER,
      });
    }

    const operation = validateFiles ? "verification" : "update";
    log.info(`Starting PZ server ${operation} (branch: ${selectedBranch})...`);

    // Mark operation as active
    activeSteamOperations.set(normalizedPath, {
      type: operation,
      startTime: Date.now(),
      lastOutputAt: Date.now(),
      branch: selectedBranch,
    });
    activeOperationPath = normalizedPath;

    // Build SteamCMD command
    const betaArgs = getBetaArgs(selectedBranch);
    const loginArgs = await getSteamLoginArgs();
    const steamcmdArgs = [
      "+force_install_dir",
      installPath,
      ...loginArgs,
      "+app_update",
      "380870",
      ...betaArgs,
      "validate",
      "+quit",
    ];

    const io = req.app.get("io");

    // Emit start event
    io.emit("steam:start", {
      type: validateFiles ? "verify" : "update",
      message: validateFiles ? "Verifying game files..." : "Updating server...",
      progressCode: validateFiles
        ? ProgressCode.STEAM_START_VERIFY
        : ProgressCode.STEAM_START_UPDATE,
    });

    // On Linux, set LD_LIBRARY_PATH so SteamCMD can find its 32-bit libraries
    const updateSpawnOpts = { cwd: steamcmdPath };
    if (!isWindows) {
      const ldPaths = [
        path.join(steamcmdPath, "linux32"),
        path.join(steamcmdPath, "linux64"),
        steamcmdPath,
        process.env.LD_LIBRARY_PATH || "",
      ]
        .filter(Boolean)
        .join(":");
      updateSpawnOpts.env = { ...process.env, LD_LIBRARY_PATH: ldPaths };
    }
    const steamcmd = spawn(steamcmdExe, steamcmdArgs, updateSpawnOpts);
    activeSteamOperations.get(normalizedPath).pid = steamcmd.pid;
    activeSteamOperations.get(normalizedPath).watchdog = setInterval(() => {
      const activeOperation = activeSteamOperations.get(normalizedPath);
      if (!activeOperation) return;
      if (!isSteamOperationIdle(activeOperation)) return;

      log.error(
        `SteamCMD ${activeOperation.type} produced no output for ${STEAM_OPERATION_IDLE_TIMEOUT_MS / 60000} minutes; terminating the stalled process`,
      );
      steamcmd.kill();
    }, 30_000);
    activeSteamOperations.get(normalizedPath).watchdog.unref?.();

    let output = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";

    steamcmd.stdout.on("data", (data) => {
      const operation = activeSteamOperations.get(normalizedPath);
      if (operation) operation.lastOutputAt = Date.now();
      const text = data.toString();
      output += text;
      stdoutBuffer += text;

      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          emitRawSteamCmdLine(io, "steam:log", "stdout", line);
          log.info(`SteamCMD: ${line}`);
        }
      }
    });

    steamcmd.stderr.on("data", (data) => {
      const operation = activeSteamOperations.get(normalizedPath);
      if (operation) operation.lastOutputAt = Date.now();
      const text = data.toString();
      output += text;
      stderrBuffer += text;

      // Buffer stderr lines like stdout for consistent output
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          emitRawSteamCmdLine(io, "steam:log", "stderr", line);
          log.warn(`SteamCMD stderr: ${line}`);
        }
      }
    });

    steamcmd.on("close", (code) => {
      // Flush remaining buffers
      if (stdoutBuffer.trim()) {
        emitRawSteamCmdLine(io, "steam:log", "stdout", stdoutBuffer.trim());
      }
      if (stderrBuffer.trim()) {
        emitRawSteamCmdLine(io, "steam:log", "stderr", stderrBuffer.trim());
      }

      // Clear active operation
      clearActiveSteamOperation(normalizedPath);

      const success = code === 0;
      const steamDepotAccessDenied =
        /app ['"]?380870['"]? state is 0x6/i.test(output) ||
        /manifest.*access denied/i.test(output);
      const failureMessage = steamDepotAccessDenied
        ? "SteamCMD could not access a Project Zomboid depot manifest. Your installed server files were not changed. Retry later; if it persists, update using a Steam account that owns Project Zomboid."
        : `Server ${operation} failed with code ${code}`;

      // "update" vs "verification" is a word choice, not a value -- own
      // codes per direction, not a shared template with `operation`
      // substituted in (see ProgressCode's file header, params-vs-variant
      // rule). steamDepotAccessDenied is independent of that distinction.
      let completeProgressCode;
      let completeParams;
      if (success) {
        completeProgressCode = validateFiles
          ? ProgressCode.STEAM_VERIFY_COMPLETE_SUCCESS
          : ProgressCode.STEAM_UPDATE_COMPLETE_SUCCESS;
      } else if (steamDepotAccessDenied) {
        completeProgressCode = ProgressCode.STEAM_DEPOT_ACCESS_DENIED;
      } else {
        completeProgressCode = validateFiles
          ? ProgressCode.STEAM_VERIFY_FAILED
          : ProgressCode.STEAM_UPDATE_FAILED;
        completeParams = { code };
      }

      io.emit("steam:complete", {
        success,
        message: success
          ? `Server ${operation} completed successfully`
          : failureMessage,
        progressCode: completeProgressCode,
        ...(completeParams ? { params: completeParams } : {}),
      });

      // After successful update, re-check update status so banner clears
      if (success) {
        try {
          const updateChecker = req.app.get("updateChecker");
          if (updateChecker) {
            setTimeout(() => updateChecker.checkForUpdates(true), 3000);
          }
        } catch (e) {
          // Non-critical
        }
      }

      logServerEvent(
        success ? "server_update" : "server_update_failed",
        `Server ${operation} ${success ? "completed" : "failed"}`,
      ).catch((e) => log.error("Failed to log server event:", e));

      log.info(`SteamCMD ${operation} finished with code ${code}`);
    });

    steamcmd.on("error", (error) => {
      // Clear active operation on error
      clearActiveSteamOperation(normalizedPath);

      io.emit("steam:complete", {
        success: false,
        message: `Failed to run SteamCMD: ${sanitizeError(error.message)}`,
        progressCode: ProgressCode.STEAMCMD_RUN_FAILED,
        params: { reason: sanitizeError(error.message) },
      });
      log.error(`SteamCMD error: ${error.message}`);
    });

    res.json({
      success: true,
      message: `Server ${operation} started`,
    });
  } catch (error) {
    if (activeOperationPath) {
      activeSteamOperations.delete(activeOperationPath);
    }
    log.error(`Steam update failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Auto-download and install SteamCMD
router.post("/steamcmd/download", requirePermission("server.install"), async (req, res) => {
  try {
    log.info(`POST /steamcmd/download (platform=${process.platform})`);
    const defaultPath = isWindows
      ? "C:\\SteamCMD"
      : [
          "/usr/games",
          "/usr/bin",
          path.join(os.homedir(), "steamcmd"),
          "/opt/steamcmd",
          "/usr/local/bin",
        ].find(
          (p) =>
            fs.existsSync(path.join(p, "steamcmd.sh")) ||
            fs.existsSync(path.join(p, "steamcmd")),
        ) || path.join(os.homedir(), "steamcmd");
    const { installPath = defaultPath } = req.body || {};

    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: "Invalid installation path", code: ErrorCode.STEAMCMD_DOWNLOAD_INVALID_PATH });
    }

    // This route's whole job is provisioning SteamCMD at installPath --
    // persist it as the configured steamcmdPath setting now, before
    // runFirstTimeSetup()'s spawn() resolves an executable from it below
    // (CodeQL js/command-line-injection #297; see
    // saveAndResolveSteamCmdExe's header comment). Also makes /install and
    // /steam-update find this location afterward without the operator
    // re-typing it.
    const configuredSteamcmdPath = await getSetting("steamcmdPath");
    if (configuredSteamcmdPath !== installPath) {
      await setSetting("steamcmdPath", installPath);
    }

    const io = req.app.get("io");

    // Create directory if it doesn't exist
    if (!fs.existsSync(installPath)) {
      fs.mkdirSync(installPath, { recursive: true });
    }

    if (isWindows) {
      // Windows: Download and extract zip
      const unzipper = await import("unzipper");
      const steamcmdUrl =
        "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip";
      const zipPath = path.join(installPath, "steamcmd.zip");

      io.emit("steamcmd:status", {
        status: "downloading",
        message: "Downloading SteamCMD...",
        progressCode: ProgressCode.STEAMCMD_DOWNLOADING,
      });
      log.info(`Downloading SteamCMD to ${installPath}`);

      const file = fs.createWriteStream(zipPath);

      const handleDownloadError = (err) => {
        file.close();
        fs.unlink(zipPath, () => {});
        io.emit("steamcmd:status", {
          status: "error",
          message: `Download failed: ${err.message}`,
          progressCode: ProgressCode.STEAMCMD_DOWNLOAD_FAILED,
          params: { reason: err.message },
        });
        log.error(`SteamCMD download failed: ${err.message}`);
      };

      const downloadAndExtract = (url) => {
        https
          .get(url, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
              downloadAndExtract(response.headers.location);
              return;
            }
            if (response.statusCode !== 200) {
              handleDownloadError(new Error(`HTTP ${response.statusCode}`));
              return;
            }
            response.pipe(file);
            file.on("close", async () => {
              // extractAndSetup() already fully guards itself and reports
              // its own failures via steamcmd:status -- this try/catch is
              // the CALLER'S OWN backstop, not a duplicate of that. An
              // EventEmitter listener whose returned promise nothing
              // awaits or .catches is exactly the shape that turns a
              // future change to extractAndSetup's internals into an
              // unhandledRejection -> fatalExit() panel kill (2026-08-26,
              // same class as the install setSetting crash). Latent, not
              // live: extractAndSetup cannot reject today.
              try {
                await extractAndSetup(zipPath);
              } catch (unexpectedError) {
                log.error(`SteamCMD self-setup failed unexpectedly: ${unexpectedError.message}`);
                io.emit("steamcmd:status", {
                  status: "error",
                  message: `SteamCMD setup failed unexpectedly: ${sanitizeError(unexpectedError.message)}`,
                  progressCode: ProgressCode.STEAMCMD_SELF_SETUP_UNEXPECTED_ERROR,
                  params: { reason: sanitizeError(unexpectedError.message) },
                });
              }
            });
          })
          .on("error", handleDownloadError);
      };

      downloadAndExtract(steamcmdUrl);

      async function extractAndSetup(zipFile) {
        try {
          io.emit("steamcmd:status", {
            status: "extracting",
            message: "Extracting SteamCMD...",
            progressCode: ProgressCode.STEAMCMD_EXTRACTING,
          });
          log.info("Extracting SteamCMD...");

          await fs
            .createReadStream(zipFile)
            .pipe(unzipper.default.Extract({ path: installPath }))
            .promise();

          fs.unlinkSync(zipFile);
          runFirstTimeSetup();
        } catch (extractError) {
          io.emit("steamcmd:status", {
            status: "error",
            message: `Extraction failed: ${sanitizeError(extractError.message)}`,
            progressCode: ProgressCode.STEAMCMD_EXTRACTION_FAILED,
            params: { reason: sanitizeError(extractError.message) },
          });
          log.error(`SteamCMD extraction failed: ${extractError.message}`);
        }
      }
    } else {
      // Linux: Download and extract tar.gz, then make executable
      const execCb = exec;
      const tarUrl =
        "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz";
      const tarPath = path.join(installPath, "steamcmd_linux.tar.gz");

      io.emit("steamcmd:status", {
        status: "downloading",
        message: "Downloading SteamCMD for Linux...",
        progressCode: ProgressCode.STEAMCMD_DOWNLOADING_LINUX,
      });
      log.info(`Downloading SteamCMD (Linux) to ${installPath}`);

      // Try curl first, fall back to wget (CentOS minimal may lack curl)
      const safeTarPath = tarPath.replace(/'/g, "'\\''");
      const safeTarUrl = tarUrl.replace(/'/g, "'\\''");
      const curlCmd = `curl -sSL -o '${safeTarPath}' '${safeTarUrl}'`;
      const wgetCmd = `wget -q -O '${safeTarPath}' '${safeTarUrl}'`;

      const tryDownload = (cmd, fallbackCmd) => {
        execCb(cmd, { timeout: 120000 }, (dlErr) => {
          if (dlErr && fallbackCmd) {
            log.warn(
              `Download with ${cmd.split(" ")[0]} failed, trying fallback...`,
            );
            tryDownload(fallbackCmd, null);
            return;
          }
          if (dlErr) {
            io.emit("steamcmd:status", {
              status: "error",
              message: `Download failed: ${dlErr.message}. Ensure curl or wget is installed.`,
              progressCode: ProgressCode.STEAMCMD_DOWNLOAD_FAILED_LINUX,
              params: { reason: dlErr.message },
            });
            log.error(`SteamCMD download failed: ${dlErr.message}`);
            return;
          }
          afterDownload();
        });
      };

      tryDownload(curlCmd, wgetCmd);

      function afterDownload() {
        io.emit("steamcmd:status", {
          status: "extracting",
          message: "Extracting SteamCMD...",
          progressCode: ProgressCode.STEAMCMD_EXTRACTING,
        });
        log.info("Extracting SteamCMD...");

        const safeInstallPath = installPath.replace(/'/g, "'\\''");
        execCb(
          `tar -xzf '${safeTarPath}' -C '${safeInstallPath}'`,
          { timeout: 30000 },
          (tarErr) => {
            // Clean up tar file regardless
            try {
              fs.unlinkSync(tarPath);
            } catch (e) {
              /* ignore */
            }

            if (tarErr) {
              io.emit("steamcmd:status", {
                status: "error",
                message: `Extraction failed: ${tarErr.message}`,
                progressCode: ProgressCode.STEAMCMD_EXTRACTION_FAILED,
                params: { reason: tarErr.message },
              });
              log.error(`SteamCMD extraction failed: ${tarErr.message}`);
              return;
            }

            // Make steamcmd.sh executable
            const steamcmdSh = path.join(installPath, "steamcmd.sh");
            try {
              fs.chmodSync(steamcmdSh, 0o755);
            } catch (e) {
              /* ignore */
            }
            // Also make the actual binary executable
            const steamcmdBin = path.join(installPath, "steamcmd");
            try {
              fs.chmodSync(steamcmdBin, 0o755);
            } catch (e) {
              /* ignore */
            }

            // Install 32-bit libraries if missing (SteamCMD requires them on 64-bit CentOS/RHEL)
            log.info(
              "Checking for required 32-bit libraries (SteamCMD dependency)...",
            );
            execCb(
              "ldconfig -p | grep -c libc.so.6",
              { timeout: 5000 },
              (ldErr) => {
                if (ldErr) {
                  log.warn(
                    "Could not verify 32-bit libraries. SteamCMD may fail if glibc.i686 / lib32gcc is not installed.",
                  );
                  // Our own authored text, not SteamCMD's -- deliberately
                  // NOT routed through emitRawSteamCmdLine(). It carries a
                  // progressCode like every other authored line, on the
                  // same event a raw line would use, which is exactly the
                  // ambiguity that made this call site worth fixing: with
                  // the helper split in place, a raw line physically
                  // cannot carry a progressCode, so this one being
                  // authored is now visible in the payload shape itself.
                  io.emit("steamcmd:log", {
                    type: "stderr",
                    text: "Warning: Could not verify 32-bit libraries. If SteamCMD fails, install: yum install glibc.i686 libstdc++.i686 (CentOS/RHEL) or apt install lib32gcc-s1 (Debian/Ubuntu)",
                    progressCode: ProgressCode.STEAMCMD_32BIT_LIB_WARNING,
                  });
                }
                runFirstTimeSetup();
              },
            );
          },
        );
      }
    }

    function runFirstTimeSetup() {
      io.emit("steamcmd:status", {
        status: "initializing",
        message: "Initializing SteamCMD (first run)...",
        progressCode: ProgressCode.STEAMCMD_INITIALIZING,
      });
      log.info("Running SteamCMD first-time setup...");

      // installPath was already persisted as the steamcmdPath setting
      // earlier in this same request (before the download even started),
      // so this closure's value is provably the saved one -- not converted
      // to the async saveAndResolveSteamCmdExe() here because
      // runFirstTimeSetup() is a synchronous, fire-and-forget inner
      // function invoked from a spawn/stream callback, not awaited by
      // either caller.
      const steamcmdExe = getSteamCmdExe(installPath);
      // On Linux, set LD_LIBRARY_PATH for SteamCMD's 32-bit libraries
      const firstRunOpts = { cwd: installPath };
      if (!isWindows) {
        const ldPaths = [
          path.join(installPath, "linux32"),
          path.join(installPath, "linux64"),
          installPath,
          process.env.LD_LIBRARY_PATH || "",
        ]
          .filter(Boolean)
          .join(":");
        firstRunOpts.env = { ...process.env, LD_LIBRARY_PATH: ldPaths };
      }
      const steamcmd = spawn(steamcmdExe, ["+quit"], firstRunOpts);

      steamcmd.stdout.on("data", (data) => {
        emitRawSteamCmdLine(io, "steamcmd:log", "stdout", data.toString());
      });

      steamcmd.stderr.on("data", (data) => {
        emitRawSteamCmdLine(io, "steamcmd:log", "stderr", data.toString());
      });

      steamcmd.on("close", (code) => {
        if (code === 0 || code === 7) {
          io.emit("steamcmd:status", {
            status: "complete",
            message: "SteamCMD installed successfully!",
            path: installPath,
            progressCode: ProgressCode.STEAMCMD_INSTALL_COMPLETE,
          });
          log.info(`SteamCMD installed successfully to ${installPath}`);
        } else {
          io.emit("steamcmd:status", {
            status: "error",
            message: `SteamCMD setup failed with code ${code}`,
            progressCode: ProgressCode.STEAMCMD_SETUP_FAILED,
            params: { code },
          });
          log.error(`SteamCMD first-run failed with code ${code}`);
        }
      });

      steamcmd.on("error", (error) => {
        io.emit("steamcmd:status", {
          status: "error",
          message: `Failed to run SteamCMD: ${sanitizeError(error.message)}`,
          progressCode: ProgressCode.STEAMCMD_RUN_FAILED,
          params: { reason: sanitizeError(error.message) },
        });
        log.error(`SteamCMD run error: ${error.message}`);
      });
    }

    res.json({ success: true, message: "SteamCMD download started" });
  } catch (error) {
    log.error(`SteamCMD download failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Check if SteamCMD exists at a path
router.get("/steamcmd/check", requirePermission("server.install"), async (req, res) => {
  try {
    const { path: checkPath } = req.query;

    if (!checkPath || !isValidPath(checkPath)) {
      return res.json({ exists: false, message: "Invalid path" });
    }

    const steamcmdExe = getSteamCmdExe(checkPath);
    const exists = fs.existsSync(steamcmdExe);

    res.json({
      exists,
      path: checkPath,
      executable: steamcmdExe,
      message: exists
        ? "SteamCMD found"
        : "SteamCMD not found at this location",
    });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Fail-closed "is the server confirmed stopped" check, shared by both call
// sites in /delete-files below -- factored out instead of a second
// copy-pasted copy of the same ~15-line getServerProcessDetails/scanFailed
// block. Returns null when confirmed stopped and safe to proceed; otherwise
// the {status, body} to send back verbatim. checkServerRunning() would
// collapse a failed scan into a bare `false` (see d85fd42) and let a
// destructive action proceed against a server we simply failed to see was
// running -- getServerProcessDetails() exposes scanFailed so that case can
// be refused instead.
//
// NOT wired into /wipe, which has its own identical inline copy: that route
// is out of scope for this pass (2026-08-26 bug hunt round 2, Pam's
// asset-destruction hunt finding 2 -- TOCTOU on /delete-files specifically).
// A natural follow-up for whoever next touches /wipe.
async function checkServerConfirmedStopped(serverManager, actionLabel) {
  const processDetails = await serverManager.getServerProcessDetails();
  if (processDetails.scanFailed) {
    return {
      status: 503,
      body: {
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      },
    };
  }
  if (processDetails.running) {
    return {
      status: 400,
      body: {
        error: `Server must be stopped before ${actionLabel}. Stop the server first.`,
        // Shared with /wipe -- see errorCodes.js for why.
        code: ErrorCode.WIPE_SERVER_RUNNING,
      },
    };
  }
  return null;
}

// Delete server files (used when removing a server from panel with file deletion)
router.post("/delete-files", requirePermission("server.wipe"), async (req, res) => {
  try {
    // Same rails POST /wipe already has: refuse without confirm, refuse
    // while the server is running, and fail CLOSED (not open) when
    // detection itself can't tell. Mirrors /wipe's exact order: state check,
    // then confirm, then this route's own path/PZ-install validation below.
    const serverManager = req.app.get("serverManager");
    await serverManager.loadConfig();

    const notStoppedError = await checkServerConfirmedStopped(serverManager, "deleting its files");
    if (notStoppedError) {
      return res.status(notStoppedError.status).json(notStoppedError.body);
    }

    const { path: deletePath, confirm } = req.body || {};
    if (confirm !== true) {
      return res.status(400).json({
        error: "Deleting these files requires confirm: true",
        // Own code, not /wipe's -- see errorCodes.js for why this was split
        // from the shared WIPE_CONFIRM_REQUIRED (2026-08-26 bug hunt round 2).
        code: ErrorCode.DELETE_FILES_CONFIRM_REQUIRED,
      });
    }

    if (!deletePath || !isValidPath(deletePath)) {
      return res.status(400).json({ error: "Invalid path", code: ErrorCode.INVALID_PATH });
    }

    // Safety check: path must exist and contain PZ server files
    if (!fs.existsSync(deletePath)) {
      return res.status(404).json({ error: "Path does not exist", code: ErrorCode.PATH_NOT_FOUND });
    }

    // Check for known PZ server markers to prevent accidental deletion of wrong folders
    // Require one of the PZ-specific files (not just generic dirs like 'java')
    const hasPzFiles = hasPzInstallMarker(deletePath);

    // Also reject paths containing '..' after normalization
    const normalizedDelete = path.normalize(deletePath);
    if (normalizedDelete.includes("..")) {
      return res.status(400).json({ error: "Invalid path", code: ErrorCode.INVALID_PATH });
    }

    if (!hasPzFiles) {
      return res.status(400).json({
        error:
          "This does not appear to be a Project Zomboid server installation. Refusing to delete for safety.",
        code: ErrorCode.DELETE_FILES_NOT_PZ_INSTALL,
      });
    }

    // hasPzInstallMarker() above only confirms a handful of marker
    // FILENAMES exist -- trivially satisfied by creating an empty file
    // with one of those names anywhere on the host, not an authorization
    // check (bug-hunt-2026-08-27). The two real callers of this route
    // (Servers.tsx's "Delete Everything" and "Clear Install Folder") only
    // ever pass a path that's already a configured server's own
    // installPath, so require an exact match against one -- turning
    // "any directory with a spoofable marker file" into "must be a server
    // the panel already has on record" (creating that record requires
    // servers.manage, a capability distinct from server.wipe). This is a
    // second, narrower layer on top of the marker check, not a
    // replacement for it.
    const resolvedDeletePath = path.resolve(deletePath);
    const configuredServers = await getServers();
    const matchesConfiguredServer = configuredServers.some(
      (s) => s.installPath && path.resolve(s.installPath) === resolvedDeletePath,
    );
    if (!matchesConfiguredServer) {
      return res.status(400).json({
        error:
          "This path doesn't match a server the panel has on record. Refusing to delete for safety.",
        code: ErrorCode.DELETE_FILES_NOT_CONFIGURED_SERVER,
      });
    }

    // A default install keeps the Zomboid data folder OUTSIDE installPath
    // (resolveZomboidPaths defaults it to a sibling `<installPath>_Data`),
    // so deleting the install folder alone leaves Saves/Multiplayer
    // untouched -- annoying (reinstall via the Setup Wizard) but not a
    // world-ending loss. Nothing stops an operator from pointing
    // zomboidDataPath INSIDE the install folder instead, though, and
    // nothing here ever checked for it. When that's the configuration,
    // this delete also destroys the live world save -- a different
    // severity than "reinstall the binaries," and the UI gives no
    // indication either way. Refuse outright rather than trying to back
    // the data up first: the backups folder itself lives at
    // <zomboidDataPath>/backups, which would be inside the doomed tree
    // too, so a same-tree backup would just get deleted right alongside
    // everything else it was meant to protect.
    const zomboidDataPath = serverManager.savePath;
    if (zomboidDataPath) {
      const resolvedDeletePath = path.resolve(deletePath);
      if (confineToRoots(zomboidDataPath, [resolvedDeletePath])) {
        return res.status(400).json({
          error: `Refusing to delete: this server's Zomboid data folder (${zomboidDataPath}) is inside the folder you're about to delete, so this would also permanently destroy the world save. Move the data path outside the install folder in Settings, or back it up yourself first, before deleting.`,
          code: ErrorCode.DELETE_FILES_DATA_PATH_NESTED,
        });
      }
    }

    // Re-check immediately before the irreversible delete (2026-08-26 bug
    // hunt round 2, Pam's finding 2): the FIRST check above is stale by the
    // time we get here -- getServerProcessDetails() takes real wall-clock
    // time (OS process enumeration), and everything between that await
    // resolving and this point is synchronous path/marker validation with
    // no further awaits, so a second admin session, a scheduler task, or a
    // supervisor auto-restart starting the server DURING that first scan
    // would sail through undetected. This doesn't make the check-then-act
    // atomic in a formal sense -- true atomicity would need the /start path
    // to participate in a shared lock too, out of scope here -- but it
    // narrows the exploitable window from "however long the first scan
    // took" down to just this second scan's own duration, immediately
    // before the act it guards, using the exact same fail-closed check.
    const stillNotStoppedError = await checkServerConfirmedStopped(serverManager, "deleting its files");
    if (stillNotStoppedError) {
      return res.status(stillNotStoppedError.status).json(stillNotStoppedError.body);
    }

    log.warn(`Deleting server files at: ${deletePath}`);

    // Use recursive delete
    fs.rmSync(deletePath, { recursive: true, force: true });

    log.info(`Successfully deleted server files at: ${deletePath}`);
    res.json({ success: true, message: "Server files deleted" });
  } catch (error) {
    log.error(`Failed to delete server files: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// List directory contents for the in-app folder browser
router.post("/list-directory", requirePermission("server.install"), async (req, res) => {
  try {
    const { dirPath } = req.body || {};

    // If no path provided, return available drives (Windows) or root (Linux)
    if (!dirPath) {
      if (isWindows) {
        // List available drive letters
        const drives = [];
        for (let i = 65; i <= 90; i++) {
          const letter = String.fromCharCode(i);
          const drivePath = `${letter}:\\`;
          try {
            fs.accessSync(drivePath, fs.constants.R_OK);
            let label = `Local Disk (${letter}:)`;
            try {
              const stats = fs.statfsSync(drivePath);
              const totalGB = (
                (stats.bsize * stats.blocks) /
                1024 ** 3
              ).toFixed(1);
              const freeGB = ((stats.bsize * stats.bfree) / 1024 ** 3).toFixed(
                1,
              );
              label = `${letter}: — ${freeGB} GB free of ${totalGB} GB`;
            } catch (e) {
              log.debug(`Drive stat failed for ${letter}: ${e.message}`);
            }
            drives.push({
              name: `${letter}:`,
              path: drivePath,
              label,
              isDrive: true,
            });
          } catch (e) {
            // Drive not accessible
          }
        }
        return res.json({
          entries: drives,
          currentPath: null,
          parentPath: null,
        });
      } else {
        // Linux: start at root
        return res.json({
          entries: [{ name: "/", path: "/", label: "/", isDrive: true }],
          currentPath: null,
          parentPath: null,
        });
      }
    }

    // Validate the requested path
    if (!isValidPath(dirPath)) {
      return res.status(400).json({ error: "Invalid path", code: ErrorCode.INVALID_PATH });
    }

    const normalized = path.normalize(dirPath);

    if (!fs.existsSync(normalized)) {
      return res.status(404).json({ error: "Path does not exist", code: ErrorCode.PATH_NOT_FOUND });
    }

    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: "Path is not a directory", code: ErrorCode.PATH_NOT_A_DIRECTORY });
    }

    // Read directory entries — only folders
    let items;
    try {
      items = fs.readdirSync(normalized, { withFileTypes: true });
    } catch (e) {
      const osCode = e && typeof e === "object" && "code" in e ? e.code : "UNKNOWN";
      const readError = formatDirectoryReadError(normalized, osCode);
      return res.status(403).json({
        error: readError.message,
        code: readError.code,
        params: readError.params,
      });
    }

    const folders = [];
    for (const item of items) {
      if (!item.isDirectory()) continue;
      // Skip hidden/system folders
      if (
        item.name.startsWith(".") ||
        item.name === "$RECYCLE.BIN" ||
        item.name === "System Volume Information"
      )
        continue;
      folders.push({
        name: item.name,
        path: path.join(normalized, item.name),
      });
    }

    // Sort alphabetically, case-insensitive
    folders.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

    // Parent path
    const parentPath = path.dirname(normalized);
    const hasParent = parentPath !== normalized; // at root when dirname === self

    res.json({
      entries: folders,
      currentPath: normalized,
      parentPath: hasParent ? parentPath : null,
    });
  } catch (error) {
    log.error(`List directory failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Open folder browser dialog (uses PowerShell on Windows, zenity/kdialog on Linux)
router.post("/browse-folder", requirePermission("server.install"), async (req, res) => {
  try {
    const { initialPath, description = "Select a folder" } = req.body || {};

    // Strict validation for description — alphanumeric, spaces, and basic punctuation only
    if (
      typeof description !== "string" ||
      description.length > 100 ||
      !/^[a-zA-Z0-9 _.\-:()]+$/.test(description)
    ) {
      return res.status(400).json({ error: "Invalid description parameter", code: ErrorCode.BROWSE_FOLDER_INVALID_DESCRIPTION });
    }

    if (!isWindows) {
      // Linux: try zenity, then kdialog, then return unsupported
      const execCb = exec;
      const safeDesc = description.replace(/'/g, "'\\''");
      const safePath =
        initialPath && isValidPath(initialPath)
          ? initialPath.replace(/'/g, "'\\''")
          : "";

      // Try zenity first (GNOME/GTK)
      const zenityCmd = `zenity --file-selection --directory --title='${safeDesc}'${safePath ? ` --filename='${safePath}/'` : ""}`;
      execCb(zenityCmd, { timeout: 120000 }, (zenErr, zenOut) => {
        if (!zenErr && zenOut && zenOut.trim()) {
          return res.json({
            success: true,
            path: zenOut.trim(),
            cancelled: false,
          });
        }
        // If zenity returned exit code 1 (user cancelled), return cancelled
        if (zenErr && zenErr.code === 1) {
          return res.json({ success: false, path: null, cancelled: true });
        }
        // Try kdialog (KDE)
        const kdialogCmd = `kdialog --getexistingdirectory '${safePath || "~"}' --title '${safeDesc}'`;
        execCb(kdialogCmd, { timeout: 120000 }, (kdErr, kdOut) => {
          if (!kdErr && kdOut && kdOut.trim()) {
            return res.json({
              success: true,
              path: kdOut.trim(),
              cancelled: false,
            });
          }
          if (kdErr && kdErr.code === 1) {
            return res.json({ success: false, path: null, cancelled: true });
          }
          // No GUI dialog available
          return res.status(501).json({
            error:
              "No folder browser available. Install zenity or kdialog, or enter the path manually.",
            code: ErrorCode.BROWSE_FOLDER_NO_DIALOG_AVAILABLE,
          });
        });
      });
      return;
    }

    const safePath =
      initialPath && isValidPath(initialPath)
        ? initialPath.replace(/'/g, "''")
        : "";
    const safeDesc = description.replace(/'/g, "''");

    // Simple FolderBrowserDialog — needs -STA for COM, no RootFolder restriction
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '${safeDesc}'
$dialog.UseDescriptionForTitle = $true
$dialog.ShowNewFolderButton = $true
${safePath ? `if (Test-Path '${safePath}') { $dialog.SelectedPath = '${safePath}' }` : ""}
$result = $dialog.ShowDialog()
if ($result -eq 'OK') { Write-Output $dialog.SelectedPath } else { Write-Output '' }
`;

    const powershell = spawn(
      "powershell",
      ["-NoProfile", "-STA", "-Command", psScript],
      {
        windowsHide: false,
      },
    );

    let output = "";
    let errorOutput = "";

    powershell.stdout.on("data", (data) => {
      output += data.toString();
    });

    powershell.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    powershell.on("close", (code) => {
      const selectedPath = output.trim();

      if (code !== 0 || errorOutput) {
        log.warn(`Folder browser had issues: ${errorOutput}`);
      }

      res.json({
        success: !!selectedPath,
        path: selectedPath || null,
        cancelled: !selectedPath,
      });
    });

    powershell.on("error", (error) => {
      log.error(`Folder browser error: ${error.message}`);
      res.status(500).json({ error: "Failed to open folder browser", code: ErrorCode.BROWSE_FOLDER_OPEN_FAILED });
    });
  } catch (error) {
    log.error(`Browse folder failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ============================================
// Server Console Log (server-console.txt)
// ============================================

// Filter patterns for console log - patterns to exclude (noise)
const CONSOLE_LOG_EXCLUDE_PATTERNS = [
  // Duplicate sprites/textures (very spammy)
  /IsoSpriteManager\.AddSprite > duplicate texture/,
  // PlayerHitZombie packet spam (not consistent packets)
  /The packet PlayerHitZombie is not consistent/,
  // Missing icons for build items (cosmetic only)
  /XuiSkin\$EntityUiStyle\.Load > Could not find icon:/,
  /XuiSkin\$EntityUiStyle\.LoadComponentInfo> Could not find icon:/,
  // Recursive require warnings (usually harmless)
  /LuaManager\.RunLua > recursive require\(\)/,
  // AnimalPacket/AnimalEventPacket class warnings (known issue)
  /The AnimalPacket class doesn't have PacketSetting attributes/,
  /The AnimalEventPacket class doesn't have PacketSetting attributes/,
];

// Patterns for errors (always show these)
const CONSOLE_LOG_ERROR_PATTERNS = [
  /^ERROR\[/,
  /Exception thrown/,
  /Stack trace:/,
  /java\.lang\.\w+Exception/,
  /KahluaThread\.flushErrorMessage/,
];

// Patterns for important info (always show these)
const CONSOLE_LOG_IMPORTANT_PATTERNS = [
  /^\[PanelBridge\]/,
  /SERVER STARTED/,
  /fully-connected/,
  /player-connect/,
  /connection-lost/,
  /disconnect/,
  /Steam client .* is initiating/,
  /RCON:/,
  /Recipe AutoLearned/,
  /Reduce Head Condition/,
  /ISBuildIsoEntity/,
];

/**
 * Filter console log lines based on filter level
 * @param {string[]} lines - Array of log lines
 * @param {string} filterLevel - 'all' | 'filtered' | 'important' | 'errors'
 * @returns {string[]} Filtered lines
 */
function filterConsoleLogLines(lines, filterLevel = "filtered") {
  if (filterLevel === "all") {
    return lines;
  }

  return lines.filter((line) => {
    if (!line.trim()) return false;

    // Always include error lines
    const isError = CONSOLE_LOG_ERROR_PATTERNS.some((pattern) =>
      pattern.test(line),
    );
    if (isError) return true;

    // Always include important lines
    const isImportant = CONSOLE_LOG_IMPORTANT_PATTERNS.some((pattern) =>
      pattern.test(line),
    );
    if (isImportant) return true;

    // For 'errors' level, only show errors
    if (filterLevel === "errors") {
      return isError;
    }

    // For 'important' level, show errors + important
    if (filterLevel === "important") {
      return isError || isImportant;
    }

    // For 'filtered' level (default), exclude noise patterns
    const isNoise = CONSOLE_LOG_EXCLUDE_PATTERNS.some((pattern) =>
      pattern.test(line),
    );
    return !isNoise;
  });
}

// Get server console log content
router.get("/console-log", requirePermission("server.world_events"), async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    // server-console.txt is in zomboidDataPath (where Server/, Saves/, Logs/ are)
    const zomboidDataPath =
      activeServer?.zomboidDataPath ||
      activeServer?.installPath ||
      (await getSetting("zomboidDataPath")) ||
      (await getSetting("serverPath"));

    if (!zomboidDataPath) {
      return res.status(400).json({ error: "Server data path not configured", code: ErrorCode.SERVER_DATA_PATH_NOT_CONFIGURED });
    }

    const consoleLogPath = path.join(zomboidDataPath, "server-console.txt");

    if (!fs.existsSync(consoleLogPath)) {
      return res.json({
        success: true,
        content: "",
        lines: [],
        exists: false,
        path: consoleLogPath,
      });
    }

    // Filter level: 'all' | 'filtered' | 'important' | 'errors'
    const filterLevel = req.query.filter || "filtered";

    // Read last N lines (default 500, max 2000)
    const maxLines = parseBoundedInteger(req.query.lines, 500, 1, 2000);

    // Read only the tail of the file to prevent DoS with large log files
    const stats = fs.statSync(consoleLogPath);
    const MAX_READ_BYTES = 5 * 1024 * 1024; // 5MB cap
    let content;
    if (stats.size > MAX_READ_BYTES) {
      const fd = fs.openSync(consoleLogPath, "r");
      const readStart = stats.size - MAX_READ_BYTES;
      const buffer = Buffer.alloc(MAX_READ_BYTES);
      try {
        fs.readSync(fd, buffer, 0, MAX_READ_BYTES, readStart);
      } finally {
        try {
          fs.closeSync(fd);
        } catch (_) {
          /* ignore */
        }
      }
      // Skip first partial line after seeking
      const raw = buffer.toString("utf-8");
      const firstNewline = raw.indexOf("\n");
      content = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
    } else {
      content = fs.readFileSync(consoleLogPath, "utf-8");
    }
    const allLines = content.split("\n");

    // Apply filtering
    const filteredLines = filterConsoleLogLines(allLines, filterLevel);
    const lines = filteredLines.slice(-maxLines);

    res.json({
      success: true,
      content: lines.join("\n"),
      lines,
      totalLines: allLines.length,
      filteredCount: filteredLines.length,
      filterLevel,
      exists: true,
      path: consoleLogPath,
      lastModified: stats.mtime.toISOString(),
      size: stats.size,
    });
  } catch (error) {
    log.error(`Failed to read server console log: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// How many errors the game has thrown, so the dashboard can stop being calm
// while the server is screaming. Counted from the most recent "SERVER STARTED"
// marker when one is present in the sampled tail, otherwise across the sample.
let errorCountCache = { at: 0, value: null };
const ERROR_COUNT_TTL_MS = 20000;

router.get("/console-log/error-count", requirePermission("server.world_events"), async (req, res) => {
  try {
    const now = Date.now();
    if (errorCountCache.value && now - errorCountCache.at < ERROR_COUNT_TTL_MS) {
      return res.json(errorCountCache.value);
    }

    const activeServer = await getActiveServer();
    const zomboidDataPath =
      activeServer?.zomboidDataPath ||
      activeServer?.installPath ||
      (await getSetting("zomboidDataPath")) ||
      (await getSetting("serverPath"));

    if (!zomboidDataPath) {
      return res.json({ exists: false, count: 0, sinceStart: false });
    }

    const consoleLogPath = path.join(zomboidDataPath, "server-console.txt");
    if (!fs.existsSync(consoleLogPath)) {
      return res.json({ exists: false, count: 0, sinceStart: false });
    }

    // Only ever read the tail. This endpoint is polled, so it must stay cheap
    // no matter how large the log has grown.
    const MAX_READ_BYTES = 2 * 1024 * 1024;
    const stats = fs.statSync(consoleLogPath);
    let content;
    let truncated = false;
    if (stats.size > MAX_READ_BYTES) {
      truncated = true;
      const fd = fs.openSync(consoleLogPath, "r");
      const buffer = Buffer.alloc(MAX_READ_BYTES);
      try {
        fs.readSync(fd, buffer, 0, MAX_READ_BYTES, stats.size - MAX_READ_BYTES);
      } finally {
        try {
          fs.closeSync(fd);
        } catch (_) {
          /* ignore */
        }
      }
      const raw = buffer.toString("utf-8");
      const firstNewline = raw.indexOf("\n");
      content = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
    } else {
      content = fs.readFileSync(consoleLogPath, "utf-8");
    }

    const lines = content.split("\n");
    let startIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/SERVER STARTED/.test(lines[i])) {
        startIndex = i;
        break;
      }
    }
    const scanned = startIndex >= 0 ? lines.slice(startIndex) : lines;
    const count = scanned.filter((line) =>
      CONSOLE_LOG_ERROR_PATTERNS.some((pattern) => pattern.test(line)),
    ).length;

    const payload = {
      exists: true,
      count,
      sinceStart: startIndex >= 0,
      truncated,
      lastModified: stats.mtime.toISOString(),
    };
    errorCountCache = { at: now, value: payload };
    res.json(payload);
  } catch (error) {
    log.error(`Failed to count console log errors: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Stream server console log (long-polling for new content)
router.get("/console-log/stream", requirePermission("server.world_events"), async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    // server-console.txt is in zomboidDataPath (where Server/, Saves/, Logs/ are)
    const zomboidDataPath =
      activeServer?.zomboidDataPath ||
      activeServer?.installPath ||
      (await getSetting("zomboidDataPath")) ||
      (await getSetting("serverPath"));

    if (!zomboidDataPath) {
      return res.status(400).json({ error: "Server data path not configured", code: ErrorCode.SERVER_DATA_PATH_NOT_CONFIGURED });
    }

    const consoleLogPath = path.join(zomboidDataPath, "server-console.txt");

    if (!fs.existsSync(consoleLogPath)) {
      return res.json({ success: true, newLines: [], exists: false });
    }

    // Filter level: 'all' | 'filtered' | 'important' | 'errors'
    const filterLevel = req.query.filter || "filtered";

    // Get the last known position from client
    const lastSize = parseBoundedInteger(
      req.query.lastSize,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const stats = fs.statSync(consoleLogPath);

    // If file is smaller than last known size, it was likely rotated/cleared
    if (stats.size < lastSize) {
      const content = fs.readFileSync(consoleLogPath, "utf-8");
      const allLines = content.split("\n").filter((l) => l.trim());
      const lines = filterConsoleLogLines(allLines, filterLevel);
      return res.json({
        success: true,
        newLines: lines,
        currentSize: stats.size,
        rotated: true,
        filterLevel,
        lastModified: stats.mtime.toISOString(),
      });
    }

    // If no new content, return empty
    if (stats.size === lastSize) {
      return res.json({
        success: true,
        newLines: [],
        currentSize: stats.size,
        filterLevel,
        lastModified: stats.mtime.toISOString(),
      });
    }

    // Read only new content from the last known position
    const fd = fs.openSync(consoleLogPath, "r");
    const newBytes = stats.size - lastSize;
    const buffer = Buffer.alloc(newBytes);
    try {
      fs.readSync(fd, buffer, 0, newBytes, lastSize);
    } finally {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* ignore */
      }
    }

    const newContent = buffer.toString("utf-8");
    const allNewLines = newContent.split("\n").filter((l) => l.trim());
    const newLines = filterConsoleLogLines(allNewLines, filterLevel);

    res.json({
      success: true,
      newLines,
      currentSize: stats.size,
      filterLevel,
      lastModified: stats.mtime.toISOString(),
    });
  } catch (error) {
    log.error(`Failed to stream server console log: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Clear server console log
router.post("/console-log/clear", requirePermission("server.configure"), async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    // server-console.txt is in zomboidDataPath (where Server/, Saves/, Logs/ are)
    const zomboidDataPath =
      activeServer?.zomboidDataPath ||
      activeServer?.installPath ||
      (await getSetting("zomboidDataPath")) ||
      (await getSetting("serverPath"));

    if (!zomboidDataPath) {
      return res.status(400).json({ error: "Server data path not configured", code: ErrorCode.SERVER_DATA_PATH_NOT_CONFIGURED });
    }

    const consoleLogPath = path.join(zomboidDataPath, "server-console.txt");

    if (fs.existsSync(consoleLogPath)) {
      fs.writeFileSync(consoleLogPath, "");
      log.info("Server console log cleared");
    }

    res.json({ success: true });
  } catch (error) {
    log.error(`Failed to clear server console log: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ==================== UPDATE CHECKER ROUTES ====================

// Check for server updates
router.get("/update-check", requirePermission("server.world_events"), async (req, res) => {
  try {
    const updateChecker = req.app.get("updateChecker");
    if (!updateChecker) {
      return res.status(503).json({ error: "Update checker not available", code: ErrorCode.UPDATE_CHECKER_NOT_AVAILABLE });
    }

    const forceCheck = req.query.force === "true";

    if (forceCheck) {
      const result = await updateChecker.checkForUpdates(true);
      res.json(result || { error: "Could not check for updates", code: ErrorCode.UPDATE_CHECK_NO_RESULT });
    } else {
      res.json(await updateChecker.getStatus());
    }
  } catch (error) {
    log.error(`Update check failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get update checker status
router.get("/update-check/status", requirePermission("server.world_events"), async (req, res) => {
  try {
    const updateChecker = req.app.get("updateChecker");
    if (!updateChecker) {
      return res.status(503).json({ error: "Update checker not available", code: ErrorCode.UPDATE_CHECKER_NOT_AVAILABLE });
    }

    res.json(await updateChecker.getStatus());
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Acknowledge the last automatic-update result so its banner stops showing.
// Shared server-side state (not per-browser localStorage) deliberately: a
// failure one admin dismisses must not vanish for another admin or another
// device that never saw it.
router.post("/update-check/auto-update-result/dismiss", requirePermission("server.world_events"), async (req, res) => {
  try {
    const updateChecker = req.app.get("updateChecker");
    if (!updateChecker) {
      return res.status(503).json({ error: "Update checker not available", code: ErrorCode.UPDATE_CHECKER_NOT_AVAILABLE });
    }

    await updateChecker.dismissAutoUpdateResult();
    res.json(await updateChecker.getStatus());
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set update check interval
router.post("/update-check/interval", requirePermission("server.configure"), async (req, res) => {
  try {
    const updateChecker = req.app.get("updateChecker");
    if (!updateChecker) {
      return res.status(503).json({ error: "Update checker not available", code: ErrorCode.UPDATE_CHECKER_NOT_AVAILABLE });
    }

    const { minutes } = req.body || {};
    if (!minutes || typeof minutes !== "number") {
      return res.status(400).json({ error: "minutes must be a number", code: ErrorCode.UPDATE_CHECK_INTERVAL_INVALID });
    }

    await updateChecker.setInterval(minutes);
    res.json({ success: true, intervalMinutes: minutes });
  } catch (error) {
    log.error(`Failed to set update check interval: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ── Server Wipe ──────────────────────────────────────────────────────────────

// Guard against concurrent wipe operations
let wipeInProgress = false;

// Run `worker` over `items` with at most `limit` in flight at once. Mirrors
// chunks.js's runWithConcurrency (same reasoning: unbounded Promise.all over
// a directory with hundreds of entries can exhaust file handles or, on slow
// storage, queue so many concurrent round trips that it's slower than doing
// them one at a time) -- duplicated locally rather than imported since
// chunks.js doesn't export it and these two route files don't otherwise
// depend on each other.
const WIPE_PREVIEW_WALK_CONCURRENCY = 8;
async function runWithConcurrencyBounded(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

// Recursively count files and total size under `dir`. Was fully synchronous
// (fs.readdirSync/fs.statSync, no concurrency, no cap) -- Jim measured 20.7
// SECONDS for map/ alone on a 147,136-file save, fully blocking the Node
// event loop that whole time for every other admin session and RCON call on
// the panel, not just the requester's own page. Now async with bounded
// per-level concurrency (same shape as chunks.js's getDirStats) and a
// shared `budget` -- a wall-clock deadline plus an entry cap, same pattern
// as debug.js's scanSaveStats -- so a pathologically large or slow-storage
// save can't hang the request open-endedly. Once the budget runs out,
// `budget.truncated` is set and every further call returns zero rather than
// silently continuing to count: the caller MUST report that flag rather
// than presenting a wipe-preview number that quietly stopped being exact.
export async function countDir(dir, budget) {
  if (budget.truncated || Date.now() >= budget.deadline || budget.visited >= budget.maxEntries) {
    budget.truncated = true;
    return { files: 0, size: 0 };
  }
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    log.debug(`countDir readdir failed for ${dir}: ${e.message}`);
    return { files: 0, size: 0 };
  }
  const results = await runWithConcurrencyBounded(
    entries,
    WIPE_PREVIEW_WALK_CONCURRENCY,
    async (entry) => {
      if (budget.truncated || Date.now() >= budget.deadline || budget.visited >= budget.maxEntries) {
        budget.truncated = true;
        return { files: 0, size: 0 };
      }
      budget.visited++;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return countDir(fullPath, budget);
      }
      let size = 0;
      try {
        const stat = await fs.promises.stat(fullPath);
        size = stat.size;
      } catch (e) {
        log.debug(`Stat failed for ${fullPath}: ${e.message}`);
      }
      return { files: 1, size };
    },
  );
  let files = 0;
  let size = 0;
  for (const r of results) {
    files += r.files;
    size += r.size;
  }
  return { files, size };
}

// Preview what will be wiped (dry-run). Admin-only, same as /wipe itself --
// this pairs with the actual wipe, so anyone who can't wipe has no reason
// to preview one.
router.post("/wipe/preview", requirePermission("server.wipe"), async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    await serverManager.loadConfig();

    const { targets } = req.body || {}; // e.g. ["map", "players", "world"]
    if (!Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({
        error:
          "targets must be a non-empty array of: map, players, world, accounts",
        code: ErrorCode.WIPE_TARGETS_REQUIRED,
      });
    }

    // "accounts" lives outside the save folder, so it is not part of the sweep
    const SAVE_TARGETS = ["map", "players", "world"];
    const allowedTargets = [...SAVE_TARGETS, "accounts"];
    const invalid = targets.filter((t) => !allowedTargets.includes(t));
    if (invalid.length > 0) {
      return res.status(400).json({
        error: `Invalid targets: ${invalid.join(", ")}. Allowed: ${allowedTargets.join(", ")}`,
        code: ErrorCode.WIPE_PREVIEW_INVALID_TARGETS,
      });
    }

    const savePath = serverManager.savePath;
    const serverName = serverManager.serverName || "servertest";
    if (!savePath) {
      return res.status(400).json({ error: "No zomboid data path configured", code: ErrorCode.WIPE_ZOMBOID_DATA_PATH_NOT_CONFIGURED });
    }
    // Reject server names with path separators
    if (/[/\\]/.test(serverName)) {
      return res.status(400).json({ error: "Invalid server name", code: ErrorCode.WIPE_INVALID_SERVER_NAME });
    }

    const saveDir = path.join(savePath, "Saves", "Multiplayer", serverName);
    if (!fs.existsSync(saveDir)) {
      return res
        .status(404)
        .json({ error: `Save directory not found: ${serverName}`, code: ErrorCode.WIPE_SAVE_DIRECTORY_NOT_FOUND });
    }

    const preview = {};
    let totalFiles = 0;
    let totalSize = 0;
    // Shared across every countDir() call below so the budget covers the
    // WHOLE preview request (every target's directories combined), not each
    // directory independently -- otherwise several individually-under-
    // budget walks could still add up to the multi-second block this fix
    // exists to remove. 15s / 300,000 entries is generous headroom over
    // Jim's 20.7s/147,136-file measurement (which was the fully synchronous,
    // no-concurrency walk); truncation is a backstop for pathological or
    // slow-storage cases, not an expected outcome for a normal save.
    const budget = {
      deadline: Date.now() + 15_000,
      visited: 0,
      maxEntries: 300_000,
      truncated: false,
    };

    // Directories belonging to each target
    const MAP_DIRS = [
      "map",
      "chunkdata",
      "isoregiondata",
      "zpop",
      "apop",
      "metagrid",
      "map_visited_server",
    ];
    const WORLD_DIRS = ["radio"];
    // Player files in save root
    const PLAYER_ROOT_FILES =
      /^(players\.db|players\.db-journal|vehicles\.db|vehicles\.db-journal|map_p\.bin|map_zone\.bin)$/i;
    // World state files in save root (everything that isn't player data or directories)
    // This covers WorldDictionary.bin, map_meta.bin, map_t.bin, entity_data.bin,
    // global_mod_data.bin, reanimated.bin, iTrack.bin, gos_*.bin, map_*.bin (except map_zone/map_p),
    // z_outfits.bin, recorded_media.bin, erosion.ini, WorldDictionary*.lua, etc.
    const WORLD_ROOT_FILES =
      /^(WorldDictionary.*|map_meta\.bin|map_t\.bin|map_worldgen\.bin|map_animals\.bin|map_basements\.bin|entity_data\.bin|global_mod_data\.bin|reanimated\.bin|iTrack\.bin|gos_.*\.bin|id_manager_data\.bin|important_area_data\.bin|z_outfits\.bin|recorded_media\.bin|servermap_symbols\.bin|map_sand\.bin|hidden_authors\.ini|erosion\.ini)$/i;

    if (targets.includes("map")) {
      let mapFiles = 0;
      let mapSize = 0;
      for (const dirName of MAP_DIRS) {
        const dir = path.join(saveDir, dirName);
        if (fs.existsSync(dir)) {
          const sub = await countDir(dir, budget);
          mapFiles += sub.files;
          mapSize += sub.size;
        }
      }
      preview.map = { files: mapFiles, size: mapSize };
      totalFiles += mapFiles;
      totalSize += mapSize;
    }

    if (targets.includes("players")) {
      let playerFiles = 0;
      let playerSize = 0;
      try {
        const rootEntries = fs.readdirSync(saveDir, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (!entry.isDirectory() && PLAYER_ROOT_FILES.test(entry.name)) {
            playerFiles++;
            try {
              playerSize += fs.statSync(path.join(saveDir, entry.name)).size;
            } catch (e) {
              log.debug(
                `Stat failed for player file ${entry.name}: ${e.message}`,
              );
            }
          }
        }
      } catch (e) {
        log.debug(`Player file scan failed: ${e.message}`);
      }
      preview.players = { files: playerFiles, size: playerSize };
      totalFiles += playerFiles;
      totalSize += playerSize;
    }

    if (targets.includes("world")) {
      let worldFiles = 0;
      let worldSize = 0;
      // Count world directories
      for (const dirName of WORLD_DIRS) {
        const dir = path.join(saveDir, dirName);
        if (fs.existsSync(dir)) {
          const sub = await countDir(dir, budget);
          worldFiles += sub.files;
          worldSize += sub.size;
        }
      }
      // Count world root files
      try {
        const rootEntries = fs.readdirSync(saveDir, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (!entry.isDirectory() && WORLD_ROOT_FILES.test(entry.name)) {
            worldFiles++;
            try {
              worldSize += fs.statSync(path.join(saveDir, entry.name)).size;
            } catch (e) {
              log.debug(
                `Stat failed for world file ${entry.name}: ${e.message}`,
              );
            }
          }
        }
      } catch (e) {
        log.debug(`World file scan failed: ${e.message}`);
      }
      preview.world = { files: worldFiles, size: worldSize };
      totalFiles += worldFiles;
      totalSize += worldSize;
    }

    // Selecting every target means a total wipe, so account for anything the
    // per-target lists don't recognise (mod files, stale backups, new formats).
    if (SAVE_TARGETS.every((t) => targets.includes(t))) {
      const claimed = new Set([...MAP_DIRS, ...WORLD_DIRS]);
      let extraFiles = 0;
      let extraSize = 0;
      try {
        for (const entry of fs.readdirSync(saveDir, { withFileTypes: true })) {
          if (claimed.has(entry.name)) continue;
          if (
            !entry.isDirectory() &&
            (PLAYER_ROOT_FILES.test(entry.name) ||
              WORLD_ROOT_FILES.test(entry.name))
          ) {
            continue;
          }
          const fullPath = path.join(saveDir, entry.name);
          if (entry.isDirectory()) {
            const sub = await countDir(fullPath, budget);
            extraFiles += sub.files;
            extraSize += sub.size;
          } else {
            extraFiles++;
            try {
              extraSize += fs.statSync(fullPath).size;
            } catch (e) {
              log.debug(`Stat failed for ${entry.name}: ${e.message}`);
            }
          }
        }
      } catch (e) {
        log.debug(`Leftover scan failed: ${e.message}`);
      }
      preview.leftovers = { files: extraFiles, size: extraSize };
      totalFiles += extraFiles;
      totalSize += extraSize;
    }

    if (targets.includes("accounts")) {
      let accountFiles = 0;
      let accountSize = 0;
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        const dbFile = path.join(savePath, "db", `${serverName}.db${suffix}`);
        if (fs.existsSync(dbFile)) {
          accountFiles++;
          try {
            accountSize += fs.statSync(dbFile).size;
          } catch (e) {
            log.debug(`Stat failed for ${dbFile}: ${e.message}`);
          }
        }
      }
      preview.accounts = { files: accountFiles, size: accountSize };
      totalFiles += accountFiles;
      totalSize += accountSize;
    }

    res.json({
      success: true,
      serverName,
      saveDir,
      targets,
      preview,
      totalFiles,
      totalSize,
      // True if the walk hit its wall-clock/entry-count budget before
      // finishing -- the counts above are then a LOWER BOUND, not exact.
      // Never silently swallowed: the wipe dialog is about to act on these
      // numbers, so an operator seeing a truncated preview needs to know
      // it undercounts rather than trusting it as final.
      truncated: budget.truncated,
    });
  } catch (error) {
    log.error(`Wipe preview failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Execute server wipe
router.post("/wipe", requirePermission("server.wipe"), async (req, res) => {
  // Claim the guard before the first await: awaiting between the check and the
  // assignment lets a second concurrent request pass the check and run a
  // parallel destructive wipe of the same save directory.
  if (wipeInProgress) {
    return res.status(409).json({
      error: "A wipe operation is already in progress. Please wait.",
      code: ErrorCode.WIPE_IN_PROGRESS,
    });
  }
  wipeInProgress = true;

  // 2026-09-05 host-suspend-resume sweep: the "server must be stopped"
  // check below and the multi-minute pre-wipe backup that follows it were
  // not covered by any lock a concurrent /start could also see -- only
  // `wipeInProgress` (this-route-only) stood in the way, so a Start fired
  // during the backup passed straight through and this handler went on to
  // rmSync the save tree of a now-running server. restoreBackup() has the
  // exact same shape (checked-then-long-op-then-destructive) and is fixed
  // the same way in backupService.js: acquire the SAME process-wide
  // lifecycle lock /start, /stop, /restart already take, before the
  // stopped-check, held through the destructive step, released once in the
  // outer finally below alongside wipeInProgress.
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = acquireLifecycleLock(
    "wipe",
    activeServerForLock?.name || activeServerForLock?.serverName || null,
  );
  if (!lifecycleLock) {
    wipeInProgress = false;
    return res.status(409).json(lifecycleInProgressResponse());
  }

  // Declared here, not with `const`/`let` inside the try below, so the
  // catch block can still see whatever these held at the moment of a
  // mid-wipe throw -- a try-scoped `const results = {}` is invisible to
  // its own catch in JS, which would have made the partial-failure report
  // below throw a ReferenceError instead of ever reaching the client.
  let serverName = null;
  let backupResult = null;
  let results = {};
  let targets = null;

  try {
    const serverManager = req.app.get("serverManager");
    await serverManager.loadConfig();

    // Safety: server must be stopped, and we must be SURE of that.
    // checkServerRunning() collapses a failed detection scan into `false`
    // (same as a confirmed-stopped server), which would let this destructive
    // wipe proceed against a server we simply failed to see was running.
    // getServerProcessDetails() exposes that distinction via scanFailed, so
    // use it directly here and fail closed when detection itself failed.
    const processDetails = await serverManager.getServerProcessDetails();
    if (processDetails.scanFailed) {
      return res.status(503).json({
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      });
    }
    if (processDetails.running) {
      return res.status(400).json({
        error: "Server must be stopped before wiping. Stop the server first.",
        code: ErrorCode.WIPE_SERVER_RUNNING,
      });
    }

    let confirm, createBackup;
    ({ targets, confirm, createBackup = true } = req.body || {});
    if (confirm !== true) {
      return res.status(400).json({ error: "Wipe requires confirm: true", code: ErrorCode.WIPE_CONFIRM_REQUIRED });
    }
    if (!Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({
        error:
          "targets must be a non-empty array of: map, players, world, accounts",
        code: ErrorCode.WIPE_TARGETS_REQUIRED,
      });
    }

    // "accounts" lives outside the save folder, so it is not part of the sweep
    const SAVE_TARGETS = ["map", "players", "world"];
    const allowedTargets = [...SAVE_TARGETS, "accounts"];
    const invalid = targets.filter((t) => !allowedTargets.includes(t));
    if (invalid.length > 0) {
      return res
        .status(400)
        .json({ error: `Invalid targets: ${invalid.join(", ")}`, code: ErrorCode.WIPE_INVALID_TARGETS });
    }

    const savePath = serverManager.savePath;
    serverName = serverManager.serverName || "servertest";
    if (!savePath) {
      return res.status(400).json({ error: "No zomboid data path configured", code: ErrorCode.WIPE_ZOMBOID_DATA_PATH_NOT_CONFIGURED });
    }
    if (/[/\\]/.test(serverName)) {
      return res.status(400).json({ error: "Invalid server name", code: ErrorCode.WIPE_INVALID_SERVER_NAME });
    }

    const saveDir = path.join(savePath, "Saves", "Multiplayer", serverName);
    if (!fs.existsSync(saveDir)) {
      return res
        .status(404)
        .json({ error: `Save directory not found: ${serverName}`, code: ErrorCode.WIPE_SAVE_DIRECTORY_NOT_FOUND });
    }

    // Path traversal safety
    const normalizedSaveDir = path.normalize(saveDir);
    if (normalizedSaveDir.includes("..")) {
      return res.status(400).json({ error: "Invalid path", code: ErrorCode.INVALID_PATH });
    }

    // Back up before wiping, fail CLOSED if the backup itself fails -- a wipe
    // that proceeds after a failed backup is strictly worse than no backup
    // option at all, because the operator now believes an undo exists. This
    // mirrors chunks.js's delete-chunks/delete-region convention (backup
    // first, propagate failure, never reach the deletion code below) but
    // uses backupService's streaming zip archiver rather than chunks.js's
    // per-file copy loop: a full world save can be many GB, and copying it
    // file-by-file the way chunks.js backs up a hand-picked chunk selection
    // has no place to report progress and no bound on how long the request
    // blocks. backupService.createBackup() already solves exactly this --
    // it's the same mechanism restoreBackup() uses for its own mandatory
    // pre-restore backup, streams to a .zip instead of materializing a
    // second copy of the save tree, reports progress over `io` the same way,
    // and is exempt from ad-hoc invention: it's the codebase's one existing
    // answer to "back up the whole world safely."
    if (createBackup) {
      const backupService = req.app.get("backupService");
      if (!backupService) {
        return res.status(500).json({
          error: "Backup service unavailable — refusing to wipe without a backup. Nothing was deleted.",
          code: ErrorCode.WIPE_BACKUP_FAILED,
        });
      }
      const io = req.app.get("io");
      backupResult = await backupService.createBackup({ isPreWipe: true, io });
      // 2026-08-26 bug hunt: createBackup can return success:true while
      // having silently skipped files -- a file that vanished mid-archive,
      // or (since 445c15a5, 2026-08-29) a symbolic link deliberately not
      // followed -- it surfaces that via skippedFiles rather than deciding
      // policy itself. This backup is about to become the ONLY copy of
      // whatever wipe is about to delete -- "mostly complete" is not a
      // safety net, so any skip is treated exactly like an outright backup
      // failure, same as the existing backup-or-abort posture below.
      const backupIncomplete =
        backupResult.success && (backupResult.skippedFiles?.length ?? 0) > 0;
      if (!backupResult.success || backupIncomplete) {
        const reason = backupIncomplete
          ? `it could not include ${backupResult.skippedFiles.length} file(s) (${backupResult.skippedFiles.join(", ")}) -- an incomplete pre-wipe backup is not a safety net`
          : backupResult.message;
        return res.status(500).json({
          error: `Wipe aborted: could not create a backup first (${reason}). Nothing was deleted.`,
          code: ErrorCode.WIPE_BACKUP_FAILED,
        });
      }

      // The account/whitelist database lives at <zomboidDataPath>/db/, a
      // sibling of Saves/Multiplayer -- outside the tree backupService just
      // zipped. When "accounts" is one of the selected targets, the backup
      // above does not actually cover what's about to be deleted unless we
      // also copy it. These files are small (a sqlite whitelist db, not
      // world data), so a direct copy -- the same shape chunks.js uses for
      // its own per-file backups -- is the right tool here, unlike the
      // world save above.
      if (targets.includes("accounts")) {
        try {
          const accountsBackupDir = path.join(
            await backupService.getBackupsPath(),
            `${serverName}_accounts_${Date.now()}`,
          );
          await fs.promises.mkdir(accountsBackupDir, { recursive: true });
          for (const suffix of ["", "-journal", "-wal", "-shm"]) {
            const dbFile = path.join(savePath, "db", `${serverName}.db${suffix}`);
            if (fs.existsSync(dbFile)) {
              await fs.promises.copyFile(
                dbFile,
                path.join(accountsBackupDir, `${serverName}.db${suffix}`),
              );
            }
          }
        } catch (e) {
          return res.status(500).json({
            error: `Wipe aborted: could not back up the accounts database (${e.message}). Nothing was deleted.`,
            code: ErrorCode.WIPE_BACKUP_FAILED,
          });
        }
      }
    }

    results = {};

    // Same directory/file lists as preview
    const MAP_DIRS = [
      "map",
      "chunkdata",
      "isoregiondata",
      "zpop",
      "apop",
      "metagrid",
      "map_visited_server",
    ];
    const WORLD_DIRS = ["radio"];
    const PLAYER_ROOT_FILES =
      /^(players\.db|players\.db-journal|vehicles\.db|vehicles\.db-journal|map_p\.bin|map_zone\.bin)$/i;
    const WORLD_ROOT_FILES =
      /^(WorldDictionary.*|map_meta\.bin|map_t\.bin|map_worldgen\.bin|map_animals\.bin|map_basements\.bin|entity_data\.bin|global_mod_data\.bin|reanimated\.bin|iTrack\.bin|gos_.*\.bin|id_manager_data\.bin|important_area_data\.bin|z_outfits\.bin|recorded_media\.bin|servermap_symbols\.bin|map_sand\.bin|hidden_authors\.ini|erosion\.ini)$/i;

    try {
      if (targets.includes("map")) {
        let deletedCount = 0;
        for (const dirName of MAP_DIRS) {
          const dir = path.join(saveDir, dirName);
          if (fs.existsSync(dir)) {
            log.warn(`WIPE: Deleting ${dirName}/ at ${dir}`);
            fs.rmSync(dir, { recursive: true, force: true });
            deletedCount++;
          }
        }
        results.map =
          deletedCount > 0
            ? `deleted ${deletedCount} directories`
            : "not found";
        // chunks.js's /chunks and /stats routes cache a scan of this save's
        // map/ folder for a few seconds (see getMapFolderScan()'s comment).
        // This wipe just deleted it out from under that cache -- without
        // this, a page reload within the TTL window would show chunk counts
        // for a map/ folder that no longer exists.
        invalidateMapFolderScan(path.join(saveDir, "map"));
      }

      if (targets.includes("players")) {
        let deletedCount = 0;
        // No inner try/catch here (bug hunt 2026-08-31): a throw must reach
        // the outer catch below, same as map/leftovers/accounts already do,
        // so a real unlink failure (e.g. a lingering AV/backup file lock
        // right after the pre-wipe stop) produces an honest
        // WIPE_PARTIAL_FAILURE instead of being swallowed into the same
        // "not found" string a genuinely-empty directory reports -- those
        // two outcomes must not look identical to the caller.
        const rootEntries = fs.readdirSync(saveDir, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (!entry.isDirectory() && PLAYER_ROOT_FILES.test(entry.name)) {
            log.warn(`WIPE: Deleting player file ${entry.name}`);
            fs.unlinkSync(path.join(saveDir, entry.name));
            deletedCount++;
          }
        }
        results.players =
          deletedCount > 0 ? `deleted ${deletedCount} files` : "not found";
      }

      if (targets.includes("world")) {
        let deletedCount = 0;
        // Delete world directories
        for (const dirName of WORLD_DIRS) {
          const dir = path.join(saveDir, dirName);
          if (fs.existsSync(dir)) {
            log.warn(`WIPE: Deleting ${dirName}/ at ${dir}`);
            fs.rmSync(dir, { recursive: true, force: true });
            deletedCount++;
          }
        }
        // Delete world root files. Same no-inner-catch reasoning as the
        // players block above.
        const rootEntries = fs.readdirSync(saveDir, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (!entry.isDirectory() && WORLD_ROOT_FILES.test(entry.name)) {
            log.warn(`WIPE: Deleting world file ${entry.name}`);
            fs.unlinkSync(path.join(saveDir, entry.name));
            deletedCount++;
          }
        }
        results.world =
          deletedCount > 0 ? `deleted ${deletedCount} items` : "not found";
      }

      // Selecting every target means a total wipe: remove whatever the
      // per-target lists don't recognise so nothing from the old world survives.
      if (SAVE_TARGETS.every((t) => targets.includes(t))) {
        let leftovers = 0;
        for (const entry of fs.readdirSync(saveDir, { withFileTypes: true })) {
          log.warn(`WIPE: Deleting leftover ${entry.name}`);
          fs.rmSync(path.join(saveDir, entry.name), {
            recursive: true,
            force: true,
          });
          leftovers++;
        }
        results.leftovers =
          leftovers > 0 ? `deleted ${leftovers} remaining items` : "none";
      }

      if (targets.includes("accounts")) {
        let deletedCount = 0;
        for (const suffix of ["", "-journal", "-wal", "-shm"]) {
          const dbFile = path.join(savePath, "db", `${serverName}.db${suffix}`);
          if (fs.existsSync(dbFile)) {
            log.warn(`WIPE: Deleting account database ${dbFile}`);
            fs.rmSync(dbFile, { force: true });
            deletedCount++;
          }
        }
        results.accounts =
          deletedCount > 0 ? `deleted ${deletedCount} files` : "not found";
      }
    } finally {
      wipeInProgress = false;
    }

    log.warn(
      `WIPE COMPLETE: server=${serverName}, targets=${targets.join(",")}, results=${JSON.stringify(results)}`,
    );
    await logServerEventBestEffort("wipe", `Server wiped: ${targets.join(", ")}`, {
      targets,
      results,
    });

    res.json({
      success: true,
      serverName,
      targets,
      results,
      backupCreated: !!backupResult?.success,
      backupName: backupResult?.backup?.name || null,
      message: `Server "${serverName}" wiped: ${targets.join(", ")}`,
    });
  } catch (error) {
    log.error(`Wipe failed: ${error.message}`);
    // 2026-08-26, partial-failure-state hunt: `results` may already hold
    // completed targets from before this throw (map/leftovers/accounts
    // deletion isn't individually try/caught the way players/world's
    // root-file loops are) -- a bare {error} here told the operator
    // neither what actually got deleted nor that a pre-wipe backup exists
    // to fall back to. Both are already in scope from earlier in this
    // handler; surfacing them costs nothing and answers the two questions
    // that actually matter after a failed destructive operation.
    log.warn(`WIPE PARTIAL: server=${serverName || "unknown"}, results=${JSON.stringify(results)}`);
    await logServerEventBestEffort(
      "wipe",
      `Server wipe FAILED partway through: ${error.message}`,
      { targets, results, error: error.message },
    );
    res.status(500).json({
      error: `Wipe failed partway through (${sanitizeError(error.message)}). Some of the selected targets may be only partially deleted -- check the results for what completed before the failure.`,
      code: ErrorCode.WIPE_PARTIAL_FAILURE,
      params: { reason: sanitizeError(error.message) },
      results,
      backupCreated: !!backupResult?.success,
      backupName: backupResult?.backup?.name || null,
    });
  } finally {
    wipeInProgress = false;
    lifecycleLock.release();
  }
});

export default router;
