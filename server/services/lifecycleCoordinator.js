import { createLogger } from "../utils/logger.js";

const log = createLogger("Lifecycle");

export const LIFECYCLE_IN_PROGRESS_CODE = "SERVER_LIFECYCLE_IN_PROGRESS";

let activeLock = null;
let nextLockId = 0;
let resolveServerDisplayName = null;
// When the last lock naming each server was released ("" for a lock that
// named none) -- see lifecycleActivityCovers().
const lastReleasedAt = new Map();
// When the panel last sent `quit` to each server -- see
// noteServerQuitRequested().
const quitRequestedAt = new Map();
// A server's own hold, by server id, once its process is up and the panel
// only waits for its RCON to answer (holdServerUntilRcon below). It refuses
// operations for that server and operations for no server in particular,
// but not the other servers' -- the wait takes 1-3 minutes and used to hold
// the one process-wide lock for all of it.
const serverHolds = new Map();
// What refused the last acquireLifecycleLock(), for the 409 that follows it
// when the refusal came from a server's hold rather than activeLock.
let lastRefusal = null;
// Told the lock state after every change (wired to a socket emit at boot), so
// the client can show why a control is unavailable before it is clicked.
let changeListener = null;

export function setLifecycleChangeListener(listener) {
  changeListener = typeof listener === "function" ? listener : null;
}

function notifyLifecycleChange() {
  if (!changeListener) return;
  try {
    changeListener(getLifecycleState());
  } catch (error) {
    log.debug(`Lifecycle change listener failed: ${error?.message || error}`);
  }
}

function normalizeServerId(serverId) {
  return serverId !== null && serverId !== undefined ? String(serverId).trim() : "";
}

function displayNameOf(serverId) {
  if (!serverId || !resolveServerDisplayName) return null;
  try {
    return resolveServerDisplayName(serverId) || null;
  } catch {
    return null;
  }
}

function describeHolder(holder) {
  if (!holder) return null;
  return {
    operation: holder.operation,
    serverId: holder.serverId,
    serverName: displayNameOf(holder.serverId),
    phase: holder.phase ?? null,
    since: holder.since ?? null,
  };
}

// What would refuse an operation for `serverId` right now: the process-wide
// lock, else that server's own hold -- or, for an operation with no server
// in particular, any server's hold.
function blockerFor(serverId) {
  if (activeLock) return activeLock;
  const id = normalizeServerId(serverId);
  if (id) return serverHolds.get(id) ?? null;
  for (const hold of serverHolds.values()) return hold;
  return null;
}

// The lock and every server's hold, for GET /servers/lifecycle and the
// lifecycle:state socket event.
export function getLifecycleState() {
  return {
    lock: describeHolder(activeLock),
    servers: [...serverHolds.values()].map(describeHolder),
  };
}

// Injected, not statically imported from database/init.js, on purpose:
// dozens of test files mock that module with only the exports THEY need
// (vi.mock("../database/init.js", () => ({ getServer, ... }))), which
// REPLACES the whole module for that test file -- a static import here
// would throw "no such export" the instant lifecycleInProgressResponse()
// ran in any of them, even ones that never touch a lifecycle lock's
// message on purpose. Wired once at real boot (server/index.js) to
// database/init.js's peekServerDisplayName(); every test file that never
// calls this keeps getting the existing generic-wording fallback exactly
// as before, unchanged, with zero coupling to what that file's own mock
// happens to export.
export function setServerDisplayNameResolver(resolver) {
  resolveServerDisplayName = typeof resolver === "function" ? resolver : null;
}

// Runs immediately before the game process (or its container) is launched,
// as the last half of prepareForLaunch() below, from the two places the
// panel's starts and restarts funnel through: serverManager.startServer()
// and managedContainer.runManagedLifecycle(), plus the Servers page's
// per-container Start/Restart (routes/docker.js), which drives
// dockerClient.runManagedAction() directly.
// Wired once at boot (server/index.js) to bridgeDelivery.reconcileBridge(),
// which keeps the loose PanelBridge.lua current -- or moves it out and
// re-adds the Workshop entries -- for the launch that is about to happen;
// PZ loads Lua only when its JVM starts. Injected rather than imported for
// the same reason as setServerDisplayNameResolver above: reconcileBridge
// pulls in database/init.js, which dozens of test files mock partially.
//
// Never throws and never blocks a launch: a failing hook returns null and
// the caller starts the server anyway. reconcileBridge() bounds itself to
// 15 s and reports problems through GET /api/panel-bridge/delivery.
let beforeLaunchHook = null;

