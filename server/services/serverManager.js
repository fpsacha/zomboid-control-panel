import { spawn, exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import { logServerEvent, getSetting, getActiveServer } from '../database/init.js';

// Helper function to escape regex special characters
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class ServerManager {
  constructor() {
    this.serverProcess = null;
    this.serverPath = process.env.PZ_SERVER_PATH || '';
    this.serverBat = process.env.PZ_SERVER_BAT || 'StartServer64.bat';
    this.savePath = process.env.PZ_SAVE_PATH || '';
    this.serverName = 'servertest';
    this.isRunning = false;
    this.startTime = null;
    this.configLoaded = false;
  }

  // Reload config (called when active server changes)
  async reloadConfig() {
    this.configLoaded = false;
    await this.loadConfig();
  }

  // Load settings from active server or legacy database settings
  async loadConfig() {
    if (this.configLoaded) return;
    try {
      // First, try to load from active server (multi-server support)
      const activeServer = await getActiveServer();
      if (activeServer) {
        // Use serverPath if available, otherwise extract from installPath
        let serverDir = activeServer.serverPath || activeServer.installPath;
        
        // If path points to a file (e.g., .bat), extract the directory
        if (serverDir && (serverDir.endsWith('.bat') || serverDir.endsWith('.sh') || serverDir.endsWith('.exe'))) {
          // Extract the batch file name before getting directory
          const batchFileName = path.basename(serverDir);
          serverDir = path.dirname(serverDir);
          // Use the specified batch file
          this.serverBat = batchFileName;
          logger.debug(`ServerManager: Using batch file from installPath: ${batchFileName}`);
        }
        
        if (serverDir) {
          this.serverPath = serverDir;
          logger.debug(`ServerManager: Loaded serverPath: ${serverDir}`);
        }
        
        if (activeServer.serverName) {
          this.serverName = activeServer.serverName;
          // Only look for custom batch file if we didn't already get one from installPath
          if (!this.serverBat || this.serverBat === 'StartServer64.bat') {
            const customBat = `StartServer_${activeServer.serverName}.bat`;
            const customBatPath = path.join(this.serverPath, customBat);
            if (fs.existsSync(customBatPath)) {
              this.serverBat = customBat;
            } else if (activeServer.useNoSteam) {
              this.serverBat = 'StartServer64_nosteam.bat';
            } else {
              this.serverBat = 'StartServer64.bat';
            }
          }
        }
        if (activeServer.zomboidDataPath) {
          this.savePath = activeServer.zomboidDataPath;
        }
        this.configLoaded = true;
        logger.debug(`ServerManager: Loaded config from active server: ${activeServer.name}`);
        return;
      }
      
      // Fallback: load from legacy settings
      const dbServerPath = await getSetting('serverPath');
      const dbServerName = await getSetting('serverName');
      const dbZomboidPath = await getSetting('zomboidDataPath');
      
      if (dbServerPath) {
        this.serverPath = dbServerPath;
        logger.debug(`ServerManager: Loaded serverPath from database: ${dbServerPath}`);
      }
      if (dbServerName) {
        this.serverName = dbServerName;
        // Use custom batch file if server was set up through the app
        this.serverBat = `StartServer_${dbServerName}.bat`;
      }
      if (dbZomboidPath) {
        this.savePath = dbZomboidPath;
      }
      this.configLoaded = true;
    } catch (error) {
      logger.debug(`Could not load server config from database: ${error.message}`);
    }
  }

  async checkServerRunning() {
    return new Promise((resolve) => {
      // Check if ProjectZomboid DEDICATED SERVER is running
      // The dedicated server runs as java.exe with zombie.network.GameServer class
      // The game client also uses ProjectZomboid64.exe, so we need to check command line
      
      // Set a timeout to prevent hanging if PowerShell is slow
      const timeout = setTimeout(() => {
        logger.warn('checkServerRunning: PowerShell timed out, assuming server is not running');
        resolve(false);
      }, 10000); // 10 second timeout
      
      // First, check for java.exe with the GameServer class (primary server detection)
      exec('powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'java.exe\'\\" | Select-Object CommandLine | Format-List"', { timeout: 8000 }, (psError, psStdout) => {
        if (!psError && psStdout) {
          // Check if any java process is running the PZ dedicated server
          const isPZServer = psStdout.toLowerCase().includes('zombie.network.gameserver');
          if (isPZServer) {
            clearTimeout(timeout);
            this.isRunning = true;
            resolve(true);
            return;
          }
        }
        
        // Fallback: Check for standalone server builds (ProjectZomboid64.exe with -server flag)
        // The game client does NOT have -server in its command line
        exec('powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'ProjectZomboid64.exe\'\\" | Select-Object CommandLine | Format-List"', { timeout: 8000 }, (psError2, psStdout2) => {
          clearTimeout(timeout);
          if (psError2 || !psStdout2) {
            this.isRunning = false;
            resolve(false);
            return;
          }
          
          // Check if it's a server process (has -server flag or zombie.network.gameserver)
          const cmdLine = psStdout2.toLowerCase();
          const isServer = cmdLine.includes('-server') || 
                          cmdLine.includes('zombie.network.gameserver') ||
                          cmdLine.includes('startserver');
          
          this.isRunning = isServer;
          resolve(isServer);
        });
      });
    });
  }

  async startServer() {
    // Force reload config from database before starting (settings may have changed)
    this.configLoaded = false;
    await this.loadConfig();
    
    if (!this.serverPath) {
      throw new Error('Server path not configured');
    }

    const isRunning = await this.checkServerRunning();
    if (isRunning) {
      throw new Error('Server is already running');
    }

    const batPath = path.join(this.serverPath, this.serverBat);
    
    if (!fs.existsSync(batPath)) {
      throw new Error(`Server batch file not found: ${batPath}`);
    }

    return new Promise((resolve, reject) => {
      try {
        // Start the server process
        logger.info('Starting server process');
        
        this.serverProcess = spawn('cmd.exe', ['/c', this.serverBat], {
          cwd: this.serverPath,
          detached: true,
          stdio: 'ignore'
        });
        
        // Handle spawn errors (e.g., invalid path, permissions)
        this.serverProcess.on('error', (error) => {
          logger.error(`Server process error: ${error.message}`);
          this.isRunning = false;
          this.serverProcess = null;
        });
        
        this.serverProcess.unref();
        this.isRunning = true;
        this.startTime = new Date();
        
        logServerEvent('server_start', 'Server started via manager');
        logger.info('Server start command executed');
        
        resolve({ success: true, message: 'Server start command executed' });
      } catch (error) {
        logger.error(`Failed to start server: ${error.message}`);
        reject(error);
      }
    });
  }

  async stopServer(graceful = true) {
    if (graceful) {
      // This should be done via RCON 'quit' command
      // This method is for force stopping
      logger.info('Graceful stop requested - use RCON quit command');
      return { success: true, message: 'Use RCON quit command for graceful shutdown' };
    }

    return new Promise((resolve, reject) => {
      // First try to kill java.exe running the PZ dedicated server
      exec('powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'java.exe\'\\" | Where-Object { $_.CommandLine -like \'*zombie.network.gameserver*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"', (javaErr) => {
        // Also try to kill ProjectZomboid64.exe (for standalone builds)
        exec('taskkill /IM ProjectZomboid64.exe /F', (pzError, stdout, stderr) => {
          // Check if at least one process was killed
          const javaKilled = !javaErr;
          const pzKilled = !pzError;
          
          if (!javaKilled && !pzKilled) {
            // Neither process found - server wasn't running
            if (pzError && pzError.message.includes('not found')) {
              resolve({ success: true, message: 'Server was not running' });
              return;
            }
            // Some other error
            resolve({ success: true, message: 'Server may not have been running' });
            return;
          }
          
          this.isRunning = false;
          this.serverProcess = null;
          this.startTime = null;
          
          logServerEvent('server_stop', 'Server force stopped');
          logger.info('Server force stopped');
          
          resolve({ success: true, message: 'Server stopped' });
        });
      });
    });
  }

  async restartServer(rconService, warningMinutes = 5) {
    try {
      // Helper to send message with timeout (don't let RCON failures block restart)
      const sendWarning = async (msg) => {
        try {
          await Promise.race([
            rconService.serverMessage(msg),
            this.sleep(5000).then(() => { throw new Error('RCON timeout'); })
          ]);
        } catch (e) {
          logger.warn(`Failed to send restart warning: ${e.message}`);
        }
      };

      // Send warning messages
      const warnings = [5, 4, 3, 2, 1];
      for (const minutes of warnings) {
        if (minutes <= warningMinutes) {
          await sendWarning(`Server restarting in ${minutes} minute(s)!`);
          if (minutes > 1) {
            await this.sleep(60000); // Wait 1 minute
          }
        }
      }

      // Final warning
      await sendWarning('Server restarting NOW!');
      await this.sleep(5000);

      // Save the world (with timeout)
      try {
        await Promise.race([
          rconService.save(),
          this.sleep(10000).then(() => { throw new Error('Save timeout'); })
        ]);
      } catch (e) {
        logger.warn(`Save before restart failed: ${e.message}`);
      }
      await this.sleep(3000);

      // Quit the server (with timeout)
      try {
        await Promise.race([
          rconService.quit(),
          this.sleep(10000).then(() => { throw new Error('Quit timeout'); })
        ]);
      } catch (e) {
        logger.warn(`RCON quit failed, will force stop: ${e.message}`);
      }
      await this.sleep(10000);

      // Wait for server to fully stop
      let attempts = 0;
      while (await this.checkServerRunning() && attempts < 30) {
        await this.sleep(1000);
        attempts++;
      }

      // Force stop if still running
      if (await this.checkServerRunning()) {
        await this.stopServer(false);
        await this.sleep(5000);
      }

      // Start the server
      await this.startServer();

      logServerEvent('server_restart', 'Server restarted');
      return { success: true, message: 'Server restarted successfully' };
    } catch (error) {
      logger.error(`Restart failed: ${error.message}`);
      throw error;
    }
  }

  async getServerStatus() {
    // Ensure config is loaded before returning status
    await this.loadConfig();
    
    const isRunning = await this.checkServerRunning();
    
    // Calculate uptime in seconds (not milliseconds)
    const uptimeMs = this.startTime ? Date.now() - this.startTime.getTime() : 0;
    const uptimeSeconds = Math.floor(uptimeMs / 1000);
    
    return {
      running: isRunning,
      startTime: this.startTime,
      uptime: uptimeSeconds,
      serverPath: this.serverPath,
      configured: !!this.serverPath
    };
  }

  async getServerConfig() {
    await this.loadConfig();  // Ensure config is loaded
    
    if (!this.savePath) {
      return null;
    }

    // Try the actual server name first (proper path: savePath/Server/{serverName}.ini)
    const serverConfigDir = path.join(this.savePath, 'Server');
    const serverNameIniPath = path.join(serverConfigDir, `${this.serverName}.ini`);
    
    if (fs.existsSync(serverNameIniPath)) {
      logger.debug(`ServerManager: Reading config from ${serverNameIniPath}`);
      return this.parseIniFile(serverNameIniPath);
    }
    
    // Fallback: try old path directly in savePath (for backwards compatibility)
    const configPath = path.join(this.savePath, `${this.serverName}.ini`);
    if (fs.existsSync(configPath)) {
      logger.debug(`ServerManager: Reading config from fallback ${configPath}`);
      return this.parseIniFile(configPath);
    }
    
    // Legacy fallback: servertest.ini
    const legacyPath = path.join(this.savePath, 'servertest.ini');
    if (fs.existsSync(legacyPath)) {
      logger.debug(`ServerManager: Reading config from legacy ${legacyPath}`);
      return this.parseIniFile(legacyPath);
    }
    
    // Try alternative path
    const altPath = path.join(this.savePath, 'serveroptions.ini');
    if (fs.existsSync(altPath)) {
      return this.parseIniFile(altPath);
    }
    
    logger.warn(`ServerManager: No config file found. Tried: ${serverNameIniPath}, ${configPath}, ${legacyPath}`);
    return null;
  }

  parseIniFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const config = {};
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith(';')) {
          const [key, ...valueParts] = trimmed.split('=');
          if (key && valueParts.length > 0) {
            config[key.trim()] = valueParts.join('=').trim();
          }
        }
      }

      return config;
    } catch (error) {
      logger.error(`Failed to parse config file: ${error.message}`);
      return null;
    }
  }

  async saveServerConfig(config) {
    if (!this.savePath) {
      throw new Error('Save path not configured');
    }

    const configPath = path.join(this.savePath, 'servertest.ini');
    
    try {
      // Read existing file to preserve comments and structure
      let content = '';
      if (fs.existsSync(configPath)) {
        content = fs.readFileSync(configPath, 'utf-8');
      }

      // Update values
      for (const [key, value] of Object.entries(config)) {
        // Validate key is a valid identifier (alphanumeric and underscore only)
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          logger.warn(`Invalid config key skipped: ${key}`);
          continue;
        }
        const escapedKey = escapeRegExp(key);
        const regex = new RegExp(`^${escapedKey}=.*$`, 'm');
        if (content.match(regex)) {
          content = content.replace(regex, `${key}=${value}`);
        } else {
          content += `\n${key}=${value}`;
        }
      }

      fs.writeFileSync(configPath, content, 'utf-8');
      logger.info('Server config saved');
      return { success: true };
    } catch (error) {
      logger.error(`Failed to save config: ${error.message}`);
      throw error;
    }
  }

  async getModList() {
    if (!this.savePath) {
      return [];
    }

    try {
      const config = await this.getServerConfig();
      if (!config || !config.Mods) {
        return [];
      }

      const mods = config.Mods.split(';').filter(m => m.trim());
      const workshopIds = config.WorkshopItems ? 
        config.WorkshopItems.split(';').filter(m => m.trim()) : [];

      return mods.map((mod, index) => ({
        name: mod,
        workshopId: workshopIds[index] || null
      }));
    } catch (error) {
      logger.error(`Failed to get mod list: ${error.message}`);
      return [];
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  updatePaths(serverPath, savePath) {
    this.serverPath = serverPath || this.serverPath;
    this.savePath = savePath || this.savePath;
  }
}
