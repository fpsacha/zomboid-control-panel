import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { getDataPaths } from "../utils/paths.js";
import { checkAndExitIfOwnershipBlocked } from "../utils/firstRunOwnershipCheck.js";
import { createLogger } from "../utils/logger.js";
import { normalizeMemoryGb } from "../utils/memory.js";
import { parseClampedInteger } from "../utils/queryNumbers.js";
import {
  rehydrateRconSecrets,
  redactRconSecretsForWrite,
  deleteServerSecret,
} from "../utils/serverRconSecrets.js";
import { redactRconCommandSecrets } from "../utils/rconCommandRedaction.js";
import { readUiSecretFile, writeUiSecretFile } from "../utils/uiSecretFile.js";
import { isPidAlive } from "../utils/pidLiveness.js";
const log = createLogger("DB");

// ============================================
// PanelBridge SFTP password — same shape as rconPassword above, not the
// discordBotToken/steamSessionId shape. rconPassword's rehydrate/redact
// pair lives in serverRconSecrets.js because it also owns per-server RCON
// secrets; panelBridgeSftpPassword has no per-server counterpart and no
// single owning service (it's read directly off getAllSettings() by
// routes/panelBridge.js, routes/serverFiles.js and index.js alike), so its
// pair lives here instead of growing an RCON-scoped file to cover an
// unrelated credential.
//
// 2026-08-29: panelBridgeSftpPassword was the one settings-field credential
// that never got moved out to its own file the way discordBotToken,
// steamSessionId/steamLoginSecure and rconPassword all were -- db.json's
// own two backup paths (this file's createBackup() below, and the #122
// pre-update snapshot in panelUpdateChecker.js) both copy db.json as a raw
// file, so it was riding along in every one of those in plaintext.
// ============================================

/**
 * Run on every load, same as rehydrateRconSecrets() -- not schema-version-
 * gated, because db.json never carries this value again once a single
 * write has happened (see redactPanelBridgeSftpPasswordForWrite below), so
 * it has to be re-attached in memory on every restart, not just once at an
 * upgrade. Guarded on the value already being absent: if an operator
 * restores an OLDER db.json that still has the plaintext, this leaves that
 * restored value alone rather than overwriting it with a stale (or
 * missing) secret file -- the next flush redacts whatever is actually in
 * memory, which is the just-restored value.
 */
export function rehydratePanelBridgeSftpPassword(data, log) {
  if (!data.settings) data.settings = {};
  if (!data.settings.panelBridgeSftpPassword) {
    const fromFile = readUiSecretFile("panelBridgeSftpPassword", log);
    if (fromFile) data.settings.panelBridgeSftpPassword = fromFile;
  }
  return data;
}

/**
 * Called inside flushWrites() alongside redactRconSecretsForWrite() -- see
 * that function's doc comment for why `data` itself is never mutated, only
 * the object being serialized. Chained after redactRconSecretsForWrite()
 * (order between the two doesn't matter, they touch different settings
 * keys), so this receives an already-cloned object and returns another
 * clone rather than mutating its input.
 */
export function redactPanelBridgeSftpPasswordForWrite(data) {
  if (!data.settings?.panelBridgeSftpPassword) return data;
  writeUiSecretFile("panelBridgeSftpPassword", data.settings.panelBridgeSftpPassword);
  const { panelBridgeSftpPassword: _panelBridgeSftpPassword, ...restSettings } =
    data.settings;
  return { ...data, settings: restSettings };
}

// ============================================
// Database Configuration
// ============================================

const RETENTION = {
  command_history: 500,
  player_logs: 1000,
  server_events: 500,
  schedule_history: 500,
  // 24h at 60-sec intervals. Keep this in sync with the perf polling interval
  // in index.js: every snapshot rewrites the whole db.json, so this array's
  // length is what sets the panel's steady-state disk write volume — and that
  // disk is usually the one PZ is saving chunks to.
  performance_history: 1440,
  player_sessions: 50, // per player
  bridge_logs: 500,
};

const WRITE_DEBOUNCE_MS = 500; // Coalesce rapid writes
const BACKUP_INTERVAL_MS = 6 * 3600000; // Auto-backup every 6 hours
const MAX_BACKUPS = 5;

// ============================================
// Paths
// ============================================

const paths = getDataPaths();
const dataDir = paths.dataDir;
const dbPath = paths.dbPath;
const backupDir = path.join(dataDir, "backups");

// Ensure directories exist with restrictive perms (POSIX). Mode is ignored on Windows.
// 0o700 — these dirs hold db.json, its rotating backups, and the sibling
// secret files (jwt.secret, discordBotToken.secret, rconPassword.secret,
// server-secrets/*.secret, ...) that keep those values out of db.json
// itself — see utils/jwtSecret.js, utils/uiSecretFile.js,
// utils/serverRconSecrets.js.
for (const dir of [dataDir, backupDir]) {
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      // Defense-in-depth for the root-first-run trap (2026-08-29): the
      // preflight in server/utils/firstRunOwnershipCheck.js (imported
      // first in server/index.js, ahead of this module) is the primary
      // guard and normally catches this before dataDir/backupDir are even
      // reached. This second check exists for the narrower case it can't
      // see coming -- dataDir itself is fine, but a stray root run only
      // touched backupDir (e.g. an operator who deletes just the backups
      // folder, then happens to restart once via sudo before switching
      // back). Same consolidated diagnostic either way, never a raw
      // uncaught EACCES stack trace with no path/account context.
      if (
        (err.code === "EACCES" || err.code === "EPERM") &&
        checkAndExitIfOwnershipBlocked([dataDir, backupDir])
      ) {
        throw err; // unreachable: checkAndExitIfOwnershipBlocked() exits the process
      }
      throw err; // not an ownership problem (e.g. disk full) -- preserve prior behavior
    }
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch (_) {
    /* best-effort: Windows / network shares */
  }
}

// ============================================
// Default Schema
// ============================================

const defaultData = {
  command_history: [],
  scheduled_tasks: [],
  schedule_history: [],
  player_logs: [],
  server_events: [],
  tracked_mods: [],
  ignored_mods: [],
  ignored_mod_pairs: [],
  servers: [],
  player_notes: [],
  player_stats: [],
  mod_presets: [],
  user_templates: [],
  steamid_bans: [],
  performance_history: [],
  bridge_logs: [],
  discord_webhooks: [],
  users: [],
  roles: [],
  settings: {},
  _schemaVersion: 1,
};

// ============================================
// Schema Migrations
// ============================================

const CURRENT_SCHEMA_VERSION = 3;

// Migration 2 seed: a SNAPSHOT of what every requireRole(...) call site in
// the app actually granted at the moment this migration was written --
// upgrade day must be a zero-behaviour-change event, so this seed follows
// reality rather than making policy. Kept as its own local copy rather than
// imported from services/permissions.js's DEFAULT_ROLE_CAPABILITIES to
// avoid a circular import between this file and that one (permissions.js
// imports getDb/getRoles/etc. from here); server/tests/
// rolesMigrationMatchesSeed.test.js asserts the two copies stay identical,
// so a future edit to one that isn't mirrored to the other fails loudly
// instead of silently drifting.
const MIGRATION_V2_TECHNICIAN_CAPABILITIES = [
  "backups.manage",
  "backups.download",
  "server.control",
  "server.install",
  "server.configure",
  "server.world_events",
  "rcon.execute",
  "servers.manage",
  "templates.manage",
  "bridge.setup",
  "bridge.diagnostics",
  "players.moderate",
  "players.gm_tools",
  "players.view",
  "mods.manage",
  "automation.manage",
  "integrations.manage",
  "docker.manage",
  "chunks.manage",
  "serverfiles.manage",
];
const MIGRATION_V2_MODERATOR_CAPABILITIES = [
  "players.moderate",
  "players.gm_tools",
  "players.view",
  "server.world_events",
];
const MIGRATION_V2_ADMIN_CAPABILITIES = [
  "users.manage",
  "roles.manage",
  "backups.manage",
  "backups.download",
  "backups.restore",
  "server.control",
  "server.install",
  "server.configure",
  "server.wipe",
  "server.world_events",
  "rcon.execute",
  "servers.manage",
  "servers.discover",
  "templates.manage",
  "bridge.setup",
  "bridge.diagnostics",
  "bridge.command",
  "players.moderate",
  "players.gm_tools",
  "players.view",
  "players.endanger_or_impersonate",
  "mods.manage",
  "automation.manage",
  "integrations.manage",
  "docker.manage",
  "chunks.manage",
  "serverfiles.manage",
  "diagnostics.manage",
  "panel.settings",
];

/**
 * Run any pending schema migrations.
 * Add new migrations as sequential `if (version < N)` blocks.
 * Each migration must be idempotent — safe to re-run if the write after
 * bumping the version failed.
 * Exported for direct testing against a plain object (see
 * server/tests/rolesMigration.test.js) -- getDb()'s dataDir is resolved
 * once from paths.config.json and memoized process-wide (see
 * vitest.globalSetup.mjs), so exercising a specific pre-migration db.json
 * through the real getDb() singleton isn't practical from an individual
 * test file; this function has no I/O of its own and needs none of that.
 */