export function setBeforeLaunchHook(fn) {
  beforeLaunchHook = typeof fn === "function" ? fn : null;
}

export async function runBeforeLaunchHook(server) {
  if (!beforeLaunchHook || !server) return null;
  try {
    return await beforeLaunchHook(server);
  } catch {
    return null;
  }
}

// Brings what Project Zomboid reads at launch in line with the server's
// CURRENT settings: RCONPassword/RCONPort in its ini and, for a panel-managed
// install, the generated StartServer_<name>.bat / start-server_<name>.sh
// (-servername, -cachedir, -adminpassword and memory are baked into it).
// Wired once at boot (server/index.js) to routes/server.js's
// refreshLaunchTargetBeforeStart(), fed a fresh database read of the server,
// and injected for the same partial-mock reason as the two hooks above.
//
// GH #167: only the dashboard's Start and the scheduler used to call it,
// each at its own call site, so the boot auto-start launched whatever script
// and ini were on disk -- a fresh install ran the stock start-server.sh (the
// named one didn't exist yet) and a changed RCON or admin password only
// reached the game after a manual restart. It now runs inside
// prepareForLaunch() below, which every launch path goes through.
let launchTargetRefresher = null;

export function setLaunchTargetRefresher(fn) {
  launchTargetRefresher = typeof fn === "function" ? fn : null;
}

// The one before-launch step: serverManager.startServer() (native and
// systemd/OpenRC launches -- the dashboard, boot auto-start, the scheduler,
// mod-update and Discord restarts, the post-update start) and, for a
// Docker-managed server, managedContainer.runManagedLifecycle() and the
// Servers page's per-container Start/Restart (routes/docker.js). `container`
// is true for the last two: the image owns the launch command there, so only
// the ini is refreshed, never a script.
//
// Refreshes the launch target first, then runs the PanelBridge hook -- both
// write the server's ini, so they run one after the other, never together.
// Like runBeforeLaunchHook(), it never throws and never blocks a launch: a
// refresh that couldn't write is logged by the refresher itself, one that
// threw is logged here, and startServer() refuses a named server whose
// script is still missing instead of falling back to the stock one -- a
// refusal that sends the operator to the panel log for the reason. Returns
// the refresher's backup notices for scripts that had content the panel
// didn't write, and this launch's number (launchSeq, see
// currentLaunchSequence() below) for the caller to hand to
// notifyServerLaunched() once the launch has actually happened, and the
// admin password a direct launch of the panel's script hands the game
// through its environment ("" for none; services/adminPasswordLaunch.js).
export async function prepareForLaunch(server, { container = false } = {}) {
  const launchSeq = ++launchSequence;
  lastLaunchByServer.set(normalizeServerId(server?.id), launchSeq);
  let scriptWarnings = [];
  let launchAdminPassword = "";
  if (launchTargetRefresher && server) {
    try {
      const refreshed = await launchTargetRefresher(server, {
        managedHandled: container === true,
      });
      if (Array.isArray(refreshed?.scriptBackupWarnings)) {
        scriptWarnings = refreshed.scriptBackupWarnings;
      }
      if (typeof refreshed?.launchAdminPassword === "string") {
        launchAdminPassword = refreshed.launchAdminPassword;
      }
    } catch (error) {
      // Never blocks the launch -- see the comment above.
      log.warn(
        `Could not refresh the launch target before this start: ${error?.message || error}`,
      );
    }
  }
  await runBeforeLaunchHook(server);
  return { scriptWarnings, launchSeq, launchAdminPassword };
}

// GH #189: a mod-update restart still waiting for players to leave went
// ahead after the operator had already restarted the server by hand, so the
// game restarted a second time for nothing -- the manual restart had
// already loaded the updated mods. The mod checker learns about every launch
// the panel makes through the hook below, wired once at boot
// (server/index.js) to ModChecker.noteServerLaunched() and injected for the
// same partial-mock reason as the hooks above.
//
// Every launch is numbered when it begins (prepareForLaunch() above), so
// "did this launch begin after that mod update was detected" is a plain
// comparison against currentLaunchSequence() read at detection -- no clock
// involved. The callers that launch -- serverManager.startServer() and its
// systemd/OpenRC restart, managedContainer.runManagedLifecycle() and the
// Servers page's per-container Start/Restart (routes/docker.js) -- report a
// launch only once it has actually happened: prepareForLaunch() runs before
// the refusals that leave the old process running ("already running", a
// port in use), and those must not count as a fresh start.
let launchSequence = 0;
// The last launch begun for each server id ("" for a launch that named none).
const lastLaunchByServer = new Map();
let serverLaunchedHook = null;

