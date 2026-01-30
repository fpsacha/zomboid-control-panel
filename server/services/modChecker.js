import { logger } from '../utils/logger.js';
import { getTrackedMods, updateModTimestamp, logServerEvent, getSetting, setSetting, addTrackedMod, getActiveServer } from '../database/init.js';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

export class ModChecker extends EventEmitter {
  constructor() {
    super();
    this.checkInterval = parseInt(process.env.MOD_CHECK_INTERVAL, 10) || 300000; // 5 minutes default
    this.intervalId = null;
    this.lastCheck = null;
    this.modsNeedingUpdate = [];
    this.onUpdateCallback = null;
    this.autoRestartEnabled = false;  // Track auto-restart state
    this.scheduler = null;  // Will be set by init()
    this.serverManager = null;  // Will be set by init()
    this.io = null;  // Socket.io instance for emitting events
    this.workshopAcfPath = null;  // Path to appworkshop_108600.acf
    
    // Advanced options
    this.restartWarningMinutes = 5;  // Minutes to warn before restart
    this.delayIfPlayersOnline = false;  // Wait for players to leave before restart
    this.maxDelayMinutes = 30;  // Maximum wait time if delaying for players
    this.lastUpdateDetected = null;  // Timestamp of last update detection
    this.pendingRestart = false;  // Whether a restart is pending (waiting for players)
    this.playerCheckInterval = null;  // Interval for checking player count
  }

  // Initialize with scheduler and restore saved settings
  async init(scheduler, serverManager = null, io = null) {
    this.scheduler = scheduler;
    this.serverManager = serverManager;
    this.io = io;
    
    // Find the workshop ACF file path
    await this.findWorkshopAcfPath();
    
    // Restore all saved settings from database
    try {
      const savedAutoRestart = await getSetting('modAutoRestartEnabled');
      const savedWarningMinutes = await getSetting('modRestartWarningMinutes');
      const savedDelayIfPlayers = await getSetting('modDelayIfPlayersOnline');
      const savedMaxDelay = await getSetting('modMaxDelayMinutes');
      const savedCheckInterval = await getSetting('modCheckInterval');
      
      if (savedWarningMinutes !== null) this.restartWarningMinutes = savedWarningMinutes;
      if (savedDelayIfPlayers !== null) this.delayIfPlayersOnline = savedDelayIfPlayers;
      if (savedMaxDelay !== null) this.maxDelayMinutes = savedMaxDelay;
      if (savedCheckInterval !== null) this.checkInterval = savedCheckInterval;
      
      if (savedAutoRestart === true) {
        this.autoRestartEnabled = true;
        if (this.scheduler) {
          this.onUpdateCallback = async (updatedMods) => {
            await this.handleModUpdate(updatedMods);
          };
          logger.info('Auto-restart on mod update restored from settings');
        }
      }
    } catch (error) {
      logger.warn(`Failed to restore mod checker settings: ${error.message}`);
    }
    
    // Auto-sync mods from workshop ACF file
    await this.autoSyncModsOnStartup();
  }

  // Find the workshop ACF file path from server config
  async findWorkshopAcfPath() {
    try {
      const activeServer = await getActiveServer();
      let installPath = activeServer?.installPath;
      
      if (!installPath) {
        installPath = await getSetting('serverPath');
      }
      
      if (!installPath) {
        logger.debug('ModChecker: Server install path not configured');
        return null;
      }
      
      // Workshop ACF is at: {installPath}/steamapps/workshop/appworkshop_108600.acf
      const acfPath = path.join(installPath, 'steamapps', 'workshop', 'appworkshop_108600.acf');
      
      if (fs.existsSync(acfPath)) {
        this.workshopAcfPath = acfPath;
        logger.info(`ModChecker: Found workshop ACF at ${acfPath}`);
        return acfPath;
      }
      
      logger.debug(`ModChecker: Workshop ACF not found at ${acfPath}`);
      return null;
    } catch (error) {
      logger.warn(`ModChecker: Failed to find workshop ACF: ${error.message}`);
      return null;
    }
  }

