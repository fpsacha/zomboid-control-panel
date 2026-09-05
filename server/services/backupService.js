import path from "path";
import fs from "fs";
import { createWriteStream } from "fs";
import archiver from "archiver";
import { createReadStream } from "fs";
import { crc32 } from "zlib";
import { createLogger } from "../utils/logger.js";
import { isPidAlive } from "../utils/pidLiveness.js";
const log = createLogger("Backup");
import {
  getActiveServer,
  getSetting,
  setSetting,
  logServerEvent,
  getLatestScheduleExecutionByCommand,
  flushWrites,
} from "../database/init.js";
import { sanitizeError } from "../utils/sanitize.js";
import { captureBackupSnapshot } from "../utils/backupSnapshot.js";
import { addBackupRecord, removeBackupRecord } from "./backupRecords.js";
import { invalidateMapFolderScan } from "../routes/chunks.js";
import {
  isCronTooFrequent,
  isSupportedFiveFieldCron,
} from "../utils/cronValidation.js";

// Dynamic import for unzipper (CommonJS module)
let unzipper;
async function getUnzipper() {
  if (!unzipper) {
    unzipper = await import("unzipper");
  }
  return unzipper;
}

async function* walkDirectory(rootDir) {
  const pending = [{ dirPath: rootDir, archivePath: "", isRoot: true }];

  while (pending.length > 0) {
    const current = pending.pop();
    let directory;
    try {
      directory = await fs.promises.opendir(current.dirPath);
    } catch (error) {
      if (current.isRoot) throw error;
      continue;
    }

    try {
      let entry;
      while ((entry = await directory.read()) !== null) {
        const archivePath = current.archivePath
          ? `${current.archivePath}/${entry.name}`
          : entry.name;
        const fullPath = path.join(current.dirPath, entry.name);

        if (entry.isSymbolicLink()) {
          // Deliberately not followed (zip-slip in reverse -- a symlink
          // inside the save tree pointing outside it must never leak
          // arbitrary filesystem content into the archive), but that
          // decision has to be VISIBLE the same way a vanished file already
          // is via waitForArchiveEntry's ENOENT handling below -- silently
          // dropping it here meant a pre-restore/pre-wipe backup could be
          // incomplete with skippedFiles staying empty, defeating the
          // "any skip is a failure" policy those call sites rely on.
          yield { entry, fullPath, archivePath, isSymlink: true };
          continue;
        }

        if (entry.isDirectory()) {
          pending.push({
            dirPath: fullPath,
            archivePath,
            isRoot: false,
          });
        }

        yield { entry, fullPath, archivePath };
      }
    } finally {
      await directory.close().catch(() => {});
    }
  }
}

