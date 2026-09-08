import { createLogger } from "../utils/logger.js";
import { getSetting, setSetting } from "../database/init.js";
import { isPidAlive } from "../utils/pidLiveness.js";

const log = createLogger("SteamOperations");

// Extracted out of routes/server.js (hunt-wave5-2026-08-29, concurrency
// hunt) so serverManager.js's startServer() can check it too, without a
// circular import: routes/server.js already imports resolveLaunchMode from
// serverManager.js, so a reverse edge (serverManager.js importing FROM
// routes/server.js) would create a real cycle. This module sits below both
// -- routes/server.js and serverManager.js both import from here, neither
// imports from the other for this.
//
// Tracks in-flight SteamCMD operations (install/update/validate) per
// normalized install path. POST /install and POST /steam-update
// (routes/server.js) already guarded against a SECOND SteamCMD operation
// on the SAME path this way -- what was missing (see
// server/tests/startServerBlockedDuringSteamOperation.test.js) is that
// nothing checked this before SPAWNING THE PZ SERVER ITSELF: a Start or
// Restart could launch the JVM directly against an install directory
// SteamCMD was still mid-write to.
const activeSteamOperations = new Map();
export const STEAM_OPERATION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export function isSteamOperationIdle(operation, now = Date.now()) {
  return Boolean(
    operation?.lastOutputAt &&
      now - operation.lastOutputAt >= STEAM_OPERATION_IDLE_TIMEOUT_MS,
  );
}

export function getActiveSteamOperations() {
  return activeSteamOperations;
}

export function clearActiveSteamOperation(normalizedPath) {
  const operation = activeSteamOperations.get(normalizedPath);
  if (operation?.watchdog) clearInterval(operation.watchdog);
  activeSteamOperations.delete(normalizedPath);
  // Fire-and-forget: this function's signature (synchronous, called from
  // many places without awaiting) predates the persisted mirror below and
  // stays that way rather than making every existing caller async for a
  // best-effort write. Worst case on a failed persist here is a stale
  // snapshot entry that rehydrateActiveSteamOperationsFromDisk() below
  // will find already-dead and self-heal on the next restart anyway --
  // never a false claim that blocks something real.
  persistSnapshot().catch((error) => {
    log.warn(`Could not clear persisted active Steam operation state: ${error.message}`);
  });
}

