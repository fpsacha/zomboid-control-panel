import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { createLogger } from '../utils/logger.js';
const log = createLogger('API:Server');
import { logServerEvent, setSetting, getSetting, getActiveServer } from '../database/init.js';

const router = express.Router();

// Track active Steam operations to prevent concurrent runs on the same path
const activeSteamOperations = new Map();

// Helper to auto-configure RCON in the server's .ini file
// This is called after server starts and creates the .ini file
async function ensureRconConfigured() {
  try {
    const activeServer = await getActiveServer();
    if (!activeServer) {
      log.debug('ensureRconConfigured: No active server');
      return false;
    }
    
    const serverConfigPath = activeServer.serverConfigPath || 
      (activeServer.zomboidDataPath ? path.join(activeServer.zomboidDataPath, 'Server') : null);
    const serverName = activeServer.serverName;
    const rconPassword = activeServer.rconPassword;
    const rconPort = activeServer.rconPort || 27015;
    
    if (!serverConfigPath || !serverName) {
      log.debug('ensureRconConfigured: Missing serverConfigPath or serverName');
      return false;
    }
    
    const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
    
    if (!fs.existsSync(iniPath)) {
      log.debug(`ensureRconConfigured: INI file not found at ${iniPath}`);
      return false;
    }
    
    // Check if RCON is already configured correctly
    let content = fs.readFileSync(iniPath, 'utf-8');
    const hasCorrectPassword = content.includes(`RCONPassword=${rconPassword}`);
    const hasCorrectPort = content.includes(`RCONPort=${rconPort}`);
    
    if (hasCorrectPassword && hasCorrectPort) {
      log.debug('ensureRconConfigured: RCON already configured correctly');
      return true;
    }
    
    // Update RCON settings in the .ini file
    log.info(`Auto-configuring RCON in ${iniPath}`);
    
    // Update RCONPassword
    if (content.includes('RCONPassword=')) {
      content = content.replace(/RCONPassword=.*/g, () => `RCONPassword=${rconPassword}`);
    } else {
      content += `\nRCONPassword=${rconPassword}`;
    }
    
    // Update RCONPort
    if (content.includes('RCONPort=')) {
      content = content.replace(/RCONPort=.*/g, () => `RCONPort=${rconPort}`);
    } else {
      content += `\nRCONPort=${rconPort}`;
    }
    
    fs.writeFileSync(iniPath, content, 'utf-8');
    log.info('RCON auto-configured successfully in server .ini file');
    return true;
  } catch (error) {
    log.error(`ensureRconConfigured error: ${error.message}`);
    return false;
  }
}

// Helper functions for multi-server support
async function getServerConfigPath() {
  const activeServer = await getActiveServer();
  if (activeServer?.serverConfigPath) {
    return activeServer.serverConfigPath;
  }
  const legacyPath = await getSetting('serverConfigPath');
  return legacyPath || null;
}

async function getServerName() {
  const activeServer = await getActiveServer();
  if (activeServer?.serverName) {
    return activeServer.serverName;
  }
  const legacyName = await getSetting('serverName');
  return legacyName || 'servertest';
}

