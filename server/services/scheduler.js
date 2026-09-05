import fs from "fs";
import path from "path";
import cron from "node-cron";
import { createLogger } from "../utils/logger.js";
const log = createLogger("Scheduler");
import panelBridge from "./panelBridge.js";
import { RconService } from "./rcon.js";
import { ServerManager } from "./serverManager.js";
import { runManagedLifecycle } from "./managedContainer.js";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
} from "./lifecycleCoordinator.js";
import { createBackupIfChanged } from "../utils/configBackup.js";
import {
  candidateIniPaths,
  refreshLaunchTargetBeforeStart,
} from "../routes/server.js";
import {
  getScheduledTasks,
  updateTaskLastRun,
  logServerEvent,
  logScheduleExecution,
  getActiveServer,
  getServer,
  getSetting,
  setSetting,
} from "../database/init.js";
import {
  isCronTooFrequent,
  isSupportedFiveFieldCron,
  isValidIanaTimezone,
  isRawOffsetTimezone,
  dstFallBackWarning,
} from "../utils/cronValidation.js";
import {
  defaultRestartWarningSettings,
  formatRestartWarning,
  getRestartWarningNotice,
  getRestartWarningPresetTemplates,
  normalizeRestartWarningSettings,
  RESTART_WARNING_SETTING_KEY,
  validateRestartWarningSettings,
} from "../utils/restartWarning.js";

// Settings-store key for the install-wide scheduler timezone (2026-08-29,
// timezone-picker card). ONE zone for the whole install, not per-schedule --
// per-schedule is strictly more powerful but multiplies the migration
// question (this file's whole hard problem) by every task an operator has
// ever created, for a granularity nobody asked for; every cron.schedule()
// call in this file (user tasks, the backup job, AUTO_RESTART_CRON) reads
// the SAME resolved value, so the operator has exactly one place to look
// and one place to change.
const SCHEDULER_TIMEZONE_SETTING_KEY = "schedulerTimezone";
// Built-in PanelBridge actions exposed to the scheduler via the
// `bridge:<action>` command syntax. Optional JSON args follow the action,
// e.g. `bridge:triggerBlizzard {"duration":2}`. Only the actions listed
// here can be invoked from a scheduled task — keeps the surface small
// and intentional rather than letting arbitrary handlers run on a cron.
const SCHEDULABLE_BRIDGE_ACTIONS = new Set([
  "triggerBlizzard",
  "triggerTropicalStorm",
  "triggerStorm",
  "stopWeather",
  "startRain",
  "stopRain",
  "setSnow",
  "triggerLightning",
  "triggerGunshot",
  "triggerAlarmSound",
  "restoreUtilities",
  "shutOffUtilities",
  "saveWorld",
  "sendToServerChat",
  "sendToAdminChat",
]);

// The single source of truth for which scheduled-task commands are the
// curated, validated verbs automation.manage alone is meant to reach, vs.
// "raw" -- forwarded to rconService.execute() as an arbitrary RCON command,
// the same power routes/rcon.js gates behind rcon.execute. executeTask()'s
// dispatch and routes/scheduler.js's write-time/run-time permission checks
// both call this so the two can never silently drift apart on what counts
// as "safe" -- see docs/qa/kevin-adversarial-findings.md Finding 1.
export function classifyScheduledCommand(command) {
  const commandLower = String(command ?? "").toLowerCase();
  if (commandLower === "restart") return "restart";
  if (commandLower === "save") return "save";
  if (commandLower.startsWith("servermsg ")) return "servermsg";
  if (commandLower.startsWith("bridge:")) return "bridge";
  return "raw";
}

// Extracts the action name from a `bridge:<action>` scheduled command (the
// part before any JSON args blob), preserving original casing since
// PanelBridge action names are case-sensitive. Shared by executeBridgeAction
// (which needs the name to dispatch) and requiredCapabilityForScheduledCommand
// below (which needs it to tell saveWorld apart from every other bridge:
// action) so the two can't parse it two different ways.
function parseBridgeActionName(rawCommand) {
  const body = rawCommand.slice("bridge:".length).trim();
  const firstSpace = body.indexOf(" ");
  return (firstSpace === -1 ? body : body.slice(0, firstSpace)).trim();
}

// The single source of truth for which panel capability a scheduled command
// requires -- the SAME capability its direct/interactive equivalent route
// requires, because scheduling an action must not cost less than performing
// it (docs/qa/kevin-adversarial-findings.md Finding 1 established this for
// raw/rcon.execute specifically; this generalises it to the other three
// curated classifications, closing the gap Finding 1's own fix never
// checked -- automation.manage was verified against rcon.execute, never
// against server.world_events or server.control).
// routes/scheduler.js's write-time (POST/PUT /tasks) and run-time
// (POST /tasks/:id/run) permission checks all call this, so they can never
// silently drift on what a given command needs -- same reasoning as
// classifyScheduledCommand's own header comment, extended.
//
// bridge:saveWorld is the one bridge: action that is NOT a world event: it's
// PanelBridge's own equivalent of POST /server/save and POST
// /panel-bridge/world/save, both gated server.control (panelBridge.js:2003).
//
// 2026-08-27 (operator ruling on ranked-bug #5): server.world_events itself
// split, and three more schedulable bridge: actions went with the targeted
// half -- triggerGunshot and triggerAlarmSound both accept {username} and,
// per the Lua handler, resolve it to that player's exact x/y/z before
// playing (services/panelBridge.js triggerGunshot/triggerAlarmSound ->
// PanelBridge.lua handlers.triggerGunshot/triggerAlarmSound), the same
// attraction-sound-at-a-player shape as POST /panel-bridge/sound/gunshot
// and /sound/alarm; sendToAdminChat is PanelBridge's own equivalent of POST
// /panel-bridge/chat/admin. All three now require
// players.endanger_or_impersonate, matching their direct routes, not
// server.world_events -- otherwise a moderator (who kept server.world_events
// but lost players.endanger_or_impersonate in the split) could still reach
// them by scheduling instead of calling the route directly, the exact
// "scheduling an action must not cost less than performing it" gap this
// function exists to close, just reopened by the split. createNoise
// (/sound/noise's equivalent, also {username}-capable) is NOT in
// SCHEDULABLE_BRIDGE_ACTIONS, so it isn't reachable via the scheduler at
// all -- nothing to remap there.
const ENDANGER_OR_IMPERSONATE_BRIDGE_ACTIONS = new Set([
  "triggerGunshot",
  "triggerAlarmSound",
  "sendToAdminChat",
]);

export function requiredCapabilityForScheduledCommand(command) {
  const kind = classifyScheduledCommand(command);
  if (kind === "restart" || kind === "save") return "server.control";
  if (kind === "servermsg") return "server.world_events";
  if (kind === "bridge") {
    const action = parseBridgeActionName(String(command ?? ""));
    if (action === "saveWorld") return "server.control";
    if (ENDANGER_OR_IMPERSONATE_BRIDGE_ACTIONS.has(action)) {
      return "players.endanger_or_impersonate";
    }
    return "server.world_events";
  }
  return "rcon.execute"; // kind === "raw"
}

export class Scheduler {
  constructor(rconService, serverManager) {
    this.rconService = rconService;
    this.serverManager = serverManager;
    this.backupService = null;
    this.discordBot = null;
    this.io = null;
    this.jobs = new Map();
    this.jobLabels = new Map(); // task id -> human label, for reporting next run
    this.autoRestartJob = null;
    this.backupJob = null;
    this.modUpdateRestartPending = false;
    this.restartInProgress = false;
    this.runningTasks = new Set(); // Track tasks currently executing to prevent duplicates
    // The install-wide timezone every cron.schedule() call in this class
    // uses, resolved (and migrated, if needed) once by resolveTimezone()
    // before any scheduling happens -- see that method's own comment.
    // Cached here, not re-read from settings on every scheduleTask() call,
    // because it only ever changes on an explicit operator action
    // (setTimezone()), which re-resolves and reschedules everything itself.
    this.effectiveTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.configuredTimezone = null; // the raw settings value, once resolved
    this.timezoneFallback = null; // {configured, effective} when the configured zone is invalid
    this.restartWarning = defaultRestartWarningSettings();
  }

  setBackupService(backupService) {
    this.backupService = backupService;
  }

  setDiscordBot(discordBot) {
    this.discordBot = discordBot;
  }

