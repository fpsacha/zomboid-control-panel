import { createLogger } from "../utils/logger.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.js";
import { getActiveServer, getServer, logServerEvent } from "../database/init.js";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
} from "./lifecycleCoordinator.js";
import { resolveDockerHostSignal, runManagedLifecycle } from "./managedContainer.js";
import { resolveProvider } from "../utils/serverStatusModel.js";
import { RconService } from "./rcon.js";
import { ServerManager } from "./serverManager.js";
import { isFirstBootMissingAdminPassword } from "../routes/server.js";

const log = createLogger("OtherServers");

// Start, stop and restart a server other than the active one, from the
// Dashboard's list of servers (POST /api/servers/:id/start|stop|restart).
// The Dashboard's own Start/Stop/Restart (routes/server.js) act on the active
// server through the panel's shared ServerManager and RCON connection; these
// reach another one through instances of its own, the way a scheduled task
// pinned to it does (scheduler.js's _resolveServicesForTask()), so the
// active server -- and everything that follows it -- is left alone. Same
// rules as the Dashboard's: the global lifecycle lock, a save before a stop,
// a graceful stop escalated to a kill after a minute, a Docker-managed
// server through Docker. Not here: Force stop and RCON for a remote server --
// "Show" makes it the active server, where both are.
//
// Each function resolves to { status, body } for the route to send.

export const START_CONFIRM_MS = 30 * 1000;
export const STOP_ESCALATE_AFTER_MS = 60 * 1000;
export const STOP_CONFIRM_MS = 5 * 60 * 1000;
const POLL_MS = 1000;