  // Parse Steam's VDF/ACF format (simplified parser)
  parseAcfFile(content) {
    const result = {
      installedMods: {},
      modDetails: {}
    };
    
    try {
      // Extract WorkshopItemsInstalled section
      const installedMatch = content.match(/"WorkshopItemsInstalled"\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/);
      if (installedMatch) {
        const installedSection = installedMatch[1];
        // Match each mod entry
        const modPattern = /"(\d+)"\s*\{([^}]+)\}/g;
        let match;
        while ((match = modPattern.exec(installedSection)) !== null) {
          const workshopId = match[1];
          const modData = match[2];
          
          const sizeMatch = modData.match(/"size"\s*"(\d+)"/);
          const timeMatch = modData.match(/"timeupdated"\s*"(\d+)"/);
          
          result.installedMods[workshopId] = {
            size: sizeMatch ? parseInt(sizeMatch[1]) : 0,
            timeupdated: timeMatch ? parseInt(timeMatch[1]) : 0
          };
        }
      }
      
      // Extract WorkshopItemDetails section (has latest_timeupdated)
      const detailsMatch = content.match(/"WorkshopItemDetails"\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/);
      if (detailsMatch) {
        const detailsSection = detailsMatch[1];
        const modPattern = /"(\d+)"\s*\{([^}]+)\}/g;
        let match;
        while ((match = modPattern.exec(detailsSection)) !== null) {
          const workshopId = match[1];
          const modData = match[2];
          
          const timeMatch = modData.match(/"timeupdated"\s*"(\d+)"/);
          const latestMatch = modData.match(/"latest_timeupdated"\s*"(\d+)"/);
          
          result.modDetails[workshopId] = {
            timeupdated: timeMatch ? parseInt(timeMatch[1]) : 0,
            latest_timeupdated: latestMatch ? parseInt(latestMatch[1]) : 0
          };
        }
      }
    } catch (error) {
      logger.error(`ModChecker: Failed to parse ACF file: ${error.message}`);
    }
    
    return result;
  }

  // Auto-sync mods from workshop ACF file on startup
  async autoSyncModsOnStartup() {
    try {
      if (!this.workshopAcfPath || !fs.existsSync(this.workshopAcfPath)) {
        logger.debug('ModChecker: No workshop ACF file, skipping auto-sync');
        return;
      }
      
      const trackedMods = await getTrackedMods() || [];
      
      // Only auto-sync if no mods are tracked
      if (trackedMods.length > 0) {
        logger.debug(`ModChecker: ${trackedMods.length} mods already tracked, skipping auto-sync`);
        return;
      }
      
      // Read and parse the ACF file
      const content = fs.readFileSync(this.workshopAcfPath, 'utf-8');
      const parsed = this.parseAcfFile(content);
      
      const workshopIds = Object.keys(parsed.installedMods);
      
      if (workshopIds.length === 0) {
        logger.debug('ModChecker: No mods found in workshop ACF');
        return;
      }
      
      // Add all mods to tracking
      let synced = 0;
      for (const workshopId of workshopIds) {
        try {
          const modInfo = parsed.installedMods[workshopId];
          await addTrackedMod(workshopId, `Workshop Mod ${workshopId}`);
          
          // Set the current timestamp so we detect future changes
          if (modInfo.timeupdated) {
            const timestamp = new Date(modInfo.timeupdated * 1000).toISOString();
            await updateModTimestamp(workshopId, timestamp);
          }
          synced++;
        } catch (e) {
          logger.warn(`Failed to auto-sync mod ${workshopId}: ${e.message}`);
        }
      }
      
      if (synced > 0) {
        logger.info(`ModChecker: Auto-synced ${synced} mods from workshop ACF`);
      }
    } catch (error) {
      logger.warn(`ModChecker: Auto-sync failed: ${error.message}`);
    }
  }

  start() {
    // Check if we have the workshop ACF file
    if (!this.workshopAcfPath) {
      logger.warn('ModChecker: Workshop ACF file not configured - mod update checking disabled. Configure server install path first.');
      return false;
    }
    
    if (!fs.existsSync(this.workshopAcfPath)) {
      logger.warn(`ModChecker: Workshop ACF file not found at ${this.workshopAcfPath}`);
      return false;
    }

    this.intervalId = setInterval(() => this.checkForUpdates(), this.checkInterval);
    logger.info(`Mod checker started - checking every ${Math.round(this.checkInterval / 1000)}s`);
    
    // Run initial check
    this.checkForUpdates();
    return true;
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Mod checker stopped');
    }
    if (this.playerCheckInterval) {
      clearInterval(this.playerCheckInterval);
      this.playerCheckInterval = null;
    }
  }

  async setUpdateCallback(callback) {
    this.onUpdateCallback = callback;
    this.autoRestartEnabled = !!callback;
    // Persist to database
    await setSetting('modAutoRestartEnabled', this.autoRestartEnabled);
  }

  // Configure restart options
  async setRestartOptions(options) {
    if (options.warningMinutes !== undefined) {
      this.restartWarningMinutes = Math.max(0, Math.min(30, options.warningMinutes));
      await setSetting('modRestartWarningMinutes', this.restartWarningMinutes);
    }
    if (options.delayIfPlayersOnline !== undefined) {
      this.delayIfPlayersOnline = !!options.delayIfPlayersOnline;
      await setSetting('modDelayIfPlayersOnline', this.delayIfPlayersOnline);
    }
    if (options.maxDelayMinutes !== undefined) {
      this.maxDelayMinutes = Math.max(5, Math.min(120, options.maxDelayMinutes));
      await setSetting('modMaxDelayMinutes', this.maxDelayMinutes);
    }
    if (options.checkInterval !== undefined) {
      this.checkInterval = Math.max(60000, options.checkInterval);
      await setSetting('modCheckInterval', this.checkInterval);
      // Restart with new interval
      if (this.intervalId) {
        this.stop();
        this.start();
      }
    }
    
    logger.info(`Mod restart options updated: warning=${this.restartWarningMinutes}min, delayIfPlayers=${this.delayIfPlayersOnline}, maxDelay=${this.maxDelayMinutes}min`);
  }

  // Handle mod update detection
  async handleModUpdate(updatedMods) {
    this.lastUpdateDetected = new Date();
    
    // Emit socket event
    if (this.io) {
      this.io.emit('mods:update_detected', { 
        mods: updatedMods,
        timestamp: this.lastUpdateDetected.toISOString(),
        autoRestart: this.autoRestartEnabled,
        warningMinutes: this.restartWarningMinutes
      });
    }
    this.emit('update_detected', updatedMods);
    
    if (!this.scheduler) {
      logger.warn('ModChecker: Scheduler not available, cannot trigger restart');
      return;
    }
    
    // Check if we should delay for players
    if (this.delayIfPlayersOnline && this.serverManager) {
      try {
        const playerCount = await this.getOnlinePlayerCount();
        
        if (playerCount > 0) {
          logger.info(`ModChecker: ${playerCount} players online, delaying restart (max ${this.maxDelayMinutes} min)`);
          await this.scheduler.rconService?.serverMessage(
            `🔧 Mod updates detected! Restart pending - waiting for players to leave (max ${this.maxDelayMinutes} min).`
          );
          
          if (this.io) {
            this.io.emit('mods:restart_pending', { 
              reason: 'waiting_for_players',
              playerCount,
              maxDelayMinutes: this.maxDelayMinutes
            });
          }
          
          // Start player count monitoring
          this.startPlayerMonitoring(updatedMods);
          return;
        }
      } catch (error) {
        logger.warn(`ModChecker: Failed to check player count: ${error.message}`);
      }
    }
    
    // No delay, trigger restart immediately
    await this.triggerModRestart(updatedMods);
  }

  // Get online player count
  async getOnlinePlayerCount() {
    if (!this.scheduler?.rconService) return 0;
    
    try {
      const result = await this.scheduler.rconService.getPlayers();
      if (result.success && result.players) {
        return result.players.length;
      }
    } catch (error) {
      logger.debug(`Failed to get player count: ${error.message}`);
    }
    return 0;
  }

  // Monitor player count and restart when empty
  startPlayerMonitoring(updatedMods) {
    if (this.playerCheckInterval) {
      clearInterval(this.playerCheckInterval);
    }
    
    this.pendingRestart = true;
    const startTime = Date.now();
    const maxWaitMs = this.maxDelayMinutes * 60 * 1000;
    
    this.playerCheckInterval = setInterval(async () => {
      const elapsed = Date.now() - startTime;
      
      // Check if max delay exceeded
      if (elapsed >= maxWaitMs) {
        logger.info('ModChecker: Max delay exceeded, forcing restart');
        clearInterval(this.playerCheckInterval);
        this.playerCheckInterval = null;
        this.pendingRestart = false;
        await this.triggerModRestart(updatedMods);
        return;
      }
      
      // Check player count
      const playerCount = await this.getOnlinePlayerCount();
      
      if (playerCount === 0) {
        logger.info('ModChecker: No players online, triggering restart');
        clearInterval(this.playerCheckInterval);
        this.playerCheckInterval = null;
        this.pendingRestart = false;
        await this.triggerModRestart(updatedMods);
      } else {
        const remainingMin = Math.round((maxWaitMs - elapsed) / 60000);
        logger.debug(`ModChecker: ${playerCount} players still online, ${remainingMin} min remaining`);
      }
    }, 30000); // Check every 30 seconds
  }

  // Trigger the actual restart
  async triggerModRestart(updatedMods) {
    logger.info(`ModChecker: Triggering restart for ${updatedMods.length} updated mod(s)`);
    
    const modNames = updatedMods.map(m => m.name).join(', ');
    
    if (this.io) {
      this.io.emit('mods:restart_starting', { 
        mods: updatedMods,
        warningMinutes: this.restartWarningMinutes
      });
    }
    
    try {
      // Send warning message
      await this.scheduler.rconService?.serverMessage(
        `🔧 Mod updates detected: ${modNames.substring(0, 100)}${modNames.length > 100 ? '...' : ''}. Server will restart in ${this.restartWarningMinutes} minute(s).`
      );
      
      // Perform restart with configured warning time
      await this.scheduler.performRestart(this.restartWarningMinutes);
      
      await logServerEvent('mod_update_restart', `Restarted for mod updates: ${modNames}`);
      
      if (this.io) {
        this.io.emit('mods:restart_complete', { mods: updatedMods });
      }
    } catch (error) {
      logger.error(`ModChecker: Restart failed: ${error.message}`);
      if (this.io) {
        this.io.emit('mods:restart_failed', { error: error.message });
      }
    }
  }

  // Check for mod updates using local workshop ACF file
  // This compares timeupdated vs latest_timeupdated in Steam's cache
  async checkForUpdates() {
    try {
      // Make sure we have the ACF path
      if (!this.workshopAcfPath) {
        await this.findWorkshopAcfPath();
      }
      
      if (!this.workshopAcfPath || !fs.existsSync(this.workshopAcfPath)) {
        logger.warn('ModChecker: Workshop ACF file not found - cannot check for updates');
        return { updated: false, mods: [], error: 'Workshop ACF file not found' };
      }
      
      // Read and parse the ACF file
      const content = fs.readFileSync(this.workshopAcfPath, 'utf-8');
      const parsed = this.parseAcfFile(content);
      
      const modCount = Object.keys(parsed.modDetails).length;
      if (modCount > 0) {
        logger.info(`Checking ${modCount} workshop mods for updates...`);
      } else {
        logger.debug('No workshop mods to check for updates');
      }
      
      const updatedMods = [];
      const trackedMods = await getTrackedMods() || [];
      
      // Build a map of tracked mods for quick lookup
      const trackedMap = new Map();
      for (const mod of trackedMods) {
        trackedMap.set(mod.workshop_id, mod);
      }

      // Check each mod in the ACF file
      for (const [workshopId, details] of Object.entries(parsed.modDetails)) {
        const { timeupdated, latest_timeupdated } = details;
        
        // If latest_timeupdated is newer than timeupdated, an update is available
        if (latest_timeupdated > timeupdated) {
          const trackedMod = trackedMap.get(workshopId);
          const modName = trackedMod?.name || `Workshop Mod ${workshopId}`;
          
          logger.info(`Mod update available: ${modName} (${workshopId}) - local: ${timeupdated}, latest: ${latest_timeupdated}`);
          
          updatedMods.push({
            workshopId,
            name: modName,
            localTimestamp: new Date(timeupdated * 1000),
            latestTimestamp: new Date(latest_timeupdated * 1000)
          });
          
          // Add to tracking if not already tracked
          if (!trackedMod) {
            await addTrackedMod(workshopId, modName);
          }
        }
      }

      this.lastCheck = new Date();
      this.modsNeedingUpdate = updatedMods;

      if (updatedMods.length > 0) {
        logger.info(`${updatedMods.length} mod(s) have updates available`);
        await logServerEvent('mod_update_detected', JSON.stringify(updatedMods.map(m => m.name)));
        
        // Emit socket event
        if (this.io) {
          this.io.emit('mods:updates_available', { 
            count: updatedMods.length,
            mods: updatedMods 
          });
        }
        
        if (this.onUpdateCallback) {
          try {
            await this.onUpdateCallback(updatedMods);
          } catch (callbackError) {
            logger.error(`Mod update callback failed: ${callbackError.message}`);
          }
        }
      } else {
        logger.debug('No mod updates available');
      }

      return { updated: updatedMods.length > 0, mods: updatedMods };
    } catch (error) {
      logger.error(`Mod update check failed: ${error.message}`);
      return { updated: false, mods: [], error: error.message };
    }
  }

  // Get workshop info from ACF file (replaces Steam API)
  async getWorkshopInfo() {
    if (!this.workshopAcfPath || !fs.existsSync(this.workshopAcfPath)) {
      return {};
    }
    
    try {
      const content = fs.readFileSync(this.workshopAcfPath, 'utf-8');
      const parsed = this.parseAcfFile(content);
      
      const result = {};
      for (const [workshopId, installed] of Object.entries(parsed.installedMods)) {
        const details = parsed.modDetails[workshopId] || {};
        result[workshopId] = {
          size: installed.size,
          timeupdated: installed.timeupdated,
          latest_timeupdated: details.latest_timeupdated || installed.timeupdated,
          needsUpdate: details.latest_timeupdated > installed.timeupdated
        };
      }
      
      return result;
    } catch (error) {
      logger.error(`Failed to read workshop ACF: ${error.message}`);
      return {};
    }
  }

  async addModToTrack(workshopId) {
    try {
      const { addTrackedMod } = await import('../database/init.js');
      
      // Try to get mod info from local ACF file
      const allInfo = await this.getWorkshopInfo();
      const modInfo = allInfo[workshopId];
      
      if (modInfo) {
        // We have mod info from ACF
        await addTrackedMod(workshopId, `Workshop Mod ${workshopId}`);
        if (modInfo.timeupdated) {
          await updateModTimestamp(workshopId, new Date(modInfo.timeupdated * 1000).toISOString());
        }
        return { success: true, name: `Workshop Mod ${workshopId}`, needsUpdate: modInfo.needsUpdate };
      } else {
        // Mod not in ACF (not subscribed on this server) - still add to tracking
        await addTrackedMod(workshopId, `Workshop Mod ${workshopId}`);
        return { success: true, name: `Workshop Mod ${workshopId}`, note: 'Mod not found in Steam Workshop cache - may not be subscribed' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getStatus() {
    const trackedMods = await getTrackedMods() || [];
    const workshopInfo = await this.getWorkshopInfo();
    const modsWithUpdates = Object.entries(workshopInfo).filter(([, info]) => info.needsUpdate).length;
    
    return {
      running: !!this.intervalId,
      lastCheck: this.lastCheck,
      lastUpdateDetected: this.lastUpdateDetected,
      checkInterval: this.checkInterval,
      modsNeedingUpdate: this.modsNeedingUpdate,
      workshopAcfConfigured: !!this.workshopAcfPath && fs.existsSync(this.workshopAcfPath),
      workshopAcfPath: this.workshopAcfPath,
      totalModsInWorkshop: Object.keys(workshopInfo).length,
      totalModsTracked: Array.isArray(trackedMods) ? trackedMods.length : 0,
      updatesAvailable: modsWithUpdates,
      autoRestartEnabled: this.autoRestartEnabled,
      // Restart options
      restartWarningMinutes: this.restartWarningMinutes,
      delayIfPlayersOnline: this.delayIfPlayersOnline,
      maxDelayMinutes: this.maxDelayMinutes,
      pendingRestart: this.pendingRestart
    };
  }

  async setCheckInterval(intervalMs) {
    this.checkInterval = Math.max(60000, intervalMs);
    await setSetting('modCheckInterval', this.checkInterval);
    if (this.intervalId) {
      this.stop();
      this.start();
    }
  }

  // Cancel pending restart (if waiting for players)
  cancelPendingRestart() {
    if (this.playerCheckInterval) {
      clearInterval(this.playerCheckInterval);
      this.playerCheckInterval = null;
    }
    this.pendingRestart = false;
    logger.info('ModChecker: Pending restart cancelled');
    
    if (this.io) {
      this.io.emit('mods:restart_cancelled', {});
    }
  }
}
