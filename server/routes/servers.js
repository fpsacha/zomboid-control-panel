import express from "express";
import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.js";
const log = createLogger("API:Servers");
import {
  sanitizeError,
  sanitizeServerResponse,
  sanitizeServerResponseList,
  isMaskedSecret,
} from "../utils/sanitize.js";
import { testRconConnection } from "../services/rcon.js";
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
import { requirePermission } from "../services/permissions.js";
import {
  canAutoInstall,
  checkBridgeInstalled,
  installBridge,
} from "../services/panelBridgeInstaller.js";
import { refreshWorkshopChecker } from "../services/modChecker.js";
import {
  parseBoundedInteger,
  parseClampedInteger,
} from "../utils/queryNumbers.js";
import { normalizeMemoryGb } from "../utils/memory.js";
import { GAME_PORT_MAX, applyUpnpToIni } from "./server.js";
import {
  resolveLaunchMode,
  ServerManager,
} from "../services/serverManager.js";
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

// Auto-install/update PanelBridge.lua on the newly-activated server when the
// panel has direct filesystem access to its install directory. Best-effort:
// logs and swallows any failure rather than affecting activation.
function autoInstallBridgeIfNeeded(server) {
  try {
    if (!canAutoInstall(server)) return;
    const status = checkBridgeInstalled(server);
    if (status.installed && !status.needsUpdate) return;

    const result = installBridge(server);
    if (result.success) {
      log.info(
        `PanelBridge ${status.installed ? "updated" : "installed"} at ${result.targetPath} (v${result.version || "unknown"})`,
      );
    } else {
      log.warn(`PanelBridge auto-install failed: ${result.error}`);
    }
  } catch (error) {
    log.warn(`PanelBridge auto-install check failed: ${error.message}`);
  }
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
    const withRemoteConfig = servers.map((server) => ({
      ...server,
      remoteConfigConfigured: computeRemoteConfigConfigured(server, settings),
    }));
    res.json({
      servers: sanitizeServerResponseList(withRemoteConfig),
      lifecycleCapabilities: getLinuxLifecycleCapabilities(),
    });
  } catch (error) {
    log.error(`Failed to get servers: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Per-server running status. Scans the host once for all PZ server processes
// and attributes each match to a configured server by comparing its install
// path against the process command line. Servers with no matching process
// are reported as not running. The active server's state is reported by
// serverManager directly so it stays consistent with /api/server/status.
router.get("/status", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    const servers = await getServers();
    const activeServer = await getActiveServer();
    const activeId = activeServer?.id || null;

    let matched = [];
    let detectionError = null;
    if (serverManager?.getServerProcessDetails) {
      try {
        const result = await serverManager.getServerProcessDetails();
        matched = Array.isArray(result?.matched) ? result.matched : [];
      } catch (err) {
        detectionError = err.message;
        log.debug(`Per-server status detection failed: ${err.message}`);
      }
    }

    // Normalise install paths for comparison: lowercase + forward slashes.
    // Windows command lines may double-quote the path or use backslashes;
    // the substring check below covers both.
    const norm = (p) =>
      String(p || "")
        .toLowerCase()
        .replace(/\\/g, "/")
        .trim();

    const statuses = await Promise.all(servers.map(async (server) => {
      if (isManagedLifecycleProvider(server.lifecycleProvider)) {
        try {
          const status = await createLinuxServiceLifecycle(
            server,
            server.lifecycleProvider,
          ).status();
          return {
            id: server.id,
            name: server.name,
            running: status.running,
            pid: null,
            isActive: server.id === activeId,
            provider: server.lifecycleProvider,
            stateUnknown: Boolean(status.scanFailed),
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
            error: sanitizeError(error.message),
          };
        }
      }
      const installPathNorm = norm(server.installPath);
      let running = false;
      let pid;
      if (installPathNorm) {
        for (const m of matched) {
          if (norm(m.cmd).includes(installPathNorm)) {
            running = true;
            pid = m.pid;
            break;
          }
        }
      }
      // Fallback: the active server's running state is authoritative even
      // when the install path doesn't appear in the command line (e.g. when
      // the process was started outside the panel and uses a different
      // working directory).
      if (!running && server.id === activeId && serverManager?.isRunning) {
        running = true;
      }
      return {
        id: server.id,
        name: server.name,
        running,
        pid: pid || null,
        isActive: server.id === activeId,
        provider: "direct",
      };
    }));

    res.json({
      servers: statuses,
      detectedProcesses: matched.length,
      detectionError,
    });
  } catch (error) {
    log.error(`Failed to get per-server status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Lightweight, bounded RCON connectivity probe for every configured server.
// It creates no persistent connections and never returns credential material.
router.get("/rcon-status", async (req, res) => {
  try {
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
      });
      return {
        id: server.id,
        status: result.success ? "connected" : result.error || "unavailable",
      };
    });
    res.json({ servers: statuses });
  } catch (error) {
    log.error(`Failed to probe server RCON status: ${error.message}`);
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
    res.json({
      server: sanitizeServerResponse({ ...server, remoteConfigConfigured }),
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

    res.json({ server: sanitizeServerResponse(server) });
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
    }

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
        return res.status(400).json({ error: installPathCheck.error });
      }
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
      minMemory: normalizeMemoryGb(config.minMemory, 4),
      maxMemory: normalizeMemoryGb(config.maxMemory, 8),
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
  "description",
  "adminPassword",
  // startBat/batFile used to be allowed here too. Re-confirmed dead
  // (2026-08-27, custom-launcher-as-a-real-supported-mode-not-an-accident):
  // grepped serverManager.js, database/init.js and all of client/src --
  // zero reads of either field anywhere. Removed rather than repurposed:
  // the real, now-supported mechanism for "point at a specific launcher
  // file" is a serverPath/installPath ending in .bat/.sh/.exe (see
  // resolveLaunchMode()), and keeping these next to that would have been a
  // third, unused mechanism sitting beside the two real ones.
];

