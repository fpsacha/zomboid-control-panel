import express from "express";
import path from "path";
import fs from "fs";
import { createLogger } from "../utils/logger.js";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.js";
import { publicRestoreMessage } from "../utils/restoreMessage.js";
import { HOST_PATH_CAPABILITIES } from "../utils/hostPathView.js";
import { getActiveServer } from "../database/init.js";
import {
  getCapabilitiesForRole,
  requirePermission,
  requireAnyPermission,
} from "../services/permissions.js";
import { listBackupRecords } from "../services/backupRecords.js";
import { resolveObservedServerRunning } from "../utils/serverStatus.js";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
} from "../services/lifecycleCoordinator.js";
import { hasActiveSteamOperation } from "../services/activeSteamOperations.js";
import { ErrorCode } from "../utils/errorCodes.js";
import cron from "node-cron";
import {
  hasUnsupportedCronFieldCount,
  isCronTooFrequent,
} from "../utils/cronValidation.js";
import { nodeCronNextRun, restrictsBothDayFields } from "../utils/cronNextRun.js";
import { parseClampedInteger } from "../utils/queryNumbers.js";
import { allowSlowBody } from "../utils/requestBodyDeadline.js";
import {
  streamUploadToFile,
  UPLOAD_TOO_LARGE_CODE,
  UPLOAD_BAD_SIGNATURE_CODE,
} from "../utils/uploadStream.js";
import { freeBytesAt, insufficientSpaceError } from "../services/backupDiskSpace.js";
import { FM_LIMITS } from "../services/fileManagerContract.js";
const log = createLogger("API:Backup");

const router = express.Router();

// sweep-round5 (2026-09-07): GET /status, /list and /history had no
// capability check at all -- no single capability describes "may see
// what backups exist and where," since that's legitimately true of
// anyone holding backups.manage, backups.download, OR backups.restore.
// The responses carry savesPath/backupsPath (absolute host filesystem
// paths, not just backup filenames), so leaving them open to any signed-in
// user is the same class of disclosure this floor already closed twice
// tonight (5e3e2bcd, c19f351f) -- metadata-is-not-secret is defensible for
// a filename, not for host layout. Gating on backups.manage alone would
// break a download-only or restore-only custom role's ability to see what
// to act on before calling /download/:name or /restore/:name.
// A bound on the scheduled backup's list of servers (backupService.js has
// the same one).
const BACKUP_SERVER_IDS_MAX = 100;

const requireAnyBackupCapability = requireAnyPermission(
  "backups.manage",
  "backups.download",
  "backups.restore",
);

// SECURITY (2026-10-05, PATHS-1): a remote server's backups aren't on this
// computer. /create, /restore and /upload refused one already, but the
// routes below that read, download or delete a backup by name went on to
// use the remote record's data folder here -- a folder no save-time check
// holds (it names a path on the other host), so servers.manage could aim
// them at any folder on this one. They refuse a remote server the same way
// now, and backupService resolves no backups folder for one (its
// dataFolderUsable()), so /list and /status show none.
async function remoteServerBackupsRefusal() {
  const activeServer = await getActiveServer();
  if (!activeServer?.isRemote) return null;
  return {
    error:
      "Backups are not available for remote servers. The server filesystem is not accessible from this panel.",
    code: ErrorCode.BACKUP_REMOTE_NOT_AVAILABLE,
  };
}

// SECURITY (2026-10-05, H4): ...but where backups live is not something a
// download-only or restore-only role acts on: it picks a backup by name.
// The folders (savesPath, backupsPath, each backup's `path`) go to the roles
// that already see them elsewhere -- backups.manage and diagnostics.manage,
// as for the disk routes (routes/system.js), and the roles that set the
// server's folders up (utils/hostPathView.js) -- and are null for the rest,
// whose last scheduled attempt's error text is path-redacted too. So is the
// last restore's: publicRestoreMessage() keeps the folder a failed rollback
// left the previous save in, which is for a role that can go and get it.
const BACKUP_PATH_CAPABILITIES = Object.freeze([
  "backups.manage",
  "diagnostics.manage",
  ...HOST_PATH_CAPABILITIES,
]);

async function canSeeBackupPaths(req) {
  try {
    const capabilities = await getCapabilitiesForRole(req.user?.role);
    return (
      Array.isArray(capabilities) &&
      BACKUP_PATH_CAPABILITIES.some((capability) => capabilities.includes(capability))
    );
  } catch {
    return false;
  }
}

