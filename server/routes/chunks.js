import express from "express";
import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.js";
const log = createLogger("API:Chunks");
import {
  getSetting,
  setSetting,
  getActiveServer,
  updateServer,
  getServers,
} from "../database/init.js";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.js";
import { requirePermission, getRoleByName } from "../services/permissions.js";
import { deleteVehiclesInBoxes } from "../utils/vehiclesDb.js";
import { confineToRoots } from "../utils/browseRoots.js";
import {
  normalizeUserPath,
  getCandidateZomboidPaths,
  invalidateCandidatePathsCache,
  inspectZomboidPath,
} from "../utils/zomboidPaths.js";
import { ErrorCode } from "../utils/errorCodes.js";

// Re-export for tests / other modules that still pull these from chunks.js.
export { normalizeUserPath, getCandidateZomboidPaths, invalidateMapFolderScan };

const router = express.Router();

// Run `worker` over `items` with at most `limit` in flight at once. Used for
// directory-tree walks where the item count can run into the hundreds or
// thousands (e.g. one X-directory per iteration on a large B42 map) —
// unbounded Promise.all over that many entries can exhaust file handles
// (EMFILE) and, on a spinning array or network share, queue so many
// concurrent round trips that it's slower than doing them one at a time.
// Fully sequential has the opposite problem: on the same slow storage, each
// round trip's latency is paid one after another with nothing overlapped.
// A small bounded batch overlaps latency without either extreme.
//
// The bound is PER CALL, not global. getDirSize/getDirStats
// below call this recursively — each nesting level gets its own fresh
// `limit`-wide batch, so the true worst case across a walk N levels deep is
// limit^N concurrent operations, not limit. For a save shaped like
// savePath -> map -> {X} -> {Y}.bin (3 levels) at limit=8 that's a
// theoretical 8^3=512 in-flight file handles, not 8. A shared semaphore
// threaded through the recursion would cap it at a true global 8, but a
// naive version of that deadlocks: a directory-level worker holds its slot
// while awaiting its own children's walk, and children recursing into the
// same shared pool can end up with every slot held by parents who are
// themselves just waiting — confirmed this by hand before ruling it out,
// not worth attempting again without a proper acquire-then-release-before-
// recursing redesign. Left as a per-level bound: still a large, real
// improvement over the fully-unbounded Promise.all this replaced (which
// had no ceiling at all, i.e. an unbounded, not just larger, blast radius),
// and 512 in a genuine worst case is well below typical OS handle limits
// for the shapes these saves actually take in practice.
async function runWithConcurrency(items, limit, worker) {
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

export async function copyChunkBackup(sourcePath, destinationPath, exclusive = false) {
  try {
    await fs.promises.copyFile(
      sourcePath,
      destinationPath,
      exclusive ? fs.constants.COPYFILE_EXCL : 0,
    );
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// B42: 1 cell = 32×32 chunks (256×256 tiles, 8 tiles/chunk).
// B41: 1 cell = 30×30 chunks (300×300 tiles, 10 tiles/chunk).
function cellDivisorFor(isB42) {
  return isB42 ? 32 : 30;
}
function tilesPerChunkFor(isB42) {
  return isB42 ? 8 : 10;
}

// Filesystem-based B42 detection. Much more reliable than inferring from a
// filename pattern because selections can be chunkdata-only (no `map/X/Y.bin`
// path, which would falsely look like B41). Order:
//   1. map/ contains numeric X subdirectories → B42 layout
//   2. B42 indicator files in save root (WorldDictionary.bin etc)
//   3. fall back to flat B41 layout
function detectSaveIsB42Sync(savePath) {
  try {
    const mapPath = path.join(savePath, "map");
    if (fs.existsSync(mapPath)) {
      const entries = fs.readdirSync(mapPath, { withFileTypes: true });
      if (entries.some((e) => e.isDirectory() && /^\d+$/.test(e.name)))
        return true;
    }
  } catch {
    /* ignore */
  }
  const b42Indicators = [
    "WorldDictionary.bin",
    "global_mod_data.bin",
    "entity_data.bin",
  ];
  return b42Indicators.some((f) => {
    try {
      return fs.existsSync(path.join(savePath, f));
    } catch {
      return false;
    }
  });
}

// Given the set of cells touched by a chunk-deletion pass, determine which
// cells are now FULLY empty (no surviving chunk files anywhere in the cell's
// chunk range) and delete the per-cell auxiliary files (chunkdata, zpop,
// metagrid, apop). If any chunk survives in the cell we leave the cell files
// intact — deleting them nukes state for up to 1023 neighbouring chunks and
// is what made vehicles, zombies and loot "come back" in older builds.
//
// Only handles the B42 map/X/Y.bin layout. For B41 flat layouts, cell files
// typically don't exist or aren't used the same way — we leave them alone to
// avoid clobbering unrelated saves.
//
// If backupPath is provided, each aux file is copied into it before deletion
// so a restore can rebuild the cell exactly. Without this, a "restore from
// backup" leaves the save with chunk files present but no cell metadata —
// PZ would regenerate the cell partially and we'd get inconsistent state.
async function cleanupEmptyCellFiles(
  savePath,
  touchedCells,
  isB42,
  backupPath = null,
) {
  if (!isB42 || touchedCells.size === 0) return { removed: [] };
  const divisor = cellDivisorFor(true);
  const mapPath = path.join(savePath, "map");
  const removed = [];

  for (const key of touchedCells) {
    const [cellX, cellY] = key.split(",").map(Number);
    if (!Number.isInteger(cellX) || !Number.isInteger(cellY)) continue;

    // Check survivors: scan map/{X}/ for any *.bin whose Y falls in the cell's
    // chunk range [cellY*divisor, cellY*divisor+divisor).
    const minChunkX = cellX * divisor;
    const maxChunkX = minChunkX + divisor - 1;
    const minChunkY = cellY * divisor;
    const maxChunkY = minChunkY + divisor - 1;

    let hasSurvivor = false;
    for (let cx = minChunkX; cx <= maxChunkX && !hasSurvivor; cx++) {
      const xDir = path.join(mapPath, String(cx));
      let entries;
      try {
        entries = await fs.promises.readdir(xDir);
      } catch (e) {
        if (e.code === "ENOENT") continue;
        // On unexpected errors, assume survivor to stay safe.
        hasSurvivor = true;
        break;
      }
      for (const name of entries) {
        const m = name.match(/^(\d+)\.bin$/);
        if (!m) continue;
        const y = parseInt(m[1], 10);
        if (y >= minChunkY && y <= maxChunkY) {
          hasSurvivor = true;
          break;
        }
      }
    }

    if (hasSurvivor) continue;

    // Cell is empty on disk — safe to remove per-cell auxiliary files.
    const cellFiles = [
      ["chunkdata", `chunkdata_${cellX}_${cellY}.bin`],
      ["zpop", `zpop_${cellX}_${cellY}.bin`],
      ["metagrid", `metacell_${cellX}_${cellY}.bin`],
      ["apop", `apop_${cellX}_${cellY}.bin`],
    ];
    for (const [folder, file] of cellFiles) {
      const full = path.join(savePath, folder, file);
      try {
        // Back up before deletion if a backup folder was passed. Nested under
        // cellaux/ so the restore script can distinguish these from chunk
        // backups (which live at the top level of backupPath).
        if (backupPath) {
          const cellAuxDir = path.join(backupPath, "cellaux", folder);
          await fs.promises.mkdir(cellAuxDir, { recursive: true });
          await copyChunkBackup(full, path.join(cellAuxDir, file));
        }
        await fs.promises.unlink(full);
        removed.push(`${folder}/${file}`);
      } catch (e) {
        if (e.code !== "ENOENT") {
          log.debug(
            `Failed to delete cell file ${folder}/${file}: ${e.message}`,
          );
        }
      }
    }
  }
  return { removed };
}

// Block all chunk operations for remote servers (no local filesystem access)
router.use(async (req, res, next) => {
  try {
    const activeServer = await getActiveServer();
    if (activeServer?.isRemote) {
      return res
        .status(400)
        .json({
          error:
            "Map cleanup is not available for remote servers. The server filesystem is not accessible from this panel.",
        });
    }
    next();
  } catch (err) {
    next(err);
  }
});

// Helper: Get zomboidDataPath from active server or legacy settings
async function getZomboidDataPath() {
  // First try active server (multi-server support)
  const activeServer = await getActiveServer();
  if (activeServer?.zomboidDataPath) {
    return normalizeUserPath(activeServer.zomboidDataPath);
  }

  // Fallback to legacy settings
  const legacyPath = await getSetting("zomboidDataPath");
  return normalizeUserPath(legacyPath) || null;
}

function resolveSavesPath(zomboidDataPath) {
  let savesPath = path.join(zomboidDataPath, "Saves", "Multiplayer");

  if (!fs.existsSync(savesPath)) {
    const basename = path.basename(zomboidDataPath);
    const parentDir = path.dirname(zomboidDataPath);
    const parentBase = path.basename(parentDir);
    const grandparentBase = path.basename(path.dirname(parentDir));
    if (basename === "Multiplayer" && parentBase === "Saves") {
      // User pointed at .../Saves/Multiplayer directly
      savesPath = zomboidDataPath;
    } else if (basename === "Saves") {
      // User pointed at .../Saves — append Multiplayer
      savesPath = path.join(zomboidDataPath, "Multiplayer");
    } else if (parentBase === "Multiplayer" && grandparentBase === "Saves") {
      // User pointed at an INDIVIDUAL save directory (.../Saves/Multiplayer/<savename>).
      // Walk up one level so we list saves from the right parent. Without this we
      // double-append and log: "Saves path not found: .../<savename>/Saves/Multiplayer".
      savesPath = parentDir;
    }
  }

  return savesPath;
}

function resolveCustomOrDefaultDataPath(customPath) {
  if (!customPath) return null;
  const cleaned = normalizeUserPath(customPath);
  if (!cleaned) return null;
  const normalized = path.resolve(cleaned);
  // SECURITY (2026-09-05, env-var-expansion-oracle): normalizeUserPath()
  // expands %VAR%/${VAR}/$VAR from the raw input. If the EXPANDED value
  // (`normalized`) is echoed back here, a caller who only holds the
  // delegable chunks.manage capability can read any process-environment
  // secret (JWT_SECRET, RCON_PASSWORD, ...) one request at a time via
  // customPath=%SECRET_NAME% — the failure message hands the expansion
  // straight back. Every error below must echo the caller's raw literal
  // (`customPath`), never `normalized`.
  if (!fs.existsSync(normalized)) {
    const error = new Error(
      `Custom path does not exist: ${customPath}. ` +
        `Check for typos and verify the panel has read access to this folder.`,
    );
    error.statusCode = 400;
    error.details = { reason: "not-found", tried: String(customPath) };
    throw error;
  }
  try {
    if (!fs.statSync(normalized).isDirectory()) {
      const error = new Error(`Custom path is not a directory: ${customPath}`);
      error.statusCode = 400;
      error.details = { reason: "not-a-directory", tried: String(customPath) };
      throw error;
    }
  } catch (e) {
    if (e.statusCode) throw e;
    const error = new Error(
      `Could not read custom path (${e.code || "error"}): ${customPath}`,
    );
    error.statusCode = 400;
    error.details = {
      reason: "stat-failed",
      tried: String(customPath),
      errorCode: e.code,
    };
    throw error;
  }

  const verdict = inspectZomboidPath(normalized);
  if (verdict.ok) return normalized;

  // Structured rejection — caller surfaces these in the debug payload so the
  // frontend can render targeted remediation (parent suggestion, "this is the
  // server install", etc.) instead of just a generic "doesn't look like…".
  if (verdict.reason === "install-folder") {
    log.warn(
      `[ChunkCleaner] Rejected custom path (server install folder): ${normalized}`,
    );
    const error = new Error(
      "This folder looks like a Project Zomboid server install (it contains " +
        "ProjectZomboid64.exe / .json or similar). " +
        "Point at the user data folder instead — usually " +
        (process.platform === "win32"
          ? "C:\\Users\\<you>\\Zomboid"
          : "~/Zomboid") +
        " — not the server folder.",
    );
    error.statusCode = 400;
    error.details = {
      reason: "install-folder",
      tried: normalized,
      checks: verdict.checks,
    };
    throw error;
  }

  // No Zomboid markers anywhere. If they pointed at .../Saves or
  // .../Multiplayer (common copy-paste mistake), suggest the parent.
  log.warn(
    `[ChunkCleaner] Rejected custom path (no Zomboid markers found): ${normalized}`,
  );
  let msg =
    "Path does not appear to be a Zomboid data directory. " +
    "Point at your Zomboid data folder (the one containing Saves/), " +
    "a Saves/Multiplayer folder, or an individual save directory.";
  if (verdict.parentSuggestion) {
    msg += ` Did you mean ${verdict.parentSuggestion}?`;
  }
  const error = new Error(msg);
  error.statusCode = 403;
  error.details = {
    reason: "no-zomboid-markers",
    tried: normalized,
    checks: verdict.checks,
    parentSuggestion: verdict.parentSuggestion || null,
  };
  throw error;
}

// inspectZomboidPath()'s acceptance criteria (hasSavesDir, hasMultiplayerDir,
// isInsideSavesDir, hasZomboidMarker, hasSaveArtifacts -- any ONE is enough)
// was designed to guide an operator's folder PICKER: "does this look like
// the right kind of folder, or should we suggest the parent?" Two of those
// five signals -- isInsideSavesDir and hasZomboidMarker -- are pure
// substring matches against the PATH STRING ITSELF and require the caller
// to control no filesystem state at all, just an absolute path whose text
// happens to contain "saves" or "zomboid" somewhere. Used here to reject
// the most obviously-bogus customPath values fast, with a clear message,
// on the READ path (GET /chunks/:saveName) -- a wrong guess there just
// shows an empty save list either way, this only makes the failure faster
// and clearer. NOT the real gate for the destructive routes; see
// assertKnownSaveRoot below for those.
function assertRealSaveDataPath(zomboidDataPath) {
  const verdict = inspectZomboidPath(zomboidDataPath);
  const hasStructuralEvidence =
    verdict.checks.hasSavesDir ||
    verdict.checks.hasMultiplayerDir ||
    verdict.checks.hasSaveArtifacts;
  if (!hasStructuralEvidence) {
    const error = new Error(
      "This custom path doesn't contain an actual Saves/Multiplayer folder or " +
        "recognizable save data -- refusing to delete from it for safety. " +
        "Point at a real Zomboid data folder, not just a path with a suggestive name.",
    );
    error.statusCode = 400;
    error.details = { reason: "no-structural-save-evidence", checks: verdict.checks };
    throw error;
  }
}

// The REAL gate for delete-chunks/delete-region (bug-hunt-2026-08-27, item
// C). assertRealSaveDataPath above only asks "does this directory contain
// SOMETHING that looks like save data" -- and by the time delete-chunks/
// delete-region reach their own fs.existsSync(savePath) check, a matching
// Saves/Multiplayer/<saveName> subtree already has to exist for the delete
// to proceed at all, which independently forces hasSavesDir-shaped
// structural evidence to be present regardless. So a "does this look like
// real save content" check alone doesn't change what customPath values can
// actually reach a delete -- verified empirically (see
// chunksDeletionLogic.test.js): a fake directory with zero real structure
// gets refused before this function is even reached (404 Save not found,
// via the existsSync check), not bypassed. The genuine residual risk isn't
// "the panel can be fooled into thinking a bogus folder is real" -- it's
// "chunks.manage lets an operator direct the panel process to delete named
// files at ANY host location the process can reach, as long as SOMETHING
// matching a Saves/Multiplayer/<name> shape exists (or can be created)
// there" -- a location the panel process may have broader filesystem
// access to than the operator does through any other route. Closing that
// means constraining WHICH locations a destructive action can target, not
// making the "does it look right" heuristic stricter: customPath must
// resolve to somewhere the panel already recognizes -- a configured
// server's own zomboidDataPath (servers.manage-gated, so creating a new
// one requires a capability chunks.manage doesn't include) or one of the
// panel's own OS-standard auto-detected candidate locations
// (getCandidateZomboidPaths() -- computed from platform conventions, not
// request input). Deliberately NOT applied to the read routes (GET
// /saves, /chunks/:saveName, /stats/:saveName) -- ChunkCleaner.tsx's
// custom-path field is a real, intentional feature for BROWSING save data
// outside the active server's own configured location, and constraining
// reads the same way would remove that flexibility for no safety benefit
// a read doesn't need.
async function assertKnownSaveRoot(zomboidDataPath) {
  const resolved = path.resolve(zomboidDataPath);
  const configuredServers = await getServers();
  const matchesConfiguredServer = configuredServers.some(
    (s) => s.zomboidDataPath && path.resolve(s.zomboidDataPath) === resolved,
  );
  if (matchesConfiguredServer) return;

  const candidates = getCandidateZomboidPaths();
  const matchesCandidate = candidates.some((c) => path.resolve(c.path) === resolved);
  if (matchesCandidate) return;

  const legacyPath = await getSetting("zomboidDataPath");
  if (legacyPath && path.resolve(normalizeUserPath(legacyPath)) === resolved) return;

  const error = new Error(
    "This custom path isn't a location the panel already recognizes -- not a configured " +
      "server's data folder, and not one of the standard OS locations Zomboid saves usually " +
      "live in. Refusing to delete from it for safety.",
  );
  error.statusCode = 400;
  error.details = { reason: "not-a-known-save-root", tried: resolved };
  throw error;
}

// Operator ruling, hunt-wave12 2026-08-30: /saves, /suggested-paths,
// /chunks/:saveName, /stats/:saveName and /browse below used to sit only
// behind the global auth middleware, authed but not permissioned, while
// their mutating siblings (/delete-chunks, /delete-region, /save-path) all
// require chunks.manage. docker.js's own GET /stats already gates behind
// docker.manage -- chunks.js was the outlier, not the convention.
// chunks.manage is the ONLY chunks capability that exists (no read-level
// chunks.view); gating reads behind it therefore couples "can look at
// saves" to "can delete them," which is a real, deliberate tradeoff, not
// an oversight -- a future chunks.view split is a policy call for the
// operator, not something to invent here.
//
// Get list of available saves
router.get("/saves", requirePermission("chunks.manage"), async (req, res) => {
  try {
    // Support custom path override from query parameter
    const customPath = req.query.customPath
      ? String(req.query.customPath)
      : null;

    let zomboidDataPath;
    // Tracks whether we silently selected a candidate path when none was
    // configured — surfaced to the UI so the user can confirm/persist it.
    let autoPickedFrom = null;
    if (customPath) {
      // Validate custom path exists and is a directory
      const normalized = resolveCustomOrDefaultDataPath(customPath);
      zomboidDataPath = normalized;
      log.info(`[ChunkCleaner] Using custom path: ${normalized}`);
    } else {
      zomboidDataPath = await getZomboidDataPath();
    }

    if (!zomboidDataPath) {
      // No path configured — before bouncing to an error, try to auto-pick
      // a candidate that has saves on disk. This is the common case for a
      // fresh install where the panel was started before any server was
      // configured. Pick only if exactly one candidate has saves to avoid
      // silently choosing the wrong one when multiple installs exist.
      const candidates = getCandidateZomboidPaths();
      const withSaves = candidates.filter((c) => c.hasSaves);
      if (withSaves.length === 1) {
        zomboidDataPath = withSaves[0].path;
        autoPickedFrom = zomboidDataPath;
        log.info(
          `[ChunkCleaner] Auto-picked Zomboid data path: ${zomboidDataPath}`,
        );
      } else {
        return res.status(400).json({
          error:
            "Zomboid data path not set. " +
            "Configure a server in Settings → Servers, or use the Custom path field below to point at your Zomboid folder.",
          debug: {
            zomboidDataPath: null,
            savesPath: null,
            exists: false,
            usedCustomPath: false,
            hint:
              withSaves.length > 1
                ? `Found ${withSaves.length} candidate folders with saves — pick one below.`
                : "No Zomboid data folder is configured for this panel.",
            suggestedPaths: candidates,
          },
        });
      }
    }

    // Try the standard path first, then check if the path IS a Saves/Multiplayer dir directly
    let savesPath = resolveSavesPath(zomboidDataPath);
    const attempted = [savesPath];

    if (!fs.existsSync(savesPath)) {
      // Maybe the user pointed directly to Saves/Multiplayer
      const basename = path.basename(zomboidDataPath);
      const parentDir = path.dirname(zomboidDataPath);
      const parentBase = path.basename(parentDir);
      const grandparentBase = path.basename(path.dirname(parentDir));
      if (basename === "Multiplayer" && parentBase === "Saves") {
        savesPath = zomboidDataPath;
        log.info(`[ChunkCleaner] Path points directly to Saves/Multiplayer`);
      } else if (basename === "Saves") {
        savesPath = path.join(zomboidDataPath, "Multiplayer");
        attempted.push(savesPath);
        log.info(`[ChunkCleaner] Path points directly to Saves dir`);
      } else if (parentBase === "Multiplayer" && grandparentBase === "Saves") {
        // Individual save directory — walk up to list siblings
        savesPath = parentDir;
        attempted.push(savesPath);
        log.info(
          `[ChunkCleaner] Path points to an individual save; using parent Saves/Multiplayer`,
        );
      } else {
        log.warn(`[ChunkCleaner] Saves path not found: ${savesPath}`);
        log.info(`[ChunkCleaner] zomboidDataPath: ${zomboidDataPath}`);
        return res.json({
          saves: [],
          debug: {
            zomboidDataPath,
            savesPath,
            exists: false,
            usedCustomPath: Boolean(customPath),
            attempted,
            hint:
              `Looked for ${path.join("Saves", "Multiplayer")} inside the data folder but didn't find it. ` +
              `Has this server ever been started, or is the data path pointing at the wrong place?`,
            suggestedPaths: customPath ? [] : getCandidateZomboidPaths(),
          },
        });
      }
    }

    if (!fs.existsSync(savesPath)) {
      log.warn(
        `[ChunkCleaner] Resolved saves path does not exist: ${savesPath}`,
      );
      return res.json({
        saves: [],
        debug: {
          zomboidDataPath,
          savesPath,
          exists: false,
          usedCustomPath: Boolean(customPath),
          attempted,
          hint: `The resolved saves folder doesn't exist on disk. Start the server once to create it, or pick a different data path.`,
          suggestedPaths: customPath ? [] : getCandidateZomboidPaths(),
        },
      });
    }

    log.info(`[ChunkCleaner] Listing saves from: ${savesPath}`);

    let entries;
    try {
      entries = await fs.promises.readdir(savesPath, { withFileTypes: true });
    } catch (e) {
      log.warn(
        `[ChunkCleaner] Failed to read saves dir ${savesPath}: ${e.message}`,
      );
      const code = e.code || "EREAD";
      const permissionDenied = code === "EACCES" || code === "EPERM";
      const variant = process.platform === "win32"
        ? "windows"
        : process.platform === "linux"
          ? "linux"
          : "generic";
      const hint = !permissionDenied
        ? `Could not read the saves folder (${code}).`
        : variant === "linux"
          ? "Panel cannot read this folder. Check ownership and read permissions for the panel service user."
          : variant === "windows"
            ? "Panel cannot read this folder. Check that the panel service account has read access to it."
            : "Panel cannot read this folder. Check the folder permissions for the account running the panel.";
      return res.status(403).json({
        error: hint,
        variant,
        debug: {
          zomboidDataPath,
          savesPath,
          exists: true,
          usedCustomPath: Boolean(customPath),
          attempted,
          hint,
          errorCode: code,
        },
      });
    }
    // Exclude our own `backups` folder. Chunk/region deletions write backups
    // to `<zomboidDataPath>/backups`. When the user points the data path
    // directly at `Saves/Multiplayer` (a supported config), that backups
    // folder lands inside the saves listing and would otherwise show up as a
    // fake, un-loadable "save". It is never a real PZ multiplayer save.
    const directories = entries.filter(
      (d) => d.isDirectory() && d.name.toLowerCase() !== "backups",
    );

    log.info(
      `[ChunkCleaner] Found ${directories.length} save directories: ${directories.map((d) => d.name).join(", ")}`,
    );

    const saves = await Promise.all(
      directories.map(async (d) => {
        const savePath = path.join(savesPath, d.name);
        const stats = await fs.promises.stat(savePath);

        // /chunks/:saveName and /stats/:saveName already share map/'s scan
        // via getMapFolderScan() (see its comment) -- this route was the
        // one caller still walking it independently, via countFiles(), on
        // EVERY page load (fetchSaves() runs on ChunkCleaner mount, before
        // the user has even picked a save). Measured live: 8.06s for a
        // 147,136-chunk save, on top of the already-fixed /chunks+/stats
        // pair -- the operator's real page-load total was still ~13.7s
        // after 6ad0ce0, not the 5.6s that fix alone reported.
        const mapPath = path.join(savePath, "map");
        const mapScan = await getMapFolderScan(mapPath);

        // Count chunk files (uses recursive count for B42's subdirectory structure)
        // Also check save root for B41 flat chunk files
        let chunkCount = mapScan.isB42Structure
          ? mapScan.totalBinFiles + mapScan.totalNonBinFiles
          : 0;
        if (chunkCount === 0) {
          // B41 fallback: count map_X_Y.bin files in save root
          const B41_CHUNK_REGEX = /^map_\d+_\d+\.bin$/i;
          try {
            const rootEntries = await fs.promises.readdir(savePath);
            chunkCount = rootEntries.filter((f) =>
              B41_CHUNK_REGEX.test(f),
            ).length;
          } catch (e) {
            log.debug(
              `B41 chunk count fallback failed for ${savePath}: ${e.message}`,
            );
          }
        }

        // Get save size -- reuse the map/ scan above for the "map" entry
        // instead of letting getDirSize() re-walk the same 100k+ files a
        // third time; every other top-level entry (chunkdata/, players.db,
        // etc.) still goes through getDirSize()/stat() same as before.
        let size = 0;
        try {
          const topEntries = await fs.promises.readdir(savePath, {
            withFileTypes: true,
          });
          const topSizes = await Promise.all(
            topEntries.map(async (entry) => {
              if (entry.name === "map" && mapScan.isB42Structure) {
                const chunkSize = mapScan.rawChunks.reduce(
                  (sum, c) => sum + c.size,
                  0,
                );
                return chunkSize + mapScan.totalNonBinSize;
              }
              const fullPath = path.join(savePath, entry.name);
              if (entry.isDirectory()) return getDirSize(fullPath);
              try {
                return (await fs.promises.stat(fullPath)).size;
              } catch (e) {
                return 0;
              }
            }),
          );
          size = topSizes.reduce((a, b) => a + b, 0);
        } catch (e) {
          log.debug(`Save size scan failed for ${savePath}: ${e.message}`);
        }

        return {
          name: d.name,
          modified: stats.mtime,
          chunkCount,
          size,
          sizeFormatted: formatBytes(size),
        };
      }),
    );

    res.json({
      saves,
      debug: {
        zomboidDataPath,
        savesPath,
        exists: true,
        usedCustomPath: Boolean(customPath),
        autoPicked: autoPickedFrom,
        hint:
          saves.length === 0
            ? `Saves folder exists but contains no save directories. Start the server once, or pick a different folder.`
            : null,
        suggestedPaths:
          saves.length === 0 && !customPath ? getCandidateZomboidPaths() : [],
      },
    });
  } catch (error) {
    // User-input rejections (400/403 with structured details) are not panel
    // bugs — log them at WARN so alerting/email pipelines don't fire on every
    // typo in the path field. Real failures (no statusCode = 500) stay ERROR.
    const isUserError = error.statusCode && error.statusCode < 500;
    if (isUserError) {
      log.warn(`Get saves rejected (${error.statusCode}): ${error.message}`);
    } else {
      log.error(`Failed to get saves: ${error.message}`);
    }
    // Forward structured rejection details (reason, checks, parentSuggestion)
    // so the frontend empty-state panel can render targeted remediation.
    const payload = { error: sanitizeError(error.message) };
    if (error.details) {
      payload.debug = {
        zomboidDataPath: null,
        savesPath: null,
        exists: false,
        usedCustomPath: true,
        hint: error.message,
        rejection: error.details,
        suggestedPaths: getCandidateZomboidPaths(),
      };
    }
    res.status(error.statusCode || 500).json(payload);
  }
});

// List common Zomboid path candidates so the UI can present clickable
// suggestions when the panel can't find a data folder on its own.
router.get("/suggested-paths", requirePermission("chunks.manage"), async (req, res) => {
  try {
    // Allow the UI to bust the 30s cache after the user creates/moves a
    // folder (?refresh=1) so suggestions update without a panel restart.
    if (req?.query?.refresh) invalidateCandidatePathsCache();
    res.json({
      candidates: getCandidateZomboidPaths(),
      platform: process.platform,
    });
  } catch (error) {
    log.error(`Failed to enumerate suggested paths: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Persist a custom path as the panel's configured Zomboid data folder.
// Writes to the active server's `zomboidDataPath` when one exists, otherwise
// to the legacy flat setting. The path is validated with the same rules as
// the /saves customPath query parameter so users can't smuggle in arbitrary
// directories via this endpoint.
router.post("/save-path", requirePermission("chunks.manage"), async (req, res) => {
  try {
    const { path: rawPath } = req.body || {};
    if (!rawPath || typeof rawPath !== "string") {
      return res.status(400).json({
        error: "Missing path.",
        code: ErrorCode.CHUNKS_SAVE_PATH_MISSING,
      });
    }
    let validated;
    try {
      validated = resolveCustomOrDefaultDataPath(rawPath);
    } catch (e) {
      // Surface validation details so the UI can render the same empty-state
      // remediation it gets from /saves.
      const payload = { error: sanitizeError(e.message) };
      if (e.details) payload.rejection = e.details;
      return res.status(e.statusCode || 400).json(payload);
    }
    if (!validated) {
      return res.status(400).json({
        error: "Path is empty after normalization.",
        code: ErrorCode.CHUNKS_SAVE_PATH_EMPTY,
      });
    }

    const activeServer = await getActiveServer();

    // This route repoints the ACTIVE SERVER's entire zomboidDataPath -- the
    // same field serverManager.js/mods.js/server.js resolve Server/<name>.ini
    // (RCON password included) and every server-scoped file from, not a
    // chunk-specific setting (chunks are just files under this path; there
    // is no separate concept to write instead). chunks.manage alone used to
    // reach it, meaning a chunks.manage holder could point a live server at
    // a different real Zomboid folder and have it silently start reading a
    // different RCON password/sandbox config on next restart --
    // config-hijack via the chunk-cleanup screen. server.configure is
    // required in addition, matching the capability that already governs
    // "the server's ... network/path configuration" everywhere else.
    // Enforced on CHANGE, not presence: re-submitting the path already in
    // effect must not require anything beyond chunks.manage.
    const currentPath = activeServer?.zomboidDataPath || (await getSetting("zomboidDataPath")) || null;
    if (currentPath !== validated) {
      const role = req.user ? await getRoleByName(req.user.role) : null;
      const capabilities = Array.isArray(role?.capabilities) ? role.capabilities : [];
      if (!capabilities.includes("server.configure")) {
        return res.status(403).json({
          error: "Repointing the server's data path also requires server.configure.",
          code: ErrorCode.CHUNKS_SAVE_PATH_CAPABILITY_REQUIRED,
        });
      }
    }

    if (activeServer?.id) {
      // updateServer() returns null instead of writing anything if this
      // server id no longer exists by the time this call runs (deleted
      // concurrently between the getActiveServer() call above and here) --
      // without checking that, this route reported the path as saved to a
      // server profile that was no longer there to save it to.
      const updated = await updateServer(activeServer.id, { zomboidDataPath: validated });
      if (!updated) {
        return res.status(404).json({ error: "Active server no longer exists." });
      }
      log.info(
        `[ChunkCleaner] Saved zomboidDataPath to active server "${activeServer.name}": ${validated}`,
      );
      return res.json({
        ok: true,
        target: "server",
        serverId: activeServer.id,
        path: validated,
      });
    }
    await setSetting("zomboidDataPath", validated);
    log.info(
      `[ChunkCleaner] Saved zomboidDataPath to legacy settings: ${validated}`,
    );
    res.json({ ok: true, target: "setting", path: validated });
  } catch (error) {
    log.error(`Failed to save zomboid data path: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get chunk data for a specific save
router.get("/chunks/:saveName", requirePermission("chunks.manage"), async (req, res) => {
  try {
    const { saveName } = req.params;
    const customPath = req.query.customPath
      ? String(req.query.customPath)
      : null;

    // Optional progress streaming: the client passes a scanId and subscribes to
    // `chunkScan:progress` over Socket.IO. Scanning a huge save over a slow UNC
    // share can take a while, so we report % completion (by directory) instead
    // of capping the result. No scanId → no emits (back-compat).
    const scanId = req.query.scanId ? String(req.query.scanId) : null;
    const io = req.app.get("io");
    let lastProgressAt = 0;
    const emitProgress = (scanned, total, found, { force = false } = {}) => {
      if (!io || !scanId) return;
      const now = Date.now();
      // Throttle to ~5/sec to avoid flooding the socket on fast local disks.
      if (!force && now - lastProgressAt < 200) return;
      lastProgressAt = now;
      io.emit("chunkScan:progress", { scanId, scanned, total, chunks: found });
    };

    // Sanitize saveName to prevent path traversal. path.basename() alone
    // catches every payload that contains a separator ("../x", "a/../b") --
    // the sanitized value stops matching the original and the request is
    // rejected below. It does NOT catch the two special dot-segments on
    // their own: path.basename("..") === ".." and path.basename(".") === "."
    // (both are already "just a basename" by Node's own definition), so
    // without the explicit check here a saveName of ".." or "." sails
    // through unchanged and resolves savePath to the PARENT of the saves
    // directory (or the saves directory itself) instead of a real save --
    // proven end-to-end (a decoy file placed outside any save gets deleted,
    // and /stats leaks aggregate sibling-save size) in
    // linuxChunksSaveNameTraversal.test.js.
    const sanitizedSaveName = path.basename(saveName);
    if (
      !sanitizedSaveName ||
      sanitizedSaveName !== saveName ||
      sanitizedSaveName === "." ||
      sanitizedSaveName === ".."
    ) {
      return res.status(400).json({
        error: "Invalid save name",
        code: ErrorCode.CHUNKS_INVALID_SAVE_NAME,
      });
    }

    let zomboidDataPath;
    if (customPath) {
      zomboidDataPath = resolveCustomOrDefaultDataPath(String(customPath));
      assertRealSaveDataPath(zomboidDataPath);
    } else {
      zomboidDataPath = await getZomboidDataPath();
    }

    if (!zomboidDataPath) {
      return res.status(400).json({
        error: "Zomboid data path not set",
        code: ErrorCode.CHUNKS_DATA_PATH_NOT_SET,
      });
    }

    // Resolve the saves path the same way as /saves
    let savesPath = resolveSavesPath(zomboidDataPath);

    const savePath = path.join(savesPath, sanitizedSaveName);
    const mapPath = path.join(savePath, "map");

    log.info(
      `[ChunkCleaner] Loading chunks for "${sanitizedSaveName}" from: ${mapPath}`,
    );

    if (!fs.existsSync(savePath)) {
      log.warn(`[ChunkCleaner] Save directory not found: ${savePath}`);
      return res.json({ chunks: [], bounds: null });
    }

    const chunks = [];
    const seenChunkCoords = new Set();
    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;
    let totalChunks = 0;

    // B42 uses subdirectory structure: map/{X}/{Y}.bin
    // B41 may use flat files inside map/ OR flat files in the save root
    //
    // The (potentially 100k+ file) B42 scan goes through getMapFolderScan(),
    // which /stats/:saveName also calls for the SAME save -- the client
    // fires both routes concurrently on every page load (see
    // ChunkCleaner.tsx's Promise.allSettled). Sharing the walk while both
    // are in flight means the tree gets walked once, not twice -- measured
    // on a 147,136-file synthetic fixture matching a real operator save:
    // /chunks alone 6.2s, /stats alone 9.3s, both concurrently 15.3s before
    // this; roughly one walk's cost after. See getMapFolderScan()'s own
    // comment for why this is in-flight-only, not a TTL cache.
    const mapScan = await getMapFolderScan(mapPath, emitProgress);
    const mapExists = mapScan.mapExists;
    const mapContents = mapScan.mapContents || [];
    const flatBinFiles = mapContents.filter(
      (f) => f.isFile() && f.name.endsWith(".bin"),
    );

    log.info(
      `[ChunkCleaner] map/ ${mapExists ? "exists" : "missing"}: ${mapContents.length} entries, ${mapScan.isB42Structure ? "B42 structure" : "no B42 dirs"}, ${flatBinFiles.length} flat .bin files (B41)`,
    );

    const rememberChunkCoord = (x, y) => {
      const key = `${x},${y}`;
      if (seenChunkCoords.has(key)) return false;
      seenChunkCoords.add(key);
      totalChunks++;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      return true;
    };

    if (mapScan.isB42Structure) {
      // Coordinates can't actually collide within map/{X}/{Y}.bin (X is the
      // directory, Y the filename) -- still run every record through
      // rememberChunkCoord for bounds/totalChunks bookkeeping, exactly as
      // before this was extracted into getMapFolderScan().
      for (const c of mapScan.rawChunks) {
        if (!rememberChunkCoord(c.x, c.y)) continue;
        chunks.push(c);
      }
    } else {
      // Legacy flat file structure: map_X_Y.bin or X_Y.bin
      const files = mapContents
        .filter((f) => f.isFile() && f.name.endsWith(".bin"))
        .map((f) => f.name);

      const chunkEntries = [];
      for (const file of files) {
        // Common formats: map_X_Y.bin, chunkdata_X_Y.bin, X_Y.bin
        const match = file.match(
          /^(?:map_|chunkdata_|chunk_)?(\d+)_(\d+)(?:_\d+)?\.bin$/i,
        );
        if (match) {
          const x = parseInt(match[1], 10);
          const y = parseInt(match[2], 10);
          if (!rememberChunkCoord(x, y)) continue;

          chunkEntries.push({ file, x, y });
        }
      }

      const legacyResults = await Promise.all(
        chunkEntries.map(async ({ file, x, y }) => {
          try {
            const stats = await fs.promises.stat(path.join(mapPath, file));
            return {
              file,
              x,
              y,
              size: stats.size,
              modified: stats.mtime,
            };
          } catch (e) {
            log.debug(`Stat failed for legacy chunk ${file}: ${e.message}`);
            return null;
          }
        }),
      );

      for (const res of legacyResults) {
        if (res) {
          chunks.push(res);
        }
      }
    }

    // B41 fallback: if map/ didn't yield any chunks, check save root for
    // flat chunk files like map_X_Y.bin (common B41 save layout).
    let isB42 = mapScan.isB42Structure;

    // Secondary B42 detection: if map/ is empty (no subdirs, no flat files),
    // check for B42-specific files in the save root. B42 saves have files like
    // WorldDictionary.bin, global_mod_data.bin, entity_data.bin that B41 doesn't.
    if (!isB42 && chunks.length === 0) {
      const b42Indicators = [
        "WorldDictionary.bin",
        "global_mod_data.bin",
        "entity_data.bin",
      ];
      const hasB42Files = b42Indicators.some((f) =>
        fs.existsSync(path.join(savePath, f)),
      );
      if (hasB42Files) {
        isB42 = true;
        log.info(
          `[ChunkCleaner] Detected B42 save via indicator files (map/ is empty)`,
        );
      }
    }

    if (!isB42 && totalChunks === 0) {
      const B41_CHUNK_REGEX = /^map_(\d+)_(\d+)\.bin$/i;
      const rootEntries = await fs.promises.readdir(savePath, {
        withFileTypes: true,
      });
      const rootBinFiles = rootEntries.filter(
        (f) => f.isFile() && B41_CHUNK_REGEX.test(f.name),
      );

      if (rootBinFiles.length > 0) {
        log.info(
          `[ChunkCleaner] Found ${rootBinFiles.length} B41 chunk files in save root`,
        );

        const chunkEntries = [];
        for (const entry of rootBinFiles) {
          const match = entry.name.match(B41_CHUNK_REGEX);
          if (!match) continue;

          const x = parseInt(match[1], 10);
          const y = parseInt(match[2], 10);
          if (!rememberChunkCoord(x, y)) continue;

          chunkEntries.push({ entry, x, y });
        }

        const rootResults = await Promise.all(
          chunkEntries.map(async ({ entry, x, y }) => {
            try {
              const stats = await fs.promises.stat(
                path.join(savePath, entry.name),
              );
              return {
                file: entry.name,
                x,
                y,
                size: stats.size,
                modified: stats.mtime,
                source: "saveroot",
              };
            } catch (e) {
              log.debug(
                `Stat failed for B41 root chunk ${entry.name}: ${e.message}`,
              );
              return null;
            }
          }),
        );

        for (const res of rootResults) {
          if (res) {
            chunks.push(res);
          }
        }
      }
    }

    // Also check chunkdata folder for additional chunk data.
    // In B41 saves, chunkdata coords match chunk coords directly.
    // In B42 saves, chunkdata uses CELL coordinates and is converted here to
    // native B42 chunk coordinates (× 32). Original cell coords are preserved
    // in cellX/cellY for deletion operations.
    //
    // NOTE: chunkdata entries are kept in a SEPARATE dedup namespace from map
    // chunks. A chunkdata entry represents an entire cell's state (256×256
    // tiles on B42), not just the corner chunk. Previously these got dropped
    // when `map/0/0.bin` already claimed coord (0,0) — which meant the user
    // could not select the cell-wide chunkdata entry, and its cell-span
    // vehicle/state cleanup never ran.
    const seenChunkDataCoords = new Set();
    {
      const chunkDataPath = path.join(savePath, "chunkdata");
      if (fs.existsSync(chunkDataPath)) {
        const chunkDataFiles = await fs.promises.readdir(chunkDataPath);
        const validFiles = chunkDataFiles.filter((f) => f.endsWith(".bin"));

        const chunkEntries = [];
        for (const file of validFiles) {
          const match = file.match(/^(\d+)_(\d+)(?:_\d+)?\.bin$/i);
          if (match) {
            const rawX = parseInt(match[1], 10);
            const rawY = parseInt(match[2], 10);

            const displayX = isB42 ? rawX * 32 : rawX * 30;
            const displayY = isB42 ? rawY * 32 : rawY * 30;

            // Dedup against ONLY other chunkdata entries, not against map
            // chunks — the two sources cover different amounts of world state.
            const cdKey = `${displayX},${displayY}`;
            if (seenChunkDataCoords.has(cdKey)) continue;
            seenChunkDataCoords.add(cdKey);
            // Track for bounds even though rememberChunkCoord was skipped.
            minX = Math.min(minX, displayX);
            maxX = Math.max(maxX, displayX);
            minY = Math.min(minY, displayY);
            maxY = Math.max(maxY, displayY);
            totalChunks++;

            chunkEntries.push({ file, rawX, rawY, displayX, displayY });
          }
        }

        const chunkDataResults = await Promise.all(
          chunkEntries.map(async ({ file, rawX, rawY, displayX, displayY }) => {
            try {
              const stats = await fs.promises.stat(
                path.join(chunkDataPath, file),
              );
              return {
                file,
                x: displayX,
                y: displayY,
                size: stats.size,
                modified: stats.mtime,
                source: "chunkdata",
                cellX: rawX,
                cellY: rawY,
              };
            } catch (e) {
              log.debug(`Stat failed for chunkdata ${file}: ${e.message}`);
              return null;
            }
          }),
        );

        for (const res of chunkDataResults) {
          if (res) {
            chunks.push(res);
          }
        }
      }
    }

    const bounds = chunks.length > 0 ? { minX, maxX, minY, maxY } : null;

    // Sort chunks by coordinate for consistent rendering order
    chunks.sort((a, b) => a.x - b.x || a.y - b.y);

    res.json({
      saveName,
      chunks,
      shownChunks: chunks.length,
      totalChunks,
      bounds,
      limitReached: false,
      maxChunks: null,
      isB42,
    });
  } catch (error) {
    // resolveCustomOrDefaultDataPath throws 400/403 for bad custom paths —
    // forward that status (and structured rejection details) instead of
    // masking it as a generic 500 so the UI can render targeted remediation.
    const isUserError = error.statusCode && error.statusCode < 500;
    if (isUserError)
      log.warn(`Get chunks rejected (${error.statusCode}): ${error.message}`);
    else log.error(`Failed to get chunks: ${error.message}`);
    const payload = { error: sanitizeError(error.message) };
    if (error.details) payload.rejection = error.details;
    res.status(error.statusCode || 500).json(payload);
  }
});

// Delete selected chunks
router.post("/delete-chunks", requirePermission("chunks.manage"), async (req, res) => {
  try {
    const {
      saveName,
      chunks,
      createBackup = true,
      customPath = null,
      deleteVehicles = false,
      force = false,
    } = req.body;
    log.info(
      `POST /delete-chunks: saveName=${saveName}, chunkCount=${chunks?.length || 0}, createBackup=${createBackup}, deleteVehicles=${!!deleteVehicles}, force=${!!force}`,
    );

    // Refuse to mutate save files while the server is running — it will write
    // them back on shutdown and corrupt the save, or hold vehicles.db open
    // on Windows and cause the DB write to fail mid-flight.
    //
    // Issue #5: detection can false-positive when the user runs the server
    // via a custom systemd unit / launcher we don't recognise, or when an
    // unrelated java process matches our heuristics. We surface the matched
    // process info and accept `force: true` so users can override after
    // confirming the server really is stopped.
    if (!force) {
      const serverManager = req.app.get("serverManager");
      // Fail CLOSED, not open: a scan that couldn't determine the server's
      // state (scanFailed), threw outright, or has no richer check to even
      // run must refuse the same way a confirmed-running server does, never
      // be read as "confirmed stopped". No fallback to checkServerRunning()
      // -- that collapses a failed scan into a plain `false`, indistinguishable
      // from a confirmed-stopped server, which is the exact bug fixed
      // elsewhere (/wipe, /delete-files) via this same scanFailed flag; a
      // fallback to it here would silently reopen it the moment a lighter
      // serverManager without getServerProcessDetails is ever wired up.
      // Same shape as index.js's Docker-update gate (handlePanelUpdateDownload):
      // treat "the richer check isn't available" as equivalent to scanFailed.
      let details = null;
      if (serverManager) {
        try {
          details =
            typeof serverManager.getServerProcessDetails === "function"
              ? await serverManager.getServerProcessDetails()
              : null;
        } catch (e) {
          log.warn(
            `Server-running check failed, refusing to proceed: ${e.message}`,
          );
          details = null;
        }
      }
      if (!details || details.scanFailed) {
        return res.status(503).json({
          error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
          code: ErrorCode.SERVER_STATE_UNKNOWN,
        });
      }
      if (details.running) {
        return res.status(400).json({
          error:
            "Stop the server before deleting chunks. Running servers hold save files open and will overwrite your changes on shutdown.",
          code: "server_running",
          matched: details.matched,
        });
      }
    } else {
      log.warn("delete-chunks: server-running check bypassed via force=true");
    }

    if (!saveName || !chunks || !Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({
        error: "Save name and chunks array required",
        code: ErrorCode.DELETE_CHUNKS_FIELDS_REQUIRED,
      });
    }

    // Cap chunk count explicitly. Express body-parser already rejects >1MB
    // payloads with a cryptic PayloadTooLargeError; this check fires earlier
    // and gives a clear message. 100k matches the region endpoint's cap.
    if (chunks.length > 100000) {
      return res.status(400).json({
        error: `Too many chunks (${chunks.length.toLocaleString()}). Maximum is 100,000 per request — split into smaller batches.`,
        code: ErrorCode.DELETE_CHUNKS_TOO_MANY,
        params: sanitizeErrorParams({ count: chunks.length }),
      });
    }

    // Sanitize saveName to prevent path traversal. path.basename() alone
    // catches every payload that contains a separator ("../x", "a/../b") --
    // the sanitized value stops matching the original and the request is
    // rejected below. It does NOT catch the two special dot-segments on
    // their own: path.basename("..") === ".." and path.basename(".") === "."
    // (both are already "just a basename" by Node's own definition), so
    // without the explicit check here a saveName of ".." or "." sails
    // through unchanged and resolves savePath to the PARENT of the saves
    // directory (or the saves directory itself) instead of a real save --
    // proven end-to-end (a decoy file placed outside any save gets deleted,
    // and /stats leaks aggregate sibling-save size) in
    // linuxChunksSaveNameTraversal.test.js.
    const sanitizedSaveName = path.basename(saveName);
    if (
      !sanitizedSaveName ||
      sanitizedSaveName !== saveName ||
      sanitizedSaveName === "." ||
      sanitizedSaveName === ".."
    ) {
      return res.status(400).json({
        error: "Invalid save name",
        code: ErrorCode.CHUNKS_INVALID_SAVE_NAME,
      });
    }

    // Validate chunk files and coordinates
    for (const chunk of chunks) {
      if (!chunk.file) {
        return res.status(400).json({
          error: "Invalid chunk file name",
          code: ErrorCode.DELETE_CHUNKS_INVALID_FILE_NAME,
        });
      }
      const normalized = path.normalize(chunk.file);
      if (normalized.includes("..") || path.isAbsolute(normalized)) {
        return res.status(400).json({
          error: "Invalid chunk file path",
          code: ErrorCode.DELETE_CHUNKS_INVALID_FILE_PATH,
        });
      }
      if (chunk.x !== undefined && chunk.x !== null) {
        const nx = Number(chunk.x);
        if (!Number.isFinite(nx) || !Number.isInteger(nx)) {
          return res.status(400).json({
            error: "Invalid chunk x coordinate — must be an integer",
            code: ErrorCode.DELETE_CHUNKS_INVALID_X,
          });
        }
        chunk.x = nx;
      }
      if (chunk.y !== undefined && chunk.y !== null) {
        const ny = Number(chunk.y);
        if (!Number.isFinite(ny) || !Number.isInteger(ny)) {
          return res.status(400).json({
            error: "Invalid chunk y coordinate — must be an integer",
            code: ErrorCode.DELETE_CHUNKS_INVALID_Y,
          });
        }
        chunk.y = ny;
      }
    }

    const zomboidDataPath = customPath
      ? resolveCustomOrDefaultDataPath(String(customPath))
      : await getZomboidDataPath();
    if (!zomboidDataPath) {
      return res.status(400).json({
        error: "Zomboid data path not set",
        code: ErrorCode.CHUNKS_DATA_PATH_NOT_SET,
      });
    }
    if (customPath) await assertKnownSaveRoot(zomboidDataPath);

    const savesPath = resolveSavesPath(zomboidDataPath);
    const savePath = path.join(savesPath, sanitizedSaveName);

    if (!fs.existsSync(savePath)) {
      return res.status(404).json({
        error: "Save not found",
        code: ErrorCode.CHUNKS_SAVE_NOT_FOUND,
      });
    }

    // B42 vs B41 detection — filesystem-based, not filename-based.
    // Filename inference (chunks.some(c => c.file.includes('/'))) silently
    // mis-detects selections made of only `chunkdata_X_Y.bin` entries on B42
    // saves. That would compute the wrong cell size and the wrong vehicle
    // bbox (30×10 B41 tiles vs 32×8 B42 tiles).
    const isB42 = detectSaveIsB42Sync(savePath);
    const cellDivisor = cellDivisorFor(isB42);
    const tilesPerChunk = tilesPerChunkFor(isB42);

    // Backfill cell coordinates for chunkdata-origin and map-origin chunks.
    // Use == null (not === undefined) so a null from the client JSON payload
    // is also treated as "needs backfill" — otherwise touchedCells ends up
    // with "null,null" keys and per-cell aux cleanup silently skips.
    for (const chunk of chunks) {
      if (chunk.source === "chunkdata" && chunk.cellX == null) {
        const cdMatch = chunk.file.match(/(\d+)_(\d+)/);
        if (cdMatch) {
          chunk.cellX = parseInt(cdMatch[1], 10);
          chunk.cellY = parseInt(cdMatch[2], 10);
        }
      }
      if (chunk.cellX == null) chunk.cellX = Math.floor(chunk.x / cellDivisor);
      if (chunk.cellY == null) chunk.cellY = Math.floor(chunk.y / cellDivisor);
    }

    // Create backup if requested. We back up map files AND vehicles.db (if
    // vehicles are being deleted) so the operation is fully reversible.
    let backupPath = null;
    if (createBackup) {
      backupPath = path.join(
        zomboidDataPath,
        "backups",
        `${sanitizedSaveName}_chunks_${Date.now()}`,
      );
      await fs.promises.mkdir(backupPath, { recursive: true });

      await Promise.all(
        chunks.map(async (chunk) => {
          try {
            // Use source as a prefix so a B42 map chunk (`0/0.bin`) and a B41
            // save-root chunk (`0_0.bin`) can coexist in the same backup without
            // colliding to `map_0_0.bin` + EEXIST (which COPYFILE_EXCL would
            // otherwise silently drop as a warn).
            const srcTag =
              chunk.source === "saveroot"
                ? "saveroot"
                : chunk.source === "chunkdata"
                  ? "chunkdata"
                  : "map";
            const mapFile =
              chunk.source === "saveroot"
                ? path.join(savePath, chunk.file)
                : path.join(savePath, "map", chunk.file);
            try {
              const backupName = `${srcTag}_${chunk.file.replace(/[/\\]/g, "_")}`;
              await copyChunkBackup(
                mapFile,
                path.join(backupPath, backupName),
                true,
              );
            } catch (e) {
              if (e.code !== "ENOENT") throw e;
            }
            if (chunk.source === "chunkdata") {
              const chunkDataFile = path.join(
                savePath,
                "chunkdata",
                chunk.file,
              );
              try {
                const backupName = `chunkdata_${chunk.file.replace(/[/\\]/g, "_")}`;
                await copyChunkBackup(
                  chunkDataFile,
                  path.join(backupPath, backupName),
                  true,
                );
              } catch (e) {
                if (e.code !== "ENOENT") throw e;
              }
            }
          } catch (e) {
            log.error(`Failed to backup chunk ${chunk.file}: ${e.message}`);
            throw e;
          }
        }),
      );

      log.info(`Created chunk backup at ${backupPath}`);
    }

    // ─── Pass 1: delete the chunk files themselves ──────────────────────
    let deleted = 0;
    const errors = [];
    const touchedCells = new Set();

    const deleteResults = await Promise.all(
      chunks.map(async (chunk) => {
        try {
          let wasDeleted = false;

          if (chunk.source === "chunkdata") {
            // Pure chunkdata entry (no map file) — delete the chunkdata file directly.
            // Use the ACTUAL filename captured by the scanner (it may be
            // `chunkdata_X_Y.bin` OR a bare `X_Y.bin` depending on save layout).
            const chunkDataFile = path.join(savePath, "chunkdata", chunk.file);
            try {
              await fs.promises.unlink(chunkDataFile);
              wasDeleted = true;
            } catch (e) {
              if (e.code !== "ENOENT")
                return {
                  success: false,
                  error: `chunkdata: ${e.message}`,
                  file: chunk.file,
                };
            }
          } else {
            const mapFile =
              chunk.source === "saveroot"
                ? path.join(savePath, chunk.file)
                : path.join(savePath, "map", chunk.file);
            try {
              await fs.promises.unlink(mapFile);
              wasDeleted = true;
            } catch (e) {
              if (e.code !== "ENOENT")
                return {
                  success: false,
                  error: sanitizeError(e.message),
                  file: chunk.file,
                };
            }
          }

          if (wasDeleted) {
            touchedCells.add(`${chunk.cellX},${chunk.cellY}`);
          }
          return { success: true, wasDeleted };
        } catch (err) {
          return {
            success: false,
            error: sanitizeError(err.message),
            file: chunk.file,
          };
        }
      }),
    );

    for (const r of deleteResults) {
      if (r.success) {
        if (r.wasDeleted) deleted++;
      } else errors.push(`${r.file}: ${r.error}`);
    }

    // ─── Pass 2: remove per-cell aux files only for cells that are now empty ───
    // (Fixes the overreach bug that made one chunk deletion wipe cell state
    // for 1023 innocent neighbours.)
    const cellCleanup = await cleanupEmptyCellFiles(
      savePath,
      touchedCells,
      isB42,
      backupPath,
    );

    // Clean up empty X directories (B42)
    const deletedXDirs = new Set();
    for (const chunk of chunks) {
      const parts = chunk.file.split("/");
      if (parts.length === 2) deletedXDirs.add(parts[0]);
    }
    for (const xDir of deletedXDirs) {
      try {
        const xPath = path.join(savePath, "map", xDir);
        const remaining = await fs.promises.readdir(xPath);
        if (remaining.length === 0) await fs.promises.rmdir(xPath);
      } catch (e) {
        /* ignore */
      }
    }

    // ─── Pass 3: delete matching rows from vehicles.db ─────────────────
    // This is the critical fix for "cars come back when I return to the cell".
    // Runtime PanelBridge only touches loaded vehicles; the DB retains every
    // other one. We delete every vehicle whose world tile coords fall inside
    // one of the just-deleted chunks.
    let vehiclesResult = { deleted: 0, skipped: true };
    if (deleteVehicles && deleted > 0) {
      const dbBackup = backupPath
        ? path.join(backupPath, "vehicles.db.bak")
        : null;
      // Build tile bboxes. chunkdata-source entries cover a whole cell
      // (not just one chunk) — expand them so we don't miss vehicles in the
      // other 1023 chunks of that cell.
      // Also supply wx/wy (chunk-coord) bounds so vehicles with drifted tile
      // coords but valid chunk coords still get matched.
      const cellTileSpan = cellDivisor * tilesPerChunk;
      const boxes = chunks
        .filter((c) => c.cellX != null && c.cellY != null)
        .map((c) => {
          if (c.source === "chunkdata") {
            const x0 = c.cellX * cellTileSpan;
            const y0 = c.cellY * cellTileSpan;
            // chunkdata covers the whole cell, so wx spans cellDivisor chunks.
            const wx0 = c.cellX * cellDivisor;
            const wy0 = c.cellY * cellDivisor;
            return {
              x0,
              x1: x0 + cellTileSpan,
              y0,
              y1: y0 + cellTileSpan,
              wx0,
              wx1: wx0 + cellDivisor,
              wy0,
              wy1: wy0 + cellDivisor,
            };
          }
          const x0 = c.x * tilesPerChunk;
          const y0 = c.y * tilesPerChunk;
          return {
            x0,
            x1: x0 + tilesPerChunk,
            y0,
            y1: y0 + tilesPerChunk,
            wx0: c.x,
            wx1: c.x + 1,
            wy0: c.y,
            wy1: c.y + 1,
          };
        });
      try {
        vehiclesResult = await deleteVehiclesInBoxes(savePath, boxes, {
          backupPath: dbBackup,
        });
        log.info(`vehicles.db: removed ${vehiclesResult.deleted} rows`);
      } catch (e) {
        log.warn(`vehicles.db cleanup failed: ${e.message}`);
        errors.push(`vehicles.db: ${e.message}`);
      }
    }

    log.info(
      `Deleted ${deleted} chunks from save ${sanitizedSaveName} (cell aux files removed: ${cellCleanup.removed.length}, vehicles removed: ${vehiclesResult.deleted})`,
    );

    // /saves' and /chunks+/stats' cached scan of this save's map/ folder
    // (see getMapFolderScan()'s comment) is now stale -- a follow-up load
    // must not report chunks we just deleted.
    invalidateMapFolderScan(path.join(savePath, "map"));

    res.json({
      success: true,
      deleted,
      vehiclesDeleted: vehiclesResult.deleted || 0,
      cellFilesRemoved: cellCleanup.removed.length,
      errors: errors.length > 0 ? errors : undefined,
      backupCreated: createBackup,
    });
  } catch (error) {
    log.error(`Failed to delete chunks: ${error.message}`);
    res
      .status(error.statusCode || 500)
      .json({ error: sanitizeError(error.message) });
  }
});

// Delete chunks by region (x/y coordinate range)
router.post("/delete-region", requirePermission("chunks.manage"), async (req, res) => {
  try {
    const {
      saveName,
      minX,
      maxX,
      minY,
      maxY,
      createBackup = true,
      invert = false,
      customPath = null,
      deleteVehicles = false,
      force = false,
    } = req.body;

    // Refuse to mutate save files while the server is running. See the
    // delete-chunks handler above for the full rationale and `force` escape
    // hatch (issue #5: detection can false-positive on custom launchers).
    if (!force) {
      const serverManager = req.app.get("serverManager");
      // Fail CLOSED, not open -- see the matching comment in delete-chunks
      // above for the full rationale (this guard is identical, including
      // the "no fallback to checkServerRunning()" reasoning).
      let details = null;
      if (serverManager) {
        try {
          details =
            typeof serverManager.getServerProcessDetails === "function"
              ? await serverManager.getServerProcessDetails()
              : null;
        } catch (e) {
          log.warn(
            `Server-running check failed, refusing to proceed: ${e.message}`,
          );
          details = null;
        }
      }
      if (!details || details.scanFailed) {
        return res.status(503).json({
          error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
          code: ErrorCode.SERVER_STATE_UNKNOWN,
        });
      }
      if (details.running) {
        return res.status(400).json({
          error:
            "Stop the server before deleting chunks. Running servers hold save files open and will overwrite your changes on shutdown.",
          code: "server_running",
          matched: details.matched,
        });
      }
    } else {
      log.warn("delete-region: server-running check bypassed via force=true");
    }

    if (
      !saveName ||
      minX === undefined ||
      maxX === undefined ||
      minY === undefined ||
      maxY === undefined
    ) {
      return res.status(400).json({
        error: "Save name and region bounds required",
        code: ErrorCode.DELETE_REGION_FIELDS_REQUIRED,
      });
    }

    // Sanitize saveName to prevent path traversal. path.basename() alone
    // catches every payload that contains a separator ("../x", "a/../b") --
    // the sanitized value stops matching the original and the request is
    // rejected below. It does NOT catch the two special dot-segments on
    // their own: path.basename("..") === ".." and path.basename(".") === "."
    // (both are already "just a basename" by Node's own definition), so
    // without the explicit check here a saveName of ".." or "." sails
    // through unchanged and resolves savePath to the PARENT of the saves
    // directory (or the saves directory itself) instead of a real save --
    // proven end-to-end (a decoy file placed outside any save gets deleted,
    // and /stats leaks aggregate sibling-save size) in
    // linuxChunksSaveNameTraversal.test.js.
    const sanitizedSaveName = path.basename(saveName);
    if (
      !sanitizedSaveName ||
      sanitizedSaveName !== saveName ||
      sanitizedSaveName === "." ||
      sanitizedSaveName === ".."
    ) {
      return res.status(400).json({
        error: "Invalid save name",
        code: ErrorCode.CHUNKS_INVALID_SAVE_NAME,
      });
    }

    // Validate bounds are numbers
    if (
      typeof minX !== "number" ||
      typeof maxX !== "number" ||
      typeof minY !== "number" ||
      typeof maxY !== "number" ||
      !Number.isFinite(minX) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(minY) ||
      !Number.isFinite(maxY)
    ) {
      return res.status(400).json({
        error: "Region bounds must be finite numbers",
        code: ErrorCode.DELETE_REGION_BOUNDS_NOT_FINITE,
      });
    }
    // Reject swapped bounds — otherwise a non-invert selection silently
    // matches nothing and the caller sees an unhelpful "0 deleted".
    if (minX > maxX || minY > maxY) {
      return res.status(400).json({
        error: "Region bounds inverted (minX > maxX or minY > maxY)",
        code: ErrorCode.DELETE_REGION_BOUNDS_INVERTED,
      });
    }

    const zomboidDataPath = customPath
      ? resolveCustomOrDefaultDataPath(String(customPath))
      : await getZomboidDataPath();
    if (!zomboidDataPath) {
      return res.status(400).json({
        error: "Zomboid data path not set",
        code: ErrorCode.CHUNKS_DATA_PATH_NOT_SET,
      });
    }
    if (customPath) await assertKnownSaveRoot(zomboidDataPath);

    const savesPath = resolveSavesPath(zomboidDataPath);
    const savePath = path.join(savesPath, sanitizedSaveName);
    const mapPath = path.join(savePath, "map");

    if (!fs.existsSync(savePath)) {
      return res.status(404).json({
        error: "Save not found",
        code: ErrorCode.CHUNKS_SAVE_NOT_FOUND,
      });
    }

    const mapExists = fs.existsSync(mapPath);

    // B42 vs B41 detection — filesystem-based (see detectSaveIsB42Sync's
    // comment above), not inferred from whether map/ currently has numeric
    // subdirectories. A B42 save with a fresh or emptied-out map/ folder (no
    // chunks generated yet, or a prior pass already deleted every chunk in
    // it) has xDirs.length === 0 even though it's genuinely B42 -- reading
    // that as B41 would silently pick the wrong cell divisor/tile size for
    // the cell-aux cleanup and vehicle-bbox math below. Computed once, before
    // the chunk scan, so the chunkdata scan below (display-coordinate
    // conversion) and the deletion pass share one answer.
    const regionIsB42 = detectSaveIsB42Sync(savePath);

    // Get all chunks - handle B42 directory structure, B41 flat files in map/, and B41 flat files in save root
    const chunksToDelete = [];
    let mapContents = [];
    let xDirs = [];

    if (mapExists) {
      mapContents = await fs.promises.readdir(mapPath, { withFileTypes: true });
      xDirs = mapContents.filter(
        (d) => d.isDirectory() && /^\d+$/.test(d.name),
      );
    }

    if (xDirs.length > 0) {
      // B42 structure: map/{X}/{Y}.bin
      await Promise.all(
        xDirs.map(async (xDir) => {
          const x = parseInt(xDir.name, 10);
          // Quick AABB check: if entire X row is out of X bounds, skip it
          if (!invert && (x < minX || x > maxX)) return;

          const xPath = path.join(mapPath, xDir.name);

          try {
            const yFiles = await fs.promises.readdir(xPath);
            const binFiles = yFiles.filter((f) => f.endsWith(".bin"));

            for (const yFile of binFiles) {
              const yMatch = yFile.match(/^(\d+)\.bin$/);
              if (yMatch) {
                const y = parseInt(yMatch[1], 10);

                const inRegion =
                  x >= minX && x <= maxX && y >= minY && y <= maxY;
                const shouldDelete = invert ? !inRegion : inRegion;

                if (shouldDelete) {
                  chunksToDelete.push({ file: `${x}/${yFile}`, x, y });
                }
              }
            }
          } catch (err) {
            log.warn(`Error reading chunk directory ${xPath}: ${err.message}`);
          }
        }),
      );
    } else {
      // Legacy flat file structure in map/ directory
      const files = mapContents
        .filter((f) => f.isFile() && f.name.endsWith(".bin"))
        .map((f) => f.name);

      for (const file of files) {
        const match = file.match(
          /^(?:map_|chunkdata_|chunk_)?(\d+)_(\d+)(?:_\d+)?\.bin$/i,
        );
        if (match) {
          const x = parseInt(match[1], 10);
          const y = parseInt(match[2], 10);

          const inRegion = x >= minX && x <= maxX && y >= minY && y <= maxY;
          const shouldDelete = invert ? !inRegion : inRegion;

          if (shouldDelete) {
            chunksToDelete.push({ file, x, y });
          }
        }
      }

      // B41 save-root fallback: check for map_X_Y.bin in save root
      if (chunksToDelete.length === 0) {
        const B41_CHUNK_REGEX = /^map_(\d+)_(\d+)\.bin$/i;
        const rootEntries = await fs.promises.readdir(savePath, {
          withFileTypes: true,
        });
        const rootBinFiles = rootEntries.filter(
          (f) => f.isFile() && B41_CHUNK_REGEX.test(f.name),
        );

        for (const entry of rootBinFiles) {
          const match = entry.name.match(B41_CHUNK_REGEX);
          if (match) {
            const x = parseInt(match[1], 10);
            const y = parseInt(match[2], 10);

            const inRegion = x >= minX && x <= maxX && y >= minY && y <= maxY;
            const shouldDelete = invert ? !inRegion : inRegion;

            if (shouldDelete) {
              chunksToDelete.push({
                file: entry.name,
                x,
                y,
                source: "saveroot",
              });
            }
          }
        }
      }
    }

    // Also check the chunkdata folder for additional chunk data in range.
    // Mirrors GET /chunks/:saveName and /delete-chunks (see the comment on
    // that scan): a chunkdata entry can be the ONLY record of a cell's state
    // (no matching map/X/Y.bin), so a region delete that only walked map/
    // would silently leave those cells' chunkdata behind while still
    // reporting success -- the operator believes the region is clean and it
    // partially is not. Coordinates are converted to display (chunk-scale)
    // space the same way the GET scan does, so the same minX/maxX/minY/maxY
    // (and invert) bounds check applies uniformly across all three sources.
    {
      const chunkDataPath = path.join(savePath, "chunkdata");
      if (fs.existsSync(chunkDataPath)) {
        const chunkDataFiles = await fs.promises.readdir(chunkDataPath);
        const validFiles = chunkDataFiles.filter((f) => f.endsWith(".bin"));

        for (const file of validFiles) {
          const match = file.match(/^(\d+)_(\d+)(?:_\d+)?\.bin$/i);
          if (!match) continue;

          const rawX = parseInt(match[1], 10);
          const rawY = parseInt(match[2], 10);
          const displayX = regionIsB42 ? rawX * 32 : rawX * 30;
          const displayY = regionIsB42 ? rawY * 32 : rawY * 30;

          const inRegion =
            displayX >= minX &&
            displayX <= maxX &&
            displayY >= minY &&
            displayY <= maxY;
          const shouldDelete = invert ? !inRegion : inRegion;

          if (shouldDelete) {
            chunksToDelete.push({
              file,
              x: displayX,
              y: displayY,
              source: "chunkdata",
              cellX: rawX,
              cellY: rawY,
            });
          }
        }
      }
    }

    if (chunksToDelete.length === 0) {
      return res.json({
        success: true,
        deleted: 0,
        message: "No chunks in selected region",
      });
    }

    // Safety limit to prevent accidental mass deletion
    if (chunksToDelete.length > 100000) {
      return res.status(400).json({
        error: `Region too large (${chunksToDelete.length.toLocaleString()} chunks). Maximum is 100,000 at a time.`,
        code: ErrorCode.DELETE_REGION_TOO_LARGE,
        params: sanitizeErrorParams({ count: chunksToDelete.length }),
      });
    }

    // Create backup if requested
    let backupPath = null;
    if (createBackup) {
      backupPath = path.join(
        zomboidDataPath,
        "backups",
        `${sanitizedSaveName}_region_${Date.now()}`,
      );
      await fs.promises.mkdir(backupPath, { recursive: true });

      // Parallel backup. Source-tagged filename prefix (matching
      // /delete-chunks) so a B42 map chunk, a B41 save-root chunk, and a
      // chunkdata entry can't collide into the same backup filename.
      await Promise.all(
        chunksToDelete.map(async (chunk) => {
          const srcTag =
            chunk.source === "saveroot"
              ? "saveroot"
              : chunk.source === "chunkdata"
                ? "chunkdata"
                : "map";
          const srcFile =
            chunk.source === "saveroot"
              ? path.join(savePath, chunk.file)
              : chunk.source === "chunkdata"
                ? path.join(savePath, "chunkdata", chunk.file)
                : path.join(mapPath, chunk.file);
          try {
            const backupName = `${srcTag}_${chunk.file.replace(/[/\\]/g, "_")}`;
            await copyChunkBackup(
              srcFile,
              path.join(backupPath, backupName),
            );
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
        }),
      );

      // Save region info
      await fs.promises.writeFile(
        path.join(backupPath, "region_info.json"),
        JSON.stringify(
          {
            minX,
            maxX,
            minY,
            maxY,
            invert,
            chunksDeleted: chunksToDelete.length,
          },
          null,
          2,
        ),
      );

      log.info(`Created region backup at ${backupPath}`);
    }

    // Delete chunks
    let deleted = 0;
    const errors = [];
    const touchedCells = new Set();
    const regionCellDiv = cellDivisorFor(regionIsB42);

    await Promise.all(
      chunksToDelete.map(async (chunk) => {
        try {
          const chunkFile =
            chunk.source === "saveroot"
              ? path.join(savePath, chunk.file)
              : chunk.source === "chunkdata"
                ? path.join(savePath, "chunkdata", chunk.file)
                : path.join(mapPath, chunk.file);
          await fs.promises.unlink(chunkFile);
          deleted++;
          touchedCells.add(
            `${Math.floor(chunk.x / regionCellDiv)},${Math.floor(chunk.y / regionCellDiv)}`,
          );
        } catch (err) {
          if (err.code !== "ENOENT") {
            log.warn(`Failed to delete chunk ${chunk.file}: ${err.message}`);
            errors.push(`${chunk.file}: ${sanitizeError(err.message)}`);
          }
        }
      }),
    );

    // Per-cell aux cleanup — only for cells that are now fully empty on disk.
    const cellCleanup = await cleanupEmptyCellFiles(
      savePath,
      touchedCells,
      regionIsB42,
      backupPath,
    );

    // Clean up empty X directories after B42 chunk deletion
    const deletedXDirs = new Set();
    for (const chunk of chunksToDelete) {
      const parts = chunk.file.split("/");
      if (parts.length === 2) deletedXDirs.add(parts[0]);
    }
    for (const xDir of deletedXDirs) {
      try {
        const xDirPath = path.join(mapPath, xDir);
        const remaining = await fs.promises.readdir(xDirPath);
        if (remaining.length === 0) await fs.promises.rmdir(xDirPath);
      } catch (e) {
        if (e.code !== "ENOENT")
          log.debug(`Failed to clean up empty dir ${xDir}: ${e.message}`);
      }
    }

    // Vehicles.db cleanup (optional, destructive).
    // Backup lives inside the chunk backup folder (if one was made) so a
    // single restore operation covers everything from this call. Matches the
    // layout used by /delete-chunks.
    let vehiclesResult = { deleted: 0, skipped: true };
    if (deleteVehicles && deleted > 0) {
      const tilesPerChunk = tilesPerChunkFor(regionIsB42);
      const dbBackup =
        createBackup && typeof backupPath === "string"
          ? path.join(backupPath, "vehicles.db.bak")
          : null;
      // chunkdata-source entries cover a whole cell (not just one chunk) —
      // expand their box so a region delete doesn't miss vehicles in the
      // other cellDivisor²-1 chunks of that cell. Matches /delete-chunks.
      const cellTileSpan = regionCellDiv * tilesPerChunk;
      const boxes = chunksToDelete.map((c) => {
        if (c.source === "chunkdata") {
          const x0 = c.cellX * cellTileSpan;
          const y0 = c.cellY * cellTileSpan;
          const wx0 = c.cellX * regionCellDiv;
          const wy0 = c.cellY * regionCellDiv;
          return {
            x0,
            x1: x0 + cellTileSpan,
            y0,
            y1: y0 + cellTileSpan,
            wx0,
            wx1: wx0 + regionCellDiv,
            wy0,
            wy1: wy0 + regionCellDiv,
          };
        }
        const x0 = c.x * tilesPerChunk;
        const y0 = c.y * tilesPerChunk;
        return {
          x0,
          x1: x0 + tilesPerChunk,
          y0,
          y1: y0 + tilesPerChunk,
          wx0: c.x,
          wx1: c.x + 1,
          wy0: c.y,
          wy1: c.y + 1,
        };
      });
      try {
        vehiclesResult = await deleteVehiclesInBoxes(savePath, boxes, {
          backupPath: dbBackup,
        });
        log.info(
          `vehicles.db: removed ${vehiclesResult.deleted} rows from region`,
        );
      } catch (e) {
        log.warn(`vehicles.db region cleanup failed: ${e.message}`);
      }
    }

    log.info(
      `Deleted ${deleted} chunks in region [${minX},${minY}]-[${maxX},${maxY}] from ${sanitizedSaveName} (cell files removed: ${cellCleanup.removed.length}, vehicles: ${vehiclesResult.deleted})`,
    );

    // /saves' and /chunks+/stats' cached scan of this save's map/ folder
    // (see getMapFolderScan()'s comment) is now stale -- a follow-up load
    // must not report chunks we just deleted.
    invalidateMapFolderScan(mapPath);

    res.json({
      success: true,
      deleted,
      vehiclesDeleted: vehiclesResult.deleted || 0,
      cellFilesRemoved: cellCleanup.removed.length,
      errors: errors.length > 0 ? errors : undefined,
      region: { minX, maxX, minY, maxY },
      inverted: invert,
    });
  } catch (error) {
    log.error(`Failed to delete region: ${error.message}`);
    res
      .status(error.statusCode || 500)
      .json({ error: sanitizeError(error.message) });
  }
});

// Get save statistics
router.get("/stats/:saveName", requirePermission("chunks.manage"), async (req, res) => {
  try {
    const { saveName } = req.params;
    const customPath = req.query.customPath
      ? String(req.query.customPath)
      : null;

    // Sanitize saveName to prevent path traversal. path.basename() alone
    // catches every payload that contains a separator ("../x", "a/../b") --
    // the sanitized value stops matching the original and the request is
    // rejected below. It does NOT catch the two special dot-segments on
    // their own: path.basename("..") === ".." and path.basename(".") === "."
    // (both are already "just a basename" by Node's own definition), so
    // without the explicit check here a saveName of ".." or "." sails
    // through unchanged and resolves savePath to the PARENT of the saves
    // directory (or the saves directory itself) instead of a real save --
    // proven end-to-end (a decoy file placed outside any save gets deleted,
    // and /stats leaks aggregate sibling-save size) in
    // linuxChunksSaveNameTraversal.test.js.
    const sanitizedSaveName = path.basename(saveName);
    if (
      !sanitizedSaveName ||
      sanitizedSaveName !== saveName ||
      sanitizedSaveName === "." ||
      sanitizedSaveName === ".."
    ) {
      return res.status(400).json({
        error: "Invalid save name",
        code: ErrorCode.CHUNKS_INVALID_SAVE_NAME,
      });
    }

    let zomboidDataPath;
    if (customPath) {
      // Validate custom path the same way /saves and /chunks do — prevents
      // arbitrary filesystem reads via the stats endpoint.
      zomboidDataPath = resolveCustomOrDefaultDataPath(String(customPath));
    } else {
      zomboidDataPath = await getZomboidDataPath();
    }

    if (!zomboidDataPath) {
      return res.status(400).json({
        error: "Zomboid data path not set",
        code: ErrorCode.CHUNKS_DATA_PATH_NOT_SET,
      });
    }

    // Resolve the saves path the same way as /saves
    let savesPath = resolveSavesPath(zomboidDataPath);

    const savePath = path.join(savesPath, sanitizedSaveName);

    if (!fs.existsSync(savePath)) {
      return res.status(404).json({
        error: "Save not found",
        code: ErrorCode.CHUNKS_SAVE_NOT_FOUND,
      });
    }

    const folders = [
      "map",
      "chunkdata",
      "isoregiondata",
      "zpop",
      "metagrid",
      "apop",
      "radio",
    ];

    // One combined walk per known folder (count + size together) instead of
    // countFiles() and getDirSize() separately — that previously walked
    // each folder's whole subtree twice.
    const folderStatsByName = {};
    for (const folder of folders) {
      const folderPath = path.join(savePath, folder);
      try {
        if (folder === "map") {
          // map/ is the one folder /chunks/:saveName ALSO walks on the same
          // page load (Promise.allSettled fires both routes concurrently) —
          // route through the shared, in-flight-coalesced scan instead of
          // getDirStats() so a B42 save's 100k+ files get walked once, not
          // twice. See getMapFolderScan()'s comment for the measured win.
          const mapScan = await getMapFolderScan(folderPath);
          if (mapScan.isB42Structure) {
            const chunkSize = mapScan.rawChunks.reduce(
              (sum, c) => sum + c.size,
              0,
            );
            folderStatsByName.map = {
              count: mapScan.totalBinFiles + mapScan.totalNonBinFiles,
              size: chunkSize + mapScan.totalNonBinSize,
            };
          } else if (mapScan.mapExists) {
            // Non-B42 map/ (flat B41 files or empty) is cheap to walk
            // directly — no coalescing benefit, keep the existing path.
            const { count, size } = await getDirStats(folderPath);
            folderStatsByName.map = { count, size };
          }
          continue;
        }
        if (fs.existsSync(folderPath)) {
          const { count, size } = await getDirStats(folderPath);
          folderStatsByName[folder] = { count, size };
        }
      } catch (e) {
        log.debug(`Failed to stat folder ${folder}: ${e.message}`);
      }
    }

    // Total save size: sum of everything directly under savePath. Reuses
    // the per-folder walk above for entries that are one of the known
    // folders (previously a THIRD full walk of the same subtree — once as
    // part of this total, once via countFiles, once via getDirSize) rather
    // than re-scanning them.
    let totalSize = 0;
    try {
      const topEntries = await fs.promises.readdir(savePath, { withFileTypes: true });
      const topSizes = await runWithConcurrency(topEntries, DIR_WALK_CONCURRENCY, async (entry) => {
        if (entry.isDirectory()) {
          if (Object.prototype.hasOwnProperty.call(folderStatsByName, entry.name)) {
            return folderStatsByName[entry.name].size;
          }
          // A directory we don't already have stats for (not one of the
          // known folders) — still needs its own walk to be counted.
          return getDirSize(path.join(savePath, entry.name));
        }
        try {
          const s = await fs.promises.stat(path.join(savePath, entry.name));
          return s.size;
        } catch (e) {
          return 0;
        }
      });
      totalSize = topSizes.reduce((a, b) => a + b, 0);
    } catch (err) {
      if (err.code !== "EACCES" && err.code !== "ENOENT")
        log.debug(`Top-level size scan failed for ${savePath}: ${err.message}`);
    }

    const stats = {
      saveName,
      totalSize,
      folders: {},
    };

    for (const folder of folders) {
      if (folderStatsByName[folder]) {
        const { count, size } = folderStatsByName[folder];
        stats.folders[folder] = {
          fileCount: count,
          size,
          sizeFormatted: formatBytes(size),
        };
      }
    }

    // B41 root chunk files: count map_X_Y.bin in save root when map/ has no chunks
    if (!stats.folders.map || stats.folders.map.fileCount === 0) {
      const B41_CHUNK_REGEX = /^map_\d+_\d+\.bin$/i;
      try {
        const rootEntries = await fs.promises.readdir(savePath, {
          withFileTypes: true,
        });
        const rootChunks = rootEntries.filter(
          (f) => f.isFile() && B41_CHUNK_REGEX.test(f.name),
        );
        if (rootChunks.length > 0) {
          let rootChunkSize = 0;
          for (const f of rootChunks) {
            try {
              const s = await fs.promises.stat(path.join(savePath, f.name));
              rootChunkSize += s.size;
            } catch (e) {
              log.debug(`Stat failed for root chunk ${f.name}: ${e.message}`);
            }
          }
          stats.folders["map (root)"] = {
            fileCount: rootChunks.length,
            size: rootChunkSize,
            sizeFormatted: formatBytes(rootChunkSize),
          };
        }
      } catch (e) {
        log.debug(`B41 root chunk scan failed: ${e.message}`);
      }
    }

    // Players count
    const playersDb = path.join(savePath, "players.db");
    if (fs.existsSync(playersDb)) {
      try {
        const s = await fs.promises.stat(playersDb);
        stats.playersDbSize = s.size;
      } catch (e) {
        log.debug(`Stat failed for players.db: ${e.message}`);
      }
    }

    // Vehicles db
    const vehiclesDb = path.join(savePath, "vehicles.db");
    if (fs.existsSync(vehiclesDb)) {
      try {
        const s = await fs.promises.stat(vehiclesDb);
        stats.vehiclesDbSize = s.size;
      } catch (e) {
        log.debug(`Stat failed for vehicles.db: ${e.message}`);
      }
    }

    stats.totalSizeFormatted = formatBytes(stats.totalSize);

    res.json(stats);
  } catch (error) {
    const isUserError = error.statusCode && error.statusCode < 500;
    if (isUserError)
      log.warn(`Get stats rejected (${error.statusCode}): ${error.message}`);
    else log.error(`Failed to get save stats: ${error.message}`);
    const payload = { error: sanitizeError(error.message) };
    if (error.details) payload.rejection = error.details;
    res.status(error.statusCode || 500).json(payload);
  }
});

// Helper functions
//
// getDirSize/getDirStats both recurse with bounded concurrency
// (via runWithConcurrency) rather than firing every entry at once — a
// directory with hundreds of subdirectories previously opened hundreds of
// simultaneous readdir/stat handles per recursion level. That's a per-level
// bound, not a global one — see the note on runWithConcurrency above for
// why, and the real worst case for a walk this deep.
const DIR_WALK_CONCURRENCY = 8;

async function getDirSize(dirPath) {
  let totalSize = 0;
  try {
    const files = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const sizes = await runWithConcurrency(files, DIR_WALK_CONCURRENCY, async (file) => {
      const filePath = path.join(dirPath, file.name);
      if (file.isDirectory()) {
        return getDirSize(filePath);
      }
      try {
        const stats = await fs.promises.stat(filePath);
        return stats.size;
      } catch (e) {
        return 0;
      }
    });
    totalSize = sizes.reduce((a, b) => a + b, 0);
  } catch (err) {
    if (err.code !== "EACCES" && err.code !== "ENOENT")
      log.debug(`getDirSize error for ${dirPath}: ${err.message}`);
  }
  return totalSize;
}

// Combined file-count + total-size in a single recursive pass — for callers
// (currently only /stats/:saveName) that need both numbers for the SAME
// directory, where walking it for a count and again for a size separately
// would walk that directory's whole subtree twice for no reason.
async function getDirStats(dirPath) {
  let count = 0;
  let size = 0;
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    await runWithConcurrency(entries, DIR_WALK_CONCURRENCY, async (entry) => {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const sub = await getDirStats(entryPath);
        count += sub.count;
        size += sub.size;
        return;
      }
      count++;
      try {
        const stats = await fs.promises.stat(entryPath);
        size += stats.size;
      } catch (e) {
        // Matches getDirSize's silent-0-on-stat-failure — the file still
        // counts, it just doesn't contribute a known size.
      }
    });
  } catch (err) {
    if (err.code !== "EACCES" && err.code !== "ENOENT")
      log.debug(`getDirStats error for ${dirPath}: ${err.message}`);
  }
  return { count, size };
}

// /saves, /chunks/:saveName and /stats/:saveName all need to walk map/'s
// B42 {X}/{Y}.bin structure for the SAME save. /chunks and /stats fire
// concurrently on every page load (ChunkCleaner.tsx's Promise.allSettled) --
// on a 147,136-file synthetic fixture matching a real operator save, that
// pair alone went from 15.3s to ~5.6s once they shared one in-flight walk
// instead of each doing its own. /saves runs BEFORE that pair, sequentially
// (the client awaits fetchSaves() to completion before auto-selecting a
// save and firing /chunks+/stats) -- by the time /chunks+/stats start,
// /saves' own walk has already resolved and its in-flight entry is gone,
// so pure in-flight sharing can't bridge that gap. Nothing changes on disk
// during that gap either: it's the same page mount, no user action has
// happened yet. Measured full-mount-sequence cost of paying for that
// second walk anyway: /saves (~5-8s, see commit c67099f) then /chunks+
// /stats (~5.6s) again, back to back.
//
// So there are two layers here:
//  1. In-flight sharing (as before) for genuinely concurrent callers.
//  2. A SHORT (few-second) TTL cache on top, to bridge the sequential
//     /saves -> /chunks+/stats gap within one page mount.
//
// The TTL is a BACKSTOP, not the primary correctness mechanism -- EXPLICIT
// invalidation is. Every write this file makes to a save's map/ directory
// (delete-chunks, delete-region) calls invalidateMapFolderScan() directly,
// so a chunk count is never stale after an action taken from this app's own
// chunk-deletion UI, which is the case that actually feeds a destructive
// decision (delete once, reload, see the old count, delete "again").
// The TTL exists for writers THIS FILE CANNOT SEE: server.js's /wipe
// recursively deletes map/ outright, and backupService.js's restoreBackup()
// extracts a full save over the existing one -- both mutate the same tree
// from a different module with no path to call into this one or be called
// back. Kept short deliberately: a stale read in the few seconds after
// either of those is a narrow accident of timing (the user would have to
// return to this exact save's chunk view within the TTL window), not a
// standing risk the way an un-invalidated cache would be.
const MAP_SCAN_TTL_MS = 3000;
const _mapScanCache = new Map(); // mapPath -> { result, at }
const _mapScanInflight = new Map(); // mapPath -> Promise<scan result>

async function getMapFolderScan(mapPath, emitProgress) {
  const cached = _mapScanCache.get(mapPath);
  if (cached && Date.now() - cached.at < MAP_SCAN_TTL_MS) {
    return cached.result;
  }
  const inflight = _mapScanInflight.get(mapPath);
  if (inflight) return inflight;
  const promise = scanMapFolder(mapPath, emitProgress)
    .then((result) => {
      _mapScanCache.set(mapPath, { result, at: Date.now() });
      return result;
    })
    .finally(() => {
      _mapScanInflight.delete(mapPath);
    });
  _mapScanInflight.set(mapPath, promise);
  return promise;
}

// Call after any write THIS FILE makes to a save's map/ directory. Clears
// only the resolved-and-cached entry -- a walk already in flight was
// started before this write and will still hand its (pre-write) result to
// whoever is already awaiting it, but there is nothing safe to cancel
// mid-walk, and the NEXT call sees a cache miss here and starts fresh once
// that in-flight walk clears itself.
function invalidateMapFolderScan(mapPath) {
  _mapScanCache.delete(mapPath);
}

// The actual walk, extracted verbatim from the old inline /chunks scan loop
// (same XDIR_SCAN_CONCURRENCY bound, same progress emits) except it returns
// raw per-file records instead of mutating a request-scoped `chunks` array
// or calling a request-scoped dedup closure -- callers (both /chunks and
// /stats) derive their own response shape from the shared result, so this
// function has no knowledge of either route's output format.
//
// `emitProgress` is best-effort: only whichever caller's request actually
// triggers the walk (the "winner" when /chunks and /stats race in) gets
// progress emits for that walk. /stats never passes one. In practice
// /chunks is listed first in the client's Promise.allSettled call and wins
// almost always; on the rare occasion /stats wins instead, the walk still
// completes at the same (now much faster) speed, just without a progress
// bar tick for that particular page load -- a cosmetic-only trade-off.
async function scanMapFolder(mapPath, emitProgress) {
  const mapExists = fs.existsSync(mapPath);
  if (!mapExists) {
    return { mapExists: false, isB42Structure: false };
  }

  const mapContents = await fs.promises.readdir(mapPath, {
    withFileTypes: true,
  });
  const xDirs = mapContents.filter(
    (d) => d.isDirectory() && /^\d+$/.test(d.name),
  );

  if (xDirs.length === 0) {
    return { mapExists: true, isB42Structure: false, mapContents };
  }

  // B42 structure: map/{X}/{Y}.bin
  // Bounded-concurrency directory scan: XDIR_SCAN_CONCURRENCY dirs in
  // flight at once. A large B42 map can have hundreds of X-directories; a
  // fully sequential scan pays each directory's round-trip latency one
  // after another, which is fine on a local SSD but adds up fast on the
  // spinning arrays / network shares unRAID setups commonly use. Unbounded
  // concurrency has its own failure mode on the same hardware — hundreds of
  // simultaneous readdir/stat calls can exhaust file handles (EMFILE) or
  // queue so deep on slow storage that it's slower than sequential. See
  // runWithConcurrency() above.
  const XDIR_SCAN_CONCURRENCY = 8;
  let totalBinFiles = 0;
  let totalNonBinFiles = 0;
  let totalNonBinSize = 0;
  let sampleNonBinFiles = [];
  let emptyDirs = 0;
  let scannedDirs = 0;
  const rawChunks = [];
  emitProgress?.(0, xDirs.length, 0, { force: true });

  await runWithConcurrency(xDirs, XDIR_SCAN_CONCURRENCY, async (xDir) => {
    const x = parseInt(xDir.name, 10);
    const xPath = path.join(mapPath, xDir.name);

    try {
      // Read Y files in this X directory
      const yEntries = await fs.promises.readdir(xPath, {
        withFileTypes: true,
      });
      // Only process files (skip subdirectories inside chunk dirs)
      const yFiles = yEntries.filter((e) => e.isFile()).map((e) => e.name);

      if (yFiles.length === 0) {
        emptyDirs++;
        return;
      }

      const binFiles = yFiles.filter((f) => f.endsWith(".bin"));
      const nonBinFiles = yFiles.filter((f) => !f.endsWith(".bin"));
      totalBinFiles += binFiles.length;
      totalNonBinFiles += nonBinFiles.length;
      if (nonBinFiles.length > 0 && sampleNonBinFiles.length < 5) {
        sampleNonBinFiles.push(
          ...nonBinFiles.slice(0, 3).map((f) => `${xDir.name}/${f}`),
        );
      }

      const yMatches = [];
      for (const yFile of binFiles) {
        const yMatch = yFile.match(/^(\d+)\.bin$/);
        if (!yMatch) continue;
        yMatches.push({ y: parseInt(yMatch[1], 10), yFile });
      }

      const [chunkResults, nonBinSizes] = await Promise.all([
        Promise.all(
          yMatches.map(async ({ y, yFile }) => {
            const filePath = path.join(xPath, yFile);
            try {
              const stats = await fs.promises.stat(filePath);
              return {
                file: `${x}/${yFile}`,
                x,
                y,
                size: stats.size,
                modified: stats.mtime,
              };
            } catch (e) {
              log.debug(`Stat failed for chunk ${x}/${yFile}: ${e.message}`);
              return null;
            }
          }),
        ),
        // Stat non-.bin files too, purely so /stats' folder size for map/
        // matches what getDirStats() would have reported (it stats every
        // file regardless of extension) -- these are expected to be rare to
        // nonexistent on a real save.
        Promise.all(
          nonBinFiles.map(async (f) => {
            try {
              const s = await fs.promises.stat(path.join(xPath, f));
              return s.size;
            } catch (e) {
              return 0;
            }
          }),
        ),
      ]);

      for (const chunk of chunkResults) {
        if (chunk) rawChunks.push(chunk);
      }
      totalNonBinSize += nonBinSizes.reduce((a, b) => a + b, 0);
    } catch (err) {
      log.warn(`Error reading chunk directory ${xPath}: ${err.message}`);
    }

    scannedDirs++;
    emitProgress?.(scannedDirs, xDirs.length, rawChunks.length);
  });

  // Diagnostic: log what was found inside the B42 dirs
  log.info(
    `[ChunkCleaner] B42 scan: ${rawChunks.length} chunks loaded, ${totalBinFiles} .bin files, ${emptyDirs} empty dirs, ${totalNonBinFiles} non-.bin files${sampleNonBinFiles.length > 0 ? " (samples: " + sampleNonBinFiles.join(", ") + ")" : ""}`,
  );
  emitProgress?.(xDirs.length, xDirs.length, rawChunks.length, {
    force: true,
  });

  return {
    mapExists: true,
    isB42Structure: true,
    rawChunks,
    totalBinFiles,
    totalNonBinFiles,
    totalNonBinSize,
    emptyDirs,
    mapContents,
  };
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// Browse a path — list directories for manual navigation. Confined to the
// active server's zomboidDataPath so this can't be used to walk the entire
// host filesystem (it was previously unconfined path.resolve()).
router.get("/browse", requirePermission("chunks.manage"), async (req, res) => {
  try {
    const browsePath = req.query.path ? String(req.query.path) : null;
    const zomboidDataPath = await getZomboidDataPath();

    if (!browsePath) {
      // Return the current zomboidDataPath as starting point
      return res.json({
        currentPath: zomboidDataPath || "",
        directories: [],
        hasSaves: false,
      });
    }

    if (!zomboidDataPath) {
      return res.status(400).json({
        error: "No Zomboid data path configured to browse",
        code: ErrorCode.BROWSE_CHUNKS_DATA_PATH_NOT_SET,
      });
    }

    const allowedRoots = [path.resolve(zomboidDataPath)];
    const resolved = confineToRoots(browsePath, allowedRoots);
    if (!resolved) {
      return res.status(403).json({
        error: "Access denied: path is outside the server's save directory",
        code: ErrorCode.BROWSE_CHUNKS_ACCESS_DENIED,
      });
    }

    if (!fs.existsSync(resolved)) {
      return res.status(400).json({
        error: "Path does not exist",
        code: ErrorCode.BROWSE_CHUNKS_PATH_NOT_FOUND,
      });
    }

    const stat = await fs.promises.stat(resolved);
    if (!stat.isDirectory()) {
      return res.status(400).json({
        error: "Path is not a directory",
        code: ErrorCode.BROWSE_CHUNKS_PATH_NOT_DIRECTORY,
      });
    }

    const entries = await fs.promises.readdir(resolved, {
      withFileTypes: true,
    });
    const directories = entries
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    // Check if this path has a Saves/Multiplayer structure
    const savesMultiplayer = path.join(resolved, "Saves", "Multiplayer");
    const hasSavesMultiplayer = fs.existsSync(savesMultiplayer);

    // Or if it IS a Saves/Multiplayer path
    const basename = path.basename(resolved);
    const parentBase = path.basename(path.dirname(resolved));
    const isSavesMultiplayer =
      basename === "Multiplayer" && parentBase === "Saves";

    // Check if any child dirs contain a map/ folder or B41 root chunk files (direct save dirs)
    const B41_ROOT_REGEX = /^map_\d+_\d+\.bin$/i;
    const hasMapFolders = directories.some((d) => {
      const childPath = path.join(resolved, d);
      if (fs.existsSync(path.join(childPath, "map"))) return true;
      // B41 fallback: check for map_X_Y.bin files in the child directory
      try {
        const childFiles = fs.readdirSync(childPath);
        return childFiles.some((f) => B41_ROOT_REGEX.test(f));
      } catch (e) {
        log.debug(`B41 check failed for ${d}: ${e.message}`);
        return false;
      }
    });

    res.json({
      currentPath: resolved,
      directories,
      hasSaves: hasSavesMultiplayer || isSavesMultiplayer || hasMapFolders,
      parent:
        path.dirname(resolved) !== resolved &&
        confineToRoots(path.dirname(resolved), allowedRoots)
          ? path.dirname(resolved)
          : null,
    });
  } catch (error) {
    log.error(`Failed to browse path: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
