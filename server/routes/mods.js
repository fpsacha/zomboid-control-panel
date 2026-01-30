import express from 'express';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import { getTrackedMods, addTrackedMod, removeTrackedMod, clearModUpdates, getSetting, getActiveServer, getModPresets, createModPreset, updateModPreset, deleteModPreset } from '../database/init.js';

const router = express.Router();

// Helper functions for multi-server support
async function getServerConfigPath() {
  const activeServer = await getActiveServer();
  
  // First, use explicitly configured serverConfigPath if available
  if (activeServer?.serverConfigPath) {
    return activeServer.serverConfigPath;
  }
  
  // Fallback to zomboidDataPath + Server (like serverFiles.js does)
  if (activeServer?.zomboidDataPath) {
    return path.join(activeServer.zomboidDataPath, 'Server');
  }
  
  // Fallback to legacy settings
  const legacyPath = await getSetting('serverConfigPath');
  if (legacyPath) return legacyPath;
  
  const legacyZomboidPath = await getSetting('zomboidDataPath');
  if (legacyZomboidPath) {
    return path.join(legacyZomboidPath, 'Server');
  }
  
  return null;
}

async function getServerName() {
  const activeServer = await getActiveServer();
  if (activeServer?.serverName) {
    return activeServer.serverName;
  }
  const legacyName = await getSetting('serverName');
  return legacyName || 'servertest';
}

async function getServerPath() {
  const activeServer = await getActiveServer();
  if (activeServer?.installPath) {
    return activeServer.installPath;
  }
  const legacyPath = await getSetting('serverPath');
  return legacyPath || null;
}

// Helper to get modChecker with null check
function getModChecker(req, res) {
  const modChecker = req.app.get('modChecker');
  if (!modChecker) {
    res.status(500).json({ error: 'Mod checker not initialized' });
    return null;
  }
  return modChecker;
}

