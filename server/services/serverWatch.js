import { createLogger } from "../utils/logger.js";
import { LIFECYCLE_IN_PROGRESS_CODE, lifecycleActivityCovers } from "./lifecycleCoordinator.js";

const log = createLogger("ServerWatch");

// The status watchdog (server/index.js's checkServerStatusNow()) follows the
// active server only, through the panel's shared ServerManager and RCON. A
// server started alongside it -- the boot auto-start's other servers, or one
// started from the Dashboard's list of servers -- went down unnoticed: no
// event, no update on the Dashboard until its next poll, and nobody to start
// it again. This watch reads every local server's state from the same
// one-scan-for-all GET /api/servers/status uses (readServerStatuses()) and:
//   - pushes `servers:status` when one of them starts or stops, so the
//     Dashboard's list of servers follows at once;
//   - records a server_stop event, under that server, when one stops without
//     the panel asking;
//   - starts it again when it is in restartOnCrashServerIds.
// The active server's own stops still come from the status watchdog, which
// tells crashes from deliberate stops more precisely; it hands them to
// onActiveServerStopped() for the restart part.
//
// "Without the panel asking": no lifecycle operation (Stop, Restart, a wipe,
// a restore, an update...) is under way for the server, or ended within
// PANEL_STOP_WINDOW_MS (lifecycleActivityCovers()). A stop from inside the
// game (an admin's /quit) or from outside the panel counts as unasked too:
// the panel can't tell it from a crash.

export const WATCH_INTERVAL_MS = 30 * 1000;
// A Docker or service stop confirms before its lock is released, and a
// graceful stop's own poll can release it a moment before this watch looks.
export const PANEL_STOP_WINDOW_MS = 2 * 60 * 1000;
// Before starting a server that went down: the OS frees its ports, and an
// operator who stopped it from the game has a moment to start it again.
export const CRASH_RESTART_DELAY_MS = 15 * 1000;
// A server that keeps falling over is left down after this many restarts in
// the window, rather than started in a loop.
export const CRASH_RESTART_LIMIT = 3;
export const CRASH_RESTART_WINDOW_MS = 30 * 60 * 1000;
// A restart refused because another server's operation holds the panel (the
// scheduler runs one restart at a time, and starts and stops take the
// lifecycle lock) is tried again every CRASH_RESTART_BUSY_POLL_MS, for as
// long as a restart with the longest warning (an hour) and its sequence can
// take. Two servers that go down together -- the host's memory ran out, a mod
// both load broke -- used to leave the second one down for good.
export const CRASH_RESTART_BUSY_POLL_MS = 15 * 1000;
export const CRASH_RESTART_BUSY_WAIT_MS = 75 * 60 * 1000;

// The refusal of a restart that never began because something else held the
// panel: the lifecycle lock (LIFECYCLE_IN_PROGRESS_CODE) or the scheduler's
// one-restart-at-a-time rule (`busy`).
function refusedAsBusy(result) {
  return Boolean(result && !result.success && (result.busy === true || result.code === LIFECYCLE_IN_PROGRESS_CODE));
}

export function restartOnCrashChosen(settingValue, serverId) {
  return (
    Array.isArray(settingValue) &&
    serverId !== null &&
    serverId !== undefined &&
    settingValue.some((id) => String(id) === String(serverId))
  );
}