function withoutBackupPath(backup) {
  return backup && typeof backup === "object" ? { ...backup, path: null } : backup;
}

function withRedactedMessage(entry) {
  return entry && typeof entry.message === "string" && entry.message
    ? { ...entry, message: sanitizeError(entry.message) }
    : entry;
}

function hideBackupPaths(status) {
  return {
    ...status,
    savesPath: null,
    backupsPath: null,
    lastBackup: withoutBackupPath(status.lastBackup),
    lastScheduledBackupAttempt: withRedactedMessage(status.lastScheduledBackupAttempt),
    lastRestore: withRedactedMessage(status.lastRestore),
  };
}

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

// One verdict for a backup schedule, shared by POST /settings (which
// refuses to save anything else) and POST /validate-schedule (the Backups
// page's live preview of a custom expression) so the preview can never call
// "valid" what the save then rejects -- the same parity reason the
// Scheduler's /validate-cron shares its checks with POST /tasks. The same
// rules setupBackupSchedule() applies when it arms the job: exactly 5 cron
// fields node-cron accepts, no more often than every 5 minutes.
function validateBackupSchedule(schedule) {
  if (typeof schedule !== "string" || !schedule.trim() || schedule.length > 100) {
    return {
      valid: false,
      error: "Invalid cron expression format",
      code: ErrorCode.SCHEDULER_INVALID_CRON_EXPRESSION,
    };
  }
  // Same order as /validate-cron: node-cron's own verdict first, so a
  // malformed expression isn't mislabelled a seconds-precision one just
  // because its field count is also wrong.
  if (!cron.validate(schedule)) {
    return {
      valid: false,
      error: "Invalid cron expression format",
      code: ErrorCode.SCHEDULER_INVALID_CRON_EXPRESSION,
    };
  }
  if (hasUnsupportedCronFieldCount(schedule)) {
    return {
      valid: false,
      error: "The panel does not support seconds-precision schedules. Use exactly 5 fields: minute hour day month weekday.",
      code: ErrorCode.SCHEDULER_CRON_SECONDS_UNSUPPORTED,
    };
  }
  if (isCronTooFrequent(schedule)) {
    return {
      valid: false,
      error: "Backups cannot run more often than every 5 minutes",
      code: ErrorCode.BACKUP_SCHEDULE_TOO_FREQUENT,
    };
  }
  return { valid: true };
}

// Advisory data riding along on a status/preview response -- a failure
// computing it must never turn the whole response into a 500.
//
// Each overlap names the restart task and its cron expression, which are
// otherwise only readable through /api/scheduler (automation.manage on
// every route there), while these backup routes admit backups.manage,
// .download or .restore. A caller without automation.manage still gets the
// warning -- the times, and whether every backup is affected -- just not
// which task it is (the page words that case without a name).
async function getRestartOverlaps(req, scheduler, schedule) {
  if (typeof scheduler?.getBackupRestartOverlaps !== "function") return [];
  let overlaps;
  try {
    overlaps = await scheduler.getBackupRestartOverlaps(schedule);
  } catch (error) {
    log.debug(`Could not compute backup/restart overlaps: ${error.message}`);
    return [];
  }
  if (!Array.isArray(overlaps) || overlaps.length === 0) return [];
  const capabilities = await getCapabilitiesForRole(req.user?.role);
  if (capabilities?.includes("automation.manage")) return overlaps;
  return overlaps.map((overlap) => ({ ...overlap, name: null, cron: null }));
}

