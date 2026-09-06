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
import { logPlayerAction, recordPlayerSession } from '../database/init.js';
import { createLogger } from '../utils/logger.js';
import { PanelBridgeSftpTransport } from './panelBridgeSftp.js';
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

class PanelBridge extends EventEmitter {
  constructor() {
    super();
    this.bridgePath = null;
    this.isRunning = false;
    this.pollInterval = null;
    this.statusInterval = null;
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
      lastConsumedResultSeq: 0
    };
    this.outboxStuckState = { seq: null, since: 0, nextCheckAt: 0 };
    this.inboxResyncNextCheckAt = 0;
    this.lastQueueCleanupAt = 0;
    this.modStatus = null;
    this.previousPlayers = new Set(); // Track previous player list for connect/disconnect detection
    this.lastStatusFileCheck = 0;
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
      fileWatchDebounceMs: 100      // Debounce file change events
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
      // The Lua mod writes to: {base}/Lua/panelbridge/{serverName}/
      const bridgePath = path.join(base, 'Lua', 'panelbridge', serverName);
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
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8') || '{}');
        const nextSeq = Number(state.nextCommandSeq);
        const consumed = Number(state.lastConsumedResultSeq);
        this.queueState.nextCommandSeq = Number.isFinite(nextSeq) && nextSeq > 0 ? Math.floor(nextSeq) : 1;
        this.queueState.lastConsumedResultSeq = Number.isFinite(consumed) && consumed >= 0 ? Math.floor(consumed) : 0;
      } catch (error) {
        log.warn(`Could not parse queue state file: ${error.message}`);
        this.queueState.nextCommandSeq = 1;
        this.queueState.lastConsumedResultSeq = 0;
      }
    }

    // The SFTP cache can be cleared independently of the remote server. In
    // that case the Lua cursor is the authoritative lower bound for new
    // command filenames, otherwise Node would restart at cmd-0000000001.
    const luaStateFile = this.resolveModFile('queue-state-lua.json');
    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    if (luaStateFile && fs.existsSync(luaStateFile)) {
      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        const luaState = JSON.parse(fs.readFileSync(luaStateFile, 'utf-8') || '{}');
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
      updatedAt: Date.now()
    };
    const tempFile = `${stateFile}.tmp`;
    try {
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      fs.renameSync(tempFile, stateFile);
    } catch (error) {
      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
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

    const issues = [];
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
      issues.push('Bridge path is not configured.');
      return {
        healthy: false,
        canSendCommands: false,
        checks,
        issues,
        summary: 'Bridge path not configured.',
      };
    }

    try {
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      checks.bridgePathExists = fs.existsSync(bridgePath);
      if (!checks.bridgePathExists) {
        issues.push('Bridge directory does not exist yet.');
      }
    } catch (e) {
      issues.push(`Bridge directory check failed: ${e.message}`);
    }

    if (checks.bridgePathExists) {
      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        fs.accessSync(bridgePath, fs.constants.R_OK);
        checks.bridgePathReadable = true;
      } catch (e) {
        issues.push(`Bridge directory is not readable: ${e.message}`);
      }

      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        fs.accessSync(bridgePath, fs.constants.W_OK);
        checks.bridgePathWritable = true;
      } catch (e) {
        issues.push(`Bridge directory is not writable: ${e.message}`);
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
        issues.push(`${path.basename(filePath)} is not readable: ${e.message}`);
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
      issues.push('Status file is missing. Start the game server with PanelBridge enabled.');
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
        checks.statusFresh = ageMs < diagStaleMs;
        if (!checks.statusFresh) {
          issues.push(`Status file is stale (${formatAge(ageMs)} old) — is the PZ server running?`);
        }
      } catch (e) {
        issues.push(`Could not read status file metadata: ${e.message}`);
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
      summary: issues[0] || 'Bridge file connection looks healthy.',
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

    // Start polling for results (fast poll)
    this.pollInterval = setInterval(() => this.pollResults(), this.config.pollIntervalMs);

    // Start checking mod status
    this.statusInterval = setInterval(() => this.checkModStatus(), this.config.statusCheckMs);

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
    this.trackPlayerActivity([]);
    this.watcherRetries = 0;
    this.modStatus = null;
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
    log.debug(`sendCommand: action=${action} args=${JSON.stringify(args).substring(0, 200)}`);
    if (!this.bridgePath) {
      throw new Error('Bridge not configured');
    }
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }

    const connection = this.getConnectionDiagnostics();
    if (!connection.canSendCommands) {
      throw new Error(`Bridge file connection is unhealthy: ${connection.summary}`);
    }

    // Fail fast if the mod hasn't responded recently (avoids 15s timeout wait)
    if (this.modStatus && !this.modStatus.alive && action !== 'ping') {
      throw new Error('Mod is not responding — check the PZ server is running with PanelBridge enabled');
    }

    const commandsFile = this.getCommandsFile();
    const id = uuidv4();
    this.ensureQueueProtocol();

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
      throw new Error(`Failed to write command ${action}: ${writeError.message}`);
    }

    // Return a promise that resolves when we get the result
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`Command timeout: ${action} (no response from mod)`));
      }, this.config.commandTimeoutMs);

      this.pendingCommands.set(id, {
        resolve,
        reject,
        timeout,
        action,
        timestamp: Date.now()
      });
      log.debug(`sendCommand: queued action=${action} id=${id} (pending=${this.pendingCommands.size})`);
    });
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
        const content = fs.readFileSync(commandsFile, 'utf-8');
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
    fs.writeFileSync(tempFile, JSON.stringify(commands, null, 2), { mode: 0o600 });
    try {
      // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
      fs.renameSync(tempFile, commandsFile);
    } catch (err) {
      // If rename fails (file locked), try direct write as fallback
      log.warn(`renameSync failed, using direct write: ${err.message}`);
      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        fs.writeFileSync(commandsFile, JSON.stringify(commands, null, 2), { mode: 0o600 });
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
    const payload = {
      protocolVersion: this.protocolVersion,
      seq,
      id,
      action,
      args,
      createdAt: Date.now(),
      expiresAt: Date.now() + (this.config.commandTimeoutMs * 2)
    };

    const tempFile = `${commandFile}.tmp`;
    // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
    fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
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
   */
  tryResyncOutboxCursor(seq) {
    const now = Date.now();
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
      luaState = JSON.parse(fs.readFileSync(luaStateFile, 'utf-8') || '{}');
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
        raw = fs.readFileSync(resultFile, 'utf-8');
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
        fs.writeFileSync(resultFile, '', { mode: 0o600 });
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
      luaState = JSON.parse(fs.readFileSync(luaStateFile, 'utf-8') || '{}');
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
        const raw = fs.readFileSync(resultFile, 'utf-8');
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
        log.debug(`Queue result parse error for seq ${seq}: ${error.message}`);
        break;
      }

      const result = parsed && parsed.result ? parsed.result : parsed;
      if (result) {
        this.processResult(result);
      }

      this.queueState.lastConsumedResultSeq = seq;
      consumed++;

      try {
        // codeql[js/path-injection] this.bridgePath is set only by configure()/autoDetect(), both of which validate their input before assignment (route-layer isAbsolute+blocklist guard, or autoDetect's regex on serverName) -- this line only re-reads the already-validated field.
        fs.writeFileSync(resultFile, '', { mode: 0o600 });
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
      const content = fs.readFileSync(resultsFile, 'utf-8');
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
        const cursor = JSON.parse(fs.readFileSync(cursorFile, 'utf-8') || '{}');
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
      const content = fs.readFileSync(statusFile, 'utf-8');
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

      // Track player connections and disconnections
      if (status.alive && status.players) {
        this.trackPlayerActivity(status.players);
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
   * Track player connect/disconnect events
   */
  trackPlayerActivity(currentPlayers) {
    // Normalize players: PanelBridge.lua's own JSON encoder (kind_of()) defaults an empty table to
    // [] on the wire, not {} -- but handle both shapes defensively anyway, since nothing here
    // depends on which one actually arrives and a future encoder change shouldn't be able to break this.
    const playerList = Array.isArray(currentPlayers) ? currentPlayers : Object.keys(currentPlayers || {});
    const current = new Set(playerList);
    const previous = this.previousPlayers;

    // Find players who joined (in current but not in previous)
    for (const player of current) {
      if (!previous.has(player)) {
        logPlayerAction(player, 'connect', 'Player connected to server').catch(err => log.debug(`Failed to log player connect: ${err.message}`));
        recordPlayerSession(player, 'connect').catch(err => log.debug(`Failed to record player connect session: ${err.message}`));
        this.emit('playerConnect', player);
      }
    }

    // Find players who left (in previous but not in current)
    for (const player of previous) {
      if (!current.has(player)) {
        logPlayerAction(player, 'disconnect', 'Player disconnected from server').catch(err => log.debug(`Failed to log player disconnect: ${err.message}`));
        recordPlayerSession(player, 'disconnect').catch(err => log.debug(`Failed to record player disconnect session: ${err.message}`));
        this.emit('playerDisconnect', player);
      }
    }

    // Update previous players set
    this.previousPlayers = current;
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
      transport: this.sftpTransport?.getStatus() || { type: 'local', running: this.isRunning },
      lastSftpTransport: this.lastSftpStatus
    };
  }

  /**
   * Check if mod is connected and responsive
   */
  isModConnected() {
    return this.modStatus?.alive === true;
  }

  /**
   * Convenience method: ping the mod
   */
  async ping() {
    if (!this.isRunning) {
      return { success: false, error: 'Bridge not running' };
    }
    if (!this.isModConnected()) {
      return { success: false, error: 'Mod not connected', modStatus: this.modStatus };
    }
    try {
      const result = await this.sendCommand('ping', {});
      // Include modStatus in the response for the frontend
      return { ...result, modStatus: this.modStatus };
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

  /**
   * Convenience method: save world
   */
  async saveWorld() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('saveWorld', {});
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
