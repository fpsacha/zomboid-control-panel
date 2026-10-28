import express from "express";
import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.js";
const log = createLogger("API:Servers");
import {
  sanitizeError,
  sanitizeErrorParams,
  sanitizeServerResponse,
  sanitizeServerResponseList,
  isMaskedSecret,
} from "../utils/sanitize.js";
import { resolveEnvRconHost, testRconConnection } from "../services/rcon.js";
import {
  rconPasswordCannotBeStoredInIni,
  rconPasswordUnsupportedCharsBody,
} from "../utils/rconPassword.js";
import {
  getServers,
  getServer,
  getActiveServer,
  createServer,
  updateServer,
  deleteServer,
  setActiveServer,
  getAllSettings,
  setSetting,
} from "../database/init.js";
import { isRemoteConfigConfigured } from "../services/remoteConfigFiles.js";
import { requireAnyPermission, requirePermission } from "../services/permissions.js";
import {
  acquireLifecycleLock,
  getLifecycleState,
  lifecycleInProgressResponse,
} from "../services/lifecycleCoordinator.js";
import {
  findNoSteamWorkshopConflicts,
  launchLooksNoSteam,
  newProfileConflictsWithWorkshop,
  noSteamSiblingConflictResponse,
  noSteamWorkshopConflictResponse,
  reconcileBridge,
} from "../services/bridgeDelivery.js";
import { refreshWorkshopChecker } from "../services/modChecker.js";
import {
  parseBoundedInteger,
  parseClampedInteger,
} from "../utils/queryNumbers.js";
import {
  memoryMinExceedsMax,
  memoryMinExceedsMaxFields,
  normalizeMemoryGb,
  normalizeMinMemoryGb,
} from "../utils/memory.js";
import { GAME_PORT_MAX, applyUpnpToIni } from "./server.js";
import { hostMemoryLimitBytes, readProcessesMemory } from "../utils/processMemory.js";
import {
  resolveOtherServer,
  restartOtherServer,
  startOtherServer,
  stopOtherServer,
} from "../services/otherServerLifecycle.js";
import { codedActionResultFields, emitActionResult } from "./scheduler.js";
import { resolveDockerHostSignal } from "../services/managedContainer.js";
import { resolveProvider } from "../utils/serverStatusModel.js";
import {
  findLaunchTargetRefusal,
  launchFolderRefusedError,
  launchTargetOf,
  launchTargetRefusedError,
  resolveLaunchMode,
  ServerManager,
  scanLeavesServerUnknown,
  scoreServerProcessOwnership,
  untrustedLaunchFolderReason,
} from "../services/serverManager.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { canSeeHostPaths, hideHostPaths } from "../utils/hostPathView.js";
import { canSeeRconTarget, withoutRconTarget } from "../utils/rconTargetView.js";
import { serverConfigDirOf, serverConfigPathIsConfined, serverFolderProblem } from "../utils/serverConfigPath.js";
import { checkZomboidDataPath } from "../services/zomboidDataPath.js";
import { adminPasswordStartScriptRefusal } from "../services/startScriptValues.js";
import {
  buildLifecycleTemplate,
  createLinuxServiceLifecycle,
  getLinuxLifecycleCapabilities,
  isManagedLifecycleProvider,
  LIFECYCLE_PROVIDERS,
} from "../services/linuxServiceLifecycle.js";

const router = express.Router();
const RCON_HOST_REGEX = /^[a-zA-Z0-9.-]{1,255}$/;
const RCON_PASSWORD_MAX_LENGTH = 256;

// serverName is interpolated into filesystem paths (server-files, backups,
// chunks) as `${serverName}.ini` etc. — reject anything but a plain,
// non-traversal-capable name up front instead of relying on every
// downstream path-building call site to re-validate it.
const SERVER_NAME_REGEX =
  /^[a-zA-Z0-9_-][a-zA-Z0-9_\- ]*[a-zA-Z0-9_-]$|^[a-zA-Z0-9_-]$/;

function isValidServerName(value) {
  return typeof value === "string" && SERVER_NAME_REGEX.test(value);
}

function isValidDockerContainerRef(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
}

const INSTALL_PATH_MAX_LENGTH = 1024;

// HARDEN (operator ruling 2026-08-27, card
// custom-launcher-as-a-real-supported-mode-not-an-accident): neither
// installPath nor serverPath was validated at all before this, despite
// silently controlling MANAGED vs CUSTOM LAUNCHER mode (serverManager.js's
// resolveLaunchMode() -- the same predicate this calls, so a saved value's
// shape and the mode it will actually resolve to at load time can never
// disagree). A launcher-shaped value (.bat/.sh/.exe) is accepted without
// requiring it to exist yet -- the operator may be configuring this before
// the file is in place, matching installPath's own existing not-yet-
// installed allowance for a fresh, not-yet-downloaded server. A
// directory-shaped value must actually BE a directory if something already
// exists at that path; a value that already exists as a plain file with no
// recognized launcher extension is rejected outright -- that combination
// (file-shaped, unrecognized) is exactly the unvalidated case that used to
// silently break regeneration (server.js's refreshLaunchTargetBeforeStart()
// would join a filename onto a file, not a directory).
function validateInstallPathShape(value) {
  if (typeof value !== "string" || !value.trim()) {
    return { valid: false, error: "Install path must be a non-empty string" };
  }
  if (value.length > INSTALL_PATH_MAX_LENGTH) {
    return { valid: false, error: "Install path is too long" };
  }
  if (/[\x00-\x1f]/.test(value)) {
    return { valid: false, error: "Install path contains invalid characters" };
  }
  const { mode } = resolveLaunchMode({ installPath: value });
  // The launch folder rule startServer() enforces (a Workshop download
  // folder or a network share is anyone's files): refused when saved too,
  // for every role, so the record never holds a server that can't start.
  const untrustedFolder = untrustedLaunchFolderReason(
    mode === "custom" ? path.dirname(value) : value,
  );
  if (untrustedFolder) {
    const error = launchFolderRefusedError(untrustedFolder);
    return { valid: false, error: error.message, code: error.code };
  }
  if (mode === "custom") {
    return { valid: true, mode };
  }
  try {
    if (fs.existsSync(value) && !fs.statSync(value).isDirectory()) {
      return {
        valid: false,
        error:
          "Install path exists but is not a directory. If this is meant to point at a custom launcher script, its filename must end in .bat, .sh, or .exe.",
      };
    }
  } catch {
    // Unreadable (permissions, a transient mount hiccup) -- don't hard-fail
    // a save over a stat error; a genuinely unusable path still surfaces a
    // real error at install/start time.
  }
  return { valid: true, mode };
}

// FILES-2: a server's config folder must resolve to <zomboidDataPath>/Server
// or a folder inside it -- see utils/serverConfigPath.js. Re-exported for
// the tests that import it from here.
export { serverConfigPathIsConfined };

function serverConfigPathRefusal() {
  return {
    error:
      "The server config folder must be the Server folder inside this server's Zomboid data folder, or a folder inside it. Set the Zomboid data folder first, or leave the config folder empty.",
    code: ErrorCode.SERVER_CONFIG_PATH_OUTSIDE_DATA,
  };
}

// Run a requirePermission() check outside of route-level middleware, for a
// capability that only applies to one branch of a handler (importIniFrom
// below needs servers.discover -- the same capability that gates /auto-scan
// and /detect's own filesystem reads -- in addition to this route's regular
// servers.manage gate). Mirrors routes/scheduler.js's identical helper.
async function requireCapabilityInline(capability, req, res) {
  let passed = false;
  await requirePermission(capability)(req, res, () => {
    passed = true;
  });
  return passed;
}

// SECURITY (2026-10-04, RCE-STARTCMD): a server's launch target -- its
// custom start command, or an installPath/serverPath naming a launcher
// script (resolveLaunchMode()) -- is a program the panel runs on this
// computer as its own account at the next start. servers.manage was enough
// to set either, so a technician could save `powershell.exe -enc <payload>`
// and press Start (server.control). Changing one now takes files.manage,
// the admin-only-by-default capability that can already change the game
// files a server runs, so no new capability. The install path of a server
// that has one (before or after the edit) counts too: a relative start
// command is resolved against it, and replacing a launcher script replaces
// what runs. Untouched values pass, since the edit dialog sends the whole
// record back.
function launchIsOperatorDefined(server) {
  return (
    Boolean(String(server?.startCommand ?? "").trim()) ||
    resolveLaunchMode(server).mode === "custom"
  );
}

function isLauncherShaped(value) {
  return (
    typeof value === "string" &&
    resolveLaunchMode({ installPath: value }).mode === "custom"
  );
}

export function changesLaunchTarget(stored, updates) {
  const differs = (key) =>
    updates[key] !== undefined &&
    String(updates[key] ?? "") !== String(stored?.[key] ?? "");
  if (differs("startCommand")) return true;
  const after = { ...stored, ...updates };
  return ["installPath", "serverPath"].some(
    (key) =>
      differs(key) &&
      (isLauncherShaped(updates[key]) ||
        launchIsOperatorDefined(stored) ||
        launchIsOperatorDefined(after)),
  );
}

// requirePermission() itself decides, so the role resolves the same
// fail-closed way, but the refusal is this route's own coded one.
async function holdsCapability(capability, req) {
  let passed = false;
  const probe = { status: () => probe, json: () => probe };
  await requirePermission(capability)(req, probe, () => {
    passed = true;
  });
  return passed;
}

// Sends the response and returns true when the launch target `server`
// would end up with may not be saved by this caller: 403 without
// files.manage, 400 when it would be refused at start anyway
// (findLaunchTargetRefusal()). A remote profile is never launched here.
async function refuseLaunchTargetChange(req, res, server) {
  if (!(await holdsCapability("files.manage", req))) {
    res.status(403).json({
      error:
        "Changing a server's start command or launcher script requires the files.manage permission, which this role doesn't have: whatever it names runs on this computer when the server starts. Ask an admin to make this change.",
      code: ErrorCode.SERVER_LAUNCH_TARGET_ADMIN_ONLY,
    });
    return true;
  }
  const refusal = server.isRemote
    ? null
    : findLaunchTargetRefusal(launchTargetOf(server));
  if (refusal) {
    const error = launchTargetRefusedError(refusal);
    res.status(400).json({
      error: error.message,
      code: error.code,
      params: error.params,
    });
    return true;
  }
  return false;
}

// SECURITY (2026-10-20, access-control audit): a server's RCON host, port
// and password belong to server.configure, as they do everywhere else
// (routes/config.js's SETTINGS_KEY_CAPABILITY, server.js's /configure-rcon).
// With servers.manage alone a role could point the stored password at a
// host it runs, and GET /rcon-status (or, for the active server, the
// reconnect after the save) sent it there. An edit that changes any of the
// three now needs server.configure, and a new host or port needs the
// password entered again: the stored one is never sent somewhere it was not
// saved for. Judged against the stored values, since the edit dialog sends
// the whole record back on every save.
function normalizedRconHost(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function rconConnectionChanges(stored, updates) {
  const host =
    updates.rconHost !== undefined &&
    normalizedRconHost(updates.rconHost) !== normalizedRconHost(stored?.rconHost);
  const port =
    updates.rconPort !== undefined &&
    parseBoundedInteger(updates.rconPort, null, 1, 65535) !==
      parseBoundedInteger(stored?.rconPort, null, 1, 65535);
  const password =
    updates.rconPassword !== undefined &&
    String(updates.rconPassword) !== String(stored?.rconPassword ?? "");
  return { host, port, password, any: host || port || password };
}

// The hosts an imported ini's own server answers on: this machine, or the
// RCON_HOST the operator configured for a separate game container.
function rconHostIsThisMachine(host) {
  const value = normalizedRconHost(host);
  return (
    // No host at all is refused later as a missing field.
    value === "" ||
    value === "localhost" ||
    /^127(\.\d{1,3}){3}$/.test(value) ||
    value === normalizedRconHost(resolveEnvRconHost())
  );
}

function rconChangeRefusal() {
  return {
    error:
      "Changing a server's RCON host, port or password requires the server.configure permission, which this role doesn't have. Ask an admin to make this change.",
    code: ErrorCode.SERVER_RCON_CHANGE_REQUIRES_CONFIGURE,
  };
}

function rconPasswordRequiredRefusal() {
  return {
    error:
      "Enter the RCON password again to change the RCON host or port: the saved password is only sent to the host and port it was saved for.",
    code: ErrorCode.SERVER_RCON_PASSWORD_REQUIRED_FOR_NEW_TARGET,
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function refreshWorkshopCheckerIfAvailable(req) {
  const modChecker = req.app.get("modChecker");
  if (!modChecker) return;

  try {
    await refreshWorkshopChecker(modChecker);
  } catch (error) {
    // Server profile changes must remain saveable if workshop probing fails.
    log.warn(`Workshop checker refresh failed: ${error.message}`);
  }
}

// Helper: Parse INI file
function parseIni(content) {
  const result = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";"))
      continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      result[key] = value;
    }
  }
  return result;
}

