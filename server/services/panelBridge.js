/**
 * PanelBridge - Node.js Bridge Service
 * 
 * Provides communication between the panel and the PZ server mod.
 * Uses file-based communication with atomic operations.
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { logPlayerAction, recordPlayerSession } from '../database/init.js';
import { logger } from '../utils/logger.js';

class PanelBridge extends EventEmitter {
  constructor() {
    super();
    this.bridgePath = null;
    this.isRunning = false;
    this.pollInterval = null;
    this.statusInterval = null;
    this.fileWatcher = null;
    this.pendingCommands = new Map(); // id -> { resolve, reject, timeout, timestamp }
    this.processedResults = new Map(); // id -> timestamp (for deduplication)
    this.modStatus = null;
    this.previousPlayers = new Set(); // Track previous player list for connect/disconnect detection
    this.lastStatusFileCheck = 0;
    this.consecutiveFailures = 0;
    this.maxConsecutiveFailures = 5;
    this.watcherRetries = 0;
    this.maxWatcherRetries = 3;
    this.config = {
      pollIntervalMs: 300,          // Faster polling for results (300ms)
      statusCheckMs: 1000,          // Check status every 1 second
      commandTimeoutMs: 15000,
      statusStaleMs: 45000,         // Status considered stale after 45 seconds (Lua updates every 5s)
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
    
    // Ensure directory exists
    if (!fs.existsSync(this.bridgePath)) {
      fs.mkdirSync(this.bridgePath, { recursive: true });
    }

    logger.debug(`PanelBridge: Configured path: ${this.bridgePath}`);
    this.emit('configured', { path: this.bridgePath });
    
    return this.bridgePath;
  }

  /**
   * Auto-detect the bridge path from server name
   * @param {string} serverName - Name of the PZ server
   * @param {string} zomboidUserFolder - Path to Zomboid user folder (optional)
   */
  autoDetect(serverName, zomboidUserFolder = null) {
    // Default Zomboid folder locations
    const possibleBases = zomboidUserFolder 
      ? [zomboidUserFolder]
      : [
          process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Zomboid') : null,
          process.env.HOME ? path.join(process.env.HOME, 'Zomboid') : null,
        ].filter(Boolean);

    for (const base of possibleBases) {
      const savePath = path.join(base, 'Saves', 'Multiplayer', serverName);
      if (fs.existsSync(savePath)) {
        return this.configure(savePath);
      }
    }

    throw new Error(`Could not find save folder for server: ${serverName}`);
  }

  /**
   * Get file paths
   */
  getCommandsFile() {
    return this.bridgePath ? path.join(this.bridgePath, 'commands.json') : null;
  }

  getResultsFile() {
    return this.bridgePath ? path.join(this.bridgePath, 'results.json') : null;
  }

  getStatusFile() {
    return this.bridgePath ? path.join(this.bridgePath, 'status.json') : null;
  }

  /**
   * Start the bridge polling
   */
  start() {
    if (!this.bridgePath) {
      throw new Error('Bridge not configured. Call configure() first.');
    }

    if (this.isRunning) {
      logger.debug('PanelBridge: Already running');
      return;
    }

    // Reset failure counter on start
    this.consecutiveFailures = 0;
    this.lastStatusFileCheck = 0;

    // Start polling for results (fast poll)
    this.pollInterval = setInterval(() => this.pollResults(), this.config.pollIntervalMs);
    
    // Start checking mod status
    this.statusInterval = setInterval(() => this.checkModStatus(), this.config.statusCheckMs);

    // Setup file watcher for immediate response to file changes
    this.setupFileWatcher();

    // Do an immediate status check
    this.checkModStatus();

    this.isRunning = true;
    logger.info(`PanelBridge: Started - watching ${this.bridgePath}`);
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
        logger.warn(`PanelBridge: Gave up on file watcher after ${this.maxWatcherRetries} attempts. Falling back to polling only.`);
        return;
    }

    try {
      let debounceTimer = null;
      this.fileWatcher = fs.watch(this.bridgePath, { persistent: false }, (eventType, filename) => {
        // Debounce rapid file changes
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          try {
            if (filename === 'status.json') {
              this.checkModStatus();
            } else if (filename === 'results.json') {
              this.pollResults();
            }
          } catch (e) {
            logger.debug(`PanelBridge: File change handler error: ${e.message}`);
          }
          debounceTimer = null;
        }, this.config.fileWatchDebounceMs);
      });

      this.fileWatcher.on('error', (err) => {
        logger.warn(`PanelBridge: File watcher error: ${err.message}`);
        // Try to recover by closing and nullifying
        try {
          this.fileWatcher.close();
        } catch (e) { /* ignore */ }
        this.fileWatcher = null;
        this.watcherRetries++;
        
        // Attempt to restart file watcher after delay
        setTimeout(() => {
          if (this.isRunning && !this.fileWatcher) {
            logger.info(`PanelBridge: Attempting to restart file watcher (attempt ${this.watcherRetries}/${this.maxWatcherRetries})...`);
            this.setupFileWatcher();
          }
        }, 5000);
      });

      logger.debug('PanelBridge: File watcher active');
      this.watcherRetries = 0; // Reset retries on successful setup
    } catch (err) {
      // File watching is optional - polling will still work
      this.watcherRetries++;
      logger.warn(`PanelBridge: Could not setup file watcher: ${err.message}`);
      
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

    // Reject all pending commands
    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Bridge stopped'));
    }
    this.pendingCommands.clear();

    this.isRunning = false;
    logger.info('PanelBridge: Stopped');
    this.emit('stopped');
  }

  /**
   * Send a command to the PZ mod
   * @param {string} action - Command action name
   * @param {object} args - Command arguments
   * @returns {Promise<object>} - Command result
   */
  async sendCommand(action, args = {}) {
    if (!this.bridgePath) {
      throw new Error('Bridge not configured');
    }
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }

    const commandsFile = this.getCommandsFile();
    const id = uuidv4();

    // Serialize file access to prevent TOCTOU race conditions
    if (!this._writeQueue) this._writeQueue = Promise.resolve();
    this._writeQueue = this._writeQueue.then(() => this._appendCommand(commandsFile, id, action, args))
      .catch(err => logger.error(`PanelBridge write queue error: ${err.message}`));
    await this._writeQueue;

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
    });
  }

  /**
   * Append a command to the commands file (serialized via _writeQueue)
   */
  _appendCommand(commandsFile, id, action, args) {
    let commands = { commands: [] };
    try {
      if (fs.existsSync(commandsFile)) {
        const content = fs.readFileSync(commandsFile, 'utf-8');
        if (content.trim()) {
          commands = JSON.parse(content);
          if (!commands.commands) commands.commands = [];
        }
      }
    } catch (e) {
      commands = { commands: [] };
    }

    commands.commands.push({
      id,
      action,
      args,
      timestamp: Date.now()
    });

    const tempFile = commandsFile + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(commands, null, 2));
    try {
      fs.renameSync(tempFile, commandsFile);
    } catch (err) {
      // If rename fails (file locked), try direct write as fallback
      logger.warn(`PanelBridge: renameSync failed, using direct write: ${err.message}`);
      fs.writeFileSync(commandsFile, JSON.stringify(commands, null, 2));
      try { fs.unlinkSync(tempFile); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Poll for results from the mod
   */
  pollResults() {
    const resultsFile = this.getResultsFile();
    if (!resultsFile || !fs.existsSync(resultsFile)) {
      return;
    }

    try {
      const content = fs.readFileSync(resultsFile, 'utf-8');
      if (!content.trim()) return;

      const data = JSON.parse(content);
      
      if (data.results && Array.isArray(data.results)) {
        for (const result of data.results) {
          // Skip already processed results
          if (this.processedResults.has(result.id)) continue;
          this.processedResults.set(result.id, Date.now());

          // Resolve pending command
          const pending = this.pendingCommands.get(result.id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingCommands.delete(result.id);

            if (result.success) {
              pending.resolve({ success: true, data: result.data });
            } else {
              pending.reject(new Error(result.error || 'Command failed'));
            }
          }

          // Emit result event
          this.emit('result', result);
        }
      }

      // Cleanup old processed IDs (keep last 100)
      if (this.processedResults.size > 100) {
          // Map iterates in insertion order, so the first items are the oldest
          let count = 0;
          for (const [key, _] of this.processedResults) {
              this.processedResults.delete(key);
              count++;
              if (count >= 50) break; // Remove oldest 50
          }
      }

      // Cleanup stale pendingCommands that somehow missed their timeout (Bug #17)
      const now = Date.now();
      const maxPendingAge = (this.config.commandTimeoutMs || 30000) * 2;
      for (const [id, cmd] of this.pendingCommands) {
        if (now - cmd.timestamp > maxPendingAge) {
          clearTimeout(cmd.timeout);
          this.pendingCommands.delete(id);
          logger.warn(`PanelBridge: Cleaned up stale pending command: ${cmd.action} (age: ${Math.round((now - cmd.timestamp) / 1000)}s)`);
        }
      }
    } catch (e) {
      // File might be being written, ignore
    }
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
    
    if (!fs.existsSync(statusFile)) {
      this.handleStatusFailure('Status file does not exist');
      return;
    }

    try {
      // Check file modification time first (faster than reading)
      const stats = fs.statSync(statusFile);
      const age = Date.now() - stats.mtimeMs;
      
      // If file hasn't changed since last check and we have valid status (not just waiting), skip full re-read
      // Always re-read if modStatus is in waiting state (version is null) to pick up initial data
      const hasValidStatus = this.modStatus && !this.modStatus.waiting && this.modStatus.version;
      if (stats.mtimeMs === this.lastStatusFileCheck && hasValidStatus) {
        // Just update age in existing status
        if (this.modStatus.age !== age) {
          this.modStatus.age = age;
          this.modStatus.alive = age < this.config.statusStaleMs;
          if (!this.modStatus.alive && this.modStatus._wasAlive) {
            this.modStatus._wasAlive = false;
            this.emit('modStatus', this.modStatus);
          }
        }
        return;
      }
      
      // Read and parse the file
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
      status.alive = age < this.config.statusStaleMs;
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
        
        if (status.alive) {
          logger.debug(`PanelBridge: Mod connected (age: ${Math.round(age / 1000)}s)`);
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
      logger.debug(`PanelBridge: Status check failed (${this.consecutiveFailures}x): ${reason}`);
    }
    
    // Update mod status to disconnected after several failures
    if (this.modStatus?.alive && this.consecutiveFailures >= this.maxConsecutiveFailures) {
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
      logger.warn(`PanelBridge: Mod marked as disconnected after ${this.consecutiveFailures} failures`);
    } else if (!this.modStatus) {
      this.modStatus = { alive: false, waiting: true, version: null, playerCount: undefined, players: [] };
    }
  }

  /**
   * Track player connect/disconnect events
   */
  trackPlayerActivity(currentPlayers) {
    const current = new Set(currentPlayers || []);
    const previous = this.previousPlayers;
    
    // Find players who joined (in current but not in previous)
    for (const player of current) {
      if (!previous.has(player)) {
        logPlayerAction(player, 'connect', 'Player connected to server').catch(() => {});
        recordPlayerSession(player, 'connect').catch(() => {});
        this.emit('playerConnect', player);
      }
    }
    
    // Find players who left (in previous but not in current)
    for (const player of previous) {
      if (!current.has(player)) {
        logPlayerAction(player, 'disconnect', 'Player disconnected from server').catch(() => {});
        recordPlayerSession(player, 'disconnect').catch(() => {});
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
        if (fs.existsSync(statusFile)) {
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
      consecutiveFailures: this.consecutiveFailures,
      config: {
        statusStaleMs: this.config.statusStaleMs,
        pollIntervalMs: this.config.pollIntervalMs,
        statusCheckMs: this.config.statusCheckMs
      },
      statusFile: fileInfo,
      hasFileWatcher: !!this.fileWatcher
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
  async setSnow(enabled = true) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('setSnow', { enabled });
  }

  // =============================================
  // NEW V1.1.0 METHODS
  // =============================================

  /**
   * Convenience method: start rain
   */
  async startRain(intensity = 1.0) {
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
  async triggerLightning(x = null, y = null, strike = false, light = true, rumble = true) {
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
   * Convenience method: send server message
   */
  async sendServerMessage(message, color = 'white') {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('sendServerMessage', { message, color });
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
}

// Export singleton instance
const bridge = new PanelBridge();

export { PanelBridge, bridge };
export default bridge;
