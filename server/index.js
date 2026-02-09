import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

import { logger, onLog } from './utils/logger.js';
import { initDatabase, getActiveServer, getAllSettings, getSetting } from './database/init.js';
import { RconService } from './services/rcon.js';
import { ServerManager } from './services/serverManager.js';
import { ModChecker } from './services/modChecker.js';
import { Scheduler } from './services/scheduler.js';
import { DiscordBot } from './services/discordBot.js';
import { BackupService } from './services/backupService.js';
import { UpdateChecker } from './services/updateChecker.js';
import { LogTailer } from './services/logTailer.js';

// Global error handlers to prevent app crashes
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  // Don't exit - keep the app running
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit - keep the app running
});

// Graceful shutdown handling
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  logger.info(`Received ${signal}, shutting down gracefully...`);
  
  try {
    // Stop player polling
    stopPlayerPolling();
    
    // Stop scheduler jobs
    if (scheduler) {
      scheduler.stopAllJobs?.();
    }
    
    // Stop mod checker
    if (modChecker) {
      modChecker.stop();
    }
    
    // Stop log tailer
    if (logTailer) {
      logTailer.stopWatching();
    }
    
    // Stop update checker
    if (updateChecker) {
      updateChecker.stop();
    }
    
    // Stop PanelBridge
    if (panelBridge?.isRunning) {
      panelBridge.stop();
    }
    
    // Stop RCON auto-reconnect and disconnect
    if (rconService) {
      rconService.stopAutoReconnect();
      if (rconService.connected) {
        await rconService.disconnect();
      }
    }
    
    // Close HTTP server
    httpServer.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
    
    // Force exit after 10 seconds if graceful shutdown hangs
    setTimeout(() => {
      logger.warn('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 10000);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Routes
import serverRoutes from './routes/server.js';
import serversRoutes from './routes/servers.js';
import serverFilesRoutes from './routes/serverFiles.js';
import playerRoutes from './routes/players.js';
import rconRoutes from './routes/rcon.js';
import configRoutes from './routes/config.js';
import schedulerRoutes from './routes/scheduler.js';
import modsRoutes from './routes/mods.js';
import chunksRoutes from './routes/chunks.js';
import discordRoutes from './routes/discord.js';
import debugRoutes, { addLogToBuffer } from './routes/debug.js';
import serverFinderRoutes from './routes/serverFinder.js';
import panelBridgeRoutes from './routes/panelBridge.js';
import backupRoutes from './routes/backup.js';
import panelBridge from './services/panelBridge.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: ['http://localhost:5173', 'http://localhost:3001'],
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Initialize services
const rconService = new RconService();
const serverManager = new ServerManager();
const modChecker = new ModChecker();
const logTailer = new LogTailer();
const scheduler = new Scheduler(rconService, serverManager);
const discordBot = new DiscordBot(rconService, serverManager, scheduler, logTailer);
const backupService = new BackupService();

// Connect services for cross-communication
rconService.setServerManager(serverManager);
scheduler.setBackupService(backupService);

// Start RCON auto-reconnect for automatic recovery
rconService.startAutoReconnect();

/**
 * Find the PanelBridge path for the active server
 * PZ Lua mod writes to: {serverRuntimePath}/Lua/panelbridge/{serverName}/
 * For dedicated servers, this is usually a Server_files* folder (set via -cachedir)
 */
async function findPanelBridgePath() {
  const activeServer = await getActiveServer();
  if (!activeServer) {
    return { error: 'No active server configured' };
  }
  
  const serverName = activeServer.serverName || activeServer.name;
  if (!serverName) {
    return { error: 'Server name not configured' };
  }
  
  // Check if db.json has a saved bridgePath that exists and has files
  const settings = await getAllSettings();
  if (settings?.panelBridge?.bridgePath) {
    const savedPath = settings.panelBridge.bridgePath;
    const statusFile = path.join(savedPath, 'status.json');
    if (fs.existsSync(statusFile)) {
      return { path: savedPath, source: 'db.json (saved)', serverName };
    }
  }
  
  // Build list of possible paths - PZ Lua mod writes to Lua/panelbridge/
  const possiblePaths = [];
  
  // Helper to safely read directory contents
  const safeReadDir = (dirPath) => {
    try {
      return fs.existsSync(dirPath) ? fs.readdirSync(dirPath) : [];
    } catch (e) {
      return [];
    }
  };
  
  // PRIORITY 1: zomboidDataPath is where -cachedir points - this is where the mod WRITES status.json
  // This should be checked first since it's explicitly configured for the server
  if (activeServer.zomboidDataPath) {
    possiblePaths.push({ p: path.join(activeServer.zomboidDataPath, 'Lua', 'panelbridge', serverName), source: 'zomboidDataPath/Lua (cachedir)', priority: 1 });
  }
  
  // PRIORITY 2: Look for Server_files* folders at parent level (dedicated server runtime data)
  // This is where -cachedir typically points for dedicated servers with separate data folders
  if (activeServer.installPath) {
    const parentDir = path.dirname(activeServer.installPath);
    const parentContents = safeReadDir(parentDir);
    for (const item of parentContents) {
      if (item.startsWith('Server_files') || item.match(/Server.*files/i)) {
        possiblePaths.push({ p: path.join(parentDir, item, 'Lua', 'panelbridge', serverName), source: `${item}/Lua`, priority: 2 });
      }
    }
  }
  
  // PRIORITY 3: Lua folder directly in install path (fallback)
  if (activeServer.installPath) {
    possiblePaths.push({ p: path.join(activeServer.installPath, 'Lua', 'panelbridge', serverName), source: 'installPath/Lua', priority: 3 });
  }
  
  // Find first path with existing status.json (bridge is active)
  for (const { p, source } of possiblePaths) {
    const statusFile = path.join(p, 'status.json');
    if (fs.existsSync(statusFile)) {
      return { path: p, source, serverName };
    }
  }
  
  // Check for .init file (bridge initialized but not yet active)
  for (const { p, source } of possiblePaths) {
    const initFile = path.join(p, '.init');
    if (fs.existsSync(initFile)) {
      return { path: p, source: `${source} (.init)`, serverName };
    }
  }
  
  // Check if any of the paths exist (even if empty - mod may have started writing)
  for (const { p, source } of possiblePaths) {
    if (fs.existsSync(p)) {
      return { path: p, source: `${source} (exists)`, serverName };
    }
  }
  
  // No existing bridge found - return the best expected path but DON'T create it
  // The directory will be created by the PZ mod when it runs
  if (possiblePaths.length > 0) {
    possiblePaths.sort((a, b) => a.priority - b.priority);
    const bestPath = possiblePaths[0];
    return { path: bestPath.p, source: `${bestPath.source} (expected)`, serverName, notCreated: true };
  }
  
  return { error: 'No valid bridge path could be determined', searchedPaths: possiblePaths.map(x => x.p), serverName };
}

/**
 * Start PanelBridge if a valid bridge path is found
 * This is called both at startup and when RCON connects
 */
async function tryStartPanelBridge(trigger = 'unknown') {
  if (panelBridge.isRunning) {
    logger.debug(`PanelBridge: Already running (trigger: ${trigger})`);
    return true;
  }
  
  const result = await findPanelBridgePath();
  
  if (result.error) {
    logger.debug(`PanelBridge: ${result.error} (trigger: ${trigger})`);
    return false;
  }
  
  try {
    panelBridge.configure(result.path, true);
    panelBridge.start();
    logger.info(`PanelBridge: Started from ${result.source} (trigger: ${trigger})`);
    return true;
  } catch (error) {
    logger.warn(`PanelBridge: Failed to start - ${error.message}`);
    return false;
  }
}

// Auto-start PanelBridge when RCON connects (secondary trigger)
rconService.on('connected', async () => {
  logger.info('RCON connected - checking PanelBridge...');
  await tryStartPanelBridge('rcon-connected');
});

rconService.on('disconnected', () => {
  // Optionally stop the bridge when RCON disconnects (server stopped)
  // Uncomment if you want bridge to stop when server stops:
  // if (panelBridge.isRunning) {
  //   panelBridge.stop();
  //   logger.info('[PanelBridge] Stopped due to RCON disconnect');
  // }
});

// Emit PanelBridge status changes to connected clients via Socket.IO
panelBridge.on('started', () => {
  io.emit('panelBridge:status', { isRunning: true, bridgePath: panelBridge.bridgePath });
});

panelBridge.on('stopped', () => {
  io.emit('panelBridge:status', { isRunning: false, bridgePath: panelBridge.bridgePath });
});

panelBridge.on('modStatus', (status) => {
  io.emit('panelBridge:modStatus', status);
});

panelBridge.on('configured', ({ path }) => {
  io.emit('panelBridge:configured', { bridgePath: path });
});

// Make services available to routes
app.set('rconService', rconService);
app.set('serverManager', serverManager);
app.set('modChecker', modChecker);
app.set('scheduler', scheduler);
app.set('discordBot', discordBot);
app.set('backupService', backupService);
app.set('io', io);

// Initialize update checker (needs io for socket events)
const updateChecker = new UpdateChecker(io);
app.set('updateChecker', updateChecker);

// API Routes
app.use('/api/server', serverRoutes);
app.use('/api/servers', serversRoutes);
app.use('/api/server-files', serverFilesRoutes);
app.use('/api/players', playerRoutes);
app.use('/api/rcon', rconRoutes);
app.use('/api/config', configRoutes);
app.use('/api/scheduler', schedulerRoutes);
app.use('/api/mods', modsRoutes);
app.use('/api/chunks', chunksRoutes);
app.use('/api/discord', discordRoutes);
app.use('/api/debug', debugRoutes);
app.use('/api/server-finder', serverFinderRoutes);
app.use('/api/panel-bridge', panelBridgeRoutes);
app.use('/api/backup', backupRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static files in production
// Detect if running as packaged exe (pkg sets process.pkg)
const isPackaged = typeof process.pkg !== 'undefined';
let clientDistPath;

if (isPackaged) {
  // When packaged, client/dist is next to the exe
  clientDistPath = path.join(path.dirname(process.execPath), 'client', 'dist');
} else {
  // Development mode
  clientDistPath = path.join(__dirname, '../client/dist');
}

logger.info(`Serving client from: ${clientDistPath}`);
app.use(express.static(clientDistPath));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({ error: 'API endpoint not found' });
  } else {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);
  
  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });
  
  // Subscribe to server status updates
  socket.on('subscribe:status', () => {
    socket.join('server-status');
  });
  
  // Subscribe to player updates
  socket.on('subscribe:players', () => {
    socket.join('players');
  });
  
  // Subscribe to logs
  socket.on('subscribe:logs', () => {
    socket.join('logs');
  });
});

