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
  getRoleByName,
} from "../database/init.js";
import { sanitizeError, sanitizeErrorParams, isMaskedSecret } from "../utils/sanitize.js";
import { getDataPaths } from "../utils/paths.js";
import { persistSandboxValues } from "./serverFiles.js";
import { requirePermission } from "../services/permissions.js";
import { parseClampedInteger } from "../utils/queryNumbers.js";
import {
  getEmbeddedPanelBridgeLua,
  compareModVersions,
  writeLuaAtomic,
} from "../utils/embeddedLua.js";
import {
  canAutoInstall,
  checkBridgeInstalled,
  getBundledBridgeVersion,
  installBridge,
  isBridgeVersionBehindBundled,
  resolveInstallDir,
} from "../services/panelBridgeInstaller.js";
import { createLogger } from "../utils/logger.js";
import {
  getSftpCachePath,
  testSftpBridge,
  formatSftpError,
  classifySftpErrorCode,
  validateSftpBridgeConfig,
  listSftpLogs,
  readSftpLogTail,
} from "../services/panelBridgeSftp.js";
import {
  SFTP_CONFIG_PATH_KEY,
  listRemoteConfigFiles,
  resetRemoteConfigSession,
  validateRemoteConfigTransport,
} from "../services/remoteConfigFiles.js";
import { ErrorCode } from "../utils/errorCodes.js";
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
export const VALID_ACTIONS = new Set([
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
  "stopHelicopterEvent",
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
  // Was missing entirely (2026-08-29, pin-literal-sendcommand-strings-
  // against-valid-actions): POST /catalog/debug-item-script has called
  // bridge.sendCommand("debugItemScript", {}) directly since that route was
  // added, and the Lua side (PanelBridge.lua's handlers.debugItemScript)
  // genuinely implements it -- this was never a runtime bug, only a gap in
  // this allowlist, unlike every other dedicated-route action, which all
  // have a matching VALID_ACTIONS entry.
  "debugItemScript",
]);

// POST /command is gated bridge.command alone -- deliberately, as the
// generic passthrough for every action above, including the ~30 with no
// dedicated route at all (vehicles, safehouses, factions, sandbox reads,
// time-speed, infrastructure snapshot, event sequences). That breadth is
// intentional and documented at the route below: those actions are all
// GM-tool/world-management flavored, the same risk tier as
// players.gm_tools or server.world_events, which bridge.command -- an
// admin-only-by-default, deliberately-granted capability -- already
// legitimately subsumes.
//
// The four moderation actions are different in kind, not just degree.
// "Discipline a player" is carved out into its OWN capability
// (players.moderate) everywhere else this app reaches it -- players.js's
// own header comment names exactly why: kick/ban carries a
// favouritism/griefing risk distinct from a GM tool's risk, which is the
// entire reason the matrix splits players.moderate from players.gm_tools
// in the first place. These four have no dedicated route of their own (the
// only caller is Events.tsx's "Moderation Automation" panel, via this
// exact endpoint), so bridge.command is currently their ONLY gate -- a
// custom role granted bridge.command for legitimate GM/world-event
// automation, but never granted players.moderate, gets full kick/ban/
// ban-by-IP/ban-by-SteamID power as an undocumented side effect.
// bug-hunt-2026-08-27: Pam's cross-route-family capability sweep.
//
// setGodMode/setInvisible/setNoclip/healPlayer are the SAME shape, found the
// same day (bug-hunt-2026-08-27, were-the-dedicated-gm-tools-routes-ever-wired):
// unlike the moderation four, these DO each have a dedicated, correctly-
// gated players.gm_tools route (players.js's /godmode, /invisible, /noclip;
// this file's /players/:username/heal) -- but Players.tsx has not called any
// of them since commit 8bd0edc ("Release v1.0.2"), which silently swapped
// three of the four onto this passthrough (and built the fourth, heal,
// against the passthrough from the start) as an incidental side effect of an
// unrelated 641-line UI-overhaul release commit, with no comment anywhere in
// that diff acknowledging the capability implication.
//
// hunt-wave12-2026-08-30 UI-reachability audit, extending the above: THIS
// FILE also has its own dedicated /players/:username/godmode and
// /players/:username/invisible routes (below), separate from players.js's
// /godmode and /invisible -- the original 2026-08-27 comment named only the
// players.js pair and didn't mention this file has a second, independent
// implementation. Checked both: players.js's /godmode, /invisible AND this
// file's /players/:username/godmode, /players/:username/invisible are ALL
// dead (playersApi.setGodMode/setInvisible, the client wrappers for the
// players.js pair, are never called either). The only live path for
// setGodMode/setInvisible is this route's own bridge.command passthrough,
// same as healPlayer.
//
// The two buckets below use DIFFERENT gating shapes, not the same one:
//  - The moderation four have no dedicated route of their own, so the
//    capability named here is ADDITIONAL, on top of this route's own
//    bridge.command gate (still enforced for them -- see
//    requireBridgeCommandUnlessGmToolsOnly below).
//  - The GM four (GM_TOOLS_ONLY_ACTIONS) use REPLACEMENT semantics as of
//    an operator ruling (bug-hunt-2026-08-27, reverses c3083d5 the same
//    day): players.gm_tools ALONE is sufficient, and bridge.command is not
//    required at all for these four. c3083d5 had made it "gm_tools AND
//    bridge.command" -- the operator ruled that was never the intended
//    fix, since bridge.command was only ever an accidental side effect of
//    these four routing through the generic passthrough, and requiring it
//    denies Technician (who holds gm_tools but not bridge.command by
//    default) the GM tools it's meant to have. A role holding ONLY
//    players.gm_tools must reach these four through this passthrough, the
//    same as it already can through their own dedicated routes.
export const BRIDGE_ACTION_CAPABILITY = {
  moderationKickUser: "players.moderate",
  moderationBanUser: "players.moderate",
  moderationBanIP: "players.moderate",
  moderationBanSteamID: "players.moderate",
  setGodMode: "players.gm_tools",
  setInvisible: "players.gm_tools",
  setNoclip: "players.gm_tools",
  healPlayer: "players.gm_tools",
  // ADDITIONAL semantics (bridge.command AND bridge.diagnostics), not
  // GM_TOOLS_ONLY_ACTIONS replacement semantics -- unlike the GM four,
  // there's no described legitimate automation role that needs this
  // specific debug/diagnostic probe without also holding bridge.command;
  // its own dedicated route (POST /catalog/debug-item-script) already gates
  // on bridge.diagnostics alone, but adding debugItemScript to VALID_ACTIONS
  // (this same commit) makes it newly reachable through the generic
  // passthrough too -- without this entry, ANY role holding only
  // bridge.command (e.g. a GM/world-event automation role) would gain this
  // debug action for free, the exact bypass class e728248 closed for the
  // moderation four.
  debugItemScript: "bridge.diagnostics",
  // 2026-08-31 bug hunt: these eight are the SAME actions the 2026-08-27
  // ranked-bug #5 ruling (see the big comment above the route matrix,
  // "operator ruling on ranked-bug #5") moved off server.world_events onto
  // players.endanger_or_impersonate for their own dedicated routes
  // (/sound/near-player, /sound/gunshot, /sound/alarm, /sound/noise,
  // /zombies/spawn-near, /zombies/spawn-behind, /chat/admin,
  // /chat/general) -- but this generic passthrough was never updated to
  // match, so a role holding only bridge.command (a legitimate GM/
  // world-event-automation grant, per this file's own header comment) could
  // reach targeted zombie-spawning, targeted sound effects, and chat
  // impersonation-as-server/admin through POST /command with no
  // endanger_or_impersonate check at all -- the exact bypass class e728248
  // closed for the moderation four, just not extended here. REPLACEMENT
  // semantics (see ENDANGER_OR_IMPERSONATE_ONLY_ACTIONS below), not
  // ADDITIONAL like the moderation four or debugItemScript: unlike
  // debugItemScript (ADDITIONAL because "there's no described legitimate
  // automation role that needs this probe without also holding
  // bridge.command"), a role holding ONLY players.endanger_or_impersonate
  // already reaches all eight through their dedicated routes today --
  // requiring bridge.command here too would newly block that role from this
  // passthrough for actions it's otherwise fully entitled to.
  playSoundNearPlayer: "players.endanger_or_impersonate",
  triggerGunshot: "players.endanger_or_impersonate",
  triggerAlarmSound: "players.endanger_or_impersonate",
  createNoise: "players.endanger_or_impersonate",
  spawnHordeNearPlayer: "players.endanger_or_impersonate",
  spawnHordeBehindPlayer: "players.endanger_or_impersonate",
  sendToAdminChat: "players.endanger_or_impersonate",
  sendToGeneralChat: "players.endanger_or_impersonate",
};