export function setServerLaunchedHook(fn) {
  serverLaunchedHook = typeof fn === "function" ? fn : null;
}

export function currentLaunchSequence() {
  return launchSequence;
}

// The number of the last launch begun for this server -- or for no server in
// particular, which may have been this one -- 0 for none: "has this server
// been launched since" when several servers launch on their own (the boot
// auto-start, the Dashboard's list, a restart after going down).
export function lastLaunchSequenceFor(serverId) {
  return Math.max(
    lastLaunchByServer.get(normalizeServerId(serverId)) ?? 0,
    lastLaunchByServer.get("") ?? 0,
  );
}

// Never throws and never waits: the hook's work (and any rejection) stays
// off the launch path.
export function notifyServerLaunched(server, launchSeq) {
  if (!serverLaunchedHook || !Number.isInteger(launchSeq)) return;
  try {
    const result = serverLaunchedHook({
      serverId: server?.id ?? null,
      launchSeq,
    });
    if (typeof result?.catch === "function") {
      result.catch((error) =>
        log.debug(`Server-launched hook failed: ${error?.message || error}`),
      );
    }
  } catch (error) {
    log.debug(`Server-launched hook failed: ${error?.message || error}`);
  }
}

// 2026-09-04, lifecycle-lock investigation: the lock itself was never the
// problem -- every acquire/release path was already correct, and the
// process-wide scope is intentional (an auto-update must not run while
// someone clicks Start on any server; a per-server lock would not prevent
// that). The actual defect was the REFUSAL MESSAGE: "Another server
// lifecycle operation is already in progress" names neither the operation
// nor the server holding the lock, so even an engineer who had just
// instrumented this exact code path read a correct 409 as a probable leak.
//
// 2026-09-08, normalize-lifecycle-lock-server-identifier: renamed from
// `serverName` to `serverId` and its contract narrowed on purpose. The old
// name invited five different values across the 20 real call sites (display
// name, server DB id, a Docker container id, a save name, or nothing) to
// share one field -- harmless while it was purely cosmetic for the 409
// message below, but it means a same-server EQUALITY COMPARISON between two
// callers' values is meaningless without first knowing which of the five
// schemes each one used. `serverId` is now always the server's DB id (the
// same value getActiveServer()/getServer() return as `.id`) or null when a
// site genuinely has no server to name yet (see server.js's /delete-files:
// the lock there is deliberately acquired before its target path is even
// parsed, so there is no id to pass without reopening the exact TOCTOU
// window the lock exists to close). Still optional and still just carried
// through to the 409 message below -- it changes nothing about who holds
// the lock or how it's released -- but a caller can no longer paper over
// "I don't have the id" by passing a display name instead, which is the
// property the eventual same-server SteamCMD guard needs.
//
// `panelWide`: the operation names a server but changes something every
// server's wait for RCON relies on -- switching the active server, whose
// shared RCON connection a start of the active server is still polling --
// so it waits for every server's hold, as an operation for no server does.
export function acquireLifecycleLock(operation = "lifecycle", serverId = null, { panelWide = false } = {}) {
  const blocker = blockerFor(panelWide ? null : serverId);
  if (blocker) {
    lastRefusal = blocker;
    return null;
  }
  return installLifecycleLock(operation, serverId);
}

function installLifecycleLock(operation, serverId) {
  // Coerced with String(), not restricted to typeof === "string": real
  // server DB ids are always UUID strings (database/init.js's generateId()),
  // but found via this normalization's own test suite that a caller can
  // reasonably hold one as a number (e.g. a throwaway ServerManager's
  // _serverId in test fixtures, and conceivably a legacy numeric id
  // elsewhere) -- silently discarding that to null defeats the whole point
  // of making this field load-bearing for a same-server comparison a caller
  // might reasonably make with either representation.
  const normalizedServerId =
    serverId !== null && serverId !== undefined
      ? String(serverId).trim()
      : "";
  const token = {
    id: ++nextLockId,
    operation: String(operation || "lifecycle"),
    serverId: normalizedServerId || null,
    phase: null,
    since: Date.now(),
  };
  activeLock = token;
  lastRefusal = null;
  let released = false;
  notifyLifecycleChange();

  return {
    operation: token.operation,
    serverId: token.serverId,
    // Still the lock in force: not released, and not taken over by Stop
    // (supersedeLifecycleLock).
    isHeld() {
      return !released && activeLock === token;
    },
    release() {
      if (released) return;
      released = true;
      if (activeLock === token) activeLock = null;
      lastReleasedAt.set(token.serverId ?? "", Date.now());
      notifyLifecycleChange();
    },
  };
}