// Stream logs to Socket.IO clients
onLog((logEntry) => {
  addLogToBuffer(logEntry.level, logEntry.message, logEntry.source);
  io.to('logs').emit('log:entry', logEntry);
});

// ============================================
// Server-side player polling for real-time updates
// ============================================
let lastPlayerList = [];
let playerPollingInterval = null;

function startPlayerPolling() {
  // Poll every 5 seconds for player changes
  if (playerPollingInterval) {
    clearInterval(playerPollingInterval);
  }
  
  playerPollingInterval = setInterval(async () => {
    try {
      // Only poll if RCON is connected
      if (!rconService.connected) {
        return;
      }
      
      const result = await rconService.getPlayers();
      if (result.success && result.players) {
        // Check if player list has changed
        const currentNames = result.players.map(p => p.name).sort().join(',');
        const lastNames = lastPlayerList.map(p => p.name).sort().join(',');
        
        if (currentNames !== lastNames) {
          lastPlayerList = result.players;
          // Broadcast to all clients in the 'players' room
          io.to('players').emit('players:update', result.players);
          logger.debug(`Player list updated: ${result.players.length} players online`);
        }
      }
    } catch (error) {
      // Silently ignore polling errors to avoid log spam
      logger.debug(`Player polling error: ${error.message}`);
    }
  }, 5000);
  
  logger.info('Server-side player polling started (5s interval)');
}