// True if a live SteamCMD process is still tracked for this exact
// normalized path. A tracked-but-dead entry (the process exited without
// this module's own 'close' handler clearing it -- shouldn't normally
// happen, but this must not trust stale bookkeeping either way) is
// verified with a signal-0 liveness probe and self-heals by clearing the
// stale entry rather than reporting a false positive forever.
//
// wrapper-bypass class sweep, 2026-09-08: this used to reimplement the
// signal-0 probe inline (process.kill(pid, 0), ESRCH-vs-other) instead of
// calling pidLiveness.js's isPidAlive() -- the shared primitive that module
// was built specifically because a THIRD undeduplicated copy (pidLock.js)
// once had this exact ambiguous-direction backwards. Verified byte-identical
// in behavior before swapping (both treat any non-ESRCH outcome as "still
// alive"); this closes the drift risk of a future isPidAlive() refinement
// silently not reaching this call site -- see pidLiveness.js's own header
// comment for why that "the one place it lives now" claim matters here.
export function hasActiveSteamOperation(normalizedPath) {
  const operation = activeSteamOperations.get(normalizedPath);
  if (!operation) return false;

  if (Number.isInteger(operation.pid)) {
    if (isPidAlive(operation.pid)) return true;
    clearActiveSteamOperation(normalizedPath);
    log.warn(
      `Cleared stale Steam ${operation.type} operation for ${normalizedPath}`,
    );
    return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Crash-survival mirror. The Map above only guards for as long as THIS
// PROCESS lives -- if the panel itself crashes (not the update failing,
// the panel dying) while SteamCMD is running, a restarted panel's Map
// starts empty, with no memory that an orphaned SteamCMD might still be
// running, and Start/Restart's own guard (serverManager.js's
// hasActiveSteamOperation() call) sees nothing to block it. The
// consequence is not a failed update, it's the JVM launching over a
// half-written install -- a corrupted server, not a retryable failure
// (2026-09-08, god's ruling on the game-server-autoupdate-sweep's reported
// edge: don't build a new persistence layer, reuse the settings store
// every operational marker in this codebase already goes through -- see
// updateChecker.js's lastAutoUpdateResult for the identical pattern this
// mirrors).
//
// Deliberately persists only `pid`/`type`/`startTime`, never the whole
// operation object -- `watchdog` is a live setInterval handle, meaningless
// (and unserializable) across a process restart, and `lastOutputAt`'s only
// consumer (isSteamOperationIdle above) exists to detect a
// silent-but-still-running steamcmd from within the same process's own
// watchdog tick, not to survive a restart.
// ─────────────────────────────────────────────────────────────────────────
const PERSISTED_SETTING_KEY = "activeSteamOperations";

async function persistSnapshot() {
  const snapshot = {};
  for (const [normalizedPath, operation] of activeSteamOperations) {
    if (!Number.isInteger(operation?.pid)) continue;
    snapshot[normalizedPath] = {
      pid: operation.pid,
      type: operation.type || "unknown",
      startTime: operation.startTime || Date.now(),
    };
  }
  try {
    await setSetting(PERSISTED_SETTING_KEY, snapshot);
  } catch (error) {
    // Best-effort: the in-memory Map (this process's own live guard) is
    // already correct regardless -- a failed persist only weakens crash
    // survival, it never makes THIS process's own guarding wrong.
    log.warn(`Could not persist active Steam operation state: ${error.message}`);
  }
}

// Called once the pid of a just-spawned SteamCMD child is known (the claim
// itself, activeSteamOperations.set(), necessarily happens BEFORE spawn --
// closing the check-then-claim race is what that ordering is for -- so the
// pid, the one field this exists to persist, is only available a moment
// later). Awaited at every call site: correctness here matters more than
// at release, since the whole point is having the marker on disk BEFORE a
// crash, not eventually.
export async function recordActiveSteamOperationPid(normalizedPath, pid) {
  const operation = activeSteamOperations.get(normalizedPath);
  if (!operation) return;
  operation.pid = pid;
  await persistSnapshot();
}

// Rehydrates the in-memory Map from the persisted snapshot at startup, one
// time, before anything could ever call startServer() or spawn a second
// SteamCMD operation. A dead pid is exactly what hasActiveSteamOperation()
// above already knows how to self-heal (it was written for a stale entry
// surviving within one process's own lifetime; a stale entry surviving a
// RESTART is the identical shape from its point of view) -- so this seeds
// the Map and asks that same function to resolve each entry immediately,
// rather than duplicating its liveness logic or waiting for whichever
// caller happens to check first.
export async function rehydrateActiveSteamOperationsFromDisk() {
  let snapshot;
  try {
    snapshot = await getSetting(PERSISTED_SETTING_KEY);
  } catch (error) {
    log.warn(`Could not read persisted active Steam operation state: ${error.message}`);
    return;
  }
  if (!snapshot || typeof snapshot !== "object") return;

  for (const [normalizedPath, entry] of Object.entries(snapshot)) {
    if (!Number.isInteger(entry?.pid)) continue;
    activeSteamOperations.set(normalizedPath, {
      type: entry.type || "unknown",
      startTime: entry.startTime || null,
      pid: entry.pid,
    });
    if (hasActiveSteamOperation(normalizedPath)) {
      log.warn(
        `A Steam ${entry.type || "unknown"} operation for ${normalizedPath} (pid ${entry.pid}) may still be running from before this restart -- Start/Restart and new Steam operations on this path are refused until it's confirmed finished.`,
      );
    } else {
      log.info(
        `A recorded Steam operation for ${normalizedPath} was not actually running anymore (pid ${entry.pid}) -- cleared.`,
      );
    }
  }
}
