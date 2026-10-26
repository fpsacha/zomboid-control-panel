import fs from "fs";
import path from "path";
import os from "os";
import { createLogger } from "../utils/logger.js";
import { sanitizeIniValue, looksLikeWorkshopId } from "../utils/sanitize.js";
import { readTextFile } from "../utils/modIni.js";
import { orderingFieldsFromModInfo, parseModInfoForGame } from "../utils/modLoadOrder.js";

// Readers for a downloaded Workshop item's folders: where the item lives on
// disk, which mods (mod.info ids) and map folders it holds. Moved verbatim out
// of routes/mods.js (behaviour-preserving) so the code that decides which
// mod id the game would load is testable on its own and shared by the routes.
const log = createLogger("API:Mods");

// Helper to get workshop paths for a mod
export function getWorkshopPaths(workshopId, serverPath) {
  const home = os.homedir();
  const paths = [
    // Server's steamapps folder
    path.join(
      serverPath,
      "steamapps",
      "workshop",
      "content",
      "108600",
      workshopId,
    ),
    // Alternative location
    path.join(
      serverPath,
      "..",
      "steamapps",
      "workshop",
      "content",
      "108600",
      workshopId,
    ),
    // User's Steam folder — platform-specific
    path.join(
      home,
      "Steam",
      "steamapps",
      "workshop",
      "content",
      "108600",
      workshopId,
    ),
  ];
  // Add Linux-specific Steam paths
  if (process.platform !== "win32") {
    paths.push(
      path.join(
        home,
        ".local",
        "share",
        "Steam",
        "steamapps",
        "workshop",
        "content",
        "108600",
        workshopId,
      ),
      path.join(
        home,
        ".steam",
        "steam",
        "steamapps",
        "workshop",
        "content",
        "108600",
        workshopId,
      ),
      // Flatpak Steam sandboxes $HOME under ~/.var/app/<appid>, so its
      // steamapps live at a completely different path from a native install.
      path.join(
        home,
        ".var",
        "app",
        "com.valvesoftware.Steam",
        ".local",
        "share",
        "Steam",
        "steamapps",
        "workshop",
        "content",
        "108600",
        workshopId,
      ),
    );
  }
  return paths;
}

// Helper to check if a map folder contains actual map tile data (not just overlays/spawns)
// Valid map folders have .lotheader, objects.lua, or .lotpack/.bin cell data
function isValidMapFolder(mapFolderPath) {
  try {
    // codeql[js/path-injection] workshopId is validated as /^\d{1,15}$/ at this file's POST /inspect-workshop-item handler before reaching getWorkshopPaths/getModDetailsFromWorkshop/findMapFoldersFromWorkshop -- CodeQL's only tracked source for this sink is that numeric-validated field.
    const files = fs.readdirSync(mapFolderPath);
    for (const file of files) {
      const lower = file.toLowerCase();
      if (
        lower.endsWith(".lotheader") ||
        lower === "objects.lua" ||
        lower.endsWith(".lotpack")
      ) {
        return true;
      }
      // Cell data files like chunkdata_*_*_*.bin or world_*_*.lotpack
      if (lower.startsWith("world_") || lower.startsWith("chunkdata_")) {
        return true;
      }
    }
    return false;
  } catch (e) {
    log.debug(`Error validating map folder ${mapFolderPath}: ${e.message}`);
    return false;
  }
}

// SECURITY (2026-10-20): a map folder's name goes into the server .ini's
// Map= line as it is on disk. A Workshop item is someone else's content, and
// on Linux a folder name may hold a line break (a new ini line, such as
// "DiscordToken=..."), a ";" (two map entries), an "=" (the game cuts the
// value there) or another control char. No such name can be a map the game
// loads from Map=, so it is not offered at all.
const UNWRITABLE_MAP_FOLDER_CHARS = /[\u0000-\u001f\u007f;=]/;
export function isWritableMapFolderName(name) {
  return typeof name === "string" && name.trim() !== "" && !UNWRITABLE_MAP_FOLDER_CHARS.test(name);
}

