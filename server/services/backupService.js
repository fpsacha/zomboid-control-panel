import path from "path";
import fs from "fs";
import { createWriteStream } from "fs";
import { StreamingBackupArchive } from "./backupArchive.js";
import { createReadStream } from "fs";
import { crc32 } from "zlib";
import { randomUUID } from "crypto";
import { createLogger } from "../utils/logger.js";
import { isPidAlive } from "../utils/pidLiveness.js";
import { ErrorCode } from "../utils/errorCodes.js";
import {
  listWorldFolders,
  saveFolderBelongsToName,
  saveFolderKey,
} from "../utils/savesFolder.js";
const log = createLogger("Backup");
import {
  getActiveServer,
  getServers,
  getSetting,
  setSetting,
  logServerEvent,
  getLatestScheduleExecutionByCommand,
  flushWrites,
} from "../database/init.js";
import { sanitizeError } from "../utils/sanitize.js";
import {
  RESTORE_ROLLBACK_FAILED_PREFIX,
  publicRestoreMessage,
} from "../utils/restoreMessage.js";
import { captureBackupSnapshot } from "../utils/backupSnapshot.js";
import { redactPanelDbForBackup } from "../utils/panelDbRedaction.js";
import {
  describeRefusal,
  logRefusalOnce,
  zomboidDataFolderHolds,
  zomboidDataFolderRefusal,
} from "./zomboidDataPath.js";
import {
  addBackupRecord,
  listBackupRecords,
  removeBackupRecord,
} from "./backupRecords.js";
import { invalidateMapFolderScan } from "../routes/chunks.js";
import {
  isCronTooFrequent,
  isSupportedFiveFieldCron,
} from "../utils/cronValidation.js";
import { LEGACY_RESTART_SKIP_MESSAGE } from "../utils/backupRestartOverlap.js";
import { resolveObservedServerRunning } from "../utils/serverStatus.js";
import { renameWithRetry } from "../utils/renameWithRetry.js";
import { measureFolder, walkDirectory } from "./backupFolderWalk.js";
import {
  estimateArchiveBytes,
  formatBytes,
  freeBytesAt,
  insufficientSpaceError,
  onSameVolume,
} from "./backupDiskSpace.js";
import {
  MAX_SAFETY_BACKUPS,
  attributeBackupFilename,
  backupSortKey,
  isSafetyBackupName,
  safetyBackupPrefix,
} from "./backupNames.js";
import {
  createRestoreStagingDir,
  extractArchiveToStaging,
  normalizeZipEntryPath,
  sweepStaleRestoreStaging,
} from "./backupRestoreExtract.js";

// Kept exported from here: tests (and any caller) import it by this name.
export { createRestoreStagingDir };

// Dynamic import for unzipper (CommonJS module)
let unzipper;
async function getUnzipper() {
  if (!unzipper) {
    unzipper = await import("unzipper");
  }
  return unzipper;
}

// The shape a page may pick for its own restore's id (see restoreBackup()'s
// currentRestore/lastRestore comment) -- anything else gets a server-made
// one. It is echoed back in GET /backup/status, so it stays short and plain.
const RESTORE_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// "View snapshot" reads panel-server-snapshot.json, a few KB in a real
// backup; an uploaded zip can hold anything under that name.
export const SNAPSHOT_MAX_BYTES = 1024 * 1024;
export const ZIP_ENTRY_TOO_LARGE = "ZIP_ENTRY_TOO_LARGE";

/**
 * One entry of a zip on disk, read into memory only up to `maxBytes`: the
 * inflated bytes are counted as they arrive (the sizes in the zip's directory
 * are whatever the archive says) and the read stops past the cap with an
 * error whose code is ZIP_ENTRY_TOO_LARGE. Resolves null when there is no
 * such entry. Every read stream it opens is closed when it settles (unzipper's
 * Open.file() leaves the ones it opens behind, holding the file open).
 */
export async function readZipEntryCapped(unzip, filePath, entryPath, maxBytes) {
  const streams = new Set();
  let onSourceError = null;
  const source = {
    stream(start, length) {
      const end = length ? start + length : undefined;
      const stream = fs.createReadStream(filePath, { start, end });
      streams.add(stream);
      stream.on("close", () => streams.delete(stream));
      // pipe() does not forward a source's errors: without this an
      // unreadable file would be an uncaught 'error'.
      stream.on("error", (error) => onSourceError?.(error));
      return stream;
    },
    size: async () => (await fs.promises.stat(filePath)).size,
  };
  const tooLarge = () =>
    Object.assign(new Error(`${entryPath} is larger than ${maxBytes} bytes`), {
      code: ZIP_ENTRY_TOO_LARGE,
    });
  try {
    const archive = await new Promise((resolve, reject) => {
      onSourceError = reject;
      unzip.Open.custom(source).then(resolve, reject);
    });
    const entry = archive.files.find((file) => file.path === entryPath);
    if (!entry) return null;
    if (Number.isFinite(entry.uncompressedSize) && entry.uncompressedSize > maxBytes) {
      throw tooLarge();
    }
    return await new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let done = false;
      const stream = entry.stream();
      const finish = (error, value) => {
        if (done) return;
        done = true;
        if (error) {
          stream.destroy();
          reject(error);
        } else {
          resolve(value);
        }
      };
      onSourceError = (error) => finish(error);
      stream.on("data", (chunk) => {
        if (done) return;
        total += chunk.length;
        if (total > maxBytes) {
          finish(tooLarge());
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => finish(null, Buffer.concat(chunks, total)));
      stream.on("error", (error) => finish(error));
    });
  } finally {
    onSourceError = null;
    for (const stream of streams) stream.destroy();
  }
}

// Orphan temp sweep, hunt-wave11-2026-08-29 follow-up. Dwight found this
// while copying this function as the model for fileWriteQueue.js's own
// sweep (531dfd8d) -- his copy came out stronger than the original.
// cleanupOrphanBackupTemps deleted on FILENAME PATTERN ALONE, with no check
// that the process which created a match is actually gone. Safe TODAY only
// because backups are effectively single-flight -- an assumption resting
// OUTSIDE this function rather than a guarantee inside it. If concurrent
// backups ever become possible, this deleted a live backup's temp with no
// warning.
//
// Applies the shared isPidAlive() helper (utils/pidLiveness.js) exactly:
// any outcome other than a confirmed ESRCH (including EPERM, a pid this
// process cannot signal) is treated as "still alive" -- an ambiguous
// signal never authorises a delete. fileWriteQueue.js's writeFileAtomic
// sweep applies the same helper to its own, differently-shaped pattern
// (hunt-wave12, 2026-08-30: unifies what used to be two duplicated copies
// of this pid-liveness check, one per file).
//
// The two patterns THIS function sweeps do NOT uniformly embed a pid, so
// this deliberately does NOT force one sweep mechanism onto both (that
// generalisation is what Dwight correctly deferred rather than inventing,
// and unifying the pid-liveness check above does not change that):
//   - .central-{pid}-{timestamp}-{random}.tmp (StreamingZipWriter's own
//     centralPath, server/utils/streamingZip.js) DOES embed a pid as its
//     first segment, extracted and liveness-checked below.
//   - *.zip.tmp (`${backupPath}.tmp`, this file's own createBackup) has NO
//     pid anywhere in its name. There is no liveness check to run without
//     changing that naming scheme, which is a separate, larger change than
//     this card's scope -- left exactly as before (pattern-only deletion),
//     still resting on the single-flight assumption above. Deliberately
//     NOT given a false sense of safety by bolting a liveness check onto a
//     name that cannot carry one.
const CENTRAL_TEMP_PATTERN = /^\.central-(\d+)-\d+-[0-9a-z]+\.tmp$/;
// POST /api/backup/upload streams into `${targetPath}.${pid}.${random}.tmp`
// (routes/backup.js) and a killed panel left it behind for good: it embeds
// a pid, so it is swept like the central-directory temp, once that pid is gone.
const UPLOAD_TEMP_PATTERN = /\.zip\.(\d+)\.[0-9a-z]+\.tmp$/;

// Exported alias, not a fresh implementation: kept so this sweep's own
// tests and callers can name the check in domain terms (is the temp
// file's *owner* still alive) without every caller needing to know the
// underlying check is now shared with fileWriteQueue.js.
export const isBackupTempOwnerAlive = isPidAlive;

// When this process started. In the Docker images the panel is PID 1 at every
// start, so a temp left by a killed earlier run carries a pid that is "alive"
// again (it is ours): a temp named with OUR pid but last written before this
// process started is from an earlier run and is swept too.
const PROCESS_STARTED_AT_MS = Date.now() - process.uptime() * 1000;
const START_CLOCK_SLACK_MS = 5000;

export function cleanupOrphanBackupTemps(backupsPath) {
  let entries;
  try {
    entries = fs.readdirSync(backupsPath);
  } catch {
    return;
  }
  for (const name of entries) {
    const pidMatch = CENTRAL_TEMP_PATTERN.exec(name) || UPLOAD_TEMP_PATTERN.exec(name);
    if (pidMatch) {
      const ownerPid = Number(pidMatch[1]);
      if (ownerPid === process.pid) {
        let writtenAt = Infinity;
        try {
          writtenAt = fs.statSync(path.join(backupsPath, name)).mtimeMs;
        } catch {
          continue;
        }
        if (writtenAt >= PROCESS_STARTED_AT_MS - START_CLOCK_SLACK_MS) continue; // ours, in use
      } else if (isBackupTempOwnerAlive(ownerPid)) {
        continue;
      }
    } else if (!name.endsWith(".zip.tmp")) {
      continue;
    }
    try {
      fs.unlinkSync(path.join(backupsPath, name));
      log.info(`Removed orphan backup temporary file: ${name}`);
    } catch (error) {
      log.debug(`Could not remove orphan backup temporary file ${name}: ${error.message}`);
    }
  }
}

// 2026-08-26 bug hunt: used to resolve with nothing (undefined) on BOTH a
// genuine "entry" success and an ENOENT warning (a file that vanished
// between the initial scan and archiving -- a real race on a live PZ
// directory, since the game process rotates/deletes temp files, logs and
// lock files while a backup can be mid-scan). That made the two outcomes
// indistinguishable to every caller, so a silently-dropped file left zero
// trace anywhere -- createBackup resolved success:true regardless of how
// many files were actually skipped. Now resolves { skipped: boolean } so
// callers can track precisely which archive entries made it in and which
// didn't, entry by entry, with no separate bookkeeping needed: every path
// that adds anything to the archive already goes through this function.
export function waitForArchiveEntry(archive, append) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      archive.off("entry", onEntry);
      archive.off("error", onError);
      archive.off("warning", onWarning);
    };

    const settle = (handler, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    };

    const onEntry = () => settle(resolve, { skipped: false });
    const onError = (error) => settle(reject, error);
    const onWarning = (error) => {
      if (error.code === "ENOENT") {
        settle(resolve, { skipped: true });
      } else {
        settle(reject, error);
      }
    };

    archive.on("entry", onEntry);
    archive.on("error", onError);
    archive.on("warning", onWarning);

    try {
      append();
    } catch (error) {
      settle(reject, error);
    }
  });
}

// Returns the archive-relative paths of any entries that were skipped --
// either vanished between the scan and the archive pass, or a symbolic
// link deliberately not followed -- rather than swallowing that
// information the way the caller used to have no way to find out.
export async function appendDirectoryToArchive(archive, sourceRoot, destinationRoot) {
  const skipped = [];
  for await (const { entry, fullPath, archivePath, isSymlink } of walkDirectory(
    sourceRoot,
  )) {
    const entryName = `${destinationRoot}/${archivePath}${entry.isDirectory() ? "/" : ""}`;
    if (isSymlink) {
      log.warn(`Skipping symbolic link during backup: ${fullPath}`);
      skipped.push(entryName);
      continue;
    }
    const result = await waitForArchiveEntry(archive, () =>
      archive.file(fullPath, { name: entryName }),
    );
    if (result.skipped) skipped.push(entryName);
  }
  return skipped;
}

// The Socket.IO room backup:progress, restore:progress and restore:finished
// go to (server/index.js's CAPABILITY_ROOMS gates who may join it). They
// used to go to every connected socket, whatever its role, with raw error
// text that can quote host paths.
export const BACKUP_PROGRESS_ROOM = "backups";
// A bound on the scheduled backup's list of servers, far above any real one.
const BACKUP_SERVER_IDS_MAX = 100;

