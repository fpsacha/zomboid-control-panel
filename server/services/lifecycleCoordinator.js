export const LIFECYCLE_IN_PROGRESS_CODE = "SERVER_LIFECYCLE_IN_PROGRESS";

let activeLock = null;
let nextLockId = 0;
let resolveServerDisplayName = null;

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
export function acquireLifecycleLock(operation = "lifecycle", serverId = null) {
  if (activeLock) return null;

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
  };
  activeLock = token;
  let released = false;

  return {
    operation: token.operation,
    release() {
      if (released) return;
      released = true;
      if (activeLock === token) activeLock = null;
    },
  };
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
export function lifecycleInProgressResponse() {
  const holder = activeLock;
  let displayName = null;
  if (holder?.serverId && resolveServerDisplayName) {
    try {
      displayName = resolveServerDisplayName(holder.serverId) || null;
    } catch {
      displayName = null;
    }
  }
  const error =
    holder?.operation && displayName
      ? `A '${holder.operation}' operation for '${displayName}' is already in progress`
      : holder?.operation
        ? `A '${holder.operation}' operation is already in progress`
        : "Another server lifecycle operation is already in progress";
  return { error, code: LIFECYCLE_IN_PROGRESS_CODE };
}

export function isLifecycleLocked() {
  return activeLock !== null;
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
  if (!activeLock?.serverId) return false;
  if (serverId === null || serverId === undefined) return false;
  const normalized = String(serverId).trim();
  return normalized.length > 0 && activeLock.serverId === normalized;
}