// Helper function to find map folders from a workshop mod
// Map mods have a media/maps folder with their map folder inside
// Only returns folders that contain actual map tile data
export function findMapFoldersFromWorkshop(workshopId, serverPath) {
  const mapFolders = [];
  const possiblePaths = getWorkshopPaths(workshopId, serverPath);

  // Helper: scan a media/maps directory for valid map subfolders
  function scanMapsDir(mapsPath) {
    // codeql[js/path-injection] workshopId is validated as /^\d{1,15}$/ at this file's POST /inspect-workshop-item handler before reaching getWorkshopPaths/getModDetailsFromWorkshop/findMapFoldersFromWorkshop -- CodeQL's only tracked source for this sink is that numeric-validated field.
    if (!fs.existsSync(mapsPath)) return;
    // codeql[js/path-injection] workshopId is validated as /^\d{1,15}$/ at this file's POST /inspect-workshop-item handler before reaching getWorkshopPaths/getModDetailsFromWorkshop/findMapFoldersFromWorkshop -- CodeQL's only tracked source for this sink is that numeric-validated field.
    const mapEntries = fs.readdirSync(mapsPath, { withFileTypes: true });
    for (const mapEntry of mapEntries) {
      if (mapEntry.isDirectory() && !isWritableMapFolderName(mapEntry.name)) {
        log.warn(
          `Workshop item ${workshopId}: skipped map folder ${JSON.stringify(mapEntry.name)}; its name cannot be written to Map=`,
        );
        continue;
      }
      if (
        mapEntry.isDirectory() &&
        !mapFolders.includes(mapEntry.name) &&
        isValidMapFolder(path.join(mapsPath, mapEntry.name))
      ) {
        mapFolders.push(mapEntry.name);
        log.debug(
          `Found valid map folder: ${mapEntry.name} in workshop ${workshopId}`,
        );
      }
    }
  }

  for (const workshopPath of possiblePaths) {
    // codeql[js/path-injection] workshopId is validated as /^\d{1,15}$/ at this file's POST /inspect-workshop-item handler before reaching getWorkshopPaths/getModDetailsFromWorkshop/findMapFoldersFromWorkshop -- CodeQL's only tracked source for this sink is that numeric-validated field.
    if (!fs.existsSync(workshopPath)) continue;

    // Look for mods subfolder first (some mods have mods/ModName/media/maps structure)
    const modsFolder = path.join(workshopPath, "mods");
    // codeql[js/path-injection] workshopId is validated as /^\d{1,15}$/ at this file's POST /inspect-workshop-item handler before reaching getWorkshopPaths/getModDetailsFromWorkshop/findMapFoldersFromWorkshop -- CodeQL's only tracked source for this sink is that numeric-validated field.
    const searchPath = fs.existsSync(modsFolder) ? modsFolder : workshopPath;

    try {
      // codeql[js/path-injection] workshopId is validated as /^\d{1,15}$/ at this file's POST /inspect-workshop-item handler before reaching getWorkshopPaths/getModDetailsFromWorkshop/findMapFoldersFromWorkshop -- CodeQL's only tracked source for this sink is that numeric-validated field.
      if (fs.existsSync(searchPath)) {
        // codeql[js/path-injection] workshopId is validated as /^\d{1,15}$/ at this file's POST /inspect-workshop-item handler before reaching getWorkshopPaths/getModDetailsFromWorkshop/findMapFoldersFromWorkshop -- CodeQL's only tracked source for this sink is that numeric-validated field.
        const entries = fs.readdirSync(searchPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const entryPath = path.join(searchPath, entry.name);

          // Check standard path: <entry>/media/maps/
          scanMapsDir(path.join(entryPath, "media", "maps"));

          // B42 multi-version layout: probe every direct subdirectory for
          // <entry>/<sub>/media/maps/ (covers common, 42, 42.0, 42.1, 41,
          // 43, and any future version folder).
          try {
            // codeql[js/path-injection] workshopId is validated as /^\d{1,15}$/ at this file's POST /inspect-workshop-item handler before reaching getWorkshopPaths/getModDetailsFromWorkshop/findMapFoldersFromWorkshop -- CodeQL's only tracked source for this sink is that numeric-validated field.
            const subEntries = fs.readdirSync(entryPath, {
              withFileTypes: true,
            });
            for (const sub of subEntries) {
              if (sub.isDirectory()) {
                scanMapsDir(path.join(entryPath, sub.name, "media", "maps"));
              }
            }
          } catch {
            // Ignore unreadable mod folders
          }
        }
      }

      // Also check direct media/maps path (some mods don't have mods subfolder)
      scanMapsDir(path.join(workshopPath, "media", "maps"));

      if (mapFolders.length > 0) return mapFolders;
    } catch (e) {
      // Continue to next path
    }
  }

  return mapFolders;
}