export function parseDiscoveredPort(value, fallback, max = 65535) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") return null;
  if (value.trim() === "") return fallback;
  // Ports are unsigned. parseBoundedInteger alone would accept an explicit
  // "+27015" (it's a general integer parser reused elsewhere for values
  // that legitimately can be negative), but mountDiscovery.js's parsePort
  // -- the other reader of this same ini field, used by
  // create-from-discovery -- has always enforced digits-only. Without this
  // check the same ini line was a valid server on one route and an invalid
  // one on the other.
  if (!/^\d+$/.test(value.trim())) return null;
  return parseBoundedInteger(value, null, 1, max);
}

// Helper: Recursively scan for PZ server paths (max depth 3)
function scanForPzPaths(rootPath, maxDepth = 3) {
  const results = {
    installPaths: [], // Folders containing PZ server startup scripts
    dataPaths: [], // Folders containing Server/ subfolder with .ini files
    customBatFiles: [], // Custom startup scripts found
  };

  function scan(currentPath, depth) {
    if (depth > maxDepth) return;

    try {
      if (
        !fs.existsSync(currentPath) ||
        !fs.statSync(currentPath).isDirectory()
      )
        return;

      const items = fs.readdirSync(currentPath);

      // Check if this is an install path (has startup script or jre64)
      if (
        items.includes("StartServer64.bat") ||
        items.includes("StartServer64_nosteam.bat") ||
        items.includes("start-server.sh") ||
        (items.includes("jre64") && items.includes("ProjectZomboid64.json"))
      ) {
        results.installPaths.push(currentPath);

        // Also look for custom startup scripts
        const customScripts = items.filter(
          (f) =>
            (f.startsWith("StartServer_") && f.endsWith(".bat")) ||
            (f.startsWith("StartServer64_") &&
              f.endsWith(".bat") &&
              f !== "StartServer64_nosteam.bat") ||
            (f.startsWith("StartServer_") && f.endsWith(".sh")) ||
            (f.startsWith("start-server-") && f.endsWith(".sh")),
        );
        for (const script of customScripts) {
          // Extract server name from script file name (e.g., StartServer_DoomerZ.bat -> DoomerZ)
          let serverName = script
            .replace(/^StartServer(64)?_/, "")
            .replace(/^start-server-/, "")
            .replace(/\.(bat|sh)$/, "");
          results.customBatFiles.push({
            path: path.join(currentPath, script),
            folder: currentPath,
            fileName: script,
            serverName: serverName,
          });
        }
      }

      // Check if this is a data path (has Server/ subfolder with .ini files)
      if (items.includes("Server")) {
        const serverPath = path.join(currentPath, "Server");
        if (
          fs.existsSync(serverPath) &&
          fs.statSync(serverPath).isDirectory()
        ) {
          const serverFiles = fs.readdirSync(serverPath);
          // Look for .ini files that don't end with known suffixes like _SandboxVars, _spawnpoints, _spawnregions
          const hasIni = serverFiles.some(
            (f) =>
              f.endsWith(".ini") &&
              !f.endsWith("_SandboxVars.ini") &&
              !f.endsWith("_spawnpoints.ini") &&
              !f.endsWith("_spawnregions.ini"),
          );
          if (hasIni) {
            results.dataPaths.push(currentPath);
          }
        }
      }

      // Recurse into subdirectories (skip common non-relevant folders)
      const skipFolders = [
        "node_modules",
        ".git",
        "logs",
        "Logs",
        "cache",
        "Saves",
        "mods",
        "steamapps",
        "depotcache",
        "appcache",
        "userdata",
        "media",
      ];
      for (const item of items) {
        if (skipFolders.includes(item)) continue;
        const itemPath = path.join(currentPath, item);
        try {
          if (fs.statSync(itemPath).isDirectory()) {
            scan(itemPath, depth + 1);
          }
        } catch (e) {
          log.debug(`Skipping inaccessible path ${itemPath}: ${e.message}`);
        }
      }
    } catch (e) {
      log.debug(`Skipping inaccessible folder ${currentPath}: ${e.message}`);
    }
  }

  scan(rootPath, 0);
  return results;
}