// The subset of BRIDGE_ACTION_CAPABILITY that uses REPLACEMENT semantics
// (see the comment above) -- an explicit set rather than derived from the
// capability string, so a future action that happens to reuse
// "players.gm_tools" with ADDITIONAL semantics can't silently fall into
// the wrong bucket.
export const GM_TOOLS_ONLY_ACTIONS = new Set([
  "setGodMode",
  "setInvisible",
  "setNoclip",
  "healPlayer",
]);

// Same REPLACEMENT-semantics bucket as GM_TOOLS_ONLY_ACTIONS above, for the
// eight players.endanger_or_impersonate actions (2026-08-31 bug hunt) --
// see BRIDGE_ACTION_CAPABILITY's own comment on those eight entries for why
// this is REPLACEMENT (matching their dedicated routes, which require
// players.endanger_or_impersonate alone) rather than ADDITIONAL.
export const ENDANGER_OR_IMPERSONATE_ONLY_ACTIONS = new Set([
  "playSoundNearPlayer",
  "triggerGunshot",
  "triggerAlarmSound",
  "createNoise",
  "spawnHordeNearPlayer",
  "spawnHordeBehindPlayer",
  "sendToAdminChat",
  "sendToGeneralChat",
]);

// POST /command's own gate can't be a flat requirePermission("bridge.command")
// the way every other bridge.setup route above is: GM_TOOLS_ONLY_ACTIONS and
// ENDANGER_OR_IMPERSONATE_ONLY_ACTIONS must each be reachable WITHOUT
// bridge.command, decided per-request by the action in the body, which
// requirePermission()'s capability argument (fixed at route-registration
// time) has no way to see. This still enforces authentication (401) exactly
// like requirePermission does; it only skips the bridge.command capability
// check when the action is in one of those two REPLACEMENT-semantics sets,
// leaving BRIDGE_ACTION_CAPABILITY's own inline check further down in the
// handler as their sole gate.
const requireBridgeCommand = requirePermission("bridge.command");
function requireBridgeCommandUnlessGmToolsOnly(req, res, next) {
  const { action } = req.body || {};
  if (
    typeof action === "string" &&
    (GM_TOOLS_ONLY_ACTIONS.has(action) || ENDANGER_OR_IMPERSONATE_ONLY_ACTIONS.has(action))
  ) {
    return next();
  }
  return requireBridgeCommand(req, res, next);
}

// Username validation for PanelBridge player endpoints.
// Allow normal in-game names (spaces/symbols) while blocking control chars and quote/backslash.
const BRIDGE_USERNAME_REGEX = /^(?=.*\S)[^\x00-\x1F\x7F"\\]{1,64}$/;

// Shared path safety check for /configure, /configure-direct and
// /auto-detect: bridge.configure()/autoDetect() (services/panelBridge.js)
// perform no validation of their own -- whatever path reaches them becomes
// this.bridgePath, which mkdirSync/writeFileSync/readFileSync then act on
// directly once the bridge starts polling. Must be absolute and not a
// protected system directory. Checks isAbsolute() on the RAW input, not on
// the result of path.resolve() -- resolve() always returns an absolute path
// by resolving against cwd, so checking absoluteness after resolving can
// never reject anything and silently accepted relative paths.
const BLOCKED_BRIDGE_PATH_PREFIXES =
  process.platform === "win32"
    ? ["c:\\windows", "c:\\program files"]
    : ["/etc", "/usr", "/bin", "/sbin", "/proc", "/sys", "/dev"];

function isValidBridgePath(inputPath) {
  if (!inputPath || typeof inputPath !== "string") return false;
  if (!path.isAbsolute(inputPath)) return false;
  const resolved = path.resolve(inputPath);
  const lower = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return !BLOCKED_BRIDGE_PATH_PREFIXES.some((p) => lower.startsWith(p));
}

// The 60 curated in-game GM/world routes below (weather, climate, time,
// sound, zombies, visual, chat, utilities, character export/import,
// teleport/give-item/heal/kill/godmode/invisible, plus /message) were
// previously reachable by any signed-in role with no gate at all. Folded
// into the matrix, originally split by target: world-wide effects
// requirePermission("server.world_events"); actions aimed at a specific
// player or character, plus the read-only catalogue/sandbox reads that
// support them, requirePermission("players.gm_tools") -- the same
// capability players.js's own teleport/give-item-equivalent routes use.
// Both defaulted to admin+technician+moderator, zero-behaviour-change.
//
// 2026-08-27 (operator ruling on ranked-bug #5) split world_events again:
// /sound/near-player, /sound/gunshot, /zombies/spawn-near, /zombies/spawn-
// behind, /chat/admin and /chat/general all take an optional target (a
// username, or in chat/general's case an arbitrary custom author name) and
// can spawn up to 500 zombies at a named player or make a chat message
// read as if they said it -- gated on players.endanger_or_impersonate now,
// admin-only by default, NOT folded into moderator's default grant the way
// the original split was. Every other world_events route stays exactly as
// described above: genuinely world-wide, no per-player target possible.
// /status and /ping stay deliberately outside the matrix -- see
// server.js's equivalent comment for why: dashboard-wide reads that
// protect nothing if gated and can break a screen for a role if mis-set.
// /commands stays outside the matrix too, for its own reason: the handler
// returns a static hardcoded array of action names and argument shapes --
// no live data, no server state, nothing that differs by who's asking. It's
// API documentation, not a read of anything. Gating it would add a
// permission check that protects nothing.
// /server-info is NOT in that class: handlers.getServerInfo returns every
// online player's exact x/y/z position and current health, unauthenticated,
// to anyone who can reach the panel. Gated requirePermission("players.view")
// -- same capability players.js uses for reading player details/status, and
// held by all three default roles, so no legitimate caller loses access.

// Get bridge status
router.get("/status", async (req, res) => {
  const status = bridge.getStatus();

  // Also include detected paths and either local auto-install status or a
  // remote version check, depending on the active server's topology.
  let detectedPaths = null;
  let localInstall = null;
  // Remote/SFTP servers have no local file the panel can content-compare
  // against -- canAutoInstall()/checkBridgeInstalled() both require a
  // target path the panel writes to, which a remote server has none of (the
  // panel never touches its filesystem). The only signal that's possible
  // there is a plain version-STRING comparison between the bridge's own
  // live self-report (status.version, from its status.json heartbeat) and
  // whatever this panel currently bundles -- do not "fix" this into a
  // content comparison later; it cannot work for a server the panel never
  // writes to (2026-09-02 bridge-enforcement/bridge-install-integrity).
  let remoteBridgeVersionCheck = null;
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
      if (activeServer.isRemote) {
        const bundledVersion = getBundledBridgeVersion();
        const liveVersion = status.version || null;
        remoteBridgeVersionCheck = {
          bundledVersion,
          liveVersion,
          behind: liveVersion ? isBridgeVersionBehindBundled(liveVersion) : null,
        };
      } else {
        localInstall = {
          canAutoInstall: canAutoInstall(activeServer),
          ...checkBridgeInstalled(activeServer),
        };
      }
    }
  } catch (e) {
    // Ignore
  }

  res.json({
    ...status,
    modConnected: bridge.isModConnected(),
    detectedPaths,
    localInstall,
    remoteBridgeVersionCheck,
  });
});

