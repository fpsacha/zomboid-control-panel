import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { createLogger } from '../utils/logger.js';
const log = createLogger('Updates');
import { getSetting, setSetting } from '../database/init.js';

/**
 * Service to check for PZ server updates via Steam
 */
export class UpdateChecker {
  constructor(io) {
    this.io = io;
    this.checkInterval = null;
    this.lastCheck = null;
    this.updateAvailable = null;
    this.isChecking = false;
    
    // Default check interval: 30 minutes
    this.intervalMs = 30 * 60 * 1000;
  }

  /**
   * Start periodic update checking
   */
  async start() {
    // Load saved interval from settings
    const interval = await getSetting('updateCheckInterval');
    if (interval && interval > 0) {
      this.intervalMs = interval * 60 * 1000; // Convert minutes to ms
    }

    // Do initial check after 1 minute (let server fully start)
    this.initialTimeout = setTimeout(() => this.checkForUpdates(), 60 * 1000);

    // Start periodic checks
    this.checkInterval = setInterval(() => {
      this.checkForUpdates();
    }, this.intervalMs);

    log.info(`started (checking every ${this.intervalMs / 60000} minutes)`);
  }

  /**
   * Stop update checking
   */
  stop() {
    if (this.initialTimeout) {
      clearTimeout(this.initialTimeout);
      this.initialTimeout = null;
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    log.info('stopped');
  }

  /**
   * Set check interval in minutes
   */
  async setInterval(minutes) {
    if (minutes < 5) minutes = 5; // Minimum 5 minutes
    if (minutes > 1440) minutes = 1440; // Maximum 24 hours
    
    this.intervalMs = minutes * 60 * 1000;
    await setSetting('updateCheckInterval', minutes);
    
    // Restart the interval
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = setInterval(() => {
        this.checkForUpdates();
      }, this.intervalMs);
    }
    
    log.info(`interval set to ${minutes} minutes`);
  }