function displayName(server) {
  return server?.name || server?.serverName || String(server?.id ?? "server");
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function loadManager(serverId) {
  const manager = new ServerManager();
  await manager.loadConfig(serverId);
  return manager;
}

async function loadRcon(serverId) {
  const rcon = new RconService();
  await rcon.loadConfig(serverId);
  return rcon;
}

function runsInContainer(server) {
  const provider = resolveProvider(server);
  return provider === "docker-local" || provider === "docker-managed";
}

// "running", "stopped", or "unknown" when the scan can't say. A server run by
// a Docker container is what Docker says: the process scan never sees a game
// in another container, so Stop answered "already stopped" for a running one.
async function processState(manager, server = null, dockerSignal = resolveDockerHostSignal) {
  const details =
    server && runsInContainer(server)
      ? await dockerSignal(server)
      : await manager.getServerProcessDetails();
  if (!details || details.scanFailed || typeof details.running !== "boolean") {
    return "unknown";
  }
  return details.running ? "running" : "stopped";
}

function refusal(status, error, code, params) {
  return {
    status,
    body: { error, code, ...(params ? { params: sanitizeErrorParams(params) } : {}) },
  };
}

// The server the request names, or the refusal: none by that id, the active
// server (its own controls are the Dashboard's), or a remote one (the panel
// doesn't run its process).
export async function resolveOtherServer(
  serverId,
  { findServer = getServer, findActiveServer = getActiveServer } = {},
) {
  const server = serverId === null ? null : await findServer(serverId);
  if (!server) {
    return {
      refused: refusal(404, "Server profile not found", ErrorCode.SERVER_PROFILE_NOT_FOUND),
    };
  }
  const name = displayName(server);
  const active = await findActiveServer();
  if (active && String(active.id) === String(server.id)) {
    return {
      refused: refusal(
        409,
        `${name} is the active server: use the Dashboard's own Start, Stop and Restart.`,
        ErrorCode.SERVERS_ACTION_ACTIVE_SERVER,
        { name },
      ),
    };
  }
  if (server.isRemote) {
    return {
      refused: refusal(
        400,
        `${name} runs on another machine, so the panel doesn't start, stop or restart it from the list of servers. Show it on the Dashboard to stop it over RCON.`,
        ErrorCode.SERVERS_ACTION_REMOTE_REFUSED,
        { name },
      ),
    };
  }
  return { server };
}

function stateUnknownRefusal(server) {
  const name = displayName(server);
  return refusal(
    409,
    `The panel can't tell whether ${name} is running, so it did nothing. Try again in a moment.`,
    ErrorCode.SERVERS_ACTION_STATE_UNKNOWN,
    { name },
  );
}

// Polls until the process scan says `wanted`, or `withinMs` passes.
async function waitForState(manager, wanted, withinMs, { sleep, now }) {
  const deadline = now() + withinMs;
  for (;;) {
    try {
      if ((await processState(manager)) === wanted) return true;
    } catch (error) {
      log.debug(`Process check failed: ${error.message}`);
    }
    if (now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

export async function startOtherServer(
  server,
  {
    createManager = loadManager,
    acquireLock = acquireLifecycleLock,
    runManaged = runManagedLifecycle,
    dockerSignal = resolveDockerHostSignal,
    logEvent = logServerEvent,
    onSettled = () => {},
    sleep = defaultSleep,
    now = () => Date.now(),
  } = {},
) {
  const name = displayName(server);
  const lock = acquireLock("start", server.id);
  if (!lock) return { status: 409, body: lifecycleInProgressResponse() };
  let lockTransferred = false;
  try {
    const manager = await createManager(server.id);
    const state = await processState(manager, server, dockerSignal);
    if (state === "unknown") return stateUnknownRefusal(server);
    if (state === "running") {
      return { status: 200, body: { success: true, alreadyRunning: true } };
    }

    log.info(`Starting ${name} from the list of servers`);
    const managed = await runManaged("start", { serverId: server.id });
    if (managed.handled) {
      if (!managed.success) {
        return {
          status: 502,
          body: { error: sanitizeError(managed.error || "Container start failed") },
        };
      }
      await logEvent("server_start", `${name} started via web UI`, { serverId: server.id });
      onSettled();
      return {
        status: 200,
        body: {
          success: true,
          ...(managed.alreadyRunning ? { alreadyRunning: true } : {}),
          message: managed.message || "Container starting",
        },
      };
    }

    // The Dashboard's Start refuses this too (routes/server.js): PZ would
    // stop at a console prompt for the admin password nobody can answer.
    if (isFirstBootMissingAdminPassword(server)) {
      return refusal(
        400,
        `${name} has never started before and has no admin password set, so Project Zomboid would stop at a console prompt for one that the panel can't answer. Set an admin password for it in My Servers, then start it again.`,
        ErrorCode.SERVERS_START_ADMIN_PASSWORD_MISSING,
        { name },
      );
    }

    const launched = await manager.startServer({ serverId: server.id });
    if (!launched?.success) {
      return {
        status: 500,
        body: {
          error: sanitizeError(launched?.error || launched?.message || "Server start failed"),
        },
      };
    }
    await logEvent("server_start", `${name} started via web UI`, { serverId: server.id });

    // The answer goes back now; the lock is held until the process shows up
    // (or 30 s pass), as the Dashboard's Start does.
    lockTransferred = true;
    void waitForState(manager, "running", START_CONFIRM_MS, { sleep, now })
      .then((up) => {
        if (!up) log.warn(`${name} was launched, but its process didn't show up within ${START_CONFIRM_MS / 1000}s`);
      })
      .finally(() => {
        lock.release();
        onSettled();
      });
    return {
      status: 200,
      body: {
        success: true,
        message: launched.message || "Server starting",
        ...(Array.isArray(launched.scriptWarnings) && launched.scriptWarnings.length > 0
          ? { scriptWarnings: launched.scriptWarnings }
          : {}),
      },
    };
  } finally {
    if (!lockTransferred) lock.release();
  }
}

export async function stopOtherServer(
  server,
  {
    createManager = loadManager,
    createRcon = loadRcon,
    acquireLock = acquireLifecycleLock,
    runManaged = runManagedLifecycle,
    dockerSignal = resolveDockerHostSignal,
    logEvent = logServerEvent,
    onSettled = () => {},
    sleep = defaultSleep,
    now = () => Date.now(),
  } = {},
) {
  const name = displayName(server);
  const lock = acquireLock("stop", server.id);
  if (!lock) return { status: 409, body: lifecycleInProgressResponse() };
  let lockTransferred = false;
  let rcon = null;
  try {
    const manager = await createManager(server.id);
    const state = await processState(manager, server, dockerSignal);
    if (state === "unknown") return stateUnknownRefusal(server);
    if (state === "stopped") {
      return { status: 200, body: { success: true, alreadyStopped: true } };
    }

    // Save first -- quitting after a failed save discards everything since
    // the last one -- over a connection of its own: the panel's reaches the
    // active server only.
    rcon = await createRcon(server.id);
    try {
      await rcon.connect();
    } catch (error) {
      log.debug(`RCON to ${name} failed: ${error.message}`);
    }
    if (!rcon.connected) {
      return refusal(
        400,
        `RCON on ${name} doesn't answer, so the panel can't save its world and stop it. If it is stuck, show it on the Dashboard and use Force stop there.`,
        ErrorCode.SERVERS_STOP_RCON_UNAVAILABLE,
        { name },
      );
    }
    const saved = await rcon.save({ retryOnConnectionError: false });
    if (!saved?.success) {
      const reason = saved?.error || "unknown error";
      return refusal(
        502,
        `${name}'s world could not be saved (${sanitizeError(reason)}), so it was left running. If it is stuck, show it on the Dashboard and use Force stop there.`,
        ErrorCode.SERVERS_STOP_SAVE_FAILED,
        { name, reason },
      );
    }

    log.info(`Stopping ${name} from the list of servers`);
    // A container-managed server goes down through Docker (RCON quit would
    // let its restart policy bring it straight back), a systemd/OpenRC one
    // through its service; both answer once it is down.
    const managed = await runManaged("stop", { serverId: server.id });
    if (managed.handled || manager.usesManagedServiceLifecycle?.()) {
      const result = managed.handled
        ? managed
        : await manager.stopServer({ serverId: server.id });
      if (!result?.success || result.confirmed === false) {
        return {
          status: 502,
          body: managed.handled
            ? {
                error: `The world was saved, but the container could not be stopped: ${sanitizeError(managed.error)}`,
                code: ErrorCode.SERVER_STOP_CONTAINER_STOP_FAILED,
                params: sanitizeErrorParams({ reason: managed.error || "unknown error" }),
              }
            : { error: sanitizeError(result?.error || result?.message || "Server stop failed") },
        };
      }
      await logEvent("server_stop", `${name} stopped via web UI`, { serverId: server.id });
      onSettled();
      return { status: 200, body: { success: true, confirmed: true } };
    }

    const quit = await rcon.quit({ retryOnConnectionError: false });
    if (!quit?.success) {
      return {
        status: 502,
        body: { error: sanitizeError(quit?.error || quit?.message || "Server stop failed") },
      };
    }
    await logEvent("server_stop", `Graceful shutdown of ${name} requested via web UI`, {
      serverId: server.id,
    });

    // PZ saves and exits on its own time: the lock is held until the process
    // is gone, a kill after STOP_ESCALATE_AFTER_MS, as routes/server.js's
    // monitorGracefulStop() does for the active server.
    lockTransferred = true;
    void (async () => {
      if (await waitForState(manager, "stopped", STOP_ESCALATE_AFTER_MS, { sleep, now })) return;
      log.warn(`${name} did not stop within ${STOP_ESCALATE_AFTER_MS / 1000}s of its save and quit; force-stopping it`);
      try {
        const forced = await manager.stopServer({ serverId: server.id });
        if (!forced?.success || forced.confirmed === false) {
          log.error(`Force-stopping ${name} did not confirm: ${forced?.error || forced?.message || "unknown error"}`);
        }
      } catch (error) {
        log.error(`Force-stopping ${name} failed: ${error.message}`);
      }
      if (!(await waitForState(manager, "stopped", STOP_CONFIRM_MS - STOP_ESCALATE_AFTER_MS, { sleep, now }))) {
        log.warn(`${name}'s stop was never confirmed; releasing the lifecycle lock`);
      }
    })()
      .catch((error) => log.error(`Stopping ${name} failed: ${error.message}`))
      .finally(() => {
        lock.release();
        onSettled();
      });
    return {
      status: 200,
      body: { success: true, confirmed: false, message: quit.message || quit.response || "Shutdown requested" },
    };
  } finally {
    if (!lockTransferred) lock.release();
    if (rcon?.connected) await rcon.disconnect().catch(() => {});
  }
}

// The countdown, save, stop and start are scheduler.performRestart()'s, run
// against this server's own connections like a scheduled restart pinned to
// it. Answers once accepted; `onResult` gets the outcome ({ success, message,
// code?, params? }), a throw included.
export async function restartOtherServer(
  server,
  {
    scheduler,
    warningMinutes = null,
    createManager = loadManager,
    createRcon = loadRcon,
    acquireLock = acquireLifecycleLock,
    onResult = () => {},
  } = {},
) {
  const lock = acquireLock("restart", server.id);
  if (!lock) return { status: 409, body: lifecycleInProgressResponse() };
  if (scheduler.restartInProgress) {
    lock.release();
    return { status: 409, body: lifecycleInProgressResponse() };
  }
  let rcon = null;
  try {
    rcon = await createRcon(server.id);
    const manager = await createManager(server.id);
    const name = displayName(server);
    log.info(`Restarting ${name} from the list of servers`);
    void Promise.resolve(
      scheduler.performRestart(warningMinutes, {
        rconService: rcon,
        serverManager: manager,
        label: "Manual restart",
        lifecycleLock: lock,
      }),
    )
      .then(onResult, (error) =>
        onResult({
          success: false,
          message: error.message,
          ...(error.code ? { code: error.code, params: error.params } : {}),
        }),
      )
      .finally(async () => {
        lock.release();
        if (rcon.connected) await rcon.disconnect().catch(() => {});
      });
    return {
      status: 200,
      body: {
        success: true,
        message:
          warningMinutes > 0
            ? `Restart of ${name} initiated with ${warningMinutes} minute warning`
            : `Restart of ${name} initiated`,
      },
    };
  } catch (error) {
    lock.release();
    if (rcon?.connected) await rcon.disconnect().catch(() => {});
    throw error;
  }
}