// Auto-configure bridge from server settings (optionally specify serverId)
router.post("/auto-configure", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const { serverId } = req.body || {};
    log.info(`POST /auto-configure (serverId=${serverId || "active"})`);

    // Get specified server or active server
    let targetServer;
    if (serverId) {
      targetServer = await getServer(serverId);
      if (!targetServer) {
        return res.status(400).json({
          error: `Server with ID ${serverId} not found.`,
          code: ErrorCode.PANELBRIDGE_SERVER_ID_NOT_FOUND,
          params: sanitizeErrorParams({ serverId }),
        });
      }
    } else {
      targetServer = await getActiveServer();
      if (!targetServer) {
        return res.status(400).json({
          error:
            "No active server configured. Please configure a server first.",
          code: ErrorCode.PANELBRIDGE_AUTO_CONFIGURE_NO_ACTIVE_SERVER,
        });
      }
    }

    const serverName = targetServer.serverName || targetServer.name;
    if (!serverName) {
      return res.status(400).json({
        error: "Server name not configured.",
        code: ErrorCode.PANELBRIDGE_SERVER_NAME_NOT_CONFIGURED,
      });
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
        code: ErrorCode.PANELBRIDGE_PATH_NOT_DETERMINED,
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
      const installDir = resolveInstallDir(targetServer);
      if (installDir) {
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
router.get("/scan-server/:serverId", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const { serverId } = req.params;
    const targetServer = await getServer(serverId);

    if (!targetServer) {
      return res.status(404).json({
        success: false,
        error: `Server with ID ${serverId} not found.`,
        code: ErrorCode.PANELBRIDGE_SERVER_ID_NOT_FOUND,
        params: sanitizeErrorParams({ serverId }),
      });
    }

    const serverName = targetServer.serverName || targetServer.name;
    if (!serverName) {
      return res
        .status(400)
        .json({
          success: false,
          error: "Server name not configured.",
          code: ErrorCode.PANELBRIDGE_SERVER_NAME_NOT_CONFIGURED,
        });
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
router.post("/auto-detect", requirePermission("bridge.setup"), async (req, res) => {
  const { serverName, zomboidUserFolder } = req.body || {};

  if (!serverName) {
    return res.status(400).json({
      error: "serverName is required",
      code: ErrorCode.PANELBRIDGE_SERVER_NAME_REQUIRED,
    });
  }

  if (zomboidUserFolder && !isValidBridgePath(zomboidUserFolder)) {
    return res.status(400).json({
      error: "Invalid zomboidUserFolder path",
      code: ErrorCode.PANELBRIDGE_INVALID_ZOMBOID_USER_FOLDER,
    });
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
router.post("/configure", requirePermission("bridge.setup"), async (req, res) => {
  const { zomboidSavePath } = req.body || {};

  if (!zomboidSavePath) {
    return res.status(400).json({
      error: "zomboidSavePath is required",
      code: ErrorCode.PANELBRIDGE_SAVE_PATH_REQUIRED,
    });
  }

  if (!isValidBridgePath(zomboidSavePath)) {
    return res.status(400).json({
      error: "Invalid zomboidSavePath",
      code: ErrorCode.PANELBRIDGE_INVALID_SAVE_PATH,
    });
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
    // Persist so index.js's findPanelBridgePath() restore (settings.panelBridge.bridgePath)
    // finds this again after a panel restart instead of falling through to auto-detect.
    await setSetting("panelBridge", { bridgePath });
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
router.post("/configure-direct", requirePermission("bridge.setup"), async (req, res) => {
  const { bridgePath: reqPath } = req.body || {};

  if (!reqPath || typeof reqPath !== "string") {
    return res.status(400).json({
      error: "bridgePath is required",
      code: ErrorCode.PANELBRIDGE_BRIDGE_PATH_REQUIRED,
    });
  }

  // Must check isAbsolute() on the raw input: path.resolve() always returns
  // an absolute path (resolved against cwd), so this check would never
  // reject anything if run on its result -- it was a no-op that silently
  // accepted relative paths.
  if (!path.isAbsolute(reqPath)) {
    return res.status(400).json({
      error: "Path must be absolute",
      code: ErrorCode.PANELBRIDGE_PATH_MUST_BE_ABSOLUTE,
    });
  }
  const resolved = path.resolve(reqPath);

  // Block obvious system dirs
  const lower =
    process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (BLOCKED_BRIDGE_PATH_PREFIXES.some((p) => lower.startsWith(p))) {
    return res
      .status(400)
      .json({
      error: "Path targets a protected system directory",
      code: ErrorCode.PANELBRIDGE_PATH_PROTECTED_SYSTEM_DIR,
    });
  }

  try {
    await bridge.stopSftp();
    if (bridge.isRunning) {
      bridge.stop();
    }
    const configuredPath = bridge.configure(resolved, true);
    bridge.start();
    // Persist so index.js's findPanelBridgePath() restore (settings.panelBridge.bridgePath)
    // finds this again after a panel restart -- this route is the manual escape hatch for
    // when auto-detect can't find the bridge on its own, so it's the one case that can't
    // self-heal without this.
    await setSetting("panelBridge", { bridgePath: configuredPath });
    res.json({
      success: true,
      message: "Bridge configured with manual path and started",
      bridgePath: configuredPath,
    });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/sftp/test", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const config = await resolveSftpConfig(req.body);
    const result = await testSftpBridge(config);
    res.json(result);
  } catch (error) {
    // error (English, unchanged) is the pre-2026-08-26-classification fallback
    // for any client that doesn't read `code` -- code + params.detail let an
    // updated client show the exact same classification, translated, with
    // the original error text preserved as {{detail}} rather than replaced
    // by a vaguer generic sentence (see errorCodes.js's SFTP_* entries).
    res.status(400).json({
      error: sanitizeError(formatSftpError(error)),
      code: classifySftpErrorCode(error),
      params: sanitizeErrorParams({ detail: error?.message || String(error) }),
    });
  }
});

router.post("/sftp/configure", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const config = await resolveSftpConfig(req.body);
    const cachePath = getSftpCachePath(config);
    await bridge.configureSftp(config, cachePath);
    for (const [field, key] of Object.entries(SFTP_SETTING_KEYS)) {
      const value = field === "enabled" ? true : config[field];
      if (value !== undefined) await setSetting(key, value);
    }
    res.json({ success: true, bridgePath: cachePath, transport: bridge.getStatus().transport });
  } catch (error) {
    res.status(400).json({
      error: sanitizeError(formatSftpError(error)),
      code: classifySftpErrorCode(error),
      params: sanitizeErrorParams({ detail: error?.message || String(error) }),
    });
  }
});

router.post("/sftp/logs/list", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const config = await resolveSftpLogConfig(req.body);
    const result = await listSftpLogs(config);
    if (req.body?.logPath) await setSetting(SFTP_LOG_PATH_KEY, config.logPath);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

router.post("/sftp/logs/tail", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const config = await resolveSftpLogConfig(req.body);
    const result = await readSftpLogTail(config, req.body?.name, req.body?.maxBytes);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

// Verify the remote Server/ folder the config editor mirrors for a remote server.
router.post("/sftp/config/list", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const settings = await getAllSettings();
    const password =
      req.body?.password && !isMaskedSecret(req.body.password)
        ? req.body.password
        : settings[SFTP_SETTING_KEYS.password] || "";
    const config = validateRemoteConfigTransport({
      host: req.body?.host ?? settings[SFTP_SETTING_KEYS.host],
      port: req.body?.port ?? settings[SFTP_SETTING_KEYS.port],
      username: req.body?.username ?? settings[SFTP_SETTING_KEYS.username],
      password,
      configPath: req.body?.configPath ?? settings[SFTP_CONFIG_PATH_KEY],
    });
    const result = await listRemoteConfigFiles(config);
    if (req.body?.configPath) {
      await setSetting(SFTP_CONFIG_PATH_KEY, config.configPath);
      resetRemoteConfigSession();
    }
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

// Start the bridge polling
router.post("/start", requirePermission("bridge.setup"), (req, res) => {
  try {
    bridge.start();
    res.json({ success: true, message: "Bridge started" });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Stop the bridge
router.post("/stop", requirePermission("bridge.setup"), async (req, res) => {
  try {
    await bridge.stopSftp();
    bridge.stop();
    res.json({ success: true, message: "Bridge stopped" });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Scan for all panelbridge folders across known locations
router.get("/scan-paths", requirePermission("bridge.setup"), async (req, res) => {
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
router.post("/refresh", requirePermission("bridge.setup"), (req, res) => {
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
    return res.status(400).json({
      error: "Bridge not configured",
      code: ErrorCode.BRIDGE_NOT_CONFIGURED,
    });
  }

  try {
    const result = await bridge.ping();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Send a command to the game. Gated on bridge.command for consistency with
// the other powerful/destructive routes (backup restore, chunk deletion,
// server wipe) — this is the generic passthrough for ANY PanelBridge
// handler (teleport, giveItem, character import/export, horde spawning,
// etc.), not just the curated preset buttons in the Events UI. Neither
// technician nor moderator holds bridge.command in the default role seed
// (see permissions.js's DEFAULT_ROLE_CAPABILITIES) — only admin does,
// automatically, by holding every capability. This gate is live and doing
// real work today: roles are data now, an operator can create a custom
// role and grant it bridge.command deliberately, and this is exactly what
// stops that role also getting the unrestricted passthrough by accident.
// EXCEPT for GM_TOOLS_ONLY_ACTIONS and ENDANGER_OR_IMPERSONATE_ONLY_ACTIONS
// (see requireBridgeCommandUnlessGmToolsOnly and BRIDGE_ACTION_CAPABILITY's
// own comment above) — those twelve skip this gate entirely and are
// enforced solely by their inline single-capability check further down in
// this handler.
router.post("/command", requireBridgeCommandUnlessGmToolsOnly, async (req, res) => {
  const activeServer = await getActiveServer();
  if (activeServer?.isRemote && !bridge.isSftpRunning() && !bridge.isRunning) {
    return res.status(400).json({
      error:
        "PanelBridge requires a configured mapped drive or a running SFTP bridge transport for remote servers.",
      code: ErrorCode.PANELBRIDGE_COMMAND_REMOTE_TRANSPORT_UNAVAILABLE,
    });
  }

  const { action, args } = req.body || {};

  if (!action) {
    return res.status(400).json({
      error: "action is required",
      code: ErrorCode.PANELBRIDGE_ACTION_REQUIRED,
    });
  }

  // Validate action against whitelist
  if (typeof action !== "string" || !VALID_ACTIONS.has(action)) {
    return res.status(400).json({
      error: "Unknown or invalid action",
      code: ErrorCode.PANELBRIDGE_UNKNOWN_ACTION,
    });
  }

  // Validate args if provided
  if (
    args !== undefined &&
    (typeof args !== "object" || args === null || Array.isArray(args))
  ) {
    return res.status(400).json({
      error: "args must be an object",
      code: ErrorCode.PANELBRIDGE_ARGS_MUST_BE_OBJECT,
    });
  }

  // See BRIDGE_ACTION_CAPABILITY's own comment above for the two different
  // gating shapes here: the four moderation actions need players.moderate
  // ADDITIONALLY, on top of the bridge.command gate already enforced by
  // requireBridgeCommandUnlessGmToolsOnly above. The GM four
  // (GM_TOOLS_ONLY_ACTIONS) and the eight endanger_or_impersonate actions
  // (ENDANGER_OR_IMPERSONATE_ONLY_ACTIONS) never went through that gate at
  // all for this request -- their one mapped capability here is their ONLY
  // gate, not an addition.
  const requiredCapability = BRIDGE_ACTION_CAPABILITY[action];
  if (requiredCapability) {
    const role = req.user ? await getRoleByName(req.user.role) : null;
    const capabilities = Array.isArray(role?.capabilities) ? role.capabilities : [];
    if (!capabilities.includes(requiredCapability)) {
      const isReplacementSemantics =
        GM_TOOLS_ONLY_ACTIONS.has(action) || ENDANGER_OR_IMPERSONATE_ONLY_ACTIONS.has(action);
      return res.status(403).json({
        error: isReplacementSemantics
          ? `"${action}" requires ${requiredCapability}.`
          : `"${action}" also requires ${requiredCapability}.`,
        code: ErrorCode.PANELBRIDGE_ACTION_CAPABILITY_REQUIRED,
      });
    }
  }

  // Build 42 does not expose a Lua vehicle-spawn API. The RCON command is
  // the supported server path and returns its result directly to the map.
  if (action === "spawnVehicleAt") {
    const vehicle = args?.vehicle ?? args?.scriptName;
    const x = Number(args?.x);
    const y = Number(args?.y);
    const z = Number(args?.z ?? 0);
    if (typeof vehicle !== "string" || !VEHICLE_SCRIPT_REGEX.test(vehicle)) {
      return res.status(400).json({
      error: "Invalid vehicle script name",
      code: ErrorCode.PANELBRIDGE_INVALID_VEHICLE_SCRIPT_NAME,
    });
    }
    if (
      !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) ||
      x < 0 || x > 24000 || y < 0 || y > 24000 || z < 0 || z > 8 ||
      (x === 0 && y === 0)
    ) {
      return res.status(400).json({
      error: "Invalid coordinates (x/y: 0-24000, z: 0-8)",
      code: ErrorCode.PANELBRIDGE_SPAWN_VEHICLE_INVALID_COORDS,
    });
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
    return res.status(400).json({
      error: "Bridge not configured",
      code: ErrorCode.BRIDGE_NOT_CONFIGURED,
    });
  }

  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
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
        .json({
      error: "Invalid airdrop coordinates (valid: 0-24000)",
      code: ErrorCode.PANELBRIDGE_AIRDROP_INVALID_COORDS,
    });
    }
    if (
      args.preset &&
      (typeof args.preset !== "string" || !VALID_PRESETS.includes(args.preset))
    ) {
      return res
        .status(400)
        .json({
      error: `Invalid preset. Valid: ${VALID_PRESETS.join(", ")}`,
      code: ErrorCode.PANELBRIDGE_AIRDROP_INVALID_PRESET,
      params: sanitizeErrorParams({ presets: VALID_PRESETS.join(", ") }),
    });
    }
    if (args.items && (!Array.isArray(args.items) || args.items.length > 50)) {
      return res
        .status(400)
        .json({
      error: "items must be an array with at most 50 entries",
      code: ErrorCode.PANELBRIDGE_AIRDROP_ITEMS_ARRAY_INVALID,
    });
    }
    if (Array.isArray(args.items)) {
      for (const entry of args.items) {
        if (!entry || typeof entry !== "object") {
          return res
            .status(400)
            .json({
      error: "Each item must be an object with itemType",
      code: ErrorCode.PANELBRIDGE_AIRDROP_ITEM_INVALID,
    });
        }
        if (
          typeof entry.itemType !== "string" ||
          !ITEM_TYPE_REGEX.test(entry.itemType)
        ) {
          const itemType = String(entry.itemType).slice(0, 60);
          return res.status(400).json({
            error: `Invalid item type format: ${itemType}`,
            code: ErrorCode.PANELBRIDGE_AIRDROP_ITEM_TYPE_INVALID,
            params: sanitizeErrorParams({ itemType }),
          });
        }
        if (
          entry.count !== undefined &&
          (typeof entry.count !== "number" ||
            entry.count < 1 ||
            entry.count > 20)
        ) {
          return res.status(400).json({
      error: "Item count must be 1-20",
      code: ErrorCode.PANELBRIDGE_AIRDROP_ITEM_COUNT_INVALID,
    });
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

    // 2026-08-31 bug hunt: services/panelBridge.js's processResult() attaches
    // a rich soft-failure diagnostic table to err.data specifically so "a
    // caller that wants the diagnostics can get them" (see that function's
    // own comment) -- but every branch below built its response from
    // error.message alone, discarding it at this boundary. Conditional: a
    // genuine transport failure (bridge not configured/running, a timeout)
    // never sets .data, so those responses are byte-identical to before.
    //
    // Spread directly into the body, NOT nested under a `data` key: the
    // client's ApiError.data (client/src/lib/api.ts's buildResponseError)
    // is the ENTIRE parsed response body, so a top-level field here is what
    // reaches `error.data.<field>` -- e.g. getRecoveryUrl() already reads
    // error.data.fixUrl straight off the body on other routes. Nesting an
    // extra `data:` key here would have put the diagnostic table at
    // error.data.data instead, one level deeper than every existing and
    // planned consumer expects (Events.tsx's BridgeResultDisplay reads
    // error.data directly and feeds it straight to
    // isEventSequenceResultData(), which checks top-level `executed`/
    // `failedCount`/`results`). error/category are spread LAST so they
    // cannot be clobbered by a same-named field in the diagnostic table.
    //
    // Checked the consumer before shipping this (client/src/lib/
    // errorMessage.ts): neither getUserErrorMessage() nor getRecoveryUrl()
    // read anything from this specific table (no `params`, no `fixUrl`
    // key), so no user-visible error TEXT changes for any existing caller --
    // only Events.tsx's BridgeResultDisplay path, which already reads
    // error.data defensively (?? null) and was simply getting null every
    // time until now.
    const diagnosticFields =
      error?.data && typeof error.data === "object" ? error.data : {};

    if (/timeout/i.test(message)) {
      return res
        .status(504)
        .json({ ...diagnosticFields, error: message, category: "timeout" });
    }
    if (
      /not configured|not running|unhealthy|not responding|stale|missing/i.test(
        message,
      )
    ) {
      return res
        .status(503)
        .json({ ...diagnosticFields, error: message, category: "bridge-unavailable" });
    }
    if (/invalid|required/i.test(message)) {
      return res
        .status(400)
        .json({ ...diagnosticFields, error: message, category: "validation" });
    }

    return res
      .status(500)
      .json({ ...diagnosticFields, error: message, category: "unknown" });
  }
});

// Get weather info
router.get("/weather", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.bridgePath) {
    return res.status(400).json({
      error: "Bridge not configured",
      code: ErrorCode.BRIDGE_NOT_CONFIGURED,
    });
  }
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }

  try {
    const result = await bridge.getWeather();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get server info
router.get("/server-info", requirePermission("players.view"), async (req, res) => {
  if (!bridge.bridgePath) {
    return res.status(400).json({
      error: "Bridge not configured",
      code: ErrorCode.BRIDGE_NOT_CONFIGURED,
    });
  }
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
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
router.post("/weather/blizzard", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { duration } = req.body || {};
  try {
    const result = await bridge.triggerBlizzard(duration);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/tropical-storm", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { duration } = req.body || {};
  try {
    const result = await bridge.triggerTropicalStorm(duration);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/storm", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { duration } = req.body || {};
  if (
    duration !== undefined &&
    (typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration < 0 ||
      duration > 168)
  ) {
    return res
      .status(400)
      .json({
      error: "duration must be a number 0-168 (hours)",
      code: ErrorCode.PANELBRIDGE_STORM_DURATION_INVALID,
    });
  }
  try {
    const result = await bridge.triggerStorm(duration);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/stop", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.stopWeather();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Generate weather period
router.post("/weather/generate", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { strength, frontType } = req.body || {};
  if (
    strength !== undefined &&
    (typeof strength !== "number" ||
      !Number.isFinite(strength) ||
      strength < 0 ||
      strength > 1)
  ) {
    return res.status(400).json({
      error: "strength must be a number 0-1",
      code: ErrorCode.PANELBRIDGE_WEATHER_STRENGTH_INVALID,
    });
  }
  if (
    frontType !== undefined &&
    (typeof frontType !== "number" ||
      !Number.isInteger(frontType) ||
      frontType < 0 ||
      frontType > 5)
  ) {
    return res.status(400).json({
      error: "frontType must be an integer 0-5",
      code: ErrorCode.PANELBRIDGE_WEATHER_FRONT_TYPE_INVALID,
    });
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

router.post("/weather/snow", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { enabled, intensity } = req.body || {};
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  if (
    intensity !== undefined &&
    intensity !== null &&
    (typeof intensity !== "number" ||
      !Number.isFinite(intensity) ||
      intensity < 0 ||
      intensity > 1)
  ) {
    return res.status(400).json({
      error: "intensity must be a number 0-1",
      code: ErrorCode.BRIDGE_INTENSITY_MUST_BE_NUMBER_0_1,
    });
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
router.post("/weather/rain/start", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { intensity } = req.body || {};
  if (
    intensity !== undefined &&
    (typeof intensity !== "number" ||
      !Number.isFinite(intensity) ||
      intensity < 0 ||
      intensity > 1)
  ) {
    return res.status(400).json({
      error: "intensity must be a number 0-1",
      code: ErrorCode.BRIDGE_INTENSITY_MUST_BE_NUMBER_0_1,
    });
  }
  try {
    const result = await bridge.startRain(intensity ?? 0.5);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/rain/stop", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.stopRain();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Lightning
router.post("/weather/lightning", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { x, y, strike, light, rumble } = req.body || {};
  if (x !== undefined && (typeof x !== "number" || !Number.isFinite(x))) {
    return res.status(400).json({
      error: "x must be a number",
      code: ErrorCode.PANELBRIDGE_LIGHTNING_X_INVALID,
    });
  }
  if (y !== undefined && (typeof y !== "number" || !Number.isFinite(y))) {
    return res.status(400).json({
      error: "y must be a number",
      code: ErrorCode.PANELBRIDGE_LIGHTNING_Y_INVALID,
    });
  }
  try {
    const result = await bridge.triggerLightning(x, y, strike, light, rumble);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Climate float control
router.get("/climate/floats", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.getClimateFloats();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/climate/float", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { floatId, value, enable } = req.body || {};
  if (floatId === undefined || value === undefined) {
    return res.status(400).json({
      error: "floatId and value are required",
      code: ErrorCode.PANELBRIDGE_CLIMATE_FLOAT_FIELDS_REQUIRED,
    });
  }
  if (
    typeof floatId !== "number" ||
    !Number.isInteger(floatId) ||
    floatId < 0 ||
    floatId > 12
  ) {
    return res.status(400).json({
      error: "floatId must be an integer 0-12",
      code: ErrorCode.PANELBRIDGE_CLIMATE_FLOAT_ID_INVALID,
    });
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return res.status(400).json({
      error: "value must be a number",
      code: ErrorCode.PANELBRIDGE_CLIMATE_FLOAT_VALUE_INVALID,
    });
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

router.post("/climate/reset", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.resetClimateOverrides();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Individual climate shortcuts (setTemperature/setWind/setFog/setClouds).
// hunt-wave12-2026-08-30 UI-reachability audit: all four are dead routes --
// nothing in client/src calls any of them. The feature is not missing:
// Events.tsx's climate panel (temperature/wind/fog/clouds/humidity/
// precipitation sliders) applies through the generic setClimateFloat
// action instead, with hardcoded float ids (temperature=4, wind=6, fog=5,
// clouds=8; humidity=12 and precipitation=3 have no single-purpose route
// at all) -- these single-purpose routes were superseded and never wired
// or removed. Documented rather than deleted per the operator's own
// standard for this class of shadowed route (see healPlayer/setGodMode/
// setInvisible below, and getSandboxOptions/saveWorld further down).
router.post("/climate/temperature", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { value } = req.body || {};
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < -50 ||
      value > 50)
  ) {
    return res.status(400).json({
      error: "value must be a number -50 to 50",
      code: ErrorCode.PANELBRIDGE_TEMPERATURE_VALUE_INVALID,
    });
  }
  try {
    const result = await bridge.setTemperature(value ?? 22);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Dead route, live path setClimateFloat(6, ...) -- see comment above /climate/temperature.
router.post("/climate/wind", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { value } = req.body || {};
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1)
  ) {
    return res.status(400).json({
      error: "value must be a number 0-1",
      code: ErrorCode.BRIDGE_VALUE_MUST_BE_NUMBER_0_1,
    });
  }
  try {
    const result = await bridge.setWind(value ?? 0.5);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Dead route, live path setClimateFloat(5, ...) -- see comment above /climate/temperature.
router.post("/climate/fog", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { value } = req.body || {};
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1)
  ) {
    return res.status(400).json({
      error: "value must be a number 0-1",
      code: ErrorCode.BRIDGE_VALUE_MUST_BE_NUMBER_0_1,
    });
  }
  try {
    const result = await bridge.setFog(value ?? 0);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Dead route, live path setClimateFloat(8, ...) -- see comment above /climate/temperature.
router.post("/climate/clouds", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { value } = req.body || {};
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1)
  ) {
    return res.status(400).json({
      error: "value must be a number 0-1",
      code: ErrorCode.BRIDGE_VALUE_MUST_BE_NUMBER_0_1,
    });
  }
  try {
    const result = await bridge.setClouds(value ?? 0);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Game time endpoints
router.get("/time", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.getGameTime();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/time", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { hour, day, month, year } = req.body || {};
  if (
    hour !== undefined &&
    (typeof hour !== "number" ||
      !Number.isInteger(hour) ||
      hour < 0 ||
      hour > 23)
  ) {
    return res.status(400).json({
      error: "hour must be an integer 0-23",
      code: ErrorCode.PANELBRIDGE_GAMETIME_HOUR_INVALID,
    });
  }
  if (
    day !== undefined &&
    (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 31)
  ) {
    return res.status(400).json({
      error: "day must be an integer 1-31",
      code: ErrorCode.PANELBRIDGE_GAMETIME_DAY_INVALID,
    });
  }
  if (
    month !== undefined &&
    (typeof month !== "number" ||
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12)
  ) {
    return res.status(400).json({
      error: "month must be an integer 1-12",
      code: ErrorCode.PANELBRIDGE_GAMETIME_MONTH_INVALID,
    });
  }
  if (
    year !== undefined &&
    (typeof year !== "number" ||
      !Number.isInteger(year) ||
      year < 1 ||
      year > 9999)
  ) {
    return res.status(400).json({
      error: "year must be an integer 1-9999",
      code: ErrorCode.PANELBRIDGE_GAMETIME_YEAR_INVALID,
    });
  }
  try {
    const result = await bridge.setGameTime({ hour, day, month, year });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// World stats
router.get("/world/stats", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.getWorldStats();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Save world. admin+technician, matching /api/server/save -- an operational
// action, not player-facing GM authority.
// hunt-wave12-2026-08-30 UI-reachability audit: this dedicated route itself
// is dead -- nothing in client/src calls POST /panel-bridge/world/save
// directly. Two separate live paths exist instead: Scheduler.tsx's
// schedulable 'bridge:saveWorld' preset (still this same action, via the
// /panel-bridge/command passthrough, not this route); and Dashboard.tsx's
// "Save world" button, which goes through serverApi.save (server.js's own
// /servers/:id/save-world, over RCON) -- a completely different code path
// for a similarly-named but independent feature, not a shadow of this one.
router.post("/world/save", requirePermission("server.control"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.saveWorld();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Player endpoints
router.get("/players", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.getAllPlayerDetails();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/players/:username", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  if (!BRIDGE_USERNAME_REGEX.test(req.params.username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  try {
    const result = await bridge.getPlayerDetails(req.params.username);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "Failed to get player details",
      code: ErrorCode.PANELBRIDGE_GET_PLAYER_DETAILS_FAILED,
    });
  }
});

router.post("/players/:username/teleport", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  if (!BRIDGE_USERNAME_REGEX.test(req.params.username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  const { x, y, z } = req.body || {};
  if (x === undefined || y === undefined) {
    return res.status(400).json({
      error: "x and y coordinates are required",
      code: ErrorCode.BRIDGE_XY_COORDS_REQUIRED,
    });
  }
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    (z !== undefined && typeof z !== "number")
  ) {
    return res.status(400).json({
      error: "Coordinates must be numbers",
      code: ErrorCode.PANELBRIDGE_TELEPORT_COORDS_NOT_NUMBERS,
    });
  }
  if (x < 0 || x > 24000 || y < 0 || y > 24000) {
    return res
      .status(400)
      .json({
        error: "x/y coordinates out of range (0-24000)",
        code: ErrorCode.PANELBRIDGE_TELEPORT_XY_OUT_OF_RANGE,
      });
  }
  if (z !== undefined && (z < 0 || z > 8)) {
    return res.status(400).json({
      error: "z coordinate out of range (0-8)",
      code: ErrorCode.PANELBRIDGE_TELEPORT_Z_OUT_OF_RANGE,
    });
  }
  try {
    const result = await bridge.teleportPlayer(req.params.username, x, y, z);
    res.json(result);
  } catch (error) {
    // Same drop as POST /command's catch (2026-08-31 bug hunt, see its own
    // comment) -- teleportPlayer's verify-false soft failure attaches
    // verifyPosition/newPosition to err.data via processResult(), and this
    // dedicated route (a live path: client/src/lib/api.ts's
    // teleportPlayerBridge) discarded it same as the generic passthrough
    // did. Spread first, error/code last, so they can't be clobbered by a
    // same-named field in the diagnostic table -- see POST /command's
    // catch for why this is a flat spread, not nested under a `data` key.
    const diagnosticFields =
      error?.data && typeof error.data === "object" ? error.data : {};
    res.status(500).json({
      ...diagnosticFields,
      error: "Teleport failed",
      code: ErrorCode.PANELBRIDGE_TELEPORT_FAILED,
    });
  }
});

// Server message (routed via sendToServerChat; no dedicated sendServerMessage Lua handler)
router.post("/message", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { message } = req.body || {};
  if (!message || typeof message !== "string" || message.length > 2000) {
    return res
      .status(400)
      .json({
        error: "message is required (max 2000 chars)",
        code: ErrorCode.BRIDGE_MESSAGE_REQUIRED,
      });
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
// hunt-wave12-2026-08-30 UI-reachability audit: dead route -- nothing in
// client/src calls GET /panel-bridge/sandbox. ServerConfig.tsx reads
// sandbox options through the passthrough action getAllSandboxOptions
// instead (a different, broader action, not this route's getSandboxOptions).
router.get("/sandbox", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.getSandboxOptions();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get available commands. NOT verified complete -- despite the "complete
// reference" claim this comment used to make, it has no consumer anywhere
// in this codebase (confirmed by grep across client/src and a full-history
// pickaxe on the client wrapper, panelBridgeApi.getCommands: zero callers
// were ever added since the wrapper's own introduction in the initial
// commit), so nothing has ever enforced it staying in sync with
// VALID_ACTIONS as new actions were added. panelBridgeCommandsDocStaleness
// .test.js gates the SAFE half (no entry here that isn't a real
// VALID_ACTIONS member -- see its own header comment for why the other
// half, every VALID_ACTIONS member having a doc entry, isn't gated too:
// several missing actions have no dedicated route anywhere in this
// codebase to verify a real argument shape through, and documenting a
// shape nobody has confirmed would be worse than the current gap).
// bug-hunt-2026-08-27.
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
      // addLamppost/removeLamppost removed here 2026 (release v0.8.0, commit
      // f47ea1a) -- deliberately dropped from VALID_ACTIONS, but these two
      // documentation entries were left behind and kept advertising them as
      // callable. POST /command's whitelist check would refuse either one
      // with "Unknown or invalid action" if anyone tried, since neither name
      // exists in VALID_ACTIONS any more. bug-hunt-2026-08-27.

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
router.get("/mod-path", requirePermission("bridge.setup"), async (req, res) => {
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

// Explicitly install/update PanelBridge.lua on the active server's local
// filesystem (bind mount / same-host install). See services/panelBridgeInstaller.js
// — this is the manual counterpart to the auto-install run on activation.
router.post("/install-local", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const server = await getActiveServer();
    if (!server) {
      return res
        .status(400)
        .json({
          success: false,
          error: "No active server configured.",
          code: ErrorCode.PANELBRIDGE_NO_ACTIVE_SERVER,
        });
    }

    if (!canAutoInstall(server)) {
      return res.status(400).json({
        success: false,
        error:
          "Auto-install is not available for this server. It must be a local (non-remote) server with a writable install path and the PanelBridge source present.",
        code: ErrorCode.PANELBRIDGE_AUTO_INSTALL_NOT_AVAILABLE,
      });
    }

    const result = installBridge(server);
    if (!result.success) {
      return res.status(500).json(result);
    }

    res.json({
      ...result,
      message: `PanelBridge installed to ${result.targetPath}`,
      serverName: server.serverName || server.name,
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: sanitizeError(error.message) });
  }
});

// Auto-install mod to server's Lua folder (optionally specify serverId)
router.post("/install-mod-auto", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const { serverId } = req.body || {};

    // Get specified server or active server
    let targetServer;
    if (serverId) {
      targetServer = await getServer(serverId);
      if (!targetServer) {
        return res.status(400).json({
          error: `Server with ID ${serverId} not found.`,
          code: ErrorCode.PANELBRIDGE_SERVER_ID_NOT_FOUND,
          params: sanitizeErrorParams({ serverId }),
        });
      }
    } else {
      targetServer = await getActiveServer();
      if (!targetServer) {
        return res.status(400).json({
          error: "No active server configured.",
          code: ErrorCode.PANELBRIDGE_NO_ACTIVE_SERVER,
        });
      }
    }

    if (targetServer.isRemote) {
      return res.status(400).json({
        error: "Automatic PanelBridge installation is unavailable for remote servers. Copy PanelBridge.lua to the remote server's Lua folder using SFTP or the hosting provider's file manager.",
        code: ErrorCode.PANELBRIDGE_INSTALL_REMOTE_NOT_AVAILABLE,
      });
    }

    if (!canAutoInstall(targetServer)) {
      return res.status(400).json({
        error: "Automatic PanelBridge installation is unavailable. Configure an existing local server install folder with write permission, or use the manual install path.",
        code: ErrorCode.PANELBRIDGE_INSTALL_CANNOT_AUTO_INSTALL,
      });
    }

    const installResult = installBridge(targetServer);
    if (!installResult.success) {
      return res.status(500).json(installResult);
    }

    return res.json({
      ...installResult,
      message: installResult.message || `PanelBridge installed to ${installResult.targetPath}`,
      serverName: targetServer.serverName || targetServer.name,
    });

  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Copy mod to server Lua folder (manual path)
router.post("/install-mod", requirePermission("bridge.setup"), (req, res) => {
  const { serverLuaPath } = req.body || {};

  // Support legacy field name
  const targetPath = serverLuaPath || req.body.serverModsPath;

  if (!targetPath) {
    return res
      .status(400)
      .json({
        error: "serverLuaPath is required (path to media/lua/server/)",
        code: ErrorCode.PANELBRIDGE_SERVER_LUA_PATH_REQUIRED,
      });
  }

  // Validate path: must be a string, absolute, no traversal
  if (typeof targetPath !== "string" || targetPath.length > 500) {
    return res.status(400).json({
      error: "Invalid path format",
      code: ErrorCode.PANELBRIDGE_SERVER_LUA_PATH_FORMAT_INVALID,
    });
  }

  // Must check isAbsolute() on the raw input: path.resolve() always
  // returns an absolute path (resolved against cwd), so checking it after
  // resolving would never reject anything and silently accepted relative
  // paths as if they'd been rejected. (The real containment check is the
  // realpath + /media/lua/server suffix check below, which does work.)
  if (!path.isAbsolute(targetPath)) {
    return res.status(400).json({
      error: "Must be an absolute path",
      code: ErrorCode.PANELBRIDGE_SERVER_LUA_PATH_NOT_ABSOLUTE,
    });
  }
  const resolvedTarget = path.resolve(targetPath);

  // Resolve symlinks to prevent traversal via symlink chains
  let realTarget;
  try {
    // If target doesn't exist yet, resolve the parent and join
    // codeql[js/path-injection] targetPath is required to be absolute, resolved and realpath'd, then required to end in /media/lua/server(/) (suffix-containment check) before this line runs -- see the guard chain starting a few lines above ('Validate path: must be a string, absolute, no traversal').
    if (fs.existsSync(resolvedTarget)) {
      realTarget = fs.realpathSync(resolvedTarget);
    } else {
      const parent = path.dirname(resolvedTarget);
      // codeql[js/path-injection] targetPath is required to be absolute, resolved and realpath'd, then required to end in /media/lua/server(/) (suffix-containment check) before this line runs -- see the guard chain starting a few lines above ('Validate path: must be a string, absolute, no traversal').
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
      .json({
        error: "Path must point to a media/lua/server/ directory",
        code: ErrorCode.PANELBRIDGE_SERVER_LUA_PATH_WRONG_DIRECTORY,
      });
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
        code: ErrorCode.PANELBRIDGE_SOURCE_MOD_NOT_FOUND,
      });
    }

    // Ensure target directory exists (use realTarget for safety)
    // codeql[js/path-injection] targetPath is required to be absolute, resolved and realpath'd, then required to end in /media/lua/server(/) (suffix-containment check) before this line runs -- see the guard chain starting a few lines above ('Validate path: must be a string, absolute, no traversal').
    if (!fs.existsSync(realTarget)) {
      // codeql[js/path-injection] targetPath is required to be absolute, resolved and realpath'd, then required to end in /media/lua/server(/) (suffix-containment check) before this line runs -- see the guard chain starting a few lines above ('Validate path: must be a string, absolute, no traversal').
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
router.post("/sound/world", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { x, y, z, radius, volume } = req.body || {};
  if (x === undefined || y === undefined) {
    return res.status(400).json({
      error: "x and y coordinates are required",
      code: ErrorCode.BRIDGE_XY_COORDS_REQUIRED,
    });
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
      .json({
        error: "Coordinates out of range (valid: 0-24000)",
        code: ErrorCode.PANELBRIDGE_SOUND_COORDS_OUT_OF_RANGE,
      });
  }
  try {
    const result = await bridge.playWorldSound(x, y, z, radius, volume);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Play sound near a player
router.post("/sound/near-player", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { username, radius, volume } = req.body || {};
  if (!username || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Valid username is required",
      code: ErrorCode.BRIDGE_VALID_USERNAME_REQUIRED,
    });
  }
  try {
    const result = await bridge.playSoundNearPlayer(username, radius, volume);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "Failed to play sound",
      code: ErrorCode.PANELBRIDGE_PLAY_SOUND_FAILED,
    });
  }
});

// Trigger gunshot sound
router.post("/sound/gunshot", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { x, y, z, username } = req.body || {};
  if (username && !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  try {
    const result = await bridge.triggerGunshot({ x, y, z, username });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "Failed to trigger gunshot",
      code: ErrorCode.PANELBRIDGE_TRIGGER_GUNSHOT_FAILED,
    });
  }
});

// Trigger alarm sound
router.post("/sound/alarm", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { x, y, z, username } = req.body || {};
  if (username && !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  try {
    const result = await bridge.triggerAlarmSound({ x, y, z, username });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Create custom noise
router.post("/sound/noise", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { x, y, z, radius, volume, username } = req.body || {};
  if (username && !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
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
router.get("/utilities/status", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.sendCommand("getUtilitiesStatus", {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Restore utilities (turn power/water back on)
router.post("/utilities/restore", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { power, water } = req.body || {};
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
router.post("/utilities/shutoff", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { power, water } = req.body || {};
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
router.post("/character/export", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { username } = req.body || {};
  if (!username || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid or missing username",
      code: ErrorCode.BRIDGE_INVALID_OR_MISSING_USERNAME,
    });
  }
  try {
    const result = await bridge.sendCommand("exportPlayerData", { username });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Import character data (apply XP, perks to player)
router.post("/character/import", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { username, data, options } = req.body || {};
  if (!username || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid or missing username",
      code: ErrorCode.BRIDGE_INVALID_OR_MISSING_USERNAME,
    });
  }
  if (!data) {
    return res.status(400).json({
      error: "Character data is required",
      code: ErrorCode.PANELBRIDGE_CHARACTER_DATA_REQUIRED,
    });
  }
  // Validate data is an object with expected structure
  if (typeof data !== "object" || Array.isArray(data)) {
    return res.status(400).json({
      error: "Character data must be an object",
      code: ErrorCode.PANELBRIDGE_CHARACTER_DATA_NOT_OBJECT,
    });
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
      code: ErrorCode.PANELBRIDGE_CHARACTER_DATA_NO_VALID_SECTION,
      params: sanitizeErrorParams({ sections: validSections.join(", ") }),
    });
  }
  // Snapshot the target's CURRENT data before overwriting it. Unlike a
  // config edit, another player's XP/perks/inventory can't be reconstructed
  // by hand if the wrong file lands on the wrong player -- so a failed
  // snapshot REFUSES the import rather than warning and proceeding, the
  // opposite of this codebase's config-write backup policy (a false sense
  // of safety is worse than an honest refusal here). Reuses the same bridge
  // command GET /character/export already calls and writes into the same
  // exports/<username>/ directory + filename convention autoExportPlayer
  // (server/index.js) uses, so a successful snapshot is immediately visible
  // and downloadable from Players.tsx's existing Saved Exports list with no
  // client changes.
  let snapshotPath;
  try {
    const snapshot = await bridge.sendCommand("exportPlayerData", { username });
    const { dataDir } = getDataPaths();
    const safeUsername = username.replace(/[^a-zA-Z0-9_-]/g, "_");
    const exportDir = path.join(dataDir, "exports", safeUsername);
    // codeql[js/path-injection] username is stripped to [a-zA-Z0-9_-] via safeUsername = username.replace(...) immediately above before being joined into this path.
    fs.mkdirSync(exportDir, { recursive: true });
    // toISOString() is millisecond-resolution -- two imports for the same
    // player landing in the same millisecond (a double-submit before the
    // button disables, or a retried request) would otherwise make the
    // second import's "recovery copy" silently overwrite the first, which
    // is worse than the failure this snapshot exists to guard against: the
    // route would still report success and the earlier pre-import state
    // would just be gone. Same collision-suffix convention as
    // autoExportPlayer() (server/index.js), which writes into this same
    // exports/<username>/ directory.
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snapshotBaseName = `${safeUsername}_pre-import_${timestamp}`;
    snapshotPath = path.join(exportDir, `${snapshotBaseName}.json`);
    for (let collision = 2; fs.existsSync(snapshotPath); collision++) {
      snapshotPath = path.join(
        exportDir,
        `${snapshotBaseName}-${collision}.json`,
      );
    }
    fs.writeFileSync(
      // codeql[js/path-injection] username is stripped to [a-zA-Z0-9_-] via safeUsername = username.replace(...) immediately above before being joined into this path.
      snapshotPath,
      JSON.stringify(snapshot.data ?? snapshot, null, 2),
    );
  } catch (error) {
    return res.status(502).json({
      error: `Could not snapshot ${username}'s current data before import — refusing to overwrite without a recovery copy: ${sanitizeError(error.message)}`,
    });
  }

  try {
    const result = await bridge.sendCommand("importPlayerData", {
      username,
      data,
      options,
    });
    res.json({ ...result, snapshotFile: path.basename(snapshotPath) });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ============================================
// PLAYER ADMIN CONTROLS
// ============================================

// Give item to player
// hunt-wave12-2026-08-30 UI-reachability audit: dead route -- nothing in
// client/src calls it. Players.tsx's "Give items" flow (SpawnBrowser
// dialog) calls playersApi.addItem instead -- a different API family
// entirely (players.js's own route, not this file's giveItem action).
router.post("/players/:username/give-item", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { username } = req.params;
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  const { itemType, count = 1 } = req.body || {};
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
    return res.status(400).json({
      error: "count must be 1-100",
      code: ErrorCode.PANELBRIDGE_HORDE_COUNT_INVALID,
    });
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
// Dead route, live path is the bridge.command passthrough -- see the
// 2026-08-27/2026-08-30 comment above BRIDGE_ACTION_CAPABILITY.
router.post("/players/:username/heal", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { username } = req.params;
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  try {
    const result = await bridge.sendCommand("healPlayer", { username });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Kill player
router.post("/players/:username/kill", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { username } = req.params;
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  try {
    const result = await bridge.sendCommand("killPlayer", { username });
    res.json(result);
  } catch (error) {
    // Same drop as POST /command's catch (2026-08-31 bug hunt, see its own
    // comment) -- killPlayer's not-dead soft failure attaches its own
    // diagnostic data to err.data via processResult(), and this dedicated
    // route (a live path: client/src/lib/api.ts's killPlayer) discarded it
    // same as the generic passthrough did. Spread first, error last, so it
    // can't be clobbered by a same-named field in the diagnostic table.
    const diagnosticFields =
      error?.data && typeof error.data === "object" ? error.data : {};
    res
      .status(500)
      .json({ ...diagnosticFields, error: sanitizeError(error.message) });
  }
});

// Set god mode for player
// Dead route (as is players.js's own /godmode), live path is the
// bridge.command passthrough -- see the 2026-08-27/2026-08-30 comment
// above BRIDGE_ACTION_CAPABILITY.
router.post("/players/:username/godmode", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { username } = req.params;
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
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
// Dead route (as is players.js's own /invisible), live path is the
// bridge.command passthrough -- see the 2026-08-27/2026-08-30 comment
// above BRIDGE_ACTION_CAPABILITY.
router.post("/players/:username/invisible", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { username } = req.params;
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
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
router.get("/zombies/count", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  try {
    const result = await bridge.sendCommand("getZombieCount", {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Clear zombies near a player
router.post("/zombies/clear-near-player", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { username, radius = 50 } = req.body || {};
  if (!username || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Valid username is required",
      code: ErrorCode.BRIDGE_VALID_USERNAME_REQUIRED,
    });
  }
  if (typeof radius !== "number" || radius < 1 || radius > 500) {
    return res.status(400).json({
      error: "radius must be 1-500",
      code: ErrorCode.PANELBRIDGE_CLEAR_ZOMBIES_RADIUS_INVALID,
    });
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
router.post("/zombies/clear-all", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
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
router.post("/zombies/spawn-near", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { username, count = 50 } = req.body || {};
  if (!username || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Valid username is required",
      code: ErrorCode.BRIDGE_VALID_USERNAME_REQUIRED,
    });
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
router.post("/zombies/spawn-behind", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { username, count = 50 } = req.body || {};
  if (!username || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Valid username is required",
      code: ErrorCode.BRIDGE_VALID_USERNAME_REQUIRED,
    });
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
router.post("/visual/view-distance", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { value } = req.body || {};
  if (typeof value !== "number") {
    return res
      .status(400)
      .json({
        error: "value is required (number 0.0-1.0)",
        code: ErrorCode.PANELBRIDGE_VALUE_REQUIRED_NUMBER_0_1,
      });
  }
  try {
    const result = await bridge.sendCommand("setViewDistance", { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set daylight level
router.post("/visual/daylight", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { value } = req.body || {};
  if (typeof value !== "number") {
    return res.status(400).json({
      error: "value is required (0.0-1.0)",
      code: ErrorCode.BRIDGE_VALUE_REQUIRED_0_1,
    });
  }
  try {
    const result = await bridge.sendCommand("setDayLight", { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set night strength
router.post("/visual/night-strength", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { value } = req.body || {};
  if (typeof value !== "number") {
    return res.status(400).json({
      error: "value is required (0.0-1.0)",
      code: ErrorCode.BRIDGE_VALUE_REQUIRED_0_1,
    });
  }
  try {
    const result = await bridge.sendCommand("setNightStrength", { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set desaturation (color wash)
router.post("/visual/desaturation", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { value } = req.body || {};
  if (typeof value !== "number") {
    return res.status(400).json({
      error: "value is required (0.0-1.0)",
      code: ErrorCode.BRIDGE_VALUE_REQUIRED_0_1,
    });
  }
  try {
    const result = await bridge.sendCommand("setDesaturation", { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set ambient light
router.post("/visual/ambient", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { value } = req.body || {};
  if (typeof value !== "number") {
    return res.status(400).json({
      error: "value is required (0.0-1.0)",
      code: ErrorCode.BRIDGE_VALUE_REQUIRED_0_1,
    });
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
router.get("/chat/info", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
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
router.post("/chat/admin", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== "string" || message.length > 2000) {
    return res
      .status(400)
      .json({
        error: "message is required (max 2000 chars)",
        code: ErrorCode.BRIDGE_MESSAGE_REQUIRED,
      });
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
      .json({
        error: "Neither PanelBridge nor RCON available for admin chat",
        code: ErrorCode.PANELBRIDGE_ADMIN_CHAT_UNAVAILABLE,
      });
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
    res.status(500).json({
      error: "Failed to send admin message",
      code: ErrorCode.PANELBRIDGE_SEND_ADMIN_MESSAGE_FAILED,
    });
  }
});

// Send to general chat with author
router.post("/chat/general", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  const author =
    typeof req.body.author === "string"
      ? req.body.author.trim().slice(0, 64) || "Server"
      : "Server";
  const { message } = req.body || {};
  if (!message || typeof message !== "string" || message.length > 2000) {
    return res
      .status(400)
      .json({
        error: "message is required (max 2000 chars)",
        code: ErrorCode.BRIDGE_MESSAGE_REQUIRED,
      });
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
      .json({
        error: "Neither PanelBridge nor RCON available for chat",
        code: ErrorCode.PANELBRIDGE_CHAT_UNAVAILABLE,
      });
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
router.post("/chat/alert", requirePermission("server.world_events"), async (req, res) => {
  const { message, alert = true } = req.body || {};
  if (!message || typeof message !== "string" || message.length > 2000) {
    return res
      .status(400)
      .json({
        error: "message is required (max 2000 chars)",
        code: ErrorCode.BRIDGE_MESSAGE_REQUIRED,
      });
  }
  try {
    // Only PanelBridge can deliver a genuine alert -- the Lua handler calls
    // chat.server:sendServerAlertMessageToServerChat, a distinct native API
    // from the plain sendMessageToServerChat it uses otherwise. RCON's
    // servermsg has no alert/banner concept at all. Trying RCON first (as
    // this route used to, unconditionally) meant a requested alert silently
    // downgraded to a plain broadcast whenever RCON was connected -- the
    // common case -- while the response still echoed isAlert:true as if the
    // alert had actually been delivered. Try bridge first when an alert is
    // actually requested; RCON remains the fallback, same as before.
    if (alert && bridge.isRunning) {
      const result = await bridge.sendCommand("sendToServerChat", {
        message,
        alert: true,
      });
      // 2026-08-30, panelbridge-total-audit-2026-08-30 (Finding B): chat/admin
      // and chat/general both check data.method !== "player:Say" here to
      // detect the alert API silently degrading to plain overhead-text
      // delivery, and fall back to RCON when it does. This route lacked that
      // check -- a degraded alert used to return as a bare success, with no
      // alert/banner styling at all, while the caller saw the same response
      // shape as a real delivered alert.
      if (result?.success && result?.data?.method !== "player:Say") return res.json(result);
    }

    const rconResult = await trySendViaRcon(req, message);
    if (rconResult) {
      return res.json({
        success: true,
        data: {
          // Honest either way: RCON has never been able to deliver alert
          // styling, so isAlert reflects what actually happened, not what
          // was requested.
          message: alert
            ? "Alert requested but RCON has no alert styling -- sent as a plain broadcast"
            : "Alert sent via RCON",
          isAlert: false,
          method: "RCON",
        },
      });
    }
    // Fallback: PanelBridge (covers alert===false reaching here, or the
    // alert-preferred bridge attempt above having failed)
    if (bridge.isRunning) {
      const result = await bridge.sendCommand("sendToServerChat", {
        message,
        alert,
      });
      return res.json(result);
    }
    return res
      .status(400)
      .json({
        error: "Neither RCON nor PanelBridge available",
        code: ErrorCode.PANELBRIDGE_RCON_AND_BRIDGE_UNAVAILABLE,
      });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ============================================
// DEBUG ENDPOINTS
// ============================================

// Get mod debug log
router.get("/debug/log", requirePermission("bridge.diagnostics"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const limit = parseClampedInteger(req.query.limit, 50, 1, 500);
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
router.get("/debug/stats", requirePermission("bridge.diagnostics"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  try {
    const result = await bridge.sendCommand("getStats", {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set debug mode
router.post("/debug/mode", requirePermission("bridge.diagnostics"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
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
router.get("/debug/api", requirePermission("bridge.diagnostics"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { object, method } = req.query;
  // Validate as identifier-like strings
  if (
    object &&
    (typeof object !== "string" || !/^[a-zA-Z0-9_.]{1,100}$/.test(object))
  ) {
    return res.status(400).json({
      error: "Invalid object name",
      code: ErrorCode.PANELBRIDGE_INVALID_OBJECT_NAME,
    });
  }
  if (
    method &&
    (typeof method !== "string" || !/^[a-zA-Z0-9_.]{1,100}$/.test(method))
  ) {
    return res.status(400).json({
      error: "Invalid method name",
      code: ErrorCode.PANELBRIDGE_INVALID_METHOD_NAME,
    });
  }
  try {
    const result = await bridge.sendCommand("checkAPI", { object, method });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get available handlers
router.get("/debug/handlers", requirePermission("bridge.diagnostics"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  try {
    const result = await bridge.sendCommand("getAvailableHandlers", {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Clear mod errors
router.post("/debug/clear-errors", requirePermission("bridge.diagnostics"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
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
router.get("/catalog/items", requirePermission("players.gm_tools"), async (req, res) => {
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
router.get("/catalog/vehicles", requirePermission("players.gm_tools"), async (req, res) => {
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
router.post("/catalog/scan-items", requirePermission("bridge.diagnostics"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running — server must be online to scan items",
      code: ErrorCode.PANELBRIDGE_SCAN_ITEMS_NOT_RUNNING,
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
router.post("/catalog/scan-vehicles", requirePermission("bridge.diagnostics"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running — server must be online to scan vehicles",
      code: ErrorCode.PANELBRIDGE_SCAN_VEHICLES_NOT_RUNNING,
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
router.post("/catalog/debug-item-script", requirePermission("bridge.diagnostics"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  try {
    const result = await bridge.sendCommand("debugItemScript", {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
