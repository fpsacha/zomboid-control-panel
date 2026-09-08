export const LIFECYCLE_IN_PROGRESS_CODE = "SERVER_LIFECYCLE_IN_PROGRESS";

let activeLock = null;
let nextLockId = 0;

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
// 2026-09-08: the interpolated value is now a raw server DB id (a UUID),
// not the display name it used to be for most callers -- this message got
// less friendly as a direct, accepted consequence of `serverId` becoming
// load-bearing rather than cosmetic (see acquireLifecycleLock's comment
// above). Resolving it back to a display name here would need this
// function to become async (a DB read) and touch all 13 read call sites
// for a message-readability improvement that was not part of this
// normalization -- flagged to god as a follow-up, not fixed here.
export function lifecycleInProgressResponse() {
  const holder = activeLock;
  const error =
    holder?.operation && holder?.serverId
      ? `A '${holder.operation}' operation for '${holder.serverId}' is already in progress`
      : holder?.operation
        ? `A '${holder.operation}' operation is already in progress`
        : "Another server lifecycle operation is already in progress";
  return { error, code: LIFECYCLE_IN_PROGRESS_CODE };
}

export function isLifecycleLocked() {
  return activeLock !== null;
}
