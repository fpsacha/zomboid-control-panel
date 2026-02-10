import express from 'express';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import {
  getServers,
  getServer,
  getActiveServer,
  createServer,
  updateServer,
  deleteServer,
  setActiveServer
} from '../database/init.js';

const router = express.Router();

// Helper: Parse INI file
function parseIni(content) {
  const result = {};
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      result[key] = value;
    }
  }
  return result;
}

// Helper: Recursively scan for PZ server paths (max depth 3)
function scanForPzPaths(rootPath, maxDepth = 3) {
  const results = {
    installPaths: [],   // Folders containing StartServer64.bat
    dataPaths: [],      // Folders containing Server/ subfolder with .ini files
    customBatFiles: []  // Custom StartServer_*.bat files found
  };
  
  function scan(currentPath, depth) {
    if (depth > maxDepth) return;
    
    try {
      if (!fs.existsSync(currentPath) || !fs.statSync(currentPath).isDirectory()) return;
      
      const items = fs.readdirSync(currentPath);
      
      // Check if this is an install path (has StartServer64.bat or jre64)
      if (items.includes('StartServer64.bat') || items.includes('StartServer64_nosteam.bat') || 
          (items.includes('jre64') && items.includes('ProjectZomboid64.json'))) {
        results.installPaths.push(currentPath);
        
        // Also look for custom StartServer_*.bat files
        const customBats = items.filter(f => 
          f.startsWith('StartServer_') && f.endsWith('.bat') ||
          f.startsWith('StartServer64_') && f.endsWith('.bat') && f !== 'StartServer64_nosteam.bat'
        );
        for (const bat of customBats) {
          // Extract server name from bat file name (e.g., StartServer_DoomerZ.bat -> DoomerZ)
          let serverName = bat.replace(/^StartServer(64)?_/, '').replace('.bat', '');
          results.customBatFiles.push({
            path: path.join(currentPath, bat),
            folder: currentPath,
            fileName: bat,
            serverName: serverName
          });
        }
      }
      
      // Check if this is a data path (has Server/ subfolder with .ini files)
      if (items.includes('Server')) {
        const serverPath = path.join(currentPath, 'Server');
        if (fs.existsSync(serverPath) && fs.statSync(serverPath).isDirectory()) {
          const serverFiles = fs.readdirSync(serverPath);
          // Look for .ini files that don't end with known suffixes like _SandboxVars, _spawnpoints, _spawnregions
          const hasIni = serverFiles.some(f => f.endsWith('.ini') && 
            !f.endsWith('_SandboxVars.ini') && 
            !f.endsWith('_spawnpoints.ini') && 
            !f.endsWith('_spawnregions.ini'));
          if (hasIni) {
            results.dataPaths.push(currentPath);
          }
        }
      }
      
      // Recurse into subdirectories (skip common non-relevant folders)
      const skipFolders = ['node_modules', '.git', 'logs', 'Logs', 'cache', 'Saves', 'mods', 
                           'steamapps', 'depotcache', 'appcache', 'userdata', 'media'];
      for (const item of items) {
        if (skipFolders.includes(item)) continue;
        const itemPath = path.join(currentPath, item);
        try {
          if (fs.statSync(itemPath).isDirectory()) {
            scan(itemPath, depth + 1);
          }
        } catch {
          // Skip inaccessible folders
        }
      }
    } catch {
      // Skip inaccessible folders
    }
  }
  
  scan(rootPath, 0);
  return results;
}

