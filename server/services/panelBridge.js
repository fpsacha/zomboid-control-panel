/**
 * PanelBridge - Node.js Bridge Service
 *
 * Provides communication between the panel and the PZ server mod.
 * Uses file-based communication with atomic operations.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import {
  logPlayerAction,
  recordPlayerSession,
  logServerEvent,
  applySuspendGapToInFlightSessions,
  getActiveServer,
} from '../database/init.js';
import { createLogger } from '../utils/logger.js';
import { bridgeFolderName } from '../utils/bridgeFolderName.js';
import { bridgeArgsRefusal, bridgeArgsRefusalMessage, boundedSoundArgs } from '../utils/bridgeCommandArgs.js';
import {
  BRIDGE_FILE_TOO_LARGE,
  readModFileCapped,
  clearModFile,
  writeFreshModFile,
  writeModFileNoFollow,
  isUnreadableBridgeFile,
} from '../utils/bridgeModFile.js';
import { PanelBridgeSftpTransport } from './panelBridgeSftp.js';

// Kept exported from here for existing importers.
export { BRIDGE_FILE_TOO_LARGE, readModFileCapped };
const log = createLogger('Bridge');

// Build 42 (buildid 24449161) only lets Lua write files whose name ends in
// .txt, so every file the mod owns carries this extra suffix from v1.7.7.
const MOD_WRITE_SUFFIX = '.txt';
const RESULT_FILE_PATTERN = /^res-(\d+)\.json(?:\.txt)?$/;

// 2026-09-02, destructive-guards-sweep: cleanupInboxFiles/cleanupOutboxFiles
// used to unlink every *.tmp file they found with NO guard at all -- no age
// check, no liveness check, nothing. Both the mod-side (Lua getFileWriter,
// likely doing its own atomic write-then-rename under the hood -- the code
// here has documented "orphaned .tmp files from interrupted atomic writes"
// since before this fix, implying a *.tmp file mid-write is an expected,
// routine sight, not a rare crash artifact) and the panel's own inbox write
// (writeFileSync(tempFile) + renameSync, see sendCommand-family callers
// below) both go through a temp-then-rename pattern, so a *.tmp file this
// sweep sees can genuinely be mid-write, not just orphaned. Deleting it out
// from under the writer silently drops a queued command or its result --
// same defect shape as database/init.js's db.json.*.tmp sweep (bughunt
// single-signal-sweep-2026-09-02), same fix: gate on age, matching
// database/init.js's MIN_ORPHAN_AGE_MS convention. The cleanup sweep itself
// only runs once per cleanupIntervalMs (60s), so a genuinely orphaned file
// still gets swept on the next pass -- this only removes the window where a
// file that is not yet a full sweep interval old gets deleted while a
// writer might still be using it.
const MIN_ORPHAN_TMP_AGE_MS = 60_000;

// 2026-09-06, host-suspend-resume sweep (operator-decided shape): a laptop
// sleep or VM pause freezes the whole Node process, timers included --
// setInterval callbacks simply do not fire while it's frozen, and the very
// next tick after resume sees a Date.now() that jumped by the full real
// elapsed time, not by ~heartbeatIntervalMs. checkHeartbeat() below measures
// that jump. This threshold is how far past the expected interval a tick can
// land before it counts as a genuine suspend rather than ordinary
// event-loop jitter or a GC pause -- comfortably above anything routine
// jitter produces, comfortably below the shortest suspend anyone would
// actually notice happened.
const SUSPEND_GAP_THRESHOLD_MS = 10_000;

// A queued command carries expiresAt, and the mod (processSingleCommand in
// PanelBridge.lua) refuses to start one that is past it, answering "Command
// expired before mod could process it". That check exists so a command the
// caller was already told timed out (sendCommand rejects after
// commandTimeoutMs) does not run afterwards anyway: a retry would then do
// the work twice (a horde, an airdrop, giveItem). So expiresAt is the
// timeout plus only this allowance for the two clocks disagreeing: the mod
// compares it with the game host's clock, which over SFTP is not the
// panel's. It used to be twice the timeout, which let a command stuck behind
// a long handler run 15-30 s after the caller had given up.
const COMMAND_EXPIRY_SKEW_MS = 5_000;

// Fails toward KEEPING the file on any ambiguity (stat failure means "can't
// prove this is safe to delete"), matching pidLiveness.js's isPidAlive()
// philosophy: an inconclusive signal never authorises a destructive action.
function isOldEnoughToSweep(filePath, minAgeMs = MIN_ORPHAN_TMP_AGE_MS) {
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs >= minAgeMs;
  } catch (_) {
    return false;
  }
}

// Format an age in milliseconds as a short human string ("38d", "2h", "45s").
// Used for diagnostics messages so users don't read raw seconds-since-epoch.
function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

// The same age as a number, beside formatAge()'s English text in a
// diagnostic's params: the client words it with its own duration units
// (serverUptime's "12 min", "12 Min.", "12 хв"), which a translated
// sentence needs -- a bare "12m" reads as metres in Portuguese. Left out
// when there is no sensible age, so the client keeps the text as sent.
function ageSecondsParam(ms) {
  return Number.isFinite(ms) && ms >= 0 ? { ageSeconds: Math.floor(ms / 1000) } : {};
}

// The active server's id as the player tables store it (String(server.id)),
// or undefined when there is none or it can't be read. Never throws: a
// lookup failure only means the session calls fall back to the active
// server, as before.
function resolveSessionServerId() {
  try {
    return Promise.resolve(getActiveServer())
      .then((server) => (server?.id != null ? String(server.id) : undefined))
      .catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

class PanelBridge extends EventEmitter {
  constructor() {
    super();
    this.bridgePath = null;
    this.isRunning = false;
    this.pollInterval = null;
    this.statusInterval = null;
    this.heartbeatInterval = null;
    this.lastHeartbeatAt = null;
    this.fileWatcher = null;
    this.sftpTransport = null;
    this.lastSftpStatus = null;
    this.pendingCommands = new Map(); // id -> { resolve, reject, timeout, timestamp }
    this.processedResults = new Map(); // id -> timestamp (for deduplication)
    this.protocolVersion = 'queue-v1';
    this.queue = {
      inboxDir: 'inbox',
      outboxDir: 'outbox',
      inboxCursorFile: path.join('inbox', 'cursor.json'),
      sequenceWidth: 10,
      maxResultsPerPoll: 100,
      retainRecentFiles: 200,
      cleanupIntervalMs: 60000,
      // How long to wait on a missing next-sequence result file before
      // suspecting the two sides' counters have desynced (e.g. this file
      // getting reset by a redeploy while the mod's counter kept climbing).
      resyncStuckMs: 20000,
      // Once stuck, how often to re-probe the mod's own state file (avoids
      // reading it every 150ms poll while legitimately idle).
      resyncCheckIntervalMs: 5000
    };
    this.queueState = {
      initialized: false,
      nextCommandSeq: 1,
      lastConsumedResultSeq: 0,
      nextResultSeq: 1
    };
    this.outboxStuckState = { seq: null, since: 0, nextCheckAt: 0 };
    this.inboxResyncNextCheckAt = 0;
    this.lastQueueCleanupAt = 0;
    this.modStatus = null;
    this.previousPlayers = new Set(); // Track previous player list for connect/disconnect detection
    // The server whose players this bridge session tracks: the active server
    // when start() ran (see resolveSessionServerId()). undefined until known,
    // and then the session calls fall back to the active server.
    this.sessionServerId = undefined;
    this.sessionServerIdToken = null;
    // False until the first alive status read of this bridge session: that
    // read only establishes who is already online (see checkModStatus()).
    this.playersBaselined = false;
    // Which of the deaths status.json lists were already reported (see
    // trackPlayerDeaths()); null until the first status of this bridge path.
    this.deathTracking = null;
    this.lastStatusFileCheck = 0;
    // mtime of the status file the last exited server process left behind
    // (see markServerExited()); null when nothing is being disbelieved.
    // Deliberately NOT reset by stop(): it describes that file on disk, not
    // this bridge session, and a bridge restart on the same path must not
    // resurrect a dead server's heartbeat. Any other mtime clears it.
    this.exitedServerStatusMtimeMs = null;
    // When the game server was first seen running again while that exited
    // write is still the newest one (markServerRunning()); null while the
    // panel last knew it stopped. Decides only what the diagnostics say --
    // never whether the mod counts as connected.
    this.serverRunningAgainSinceMs = null;
    // panelbridge-lua-version-handshake: last protocolVersion string we've
    // already warned about, so a mismatch logs once (not every ~1s poll)
    // and re-warns if the mod is redeployed to yet another mismatched build.
    this.loggedProtocolVersionMismatch = null;
    this.consecutiveFailures = 0;
    this.maxConsecutiveFailures = 5;
    this.watcherRetries = 0;
    this.maxWatcherRetries = 3;
    this.config = {
      pollIntervalMs: 150,          // Fast polling for results (150ms)
      statusCheckMs: 1000,          // Check status every 1 second
      commandTimeoutMs: 15000,
      statusStaleMs: 45000,         // Status considered stale after 45 seconds (Lua updates every 3s)
      statusStaleIdleMs: 300000,    // 5 min tolerance when 0 players (PZ stops ticking with no players)
      fileWatchDebounceMs: 100,     // Debounce file change events
      heartbeatIntervalMs: 5000     // Suspend-detection heartbeat (see checkHeartbeat())
    };
  }

  /**
   * Configure the bridge with the path to the PZ server's panelbridge folder
   * @param {string} bridgeFolderPath - Path to the panelbridge folder (or parent folder)
   * @param {boolean} isDirectPath - If true, bridgeFolderPath IS the panelbridge folder. If false, add /panelbridge/ to it.
   */
  configure(bridgeFolderPath, isDirectPath = false) {
    if (!bridgeFolderPath) {
      throw new Error('bridgeFolderPath is required');
    }

    // The mod creates files in: {Lua}/panelbridge/{serverName}/
    // If isDirectPath, the path already points to the panelbridge folder
    if (isDirectPath) {
      this.bridgePath = bridgeFolderPath;
    } else {
      this.bridgePath = path.join(bridgeFolderPath, 'panelbridge');
    }

    // Don't create the directory here — the PZ Lua mod creates it on startup.
    // Its existence serves as a signal that the mod has been installed and initialized.

    log.debug(`Configured path: ${this.bridgePath}`);
    // Another folder is another server: its recent deaths aren't new.
    this.deathTracking = null;
    this.emit('configured', { path: this.bridgePath });

    return this.bridgePath;
  }

  async configureSftp(config, cachePath) {
    const transport = new PanelBridgeSftpTransport();
    try {
      await transport.start(config, cachePath);
    } catch (error) {
      this.lastSftpStatus = transport.getStatus();
      await transport.stop();
      this.lastSftpStatus = transport.getStatus();
      throw error;
    }

    // Keep the current bridge alive until the replacement has completed its
    // initial remote directory and status sync. A bad replacement must not
    // disconnect an otherwise healthy server.
    const previousTransport = this.sftpTransport;
    try {
      if (this.isRunning) this.stop();
      if (previousTransport) await previousTransport.stop();
      this.configure(cachePath, true);
      this.config.commandTimeoutMs = 60000;
      this.sftpTransport = transport;
      this.lastSftpStatus = transport.getStatus();
      this.start();
    } catch (error) {
      // The new transport connected successfully -- the try/catch above
      // already proved that -- but something in the swap itself failed
      // (this.configure()/this.start() throwing, or a future edit adding a
      // step here that can). Without this, the freshly-connected transport
      // is silently leaked: its SFTP connection and poll timer keep
      // running, owned by nothing, and this.sftpTransport is left pointing
      // at whatever it was before -- possibly the OLD transport, which was
      // already stopped two lines up, so the bridge would report itself
      // configured against a transport that isn't actually running.
      this.sftpTransport = null;
      await transport.stop();
      this.lastSftpStatus = transport.getStatus();
      throw error;
    }
    return this.bridgePath;
  }

  async stopSftp() {
    if (this.sftpTransport) {
      await this.sftpTransport.stop();
      this.lastSftpStatus = this.sftpTransport.getStatus();
    }
    this.sftpTransport = null;
    this.config.commandTimeoutMs = 15000;
  }

  isSftpRunning() {
    return Boolean(this.sftpTransport?.running);
  }

  /**
   * Auto-detect the bridge path from server name
   * @param {string} serverName - Name of the PZ server
   * @param {string} zomboidUserFolder - Path to Zomboid user folder (optional)
   */
  autoDetect(serverName, zomboidUserFolder = null) {
    // Validate serverName to prevent path traversal
    if (!serverName || typeof serverName !== 'string' || !/^[a-zA-Z0-9_\- ]{1,64}$/.test(serverName)) {
      throw new Error('Invalid server name — use only letters, numbers, spaces, hyphens, and underscores (max 64 chars)');
    }

    // Default Zomboid folder locations (platform-aware)
    const possibleBases = zomboidUserFolder
      ? [zomboidUserFolder]
      : process.platform === 'win32'
        ? [path.join(os.homedir(), 'Zomboid')]
        : [
            path.join(os.homedir(), 'Zomboid'),
            path.join(os.homedir(), 'pzserver'),
            '/opt/pz-server',
            '/srv/zomboid',
          ];

    for (const base of possibleBases) {
      // The Lua mod writes to: {base}/Lua/panelbridge/{folder}/, where folder is
      // the server name with whitespace replaced (utils/bridgeFolderName.js)
      const bridgePath = path.join(base, 'Lua', 'panelbridge', bridgeFolderName(serverName));
      // codeql[js/path-injection] bridgePath here is built from serverName, validated immediately above against /^[a-zA-Z0-9_\- ]{1,64}$/ -- no path-traversal characters are possible in a name matching that pattern.
      if (fs.existsSync(bridgePath)) {
        return this.configure(bridgePath, true); // direct path — already the panelbridge folder
      }
    }

    throw new Error(`Could not find panelbridge folder for server: ${serverName}`);
  }

  /**
   * Get file paths
   */

  /**
   * Project Zomboid Build 42 (buildid 24449161) restricts getFileWriter to an
   * extension whitelist - .json is rejected outright - so from mod v1.7.7 every
   * file the Lua side owns is written with a .txt suffix appended:
   * panelbridge/DoomerZ/outbox/res-1.json -> panelbridge/DoomerZ/outbox/res-1.json.txt
   * Files the panel writes (commands.json, inbox/*) are unaffected.
   */
  getModWriteFile(relativeName) {
    if (!this.bridgePath) return null;
    return path.join(this.bridgePath, `${relativeName}${MOD_WRITE_SUFFIX}`);
  }

  /**
   * Resolve a file written by the Lua mod, preferring the .txt-suffixed Build 42
   * name and falling back to the unsuffixed one written by older mod versions.
   */
  resolveModFile(relativeName) {
    if (!this.bridgePath) return null;
    const suffixedFile = this.getModWriteFile(relativeName);
    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    if (suffixedFile && fs.existsSync(suffixedFile)) return suffixedFile;
    return path.join(this.bridgePath, relativeName);
  }

  getCommandsFile() {
    return this.bridgePath ? path.join(this.bridgePath, 'commands.json') : null;
  }

  getResultsFile() {
    return this.resolveModFile('results.json');
  }

  getStatusFile() {
    return this.resolveModFile('status.json');
  }

  getInboxDir() {
    return this.bridgePath ? path.join(this.bridgePath, this.queue.inboxDir) : null;
  }

  getOutboxDir() {
    return this.bridgePath ? path.join(this.bridgePath, this.queue.outboxDir) : null;
  }

  getQueueStateFile() {
    return this.bridgePath ? path.join(this.bridgePath, '.queue-state-node.json') : null;
  }

  getInboxCursorFile() {
    return this.resolveModFile(this.queue.inboxCursorFile);
  }

  formatSeq(seq) {
    return String(seq).padStart(this.queue.sequenceWidth, '0');
  }

  getCommandFileBySeq(seq) {
    const inboxDir = this.getInboxDir();
    if (!inboxDir) return null;
    return path.join(inboxDir, `cmd-${this.formatSeq(seq)}.json`);
  }

  getResultFileBySeq(seq) {
    if (!this.bridgePath) return null;
    return this.resolveModFile(path.join(this.queue.outboxDir, `res-${this.formatSeq(seq)}.json`));
  }

  ensureQueueProtocol() {
    if (!this.bridgePath) {
      throw new Error('Bridge path not configured');
    }
    if (this.queueState.initialized) {
      return;
    }

    const inboxDir = this.getInboxDir();
    const outboxDir = this.getOutboxDir();
    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    fs.mkdirSync(inboxDir, { recursive: true });
    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    fs.mkdirSync(outboxDir, { recursive: true });

    const stateFile = this.getQueueStateFile();
    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    if (fs.existsSync(stateFile)) {
      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        const state = JSON.parse(readModFileCapped(stateFile) || '{}');
        const nextSeq = Number(state.nextCommandSeq);
        const consumed = Number(state.lastConsumedResultSeq);
        const nextResult = Number(state.nextResultSeq);
        this.queueState.nextCommandSeq = Number.isFinite(nextSeq) && nextSeq > 0 ? Math.floor(nextSeq) : 1;
        this.queueState.lastConsumedResultSeq = Number.isFinite(consumed) && consumed >= 0 ? Math.floor(consumed) : 0;
        this.queueState.nextResultSeq = Number.isFinite(nextResult) && nextResult > 0 ? Math.floor(nextResult) : 1;
      } catch (error) {
        log.warn(`Could not parse queue state file: ${error.message}`);
        this.queueState.nextCommandSeq = 1;
        this.queueState.lastConsumedResultSeq = 0;
        this.queueState.nextResultSeq = 1;
      }
    }

    // A malformed Lua-owned state file must not reset the result sequence to
    // one while old outbox files are still present. Recover the strongest
    // lower bound available from the panel-owned state, Lua's last snapshot,
    // and surviving cached result filenames.
    const luaStateFile = this.resolveModFile('queue-state-lua.json');
    if (luaStateFile && fs.existsSync(luaStateFile)) {
      try {
        const luaState = JSON.parse(readModFileCapped(luaStateFile) || '{}');
        const luaNextResult = Number(luaState.nextResultSeq);
        if (Number.isFinite(luaNextResult) && luaNextResult > 0) {
          this.queueState.nextResultSeq = Math.max(this.queueState.nextResultSeq, Math.floor(luaNextResult));
        }
      } catch (error) {
        log.warn(`Could not parse Lua result sequence state: ${error.message}`);
      }
    }

    if (outboxDir && fs.existsSync(outboxDir)) {
      try {
        for (const name of fs.readdirSync(outboxDir)) {
          const match = /^res-(\d+)\.json(?:\.txt)?$/.exec(name);
          if (!match) continue;
          const resultSeq = Number(match[1]);
          if (Number.isFinite(resultSeq)) {
            this.queueState.nextResultSeq = Math.max(this.queueState.nextResultSeq, Math.floor(resultSeq) + 1);
          }
        }
      } catch (error) {
        log.warn(`Could not scan outbox result sequence state: ${error.message}`);
      }
    }

    // The SFTP cache can be cleared independently of the remote server. In
    // that case the Lua cursor is the authoritative lower bound for new
    // command filenames, otherwise Node would restart at cmd-0000000001.
    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    if (luaStateFile && fs.existsSync(luaStateFile)) {
      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        const luaState = JSON.parse(readModFileCapped(luaStateFile) || '{}');
        const lastCommandSeq = Number(luaState.lastCommandSeq);
        if (Number.isFinite(lastCommandSeq) && lastCommandSeq >= 0) {
          this.queueState.nextCommandSeq = Math.max(
            this.queueState.nextCommandSeq,
            Math.floor(lastCommandSeq) + 1,
          );
        }
      } catch (error) {
        log.warn(`Could not parse Lua queue state file: ${error.message}`);
      }
    }

    this.queueState.initialized = true;
    this.persistQueueState();
  }

  persistQueueState() {
    const stateFile = this.getQueueStateFile();
    if (!stateFile) return;
    const payload = {
      protocolVersion: this.protocolVersion,
      nextCommandSeq: this.queueState.nextCommandSeq,
      lastConsumedResultSeq: this.queueState.lastConsumedResultSeq,
      nextResultSeq: Math.max(this.queueState.nextResultSeq, this.queueState.lastConsumedResultSeq + 1),
      updatedAt: Date.now()
    };
    const tempFile = `${stateFile}.tmp`;
    try {
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      writeFreshModFile(tempFile, JSON.stringify(payload, null, 2));
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      fs.renameSync(tempFile, stateFile);
    } catch (error) {
      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        writeModFileNoFollow(stateFile, JSON.stringify(payload, null, 2));
      } catch (writeError) {
        log.warn(`Could not persist queue state: ${writeError.message}`);
      }
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      try { fs.unlinkSync(tempFile); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Assess file-based IPC health between panel and PanelBridge mod.
   * Uses fast file-system checks only (no writes).
   */
  getConnectionDiagnostics() {
    const bridgePath = this.bridgePath;
    const commandsFile = this.getCommandsFile();
    const resultsFile = this.getResultsFile();
    const statusFile = this.getStatusFile();

    // Each issue is `{key, params, text}` -- `text` is the exact English
    // sentence a caller with no translation entry sees (kept for anyone
    // still consuming this as a plain string), `key`+`params` let the
    // client resolve `bridge.diagnostics.<key>` via i18next with `text` as
    // defaultValue, the same convention as capabilities.<key>.label. See
    // client/src/pages/Settings.tsx and Events.tsx for the two consumers.
    const issues = [];
    const pushIssue = (key, text, params) => issues.push({ key, params, text });
    const checks = {
      bridgePathConfigured: Boolean(bridgePath),
      bridgePathExists: false,
      bridgePathReadable: false,
      bridgePathWritable: false,
      inboxDirPresent: false,
      outboxDirPresent: false,
      commandsFilePresent: false,
      commandsFileReadable: false,
      resultsFilePresent: false,
      resultsFileReadable: false,
      statusFilePresent: false,
      statusFileReadable: false,
      statusFresh: false,
      statusAgeMs: null,
    };

    if (!bridgePath) {
      pushIssue('notConfigured', 'Bridge path is not configured.');
      return {
        healthy: false,
        canSendCommands: false,
        checks,
        issues,
        summary: { key: 'notConfigured', text: 'Bridge path is not configured.' },
      };
    }

    try {
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      checks.bridgePathExists = fs.existsSync(bridgePath);
      if (!checks.bridgePathExists) {
        pushIssue('directoryMissing', 'Bridge directory does not exist yet.');
      }
    } catch (e) {
      pushIssue('directoryCheckFailed', `Bridge directory check failed: ${e.message}`, { error: e.message });
    }

    if (checks.bridgePathExists) {
      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        fs.accessSync(bridgePath, fs.constants.R_OK);
        checks.bridgePathReadable = true;
      } catch (e) {
        pushIssue('directoryNotReadable', `Bridge directory is not readable: ${e.message}`, { error: e.message });
      }

      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        fs.accessSync(bridgePath, fs.constants.W_OK);
        checks.bridgePathWritable = true;
      } catch (e) {
        pushIssue('directoryNotWritable', `Bridge directory is not writable: ${e.message}`, { error: e.message });
      }
    }

    const inspectFile = (filePath, presentKey, readableKey) => {
      if (!filePath) return;
      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        const exists = fs.existsSync(filePath);
        checks[presentKey] = exists;
        if (!exists) return;
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        fs.accessSync(filePath, fs.constants.R_OK);
        checks[readableKey] = true;
      } catch (e) {
        checks[readableKey] = false;
        const filename = path.basename(filePath);
        pushIssue('fileNotReadable', `${filename} is not readable: ${e.message}`, { filename, error: e.message });
      }
    };

    inspectFile(commandsFile, 'commandsFilePresent', 'commandsFileReadable');
    inspectFile(resultsFile, 'resultsFilePresent', 'resultsFileReadable');
    inspectFile(statusFile, 'statusFilePresent', 'statusFileReadable');

    const inboxDir = this.getInboxDir();
    const outboxDir = this.getOutboxDir();
    if (inboxDir) {
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      checks.inboxDirPresent = fs.existsSync(inboxDir);
    }
    if (outboxDir) {
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      checks.outboxDirPresent = fs.existsSync(outboxDir);
    }

    if (!checks.statusFilePresent) {
      // Method-neutral, like bridgeSilentSinceStart below: "enabled" read as
      // a Mods= step, which the default panel-installed PanelBridge has not.
      pushIssue(
        'statusFileMissing',
        "Status file is missing. PanelBridge writes it once the game server's world has loaded; if it stays missing while the server runs, see “How PanelBridge is installed” in Settings › PanelBridge.",
      );
    } else {
      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        const stats = fs.statSync(statusFile);
        const ageMs = Date.now() - stats.mtimeMs;
        // Use relaxed threshold when server idle (0 players)
        const diagStaleMs = (this.modStatus?.playerCount === 0)
          ? this.config.statusStaleIdleMs
          : this.config.statusStaleMs;
        checks.statusAgeMs = ageMs;
        // The last write of a server process that has since exited
        // (markServerExited()) is not a live mod however young it is --
        // judging it by age alone told Settings > Bridge and the Debug page
        // the connection was healthy for up to statusStaleIdleMs after a
        // quiet stop, beside a mod status that already said offline (and
        // sendCommand() refusing with "Mod is not responding").
        const exitedServerWrite =
          this.exitedServerStatusMtimeMs !== null && stats.mtimeMs === this.exitedServerStatusMtimeMs;
        checks.statusFresh = !exitedServerWrite && ageMs < diagStaleMs;
        if (exitedServerWrite && this.serverRunningAgainSinceMs !== null) {
          // The server is back up but its mod has not written yet. The
          // mod's first write comes from onServerStarted, after the world
          // has loaded (minutes on Build 42), and never comes at all when
          // the mod broke on an update or left the mod list -- so this
          // says how long it has been silent since the start, the one
          // number that tells those two apart, instead of claiming the
          // server is stopped beside a Dashboard that says it is running.
          const silentMs = Date.now() - this.serverRunningAgainSinceMs;
          const age = formatAge(silentMs);
          pushIssue(
            'bridgeSilentSinceStart',
            `The game server started ${age} ago, but PanelBridge has not reported yet. It reports once the world has loaded; if it stays silent, see “How PanelBridge is installed” in Settings › PanelBridge.`,
            { age, ...ageSecondsParam(silentMs) },
          );
        } else if (exitedServerWrite) {
          // Its own message rather than statusFileStale's: seconds after a
          // stop that one read "Status file is stale (2s old) -- is the PZ
          // server running?", an age too young for "stale" and a question
          // the panel already knows the answer to.
          pushIssue('serverExited', 'The game server has stopped. PanelBridge reconnects when the server starts again.');
        } else if (!checks.statusFresh) {
          const age = formatAge(ageMs);
          pushIssue('statusFileStale', `Status file is stale (${age} old) — is the PZ server running?`, { age, ...ageSecondsParam(ageMs) });
        }
      } catch (e) {
        pushIssue('statusFileMetadataFailed', `Could not read status file metadata: ${e.message}`, { error: e.message });
      }
    }

    const canSendCommands = checks.bridgePathConfigured
      && checks.bridgePathExists
      && checks.bridgePathWritable
      && checks.statusFilePresent
      && checks.statusFresh;

    return {
      healthy: issues.length === 0,
      canSendCommands,
      checks,
      issues,
      summary: issues[0] || { key: 'healthy', text: 'Bridge file connection looks healthy.' },
    };
  }

  /**
   * Start the bridge polling
   */
  start() {
    if (!this.bridgePath) {
      throw new Error('Bridge not configured. Call configure() first.');
    }

    if (this.isRunning) {
      log.debug('Already running');
      return;
    }

    // Reset failure counter on start
    this.consecutiveFailures = 0;
    this.lastStatusFileCheck = 0;
    this.queueState.initialized = false;
    this.ensureQueueProtocol();

    // Pin the server these players belong to now. A server switch activates
    // the new server BEFORE it stops this bridge, and stop() then closes
    // every open session: looked up at that point, the active server is the
    // new one, so the old server's sessions never closed (playtime lost) and
    // the new one got rows for players who never joined it.
    const sessionToken = {};
    this.sessionServerIdToken = sessionToken;
    this.sessionServerId = undefined;
    resolveSessionServerId().then((serverId) => {
      if (this.sessionServerIdToken === sessionToken) this.sessionServerId = serverId;
    });

    // Start polling for results (fast poll)
    this.pollInterval = setInterval(() => this.pollResults(), this.config.pollIntervalMs);

    // Start checking mod status
    this.statusInterval = setInterval(() => this.checkModStatus(), this.config.statusCheckMs);

    // Start the suspend-detection heartbeat (see checkHeartbeat())
    this.lastHeartbeatAt = Date.now();
    this.heartbeatInterval = setInterval(() => this.checkHeartbeat(), this.config.heartbeatIntervalMs);

    // Setup file watcher for immediate response to file changes
    this.setupFileWatcher();

    // Do an immediate status check
    this.checkModStatus();

    this.isRunning = true;
    log.info(`Started - watching ${this.bridgePath}`);
    this.emit('started');
  }

  /**
   * Setup file watcher for the bridge directory
   */
  setupFileWatcher() {
    if (this.fileWatcher) {
      try {
        this.fileWatcher.close();
      } catch (e) {
        // Ignore close errors
      }
      this.fileWatcher = null;
    }

    // Stop trying if we've failed too many times
    if (this.watcherRetries >= this.maxWatcherRetries) {
        const hint = process.platform === 'linux'
          ? ' On Linux, check: sysctl fs.inotify.max_user_watches (increase to 524288 if low).'
          : '';
        log.warn(`Gave up on file watcher after ${this.maxWatcherRetries} attempts. Falling back to polling only.${hint}`);
        return;
    }

    try {
      this._debounceTimer = null;
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      this.fileWatcher = fs.watch(this.bridgePath, { persistent: false }, (eventType, filename) => {
        // Debounce rapid file changes
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
          this._debounceTimer = null;
          if (!this.isRunning) return;
          try {
            if (filename === 'status.json') {
              this.checkModStatus();
            } else if (filename === 'results.json') {
              this.pollResults();
            }
          } catch (e) {
            log.debug(`File change handler error: ${e.message}`);
          }
        }, this.config.fileWatchDebounceMs);
      });

      this.fileWatcher.on('error', (err) => {
        const hint = process.platform === 'linux' && (err.code === 'ENOSPC' || err.message.includes('inotify'))
          ? ' Increase fs.inotify.max_user_watches: sudo sysctl -w fs.inotify.max_user_watches=524288'
          : '';
        log.warn(`File watcher error: ${err.message}${hint}`);
        // Try to recover by closing and nullifying
        try {
          this.fileWatcher.close();
        } catch (e) { /* ignore */ }
        this.fileWatcher = null;
        this.watcherRetries++;

        // Attempt to restart file watcher after delay
        setTimeout(() => {
          if (this.isRunning && !this.fileWatcher) {
            log.info(`Attempting to restart file watcher (attempt ${this.watcherRetries}/${this.maxWatcherRetries})...`);
            this.setupFileWatcher();
          }
        }, 5000);
      });

      log.debug('File watcher active');
      this.watcherRetries = 0; // Reset retries on successful setup
    } catch (err) {
      // File watching is optional - polling will still work
      this.watcherRetries++;
      log.warn(`Could not setup file watcher: ${err.message}`);

      // Retry initially a few times even if immediate setup fails
      if (this.watcherRetries < this.maxWatcherRetries) {
         setTimeout(() => {
             if (this.isRunning && !this.fileWatcher) {
                 this.setupFileWatcher();
             }
         }, 5000);
      }
    }
  }

  /**
   * Stop the bridge
   */
  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.lastHeartbeatAt = null;
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    // Reject all pending commands
    for (const [, pending] of this.pendingCommands) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Bridge stopped'));
    }
    this.pendingCommands.clear();

    // Reset state so next start() cycle is clean
    this.processedResults.clear();
    // Same reasoning as handleStatusFailure's own comment: close out every
    // tracked player's session before clearing previousPlayers, rather than
    // wiping it directly. Wiping it directly (the old behavior) didn't
    // avoid the problem, it just moved it -- the next checkModStatus() read
    // after a restart would see the SAME still-connected players as brand
    // new joins (previous was empty) and fire a phantom "connect" that
    // silently overwrote their still-open prior session with no
    // "disconnect" ever recorded, the identical playtime-loss bug via a
    // different path. This way the session actually closes (playtime
    // accumulated) before the phantom reconnect opens a new one -- a split
    // session instead of lost time.
    //
    // silent: this is the panel closing its own books (a bridge restart, a
    // switch to another server, a panel shutdown), not anyone leaving, so
    // the Discord/auto-export listeners must not announce it.
    this.trackPlayerActivity([], { silent: true });
    this.sessionServerId = undefined;
    this.sessionServerIdToken = null;
    this.playersBaselined = false;
    this.watcherRetries = 0;
    this.modStatus = null;
    this.deathTracking = null;
    this.consecutiveFailures = 0;
    this.lastStatusFileCheck = 0;
    this.queueState.initialized = false;

    this.isRunning = false;
    log.info('Stopped');
    this.emit('stopped');
  }

  /**
   * Send a command to the PZ mod
   * @param {string} action - Command action name
   * @param {object} args - Command arguments
   * @returns {Promise<object>} - Command result
   */
  async sendCommand(action, args = {}) {
    // Before anything stringifies args (the debug line below would throw on
    // deeply nested args): see utils/bridgeCommandArgs.js.
    const argsRefusal = bridgeArgsRefusal(action, args);
    if (argsRefusal) {
      throw Object.assign(new Error(`${action}: ${bridgeArgsRefusalMessage(argsRefusal)}`), {
        code: 'PANELBRIDGE_ARGS_TOO_LARGE',
      });
    }
    args = boundedSoundArgs(action, args);
    log.debug(`sendCommand: action=${action} args=${JSON.stringify(args).substring(0, 200)}`);
    if (!this.bridgePath) {
      throw new Error('Bridge not configured');
    }
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }

    const connection = this.getConnectionDiagnostics();
    if (!connection.canSendCommands) {
      // summary is a {key, params, text} entry, not a string -- interpolated
      // whole, this read "…unhealthy: [object Object]".
      throw new Error(`Bridge file connection is unhealthy: ${connection.summary?.text ?? connection.summary}`);
    }

    // Fail fast if the mod hasn't responded recently (avoids 15s timeout wait)
    if (this.modStatus && !this.modStatus.alive && action !== 'ping') {
      throw new Error(
        'Mod is not responding — check the PZ server is running and its world has loaded; Settings › PanelBridge shows how this server gets PanelBridge',
      );
    }

    const commandsFile = this.getCommandsFile();
    const id = uuidv4();
    this.ensureQueueProtocol();

    // Register before writing the inbox file. The mod can process a local
    // command before the write promise yields back to this function; adding
    // the pending entry afterwards loses that valid fast response as an
    // orphan and makes the caller wait for a false timeout.
    let resolveCommand;
    let rejectCommand;
    const commandPromise = new Promise((resolve, reject) => {
      resolveCommand = resolve;
      rejectCommand = reject;
    });
    const timeout = setTimeout(() => {
      this.pendingCommands.delete(id);
      rejectCommand(new Error(`Command timeout: ${action} (no response from mod)`));
    }, this.config.commandTimeoutMs);
    this.pendingCommands.set(id, {
      resolve: resolveCommand,
      reject: rejectCommand,
      timeout,
      action,
      timestamp: Date.now(),
    });
    log.debug(`sendCommand: pending action=${action} id=${id} (pending=${this.pendingCommands.size})`);

    // Serialize file access to prevent TOCTOU race conditions
    if (!this._writeQueue) this._writeQueue = Promise.resolve();

    let writeError = null;
    this._writeQueue = this._writeQueue
      .then(() => this._enqueueCommand(id, action, args))
      .catch(async (queueError) => {
        log.warn(`Queue write failed, falling back to legacy commands.json: ${queueError.message}`);
        await this._appendCommand(commandsFile, id, action, args);
      })
      .catch(err => { writeError = err; });
    await this._writeQueue;

    // If the command failed to write, reject immediately instead of waiting for timeout
    if (writeError) {
      const pending = this.pendingCommands.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingCommands.delete(id);
        pending.reject(new Error(`Failed to write command ${action}: ${writeError.message}`));
      }
    }

    // Resolve when the result arrives, including a result that arrived while
    // the serialized inbox write was still yielding.
    return commandPromise;
  }

  /**
   * Append a command to the commands file (serialized via _writeQueue)
   */
  _appendCommand(commandsFile, id, action, args) {
    let commands = { commands: [] };
    try {
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      if (fs.existsSync(commandsFile)) {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        const content = readModFileCapped(commandsFile);
        if (content.trim()) {
          commands = JSON.parse(content);
          if (!commands.commands) commands.commands = [];
        }
      }
    } catch (e) {
      log.debug(`Failed to parse commands file ${commandsFile}: ${e.message}`);
      commands = { commands: [] };
    }

    commands.commands.push({
      id,
      action,
      args,
      timestamp: Date.now()
    });

    const tempFile = commandsFile + '.tmp';
    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    writeFreshModFile(tempFile, JSON.stringify(commands, null, 2));
    try {
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      fs.renameSync(tempFile, commandsFile);
    } catch (err) {
      // If rename fails (file locked), try direct write as fallback
      log.warn(`renameSync failed, using direct write: ${err.message}`);
      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        writeModFileNoFollow(commandsFile, JSON.stringify(commands, null, 2));
      } catch (writeErr) {
        log.error(`Direct write also failed: ${writeErr.message}`);
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        try { fs.unlinkSync(tempFile); } catch (_) { /* ignore */ }
        throw writeErr; // Propagate so caller knows the command failed
      }
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      try { fs.unlinkSync(tempFile); } catch (_) { /* ignore */ }
    }
  }

  _enqueueCommand(id, action, args) {
    if (!this.queueState.initialized) {
      this.ensureQueueProtocol();
    }

    const seq = this.queueState.nextCommandSeq;
    const commandFile = this.getCommandFileBySeq(seq);
    const createdAt = Date.now();
    const payload = {
      protocolVersion: this.protocolVersion,
      seq,
      id,
      action,
      args,
      createdAt,
      expiresAt: createdAt + this.config.commandTimeoutMs + COMMAND_EXPIRY_SKEW_MS
    };

    const tempFile = `${commandFile}.tmp`;
    // Compact: the mod reads this file on the game thread, and indentation
    // only adds bytes for it to skip.
    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    writeFreshModFile(tempFile, JSON.stringify(payload));
    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    fs.renameSync(tempFile, commandFile);

    this.queueState.nextCommandSeq = seq + 1;
    this.persistQueueState();
  }

  /**
   * Poll for results from the mod
   */
  pollResults() {
    this.pollQueueResults();
    this.tryResyncInboxCommandCursor();
    this.pollLegacyResults();
    this.cleanupResultTracking();
    this.cleanupQueueFilesIfNeeded();
  }

  /**
   * Detects a stalled outbox cursor (missing result file at the expected
   * sequence for a sustained period) and, if the mod's own persisted write
   * position (queue-state-lua.json) disagrees with what we're waiting for,
   * resyncs lastConsumedResultSeq to match it instead of waiting forever
   * (or, if the mod is far ahead and already rotated the old file away,
   * effectively forever). Mirrors the equivalent fix in PanelBridge.lua
   * for the inbox/commands direction.
   *
   * Uses performance.now() (monotonic), not Date.now() (wall clock), for
   * the stuck-duration/next-check math -- bug hunt 2026-09-07 (Date.now()-
   * for-elapsed-time sweep): the old Date.now()-based version could have a
   * clock step backward (NTP correction, DST, a manual clock change) land
   * between the two reads, making `now` LESS than `nextCheckAt` far longer
   * than resyncStuckMs actually elapsed -- the exact "watchdog that misses
   * is absent, not late" shape, here meaning a genuinely desynced cursor
   * would never get the self-heal this function exists to provide until
   * real wall-clock time closed the gap the step introduced (which, for a
   * large correction, could be hours). Monotonic time cannot step
   * backward, so `now < nextCheckAt` can only ever be true because not
   * enough real time has passed yet, matching this function's actual
   * intent. (createdAt/expiresAt on the command payload itself, read by
   * the Lua side, stay on wall clock -- that's a cross-process timestamp
   * a different runtime has to parse, not an in-process duration.)
   */
  tryResyncOutboxCursor(seq) {
    const now = performance.now();
    if (this.outboxStuckState.seq !== seq) {
      this.outboxStuckState = { seq, since: now, nextCheckAt: now + this.queue.resyncStuckMs };
      return false;
    }
    if (now < this.outboxStuckState.nextCheckAt) {
      return false;
    }
    this.outboxStuckState.nextCheckAt = now + this.queue.resyncCheckIntervalMs;

    const luaStateFile = this.resolveModFile('queue-state-lua.json');
    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    if (!luaStateFile || !fs.existsSync(luaStateFile)) {
      return false;
    }

    let luaState;
    try {
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      luaState = JSON.parse(readModFileCapped(luaStateFile) || '{}');
    } catch (error) {
      log.debug(`Could not parse mod queue state during resync check: ${error.message}`);
      return false;
    }

    const luaNextResultSeq = Number(luaState.nextResultSeq);
    if (!Number.isFinite(luaNextResultSeq) || luaNextResultSeq < 1) {
      return false;
    }

    const luaHighWater = luaNextResultSeq - 1;
    if (luaHighWater === this.queueState.lastConsumedResultSeq) {
      // Genuinely idle and in sync — nothing to resync.
      return false;
    }

    // Forward-only, mirroring tryResyncInboxCommandCursor's identical guard
    // for the opposite (commands) direction -- see that function's comment
    // for the concrete incident this class of hazard already caused here.
    // A stale or racing read of the mod's own state file (SFTP transport
    // lag, a freshly-regenerated queue-state-lua.json, or a second bridge
    // process's write) can only ever show a LOWER luaHighWater than the
    // truth, never a fabricated higher one. Without this guard, rewinding
    // lastConsumedResultSeq backward makes pollQueueResults() re-walk every
    // seq between the rewound point and where it actually was -- each one
    // either already-cleared-but-not-yet-deleted (stalls ~1.5s per file in
    // the empty-read retry path) or already deleted (stalls resyncStuckMs
    // per file re-triggering this same check) -- silently stalling every
    // pending command's response for as long as that backlog takes to
    // re-drain, while the bridge still reports itself connected.
    if (luaHighWater < this.queueState.lastConsumedResultSeq) {
      return false;
    }

    log.warn(`Outbox sequence desync detected, resyncing to mod position (expected seq ${seq}, mod high-water ${luaHighWater})`);
    // Jumping lastConsumedResultSeq straight to luaHighWater would silently
    // throw away any result file that DOES physically exist in the gap
    // being skipped -- and over SFTP, commandTimeoutMs (60000ms) is longer
    // than resyncStuckMs (20000ms), so a still-pending command's real,
    // already-written response can be sitting in that gap when this fires.
    // Recover what's actually there before moving past it: a command whose
    // result gets skipped this way doesn't hang forever (its own timeout
    // still fires), but it fails with "no response from mod" when the mod
    // in fact responded successfully -- a misleading failure, not a
    // dropped one, but still wrong. A seq with no file in the gap (already
    // cleaned up, or genuinely never written -- the real desync case this
    // resync exists to heal) costs one cheap existsSync and is skipped.
    this.recoverSkippedResults(this.queueState.lastConsumedResultSeq, luaHighWater);
    this.queueState.lastConsumedResultSeq = luaHighWater;
    this.queueState.nextResultSeq = Math.max(this.queueState.nextResultSeq, luaNextResultSeq);
    this.persistQueueState();
    this.outboxStuckState.seq = null;
    return true;
  }

  /**
   * Scans (fromSeqExclusive, toSeqInclusive] for result files that still
   * physically exist and processes each one exactly like the normal poll
   * loop would, before tryResyncOutboxCursor jumps the cursor past them.
   * Bounded to the last retainRecentFiles entries of the gap -- anything
   * older than the retention window is already outside what
   * cleanupOutboxFiles guarantees keeping around, so scanning further back
   * than that cannot recover anything real and would only cost I/O on a
   * gap that can otherwise be arbitrarily large (e.g. a long-idle server
   * restarting after weeks).
   */
  recoverSkippedResults(fromSeqExclusive, toSeqInclusive) {
    const scanFrom = (toSeqInclusive - fromSeqExclusive) > this.queue.retainRecentFiles
      ? (toSeqInclusive - this.queue.retainRecentFiles + 1)
      : (fromSeqExclusive + 1);

    let recovered = 0;
    for (let seq = scanFrom; seq <= toSeqInclusive; seq++) {
      const resultFile = this.getResultFileBySeq(seq);
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      if (!resultFile || !fs.existsSync(resultFile)) continue;

      let raw;
      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        raw = readModFileCapped(resultFile);
      } catch (error) {
        log.debug(`Resync recovery: could not read result seq ${seq}: ${error.message}`);
        continue;
      }
      if (!raw.trim()) continue;

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        log.debug(`Resync recovery: could not parse result seq ${seq}: ${error.message}`);
        continue;
      }

      const result = parsed && parsed.result ? parsed.result : parsed;
      if (result) {
        this.processResult(result);
        recovered++;
      }

      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        clearModFile(resultFile);
      } catch (cleanupErr) {
        log.debug(`Resync recovery: failed to clear result file seq ${seq}: ${cleanupErr.message}`);
      }
    }

    if (recovered > 0) {
      log.warn(`Resync recovery: recovered ${recovered} result(s) that the missing-file check would otherwise have skipped past`);
    }
  }

  /**
   * Catches this process's nextCommandSeq up to Lua's actual lastCommandSeq
   * when the mod has processed further than this process ever wrote --
   * which happens when a DIFFERENT process (another panel instance pointed
   * at the same bridge folder) wrote some of those commands. Without this,
   * ensureQueueProtocol()'s own Math.max reconciliation against Lua's state
   * only ever runs ONCE per process lifetime (gated by queueState.initialized,
   * checked at bridge start) -- after that, nextCommandSeq lives purely in
   * memory, incremented one command at a time, with nothing to notice if
   * Lua's cursor moves past it from elsewhere. Four such processes sharing
   * one bridge folder is exactly how commandTimeoutMs-length hangs against an
   * idle server with zero players turned out to be a live queue desync, not
   * contention (2026-08-30 bridge-queue-timing investigation).
   *
   * Mirrors tryResyncOutboxCursor's shape for the opposite (results)
   * direction, but there's no "stuck waiting on a missing file" signal to
   * gate on here -- Node writes commands, it doesn't wait for them to be
   * written -- so this just re-checks on a plain interval instead of a
   * stuck-then-recheck one. Forward-only: it only ever raises nextCommandSeq,
   * never lowers it, so it can't undo real in-flight work even if this read
   * races a moment where Lua's file is stale.
   */
  tryResyncInboxCommandCursor() {
    const now = Date.now();
    if (now < this.inboxResyncNextCheckAt) {
      return false;
    }
    this.inboxResyncNextCheckAt = now + this.queue.resyncCheckIntervalMs;

    const luaStateFile = this.resolveModFile('queue-state-lua.json');
    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    if (!luaStateFile || !fs.existsSync(luaStateFile)) {
      return false;
    }

    let luaState;
    try {
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      luaState = JSON.parse(readModFileCapped(luaStateFile) || '{}');
    } catch (error) {
      log.debug(`Could not parse mod queue state during inbox resync check: ${error.message}`);
      return false;
    }

    const luaLastCommandSeq = Number(luaState.lastCommandSeq);
    if (!Number.isFinite(luaLastCommandSeq) || luaLastCommandSeq < 0) {
      return false;
    }

    const luaNextExpected = luaLastCommandSeq + 1;
    if (luaNextExpected <= this.queueState.nextCommandSeq) {
      // Lua hasn't gotten ahead of what this process expects -- normal case,
      // nothing to catch up.
      return false;
    }

    log.warn(`Command sequence desync detected: mod has processed through ${luaLastCommandSeq} but this process only expected to reach ${this.queueState.nextCommandSeq - 1}; advancing to avoid reusing already-consumed sequence numbers`);
    this.queueState.nextCommandSeq = luaNextExpected;
    this.persistQueueState();
    return true;
  }

  pollQueueResults() {
    if (!this.queueState.initialized) {
      try {
        this.ensureQueueProtocol();
      } catch (error) {
        log.debug(`Queue init not ready during poll: ${error.message}`);
        return;
      }
    }

    const maxToRead = this.queue.maxResultsPerPoll;
    let consumed = 0;
    while (consumed < maxToRead) {
      const seq = this.queueState.lastConsumedResultSeq + 1;
      const resultFile = this.getResultFileBySeq(seq);
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      if (!resultFile || !fs.existsSync(resultFile)) {
        if (this.tryResyncOutboxCursor(seq)) {
          // Resynced to the mod's actual write position; loop back around
          // and retry immediately at the new expected sequence.
          continue;
        }
        break;
      }

      let parsed = null;
      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        const raw = readModFileCapped(resultFile);
        if (!raw.trim()) {
          // Lua may have just opened the file for writing (truncates immediately
          // with getFileWriter append=false) but not yet flushed content.
          // Retry on the next poll instead of advancing past a real result.
          // After ~10 polls (~1.5s) treat the file as genuinely empty/orphaned
          // and advance with a warning so we don't stall forever.
          if (!this._emptyReadCounter) this._emptyReadCounter = { seq: 0, count: 0 };
          if (this._emptyReadCounter.seq !== seq) {
            this._emptyReadCounter.seq = seq;
            this._emptyReadCounter.count = 0;
          }
          this._emptyReadCounter.count++;
          if (this._emptyReadCounter.count >= 10) {
            log.warn(`Queue result seq ${seq} empty for ${this._emptyReadCounter.count} polls, advancing past it`);
            this.queueState.lastConsumedResultSeq = seq;
            this.queueState.nextResultSeq = Math.max(this.queueState.nextResultSeq, seq + 1);
            this._emptyReadCounter.count = 0;
            consumed++;
            continue;
          }
          break;
        }
        // Reset retry counter once we successfully read content
        if (this._emptyReadCounter) this._emptyReadCounter.count = 0;
        parsed = JSON.parse(raw);
      } catch (error) {
        if (isUnreadableBridgeFile(error)) {
          // Never read: skipped like an orphaned empty result, so one
          // oversized file can't stall the queue (its command times out).
          this.queueState.lastConsumedResultSeq = seq;
          this.queueState.nextResultSeq = Math.max(this.queueState.nextResultSeq, seq + 1);
          consumed++;
          continue;
        }
        log.debug(`Queue result parse error for seq ${seq}: ${error.message}`);
        break;
      }

      const result = parsed && parsed.result ? parsed.result : parsed;
      if (result) {
        this.processResult(result);
      }

      this.queueState.lastConsumedResultSeq = seq;
      this.queueState.nextResultSeq = Math.max(this.queueState.nextResultSeq, seq + 1);
      consumed++;

      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        clearModFile(resultFile);
      } catch (cleanupErr) {
        log.debug(`Failed to clear result file seq ${seq}: ${cleanupErr.message}`);
      }
    }

    if (consumed > 0) {
      this.persistQueueState();
    }
  }

  pollLegacyResults() {
    const resultsFile = this.getResultsFile();
    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    if (!resultsFile || !fs.existsSync(resultsFile)) {
      return;
    }

    try {
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      const content = readModFileCapped(resultsFile);
      if (!content.trim()) return;

      const data = JSON.parse(content);

      if (data.results && Array.isArray(data.results)) {
        for (const result of data.results) {
          this.processResult(result);
        }
      }

    } catch (e) {
      // File might be mid-write by the Lua mod — log at debug level so it's
      // visible in verbose mode without spamming normal logs.
      log.debug(`pollResults read error (likely mid-write): ${e.message}`);
    }
  }

  cleanupResultTracking() {
    // Cleanup old processed IDs (keep last 100, hard cap at 500)
    if (this.processedResults.size > 500) {
      this.processedResults.clear();
    } else if (this.processedResults.size > 100) {
      let count = 0;
      for (const [key] of this.processedResults) {
        this.processedResults.delete(key);
        count++;
        if (count >= 50) break;
      }
    }

    // Cleanup stale pending commands that somehow missed their timeout.
    const now = Date.now();
    const maxPendingAge = (this.config.commandTimeoutMs || 30000) * 2;
    for (const [id, cmd] of this.pendingCommands) {
      if (now - cmd.timestamp > maxPendingAge) {
        clearTimeout(cmd.timeout);
        this.pendingCommands.delete(id);
        // Same failure class as an isChecking latch left set on early return:
        // deleting the map entry here without rejecting leaves sendCommand()'s
        // promise with no path left to ever settle if this sweep wins the
        // race against the command's own timeout (which normally rejects via
        // its closure directly, not through the map) -- e.g. after a long
        // stall/suspend, when Node fires every now-overdue timer in one
        // catch-up burst and this interval-driven sweep's tick can beat the
        // individual command's timer to it.
        cmd.reject(new Error(`Command timeout: ${cmd.action} (stale pending command cleaned up, no response from mod)`));
        log.warn(`Cleaned up stale pending command: ${cmd.action} (age: ${Math.round((now - cmd.timestamp) / 1000)}s)`);
      }
    }
  }

  cleanupQueueFilesIfNeeded() {
    const now = Date.now();
    if (now - this.lastQueueCleanupAt < this.queue.cleanupIntervalMs) {
      return;
    }
    this.lastQueueCleanupAt = now;

    try {
      this.cleanupInboxFiles();
    } catch (error) {
      log.debug(`Queue inbox cleanup skipped: ${error.message}`);
    }

    try {
      this.cleanupOutboxFiles();
    } catch (error) {
      log.debug(`Queue outbox cleanup skipped: ${error.message}`);
    }
  }

  cleanupInboxFiles() {
    const inboxDir = this.getInboxDir();
    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    if (!inboxDir || !fs.existsSync(inboxDir)) return;

    // Sweep orphaned .tmp files from interrupted atomic writes regardless of cursor state.
    // Age-gated (see isOldEnoughToSweep above) -- a .tmp file this fresh may
    // still be mid-write, not orphaned.
    try {
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      for (const fileName of fs.readdirSync(inboxDir)) {
        if (fileName.endsWith('.tmp')) {
          // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
          const tmpPath = path.join(inboxDir, fileName);
          if (!isOldEnoughToSweep(tmpPath)) continue;
          try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* ignore */ }

    const cursorFile = this.getInboxCursorFile();
    let lastProcessedSeq = 0;
    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    if (cursorFile && fs.existsSync(cursorFile)) {
      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        const cursor = JSON.parse(readModFileCapped(cursorFile) || '{}');
        const parsed = Number(cursor.lastProcessedSeq);
        if (Number.isFinite(parsed) && parsed > 0) {
          lastProcessedSeq = Math.floor(parsed);
        }
      } catch (error) {
        log.debug(`Could not parse inbox cursor file: ${error.message}`);
      }
    }

    if (lastProcessedSeq <= this.queue.retainRecentFiles) {
      return;
    }

    const deleteUpToSeq = lastProcessedSeq - this.queue.retainRecentFiles;
    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    const files = fs.readdirSync(inboxDir);
    let deleted = 0;
    for (const fileName of files) {
      // Sweep .tmp orphans from interrupted writes (atomic temp+rename pattern).
      // Age-gated, same reasoning as the sweep above.
      if (fileName.endsWith('.tmp')) {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        const tmpPath = path.join(inboxDir, fileName);
        if (isOldEnoughToSweep(tmpPath)) {
          try { fs.unlinkSync(tmpPath); deleted++; } catch (_) { /* ignore */ }
        }
        continue;
      }
      const seq = this.extractSeq(fileName, /^cmd-(\d+)\.json$/);
      if (seq !== null && seq <= deleteUpToSeq) {
        try {
          // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
          fs.unlinkSync(path.join(inboxDir, fileName));
          deleted++;
        } catch (_) {
          // Ignore cleanup failures.
        }
      }
    }

    if (deleted > 0) {
      log.debug(`Queue cleanup removed ${deleted} old inbox files (<= seq ${deleteUpToSeq})`);
    }
  }

  cleanupOutboxFiles() {
    const outboxDir = this.getOutboxDir();
    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    if (!outboxDir || !fs.existsSync(outboxDir)) return;

    // Sweep orphaned .tmp files first, regardless of cursor state. Age-gated,
    // same reasoning as cleanupInboxFiles above.
    try {
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      for (const fileName of fs.readdirSync(outboxDir)) {
        if (fileName.endsWith('.tmp')) {
          // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
          const tmpPath = path.join(outboxDir, fileName);
          if (!isOldEnoughToSweep(tmpPath)) continue;
          try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* ignore */ }

    if (this.queueState.lastConsumedResultSeq <= this.queue.retainRecentFiles) {
      return;
    }

    const deleteUpToSeq = this.queueState.lastConsumedResultSeq - this.queue.retainRecentFiles;
    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    const files = fs.readdirSync(outboxDir);
    let deleted = 0;
    for (const fileName of files) {
      const seq = this.extractSeq(fileName, RESULT_FILE_PATTERN);
      if (seq !== null && seq <= deleteUpToSeq) {
        try {
          // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
          fs.unlinkSync(path.join(outboxDir, fileName));
          deleted++;
        } catch (_) {
          // Ignore cleanup failures.
        }
      }
    }

    if (deleted > 0) {
      log.debug(`Queue cleanup removed ${deleted} old outbox files (<= seq ${deleteUpToSeq})`);
    }
  }

  extractSeq(fileName, pattern) {
    const match = fileName.match(pattern);
    if (!match) return null;
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed)) return null;
    return Math.floor(parsed);
  }

  processResult(result) {
    if (!result || !result.id) return;

    if (this.processedResults.has(result.id)) return;
    this.processedResults.set(result.id, Date.now());

    const pending = this.pendingCommands.get(result.id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingCommands.delete(result.id);
      const elapsed = Date.now() - pending.timestamp;

      if (result.success) {
        log.debug(`PanelBridge result: action=${pending.action} success=true (${elapsed}ms)`);
        pending.resolve({ success: true, data: result.data });
      } else {
        // Downgrade chat failures to debug (RCON servermsg is the primary path; bridge chat is a secondary boost)
        const isChatFallback = pending.action === 'sendToServerChat' || pending.action === 'sendToAdminChat' || pending.action === 'sendToGeneralChat';
        const logLevel = isChatFallback ? 'debug' : 'warn';
        log[logLevel](`PanelBridge result: action=${pending.action} failed: ${result.error || 'unknown'} (${elapsed}ms)`);
        // Some handlers return a "soft failure" with a rich diagnostic table
        // instead of (or in addition to) an error string -- e.g. killPlayer's
        // not-dead path sets no error at all, only data.message; teleportPlayer's
        // verify-false path sets both. Previously this whole data table was
        // dropped here regardless, so a handler could craft the most honest,
        // diagnostic-rich failure imaginable and the caller would only ever see
        // "Command failed". Preserve result.error as the message whenever it's
        // present (unchanged behavior); only fall back to data.message when
        // there's no error string, and always attach the full data table to
        // the rejected Error so a caller that wants the diagnostics can get them.
        const message = result.error || result.data?.message || 'Command failed';
        const err = new Error(message);
        err.data = result.data;
        pending.reject(err);
      }
    } else {
      // The mod DID answer -- just not before this command's own timeout
      // (the setTimeout in sendCommand()) already fired, rejected the
      // original caller with "no response from mod", and deleted this id
      // from pendingCommands. Without this log, that answer -- success or
      // failure -- vanishes with zero trace: the caller already saw a
      // timeout, and nothing recorded that the mod's real result showed up
      // after all. Same silent-loss hazard already named above for the
      // seq-desync recovery path (recoverSkippedResults' header comment,
      // "fails with 'no response from mod' when the mod in fact responded
      // successfully") -- this is the ordinary route to it, no desync
      // required, just an answer slower than commandTimeoutMs.
      const lateMs = typeof result.timestamp === 'number' ? Date.now() - result.timestamp : null;
      log.warn(
        `PanelBridge result: orphaned result id=${result.id} success=${result.success}` +
        (lateMs !== null
          ? ` -- mod answered ${lateMs}ms after its command's own timeout had already fired; discarded, caller already saw a timeout failure`
          : ` -- arrived after its command's own timeout had already fired; discarded, caller already saw a timeout failure`)
      );
    }

    this.emit('result', result);
  }

  /**
   * Check mod status
   */
  checkModStatus() {
    const statusFile = this.getStatusFile();

    // Check if file exists
    if (!statusFile) {
      this.handleStatusFailure('No status file path configured');
      return;
    }

    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    if (!fs.existsSync(statusFile)) {
      this.handleStatusFailure('Status file does not exist');
      return;
    }

    try {
      // Check file modification time first (faster than reading)
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      const stats = fs.statSync(statusFile);

      // This exact write is the last heartbeat of a server process the
      // watchdog has since seen exit (markServerExited()). Its age says
      // nothing about a mod that no longer exists, and the idle tolerance
      // below would read it back in as live for up to five minutes. Any
      // other mtime is a new write -- a server is up again -- so normal
      // checking resumes from there.
      if (this.exitedServerStatusMtimeMs !== null) {
        if (stats.mtimeMs === this.exitedServerStatusMtimeMs) return;
        this.exitedServerStatusMtimeMs = null;
        this.serverRunningAgainSinceMs = null;
      }

      const age = Date.now() - stats.mtimeMs;

      // Use relaxed threshold when server is idle (0 players) — PZ stops Lua ticks with no players
      const staleThreshold = (this.modStatus?.playerCount === 0)
        ? this.config.statusStaleIdleMs
        : this.config.statusStaleMs;

      // If file hasn't changed since last check and we have valid status (not just waiting), skip full re-read
      // Always re-read if modStatus is in waiting state (version is null) to pick up initial data
      const hasValidStatus = this.modStatus && !this.modStatus.waiting && this.modStatus.version;
      if (stats.mtimeMs === this.lastStatusFileCheck && hasValidStatus) {
        // Just update age in existing status
        if (this.modStatus.age !== age) {
          this.modStatus.age = age;
          this.modStatus.alive = age < staleThreshold;
          if (!this.modStatus.alive && this.modStatus._wasAlive) {
            this.modStatus._wasAlive = false;
            this.emit('modStatus', this.modStatus);
          }
        }
        return;
      }

      // Read and parse the file
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      const content = readModFileCapped(statusFile);
      if (!content.trim()) {
        this.handleStatusFailure('Status file is empty');
        return;
      }

      const status = JSON.parse(content);

      // Update tracking
      this.lastStatusFileCheck = stats.mtimeMs;
      this.consecutiveFailures = 0; // Reset failure counter on success

      // Determine if status is stale
      // Use relaxed threshold when server is idle (0 players) — PZ stops Lua ticks with no players
      const fullReadStaleThreshold = (status.playerCount === 0)
        ? this.config.statusStaleIdleMs
        : this.config.statusStaleMs;
      status.alive = age < fullReadStaleThreshold;
      status.age = age;
      status._wasAlive = status.alive;
      status.filePath = statusFile;

      // panelbridge-lua-version-handshake: the mod has written its own
      // protocolVersion into every status.json since PROTOCOL_VERSION was
      // added (PanelBridge.lua's updateStatus()) -- this side just never
      // read it back. Nothing new needed from the mod; the field already
      // ships today. Surfaced, not enforced: mod and panel are shipped as
      // one hand-synced pair today with no compatibility matrix behind
      // them (deliberately not built -- see the card), so a mismatch means
      // one side of that pair got updated without the other, not a known
      // "these two versions can't talk" case this could safely reject.
      // Logs once per distinct mismatch and rides along on modStatus for
      // any future diagnostic/UI to read; never blocks a command or marks
      // the mod unreachable over it.
      if (status.protocolVersion && status.protocolVersion !== this.protocolVersion) {
        status.protocolVersionMismatch = { expected: this.protocolVersion, actual: status.protocolVersion };
        if (this.loggedProtocolVersionMismatch !== status.protocolVersion) {
          this.loggedProtocolVersionMismatch = status.protocolVersion;
          log.warn(`PanelBridge protocol version mismatch: panel expects '${this.protocolVersion}', mod reports '${status.protocolVersion}' -- they ship as a bundled pair, so this usually means one side was updated without the other`);
        }
      } else if (this.loggedProtocolVersionMismatch) {
        this.loggedProtocolVersionMismatch = null; // resolved (mod redeployed) -- re-warn if it recurs
      }

      // Track player connections and disconnections
      if (status.alive && status.players) {
        // The first alive read of a bridge session (panel restart, bridge
        // restart, server switch) only learns who is already online: those
        // players did not just join, so it is recorded silently. The RCON
        // poll does the same with playerBaselineReady.
        const baseline = !this.playersBaselined;
        this.playersBaselined = true;
        this.trackPlayerActivity(status.players, { silent: baseline });
      }
      if (status.alive) {
        this.trackPlayerDeaths(status);
      }

      // Emit status change (always emit if alive status changed or it's a new status)
      const aliveChanged = this.modStatus?.alive !== status.alive;
      const isNewStatus = !this.modStatus;
      const dataChanged = JSON.stringify(status) !== JSON.stringify(this.modStatus);

      if (aliveChanged || isNewStatus || dataChanged) {
        this.modStatus = status;
        this.emit('modStatus', status);

        if (status.alive && (aliveChanged || isNewStatus)) {
          log.info(`Mod connected (age: ${Math.round(age / 1000)}s, players: ${status.playerCount})`);
        }
      }
    } catch (e) {
      this.handleStatusFailure(`Parse error: ${e.message}`);
    }
  }

  /**
   * Handle status check failure
   */
  handleStatusFailure(reason) {
    this.consecutiveFailures++;

    // Only log occasionally to avoid spam
    if (this.consecutiveFailures === 1 || this.consecutiveFailures % 10 === 0) {
      log.debug(`Status check failed (${this.consecutiveFailures}x): ${reason}`);
    }

    // Update mod status to disconnected after several failures
    if (this.modStatus?.alive && this.consecutiveFailures >= this.maxConsecutiveFailures) {
      // Close out every currently-tracked player's session BEFORE wiping
      // modStatus.players below. trackPlayerActivity()'s connect/disconnect
      // diffing (against this.previousPlayers) only ever ran from a fresh,
      // alive status read in checkModStatus() -- a player connected at the
      // moment the mod goes offline (server crash, hang, or stop) never got
      // a "disconnect" recorded, because nothing here called it. That
      // matters beyond this in-memory status: recordPlayerSession() only
      // accumulates total_playtime_seconds on "disconnect" -- with no
      // matching call, that player's still-open session (last_session_start)
      // just sits there and gets silently overwritten the next time they
      // connect, dropping the elapsed time for every ordinary server
      // crash/stop/restart with anyone online, not some rare edge case.
      // maxConsecutiveFailures=5 at a 1s poll interval means this only
      // fires after 5 straight seconds of no fresh status -- long enough
      // that a transient blip (a single slow disk write, a GC pause)
      // resolves before ever reaching here, so this isn't trading a real
      // bug for spurious disconnect noise on routine jitter.
      this.trackPlayerActivity([]);
      // Preserve last known version, serverName, etc. when going offline
      // Don't set playerCount - undefined means unknown (offline), 0 means online with no players
      this.modStatus = {
        ...this.modStatus,
        alive: false,
        error: reason,
        consecutiveFailures: this.consecutiveFailures,
        lastPath: this.bridgePath,
        playerCount: undefined,
        players: []
      };
      this.emit('modStatus', this.modStatus);
      log.warn(`Mod marked as disconnected after ${this.consecutiveFailures} failures`);
    } else if (!this.modStatus) {
      this.modStatus = { alive: false, waiting: true, version: null, playerCount: undefined, players: [] };
    }
  }

  /**
   * Player deaths the mod reports in status.json (`deaths`: the last few,
   * oldest first, numbered from 1 each time the server starts).
   *
   * SECURITY (2026-10-04, BRIDGE-1 adversary pass): deaths used to come only
   * from the game's user log, and a co-op (split-screen) player's name skips
   * the server's username check, so it can carry line breaks and whole fake
   * "[timestamp] user X died at ..." lines -- a forged death for any player,
   * which no parsing of that log can tell from a real one. A bridge that
   * sends `deaths` takes over (reportsPlayerDeaths(); index.js then ignores
   * the log's deaths). A name with a control character is the co-op trick
   * itself, so it is dropped rather than reported under a mangled name.
   *
   * The first status read for a bridge folder only records where the list
   * stands: those deaths happened before the panel was watching. A new
   * startedAt is a server restart, whose numbering starts over.
   */
  trackPlayerDeaths(status) {
    if (!Array.isArray(status.deaths)) return;
    const run = status.startedAt ?? null;
    const deaths = status.deaths.filter(
      (death) =>
        death &&
        Number.isSafeInteger(death.seq) &&
        death.seq > 0 &&
        typeof death.username === 'string' &&
        death.username !== '',
    );
    if (this.deathTracking === null) {
      this.deathTracking = {
        run,
        lastSeq: deaths.reduce((max, death) => Math.max(max, death.seq), 0),
      };
      return;
    }
    if (this.deathTracking.run !== run) {
      this.deathTracking = { run, lastSeq: 0 };
    }
    for (const death of deaths) {
      if (death.seq <= this.deathTracking.lastSeq) continue;
      this.deathTracking.lastSeq = death.seq;
      if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(death.username)) {
        log.warn('Ignoring a reported player death whose name contains a control character');
        continue;
      }
      const x = Math.trunc(Number(death.x)) || 0;
      const y = Math.trunc(Number(death.y)) || 0;
      const z = Math.trunc(Number(death.z)) || 0;
      this.emit('playerDeath', {
        player: death.username,
        x,
        y,
        z,
        pvp: death.pvp === true,
        location: `${x},${y},${z}`,
        timestamp: new Date(),
      });
    }
  }

  /**
   * True while a live mod reports player deaths itself (see
   * trackPlayerDeaths()); the game's user log is only the fallback then.
   */
  reportsPlayerDeaths() {
    return Boolean(this.modStatus?.alive && Array.isArray(this.modStatus.deaths));
  }

  /**
   * Track player connect/disconnect events.
   *
   * `silent` still records the sessions and player history but tells the
   * playerConnect/playerDisconnect listeners (second argument, `{ silent }`)
   * that nobody actually joined or left, so Discord posts and auto-export
   * skip them.
   */
  trackPlayerActivity(currentPlayers, { silent = false } = {}) {
    // Normalize players: PanelBridge.lua's own JSON encoder (kind_of()) defaults an empty table to
    // [] on the wire, not {} -- but handle both shapes defensively anyway, since nothing here
    // depends on which one actually arrives and a future encoder change shouldn't be able to break this.
    const playerList = Array.isArray(currentPlayers) ? currentPlayers : Object.keys(currentPlayers || {});
    const current = new Set(playerList);
    const previous = this.previousPlayers;
    // The server this bridge session belongs to (see start()); without it the
    // database falls back to the active server.
    const serverArgs = this.sessionServerId !== undefined ? [this.sessionServerId] : [];

    // Find players who joined (in current but not in previous)
    for (const player of current) {
      if (!previous.has(player)) {
        logPlayerAction(player, 'connect', 'Player connected to server', ...serverArgs).catch(err => log.debug(`Failed to log player connect: ${err.message}`));
        recordPlayerSession(player, 'connect', ...serverArgs).catch(err => log.debug(`Failed to record player connect session: ${err.message}`));
        this.emit('playerConnect', player, { silent });
      }
    }

    // Find players who left (in previous but not in current)
    for (const player of previous) {
      if (!current.has(player)) {
        logPlayerAction(player, 'disconnect', 'Player disconnected from server', ...serverArgs).catch(err => log.debug(`Failed to log player disconnect: ${err.message}`));
        recordPlayerSession(player, 'disconnect', ...serverArgs).catch(err => log.debug(`Failed to record player disconnect session: ${err.message}`));
        this.emit('playerDisconnect', player, { silent });
      }
    }

    // Update previous players set
    this.previousPlayers = current;
  }

  /**
   * Detect a host suspend/pause (laptop sleep, VM pause) by watching for the
   * wall-clock gap between heartbeat ticks. See SUSPEND_GAP_THRESHOLD_MS's
   * own comment for why this can't just reuse checkModStatus()'s existing
   * staleness check: that measures the MOD's liveness (the status file's own
   * age), which conflates "host was frozen" with "game server crashed" --
   * two different problems needing two different responses. This measures
   * the PANEL PROCESS's own wall clock directly, independent of the mod.
   */
  async checkHeartbeat() {
    const now = Date.now();
    const gap = now - this.lastHeartbeatAt - this.config.heartbeatIntervalMs;
    this.lastHeartbeatAt = now;

    if (gap < SUSPEND_GAP_THRESHOLD_MS) return;

    log.warn(`Detected a ${formatAge(gap)} gap since the last heartbeat -- host was likely suspended/paused. Subtracting it from every in-flight player session.`);
    try {
      const { adjustedPlayers } = await applySuspendGapToInFlightSessions(gap);
      await logServerEvent(
        'host_suspend_detected',
        `Detected a ~${formatAge(gap)} gap since the last heartbeat (host suspend/pause?)` +
          (adjustedPlayers.length > 0
            ? `; subtracted from ${adjustedPlayers.length} in-flight session(s): ${adjustedPlayers.join(', ')}`
            : '; no players were online at the time'),
      );
    } catch (err) {
      log.warn(`Failed to record host-suspend diagnostic event: ${err.message}`);
    }
  }

  /**
   * Get current status with detailed diagnostics
   */
  getStatus() {
    const statusFile = this.getStatusFile();
    let fileInfo = null;

    if (statusFile) {
      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        if (fs.existsSync(statusFile)) {
          // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
          const stats = fs.statSync(statusFile);
          fileInfo = {
            exists: true,
            path: statusFile,
            size: stats.size,
            modified: stats.mtime,
            age: Date.now() - stats.mtimeMs,
            ageSeconds: Math.round((Date.now() - stats.mtimeMs) / 1000)
          };
        } else {
          fileInfo = { exists: false, path: statusFile };
        }
      } catch (e) {
        fileInfo = { exists: false, error: e.message };
      }
    }

    return {
      configured: !!this.bridgePath,
      bridgePath: this.bridgePath,
      isRunning: this.isRunning,
      pendingCommands: this.pendingCommands.size,
      modStatus: this.modStatus,
      connection: this.getConnectionDiagnostics(),
      consecutiveFailures: this.consecutiveFailures,
      config: {
        statusStaleMs: this.config.statusStaleMs,
        pollIntervalMs: this.config.pollIntervalMs,
        statusCheckMs: this.config.statusCheckMs
      },
      statusFile: fileInfo,
      hasFileWatcher: !!this.fileWatcher,
      transport: this.sftpTransport?.getStatus() || { type: 'local', running: this.isRunning }
      // lastSftpTransport (this.lastSftpStatus) intentionally dropped from
      // this response, sweep-round5 (2026-09-07): grepped client/src --
      // never read anywhere, not even in a TypeScript type declaration.
      // this.lastSftpStatus itself is left alone (harmless internal
      // bookkeeping, written once elsewhere in this file); only the
      // outward-facing HTTP field is removed.
    };
  }

  /**
   * Check if mod is connected and responsive
   */
  isModConnected() {
    return this.modStatus?.alive === true;
  }

  /**
   * The active game server is confirmed stopped: the status watchdog
   * (server/index.js's checkServerStatusNow) reached a new stopped verdict,
   * a panel stop (routes/server.js's /stop, /force-stop, graceful-stop
   * monitor) confirmed the process, unit or container gone, or a restart
   * (Scheduler.performRestart()) confirmed the old process exited.
   * status.json is the mod's only heartbeat and checkModStatus() judges it
   * purely by the file's age, so without this the last write an exited
   * server made kept the mod "connected" for up to statusStaleIdleMs
   * (5 minutes) after a quiet stop -- on the Dashboard's PanelBridge line,
   * in Settings > Bridge (getConnectionDiagnostics() treats the pinned write
   * as stale too), and for every bridge command, which then waited out its
   * full timeout against a mod that was gone. Pins that write as dead
   * (checkModStatus() skips it until the file changes) and marks the mod
   * offline now, the same way a heartbeat that aged out is marked:
   * alive=false plus one modStatus event.
   *
   * For a native (including a managed systemd/openrc unit) or Docker host
   * that verdict is the host signal itself; for a remote host the verdict
   * already required this heartbeat to be dead (see isServerObservedRunning),
   * so pinning it changes nothing there. One accepted edge: a live PZ
   * process the completed scan cannot attribute to this server is "stopped"
   * to the watchdog too -- including on its first observation after every
   * panel restart -- so its mod reads offline, and bridge commands are
   * refused, until its next status.json write clears the pin (every few
   * seconds while the mod ticks).
   */
  markServerExited() {
    this.serverRunningAgainSinceMs = null;
    const statusFile = this.getStatusFile();
    try {
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      if (statusFile && fs.existsSync(statusFile)) {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        this.exitedServerStatusMtimeMs = fs.statSync(statusFile).mtimeMs;
      }
    } catch (e) {
      // Nothing pinned: the normal age check still expires the heartbeat.
      log.debug(`Could not pin the exited server's status file: ${e.message}`);
    }

    if (this.modStatus?.alive) {
      this.modStatus.alive = false;
      this.modStatus._wasAlive = false;
      this.emit('modStatus', this.modStatus);
      log.info('Mod marked as disconnected: the game server process exited');
    }
  }

  /**
   * The active game server is observed running again: the status
   * watchdog's running verdict, or a restart's verified start. Nothing
   * cleared the "stopped" diagnostic before this but the mod's next write,
   * and that write only comes once the new process has loaded its world --
   * minutes on Build 42, never if the mod broke on an update -- so
   * Settings > Bridge and the Events page kept saying the server was
   * stopped while it ran. From here getConnectionDiagnostics() says how long
   * the running server's mod has been silent instead.
   *
   * The pin itself stays: the exited write is still dead, and releasing it
   * here would let the idle tolerance read it back in as a live mod for up
   * to five minutes. Only a new write clears it (checkModStatus()). A no-op
   * with nothing pinned, and repeat calls keep the first sighting's time,
   * so the watchdog can call this on every running tick.
   */
  markServerRunning() {
    if (this.exitedServerStatusMtimeMs === null || this.serverRunningAgainSinceMs !== null) return;
    this.serverRunningAgainSinceMs = Date.now();
  }

  // sweep-round5 follow-up (2026-09-07, release-1-2-17): ping() used to
  // spread the FULL this.modStatus into its response -- an allow-list
  // hazard, not just an oversight, since modStatus is shared internal
  // state that legitimately carries fields this route was never meant to
  // expose: path (the mod's own base path on the game server) and
  // filePath (the panel's local status-file path, i.e. the SFTP mirror
  // dir for a remote server) leaked the same class of filesystem paths
  // /status did, and players (a live online-username list) bypassed
  // players.view entirely, unlike every other route that exposes player
  // presence -- reachable by ANY authenticated session regardless of
  // role. Deliberately narrows what ping()'s RESPONSE merges in, not
  // modStatus itself (still passed whole to getStatus() and elsewhere) --
  // and deliberately an allow-list (only serverName, the one field
  // Settings.tsx's handlePingMod actually reads), not a delete-list: a
  // subtract-list silently re-leaks the next field someone adds to
  // modStatus, which is exactly how this one happened.
  pingModStatusView() {
    return { serverName: this.modStatus?.serverName ?? null };
  }

  /**
   * Convenience method: ping the mod
   */
  async ping() {
    if (!this.isRunning) {
      return { success: false, error: 'Bridge not running' };
    }
    if (!this.isModConnected()) {
      return { success: false, error: 'Mod not connected', modStatus: this.pingModStatusView() };
    }
    try {
      const result = await this.sendCommand('ping', {});
      // Include a narrowed modStatus view in the response for the frontend
      return { ...result, modStatus: this.pingModStatusView() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Convenience method: get weather info
   */
  async getWeather() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('getWeather', {});
  }

  /**
   * Convenience method: get server info
   */
  async getServerInfo() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('getServerInfo', {});
  }

  /**
   * Convenience method: trigger blizzard
   */
  async triggerBlizzard(duration = 1.0) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('triggerBlizzard', { duration });
  }

  /**
   * Convenience method: trigger tropical storm
   */
  async triggerTropicalStorm(duration = 1.0) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('triggerTropicalStorm', { duration });
  }

  /**
   * Convenience method: trigger storm
   */
  async triggerStorm(duration = 1.0) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('triggerStorm', { duration });
  }

  /**
   * Convenience method: stop weather
   */
  async stopWeather() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('stopWeather', {});
  }

  /**
   * Convenience method: set snow
   */
  async setSnow(enabled = true, intensity = null) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    const args = { enabled };
    if (intensity !== null) args.intensity = intensity;
    return this.sendCommand('setSnow', args);
  }

  // =============================================
  // NEW V1.1.0 METHODS
  // =============================================

  /**
   * Convenience method: start rain
   */
  async startRain(intensity = 0.5) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('startRain', { intensity });
  }

  /**
   * Convenience method: stop rain
   */
  async stopRain() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('stopRain', {});
  }

  /**
   * Convenience method: trigger lightning
   */
  async triggerLightning(x = null, y = null, strike = true, light = true, rumble = true) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('triggerLightning', { x, y, strike, light, rumble });
  }

  /**
   * Convenience method: set climate float value (admin control)
   * @param {number} floatId - ClimateFloat ID (0-12)
   * @param {number} value - Value to set
   * @param {boolean} enable - Enable admin override
   */
  async setClimateFloat(floatId, value, enable = true) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('setClimateFloat', { floatId, value, enable });
  }

  /**
   * Convenience method: get all climate floats
   */
  async getClimateFloats() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('getClimateFloats', {});
  }

  /**
   * Convenience method: reset all climate overrides
   */
  async resetClimateOverrides() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('resetClimateOverrides', {});
  }

  /**
   * Convenience method: get game time
   */
  async getGameTime() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('getGameTime', {});
  }

  /**
   * Convenience method: set game time
   */
  async setGameTime(options = {}) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('setGameTime', options);
  }

  /**
   * Convenience method: get world stats
   */
  async getWorldStats() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('getWorldStats', {});
  }

  /**
   * Convenience method: get player details
   */
  async getPlayerDetails(username) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('getPlayerDetails', { username });
  }

  /**
   * Convenience method: get all player details
   */
  async getAllPlayerDetails() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('getAllPlayerDetails', {});
  }

  /**
   * The leaderboard. `source` says who asked (page, character, sampler,
   * bundle); bridges after 1.7.73 record it on each row they read, older
   * ones ignore it.
   */
  async getLeaderboard({ source } = {}) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('getLeaderboard', source ? { source } : {});
  }

  /**
   * Convenience method: teleport player
   */
  async teleportPlayer(username, x, y, z = 0) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('teleportPlayer', { username, x, y, z });
  }

  /**
   * Convenience method: get sandbox options
   */
  async getSandboxOptions() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('getSandboxOptions', {});
  }

  // =============================================
  // V1.2.0 SOUND/NOISE METHODS
  // =============================================

  /**
   * Play a sound at specific world coordinates (zombies will hear it)
   * @param {number} x - World X coordinate
   * @param {number} y - World Y coordinate
   * @param {number} z - World Z coordinate (default 0)
   * @param {number} radius - Sound radius (default 50)
   * @param {number} volume - Sound volume (default 100)
   */
  async playWorldSound(x, y, z = 0, radius = 50, volume = 100) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('playWorldSound', { x, y, z, radius, volume });
  }

  /**
   * Play a sound near a specific player's location
   * @param {string} username - Player username
   * @param {number} radius - Sound radius (default 50)
   * @param {number} volume - Sound volume (default 100)
   */
  async playSoundNearPlayer(username, radius = 50, volume = 100) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('playSoundNearPlayer', { username, radius, volume });
  }

  /**
   * Trigger a gunshot sound (high radius, attracts zombies from far)
   * @param {object} options - Either {x, y, z} coordinates or {username}
   */
  async triggerGunshot(options = {}) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('triggerGunshot', options);
  }

  /**
   * Trigger an alarm sound
   * @param {object} options - Either {x, y, z} coordinates or {username}
   */
  async triggerAlarmSound(options = {}) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('triggerAlarmSound', options);
  }

  /**
   * Create a custom noise at a location
   * @param {object} options - {x, y, z, radius, volume} or {username, radius, volume}
   */
  async createNoise(options = {}) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('createNoise', options);
  }

  // =============================================
  // V1.3.0 CLIMATE / WEATHER / DEBUG METHODS
  // =============================================

  /**
   * Generate a weather period
   * @param {number} strength - Weather strength 0-1 (default 0.5)
   * @param {number} frontType - 0=stationary, 1=cold, 2=warm (default 0)
   */
  async generateWeather(strength = 0.5, frontType = 0) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('generateWeather', { strength, frontType });
  }

  /**
   * Set temperature via climate admin override
   * @param {number} value - Temperature in Celsius (-50 to +50)
   */
  async setTemperature(value = 22) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('setTemperature', { value });
  }

  /**
   * Set wind intensity via climate admin override
   * @param {number} value - Wind intensity 0-1
   */
  async setWind(value = 0.5) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('setWind', { value });
  }

  /**
   * Set fog intensity via climate admin override
   * @param {number} value - Fog intensity 0-1
   */
  async setFog(value = 0) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('setFog', { value });
  }

  /**
   * Set cloud intensity via climate admin override
   * @param {number} value - Cloud intensity 0-1
   */
  async setClouds(value = 0) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('setClouds', { value });
  }

  /**
   * Clear mod error log
   */
  async clearErrors() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('clearErrors', {});
  }
}

// Export singleton instance
const bridge = new PanelBridge();

export { PanelBridge, bridge };
export default bridge;