  // Wired once from index.js. Lets performRestart() push server:status at
  // its own VERIFIED stop/start transitions (see its own comments) instead
  // of leaving the client blind for the whole restart -- previously up to
  // 60+ seconds with only a terminal scheduler:action_result event once the
  // entire restart resolved. Optional: a scheduler constructed without it
  // (e.g. in a test) just skips the emit, exactly like every other
  // `this.io?.emit(...)` guard in this class.
  setIo(io) {
    this.io = io;
  }

  // Only emits when the claim is already VERIFIED true by the caller (a
  // confirmed process-exit poll, a confirmed process/RCON-up poll, or
  // Docker's OWN restart action -- which per dockerClient.js's
  // lifecycleTimeoutMs comment "answers only once the action completes"),
  // never a merely-requested/accepted state -- the same distinction
  // server/routes/server.js's /start and /stop routes already draw (see
  // their own comments) to avoid the exact "confident but unconfirmed
  // claim" shape the 2026-08-26 bug hunt fixed for /stop's graceful path.
  // Deliberately does NOT go through checkServerStatusNow() (server/
  // index.js) -- these transitions are already independently confirmed
  // here, so there is nothing left for that function to verify -- but see
  // its own header comment for why every OTHER "did state change" decision
  // still funnels through it alone.
  _emitVerifiedTransition(running) {
    if (typeof this.io?.emit === "function") {
      this.io.emit("server:status", { running });
    }
  }

  // Resolves the install-wide scheduler timezone, migrating a not-yet-
  // configured install and failing loudly-but-running on an invalid stored
  // value. Called once at boot (before anything is scheduled) and again
  // from setTimezone() when the operator changes it -- never per-task,
  // since the resolved value only changes on one of those two events.
  //
  // MIGRATION (requirement 1 of the card): an install upgrading from before
  // this setting existed must see NO CHANGE in real-world fire times until
  // the operator deliberately picks a different zone. The setting's
  // ABSENCE (never configured) is therefore initialized to the CURRENTLY
  // EFFECTIVE zone -- not a hardcoded default like UTC, which would
  // silently move every existing non-UTC install's schedules the moment
  // this feature shipped -- and PERSISTED immediately, so a later change to
  // the process's own environment (a redeployed container with a different
  // host TZ, say) can never retroactively alter what an already-migrated
  // install resolves to. This mirrors the exact pattern
  // getScheduledTasks()'s own server_id migration already uses in
  // database/init.js: detect "never set," compute the value that preserves
  // current behaviour, persist it once, done.
  //
  // FAILING ZONE (requirement 4): a stored zone can stop being valid after
  // migration (tzdata removes a deprecated name, or db.json was restored
  // onto a different machine). Refusing to start is wrong -- every schedule
  // on the install would silently stop firing, the exact failure mode this
  // whole hunt is about. Silently substituting UTC is worse -- a wrong
  // answer presented as a right one. So: log a clear, loud error, record
  // the mismatch on `timezoneFallback` (surfaced by getStatus() so the UI
  // can show it even to nobody currently reading logs), fall back to the
  // process's own resolved zone, and keep scheduling normally.
  async resolveTimezone() {
    const processDefault = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let stored = await getSetting(SCHEDULER_TIMEZONE_SETTING_KEY);

    if (stored == null) {
      stored = processDefault;
      try {
        await setSetting(SCHEDULER_TIMEZONE_SETTING_KEY, stored);
        log.info(
          `Scheduler timezone was not previously configured -- initialized to the currently-effective zone (${stored}) so upgrading does not move any existing schedule's real fire time`,
        );
      } catch (error) {
        // Don't let a failed persist block scheduling from starting --
        // worst case this migration re-runs (harmlessly, same result) on
        // the next boot before the write eventually succeeds.
        log.warn(`Could not persist the migrated scheduler timezone: ${error.message}`);
      }
    }

    this.configuredTimezone = stored;

    if (!isValidIanaTimezone(stored)) {
      // 2026-09-05, scheduler-time-audit: a bare offset like "-05:00" used
      // to pass isValidIanaTimezone() and get silently kept forever (it
      // never becomes invalid on its own -- there's no tzdata entry to
      // remove). Now that the validator rejects it, an install that already
      // had one saved needs a message that says so specifically, not the
      // generic "deprecated name / restored database" one, which would be
      // actively misleading here: nothing was removed or restored, this
      // value was never a real zone to begin with.
      log.error(
        isRawOffsetTimezone(stored)
          ? `Configured scheduler timezone "${stored}" is a fixed UTC offset, not a real timezone -- it never observes daylight saving, so every schedule on this install has been silently drifting by an hour from the operator's actual local time across each DST transition. Falling back to ${processDefault} so schedules keep firing. Pick a real zone (e.g. "America/New_York") in Scheduler settings.`
          : `Configured scheduler timezone "${stored}" is not a valid IANA zone (tzdata may have removed a deprecated name, or this database was restored from a different machine) -- falling back to ${processDefault} so schedules keep firing. Fix this in Scheduler settings.`,
      );
      this.timezoneFallback = { configured: stored, effective: processDefault };
      this.effectiveTimezone = processDefault;
      return this.effectiveTimezone;
    }

    this.timezoneFallback = null;
    this.effectiveTimezone = stored;
    return this.effectiveTimezone;
  }

  // Operator-facing setter (routes/scheduler.js's PUT /timezone). Validates,
  // persists, re-resolves, and immediately reschedules EVERY cron.schedule()
  // call this class owns under the new zone -- user tasks, the backup job,
  // AUTO_RESTART_CRON alike, per the card's explicit requirement that a
  // timezone setting covering only some of the three would be worse than
  // none (the UI would then be confidently wrong about the other two).
  async setTimezone(newZone) {
    if (!isValidIanaTimezone(newZone)) {
      const error = new Error(`"${newZone}" is not a valid IANA timezone`);
      error.code = "SCHEDULER_INVALID_TIMEZONE";
      throw error;
    }

    await setSetting(SCHEDULER_TIMEZONE_SETTING_KEY, newZone);
    await this.resolveTimezone();

    const tasks = await getScheduledTasks();
    for (const task of tasks) {
      if (task.enabled) this.scheduleTask(task);
    }
    this.setupAutoRestart();
    await this.setupBackupSchedule();

    log.info(`Scheduler timezone changed to ${this.effectiveTimezone} -- rescheduled ${tasks.filter((t) => t.enabled).length} task(s), auto-restart, and the backup job`);
    return this.getStatus();
  }

  async loadRestartWarningSettings() {
    try {
      this.restartWarning = normalizeRestartWarningSettings(
        await getSetting(RESTART_WARNING_SETTING_KEY),
      );
    } catch (error) {
      this.restartWarning = defaultRestartWarningSettings();
      log.warn(`Could not load restart warning settings: ${error.message}`);
    }
    return this.restartWarning;
  }

  async setRestartWarning(settings) {
    const normalized = validateRestartWarningSettings(settings);
    await setSetting(RESTART_WARNING_SETTING_KEY, normalized);
    this.restartWarning = normalized;
    return this.restartWarning;
  }

  async init() {
    // Resolve (and migrate, if needed) the timezone BEFORE anything is
    // scheduled -- every scheduling step below reads this.effectiveTimezone.
    await this.resolveTimezone();
    await this.loadRestartWarningSettings();

    // Load saved scheduled tasks
    await this.loadScheduledTasks();

    // Setup auto-restart if enabled
    this.setupAutoRestart();

    // Setup backup schedule if enabled
    await this.setupBackupSchedule();

    log.info(`Scheduler initialized (timezone: ${this.effectiveTimezone})`);
  }

  async loadScheduledTasks() {
    try {
      const tasks = await getScheduledTasks();

      if (!tasks || !Array.isArray(tasks)) {
        log.info("No scheduled tasks found");
        return;
      }

      for (const task of tasks) {
        if (task.enabled) {
          const scheduled = this.scheduleTask(task);
          if (!scheduled) {
            log.warn(
              `Failed to schedule task ${task.id} (${task.name}) - see previous errors`,
            );
          }
        }
      }

      log.info(`Loaded ${tasks.length} scheduled tasks`);
    } catch (error) {
      log.error(`Failed to load scheduled tasks: ${error.message}`);
    }
  }