// Auto-scan a folder to find PZ server install paths and data paths
router.post('/auto-scan', async (req, res) => {
  try {
    const { scanPath, maxDepth = 3 } = req.body;
    
    if (!scanPath) {
      return res.status(400).json({ error: 'Scan path is required' });
    }
    
    // Validate scanPath - resolve to absolute and check for path traversal
    const resolvedPath = path.resolve(scanPath);
    if (resolvedPath !== scanPath && !scanPath.startsWith('/') && !scanPath.match(/^[A-Za-z]:/)) {
      return res.status(400).json({ error: 'Invalid path format' });
    }
    
    if (!fs.existsSync(resolvedPath)) {
      return res.status(400).json({ error: 'Path does not exist' });
    }
    
    logger.info(`Auto-scanning for PZ servers in: ${resolvedPath}`);
    
    const results = scanForPzPaths(resolvedPath, Math.min(maxDepth, 5));
    
    // For each data path, detect the server configs
    const detectedConfigs = [];
    for (const dataPath of results.dataPaths) {
      const serverConfigPath = path.join(dataPath, 'Server');
      const files = fs.readdirSync(serverConfigPath);
      // Filter for server .ini files (exclude _SandboxVars, _spawnpoints, _spawnregions)
      const iniFiles = files.filter(f => f.endsWith('.ini') && 
        !f.endsWith('_SandboxVars.ini') && 
        !f.endsWith('_spawnpoints.ini') && 
        !f.endsWith('_spawnregions.ini'));
      
      for (const iniFile of iniFiles) {
        const serverName = iniFile.replace('.ini', '');
        const iniPath = path.join(serverConfigPath, iniFile);
        
        try {
          const content = fs.readFileSync(iniPath, 'utf-8');
          const settings = parseIni(content);
          
          // Try to find a matching custom bat file for this server
          const matchingBat = results.customBatFiles.find(bat => 
            serverName.toLowerCase().includes(bat.serverName.toLowerCase()) ||
            bat.serverName.toLowerCase().includes(serverName.toLowerCase())
          );
          
          detectedConfigs.push({
            dataPath,
            serverConfigPath,
            serverName,
            iniFile,
            rconPort: parseInt(settings.RCONPort, 10) || 27015,
            rconPassword: settings.RCONPassword || '',
            serverPort: parseInt(settings.DefaultPort, 10) || 16261,
            publicName: settings.PublicName || serverName,
            hasRcon: !!settings.RCONPassword,
            // New: matched bat file info
            matchedBatFile: matchingBat ? matchingBat.path : null,
            matchedInstallPath: matchingBat ? matchingBat.folder : null
          });
        } catch (err) {
          logger.warn(`Failed to parse ${iniFile}: ${err.message}`);
        }
      }
    }
    
    logger.info(`Found ${results.installPaths.length} install paths, ${results.dataPaths.length} data paths, ${detectedConfigs.length} server configs, ${results.customBatFiles.length} custom bat files`);
    
    res.json({
      scanPath,
      installPaths: results.installPaths,
      dataPaths: results.dataPaths,
      customBatFiles: results.customBatFiles,
      detectedConfigs
    });
    
  } catch (error) {
    logger.error(`Failed to auto-scan: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Detect server settings from data path (folder containing Server/, Saves/, Logs/)
router.post('/detect', async (req, res) => {
  try {
    const { dataPath, installPath } = req.body;
    
    if (!dataPath) {
      return res.status(400).json({ error: 'Data path is required' });
    }
    
    // Verify data path exists
    if (!fs.existsSync(dataPath)) {
      return res.status(400).json({ error: 'Data path does not exist' });
    }
    
    // Check if this is a valid Zomboid data folder (should have Server subfolder)
    const serverConfigPath = path.join(dataPath, 'Server');
    if (!fs.existsSync(serverConfigPath)) {
      return res.status(400).json({ error: 'Not a valid Zomboid data folder (no Server subfolder found)' });
    }
    
    // Check for install path if provided
    let hasNoSteam = false;
    let validInstallPath = false;
    if (installPath && fs.existsSync(installPath)) {
      const startBat = path.join(installPath, 'StartServer64.bat');
      const startBatNoSteam = path.join(installPath, 'StartServer64_nosteam.bat');
      validInstallPath = fs.existsSync(startBat) || fs.existsSync(startBatNoSteam);
      hasNoSteam = fs.existsSync(startBatNoSteam);
    }
    
    // Find server INI files
    const detectedServers = [];
    
    if (fs.existsSync(serverConfigPath)) {
      const files = fs.readdirSync(serverConfigPath);
      // Filter for server .ini files (exclude _SandboxVars, _spawnpoints, _spawnregions)
      const iniFiles = files.filter(f => f.endsWith('.ini') && 
        !f.endsWith('_SandboxVars.ini') && 
        !f.endsWith('_spawnpoints.ini') && 
        !f.endsWith('_spawnregions.ini'));
      
      for (const iniFile of iniFiles) {
        const serverName = iniFile.replace('.ini', '');
        const iniPath = path.join(serverConfigPath, iniFile);
        
        try {
          const content = fs.readFileSync(iniPath, 'utf-8');
          const settings = parseIni(content);
          
          detectedServers.push({
            serverName,
            iniFile,
            rconPort: parseInt(settings.RCONPort, 10) || 27015,
            rconPassword: settings.RCONPassword || '',
            serverPort: parseInt(settings.DefaultPort, 10) || 16261,
            publicName: settings.PublicName || serverName,
            hasRcon: !!settings.RCONPassword
          });
        } catch (err) {
          logger.warn(`Failed to parse ${iniFile}: ${err.message}`);
        }
      }
    }
    
    res.json({
      valid: true,
      dataPath,
      serverConfigPath,
      installPath: installPath || '',
      validInstallPath,
      hasNoSteam,
      detectedServers
    });
    
  } catch (error) {
    logger.error(`Failed to detect server: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get all servers
router.get('/', async (req, res) => {
  try {
    const servers = await getServers();
    res.json({ servers });
  } catch (error) {
    logger.error(`Failed to get servers: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get active server
router.get('/active', async (req, res) => {
  try {
    const server = await getActiveServer();
    if (!server) {
      return res.status(404).json({ error: 'No active server configured' });
    }
    res.json({ server });
  } catch (error) {
    logger.error(`Failed to get active server: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get a specific server
router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: 'Invalid server ID' });
    }
    // Check if ID looks like a UUID (contains dashes or letters beyond valid decimal digits)
    const isUUID = /[a-f-]/i.test(id);
    const serverId = isUUID ? id : parseInt(id, 10);
    
    const server = await getServer(serverId);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }
    
    res.json({ server });
  } catch (error) {
    logger.error(`Failed to get server: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Create a new server
router.post('/', async (req, res) => {
  try {
    const config = req.body;
    
    // Validate required fields - installPath not required for remote servers
    const isRemote = !!config.isRemote;
    const requiredFields = isRemote 
      ? ['name', 'rconHost', 'rconPort', 'rconPassword']
      : ['name', 'installPath', 'rconHost', 'rconPort', 'rconPassword'];
    for (const field of requiredFields) {
      if (!config[field]) {
        return res.status(400).json({ error: `Missing required field: ${field}` });
      }
    }
    
    // Validate RCON port
    const rconPort = parseInt(config.rconPort, 10);
    if (isNaN(rconPort) || rconPort < 1 || rconPort > 65535) {
      return res.status(400).json({ error: 'Invalid RCON port' });
    }
    
    // Validate serverName against path traversal
    const serverName = config.serverName || 'servertest';
    if (!/^[a-zA-Z0-9_-]+$/.test(serverName)) {
      return res.status(400).json({ error: 'Invalid server name: only letters, numbers, underscores and hyphens allowed' });
    }
    
    // Validate server port if provided
    if (config.serverPort) {
      const serverPort = parseInt(config.serverPort, 10);
      if (isNaN(serverPort) || serverPort < 1 || serverPort > 65535) {
        return res.status(400).json({ error: 'Invalid server port' });
      }
    }
    
    const server = await createServer({
      name: config.name,
      serverName: config.serverName || 'servertest',
      installPath: config.installPath || '',
      zomboidDataPath: config.zomboidDataPath || null,
      serverConfigPath: config.serverConfigPath || null,
      branch: config.branch || 'stable',
      rconHost: config.rconHost,
      rconPort: rconPort,
      rconPassword: config.rconPassword,
      serverPort: parseInt(config.serverPort, 10) || 16261,
      minMemory: parseInt(config.minMemory, 10) || 2048,
      maxMemory: parseInt(config.maxMemory, 10) || 4096,
      useNoSteam: !!config.useNoSteam,
      useDebug: !!config.useDebug,
      isRemote: isRemote
    });
    
    logger.info(`Created new server: ${server.name} (ID: ${server.id})`);
    res.status(201).json({ server, message: 'Server created successfully' });
  } catch (error) {
    logger.error(`Failed to create server: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Update a server
router.put('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: 'Invalid server ID' });
    }
    // Check if ID looks like a UUID (contains dashes or letters beyond valid decimal digits)
    const isUUID = /[a-f-]/i.test(id);
    const serverId = isUUID ? id : parseInt(id, 10);
    
    const updates = req.body;
    
    // Validate RCON port if provided
    if (updates.rconPort !== undefined) {
      const rconPort = parseInt(updates.rconPort, 10);
      if (isNaN(rconPort) || rconPort < 1 || rconPort > 65535) {
        return res.status(400).json({ error: 'Invalid RCON port' });
      }
      updates.rconPort = rconPort;
    }
    
    // Validate server port if provided
    if (updates.serverPort !== undefined) {
      const serverPort = parseInt(updates.serverPort, 10);
      if (isNaN(serverPort) || serverPort < 1 || serverPort > 65535) {
        return res.status(400).json({ error: 'Invalid server port' });
      }
      updates.serverPort = serverPort;
    }
    
    // Parse numeric fields
    if (updates.minMemory !== undefined) {
      updates.minMemory = parseInt(updates.minMemory, 10) || 2048;
    }
    if (updates.maxMemory !== undefined) {
      updates.maxMemory = parseInt(updates.maxMemory, 10) || 4096;
    }
    
    // Parse boolean fields
    if (updates.useNoSteam !== undefined) {
      updates.useNoSteam = !!updates.useNoSteam;
    }
    if (updates.useDebug !== undefined) {
      updates.useDebug = !!updates.useDebug;
    }
    
    const server = await updateServer(serverId, updates);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }
    
    logger.info(`Updated server: ${server.name} (ID: ${server.id})`);
    res.json({ server, message: 'Server updated successfully' });
  } catch (error) {
    logger.error(`Failed to update server: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Delete a server
router.delete('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: 'Invalid server ID' });
    }
    // Check if ID looks like a UUID (contains dashes or letters beyond valid decimal digits)
    const isUUID = /[a-f-]/i.test(id);
    const serverId = isUUID ? id : parseInt(id, 10);
    
    const success = await deleteServer(serverId);
    if (!success) {
      return res.status(404).json({ error: 'Server not found' });
    }
    
    logger.info(`Deleted server ID: ${serverId}`);
    res.json({ success: true, message: 'Server deleted successfully' });
  } catch (error) {
    logger.error(`Failed to delete server: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Set active server
router.post('/:id/activate', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: 'Invalid server ID' });
    }
    // Check if ID looks like a UUID (contains dashes or letters beyond valid decimal digits)
    const isUUID = /[a-f-]/i.test(id);
    const serverId = isUUID ? id : parseInt(id, 10);
    
    const server = await setActiveServer(serverId);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }
    
    // Notify services about the active server change
    const rconService = req.app.get('rconService');
    const serverManager = req.app.get('serverManager');
    const io = req.app.get('io');
    
    // Reload ServerManager config for new active server
    if (serverManager && serverManager.reloadConfig) {
      await serverManager.reloadConfig();
      logger.info(`ServerManager reloaded config for server: ${server.name}`);
    }
    
    // Disconnect current RCON if connected
    if (rconService && rconService.isConnected()) {
      await rconService.disconnect();
    }
    
    // Reload RCON config and reconnect with new server's settings
    if (rconService && server.rconPassword) {
      try {
        await rconService.reloadConfig();
        await rconService.connect();
        logger.info(`RCON reconnected for server: ${server.name}`);
      } catch (rconErr) {
        logger.warn(`Failed to connect RCON for new server: ${rconErr.message}`);
      }
    }
    
    // Emit to clients that active server changed
    if (io) {
      io.emit('activeServerChanged', { server });
    }
    
    logger.info(`Activated server: ${server.name} (ID: ${server.id})`);
    res.json({ server, message: `Now managing: ${server.name}` });
  } catch (error) {
    logger.error(`Failed to activate server: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;
