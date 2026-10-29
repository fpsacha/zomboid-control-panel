import express from "express";
import path from "path";
import fs from "fs";
import { promises as fsp } from "fs";
import crypto from "crypto";
import { createLogger } from "../utils/logger.js";
const log = createLogger("API:Mods");
import {
  getTrackedMods,
  addTrackedMod,
  removeTrackedMod,
  clearModUpdates,
  getSetting,
  getActiveServer,
  getModPresets,
  createModPreset,
  updateModPreset,
  deleteModPreset,
  getModGroups,
  createModGroup,
  updateModGroup,
  deleteModGroup,
  getDismissedModGroupSuggestions,
  dismissModGroupSuggestion,
  getModNotes,
  setModNote,
  deleteModNote,
  setSetting,
  addIgnoredMod,
  getIgnoredMods,
  removeIgnoredMod,
  removeIgnoredMods,
  clearAllIgnoredMods,
  isModIgnored,
  getIgnoredModPairs,
  addIgnoredModPair,
  removeIgnoredModPair,
} from "../database/init.js";
import { getDataPaths } from "../utils/paths.js";
import { getSteamApiKey } from "../services/steamApiKey.js";
import {
  sanitizeError,
  sanitizeErrorParams,
  sanitizeIniValue,
  sanitizeIniList,
  sanitizeModIdList,
  looksLikeWorkshopId,
} from "../utils/sanitize.js";
import {
  getCollectionContents,
  addItemToCollection,
  removeItemFromCollection,
  computeDiff as computeCollectionDiff,
  syncSingleChange as autoSyncCollection,
  fetchPublishedFileTitles,
  getSteamSessionCredentials,
  setSteamSessionCredentials,
} from "../services/workshopCollectionSync.js";
import {
  listAvailableBrowsers,
  extractSteamCookies,
} from "../utils/browserCookies.js";
import { requirePermission } from "../services/permissions.js";
import { hostPathViewFor } from "../utils/hostPathView.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { activeServerConfigDir, serverConfigDirRefusal } from "../utils/serverConfigPath.js";
import { describeRefusal, logRefusalOnce } from "../services/zomboidDataPath.js";
import { withFileLock } from "../utils/fileWriteQueue.js";
import { writeIniWithBackup as writeIniWithBackupRaw, backupWarningFor } from "../utils/configBackup.js";
import { getBridgeManaged, protectBridgeIniEntries } from "../services/bridgeDelivery.js";
import { findDuplicateIniKeys } from "../utils/iniDuplicateKeys.js";
import { parseBoundedInteger } from "../utils/queryNumbers.js";
import {
  readTextFile,
  splitIniList,
  splitModIdList,
  splitModIdTokens,
} from "../utils/modIni.js";
import {
  MOD_GROUP_COLORS,
  MOD_GROUP_LIMITS,
  applyModGroups,
  groupsInOrder,
  normalizeGroup,
  validateGroupFields,
  validateGroupDocument,
} from "../utils/modGroups.js";
import { computeGroupSuggestions, isSuggestionKey } from "../utils/modGroupSuggestions.js";
import { cleanRuleModId } from "../utils/modOrderRules.js";
import { MOD_NOTE_LIMITS, cleanModNoteText, isNoteWorkshopId } from "../utils/modNotes.js";
import {
  getWorkshopPaths,
  getModDetailsFromWorkshop,
  findMapFoldersFromWorkshop,
  findAllModIdsFromWorkshop,
  findModIdFromWorkshop,
  findModForFolder,
  isModIdVerifiedOnDisk,
  sanitizeModIdListWithDiskBypass,
  shippedByListedItems,
} from "../services/workshopModInfo.js";
import { addMapFoldersToIni, addWorkshopItemToIni } from "../services/modIniEdit.js";
import {
  extractClothingOutfits,
  extractLuaGlobals,
  extractLuaSymbols,
  extractScriptDefinitionBodies,
  extractTranslationEntries,
} from "../utils/modDefinitionExtractors.js";
import {
  analyzeModOrder,
  computeOrderingConstraints,
  createDependencyRelation,
  findIncompatiblePairs,
} from "../utils/modLoadOrder.js";
import {
  cachedFileHash,
  cachedParse,
  compareLayeredDefinitions,
  compareScriptFileCopies,
  compareTranslationEntries,
  expireConflictFileCacheAfter,
  gameMediaDirs,
  isNonGameplayMediaFile,
  statFile,
  translationPathInfo,
} from "../utils/modConflictRules.js";
import { downloadWorkshopItem } from "../services/workshopDownload.js";
import { addConflictSuggestions, refreshConflictSuggestions } from "../services/modSmartScan.js";
import { hardOrderEdges } from "../services/modSmartContext.js";
import { loadCurrentExtensionFiles, zipExtensionFiles } from "../utils/embeddedExtension.js";

// The workshop readers live in services/workshopModInfo.js; the route file
// keeps exporting getModDetailsFromWorkshop for its existing importers.
export { getModDetailsFromWorkshop };

const router = express.Router();

// Every route in this file is admin+technician: "mods" and "config" are
// explicitly the technician's job per the role brief, and moderator's job
// is player/in-game authority, not workshop or INI management. Applied
// once at the router level (this file has ~70 endpoints) rather than
// per-route, so a route added here later is admin+technician by default
// instead of silently inheriting the central-login-gate-only exposure this
// whole file had before (any logged-in role — including moderator — could
// previously edit sandbox vars, mod lists, or workshop collections).
//
// EXCEPT /thumbnail/:workshopId, carved out below: authService.middleware()
// (services/auth.js) deliberately never sets req.user for
// "/api/mods/thumbnail/" — it's loaded via <img> tags, which cannot carry
// an Authorization header, the same reason /api/map/*tiles/ are exempted
// there too. Gating this router at the request level with no carve-out
// re-imposes the very check middleware() intentionally skipped, so
// req.user is always absent and requirePermission() 401s every thumbnail
// request, for every user, always — this is exactly the bug that shipped
// in 9c6ce2e / v1.2.0 (conv-mods-thumbnails). The exemption has to be
// explicit and live here rather than via route registration order: order
// is invisible, and the next reorder of this file breaks it again silently.
const requireModsManage = requirePermission("mods.manage");
router.use((req, res, next) => {
  if (req.path.toLowerCase().startsWith("/thumbnail/")) return next();
  return requireModsManage(req, res, next);
});

// A capability on top of mods.manage, checked inside a handler (the same
// helper as routes/scheduler.js): requirePermission() answers the 401/403
// itself, and this says whether the handler may go on.
async function requireCapabilityInline(capability, req, res) {
  let passed = false;
  await requirePermission(capability)(req, res, () => {
    passed = true;
  });
  return passed;
}

// ─── INI write mutex ────────────────────────────────────────────────────────
// Serialises write operations to the same INI file so concurrent requests
// cannot interleave their writes (prevents lost-update race conditions).
//
// Delegates the actual serialization to the shared per-path lock in
// utils/fileWriteQueue.js — the same one routes/serverFiles.js's PUT /ini and
// PUT /raw/:type use for the identical file. Before this, mods.js kept its
// own separate Map here: two independent mutexes guarding one physical INI
// file, neither aware of the other. A ServerConfig save (PUT /ini) and a
// Mods-page toggle (POST /toggle-mod-id, /write-to-ini, ...) landing at the
// same moment could each acquire "their" lock, both read the same starting
// content, and the second write would silently clobber the first's change —
// exactly the lost-update race both call sites' comments claimed to prevent,
// but only within their own file.
//
// activeIniLocks below is bookkeeping only (backs getIniLockCount, which an
// existing test asserts drains to 0) — it never gates a write itself.
const activeIniLocks = new Map(); // iniPath -> in-flight call count
export function withIniLock(iniPath, fn) {
  activeIniLocks.set(iniPath, (activeIniLocks.get(iniPath) || 0) + 1);
  const cleanup = () => {
    const remaining = (activeIniLocks.get(iniPath) || 1) - 1;
    if (remaining <= 0) activeIniLocks.delete(iniPath);
    else activeIniLocks.set(iniPath, remaining);
  };
  const run = withFileLock(iniPath, fn);
  run.then(cleanup, cleanup);
  return run;
}

export function getIniLockCount() {
  return activeIniLocks.size;
}

export function filterOwnedClientModIds(clientModIds, ownedModIds) {
  const ownedSet = new Set((ownedModIds || []).map(String));
  if (!ownedSet.size || !Array.isArray(clientModIds)) return [];

  const filtered = [];
  const seen = new Set();
  for (const rawId of clientModIds) {
    if (typeof rawId !== "string") continue;
    const modId = sanitizeIniValue(rawId).trim();
    if (!modId || modId.length >= 200) continue;
    if (looksLikeWorkshopId(modId)) continue;
    if (!ownedSet.has(modId) || seen.has(modId)) continue;
    seen.add(modId);
    filtered.push(modId);
  }
  return filtered;
}

// Every ini write in this file goes through here. When the active server
// gets PanelBridge from the Steam Workshop, its Mods=/WorkshopItems= entries
// are managed in Settings › PanelBridge: a remove, toggle, collection import
// or load-order save that would drop one gets it put back at its old
// position (bridgeDelivery.protectBridgeIniEntries). Nothing is ever added
// that wasn't there before, and reorders are kept. Wrapping the one writer
// instead of editing its ~18 call sites keeps a future route from missing it.
export async function writeIniWithBackup(iniPath, content) {
  let before = "";
  try {
    before = readTextFile(iniPath);
  } catch {
    /* first write */
  }
  return writeIniWithBackupRaw(iniPath, await protectBridgeIniEntries(iniPath, before, content));
}

// Security: INI sanitization imported from shared util
// sanitizeIniValue strips \r\n;= to prevent injection
// sanitizeIniList joins sanitized values with semicolons

export function getSanitizedIniPath(serverConfigPath, serverName) {
  if (!serverConfigPath || typeof serverName !== "string") {
    return null;
  }

  const sanitizedServerName = path.basename(serverName);
  if (
    !sanitizedServerName ||
    sanitizedServerName !== serverName ||
    serverName.includes("..")
  ) {
    return null;
  }

  return path.join(serverConfigPath, `${sanitizedServerName}.ini`);
}

// Helper for multi-server support.
//
// split-derivation sweep, 2026-09-07 (same class as /wipe's pre-fix bug,
// 5c2e73e9): this file used to have getServerConfigPath()/getServerName()/
// getServerPath() as three separate functions, each making its OWN
// independent getActiveServer() call. Most handlers in this file need two
// or three of these values together, so a concurrent request switching the
// active server between two or three separate awaited calls could produce
// e.g. serverConfigPath from server A + serverName from server B, matching
// neither server's real INI. This reads the active server ONCE and derives
// all three values from that single snapshot. getServerPath() below is
// kept as a thin wrapper purely for the handlers elsewhere in this file
// that only ever need the install path alone, where there is nothing to
// diverge against.
// Exported so server/tests/modsGetActiveServerPathsSingleRead.test.js can
// assert the single-read behaviour directly.
export async function getActiveServerPaths() {
  const activeServer = await getActiveServer();

  // The explicitly configured serverConfigPath, else zomboidDataPath +
  // Server, else the legacy settings of both (like serverFiles.js does).
  // SECURITY (2026-10-05, PATHS-2): the routes here rewrite <name>.ini in
  // that folder, so a configured one is used only while it is inside the
  // data folder in effect (the record's, else the legacy setting) --
  // utils/serverConfigPath.js. Refused, it comes back null, which every
  // route below already answers as "not configured". That data folder is
  // itself held to the data-folder rule there too (PATHS-1 verifier pass
  // 2): a remote server's, never judged when saved, named any folder here.
  const legacy = activeServer?.zomboidDataPath
    ? {}
    : {
        serverConfigPath: await getSetting("serverConfigPath"),
        zomboidDataPath: await getSetting("zomboidDataPath"),
      };
  const config = activeServerConfigDir(activeServer, legacy);
  // SECURITY (2026-10-05, PT3/PT5): refused, the routes below answer the
  // refusal itself (configRefusal, through withConfigRefusal()), not "not
  // set", and every route lands here, so the log line is written at warn
  // once per data folder and reason, then at debug.
  const configRefusal = config.refused ? serverConfigDirRefusal(config) : null;
  if (configRefusal) {
    logRefusalOnce(
      log,
      `Not using the server config folder for mods (Zomboid data folder: ${config.dataPath || "not set"}): ${describeRefusal(configRefusal)}`,
    );
  }
  const serverConfigPath = config.dir;

  let serverName = activeServer?.serverName || null;
  if (!serverName) {
    const legacyName = await getSetting("serverName");
    // No active server and no legacy settings name either -- there is no
    // real server this could refer to. "servertest" used to fill in here,
    // which happens to be Project Zomboid's own vanilla single-player/
    // test-server name: on a machine that has a real (unrelated,
    // never-added-to-the-panel) PZ install at the default path, an
    // unconfigured panel would silently read/write ITS Server/servertest.ini
    // and report success. Every call site below already gates on
    // `!serverConfigPath`; null here (instead of a fabricated name) makes
    // those same gates also catch "no server name configured" rather than
    // papering over it.
    serverName = legacyName || null;
  }

  let serverPath = activeServer?.installPath || null;
  if (!serverPath) {
    const legacyPath = await getSetting("serverPath");
    serverPath = legacyPath || null;
  }

  // The data folder the game runs with (-cachedir): its mods/ and Workshop/
  // folders hold mods the server loads too. Only when it passed the
  // data-folder rule above.
  const zomboidDataPath = config.refused ? null : config.dataPath || null;

  return { serverConfigPath, serverName, serverPath, configRefusal, zomboidDataPath };
}

// SECURITY (2026-10-05, PT3): the body a route answers when it has no
// config folder to use. When the folder was refused -- a data folder that
// no longer meets the data-folder rule after the update, or a config folder
// with no data folder -- that refusal goes out (its code, and what to set),
// not `fallback`'s "Server config path not set. Please configure the server
// first.", which sent the operator to configure a server that was
// configured.
function withConfigRefusal(configRefusal, fallback) {
  return configRefusal ? { ...fallback, error: configRefusal.error, code: configRefusal.code } : fallback;
}

async function getServerPath() {
  return (await getActiveServerPaths()).serverPath;
}

// Helper to get modChecker with null check
function getModChecker(req, res) {
  const modChecker = req.app.get("modChecker");
  if (!modChecker) {
    res.status(500).json({
      error: "Mod checker not initialized",
      code: ErrorCode.MOD_CHECKER_NOT_INITIALIZED,
    });
    return null;
  }
  return modChecker;
}

function shouldRefreshTrackedModName(name) {
  return (
    !name || /^Workshop Mod /i.test(name) || /\[\s*Legacy\s*\]/i.test(name)
  );
}

// SECURITY (2026-10-05, H4 round 3): mods.manage doesn't set the server's
// folders up, and the Workshop ACF sits in the install folder (or in the
// SteamCMD folder below the panel account's profile). A role without the
// host-path capabilities (utils/hostPathView.js) gets the placeholder,
// which still reads as "found" to a page that checks it is set; the same
// goes for the ini path the routes below answer with (its file name).
// Get mod checker status
router.get("/status", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    const status = await modChecker.getStatus();
    const view = await hostPathViewFor(req.user);
    res.json({ ...status, workshopAcfPath: view.folder(status.workshopAcfPath) });
  } catch (error) {
    log.error(`Failed to get mod checker status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get all tracked mods
router.get("/tracked", async (req, res) => {
  try {
    // ─── Auto-track from INI ────────────────────────────────────────────────
    // Tracking is no longer a user-managed concept: any workshop ID present
    // in the server's INI is automatically tracked so it gets polled for
    // Workshop updates (which trigger the auto-restart). This keeps the
    // mental model simple — "what's on the server is what gets tracked".
    // We skip mods the user has explicitly removed (ignore list) so this
    // doesn't fight the "Remove from server" action.
    try {
      const { serverConfigPath, serverName } = await getActiveServerPaths();
      if (serverConfigPath && serverName) {
        const sanitizedServerName = path.basename(serverName);
        if (sanitizedServerName === serverName && !serverName.includes("..")) {
          const iniPath = path.join(
            serverConfigPath,
            `${sanitizedServerName}.ini`,
          );
          if (fs.existsSync(iniPath)) {
            const content = readTextFile(iniPath);
            // Widened to tolerate whitespace around "=" -- same fix as this
            // file's other ini-read sites (hunt-wave13, 3d1921ad/783672aa),
            // missed here. A hand-edited "WorkshopItems = ..." line
            // previously parsed as zero configured items, not "the check
            // couldn't run" -- so every tracked mod would show as missing
            // from the server, the exact "unreadable INI reported as every
            // mod missing" case this route's own serverConfigRead flag
            // (just above) exists to prevent.
            const workshopMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
            const workshopIds =
              splitIniList(workshopMatch?.[1]);
            const configuredIds = new Set(
              workshopIds.filter((id) => /^\d{1,15}$/.test(id)),
            );
            const trackedNow = await getTrackedMods();

            // Tracked mods absent from WorkshopItems= are deliberately kept:
            // they are what the Mods > Deactivated tab lists so they can be
            // re-enabled or deleted on purpose. Pruning them here silently
            // emptied that tab on the next page load. "Remove from server"
            // already untracks and ignore-lists in one step.
            if (configuredIds.size > 0) {
              const trackedSet = new Set(
                trackedNow.map((m) => m.workshop_id),
              );
              const modChecker = req.app.get("modChecker");
              let added = 0;
              for (const wsId of configuredIds) {
                if (trackedSet.has(wsId)) continue;
                if (await isModIgnored(wsId)) continue;
                const nameFromDisk = modChecker?.resolveModNameFromDisk(wsId);
                await addTrackedMod(
                  wsId,
                  nameFromDisk || `Workshop Mod ${wsId}`,
                );
                added++;
              }
              if (added > 0) log.info(`Auto-tracked ${added} mods from INI`);
            }
          }
        }
      }
    } catch (e) {
      log.debug(`Auto-track from INI skipped: ${e.message}`);
    }

    const mods = await getTrackedMods();

    // Enrich generic or stale display names with real names from disk, then
    // Steam for mods that are not downloaded locally. A tracked mod should
    // never stay a generic workshop-ID label just because it is deactivated.
    const modChecker = req.app.get("modChecker");
    if (modChecker) {
      let updated = 0;
      const unresolvedIds = [];
      for (const mod of mods) {
        if (shouldRefreshTrackedModName(mod.name)) {
          const realName = modChecker.resolveModNameFromDisk(
            mod.workshop_id,
            true,
          );
          if (realName && realName !== mod.name) {
            mod.name = realName;
            // Persist the resolved name in the database
            await addTrackedMod(mod.workshop_id, realName);
            updated++;
          } else {
            unresolvedIds.push(mod.workshop_id);
          }
        }
      }
      if (unresolvedIds.length > 0) {
        const titles = await fetchPublishedFileTitles(unresolvedIds);
        for (const mod of mods) {
          const realName = titles.get(mod.workshop_id);
          if (realName && shouldRefreshTrackedModName(mod.name)) {
            mod.name = realName;
            await addTrackedMod(mod.workshop_id, realName);
            updated++;
          }
        }
      }
      if (updated > 0) {
        log.debug(`Resolved ${updated} tracked mod names`);
      }
    }

    res.json({ mods });
  } catch (error) {
    log.error(`Failed to get tracked mods: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Refresh display names for tracked mods that still show a generic
// "Workshop Mod <id>" placeholder. Tries the on-disk mod.info first, then
// falls back to Steam's GetPublishedFileDetails (batched) for mods whose
// workshop folder isn't on this machine yet.
router.post("/refresh-names", async (req, res) => {
  try {
    const modChecker = req.app.get("modChecker");
    const { workshopIds } = req.body || {};
    const targetSet =
      Array.isArray(workshopIds) && workshopIds.length > 0
        ? new Set(workshopIds.map(String).filter((id) => /^\d{1,15}$/.test(id)))
        : null;

    const mods = await getTrackedMods();
    const candidates = mods.filter((m) => {
      if (targetSet && !targetSet.has(m.workshop_id)) return false;
      return shouldRefreshTrackedModName(m.name);
    });

    let diskResolved = 0;
    let steamResolved = 0;
    const stillUnresolved = [];

    // Pass 1: try disk
    for (const mod of candidates) {
      const nameFromDisk = modChecker?.resolveModNameFromDisk(
        mod.workshop_id,
        true,
      );
      if (nameFromDisk) {
        await addTrackedMod(mod.workshop_id, nameFromDisk);
        diskResolved++;
      } else {
        stillUnresolved.push(mod.workshop_id);
      }
    }

    // Pass 2: batched Steam API for whatever's left
    if (stillUnresolved.length > 0) {
      const BATCH = 100;
      for (let i = 0; i < stillUnresolved.length; i += BATCH) {
        const slice = stillUnresolved.slice(i, i + BATCH);
        const params = new URLSearchParams();
        params.append("itemcount", String(slice.length));
        slice.forEach((id, idx) =>
          params.append(`publishedfileids[${idx}]`, id),
        );
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10000);
          const r = await fetch(
            "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
            { method: "POST", body: params, signal: controller.signal },
          );
          clearTimeout(timer);
          if (!r.ok) continue;
          const data = await r.json();
          const items = data?.response?.publishedfiledetails || [];
          for (const item of items) {
            if (
              item?.result === 1 &&
              typeof item.title === "string" &&
              item.title.trim()
            ) {
              await addTrackedMod(
                String(item.publishedfileid),
                item.title.trim(),
              );
              steamResolved++;
            }
          }
        } catch (e) {
          log.debug(`Steam name refresh batch failed: ${e.message}`);
        }
      }
    }

    res.json({
      success: true,
      checked: candidates.length,
      diskResolved,
      steamResolved,
      totalResolved: diskResolved + steamResolved,
      unresolved: candidates.length - diskResolved - steamResolved,
    });
  } catch (error) {
    log.error(`Failed to refresh mod names: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Add a mod to track
router.post("/track", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    const { workshopId } = req.body;
    log.info(`POST /track: workshopId=${workshopId}`);

    if (!workshopId) {
      return res.status(400).json({
        error: "Workshop ID is required",
        code: ErrorCode.MODS_WORKSHOP_ID_REQUIRED,
      });
    }

    const workshopIdStr = String(workshopId);
    if (!/^\d{1,15}$/.test(workshopIdStr)) {
      return res.status(400).json({
        error: "Invalid Workshop ID format",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_FORMAT,
      });
    }

    // Clear from ignore list if present (user explicitly wants to track this)
    await removeIgnoredMod(workshopIdStr);

    const result = await modChecker.addModToTrack(workshopIdStr);
    // Best-effort Workshop collection mirror — fire-and-forget so the user's
    // tracking action never blocks on Steam being slow or cookies being stale.
    autoSyncCollection("add", workshopIdStr).catch(() => {});
    res.json(result);
  } catch (error) {
    log.error(`Failed to add mod to track: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Remove a mod from tracking
router.delete("/track/:workshopId", async (req, res) => {
  try {
    const { workshopId } = req.params;

    // Validate workshopId is a numeric string
    if (!workshopId || !/^\d{1,15}$/.test(workshopId)) {
      return res.status(400).json({
        error: "Invalid workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_LOWER,
      });
    }

    // Get mod name before removing (for the ignore list)
    const trackedMods = await getTrackedMods();
    const mod = trackedMods.find((m) => m.workshop_id === workshopId);

    await removeTrackedMod(workshopId);
    // Add to ignored list so auto-sync won't re-add it
    await addIgnoredMod(workshopId, mod?.name || null);
    // Mirror removal into the Workshop collection if auto-sync is on.
    autoSyncCollection("remove", workshopId).catch(() => {});
    res.json({
      success: true,
      message: "Mod removed from tracking and added to ignore list",
    });
  } catch (error) {
    log.error(`Failed to remove tracked mod: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ============================================
// Ignored Mods Management
// ============================================

// Get all ignored mods for the active server
router.get("/ignored", async (req, res) => {
  try {
    const ignored = await getIgnoredMods();
    res.json(ignored);
  } catch (error) {
    log.error(`Failed to get ignored mods: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Un-ignore a mod (allow it to be tracked again)
router.delete("/ignored/:workshopId", async (req, res) => {
  try {
    const { workshopId } = req.params;
    if (!workshopId || !/^\d{1,15}$/.test(workshopId)) {
      return res.status(400).json({
        error: "Invalid workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_LOWER,
      });
    }
    const removed = await removeIgnoredMod(workshopId);
    if (!removed) {
      return res.status(404).json({
        error: "Mod not found in ignore list",
        code: ErrorCode.MODS_IGNORE_ENTRY_NOT_FOUND,
      });
    }
    res.json({ success: true, message: "Mod removed from ignore list" });
  } catch (error) {
    log.error(`Failed to un-ignore mod: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Un-ignore several mods at once (multi-select in the ignored list). Ids that
// are not on the list are skipped, so the count says what actually changed.
router.post("/ignored/remove", async (req, res) => {
  try {
    const { workshopIds } = req.body || {};
    if (!Array.isArray(workshopIds) || workshopIds.length === 0) {
      return res.status(400).json({
        error: "workshopIds must be a non-empty array",
        code: ErrorCode.MODS_WORKSHOP_IDS_ARRAY_REQUIRED,
      });
    }
    const cleaned = workshopIds
      .map(String)
      .filter((id) => /^\d{1,15}$/.test(id));
    if (cleaned.length === 0) {
      return res.status(400).json({
        error: "No valid workshop IDs provided",
        code: ErrorCode.MODS_NO_VALID_WORKSHOP_IDS,
      });
    }
    const removed = await removeIgnoredMods(cleaned);
    res.json({
      success: true,
      message: `Removed ${removed} mod${removed !== 1 ? "s" : ""} from the ignore list`,
      removed,
    });
  } catch (error) {
    log.error(`Failed to un-ignore mods: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Clear all ignored mods for the active server
router.delete("/ignored", async (req, res) => {
  try {
    const removed = await clearAllIgnoredMods();
    res.json({
      success: true,
      message: `Cleared ${removed} ignored mod${removed !== 1 ? "s" : ""}`,
      removed,
    });
  } catch (error) {
    log.error(`Failed to clear ignored mods: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ============================================
// Ignored mod-conflict pairs (false positives on the variant detector)
// ============================================

const MOD_ID_RE = /^[A-Za-z0-9_.\-+ ()]{1,128}$/;

router.get("/ignored-pairs", async (req, res) => {
  try {
    const pairs = await getIgnoredModPairs();
    res.json(pairs);
  } catch (error) {
    log.error(`Failed to get ignored mod pairs: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/ignored-pairs", async (req, res) => {
  try {
    const { modIdA, modIdB, reason } = req.body || {};
    if (
      typeof modIdA !== "string" ||
      typeof modIdB !== "string" ||
      !MOD_ID_RE.test(modIdA) ||
      !MOD_ID_RE.test(modIdB)
    ) {
      return res.status(400).json({
        error: "modIdA and modIdB are required and must be valid mod IDs",
        code: ErrorCode.MODS_IGNORED_PAIR_INVALID_IDS,
      });
    }
    if (modIdA === modIdB) {
      return res.status(400).json({
        error: "modIdA and modIdB must differ",
        code: ErrorCode.MODS_IGNORED_PAIR_SAME_ID,
      });
    }
    const safeReason = typeof reason === "string" ? reason.slice(0, 200) : null;
    const entry = await addIgnoredModPair(modIdA, modIdB, safeReason);
    if (!entry)
      return res.status(400).json({
        error: "Invalid pair",
        code: ErrorCode.MODS_IGNORED_PAIR_INVALID,
      });
    res.json({ success: true, pair: entry });
  } catch (error) {
    log.error(`Failed to add ignored mod pair: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete("/ignored-pairs", async (req, res) => {
  try {
    const { modIdA, modIdB } = req.body || {};
    if (
      typeof modIdA !== "string" ||
      typeof modIdB !== "string" ||
      !MOD_ID_RE.test(modIdA) ||
      !MOD_ID_RE.test(modIdB)
    ) {
      return res.status(400).json({
        error: "modIdA and modIdB are required",
        code: ErrorCode.MODS_IGNORED_PAIR_IDS_REQUIRED,
      });
    }
    const removed = await removeIgnoredModPair(modIdA, modIdB);
    if (!removed)
      return res.status(404).json({
        error: "Pair not found in ignore list",
        code: ErrorCode.MODS_IGNORED_PAIR_NOT_FOUND,
      });
    res.json({ success: true });
  } catch (error) {
    log.error(`Failed to remove ignored mod pair: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Manually check for mod updates
router.post("/check-updates", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    const result = await modChecker.checkForUpdates();
    res.json(result);
  } catch (error) {
    log.error(`Failed to check for updates: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get mod list from server config
router.get("/server-mods", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    const mods = await serverManager.getModList();
    res.json({ mods });
  } catch (error) {
    log.error(`Failed to get server mods: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Check mods via RCON
router.get("/check-rcon", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.checkModsNeedUpdate();
    res.json(result);
  } catch (error) {
    log.error(`Failed to check mods via RCON: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Start mod checker
router.post("/start", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    const started = modChecker.start();
    if (!started) {
      return res.status(400).json({
        success: false,
        error:
          "Mod checker could not start. Configure a valid Workshop ACF path first.",
        code: ErrorCode.MODS_START_ACF_PATH_NOT_SET,
      });
    }
    res.json({ success: true, message: "Mod checker started" });
  } catch (error) {
    log.error(`Failed to start mod checker: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Stop mod checker
router.post("/stop", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    modChecker.stop();
    res.json({ success: true, message: "Mod checker stopped" });
  } catch (error) {
    log.error(`Failed to stop mod checker: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set check interval
router.put("/interval", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    const { intervalMs } = req.body || {};

    if (
      !Number.isInteger(intervalMs) ||
      intervalMs < 60000 ||
      intervalMs > 120 * 60 * 1000 ||
      intervalMs % 60000 !== 0
    ) {
      return res.status(400).json({
        error:
          "Interval must be a whole number of minutes from 60000ms to 7200000ms",
        code: ErrorCode.MODS_CHECK_INTERVAL_INVALID,
      });
    }

    await modChecker.setCheckInterval(intervalMs);
    res.json({
      success: true,
      message: `Check interval set to ${intervalMs}ms`,
    });
  } catch (error) {
    log.error(`Failed to set check interval: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Enable auto-restart on mod update
router.post("/auto-restart", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({
        error: "`enabled` must be a boolean",
        code: ErrorCode.MODS_AUTO_RESTART_ENABLED_REQUIRED,
      });
    }

    // SECURITY: with auto-restart on, a tracked item's update restarts the
    // running servers, so turning it on is a restart decision and takes
    // server.control, as scheduling a restart does (routes/scheduler.js).
    // mods.manage alone (which picks the tracked items, and can force an
    // update check) turned it on. Turning it off stays with mods.manage.
    if (enabled && !(await requireCapabilityInline("server.control", req, res))) return;

    if (enabled) {
      await modChecker.setUpdateCallback(async (updatedMods) => {
        const handled = await modChecker.handleModUpdate(updatedMods);
        if (!handled?.success) {
          log.warn(
            `Mod update handling failed: ${handled?.error || handled?.message || "unknown error"}`,
          );
        }
        // Without this, checkForUpdates()'s markProcessed dedup check always
        // sees undefined here (a block-bodied async function resolves
        // undefined unless it explicitly returns), so a successful restart
        // was never recorded as processed and the same update could
        // retrigger another restart on the next check cycle. Identical bug,
        // same fix, as modChecker.js's init() restore-path callback
        // (e76cade9); routes/config.js's bulk-save path already gets this
        // right with an implicit-return arrow.
        return handled;
      });
    } else {
      await modChecker.setUpdateCallback(null);
    }

    res.json({ success: true, autoRestart: enabled });
  } catch (error) {
    log.error(`Failed to configure auto-restart: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Configure restart options
router.put("/restart-options", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    const {
      warningMinutes,
      delayIfPlayersOnline,
      maxDelayMinutes,
      checkInterval,
    } = req.body || {};

    // Validate each field if present. Allow undefined (means "don't change").
    const inRange = (v, min, max) =>
      parseBoundedInteger(v, null, min, max) !== null;
    if (warningMinutes !== undefined && !inRange(warningMinutes, 0, 30)) {
      return res.status(400).json({
        error: "warningMinutes must be a whole number from 0 to 30",
        code: ErrorCode.MODS_RESTART_WARNING_MINUTES_INVALID,
      });
    }
    if (maxDelayMinutes !== undefined && !inRange(maxDelayMinutes, 5, 120)) {
      return res.status(400).json({
        error: "maxDelayMinutes must be a whole number from 5 to 120",
        code: ErrorCode.MODS_RESTART_MAX_DELAY_MINUTES_INVALID,
      });
    }
    if (
      checkInterval !== undefined &&
      (!inRange(checkInterval, 60_000, 120 * 60 * 1000) ||
        parseBoundedInteger(checkInterval, null, 60_000, 120 * 60 * 1000) %
          60_000 !==
          0)
    ) {
      return res.status(400).json({
        error:
          "checkInterval must be a whole number of minutes from 60000ms to 7200000ms",
        code: ErrorCode.MODS_RESTART_CHECK_INTERVAL_INVALID,
      });
    }
    if (
      delayIfPlayersOnline !== undefined &&
      typeof delayIfPlayersOnline !== "boolean"
    ) {
      return res
        .status(400)
        .json({
          error: "delayIfPlayersOnline must be a boolean",
          code: ErrorCode.MODS_RESTART_DELAY_IF_PLAYERS_ONLINE_INVALID,
        });
    }

    // How a mod-update restart warns and waits for players is part of the
    // restart (see POST /auto-restart): changing it takes server.control.
    // The check interval stays with mods.manage.
    const changes = (value, current) =>
      value !== undefined && value !== current && Number(value) !== current;
    if (
      (changes(warningMinutes, modChecker.restartWarningMinutes) ||
        changes(delayIfPlayersOnline, modChecker.delayIfPlayersOnline) ||
        changes(maxDelayMinutes, modChecker.maxDelayMinutes)) &&
      !(await requireCapabilityInline("server.control", req, res))
    ) {
      return;
    }

    await modChecker.setRestartOptions({
      warningMinutes,
      delayIfPlayersOnline,
      maxDelayMinutes,
      checkInterval,
    });

    const status = await modChecker.getStatus();
    res.json({
      success: true,
      options: {
        warningMinutes: status.restartWarningMinutes,
        delayIfPlayersOnline: status.delayIfPlayersOnline,
        maxDelayMinutes: status.maxDelayMinutes,
        checkInterval: status.checkInterval,
      },
    });
  } catch (error) {
    log.error(`Failed to set restart options: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get workshop ACF status (Steam API key no longer needed - using local ACF file)
router.get("/workshop-status", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    const status = await modChecker.getStatus();
    const view = await hostPathViewFor(req.user);

    res.json({
      success: true,
      configured: status.workshopAcfConfigured,
      workshopAcfPath: view.folder(status.workshopAcfPath),
      message: status.workshopAcfConfigured
        ? "Workshop ACF file found - mod updates can be detected automatically"
        : "Workshop ACF file not found - ensure server install path is correct",
    });
  } catch (error) {
    log.error(`Failed to get workshop status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Cancel pending restart (if waiting for players)
router.post("/cancel-pending-restart", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    if (!modChecker.pendingRestart) {
      return res.json({
        success: false,
        message: "No pending restart to cancel",
      });
    }

    modChecker.cancelPendingRestart();
    res.json({ success: true, message: "Pending restart cancelled" });
  } catch (error) {
    log.error(`Failed to cancel pending restart: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Sync mods from server config
router.post("/sync-from-server", async (req, res) => {
  try {
    // Use direct INI reading (more reliable than serverManager which has path issues)
    const { serverConfigPath, serverName, configRefusal } = await getActiveServerPaths();

    if (!serverConfigPath || !serverName) {
      // PT3: a refused folder is logged (once) by getActiveServerPaths().
      if (!configRefusal) log.warn("sync-from-server: Server config path not set");
      return res.json({
        success: false,
        message:
          configRefusal?.error ?? "Server config path not set. Please configure the server first.",
        ...(configRefusal ? { code: configRefusal.code } : {}),
        synced: 0,
      });
    }

    // Sanitize serverName
    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    log.info(`sync-from-server: Looking for config at ${iniPath}`);

    const view = await hostPathViewFor(req.user);
    if (!fs.existsSync(iniPath)) {
      log.warn(`sync-from-server: Config file not found at ${iniPath}`);
      return res.json({
        success: false,
        message: `Server config not found at ${view.file(iniPath)}. Start the server once first.`,
        synced: 0,
      });
    }

    // Read and parse the INI file (normalize CRLF for cross-platform compatibility)
    const content = readTextFile(iniPath);
    // Widened to tolerate whitespace around "=" -- same fix as this file's
    // other ini-read sites (hunt-wave13, 3d1921ad/783672aa), missed here. A
    // hand-edited "WorkshopItems = ..." line previously parsed as zero
    // workshop items, so this button -- the actual onboarding path for
    // adding an already-running server -- reported "No mods found in
    // server configuration" and synced nothing, for a server that has mods.
    const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
    const workshopMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);

    const modIds = splitModIdList(modsMatch?.[1]);
    // Only digits-only ids are Workshop items (same filter as GET /tracked);
    // anything else in a hand-edited line is neither tracked nor looked up.
    const workshopIds = splitIniList(workshopMatch?.[1]).filter((id) =>
      /^\d{1,15}$/.test(id),
    );

    log.info(
      `sync-from-server: Found ${modIds.length} mod IDs and ${workshopIds.length} workshop IDs`,
    );

    if (workshopIds.length === 0) {
      return res.json({
        success: true,
        message:
          "No mods found in server configuration (WorkshopItems is empty)",
        synced: 0,
      });
    }

    // Query Steam API to identify non-mod items (collections, screenshots, etc.)
    // Real PZ mods have creator_app_id 108600; collections/screenshots use 766 (Steam tools)
    const PZ_APP_ID = 108600;
    const modChecker = req.app.get("modChecker");
    let steamInfo = new Map();
    const nonModTypes = new Set();
    if (modChecker) {
      try {
        steamInfo = await modChecker.fetchSteamTimestamps(workshopIds);
        for (const [id, info] of steamInfo) {
          if (info.creator_app_id && info.creator_app_id !== PZ_APP_ID) {
            nonModTypes.add(id);
            log.info(
              `sync-from-server: Filtering "${info.title || id}" (creator_app_id: ${info.creator_app_id}, not a PZ mod)`,
            );
          }
        }
      } catch (e) {
        log.warn(
          `sync-from-server: Steam API lookup failed, proceeding without type filter: ${e.message}`,
        );
      }
    }

    // Add each workshop ID to tracking
    let synced = 0;
    let skippedIgnored = 0;
    let skippedNonMod = 0;
    for (let i = 0; i < workshopIds.length; i++) {
      try {
        const workshopId = workshopIds[i];
        // Skip non-mod items (collections, screenshots, etc.)
        if (nonModTypes.has(workshopId)) {
          skippedNonMod++;
          continue;
        }
        // Skip mods the user explicitly ignored
        if (await isModIgnored(workshopId)) {
          skippedIgnored++;
          continue;
        }
        // Try to resolve real name from mod.info on disk, fall back to a
        // placeholder. modIds[i] (the Mods= list) is NOT usable as a
        // same-index fallback here: Mods= and WorkshopItems= are two
        // independently-ordered, independently-sized INI lists (a single
        // workshop item can contribute zero, one, or several Mods= entries,
        // and map-only/framework workshop items contribute none at all), so
        // there is no positional correspondence between workshopIds[i] and
        // modIds[i] to fall back on. Using it here silently labelled a
        // workshop item with an unrelated mod's ID whenever the two lists
        // diverged in length or order -- the common case, not the edge
        // case. A "Workshop Mod <id>" placeholder is also what lets
        // shouldRefreshTrackedModName() (above) pick this mod up and
        // correct the name on a later refresh; a wrong-but-plausible-looking
        // name from modIds[i] would never match that pattern and would
        // stick around wrong forever.
        const nameFromDisk = modChecker?.resolveModNameFromDisk(workshopId);
        // Use Steam API title if available, then disk name, then placeholder.
        const steamTitle = steamInfo.get(workshopId)?.title;
        const modName =
          steamTitle || nameFromDisk || `Workshop Mod ${workshopId}`;
        await addTrackedMod(workshopId, modName);
        synced++;
      } catch (e) {
        log.warn(`Failed to sync mod ${workshopIds[i]}: ${e.message}`);
      }
    }

    const parts = [];
    if (skippedIgnored > 0) parts.push(`${skippedIgnored} ignored`);
    if (skippedNonMod > 0)
      parts.push(`${skippedNonMod} non-mod items filtered`);
    const message =
      parts.length > 0
        ? `Synced ${synced} mods from server config (${parts.join(", ")})`
        : `Synced ${synced} mods from server config`;
    res.json({
      success: true,
      message,
      synced,
      skippedIgnored,
      skippedNonMod,
      iniPath: view.file(iniPath),
    });
  } catch (error) {
    log.error(`Failed to sync mods from server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Clear all update flags
router.post("/clear-updates", async (req, res) => {
  try {
    await clearModUpdates();
    res.json({ success: true, message: "Update flags cleared" });
  } catch (error) {
    log.error(`Failed to clear mod updates: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ============================================
// Workshop Collection Sync
// Mirrors the tracked-mod list into a user-owned Steam Workshop collection.
// Reads are public; writes need the user's session cookies (settings).
// ============================================

// The workshop items the active server loads (WorkshopItems=). `read` is
// false when the INI could not be read: callers then fall back to the
// tracked list, so an unreadable INI is never reported as "every mod is
// missing from the server".
async function readCollectionServerMembership() {
  const ids = new Set();
  try {
    const { serverConfigPath, serverName } = await getActiveServerPaths();
    const sanitizedServerName = path.basename(serverName || "");
    if (
      serverConfigPath &&
      sanitizedServerName === serverName &&
      !serverName.includes("..")
    ) {
      const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
      if (fs.existsSync(iniPath)) {
        const workshopMatch = readTextFile(iniPath).match(
          /^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m,
        );
        for (const id of splitIniList(workshopMatch?.[1])) {
          if (id) ids.add(id);
        }
        return { ids, read: true };
      }
    }
  } catch (error) {
    log.debug(`Collection server membership check skipped: ${error.message}`);
  }
  return { ids: new Set(), read: false };
}

// What the collection should mirror: the mods the server loads. Tracking
// alone is not that (a deactivated mod stays tracked on purpose), so the
// Mods page chip and Sync used to count it as missing and push it into the
// public collection, unlike Settings' per-item view.
function collectionMirrorIds(membership, trackedIds) {
  return membership.read ? [...membership.ids] : trackedIds;
}

router.get("/collection/diff", async (req, res) => {
  try {
    const tracked = await getTrackedMods();
    const ids = tracked.map((m) => String(m.workshop_id));
    // Whether WorkshopItems= was actually read. Status below is derived from
    // server membership, so an unreadable INI must not be reported as "every
    // mod is missing from the server".
    const membership = await readCollectionServerMembership();
    const configuredWorkshopIds = membership.ids;
    const serverConfigRead = membership.read;
    const diff = await computeCollectionDiff(
      collectionMirrorIds(membership, ids),
    );

    // Build a unified, name-enriched item list so the UI can show every
    // tracked + collection mod in one table with per-row actions. This is
    // best-effort: if Steam is unreachable we still return the raw IDs.
    let items = [];
    if (diff.ok) {
      const trackedNames = new Map(
        tracked.map((m) => {
          const workshopId = String(m.workshop_id);
          const name = typeof m.name === "string" ? m.name.trim() : "";
          // Older tracking entries use this generated label until Steam has
          // supplied a real title. Treat it as missing so collection search
          // and the synced list show the same name as Steam.
          const isPlaceholder = name === `Workshop Mod ${workshopId}`;
          return [workshopId, isPlaceholder ? null : name || null];
        }),
      );
      const inCollection = new Set(diff.inCollection.map(String));
      // Mods enabled on the server are included even when they are neither
      // tracked nor in the collection (an ignored mod, say) — they are drift
      // and would otherwise be invisible here.
      const allIds = new Set([
        ...trackedNames.keys(),
        ...inCollection,
        ...configuredWorkshopIds,
      ]);
      // Resolve names for collection-only items (and any tracked items
      // missing a stored name).
      const needTitles = [...allIds].filter((id) => !trackedNames.get(id));
      const titleMap =
        needTitles.length > 0
          ? await fetchPublishedFileTitles(needTitles)
          : new Map();
      items = [...allIds].map((id) => {
        const inTracked = trackedNames.has(id);
        const inColl = inCollection.has(id);
        const inServer = configuredWorkshopIds.has(id);
        // The collection is meant to mirror what the server actually loads,
        // so drift is measured against WorkshopItems=. Tracking alone no
        // longer implies the mod is on the server: deactivated mods stay
        // tracked on purpose. Fall back to tracking when the INI is
        // unreadable, otherwise every row would claim to be off-server.
        const present = serverConfigRead ? inServer : inTracked;
        let status;
        if (present && inColl) status = "synced";
        else if (present && !inColl) status = "to-add";
        else if (!present && inColl) status = "collection-only";
        else status = "tracked-only";
        return {
          workshopId: id,
          name: trackedNames.get(id) || titleMap.get(id) || null,
          status,
          inTracked,
          inCollection: inColl,
          inServer,
        };
      });
      // Mods on the server but missing from the collection need attention
      // first, then collection entries the server no longer loads, then
      // tracked leftovers, then everything already in sync.
      const order = {
        "to-add": 0,
        "collection-only": 1,
        "tracked-only": 2,
        synced: 3,
      };
      items.sort((a, b) => {
        if (order[a.status] !== order[b.status])
          return order[a.status] - order[b.status];
        const an = (a.name || a.workshopId).toLowerCase();
        const bn = (b.name || b.workshopId).toLowerCase();
        return an.localeCompare(bn);
      });
    }

    // Match the same shape buildAuthCookies() requires: real (non-masked)
    // strings, of plausible length. Otherwise the UI would happily show
    // "configured" while the actual write endpoints fail with "Steam
    // session cookies not configured".
    const { sessionId: sidVal, loginSecure: lsVal } =
      await getSteamSessionCredentials();
    const looksMasked = (v) =>
      typeof v === "string" && (v.startsWith("••••••••") || /^[•*]+$/.test(v));
    const hasCredentials =
      typeof sidVal === "string" &&
      sidVal.trim().length >= 8 &&
      !looksMasked(sidVal) &&
      typeof lsVal === "string" &&
      lsVal.trim().length >= 16 &&
      !looksMasked(lsVal);

    // Decode JWT expiry from steamLoginSecure to warn the UI about stale tokens.
    let tokenExpiry = null;
    let tokenExpired = false;
    if (hasCredentials && lsVal) {
      try {
        // steamLoginSecure format: <steamid>%7C%7C<jwt> (URL-encoded ||)
        const decoded = decodeURIComponent(lsVal.trim());
        const jwtPart = decoded.split("||")[1];
        if (jwtPart) {
          const payload = JSON.parse(
            Buffer.from(jwtPart.split(".")[1], "base64").toString(),
          );
          if (payload.exp) {
            tokenExpiry = payload.exp * 1000; // ms epoch
            tokenExpired = Date.now() > tokenExpiry;
          }
        }
      } catch {
        /* non-JWT format or decode failure — ignore */
      }
    }

    res.json({
      ...diff,
      items,
      collectionId: (await getSetting("workshopCollectionId")) || null,
      autoSync: !!(await getSetting("workshopCollectionAutoSync")),
      hasCredentials,
      tokenExpiry,
      tokenExpired,
      trackedCount: ids.length,
      serverConfigRead,
    });
  } catch (error) {
    log.error(`Collection diff failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ── Per-item collection mutations ─────────────────────────────────────────
// Used by the unified Sync UI: each row in the table has its own
// add/remove button. Bulk sync (`/collection/sync`) is still available
// for one-click "fix everything".

router.post("/collection/items", async (req, res) => {
  try {
    const collectionId = await getSetting("workshopCollectionId");
    if (!collectionId) {
      return res.status(400).json({
        error: "Collection ID not configured",
        code: ErrorCode.MODS_COLLECTION_ID_NOT_CONFIGURED,
      });
    }
    const workshopId = String(req.body?.workshopId || "").trim();
    if (!/^\d{1,15}$/.test(workshopId)) {
      return res.status(400).json({
        error: "Invalid workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_LOWER,
      });
    }
    const r = await addItemToCollection(collectionId, workshopId);
    if (!r.ok)
      return res
        .status(502)
        .json({ error: r.error || "Steam rejected the change" });
    res.json({ ok: true, workshopId, action: "add" });
  } catch (error) {
    log.error(`Collection add failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete("/collection/items/:workshopId", async (req, res) => {
  try {
    const collectionId = await getSetting("workshopCollectionId");
    if (!collectionId) {
      return res.status(400).json({
        error: "Collection ID not configured",
        code: ErrorCode.MODS_COLLECTION_ID_NOT_CONFIGURED,
      });
    }
    const workshopId = String(req.params.workshopId || "").trim();
    if (!/^\d{1,15}$/.test(workshopId)) {
      return res.status(400).json({
        error: "Invalid workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_LOWER,
      });
    }
    const r = await removeItemFromCollection(collectionId, workshopId);
    if (!r.ok)
      return res
        .status(502)
        .json({ error: r.error || "Steam rejected the change" });
    res.json({ ok: true, workshopId, action: "remove" });
  } catch (error) {
    log.error(`Collection remove failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Stop panel tracking for an optional collection item. Unlike DELETE /track,
// this intentionally does not create an ignore rule or modify Steam.
router.delete("/collection/tracking/:workshopId", async (req, res) => {
  try {
    const workshopId = String(req.params.workshopId || "").trim();
    if (!/^\d{1,15}$/.test(workshopId)) {
      return res.status(400).json({
        error: "Invalid workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_LOWER,
      });
    }
    const removed = await removeTrackedMod(workshopId);
    res.json({
      ok: true,
      workshopId,
      removed,
      message: removed
        ? "Mod is no longer tracked; Steam collection and server configuration were unchanged"
        : "Mod was not tracked",
    });
  } catch (error) {
    log.error(`Collection tracking removal failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/collection/sync", async (req, res) => {
  try {
    const collectionId = await getSetting("workshopCollectionId");
    if (!collectionId) {
      return res.status(400).json({
        error: "Collection ID not configured",
        code: ErrorCode.MODS_COLLECTION_ID_NOT_CONFIGURED,
      });
    }
    const tracked = await getTrackedMods();
    const trackedIds = tracked.map((m) => String(m.workshop_id));
    const diff = await computeCollectionDiff(
      collectionMirrorIds(await readCollectionServerMembership(), trackedIds),
    );
    if (!diff.ok) {
      return res
        .status(502)
        .json({ error: diff.error || "Could not read collection" });
    }

    const added = [];
    const errors = [];
    let staleSession = false;

    // Sequential with a small delay keeps Steam happy when a fresh setup has
    // dozens of pending changes. Steam will silently throttle / 429 a tight
    // loop. The lists are usually small after the first run.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const STALE_RE = /session expired|HTTP 302|HTTP 401|HTTP 403/i;

    for (const id of diff.toAdd) {
      const r = await addItemToCollection(collectionId, id);
      if (r.ok) added.push(id);
      else {
        errors.push({ action: "add", id, error: r.error });
        if (r.error && STALE_RE.test(r.error)) {
          staleSession = true;
          break;
        }
      }
      await sleep(300);
    }
    const failedTitles = await fetchPublishedFileTitles(errors.map(({ id }) => id));
    const detailedErrors = errors.map((entry) => ({
      ...entry,
      title: failedTitles.get(entry.id) || null,
    }));
    res.json({
      success: detailedErrors.length === 0,
      collectionId,
      added,
      removed: [],
      errors: detailedErrors,
      staleSession,
      message:
        detailedErrors.length === 0
          ? `Synced \u2014 added ${added.length}`
          : staleSession
            ? "Steam session expired \u2014 paste fresh cookies and try again"
            : `Steam rejected ${detailedErrors.length} item${detailedErrors.length !== 1 ? "s" : ""}`,
    });
  } catch (error) {
    log.error(`Collection sync failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Validate that the configured cookies can edit the collection. Tries a
// no-mutation read of the collection first, then attempts a tiny add+remove
// dance on a known item to prove write access. We use the FIRST item already
// in the collection to avoid actually changing its contents.
router.post("/collection/test", async (req, res) => {
  try {
    const collectionId = await getSetting("workshopCollectionId");
    if (!collectionId)
      return res.status(400).json({
        error: "Collection ID not configured",
        code: ErrorCode.MODS_COLLECTION_ID_NOT_CONFIGURED,
      });
    const { sessionId, loginSecure } = await getSteamSessionCredentials();
    if (!sessionId || !loginSecure)
      return res
        .status(400)
        .json({
          error: "Steam session cookies not configured",
          code: ErrorCode.MODS_STEAM_SESSION_COOKIES_NOT_CONFIGURED,
        });

    const contents = await getCollectionContents(collectionId);
    if (!contents.ok)
      return res
        .status(502)
        .json({ error: contents.error || "Could not read collection" });

    // Read-only test: confirms the collection ID is valid and reachable. We
    // deliberately do NOT exercise write access here — any write probe would
    // mutate the user's real collection. Write capability is verified the
    // first time a real sync runs, where a stale session surfaces clearly.
    res.json({
      success: true,
      collectionId,
      title: contents.title,
      itemCount: contents.items.length,
      writeVerified: false,
      message: contents.title
        ? `Collection "${contents.title}" found (${contents.items.length} items). Write access is verified on first sync.`
        : `Collection found (${contents.items.length} items). Write access is verified on first sync.`,
    });
  } catch (error) {
    log.error(`Collection test failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ─── Browser cookie auto-extraction ─────────────────────────────────────────
// Lists browsers detected on the host machine and (optionally) extracts the
// Steam session cookies from one of them so the user does not have to paste
// them manually. Windows-only for now; Firefox/Chrome/Edge/Brave supported.

router.get("/collection/browsers", async (req, res) => {
  try {
    const info = listAvailableBrowsers();
    res.json(info);
  } catch (error) {
    log.error(`List browsers failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/collection/extract-cookies", async (req, res) => {
  try {
    const browser = String(req.body?.browser || "")
      .toLowerCase()
      .trim();
    const allowed = ["firefox", "chrome", "edge", "brave"];
    if (!allowed.includes(browser)) {
      return res.status(400).json({
        error: "Invalid browser. Must be one of: " + allowed.join(", "),
        code: ErrorCode.MODS_INVALID_BROWSER,
        params: sanitizeErrorParams({ browsers: allowed.join(", ") }),
      });
    }
    const result = await extractSteamCookies(browser);
    if (!result.ok) {
      return res.status(200).json(result); // 200 with ok:false so the UI can render the message
    }
    // The extracted credentials never need to leave the server: extract
    // and save in one step, and report only success -- sessionid/
    // steamLoginSecure previously round-tripped to the client in this
    // response purely so the client could immediately POST them straight
    // back for storage (client never displayed them). A technician-tier
    // caller (this router's own permission floor) could ask this one
    // endpoint for the panel host's live Steam login token; now it can't
    // (2026-08-26 bug hunt, extract-cookies response shape finding).
    await setSteamSessionCredentials(result.sessionid, result.steamLoginSecure);
    res.json({
      ok: true,
      browser: result.browser,
      saved: true,
      notes: result.notes,
    });
  } catch (error) {
    log.error(`Extract cookies failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Push endpoint used by the panel browser extension. The extension reads
// Steam cookies via the WebExtensions `cookies` API (works regardless of
// Chrome's App-Bound Encryption) and POSTs them here. Authentication is the
// usual JWT — the extension logs in with the panel's normal username/password
// first to obtain a token.
router.post("/collection/extension-push", async (req, res) => {
  try {
    const sessionid =
      typeof req.body?.sessionid === "string" ? req.body.sessionid.trim() : "";
    const loginSecure =
      typeof req.body?.steamLoginSecure === "string"
        ? req.body.steamLoginSecure.trim()
        : "";

    if (!sessionid || !loginSecure) {
      return res
        .status(400)
        .json({
          error: "Both sessionid and steamLoginSecure are required",
          code: ErrorCode.MODS_EXTENSION_COOKIES_REQUIRED,
        });
    }
    // Cookie values must not contain CR/LF/null/semicolon — those would break
    // the Cookie header we build for Workshop write requests and could be
    // used for header injection.
    const HAS_CONTROL = /[\r\n\0;]/;
    if (HAS_CONTROL.test(sessionid) || HAS_CONTROL.test(loginSecure)) {
      return res
        .status(400)
        .json({
          error: "Cookie values contain forbidden control characters",
          code: ErrorCode.MODS_EXTENSION_COOKIES_CONTROL_CHARS,
        });
    }
    // Sanity-check value lengths — Steam cookies are well under 1 KB each.
    if (sessionid.length > 4096 || loginSecure.length > 4096) {
      return res
        .status(400)
        .json({
          error: "Cookie values are unexpectedly long",
          code: ErrorCode.MODS_EXTENSION_COOKIES_TOO_LONG,
        });
    }

    await setSteamSessionCredentials(sessionid, loginSecure);

    log.info(
      `Steam cookies updated via browser extension (user: ${req.user?.username || "unknown"})`,
    );
    res.json({ ok: true, message: "Cookies saved" });
  } catch (error) {
    log.error(`Extension push failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Serves the panel's browser extension as a zip: the copy this panel version
// carries (utils/embeddedExtension.js), never a prebuilt zip next to the
// install, which an in-place update leaves at the version first installed.
router.get("/collection/extension-bundle", async (req, res) => {
  try {
    const files = loadCurrentExtensionFiles();
    if (!files) {
      return res.status(404).json({
        error:
          "Browser extension files are missing from this panel install. Download zomboid-panel-extension.zip from the GitHub release instead.",
        code: ErrorCode.MODS_EXTENSION_FILES_MISSING,
      });
    }
    const zip = await zipExtensionFiles(files);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="zomboid-panel-extension.zip"',
    );
    res.setHeader("Content-Length", String(zip.length));
    res.end(zip);
  } catch (error) {
    log.error(`Extension bundle serve failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get Steam Workshop collection details (extract all mods from a collection)
router.post("/import-collection", async (req, res) => {
  try {
    const { collectionUrl } = req.body;

    if (!collectionUrl) {
      return res
        .status(400)
        .json({
          error: "Collection URL or ID is required",
          code: ErrorCode.MODS_IMPORT_COLLECTION_URL_REQUIRED,
        });
    }

    // Extract collection ID from URL or use directly
    let collectionId = collectionUrl;
    const urlMatch = collectionUrl.match(/id=(\d+)/);
    if (urlMatch) {
      collectionId = urlMatch[1];
    }

    // Validate it's a number
    if (!/^\d{1,15}$/.test(collectionId)) {
      return res.status(400).json({
        error: "Invalid collection ID",
        code: ErrorCode.MODS_IMPORT_COLLECTION_ID_INVALID,
      });
    }

    log.info(`Fetching collection details for ID: ${collectionId}`);

    // Use Steam API to get collection details
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    let collectionResponse;
    try {
      collectionResponse = await fetch(
        "https://api.steampowered.com/ISteamRemoteStorage/GetCollectionDetails/v1/",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            collectioncount: "1",
            "publishedfileids[0]": collectionId,
          }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (error.name === "AbortError") {
        return res.status(504).json({
          error: "Steam collection lookup timed out. Please try again.",
          code: ErrorCode.MODS_IMPORT_COLLECTION_TIMEOUT,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!collectionResponse.ok) {
      throw new Error(`Steam API returned ${collectionResponse.status}`);
    }

    const collectionData = await collectionResponse.json();

    if (!collectionData.response?.collectiondetails?.[0]) {
      return res.status(404).json({
        error: "Collection not found",
        code: ErrorCode.MODS_IMPORT_COLLECTION_NOT_FOUND,
      });
    }

    const collection = collectionData.response.collectiondetails[0];

    if (collection.result !== 1) {
      return res
        .status(404)
        .json({
          error: "Collection not found or is private",
          code: ErrorCode.MODS_IMPORT_COLLECTION_PRIVATE,
        });
    }

    // A collection's direct children can themselves be sub-collections --
    // Steam marks these with filetype 2 (k_EWorkshopFileTypeCollection) in
    // GetCollectionDetails' children[], the same enum value Steam's own
    // sharedfiles/addchild error body echoes back when you try to add one:
    // "the id you gave me IS a collection". A collection-of-collections is
    // a real, common curation pattern (e.g. a "complete overhaul" bundle
    // whose direct children are themed sub-collections). Treating a
    // sub-collection id as an ordinary importable mod used to make every
    // later add/track/sync attempt on it fail identically and permanently
    // -- no cookie or session fix could ever resolve it -- because Steam
    // refuses to nest a collection inside another collection this way.
    const WORKSHOP_FILE_TYPE_COLLECTION = 2;
    const children = collection.children || [];
    const subCollectionIds = children
      .filter((c) => Number(c.filetype) === WORKSHOP_FILE_TYPE_COLLECTION)
      .map((c) => c.publishedfileid);
    const modIds = children
      .filter((c) => Number(c.filetype) !== WORKSHOP_FILE_TYPE_COLLECTION)
      .map((c) => c.publishedfileid);

    if (modIds.length === 0) {
      return res.json({
        success: true,
        message: "Collection is empty",
        mods: [],
        subCollectionIds,
      });
    }

    // Now get details for each mod in the collection
    const modFormData = new URLSearchParams();
    modFormData.append("itemcount", modIds.length.toString());
    modIds.forEach((id, index) => {
      modFormData.append(`publishedfileids[${index}]`, id);
    });

    const modsAbort = new AbortController();
    const modsTimer = setTimeout(() => modsAbort.abort(), 15000);
    let modsResponse;
    try {
      modsResponse = await fetch(
        "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: modFormData,
          signal: modsAbort.signal,
        },
      );
    } finally {
      clearTimeout(modsTimer);
    }

    if (!modsResponse.ok) {
      throw new Error(`Steam API returned ${modsResponse.status}`);
    }

    const modsData = await modsResponse.json();
    const allDetails = modsData.response?.publishedfiledetails || [];

    const mods = allDetails
      .filter((m) => m.result === 1)
      .map((m) => ({
        workshopId: m.publishedfileid,
        name: m.title,
        description: m.description?.substring(0, 200),
        tags: m.tags?.map((t) => t.tag) || [],
        isMap:
          m.tags?.some(
            (t) =>
              t.tag?.toLowerCase() === "map" || t.tag?.toLowerCase() === "maps",
          ) || false,
      }));

    // A member whose Steam detail lookup didn't come back with result === 1
    // (deleted, made private, or Steam omitted it from the response
    // entirely) is silently absent from `mods` above -- this list is what
    // lets a caller tell "3 mods were dropped" apart from "the collection
    // only ever had 47", same notice this route already gives for skipped
    // sub-collections (bug hunt 2026-08-31, carded low-priority: the route
    // already knows how to say "some were dropped" for one class and didn't
    // for this one).
    const resolvedIds = new Set(mods.map((m) => m.workshopId));
    const skippedModIds = modIds.filter((id) => !resolvedIds.has(id));

    log.info(
      `Found ${mods.length} mods in collection ${collectionId}` +
        (subCollectionIds.length > 0
          ? ` (${subCollectionIds.length} sub-collection${subCollectionIds.length === 1 ? "" : "s"} skipped)`
          : "") +
        (skippedModIds.length > 0
          ? ` (${skippedModIds.length} mod lookup${skippedModIds.length === 1 ? "" : "s"} failed: ${skippedModIds.join(", ")})`
          : ""),
    );

    res.json({
      success: true,
      collectionId,
      totalMods: mods.length,
      mods,
      subCollectionIds,
      skippedModIds,
    });
  } catch (error) {
    log.error(`Failed to import collection: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get mod info from Steam Workshop (for a single mod)
router.post("/get-mod-info", async (req, res) => {
  try {
    const { workshopId } = req.body;

    if (!workshopId) {
      return res.status(400).json({
        error: "Workshop ID is required",
        code: ErrorCode.MODS_WORKSHOP_ID_REQUIRED,
      });
    }

    const workshopIdStr = String(workshopId);
    if (!/^\d{1,15}$/.test(workshopIdStr)) {
      return res.status(400).json({
        error: "Invalid Workshop ID format",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_FORMAT,
      });
    }

    const infoAbort = new AbortController();
    const infoTimer = setTimeout(() => infoAbort.abort(), 15000);
    let response;
    try {
      response = await fetch(
        "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            itemcount: "1",
            "publishedfileids[0]": workshopId,
          }),
          signal: infoAbort.signal,
        },
      );
    } finally {
      clearTimeout(infoTimer);
    }

    if (!response.ok) {
      throw new Error(`Steam API returned ${response.status}`);
    }

    const data = await response.json();
    const modInfo = data.response?.publishedfiledetails?.[0];

    if (!modInfo || modInfo.result !== 1) {
      return res.status(404).json({
        error: "Mod not found",
        code: ErrorCode.MODS_GET_MOD_INFO_NOT_FOUND,
      });
    }

    res.json({
      workshopId: modInfo.publishedfileid,
      name: modInfo.title,
      description: modInfo.description?.substring(0, 500),
      tags: modInfo.tags?.map((t) => t.tag) || [],
      isMap:
        modInfo.tags?.some(
          (t) =>
            t.tag?.toLowerCase() === "map" || t.tag?.toLowerCase() === "maps",
        ) || false,
      timeUpdated: modInfo.time_updated,
      timeCreated: modInfo.time_created,
    });
  } catch (error) {
    log.error(`Failed to get mod info: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Write mods to server .ini file
router.post("/write-to-ini", async (req, res) => {
  try {
    const { mods, mapFolders } = req.body;
    log.info(
      `POST /write-to-ini: ${mods?.length || 0} mods, ${mapFolders?.length || 0} map folders`,
    );
    // mods: array of { workshopId, modId } where modId is the mod loading ID (from info.txt)
    // mapFolders: optional array of map folder names for map mods

    if (!mods || !Array.isArray(mods)) {
      return res.status(400).json({
        error: "Mods array is required",
        code: ErrorCode.MODS_WRITE_TO_INI_MODS_ARRAY_REQUIRED,
      });
    }

    // Validate all workshopId values are numeric to prevent path traversal
    for (const m of mods) {
      if (m.workshopId && !/^\d{1,15}$/.test(String(m.workshopId))) {
        const workshopId = String(m.workshopId).substring(0, 20);
        return res.status(400).json({
          error: `Invalid Workshop ID: ${workshopId}`,
          code: ErrorCode.MODS_INVALID_WORKSHOP_ID_TEMPLATE,
          params: sanitizeErrorParams({ workshopId }),
        });
      }
    }

    const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Server config path not set. Please configure the server first.",
          code: ErrorCode.MODS_CONFIG_PATH_NOT_SET_GUIDANCE,
        }),
      );
    }

    // Sanitize serverName to prevent path traversal
    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error:
          "Server config file not found. Start the server once first to generate the config file.",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND_GUIDANCE,
      });
    }

    // Build the mod strings, auto-detecting mod IDs where possible
    // Mods= is semicolon-separated list of mod IDs (from mod's info.txt id= field)
    // WorkshopItems= is semicolon-separated list of Workshop IDs
    const resolvedMods = [];
    let autoDetectedCount = 0;

    for (const m of mods) {
      let modId = m.modId;
      const workshopIdStr = String(m.workshopId);

      // If modId looks like a workshop ID (all numeric), try to auto-detect the real mod ID
      if (modId && /^\d{1,15}$/.test(modId)) {
        // First try local files
        if (serverPath) {
          const detectedId = findModIdFromWorkshop(modId, serverPath);
          if (detectedId) {
            modId = detectedId;
            autoDetectedCount++;
            log.info(
              `Auto-detected mod ID from local files: ${detectedId} for workshop ${m.workshopId}`,
            );
          }
        }
        // If still numeric, try fetching from Steam Workshop page
        if (/^\d{1,15}$/.test(modId)) {
          const steamModId = await fetchModIdFromWorkshop(workshopIdStr);
          if (steamModId) {
            modId = steamModId;
            autoDetectedCount++;
            log.info(
              `Auto-detected mod ID from Steam Workshop: ${steamModId} for workshop ${m.workshopId}`,
            );
          }
        }
      }
      // Also try if no modId at all
      else if (!modId) {
        // First try local files
        if (serverPath) {
          const detectedId = findModIdFromWorkshop(workshopIdStr, serverPath);
          if (detectedId) {
            modId = detectedId;
            autoDetectedCount++;
            log.info(
              `Auto-detected mod ID from local files: ${detectedId} for workshop ${m.workshopId}`,
            );
          }
        }
        // If still no modId, try fetching from Steam Workshop page
        if (!modId) {
          const steamModId = await fetchModIdFromWorkshop(workshopIdStr);
          if (steamModId) {
            modId = steamModId;
            autoDetectedCount++;
            log.info(
              `Auto-detected mod ID from Steam Workshop: ${steamModId} for workshop ${m.workshopId}`,
            );
          }
        }
      }

      // Final safeguard: if detection failed and modId still looks like a
      // Steam Workshop ID (all-numeric), drop it. PZ resolves Mods= against
      // the letter-based `id=` field from mod.info — a numeric value there
      // silently fails to load AND pollutes the INI (this is the root cause
      // of the "numeric IDs merged into Mods=" bug).
      if (modId && looksLikeWorkshopId(String(modId))) {
        log.warn(
          `Dropping unresolved numeric modId "${modId}" for workshop ${m.workshopId} (would have polluted Mods=)`,
        );
        modId = null;
      }

      resolvedMods.push({
        workshopId: m.workshopId,
        modId: modId || null,
      });
    }

    const modIdList = sanitizeModIdList(
      resolvedMods.map((m) => m.modId).filter(Boolean),
    );
    const workshopIdList = sanitizeIniList(
      resolvedMods.map((m) => m.workshopId).filter(Boolean),
    );
    // Every workshopId ends up in WorkshopItems= above regardless of whether
    // its modId resolved, so Steam will download it either way. A workshopId
    // whose modId never resolved is silently EXCLUDED from Mods= (filtered
    // via .filter(Boolean) above) -- it never loads in PZ even though it's
    // subscribed. Surface which ones so the caller isn't told "success" for
    // mods that are actually still orphaned.
    const unresolvedWorkshopIds = resolvedMods
      .filter((m) => m.workshopId && !m.modId)
      .map((m) => m.workshopId);

    // Auto-detect map folders from downloaded workshop mods if not provided
    let detectedMapFolders = mapFolders || [];
    if (serverPath && (!mapFolders || mapFolders.length === 0)) {
      for (const m of mods) {
        const workshopIdStr = String(m.workshopId);
        const modMapFolders = findMapFoldersFromWorkshop(
          workshopIdStr,
          serverPath,
        );
        for (const folder of modMapFolders) {
          if (!detectedMapFolders.includes(folder)) {
            detectedMapFolders.push(folder);
            log.info(
              `Auto-detected map folder: ${folder} from workshop ${workshopIdStr}`,
            );
          }
        }
      }
    }

    // Build Map= string - mod maps must come BEFORE the main map
    // Format: "ModMap1;ModMap2;Muldraugh, KY"
    let mapList = "Muldraugh, KY";
    if (detectedMapFolders && detectedMapFolders.length > 0) {
      mapList = `${sanitizeIniList(detectedMapFolders)};Muldraugh, KY`;
    }

    // Atomically read-modify-write the ini file inside the lock
    let backupWarning = null;
    await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);

      // Update or add Mods= (mod IDs like NeatUI_Framework)
      //
      // Existence must be checked with the SAME anchored regex used to
      // replace it, not a plain .includes() -- .includes("Mods=") matches
      // those characters ANYWHERE in the file, including inside operator
      // free text (PublicDescription, ServerWelcomeMessage). When that
      // happened, this took the replace branch, the anchored regex matched
      // nothing, content.replace() returned the string unchanged, and the
      // write proceeded anyway -- backup taken, route returns success,
      // the operator's mod-list change silently never lands. Found
      // 2026-08-27 auditing this file's write surface for the "cannot
      // fail" class; the correct pattern already existed at 5 of the file's
      // 18 ini-write sites (this fix brings the other 13 in line with it).
      // Anchored with the SAME whitespace tolerance parseIni()/toIni() (in
      // serverFiles.js) and findDuplicateIniKeys() already give a real
      // assignment line -- a bare /^Mods=.*/m does not match "Mods = foo"
      // (spaces around "="), which a hand-edited file can easily carry.
      // Before serverFiles.js's toIni() preserved untouched lines' original
      // formatting (573f63fd), any structured-editor save silently
      // normalized "Mods = foo" to "Mods=foo" the moment the operator saved
      // ANY field, which accidentally kept this route's strict match
      // working. Now that toIni() correctly leaves untouched lines alone,
      // that accidental repair no longer happens, so a whitespace-variant
      // line here would miss the match, get appended as a SECOND "Mods="
      // line instead of replacing the first, and the resulting duplicate
      // key would then 409-lock PUT /ini's structured save via
      // findDuplicateIniKeys() until the raw editor manually fixes it. The
      // three writers need to agree on what a key line looks like; this
      // brings mods.js's match+replace in line with the other two.
      if (content.match(/^[ \t]*Mods[ \t]*=.*/m)) {
        content = content.replace(/^[ \t]*Mods[ \t]*=.*/m, () => `Mods=${modIdList}`);
      } else {
        content += `\nMods=${modIdList}`;
      }

      // Update or add WorkshopItems= (workshop IDs like 3508537032)
      if (content.match(/^[ \t]*WorkshopItems[ \t]*=.*/m)) {
        content = content.replace(
          /^[ \t]*WorkshopItems[ \t]*=.*/m,
          () => `WorkshopItems=${workshopIdList}`,
        );
      } else {
        content += `\nWorkshopItems=${workshopIdList}`;
      }

      // Update or add Map= (only if we have custom maps)
      if (detectedMapFolders && detectedMapFolders.length > 0) {
        if (content.match(/^[ \t]*Map[ \t]*=.*/m)) {
          content = content.replace(/^[ \t]*Map[ \t]*=.*/m, () => `Map=${mapList}`);
        } else {
          content += `\nMap=${mapList}`;
        }
      }

      backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
    });

    log.info(
      `Wrote ${mods.length} mods to ${iniPath} (${autoDetectedCount} mod IDs auto-detected, ${detectedMapFolders.length} map folders)`,
    );

    res.json({
      success: true,
      message: `Successfully configured ${mods.length} mods in server config.${autoDetectedCount > 0 ? ` (${autoDetectedCount} mod IDs auto-detected)` : ""}${detectedMapFolders.length > 0 ? ` Map folders: ${detectedMapFolders.join(", ")}` : ""}${unresolvedWorkshopIds.length > 0 ? ` WARNING: ${unresolvedWorkshopIds.length} mod ID(s) could not be auto-detected and were subscribed but NOT enabled: ${unresolvedWorkshopIds.join(", ")}` : ""}`,
      iniPath: (await hostPathViewFor(req.user)).file(iniPath),
      modsConfigured: mods.length,
      autoDetectedModIds: autoDetectedCount,
      unresolvedModIds: unresolvedWorkshopIds,
      modIds: modIdList,
      workshopItems: workshopIdList,
      mapList,
      mapFolders: detectedMapFolders,
      ...(backupWarning ? { backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to write mods to ini: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get current mod configuration from .ini file
router.get("/current-config", async (req, res) => {
  try {
    const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();

    if (!serverConfigPath || !serverName) {
      return res.json(
        withConfigRefusal(configRefusal, {
          configured: false,
          error: "Server config path not set",
          code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
          modIds: [],
          workshopIds: [],
          totalMods: 0,
        }),
      );
    }

    // Sanitize serverName to prevent path traversal
    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);

    if (!fs.existsSync(iniPath)) {
      return res.json({
        configured: false,
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
        modIds: [],
        workshopIds: [],
        totalMods: 0,
      });
    }

    const content = readTextFile(iniPath);

    // Extract mod-related settings. Widened to tolerate whitespace around
    // "=" -- this is GET /current-config, the route the Mods page actually
    // loads on open (see the duplicate-key comment just below), so a hand-
    // edited "Mods = foo;bar" line didn't just misparse a field here, it
    // rendered the whole Mods page as empty (totalMods: 0) with no error at
    // all. Same fix as this file's other ini-write/-read sites (hunt-
    // wave13, 3d1921ad/783672aa), missed here.
    const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
    const workshopMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
    const mapMatch = content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m);

    const modIds = splitModIdList(modsMatch?.[1]);
    const workshopIds = splitIniList(workshopMatch?.[1]);
    const maps = mapMatch ? splitIniList(mapMatch[1]) : ["Muldraugh, KY"];

    // Everything above reads via content.match(/^Key=.../m) with no /g --
    // the FIRST occurrence only. A duplicated key means this page is
    // showing (and every write here edits) one of possibly several
    // disagreeing blocks in the file, with nothing else telling the
    // operator that. Additive, reported not thrown -- this is the route
    // the Mods page actually loads on open (GET /current-config), so this
    // is where an operator would actually see it. See
    // utils/iniDuplicateKeys.js.
    const duplicateKeys = findDuplicateIniKeys(content);

    // Build workshop → modId mapping from disk
    const modIdSet = new Set(modIds);
    const workshopModMap = {}; // workshopId -> [{ id, name, enabled, require, loadAfter, loadBefore, incompatible, modInfoIssues }]
    const knownMods = [];
    if (serverPath) {
      for (const wsId of workshopIds) {
        const details = getModDetailsFromWorkshop(wsId, serverPath);
        knownMods.push(...details);
        workshopModMap[wsId] = details.map((m) => ({
          id: m.id,
          name: m.name || m.id,
          enabled: modIdSet.has(m.id),
          require: m.require?.length ? m.require : undefined,
          loadAfter: m.loadAfter?.length ? m.loadAfter : undefined,
          loadBefore: m.loadBefore?.length ? m.loadBefore : undefined,
          incompatible: m.incompatible?.length ? m.incompatible : undefined,
          modInfoIssues: m.modInfoIssues?.length ? m.modInfoIssues : undefined,
        }));
      }
    }
    // The order the server really loads Mods= in, what is wrong with it, and
    // the ordering rules a sort should keep (utils/modLoadOrder.js).
    const { effectiveModOrder, orderWarnings, orderingConstraints } = analyzeModOrder(
      modIds,
      knownMods,
      { conflictWinners: cachedConflictWinners(workshopIds, modIds, serverPath) },
    );

    res.json({
      configured: true,
      modIds,
      workshopIds,
      maps,
      totalMods: modIds.length,
      iniPath: (await hostPathViewFor(req.user)).file(iniPath),
      workshopModMap,
      effectiveModOrder,
      orderWarnings,
      orderingConstraints,
      duplicateKeys,
      // { modId, workshopId } when those entries are PanelBridge's own
      // Steam Workshop delivery (the Mods page badges and locks them).
      bridgeManaged: await getBridgeManaged(),
    });
  } catch (error) {
    log.error(`Failed to get current mod config: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Toggle a single mod ID on/off in the Mods= line
router.post("/toggle-mod-id", async (req, res) => {
  try {
    const { modId, enabled } = req.body;

    if (!modId || typeof modId !== "string") {
      return res.status(400).json({
        error: "modId is required",
        code: ErrorCode.MODS_TOGGLE_MOD_ID_REQUIRED,
      });
    }
    if (typeof enabled !== "boolean") {
      return res.status(400).json({
        error: "enabled (boolean) is required",
        code: ErrorCode.MODS_TOGGLE_ENABLED_REQUIRED,
      });
    }
    // Validate modId format — allow any printable characters except INI delimiters
    if (/[\r\n;=]/.test(modId) || modId.length > 200) {
      return res.status(400).json({
        error: "Invalid mod ID format",
        code: ErrorCode.MODS_INVALID_MOD_ID_FORMAT,
      });
    }

    const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Server config path not set",
          code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
        }),
      );
    }

    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
      });
    }

    const result = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);
      // Widened to tolerate whitespace around "=" (see hunt-wave13,
      // 3d1921ad): modsMatch doubles as BOTH the current-value parse and
      // the exists-check the replace below relies on, so a hand-edited
      // "Mods = foo" line previously parsed as zero current mods AND took
      // the append branch, creating a duplicate "Mods=" key.
      const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
      let currentModIds = splitModIdList(modsMatch?.[1]);
      const modIdsBefore = [...currentModIds];
      const currentWorkshopIds = splitIniList(
        content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m)?.[1],
      );

      // Reject attempts to ENABLE a workshop-ID-shaped value as a mod ID,
      // UNLESS a real mod.info on disk confirms it's a legitimate mod ID
      // that just happens to look like one (e.g. "Tear All Clothes"
      // 3519629457, see enable-disk-mod above) -- disk verification is
      // strictly more evidence than the regex that flagged it ambiguous.
      // Disabling is still always allowed so the Debug "Strip numeric IDs
      // from Mods=" auto-fix can remove existing pollution.
      if (
        enabled &&
        looksLikeWorkshopId(modId) &&
        !isModIdVerifiedOnDisk(modId, currentWorkshopIds, serverPath)
      ) {
        return { rejected: true };
      }

      if (enabled) {
        if (!currentModIds.includes(modId)) {
          currentModIds.push(modId);
        }
      } else {
        currentModIds = currentModIds.filter((id) => id !== modId);
      }

      // Disk-bypass-aware sanitizer applied to the FULL list, not just the
      // entry being toggled -- otherwise toggling any unrelated mod would
      // silently re-strip a pre-existing, already-disk-verified numeric-ID
      // mod elsewhere in the same Mods= line as collateral damage.
      const newModList = sanitizeModIdListWithDiskBypass(
        currentModIds,
        currentWorkshopIds,
        serverPath,
        modIdsBefore,
      );
      // Reuse modsMatch (already computed above) as the existence check --
      // a separate content.includes("Mods=") would match those characters
      // anywhere in the file (e.g. operator free text), taking this branch
      // while the anchored replace below matches nothing and silently
      // no-ops. See the 2026-08-27 comment on this file's first ini-write
      // site for the full explanation.
      if (modsMatch) {
        content = content.replace(/^[ \t]*Mods[ \t]*=.*/m, () => `Mods=${newModList}`);
      } else {
        content += `\nMods=${newModList}`;
      }

      const backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
      return { totalMods: currentModIds.length, backupWarning };
    });

    if (result.rejected) {
      return res.status(400).json({
        error:
          "That looks like a Steam Workshop ID, not a mod ID. Workshop IDs (numeric) belong in WorkshopItems=, not Mods=.",
        code: ErrorCode.MODS_TOGGLE_WORKSHOP_ID_IN_MODID,
      });
    }

    log.info(
      `Toggled mod ID "${modId}" ${enabled ? "ON" : "OFF"} in ${iniPath}`,
    );

    res.json({
      success: true,
      modId,
      enabled,
      totalMods: result.totalMods,
      ...(result.backupWarning ? { backupWarning: result.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to toggle mod ID: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Batch toggle multiple mod IDs on/off in a single INI write
router.post("/batch-toggle-mod-ids", async (req, res) => {
  try {
    const { changes } = req.body;

    if (!Array.isArray(changes) || changes.length === 0) {
      return res.status(400).json({
        error: "changes array is required",
        code: ErrorCode.MODS_BATCH_TOGGLE_CHANGES_REQUIRED,
      });
    }
    if (changes.length > 500) {
      return res.status(400).json({
        error: "Too many changes (max 500)",
        code: ErrorCode.MODS_BATCH_TOGGLE_TOO_MANY,
      });
    }

    // Validate all entries
    for (const change of changes) {
      if (!change.modId || typeof change.modId !== "string") {
        return res.status(400).json({
          error: "Each change must have a modId string",
          code: ErrorCode.MODS_BATCH_TOGGLE_MODID_STRING_REQUIRED,
        });
      }
      if (typeof change.enabled !== "boolean") {
        return res.status(400).json({
          error: "Each change must have an enabled boolean",
          code: ErrorCode.MODS_BATCH_TOGGLE_ENABLED_BOOLEAN_REQUIRED,
        });
      }
      if (/[\r\n;=]/.test(change.modId) || change.modId.length > 200) {
        const modId = change.modId.substring(0, 50);
        return res.status(400).json({
          error: `Invalid mod ID format: ${modId}`,
          code: ErrorCode.MODS_INVALID_MOD_ID_FORMAT_TEMPLATE,
          params: sanitizeErrorParams({ modId }),
        });
      }
    }

    const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Server config path not set",
          code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
        }),
      );
    }

    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
      });
    }

    const result = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);
      // Widened to tolerate whitespace around "=" (hunt-wave13, 3d1921ad) --
      // see /toggle-mod-id above for why the guard AND the read must both
      // change together.
      const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
      let currentModIds = splitModIdList(modsMatch?.[1]);
      const modIdsBefore = [...currentModIds];
      const currentWorkshopIds = splitIniList(
        content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m)?.[1],
      );

      // Reject changes that try to ENABLE a workshop-ID-shaped value,
      // UNLESS a real mod.info on disk confirms it's a legitimate mod ID
      // (see /toggle-mod-id above for the full reasoning). Removal is still
      // always allowed (used by the Debug page "Strip numeric IDs" fix).
      const badEnables = changes.filter(
        (c) =>
          c.enabled &&
          looksLikeWorkshopId(c.modId) &&
          !isModIdVerifiedOnDisk(c.modId, currentWorkshopIds, serverPath),
      );
      if (badEnables.length > 0) {
        return { rejectedCount: badEnables.length };
      }

      // Apply all changes
      for (const { modId, enabled } of changes) {
        if (enabled) {
          if (!currentModIds.includes(modId)) {
            currentModIds.push(modId);
          }
        } else {
          currentModIds = currentModIds.filter((id) => id !== modId);
        }
      }

      // Disk-bypass-aware sanitizer applied to the FULL list -- see
      // /toggle-mod-id above for why this must cover every entry, not just
      // the ones in `changes`.
      const newModList = sanitizeModIdListWithDiskBypass(
        currentModIds,
        currentWorkshopIds,
        serverPath,
        modIdsBefore,
      );
      // Reuse modsMatch (see this file's first ini-write site for why a
      // separate .includes("Mods=") is wrong here).
      if (modsMatch) {
        content = content.replace(/^[ \t]*Mods[ \t]*=.*/m, () => `Mods=${newModList}`);
      } else {
        content += `\nMods=${newModList}`;
      }

      const backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
      return { totalMods: currentModIds.length, backupWarning };
    });

    if (result.rejectedCount) {
      return res.status(400).json({
        error: `Refusing to add ${result.rejectedCount} workshop-ID-shaped entr${result.rejectedCount === 1 ? "y" : "ies"} to Mods= (those belong in WorkshopItems=).`,
        code: ErrorCode.MODS_BATCH_TOGGLE_WORKSHOP_ID_IN_MODS,
        params: sanitizeErrorParams({ count: result.rejectedCount }),
      });
    }

    log.info(`Batch toggled ${changes.length} mod IDs in ${iniPath}`);

    res.json({
      success: true,
      changesApplied: changes.length,
      totalMods: result.totalMods,
      ...(result.backupWarning ? { backupWarning: result.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to batch toggle mod IDs: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Add a single mod to server .ini file (appends to existing mods)
router.post("/add-to-ini", async (req, res) => {
  try {
    const { workshopId, modId } = req.body;
    // workshopId: the Steam Workshop ID
    // modId: optional - the mod loading ID (from info.txt). If not provided, workshopId is used as a placeholder

    if (!workshopId) {
      return res.status(400).json({
        error: "Workshop ID is required",
        code: ErrorCode.MODS_WORKSHOP_ID_REQUIRED,
      });
    }

    // Validate workshopId is numeric
    if (!/^\d{1,15}$/.test(String(workshopId))) {
      return res.status(400).json({
        error: "Invalid Workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_CAP,
      });
    }

    const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error:
            "Server config path not set. Please configure the server first in Settings.",
          code: ErrorCode.MODS_ADD_TO_INI_CONFIG_PATH_NOT_SET,
        }),
      );
    }

    // Sanitize serverName to prevent path traversal
    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error:
          "Server config file not found. Start the server once first to generate the config file.",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND_GUIDANCE,
      });
    }

    // Do all async detection work BEFORE taking the lock.
    //
    // continuous-bug-hunt round 27 (mod load order / Workshop collection
    // import): a single workshop item can bundle several mods (one mod folder
    // each). This route only ever enabled the default (first) one in Mods=,
    // with nothing telling the operator the workshop item actually bundled
    // more mods -- WorkshopItems= (content downloaded/tracked) and Mods=
    // (content enabled) silently drifted out of step for every extra bundled
    // mod, invisibly, on the MAIN "add a mod" path (Mods.tsx's addToIni,
    // called with no explicit modId for every ordinary add). The sibling
    // /sync-mod-ids route already solved this correctly -- same "auto-enable
    // the default, report the rest as `alternatives`" shape, deliberately NOT
    // auto-enabling every bundled id unasked (a workshop item's other mods
    // can be genuinely optional sub-content, not always meant to all load) --
    // so does this one (resolveModIdsForAddition, `discover: "first"`).
    const resolution = await resolveModIdsForAddition({
      workshopId: String(workshopId),
      explicitModIds: modId ? [String(modId)] : [],
      discover: modId ? "none" : "first",
      serverPath,
    });
    const detectedModId = resolution.modIds[0] || null;
    const detectionSource = resolution.detectionSource;
    const alternativeModIds = resolution.alternativeModIds;

    // Detect map folders (async-safe, doesn't touch INI)
    let modMapFolders = [];
    if (serverPath) {
      modMapFolders = findMapFoldersFromWorkshop(
        String(workshopId),
        serverPath,
      );
    }

    // Atomically read-modify-write inside the lock
    const result = await withIniLock(iniPath, async () => {
      const applied = addWorkshopItemToIni(readTextFile(iniPath), {
        workshopId: String(workshopId),
        modIds: detectedModId ? [detectedModId] : [],
        mapFolders: modMapFolders,
        serverPath,
      });

      // Check if mod is already in the list
      if (applied.workshopAlreadyExisted) {
        return { alreadyExists: true };
      }

      const backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, applied.content),
      );
      return {
        alreadyExists: false,
        totalWorkshopItems: applied.workshopCount,
        addedMapFolders: applied.addedMapFolders,
        backupWarning,
      };
    });

    if (result.alreadyExists) {
      return res.json({
        success: true,
        message: "Mod is already configured in the server",
        alreadyExists: true,
      });
    }

    const addedMapFolders = result.addedMapFolders;
    log.info(
      `Added mod ${workshopId} to ${iniPath}${addedMapFolders.length > 0 ? ` with map folders: ${addedMapFolders.join(", ")}` : ""}`,
    );

    res.json({
      success: true,
      message: detectedModId
        ? `Mod added to server configuration${addedMapFolders.length > 0 ? ` with map folders: ${addedMapFolders.join(", ")}` : ""}`
        : "Workshop ID added (mod will be downloaded on server start)",
      workshopId,
      modId: detectedModId || null,
      autoDetected: !modId && !!detectedModId,
      detectionSource: detectedModId ? detectionSource : null,
      // Same field name/shape as /sync-mod-ids' own `alternatives` entry --
      // other mod ids this workshop item declared that were NOT auto-
      // enabled, so a caller can tell "this workshop item only ever had
      // one mod" apart from "it had more, and we only turned one on."
      alternativeModIds,
      totalWorkshopItems: result.totalWorkshopItems,
      mapFoldersAdded: addedMapFolders,
      note: detectedModId
        ? undefined
        : 'Mod ID could not be auto-detected. You may need to add it manually or use "Sync Mod IDs" after the mod is downloaded.',
      ...(result.backupWarning ? { backupWarning: result.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to add mod to ini: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// The first id= after the description's first [code], when a [/code] follows
// it: what /\[code\][\s\S]*?id\s*=\s*([^\s\[\]]+)[\s\S]*?\[\/code\]/i
// matched, found in one pass. That regex retried every [code] against every
// id= and every later position (cubic: a 16,000-character Workshop
// description took 2.7 s). A later [code] can only find the same id= or a
// later one, and the value stops at "[", so this is the same answer.
function matchCodeBlockId(text) {
  const open = /\[code\]/i.exec(text);
  if (!open) return null;
  const idPattern = /id\s*=\s*([^\s[\]]+)/gi;
  idPattern.lastIndex = open.index + open[0].length;
  const idMatch = idPattern.exec(text);
  if (!idMatch) return null;
  const close = /\[\/code\]/gi;
  close.lastIndex = idMatch.index + idMatch[0].length;
  return close.test(text) ? idMatch : null;
}

export function extractWorkshopModId(description, title) {
  const patterns = [
    /Mod\s*ID\s*[:=]\s*([^\n\r\[\]<>]+)/i,
    /\bid\s*=\s*([^\n\r\[\]<>]+)/i,
    /\bMod\s*:\s*([^\n\r\[\]<>]+)/i,
    matchCodeBlockId,
    /IDs\s*[:=]\s*([^\n\r\[\]<>]+)/i,
  ];

  const text = String(description || "");
  for (const pattern of patterns) {
    const match = typeof pattern === "function" ? pattern(text) : text.match(pattern);
    if (!match) continue;
    const candidate = match[1].trim();
    if (/^[A-Za-z0-9_-]+$/.test(candidate) && candidate.length > 0) {
      return candidate;
    }
  }

  const potentialId = String(title || "").trim();
  return /^[A-Za-z0-9_-]{4,29}$/.test(potentialId) ? potentialId : null;
}

// Helper function to fetch mod ID from Steam Workshop page description
async function fetchModIdFromWorkshop(workshopId) {
  try {
    // First, get the mod description from Steam API
    const fetchAbort = new AbortController();
    const fetchTimer = setTimeout(() => fetchAbort.abort(), 15000);
    let response;
    try {
      response = await fetch(
        "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            itemcount: "1",
            "publishedfileids[0]": workshopId,
          }),
          signal: fetchAbort.signal,
        },
      );
    } finally {
      clearTimeout(fetchTimer);
    }

    if (!response.ok) {
      log.warn(
        `Steam API returned ${response.status} for workshop ${workshopId}`,
      );
      return null;
    }

    const data = await response.json();
    const modInfo = data.response?.publishedfiledetails?.[0];

    if (!modInfo || modInfo.result !== 1) {
      log.warn(`Mod not found for workshop ${workshopId}`);
      return null;
    }

    const description = modInfo.description || "";
    const title = modInfo.title || "";
    const detectedId = extractWorkshopModId(description, title);
    if (detectedId) {
      log.info(`Found Mod ID from Steam Workshop metadata: ${detectedId}`);
      return detectedId;
    }

    log.warn(
      `Could not extract Mod ID from workshop ${workshopId} description. Title: "${title}"`,
    );
    return null;
  } catch (error) {
    log.error(
      `Error fetching mod ID from workshop ${workshopId}: ${error.message}`,
    );
    return null;
  }
}

// Which mod ids should adding a workshop item enable? One answer for POST
// /add-to-ini, POST /add-mod-advanced and the bulk POST /add-to-ini-bulk.
//   discover "none"  -- exactly `explicitModIds`, nothing looked up
//            "first" -- the id the game loads from the item's first mod folder;
//                       the other mods of the item come back as
//                       `alternativeModIds` (not enabled unasked)
//            "all"   -- every mod of the item, plus any explicit ids
// An item that is not downloaded yet has no mod.info on disk, so when nothing
// was found and no id was given the Steam Workshop page is asked (unless
// `allowSteam` is false). No id at all comes back as `modIds: []`: the item can
// then only be added to WorkshopItems=, and callers must say so.
async function resolveModIdsForAddition({
  workshopId,
  explicitModIds = [],
  discover,
  serverPath,
  allowSteam = true,
}) {
  let modIds = [...explicitModIds];
  let alternativeModIds = [];
  let detectionSource = modIds.length > 0 ? "provided" : null;

  const found =
    discover !== "none" && serverPath
      ? findAllModIdsFromWorkshop(workshopId, serverPath)
      : [];
  if (found.length > 0) {
    if (discover === "all") {
      for (const id of found) if (!modIds.includes(id)) modIds.push(id);
    } else if (modIds.length === 0) {
      modIds = [found[0]];
      alternativeModIds = found.slice(1);
    }
    detectionSource ??= "local-files";
    log.info(
      `Auto-detected mod ID from local files: ${found.join(", ")} for workshop ${workshopId}` +
        (alternativeModIds.length > 0
          ? ` (${alternativeModIds.length} additional mod id(s) in this workshop item not auto-enabled: ${alternativeModIds.join(", ")})`
          : ""),
    );
  }

  // Not downloaded (or no mod.info yet): the Steam Workshop page description
  if (modIds.length === 0 && discover !== "none" && allowSteam) {
    const steamModId = await fetchModIdFromWorkshop(workshopId);
    if (steamModId) {
      modIds = [steamModId];
      detectionSource = "steam-workshop";
      log.info(
        `Auto-detected mod ID from Steam Workshop: ${steamModId} for workshop ${workshopId}`,
      );
    }
  }

  return { modIds, alternativeModIds, detectionSource };
}

// What an addition amounted to, for the response (and the client's toast):
//   "added"              at least one mod ID was written to Mods=
//   "already-configured" nothing needed changing (or only the workshop id was new)
//   "workshop-only"      the item was added to WorkshopItems= but no mod ID is
//                        known, so nothing was enabled -- it will not load
function additionStatus(resolvedModIdCount, applied) {
  if (applied.addedModIds.length > 0) return "added";
  if (resolvedModIdCount === 0 && !applied.workshopAlreadyExisted) {
    return "workshop-only";
  }
  return "already-configured";
}

function additionMessage(status, applied) {
  if (status === "added") {
    return `Added ${applied.addedModIds.length} mod ID(s): ${applied.addedModIds.join(", ")}`;
  }
  if (status === "workshop-only") {
    return "Workshop ID added to WorkshopItems only: its mod ID is not known yet, so nothing was enabled. Start the server to download it, then use Sync Mod IDs.";
  }
  return applied.workshopAlreadyExisted
    ? "Already configured (the workshop item and its mod IDs were already in the server config)"
    : "Workshop ID added (mod IDs were already configured)";
}

export function scoreWorkshopDependencyMatch(query, modId, modName) {
  const normalize = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[\s_.\-+\[\]()]/g, "");
  const queryLower = String(query || "")
    .toLowerCase()
    .trim();
  const idLower = String(modId || "").toLowerCase();
  const nameLower = String(modName || "").toLowerCase();
  const queryNormalized = normalize(query);
  const idNormalized = normalize(modId);
  const nameNormalized = normalize(modName);

  if (!queryLower || !idLower) return { score: 0, matchType: "none" };
  if (idLower === queryLower) return { score: 1200, matchType: "exact-id" };
  if (idNormalized === queryNormalized)
    return { score: 1100, matchType: "exact-id" };
  if (nameLower === queryLower || nameNormalized === queryNormalized)
    return { score: 950, matchType: "exact-name" };
  if (
    idLower.startsWith(queryLower) ||
    idNormalized.startsWith(queryNormalized)
  )
    return { score: 650, matchType: "id-prefix" };
  if (
    nameLower.startsWith(queryLower) ||
    nameNormalized.startsWith(queryNormalized)
  )
    return { score: 550, matchType: "name-prefix" };
  if (idLower.includes(queryLower) || idNormalized.includes(queryNormalized))
    return { score: 350, matchType: "id-contains" };
  if (
    nameLower.includes(queryLower) ||
    nameNormalized.includes(queryNormalized)
  )
    return { score: 250, matchType: "name-contains" };
  return { score: 0, matchType: "none" };
}

// Return available Mod IDs inside a downloaded Workshop Item
router.post("/inspect-workshop-item", async (req, res) => {
  try {
    const { workshopId } = req.body;
    if (!workshopId) {
      return res.status(400).json({
        error: "Workshop ID is required",
        code: ErrorCode.MODS_WORKSHOP_ID_REQUIRED,
      });
    }

    // Validate workshopId is numeric to prevent path traversal
    if (!/^\d{1,15}$/.test(String(workshopId))) {
      return res.status(400).json({
        error: "Invalid Workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_CAP,
      });
    }

    const serverPath = await getServerPath();
    if (!serverPath) {
      return res.status(400).json({
        error: "Server path not configured",
        code: ErrorCode.MODS_SERVER_PATH_NOT_CONFIGURED_NOPERIOD,
      });
    }

    const mods = getModDetailsFromWorkshop(workshopId, serverPath);

    // Also try to find map folders
    const mapFolders = findMapFoldersFromWorkshop(workshopId, serverPath);

    res.json({
      workshopId,
      found: mods.length > 0 || mapFolders.length > 0,
      mods,
      mapFolders,
      count: mods.length,
    });
  } catch (error) {
    log.error(`Failed to inspect workshop item: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Remove a single mod from server .ini file
router.post("/remove-from-ini", async (req, res) => {
  try {
    const { workshopId, modId, modIds: clientModIds } = req.body;

    if (!workshopId) {
      return res.status(400).json({
        error: "Workshop ID is required",
        code: ErrorCode.MODS_WORKSHOP_ID_REQUIRED,
      });
    }

    // Validate workshopId is numeric to prevent path traversal
    if (!/^\d{1,15}$/.test(String(workshopId))) {
      return res.status(400).json({
        error: "Invalid Workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_CAP,
      });
    }

    const knownModIds = Array.isArray(clientModIds)
      ? clientModIds.slice(0, 50)
      : [];

    const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Server config path not set",
          code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
        }),
      );
    }

    // Sanitize serverName
    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
      });
    }

    // Atomically read-modify-write inside the lock
    const lockResult = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);

      // Get current workshop items. Widened to tolerate whitespace around
      // "=" (hunt-wave13, 3d1921ad) -- this match doubles as the
      // exists-check for the replace below (no whitespace tolerance here
      // previously meant a "WorkshopItems = ..." line was read as EMPTY,
      // and the replace two guards down silently no-opped instead of
      // actually removing the workshop ID).
      const workshopMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
      let workshopIds = splitIniList(workshopMatch?.[1]);

      // Get current mod IDs
      const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
      let modIds = splitModIdList(modsMatch?.[1]);
      const modIdsBefore = [...modIds];

      // Remove from workshop items
      workshopIds = workshopIds.filter((id) => id !== String(workshopId));

      // Determine which mod IDs to remove (a workshop item can have multiple mods)
      let removedModIds = [];
      let ownedModIds = [];

      if (serverPath) {
        // Find ALL mod IDs for this workshop item
        const allModIds = findAllModIdsFromWorkshop(
          String(workshopId),
          serverPath,
        );
        ownedModIds = allModIds;
        if (allModIds.length > 0) {
          for (const mid of allModIds) {
            if (modIds.includes(mid)) {
              modIds = modIds.filter((id) => id !== mid);
              removedModIds.push(mid);
            }
          }
          log.info(
            `Found mod IDs for workshop ${workshopId}: ${allModIds.join(", ")}`,
          );
        }
      }

      // Also remove explicitly provided modId if server-side workshop data
      // verifies that it belongs to this workshop item.
      if (
        modId &&
        ownedModIds.includes(modId) &&
        !removedModIds.includes(modId) &&
        modIds.includes(modId)
      ) {
        modIds = modIds.filter((id) => id !== modId);
        removedModIds.push(modId);
      }

      // Fallback: if no mods removed via filesystem, try single lookup
      if (removedModIds.length === 0 && !modId && serverPath) {
        const fallbackModId = findModIdFromWorkshop(
          String(workshopId),
          serverPath,
        );
        if (fallbackModId && modIds.includes(fallbackModId)) {
          modIds = modIds.filter((id) => id !== fallbackModId);
          removedModIds.push(fallbackModId);
        }
      }

      // Last resort: use client-known IDs only when they are also verified
      // against server-side workshop data for this exact Workshop item.
      const verifiedKnownModIds = filterOwnedClientModIds(
        knownModIds,
        ownedModIds,
      );
      if (removedModIds.length === 0 && verifiedKnownModIds.length > 0) {
        for (const mid of verifiedKnownModIds) {
          if (modIds.includes(mid) && !removedModIds.includes(mid)) {
            modIds = modIds.filter((id) => id !== mid);
            removedModIds.push(mid);
          }
        }
        if (removedModIds.length > 0) {
          log.info(
            `Fallback: removed ${removedModIds.join(", ")} for workshop ${workshopId} via client-provided mod IDs`,
          );
        }
      }

      // A mod id an item still in WorkshopItems= ships too (a re-upload
      // under a new Workshop ID) stays in Mods=.
      const stillShipped = shippedByListedItems({ modIds: removedModIds, listedWorkshopIds: workshopIds, serverPath }).mods;
      if (stillShipped.size > 0) {
        removedModIds = removedModIds.filter((id) => !stillShipped.has(id));
        modIds = modIdsBefore.filter((id) => !removedModIds.includes(id));
        log.info(`Kept ${[...stillShipped].join(", ")} in Mods=: another listed Workshop item ships it too`);
      }

      // Check if this mod has map folders and remove them from Map=
      let removedMapFolders = [];
      if (serverPath) {
        const modMapFolders = findMapFoldersFromWorkshop(
          String(workshopId),
          serverPath,
        );
        if (modMapFolders.length > 0) {
          const mapMatch = content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m);
          let currentMaps = splitIniList(mapMatch?.[1]);
          const mapsStillShipped = shippedByListedItems({
            mapFolders: modMapFolders.filter((folder) => currentMaps.includes(folder)),
            listedWorkshopIds: workshopIds,
            serverPath,
          }).maps;

          for (const folder of modMapFolders) {
            if (currentMaps.includes(folder) && !mapsStillShipped.has(folder)) {
              currentMaps = currentMaps.filter((m) => m !== folder);
              removedMapFolders.push(folder);
              log.info(
                `Removed map folder: ${folder} for workshop ${workshopId}`,
              );
            }
          }

          if (currentMaps.length === 0) {
            currentMaps = ["Muldraugh, KY"];
          }

          const newMapList = sanitizeIniList(currentMaps);
          if (mapMatch) {
            content = content.replace(/^[ \t]*Map[ \t]*=.*/m, () => `Map=${newMapList}`);
          } else {
            content += `\nMap=${newMapList}`;
          }
        }
      }

      // Update WorkshopItems= -- reuse workshopMatch/modsMatch (computed
      // above) instead of a separate .includes(), same fix as this file's
      // first ini-write site.
      if (workshopMatch) {
        content = content.replace(
          /^[ \t]*WorkshopItems[ \t]*=.*/m,
          () => `WorkshopItems=${sanitizeIniList(workshopIds)}`,
        );
      }

      // Update Mods=
      if (modsMatch) {
        content = content.replace(
          /^[ \t]*Mods[ \t]*=.*/m,
          () =>
            `Mods=${sanitizeModIdListWithDiskBypass(modIds, workshopIds, serverPath, modIdsBefore)}`,
        );
      }

      const backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
      return {
        removedModIds,
        removedMapFolders,
        remainingWorkshopItems: workshopIds.length,
        remainingMods: modIds.length,
        backupWarning,
      };
    });

    log.info(
      `Removed workshop ID ${workshopId}${lockResult.removedModIds.length > 0 ? ` and mod IDs ${lockResult.removedModIds.join(", ")}` : ""}${lockResult.removedMapFolders.length > 0 ? ` and map folders: ${lockResult.removedMapFolders.join(", ")}` : ""} from ${iniPath}`,
    );

    res.json({
      success: true,
      message:
        lockResult.removedModIds.length > 0
          ? `Mod removed from server configuration (WorkshopItems, Mods${lockResult.removedMapFolders.length > 0 ? ", and Map" : ""})`
          : "Workshop ID removed. Note: Could not find matching mod ID - you may need to manually remove it from Mods= in the .ini file.",
      workshopId,
      modIdsRemoved: lockResult.removedModIds,
      mapFoldersRemoved: lockResult.removedMapFolders,
      remainingWorkshopItems: lockResult.remainingWorkshopItems,
      remainingMods: lockResult.remainingMods,
      ...(lockResult.backupWarning ? { backupWarning: lockResult.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to remove mod from ini: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Batch remove multiple mods from tracking AND server .ini in a single operation
// Avoids the N×2 individual API call problem for bulk removal
router.post("/batch-remove", async (req, res) => {
  try {
    const { workshopIds } = req.body;

    if (!Array.isArray(workshopIds) || workshopIds.length === 0) {
      return res.status(400).json({
        error: "workshopIds array is required",
        code: ErrorCode.MODS_BATCH_REMOVE_WORKSHOP_IDS_ARRAY_REQUIRED,
      });
    }

    // Cap batch size to prevent abuse
    if (workshopIds.length > 500) {
      return res.status(400).json({
        error: "Maximum 500 mods per batch",
        code: ErrorCode.MODS_BATCH_REMOVE_TOO_MANY,
      });
    }

    // Validate all IDs upfront
    const validIds = [];
    for (const id of workshopIds) {
      const str = String(id);
      if (/^\d{1,15}$/.test(str)) validIds.push(str);
    }

    if (validIds.length === 0) {
      return res.status(400).json({
        error: "No valid workshop IDs provided",
        code: ErrorCode.MODS_NO_VALID_WORKSHOP_IDS,
      });
    }

    // Step 1: Get mod names before removal (for ignore list)
    const trackedMods = await getTrackedMods();
    const modNameMap = new Map();
    for (const mod of trackedMods) {
      modNameMap.set(mod.workshop_id, mod.name);
    }

    // Step 2: Prepare database removal results. Apply these only after the
    // INI edit succeeds so a filesystem error cannot leave tracking removed
    // while WorkshopItems= still loads the mod.
    const dbResults = { removed: 0, failed: 0 };

    // Step 2: Remove all from INI in a single locked write
    const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();

    let iniResult = { removed: 0, skipped: 0 };
    // Tracks whether the INI edit block below actually ran. Ignore-listing
    // must never happen unless this is true, or a mod can be marked
    // "removed" while still silently loading from the live Mods=/
    // WorkshopItems= lines (root cause of mods getting stuck in the ignore
    // list without ever leaving the server config).
    let iniEditApplied = false;

    if (serverConfigPath && serverName) {
      const sanitizedServerName = path.basename(serverName);
      if (
        sanitizedServerName &&
        sanitizedServerName === serverName &&
        !serverName.includes("..")
      ) {
        const iniPath = path.join(
          serverConfigPath,
          `${sanitizedServerName}.ini`,
        );

        if (fs.existsSync(iniPath)) {
          iniEditApplied = true;
          iniResult = await withIniLock(iniPath, async () => {
            let content = readTextFile(iniPath);
            const removeSet = new Set(validIds);

            // Parse current lists. Widened to tolerate whitespace around
            // "=" (hunt-wave13, 783672aa) -- each match doubles as the
            // exists-check for its replace below.
            const workshopMatch = content.match(
              /^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m,
            );
            let iniWorkshopIds =
              splitIniList(workshopMatch?.[1]);

            const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
            let iniModIds = splitModIdList(modsMatch?.[1]);
            const iniModIdsBefore = [...iniModIds];

            const mapMatch = content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m);
            let iniMaps = splitIniList(mapMatch?.[1]);

            // Collect all mod IDs and map folders to remove
            const modIdsToRemove = new Set();
            const mapFoldersToRemove = new Set();

            for (const wsId of validIds) {
              if (serverPath) {
                const allModIds = findAllModIdsFromWorkshop(wsId, serverPath);
                for (const mid of allModIds) modIdsToRemove.add(mid);

                const mapFolders = findMapFoldersFromWorkshop(wsId, serverPath);
                for (const folder of mapFolders) mapFoldersToRemove.add(folder);
              }
            }

            // Filter lists
            const origWsCount = iniWorkshopIds.length;
            const origModCount = iniModIds.length;
            iniWorkshopIds = iniWorkshopIds.filter((id) => !removeSet.has(id));
            // What an item still listed ships too stays (a re-upload under
            // a new Workshop ID keeps the mod id; removing the old,
            // deactivated item must not unload it).
            const stillShipped = shippedByListedItems({
              modIds: [...modIdsToRemove].filter((id) => iniModIds.includes(id)),
              mapFolders: [...mapFoldersToRemove].filter((folder) => iniMaps.includes(folder)),
              listedWorkshopIds: iniWorkshopIds,
              serverPath,
            });
            for (const id of stillShipped.mods) modIdsToRemove.delete(id);
            for (const folder of stillShipped.maps) mapFoldersToRemove.delete(folder);
            iniModIds = iniModIds.filter((id) => !modIdsToRemove.has(id));
            iniMaps = iniMaps.filter((m) => !mapFoldersToRemove.has(m));

            if (iniMaps.length === 0) iniMaps = ["Muldraugh, KY"];

            // Write back -- reuse workshopMatch/modsMatch/mapMatch (computed
            // above) instead of a separate .includes(), same fix as this
            // file's first ini-write site.
            if (workshopMatch) {
              content = content.replace(
                /^[ \t]*WorkshopItems[ \t]*=.*/m,
                () => `WorkshopItems=${sanitizeIniList(iniWorkshopIds)}`,
              );
            }
            if (modsMatch) {
              content = content.replace(
                /^[ \t]*Mods[ \t]*=.*/m,
                () =>
                  `Mods=${sanitizeModIdListWithDiskBypass(iniModIds, iniWorkshopIds, serverPath, iniModIdsBefore)}`,
              );
            }
            if (mapMatch) {
              content = content.replace(
                /^[ \t]*Map[ \t]*=.*/m,
                () => `Map=${sanitizeIniList(iniMaps)}`,
              );
            }

            const backupWarning = backupWarningFor(
              await writeIniWithBackup(iniPath, content),
            );

            const wsRemoved = origWsCount - iniWorkshopIds.length;
            const modRemoved = origModCount - iniModIds.length;
            log.info(
              `Batch INI removal: removed ${wsRemoved} workshop IDs, ${modRemoved} mod IDs, ${mapFoldersToRemove.size} map folders`,
            );

            return {
              removed: wsRemoved,
              skipped: validIds.length - wsRemoved,
              backupWarning,
            };
          });
        }
      }
    }

    // Step 3: Remove all from database and add to ignore list. This happens
    // after the INI operation so a locked-write failure aborts before any
    // tracking state is changed. Gated on iniEditApplied: if the INI edit
    // never ran (bad config path, missing ini file, etc.), the mod is still
    // live in Mods=/WorkshopItems= and must NOT be ignore-listed as if it
    // had been removed.
    if (iniEditApplied) {
      for (const wsId of validIds) {
        try {
          await removeTrackedMod(wsId);
          await addIgnoredMod(wsId, modNameMap.get(wsId) || null);
          dbResults.removed++;
        } catch (e) {
          dbResults.failed++;
          log.debug(`DB removal failed for ${wsId}: ${e.message}`);
        }
      }
    } else {
      log.error(
        `Batch removal aborted before any INI edit (serverConfigPath=${serverConfigPath}, serverName=${serverName}, validIds=${validIds.join(",")}) — nothing was removed or ignore-listed`,
      );
    }

    // Mirror removals to the Workshop collection when auto-sync is enabled.
    if (iniEditApplied && validIds.length > 0) {
      (async () => {
        for (const wsId of validIds) {
          try {
            await autoSyncCollection("remove", wsId);
          } catch {
            /* logged inside */
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      })().catch(() => {});
    }

    res.json({
      success: iniEditApplied,
      total: validIds.length,
      dbRemoved: dbResults.removed,
      dbFailed: dbResults.failed,
      iniRemoved: iniResult.removed,
      iniSkipped: iniResult.skipped,
      ...(iniResult.backupWarning ? { backupWarning: iniResult.backupWarning } : {}),
      // PT3 (verifier round 1): a refused folder says why, as above.
      ...(iniEditApplied
        ? {}
        : withConfigRefusal(configRefusal, {
            error:
              "Server config file was not found or not accessible — no mods were removed.",
            code: ErrorCode.MODS_BATCH_REMOVE_INI_NOT_ACCESSIBLE,
          })),
    });
  } catch (error) {
    log.error(`Batch removal failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Repair Map= entries - validates each entry has actual map data on disk and removes invalid ones
router.post("/repair-map-entries", async (req, res) => {
  try {
    const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();

    if (!serverConfigPath || !serverPath || !serverName) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Server path not configured.",
          code: ErrorCode.MODS_SERVER_PATH_NOT_CONFIGURED,
        }),
      );
    }

    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found.",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND_PERIOD,
      });
    }

    // Atomically read-modify-write inside the lock
    const lockResult = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);
      // Widened to tolerate whitespace around "=" (hunt-wave13, 783672aa) --
      // mapMatch is the guard for the replace below.
      const mapMatch = content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m);
      const currentMaps = splitIniList(mapMatch?.[1]);

      // Same widening -- this site was missed when hunt-wave13 landed. A
      // hand-edited "WorkshopItems = ..." line previously read as zero
      // workshop items, so this route would see no valid map folders from
      // any configured mod and strip every non-vanilla Map= entry as
      // "invalid", not just repair genuinely-stale ones.
      const workshopMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
      const workshopIds = splitIniList(workshopMatch?.[1]);

      const validMapFolders = new Set();
      for (const wsId of workshopIds) {
        const folders = findMapFoldersFromWorkshop(wsId, serverPath);
        for (const f of folders) validMapFolders.add(f);
      }
      validMapFolders.add("Muldraugh, KY");

      const validEntries = [];
      const removedEntries = [];
      for (const entry of currentMaps) {
        if (
          validMapFolders.has(entry) ||
          entry.includes("Muldraugh") ||
          entry.includes("West Point") ||
          entry.includes("Riverside") ||
          entry.includes("Rosewood") ||
          entry.includes("March Ridge") ||
          entry.includes("Louisville")
        ) {
          validEntries.push(entry);
        } else {
          removedEntries.push(entry);
        }
      }

      const addedEntries = [];
      for (const folder of validMapFolders) {
        if (folder === "Muldraugh, KY") continue;
        if (!validEntries.includes(folder)) {
          const mulIdx = validEntries.findIndex((e) => e.includes("Muldraugh"));
          if (mulIdx >= 0) {
            validEntries.splice(mulIdx, 0, folder);
          } else {
            validEntries.push(folder);
          }
          addedEntries.push(folder);
        }
      }

      if (!validEntries.some((e) => e.includes("Muldraugh"))) {
        validEntries.push("Muldraugh, KY");
      }

      let backupWarning = null;
      if (removedEntries.length > 0 || addedEntries.length > 0) {
        const newMapLine = sanitizeIniList(validEntries);
        // Reuse mapMatch (computed above), same fix as this file's first
        // ini-write site.
        if (mapMatch) {
          content = content.replace(/^[ \t]*Map[ \t]*=.*/m, () => `Map=${newMapLine}`);
        }
        backupWarning = backupWarningFor(
          await writeIniWithBackup(iniPath, content),
        );
        log.info(
          `Repaired Map= entries: removed ${removedEntries.length} invalid, added ${addedEntries.length} missing`,
        );
        if (removedEntries.length > 0)
          log.info(`  Removed: ${removedEntries.join(", ")}`);
        if (addedEntries.length > 0)
          log.info(`  Added: ${addedEntries.join(", ")}`);
      }

      return { removedEntries, addedEntries, validEntries, backupWarning };
    });

    const parts = [];
    if (lockResult.removedEntries.length > 0)
      parts.push(
        `Removed ${lockResult.removedEntries.length} invalid: ${lockResult.removedEntries.join(", ")}`,
      );
    if (lockResult.addedEntries.length > 0)
      parts.push(
        `Added ${lockResult.addedEntries.length} missing: ${lockResult.addedEntries.join(", ")}`,
      );

    res.json({
      success: true,
      removed: lockResult.removedEntries,
      added: lockResult.addedEntries,
      remaining: lockResult.validEntries,
      message:
        parts.length > 0
          ? parts.join(". ")
          : "All map entries are valid. No changes needed.",
      ...(lockResult.backupWarning ? { backupWarning: lockResult.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to repair map entries: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Deduplicate mod IDs in the Mods= line — removes exact duplicates, keeps one of each
router.post("/deduplicate-mod-ids", async (req, res) => {
  try {
    const { serverConfigPath, serverName, configRefusal } = await getActiveServerPaths();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Server path not configured.",
          code: ErrorCode.MODS_SERVER_PATH_NOT_CONFIGURED,
        }),
      );
    }

    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found.",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND_PERIOD,
      });
    }

    // Atomically read-modify-write inside the lock
    const lockResult = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);
      // Widened to tolerate whitespace around "=" (same fix as this file's
      // other ini-write sites, hunt-wave13, 3d1921ad/783672aa) -- this site
      // was missed when that fix landed. modsMatch doubles as the exists-
      // check for the replace below: a hand-edited "Mods = foo;bar" line
      // previously matched nothing here, so currentMods came back empty and
      // this route reported "No duplicate mod IDs found" (a false clean
      // bill of health) instead of ever reading the real, possibly-
      // duplicated list.
      const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
      const currentMods = splitModIdList(modsMatch?.[1]);

      const seen = new Map();
      const deduped = [];
      const removed = [];
      for (const modId of currentMods) {
        const count = (seen.get(modId) || 0) + 1;
        seen.set(modId, count);
        if (count === 1) {
          deduped.push(modId);
        } else {
          removed.push(modId);
        }
      }

      if (removed.length === 0) {
        return { noChanges: true, deduped };
      }

      // Nothing is added here, so every entry is one the line already had.
      content = content.replace(
        /^[ \t]*Mods[ \t]*=.*/m,
        () => `Mods=${sanitizeModIdListWithDiskBypass(deduped, [], null, currentMods)}`,
      );
      const backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
      return { noChanges: false, removed, deduped, backupWarning };
    });

    if (lockResult.noChanges) {
      return res.json({
        success: true,
        removed: [],
        remaining: lockResult.deduped.length,
        message: "No duplicate mod IDs found. No changes needed.",
      });
    }

    const uniqueDupes = [...new Set(lockResult.removed)];
    log.info(
      `Deduplicated Mods= line: removed ${lockResult.removed.length} duplicate entries (${uniqueDupes.length} unique mod IDs: ${uniqueDupes.join(", ")})`,
    );

    res.json({
      success: true,
      removed: uniqueDupes,
      removedCount: lockResult.removed.length,
      uniqueCount: uniqueDupes.length,
      remaining: lockResult.deduped.length,
      message: `Removed ${lockResult.removed.length} duplicate mod ID${lockResult.removed.length !== 1 ? "s" : ""}: ${uniqueDupes.join(", ")}`,
      ...(lockResult.backupWarning ? { backupWarning: lockResult.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to deduplicate mod IDs: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ─── Missing Dependencies: Add a resolved dependency to INI ─────────────────
router.post("/add-missing-dep", async (req, res) => {
  try {
    const { workshopId, modId } = req.body;
    if (!workshopId || !/^\d{1,15}$/.test(String(workshopId))) {
      return res.status(400).json({
        error: "Valid Workshop ID is required",
        code: ErrorCode.MODS_ADD_MISSING_DEP_WORKSHOP_ID_REQUIRED,
      });
    }
    // Sanitize modId — only allow safe characters
    const modIdStr = modId ? String(modId) : null;
    if (modIdStr && !/^[\w.\-]{1,200}$/.test(modIdStr)) {
      return res.status(400).json({
        error: "Invalid mod ID format",
        code: ErrorCode.MODS_INVALID_MOD_ID_FORMAT,
      });
    }

    const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();
    if (!serverConfigPath || !serverName)
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Server path not configured.",
          code: ErrorCode.MODS_SERVER_PATH_NOT_CONFIGURED,
        }),
      );

    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }
    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
      });
    }

    // Do async detection work BEFORE taking the lock
    const wsIdStr = String(workshopId);
    let resolvedModId = modIdStr;
    if (!resolvedModId && serverPath) {
      resolvedModId = findModIdFromWorkshop(wsIdStr, serverPath);
    }
    if (!resolvedModId) {
      resolvedModId = await fetchModIdFromWorkshop(wsIdStr);
    }

    // Detect map folders (sync disk reads, no INI dependency)
    const mapFolders = serverPath
      ? findMapFoldersFromWorkshop(wsIdStr, serverPath)
      : [];

    // Atomically read-modify-write inside the lock
    const lockResult = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);

      // Add to WorkshopItems if not present. Widened to tolerate whitespace
      // around "=" (hunt-wave13, 783672aa) -- wsMatch is the guard below.
      const wsMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
      const currentWs = splitIniList(wsMatch?.[1]);
      let wsAdded = false;
      if (!currentWs.includes(wsIdStr)) {
        currentWs.push(wsIdStr);
        // sanitizeIniList, not a bare join(";") -- inert today only because
        // wsIdStr is already digit-only by the time it gets here (workshopId
        // is regex-checked earlier in this handler), but every other
        // WorkshopItems=/Mods= write site in this file goes through
        // sanitizeIniList/sanitizeModIdList regardless of whether its own
        // input happens to be pre-constrained, and this one should match
        // (2026-08-26 bug hunt finding 14) rather than rely on a guard that
        // lives in a different function than the write it protects.
        const wsLine = `WorkshopItems=${sanitizeIniList(currentWs)}`;
        // Reuse wsMatch (computed above), same fix as this file's first
        // ini-write site.
        if (wsMatch) {
          content = content.replace(/^[ \t]*WorkshopItems[ \t]*=.*/m, () => wsLine);
        } else {
          content += `\n${wsLine}`;
        }
        wsAdded = true;
      }

      // Add to Mods if we have a mod ID and it's not present
      let modIdAdded = false;
      if (resolvedModId) {
        const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
        const currentMods = splitModIdList(modsMatch?.[1]);
        if (!currentMods.includes(resolvedModId)) {
          const modsBefore = [...currentMods];
          currentMods.push(resolvedModId);
          // Entries already on the line are kept; only the added id faces the
          // numeric-workshop-ID filter (unless a mod.info on disk confirms it).
          const modsValue = sanitizeModIdListWithDiskBypass(
            currentMods,
            currentWs,
            serverPath,
            modsBefore,
          );
          // Reuse modsMatch (computed above), same fix as this file's
          // first ini-write site.
          if (modsMatch) {
            content = content.replace(
              /^[ \t]*Mods[ \t]*=.*/m,
              () => `Mods=${modsValue}`,
            );
          } else {
            content += `\nMods=${modsValue}`;
          }
          modIdAdded = true;
        }
      }

      // Auto-detect map folders
      if (mapFolders.length > 0) {
        const mapMatch = content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m);
        const currentMaps = splitIniList(mapMatch?.[1]);
        let mapsChanged = false;
        for (const f of mapFolders) {
          if (!currentMaps.includes(f)) {
            currentMaps.unshift(f);
            mapsChanged = true;
          }
        }
        if (mapsChanged) {
          // Reuse mapMatch (computed above), same fix as this file's first
          // ini-write site.
          if (mapMatch)
            content = content.replace(
              /^[ \t]*Map[ \t]*=.*/m,
              () => `Map=${sanitizeIniList(currentMaps)}`,
            );
          else content += `\nMap=${sanitizeIniList(currentMaps)}`;
        }
      }

      const backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
      return { wsAdded, modIdAdded, backupWarning };
    });

    log.info(
      `Added missing dep: workshop ${wsIdStr}, modId ${resolvedModId || "(unknown)"}`,
    );

    res.json({
      success: true,
      workshopId: wsIdStr,
      modId: resolvedModId,
      wsAdded: lockResult.wsAdded,
      modIdAdded: lockResult.modIdAdded,
      mapFolders,
      message: `Added ${resolvedModId || wsIdStr} to server config.${mapFolders.length > 0 ? ` Map folders: ${mapFolders.join(", ")}` : ""}`,
      ...(lockResult.backupWarning ? { backupWarning: lockResult.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to add missing dep: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ─── Missing Dependencies: Batch add all resolved deps ──────────────────────
router.post("/add-all-resolved-deps", async (req, res) => {
  try {
    const { deps } = req.body;
    if (!deps || !Array.isArray(deps) || deps.length === 0) {
      return res.status(400).json({
        error: "No dependencies provided",
        code: ErrorCode.MODS_ADD_ALL_DEPS_REQUIRED,
      });
    }
    if (deps.length > 200) {
      return res.status(400).json({
        error: "Too many dependencies in one request (max 200)",
        code: ErrorCode.MODS_ADD_ALL_DEPS_TOO_MANY,
      });
    }

    // Validate all workshop IDs
    for (const dep of deps) {
      if (!dep.workshopId || !/^\d{1,15}$/.test(String(dep.workshopId))) {
        const workshopId = String(dep.workshopId).substring(0, 20);
        return res.status(400).json({
          error: `Invalid Workshop ID: ${workshopId}`,
          code: ErrorCode.MODS_INVALID_WORKSHOP_ID_TEMPLATE,
          params: sanitizeErrorParams({ workshopId }),
        });
      }
    }

    const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();
    if (!serverConfigPath || !serverName) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Server config path not set",
          code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
        }),
      );
    }
    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }
    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
      });
    }

    // Pre-resolve all mod IDs BEFORE taking the lock (async ops)
    const resolvedDeps = [];
    for (const dep of deps) {
      const wsId = String(dep.workshopId);
      let modId = dep.modId || null;
      if (!modId && serverPath) modId = findModIdFromWorkshop(wsId, serverPath);
      if (!modId) {
        try {
          modId = await fetchModIdFromWorkshop(wsId);
        } catch (e) {
          log.debug(`fetchModIdFromWorkshop failed for ${wsId}: ${e.message}`);
        }
      }
      const mapFolders = serverPath
        ? findMapFoldersFromWorkshop(wsId, serverPath)
        : [];
      resolvedDeps.push({ wsId, modId, mapFolders });
    }

    // Atomically read-modify-write inside the lock
    const lockResult = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);
      // Widened to tolerate whitespace around "=" (hunt-wave13, 783672aa) --
      // each match doubles as the exists-check for its replace below.
      const wsMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
      const currentWs = new Set(splitIniList(wsMatch?.[1]));
      const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
      const currentMods = new Set(
        splitModIdList(modsMatch?.[1]),
      );
      const modsBefore = [...currentMods];
      const mapMatch = content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m);
      const currentMaps = splitIniList(mapMatch?.[1]);

      let wsAdded = 0,
        modIdsAdded = 0;
      const allMapFolders = [];
      // Per-item outcome, one entry per requested dep, same shape as the
      // single-add sibling POST /add-missing-dep already returns
      // (workshopId, modId, wsAdded, modIdAdded -- see client/src/lib/
      // api.ts's addMissingDep) -- the aggregate wsAdded/modIdsAdded counts
      // above can't tell a caller WHICH item (if any) failed to resolve a
      // mod ID, only how many succeeded overall. A caller should treat
      // `modId === null` as failure: the workshop-ID side always ends up
      // present in WorkshopItems= (either just-added or already there), so
      // the only real per-item failure mode is modId staying null when
      // fetchModIdFromWorkshop()'s best-effort description scrape can't
      // find one -- without this, a caller that only checks the aggregate
      // counts (or just "did the request throw") can't tell that one dep
      // out of a batch was left subscribed but not enabled.
      const itemResults = [];

      for (const { wsId, modId, mapFolders } of resolvedDeps) {
        let itemWsAdded = false;
        let itemModIdAdded = false;
        if (!currentWs.has(wsId)) {
          currentWs.add(wsId);
          wsAdded++;
          itemWsAdded = true;
        }
        if (modId && !currentMods.has(modId)) {
          currentMods.add(modId);
          modIdsAdded++;
          itemModIdAdded = true;
        }
        itemResults.push({
          workshopId: wsId,
          modId,
          wsAdded: itemWsAdded,
          modIdAdded: itemModIdAdded,
        });
        for (const f of mapFolders) {
          if (!currentMaps.includes(f)) {
            currentMaps.unshift(f);
            allMapFolders.push(f);
          }
        }
      }

      const wsLine = Array.from(currentWs).join(";");
      // Entries already on the line are kept; only the added ids face the
      // numeric-workshop-ID filter (unless a mod.info on disk confirms them).
      const modsLine = sanitizeModIdListWithDiskBypass(
        Array.from(currentMods),
        Array.from(currentWs),
        serverPath,
        modsBefore,
      );
      const mapLine = sanitizeIniList(currentMaps);

      // Reuse wsMatch/modsMatch/mapMatch (computed above) instead of a
      // separate .includes(), same fix as this file's first ini-write site.
      if (wsMatch)
        content = content.replace(
          /^[ \t]*WorkshopItems[ \t]*=.*/m,
          () => `WorkshopItems=${wsLine}`,
        );
      else content += `\nWorkshopItems=${wsLine}`;
      if (modsMatch)
        content = content.replace(/^[ \t]*Mods[ \t]*=.*/m, () => `Mods=${modsLine}`);
      else content += `\nMods=${modsLine}`;
      if (allMapFolders.length > 0) {
        if (mapMatch)
          content = content.replace(/^[ \t]*Map[ \t]*=.*/m, () => `Map=${mapLine}`);
        else content += `\nMap=${mapLine}`;
      }

      const backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
      return { wsAdded, modIdsAdded, allMapFolders, backupWarning, itemResults };
    });

    const unresolvedCount = lockResult.itemResults.filter((r) => r.modId === null).length;
    log.info(
      `Batch added ${deps.length} missing deps: ${lockResult.wsAdded} ws IDs, ${lockResult.modIdsAdded} mod IDs` +
        (unresolvedCount > 0 ? `, ${unresolvedCount} mod ID(s) unresolved` : ""),
    );

    res.json({
      success: true,
      total: deps.length,
      wsAdded: lockResult.wsAdded,
      modIdsAdded: lockResult.modIdsAdded,
      mapFolders: lockResult.allMapFolders,
      // Per-item outcome -- see itemResults' own comment above. Callers
      // must check each entry's `modId` for null to decide per-row success;
      // the aggregate counts above and an absence of a thrown error are not
      // sufficient (a dep whose mod ID never resolves still leaves
      // success:true here, by design, since the other requested deps did
      // apply and a hard failure would discard those too).
      results: lockResult.itemResults,
      message: `Added ${deps.length} dependencies to server config.`,
      ...(lockResult.backupWarning ? { backupWarning: lockResult.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to batch add deps: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ─── Missing Dependencies: Search Steam Workshop for a mod by name ──────────
router.post("/search-workshop-mods", async (req, res) => {
  try {
    const { query, parentName, parentWorkshopId, parentModId } = req.body;
    if (!query || typeof query !== "string" || query.trim().length < 2) {
      return res
        .status(400)
        .json({
          error: "Query must be at least 2 characters",
          code: ErrorCode.MODS_SEARCH_QUERY_TOO_SHORT,
        });
    }

    const trimmed = query.trim();
    if (trimmed.length > 100) {
      log.debug(`Search query truncated from ${trimmed.length} to 100 chars`);
    }
    const searchTerm = trimmed.substring(0, 100);
    const parentNameClean =
      typeof parentName === "string" ? parentName.trim().substring(0, 100) : "";
    const parentWsClean =
      typeof parentWorkshopId === "string" &&
      /^\d{1,15}$/.test(parentWorkshopId)
        ? parentWorkshopId
        : "";
    const parentModClean =
      typeof parentModId === "string" && parentModId.length < 100
        ? parentModId
        : "";
    const serverPath = await getServerPath();

    // ── Build a small list of search variants to try in order. Mod IDs in PZ
    // are typically PascalCase, snake_case, or all-lowercase like "truemusic".
    // Steam's text search treats the whole token as one word, so "truemusic"
    // misses the actual mod titled "True Music". We try the raw form first,
    // then a humanized version, then strip common suffixes (_b41, _b42, _fix,
    // _v2…), and finally fall back to the parent mod's name with the same
    // suffix-stripping. Duplicates and very short variants (<3 chars) get
    // dropped so we never spam Steam with noise.
    const buildSearchVariants = (raw, parent) => {
      const variants = [];
      const seen = new Set();
      const push = (v) => {
        if (!v) return;
        const s = v.trim().toLowerCase();
        if (s.length < 3 || seen.has(s)) return;
        seen.add(s);
        variants.push(v.trim());
      };
      const stripSuffixes = (s) =>
        s
          .replace(
            /[_-]?(b4[12]fix|b4[12]_fix|b4[12]|fix(es)?|patch|patches|update|updates|v\d+(\.\d+)*|rev\d+|reupload|continued|continuation|port|ported|edition)$/gi,
            "",
          )
          .trim();
      const humanize = (s) =>
        s
          .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase → camel Case
          .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // ABCWord  → ABC Word
          .replace(/[_\-]+/g, " ") // snake / kebab → spaces
          .replace(/\s+/g, " ")
          .trim();
      push(raw);
      const humanized = humanize(raw);
      if (humanized.toLowerCase() !== raw.toLowerCase()) push(humanized);
      const stripped = stripSuffixes(raw);
      if (stripped.toLowerCase() !== raw.toLowerCase()) push(stripped);
      const humanizedStripped = humanize(stripped);
      if (
        humanizedStripped.toLowerCase() !== humanized.toLowerCase() &&
        humanizedStripped.toLowerCase() !== stripped.toLowerCase()
      )
        push(humanizedStripped);
      if (parent) {
        push(parent);
        const parentStripped = stripSuffixes(parent);
        if (parentStripped.toLowerCase() !== parent.toLowerCase())
          push(parentStripped);
      }
      return variants;
    };
    const searchVariants = buildSearchVariants(searchTerm, parentNameClean);

    // Phase 1: Search locally downloaded mods — match by mod ID (exact or partial) and mod name
    const localResults = [];
    const seenWorkshopIds = new Set();
    let hasExactLocalMatch = false;
    if (serverPath) {
      const workshopPaths = [
        path.join(serverPath, "steamapps", "workshop", "content", "108600"),
        path.join(
          serverPath,
          "..",
          "steamapps",
          "workshop",
          "content",
          "108600",
        ),
      ];
      for (const workshopBase of workshopPaths) {
        if (!fs.existsSync(workshopBase)) continue;
        try {
          for (const entry of fs.readdirSync(workshopBase, {
            withFileTypes: true,
          })) {
            if (!entry.isDirectory()) continue;
            if (localResults.length >= 20) break;
            // Don't suggest the parent mod itself as a candidate for its own dependency
            if (parentWsClean && entry.name === parentWsClean) continue;
            try {
              const details = getModDetailsFromWorkshop(entry.name, serverPath);
              for (const mod of details) {
                if (parentModClean && mod.id === parentModClean) continue;
                const scored = scoreWorkshopDependencyMatch(
                  searchTerm,
                  mod.id,
                  mod.name,
                );
                if (scored.score > 0) {
                  if (!seenWorkshopIds.has(`${entry.name}-${mod.id}`)) {
                    seenWorkshopIds.add(`${entry.name}-${mod.id}`);
                    localResults.push({
                      workshopId: entry.name,
                      modId: mod.id,
                      modName: mod.name,
                      source: "local",
                      isDownloaded: true,
                      exactMatch: scored.matchType === "exact-id",
                      matchType: scored.matchType,
                      relevance: scored.score,
                    });
                  }
                }
              }
            } catch (e) {
              log.debug(`Error scanning mod entry during search: ${e.message}`);
            }
          }
        } catch (e) {
          log.debug(`Error reading workshop dir during search: ${e.message}`);
        }
        if (localResults.length >= 20) break;
      }
      // If the required internal ID exists locally, keep the answer sharp:
      // exact ID candidates are what the admin needs to add. Prefix/contains
      // matches are useful only when no exact ID is available.
      const exactLocalMatches = localResults.filter(
        (result) => result.matchType === "exact-id",
      );
      if (exactLocalMatches.length > 0) {
        hasExactLocalMatch = true;
        localResults.splice(0, localResults.length, ...exactLocalMatches);
      }

      // Sort: strongest match first, then popularity-ish stable name order.
      localResults.sort((a, b) => {
        if ((b.relevance || 0) !== (a.relevance || 0))
          return (b.relevance || 0) - (a.relevance || 0);
        return a.modName.localeCompare(b.modName);
      });
    }

    // Phase 2: Try Steam API lookup if the query looks like a workshop ID
    const steamResults = [];
    if (/^\d{5,15}$/.test(searchTerm)) {
      // Skip if already found locally
      const alreadyFoundLocally = localResults.some(
        (r) => r.workshopId === searchTerm,
      );
      if (!alreadyFoundLocally) {
        try {
          const response = await fetch(
            "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                itemcount: "1",
                "publishedfileids[0]": searchTerm,
              }),
            },
          );
          if (response.ok) {
            const data = await response.json();
            const info = data.response?.publishedfiledetails?.[0];
            if (info && info.result === 1) {
              steamResults.push({
                workshopId: info.publishedfileid,
                modName: info.title,
                description: info.description?.substring(0, 200),
                subscriberCount: info.subscriptions || 0,
                source: "steam",
                isDownloaded: false,
              });
            }
          }
        } catch (e) {
          log.debug(`Steam collection lookup failed (non-fatal): ${e.message}`);
        }
      }
    }

    // Phase 3: Steam Workshop text search via IPublishedFileService/QueryFiles (requires API key).
    // Tries each query variant until enough candidates are found. We keep going
    // even when local matches exist for short queries, since a one-word mod ID
    // may have come from a sibling mod that happens to share the substring.
    let steamSearchEnabled = false;
    let steamSearchAttempted = false;
    if (!/^\d{5,15}$/.test(searchTerm) && !hasExactLocalMatch) {
      try {
        const steamApiKey = await getSteamApiKey();
        if (
          steamApiKey &&
          typeof steamApiKey === "string" &&
          steamApiKey.length > 10
        ) {
          steamSearchEnabled = true;
          // Score candidates so the most likely match floats to the top: exact
          // ID/name match first, then prefix/contains, then sub count tiebreak.
          const lowerOriginal = searchTerm.toLowerCase();
          const scoreCandidate = (title) => {
            const t = (title || "").toLowerCase();
            if (!t) return 0;
            if (t === lowerOriginal) return 1000;
            if (t.replace(/[\s_-]/g, "") === lowerOriginal) return 900;
            if (t.startsWith(lowerOriginal)) return 700;
            if (t.includes(lowerOriginal)) return 500;
            // Token overlap fallback for humanized variants
            const queryTokens = lowerOriginal
              .replace(/([a-z])([A-Z])/g, "$1 $2")
              .split(/[\s_-]+/)
              .filter((x) => x.length > 2);
            if (queryTokens.length === 0) return 0;
            const matched = queryTokens.filter((tok) => t.includes(tok)).length;
            return Math.round((matched / queryTokens.length) * 400);
          };

          const seenSteamIds = new Set([
            ...localResults.map((r) => r.workshopId),
            ...steamResults.map((r) => r.workshopId),
          ]);
          if (parentWsClean) seenSteamIds.add(parentWsClean);
          const collected = []; // { workshopId, modName, description, subscriberCount, score, variant }
          const targetCount = 12;

          for (const variant of searchVariants) {
            if (collected.length >= targetCount) break;
            steamSearchAttempted = true;
            const params = new URLSearchParams({
              key: steamApiKey,
              query_type: "12", // k_PublishedFileQueryType_RankedByTextSearch
              page: "1",
              numperpage: "15",
              appid: "108600", // Project Zomboid
              search_text: variant,
              return_short_description: "true",
              return_metadata: "true",
            });
            try {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 8000);
              const response = await fetch(
                `https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/?${params}`,
                {
                  signal: controller.signal,
                },
              );
              clearTimeout(timeout);
              if (!response.ok) continue;
              const data = await response.json();
              const files = data.response?.publishedfiledetails || [];
              for (const item of files) {
                if (!item.publishedfileid || item.result !== 1) continue;
                const wsId = String(item.publishedfileid);
                if (seenSteamIds.has(wsId)) continue;
                seenSteamIds.add(wsId);
                const title = item.title || `Workshop ${wsId}`;
                const desc = item.short_description?.substring(0, 200) || "";
                const score =
                  scoreCandidate(title) +
                  Math.min(50, Math.log10((item.subscriptions || 0) + 1) * 10);
                collected.push({
                  workshopId: wsId,
                  modName: title,
                  description: desc,
                  subscriberCount: item.subscriptions || 0,
                  score,
                  matchedVariant: variant,
                });
              }
            } catch (e) {
              log.debug?.(
                `Steam text search variant "${variant}" failed (non-fatal): ${e.message}`,
              );
            }
          }

          // Sort by score and keep the strongest matches
          collected.sort((a, b) => b.score - a.score);
          for (const c of collected.slice(0, targetCount)) {
            steamResults.push({
              workshopId: c.workshopId,
              modName: c.modName,
              description: c.description,
              subscriberCount: c.subscriberCount,
              source: "steam",
              isDownloaded: false,
              matchedVariant: c.matchedVariant,
              relevance: c.score,
            });
          }
        }
      } catch (e) {
        log.debug?.(`Steam text search failed (non-fatal): ${e.message}`);
      }
    }

    res.json({
      success: true,
      query: searchTerm,
      variantsTried: searchVariants,
      steamSearchEnabled,
      steamSearchAttempted,
      results: [...localResults, ...steamResults],
      searchUrl: `https://steamcommunity.com/workshop/browse/?appid=108600&searchtext=${encodeURIComponent(searchTerm)}`,
    });
  } catch (error) {
    log.error(`Workshop search failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ─── Missing Dependencies: Auto-resolve all unresolved deps ─────────────────
router.post("/resolve-missing-deps", async (req, res) => {
  try {
    const { deps } = req.body;
    if (!deps || !Array.isArray(deps)) {
      return res.status(400).json({
        error: "Dependencies array is required",
        code: ErrorCode.MODS_RESOLVE_DEPS_ARRAY_REQUIRED,
      });
    }

    // Same cap as the sibling POST /add-all-resolved-deps: every dep used to
    // trigger a synchronous read of every downloaded mod.info, so an
    // unbounded array pinned the event loop for as long as the caller liked.
    if (deps.length > 200) {
      return res.status(400).json({
        error: "Too many dependencies in one request (max 200)",
        code: ErrorCode.MODS_RESOLVE_DEPS_TOO_MANY,
      });
    }

    const serverPath = await getServerPath();
    const resolved = [];

    // mod id -> { workshopId, name } over the downloaded workshop items, built
    // on the first dep that needs it and shared by the rest of the request
    // (one pass over the workshop folders instead of one per dep). The first
    // item to declare an id wins, in the same scan order as before.
    let localModIndex = null;
    const buildLocalModIndex = () => {
      const index = new Map();
      if (!serverPath) return index;
      const workshopPaths = [
        path.join(serverPath, "steamapps", "workshop", "content", "108600"),
        path.join(
          serverPath,
          "..",
          "steamapps",
          "workshop",
          "content",
          "108600",
        ),
      ];
      for (const workshopBase of workshopPaths) {
        if (!fs.existsSync(workshopBase)) continue;
        try {
          for (const entry of fs.readdirSync(workshopBase, {
            withFileTypes: true,
          })) {
            if (!entry.isDirectory()) continue;
            try {
              for (const mod of getModDetailsFromWorkshop(entry.name, serverPath)) {
                if (!index.has(mod.id)) {
                  index.set(mod.id, { workshopId: entry.name, name: mod.name });
                }
              }
            } catch (e) {
              log.debug(
                `Error reading mod details during dep resolution: ${e.message}`,
              );
            }
          }
        } catch (e) {
          log.debug(
            `Error reading workshop path during dep scan: ${e.message}`,
          );
        }
      }
      return index;
    };

    for (const dep of deps) {
      const missingDep = dep?.missingDep;
      if (!missingDep || typeof missingDep !== "string") continue;
      if (dep.resolvedWorkshopId) {
        resolved.push(dep);
        continue;
      }

      // Search locally
      localModIndex ??= buildLocalModIndex();
      const match = localModIndex.get(missingDep);
      if (match) {
        resolved.push({
          ...dep,
          resolvedWorkshopId: match.workshopId,
          resolvedModName: match.name,
        });
      } else {
        resolved.push(dep);
      }
    }

    res.json({
      success: true,
      deps: resolved,
      resolvedCount: resolved.filter((d) => d.resolvedWorkshopId).length,
    });
  } catch (error) {
    log.error(`Failed to resolve missing deps: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ─── Sync mod IDs from Workshop → INI ─────────────────────────────────────
router.post("/sync-mod-ids", async (req, res) => {
  try {
    const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();
    if (!serverConfigPath || !serverName) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Server config path not set",
          code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
        }),
      );
    }
    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }
    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
      });
    }

    // First pass: read INI to get workshop IDs list (no lock needed for read-only)
    const preContent = readTextFile(iniPath);
    // Widened to tolerate whitespace around "=" -- same fix as the write
    // pass further below in this same route (hunt-wave13, 783672aa), missed
    // on this earlier read pass. This is the list the whole sync loop
    // iterates over, so a hand-edited "WorkshopItems = ..." line made the
    // entire route a silent no-op (0 synced, 0 missing, no error) instead
    // of actually reconciling anything.
    const preWorkshopMatch = preContent.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
    const workshopIds = (
      splitIniList(preWorkshopMatch?.[1])
    ).filter((id) => /^\d{1,15}$/.test(id));

    // Pre-resolve all mod IDs BEFORE taking the lock (async operations)
    const resolvedMap = new Map(); // workshopId -> { availableModIds, fallbackId, error }
    for (const workshopId of workshopIds) {
      try {
        const availableModIds = findAllModIdsFromWorkshop(
          workshopId,
          serverPath,
        );
        if (availableModIds.length > 0) {
          resolvedMap.set(workshopId, { availableModIds, fallbackId: null });
        } else {
          const fallbackId = await fetchModIdFromWorkshop(workshopId);
          resolvedMap.set(workshopId, { availableModIds: [], fallbackId });
        }
      } catch (err) {
        log.error(`Error processing workshop ID ${workshopId}: ${err.message}`);
        resolvedMap.set(workshopId, {
          availableModIds: [],
          fallbackId: null,
          error: true,
        });
      }
    }

    // Atomically re-read, modify, and write inside the lock
    const lockResult = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);

      // Widened to tolerate whitespace around "=" (hunt-wave13, 783672aa) --
      // modsMatch is the guard for the replace below.
      const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
      const currentModIds = splitModIdList(modsMatch?.[1]);
      const finalModIds = [...currentModIds];

      const syncedMods = [];
      const missingMods = [];

      for (const workshopId of workshopIds) {
        const resolved = resolvedMap.get(workshopId);
        if (!resolved || resolved.error) {
          missingMods.push(workshopId);
          continue;
        }

        const { availableModIds, fallbackId } = resolved;

        if (availableModIds.length > 0) {
          const present = availableModIds.filter((id) =>
            currentModIds.includes(id),
          );
          if (present.length > 0) {
            syncedMods.push({
              workshopId,
              mods: present,
              status: "verified_present",
            });
          } else {
            const defaultMod = availableModIds[0];
            if (!finalModIds.includes(defaultMod)) {
              finalModIds.push(defaultMod);
              syncedMods.push({
                workshopId,
                mods: [defaultMod],
                status: "added_default",
              });
              log.info(
                `Auto-added default mod ID '${defaultMod}' for workshop item ${workshopId}`,
              );
            }
            if (availableModIds.length > 1) {
              syncedMods[syncedMods.length - 1].alternatives =
                availableModIds.slice(1);
            }
          }
        } else if (fallbackId) {
          if (!finalModIds.includes(fallbackId)) {
            finalModIds.push(fallbackId);
            syncedMods.push({
              workshopId,
              mods: [fallbackId],
              status: "added_from_steam_api",
            });
          } else {
            syncedMods.push({
              workshopId,
              mods: [fallbackId],
              status: "verified_present_api",
            });
          }
        } else {
          missingMods.push(workshopId);
        }
      }

      // Entries already on the line are kept; the ids added above face the
      // numeric-workshop-ID filter unless their mod.info on disk confirms them.
      const newModList = sanitizeModIdListWithDiskBypass(
        finalModIds,
        workshopIds,
        serverPath,
        currentModIds,
      );
      // Reuse modsMatch (computed above), same fix as this file's first
      // ini-write site.
      if (modsMatch) {
        content = content.replace(/^[ \t]*Mods[ \t]*=.*/m, () => `Mods=${newModList}`);
      } else {
        content += `\nMods=${newModList}`;
      }

      const backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
      return {
        syncedMods,
        missingMods,
        totalModIds: finalModIds.length,
        backupWarning,
      };
    });

    const addedCount = lockResult.syncedMods.filter((m) =>
      m.status.startsWith("added"),
    ).length;

    log.info(
      `Synced mod IDs: ${addedCount} added, ${lockResult.missingMods.length} missing downloads`,
    );

    res.json({
      success: true,
      message: `Synced configuration. Added ${addedCount} missing mod IDs. ${lockResult.missingMods.length} items need download.`,
      syncedMods: lockResult.syncedMods,
      missingMods: lockResult.missingMods,
      totalModIds: lockResult.totalModIds,
      note:
        lockResult.missingMods.length > 0
          ? "Start server to download missing workshop items."
          : undefined,
      ...(lockResult.backupWarning ? { backupWarning: lockResult.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to sync mod IDs: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Validate mod configuration (check for dependencies and consistency)
router.get("/validate-config", async (req, res) => {
  try {
    const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Server config path not set",
          code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
        }),
      );
    }

    // Sanitize serverName
    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }
    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
      });
    }

    const content = readTextFile(iniPath);
    // Widened to tolerate whitespace around "=" -- same fix as this file's
    // other ini-read sites (hunt-wave13, 3d1921ad/783672aa), missed here. A
    // hand-edited "WorkshopItems = ..." line previously parsed as zero
    // workshop items/mods, which this "closest thing to a health check"
    // route (see the duplicate-key comment below) would have validated as
    // clean instead of flagging.
    const workshopMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
    const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);

    const workshopIds = workshopMatch
      ? splitIniList(workshopMatch[1])
      : [];
    const modIds = modsMatch ? splitModIdList(modsMatch[1]) : [];

    const warnings = [];
    const errors = [];

    // 0. Check for a duplicated key. Everything below this reads via
    // content.match(/^Key=.../m) with no /g -- the FIRST occurrence only
    // -- so without this check, a duplicated Mods=/WorkshopItems=/Map=
    // would validate cleanly against whichever block came first and never
    // surface that a second, unreachable-to-this-route block exists.
    // Found 2026-08-27 investigating an operator's corrupted ini: this
    // route is the closest thing to a health check this file has, and it
    // was structurally blind to the worst state its own file can be in.
    for (const { key, count } of findDuplicateIniKeys(content)) {
      errors.push({
        type: "duplicate_key",
        key,
        count,
        message: `"${key}=" appears ${count} times in this file. This tool reads and writes only the FIRST occurrence -- if the server itself reads a different one, changes here can appear to save while having no effect in-game. Open the raw INI editor to see and fix the duplicate.`,
      });
    }

    // 1. Check for Orphaned Mod IDs (Mods in list but no corresponding Workshop Item)
    // This requires scanning all configured workshop items to see what mods they provide
    const availableModIds = new Set();
    const modIdToWorkshopId = new Map();
    const references = new Map(); // modId -> { require: [] }

    if (serverPath) {
      for (const wid of workshopIds) {
        const details = getModDetailsFromWorkshop(wid, serverPath);
        for (const mod of details) {
          availableModIds.add(mod.id);
          modIdToWorkshopId.set(mod.id, wid);
          if (mod.require) {
            references.set(mod.id, mod.require);
          }
        }
      }

      // Check if enabled mods exist in enabled workshop items
      for (const mid of modIds) {
        if (!availableModIds.has(mid)) {
          // It might be a default game map/mod, or truly missing
          // PZ default mods don't come from workshop
          if (mid !== "example") {
            // Filter out common testing strings
            warnings.push({
              type: "missing_source",
              modId: mid,
              message: `Mod ID '${mid}' is enabled but not found in any configured Workshop Item.`,
            });
          }
        }
      }

      // 2. Check for Missing Dependencies
      for (const mid of modIds) {
        const requirements = references.get(mid);
        if (requirements) {
          for (const req of requirements) {
            if (!modIds.includes(req)) {
              // Check if it's a base game mod (unlikely to be missing but possible)
              errors.push({
                type: "missing_dependency",
                modId: mid,
                dependency: req,
                message: `Mod '${mid}' requires '${req}' but it is not enabled.`,
              });
            }
          }
        }
      }
    } else {
      warnings.push({
        type: "config",
        message: "Server path not configured - cannot validate files on disk.",
      });
    }

    res.json({
      valid: errors.length === 0,
      errors,
      warnings,
      stats: {
        workshopItems: workshopIds.length,
        enabledMods: modIds.length,
        availableMods: availableModIds.size,
      },
    });
  } catch (error) {
    log.error(`Failed to validate config: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ===== MOD PRESETS =====

// A preset's lists end up in WorkshopItems= and Mods= when it is applied, so
// they follow the rules of every other writer of those lines: Workshop IDs
// are 1-15 digits, mod IDs are what Mods= holds (cleanRuleModId), and a list
// keeps at most PRESET_LIST_MAX entries (the load-order save's cap). PUT
// /presets/:id stored whatever JSON it was sent: any value, nested to any
// depth (which stops every later save of the panel database) or of any size.
const PRESET_LIST_MAX = 2000;

function presetWorkshopId(value) {
  const id =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : value;
  return typeof id === "string" && /^\d{1,15}$/.test(id) ? id : null;
}

// The ids of a stored preset that can be written, for a preset saved before
// the checks above (or edited by hand in db.json). Not cut to
// PRESET_LIST_MAX: POST /presets saves the server's own lists, whatever
// their length.
function writablePresetIds(list, clean) {
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const raw of list) {
    const id = clean(raw);
    if (id !== null) out.add(id);
  }
  return [...out];
}

// Get all mod presets
router.get("/presets", async (req, res) => {
  try {
    const presets = await getModPresets();
    res.json({ presets });
  } catch (error) {
    log.error(`Failed to get mod presets: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Create a mod preset (save current mods as a preset)
router.post("/presets", async (req, res) => {
  try {
    let { name, description } = req.body;
    if (!name || typeof name !== "string") {
      return res.status(400).json({
        error: "Preset name is required",
        code: ErrorCode.MODS_PRESET_NAME_REQUIRED,
      });
    }
    name = name.trim();
    if (!name || name.length > 100) {
      return res.status(400).json({
        error: "Preset name must be 1-100 characters",
        code: ErrorCode.MODS_PRESET_NAME_LENGTH_INVALID,
      });
    }
    if (description && typeof description === "string") {
      description = description.trim().slice(0, 500);
    } else {
      description = "";
    }

    // Read current mods from INI
    const { serverConfigPath, serverName, configRefusal } = await getActiveServerPaths();
    const iniPath = getSanitizedIniPath(serverConfigPath, serverName);

    if (!iniPath) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Invalid server name",
          code: ErrorCode.MODS_INVALID_SERVER_NAME,
        }),
      );
    }

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server INI not found",
        code: ErrorCode.MODS_SERVER_INI_NOT_FOUND,
      });
    }

    const content = readTextFile(iniPath);
    // Widened to tolerate whitespace around "=" -- same fix as this file's
    // other ini-read sites (hunt-wave13, 3d1921ad/783672aa), missed here. A
    // hand-edited "WorkshopItems = ..." line previously parsed as zero
    // workshop items/mods, silently saving an EMPTY preset while reporting
    // success ("Preset ... created successfully") for a server that
    // actually has mods configured.
    const workshopMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
    const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);

    const workshopIds = workshopMatch
      ? splitIniList(workshopMatch[1])
      : [];
    const modIds = modsMatch ? splitModIdList(modsMatch[1]) : [];

    const preset = await createModPreset(
      name,
      description,
      modIds,
      workshopIds,
    );

    log.info(
      `Created mod preset "${name}" with ${workshopIds.length} workshop items and ${modIds.length} mod IDs`,
    );
    res.json({ preset, message: `Preset "${name}" created successfully` });
  } catch (error) {
    log.error(`Failed to create mod preset: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Update a mod preset
router.put("/presets/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({
        error: "Invalid preset ID",
        code: ErrorCode.MODS_INVALID_PRESET_ID,
      });
    }

    const updates = {};
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== "string")
        return res.status(400).json({
          error: "name must be a string",
          code: ErrorCode.MODS_PRESET_UPDATE_NAME_STRING_REQUIRED,
        });
      const trimmed = req.body.name.trim();
      if (!trimmed || trimmed.length > 100)
        return res.status(400).json({
          error: "name must be 1-100 characters",
          code: ErrorCode.MODS_PRESET_UPDATE_NAME_LENGTH_INVALID,
        });
      updates.name = trimmed;
    }
    if (req.body.description !== undefined) {
      updates.description =
        typeof req.body.description === "string"
          ? req.body.description.trim().slice(0, 500)
          : "";
    }
    if (req.body.workshopIds !== undefined) {
      if (!Array.isArray(req.body.workshopIds))
        return res.status(400).json({
          error: "workshopIds must be an array",
          code: ErrorCode.MODS_PRESET_UPDATE_WORKSHOP_IDS_ARRAY,
        });
      if (req.body.workshopIds.length > PRESET_LIST_MAX)
        return res.status(400).json({
          error: `Too many mod IDs (max ${PRESET_LIST_MAX})`,
          code: ErrorCode.MODS_SAVE_ORDER_TOO_MANY,
        });
      const workshopIds = new Set();
      for (const raw of req.body.workshopIds) {
        const workshopId = presetWorkshopId(raw);
        if (workshopId === null) {
          const shown = (typeof raw === "string" ? raw : typeof raw).substring(0, 20);
          return res.status(400).json({
            error: `Invalid Workshop ID: ${shown}`,
            code: ErrorCode.MODS_INVALID_WORKSHOP_ID_TEMPLATE,
            params: sanitizeErrorParams({ workshopId: shown }),
          });
        }
        workshopIds.add(workshopId);
      }
      updates.workshop_ids = [...workshopIds];
    }
    if (req.body.modIds !== undefined) {
      if (!Array.isArray(req.body.modIds))
        return res.status(400).json({
          error: "modIds must be an array",
          code: ErrorCode.MODS_MOD_IDS_ARRAY_REQUIRED,
        });
      if (req.body.modIds.length > PRESET_LIST_MAX)
        return res.status(400).json({
          error: `Too many mod IDs (max ${PRESET_LIST_MAX})`,
          code: ErrorCode.MODS_SAVE_ORDER_TOO_MANY,
        });
      const modIds = new Set();
      for (const raw of req.body.modIds) {
        const modId = cleanRuleModId(raw);
        if (modId === null) {
          return res.status(400).json({
            error: "Each mod ID must be a string (max 200 chars)",
            code: ErrorCode.MODS_SAVE_ORDER_MODID_STRING_REQUIRED,
          });
        }
        modIds.add(modId);
      }
      updates.mods = [...modIds];
    }

    const preset = await updateModPreset(id, updates);
    if (!preset) {
      return res.status(404).json({
        error: "Preset not found",
        code: ErrorCode.MODS_PRESET_NOT_FOUND,
      });
    }

    log.info(`Updated mod preset: ${updates.name || id}`);
    res.json({ preset, message: "Preset updated successfully" });
  } catch (error) {
    log.error(`Failed to update mod preset: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Delete a mod preset
router.delete("/presets/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({
        error: "Invalid preset ID",
        code: ErrorCode.MODS_INVALID_PRESET_ID,
      });
    }

    const deleted = await deleteModPreset(id);

    if (!deleted) {
      return res.status(404).json({
        error: "Preset not found",
        code: ErrorCode.MODS_PRESET_NOT_FOUND,
      });
    }

    log.info(`Deleted mod preset: ${id}`);
    res.json({ message: "Preset deleted successfully" });
  } catch (error) {
    log.error(`Failed to delete mod preset: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Apply a mod preset (load mods from preset)
router.post("/presets/:id/apply", async (req, res) => {
  try {
    const { id } = req.params;
    const presets = await getModPresets();
    const preset = presets.find((p) => String(p.id) === String(id));

    if (!preset) {
      return res.status(404).json({
        error: "Preset not found",
        code: ErrorCode.MODS_PRESET_NOT_FOUND,
      });
    }

    const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();
    const iniPath = getSanitizedIniPath(serverConfigPath, serverName);

    if (!iniPath) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Invalid server name",
          code: ErrorCode.MODS_INVALID_SERVER_NAME,
        }),
      );
    }

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server INI not found",
        code: ErrorCode.MODS_SERVER_INI_NOT_FOUND,
      });
    }

    // Only what PUT /presets/:id would accept now reaches the ini (a preset
    // saved before that check could hold anything).
    const presetWorkshopIds = writablePresetIds(preset.workshop_ids, presetWorkshopId);
    const presetModIds = writablePresetIds(preset.mods, cleanRuleModId);

    let backupWarning = null;
    await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);

      // Map= follows the items that come and go, as when they are added or
      // removed one by one: a preset only keeps Mods= and WorkshopItems=, so
      // a map mod's map stayed in Map= after a preset without it (and a
      // preset with one loaded it without its map).
      const itemsBefore = workshopItemsOf(content);
      const itemsAfter = presetWorkshopIds;
      const isItemId = (id) => /^\d{1,15}$/.test(id);
      const removedItems = itemsBefore.filter((id) => isItemId(id) && !itemsAfter.includes(id));
      const addedItems = itemsAfter.filter((id) => isItemId(id) && !itemsBefore.includes(id));
      const mapMatch = content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m);
      const mapsBefore = mapMatch ? splitIniList(mapMatch[1]) : null;
      if (serverPath && mapsBefore) {
        const leaving = removedItems
          .flatMap((wsId) => findMapFoldersFromWorkshop(wsId, serverPath))
          .filter((folder) => mapsBefore.includes(folder));
        const kept = shippedByListedItems({ mapFolders: leaving, listedWorkshopIds: itemsAfter, serverPath }).maps;
        const out = new Set(leaving.filter((folder) => !kept.has(folder)));
        if (out.size > 0) {
          const maps = mapsBefore.filter((folder) => !out.has(folder));
          content = content.replace(
            /^[ \t]*Map[ \t]*=.*/m,
            () => `Map=${sanitizeIniList(maps.length ? maps : ["Muldraugh, KY"])}`,
          );
        }
      }
      if (serverPath && addedItems.length > 0) {
        content = addMapFoldersToIni(
          content,
          addedItems.flatMap((wsId) => findMapFoldersFromWorkshop(wsId, serverPath)),
        ).content;
      }

      // Existence must be checked with the same anchored regex used to
      // replace it, not a plain .includes() -- see this file's first
      // ini-write site for why.
      const workshopLine = `WorkshopItems=${sanitizeIniList(presetWorkshopIds)}`;
      if (content.match(/^[ \t]*WorkshopItems[ \t]*=.*/m)) {
        content = content.replace(/^[ \t]*WorkshopItems[ \t]*=.*/m, () => workshopLine);
      } else {
        content += `\n${workshopLine}`;
      }

      // preset.mods is an authoritative, previously-validated ID list (saved
      // from a real Mods= state), not free-typed text -- sanitizeModIdList's
      // numeric-ID filter is for stripping mis-pasted workshop IDs out of
      // that kind of input, and would silently drop a mod whose mod.info
      // `id=` legitimately IS a 5-15 digit number (e.g. "Tear All Clothes"
      // 3519629457, see this file's enable-disk-mod handler). Character-only
      // sanitization here, same bypass already used for disk-verified IDs.
      const modsLine = `Mods=${sanitizeIniList(presetModIds)}`;
      if (content.match(/^[ \t]*Mods[ \t]*=.*/m)) {
        content = content.replace(/^[ \t]*Mods[ \t]*=.*/m, () => modsLine);
      } else {
        content += `\n${modsLine}`;
      }

      backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
    });

    log.info(
      `Applied mod preset "${preset.name}": ${presetWorkshopIds.length} workshop items, ${presetModIds.length} mod IDs`,
    );
    res.json({
      message: `Preset "${preset.name}" applied successfully`,
      workshopCount: presetWorkshopIds.length,
      modCount: presetModIds.length,
      ...(backupWarning ? { backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to apply mod preset: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ===== MOD GROUPS =====
//
// A group is a named, ordered list of mod IDs shared by every admin of the
// panel (stored in the panel database like the presets above, not per
// server): the list order is the load order those mods must keep in Mods=.
// utils/modGroups.js holds the rules; POST /save-order enforces them.

const MOD_GROUP_FIELD_ERRORS = {
  name: `Group name must be 1-${MOD_GROUP_LIMITS.nameMax} characters`,
  description: `Group description must be at most ${MOD_GROUP_LIMITS.descriptionMax} characters`,
  modIds: `modIds must list 1-${MOD_GROUP_LIMITS.modIdsMax} mod IDs of at most ${MOD_GROUP_LIMITS.modIdMax} characters`,
  color: `color must be null or one of ${MOD_GROUP_COLORS.join(", ")}`,
  keepTogether: "keepTogether must be true or false",
  placement: 'placement must be null, "first" or "last"',
  enforce: "enforce must be true or false",
  keepShared: "keepShared must be true or false",
  key: "key must be a suggestion key from GET /groups/suggestions",
};

function respondModGroupInvalid(res, field) {
  return res.status(400).json({
    error: MOD_GROUP_FIELD_ERRORS[field] || "Invalid mod group",
    code: ErrorCode.MODS_GROUP_INVALID,
    params: sanitizeErrorParams({ field }),
  });
}

function respondModGroupLimitReached(res) {
  return res.status(409).json({
    error: `At most ${MOD_GROUP_LIMITS.maxGroups} mod groups can be kept`,
    code: ErrorCode.MODS_GROUP_LIMIT_REACHED,
    params: sanitizeErrorParams({ max: MOD_GROUP_LIMITS.maxGroups }),
  });
}

function respondModGroupNotFound(res) {
  return res.status(404).json({
    error: "Mod group not found",
    code: ErrorCode.MODS_GROUP_NOT_FOUND,
  });
}

// On unless an admin turned it off, so a panel that never saved the setting
// enforces groups.
async function isModGroupEnforcementOn() {
  return (await getSetting("modGroupsEnforce")) !== false;
}

// The active server's ini (and install folder, from the same read of the
// active server), resolved like the preset routes do. Answers with the coded
// error itself and returns null when there is no ini to read.
export async function resolveActiveServerIniOrRespond(res) {
  const { serverConfigPath, serverName, serverPath, configRefusal, zomboidDataPath } = await getActiveServerPaths();
  const iniPath = getSanitizedIniPath(serverConfigPath, serverName);

  if (!iniPath) {
    res.status(400).json(
      withConfigRefusal(configRefusal, {
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      }),
    );
    return null;
  }

  if (!fs.existsSync(iniPath)) {
    res.status(400).json({
      error: "Server INI not found",
      code: ErrorCode.MODS_SERVER_INI_NOT_FOUND,
    });
    return null;
  }
  return { iniPath, serverPath, zomboidDataPath };
}

async function resolveActiveIniPathOrRespond(res) {
  return (await resolveActiveServerIniOrRespond(res))?.iniPath ?? null;
}

// The Mods= entries of an ini text, in load order, as { raw, id } (raw is the
// token as written, id what the game reads).
function modTokensOf(iniText) {
  return splitModIdTokens(iniText.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m)?.[1]);
}

function workshopItemsOf(iniText) {
  return splitIniList(iniText.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m)?.[1]);
}

// `line` in place of the ini's `key=` line, or appended when it has none.
function withIniLine(content, key, line) {
  const pattern = key === "Mods" ? /^[ \t]*Mods[ \t]*=.*/m : /^[ \t]*WorkshopItems[ \t]*=.*/m;
  return pattern.test(content) ? content.replace(pattern, () => line) : `${content.trimEnd()}\n${line}\n`;
}

// The Mods= line for `ids`, each written the way the ini already had it
// (backslashes kept) and a new one as its id. Equal ids are interchangeable,
// so each takes the next unused token of its own.
function modsLineFor(ids, tokens) {
  const unused = new Map();
  for (const token of tokens) {
    if (!unused.has(token.id)) unused.set(token.id, []);
    unused.get(token.id).push(token.raw);
  }
  return `Mods=${sanitizeIniList(ids.map((id) => unused.get(id)?.shift() ?? id))}`;
}

// Lists the groups with the panel-wide enforcement setting.
router.get("/groups", async (req, res) => {
  try {
    res.json({ groups: (await getModGroups()).map(normalizeGroup), enforce: await isModGroupEnforcementOn() });
  } catch (error) {
    log.error(`Failed to get mod groups: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Create a group.
router.post("/groups", async (req, res) => {
  try {
    const parsed = validateGroupFields(req.body);
    if (!parsed.ok) return respondModGroupInvalid(res, parsed.field);

    const group = await createModGroup(parsed.value, { maxGroups: MOD_GROUP_LIMITS.maxGroups });
    if (!group) return respondModGroupLimitReached(res);

    log.info(`Created mod group "${group.name}" with ${group.modIds.length} mods`);
    res.status(201).json({ group: normalizeGroup(group) });
  } catch (error) {
    log.error(`Failed to create mod group: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Create a group from a shared file. A name that is taken becomes "name (2)".
// Registered before /groups/:id (and the other literal /groups/* paths below)
// so a literal path is never read as a group id.
router.post("/groups/import", async (req, res) => {
  try {
    const parsed = validateGroupDocument(req.body?.document);
    if (!parsed.ok) {
      return res.status(400).json({
        error: "Not a valid mod group export",
        code: ErrorCode.MODS_GROUP_IMPORT_INVALID,
      });
    }

    const group = await createModGroup(parsed.value, {
      maxGroups: MOD_GROUP_LIMITS.maxGroups,
      uniqueName: true,
    });
    if (!group) return respondModGroupLimitReached(res);

    log.info(`Imported mod group "${group.name}" with ${group.modIds.length} mods`);
    res.status(201).json({ group: normalizeGroup(group) });
  } catch (error) {
    log.error(`Failed to import mod group: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Which groups the CURRENT Mods= order already respects. A group kept
// together that require= links or order rules keep apart (another mod must
// load between its members) is judged on its order alone and carries
// `forcedApart` (the rule the load-order planner follows too).
router.get("/groups/status", async (req, res) => {
  try {
    const active = await resolveActiveServerIniOrRespond(res);
    if (!active) return;

    const content = readTextFile(active.iniPath);
    const order = modTokensOf(content).map((token) => token.id);
    const groups = await getModGroups();
    const hardEdges = await hardOrderEdges(order, { content, ...active });
    const statuses = groupsInOrder(order, groups, { hardEdges });
    res.json({
      groups: statuses,
      inOrder: statuses.every((status) => status.inOrder),
      conflicts: applyModGroups(order, groups, { hardEdges }).conflicts,
    });
  } catch (error) {
    log.error(`Failed to get mod group status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Put the groups' order into the current Mods= line. `preview: true` only
// reports what would move. The write goes through the same lock and backup as
// POST /save-order and only happens when something changes.
router.post("/groups/apply", async (req, res) => {
  try {
    const preview = req.body?.preview === true;
    const active = await resolveActiveServerIniOrRespond(res);
    if (!active) return;
    const { iniPath } = active;

    const groups = await getModGroups();
    let result = { order: [], moved: [], conflicts: [] };
    let written = false;
    let backupWarning = null;

    if (preview) {
      const content = readTextFile(iniPath);
      const ids = modTokensOf(content).map((token) => token.id);
      result = applyModGroups(ids, groups, { hardEdges: await hardOrderEdges(ids, { content, ...active }) });
    } else {
      await withIniLock(iniPath, async () => {
        let content = readTextFile(iniPath);
        const tokens = modTokensOf(content);
        const ids = tokens.map((token) => token.id);
        result = applyModGroups(ids, groups, { hardEdges: await hardOrderEdges(ids, { content, ...active }) });
        if (result.moved.length === 0) return;

        // Write the entries as they were written (backslashes kept), only in
        // the new order.
        const modsLine = modsLineFor(result.order, tokens);
        content = content.replace(/^[ \t]*Mods[ \t]*=.*/m, () => modsLine);

        backupWarning = backupWarningFor(await writeIniWithBackup(iniPath, content));
        written = true;
      });
    }

    if (written) {
      log.info(`Applied mod groups to the load order: ${result.moved.length} mods moved`);
    }
    res.json({
      changed: result.moved.length > 0,
      moved: result.moved,
      order: result.order,
      written,
      conflicts: result.conflicts,
      ...(backupWarning ? { backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to apply mod groups: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Turn the enforcement in POST /save-order on or off, panel-wide.
router.put("/groups/enforce", async (req, res) => {
  try {
    const enforce = req.body?.enforce;
    if (typeof enforce !== "boolean") return respondModGroupInvalid(res, "enforce");

    await setSetting("modGroupsEnforce", enforce);
    log.info(`Mod group enforcement ${enforce ? "enabled" : "disabled"}`);
    res.json({ enforce });
  } catch (error) {
    log.error(`Failed to set mod group enforcement: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// What mod.info says about the mods of the Workshop items in WorkshopItems=
// (the reading GET /current-config's workshopModMap does), one entry per mod
// with the item it came from.
function listedWorkshopMods(workshopIds, serverPath) {
  const mods = [];
  if (!serverPath) return mods;
  for (const wsId of workshopIds) {
    if (!/^\d{1,15}$/.test(wsId)) continue;
    for (const mod of getModDetailsFromWorkshop(wsId, serverPath)) {
      mods.push({ id: mod.id, name: mod.name || mod.id, workshopId: wsId, require: mod.require || [] });
    }
  }
  return mods;
}

// Workshop item titles the panel knows from tracking (not the placeholders it
// gives an item before Steam answered). Best effort: none is fine.
async function trackedWorkshopTitles() {
  const titles = {};
  try {
    for (const mod of (await getTrackedMods()) || []) {
      const wsId = String(mod?.workshop_id ?? "");
      if (wsId && !titles[wsId] && !shouldRefreshTrackedModName(mod.name)) titles[wsId] = String(mod.name);
    }
  } catch (error) {
    log.debug(`Group suggestions without Workshop titles: ${error.message}`);
  }
  return titles;
}

// Groups the panel suggests for the active server's enabled mods
// (utils/modGroupSuggestions.js): a library and the mods that need it, a
// Workshop item that ships several enabled mods, mods whose names share a
// distinctive prefix. Leaves out what an existing group already holds and
// what an admin dismissed. Registered before /groups/:id.
router.get("/groups/suggestions", async (req, res) => {
  try {
    const active = await resolveActiveServerIniOrRespond(res);
    if (!active) return;

    const content = readTextFile(active.iniPath);
    const suggestions = computeGroupSuggestions({
      enabled: modTokensOf(content).map((token) => token.id),
      mods: listedWorkshopMods(workshopItemsOf(content), active.serverPath),
      groups: await getModGroups(),
      dismissed: await getDismissedModGroupSuggestions(),
      workshopTitles: await trackedWorkshopTitles(),
    });
    res.json({ suggestions });
  } catch (error) {
    log.error(`Failed to suggest mod groups: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Hide a suggestion for every admin (the panel keeps the newest 500 keys).
router.post("/groups/suggestions/dismiss", async (req, res) => {
  try {
    const key = req.body?.key;
    if (!isSuggestionKey(key)) return respondModGroupInvalid(res, "key");

    await dismissModGroupSuggestion(key, { max: 500 });
    log.info(`Dismissed mod group suggestion ${key}`);
    res.json({ success: true });
  } catch (error) {
    log.error(`Failed to dismiss mod group suggestion: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Change the given fields of a group.
router.put("/groups/:id", async (req, res) => {
  try {
    const parsed = validateGroupFields(req.body, { partial: true });
    if (!parsed.ok) return respondModGroupInvalid(res, parsed.field);

    const group = await updateModGroup(req.params.id, parsed.value);
    if (!group) return respondModGroupNotFound(res);

    log.info(`Updated mod group "${group.name}"`);
    res.json({ group: normalizeGroup(group) });
  } catch (error) {
    log.error(`Failed to update mod group: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Delete a group.
router.delete("/groups/:id", async (req, res) => {
  try {
    if (!(await deleteModGroup(req.params.id))) return respondModGroupNotFound(res);

    log.info(`Deleted mod group: ${req.params.id}`);
    res.json({ success: true });
  } catch (error) {
    log.error(`Failed to delete mod group: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

function uniqueMemberIds(group) {
  return [...new Set((Array.isArray(group?.modIds) ? group.modIds : []).filter((id) => typeof id === "string"))];
}

// The Workshop item folders downloaded for this server (every content folder
// getWorkshopPaths knows), sorted so the first match is always the same one.
function downloadedWorkshopIds(serverPath) {
  const roots = new Set(getWorkshopPaths("0", serverPath).map((folder) => path.dirname(folder)));
  const ids = new Set();
  for (const root of roots) {
    let entries;
    try {
      // codeql[js/path-injection] root is one of getWorkshopPaths' fixed content folders (install folder or the panel account's Steam), no request input.
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && /^\d{1,15}$/.test(entry.name)) ids.add(entry.name);
    }
  }
  return [...ids].sort();
}

// Which Workshop item holds each of `modIds` on disk (mod.info id): the items
// in WorkshopItems= first, in their order, then the other downloaded items.
// Each item is read once, and only while an id is still not placed.
export function locateModsOnDisk(modIds, listedWorkshopIds, serverPath) {
  const owner = new Map();
  const wanted = new Set(modIds);
  if (!serverPath || wanted.size === 0) return owner;
  const scan = (wsId) => {
    for (const mod of getModDetailsFromWorkshop(wsId, serverPath)) {
      if (wanted.has(mod.id) && !owner.has(mod.id)) owner.set(mod.id, wsId);
    }
  };
  const listed = listedWorkshopIds.filter((wsId) => /^\d{1,15}$/.test(wsId));
  for (const wsId of listed) {
    if (owner.size === wanted.size) return owner;
    scan(wsId);
  }
  const listedSet = new Set(listed);
  for (const wsId of downloadedWorkshopIds(serverPath)) {
    if (owner.size === wanted.size) break;
    if (!listedSet.has(wsId)) scan(wsId);
  }
  return owner;
}

// Puts each id of `adding` into `order` so the group's order holds: right
// after the nearest earlier member that is in the list, else right before the
// nearest later one, else at the end. Members are placed in the group's order,
// so one placed earlier counts for the next.
function insertInGroupOrder(order, members, adding) {
  const result = [...order];
  const add = new Set(adding);
  const indexOf = (id) => result.indexOf(id);
  for (let k = 0; k < members.length; k++) {
    if (!add.has(members[k])) continue;
    let at = -1;
    for (let j = k - 1; j >= 0 && at === -1; j--) {
      const index = indexOf(members[j]);
      if (index !== -1) at = index + 1;
    }
    for (let j = k + 1; j < members.length && at === -1; j++) {
      if (add.has(members[j])) continue; // not placed yet
      const index = indexOf(members[j]);
      if (index !== -1) at = index;
    }
    result.splice(at === -1 ? result.length : at, 0, members[k]);
  }
  return result;
}

// Enable every mod of a group on the active server: its member mod IDs that
// are not in Mods= go in where the group's order puts them (then the groups
// are enforced, like a load-order save, when that is on) and the Workshop
// items they come from join WorkshopItems= when missing. Only IDs found in a
// Workshop item on disk can be enabled; the others come back in `missing`.
// One write, through the lock and backup path the other mod writes use, and
// only when something changes.
router.post("/groups/:id/enable", async (req, res) => {
  try {
    const groups = await getModGroups();
    const group = groups.find((g) => g.id === req.params.id);
    if (!group) return respondModGroupNotFound(res);

    const active = await resolveActiveServerIniOrRespond(res);
    if (!active) return;
    const { iniPath, serverPath, zomboidDataPath } = active;
    const members = uniqueMemberIds(group);
    const enforce = await isModGroupEnforcementOn();

    let result = null;
    let backupWarning = null;
    await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);
      const tokens = modTokensOf(content);
      const order = tokens.map((token) => token.id);
      const enabledNow = new Set(order);
      const workshopItems = workshopItemsOf(content);

      const alreadyEnabled = members.filter((id) => enabledNow.has(id));
      const wanted = members.filter((id) => !enabledNow.has(id));
      const owner = locateModsOnDisk(wanted, workshopItems, serverPath);
      const enabled = wanted.filter((id) => owner.has(id));
      const missing = wanted.filter((id) => !owner.has(id));
      const listed = new Set(workshopItems);
      const workshopItemsAdded = [];
      for (const id of enabled) {
        const wsId = owner.get(id);
        if (!listed.has(wsId)) {
          listed.add(wsId);
          workshopItemsAdded.push(wsId);
        }
      }
      result = { enabled, alreadyEnabled, missing, workshopItemsAdded, groupsAdjusted: [] };
      if (enabled.length === 0) return;

      let newOrder = insertInGroupOrder(order, members, enabled);
      if (enforce) {
        try {
          // The mod list as it will be (with the items this adds), for the
          // require= links the keep-together rule reads.
          const probe = workshopItemsAdded.length
            ? withIniLine(content, "WorkshopItems", `WorkshopItems=${sanitizeIniList([...workshopItems, ...workshopItemsAdded])}`)
            : content;
          const hardEdges = await hardOrderEdges(newOrder, { content: probe, serverPath, zomboidDataPath });
          const applied = applyModGroups(newOrder, groups, { hardEdges });
          newOrder = applied.order;
          result.groupsAdjusted = applied.moved;
        } catch (error) {
          log.warn(`Mod groups not enforced while enabling "${group.name}": ${error.message}`);
        }
      }

      content = withIniLine(content, "Mods", modsLineFor(newOrder, tokens));
      if (workshopItemsAdded.length > 0) {
        content = withIniLine(
          content,
          "WorkshopItems",
          `WorkshopItems=${sanitizeIniList([...workshopItems, ...workshopItemsAdded])}`,
        );
        // An item this adds puts its maps in front of Map=, like every
        // add-mod flow (addWorkshopItemToIni): without them a map mod of the
        // group loads with no map.
        const folders = workshopItemsAdded.flatMap((wsId) => findMapFoldersFromWorkshop(wsId, serverPath));
        const maps = addMapFoldersToIni(content, folders);
        content = maps.content;
        if (maps.addedMapFolders.length > 0) result.mapFoldersAdded = maps.addedMapFolders;
      }
      backupWarning = backupWarningFor(await writeIniWithBackup(iniPath, content));
    });

    if (result.enabled.length > 0) {
      log.info(
        `Enabled mod group "${group.name}": ${result.enabled.length} mods` +
          (result.workshopItemsAdded.length ? `, ${result.workshopItemsAdded.length} Workshop items added` : "") +
          (result.missing.length ? ` (${result.missing.length} not found on disk)` : ""),
      );
    }
    res.json({ ...result, ...(backupWarning ? { backupWarning } : {}) });
  } catch (error) {
    log.error(`Failed to enable mod group: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Disable every mod of a group on the active server: its member mod IDs leave
// Mods=. With keepShared (the default) a mod that another group also lists
// stays while that group still has an enabled mod this leaves on (keptShared):
// a shared library its add-ons need. Not "every member enabled": groups are
// shared by every server, so most have members a given server does not have,
// and the library went with the add-ons still loading. PanelBridge's own mod, when
// its Workshop delivery manages it, always stays (keptManaged). WorkshopItems=
// is left alone, so the files stay and enabling again is instant. One write,
// through the lock and backup path, and only when something changes.
router.post("/groups/:id/disable", async (req, res) => {
  try {
    const keepShared = req.body?.keepShared === undefined ? true : req.body.keepShared;
    if (typeof keepShared !== "boolean") return respondModGroupInvalid(res, "keepShared");

    const allGroups = await getModGroups();
    const group = allGroups.find((g) => g.id === req.params.id);
    if (!group) return respondModGroupNotFound(res);

    const iniPath = await resolveActiveIniPathOrRespond(res);
    if (!iniPath) return;
    const members = uniqueMemberIds(group);
    const otherGroups = allGroups.filter((g) => g !== group).map(uniqueMemberIds);
    const bridgeModId = (await getBridgeManaged())?.modId ?? null;

    let result = null;
    let backupWarning = null;
    await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);
      const tokens = modTokensOf(content);
      const enabledNow = new Set(tokens.map((token) => token.id));

      const notEnabled = members.filter((id) => !enabledNow.has(id));
      const keptShared = [];
      const keptManaged = [];
      const disabled = [];
      const leaving = new Set(members);
      const stillUsed = (other) => other.some((member) => !leaving.has(member) && enabledNow.has(member));
      for (const id of members) {
        if (!enabledNow.has(id)) continue;
        if (id === bridgeModId) keptManaged.push(id);
        else if (keepShared && otherGroups.some((other) => other.includes(id) && stillUsed(other))) {
          keptShared.push(id);
        } else disabled.push(id);
      }
      result = { disabled, keptShared, notEnabled, keptManaged };
      if (disabled.length === 0) return;

      const off = new Set(disabled);
      const kept = tokens.filter((token) => !off.has(token.id));
      content = withIniLine(content, "Mods", `Mods=${sanitizeIniList(kept.map((token) => token.raw))}`);
      backupWarning = backupWarningFor(await writeIniWithBackup(iniPath, content));
    });

    if (result.disabled.length > 0) {
      log.info(
        `Disabled mod group "${group.name}": ${result.disabled.length} mods` +
          (result.keptShared.length ? ` (${result.keptShared.length} kept for other groups)` : ""),
      );
    }
    res.json({ ...result, ...(backupWarning ? { backupWarning } : {}) });
  } catch (error) {
    log.error(`Failed to disable mod group: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ===== MOD NOTES =====
//
// One note per Workshop item, shared by every admin (panel database). An
// empty text deletes the note.

function noteResponse(note) {
  return { text: note.text, updatedAt: note.updatedAt, updatedBy: note.updatedBy ?? null };
}

router.get("/notes", async (req, res) => {
  try {
    const notes = {};
    for (const note of await getModNotes()) {
      if (isNoteWorkshopId(note?.workshopId) && typeof note.text === "string") {
        notes[note.workshopId] = noteResponse(note);
      }
    }
    res.json({ notes });
  } catch (error) {
    log.error(`Failed to get mod notes: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.put("/notes/:workshopId", async (req, res) => {
  try {
    const workshopId = req.params.workshopId;
    if (!isNoteWorkshopId(workshopId)) {
      return res.status(400).json({
        error: "Invalid workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_LOWER,
      });
    }

    const cleaned = cleanModNoteText(req.body?.text);
    if (!cleaned.ok && cleaned.reason === "length") {
      return res.status(400).json({
        error: `A mod note can be at most ${MOD_NOTE_LIMITS.textMax} characters`,
        code: ErrorCode.MODS_NOTE_TOO_LONG,
        params: sanitizeErrorParams({ max: MOD_NOTE_LIMITS.textMax }),
      });
    }
    if (!cleaned.ok) {
      return res.status(400).json({
        error: "A mod note must be text without control characters",
        code: ErrorCode.MODS_NOTE_INVALID,
      });
    }

    if (cleaned.text === "") {
      if (await deleteModNote(workshopId)) log.info(`Deleted the note on Workshop item ${workshopId}`);
      return res.json({ note: null });
    }

    const note = await setModNote(workshopId, cleaned.text, {
      updatedBy: req.user?.username || null,
      maxNotes: MOD_NOTE_LIMITS.maxNotes,
    });
    if (!note) {
      return res.status(409).json({
        error: `At most ${MOD_NOTE_LIMITS.maxNotes} mod notes can be kept`,
        code: ErrorCode.MODS_NOTE_LIMIT_REACHED,
        params: sanitizeErrorParams({ max: MOD_NOTE_LIMITS.maxNotes }),
      });
    }
    log.info(`Saved the note on Workshop item ${workshopId}`);
    res.json({ note: noteResponse(note) });
  } catch (error) {
    log.error(`Failed to save mod note: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Save mod load order
router.post("/save-order", async (req, res) => {
  try {
    const { modIds } = req.body;

    if (!Array.isArray(modIds)) {
      return res.status(400).json({
          error: "modIds must be an array",
          code: ErrorCode.MODS_MOD_IDS_ARRAY_REQUIRED,
        });
    }
    if (modIds.length > 2000) {
      return res.status(400).json({
        error: "Too many mod IDs (max 2000)",
        code: ErrorCode.MODS_SAVE_ORDER_TOO_MANY,
      });
    }
    for (const id of modIds) {
      if (typeof id !== "string" || id.length > 200) {
        return res.status(400).json({
          error: "Each mod ID must be a string (max 200 chars)",
          code: ErrorCode.MODS_SAVE_ORDER_MODID_STRING_REQUIRED,
        });
      }
    }

    const { serverConfigPath, serverName, serverPath, configRefusal, zomboidDataPath } = await getActiveServerPaths();
    const iniPath = getSanitizedIniPath(serverConfigPath, serverName);

    if (!iniPath) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Invalid server name",
          code: ErrorCode.MODS_INVALID_SERVER_NAME,
        }),
      );
    }

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server INI not found",
        code: ErrorCode.MODS_SERVER_INI_NOT_FOUND,
      });
    }

    // Mod groups: with enforcement on (the default) the order of every group
    // is put into the list before it is written, so a drag in the Mod Manager
    // cannot break a group's load order. Only the members of a group change
    // places; the response says which mods moved and which groups cannot
    // be satisfied together.
    let orderToWrite = modIds;
    let groupsAdjusted = [];
    let groupConflicts = [];
    try {
      if (await isModGroupEnforcementOn()) {
        // A group kept together that require= links or order rules keep
        // apart only keeps its order: the rule the load-order planner
        // follows, so saving a plan leaves it as planned.
        const hardEdges = await hardOrderEdges(modIds, { content: readTextFile(iniPath), serverPath, zomboidDataPath });
        const applied = applyModGroups(modIds, await getModGroups(), { hardEdges });
        orderToWrite = applied.order;
        groupsAdjusted = applied.moved;
        groupConflicts = applied.conflicts;
      }
    } catch (error) {
      // Groups are an aid on top of the load order: failing to read them must
      // never stop the admin's own order from being saved.
      log.warn(`Mod groups not enforced for this save: ${error.message}`);
    }

    let backupWarning = null;
    await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);

      // modIds is the client's reorder of the CURRENT live Mods= entries
      // (Mods.tsx seeds its drag list from the server's own last read of
      // Mods=), not free-typed text -- sanitizeModIdList's numeric-ID filter
      // would silently drop a mod whose mod.info `id=` legitimately IS a
      // 5-15 digit number (e.g. "Tear All Clothes" 3519629457, see this
      // file's enable-disk-mod handler) on every reorder. Character-only
      // sanitization here, same bypass already used for disk-verified IDs.
      const modsLine = `Mods=${sanitizeIniList(orderToWrite)}`;
      // Same fix as this file's first ini-write site: check the anchored
      // regex, not a plain .includes().
      if (content.match(/^[ \t]*Mods[ \t]*=.*/m)) {
        content = content.replace(/^[ \t]*Mods[ \t]*=.*/m, () => modsLine);
      } else {
        content += `\n${modsLine}`;
      }

      backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
    });

    log.info(
      `Saved mod load order: ${modIds.length} mods` +
        (groupsAdjusted.length ? ` (${groupsAdjusted.length} moved to keep mod groups in order)` : ""),
    );
    res.json({
      message: "Mod load order saved successfully",
      modCount: modIds.length,
      groupsAdjusted,
      groupConflicts,
      ...(backupWarning ? { backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to save mod order: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// POST /discover-mod-ids's SteamCMD downloads (below). Each request gets a
// folder of its own under <dataDir>/workshop-download-cache/ and removes it
// whole when it is done, appworkshop_108600.acf included: with one shared
// folder the .acf kept saying an item was installed after its files were
// dropped, so adding the same mod again could "succeed" without downloading
// anything, and two adds at once could delete each other's files. Folders a
// crashed or killed panel left behind go once they are an hour old; one this
// process is still downloading into is never swept, however long it takes.
const WORKSHOP_DOWNLOAD_CACHE_DIR = "workshop-download-cache";
const WORKSHOP_DOWNLOAD_STALE_MS = 60 * 60 * 1000;
const activeWorkshopDownloadDirs = new Set();

export function sweepStaleWorkshopDownloadDirs(cacheRoot, now = Date.now()) {
  let entries;
  try {
    entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(cacheRoot, entry.name);
    if (activeWorkshopDownloadDirs.has(entryPath)) continue;
    try {
      if (now - fs.lstatSync(entryPath).mtimeMs < WORKSHOP_DOWNLOAD_STALE_MS) continue;
      fs.rmSync(entryPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      log.debug(`Workshop download cache: could not remove ${entry.name}: ${error.message}`);
    }
  }
}

function workshopDownloadDirFor(dataDir) {
  const cacheRoot = path.join(dataDir, WORKSHOP_DOWNLOAD_CACHE_DIR);
  sweepStaleWorkshopDownloadDirs(cacheRoot);
  const dir = path.join(cacheRoot, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  activeWorkshopDownloadDirs.add(dir);
  return dir;
}

function releaseWorkshopDownloadDir(dir) {
  activeWorkshopDownloadDirs.delete(dir);
  try {
    // Retries: on Windows a SteamCMD just stopped (the dialog closed) can
    // hold its files for a moment. A folder still left is swept later.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    log.warn(`Workshop download cache: could not remove ${path.basename(dir)}: ${error.message}`);
  }
}

router.post("/discover-mod-ids", async (req, res) => {
  try {
    const { workshopId, workshopUrl } = req.body;

    // Parse workshop ID from URL if provided
    let wsId = workshopId;
    if (!wsId && workshopUrl) {
      const urlMatch = workshopUrl.match(/id=(\d+)/);
      if (urlMatch) {
        wsId = urlMatch[1];
      }
    }

    if (!wsId) {
      return res.status(400).json({
        error: "Workshop ID or URL is required",
        code: ErrorCode.MODS_DISCOVER_WORKSHOP_ID_OR_URL_REQUIRED,
      });
    }

    // Validate it's a number
    if (!/^\d{1,15}$/.test(String(wsId))) {
      return res.status(400).json({
        error: "Invalid Workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_CAP,
      });
    }

    const serverPath = await getServerPath();
    const discoveredModIds = [];
    const sources = [];

    // 1. First try local files (most accurate if mod is already downloaded)
    if (serverPath) {
      const localModIds = findAllModIdsFromWorkshop(String(wsId), serverPath);
      for (const modId of localModIds) {
        if (!discoveredModIds.includes(modId)) {
          discoveredModIds.push(modId);
          sources.push({ modId, source: "local-files" });
        }
      }
    }

    // 1b. Not on disk yet: have SteamCMD download it (the add dialog asks for
    // this), so the mod IDs and map folders come from the item's own files.
    // Without them a mod whose description does not state its mod IDs was added
    // to WorkshopItems= only; the server downloaded it on the next boot, after
    // it had read Mods=, and the mod was never enabled. It is downloaded into
    // the panel's own cache, not the server's Workshop folder: SteamCMD never
    // writes the files (or appworkshop_108600.acf) the game server itself
    // downloads into at start, so a start is neither blocked nor raced. The
    // server downloads its own copy when it starts. Skipped for a remote server
    // and when SteamCMD is not set up (the description below is used as before).
    let downloadedFromSteam = false;
    let downloadSkippedReason = null;
    let downloadedMapFolders = [];
    if (discoveredModIds.length === 0 && serverPath && req.body?.download === true) {
      const activeServer = await getActiveServer();
      if (activeServer?.isRemote) {
        downloadSkippedReason = "remote-server";
      } else {
        const abort = new AbortController();
        res.on?.("close", () => {
          if (!res.writableEnded) abort.abort(); // the dialog was closed: stop SteamCMD
        });
        const buildEnv =
          process.platform === "win32"
            ? null
            : (await import("./server.js")).buildLinuxSteamCmdEnv;
        // A folder of its own per request (see workshopDownloadDirFor()),
        // removed whole -- appworkshop_108600.acf included -- once the IDs
        // are read.
        const downloadDir = workshopDownloadDirFor(getDataPaths().dataDir);
        try {
          const download = await downloadWorkshopItem(String(wsId), {
            serverPath: downloadDir,
            signal: abort.signal,
            buildEnv,
          });
          if (download.success) {
            downloadedFromSteam = true;
            for (const modId of findAllModIdsFromWorkshop(String(wsId), downloadDir)) {
              if (!discoveredModIds.includes(modId)) {
                discoveredModIds.push(modId);
                sources.push({ modId, source: "steamcmd-download" });
              }
            }
            downloadedMapFolders = findMapFoldersFromWorkshop(String(wsId), downloadDir);
          } else {
            downloadSkippedReason = download.reason;
            log.info(`discover-mod-ids ${wsId}: SteamCMD download not used (${download.reason}: ${download.error})`);
          }
        } finally {
          releaseWorkshopDownloadDir(downloadDir);
        }
      }
    }

    // 2. Try Steam Workshop API to get mod info (with timeout)
    let modInfo = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      const response = await fetch(
        "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            itemcount: "1",
            "publishedfileids[0]": wsId,
          }),
          signal: controller.signal,
        },
      );

      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        modInfo = data.response?.publishedfiledetails?.[0];

        // Handle Steam API error codes
        if (modInfo && modInfo.result !== 1) {
          log.warn(
            `Steam API returned error for workshop ${wsId}: result=${modInfo.result}`,
          );
          modInfo = null;
        }
      }
    } catch (e) {
      if (e.name === "AbortError") {
        log.warn(`Steam API request timed out for workshop ${wsId}`);
      } else {
        log.warn(
          `Failed to fetch Steam API for workshop ${wsId}: ${e.message}`,
        );
      }
    }

    // 3. Parse mod IDs from description (if not found locally)
    if (modInfo && modInfo.result === 1 && discoveredModIds.length === 0) {
      const description = modInfo.description || "";

      // Try various patterns to find mod IDs
      const patterns = [
        // Pattern: "Mod ID: SomeName" or "ModID: SomeName" (can appear multiple times)
        /Mod\s*ID\s*[:=]\s*([A-Za-z0-9_-]+)/gi,
        // Pattern: "id=SomeName"
        /\bid\s*=\s*([A-Za-z0-9_-]+)/gi,
      ];

      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(description)) !== null) {
          const modId = match[1].trim();
          // Skip numeric-only values (likely workshop IDs)
          if (!/^\d{1,15}$/.test(modId) && !discoveredModIds.includes(modId)) {
            discoveredModIds.push(modId);
            sources.push({ modId, source: "steam-description" });
          }
        }
      }
    }

    // Deduplicate mod IDs (some mods list the same ID multiple times)
    const uniqueModIds = [...new Set(discoveredModIds)];

    // Get map folders if available
    let mapFolders = [];
    if (serverPath) {
      mapFolders = findMapFoldersFromWorkshop(String(wsId), serverPath);
    }
    if (mapFolders.length === 0 && downloadedMapFolders.length > 0) {
      mapFolders = downloadedMapFolders;
    }

    // Check if mod has map tag from Steam API
    const isMap =
      modInfo?.tags?.some(
        (t) =>
          t.tag?.toLowerCase() === "map" || t.tag?.toLowerCase() === "maps",
      ) || mapFolders.length > 0;

    res.json({
      success: true,
      workshopId: wsId,
      name: modInfo?.title || `Workshop Mod ${wsId}`,
      description: modInfo?.description?.substring(0, 500) || null,
      modIds: uniqueModIds,
      hasMultipleModIds: uniqueModIds.length > 1,
      sources,
      isMap,
      mapFolders,
      isDownloaded: serverPath
        ? findAllModIdsFromWorkshop(String(wsId), serverPath).length > 0
        : false,
      tags: modInfo?.tags?.map((t) => t.tag) || [],
      downloadedFromSteam,
      downloadSkippedReason,
    });
  } catch (error) {
    log.error(`Failed to discover mod IDs: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Add mod with specific mod IDs selected (for multi-ID mods)
router.post("/add-mod-advanced", async (req, res) => {
  try {
    const { workshopId, selectedModIds, includeAllModIds } = req.body;
    // workshopId: the Steam Workshop ID
    // selectedModIds: array of mod IDs to add (user-selected)
    // includeAllModIds: boolean - if true, add all discovered mod IDs

    if (!workshopId) {
      return res.status(400).json({
        error: "Workshop ID is required",
        code: ErrorCode.MODS_WORKSHOP_ID_REQUIRED,
      });
    }

    if (!selectedModIds && !includeAllModIds) {
      return res.status(400).json({
        error: "Either selectedModIds or includeAllModIds is required",
        code: ErrorCode.MODS_ADD_ADVANCED_SELECTION_REQUIRED,
      });
    }

    // Validate workshopId is numeric
    if (!/^\d{1,15}$/.test(String(workshopId))) {
      return res.status(400).json({
        error: "Invalid Workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_CAP,
      });
    }

    const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Server config path not set",
          code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
        }),
      );
    }

    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
      });
    }

    // Validate mod ID format BEFORE taking the lock (prevent INI injection)
    let modIdsToAdd = selectedModIds || [];
    for (const modId of modIdsToAdd) {
      if (
        typeof modId !== "string" ||
        !modId.trim() ||
        /[\r\n;=]/.test(modId) ||
        modId.length > 200
      ) {
        const truncatedModId = String(modId).substring(0, 50);
        return res.status(400).json({
          error: `Invalid mod ID format: ${truncatedModId}`,
          code: ErrorCode.MODS_INVALID_MOD_ID_FORMAT_TEMPLATE,
          params: sanitizeErrorParams({ modId: truncatedModId }),
        });
      }
    }

    // Which mod ids to enable: the ones asked for, plus every mod of the item
    // when includeAllModIds is set. An item that is not downloaded yet has
    // nothing on disk to read, so (like POST /add-to-ini) the Steam Workshop
    // page is asked for its id; if that finds nothing either, the item goes
    // into WorkshopItems= alone and the response says so (status
    // "workshop-only") instead of implying the mod will load after a restart.
    const resolution = await resolveModIdsForAddition({
      workshopId: String(workshopId),
      explicitModIds: modIdsToAdd,
      discover: includeAllModIds ? "all" : "none",
      serverPath,
    });
    modIdsToAdd = resolution.modIds;

    // Detect map folders outside the lock (sync disk reads)
    let modMapFolders = [];
    if (serverPath) {
      modMapFolders = findMapFoldersFromWorkshop(
        String(workshopId),
        serverPath,
      );
    }

    // Atomically read-modify-write inside the lock
    const lockResult = await withIniLock(iniPath, async () => {
      const applied = addWorkshopItemToIni(readTextFile(iniPath), {
        workshopId: String(workshopId),
        modIds: modIdsToAdd,
        mapFolders: modMapFolders,
        serverPath,
      });

      let backupWarning = null;
      if (applied.changed) {
        backupWarning = backupWarningFor(
          await writeIniWithBackup(iniPath, applied.content),
        );
      }
      return { applied, backupWarning };
    });
    const applied = lockResult.applied;
    const status = additionStatus(modIdsToAdd.length, applied);

    // Also add to tracking (and clear from ignore list if present)
    try {
      await removeIgnoredMod(String(workshopId));
      await addTrackedMod(String(workshopId), `Workshop Mod ${workshopId}`);
    } catch (e) {
      // Ignore if already tracked
    }

    // Best-effort: mirror this add into the configured Steam Workshop
    // collection if auto-sync is enabled. Never blocks the response.
    autoSyncCollection("add", String(workshopId)).catch(() => {});

    log.info(
      `Added mod ${workshopId} with ${applied.addedModIds.length} mod IDs: ${applied.addedModIds.join(", ")} (${status})`,
    );

    res.json({
      success: true,
      workshopId,
      addedModIds: applied.addedModIds,
      totalModIdsInConfig: applied.modCount,
      workshopAlreadyExisted: applied.workshopAlreadyExisted,
      mapFoldersAdded: applied.addedMapFolders,
      // "added": at least one mod ID was written to Mods=. "already-configured":
      // nothing needed changing. "workshop-only": no mod ID could be found, so
      // only WorkshopItems= changed -- the mod does not load until its ID is
      // known (start the server to download it, then Sync Mod IDs).
      status,
      detectionSource: resolution.detectionSource,
      message: additionMessage(status, applied),
      ...(lockResult.backupWarning ? { backupWarning: lockResult.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to add mod advanced: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ─── Add many workshop items in ONE ini write ───────────────────────────────
// Importing a collection (or re-enabling a handful of deactivated mods) used to
// call POST /add-mod-advanced (or /add-to-ini) once per mod. Each call is a
// separate ini write and so a separate backup, and a backup keeps only the 10
// newest: a 60-mod import evicted the pre-import copy of the server config,
// the one file a bad import needs back. This endpoint does the whole batch
// under one lock with one write (so exactly one backup); the single-item
// endpoints stay as they were and share the same edit (addWorkshopItemToIni).
//
// Body: { mods: [{ workshopId, selectedModIds?, includeAllModIds? }], track? }
//   selectedModIds   exactly these mod ids (plus every mod of the item with includeAllModIds)
//   includeAllModIds every mod of the item
//   neither          the item's default mod only; the others come back as alternativeModIds
//   track            also track each item and mirror it into the Workshop
//                    collection when auto-sync is on (what an import wants)
const ADD_BULK_MAX = 500;
const ADD_BULK_RESOLVE_CONCURRENCY = 5;
// Each Steam lookup can take up to 15 s when Steam is slow; stop asking after
// this long and add the remaining items to WorkshopItems= alone.
const ADD_BULK_STEAM_BUDGET_MS = 30_000;

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

router.post("/add-to-ini-bulk", async (req, res) => {
  try {
    const { mods, track } = req.body || {};
    if (!Array.isArray(mods) || mods.length === 0) {
      return res.status(400).json({
        error: "Mods array is required",
        code: ErrorCode.MODS_ADD_BULK_MODS_ARRAY_REQUIRED,
      });
    }
    if (mods.length > ADD_BULK_MAX) {
      return res.status(400).json({
        error: `Maximum ${ADD_BULK_MAX} mods per batch`,
        code: ErrorCode.MODS_ADD_BULK_TOO_MANY,
      });
    }

    const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();
    if (!serverConfigPath || !serverName) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Server config path not set",
          code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
        }),
      );
    }
    const iniPath = getSanitizedIniPath(serverConfigPath, serverName);
    if (!iniPath) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
      });
    }

    // Validate every item up front; a bad item is reported, not fatal.
    const results = [];
    const valid = [];
    const seen = new Set();
    for (const item of mods) {
      const workshopId = String(item?.workshopId ?? "");
      if (!/^\d{1,15}$/.test(workshopId)) {
        results.push({
          workshopId: workshopId.slice(0, 20),
          status: "invalid",
          code: ErrorCode.MODS_INVALID_WORKSHOP_ID_CAP,
        });
        continue;
      }
      if (seen.has(workshopId)) continue; // the same item twice is one item
      seen.add(workshopId);
      const selected = item.selectedModIds ?? [];
      const badModId = Array.isArray(selected)
        ? selected.find(
            (id) =>
              typeof id !== "string" ||
              !id.trim() ||
              /[\r\n;=]/.test(id) ||
              id.length > 200,
          )
        : "";
      if (!Array.isArray(selected) || badModId !== undefined) {
        const truncatedModId = String(badModId ?? "").substring(0, 50);
        results.push({
          workshopId,
          status: "invalid",
          code: ErrorCode.MODS_INVALID_MOD_ID_FORMAT_TEMPLATE,
          params: sanitizeErrorParams({ modId: truncatedModId }),
        });
        continue;
      }
      valid.push({
        workshopId,
        explicitModIds: selected,
        discover: item.includeAllModIds ? "all" : selected.length > 0 ? "none" : "first",
      });
    }

    // Resolve ids and map folders outside the lock (disk reads, Steam lookups).
    const steamDeadline = performance.now() + ADD_BULK_STEAM_BUDGET_MS;
    const planned = await mapWithConcurrency(
      valid,
      ADD_BULK_RESOLVE_CONCURRENCY,
      async (entry) => {
        const resolution = await resolveModIdsForAddition({
          workshopId: entry.workshopId,
          explicitModIds: entry.explicitModIds,
          discover: entry.discover,
          serverPath,
          allowSteam: performance.now() < steamDeadline,
        });
        const mapFolders = serverPath
          ? findMapFoldersFromWorkshop(entry.workshopId, serverPath)
          : [];
        return { ...entry, resolution, mapFolders };
      },
    );

    // One read, every addition, one write.
    const lockResult = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);
      let changed = false;
      const outcomes = [];
      for (const plan of planned) {
        const applied = addWorkshopItemToIni(content, {
          workshopId: plan.workshopId,
          modIds: plan.resolution.modIds,
          mapFolders: plan.mapFolders,
          serverPath,
        });
        content = applied.content;
        changed ||= applied.changed;
        outcomes.push({ plan, applied });
      }
      let backupWarning = null;
      if (changed) {
        backupWarning = backupWarningFor(await writeIniWithBackup(iniPath, content));
      }
      return { outcomes, backupWarning, changed };
    });

    const mapFoldersAdded = [];
    for (const { plan, applied } of lockResult.outcomes) {
      const status = additionStatus(plan.resolution.modIds.length, applied);
      results.push({
        workshopId: plan.workshopId,
        status,
        addedModIds: applied.addedModIds,
        alternativeModIds: plan.resolution.alternativeModIds,
        mapFoldersAdded: applied.addedMapFolders,
        workshopAlreadyExisted: applied.workshopAlreadyExisted,
        detectionSource: plan.resolution.detectionSource,
      });
      mapFoldersAdded.push(...applied.addedMapFolders);
    }

    if (track) {
      for (const { workshopId } of valid) {
        try {
          await removeIgnoredMod(workshopId);
          await addTrackedMod(workshopId, `Workshop Mod ${workshopId}`);
        } catch {
          // Ignore if already tracked
        }
      }
      // Best-effort: mirror the adds into the configured Steam Workshop
      // collection when auto-sync is enabled. Paced like /batch-remove and
      // never blocks the response.
      (async () => {
        for (const { workshopId } of valid) {
          try {
            await autoSyncCollection("add", workshopId);
          } catch {
            /* logged inside */
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      })().catch(() => {});
    }

    const count = (status) => results.filter((r) => r.status === status).length;
    log.info(
      `Bulk add: ${valid.length} workshop items, ${count("added")} with new mod IDs, ${count("workshop-only")} workshop-only, ${count("already-configured")} already configured, ${count("invalid")} invalid (${lockResult.changed ? "one ini write" : "no ini write"})`,
    );

    res.json({
      success: true,
      total: mods.length,
      added: count("added"),
      alreadyConfigured: count("already-configured"),
      workshopOnly: count("workshop-only"),
      invalid: count("invalid"),
      mapFoldersAdded,
      results,
      ...(lockResult.backupWarning ? { backupWarning: lockResult.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to bulk add mods: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ─── Mod Conflict Scanner ────────────────────────────────────────────────
// Scans all configured workshop mods for file-level conflicts (multiple mods
// overriding the same game file). Similar concept to LOOT for Skyrim.

// Prevent concurrent scans from hammering disk I/O
let conflictScanInFlight = false;
let conflictScanStartedAt = 0;
const SCAN_MUTEX_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// In-memory cache of last scan result (cleared on config changes or after TTL)
let lastScanResult = null;
let lastScanWorkshopSnapshot = null;
let lastScanModSnapshot = null;
let lastScanServerPath = null;

export function createConflictScanSnapshots(workshopIds, modIds) {
  return {
    workshop: workshopIds.slice().sort().join(","),
    mods: modIds.join(","),
  };
}
let lastScanTimestamp = 0;
let scanLockToken = 0;
const SCAN_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Returns a token identifying this scan, or null when a scan is already running.
//
// conflictScanStartedAt uses performance.now() (monotonic), not Date.now()
// (wall clock) -- bug hunt 2026-09-07 (Date.now()-for-elapsed-time sweep):
// the old Date.now()-based version's stuck-mutex auto-reset is a stuck-
// state auto-recovery that can silently stop being able to run -- a wall-
// clock step BACKWARD (NTP correction, DST, a manual clock change) landing
// between conflictScanStartedAt being recorded and a later acquireScanLock()
// call means `Date.now() - conflictScanStartedAt` may never exceed
// SCAN_MUTEX_TIMEOUT_MS again. A genuinely crashed/stuck scan's mutex would
// then never auto-release -- every subsequent scan request gets rejected as
// "already running" until real wall-clock time closes whatever gap the step
// introduced, which for a large correction could be hours. Monotonic time
// cannot step backward, so this comparison can only ever be false because
// not enough real time has actually passed -- matching what the auto-reset
// was written to measure.
// Exported so tests can drive the mutex directly against real
// timers/clocks without needing a full conflict-scan route call -- see
// server/tests/modsScanMutexClockJump.test.js.
export function acquireScanLock() {
  // Auto-reset if stuck for more than 5 minutes (e.g. crash mid-scan)
  if (
    conflictScanInFlight &&
    performance.now() - conflictScanStartedAt > SCAN_MUTEX_TIMEOUT_MS
  ) {
    log.warn("Conflict scan mutex was stuck for >5 min — auto-resetting");
    conflictScanInFlight = false;
  }
  if (conflictScanInFlight) return null;
  conflictScanInFlight = true;
  conflictScanStartedAt = performance.now();
  return ++scanLockToken;
}

// Tokens stop a scan that overran the stuck-mutex timeout from releasing the
// lock out from under the newer scan that replaced it.
export function releaseScanLock(token) {
  if (token !== scanLockToken) return;
  conflictScanInFlight = false;
  conflictScanStartedAt = 0;
}

// Max file size to hash (50 MB) — larger files are treated as different
const HASH_MAX_BYTES = 50 * 1024 * 1024;

const WALK_MAX_DEPTH = 20;
const WALK_MAX_FILES = 50_000;

// Global cap on how many entries buildFileIndex() will accumulate across ALL
// mods combined (panel-oom-buildfileindex-unbounded). WALK_MAX_FILES bounds
// a single mod's walk, but ctx.left is created fresh per top-level walkDir()
// call, so the real ceiling was 50,000 x number of mods -- unbounded by mod
// count. Measured (synthetic, matching the real entry shape -- workshopId +
// modId + modName + absPath strings per entry): ~500 bytes/entry, so a
// heavy modlist (150 mods, several routinely near the per-mod ceiling) can
// reach millions of entries and gigabytes, reproducing the operator's exact
// "Mark-Compact thrashing near the limit, then heap OOM" crash. 300,000
// entries (~150MB worst case) matches the maxEntries budget server.js's
// wipe-preview countDir() already uses for the same class of problem.
export const FILE_INDEX_MAX_ENTRIES = 300_000;
// A single shared path is copied into every affected mod pair for the API.
// With N mods that is N*(N-1)/2 rows, so the bounded file index can still
// expand into millions of pair-file objects and exhaust V8 while grouping or
// serializing the response. Keep the projection bounded independently.
export const CONFLICT_PAIR_FILE_MAX_ENTRIES = 100_000;
const WALK_SKIP_DIRS = new Set([
  ".git",
  ".svn",
  ".hg",
  "__pycache__",
  "node_modules",
  ".vscode",
]);

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    log.debug(`Could not resolve ${p}: ${e.message}`);
    return null;
  }
}

function isInsideRoot(target, root) {
  return target === root || target.startsWith(root + path.sep);
}

// How many directory entries to process between yields to the event loop.
// Measured (mods-conflict-scan-unmeasured-at-scale): a single mod sitting at
// WALK_MAX_FILES (a real, code-enforced ceiling, not a hypothetical one —
// see the truncation branch below) blocked the event loop for ~690ms in one
// synchronous burst, because the old sync walkDir() only ever yielded
// between MODS (buildFileIndex's own loop), never within one mod's walk.
// One large map/texture mod is enough to freeze every other request on the
// panel for that long. Yielding every WALK_YIELD_EVERY entries bounds a
// single burst to a few tens of ms regardless of how large one mod's media
// tree is.
const WALK_YIELD_EVERY = 1000;

// Recursively collect all files under a directory, returning relative paths.
// Guarded with depth and file-count limits to prevent runaway traversal.
// Returns { files: string[], truncated: boolean }
async function walkDir(dir, prefix = "", _depth = 0, _ctx = null) {
  // The budget is shared across the whole recursion; a per-call limit let a
  // deep tree return many times the intended maximum. sinceYield is shared
  // the same way, so the yield cadence is measured across the whole mod's
  // walk, not reset every time recursion descends into a new subdirectory.
  const ctx = _ctx || {
    left: WALK_MAX_FILES,
    root: safeRealpath(dir) || dir,
    sinceYield: 0,
  };
  const results = [];
  let truncated = false;
  if (_depth > WALK_MAX_DEPTH) return { files: results, truncated };
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    log.debug(`walkDir: could not read ${dir}: ${e.message}`);
    return { files: results, truncated };
  }
  for (const entry of entries) {
    if (ctx.left <= 0) {
      truncated = true;
      break;
    }
    if (++ctx.sinceYield >= WALK_YIELD_EVERY) {
      ctx.sinceYield = 0;
      await yieldTick();
    }
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    // readdir reports a symlink as its own type, so a linked folder would
    // otherwise be indexed as if it were a file. Resolve it, and refuse
    // anything that escapes the mod's own media tree.
    if (entry.isSymbolicLink()) {
      const real = safeRealpath(fullPath);
      if (!real || !isInsideRoot(real, ctx.root)) continue;
      try {
        isDirectory = (await fs.promises.stat(real)).isDirectory();
      } catch (e) {
        log.debug(`walkDir: could not stat link ${fullPath}: ${e.message}`);
        continue;
      }
    }
    if (isDirectory) {
      // Skip version-control and metadata directories — never game content
      if (WALK_SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      const sub = await walkDir(fullPath, rel, _depth + 1, ctx);
      results.push(...sub.files);
      if (sub.truncated) truncated = true;
    } else {
      ctx.left--;
      results.push(rel);
    }
  }
  return { files: results, truncated };
}

// Classify a file path into a conflict severity category
function classifyFile(relPath) {
  const lower = relPath.toLowerCase();
  const basename = lower.split("/").pop();

  // ─── Top-level media files (at media/ root) ───
  // sandbox-options.txt: PZ merges option blocks by name — always additive.
  if (basename === "sandbox-options.txt") return "sandbox-options";
  // fileGuidTable.xml: read from every mod's own folder and merged GUID by
  // GUID (ZomboidFileSystem.loadFileGuidTable) — additive.
  if (basename === "fileguidtable.xml") return "fileguidtable";

  // ─── Lua scripts ───
  if (lower.startsWith("lua/")) {
    if (lower.startsWith("lua/server/")) return "lua-server";
    if (lower.startsWith("lua/client/")) return "lua-client";
    // A .lua file under Translate/ is Lua like any other (LoadDirBase runs
    // every .lua under shared/); the rest there are translations.
    if (lower.startsWith("lua/shared/translate/")) {
      return lower.endsWith(".lua") ? "lua-shared" : "translate";
    }
    if (lower.startsWith("lua/shared/")) return "lua-shared";
    return "lua-other";
  }

  // ─── PZ script definitions ───
  if (lower.startsWith("scripts/")) return "scripts";

  // ─── Clothing definitions ───
  // PZ merges all clothing.xml and clothingitems/*.xml files — each mod defines
  // its own clothing items by unique ID. Only overlapping IDs are real conflicts.
  if (lower.startsWith("clothing/")) return "clothing";

  if (lower.startsWith("maps/")) return "maps";
  if (
    lower.startsWith("texturepacks/") ||
    lower.startsWith("textures/") ||
    lower.endsWith(".pack")
  )
    return "textures";
  if (lower.startsWith("ui/")) return "ui-assets";
  if (lower.startsWith("sound/") || lower.startsWith("music/")) return "audio";
  if (
    lower.startsWith("models/") ||
    lower.startsWith("models_x/") ||
    lower.endsWith(".fbx") ||
    lower.endsWith(".x")
  )
    return "models";
  if (lower.endsWith(".png") || lower.endsWith(".jpg")) return "textures";
  if (lower.endsWith(".xml") || lower.endsWith(".txt")) return "data";
  return "other";
}

const SEVERITY_MAP = {
  "lua-server": "high",
  "lua-shared": "high",
  "lua-client": "high",
  "lua-other": "high",
  "lua-cross-file": "high",
  scripts: "medium",
  clothing: "medium",
  "sandbox-options": "low",
  fileguidtable: "low",
  translate: "low",
  maps: "medium",
  textures: "low",
  "ui-assets": "low",
  models: "low",
  audio: "low",
  data: "medium",
  other: "low",
};

const CATEGORY_LABELS = {
  "lua-server": "Server Lua Scripts",
  "lua-shared": "Shared Lua Scripts",
  "lua-client": "Client Lua Scripts",
  "lua-other": "Lua Scripts",
  "lua-cross-file": "Lua Global Redefined (different files)",
  scripts: "Item/Recipe/Vehicle Scripts",
  "scripts-cross-file": "Item/Recipe/Vehicle Definitions (different files)",
  "mod-info": "Declared Incompatible",
  clothing: "Clothing Definitions",
  "sandbox-options": "Sandbox Options",
  fileguidtable: "Mod Editor Metadata",
  translate: "Translation Files",
  maps: "Map Data",
  textures: "Texture Packs",
  "ui-assets": "UI Assets",
  models: "3D Models",
  audio: "Audio",
  data: "Data Files",
  other: "Other Files",
};

// Compare per-mod definition sets for one shared file path.
// `extract` returns a Set of names, or null when the file could not be parsed.
// The two cases are deliberately different: a file that parsed to zero
// definitions genuinely cannot collide with anything, while a file that failed
// to parse tells us nothing and must fail closed so a parser limitation never
// hides a real clash.
// Returns { disjoint, overlapping, inconclusive }.
export function compareDefinitionSets(modEntries, extract) {
  const parsed = [];
  let unparsable = 0;
  for (const entry of modEntries) {
    const defs = extract(entry.absPath);
    if (!defs) {
      unparsable++;
      continue;
    }
    parsed.push({ mod: entry, defs });
  }
  const overlapping = new Set();
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      if (parsed[i].mod.modId === parsed[j].mod.modId) continue;
      // Iterate the smaller set so the cost tracks the cheaper file.
      const [small, large] =
        parsed[i].defs.size <= parsed[j].defs.size
          ? [parsed[i].defs, parsed[j].defs]
          : [parsed[j].defs, parsed[i].defs];
      for (const d of small) if (large.has(d)) overlapping.add(d);
    }
  }
  if (overlapping.size > 0) {
    return {
      disjoint: false,
      overlapping: [...overlapping],
      inconclusive: false,
    };
  }
  const distinctParsedMods = new Set(parsed.map((p) => p.mod.modId)).size;
  const inconclusive = unparsable > 0 || distinctParsedMods < 2;
  return { disjoint: !inconclusive, overlapping: [], inconclusive };
}

// Lua symbols (what two same-path copies both define, shown for a Lua
// override). The scan mutex guarantees one scan at a time, so a module-level
// cache is safe. Cleared at the end of every scan.
const LUA_SYMBOL_CACHE_MAX = 20_000;
const luaSymbolCache = new Map();

function getLuaSymbols(filePath) {
  const cached = luaSymbolCache.get(filePath);
  if (cached !== undefined) return cached;
  const symbols = extractLuaSymbols(filePath);
  if (luaSymbolCache.size < LUA_SYMBOL_CACHE_MAX)
    luaSymbolCache.set(filePath, symbols);
  return symbols;
}

function resetScanCaches() {
  luaSymbolCache.clear();
  // Hashes and parses (validated by size + mtime) are kept for a rescan, then
  // dropped once the scan results themselves would be stale.
  expireConflictFileCacheAfter(SCAN_CACHE_TTL_MS);
}

// Compare Lua files at the same path across multiple mods.
// Returns { overlapping: [...], parsed: number } or null when nothing parsable.
function compareLuaSymbols(modEntries) {
  const symsByMod = [];
  for (const entry of modEntries) {
    const s = getLuaSymbols(entry.absPath);
    if (!s || s.size === 0) continue;
    symsByMod.push({ mod: entry, symbols: s });
  }
  if (symsByMod.length < 2) return null;
  const overlapping = new Set();
  for (let i = 0; i < symsByMod.length; i++) {
    for (let j = i + 1; j < symsByMod.length; j++) {
      if (symsByMod[i].mod.modId === symsByMod[j].mod.modId) continue;
      for (const s of symsByMod[i].symbols)
        if (symsByMod[j].symbols.has(s)) overlapping.add(s);
    }
  }
  return { overlapping: [...overlapping], parsed: symsByMod.length };
}

// ─── Shared scan helpers ────────────────────────────────────────────────────
// Yield to event loop (allows SSE writes, incoming requests, etc.)
const yieldTick = () => new Promise((resolve) => setImmediate(resolve));

const LUA_CATEGORIES = new Set([
  "lua-server",
  "lua-shared",
  "lua-client",
  "lua-other",
]);

// buildFileIndex keeps one entry per mod and path, but two Workshop items can
// declare the same mod id. Pairing and reporting must run on distinct mods or
// a mod ends up listed as conflicting with itself.
function dedupeByModId(entries) {
  const byId = new Map();
  for (const entry of entries) if (!byId.has(entry.modId)) byId.set(entry.modId, entry);
  return [...byId.values()];
}

// Decide whether every mod's copy of one relative path holds the same bytes.
// Sizes are compared first: a size difference already proves the contents
// differ, so genuinely conflicting files are never read at all.
// Returns "identical", "differs" (also used whenever the answer cannot be
// verified, so a real conflict is never hidden), or "unknown" when fewer than
// two copies could be read.
// Hashes are cached by path + size + mtime (utils/modConflictRules.js), so a
// rescan of unchanged mods reads no file twice.
async function compareFileContents(entries) {
  const sized = await Promise.all(
    entries.map(async (entry) => {
      const stat = await statFile(entry.absPath);
      if (!stat) {
        log.debug(`Error reading file size ${entry.absPath}`);
        return null;
      }
      return { entry, size: stat.size, stat };
    }),
  );
  const readable = sized.filter(Boolean);
  const unreadable = sized.length - readable.length;
  if (readable.length < 2) return "unknown";
  if (new Set(readable.map((r) => r.size)).size > 1) return "differs";
  if (readable[0].size > HASH_MAX_BYTES) return "differs";
  const hashes = await Promise.all(
    readable.map((r) => cachedFileHash(r.entry.absPath, r.stat)),
  );
  if (hashes.some((h) => h == null)) return "differs";
  if (new Set(hashes).size > 1) return "differs";
  return unreadable === 0 ? "identical" : "differs";
}

// Sync variant kept for the non-streaming diff endpoint (single-file, already fast)
function hashFileSync(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > HASH_MAX_BYTES) return "too-large";
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("md5").update(buf).digest("hex");
  } catch (e) {
    log.debug(`Error hashing file sync ${filePath}: ${e.message}`);
    return null;
  }
}

// Read INI and return { workshopIds, modIdsFromIni }
async function readIniModLists() {
  const { serverConfigPath, serverName } = await getActiveServerPaths();
  const iniPath = getSanitizedIniPath(serverConfigPath, serverName);
  let workshopIds = [];
  let modIdsFromIni = [];
  if (iniPath && fs.existsSync(iniPath)) {
    const iniContent = readTextFile(iniPath);
    // Widened to tolerate whitespace around "=" -- this is the shared
    // parser behind the conflict scanner (/conflicts, /conflicts/stream),
    // findMissingDeps, and sync-mod-ids' read pass, so a hand-edited
    // "WorkshopItems = ..." / "Mods = ..." line didn't just mis-parse one
    // route, it silently zeroed out workshopIds/modIdsFromIni for every
    // caller of this function -- an empty-modlist result with no error,
    // same bug class this file already fixed at several other call sites
    // (hunt-wave13, 3d1921ad/783672aa) but missed here.
    const wsMatch = iniContent.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
    const modsMatch = iniContent.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
    if (wsMatch && wsMatch[1].trim()) {
      workshopIds = splitIniList(wsMatch[1]);
    }
    if (modsMatch && modsMatch[1].trim()) {
      modIdsFromIni = splitModIdList(modsMatch[1]);
    }
  }
  return { workshopIds, modIdsFromIni };
}

// How many mods' folders are walked at once. One walk is a chain of small
// awaited readdir calls; overlapping a few keeps the fs thread pool busy
// instead of waiting on one round trip at a time. Results are still indexed
// strictly in mod order, so the index (and every winner) is unchanged.
const WALK_CONCURRENCY = 6;

// Build the file index and collect per-mod metadata.
// Calls `onModScanned(modId, modName, wsId, fileCount)` for each mod.
// If `activeModIds` is provided, only mod directories whose ID is in that set are scanned.
// `maxEntries` defaults to the real production cap; tests override it with a
// small value (same pattern as server.js's countDir(dir, budget)) so the cap
// mechanism is provable without a fixture at the real 300,000-entry scale.
//
// Only the folders B42 loads are read (gameMediaDirs: common/ then the newest
// 42.x folder, a root media/ only for the old layout), and each mod gets ONE
// entry per path: the copy the game uses (the version folder's beats
// common/'s), so a mod is never compared with a copy the game never loads.
// `modDetailsByWorkshop` (wsId -> getModDetailsFromWorkshop()) skips reading
// the mod.info files again when the caller already has them.
export async function buildFileIndex(
  workshopIds,
  serverPath,
  onModScanned,
  activeModIds,
  maxEntries = FILE_INDEX_MAX_ENTRIES,
  modDetailsByWorkshop = null,
) {
  const fileIndex = {};
  const modInfoMap = {};
  let modsScanned = 0;
  let modsNotFound = 0;
  let modsSkippedInactive = 0;
  let indexedEntries = 0;
  let indexTruncated = false;
  const warnings = [];
  const totalWorkshopIds = workshopIds.length;
  const activeSet = activeModIds ? new Set(activeModIds) : null;

  // 1. The mod folders to read, in order (synchronous and cheap: mod.info
  // files and folder listings only).
  const jobs = [];
  for (let wsIdx = 0; wsIdx < totalWorkshopIds; wsIdx++) {
    const wsId = workshopIds[wsIdx];
    if (!/^\d{1,15}$/.test(wsId)) {
      warnings.push(`Skipped invalid workshop ID: ${wsId.slice(0, 20)}`);
      continue;
    }
    const possiblePaths = getWorkshopPaths(wsId, serverPath);
    let workshopPath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        workshopPath = p;
        break;
      }
    }
    if (!workshopPath) {
      // Counted in modsNotFound; not pushed to warnings — would otherwise drown out real ones.
      modsNotFound++;
      continue;
    }
    const modDetails =
      modDetailsByWorkshop?.[wsId] || getModDetailsFromWorkshop(wsId, serverPath);
    modInfoMap[wsId] = modDetails;
    const modsFolder = path.join(workshopPath, "mods");
    const searchBase = fs.existsSync(modsFolder) ? modsFolder : workshopPath;
    let modEntries;
    try {
      modEntries = fs.readdirSync(searchBase, { withFileTypes: true });
    } catch (e) {
      log.debug(`Could not read mod directory ${searchBase}: ${e.message}`);
      continue;
    }
    const firstJob = jobs.length;
    for (const modDir of modEntries) {
      if (!modDir.isDirectory()) continue;
      const modDirPath = path.join(searchBase, modDir.name);
      // The media folders B42 loads, in the order it applies them.
      const mediaPaths = gameMediaDirs(modDirPath).dirs;
      if (mediaPaths.length === 0) continue;
      const matchingMod = findModForFolder(modDetails, modDir.name);
      const modId = matchingMod?.id || modDir.name;
      const modName = matchingMod?.name || modDir.name;
      // Skip mod directories that aren't in the active Mods= list
      if (activeSet && !activeSet.has(modId)) {
        modsSkippedInactive++;
        continue;
      }
      jobs.push({ wsIdx, wsId, modId, modName, mediaPaths, modsInWorkshop: 0 });
    }
    if (jobs.length > firstJob) jobs[jobs.length - 1].modsInWorkshop = jobs.length - firstJob;
  }

  // 2. Walk a few mods ahead, index them one by one in order.
  const walks = new Array(jobs.length);
  let started = 0;
  outer: for (let i = 0; i < jobs.length; i++) {
    while (started < jobs.length && started < i + WALK_CONCURRENCY) {
      const job = jobs[started];
      walks[started] = Promise.all(job.mediaPaths.map((mediaPath) => walkDir(mediaPath)));
      started++;
    }
    const job = jobs[i];
    const { wsId, modId, modName } = job;
    const results = await walks[i];
    walks[i] = null;
    modsScanned++;
    let totalFileCount = 0;
    // One entry per path for this mod: the copy the game loads. A later
    // media folder (the version folder) replaces common/'s entry in place.
    const ownEntries = new Map();
    for (let k = 0; k < job.mediaPaths.length; k++) {
      const mediaPath = job.mediaPaths[k];
      const { files, truncated } = results[k];
      if (truncated) {
        warnings.push(
          `${modName} (${wsId}): file scan hit the 50,000 file limit — some files were skipped`,
        );
      }
      totalFileCount += files.length;
      // Measured (mods-conflict-scan-unmeasured-at-scale): this loop, not
      // walkDir() itself, was the real event-loop-blocking cost. A mod at
      // the WALK_MAX_FILES ceiling (50,000 files -- a real, code-enforced
      // case, see the truncation branch above) blocked here for ~316ms in
      // one unbroken synchronous burst, because this loop had no yield of
      // its own; the outer per-mod loop only yields once ALL of a mod's
      // media paths are fully indexed. Same WALK_YIELD_EVERY cadence as
      // walkDir(), so one giant mod can't freeze every other request on
      // the panel for the length of its own indexing.
      let sinceYield = 0;
      for (const relFile of files) {
        // Global cap (panel-oom-buildfileindex-unbounded): WALK_MAX_FILES
        // only bounds ONE mod's walk. Without this, fileIndex keeps
        // accumulating entries across every mod combined, unbounded by mod
        // count — this is the check that actually stops the OOM. Bail out
        // of the whole scan (not just this mod) the moment the cap is hit;
        // continuing to walk further mods after the index is already full
        // just burns more CPU and memory building `files` arrays nothing
        // will use (at most WALK_CONCURRENCY walks are already under way).
        if (indexedEntries >= maxEntries) {
          indexTruncated = true;
          break outer;
        }
        const normalizedPath = relFile.replace(/\\/g, "/").toLowerCase();
        const absPath = path.join(mediaPath, relFile);
        const own = ownEntries.get(normalizedPath);
        if (own) {
          own.absPath = absPath;
          continue;
        }
        if (!fileIndex[normalizedPath]) {
          fileIndex[normalizedPath] = [];
        }
        const entry = { workshopId: wsId, modId, modName, absPath };
        ownEntries.set(normalizedPath, entry);
        fileIndex[normalizedPath].push(entry);
        indexedEntries++;
        if (++sinceYield >= WALK_YIELD_EVERY) {
          sinceYield = 0;
          await yieldTick();
        }
      }
    }
    if (onModScanned)
      onModScanned({
        modId,
        modName,
        workshopId: wsId,
        fileCount: totalFileCount,
        modsScanned,
        totalWorkshopIds,
        wsIdx: job.wsIdx,
      });
    if (job.modsInWorkshop > 0) {
      if (job.modsInWorkshop > 1) {
        log.debug(
          `Workshop ${wsId}: contains ${job.modsInWorkshop} mod dirs (${modInfoMap[wsId]?.map((m) => m.id).join(", ") || "unknown"})`,
        );
      }
      // Yield after each workshop item so SSE writes and incoming requests aren't starved
      await yieldTick();
    }
  }
  if (indexTruncated) {
    // A truncated scan is a wrong answer presented as a complete one unless
    // it says so — both here (a machine-checkable field) and in `warnings`
    // (what the UI already surfaces to the operator, see ConflictsPanel.tsx).
    warnings.push(
      `File index reached the global ${maxEntries.toLocaleString()}-entry limit — the conflict scan is incomplete. Scan fewer mods at once or remove unused ones and retry.`,
    );
  }
  return {
    fileIndex,
    modInfoMap,
    modsScanned,
    modsNotFound,
    modsSkippedInactive,
    truncated: indexTruncated,
    warnings,
  };
}

// ─── Conflict rules ──────────────────────────────────────────────────────
// Each conflict carries, besides file/category/severity/mods/overlap/winner:
//   kind    file-override | lua-override | script-file-override |
//           script-override | translation-override | clothing-override |
//           lua-global-clash | declared-incompatible
//   reason  a stable code the client translates (conflictsPanel reasons.*):
//           assetOverride, mapFileOverride, dataFileOverride, luaFileOverride,
//           scriptFileReplaced, scriptFileOverride, scriptDefinitionOverride,
//           scriptDefinitionMerge, translationKeyOverride,
//           translationUnreadable, clothingOutfitOverride,
//           clothingItemOverride, luaGlobalRedefined, luaVariantClash,
//           declaredIncompatible, intendedPatch, patchLoadsBeforeTarget
//   severity high | medium | low | info (info: an intended override, e.g. a
//           patch that require=s the mod it overrides and loads after it)
//   intended true when the override is a declared patch's (see above);
//           baseReason then keeps the file-level reason it replaced
//   files   [{ modId, file }] for conflicts across different files
// The rules follow what the game loads (utils/modLoadOrder.js header).

const REASON_SEVERITY = {
  assetOverride: null, // per category (SEVERITY_MAP)
  mapFileOverride: "medium",
  dataFileOverride: null,
  luaFileOverride: "high",
  scriptFileReplaced: "high",
  scriptFileOverride: "medium",
  scriptDefinitionOverride: "medium",
  // Layered bodies (vehicle, xuiSkin): only the keys both set differently.
  scriptDefinitionMerge: "low",
  translationKeyOverride: "low",
  translationUnreadable: "low",
  clothingOutfitOverride: "medium",
  clothingItemOverride: "medium",
  luaGlobalRedefined: "medium",
  luaVariantClash: "high",
  declaredIncompatible: "high",
};

const SEVERITY_RANK = { high: 0, medium: 1, low: 2, info: 3 };

function fileOverrideReason(category) {
  if (category === "maps") return "mapFileOverride";
  if (
    category === "data" ||
    category === "other" ||
    category === "clothing" ||
    LUA_CATEGORIES.has(category)
  ) {
    return "dataFileOverride";
  }
  return "assetOverride";
}

// Position of each mod in the order the game loads them; -1 when unknown.
function loadPosition(orderIndex, modId) {
  const pos = orderIndex?.get(modId);
  return pos == null ? -1 : pos;
}

// Entries sorted by load order, earliest first (unknown positions first:
// they cannot be shown to win).
function byLoadOrder(entries, orderIndex) {
  return entries
    .map((entry, i) => ({ entry, i, pos: loadPosition(orderIndex, entry.modId) }))
    .sort((a, b) => a.pos - b.pos || a.i - b.i)
    .map((x) => x.entry);
}

function modRef(m) {
  return { workshopId: m.workshopId, modId: m.modId, modName: m.modName };
}

function overlapOf(kind, items) {
  const unique = [...new Set(items)];
  return unique.length > 0
    ? { kind, items: unique.slice(0, 50), total: unique.length }
    : undefined;
}

// The winner of a conflict: the mod among it that loads last in the order the
// game really uses (the effective order: Mods= with required mods loaded
// first). null when no mod has a known position.
function winnerOf(conflict, orderIndex) {
  let best = -1;
  let winner = null;
  for (const m of conflict.mods) {
    const pos = loadPosition(orderIndex, m.modId);
    if (pos > best) {
      best = pos;
      winner = m;
    }
  }
  return winner ? modRef(winner) : null;
}

/**
 * Re-rates one pair of a conflict when one mod declares it builds on the
 * other (require=, loadModAfter=, the other's loadModBefore=, directly or
 * through other mods): overriding the target is then the point of the patch
 * (severity info, reason intendedPatch) -- as long as the patch loads after
 * its target, otherwise its changes are lost (high, patchLoadsBeforeTarget).
 * Returns null when the pair is unrelated.
 */
export function classifyConflictPair(conflict, idA, idB, dependsOn, orderIndex) {
  if (!dependsOn || conflict.kind === "declared-incompatible") return null;
  const aOnB = dependsOn(idA, idB);
  const bOnA = dependsOn(idB, idA);
  if (!aOnB && !bOnA) return null;
  const patch = aOnB ? idA : idB;
  const target = patch === idA ? idB : idA;
  const patchPos = loadPosition(orderIndex, patch);
  const targetPos = loadPosition(orderIndex, target);
  if (patchPos < 0 || targetPos < 0) return null; // one of them does not load
  if (patchPos > targetPos) {
    return { severity: "info", reason: "intendedPatch", intended: true, patch, target };
  }
  return { severity: "high", reason: "patchLoadsBeforeTarget", intended: false, patch, target };
}

// Sets the winner (unless the detector already knows it) and re-rates a
// two-mod conflict that is a declared patch's override.
function makeFinalizer(orderIndex, dependsOn) {
  return (conflict) => {
    if (conflict.winner === undefined) conflict.winner = winnerOf(conflict, orderIndex);
    const ids = [...new Set(conflict.mods.map((m) => m.modId))];
    if (ids.length !== 2) return conflict;
    const rated = classifyConflictPair(conflict, ids[0], ids[1], dependsOn, orderIndex);
    if (rated) {
      conflict.baseSeverity = conflict.severity;
      conflict.baseReason = conflict.reason;
      conflict.severity = rated.severity;
      conflict.reason = rated.reason;
      conflict.intended = rated.intended;
    }
    return conflict;
  };
}

// The copy of a shared path the game loads: the last mod's.
function loadedCopy(entries, orderIndex) {
  const ordered = byLoadOrder(entries, orderIndex);
  return ordered[ordered.length - 1];
}

// Detect conflicts from a file index. Calls `onConflictFound(conflict)` for each.
// options: shouldAbort, onProgress, orderIndex (Map modId -> load position,
// the effective order), dependsOn (createDependencyRelation()).
async function detectConflicts(fileIndex, onConflictFound, options = {}) {
  const { shouldAbort, onProgress, orderIndex = new Map(), dependsOn = null } = options;
  const finalize = makeFinalizer(orderIndex, dependsOn);
  const conflicts = [];
  let identicalSkipped = 0;
  let additiveSkipped = 0;
  let pzAdditiveSkipped = 0; // PZ-specific additive files (sandbox, scripts, clothing, metadata)
  const pzAdditiveBreakdown = {
    sandbox: 0,
    scripts: 0,
    clothing: 0,
    fileguidtable: 0,
    translate: 0,
  };
  // Shared paths that are not conflicts for another reason than identical
  // bytes: never read by the game, or the same definitions written
  // differently.
  const benignSkipped = { nonGameplay: 0, notLoaded: 0, sameDefinitions: 0, layeredAdditions: 0 };
  const emit = (conflict) => {
    finalize(conflict);
    conflicts.push(conflict);
    if (onConflictFound) onConflictFound(conflict);
  };
  let processed = 0;
  const indexEntries = Object.entries(fileIndex);
  for (const [filePath, mods] of indexEntries) {
    if (shouldAbort && shouldAbort()) break;
    if (mods.length < 2) continue;
    const distinctMods = dedupeByModId(mods);
    if (distinctMods.length < 2) continue;

    // Workshop metadata, documentation, VCS files: the game never reads them.
    if (isNonGameplayMediaFile(filePath)) {
      benignSkipped.nonGameplay++;
      continue;
    }
    const category = classifyFile(filePath);

    // sandbox-options.txt and fileGuidTable.xml are read from each mod's own
    // folder and merged entry by entry (CustomSandboxOptions,
    // ZomboidFileSystem.loadFileGuidTable): additive whatever they contain,
    // so skip them before reading 34+ copies only to discard the answer.
    if (category === "sandbox-options" || category === "fileguidtable") {
      pzAdditiveSkipped++;
      pzAdditiveBreakdown[
        category === "sandbox-options" ? "sandbox" : "fileguidtable"
      ]++;
      continue;
    }
    // B42 reads translations from Translate/<LANG>/*.json only; the B41 .txt
    // files are never loaded. Script files outside .txt are never parsed.
    const translation = category === "translate" ? translationPathInfo(filePath) : null;
    if (
      (category === "translate" && !translation?.json) ||
      (category === "scripts" && !filePath.endsWith(".txt"))
    ) {
      benignSkipped.notLoaded++;
      continue;
    }

    const contentState = await compareFileContents(distinctMods);
    if (++processed % 25 === 0) {
      if (onProgress) onProgress({ processed, total: indexEntries.length });
      await yieldTick();
    }
    // "unknown" means too few copies were readable to conclude anything.
    if (contentState === "unknown") continue;
    if (contentState === "identical") {
      identicalSkipped++;
      continue;
    }

    const ordered = byLoadOrder(distinctMods, orderIndex);
    const base = {
      file: filePath,
      category,
      categoryLabel: CATEGORY_LABELS[category] || category,
      identical: false,
      mods: distinctMods.map(modRef),
    };

    // Translations merge key by key (Translator.tryFillMapFromMods): two
    // mods shipping the same file is harmless, only the same key with a
    // different non-empty value is a conflict. Unreadable: fail closed.
    if (category === "translate") {
      const comparison = compareTranslationEntries(
        ordered.map((m) => ({
          modId: m.modId,
          entries: cachedParse("translation", m.absPath, extractTranslationEntries) ?? null,
        })),
      );
      if (!comparison.unreadable && comparison.conflicting.length === 0) {
        additiveSkipped++;
        pzAdditiveBreakdown.translate++;
        continue;
      }
      // Only the mods that give a clashing key a value are in the conflict;
      // the others shipping this file just add their own keys.
      const involved = new Set(comparison.unreadable ? distinctMods.map((m) => m.modId) : comparison.modIds);
      emit({
        ...base,
        mods: distinctMods.filter((m) => involved.has(m.modId)).map(modRef),
        severity: "low",
        kind: "translation-override",
        reason: comparison.conflicting.length > 0 ? "translationKeyOverride" : "translationUnreadable",
        overlap: overlapOf("translation-keys", comparison.conflicting),
      });
      continue;
    }

    // Scripts: only the winner's copy of a shared path is parsed
    // (ScriptManager.Load). What the other copies define is gone unless the
    // winner defines it too.
    if (category === "scripts") {
      const winner = ordered[ordered.length - 1];
      const winnerDefs = cachedParse("scriptDefs", winner.absPath, extractScriptDefinitionBodies);
      let unreadable = !winnerDefs;
      const lost = [];
      const overridden = [];
      // The winner, plus every copy that loses something by being dropped
      // (a copy defining exactly what the winner defines loses nothing).
      const involved = new Set([winner.modId]);
      for (const loser of ordered.slice(0, -1)) {
        const loserDefs = cachedParse("scriptDefs", loser.absPath, extractScriptDefinitionBodies);
        if (!loserDefs || !winnerDefs) {
          unreadable = true;
          involved.add(loser.modId);
          continue;
        }
        const comparison = compareScriptFileCopies(winnerDefs, loserDefs);
        if (comparison.lost.length > 0 || comparison.overridden.length > 0) involved.add(loser.modId);
        lost.push(...comparison.lost);
        overridden.push(...comparison.overridden);
      }
      if (!unreadable && lost.length === 0 && overridden.length === 0) {
        benignSkipped.sameDefinitions++;
        continue;
      }
      const replaced = unreadable || lost.length > 0;
      emit({
        ...base,
        mods: distinctMods.filter((m) => involved.has(m.modId)).map(modRef),
        severity: replaced ? "high" : "medium",
        kind: "script-file-override",
        reason: replaced ? "scriptFileReplaced" : "scriptFileOverride",
        overlap: overlapOf("script-defs", lost.length > 0 ? lost : overridden),
      });
      continue;
    }

    // clothing.xml is read from each mod and merged outfit by outfit
    // (OutfitManager); clothingItems/*.xml load through the path map, so a
    // shared path is the same item replaced.
    if (category === "clothing") {
      if (filePath === "clothing/clothing.xml") {
        const byOutfit = new Map(); // outfit -> Map(modId -> digest)
        let unreadable = false;
        for (const m of ordered) {
          const outfits = cachedParse("outfits", m.absPath, extractClothingOutfits);
          if (!outfits) {
            unreadable = true;
            continue;
          }
          for (const [name, hash] of outfits) {
            if (!byOutfit.has(name)) byOutfit.set(name, new Map());
            byOutfit.get(name).set(m.modId, hash);
          }
        }
        const clashing = [];
        const involved = new Set();
        for (const [name, byMod] of byOutfit) {
          if (new Set(byMod.values()).size < 2) continue;
          clashing.push(name);
          for (const modId of byMod.keys()) involved.add(modId);
        }
        if (!unreadable && clashing.length === 0) {
          pzAdditiveSkipped++;
          pzAdditiveBreakdown.clothing++;
          continue;
        }
        emit({
          ...base,
          mods: unreadable ? base.mods : distinctMods.filter((m) => involved.has(m.modId)).map(modRef),
          severity: "medium",
          kind: "clothing-override",
          reason: "clothingOutfitOverride",
          overlap: overlapOf("clothing-items", clashing),
        });
        continue;
      }
      if (filePath.startsWith("clothing/clothingitems/")) {
        emit({
          ...base,
          severity: "medium",
          kind: "clothing-override",
          reason: "clothingItemOverride",
        });
        continue;
      }
    }

    // Lua: one copy of a path runs, the winner's (LuaManager.LoadDirBase);
    // every other copy is never executed. Always a real override.
    if (LUA_CATEGORIES.has(category) && filePath.endsWith(".lua")) {
      const luaOverlap = compareLuaSymbols(distinctMods);
      emit({
        ...base,
        severity: "high",
        kind: "lua-override",
        reason: "luaFileOverride",
        overlap:
          luaOverlap && luaOverlap.overlapping.length > 0
            ? overlapOf("lua-symbols", luaOverlap.overlapping)
            : { kind: "lua-shadow", items: [], total: 0 },
      });
      continue;
    }

    // Any other file: the path map keeps the last mod's copy. A non-Lua file
    // under lua/ is never executed, only possibly read as data.
    const reason = fileOverrideReason(category);
    emit({
      ...base,
      severity:
        REASON_SEVERITY[reason] ||
        (LUA_CATEGORIES.has(category) ? "medium" : SEVERITY_MAP[category]) ||
        "low",
      kind: "file-override",
      reason,
    });
  }
  return {
    conflicts,
    identicalSkipped,
    additiveSkipped,
    pzAdditiveSkipped,
    pzAdditiveBreakdown,
    benignSkipped,
  };
}

function crossFileLabel(files) {
  const unique = [...new Set(files)];
  if (unique.length <= 3) return unique.join(" ↔ ");
  return `${unique.slice(0, 2).join(" ↔ ")} ↔ … (+${unique.length - 2})`;
}

// Script definitions across DIFFERENT files: the game merges every script
// file it parses by module + type + name, a later body replacing the earlier
// (vehicle / xuiSkin bodies are layered). Only the copies the game parses
// count (a shared path's winner). Same name and same body: harmless; a name
// only one mod defines: an addition, not a conflict.
async function detectScriptDefinitionConflicts(fileIndex, emitConflict, options = {}) {
  const { shouldAbort, orderIndex = new Map() } = options;
  const defsByName = new Map();
  let parsed = 0;
  for (const [relPath, entries] of Object.entries(fileIndex)) {
    if (shouldAbort && shouldAbort()) break;
    if (!relPath.startsWith("scripts/") || !relPath.endsWith(".txt")) continue;
    const copy = loadedCopy(dedupeByModId(entries), orderIndex);
    if (++parsed % 50 === 0) await yieldTick();
    const defs = cachedParse("scriptDefs", copy.absPath, extractScriptDefinitionBodies);
    if (!defs) continue;
    for (const [name, def] of defs) {
      if (!defsByName.has(name)) defsByName.set(name, new Map());
      const byMod = defsByName.get(name);
      if (def.merged && def.layers) {
        // A layered body: every file of the mod adds its keys (a later
        // file's key on top of an earlier one's).
        const prev = byMod.get(copy.modId);
        const layers = prev?.layers || new Map();
        for (const [layerKey, hash] of def.layers) layers.set(layerKey, { hash, entry: copy, file: relPath });
        byMod.set(copy.modId, { entry: prev?.entry || copy, file: prev?.file || relPath, hash: def.hash, merged: true, layers });
        continue;
      }
      // Within one mod the later file (game order: sorted path) wins.
      byMod.set(copy.modId, { entry: copy, file: relPath, hash: def.hash, merged: def.merged });
    }
  }
  // One conflict per pair of mods (and files) whose bodies of a name differ;
  // two mods writing the same body agree and are no conflict. The winner is
  // the mod whose body the game ends up with (the last of ALL that define
  // the name), so a third mod can win a pair. Layered bodies (vehicle,
  // xuiSkin) only clash on the keys both set differently (low): two mods
  // each adding their own entity style to "xuiSkin default" add up.
  let sameDefinitions = 0;
  let layeredAdditions = 0;
  const pairs = new Map();
  const pairFor = (x, y, merged, winner) => {
    const [a, b] = x.modId < y.modId ? [x, y] : [y, x];
    const key = `${a.modId}\u0000${a.file}\u0001${b.modId}\u0000${b.file}`;
    if (!pairs.has(key)) pairs.set(key, { a, b, items: [], merged, winner });
    const pair = pairs.get(key);
    if (!merged) pair.merged = false;
    return pair;
  };
  for (const [name, byMod] of defsByName) {
    if (byMod.size < 2) continue;
    const defs = byLoadOrder([...byMod.values()].map((d) => ({ ...d, modId: d.entry.modId })), orderIndex);
    if (defs.every((d) => d.layers)) {
      let clashed = false;
      for (let i = 0; i < defs.length; i++) {
        for (let j = i + 1; j < defs.length; j++) {
          const keys = compareLayeredDefinitions(defs[i].layers, defs[j].layers);
          if (keys.length === 0) continue;
          clashed = true;
          // The files that set the first clashing key, and the mod whose
          // value the game ends up with (the last of ALL that set it).
          const at = (d) => ({ ...d, entry: d.layers.get(keys[0]).entry, file: d.layers.get(keys[0]).file });
          const setters = defs.filter((d) => d.layers.has(keys[0]));
          const pair = pairFor(at(defs[i]), at(defs[j]), true, setters[setters.length - 1].layers.get(keys[0]).entry);
          for (const k of keys) pair.items.push(`${name} › ${k.startsWith("=") ? k.slice(1) : k}`);
        }
      }
      if (clashed) continue;
      if (new Set(defs.map((d) => d.hash)).size === 1) sameDefinitions++;
      else layeredAdditions++;
      continue;
    }
    if (new Set(defs.map((d) => d.hash)).size === 1) {
      sameDefinitions++;
      continue;
    }
    const finalDef = defs[defs.length - 1];
    for (let i = 0; i < defs.length; i++) {
      for (let j = i + 1; j < defs.length; j++) {
        if (defs[i].hash === defs[j].hash) continue;
        const pair = pairFor(defs[i], defs[j], false, finalDef.entry);
        pair.items.push(name);
      }
    }
  }
  let emitted = 0;
  for (const pair of pairs.values()) {
    if (shouldAbort && shouldAbort()) break;
    const files = [
      { modId: pair.a.modId, file: pair.a.file },
      { modId: pair.b.modId, file: pair.b.file },
    ];
    emitConflict({
      file: crossFileLabel(files.map((f) => f.file)),
      category: "scripts-cross-file",
      categoryLabel: CATEGORY_LABELS["scripts-cross-file"],
      severity: pair.merged ? REASON_SEVERITY.scriptDefinitionMerge : REASON_SEVERITY.scriptDefinitionOverride,
      identical: false,
      crossFile: true,
      kind: "script-override",
      reason: pair.merged ? "scriptDefinitionMerge" : "scriptDefinitionOverride",
      overlap: overlapOf("script-defs", pair.items),
      files,
      mods: [modRef(pair.a.entry), modRef(pair.b.entry)],
      winner: modRef(pair.winner),
    });
    if (++emitted % 20 === 0) await yieldTick();
  }
  return { sameDefinitions, layeredAdditions };
}

// A global name defined by more mods than this is reported for the first ones
// only, so one name every mod touches cannot explode into N² pairs.
const LUA_GLOBAL_MAX_MODS = 64;

// Global Lua names redefined from DIFFERENT files by different mods: whichever
// file runs last replaces the other's function or table (possible clobbering;
// chained hooks that keep the original are not counted, see
// extractLuaGlobals). Two mod ids from the SAME Workshop item doing it are
// usually variants meant to be picked one at a time (TombBodyTexNUDE /
// TombBodyTexDOLL): high. Pairs that already clash on a same-path Lua file
// are skipped (that file is the bigger problem).
async function detectLuaGlobalClashes(fileIndex, existingConflicts, emitConflict, options = {}) {
  const { shouldAbort, orderIndex = new Map() } = options;
  const coveredPairs = new Set();
  for (const c of existingConflicts) {
    if (c.kind !== "lua-override") continue;
    const ids = [...new Set(c.mods.map((m) => m.modId))].sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) coveredPairs.add(`${ids[i]}|${ids[j]}`);
    }
  }
  // symbol -> Map(modId -> { entry, file })
  const bySymbol = new Map();
  let parsed = 0;
  for (const [relPath, entries] of Object.entries(fileIndex)) {
    if (shouldAbort && shouldAbort()) break;
    if (!LUA_CATEGORIES.has(classifyFile(relPath)) || !relPath.endsWith(".lua")) continue;
    const copy = loadedCopy(dedupeByModId(entries), orderIndex);
    if (++parsed % 50 === 0) await yieldTick();
    const globals = cachedParse("luaGlobals", copy.absPath, extractLuaGlobals);
    if (!globals) continue;
    for (const symbol of globals) {
      if (!bySymbol.has(symbol)) bySymbol.set(symbol, new Map());
      const byMod = bySymbol.get(symbol);
      if (!byMod.has(copy.modId) && byMod.size < LUA_GLOBAL_MAX_MODS) {
        byMod.set(copy.modId, { entry: copy, file: relPath });
      }
    }
  }
  const pairs = new Map();
  for (const [symbol, byMod] of bySymbol) {
    if (byMod.size < 2) continue;
    const defs = [...byMod.values()];
    for (let i = 0; i < defs.length; i++) {
      for (let j = i + 1; j < defs.length; j++) {
        const [a, b] = defs[i].entry.modId < defs[j].entry.modId ? [defs[i], defs[j]] : [defs[j], defs[i]];
        const pairKey = `${a.entry.modId}|${b.entry.modId}`;
        if (coveredPairs.has(pairKey)) continue;
        if (!pairs.has(pairKey)) pairs.set(pairKey, { a, b, items: [] });
        pairs.get(pairKey).items.push(symbol);
      }
    }
  }
  let emitted = 0;
  for (const { a, b, items } of pairs.values()) {
    if (shouldAbort && shouldAbort()) break;
    const sameWorkshop = a.entry.workshopId === b.entry.workshopId;
    emitConflict({
      file: a.file === b.file ? a.file : `${a.file} ↔ ${b.file}`,
      category: "lua-cross-file",
      categoryLabel: CATEGORY_LABELS["lua-cross-file"],
      severity: sameWorkshop ? "high" : "medium",
      identical: false,
      crossFile: true,
      kind: "lua-global-clash",
      reason: sameWorkshop ? "luaVariantClash" : "luaGlobalRedefined",
      overlap: overlapOf("lua-symbols", items),
      files: [
        { modId: a.entry.modId, file: a.file },
        { modId: b.entry.modId, file: b.file },
      ],
      mods: [modRef(a.entry), modRef(b.entry)],
    });
    if (++emitted % 20 === 0) await yieldTick();
  }
}

// Mods that declare each other incompatible= and both load (the main menu
// refuses the pair; the server loads both).
function detectDeclaredIncompatibilities(effectiveOrder, modInfoMap, emitConflict) {
  const refs = new Map();
  const mods = [];
  for (const [wsId, details] of Object.entries(modInfoMap)) {
    for (const mod of details) {
      if (refs.has(mod.id)) continue;
      refs.set(mod.id, { workshopId: wsId, modId: mod.id, modName: mod.name || mod.id });
      mods.push(mod);
    }
  }
  for (const pair of findIncompatiblePairs(effectiveOrder, mods)) {
    if (!refs.has(pair.a) || !refs.has(pair.b)) continue;
    emitConflict({
      file: "mod.info",
      category: "mod-info",
      categoryLabel: CATEGORY_LABELS["mod-info"],
      severity: "high",
      identical: false,
      kind: "declared-incompatible",
      reason: "declaredIncompatible",
      declaredBy: pair.declaredBy,
      mods: [refs.get(pair.a), refs.get(pair.b)],
    });
  }
}

// Group flat conflict list into mod pairs with a global output budget.
// options.classifyPair(conflict, idA, idB) may re-rate one pair's entry
// ({ severity, reason, intended } or null), e.g. an intended patch.
export function groupIntoPairs(
  conflicts,
  maxFileEntries = CONFLICT_PAIR_FILE_MAX_ENTRIES,
  options = {},
) {
  const { classifyPair } = options;
  const pairConflicts = {};
  let groupedFileEntries = 0;
  let truncated = false;
  outer: for (const conflict of conflicts) {
    // Deduplicate first: a repeated mod ID would otherwise produce an "A vs A"
    // self-pair and double-count every real pair it appears in.
    const modIds = [...new Set(conflict.mods.map((m) => m.modId))].sort();
    for (let i = 0; i < modIds.length; i++) {
      for (let j = i + 1; j < modIds.length; j++) {
        if (groupedFileEntries >= maxFileEntries) {
          truncated = true;
          break outer;
        }
        const pairKey = `${modIds[i]}|${modIds[j]}`;
        if (!pairConflicts[pairKey]) {
          pairConflicts[pairKey] = {
            modA: conflict.mods.find((m) => m.modId === modIds[i]),
            modB: conflict.mods.find((m) => m.modId === modIds[j]),
            files: [],
            highCount: 0,
            mediumCount: 0,
            lowCount: 0,
            infoCount: 0,
            aWins: 0,
            bWins: 0,
            thirdPartyWins: 0,
            unknownWins: 0,
          };
        }
        let severity = conflict.severity;
        let reason = conflict.reason;
        let intended = conflict.intended;
        let baseReason = conflict.baseReason;
        if (classifyPair && modIds.length > 2) {
          const rated = classifyPair(conflict, modIds[i], modIds[j]);
          if (rated) {
            ({ severity, reason, intended } = rated);
            baseReason = conflict.reason;
          }
        }
        const fileEntry = {
          file: conflict.file,
          category: conflict.category,
          categoryLabel: conflict.categoryLabel,
          severity,
          winner: conflict.winner || null,
          overlap: conflict.overlap || null,
        };
        if (conflict.kind) fileEntry.kind = conflict.kind;
        if (reason) fileEntry.reason = reason;
        // The file-level reason a patch re-rating replaced (intendedPatch /
        // patchLoadsBeforeTarget), e.g. luaFileOverride.
        if (baseReason && baseReason !== reason) fileEntry.baseReason = baseReason;
        if (intended != null) fileEntry.intended = intended;
        if (conflict.files) {
          fileEntry.files = conflict.files.filter(
            (f) => f.modId === modIds[i] || f.modId === modIds[j],
          );
        }
        pairConflicts[pairKey].files.push(fileEntry);
        groupedFileEntries++;
        const severityKey = `${severity}Count`;
        if (severityKey in pairConflicts[pairKey])
          pairConflicts[pairKey][severityKey]++;
        // Per-file winner tally for the pair card
        if (conflict.winner == null) pairConflicts[pairKey].unknownWins++;
        else if (conflict.winner.modId === modIds[i])
          pairConflicts[pairKey].aWins++;
        else if (conflict.winner.modId === modIds[j])
          pairConflicts[pairKey].bWins++;
        else pairConflicts[pairKey].thirdPartyWins++;
      }
    }
  }
  return {
    pairs: Object.values(pairConflicts).sort(
      (a, b) =>
        b.highCount - a.highCount ||
        b.mediumCount - a.mediumCount ||
        b.files.length - a.files.length,
    ),
    truncated,
    groupedFileEntries,
  };
}

// Winners of the last scan's pairs, as { winner, loser } for the "keep the
// current winner" ordering rule; only while that scan matches the config.
function cachedConflictWinners(workshopIds, modIds, serverPath) {
  if (!lastScanResult || Date.now() - lastScanTimestamp > SCAN_CACHE_TTL_MS) return [];
  const snapshot = createConflictScanSnapshots(workshopIds, modIds);
  if (
    snapshot.workshop !== lastScanWorkshopSnapshot ||
    snapshot.mods !== lastScanModSnapshot ||
    serverPath !== lastScanServerPath
  ) {
    return [];
  }
  return conflictWinnersFromPairs(lastScanResult.pairs);
}

// The pairs of the last scan that share gameplay files (not only intended
// overrides), as [modA, modB]; only while that scan matches the config. The
// load-order planner keeps the later one of each pair later.
export function cachedConflictPairs(workshopIds, modIds, serverPath) {
  if (!lastScanResult || Date.now() - lastScanTimestamp > SCAN_CACHE_TTL_MS) return [];
  const snapshot = createConflictScanSnapshots(workshopIds, modIds);
  if (
    snapshot.workshop !== lastScanWorkshopSnapshot ||
    snapshot.mods !== lastScanModSnapshot ||
    serverPath !== lastScanServerPath
  ) {
    return [];
  }
  const pairs = [];
  for (const pair of lastScanResult.pairs || []) {
    const a = pair.modA?.modId;
    const b = pair.modB?.modId;
    if (!a || !b || a === b) continue;
    if (!pair.files.some((f) => f.severity !== "info" && f.kind !== "declared-incompatible")) continue;
    pairs.push([a, b]);
  }
  return pairs;
}

export function conflictWinnersFromPairs(pairs) {
  const winners = [];
  for (const pair of pairs || []) {
    const a = pair.modA?.modId;
    const b = pair.modB?.modId;
    if (!a || !b) continue;
    const real = pair.files.filter((f) => f.severity !== "info");
    const aWins = real.some((f) => f.winner?.modId === a);
    const bWins = real.some((f) => f.winner?.modId === b);
    if (aWins && !bWins) winners.push({ winner: a, loser: b });
    else if (bWins && !aWins) winners.push({ winner: b, loser: a });
  }
  return winners;
}

// Everything a scan computes after the file index: the conflicts (per path,
// across script files, across Lua files, declared incompatible), winners on
// the effective order, intended patches re-rated, pairs. Shared by GET
// /conflicts and /conflicts/stream.
async function analyzeConflicts(fileIndex, modInfoMap, order, callbacks = {}) {
  const { onConflictFound, onProgress, shouldAbort, onPhase } = callbacks;
  const knownMods = Object.values(modInfoMap).flat();
  const dependsOn = createDependencyRelation(knownMods);
  const orderIndex = new Map(order.effectiveModOrder.map((id, i) => [id, i]));
  const finalize = makeFinalizer(orderIndex, dependsOn);
  const detected = await detectConflicts(fileIndex, onConflictFound, {
    shouldAbort,
    onProgress,
    orderIndex,
    dependsOn,
  });
  const { conflicts } = detected;
  if (shouldAbort && shouldAbort()) {
    return { ...detected, pairs: [], truncated: false, groupedFileEntries: 0, knownMods };
  }
  if (onPhase) onPhase("grouping");
  const emit = (conflict) => {
    finalize(conflict);
    conflicts.push(conflict);
    if (onConflictFound) onConflictFound(conflict);
  };
  const { sameDefinitions, layeredAdditions } = await detectScriptDefinitionConflicts(fileIndex, emit, {
    shouldAbort,
    orderIndex,
  });
  detected.benignSkipped.sameDefinitions += sameDefinitions;
  detected.benignSkipped.layeredAdditions += layeredAdditions;
  await detectLuaGlobalClashes(fileIndex, [...conflicts], emit, { shouldAbort, orderIndex });
  detectDeclaredIncompatibilities(order.effectiveModOrder, modInfoMap, emit);
  conflicts.sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4) ||
      a.file.localeCompare(b.file),
  );
  const grouped = groupIntoPairs(conflicts, CONFLICT_PAIR_FILE_MAX_ENTRIES, {
    classifyPair: (conflict, idA, idB) =>
      classifyConflictPair(conflict, idA, idB, dependsOn, orderIndex),
  });
  return { ...detected, ...grouped, knownMods };
}

// Reads every configured Workshop item's mod.info once and works out the
// order the server really loads Mods= in. The scan covers every Mods= entry
// plus the required mods the game loads although Mods= does not list them.
function prepareScanOrder(workshopIds, modIdsFromIni, serverPath) {
  const modDetailsByWorkshop = {};
  const knownMods = [];
  for (const wsId of workshopIds) {
    if (!/^\d{1,15}$/.test(wsId)) continue;
    const details = getModDetailsFromWorkshop(wsId, serverPath);
    modDetailsByWorkshop[wsId] = details;
    knownMods.push(...details);
  }
  const order = analyzeModOrder(modIdsFromIni, knownMods);
  const activeModIds = [...new Set([...modIdsFromIni, ...order.effectiveModOrder])];
  return { modDetailsByWorkshop, order, activeModIds };
}

// The scan response. Existing fields keep their meaning (modLoadOrder is
// still the Mods= line); the rule fields are new:
//   effectiveModOrder, orderWarnings, orderingConstraints (see
//   utils/modLoadOrder.js analyzeModOrder), benignSkipped
//   { nonGameplay, notLoaded, sameDefinitions }, severityCounts
//   { high, medium, low, info } over all conflicts.
function buildScanResult({
  analysis,
  modsScanned,
  modsNotFound,
  modsSkippedInactive,
  workshopIds,
  missingDeps,
  steamDeps,
  idCollisions,
  modIdsFromIni,
  order,
  truncated,
  warnings,
  scanStart,
}) {
  const { conflicts, pairs } = analysis;
  const severityCounts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const c of conflicts) {
    if (c.severity in severityCounts) severityCounts[c.severity]++;
  }
  return {
    totalConflicts: conflicts.length,
    identicalSkipped: analysis.identicalSkipped,
    additiveSkipped: analysis.additiveSkipped,
    pzAdditiveSkipped: analysis.pzAdditiveSkipped,
    pzAdditiveBreakdown: analysis.pzAdditiveBreakdown,
    benignSkipped: analysis.benignSkipped,
    severityCounts,
    pairs,
    totalPairs: pairs.length,
    modsScanned,
    modsNotFound,
    modsSkippedInactive,
    totalWorkshopIds: workshopIds.length,
    missingDeps,
    steamDeps,
    idCollisions,
    modLoadOrder: modIdsFromIni,
    effectiveModOrder: order.effectiveModOrder,
    orderWarnings: order.orderWarnings,
    orderingConstraints: computeOrderingConstraints(analysis.knownMods, {
      conflictWinners: conflictWinnersFromPairs(pairs),
    }),
    truncated,
    warnings,
    scanDurationMs: Date.now() - scanStart,
  };
}

// Detect cases where multiple workshop items declare the same internal mod id.
// PZ loads only one of them (whichever is listed first / found first), the others
// are silently ignored. Highly common cause of "my mod isn't working" issues.
function findIdCollisions(modInfoMap, modIdsFromIni) {
  const activeSet = new Set(modIdsFromIni);
  const byModId = new Map();
  for (const [wsId, details] of Object.entries(modInfoMap)) {
    for (const mod of details) {
      if (!byModId.has(mod.id)) byModId.set(mod.id, []);
      byModId.get(mod.id).push({
        workshopId: wsId,
        modName: mod.name,
        active: activeSet.has(mod.id),
      });
    }
  }
  const collisions = [];
  for (const [modId, sources] of byModId.entries()) {
    // Distinct workshop IDs declaring the same mod id
    const distinctWs = [
      ...new Map(sources.map((s) => [s.workshopId, s])).values(),
    ];
    if (distinctWs.length > 1) {
      collisions.push({
        modId,
        active: distinctWs.some((s) => s.active),
        sources: distinctWs,
      });
    }
  }
  return collisions;
}

// Compute missing dependencies, then try to resolve each to a workshop ID by scanning all downloaded folders
function findMissingDeps(modInfoMap, modIdsFromIni, serverPath) {
  const activeModSet = new Set(modIdsFromIni);
  const dependencies = {};
  for (const [wsId, details] of Object.entries(modInfoMap)) {
    for (const mod of details) {
      // Only check deps for mods actually active in the Mods= INI line
      if (mod.require?.length > 0 && activeModSet.has(mod.id)) {
        dependencies[mod.id] = {
          modId: mod.id,
          modName: mod.name,
          workshopId: wsId,
          requires: mod.require,
        };
      }
    }
  }
  // Vanilla PZ modules — always available, never in WorkshopItems. Both B41 and B42
  // module names included (some mods reference lowercase variants).
  const builtInMods = new Set([
    "Base",
    "base",
    "Farming",
    "Radio",
    "Camping",
    "Trapping",
    "Fishing",
    "Foraging",
    "Erosion",
    // B42 additions
    "Animal",
    "NPCs",
    "Seasons",
    "FireFighting",
    "FeedingTrough",
    "RainBarrel",
    "Vehicles",
    "Zombies",
    "XpSystem",
    "HealthSystem",
    "Professions",
    "Climate",
  ]);
  const allModIds = new Set(builtInMods);
  for (const id of modIdsFromIni) allModIds.add(id);
  const missingDeps = [];
  for (const [modId, depInfo] of Object.entries(dependencies)) {
    for (const req of depInfo.requires) {
      if (allModIds.has(req)) continue;
      // Accept variant IDs of the same mod (e.g. require=AZASFrequencyIndex satisfied by
      // AZASFrequencyIndex_RefactorTest). Modders use "<id>_<suffix>" for test/beta/legacy
      // forks shipped from the same Workshop item. Case-insensitive to be forgiving.
      const reqLower = req.toLowerCase();
      const variantMatch = Array.from(allModIds).find((id) => {
        const lower = id.toLowerCase();
        return (
          lower.startsWith(reqLower + "_") || lower.startsWith(reqLower + "-")
        );
      });
      if (variantMatch) continue;
      missingDeps.push({
        modId,
        modName: depInfo.modName,
        workshopId: depInfo.workshopId,
        missingDep: req,
      });
    }
  }

  // Resolve missing deps to workshop IDs by scanning ALL downloaded workshop folders on disk
  if (serverPath && missingDeps.length > 0) {
    const missingIds = new Set(missingDeps.map((d) => d.missingDep));
    const resolved = new Map(); // modId → { workshopId, modName }
    const workshopPaths = [
      path.join(serverPath, "steamapps", "workshop", "content", "108600"),
      path.join(serverPath, "..", "steamapps", "workshop", "content", "108600"),
    ];
    for (const workshopBase of workshopPaths) {
      if (!fs.existsSync(workshopBase)) continue;
      try {
        for (const entry of fs.readdirSync(workshopBase, {
          withFileTypes: true,
        })) {
          if (!entry.isDirectory() || resolved.size === missingIds.size)
            continue;
          try {
            const details = getModDetailsFromWorkshop(entry.name, serverPath);
            for (const mod of details) {
              if (missingIds.has(mod.id) && !resolved.has(mod.id)) {
                resolved.set(mod.id, {
                  workshopId: entry.name,
                  modName: mod.name,
                });
              }
            }
          } catch (e) {
            log.debug(`Workshop folder unreadable ${entry.name}: ${e.message}`);
          }
        }
      } catch (e) {
        log.debug(`Workshop path inaccessible: ${e.message}`);
      }
      if (resolved.size === missingIds.size) break;
    }
    // Annotate missing deps with resolved workshop IDs
    for (const dep of missingDeps) {
      const match = resolved.get(dep.missingDep);
      if (match) {
        dep.resolvedWorkshopId = match.workshopId;
        dep.resolvedModName = match.modName;
      }
    }
  }

  return missingDeps;
}

// ─── Steam API: fetch workshop item dependencies (children) ─────────────────
// Uses GetPublishedFileDetails to get the "Required Items" for each workshop item,
// then checks which required Workshop IDs are missing from the configured list.
// Returns { deps: [...], warnings: [...] }
async function findSteamDeps(workshopIds) {
  const steamApiKey = await getSteamApiKey();
  if (
    !steamApiKey ||
    typeof steamApiKey !== "string" ||
    steamApiKey.length < 10
  )
    return {
      deps: [],
      warnings: [
        "Steam API key not configured — dependency check skipped. Set it in Settings to enable.",
      ],
    };

  const configuredWsIds = new Set(workshopIds.map(String));
  const allDeps = [];
  const steamWarnings = [];
  let steamApiFailed = false;

  // Batch in groups of 50 (Steam API limit)
  for (let i = 0; i < workshopIds.length; i += 50) {
    const batch = workshopIds.slice(i, i + 50);
    const params = new URLSearchParams({
      key: steamApiKey,
      includechildren: "true",
    });
    batch.forEach((id, idx) =>
      params.append(`publishedfileids[${idx}]`, String(id)),
    );
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const response = await fetch(
        `https://api.steampowered.com/IPublishedFileService/GetDetails/v1/?${params}`,
        {
          signal: controller.signal,
        },
      );
      clearTimeout(timeout);
      if (!response.ok) {
        steamApiFailed = true;
        continue;
      }
      const data = await response.json();
      const details = data.response?.publishedfiledetails || [];
      for (const item of details) {
        if (!item.publishedfileid || !item.children?.length) continue;
        const parentWsId = String(item.publishedfileid);
        const parentName = item.title || `Workshop ${parentWsId}`;
        for (const child of item.children) {
          // file_type 0 = required item dependency
          if (child.file_type !== 0) continue;
          const childWsId = String(child.publishedfileid);
          if (!configuredWsIds.has(childWsId)) {
            allDeps.push({
              parentWorkshopId: parentWsId,
              parentName,
              childWorkshopId: childWsId,
              childName: null, // resolved in next batch
              source: "steam",
            });
          }
        }
      }
    } catch (e) {
      steamApiFailed = true;
      log.debug?.(`Steam deps batch failed (non-fatal): ${e.message}`);
    }
  }

  if (steamApiFailed) {
    steamWarnings.push(
      "Steam Workshop API was unreachable — dependency check may be incomplete",
    );
  }

  // Resolve child names in a single batch call
  const childIds = [...new Set(allDeps.map((d) => d.childWorkshopId))];
  if (childIds.length > 0) {
    for (let i = 0; i < childIds.length; i += 50) {
      const batch = childIds.slice(i, i + 50);
      const params = new URLSearchParams({ key: steamApiKey });
      batch.forEach((id, idx) => params.append(`publishedfileids[${idx}]`, id));
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(
          `https://api.steampowered.com/IPublishedFileService/GetDetails/v1/?${params}`,
          {
            signal: controller.signal,
          },
        );
        clearTimeout(timeout);
        if (!response.ok) continue;
        const data = await response.json();
        const details = data.response?.publishedfiledetails || [];
        const nameMap = new Map();
        for (const item of details) {
          if (item.publishedfileid && item.title) {
            nameMap.set(String(item.publishedfileid), item.title);
          }
        }
        for (const dep of allDeps) {
          if (!dep.childName && nameMap.has(dep.childWorkshopId)) {
            dep.childName = nameMap.get(dep.childWorkshopId);
          }
        }
      } catch (e) {
        log.debug(
          `Steam deps batch name lookup failed (non-fatal): ${e.message}`,
        );
      }
    }
  }

  // Fill in fallback names
  for (const dep of allDeps) {
    if (!dep.childName) dep.childName = `Workshop Item #${dep.childWorkshopId}`;
  }

  // Deduplicate (same child can be required by multiple parents)
  const seen = new Set();
  const deps = allDeps.filter((d) => {
    const key = `${d.parentWorkshopId}-${d.childWorkshopId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { deps, warnings: steamWarnings };
}

// ─── Cached scan result endpoint ─────────────────────────────────────────────
// Returns the last scan result without re-running the scan.
router.get("/conflicts/cached", async (req, res) => {
  if (!lastScanResult || Date.now() - lastScanTimestamp > SCAN_CACHE_TTL_MS) {
    return res.json(null);
  }
  // Check if config has changed since last scan
  try {
    // Order rules added since the scan answer the pairs they decide.
    await refreshConflictSuggestions(lastScanResult);
    const { workshopIds, modIdsFromIni } = await readIniModLists();
    const currentServerPath = await getServerPath();
    const currentSnapshot = createConflictScanSnapshots(
      workshopIds,
      modIdsFromIni,
    );
    const stale =
      currentSnapshot.workshop !== lastScanWorkshopSnapshot ||
      currentSnapshot.mods !== lastScanModSnapshot ||
      currentServerPath !== lastScanServerPath;
    res.json({
      ...lastScanResult,
      stale,
      _workshopIdsSnapshot: lastScanWorkshopSnapshot
        ? lastScanWorkshopSnapshot.split(",")
        : [],
      _modIdsSnapshot: lastScanModSnapshot
        ? lastScanModSnapshot.split(",")
        : [],
    });
  } catch (e) {
    log.debug(`Error checking scan staleness (marking stale): ${e.message}`);
    res.json({ ...lastScanResult, stale: true });
  }
});

// ─── Batch scan endpoint (for non-SSE clients) ──────────────────────────────
router.get("/conflicts", async (req, res) => {
  const lockToken = acquireScanLock();
  if (!lockToken) {
    return res
      .status(429)
      .json({
        error: "A conflict scan is already running. Please wait.",
        code: ErrorCode.MODS_CONFLICT_SCAN_ALREADY_RUNNING,
      });
  }
  const scanStart = Date.now();
  try {
    const serverPath = await getServerPath();
    if (!serverPath)
      return res.status(400).json({
        error: "Server install path not set — configure it in Settings",
        code: ErrorCode.MODS_SERVER_INSTALL_PATH_NOT_SET,
      });
    const { workshopIds, modIdsFromIni } = await readIniModLists();
    if (workshopIds.length === 0) {
      return res.json({
        totalConflicts: 0,
        identicalSkipped: 0,
        additiveSkipped: 0,
        pzAdditiveSkipped: 0,
        pzAdditiveBreakdown: {
          sandbox: 0,
          scripts: 0,
          clothing: 0,
          fileguidtable: 0,
          translate: 0,
        },
        pairs: [],
        totalPairs: 0,
        modsScanned: 0,
        missingDeps: [],
        modLoadOrder: modIdsFromIni,
        truncated: false,
        warnings: [],
        scanDurationMs: Date.now() - scanStart,
      });
    }
    const { modDetailsByWorkshop, order, activeModIds } = prepareScanOrder(
      workshopIds,
      modIdsFromIni,
      serverPath,
    );
    const {
      fileIndex,
      modInfoMap,
      modsScanned,
      modsNotFound,
      modsSkippedInactive,
      truncated,
      warnings,
    } = await buildFileIndex(
      workshopIds,
      serverPath,
      null,
      activeModIds,
      FILE_INDEX_MAX_ENTRIES,
      modDetailsByWorkshop,
    );
    const analysis = await analyzeConflicts(fileIndex, modInfoMap, order);
    const idCollisions = findIdCollisions(modInfoMap, modIdsFromIni);
    if (analysis.truncated) {
      warnings.push(
        `Conflict output reached the global ${CONFLICT_PAIR_FILE_MAX_ENTRIES.toLocaleString()} pair-file limit — the conflict scan is incomplete. Scan fewer mods at once or remove unused ones and retry.`,
      );
    }
    const missingDeps = findMissingDeps(modInfoMap, modIdsFromIni, serverPath);
    let steamDeps = [];
    try {
      const steamResult = await findSteamDeps(workshopIds);
      steamDeps = steamResult.deps;
      warnings.push(...steamResult.warnings);
    } catch (e) {
      log.debug(
        `Steam deps lookup failed during batch scan (non-fatal): ${e.message}`,
      );
    }
    const result = buildScanResult({
      analysis,
      modsScanned,
      modsNotFound,
      modsSkippedInactive,
      workshopIds,
      missingDeps,
      steamDeps,
      idCollisions,
      modIdsFromIni,
      order,
      truncated: truncated || analysis.truncated,
      warnings,
      scanStart,
    });
    await addConflictSuggestions(result, { fileIndex, modInfoMap, effectiveOrder: order.effectiveModOrder });
    const snapshots = createConflictScanSnapshots(workshopIds, modIdsFromIni);
    lastScanWorkshopSnapshot = snapshots.workshop;
    lastScanModSnapshot = snapshots.mods;
    lastScanServerPath = serverPath;
    lastScanResult = result;
    lastScanTimestamp = Date.now();
    res.json(result);
  } catch (error) {
    log.error(`Failed to scan mod conflicts: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    resetScanCaches();
    releaseScanLock(lockToken);
  }
});

// ─── SSE streaming scan endpoint ────────────────────────────────────────────
// Streams progress events as each mod is scanned and conflicts are found.
// Auth handled via ?token= query param (SSE can't set custom headers).
router.get("/conflicts/stream", async (req, res) => {
  const lockToken = acquireScanLock();
  if (!lockToken) {
    return res
      .status(429)
      .json({
        error: "A conflict scan is already running. Please wait.",
        code: ErrorCode.MODS_CONFLICT_SCAN_ALREADY_RUNNING,
      });
  }
  const scanStart = Date.now();

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable nginx buffering if proxied
  });
  res.flushHeaders();

  // Detect client disconnect
  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });

  const send = (event, data) => {
    if (!res.writable || aborted) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      log.debug(`SSE write failed (stream closed): ${e.message}`);
    }
  };

  // A large scan can spend a long time in one phase. Without traffic a proxy
  // is free to drop the connection, so emit an SSE comment as a keep-alive.
  const heartbeat = setInterval(() => {
    if (!res.writable || aborted) return;
    try {
      res.write(": ping\n\n");
    } catch (e) {
      log.debug(`SSE heartbeat failed (stream closed): ${e.message}`);
    }
  }, 20_000);
  heartbeat.unref?.();

  try {
    const serverPath = await getServerPath();
    if (!serverPath) {
      send("error", {
        error: "Server install path not set — configure it in Settings",
        code: ErrorCode.MODS_SERVER_INSTALL_PATH_NOT_SET,
      });
      res.end();
      return;
    }
    const { workshopIds, modIdsFromIni } = await readIniModLists();

    send("init", {
      totalWorkshopIds: workshopIds.length,
      modLoadOrder: modIdsFromIni,
    });

    if (workshopIds.length === 0) {
      send("complete", {
        totalConflicts: 0,
        identicalSkipped: 0,
        additiveSkipped: 0,
        pzAdditiveSkipped: 0,
        pzAdditiveBreakdown: {
          sandbox: 0,
          scripts: 0,
          clothing: 0,
          fileguidtable: 0,
          translate: 0,
        },
        pairs: [],
        totalPairs: 0,
        modsScanned: 0,
        totalWorkshopIds: 0,
        missingDeps: [],
        modLoadOrder: modIdsFromIni,
        truncated: false,
        warnings: [],
        scanDurationMs: Date.now() - scanStart,
      });
      res.end();
      return;
    }

    // Phase 1: scan mods — emit progress per mod
    const { modDetailsByWorkshop, order, activeModIds } = prepareScanOrder(
      workshopIds,
      modIdsFromIni,
      serverPath,
    );
    const {
      fileIndex,
      modInfoMap,
      modsScanned,
      modsNotFound,
      modsSkippedInactive,
      truncated,
      warnings,
    } = await buildFileIndex(
      workshopIds,
      serverPath,
      (info) => {
        if (aborted) return;
        send("mod-scanned", {
          modId: info.modId,
          modName: info.modName,
          workshopId: info.workshopId,
          fileCount: info.fileCount,
          modsScanned: info.modsScanned,
          totalWorkshopIds: info.totalWorkshopIds,
          progress: Math.round(((info.wsIdx + 1) / info.totalWorkshopIds) * 60), // 0-60%
        });
      },
      activeModIds,
      FILE_INDEX_MAX_ENTRIES,
      modDetailsByWorkshop,
    );

    if (aborted) {
      res.end();
      return;
    }
    send("phase", { phase: "hashing", progress: 60 });

    // Phase 2: detect conflicts (hashing happens here), then the passes
    // across files and the grouping.
    let conflictCount = 0;
    const analysis = await analyzeConflicts(fileIndex, modInfoMap, order, {
      onConflictFound: (conflict) => {
        if (aborted) return;
        conflictCount++;
        // Stream each conflict as it's found (every 3rd to avoid flooding, or always for high severity)
        if (
          conflict.severity === "high" ||
          conflictCount <= 5 ||
          conflictCount % 3 === 0
        ) {
          send("conflict-found", {
            file: conflict.file,
            severity: conflict.severity,
            categoryLabel: conflict.categoryLabel,
            mods: conflict.mods.map((m) => m.modName),
            conflictsSoFar: conflictCount,
            kind: conflict.kind,
            reason: conflict.reason,
          });
        }
      },
      // Stop the scan when the client has gone: comparing files for a
      // browser that closed the tab is pure wasted I/O.
      shouldAbort: () => aborted,
      // Comparison used to be a silent gap between 60% and 85%.
      onProgress: ({ processed, total }) => {
        if (aborted || total === 0) return;
        send("phase", {
          phase: "hashing",
          progress: 60 + Math.round((processed / total) * 25),
        });
      },
      onPhase: (phase) => {
        if (!aborted) send("phase", { phase, progress: 85 });
      },
    });

    if (aborted) {
      res.end();
      return;
    }
    const idCollisions = findIdCollisions(modInfoMap, modIdsFromIni);
    if (analysis.truncated) {
      warnings.push(
        `Conflict output reached the global ${CONFLICT_PAIR_FILE_MAX_ENTRIES.toLocaleString()} pair-file limit — the conflict scan is incomplete. Scan fewer mods at once or remove unused ones and retry.`,
      );
    }
    const missingDeps = findMissingDeps(modInfoMap, modIdsFromIni, serverPath);

    // Phase 4: Steam API dependency check (parallel-safe, non-blocking)
    let steamDeps = [];
    try {
      if (!aborted) {
        send("phase", { phase: "dependencies", progress: 90 });
        const steamResult = await findSteamDeps(workshopIds);
        steamDeps = steamResult.deps;
        warnings.push(...steamResult.warnings);
      }
    } catch (e) {
      log.debug(
        `Steam deps lookup failed during SSE scan (non-fatal): ${e.message}`,
      );
    }

    const result = buildScanResult({
      analysis,
      modsScanned,
      modsNotFound,
      modsSkippedInactive,
      workshopIds,
      missingDeps,
      steamDeps,
      idCollisions,
      modIdsFromIni,
      order,
      truncated: truncated || analysis.truncated,
      warnings,
      scanStart,
    });
    await addConflictSuggestions(result, { fileIndex, modInfoMap, effectiveOrder: order.effectiveModOrder });
    lastScanResult = result;
    lastScanTimestamp = Date.now();
    const snapshots = createConflictScanSnapshots(workshopIds, modIdsFromIni);
    lastScanWorkshopSnapshot = snapshots.workshop;
    lastScanModSnapshot = snapshots.mods;
    lastScanServerPath = serverPath;
    send("complete", result);
    res.end();
  } catch (error) {
    log.error(`Streaming conflict scan failed: ${error.message}`);
    if (!aborted) {
      send("error", { error: sanitizeError(error.message) });
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
    resetScanCaches();
    releaseScanLock(lockToken);
  }
});

// ─── File diff endpoint ─────────────────────────────────────────────────────
// Compare two mods' versions of the same file.
// GET /api/mods/conflicts/diff?file=<relPath>&modA=<modId>&modB=<modId>
const DIFF_MAX_BYTES = 512 * 1024; // 512 KB max for diffing

router.get("/conflicts/diff", async (req, res) => {
  try {
    const { file, modA, modB } = req.query;
    if (!file || !modA || !modB) {
      return res.status(400).json({
        error:
          "Could not load file comparison — missing file or mod information",
        code: ErrorCode.MODS_CONFLICTS_DIFF_PARAMS_REQUIRED,
      });
    }

    // Sanitize mod IDs — only allow safe characters (alphanumeric, hyphens, underscores, dots, spaces)
    const modAStr = String(modA);
    const modBStr = String(modB);
    if (
      !/^[\w .\-]{1,200}$/.test(modAStr) ||
      !/^[\w .\-]{1,200}$/.test(modBStr)
    ) {
      return res
        .status(400)
        .json({
          error: "Could not identify one of the mods — try rescanning",
          code: ErrorCode.MODS_CONFLICTS_DIFF_MOD_ID_INVALID,
        });
    }

    // Validate the file path doesn't try path traversal
    const normalizedFile = String(file).replace(/\\/g, "/");
    if (
      normalizedFile.includes("..") ||
      path.isAbsolute(normalizedFile) ||
      normalizedFile.length > 500
    ) {
      return res.status(400).json({
        error: "The file path looks invalid — try rescanning conflicts",
        code: ErrorCode.MODS_CONFLICTS_DIFF_PATH_INVALID,
      });
    }

    const serverPath = await getServerPath();
    if (!serverPath)
      return res.status(400).json({
        error: "Server install path not set — configure it in Settings",
        code: ErrorCode.MODS_SERVER_INSTALL_PATH_NOT_SET,
      });
    const { workshopIds } = await readIniModLists();

    // Find the absolute paths for this file in both mods
    let pathA = null,
      pathB = null;
    for (const wsId of workshopIds) {
      if (!/^\d{1,15}$/.test(wsId)) continue;
      const possiblePaths = getWorkshopPaths(wsId, serverPath);
      let workshopPath = null;
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          workshopPath = p;
          break;
        }
      }
      if (!workshopPath) continue;

      const modDetails = getModDetailsFromWorkshop(wsId, serverPath);
      const modsFolder = path.join(workshopPath, "mods");
      const searchBase = fs.existsSync(modsFolder) ? modsFolder : workshopPath;
      let modEntries;
      try {
        modEntries = fs.readdirSync(searchBase, { withFileTypes: true });
      } catch (e) {
        log.debug(`Could not read mod directory ${searchBase}: ${e.message}`);
        continue;
      }

      for (const modDir of modEntries) {
        if (!modDir.isDirectory()) continue;
        const matchingMod = findModForFolder(modDetails, modDir.name);
        const modId = matchingMod?.id || modDir.name;
        const modDirPath = path.join(searchBase, modDir.name);

        // The media folders the game loads, in the order it applies them:
        // a later folder's copy (the version folder's) replaces common/'s,
        // exactly the copy the scan compared.
        const mediaCandidates = gameMediaDirs(modDirPath).dirs;

        for (const mediaDir of mediaCandidates) {
          const candidate = path.join(mediaDir, normalizedFile);
          const resolved = path.resolve(candidate);
          const mediaBase = path.resolve(mediaDir);
          if (
            !resolved.startsWith(mediaBase + path.sep) &&
            resolved !== mediaBase
          )
            continue;
          if (modId !== modAStr && modId !== modBStr) continue;
          if (!fs.existsSync(candidate)) continue;
          // The lexical check above stays inside media/ only on paper: a
          // symlink or junction on the way can lead anywhere. Same rule as
          // the scan's walkDir(): the real file must be inside the real
          // media folder, and a regular file.
          const realMedia = safeRealpath(mediaDir);
          const realCandidate = realMedia ? safeRealpath(candidate) : null;
          if (!realCandidate || !isInsideRoot(realCandidate, realMedia)) {
            log.warn(`Conflict diff: ${JSON.stringify(normalizedFile)} in ${JSON.stringify(modId)} leads outside its media folder -- not read`);
            continue;
          }
          try {
            if (!fs.statSync(realCandidate).isFile()) continue;
          } catch {
            continue;
          }
          if (modId === modAStr) pathA = realCandidate;
          if (modId === modBStr) pathB = realCandidate;
        }
      }
      if (pathA && pathB) break;
    }

    if (!pathA || !pathB) {
      return res.status(404).json({
        error:
          "Could not find both mod files on disk — they may have been removed or updated since the last scan",
        code: ErrorCode.MODS_CONFLICTS_DIFF_FILES_NOT_FOUND,
      });
    }

    // Determine if files are text or binary
    const ext = path.extname(normalizedFile).toLowerCase();
    const textExts = new Set([
      ".lua",
      ".txt",
      ".xml",
      ".json",
      ".cfg",
      ".ini",
      ".csv",
      ".md",
      ".properties",
      ".script",
    ]);
    const imageExts = new Set([
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".bmp",
      ".tga",
    ]);
    const isText = textExts.has(ext);
    const isImage = imageExts.has(ext);

    if (isImage) {
      // For images, return base64 thumbnails
      const statA = fs.statSync(pathA);
      const statB = fs.statSync(pathB);
      const maxImg = 2 * 1024 * 1024; // 2 MB cap
      return res.json({
        type: "image",
        ext,
        modA: {
          size: statA.size,
          base64:
            statA.size <= maxImg
              ? fs.readFileSync(pathA).toString("base64")
              : null,
        },
        modB: {
          size: statB.size,
          base64:
            statB.size <= maxImg
              ? fs.readFileSync(pathB).toString("base64")
              : null,
        },
      });
    }

    if (!isText) {
      // Binary/unknown — just return file sizes and hashes
      const statA = fs.statSync(pathA);
      const statB = fs.statSync(pathB);
      return res.json({
        type: "binary",
        ext,
        modA: { size: statA.size, hash: hashFileSync(pathA) },
        modB: { size: statB.size, hash: hashFileSync(pathB) },
      });
    }

    // Text diff — simple LCS-based unified diff
    const statA = fs.statSync(pathA);
    const statB = fs.statSync(pathB);
    if (statA.size > DIFF_MAX_BYTES || statB.size > DIFF_MAX_BYTES) {
      return res.json({
        type: "text-too-large",
        ext,
        modA: { size: statA.size, hash: hashFileSync(pathA) },
        modB: { size: statB.size, hash: hashFileSync(pathB) },
      });
    }

    const contentA = fs.readFileSync(pathA, "utf-8");
    const contentB = fs.readFileSync(pathB, "utf-8");
    const linesA = contentA.split("\n");
    const linesB = contentB.split("\n");

    // Myers-like diff: compute edit script between linesA and linesB
    const hunks = computeUnifiedDiff(linesA, linesB, 3);

    res.json({
      type: "text",
      ext,
      modA: { size: statA.size, lineCount: linesA.length },
      modB: { size: statB.size, lineCount: linesB.length },
      hunks,
      totalAdded: hunks.reduce(
        (s, h) => s + h.lines.filter((l) => l.type === "add").length,
        0,
      ),
      totalRemoved: hunks.reduce(
        (s, h) => s + h.lines.filter((l) => l.type === "remove").length,
        0,
      ),
    });
  } catch (error) {
    log.error(`Failed to diff files: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Compute unified diff hunks between two line arrays using LCS
function computeUnifiedDiff(linesA, linesB, contextLines = 3) {
  // Simple O(n*m) LCS for files up to ~10k lines; fast enough for mod files
  const n = linesA.length,
    m = linesB.length;

  // Guard: Uint16Array max value is 65535 — if either file exceeds that, fall back
  // Also guard against excessive memory: n*m cells
  if (n > 65535 || m > 65535 || n * m > 10_000_000) {
    // Too large for full LCS — return a simplified diff
    return [
      {
        startA: 1,
        startB: 1,
        countA: n,
        countB: m,
        lines: [
          ...linesA
            .slice(0, 50)
            .map((l, i) => ({ type: "remove", lineA: i + 1, text: l })),
          {
            type: "context",
            text: `... (${n} lines in Mod A, ${m} lines in Mod B — file too large for inline diff)`,
          },
          ...linesB
            .slice(0, 50)
            .map((l, i) => ({ type: "add", lineB: i + 1, text: l })),
        ],
      },
    ];
  }

  // Build LCS table
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        linesA[i - 1] === linesB[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to get edit ops
  const ops = []; // { type: 'equal'|'remove'|'add', lineA?, lineB?, text }
  let i = n,
    j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      ops.push({ type: "equal", lineA: i, lineB: j, text: linesA[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "add", lineB: j, text: linesB[j - 1] });
      j--;
    } else {
      ops.push({ type: "remove", lineA: i, text: linesA[i - 1] });
      i--;
    }
  }
  ops.reverse();

  // Group into hunks with context
  const hunks = [];
  let currentHunk = null;
  let sinceLastChange = Infinity;

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    const isChange = op.type !== "equal";

    if (isChange) {
      if (!currentHunk || sinceLastChange > contextLines * 2) {
        // Start new hunk — include preceding context
        if (currentHunk) hunks.push(currentHunk);
        const ctxStart = Math.max(0, k - contextLines);
        currentHunk = {
          startA: ops[ctxStart]?.lineA || op.lineA || 1,
          startB: ops[ctxStart]?.lineB || op.lineB || 1,
          lines: [],
        };
        // Add context lines before this change
        for (let c = ctxStart; c < k; c++) {
          if (ops[c].type === "equal") {
            currentHunk.lines.push({
              type: "context",
              lineA: ops[c].lineA,
              lineB: ops[c].lineB,
              text: ops[c].text,
            });
          }
        }
      }
      currentHunk.lines.push(op);
      sinceLastChange = 0;
    } else {
      sinceLastChange++;
      if (currentHunk && sinceLastChange <= contextLines) {
        currentHunk.lines.push({
          type: "context",
          lineA: op.lineA,
          lineB: op.lineB,
          text: op.text,
        });
      }
    }
  }
  if (currentHunk) hunks.push(currentHunk);

  // Add counts to each hunk
  for (const hunk of hunks) {
    hunk.countA = hunk.lines.filter((l) => l.type !== "add").length;
    hunk.countB = hunk.lines.filter((l) => l.type !== "remove").length;
  }

  return hunks;
}

// ─── Disk-only mods ─────────────────────────────────────────────────────────
// Returns workshop IDs that exist on disk (downloaded into the Steam workshop
// content folder) but are NOT in the server's INI WorkshopItems= list.
// These are "installed but disabled" mods — the user has the files, but the
// server isn't loading them. The UI shows these as greyed-out rows behind a
// "Show disabled" toggle, with a quick Enable action.
router.get("/disk-only", async (req, res) => {
  try {
    const modChecker = req.app.get("modChecker");
    if (!modChecker || !modChecker.workshopAcfPath) {
      return res.json({ mods: [], reason: "workshop folder not configured" });
    }

    // Read INI to know what's currently enabled.
    const { serverConfigPath, serverName } = await getActiveServerPaths();
    const inIni = new Set();
    if (serverConfigPath && serverName) {
      const sanitized = path.basename(serverName);
      if (sanitized === serverName && !serverName.includes("..")) {
        const iniPath = path.join(serverConfigPath, `${sanitized}.ini`);
        if (fs.existsSync(iniPath)) {
          const content = readTextFile(iniPath);
          // Widened to tolerate whitespace around "=" -- same fix as this
          // file's other ini-read sites (hunt-wave13, 3d1921ad/783672aa),
          // missed here. A hand-edited "WorkshopItems = ..." line previously
          // parsed as zero enabled items, so this route would show every
          // already-enabled downloaded mod as "installed but disabled".
          const m = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
          for (const id of splitIniList(m?.[1]))
            inIni.add(id);
        }
      }
    }

    // Mods the user has explicitly ignored are shown in their own panel and
    // shouldn't pollute the disabled-on-disk list (otherwise the same row
    // appears twice in the UI).
    const ignored = new Set();
    try {
      for (const m of (await getIgnoredMods()) || []) {
        if (m?.workshop_id) ignored.add(String(m.workshop_id));
      }
    } catch {
      /* best-effort */
    }

    // Enumerate the steamapps/workshop/content/108600 folder for the active server.
    const workshopDir = path.dirname(modChecker.workshopAcfPath);
    const contentDir = path.join(workshopDir, "content", "108600");
    if (!fs.existsSync(contentDir)) {
      return res.json({ mods: [], reason: "no workshop content folder" });
    }

    let entries = [];
    try {
      entries = fs.readdirSync(contentDir, { withFileTypes: true });
    } catch (e) {
      log.warn(`disk-only: failed to read ${contentDir}: ${e.message}`);
      return res.json({ mods: [], reason: "cannot read workshop folder" });
    }

    const mods = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wsId = entry.name;
      if (!/^\d{1,15}$/.test(wsId)) continue;
      if (inIni.has(wsId)) continue; // already enabled in INI
      if (ignored.has(wsId)) continue; // user explicitly ignored — shown in the Ignored panel instead
      const name =
        modChecker.resolveModNameFromDisk(wsId) || `Workshop Mod ${wsId}`;
      mods.push({ workshop_id: wsId, name });
    }

    res.json({ mods });
  } catch (error) {
    log.error(`Failed to list disk-only mods: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Enable a disk-only mod: append its workshop ID to the INI WorkshopItems=
// list (and best-effort the corresponding mod IDs to Mods=) so the server
// loads it on next start. This is the inverse of the existing batch-remove.
router.post("/enable-disk-mod", async (req, res) => {
  try {
    const { workshopId } = req.body || {};
    const wsId = String(workshopId || "");
    if (!/^\d{1,15}$/.test(wsId)) {
      return res.status(400).json({
        error: "Invalid workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_LOWER,
      });
    }

    const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();
    if (!serverConfigPath || !serverName) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Server config path not set",
          code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
        }),
      );
    }
    const sanitized = path.basename(serverName);
    if (sanitized !== serverName || serverName.includes("..")) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }
    const iniPath = path.join(serverConfigPath, `${sanitized}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(404).json({
        error: "Server INI not found",
        code: ErrorCode.MODS_SERVER_INI_NOT_FOUND,
      });
    }

    // Resolve mod folder IDs (Mods= entries) from the workshop folder so the
    // server can actually load it. A workshop item can ship multiple mods.
    const modIdsToAdd = serverPath
      ? findAllModIdsFromWorkshop(wsId, serverPath)
      : [];

    let backupWarning = null;
    await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);

      // WorkshopItems. Widened to tolerate whitespace around "="
      // (hunt-wave13, 783672aa) -- wsMatch/modsMatch double as the
      // exists-check for their replace below.
      const wsMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
      const wsList = splitIniList(wsMatch?.[1]);
      if (!wsList.includes(wsId)) wsList.push(wsId);
      const wsLine = `WorkshopItems=${sanitizeIniList(wsList)}`;
      content = wsMatch
        ? content.replace(/^[ \t]*WorkshopItems[ \t]*=.*/m, () => wsLine)
        : content.trimEnd() + `\n${wsLine}\n`;

      // Mods
      const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
      const existing = splitModIdList(modsMatch?.[1]);
      // Keep every entry already on the line (the numeric-ID filter used to
      // run over it and dropped a legitimate all-digit mod id belonging to
      // another workshop item), then union with the mod.info-verified IDs --
      // those are authoritative so they bypass the numeric-ID filter (some
      // mods use their workshop ID as their mod ID, e.g. "Tear All Clothes"
      // 3519629457).
      const modsList = [...existing];
      for (const mid of modIdsToAdd) {
        if (!modsList.includes(mid)) modsList.push(mid);
      }
      const modsLine = `Mods=${sanitizeIniList(modsList)}`;
      content = modsMatch
        ? content.replace(/^[ \t]*Mods[ \t]*=.*/m, () => modsLine)
        : content.trimEnd() + `\n${modsLine}\n`;

      backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
    });

    // Lift any prior ignore-list entry so auto-track picks it up.
    try {
      await removeIgnoredMod(wsId);
    } catch {
      /* best-effort */
    }

    log.info(
      `Enabled disk-only mod ${wsId} (added ${modIdsToAdd.length} mod IDs)`,
    );
    res.json({
      success: true,
      workshopId: wsId,
      modIdsAdded: modIdsToAdd.length,
      ...(backupWarning ? { backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to enable disk-only mod: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Deletes the workshop content folder, then strips the workshop ID, its
// mod-folder IDs and its map folders from the server INI so the server stops
// loading it. Returns iniEditApplied=false when the config file could not be
// reached — callers must not ignore-list in that case, because the mod may
// still be live in Mods=/WorkshopItems=. `configRefusal` is why, when the
// server's folders were refused (PT3, verifier round 1).
async function deleteModFromDiskAndIni(wsId) {
  const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();
  const sanitized = serverName ? path.basename(serverName) : null;
  const iniPath =
    sanitized && serverConfigPath
      ? path.join(serverConfigPath, `${sanitized}.ini`)
      : null;

  if (!iniPath || !fs.existsSync(iniPath)) {
    return {
      removedPath: null,
      modIdsToStrip: [],
      mapFoldersToStrip: [],
      iniEditApplied: false,
      error: "Server config file was not found or not accessible",
      configRefusal,
    };
  }

  // Capture mod IDs and map folders BEFORE we delete the folder — both are
  // read off the files we are about to remove.
  let modIdsToStrip = serverPath
    ? findAllModIdsFromWorkshop(wsId, serverPath)
    : [];
  let mapFoldersToStrip = serverPath
    ? findMapFoldersFromWorkshop(wsId, serverPath)
    : [];

  let backupWarning = null;
  await withIniLock(iniPath, async () => {
    let content = readTextFile(iniPath);
    // Widened to tolerate whitespace around "=" (hunt-wave13, 783672aa) --
    // each match doubles as the exists-check for its replace below.
    const wsMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
    const wsList = splitIniList(wsMatch?.[1]).filter((id) => id !== wsId);
    if (wsMatch) {
      content = content.replace(
        /^[ \t]*WorkshopItems[ \t]*=.*/m,
        () => `WorkshopItems=${sanitizeIniList(wsList)}`,
      );
    }
    // A mod id or map an item still listed ships too stays: deleting an old
    // download must not unload its re-upload under a new Workshop ID.
    const listedMods = splitModIdList(content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m)?.[1]);
    const listedMaps = splitIniList(content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m)?.[1]);
    const stillShipped = shippedByListedItems({
      modIds: modIdsToStrip.filter((id) => listedMods.includes(id)),
      mapFolders: mapFoldersToStrip.filter((folder) => listedMaps.includes(folder)),
      listedWorkshopIds: wsList,
      serverPath,
    });
    modIdsToStrip = modIdsToStrip.filter((id) => !stillShipped.mods.has(id));
    mapFoldersToStrip = mapFoldersToStrip.filter((folder) => !stillShipped.maps.has(folder));
    const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
    if (modsMatch && modIdsToStrip.length > 0) {
      const modsList = splitModIdList(modsMatch[1])
        .filter((id) => !modIdsToStrip.includes(id));
      // Only removing: every entry left is one the line already had, so just
      // the character sanitising applies (no numeric-ID filter).
      content = content.replace(
        /^[ \t]*Mods[ \t]*=.*/m,
        () => `Mods=${sanitizeIniList(modsList)}`,
      );
    }
    const mapMatch = content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m);
    if (mapMatch && mapFoldersToStrip.length > 0) {
      let mapList = splitIniList(mapMatch[1])
        .filter((m) => !mapFoldersToStrip.includes(m));
      if (mapList.length === 0) mapList = ["Muldraugh, KY"];
      content = content.replace(
        /^[ \t]*Map[ \t]*=.*/m,
        () => `Map=${sanitizeIniList(mapList)}`,
      );
    }
    backupWarning = backupWarningFor(
      await writeIniWithBackup(iniPath, content),
    );
  });

  const possiblePaths = getWorkshopPaths(wsId, serverPath || "");
  let removedPath = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
        removedPath = p;
        break;
      } catch (e) {
        log.warn(`Failed to delete workshop folder ${p}: ${e.message}`);
      }
    }
  }

  return {
    removedPath,
    modIdsToStrip,
    mapFoldersToStrip,
    iniEditApplied: true,
    backupWarning,
  };
}

// Delete a mod from disk: removes the workshop content folder, and also
// strips the workshop ID + any of its mod-folder IDs from the server INI
// so the server won't try to load it on next start. Used by the "Disabled
// mods on disk" and "Ignored mods" panels in the Mods page UI.
router.post("/delete-disk-mod", async (req, res) => {
  try {
    const { workshopId } = req.body || {};
    const wsId = String(workshopId || "");
    if (!/^\d{1,15}$/.test(wsId)) {
      return res.status(400).json({
        error: "Invalid workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_LOWER,
      });
    }

    const { removedPath, modIdsToStrip, iniEditApplied, backupWarning, configRefusal } =
      await deleteModFromDiskAndIni(wsId);

    if (!iniEditApplied) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Server config file was not found or not accessible",
          code: ErrorCode.MODS_INI_NOT_ACCESSIBLE,
          workshopId: wsId,
          deletedFromDisk: false,
        }),
      );
    }

    // Drop from tracking, then ADD to the ignore list so auto-sync won't
    // re-track the mod next time Steam re-downloads it. Delete is meant to
    // be a "gone forever" action, not a temporary cleanup. Gated on
    // iniEditApplied — if the INI was never actually reached, the mod ID
    // may still be sitting in Mods=/WorkshopItems= and must not be
    // ignore-listed as if it had been removed from the server config.
    let priorName = null;
    try {
      const tracked = await getTrackedMods();
      priorName =
        tracked?.find((m) => String(m.workshop_id) === wsId)?.name || null;
    } catch {
      /* ignore */
    }
    if (!priorName && req.body?.modName)
      priorName = String(req.body.modName).slice(0, 200);
    if (iniEditApplied) {
      try {
        await removeTrackedMod(wsId);
      } catch {
        /* ignore */
      }
      try {
        await addIgnoredMod(wsId, priorName);
      } catch {
        /* ignore */
      }
    } else {
      log.error(
        `delete-disk-mod ${wsId}: INI edit was never applied (missing server config path or ini file) — not ignore-listing`,
      );
    }

    log.info(
      `Deleted disk mod ${wsId} (folder: ${removedPath || "not found"}, mod IDs stripped: ${modIdsToStrip.length})`,
    );
    res.json({
      success: true,
      workshopId: wsId,
      deletedFromDisk: !!removedPath,
      modIdsStripped: modIdsToStrip.length,
      ...(backupWarning ? { backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to delete disk mod: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// "Remove everywhere" — the single action for a mod you never want back.
// Steam collection, then server INI, then disk, then tracking, and finally
// ignore-listed so a later scan can't quietly re-add it. The collection step
// is reported separately because it is the only one that can fail for a
// reason the user can fix (missing Steam cookies).
router.post("/purge", async (req, res) => {
  try {
    const wsId = String(req.body?.workshopId || "").trim();
    if (!/^\d{1,15}$/.test(wsId)) {
      return res.status(400).json({
        error: "Invalid workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_LOWER,
      });
    }

    // Read the name before untracking, or the ignore list loses it.
    let name = null;
    try {
      const tracked = await getTrackedMods();
      name = tracked?.find((m) => String(m.workshop_id) === wsId)?.name || null;
    } catch {
      /* ignore */
    }
    if (!name && req.body?.name) name = String(req.body.name).slice(0, 200);

    const collection = { attempted: false, ok: false, error: null };
    const collectionId = await getSetting("workshopCollectionId");
    if (collectionId) {
      collection.attempted = true;
      try {
        const r = await removeItemFromCollection(collectionId, wsId);
        collection.ok = !!r.ok;
        if (!r.ok) collection.error = r.error || "Steam rejected the change";
      } catch (e) {
        collection.error = e.message;
      }
    }

    const {
      removedPath,
      modIdsToStrip,
      mapFoldersToStrip,
      iniEditApplied,
      backupWarning,
      configRefusal,
    } = await deleteModFromDiskAndIni(wsId);

    if (!iniEditApplied) {
      log.error(
        `Purge ${wsId}: INI edit was never applied (missing server config path or ini file) — not untracking or ignore-listing`,
      );
      return res.status(500).json(
        withConfigRefusal(configRefusal, {
          error:
            "Server config file was not found or not accessible — the mod was not removed from the server.",
          code: ErrorCode.MODS_PURGE_INI_NOT_ACCESSIBLE,
          collection,
          deletedFromDisk: !!removedPath,
        }),
      );
    }

    try {
      await removeTrackedMod(wsId);
    } catch {
      /* ignore */
    }
    try {
      await addIgnoredMod(wsId, name);
    } catch {
      /* ignore */
    }

    log.info(
      `Purged ${wsId} (${name || "unknown name"}): collection=${
        collection.attempted ? (collection.ok ? "removed" : "failed") : "skipped"
      }, disk=${removedPath || "not found"}, mod IDs stripped=${
        modIdsToStrip.length
      }, map folders stripped=${mapFoldersToStrip.length}`,
    );

    res.json({
      success: true,
      workshopId: wsId,
      name,
      collection,
      deletedFromDisk: !!removedPath,
      modIdsStripped: modIdsToStrip.length,
      mapFoldersStripped: mapFoldersToStrip.length,
      ...(backupWarning ? { backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Purge failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/batch-delete-disk-mods", async (req, res) => {
  try {
    const { workshopIds } = req.body || {};
    if (!Array.isArray(workshopIds) || workshopIds.length === 0) {
      return res
        .status(400)
        .json({
          error: "workshopIds must be a non-empty array",
          code: ErrorCode.MODS_WORKSHOP_IDS_ARRAY_REQUIRED,
        });
    }

    // sibling-convention sweep, 2026-09-08: /batch-remove (an INI/DB-only
    // edit) caps its own workshopIds array at 500 "to prevent abuse" -- this
    // route had no cap at all despite doing the more destructive of the two
    // operations (deleting real files from disk per ID, via
    // findAllModIdsFromWorkshop's filesystem scan for each one, then rmSync).
    // An unbounded array here is worse than an unbounded one on the
    // INI-only route: the blast radius is real files gone, not just list
    // entries, and the synchronous scan-then-delete loop over an
    // attacker-or-mistake-supplied array has no upper bound on how long it
    // blocks the event loop either. Same cap, same reasoning, own code
    // since this route's failure mode is sharper.
    if (workshopIds.length > 500) {
      return res.status(400).json({
        error: "Maximum 500 mods per batch",
        code: ErrorCode.MODS_BATCH_DELETE_DISK_MODS_TOO_MANY,
      });
    }

    const cleaned = workshopIds
      .map(String)
      .filter((id) => /^\d{1,15}$/.test(id));
    if (cleaned.length === 0) {
      return res.status(400).json({
        error: "No valid workshop IDs provided",
        code: ErrorCode.MODS_NO_VALID_WORKSHOP_IDS,
      });
    }

    const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();
    const sanitized = serverName ? path.basename(serverName) : null;
    const iniPath =
      sanitized && serverConfigPath
        ? path.join(serverConfigPath, `${sanitized}.ini`)
        : null;

    if (!iniPath || !fs.existsSync(iniPath)) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Server config file was not found or not accessible",
          code: ErrorCode.MODS_INI_NOT_ACCESSIBLE,
        }),
      );
    }

    // Capture all mod IDs AND map folders BEFORE we start deleting -- both
    // are read off the workshop folders this route is about to rmSync, the
    // same ordering deleteModFromDiskAndIni() (the single-mod sibling this
    // route duplicates instead of calling) already gets right.
    const allModIdsToStrip = new Set();
    const allMapFoldersToStrip = new Set();
    for (const wsId of cleaned) {
      if (serverPath) {
        for (const m of findAllModIdsFromWorkshop(wsId, serverPath))
          allModIdsToStrip.add(m);
        for (const folder of findMapFoldersFromWorkshop(wsId, serverPath))
          allMapFoldersToStrip.add(folder);
      }
    }

    let backupWarning = null;
    await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);
      // Widened to tolerate whitespace around "=" (hunt-wave13, 783672aa) --
      // each match doubles as the exists-check for its replace below.
      const wsMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
      const wsList = splitIniList(wsMatch?.[1]).filter((id) => !cleaned.includes(id));
      if (wsMatch) {
        content = content.replace(
          /^[ \t]*WorkshopItems[ \t]*=.*/m,
          () => `WorkshopItems=${sanitizeIniList(wsList)}`,
        );
      }
      // What an item still listed ships too stays (see deleteModFromDiskAndIni()).
      const listedMods = splitModIdList(content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m)?.[1]);
      const listedMaps = splitIniList(content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m)?.[1]);
      const stillShipped = shippedByListedItems({
        modIds: [...allModIdsToStrip].filter((id) => listedMods.includes(id)),
        mapFolders: [...allMapFoldersToStrip].filter((folder) => listedMaps.includes(folder)),
        listedWorkshopIds: wsList,
        serverPath,
      });
      for (const id of stillShipped.mods) allModIdsToStrip.delete(id);
      for (const folder of stillShipped.maps) allMapFoldersToStrip.delete(folder);
      const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
      if (modsMatch && allModIdsToStrip.size > 0) {
        const modsList = splitModIdList(modsMatch[1])
          .filter((id) => !allModIdsToStrip.has(id));
        // Only removing: every entry left is one the line already had, so
        // just the character sanitising applies (no numeric-ID filter).
        content = content.replace(
          /^[ \t]*Mods[ \t]*=.*/m,
          () => `Mods=${sanitizeIniList(modsList)}`,
        );
      }
      // continuous-bug-hunt, 2026-09-18 (mod-list-drift round): this route
      // deletes the ENTIRE workshop folder per id below (fs.rmSync,
      // recursive) -- including any map content it owns -- but, unlike its
      // single-mod sibling deleteModFromDiskAndIni() (used by /delete-disk-mod
      // and /purge), never removed the matching Map= entries. The server's
      // Map= line kept naming a folder that no longer existed on disk after
      // a batch delete, silently, with the response reporting success and no
      // hint anything Map=-related happened. Same fallback as the sibling:
      // Map= may never be empty, or PZ has nothing to boot into.
      const mapMatch = content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m);
      if (mapMatch && allMapFoldersToStrip.size > 0) {
        let mapList = splitIniList(mapMatch[1])
          .filter((m) => !allMapFoldersToStrip.has(m));
        if (mapList.length === 0) mapList = ["Muldraugh, KY"];
        content = content.replace(
          /^[ \t]*Map[ \t]*=.*/m,
          () => `Map=${sanitizeIniList(mapList)}`,
        );
      }
      backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
    });

    // Delete folders.
    const results = [];
    for (const wsId of cleaned) {
      const possiblePaths = getWorkshopPaths(wsId, serverPath || "");
      let removed = false;
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          try {
            fs.rmSync(p, { recursive: true, force: true });
            removed = true;
            break;
          } catch (e) {
            log.warn(`Failed to delete ${p}: ${e.message}`);
          }
        }
      }
      results.push({ workshopId: wsId, deletedFromDisk: removed });
    }

    // Drop from tracking, then ADD to the ignore list so auto-sync won't
    // re-track the mod next time Steam re-downloads it.
    let trackedById = new Map();
    try {
      for (const m of (await getTrackedMods()) || []) {
        if (m?.workshop_id)
          trackedById.set(String(m.workshop_id), m.name || null);
      }
    } catch {
      /* ignore */
    }
    for (const wsId of cleaned) {
      try {
        await removeTrackedMod(wsId);
      } catch {
        /* ignore */
      }
      try {
        await addIgnoredMod(wsId, trackedById.get(wsId) || null);
      } catch {
        /* ignore */
      }
    }

    const deletedCount = results.filter((r) => r.deletedFromDisk).length;
    log.info(
      `Batch deleted ${deletedCount}/${cleaned.length} disk mods (mod IDs stripped: ${allModIdsToStrip.size}, map folders stripped: ${allMapFoldersToStrip.size})`,
    );
    res.json({
      success: true,
      total: cleaned.length,
      deletedFromDisk: deletedCount,
      modIdsStripped: allModIdsToStrip.size,
      mapFoldersStripped: allMapFoldersToStrip.size,
      results,
      ...(backupWarning ? { backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to batch delete disk mods: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Smart triage for the "Subscribed Workshop items not enabled" diagnostic.
// For each orphan workshop ID (in WorkshopItems= but not loadable via Mods=),
// decide per-ID:
//   - ignored OR folder missing on disk  → drop from WorkshopItems=
//   - folder present on disk             → resolve its mod IDs and add to Mods=
// One INI write for the whole batch. Returns a per-ID breakdown.
router.post("/resolve-orphan-workshop", async (req, res) => {
  try {
    const { workshopIds } = req.body || {};
    if (!Array.isArray(workshopIds) || workshopIds.length === 0) {
      return res
        .status(400)
        .json({
          error: "workshopIds must be a non-empty array",
          code: ErrorCode.MODS_WORKSHOP_IDS_ARRAY_REQUIRED,
        });
    }

    // sibling-convention sweep, 2026-09-08: same missing-cap shape as
    // /batch-delete-disk-mods just above -- /batch-remove established a
    // 500-item cap "to prevent abuse" for this exact array shape and this
    // route never adopted it, despite doing the same per-ID filesystem scan
    // (findAllModIdsFromWorkshop) that scan does. No disk deletion here
    // (INI-only, same severity class as /batch-remove), so same cap, same
    // reasoning, own code per this file's convention.
    if (workshopIds.length > 500) {
      return res.status(400).json({
        error: "Maximum 500 mods per batch",
        code: ErrorCode.MODS_RESOLVE_ORPHAN_WORKSHOP_TOO_MANY,
      });
    }

    const cleaned = workshopIds
      .map(String)
      .filter((id) => /^\d{1,15}$/.test(id));
    if (cleaned.length === 0) {
      return res.status(400).json({
        error: "No valid workshop IDs provided",
        code: ErrorCode.MODS_NO_VALID_WORKSHOP_IDS,
      });
    }

    const { serverConfigPath, serverName, serverPath, configRefusal } = await getActiveServerPaths();
    if (!serverConfigPath || !serverName) {
      return res.status(400).json(
        withConfigRefusal(configRefusal, {
          error: "Server config path not set",
          code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
        }),
      );
    }
    const sanitized = path.basename(serverName);
    if (sanitized !== serverName || serverName.includes("..")) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }
    const iniPath = path.join(serverConfigPath, `${sanitized}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(404).json({
        error: "Server INI not found",
        code: ErrorCode.MODS_SERVER_INI_NOT_FOUND,
      });
    }

    const ignoredSet = new Set();
    try {
      for (const m of (await getIgnoredMods()) || []) {
        if (m?.workshop_id) ignoredSet.add(String(m.workshop_id));
      }
    } catch {
      /* best-effort */
    }

    // Classify each orphan.
    const wsToDrop = new Set();
    const modIdsToAdd = new Set();
    const breakdown = [];
    for (const wsId of cleaned) {
      const ignored = ignoredSet.has(wsId);
      const folderExists = serverPath
        ? getWorkshopPaths(wsId, serverPath).some((p) => fs.existsSync(p))
        : false;
      let action;
      const ids =
        folderExists && serverPath
          ? findAllModIdsFromWorkshop(wsId, serverPath)
          : [];

      if (ignored) {
        wsToDrop.add(wsId);
        action = "dropped-ignored";
      } else if (!folderExists) {
        wsToDrop.add(wsId);
        action = "dropped-missing";
      } else if (ids.length === 0) {
        // Folder exists but no readable mod.info — treat as dead.
        wsToDrop.add(wsId);
        action = "dropped-no-mod-info";
      } else {
        for (const m of ids) modIdsToAdd.add(m);
        action = "enabled";
      }
      breakdown.push({ workshopId: wsId, action, modIds: ids });
    }

    // Apply both INI mutations in a single locked write.
    let backupWarning = null;
    await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);

      if (wsToDrop.size > 0) {
        // Widened to tolerate whitespace around "=" (hunt-wave13,
        // 783672aa) -- wsMatch is the exists-check for the replace below.
        const wsMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
        if (wsMatch) {
          const wsList = splitIniList(wsMatch[1])
            .filter((id) => !wsToDrop.has(id));
          content = content.replace(
            /^[ \t]*WorkshopItems[ \t]*=.*/m,
            () => `WorkshopItems=${sanitizeIniList(wsList)}`,
          );
        }
      }

      if (modIdsToAdd.size > 0) {
        // Widened to tolerate whitespace around "=" (hunt-wave13,
        // 783672aa) -- modsMatch is the exists-check for the replace below.
        const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
        const existing = splitModIdList(modsMatch?.[1]);
        // Keep the EXISTING list as it is (the numeric-ID filter used to run
        // over it and dropped a legitimate all-digit mod id of another
        // workshop item), then union with the IDs we just resolved from
        // mod.info. Those are authoritative, so they bypass the numeric-ID
        // filter — some mods legitimately use their workshop ID as their mod
        // ID (e.g. "Tear All Clothes" 3519629457).
        const finalList = [...existing];
        for (const m of modIdsToAdd) {
          if (!finalList.includes(m)) finalList.push(m);
        }
        const newLine = `Mods=${sanitizeIniList(finalList)}`;
        content = modsMatch
          ? content.replace(/^[ \t]*Mods[ \t]*=.*/m, () => newLine)
          : content.trimEnd() + `\n${newLine}\n`;
      }

      backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
    });

    const counts = {
      enabled: breakdown.filter((b) => b.action === "enabled").length,
      droppedIgnored: breakdown.filter((b) => b.action === "dropped-ignored")
        .length,
      droppedMissing: breakdown.filter((b) => b.action === "dropped-missing")
        .length,
      droppedNoModInfo: breakdown.filter(
        (b) => b.action === "dropped-no-mod-info",
      ).length,
    };
    log.info(
      `Resolve-orphan-workshop: enabled=${counts.enabled}, droppedIgnored=${counts.droppedIgnored}, droppedMissing=${counts.droppedMissing}, droppedNoModInfo=${counts.droppedNoModInfo} (modIdsAdded=${modIdsToAdd.size}, wsDropped=${wsToDrop.size})`,
    );
    res.json({
      success: true,
      total: cleaned.length,
      counts,
      modIdsAdded: modIdsToAdd.size,
      wsDropped: wsToDrop.size,
      breakdown,
      ...(backupWarning ? { backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to resolve orphan workshop items: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ─── Mod thumbnail proxy ────────────────────────────────────────────────────
// Streams the Steam Workshop preview image for a tracked mod, caching the
// bytes to disk so we hit Steam at most once per mod. Loaded via <img> tags
// so it must remain auth-exempt (see services/auth.js middleware).
//
// Cache lives at <dataDir>/mod-thumbnails/<workshopId>.img — single file per
// mod, no extension games. Content-Type is always reported as image/jpeg;
// browsers handle the actual decoding regardless (Steam serves JPEG or PNG).
//
// Being auth-exempt, this route is reachable by anyone who can reach the
// panel, before first-run setup included. It used to fetch and permanently
// cache the preview of ANY Workshop id it was handed (any game's, tracked or
// not), so an anonymous caller could fill the data volume -- shared with
// world saves on single-host installs -- one ~1 MB file per request. It now
// only ever goes to Steam (and to disk) for a mod tracked on the active
// server -- getTrackedMods(), the same list the Mods page renders every
// thumbnail from -- and only for a Workshop item that belongs to Project
// Zomboid (consumer_app_id). The set of files it can create is therefore
// bounded by what an admin or technician has tracked. Anything else gets
// the placeholder with no network call and no disk write. An image already
// on disk is still served as-is: reading it costs nothing and grows nothing.
//
// SECURITY (2026-10-05, H3): ...but only for a mod tracked on the active
// server, checked before the disk cache too. Versions before the DISKFILL
// fix cached thumbnails for any id an anonymous caller named, and those
// files stayed on disk for good and kept being served. Files for ids no
// server tracks are pruned (pruneModThumbnailCache()): at startup, and in
// the background -- at most once per THUMB_PRUNE_INTERVAL_MS -- when a
// thumbnail is written or a request finds one for an untracked id.
//
// A resolution FAILURE is never written to that disk cache (there is nothing
// worth persisting), which used to mean a host where resolution is broken —
// missing preview_url and an unreachable/failing Steam — re-ran the full
// Steam round trip for every tracked mod on every single page load, forever.
// THUMB_FAIL_CACHE remembers a failure for THUMB_FAIL_TTL_MS so it can be
// skipped cheaply instead of retried immediately, without ever writing
// anything to disk, so it can never be confused with a real cached image.
// It must expire — a transient outage should not blank a thumbnail forever —
// so failures are retried periodically rather than cached indefinitely.
const THUMB_FETCH_TIMEOUT_MS = 12_000;
const THUMB_MAX_BYTES = 5 * 1024 * 1024; // 5 MB hard cap
const THUMB_INFLIGHT = new Map(); // workshopId → Promise<Buffer|null>
const THUMB_EMPTY_GIF = Buffer.from(
  "R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64",
);
// Retry a failed resolve sooner than "never" — same interval mapProxy.js
// uses for the same reason (B42_DIR_RETRY_MS), for consistency across the
// codebase's failed-external-resolution retry windows.
const THUMB_FAIL_TTL_MS = 5 * 60 * 1000;
const THUMB_FAIL_CACHE = new Map(); // workshopId → { failedAt, reason }
// Hard ceiling on THUMB_FAIL_CACHE: entries only expire lazily (on lookup),
// so without a cap the map grows with every distinct id that ever failed.
// Only tracked ids can fail now, but the cap holds regardless; the oldest
// entry goes first (a Map iterates in insertion order).
const THUMB_FAIL_CACHE_MAX = 1000;
// Steam app id of Project Zomboid. A Workshop item's consumer_app_id names
// the game it belongs to (collections included); anything else is not a PZ
// mod and its preview is never fetched or cached.
const THUMB_PZ_APP_ID = 108600;
let _thumbLastFailure = null; // { workshopId, reason, at } — outlives any one entry's TTL, for diagnostics
// Background prunes of the disk cache, after the startup one: at most one
// per interval, however many writes or untracked hits ask for one.
const THUMB_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
// A "<id>.img.tmp-<pid>-<ms>" this old is a write that never finished (the
// process died between writeFile and rename); a younger one may be in flight.
const THUMB_TMP_MAX_AGE_MS = 60 * 60 * 1000;
const THUMB_CACHE_FILE_RE = /^(\d{1,15})\.img$/;
const THUMB_CACHE_TMP_RE = /^\d{1,15}\.img\.tmp-/;
let _thumbPrune = null; // the prune running now, if any
let _thumbLastPruneAt = 0;

function thumbnailCacheDir() {
  return path.join(getDataPaths().dataDir, "mod-thumbnails");
}

/**
 * Delete cached thumbnails of Workshop ids no server tracks (and abandoned
 * temp files). Concurrent calls share one run. Resolves to { removed, kept }.
 */
export function pruneModThumbnailCache() {
  if (_thumbPrune) return _thumbPrune;
  _thumbLastPruneAt = Date.now();
  _thumbPrune = (async () => {
    const cacheDir = thumbnailCacheDir();
    let names;
    try {
      names = await fsp.readdir(cacheDir);
    } catch (err) {
      if (err.code === "ENOENT") return { removed: 0, kept: 0 };
      throw err;
    }
    // Read after the listing: every file in it was written for a mod that
    // was tracked then, so one tracked since the listing is in this set too.
    const { getAllTrackedWorkshopIds } = await import("../database/init.js");
    const tracked = await getAllTrackedWorkshopIds();
    let removed = 0;
    let kept = 0;
    for (const name of names) {
      const cached = THUMB_CACHE_FILE_RE.exec(name);
      const filePath = path.join(cacheDir, name);
      try {
        if (cached) {
          if (tracked.has(cached[1])) {
            kept++;
            continue;
          }
        } else if (THUMB_CACHE_TMP_RE.test(name)) {
          const st = await fsp.stat(filePath);
          if (Date.now() - st.mtimeMs < THUMB_TMP_MAX_AGE_MS) continue;
        } else {
          continue; // not something this cache wrote
        }
        await fsp.unlink(filePath);
        removed++;
      } catch (err) {
        if (err.code !== "ENOENT") log.debug(`Could not prune cached thumbnail ${name}: ${err.message}`);
      }
    }
    if (removed > 0) {
      log.info(`Removed ${removed} cached mod thumbnail file(s) for Workshop items no server tracks`);
    }
    return { removed, kept };
  })().finally(() => {
    _thumbPrune = null;
  });
  return _thumbPrune;
}

// A background prune unless one ran (or started) within the interval.
function pruneModThumbnailCacheSoon() {
  if (_thumbPrune || Date.now() - _thumbLastPruneAt < THUMB_PRUNE_INTERVAL_MS) return;
  pruneModThumbnailCache().catch((err) =>
    log.debug(`Mod thumbnail cache prune failed: ${err.message}`),
  );
}

function recordThumbFailure(wsId, reason) {
  const failedAt = Date.now();
  THUMB_FAIL_CACHE.delete(wsId);
  while (THUMB_FAIL_CACHE.size >= THUMB_FAIL_CACHE_MAX) {
    THUMB_FAIL_CACHE.delete(THUMB_FAIL_CACHE.keys().next().value);
  }
  THUMB_FAIL_CACHE.set(wsId, { failedAt, reason });
  _thumbLastFailure = { workshopId: wsId, reason, at: failedAt };
}

function clearThumbFailure(wsId) {
  THUMB_FAIL_CACHE.delete(wsId);
}

// Live (non-expired) failure entry for wsId, or null. Prunes the entry as a
// side effect once it has expired, so no separate cleanup timer is needed.
function liveThumbFailure(wsId) {
  const entry = THUMB_FAIL_CACHE.get(wsId);
  if (!entry) return null;
  if (Date.now() - entry.failedAt >= THUMB_FAIL_TTL_MS) {
    THUMB_FAIL_CACHE.delete(wsId);
    return null;
  }
  return entry;
}

// For Debug diagnostics / the support bundle: how many tracked mods are
// currently in a failed-resolution state, and what the most recent failure
// was (which can outlive any individual entry's TTL).
export async function getThumbnailResolutionStatus() {
  const now = Date.now();
  let failing = 0;
  for (const [wsId, entry] of [...THUMB_FAIL_CACHE]) {
    if (now - entry.failedAt < THUMB_FAIL_TTL_MS) {
      failing++;
    } else {
      THUMB_FAIL_CACHE.delete(wsId);
    }
  }
  const tracked = await getTrackedMods();
  return { failing, total: tracked.length, lastError: _thumbLastFailure };
}

function sendEmptyThumbnail(res, cacheControl = "public, max-age=3600") {
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", cacheControl);
  return res.end(THUMB_EMPTY_GIF);
}

async function fetchSteamPreviewUrl(workshopId) {
  // Fallback: hit GetPublishedFileDetails for a single ID if our DB row has no
  // preview_url yet (mod was added but update check hasn't run).
  const params = new URLSearchParams();
  params.append("itemcount", "1");
  params.append("publishedfileids[0]", workshopId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), THUMB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
      { method: "POST", body: params, signal: controller.signal },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const item = data?.response?.publishedfiledetails?.[0];
    if (
      item?.result === 1 &&
      Number(item.consumer_app_id) === THUMB_PZ_APP_ID &&
      typeof item.preview_url === "string"
    ) {
      return item.preview_url;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadThumbnail(previewUrl) {
  // Only allow Steam CDN hosts to prevent SSRF via tampered DB values.
  let parsed;
  try {
    parsed = new URL(previewUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  const allowed =
    host === "steamuserimages-a.akamaihd.net" ||
    host.endsWith(".steamstatic.com") ||
    host.endsWith(".akamaihd.net") ||
    host === "images.steamusercontent.com";
  if (!allowed) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), THUMB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(previewUrl, { signal: controller.signal });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) return null;
    const len = parseInt(res.headers.get("content-length") || "0", 10);
    if (len && len > THUMB_MAX_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > THUMB_MAX_BYTES) return null;
    return buf;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

router.get("/thumbnail/:workshopId", async (req, res) => {
  const wsId = String(req.params.workshopId || "");
  if (!/^\d{1,15}$/.test(wsId)) {
    return res.status(400).end();
  }

  const cacheDir = thumbnailCacheDir();
  const cacheFile = path.join(cacheDir, `${wsId}.img`);

  // Defensive: confirm resolved path stays inside cacheDir.
  if (!cacheFile.startsWith(cacheDir + path.sep)) {
    return res.status(400).end();
  }

  // Only a mod tracked on the active server gets its thumbnail, from the
  // disk cache or from Steam (see the header comment). Not a failure:
  // nothing is recorded, and the placeholder is not cacheable, so the real
  // image shows up as soon as the mod is tracked. A file left on disk for
  // an untracked id is never served, and gets the cache pruned.
  let mod = null;
  try {
    mod = (await getTrackedMods()).find((m) => m.workshop_id === wsId) || null;
  } catch (err) {
    log.debug(`Thumbnail tracked-mod lookup failed for ${wsId}: ${err.message}`);
  }
  if (!mod) {
    fsp.stat(cacheFile).then(() => pruneModThumbnailCacheSoon(), () => {});
    return sendEmptyThumbnail(res, "no-store");
  }

  try {
    const st = await fsp.stat(cacheFile);
    if (st.size > 0) {
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      // res.sendFile() needs a callback: without one, Express's default on a
      // failed send (the cache file vanishing between the stat() above and
      // this call, a permission problem, anything) is next(err) -- which
      // lands in server/index.js's generic apiErrorHandler and gets logged
      // as `[ERROR] [Panel] Unhandled API error on GET /mods/thumbnail/<id>:
      // Not Found`, at ERROR severity, indistinguishable from a real bug. A
      // real user's support bundle (2026-09-08) had 300+ of these -- the
      // single largest thing in error.log, burying every other error next
      // to it. Every OTHER failure path in this function already falls back
      // to the placeholder gif via sendEmptyThumbnail() instead of
      // propagating; this is the one path that didn't.
      return res.sendFile(cacheFile, (err) => {
        if (!err || res.headersSent) return;
        log.debug(`Cached thumbnail for ${wsId} vanished before it could be sent: ${err.message}`);
        recordThumbFailure(wsId, err.message);
        sendEmptyThumbnail(res);
      });
    }
  } catch {
    /* not cached yet */
  }

  // A recent failure for this mod is remembered — skip straight to the
  // placeholder with zero network calls instead of retrying every request.
  if (liveThumbFailure(wsId)) {
    return sendEmptyThumbnail(res);
  }

  // Coalesce concurrent requests for the same mod.
  let pending = THUMB_INFLIGHT.get(wsId);
  if (!pending) {
    pending = (async () => {
      let previewUrl = mod.preview_url || null;
      if (!previewUrl) {
        previewUrl = await fetchSteamPreviewUrl(wsId);
        if (previewUrl) {
          try {
            const { setModPreviewUrl } = await import("../database/init.js");
            await setModPreviewUrl(wsId, previewUrl);
          } catch {
            /* best-effort */
          }
        }
      }
      if (!previewUrl) {
        recordThumbFailure(wsId, "no Steam preview URL available");
        return null;
      }
      const buf = await downloadThumbnail(previewUrl);
      if (!buf) {
        recordThumbFailure(wsId, "preview image download failed");
        return null;
      }
      await fsp.mkdir(cacheDir, { recursive: true });
      const tmp = `${cacheFile}.tmp-${process.pid}-${Date.now()}`;
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, cacheFile);
      clearThumbFailure(wsId);
      pruneModThumbnailCacheSoon();
      return buf;
    })().finally(() => {
      THUMB_INFLIGHT.delete(wsId);
    });
    THUMB_INFLIGHT.set(wsId, pending);
  }

  try {
    const buf = await pending;
    if (!buf) return sendEmptyThumbnail(res);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return res.end(buf);
  } catch (err) {
    log.debug(`Thumbnail fetch failed for ${wsId}: ${err.message}`);
    recordThumbFailure(wsId, err.message);
    return sendEmptyThumbnail(res);
  }
});

export default router;