  /**
   * Get the currently installed build info from appmanifest
   */
  async getInstalledBuildInfo(serverPath) {
    const manifestPath = path.join(serverPath, 'steamapps', 'appmanifest_380870.acf');
    
    try {
       await fs.promises.access(manifestPath);
    } catch (e) {
       return null;
    }

    try {
      const content = await fs.promises.readFile(manifestPath, 'utf8');
      
      const buildIdMatch = content.match(/"buildid"\s+"(\d+)"/);
      const betaKeyMatch = content.match(/"BetaKey"\s+"([^"]+)"/);
      const lastUpdatedMatch = content.match(/"LastUpdated"\s+"(\d+)"/);
      
      return {
        buildId: buildIdMatch ? buildIdMatch[1] : null,
        branch: betaKeyMatch ? betaKeyMatch[1] : 'public',
        lastUpdated: lastUpdatedMatch ? new Date(parseInt(lastUpdatedMatch[1]) * 1000).toISOString() : null
      };
    } catch (err) {
      log.error(`Failed to read appmanifest: ${err.message}`);
      return null;
    }
  }

  /**
   * Get latest build info from Steam for a specific branch
   */
  async getLatestBuildInfo(steamcmdPath, branch = 'public') {
    const steamcmdExe = path.join(steamcmdPath, 'steamcmd.exe');
      
    try {
        await fs.promises.access(steamcmdExe);
    } catch(e) {
        throw new Error('SteamCMD not found');
    }

    return new Promise((resolve, reject) => {
      const args = [
        '+login', 'anonymous',
        '+app_info_update', '1',
        '+app_info_print', '380870',
        '+quit'
      ];

      const steamcmd = spawn(steamcmdExe, args, {
        cwd: steamcmdPath
      });

      let output = '';
      const timeout = setTimeout(() => {
        steamcmd.kill();
        reject(new Error('SteamCMD timeout'));
      }, 60000); // 60 second timeout

      steamcmd.stdout.on('data', (data) => {
        output += data.toString();
      });

      steamcmd.stderr.on('data', (data) => {
        output += data.toString();
      });

      steamcmd.on('close', (code) => {
        clearTimeout(timeout);
        
        if (code !== 0) {
          return reject(new Error(`SteamCMD exited with code ${code}`));
        }

        // Parse the branch info
        const branchInfo = this.parseBranchFromOutput(output, branch);
        resolve(branchInfo);
      });

      steamcmd.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Parse Steam app_info output to get build info for a specific branch
   */
  parseBranchFromOutput(output, targetBranch) {
    try {
      // Normalize branch name
      const branch = targetBranch === 'stable' ? 'public' : targetBranch;
      
      // Find the branches section
      const branchesMatch = output.match(/"branches"\s*\{([^]*?)\n\t\t\}/);
      if (!branchesMatch) {
        return null;
      }

      const branchesSection = branchesMatch[1];
      
      // Find the specific branch - improved regex
      const branchRegex = new RegExp(`"${branch}"\\s*\\{([^{}]*(?:\\{[^{}]*\\}[^{}]*)*)\\}`, 'i');
      const branchMatch = branchesSection.match(branchRegex);
      
      if (!branchMatch) {
        return null;
      }

      const branchContent = branchMatch[1];
      
      const buildIdMatch = branchContent.match(/"buildid"\s+"(\d+)"/);
      const timeUpdatedMatch = branchContent.match(/"timeupdated"\s+"(\d+)"/);
      const descMatch = branchContent.match(/"description"\s+"([^"]+)"/);

      return {
        branch: targetBranch,
        buildId: buildIdMatch ? buildIdMatch[1] : null,
        timeUpdated: timeUpdatedMatch ? new Date(parseInt(timeUpdatedMatch[1]) * 1000).toISOString() : null,
        description: descMatch ? descMatch[1] : null
      };
    } catch (err) {
      log.error(`Failed to parse Steam output: ${err.message}`);
      return null;
    }
  }

  /**
   * Check for updates
   */
  async checkForUpdates(forceEmit = false) {
    if (this.isChecking) {
      // Add staleness check - if check has been running for more than 2 minutes, reset
      if (this.checkStartTime && Date.now() - this.checkStartTime > 120000) {
        log.warn('UpdateChecker: Previous update check appears stuck, resetting');
        this.isChecking = false;
      } else {
        log.debug('Update check already in progress, skipping');
        return this.updateAvailable;
      }
    }

    this.isChecking = true;
    this.checkStartTime = Date.now();

    try {
      // Get paths from settings
      const steamcmdPath = await getSetting('steamcmdPath');
      const serverPath = await getSetting('serverPath');

      if (!steamcmdPath || !serverPath) {
        log.debug('UpdateChecker: steamcmdPath or serverPath not configured');
        this.isChecking = false;
        return null;
      }

      // Get installed build info
      const installed = await this.getInstalledBuildInfo(serverPath);
      if (!installed || !installed.buildId) {
        log.debug('UpdateChecker: Could not determine installed build');
        this.isChecking = false;
        return null;
      }

      // Get latest build info from Steam
      const latest = await this.getLatestBuildInfo(steamcmdPath, installed.branch);
      if (!latest || !latest.buildId) {
        log.debug('UpdateChecker: Could not get latest build info from Steam');
        this.isChecking = false;
        return null;
      }

      this.lastCheck = new Date().toISOString();

      // Compare build IDs (ensure base 10 parsing)
      const installedBuild = parseInt(installed.buildId, 10);
      const latestBuild = parseInt(latest.buildId, 10);
      
      // Guard against NaN from invalid build IDs
      if (isNaN(installedBuild) || isNaN(latestBuild)) {
        log.warn('UpdateChecker: Invalid build ID format');
        this.isChecking = false;
        return null;
      }

      const updateInfo = {
        updateAvailable: latestBuild > installedBuild,
        installed: {
          buildId: installed.buildId,
          branch: installed.branch,
          lastUpdated: installed.lastUpdated
        },
        latest: {
          buildId: latest.buildId,
          branch: latest.branch,
          timeUpdated: latest.timeUpdated,
          description: latest.description
        },
        lastCheck: this.lastCheck
      };

      // Only emit if update status changed or force emit
      const wasAvailable = this.updateAvailable?.updateAvailable;
      this.updateAvailable = updateInfo;

      if (updateInfo.updateAvailable) {
        log.info(`Server update available! Installed: ${installed.buildId}, Latest: ${latest.buildId} (${installed.branch} branch)`);
        
        if (!wasAvailable || forceEmit) {
          // Emit to all connected clients
          this.io.emit('server:updateAvailable', updateInfo);
        }
      } else {
        log.debug(`Server is up to date (build ${installed.buildId}, ${installed.branch} branch)`);
        
        if (forceEmit) {
          this.io.emit('server:updateCheck', updateInfo);
        }
      }

      return updateInfo;

    } catch (err) {
      log.error(`Update check failed: ${err.message}`);
      this.isChecking = false;
      return null;
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Get current update status without checking
   */
  getStatus() {
    return {
      updateAvailable: this.updateAvailable,
      lastCheck: this.lastCheck,
      intervalMinutes: this.intervalMs / 60000,
      isChecking: this.isChecking
    };
  }
}