// The mod (from getModDetailsFromWorkshop) that lives in the mod folder
// `folderName`. The folder getModDetailsFromWorkshop recorded is the exact
// answer; matching the folder name against a mod's id or display name is the
// older heuristic, kept as the fallback because plenty of mods name the folder
// after themselves. A mod whose folder is named after neither used to match
// nothing -- the conflict scan then treated the folder name as its id and
// skipped it as "not in Mods=".
export function findModForFolder(modDetails, folderName) {
  return (
    modDetails.find((m) => m.folder === folderName) ||
    modDetails.find((m) => m.id === folderName || m.name === folderName)
  );
}

// Helper function to find ALL mod IDs from workshop folder (returns array)
export function findAllModIdsFromWorkshop(workshopId, serverPath) {
  const mods = getModDetailsFromWorkshop(workshopId, serverPath);
  return mods.map((m) => m.id);
}

/**
 * The mod ids of `modIds` and folders of `mapFolders` that an item of
 * `listedWorkshopIds` (what WorkshopItems= keeps) ships too. A remove or a
 * disk delete of one Workshop item leaves those in Mods= and Map=: a
 * re-upload under a new Workshop ID keeps the mod id, so taking the old item
 * out (or deleting its download) must not unload the new one. Reads only as
 * many items as it takes to find them all, and maps only when one is asked.
 * Returns { mods: Set, maps: Set }.
 */
export function shippedByListedItems({ modIds = [], mapFolders = [], listedWorkshopIds = [], serverPath }) {
  const wantMods = new Set(modIds);
  const wantMaps = new Set(mapFolders);
  const mods = new Set();
  const maps = new Set();
  if (!serverPath || (wantMods.size === 0 && wantMaps.size === 0)) return { mods, maps };
  for (const wsId of new Set(listedWorkshopIds)) {
    if (mods.size === wantMods.size && maps.size === wantMaps.size) break;
    if (!/^\d{1,15}$/.test(String(wsId))) continue;
    try {
      if (mods.size < wantMods.size) {
        for (const id of findAllModIdsFromWorkshop(String(wsId), serverPath)) {
          if (wantMods.has(id)) mods.add(id);
        }
      }
      if (maps.size < wantMaps.size) {
        for (const folder of findMapFoldersFromWorkshop(String(wsId), serverPath)) {
          if (wantMaps.has(folder)) maps.add(folder);
        }
      }
    } catch {
      // An unreadable item ships nothing we can tell.
    }
  }
  return { mods, maps };
}

// Helper function to find mod ID from workshop folder
export function findModIdFromWorkshop(workshopId, serverPath) {
  // Use shared helper to parse details
  const mods = getModDetailsFromWorkshop(workshopId, serverPath);
  // Return the first ID found (legacy behavior)
  return mods.length > 0 ? mods[0].id : null;
}

