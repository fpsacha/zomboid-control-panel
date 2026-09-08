/**
 * PID lock file for the panel.
 *
 * Prevents two instances of the panel from racing on the same data folder,
 * which previously caused:
 *   - port 3001 EADDRINUSE restart loops (systemd respawning while the
 *     previous process still owned the socket)
 *   - db.json.tmp rename ENOENT races (two writers, one shared tmp name)
 *
 * Behaviour:
 *   - acquireLock() reads any existing lock file and bails out if that PID
 *     is still alive, via the shared isPidAlive() (utils/pidLiveness.js) --
 *     process.kill(pid, 0), treating any error OTHER than ESRCH ("no such
 *     process") as "still alive," never as "safe to overwrite." An
 *     ambiguous signal belongs on the side that fails toward refusing to
 *     start, not toward proceeding (operator ruling, bughunt-2026-08-31-c):
 *     a false PROCEED here is the port-conflict / db.json-corruption pair
 *     this whole file exists to prevent; a false REFUSAL is visible and
 *     recoverable in one step (delete the lock file, restart). This file
 *     used to carry its own separate isProcessAlive(), which got that
 *     direction backwards -- it treated any non-EPERM error as "not alive,"
 *     i.e. safe to proceed -- and was a THIRD, undeduplicated copy of the
 *     exact check pidLiveness.js's own header already claimed was
 *     consolidated to one place. Folding this file onto the shared
 *     primitive removes that copy AND fixes its direction in the same
 *     change; the direction fix is the reason to do this now, not a side
 *     effect of a dedup.
 *   - "Alive" still does NOT verify the PID is actually a panel process
 *     (this comment claimed it did, from this file's very first commit;
 *     the code never did). On a system that reuses PIDs quickly (small
 *     pid_max, Windows), a panel crash followed by a fast restart can land
 *     on a PID the OS has already handed to an unrelated process, and this
 *     would refuse to start believing it's a duplicate instance -- the
 *     SAME "fail toward refusing to start" direction as above, so this is
 *     a known, accepted cost of that ruling, not a separate bug. A real
 *     identity check means reading the target process's argv/image name,
 *     which has no single cross-platform primitive.
 *   - Stale locks (process gone, confirmed via ESRCH) are silently replaced.
 *   - If the lock file itself cannot be WRITTEN (not "another instance has
 *     it," but "acquireLock() can't create it at all"), the direction
 *     ruling above was never actually applied here -- this branch predates
 *     bughunt-2026-08-31-c and was not revisited by it (confirmed via git
 *     history: that fix's own commit message scopes itself to the
 *     ambiguous-liveness-signal branch, and its test file covers every
 *     OTHER branch in this function but not this one). It unconditionally
 *     logged a warn and proceeded WITHOUT a lock -- the opposite direction
 *     from three lines above, and reachable by every instance identically
 *     whenever the data directory is read-only or access-restricted, which
 *     is exactly the environment class least likely to have anyone
 *     watching warn-level logs. 2026-09-08: narrowed to the SPECIFIC,
 *     empirically-verified error codes the original comment actually
 *     defended (EXPECTED_UNWRITABLE_CODES below) -- those still proceed
 *     without a lock (refusing would turn a supported read-only-mount
 *     deployment into its own outage), but anything else unexpected now
 *     refuses, matching the ruling instead of silently bypassing it.
 *     isLockProtectionDisabled() exposes the accepted case persistently for
 *     a diagnostics check to surface, since a warn line only reaches an
 *     operator already watching for it.
 *   - releaseLock() removes the file; registered for process exit signals.
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';
import { isPidAlive } from './pidLiveness.js';

const log = createLogger('Lock');

let _lockFilePath = null;
let _released = false;
let _lockDisabledReason = null;

// Error codes accepted as "the data directory is deliberately read-only or
// access-restricted" -- the ONLY case the comment below was written to
// excuse from the fail-toward-refuse ruling above. Verified empirically
// against real environments tonight (2026-09-08), not derived from
// documentation, because a guessed set that's wrong in either direction is
// its own bug: too narrow silently converts the legitimate case into an
// outage (exactly what this exception exists to prevent); too wide quietly
// re-opens the duplicate-instance/db.json-corruption pair this file exists
// to close.
//   EROFS  -- real Linux read-only bind mount (`docker run -v host:/data:ro`).
//   EACCES -- real Linux permission-denied directory (chmod 000, non-root).
//   EPERM  -- real Windows ACL-denied directory (icacls /deny write) --
//             Windows does NOT surface EROFS/EACCES for this, confirmed
//             directly; guessing here would risk breaking the packaged
//             app's primary platform, which is worse than the bug being
//             fixed.
//   EBUSY  -- included defensively (a locked/in-use lock file, e.g. an
//             antivirus or backup tool holding it momentarily, is a real
//             possibility this list should not refuse on) but NOT
//             independently reproduced the way the other three were --
//             flagged here so a future reader knows the difference between
//             "verified" and "included on the safe side."
const EXPECTED_UNWRITABLE_CODES = new Set(['EROFS', 'EACCES', 'EPERM', 'EBUSY']);

/**
 * Try to acquire the lock. Returns { acquired: true } on success.
 * On failure returns { acquired: false, reason, existingPid? }.
 *
 * A successful acquisition can still mean duplicate-instance protection is
 * OFF: if the data directory is deliberately read-only/access-restricted
 * (one of EXPECTED_UNWRITABLE_CODES above), this proceeds without a lock
 * rather than turning a supported deployment into an outage, and sets
 * lockPath to null. Call isLockProtectionDisabled() to check that state
 * later (e.g. from a diagnostics check) without re-deriving it.
 *
 * Any OTHER write failure (not on that list -- ENOSPC, an unexpected I/O
 * error, a bug) was never a considered exception to the fail-toward-refuse
 * ruling below, so it refuses to start rather than silently proceeding.
 *
 * On success, the caller MUST eventually call releaseLock() or rely on
 * the registered exit handlers to clean up.
 */