function displayName(server) {
  return server?.name || server?.serverName || String(server?.id ?? "server");
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class ServerWatch {
  /**
   * @param {object} deps
   * @param {() => Promise<Array<{id, running, stateUnknown}>>} deps.readStatuses
   * @param {() => Promise<Array<object>>} deps.getServers
   * @param {() => Promise<object|null>} deps.getActiveServer
   * @param {(key: string) => Promise<unknown>} deps.getSetting
   * @param {(server: object, opts: {isActive: boolean}) => Promise<{success?: boolean, message?: string, error?: string}>} deps.restartServer
   * @param {(server: object, opts: {isActive: boolean}) => Promise<boolean|null>} deps.isStopped
   *   Whether the server is still down right before a restart: true, false,
   *   or null when the panel can't tell.
   * @param {(type: string, message: string, serverId: string) => unknown} deps.logEvent
   * @param {(payload: {serverId: string, running: boolean}) => void} [deps.emit]
   */
  constructor({
    readStatuses,
    getServers,
    getActiveServer,
    getSetting,
    restartServer,
    isStopped,
    logEvent,
    emit = () => {},
    activityCovers = lifecycleActivityCovers,
    now = () => Date.now(),
    sleep = defaultSleep,
    restartDelayMs = CRASH_RESTART_DELAY_MS,
    busyPollMs = CRASH_RESTART_BUSY_POLL_MS,
    busyWaitMs = CRASH_RESTART_BUSY_WAIT_MS,
  }) {
    this.readStatuses = readStatuses;
    this.getServers = getServers;
    this.getActiveServer = getActiveServer;
    this.getSetting = getSetting;
    this.restartServer = restartServer;
    this.isStopped = isStopped;
    this.logEvent = logEvent;
    this.emit = emit;
    this.activityCovers = activityCovers;
    this.now = now;
    this.sleep = sleep;
    this.restartDelayMs = restartDelayMs;
    this.busyPollMs = busyPollMs;
    this.busyWaitMs = busyWaitMs;
    // Last confident state of each server other than the active one, by id.
    this.lastRunning = new Map();
    // When each server was restarted after going down, for the loop guard.
    this.crashRestarts = new Map();
    // Servers with a restart waiting out its delay or running.
    this.pendingRestarts = new Set();
    this.ticking = false;
    this.interval = null;
  }

  start(intervalMs = WATCH_INTERVAL_MS) {
    this.stop();
    this.interval = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.interval.unref?.();
    log.info(`Server watch started (${Math.round(intervalMs / 1000)}s interval)`);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  // One look at every local server other than the active one. Never throws.
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const [servers, active] = await Promise.all([
        this.getServers(),
        this.getActiveServer(),
      ]);
      const activeId = active?.id !== null && active?.id !== undefined ? String(active.id) : null;
      const watched = (Array.isArray(servers) ? servers : []).filter(
        (server) => server && !server.isRemote && String(server.id) !== activeId,
      );
      // A server deleted, or made active (the status watchdog's now), starts
      // over: its next state here is a first look, not a change.
      const watchedIds = new Set(watched.map((server) => String(server.id)));
      for (const id of [...this.lastRunning.keys()]) {
        if (!watchedIds.has(id)) this.lastRunning.delete(id);
      }
      if (watched.length === 0) return;

      const rows = await this.readStatuses();
      const byId = new Map(
        (Array.isArray(rows) ? rows : []).map((row) => [String(row?.id), row]),
      );
      for (const server of watched) {
        const id = String(server.id);
        const row = byId.get(id);
        // An unanswered scan is no change: the last confident state stays.
        if (!row || row.stateUnknown || typeof row.running !== "boolean") continue;
        const before = this.lastRunning.get(id);
        this.lastRunning.set(id, row.running);
        if (before === undefined || before === row.running) continue;
        this.emit({ serverId: server.id, running: row.running });
        if (row.running) {
          log.info(`${displayName(server)} is running (detected by the server watch)`);
          continue;
        }
        if (this.activityCovers(server.id, PANEL_STOP_WINDOW_MS, this.now())) {
          log.info(`${displayName(server)} stopped (a panel operation stopped it)`);
          continue;
        }
        log.warn(`${displayName(server)} stopped without the panel asking (detected by the server watch)`);
        await this.logEvent(
          "server_stop",
          `${displayName(server)} stopped without the panel asking (detected by the server watch)`,
          server.id,
        );
        this.scheduleRestartAfterCrash(server, { isActive: false });
      }
    } catch (error) {
      log.debug(`Server watch tick failed: ${error.message}`);
    } finally {
      this.ticking = false;
    }
  }

  // The status watchdog saw the active server stop. `reason` is its
  // classifyStopReason() verdict: a stop or restart the panel made needs
  // nothing from here.
  async onActiveServerStopped({ serverId, reason }) {
    try {
      if (reason === "stop" || reason === "restart") return;
      if (serverId === null || serverId === undefined) return;
      const servers = await this.getServers();
      const server = (Array.isArray(servers) ? servers : []).find(
        (candidate) => candidate && String(candidate.id) === String(serverId),
      );
      if (!server || server.isRemote) return;
      if (this.activityCovers(server.id, PANEL_STOP_WINDOW_MS, this.now())) return;
      this.scheduleRestartAfterCrash(server, { isActive: true });
    } catch (error) {
      log.debug(`Active-server stop handling failed: ${error.message}`);
    }
  }

  // Off the caller's path: the delay alone outlasts a watchdog tick.
  scheduleRestartAfterCrash(server, { isActive }) {
    const id = String(server.id);
    if (this.pendingRestarts.has(id)) return;
    this.pendingRestarts.add(id);
    const run = this.restartAfterCrash(server, { isActive })
      .catch((error) => log.error(`Restart after a crash failed for ${displayName(server)}: ${error.message}`))
      .finally(() => this.pendingRestarts.delete(id));
    this.lastRestart = run;
  }

  async restartAfterCrash(server, { isActive }) {
    const id = String(server.id);
    const name = displayName(server);
    if (!restartOnCrashChosen(await this.getSetting("restartOnCrashServerIds"), id)) {
      return { restarted: false, reason: "notChosen" };
    }

    const now = this.now();
    const recent = (this.crashRestarts.get(id) || []).filter(
      (at) => now - at < CRASH_RESTART_WINDOW_MS,
    );
    this.crashRestarts.set(id, recent);
    if (recent.length >= CRASH_RESTART_LIMIT) {
      const minutes = Math.round(CRASH_RESTART_WINDOW_MS / 60000);
      log.warn(`${name} went down again after ${recent.length} restarts in ${minutes} minutes; leaving it down`);
      await this.logEvent(
        "crash_restart_gave_up",
        `${name} went down again after being restarted ${recent.length} times in ${minutes} minutes, so the panel left it down`,
        id,
      );
      return { restarted: false, reason: "limit" };
    }

    await this.sleep(this.restartDelayMs);
    const busyDeadline = this.now() + this.busyWaitMs;
    let announced = false;
    let result;
    for (;;) {
      // Unticked while it waited: left down, as asked.
      if (!restartOnCrashChosen(await this.getSetting("restartOnCrashServerIds"), id)) {
        return { restarted: false, reason: "notChosen" };
      }
      // Started again in the meantime (by hand, or from the game's host), or
      // a panel operation took it over: nothing to do. Asked again because a
      // restart of a server found running is a full restart, countdown and all.
      if (this.activityCovers(id, PANEL_STOP_WINDOW_MS, this.now())) {
        return { restarted: false, reason: "panelOperation" };
      }
      const stopped = await this.isStopped(server, { isActive });
      if (stopped !== true) {
        log.info(
          stopped === false
            ? `${name} is running again; no restart needed`
            : `Could not tell whether ${name} is still down; not restarting it`,
        );
        return { restarted: false, reason: stopped === false ? "running" : "unknown" };
      }

      if (!announced) {
        announced = true;
        recent.push(this.now());
        log.warn(`Restarting ${name}: it went down without the panel asking`);
        await this.logEvent("crash_restart", `${name} went down without the panel asking; starting it again`, id);
      }
      result = await this.restartServer(server, { isActive });
      if (!refusedAsBusy(result)) break;
      if (this.now() >= busyDeadline) {
        const minutes = Math.round(this.busyWaitMs / 60000);
        await this.logEvent(
          "crash_restart_error",
          `${name} could not be started again: another operation kept the panel busy for ${minutes} minutes`,
          id,
        );
        return { restarted: false, reason: "busy" };
      }
      log.info(`${name} waits for another operation to finish before it is started again`);
      await this.sleep(this.busyPollMs);
    }
    if (!result?.success) {
      const reason = result?.message || result?.error || "no reason was given";
      await this.logEvent("crash_restart_error", `${name} could not be started again: ${reason}`, id);
      return { restarted: false, reason: "failed" };
    }
    return { restarted: true };
  }
}
