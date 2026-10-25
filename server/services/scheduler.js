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
  currentLaunchSequence,
  holdServerUntilRcon,
  lifecycleInProgressResponse,
} from "./lifecycleCoordinator.js";
import {
  describeSteamOperation,
  getStartBlockingSteamOperation,
} from "./activeSteamOperations.js";
import { createBackupIfChanged } from "../utils/configBackup.js";
import { resolveServerPhase } from "../utils/serverStatus.js";
import { isUnmanagedRemoteServer } from "../utils/serverStatusModel.js";
import { candidateIniPaths } from "../routes/server.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { serverConfigDirOf, serverConfigDirRefusalReason } from "../utils/serverConfigPath.js";
import { waitForProcessExit } from "../utils/processScanRetry.js";
import {
  LIVE_SANDBOX_BRIDGE_ACTIONS,
  findActiveWorldSandboxSnapshot,
  refreshWorldSandboxSnapshotAfterSave,
  withWorldSandboxSnapshotFlag,
} from "./worldSandboxSnapshot.js";
import {
  getScheduledTasks,
  updateTaskLastRun,
  logServerEvent,
  logScheduleExecution,
  getActiveServer,
  getServer,
  getServers,
  getSetting,
  setSetting,
} from "../database/init.js";
import {
  isCronTooFrequent,
  isSupportedFiveFieldCron,
  isValidIanaTimezone,
  isRawOffsetTimezone,
  dstFallBackWarning,
  dstSpringForwardWarning,
} from "../utils/cronValidation.js";
import { computeNextRun } from "../utils/cronNextRun.js";
import {
  findBackupRestartOverlaps,
  RESTART_TYPICAL_TAIL_MINUTES,
} from "../utils/backupRestartOverlap.js";
import {
  defaultRestartWarningSettings,
  formatRestartWarning,
  getRestartWarningNotice,
  getRestartWarningPresetTemplates,
  MAX_RESTART_WARNING_MINUTES,
  normalizeRestartWarningSettings,
  parseDefaultRestartWarningMinutes,
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
  "sendToServerChat",
  "sendToAdminChat",
]);

// The single source of truth for which scheduled-task commands are the
// curated, validated verbs automation.manage alone is meant to reach, vs.
// "raw" -- forwarded to rconService.execute() as an arbitrary RCON command,
// the same power routes/rcon.js gates behind rcon.execute. executeTask()'s
// dispatch and routes/scheduler.js's write-time/run-time permission checks
// both call this so the two can never silently drift apart on what counts
// as "safe" -- see the scheduler permission audit.
//
// bridge:saveWorld (a preset until #197) runs as a plain `save`: the
// bridge's save was the game's single-player save path, which wrote
// map_sand.bin and made the world override SandboxVars.lua on every start.
// Existing tasks keep working and need the same server.control as before;
// on a world that already has a map_sand.bin they also have the bridge
// rewrite it afterwards, as their save did (executeTask).
// The servers the scheduled backup backs up when backupServerIds names them:
// the local ones among them (a remote server's world isn't on this machine),
// the active server first, then My Servers order. Exported for testing.
export function selectScheduledBackupServers({ serverIds, servers = [], activeServer = null }) {
  const chosen = new Set((serverIds || []).map((id) => String(id)));
  const local = servers.filter((server) => server && !server.isRemote && chosen.has(String(server.id)));
  const activeId = activeServer?.id !== null && activeServer?.id !== undefined ? String(activeServer.id) : null;
  return [
    ...local.filter((server) => String(server.id) === activeId),
    ...local.filter((server) => String(server.id) !== activeId),
  ];
}

export function classifyScheduledCommand(command) {
  const commandLower = String(command ?? "").toLowerCase();
  if (commandLower === "restart") return "restart";
  if (commandLower === "save") return "save";
  if (commandLower.startsWith("servermsg ")) return "servermsg";
  if (commandLower.startsWith("bridge:")) {
    return parseBridgeActionName(String(command)) === "saveWorld" ? "save" : "bridge";
  }
  return "raw";
}

// Extracts the action name from a `bridge:<action>` scheduled command (the
// part before any JSON args blob), preserving original casing since
// PanelBridge action names are case-sensitive. Shared by executeBridgeAction
// (which needs the name to dispatch), classifyScheduledCommand and
// requiredCapabilityForScheduledCommand above and below (which need it to
// single out bridge:saveWorld and the player-targeting actions) so they can't
// parse it different ways.
function parseBridgeActionName(rawCommand) {
  const body = rawCommand.slice("bridge:".length).trim();
  const firstSpace = body.indexOf(" ");
  return (firstSpace === -1 ? body : body.slice(0, firstSpace)).trim();
}

function isBridgeSaveWorldCommand(command) {
  const raw = String(command ?? "");
  return raw.toLowerCase().startsWith("bridge:") && parseBridgeActionName(raw) === "saveWorld";
}

// The single source of truth for which panel capability a scheduled command
// requires -- the SAME capability its direct/interactive equivalent route
// requires, because scheduling an action must not cost less than performing
// it (the scheduler permission audit established this for
// raw/rcon.execute specifically; this generalises it to the other three
// curated classifications, closing the gap Finding 1's own fix never
// checked -- automation.manage was verified against rcon.execute, never
// against server.world_events or server.control).
// routes/scheduler.js's write-time (POST/PUT /tasks) and run-time
// (POST /tasks/:id/run) permission checks all call this, so they can never
// silently drift on what a given command needs -- same reasoning as
// classifyScheduledCommand's own header comment, extended.
//
// bridge:saveWorld classifies as `save` there, so it keeps the
// server.control that POST /server/save and POST /panel-bridge/world/save
// require.
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
    if (ENDANGER_OR_IMPERSONATE_BRIDGE_ACTIONS.has(action)) {
      return "players.endanger_or_impersonate";
    }
    return "server.world_events";
  }
  return "rcon.execute"; // kind === "raw"
}

// 2026-09-05, host-suspend-resume audit: node-cron 4.6.0 (node_modules/
// node-cron/dist/_shared.js, Runner.planBeat/beat) already detects a missed
// tick by comparing the expected fire time against the real clock at the
// next heartbeat -- exactly the case a host suspend/resume, or any long
// blocking I/O/CPU stall, produces (one or more scheduled slots pass while
// nothing was running to notice). It even names the cause in its own
// message: "missed execution... Possible blocking IO or high CPU". The gap
// is visibility, not detection: InlineScheduledTask's DEFAULT reaction is a
// bare `console.warn` through node-cron's OWN internal logger (verified by
// reading _shared.js's defaultLogger -- it is not routed through this
// app's winston logger at all), which on a packaged, console-less install
// (a Windows service, `pm2`, any process manager without an attached
// terminal) is very likely never seen by anyone. A missed scheduled
// restart or backup was, before this, indistinguishable from one that
// simply never got configured -- both produce total silence.
//
// Attaching our OWN 'execution:missed' listener on the returned task
// SUPPRESSES node-cron's own default warning (see InlineScheduledTask's
// own onMissedExecution: it checks `emitter.listenerCount('execution:
// missed') > 0` before logging) -- so this handler takes over that
// responsibility completely rather than adding a second, differently-
// worded message alongside it.
//
// `taskId` is null for the two "system" schedules (auto-restart, backup)
// exactly like their own real-run logScheduleExecution() calls already do
// elsewhere in this file -- Schedule History conflates them by command
// string, not taskId, for those two (see getLatestScheduleExecutionByCommand's
// own comment in database/init.js).
function onScheduleMissed(taskId, label, command, context) {
  const missedAt =
    context?.dateLocalIso ||
    (context?.date instanceof Date ? context.date.toISOString() : String(context?.date ?? "an unknown time"));
  log.warn(
    `Scheduled ${label ? `"${label}"` : "task"} (${command}) missed its run at ${missedAt} -- the panel likely was not running or was blocked at that moment (host suspend/resume, a restart, or sustained CPU/IO load).`,
  );
  logScheduleExecution(
    taskId,
    label,
    command,
    false,
    `Missed scheduled run at ${missedAt} -- the panel was not running or was blocked at that moment`,
    0,
  ).catch((err) =>
    log.debug(`Could not record missed-execution history: ${err.message}`),
  );
}

// A scheduled backup that comes due while a restart is running waits for
// it (see _onScheduledBackupTick()). How often it re-checks:
const DEFERRED_BACKUP_POLL_MS = 5000;
// How long a scheduled backup tick that sees no restart waits before looking
// once more -- long enough for a restart due in the same second to claim
// restartInProgress first (see _onScheduledBackupTick()), and nothing next
// to a backup's own run time.
const SAME_SECOND_RESTART_SETTLE_MS = 5000;
// How long past the running restart's own warning countdown that wait may
// last before the restart is called stuck. performRestart()'s post-countdown
// sequence is bounded by its own timeouts -- about a minute of final
// countdown, the world save, up to about 2 minutes for the old process to
// exit (a wall-clock cap of that wait's own, plus the one scan in flight)
// and a forced stop, 60 looks for the new one to appear and ~5 minutes of
// RCON retries: 12-13 minutes at its slowest. 20 leaves room for a slow
// disk or save without calling a healthy restart stuck.
const RESTART_SEQUENCE_BUDGET_MS = 20 * 60 * 1000;
// Added per minute of that countdown: each minute's warning broadcast is an
// RCON round trip on top of the minute's own sleep, and against a degraded
// RCON one can take a connect timeout plus a command timeout (rcon.js:
// 13 s + 10 s) before giving up -- so a long countdown that is healthy but
// can't reach its players runs well past its nominal length, and a
// 60-minute one would otherwise spend half the budget above before its
// stop/start sequence even began.
const COUNTDOWN_MINUTE_OVERRUN_MS = 30 * 1000;
// MAX_RESTART_WARNING_MINUTES (utils/restartWarning.js) is POST
// /scheduler/restart-now's own cap on the countdown, and what the deferred
// backup's wait uses if it can't see the running restart's real countdown
// (defensive: both are set together in performRestart()).