// Auto-scan a folder to find PZ server install paths and data paths.
// Reads arbitrary local server .ini files -- admin-only, same sensitivity
// tier as chunks delete / panel-bridge command execution -- but the RCON
// password read off each ini is never put on the wire (hasRcon says
// whether one is set). POST / re-reads it server-side at creation time via
// importIniFrom, keyed off dataPath+serverName, instead of round-tripping
// the real value through the browser.
//
// 2026-08-27: this route's local parseIni() duplicates
// services/mountDiscovery.js's readServerIniSettings -- checked, not just
// filed. The two line-parsing loops are behaviourally identical (11
// fixtures: duplicate key, inline comment, section header, blank value,
// CRLF, a value containing "=", leading whitespace, both comment styles,
// eqIndex===0, lone-CR -- no divergence, not merged, since a refactor with
// no behavioural difference is pure risk). The paired port validators
// DID diverge -- parseDiscoveredPort (below) accepted "RCONPort=+27015"
// while mountDiscovery.js's parsePort (digits-only) rejected it, so the
// same ini line was a valid server on this route and not on
// create-from-discovery. Fixed by making parseDiscoveredPort digits-only
// too; see server/tests/serversRoute.test.js.
router.post("/auto-scan", requirePermission("servers.discover"), async (req, res) => {
  try {
    const { scanPath, maxDepth = 3 } = req.body || {};

    if (!scanPath) {
      return res.status(400).json({ error: "Scan path is required" });
    }

    // Validate scanPath - must be an absolute path
    if (typeof scanPath !== "string" || scanPath.length > 500) {
      return res.status(400).json({ error: "Invalid path format" });
    }

    // Must check isAbsolute() on the raw input: path.resolve() always
    // returns an absolute path (resolved against cwd), so checking it after
    // resolving would never reject anything and silently accepted relative
    // paths as if they'd been rejected.
    if (!path.isAbsolute(scanPath)) {
      return res.status(400).json({ error: "Must be an absolute path" });
    }
    const resolvedPath = path.resolve(scanPath);

    // Block scanning root paths directly — require at least one subfolder
    const isRootPath =
      process.platform === "win32"
        ? /^[A-Za-z]:[\\/]?$/.test(resolvedPath)
        : resolvedPath === "/";
    if (isRootPath) {
      return res
        .status(400)
        .json({
          error: "Cannot scan a root path. Please specify a subfolder.",
        });
    }

    if (!fs.existsSync(resolvedPath)) {
      return res.status(400).json({ error: "Path does not exist" });
    }

    log.info(`Auto-scanning for PZ servers in: ${resolvedPath}`);

    const clampedDepth = parseClampedInteger(maxDepth, 3, 1, 3);
    const results = scanForPzPaths(resolvedPath, clampedDepth);

    // For each data path, detect the server configs
    const detectedConfigs = [];
    for (const dataPath of results.dataPaths) {
      const serverConfigPath = path.join(dataPath, "Server");
      const files = fs.readdirSync(serverConfigPath);
      // Filter for server .ini files (exclude _SandboxVars, _spawnpoints, _spawnregions)
      const iniFiles = files.filter(
        (f) =>
          f.endsWith(".ini") &&
          !f.endsWith("_SandboxVars.ini") &&
          !f.endsWith("_spawnpoints.ini") &&
          !f.endsWith("_spawnregions.ini"),
      );

      for (const iniFile of iniFiles) {
        const serverName = iniFile.replace(".ini", "");
        const iniPath = path.join(serverConfigPath, iniFile);

        try {
          const content = fs
            .readFileSync(iniPath, "utf-8")
            .replace(/\r\n/g, "\n");
          const settings = parseIni(content);
          const rconPort = parseDiscoveredPort(settings.RCONPort, 27015);
          const serverPort = parseDiscoveredPort(settings.DefaultPort, 16261, GAME_PORT_MAX);
          if (rconPort === null || serverPort === null) {
            throw new Error("RCONPort or DefaultPort is invalid");
          }

          // Try to find a matching custom bat file for this server
          const matchingBat = results.customBatFiles.find(
            (bat) =>
              serverName.toLowerCase().includes(bat.serverName.toLowerCase()) ||
              bat.serverName.toLowerCase().includes(serverName.toLowerCase()),
          );

          detectedConfigs.push({
            dataPath,
            serverConfigPath,
            serverName,
            iniFile,
            rconPort,
            serverPort,
            publicName: settings.PublicName || serverName,
            hasRcon: !!settings.RCONPassword,
            // New: matched bat file info
            matchedBatFile: matchingBat ? matchingBat.path : null,
            matchedInstallPath: matchingBat ? matchingBat.folder : null,
          });
        } catch (err) {
          log.warn(`Failed to parse ${iniFile}: ${err.message}`);
        }
      }
    }

    log.info(
      `Found ${results.installPaths.length} install paths, ${results.dataPaths.length} data paths, ${detectedConfigs.length} server configs, ${results.customBatFiles.length} custom bat files`,
    );

    res.json({
      scanPath,
      installPaths: results.installPaths,
      dataPaths: results.dataPaths,
      customBatFiles: results.customBatFiles,
      detectedConfigs,
    });
  } catch (error) {
    log.error(`Failed to auto-scan: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Detect server settings from data path (folder containing Server/, Saves/, Logs/)
// Same as /auto-scan: reads RCON passwords straight off disk but never
// returns them -- see the comment above /auto-scan.
router.post("/detect", requirePermission("servers.discover"), async (req, res) => {
  try {
    const { dataPath, installPath } = req.body || {};
    log.info(
      `POST /detect: dataPath=${dataPath}, installPath=${installPath || "auto"}`,
    );

    if (!dataPath) {
      return res.status(400).json({ error: "Data path is required" });
    }

    // Validate path format
    if (typeof dataPath !== "string" || dataPath.length > 500) {
      return res.status(400).json({ error: "Invalid path format" });
    }

    // Must check isAbsolute() on the raw input: path.resolve() always
    // returns an absolute path (resolved against cwd), so checking it after
    // resolving would never reject anything and silently accepted relative
    // paths as if they'd been rejected.
    if (!path.isAbsolute(dataPath)) {
      return res.status(400).json({ error: "Must be an absolute path" });
    }
    const resolvedData = path.resolve(dataPath);

    // Verify data path exists
    if (!fs.existsSync(resolvedData)) {
      return res.status(400).json({ error: "Data path does not exist" });
    }

    // Check if this is a valid Zomboid data folder (should have Server subfolder)
    const serverConfigPath = path.join(resolvedData, "Server");
    if (!fs.existsSync(serverConfigPath)) {
      return res
        .status(400)
        .json({
          error: "Not a valid Zomboid data folder (no Server subfolder found)",
        });
    }

    // Validate installPath if provided
    let resolvedInstall = null;
    let hasNoSteam = false;
    let validInstallPath = false;
    if (installPath) {
      if (typeof installPath !== "string" || installPath.length > 500) {
        return res.status(400).json({ error: "Invalid install path format" });
      }
      if (!path.isAbsolute(installPath)) {
        return res.status(400).json({ error: "Install path must be absolute" });
      }
      resolvedInstall = path.resolve(installPath);
      if (fs.existsSync(resolvedInstall)) {
        const startBat = path.join(resolvedInstall, "StartServer64.bat");
        const startBatNoSteam = path.join(
          resolvedInstall,
          "StartServer64_nosteam.bat",
        );
        const startSh = path.join(resolvedInstall, "start-server.sh");
        validInstallPath =
          fs.existsSync(startBat) ||
          fs.existsSync(startBatNoSteam) ||
          fs.existsSync(startSh);
        hasNoSteam = fs.existsSync(startBatNoSteam);
      }
    }

    // Find server INI files
    const detectedServers = [];

    if (fs.existsSync(serverConfigPath)) {
      const files = fs.readdirSync(serverConfigPath);
      // Filter for server .ini files (exclude _SandboxVars, _spawnpoints, _spawnregions)
      const iniFiles = files.filter(
        (f) =>
          f.endsWith(".ini") &&
          !f.endsWith("_SandboxVars.ini") &&
          !f.endsWith("_spawnpoints.ini") &&
          !f.endsWith("_spawnregions.ini"),
      );

      for (const iniFile of iniFiles) {
        const serverName = iniFile.replace(".ini", "");
        const iniPath = path.join(serverConfigPath, iniFile);

        try {
          const content = fs
            .readFileSync(iniPath, "utf-8")
            .replace(/\r\n/g, "\n");
          const settings = parseIni(content);
          const rconPort = parseDiscoveredPort(settings.RCONPort, 27015);
          const serverPort = parseDiscoveredPort(settings.DefaultPort, 16261, GAME_PORT_MAX);
          if (rconPort === null || serverPort === null) {
            throw new Error("RCONPort or DefaultPort is invalid");
          }

          detectedServers.push({
            serverName,
            iniFile,
            rconPort,
            serverPort,
            publicName: settings.PublicName || serverName,
            hasRcon: !!settings.RCONPassword,
          });
        } catch (err) {
          log.warn(`Failed to parse ${iniFile}: ${err.message}`);
        }
      }
    }

    res.json({
      valid: true,
      dataPath: resolvedData,
      serverConfigPath,
      installPath: resolvedInstall || "",
      validInstallPath,
      hasNoSteam,
      detectedServers,
    });
  } catch (error) {
    log.error(`Failed to detect server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Shared by GET / and GET /active so the two routes can't drift on what
// "remote config configured" means -- the client's only consumer of this
// field (Layout.tsx's nav) reads it off the list from GET /, not GET
// /active, so this must actually run in both places, not just one.
// isRemoteConfigConfigured() only checks already-loaded settings fields
// (no I/O), so computing it per row here costs nothing beyond the one
// getAllSettings() call already made for the whole list.
function computeRemoteConfigConfigured(server, settings) {
  return server.isRemote ? isRemoteConfigConfigured(settings) : false;
}

// Get all servers
router.get("/", async (req, res) => {
  try {
    const servers = await getServers();
    const settings = await getAllSettings();
    // Host folders only for a role that sets them up (utils/hostPathView.js),
    // the RCON host and port only for one that works with RCON
    // (utils/rconTargetView.js).
    const showPaths = await canSeeHostPaths(req.user);
    const showRconTarget = await canSeeRconTarget(req.user);
    const withRemoteConfig = servers.map((server) => {
      const view = {
        ...server,
        remoteConfigConfigured: computeRemoteConfigConfigured(server, settings),
        // SECURITY (2026-10-05, PT3): why the panel won't use this server's
        // folders, if it won't (utils/serverConfigPath.js's
        // serverFolderProblem()) -- for the Servers page's warning, so an
        // operator whose data folder no longer passes after the update
        // sees what to set where it is set. A code and text, no folder.
        folderProblem: serverFolderProblem(server),
      };
      const pathView = showPaths ? view : hideHostPaths(view);
      return showRconTarget ? pathView : withoutRconTarget(pathView);
    });
    res.json({
      servers: sanitizeServerResponseList(withRemoteConfig),
      lifecycleCapabilities: getLinuxLifecycleCapabilities(),
    });
  } catch (error) {
    log.error(`Failed to get servers: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// SECURITY (2026-10-04, SDOS-4): GET /status has no capability gate (every
// role's pages poll it), and each call ran its own host-wide process scan --
// on Windows a PowerShell Win32_Process query -- plus, when that scan
// couldn't place the active server, the active server's own scan. A burst
// of calls from any signed-in role started that many PowerShell processes
// at once (24 alive together in the verifier's run). Calls now share them:
// one that arrives while a scan runs waits for that scan, and a finished
// scan's answer serves STATUS_SCAN_REUSE_MS more calls. Keyed on the app's
// shared serverManager, so every app (and every test's fake one) keeps its
// own; without one there is nothing to share and each call scans.
const STATUS_SCAN_REUSE_MS = 2000;
const statusScans = new WeakMap();

export function sharedStatusScan(owner, key, run) {
  if (!owner || typeof owner !== "object") return run();
  let scans = statusScans.get(owner);
  if (!scans) {
    scans = new Map();
    statusScans.set(owner, scans);
  }
  const now = Date.now();
  const reusable = (entry) =>
    entry.settledAt === null || now - entry.settledAt < STATUS_SCAN_REUSE_MS;
  const cached = scans.get(key);
  if (cached && reusable(cached)) return cached.promise;
  for (const [otherKey, entry] of scans) {
    if (!reusable(entry)) scans.delete(otherKey);
  }
  const entry = { settledAt: null, promise: null };
  entry.promise = Promise.resolve()
    .then(run)
    .then(
      (result) => {
        entry.settledAt = Date.now();
        return result;
      },
      (error) => {
        if (scans.get(key) === entry) scans.delete(key);
        throw error;
      },
    );
  scans.set(key, entry);
  return entry.promise;
}

// Per-server running status. Scans the host once for all PZ server processes
// and attributes each match to a configured server via the same
// scoreServerProcessOwnership() rules serverManager.js uses for its own
// server (-servername/-cachedir first, install path only as a fallback).
// Servers with no matching process are reported as not running -- or as
// unknown when Windows also lists processes the panel can't read.
// The rows behind GET /status, and the server watch's view of every server
// (services/serverWatch.js reads them on its own timer, sharing the scan
// with any page polling this route at the same moment). `memory` adds each
// running row's resident memory (memoryBytes), for the Dashboard's list.
export async function readServerStatuses(serverManager, { memory = false } = {}) {
  const servers = await getServers();
  const activeServer = await getActiveServer();
  const activeId = activeServer?.id || null;

  // A throwaway instance, not the shared `serverManager` singleton:
  // scanHostForServerProcesses() (via the private scan it wraps) writes
  // `this.isRunning` as a side effect, and that value means something
  // different here -- "some PZ process exists somewhere on the host" --
  // than what the shared instance's cached isRunning is supposed to mean
  // ("MY configured server is running"), which server.js's start/stop
  // polling and the fallback below both still read.
  let matched = [];
  let hostScan = null;
  let detectionError = null;
  try {
    const scan = await sharedStatusScan(serverManager, "host", () =>
      new ServerManager().scanHostForServerProcesses(),
    );
    hostScan = scan;
    matched = Array.isArray(scan?.matched) ? scan.matched : [];
    if (scan?.scanFailed) {
      detectionError = scan.error || "Process detection failed";
    }
  } catch (err) {
    detectionError = err.message;
    log.debug(`Per-server status detection failed: ${err.message}`);
  }

  // Each running row's start time for the process that row was attributed
  // (for a managed lifecycle, systemd's MainPID or OpenRC's supervised
  // child -- see LinuxServiceLifecycle.status()) -- through the same
  // serverManager.startTimeOf() the active server's resolveStartTime()
  // uses, so a card and the dashboard can't disagree: on Windows it rides
  // on the scan row above, elsewhere it is two /proc reads. ISO string, or
  // null when unknown (stopped, unverifiable, or the OS couldn't say).
  const startedAtFor = async (entry, running) => {
    if (!running || !entry?.pid || typeof serverManager?.startTimeOf !== "function") {
      return null;
    }
    const startedMs = await serverManager.startTimeOf(entry);
    return startedMs === null ? null : new Date(startedMs).toISOString();
  };

  const statuses = await Promise.all(servers.map(async (server) => {
    // A server run by a Docker container: what Docker says, as for the
    // active server's own status (utils/serverStatus.js). The process scan
    // never sees a game running in another container, so every such row read
    // as stopped: no Stop on the Dashboard's list, and the server watch never
    // saw it go down.
    const provider = resolveProvider(server);
    if (!server.isRemote && (provider === "docker-local" || provider === "docker-managed")) {
      let signal;
      try {
        signal = await resolveDockerHostSignal(server);
      } catch (error) {
        log.debug(`Docker status of ${server.name} failed: ${error.message}`);
        signal = { running: false, scanFailed: true };
      }
      const known = !signal.scanFailed;
      // Docker's StartedAt carries nanoseconds; the rows' startedAt is a plain ISO string.
      const startedMs = known && signal.running && signal.startedAt ? Date.parse(signal.startedAt) : NaN;
      return {
        id: server.id,
        name: server.name,
        running: known && Boolean(signal.running),
        pid: null,
        isActive: server.id === activeId,
        provider,
        stateUnknown: !known,
        startedAt: Number.isFinite(startedMs) && startedMs > 0 ? new Date(startedMs).toISOString() : null,
      };
    }
    if (isManagedLifecycleProvider(server.lifecycleProvider)) {
      try {
        const status = await createLinuxServiceLifecycle(
          server,
          server.lifecycleProvider,
        ).status();
        const known = status.running && !status.scanFailed;
        return {
          id: server.id,
          name: server.name,
          running: status.running,
          pid: null,
          isActive: server.id === activeId,
          provider: server.lifecycleProvider,
          stateUnknown: Boolean(status.scanFailed),
          startedAt: await startedAtFor({ pid: status.mainPid }, known),
        };
      } catch (error) {
        return {
          id: server.id,
          name: server.name,
          running: false,
          pid: null,
          isActive: server.id === activeId,
          provider: server.lifecycleProvider,
          stateUnknown: true,
          startedAt: null,
          error: sanitizeError(error.message),
        };
      }
    }
    // Same ownership scorer serverManager.js uses for the active server's
    // own detection (-servername/-cachedir first, install-path substring
    // only as a fallback for a stock launch with no identifying args) --
    // using a second, weaker, ad-hoc match here would let this list and
    // the active server's own status disagree about the same process.
    const descriptor = {
      serverName: server.serverName,
      savePath: server.zomboidDataPath,
      serverPath: server.serverPath || server.installPath,
    };
    let running = false;
    let pid;
    let attributed = null;
    for (const m of matched) {
      if (scoreServerProcessOwnership(m.cmd, descriptor) > 0) {
        running = true;
        pid = m.pid;
        attributed = m;
        break;
      }
    }
    // Fallback: the active server's running state is authoritative even
    // when nothing in the host-wide scan above can be attributed to it
    // (e.g. when the process was started outside the panel and uses a
    // different working directory, with no -servername/-cachedir either).
    //
    // is-running-enumeration sweep, 2026-09-08: this used to read
    // serverManager.isRunning directly -- a cached field with no bound on
    // its own age, refreshed only as a SIDE EFFECT of something unrelated
    // elsewhere happening to call getServerProcessDetails() on the shared
    // instance. Convention A (getServerProcessDetails() itself) exposes
    // scanFailed precisely so a caller never mistakes "haven't checked
    // recently" for "confirmed" -- this fallback had no such capability.
    // Servers.tsx's waitForActionState() polls exactly this endpoint to
    // confirm both Start and Stop, so a stale-true cached flag broke both
    // directions: STOP could never see running:false and burned its full
    // timeout reporting "not confirmed" on a server that HAD actually
    // stopped, and START could report success off a flag startServer()
    // sets synchronously at spawn time, before anything had actually
    // observed the process. Calling getServerProcessDetails() fresh here
    // -- the same call every other convention-A site already makes --
    // keeps the grace window (its JVM-shape/zomboid-adjacent matching is
    // deliberately more permissive than scoreServerProcessOwnership's
    // descriptor-based scoring above, which is what let it catch a stock,
    // argument-less launch in the first place) while replacing an
    // unbounded-age field read with an actual observation, and gives this
    // row the same "don't know yet" signal every other site already has
    // instead of forcing a confident guess.
    let activeFallbackUnknown = false;
    let fallbackEntry = null;
    if (!running && server.id === activeId && typeof serverManager?.getServerProcessDetails === "function") {
      try {
        const activeDetails = await sharedStatusScan(
          serverManager,
          `active:${activeId}`,
          () => serverManager.getServerProcessDetails(),
        );
        if (activeDetails.scanFailed) {
          activeFallbackUnknown = true;
        } else if (activeDetails.running) {
          running = true;
          fallbackEntry = activeDetails.matched?.[0] || null;
        }
      } catch (err) {
        activeFallbackUnknown = true;
        log.debug(`Active-server fallback detection failed: ${err.message}`);
      }
    }
    // Windows may also list processes the panel can't read; for a row
    // none of the readable ones belongs to, one of those may be it.
    const stateUnknown =
      Boolean(detectionError) ||
      activeFallbackUnknown ||
      scanLeavesServerUnknown(hostScan, running);
    return {
      id: server.id,
      name: server.name,
      running,
      pid: pid || null,
      isActive: server.id === activeId,
      provider: "direct",
      stateUnknown,
      startedAt: await startedAtFor(attributed || fallbackEntry, running && !stateUnknown),
    };
  }));
  if (memory) {
    const usage = await readProcessesMemory(
      statuses.filter((row) => row.running && row.pid).map((row) => row.pid),
    );
    for (const row of statuses) {
      const bytes = row.pid ? usage.get(Number(row.pid)) : undefined;
      if (bytes !== undefined) row.memoryBytes = bytes;
    }
  }
  return { statuses, matched, detectionError };
}

// What holds the lifecycle lock, and which servers are waiting for their
// RCON after a start (lifecycleCoordinator.js's holdServerUntilRcon), for
// the client to say why a Start/Stop/Restart is unavailable. Pushed on every
// change as lifecycle:state; this is the read on page load. Same audience as
// GET /status: the operation and the server's name, nothing else.
router.get("/lifecycle", (req, res) => {
  res.json(getLifecycleState());
});

router.get("/status", async (req, res) => {
  try {
    const { statuses, matched, detectionError } = await readServerStatuses(
      req.app.get("serverManager"),
      { memory: true },
    );
    // Each server's data-folder disk, from the disk monitor's last check
    // (percentages and free bytes only, no path).
    const diskByServer = req.app.get("diskMonitor")?.getServerDiskStatuses?.() || {};

    res.json({
      servers: statuses.map((row) =>
        diskByServer[String(row.id)] ? { ...row, disk: diskByServer[String(row.id)] } : row,
      ),
      detectedProcesses: matched.length,
      // Every role reads this route; a failed process scan's raw error can
      // quote the tool it ran or a host folder (SECURITY 2026-10-05, H4).
      detectionError: detectionError ? sanitizeError(detectionError) : null,
      // This host's clock as it answered, so the client can count the
      // rows' startedAt in its own clock -- see the client's hostClock.ts.
      serverTime: Date.now(),
      // What this host (or container) can give the servers, against which
      // the Dashboard weighs the heap of the servers that start together.
      hostMemoryBytes: hostMemoryLimitBytes(),
    });
  } catch (error) {
    log.error(`Failed to get per-server status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Lightweight, bounded RCON connectivity probe for every configured server.
// It creates no persistent connections and never returns credential material.
// SECURITY (2026-10-20, access-control audit): it does send each server's
// stored password to that server's RCON host, so only the roles that work
// with RCON or the server list may start it: servers.manage or rcon.execute.
// The Servers page shows the RCON badge to those roles only.
// `?players=1` also counts who is on each one that answers (the Dashboard's
// overview of every server, which the panel's single RCON connection to the
// active server can't give): `players` is a number, or null when unknown.
// Other roles see the overview's player counts as unknown.
router.get("/rcon-status", requireAnyPermission("servers.manage", "rcon.execute"), async (req, res) => {
  try {
    const countPlayers = req.query?.players === "1";
    const servers = await getServers();
    const statuses = await mapWithConcurrency(servers, 3, async (server) => {
      const rconHost =
        typeof server.rconHost === "string" ? server.rconHost.trim() : "";
      const rconPort = parseBoundedInteger(server.rconPort, null, 1, 65535);
      if (
        !rconHost ||
        server.rconPort === undefined ||
        server.rconPort === null ||
        server.rconPort === ""
      ) {
        return { id: server.id, status: "unconfigured" };
      }
      if (rconPort === null) return { id: server.id, status: "unavailable" };
      const result = await testRconConnection({
        host: rconHost,
        port: rconPort,
        password: server.rconPassword || "",
        timeoutMs: 3000,
        countPlayers,
      });
      return {
        id: server.id,
        status: result.success ? "connected" : result.error || "unavailable",
        ...(countPlayers ? { players: result.success ? (result.players ?? null) : null } : {}),
      };
    });
    res.json({ servers: statuses });
  } catch (error) {
    log.error(`Failed to probe server RCON status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Each server other than the active one: its mods behind Steam and its
// game build against Steam's latest (services/otherServerUpdates.js), as of
// the last check -- for the Dashboard's list of servers. Reads only: every
// role reads this route, and a check asks Steam (and SteamCMD) on its own
// timer, not on a caller's request.
router.get("/updates", async (req, res) => {
  try {
    const updates = req.app.get("otherServerUpdates");
    res.json({ servers: updates ? updates.getResults() : [] });
  } catch (error) {
    log.error(`Failed to read other servers' updates: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get active server
router.get("/active", async (req, res) => {
  try {
    const server = await getActiveServer();
    if (!server) {
      return res.status(404).json({ error: "No active server configured" });
    }
    // Lets the UI stop hiding file-based pages once a remote server's Server
    // folder is reachable over SFTP.
    const remoteConfigConfigured = computeRemoteConfigConfigured(
      server,
      await getAllSettings(),
    );
    // PT3: as GET / above, so the two stay the same shape.
    const view = { ...server, remoteConfigConfigured, folderProblem: serverFolderProblem(server) };
    const pathView = (await canSeeHostPaths(req.user)) ? view : hideHostPaths(view);
    res.json({
      server: sanitizeServerResponse(
        (await canSeeRconTarget(req.user)) ? pathView : withoutRconTarget(pathView),
      ),
    });
  } catch (error) {
    log.error(`Failed to get active server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get a specific server
router.get("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: "Invalid server ID" });
    }
    const serverId = parseServerId(id);
    if (serverId === null) {
      return res.status(400).json({ error: "Invalid server ID" });
    }

    const server = await getServer(serverId);
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    // As GET / above: host folders and the RCON target per role.
    const pathView = (await canSeeHostPaths(req.user)) ? server : hideHostPaths(server);
    res.json({
      server: sanitizeServerResponse(
        (await canSeeRconTarget(req.user)) ? pathView : withoutRconTarget(pathView),
      ),
    });
  } catch (error) {
    log.error(`Failed to get server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Generate a provider-specific user-service file for the panel account to
// install.
// The panel deliberately returns the file as data and never writes to /etc or
// invokes sudo itself.
router.get(
  "/:id/lifecycle-template",
  requirePermission("servers.manage"),
  async (req, res) => {
    try {
      const serverId = parseServerId(req.params.id);
      if (serverId === null) {
        return res.status(400).json({ error: "Invalid server ID" });
      }
      const provider = String(req.query?.provider || "").trim();
      if (!isManagedLifecycleProvider(provider)) {
        return res.status(400).json({
          error: "provider must be systemd or openrc",
        });
      }
      const server = await getServer(serverId);
      if (!server) {
        return res.status(404).json({ error: "Server not found" });
      }
      if (server.isRemote || server.dockerContainerName || server.dockerContainerId) {
        return res.status(409).json({
          error:
            "Managed Linux services are available only for local, non-container server profiles",
        });
      }
      const capabilities = getLinuxLifecycleCapabilities();
      if (!capabilities.supported) {
        return res.status(409).json({
          error: capabilities.containerized
            ? "Container installations must keep their existing lifecycle model"
            : "Managed service lifecycles are supported only on Linux",
        });
      }
      const template = buildLifecycleTemplate(server, provider, {
        serviceUser: req.query?.serviceUser,
      });
      res.json({
        ...template,
        warning:
          "Review and install this file for the panel service account. The panel will not modify the filesystem or run sudo.",
      });
    } catch (error) {
      log.error(`Failed to generate lifecycle template: ${error.message}`);
      res.status(400).json({ error: sanitizeError(error.message) });
    }
  },
);

// Switching lifecycle ownership is intentionally a separate, confirmed
// operation instead of a generic profile update. This makes migration opt-in
// and gives the backend a chance to reject running or conflicting services.
router.post(
  "/:id/lifecycle-provider",
  requirePermission("servers.manage"),
  async (req, res) => {
    try {
      const serverId = parseServerId(req.params.id);
      if (serverId === null) {
        return res.status(400).json({ error: "Invalid server ID" });
      }
      const provider = String(req.body?.provider || "").trim();
      if (!LIFECYCLE_PROVIDERS.includes(provider)) {
        return res.status(400).json({
          error: "provider must be direct, systemd, or openrc",
        });
      }
      if (req.body?.confirm !== true) {
        return res.status(400).json({
          error: "Explicit lifecycle migration confirmation is required",
        });
      }

      const server = await getServer(serverId);
      if (!server) {
        return res.status(404).json({ error: "Server not found" });
      }
      const currentProvider = server.lifecycleProvider || "direct";
      if (provider === currentProvider) {
        return res.json({
          server: sanitizeServerResponse(server),
          message: `${provider} lifecycle is already active`,
        });
      }
      if (server.isRemote || server.dockerContainerName || server.dockerContainerId) {
        return res.status(409).json({
          error:
            "Remote and container-managed profiles must keep their existing lifecycle model",
        });
      }

      if (isManagedLifecycleProvider(provider)) {
        const lifecycle = createLinuxServiceLifecycle(server, provider);
        const preflight = await lifecycle.preflightActivation();
        if (!preflight.ready) {
          return res.status(409).json({
            error: sanitizeError(preflight.error),
            conflict: Boolean(preflight.conflict),
            running: Boolean(preflight.running),
          });
        }

        // While the database still says direct, use the native scanner to
        // prove there is no process to adopt silently.
        const directManager = new ServerManager();
        await directManager.reloadConfig(serverId);
        const directStatus = await directManager.getServerProcessDetails();
        if (directStatus.scanFailed) {
          return res.status(503).json({
            error:
              "Could not confirm that the directly managed server is stopped",
          });
        }
        if (directStatus.running) {
          return res.status(409).json({
            error:
              "Stop the directly managed server before activating a service provider. Running processes are never adopted automatically.",
            running: true,
          });
        }
      } else {
        const lifecycle = createLinuxServiceLifecycle(server, currentProvider);
        const currentStatus = await lifecycle.status();
        if (currentStatus.scanFailed || currentStatus.running) {
          return res.status(currentStatus.running ? 409 : 503).json({
            error: currentStatus.running
              ? "Stop the managed service before switching back to direct lifecycle"
              : "Could not confirm that the managed service is stopped",
            running: Boolean(currentStatus.running),
          });
        }
      }

      const updated = await updateServer(serverId, {
        lifecycleProvider: provider,
      });
      const sharedManager = req.app.get("serverManager");
      if (updated?.isActive && sharedManager?.reloadConfig) {
        await sharedManager.reloadConfig();
      }
      res.json({
        server: sanitizeServerResponse(updated),
        message: `Lifecycle provider changed to ${provider}`,
      });
    } catch (error) {
      log.error(`Failed to change lifecycle provider: ${error.message}`);
      res.status(400).json({ error: sanitizeError(error.message) });
    }
  },
);

// Create a new server
router.post("/", requirePermission("servers.manage"), async (req, res) => {
  try {
    const config =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body
        : {};
    log.info(
      `POST / — creating server: name=${config?.name}, remote=${!!config?.isRemote}`,
    );

    // /auto-scan and /detect never put the ini's RCON password on the wire.
    // A server created from one of their results instead sends back which
    // config it picked (dataPath + serverName) and we re-read the password
    // here, server-side, from that exact ini -- same shape as
    // discovery.js's create-from-discovery, adapted for this route's scan
    // being an arbitrary-path scan (gated by servers.discover) rather than
    // discovery.js's fixed, pre-enumerated mount list: there's no discovered
    // set to validate the reference against here, so the extra guard is
    // requiring servers.discover again, inline, for this branch specifically
    // -- the same capability that already gates reading arbitrary local ini
    // files on /auto-scan and /detect. Without it, a servers.manage-only
    // caller (who cannot call /auto-scan or /detect at all) could otherwise
    // use this branch to make the server read any *.ini path on the host.
    if (config.importIniFrom && typeof config.importIniFrom === "object") {
      const allowed = await requireCapabilityInline("servers.discover", req, res);
      if (!allowed) return;
      // The ini's RCON password is read here and never shown to the caller,
      // so the caller doesn't get to choose where it is sent either (see
      // rconConnectionChanges()): that ini's server answers on this machine.
      if (
        !rconHostIsThisMachine(config.rconHost) &&
        !(await holdsCapability("server.configure", req))
      ) {
        return res.status(403).json(rconChangeRefusal());
      }

      const { dataPath: importDataPath, serverName: importServerName } =
        config.importIniFrom;
      if (
        typeof importDataPath !== "string" ||
        importDataPath.length > 500 ||
        !path.isAbsolute(importDataPath)
      ) {
        return res
          .status(400)
          .json({ error: "Invalid importIniFrom.dataPath" });
      }
      if (!isValidServerName(importServerName)) {
        return res
          .status(400)
          .json({ error: "Invalid importIniFrom.serverName" });
      }
      const resolvedImportData = path.resolve(importDataPath);
      const importServerConfigPath = path.join(resolvedImportData, "Server");
      if (!fs.existsSync(importServerConfigPath)) {
        return res.status(400).json({
          error: "Not a valid Zomboid data folder (no Server subfolder found)",
        });
      }
      const importIniPath = path.join(
        importServerConfigPath,
        `${importServerName}.ini`,
      );
      if (!fs.existsSync(importIniPath)) {
        return res
          .status(400)
          .json({ error: `${importServerName}.ini not found` });
      }
      let importedSettings;
      try {
        const importedContent = fs
          .readFileSync(importIniPath, "utf-8")
          .replace(/\r\n/g, "\n");
        importedSettings = parseIni(importedContent);
      } catch (err) {
        return res.status(400).json({
          error: `Failed to read ${importServerName}.ini: ${sanitizeError(err.message)}`,
        });
      }
      if (!importedSettings.RCONPassword) {
        return res.status(400).json({
          error: `RCON password not set in ${importServerName}.ini — set RCONPassword on the server, then retry.`,
        });
      }
      // The freshly-read value always wins over anything the client sent
      // directly, so a bogus client-supplied rconPassword paired with a
      // valid importIniFrom can't stick.
      config.rconPassword = importedSettings.RCONPassword;
      if (!config.serverName) config.serverName = importServerName;
      // discovery.js's create-from-discovery (the sibling this route's own
      // comment says it mirrors) sets `zomboidDataPath: discovered.dataPath`
      // -- this branch validated and read the ini from that exact same
      // folder above but never wrote it back to `config`, so the created
      // server had a real, working rconPassword and a null
      // zomboidDataPath: it saved, then could not launch (serverManager
      // needs zomboidDataPath to resolve the cachedir), with nothing at
      // create time to connect the failure back to a bad import. Same
      // "freshly-verified value wins" precedence as rconPassword above --
      // this is the folder we just confirmed contains Server/<name>.ini,
      // so a stale/mismatched client-supplied zomboidDataPath must not
      // override it either.
      config.zomboidDataPath = resolvedImportData;
    }

    // RCE-STARTCMD: a new profile whose install path names a launcher
    // script is a launch target too (see changesLaunchTarget()). Judged on
    // what the caller sent, before the env fallback below.
    const requestsLauncher = isLauncherShaped(config.installPath);
    // PATHS-1: only a data folder the request names is judged below; the
    // PZ_SAVE_PATH fallback is the operator's own environment.
    const requestsDataPath = Boolean(config.zomboidDataPath);

    // Fall back to env-configured paths (docker-compose PZ_SERVER_PATH /
    // PZ_SAVE_PATH) when the request body doesn't set them explicitly.
    if (!config.installPath)
      config.installPath = process.env.PZ_SERVER_PATH || "";
    if (!config.zomboidDataPath)
      config.zomboidDataPath = process.env.PZ_SAVE_PATH || null;

    // Validate required fields - installPath not required for remote servers
    if (config.isRemote !== undefined && typeof config.isRemote !== "boolean") {
      return res.status(400).json({ error: "isRemote must be a boolean" });
    }
    const isRemote = config.isRemote === true;
    const requiredFields = isRemote
      ? ["name", "rconHost", "rconPort", "rconPassword"]
      : ["name", "installPath", "rconHost", "rconPort", "rconPassword"];
    for (const field of requiredFields) {
      if (!config[field]) {
        return res
          .status(400)
          .json({ error: `Missing required field: ${field}` });
      }
    }

    if (!isRemote) {
      const installPathCheck = validateInstallPathShape(config.installPath);
      if (!installPathCheck.valid) {
        return res.status(400).json({ error: installPathCheck.error, ...(installPathCheck.code ? { code: installPathCheck.code } : {}) });
      }
    }

    // SECURITY (2026-10-05, PATHS-1): this route stored the data folder
    // with no check at all, where PUT /:id and chunks /save-path checked
    // theirs -- so servers.manage alone named any folder on this computer
    // as a server's data folder. Same rule as every other setter now
    // (services/zomboidDataPath.js), stored as the path it resolved to, as PUT
    // stores it. A remote server's folder is on another host.
    if (!isRemote && requestsDataPath) {
      const dataPathCheck = checkZomboidDataPath(config.zomboidDataPath);
      if (!dataPathCheck.ok) {
        return res.status(400).json(dataPathCheck.body);
      }
      config.zomboidDataPath = dataPathCheck.path;
    }

    // FILES-2: see serverConfigPathIsConfined(). Judged against the data
    // folder this profile will be saved with (the env fallback included).
    if (
      config.serverConfigPath &&
      !serverConfigPathIsConfined(config.serverConfigPath, config.zomboidDataPath)
    ) {
      return res.status(400).json(serverConfigPathRefusal());
    }

    if (
      requestsLauncher &&
      (await refuseLaunchTargetChange(req, res, {
        installPath: config.installPath,
        isRemote,
      }))
    ) {
      return;
    }

    // Validate display name length
    if (typeof config.name !== "string" || config.name.length > 100) {
      return res
        .status(400)
        .json({ error: "Server name must be under 100 characters" });
    }

    // Validate RCON port
    const rconPort = parseBoundedInteger(config.rconPort, null, 1, 65535);
    if (rconPort === null) {
      return res.status(400).json({ error: "Invalid RCON port" });
    }
    if (
      typeof config.rconHost !== "string" ||
      !RCON_HOST_REGEX.test(config.rconHost.trim())
    ) {
      return res.status(400).json({ error: "Invalid RCON host" });
    }
    if (
      typeof config.rconPassword !== "string" ||
      config.rconPassword.length > RCON_PASSWORD_MAX_LENGTH
    ) {
      return res.status(400).json({ error: "Invalid RCON password" });
    }
    // The game reads server.ini only up to the first "=" and a line ends at
    // a break: see utils/rconPassword.js. Refused here, not stripped later.
    if (rconPasswordCannotBeStoredInIni(config.rconPassword)) {
      return res.status(400).json(rconPasswordUnsupportedCharsBody());
    }

    // The admin password goes into the start scripts: one they can't carry is
    // refused here rather than changed there.
    const adminPasswordRefusal = adminPasswordStartScriptRefusal(config.adminPassword);
    if (adminPasswordRefusal) {
      return res.status(400).json(adminPasswordRefusal);
    }

    // Validate serverName against path traversal. This value becomes the PZ
    // dedicated server's own internal name -- it names the .ini file and the
    // Saves/Multiplayer/<serverName> folder the panel reads and writes.
    // "servertest" used to fill in here when it was left blank, which is
    // Project Zomboid's own vanilla single-player/test-server name: on a
    // machine with a real, unrelated PZ install using that default name, the
    // panel would silently adopt its save/config directory as this server's
    // own. Fall back to the required display name instead of a shared,
    // well-known default -- and reject outright if neither is usable, rather
    // than inventing an identity.
    const serverName = String(config.serverName || config.name || "").trim();
    if (!isValidServerName(serverName)) {
      return res
        .status(400)
        .json({
          error: config.serverName
            ? "Invalid server name: only letters, numbers, underscores, hyphens and spaces allowed"
            : "Server name is required, or give the server a display name that can be reused as one (letters, numbers, underscores, hyphens and spaces only)",
        });
    }
    const dockerContainerName = String(config.dockerContainerName || "").trim();
    if (dockerContainerName && !isValidDockerContainerRef(dockerContainerName)) {
      return res.status(400).json({ error: "Invalid Docker container name" });
    }

    // Validate server port if provided
    let serverPort = 16261;
    if (config.serverPort !== undefined && config.serverPort !== null && config.serverPort !== "") {
      serverPort = parseBoundedInteger(config.serverPort, null, 1, GAME_PORT_MAX);
      if (serverPort === null) {
        return res.status(400).json({ error: "Invalid server port" });
      }
    }

    for (const key of ["useNoSteam", "useDebug", "useUpnp"]) {
      if (config[key] !== undefined && typeof config[key] !== "boolean") {
        return res.status(400).json({ error: `${key} must be a boolean` });
      }
    }

    // Same rule as PUT /:id: the game folder decides the PanelBridge
    // delivery, so a new profile on a folder that gets it from the Steam
    // Workshop can't be one that launches without Steam (useNoSteam, or an
    // installPath naming a -nosteam launcher script). PUT's other direction
    // can't happen here: a new profile is never Workshop by its own choice.
    const launchCandidate = { installPath: config.installPath, useNoSteam: config.useNoSteam === true };
    if (
      !isRemote &&
      launchLooksNoSteam(launchCandidate) &&
      newProfileConflictsWithWorkshop(launchCandidate, await getServers())
    ) {
      return res.status(409).json(noSteamWorkshopConflictResponse());
    }

    // -Xms above -Xmx makes the JVM refuse to start, so refuse the pair here
    // instead of saving a server that can never launch. A remote server's
    // memory is never used by this panel.
    const newMinMemory = normalizeMinMemoryGb(config.minMemory, 4);
    const newMaxMemory = normalizeMemoryGb(config.maxMemory, 8);
    if (!isRemote && memoryMinExceedsMax(newMinMemory, newMaxMemory)) {
      return res.status(400).json({
        ...memoryMinExceedsMaxFields(newMinMemory, newMaxMemory),
        code: ErrorCode.MEMORY_MIN_EXCEEDS_MAX,
      });
    }

    const server = await createServer({
      name: config.name,
      serverName,
      installPath: config.installPath || "",
      zomboidDataPath: config.zomboidDataPath || null,
      serverConfigPath: config.serverConfigPath || null,
      dockerContainerName: dockerContainerName || null,
      branch: config.branch || "stable",
      rconHost: config.rconHost.trim(),
      rconPort: rconPort,
      rconPassword: config.rconPassword,
      adminPassword: config.adminPassword || "",
      serverPort,
      minMemory: newMinMemory,
      maxMemory: newMaxMemory,
      useNoSteam: config.useNoSteam === true,
      useDebug: config.useDebug === true,
      useUpnp: config.useUpnp !== false,
      isRemote: isRemote,
    });

    log.info(`Created new server: ${server.name} (ID: ${server.id})`);
    res.status(201).json({
      server: sanitizeServerResponse(server),
      message: "Server created successfully",
    });
  } catch (error) {
    if (error?.code === ErrorCode.SERVER_ALREADY_EXISTS) {
      return res.status(409).json({
        error: error.message,
        code: ErrorCode.SERVER_ALREADY_EXISTS,
        params: sanitizeErrorParams(error.params),
      });
    }
    log.error(`Failed to create server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Allowed fields for server update — prevents mass assignment of internal fields (id, isActive, etc.)
const ALLOWED_SERVER_UPDATE_FIELDS = [
  "name",
  "serverName",
  "installPath",
  "serverPath",
  "zomboidDataPath",
  "serverConfigPath",
  "dockerContainerName",
  "branch",
  "rconHost",
  "rconPort",
  "rconPassword",
  "serverPort",
  "minMemory",
  "maxMemory",
  "useNoSteam",
  "useDebug",
  // Was absent from this list entirely (2026-08-26 same-night audit) --
  // there was no edit-screen path to fix a missing/wrong UPnP setting the
  // way adminPassword had one, because there was no per-server column for
  // it to update in the first place.
  "useUpnp",
  "isRemote",
  "startCommand",
  "adminPassword",
  // startBat/batFile used to be allowed here too. Re-confirmed dead
  // (2026-08-27, custom-launcher-as-a-real-supported-mode-not-an-accident):
  // grepped serverManager.js, database/init.js and all of client/src --
  // zero reads of either field anywhere. Removed rather than repurposed:
  // the real, now-supported mechanism for "point at a specific launcher
  // file" is a serverPath/installPath ending in .bat/.sh/.exe (see
  // resolveLaunchMode()), and keeping these next to that would have been a
  // third, unused mechanism sitting beside the two real ones.
  //
  // "description" removed the same way (2026-08-29): grepped for
  // `.description` on a server-shaped object across server/ and client/src/
  // -- every hit was mod metadata, Steam branch metadata, a toast's
  // `description` field, or an i18n key literally named `description`, none
  // of it this record's own field. updateServer() persists whatever lands in
  // `updates` via `{...db.data.servers[index], ...updates}` -- a spread, not
  // a field-by-field write -- so the value WAS being written to db.json on
  // every update that included it, just never read back by anything. A
  // request that still sends "description" after this change has it
  // silently filtered out here (same as any other field never on this
  // list) -- not a 400, just ignored, matching how startBat/batFile already
  // behave.
];

export function parseServerId(value) {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return /^\d+$/.test(id) ? Number(id) : id;
}

// Update a server
router.put("/:id", requirePermission("servers.manage"), async (req, res) => {
  const lifecycleLock = acquireLifecycleLock(
    "server-profile-change",
    req.params.id || null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: "Invalid server ID" });
    }
    const serverId = parseServerId(id);
    if (serverId === null) {
      return res.status(400).json({ error: "Invalid server ID" });
    }

    // Only allow whitelisted fields — block id, isActive, created, etc.
    const updates = {};
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body
        : {};
    for (const key of ALLOWED_SERVER_UPDATE_FIELDS) {
      if (body[key] !== undefined) {
        updates[key] = body[key];
      }
    }

    // Validate serverName against path traversal — this field is
    // interpolated into filesystem paths downstream (server-files, backups,
    // chunks), so it must pass the same check as server creation.
    if (updates.serverName !== undefined) {
      if (typeof updates.serverName !== "string") {
        return res.status(400).json({ error: "Invalid server name" });
      }
      const trimmed = updates.serverName.trim();
      if (!isValidServerName(trimmed)) {
        return res.status(400).json({
          error:
            "Invalid server name: only letters, numbers, underscores, hyphens and spaces allowed",
        });
      }
      updates.serverName = trimmed;
    }

    if (
      updates.name !== undefined &&
      (typeof updates.name !== "string" || updates.name.length > 100)
    ) {
      return res.status(400).json({
        error: "Server name must be under 100 characters",
      });
    }

    if (updates.dockerContainerName !== undefined) {
      if (
        updates.dockerContainerName !== null &&
        typeof updates.dockerContainerName !== "string"
      ) {
        return res.status(400).json({
          error: "Invalid Docker container name",
        });
      }
      const value = (updates.dockerContainerName || "").trim();
      if (value && !isValidDockerContainerRef(value)) {
        return res.status(400).json({
          error: "Invalid Docker container name",
        });
      }
      updates.dockerContainerName = value || null;
    }

    // HARDEN (operator ruling 2026-08-27): neither field was validated at
    // all before this, despite silently controlling MANAGED vs CUSTOM
    // LAUNCHER mode (serverManager.js's resolveLaunchMode()) -- an
    // unvalidated path that silently changes launch behavior was the whole
    // bug this feature closes. serverPath is the same shape as installPath
    // and follows the same rule.
    for (const key of ["installPath", "serverPath"]) {
      if (updates[key] !== undefined && updates[key] !== "") {
        const check = validateInstallPathShape(updates[key]);
        if (!check.valid) {
          return res.status(400).json({ error: check.error, ...(check.code ? { code: check.code } : {}) });
        }
      }
    }

    // HARDEN (2026-08-29, savepath-needs-existence-validation-at-set-time):
    // this route wrote zomboidDataPath straight through with zero validation
    // -- a wrong-but-structurally-valid path saved here while the server is
    // stopped passed silently, and POST /wipe (server.js) later deletes
    // under it. Remote servers are exempt: their data path lives on a
    // different host, so a local fs check would always incorrectly fail --
    // same exemption installPath already gets at server-creation time.
    //
    // SECURITY (2026-10-05, PATHS-1): the rule is now the one every setter
    // shares (services/zomboidDataPath.js): a folder that doesn't exist yet is
    // accepted (the game creates it on first start; POST / and the install
    // routes save one, and this route then refused every later edit of that
    // profile), and an existing one must really be a data folder -- not
    // merely have "zomboid" in its path. Judged when the value changes, and
    // when a remote profile turns local (its folder was never checked here):
    // the edit dialog sends the whole record back, and an unchanged folder
    // is judged again where it is used. Errors echo only the caller's own
    // value, never its %VAR% expansion (env-var-expansion-oracle,
    // 2026-09-05).
    if (updates.zomboidDataPath === null) updates.zomboidDataPath = "";
    if (updates.zomboidDataPath !== undefined || updates.isRemote !== undefined) {
      const stored = await getServer(serverId);
      const nextIsRemote =
        updates.isRemote !== undefined ? updates.isRemote === true : Boolean(stored?.isRemote);
      const nextDataPath =
        updates.zomboidDataPath !== undefined ? updates.zomboidDataPath : stored?.zomboidDataPath;
      const dataPathChanged =
        updates.zomboidDataPath !== undefined &&
        String(updates.zomboidDataPath) !== String(stored?.zomboidDataPath ?? "");
      const becomesLocal = Boolean(stored?.isRemote) && !nextIsRemote;
      if (!nextIsRemote && nextDataPath && (dataPathChanged || becomesLocal)) {
        const dataPathCheck = checkZomboidDataPath(nextDataPath);
        if (!dataPathCheck.ok) {
          return res.status(400).json(dataPathCheck.body);
        }
        if (updates.zomboidDataPath !== undefined) {
          updates.zomboidDataPath = dataPathCheck.path;
        }
      }
    }

    // FILES-2: see serverConfigPathIsConfined(). Judged against the data
    // folder the profile will have after this edit, whenever either folder
    // changes -- the edit dialog sends the whole record back, so an
    // unchanged pair is left alone. Moving or clearing the data folder
    // judges the stored config folder again: clearing it used to leave a
    // config folder with nothing to hold it to, which Server Files then
    // let through (FILES-2 adversary pass 2).
    if (updates.serverConfigPath !== undefined || updates.zomboidDataPath !== undefined) {
      const stored = await getServer(serverId);
      if (stored) {
        const changed = (key) =>
          updates[key] !== undefined && String(updates[key] ?? "") !== String(stored[key] ?? "");
        const nextConfigPath =
          updates.serverConfigPath !== undefined ? updates.serverConfigPath : stored.serverConfigPath;
        const nextDataPath =
          updates.zomboidDataPath !== undefined ? updates.zomboidDataPath : stored.zomboidDataPath;
        if (
          nextConfigPath &&
          (changed("serverConfigPath") || changed("zomboidDataPath")) &&
          !serverConfigPathIsConfined(nextConfigPath, nextDataPath)
        ) {
          return res.status(400).json(serverConfigPathRefusal());
        }
      }
    }

    // GET responses mask rconPassword/adminPassword (sanitizeServerResponse).
    // If the client echoes that masked value back unmodified, drop the field
    // so the real stored secret isn't overwritten with bullets.
    for (const key of ["rconPassword", "adminPassword"]) {
      if (updates[key] !== undefined && isMaskedSecret(updates[key])) {
        delete updates[key];
      }
    }

    // See POST /: the admin password goes into the start scripts.
    if (updates.adminPassword !== undefined) {
      const adminPasswordRefusal = adminPasswordStartScriptRefusal(updates.adminPassword);
      if (adminPasswordRefusal) {
        return res.status(400).json(adminPasswordRefusal);
      }
    }

    if (updates.rconHost !== undefined) {
      if (
        typeof updates.rconHost !== "string" ||
        !RCON_HOST_REGEX.test(updates.rconHost.trim())
      ) {
        return res.status(400).json({ error: "Invalid RCON host" });
      }
      updates.rconHost = updates.rconHost.trim();
    }

    if (
      updates.rconPassword !== undefined &&
      (typeof updates.rconPassword !== "string" ||
        updates.rconPassword.length > RCON_PASSWORD_MAX_LENGTH)
    ) {
      return res.status(400).json({ error: "Invalid RCON password" });
    }
    if (rconPasswordCannotBeStoredInIni(updates.rconPassword)) {
      return res.status(400).json(rconPasswordUnsupportedCharsBody());
    }

    // Validate RCON port if provided
    if (updates.rconPort !== undefined) {
      const rconPort = parseBoundedInteger(updates.rconPort, null, 1, 65535);
      if (rconPort === null) {
        return res.status(400).json({ error: "Invalid RCON port" });
      }
      updates.rconPort = rconPort;
    }

    // See rconConnectionChanges(). Kept for the reconnect below: only a real
    // change of the active server's connection reconnects it.
    let rconChange = { host: false, port: false, password: false, any: false };
    if (["rconHost", "rconPort", "rconPassword"].some((key) => updates[key] !== undefined)) {
      const storedRcon = await getServer(serverId);
      if (storedRcon) {
        rconChange = rconConnectionChanges(storedRcon, updates);
        if (rconChange.any && !(await holdsCapability("server.configure", req))) {
          return res.status(403).json(rconChangeRefusal());
        }
        if (
          (rconChange.host || rconChange.port) &&
          updates.rconPassword === undefined &&
          String(storedRcon.rconPassword ?? "") !== ""
        ) {
          return res.status(400).json(rconPasswordRequiredRefusal());
        }
      }
    }

    // Validate server port if provided
    if (updates.serverPort !== undefined) {
      const serverPort = parseBoundedInteger(updates.serverPort, null, 1, GAME_PORT_MAX);
      if (serverPort === null) {
        return res.status(400).json({ error: "Invalid server port" });
      }
      updates.serverPort = serverPort;
    }

    // Parse numeric fields
    if (updates.minMemory !== undefined) {
      // 0 = no -Xms (normalizeMinMemoryGb()).
      updates.minMemory = normalizeMinMemoryGb(updates.minMemory, 4);
    }
    if (updates.maxMemory !== undefined) {
      updates.maxMemory = normalizeMemoryGb(updates.maxMemory, 8);
    }
    // Judged on the pair the record will hold after this edit (an edit of one
    // value is checked against the stored other one), see POST /. A remote
    // server's memory is never used, and its edit dialog hides the fields.
    if (updates.minMemory !== undefined || updates.maxMemory !== undefined) {
      const storedMemory = await getServer(serverId);
      const nextMin = updates.minMemory !== undefined ? updates.minMemory : storedMemory?.minMemory;
      const nextMax = updates.maxMemory !== undefined ? updates.maxMemory : storedMemory?.maxMemory;
      const nextIsRemote = updates.isRemote !== undefined ? updates.isRemote : storedMemory?.isRemote;
      if (!nextIsRemote && memoryMinExceedsMax(nextMin, nextMax)) {
        return res.status(400).json({
          ...memoryMinExceedsMaxFields(nextMin, nextMax),
          code: ErrorCode.MEMORY_MIN_EXCEEDS_MAX,
        });
      }
    }

    // Parse boolean fields
    for (const key of ["useNoSteam", "useDebug", "isRemote", "useUpnp"]) {
      if (updates[key] !== undefined) {
        if (typeof updates[key] !== "boolean") {
          return res.status(400).json({ error: `${key} must be a boolean` });
        }
      }
    }

    if (updates.startCommand === null) updates.startCommand = "";
    if (
      updates.startCommand !== undefined &&
      typeof updates.startCommand !== "string"
    ) {
      return res.status(400).json({ error: "Invalid start command" });
    }

    // RCE-STARTCMD: see changesLaunchTarget().
    if (["startCommand", "installPath", "serverPath"].some((key) => key in updates)) {
      const stored = await getServer(serverId);
      if (
        stored &&
        changesLaunchTarget(stored, updates) &&
        (await refuseLaunchTargetChange(req, res, { ...stored, ...updates }))
      ) {
        return;
      }
    }

    // A server that gets PanelBridge from the Steam Workshop needs Steam to
    // download it: launched without Steam it starts with no bridge and, with
    // the item still listed in Mods=, refuses every join. Switching delivery
    // back to panel-installed has to come first (Settings › PanelBridge).
    // Judged on the records AFTER this edit, both ways round: this profile
    // turning no-Steam or moving into a Workshop game folder, and a Workshop
    // profile moving (installPath, serverPath, remote to local) into a
    // folder another profile launches without Steam from -- the folder
    // decides, so that profile would turn Workshop too. Only conflicts the
    // edit creates count: the edit dialog saves the whole record, so a
    // profile already in that state must stay renameable.
    if (["useNoSteam", "startCommand", "installPath", "serverPath", "isRemote"].some((key) => key in updates)) {
      const target = await getServer(serverId);
      if (target) {
        const conflicts = findNoSteamWorkshopConflicts(target, { ...target, ...updates }, await getServers());
        if (conflicts.self) {
          return res.status(409).json(noSteamWorkshopConflictResponse());
        }
        if (conflicts.siblings.length > 0) {
          return res.status(409).json(noSteamSiblingConflictResponse(conflicts.siblings));
        }
      }
    }

    const maskedSecretsOnly =
      Object.keys(body).length > 0 &&
      Object.entries(body).every(
        ([key, value]) =>
          ["rconPassword", "adminPassword"].includes(key) &&
          isMaskedSecret(value),
      );
    if (Object.keys(updates).length === 0 && !maskedSecretsOnly) {
      return res.status(400).json({ error: "At least one field is required" });
    }

    // The edit dialog sends the whole record back, useUpnp included, so the
    // key being PRESENT says nothing about the user having touched UPnP. Only
    // a value that differs from the stored one is an edit: acting on an echoed
    // value would rewrite UPnP= in the ini from a stale record (undoing a
    // change made in Server Config) and raise a warning for a rename. A record
    // with no stored value counts as on, the same default creation uses.
    let upnpChanged = false;
    if (updates.useUpnp !== undefined) {
      const storedBeforeUpdate = await getServer(serverId);
      upnpChanged =
        !storedBeforeUpdate ||
        (storedBeforeUpdate.useUpnp !== false) !== updates.useUpnp;
    }

    const server = await updateServer(serverId, updates);
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    log.info(`Updated server: ${server.name} (ID: ${server.id})`);

    // If the active server's RCON settings changed, refresh the RCON service
    // Otherwise the service keeps stale cached credentials after a reconnect
    // `warningDetails` carries each warning with its code, when it has one,
    // so the page can show it in the reader's language; `warnings` keeps the
    // English text for anything that reads only that.
    const reloadWarnings = [];
    const warningDetails = [];
    const addWarning = (text, code) => {
      reloadWarnings.push(text);
      warningDetails.push(code ? { error: text, code } : { error: text });
    };
    if (server.isActive) {
      // A real change only (rconConnectionChanges()): the edit dialog sends
      // the whole record back, so every save of the active server used to
      // drop and reconnect RCON, and warn when that reconnect failed.
      const rconFieldsChanged = rconChange.any;
      const serverManagerFieldsChanged = [
        "installPath",
        "serverPath",
        "zomboidDataPath",
        "serverConfigPath",
        "branch",
        "serverPort",
        "minMemory",
        "maxMemory",
        "useNoSteam",
        "useDebug",
        "startCommand",
        "serverName",
      ].some((k) => Object.prototype.hasOwnProperty.call(updates, k));

      const rconService = req.app.get("rconService");
      const serverManager = req.app.get("serverManager");

      if (serverManagerFieldsChanged && serverManager?.reloadConfig) {
        try {
          await serverManager.reloadConfig();
          log.info(`ServerManager config refreshed after active server update`);
        } catch (e) {
          log.warn(`ServerManager reload failed after update: ${e.message}`);
          addWarning(
            "Server manager failed to reload; restart the panel or server before relying on the updated settings",
          );
        }
      }

      // serverManagerFieldsChanged includes zomboidDataPath -- the exact
      // value LogTailer resolves its watched console/chat/user log paths
      // from (see logTailer.js's findLogPath()). Without this, editing the
      // ACTIVE server's own zomboidDataPath/serverName here (as opposed to
      // switching to a different server via /:id/activate, which already
      // calls discordBot.logTailer.reloadConfig() through
      // reloadServicesForNewActiveServer) left the tailer pinned to the OLD
      // path indefinitely -- same "wrong server's logs, no error, nothing
      // in the UI" failure mode as the /:id/activate gap this route's
      // sibling comment describes, just reached by editing the active
      // profile in place instead of switching away from it. discordBot is
      // the only handle routes have on the shared LogTailer instance (it is
      // never registered on the app directly).
      const discordBot = req.app.get("discordBot");
      if (serverManagerFieldsChanged && discordBot?.logTailer?.reloadConfig) {
        try {
          await discordBot.logTailer.reloadConfig();
          log.info(`LogTailer repointed after active server update: ${server.name}`);
        } catch (e) {
          log.warn(`LogTailer reload failed after active server update: ${e.message}`);
          addWarning(
            "Log tailer failed to reload; restart the panel before relying on chat/death detection for the updated path",
          );
        }
      }

      if (rconFieldsChanged && rconService?.reloadConfig) {
        try {
          if (rconService.isConnected && rconService.isConnected()) {
            await rconService.disconnect();
          }
          await rconService.reloadConfig();
          const reconnected = await rconService.connect();
          if (!reconnected) {
            log.warn("RCON reconnect returned false after active server update");
            addWarning(
              "RCON could not reconnect; verify the updated connection settings",
              ErrorCode.SERVER_RCON_RECONNECT_FAILED,
            );
          } else {
            log.info(`RCON config refreshed after active server update`);
          }
        } catch (e) {
          log.warn(`RCON reload failed after update: ${e.message}`);
          addWarning(
            "RCON failed to reload; reconnect before relying on the updated connection settings",
            ErrorCode.SERVER_RCON_RELOAD_FAILED,
          );
        }
      }

      if (Object.prototype.hasOwnProperty.call(updates, "installPath")) {
        await refreshWorkshopCheckerIfAvailable(req);
      }

      // Persisting useUpnp on the server record alone changes nothing PZ
      // actually reads (2026-08-26: adding it to ALLOWED_SERVER_UPDATE_FIELDS
      // without this would have recreated the exact "checkbox does nothing"
      // bug being fixed, one layer over -- found by a same-night audit
      // before this shipped). The real toggle is the UPnP= line in the
      // server's own .ini, the same one /configure-network writes -- reused
      // here via applyUpnpToIni() rather than duplicated. PATHS-2: only
      // into a config folder the record's own data folder holds, and only
      // while that data folder meets the data-folder rule (a remote
      // server's is never judged when saved -- PATHS-1 verifier pass 2).
      const upnpConfig = server.serverConfigPath ? serverConfigDirOf(server) : null;
      if (
        upnpChanged &&
        upnpConfig?.refused
      ) {
        addWarning(
          upnpConfig.reason === "data-folder"
            ? "UPnP setting saved, but not written to the server config: its Zomboid data folder holds files the game doesn't keep in a data folder. Fix the data folder, then edit UPnP again."
            : "UPnP setting saved, but not written to the server config: its config folder is outside its Zomboid data folder. Fix the config folder, then edit UPnP again.",
        );
      }
      if (
        upnpChanged &&
        upnpConfig?.dir &&
        server.serverName
      ) {
        const result = await applyUpnpToIni(
          upnpConfig.dir,
          server.serverName,
          updates.useUpnp,
        );
        if (result.applied) {
          await setSetting("useUpnp", updates.useUpnp);
          // PZ only reads this file at its own boot -- the .ini write above
          // is immediate, but its EFFECT is not, whether the server is
          // currently running (reads the old value until the next restart)
          // or currently stopped (reads the new value on its next start
          // either way). Saying so explicitly rather than letting "saved"
          // imply "live", same defect class as the two silent-failure fixes
          // earlier tonight -- a confident status the app cannot back.
          addWarning(
            "UPnP setting saved and written to the server config -- takes effect the next time this server starts, not immediately.",
          );
        } else {
          log.warn(`Could not apply UPnP setting to ini: ${result.reason}`);
          addWarning(
            `UPnP setting saved, but could not be applied to the server config (${result.reason}). Start the server once to generate its config file, then edit UPnP again.`,
          );
        }
      }
    }

    res.json({
      server: sanitizeServerResponse(server),
      message: "Server updated successfully",
      ...(reloadWarnings.length > 0 ? { warnings: reloadWarnings, warningDetails } : {}),
    });
  } catch (error) {
    log.error(`Failed to update server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    lifecycleLock.release();
  }
});

// Delete a server
router.delete("/:id", requirePermission("servers.manage"), async (req, res) => {
  const lifecycleLock = acquireLifecycleLock(
    "server-profile-change",
    req.params.id || null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: "Invalid server ID" });
    }
    const serverId = parseServerId(id);
    if (serverId === null) {
      return res.status(400).json({ error: "Invalid server ID" });
    }

    // Captured BEFORE deleting: deleteServer() silently promotes another
    // server to active when the one being deleted was active, but the live
    // serverManager/rconService need an explicit reload to match -- see
    // reloadServicesForNewActiveServer's comment above /:id/activate.
    const targetServer = await getServer(serverId);
    const deletingActiveServer = !!targetServer?.isActive;

    const success = await deleteServer(serverId);
    if (!success) {
      return res.status(404).json({ error: "Server not found" });
    }

    const io = req.app.get("io");

    if (deletingActiveServer) {
      const newActiveServer = await getActiveServer();
      if (newActiveServer) {
        try {
          await reloadServicesForNewActiveServer(req, newActiveServer);
        } catch (reloadErr) {
          log.warn(
            `Failed to reload services after deleting the active server: ${reloadErr.message}`,
          );
        }
        if (io) {
          io.emit("activeServerChanged", { server: activeServerSummary(newActiveServer) });
        }
      } else if (io) {
        // No servers left at all.
        io.emit("activeServerChanged", { deleted: serverId });
      }
    } else if (io) {
      // Sidebar/list still needs a refresh even though nothing was reloaded.
      io.emit("activeServerChanged", { deleted: serverId });
    }

    log.info(`Deleted server ID: ${serverId}`);
    res.json({ success: true, message: "Server deleted successfully" });
  } catch (error) {
    log.error(`Failed to delete server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    lifecycleLock.release();
  }
});

// SECURITY (2026-10-04, PR #193 review): activeServerChanged goes to every
// signed-in socket, whatever its role, and carried the whole server record:
// install, data and config folders, start command, RCON host and port,
// masked passwords. It now names the new active server and carries only
// what the page that reads the payload uses (Dashboard: id, serverName,
// maxMemory, and isRemote plus the Docker container reference for
// resolveClientProvider()); a page that needs the record reads GET
// /api/servers.
export function activeServerSummary(server) {
  return {
    id: server.id,
    name: server.name,
    serverName: server.serverName,
    isActive: Boolean(server.isActive),
    isRemote: Boolean(server.isRemote),
    dockerContainerName: server.dockerContainerName || null,
    dockerContainerId: server.dockerContainerId || null,
    maxMemory: server.maxMemory,
  };
}

// Reload the live in-memory services (serverManager, RCON, PanelBridge,
// LogTailer) to match `server` becoming the active one. Shared by
// POST /:id/activate and
// DELETE /:id below -- deleteServer() silently promotes another server to
// active in the database when the deleted one was active, and without this
// call the live services stayed pointed at the just-deleted server's stale
// config (old paths, old RCON credentials) until something else happened to
// reload them, unlike this route's own explicit activation sequence.
async function reloadServicesForNewActiveServer(req, server) {
  const rconService = req.app.get("rconService");
  const serverManager = req.app.get("serverManager");

  // The status watchdog's last-known state belongs to the server that was
  // active until now. Cleared up front so a tick that lands while the
  // services below are being repointed cannot compare the new server to the
  // old one and post a false "Server Stopped"/"Server Started" to Discord,
  // and again at the end so a baseline taken mid-reload is discarded.
  resetStatusWatchdogBaseline(req);

  if (serverManager && serverManager.reloadConfig) {
    await serverManager.reloadConfig();
    log.info(`ServerManager reloaded config for server: ${server.name}`);
  }

  await refreshWorkshopCheckerIfAvailable(req);

  // discordBot is the only handle routes have on the shared LogTailer
  // instance (it is never registered on the app directly). Without this,
  // deaths/chat kept flowing from the server that was active before the
  // switch -- see this function's own header comment.
  const discordBot = req.app.get("discordBot");
  if (discordBot && discordBot.logTailer && discordBot.logTailer.reloadConfig) {
    try {
      await discordBot.logTailer.reloadConfig();
      log.info(`LogTailer repointed for server: ${server.name}`);
    } catch (logTailerErr) {
      log.warn(`Failed to repoint LogTailer for new server: ${logTailerErr.message}`);
    }
  }

  if (rconService && rconService.isConnected()) {
    await rconService.disconnect();
  }

  // The reload is unconditional: a server with no RCON password still has to
  // repoint the service (host, port, serverId, empty password). Skipping it
  // left the previous server's cached config loaded, so the next command or
  // auto-reconnect silently talked to the OLD server. Only the connect is
  // gated on a password being present.
  if (rconService) {
    try {
      await rconService.reloadConfig();
      if (server.rconPassword) {
        await rconService.connect();
        log.info(`RCON reconnected for server: ${server.name}`);
      } else {
        log.info(`RCON repointed to server without a password: ${server.name}`);
      }
    } catch (rconErr) {
      log.warn(`Failed to connect RCON for new server: ${rconErr.message}`);
    }
  }

  // panelBridge is the third shared singleton this function repoints, next
  // to serverManager and rconService above -- previously the only thing
  // that repointed it was rconService's own "connected" event indirectly
  // re-triggering tryStartPanelBridge(), which only fires when the RCON
  // reconnect above actually runs (i.e. only when `server.rconPassword` is
  // set). A server managed via PanelBridge/SFTP only, or one that simply
  // hasn't had a password set yet, left panelBridge silently still pointed
  // at whatever server it last served -- not a display-only bug:
  // sendCommand() writes to the stale bridgePath's commands.json, so a
  // command the operator believes targets the newly active server is
  // actually delivered to, and executed by, the previous one. Explicit now,
  // not dependent on RCON reconnecting for an unrelated reason.
  const resyncPanelBridge = req.app.get("resyncPanelBridgeForActiveServer");
  if (typeof resyncPanelBridge === "function") {
    try {
      await resyncPanelBridge("active-server-changed");
      log.info(`PanelBridge repointed for server: ${server.name}`);
    } catch (bridgeErr) {
      log.warn(`Failed to repoint PanelBridge for new server: ${bridgeErr.message}`);
    }
  }

  // Best-effort: bring the newly active server's game folder in line with
  // its PanelBridge delivery method (bridgeDelivery.reconcileBridge never
  // throws). Not awaited: activation must not wait on disk work.
  void reconcileBridge(server, { reason: "activate" });

  // continuous-bug-hunt round 21: index.js's own 5s player-roster poll
  // shares this same rconService singleton but never got repointed here --
  // for up to 5s after this switch, the player count fed into perf
  // snapshots and every 'players:update' socket emission still showed the
  // PREVIOUS server's roster. See index.js's resetPlayerPollingBaseline()
  // for the full reasoning. Best-effort, same posture as every other
  // reload step above: never let this block a successful activation.
  try {
    const resetPlayerPollingBaseline = req.app.get("resetPlayerPollingBaseline");
    if (typeof resetPlayerPollingBaseline === "function") {
      resetPlayerPollingBaseline();
    }
  } catch (pollErr) {
    log.warn(`Failed to reset player-polling baseline for new server: ${pollErr.message}`);
  }

  resetStatusWatchdogBaseline(req);
}

// Best-effort, same posture as every reload step in
// reloadServicesForNewActiveServer: never block a successful activation.
function resetStatusWatchdogBaseline(req) {
  try {
    const reset = req.app.get("resetStatusWatchdogBaseline");
    if (typeof reset === "function") {
      reset();
    }
  } catch (err) {
    log.warn(`Failed to reset the status watchdog baseline for new server: ${err.message}`);
  }
}

// Set active server
router.post("/:id/activate", requirePermission("servers.manage"), async (req, res) => {
  // Panel-wide: a start of the active server may still be polling its RCON
  // through the shared connection this switch repoints (holdServerUntilRcon).
  const lifecycleLock = acquireLifecycleLock(
    "server-profile-change",
    req.params.id || null,
    { panelWide: true },
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: "Invalid server ID" });
    }
    const serverId = parseServerId(id);
    if (serverId === null) {
      return res.status(400).json({ error: "Invalid server ID" });
    }

    const server = await setActiveServer(serverId);
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    const io = req.app.get("io");
    // Best-effort, same posture as DELETE /:id's own call to this exact
    // function (see that route and reloadServicesForNewActiveServer's own
    // comment): the database record IS active at this point regardless of
    // what happens next, so a reload failure here must not turn a
    // successful activation into a 500 -- that would report failure for a
    // request that actually succeeded, and skip the activeServerChanged
    // broadcast below entirely, leaving connected clients unaware the
    // active server changed at all.
    const reloadWarnings = [];
    try {
      await reloadServicesForNewActiveServer(req, server);
    } catch (reloadErr) {
      log.warn(
        `Failed to reload services after activating server: ${reloadErr.message}`,
      );
      reloadWarnings.push(
        "Server activated, but live services could not be fully reloaded; restart the panel or reconnect RCON before relying on the new settings",
      );
    }

    // Emit to clients that active server changed
    if (io) {
      io.emit("activeServerChanged", { server: activeServerSummary(server) });
    }

    log.info(`Activated server: ${server.name} (ID: ${server.id})`);
    res.json({
      server: sanitizeServerResponse(server),
      message: `Now managing: ${server.name}`,
      ...(reloadWarnings.length > 0 ? { warnings: reloadWarnings } : {}),
    });
  } catch (error) {
    log.error(`Failed to activate server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    lifecycleLock.release();
  }
});

// Start, stop or restart a server other than the active one, from the
// Dashboard's list of servers -- see services/otherServerLifecycle.js. The
// capability of the Dashboard's own Start/Stop/Restart. Each settles with a
// `servers:status` push, as the server watch sends when it sees a server
// start or stop, so every open Dashboard's list follows.
async function runOtherServerAction(req, res, verb, action) {
  try {
    const { server, refused } = await resolveOtherServer(parseServerId(req.params.id));
    if (refused) return res.status(refused.status).json(refused.body);
    const io = req.app.get("io");
    const onSettled = () => io?.emit("servers:status", { serverId: server.id });
    const outcome = await action(server, { io, onSettled });
    res.status(outcome.status).json(outcome.body);
  } catch (error) {
    log.error(`Failed to ${verb} server ${req.params.id}: ${error.message}`);
    // startServer()'s coded refusals (SERVER_START_SCRIPT_MISSING,
    // SERVER_START_GAME_PORT_IN_USE...) keep their code, as on the Dashboard.
    res.status(500).json({
      error: sanitizeError(error.message),
      ...codedActionResultFields(error),
    });
  }
}

router.post("/:id/start", requirePermission("server.control"), (req, res) =>
  runOtherServerAction(req, res, "start", (server, { onSettled }) =>
    startOtherServer(server, { onSettled }),
  ),
);

router.post("/:id/stop", requirePermission("server.control"), (req, res) =>
  runOtherServerAction(req, res, "stop", (server, { onSettled }) =>
    stopOtherServer(server, { onSettled }),
  ),
);

// warningMinutes as POST /api/server/restart takes it: 0-60, 5 by default.
// The outcome reaches every client as the Dashboard's restart's does
// (scheduler:action_result), with the server's name.
router.post("/:id/restart", requirePermission("server.control"), (req, res) =>
  runOtherServerAction(req, res, "restart", (server, { io, onSettled }) =>
    restartOtherServer(server, {
      scheduler: req.app.get("scheduler"),
      warningMinutes: Math.min(
        parseBoundedInteger(req.body?.warningMinutes, 5, 0, Number.MAX_SAFE_INTEGER),
        60,
      ),
      onResult: (result) => {
        emitActionResult(io, {
          kind: "restart",
          serverName: server.name || server.serverName,
          success: !!result?.success,
          message: result?.message || (result?.success ? "Restart completed" : "Restart failed"),
          ...(result?.success ? {} : codedActionResultFields(result)),
        });
        onSettled();
      },
    }),
  ),
);

export default router;