// SECURITY (2026-10-05, PATHS-1): backups read the world save under a
// server's Zomboid data folder and list, write, restore and delete in its
// backups/ folder, so that folder is held to the data-folder rule
// (services/zomboidDataPath.js) again here, where it is used: one saved
// before the rule existed, or one that didn't exist when it was saved and
// has appeared since, is refused -- never swapped for the legacy setting's
// or the panel's own folder.
//
// A remote server's data folder is on its own host, so none of it is here:
// no saves or backups folder resolves for one (getSavesPath() and
// _resolveServerDataBasePath() return null), not the legacy setting's or
// the panel's own either. Remote records skip the save-time rule for that
// reason, so passing them through here let servers.manage name any folder
// on this computer as a remote server's data folder and have backups create
// <folder>/backups and list, download and delete the .zip files in it.
function dataFolderUsable(server, dataPath) {
  if (server?.isRemote) return false;
  if (zomboidDataFolderHolds(dataPath)) return true;
  // PT5: once per folder at warn, then debug -- GET /status lands here up
  // to three times a call, and the Backups page polls it.
  logRefusalOnce(
    log,
    `Not using ${dataPath} for backups: ${describeRefusal(zomboidDataFolderRefusal())}`,
  );
  return false;
}

// The key two profiles' backups folders are compared by: the folder's real
// path when it exists (a junction, a symlink or a short 8.3 spelling leads to
// the same key), case-folded on Windows, where C:\PZ and c:\pz are one folder.
function backupsFolderKey(folder) {
  let resolved = path.resolve(String(folder));
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // Not there (yet): the path as written.
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// Every spelling a requested backup name is known by: as requested, and the
// name the file has on disk when that differs (a case variant, or a Windows
// 8.3 short name) and the file sits right in `backupsPath`.
function backupNameSpellings(name, backupsPath) {
  const spellings = [name];
  try {
    const real = fs.realpathSync.native(path.join(backupsPath, name));
    const onDisk = path.basename(real);
    if (
      onDisk !== name &&
      backupsFolderKey(path.dirname(real)) === backupsFolderKey(backupsPath)
    ) {
      spellings.push(onDisk);
    }
  } catch {
    // Not there: nothing else it could name.
  }
  return spellings;
}

function sameFolderPath(a, b) {
  const norm = (p) => {
    const resolved = path.resolve(String(p));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

// getSavesPath() runs on every Backups/Dashboard status poll, so a warning
// about the same unresolved or stood-in folder would repeat every few
// seconds: once per name per hour.
const SAVES_WARN_INTERVAL_MS = 60 * 60 * 1000;
const savesWarnedAt = new Map();
function warnSavesFolderOnce(key, message) {
  const now = Date.now();
  const last = savesWarnedAt.get(key);
  if (last !== undefined && now - last < SAVES_WARN_INTERVAL_MS) return;
  if (savesWarnedAt.size >= 200) savesWarnedAt.clear();
  savesWarnedAt.set(key, now);
  log.warn(message);
}

// The text routes/backup.js sends with BACKUP_REMOTE_NOT_AVAILABLE, for the
// scheduled backup job, which reaches createBackup() without the route.
const REMOTE_BACKUPS_MESSAGE =
  "Backups are not available for remote servers. The server filesystem is not accessible from this panel.";

export class BackupService {
  constructor() {
    this.backupInProgress = false;
    this.restoreInProgress = false;
    // The restore running right now and the one that ran last, as
    // restoreBackup() records them -- see that method's comment.
    this.currentRestore = null;
    this.lastRestore = null;
    this.lastBackup = null;
    this.backupHistory = [];
    this.discordBot = null;
    this.serverManager = null;
    this.rconService = null;
    this.scheduler = null;
  }

  /**
   * Get the saves folder path for the current server
   */

  setDiscordBot(discordBot) {
    this.discordBot = discordBot;
  }

  setServerManager(serverManager) {
    this.serverManager = serverManager;
  }

  // Read-only: restoreBackup() asks whether the server is up through the
  // shared resolveObservedServerRunning() verdict, which looks at RCON too.
  setRconService(rconService) {
    this.rconService = rconService;
  }

  // Read-only from here: only ever consulted for its .restartInProgress
  // flag (see createBackup()'s guard), never mutated through this
  // reference.
  setScheduler(scheduler) {
    this.scheduler = scheduler;
  }

  /**
   * The names of the other local server profiles that keep their data in the
   * same Zomboid data folder as `activeServer`, i.e. whose worlds sit beside
   * its own under Saves/Multiplayer. null when the profiles cannot be read:
   * then nothing can be ruled out.
   */
  async _otherProfileNamesInDataFolder(activeServer) {
    let allServers;
    try {
      allServers = await getServers();
    } catch (error) {
      log.warn(`Could not read the server profiles to attribute a save folder: ${error.message}`);
      return null;
    }
    const names = [];
    for (const other of allServers || []) {
      if (!other || other.isRemote) continue;
      if (String(other.id) === String(activeServer?.id ?? "")) continue;
      if (typeof other.serverName !== "string" || !other.serverName) continue;
      const otherBase = await this._resolveServerDataBasePath(other);
      if (otherBase && sameFolderPath(otherBase, activeServer.zomboidDataPath)) {
        names.push(other.serverName);
      }
    }
    return names;
  }

  /**
   * The folder under Saves/Multiplayer that stands in for a server's own
   * (missing) world folder, or null. Another server's world must never be
   * taken for it, because a backup would archive that world under this
   * server's name and a restore would replace it. So a folder qualifies only
   * when it is the only one that matches the server's name -- ignoring letter
   * case, then ignoring everything but letters and digits -- or the only
   * world folder there is, and in both cases no other server profile sharing
   * the data folder is named for it.
   */
  async _findSavesFolderStandIn(activeServer, baseSavesPath) {
    const name = activeServer.serverName;
    const folders = listWorldFolders(baseSavesPath);
    if (folders.length === 0) return null; // no Saves/Multiplayer yet, or no world in it

    const otherNames = await this._otherProfileNamesInDataFolder(activeServer);
    const ownedByAnother = (folder) =>
      otherNames === null || otherNames.some((other) => saveFolderBelongsToName(folder, other));
    const onlyUnowned = (candidates) =>
      candidates.length === 1 && !ownedByAnother(candidates[0]) ? candidates[0] : null;

    const sameIgnoringCase = onlyUnowned(
      folders.filter((f) => f.toLowerCase() === name.toLowerCase()),
    );
    if (sameIgnoringCase) return sameIgnoringCase;

    const key = saveFolderKey(name);
    const sameKey = key ? onlyUnowned(folders.filter((f) => saveFolderKey(f) === key)) : null;
    if (sameKey) {
      warnSavesFolderOnce(
        `${baseSavesPath}|${name}|${sameKey}`,
        `Save folder "${name}" not found; using "${sameKey}", the only folder with the same letters and digits`,
      );
      return sameKey;
    }

    const onlyFolder = folders.length === 1 ? onlyUnowned(folders) : null;
    if (onlyFolder) {
      warnSavesFolderOnce(
        `${baseSavesPath}|${name}|${onlyFolder}`,
        `Save folder "${name}" not found; using "${onlyFolder}", the only world folder and no other server profile is named for it`,
      );
      return onlyFolder;
    }

    const shown = folders.slice(0, 5).join(", ") + (folders.length > 5 ? ", ..." : "");
    warnSavesFolderOnce(
      `${baseSavesPath}|${name}|-`,
      `No save folder under ${baseSavesPath} can be attributed to server "${name}" (found: ${shown}); backups and restores will not use another server's world`,
    );
    return null;
  }

  /**
   * Get the saves folder path for the current server.
   *
   * lifecycle-lock-set sweep, 2026-09-07: `activeServerOverride` lets a
   * caller that already resolved getActiveServer() (createBackup(), which
   * also needs the same server for getBackupsPath() and the backup's
   * filename label) reuse that single fresh read instead of each callee
   * re-querying the DB independently -- a concurrent /servers/:id/activate
   * landing between three independent reads could otherwise put the
   * archive's DATA under one server's save folder while its FILENAME
   * labels a different server (Kevin's finding, backup-restore lane).
   * Every other existing caller (getStatus(), routes/backup.js's listing
   * routes, /wipe's pre-wipe backup path resolution) passes nothing, so
   * `activeServerOverride` stays `undefined` there and this falls back to
   * its own always-fresh read exactly as before -- byte-identical
   * behavior for every call site that isn't createBackup().
   */
  async getSavesPath(activeServerOverride) {
    /**
     * (getSavesPath starts here)
     */
    try {
      const activeServer =
        activeServerOverride !== undefined
          ? activeServerOverride
          : await getActiveServer();

      // PATHS-1: see dataFolderUsable() -- nothing of a remote server's is here.
      if (activeServer?.isRemote) return null;

      if (activeServer?.zomboidDataPath && activeServer?.serverName) {
        if (!dataFolderUsable(activeServer, activeServer.zomboidDataPath)) return null;
        const savesPath = path.join(
          activeServer.zomboidDataPath,
          "Saves",
          "Multiplayer",
          activeServer.serverName,
        );
        if (fs.existsSync(savesPath)) {
          return savesPath;
        }
        // The exact folder is not there. Another folder stands in for it
        // only when it can be attributed to THIS server (see
        // _findSavesFolderStandIn()); a guess here would back up, or worse
        // restore over, another server's world.
        const baseSavesPath = path.join(
          activeServer.zomboidDataPath,
          "Saves",
          "Multiplayer",
        );
        const standIn = await this._findSavesFolderStandIn(activeServer, baseSavesPath);
        if (standIn) {
          return path.join(baseSavesPath, standIn);
        }
        // No world of this server's yet (or none that can be told from
        // another's): the folder it will have. A backup then reports it
        // missing, and a restore creates it, instead of touching a
        // different server's folder.
        return savesPath;
      }

      // Fallback to legacy settings
      const zomboidDataPath = await getSetting("zomboidDataPath");
      const serverName = await getSetting("serverName");

      if (zomboidDataPath && serverName) {
        if (!dataFolderUsable(null, zomboidDataPath)) return null;
        return path.join(zomboidDataPath, "Saves", "Multiplayer", serverName);
      }

      return null;
    } catch (error) {
      log.error(`Failed to get saves path: ${error.message}`);
      return null;
    }
  }

  /**
   * Read-only resolution of the data directory a server's backups/ folder
   * lives under -- the same fallback chain getBackupsPath() below applies,
   * pulled out so cross-server ownership checks (see
   * _excludeOtherServersBackups()/_findForeignBackupOwner() further down)
   * can ask "where would THIS OTHER server's backups be" without also
   * getBackupsPath()'s own side effect of creating that directory on disk
   * for a server that may not even have any backups yet.
   */
  async _resolveServerDataBasePath(activeServerOverride) {
    const activeServer =
      activeServerOverride !== undefined
        ? activeServerOverride
        : await getActiveServer();

    // PATHS-1: see dataFolderUsable(). Also keeps a remote server from
    // falling through to the legacy setting's folder or the panel's own.
    if (activeServer?.isRemote) return null;

    if (activeServer?.zomboidDataPath) {
      return dataFolderUsable(activeServer, activeServer.zomboidDataPath)
        ? activeServer.zomboidDataPath
        : null;
    }

    const legacyPath = await getSetting("zomboidDataPath");
    if (legacyPath) return dataFolderUsable(null, legacyPath) ? legacyPath : null;

    // Use local backups folder as fallback
    const { getDataPaths } = await import("../utils/paths.js");
    return getDataPaths().dataDir;
  }

  /**
   * Get the backups folder path.
   *
   * `activeServerOverride` -- see getSavesPath()'s comment just above for
   * the full rationale; same optional-reuse parameter, same "every
   * existing caller passes nothing and keeps its own always-fresh read"
   * guarantee.
   *
   * SECURITY (2026-10-05, PT1): `create` -- only the callers about to write
   * a backup into the folder (createBackup(), the upload route) create it.
   * Every call used to, so GET /list and /status -- which only read --
   * created <data folder>/backups, and the data folder with it when it
   * didn't exist yet: a technician saved <folder>/Saves as a server's data
   * folder (missing, so accepted), opened Backups, and <folder> then had
   * the Saves folder the data-folder rule took as a sign of a real one.
   * The folder it creates in is one _resolveServerDataBasePath() held to
   * that rule, as before.
   */
  async getBackupsPath(activeServerOverride, { create = false } = {}) {
    try {
      const basePath = await this._resolveServerDataBasePath(activeServerOverride);
      if (!basePath) return null;
      const backupsPath = path.join(basePath, "backups");

      if (create && !fs.existsSync(backupsPath)) {
        fs.mkdirSync(backupsPath, { recursive: true });
      }

      return backupsPath;
    } catch (error) {
      log.error(`Failed to get backups path: ${error.message}`);
      return null;
    }
  }

  /**
   * Remove the restore staging folders (.restore-staging-*) that a restore
   * which failed hard, or was cut off by the panel stopping, left behind in
   * each local server's Saves/Multiplayer. Run at boot, where no restore can
   * be running; restoreBackup() also sweeps its own saves folder before it
   * extracts. Best effort, never throws.
   */
  async sweepRestoreStaging() {
    if (this.restoreInProgress) return;
    const parents = new Set();
    try {
      const savesPath = await this.getSavesPath();
      if (savesPath) parents.add(path.dirname(savesPath));
      for (const server of (await getServers()) || []) {
        if (!server || server.isRemote) continue;
        const base = await this._resolveServerDataBasePath(server);
        if (base) parents.add(path.join(base, "Saves", "Multiplayer"));
      }
    } catch (error) {
      log.debug(`Could not list the saves folders to sweep for restore leftovers: ${error.message}`);
    }
    for (const parent of parents) {
      try {
        sweepStaleRestoreStaging(parent);
      } catch (error) {
        log.debug(`Could not sweep ${parent} for restore leftovers: ${error.message}`);
      }
    }
  }

  // continuous-bug-hunt round 18 (backups and server ownership): unlike
  // Saves/Multiplayer/<serverName>, a server's backups/ folder is just
  // `<zomboidDataPath>/backups` -- no serverName segment in the PATH at
  // all, only encoded in each FILE's own name (`${serverName}_${timestamp}
  // .zip`, see createBackup() above). getBackupsPath() falls back to the
  // app-wide legacy `zomboidDataPath` setting (or PZ_SAVE_PATH via
  // routes/servers.js's own default) whenever a server profile doesn't
  // have its OWN zomboidDataPath configured -- a perfectly ordinary state
  // for a newly added second server profile, or any server never
  // individually pointed at its own data folder. When that happens, TWO
  // (or more) server profiles resolve to the exact SAME backups/ directory
  // with nothing anywhere checking which file belongs to which server --
  // every consumer (this list, cleanupOldBackups' automatic pruning,
  // restore, delete) previously treated every .zip sitting in that shared
  // folder as fair game, regardless of which server's name prefixed it.
  //
  // Deliberately narrow: only ever excludes something when a REAL
  // collision is detected against a server that is CURRENTLY configured
  // (fetched fresh, not cached) and genuinely resolves to this exact same
  // directory -- for the overwhelming normal case (every server has its
  // own distinct data path), every server in `others` fails the path
  // comparison and this returns its input completely unchanged, zero
  // behavior difference from before this fix. A backup is only ever
  // treated as "not mine" when attributeBackupFilename() (see its own
  // comment -- the WHOLE filename anchored against name + the exact
  // timestamp shape, longest matching name wins, never the active
  // server's own name) resolves it to a DIFFERENT, currently-existing,
  // currently-colliding server -- anything else (a legacy backup
  // predating multi-server support, one made before THIS server was
  // renamed, an uploaded archive, or simply a name matching no known
  // server) stays visible and prunable under this server: hiding or
  // permanently losing track of an ambiguous-but-possibly-real backup
  // would be a worse failure than this function occasionally
  // under-filtering.
  async _excludeOtherServersBackups(backups, backupsPath, activeServerOverride) {
    if (backups.length === 0) return backups;
    try {
      const activeServer =
        activeServerOverride !== undefined
          ? activeServerOverride
          : await getActiveServer();
      const allServers = await getServers();
      const others = allServers.filter(
        (s) => String(s.id) !== String(activeServer?.id ?? ""),
      );
      if (others.length === 0) return backups;

      const collidingOtherNames = new Set();
      const resolvedBackupsPath = backupsFolderKey(backupsPath);
      for (const other of others) {
        const otherBasePath = await this._resolveServerDataBasePath(other);
        if (!otherBasePath) continue;
        const otherBackupsPath = backupsFolderKey(path.join(otherBasePath, "backups"));
        if (
          otherBackupsPath === resolvedBackupsPath &&
          typeof other.serverName === "string" &&
          other.serverName
        ) {
          collidingOtherNames.add(other.serverName);
        }
      }
      if (collidingOtherNames.size === 0) return backups;

      const ownName =
        typeof activeServer?.serverName === "string" && activeServer.serverName
          ? activeServer.serverName
          : null;
      const candidates = ownName ? [ownName, ...collidingOtherNames] : [...collidingOtherNames];

      return backups.filter((b) => {
        const owner = attributeBackupFilename(b.name, candidates);
        if (owner && owner !== ownName) {
          log.warn(
            `Backup "${b.name}" sits in a backups folder shared with another server profile ("${owner}") -- excluded from this server's list/pruning`,
          );
          return false;
        }
        return true;
      });
    } catch (error) {
      log.warn(`Could not check for cross-server backup ownership: ${error.message}`);
      return backups; // fail open to the pre-fix behavior, not a blank list
    }
  }

  // Single-name variant of the check above, for the destructive single-file
  // operations (restore, delete) that don't go through listBackups() at
  // all. Returns the OTHER server's name if `name` belongs to it (a real,
  // currently-colliding server), else null -- including whenever
  // attributeBackupFilename() resolves it to the ACTIVE server's own name
  // instead, so this server's own file is never refused as foreign.
  async _findForeignBackupOwner(name, backupsPath, activeServerOverride) {
    try {
      const activeServer =
        activeServerOverride !== undefined
          ? activeServerOverride
          : await getActiveServer();
      const allServers = await getServers();
      const others = allServers.filter(
        (s) => String(s.id) !== String(activeServer?.id ?? ""),
      );
      if (others.length === 0) return null;

      const resolvedBackupsPath = backupsFolderKey(backupsPath);
      const collidingOtherNames = new Set();
      for (const other of others) {
        if (typeof other.serverName !== "string" || !other.serverName) continue;
        const otherBasePath = await this._resolveServerDataBasePath(other);
        if (!otherBasePath) continue;
        const otherBackupsPath = backupsFolderKey(path.join(otherBasePath, "backups"));
        if (otherBackupsPath === resolvedBackupsPath) {
          collidingOtherNames.add(other.serverName);
        }
      }
      if (collidingOtherNames.size === 0) return null;

      const ownName =
        typeof activeServer?.serverName === "string" && activeServer.serverName
          ? activeServer.serverName
          : null;
      const candidates = ownName ? [ownName, ...collidingOtherNames] : [...collidingOtherNames];

      // Windows (and macOS) ignore case in file names, and Windows also opens
      // a file by its 8.3 short name: "serverb_2026-...t...zip" or
      // "SERVER~1.ZIP" reaches ServerB's archive while matching no pattern.
      // The name the file really has is attributed too.
      for (const spelling of backupNameSpellings(name, backupsPath)) {
        const owner = attributeBackupFilename(spelling, candidates);
        if (owner && owner !== ownName) return owner;
      }
      return null;
    } catch (error) {
      log.warn(`Could not check backup ownership for ${name}: ${error.message}`);
      return null; // fail open, same posture as _excludeOtherServersBackups
    }
  }

  /**
   * Get backup settings
   */
  async getSettings() {
    const enabled = (await getSetting("backupEnabled")) ?? false;
    const schedule = (await getSetting("backupSchedule")) ?? "0 */6 * * *"; // Every 6 hours
    const maxBackups = (await getSetting("backupMaxCount")) ?? 10;
    const includeDb = (await getSetting("backupIncludeDb")) ?? false;
    // The servers the schedule backs up (the Dashboard's list of servers);
    // null until someone chooses, which means the active server alone.
    const storedServerIds = await getSetting("backupServerIds");
    const serverIds = Array.isArray(storedServerIds) ? storedServerIds.map(String) : null;

    return { enabled, schedule, maxBackups, includeDb, serverIds };
  }

  /**
   * Update backup settings
   */
  async updateSettings(settings) {
    if (
      settings.enabled !== undefined &&
      typeof settings.enabled !== "boolean"
    ) {
      throw new Error("enabled must be a boolean");
    }
    if (
      settings.maxBackups !== undefined &&
      (!Number.isInteger(settings.maxBackups) ||
        settings.maxBackups < 1 ||
        settings.maxBackups > 100)
    ) {
      throw new Error("maxBackups must be an integer between 1 and 100");
    }
    if (
      settings.includeDb !== undefined &&
      typeof settings.includeDb !== "boolean"
    ) {
      throw new Error("includeDb must be a boolean");
    }
    if (
      settings.schedule !== undefined &&
      (!isSupportedFiveFieldCron(settings.schedule) ||
        isCronTooFrequent(settings.schedule))
    ) {
      throw new Error(
        "Invalid backup schedule. Use exactly 5 cron fields and no more than one run every 5 minutes.",
      );
    }
    if (settings.enabled !== undefined) {
      await setSetting("backupEnabled", settings.enabled);
    }
    if (settings.schedule !== undefined) {
      await setSetting("backupSchedule", settings.schedule);
    }
    if (settings.maxBackups !== undefined) {
      await setSetting("backupMaxCount", settings.maxBackups);
    }
    if (settings.includeDb !== undefined) {
      await setSetting("backupIncludeDb", settings.includeDb);
    }
    if (settings.serverIds !== undefined) {
      if (
        !Array.isArray(settings.serverIds) ||
        settings.serverIds.length > BACKUP_SERVER_IDS_MAX ||
        !settings.serverIds.every(
          (id) =>
            (typeof id === "string" && id.trim() !== "" && id.length <= 100) ||
            Number.isSafeInteger(id),
        )
      ) {
        throw new Error(`serverIds must be a list of up to ${BACKUP_SERVER_IDS_MAX} server ids`);
      }
      await setSetting(
        "backupServerIds",
        [...new Set(settings.serverIds.map((id) => String(id).trim()))],
      );
    }

    return this.getSettings();
  }

  /**
   * Create a backup of the server world
   */
  async createBackup(options = {}) {
    if (this.backupInProgress) {
      return { success: false, message: "Backup already in progress" };
    }
    // restoreBackup() already refuses a new restore (and an independent
    // createBackup() call) while ITS OWN restoreInProgress is set -- see the
    // `if (this.backupInProgress)` check near the top of restoreBackup()
    // below. That guard only ever ran in one direction: a backup could
    // still start while a restore was mid-swap (savesPath renamed out, then
    // the extracted world renamed in), reading some files from the world
    // being replaced and some from its replacement under the same relative
    // names, silently. `options.isPreRestore` is the same flag
    // restoreBackup() already passes on its OWN internal pre-restore
    // createBackup() call (see the call site below) -- it must be exempted
    // here, or every restore with createPreRestoreBackup !== false would
    // refuse its own mandatory pre-restore backup the instant this check
    // was added.
    if (this.restoreInProgress && !options.isPreRestore) {
      return { success: false, message: "Restore in progress, please wait" };
    }

    // continuous-bug-hunt, 2026-09-18 (backup-integrity round): scheduler.js's
    // own scheduled-backup cron job already refuses to fire while
    // this.scheduler.restartInProgress is true (see its comment: a restart's
    // warning countdown + RCON save + quit + relaunch all mutate savesPath
    // for potentially minutes, so a backup taken mid-restart can archive a
    // save mid-write -- "a corrupt or inconsistent snapshot that looks like
    // a normal backup until someone tries to restore it"). That check lived
    // ONLY in the scheduler's cron callback, one caller out of several --
    // routes/backup.js's POST /create (manual "Create Backup Now") and any
    // other direct caller of createBackup() had no such check at all and
    // would archive the same mid-write state, reporting success:true with an
    // empty skippedFiles (a torn save isn't a vanished file -- nothing here
    // would ever notice). Centralized here instead of duplicated at every
    // call site, the same way restoreInProgress already is. No isPreRestore-
    // style exemption needed: unlike restoreBackup(), nothing in
    // performRestart() ever calls createBackup() itself, so there is no
    // legitimate caller this would wrongly refuse.
    if (this.scheduler?.restartInProgress) {
      return { success: false, message: "A server restart is in progress, please wait" };
    }

    this.backupInProgress = true;
    const startTime = Date.now();
    const io = options.io; // Socket.IO for progress updates

    // Helper to emit progress. The message goes through sanitizeError()
    // here, once, rather than at each call site: several pass a raw
    // err.message, which can quote the save or backup folder.
    const emitProgress = (phase, percent, message, extra = {}) => {
      if (io) {
        io.to(BACKUP_PROGRESS_ROOM).emit("backup:progress", {
          phase,
          percent,
          message: sanitizeError(message),
          ...extra,
        });
      }
    };

    // Wrap in try-finally to ensure mutex is always released
    try {
      return await this._doCreateBackup(options, startTime, emitProgress);
    } catch (error) {
      log.error(`Backup failed: ${error.message}`);
      emitProgress(
        "error",
        0,
        `Backup failed: ${sanitizeError(error.message)}`,
      );
      return {
        success: false,
        message: sanitizeError(error.message),
        ...(error.errorCode ? { code: error.errorCode } : {}),
        ...(error.errorParams ? { params: error.errorParams } : {}),
      };
    } finally {
      this.backupInProgress = false;
    }
  }

  /**
   * Internal backup implementation
   */
  async _doCreateBackup(options, startTime, emitProgress) {
    emitProgress("preparing", 5, "Preparing backup...");

    // lifecycle-lock-set sweep, 2026-09-07 (Kevin's finding, backup-restore
    // lane): POST /create takes no lifecycle lock, so a concurrent
    // /servers/:id/activate could switch the active server between
    // separate reads. One fresh read here, reused for the saves path, the
    // backups path, the filename label, and the snapshot below, so all
    // four agree on which server this backup is actually of -- restore's
    // own two getActiveServer() calls (restoreBackup(), further down) stay
    // as they are: restore holds the lifecycle lock for its whole
    // duration, and /servers/:id/activate takes that same lock, so the
    // active server provably cannot change under restore already.
    //
    // `options.server`: a server other than the active one -- the scheduled
    // backup of each chosen server (scheduler.js's _runScheduledBackup()).
    // Everything below reads it the way it reads the active server, except
    // that it leaves this.lastBackup (the active server's "Last backup") and
    // the Discord notice, whose text names no server, alone.
    const currentActive = await getActiveServer();
    const activeServer = options.server ?? currentActive;
    const backsUpActiveServer =
      !options.server || String(options.server.id) === String(currentActive?.id);
    if (activeServer?.isRemote) {
      throw new Error(REMOTE_BACKUPS_MESSAGE);
    }
    const dataPath =
      activeServer?.zomboidDataPath || (await getSetting("zomboidDataPath"));
    if (dataPath && !dataFolderUsable(activeServer, dataPath)) {
      throw new Error(zomboidDataFolderRefusal().error);
    }
    const savesPath = await this.getSavesPath(activeServer);

    if (!savesPath) {
      throw new Error(
        "Could not determine saves folder path. Please configure the server first.",
      );
    }

    if (!fs.existsSync(savesPath)) {
      const notFound = new Error(`Saves folder not found: ${savesPath}`);
      notFound.errorCode = ErrorCode.BACKUP_SAVES_FOLDER_NOT_FOUND;
      throw notFound;
    }

    // PT1: created only now, with a world save there to write into it.
    const backupsPath = await this.getBackupsPath(activeServer, { create: true });
    if (!backupsPath) {
      throw new Error("Could not determine backups folder path");
    }

    // Generate backup filename with timestamp
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 23);
    const serverName = activeServer?.serverName || "server";
    // A safety copy taken right before a restore or a wipe is named for what
    // it is (pre-restore-/pre-wipe-), so retention can leave it alone: with
    // backupMaxCount=1 the next scheduled backup used to delete the copy of
    // the world that had just been replaced. See backupNames.js.
    const baseBackupName = `${safetyBackupPrefix(options)}${serverName}_${timestamp}`;
    let backupName = `${baseBackupName}.zip`;
    let backupPath = path.join(backupsPath, backupName);
    // 2026-09-09 (Kevin's cross-ring sweep, timestamp-tie-breaks): starting
    // at 1 made the FIRST collision produce "-1.zip" -- the exact same
    // suffix backupSortKey() (above) already implies for an unsuffixed
    // original (`suffix: match[2] ? ... : 1`). On a real same-millisecond
    // collision the original and its first collision then carry an
    // IDENTICAL sort key, listBackups()'s sort can't tell them apart, and
    // the stable sort falls back to readdir() order -- unrelated to
    // creation order -- which cleanupOldBackups()'s .slice(maxBackups)
    // deletion and `this.lastBackup = backups[0]` both trust completely.
    // Starting at 2 instead matches every sibling ring's identical
    // convention (database/init.js, utils/configBackup.js, index.js's
    // player-export rotation) -- an unsuffixed original and a first
    // collision can never collapse to one key.
    let collision = 2;
    while (fs.existsSync(backupPath)) {
      backupName = `${baseBackupName}-${collision}.zip`;
      backupPath = path.join(backupsPath, backupName);
      collision++;
    }
    // Write under a name listBackups() won't match (it only lists *.zip), and
    // rename into place only after the archive closes successfully -- writing
    // straight to backupPath meant a process kill mid-archive left a
    // truncated file at the real, listed filename, indistinguishable in the
    // UI from a real backup until someone tried to restore it.
    const tempBackupPath = `${backupPath}.tmp`;
    cleanupOrphanBackupTemps(backupsPath);
    const serverSnapshot = captureBackupSnapshot(activeServer);

    log.info(`Starting backup: ${backupName}`);
    log.info(`Source: ${savesPath}`);
    log.info(`Destination: ${backupPath}`);

    emitProgress("preparing", 10, "Scanning files...");

    // Count total files for progress without materializing directory listings,
    // and add up their sizes for the free-space check below (null when the
    // walk fails: then the check has nothing to compare and does not block).
    let totalFiles = 0;
    let sourceBytes = null;

    try {
      const measured = await measureFolder(savesPath);
      totalFiles = measured.files;
      sourceBytes = measured.bytes;
    } catch (err) {
      log.warn(`Failed to count files: ${err.message}`);
      totalFiles = 1000; // Fallback estimate
    }

    // SECURITY (2026-10-20, access-control audit): whether the panel
    // database goes in is the stored setting's decision alone, never the
    // caller's -- POST /backup/create used to pass its request body through,
    // so any backups.manage holder could add it with {"includeDb":true}. The
    // safety copies taken before a restore or a wipe leave it out, as they
    // always have. And what goes in is a redacted copy (utils/
    // panelDbRedaction.js): no password hashes, sessions or other secrets,
    // since a backup leaves the machine with backups.download.
    const includeDb =
      !options.isPreRestore &&
      !options.isPreWipe &&
      (await this.getSettings()).includeDb === true;
    const skippedFiles = [];
    let redactedDbJson = null;
    if (includeDb) {
      // Same defect class as database/init.js's createDatabaseBackup() (fixed
      // alongside this, 2026-09-05 backup-restore-round-trip hunt): db.json
      // writes are debounced (up to WRITE_DEBOUNCE_MS=500ms, longer under
      // retry backoff) and this archives whatever is CURRENTLY ON DISK --
      // without flushing first, a world backup taken right after a settings/
      // server/role change can silently ship a db.json missing that change.
      await flushWrites();
      const { getDataPaths } = await import("../utils/paths.js");
      const dbPath = getDataPaths().dbPath;
      if (fs.existsSync(dbPath)) {
        try {
          const parsed = JSON.parse(await fs.promises.readFile(dbPath, "utf-8"));
          redactedDbJson = JSON.stringify(redactPanelDbForBackup(parsed), null, 2);
          totalFiles++;
          if (sourceBytes !== null) sourceBytes += Buffer.byteLength(redactedDbJson);
        } catch (error) {
          // Never the raw file instead: reported like any other skip.
          log.warn(`Panel database left out of the backup: ${error.message}`);
          skippedFiles.push("db.json");
        }
      }
    }

    // Backups are written under <data folder>/backups, on the same volume as
    // the live world: one that does not fit fails part-way after minutes of
    // archiving and, worse, fills the disk the running game saves to. Refuse
    // a clear shortfall now, with the numbers. For a routine backup that has
    // reached its count, the oldest backup retention would delete after this
    // one is made is deleted first when that frees enough.
    await this._ensureSpaceForBackup({
      backupsPath,
      sourceBytes,
      safetyCopy: Boolean(options.isPreRestore || options.isPreWipe),
      activeServer,
    });

    emitProgress("archiving", 15, `Found ${totalFiles} files to backup...`, {
      totalFiles,
    });

    // Create zip archive
    const output = createWriteStream(tempBackupPath);
    const archive = new StreamingBackupArchive(tempBackupPath, output, { level: 6 });

    let filesProcessed = 0;
    // Every archive addition (saves-folder walk, the snapshot, db.json) goes
    // through waitForArchiveEntry, so skippedFiles (declared above, where an
    // unreadable db.json is already counted) collects every skip precisely --
    // not a sampled backstop, the complete account.

    return new Promise((resolve, reject) => {
      // Set by the FIRST failure on the output stream, the archive or the
      // append loop. A write error (a full disk, an I/O error) fires 'error'
      // and then 'close' on the output stream, and 'close' used to carry on as
      // if the archive had been written: it renamed the truncated .zip.tmp to
      // a real .zip, saved a record, logged backup_created, sent the Discord
      // "backup complete" and ran retention, which deleted the last good
      // backup in favour of the truncated one (probe: ENOSPC with
      // backupMaxCount=1). Everything after the archive is written is skipped
      // once this is set.
      let failed = false;

      // Track progress during archiving
      archive.on("entry", (entry) => {
        if (failed) return;
        filesProcessed++;
        const percent = Math.min(
          15 + Math.round((filesProcessed / totalFiles) * 75),
          90,
        );
        if (filesProcessed % 50 === 0 || filesProcessed === totalFiles) {
          emitProgress(
            "archiving",
            percent,
            `Archiving files... (${filesProcessed}/${totalFiles})`,
            {
              filesProcessed,
              totalFiles,
              currentFile: entry.name,
            },
          );
        }
      });

      // Best-effort: remove whatever partial bytes made it to disk so a
      // failed run doesn't leave a stray .tmp file behind. Not the listed
      // backup name (already excluded by listBackups()'s .zip filter), so
      // this is cleanliness, not the safety property -- that's the rename.
      // Retries because an antivirus scan or the search indexer can hold the
      // file for a moment right after its handle closes.
      const removeTemp = async () => {
        try {
          await fs.promises.rm(tempBackupPath, {
            force: true,
            maxRetries: 3,
            retryDelay: 100,
          });
        } catch (cleanupErr) {
          log.warn(
            `Could not remove incomplete backup file ${tempBackupPath}: ${cleanupErr.message}`,
          );
        }
      };

      // Closes the output stream (a no-op when it is already closed) and
      // waits for its handle to be released, so the partial file can be
      // deleted. The timeout is only a backstop for a stream that never
      // reports 'close'.
      const releaseOutput = () =>
        new Promise((released) => {
          if (output.closed) {
            released();
            return;
          }
          const timer = setTimeout(released, 2000);
          timer.unref?.();
          output.once("close", () => {
            clearTimeout(timer);
            released();
          });
          output.destroy();
        });

      // The one failure path: output stream error, archive error or warning,
      // the append loop throwing, or the final rename giving up. Only the
      // first call acts. It stops the archive (so nothing keeps reading the
      // world, and anything awaiting an entry is released with the error),
      // and rejects once the partial file is gone.
      const fail = (error, progressMessage) => {
        if (failed) return;
        failed = true;
        emitProgress("error", 0, progressMessage ?? `Backup failed: ${error.message}`);
        try {
          archive.abort();
        } catch {
          /* already finalized or aborted */
        }
        try {
          archive.destroy(error);
        } catch {
          /* already destroyed */
        }
        void releaseOutput()
          .then(removeTemp)
          .then(() => reject(error));
      };

      const finish = async () => {
        await archive.settled();
        emitProgress("finalizing", 95, "Finalizing backup...");

        // Only now, with the archive fully written and closed, does it become
        // the real backup. Anything that dies before this line leaves nothing
        // but an already-excluded .tmp file behind. A lock on the finished
        // file (antivirus, the search indexer) is waited out briefly; a
        // rename that still fails removes the temp file instead of leaving a
        // whole backup-sized .zip.tmp behind.
        try {
          await renameWithRetry(tempBackupPath, backupPath, {
            onRetry: (renameError, attempt) =>
              log.warn(
                `Could not move ${backupName} into place (${renameError.code}), retrying (attempt ${attempt})`,
              ),
          });
        } catch (renameError) {
          fail(renameError, `Backup failed: ${renameError.message}`);
          return;
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        const sizeBytes = archive.pointer();
        const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);

        if (skippedFiles.length > 0) {
          // "vanished during archiving" until 2026-08-29 -- no longer
          // accurate now that a deliberately-excluded symbolic link also
          // lands in this same array (see walkDirectory's own comment);
          // kept cause-agnostic since both reasons already get identical
          // treatment by every consumer of skippedFiles.
          log.warn(
            `Backup ${backupName} completed but ${skippedFiles.length} file(s) could not be included: ${skippedFiles.join(", ")}`,
          );
        } else {
          log.info(
            `Backup completed: ${backupName} (${sizeMB} MB) in ${duration}s`,
          );
        }

        const created = {
          name: backupName,
          path: backupPath,
          size: sizeBytes,
          created: new Date().toISOString(),
        };
        if (backsUpActiveServer) this.lastBackup = created;

        try {
          await addBackupRecord({
            backup: created,
            server: activeServer,
            snapshot: serverSnapshot,
          });
        } catch (error) {
          log.warn(`Backup record could not be saved for ${backupName}: ${error.message}`);
        }

        try {
          await logServerEvent("backup_created", `${backupName} (${sizeMB} MB)`, {
            serverId: activeServer?.id ?? null,
          });
        } catch (error) {
          log.warn(
            `Backup event could not be logged for ${backupName}: ${error.message}`,
          );
        }

        // Clean up old backups -- but NEVER as part of a pre-restore or
        // pre-wipe safety backup. bug hunt 2026-09-05 (backup-restore-
        // round-trip sweep, item #1): this used to run unconditionally,
        // "including the mandatory pre-wipe and pre-restore ones" per the
        // comment that used to be here -- which meant restoring your OLDEST
        // backup (an entirely ordinary thing to do) could have its own
        // pre-restore backup push the count over maxBackups, prune the
        // oldest survivor, and delete the very archive restoreBackup() was
        // about to read from a few lines later. Reproduced directly:
        // maxBackups=1, one existing backup, restore it with the default
        // createPreRestoreBackup:true -- the prune deletes it and the
        // restore then fails with ENOENT reading its own source archive.
        // Deferring retention to the next ROUTINE backup costs nothing (the
        // panel is never long without one) and removes the interaction
        // entirely, rather than trying to special-case "protect this one
        // filename from this one prune pass".
        //
        // cleanupOldBackups() already has its own full internal try/catch
        // and cannot reject today -- but this caller must not depend on
        // that staying true forever: an unguarded reject here would be an
        // unhandledRejection -> fatalExit() panel kill sitting directly
        // downstream of every destructive operation in the app (2026-08-26,
        // same class as the install setSetting crash). Retention
        // housekeeping failing does NOT mean the backup failed -- log and
        // continue, never flip the backup result or abort whatever
        // destructive step is waiting on it.
        if (!options.isPreRestore && !options.isPreWipe) {
          try {
            await this.cleanupOldBackups(activeServer);
          } catch (cleanupError) {
            log.warn(`Backup retention cleanup failed for ${backupName}: ${cleanupError.message}`);
          }
        }

        emitProgress(
          "complete",
          100,
          `Backup complete! (${sizeMB} MB in ${duration}s)`,
        );

        // Notify Discord of completed backup
        if (this.discordBot && backsUpActiveServer) {
          this.discordBot
            .sendEventNotification("backupComplete", {})
            .catch((err) =>
              log.debug(
                `Discord backupComplete notification failed: ${err.message}`,
              ),
            );
        }

        // Surfaced, not decided here: the transition (write + rename) really
        // did succeed, so success stays true -- but WHETHER a skip is
        // acceptable depends on why this backup was taken, which only the
        // caller knows. A routine/scheduled backup tolerates skips and
        // reports them; a backup taken immediately before a destructive
        // operation (restoreBackup's pre-restore backup, /wipe's pre-wipe
        // backup) is about to become the only copy and must treat any skip
        // as a failure. That policy lives at those call sites, not here.
        resolve({
          success: true,
          backup: created,
          duration: parseFloat(duration),
          skippedFiles,
        });
      };

      output.on("close", () => {
        // A failed backup is already being torn down by fail(): its partial
        // file is removed there, and none of the success steps in finish()
        // (rename, record, event, retention, Discord) may run for it.
        if (failed) return;
        // 'close' normally follows 'error', but do not rely on the order.
        const streamError = output.errored || archive.errored;
        if (streamError) {
          fail(streamError);
          return;
        }
        finish().catch((error) => fail(error));
      });

      output.on("error", (err) => {
        fail(err, `Backup failed: ${err.message}`);
      });

      archive.on("error", (err) => {
        fail(err, `Archive error: ${err.message}`);
      });

      archive.on("warning", (err) => {
        if (err.code === "ENOENT") {
          log.warn(`Backup warning: ${err.message}`);
        } else {
          fail(err, `Archive error: ${err.message}`);
        }
      });

      const appendBackupContents = async () => {
        try {
          const skippedSaves = await appendDirectoryToArchive(
            archive,
            savesPath,
            path.basename(savesPath),
          );
          skippedFiles.push(...skippedSaves);

          const snapshotResult = await waitForArchiveEntry(archive, () =>
            archive.append(JSON.stringify(serverSnapshot, null, 2), {
              name: "panel-server-snapshot.json",
            }),
          );
          if (snapshotResult.skipped) skippedFiles.push("panel-server-snapshot.json");

          if (redactedDbJson !== null) {
            const dbResult = await waitForArchiveEntry(archive, () =>
              archive.append(redactedDbJson, { name: "db.json" }),
            );
            if (dbResult.skipped) skippedFiles.push("db.json");
          }

          await archive.finalize();
        } catch (error) {
          fail(error);
        }
      };

      void appendBackupContents();
    });
  }

  /**
   * Refuses (throws BACKUP_INSUFFICIENT_DISK_SPACE) a backup whose archive is
   * estimated not to fit in the free space on the backups folder's volume.
   * An unknown world size or an unreadable free-space figure never blocks.
   *
   * `safetyCopy` -- the pre-restore / pre-wipe backup: never frees room by
   * deleting other backups, since the operator is about to lose the world it
   * protects, and those copies are exactly what retention keeps.
   */
  async _ensureSpaceForBackup({ backupsPath, sourceBytes, safetyCopy, activeServer }) {
    let needed = null;
    let free = null;
    let backups = [];
    try {
      if (!Number.isFinite(sourceBytes) || sourceBytes <= 0) return;
      free = await freeBytesAt(backupsPath);
      if (free === null) return;
      backups = await this.listBackups(activeServer);
      // The newest archive is the best guide to the next one's size; an
      // upload came from somewhere else and says nothing about this world.
      const previous = backups.find((b) => !b.name.startsWith("uploaded-"));
      needed = estimateArchiveBytes(sourceBytes, previous?.size);
    } catch (error) {
      log.debug(`Free-space check skipped: ${error.message}`);
      return;
    }
    if (needed === null || free >= needed) return;

    if (!safetyCopy) {
      const freeAfterPrune = await this._pruneOldestToFit({
        backups,
        needed,
        free,
        backupsPath,
        activeServer,
      });
      if (freeAfterPrune >= needed) return;
      free = freeAfterPrune;
    }
    log.warn(
      `Backup refused: about ${formatBytes(needed)} needed, ${formatBytes(free)} free on the backups drive`,
    );
    throw insufficientSpaceError(needed, free);
  }

  /**
   * Makes room for the next backup by deleting the oldest backups that
   * retention would delete once it exists (the ones beyond backupMaxCount - 1
   * of the prunable list, so retention math is unchanged, but always sparing
   * the newest one), oldest first, but only when that frees enough: a backup
   * is never deleted for a new one that would still not fit. Uploads and the
   * pre-restore / pre-wipe safety copies are never touched. Returns the free bytes afterwards (unchanged when
   * nothing was deleted).
   */
  async _pruneOldestToFit({ backups, needed, free, backupsPath, activeServer }) {
    try {
      const settings = await this.getSettings();
      const ownServerName = await this._ownServerName(activeServer);
      const prunable = backups.filter(
        (b) => !b.name.startsWith("uploaded-") && !isSafetyBackupName(b.name, ownServerName),
      );
      // newest first: what retention will delete after this backup is made.
      // Never the newest remaining one, even with backupMaxCount=1: its
      // replacement does not exist yet, and if the new archive then fails
      // that would leave no backup at all. With a count of 1 the backup is
      // refused for lack of space instead.
      const deletable = prunable.slice(Math.max(settings.maxBackups - 1, 1));
      const reclaimable = deletable.reduce((sum, b) => sum + (b.size || 0), 0);
      if (deletable.length === 0 || free + reclaimable < needed) return free;

      let freed = 0;
      for (const backup of [...deletable].reverse()) {
        if (free + freed >= needed) break;
        const deleted = await this.deleteBackup(backup.name, activeServer);
        if (!deleted?.success) {
          log.warn(
            `Could not remove ${backup.name} to make room for a backup: ${deleted?.message || "unknown error"}`,
          );
          continue;
        }
        freed += backup.size || 0;
        log.warn(
          `Not enough free disk space for the next backup: removed the oldest backup ${backup.name} ahead of retention (it would be removed once the new backup exists)`,
        );
      }
      const measured = await freeBytesAt(backupsPath);
      return measured !== null ? measured : free + freed;
    } catch (error) {
      log.warn(`Could not make room for a backup: ${error.message}`);
      return free;
    }
  }

  /**
   * Refuses a restore whose extraction (plus, unless skipped, its pre-restore
   * safety backup) is estimated not to fit. The extracted world is staged next
   * to the live one on the saves volume, the safety backup goes to the backups
   * folder; when both are on one volume their needs add up. Unknown sizes or
   * free space never block.
   */
  async _ensureSpaceForRestore({ backupPath, savesPath, backupsPath, withSafetyBackup }) {
    let stagingBytes = 0;
    let safetyBytes = 0;
    let savesFree = null;
    let backupsFree = null;
    try {
      try {
        const unzip = await getUnzipper();
        const archive = await unzip.Open.file(backupPath);
        stagingBytes = archive.files.reduce(
          (sum, file) =>
            file.type === "File" && Number.isFinite(file.uncompressedSize)
              ? sum + file.uncompressedSize
              : sum,
          0,
        );
      } catch {
        // An unreadable archive is reported by the extraction itself.
      }
      if (withSafetyBackup && fs.existsSync(savesPath)) {
        const measured = await measureFolder(savesPath);
        const previous = (await this.listBackups()).find((b) => !b.name.startsWith("uploaded-"));
        safetyBytes = estimateArchiveBytes(measured.bytes, previous?.size) ?? 0;
      }
      if (stagingBytes <= 0 && safetyBytes <= 0) return;
      savesFree = await freeBytesAt(path.dirname(savesPath));
      backupsFree = await freeBytesAt(backupsPath);
    } catch (error) {
      log.debug(`Restore free-space check skipped: ${error.message}`);
      return;
    }

    const shortfalls = [];
    if (onSameVolume(path.dirname(savesPath), backupsPath)) {
      const free = savesFree ?? backupsFree;
      if (free !== null) shortfalls.push({ needed: stagingBytes + safetyBytes, free });
    } else {
      if (savesFree !== null) shortfalls.push({ needed: stagingBytes, free: savesFree });
      if (backupsFree !== null) shortfalls.push({ needed: safetyBytes, free: backupsFree });
    }
    const short = shortfalls.find(({ needed, free }) => needed > 0 && free < needed);
    if (short) {
      log.warn(
        `Restore refused: about ${formatBytes(short.needed)} needed (extracted world${withSafetyBackup ? " plus the safety backup" : ""}), ${formatBytes(short.free)} free`,
      );
      throw insufficientSpaceError(short.needed, short.free);
    }
  }

  /**
   * Get list of existing backups.
   *
   * `activeServerOverride` -- see getSavesPath()'s comment; same optional
   * reuse parameter, threaded through to getBackupsPath() so
   * cleanupOldBackups() (called right after a createBackup() completes)
   * lists the SAME server's backups folder the backup just created, not a
   * freshly re-derived one a concurrent activate() could have switched.
   * Every other existing caller (routes/backup.js's listing route, etc.)
   * passes nothing and keeps its own always-fresh read.
   */
  async listBackups(activeServerOverride) {
    try {
      const backupsPath = await this.getBackupsPath(activeServerOverride);
      if (!backupsPath || !fs.existsSync(backupsPath)) {
        return [];
      }

      const files = await fs.promises.readdir(backupsPath);

      const backups = (
        await Promise.all(
          files
            .filter((f) => f.endsWith(".zip"))
            .map(async (f) => {
              try {
                const filePath = path.join(backupsPath, f);
                const stats = await fs.promises.stat(filePath);
                return {
                  name: f,
                  path: filePath,
                  size: stats.size,
                  created: stats.birthtime.toISOString(),
                  sortKey: backupSortKey(f, stats),
                };
              } catch (e) {
                return null;
              }
            }),
        )
      ).filter((b) => b !== null);

      const owned = await this._excludeOtherServersBackups(
        backups,
        backupsPath,
        activeServerOverride,
      );

      return owned
        .sort((a, b) => {
          if (a.sortKey.key !== b.sortKey.key) {
            return a.sortKey.key < b.sortKey.key ? 1 : -1; // newest first
          }
          return b.sortKey.suffix - a.sortKey.suffix; // higher collision suffix = created later
        })
        .map(({ sortKey: _sortKey, ...backup }) => backup); // internal-only, don't leak the key
    } catch (error) {
      log.error(`Failed to list backups: ${error.message}`);
      return [];
    }
  }

  async getBackupSnapshot(backupName) {
    const backupsPath = await this.getBackupsPath();
    const safeName = path.basename(backupName);
    // LOAD-BEARING for traversal safety, not just a format check: neither
    // "." nor ".." ends in ".zip", so this incidentally rejects both even
    // though safeName is never compared back to backupName itself (the
    // check every OTHER basename-sanitized route in this codebase uses).
    // Do not relax or remove the .zip requirement without adding that
    // explicit "." / ".." rejection first.
    if (!backupsPath || !safeName.endsWith(".zip")) {
      return { success: false, message: "Invalid backup file" };
    }

    const backupPath = path.join(backupsPath, safeName);
    if (!fs.existsSync(backupPath)) {
      return { success: false, message: "Backup not found" };
    }

    // round 19 (backup-read-paths-ownership): the write/destructive paths
    // (deleteBackup, restoreBackup) already refuse a name that identifies
    // another currently-colliding server's own backup -- see
    // _findForeignBackupOwner()'s own comment -- but this READ path never
    // checked at all, so an operator of one server could read the panel
    // snapshot embedded inside another server's backup archive just by
    // knowing (or guessing, from the predictable `${serverName}_${timestamp}
    // .zip` naming) its filename.
    const foreignOwner = await this._findForeignBackupOwner(safeName, backupsPath);
    if (foreignOwner) {
      return {
        success: false,
        message: `This backup belongs to another server profile ("${foreignOwner}") that shares this backups folder -- refusing to read it here.`,
      };
    }

    try {
      const unzip = await getUnzipper();
      const raw = await readZipEntryCapped(
        unzip,
        backupPath,
        "panel-server-snapshot.json",
        SNAPSHOT_MAX_BYTES,
      );
      if (!raw) {
        return { success: false, message: "This backup has no panel snapshot" };
      }
      const snapshot = JSON.parse(raw.toString("utf-8"));
      return { success: true, snapshot };
    } catch (error) {
      if (error.code === ZIP_ENTRY_TOO_LARGE) {
        log.warn(`Backup snapshot in ${safeName} is larger than ${formatBytes(SNAPSHOT_MAX_BYTES)}: not read`);
        return {
          success: false,
          message: `This backup's panel snapshot is larger than ${formatBytes(SNAPSHOT_MAX_BYTES)}, so it was not read.`,
          code: ErrorCode.BACKUP_SNAPSHOT_TOO_LARGE,
        };
      }
      log.warn(`Could not read backup snapshot from ${safeName}: ${error.message}`);
      return { success: false, message: "Could not read backup snapshot" };
    }
  }

  // The active server's own name, for telling its ordinary backups from
  // safety copies (see isSafetyBackupName()). null when it cannot be read.
  async _ownServerName(activeServerOverride) {
    try {
      const server =
        activeServerOverride !== undefined
          ? activeServerOverride
          : await getActiveServer();
      return typeof server?.serverName === "string" && server.serverName
        ? server.serverName
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Delete a backup
   */
  // `activeServerOverride`: the server whose backups folder holds it, for the
  // retention of a scheduled backup of a server other than the active one
  // (cleanupOldBackups(), _pruneOldestToFit()). Without it that pass looked
  // for the file in the active server's folder ("Backup not found"), or,
  // with both servers on one data folder, refused it as the other server's.
  async deleteBackup(backupName, activeServerOverride) {
    try {
      const backupsPath = await this.getBackupsPath(activeServerOverride);
      if (!backupsPath) {
        throw new Error("Backups folder not found");
      }

      // Sanitize filename to prevent path traversal
      const safeName = path.basename(backupName);
      if (!safeName.endsWith(".zip")) {
        throw new Error("Invalid backup file");
      }

      const backupPath = path.join(backupsPath, safeName);

      if (!fs.existsSync(backupPath)) {
        throw new Error("Backup not found");
      }

      // round 18: refuse a delete whose name identifies it as another,
      // currently-colliding server's own backup -- see
      // _findForeignBackupOwner()'s own comment.
      const foreignOwner = await this._findForeignBackupOwner(
        safeName,
        backupsPath,
        activeServerOverride,
      );
      if (foreignOwner) {
        throw new Error(
          `This backup belongs to another server profile ("${foreignOwner}") that shares this backups folder -- refusing to delete it from here.`,
        );
      }

      fs.unlinkSync(backupPath);
      try {
        await removeBackupRecord(safeName);
      } catch (error) {
        log.warn(`Backup record could not be removed for ${safeName}: ${error.message}`);
      }
      log.info(`Deleted backup: ${safeName}`);
      try {
        await logServerEvent(
          "backup_deleted",
          safeName,
          activeServerOverride?.id != null ? { serverId: activeServerOverride.id } : {},
        );
      } catch (error) {
        // The file is already unlinked and the record already removed --
        // a logging failure here must not turn an actually-successful
        // delete into a reported failure (the caller would retry and get
        // "Backup not found" for a backup that's genuinely gone).
        log.warn(`Could not log backup_deleted event for ${safeName}: ${error.message}`);
      }

      return { success: true };
    } catch (error) {
      log.error(`Failed to delete backup: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Clean up old backups based on maxBackups setting.
   *
   * Uploaded archives (see routes/backup.js's /upload comment -- stored
   * with an "uploaded-" prefix precisely so they can be told apart here)
   * are exempt from this automatic, unattended prune, full stop -- they
   * are never counted toward maxBackups and never selected for deletion.
   * This runs on a schedule with nobody watching; an operator who
   * uploaded an archive specifically to preserve it must not lose it
   * just because enough panel-created backups piled up around it.
   * deleteBackupsOlderThan is the other pruning path and is a deliberate
   * choice: it is operator-initiated, not automatic, so it does the
   * opposite and includes uploads -- see its own comment.
   *
   * The pre-restore-/pre-wipe- safety copies (see backupNames.js) are exempt
   * from the maxBackups count the same way: with backupMaxCount=1 the next
   * routine backup used to delete the copy of the world a restore or wipe had
   * just replaced. They are kept to the newest MAX_SAFETY_BACKUPS instead, so
   * a restore every day does not grow the folder without bound.
   */
  async cleanupOldBackups(activeServerOverride) {
    try {
      const settings = await this.getSettings();
      const backups = await this.listBackups(activeServerOverride);
      const ownServerName = await this._ownServerName(activeServerOverride);
      const safety = backups.filter((b) => isSafetyBackupName(b.name, ownServerName));
      const prunable = backups.filter(
        (b) => !b.name.startsWith("uploaded-") && !safety.includes(b),
      );

      // Both lists are newest first (listBackups() sorts them that way).
      const toDelete = [
        ...prunable.slice(settings.maxBackups),
        ...safety.slice(MAX_SAFETY_BACKUPS),
      ];
      if (toDelete.length === 0) {
        return;
      }

      // Delete oldest backups
      for (const backup of toDelete) {
        const deleted = await this.deleteBackup(backup.name, activeServerOverride);
        if (!deleted?.success) {
          // deleteBackup() only ever sets .message on failure, never
          // .error -- this read the wrong field, so every real cleanup
          // failure logged "unknown error" unconditionally regardless of
          // what actually went wrong.
          log.warn(
            `Could not clean up old backup ${backup.name}: ${deleted?.message || "unknown error"}`,
          );
          continue;
        }
        log.info(`Cleaned up old backup: ${backup.name}`);
      }
    } catch (error) {
      log.error(`Failed to cleanup old backups: ${error.message}`);
    }
  }

  /**
   * Delete backups older than X days -- operator-initiated (the route
   * requires a human to submit a days value), unlike cleanupOldBackups
   * which fires unattended on a schedule. Deliberately does NOT exempt
   * uploaded archives: an explicit "delete everything older than X days"
   * reasonably means what it says. Automatic pruning must never surprise
   * an operator by taking something they deliberately preserved;
   * an explicit bulk delete they typed in themselves is a choice they
   * made, not a surprise. To keep a specific upload past a bulk cutoff,
   * delete everything else and re-upload it, or use DELETE /:name to
   * remove other backups by exact name instead of by age.
   */
  async deleteBackupsOlderThan(days) {
    // Mirrors routes/backup.js's own guard -- see its comment for why
    // Number.isInteger matters here specifically (setDate() below silently
    // reinterprets a fractional value instead of using it as typed).
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1) {
      return { success: false, message: "Invalid days parameter. Must be a whole number >= 1" };
    }
    try {
      const backups = await this.listBackups();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const toDelete = backups.filter((backup) => {
        const backupDate = new Date(backup.created);
        return backupDate < cutoffDate;
      });

      if (toDelete.length === 0) {
        return {
          success: true,
          deleted: 0,
          message: `No backups older than ${days} days found`,
        };
      }

      let deletedCount = 0;
      let failedCount = 0;
      const deletedNames = [];

      for (const backup of toDelete) {
        const result = await this.deleteBackup(backup.name);
        if (result.success) {
          deletedCount++;
          deletedNames.push(backup.name);
        } else {
          failedCount++;
        }
      }

      log.info(`Deleted ${deletedCount} backups older than ${days} days`);

      return {
        success: failedCount === 0,
        deleted: deletedCount,
        failed: failedCount,
        deletedNames,
        message: `Deleted ${deletedCount} backup${deletedCount !== 1 ? "s" : ""} older than ${days} days${failedCount > 0 ? ` (${failedCount} failed)` : ""}`,
      };
    } catch (error) {
      log.error(`Failed to delete old backups: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get backup status
   */
  async getStatus() {
    const settings = await this.getSettings();
    const backups = await this.listBackups();
    const savesPath = await this.getSavesPath();
    const backupsPath = await this.getBackupsPath();

    // `this.lastBackup` is only ever WRITTEN by createBackup() succeeding in
    // THIS process (line ~687) -- it starts null at construction and is
    // never hydrated from disk, so every panel restart/update forgets it
    // even though real backups are sitting right there. `listBackups()`
    // above, by contrast, is always a live fs.readdir+stat scan and can
    // never go stale. Confirmed real-world shape: an operator with 20 real
    // backups sees "Last Backup: Never" right next to a correct non-zero
    // backupCount on the exact same status card, right after every restart
    // -- the moment an operator is already watching this card closest.
    // `backups[0]` (listBackups() sorts newest-first) and `this.lastBackup`
    // as set at line ~687 are the identical {name, path, size, created}
    // shape -- guarded by crossProducerShapeGate.test.js's cross-producer
    // check on this exact pair, so assigning one into the other here can't
    // print a raw object where the UI expects `.created` to read a string.
    // Lazy (computed here, not at construction) rather than eager: a
    // constructor that touches the filesystem is startup cost nobody is
    // looking at yet and is harder to test, and lazy self-heals if a backup
    // appears via any route OTHER than createBackup() succeeding in this
    // process -- exactly the gap that produced this bug in the first place.
    // Backups.tsx/Dashboard.tsx/Settings.tsx's readers all already treat
    // this generically as "the newest backup", never as "one this session
    // made", so widening the meaning from "mine" to "the real one on disk"
    // is what the label already claimed, not a behavior change for them.
    // Zero backups on disk must still read "Never": backups.length === 0
    // leaves this.lastBackup untouched (still its constructor-default null).
    if (!this.lastBackup && backups.length > 0) {
      this.lastBackup = backups[0];
    }

    // `lastBackup` above only ever reflects a SUCCESSFUL backup (manual or
    // scheduled) that produced a file -- it says nothing about whether the
    // scheduler itself has been failing. An operator can have "Auto Backup:
    // ON" showing green for weeks while every scheduled attempt has been
    // erroring out (bad schedule, unreachable backupsPath, disk full, ...)
    // with the failure visible only in the panel's own log and in Schedule
    // History, neither of which this status card surfaces. Only checked
    // when scheduling is actually enabled -- a stale failure from before the
    // operator turned it off isn't this card's business to report.
    // This server's own runs: the schedule can back up several.
    const lastScheduledAttempt = settings.enabled
      ? await getLatestScheduleExecutionByCommand(
          "backup",
          (await getActiveServer())?.id ?? undefined,
        )
      : null;

    // A failed scheduled attempt stops being a live problem the moment ANY
    // backup succeeds after it -- a manual "Create Backup", a pre-restore
    // safety backup, or a later scheduled run. Before this, only the next
    // successful SCHEDULED run could clear the warning: manual backups never
    // write Schedule History, so "try doing a backup" (the obvious advice,
    // and the maintainer's, in the 2026-09-27 Discord report) left
    // "Scheduled backup failing" on the Dashboard regardless. Read from the
    // persisted backup records rather than lastBackup: a record is written
    // only when createBackup() itself succeeds, whereas lastBackup can come
    // from a listing whose newest file was merely uploaded (its timestamp
    // says nothing about when the world was last actually backed up).
    let recoveredAt = null;
    if (lastScheduledAttempt && !lastScheduledAttempt.success) {
      try {
        const [newest] = await listBackupRecords({
          serverId: lastScheduledAttempt.server_id ?? undefined,
          limit: 1,
        });
        const failedAt = Date.parse(lastScheduledAttempt.executed_at);
        const createdAt = Date.parse(newest?.createdAt);
        if (Number.isFinite(failedAt) && Number.isFinite(createdAt) && createdAt > failedAt) {
          recoveredAt = newest.createdAt;
        }
      } catch (error) {
        log.debug(`Could not read backup records for the scheduled-attempt status: ${error.message}`);
      }
    }

    return {
      ...settings,
      backupInProgress: this.backupInProgress,
      restoreInProgress: this.restoreInProgress || false,
      currentRestore: this.currentRestore,
      lastRestore: this.lastRestore,
      lastBackup: this.lastBackup,
      backupCount: backups.length,
      savesPath,
      backupsPath,
      savesExists: savesPath ? fs.existsSync(savesPath) : false,
      lastScheduledBackupAttempt: lastScheduledAttempt
        ? {
            success: !!lastScheduledAttempt.success,
            message: lastScheduledAttempt.message,
            // Set when `message` is the panel's own prose (a backup given up
            // on because a restart looked stuck -- see logScheduleExecution),
            // so the page renders it translated; null for raw errors, and
            // for rows written before the key existed.
            messageKey: lastScheduledAttempt.message_key ?? null,
            messageParams: lastScheduledAttempt.message_params ?? null,
            executedAt: lastScheduledAttempt.executed_at,
            // 'restart' for the pre-deferral "skipped, a restart was in
            // progress" rows (see LEGACY_RESTART_SKIP_MESSAGE) -- not a
            // backup that broke, and the UI words it that way. Current code
            // never writes a skip: it holds the backup until the restart
            // ends (scheduler.js _onScheduledBackupTick()).
            skipReason:
              !lastScheduledAttempt.success &&
              lastScheduledAttempt.message === LEGACY_RESTART_SKIP_MESSAGE
                ? "restart"
                : null,
            recoveredAt,
          }
        : null,
    };
  }

  /**
   * Get info about what's included in a backup
   */
  getBackupContentsInfo() {
    return {
      description: "Server world save data",
      includes: [
        "map_*.bin - World map chunk data",
        "map_meta.bin - Map metadata",
        "map_sand.bin - Sandbox settings snapshot",
        "players/ - Player save files",
        "vehicles.db - Vehicle data",
        "reanimated.bin - Zombie data",
        "worldstats.txt - World statistics",
        "panel-server-snapshot.json - Safe server configuration snapshot",
        "Other world-specific data files",
      ],
      location: "Saves/Multiplayer/{ServerName}/",
      note: "Backups contain the entire world state. Server must be stopped before restoring.",
    };
  }

  /**
   * Restore a backup
   * WARNING: This will overwrite the current world save!
   */
  async restoreBackup(backupName, options = {}) {
    if (this.restoreInProgress) {
      return { success: false, message: "Restore already in progress" };
    }

    if (this.backupInProgress) {
      return { success: false, message: "Backup in progress, please wait" };
    }

    // Claim the lock BEFORE any await, not after. This used to be set only
    // once the async server-running check below had already resolved,
    // which left a real window: two near-simultaneous restoreBackup() calls
    // both read restoreInProgress as false (neither had reached the
    // assignment yet), both proceeded past every guard, and both extracted
    // + swapped the save directory concurrently -- the second rename to
    // finish silently wins over the first, with BOTH callers reported
    // success:true and no error anywhere. Confirmed empirically (two
    // concurrent calls, force !== true, an artificial delay inside
    // getServerProcessDetails to widen the window), not just reasoned
    // about -- bug-hunt-2026-08-27, backup-restore hunt. Every return in
    // _runRestore() happens inside the try/finally below, so the flag is
    // always released, same as the pre-restore-backup-failure path already
    // was.
    this.restoreInProgress = true;
    // GH#166: the HTTP response to POST /restore/:name used to be the only
    // place a restore's outcome existed. A restore that outlived that
    // request (a big world past the client's timeout, a reverse proxy
    // cutting a long request, the browser's connection dropping, the
    // operator navigating away) had no outcome anyone could read back, and
    // a page that had only SEEN the restore running (another tab, a reload)
    // could never learn it ended. GET /backup/status now carries both: the
    // restore running right now, and how the last one ended -- set before
    // restoreInProgress clears, so a status read that sees the flag down
    // always sees the outcome with it. `id` is the requesting page's own
    // requestId when it sent a well-formed one, which is how that page
    // tells its own outcome from another restore's. `preRestoreBackup`
    // says whether this restore backed the replaced world up first (both
    // panel pages always ask for it, an API caller may not), so a page
    // that only watched it never claims a safety backup that isn't there.
    // 'restore:finished' is the push for the same moment: sent once both
    // are recorded, where restore:progress's own 'complete'/'error' fire
    // from inside the restore, before the flag is down (and not at all for
    // a refusal). It carries the id alone: it goes to every signed-in
    // socket, backup capability or not, and a rollback failure's message
    // names a host path (see publicRestoreMessage()) -- pages read the
    // outcome from GET /backup/status, which is capability-gated.
    const restore = {
      id:
        typeof options.requestId === "string" &&
        RESTORE_REQUEST_ID_RE.test(options.requestId)
          ? options.requestId
          : randomUUID(),
      backupName: path.basename(String(backupName ?? "")),
      startedAt: new Date().toISOString(),
      preRestoreBackup: options.createPreRestoreBackup !== false,
    };
    this.currentRestore = restore;
    let result = null;
    try {
      result = await this._runRestore(backupName, options);
      return result;
    } finally {
      this.lastRestore = {
        ...restore,
        finishedAt: new Date().toISOString(),
        success: result?.success === true,
        message:
          result?.success === true
            ? null
            : publicRestoreMessage(result?.message ?? "Restore failed unexpectedly"),
        duration: typeof result?.duration === "number" ? result.duration : null,
      };
      this.currentRestore = null;
      this.restoreInProgress = false;
      options.io?.to(BACKUP_PROGRESS_ROOM).emit("restore:finished", { id: restore.id });
    }
  }

  // restoreBackup()'s body, run only while it holds restoreInProgress.
  async _runRestore(backupName, options) {
    const startTime = Date.now();
    let stagingPath = null;
    const io = options.io; // Socket.IO for progress updates

    // Helper to emit progress. Mirrors createBackup's emitProgress exactly so
    // the two events share a shape -- restore previously emitted nothing at
    // all, not even for its own pre-restore-backup sub-step, because that
    // inner createBackup() call never received io.
    const emitProgress = (phase, percent, message, extra = {}) => {
      if (io) {
        io.to(BACKUP_PROGRESS_ROOM).emit("restore:progress", {
          phase,
          percent,
          message: sanitizeError(message),
          ...extra,
        });
      }
    };

    try {
      // Restoring under a live server destroys the save: the running process
      // holds the map files open, and writes its in-memory world back over
      // whatever we extract. Prefer the richer process-state API because the
      // boolean helper collapses a failed scan into a confirmed stop.
      if (options.force !== true) {
        if (!this.serverManager) {
          // Same defect shape as the getServerProcessDetails-missing branch
          // below, one level up: "the check isn't wired" must refuse, not
          // silently skip straight to restore. Currently unreachable in
          // production -- server/index.js calls setServerManager() at boot,
          // before the only caller (routes/backup.js) is reachable, and that
          // route also runs its own independent getServerProcessDetails check
          // before ever calling here -- but both of those are call-graph
          // coincidences, not guarantees this method can rely on by itself.
          log.warn("Could not confirm server is stopped: no server manager wired");
          return {
            success: false,
            message:
              "Could not confirm the server is stopped because no server manager is available. Stop the server and try again.",
          };
        }
        try {
          if (typeof this.serverManager.getServerProcessDetails !== "function") {
            // No fallback to checkServerRunning() here even for an older
            // injected manager that only implements it -- that call collapses
            // a failed scan into a plain `false`, indistinguishable from a
            // confirmed-stopped server, which is exactly the bug this whole
            // guard exists to avoid. Treat "the richer check isn't available"
            // as equivalent to a failed scan and refuse, same shape as
            // server/index.js's Docker-update gate (handlePanelUpdateDownload).
            return {
              success: false,
              message:
                "Could not confirm the server is stopped because process detection is unavailable. Stop the server and try again.",
            };
          }

          // The same verdict as the route's gate and the status badge, the
          // watchdog and Discord (see routes/backup.js's restore route): the
          // local process scan alone says "stopped" for a server running in
          // another container, so the container state, RCON and PanelBridge
          // are consulted too. null = could not tell, which refuses.
          const running = await resolveObservedServerRunning(
            this.serverManager,
            this.rconService,
          );
          if (running === null) {
            log.warn("Could not confirm server is stopped: no signal could tell");
            return {
              success: false,
              message:
                "Could not confirm the server is stopped because process detection failed. Stop the server and try again.",
            };
          }

          if (running) {
            return {
              success: false,
              message:
                "Server is still running. Stop the server before restoring a backup, otherwise the running world will overwrite the restored save.",
            };
          }
        } catch (error) {
          log.warn(`Could not confirm server is stopped: ${error.message}`);
          return {
            success: false,
            message: `Could not confirm the server is stopped (${error.message}). Stop the server and try again.`,
          };
        }
      }

      emitProgress("preparing", 5, "Preparing restore...");

      const backupsPath = await this.getBackupsPath();
      const savesPath = await this.getSavesPath();

      if (!backupsPath) {
        throw new Error("Could not determine backups folder path");
      }

      if (!savesPath) {
        throw new Error(
          "Could not determine saves folder path. Please configure the server first.",
        );
      }

      // Sanitize backup name
      const safeName = path.basename(backupName);
      if (!safeName.endsWith(".zip")) {
        throw new Error("Invalid backup file");
      }

      const backupPath = path.join(backupsPath, safeName);

      if (!fs.existsSync(backupPath)) {
        throw new Error(`Backup not found: ${safeName}`);
      }

      // round 18: refuse to restore a backup whose name identifies it as
      // another, currently-colliding server's own backup -- the sharpest
      // version of "restore writes server A's backup into server B's
      // saves path" this bug hunt named. See _findForeignBackupOwner()'s
      // own comment.
      const foreignOwner = await this._findForeignBackupOwner(safeName, backupsPath);
      if (foreignOwner) {
        throw new Error(
          `This backup belongs to another server profile ("${foreignOwner}") that shares this backups folder -- refusing to restore it here.`,
        );
      }

      // The extracted world is staged beside the live one and (unless the
      // caller opted out) the current world is backed up first: refuse now,
      // with the numbers, rather than fail part-way with both on the disk.
      await this._ensureSpaceForRestore({
        backupPath,
        savesPath,
        backupsPath,
        withSafetyBackup: options.createPreRestoreBackup !== false,
      });

      log.info(`Starting restore from: ${safeName}`);
      log.info(`Destination: ${savesPath}`);

      // Create a pre-restore backup if requested
      if (options.createPreRestoreBackup !== false) {
        log.info("Creating pre-restore backup...");
        emitProgress("pre-backup", 10, "Backing up current world before restoring...");
        // Passing io through means this sub-step surfaces its own normal
        // backup:progress events (preparing/archiving/finalizing) instead of
        // running silently -- restore no longer looks stalled during what can
        // be the longest part of the whole operation.
        const preBackupResult = await this.createBackup({ isPreRestore: true, io });
        // 2026-08-26 bug hunt: createBackup can return success:true while
        // having silently skipped files that vanished mid-archive (a real
        // race on a live PZ directory) -- it surfaces that via
        // skippedFiles rather than deciding policy itself, because the same
        // skip means different things depending on why the backup exists.
        // THIS backup is about to become the world's only copy while
        // restore overwrites the live save -- "mostly complete" is not a
        // safety net here, so any skip is treated exactly like an outright
        // backup failure, the same fail-closed posture already applied to
        // an unconfirmed server-stopped state above.
        const preBackupIncomplete =
          preBackupResult.success && (preBackupResult.skippedFiles?.length ?? 0) > 0;
        if (!preBackupResult.success || preBackupIncomplete) {
          const reason = preBackupIncomplete
            ? `it could not include ${preBackupResult.skippedFiles.length} file(s) (${preBackupResult.skippedFiles.join(", ")}) -- an incomplete pre-restore backup is not a safety net`
            : preBackupResult.message;
          log.error(`Pre-restore backup failed: ${reason}`);
          emitProgress(
            "error",
            0,
            `Cannot restore: pre-restore backup failed (${reason}). Aborting to protect save data.`,
          );
          return {
            success: false,
            message: `Cannot restore: pre-restore backup failed (${reason}). Aborting to protect save data.`,
          };
        }
      }

      // Get parent directory and expected folder name
      const savesParentPath = path.dirname(savesPath);
      const expectedFolderName = path.basename(savesPath);

      // Ensure parent directory exists
      if (!fs.existsSync(savesParentPath)) {
        fs.mkdirSync(savesParentPath, { recursive: true });
      }

      // A restore that failed hard or was killed leaves its staging folder
      // behind (hundreds of MB), and nothing else removes it. Restores run one
      // at a time, so any .restore-staging-* here is stale.
      sweepStaleRestoreStaging(savesParentPath);

      // Extract into a staging sibling and only swap it in once extraction has
      // fully succeeded. Deleting the live save first meant a truncated or
      // corrupt archive destroyed the world with nothing to fall back to.
      // A sibling keeps the swap on the same filesystem, so it stays a rename.
      stagingPath = createRestoreStagingDir(savesParentPath);

      // Extract the backup with zip-slip protection. On the first error the
      // extraction stops reading, closes what it has open and only then
      // rejects, so the staging folder removed below stays removed.
      log.info("Extracting backup to staging area...");
      emitProgress("extracting", 45, "Extracting backup...");
      const unzip = await getUnzipper();
      // Measured now, after the safety backup took its share of the disk.
      const limits = await this._restoreExtractionLimits(unzip, backupPath, savesParentPath);
      await extractArchiveToStaging(unzip, backupPath, stagingPath, limits);

      // Extraction succeeding only proves the archive was PARSEABLE -- the
      // unzipper streaming Parse() this whole block uses reads and discards
      // each entry's recorded CRC32 as bookkeeping and never actually
      // recomputes it against the bytes it just wrote (confirmed empirically:
      // a single flipped data byte inside an otherwise well-formed stored
      // entry extracts silently with the wrong content and raises no error
      // anywhere in the pipeline). Bit rot on backup storage, a bad copy, or
      // a partial download would all look exactly like a healthy backup right
      // up until this restore replaced a working world with corrupted bytes.
      // Verify every entry's actual CRC32 against what the archive's own
      // central directory recorded BEFORE the swap below -- staging is still
      // disposable at this point, so a failure here costs nothing.
      emitProgress("verifying", 80, "Verifying restored file integrity...");
      const integrity = await this._verifyExtractedIntegrity(
        backupPath,
        stagingPath,
      );
      if (!integrity.ok) {
        const preview = integrity.corruptFiles.slice(0, 5).join(", ");
        const more =
          integrity.corruptFiles.length > 5
            ? ` (+${integrity.corruptFiles.length - 5} more)`
            : "";
        throw new Error(
          `Backup archive failed integrity verification: ${integrity.corruptFiles.length} file(s) did not match their recorded checksum -- ${preview}${more}. Live save left untouched.`,
        );
      }

      // Extraction succeeded and every file verified against the archive's
      // own checksums. Only now is it safe to touch the live save.
      const stagedWorldPath = this._findExtractedWorld(
        stagingPath,
        expectedFolderName,
      );

      if (!stagedWorldPath) {
        throw new Error(
          "Backup did not contain a world save folder - live save left untouched",
        );
      }

      emitProgress("finalizing", 85, "Swapping in the restored world...");

      const retiredPath = `${savesPath}.replaced-${Date.now()}`;
      let retired = false;

      if (fs.existsSync(savesPath)) {
        fs.renameSync(savesPath, retiredPath);
        retired = true;
      }

      try {
        fs.renameSync(stagedWorldPath, savesPath);
      } catch (swapError) {
        // Put the original world back rather than leaving nothing in place.
        if (retired) {
          try {
            fs.renameSync(retiredPath, savesPath);
          } catch (rollbackError) {
            log.error(
              `Restore rollback failed - previous save is at ${retiredPath}: ${rollbackError.message}`,
            );
            throw new Error(
              `${RESTORE_ROLLBACK_FAILED_PREFIX} It is preserved at ${retiredPath}.`,
            );
          }
        }
        throw swapError;
      }

      if (retired) {
        try {
          fs.rmSync(retiredPath, { recursive: true, force: true });
        } catch (cleanupError) {
          log.warn(
            `Restored successfully but could not remove ${retiredPath}: ${cleanupError.message}`,
          );
        }
      }

      if (!fs.existsSync(savesPath)) {
        throw new Error(
          "Restore may have failed - saves folder not found after extraction",
        );
      }

      // chunks.js's /chunks and /stats routes cache a scan of this save's
      // map/ folder for a few seconds (see getMapFolderScan()'s comment).
      // This restore just swapped that whole save in from the archive --
      // without this, a page reload within the TTL window would show chunk
      // counts for the PRE-restore map/ contents.
      invalidateMapFolderScan(path.join(savesPath, "map"));

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      log.info(`Restore completed in ${duration}s`);

      try {
        await logServerEvent("backup_restored", `Restored from ${safeName}`);
      } catch (eventError) {
        log.warn(
          `Restore event could not be logged for ${safeName}: ${eventError.message}`,
        );
      }
      emitProgress("complete", 100, `Restored from ${safeName}`);

      return {
        success: true,
        message: `Restored from ${safeName}`,
        duration: parseFloat(duration),
      };
    } catch (error) {
      log.error(`Restore failed: ${error.message}`);
      emitProgress("error", 0, `Restore failed: ${sanitizeError(error.message)}`);
      try {
        await logServerEvent("restore_failed", error.message);
      } catch (eventError) {
        log.warn(
          `Restore failure event could not be logged: ${eventError.message}`,
        );
      }
      return {
        success: false,
        message: error.message,
        ...(error.errorCode ? { code: error.errorCode } : {}),
        ...(error.errorParams ? { params: error.errorParams } : {}),
      };
    } finally {
      // try/finally (not manual resets at each return) so this always runs,
      // including the early return above when the pre-restore backup fails.
      // restoreInProgress itself is released by restoreBackup()'s own
      // finally -- that path used to leak the flag permanently, locking out
      // all future restores until the process was restarted.
      if (stagingPath) {
        try {
          fs.rmSync(stagingPath, { recursive: true, force: true });
        } catch (cleanupError) {
          log.warn(
            `Could not remove restore staging folder ${stagingPath}: ${cleanupError.message}`,
          );
        }
      }
    }
  }

  // What the extraction may write (extractArchiveToStaging()'s `limits`): the
  // central directory's size per entry and in total, and the free space on
  // the saves volume. Unknown parts are null and only lift that one cap.
  async _restoreExtractionLimits(unzip, backupPath, savesParentPath) {
    let declaredSizes = null;
    let declaredTotal = null;
    try {
      const archive = await unzip.Open.file(backupPath);
      const sizes = new Map();
      let total = 0;
      let totalKnown = true;
      for (const file of archive.files) {
        if (file.type !== "File") continue;
        // A size the directory does not give (0xFFFFFFFF with no zip64
        // field): that entry has no cap of its own, and the total is unknown.
        if (!Number.isFinite(file.uncompressedSize)) {
          totalKnown = false;
          continue;
        }
        const key = normalizeZipEntryPath(file.path);
        sizes.set(key, Math.max(sizes.get(key) ?? 0, file.uncompressedSize));
        total += file.uncompressedSize;
      }
      declaredSizes = sizes;
      declaredTotal = totalKnown ? total : null;
    } catch (error) {
      // An unreadable directory is reported by the extraction itself.
      log.debug(`Restore size limits: could not read the archive directory: ${error.message}`);
    }
    let freeBytes = null;
    try {
      freeBytes = await freeBytesAt(savesParentPath);
    } catch (error) {
      log.debug(`Restore size limits: could not read free space: ${error.message}`);
    }
    return { declaredSizes, declaredTotal, freeBytes };
  }

  // Recomputes each extracted file's CRC32 and compares it against the value
  // the archive's own central directory recorded for that entry -- the check
  // the streaming extraction above never performs (see the caller's
  // comment). unzip.Open.file() reads the central directory directly (the
  // same API getBackupSnapshot() already uses), independent of the
  // streaming Parse() used to extract, so a corruption that fooled one
  // reading path is still caught by the other actually checking the number
  // it recorded. Mirrors the exact same `path.join(stagingPath, entry.path)`
  // mapping the extraction loop's zip-slip guard uses, so this checks
  // precisely the files that were actually written to staging, not a
  // parallel guess at where they'd be.
  async _verifyExtractedIntegrity(backupPath, stagingPath) {
    const corruptFiles = [];
    let archive;
    try {
      const unzip = await getUnzipper();
      archive = await unzip.Open.file(backupPath);
    } catch (error) {
      // Could not even read the central directory to verify against --
      // fail closed rather than skip verification silently.
      return { ok: false, corruptFiles: [`(could not read archive directory: ${error.message})`] };
    }

    const stagingRoot = path.resolve(stagingPath) + path.sep;
    for (const entry of archive.files) {
      if (entry.type !== "File") continue;
      // Same separators as the extraction (normalizeZipEntryPath()), so a
      // backslash-separated zip is checked where it was written.
      const entryPath = path.join(stagingPath, normalizeZipEntryPath(entry.path));
      // An entry the extraction refused as a traversal: never read a file
      // outside staging to compare it (and a zip carrying one is refused).
      if (!path.resolve(entryPath).startsWith(stagingRoot)) {
        corruptFiles.push(`${entry.path} (outside the archive's folder)`);
        continue;
      }

      let actualCrc32;
      try {
        actualCrc32 = await new Promise((resolve, reject) => {
          let checksum = 0;
          const stream = createReadStream(entryPath);
          stream.on("data", (chunk) => {
            checksum = crc32(chunk, checksum);
          });
          stream.on("end", () => resolve(checksum));
          stream.on("error", reject);
        });
      } catch (error) {
        // Missing on disk despite being listed in the central directory --
        // the streaming extraction silently dropped it (an even stranger
        // failure than a checksum mismatch, but the operator needs to know
        // either way, not have it discovered only inside the swapped-in world).
        corruptFiles.push(`${entry.path} (missing after extraction: ${error.message})`);
        continue;
      }

      if (actualCrc32 !== entry.crc32) {
        corruptFiles.push(entry.path);
      }
    }

    return { ok: corruptFiles.length === 0, corruptFiles };
  }

  // A backup normally wraps the world in its server-name folder, but older or
  // hand-made archives may use a different name or none at all.
  _findExtractedWorld(stagingPath, expectedFolderName) {
    const looksLikeWorld = (dir) =>
      fs.existsSync(path.join(dir, "map_meta.bin")) ||
      fs.existsSync(path.join(dir, "map_t.bin"));

    // The folder named like the server counts only when it holds a world:
    // an archive with just servertest/readme.txt used to replace the live
    // world with that. Otherwise the search below looks for one.
    const expected = path.join(stagingPath, expectedFolderName);
    if (fs.existsSync(expected) && fs.statSync(expected).isDirectory() && looksLikeWorld(expected)) {
      return expected;
    }

    if (looksLikeWorld(stagingPath)) {
      return stagingPath;
    }

    const candidates = [];
    const pending = [stagingPath];
    while (pending.length > 0) {
      const current = pending.pop();
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      if (current !== stagingPath && looksLikeWorld(current)) {
        candidates.push(current);
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      }
    }

    return candidates.length === 1 ? candidates[0] : null;
  }
}