// Get mod checker status
router.get('/status', async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;
    
    const status = await modChecker.getStatus();
    res.json(status);
  } catch (error) {
    logger.error(`Failed to get mod checker status: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get all tracked mods
router.get('/tracked', async (req, res) => {
  try {
    const mods = await getTrackedMods();
    res.json({ mods });
  } catch (error) {
    logger.error(`Failed to get tracked mods: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Add a mod to track
router.post('/track', async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;
    
    const { workshopId } = req.body;
    
    if (!workshopId) {
      return res.status(400).json({ error: 'Workshop ID is required' });
    }
    
    // Validate workshopId is a string or number
    if (typeof workshopId !== 'string' && typeof workshopId !== 'number') {
      return res.status(400).json({ error: 'Workshop ID must be a string or number' });
    }
    
    const result = await modChecker.addModToTrack(String(workshopId));
    res.json(result);
  } catch (error) {
    logger.error(`Failed to add mod to track: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Remove a mod from tracking
router.delete('/track/:workshopId', async (req, res) => {
  try {
    const { workshopId } = req.params;
    
    // Validate workshopId is a numeric string
    if (!workshopId || !/^\d+$/.test(workshopId)) {
      return res.status(400).json({ error: 'Invalid workshop ID' });
    }
    
    await removeTrackedMod(workshopId);
    res.json({ success: true, message: 'Mod removed from tracking' });
  } catch (error) {
    logger.error(`Failed to remove tracked mod: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Manually check for mod updates
router.post('/check-updates', async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;
    
    const result = await modChecker.checkForUpdates();
    res.json(result);
  } catch (error) {
    logger.error(`Failed to check for updates: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get mod list from server config
router.get('/server-mods', async (req, res) => {
  try {
    const serverManager = req.app.get('serverManager');
    const mods = await serverManager.getModList();
    res.json({ mods });
  } catch (error) {
    logger.error(`Failed to get server mods: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Check mods via RCON
router.get('/check-rcon', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const result = await rconService.checkModsNeedUpdate();
    res.json(result);
  } catch (error) {
    logger.error(`Failed to check mods via RCON: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Start mod checker
router.post('/start', async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;
    
    modChecker.start();
    res.json({ success: true, message: 'Mod checker started' });
  } catch (error) {
    logger.error(`Failed to start mod checker: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Stop mod checker
router.post('/stop', async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;
    
    modChecker.stop();
    res.json({ success: true, message: 'Mod checker stopped' });
  } catch (error) {
    logger.error(`Failed to stop mod checker: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Set check interval
router.put('/interval', async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;
    
    const { intervalMs } = req.body;
    
    if (!intervalMs || intervalMs < 60000) {
      return res.status(400).json({ error: 'Interval must be at least 60000ms (1 minute)' });
    }
    
    modChecker.setCheckInterval(intervalMs);
    res.json({ success: true, message: `Check interval set to ${intervalMs}ms` });
  } catch (error) {
    logger.error(`Failed to set check interval: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Enable auto-restart on mod update
router.post('/auto-restart', async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;
    
    const { enabled } = req.body;
    
    if (enabled) {
      await modChecker.setUpdateCallback(async (updatedMods) => {
        await modChecker.handleModUpdate(updatedMods);
      });
    } else {
      await modChecker.setUpdateCallback(null);
    }
    
    res.json({ success: true, autoRestart: enabled });
  } catch (error) {
    logger.error(`Failed to configure auto-restart: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Configure restart options
router.put('/restart-options', async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;
    
    const { warningMinutes, delayIfPlayersOnline, maxDelayMinutes, checkInterval } = req.body;
    
    await modChecker.setRestartOptions({
      warningMinutes,
      delayIfPlayersOnline,
      maxDelayMinutes,
      checkInterval
    });
    
    const status = await modChecker.getStatus();
    res.json({ 
      success: true, 
      options: {
        warningMinutes: status.restartWarningMinutes,
        delayIfPlayersOnline: status.delayIfPlayersOnline,
        maxDelayMinutes: status.maxDelayMinutes,
        checkInterval: status.checkInterval
      }
    });
  } catch (error) {
    logger.error(`Failed to set restart options: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get workshop ACF status (Steam API key no longer needed - using local ACF file)
router.get('/workshop-status', async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;
    
    const status = await modChecker.getStatus();
    
    res.json({ 
      success: true, 
      configured: status.workshopAcfConfigured,
      workshopAcfPath: status.workshopAcfPath,
      message: status.workshopAcfConfigured 
        ? 'Workshop ACF file found - mod updates can be detected automatically' 
        : 'Workshop ACF file not found - ensure server install path is correct'
    });
  } catch (error) {
    logger.error(`Failed to get workshop status: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Cancel pending restart (if waiting for players)
router.post('/cancel-pending-restart', async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;
    
    if (!modChecker.pendingRestart) {
      return res.json({ success: false, message: 'No pending restart to cancel' });
    }
    
    modChecker.cancelPendingRestart();
    res.json({ success: true, message: 'Pending restart cancelled' });
  } catch (error) {
    logger.error(`Failed to cancel pending restart: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Sync mods from server config
router.post('/sync-from-server', async (req, res) => {
  try {
    // Use direct INI reading (more reliable than serverManager which has path issues)
    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    
    if (!serverConfigPath) {
      logger.warn('sync-from-server: Server config path not set');
      return res.json({ 
        success: false, 
        message: 'Server config path not set. Please configure the server first.',
        synced: 0 
      });
    }
    
    // Sanitize serverName
    const sanitizedServerName = path.basename(serverName);
    if (!sanitizedServerName || sanitizedServerName !== serverName || serverName.includes('..')) {
      return res.status(400).json({ error: 'Invalid server name' });
    }
    
    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    logger.info(`sync-from-server: Looking for config at ${iniPath}`);
    
    if (!fs.existsSync(iniPath)) {
      logger.warn(`sync-from-server: Config file not found at ${iniPath}`);
      return res.json({ 
        success: false, 
        message: `Server config not found at ${iniPath}. Start the server once first.`,
        synced: 0 
      });
    }
    
    // Read and parse the INI file
    const content = fs.readFileSync(iniPath, 'utf-8');
    const modsMatch = content.match(/^Mods=(.*)$/m);
    const workshopMatch = content.match(/^WorkshopItems=(.*)$/m);
    
    const modIds = modsMatch?.[1]?.split(';').filter(Boolean) || [];
    const workshopIds = workshopMatch?.[1]?.split(';').filter(Boolean) || [];
    
    logger.info(`sync-from-server: Found ${modIds.length} mod IDs and ${workshopIds.length} workshop IDs`);
    
    if (workshopIds.length === 0) {
      return res.json({ 
        success: true, 
        message: 'No mods found in server configuration (WorkshopItems is empty)',
        synced: 0 
      });
    }
    
    // Add each workshop ID to tracking
    let synced = 0;
    for (let i = 0; i < workshopIds.length; i++) {
      try {
        const workshopId = workshopIds[i];
        const modName = modIds[i] || `Workshop Mod ${workshopId}`;
        await addTrackedMod(workshopId, modName);
        synced++;
      } catch (e) {
        logger.warn(`Failed to sync mod ${workshopIds[i]}: ${e.message}`);
      }
    }
    
    res.json({ 
      success: true, 
      message: `Synced ${synced} mods from server config`,
      synced,
      iniPath
    });
  } catch (error) {
    logger.error(`Failed to sync mods from server: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Clear all update flags
router.post('/clear-updates', async (req, res) => {
  try {
    await clearModUpdates();
    res.json({ success: true, message: 'Update flags cleared' });
  } catch (error) {
    logger.error(`Failed to clear mod updates: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get Steam Workshop collection details (extract all mods from a collection)
router.post('/import-collection', async (req, res) => {
  try {
    const { collectionUrl } = req.body;
    
    if (!collectionUrl) {
      return res.status(400).json({ error: 'Collection URL or ID is required' });
    }
    
    // Extract collection ID from URL or use directly
    let collectionId = collectionUrl;
    const urlMatch = collectionUrl.match(/id=(\d+)/);
    if (urlMatch) {
      collectionId = urlMatch[1];
    }
    
    // Validate it's a number
    if (!/^\d+$/.test(collectionId)) {
      return res.status(400).json({ error: 'Invalid collection ID' });
    }
    
    logger.info(`Fetching collection details for ID: ${collectionId}`);
    
    // Use Steam API to get collection details
    const collectionResponse = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetCollectionDetails/v1/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        'collectioncount': '1',
        'publishedfileids[0]': collectionId
      })
    });
    
    if (!collectionResponse.ok) {
      throw new Error(`Steam API returned ${collectionResponse.status}`);
    }
    
    const collectionData = await collectionResponse.json();
    
    if (!collectionData.response?.collectiondetails?.[0]) {
      return res.status(404).json({ error: 'Collection not found' });
    }
    
    const collection = collectionData.response.collectiondetails[0];
    
    if (collection.result !== 1) {
      return res.status(404).json({ error: 'Collection not found or is private' });
    }
    
    const modIds = collection.children?.map(c => c.publishedfileid) || [];
    
    if (modIds.length === 0) {
      return res.json({ 
        success: true, 
        message: 'Collection is empty',
        mods: [] 
      });
    }
    
    // Now get details for each mod in the collection
    const modFormData = new URLSearchParams();
    modFormData.append('itemcount', modIds.length.toString());
    modIds.forEach((id, index) => {
      modFormData.append(`publishedfileids[${index}]`, id);
    });
    
    const modsResponse = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: modFormData
    });
    
    if (!modsResponse.ok) {
      throw new Error(`Steam API returned ${modsResponse.status}`);
    }
    
    const modsData = await modsResponse.json();
    
    const mods = (modsData.response?.publishedfiledetails || [])
      .filter(m => m.result === 1)
      .map(m => ({
        workshopId: m.publishedfileid,
        name: m.title,
        description: m.description?.substring(0, 200),
        tags: m.tags?.map(t => t.tag) || [],
        isMap: m.tags?.some(t => t.tag?.toLowerCase() === 'map' || t.tag?.toLowerCase() === 'maps') || false
      }));
    
    logger.info(`Found ${mods.length} mods in collection ${collectionId}`);
    
    res.json({
      success: true,
      collectionId,
      totalMods: mods.length,
      mods
    });
  } catch (error) {
    logger.error(`Failed to import collection: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get mod info from Steam Workshop (for a single mod)
router.post('/get-mod-info', async (req, res) => {
  try {
    const { workshopId } = req.body;
    
    if (!workshopId) {
      return res.status(400).json({ error: 'Workshop ID is required' });
    }
    
    const response = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        'itemcount': '1',
        'publishedfileids[0]': workshopId
      })
    });
    
    if (!response.ok) {
      throw new Error(`Steam API returned ${response.status}`);
    }
    
    const data = await response.json();
    const modInfo = data.response?.publishedfiledetails?.[0];
    
    if (!modInfo || modInfo.result !== 1) {
      return res.status(404).json({ error: 'Mod not found' });
    }
    
    res.json({
      workshopId: modInfo.publishedfileid,
      name: modInfo.title,
      description: modInfo.description?.substring(0, 500),
      tags: modInfo.tags?.map(t => t.tag) || [],
      isMap: modInfo.tags?.some(t => t.tag?.toLowerCase() === 'map' || t.tag?.toLowerCase() === 'maps') || false,
      timeUpdated: modInfo.time_updated,
      timeCreated: modInfo.time_created
    });
  } catch (error) {
    logger.error(`Failed to get mod info: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Write mods to server .ini file
router.post('/write-to-ini', async (req, res) => {
  try {
    const { mods, mapFolders } = req.body;
    // mods: array of { workshopId, modId } where modId is the mod loading ID (from info.txt)
    // mapFolders: optional array of map folder names for map mods
    
    if (!mods || !Array.isArray(mods)) {
      return res.status(400).json({ error: 'Mods array is required' });
    }
    
    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    const serverPath = await getServerPath();
    
    if (!serverConfigPath) {
      return res.status(400).json({ error: 'Server config path not set. Please configure the server first.' });
    }
    
    // Sanitize serverName to prevent path traversal
    const sanitizedServerName = path.basename(serverName);
    if (!sanitizedServerName || sanitizedServerName !== serverName || serverName.includes('..')) {
      return res.status(400).json({ error: 'Invalid server name' });
    }
    
    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({ 
        error: `Server config not found at ${iniPath}. Start the server once first to generate the config file.` 
      });
    }
    
    // Build the mod strings, auto-detecting mod IDs where possible
    // Mods= is semicolon-separated list of mod IDs (from mod's info.txt id= field)
    // WorkshopItems= is semicolon-separated list of Workshop IDs
    const resolvedMods = [];
    let autoDetectedCount = 0;
    
    for (const m of mods) {
      let modId = m.modId;
      const workshopIdStr = String(m.workshopId);
      
      // If modId looks like a workshop ID (all numeric), try to auto-detect the real mod ID
      if (modId && /^\d+$/.test(modId)) {
        // First try local files
        if (serverPath) {
          const detectedId = findModIdFromWorkshop(modId, serverPath);
          if (detectedId) {
            modId = detectedId;
            autoDetectedCount++;
            logger.info(`Auto-detected mod ID from local files: ${detectedId} for workshop ${m.workshopId}`);
          }
        }
        // If still numeric, try fetching from Steam Workshop page
        if (/^\d+$/.test(modId)) {
          const steamModId = await fetchModIdFromWorkshop(workshopIdStr);
          if (steamModId) {
            modId = steamModId;
            autoDetectedCount++;
            logger.info(`Auto-detected mod ID from Steam Workshop: ${steamModId} for workshop ${m.workshopId}`);
          }
        }
      }
      // Also try if no modId at all
      else if (!modId) {
        // First try local files
        if (serverPath) {
          const detectedId = findModIdFromWorkshop(workshopIdStr, serverPath);
          if (detectedId) {
            modId = detectedId;
            autoDetectedCount++;
            logger.info(`Auto-detected mod ID from local files: ${detectedId} for workshop ${m.workshopId}`);
          }
        }
        // If still no modId, try fetching from Steam Workshop page
        if (!modId) {
          const steamModId = await fetchModIdFromWorkshop(workshopIdStr);
          if (steamModId) {
            modId = steamModId;
            autoDetectedCount++;
            logger.info(`Auto-detected mod ID from Steam Workshop: ${steamModId} for workshop ${m.workshopId}`);
          }
        }
      }
      
      resolvedMods.push({
        workshopId: m.workshopId,
        modId: modId || null
      });
    }
    
    const modIdList = resolvedMods.map(m => m.modId).filter(Boolean).join(';');
    const workshopIdList = resolvedMods.map(m => m.workshopId).filter(Boolean).join(';');
    
    // Auto-detect map folders from downloaded workshop mods if not provided
    let detectedMapFolders = mapFolders || [];
    if (serverPath && (!mapFolders || mapFolders.length === 0)) {
      for (const m of mods) {
        const workshopIdStr = String(m.workshopId);
        const modMapFolders = findMapFoldersFromWorkshop(workshopIdStr, serverPath);
        for (const folder of modMapFolders) {
          if (!detectedMapFolders.includes(folder)) {
            detectedMapFolders.push(folder);
            logger.info(`Auto-detected map folder: ${folder} from workshop ${workshopIdStr}`);
          }
        }
      }
    }
    
    // Build Map= string - mod maps must come BEFORE the main map
    // Format: "ModMap1;ModMap2;Muldraugh, KY"
    let mapList = 'Muldraugh, KY';
    if (detectedMapFolders && detectedMapFolders.length > 0) {
      mapList = `${detectedMapFolders.join(';')};Muldraugh, KY`;
    }
    
    // Read and update the ini file
    let content = fs.readFileSync(iniPath, 'utf-8');
    
    // Update or add Mods=
    if (content.includes('Mods=')) {
      content = content.replace(/^Mods=.*/m, `Mods=${modIdList}`);
    } else {
      content += `\nMods=${modIdList}`;
    }
    
    // Update or add WorkshopItems=
    if (content.includes('WorkshopItems=')) {
      content = content.replace(/^WorkshopItems=.*/m, `WorkshopItems=${workshopIdList}`);
    } else {
      content += `\nWorkshopItems=${workshopIdList}`;
    }
    
    // Update or add Map= (only if we have custom maps)
    if (detectedMapFolders && detectedMapFolders.length > 0) {
      if (content.includes('Map=')) {
        content = content.replace(/^Map=.*/m, `Map=${mapList}`);
      } else {
        content += `\nMap=${mapList}`;
      }
    }
    
    fs.writeFileSync(iniPath, content, 'utf-8');
    
    logger.info(`Wrote ${mods.length} mods to ${iniPath} (${autoDetectedCount} mod IDs auto-detected, ${detectedMapFolders.length} map folders)`);
    
    res.json({
      success: true,
      message: `Successfully configured ${mods.length} mods in server config.${autoDetectedCount > 0 ? ` (${autoDetectedCount} mod IDs auto-detected)` : ''}${detectedMapFolders.length > 0 ? ` Map folders: ${detectedMapFolders.join(', ')}` : ''}`,
      iniPath,
      modsConfigured: mods.length,
      autoDetectedModIds: autoDetectedCount,
      modIds: modIdList,
      workshopItems: workshopIdList,
      mapList,
      mapFolders: detectedMapFolders
    });
  } catch (error) {
    logger.error(`Failed to write mods to ini: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get current mod configuration from .ini file
router.get('/current-config', async (req, res) => {
  try {
    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    
    if (!serverConfigPath) {
      return res.json({ 
        configured: false,
        error: 'Server config path not set' 
      });
    }
    
    // Sanitize serverName to prevent path traversal
    const sanitizedServerName = path.basename(serverName);
    if (!sanitizedServerName || sanitizedServerName !== serverName || serverName.includes('..')) {
      return res.status(400).json({ error: 'Invalid server name' });
    }
    
    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    
    if (!fs.existsSync(iniPath)) {
      return res.json({ 
        configured: false,
        error: 'Server config file not found' 
      });
    }
    
    const content = fs.readFileSync(iniPath, 'utf-8');
    
    // Extract mod-related settings
    const modsMatch = content.match(/^Mods=(.*)$/m);
    const workshopMatch = content.match(/^WorkshopItems=(.*)$/m);
    const mapMatch = content.match(/^Map=(.*)$/m);
    
    const modIds = modsMatch?.[1]?.split(';').filter(Boolean) || [];
    const workshopIds = workshopMatch?.[1]?.split(';').filter(Boolean) || [];
    const maps = mapMatch?.[1]?.split(';').filter(Boolean) || ['Muldraugh, KY'];
    
    res.json({
      configured: true,
      modIds,
      workshopIds,
      maps,
      totalMods: modIds.length,
      iniPath
    });
  } catch (error) {
    logger.error(`Failed to get current mod config: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Add a single mod to server .ini file (appends to existing mods)
router.post('/add-to-ini', async (req, res) => {
  try {
    const { workshopId, modId } = req.body;
    // workshopId: the Steam Workshop ID
    // modId: optional - the mod loading ID (from info.txt). If not provided, workshopId is used as a placeholder
    
    if (!workshopId) {
      return res.status(400).json({ error: 'Workshop ID is required' });
    }
    
    // Validate workshopId is numeric
    if (!/^\d+$/.test(String(workshopId))) {
      return res.status(400).json({ error: 'Invalid Workshop ID' });
    }
    
    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    
    if (!serverConfigPath) {
      return res.status(400).json({ error: 'Server config path not set. Please configure the server first in Settings.' });
    }
    
    // Sanitize serverName to prevent path traversal
    const sanitizedServerName = path.basename(serverName);
    if (!sanitizedServerName || sanitizedServerName !== serverName || serverName.includes('..')) {
      return res.status(400).json({ error: 'Invalid server name' });
    }
    
    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({ 
        error: `Server config not found at ${iniPath}. Start the server once first to generate the config file.` 
      });
    }
    
    // Read current config
    let content = fs.readFileSync(iniPath, 'utf-8');
    
    // Get current workshop items
    const workshopMatch = content.match(/^WorkshopItems=(.*)$/m);
    const currentWorkshopIds = workshopMatch?.[1]?.split(';').filter(Boolean) || [];
    
    // Get current mod IDs
    const modsMatch = content.match(/^Mods=(.*)$/m);
    const currentModIds = modsMatch?.[1]?.split(';').filter(Boolean) || [];
    
    // Check if mod is already in the list
    if (currentWorkshopIds.includes(String(workshopId))) {
      return res.json({
        success: true,
        message: 'Mod is already configured in the server',
        alreadyExists: true
      });
    }
    
    // Try to auto-detect mod ID if not provided
    let detectedModId = modId;
    let detectionSource = 'provided';
    
    if (!detectedModId) {
      // First, try to find from already downloaded workshop folder
      const serverPath = await getServerPath();
      if (serverPath) {
        detectedModId = findModIdFromWorkshop(String(workshopId), serverPath);
        if (detectedModId) {
          detectionSource = 'local-files';
          logger.info(`Auto-detected mod ID from local files: ${detectedModId} for workshop ${workshopId}`);
        }
      }
      
      // If not found locally, try to fetch from Steam Workshop page description
      if (!detectedModId) {
        detectedModId = await fetchModIdFromWorkshop(String(workshopId));
        if (detectedModId) {
          detectionSource = 'steam-workshop';
          logger.info(`Auto-detected mod ID from Steam Workshop: ${detectedModId} for workshop ${workshopId}`);
        }
      }
    }
    
    // Add the new workshop ID
    currentWorkshopIds.push(String(workshopId));
    const newWorkshopList = currentWorkshopIds.join(';');
    
    // Add the mod ID if we have one (provided or detected)
    if (detectedModId) {
      currentModIds.push(detectedModId);
    }
    const newModList = currentModIds.join(';');
    
    // Update WorkshopItems=
    if (content.includes('WorkshopItems=')) {
      content = content.replace(/^WorkshopItems=.*/m, `WorkshopItems=${newWorkshopList}`);
    } else {
      content += `\nWorkshopItems=${newWorkshopList}`;
    }
    
    // Update Mods= if we have a modId
    if (detectedModId) {
      if (content.includes('Mods=')) {
        content = content.replace(/^Mods=.*/m, `Mods=${newModList}`);
      } else {
        content += `\nMods=${newModList}`;
      }
    }
    
    // Check if this mod has map folders and add them to Map=
    let addedMapFolders = [];
    const serverPath = await getServerPath();
    if (serverPath) {
      const modMapFolders = findMapFoldersFromWorkshop(String(workshopId), serverPath);
      if (modMapFolders.length > 0) {
        // Get current map list
        const mapMatch = content.match(/^Map=(.*)$/m);
        let currentMaps = mapMatch?.[1]?.split(';').filter(Boolean) || ['Muldraugh, KY'];
        
        // Add new map folders (before the main map - map mods must come first)
        for (const folder of modMapFolders) {
          if (!currentMaps.includes(folder)) {
            // Insert at the beginning (before main map)
            currentMaps.unshift(folder);
            addedMapFolders.push(folder);
            logger.info(`Added map folder: ${folder} for workshop ${workshopId}`);
          }
        }
        
        // Update Map= in the ini file
        const newMapList = currentMaps.join(';');
        if (content.includes('Map=')) {
          content = content.replace(/^Map=.*/m, `Map=${newMapList}`);
        } else {
          content += `\nMap=${newMapList}`;
        }
      }
    }
    
    fs.writeFileSync(iniPath, content, 'utf-8');
    
    logger.info(`Added mod ${workshopId} to ${iniPath}${addedMapFolders.length > 0 ? ` with map folders: ${addedMapFolders.join(', ')}` : ''}`);
    
    res.json({
      success: true,
      message: detectedModId 
        ? `Mod added to server configuration${addedMapFolders.length > 0 ? ` with map folders: ${addedMapFolders.join(', ')}` : ''}` 
        : 'Workshop ID added (mod will be downloaded on server start)',
      workshopId,
      modId: detectedModId || null,
      autoDetected: !modId && !!detectedModId,
      detectionSource: detectedModId ? detectionSource : null,
      totalWorkshopItems: currentWorkshopIds.length,
      mapFoldersAdded: addedMapFolders,
      note: detectedModId ? undefined : 'Mod ID could not be auto-detected. You may need to add it manually or use "Sync Mod IDs" after the mod is downloaded.'
    });
  } catch (error) {
    logger.error(`Failed to add mod to ini: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to fetch mod ID from Steam Workshop page description
async function fetchModIdFromWorkshop(workshopId) {
  try {
    // First, get the mod description from Steam API
    const response = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        'itemcount': '1',
        'publishedfileids[0]': workshopId
      })
    });
    
    if (!response.ok) {
      logger.warn(`Steam API returned ${response.status} for workshop ${workshopId}`);
      return null;
    }
    
    const data = await response.json();
    const modInfo = data.response?.publishedfiledetails?.[0];
    
    if (!modInfo || modInfo.result !== 1) {
      logger.warn(`Mod not found for workshop ${workshopId}`);
      return null;
    }
    
    const description = modInfo.description || '';
    const title = modInfo.title || '';
    
    // Try various patterns to find the mod ID in the description
    // Pattern 1: "Mod ID: SomeName" or "ModID: SomeName"
    let match = description.match(/Mod\s*ID\s*[:=]\s*([^\s\n\r\[\]<>]+)/i);
    if (match) {
      logger.info(`Found Mod ID from "Mod ID:" pattern: ${match[1]}`);
      return match[1].trim();
    }
    
    // Pattern 2: "id=SomeName" (common in description)
    match = description.match(/\bid\s*=\s*([^\s\n\r\[\]<>]+)/i);
    if (match) {
      logger.info(`Found Mod ID from "id=" pattern: ${match[1]}`);
      return match[1].trim();
    }
    
    // Pattern 3: Workshop ID matches a pattern like "Mod: ModName"
    match = description.match(/\bMod\s*:\s*([A-Za-z0-9_-]+)/i);
    if (match && match[1].length > 3) {
      logger.info(`Found Mod ID from "Mod:" pattern: ${match[1]}`);
      return match[1].trim();
    }
    
    // Pattern 4: Look for [code] blocks that might contain mod.info content
    match = description.match(/\[code\][^]*?id\s*=\s*([^\s\n\r\[\]]+)[^]*?\[\/code\]/i);
    if (match) {
      logger.info(`Found Mod ID from [code] block: ${match[1]}`);
      return match[1].trim();
    }
    
    // Pattern 5: Title-based fallback - extract likely mod ID from title
    // e.g., "Clean UI B42" -> "CleanUIB42" or "Arsenal(26) GunFighter" -> try to find in desc
    
    logger.warn(`Could not extract Mod ID from workshop ${workshopId} description`);
    return null;
  } catch (error) {
    logger.error(`Error fetching mod ID from workshop ${workshopId}: ${error.message}`);
    return null;
  }
}

// Helper to get workshop paths for a mod
function getWorkshopPaths(workshopId, serverPath) {
  return [
    // Server's steamapps folder
    path.join(serverPath, 'steamapps', 'workshop', 'content', '108600', workshopId),
    // Alternative location
    path.join(serverPath, '..', 'steamapps', 'workshop', 'content', '108600', workshopId),
    // User's Steam folder (less common for dedicated servers)
    path.join(process.env.USERPROFILE || '', 'Steam', 'steamapps', 'workshop', 'content', '108600', workshopId),
  ];
}

// Helper function to find map folders from a workshop mod
// Map mods have a media/maps folder with their map folder inside
function findMapFoldersFromWorkshop(workshopId, serverPath) {
  const mapFolders = [];
  const possiblePaths = getWorkshopPaths(workshopId, serverPath);
  
  for (const workshopPath of possiblePaths) {
    if (!fs.existsSync(workshopPath)) continue;
    
    // Look for mods subfolder first (some mods have mods/ModName/media/maps structure)
    const modsFolder = path.join(workshopPath, 'mods');
    const searchPath = fs.existsSync(modsFolder) ? modsFolder : workshopPath;
    
    try {
      const entries = fs.readdirSync(searchPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        
        // Check for media/maps folder in this mod
        const mapsPath = path.join(searchPath, entry.name, 'media', 'maps');
        if (fs.existsSync(mapsPath)) {
          // Get the map folder names inside media/maps
          const mapEntries = fs.readdirSync(mapsPath, { withFileTypes: true });
          for (const mapEntry of mapEntries) {
            if (mapEntry.isDirectory()) {
              mapFolders.push(mapEntry.name);
              logger.debug(`Found map folder: ${mapEntry.name} in workshop ${workshopId}`);
            }
          }
        }
      }
      
      // Also check direct media/maps path (some mods don't have mods subfolder)
      const directMapsPath = path.join(workshopPath, 'media', 'maps');
      if (fs.existsSync(directMapsPath)) {
        const mapEntries = fs.readdirSync(directMapsPath, { withFileTypes: true });
        for (const mapEntry of mapEntries) {
          if (mapEntry.isDirectory() && !mapFolders.includes(mapEntry.name)) {
            mapFolders.push(mapEntry.name);
            logger.debug(`Found map folder (direct): ${mapEntry.name} in workshop ${workshopId}`);
          }
        }
      }
      
      if (mapFolders.length > 0) return mapFolders;
    } catch (e) {
      // Continue to next path
    }
  }
  
  return mapFolders;
}

// Helper function to find ALL mod IDs from workshop folder (returns array)
function findAllModIdsFromWorkshop(workshopId, serverPath) {
  const modIds = [];
  const possiblePaths = getWorkshopPaths(workshopId, serverPath);
  
  for (const workshopPath of possiblePaths) {
    if (!fs.existsSync(workshopPath)) continue;
    
    // Look for mod.info or mods folder
    const modsFolder = path.join(workshopPath, 'mods');
    const searchPath = fs.existsSync(modsFolder) ? modsFolder : workshopPath;
    
    try {
      const entries = fs.readdirSync(searchPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        
        // Check for mod.info in this folder
        const modInfoPath = path.join(searchPath, entry.name, 'mod.info');
        if (fs.existsSync(modInfoPath)) {
          const content = fs.readFileSync(modInfoPath, 'utf-8');
          // Parse mod.info to get the id= field
          const idMatch = content.match(/^id\s*=\s*(.+)$/m);
          if (idMatch) {
            const modId = idMatch[1].trim();
            if (!modIds.includes(modId)) {
              modIds.push(modId);
            }
          }
        }
      }
      
      // If we found mods, don't check other paths
      if (modIds.length > 0) return modIds;
    } catch (e) {
      // Continue to next path
    }
  }
  
  return modIds;
}

// Helper function to find mod ID from workshop folder
function findModIdFromWorkshop(workshopId, serverPath) {
  // Common locations where workshop mods are stored
  const possiblePaths = getWorkshopPaths(workshopId, serverPath);
  
  for (const workshopPath of possiblePaths) {
    if (!fs.existsSync(workshopPath)) continue;
    
    // Look for mod.info or mods folder
    const modsFolder = path.join(workshopPath, 'mods');
    const searchPath = fs.existsSync(modsFolder) ? modsFolder : workshopPath;
    
    try {
      const entries = fs.readdirSync(searchPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        
        // Check for mod.info in this folder
        const modInfoPath = path.join(searchPath, entry.name, 'mod.info');
        if (fs.existsSync(modInfoPath)) {
          const content = fs.readFileSync(modInfoPath, 'utf-8');
          // Parse mod.info to get the id= field
          const idMatch = content.match(/^id\s*=\s*(.+)$/m);
          if (idMatch) {
            return idMatch[1].trim();
          }
        }
      }
    } catch (e) {
      // Continue to next path
    }
  }
  
  return null;
}

// Remove a single mod from server .ini file
router.post('/remove-from-ini', async (req, res) => {
  try {
    const { workshopId, modId } = req.body;
    
    if (!workshopId) {
      return res.status(400).json({ error: 'Workshop ID is required' });
    }
    
    const serverConfigPath = await getServerConfigPath();
    const serverPath = await getServerPath();
    const serverName = await getServerName();
    
    if (!serverConfigPath) {
      return res.status(400).json({ error: 'Server config path not set' });
    }
    
    // Sanitize serverName
    const sanitizedServerName = path.basename(serverName);
    if (!sanitizedServerName || sanitizedServerName !== serverName || serverName.includes('..')) {
      return res.status(400).json({ error: 'Invalid server name' });
    }
    
    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({ error: 'Server config file not found' });
    }
    
    let content = fs.readFileSync(iniPath, 'utf-8');
    
    // Get current workshop items
    const workshopMatch = content.match(/^WorkshopItems=(.*)$/m);
    let workshopIds = workshopMatch?.[1]?.split(';').filter(Boolean) || [];
    
    // Get current mod IDs
    const modsMatch = content.match(/^Mods=(.*)$/m);
    let modIds = modsMatch?.[1]?.split(';').filter(Boolean) || [];
    
    // Remove from workshop items
    workshopIds = workshopIds.filter(id => id !== String(workshopId));
    
    // Determine which mod ID to remove
    let removedModId = null;
    let modIdToRemove = modId;
    
    if (!modIdToRemove && serverPath) {
      // Try to find the mod ID by reading the workshop folder
      modIdToRemove = findModIdFromWorkshop(String(workshopId), serverPath);
      if (modIdToRemove) {
        logger.info(`Found mod ID "${modIdToRemove}" for workshop ID ${workshopId} from mod files`);
      }
    }
    
    if (modIdToRemove) {
      const originalLength = modIds.length;
      modIds = modIds.filter(id => id !== modIdToRemove);
      if (modIds.length < originalLength) {
        removedModId = modIdToRemove;
      }
    }
    
    // Check if this mod has map folders and remove them from Map=
    let removedMapFolders = [];
    if (serverPath) {
      const modMapFolders = findMapFoldersFromWorkshop(String(workshopId), serverPath);
      if (modMapFolders.length > 0) {
        // Get current map list
        const mapMatch = content.match(/^Map=(.*)$/m);
        let currentMaps = mapMatch?.[1]?.split(';').filter(Boolean) || [];
        
        // Remove map folders associated with this mod
        for (const folder of modMapFolders) {
          if (currentMaps.includes(folder)) {
            currentMaps = currentMaps.filter(m => m !== folder);
            removedMapFolders.push(folder);
            logger.info(`Removed map folder: ${folder} for workshop ${workshopId}`);
          }
        }
        
        // Ensure at least the default map remains
        if (currentMaps.length === 0) {
          currentMaps = ['Muldraugh, KY'];
        }
        
        // Update Map= in the ini file
        const newMapList = currentMaps.join(';');
        if (content.includes('Map=')) {
          content = content.replace(/^Map=.*/m, `Map=${newMapList}`);
        }
      }
    }
    
    // Update WorkshopItems=
    if (content.includes('WorkshopItems=')) {
      content = content.replace(/^WorkshopItems=.*/m, `WorkshopItems=${workshopIds.join(';')}`);
    }
    
    // Update Mods=
    if (content.includes('Mods=')) {
      content = content.replace(/^Mods=.*/m, `Mods=${modIds.join(';')}`);
    }
    
    fs.writeFileSync(iniPath, content, 'utf-8');
    
    logger.info(`Removed workshop ID ${workshopId}${removedModId ? ` and mod ID ${removedModId}` : ''}${removedMapFolders.length > 0 ? ` and map folders: ${removedMapFolders.join(', ')}` : ''} from ${iniPath}`);
    
    res.json({
      success: true,
      message: removedModId 
        ? `Mod removed from server configuration (WorkshopItems, Mods${removedMapFolders.length > 0 ? ', and Map' : ''})` 
        : 'Workshop ID removed. Note: Could not find matching mod ID - you may need to manually remove it from Mods= in the .ini file.',
      workshopId,
      modIdRemoved: removedModId,
      mapFoldersRemoved: removedMapFolders,
      remainingWorkshopItems: workshopIds.length,
      remainingMods: modIds.length
    });
  } catch (error) {
    logger.error(`Failed to remove mod from ini: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Sync mod IDs from downloaded mods - reads workshop folders and updates Mods= in ini
router.post('/sync-mod-ids', async (req, res) => {
  try {
    const serverConfigPath = await getServerConfigPath();
    const serverPath = await getServerPath();
    const serverName = await getServerName();
    
    if (!serverConfigPath || !serverPath) {
      return res.status(400).json({ error: 'Server path not configured. Please set up the server first.' });
    }
    
    // Sanitize serverName
    const sanitizedServerName = path.basename(serverName);
    if (!sanitizedServerName || sanitizedServerName !== serverName || serverName.includes('..')) {
      return res.status(400).json({ error: 'Invalid server name' });
    }
    
    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({ error: 'Server config file not found. Start the server once first.' });
    }
    
    let content = fs.readFileSync(iniPath, 'utf-8');
    
    // Get current workshop items
    const workshopMatch = content.match(/^WorkshopItems=(.*)$/m);
    const workshopIds = workshopMatch?.[1]?.split(';').filter(Boolean) || [];
    
    // Get current mod IDs
    const modsMatch = content.match(/^Mods=(.*)$/m);
    const currentModIds = modsMatch?.[1]?.split(';').filter(Boolean) || [];
    
    // For each workshop ID, try to find the corresponding mod ID
    const syncedMods = [];
    const missingMods = [];
    const newModIds = [...currentModIds];
    
    for (const workshopId of workshopIds) {
      // First try local files
      let modId = findModIdFromWorkshop(workshopId, serverPath);
      
      // If not found locally, try Steam Workshop API
      if (!modId) {
        modId = await fetchModIdFromWorkshop(workshopId);
      }
      
      if (modId) {
        if (!newModIds.includes(modId)) {
          newModIds.push(modId);
          syncedMods.push({ workshopId, modId, status: 'added' });
        } else {
          syncedMods.push({ workshopId, modId, status: 'already_exists' });
        }
      } else {
        missingMods.push(workshopId);
      }
    }
    
    // Update Mods= in the ini file
    const newModList = newModIds.join(';');
    if (content.includes('Mods=')) {
      content = content.replace(/^Mods=.*/m, `Mods=${newModList}`);
    } else {
      content += `\nMods=${newModList}`;
    }
    
    fs.writeFileSync(iniPath, content, 'utf-8');
    
    const addedCount = syncedMods.filter(m => m.status === 'added').length;
    
    logger.info(`Synced mod IDs: ${addedCount} added, ${missingMods.length} missing`);
    
    res.json({
      success: true,
      message: `Synced ${addedCount} new mod IDs. ${missingMods.length} mods not yet downloaded.`,
      syncedMods,
      missingMods,
      totalModIds: newModIds.length,
      note: missingMods.length > 0 
        ? 'Start the server to download missing mods, then sync again.' 
        : undefined
    });
  } catch (error) {
    logger.error(`Failed to sync mod IDs: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ===== MOD PRESETS =====

// Get all mod presets
router.get('/presets', async (req, res) => {
  try {
    const presets = await getModPresets();
    res.json({ presets });
  } catch (error) {
    logger.error(`Failed to get mod presets: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Create a mod preset (save current mods as a preset)
router.post('/presets', async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Preset name is required' });
    }
    
    // Read current mods from INI
    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
    
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({ error: 'Server INI not found' });
    }
    
    const content = fs.readFileSync(iniPath, 'utf-8');
    const workshopMatch = content.match(/^WorkshopItems=(.*)$/m);
    const modsMatch = content.match(/^Mods=(.*)$/m);
    
    const workshopIds = workshopMatch ? workshopMatch[1].split(';').filter(Boolean) : [];
    const modIds = modsMatch ? modsMatch[1].split(';').filter(Boolean) : [];
    
    const preset = await createModPreset(name, description, workshopIds, modIds);
    
    logger.info(`Created mod preset "${name}" with ${workshopIds.length} workshop items and ${modIds.length} mod IDs`);
    res.json({ preset, message: `Preset "${name}" created successfully` });
  } catch (error) {
    logger.error(`Failed to create mod preset: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Update a mod preset
router.put('/presets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const presetId = parseInt(id, 10);
    if (isNaN(presetId)) {
      return res.status(400).json({ error: 'Invalid preset ID' });
    }
    
    const { name, description, workshopIds, modIds } = req.body;
    
    const preset = await updateModPreset(presetId, { name, description, workshopIds, modIds });
    if (!preset) {
      return res.status(404).json({ error: 'Preset not found' });
    }
    
    logger.info(`Updated mod preset: ${name || id}`);
    res.json({ preset, message: 'Preset updated successfully' });
  } catch (error) {
    logger.error(`Failed to update mod preset: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Delete a mod preset
router.delete('/presets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const presetId = parseInt(id, 10);
    if (isNaN(presetId)) {
      return res.status(400).json({ error: 'Invalid preset ID' });
    }
    
    const deleted = await deleteModPreset(presetId);
    
    if (!deleted) {
      return res.status(404).json({ error: 'Preset not found' });
    }
    
    logger.info(`Deleted mod preset: ${id}`);
    res.json({ message: 'Preset deleted successfully' });
  } catch (error) {
    logger.error(`Failed to delete mod preset: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Apply a mod preset (load mods from preset)
router.post('/presets/:id/apply', async (req, res) => {
  try {
    const { id } = req.params;
    const presets = await getModPresets();
    const preset = presets.find(p => p.id === parseInt(id));
    
    if (!preset) {
      return res.status(404).json({ error: 'Preset not found' });
    }
    
    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
    
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({ error: 'Server INI not found' });
    }
    
    let content = fs.readFileSync(iniPath, 'utf-8');
    
    // Update WorkshopItems
    const workshopLine = `WorkshopItems=${preset.workshopIds.join(';')}`;
    if (content.includes('WorkshopItems=')) {
      content = content.replace(/^WorkshopItems=.*/m, workshopLine);
    } else {
      content += `\n${workshopLine}`;
    }
    
    // Update Mods
    const modsLine = `Mods=${preset.modIds.join(';')}`;
    if (content.includes('Mods=')) {
      content = content.replace(/^Mods=.*/m, modsLine);
    } else {
      content += `\n${modsLine}`;
    }
    
    fs.writeFileSync(iniPath, content, 'utf-8');
    
    logger.info(`Applied mod preset "${preset.name}": ${preset.workshopIds.length} workshop items, ${preset.modIds.length} mod IDs`);
    res.json({ 
      message: `Preset "${preset.name}" applied successfully`,
      workshopCount: preset.workshopIds.length,
      modCount: preset.modIds.length
    });
  } catch (error) {
    logger.error(`Failed to apply mod preset: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Save mod load order
router.post('/save-order', async (req, res) => {
  try {
    const { modIds } = req.body;
    
    if (!Array.isArray(modIds)) {
      return res.status(400).json({ error: 'modIds must be an array' });
    }
    
    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
    
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({ error: 'Server INI not found' });
    }
    
    let content = fs.readFileSync(iniPath, 'utf-8');
    
    // Update Mods line with new order
    const modsLine = `Mods=${modIds.join(';')}`;
    if (content.includes('Mods=')) {
      content = content.replace(/^Mods=.*/m, modsLine);
    } else {
      content += `\n${modsLine}`;
    }
    
    fs.writeFileSync(iniPath, content, 'utf-8');
    
    logger.info(`Saved mod load order: ${modIds.length} mods`);
    res.json({ 
      message: 'Mod load order saved successfully',
      modCount: modIds.length
    });
  } catch (error) {
    logger.error(`Failed to save mod order: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;

// Discover all mod IDs from a workshop item (for mods with multiple IDs)
router.post('/discover-mod-ids', async (req, res) => {
  try {
    const { workshopId, workshopUrl } = req.body;
    
    // Parse workshop ID from URL if provided
    let wsId = workshopId;
    if (!wsId && workshopUrl) {
      const urlMatch = workshopUrl.match(/id=(\d+)/);
      if (urlMatch) {
        wsId = urlMatch[1];
      }
    }
    
    if (!wsId) {
      return res.status(400).json({ error: 'Workshop ID or URL is required' });
    }
    
    // Validate it's a number
    if (!/^\d+$/.test(String(wsId))) {
      return res.status(400).json({ error: 'Invalid Workshop ID' });
    }
    
    const serverPath = await getServerPath();
    const discoveredModIds = [];
    const sources = [];
    
    // 1. First try local files (most accurate if mod is already downloaded)
    if (serverPath) {
      const localModIds = findAllModIdsFromWorkshop(String(wsId), serverPath);
      for (const modId of localModIds) {
        if (!discoveredModIds.includes(modId)) {
          discoveredModIds.push(modId);
          sources.push({ modId, source: 'local-files' });
        }
      }
    }
    
    // 2. Try Steam Workshop API to get mod info (with timeout)
    let modInfo = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const response = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          'itemcount': '1',
          'publishedfileids[0]': wsId
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      
      if (response.ok) {
        const data = await response.json();
        modInfo = data.response?.publishedfiledetails?.[0];
        
        // Handle Steam API error codes
        if (modInfo && modInfo.result !== 1) {
          logger.warn(`Steam API returned error for workshop ${wsId}: result=${modInfo.result}`);
          modInfo = null;
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        logger.warn(`Steam API request timed out for workshop ${wsId}`);
      } else {
        logger.warn(`Failed to fetch Steam API for workshop ${wsId}: ${e.message}`);
      }
    }
    
    // 3. Parse mod IDs from description (if not found locally)
    if (modInfo && modInfo.result === 1 && discoveredModIds.length === 0) {
      const description = modInfo.description || '';
      
      // Try various patterns to find mod IDs
      const patterns = [
        // Pattern: "Mod ID: SomeName" or "ModID: SomeName" (can appear multiple times)
        /Mod\s*ID\s*[:=]\s*([A-Za-z0-9_-]+)/gi,
        // Pattern: "id=SomeName" 
        /\bid\s*=\s*([A-Za-z0-9_-]+)/gi,
      ];
      
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(description)) !== null) {
          const modId = match[1].trim();
          // Skip numeric-only values (likely workshop IDs)
          if (!/^\d+$/.test(modId) && !discoveredModIds.includes(modId)) {
            discoveredModIds.push(modId);
            sources.push({ modId, source: 'steam-description' });
          }
        }
      }
    }
    
    // Deduplicate mod IDs (some mods list the same ID multiple times)
    const uniqueModIds = [...new Set(discoveredModIds)];
    
    // Get map folders if available
    let mapFolders = [];
    if (serverPath) {
      mapFolders = findMapFoldersFromWorkshop(String(wsId), serverPath);
    }
    
    // Check if mod has map tag from Steam API
    const isMap = modInfo?.tags?.some(t => 
      t.tag?.toLowerCase() === 'map' || t.tag?.toLowerCase() === 'maps'
    ) || mapFolders.length > 0;
    
    res.json({
      success: true,
      workshopId: wsId,
      name: modInfo?.title || `Workshop Mod ${wsId}`,
      description: modInfo?.description?.substring(0, 500) || null,
      modIds: uniqueModIds,
      hasMultipleModIds: uniqueModIds.length > 1,
      sources,
      isMap,
      mapFolders,
      isDownloaded: serverPath ? findAllModIdsFromWorkshop(String(wsId), serverPath).length > 0 : false,
      tags: modInfo?.tags?.map(t => t.tag) || []
    });
  } catch (error) {
    logger.error(`Failed to discover mod IDs: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Add mod with specific mod IDs selected (for multi-ID mods)
router.post('/add-mod-advanced', async (req, res) => {
  try {
    const { workshopId, selectedModIds, includeAllModIds } = req.body;
    // workshopId: the Steam Workshop ID
    // selectedModIds: array of mod IDs to add (user-selected)
    // includeAllModIds: boolean - if true, add all discovered mod IDs
    
    if (!workshopId) {
      return res.status(400).json({ error: 'Workshop ID is required' });
    }
    
    if (!selectedModIds && !includeAllModIds) {
      return res.status(400).json({ error: 'Either selectedModIds or includeAllModIds is required' });
    }
    
    // Validate workshopId is numeric
    if (!/^\d+$/.test(String(workshopId))) {
      return res.status(400).json({ error: 'Invalid Workshop ID' });
    }
    
    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    const serverPath = await getServerPath();
    
    if (!serverConfigPath) {
      return res.status(400).json({ error: 'Server config path not set. Please configure the server first.' });
    }
    
    // Sanitize serverName
    const sanitizedServerName = path.basename(serverName);
    if (!sanitizedServerName || sanitizedServerName !== serverName || serverName.includes('..')) {
      return res.status(400).json({ error: 'Invalid server name' });
    }
    
    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({ 
        error: `Server config not found at ${iniPath}. Start the server once first.` 
      });
    }
    
    // Read current config
    let content = fs.readFileSync(iniPath, 'utf-8');
    
    // Get current workshop items
    const workshopMatch = content.match(/^WorkshopItems=(.*)$/m);
    const currentWorkshopIds = workshopMatch?.[1]?.split(';').filter(Boolean) || [];
    
    // Get current mod IDs
    const modsMatch = content.match(/^Mods=(.*)$/m);
    const currentModIds = modsMatch?.[1]?.split(';').filter(Boolean) || [];
    
    // Determine which mod IDs to add
    let modIdsToAdd = selectedModIds || [];
    
    if (includeAllModIds && serverPath) {
      const allModIds = findAllModIdsFromWorkshop(String(workshopId), serverPath);
      modIdsToAdd = [...new Set([...modIdsToAdd, ...allModIds])];
    }
    
    // Check if workshop ID is already in the list
    const workshopAlreadyExists = currentWorkshopIds.includes(String(workshopId));
    
    // Add workshop ID if not exists
    if (!workshopAlreadyExists) {
      currentWorkshopIds.push(String(workshopId));
    }
    
    // Add selected mod IDs (avoiding duplicates)
    const addedModIds = [];
    for (const modId of modIdsToAdd) {
      if (!currentModIds.includes(modId)) {
        currentModIds.push(modId);
        addedModIds.push(modId);
      }
    }
    
    const newWorkshopList = currentWorkshopIds.join(';');
    const newModList = currentModIds.join(';');
    
    // Update WorkshopItems=
    if (content.includes('WorkshopItems=')) {
      content = content.replace(/^WorkshopItems=.*/m, `WorkshopItems=${newWorkshopList}`);
    } else {
      content += `\nWorkshopItems=${newWorkshopList}`;
    }
    
    // Update Mods=
    if (content.includes('Mods=')) {
      content = content.replace(/^Mods=.*/m, `Mods=${newModList}`);
    } else {
      content += `\nMods=${newModList}`;
    }
    
    // Handle map folders
    let addedMapFolders = [];
    if (serverPath) {
      const modMapFolders = findMapFoldersFromWorkshop(String(workshopId), serverPath);
      if (modMapFolders.length > 0) {
        const mapMatch = content.match(/^Map=(.*)$/m);
        let currentMaps = mapMatch?.[1]?.split(';').filter(Boolean) || ['Muldraugh, KY'];
        
        for (const folder of modMapFolders) {
          if (!currentMaps.includes(folder)) {
            currentMaps.unshift(folder);
            addedMapFolders.push(folder);
          }
        }
        
        const newMapList = currentMaps.join(';');
        if (content.includes('Map=')) {
          content = content.replace(/^Map=.*/m, `Map=${newMapList}`);
        } else {
          content += `\nMap=${newMapList}`;
        }
      }
    }
    
    fs.writeFileSync(iniPath, content, 'utf-8');
    
    // Also add to tracking
    try {
      await addTrackedMod(String(workshopId), `Workshop Mod ${workshopId}`);
    } catch (e) {
      // Ignore if already tracked
    }
    
    logger.info(`Added mod ${workshopId} with ${addedModIds.length} mod IDs: ${addedModIds.join(', ')}`);
    
    res.json({
      success: true,
      workshopId,
      addedModIds,
      totalModIdsInConfig: currentModIds.length,
      workshopAlreadyExisted: workshopAlreadyExists,
      mapFoldersAdded: addedMapFolders,
      message: addedModIds.length > 0 
        ? `Added ${addedModIds.length} mod ID(s): ${addedModIds.join(', ')}` 
        : 'Workshop ID added (mod IDs were already configured)'
    });
  } catch (error) {
    logger.error(`Failed to add mod advanced: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});