function stopPlayerPolling() {
  if (playerPollingInterval) {
    clearInterval(playerPollingInterval);
    playerPollingInterval = null;
    logger.info('Server-side player polling stopped');
  }
}

// Initialize and start server
async function start() {
  try {
    // Initialize database
    await initDatabase();
    logger.info('Database initialized');

    // Initialize log tailer
    await logTailer.init();
    
    // Broadcast live chat messages to Socket.IO clients
    logTailer.on('chatMessage', (data) => {
        io.emit('chat:message', {
            id: Date.now().toString(),
            type: 'general', // Default to general for now
            author: data.author,
            message: data.message,
            timestamp: data.timestamp
        });
    });
    
    // Initialize scheduler first (needed by modChecker for auto-restart)
    await scheduler.init();
    
    // Initialize mod checker with scheduler, serverManager, and socket.io
    // Pass io so it can emit real-time events for mod updates
    await modChecker.init(scheduler, serverManager, io);
    
    // Start mod checker if workshop ACF file is found (detects mod updates locally)
    if (modChecker.workshopAcfPath) {
      modChecker.start();
      logger.info('Mod checker started - using local Steam Workshop cache');
    } else {
      logger.info('Mod checker: Workshop ACF file not found - ensure server install path is configured');
    }
    
    // Initialize Discord bot
    await discordBot.loadConfig();
    if (discordBot.token && discordBot.guildId) {
      await discordBot.start();
      logger.info('Discord bot started');
    }
    
    // Check if PZ server is already running and auto-configure services
    // Run this in the background so it doesn't block server startup
    (async () => {
      try {
        // Wait a moment for everything to initialize
        await new Promise(r => setTimeout(r, 1000));
        
        // STEP 1: Try to start PanelBridge first (file-based, independent of RCON)
        // This works even if RCON isn't connected yet
        const bridgeStarted = await tryStartPanelBridge('startup');
        if (bridgeStarted) {
          logger.info('PanelBridge started on startup (found active bridge files)');
        }
        
        // STEP 2: Check if PZ server is running and connect RCON
        const timeoutMs = 15000;
        const isRunning = await Promise.race([
          serverManager.checkServerRunning(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Server check timeout')), timeoutMs))
        ]);
        
        if (isRunning) {
          logger.info('PZ server detected running - connecting RCON...');
          
          // Try to connect RCON with retries
          let connected = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              await Promise.race([
                rconService.connect(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('RCON connection timeout')), timeoutMs))
              ]);
              
              if (rconService.connected) {
                connected = true;
                logger.info(`RCON connected on attempt ${attempt}`);
                break;
              }
            } catch (e) {
              logger.debug(`RCON connection attempt ${attempt} failed: ${e.message}`);
              if (attempt < 3) {
                await new Promise(r => setTimeout(r, 5000)); // Wait 5s before retry
              }
            }
          }
          
          if (!connected) {
            logger.warn('RCON connection failed after 3 attempts - auto-reconnect will keep trying');
          }
        } else {
          logger.info('PZ server not detected running on startup');
          
          // Check if auto-start is enabled
          const autoStartServer = await getSetting('autoStartServer');
          if (autoStartServer === true || autoStartServer === 'true') {
            logger.info('Auto-start is enabled - starting PZ server...');
            
            // Set flag to prevent auto-reconnect from interfering
            rconService.setServerStarting(true);
            
            try {
              const startResult = await serverManager.startServer();
              if (startResult.success) {
                logger.info('PZ server auto-started successfully');
                
                // Wait for server to fully start before connecting RCON
                // Monitor the TCP port instead of hard waiting
                logger.info('PZ server auto-started - Monitoring RCON port...');
                
                await rconService.loadConfig(); // Ensure clean config
                const rconHost = rconService.config.host || '127.0.0.1';
                const rconPort = rconService.config.port || 27015;
                
                let connected = false;
                const maxPollAttempts = 60; // 5 minutes max
                
                for (let i = 0; i < maxPollAttempts; i++) {
                  // Check port readiness
                  const portOpen = await rconService.checkPortOpen(rconHost, rconPort);
                  
                  if (!portOpen) {
                    // Log every 30s
                    if (i % 6 === 0) {
                      logger.debug(`Auto-start: Waiting for RCON port ${rconHost}:${rconPort}...`);
                    }
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                  }
                  
                  // Port is open, try to connect
                  logger.info(`RCON port open! Attempting connection...`);
                  
                  try {
                    await Promise.race([
                      rconService.connect(),
                      new Promise((_, reject) => setTimeout(() => reject(new Error('RCON connection timeout')), 15000))
                    ]);
                    
                    if (rconService.connected) {
                      logger.info('RCON connected successfully after auto-start');
                      connected = true;
                      break;
                    } else {
                        // Port open but auth/handshake failed
                        logger.debug('RCON port open but connection failed, retrying in 5s...');
                        await new Promise(r => setTimeout(r, 5000));
                    }
                  } catch (e) {
                    logger.debug(`Auto-start RCON connection failed: ${e.message}`);
                    await new Promise(r => setTimeout(r, 5000));
                  }
                }
              } else {
                logger.error('Failed to auto-start PZ server:', startResult.error);
              }
            } catch (e) {
              logger.error('Error during auto-start:', e.message);
            } finally {
              // Clear the flag so auto-reconnect can resume normally
              rconService.setServerStarting(false);
            }
          }
          
          // Even if server isn't running, Panel Bridge might have stale files
          // The bridge will detect the mod isn't responding via status timestamp
        }
      } catch (e) {
        logger.debug(`Startup initialization: ${e.message}`);
      }
    })();
    
    // Start server-side player polling for real-time updates
    startPlayerPolling();
    
    // Start update checker for server updates
    updateChecker.start();
    
    const PORT = process.env.PORT || 3001;
    httpServer.listen(PORT, () => {
      console.log('');
      console.log('  ╔═══════════════════════════════════════════════╗');
      console.log('  ║         Zomboid Control Panel                 ║');
      console.log('  ╠═══════════════════════════════════════════════╣');
      console.log(`  ║  Web UI:  http://localhost:${PORT}               ║`);
      console.log(`  ║  API:     http://localhost:${PORT}/api           ║`);
      console.log('  ╚═══════════════════════════════════════════════╝');
      console.log('');
      
      // Auto-open browser when running as packaged exe
      if (typeof process.pkg !== 'undefined') {
        const url = `http://localhost:${PORT}`;
        exec(`start "" "${url}"`, (err) => {
          if (err) logger.error('Failed to open browser:', err);
        });
      }
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

export { io };
