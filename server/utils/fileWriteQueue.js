/**
 * Shared helpers for safely writing config files (INI/Lua/JSON) that PZ
 * itself also reads, where a half-written file or a lost concurrent update
 * would be a real (if rare) way to corrupt or clobber a server's config.
 *
 * The DB layer (database/init.js) already does the atomic temp-file+rename
 * trick for db.json; these two helpers bring the same protection to the
 * config-file editor routes, which previously did a direct
 * `fs.writeFileSync` straight onto the live file with no locking.
 */
import fs from "fs";
import path from "path";

const fileLocks = new Map(); // resolved path -> tail of the pending promise chain

// Codes that mean "something else has a momentary handle on the target
// file" -- an antivirus scanner, the search indexer, or any process briefly
// opening it -- rather than a real, permanent failure. Windows surfaces this
// contention as EPERM as often as the more obviously-named EBUSY; EACCES is
// the same shape from a transient permissions/lock check. Anything else
// (ENOENT, ENOSPC, a real permission problem, ...) is not transient and must
// fail immediately, not spend time retrying a rename that was never going to
// succeed.
const TRANSIENT_RENAME_ERROR_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

// Small, fixed, bounded backoff -- three retries max, in whole milliseconds.
// This is a SYNCHRONOUS call on a request path (writeFileAtomic has no
// callers to `await`, unlike database/init.js's own debounced/async write
// path, which is why this doesn't reuse that shape's much longer
// exponential backoff verbatim): an unbounded or slow retry here would turn
// a failed save into a hung request instead of a fast one. ~175ms worst
// case is enough to ride out a sub-100ms transient scan lock without making
// a request noticeably slow.
const RENAME_RETRY_DELAYS_MS = [25, 50, 100];

// Blocks the calling thread for `ms` without a busy-loop (Atomics.wait
// parks on the OS wait primitive instead of spinning). There is no
// non-blocking way to delay inside a synchronous function, and keeping
// writeFileAtomic synchronous avoids threading `await` through every one of
// its callers across mods.js, server.js, serverFiles.js, serverManager.js,
// templateService.js and templateFiles.js for what must stay a small,
// bounded wait.
function sleepSync(ms) {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

/**
 * Serialize an async critical section per file path. Concurrent callers for
 * the SAME path run one after another, in call order; different paths run
 * concurrently and don't block each other. Prevents a lost-update race where
 * two overlapping PUTs to the same INI/Lua file both read the old content,
 * mutate independently, and the second write silently clobbers the first's
 * change.
 */
export function withFileLock(filePath, fn) {
  const key = path.resolve(filePath);
  const prior = fileLocks.get(key) || Promise.resolve();
  const run = prior.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  fileLocks.set(key, tail);
  tail.finally(() => {
    if (fileLocks.get(key) === tail) fileLocks.delete(key);
  });
  return run;
}

/**
 * Atomically write a file: write to a unique temp file in the same
 * directory, then rename into place. A plain `writeFileSync` truncates the
 * live file first, so a crash/power-loss mid-write (or, on Windows, another
 * process holding the file open) can leave a corrupt half-written config.
 * Writing to a temp file and renaming means the live file is only ever
 * replaced by a COMPLETE new version — a crash before the rename leaves the
 * original file untouched.
 *
 * The rename itself gets a small, bounded retry on a transient Windows
 * contention error (see TRANSIENT_RENAME_ERROR_CODES above) -- without it,
 * an antivirus scanner or the search indexer briefly holding the target
 * file open turns a perfectly fine save into a hard failure that a retry
 * 25-100ms later would have avoided. A non-transient error still fails on
 * the first attempt, no delay. Either way, the tmp file never survives a
 * failure: it's only ever cleaned up once, when this function is done
 * retrying and about to give up for good.
 *
 * Permissions (2026-08-29 Linux secrets hunt): rename() makes the LIVE file
 * inherit the TEMP file's mode, not whatever the live file's mode was a
 * moment ago. A caller that doesn't pass an explicit `mode` (most of them —
 * this is shared by ~15 call sites across serverFiles.js/server.js/
 * serverManager.js/templateFiles.js, several of them rewriting server.ini,
 * which legitimately carries a plaintext RCONPassword= for the PZ server
 * binary itself to read) would otherwise silently RESET an already-hardened
 * file back to whatever the current process umask produces on every single
 * rewrite — confirmed on real Linux: a file hardened to 0600 came back
 * 0644/0664/0666 after one unmoded rewrite, depending on umask. Fixed by
 * preserving the existing target's mode across a mode-less rewrite,
 * intersected with whatever the umask-derived default would have been so a
 * rewrite can still TIGHTEN (a stricter umask than last time) but can never
 * LOOSEN. An explicit `mode` in `options` always wins outright, unchanged
 * from before. A brand-new file (no existing target) is unaffected — same
 * umask-derived default as always, so first-write behavior doesn't regress.
 */
export function writeFileAtomic(filePath, data, options = "utf-8") {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  const explicitMode =
    typeof options === "object" && options !== null && options.mode != null
      ? options.mode
      : null;
  let existingMode = null;
  if (explicitMode == null) {
    try {
      existingMode = fs.statSync(filePath).mode & 0o777;
    } catch {
      /* no existing target -- nothing to preserve, first-write default stands */
    }
  }

  // `options` is passed straight through to fs.writeFileSync, so callers can
  // pass either an encoding string ('utf-8') or an options object
  // ({ encoding, mode }) exactly as they would to writeFileSync directly.
  fs.writeFileSync(tmpPath, data, options);

  if (existingMode != null) {
    const defaultMode = fs.statSync(tmpPath).mode & 0o777;
    try {
      fs.chmodSync(tmpPath, existingMode & defaultMode);
    } catch {
      /* best-effort: Windows / network shares */
    }
  }

  let attempt = 0;
  for (;;) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      const canRetry =
        TRANSIENT_RENAME_ERROR_CODES.has(err.code) &&
        attempt < RENAME_RETRY_DELAYS_MS.length;
      if (!canRetry) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          /* best effort */
        }
        throw err;
      }
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
      attempt++;
    }
  }
}