export function runMigrations(data) {
  const version = data._schemaVersion || 0;
  if (version >= CURRENT_SCHEMA_VERSION) return data;

  log.info(`Running DB migrations: v${version} → v${CURRENT_SCHEMA_VERSION}`);

  // Migration 1: stamp initial schema version (no data changes needed)

  if (version < 2) {
    if (!data.roles) data.roles = [];

    const seedRole = (id, name, capabilities) => {
      if (data.roles.some((r) => r.id === id)) return; // idempotent re-run
      data.roles.push({
        id,
        name,
        capabilities: [...capabilities],
        isSeeded: true,
        createdAt: new Date().toISOString(),
      });
    };
    seedRole("role-admin", "admin", MIGRATION_V2_ADMIN_CAPABILITIES);
    seedRole("role-technician", "technician", MIGRATION_V2_TECHNICIAN_CAPABILITIES);
    seedRole("role-moderator", "moderator", MIGRATION_V2_MODERATOR_CAPABILITIES);

    // Dual-write: set roleId alongside the existing role string, which
    // stays untouched and remains what requirePermission() resolves
    // against today (see services/permissions.js). roleId is forward
    // compatible for when auth.js's request-auth path starts resolving by
    // id instead of by name -- not read by anything yet.
    const roleIdByName = Object.fromEntries(data.roles.map((r) => [r.name, r.id]));
    for (const user of data.users || []) {
      if (!user.roleId && roleIdByName[user.role]) {
        user.roleId = roleIdByName[user.role];
      }
    }
  }

  // Migration 3: backups.download was split out of backups.manage after
  // GET /api/backup/download/:name went from having no gate at all to
  // requiring its own capability (see routes/backup.js). The v2 seed
  // above already grants backups.download to a FRESH v1-install's admin
  // and technician roles directly, but that only helps an install that
  // migrates today -- an install that already passed through v2 before
  // this split existed has its roles frozen at whatever v2 seeded them
  // with, and never re-runs that step. Without this, every existing
  // technician role would silently lose an ability it already had
  // (the route was unguarded, so it could always download) the moment
  // this build shipped, with no explanation and nothing to click.
  // Backfill rule, applied uniformly to every role -- seeded or a custom
  // one an operator built themselves, since both are equally "existed
  // before the split": whatever already held backups.manage keeps the
  // same trust level it always had by also getting backups.download.
  // Anything that never held backups.manage (a bare custom role, or
  // moderator) gets nothing here -- that gap is the fix Finding 2 asked
  // for, not a bug in this migration.
  if (version < 3) {
    for (const role of data.roles || []) {
      if (
        Array.isArray(role.capabilities) &&
        role.capabilities.includes("backups.manage") &&
        !role.capabilities.includes("backups.download")
      ) {
        role.capabilities.push("backups.download");
      }
    }
  }

  data._schemaVersion = CURRENT_SCHEMA_VERSION;
  log.info(`DB migrated to schema v${CURRENT_SCHEMA_VERSION}`);
  return data;
}

// ============================================
// Write Queue (debounced, crash-safe)
// ============================================

let db = null;
let _writeTimer = null;
let _writePromise = null;
let _dirty = false;
let _writeRetries = 0;
const MAX_WRITE_RETRIES = 5;
// Exponential backoff between failed flushes: 1s, 2s, 4s, 8s, 16s (capped).
const WRITE_BACKOFF_BASE_MS = 1000;
const WRITE_BACKOFF_MAX_MS = 16_000;
// Circuit breaker: once tripped, refuse to schedule further writes for a cooldown.
let _writeCircuitOpenUntil = 0;
const CIRCUIT_OPEN_MS = 60_000;
// State surfaced read-only via getCircuitBreakerStatus() below — purely
// observational, never read by the write path itself, so adding these
// doesn't change any circuit-breaker behavior.
let _lastWriteError = null;
let _circuitFailCount = 0;
let _backupTimer = null;
let _shutdownRegistered = false;

/**
 * Mark the database as dirty and schedule a debounced write.
 * Multiple rapid mutations coalesce into a single disk write.
 */
function scheduleWrite() {
  _dirty = true;

  // Circuit breaker: if recent writes have been failing hard, defer.
  if (Date.now() < _writeCircuitOpenUntil) return;

  // If there's already a pending timer, let it handle the write
  if (_writeTimer) return;

  // Apply exponential backoff if we're currently retrying after failures.
  const delay =
    _writeRetries > 0
      ? Math.min(
          WRITE_BACKOFF_BASE_MS * Math.pow(2, _writeRetries - 1),
          WRITE_BACKOFF_MAX_MS,
        )
      : WRITE_DEBOUNCE_MS;

  _writeTimer = setTimeout(async () => {
    _writeTimer = null;
    await flushWrites();
  }, delay);
}

/**
 * Immediately flush all pending writes to disk.
 * Safe to call multiple times — deduplicates concurrent flushes.
 */