// A workshop-ID-shaped modId is ambiguous by regex alone: some mods
// legitimately use their Steam Workshop file ID as their mod.info id= too
// (e.g. "Tear All Clothes" 3519629457 -- see enable-disk-mod/
// resolve-orphan-workshop above, which already trust disk-resolved IDs
// unconditionally for this exact reason). Disk verification is strictly
// MORE evidence than the regex that flagged it ambiguous in the first
// place, so toggle/batch-toggle can use it to tell a real numeric mod ID
// apart from an actually-misplaced workshop ID, instead of rejecting both
// alike. Checks every currently-configured WorkshopItems= entry (not just
// one) since we don't know in advance which workshop item owns this mod ID.
export function isModIdVerifiedOnDisk(modId, currentWorkshopIds, serverPath) {
  if (!serverPath || !currentWorkshopIds?.length) return false;
  for (const wsId of currentWorkshopIds) {
    try {
      if (findAllModIdsFromWorkshop(wsId, serverPath).includes(modId)) {
        return true;
      }
    } catch {
      // Unreadable/missing workshop folder for this ID -- not evidence
      // either way, keep checking the rest.
    }
  }
  return false;
}

// Same job as sanitizeModIdList (utils/sanitize.js), plus the disk-
// verification bypass above: a numeric-looking entry is dropped UNLESS it's
// independently confirmed by a real mod.info on disk. Order-preserving
// single pass -- unlike a filter-then-append union, this doesn't reshuffle
// a disk-verified entry to the end of the list, which would silently change
// load order as a side effect of an unrelated toggle. Used for
// toggle/batch-toggle, which (unlike save-order/presets-apply) mutate one
// entry in an existing list rather than replacing the whole thing, so a
// pre-existing numeric-ID mod elsewhere in that list is also at risk of
// being silently dropped by a completely unrelated toggle if this isn't
// applied to the FULL list, not just the entry being toggled.
//
// `keepIds` is the Mods= line as it was before this edit. Every route that
// rewrites the line (add, remove, dedupe, delete, sync, ...) reads it, changes
// a few entries and writes the whole list back, so an entry that was already
// there is never this call's to judge: the numeric filter only applies to what
// the edit itself adds. Without it, an unrelated edit dropped a legitimate
// all-digit mod id whose workshop item was not on disk (not downloaded yet, or
// listed under another folder), exactly like the old sanitizeModIdList did.
// The disk index is built once, and only when a numeric entry needs it.
export function sanitizeModIdListWithDiskBypass(
  ids,
  currentWorkshopIds,
  serverPath,
  keepIds = [],
) {
  const keep = new Set((keepIds || []).map((raw) => sanitizeIniValue(raw)));
  let onDisk = null;
  const verifiedOnDisk = (value) => {
    if (!serverPath || !currentWorkshopIds?.length) return false;
    if (!onDisk) {
      onDisk = new Set();
      for (const wsId of currentWorkshopIds) {
        try {
          for (const id of findAllModIdsFromWorkshop(wsId, serverPath)) onDisk.add(id);
        } catch {
          // Unreadable/missing workshop folder for this ID -- not evidence
          // either way, keep checking the rest.
        }
      }
    }
    return onDisk.has(value);
  };

  const out = [];
  for (const raw of ids || []) {
    const v = sanitizeIniValue(raw);
    if (!v) continue;
    if (looksLikeWorkshopId(v) && !keep.has(v) && !verifiedOnDisk(v)) {
      continue;
    }
    out.push(v);
  }
  return out.join(";");
}

// Remove a single mod from server .ini file

// Helper to getting full details of mods inside a workshop item.
//
// B42 introduced a multi-version layout where mod.info can live under
// versioned subdirectories of the mod folder (e.g. <mod>/common/mod.info,
// <mod>/42/mod.info, <mod>/42.0/mod.info, future <mod>/43/mod.info, ...).
// We probe the mod root AND every direct subdirectory so we resolve mods
// regardless of which layout the author used, instead of relying on a
// fixed allowlist of folder names.
//
// The game, though, reads exactly ONE mod.info per mod folder (the best
// version folder's, else common/) and takes the id from it the way
// zombie.gameStates.ChooseGameInfo.readModInfoAux does: a line counts only
// when it STARTS with "id=" (no leading space, lower case), its value is
// trimmed, a blank value is ignored, and the LAST such line wins. So a
// mod.info that lists three ids is one mod (the third), not three, and the
// ids of the older version folders do not exist for the game at all. Each mod
// folder therefore yields one mod here: the id the game would load. (Several
// folders in one workshop item are still several mods.)
function parseModInfoVersionFolder(folderName) {
  if (!/^\d+(?:\.\d+)*$/.test(folderName)) return null;
  return folderName.split(".").map((part) => Number.parseInt(part, 10));
}