// Hands a start's lock over to a hold on its own server once the process is
// up and all that is left is waiting for RCON (1-3 minutes; the callers give
// up after 5). The process-wide lock is released at once, so the other
// servers can start and stop meanwhile; this server, and the operations for
// no server in particular, stay refused until the returned hold is released.
// A lock that names no server can't be narrowed: it is kept, and null comes
// back (the caller then releases that lock as before). Nor can a lock that
// is no longer in force (a Stop took it over): there is nothing left to hand
// on, and holding the server now would block that Stop's own server.
export function holdServerUntilRcon(lock) {
  const id = normalizeServerId(lock?.serverId);
  if (!lock || !id) return null;
  if (typeof lock.isHeld === "function" && !lock.isHeld()) return null;
  const hold = {
    id: ++nextLockId,
    operation: lock.operation,
    serverId: id,
    phase: "waiting-for-rcon",
    since: Date.now(),
  };
  serverHolds.set(id, hold);
  lock.release();
  let released = false;
  return {
    operation: hold.operation,
    serverId: id,
    release() {
      if (released) return;
      released = true;
      if (serverHolds.get(id) !== hold) return;
      serverHolds.delete(id);
      lastReleasedAt.set(id, Date.now());
      notifyLifecycleChange();
    },
  };
}

// What would refuse an operation for `serverId` right now -- the
// process-wide lock as { operation, serverId }, or that server's hold with
// its `phase` too -- or null. Read-only; a caller that wants to wait for the holder or
// take over from it uses this to decide whether that is allowed (see
// supersedeLifecycleLock).
export function getLifecycleLockHolder(serverId = null) {
  const holder = blockerFor(serverId);
  if (!holder) return null;
  return {
    operation: holder.operation,
    serverId: holder.serverId,
    ...(holder.phase ? { phase: holder.phase } : {}),
  };
}

// Takes the lock away from its current holder and hands it to the caller.
// For Stop and Force stop only, when the holder is a restart that did not
// finish cancelling: a restart holds the one process-wide lock for its whole
// run (a countdown of up to an hour, then the stop, the start and the wait for
// RCON), and an operator must be able to turn the server off at any point.
// The previous holder's release() becomes a no-op (it only clears the lock it
// still owns), so it can run to its end without freeing the new owner's lock.
// A restart already waiting for RCON holds its server instead (see
// holdServerUntilRcon): that hold is taken over the same way. The
// process-wide lock is never taken from ANOTHER server's operation: that
// refuses, as an acquire would.
export function supersedeLifecycleLock(operation = "lifecycle", serverId = null) {
  const id = normalizeServerId(serverId);
  if (activeLock?.serverId && id && activeLock.serverId !== id) {
    lastRefusal = activeLock;
    return null;
  }
  activeLock = null;
  if (id) serverHolds.delete(id);
  return installLifecycleLock(operation, serverId);
}

// Whether a panel lifecycle operation could account for this server going
// down: one is under way for it, or for no server in particular (boot
// auto-start, an automatic update, /delete-files), or one ended within
// `withinMs`. A Docker or service stop confirms before its lock is released,
// but the watch that notices the process gone can tick a little later. The
// server watch (services/serverWatch.js) reads it so a stop the panel made --
// Stop, Restart, a wipe, a restore, an update -- is never taken for a crash.
export function lifecycleActivityCovers(serverId, withinMs, now = Date.now()) {
  const id =
    serverId !== null && serverId !== undefined ? String(serverId).trim() : "";
  if (activeLock && (!activeLock.serverId || activeLock.serverId === id)) {
    return true;
  }
  if (id && serverHolds.has(id)) return true;
  const quitAt = id ? quitRequestedAt.get(id) : undefined;
  if (quitAt !== undefined && now - quitAt <= withinMs) return true;
  return [id, ""].some((key) => {
    const at = lastReleasedAt.get(key);
    return at !== undefined && now - at <= withinMs;
  });
}

// When the panel last sent `quit` over RCON to each server, by server id
// (rcon.js's execute()). A quit takes no lifecycle lock when it is typed in
// the Console or run by a scheduled task, so without this the server watch
// took the stop that followed for a crash and, with "Restart if it goes
// down" on, started the server again 15 seconds after the operator stopped it.
export function noteServerQuitRequested(serverId, at = Date.now()) {
  const id = normalizeServerId(serverId);
  if (id) quitRequestedAt.set(id, at);
}