// Security: Sanitize string for use in batch files/commands
function sanitizeForBatch(str) {
  if (!str) return '';
  // Remove or escape dangerous characters for batch files
  return String(str)
    .replace(/[&|<>^%"`;$(){}[\]!]/g, '') // Remove shell metacharacters
    .replace(/\.\./g, '') // Remove path traversal
    .trim();
}

// Security: Validate server name (alphanumeric, underscore, hyphen only)
function isValidServerName(name) {
  if (!name || typeof name !== 'string') return false;
  return /^[a-zA-Z0-9_-]{1,64}$/.test(name);
}

// Security: Validate path is safe (no traversal, absolute path)
function isValidPath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') return false;
  const normalized = path.normalize(inputPath);
  // Check for path traversal attempts
  if (normalized.includes('..')) return false;
  // Must be absolute path on Windows
  if (!path.isAbsolute(normalized)) return false;
  return true;
}

// Security: Validate integer in range
function validateInt(value, min, max, defaultVal) {
  const num = parseInt(value, 10);
  if (isNaN(num) || num < min || num > max) return defaultVal;
  return num;
}

// Generate a custom startup batch file with configured options
function generateStartupBatch(options) {
  const {
    installPath,
    serverName,
    minMemory = 4,
    maxMemory = 8,
    zomboidDataPath,
    adminPassword,
    serverPort = 16261,
    useNoSteam = false,
    useDebug = false
  } = options;

  // Sanitize inputs for batch file safety
  const safeServerName = sanitizeForBatch(serverName);
  const safeAdminPassword = adminPassword ? sanitizeForBatch(adminPassword) : '';
  const safeZomboidDataPath = zomboidDataPath ? sanitizeForBatch(zomboidDataPath) : '';

  // Build JVM arguments
  const jvmArgs = [
    '-Djava.awt.headless=true',
    useNoSteam ? '-Dzomboid.steam=0' : '-Dzomboid.steam=1',
    '-Dzomboid.znetlog=1',
    '-XX:+UseZGC',
    '-XX:-CreateCoredumpOnCrash',
    '-XX:-OmitStackTraceInFastThrow',
    `-Xms${minMemory}g`,
    `-Xmx${maxMemory}g`,
  ];

  // Add debug flag if enabled
  if (useDebug) {
    jvmArgs.push('-Ddebug');
  }

  // Build game arguments
  const gameArgs = [
    `-servername "${safeServerName}"`,
  ];

  // Add custom cache/data directory if specified (uses -cachedir game arg)
  if (safeZomboidDataPath) {
    gameArgs.push(`-cachedir="${safeZomboidDataPath}"`);
  }

  if (safeAdminPassword) {
    gameArgs.push(`-adminpassword "${safeAdminPassword}"`);
  }

  if (serverPort !== 16261) {
    gameArgs.push(`-port ${serverPort}`);
  }

  if (useNoSteam) {
    gameArgs.push('-nosteam');
  }

  gameArgs.push('-statistic 0');

  const batchContent = `@echo off
@setlocal enableextensions
@cd /d "%~dp0"

REM =====================================================
REM Project Zomboid Server Startup Script
REM Generated by PZ Server Manager
REM Server Name: ${safeServerName}
REM Memory: ${minMemory}GB - ${maxMemory}GB
REM =====================================================

SET PZ_CLASSPATH=java/;java/projectzomboid.jar

".\\jre64\\bin\\java.exe" ${jvmArgs.join(' ')} -Djava.library.path=natives/;natives/win64/;. -cp %PZ_CLASSPATH% zombie.network.GameServer ${gameArgs.join(' ')}

PAUSE
`;

  return batchContent;
}

// Get server status
router.get('/status', async (req, res) => {
  try {
    const serverManager = req.app.get('serverManager');
    const rconService = req.app.get('rconService');
    
    const status = await serverManager.getServerStatus();
    const rconStatus = rconService.getConfig();
    
    res.json({
      ...status,
      rcon: rconStatus
    });
  } catch (error) {
    log.error(`Failed to get server status: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Start server
router.post('/start', async (req, res) => {
  try {
    const serverManager = req.app.get('serverManager');
    const rconService = req.app.get('rconService');
    const result = await serverManager.startServer();
    
    // Emit status update via Socket.IO
    const io = req.app.get('io');
    
    // Set flag to prevent RCON reconnect attempts during startup
    // Use setServerStarting which has a 5-minute failsafe timeout
    if (rconService.setServerStarting) {
      rconService.setServerStarting(true);
    } else {
      rconService.serverStarting = true;
    }
    
    // Poll for server to actually be running (takes a few seconds to start)
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds max
    let pollCleared = false;
    
    const pollInterval = setInterval(async () => {
      if (pollCleared) return; // Safety check
      try {
        attempts++;
        const isRunning = await serverManager.checkServerRunning();
        
        if (isRunning) {
          pollCleared = true;
          clearInterval(pollInterval);
          io.emit('server:status', { running: true });
          log.info('Server detected as running');
          
          // Wait for RCON to be ready (PZ takes 60-180s to fully start)
          // Look for open port instead of blindly waiting
          // Keep serverStarting=true the whole time to block auto-reconnect
          log.info('Waiting for RCON to be ready - starting port polling...');
          
          await rconService.loadConfig(); // Ensure clean config
          const rconHost = rconService.config.host || '127.0.0.1';
          const rconPort = rconService.config.port || 27015;
          log.info(`Monitoring TCP port ${rconHost}:${rconPort} for activity...`);

          let rconConnected = false;
          let rconConfigured = false;
          let portOpen = false;
          
          // Poll port for up to 5 minutes (300 seconds) - checking every 5 seconds
          const maxPollAttempts = 60; 
          
          for (let i = 0; i < maxPollAttempts; i++) {
            // 1. Check if port is open (if not already found)
            if (!portOpen) {
               portOpen = await rconService.checkPortOpen(rconHost, rconPort);
               
               if (!portOpen) {
                 log.debug(`RCON startup: Port ${rconHost}:${rconPort} not yet open (poll ${i+1}/${maxPollAttempts})...`);
                 // Wait 5 seconds before next check
                 await new Promise(r => setTimeout(r, 5000));
                 
                 // Periodically try to configure RCON (Wait for .ini to appear)
                 if (!rconConfigured && (i % 3 === 0)) { // Every 15s (3 * 5s)
                    rconConfigured = await ensureRconConfigured();
                    if (rconConfigured) {
                      log.info('RCON settings auto-configured in server .ini file during startup wait');
                    }
                 }
                 continue;
               }
               log.info(`RCON port ${rconHost}:${rconPort} is now open! Initiating connection...`);
            }
            
            // 2. Port is open, try to connect
            // Reset connection state before attempt to clear any stalled state
            if (rconService.forceResetConnectionState) {
              rconService.forceResetConnectionState();
            }
            
            try {
              // Attempt connection with a 15s timeout
              const connectPromise = rconService.connect();
              const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Connection attempt timed out after 15s')), 15000)
              );
              
              await Promise.race([connectPromise, timeoutPromise]);
              
              if (rconService.connected) {
                log.info('RCON connected successfully after server startup');
                rconConnected = true;
                break;
              } else {
                log.warn(`RCON connected to port but authentication/handshake failed. Retrying...`);
                // Wait a bit before retry if port is open but auth fails (service might be starting up)
                await new Promise(r => setTimeout(r, 5000));
              }
            } catch (e) {
              log.warn(`RCON connection attempt failed: ${e.message}`);
              await new Promise(r => setTimeout(r, 5000));
            }
          }
          
          // Log completion status
          if (rconConnected) {
            log.info('RCON startup sequence completed - connected');
          } else {
            log.warn('RCON startup sequence completed - NOT connected (auto-reconnect will keep trying every 30s)');
          }
          
          // Clear the flag when done - now auto-reconnect can take over
          if (rconService.setServerStarting) {
            rconService.setServerStarting(false);
          } else {
            rconService.serverStarting = false;
          }
        } else if (attempts >= maxAttempts) {
          pollCleared = true;
          clearInterval(pollInterval);
          if (rconService.setServerStarting) {
            rconService.setServerStarting(false);
          } else {
            rconService.serverStarting = false;
          }
          log.warn('Server start polling timed out');
        }
      } catch (err) {
        // Clear interval on error to prevent memory leak
        pollCleared = true;
        clearInterval(pollInterval);
        if (rconService.setServerStarting) {
          rconService.setServerStarting(false);
        } else {
          rconService.serverStarting = false;
        }
        log.error(`Server status poll failed: ${err.message}`);
      }
    }, 1000);
    
    // Send immediate response
    res.json(result);
  } catch (error) {
    log.error(`Failed to start server: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Stop server (graceful via RCON)
router.post('/stop', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    
    // Check if RCON is connected first
    if (!rconService.connected) {
      return res.status(400).json({ error: 'RCON not connected. Cannot gracefully stop server.' });
    }
    
    // Save first
    await rconService.save();
    
    // Then quit
    const result = await rconService.quit();
    
    const io = req.app.get('io');
    io.to('server-status').emit('server:status', { running: false });
    
    logServerEvent('server_stop', 'Server stopped via web UI');
    res.json(result);
  } catch (error) {
    log.error(`Failed to stop server: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Force stop server
router.post('/force-stop', async (req, res) => {
  try {
    const serverManager = req.app.get('serverManager');
    const result = await serverManager.stopServer(false);
    
    const io = req.app.get('io');
    io.to('server-status').emit('server:status', { running: false });
    
    res.json(result);
  } catch (error) {
    log.error(`Failed to force stop server: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Restart server
router.post('/restart', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const warningMinutes = typeof req.body.warningMinutes === 'number' ? req.body.warningMinutes : 5;
    
    // Run restart in background with specified warning time
    scheduler.performRestart(warningMinutes).catch(err => {
      log.error(`Restart failed: ${err.message}`);
    });
    
    res.json({ success: true, message: warningMinutes > 0 ? `Restart initiated with ${warningMinutes} minute warning` : 'Immediate restart initiated' });
  } catch (error) {
    log.error(`Failed to restart server: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Save world
router.post('/save', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const result = await rconService.save();
    res.json(result);
  } catch (error) {
    log.error(`Failed to save world: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Send server message
router.post('/message', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    
    if (typeof message !== 'string' || message.length > 1000) {
      return res.status(400).json({ error: 'Message must be a string under 1000 characters' });
    }
    
    const result = await rconService.serverMessage(message);
    res.json(result);
  } catch (error) {
    log.error(`Failed to send message: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Weather controls
router.post('/weather/start-rain', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { intensity } = req.body;
    const result = await rconService.startRain(intensity);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/weather/stop-rain', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const result = await rconService.stopRain();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/weather/start-storm', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { duration } = req.body;
    const result = await rconService.startStorm(duration);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/weather/stop', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const result = await rconService.stopWeather();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Events
router.post('/events/chopper', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const result = await rconService.triggerChopper();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/events/gunshot', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const result = await rconService.triggerGunshot();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/events/lightning', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username } = req.body;
    const result = await rconService.triggerLightning(username);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/events/thunder', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username } = req.body;
    const result = await rconService.triggerThunder(username);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/events/horde', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { count, username } = req.body;
    const result = await rconService.createHorde(count || 50, username);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fallback branches if dynamic fetch fails
// These are the known valid Steam branches for PZ Dedicated Server (App ID 380870)
const FALLBACK_BRANCHES = [
  { name: 'public', description: 'Default stable branch (Build 41)' },
  { name: 'unstable', description: 'Build 42 (including multiplayer)' },
  { name: 'iwbums', description: 'I Will Backup My Save (testing)' },
  { name: 'legacy41', description: 'Legacy Build 41' }
];

// Get available Steam branches for PZ Dedicated Server (App ID 380870)
router.get('/branches', async (req, res) => {
  try {
    const steamcmdPath = req.query.steamcmdPath || await getSetting('steamcmdPath');
    
    if (!steamcmdPath) {
      // Return fallback branches if no SteamCMD configured
      return res.json({ 
        branches: FALLBACK_BRANCHES,
        source: 'fallback',
        message: 'SteamCMD path not configured, using fallback branches'
      });
    }
    
    const steamcmdExe = path.join(steamcmdPath, 'steamcmd.exe');
    if (!fs.existsSync(steamcmdExe)) {
      return res.json({ 
        branches: FALLBACK_BRANCHES,
        source: 'fallback',
        message: 'SteamCMD not found, using fallback branches'
      });
    }
    
    // Run SteamCMD to get app info
    const steamcmdArgs = [
      '+login', 'anonymous',
      '+app_info_update', '1',
      '+app_info_print', '380870',
      '+quit'
    ];
    
    const result = await new Promise((resolve, reject) => {
      const steamcmd = spawn(steamcmdExe, steamcmdArgs, {
        cwd: steamcmdPath,
        timeout: 60000
      });
      
      let stdout = '';
      let stderr = '';
      let completed = false;
      
      // Timeout after 30 seconds
      const timeoutId = setTimeout(() => {
        if (!completed) {
          completed = true;
          steamcmd.kill();
          reject(new Error('SteamCMD timed out'));
        }
      }, 30000);
      
      steamcmd.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      steamcmd.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      steamcmd.on('close', (code) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);
          resolve({ code, stdout, stderr });
        }
      });
      
      steamcmd.on('error', (err) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
    });
    
    // Parse the output to find branches
    const branches = parseSteamBranches(result.stdout);
    
    if (branches.length === 0) {
      return res.json({ 
        branches: FALLBACK_BRANCHES,
        source: 'fallback',
        message: 'Could not parse branches from SteamCMD output'
      });
    }
    
    res.json({ 
      branches,
      source: 'steam',
      message: 'Branches fetched from Steam'
    });
    
  } catch (error) {
    log.warn(`Failed to fetch Steam branches: ${error.message}`);
    res.json({ 
      branches: FALLBACK_BRANCHES,
      source: 'fallback',
      message: `Error: ${error.message}`
    });
  }
});

// Parse Steam app_info output to extract branches
function parseSteamBranches(output) {
  const branches = [];
  
  try {
    // Look for the "branches" section in VDF format
    // Format is like:
    // "branches"
    // {
    //   "public"
    //   {
    //     "buildid" "12345"
    //     "timeupdated" "1234567890"
    //   }
    //   "unstable"
    //   {
    //     "buildid" "12346"
    //     "description" "Build 42"
    //     ...
    //   }
    // }
    
    const branchesMatch = output.match(/"branches"\s*\{([^]*?)\n\t\t\}/);
    if (!branchesMatch) {
      // Try alternative pattern
      const altMatch = output.match(/"branches"\s*\{([^]*?)\}\s*"installedrepots"/i);
      if (!altMatch) {
        return branches;
      }
    }
    
    const branchesSection = branchesMatch ? branchesMatch[1] : '';
    
    // Extract individual branch names and their properties
    // Match pattern: "branchname" followed by { ... }
    const branchRegex = /^\s*"([^"]+)"\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/gm;
    let match;
    
    while ((match = branchRegex.exec(branchesSection)) !== null) {
      const branchName = match[1];
      const branchContent = match[2];
      
      // Skip password-protected branches
      if (branchContent.includes('"pwdrequired"') && branchContent.includes('"1"')) {
        continue;
      }
      
      // Extract description if available
      const descMatch = branchContent.match(/"description"\s+"([^"]+)"/);
      const description = descMatch ? descMatch[1] : (branchName === 'public' ? 'Default stable branch' : '');
      
      // Extract buildid for reference
      const buildMatch = branchContent.match(/"buildid"\s+"(\d+)"/);
      const buildId = buildMatch ? buildMatch[1] : null;
      
      // Extract time updated
      const timeMatch = branchContent.match(/"timeupdated"\s+"(\d+)"/);
      const timeUpdated = timeMatch ? new Date(parseInt(timeMatch[1]) * 1000).toISOString() : null;
      
      branches.push({
        name: branchName,
        description: description || branchName,
        buildId,
        timeUpdated
      });
    }
    
    // Sort: public first, then alphabetically
    branches.sort((a, b) => {
      if (a.name === 'public') return -1;
      if (b.name === 'public') return 1;
      return a.name.localeCompare(b.name);
    });
    
  } catch (err) {
    log.warn(`Failed to parse Steam branches: ${err.message}`);
  }
  
  return branches;
}

// Helper to build Steam beta arguments as array
function getBetaArgs(branch) {
  if (!branch || branch === 'stable' || branch === 'public') return [];
  // Backwards compatibility: treat boolean true as 'unstable'
  if (branch === true) return ['-beta', 'unstable'];
  // Allow any branch name - Steam will validate it
  return ['-beta', branch];
}

// SteamCMD Installation endpoint
router.post('/install', async (req, res) => {
  try {
    const { 
      steamcmdPath, 
      installPath, 
      serverName, 
      branch,
      useUnstable, // Legacy support
      // New options
      zomboidDataPath,
      minMemory = 4,
      maxMemory = 8,
      adminPassword,
      serverPort = 16261,
      useUpnp = true,
      useNoSteam = false,
      useDebug = false,
      // RCON settings
      rconPassword,
      rconPort = 27015
    } = req.body;
    
    // Determine branch - support both new 'branch' param and legacy 'useUnstable'
    const selectedBranch = branch || (useUnstable ? 'unstable' : 'stable');
    
    // Validate paths - Security check for path traversal
    if (!steamcmdPath || !installPath || !serverName) {
      return res.status(400).json({ error: 'Missing required fields: steamcmdPath, installPath, serverName' });
    }
    
    if (!isValidPath(steamcmdPath)) {
      return res.status(400).json({ error: 'Invalid SteamCMD path' });
    }
    
    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: 'Invalid install path' });
    }
    
    if (!isValidServerName(serverName)) {
      return res.status(400).json({ error: 'Invalid server name. Use only letters, numbers, underscores, and hyphens (max 64 chars)' });
    }
    
    if (zomboidDataPath && !isValidPath(zomboidDataPath)) {
      return res.status(400).json({ error: 'Invalid Zomboid data path' });
    }
    
    // Validate numeric inputs
    const safeMinMemory = validateInt(minMemory, 1, 64, 4);
    const safeMaxMemory = validateInt(maxMemory, 1, 128, 8);
    const safeServerPort = validateInt(serverPort, 1024, 65535, 16261);
    const safeRconPort = validateInt(rconPort, 1024, 65535, 27015);
    
    // Sanitize string inputs for batch file
    const safeAdminPassword = sanitizeForBatch(adminPassword);
    
    // Check if steamcmd.exe exists
    const steamcmdExe = path.join(steamcmdPath, 'steamcmd.exe');
    if (!fs.existsSync(steamcmdExe)) {
      return res.status(400).json({ error: `SteamCMD not found at: ${steamcmdExe}` });
    }
    
    // Prevent concurrent operations on the same install path
    const normalizedPath = path.normalize(installPath).toLowerCase();
    if (activeSteamOperations.has(normalizedPath)) {
      return res.status(409).json({ 
        error: 'A Steam operation is already in progress for this path. Please wait for it to complete.' 
      });
    }
    
    // Create install directory if it doesn't exist
    if (!fs.existsSync(installPath)) {
      fs.mkdirSync(installPath, { recursive: true });
    }
    
    // Create custom zomboid data path if specified
    if (zomboidDataPath && !fs.existsSync(zomboidDataPath)) {
      fs.mkdirSync(zomboidDataPath, { recursive: true });
    }
    
    log.info(`Starting PZ server installation to ${installPath} (branch: ${selectedBranch})`);
    
    // Mark operation as active
    activeSteamOperations.set(normalizedPath, { 
      type: 'install', 
      startTime: Date.now(),
      branch: selectedBranch,
      serverName 
    });
    
    // Build SteamCMD command
    // App ID 380870 is Project Zomboid Dedicated Server
    const betaArgs = getBetaArgs(selectedBranch);
    const steamcmdArgs = [
      '+force_install_dir', installPath,
      '+login', 'anonymous',
      '+app_update', '380870', ...betaArgs, 'validate',
      '+quit'
    ];
    
    const io = req.app.get('io');
    
    // Spawn SteamCMD process
    const steamcmd = spawn(steamcmdExe, steamcmdArgs, {
      cwd: steamcmdPath
    });
    
    let output = '';
    let stdoutBuffer = '';
    let stderrBuffer = '';
    
    steamcmd.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      stdoutBuffer += text;
      
      // Split by newlines and emit each line for real-time streaming
      const lines = stdoutBuffer.split(/\r?\n/);
      // Keep the last incomplete line in the buffer
      stdoutBuffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.trim()) {
          io.emit('install:log', { type: 'stdout', text: line });
          log.info(`SteamCMD: ${line}`);
        }
      }
    });
    
    steamcmd.stderr.on('data', (data) => {
      const text = data.toString();
      output += text;
      stderrBuffer += text;
      
      // Split by newlines and emit each line for real-time streaming
      const lines = stderrBuffer.split(/\r?\n/);
      // Keep the last incomplete line in the buffer
      stderrBuffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.trim()) {
          io.emit('install:log', { type: 'stderr', text: line });
          log.warn(`SteamCMD stderr: ${line}`);
        }
      }
    });
    
    steamcmd.on('close', async (code) => {
      // Flush any remaining buffered output
      if (stdoutBuffer.trim()) {
        io.emit('install:log', { type: 'stdout', text: stdoutBuffer.trim() });
        log.info(`SteamCMD: ${stdoutBuffer.trim()}`);
      }
      if (stderrBuffer.trim()) {
        io.emit('install:log', { type: 'stderr', text: stderrBuffer.trim() });
        log.warn(`SteamCMD stderr: ${stderrBuffer.trim()}`);
      }
      
      if (code === 0) {
        log.info('PZ server installation completed successfully');
        
        // Auto-update settings with new paths
        await setSetting('serverPath', installPath);
        await setSetting('serverName', serverName);
        await setSetting('minMemory', minMemory);
        await setSetting('maxMemory', maxMemory);
        await setSetting('serverPort', serverPort);
        await setSetting('useUpnp', useUpnp);
        
        // Determine config path
        let zomboidPath;
        let serverConfigPath;
        
        if (zomboidDataPath) {
          // Use custom data path - zomboidDataPath IS the data folder (contains Server/, Saves/, etc.)
          zomboidPath = zomboidDataPath;
          serverConfigPath = path.join(zomboidDataPath, 'Server');
          await setSetting('zomboidDataPath', zomboidDataPath);
        } else {
          // Create server-specific data folder alongside install path for isolation
          // e.g., E:\PZ\Server_Data\MyServer\ -> E:\PZ\Server_Data\MyServer_Data\
          zomboidPath = `${installPath}_Data`;
          serverConfigPath = path.join(zomboidPath, 'Server');
          await setSetting('zomboidDataPath', zomboidPath);
          io.emit('install:log', { type: 'stdout', text: `Using isolated data folder: ${zomboidPath}` });
        }
        
        await setSetting('serverConfigPath', serverConfigPath);
        
        // Save RCON settings for later use
        if (rconPassword) {
          await setSetting('rconPassword', rconPassword);
          await setSetting('rconPort', rconPort);
          await setSetting('rconHost', '127.0.0.1');
          io.emit('install:log', { type: 'stdout', text: `RCON settings saved (port: ${rconPort})` });
        }
        
        // Generate custom startup batch file
        try {
          const batchContent = generateStartupBatch({
            installPath,
            serverName,
            minMemory: safeMinMemory,
            maxMemory: safeMaxMemory,
            zomboidDataPath: zomboidPath,  // Use the resolved path (either custom or auto-generated)
            adminPassword: safeAdminPassword,
            serverPort: safeServerPort,
            useNoSteam,
            useDebug
          });
          
          const batchPath = path.join(installPath, `StartServer_${serverName}.bat`);
          fs.writeFileSync(batchPath, batchContent, 'utf8');
          log.info(`Created custom startup batch: ${batchPath}`);
          io.emit('install:log', { type: 'stdout', text: `Created custom startup script: StartServer_${serverName}.bat` });
        } catch (batchError) {
          log.warn(`Failed to create startup batch: ${batchError.message}`);
        }
        
        logServerEvent('server_install', `Installed PZ server to ${installPath} (${selectedBranch} branch)`);
        
        // Auto-install PanelBridge mod to the server
        try {
          const possibleModPaths = [
            path.join(process.cwd(), 'pz-mod', 'PanelBridge'),
            path.join(path.dirname(process.execPath), 'pz-mod', 'PanelBridge'),
          ];
          
          let modSourcePath = null;
          for (const p of possibleModPaths) {
            if (fs.existsSync(p)) {
              modSourcePath = p;
              break;
            }
          }
          
          if (modSourcePath) {
            const sourceLuaFile = path.join(modSourcePath, 'media', 'lua', 'server', 'PanelBridge.lua');
            const destLuaDir = path.join(installPath, 'media', 'lua', 'server');
            const destLuaFile = path.join(destLuaDir, 'PanelBridge.lua');
            
            if (fs.existsSync(sourceLuaFile)) {
              if (!fs.existsSync(destLuaDir)) {
                fs.mkdirSync(destLuaDir, { recursive: true });
              }
              fs.copyFileSync(sourceLuaFile, destLuaFile);
              io.emit('install:log', { type: 'stdout', text: 'PanelBridge mod installed automatically' });
              log.info('PanelBridge mod auto-installed to server');
            }
          }
        } catch (modError) {
          log.warn(`Failed to auto-install PanelBridge mod: ${modError.message}`);
        }
        
        io.emit('install:complete', { 
          success: true, 
          message: 'Server installed successfully',
          installPath,
          serverName,
          zomboidDataPath: zomboidPath,  // Send back the computed data path
          serverConfigPath,
          branch: selectedBranch,
          rconPort: safeRconPort,
          rconPassword,
          serverPort: safeServerPort,
          minMemory: safeMinMemory,
          maxMemory: safeMaxMemory
        });
      } else {
        log.error(`SteamCMD exited with code ${code}`);
        io.emit('install:complete', { 
          success: false, 
          message: `Installation failed with exit code ${code}`,
          output 
        });
      }
      
      // Clear active operation
      activeSteamOperations.delete(normalizedPath);
    });
    
    steamcmd.on('error', (error) => {
      // Clear active operation on error
      activeSteamOperations.delete(normalizedPath);
      
      log.error(`SteamCMD error: ${error.message}`);
      io.emit('install:complete', { 
        success: false, 
        message: `Failed to run SteamCMD: ${error.message}` 
      });
    });
    
    // Return immediately - progress is sent via Socket.IO
    res.json({ 
      success: true, 
      message: 'Installation started. Check the log for progress.',
      installPath,
      branch: selectedBranch
    });
    
  } catch (error) {
    log.error(`Installation error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Quick Setup - Create new server config using existing files (no SteamCMD download)
router.post('/quick-setup', async (req, res) => {
  try {
    const { 
      installPath, 
      serverName, 
      zomboidDataPath,
      minMemory = 4,
      maxMemory = 8,
      adminPassword,
      serverPort = 16261,
      useUpnp = true,
      useNoSteam = false,
      useDebug = false,
      rconPassword,
      rconPort = 27015
    } = req.body;
    
    // Validate inputs
    if (!installPath || !serverName) {
      return res.status(400).json({ error: 'Missing required fields: installPath, serverName' });
    }
    
    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: 'Invalid install path' });
    }
    
    if (!isValidServerName(serverName)) {
      return res.status(400).json({ error: 'Invalid server name. Use only letters, numbers, underscores, and hyphens (max 64 chars)' });
    }
    
    if (zomboidDataPath && !isValidPath(zomboidDataPath)) {
      return res.status(400).json({ error: 'Invalid Zomboid data path' });
    }
    
    // Check if server files exist
    const startServerBat = path.join(installPath, 'StartServer64.bat');
    const javaFolder = path.join(installPath, 'jre64');
    
    if (!fs.existsSync(startServerBat) && !fs.existsSync(javaFolder)) {
      return res.status(400).json({ 
        error: 'Server files not found. Make sure the path contains Project Zomboid dedicated server files.' 
      });
    }
    
    // Validate numeric inputs
    const safeMinMemory = validateInt(minMemory, 1, 64, 4);
    const safeMaxMemory = validateInt(maxMemory, 1, 128, 8);
    const safeServerPort = validateInt(serverPort, 1024, 65535, 16261);
    const safeRconPort = validateInt(rconPort, 1024, 65535, 27015);
    const safeAdminPassword = sanitizeForBatch(adminPassword);
    
    log.info(`Quick setup: Creating server config for ${serverName} using files from ${installPath}`);
    
    // Create custom zomboid data path if specified
    if (zomboidDataPath && !fs.existsSync(zomboidDataPath)) {
      fs.mkdirSync(zomboidDataPath, { recursive: true });
    }
    
    // Update settings
    await setSetting('serverPath', installPath);
    await setSetting('serverName', serverName);
    await setSetting('minMemory', safeMinMemory);
    await setSetting('maxMemory', safeMaxMemory);
    await setSetting('serverPort', safeServerPort);
    await setSetting('useUpnp', useUpnp);
    
    // Determine config path
    let zomboidPath;
    let serverConfigPath;
    
    if (zomboidDataPath) {
      // zomboidDataPath IS the data folder (contains Server/, Saves/, etc.)
      zomboidPath = zomboidDataPath;
      serverConfigPath = path.join(zomboidDataPath, 'Server');
      await setSetting('zomboidDataPath', zomboidDataPath);
    } else {
      // Create server-specific data folder alongside install path for isolation
      // e.g., E:\PZ\Server_Data\MyServer\ -> E:\PZ\Server_Data\MyServer_Data\
      zomboidPath = `${installPath}_Data`;
      serverConfigPath = path.join(zomboidPath, 'Server');
      await setSetting('zomboidDataPath', zomboidPath);
      log.info(`Using isolated data folder: ${zomboidPath}`);
    }
    
    await setSetting('serverConfigPath', serverConfigPath);
    
    // Save RCON settings
    if (rconPassword) {
      await setSetting('rconPassword', rconPassword);
      await setSetting('rconPort', safeRconPort);
      await setSetting('rconHost', '127.0.0.1');
    }
    
    // Generate custom startup batch file
    const batchContent = generateStartupBatch({
      installPath,
      serverName,
      minMemory: safeMinMemory,
      maxMemory: safeMaxMemory,
      zomboidDataPath: zomboidPath,  // Use the resolved path (either custom or auto-generated)
      adminPassword: safeAdminPassword,
      serverPort: safeServerPort,
      useNoSteam,
      useDebug
    });
    
    const batchPath = path.join(installPath, `StartServer_${serverName}.bat`);
    fs.writeFileSync(batchPath, batchContent, 'utf8');
    log.info(`Created custom startup batch: ${batchPath}`);
    
    // Auto-install PanelBridge mod to the server
    let panelBridgeInstalled = false;
    try {
      const possibleModPaths = [
        path.join(process.cwd(), 'pz-mod', 'PanelBridge'),
        path.join(path.dirname(process.execPath), 'pz-mod', 'PanelBridge'),
      ];
      
      let modSourcePath = null;
      for (const p of possibleModPaths) {
        if (fs.existsSync(p)) {
          modSourcePath = p;
          break;
        }
      }
      
      if (modSourcePath) {
        const sourceLuaFile = path.join(modSourcePath, 'media', 'lua', 'server', 'PanelBridge.lua');
        const destLuaDir = path.join(installPath, 'media', 'lua', 'server');
        const destLuaFile = path.join(destLuaDir, 'PanelBridge.lua');
        
        if (fs.existsSync(sourceLuaFile)) {
          if (!fs.existsSync(destLuaDir)) {
            fs.mkdirSync(destLuaDir, { recursive: true });
          }
          fs.copyFileSync(sourceLuaFile, destLuaFile);
          panelBridgeInstalled = true;
          log.info('PanelBridge mod auto-installed to server');
        }
      }
    } catch (modError) {
      log.warn(`Failed to auto-install PanelBridge mod: ${modError.message}`);
    }
    
    logServerEvent('server_quick_setup', `Created server config for ${serverName} using existing files at ${installPath}`);
    
    res.json({ 
      success: true, 
      message: 'Server configuration created successfully',
      installPath,
      serverName,
      zomboidDataPath: zomboidPath,  // Send back the computed data path
      serverConfigPath,
      batchFile: `StartServer_${serverName}.bat`,
      rconPort: safeRconPort,
      rconPassword,
      serverPort: safeServerPort,
      minMemory: safeMinMemory,
      maxMemory: safeMaxMemory,
      panelBridgeInstalled
    });
    
  } catch (error) {
    log.error(`Quick setup error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Configure RCON in server's .ini file
router.post('/configure-rcon', async (req, res) => {
  try {
    const { rconPassword, rconPort = 27015 } = req.body;
    
    if (!rconPassword) {
      return res.status(400).json({ error: 'RCON password is required' });
    }
    
    // Get the server config path from active server or settings
    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    
    if (!serverConfigPath) {
      return res.status(400).json({ error: 'Server config path not set. Please run installation first.' });
    }
    
    const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
    
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({ 
        error: `Server config not found at ${iniPath}. Start the server once first to generate the config file.` 
      });
    }
    
    // Read and update the ini file
    let content = fs.readFileSync(iniPath, 'utf-8');
    
    // Update RCONPassword
    if (content.includes('RCONPassword=')) {
      content = content.replace(/RCONPassword=.*/g, () => `RCONPassword=${rconPassword}`);
    } else {
      content += `\nRCONPassword=${rconPassword}`;
    }
    
    // Update RCONPort
    if (content.includes('RCONPort=')) {
      content = content.replace(/RCONPort=.*/g, () => `RCONPort=${rconPort}`);
    } else {
      content += `\nRCONPort=${rconPort}`;
    }
    
    fs.writeFileSync(iniPath, content, 'utf-8');
    
    // Also save to app settings
    await setSetting('rconPassword', rconPassword);
    await setSetting('rconPort', rconPort);
    await setSetting('rconHost', '127.0.0.1');
    
    log.info(`RCON configured in ${iniPath}`);
    res.json({ 
      success: true, 
      message: `RCON configured successfully. Restart the server for changes to take effect.`,
      iniPath 
    });
  } catch (error) {
    log.error(`Failed to configure RCON: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Configure server network settings (port, UPnP) in .ini file
router.post('/configure-network', async (req, res) => {
  try {
    const { serverPort = 16261, useUpnp = true } = req.body;
    
    // Get the server config path from active server or settings
    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    
    if (!serverConfigPath) {
      return res.status(400).json({ error: 'Server config path not set. Please run installation first.' });
    }
    
    const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
    
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({ 
        error: `Server config not found at ${iniPath}. Start the server once first to generate the config file.` 
      });
    }
    
    // Read and update the ini file
    let content = fs.readFileSync(iniPath, 'utf-8');
    
    // Update DefaultPort
    if (content.includes('DefaultPort=')) {
      content = content.replace(/DefaultPort=.*/g, `DefaultPort=${serverPort}`);
    } else {
      content += `\nDefaultPort=${serverPort}`;
    }
    
    // Update UDPPort (DefaultPort + 1)
    if (content.includes('UDPPort=')) {
      content = content.replace(/UDPPort=.*/g, `UDPPort=${serverPort + 1}`);
    } else {
      content += `\nUDPPort=${serverPort + 1}`;
    }
    
    // Update UPnP
    const upnpValue = useUpnp ? 'true' : 'false';
    if (content.includes('UPnP=')) {
      content = content.replace(/UPnP=.*/g, `UPnP=${upnpValue}`);
    } else {
      content += `\nUPnP=${upnpValue}`;
    }
    
    fs.writeFileSync(iniPath, content, 'utf-8');
    
    // Also save to app settings
    await setSetting('serverPort', serverPort);
    await setSetting('useUpnp', useUpnp);
    
    log.info(`Network settings configured in ${iniPath}: port=${serverPort}, UPnP=${upnpValue}`);
    res.json({ 
      success: true, 
      message: `Network settings configured successfully. Restart the server for changes to take effect.`,
      iniPath,
      settings: {
        defaultPort: serverPort,
        udpPort: serverPort + 1,
        upnp: useUpnp
      }
    });
  } catch (error) {
    log.error(`Failed to configure network settings: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Alarm - sound building alarm
router.post('/alarm', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const result = await rconService.alarm();
    logServerEvent('alarm');
    res.json(result);
  } catch (error) {
    log.error(`Failed to trigger alarm: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Remove zombies
router.post('/removezombies', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const result = await rconService.removeZombies();
    logServerEvent('removezombies');
    res.json(result);
  } catch (error) {
    log.error(`Failed to remove zombies: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Reload Lua script
router.post('/reloadlua', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { filename } = req.body;
    
    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }
    
    // Validate filename - allow alphanumeric, underscores, dots, and slashes
    if (!/^[a-zA-Z0-9_./\\-]+\.lua$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename format' });
    }
    
    const result = await rconService.reloadLua(filename);
    logServerEvent('reloadlua', filename);
    res.json(result);
  } catch (error) {
    log.error(`Failed to reload Lua: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Set log level
router.post('/log', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { type, level } = req.body;
    
    if (!type || !level) {
      return res.status(400).json({ error: 'Type and level are required' });
    }
    
    const validTypes = [
      'General', 'Network', 'Multiplayer', 'Voice', 'Packet', 'NetworkFileDebug',
      'Lua', 'Mod', 'Sound', 'Zombie', 'Combat', 'Objects', 'Fireplace', 'Radio',
      'MapLoading', 'Clothing', 'Animation', 'Asset', 'Script', 'Shader', 'Input',
      'Recipe', 'ActionSystem', 'IsoRegion', 'UniTests', 'FileIO', 'Ownership',
      'Death', 'Damage', 'Statistic', 'Vehicle', 'Checksum'
    ];
    
    const validLevels = ['Trace', 'Debug', 'General', 'Warning', 'Error'];
    
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Invalid log type. Valid: ${validTypes.join(', ')}` });
    }
    
    if (!validLevels.includes(level)) {
      return res.status(400).json({ error: `Invalid log level. Valid: ${validLevels.join(', ')}` });
    }
    
    const result = await rconService.setLogLevel(type, level);
    res.json(result);
  } catch (error) {
    log.error(`Failed to set log level: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Server statistics
router.post('/stats', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { mode, period } = req.body;
    
    if (!mode) {
      return res.status(400).json({ error: 'Mode is required' });
    }
    
    const validModes = ['none', 'file', 'console', 'all'];
    if (!validModes.includes(mode.toLowerCase())) {
      return res.status(400).json({ error: `Invalid mode. Valid: ${validModes.join(', ')}` });
    }
    
    const validPeriod = period ? validateInt(period, 1, 3600, null) : null;
    
    const result = await rconService.setStats(mode, validPeriod);
    res.json(result);
  } catch (error) {
    log.error(`Failed to set stats: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Release safehouse
router.post('/releasesafehouse', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const result = await rconService.releaseSafehouse();
    res.json(result);
  } catch (error) {
    log.error(`Failed to release safehouse: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Update server using SteamCMD
router.post('/steam-update', async (req, res) => {
  try {
    let { steamcmdPath, installPath, branch, useUnstable = false, validateFiles = false } = req.body;
    
    // Determine branch - support both new 'branch' param and legacy 'useUnstable'
    const selectedBranch = branch || (useUnstable ? 'unstable' : 'stable');
    
    // Auto-load steamcmdPath from settings if not provided
    if (!steamcmdPath) {
      steamcmdPath = await getSetting('steamcmdPath');
    }
    
    if (!steamcmdPath || !installPath) {
      return res.status(400).json({ error: 'Missing required fields: steamcmdPath, installPath' });
    }
    
    if (!isValidPath(steamcmdPath)) {
      return res.status(400).json({ error: 'Invalid SteamCMD path' });
    }
    
    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: 'Invalid install path' });
    }
    
    // Check if server is running - cannot update while running
    const serverManager = req.app.get('serverManager');
    try {
      const isRunning = await serverManager.checkServerRunning();
      if (isRunning) {
        return res.status(400).json({ 
          error: 'Server is currently running. Please stop the server before updating.' 
        });
      }
    } catch (e) {
      log.warn(`Could not verify server status before update: ${e.message}`);
      // Continue anyway - user may be updating a different server
    }
    
    // Prevent concurrent operations on the same install path
    const normalizedPath = path.normalize(installPath).toLowerCase();
    if (activeSteamOperations.has(normalizedPath)) {
      return res.status(409).json({ 
        error: 'A Steam operation is already in progress for this server. Please wait for it to complete.' 
      });
    }
    
    const steamcmdExe = path.join(steamcmdPath, 'steamcmd.exe');
    if (!fs.existsSync(steamcmdExe)) {
      return res.status(400).json({ error: `SteamCMD not found at: ${steamcmdExe}` });
    }
    
    const operation = validateFiles ? 'verification' : 'update';
    log.info(`Starting PZ server ${operation} (branch: ${selectedBranch})...`);
    
    // Mark operation as active
    activeSteamOperations.set(normalizedPath, { 
      type: operation, 
      startTime: Date.now(),
      branch: selectedBranch 
    });
    
    // Build SteamCMD command
    const betaArgs = getBetaArgs(selectedBranch);
    const steamcmdArgs = [
      '+force_install_dir', installPath,
      '+login', 'anonymous',
      '+app_update', '380870', ...betaArgs, 'validate',
      '+quit'
    ];
    
    const io = req.app.get('io');
    
    // Emit start event
    io.emit('steam:start', { 
      type: validateFiles ? 'verify' : 'update',
      message: validateFiles ? 'Verifying game files...' : 'Updating server...'
    });
    
    const steamcmd = spawn(steamcmdExe, steamcmdArgs, {
      cwd: steamcmdPath
    });
    
    let output = '';
    let stdoutBuffer = '';
    let stderrBuffer = '';
    
    steamcmd.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      stdoutBuffer += text;
      
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.trim()) {
          io.emit('steam:log', { type: 'stdout', text: line });
          log.info(`SteamCMD: ${line}`);
        }
      }
    });
    
    steamcmd.stderr.on('data', (data) => {
      const text = data.toString();
      output += text;
      stderrBuffer += text;
      
      // Buffer stderr lines like stdout for consistent output
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.trim()) {
          io.emit('steam:log', { type: 'stderr', text: line });
          log.warn(`SteamCMD stderr: ${line}`);
        }
      }
    });
    
    steamcmd.on('close', (code) => {
      // Flush remaining buffers
      if (stdoutBuffer.trim()) {
        io.emit('steam:log', { type: 'stdout', text: stdoutBuffer.trim() });
      }
      if (stderrBuffer.trim()) {
        io.emit('steam:log', { type: 'stderr', text: stderrBuffer.trim() });
      }
      
      // Clear active operation
      activeSteamOperations.delete(normalizedPath);
      
      const success = code === 0;
      
      io.emit('steam:complete', { 
        success,
        message: success 
          ? `Server ${operation} completed successfully` 
          : `Server ${operation} failed with code ${code}`
      });
      
      logServerEvent(success ? 'server_update' : 'server_update_failed', 
        `Server ${operation} ${success ? 'completed' : 'failed'}`);
      
      log.info(`SteamCMD ${operation} finished with code ${code}`);
    });
    
    steamcmd.on('error', (error) => {
      // Clear active operation on error
      activeSteamOperations.delete(normalizedPath);
      
      io.emit('steam:complete', { 
        success: false, 
        message: `Failed to run SteamCMD: ${error.message}` 
      });
      log.error(`SteamCMD error: ${error.message}`);
    });
    
    res.json({ 
      success: true, 
      message: `Server ${operation} started` 
    });
    
  } catch (error) {
    log.error(`Steam update failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Auto-download and install SteamCMD
router.post('/steamcmd/download', async (req, res) => {
  try {
    const { installPath = 'C:\\SteamCMD' } = req.body;
    
    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: 'Invalid installation path' });
    }
    
    const io = req.app.get('io');
    const https = await import('https');
    const unzipper = await import('unzipper');
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(installPath)) {
      fs.mkdirSync(installPath, { recursive: true });
    }
    
    const steamcmdUrl = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';
    const zipPath = path.join(installPath, 'steamcmd.zip');
    
    io.emit('steamcmd:status', { status: 'downloading', message: 'Downloading SteamCMD...' });
    log.info(`Downloading SteamCMD to ${installPath}`);
    
    // Download the zip file
    const file = fs.createWriteStream(zipPath);
    
    const handleDownloadError = (err) => {
      file.close();
      fs.unlink(zipPath, () => {});
      io.emit('steamcmd:status', { status: 'error', message: `Download failed: ${err.message}` });
      log.error(`SteamCMD download failed: ${err.message}`);
    };
    
    https.default.get(steamcmdUrl, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        https.default.get(response.headers.location, (redirectResponse) => {
          if (redirectResponse.statusCode !== 200) {
            handleDownloadError(new Error(`HTTP ${redirectResponse.statusCode}`));
            return;
          }
          redirectResponse.pipe(file);
          
          file.on('close', async () => {
            await extractAndSetup();
          });
        }).on('error', handleDownloadError);
        return;
      }
      
      if (response.statusCode !== 200) {
        handleDownloadError(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      
      file.on('close', async () => {
        await extractAndSetup();
      });
    }).on('error', handleDownloadError);
    
    async function extractAndSetup() {
      try {
        io.emit('steamcmd:status', { status: 'extracting', message: 'Extracting SteamCMD...' });
        log.info('Extracting SteamCMD...');
        
        // Extract the zip file
        await fs.createReadStream(zipPath)
          .pipe(unzipper.default.Extract({ path: installPath }))
          .promise();
        
        // Clean up zip file
        fs.unlinkSync(zipPath);
        
        io.emit('steamcmd:status', { status: 'initializing', message: 'Initializing SteamCMD (first run)...' });
        log.info('Running SteamCMD first-time setup...');
        
        // Run steamcmd once to let it update itself
        const steamcmdExe = path.join(installPath, 'steamcmd.exe');
        const steamcmd = spawn(steamcmdExe, ['+quit'], {
          cwd: installPath
        });
        
        steamcmd.stdout.on('data', (data) => {
          io.emit('steamcmd:log', { type: 'stdout', text: data.toString() });
        });
        
        steamcmd.stderr.on('data', (data) => {
          io.emit('steamcmd:log', { type: 'stderr', text: data.toString() });
        });
        
        steamcmd.on('close', (code) => {
          if (code === 0 || code === 7) { // Code 7 is also success for steamcmd
            io.emit('steamcmd:status', { 
              status: 'complete', 
              message: 'SteamCMD installed successfully!',
              path: installPath 
            });
            log.info(`SteamCMD installed successfully to ${installPath}`);
          } else {
            io.emit('steamcmd:status', { 
              status: 'error', 
              message: `SteamCMD setup failed with code ${code}` 
            });
            log.error(`SteamCMD first-run failed with code ${code}`);
          }
        });
        
        steamcmd.on('error', (error) => {
          io.emit('steamcmd:status', { 
            status: 'error', 
            message: `Failed to run SteamCMD: ${error.message}` 
          });
          log.error(`SteamCMD run error: ${error.message}`);
        });
        
      } catch (extractError) {
        io.emit('steamcmd:status', { 
          status: 'error', 
          message: `Extraction failed: ${extractError.message}` 
        });
        log.error(`SteamCMD extraction failed: ${extractError.message}`);
      }
    }
    
    res.json({ success: true, message: 'SteamCMD download started' });
    
  } catch (error) {
    log.error(`SteamCMD download failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Check if SteamCMD exists at a path
router.get('/steamcmd/check', async (req, res) => {
  try {
    const { path: checkPath } = req.query;
    
    if (!checkPath || !isValidPath(checkPath)) {
      return res.json({ exists: false, message: 'Invalid path' });
    }
    
    const steamcmdExe = path.join(checkPath, 'steamcmd.exe');
    const exists = fs.existsSync(steamcmdExe);
    
    res.json({ 
      exists,
      path: checkPath,
      executable: steamcmdExe,
      message: exists ? 'SteamCMD found' : 'SteamCMD not found at this location'
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete server files (used when removing a server from panel with file deletion)
router.post('/delete-files', async (req, res) => {
  try {
    const { path: deletePath } = req.body;
    
    if (!deletePath || !isValidPath(deletePath)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    
    // Safety check: path must exist and contain PZ server files
    if (!fs.existsSync(deletePath)) {
      return res.status(404).json({ error: 'Path does not exist' });
    }
    
    // Check for known PZ server markers to prevent accidental deletion of wrong folders
    const pzMarkers = ['ProjectZomboid64.json', 'StartServer64.bat', 'java', 'natives'];
    const hasPzFiles = pzMarkers.some(marker => fs.existsSync(path.join(deletePath, marker)));
    
    if (!hasPzFiles) {
      return res.status(400).json({ 
        error: 'This does not appear to be a Project Zomboid server installation. Refusing to delete for safety.' 
      });
    }
    
    log.warn(`Deleting server files at: ${deletePath}`);
    
    // Use recursive delete
    fs.rmSync(deletePath, { recursive: true, force: true });
    
    log.info(`Successfully deleted server files at: ${deletePath}`);
    res.json({ success: true, message: 'Server files deleted' });
    
  } catch (error) {
    log.error(`Failed to delete server files: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Open folder browser dialog (uses PowerShell for native Windows dialog)
router.post('/browse-folder', async (req, res) => {
  try {
    const { initialPath, description = 'Select a folder' } = req.body;
    const safePath = initialPath && isValidPath(initialPath) ? initialPath.replace(/'/g, "''") : '';
    const safeDesc = description.replace(/'/g, "''");
    
    // Use modern Windows Vista+ folder picker via COM (Shell.Application)
    // This shows the modern Explorer-style dialog instead of the old XP dialog
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Microsoft.VisualBasic

# Try to use the modern FolderBrowserDialog with Vista style
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '${safeDesc}'
$dialog.UseDescriptionForTitle = $true
$dialog.RootFolder = [System.Environment+SpecialFolder]::MyComputer
$dialog.ShowNewFolderButton = $true
${safePath ? `if (Test-Path '${safePath}') { $dialog.SelectedPath = '${safePath}' }` : ''}

# Force the modern dialog style
$dialog.GetType().GetProperty('AutoUpgradeEnabled', [System.Reflection.BindingFlags]'Instance,NonPublic,Public').SetValue($dialog, $true, $null) 2>$null

$result = $dialog.ShowDialog()
if ($result -eq 'OK') {
    Write-Output $dialog.SelectedPath
} else {
    Write-Output ''
}
`;
    
    const powershell = spawn('powershell', ['-NoProfile', '-Command', psScript], {
      windowsHide: false
    });
    
    let output = '';
    let errorOutput = '';
    
    powershell.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    powershell.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    powershell.on('close', (code) => {
      const selectedPath = output.trim();
      
      if (code !== 0 || errorOutput) {
        log.warn(`Folder browser had issues: ${errorOutput}`);
      }
      
      res.json({ 
        success: !!selectedPath,
        path: selectedPath || null,
        cancelled: !selectedPath
      });
    });
    
    powershell.on('error', (error) => {
      log.error(`Folder browser error: ${error.message}`);
      res.status(500).json({ error: 'Failed to open folder browser' });
    });
    
  } catch (error) {
    log.error(`Browse folder failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Server Console Log (server-console.txt)
// ============================================

// Filter patterns for console log - patterns to exclude (noise)
const CONSOLE_LOG_EXCLUDE_PATTERNS = [
  // Duplicate sprites/textures (very spammy)
  /IsoSpriteManager\.AddSprite > duplicate texture/,
  // PlayerHitZombie packet spam (not consistent packets)
  /The packet PlayerHitZombie is not consistent/,
  // Missing icons for build items (cosmetic only)
  /XuiSkin\$EntityUiStyle\.Load > Could not find icon:/,
  /XuiSkin\$EntityUiStyle\.LoadComponentInfo> Could not find icon:/,
  // Recursive require warnings (usually harmless)
  /LuaManager\.RunLua > recursive require\(\)/,
  // AnimalPacket/AnimalEventPacket class warnings (known issue)
  /The AnimalPacket class doesn't have PacketSetting attributes/,
  /The AnimalEventPacket class doesn't have PacketSetting attributes/,
];

// Patterns for errors (always show these)
const CONSOLE_LOG_ERROR_PATTERNS = [
  /^ERROR\[/,
  /Exception thrown/,
  /Stack trace:/,
  /java\.lang\.\w+Exception/,
  /KahluaThread\.flushErrorMessage/,
];

// Patterns for important info (always show these)
const CONSOLE_LOG_IMPORTANT_PATTERNS = [
  /^\[PanelBridge\]/,
  /SERVER STARTED/,
  /fully-connected/,
  /player-connect/,
  /connection-lost/,
  /disconnect/,
  /Steam client .* is initiating/,
  /RCON:/,
  /Recipe AutoLearned/,
  /Reduce Head Condition/,
  /ISBuildIsoEntity/,
];

/**
 * Filter console log lines based on filter level
 * @param {string[]} lines - Array of log lines
 * @param {string} filterLevel - 'all' | 'filtered' | 'important' | 'errors'
 * @returns {string[]} Filtered lines
 */
function filterConsoleLogLines(lines, filterLevel = 'filtered') {
  if (filterLevel === 'all') {
    return lines;
  }
  
  return lines.filter(line => {
    if (!line.trim()) return false;
    
    // Always include error lines
    const isError = CONSOLE_LOG_ERROR_PATTERNS.some(pattern => pattern.test(line));
    if (isError) return true;
    
    // Always include important lines
    const isImportant = CONSOLE_LOG_IMPORTANT_PATTERNS.some(pattern => pattern.test(line));
    if (isImportant) return true;
    
    // For 'errors' level, only show errors
    if (filterLevel === 'errors') {
      return isError;
    }
    
    // For 'important' level, show errors + important
    if (filterLevel === 'important') {
      return isError || isImportant;
    }
    
    // For 'filtered' level (default), exclude noise patterns
    const isNoise = CONSOLE_LOG_EXCLUDE_PATTERNS.some(pattern => pattern.test(line));
    return !isNoise;
  });
}

// Get server console log content
router.get('/console-log', async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    // server-console.txt is in zomboidDataPath (where Server/, Saves/, Logs/ are)
    const zomboidDataPath = activeServer?.zomboidDataPath || activeServer?.installPath || await getSetting('zomboidDataPath') || await getSetting('serverPath');
    
    if (!zomboidDataPath) {
      return res.status(400).json({ error: 'Server data path not configured' });
    }
    
    const consoleLogPath = path.join(zomboidDataPath, 'server-console.txt');
    
    if (!fs.existsSync(consoleLogPath)) {
      return res.json({ 
        success: true, 
        content: '', 
        lines: [],
        exists: false,
        path: consoleLogPath
      });
    }
    
    // Filter level: 'all' | 'filtered' | 'important' | 'errors'
    const filterLevel = req.query.filter || 'filtered';
    
    // Read last N lines (default 500, max 2000)
    const maxLines = Math.min(parseInt(req.query.lines) || 500, 2000);
    const content = fs.readFileSync(consoleLogPath, 'utf-8');
    const allLines = content.split('\n');
    
    // Apply filtering
    const filteredLines = filterConsoleLogLines(allLines, filterLevel);
    const lines = filteredLines.slice(-maxLines);
    
    // Get file stats for change detection
    const stats = fs.statSync(consoleLogPath);
    
    res.json({
      success: true,
      content: lines.join('\n'),
      lines,
      totalLines: allLines.length,
      filteredCount: filteredLines.length,
      filterLevel,
      exists: true,
      path: consoleLogPath,
      lastModified: stats.mtime.toISOString(),
      size: stats.size
    });
  } catch (error) {
    log.error(`Failed to read server console log: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Stream server console log (long-polling for new content)
router.get('/console-log/stream', async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    // server-console.txt is in zomboidDataPath (where Server/, Saves/, Logs/ are)
    const zomboidDataPath = activeServer?.zomboidDataPath || activeServer?.installPath || await getSetting('zomboidDataPath') || await getSetting('serverPath');
    
    if (!zomboidDataPath) {
      return res.status(400).json({ error: 'Server data path not configured' });
    }
    
    const consoleLogPath = path.join(zomboidDataPath, 'server-console.txt');
    
    if (!fs.existsSync(consoleLogPath)) {
      return res.json({ success: true, newLines: [], exists: false });
    }
    
    // Filter level: 'all' | 'filtered' | 'important' | 'errors'
    const filterLevel = req.query.filter || 'filtered';
    
    // Get the last known position from client
    const lastSize = parseInt(req.query.lastSize) || 0;
    const stats = fs.statSync(consoleLogPath);
    
    // If file is smaller than last known size, it was likely rotated/cleared
    if (stats.size < lastSize) {
      const content = fs.readFileSync(consoleLogPath, 'utf-8');
      const allLines = content.split('\n').filter(l => l.trim());
      const lines = filterConsoleLogLines(allLines, filterLevel);
      return res.json({
        success: true,
        newLines: lines,
        currentSize: stats.size,
        rotated: true,
        filterLevel,
        lastModified: stats.mtime.toISOString()
      });
    }
    
    // If no new content, return empty
    if (stats.size === lastSize) {
      return res.json({
        success: true,
        newLines: [],
        currentSize: stats.size,
        filterLevel,
        lastModified: stats.mtime.toISOString()
      });
    }
    
    // Read only new content from the last known position
    const fd = fs.openSync(consoleLogPath, 'r');
    const newBytes = stats.size - lastSize;
    const buffer = Buffer.alloc(newBytes);
    fs.readSync(fd, buffer, 0, newBytes, lastSize);
    fs.closeSync(fd);
    
    const newContent = buffer.toString('utf-8');
    const allNewLines = newContent.split('\n').filter(l => l.trim());
    const newLines = filterConsoleLogLines(allNewLines, filterLevel);
    
    res.json({
      success: true,
      newLines,
      currentSize: stats.size,
      filterLevel,
      lastModified: stats.mtime.toISOString()
    });
  } catch (error) {
    log.error(`Failed to stream server console log: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Clear server console log
router.post('/console-log/clear', async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    // server-console.txt is in zomboidDataPath (where Server/, Saves/, Logs/ are)
    const zomboidDataPath = activeServer?.zomboidDataPath || activeServer?.installPath || await getSetting('zomboidDataPath') || await getSetting('serverPath');
    
    if (!zomboidDataPath) {
      return res.status(400).json({ error: 'Server data path not configured' });
    }
    
    const consoleLogPath = path.join(zomboidDataPath, 'server-console.txt');
    
    if (fs.existsSync(consoleLogPath)) {
      fs.writeFileSync(consoleLogPath, '');
      log.info('Server console log cleared');
    }
    
    res.json({ success: true });
  } catch (error) {
    log.error(`Failed to clear server console log: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ==================== UPDATE CHECKER ROUTES ====================

// Check for server updates
router.get('/update-check', async (req, res) => {
  try {
    const updateChecker = req.app.get('updateChecker');
    if (!updateChecker) {
      return res.status(503).json({ error: 'Update checker not available' });
    }

    const forceCheck = req.query.force === 'true';
    
    if (forceCheck) {
      const result = await updateChecker.checkForUpdates(true);
      res.json(result || { error: 'Could not check for updates' });
    } else {
      res.json(updateChecker.getStatus());
    }
  } catch (error) {
    log.error(`Update check failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get update checker status
router.get('/update-check/status', async (req, res) => {
  try {
    const updateChecker = req.app.get('updateChecker');
    if (!updateChecker) {
      return res.status(503).json({ error: 'Update checker not available' });
    }

    res.json(updateChecker.getStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set update check interval
router.post('/update-check/interval', async (req, res) => {
  try {
    const updateChecker = req.app.get('updateChecker');
    if (!updateChecker) {
      return res.status(503).json({ error: 'Update checker not available' });
    }

    const { minutes } = req.body;
    if (!minutes || typeof minutes !== 'number') {
      return res.status(400).json({ error: 'minutes must be a number' });
    }

    await updateChecker.setInterval(minutes);
    res.json({ success: true, intervalMinutes: minutes });
  } catch (error) {
    log.error(`Failed to set update check interval: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;