function compareModInfoCandidatePaths(leftCandidate, rightCandidate) {
  const leftVersion = leftCandidate.version;
  const rightVersion = rightCandidate.version;

  if (leftVersion && !rightVersion) return -1;
  if (!leftVersion && rightVersion) return 1;

  if (leftVersion && rightVersion) {
    const maxParts = Math.max(leftVersion.length, rightVersion.length);
    for (let partIndex = 0; partIndex < maxParts; partIndex++) {
      const leftPart = leftVersion[partIndex] || 0;
      const rightPart = rightVersion[partIndex] || 0;
      if (leftPart !== rightPart) return rightPart - leftPart;
    }
  }

  return leftCandidate.order - rightCandidate.order;
}

// Parse a mod.info file and return { id, meta: { name, poster, ... } }, where
// `id` is the one the game takes (see the note above): the last non-blank
// value of a line that starts with "id=", or null.
function parseModInfoFile(modInfoPath) {
  let id = null;
  const meta = {};
  let content;
  try {
    content = readTextFile(modInfoPath);
  } catch {
    return { id, meta, game: null };
  }
  if (!content) return { id, meta, game: null };
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  // The ordering lists exactly as the game reads them (utils/modLoadOrder.js).
  const game = parseModInfoForGame(content);
  for (const rawLine of content.split(/\r?\n/)) {
    if (rawLine.startsWith("id=")) {
      // The game does line.replace("id=", "").trim() (every "id=" goes).
      const val = rawLine.split("id=").join("").trim();
      if (val) id = val;
      continue;
    }
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.substring(0, idx).trim();
    const val = line.substring(idx + 1).trim();
    if (!key || key.toLowerCase() === "id") continue;
    if (!(key in meta)) {
      // First-occurrence wins for non-id fields (name/poster/icon/etc.)
      meta[key] = val;
    }
  }
  return { id, meta, game };
}

