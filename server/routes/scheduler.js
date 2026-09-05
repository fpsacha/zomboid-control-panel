import express from 'express';
import cron from 'node-cron';
import { createLogger } from '../utils/logger.js';
const log = createLogger('API:Scheduler');
import { sanitizeError, sanitizeErrorParams } from '../utils/sanitize.js';
import { ErrorCode } from '../utils/errorCodes.js';
import {
  getScheduledTasks,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  getScheduleHistory,
  clearScheduleHistory,
  getActiveServer,
  getServer
} from '../database/init.js';
import { requirePermission } from '../services/permissions.js';
import { requiredCapabilityForScheduledCommand } from '../services/scheduler.js';
import {
  hasUnsupportedCronFieldCount,
  isCronTooFrequent,
  isValidIanaTimezone,
} from '../utils/cronValidation.js';
import { parseBoundedInteger, parseClampedInteger } from '../utils/queryNumbers.js';

export { hasUnsupportedCronFieldCount };

export function parseTaskId(value) {
  return parseBoundedInteger(value, null, 1, Number.MAX_SAFE_INTEGER);
}

// Guards against a test double or a partial app.get() mock that returns
// something truthy but not a real Socket.IO server for other keys -- a
// bare truthy check on `io` isn't enough (2026-08-26 bug hunt, scheduler
// blind-success family: added after this exact shape broke an existing
// req.app mock that returns the same object for any key).
// Exported so server.js's POST /restart -- a second, independent client
// entry point that also calls scheduler.performRestart() directly -- can
// reuse the exact same guard and event shape rather than drifting a second
// copy of it (2026-08-26 bug hunt: /server/restart turned out to be the
// same blind-success shape as /restart-now, just in a different file).
export function emitActionResult(io, payload) {
  if (typeof io?.emit === 'function') io.emit('scheduler:action_result', payload);
}

const router = express.Router();

// Task automation (create/edit/delete/run scheduled commands, trigger an
// immediate restart) is "operate the server" — technician's job per the
// role brief, not player-facing, so moderator is excluded. Applied once at
// the router level rather than per-route. Previously any logged-in role,
// including moderator, could create or run a scheduled task — including
// /restart-now.
router.use(requirePermission('automation.manage'));

// automation.manage alone only covers "manage scheduled tasks" as a
// concept — it says nothing about what a given scheduled command actually
// DOES once it fires, and a scheduled command can do anything from an
// arbitrary RCON command to a world-wide broadcast to a full server
// restart. If scheduling an action performs the action, scheduling it
// cannot cost less than performing it directly — so every curated
// classification requires the SAME capability its own direct/interactive
// route requires, not automation.manage alone:
//   restart/save        -> server.control   (matches POST /server/restart,
//                                             /server/save)
//   servermsg, bridge:*  -> server.world_events (matches POST
//                                             /server/message and most
//                                             PanelBridge world-event
//                                             routes) — except
//                                             bridge:saveWorld, which
//                                             matches server.control instead
//                                             (PanelBridge's own equivalent
//                                             of /server/save), and
//                                             bridge:triggerGunshot/
//                                             triggerAlarmSound/
//                                             sendToAdminChat, which match
//                                             players.endanger_or_impersonate
//                                             (2026-08-27, operator ruling
//                                             on ranked-bug #5 -- these
//                                             three can target a named
//                                             player, same as their direct
//                                             routes)
//   raw (unrecognised)   -> rcon.execute     (the exact power routes/rcon.js
//                                             gates behind, admin+technician
//                                             only, deliberately not
//                                             moderator)
// requiredCapabilityForScheduledCommand() in services/scheduler.js is the
// single source of truth for this mapping — both the checks below and
// executeTask()'s own dispatch draw from it, so they can never silently
// drift on what a given command needs.
//
// This closes two related but DIFFERENT gaps found the same night:
// docs/qa/kevin-adversarial-findings.md Finding 1 (raw commands reaching
// RCON with only automation.manage, fixed 4a7dc86) verified automation.manage
// against rcon.execute ONLY — a role built with only automation.manage (a
// real, supported thing to do via Roles & Permissions) could create a task
// with any RCON command and either wait for it to fire or "Run now" it
// immediately, shutting the server down or banning anyone, invisibly (the
// scheduled-task fallback in services/scheduler.js runs with skipLog:true,
// so it never appears in RCON history). NOBODY ever cross-checked
// automation.manage against server.world_events or server.control for the
// curated verbs Finding 1's fix deliberately left alone — a role with
// automation.manage but NOT server.world_events could still schedule a
// servermsg broadcast and "Run now" it, reaching the exact effect
// POST /server/message (server.world_events) exists to gate, through a
// door that only checked a different, unrelated capability.
//
// A cron fire has no request and no req.user, so the gate can't live at
// execution time for the unattended case — it has to live at the only
// moments a scheduled command can actually enter or manually run with a
// real, checkable identity behind the request: creating/editing a task
// (below), and manually triggering one via "Run now" (also request-bound,
// checked separately at that route). The cron firing itself is deliberately
// left unchecked: authorisation happened at create/edit time, when a real
// user session existed to check it against; the cron tick later is
// execution, not authorisation, and a capability check there would mean
// every existing task whose creator later loses a role starts failing
// silently on its own schedule, with nobody watching — a worse outage than
// the escalation this closes. Reuses requirePermission() itself rather than
// re-deriving the role/capability lookup — same fail-closed behaviour,
// same error shape, zero risk of drifting from what the middleware form
// does. If requirePermission finds the caller lacks the capability it
// sends the 403/401 response itself; the caller here just needs to know
// whether to stop.
async function requireCapabilityInline(capability, req, res) {
  let passed = false;
  await requirePermission(capability)(req, res, () => {
    passed = true;
  });
  return passed;
}