async function countFiles(rootDir) {
  let count = 0;
  for await (const { entry } of walkDirectory(rootDir)) {
    if (!entry.isDirectory()) count++;
  }
  return count;
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

// Exported alias, not a fresh implementation: kept so this sweep's own
// tests and callers can name the check in domain terms (is the temp
// file's *owner* still alive) without every caller needing to know the
// underlying check is now shared with fileWriteQueue.js.
export const isBackupTempOwnerAlive = isPidAlive;

export function cleanupOrphanBackupTemps(backupsPath) {
  let entries;
  try {
    entries = fs.readdirSync(backupsPath);
  } catch {
    return;
  }
  for (const name of entries) {
    const centralMatch = CENTRAL_TEMP_PATTERN.exec(name);
    if (centralMatch) {
      if (isBackupTempOwnerAlive(Number(centralMatch[1]))) continue;
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

// Sort key for listBackups(): panel-created backups encode their own
// creation timestamp (down to the millisecond) plus a numeric collision
// suffix directly in the filename -- see the timestamp/collision-suffix
// construction in _doCreateBackup(). Parsing that out and sorting on it,
// the same fix already applied to configBackup.js's listBackupsFor() (see
// its own comment), avoids relying on fs.stat().birthtime: several backups
// created in quick succession (a fast/near-empty world backs up in well
// under a second) can land with an IDENTICAL birthtime on real
// filesystems, at which point Array.prototype.sort's stability falls back
// to readdir()'s order -- unrelated to creation order -- and the brand-new
// backup can be mistaken for the oldest and pruned instead of a genuinely
// older one. Falls back to birthtime only for names the panel didn't
// create this way (uploaded-*.zip, hand-copied files) -- there is no
// better signal for those, and they're already exempt from automatic
// pruning regardless.
const BACKUP_TIMESTAMP_RE =
  /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3})(?:-(\d+))?\.zip$/;
function backupSortKey(fileName, stats) {
  const match = fileName.match(BACKUP_TIMESTAMP_RE);
  if (match) {
    return { key: match[1], suffix: match[2] ? parseInt(match[2], 10) : 1 };
  }
  return {
    key: stats.birthtime.toISOString().replace(/[:.]/g, "-").slice(0, 23),
    suffix: 1,
  };
}

export class BackupService {
  constructor() {
    this.backupInProgress = false;
    this.restoreInProgress = false;
    this.lastBackup = null;
    this.backupHistory = [];
    this.discordBot = null;
    this.serverManager = null;
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

  /**
   * Get the saves folder path for the current server
   */
  async getSavesPath() {
    /**
     * (getSavesPath starts here)
     */
    try {
      const activeServer = await getActiveServer();

      if (activeServer?.zomboidDataPath && activeServer?.serverName) {
        const savesPath = path.join(
          activeServer.zomboidDataPath,
          "Saves",
          "Multiplayer",
          activeServer.serverName,
        );
        if (fs.existsSync(savesPath)) {
          return savesPath;
        }
        // Try without serverName subfolder - but only if the folder matches the expected name
        const baseSavesPath = path.join(
          activeServer.zomboidDataPath,
          "Saves",
          "Multiplayer",
        );
        if (fs.existsSync(baseSavesPath)) {
          // Look for a folder that matches the server name (case-insensitive)
          const folders = fs
            .readdirSync(baseSavesPath, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
          // First try exact match
          const exactMatch = folders.find((f) => f === activeServer.serverName);
          if (exactMatch) {
            return path.join(baseSavesPath, exactMatch);
          }
          // Then try case-insensitive match
          const caseInsensitiveMatch = folders.find(
            (f) => f.toLowerCase() === activeServer.serverName.toLowerCase(),
          );
          if (caseInsensitiveMatch) {
            return path.join(baseSavesPath, caseInsensitiveMatch);
          }
          // Only use first folder as last resort with a warning
          if (folders.length > 0) {
            log.warn(
              `Could not find save folder matching "${activeServer.serverName}", using first available: ${folders[0]}`,
            );
            return path.join(baseSavesPath, folders[0]);
          }
        }
      }

      // Fallback to legacy settings
      const zomboidDataPath = await getSetting("zomboidDataPath");
      const serverName = await getSetting("serverName");

      if (zomboidDataPath && serverName) {
        return path.join(zomboidDataPath, "Saves", "Multiplayer", serverName);
      }

      return null;
    } catch (error) {
      log.error(`Failed to get saves path: ${error.message}`);
      return null;
    }
  }

  /**
   * Get the backups folder path
   */
  async getBackupsPath() {
    try {
      const activeServer = await getActiveServer();
      let basePath;

      if (activeServer?.zomboidDataPath) {
        basePath = activeServer.zomboidDataPath;
      } else {
        basePath = await getSetting("zomboidDataPath");
      }

      if (!basePath) {
        // Use local backups folder as fallback
        const { getDataPaths } = await import("../utils/paths.js");
        basePath = getDataPaths().dataDir;
      }

      const backupsPath = path.join(basePath, "backups");

      // Ensure backups folder exists
      if (!fs.existsSync(backupsPath)) {
        fs.mkdirSync(backupsPath, { recursive: true });
      }

      return backupsPath;
    } catch (error) {
      log.error(`Failed to get backups path: ${error.message}`);
      return null;
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

    return { enabled, schedule, maxBackups, includeDb };
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

    this.backupInProgress = true;
    const startTime = Date.now();
    const io = options.io; // Socket.IO for progress updates

    // Helper to emit progress
    const emitProgress = (phase, percent, message, extra = {}) => {
      if (io) {
        io.emit("backup:progress", { phase, percent, message, ...extra });
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
      return { success: false, message: sanitizeError(error.message) };
    } finally {
      this.backupInProgress = false;
    }
  }

  /**
   * Internal backup implementation
   */
  async _doCreateBackup(options, startTime, emitProgress) {
    emitProgress("preparing", 5, "Preparing backup...");

    const savesPath = await this.getSavesPath();
    const backupsPath = await this.getBackupsPath();

    if (!savesPath) {
      throw new Error(
        "Could not determine saves folder path. Please configure the server first.",
      );
    }

    if (!fs.existsSync(savesPath)) {
      throw new Error(`Saves folder not found: ${savesPath}`);
    }

    if (!backupsPath) {
      throw new Error("Could not determine backups folder path");
    }

    // Generate backup filename with timestamp
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 23);
    const activeServer = await getActiveServer();
    const serverName = activeServer?.serverName || "server";
    const baseBackupName = `${serverName}_${timestamp}`;
    let backupName = `${baseBackupName}.zip`;
    let backupPath = path.join(backupsPath, backupName);
    let collision = 1;
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

    // Count total files for progress without materializing directory listings.
    let totalFiles = 0;

    try {
      totalFiles = await countFiles(savesPath);
    } catch (err) {
      log.warn(`Failed to count files: ${err.message}`);
      totalFiles = 1000; // Fallback estimate
    }

    // Get database path if needed (before entering Promise callback)
    let dbPathToInclude = null;
    if (options.includeDb) {
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
        dbPathToInclude = dbPath;
        totalFiles++;
      }
    }

    emitProgress("archiving", 15, `Found ${totalFiles} files to backup...`, {
      totalFiles,
    });

    // Create zip archive
    const output = createWriteStream(tempBackupPath);
    const archive = archiver("zip", {
      zlib: { level: 6 }, // Moderate compression
    });

    let filesProcessed = 0;
    // Every archive addition (saves-folder walk, the snapshot, db.json) goes
    // through waitForArchiveEntry, so this collects every skip precisely --
    // not a sampled backstop, the complete account.
    const skippedFiles = [];

    return new Promise((resolve, reject) => {
      // Track progress during archiving
      archive.on("entry", (entry) => {
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

      output.on("close", async () => {
        emitProgress("finalizing", 95, "Finalizing backup...");

        // Only now, with the archive fully written and closed, does it become
        // the real backup. Anything that dies before this line leaves nothing
        // but an already-excluded .tmp file behind.
        try {
          fs.renameSync(tempBackupPath, backupPath);
        } catch (renameError) {
          emitProgress(
            "error",
            0,
            `Backup failed: ${renameError.message}`,
          );
          reject(renameError);
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

        this.lastBackup = {
          name: backupName,
          path: backupPath,
          size: sizeBytes,
          created: new Date().toISOString(),
        };

        try {
          await addBackupRecord({
            backup: this.lastBackup,
            server: activeServer,
            snapshot: serverSnapshot,
          });
        } catch (error) {
          log.warn(`Backup record could not be saved for ${backupName}: ${error.message}`);
        }

        try {
          await logServerEvent("backup_created", `${backupName} (${sizeMB} MB)`);
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
            await this.cleanupOldBackups();
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
        if (this.discordBot) {
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
          backup: this.lastBackup,
          duration: parseFloat(duration),
          skippedFiles,
        });
      });

      // Best-effort: remove whatever partial bytes made it to disk so a
      // failed run doesn't leave a stray .tmp file behind. Not the listed
      // backup name (already excluded by listBackups()'s .zip filter), so
      // this is cleanliness, not the safety property -- that's the rename.
      const cleanupTemp = () => {
        fs.rm(tempBackupPath, { force: true }, (cleanupErr) => {
          if (cleanupErr) {
            log.warn(
              `Could not remove incomplete backup file ${tempBackupPath}: ${cleanupErr.message}`,
            );
          }
        });
      };

      output.on("error", (err) => {
        emitProgress("error", 0, `Backup failed: ${err.message}`);
        cleanupTemp();
        reject(err);
      });

      archive.on("error", (err) => {
        emitProgress("error", 0, `Archive error: ${err.message}`);
        cleanupTemp();
        reject(err);
      });

      archive.on("warning", (err) => {
        if (err.code === "ENOENT") {
          log.warn(`Backup warning: ${err.message}`);
        } else {
          cleanupTemp();
          reject(err);
        }
      });

      archive.pipe(output);

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

          if (dbPathToInclude) {
            const dbResult = await waitForArchiveEntry(archive, () =>
              archive.file(dbPathToInclude, { name: "db.json" }),
            );
            if (dbResult.skipped) skippedFiles.push("db.json");
          }

          await archive.finalize();
        } catch (error) {
          archive.abort();
          cleanupTemp();
          reject(error);
        }
      };

      void appendBackupContents();
    });
  }

  /**
   * Get list of existing backups
   */
  async listBackups() {
    try {
      const backupsPath = await this.getBackupsPath();
      if (!backupsPath || !fs.existsSync(backupsPath)) {
        return [];
      }

      const files = await fs.promises.readdir(backupsPath);

      const backups = await Promise.all(
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
      );

      return backups
        .filter((b) => b !== null)
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

    try {
      const unzip = await getUnzipper();
      const archive = await unzip.Open.file(backupPath);
      const entry = archive.files.find(
        (file) => file.path === "panel-server-snapshot.json",
      );
      if (!entry) {
        return { success: false, message: "This backup has no panel snapshot" };
      }
      const snapshot = JSON.parse((await entry.buffer()).toString("utf-8"));
      return { success: true, snapshot };
    } catch (error) {
      log.warn(`Could not read backup snapshot from ${safeName}: ${error.message}`);
      return { success: false, message: "Could not read backup snapshot" };
    }
  }

  /**
   * Delete a backup
   */
  async deleteBackup(backupName) {
    try {
      const backupsPath = await this.getBackupsPath();
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

      fs.unlinkSync(backupPath);
      try {
        await removeBackupRecord(safeName);
      } catch (error) {
        log.warn(`Backup record could not be removed for ${safeName}: ${error.message}`);
      }
      log.info(`Deleted backup: ${safeName}`);
      try {
        await logServerEvent("backup_deleted", safeName);
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
   */
  async cleanupOldBackups() {
    try {
      const settings = await this.getSettings();
      const backups = await this.listBackups();
      const prunable = backups.filter((b) => !b.name.startsWith("uploaded-"));

      if (prunable.length <= settings.maxBackups) {
        return;
      }

      // Delete oldest backups
      const toDelete = prunable.slice(settings.maxBackups);
      for (const backup of toDelete) {
        const deleted = await this.deleteBackup(backup.name);
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

    // `lastBackup` above only ever reflects a SUCCESSFUL backup (manual or
    // scheduled) that produced a file -- it says nothing about whether the
    // scheduler itself has been failing. An operator can have "Auto Backup:
    // ON" showing green for weeks while every scheduled attempt has been
    // erroring out (bad schedule, unreachable backupsPath, disk full, ...)
    // with the failure visible only in the panel's own log and in Schedule
    // History, neither of which this status card surfaces. Only checked
    // when scheduling is actually enabled -- a stale failure from before the
    // operator turned it off isn't this card's business to report.
    const lastScheduledAttempt = settings.enabled
      ? await getLatestScheduleExecutionByCommand("backup")
      : null;

    return {
      ...settings,
      backupInProgress: this.backupInProgress,
      restoreInProgress: this.restoreInProgress || false,
      lastBackup: this.lastBackup,
      backupCount: backups.length,
      savesPath,
      backupsPath,
      savesExists: savesPath ? fs.existsSync(savesPath) : false,
      lastScheduledBackupAttempt: lastScheduledAttempt
        ? {
            success: !!lastScheduledAttempt.success,
            message: lastScheduledAttempt.message,
            executedAt: lastScheduledAttempt.executed_at,
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
    // about -- bug-hunt-2026-08-27, backup-restore hunt. Every early return
    // below now happens inside the try/finally so the flag is still always
    // released, same as the pre-restore-backup-failure path already was.
    this.restoreInProgress = true;
    const startTime = Date.now();
    let stagingPath = null;
    const io = options.io; // Socket.IO for progress updates

    // Helper to emit progress. Mirrors createBackup's emitProgress exactly so
    // the two events share a shape -- restore previously emitted nothing at
    // all, not even for its own pre-restore-backup sub-step, because that
    // inner createBackup() call never received io.
    const emitProgress = (phase, percent, message, extra = {}) => {
      if (io) {
        io.emit("restore:progress", { phase, percent, message, ...extra });
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
          let running;
          if (typeof this.serverManager.getServerProcessDetails === "function") {
            const processDetails =
              await this.serverManager.getServerProcessDetails();
            if (!processDetails || processDetails.scanFailed) {
              log.warn("Could not confirm server is stopped: process scan failed");
              return {
                success: false,
                message:
                  "Could not confirm the server is stopped because process detection failed. Stop the server and try again.",
              };
            }
            running = processDetails.running;
          } else {
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

      // Extract into a staging sibling and only swap it in once extraction has
      // fully succeeded. Deleting the live save first meant a truncated or
      // corrupt archive destroyed the world with nothing to fall back to.
      // A sibling keeps the swap on the same filesystem, so it stays a rename.
      stagingPath = path.join(
        savesParentPath,
        `.restore-staging-${Date.now()}-${process.pid}`,
      );
      fs.mkdirSync(stagingPath, { recursive: true });

      // Extract the backup with zip-slip protection
      log.info("Extracting backup to staging area...");
      emitProgress("extracting", 45, "Extracting backup...");
      const unzip = await getUnzipper();
      const resolvedParent = path.resolve(stagingPath) + path.sep;

      await new Promise((resolve, reject) => {
        // Settle exactly once. Without this, errors on the read stream AND on
        // an individual entry write stream could both call reject, or one of
        // them could fire after `resolve` (a Parse 'close' while a write
        // stream is still flushing). settle() also lets us forward a
        // createReadStream error that pipe() does NOT propagate.
        let settled = false;
        const settle = (err) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        };

        // The parser emits 'close' as soon as it has read the archive, which
        // can happen while entry files are still flushing. Resolving then
        // leaves open handles in the staging folder, and renaming a directory
        // that still has open handles fails with EPERM on Windows.
        let pendingWrites = 0;
        let parseClosed = false;
        const settleIfComplete = () => {
          if (parseClosed && pendingWrites === 0) settle();
        };

        const readStream = createReadStream(backupPath);
        readStream.on("error", settle);

        readStream
          .pipe(unzip.Parse())
          .on("entry", (entry) => {
            try {
              const entryPath = path.join(stagingPath, entry.path);
              const resolvedEntry = path.resolve(entryPath);

              // Block zip-slip: entry must resolve inside the target directory
              if (!resolvedEntry.startsWith(resolvedParent)) {
                log.error(`Zip slip attempt blocked: ${entry.path}`);
                entry.autodrain();
                return;
              }

              if (entry.type !== "Directory" && entry.type !== "File") {
                log.warn(
                  `Skipping unsupported backup entry type ${entry.type}: ${entry.path}`,
                );
                entry.autodrain();
              } else if (entry.type === "Directory") {
                fs.mkdirSync(resolvedEntry, { recursive: true });
                entry.autodrain();
              } else {
                // Ensure parent directory exists
                fs.mkdirSync(path.dirname(resolvedEntry), { recursive: true });
                const writeStream = createWriteStream(resolvedEntry);
                pendingWrites++;
                // Per-entry write failures (ENOSPC, EACCES, path too long on
                // Windows) surface as 'error' on the WriteStream and are NOT
                // forwarded by pipe(). Without this listener the event is
                // unhandled and crashes the process.
                writeStream.on("error", (err) => {
                  pendingWrites--;
                  try {
                    entry.unpipe(writeStream);
                  } catch {
                    /* ignore */
                  }
                  try {
                    entry.autodrain();
                  } catch {
                    /* ignore */
                  }
                  settle(err);
                });
                writeStream.on("close", () => {
                  pendingWrites--;
                  settleIfComplete();
                });
                entry.on("error", settle);
                entry.pipe(writeStream);
              }
            } catch (err) {
              settle(err);
            }
          })
          .on("close", () => {
            parseClosed = true;
            settleIfComplete();
          })
          .on("error", settle);
      });

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
              `Restore failed and the previous save could not be put back automatically. It is preserved at ${retiredPath}.`,
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
      return { success: false, message: error.message };
    } finally {
      // try/finally (not manual resets at each return) so this always runs,
      // including the early return above when the pre-restore backup fails —
      // that path used to leak the flag permanently, locking out all future
      // restores until the process was restarted.
      if (stagingPath) {
        try {
          fs.rmSync(stagingPath, { recursive: true, force: true });
        } catch (cleanupError) {
          log.warn(
            `Could not remove restore staging folder ${stagingPath}: ${cleanupError.message}`,
          );
        }
      }
      this.restoreInProgress = false;
    }
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

    for (const entry of archive.files) {
      if (entry.type !== "File") continue;
      const entryPath = path.join(stagingPath, entry.path);

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

    const expected = path.join(stagingPath, expectedFolderName);
    if (fs.existsSync(expected) && fs.statSync(expected).isDirectory()) {
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