// Get backup status and settings
router.get("/status", requireAnyBackupCapability, async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const fullStatus = await backupService.getStatus();
    const status = (await canSeeBackupPaths(req)) ? fullStatus : hideBackupPaths(fullStatus);
    // continuous-bug-hunt round 28 (ux-proposals-need-backend-data): the
    // Scheduler page's backup-health card needs the backup schedule's own
    // next-run time alongside lastScheduledBackupAttempt (already computed
    // above by backupService.getStatus()) -- backupService itself has no
    // reference to the scheduler instance, so this is composed at the route
    // layer instead, same shape as GET /scheduler/tasks' own next_run.
    // scheduler.getBackupNextRun() is null whenever backups are disabled
    // (this.backupJob is null) -- no schedule, no hypothetical next run.
    const scheduler = req.app.get("scheduler");
    res.json({
      ...status,
      backupNextRun: scheduler ? scheduler.getBackupNextRun() : null,
      // Same route-layer composition, for the two restart interactions the
      // backup pages explain: the scheduled restarts this schedule keeps
      // landing inside (those backups wait for the restart and run late),
      // and a backup waiting on a restart right now. Only for an enabled
      // schedule -- an off one collides with nothing.
      restartOverlaps: status.enabled
        ? await getRestartOverlaps(req, scheduler, status.schedule)
        : [],
      backupDeferredSince: scheduler?.getDeferredBackupSince?.() ?? null,
    });
  } catch (error) {
    log.error(`Failed to get backup status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Each server's newest backup and how many it has, from the backup records,
// with the schedule's on/off and its chosen servers (null: the active server
// alone) -- the Dashboard's list of servers shows these per row. Read by the
// same roles as /status.
router.get("/summary", requireAnyBackupCapability, async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const [records, settings] = await Promise.all([
      listBackupRecords(),
      backupService.getSettings(),
    ]);
    const byServer = new Map();
    for (const record of records) {
      if (record?.serverId === null || record?.serverId === undefined) continue;
      const id = String(record.serverId);
      const entry = byServer.get(id) || { serverId: id, lastBackupAt: null, count: 0 };
      entry.count += 1;
      if (!entry.lastBackupAt || String(record.createdAt) > entry.lastBackupAt) {
        entry.lastBackupAt = String(record.createdAt);
      }
      byServer.set(id, entry);
    }
    res.json({
      servers: [...byServer.values()],
      schedule: { enabled: Boolean(settings.enabled), serverIds: settings.serverIds },
    });
  } catch (error) {
    log.error(`Failed to summarize backups: ${error.message}`);
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
router.get("/list", requireAnyBackupCapability, async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const backups = await backupService.listBackups();
    res.json({
      backups: (await canSeeBackupPaths(req)) ? backups : backups.map(withoutBackupPath),
    });
  } catch (error) {
    log.error(`Failed to list backups: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/history", requireAnyBackupCapability, async (req, res) => {
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
    const remoteRefusal = await remoteServerBackupsRefusal();
    if (remoteRefusal) return res.status(400).json(remoteRefusal);
    const backupService = req.app.get("backupService");
    const result = await backupService.getBackupSnapshot(req.params.name);
    if (result.success) return res.json(result);
    return res.status(result.code === ErrorCode.BACKUP_SNAPSHOT_TOO_LARGE ? 422 : 404).json(result);
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

    // continuous-bug-hunt round 23 (backup settings update has no server
    // check): this route applies to whichever server backupService is
    // currently scoped to (the active one), with no way for the caller to
    // say which server it MEANT -- unlike delete/restore, which check the
    // named backup file's own ownership. An operator who loads the Backups
    // page, then switches the active server in another tab before saving,
    // would silently apply their edited schedule/maxBackups/enabled toggle
    // to the NEW server instead of the one they were looking at. Mirrors
    // chunks.js's own expectedServerId/CHUNKS_STALE_SERVER_SCAN convention
    // exactly: optional (undefined skips the check, so an old client that
    // hasn't been updated to send it keeps working unchanged), refuses
    // only on a REAL mismatch, never on absence.
    if (req.body.expectedServerId !== undefined) {
      const activeServer = await getActiveServer().catch(() => null);
      const currentServerId = activeServer?.id ?? null;
      if (req.body.expectedServerId !== currentServerId) {
        return res.status(409).json({
          success: false,
          error:
            "The active server changed since these settings were loaded. Reload backup settings before saving.",
          code: ErrorCode.BACKUP_ACTIVE_SERVER_CHANGED,
        });
      }
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
      const verdict = validateBackupSchedule(req.body.schedule);
      if (!verdict.valid) {
        return res.status(400).json({
          success: false,
          error: verdict.error,
          code: verdict.code,
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
    if (req.body.onlyWhenOnline !== undefined) {
      const onlyWhenOnline = parseBackupBoolean(req.body.onlyWhenOnline);
      if (onlyWhenOnline === undefined) {
        return res.status(400).json({
          success: false,
          error: "onlyWhenOnline must be a boolean or 0/1",
        });
      }
      allowed.onlyWhenOnline = onlyWhenOnline;
    }
    // The servers the schedule backs up (the Dashboard's list of servers):
    // ids, unique, up to BACKUP_SERVER_IDS_MAX. One deleted since the page
    // loaded is kept rather than refused, as autoStartServerIds does; the
    // schedule skips it and deleteServer() drops it.
    if (req.body.serverIds !== undefined) {
      const ids = req.body.serverIds;
      if (
        !Array.isArray(ids) ||
        ids.length > BACKUP_SERVER_IDS_MAX ||
        !ids.every(
          (id) =>
            (typeof id === "string" && id.trim() !== "" && id.length <= 100) ||
            Number.isSafeInteger(id),
        )
      ) {
        return res.status(400).json({
          success: false,
          error: `serverIds must be a list of up to ${BACKUP_SERVER_IDS_MAX} server ids`,
          code: ErrorCode.BACKUP_SERVER_IDS_INVALID,
          params: sanitizeErrorParams({ max: BACKUP_SERVER_IDS_MAX }),
        });
      }
      allowed.serverIds = ids;
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

// Live preview for the Backups page's schedule picker -- a custom cron
// expression above all, but presets too, since both get the restart-overlap
// check. Advisory only (POST /settings re-validates on save), and scoped to
// backups.manage rather than reusing /api/scheduler/validate-cron: that
// router requires automation.manage, which a backups-only role lacks.
// nextRun is computed in the scheduler's own timezone, like every backup
// the job actually fires -- and by node-cron itself, the engine that fires
// it, not the panel's own calculation: that one applied classic cron's
// "day-of-month OR weekday" rule, so "0 4 1 * 1" previewed as the next 1st
// while node-cron (which requires BOTH) ran it only on a 1st that is a
// Monday, months later. bothDayFieldsRestricted lets the page say so for
// the schedules where that rule matters.
router.post("/validate-schedule", requirePermission("backups.manage"), async (req, res) => {
  try {
    const schedule = req.body?.schedule;
    const verdict = validateBackupSchedule(schedule);
    if (!verdict.valid) return res.json(verdict);

    const scheduler = req.app.get("scheduler");
    const timezone =
      scheduler?.effectiveTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const trimmed = schedule.trim();
    res.json({
      valid: true,
      nextRun: nodeCronNextRun(trimmed, timezone),
      bothDayFieldsRestricted: restrictsBothDayFields(trimmed),
      timezone,
      restartOverlaps: await getRestartOverlaps(req, scheduler, trimmed),
    });
  } catch (error) {
    log.error(`Failed to validate backup schedule: ${error.message}`);
    res.status(500).json({ valid: false, error: sanitizeError(error.message) });
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

    // Nothing in the request body is an option: isPreRestore and isPreWipe
    // are the service's own flags (restoreBackup() and /wipe set them for
    // their safety copies), which a request must not be able to set -- a
    // safety copy is kept by retention, and isPreRestore lifts the
    // restore-in-progress guard -- and whether the panel database goes in is
    // the stored backup setting's decision (SECURITY 2026-10-20: a body
    // {"includeDb":true} used to add it for any backups.manage holder).
    // Pass io for progress updates.
    const result = await backupService.createBackup({ io });

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
    const remoteRefusal = await remoteServerBackupsRefusal();
    if (remoteRefusal) return res.status(400).json(remoteRefusal);
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
// copy of it -- world save data, and if includeDb was ever turned on, the
// panel's account data (a redacted copy since 2026-10-20, without password
// hashes or sessions; older archives hold them). A role trusted to manage backups
// day-to-day is not automatically a role that should be able to walk
// away with an offline copy of everything.
// /list and /history stay deliberately ungated (read-only status routes
// are outside the matrix on purpose), but that pair is what makes this
// exposure trivially reachable without the gate below: enumerate the
// filenames, then download.
router.get("/download/:name", requirePermission("backups.download"), async (req, res) => {
  try {
    const remoteRefusal = await remoteServerBackupsRefusal();
    if (remoteRefusal) return res.status(400).json(remoteRefusal);
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

    // round 19 (backup-read-paths-ownership): deleteBackup()/restoreBackup()
    // already refuse a name that identifies another currently-colliding
    // server's own backup (see backupService.js's _findForeignBackupOwner()
    // comment) -- this download route never checked at all, so an operator
    // of one server could download another server's full backup archive
    // just by knowing (or guessing, from the predictable
    // `${serverName}_${timestamp}.zip` naming already exposed by /list's
    // pre-fix behavior) its filename. 404, not 403: matches the sibling
    // /:name/snapshot route's existing "any failure -> 404" convention
    // rather than confirming a foreign file's existence with a different
    // status code.
    const foreignOwner = await backupService._findForeignBackupOwner(safeName, backupsPath);
    if (foreignOwner) {
      return res.status(404).json({
        error: `This backup belongs to another server profile ("${foreignOwner}") that shares this backups folder -- refusing to download it here.`,
      });
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
    activeServerForLock?.id ?? null,
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

    // sweep6-lifecycle-lock-completeness: this route never checked for an
    // in-progress SteamCMD operation before extracting an archive over
    // zomboidDataPath. A default install keeps zomboidDataPath OUTSIDE
    // installPath, so this is normally a non-issue -- but nothing stops an
    // operator from nesting it inside installPath instead, and when that's
    // the configuration, a restore running while POST /install or POST
    // /steam-update is actively writing into that same tree extracts over
    // files SteamCMD has open. Same guard /wipe already claims for the
    // identical shape (2cb3ac75) and /install/steam-update claim before
    // spawning, reused here rather than a new lock -- activeSteamOperations
    // is already scoped per install path.
    if (activeServer?.installPath) {
      const normalizedRestoreTargetPath = path
        .normalize(activeServer.installPath)
        .toLowerCase();
      if (hasActiveSteamOperation(normalizedRestoreTargetPath)) {
        return res.status(409).json({
          error:
            "A Steam operation is already in progress for this path. Please wait for it to complete.",
          code: ErrorCode.STEAM_OPERATION_IN_PROGRESS_PATH,
        });
      }
    }

    // Check if server is running. checkServerRunning() collapses a FAILED
    // detection scan into a plain `false` -- indistinguishable from a
    // confirmed-stopped server -- which would let this restore silently
    // overwrite the live world save while the server might still be running
    // and holding those files open. So this fails closed on an undetermined
    // state, same as /wipe, /delete-files and chunks.js's
    // delete-chunks/delete-region.
    //
    // And the local process scan alone is not the answer for a server the
    // panel cannot see as a process: with the game in another container (a
    // docker-local setup, GH#114) the scan succeeds and finds nothing while
    // the server is up and holding the world open, so the restore went
    // ahead underneath it. resolveObservedServerRunning() is the verdict the
    // status badge, the watchdog and Discord already use -- the container's
    // own state for the Docker providers, RCON and PanelBridge alongside the
    // scan otherwise -- so this agrees with them: true refuses, null (cannot
    // tell) refuses as "can't verify".
    let observedRunning;
    try {
      observedRunning = await resolveObservedServerRunning(
        serverManager,
        req.app.get("rconService"),
      );
    } catch (error) {
      log.warn(`Could not tell whether the server is running before a restore: ${error.message}`);
      observedRunning = null;
    }
    if (observedRunning === null) {
      return res.status(503).json({
        success: false,
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      });
    }
    if (observedRunning) {
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
      // publicRestoreMessage() redacts everything except the one message
      // that deliberately needs its path visible (the rollback failure --
      // see its own comment). 2026-08-26 partial-failure-state hunt.
      // SECURITY (2026-10-05, H4): ...and only to a role that may see where
      // backups live (canSeeBackupPaths()); a restore-only role gets it
      // path-redacted, as in GET /status's lastRestore.
      const message = (await canSeeBackupPaths(req))
        ? publicRestoreMessage(result.message)
        : sanitizeError(result.message);
      res.status(400).json({ ...result, message });
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
    const remoteRefusal = await remoteServerBackupsRefusal();
    if (remoteRefusal) return res.status(400).json(remoteRefusal);

    // continuous-bug-hunt round 23: same gap and same fix as POST
    // /settings above -- this bulk-deletes real backup files for
    // whichever server is currently active, with no way for the caller to
    // confirm that's still the server they meant. See that route's own
    // comment for the full reasoning; same shared error code.
    if (req.body?.expectedServerId !== undefined) {
      const activeServer = await getActiveServer().catch(() => null);
      const currentServerId = activeServer?.id ?? null;
      if (req.body.expectedServerId !== currentServerId) {
        return res.status(409).json({
          error:
            "The active server changed since these backups were loaded. Reload before deleting.",
          code: ErrorCode.BACKUP_ACTIVE_SERVER_CHANGED,
        });
      }
    }

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
  // A multi-GB world backup over a slow line takes far longer than the
  // 5 minutes every other request gets to arrive (utils/requestBodyDeadline.js).
  allowSlowBody(),
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
    // What the free space allows the body to reach; Infinity when unknown.
    let spaceCap = Infinity;
    let freeAtStart = null;
    const insufficientSpace = (needed) => {
      const error = insufficientSpaceError(needed, freeAtStart);
      return res.status(507).json({
        error: error.message,
        code: error.errorCode,
        params: sanitizeErrorParams(error.errorParams),
      });
    };
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
      // PT1: this writes into the folder, so this creates it (the read-only
      // routes no longer do), in a data folder held to the data-folder rule.
      const backupsPath = await backupService.getBackupsPath(undefined, { create: true });
      if (!backupsPath) {
        return res
          .status(500)
          .json({
            error: "Backups folder not available. Configure the server first.",
            code: ErrorCode.BACKUPS_FOLDER_UNAVAILABLE,
          });
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
      //
      // The .tmp path itself is given a pid+random suffix (same convention
      // as utils/fileWriteQueue.js), not just `${targetPath}.tmp` -- two
      // uploads racing the SAME x-backup-filename both pass the
      // existsSync(targetPath) check above (neither has finished yet), and
      // a plain `${targetPath}.tmp` would then be one shared path both
      // streamUploadToFile() calls write into concurrently, corrupting
      // whichever "wins". The upload can run for minutes on a multi-GB
      // world backup, which is a much larger collision window than the
      // millisecond one this codebase already knows to guard timestamped
      // filenames against.
      // The backups folder sits on the volume the live world saves to: keep
      // the File Manager's free-space floor, refusing up front when the
      // announced size would cut into it and stopping the stream when a body
      // without (or with a wrong) Content-Length gets there.
      freeAtStart = await freeBytesAt(backupsPath).catch(() => null);
      if (freeAtStart !== null) {
        const announced = Number(req.headers["content-length"]);
        const incoming = Number.isFinite(announced) && announced > 0 ? announced : 0;
        if (freeAtStart - incoming < FM_LIMITS.DISK_FREE_FLOOR_BYTES) {
          log.warn(`POST /upload refused: ${incoming} bytes announced, ${freeAtStart} bytes free`);
          return insufficientSpace(incoming + FM_LIMITS.DISK_FREE_FLOOR_BYTES);
        }
        spaceCap = freeAtStart - FM_LIMITS.DISK_FREE_FLOOR_BYTES;
      }

      tmpPath = `${targetPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      const totalBytes = await streamUploadToFile(req, tmpPath, Math.min(MAX_UPLOAD_BYTES, spaceCap));

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

      // Land the file with fs.linkSync + unlink instead of a plain rename.
      // A rename would silently overwrite targetPath if the OTHER half of
      // a same-name race finished and landed its own file there while this
      // one was still streaming (the earlier existsSync check only ruled
      // that out at request start, not at this point). linkSync() fails
      // atomically with EEXIST if targetPath already exists -- no
      // check-then-act window at all, unlike a fresh existsSync check
      // immediately before the rename would still leave.
      // Land the file with fs.linkSync + unlink instead of a plain rename.
      // A rename would silently overwrite targetPath if the OTHER half of
      // a same-name race finished and landed its own file there while this
      // one was still streaming (the earlier existsSync check only ruled
      // that out at request start, not at this point). linkSync() fails
      // atomically with EEXIST if targetPath already exists -- no
      // check-then-act window at all, unlike a fresh existsSync check
      // immediately before the rename would still leave.
      try {
        fs.linkSync(tmpPath, targetPath);
      } catch (linkErr) {
        if (linkErr.code === "EEXIST") {
          fs.unlink(tmpPath, () => {});
          tmpPath = null;
          return res
            .status(409)
            .json({
              error: `A backup named "${finalName}" already exists. Delete it first or rename the upload.`,
              code: ErrorCode.BACKUP_UPLOAD_NAME_CONFLICT,
              params: sanitizeErrorParams({ name: finalName }),
            });
        }
        throw linkErr;
      }
      fs.unlinkSync(tmpPath);
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
      if (error.code === UPLOAD_TOO_LARGE_CODE && spaceCap < MAX_UPLOAD_BYTES) {
        log.warn("POST /upload stopped: the body reached the disk's free-space floor");
        return insufficientSpace(spaceCap + 1 + FM_LIMITS.DISK_FREE_FLOOR_BYTES);
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
