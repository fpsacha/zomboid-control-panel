/**
 * PanelBridge API Routes
 *
 * REST API endpoints to manage and interact with the PanelBridge mod.
 */

import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import bridge from "../services/panelBridge.js";
import {
  getActiveServer,
  getServer,
  getAllSettings,
  setSetting,
  getDb,
  commitNow,
  logBridgeCommand,
} from "../database/init.js";
import { sanitizeError } from "../utils/sanitize.js";
import { persistSandboxValues } from "./serverFiles.js";
import { requireRole } from "../services/auth.js";
import {
  getEmbeddedPanelBridgeLua,
  compareModVersions,
  writeLuaAtomic,
} from "../utils/embeddedLua.js";
import { createLogger } from "../utils/logger.js";
import {
  getSftpCachePath,
  testSftpBridge,
  validateSftpBridgeConfig,
  listSftpLogs,
  readSftpLogTail,
} from "../services/panelBridgeSftp.js";
const log = createLogger("API:PanelBridge");

// ES Module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

const ITEM_TYPE_REGEX = /^[A-Za-z0-9_]+\.[A-Za-z0-9_&#+.\-]+$/;
const VEHICLE_SCRIPT_REGEX = /^[A-Za-z0-9_]+\.[A-Za-z0-9_&#+.\-]+$/;

const SFTP_SETTING_KEYS = {
  enabled: "panelBridgeSftpEnabled",
  host: "panelBridgeSftpHost",
  port: "panelBridgeSftpPort",
  username: "panelBridgeSftpUsername",
  password: "panelBridgeSftpPassword",
  bridgePath: "panelBridgeSftpBridgePath",
  pollIntervalSeconds: "panelBridgeSftpPollIntervalSeconds",
};

const SFTP_LOG_PATH_KEY = "panelBridgeSftpLogPath";

function isMaskedSecret(value) {
  return typeof value === "string" && value.startsWith("••••••••");
}

async function resolveSftpConfig(input = {}) {
  const settings = await getAllSettings();
  const password = input.password && !isMaskedSecret(input.password)
    ? input.password
    : settings[SFTP_SETTING_KEYS.password] || "";
  return validateSftpBridgeConfig({
    host: input.host ?? settings[SFTP_SETTING_KEYS.host],
    port: input.port ?? settings[SFTP_SETTING_KEYS.port],
    username: input.username ?? settings[SFTP_SETTING_KEYS.username],
    password,
    bridgePath: input.bridgePath ?? settings[SFTP_SETTING_KEYS.bridgePath],
    pollIntervalSeconds: input.pollIntervalSeconds ?? settings[SFTP_SETTING_KEYS.pollIntervalSeconds],
  });
}

// The log transport reuses the bridge credentials but has its own remote path
// and does not require a configured bridgePath.
async function resolveSftpLogConfig(input = {}) {
  const settings = await getAllSettings();
  const password = input.password && !isMaskedSecret(input.password)
    ? input.password
    : settings[SFTP_SETTING_KEYS.password] || "";
  return {
    host: input.host ?? settings[SFTP_SETTING_KEYS.host],
    port: input.port ?? settings[SFTP_SETTING_KEYS.port],
    username: input.username ?? settings[SFTP_SETTING_KEYS.username],
    password,
    logPath: input.logPath ?? settings[SFTP_LOG_PATH_KEY],
  };
}

// Valid PanelBridge actions (defense-in-depth — Lua side also validates)
const VALID_ACTIONS = new Set([
  "ping",
  "getServerInfo",
  "getWeather",
  "getGameTime",
  "getWorldStats",
  "getPlayerDetails",
  "getAllPlayerDetails",
  "healPlayer",
  "killPlayer",
  "teleportPlayer",
  "setGodMode",
  "setInvisible",
  "setNoclip",
  "giveItem",
  "exportPlayerData",
  "importPlayerData",
  "triggerBlizzard",
  "triggerTropicalStorm",
  "triggerStorm",
  "stopWeather",
  "startRain",
  "stopRain",
  "setSnow",
  "generateWeather",
  "setTemperature",
  "setWind",
  "setFog",
  "setClouds",
  "setDayLight",
  "setNightStrength",
  "setDesaturation",
  "setViewDistance",
  "setAmbient",
  "setClimateFloat",
  "resetClimateOverrides",
  "getClimateFloats",
  "setGameTime",
  "triggerLightning",
  "playWorldSound",
  "playSoundNearPlayer",
  "triggerGunshot",
  "triggerAlarmSound",
  "createNoise",
  "sendToServerChat",
  "sendToAdminChat",
  "sendToGeneralChat",
  "getChatInfo",
  "getUtilitiesStatus",
  "restoreUtilities",
  "shutOffUtilities",
  "saveWorld",
  "getSandboxOptions",
  "getAllSandboxOptions",
  "setSandboxOption",
  "getZombieCount",
  "clearZombiesNearPlayer",
  "clearAllZombies",
  "spawnHordeNearPlayer",
  "spawnHordeBehindPlayer",
  "airdrop",
  "getSafehouses",
  "safehouseAddPlayer",
  "safehouseRemovePlayer",
  "safehouseSetOwner",
  "safehouseSetRespawn",
  "getFactions",
  "createFaction",
  "factionAddPlayer",
  "factionRemovePlayer",
  "factionSetTag",
  "removeFaction",
  "getVehiclesDetailed",
  "vehicleRepair",
  "vehicleSetAlarm",
  "vehicleSetSiren",
  "vehicleSetTrunkLocked",
  "vehicleSetFuel",
  "vehicleSetBattery",
  "removeVehicle",
  "removeVehiclesInArea",
  "spawnVehicleAt",
  "vehicleHotwire",
  "getTimeSpeed",
  "setTimeSpeed",
  "triggerHelicopterEvent",
  "triggerSwarmEvent",
  "runEventSequence",
  "getInfrastructureSnapshot",
  "moderationKickUser",
  "moderationBanUser",
  "moderationBanIP",
  "moderationBanSteamID",
  "getDebugLog",
  "setDebugMode",
  "getStats",
  "checkAPI",
  "getAvailableHandlers",
  "clearErrors",
  "getItemCatalog",
  "getVehicleCatalog",
]);

// Username validation for PanelBridge player endpoints.
// Allow normal in-game names (spaces/symbols) while blocking control chars and quote/backslash.
const BRIDGE_USERNAME_REGEX = /^(?=.*\S)[^\x00-\x1F\x7F"\\]{1,64}$/;

// Get bridge status
router.get("/status", async (req, res) => {
  const status = bridge.getStatus();

  // Also include detected paths from active server
  let detectedPaths = null;
  try {
    const activeServer = await getActiveServer();
    if (activeServer) {
      detectedPaths = {
        serverName: activeServer.serverName || activeServer.name,
        installPath: activeServer.installPath,
        zomboidDataPath: activeServer.zomboidDataPath,
        // Bridge path would be: zomboidDataPath/Saves/Multiplayer/{serverName}/panelbridge/
        // OR for dedicated servers: installPath/../Server_files/Saves/Multiplayer/{serverName}/panelbridge/
      };
    }
  } catch (e) {
    // Ignore
  }

  res.json({
    ...status,
    modConnected: bridge.isModConnected(),
    detectedPaths,
  });
});

// Auto-configure bridge from server settings (optionally specify serverId)
router.post("/auto-configure", async (req, res) => {
  try {
    const { serverId } = req.body;
    log.info(`POST /auto-configure (serverId=${serverId || "active"})`);

    // Get specified server or active server
    let targetServer;
    if (serverId) {
      targetServer = await getServer(serverId);
      if (!targetServer) {
        return res
          .status(400)
          .json({ error: `Server with ID ${serverId} not found.` });
      }
    } else {
      targetServer = await getActiveServer();
      if (!targetServer) {
        return res.status(400).json({
          error:
            "No active server configured. Please configure a server first.",
        });
      }
    }

    const serverName = targetServer.serverName || targetServer.name;
    if (!serverName) {
      return res.status(400).json({ error: "Server name not configured." });
    }

    // The PanelBridge mod writes to: {RuntimeDataPath}/Lua/panelbridge/{serverName}/
    // For dedicated servers, the runtime data folder is often separate from the install folder
    // Pattern: Server_Data/DoomerZ_B42 (install) + Server_files_B42 (runtime data via -cachedir)
    const possiblePaths = [];
    const searchedLocations = [];

    // Helper to safely read directory contents
    const safeReadDir = (dirPath) => {
      try {
        return fs.existsSync(dirPath) ? fs.readdirSync(dirPath) : [];
      } catch (e) {
        return [];
      }
    };

    // Helper to add path with metadata
    const addPath = (p, source, priority = 10) => {
      // Avoid duplicates
      if (possiblePaths.some((pp) => pp.path === p)) return;

      const statusFile = path.join(p, "status.json");
      const initFile = path.join(p, ".init");
      const hasStatus = fs.existsSync(statusFile);
      const hasInit = fs.existsSync(initFile);

      possiblePaths.push({
        path: p,
        source,
        hasStatus,
        hasInit,
        exists: hasStatus || hasInit || fs.existsSync(p),
        priority,
      });
      searchedLocations.push({ path: p, source, hasStatus, hasInit });
    };

    // PRIORITY 1: zomboidDataPath is where -cachedir points - this is where the mod WRITES status.json
    // This should be checked first since it's explicitly configured for the server
    if (targetServer.zomboidDataPath) {
      addPath(
        path.join(
          targetServer.zomboidDataPath,
          "Lua",
          "panelbridge",
          serverName,
        ),
        "zomboidDataPath/Lua (cachedir)",
        1,
      );
    }

    // PRIORITY 2 (fallback): default ~/Zomboid folder — works on both Windows and Linux when
    // the server runs without a custom -cachedir (e.g., most Linux dedicated server setups)
    addPath(
      path.join(os.homedir(), "Zomboid", "Lua", "panelbridge", serverName),
      "default Zomboid folder",
      2,
    );

    // PRIORITY 3: Look for Server_files* folders at the parent level (runtime data location)
    // This is where -cachedir typically points for dedicated servers with separate data folders
    if (targetServer.installPath) {
      const parentDir = path.dirname(targetServer.installPath);
      const parentContents = safeReadDir(parentDir);
      for (const item of parentContents) {
        // Match Server_files* patterns (e.g., Server_files_B42, Server_files_B42_Beta1)
        if (item.startsWith("Server_files") || item.match(/Server.*files/i)) {
          const luaPath = path.join(
            parentDir,
            item,
            "Lua",
            "panelbridge",
            serverName,
          );
          addPath(luaPath, `${item}/Lua`, 3);
        }
      }

      // PRIORITY 4: Also check grandparent directory (for nested setups)
      const grandParentDir = path.dirname(parentDir);
      if (grandParentDir !== parentDir) {
        const grandParentContents = safeReadDir(grandParentDir);
        for (const item of grandParentContents) {
          if (item.startsWith("Server_files") || item.match(/Server.*files/i)) {
            const luaPath = path.join(
              grandParentDir,
              item,
              "Lua",
              "panelbridge",
              serverName,
            );
            addPath(luaPath, `${item}/Lua`, 4);
          }
        }
      }

      // PRIORITY 5: Lua folder directly in install path (fallback)
      addPath(
        path.join(targetServer.installPath, "Lua", "panelbridge", serverName),
        "installPath/Lua",
        5,
      );
    }

    // Sort by priority, then by whether it has status.json
    possiblePaths.sort((a, b) => {
      // Status.json paths are highest priority
      if (a.hasStatus && !b.hasStatus) return -1;
      if (!a.hasStatus && b.hasStatus) return 1;
      // Then .init files
      if (a.hasInit && !b.hasInit) return -1;
      if (!a.hasInit && b.hasInit) return 1;
      // Then by configured priority
      return a.priority - b.priority;
    });

    // Find first path that has actual status.json (best match)
    let foundPath = possiblePaths.find((p) => p.hasStatus);

    // Fall back to path with .init file
    if (!foundPath) {
      foundPath = possiblePaths.find((p) => p.hasInit);
    }

    // Fall back to path that already exists
    if (!foundPath) {
      foundPath = possiblePaths.find((p) => p.exists);
    }

    // Fall back to first path by priority (expected location - don't create it)
    if (!foundPath && possiblePaths.length > 0) {
      possiblePaths.sort((a, b) => a.priority - b.priority);
      foundPath = possiblePaths[0];
    }

    if (!foundPath) {
      return res.status(400).json({
        error: `Could not determine bridge path for server "${serverName}". Make sure server installPath is set.`,
        searchedPaths: searchedLocations,
      });
    }

    // DON'T create the directory - the PZ mod will create it when it runs
    // Just configure the bridge to watch this path

    // Stop bridge first if already running so watcher/poller restarts on new path
    if (bridge.isRunning) {
      bridge.stop();
    }

    // Configure and start bridge - foundPath IS the complete panelbridge folder
    bridge.configure(foundPath.path, true); // true = direct path
    bridge.start();

    // Auto-install or update PanelBridge mod
    let modInstalled = false;
    let modUpdated = false;
    try {
      const serverInstallDir =
        targetServer.serverPath || targetServer.installPath;
      if (serverInstallDir) {
        const installDir =
          serverInstallDir.endsWith(".bat") ||
          serverInstallDir.endsWith(".sh") ||
          serverInstallDir.endsWith(".exe")
            ? path.dirname(serverInstallDir)
            : serverInstallDir;

        const destLuaFile = path.join(
          installDir,
          "media",
          "lua",
          "server",
          "PanelBridge.lua",
        );

        // Prefer embedded Lua (guaranteed to match running binary version).
        let srcContent = getEmbeddedPanelBridgeLua();

        if (!srcContent) {
          const possibleModPaths = [
            path.join(process.cwd(), "pz-mod", "PanelBridge"),
            path.join(path.dirname(process.execPath), "pz-mod", "PanelBridge"),
            path.join(__dirname, "..", "..", "pz-mod", "PanelBridge"),
          ];
          for (const modPath of possibleModPaths) {
            const candidate = path.join(
              modPath,
              "media",
              "lua",
              "server",
              "PanelBridge.lua",
            );
            if (fs.existsSync(candidate)) {
              srcContent = fs.readFileSync(candidate, "utf8");
              break;
            }
          }
        }

        if (srcContent) {
          let needsCopy = !fs.existsSync(destLuaFile);

          // If dest exists, compare VERSION strings and only upgrade if
          // embedded is strictly newer (avoids silent downgrade of hand-
          // installed dev builds).
          if (!needsCopy) {
            modInstalled = true;
            try {
              const destContent = fs.readFileSync(destLuaFile, "utf8");
              const srcVersion = (srcContent.match(/VERSION\s*=\s*"([^"]+)"/) ||
                [])[1];
              const destVersion = (destContent.match(
                /VERSION\s*=\s*"([^"]+)"/,
              ) || [])[1];
              if (
                srcVersion &&
                destVersion &&
                compareModVersions(srcVersion, destVersion) > 0
              ) {
                needsCopy = true;
                modUpdated = true;
                log.info(
                  `PanelBridge mod update: ${destVersion} → ${srcVersion}`,
                );
              }
            } catch (_) {
              /* ignore read errors — keep existing */
            }
          }

          if (needsCopy) {
            writeLuaAtomic(destLuaFile, srcContent);
            modInstalled = true;
            if (modUpdated) {
              log.info("PanelBridge mod updated on server");
            } else {
              log.info("PanelBridge mod auto-installed to server");
            }
          }
        }
      }
    } catch (modError) {
      // Non-fatal - mod install is optional
      log.warn(`Auto-install mod failed: ${modError.message}`);
    }

    res.json({
      success: true,
      message: `Bridge auto-configured from server: ${targetServer.name}`,
      bridgePath: foundPath.path,
      serverName,
      source: foundPath.source,
      hasStatus: foundPath.hasStatus,
      modInstalled,
      modUpdated,
      searchedPaths: searchedLocations,
    });
    log.info(
      `Bridge auto-configured: path=${foundPath.path} source=${foundPath.source} hasStatus=${foundPath.hasStatus} modInstalled=${modInstalled}`,
    );
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Scan for bridge paths for a specific server (preview before applying)
router.get("/scan-server/:serverId", async (req, res) => {
  try {
    const { serverId } = req.params;
    const targetServer = await getServer(serverId);

    if (!targetServer) {
      return res.status(404).json({
        success: false,
        error: `Server with ID ${serverId} not found.`,
      });
    }

    const serverName = targetServer.serverName || targetServer.name;
    if (!serverName) {
      return res
        .status(400)
        .json({ success: false, error: "Server name not configured." });
    }

    const possiblePaths = [];

    // Helper to safely read directory contents
    const safeReadDir = (dirPath) => {
      try {
        return fs.existsSync(dirPath) ? fs.readdirSync(dirPath) : [];
      } catch (e) {
        return [];
      }
    };

    // Helper to add path with metadata
    const addPath = (p, source, priority = 10) => {
      if (possiblePaths.some((pp) => pp.path === p)) return;

      const statusFile = path.join(p, "status.json");
      const initFile = path.join(p, ".init");
      const hasStatus = fs.existsSync(statusFile);
      const hasInit = fs.existsSync(initFile);

      possiblePaths.push({
        path: p,
        source,
        hasStatus,
        hasInit,
        exists: hasStatus || hasInit || fs.existsSync(p),
        priority,
      });
    };

    // Check default Zomboid user folder (B42 without -cachedir)
    const defaultZomboidPath = path.join(
      os.homedir(),
      "Zomboid",
      "Lua",
      "panelbridge",
      serverName,
    );
    addPath(defaultZomboidPath, "default Zomboid folder", 0);

    if (targetServer.installPath) {
      const parentDir = path.dirname(targetServer.installPath);

      // Server_files folders at parent level
      const parentContents = safeReadDir(parentDir);
      for (const item of parentContents) {
        if (item.startsWith("Server_files") || item.match(/Server.*files/i)) {
          const luaPath = path.join(
            parentDir,
            item,
            "Lua",
            "panelbridge",
            serverName,
          );
          addPath(luaPath, `${item}`, 1);
        }
      }

      // Grandparent
      const grandParentDir = path.dirname(parentDir);
      if (grandParentDir !== parentDir) {
        const grandParentContents = safeReadDir(grandParentDir);
        for (const item of grandParentContents) {
          if (item.startsWith("Server_files") || item.match(/Server.*files/i)) {
            const luaPath = path.join(
              grandParentDir,
              item,
              "Lua",
              "panelbridge",
              serverName,
            );
            addPath(luaPath, `${item} (grandparent)`, 2);
          }
        }
      }

      addPath(
        path.join(targetServer.installPath, "Lua", "panelbridge", serverName),
        "installPath/Lua",
        3,
      );
      addPath(
        path.join(parentDir, "Lua", "panelbridge", serverName),
        "parent/Lua",
        4,
      );
    }

    if (targetServer.zomboidDataPath) {
      addPath(
        path.join(
          targetServer.zomboidDataPath,
          "Lua",
          "panelbridge",
          serverName,
        ),
        "zomboidDataPath",
        1,
      );
    }

    // Sort by priority
    possiblePaths.sort((a, b) => {
      if (a.hasStatus && !b.hasStatus) return -1;
      if (!a.hasStatus && b.hasStatus) return 1;
      if (a.hasInit && !b.hasInit) return -1;
      if (!a.hasInit && b.hasInit) return 1;
      return a.priority - b.priority;
    });

    const recommendedPath =
      possiblePaths.find((p) => p.hasStatus) ||
      possiblePaths.find((p) => p.hasInit) ||
      possiblePaths[0] ||
      null;

    res.json({
      success: true,
      serverName,
      serverId: targetServer.id,
      paths: possiblePaths,
      recommendedPath: recommendedPath?.path || null,
      recommendedSource: recommendedPath?.source || null,
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: sanitizeError(error.message) });
  }
});

// Auto-detect bridge path from server name
router.post("/auto-detect", async (req, res) => {
  const { serverName, zomboidUserFolder } = req.body;

  if (!serverName) {
    return res.status(400).json({ error: "serverName is required" });
  }

  try {
    await bridge.stopSftp();
    // Stop bridge first if already running so watcher/poller restarts on new path
    if (bridge.isRunning) {
      bridge.stop();
    }
    const bridgePath = bridge.autoDetect(serverName, zomboidUserFolder);
    bridge.start();
    res.json({
      success: true,
      message: "Bridge auto-configured and started",
      bridgePath,
    });
  } catch (error) {
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

// Configure the bridge with Zomboid save path
router.post("/configure", async (req, res) => {
  const { zomboidSavePath } = req.body;

  if (!zomboidSavePath) {
    return res.status(400).json({ error: "zomboidSavePath is required" });
  }

  try {
    await bridge.stopSftp();
    // Stop bridge first if already running so watcher/poller restarts on new path
    if (bridge.isRunning) {
      bridge.stop();
    }
    const bridgePath = bridge.configure(zomboidSavePath);
    // Also start the bridge automatically after configuring
    bridge.start();
    res.json({
      success: true,
      message: "Bridge configured and started",
      bridgePath,
    });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Configure the bridge with a direct panelbridge folder path (manual override)
router.post("/configure-direct", async (req, res) => {
  const { bridgePath: reqPath } = req.body;

  if (!reqPath || typeof reqPath !== "string") {
    return res.status(400).json({ error: "bridgePath is required" });
  }

  // Basic validation: must be an absolute path
  const resolved = path.resolve(reqPath);
  if (!path.isAbsolute(resolved)) {
    return res.status(400).json({ error: "Path must be absolute" });
  }

  // Block obvious system dirs
  const lower =
    process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const blocked =
    process.platform === "win32"
      ? ["c:\\windows", "c:\\program files"]
      : ["/etc", "/usr", "/bin", "/sbin", "/proc", "/sys", "/dev"];
  if (blocked.some((p) => lower.startsWith(p))) {
    return res
      .status(400)
      .json({ error: "Path targets a protected system directory" });
  }

  try {
    await bridge.stopSftp();
    if (bridge.isRunning) {
      bridge.stop();
    }
    const configuredPath = bridge.configure(resolved, true);
    bridge.start();
    res.json({
      success: true,
      message: "Bridge configured with manual path and started",
      bridgePath: configuredPath,
    });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/sftp/test", requireRole("admin"), async (req, res) => {
  try {
    const config = await resolveSftpConfig(req.body);
    const result = await testSftpBridge(config);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

router.post("/sftp/configure", requireRole("admin"), async (req, res) => {
  try {
    const config = await resolveSftpConfig(req.body);
    for (const [field, key] of Object.entries(SFTP_SETTING_KEYS)) {
      const value = field === "enabled" ? true : config[field];
      if (value !== undefined) await setSetting(key, value);
    }
    const cachePath = getSftpCachePath(config);
    await bridge.configureSftp(config, cachePath);
    res.json({ success: true, bridgePath: cachePath, transport: bridge.getStatus().transport });
  } catch (error) {
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

router.post("/sftp/logs/list", requireRole("admin"), async (req, res) => {
  try {
    const config = await resolveSftpLogConfig(req.body);
    const result = await listSftpLogs(config);
    if (req.body?.logPath) await setSetting(SFTP_LOG_PATH_KEY, config.logPath);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

router.post("/sftp/logs/tail", requireRole("admin"), async (req, res) => {
  try {
    const config = await resolveSftpLogConfig(req.body);
    const result = await readSftpLogTail(config, req.body?.name, req.body?.maxBytes);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

// Start the bridge polling
router.post("/start", (req, res) => {
  try {
    bridge.start();
    res.json({ success: true, message: "Bridge started" });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Stop the bridge
router.post("/stop", async (req, res) => {
  try {
    await bridge.stopSftp();
    bridge.stop();
    res.json({ success: true, message: "Bridge stopped" });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Scan for all panelbridge folders across known locations
router.get("/scan-paths", async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    const foundBridges = [];
    const scannedDirs = [];

    // Helper to recursively search for panelbridge folders
    const searchForBridge = (baseDir, depth = 0, maxDepth = 3) => {
      if (depth > maxDepth || !baseDir || !fs.existsSync(baseDir)) return;

      try {
        const contents = fs.readdirSync(baseDir, { withFileTypes: true });

        for (const item of contents) {
          if (!item.isDirectory()) continue;

          const itemPath = path.join(baseDir, item.name);

          // Check if this is a panelbridge folder
          if (item.name === "panelbridge") {
            // List server folders inside
            try {
              const serverFolders = fs.readdirSync(itemPath, {
                withFileTypes: true,
              });
              for (const sf of serverFolders) {
                if (!sf.isDirectory()) continue;

                const serverPath = path.join(itemPath, sf.name);
                const statusFile = path.join(serverPath, "status.json");
                const initFile = path.join(serverPath, ".init");
                const hasStatus = fs.existsSync(statusFile);
                const hasInit = fs.existsSync(initFile);

                let statusAge = null;
                let modVersion = null;
                if (hasStatus) {
                  try {
                    const stats = fs.statSync(statusFile);
                    statusAge = Date.now() - stats.mtimeMs;
                    const content = JSON.parse(
                      fs.readFileSync(statusFile, "utf-8"),
                    );
                    modVersion = content.version;
                  } catch (e) {
                    log.debug(
                      `Failed to parse status for ${sf.name}: ${e.message}`,
                    );
                  }
                }

                foundBridges.push({
                  path: serverPath,
                  serverName: sf.name,
                  baseDir,
                  hasStatus,
                  hasInit,
                  statusAge,
                  modVersion,
                  isActive: statusAge !== null && statusAge < 60000, // Active if updated in last minute
                });
              }
            } catch (e) {
              log.debug(
                `Failed to scan panelbridge folder in ${itemPath}: ${e.message}`,
              );
            }
            continue;
          }

          // Look for Lua folder
          if (item.name === "Lua") {
            const bridgePath = path.join(itemPath, "panelbridge");
            if (fs.existsSync(bridgePath)) {
              scannedDirs.push(bridgePath);
              searchForBridge(bridgePath, depth + 1, maxDepth);
            }
            continue;
          }

          // Look for Server_files* folders
          if (
            item.name.startsWith("Server_files") ||
            item.name.match(/Server.*files/i)
          ) {
            scannedDirs.push(itemPath);
            searchForBridge(itemPath, depth + 1, maxDepth);
          }
        }
      } catch (e) {
        // Ignore errors reading directories
      }
    };

    // Build list of directories to search
    const searchDirs = new Set();

    if (activeServer?.installPath) {
      searchDirs.add(activeServer.installPath);
      searchDirs.add(path.dirname(activeServer.installPath));
    }

    if (activeServer?.zomboidDataPath) {
      searchDirs.add(activeServer.zomboidDataPath);
      searchDirs.add(path.dirname(activeServer.zomboidDataPath));
    }

    // Also check the current bridge path if set
    if (bridge.bridgePath) {
      const parts = bridge.bridgePath.split(path.sep);
      const panelbridgeIdx = parts.indexOf("panelbridge");
      if (panelbridgeIdx > 0) {
        searchDirs.add(parts.slice(0, panelbridgeIdx).join(path.sep));
      }
    }

    // Search all directories
    for (const dir of searchDirs) {
      if (dir) {
        scannedDirs.push(dir);
        searchForBridge(dir);
      }
    }

    res.json({
      foundBridges,
      scannedDirs: [...new Set(scannedDirs)],
      currentPath: bridge.bridgePath,
      isRunning: bridge.isRunning,
      modConnected: bridge.isModConnected(),
    });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Force refresh - restart bridge with fresh state
router.post("/refresh", (req, res) => {
  try {
    if (bridge.isRunning) {
      bridge.stop(); // stop() already resets all internal state
    }

    if (bridge.bridgePath) {
      bridge.start();
      res.json({
        success: true,
        message: "Bridge refreshed",
        bridgePath: bridge.bridgePath,
      });
    } else {
      res.json({
        success: false,
        message: "Bridge not configured - use auto-configure first",
      });
    }
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Ping the mod
router.get("/ping", async (req, res) => {
  if (!bridge.bridgePath) {
    return res.status(400).json({ error: "Bridge not configured" });
  }

  try {
    const result = await bridge.ping();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Send a command to the game. Admin-gated for consistency with the other
// powerful/destructive routes (backup restore, chunk deletion, server wipe)
// — this is the generic passthrough for ANY PanelBridge handler (teleport,
// giveItem, character import/export, horde spawning, etc.), not just the
// curated preset buttons in the Events UI. Every account is currently
// created as 'admin' (see auth.js), so this has no effect today, but keeps
// the route safe if a lower-privilege role is ever introduced.
router.post("/command", requireRole("admin"), async (req, res) => {
  const activeServer = await getActiveServer();
  if (activeServer?.isRemote && !bridge.isSftpRunning() && !bridge.isRunning) {
    return res.status(400).json({
      error:
        "PanelBridge requires a configured mapped drive or a running SFTP bridge transport for remote servers.",
    });
  }

  const { action, args } = req.body;

  if (!action) {
    return res.status(400).json({ error: "action is required" });
  }

  // Validate action against whitelist
  if (typeof action !== "string" || !VALID_ACTIONS.has(action)) {
    return res.status(400).json({ error: "Unknown or invalid action" });
  }

  // Validate args if provided
  if (
    args !== undefined &&
    (typeof args !== "object" || args === null || Array.isArray(args))
  ) {
    return res.status(400).json({ error: "args must be an object" });
  }

  // Build 42 does not expose a Lua vehicle-spawn API. The RCON command is
  // the supported server path and returns its result directly to the map.
  if (action === "spawnVehicleAt") {
    const vehicle = args?.vehicle ?? args?.scriptName;
    const x = Number(args?.x);
    const y = Number(args?.y);
    const z = Number(args?.z ?? 0);
    if (typeof vehicle !== "string" || !VEHICLE_SCRIPT_REGEX.test(vehicle)) {
      return res.status(400).json({ error: "Invalid vehicle script name" });
    }
    if (
      !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) ||
      x < 0 || x > 24000 || y < 0 || y > 24000 || z < 0 || z > 8 ||
      (x === 0 && y === 0)
    ) {
      return res.status(400).json({ error: "Invalid coordinates (x/y: 0-24000, z: 0-8)" });
    }

    try {
      const result = await req.app.get("rconService").addVehicleAt(vehicle, x, y, z);
      logBridgeCommand(action, args, result, result.success, 0).catch(() => {});
      return res.json({
        ...result,
        data: result.success ? {
          message: "Vehicle spawn requested",
          scriptName: vehicle,
          x: Math.floor(x),
          y: Math.floor(y),
          z: Math.floor(z),
        } : undefined,
      });
    } catch (error) {
      const message = sanitizeError(error?.message || "Vehicle spawn failed");
      logBridgeCommand(action, args, { error: message }, false, 0).catch(() => {});
      return res.status(500).json({ success: false, error: message });
    }
  }

  if (!bridge.bridgePath) {
    return res.status(400).json({ error: "Bridge not configured" });
  }

  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }

  // Action-specific validation
  if (action === "airdrop" && args) {
    const VALID_PRESETS = [
      "military",
      "medical",
      "food",
      "building",
      "weapons",
      "tools",
    ];
    const x = Number(args.x),
      y = Number(args.y);
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      x > 24000 ||
      y < 0 ||
      y > 24000
    ) {
      return res
        .status(400)
        .json({ error: "Invalid airdrop coordinates (valid: 0-24000)" });
    }
    if (
      args.preset &&
      (typeof args.preset !== "string" || !VALID_PRESETS.includes(args.preset))
    ) {
      return res
        .status(400)
        .json({ error: `Invalid preset. Valid: ${VALID_PRESETS.join(", ")}` });
    }
    if (args.items && (!Array.isArray(args.items) || args.items.length > 50)) {
      return res
        .status(400)
        .json({ error: "items must be an array with at most 50 entries" });
    }
    if (Array.isArray(args.items)) {
      for (const entry of args.items) {
        if (!entry || typeof entry !== "object") {
          return res
            .status(400)
            .json({ error: "Each item must be an object with itemType" });
        }
        if (
          typeof entry.itemType !== "string" ||
          !ITEM_TYPE_REGEX.test(entry.itemType)
        ) {
          return res.status(400).json({
            error: `Invalid item type format: ${String(entry.itemType).slice(0, 60)}`,
          });
        }
        if (
          entry.count !== undefined &&
          (typeof entry.count !== "number" ||
            entry.count < 1 ||
            entry.count > 20)
        ) {
          return res.status(400).json({ error: "Item count must be 1-20" });
        }
      }
    }
  }

  const startTime = Date.now();
  try {
    log.info(
      `POST /command: action=${action} args=${JSON.stringify(args || {}).substring(0, 200)}`,
    );
    const result = await bridge.sendCommand(action, args || {});
    const durationMs = Date.now() - startTime;
    log.debug(`POST /command: action=${action} completed in ${durationMs}ms`);
    logBridgeCommand(action, args, result, true, durationMs).catch(() => {});
    res.json(result);
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const message = sanitizeError(error?.message || "Bridge command failed");
    logBridgeCommand(action, args, { error: message }, false, durationMs).catch(
      () => {},
    );

    if (/timeout/i.test(message)) {
      return res.status(504).json({ error: message, category: "timeout" });
    }
    if (
      /not configured|not running|unhealthy|not responding|stale|missing/i.test(
        message,
      )
    ) {
      return res
        .status(503)
        .json({ error: message, category: "bridge-unavailable" });
    }
    if (/invalid|required/i.test(message)) {
      return res.status(400).json({ error: message, category: "validation" });
    }

    return res.status(500).json({ error: message, category: "unknown" });
  }
});

// Get weather info
router.get("/weather", async (req, res) => {
  if (!bridge.bridgePath) {
    return res.status(400).json({ error: "Bridge not configured" });
  }
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }

  try {
    const result = await bridge.getWeather();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get server info
router.get("/server-info", async (req, res) => {
  if (!bridge.bridgePath) {
    return res.status(400).json({ error: "Bridge not configured" });
  }
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }

  try {
    const result = await bridge.getServerInfo();
    // Lua JSON encodes empty tables as {} (object) instead of [] (array)
    if (result?.data?.players && !Array.isArray(result.data.players)) {
      result.data.players = Object.values(result.data.players);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Weather control endpoints
router.post("/weather/blizzard", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { duration } = req.body;
  try {
    const result = await bridge.triggerBlizzard(duration);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/tropical-storm", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { duration } = req.body;
  try {
    const result = await bridge.triggerTropicalStorm(duration);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/storm", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { duration } = req.body;
  if (
    duration !== undefined &&
    (typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration < 0 ||
      duration > 168)
  ) {
    return res
      .status(400)
      .json({ error: "duration must be a number 0-168 (hours)" });
  }
  try {
    const result = await bridge.triggerStorm(duration);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/stop", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  try {
    const result = await bridge.stopWeather();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Generate weather period
router.post("/weather/generate", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { strength, frontType } = req.body;
  if (
    strength !== undefined &&
    (typeof strength !== "number" ||
      !Number.isFinite(strength) ||
      strength < 0 ||
      strength > 1)
  ) {
    return res.status(400).json({ error: "strength must be a number 0-1" });
  }
  if (
    frontType !== undefined &&
    (typeof frontType !== "number" ||
      !Number.isInteger(frontType) ||
      frontType < 0 ||
      frontType > 5)
  ) {
    return res.status(400).json({ error: "frontType must be an integer 0-5" });
  }
  try {
    const result = await bridge.generateWeather(
      strength ?? 0.5,
      frontType ?? 0,
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/snow", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { enabled, intensity } = req.body;
  if (
    intensity !== undefined &&
    intensity !== null &&
    (typeof intensity !== "number" ||
      !Number.isFinite(intensity) ||
      intensity < 0 ||
      intensity > 1)
  ) {
    return res.status(400).json({ error: "intensity must be a number 0-1" });
  }
  try {
    const result = await bridge.setSnow(enabled !== false, intensity ?? null);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// =============================================
// NEW V1.1.0 ENDPOINTS
// =============================================

// Rain control
router.post("/weather/rain/start", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { intensity } = req.body;
  if (
    intensity !== undefined &&
    (typeof intensity !== "number" ||
      !Number.isFinite(intensity) ||
      intensity < 0 ||
      intensity > 1)
  ) {
    return res.status(400).json({ error: "intensity must be a number 0-1" });
  }
  try {
    const result = await bridge.startRain(intensity ?? 0.5);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/rain/stop", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  try {
    const result = await bridge.stopRain();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Lightning
router.post("/weather/lightning", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { x, y, strike, light, rumble } = req.body;
  if (x !== undefined && (typeof x !== "number" || !Number.isFinite(x))) {
    return res.status(400).json({ error: "x must be a number" });
  }
  if (y !== undefined && (typeof y !== "number" || !Number.isFinite(y))) {
    return res.status(400).json({ error: "y must be a number" });
  }
  try {
    const result = await bridge.triggerLightning(x, y, strike, light, rumble);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Climate float control
router.get("/climate/floats", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  try {
    const result = await bridge.getClimateFloats();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/climate/float", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { floatId, value, enable } = req.body;
  if (floatId === undefined || value === undefined) {
    return res.status(400).json({ error: "floatId and value are required" });
  }
  if (
    typeof floatId !== "number" ||
    !Number.isInteger(floatId) ||
    floatId < 0 ||
    floatId > 12
  ) {
    return res.status(400).json({ error: "floatId must be an integer 0-12" });
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return res.status(400).json({ error: "value must be a number" });
  }
  try {
    const result = await bridge.setClimateFloat(
      floatId,
      value,
      enable !== false,
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/climate/reset", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  try {
    const result = await bridge.resetClimateOverrides();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Individual climate shortcuts
router.post("/climate/temperature", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { value } = req.body;
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < -50 ||
      value > 50)
  ) {
    return res.status(400).json({ error: "value must be a number -50 to 50" });
  }
  try {
    const result = await bridge.setTemperature(value ?? 22);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/climate/wind", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { value } = req.body;
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1)
  ) {
    return res.status(400).json({ error: "value must be a number 0-1" });
  }
  try {
    const result = await bridge.setWind(value ?? 0.5);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/climate/fog", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { value } = req.body;
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1)
  ) {
    return res.status(400).json({ error: "value must be a number 0-1" });
  }
  try {
    const result = await bridge.setFog(value ?? 0);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/climate/clouds", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { value } = req.body;
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1)
  ) {
    return res.status(400).json({ error: "value must be a number 0-1" });
  }
  try {
    const result = await bridge.setClouds(value ?? 0);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Game time endpoints
router.get("/time", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  try {
    const result = await bridge.getGameTime();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/time", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { hour, day, month, year } = req.body;
  if (
    hour !== undefined &&
    (typeof hour !== "number" ||
      !Number.isInteger(hour) ||
      hour < 0 ||
      hour > 23)
  ) {
    return res.status(400).json({ error: "hour must be an integer 0-23" });
  }
  if (
    day !== undefined &&
    (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 31)
  ) {
    return res.status(400).json({ error: "day must be an integer 1-31" });
  }
  if (
    month !== undefined &&
    (typeof month !== "number" ||
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12)
  ) {
    return res.status(400).json({ error: "month must be an integer 1-12" });
  }
  if (
    year !== undefined &&
    (typeof year !== "number" ||
      !Number.isInteger(year) ||
      year < 1 ||
      year > 9999)
  ) {
    return res.status(400).json({ error: "year must be an integer 1-9999" });
  }
  try {
    const result = await bridge.setGameTime({ hour, day, month, year });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// World stats
router.get("/world/stats", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  try {
    const result = await bridge.getWorldStats();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Save world
router.post("/world/save", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  try {
    const result = await bridge.saveWorld();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Player endpoints
router.get("/players", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  try {
    const result = await bridge.getAllPlayerDetails();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/players/:username", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  if (!BRIDGE_USERNAME_REGEX.test(req.params.username)) {
    return res.status(400).json({ error: "Invalid username format" });
  }
  try {
    const result = await bridge.getPlayerDetails(req.params.username);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to get player details" });
  }
});

router.post("/players/:username/teleport", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  if (!BRIDGE_USERNAME_REGEX.test(req.params.username)) {
    return res.status(400).json({ error: "Invalid username format" });
  }
  const { x, y, z } = req.body;
  if (x === undefined || y === undefined) {
    return res.status(400).json({ error: "x and y coordinates are required" });
  }
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    (z !== undefined && typeof z !== "number")
  ) {
    return res.status(400).json({ error: "Coordinates must be numbers" });
  }
  if (x < 0 || x > 24000 || y < 0 || y > 24000) {
    return res
      .status(400)
      .json({ error: "x/y coordinates out of range (0-24000)" });
  }
  if (z !== undefined && (z < 0 || z > 8)) {
    return res.status(400).json({ error: "z coordinate out of range (0-8)" });
  }
  try {
    const result = await bridge.teleportPlayer(req.params.username, x, y, z);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Teleport failed" });
  }
});

// Server message (routed via sendToServerChat; no dedicated sendServerMessage Lua handler)
router.post("/message", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { message } = req.body;
  if (!message || typeof message !== "string" || message.length > 2000) {
    return res
      .status(400)
      .json({ error: "message is required (max 2000 chars)" });
  }
  try {
    const result = await bridge.sendCommand("sendToServerChat", {
      message,
      isAlert: true,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Sandbox options (read-only)
router.get("/sandbox", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  try {
    const result = await bridge.getSandboxOptions();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get available commands (complete reference for all 60 Lua handlers)
router.get("/commands", (req, res) => {
  res.json({
    commands: [
      // === Basic / Utility ===
      { action: "ping", description: "Health check", args: {} },
      {
        action: "getServerInfo",
        description: "Get server info and player list",
        args: {},
      },
      { action: "saveWorld", description: "Trigger world save", args: {} },

      // === Weather ===
      {
        action: "getWeather",
        description: "Get current weather data",
        args: {},
      },
      {
        action: "triggerBlizzard",
        description: "Trigger a blizzard",
        args: { duration: "number (hours, default: 2.0)" },
      },
      {
        action: "triggerTropicalStorm",
        description: "Trigger tropical storm",
        args: { duration: "number (hours, default: 2.0)" },
      },
      {
        action: "triggerStorm",
        description: "Trigger a storm",
        args: { duration: "number (hours, default: 2.0)" },
      },
      { action: "stopWeather", description: "Stop all weather", args: {} },
      {
        action: "generateWeather",
        description: "Generate weather period",
        args: {
          strength: "number 0-1 (default: 0.5)",
          frontType: "number 0=stationary, 1=cold, 2=warm (default: 0)",
        },
      },
      {
        action: "setSnow",
        description: "Enable/disable snow (auto-enables rain)",
        args: {
          enabled: "boolean (default: true)",
          intensity: "number 0-1 (optional, for rain start)",
        },
      },
      {
        action: "startRain",
        description: "Start rain",
        args: { intensity: "number 0-1 (default: 0.5)" },
      },
      { action: "stopRain", description: "Stop rain", args: {} },
      {
        action: "triggerLightning",
        description: "Trigger lightning bolt",
        args: {
          x: "number (optional)",
          y: "number (optional)",
          strike: "boolean (default: true)",
          light: "boolean (default: true)",
          rumble: "boolean (default: true)",
        },
      },

      // === Climate Control ===
      {
        action: "getClimateFloats",
        description: "Get all climate float values (IDs 0-12)",
        args: {},
      },
      {
        action: "setClimateFloat",
        description: "Set climate float by ID",
        args: {
          floatId: "number 0-12 (required)",
          value: "number (required)",
          enable: "boolean (default: true)",
        },
      },
      {
        action: "resetClimateOverrides",
        description: "Reset all admin climate overrides",
        args: {},
      },
      {
        action: "setTemperature",
        description: "Set temperature (Celsius)",
        args: { value: "number -50 to +50 (default: 22)" },
      },
      {
        action: "setWind",
        description: "Set wind intensity",
        args: { value: "number 0-1 (default: 0.5)" },
      },
      {
        action: "setFog",
        description: "Set fog intensity",
        args: { value: "number 0-1 (default: 0)" },
      },
      {
        action: "setClouds",
        description: "Set cloud intensity",
        args: { value: "number 0-1 (default: 0)" },
      },

      // === Visual / Lighting ===
      {
        action: "setDayLight",
        description: "Set daylight strength",
        args: { value: "number 0-1 (default: 1.0)" },
      },
      {
        action: "setNightStrength",
        description: "Set night strength",
        args: { value: "number 0-1 (default: 0)" },
      },
      {
        action: "setDesaturation",
        description: "Set desaturation level",
        args: { value: "number 0-1 (default: 0)" },
      },
      {
        action: "setViewDistance",
        description: "Set view distance",
        args: { value: "number 0-1 (default: 1.0)" },
      },
      {
        action: "setAmbient",
        description: "Set ambient light",
        args: { value: "number 0-1 (default: 1.0)" },
      },

      // === Time ===
      {
        action: "getGameTime",
        description: "Get current game time/date",
        args: {},
      },
      {
        action: "setGameTime",
        description: "Set game time/date (only sent fields are changed)",
        args: {
          hour: "number (optional)",
          day: "number (optional)",
          month: "number 1-12 (optional)",
          year: "number (optional)",
        },
      },

      // === World / Config ===
      {
        action: "getWorldStats",
        description: "Get world statistics",
        args: {},
      },
      {
        action: "getSandboxOptions",
        description: "Get sandbox options (read-only)",
        args: {},
      },

      // === Players ===
      {
        action: "getAllPlayerDetails",
        description: "Get detailed info for all online players",
        args: {},
      },
      {
        action: "getPlayerDetails",
        description: "Get detailed info for a player",
        args: { username: "string (required)" },
      },
      {
        action: "teleportPlayer",
        description: "Teleport a player",
        args: {
          username: "string (required)",
          x: "number (required)",
          y: "number (required)",
          z: "number (default: 0)",
        },
      },
      {
        action: "healPlayer",
        description: "Fully heal a player",
        args: { username: "string (required)" },
      },
      {
        action: "killPlayer",
        description: "Kill a player",
        args: { username: "string (required)" },
      },
      {
        action: "setGodMode",
        description: "Toggle god mode",
        args: {
          username: "string (required)",
          enabled: "boolean (default: false)",
        },
      },
      {
        action: "setInvisible",
        description: "Toggle invisibility",
        args: {
          username: "string (required)",
          enabled: "boolean (default: false)",
        },
      },
      {
        action: "giveItem",
        description: "Give item to player",
        args: {
          username: "string (required)",
          itemType: 'string e.g. "Base.Axe" (required)',
          count: "number 1-100 (default: 1)",
        },
      },

      // === Character Export/Import ===
      {
        action: "exportPlayerData",
        description: "Export full character data (perks, inventory, traits)",
        args: { username: "string (required)" },
      },
      {
        action: "importPlayerData",
        description: "Import/restore character data",
        args: {
          username: "string (required)",
          data: "object (required, from export)",
          options:
            "{ restorePerks: boolean, restoreInventory: boolean } (optional, both default true)",
        },
      },

      // === Chat ===
      {
        action: "sendToServerChat",
        description:
          "Send message to server chat (isAlert=true for system announcement)",
        args: {
          message: "string (required)",
          isAlert: "boolean (default: false)",
        },
      },
      {
        action: "sendToAdminChat",
        description: "Send message to admin-only chat",
        args: { message: "string (required)" },
      },
      {
        action: "sendToGeneralChat",
        description: "Send message to general chat with custom author",
        args: {
          message: "string (required)",
          author: 'string (default: "[Panel]")',
        },
      },
      {
        action: "getChatInfo",
        description: "Get available chat types",
        args: {},
      },

      // === Sound / Noise ===
      {
        action: "playWorldSound",
        description: "Create zombie-attracting sound at coordinates",
        args: {
          x: "number (required)",
          y: "number (required)",
          z: "number (default: 0)",
          radius: "number (default: 50)",
          volume: "number (default: 100)",
        },
      },
      {
        action: "playSoundNearPlayer",
        description: "Create sound at player location",
        args: {
          username: "string (required)",
          radius: "number (default: 50)",
          volume: "number (default: 100)",
        },
      },
      {
        action: "triggerGunshot",
        description: "Simulate gunshot (150m radius)",
        args: {
          x: "number",
          y: "number",
          username: "string (alternative to x/y)",
        },
      },
      {
        action: "triggerAlarmSound",
        description: "Trigger alarm sound (80m radius)",
        args: {
          x: "number",
          y: "number",
          username: "string (alternative to x/y)",
        },
      },
      {
        action: "createNoise",
        description: "Create custom noise",
        args: {
          x: "number",
          y: "number",
          radius: "number 10-500 (default: 100)",
          volume: "number 1-500 (default: 100)",
          username: "string (alternative to x/y)",
        },
      },

      // === Utilities (Power/Water) ===
      {
        action: "getUtilitiesStatus",
        description: "Get power/water status",
        args: {},
      },
      {
        action: "restoreUtilities",
        description: "Restore power and/or water",
        args: {
          power: "boolean (default: true)",
          water: "boolean (default: true)",
        },
      },
      {
        action: "shutOffUtilities",
        description: "Shut off power and/or water",
        args: {
          power: "boolean (default: true)",
          water: "boolean (default: true)",
        },
      },

      // === Zombies ===
      {
        action: "getZombieCount",
        description: "Get zombie count in loaded cells",
        args: {},
      },
      {
        action: "clearZombiesNearPlayer",
        description: "Remove zombies near a player",
        args: { username: "string (required)", radius: "number (default: 50)" },
      },
      {
        action: "clearAllZombies",
        description: "Remove ALL zombies from loaded cells",
        args: {},
      },
      {
        action: "spawnHordeNearPlayer",
        description: "Spawn horde 50-70 tiles from player",
        args: {
          username: "string (required)",
          count: "number 1-500 (default: 50)",
        },
      },
      {
        action: "spawnHordeBehindPlayer",
        description: "Spawn horde behind player based on facing direction",
        args: {
          username: "string (required)",
          count: "number 1-500 (default: 50)",
        },
      },

      // === Safehouses ===
      {
        action: "getSafehouses",
        description: "List all safehouses and key metadata",
        args: {},
      },
      {
        action: "safehouseAddPlayer",
        description: "Add player to safehouse members",
        args: {
          safehouseRef: "string id/title (required)",
          username: "string (required)",
        },
      },
      {
        action: "safehouseRemovePlayer",
        description: "Remove player from safehouse members",
        args: {
          safehouseRef: "string id/title (required)",
          username: "string (required)",
        },
      },
      {
        action: "safehouseSetOwner",
        description: "Transfer safehouse ownership",
        args: {
          safehouseRef: "string id/title (required)",
          owner: "string (required)",
        },
      },
      {
        action: "safehouseSetRespawn",
        description: "Enable/disable respawn in safehouse for user",
        args: {
          safehouseRef: "string id/title (required)",
          username: "string (required)",
          enabled: "boolean (required)",
        },
      },

      // === Factions ===
      {
        action: "getFactions",
        description: "List all factions with members",
        args: {},
      },
      {
        action: "createFaction",
        description: "Create a faction",
        args: { name: "string (required)", owner: "string (required)" },
      },
      {
        action: "factionAddPlayer",
        description: "Add player to faction",
        args: {
          factionName: "string (required)",
          username: "string (required)",
        },
      },
      {
        action: "factionRemovePlayer",
        description: "Remove player from faction",
        args: {
          factionName: "string (required)",
          username: "string (required)",
        },
      },
      {
        action: "factionSetTag",
        description: "Set faction tag",
        args: {
          factionName: "string (required)",
          tag: "string (required, max 8)",
        },
      },
      {
        action: "removeFaction",
        description: "Remove faction entirely",
        args: { factionName: "string (required)" },
      },

      // === Vehicles ===
      {
        action: "getVehiclesDetailed",
        description: "List loaded vehicles with telemetry",
        args: {},
      },
      {
        action: "vehicleRepair",
        description: "Repair a vehicle",
        args: { vehicleId: "number (required)" },
      },
      {
        action: "vehicleSetAlarm",
        description: "Toggle vehicle alarm and optionally trigger",
        args: { vehicleId: "number (required)", enabled: "boolean (required)" },
      },
      {
        action: "vehicleSetSiren",
        description: "Set vehicle siren mode",
        args: {
          vehicleId: "number (required)",
          mode: "number (optional)",
          enabled: "boolean (optional fallback)",
        },
      },
      {
        action: "vehicleSetTrunkLocked",
        description: "Lock/unlock vehicle trunk",
        args: { vehicleId: "number (required)", locked: "boolean (required)" },
      },

      // === AI Director ===
      {
        action: "triggerSwarmEvent",
        description: "Spawn a zombie swarm in rectangular area",
        args: {
          count: "number 1-500 (default: 25)",
          x1: "number (required)",
          y1: "number (required)",
          x2: "number (required)",
          y2: "number (required)",
        },
      },
      {
        action: "runEventSequence",
        description:
          "Execute chained operation steps (chat/weather/swarm/utilities/noise)",
        args: {
          steps: "array (required)",
          maxSteps: "number 1-50 (optional default: 20)",
        },
      },

      // === Infrastructure Map ===
      {
        action: "getInfrastructureSnapshot",
        description:
          "Get hydro/weather/temperature and optional sampled point data",
        args: {
          x: "number (optional)",
          y: "number (optional)",
          z: "number (optional default: 0)",
        },
      },
      {
        action: "addLamppost",
        description: "Add temporary light source",
        args: {
          x: "number (required)",
          y: "number (required)",
          z: "number (optional default: 0)",
          r: "number 0-1",
          g: "number 0-1",
          b: "number 0-1",
          radius: "number 1-30",
        },
      },
      {
        action: "removeLamppost",
        description: "Remove temporary light source",
        args: {
          x: "number (required)",
          y: "number (required)",
          z: "number (optional default: 0)",
        },
      },

      // === Moderation Automation ===
      {
        action: "moderationKickUser",
        description: "Kick a user through BanSystem",
        args: {
          username: "string (required)",
          reason: "string (optional)",
          description: "string (optional)",
        },
      },
      {
        action: "moderationBanUser",
        description: "Ban/unban user through BanSystem",
        args: {
          username: "string (required)",
          reason: "string (optional)",
          ban: "boolean (default: true)",
        },
      },
      {
        action: "moderationBanIP",
        description: "Ban/unban IP through BanSystem",
        args: {
          ip: "string (required)",
          reason: "string (optional)",
          ban: "boolean (default: true)",
        },
      },
      {
        action: "moderationBanSteamID",
        description: "Ban/unban SteamID through BanSystem",
        args: {
          steamId: "string (required)",
          reason: "string (optional)",
          ban: "boolean (default: true)",
        },
      },

      // === Debug ===
      {
        action: "getDebugLog",
        description: "Get mod debug log entries",
        args: {
          limit: "number (default: 50)",
          minLevel: "string: DEBUG|INFO|WARN|ERROR (default: DEBUG)",
        },
      },
      { action: "getStats", description: "Get mod statistics", args: {} },
      {
        action: "setDebugMode",
        description: "Toggle verbose logging",
        args: { enabled: "boolean (required)" },
      },
      {
        action: "checkAPI",
        description: "Check API method availability",
        args: {
          object: "string (default: ClimateManager)",
          method: "string (optional, specific method to check)",
        },
      },
      {
        action: "getAvailableHandlers",
        description: "List all available command handlers",
        args: {},
      },
      { action: "clearErrors", description: "Clear mod error log", args: {} },
    ],
    climateFloatIds: {
      0: "FLOAT_DESATURATION",
      1: "FLOAT_GLOBAL_LIGHT_INTENSITY",
      2: "FLOAT_NIGHT_STRENGTH",
      3: "FLOAT_PRECIPITATION_INTENSITY",
      4: "FLOAT_TEMPERATURE",
      5: "FLOAT_FOG_INTENSITY",
      6: "FLOAT_WIND_INTENSITY",
      7: "FLOAT_WIND_ANGLE_INTENSITY",
      8: "FLOAT_CLOUD_INTENSITY",
      9: "FLOAT_AMBIENT",
      10: "FLOAT_VIEW_DISTANCE",
      11: "FLOAT_DAYLIGHT_STRENGTH",
      12: "FLOAT_HUMIDITY",
    },
  });
});

// Get mod installation path (for copying mod to server)
router.get("/mod-path", async (req, res) => {
  // Path to the bundled mod - check multiple locations for packaged exe
  const possiblePaths = [
    path.join(process.cwd(), "pz-mod", "PanelBridge"),
    path.join(path.dirname(process.execPath), "pz-mod", "PanelBridge"),
    path.join(__dirname, "..", "..", "pz-mod", "PanelBridge"),
  ];

  let modPath = possiblePaths[0];
  let exists = false;

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      modPath = p;
      exists = true;
      break;
    }
  }

  // Also detect suggested install path from active server
  let suggestedInstallPath = null;
  try {
    const activeServer = await getActiveServer();
    if (activeServer?.installPath) {
      // For dedicated servers, Lua folder is at: {installPath}/media/lua/server/
      suggestedInstallPath = path.join(
        activeServer.installPath,
        "media",
        "lua",
        "server",
      );
    }
  } catch (e) {
    // Ignore
  }

  res.json({
    modPath,
    exists,
    files: exists ? fs.readdirSync(modPath) : [],
    suggestedInstallPath,
  });
});

// Auto-install mod to server's Lua folder (optionally specify serverId)
router.post("/install-mod-auto", async (req, res) => {
  try {
    const { serverId } = req.body;

    // Get specified server or active server
    let targetServer;
    if (serverId) {
      targetServer = await getServer(serverId);
      if (!targetServer) {
        return res
          .status(400)
          .json({ error: `Server with ID ${serverId} not found.` });
      }
    } else {
      targetServer = await getActiveServer();
      if (!targetServer) {
        return res.status(400).json({ error: "No active server configured." });
      }
    }

    // Use serverPath if available, otherwise extract directory from installPath
    let serverInstallDir = targetServer.serverPath || targetServer.installPath;
    if (!serverInstallDir) {
      return res
        .status(400)
        .json({ error: "Server install path not configured." });
    }

    // If installPath points to a file (e.g., .bat), extract the directory
    if (
      serverInstallDir.endsWith(".bat") ||
      serverInstallDir.endsWith(".sh") ||
      serverInstallDir.endsWith(".exe")
    ) {
      serverInstallDir = path.dirname(serverInstallDir);
    }

    // Install to: {serverInstallDir}/media/lua/server/PanelBridge.lua
    const luaServerPath = path.join(serverInstallDir, "media", "lua", "server");
    const destLuaFile = path.join(luaServerPath, "PanelBridge.lua");

    // Prefer embedded Lua (guaranteed to match running binary version).
    let srcContent = getEmbeddedPanelBridgeLua();
    let sourceLocation = srcContent ? "embedded" : null;

    if (!srcContent) {
      const possiblePaths = [
        path.join(__dirname, "..", "..", "pz-mod", "PanelBridge"),
        path.join(process.cwd(), "pz-mod", "PanelBridge"),
        path.join(path.dirname(process.execPath), "pz-mod", "PanelBridge"),
      ];
      for (const p of possiblePaths) {
        const candidate = path.join(
          p,
          "media",
          "lua",
          "server",
          "PanelBridge.lua",
        );
        if (fs.existsSync(candidate)) {
          srcContent = fs.readFileSync(candidate, "utf8");
          sourceLocation = candidate;
          break;
        }
      }
    }

    if (!srcContent) {
      return res.status(404).json({
        error: "Source mod not found (no embedded Lua and no on-disk pz-mod).",
      });
    }

    writeLuaAtomic(destLuaFile, srcContent);

    res.json({
      success: true,
      message: "PanelBridge.lua installed to server Lua folder",
      path: destLuaFile,
      source: sourceLocation,
      serverName: targetServer.serverName || targetServer.name,
    });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Copy mod to server Lua folder (manual path)
router.post("/install-mod", (req, res) => {
  const { serverLuaPath } = req.body;

  // Support legacy field name
  const targetPath = serverLuaPath || req.body.serverModsPath;

  if (!targetPath) {
    return res
      .status(400)
      .json({ error: "serverLuaPath is required (path to media/lua/server/)" });
  }

  // Validate path: must be a string, absolute, no traversal
  if (typeof targetPath !== "string" || targetPath.length > 500) {
    return res.status(400).json({ error: "Invalid path format" });
  }

  const resolvedTarget = path.resolve(targetPath);

  // Must be absolute
  if (!path.isAbsolute(resolvedTarget)) {
    return res.status(400).json({ error: "Must be an absolute path" });
  }

  // Resolve symlinks to prevent traversal via symlink chains
  let realTarget;
  try {
    // If target doesn't exist yet, resolve the parent and join
    if (fs.existsSync(resolvedTarget)) {
      realTarget = fs.realpathSync(resolvedTarget);
    } else {
      const parent = path.dirname(resolvedTarget);
      if (fs.existsSync(parent)) {
        realTarget = path.join(
          fs.realpathSync(parent),
          path.basename(resolvedTarget),
        );
      } else {
        realTarget = resolvedTarget;
      }
    }
  } catch (e) {
    log.debug(`Path resolution failed for deploy target: ${e.message}`);
    realTarget = resolvedTarget;
  }

  // Path must end with expected PZ Lua server directory pattern
  // Use forward slashes for comparison but preserve original case on Linux (case-sensitive FS)
  const normalizedTarget = realTarget.replace(/\\/g, "/");
  const targetLower = normalizedTarget.toLowerCase();
  if (
    !targetLower.endsWith("/media/lua/server") &&
    !targetLower.endsWith("/media/lua/server/")
  ) {
    return res
      .status(400)
      .json({ error: "Path must point to a media/lua/server/ directory" });
  }

  try {
    // Prefer embedded Lua (guaranteed to match running binary version).
    let srcContent = getEmbeddedPanelBridgeLua();

    if (!srcContent) {
      const possiblePaths = [
        path.join(process.cwd(), "pz-mod", "PanelBridge"),
        path.join(path.dirname(process.execPath), "pz-mod", "PanelBridge"),
        path.join(__dirname, "..", "..", "pz-mod", "PanelBridge"),
      ];
      for (const p of possiblePaths) {
        const candidate = path.join(
          p,
          "media",
          "lua",
          "server",
          "PanelBridge.lua",
        );
        if (fs.existsSync(candidate)) {
          srcContent = fs.readFileSync(candidate, "utf8");
          break;
        }
      }
    }

    if (!srcContent) {
      return res.status(404).json({
        error: "Source mod not found (no embedded Lua and no on-disk pz-mod).",
      });
    }

    // Ensure target directory exists (use realTarget for safety)
    if (!fs.existsSync(realTarget)) {
      fs.mkdirSync(realTarget, { recursive: true, mode: 0o755 });
    }

    // Atomic write of the Lua file
    const destPath = path.join(realTarget, "PanelBridge.lua");
    writeLuaAtomic(destPath, srcContent);

    res.json({
      success: true,
      message: "PanelBridge.lua installed successfully",
      path: destPath,
    });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// =============================================
// V1.2.0 SOUND/NOISE ENDPOINTS
// =============================================

// Play sound at world coordinates
router.post("/sound/world", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { x, y, z, radius, volume } = req.body;
  if (x === undefined || y === undefined) {
    return res.status(400).json({ error: "x and y coordinates are required" });
  }
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    x < 0 ||
    x > 24000 ||
    y < 0 ||
    y > 24000
  ) {
    return res
      .status(400)
      .json({ error: "Coordinates out of range (valid: 0-24000)" });
  }
  try {
    const result = await bridge.playWorldSound(x, y, z, radius, volume);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Play sound near a player
router.post("/sound/near-player", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { username, radius, volume } = req.body;
  if (!username || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({ error: "Valid username is required" });
  }
  try {
    const result = await bridge.playSoundNearPlayer(username, radius, volume);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to play sound" });
  }
});

// Trigger gunshot sound
router.post("/sound/gunshot", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { x, y, z, username } = req.body;
  if (username && !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({ error: "Invalid username format" });
  }
  try {
    const result = await bridge.triggerGunshot({ x, y, z, username });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to trigger gunshot" });
  }
});

// Trigger alarm sound
router.post("/sound/alarm", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { x, y, z, username } = req.body;
  if (username && !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({ error: "Invalid username format" });
  }
  try {
    const result = await bridge.triggerAlarmSound({ x, y, z, username });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Create custom noise
router.post("/sound/noise", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { x, y, z, radius, volume, username } = req.body;
  if (username && !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({ error: "Invalid username format" });
  }
  try {
    const result = await bridge.createNoise({
      x,
      y,
      z,
      radius,
      volume,
      username,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// =============================================
// V1.4.0 INFRASTRUCTURE (POWER/WATER) ENDPOINTS
// =============================================

// The bridge only moves SandboxOptions in memory, so mirror the same values
// into SandboxVars.lua or the next server start silently undoes the change.
// 9 = "Disabled"/never shuts off, 1 = "Instant"; the modifier is what the game
// actually compares world age against.
async function persistUtilities(power, water, on) {
  const values = {};
  if (power) {
    values.ElecShut = on ? 9 : 1;
    values.ElecShutModifier = on ? 2147483647 : 0;
  }
  if (water) {
    values.WaterShut = on ? 9 : 1;
    values.WaterShutModifier = on ? 2147483647 : 0;
  }
  try {
    const { persisted, reason } = await persistSandboxValues(values);
    if (!persisted) {
      log.warn(`Utilities not persisted to SandboxVars.lua: ${reason}`);
    }
    return { persisted, persistReason: reason };
  } catch (error) {
    log.error(
      `Failed to persist utilities to SandboxVars.lua: ${error.message}`,
    );
    return { persisted: false, persistReason: sanitizeError(error.message) };
  }
}

// Get utilities (power/water) status
router.get("/utilities/status", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  try {
    const result = await bridge.sendCommand("getUtilitiesStatus", {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Restore utilities (turn power/water back on)
router.post("/utilities/restore", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { power, water } = req.body;
  log.info(
    `Restoring utilities - power: ${power !== false}, water: ${water !== false}`,
  );
  try {
    const result = await bridge.sendCommand("restoreUtilities", {
      power: power !== false,
      water: water !== false,
    });
    log.info(
      `Utilities restored successfully`,
      result?.debug ? { debug: result.debug } : {},
    );
    res.json({
      ...result,
      ...(await persistUtilities(power !== false, water !== false, true)),
    });
  } catch (error) {
    log.error(`Failed to restore utilities: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Shut off utilities
router.post("/utilities/shutoff", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { power, water } = req.body;
  log.info(
    `Shutting off utilities - power: ${power !== false}, water: ${water !== false}`,
  );
  try {
    const result = await bridge.sendCommand("shutOffUtilities", {
      power: power !== false,
      water: water !== false,
    });
    log.info(
      `Utilities shut off successfully`,
      result?.debug ? { debug: result.debug } : {},
    );
    res.json({
      ...result,
      ...(await persistUtilities(power !== false, water !== false, false)),
    });
  } catch (error) {
    log.error(`Failed to shut off utilities: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// =============================================
// V1.5.0 CHARACTER EXPORT/IMPORT
// =============================================

// Export character data (XP, perks, skills, traits, inventory)
router.post("/character/export", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { username } = req.body;
  if (!username || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({ error: "Invalid or missing username" });
  }
  try {
    const result = await bridge.sendCommand("exportPlayerData", { username });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Import character data (apply XP, perks to player)
router.post("/character/import", async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({ error: "Bridge not running. Start it first." });
  }
  const { username, data, options } = req.body;
  if (!username || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({ error: "Invalid or missing username" });
  }
  if (!data) {
    return res.status(400).json({ error: "Character data is required" });
  }
  // Validate data is an object with expected structure
  if (typeof data !== "object" || Array.isArray(data)) {
    return res.status(400).json({ error: "Character data must be an object" });
  }
  // Check for at least one valid data section
  const validSections = [
    "perks",
    "xp",
    "skills",
    "traits",
    "recipes",
    "stats",
    "inventory",
    "wornItems",
  ];
  const hasValidSection = validSections.some(
    (section) => data[section] !== undefined,
  );
  if (!hasValidSection) {
    return res.status(400).json({
      error:
        "Character data must contain at least one of: " +
        validSections.join(", "),
    });
  }
  try {
    const result = await bridge.sendCommand("importPlayerData", {
      username,
      data,
      options,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ============================================
// PLAYER ADMIN CONTROLS
// ============================================

// Give item to player
router.post("/players/:username/give-item", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  const { username } = req.params;
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({ error: "Invalid username format" });
  }
  const { itemType, count = 1 } = req.body;
  if (
    !itemType ||
    typeof itemType !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9_]*\.[a-zA-Z][a-zA-Z0-9_]*$/.test(itemType)
  ) {
    return res.status(400).json({
      error: 'itemType must be in Module.ItemName format (e.g., "Base.Axe")',
    });
  }
  if (typeof count !== "number" || count < 1 || count > 100) {
    return res.status(400).json({ error: "count must be 1-100" });
  }
  try {
    const result = await bridge.sendCommand("giveItem", {
      username,
      itemType,
      count,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Heal player
router.post("/players/:username/heal", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  const { username } = req.params;
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({ error: "Invalid username format" });
  }
  try {
    const result = await bridge.sendCommand("healPlayer", { username });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Kill player
router.post("/players/:username/kill", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  const { username } = req.params;
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({ error: "Invalid username format" });
  }
  try {
    const result = await bridge.sendCommand("killPlayer", { username });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set god mode for player
router.post("/players/:username/godmode", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  const { username } = req.params;
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({ error: "Invalid username format" });
  }
  const { enabled } = req.body;
  try {
    const result = await bridge.sendCommand("setGodMode", {
      username,
      enabled: enabled === true,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set invisible for player
router.post("/players/:username/invisible", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  const { username } = req.params;
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({ error: "Invalid username format" });
  }
  const { enabled } = req.body;
  try {
    const result = await bridge.sendCommand("setInvisible", {
      username,
      enabled: enabled === true,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ============================================
// ZOMBIE CONTROLS
// ============================================

// Get zombie statistics
router.get("/zombies/count", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  try {
    const result = await bridge.sendCommand("getZombieCount", {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Clear zombies near a player
router.post("/zombies/clear-near-player", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  const { username, radius = 50 } = req.body;
  if (!username || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({ error: "Valid username is required" });
  }
  if (typeof radius !== "number" || radius < 1 || radius > 500) {
    return res.status(400).json({ error: "radius must be 1-500" });
  }
  try {
    const result = await bridge.sendCommand("clearZombiesNearPlayer", {
      username,
      radius,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Clear ALL zombies in loaded cells
router.post("/zombies/clear-all", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  try {
    log.info("Clearing all zombies");
    const result = await bridge.sendCommand("clearAllZombies", {});
    log.info(`Clear all zombies result: ${JSON.stringify(result)}`);
    res.json(result);
  } catch (error) {
    log.warn(`Clear all zombies failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Spawn horde near a player
router.post("/zombies/spawn-near", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  const { username, count = 50 } = req.body;
  if (!username || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({ error: "Valid username is required" });
  }
  const safeCount = Math.min(Math.max(Math.floor(Number(count) || 50), 1), 500);
  try {
    log.info(`Spawning horde near player: ${username} (count: ${safeCount})`);
    const result = await bridge.sendCommand("spawnHordeNearPlayer", {
      username,
      count: safeCount,
    });
    log.info(`Spawn horde near result: ${JSON.stringify(result)}`);
    res.json(result);
  } catch (error) {
    log.warn(`Spawn horde near failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Spawn horde behind a player
router.post("/zombies/spawn-behind", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  const { username, count = 50 } = req.body;
  if (!username || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({ error: "Valid username is required" });
  }
  const safeCount = Math.min(Math.max(Math.floor(Number(count) || 50), 1), 500);
  try {
    log.info(`Spawning horde behind player: ${username} (count: ${safeCount})`);
    const result = await bridge.sendCommand("spawnHordeBehindPlayer", {
      username,
      count: safeCount,
    });
    log.info(`Spawn horde behind result: ${JSON.stringify(result)}`);
    res.json(result);
  } catch (error) {
    log.warn(`Spawn horde behind failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ============================================
// VISUAL EFFECTS CONTROLS
// ============================================

// Set view distance
router.post("/visual/view-distance", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  const { value } = req.body;
  if (typeof value !== "number") {
    return res
      .status(400)
      .json({ error: "value is required (number 0.0-1.0)" });
  }
  try {
    const result = await bridge.sendCommand("setViewDistance", { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set daylight level
router.post("/visual/daylight", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  const { value } = req.body;
  if (typeof value !== "number") {
    return res.status(400).json({ error: "value is required (0.0-1.0)" });
  }
  try {
    const result = await bridge.sendCommand("setDayLight", { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set night strength
router.post("/visual/night-strength", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  const { value } = req.body;
  if (typeof value !== "number") {
    return res.status(400).json({ error: "value is required (0.0-1.0)" });
  }
  try {
    const result = await bridge.sendCommand("setNightStrength", { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set desaturation (color wash)
router.post("/visual/desaturation", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  const { value } = req.body;
  if (typeof value !== "number") {
    return res.status(400).json({ error: "value is required (0.0-1.0)" });
  }
  try {
    const result = await bridge.sendCommand("setDesaturation", { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set ambient light
router.post("/visual/ambient", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  const { value } = req.body;
  if (typeof value !== "number") {
    return res.status(400).json({ error: "value is required (0.0-1.0)" });
  }
  try {
    const result = await bridge.sendCommand("setAmbient", { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ============================================
// CHAT CONTROLS
// ============================================

// Get chat info
router.get("/chat/info", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  try {
    const result = await bridge.sendCommand("getChatInfo", {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Helper: try sending a chat message via RCON servermsg
async function trySendViaRcon(req, text) {
  const rconService = req.app.get("rconService");
  if (!rconService || !rconService.connected) return null;
  const result = await rconService.serverMessage(text, { skipLog: true });
  return result?.success ? result : null;
}

// Send to admin chat
router.post("/chat/admin", async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== "string" || message.length > 2000) {
    return res
      .status(400)
      .json({ error: "message is required (max 2000 chars)" });
  }
  try {
    // Try PanelBridge first (only way to target admin-only chat)
    if (bridge.isRunning) {
      const result = await bridge.sendCommand("sendToAdminChat", { message });
      if (result?.success && result?.data?.method !== "player:Say") {
        return res.json(result);
      }
    }
    // Fallback: RCON with [ADMIN] prefix (visible to all players)
    const rconResult = await trySendViaRcon(req, `[ADMIN] ${message}`);
    if (rconResult) {
      return res.json({
        success: true,
        data: {
          message: "Admin message sent via RCON (visible to all)",
          method: "RCON",
        },
      });
    }
    return res
      .status(400)
      .json({ error: "Neither PanelBridge nor RCON available for admin chat" });
  } catch (error) {
    // Still try RCON on PanelBridge error
    try {
      const rconResult = await trySendViaRcon(req, `[ADMIN] ${message}`);
      if (rconResult) {
        return res.json({
          success: true,
          data: {
            message: "Admin message sent via RCON (visible to all)",
            method: "RCON",
          },
        });
      }
    } catch (_) {
      /* ignore */
    }
    res.status(500).json({ error: "Failed to send admin message" });
  }
});

// Send to general chat with author
router.post("/chat/general", async (req, res) => {
  const author =
    typeof req.body.author === "string"
      ? req.body.author.trim().slice(0, 64) || "Server"
      : "Server";
  const { message } = req.body;
  if (!message || typeof message !== "string" || message.length > 2000) {
    return res
      .status(400)
      .json({ error: "message is required (max 2000 chars)" });
  }
  try {
    // Try PanelBridge first (supports custom author via ChatServer)
    if (bridge.isRunning) {
      const result = await bridge.sendCommand("sendToGeneralChat", {
        message,
        author,
      });
      if (result?.success && result?.data?.method !== "player:Say") {
        return res.json(result);
      }
    }
    // Fallback: RCON with author prefix
    const rconResult = await trySendViaRcon(req, `[${author}] ${message}`);
    if (rconResult) {
      return res.json({
        success: true,
        data: { message: "Message sent via RCON", author, method: "RCON" },
      });
    }
    return res
      .status(400)
      .json({ error: "Neither PanelBridge nor RCON available for chat" });
  } catch (error) {
    try {
      const rconResult = await trySendViaRcon(req, `[${author}] ${message}`);
      if (rconResult) {
        return res.json({
          success: true,
          data: { message: "Message sent via RCON", author, method: "RCON" },
        });
      }
    } catch (_) {
      /* ignore */
    }
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Send server alert
router.post("/chat/alert", async (req, res) => {
  const { message, alert = true } = req.body;
  if (!message || typeof message !== "string" || message.length > 2000) {
    return res
      .status(400)
      .json({ error: "message is required (max 2000 chars)" });
  }
  try {
    // RCON servermsg is the most reliable for server-wide messages
    const rconResult = await trySendViaRcon(req, message);
    if (rconResult) {
      return res.json({
        success: true,
        data: {
          message: "Alert sent via RCON",
          isAlert: alert,
          method: "RCON",
        },
      });
    }
    // Fallback: PanelBridge
    if (bridge.isRunning) {
      const result = await bridge.sendCommand("sendToServerChat", {
        message,
        alert,
      });
      return res.json(result);
    }
    return res
      .status(400)
      .json({ error: "Neither RCON nor PanelBridge available" });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ============================================
// DEBUG ENDPOINTS
// ============================================

// Get mod debug log
router.get("/debug/log", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  const VALID_LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"];
  const minLevel = VALID_LOG_LEVELS.includes(req.query.level)
    ? req.query.level
    : "DEBUG";
  try {
    const result = await bridge.sendCommand("getDebugLog", { limit, minLevel });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get mod statistics
router.get("/debug/stats", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  try {
    const result = await bridge.sendCommand("getStats", {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set debug mode
router.post("/debug/mode", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  const { enabled } = req.body;
  try {
    const result = await bridge.sendCommand("setDebugMode", {
      enabled: enabled === true,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Check API availability
router.get("/debug/api", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  const { object, method } = req.query;
  // Validate as identifier-like strings
  if (
    object &&
    (typeof object !== "string" || !/^[a-zA-Z0-9_.]{1,100}$/.test(object))
  ) {
    return res.status(400).json({ error: "Invalid object name" });
  }
  if (
    method &&
    (typeof method !== "string" || !/^[a-zA-Z0-9_.]{1,100}$/.test(method))
  ) {
    return res.status(400).json({ error: "Invalid method name" });
  }
  try {
    const result = await bridge.sendCommand("checkAPI", { object, method });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get available handlers
router.get("/debug/handlers", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  try {
    const result = await bridge.sendCommand("getAvailableHandlers", {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Clear mod errors
router.post("/debug/clear-errors", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  try {
    const result = await bridge.clearErrors();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ============================================
// CATALOG ENDPOINTS (item + vehicle enumeration)
// ============================================

// Get cached item catalog
router.get("/catalog/items", async (req, res) => {
  try {
    const db = await getDb();
    const catalog = db.data.itemCatalog || null;
    if (!catalog) {
      return res.json({ items: [], count: 0, scannedAt: null });
    }
    res.json(catalog);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get cached vehicle catalog
router.get("/catalog/vehicles", async (req, res) => {
  try {
    const db = await getDb();
    const catalog = db.data.vehicleCatalog || null;
    if (!catalog) {
      return res.json({ vehicles: [], count: 0, scannedAt: null });
    }
    res.json(catalog);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Scan items from running server via PanelBridge, cache result
router.post("/catalog/scan-items", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running — server must be online to scan items",
    });
  }
  try {
    log.info("Scanning item catalog via PanelBridge...");
    const result = await bridge.sendCommand("getItemCatalog", {});
    if (!result || !result.success) {
      return res
        .status(500)
        .json({ error: result?.error || "Item scan failed" });
    }
    const catalog = {
      items: result.data?.items || [],
      count: result.data?.count || 0,
      scannedAt: new Date().toISOString(),
    };
    const db = await getDb();
    db.data.itemCatalog = catalog;
    await commitNow();
    log.info(`Item catalog cached: ${catalog.count} items`);
    res.json(catalog);
  } catch (error) {
    log.error("Item catalog scan failed:", error.message);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Scan vehicles from running server via PanelBridge, cache result
router.post("/catalog/scan-vehicles", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running — server must be online to scan vehicles",
    });
  }
  try {
    log.info("Scanning vehicle catalog via PanelBridge...");
    const result = await bridge.sendCommand("getVehicleCatalog", {});
    if (!result || !result.success) {
      return res
        .status(500)
        .json({ error: result?.error || "Vehicle scan failed" });
    }
    const catalog = {
      vehicles: result.data?.vehicles || [],
      count: result.data?.count || 0,
      scannedAt: new Date().toISOString(),
    };
    const db = await getDb();
    db.data.vehicleCatalog = catalog;
    await commitNow();
    log.info(`Vehicle catalog cached: ${catalog.count} vehicles`);
    res.json(catalog);
  } catch (error) {
    log.error("Vehicle catalog scan failed:", error.message);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Debug: probe item script methods to find working category API
router.post("/catalog/debug-item-script", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: "Bridge not running" });
  }
  try {
    const result = await bridge.sendCommand("debugItemScript", {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