// performRestart()'s countdown when its caller passes none -- every
// scheduled task restart and AUTO_RESTART_CRON. One function so the
// restart-overlap warning predicts the countdown performRestart() uses.
// RESTART_WARNING_MINUTES=0 is honoured (an immediate restart) and a value
// above the cap is held to it; what was changed is logged once per value,
// not on every restart.
let lastReportedRestartWarningEnv;
export function defaultRestartWarningMinutes() {
  const raw = process.env.RESTART_WARNING_MINUTES;
  const { minutes, note } = parseDefaultRestartWarningMinutes(raw);
  if (note && raw !== lastReportedRestartWarningEnv) {
    lastReportedRestartWarningEnv = raw;
    log.warn(note);
  }
  return minutes;
}

// Whether the server process the panel itself spawned is still running:
// what confirms a start while the process scan can't answer.
function launchedProcessRunning(serverManager) {
  const child = serverManager?.serverProcess;
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

// GH #269: a restart that has already stopped the server and finds its
// relaunch refused only by a Steam install/update on the install folder
// waits up to this long for it to finish, looking every few seconds.
export const RESTART_STEAM_OPERATION_WAIT_MS = 15 * 60 * 1000;
export const RESTART_STEAM_OPERATION_POLL_MS = 5000;

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
    this.autoRestartCron = null; // the expression autoRestartJob runs, for the overlap warning
    this.backupJob = null;
    this.modUpdateRestartPending = false;
    this.restartInProgress = false;
    // {startedAt, warningMinutes} of the restart restartInProgress refers
    // to -- lets a deferred backup tell a long countdown from a stuck
    // restart. Set and cleared alongside restartInProgress.
    this.activeRestart = null;
    // {since, running} while a scheduled backup that came due mid-restart
    // is waiting for (or running after) that restart -- see
    // _deferScheduledBackupUntilRestartEnds().
    this.deferredBackup = null;
    // The scheduled backup tick in flight (settling, waiting out a restart or
    // running), so a tick arriving meanwhile folds into it instead of racing
    // it -- see _onScheduledBackupTick().
    this.scheduledBackupTick = null;
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
  // `phase` defaults to deriving straight from `running` (stopped/running)
  // for the common case; the restart-start transition below passes an
  // explicit 'starting' or 'unresponsive' from resolveServerPhase() instead
  // -- see that function's own comment for why "the new instance is up" and
  // "RCON is ready" are different claims (2026-09-07 STARTING-state fix).
  // Display-only, same as everywhere else this phase is threaded through.
  //
  // `serverId` is the server the restart is pinned to. Every other
  // server:status push describes the ACTIVE server, but a scheduled task can
  // restart a different one (and the active server can be switched mid-
  // restart), so this payload says which server it is about: clients apply a
  // push that names another server to nothing (the sidebar dot used to flip
  // to "stopped" for the whole restart of a server it wasn't showing). Left
  // out when the restart's target couldn't be pinned, which reads as "the
  // active server", as every unlabelled push does.
  _emitVerifiedTransition(running, phase = running ? "running" : "stopped", serverId = null) {
    if (typeof this.io?.emit === "function") {
      this.io.emit("server:status", {
        running,
        phase,
        ...(serverId != null ? { serverId } : {}),
      });
    }
  }

  // The old process's last status.json write outlives it
  // (PanelBridge.markServerExited()). The status watchdog expires it on a
  // stopped verdict, but this restart pushes its own verified transitions
  // instead of going through that watchdog, and the old process is only
  // down for the few seconds before the relaunch -- a 10s watchdog tick
  // often misses that window, leaving PanelBridge reading Up through the
  // new process's whole world load on the previous run's heartbeat. Only
  // for the active server: panelBridge watches the active server's folder,
  // and a throwaway ServerManager may be restarting a different one.
  async _expireBridgeHeartbeatAfterVerifiedStop(pinnedServerId) {
    if (pinnedServerId == null) return;
    try {
      const activeServer = await getActiveServer();
      if (String(activeServer?.id) !== String(pinnedServerId)) return;
      panelBridge.markServerExited();
    } catch (error) {
      log.debug(`Auto-restart: could not expire the old PanelBridge heartbeat: ${error.message}`);
    }
  }

  // The verified start's counterpart (PanelBridge.markServerRunning()):
  // without it Settings > Bridge kept saying "the game server has stopped"
  // beside the 'starting' push until the watchdog's next running tick. The
  // old heartbeat stays expired either way. Same active-server guard.
  async _noteBridgeServerRunningAfterVerifiedStart(pinnedServerId) {
    if (pinnedServerId == null) return;
    try {
      const activeServer = await getActiveServer();
      if (String(activeServer?.id) !== String(pinnedServerId)) return;
      panelBridge.markServerRunning();
    } catch (error) {
      log.debug(`Auto-restart: could not tell PanelBridge the server is running again: ${error.message}`);
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
    job.on("execution:missed", (context) => onScheduleMissed(task.id, task.name, task.command, context));

    this.jobs.set(task.id, job);
    this.jobLabels.set(task.id, task.name || task.command || "task");
    log.info(`Scheduled task: ${task.name} (${task.cron_expression})`);

    // 2026-09-05, scheduler-time-audit: nothing silent -- log it server-side
    // now, and hand it back so the create/update route can surface it in
    // the API response (Scheduler.tsx reading that field is carded
    // separately). Non-null return is still truthy/`!== false`, so this
    // does not change either existing caller's success/failure check.
    const dstWarning =
      dstFallBackWarning(task.cron_expression, this.effectiveTimezone, task.name) ||
      dstSpringForwardWarning(task.cron_expression, this.effectiveTimezone, task.name);
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
      // scheduled-task-overlap-refusal-silent-in-history, continuous-bug-hunt
      // round 10: every OTHER refusal this file can produce (a missed cron
      // tick via onScheduleMissed, a busy lifecycle lock, RCON unreachable,
      // a failed process scan, ...) already writes a Schedule History entry
      // -- this was the one exception. A task whose previous run is still
      // in flight when its next tick (or a manual "Run now" click) lands
      // was refused with zero trace: not logged here, and node-cron itself
      // considers this execution to have fired exactly on time (it has no
      // idea our own callback short-circuited), so 'execution:missed' never
      // fires for it either. The live "Run now" caller still sees the
      // refusal via the {success:false} this already returned (routes/
      // scheduler.js's socket emission), but Schedule History -- the
      // durable audit trail onScheduleMissed's own comment above exists
      // specifically to keep from going silent -- had nothing,
      // indistinguishable from a healthy schedule with nothing due.
      const message = "Already running";
      await logScheduleExecution(task.id, task.name, task.command, false, message, 0);
      return { success: false, message };
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
      // continuous-bug-hunt round 19 (duplicate Schedule History row):
      // executeTask()'s restart branch tags the Error it throws with
      // alreadyLoggedToScheduleHistory when performRestart() already wrote
      // its own row for this exact failure (deep RCON/process/container
      // failures) -- logging again here would be a second row for the same
      // execution. performRestart() tags an error it THROWS the same way
      // once its own catch has logged it (a start that threw, e.g.
      // SERVER_START_SCRIPT_MISSING). Every OTHER task kind
      // (save/servermsg/bridge/...) never sets this flag, so this still
      // logs for them exactly as before.
      if (!error.alreadyLoggedToScheduleHistory) {
        await logScheduleExecution(
          task.id,
          task.name,
          task.command,
          false,
          error.message,
          duration,
        );
      }
      await logServerEvent(
        "scheduled_task_error",
        `${task.name}: ${error.message}`,
      );
      // A coded refusal's code and params ride along, so "Run now" on a
      // restart task shows SERVER_START_SCRIPT_MISSING /
      // SERVER_RESTART_SCRIPT_MISSING translated, like a Dashboard Restart
      // (routes/scheduler.js's codedActionResultFields() picks which).
      return error.code
        ? { success: false, message: error.message, code: error.code, params: error.params }
        : { success: false, message: error.message };
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
        // scheduler-logscheduleexecution-callers-may-pass-unverified-outcomes,
        // god-dispatched 2026-09-09: used to only throw for the one
        // "Restart already in progress" message, letting every OTHER
        // performRestart() failure (RCON unreachable, process scan failed,
        // container restart failed, old server never confirmed stopped, the
        // new one never came back up, the lifecycle lock already held by a
        // different in-flight operation, ...) fall through here silently.
        // With no throw, this function returns normally and runTaskNow()
        // below unconditionally logs success:true "Completed successfully"
        // -- exactly the 63a32640 shape (a confident, unverified verdict
        // written to the audit trail) god named this hunt after, except
        // here it's worse: for most of those failures performRestart()
        // ALREADY wrote its own true `false` entry to Schedule History
        // moments earlier, so the record for one execution would show a
        // real failure immediately followed by a fabricated success. And
        // the lifecycle-lock-busy guard specifically returns `error`, not
        // `message` (see lifecycleInProgressResponse()) -- the old
        // string-equality check could never have matched it even by
        // accident, so that path had NO failure entry at all, only the
        // fabricated success. Throwing on any `!result.success` guarantees
        // runTaskNow's catch logs a false entry every time.
        //
        // continuous-bug-hunt round 19 (duplicate Schedule History row):
        // "occasionally a harmless duplicate of one performRestart() already
        // wrote" (the original wording here) was the SAME tradeoff
        // setupAutoRestart's cron callback made, and it turned out to be the
        // common case, not the edge case -- a real deep failure inside
        // performRestart() logs its own row AND (via this throw) makes
        // runTaskNow's catch log a second one for the identical execution.
        // performRestart() now marks every return where it already logged
        // with `logged: true`; tag the thrown Error with the same flag so
        // runTaskNow's catch (below) can skip its own logScheduleExecution
        // call for this one already-recorded case, without touching how it
        // handles every OTHER task kind's failure.
        if (!result.success) {
          const err = new Error(
            result.message || result.error || "Restart failed",
          );
          if (result.logged) err.alreadyLoggedToScheduleHistory = true;
          // A coded failure (SERVER_RESTART_RCON_UNAVAILABLE,
          // SERVER_RESTART_SAVE_FAILED) keeps its code and params, so "Run
          // now" shows it translated like a Dashboard Restart does.
          if (result.code) {
            err.code = result.code;
            if (result.params) err.params = result.params;
          }
          throw err;
        }
      } else if (commandKind === "save") {
        const saved = await rconService.save({ skipLog: true });
        if (!saved?.success) {
          throw new Error(`Save failed: ${saved?.error || "unknown error"}`);
        }
        if (isBridgeSaveWorldCommand(task.command)) {
          await this.refreshWorldSandboxAfterBridgeSave(task, cleanup);
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

  // serverManager.checkStoppedEvidence(), for a restart whose process scan
  // can't answer; "not stopped" when the manager has no such check.
  async _readStoppedEvidence(serverManager, options) {
    if (typeof serverManager?.checkStoppedEvidence !== "function") {
      return { stopped: false, reason: "no other check is available" };
    }
    try {
      const evidence = await serverManager.checkStoppedEvidence(options);
      return evidence && typeof evidence === "object"
        ? { stopped: evidence.stopped === true, reason: String(evidence.reason || "no reason given") }
        : { stopped: false, reason: "no answer" };
    } catch (error) {
      return { stopped: false, reason: `the check failed (${error.message})` };
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

      // SECURITY (2026-10-05, PATHS-2): this writes .bak copies into the
      // config folder, so a configured one is used only while it is inside
      // the server's own data folder (utils/serverConfigPath.js), and while
      // that data folder meets the data-folder rule; refused, this restart
      // just isn't covered, as when there is no folder.
      const configFolder = serverConfigDirOf(server);
      if (configFolder.refused) {
        log.warn(`Pre-restart config backup skipped: ${serverConfigDirRefusalReason(configFolder)}`);
      }
      const serverConfigPath = configFolder.dir;
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

  // A stored bridge:saveWorld task was the bridge's save until #197, which
  // also rewrote the world's map_sand.bin with the live sandbox settings.
  // On a world that already has one (the game loads it over SandboxVars.lua
  // on every start), live changes the panel didn't put there, such as the
  // in-game admin panel's, lasted through a restart only because of that.
  // So after the server's own save the bridge rewrites it, as before; a
  // world without one never gets one. Not saved there = the task fails
  // with the reason, in Schedule History. PanelBridge only reaches the
  // active server, so a task pinned to another one saves it and stops.
  async refreshWorldSandboxAfterBridgeSave(task, cleanup) {
    if (cleanup) {
      log.warn(
        `Scheduled task "${task.name}" saved its server; its map_sand.bin, if any, is not refreshed: PanelBridge only reaches the active server`,
      );
      return;
    }
    const { worldSandboxSnapshot, error } = await refreshWorldSandboxSnapshotAfterSave(panelBridge);
    if (worldSandboxSnapshot && !worldSandboxSnapshot.refreshed) {
      throw new Error(
        `World saved, but its map_sand.bin, which the game loads over SandboxVars.lua on every start, was not refreshed (${error || "PanelBridge did not rewrite it"}). Live sandbox changes not in it are undone at the next start.`,
      );
    }
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

    // restoreUtilities/shutOffUtilities change sandbox options: on a world
    // with a map_sand.bin the bridge rewrites it too, so the change lasts
    // past the next start (#197). Whether it does is the panel's call, not
    // the task's stored args.
    if (LIVE_SANDBOX_BRIDGE_ACTIONS.has(action)) {
      args = withWorldSandboxSnapshotFlag(args, await findActiveWorldSandboxSnapshot());
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
      this._wakeRestartWaits();
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
    // ...and a backup still waiting out a restart: its wait loop checks
    // this marker on every poll and simply ends once it's gone.
    this.deferredBackup = null;

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

      this.backupJob = cron.schedule(
        settings.schedule,
        () => this._onScheduledBackupTick(settings),
        { timezone: this.effectiveTimezone },
      );
      this.backupJob.on("execution:missed", (context) =>
        onScheduleMissed(null, "Scheduled Backup", "backup", context),
      );

      log.info(`Backup schedule configured: ${settings.schedule} (timezone: ${this.effectiveTimezone})`);

      // The backup settings save route (routes/backup.js, not this fence)
      // isn't touched here -- log only, same reasoning as setupAutoRestart's
      // own warning above.
      const dstWarning =
        dstFallBackWarning(settings.schedule, this.effectiveTimezone, "backup") ||
        dstSpringForwardWarning(settings.schedule, this.effectiveTimezone, "backup");
      if (dstWarning) log.warn(dstWarning);
    } catch (error) {
      log.error(`Failed to setup backup schedule: ${error.message}`);
    }
  }

  // One scheduled-backup cron tick.
  //
  // Linux bug hunt (2026-08-29, hunt-wave5, suspect 4 -- overlap):
  // createBackup() zips whatever is on disk under savesPath, and
  // performRestart()'s world save (RCON `save`), the server writing on its
  // way down and the new instance loading the world back all touch files
  // under that exact path. A backup taken inside that window can archive a
  // save mid-write -- a corrupt or inconsistent snapshot that looks like a
  // normal backup until someone tries to restore it. So a tick that lands
  // mid-restart must not run right then.
  //
  // It used to be dropped instead, logged as a failed "Skipped: a restart
  // was in progress" row. 2026-09-27 Discord report: with a restart
  // schedule and the backup schedule on the same cadence (both every 4
  // hours on the hour), EVERY tick collided -- the operator silently got no
  // scheduled backups at all, plus a "Scheduled backup failing" warning
  // nothing could clear. Now the tick waits for the restart and runs as
  // soon as it is over.
  //
  // After the restart, not before it: running first would mean holding the
  // restart's save/quit until the zip finished (minutes, for a big world),
  // and a restart is often exactly what the operator or a mod-update
  // trigger needs to happen now -- nothing makes a restart wait on a
  // backup, on purpose (createBackup()'s own backupInProgress mutex covers
  // the backup<->restore direction instead). After is also the better
  // snapshot: performRestart() has just saved the world, and in the common
  // case by the time it returns the old process is confirmed gone and the
  // new one has loaded the world far enough to answer RCON (or the start
  // failed and nothing is running). Not always: when the server was
  // offline it returns ~10 s after launching it, and when its RCON wait
  // times out it returns without that confirmation -- on both paths the
  // new instance may still be loading the world, which is the same
  // hot-backup condition every scheduled backup of a running server
  // already archives under. Either way the restart's own save/quit is
  // over, and that is the write a backup must not cut through. The same
  // goes for a restart that FAILED part-way: whichever state it stopped
  // in, its sequence is no longer writing, and right after a failed
  // restart is when an operator most wants a fresh backup.
  //
  // The same-second tie -- the reported setup exactly: backup and restart
  // both "0 */4 * * *". node-cron arms one heartbeat timer per job, so which
  // callback runs first isn't guaranteed, and performRestart() sets
  // restartInProgress only after its own `await getActiveServer()` (a
  // scheduled restart task has a few more awaits before that, all in-memory
  // reads). A backup tick that ran first would see no restart and start
  // zipping straight through the countdown and, for a big world, into the
  // world save/quit. So a tick that sees no restart settles for
  // SAME_SECOND_RESTART_SETTLE_MS and looks again: a restart due in the same
  // second has claimed the flag by then, and the backup is held like any
  // other. A restart that starts AFTER that while the backup is still
  // zipping -- one scheduled a few minutes later, or a manual Restart Now --
  // is the one overlap left: its countdown usually outlasts the zip, and
  // closing it fully would mean performRestart() waiting on a backup, the
  // reverse of the one-directional rule above.
  //
  // One tick at a time: the tick that is settling, waiting out a restart or
  // zipping is `this.scheduledBackupTick` until it ends, and a tick that
  // arrives meanwhile folds into it. A backup that outlasts its schedule
  // interval (a big world on an every-15-minutes schedule) used to get its
  // next tick through as a second createBackup(), refused with "Backup
  // already in progress" and written to Schedule History as a failure -- and
  // the Dashboard's "Scheduled backup failing" warning -- for a backup that
  // was running fine.
  async _onScheduledBackupTick(settings) {
    if (this._foldIntoBackupInFlight()) return;
    const tick = { since: Date.now() };
    this.scheduledBackupTick = tick;
    try {
      if (!this.restartInProgress) {
        await this.sleep(SAME_SECOND_RESTART_SETTLE_MS);
      }
      if (this.restartInProgress) {
        await this._deferScheduledBackupUntilRestartEnds();
        return;
      }
      log.info("Executing scheduled backup");
      await this._runScheduledBackup(settings);
    } finally {
      if (this.scheduledBackupTick === tick) this.scheduledBackupTick = null;
    }
  }

  // A tick landing while an earlier one is still in flight -- waiting out (or
  // running after) a restart, or running -- folds into it: a second copy
  // would only race the first into createBackup()'s "Backup already in
  // progress" refusal and log a failure for a backup that IS happening.
  _foldIntoBackupInFlight() {
    if (!this.scheduledBackupTick) return false;
    log.info(
      this.deferredBackup
        ? "Scheduled backup tick folded into the one already held back by a server restart"
        : "Scheduled backup tick folded into the scheduled backup that is still running",
    );
    return true;
  }

  // Waits for the in-progress restart, then runs the backup that came due
  // during it -- see _onScheduledBackupTick() for why after, not before.
  // Bounded: a restart still going long after its own countdown plus
  // RESTART_SEQUENCE_BUDGET_MS is stuck, not slow, and the backup then
  // fails with a Schedule History row that says so, rather than waiting
  // forever with nothing on screen.
  async _deferScheduledBackupUntilRestartEnds() {
    const deferredAt = Date.now();
    const marker = { since: new Date(deferredAt).toISOString(), running: false };
    this.deferredBackup = marker;
    this._emitBackupDeferralChanged();
    log.info(
      "Scheduled backup deferred: a server restart is in progress -- it will run as soon as the restart finishes",
    );
    try {
      for (;;) {
        if (this.deferredBackup !== marker) return; // stopAllJobs() cancelled it
        if (!this.restartInProgress) {
          // Fresh settings, not the ones this tick was scheduled with: the
          // operator may have turned scheduled backups off while it waited.
          const settings = await this.backupService.getSettings();
          if (this.deferredBackup !== marker) return;
          if (!settings.enabled) {
            log.info(
              "Deferred scheduled backup dropped: scheduled backups were turned off while it waited",
            );
            return;
          }
          // Re-checked after that await: a restart starting in the gap
          // would otherwise turn this into createBackup()'s own mid-restart
          // refusal -- a logged failure -- instead of another wait.
          if (!this.restartInProgress) {
            marker.running = true;
            this._emitBackupDeferralChanged();
            await this._runScheduledBackup(settings, { deferredAt });
            return;
          }
        }
        if (Date.now() >= this._deferredBackupDeadline(deferredAt)) {
          await this._logStuckRestartBackup(deferredAt);
          return;
        }
        await this.sleep(DEFERRED_BACKUP_POLL_MS);
      }
    } catch (error) {
      // _runScheduledBackup() records its own failures; this is anything
      // else (a settings read failing) -- still a backup that didn't
      // happen, so it gets a row rather than vanishing into node-cron's
      // own error handler.
      log.error(`Deferred scheduled backup error: ${error.message}`);
      await logScheduleExecution(
        null,
        "Scheduled Backup",
        "backup",
        false,
        `Not run: ${error.message}`,
        Date.now() - deferredAt,
      ).catch(() => {});
    } finally {
      if (this.deferredBackup === marker) this.deferredBackup = null;
      // A wait that ended without running (stuck restart, backups turned
      // off, an error) -- the start of a run already said so above.
      if (!marker.running) this._emitBackupDeferralChanged();
    }
  }

  // getDeferredBackupSince() changes without any backup:progress event -- a
  // tick being held, or the held run starting -- so an open Backups page is
  // told to re-read status rather than left saying the schedule simply
  // didn't fire (or still "waiting" once it runs). Same broadcast shape as
  // backupService's own backup:progress.
  _emitBackupDeferralChanged() {
    if (typeof this.io?.emit === "function") {
      this.io.emit("backup:deferred", { since: this.getDeferredBackupSince() });
    }
  }

  // Measured from the running restart's own start and countdown, not from
  // when the backup began waiting: a backup that came due at minute 55 of a
  // 60-minute manual countdown shouldn't get a fresh hour of patience, and
  // one that came due during a 5-minute scheduled restart shouldn't sit for
  // an hour before anyone hears the restart is stuck. Re-read on every poll,
  // so a second restart starting right as the first ends gets its own
  // budget. Each countdown minute counts with its worst-case broadcast
  // overrun (COUNTDOWN_MINUTE_OVERRUN_MS), not as a bare 60 s.
  _deferredBackupDeadline(deferredAt) {
    const countdownMs = (minutes) => minutes * (60000 + COUNTDOWN_MINUTE_OVERRUN_MS);
    const restart = this.activeRestart;
    if (restart) {
      return restart.startedAt + countdownMs(restart.warningMinutes) + RESTART_SEQUENCE_BUDGET_MS;
    }
    return deferredAt + countdownMs(MAX_RESTART_WARNING_MINUTES) + RESTART_SEQUENCE_BUDGET_MS;
  }

  // How long the restart has been stuck is measured from the restart's own
  // start, not from when this backup began waiting: once one tick has given
  // up, every later tick during the same stuck restart is past the deadline
  // the moment it arrives, and "not finished 0 min later" would read as a
  // restart that had only just begun.
  //
  // The advice has to work in exactly this state. createBackup() refuses
  // every backup -- a manual one too -- while restartInProgress is set, and
  // cancelRestart() only acts during the countdown, so a restart hung past
  // it holds until the panel itself restarts (restartInProgress lives in
  // memory). "Create a backup manually" alone would send the operator
  // straight into "A server restart is in progress, please wait".
  //
  // No absolute timestamps in the message: it is shown verbatim as the
  // Dashboard's "Scheduled backup failing" detail and in the Backups card's
  // tooltip, and a panel running in UTC (the usual Docker setup) would
  // print times hours off from the operator's browser. The row's own
  // executedAt is already shown localized; this says how long, relative
  // to that.
  //
  // And written in the past tense, as a record of that moment: the row
  // stays the newest scheduled attempt -- and the Dashboard's warning --
  // until the next tick or a successful backup, which on a daily schedule
  // is hours later, typically after the operator has done exactly what it
  // advises and restarted the panel. "Still hasn't finished ... manual
  // backups are blocked" would by then be false, and read as if that panel
  // restart had done nothing. What the operator should do next stays
  // conditional ("if a restart still seems to be running") for the same
  // reason.
  //
  // Prose the panel wrote, not a raw error, so the row also carries a
  // message key and its numbers (restartStuck / restartStuckSinceDue): the
  // Dashboard, the Backups card, the Scheduler card and Schedule History
  // render it in the operator's language. The English stays as `message`,
  // for the log and for a client that doesn't know the key.
  async _logStuckRestartBackup(deferredAt) {
    const now = Date.now();
    const waited = now - deferredAt;
    const restart = this.activeRestart;
    const minutes = Math.round((restart ? now - restart.startedAt : waited) / 60000);
    const stuck = restart
      ? `the server restart had been running for ${minutes} min (${restart.warningMinutes}-minute warning) without finishing`
      : `the server restart running when this backup came due still hadn't finished ${minutes} min later`;
    const message =
      `Not run: ${stuck} -- far longer than a restart takes, so it looked stuck, and manual backups were blocked while it lasted. ` +
      "If a restart still seems to be running, check whether the game server came back up, then restart the panel to clear it. " +
      "Creating a backup after that also clears the failed-backup warning.";
    log.error(`Scheduled backup -- ${message}`);
    await logScheduleExecution(
      null,
      "Scheduled Backup",
      "backup",
      false,
      message,
      waited,
      restart
        ? { messageKey: "restartStuck", messageParams: { minutes, warningMinutes: restart.warningMinutes } }
        : { messageKey: "restartStuckSinceDue", messageParams: { minutes } },
    );
  }

  async _runScheduledBackup(settings, { deferredAt = null } = {}) {
    // A backup already running -- a manual "Create Backup Now", or the end of
    // a long scheduled one -- archives the same world, so this slot is
    // covered. createBackup() would refuse with "Backup already in progress",
    // which landed in Schedule History as a failure (and as the Dashboard's
    // "Scheduled backup failing") although nothing went wrong. Nothing is
    // awaited between this check and createBackup()'s own claim of the flag,
    // so the flag cannot flip in between; a real failure of a backup this
    // does start is still logged below.
    if (this.backupService.backupInProgress) {
      log.info(
        "Scheduled backup skipped: another backup is already in progress, which covers this slot",
      );
      return;
    }
    const startTime = Date.now();
    // Schedule History is the only place an unattended backup's story is
    // told -- a held-back run says so, instead of looking like it simply
    // fired late for no reason.
    let lateNote = "";
    if (deferredAt != null) {
      const waitedMinutes = Math.round((startTime - deferredAt) / 60000);
      lateNote = ` -- held back until a server restart that was running at its scheduled time finished (${waitedMinutes < 1 ? "under a minute" : `${waitedMinutes} min`} later)`;
    }
    // The servers chosen for the schedule (backupServerIds), one after the
    // other; with no choice made, the active server alone, as before.
    if (!Array.isArray(settings.serverIds)) {
      await this._runScheduledBackupOf(null, settings, lateNote);
      return;
    }
    let targets = [];
    try {
      targets = selectScheduledBackupServers({
        serverIds: settings.serverIds,
        servers: await getServers(),
        activeServer: await getActiveServer(),
      });
    } catch (error) {
      log.error(`Scheduled backup: could not read the servers to back up: ${error.message}`);
      return;
    }
    if (targets.length === 0) {
      log.info("Scheduled backup: no server is chosen for it");
      return;
    }
    for (const target of targets) {
      await this._runScheduledBackupOf(target, settings, lateNote);
    }
  }

  // One server's scheduled backup, written to Schedule History under that
  // server. `target` null: whichever server is active.
  async _runScheduledBackupOf(target, settings, lateNote) {
    const startTime = Date.now();
    // A legacy run (no target) writes its rows exactly as before.
    const history = target ? [{ serverId: target.id }] : [];
    try {
      const result = await this.backupService.createBackup({
        includeDb: settings.includeDb,
        ...(target ? { server: target } : {}),
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
          `Created: ${result.backup.name}${skipNote}${lateNote}`,
          duration,
          ...history,
        );
        log.info(`Scheduled backup completed: ${result.backup.name}${skipNote}${lateNote}`);
      } else {
        await logScheduleExecution(
          null,
          "Scheduled Backup",
          "backup",
          false,
          `${result.message}${lateNote}`,
          duration,
          ...history,
        );
        log.error(`Scheduled backup failed: ${result.message}${lateNote}`);
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      await logScheduleExecution(
        null,
        "Scheduled Backup",
        "backup",
        false,
        `${error.message}${lateNote}`,
        duration,
        ...history,
      );
      log.error(`Scheduled backup error: ${error.message}${lateNote}`);
    }
  }

  // When a scheduled backup is waiting out a restart (see
  // _deferScheduledBackupUntilRestartEnds()), the moment it came due --
  // null otherwise, including once it has started running. Surfaced by GET
  // /api/backup/status so the Backups page can say "waiting for the
  // restart" instead of looking like the schedule simply didn't fire.
  getDeferredBackupSince() {
    const marker = this.deferredBackup;
    return marker && !marker.running ? marker.since : null;
  }

  // Every schedule that ends up in performRestart() on its own:
  // user-scheduled `restart` tasks and AUTO_RESTART_CRON. Tasks targeting a
  // server other than the active one count too -- restartInProgress is one
  // flag for the whole panel, so their restarts hold backups back as well.
  async _getRestartSchedules() {
    const restarts = [];
    try {
      const tasks = await getScheduledTasks();
      for (const task of tasks || []) {
        if (task.enabled && classifyScheduledCommand(task.command) === "restart") {
          restarts.push({ kind: "task", name: task.name || null, cron: task.cron_expression });
        }
      }
    } catch (error) {
      log.debug(`Could not read scheduled tasks for the restart-overlap check: ${error.message}`);
    }
    if (this.autoRestartJob && this.autoRestartCron) {
      restarts.push({ kind: "autoRestart", name: null, cron: this.autoRestartCron });
    }
    return restarts;
  }

  // Which scheduled restarts `backupCron` keeps firing inside of (see
  // findBackupRestartOverlaps()) -- those backups are held back until the
  // restart finishes, so they run late. Advisory: the Backups/Scheduler
  // pages show it so the operator can stagger the two if they care.
  async getBackupRestartOverlaps(backupCron) {
    if (!backupCron) return [];
    const restarts = await this._getRestartSchedules();
    return findBackupRestartOverlaps(backupCron, restarts, {
      timezone: this.effectiveTimezone,
      windowMinutes: defaultRestartWarningMinutes() + RESTART_TYPICAL_TAIL_MINUTES,
    });
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
    this.autoRestartCron = cronExpression;
    this.autoRestartJob = cron.schedule(cronExpression, async () => {
      log.info("Executing scheduled auto-restart");
      try {
        // performRestart answers with a result rather than throwing when it
        // refuses or fails, so a silent no-op is the failure mode to catch.
        const result = await this.performRestart();
        if (!result?.success) {
          const message = result?.message || result?.error || "unknown error";
          log.error(`Scheduled auto-restart did not complete: ${message}`);
          // continuous-bug-hunt round 17 (scheduler overlap sweep): unlike
          // every OTHER refusal this function can produce (a busy
          // lifecycle lock further along, an execution failure deep inside
          // performRestart -- both already call logScheduleExecution
          // themselves before returning/throwing), performRestart()'s two
          // EARLIEST guards -- `this.restartInProgress` already true (a
          // manual restart, a scheduled task's own "restart" command, or a
          // still-running previous auto-restart tick overlapping this one),
          // and a lifecycle lock already held by an unrelated in-flight
          // operation (Steam update, wipe, ...) -- return {success:false}
          // WITHOUT ever recording anything, because both checks fire
          // BEFORE this.restartInProgress is set and before this function
          // reaches its own logging. Before this fix, the auto-restart
          // cron's OWN "next run" firing while blocked left ZERO trace in
          // Schedule History -- indistinguishable from a healthy schedule
          // with nothing due, the exact silent-refusal shape already fixed
          // for runTaskNow()'s self-overlap case (see its own comment
          // above) and for the scheduled backup's restart-overlap skip
          // (since replaced by a deferral -- see _onScheduledBackupTick()).
          //
          // continuous-bug-hunt round 19 (duplicate Schedule History row):
          // the ORIGINAL round-17 fix above logged unconditionally on
          // `!result.success`, accepting "occasionally a harmless
          // duplicate" as a tradeoff for closing the silent-refusal gap --
          // but a REAL deep-failure return (RCON unreachable, process scan
          // failed, container restart failed, ...) already calls
          // logScheduleExecution() itself, several hundred lines up inside
          // performRestart(), before returning here. Logging again
          // unconditionally meant every genuine restart failure produced
          // TWO Schedule History rows for the same execution, not one --
          // not a harmless edge case, the COMMON case. performRestart() now
          // marks every return where it already logged with `logged: true`
          // (the two early guards above, and the mid-countdown "cancelled"
          // returns, never set it, since neither of those paths logs
          // anything) -- checking it here closes the round-17 gap (an early
          // guard's refusal still gets recorded, since `logged` is falsy
          // there) without reintroducing the duplicate for every other
          // failure shape.
          if (!result?.logged) {
            await logScheduleExecution(null, "Auto Restart", "restart", false, message, 0);
          }
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
    this.autoRestartJob.on("execution:missed", (context) =>
      onScheduleMissed(null, "Auto Restart", "restart", context),
    );

    log.info(`Auto-restart scheduled: ${cronExpression} (timezone: ${this.effectiveTimezone})`);

    // Boot-time / env-driven, not a create/update API call -- log only,
    // same as the reasoning on scheduleTask()'s own warning above.
    const dstWarning =
      dstFallBackWarning(cronExpression, this.effectiveTimezone, "auto restart") ||
      dstSpringForwardWarning(cronExpression, this.effectiveTimezone, "auto restart");
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
  // Returns whether the RCON `servermsg` broadcast -- the ONE path that
  // actually reaches every player's chat -- was actually delivered. Callers
  // in the warning countdown use this to track whether players were really
  // warned, not just whether the countdown loop kept running; see
  // performRestart()'s own `failedWarningBroadcasts` comment for why this
  // matters (round 11, notification delivery truth).
  async _broadcastRestartMessage(text, rconService = this.rconService) {
    // RCON `servermsg` — primary path, works on B41 + B42 without the mod.
    let delivered = false;
    try {
      const r = await rconService.serverMessage(text, { skipLog: true });
      delivered = Boolean(r?.success);
      if (!delivered) {
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
    if (rconService !== this.rconService) return delivered;
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
    return delivered;
  }

  // Discord was already told the restart was coming, so it has to be told when
  // it isn't. Best-effort — a cancellation must never fail because of Discord.
  async _notifyRestartCancelled() {
    if (!this.discordBot) return;
    // The announcement it follows is the "Scheduled restart" event, which the
    // operator can switch off on the Discord page. With that off nothing was
    // announced, and a cancellation notice would be about a restart Discord
    // never heard of.
    if (!this.discordBot.webhookEvents?.scheduledRestart?.enabled) return;
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
      // the restart-outcome audit. Callers that ARE a
      // live, request-bound manual trigger should pass "Manual restart";
      // genuinely unattended triggers (the AUTO_RESTART_CRON job, a
      // mod-update restart, a scheduled task's cron fire) keep the default.
      label = "Auto Restart",
      lifecycleLock: providedLifecycleLock = null,
    } = {},
  ) {
    // normalize-lifecycle-lock-server-identifier follow-up,
    // performrestart-cannot-take-the-lock-id-without-reopening-a-race
    // (2026-09-09): resolve the FULL pinnedServerId -- including the async
    // getActiveServer() fallback for the common shared-singleton case where
    // serverManager._serverId is null -- BEFORE the restartInProgress
    // check, not after. The original version only ever fed the lock the
    // synchronous serverManager._serverId (populated only for a throwaway
    // ServerManager pointed at a specific non-active server; null for the
    // common case) specifically to keep this await from landing BETWEEN the
    // check and the `this.restartInProgress = true` set below -- reopening
    // the exact checked-then-set race /wipe's own wipeInProgress guard was
    // fixed against (a second concurrent performRestart() call, e.g.
    // AUTO_RESTART_CRON firing alongside a "Restart Now" click, passing the
    // check while the first call is still awaiting).
    //
    // Moving the await here instead keeps that invariant intact: the check
    // and the set are still two back-to-back synchronous statements with
    // zero awaits between them, so whichever call's continuation resumes
    // first still runs the whole check-acquire-set sequence to completion,
    // uninterrupted, before yielding again -- same guarantee as before, just
    // established one await earlier. The only behavioural cost is that a
    // call rejected as a duplicate now also pays for one getActiveServer()
    // read first (a cached in-memory lookup, not a real query) instead of
    // returning instantly; in exchange the common case's lifecycle lock (and
    // the 409 message it drives) can finally carry a real server id instead
    // of always falling back to serverManager?.serverName.
    let pinnedServerId = serverManager._serverId ?? null;
    let targetServer = null;
    if (pinnedServerId == null) {
      try {
        targetServer = await getActiveServer();
        pinnedServerId = targetServer?.id ?? null;
      } catch (error) {
        log.debug(`Could not pin restart target: ${error.message}`);
      }
    } else {
      try {
        targetServer = await getServer(pinnedServerId);
      } catch (error) {
        log.debug(`Could not read restart target: ${error.message}`);
      }
    }

    // A remote server's process is not this panel's to stop or start. Every
    // entry point that reaches here unattended (the AUTO_RESTART_CRON job, a
    // scheduled `restart` task, the mod-update restart) had no such check
    // -- only POST /restart-now and POST /server/restart refuse a remote
    // server -- so the sequence below ran its whole warning countdown, sent
    // the RCON save and quit, and only then found startServer() had nothing
    // to launch ("Server path not configured"): the remote game was left
    // down. Refused up front, before the lifecycle lock, the restart flag
    // and any RCON traffic, so nothing is announced, saved or stopped. (A
    // server with a Docker container mapped to it is restarted through
    // Docker below, remote flag or not, and is not refused here.)
    if (isUnmanagedRemoteServer(targetServer)) {
      const message =
        "Cannot restart a remote server. The process is not managed by this panel.";
      log.warn(`Restart refused: ${message}`);
      return {
        success: false,
        message,
        code: ErrorCode.SCHEDULER_RESTART_REMOTE_NOT_SUPPORTED,
      };
    }

    // Prevent concurrent restarts -- ATOMIC with the acquire+set immediately
    // below: no await may be introduced between this check and
    // `this.restartInProgress = true`, see the resolution above.
    if (this.restartInProgress) {
      log.info("Restart already in progress, ignoring duplicate request");
      // `busy`: refused before anything began, so a caller may try again
      // once that restart is over (services/serverWatch.js does).
      return { success: false, busy: true, message: "Restart already in progress" };
    }

    const lifecycleLock =
      providedLifecycleLock || acquireLifecycleLock("restart", pinnedServerId);
    if (!lifecycleLock) {
      return { success: false, ...lifecycleInProgressResponse() };
    }

    this.restartInProgress = true;
    this.restartCancelled = false; // Allow cancellation
    // continuous-bug-hunt round 28 (ux-proposals-need-backend-data): this
    // function does its own quit()+wait+start() sequence rather than going
    // through ServerManager.restartServer() (which sets the identical
    // stopIntent='restart' at its own entry, for its own separate callers)
    // -- set here so checkServerStatusNow (server/index.js) can tell this
    // upcoming stop apart from an unrelated deliberate stop or a genuine
    // crash the moment it's observed. Set on the SAME serverManager instance
    // the rest of this function already pins its stop/start target to
    // (pinnedServerId, resolved above), not the shared singleton
    // unconditionally.
    serverManager.stopIntent = "restart";
    const warningMinutes = warningMinutesParam ?? defaultRestartWarningMinutes();
    const restartWarning = normalizeRestartWarningSettings(this.restartWarning);
    const restartStartTime = Date.now();
    // Still synchronous with the restartInProgress set above, so a deferred
    // scheduled backup never sees the flag without this.
    this.activeRestart = { startedAt: restartStartTime, warningMinutes };

    // pinnedServerId (resolved above, before the restartInProgress check) is
    // also what the restart logic below pins the actual start/stop target
    // to. The shared ServerManager otherwise re-reads "whichever server is
    // active" when it starts, so switching servers mid-countdown would stop
    // one server and bring a different one up in its place.

    // Set once the server is back up and only its RCON is awaited: from then
    // on the restart holds its own server, not the whole panel.
    let rconHold = null;
    // True once this restart has stopped a running server (or is starting
    // one a previous restart left stopped): a failure from then on leaves
    // the server down because of the panel, see getInterruptedRestart().
    let leavesServerStopped = false;
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
        const evidence = processScanFailed
          ? await this._readStoppedEvidence(serverManager, { serverId: pinnedServerId })
          : null;
        if (evidence?.stopped) {
          log.info(
            `Auto-restart: process detection failed, but ${evidence.reason}, so the server counts as stopped`,
          );
        } else if (processScanFailed) {
          if (evidence) log.warn(`Auto-restart: process detection failed and ${evidence.reason}`);
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
            { serverId: pinnedServerId },
          );
          logServerEvent("auto_restart_error", errorMsg, { serverId: pinnedServerId });
          return { success: false, wasRunning: false, message: errorMsg, logged: true };
        }

        // Server wasn't running - start it through the owning lifecycle
        // provider. A managed container must never fall through to the native
        // JVM path: that would create a second server outside Docker.
        // files are already static -- same coverage as the main branch
        // below, see _backupConfigBeforeRestart()'s own comment. The launch
        // target (RCON in the ini, the generated script) is refreshed by
        // both start calls below themselves, the same way as for the
        // dashboard's Start -- see lifecycleCoordinator.prepareForLaunch().
        log.info(
          "Auto-restart triggered but server was not running - starting server",
        );
        if (this.getInterruptedRestart(pinnedServerId)) leavesServerStopped = true;
        await this._backupConfigBeforeRestart(pinnedServerId);
        const managedStart = await runManagedLifecycle("start", {
          serverId: pinnedServerId,
        });
        let started;
        if (managedStart.handled) {
          started = managedStart;
        } else {
          started = await serverManager.startServer({
            serverId: pinnedServerId,
          });
        }
        if (!started?.success) {
          log.warn(
            `Auto-restart: start command reported failure: ${started?.error || started?.message || "unknown error"}`,
          );
        }

        // Wait a bit and verify it started
        await this._restartSleep(10000);
        const postStartDetails = await readProcessDetails();
        const isNowRunning =
          rconService.connected ||
          Boolean(postStartDetails && !postStartDetails.scanFailed && postStartDetails.running) ||
          // A scan that can't answer: the process the panel launched.
          Boolean(
            (!postStartDetails || postStartDetails.scanFailed) &&
              started?.success &&
              !managedStart.handled &&
              launchedProcessRunning(serverManager),
          );

        const restartDuration = Date.now() - restartStartTime;
        if (isNowRunning) {
          await logScheduleExecution(
            null,
            label,
            "restart",
            true,
            "Server was offline - started successfully",
            restartDuration,
            { serverId: pinnedServerId },
          );
          logServerEvent(
            "auto_restart",
            "Server was offline - started successfully",
            { serverId: pinnedServerId },
          );
          log.info("Server started successfully (was not running)");
          this._clearInterruptedRestart(pinnedServerId);
        } else {
          if (leavesServerStopped) {
            this._noteInterruptedRestart(pinnedServerId, "Server was offline - failed to start");
          }
          await logScheduleExecution(
            null,
            label,
            "restart",
            false,
            "Server was offline - failed to start",
            restartDuration,
            { serverId: pinnedServerId },
          );
          logServerEvent(
            "auto_restart_error",
            "Server was offline - failed to start",
            { serverId: pinnedServerId },
          );
          log.error("Failed to start server");
        }
        return { success: isNowRunning, wasRunning: false, logged: true };
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
        const reason = testResult.error || "connection failed";
        const errorMsg = `RCON not available: ${reason}`;
        log.error(`Auto-restart failed: ${errorMsg}`);
        await logScheduleExecution(
          null,
          label,
          "restart",
          false,
          errorMsg,
          restartDuration,
          { serverId: pinnedServerId },
        );
        logServerEvent("auto_restart_error", errorMsg, { serverId: pinnedServerId });
        // A server whose game thread died (42.21's UnsatisfiedLinkError
        // during a save, 2026-10-01) fails HERE, not at the save below: the
        // game runs every RCON command on that same main thread
        // (RCONServer.update() from GameServer.main), so `players` fails
        // exactly like `save` does. Coded like SERVER_RESTART_SAVE_FAILED,
        // so the Restart toast says, in the operator's language, that
        // nothing was stopped and that Force stop is the way down. Nothing
        // was stopped, so the restart intent set above is withdrawn.
        if (serverManager.stopIntent === "restart") serverManager.stopIntent = null;
        return {
          success: false,
          wasRunning: true,
          message: errorMsg,
          logged: true,
          code: ErrorCode.SERVER_RESTART_RCON_UNAVAILABLE,
          params: { reason },
        };
      }

      // GH #167: startServer() refuses a server whose generated startup
      // script is missing and can't be written (SERVER_START_SCRIPT_MISSING).
      // Asked here, before the countdown, save and quit -- that refusal only
      // came after the stop below, and left a server that was running fine
      // down until someone fixed the folder and pressed Start. Thrown into
      // the catch below (Schedule History row, translated Restart toast).
      // Nothing was stopped, so the restart intent set above is withdrawn
      // rather than left for the next unrelated stop or crash.
      if (typeof serverManager.assertNamedStartupScriptLaunchable === "function") {
        try {
          await serverManager.assertNamedStartupScriptLaunchable({
            serverId: pinnedServerId,
          });
        } catch (error) {
          if (serverManager.stopIntent === "restart") serverManager.stopIntent = null;
          throw error;
        }
      }

      log.info("Auto-restart: RCON verified, sending warnings...");

      // continuous-bug-hunt round 11 (notification delivery truth):
      // _broadcastRestartMessage() is deliberately best-effort and never
      // throws (RCON can legitimately drop mid-countdown after the
      // just-passed connectivity check above -- a multi-minute warning
      // sequence has plenty of time for that), so the loops below keep
      // running warning-to-warning regardless of whether any single one
      // actually reached a player. Before this fix, a broadcast failure was
      // only ever a buried log.warn(): the restart could go on to succeed
      // completely (world saved, server back up) and get logged to
      // Schedule History as an unqualified "Server restarted successfully"
      // even though players were NEVER actually warned it was coming. Track
      // failures here and fold the count into that same success message
      // instead of only the server log -- same reasoning as every other
      // "don't let success:true imply more than what was actually
      // verified" fix in this file.
      let failedWarningBroadcasts = 0;

      // Stop and Force stop cancel a restart at any point (an operator must be
      // able to turn the server off while it restarts), not only during the
      // countdown: every wait below ends the moment the restart is cancelled
      // and the next step is not taken. Nothing is started again.
      const stopCancelledRestart = async (stage) => {
        log.info(`Auto-restart: cancelled (${stage})`);
        // Stop / Force stop: the server is meant to stay down now.
        this._clearInterruptedRestart(pinnedServerId);
        if (serverManager.stopIntent === "restart") serverManager.stopIntent = null;
        if (rconService.setServerStarting) {
          rconService.setServerStarting(false);
        } else {
          rconService.serverStarting = false;
        }
        await this._notifyRestartCancelled();
        return { success: false, message: "Restart cancelled" };
      };

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
          const delivered = await this._broadcastRestartMessage(
            formatRestartWarning(restartWarning, i, "minute"),
            rconService,
          );
          if (!delivered) failedWarningBroadcasts++;

          if (i > 1) {
            await this._restartSleep(60000); // Wait 1 minute
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
          await this._restartSleep(tick.wait);
          if (this.restartCancelled) {
            log.info("Auto-restart: Cancelled during final countdown");
            await this._broadcastRestartMessage(
              getRestartWarningNotice(restartWarning, "cancelled"),
              rconService,
            );
            await this._notifyRestartCancelled();
            return { success: false, message: "Restart cancelled" };
          }
          const delivered = await this._broadcastRestartMessage(
            formatRestartWarning(restartWarning, tick.count, "second"),
            rconService,
          );
          if (!delivered) failedWarningBroadcasts++;
        }

        // One last second, then go.
        await this._restartSleep(1000);
        if (
          !(await this._broadcastRestartMessage(
            getRestartWarningNotice(restartWarning, "restarting"),
            rconService,
          ))
        ) {
          failedWarningBroadcasts++;
        }
        await this._restartSleep(2000);
      } else {
        // Immediate restart - just a brief message
        if (
          !(await this._broadcastRestartMessage(
            getRestartWarningNotice(restartWarning, "restarting"),
            rconService,
          ))
        ) {
          failedWarningBroadcasts++;
        }
        await this._restartSleep(2000);
      }

      if (this.restartCancelled) return stopCancelledRestart("before the save");

      // Save world - skip logging for automated save
      log.info("Auto-restart: Saving world...");
      const saveResult = await rconService.save({ skipLog: true });
      if (!saveResult?.success) {
        const restartDuration = Date.now() - restartStartTime;
        const reason = saveResult?.error || "unknown error";
        const errorMsg = `Save failed; restart cancelled: ${reason}`;
        log.error(`Auto-restart: ${errorMsg}`);
        await logScheduleExecution(
          null,
          label,
          "restart",
          false,
          errorMsg,
          restartDuration,
          { serverId: pinnedServerId },
        );
        await logServerEvent("auto_restart_error", errorMsg, { serverId: pinnedServerId });
        // Coded so a failed Restart's toast can say what to do next (a
        // stuck server only goes down through Force stop) in the
        // operator's language -- see routes/scheduler.js's
        // codedActionResultFields(). The schedule history keeps errorMsg.
        return {
          success: false,
          wasRunning: true,
          message: errorMsg,
          logged: true,
          code: ErrorCode.SERVER_RESTART_SAVE_FAILED,
          params: { reason },
        };
      }
      await this._restartSleep(3000);
      if (this.restartCancelled) return stopCancelledRestart("after the save");

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
          { serverId: pinnedServerId },
        );
        logServerEvent("auto_restart_error", errorMsg, { serverId: pinnedServerId });
        return { success: false, wasRunning: true, message: errorMsg, logged: true };
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
        await this._restartSleep(10000);

        // Wait for server to stop: 60 looks a second apart, as before, now
        // also capped at 2 minutes so scans that keep running into their
        // own 18 s timeout can't hold the restart for 60 of those. A failed
        // scan is unknown, not stopped -- and not the end of the wait
        // either (GH #190, see waitForProcessExit()). The old server's PIDs
        // from the check above also confirm the stop once they're gone from
        // a scan whose only doubt is a process it can't read. Still unknown
        // when the wait ends, the restart gives up: no second server over
        // one that may be running, and no kill on a guess -- the forced
        // stop below is for a confirmed `running` only.
        const stopUnconfirmed = async () => {
          const restartDuration = Date.now() - restartStartTime;
          const errorMsg =
            "Could not confirm the old server stopped because process detection kept failing, so the new server was not started. Check whether the old one is still running before starting it.";
          log.error(`Auto-restart failed: ${errorMsg}`);
          await logScheduleExecution(
            null,
            label,
            "restart",
            false,
            errorMsg,
            restartDuration,
            { serverId: pinnedServerId },
          );
          logServerEvent("auto_restart_error", errorMsg, { serverId: pinnedServerId });
          return {
            success: false,
            wasRunning: true,
            message: errorMsg,
            logged: true,
            code: ErrorCode.SERVER_RESTART_STOP_UNCONFIRMED,
          };
        };
        let processDetails = await waitForProcessExit(readProcessDetails, {
          polls: 60,
          intervalMs: 1000,
          maxElapsedMs: 2 * 60 * 1000,
          sleep: (ms) => this.sleep(ms),
          context: "Auto-restart",
          ownProcesses: initialProcessDetails?.owned,
        });
        if (processDetails.scanFailed) {
          // Still unknown: the RCON port refusing connections plus the
          // console log's shutdown lines settle it
          // (serverManager.checkStoppedEvidence()).
          const evidence = await this._readStoppedEvidence(serverManager, {
            serverId: pinnedServerId,
          });
          if (!evidence.stopped) {
            log.warn(`Auto-restart: process detection never answered and ${evidence.reason}`);
            return stopUnconfirmed();
          }
          log.info(
            `Auto-restart: process detection never answered, but ${evidence.reason}, so the old server counts as stopped`,
          );
          processDetails = { ...processDetails, running: false, scanFailed: false };
        }

        // Force stop if needed
        if (processDetails.running) {
          const forced = await serverManager.stopServer({
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
              { serverId: pinnedServerId },
            );
            logServerEvent(
              "auto_restart_error",
              `Could not confirm the old server stopped: ${stopError}`,
              { serverId: pinnedServerId },
            );
            return {
              success: false,
              wasRunning: true,
              message: `Could not confirm the old server stopped: ${stopError}`,
              logged: true,
            };
          }
          await this._restartSleep(5000);
        }

        // The old process is now confirmed stopped (either the while loop
        // above observed processDetails.running go false, or the forced
        // stop just above succeeded) -- push it instead of leaving clients
        // reading the pre-restart "running" status for the whole remainder
        // of this sequence (config backup + relaunch + up to 4 more minutes
        // of RCON waiting below). The heartbeat goes first, for the same
        // reason the watchdog orders it before its own push.
        await this._expireBridgeHeartbeatAfterVerifiedStop(pinnedServerId);
        this._emitVerifiedTransition(false, "stopped", pinnedServerId);
        leavesServerStopped = true;

        // Extra delay after stop — give OS time to fully reap the process
        // (zombie processes on Linux, WMI cache on Windows)
        await this._restartSleep(3000);
      }

      // See _backupConfigBeforeRestart()'s own comment: config files are
      // static in this window (old process confirmed stopped, new one not
      // started yet), on both the managed-container and directly-spawned
      // paths below, so this runs unconditionally regardless of which one
      // this restart takes.
      if (this.restartCancelled) return stopCancelledRestart("before the start");
      await this._backupConfigBeforeRestart(pinnedServerId);

      // No launch-target refresh here: serverManager.startServer() below
      // rewrites RCON in the ini and the launch script from current
      // settings itself, and for a managed container runManagedLifecycle()
      // above already wrote the ini BEFORE `docker restart` -- see
      // lifecycleCoordinator.prepareForLaunch(). This used to run here,
      // after the container had already restarted on the old ini.

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
        const relaunch = await this._relaunchWaitingOutSteamOperation({
          serverManager,
          serverId: pinnedServerId,
          readProcessDetails,
        });
        if (relaunch.cancelled) {
          return stopCancelledRestart("waiting for a Steam operation to finish");
        }
        const restarted = relaunch.result;
        if (!restarted?.success) {
          log.warn(
            `Auto-restart: start command reported failure: ${restarted?.error || restarted?.message || "unknown error"}`,
          );
        }

        // Wait for server process to be running (up to 60 seconds)
        for (let i = 0; i < 60; i++) {
          await this._restartSleep(1000);
          if (this.restartCancelled) return stopCancelledRestart("while the server starts");
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
          // A scan that can't answer can't confirm the start either; the
          // process the panel just launched still running does.
          if (
            (!processDetails || processDetails.scanFailed) &&
            restarted?.success &&
            launchedProcessRunning(serverManager)
          ) {
            serverStarted = true;
            log.info(
              "Auto-restart: process detection can't answer, but the server process the panel launched is running",
            );
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
          { serverId: pinnedServerId },
        );
        logServerEvent(
          "auto_restart_error",
          "Server stopped but failed to start",
          { serverId: pinnedServerId },
        );
        log.error("Auto-restart: Server stopped but failed to start");
        if (leavesServerStopped) {
          this._noteInterruptedRestart(pinnedServerId, "Server stopped but failed to start");
        }
        return { success: false, wasRunning: true, logged: true };
      }
      this._clearInterruptedRestart(pinnedServerId);

      // The new instance is now confirmed up -- either Docker's own restart
      // action already blocked until the container was running again
      // (managed.handled branch above), or the process/RCON poll just
      // confirmed it natively. RCON itself may still take another 60-240s
      // below, but the host/container signal is real now; no reason to make
      // clients wait for that too. Phase is 'starting', not a bare
      // running:true -- serverStarting is still true and RCON isn't
      // connected yet at this exact point (see the RCON-wait loop right
      // below), so a plain boolean here would be the identical premature-
      // green-dot lie POST /start used to tell (2026-09-07 STARTING-state
      // fix). The corresponding running/unresponsive correction is emitted
      // once that wait settles, a few lines down.
      await this._noteBridgeServerRunningAfterVerifiedStart(pinnedServerId);
      this._emitVerifiedTransition(
        true,
        resolveServerPhase({
          running: true,
          serverStarting: rconService.serverStarting,
          rconConnected: rconService.connected,
        }),
        pinnedServerId,
      );

      // Wait for RCON to be ready (PZ server takes 60-180s to fully initialize)
      // Keep serverStarting=true the whole time to block auto-reconnect
      log.info("Auto-restart: Waiting for RCON to be ready...");
      // The other servers can start and stop meanwhile; this one, and a
      // second restart (one at a time, see restartInProgress), wait.
      rconHold = holdServerUntilRcon(lifecycleLock);
      const rconDelays = [60000, 45000, 45000, 45000, 45000]; // 60s + 4x45s = 240s total (4 minutes)
      let rconConnected = false;

      for (let i = 0; i < rconDelays.length; i++) {
        const delaySeconds = rconDelays[i] / 1000;
        log.info(
          `Auto-restart: RCON waiting ${delaySeconds}s before attempt ${i + 1}/${rconDelays.length}...`,
        );
        await this._restartSleep(rconDelays[i]);
        if (this.restartCancelled) return stopCancelledRestart("waiting for RCON");

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
        let connectTimeoutId;
        try {
          log.info(
            `Auto-restart: RCON attempting connection ${i + 1}/${rconDelays.length}...`,
          );
          const connectPromise = rconService.connect();
          const timeoutPromise = new Promise((_, reject) => {
            connectTimeoutId = setTimeout(
              () => reject(new Error("Connection attempt timed out after 15s")),
              15000,
            );
          });

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
        } finally {
          // timeout-handling-consistency-sweep, 2026-09-10: this timer's id
          // was never captured at all, so it could never be cleared even in
          // principle -- every loop iteration where connect() settled
          // faster than 15s left a dangling timer, and across the retry
          // loop these could stack. Masked in practice by the explicit
          // forceResetConnectionState() calls above/below (state gets
          // reset regardless), but real handle litter, now closed.
          clearTimeout(connectTimeoutId);
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

      // The starting-grace window is over: correct the phase the emit above
      // left the client on. If RCON connected, this is the running
      // confirmation the "starting" dot has been waiting for. If it never
      // did, this is the "started but not responding" state god's guard
      // named directly ("starting forever is the same lie wearing a
      // different colour") -- an honest terminal state instead of leaving
      // clients on 'starting' indefinitely (checkServerStatusNow's own
      // watchdog can't be relied on to catch this: it only re-emits when ITS
      // last-known phase differs, and a restart that returns to the exact
      // phase it started from looks like no change from that function's
      // point of view, since these _emitVerifiedTransition calls don't feed
      // its lastKnownPhase -- see that function's own comment on why not).
      this._emitVerifiedTransition(
        true,
        resolveServerPhase({ running: true, serverStarting: false, rconConnected }),
        pinnedServerId,
      );

      const restartDuration = Date.now() - restartStartTime;

      if (serverStarted) {
        const rconStatus = rconConnected
          ? " (RCON connected)"
          : " (RCON not yet connected)";
        const warningNote =
          failedWarningBroadcasts > 0
            ? ` -- ${failedWarningBroadcasts} restart warning broadcast(s) failed to send; players may not have been warned before this restart`
            : "";
        await logScheduleExecution(
          null,
          label,
          "restart",
          true,
          "Server restarted successfully" + rconStatus + warningNote,
          restartDuration,
          { serverId: pinnedServerId },
        );
        logServerEvent(
          "auto_restart",
          "Server restarted successfully" + rconStatus + warningNote,
          { serverId: pinnedServerId },
        );
        log.info(
          `Auto-restart completed successfully (took ${Math.round(restartDuration / 1000)}s)${rconStatus}${warningNote}`,
        );
      } else {
        await logScheduleExecution(
          null,
          label,
          "restart",
          false,
          "Server stopped but failed to start",
          restartDuration,
          { serverId: pinnedServerId },
        );
        logServerEvent(
          "auto_restart_error",
          "Server stopped but failed to start",
          { serverId: pinnedServerId },
        );
        log.error("Auto-restart: Server stopped but failed to start");
      }

      return { success: serverStarted, wasRunning: true, logged: true };
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
        { serverId: pinnedServerId },
      );
      logServerEvent("auto_restart_error", error.message, { serverId: pinnedServerId });
      if (leavesServerStopped) this._noteInterruptedRestart(pinnedServerId, error.message);
      // Clear serverStarting flag on error so auto-reconnect can resume
      if (rconService.setServerStarting) {
        rconService.setServerStarting(false);
      } else {
        rconService.serverStarting = false;
      }
      // The row above is this failure's Schedule History entry -- the thrown
      // counterpart of the `logged: true` returns. Without the tag,
      // runTaskNow()'s catch logged a second row for a scheduled "restart"
      // task whose start threw, e.g. serverManager.startServer()'s
      // SERVER_START_SCRIPT_MISSING (GH #167), which troubleshooting.md
      // tells the operator to look for in Execution History.
      if (error && typeof error === "object") {
        error.alreadyLoggedToScheduleHistory = true;
      }
      throw error;
    } finally {
      this.restartInProgress = false;
      this.activeRestart = null;
      lifecycleLock.release();
      rconHold?.release();
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

  // continuous-bug-hunt round 28 (ux-proposals-need-backend-data): a
  // per-task next-run time for the Scheduler task list. Prefers the LIVE
  // node-cron job's own getNextRun() when this task is currently scheduled
  // (this.jobs) -- that's the exact engine that will actually fire it, so
  // there's no way for this to disagree with reality the way a second,
  // independent computation could. Falls back to computeNextRun() (a plain
  // cron_expression + timezone calculation, no live job required) for a
  // disabled task, which /tasks still needs to show but which
  // scheduleTask() never hands to cron.schedule() in the first place.
  getTaskNextRun(task) {
    const job = this.jobs.get(task.id);
    if (job && typeof job.getNextRun === "function") {
      try {
        const at = job.getNextRun();
        if (at instanceof Date && Number.isFinite(at.getTime())) return at.toISOString();
      } catch {
        // Falls through to the offline computation below.
      }
    }
    if (!task.enabled) return null;
    return computeNextRun(task.cron_expression, this.effectiveTimezone);
  }

  // Same "prefer the live job" reasoning as getTaskNextRun above, for the
  // backup schedule specifically -- this.backupJob is null whenever backups
  // are disabled, in which case there is no next run to report (not a
  // hypothetical one computed from whatever schedule string settings still
  // remembers from before it was turned off).
  getBackupNextRun() {
    if (this.backupJob && typeof this.backupJob.getNextRun === "function") {
      try {
        const at = this.backupJob.getNextRun();
        if (at instanceof Date && Number.isFinite(at.getTime())) return at.toISOString();
      } catch {
        return null;
      }
    }
    return null;
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
      // round 28: distinct from the aggregate `nextRun` below (soonest
      // across every job) -- Scheduler.tsx's own backup-health card needs
      // the backup schedule's OWN next run specifically, not whichever job
      // happens to be soonest overall.
      backupNextRun: this.getBackupNextRun(),
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

  // The waits inside performRestart: this.sleep(), but over the moment the
  // restart is cancelled (cancelRestart), and none at all once it was. Kept
  // apart from sleep() on purpose: other loops (a backup waiting out a
  // restart) call sleep() while restartCancelled is set and must still wait.
  async _restartSleep(ms) {
    if (this.restartCancelled) return;
    if (!this._restartWaiters) this._restartWaiters = new Set();
    let wake;
    const cancelled = new Promise((resolve) => {
      wake = resolve;
      this._restartWaiters.add(resolve);
    });
    try {
      await Promise.race([this.sleep(ms), cancelled]);
    } finally {
      this._restartWaiters.delete(wake);
    }
  }

  // GH #269: the relaunch step of a restart that has already stopped the
  // server. startServer()'s refusal while a Steam install/update writes the
  // install folder stays (never a JVM over half-written game files), but
  // that refusal alone no longer ends the restart with the server down: it
  // waits for the operation to finish (bounded, cancellable like every other
  // restart wait), checks that nothing started a server meanwhile, and
  // starts it through the same guards. Any other refusal, the timeout, a
  // scan that can't answer and a server found running all fail as before.
  // Returns { result } (startServer()'s own) or { cancelled: true }.
  async _relaunchWaitingOutSteamOperation({ serverManager, serverId, readProcessDetails }) {
    const deadline = Date.now() + RESTART_STEAM_OPERATION_WAIT_MS;
    const waitMinutes = Math.round(RESTART_STEAM_OPERATION_WAIT_MS / 60000);
    for (;;) {
      let blocking;
      try {
        return {
          result: await serverManager.startServer({ skipRunningCheck: true, serverId }),
        };
      } catch (error) {
        if (!error?.steamOperation) throw error;
        blocking = error.steamOperation;
      }
      const waitStartedAt = Date.now();
      log.warn(
        `Auto-restart: the server is stopped and its relaunch waits for a Steam ${describeSteamOperation(blocking, waitStartedAt)} to finish (up to ${waitMinutes} min)`,
      );
      while (getStartBlockingSteamOperation(blocking.path)) {
        if (Date.now() >= deadline) {
          throw new Error(
            `The server was stopped for the restart, but a Steam ${blocking.type} operation on its install folder was still running after ${waitMinutes} minutes, so it was not started again. Start it once that operation has finished.`,
          );
        }
        await this._restartSleep(RESTART_STEAM_OPERATION_POLL_MS);
        if (this.restartCancelled) return { cancelled: true };
      }
      log.info(
        `Auto-restart: the Steam ${blocking.type} operation on ${blocking.path} finished after ${Math.round((Date.now() - waitStartedAt) / 1000)} s; starting the server`,
      );
      // Nothing may have started this server while the restart waited (a
      // start on the host, outside the panel's lifecycle lock): the start
      // below skips its own running check, so this is the one that counts.
      const details = await readProcessDetails();
      if (!details || details.scanFailed) {
        throw new Error(
          "The server was stopped for the restart and the Steam operation that held its relaunch has finished, but process detection failed, so the panel could not check that no server was started meanwhile and did not start one. Check the server and start it if it is stopped.",
        );
      }
      if (details.running) {
        throw new Error(
          "A server process was started while the restart waited for a Steam operation to finish, so the restart did not start a second one.",
        );
      }
      if (this.restartCancelled) return { cancelled: true };
      await this._ensureRestartTarget(serverManager, serverId);
    }
  }

  // A restart that stopped the server and could not start it again (GH
  // #269): the mod checker must not take that server for one the operator
  // left offline. Valid until anything launches a server again (the launch
  // number moves), the restart is cancelled, or one brings it back up.
  _noteInterruptedRestart(serverId, message) {
    this.interruptedRestart = {
      serverId: serverId == null ? null : String(serverId),
      message: String(message || "the server did not start again"),
      at: Date.now(),
      launchSeq: currentLaunchSequence(),
    };
  }

  _clearInterruptedRestart(serverId) {
    const key = serverId == null ? null : String(serverId);
    if (this.interruptedRestart && this.interruptedRestart.serverId === key) {
      this.interruptedRestart = null;
    }
  }

  getInterruptedRestart(serverId) {
    const record = this.interruptedRestart;
    if (!record) return null;
    const key = serverId == null ? null : String(serverId);
    if (record.serverId !== key) return null;
    if (record.launchSeq !== currentLaunchSequence()) return null;
    return record;
  }

  _wakeRestartWaits() {
    if (!this._restartWaiters) return;
    for (const wake of [...this._restartWaiters]) wake();
    this._restartWaiters.clear();
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