export function parseServerId(value) {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return /^\d+$/.test(id) ? Number(id) : id;
}

// Update a server
router.put("/:id", requirePermission("servers.manage"), async (req, res) => {
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
      const value = String(updates.dockerContainerName).trim();
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
          return res.status(400).json({ error: check.error });
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

    // Validate RCON port if provided
    if (updates.rconPort !== undefined) {
      const rconPort = parseBoundedInteger(updates.rconPort, null, 1, 65535);
      if (rconPort === null) {
        return res.status(400).json({ error: "Invalid RCON port" });
      }
      updates.rconPort = rconPort;
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
      updates.minMemory = normalizeMemoryGb(updates.minMemory, 4);
    }
    if (updates.maxMemory !== undefined) {
      updates.maxMemory = normalizeMemoryGb(updates.maxMemory, 8);
    }

    // Parse boolean fields
    for (const key of ["useNoSteam", "useDebug", "isRemote", "useUpnp"]) {
      if (updates[key] !== undefined) {
        if (typeof updates[key] !== "boolean") {
          return res.status(400).json({ error: `${key} must be a boolean` });
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

    const server = await updateServer(serverId, updates);
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    log.info(`Updated server: ${server.name} (ID: ${server.id})`);

    // If the active server's RCON settings changed, refresh the RCON service
    // Otherwise the service keeps stale cached credentials after a reconnect
    const reloadWarnings = [];
    if (server.isActive) {
      const rconFieldsChanged = ["rconHost", "rconPort", "rconPassword"].some(
        (k) => Object.prototype.hasOwnProperty.call(updates, k),
      );
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
          reloadWarnings.push(
            "Server manager failed to reload; restart the panel or server before relying on the updated settings",
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
            reloadWarnings.push(
              "RCON could not reconnect; verify the updated connection settings",
            );
          } else {
            log.info(`RCON config refreshed after active server update`);
          }
        } catch (e) {
          log.warn(`RCON reload failed after update: ${e.message}`);
          reloadWarnings.push(
            "RCON failed to reload; reconnect before relying on the updated connection settings",
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
      // here via applyUpnpToIni() rather than duplicated.
      if (
        Object.prototype.hasOwnProperty.call(updates, "useUpnp") &&
        server.serverConfigPath &&
        server.serverName
      ) {
        const result = await applyUpnpToIni(
          server.serverConfigPath,
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
          reloadWarnings.push(
            "UPnP setting saved and written to the server config -- takes effect the next time this server starts, not immediately.",
          );
        } else {
          log.warn(`Could not apply UPnP setting to ini: ${result.reason}`);
          reloadWarnings.push(
            `UPnP setting saved, but could not be applied to the server config (${result.reason}). Start the server once to generate its config file, then edit UPnP again.`,
          );
        }
      }
    }

    res.json({
      server: sanitizeServerResponse(server),
      message: "Server updated successfully",
      ...(reloadWarnings.length > 0 ? { warnings: reloadWarnings } : {}),
    });
  } catch (error) {
    log.error(`Failed to update server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Delete a server
router.delete("/:id", requirePermission("servers.manage"), async (req, res) => {
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
          io.emit("activeServerChanged", { server: sanitizeServerResponse(newActiveServer) });
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
  }
});

// Reload the live in-memory services (serverManager, RCON, PanelBridge) to
// match `server` becoming the active one. Shared by POST /:id/activate and
// DELETE /:id below -- deleteServer() silently promotes another server to
// active in the database when the deleted one was active, and without this
// call the live services stayed pointed at the just-deleted server's stale
// config (old paths, old RCON credentials) until something else happened to
// reload them, unlike this route's own explicit activation sequence.
async function reloadServicesForNewActiveServer(req, server) {
  const rconService = req.app.get("rconService");
  const serverManager = req.app.get("serverManager");

  if (serverManager && serverManager.reloadConfig) {
    await serverManager.reloadConfig();
    log.info(`ServerManager reloaded config for server: ${server.name}`);
  }

  await refreshWorkshopCheckerIfAvailable(req);

  if (rconService && rconService.isConnected()) {
    await rconService.disconnect();
  }

  if (rconService && server.rconPassword) {
    try {
      await rconService.reloadConfig();
      await rconService.connect();
      log.info(`RCON reconnected for server: ${server.name}`);
    } catch (rconErr) {
      log.warn(`Failed to connect RCON for new server: ${rconErr.message}`);
    }
  }

  // Best-effort: keep PanelBridge.lua current on servers the panel can
  // reach directly on disk. Never let an install failure block activation.
  autoInstallBridgeIfNeeded(server);
}

// Set active server
router.post("/:id/activate", requirePermission("servers.manage"), async (req, res) => {
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
    await reloadServicesForNewActiveServer(req, server);

    // Emit to clients that active server changed
    if (io) {
      io.emit("activeServerChanged", { server });
    }

    log.info(`Activated server: ${server.name} (ID: ${server.id})`);
    res.json({
      server: sanitizeServerResponse(server),
      message: `Now managing: ${server.name}`,
    });
  } catch (error) {
    log.error(`Failed to activate server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
