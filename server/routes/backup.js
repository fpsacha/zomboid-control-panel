import express from "express";
import path from "path";
import fs from "fs";
import { createLogger } from "../utils/logger.js";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.js";
import { getActiveServer } from "../database/init.js";
import { requirePermission } from "../services/permissions.js";
import { listBackupRecords } from "../services/backupRecords.js";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
} from "../services/lifecycleCoordinator.js";
import { ErrorCode } from "../utils/errorCodes.js";
import {
  isCronTooFrequent,
  isSupportedFiveFieldCron,
} from "../utils/cronValidation.js";
import { parseClampedInteger } from "../utils/queryNumbers.js";
import {
  streamUploadToFile,
  UPLOAD_TOO_LARGE_CODE,
  UPLOAD_BAD_SIGNATURE_CODE,
} from "../utils/uploadStream.js";
const log = createLogger("API:Backup");

const router = express.Router();

function parseBackupBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return undefined;
}

function parseBackupMaxCount(value) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100
    ? parsed
    : undefined;
}

// Get backup status and settings
router.get("/status", async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const status = await backupService.getStatus();
    res.json(status);
  } catch (error) {
    log.error(`Failed to get backup status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get info about what backups contain
router.get("/info", async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const info = backupService.getBackupContentsInfo();
    res.json(info);
  } catch (error) {
    log.error(`Failed to get backup info: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get list of backups
router.get("/list", async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const backups = await backupService.listBackups();
    res.json({ backups });
  } catch (error) {
    log.error(`Failed to list backups: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/history", async (req, res) => {
  try {
    const limit =
      req.query.limit === undefined
        ? undefined
        : parseClampedInteger(req.query.limit, null, 1, 500);
    if (req.query.limit !== undefined && limit === null) {
      return res.status(400).json({ error: "Invalid history limit" });
    }
    const records = await listBackupRecords({
      serverId: req.query.serverId,
      limit: Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : undefined,
    });
    res.json({ records });
  } catch (error) {
    log.error(`Failed to list backup history: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/:name/snapshot", requirePermission("backups.manage"), async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const result = await backupService.getBackupSnapshot(req.params.name);
    if (result.success) return res.json(result);
    return res.status(404).json(result);
  } catch (error) {
    log.error(`Failed to read backup snapshot: ${error.message}`);
    return res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Update backup settings
router.post("/settings", requirePermission("backups.manage"), async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const scheduler = req.app.get("scheduler");

    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({
        success: false,
        error: "Request body must be an object",
      });
    }

    // Whitelist allowed backup settings to prevent prototype pollution
    const allowed = {};
    if (req.body.enabled !== undefined) {
      const enabled = parseBackupBoolean(req.body.enabled);
      if (enabled === undefined) {
        return res.status(400).json({
          success: false,
          error: "enabled must be a boolean or 0/1",
        });
      }
      allowed.enabled = enabled;
    }
    if (req.body.schedule !== undefined) {
      if (
        !isSupportedFiveFieldCron(req.body.schedule) ||
        isCronTooFrequent(req.body.schedule)
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Invalid backup schedule. Use exactly 5 cron fields and no more than one run every 5 minutes.",
        });
      }
      allowed.schedule = req.body.schedule.trim();
    }
    if (req.body.maxBackups !== undefined) {
      const maxBackups = parseBackupMaxCount(req.body.maxBackups);
      if (maxBackups === undefined) {
        return res.status(400).json({
          success: false,
          error: "maxBackups must be an integer between 1 and 100",
        });
      }
      allowed.maxBackups = maxBackups;
    }
    if (req.body.includeDb !== undefined) {
      const includeDb = parseBackupBoolean(req.body.includeDb);
      if (includeDb === undefined) {
        return res.status(400).json({
          success: false,
          error: "includeDb must be a boolean or 0/1",
        });
      }
      allowed.includeDb = includeDb;
    }

    const settings = await backupService.updateSettings(allowed);

    // Update scheduler with new backup settings
    if (scheduler && scheduler.setupBackupSchedule) {
      await scheduler.setupBackupSchedule();
    }

    res.json({ success: true, settings });
  } catch (error) {
    log.error(`Failed to update backup settings: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Create a manual backup
router.post("/create", requirePermission("backups.manage"), async (req, res) => {
  try {
    log.info("POST /create — creating manual backup");
    const activeServer = await getActiveServer();
    if (activeServer?.isRemote) {
      return res
        .status(400)
        .json({
          error:
            "Backups are not available for remote servers. The server filesystem is not accessible from this panel.",
          code: ErrorCode.BACKUP_REMOTE_NOT_AVAILABLE,
        });
    }

    const backupService = req.app.get("backupService");
    const io = req.app.get("io");

    // Pass io for progress updates
    const result = await backupService.createBackup({ ...req.body, io });

    if (result.success) {
      // 2026-08-26 bug hunt: createBackup surfaces skipped files rather than
      // deciding policy -- this is the routine/manual path, so a skip
      // (a temp/log/lock file the live game process rotated out from under
      // the scan, OR a symbolic link deliberately not followed -- see
      // walkDirectory's own comment, 2026-08-29) is tolerated, not fatal.
      // Reported as a warnings array so it's visible rather than silently
      // dropped, same convention as the reloadWarnings/scriptWarnings
      // responses used elsewhere tonight.
      if (result.skippedFiles?.length > 0) {
        res.json({
          ...result,
          warnings: [
            `${result.skippedFiles.length} file(s) could not be included in the backup: ${result.skippedFiles.join(", ")}. This is usually a temp, log, or lock file the running server rewrote mid-backup, or a symbolic link that was deliberately not followed -- check that the backup still restores correctly if any of these look like save data.`,
          ],
        });
      } else {
        res.json(result);
      }
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    log.error(`Failed to create backup: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Delete a backup
router.delete("/:name", requirePermission("backups.manage"), async (req, res) => {
  try {
    log.info(`DELETE /${req.params.name}`);
    const backupService = req.app.get("backupService");
    const result = await backupService.deleteBackup(req.params.name);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    log.error(`Failed to delete backup: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Download a backup archive off the machine. Its own capability, not
// folded into backups.manage: creating, deleting or restoring a backup
// manipulates data on this machine, but downloading EXFILTRATES a full
// copy of it -- world save data, and if includeDb was ever turned on,
// db.json's bcrypt password hashes too. A role trusted to manage backups
// day-to-day is not automatically a role that should be able to walk
// away with an offline copy of everything.
// /list and /history stay deliberately ungated (read-only status routes
// are outside the matrix on purpose), but that pair is what makes this
// exposure trivially reachable without the gate below: enumerate the
// filenames, then download.
router.get("/download/:name", requirePermission("backups.download"), async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const backupsPath = await backupService.getBackupsPath();

    if (!backupsPath) {
      return res.status(404).json({ error: "Backups folder not found", code: ErrorCode.BACKUPS_FOLDER_NOT_FOUND });
    }

    // Sanitize filename to prevent path traversal
    const safeName = path.basename(req.params.name);
    if (!safeName.endsWith(".zip")) {
      return res.status(400).json({ error: "Invalid backup file", code: ErrorCode.BACKUP_INVALID_FILE });
    }

    const backupPath = path.join(backupsPath, safeName);

    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: "Backup not found", code: ErrorCode.BACKUP_NOT_FOUND });
    }

    res.download(backupPath, safeName);
  } catch (error) {
    log.error(`Failed to download backup: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Restore a backup. Admin-only, deliberately narrower than the other backup
// routes: deleting a backup destroys the operator's safety net (housekeeping),
// but restoring one rolls the live world back over every player currently
// standing in it -- a decision about other people's time, not routine server
// operation, and invisible to the admin until someone complains.
router.post("/restore/:name", requirePermission("backups.restore"), async (req, res) => {
  // Fetched before acquiring the lock (a pure DB read, no lock needed for
  // it) purely so a refusal from a concurrent operation can name which
  // server it's for -- see lifecycleCoordinator.js's comment.
  const activeServerForLock = await getActiveServer();
  // bug hunt 2026-09-05 (backup-restore-round-trip sweep, item #2): this
  // route's own stopped-check above, and restoreBackup()'s own internal
  // one, only ever prove the server was NOT running at the instant they
  // ran. Nothing stood between that instant and the destructive rename
  // swap deep inside restoreBackup() -- a Start (manual, Discord, or a
  // scheduler tick) landing in that window raced the live JVM against the
  // extraction/swap. Same process-wide lock /start, /stop, /force-stop and
  // /restart already take for the identical reason (see their own comment
  // in routes/server.js) -- not a new mechanism, held for the whole
  // restore, not just the check.
  const lifecycleLock = acquireLifecycleLock(
    "restore",
    activeServerForLock?.name || activeServerForLock?.serverName || null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  try {
    const activeServer = activeServerForLock;
    if (activeServer?.isRemote) {
      return res
        .status(400)
        .json({
          error:
            "Backup restore is not available for remote servers. The server filesystem is not accessible from this panel.",
          code: ErrorCode.BACKUP_RESTORE_REMOTE_NOT_AVAILABLE,
        });
    }

    const backupService = req.app.get("backupService");
    const serverManager = req.app.get("serverManager");

    // Sanitize filename to prevent path traversal
    const safeName = path.basename(req.params.name);
    if (!safeName.endsWith(".zip")) {
      return res.status(400).json({ error: "Invalid backup file", code: ErrorCode.BACKUP_INVALID_FILE });
    }

    // Check if server is running. checkServerRunning() collapses a FAILED
    // detection scan into a plain `false` -- indistinguishable from a
    // confirmed-stopped server -- which would let this restore silently
    // overwrite the live world save while the server might still be running
    // and holding those files open. getServerProcessDetails() exposes that
    // distinction via scanFailed, so use it directly and fail closed when
    // detection itself failed, same as /wipe, /delete-files and
    // chunks.js's delete-chunks/delete-region.
    const processDetails = await serverManager.getServerProcessDetails();
    if (processDetails.scanFailed) {
      return res.status(503).json({
        success: false,
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      });
    }
    if (processDetails.running) {
      return res.status(400).json({
        success: false,
        error:
          "Server must be stopped before restoring a backup. Please stop the server first.",
        code: ErrorCode.BACKUP_RESTORE_SERVER_RUNNING,
      });
    }

    const io = req.app.get("io");
    // Pass io for progress updates -- see createBackup's identical pattern above.
    const result = await backupService.restoreBackup(safeName, { ...req.body, io });

    if (result.success) {
      res.json(result);
    } else {
      // restoreBackup()'s failure messages are almost all short and
      // pathless -- but the outer catch's own error.message is NOT: an
      // unexpected raw fs exception (ENOENT/EACCES) carries Node's default
      // message, which includes a full absolute path, and every other
      // error site in this codebase redacts that via sanitizeError()
      // (see the catch three lines below). This route was the one
      // exception, passing `result` straight through unsanitized.
      //
      // A blanket sanitizeError() here would fix that leak but ALSO
      // redact the one message that deliberately needs its path visible:
      // the rollback-failure branch, which names the exact path the
      // preserved original save is sitting at -- the single most
      // important string in the whole restore flow when it fires, and
      // the operator's only way to find their data back. So this is
      // surgical, not blanket: sanitize everything except that one
      // deliberately-informative message. 2026-08-26 partial-failure-
      // state hunt.
      const isRollbackFailureMessage =
        typeof result.message === "string" &&
        result.message.startsWith(
          "Restore failed and the previous save could not be put back automatically.",
        );
      res.status(400).json(
        isRollbackFailureMessage
          ? result
          : { ...result, message: sanitizeError(result.message) },
      );
    }
  } catch (error) {
    log.error(`Failed to restore backup: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    lifecycleLock.release();
  }
});

// Delete backups older than X days
router.post("/delete-older-than", requirePermission("backups.manage"), async (req, res) => {
  try {
    const days = req.body?.days;

    // Number.isInteger, not just finite: a fractional value used to reach
    // deleteBackupsOlderThan()'s setDate(getDate() - days) uncaught, where
    // JS Date arithmetic silently reinterprets it (e.g. 1.5 behaves like 2,
    // not a genuine half-day cutoff) -- confusing, not a safety issue in
    // itself (rounding observed toward an EARLIER cutoff, i.e. fewer
    // deletions), but a value the client had no way to warn about and the
    // operator never actually typed. Was unreachable in practice only
    // because the client-side field clamped to whole numbers; that clamp
    // is gone (client/src/pages/Backups.tsx now lets the server refuse).
    if (
      typeof days !== "number" ||
      !Number.isInteger(days) ||
      days < 1
    ) {
      return res.status(400).json({
        error: "Invalid days parameter. Must be a whole number >= 1",
        code: ErrorCode.BACKUP_INVALID_DAYS_PARAMETER,
      });
    }

    const backupService = req.app.get("backupService");
    const result = await backupService.deleteBackupsOlderThan(days);

    res.json(result);
  } catch (error) {
    log.error(`Failed to delete old backups: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Upload a backup .zip from the user's machine into the backups folder.
// The body is the raw zip bytes; the filename is read from the
// X-Backup-Filename header. The stored filename is prefixed with
// "uploaded-" so external archives are visually separated from the
// panel's own scheduled backups, and never collide with them when the
// auto-prune logic looks for the oldest panel-created backup to drop.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB ceiling
router.post(
  "/upload",
  requirePermission("backups.manage"),
  async (req, res) => {
    // bug hunt 2026-09-05 (backup-restore-round-trip sweep, item #5): this
    // used to be express.raw({ limit: MAX_UPLOAD_BYTES }), which buffers
    // the ENTIRE request body into one in-process Buffer before this
    // handler ever runs -- an ordinary multi-GB world backup upload could
    // hold that many bytes resident at once on a host sized for a game
    // server, not for buffering its own backups. streamUploadToFile()
    // writes straight to the .tmp file as bytes arrive and enforces the
    // same signature/size checks while streaming instead of after fully
    // receiving the body -- see its own comment for why the signature
    // check can't just look at the first `data` event.
    let tmpPath = null;
    try {
      const activeServer = await getActiveServer();
      if (activeServer?.isRemote) {
        return res
          .status(400)
          .json({
            error: "Backup upload is not available for remote servers.",
            code: ErrorCode.BACKUP_UPLOAD_REMOTE_NOT_AVAILABLE,
          });
      }

      const contentType = String(req.headers["content-type"] || "");
      if (!contentType.includes("application/zip")) {
        return res
          .status(400)
          .json({
            error:
              "No file uploaded. Send the zip body with Content-Type: application/zip.",
            code: ErrorCode.BACKUP_UPLOAD_NO_FILE,
          });
      }

      const rawName = String(
        req.headers["x-backup-filename"] || "uploaded-backup.zip",
      );
      // Strip any path components and limit to filesystem-safe characters.
      // path.basename() handles both / and \ separators on all platforms.
      const baseName = path
        .basename(rawName)
        .replace(/[^A-Za-z0-9_.\- ]/g, "_")
        .slice(0, 200);
      if (!baseName.toLowerCase().endsWith(".zip")) {
        return res
          .status(400)
          .json({ error: "Only .zip backups are accepted.", code: ErrorCode.BACKUP_UPLOAD_INVALID_EXTENSION });
      }

      const backupService = req.app.get("backupService");
      const backupsPath = await backupService.getBackupsPath();
      if (!backupsPath) {
        return res
          .status(500)
          .json({
            error: "Backups folder not available. Configure the server first.",
            code: ErrorCode.BACKUPS_FOLDER_UNAVAILABLE,
          });
      }
      if (!fs.existsSync(backupsPath)) {
        fs.mkdirSync(backupsPath, { recursive: true });
      }

      // Always prefix to distinguish from auto-named backups (world_backup_*).
      const finalName = baseName.startsWith("uploaded-")
        ? baseName
        : `uploaded-${baseName}`;
      const targetPath = path.join(backupsPath, finalName);

      // Refuse silent overwrite — a user would lose the previous upload.
      if (fs.existsSync(targetPath)) {
        return res
          .status(409)
          .json({
            error: `A backup named "${finalName}" already exists. Delete it first or rename the upload.`,
            code: ErrorCode.BACKUP_UPLOAD_NAME_CONFLICT,
            params: sanitizeErrorParams({ name: finalName }),
          });
      }

      // Atomic write: stream to .tmp first, then rename. A crash during
      // upload won't leave a half-written .zip in the listing.
      tmpPath = `${targetPath}.tmp`;
      const totalBytes = await streamUploadToFile(req, tmpPath, MAX_UPLOAD_BYTES);

      if (totalBytes === 0) {
        // An empty body isn't a signature or size violation to
        // streamUploadToFile() (nothing arrived to check), so it leaves
        // the empty tmp file in place -- this is the one success-shaped
        // outcome that still needs its own cleanup here.
        fs.unlink(tmpPath, () => {});
        tmpPath = null;
        return res
          .status(400)
          .json({
            error:
              "No file uploaded. Send the zip body with Content-Type: application/zip.",
            code: ErrorCode.BACKUP_UPLOAD_NO_FILE,
          });
      }

      fs.renameSync(tmpPath, targetPath);
      tmpPath = null;

      log.info(`POST /upload — stored ${finalName} (${totalBytes} bytes)`);
      res.json({
        success: true,
        name: finalName,
        size: totalBytes,
        message: `Uploaded backup saved as ${finalName}. Use Restore to apply it.`,
      });
    } catch (error) {
      if (tmpPath) fs.unlink(tmpPath, () => {});
      if (error.code === UPLOAD_BAD_SIGNATURE_CODE) {
        return res
          .status(400)
          .json({
            error: "File does not look like a valid .zip archive.",
            code: ErrorCode.BACKUP_UPLOAD_INVALID_ZIP_SIGNATURE,
          });
      }
      if (error.code === UPLOAD_TOO_LARGE_CODE) {
        return res
          .status(413)
          .json({
            error: `Upload exceeds the ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024 * 1024))} GB limit.`,
            code: ErrorCode.BACKUP_UPLOAD_TOO_LARGE,
          });
      }
      log.error(`Failed to upload backup: ${error.message}`);
      res.status(500).json({ error: sanitizeError(error.message) });
    }
  },
);

export default router;