  scheduleTask(task) {
    if (
      !isSupportedFiveFieldCron(task.cron_expression) ||
      isCronTooFrequent(task.cron_expression)
    ) {
      log.error(
        `Invalid cron expression for task ${task.id} (${task.name}): ${task.cron_expression}`,
      );
      return false;
    }

    // Cancel existing job if any
    if (this.jobs.has(task.id)) {
      this.jobs.get(task.id).stop();
    }

    const job = cron.schedule(task.cron_expression, () => this.runTaskNow(task), {
      timezone: this.effectiveTimezone,
    });

    this.jobs.set(task.id, job);
    this.jobLabels.set(task.id, task.name || task.command || "task");
    log.info(`Scheduled task: ${task.name} (${task.cron_expression})`);

    // 2026-09-05, scheduler-time-audit: nothing silent -- log it server-side
    // now, and hand it back so the create/update route can surface it in
    // the API response (Scheduler.tsx reading that field is carded
    // separately). Non-null return is still truthy/`!== false`, so this
    // does not change either existing caller's success/failure check.
    const dstWarning = dstFallBackWarning(
      task.cron_expression,
      this.effectiveTimezone,
      task.name,
    );
    if (dstWarning) log.warn(dstWarning);
    return { scheduled: true, dstWarning };
  }