export function acquireLock(dataDir) {
  const lockPath = path.join(dataDir, 'panel.lock');
  _lockFilePath = lockPath;
  _lockDisabledReason = null;

  try {
    if (fs.existsSync(lockPath)) {
      const raw = fs.readFileSync(lockPath, 'utf8').trim();
      const existingPid = parseInt(raw, 10);
      if (
        Number.isInteger(existingPid) &&
        existingPid > 0 &&
        existingPid !== process.pid &&
        isPidAlive(existingPid)
      ) {
        return {
          acquired: false,
          reason: `another panel instance is already running (pid ${existingPid})`,
          existingPid,
          lockPath,
        };
      }
      // Stale lock (process dead or our own PID re-used) — overwrite.
      log.debug(`Removing stale lock at ${lockPath} (pid ${raw})`);
    }

    fs.writeFileSync(lockPath, String(process.pid), { encoding: 'utf8', mode: 0o600 });
    registerExitHandlers();
    return { acquired: true, lockPath };
  } catch (err) {
    if (EXPECTED_UNWRITABLE_CODES.has(err.code)) {
      // The one documented, accepted exception: a deliberately read-only or
      // access-restricted data directory. Proceeding without a lock here,
      // rather than refusing, is the ruling this exception exists for --
      // refusing would turn a supported deployment into an outage.
      log.warn(`Could not create lock file: ${err.message} — continuing without duplicate-instance protection`);
      _lockFilePath = null;
      _lockDisabledReason = { code: err.code, message: err.message, lockPath };
      return { acquired: true, lockPath: null };
    }
    // Anything NOT on that list is unexpected (ENOSPC, disk corruption, a
    // bug) and was never a considered exception to the fail-toward-refuse
    // ruling above -- refusing here, not silently proceeding, matches that
    // ruling instead of accidentally bypassing it.
    log.error(`Could not create lock file: ${err.message} — refusing to start`);
    return {
      acquired: false,
      reason: `could not create the lock file (${err.code || 'unknown error'}: ${err.message})`,
      lockPath,
    };
  }
}

/**
 * Non-null when the most recent acquireLock() succeeded only because the
 * data directory was deliberately read-only/access-restricted (see
 * EXPECTED_UNWRITABLE_CODES) -- duplicate-instance protection is currently
 * off. Exists so a diagnostics check can surface this persistently, since a
 * one-time warn log only reaches an operator already watching for it.
 */
export function isLockProtectionDisabled() {
  return _lockDisabledReason;
}

export function releaseLock() {
  if (_released || !_lockFilePath) return;
  _released = true;
  try {
    // Only delete if it still contains our PID — never clobber another
    // instance that may have taken over.
    if (fs.existsSync(_lockFilePath)) {
      const raw = fs.readFileSync(_lockFilePath, 'utf8').trim();
      if (raw === String(process.pid)) {
        fs.unlinkSync(_lockFilePath);
      }
    }
  } catch {
    // best-effort
  }
}

let _handlersRegistered = false;
function registerExitHandlers() {
  if (_handlersRegistered) return;
  _handlersRegistered = true;
  // Use 'exit' for synchronous cleanup. Also catch signals so the file is
  // gone before systemd respawns us.
  process.on('exit', releaseLock);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      releaseLock();
      // Let other handlers run; default behaviour will exit.
    });
  }
}
