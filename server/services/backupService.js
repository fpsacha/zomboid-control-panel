import path from 'path';
import fs from 'fs';
import { createWriteStream } from 'fs';
import archiver from 'archiver';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { createLogger } from '../utils/logger.js';
const log = createLogger('Backup');
import { getActiveServer, getSetting, setSetting, logServerEvent } from '../database/init.js';

// Dynamic import for unzipper (CommonJS module)
let unzipper;
async function getUnzipper() {
  if (!unzipper) {
    unzipper = await import('unzipper');
  }
  return unzipper;
}

export class BackupService {
  constructor() {
    this.backupInProgress = false;
    this.restoreInProgress = false;
    this.lastBackup = null;
    this.backupHistory = [];
  }

  /**
   * Get the saves folder path for the current server
   */
  async getSavesPath() {
    try {
      const activeServer = await getActiveServer();
      
      if (activeServer?.zomboidDataPath && activeServer?.serverName) {
        const savesPath = path.join(activeServer.zomboidDataPath, 'Saves', 'Multiplayer', activeServer.serverName);
        if (fs.existsSync(savesPath)) {
          return savesPath;
        }
        // Try without serverName subfolder - but only if the folder matches the expected name
        const baseSavesPath = path.join(activeServer.zomboidDataPath, 'Saves', 'Multiplayer');
        if (fs.existsSync(baseSavesPath)) {
          // Look for a folder that matches the server name (case-insensitive)
          const folders = fs.readdirSync(baseSavesPath, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
          // First try exact match
          const exactMatch = folders.find(f => f === activeServer.serverName);
          if (exactMatch) {
            return path.join(baseSavesPath, exactMatch);
          }
          // Then try case-insensitive match
          const caseInsensitiveMatch = folders.find(f => f.toLowerCase() === activeServer.serverName.toLowerCase());
          if (caseInsensitiveMatch) {
            return path.join(baseSavesPath, caseInsensitiveMatch);
          }
          // Only use first folder as last resort with a warning
          if (folders.length > 0) {
            log.warn(`Could not find save folder matching "${activeServer.serverName}", using first available: ${folders[0]}`);
            return path.join(baseSavesPath, folders[0]);
          }
        }
      }
      
      // Fallback to legacy settings
      const zomboidDataPath = await getSetting('zomboidDataPath');
      const serverName = await getSetting('serverName');
      
      if (zomboidDataPath && serverName) {
        return path.join(zomboidDataPath, 'Saves', 'Multiplayer', serverName);
      }
      
      return null;
    } catch (error) {
      log.error(`Failed to get saves path: ${error.message}`);
      return null;
    }
  }

  /**
   * Get the backups folder path
   */
  async getBackupsPath() {
    try {
      const activeServer = await getActiveServer();
      let basePath;
      
      if (activeServer?.zomboidDataPath) {
        basePath = activeServer.zomboidDataPath;
      } else {
        basePath = await getSetting('zomboidDataPath');
      }
      
      if (!basePath) {
        // Use local backups folder as fallback
        const { getDataPaths } = await import('../utils/paths.js');
        basePath = getDataPaths().dataDir;
      }
      
      const backupsPath = path.join(basePath, 'backups');
      
      // Ensure backups folder exists
      if (!fs.existsSync(backupsPath)) {
        fs.mkdirSync(backupsPath, { recursive: true });
      }
      
      return backupsPath;
    } catch (error) {
      log.error(`Failed to get backups path: ${error.message}`);
      return null;
    }
  }

  /**
   * Get backup settings
   */
  async getSettings() {
    const enabled = await getSetting('backupEnabled') || false;
    const schedule = await getSetting('backupSchedule') || '0 */6 * * *'; // Every 6 hours
    const maxBackups = await getSetting('backupMaxCount') || 10;
    const includeDb = await getSetting('backupIncludeDb') || false;
    
    return { enabled, schedule, maxBackups, includeDb };
  }

  /**
   * Update backup settings
   */
  async updateSettings(settings) {
    if (settings.enabled !== undefined) {
      await setSetting('backupEnabled', settings.enabled);
    }
    if (settings.schedule !== undefined) {
      await setSetting('backupSchedule', settings.schedule);
    }
    if (settings.maxBackups !== undefined) {
      await setSetting('backupMaxCount', settings.maxBackups);
    }
    if (settings.includeDb !== undefined) {
      await setSetting('backupIncludeDb', settings.includeDb);
    }
    
    return this.getSettings();
  }

  /**
   * Create a backup of the server world
   */
  async createBackup(options = {}) {
    if (this.backupInProgress) {
      return { success: false, message: 'Backup already in progress' };
    }

    this.backupInProgress = true;
    const startTime = Date.now();
    const io = options.io; // Socket.IO for progress updates

    // Helper to emit progress
    const emitProgress = (phase, percent, message, extra = {}) => {
      if (io) {
        io.emit('backup:progress', { phase, percent, message, ...extra });
      }
    };

    // Wrap in try-finally to ensure mutex is always released
    try {
      return await this._doCreateBackup(options, startTime, emitProgress);
    } catch (error) {
      log.error(`Backup failed: ${error.message}`);
      emitProgress('error', 0, `Backup failed: ${error.message}`);
      return { success: false, message: error.message };
    } finally {
      this.backupInProgress = false;
    }
  }

  /**
   * Internal backup implementation
   */
  async _doCreateBackup(options, startTime, emitProgress) {
    emitProgress('preparing', 5, 'Preparing backup...');
    
    const savesPath = await this.getSavesPath();
    const backupsPath = await this.getBackupsPath();
      
      if (!savesPath) {
        throw new Error('Could not determine saves folder path. Please configure the server first.');
      }
      
      if (!fs.existsSync(savesPath)) {
        throw new Error(`Saves folder not found: ${savesPath}`);
      }
      
      if (!backupsPath) {
        throw new Error('Could not determine backups folder path');
      }

      // Generate backup filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const activeServer = await getActiveServer();
      const serverName = activeServer?.serverName || 'server';
      const backupName = `${serverName}_${timestamp}.zip`;
      const backupPath = path.join(backupsPath, backupName);

      log.info(`Starting backup: ${backupName}`);
      log.info(`Source: ${savesPath}`);
      log.info(`Destination: ${backupPath}`);
      
      emitProgress('preparing', 10, 'Scanning files...');

      // Count total files for progress (asynchronously to avoid blocking)
      let totalFiles = 0;
      const countFiles = async (dir) => {
        try {
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          // Use Promise.all to process directories in parallel
          const counts = await Promise.all(entries.map(async (entry) => {
            if (entry.isDirectory()) {
              return countFiles(path.join(dir, entry.name));
            } else {
              return 1;
            }
          }));
          return counts.reduce((a, b) => a + b, 0);
        } catch (e) {
          // Ignore errors during counting (e.g. permission denied)
          return 0;
        }
      };
      
      try {
          totalFiles = await countFiles(savesPath);
      } catch (err) {
          log.warn(`Failed to count files: ${err.message}`);
          totalFiles = 1000; // Fallback estimate
      }

      // Get database path if needed (before entering Promise callback)
      let dbPathToInclude = null;
      if (options.includeDb) {
        const { getDataPaths } = await import('../utils/paths.js');
        const dbPath = getDataPaths().dbPath;
        if (fs.existsSync(dbPath)) {
          dbPathToInclude = dbPath;
          totalFiles++;
        }
      }

      emitProgress('archiving', 15, `Found ${totalFiles} files to backup...`, { totalFiles });

      // Create zip archive
      const output = createWriteStream(backupPath);
      const archive = archiver('zip', {
        zlib: { level: 6 } // Moderate compression
      });

      let filesProcessed = 0;

      return new Promise((resolve, reject) => {
        // Track progress during archiving
        archive.on('entry', (entry) => {
          filesProcessed++;
          const percent = Math.min(15 + Math.round((filesProcessed / totalFiles) * 75), 90);
          if (filesProcessed % 50 === 0 || filesProcessed === totalFiles) {
            emitProgress('archiving', percent, `Archiving files... (${filesProcessed}/${totalFiles})`, {
              filesProcessed,
              totalFiles,
              currentFile: entry.name
            });
          }
        });

        output.on('close', async () => {
          emitProgress('finalizing', 95, 'Finalizing backup...');
          
          const duration = ((Date.now() - startTime) / 1000).toFixed(1);
          const sizeBytes = archive.pointer();
          const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
          
          log.info(`Backup completed: ${backupName} (${sizeMB} MB) in ${duration}s`);
          
          this.lastBackup = {
            name: backupName,
            path: backupPath,
            size: sizeBytes,
            created: new Date().toISOString()
          };

          await logServerEvent('backup_created', `${backupName} (${sizeMB} MB)`);
          
          // Clean up old backups
          await this.cleanupOldBackups();
          
          emitProgress('complete', 100, `Backup complete! (${sizeMB} MB in ${duration}s)`);
          
          resolve({
            success: true,
            backup: this.lastBackup,
            duration: parseFloat(duration)
          });
        });

        output.on('error', (err) => {
          emitProgress('error', 0, `Backup failed: ${err.message}`);
          reject(err);
        });

        archive.on('error', (err) => {
          emitProgress('error', 0, `Archive error: ${err.message}`);
          reject(err);
        });

        archive.on('warning', (err) => {
          if (err.code === 'ENOENT') {
            log.warn(`Backup warning: ${err.message}`);
          } else {
            reject(err);
          }
        });

        archive.pipe(output);

        // Add the saves folder to the archive
        archive.directory(savesPath, path.basename(savesPath));

        // Optionally include database
        if (dbPathToInclude) {
          archive.file(dbPathToInclude, { name: 'db.json' });
        }

        archive.finalize();
      });
  }

  /**
   * Get list of existing backups
   */
  async listBackups() {
    try {
      const backupsPath = await this.getBackupsPath();
      if (!backupsPath || !fs.existsSync(backupsPath)) {
        return [];
      }

      const files = await fs.promises.readdir(backupsPath);
      
      const backups = await Promise.all(files
        .filter(f => f.endsWith('.zip'))
        .map(async f => {
            try {
                const filePath = path.join(backupsPath, f);
                const stats = await fs.promises.stat(filePath);
                return {
                    name: f,
                    path: filePath,
                    size: stats.size,
                    created: stats.birthtime.toISOString()
                };
            } catch (e) {
                return null;
            }
        }));

      return backups
        .filter(b => b !== null)
        .sort((a, b) => new Date(b.created) - new Date(a.created)); // Newest first
        
    } catch (error) {
      log.error(`Failed to list backups: ${error.message}`);
      return [];
    }
  }

  /**
   * Delete a backup
   */
  async deleteBackup(backupName) {
    try {
      const backupsPath = await this.getBackupsPath();
      if (!backupsPath) {
        throw new Error('Backups folder not found');
      }

      // Sanitize filename to prevent path traversal
      const safeName = path.basename(backupName);
      if (!safeName.endsWith('.zip')) {
        throw new Error('Invalid backup file');
      }

      const backupPath = path.join(backupsPath, safeName);
      
      if (!fs.existsSync(backupPath)) {
        throw new Error('Backup not found');
      }

      fs.unlinkSync(backupPath);
      log.info(`Deleted backup: ${safeName}`);
      await logServerEvent('backup_deleted', safeName);
      
      return { success: true };
    } catch (error) {
      log.error(`Failed to delete backup: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Clean up old backups based on maxBackups setting
   */
  async cleanupOldBackups() {
    try {
      const settings = await this.getSettings();
      const backups = await this.listBackups();
      
      if (backups.length <= settings.maxBackups) {
        return;
      }

      // Delete oldest backups
      const toDelete = backups.slice(settings.maxBackups);
      for (const backup of toDelete) {
        await this.deleteBackup(backup.name);
        log.info(`Cleaned up old backup: ${backup.name}`);
      }
    } catch (error) {
      log.error(`Failed to cleanup old backups: ${error.message}`);
    }
  }

  /**
   * Delete backups older than X days
   */
  async deleteBackupsOlderThan(days) {
    try {
      const backups = await this.listBackups();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);
      
      const toDelete = backups.filter(backup => {
        const backupDate = new Date(backup.created);
        return backupDate < cutoffDate;
      });
      
      if (toDelete.length === 0) {
        return { success: true, deleted: 0, message: `No backups older than ${days} days found` };
      }
      
      let deletedCount = 0;
      let failedCount = 0;
      const deletedNames = [];
      
      for (const backup of toDelete) {
        const result = await this.deleteBackup(backup.name);
        if (result.success) {
          deletedCount++;
          deletedNames.push(backup.name);
        } else {
          failedCount++;
        }
      }
      
      log.info(`Deleted ${deletedCount} backups older than ${days} days`);
      
      return { 
        success: true, 
        deleted: deletedCount, 
        failed: failedCount,
        deletedNames,
        message: `Deleted ${deletedCount} backup${deletedCount !== 1 ? 's' : ''} older than ${days} days${failedCount > 0 ? ` (${failedCount} failed)` : ''}` 
      };
    } catch (error) {
      log.error(`Failed to delete old backups: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get backup status
   */
  async getStatus() {
    const settings = await this.getSettings();
    const backups = await this.listBackups();
    const savesPath = await this.getSavesPath();
    const backupsPath = await this.getBackupsPath();
    
    return {
      ...settings,
      backupInProgress: this.backupInProgress,
      restoreInProgress: this.restoreInProgress || false,
      lastBackup: this.lastBackup,
      backupCount: backups.length,
      savesPath,
      backupsPath,
      savesExists: savesPath ? fs.existsSync(savesPath) : false
    };
  }

  /**
   * Get info about what's included in a backup
   */
  getBackupContentsInfo() {
    return {
      description: 'Server world save data',
      includes: [
        'map_*.bin - World map chunk data',
        'map_meta.bin - Map metadata',
        'map_sand.bin - Sandbox settings snapshot',
        'players/ - Player save files',
        'vehicles.db - Vehicle data',
        'reanimated.bin - Zombie data',
        'worldstats.txt - World statistics',
        'Other world-specific data files'
      ],
      location: 'Saves/Multiplayer/{ServerName}/',
      note: 'Backups contain the entire world state. Server must be stopped before restoring.'
    };
  }

  /**
   * Restore a backup
   * WARNING: This will overwrite the current world save!
   */
  async restoreBackup(backupName, options = {}) {
    if (this.restoreInProgress) {
      return { success: false, message: 'Restore already in progress' };
    }

    if (this.backupInProgress) {
      return { success: false, message: 'Backup in progress, please wait' };
    }

    this.restoreInProgress = true;
    const startTime = Date.now();

    try {
      const backupsPath = await this.getBackupsPath();
      const savesPath = await this.getSavesPath();
      
      if (!backupsPath) {
        throw new Error('Could not determine backups folder path');
      }
      
      if (!savesPath) {
        throw new Error('Could not determine saves folder path. Please configure the server first.');
      }

      // Sanitize backup name
      const safeName = path.basename(backupName);
      if (!safeName.endsWith('.zip')) {
        throw new Error('Invalid backup file');
      }

      const backupPath = path.join(backupsPath, safeName);
      
      if (!fs.existsSync(backupPath)) {
        throw new Error(`Backup not found: ${safeName}`);
      }

      log.info(`Starting restore from: ${safeName}`);
      log.info(`Destination: ${savesPath}`);

      // Create a pre-restore backup if requested
      if (options.createPreRestoreBackup !== false) {
        log.info('Creating pre-restore backup...');
        const preBackupResult = await this.createBackup({ isPreRestore: true });
        if (!preBackupResult.success) {
          log.error(`Pre-restore backup failed: ${preBackupResult.message}`);
          return { success: false, message: `Cannot restore: pre-restore backup failed (${preBackupResult.message}). Aborting to protect save data.` };
        }
      }

      // Get parent directory and expected folder name
      const savesParentPath = path.dirname(savesPath);
      const expectedFolderName = path.basename(savesPath);

      // Clear the existing saves folder
      if (fs.existsSync(savesPath)) {
        log.info('Removing existing saves folder...');
        fs.rmSync(savesPath, { recursive: true, force: true });
      }

      // Ensure parent directory exists
      if (!fs.existsSync(savesParentPath)) {
        fs.mkdirSync(savesParentPath, { recursive: true });
      }

      // Extract the backup
      log.info('Extracting backup...');
      const unzip = await getUnzipper();
      
      await new Promise((resolve, reject) => {
        const extractStream = createReadStream(backupPath)
          .pipe(unzip.Extract({ path: savesParentPath }));
        
        extractStream.on('close', resolve);
        extractStream.on('error', reject);
      });

      // Verify the restore
      if (!fs.existsSync(savesPath)) {
        // Check if it extracted with a different folder name
        const extracted = fs.readdirSync(savesParentPath).filter(f => 
          fs.statSync(path.join(savesParentPath, f)).isDirectory()
        );
        
        if (extracted.length > 0) {
          // Find the newly extracted folder (the one that matches the backup pattern)
          for (const folder of extracted) {
            const folderPath = path.join(savesParentPath, folder);
            // Check if this looks like a world save folder
            if (fs.existsSync(path.join(folderPath, 'map_meta.bin')) || 
                fs.existsSync(path.join(folderPath, 'map_t.bin'))) {
              // Rename to expected folder name if different
              if (folder !== expectedFolderName) {
                log.info(`Renaming extracted folder from ${folder} to ${expectedFolderName}`);
                fs.renameSync(folderPath, savesPath);
              }
              break;
            }
          }
        }
      }

      if (!fs.existsSync(savesPath)) {
        throw new Error('Restore may have failed - saves folder not found after extraction');
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      log.info(`Restore completed in ${duration}s`);
      
      await logServerEvent('backup_restored', `Restored from ${safeName}`);

      this.restoreInProgress = false;
      return {
        success: true,
        message: `Restored from ${safeName}`,
        duration: parseFloat(duration)
      };

    } catch (error) {
      this.restoreInProgress = false;
      log.error(`Restore failed: ${error.message}`);
      await logServerEvent('restore_failed', error.message);
      return { success: false, message: error.message };
    }
  }
}