// Get scheduler status
router.get('/status', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const status = scheduler.getStatus();
    res.json(status);
  } catch (error) {
    log.error(`Failed to get scheduler status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set the install-wide timezone every schedule (user tasks, the backup job,
// AUTO_RESTART_CRON alike) is interpreted in. Gated by the router-level
// automation.manage check above -- this is scheduler CONFIGURATION, not an
// action a scheduled command performs, so no per-command capability layering
// applies the way it does for POST /tasks etc.
router.put('/timezone', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const timezone = typeof req.body?.timezone === 'string' ? req.body.timezone.trim() : '';
    log.info(`PUT /timezone: ${timezone}`);

    if (!timezone) {
      return res.status(400).json({ error: 'A timezone is required', code: ErrorCode.SCHEDULER_TIMEZONE_REQUIRED });
    }

    // Validated here, not just inside scheduler.setTimezone() -- refused at
    // save time with a specific error, matching every other field this
    // router validates before persisting (2026-08-29 timezone-picker card,
    // requirement 3: an invalid zone accepted here would only surface as a
    // node-cron throw the night a schedule actually tries to fire).
    if (!isValidIanaTimezone(timezone)) {
      return res.status(400).json({
        error: `"${timezone}" is not a valid timezone name (e.g. "America/New_York", "UTC")`,
        code: ErrorCode.SCHEDULER_INVALID_TIMEZONE,
        params: sanitizeErrorParams({ tz: timezone }),
      });
    }

    const status = await scheduler.setTimezone(timezone);
    res.json({ success: true, ...status });
  } catch (error) {
    log.error(`Failed to update scheduler timezone: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.put('/restart-warning', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const restartWarning = await scheduler.setRestartWarning(req.body);
    res.json({ success: true, restartWarning });
  } catch (error) {
    log.error(`Failed to update restart warning: ${error.message}`);
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

// Get all scheduled tasks
router.get('/tasks', async (req, res) => {
  try {
    const tasks = await getScheduledTasks();
    res.json({ tasks });
  } catch (error) {
    log.error(`Failed to get scheduled tasks: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Validate cron expression
router.post('/validate-cron', async (req, res) => {
  try {
    const cronExpression = req.body?.cronExpression;
    if (!cronExpression) {
      return res.status(400).json({ valid: false, error: 'cronExpression is required', code: ErrorCode.SCHEDULER_CRON_EXPRESSION_REQUIRED });
    }

    const isValid = cron.validate(cronExpression);
    if (!isValid) {
      return res.json({ valid: false, error: 'Invalid cron expression format', code: ErrorCode.SCHEDULER_INVALID_CRON_EXPRESSION });
    }

    // Keep this preview endpoint's verdict consistent with what POST /tasks
    // and PUT /tasks/:id will actually accept -- without this, a 6-field
    // expression previews as valid here and then gets refused on submit.
    if (hasUnsupportedCronFieldCount(cronExpression)) {
      return res.json({
        valid: false,
        error: 'The panel does not support seconds-precision schedules. Use exactly 5 fields: minute hour day month weekday.',
        code: ErrorCode.SCHEDULER_CRON_SECONDS_UNSUPPORTED,
      });
    }

    if (isCronTooFrequent(cronExpression)) {
      return res.json({
        valid: false,
        error: 'Tasks cannot run more frequently than every 5 minutes',
        code: ErrorCode.SCHEDULER_CRON_TOO_FREQUENT,
      });
    }

    res.json({ valid: true });
  } catch (error) {
    res.status(500).json({ valid: false, error: sanitizeError(error.message) });
  }
});

// Create a new scheduled task
router.post('/tasks', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object', code: ErrorCode.SCHEDULER_REQUEST_BODY_INVALID });
    }
    const { name, cronExpression, command, serverId } = req.body;
    log.info(`POST /tasks: name=${name}, cron=${cronExpression}, command=${typeof command === 'string' ? command.substring(0, 80) : ''}, serverId=${serverId}`);

    if (!name || !cronExpression || !command) {
      return res.status(400).json({ error: 'Name, cronExpression, and command are required', code: ErrorCode.SCHEDULER_TASK_FIELDS_REQUIRED });
    }

    // Validate input types and lengths
    if (typeof name !== 'string' || name.length > 100) {
      return res.status(400).json({ error: 'Invalid task name (max 100 chars)', code: ErrorCode.SCHEDULER_INVALID_TASK_NAME });
    }
    if (typeof command !== 'string' || command.length > 2000) {
      return res.status(400).json({ error: 'Invalid command (max 2000 chars)', code: ErrorCode.SCHEDULER_INVALID_COMMAND });
    }
    if (typeof cronExpression !== 'string' || cronExpression.length > 100) {
      return res.status(400).json({ error: 'Invalid cron expression format', code: ErrorCode.SCHEDULER_INVALID_CRON_FORMAT });
    }

    // Scheduling an action must not cost less than performing it directly --
    // see the router-level comment above for the full mapping and why.
    {
      const allowed = await requireCapabilityInline(
        requiredCapabilityForScheduledCommand(command),
        req,
        res,
      );
      if (!allowed) return;
    }

    // Validate cron expression before saving
    if (!cron.validate(cronExpression)) {
      return res.status(400).json({ error: 'Invalid cron expression. Use format: minute hour day month weekday (e.g., "0 */6 * * *" for every 6 hours)', code: ErrorCode.SCHEDULER_INVALID_CRON_EXPRESSION });
    }

    // The panel does not support seconds-precision (6-field) schedules --
    // see hasUnsupportedCronFieldCount()'s comment for why this must be
    // checked before isCronTooFrequent, not folded into it.
    if (hasUnsupportedCronFieldCount(cronExpression)) {
      return res.status(400).json({ error: 'The panel does not support seconds-precision schedules. Use exactly 5 fields: minute hour day month weekday (e.g., "0 */6 * * *").', code: ErrorCode.SCHEDULER_CRON_SECONDS_UNSUPPORTED });
    }

    // Security: Reject tasks that run more frequently than every 5 minutes to prevent DoS
    if (isCronTooFrequent(cronExpression)) {
      return res.status(400).json({ error: 'Tasks cannot run more frequently than every 5 minutes', code: ErrorCode.SCHEDULER_CRON_TOO_FREQUENT });
    }

    // Validate the target server exists, if one was explicitly given —
    // createScheduledTask() falls back to the active server when omitted.
    let resolvedServerId = serverId ?? null;
    if (resolvedServerId) {
      const target = await getServer(resolvedServerId);
      if (!target) {
        return res.status(400).json({ error: 'Target server not found', code: ErrorCode.SCHEDULER_TARGET_SERVER_NOT_FOUND });
      }
    } else {
      const active = await getActiveServer();
      resolvedServerId = active ? active.id : null;
    }

    const result = await createScheduledTask(name, cronExpression, command, resolvedServerId);
    const task = {
      id: result.id,
      name,
      cron_expression: cronExpression,
      command,
      server_id: resolvedServerId,
      enabled: 1
    };

    // Schedule the task — rollback DB entry if scheduling fails
    let scheduleResult;
    try {
      scheduleResult = scheduler.scheduleTask(task);
      if (scheduleResult === false) {
        throw new Error("Scheduler rejected the task");
      }
    } catch (schedErr) {
      log.error(`Failed to schedule task, rolling back DB entry: ${schedErr.message}`);
      await deleteScheduledTask(result.id);
      return res.status(500).json({
        error: 'Failed to schedule task: ' + sanitizeError(schedErr.message),
        code: ErrorCode.SCHEDULER_TASK_SCHEDULING_FAILED,
        params: sanitizeErrorParams({ reason: schedErr.message }),
      });
    }

    // dstWarning (2026-09-05, scheduler-time-audit): non-null only for a
    // sub-hourly (15-60 min) schedule in a DST-observing timezone -- already
    // logged server-side by scheduleTask() itself. Surfaced here too so a
    // future UI can show it without another server change (Scheduler.tsx
    // reading this field is carded separately, not part of this fix).
    res.json({ success: true, task, dstWarning: scheduleResult?.dstWarning || null });
  } catch (error) {
    log.error(`Failed to create scheduled task: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Update a scheduled task
router.put('/tasks/:id', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const { id } = req.params;
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object', code: ErrorCode.SCHEDULER_REQUEST_BODY_INVALID });
    }
    const { name, cronExpression, command, enabled, serverId } = req.body;
    log.info(`PUT /tasks/${id}: name=${name}, cron=${cronExpression}, enabled=${enabled}, serverId=${serverId}`);

    const taskId = parseTaskId(id);
    if (taskId === null) {
      return res.status(400).json({ error: 'Invalid task ID', code: ErrorCode.SCHEDULER_INVALID_TASK_ID });
    }

    // Validate name and command length
    if (name !== undefined && (typeof name !== 'string' || name.length > 100)) {
      return res.status(400).json({ error: 'Invalid task name (max 100 characters)', code: ErrorCode.SCHEDULER_INVALID_TASK_NAME });
    }
    if (command !== undefined && (typeof command !== 'string' || command.length > 2000)) {
      return res.status(400).json({ error: 'Invalid command (max 2000 characters)', code: ErrorCode.SCHEDULER_INVALID_COMMAND });
    }
    // Only gate on the command's required capability when THIS request is
    // actually setting the command -- a caller who only toggles enabled/
    // name/serverId on a task someone else created shouldn't need any
    // particular capability just because that task's untouched, pre-existing
    // command happens to need one.
    if (command !== undefined) {
      const allowed = await requireCapabilityInline(
        requiredCapabilityForScheduledCommand(command),
        req,
        res,
      );
      if (!allowed) return;
    }
    if (
      enabled !== undefined &&
      ![true, false, 0, 1].includes(enabled)
    ) {
      return res.status(400).json({ error: 'enabled must be a boolean or 0/1', code: ErrorCode.SCHEDULER_INVALID_ENABLED_VALUE });
    }
    const normalizedEnabled =
      enabled === undefined ? undefined : (enabled === true || enabled === 1 ? 1 : 0);

    // Validate cron expression before saving to prevent DB/scheduler inconsistency
    if (cronExpression && !cron.validate(cronExpression)) {
      return res.status(400).json({ error: 'Invalid cron expression. Use format: minute hour day month weekday (e.g., "0 */6 * * *" for every 6 hours)', code: ErrorCode.SCHEDULER_INVALID_CRON_EXPRESSION });
    }

    // The panel does not support seconds-precision (6-field) schedules --
    // see hasUnsupportedCronFieldCount()'s comment for why this must be
    // checked before isCronTooFrequent, not folded into it.
    if (cronExpression && hasUnsupportedCronFieldCount(cronExpression)) {
      return res.status(400).json({ error: 'The panel does not support seconds-precision schedules. Use exactly 5 fields: minute hour day month weekday (e.g., "0 */6 * * *").', code: ErrorCode.SCHEDULER_CRON_SECONDS_UNSUPPORTED });
    }

    // Security: Reject tasks that run more frequently than every 5 minutes to prevent DoS
    if (cronExpression && isCronTooFrequent(cronExpression)) {
      return res.status(400).json({ error: 'Tasks cannot run more frequently than every 5 minutes', code: ErrorCode.SCHEDULER_CRON_TOO_FREQUENT });
    }

    // Validate the target server, if reassignment was requested
    if (serverId !== undefined && serverId !== null) {
      const target = await getServer(serverId);
      if (!target) {
        return res.status(400).json({ error: 'Target server not found', code: ErrorCode.SCHEDULER_TARGET_SERVER_NOT_FOUND });
      }
    }

    const tasksBeforeUpdate = await getScheduledTasks();
    const previousTaskRecord = Array.isArray(tasksBeforeUpdate)
      ? tasksBeforeUpdate.find((task) => String(task.id) === String(taskId))
      : null;
    const previousTask = previousTaskRecord
      ? { ...previousTaskRecord }
      : null;

    const updated = await updateScheduledTask(taskId, name, cronExpression, command, normalizedEnabled, serverId);
    if (!updated) {
      return res.status(404).json({ error: 'Task not found', code: ErrorCode.SCHEDULER_TASK_NOT_FOUND });
    }

    // Reschedule from the merged record, not the request body: a partial update
    // (e.g. the enable/disable toggle) would otherwise re-arm the job without
    // its pinned server and run it against whichever server is active.
    let dstWarning = null;
    if (updated.enabled) {
      try {
        const scheduled = scheduler.scheduleTask({
          id: taskId,
          name: updated.name,
          cron_expression: updated.cron_expression,
          command: updated.command,
          server_id: updated.server_id,
          enabled: 1
        });
        if (scheduled === false) {
          throw new Error("Scheduler rejected the updated task");
        }
        // 2026-09-05, scheduler-time-audit: same field POST /tasks returns,
        // see that route's own comment.
        dstWarning = scheduled?.dstWarning || null;
      } catch (schedErr) {
        log.error(`Failed to reschedule task ${taskId}, reverting DB: ${schedErr.message}`);
        if (previousTask) {
          try {
            await updateScheduledTask(
              taskId,
              previousTask.name,
              previousTask.cron_expression,
              previousTask.command,
              previousTask.enabled,
              previousTask.server_id,
            );
            if (previousTask.enabled) {
              scheduler.scheduleTask(previousTask);
            } else {
              scheduler.cancelTask(taskId);
            }
          } catch (rollbackError) {
            log.error(
              `Failed to restore scheduled task ${taskId} after reschedule failure: ${rollbackError.message}`,
            );
          }
        } else {
          log.warn(`Could not restore scheduled task ${taskId}: previous record was unavailable`);
        }
        return res.status(500).json({
          error: 'Failed to reschedule task: ' + sanitizeError(schedErr.message),
          code: ErrorCode.SCHEDULER_TASK_RESCHEDULE_FAILED,
          params: sanitizeErrorParams({ reason: schedErr.message }),
        });
      }
    } else {
      scheduler.cancelTask(taskId);
    }

    res.json({ success: true, message: 'Task updated', dstWarning });
  } catch (error) {
    log.error(`Failed to update scheduled task: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Delete a scheduled task
router.delete('/tasks/:id', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const { id } = req.params;
    log.info(`DELETE /tasks/${id}`);

    const taskId = parseTaskId(id);
    if (taskId === null) {
      return res.status(400).json({ error: 'Invalid task ID', code: ErrorCode.SCHEDULER_INVALID_TASK_ID });
    }

    const deleted = await deleteScheduledTask(taskId);
    if (!deleted) {
      return res.status(404).json({ error: 'Task not found', code: ErrorCode.SCHEDULER_TASK_NOT_FOUND });
    }
    scheduler.cancelTask(taskId);

    res.json({ success: true, message: 'Task deleted' });
  } catch (error) {
    log.error(`Failed to delete scheduled task: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Run a scheduled task on demand. Goes through Scheduler.runTaskNow() — the
// same dispatch a cron fire uses — so special commands (restart/save/
// servermsg/bridge:) are handled correctly instead of being sent to RCON as
// a literal string. A restart can run for several minutes (warning
// countdown), so this fires in the background and returns immediately;
// completion shows up in the schedule history.
router.post('/tasks/:id/run', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const { id } = req.params;
    const taskId = parseTaskId(id);
    if (taskId === null) {
      return res.status(400).json({ error: 'Invalid task ID', code: ErrorCode.SCHEDULER_INVALID_TASK_ID });
    }

    const tasks = await getScheduledTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found', code: ErrorCode.SCHEDULER_TASK_NOT_FOUND });
    }

    // Unlike a cron fire, "Run now" IS a live request with a real req.user
    // -- check the STORED command (not request body; there isn't one here)
    // against the caller's CURRENT capabilities, not whoever created the
    // task. A task saved by someone who legitimately held the required
    // capability at the time still needs it to be manually triggered by
    // someone who doesn't hold it now -- this is HALF of the
    // schedule-is-cheaper-than-doing escalation this whole check exists to
    // close (the other half is create/edit-time, above); the cron firing
    // itself is deliberately left unchecked, see the router-level comment.
    {
      const allowed = await requireCapabilityInline(
        requiredCapabilityForScheduledCommand(task.command),
        req,
        res,
      );
      if (!allowed) return;
    }

    log.info(`POST /tasks/${taskId}/run: ${task.name}`);
    const io = req.app.get('io');
    // Same rationale as /restart-now just below in this file: the response
    // only confirms the task was accepted, runTaskNow() runs in the
    // background and reports its real outcome here once it resolves
    // (2026-08-26 bug hunt, scheduler blind-success family).
    scheduler.runTaskNow(task)
      .then((result) => {
        emitActionResult(io, {
          kind: 'task',
          taskName: task.name,
          success: !!result?.success,
          message: result?.message || (result?.success ? 'Task completed' : 'Task failed'),
        });
      })
      .catch(err => {
        log.error(`Manual run of task ${taskId} failed: ${err.message}`);
        emitActionResult(io, {
          kind: 'task',
          taskName: task.name,
          success: false,
          message: err.message,
        });
      });

    res.json({ success: true, message: 'Task triggered' });
  } catch (error) {
    log.error(`Failed to run scheduled task: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Trigger immediate restart
router.post('/restart-now', async (req, res) => {
  try {
    // This is not a scheduled-task action -- there is no stored command to
    // classify via requiredCapabilityForScheduledCommand() the way POST
    // /tasks, PUT /tasks/:id and POST /tasks/:id/run already do above. It is
    // a direct, immediate call into scheduler.performRestart(), the exact
    // same live action POST /server/restart performs under server.control.
    // automation.manage alone ("manage scheduled tasks") only covers the
    // scheduling half of that same reasoning: someone holding it but not
    // server.control could restart the live server right now through this
    // door, which /server/restart's own gate exists specifically to
    // require. bug-hunt-2026-08-27, Pam's undersell pass, routed as a
    // bypass row rather than a label fix.
    const allowed = await requireCapabilityInline('server.control', req, res);
    if (!allowed) return;

    const activeServer = await getActiveServer();
    if (activeServer?.isRemote) {
      return res.status(400).json({ error: 'Cannot restart a remote server. The process is not managed by this panel.', code: ErrorCode.SCHEDULER_RESTART_REMOTE_NOT_SUPPORTED });
    }

    const scheduler = req.app.get('scheduler');
    const io = req.app.get('io');
    const warningMinutes = req.body?.warningMinutes;

    // Parse and validate warningMinutes (0-60 range)
    let parsedWarningMinutes = parseBoundedInteger(
      warningMinutes,
      5,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    log.info(`POST /restart-now: warningMinutes=${warningMinutes}`);
    if (parsedWarningMinutes > 60) {
      parsedWarningMinutes = 60; // Cap at 60 minutes
    }

    // Run restart in background, passing warningMinutes directly. Labeled
    // "Manual restart" in Schedule History rather than performRestart()'s
    // "Auto Restart" default -- this IS a human clicking Restart Now, and
    // the history record should say so if it later fails. See
    // docs/qa/kevin-adversarial-findings.md Finding 3.
    //
    // The HTTP response below only confirms the restart was ACCEPTED --
    // performRestart() runs in the background (the countdown + graceful
    // shutdown can take minutes) and already computes a real {success,
    // message} on every path, already logged to Schedule History. This is
    // the one place that outcome can reach the client in real time instead
    // of only being discoverable by someone who thinks to go check history
    // (2026-08-26 bug hunt, scheduler blind-success family -- restart-now
    // used to report success:true unconditionally regardless of what
    // actually happened).
    scheduler.performRestart(parsedWarningMinutes, { label: 'Manual restart' })
      .then((result) => {
        emitActionResult(io, {
          kind: 'restart',
          success: !!result?.success,
          message: result?.message || (result?.success ? 'Restart completed' : 'Restart failed'),
        });
      })
      .catch(err => {
        log.error(`Restart failed: ${err.message}`);
        emitActionResult(io, {
          kind: 'restart',
          success: false,
          message: err.message,
        });
      });

    // Report the value actually used, not just the request -- the operator
    // may have typed something above the 60-minute cap above (the client's
    // own NumberInput min/max are decorative, not a client-side clamp), and
    // the toast this feeds should say what really happened, not echo back
    // whatever they typed.
    res.json({ success: true, message: 'Restart initiated', warningMinutes: parsedWarningMinutes });
  } catch (error) {
    log.error(`Failed to trigger restart: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Common cron presets for convenience
router.get('/cron-presets', (req, res) => {
  res.json({
    presets: [
      { name: 'Every hour', cron: '0 * * * *' },
      { name: 'Every 2 hours', cron: '0 */2 * * *' },
      { name: 'Every 4 hours', cron: '0 */4 * * *' },
      { name: 'Every 6 hours', cron: '0 */6 * * *' },
      { name: 'Every 12 hours', cron: '0 */12 * * *' },
      { name: 'Daily at midnight', cron: '0 0 * * *' },
      { name: 'Daily at 6 AM', cron: '0 6 * * *' },
      { name: 'Daily at noon', cron: '0 12 * * *' },
      { name: 'Daily at 6 PM', cron: '0 18 * * *' },
      { name: 'Every 30 minutes', cron: '*/30 * * * *' },
      { name: 'Every 15 minutes', cron: '*/15 * * * *' }
    ]
  });
});

// Get schedule execution history
router.get('/history', async (req, res) => {
  try {
    const limit = parseClampedInteger(req.query.limit, 100, 1, 500);
    const taskId =
      req.query.taskId === undefined
        ? null
        : parseBoundedInteger(req.query.taskId, null, 1, Number.MAX_SAFE_INTEGER);
    if (req.query.taskId !== undefined && taskId === null) {
      return res.status(400).json({ error: 'Invalid task ID', code: ErrorCode.SCHEDULER_INVALID_TASK_ID });
    }
    const history = await getScheduleHistory(limit, taskId);
    res.json({ history });
  } catch (error) {
    log.error(`Failed to get schedule history: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Clear schedule execution history
router.delete('/history', async (req, res) => {
  try {
    await clearScheduleHistory();
    res.json({ success: true, message: 'History cleared' });
  } catch (error) {
    log.error(`Failed to clear schedule history: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