export async function flushWrites() {
  if (!_dirty || !db) return;
  _dirty = false;

  // If a write is already in progress, chain after it
  if (_writePromise) {
    try {
      await _writePromise;
    } catch {
      /* swallow */
    }
  }

  // Declared outside the try block (rather than `const` inside it, its
  // original scope) purely so the catch block below can reference the tmp
  // path a failed rename leaves behind -- same value, same assignment
  // point, not a behavior change to the write itself. tmpWriteSucceeded
  // narrows the catch block's cleanup to specifically a failed RENAME (the
  // diagnosed live leak: a complete, valid tmp file with nowhere to go) --
  // NOT a failed writeFileSync, which linuxDbFileModes.test.js's own crash
  // fault-injection deliberately leaves in place as forensic proof its
  // interception actually engaged (a half-written, invalid-JSON casualty
  // file). Cleaning up an INTENTIONALLY-preserved half-write would silence
  // that test's own positive control -- this fix targets the complete-tmp
  // leak that was actually observed live, not every possible failure.
  let tmpPath;
  let tmpWriteSucceeded = false;
  _writePromise = (async () => {
    try {
      // Atomic write: write to temp file first, then rename
      // This prevents corruption on NFS/SMB mounts or if process is killed mid-write
      // mode 0o600 — db.json still holds bcrypt password hashes and other
      // settings that don't warrant world-readability, even though the JWT
      // secret, rconPassword, and the Discord/Steam credentials have all
      // moved to their own files (see the dataDir comment above).
      // We chmod the tmp file BEFORE rename because writeFileSync's `mode` option
      // is ignored when the file already exists (e.g. orphaned tmp from prior crash).
      // Unique tmp name per write — when two panel instances overlap (e.g.
      // systemd restart racing the previous process's shutdown), a shared
      // `.tmp` suffix causes the second rename to fail with ENOENT after the
      // first instance consumed it. PID + random suffix isolates them.
      tmpPath = `${dbPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      // rconPassword (per server, plus the legacy settings mirror) is
      // persisted to its own file and stripped from what actually lands on
      // disk here — see utils/serverRconSecrets.js. db.data itself is
      // never mutated by this call, only the object being serialized.
      const data = JSON.stringify(
        redactPanelBridgeSftpPasswordForWrite(redactRconSecretsForWrite(db.data)),
        null,
        2,
      );
      fs.writeFileSync(tmpPath, data, { encoding: "utf-8", mode: 0o600 });
      tmpWriteSucceeded = true;
      try {
        fs.chmodSync(tmpPath, 0o600);
      } catch (_) {
        /* best-effort: Windows */
      }
      fs.renameSync(tmpPath, dbPath);
      _writeRetries = 0; // Reset on success
      _lastWriteError = null;
      _circuitFailCount = 0;
      log.debug(`DB flushed (${Math.round(data.length / 1024)}KB)`);
    } catch (err) {
      // Best-effort cleanup of THIS attempt's own tmp file (same pattern as
      // writeFileAtomic/cleanupOrphanBackupTemps) -- a failed rename left it
      // behind, and nothing else will ever clean it up while this process
      // stays alive: sweepOrphanedTmpFiles() is deliberately dead-pid-only,
      // so a live process's own retry loop leaking one tmp per failure was
      // previously unbounded for as long as renames kept failing. Isolated
      // in its own try/catch that swallows everything, INCLUDING an error
      // from the unlink itself (e.g. the same contention that just failed
      // the rename) -- this must never be able to skip or alter anything
      // below it. A tidied-up temp file is not worth the retry counter, the
      // backoff, or the circuit breaker that feeds the operator-facing
      // storage-health banner.
      if (tmpWriteSucceeded) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          /* best-effort -- may not exist, may be locked by the same contention that failed the rename */
        }
      }
      _writeRetries++;
      _lastWriteError = err.message;
      if (_writeRetries >= MAX_WRITE_RETRIES) {
        log.error(
          `DB write failed ${_writeRetries} times, opening circuit breaker for ${CIRCUIT_OPEN_MS / 1000}s: ${err.message}`,
        );
        // Open the circuit — stop scheduling writes for a cooldown so we don't pin the event loop.
        _circuitFailCount = _writeRetries;
        _writeCircuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
        _writeRetries = 0;
        _dirty = true; // Keep dirty; next scheduleWrite after cooldown will retry.
      } else {
        log.error(
          `Write error (attempt ${_writeRetries}/${MAX_WRITE_RETRIES}): ${err.message}`,
        );
        _dirty = true; // Re-mark dirty so next scheduleWrite retries (with backoff)
        // Proactively schedule a retry so we don't depend on external scheduleWrite calls.
        if (!_writeTimer) {
          const delay = Math.min(
            WRITE_BACKOFF_BASE_MS * Math.pow(2, _writeRetries - 1),
            WRITE_BACKOFF_MAX_MS,
          );
          _writeTimer = setTimeout(async () => {
            _writeTimer = null;
            await flushWrites();
          }, delay);
        }
      }
    }
  })();

  await _writePromise;
  _writePromise = null;
}

/**
 * Read-only snapshot of the write circuit breaker's current state, for
 * surfacing storage health to the UI. `failCount` reflects the consecutive
 * failures that most recently tripped the breaker while it's open (the
 * write path resets its own retry counter on open — see flushWrites above),
 * and the live retry count once it's closed again.
 */
export function getCircuitBreakerStatus() {
  const open = Date.now() < _writeCircuitOpenUntil;
  return {
    open,
    lastError: _lastWriteError,
    failCount: open ? _circuitFailCount : _writeRetries,
    cooldownEndsAt: open
      ? new Date(_writeCircuitOpenUntil).toISOString()
      : null,
  };
}

/**
 * Immediately persist the in-memory DB to disk, bypassing the debounce timer.
 *
 * `db.write()` (lowdb's default) does a plain, non-atomic `writeFile` straight
 * onto `db.json` — no temp-file+rename, no retry/circuit-breaker, and no
 * coordination with the debounced `flushWrites()` above. Calling it directly
 * (as some routes/services used to) risks corrupting `db.json` on a crash
 * mid-write, and can race a concurrent debounced flush clobbering each other.
 * Use this instead of `db.write()` anywhere a write needs to land on disk
 * right away (e.g. auth: password/session changes, JWT secret) — it reuses
 * the same atomic temp-file+rename path as the debounced writer.
 */
export async function commitNow() {
  _dirty = true;
  await flushWrites();
}

// ============================================
// Orphaned Temp File Cleanup
// ============================================

// A hard kill between writeFileSync and the rename in flushWrites() above
// leaves `db.json.<pid>.<rand>.tmp` behind forever — a complete copy of
// what flushWrites() serializes (the JWT secret, rconPassword and the
// Discord/Steam credentials are already redacted out of that by this
// point, but bcrypt password hashes and other settings are still in
// there). Nothing else reads or removes these, so an unswept crash leaks
// that file indefinitely.
const TMP_FILE_RE = /^db\.json\.(\d+)\.[0-9a-z]+\.tmp$/i;

// Extra margin beyond pid-liveness before a tmp file is touched: no real
// write of this file takes anywhere near this long, so a file this old
// cannot still be an in-progress write even in a pid-reuse edge case.
// Belt-and-suspenders alongside the pid check below, not a substitute for it.
const MIN_ORPHAN_AGE_MS = 60_000;

/**
 * Remove orphaned write-temp files left by a crash, but only ones provably
 * dead. Two panel processes can legitimately share a data dir for a moment
 * during a restart — that's exactly why the tmp name is pid-qualified — so
 * deleting one out from under a still-writing process would turn a harmless
 * leak into the rename-ENOENT crash pidLock.js exists to prevent. If either
 * check can't establish a file is safe to remove, it is left alone: an
 * orphaned file is far cheaper than a corrupted write.
 */
export function sweepOrphanedTmpFiles() {
  let entries;
  try {
    entries = fs.readdirSync(dataDir);
  } catch (err) {
    log.debug(`Tmp sweep: could not read ${dataDir}: ${err.message}`);
    return;
  }

  for (const name of entries) {
    const match = TMP_FILE_RE.exec(name);
    if (!match) continue;

    const pid = parseInt(match[1], 10);
    if (isPidAlive(pid)) continue; // may still be mid-write — leave it

    const filePath = path.join(dataDir, name);
    try {
      const stat = fs.statSync(filePath);
      if (Date.now() - stat.mtimeMs < MIN_ORPHAN_AGE_MS) continue; // too fresh to be sure
      fs.unlinkSync(filePath);
      log.warn(`Removed orphaned tmp file from dead pid ${pid}: ${name}`);
    } catch (err) {
      log.debug(`Tmp sweep: could not inspect/remove ${name}: ${err.message}`);
    }
  }
}

// ============================================
// Backup System
// ============================================

function createBackup(label = "") {
  try {
    if (!fs.existsSync(dbPath)) return null;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const suffix = label ? `-${label}` : "";
    // Same collision-suffix convention as utils/configBackup.js's
    // createBackup() (2026-08-27/29 fix, "backups: the pruner still deletes
    // the newest backup on Linux") -- toISOString() is millisecond-
    // resolution, and several backups created in a tight loop (an
    // automation script, or simply no real disk latency between calls) can
    // land in the exact same millisecond. Without this, that collision
    // produces the IDENTICAL filename and fs.copyFileSync silently
    // OVERWRITES the earlier backup -- reported success:true on both calls,
    // no error, no warning, earlier backup unrecoverably gone. This exact
    // ring never got the fix configBackup.js's already did: reproduced live
    // (2026-09-05, backup-restore-round-trip hunt), a plain sequential
    // 8-call loop with no concurrency at all collided repeatedly on real
    // Linux (WSL/ext4), losing several of the 8 backups before pruning ever
    // ran. -2, -3, ... on an actual collision; the first backup at a given
    // (timestamp, label) keeps the old, unsuffixed name. pruneBackups()/
    // listBackupsNewestFirst() below are updated to parse and sort by this
    // suffix too -- a raw string sort would put "-2.json" before ".json"
    // ('-' < '.'), the same misordering configBackup.js's pruner had before
    // its own fix.
    let backupFile = path.join(backupDir, `db-${timestamp}${suffix}.json`);
    for (let collision = 2; fs.existsSync(backupFile); collision++) {
      backupFile = path.join(
        backupDir,
        `db-${timestamp}${suffix}-${collision}.json`,
      );
    }

    fs.copyFileSync(dbPath, backupFile);
    // Backups contain the same secrets as db.json — tighten perms.
    try {
      fs.chmodSync(backupFile, 0o600);
    } catch (_) {
      /* best-effort: Windows */
    }
    pruneBackups();
    return backupFile;
  } catch (err) {
    log.error(`Backup failed: ${err.message}`);
    return null;
  }
}

// Same (timestampKey, collisionSuffix)-parsing convention as
// utils/configBackup.js's listBackupsFor()/parseBackupName() -- see
// createBackup()'s own comment above for why a raw filename string sort
// isn't safe here: "-2.json" sorts BEFORE ".json" ('-' < '.'), which would
// treat a collision's later duplicate as older than the original it
// collided with. Collision suffixes are always digits and neither the
// timestamp (always ends in literal "Z") nor any real label
// (auto/manual/startup/shutdown, always alphabetic) can produce a trailing
// all-digit segment, so a plain trailing "-<digits>" is unambiguous.
const BACKUP_COLLISION_SUFFIX_RE = /^(.*)-(\d+)$/;

function sortBackupFilenamesNewestFirst(filenames) {
  return filenames
    .map((name) => {
      const withoutExt = name.slice(0, -".json".length);
      const match = withoutExt.match(BACKUP_COLLISION_SUFFIX_RE);
      return match
        ? { name, key: match[1], suffix: parseInt(match[2], 10) }
        : { name, key: withoutExt, suffix: 1 };
    })
    .sort((a, b) => {
      if (a.key !== b.key) return a.key < b.key ? 1 : -1; // newest first
      return b.suffix - a.suffix; // higher collision suffix = created later
    })
    .map((c) => c.name);
}

function pruneBackups() {
  try {
    const files = sortBackupFilenamesNewestFirst(
      fs
        .readdirSync(backupDir)
        .filter((f) => f.startsWith("db-") && f.endsWith(".json")),
    );

    for (const file of files.slice(MAX_BACKUPS)) {
      fs.unlinkSync(path.join(backupDir, file));
    }
  } catch (err) {
    log.debug(`Backup pruning error: ${err.message}`);
  }
}

// Newest-first, full paths. Recovery below needs to fall through past a
// corrupt "latest" backup to the next-older one rather than giving up --
// see the recovery loop in getDb() for why a single bad candidate must not
// mean the whole ring is abandoned.
function listBackupsNewestFirst() {
  try {
    const files = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith("db-") && f.endsWith(".json"));
    return sortBackupFilenamesNewestFirst(files).map((f) =>
      path.join(backupDir, f),
    );
  } catch {
    log.debug(`No backups found to list`);
    return [];
  }
}

function startBackupSchedule() {
  if (_backupTimer) clearInterval(_backupTimer);
  _backupTimer = setInterval(async () => {
    // Flush any pending debounced write first -- createBackup() copies
    // whatever is CURRENTLY ON DISK via fs.copyFileSync, which does not see
    // an in-memory change until scheduleWrite()'s up-to-500ms (or longer,
    // under write-retry backoff) debounce actually lands. Without this, an
    // auto-backup landing inside that window silently omits the change that
    // triggered it -- see createDatabaseBackup()'s identical fix below and
    // its comment for the full reasoning (2026-09-05, backup-restore-round-trip
    // hunt: proven with vi.setSystemTime(), not just read).
    await flushWrites();
    createBackup("auto");
  }, BACKUP_INTERVAL_MS);
  if (_backupTimer.unref) _backupTimer.unref();
}

// ============================================
// Graceful Shutdown
// ============================================

// A running process's flushWrites() failure is fine to leave for later: it
// re-marks _dirty and schedules its own setTimeout retry, and the process
// will still be alive when that timer fires. A process that is EXITING is
// not still going to be alive for that timer -- index.js's gracefulShutdown()
// calls httpServer.close(() => process.exit(0)) on its own, independent
// SIGTERM/SIGINT listener, unsynchronized with this module's shutdown()
// below, and with no lingering connections (the normal case on a clean
// stop) that close() callback can fire before even flushWrites()'s own 1s
// minimum backoff elapses -- abandoning the scheduled retry and silently
// dropping whatever config change was still pending. flushForShutdown()
// exists so a caller that is about to exit can wait out a few real retries
// instead of relying on a timer that will never get to fire, bounded so a
// write that can never succeed (e.g. a full disk) turns into "shutdown
// proceeds anyway after a short, fixed wait", never "shutdown never
// happens" -- matching this file's own existing tradeoff for a failed
// write (log and move on, don't hang the process) rather than inventing a
// new one.
const SHUTDOWN_FLUSH_MAX_ATTEMPTS = 3;
const SHUTDOWN_FLUSH_RETRY_DELAY_MS = 200;

export async function flushForShutdown() {
  if (_writeTimer) {
    clearTimeout(_writeTimer);
    _writeTimer = null;
  }
  for (let attempt = 1; attempt <= SHUTDOWN_FLUSH_MAX_ATTEMPTS; attempt++) {
    await flushWrites();
    if (!_dirty) return true; // nothing pending, or this attempt landed it
    if (attempt < SHUTDOWN_FLUSH_MAX_ATTEMPTS) {
      await new Promise((resolve) =>
        setTimeout(resolve, SHUTDOWN_FLUSH_RETRY_DELAY_MS),
      );
    }
  }
  // Gave it real, waited-for retries and it's still failing -- give up and
  // let shutdown proceed. Whatever's pending stays only in memory; the
  // circuit-breaker/retry state flushWrites() already tracked is unchanged
  // by any of this, so the storage-health banner still reflects it.
  return !_dirty;
}

function registerShutdownHandlers() {
  if (_shutdownRegistered) return;
  _shutdownRegistered = true;

  const shutdown = async (signal) => {
    log.info(`${signal} received — flushing writes...`);
    if (_backupTimer) {
      clearInterval(_backupTimer);
      _backupTimer = null;
    }
    await flushForShutdown();
    createBackup("shutdown");
  };

  // Only flush writes — do NOT call process.exit() here.
  // The main index.js gracefulShutdown handler manages the exit sequence.
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("beforeExit", () => shutdown("beforeExit"));
}

// ============================================
// Startup & Initialization
// ============================================

/**
 * Validate and repair the database structure.
 * Ensures all collections exist and have the correct type.
 */
function validateData(data) {
  const repaired = { ...defaultData };
  // Collections that existed but had the WRONG TYPE (not merely absent) get
  // silently replaced with an empty default below. Since db.json is
  // hand-editable and can be restored from an older backup, a subtly
  // malformed file could otherwise quietly lose e.g. all `servers` or
  // `users` with no warning. Track what got replaced so we can log loudly
  // and snapshot the pre-repair file for forensics/recovery.
  const replacedKeys = [];

  for (const [key, defaultValue] of Object.entries(defaultData)) {
    if (Array.isArray(defaultValue)) {
      if (Array.isArray(data?.[key])) {
        repaired[key] = data[key];
      } else {
        repaired[key] = defaultValue;
        if (data?.[key] !== undefined) replacedKeys.push(key);
      }
    } else if (typeof defaultValue === "object" && defaultValue !== null) {
      if (
        typeof data?.[key] === "object" &&
        !Array.isArray(data?.[key]) &&
        data?.[key] !== null
      ) {
        repaired[key] = data[key];
      } else {
        repaired[key] = defaultValue;
        if (data?.[key] !== undefined) replacedKeys.push(key);
      }
    } else {
      repaired[key] = data?.[key] ?? defaultValue;
    }
  }

  if (replacedKeys.length > 0) {
    log.error(
      `DB validation found wrong-typed collection(s) and replaced them with empty defaults, discarding their contents: ${replacedKeys.join(", ")}`,
    );
    try {
      const snapshotPath = path.join(
        backupDir,
        `pre-repair-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );
      fs.writeFileSync(snapshotPath, JSON.stringify(data, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      log.warn(
        `Saved a snapshot of the pre-repair file for recovery: ${snapshotPath}`,
      );
    } catch (snapErr) {
      log.error(`Could not snapshot pre-repair data: ${snapErr.message}`);
    }
  }

  return repaired;
}

/**
 * Append an item to a size-capped collection.
 *
 * This DB layer uses two conventions depending on how a collection is
 * consumed: `newest: true` (default) unshifts the new item to the front and
 * caps by dropping from the end — used by command_history, bridge_logs,
 * player_logs, server_events, schedule_history, all of whose readers do
 * `.slice(0, limit)` expecting newest-first order. `newest: false` pushes to
 * the end and caps by dropping from the front — used by
 * performance_history, whose reader does `.slice(-limit)` expecting
 * chronological (oldest-first) order for charts. The two conventions aren't
 * interchangeable (see B18 in the backend audit) — this single helper
 * replaces what used to be hand-rolled unshift/push+slice at each call site,
 * so any new capped collection has one obvious place to reach for instead of
 * re-deriving the pattern.
 */
function appendCapped(arr, item, max, { newest = true } = {}) {
  if (newest) {
    arr.unshift(item);
    if (arr.length > max) arr.length = max;
  } else {
    arr.push(item);
    if (arr.length > max) arr.splice(0, arr.length - max);
  }
  return arr;
}

/**
 * Apply retention policies to trim oversized collections.
 */
function compactData(data) {
  const trimArray = (arr, max) => {
    if (Array.isArray(arr) && arr.length > max) return arr.slice(0, max);
    return arr;
  };
  const trimArrayEnd = (arr, max) => {
    if (Array.isArray(arr) && arr.length > max) return arr.slice(-max);
    return arr;
  };

  data.command_history = trimArray(
    data.command_history,
    RETENTION.command_history,
  );
  data.player_logs = trimArray(data.player_logs, RETENTION.player_logs);
  data.server_events = trimArray(data.server_events, RETENTION.server_events);
  data.schedule_history = trimArray(
    data.schedule_history,
    RETENTION.schedule_history,
  );
  data.bridge_logs = trimArray(data.bridge_logs || [], RETENTION.bridge_logs);
  data.performance_history = trimArrayEnd(
    data.performance_history,
    RETENTION.performance_history,
  );

  if (Array.isArray(data.player_stats)) {
    for (const stat of data.player_stats) {
      if (
        Array.isArray(stat.sessions) &&
        stat.sessions.length > RETENTION.player_sessions
      ) {
        stat.sessions = stat.sessions.slice(0, RETENTION.player_sessions);
      }
    }
  }

  return data;
}

// Shared by both getDb() recovery triggers below (a corrupt-read AND a
// missing-file-beside-an-intact-ring) so the newest-first candidate walk
// exists in exactly one place. Assumes `db` is already constructed and
// mutates `db.data` in place via db.read() on success, same as its two
// former inline copies did.
async function attemptRecoveryFromBackups(backups) {
  for (const backup of backups) {
    log.warn(`Attempting recovery from ${path.basename(backup)}...`);
    try {
      fs.copyFileSync(backup, dbPath);
      await db.read();
      log.info(`Database recovery successful from ${path.basename(backup)}!`);
      return true;
    } catch (recoverErr) {
      log.error(
        `Recovery from ${path.basename(backup)} failed: ${recoverErr.message}`,
      );
    }
  }
  return false;
}

export async function getDb() {
  if (!db) {
    // Sweep secret-bearing tmp files orphaned by a prior crash before doing
    // anything else. See sweepOrphanedTmpFiles() above for the dead-pid rule.
    sweepOrphanedTmpFiles();

    // Tighten permissions on existing files left behind by prior installs that
    // wrote with the default umask (typically 0o644 on Linux). Idempotent.
    if (fs.existsSync(dbPath)) {
      try {
        fs.chmodSync(dbPath, 0o600);
      } catch (_) {
        /* best-effort: Windows */
      }
    }
    try {
      for (const f of fs.readdirSync(backupDir)) {
        if (f.startsWith("db-") && f.endsWith(".json")) {
          try {
            fs.chmodSync(path.join(backupDir, f), 0o600);
          } catch (_) {
            /* ignore */
          }
        }
      }
    } catch (_) {
      /* backupDir may not be readable yet on first run */
    }

    const adapter = new JSONFile(dbPath);
    db = new Low(adapter, defaultData);

    // Checked BEFORE db.read() -- a missing file and a genuinely-corrupt
    // one both need the recovery path below, but db.read() only THROWS for
    // the latter (lowdb's JSONFile adapter returns null for a missing file
    // and Low.read() quietly substitutes defaultData, no exception). See
    // the dbPathExistedBeforeRead check after the try/catch.
    const dbPathExistedBeforeRead = fs.existsSync(dbPath);

    let loadedCleanly = false;
    try {
      await db.read();
      loadedCleanly = true;
    } catch (err) {
      log.error(`Failed to read database: ${err.message}`);

      // A permission failure is NOT corruption -- it means db.json is still
      // sitting there, intact, just unreadable by this account (root-
      // first-run trap, 2026-08-29: dataDir/logsDir themselves can be
      // fine, pzuser-owned, while db.json specifically was recreated
      // root-owned by one stray sudo restart -- e.g. renameSync() below
      // silently self-heals ownership on its NEXT successful write, so a
      // dataDir-level check alone can look clean while db.json itself is
      // still blocked). Falling through to "no backup found, starting
      // fresh" here would silently discard a real, recoverable database
      // and replace it with empty defaults on the very next flush --
      // strictly worse than refusing to start. Refuse loudly instead.
      if (err.code === "EACCES" || err.code === "EPERM") {
        checkAndExitIfOwnershipBlocked([dataDir, dbPath, backupDir]);
        // Falls through only if checkAndExitIfOwnershipBlocked() found
        // every one of those paths genuinely readable/writable by THIS
        // process (fs.accessSync agrees) -- so db.read()'s EACCES/EPERM
        // came from something access() itself can't see (a permissions
        // change mid-flight between the check and the read, an exotic
        // mandatory-access-control layer, an immutable file attribute).
        // The existing corruption-recovery path below is still the right
        // fallback for that case.
      }

      // Preserve the corrupt file for forensics ONCE, before trying any
      // candidate or giving up entirely -- OUTSIDE the rotation ring so
      // pruneBackups never touches it. Runs regardless of whether a backup
      // ring exists to recover from -- it used to run only inside the
      // `backups.length > 0` branch below, so a corrupt db.json next to an
      // EMPTY ring hit the "no backup found" branch and had its only copy
      // silently overwritten by the fresh empty database a few lines down,
      // with zero forensic trace left anywhere (bug hunt 2026-09-05, sweep
      // item #4).
      try {
        const corruptPath = path.join(
          backupDir,
          `corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
        );
        fs.copyFileSync(dbPath, corruptPath);
        try {
          fs.chmodSync(corruptPath, 0o600);
        } catch (_) {
          /* best-effort */
        }
      } catch (_) {
        /* best-effort */
      }

      // Attempt recovery from backup, newest first, falling through to the
      // next-older candidate if one is also unreadable. A single corrupted
      // "latest" backup must not mean the whole ring is abandoned in favour
      // of a full reset -- pruneBackups only evicts past MAX_BACKUPS, so
      // several older, structurally-independent backups usually still exist
      // (2026-09-03, destructive-paths-sweep: the previous single-candidate
      // version fell straight to defaultData -- discarding every setting,
      // server and user -- the moment that one backup also failed to read,
      // even when an older good one was sitting right next to it).
      const backups = listBackupsNewestFirst();
      if (backups.length > 0) {
        const recovered = await attemptRecoveryFromBackups(backups);
        if (!recovered) {
          log.error("All backups failed to recover — starting fresh");
          db.data = { ...defaultData };
        }
      } else {
        log.warn("No backup found, starting with fresh database.");
        db.data = { ...defaultData };
      }
    }

    // A missing db.json is NOT a fresh install if an intact backup ring
    // exists right next to it. db.read() above does not throw for a
    // missing file (see dbPathExistedBeforeRead's comment), so this used to
    // look identical to a genuine first boot and silently keep empty
    // defaultData -- the "startup" snapshot a few lines below then
    // persisted that empty state into the SAME backup ring, and
    // pruneBackups() eventually rotated the real, recoverable backups out
    // in favour of it. bug hunt 2026-09-05 (sweep item #3): the recovery
    // path destroyed what it should have recovered from. Reaches the exact
    // same newest-first candidate walk the corrupt-read branch above uses,
    // just triggered by a different signal (file absent, not unreadable).
    if (loadedCleanly && !dbPathExistedBeforeRead) {
      const backups = listBackupsNewestFirst();
      if (backups.length > 0) {
        log.warn(
          "db.json is missing but an existing backup ring was found — recovering from backup instead of starting fresh.",
        );
        const recovered = await attemptRecoveryFromBackups(backups);
        if (!recovered) {
          log.error("All backups failed to recover — starting fresh");
          db.data = { ...defaultData };
        }
      }
    }

    // Validate structure and compact
    db.data = validateData(db.data);
    db.data = runMigrations(db.data);
    db.data = compactData(db.data);
    // Runs on EVERY load, unlike runMigrations() above (schema-version
    // gated, only ever runs once) — db.json itself never carries
    // rconPassword again once a single write has happened, so it has to be
    // re-attached in memory on every restart, not just once at an upgrade.
    db.data = rehydrateRconSecrets(db.data, log);
    db.data = rehydratePanelBridgeSftpPassword(db.data, log);

    // Use the atomic tmp+rename path instead of lowdb's non-atomic
    // adapter.write(). A crash during the startup write would otherwise
    // corrupt the file we just recovered/migrated.
    _dirty = true;
    await flushWrites();

    // Snapshot only AFTER the DB loaded and wrote successfully. This prevents
    // a corrupt file from being captured as a "good" backup at boot.
    if (loadedCleanly && fs.existsSync(dbPath)) {
      createBackup("startup");
    }

    // Start periodic backups and register shutdown handlers
    startBackupSchedule();
    registerShutdownHandlers();

    const stats = getDatabaseStatsSync();
    log.info(
      `Loaded — ${stats.totalRecords} records, ${stats.fileSizeKB}KB, ${stats.backupCount} backups`,
    );
  }
  return db;
}

export async function initDatabase() {
  await getDb();
  return db;
}

// ============================================
// Database Health & Stats
// ============================================

function getDatabaseStatsSync() {
  const data = db?.data || defaultData;
  let fileSize = 0;
  try {
    fileSize = fs.statSync(dbPath).size;
  } catch (e) {
    log.debug(`DB file stat failed (may not exist yet): ${e.message}`);
  }

  let backupCount = 0;
  try {
    backupCount = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith("db-") && f.endsWith(".json")).length;
  } catch (e) {
    log.debug(`Backup dir read failed: ${e.message}`);
  }

  return {
    fileSizeBytes: fileSize,
    fileSizeKB: Math.round((fileSize / 1024) * 10) / 10,
    backupCount,
    collections: {
      command_history: data.command_history?.length ?? 0,
      scheduled_tasks: data.scheduled_tasks?.length ?? 0,
      schedule_history: data.schedule_history?.length ?? 0,
      player_logs: data.player_logs?.length ?? 0,
      server_events: data.server_events?.length ?? 0,
      tracked_mods: data.tracked_mods?.length ?? 0,
      servers: data.servers?.length ?? 0,
      player_notes: data.player_notes?.length ?? 0,
      player_stats: data.player_stats?.length ?? 0,
      mod_presets: data.mod_presets?.length ?? 0,
      user_templates: data.user_templates?.length ?? 0,
      performance_history: data.performance_history?.length ?? 0,
      bridge_logs: data.bridge_logs?.length ?? 0,
      discord_webhooks: data.discord_webhooks?.length ?? 0,
    },
    totalRecords: Object.values(data).reduce(
      (sum, v) => sum + (Array.isArray(v) ? v.length : 0),
      0,
    ),
    settingsCount: Object.keys(data.settings || {}).length,
  };
}

export async function getDatabaseStats() {
  await getDb();
  return getDatabaseStatsSync();
}

export async function createDatabaseBackup() {
  // createBackup() copies whatever is CURRENTLY ON DISK (fs.copyFileSync) --
  // it has no visibility into db.data or the pending debounced write
  // scheduleWrite() may have queued (WRITE_DEBOUNCE_MS=500, longer under
  // retry backoff). Proven live (2026-09-05, backup-restore-round-trip
  // hunt): setSetting() then an immediate createDatabaseBackup() call, with
  // no flush between them, snapshotted db.json with settings STILL EMPTY --
  // reported success:true, with no warning that the change just made wasn't
  // in it. flushForShutdown()'s shutdown handler already gets this right
  // (flushes before its own createBackup("shutdown") call, see
  // registerShutdownHandlers above); this path never did.
  await flushWrites();
  const file = createBackup("manual");
  return file
    ? { success: true, file: path.basename(file) }
    : { success: false };
}

export async function compactDatabase() {
  const db = await getDb();
  const before = getDatabaseStatsSync();
  db.data = compactData(db.data);
  scheduleWrite();
  await flushWrites();
  const after = getDatabaseStatsSync();
  return {
    before: before.totalRecords,
    after: after.totalRecords,
    removed: before.totalRecords - after.totalRecords,
  };
}

// ============================================
// ID Generation
// ============================================

function generateId() {
  return randomUUID();
}

function generateNumericId(collection) {
  const maxExisting = Array.isArray(collection)
    ? collection.reduce(
        (max, item) => Math.max(max, typeof item.id === "number" ? item.id : 0),
        0,
      )
    : 0;
  // Date.now() as a floor guarantees the new id is always higher than any id
  // ever issued, even one that was later deleted. The old max(currentIds)+1
  // scheme only looked at IDs currently present, so deleting the
  // highest-numbered task and creating a new one reused that freed id —
  // which could then collide with a dangling schedule_history.task_id
  // reference to the deleted task. Date.now() is monotonic across process
  // restarts too, unlike the in-memory max.
  return Math.max(maxExisting + 1, Date.now());
}

// ============================================
// Command History
// ============================================

export async function logCommand(command, response, success = true) {
  const db = await getDb();
  // Redact BEFORE persisting, not on read -- see rconCommandRedaction.js
  // for what this catches and why. Applied to both fields: `command` is
  // the confirmed leak (adduser embeds the password directly), `response`
  // is defense-in-depth in case a verbose RCON reply ever echoes the
  // command it's replying to.
  const redactedCommand = redactRconCommandSecrets(command);
  const redactedResponse = redactRconCommandSecrets(response);
  const truncatedResponse =
    redactedResponse && redactedResponse.length > 4096
      ? redactedResponse.substring(0, 4096) + "... [truncated]"
      : redactedResponse;

  const entry = {
    id: generateId(),
    command: redactedCommand,
    response: truncatedResponse,
    success: success ? 1 : 0,
    executed_at: new Date().toISOString(),
  };

  appendCapped(db.data.command_history, entry, RETENTION.command_history);
  scheduleWrite();
  return entry;
}

export async function getCommandHistory(limit = 100) {
  const db = await getDb();
  const safeLimit = parseClampedInteger(limit, 100, 1, RETENTION.command_history);
  return db.data.command_history.slice(0, safeLimit);
}

// ============================================
// Bridge Logs (PanelBridge command history)
// ============================================

export async function logBridgeCommand(
  action,
  args,
  result,
  success = true,
  durationMs = 0,
) {
  const db = await getDb();
  if (!db.data.bridge_logs) db.data.bridge_logs = [];

  const truncatedResult = (() => {
    try {
      const s = JSON.stringify(result);
      return s && s.length > 4096
        ? JSON.parse(s.substring(0, 4096) + '..."}}')
        : result;
    } catch {
      return { truncated: true };
    }
  })();

  const entry = {
    id: generateId(),
    action,
    args: args || {},
    result: truncatedResult,
    success: success ? 1 : 0,
    duration_ms: durationMs,
    executed_at: new Date().toISOString(),
  };

  appendCapped(db.data.bridge_logs, entry, RETENTION.bridge_logs);
  scheduleWrite();
  return entry;
}

export async function getBridgeLogs(limit = 100) {
  const db = await getDb();
  if (!db.data.bridge_logs) return [];
  const safeLimit = parseClampedInteger(limit, 100, 1, RETENTION.bridge_logs);
  return db.data.bridge_logs.slice(0, safeLimit);
}

// ============================================
// Scheduled Tasks
// ============================================

// Returns ALL scheduled tasks across every server, unfiltered — the
// Scheduler needs to register a cron job for every task on startup
// regardless of which server is currently active in the UI. Callers that
// want to display/scope by server (the Scheduler UI) filter client-side
// using each task's server_id.
export async function getScheduledTasks() {
  const db = await getDb();
  const tasks = db.data.scheduled_tasks || [];

  // Legacy migration: a task saved before server_id existed gets the
  // currently-active server as a best guess (matches how it already
  // behaved — it always ran against whatever was active).
  const activeServerId = await getActiveServerId();
  if (activeServerId) {
    let migrated = false;
    for (const task of tasks) {
      if (!task.server_id) {
        task.server_id = activeServerId;
        migrated = true;
      }
    }
    if (migrated) scheduleWrite();
  }

  return tasks;
}

export async function createScheduledTask(
  name,
  cronExpression,
  command,
  serverId = null,
) {
  const db = await getDb();
  if (!Array.isArray(db.data.scheduled_tasks)) db.data.scheduled_tasks = [];

  const resolvedServerId = serverId || (await getActiveServerId());

  const task = {
    id: generateNumericId(db.data.scheduled_tasks),
    name,
    cron_expression: cronExpression,
    command,
    server_id: resolvedServerId,
    enabled: 1,
    last_run: null,
    created_at: new Date().toISOString(),
  };

  db.data.scheduled_tasks.push(task);
  scheduleWrite();
  return task;
}

export async function updateScheduledTask(
  id,
  name,
  cronExpression,
  command,
  enabled,
  serverId,
) {
  const db = await getDb();
  const index = db.data.scheduled_tasks.findIndex((t) => t.id === id);
  if (index === -1) return null;

  const task = db.data.scheduled_tasks[index];
  if (name !== undefined) task.name = name;
  if (cronExpression !== undefined) task.cron_expression = cronExpression;
  if (command !== undefined) task.command = command;
  if (enabled !== undefined) task.enabled = enabled ? 1 : 0;
  if (serverId !== undefined) task.server_id = serverId;
  scheduleWrite();
  return task;
}

export async function deleteScheduledTask(id) {
  const db = await getDb();
  const index = db.data.scheduled_tasks.findIndex((t) => t.id === id);
  if (index === -1) return false;

  db.data.scheduled_tasks.splice(index, 1);
  scheduleWrite();
  return true;
}

export async function updateTaskLastRun(id) {
  const db = await getDb();
  const task = db.data.scheduled_tasks.find((t) => t.id === id);
  if (task) {
    task.last_run = new Date().toISOString();
    scheduleWrite();
  }
}

// ============================================
// Schedule History
// ============================================

export async function logScheduleExecution(
  taskId,
  taskName,
  command,
  success,
  message = null,
  duration = null,
) {
  const db = await getDb();
  if (!db.data.schedule_history) db.data.schedule_history = [];

  const entry = {
    id: generateId(),
    task_id: taskId,
    task_name: taskName,
    command,
    success: success ? 1 : 0,
    message,
    duration,
    executed_at: new Date().toISOString(),
  };

  appendCapped(db.data.schedule_history, entry, RETENTION.schedule_history);
  scheduleWrite();
  return entry;
}

export async function getScheduleHistory(limit = 100, taskId = null) {
  const db = await getDb();
  if (!db.data.schedule_history) return [];

  let history = db.data.schedule_history;
  if (taskId !== null) {
    history = history.filter((h) => h.task_id === taskId);
  }
  const safeLimit = parseClampedInteger(limit, 100, 1, RETENTION.schedule_history);
  return history.slice(0, safeLimit);
}

export async function clearScheduleHistory() {
  const db = await getDb();
  db.data.schedule_history = [];
  scheduleWrite();
}

/**
 * Newest schedule_history entry for a given `command` value (the third
 * argument to logScheduleExecution above) -- used by backupService.js to
 * surface whether the LAST scheduled attempt of a given kind succeeded.
 * getScheduleHistory()'s own taskId filter can't isolate this: the
 * scheduled backup job and auto-restart both log with taskId=null, so
 * filtering by taskId alone conflates them. schedule_history is
 * newest-first (see appendCapped's doc comment above), so the first match
 * is the most recent.
 */
export async function getLatestScheduleExecutionByCommand(command) {
  const db = await getDb();
  const history = db.data.schedule_history || [];
  return history.find((h) => h.command === command) || null;
}

// ============================================
// Player Logs
// ============================================

export async function logPlayerAction(playerName, action, details = null) {
  const db = await getDb();
  const entry = {
    id: generateId(),
    player_name: playerName,
    action,
    details,
    logged_at: new Date().toISOString(),
  };

  appendCapped(db.data.player_logs, entry, RETENTION.player_logs);
  scheduleWrite();
  return entry;
}

export async function getPlayerLogs(playerName = null, limit = 100) {
  const db = await getDb();
  let logs = db.data.player_logs;
  if (playerName) {
    logs = logs.filter((l) => l.player_name === playerName);
  }
  const safeLimit = parseClampedInteger(limit, 100, 1, RETENTION.player_logs);
  return logs.slice(0, safeLimit);
}

// ============================================
// Server Events
// ============================================

export async function logServerEvent(eventType, message = null) {
  // Several callers fire this without awaiting; an unhandled rejection here
  // reaches process.on("unhandledRejection") and kills the panel.
  try {
    const db = await getDb();
    const entry = {
      id: generateId(),
      event_type: eventType,
      message,
      created_at: new Date().toISOString(),
    };

    appendCapped(db.data.server_events, entry, RETENTION.server_events);
    scheduleWrite();
    return entry;
  } catch (error) {
    log.warn(`Could not record server event ${eventType}: ${error.message}`);
    return null;
  }
}

// ============================================
// Tracked Mods (per-server scoped)
// ============================================

/** Get the active server's ID for scoping tracked mods */
async function getActiveServerId() {
  const db = await getDb();
  const active = db.data.servers.find((s) => s.isActive) || db.data.servers[0];
  return active ? String(active.id) : null;
}

export async function getTrackedMods() {
  const db = await getDb();
  const serverId = await getActiveServerId();
  if (!serverId) return db.data.tracked_mods; // no servers yet → return all (legacy)
  return db.data.tracked_mods.filter((m) => m.server_id === serverId);
}

export async function addTrackedMod(workshopId, name = null) {
  const db = await getDb();
  const serverId = await getActiveServerId();
  // Duplicate check scoped to active server
  const existing = db.data.tracked_mods.find(
    (m) =>
      m.workshop_id === workshopId &&
      (m.server_id === serverId || !m.server_id),
  );
  if (existing) {
    existing.name = name || existing.name;
    if (!existing.server_id && serverId) existing.server_id = serverId; // migrate legacy
    scheduleWrite();
    return existing;
  }

  const mod = {
    id: generateId(),
    workshop_id: workshopId,
    name,
    server_id: serverId,
    last_updated: null,
    last_checked: null,
    update_available: 0,
    preview_url: null,
    created_at: new Date().toISOString(),
  };
  db.data.tracked_mods.push(mod);
  scheduleWrite();
  return mod;
}

export async function setModPreviewUrl(workshopId, previewUrl) {
  const db = await getDb();
  const serverId = await getActiveServerId();
  const mod = db.data.tracked_mods.find(
    (m) =>
      m.workshop_id === workshopId &&
      (m.server_id === serverId || !m.server_id),
  );
  if (mod && mod.preview_url !== previewUrl) {
    mod.preview_url = previewUrl || null;
    scheduleWrite();
  }
}

export async function updateModTimestamp(workshopId, lastUpdated) {
  const db = await getDb();
  const serverId = await getActiveServerId();
  const mod = db.data.tracked_mods.find(
    (m) =>
      m.workshop_id === workshopId &&
      (m.server_id === serverId || !m.server_id),
  );
  if (mod) {
    mod.last_updated = lastUpdated;
    mod.last_checked = new Date().toISOString();
    if (!mod.server_id && serverId) mod.server_id = serverId; // migrate legacy
    scheduleWrite();
  }
}

export async function setModUpdateAvailable(workshopId, available) {
  const db = await getDb();
  const serverId = await getActiveServerId();
  const mod = db.data.tracked_mods.find(
    (m) =>
      m.workshop_id === workshopId &&
      (m.server_id === serverId || !m.server_id),
  );
  if (mod) {
    mod.update_available = available ? 1 : 0;
    if (!mod.server_id && serverId) mod.server_id = serverId; // migrate legacy
    scheduleWrite();
  }
}

/**
 * Batch-mark mods as just-checked.
 * - Sets `last_checked = now()` for every workshop_id in `checkedIds`.
 * - Sets `update_available` from the `updatesById` map (workshopId -> 0|1).
 *   Mods present in `checkedIds` but not in `updatesById` are cleared (0).
 * - Mods not in `checkedIds` are left untouched (e.g. Steam API failures).
 */
export async function markModsChecked(checkedIds, updatesById = new Map()) {
  if (!checkedIds || checkedIds.size === 0) return;
  const db = await getDb();
  const serverId = await getActiveServerId();
  const now = new Date().toISOString();
  let touched = 0;
  for (const mod of db.data.tracked_mods) {
    if (mod.server_id !== serverId && mod.server_id) continue;
    if (!checkedIds.has(mod.workshop_id)) continue;
    mod.last_checked = now;
    mod.update_available = updatesById.get(mod.workshop_id) ? 1 : 0;
    if (!mod.server_id && serverId) mod.server_id = serverId; // migrate legacy
    touched++;
  }
  if (touched > 0) scheduleWrite();
}

export async function removeTrackedMod(workshopId) {
  const db = await getDb();
  const serverId = await getActiveServerId();
  const index = db.data.tracked_mods.findIndex(
    (m) =>
      m.workshop_id === workshopId &&
      (m.server_id === serverId || !m.server_id),
  );
  if (index === -1) return false;

  db.data.tracked_mods.splice(index, 1);
  scheduleWrite();
  return true;
}

export async function clearModUpdates() {
  const db = await getDb();
  const serverId = await getActiveServerId();
  db.data.tracked_mods.forEach((m) => {
    if (m.server_id === serverId || !m.server_id) {
      m.update_available = 0;
    }
  });
  scheduleWrite();
}

// ============================================
// Ignored Mods (prevent auto-re-tracking)
// ============================================

export async function getIgnoredMods() {
  const db = await getDb();
  if (!db.data.ignored_mods) db.data.ignored_mods = [];
  const serverId = await getActiveServerId();
  if (!serverId) return db.data.ignored_mods;
  return db.data.ignored_mods.filter(
    (m) => m.server_id === serverId || !m.server_id,
  );
}

export async function addIgnoredMod(workshopId, name = null) {
  const db = await getDb();
  if (!db.data.ignored_mods) db.data.ignored_mods = [];
  const serverId = await getActiveServerId();
  const existing = db.data.ignored_mods.find(
    (m) =>
      m.workshop_id === workshopId &&
      (m.server_id === serverId || !m.server_id),
  );
  if (existing) return existing;
  const entry = {
    workshop_id: workshopId,
    name,
    server_id: serverId,
    ignored_at: new Date().toISOString(),
  };
  db.data.ignored_mods.push(entry);
  scheduleWrite();
  return entry;
}

export async function removeIgnoredMod(workshopId) {
  const db = await getDb();
  if (!db.data.ignored_mods) db.data.ignored_mods = [];
  const serverId = await getActiveServerId();
  const index = db.data.ignored_mods.findIndex(
    (m) =>
      m.workshop_id === workshopId &&
      (m.server_id === serverId || !m.server_id),
  );
  if (index === -1) return false;
  db.data.ignored_mods.splice(index, 1);
  scheduleWrite();
  return true;
}

export async function clearAllIgnoredMods() {
  const db = await getDb();
  if (!db.data.ignored_mods) db.data.ignored_mods = [];
  const serverId = await getActiveServerId();
  const before = db.data.ignored_mods.length;
  db.data.ignored_mods = db.data.ignored_mods.filter(
    (m) => m.server_id && m.server_id !== serverId,
  );
  const removed = before - db.data.ignored_mods.length;
  if (removed > 0) scheduleWrite();
  return removed;
}

export async function isModIgnored(workshopId) {
  const db = await getDb();
  if (!db.data.ignored_mods) return false;
  const serverId = await getActiveServerId();
  return db.data.ignored_mods.some(
    (m) =>
      m.workshop_id === workshopId &&
      (m.server_id === serverId || !m.server_id),
  );
}

// ============================================
// Ignored Mod Conflict Pairs (false-positive dismissals on the
// Advanced tab's variant detector — e.g. a shared library + dependant
// being mis-flagged as two variants of the same mod).
// ============================================

function _normalizePair(modIdA, modIdB) {
  const a = String(modIdA || "").trim();
  const b = String(modIdB || "").trim();
  if (!a || !b || a === b) return null;
  return a < b ? [a, b] : [b, a];
}

export async function getIgnoredModPairs() {
  const db = await getDb();
  if (!db.data.ignored_mod_pairs) db.data.ignored_mod_pairs = [];
  const serverId = await getActiveServerId();
  if (!serverId) return db.data.ignored_mod_pairs;
  return db.data.ignored_mod_pairs.filter(
    (p) => p.server_id === serverId || !p.server_id,
  );
}

export async function addIgnoredModPair(modIdA, modIdB, reason = null) {
  const pair = _normalizePair(modIdA, modIdB);
  if (!pair) return null;
  const db = await getDb();
  if (!db.data.ignored_mod_pairs) db.data.ignored_mod_pairs = [];
  const serverId = await getActiveServerId();
  const existing = db.data.ignored_mod_pairs.find(
    (p) =>
      p.mod_a === pair[0] &&
      p.mod_b === pair[1] &&
      (p.server_id === serverId || !p.server_id),
  );
  if (existing) return existing;
  const entry = {
    mod_a: pair[0],
    mod_b: pair[1],
    reason: reason || null,
    server_id: serverId,
    ignored_at: new Date().toISOString(),
  };
  db.data.ignored_mod_pairs.push(entry);
  scheduleWrite();
  return entry;
}

export async function removeIgnoredModPair(modIdA, modIdB) {
  const pair = _normalizePair(modIdA, modIdB);
  if (!pair) return false;
  const db = await getDb();
  if (!db.data.ignored_mod_pairs) db.data.ignored_mod_pairs = [];
  const serverId = await getActiveServerId();
  const before = db.data.ignored_mod_pairs.length;
  db.data.ignored_mod_pairs = db.data.ignored_mod_pairs.filter(
    (p) =>
      !(
        p.mod_a === pair[0] &&
        p.mod_b === pair[1] &&
        (p.server_id === serverId || !p.server_id)
      ),
  );
  const removed = before - db.data.ignored_mod_pairs.length;
  if (removed > 0) scheduleWrite();
  return removed > 0;
}

// ============================================
// Settings
// ============================================

export async function getSetting(key) {
  const db = await getDb();
  return db.data.settings[key] ?? null;
}

export async function setSetting(key, value) {
  const db = await getDb();
  db.data.settings[key] = value;
  scheduleWrite();
}

export async function getAllSettings() {
  const db = await getDb();
  return db.data.settings;
}

// ============================================
// Server Configurations (Multi-server)
// ============================================

// Falls back to the docker-compose PZ_SERVER_PATH / PZ_SAVE_PATH env vars when
// a stored server profile has no path configured. isRemote is inferred from
// whether the resolved paths exist on this host ONLY for legacy records that
// predate the isRemote field (server.isRemote is genuinely undefined/null —
// every server created via POST /api/servers since 94c5520e always stores an
// explicit boolean). A stored isRemote, true or false, always wins: it is the
// operator's choice, and fs.existsSync() at read time is not — a local server
// whose install hasn't run yet (or whose drive is momentarily unmounted) must
// not be silently reclassified as remote on every read.
export function normalizeServerMemory(server) {
  if (!server) return server;
  const installPath = server.installPath || process.env.PZ_SERVER_PATH || "";
  const zomboidDataPath =
    server.zomboidDataPath || process.env.PZ_SAVE_PATH || null;

  const pathsConfigured = Boolean(installPath || zomboidDataPath);
  const pathsExistLocally =
    Boolean(installPath && fs.existsSync(installPath)) ||
    Boolean(zomboidDataPath && fs.existsSync(zomboidDataPath));
  const hasStoredIsRemote =
    server.isRemote !== undefined && server.isRemote !== null;

  return {
    ...server,
    installPath,
    zomboidDataPath,
    isRemote: hasStoredIsRemote
      ? server.isRemote
      : pathsConfigured
        ? !pathsExistLocally
        : false,
    lifecycleProvider: ["systemd", "openrc"].includes(server.lifecycleProvider)
      ? server.lifecycleProvider
      : "direct",
    minMemory: normalizeMemoryGb(server.minMemory, 4),
    maxMemory: normalizeMemoryGb(server.maxMemory, 8),
  };
}

export async function getServers() {
  const db = await getDb();
  return (db.data.servers || []).map(normalizeServerMemory);
}

export async function getServer(id) {
  const db = await getDb();
  return normalizeServerMemory(
    db.data.servers.find((s) => String(s.id) === String(id)) || null,
  );
}

export async function getActiveServer() {
  const db = await getDb();
  return normalizeServerMemory(
    db.data.servers.find((s) => s.isActive) || db.data.servers[0] || null,
  );
}

export async function createServer(serverConfig) {
  const db = await getDb();
  if (!db.data.servers) db.data.servers = [];

  const isFirst = db.data.servers.length === 0;

  const server = {
    id: generateId(),
    name: serverConfig.name || serverConfig.serverName,
    serverName: serverConfig.serverName,
    installPath: serverConfig.installPath || "",
    zomboidDataPath: serverConfig.zomboidDataPath || null,
    serverConfigPath: serverConfig.serverConfigPath || null,
    // Same class as adminPassword below, caught in the same pass: this
    // literal is missing anything not on its hardcoded list, silently, with
    // no error to notice by. servers.js's POST / forwards this correctly
    // (from the Add/Register Server dialog, not the SteamCMD wizard) -- a
    // Docker-managed server created that way never got its container name
    // persisted, which would have made every provider-aware fix elsewhere
    // in the app (the status badge, dashboard headline, sidebar dot) read a
    // container name that was never there.
    dockerContainerName: serverConfig.dockerContainerName || null,
    branch: serverConfig.branch || "stable",
    rconHost: serverConfig.rconHost || "127.0.0.1",
    rconPort: serverConfig.rconPort || 27015,
    rconPassword: serverConfig.rconPassword || "",
    serverPort: serverConfig.serverPort || 16261,
    minMemory: normalizeMemoryGb(serverConfig.minMemory, 4),
    maxMemory: normalizeMemoryGb(serverConfig.maxMemory, 8),
    useNoSteam: serverConfig.useNoSteam || false,
    useDebug: serverConfig.useDebug || false,
    // Same shape again: never on this list at all, and (per a same-night
    // audit of every wizard field) not even in ALLOWED_SERVER_UPDATE_FIELDS
    // or read anywhere server-side -- unlike adminPassword, there was no
    // edit-screen workaround for this one either, because there was no edit
    // path and no read path, only a write to a global legacy setting that
    // nothing consulted. Both closed together: this field now exists on the
    // record, servers.js's create/update routes both accept it, and
    // /install writes the actual UPnP= line into the server's own .ini
    // (what PZ itself reads), matching what /configure-network already did
    // for an existing server.
    useUpnp: serverConfig.useUpnp !== false,
    isRemote: serverConfig.isRemote || false,
    lifecycleProvider: "direct",
    startCommand: serverConfig.startCommand || "",
    // 2026-08-26, two real users: this field-by-field literal never named
    // adminPassword, so servers.js's POST / forwarding it correctly made no
    // difference -- it was dropped right here, on every single server ever
    // created through the panel. A brand-new server's admin account never
    // gets created because PZ never receives -adminpassword on first boot,
    // it falls back to prompting on a stdin the panel doesn't provide, and
    // the process dies before the world exists. updateServer() below never
    // had this bug (it spreads `updates` generically instead of naming
    // fields), which is why re-saving the admin password after the fact was
    // the only thing that ever worked.
    adminPassword: serverConfig.adminPassword || "",
    isActive: isFirst,
    createdAt: new Date().toISOString(),
  };

  db.data.servers.push(server);

  if (isFirst) {
    syncServerToSettings(db, server);
  }

  scheduleWrite();
  return normalizeServerMemory(server);
}

export async function updateServer(id, updates) {
  const db = await getDb();
  const index = db.data.servers.findIndex((s) => String(s.id) === String(id));
  if (index === -1) return null;

  db.data.servers[index] = {
    ...db.data.servers[index],
    ...updates,
    id,
    updatedAt: new Date().toISOString(),
  };
  db.data.servers[index].minMemory = normalizeMemoryGb(
    db.data.servers[index].minMemory,
    4,
  );
  db.data.servers[index].maxMemory = normalizeMemoryGb(
    db.data.servers[index].maxMemory,
    8,
  );
  scheduleWrite();
  return normalizeServerMemory(db.data.servers[index]);
}

export async function deleteServer(id) {
  const db = await getDb();
  const index = db.data.servers.findIndex((s) => String(s.id) === String(id));
  if (index === -1) return false;

  const wasActive = db.data.servers[index].isActive;
  const serverId = String(db.data.servers[index].id);
  db.data.servers.splice(index, 1);

  // Clean up tracked mods for the deleted server
  db.data.tracked_mods = db.data.tracked_mods.filter(
    (m) => m.server_id !== serverId,
  );

  if (wasActive && db.data.servers.length > 0) {
    db.data.servers[0].isActive = true;
  }

  // The password file is keyed by server id and outlives the record
  // otherwise — nothing else ever removes it.
  deleteServerSecret(serverId);

  scheduleWrite();
  return true;
}

export async function setActiveServer(id) {
  const db = await getDb();
  const server = db.data.servers.find((s) => String(s.id) === String(id));
  if (!server) return null;

  db.data.servers.forEach((s) => {
    s.isActive = String(s.id) === String(id);
  });

  syncServerToSettings(db, server);
  scheduleWrite();
  return server;
}

/** Sync active server config to legacy flat settings */
function syncServerToSettings(db, server) {
  const normalizedServer = normalizeServerMemory(server);
  db.data.settings.serverPath = server.installPath;
  db.data.settings.serverName = server.serverName;
  db.data.settings.rconHost = server.rconHost;
  db.data.settings.rconPort = server.rconPort;
  db.data.settings.rconPassword = server.rconPassword;
  db.data.settings.serverPort = server.serverPort;
  db.data.settings.minMemory = normalizedServer.minMemory;
  db.data.settings.maxMemory = normalizedServer.maxMemory;
  db.data.settings.zomboidDataPath = server.zomboidDataPath;
  db.data.settings.serverConfigPath = server.serverConfigPath;
}

// ============================================
// Roles & Capabilities
// ============================================
// Data-access layer only -- capability catalogue, requirePermission
// middleware, default-seed content and lockout-rule enforcement all live in
// services/permissions.js, which calls the functions below rather than
// touching db.data.roles directly, matching every other collection in this
// file.

export async function getRoles() {
  const db = await getDb();
  return db.data.roles || [];
}

export async function getRoleById(id) {
  const db = await getDb();
  return (db.data.roles || []).find((r) => String(r.id) === String(id)) || null;
}

export async function getRoleByName(name) {
  if (!name) return null;
  const db = await getDb();
  return (db.data.roles || []).find((r) => r.name === name) || null;
}

export async function insertRole(role) {
  const db = await getDb();
  if (!db.data.roles) db.data.roles = [];
  db.data.roles.push(role);
  scheduleWrite();
  return role;
}

export async function replaceRoleById(id, updatedRole) {
  const db = await getDb();
  const roles = db.data.roles || [];
  const index = roles.findIndex((r) => String(r.id) === String(id));
  if (index === -1) return null;
  roles[index] = updatedRole;
  scheduleWrite();
  return updatedRole;
}

export async function removeRoleById(id) {
  const db = await getDb();
  const roles = db.data.roles || [];
  const index = roles.findIndex((r) => String(r.id) === String(id));
  if (index === -1) return false;
  roles.splice(index, 1);
  scheduleWrite();
  return true;
}

/**
 * Every user currently resolving to `role` -- by roleId if set, otherwise
 * by name for a seeded default role (matches how requirePermission()
 * resolves a role today, since user records don't carry a live roleId
 * until auth.js's login/role-change paths are updated to set one).
 */
export async function getUsersForRole(role) {
  const db = await getDb();
  const users = db.data.users || [];
  return users.filter(
    (u) => u.roleId === role.id || (role.isSeeded && u.role === role.name),
  );
}

// Read-only, minimal shape (id, username, role, roleId) for lockout-rule
// counting in services/permissions.js -- not the full user record (no
// password hash or session state), since that's authService's territory.
export async function getUsersForRoleAccounting() {
  const db = await getDb();
  return (db.data.users || []).map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    roleId: u.roleId,
  }));
}

/** Move every member of `fromRole` onto `toRole`. Used by role deletion's reassignTo. */
export async function reassignRoleMembers(fromRole, toRole) {
  const db = await getDb();
  let count = 0;
  for (const user of db.data.users || []) {
    const matches =
      user.roleId === fromRole.id || (fromRole.isSeeded && user.role === fromRole.name);
    if (!matches) continue;
    user.roleId = toRole.id;
    // No isSeeded condition: requirePermission() resolves capabilities via
    // getRoleByName(req.user.role) -- roleId is dual-written but read by
    // nothing yet (see the migration's own comment). Only updating .role
    // for a seeded target left it stale for a custom one, so every request
    // from a reassigned user kept authorizing against their OLD role
    // indefinitely -- fail-open on the one operation whose entire purpose
    // is taking access away. Found by Kevin reading this function; the fix
    // is that .role always becomes the target's exact .name, seeded or not.
    user.role = toRole.name;
    count++;
  }
  if (count > 0) scheduleWrite();
  return count;
}

// ============================================
// Player Notes & Tags
// ============================================

export async function getPlayerNotes() {
  const db = await getDb();
  if (!db.data.player_notes) db.data.player_notes = [];
  return db.data.player_notes;
}

export async function getPlayerNote(playerName) {
  const db = await getDb();
  if (!db.data.player_notes) db.data.player_notes = [];
  return (
    db.data.player_notes.find(
      (p) => p.player_name.toLowerCase() === playerName.toLowerCase(),
    ) || null
  );
}

export async function upsertPlayerNote(playerName, note, tags = []) {
  const db = await getDb();
  if (!db.data.player_notes) db.data.player_notes = [];

  const existingIndex = db.data.player_notes.findIndex(
    (p) => p.player_name.toLowerCase() === playerName.toLowerCase(),
  );

  const entry = {
    player_name: playerName,
    note: note || "",
    tags: tags || [],
    updated_at: new Date().toISOString(),
  };

  if (existingIndex !== -1) {
    db.data.player_notes[existingIndex] = {
      ...db.data.player_notes[existingIndex],
      ...entry,
    };
  } else {
    entry.id = generateId();
    entry.created_at = new Date().toISOString();
    db.data.player_notes.push(entry);
  }

  scheduleWrite();
  return entry;
}

export async function deletePlayerNote(playerName) {
  const db = await getDb();
  if (!db.data.player_notes) return false;

  const index = db.data.player_notes.findIndex(
    (p) => p.player_name.toLowerCase() === playerName.toLowerCase(),
  );
  if (index === -1) return false;

  db.data.player_notes.splice(index, 1);
  scheduleWrite();
  return true;
}

// ============================================
// Player Stats (playtime tracking)
// ============================================

export async function getPlayerStats() {
  const db = await getDb();
  if (!db.data.player_stats) db.data.player_stats = [];
  return db.data.player_stats;
}

export async function getPlayerStat(playerName) {
  const db = await getDb();
  if (!db.data.player_stats) db.data.player_stats = [];
  return (
    db.data.player_stats.find(
      (p) => p.player_name.toLowerCase() === playerName.toLowerCase(),
    ) || null
  );
}

export async function recordPlayerSession(playerName, action) {
  const db = await getDb();
  if (!db.data.player_stats) db.data.player_stats = [];

  let playerStat = db.data.player_stats.find(
    (p) => p.player_name.toLowerCase() === playerName.toLowerCase(),
  );

  const now = new Date().toISOString();

  if (!playerStat) {
    playerStat = {
      id: generateId(),
      player_name: playerName,
      total_playtime_seconds: 0,
      session_count: 0,
      first_seen: now,
      last_seen: now,
      last_session_start: null,
      sessions: [],
    };
    db.data.player_stats.push(playerStat);
  }

  if (action === "connect") {
    playerStat.last_session_start = now;
    playerStat.last_seen = now;
    playerStat.session_count++;
  } else if (action === "disconnect" && playerStat.last_session_start) {
    const sessionStart = new Date(playerStat.last_session_start);
    const sessionEnd = new Date(now);
    const sessionDuration = Math.floor((sessionEnd - sessionStart) / 1000);

    playerStat.total_playtime_seconds += sessionDuration;
    playerStat.last_seen = now;

    if (!playerStat.sessions) playerStat.sessions = [];
    playerStat.sessions.unshift({
      start: playerStat.last_session_start,
      end: now,
      duration_seconds: sessionDuration,
    });
    if (playerStat.sessions.length > RETENTION.player_sessions) {
      playerStat.sessions = playerStat.sessions.slice(
        0,
        RETENTION.player_sessions,
      );
    }

    playerStat.last_session_start = null;
  }

  scheduleWrite();
  return playerStat;
}

// ============================================
// Performance History
// ============================================

export async function recordPerformanceSnapshot(snapshot) {
  const db = await getDb();
  if (!db.data.performance_history) db.data.performance_history = [];

  const entry = {
    timestamp: new Date().toISOString(),
    ...snapshot,
  };

  appendCapped(
    db.data.performance_history,
    entry,
    RETENTION.performance_history,
    { newest: false },
  );

  scheduleWrite();
  return entry;
}

export async function getPerformanceHistory(limit = 60) {
  const db = await getDb();
  if (!db.data.performance_history) return [];
  const safeLimit = parseClampedInteger(
    limit,
    60,
    1,
    RETENTION.performance_history,
  );
  return db.data.performance_history.slice(-safeLimit);
}

/**
 * Explicitly clear all recorded performance history. NOT called
 * automatically on startup (see index.js) — retention already caps this
 * collection at RETENTION.performance_history entries, so a restart no
 * longer needs to wipe it to bound its size, and keeping it means a
 * monitoring chart can show data spanning a restart/update-apply. Exposed
 * here for any explicit user-triggered "reset performance history" action.
 */
export async function clearPerformanceHistory() {
  const db = await getDb();
  db.data.performance_history = [];
  scheduleWrite();
}

// ============================================
// Mod Presets
// ============================================

export async function getModPresets() {
  const db = await getDb();
  if (!db.data.mod_presets) db.data.mod_presets = [];
  return db.data.mod_presets;
}

export async function createModPreset(
  name,
  description,
  mods,
  workshopIds,
  maps,
) {
  const db = await getDb();
  if (!db.data.mod_presets) db.data.mod_presets = [];

  const preset = {
    id: generateId(),
    name,
    description: description || "",
    mods: mods || [],
    workshop_ids: workshopIds || [],
    maps: maps || [],
    created_at: new Date().toISOString(),
  };

  db.data.mod_presets.push(preset);
  scheduleWrite();
  return preset;
}

export async function updateModPreset(id, updates) {
  const db = await getDb();
  if (!db.data.mod_presets) return null;

  const index = db.data.mod_presets.findIndex((p) => p.id === id);
  if (index === -1) return null;

  db.data.mod_presets[index] = {
    ...db.data.mod_presets[index],
    ...updates,
    updated_at: new Date().toISOString(),
  };
  scheduleWrite();
  return db.data.mod_presets[index];
}

export async function deleteModPreset(id) {
  const db = await getDb();
  if (!db.data.mod_presets) return false;

  const index = db.data.mod_presets.findIndex((p) => p.id === id);
  if (index === -1) return false;

  db.data.mod_presets.splice(index, 1);
  scheduleWrite();
  return true;
}

// ============================================
// Simulation Templates (user-created; built-ins live under server/data/templates)
// ============================================

export async function getUserTemplates() {
  const db = await getDb();
  if (!db.data.user_templates) db.data.user_templates = [];
  return db.data.user_templates;
}

export async function getUserTemplate(id) {
  const db = await getDb();
  if (!db.data.user_templates) db.data.user_templates = [];
  return db.data.user_templates.find((t) => t.meta?.id === id) || null;
}

export async function saveUserTemplate(template) {
  const db = await getDb();
  if (!db.data.user_templates) db.data.user_templates = [];

  const index = db.data.user_templates.findIndex(
    (t) => t.meta?.id === template.meta?.id,
  );
  if (index === -1) {
    db.data.user_templates.push(template);
  } else {
    db.data.user_templates[index] = template;
  }
  scheduleWrite();
  return template;
}

export async function deleteUserTemplate(id) {
  const db = await getDb();
  if (!db.data.user_templates) return false;

  const index = db.data.user_templates.findIndex((t) => t.meta?.id === id);
  if (index === -1) return false;

  db.data.user_templates.splice(index, 1);
  scheduleWrite();
  return true;
}

// ============================================
// SteamID Ban Tracking
// ============================================

export async function getSteamIdBans() {
  const db = await getDb();
  if (!db.data.steamid_bans) db.data.steamid_bans = [];
  return db.data.steamid_bans;
}

export async function addSteamIdBan(steamId, reason = null) {
  const db = await getDb();
  if (!db.data.steamid_bans) db.data.steamid_bans = [];

  // Don't add duplicates
  if (db.data.steamid_bans.some((b) => b.steamId === steamId)) return;

  db.data.steamid_bans.push({
    steamId,
    reason: reason || null,
    banned_at: new Date().toISOString(),
  });
  scheduleWrite();
}

export async function removeSteamIdBan(steamId) {
  const db = await getDb();
  if (!db.data.steamid_bans) return false;

  const index = db.data.steamid_bans.findIndex((b) => b.steamId === steamId);
  if (index === -1) return false;

  db.data.steamid_bans.splice(index, 1);
  scheduleWrite();
  return true;
}