// The mods of one mods folder (a Workshop item's mods/, the data folder's
// mods/, a staged item's Contents/mods/): one per mod folder, the id the game
// would read, appended to `mods` unless `seenIds` has it. Throws when the
// folder cannot be listed.
function collectModsFromFolder(searchPath, mods, seenIds) {
  const entries = fs.readdirSync(searchPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const modDir = path.join(searchPath, entry.name);
    // Build candidate mod.info paths: the mod root, plus every direct
    // subdirectory (covers `common/`, `42/`, `42.0/`, `41/`, `43/`, ...).
    const candidatePaths = [
      {
        path: path.join(modDir, "mod.info"),
        version: null,
        order: 0,
      },
    ];
    try {
      const subfolders = fs
        // codeql[js/path-injection] workshopId is validated as /^\d{1,15}$/ at this file's POST /inspect-workshop-item handler before reaching getWorkshopPaths/getModDetailsFromWorkshop/findMapFoldersFromWorkshop -- CodeQL's only tracked source for this sink is that numeric-validated field.
        .readdirSync(modDir, { withFileTypes: true })
        .filter((sub) => sub.isDirectory())
        .map((sub) => sub.name)
        .sort((leftName, rightName) =>
          leftName.localeCompare(rightName, undefined, {
            numeric: true,
            sensitivity: "base",
          }),
        );
      for (const [subIndex, subfolder] of subfolders.entries()) {
        candidatePaths.push({
          path: path.join(modDir, subfolder, "mod.info"),
          version: parseModInfoVersionFolder(subfolder),
          order: subIndex + 1,
        });
      }
    } catch (e) {
      log.debug(`Failed to scan subdirs for ${modDir}: ${e.message}`);
    }

    // Version-specific mod.info files may coexist; the game reads one of
    // them, so take the first (newest version folder, then the mod root,
    // then common/ ...) that actually declares an id.
    for (const candidate of candidatePaths
      // codeql[js/path-injection] workshopId is validated as /^\d{1,15}$/ at this file's POST /inspect-workshop-item handler before reaching getWorkshopPaths/getModDetailsFromWorkshop/findMapFoldersFromWorkshop -- CodeQL's only tracked source for this sink is that numeric-validated field.
      .filter((item) => fs.existsSync(item.path))
      .sort(compareModInfoCandidatePaths)) {
      const { id, meta, game } = parseModInfoFile(candidate.path);
      if (!id) continue;
      if (!seenIds.has(id)) {
        seenIds.add(id);
        const ordering = orderingFieldsFromModInfo(game);
        mods.push({
          id,
          // The mod folder the id came from. Not necessarily named after
          // the id or the display name (conflict scanning matches on it).
          folder: entry.name,
          name: meta.name || id,
          poster: meta.poster,
          icon: meta.icon,
          description: meta.description || "",
          url: meta.url,
          require: meta.require
            ? meta.require
                .split(/[,;]/)
                .map((s) => s.trim().replace(/^\\+/, ""))
                .filter(Boolean)
            : [],
          // What the game itself reads (utils/modLoadOrder.js): the raw
          // require= entries it loads (null: no require= line), the
          // ordering lists the main menu uses, and every entry the game
          // cannot match.
          requireRaw: game?.require ?? null,
          loadAfter: ordering.loadAfter,
          loadBefore: ordering.loadBefore,
          incompatible: ordering.incompatible,
          modInfoIssues: ordering.modInfoIssues,
        });
      }
      break;
    }
  }
}

/**
 * The mods of a folder that holds mod folders the way the game's own mods
 * folders do (<Zomboid>/mods, <Zomboid>/Workshop/<item>/Contents/mods): the
 * same reading as getModDetailsFromWorkshop, [] when the folder is missing.
 * Unlike a Workshop item's list, two folders declaring the same id both come
 * back (the game sees both and loads the first it lists).
 */
export function getModDetailsFromModsFolder(folderPath) {
  const mods = [];
  try {
    collectModsFromFolder(folderPath, mods, { has: () => false, add: () => {} });
  } catch (e) {
    log.debug(`Error scanning mods folder ${folderPath}: ${e.message}`);
  }
  return mods;
}

export function getModDetailsFromWorkshop(workshopId, serverPath) {
  const mods = [];
  const seenIds = new Set();
  const possiblePaths = getWorkshopPaths(workshopId, serverPath);

  for (const workshopPath of possiblePaths) {
    // codeql[js/path-injection] workshopId is validated as /^\d{1,15}$/ at this file's POST /inspect-workshop-item handler before reaching getWorkshopPaths/getModDetailsFromWorkshop/findMapFoldersFromWorkshop -- CodeQL's only tracked source for this sink is that numeric-validated field.
    if (!fs.existsSync(workshopPath)) continue;

    const modsFolder = path.join(workshopPath, "mods");
    // codeql[js/path-injection] workshopId is validated as /^\d{1,15}$/ at this file's POST /inspect-workshop-item handler before reaching getWorkshopPaths/getModDetailsFromWorkshop/findMapFoldersFromWorkshop -- CodeQL's only tracked source for this sink is that numeric-validated field.
    const searchPath = fs.existsSync(modsFolder) ? modsFolder : workshopPath;

    try {
      collectModsFromFolder(searchPath, mods, seenIds);

      // If we found mods in this path, stop searching other paths
      if (mods.length > 0) return mods;
    } catch (e) {
      log.debug(`Error scanning path ${searchPath}: ${e.message}`);
    }
  }

  return mods;
}
