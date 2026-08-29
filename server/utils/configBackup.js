/**
 * Shared helper for backing up a server config file (INI/Lua) before an edit
 * overwrites it. Originally lived only in server/routes/serverFiles.js;
 * extracted here so server/routes/mods.js's ini-rewriting routes can reuse
 * the exact same logic instead of reinventing it (mods.js fully replaced
 * Mods=/WorkshopItems=/Map= with no backup at all across 19 routes — see
 * writeIniWithBackup below).
 */
import fs from "fs";
import path from "path";
import { createLogger } from "./logger.js";
import { writeFileAtomic } from "./fileWriteQueue.js";

const log = createLogger("Utils:ConfigBackup");

async function pathExists(candidatePath) {
  try {
    await fs.promises.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

// Backup directory for a given server config directory.
export async function getBackupPath(configPath) {
  return path.join(configPath, "backups");
}

// A backup name is `${filename}.<timestamp>.bak`, or
// `${filename}.<timestamp>-<n>.bak` when createBackup() had to disambiguate
// a same-millisecond collision (see its own comment). <timestamp> is
// `new Date().toISOString().replace(/[:.]/g, "-")`, which always ends in
// literal "Z" -- so splitting off a trailing "-<digits>" only ever strips a
// real collision suffix, never part of the timestamp itself.
const COLLISION_SUFFIX_RE = /^(.*Z)-(\d+)$/;

function parseBackupName(filename, name) {
  const rest = name.slice(filename.length + 1, name.length - ".bak".length);
  const match = rest.match(COLLISION_SUFFIX_RE);
  return match
    ? { timestampKey: match[1], suffix: parseInt(match[2], 10) }
    : { timestampKey: rest, suffix: 1 };
}

// Existing backups of `filename` inside `configPath`, newest first --
// ordered by parsing each backup's OWN embedded timestamp + collision
// suffix out of its filename, not by fs birthtime.
//
// This used to sort by real fs birthtime (48de518), fixing a real bug: a
// plain string sort of the whole filename put "-2.bak" before ".bak"
// ('-' < '.'), so within a same-millisecond collision group the
// chronologically-first (oldest) name was always treated as newest. But
// birthtime doesn't hold up on Linux for the same case it was meant to fix:
// several backups of the SAME filename created within the same JS tick (the
// exact scenario the collision suffix exists for) can land on ext4 with
// IDENTICAL birthtimeMs -- confirmed on real WSL2/ext4, not a theoretical
// concern -- at which point Array.prototype.sort's stability falls back to
// original array order, which is readdir()'s order, which has no
// relationship to creation order at all. The visible failure: the
// brand-new backup this very call just created gets treated as older than
// backups that existed before it, and can be the one pruned.
// See server/tests/configBackup.test.js's "pruning still keeps only the 10
// newest..." test, which reproduces this on Linux with no artificial delay
// between writes.
//
// The fix parses the timestamp + numeric collision suffix each backup's
// name already encodes (createBackup() below is the only writer of this
// format) and orders by that instead -- no filesystem timestamp of any
// kind, so no platform-dependent resolution to lose. Shared by
// createBackup()'s own pruning and by createBackupIfChanged()'s "is this
// actually new content" check below, so both agree on what "most recent"
// means.
async function listBackupsFor(backupDir, filename) {
  let files;
  try {
    files = await fs.promises.readdir(backupDir);
  } catch {
    return [];
  }
  const candidateNames = files.filter(
    (f) => f.startsWith(filename + ".") && f.endsWith(".bak"),
  );
  return candidateNames
    .map((name) => ({ name, ...parseBackupName(filename, name) }))
    .sort((a, b) => {
      if (a.timestampKey !== b.timestampKey) {
        return a.timestampKey < b.timestampKey ? 1 : -1; // newest first
      }
      return b.suffix - a.suffix; // higher collision suffix = created later
    })
    .map((c) => c.name);
}

// Create a backup of `filename` (a file directly inside `configPath`) before
// an edit overwrites it.
//
// Returns one of three shapes, DELIBERATELY not collapsed into a single
// null/truthy check: a caller that can't tell "nothing to back up" apart
// from "the backup failed" ends up treating both the same way, which is
// exactly how a response ended up asserting a backup existed when it
// didn't (see docs/qa/kevin-route-hunt.md Finding 2). Same defect shape as
// `if (!req.user) return next()` from earlier tonight -- one value quietly
// carrying two meanings, one benign and one dangerous.
//   { backedUp: true, name }               -- a real backup now exists on disk
//   { backedUp: false, reason: "no-source" } -- benign: the file being edited
//     doesn't exist yet (e.g. first-ever write), so there is nothing to
//     protect. Not a failure.
//   { backedUp: false, reason: "failed", error } -- dangerous: a backup was
//     attempted (the source file exists) and did not happen -- disk full,
//     backup dir unwritable, the copy itself failing. The safety net the
//     caller may be about to rely on is NOT there.
export async function createBackup(configPath, filename) {
  const backupDir = await getBackupPath(configPath);
  const filePath = path.join(configPath, filename);

  try {
    await fs.promises.access(filePath);
  } catch (e) {
    log.debug(`Config backup source not found: ${filePath} — ${e.message}`);
    return { backedUp: false, reason: "no-source" };
  }

  try {
    // Ensure backup directory exists
    await fs.promises.mkdir(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    // toISOString() is millisecond-resolution. Two backups of the same file
    // detected close together (e.g. two saves in quick succession) can land
    // in the same millisecond, which would make the second copyFile below
    // silently overwrite the first -- the exact defect found and fixed in
    // server.js's startup-script backups (2026-08-27). Disambiguate with a
    // counter suffix so two backups from the same tick never collide.
    let backupName = `${filename}.${timestamp}.bak`;
    let backupPath = path.join(backupDir, backupName);
    for (let suffix = 2; await pathExists(backupPath); suffix++) {
      backupName = `${filename}.${timestamp}-${suffix}.bak`;
      backupPath = path.join(backupDir, backupName);
    }

    // Async copy — this is the actual safety net. Anything that throws
    // past this point means the backup did not happen.
    await fs.promises.copyFile(filePath, backupPath);
    log.info(`Created backup: ${backupName}`);

    // Cleanup old backups is best-effort housekeeping, not part of the
    // safety net itself — the new backup above already exists on disk
    // regardless of whether pruning old ones succeeds, so a cleanup
    // failure must not flip this call's result to backedUp:false.
    try {
      const backups = await listBackupsFor(backupDir, filename);

      if (backups.length > 10) {
        const filesToDelete = backups.slice(10);
        await Promise.all(
          filesToDelete.map((old) =>
            fs.promises
              .unlink(path.join(backupDir, old))
              .catch((e) =>
                log.warn(`Failed to delete old backup ${old}: ${e.message}`),
              ),
          ),
        );
      }
    } catch (cleanupError) {
      log.warn(
        `Backup cleanup failed (new backup ${backupName} is still safe): ${cleanupError.message}`,
      );
    }

    return { backedUp: true, name: backupName };
  } catch (error) {
    log.error(`Backup creation failed: ${error.message}`);
    return { backedUp: false, reason: "failed", error: error.message };
  }
}

// Same contract as createBackup(), but for an UNATTENDED caller (a
// scheduled restart, or any future automated event) rather than a human
// edit: skips taking a new backup when the live file's content is
// byte-identical to the most recent existing backup of it.
//
// Why this exists and createBackup() itself doesn't just always dedupe:
// a human edit-and-save is, by definition, a content change already (the
// route only calls createBackup() because something is about to be
// written) -- the check would never trigger there and would just be a
// wasted read on every save. An automated event fires whether or not
// anything actually changed (every scheduled restart, whether or not the
// operator touched config since the last one), so a naive
// backup-every-time here silently fills the keep-10 quota with duplicate
// copies of an unchanged file and EVICTS the real, content-different
// human-edit backups that are the ones actually worth keeping -- the same
// shape as the sort-order pruner bug fixed earlier tonight, just reached
// by flooding the count instead of misordering it. This is the fix's own
// answer to that risk, not a follow-up: nothing new is written, so
// nothing enters the retention count, so nothing gets evicted.
//
// Returns createBackup()'s own shape, plus one more reason:
//   { backedUp: false, reason: "unchanged" } -- a backup of this exact
//     content already exists as the most recent one; nothing written.
export async function createBackupIfChanged(configPath, filename) {
  const filePath = path.join(configPath, filename);
  let liveContent;
  try {
    liveContent = await fs.promises.readFile(filePath);
  } catch {
    // No live file (or unreadable) -- let createBackup() produce its own
    // standard no-source/failed classification rather than guessing here.
    return createBackup(configPath, filename);
  }

  const backupDir = await getBackupPath(configPath);
  const existing = await listBackupsFor(backupDir, filename);
  if (existing.length > 0) {
    try {
      const mostRecent = await fs.promises.readFile(
        path.join(backupDir, existing[0]),
      );
      if (Buffer.compare(liveContent, mostRecent) === 0) {
        return { backedUp: false, reason: "unchanged" };
      }
    } catch (e) {
      log.debug(
        `Could not compare against most recent backup of ${filename}, backing up anyway: ${e.message}`,
      );
    }
  }

  return createBackup(configPath, filename);
}

// For an ordinary, intentional config edit (as opposed to /sandbox/repair's
// heuristic rewrite of an already-corrupted file): a backup that failed
// must never block the edit the operator asked for -- the file being
// edited is valid and the change is deliberate, so losing the previous
// version is an annoyance, not a disaster. But the response must say so
// rather than silently degrading. Returns a user-facing warning string, or
// null when there's nothing to warn about (backup succeeded, or there was
// no prior file to back up in the first place).
export function backupWarningFor(backup) {
  if (!backup || backup.backedUp || backup.reason === "no-source") return null;
  return `Could not back up the previous version before saving: ${backup.error}. Your change was saved, but there is no safety copy of what was there before.`;
}

// Back up the live ini at `iniPath`, then atomically write `content` in its
// place. This is the ONLY way anything in mods.js may write that ini —
// mods.js does not import writeFileAtomic directly (removed from its import
// list on purpose), so a future ini-rewriting route physically cannot skip
// the backup without first adding that import back, which is a visible,
// reviewable diff rather than a silent omission.
export async function writeIniWithBackup(iniPath, content) {
  const configPath = path.dirname(iniPath);
  const filename = path.basename(iniPath);
  const backup = await createBackup(configPath, filename);
  writeFileAtomic(iniPath, content, "utf-8");
  return backup;
}