// Reads the CURRENT holder off `activeLock` directly rather than taking a
// descriptor argument, so every call site at every refusal point (13 of
// them) needs no change at all -- only acquireLifecycleLock() callers gained
// an optional second argument. Degrades to the original generic wording
// when the holder didn't pass an id (boot auto-start, automatic updates --
// operations with no single server to name), rather than rendering
// something like "for 'undefined'".
//
// 2026-09-08: `serverId` becoming the server DB id (a UUID) rather than a
// display name meant this message would otherwise show that raw UUID --
// meaningless to an operator, and the exact "the panel says something
// useless when it refuses" complaint this whole night was about. Resolved
// back to a display name via the injected resolveServerDisplayName (see
// setServerDisplayNameResolver above) -- a SYNCHRONOUS, best-effort lookup
// by design, so this function (and its 13 read call sites) never had to go
// async for a message-readability fix. Falls back to the existing generic
// wording, unchanged, whenever no resolver is wired, the id doesn't
// resolve (a deleted server, or the /delete-files null case), or the
// resolver itself throws -- never prints a bare UUID or a placeholder. The
// lock itself still only ever stores the id (acquireLifecycleLock is
// untouched) -- only the message resolves a name from it.
//
// A refusal by a server's hold (holdServerUntilRcon) names that hold: the
// process-wide lock is free then, and lastRefusal says what refused. Either
// way `holder` carries the structured version ({ operation, serverId,
// serverName, phase, since }) so the client can word the reason itself.
export function lifecycleInProgressResponse() {
  // A caller that refuses for a reason of its own after a successful acquire
  // (one restart at a time, see restartOtherServer) gets whichever server
  // is still waiting for its RCON, rather than the generic wording.
  const holder =
    activeLock ??
    (lastRefusal?.phase && serverHolds.get(lastRefusal.serverId) === lastRefusal
      ? lastRefusal
      : (serverHolds.values().next().value ?? null));
  const displayName = displayNameOf(holder?.serverId);
  const waitingForRcon = holder?.phase === "waiting-for-rcon";
  const error =
    holder?.operation && displayName
      ? waitingForRcon
        ? `'${displayName}' is starting: the panel is waiting for its RCON to answer`
        : `A '${holder.operation}' operation for '${displayName}' is already in progress`
      : holder?.operation
        ? `A '${holder.operation}' operation is already in progress`
        : "Another server lifecycle operation is already in progress";
  return { error, code: LIFECYCLE_IN_PROGRESS_CODE, holder: describeHolder(holder) };
}

// Whether any lifecycle operation is under way -- a server waiting for its
// RCON included.
export function isLifecycleLocked() {
  return activeLock !== null || serverHolds.size > 0;
}

// steamcmd-ops-never-check-the-lifecycle-lock, 2026-09-09: SteamCMD ops
// (install/quick-setup/steam-update) must NOT take this GLOBAL lock
// themselves -- a multi-minute download holding the one module-level
// activeLock would freeze every unrelated server's start/stop/restart
// panel-wide, confirming the operator's "start/stop feels unreliable"
// report rather than fixing it (god's ruling, 2026-09-08). What they need
// instead is to ask "is the CURRENTLY HELD lock for THIS SAME server",
// which is only meaningful now that serverId means one thing everywhere
// (08396dcd's normalization) instead of five. Mirrors the scope-of-claim
// shape hasActiveSteamOperation() already uses in the reverse direction
// (wipe/restore refusing while SteamCMD holds normalizedInstallPath) --
// both sides now answer "are we touching the same thing", not "is
// anything happening anywhere".
//
// Returns false (never refuses) when either side has no id to compare:
// a lock acquired with no serverId (boot auto-start, an automatic update
// with no single server, or server.js's /delete-files -- deliberately
// null, see acquireLifecycleLock's own comment) can't be proven to be the
// SAME server, so it must not silently guard nothing while looking like it
// checked something. This is a known, already-documented gap (2 of the 20
// call sites), not a new one introduced here.
export function isLifecycleLockedForServer(serverId) {
  if (serverId === null || serverId === undefined) return false;
  const normalized = String(serverId).trim();
  if (!normalized) return false;
  // A server waiting for its RCON is that server's operation too.
  if (serverHolds.has(normalized)) return true;
  if (!activeLock?.serverId) return false;
  return activeLock.serverId === normalized;
}
