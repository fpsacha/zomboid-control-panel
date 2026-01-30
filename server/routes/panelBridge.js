/**
 * PanelBridge API Routes
 * 
 * REST API endpoints to manage and interact with the PanelBridge mod.
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bridge from '../services/panelBridge.js';
import { getActiveServer, getAllSettings } from '../database/init.js';

// ES Module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Get bridge status
router.get('/status', async (req, res) => {
  const status = bridge.getStatus();
  
  // Also include detected paths from active server
  let detectedPaths = null;
  try {
    const activeServer = await getActiveServer();
    if (activeServer) {
      detectedPaths = {
        serverName: activeServer.serverName || activeServer.name,
        installPath: activeServer.installPath,
        zomboidDataPath: activeServer.zomboidDataPath,
        // Bridge path would be: zomboidDataPath/Saves/Multiplayer/{serverName}/panelbridge/
        // OR for dedicated servers: installPath/../Server_files/Saves/Multiplayer/{serverName}/panelbridge/
      };
    }
  } catch (e) {
    // Ignore
  }
  
  res.json({
    ...status,
    modConnected: bridge.isModConnected(),
    detectedPaths
  });
});

// Auto-configure bridge from active server settings
router.post('/auto-configure', async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    if (!activeServer) {
      return res.status(400).json({ error: 'No active server configured. Please configure a server first.' });
    }
    
    const serverName = activeServer.serverName || activeServer.name;
    if (!serverName) {
      return res.status(400).json({ error: 'Server name not configured.' });
    }
    
    // The PanelBridge mod writes to: {RuntimeDataPath}/Lua/panelbridge/{serverName}/
    // For dedicated servers, the runtime data folder is often separate from the install folder
    // Pattern: Server_Data/DoomerZ_B42 (install) + Server_files_B42 (runtime data)
    const possiblePaths = [];
    const searchedLocations = [];
    
    // Helper to safely read directory contents
    const safeReadDir = (dirPath) => {
      try {
        return fs.existsSync(dirPath) ? fs.readdirSync(dirPath) : [];
      } catch (e) {
        return [];
      }
    };
    
    // Helper to add path with metadata
    const addPath = (p, source) => {
      const statusFile = path.join(p, 'status.json');
      const initFile = path.join(p, '.init');
      const hasStatus = fs.existsSync(statusFile);
      const hasInit = fs.existsSync(initFile);
      
      possiblePaths.push({
        path: p,
        source,
        hasStatus,
        hasInit,
        exists: hasStatus || hasInit || fs.existsSync(p)
      });
      searchedLocations.push({ path: p, source, hasStatus, hasInit });
    };
    
    if (activeServer.installPath) {
      // Get the parent directory (e.g., E:\PZ\)
      const parentDir = path.dirname(activeServer.installPath);
      
      // PRIORITY 1: Look for Server_files* folders at the parent level (runtime data location)
      const parentContents = safeReadDir(parentDir);
      for (const item of parentContents) {
        // Match Server_files* patterns (e.g., Server_files_B42, Server_files_B42_Beta1)
        if (item.startsWith('Server_files') || item.match(/Server.*files/i)) {
          const luaPath = path.join(parentDir, item, 'Lua', 'panelbridge', serverName);
          addPath(luaPath, `parent/${item}/Lua`);
        }
      }
      
      // PRIORITY 2: Also check grandparent directory (for nested setups)
      const grandParentDir = path.dirname(parentDir);
      if (grandParentDir !== parentDir) {
        const grandParentContents = safeReadDir(grandParentDir);
        for (const item of grandParentContents) {
          if (item.startsWith('Server_files') || item.match(/Server.*files/i)) {
            const luaPath = path.join(grandParentDir, item, 'Lua', 'panelbridge', serverName);
            addPath(luaPath, `grandparent/${item}/Lua`);
          }
        }
      }
      
      // PRIORITY 3: Lua folder directly in install path (some setups)
      addPath(path.join(activeServer.installPath, 'Lua', 'panelbridge', serverName), 'installPath/Lua');
      
      // PRIORITY 4: Check for Lua folder at parent level
      addPath(path.join(parentDir, 'Lua', 'panelbridge', serverName), 'parent/Lua');
    }
    
    // Check zomboidDataPath if set
    if (activeServer.zomboidDataPath) {
      addPath(path.join(activeServer.zomboidDataPath, 'Lua', 'panelbridge', serverName), 'zomboidDataPath/Lua');
      
      // Also check parent of zomboidDataPath for Server_files
      const dataParent = path.dirname(activeServer.zomboidDataPath);
      const dataParentContents = safeReadDir(dataParent);
      for (const item of dataParentContents) {
        if (item.startsWith('Server_files') || item.match(/Server.*files/i)) {
          const luaPath = path.join(dataParent, item, 'Lua', 'panelbridge', serverName);
          addPath(luaPath, `zomboidDataPath_parent/${item}/Lua`);
        }
      }
    }
    
    // Find first path that has actual status.json (best match)
    let foundPath = possiblePaths.find(p => p.hasStatus);
    
    // Fall back to path with .init file
    if (!foundPath) {
      foundPath = possiblePaths.find(p => p.hasInit);
    }
    
    // Fall back to first Server_files path that exists or can be created
    if (!foundPath) {
      foundPath = possiblePaths.find(p => p.source.includes('Server_files'));
    }
    
    // Last resort: any path
    if (!foundPath && possiblePaths.length > 0) {
      foundPath = possiblePaths[0];
    }
    
    if (!foundPath) {
      return res.status(400).json({ 
        error: `Could not determine bridge path for server "${serverName}". Make sure server installPath is set.`,
        searchedPaths: searchedLocations
      });
    }
    
    // Create the directory if it doesn't exist
    if (!fs.existsSync(foundPath.path)) {
      fs.mkdirSync(foundPath.path, { recursive: true });
    }
    
    // Configure and start bridge - foundPath IS the complete panelbridge folder
    const bridgePath = bridge.configure(foundPath.path, true); // true = direct path
    bridge.start();
    
    res.json({ 
      success: true, 
      message: 'Bridge auto-configured from active server', 
      bridgePath: foundPath.path,
      serverName,
      source: foundPath.source,
      hasStatus: foundPath.hasStatus,
      searchedPaths: searchedLocations
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Auto-detect bridge path from server name
router.post('/auto-detect', (req, res) => {
  const { serverName, zomboidUserFolder } = req.body;
  
  if (!serverName) {
    return res.status(400).json({ error: 'serverName is required' });
  }
  
  try {
    const bridgePath = bridge.autoDetect(serverName, zomboidUserFolder);
    bridge.start();
    res.json({ 
      success: true, 
      message: 'Bridge auto-configured and started', 
      bridgePath 
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Configure the bridge with Zomboid save path
router.post('/configure', (req, res) => {
  const { zomboidSavePath } = req.body;
  
  if (!zomboidSavePath) {
    return res.status(400).json({ error: 'zomboidSavePath is required' });
  }
  
  try {
    const bridgePath = bridge.configure(zomboidSavePath);
    // Also start the bridge automatically after configuring
    if (!bridge.isRunning) {
      bridge.start();
    }
    res.json({ success: true, message: 'Bridge configured and started', bridgePath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start the bridge polling
router.post('/start', (req, res) => {
  try {
    bridge.start();
    res.json({ success: true, message: 'Bridge started' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stop the bridge
router.post('/stop', (req, res) => {
  try {
    bridge.stop();
    res.json({ success: true, message: 'Bridge stopped' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Scan for all panelbridge folders across known locations
router.get('/scan-paths', async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    const allSettings = await getAllSettings();
    const foundBridges = [];
    const scannedDirs = [];
    
    // Helper to recursively search for panelbridge folders
    const searchForBridge = (baseDir, depth = 0, maxDepth = 3) => {
      if (depth > maxDepth || !baseDir || !fs.existsSync(baseDir)) return;
      
      try {
        const contents = fs.readdirSync(baseDir, { withFileTypes: true });
        
        for (const item of contents) {
          if (!item.isDirectory()) continue;
          
          const itemPath = path.join(baseDir, item.name);
          
          // Check if this is a panelbridge folder
          if (item.name === 'panelbridge') {
            // List server folders inside
            try {
              const serverFolders = fs.readdirSync(itemPath, { withFileTypes: true });
              for (const sf of serverFolders) {
                if (!sf.isDirectory()) continue;
                
                const serverPath = path.join(itemPath, sf.name);
                const statusFile = path.join(serverPath, 'status.json');
                const initFile = path.join(serverPath, '.init');
                const hasStatus = fs.existsSync(statusFile);
                const hasInit = fs.existsSync(initFile);
                
                let statusAge = null;
                let modVersion = null;
                if (hasStatus) {
                  try {
                    const stats = fs.statSync(statusFile);
                    statusAge = Date.now() - stats.mtimeMs;
                    const content = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
                    modVersion = content.version;
                  } catch (e) { /* ignore */ }
                }
                
                foundBridges.push({
                  path: serverPath,
                  serverName: sf.name,
                  baseDir,
                  hasStatus,
                  hasInit,
                  statusAge,
                  modVersion,
                  isActive: statusAge !== null && statusAge < 60000 // Active if updated in last minute
                });
              }
            } catch (e) { /* ignore */ }
            continue;
          }
          
          // Look for Lua folder
          if (item.name === 'Lua') {
            const bridgePath = path.join(itemPath, 'panelbridge');
            if (fs.existsSync(bridgePath)) {
              scannedDirs.push(bridgePath);
              searchForBridge(bridgePath, depth + 1, maxDepth);
            }
            continue;
          }
          
          // Look for Server_files* folders
          if (item.name.startsWith('Server_files') || item.name.match(/Server.*files/i)) {
            scannedDirs.push(itemPath);
            searchForBridge(itemPath, depth + 1, maxDepth);
          }
        }
      } catch (e) {
        // Ignore errors reading directories
      }
    };
    
    // Build list of directories to search
    const searchDirs = new Set();
    
    if (activeServer?.installPath) {
      searchDirs.add(activeServer.installPath);
      searchDirs.add(path.dirname(activeServer.installPath));
    }
    
    if (activeServer?.zomboidDataPath) {
      searchDirs.add(activeServer.zomboidDataPath);
      searchDirs.add(path.dirname(activeServer.zomboidDataPath));
    }
    
    // Also check the current bridge path if set
    if (bridge.bridgePath) {
      const parts = bridge.bridgePath.split(path.sep);
      const panelbridgeIdx = parts.indexOf('panelbridge');
      if (panelbridgeIdx > 0) {
        searchDirs.add(parts.slice(0, panelbridgeIdx).join(path.sep));
      }
    }
    
    // Search all directories
    for (const dir of searchDirs) {
      if (dir) {
        scannedDirs.push(dir);
        searchForBridge(dir);
      }
    }
    
    res.json({
      foundBridges,
      scannedDirs: [...new Set(scannedDirs)],
      currentPath: bridge.bridgePath,
      isRunning: bridge.isRunning,
      modConnected: bridge.isModConnected()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Force refresh - restart bridge with fresh state
router.post('/refresh', (req, res) => {
  try {
    if (bridge.isRunning) {
      bridge.stop();
    }
    
    // Reset internal state
    bridge.modStatus = null;
    bridge.consecutiveFailures = 0;
    bridge.lastStatusFileCheck = 0;
    
    if (bridge.bridgePath) {
      bridge.start();
      res.json({ 
        success: true, 
        message: 'Bridge refreshed',
        bridgePath: bridge.bridgePath
      });
    } else {
      res.json({ 
        success: false, 
        message: 'Bridge not configured - use auto-configure first'
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ping the mod
router.get('/ping', async (req, res) => {
  if (!bridge.bridgePath) {
    return res.status(400).json({ error: 'Bridge not configured' });
  }
  
  try {
    const result = await bridge.ping();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send a command to the game
router.post('/command', async (req, res) => {
  const { action, args } = req.body;
  
  if (!action) {
    return res.status(400).json({ error: 'action is required' });
  }
  
  if (!bridge.bridgePath) {
    return res.status(400).json({ error: 'Bridge not configured' });
  }
  
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  
  try {
    const result = await bridge.sendCommand(action, args || {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get weather info
router.get('/weather', async (req, res) => {
  if (!bridge.bridgePath) {
    return res.status(400).json({ error: 'Bridge not configured' });
  }
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  
  try {
    const result = await bridge.getWeather();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get server info
router.get('/server-info', async (req, res) => {
  if (!bridge.bridgePath) {
    return res.status(400).json({ error: 'Bridge not configured' });
  }
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  
  try {
    const result = await bridge.getServerInfo();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Weather control endpoints
router.post('/weather/blizzard', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { duration } = req.body;
  try {
    const result = await bridge.triggerBlizzard(duration);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/weather/tropical-storm', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { duration } = req.body;
  try {
    const result = await bridge.triggerTropicalStorm(duration);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/weather/storm', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { duration } = req.body;
  try {
    const result = await bridge.triggerStorm(duration);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/weather/stop', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  try {
    const result = await bridge.stopWeather();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/weather/snow', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { enabled } = req.body;
  try {
    const result = await bridge.setSnow(enabled !== false);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// NEW V1.1.0 ENDPOINTS
// =============================================

// Rain control
router.post('/weather/rain/start', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { intensity } = req.body;
  try {
    const result = await bridge.startRain(intensity || 1.0);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/weather/rain/stop', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  try {
    const result = await bridge.stopRain();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Lightning
router.post('/weather/lightning', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { x, y, strike, light, rumble } = req.body;
  try {
    const result = await bridge.triggerLightning(x, y, strike, light, rumble);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Climate float control
router.get('/climate/floats', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  try {
    const result = await bridge.getClimateFloats();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/climate/float', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { floatId, value, enable } = req.body;
  if (floatId === undefined || value === undefined) {
    return res.status(400).json({ error: 'floatId and value are required' });
  }
  try {
    const result = await bridge.setClimateFloat(floatId, value, enable !== false);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/climate/reset', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  try {
    const result = await bridge.resetClimateOverrides();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Game time endpoints
router.get('/time', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  try {
    const result = await bridge.getGameTime();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/time', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { hour, day, month, year } = req.body;
  try {
    const result = await bridge.setGameTime({ hour, day, month, year });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// World stats
router.get('/world/stats', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  try {
    const result = await bridge.getWorldStats();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save world
router.post('/world/save', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  try {
    const result = await bridge.saveWorld();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Player endpoints
router.get('/players', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  try {
    const result = await bridge.getAllPlayerDetails();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/players/:username', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  try {
    const result = await bridge.getPlayerDetails(req.params.username);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/players/:username/teleport', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { x, y, z } = req.body;
  if (x === undefined || y === undefined) {
    return res.status(400).json({ error: 'x and y coordinates are required' });
  }
  try {
    const result = await bridge.teleportPlayer(req.params.username, x, y, z);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Server message
router.post('/message', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { message, color } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }
  try {
    const result = await bridge.sendServerMessage(message, color);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sandbox options (read-only)
router.get('/sandbox', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  try {
    const result = await bridge.getSandboxOptions();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get available commands (updated list)
router.get('/commands', (req, res) => {
  res.json({
    commands: [
      // Basic
      { action: 'ping', description: 'Health check', args: {} },
      { action: 'getServerInfo', description: 'Get server info and players', args: {} },
      
      // Weather
      { action: 'getWeather', description: 'Get current weather (enhanced)', args: {} },
      { action: 'triggerBlizzard', description: 'Trigger a blizzard', args: { duration: 'number (default: 1.0)' } },
      { action: 'triggerTropicalStorm', description: 'Trigger tropical storm', args: { duration: 'number (default: 1.0)' } },
      { action: 'triggerStorm', description: 'Trigger a storm', args: { duration: 'number (default: 1.0)' } },
      { action: 'stopWeather', description: 'Stop all weather', args: {} },
      { action: 'generateWeather', description: 'Generate weather period', args: { strength: '0-1', frontType: '0-2' } },
      { action: 'setSnow', description: 'Enable/disable snow (auto-enables rain)', args: { enabled: 'boolean' } },
      { action: 'startRain', description: 'Start rain', args: { intensity: '0-1 (default: 1.0)' } },
      { action: 'stopRain', description: 'Stop rain', args: {} },
      { action: 'triggerLightning', description: 'Trigger lightning bolt', args: { x: 'optional', y: 'optional', strike: 'boolean', light: 'boolean', rumble: 'boolean' } },
      
      // Climate Control
      { action: 'getClimateFloats', description: 'Get all climate float values', args: {} },
      { action: 'setClimateFloat', description: 'Set climate float value', args: { floatId: '0-12', value: 'number', enable: 'boolean' } },
      { action: 'resetClimateOverrides', description: 'Reset all admin climate overrides', args: {} },
      { action: 'setDayLight', description: 'Set daylight strength', args: { value: '0-1' } },
      { action: 'setNightStrength', description: 'Set night strength', args: { value: '0-1' } },
      { action: 'setDesaturation', description: 'Set desaturation level', args: { value: '0-1' } },
      { action: 'setViewDistance', description: 'Set view distance', args: { value: '0-1' } },
      { action: 'setAmbient', description: 'Set ambient light', args: { value: '0-1' } },
      
      // Time
      { action: 'getGameTime', description: 'Get current game time/date', args: {} },
      { action: 'setGameTime', description: 'Set game time/date', args: { hour: 'number', day: 'number', month: 'number', year: 'number' } },
      
      // World
      { action: 'getWorldStats', description: 'Get world statistics', args: {} },
      { action: 'getSandboxOptions', description: 'Get sandbox options (read-only)', args: {} },
      { action: 'saveWorld', description: 'Trigger world save', args: {} },
      
      // Players
      { action: 'getAllPlayerDetails', description: 'Get detailed info for all players', args: {} },
      { action: 'getPlayerDetails', description: 'Get detailed info for a player', args: { username: 'string' } },
      { action: 'teleportPlayer', description: 'Teleport a player', args: { username: 'string', x: 'number', y: 'number', z: 'number (optional)' } },
      { action: 'sendServerMessage', description: 'Send message to all players', args: { message: 'string', color: 'string (optional)' } },
      
      // Sound/Noise (v1.2.0)
      { action: 'playWorldSound', description: 'Create zombie-attracting sound at coordinates', args: { x: 'number', y: 'number', z: 'number (optional)', radius: 'number (default: 50)', volume: 'number (default: 100)' } },
      { action: 'playSoundNearPlayer', description: 'Create sound at player location', args: { username: 'string', radius: 'number (default: 50)', volume: 'number (default: 100)' } },
      { action: 'triggerGunshot', description: 'Simulate loud gunshot (150m radius)', args: { x: 'number', y: 'number', username: 'string (alternative)' } },
      { action: 'triggerAlarmSound', description: 'Trigger alarm sound (80m radius)', args: { x: 'number', y: 'number', username: 'string (alternative)' } },
      { action: 'createNoise', description: 'Create custom noise', args: { x: 'number', y: 'number', radius: 'number', volume: 'number', username: 'string (alternative)' } },
    ],
    climateFloatIds: {
      0: 'FLOAT_DESATURATION',
      1: 'FLOAT_GLOBAL_LIGHT_INTENSITY',
      2: 'FLOAT_NIGHT_STRENGTH',
      3: 'FLOAT_PRECIPITATION_INTENSITY',
      4: 'FLOAT_TEMPERATURE',
      5: 'FLOAT_FOG_INTENSITY',
      6: 'FLOAT_WIND_INTENSITY',
      7: 'FLOAT_WIND_ANGLE_INTENSITY',
      8: 'FLOAT_CLOUD_INTENSITY',
      9: 'FLOAT_AMBIENT',
      10: 'FLOAT_VIEW_DISTANCE',
      11: 'FLOAT_DAYLIGHT_STRENGTH',
      12: 'FLOAT_HUMIDITY'
    }
  });
});

// Get mod installation path (for copying mod to server)
router.get('/mod-path', async (req, res) => {
  // Path to the bundled mod - check multiple locations for packaged exe
  const possiblePaths = [
    path.join(process.cwd(), 'pz-mod', 'PanelBridge'),
    path.join(path.dirname(process.execPath), 'pz-mod', 'PanelBridge'),
    path.join(__dirname, '..', '..', 'pz-mod', 'PanelBridge'),
  ];
  
  let modPath = possiblePaths[0];
  let exists = false;
  
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      modPath = p;
      exists = true;
      break;
    }
  }
  
  // Also detect suggested install path from active server
  let suggestedInstallPath = null;
  try {
    const activeServer = await getActiveServer();
    if (activeServer?.installPath) {
      // For dedicated servers, Lua folder is at: {installPath}/media/lua/server/
      suggestedInstallPath = path.join(activeServer.installPath, 'media', 'lua', 'server');
    }
  } catch (e) {
    // Ignore
  }
  
  res.json({
    modPath,
    exists,
    files: exists ? fs.readdirSync(modPath) : [],
    suggestedInstallPath
  });
});

// Auto-install mod to active server's Lua folder
router.post('/install-mod-auto', async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    if (!activeServer) {
      return res.status(400).json({ error: 'No active server configured.' });
    }
    
    // Use serverPath if available, otherwise extract directory from installPath
    let serverInstallDir = activeServer.serverPath || activeServer.installPath;
    if (!serverInstallDir) {
      return res.status(400).json({ error: 'Server install path not configured.' });
    }
    
    // If installPath points to a file (e.g., .bat), extract the directory
    if (serverInstallDir.endsWith('.bat') || serverInstallDir.endsWith('.sh') || serverInstallDir.endsWith('.exe')) {
      serverInstallDir = path.dirname(serverInstallDir);
    }
    
    // Find source mod
    const possiblePaths = [
      path.join(process.cwd(), 'pz-mod', 'PanelBridge'),
      path.join(path.dirname(process.execPath), 'pz-mod', 'PanelBridge'),
      path.join(__dirname, '..', '..', 'pz-mod', 'PanelBridge'),
    ];
    
    let sourcePath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        sourcePath = p;
        break;
      }
    }
    
    if (!sourcePath) {
      return res.status(404).json({ error: 'Source mod not found.' });
    }
    
    // Install to: {serverInstallDir}/media/lua/server/PanelBridge.lua
    const luaServerPath = path.join(serverInstallDir, 'media', 'lua', 'server');
    const sourceLuaFile = path.join(sourcePath, 'media', 'lua', 'server', 'PanelBridge.lua');
    const destLuaFile = path.join(luaServerPath, 'PanelBridge.lua');
    
    // Ensure destination directory exists
    if (!fs.existsSync(luaServerPath)) {
      fs.mkdirSync(luaServerPath, { recursive: true });
    }
    
    // Copy the Lua file
    if (!fs.existsSync(sourceLuaFile)) {
      return res.status(404).json({ error: `Source Lua file not found at: ${sourceLuaFile}` });
    }
    
    fs.copyFileSync(sourceLuaFile, destLuaFile);
    
    res.json({ 
      success: true, 
      message: 'PanelBridge.lua installed to server Lua folder', 
      path: destLuaFile,
      serverName: activeServer.serverName || activeServer.name
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Copy mod to server Lua folder (manual path)
router.post('/install-mod', (req, res) => {
  const { serverLuaPath } = req.body;
  
  // Support legacy field name
  const targetPath = serverLuaPath || req.body.serverModsPath;
  
  if (!targetPath) {
    return res.status(400).json({ error: 'serverLuaPath is required (path to media/lua/server/)' });
  }
  
  try {
    // Find source mod from multiple possible locations
    const possiblePaths = [
      path.join(process.cwd(), 'pz-mod', 'PanelBridge'),
      path.join(path.dirname(process.execPath), 'pz-mod', 'PanelBridge'),
      path.join(__dirname, '..', '..', 'pz-mod', 'PanelBridge'),
    ];
    
    let sourcePath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        sourcePath = p;
        break;
      }
    }
    
    if (!sourcePath) {
      return res.status(404).json({ error: 'Source mod not found. Checked: ' + possiblePaths.join(', ') });
    }
    
    // Source Lua file
    const sourceLuaFile = path.join(sourcePath, 'media', 'lua', 'server', 'PanelBridge.lua');
    
    if (!fs.existsSync(sourceLuaFile)) {
      return res.status(404).json({ error: `Source Lua file not found at: ${sourceLuaFile}` });
    }
    
    // Ensure target directory exists
    if (!fs.existsSync(targetPath)) {
      fs.mkdirSync(targetPath, { recursive: true });
    }
    
    // Copy the Lua file
    const destPath = path.join(targetPath, 'PanelBridge.lua');
    fs.copyFileSync(sourceLuaFile, destPath);
    
    res.json({ 
      success: true, 
      message: 'PanelBridge.lua installed successfully', 
      path: destPath 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// V1.2.0 SOUND/NOISE ENDPOINTS
// =============================================

// Play sound at world coordinates
router.post('/sound/world', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { x, y, z, radius, volume } = req.body;
  if (x === undefined || y === undefined) {
    return res.status(400).json({ error: 'x and y coordinates are required' });
  }
  try {
    const result = await bridge.playWorldSound(x, y, z, radius, volume);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Play sound near a player
router.post('/sound/near-player', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { username, radius, volume } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'username is required' });
  }
  try {
    const result = await bridge.playSoundNearPlayer(username, radius, volume);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Trigger gunshot sound
router.post('/sound/gunshot', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { x, y, z, username } = req.body;
  try {
    const result = await bridge.triggerGunshot({ x, y, z, username });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Trigger alarm sound
router.post('/sound/alarm', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { x, y, z, username } = req.body;
  try {
    const result = await bridge.triggerAlarmSound({ x, y, z, username });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create custom noise
router.post('/sound/noise', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { x, y, z, radius, volume, username } = req.body;
  try {
    const result = await bridge.createNoise({ x, y, z, radius, volume, username });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// V1.4.0 INFRASTRUCTURE (POWER/WATER) ENDPOINTS
// =============================================

// Get utilities (power/water) status
router.get('/utilities/status', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  try {
    const result = await bridge.sendCommand('getUtilitiesStatus', {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Restore utilities (turn power/water back on)
router.post('/utilities/restore', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { power, water } = req.body;
  try {
    const result = await bridge.sendCommand('restoreUtilities', { 
      power: power !== false, 
      water: water !== false 
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Shut off utilities
router.post('/utilities/shutoff', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { power, water } = req.body;
  try {
    const result = await bridge.sendCommand('shutOffUtilities', { 
      power: power !== false, 
      water: water !== false 
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// V1.5.0 CHARACTER EXPORT/IMPORT
// =============================================

// Export character data (XP, perks, skills, traits, inventory)
router.post('/character/export', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  try {
    const result = await bridge.sendCommand('exportPlayerData', { username });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Import character data (apply XP, perks to player)
router.post('/character/import', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running. Start it first.' });
  }
  const { username, data } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  if (!data) {
    return res.status(400).json({ error: 'Character data is required' });
  }
  // Validate data is an object with expected structure
  if (typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ error: 'Character data must be an object' });
  }
  // Check for at least one valid data section
  const validSections = ['perks', 'xp', 'skills', 'traits', 'recipes', 'stats'];
  const hasValidSection = validSections.some(section => data[section] !== undefined);
  if (!hasValidSection) {
    return res.status(400).json({ error: 'Character data must contain at least one of: perks, xp, skills, traits, recipes, stats' });
  }
  try {
    const result = await bridge.sendCommand('importPlayerData', { username, data });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PLAYER ADMIN CONTROLS
// ============================================

// Give item to player
router.post('/players/:username/give-item', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  const { username } = req.params;
  const { itemType, count = 1 } = req.body;
  if (!itemType) {
    return res.status(400).json({ error: 'itemType is required (e.g., "Base.Axe")' });
  }
  try {
    const result = await bridge.sendCommand('giveItem', { username, itemType, count });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Heal player
router.post('/players/:username/heal', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  const { username } = req.params;
  try {
    const result = await bridge.sendCommand('healPlayer', { username });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Kill player
router.post('/players/:username/kill', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  const { username } = req.params;
  try {
    const result = await bridge.sendCommand('killPlayer', { username });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set god mode for player
router.post('/players/:username/godmode', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  const { username } = req.params;
  const { enabled } = req.body;
  try {
    const result = await bridge.sendCommand('setGodMode', { username, enabled: enabled !== false });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set invisible for player
router.post('/players/:username/invisible', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  const { username } = req.params;
  const { enabled } = req.body;
  try {
    const result = await bridge.sendCommand('setInvisible', { username, enabled: enabled !== false });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ZOMBIE CONTROLS
// ============================================

// Get zombie statistics
router.get('/zombies/count', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  try {
    const result = await bridge.sendCommand('getZombieCount', {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear zombies near a player
router.post('/zombies/clear-near-player', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  const { username, radius = 50 } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'username is required' });
  }
  try {
    const result = await bridge.sendCommand('clearZombiesNearPlayer', { username, radius });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// VISUAL EFFECTS CONTROLS
// ============================================

// Set view distance
router.post('/visual/view-distance', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  const { value } = req.body;
  if (typeof value !== 'number') {
    return res.status(400).json({ error: 'value is required (number 0.0-1.0)' });
  }
  try {
    const result = await bridge.sendCommand('setViewDistance', { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set daylight level
router.post('/visual/daylight', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  const { value } = req.body;
  if (typeof value !== 'number') {
    return res.status(400).json({ error: 'value is required (0.0-1.0)' });
  }
  try {
    const result = await bridge.sendCommand('setDayLight', { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set night strength
router.post('/visual/night-strength', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  const { value } = req.body;
  if (typeof value !== 'number') {
    return res.status(400).json({ error: 'value is required (0.0-1.0)' });
  }
  try {
    const result = await bridge.sendCommand('setNightStrength', { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set desaturation (color wash)
router.post('/visual/desaturation', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  const { value } = req.body;
  if (typeof value !== 'number') {
    return res.status(400).json({ error: 'value is required (0.0-1.0)' });
  }
  try {
    const result = await bridge.sendCommand('setDesaturation', { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set ambient light
router.post('/visual/ambient', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  const { value } = req.body;
  if (typeof value !== 'number') {
    return res.status(400).json({ error: 'value is required (0.0-1.0)' });
  }
  try {
    const result = await bridge.sendCommand('setAmbient', { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CHAT CONTROLS
// ============================================

// Get chat info
router.get('/chat/info', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  try {
    const result = await bridge.sendCommand('getChatInfo', {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send to admin chat
router.post('/chat/admin', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }
  try {
    const result = await bridge.sendCommand('sendToAdminChat', { message });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send to general chat with author
router.post('/chat/general', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  const { message, author = 'Server' } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }
  try {
    const result = await bridge.sendCommand('sendToGeneralChat', { message, author });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send server alert
router.post('/chat/alert', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  const { message, alert = true } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }
  try {
    const result = await bridge.sendCommand('sendToServerChat', { message, alert });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DEBUG ENDPOINTS
// ============================================

// Get mod debug log
router.get('/debug/log', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  const limit = parseInt(req.query.limit) || 50;
  const minLevel = req.query.level || 'DEBUG';
  try {
    const result = await bridge.sendCommand('getDebugLog', { limit, minLevel });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get mod statistics
router.get('/debug/stats', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  try {
    const result = await bridge.sendCommand('getStats', {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set debug mode
router.post('/debug/mode', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  const { enabled } = req.body;
  try {
    const result = await bridge.sendCommand('setDebugMode', { enabled: enabled === true });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check API availability
router.get('/debug/api', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  const { object, method } = req.query;
  try {
    const result = await bridge.sendCommand('checkAPI', { object, method });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get available handlers
router.get('/debug/handlers', async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({ error: 'Bridge not running' });
  }
  try {
    const result = await bridge.sendCommand('getAvailableHandlers', {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