  // Runs a task through the same dispatch as its cron trigger (restart/save/
  // servermsg/bridge: special-casing in executeTask), so a manual "run now"
  // behaves identically to the scheduled fire instead of shelling the raw
  // command string straight to RCON.
  // Returns {success, message} -- previously implicit `undefined` on every
  // path, including failure (this method already caught and logged its own
  // errors to Schedule History, so nothing rethrew and a caller had no way
  // to learn the outcome without a second, separate history query). The
  // route now uses this to report the real result over the socket instead
  // of a blind "Task triggered" (2026-08-26 bug hunt, scheduler
  // blind-success family).
  async runTaskNow(task) {
    if (this.runningTasks.has(task.id)) {
      log.debug(
        `Skipping duplicate execution of task ${task.name} (already running)`,
      );
      return { success: false, message: "Already running" };
    }

    this.runningTasks.add(task.id);
    log.info(`Executing scheduled task: ${task.name}`);
    const startTime = Date.now();
    try {
      await this.executeTask(task);
      const duration = Date.now() - startTime;
      await updateTaskLastRun(task.id);
      const message = "Completed successfully";
      await logScheduleExecution(
        task.id,
        task.name,
        task.command,
        true,
        message,
        duration,
      );
      await logServerEvent("scheduled_task", `Executed: ${task.name}`);
      return { success: true, message };
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error(`Scheduled task failed ${task.name}: ${error.message}`);
      await logScheduleExecution(
        task.id,
        task.name,
        task.command,
        false,
        error.message,
        duration,
      );
      await logServerEvent(
        "scheduled_task_error",
        `${task.name}: ${error.message}`,
      );
      return { success: false, message: error.message };
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  /**
   * Soonest upcoming run across user tasks, auto-restart and scheduled backup.
   * "3 tasks" is not actionable; "restart in 2h 14m" is, so the dashboard asks
   * for a time rather than a count.
   * @returns {{ label: string, at: string } | null}
   */
  getNextRun() {
    const candidates = [];
    const push = (job, label) => {
      if (!job || typeof job.getNextRun !== "function") return;
      try {
        const at = job.getNextRun();
        if (at instanceof Date && Number.isFinite(at.getTime())) {
          candidates.push({ label, at });
        }
      } catch {
        /* a job with no computable next run simply does not compete */
      }
    };

    for (const [id, job] of this.jobs) {
      push(job, this.jobLabels.get(id) || "task");
    }
    push(this.autoRestartJob, "auto restart");
    push(this.backupJob, "backup");

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.at - b.at);
    return {
      label: candidates[0].label,
      at: candidates[0].at.toISOString(),
    };
  }

  async executeTask(task) {
    const commandKind = classifyScheduledCommand(task.command);

    // Resolve which RconService/ServerManager to run this task against.
    // Tasks targeting the currently-active server reuse the shared
    // singletons (unchanged behaviour, zero overhead — the only case that
    // exists for a single-server panel). Tasks targeting a DIFFERENT server
    // get their own throwaway instances instead: RconService.reloadConfig()
    // disconnects before reconnecting, so reusing the shared instance would
    // hijack the whole panel's live RCON/dashboard/UI for this task's
    // entire run — several minutes for a `restart` with warning countdown.
    const { rconService, serverManager, cleanup } =
      await this._resolveServicesForTask(task);

    try {
      // Handle special commands - skip logging for automated scheduled tasks
      if (commandKind === "restart") {
        const result = await this.performRestart(null, {
          rconService,
          serverManager,
        });
        // If restart was skipped (already in progress), throw to mark task as failed
        if (
          !result.success &&
          result.message === "Restart already in progress"
        ) {
          throw new Error("Restart skipped - already in progress");
        }
      } else if (commandKind === "save") {
        const saved = await rconService.save({ skipLog: true });
        if (!saved?.success) {
          throw new Error(`Save failed: ${saved?.error || "unknown error"}`);
        }
      } else if (commandKind === "servermsg") {
        // Preserve original casing for the message text
        const message = task.command.substring(10);
        const sent = await rconService.serverMessage(message, {
          skipLog: true,
        });
        if (!sent?.success) {
          throw new Error(
            `Broadcast failed: ${sent?.error || "unknown error"}`,
          );
        }
      } else if (commandKind === "bridge") {
        // PanelBridge action: `bridge:<action>` optionally followed by a
        // JSON args object. Validates against the SCHEDULABLE_BRIDGE_ACTIONS
        // allow list so we don't accidentally let admins schedule god-mode
        // toggles. PanelBridge is a single module-level singleton tied to
        // whatever server is currently active (its file-based bridge path
        // follows PZ_SAVE_PATH) — unlike RconService/ServerManager it can't
        // be spun up as a throwaway instance, so a bridge: task targeting a
        // non-active server fails loudly instead of silently running
        // against the wrong server.
        if (cleanup) {
          throw new Error(
            "bridge: actions only support the currently active server " +
              "(PanelBridge has no per-server instancing yet) — reassign " +
              "this task or switch the active server before it fires",
          );
        }
        await this.executeBridgeAction(task.command);
      } else {
        // commandKind === "raw": arbitrary RCON command, the same power
        // routes/rcon.js's POST /execute gates behind rcon.execute. A cron
        // fire has no request and no req.user to check a permission
        // against, so the gate lives upstream instead, at the only points
        // a raw command can actually enter or run: routes/scheduler.js
        // requires rcon.execute (in addition to automation.manage) to save
        // a task whose command isn't one of the three kinds above, and
        // again to manually "Run now" one — both of those ARE request-bound.
        // By the time a raw command reaches here, either check already
        // ran. skip logging for automated scheduled tasks (matches the
        // other branches above; this file's raw-command execution never
        // appears in the RCON command history, only in Schedule History).
        const result = await rconService.execute(task.command, {
          skipLog: true,
        });
        if (!result?.success) {
          throw new Error(result?.error || "RCON command failed");
        }
      }
    } finally {
      if (cleanup) await cleanup();
    }
  }

  // Re-point a ServerManager at the server a restart began on, in case the
  // active server was switched while the countdown was running.
  async _ensureRestartTarget(serverManager, pinnedServerId) {
    if (pinnedServerId == null) return;

    let current = serverManager._serverId ?? null;
    if (current == null) {
      try {
        current = (await getActiveServer())?.id ?? null;
      } catch (error) {
        log.debug(`Could not verify restart target: ${error.message}`);
        return;
      }
    }
    if (String(current) === String(pinnedServerId)) return;

    log.warn(
      `Auto-restart: active server changed mid-restart — re-targeting server ${pinnedServerId} so the restart finishes on the server it began on`,
    );
    await serverManager.reloadConfig(pinnedServerId);
  }

  // Config-backup coverage for the ONE call site every restart trigger
  // funnels through -- manual (Dashboard/Scheduler-page "Restart Now",
  // Discord command) and automated (the AUTO_RESTART_CRON job, a
  // mod-update-triggered restart) alike, since they all call
  // performRestart(). 2026-08-27 user report (loonE, Discord): config
  // reverted to default after a SCHEDULED reboot -- and separately,
  // confirmed by grep, that createBackup()/writeIniWithBackup() only ever
  // fire from an explicit human edit-and-save action, never from any
  // restart or the scheduled world-backup job. So the one event class most
  // likely to silently replace a config (an unattended restart, at 4am,
  // nobody watching) was also the one event class the config-backup net
  // never covered. This closes that gap at the one place that reaches
  // every restart trigger, using the existing createBackup() machinery
  // (via createBackupIfChanged() -- see its own comment for why "if
  // changed" specifically: an unconditional backup on every restart of a
  // server that restarts on a schedule would fill the keep-10 quota with
  // duplicate copies of unchanged content and evict the real,
  // content-different human-edit backups instead).
  //
  // Called once the old process is confirmed stopped and before the new
  // one starts -- config files are static in that window, on both the
  // managed-container and directly-spawned paths, so this runs
  // unconditionally regardless of which one this restart takes.
  // Deliberately best-effort: a backup failure must never block the
  // restart itself, matching every other pre-restart step in this
  // function (RCON verify, world save) that logs and continues rather
  // than throwing out of performRestart entirely for a housekeeping
  // failure -- except unlike those, a failed *backup* specifically isn't
  // even something to fail the restart FOR, since skipping it only means
  // this one restart isn't covered, not that the restart itself is unsafe.
  //
  // Resolves the config directory/filenames via candidateIniPaths() --
  // the SAME 4-way fallback ensureRconConfigured() uses (server.js), not
  // the single serverConfigPath-or-zomboidDataPath/Server guess this
  // method originally used. 2026-08-27, operator-flagged: the installs
  // most likely to have their real ini at one of the legacy locations are
  // exactly the ones the stale-launch-script defect (see
  // refreshLaunchTargetBeforeStart()) is most likely to hit -- a backup
  // step that only checks the default location would silently skip
  // covering exactly the installs at risk. One shared resolver so this
  // and ensureRconConfigured() cannot drift on where "the" ini is, same
  // reasoning as listBackupsFor() in configBackup.js. The sandbox
  // filename is derived from whichever ini was ACTUALLY found (its own
  // basename, not necessarily server.serverName) -- PZ's own
  // SandboxVars.lua naming follows the ini's basename, and the legacy
  // fallback locations (servertest.ini, serveroptions.ini) use fixed
  // names that can differ from the configured serverName.
  //
  // Returns the resolved server record (or null) so a caller needing the
  // same record for a related pre-start step doesn't have to re-fetch it.
  async _backupConfigBeforeRestart(pinnedServerId) {
    let server = null;
    try {
      server =
        pinnedServerId != null
          ? await getServer(pinnedServerId)
          : await getActiveServer();
      if (!server?.serverName) return server;

      const serverConfigPath =
        server.serverConfigPath ||
        (server.zomboidDataPath
          ? path.join(server.zomboidDataPath, "Server")
          : null);
      if (!serverConfigPath) return server;

      const iniPath =
        candidateIniPaths(
          serverConfigPath,
          server.zomboidDataPath,
          server.serverName,
        ).find((candidate) => fs.existsSync(candidate)) ||
        path.join(serverConfigPath, `${server.serverName}.ini`);

      const configDir = path.dirname(iniPath);
      const iniFilename = path.basename(iniPath);
      const sandboxFilename = iniFilename.toLowerCase().endsWith(".ini")
        ? `${iniFilename.slice(0, -4)}_SandboxVars.lua`
        : `${server.serverName}_SandboxVars.lua`;

      for (const filename of [iniFilename, sandboxFilename]) {
        const result = await createBackupIfChanged(configDir, filename);
        if (result.reason === "failed") {
          log.warn(
            `Pre-restart config backup of ${filename} failed: ${result.error}`,
          );
        }
      }
    } catch (error) {
      log.warn(`Pre-restart config backup failed: ${error.message}`);
    }
    return server;
  }

  // Picks the RconService/ServerManager pair a task should run against.
  // Returns the shared singletons (cleanup: null) for a task with no
  // server_id (legacy) or one that targets the currently-active server.
  // Otherwise builds throwaway instances scoped to that specific server via
  // loadConfig(serverId), leaving the shared singletons — and therefore the
  // live admin UI — completely untouched.
  async _resolveServicesForTask(task) {
    const shared = {
      rconService: this.rconService,
      serverManager: this.serverManager,
      cleanup: null,
    };

    if (!task.server_id) return shared;

    let active;
    try {
      active = await getActiveServer();
    } catch (error) {
      log.warn(
        `Could not resolve active server for task ${task.name}, using shared connection: ${error.message}`,
      );
      return shared;
    }

    if (active && String(active.id) === String(task.server_id)) {
      return shared;
    }

    log.info(
      `Task "${task.name}" targets server ${task.server_id}, which isn't active — using a temporary connection`,
    );
    const tempRcon = new RconService();
    const tempManager = new ServerManager();
    await tempRcon.loadConfig(task.server_id);
    await tempManager.loadConfig(task.server_id);

    return {
      rconService: tempRcon,
      serverManager: tempManager,
      cleanup: async () => {
        try {
          if (tempRcon.connected) await tempRcon.disconnect();
        } catch (error) {
          log.debug(`Cleanup: failed to disconnect temp RCON: ${error.message}`);
        }
      },
    };
  }

  async executeBridgeAction(rawCommand) {
    // Strip the `bridge:` prefix, then split off optional JSON args.
    const body = rawCommand.slice("bridge:".length).trim();
    if (!body) throw new Error("bridge: action missing");

    // action comes from the same shared parser requiredCapabilityForScheduledCommand
    // uses, so dispatch and permission-checking can never disagree on which
    // action a given command names.
    const action = parseBridgeActionName(rawCommand);
    const firstSpace = body.indexOf(" ");
    const argsRaw = firstSpace === -1 ? "" : body.slice(firstSpace + 1).trim();

    if (!SCHEDULABLE_BRIDGE_ACTIONS.has(action)) {
      throw new Error(
        `bridge action '${action}' is not allowed in scheduled tasks`,
      );
    }

    let args = {};
    if (argsRaw) {
      try {
        args = JSON.parse(argsRaw);
        if (typeof args !== "object" || args === null || Array.isArray(args)) {
          throw new Error("args must be a JSON object");
        }
      } catch (err) {
        throw new Error(`invalid bridge args JSON: ${err.message}`);
      }
    }

    // sendCommand()'s returned promise only ever resolves {success: true,
    // data} or rejects (services/panelBridge.js processResult()'s only two
    // outcomes) -- it never resolves an explicit {success: false}. A
    // caller-side `if (result.success === false) throw` here was dead code,
    // unreachable through this path, and implied a failure shape that
    // structurally cannot occur -- the `await` below already surfaces a
    // real bridge failure by rejecting, which propagates to executeTask()'s
    // caller the same as every other throw in this function.
    return panelBridge.sendCommand(action, args);
  }

  cancelTask(taskId) {
    if (this.jobs.has(taskId)) {
      this.jobs.get(taskId).stop();
      this.jobs.delete(taskId);
      this.jobLabels.delete(taskId);
      log.info(`Cancelled scheduled task: ${taskId}`);
      return true;
    }
    return false;
  }

  /**
   * Cancel an in-progress restart countdown
   */
  cancelRestart() {
    if (this.restartInProgress) {
      this.restartCancelled = true;
      log.info("Restart cancellation requested");
      return { success: true, message: "Restart cancellation requested" };
    }
    return { success: false, message: "No restart in progress" };
  }

  /**
   * Stop all scheduled jobs - used for graceful shutdown
   */
  stopAllJobs() {
    // Stop all task jobs
    for (const [taskId, job] of this.jobs) {
      job.stop();
      log.debug(`Stopped scheduled task: ${taskId}`);
    }
    this.jobs.clear();
    this.jobLabels.clear();

    // Stop auto-restart job
    if (this.autoRestartJob) {
      this.autoRestartJob.stop();
      this.autoRestartJob = null;
    }

    // Stop backup job
    if (this.backupJob) {
      this.backupJob.stop();
      this.backupJob = null;
    }

    log.info("All scheduled jobs stopped");
  }

  async setupBackupSchedule() {
    // Stop existing backup job if any
    if (this.backupJob) {
      this.backupJob.stop();
      this.backupJob = null;
    }

    if (!this.backupService) {
      log.debug("Backup service not available");
      return;
    }

    try {
      const settings = await this.backupService.getSettings();

      if (!settings.enabled) {
        log.info("Scheduled backups are disabled");
        return;
      }

      if (
        !isSupportedFiveFieldCron(settings.schedule) ||
        isCronTooFrequent(settings.schedule)
      ) {
        log.error(
          `Invalid backup schedule cron expression: ${settings.schedule}`,
        );
        return;
      }

      this.backupJob = cron.schedule(settings.schedule, async () => {
        // Linux bug hunt (2026-08-29, hunt-wave5, suspect 4 -- overlap):
        // createBackup() zips whatever is currently on disk under savesPath
        // with no awareness of restartInProgress, and performRestart()'s
        // world-save (RCON `save`) + the server actively writing during
        // shutdown both mutate files under that exact path. A scheduled
        // backup firing during that window can archive a save mid-write --
        // a corrupt or inconsistent snapshot that looks like a normal
        // backup until someone tries to restore it. This is one-directional
        // on purpose: deferring an AUTOMATIC backup by a few minutes is
        // harmless (the next 12-hourly tick, or a manual "Create Backup
        // Now", covers it), but making a RESTART wait on a backup would
        // delay something an operator (or a mod-update trigger) may need
        // to happen promptly -- see createBackup()'s own
        // this.backupInProgress mutex for the backup<->restore direction
        // this already guards; this closes the missing restart<->backup
        // direction without touching that one.
        if (this.restartInProgress) {
          log.warn(
            "Scheduled backup skipped: a restart is currently in progress (would risk archiving a save mid-write)",
          );
          await logScheduleExecution(
            null,
            "Scheduled Backup",
            "backup",
            false,
            "Skipped: a restart was in progress",
            0,
          );
          return;
        }
        log.info("Executing scheduled backup");
        const startTime = Date.now();
        try {
          const result = await this.backupService.createBackup({
            includeDb: settings.includeDb,
          });
          const duration = Date.now() - startTime;
          if (result.success) {
            // 2026-08-26 bug hunt: createBackup surfaces skipped files
            // rather than deciding policy -- a scheduled backup tolerates a
            // skip (same reasoning as the manual /backup/create route) but
            // must not bury it inside a message that reads identically to a
            // clean run, since Schedule History is the only place anyone
            // would ever see it for an unattended backup.
            //
            // "that vanished during archiving" was accurate until 2026-08-29
            // (bughunt-2026-08-31-c, completeness-claims-audit-followups):
            // walkDirectory() now also records a deliberately-excluded
            // symbolic link in this same skippedFiles array (see that
            // function's own comment), and this message was never updated
            // to match -- routes/backup.js's equivalent operator-facing
            // warning was, the same day, in the same commit (445c15a5).
            // Cause-agnostic now, matching that convention.
            const skipNote = result.skippedFiles?.length
              ? ` (${result.skippedFiles.length} file(s) not included -- a temp/log/lock file rewritten mid-backup, or a symbolic link deliberately not followed: ${result.skippedFiles.join(", ")})`
              : "";
            await logScheduleExecution(
              null,
              "Scheduled Backup",
              "backup",
              true,
              `Created: ${result.backup.name}${skipNote}`,
              duration,
            );
            log.info(`Scheduled backup completed: ${result.backup.name}${skipNote}`);
          } else {
            await logScheduleExecution(
              null,
              "Scheduled Backup",
              "backup",
              false,
              result.message,
              duration,
            );
            log.error(`Scheduled backup failed: ${result.message}`);
          }
        } catch (error) {
          const duration = Date.now() - startTime;
          await logScheduleExecution(
            null,
            "Scheduled Backup",
            "backup",
            false,
            error.message,
            duration,
          );
          log.error(`Scheduled backup error: ${error.message}`);
        }
      }, { timezone: this.effectiveTimezone });

      log.info(`Backup schedule configured: ${settings.schedule} (timezone: ${this.effectiveTimezone})`);

      // The backup settings save route (routes/backup.js, not this fence)
      // isn't touched here -- log only, same reasoning as setupAutoRestart's
      // own warning above.
      const dstWarning = dstFallBackWarning(
        settings.schedule,
        this.effectiveTimezone,
        "backup",
      );
      if (dstWarning) log.warn(dstWarning);
    } catch (error) {
      log.error(`Failed to setup backup schedule: ${error.message}`);
    }
  }

  setupAutoRestart() {
    const enabled = process.env.AUTO_RESTART_ENABLED === "true";
    const cronExpression = process.env.AUTO_RESTART_CRON || "0 */6 * * *";
    if (!enabled) {
      log.info("Auto-restart is disabled");
      return;
    }

    if (
      !isSupportedFiveFieldCron(cronExpression) ||
      isCronTooFrequent(cronExpression)
    ) {
      log.error(`Invalid auto-restart cron expression: ${cronExpression}`);
      return;
    }

    // Stop existing auto-restart job if any to prevent leaks
    if (this.autoRestartJob) {
      this.autoRestartJob.stop();
      this.autoRestartJob = null;
    }

    // Schedule the actual restart
    this.autoRestartJob = cron.schedule(cronExpression, async () => {
      log.info("Executing scheduled auto-restart");
      try {
        // performRestart answers with a result rather than throwing when it
        // refuses or fails, so a silent no-op is the failure mode to catch.
        const result = await this.performRestart();
        if (!result?.success) {
          log.error(
            `Scheduled auto-restart did not complete: ${result?.message || "unknown error"}`,
          );
        }
      } catch (err) {
        // performRestart re-throws on failure. Verified against the
        // installed node-cron@4.6.0 (InlineScheduledTask.execute(),
        // node_modules/node-cron/dist/_shared.js ~266-283): the task
        // callback is already wrapped in try/catch internally and routed to
        // onError, so an unhandled rejection here would NOT take the panel
        // down even without this catch -- confirmed by running a throwing
        // task under it directly. This catch is belt-and-braces, kept so the
        // failure is logged in our own terms (schedule history, our log
        // format) rather than only node-cron's. If node-cron's error
        // containment ever changes in a future upgrade, re-verify before
        // trusting this comment.
        log.error(`Auto-restart cron tick failed: ${err.message}`);
      }
    }, { timezone: this.effectiveTimezone });

    log.info(`Auto-restart scheduled: ${cronExpression} (timezone: ${this.effectiveTimezone})`);

    // Boot-time / env-driven, not a create/update API call -- log only,
    // same as the reasoning on scheduleTask()'s own warning above.
    const dstWarning = dstFallBackWarning(
      cronExpression,
      this.effectiveTimezone,
      "auto restart",
    );
    if (dstWarning) log.warn(dstWarning);
  }

  /**
   * Broadcast a restart message to all players. PZ's `servermsg` RCON command
   * is the canonical broadcast for both B41 and B42 and is what shows up in
   * every player's chat. We also fire it through PanelBridge's sendToServerChat
   * when the mod is connected so the message appears via the in-game chat
   * pipeline too (belt-and-braces — version-agnostic on the Lua side). Both
   * paths are best-effort and never throw.
   */
  // `rconService` defaults to the shared singleton (unchanged behaviour for
  // restart-now / the AUTO_RESTART_CRON job). performRestart() passes its
  // resolved target explicitly so a non-active-server restart's countdown
  // broadcasts to the RIGHT server, not whatever the admin UI is showing.
  async _broadcastRestartMessage(text, rconService = this.rconService) {
    // RCON `servermsg` — primary path, works on B41 + B42 without the mod.
    try {
      const r = await rconService.serverMessage(text, { skipLog: true });
      if (!r?.success) {
        log.warn(
          `Restart broadcast (RCON) failed: ${r?.error || r?.response || "unknown"}`,
        );
      }
    } catch (err) {
      log.warn(`Restart broadcast (RCON) threw: ${err.message}`);
    }

    // PanelBridge in-game chat — secondary visibility boost. Only fire if
    // the mod is currently connected; fire-and-forget so we don't add latency
    // to the countdown cadence. isAlert=true triggers PZ's server alert
    // notification (red banner / alert sound) on both B41 and B42.
    // PanelBridge is a single module-level singleton tied to whichever
    // server is currently active — skip this secondary boost entirely when
    // targeting a non-active server, since it has no per-server instancing
    // (same limitation as the `bridge:` scheduled-command guard) and firing
    // it here would send the message into the WRONG server's chat.
    if (rconService !== this.rconService) return;
    try {
      if (
        panelBridge &&
        typeof panelBridge.isModConnected === "function" &&
        panelBridge.isModConnected()
      ) {
        panelBridge
          .sendCommand("sendToServerChat", { message: text, isAlert: true })
          .catch((err) => {
            log.debug(`Restart broadcast (bridge) failed: ${err.message}`);
          });
      }
    } catch (err) {
      log.debug(`Restart broadcast (bridge) threw: ${err.message}`);
    }
  }

  // Discord was already told the restart was coming, so it has to be told when
  // it isn't. Best-effort — a cancellation must never fail because of Discord.
  async _notifyRestartCancelled() {
    if (!this.discordBot) return;
    try {
      await this.discordBot.sendNotification(
        "✅ **Scheduled restart cancelled** — the server is staying up.",
      );
    } catch (err) {
      log.debug(`Discord restart-cancelled notification failed: ${err.message}`);
    }
  }

  // `rconService`/`serverManager` default to the shared singletons
  // (unchanged behaviour for restart-now and the AUTO_RESTART_CRON job —
  // both always target "the active server" by design). The Scheduler passes
  // an explicit pair for a task whose server_id isn't the active server, so
  // the whole sequence below runs against a throwaway connection instead of
  // hijacking the shared singleton the live admin UI reads from.
  async performRestart(
    warningMinutesParam = null,
    {
      rconService = this.rconService,
      serverManager = this.serverManager,
      // Schedule History's task-name column for this run. Every call site
      // left this at the default "Auto Restart" before this label existed,
      // even a human clicking Restart Now -- see
      // docs/qa/kevin-adversarial-findings.md Finding 3. Callers that ARE a
      // live, request-bound manual trigger should pass "Manual restart";
      // genuinely unattended triggers (the AUTO_RESTART_CRON job, a
      // mod-update restart, a scheduled task's cron fire) keep the default.
      label = "Auto Restart",
      lifecycleLock: providedLifecycleLock = null,
    } = {},
  ) {
    // Prevent concurrent restarts
    if (this.restartInProgress) {
      log.info("Restart already in progress, ignoring duplicate request");
      return { success: false, message: "Restart already in progress" };
    }

    const lifecycleLock =
      providedLifecycleLock ||
      acquireLifecycleLock("restart", serverManager?.serverName || null);
    if (!lifecycleLock) {
      return { success: false, ...lifecycleInProgressResponse() };
    }

    this.restartInProgress = true;
    this.restartCancelled = false; // Allow cancellation
    const warningMinutes =
      warningMinutesParam ??
      (parseInt(process.env.RESTART_WARNING_MINUTES, 10) || 5);
    const restartWarning = normalizeRestartWarningSettings(this.restartWarning);
    const restartStartTime = Date.now();

    // Pin the restart to the server it starts against. The shared
    // ServerManager otherwise re-reads "whichever server is active" when it
    // starts, so switching servers mid-countdown would stop one server and
    // bring a different one up in its place.
    let pinnedServerId = serverManager._serverId ?? null;
    if (pinnedServerId == null) {
      try {
        pinnedServerId = (await getActiveServer())?.id ?? null;
      } catch (error) {
        log.debug(`Could not pin restart target: ${error.message}`);
      }
    }

    try {
      // No fallback to checkServerRunning() when getServerProcessDetails
      // isn't available -- that call collapses a failed scan into a plain
      // `false`, and hardcoding scanFailed:false here would additionally
      // LIE about a check that never actually ran. Treat "the richer check
      // isn't available" as equivalent to a failed scan and let the
      // existing processScanFailed handling below refuse, same shape as
      // server/index.js's Docker-update gate (handlePanelUpdateDownload).
      const readProcessDetails = async () => {
        if (typeof serverManager.getServerProcessDetails === "function") {
          return serverManager.getServerProcessDetails();
        }
        return { running: false, scanFailed: true };
      };

      // Check if server is actually running - use multiple methods
      const initialProcessDetails = await readProcessDetails();
      const processScanFailed = Boolean(initialProcessDetails?.scanFailed);
      let wasRunning = Boolean(initialProcessDetails?.running);
      log.info(`Auto-restart: Process check returned: ${wasRunning}`);

      // If process check says not running, also try RCON as a fallback
      // RCON connection success is a reliable indicator the server is running
      if (!wasRunning && rconService.connected) {
        log.info(
          "Auto-restart: Process check failed but RCON is connected - server IS running",
        );
        wasRunning = true;
      }

      // Also try a quick RCON command if we think server might be running
      if (!wasRunning) {
        try {
          const testResult = await rconService.execute("players", {
            skipLog: true,
          });
          if (testResult.success) {
            log.info(
              "Auto-restart: RCON command succeeded - server IS running",
            );
            wasRunning = true;
          }
        } catch (e) {
          // RCON failed, server probably not running
          log.debug(`Auto-restart: RCON test failed: ${e.message}`);
        }
      }

      if (!wasRunning) {
        if (processScanFailed) {
          const restartDuration = Date.now() - restartStartTime;
          const errorMsg =
            "Could not confirm whether the server is stopped because process detection failed";
          await logScheduleExecution(
            null,
            label,
            "restart",
            false,
            errorMsg,
            restartDuration,
          );
          logServerEvent("auto_restart_error", errorMsg);
          return { success: false, wasRunning: false, message: errorMsg };
        }

        // Server wasn't running - just start it. Already-stopped, so config
        // files are already static -- same coverage as the main branch
        // below, see _backupConfigBeforeRestart()'s own comment. Also
        // refresh the launch target first, same as the manual /start route
        // does, so this branch doesn't reintroduce the stale-script defect
        // just because it takes a different path than the main one below --
        // see refreshLaunchTargetBeforeStart()'s own comment.
        log.info(
          "Auto-restart triggered but server was not running - starting server",
        );
        const restartTarget = await this._backupConfigBeforeRestart(pinnedServerId);
        await refreshLaunchTargetBeforeStart(restartTarget, {
          managedHandled: false,
        });
        const started = await serverManager.startServer({
          serverId: pinnedServerId,
        });
        if (!started?.success) {
          log.warn(
            `Auto-restart: start command reported failure: ${started?.error || started?.message || "unknown error"}`,
          );
        }

        // Wait a bit and verify it started
        await this.sleep(10000);
        const postStartDetails = await readProcessDetails();
        const isNowRunning =
          rconService.connected ||
          Boolean(postStartDetails && !postStartDetails.scanFailed && postStartDetails.running);

        const restartDuration = Date.now() - restartStartTime;
        if (isNowRunning) {
          await logScheduleExecution(
            null,
            label,
            "restart",
            true,
            "Server was offline - started successfully",
            restartDuration,
          );
          logServerEvent(
            "auto_restart",
            "Server was offline - started successfully",
          );
          log.info("Server started successfully (was not running)");
        } else {
          await logScheduleExecution(
            null,
            label,
            "restart",
            false,
            "Server was offline - failed to start",
            restartDuration,
          );
          logServerEvent(
            "auto_restart_error",
            "Server was offline - failed to start",
          );
          log.error("Failed to start server");
        }
        return { success: isNowRunning, wasRunning: false };
      }

      // Server is running - perform full restart with warnings
      // First, verify RCON is connected and working
      if (!rconService.connected) {
        log.info("Auto-restart: RCON not connected, attempting to connect...");
        try {
          await rconService.connect();
        } catch (e) {
          log.error(`Auto-restart: Failed to connect RCON: ${e.message}`);
        }
      }

      // Test RCON with a simple command before proceeding
      const testResult = await rconService.execute("players", {
        skipLog: true,
      });
      if (!testResult.success) {
        const restartDuration = Date.now() - restartStartTime;
        const errorMsg = `RCON not available: ${testResult.error || "connection failed"}`;
        log.error(`Auto-restart failed: ${errorMsg}`);
        await logScheduleExecution(
          null,
          label,
          "restart",
          false,
          errorMsg,
          restartDuration,
        );
        logServerEvent("auto_restart_error", errorMsg);
        return { success: false, message: errorMsg };
      }

      log.info("Auto-restart: RCON verified, sending warnings...");

      // Notify Discord at the start of the restart sequence
      if (this.discordBot) {
        this.discordBot
          .sendEventNotification("scheduledRestart", {
            minutes: warningMinutes,
          })
          .catch((err) =>
            log.debug(
              `Discord scheduledRestart notification failed: ${err.message}`,
            ),
          );
      }

      if (warningMinutes > 0) {
        // Per-minute countdown. Plain ASCII so PZ's servermsg delivers it
        // verbatim (no emoji stripping). Bracketed prefix is the standard
        // PZ convention for server broadcasts and is visible in-chat on
        // both B41 and B42.
        for (let i = warningMinutes; i > 0; i--) {
          if (this.restartCancelled) {
            log.info("Auto-restart: Cancelled during countdown");
            await this._broadcastRestartMessage(
              getRestartWarningNotice(restartWarning, "cancelled"),
              rconService,
            );
            await this._notifyRestartCancelled();
            return { success: false, message: "Restart cancelled" };
          }
          await this._broadcastRestartMessage(
            formatRestartWarning(restartWarning, i, "minute"),
            rconService,
          );

          if (i > 1) {
            await this.sleep(60000); // Wait 1 minute
          }
        }

        // Final 60 seconds: 30s warning, 10s warning, then 5..1 each second.
        // Sleep happens BEFORE each tick, so timing after the last per-minute
        // warning is: +30s -> "30 SECONDS", +20s -> "10 SECONDS",
        // +5s -> "5", +1s -> "4", +1s -> "3", +1s -> "2", +1s -> "1",
        // +1s -> "RESTARTING NOW".
        const finalTicks = [
          { wait: 30000, count: 30 },
          { wait: 20000, count: 10 },
          { wait: 5000, count: 5 },
          { wait: 1000, count: 4 },
          { wait: 1000, count: 3 },
          { wait: 1000, count: 2 },
          { wait: 1000, count: 1 },
        ];
        for (const tick of finalTicks) {
          await this.sleep(tick.wait);
          if (this.restartCancelled) {
            log.info("Auto-restart: Cancelled during final countdown");
            await this._broadcastRestartMessage(
              getRestartWarningNotice(restartWarning, "cancelled"),
              rconService,
            );
            await this._notifyRestartCancelled();
            return { success: false, message: "Restart cancelled" };
          }
          await this._broadcastRestartMessage(
            formatRestartWarning(restartWarning, tick.count, "second"),
            rconService,
          );
        }

        // One last second, then go.
        await this.sleep(1000);
        await this._broadcastRestartMessage(
          getRestartWarningNotice(restartWarning, "restarting"),
          rconService,
        );
        await this.sleep(2000);
      } else {
        // Immediate restart - just a brief message
        await this._broadcastRestartMessage(
          getRestartWarningNotice(restartWarning, "restarting"),
          rconService,
        );
        await this.sleep(2000);
      }

      // Save world - skip logging for automated save
      log.info("Auto-restart: Saving world...");
      const saveResult = await rconService.save({ skipLog: true });
      if (!saveResult?.success) {
        const restartDuration = Date.now() - restartStartTime;
        const errorMsg = `Save failed; restart cancelled: ${saveResult?.error || "unknown error"}`;
        log.error(`Auto-restart: ${errorMsg}`);
        await logScheduleExecution(
          null,
          label,
          "restart",
          false,
          errorMsg,
          restartDuration,
        );
        await logServerEvent("auto_restart_error", errorMsg);
        return { success: false, wasRunning: true, message: errorMsg };
      }
      await this.sleep(3000);

      // A container-managed server restarts through Docker. RCON quit only
      // kills PID 1: the container exits, its restart policy races the panel to
      // bring the world back, and the panel cannot spawn a process that lives
      // inside another container anyway.
      const managed = await runManagedLifecycle("restart", {
        serverId: pinnedServerId,
      });
      if (managed.handled && !managed.success) {
        const restartDuration = Date.now() - restartStartTime;
        const errorMsg = `Container restart failed: ${managed.error || "unknown error"}`;
        log.error(`Auto-restart failed: ${errorMsg}`);
        await logScheduleExecution(
          null,
          label,
          "restart",
          false,
          errorMsg,
          restartDuration,
        );
        logServerEvent("auto_restart_error", errorMsg);
        return { success: false, wasRunning: true, message: errorMsg };
      }

      if (!managed.handled) {
        // Quit server - skip logging for automated quit
        log.info("Auto-restart: Sending quit command...");
        const quit = await rconService.quit({ skipLog: true });
        if (!quit?.success) {
          log.warn(
            `Auto-restart: quit command failed (${quit?.error || "unknown error"}), falling back to a forced stop`,
          );
        }
        await this.sleep(10000);

        // Wait for server to stop. A failed scan is unknown, not stopped.
        let attempts = 0;
        let processDetails = await readProcessDetails();
        if (!processDetails || processDetails.scanFailed) {
          const restartDuration = Date.now() - restartStartTime;
          const errorMsg =
            "Could not confirm the old server stopped because process detection failed";
          await logScheduleExecution(
            null,
            label,
            "restart",
            false,
            errorMsg,
            restartDuration,
          );
          logServerEvent("auto_restart_error", errorMsg);
          return { success: false, wasRunning: true, message: errorMsg };
        }
        while (processDetails.running && attempts < 60) {
          await this.sleep(1000);
          attempts++;
          processDetails = await readProcessDetails();
          if (!processDetails || processDetails.scanFailed) {
            const restartDuration = Date.now() - restartStartTime;
            const errorMsg =
              "Could not confirm the old server stopped because process detection failed";
            await logScheduleExecution(
              null,
              label,
              "restart",
              false,
              errorMsg,
              restartDuration,
            );
            logServerEvent("auto_restart_error", errorMsg);
            return { success: false, wasRunning: true, message: errorMsg };
          }
        }

        // Force stop if needed
        if (processDetails.running) {
          const forced = await serverManager.stopServer(false, {
            serverId: pinnedServerId,
          });
          if (!forced?.success || forced.confirmed === false) {
            const stopError =
              forced?.error || forced?.message || "unknown error";
            const restartDuration = Date.now() - restartStartTime;
            log.warn(`Auto-restart: forced stop failed: ${stopError}`);
            await logScheduleExecution(
              null,
              label,
              "restart",
              false,
              `Could not confirm the old server stopped: ${stopError}`,
              restartDuration,
            );
            logServerEvent(
              "auto_restart_error",
              `Could not confirm the old server stopped: ${stopError}`,
            );
            return {
              success: false,
              wasRunning: true,
              message: `Could not confirm the old server stopped: ${stopError}`,
            };
          }
          await this.sleep(5000);
        }

        // The old process is now confirmed stopped (either the while loop
        // above observed processDetails.running go false, or the forced
        // stop just above succeeded) -- push it instead of leaving clients
        // reading the pre-restart "running" status for the whole remainder
        // of this sequence (config backup + relaunch + up to 4 more minutes
        // of RCON waiting below).
        this._emitVerifiedTransition(false);

        // Extra delay after stop — give OS time to fully reap the process
        // (zombie processes on Linux, WMI cache on Windows)
        await this.sleep(3000);
      }

      // See _backupConfigBeforeRestart()'s own comment: config files are
      // static in this window (old process confirmed stopped, new one not
      // started yet), on both the managed-container and directly-spawned
      // paths below, so this runs unconditionally regardless of which one
      // this restart takes.
      const restartTarget = await this._backupConfigBeforeRestart(pinnedServerId);

      // Refresh RCON config and the launch script against current settings,
      // same as the manual /start route -- see
      // refreshLaunchTargetBeforeStart()'s own comment. RCON always runs
      // (matches the route); script regen is skipped for a managed
      // container the same way the route skips it, since Docker owns the
      // launch command there.
      await refreshLaunchTargetBeforeStart(restartTarget, {
        managedHandled: managed.handled,
      });

      // Set flag to prevent RCON auto-reconnect from interfering during startup
      // Use setServerStarting which has a 5-minute failsafe timeout
      if (rconService.setServerStarting) {
        rconService.setServerStarting(true);
      } else {
        rconService.serverStarting = true;
      }

      let serverStarted = false;
      if (managed.handled) {
        // `docker restart` only answers once the container is running again, so
        // there is nothing to poll for here. PZ itself is still booting — the
        // RCON wait below is the real readiness gate. Polling the process table
        // would fail outright unless the panel shares the host PID namespace.
        serverStarted = true;
        log.info("Auto-restart: Managed container restarted");
      } else {
        // Start server — skip the running check since we just confirmed the server stopped
        log.info("Auto-restart: Starting server...");
        await this._ensureRestartTarget(serverManager, pinnedServerId);
        const restarted = await serverManager.startServer({
          skipRunningCheck: true,
          serverId: pinnedServerId,
        });
        if (!restarted?.success) {
          log.warn(
            `Auto-restart: start command reported failure: ${restarted?.error || restarted?.message || "unknown error"}`,
          );
        }

        // Wait for server process to be running (up to 60 seconds)
        for (let i = 0; i < 60; i++) {
          await this.sleep(1000);
          const processDetails = await readProcessDetails();
          if (
            rconService.connected ||
            (processDetails &&
              !processDetails.scanFailed &&
              processDetails.running)
          ) {
            serverStarted = true;
            log.info("Auto-restart: Server process detected as running");
            break;
          }
        }
      }

      if (!serverStarted) {
        if (rconService.setServerStarting) {
          rconService.setServerStarting(false);
        } else {
          rconService.serverStarting = false;
        }
        const restartDuration = Date.now() - restartStartTime;
        await logScheduleExecution(
          null,
          label,
          "restart",
          false,
          "Server stopped but failed to start",
          restartDuration,
        );
        logServerEvent(
          "auto_restart_error",
          "Server stopped but failed to start",
        );
        log.error("Auto-restart: Server stopped but failed to start");
        return { success: false, wasRunning: true };
      }

      // The new instance is now confirmed up -- either Docker's own restart
      // action already blocked until the container was running again
      // (managed.handled branch above), or the process/RCON poll just
      // confirmed it natively. RCON itself may still take another 60-240s
      // below, but the host/container signal is real now; no reason to make
      // clients wait for that too.
      this._emitVerifiedTransition(true);

      // Wait for RCON to be ready (PZ server takes 60-180s to fully initialize)
      // Keep serverStarting=true the whole time to block auto-reconnect
      log.info("Auto-restart: Waiting for RCON to be ready...");
      const rconDelays = [60000, 45000, 45000, 45000, 45000]; // 60s + 4x45s = 240s total (4 minutes)
      let rconConnected = false;

      for (let i = 0; i < rconDelays.length; i++) {
        const delaySeconds = rconDelays[i] / 1000;
        log.info(
          `Auto-restart: RCON waiting ${delaySeconds}s before attempt ${i + 1}/${rconDelays.length}...`,
        );
        await this.sleep(rconDelays[i]);

        // If RCON connected during the wait (via auto-reconnect), we're done
        if (rconService.connected) {
          rconConnected = true;
          log.info("Auto-restart: RCON connected during wait period");
          break;
        }

        // Reset connection state before each attempt to clear any stalled state
        if (rconService.forceResetConnectionState) {
          rconService.forceResetConnectionState();
        }

        // Attempt connection with a 15s timeout to prevent hanging
        try {
          log.info(
            `Auto-restart: RCON attempting connection ${i + 1}/${rconDelays.length}...`,
          );
          const connectPromise = rconService.connect();
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Connection attempt timed out after 15s")),
              15000,
            ),
          );

          const connectResult = await Promise.race([
            connectPromise,
            timeoutPromise,
          ]);

          if (rconService.connected) {
            rconConnected = true;
            log.info("Auto-restart: RCON connected after server startup");
            break;
          } else {
            log.info(
              `Auto-restart: RCON attempt ${i + 1} - not connected (result: ${connectResult})`,
            );
          }
        } catch (e) {
          log.info(`Auto-restart: RCON attempt ${i + 1} failed: ${e.message}`);
          // Reset state on failure/timeout so next attempt starts fresh
          if (rconService.forceResetConnectionState) {
            rconService.forceResetConnectionState();
          }
        }
        // Don't toggle serverStarting - keep it true to block auto-reconnect
      }

      // Log completion status
      if (rconConnected) {
        log.info("Auto-restart: RCON startup sequence completed - connected");
      } else {
        log.warn(
          "Auto-restart: RCON startup sequence completed - NOT connected (auto-reconnect will keep trying every 30s)",
        );
      }

      // Clear the flag when done
      if (rconService.setServerStarting) {
        rconService.setServerStarting(false);
      } else {
        rconService.serverStarting = false;
      }

      const restartDuration = Date.now() - restartStartTime;

      if (serverStarted) {
        const rconStatus = rconConnected
          ? " (RCON connected)"
          : " (RCON not yet connected)";
        await logScheduleExecution(
          null,
          label,
          "restart",
          true,
          "Server restarted successfully" + rconStatus,
          restartDuration,
        );
        logServerEvent(
          "auto_restart",
          "Server restarted successfully" + rconStatus,
        );
        log.info(
          `Auto-restart completed successfully (took ${Math.round(restartDuration / 1000)}s)${rconStatus}`,
        );
      } else {
        await logScheduleExecution(
          null,
          label,
          "restart",
          false,
          "Server stopped but failed to start",
          restartDuration,
        );
        logServerEvent(
          "auto_restart_error",
          "Server stopped but failed to start",
        );
        log.error("Auto-restart: Server stopped but failed to start");
      }

      return { success: serverStarted, wasRunning: true };
    } catch (error) {
      const restartDuration = Date.now() - restartStartTime;
      log.error(`Auto-restart failed: ${error.message}`);
      await logScheduleExecution(
        null,
        label,
        "restart",
        false,
        error.message,
        restartDuration,
      );
      logServerEvent("auto_restart_error", error.message);
      // Clear serverStarting flag on error so auto-reconnect can resume
      if (rconService.setServerStarting) {
        rconService.setServerStarting(false);
      } else {
        rconService.serverStarting = false;
      }
      throw error;
    } finally {
      this.restartInProgress = false;
      lifecycleLock.release();
    }
  }

  async triggerModUpdateRestart() {
    if (this.modUpdateRestartPending) {
      log.info("Mod update restart already pending");
      return;
    }

    this.modUpdateRestartPending = true;
    log.info("Mod update detected - scheduling restart");

    try {
      const warned = await this.rconService.serverMessage(
        "🔧 Mod updates detected! Server will restart in 5 minutes.",
      );
      if (!warned?.success) {
        log.warn(
          `Could not warn players about the mod-update restart: ${warned?.error || "unknown error"}`,
        );
      }
      const result = await this.performRestart(5); // Explicitly pass 5 minutes to match the message
      if (!result?.success) {
        log.error(
          `Mod-update restart did not complete: ${result?.message || "unknown error"}`,
        );
      }
      this.modUpdateRestartPending = false;
    } catch (error) {
      this.modUpdateRestartPending = false;
      throw error;
    }
  }

  getStatus() {
    const tasks = [];
    for (const [id] of this.jobs) {
      tasks.push({ id, running: true });
    }

    return {
      activeTasks: tasks.length,
      autoRestartEnabled: !!this.autoRestartJob,
      backupScheduleEnabled: !!this.backupJob,
      modUpdateRestartPending: this.modUpdateRestartPending,
      nextRun: this.getNextRun(),
      // Timezone-picker card (2026-08-29, hunt-wave5 follow-up): `timezone`
      // is the EFFECTIVE zone every cron.schedule() call in this file
      // actually uses right now -- resolveTimezone() sets it once at boot
      // (migrating a not-yet-configured install to the then-current process
      // default so upgrading changes nothing) and again on setTimezone().
      // `configuredTimezone` is the raw settings value the operator chose
      // (normally identical to `timezone`). `timezoneFallback` is non-null
      // ONLY when the configured zone stopped being a valid IANA name
      // (tzdata removed a deprecated alias, or db.json was restored from a
      // different machine) -- resolveTimezone() falls back to the process
      // default rather than refusing to schedule, but does so LOUDLY: this
      // field is how the UI shows that mismatch even to an operator who
      // never reads the server log. Falls back to the live process default
      // if resolveTimezone() somehow hasn't run yet (defensive only --
      // init() always calls it before anything is scheduled).
      timezone: this.effectiveTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      configuredTimezone: this.configuredTimezone,
      timezoneFallback: this.timezoneFallback,
      restartWarning: normalizeRestartWarningSettings(this.restartWarning),
      restartWarningPresets: getRestartWarningPresetTemplates(),
    };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  shutdown() {
    // Use stopAllJobs to ensure all jobs are properly stopped
    this.stopAllJobs();

    // Also stop backup job if running
    if (this.backupJob) {
      this.backupJob.stop();
      this.backupJob = null;
    }

    log.info("Scheduler shutdown complete");
  }
}
