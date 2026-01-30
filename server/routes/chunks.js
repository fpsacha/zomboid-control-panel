import express from 'express';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getSetting, getActiveServer } from '../database/init.js';

const router = express.Router();

// Helper: Get zomboidDataPath from active server or legacy settings
async function getZomboidDataPath() {
  // First try active server (multi-server support)
  const activeServer = await getActiveServer();
  if (activeServer?.zomboidDataPath) {
    return activeServer.zomboidDataPath;
  }
  
  // Fallback to legacy settings
  const legacyPath = await getSetting('zomboidDataPath');
  return legacyPath || null;
}

// Get list of available saves
router.get('/saves', async (req, res) => {
  try {
    // Use zomboidDataPath (the parent folder containing Saves, Server, Logs, etc.)
    const zomboidDataPath = await getZomboidDataPath();
    if (!zomboidDataPath) {
      return res.status(400).json({ error: 'Zomboid data path not set. Configure a server first.' });
    }
    
    const savesPath = path.join(zomboidDataPath, 'Saves', 'Multiplayer');
    
    if (!fs.existsSync(savesPath)) {
      return res.json({ saves: [] });
    }
    
    const saves = fs.readdirSync(savesPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const savePath = path.join(savesPath, d.name);
        const stats = fs.statSync(savePath);
        
        // Count chunk files (uses recursive count for B42's subdirectory structure)
        let chunkCount = 0;
        const mapPath = path.join(savePath, 'map');
        if (fs.existsSync(mapPath)) {
          chunkCount = countFiles(mapPath);
        }
        
        // Get save size
        const size = getDirSize(savePath);
        
        return {
          name: d.name,
          path: savePath,
          modified: stats.mtime,
          chunkCount,
          size,
          sizeFormatted: formatBytes(size)
        };
      });
    
    res.json({ saves });
  } catch (error) {
    logger.error(`Failed to get saves: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get chunk data for a specific save
router.get('/chunks/:saveName', async (req, res) => {
  try {
    const { saveName } = req.params;
    
    // Sanitize saveName to prevent path traversal
    const sanitizedSaveName = path.basename(saveName);
    if (!sanitizedSaveName || sanitizedSaveName !== saveName) {
      return res.status(400).json({ error: 'Invalid save name' });
    }
    
    const zomboidDataPath = await getZomboidDataPath();
    
    if (!zomboidDataPath) {
      return res.status(400).json({ error: 'Zomboid data path not set' });
    }
    
    const savePath = path.join(zomboidDataPath, 'Saves', 'Multiplayer', sanitizedSaveName);
    const mapPath = path.join(savePath, 'map');
    
    if (!fs.existsSync(mapPath)) {
      return res.json({ chunks: [], bounds: null });
    }
    
    const chunks = [];
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    
    // B42 uses subdirectory structure: map/{X}/{Y}.bin
    // First try the new B42 directory-based structure
    const mapContents = fs.readdirSync(mapPath, { withFileTypes: true });
    const xDirs = mapContents.filter(d => d.isDirectory() && /^\d+$/.test(d.name));
    
    // Limit maximum chunks to prevent memory issues with very large maps
    const MAX_CHUNKS = 50000;
    let chunkLimitReached = false;
    
    if (xDirs.length > 0) {
      // B42 structure: map/{X}/{Y}.bin
      for (const xDir of xDirs) {
        if (chunks.length >= MAX_CHUNKS) {
          chunkLimitReached = true;
          break;
        }
        
        const x = parseInt(xDir.name, 10);
        const xPath = path.join(mapPath, xDir.name);
        
        try {
          const yFiles = fs.readdirSync(xPath).filter(f => f.endsWith('.bin'));
          for (const yFile of yFiles) {
            if (chunks.length >= MAX_CHUNKS) {
              chunkLimitReached = true;
              break;
            }
            
            const yMatch = yFile.match(/^(\d+)\.bin$/);
            if (yMatch) {
              const y = parseInt(yMatch[1], 10);
              const filePath = path.join(xPath, yFile);
              const stats = fs.statSync(filePath);
              
              chunks.push({
                file: `${x}/${yFile}`,
                x,
                y,
                size: stats.size,
                modified: stats.mtime
              });
              
              minX = Math.min(minX, x);
              maxX = Math.max(maxX, x);
              minY = Math.min(minY, y);
              maxY = Math.max(maxY, y);
            }
          }
        } catch (err) {
          logger.warn(`Error reading chunk directory ${xPath}: ${err.message}`);
        }
      }
    } else {
      // Legacy flat file structure: map_X_Y.bin or X_Y.bin
      const files = mapContents.filter(f => f.isFile() && f.name.endsWith('.bin')).map(f => f.name);
      
      for (const file of files) {
        // Common formats: map_X_Y.bin, chunkdata_X_Y.bin, X_Y.bin
        const match = file.match(/(?:map_|chunkdata_|chunk_)?(\d+)_(\d+)(?:_\d+)?\.bin$/i);
        if (match) {
          const x = parseInt(match[1], 10);
          const y = parseInt(match[2], 10);
          const stats = fs.statSync(path.join(mapPath, file));
          
          chunks.push({
            file,
            x,
            y,
            size: stats.size,
            modified: stats.mtime
          });
          
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    
    // Also check chunkdata folder for B42
    const chunkDataPath = path.join(savePath, 'chunkdata');
    if (fs.existsSync(chunkDataPath)) {
      const chunkDataFiles = fs.readdirSync(chunkDataPath).filter(f => f.endsWith('.bin'));
      for (const file of chunkDataFiles) {
        const match = file.match(/(\d+)_(\d+)(?:_\d+)?\.bin$/i);
        if (match) {
          const x = parseInt(match[1], 10);
          const y = parseInt(match[2], 10);
          
          // Check if we already have this chunk from map folder
          if (!chunks.find(c => c.x === x && c.y === y)) {
            const stats = fs.statSync(path.join(chunkDataPath, file));
            chunks.push({
              file,
              x,
              y,
              size: stats.size,
              modified: stats.mtime,
              source: 'chunkdata'
            });
            
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
      }
    }
    
    const bounds = chunks.length > 0 ? { minX, maxX, minY, maxY } : null;
    
    res.json({
      saveName,
      savePath,
      chunks,
      totalChunks: chunks.length,
      bounds,
      limitReached: chunkLimitReached,
      maxChunks: MAX_CHUNKS
    });
  } catch (error) {
    logger.error(`Failed to get chunks: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Delete selected chunks
router.post('/delete-chunks', async (req, res) => {
  try {
    const { saveName, chunks, createBackup = true } = req.body;
    
    if (!saveName || !chunks || !Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({ error: 'Save name and chunks array required' });
    }
    
    // Sanitize saveName to prevent path traversal
    const sanitizedSaveName = path.basename(saveName);
    if (!sanitizedSaveName || sanitizedSaveName !== saveName) {
      return res.status(400).json({ error: 'Invalid save name' });
    }
    
    // Validate chunk files to prevent path traversal
    // B42 uses format: {X}/{Y}.bin (e.g., "1000/1208.bin")
    // Legacy uses format: map_X_Y.bin or X_Y.bin
    for (const chunk of chunks) {
      if (!chunk.file) {
        return res.status(400).json({ error: 'Invalid chunk file name' });
      }
      // Validate the path doesn't contain traversal attempts
      const normalized = path.normalize(chunk.file);
      if (normalized.includes('..') || path.isAbsolute(normalized)) {
        return res.status(400).json({ error: 'Invalid chunk file path' });
      }
    }
    
    const zomboidDataPath = await getZomboidDataPath();
    if (!zomboidDataPath) {
      return res.status(400).json({ error: 'Zomboid data path not set' });
    }
    
    const savePath = path.join(zomboidDataPath, 'Saves', 'Multiplayer', sanitizedSaveName);
    
    if (!fs.existsSync(savePath)) {
      return res.status(404).json({ error: 'Save not found' });
    }
    
    // Create backup if requested
    if (createBackup) {
      const backupPath = path.join(zomboidDataPath, 'backups', `${saveName}_chunks_${Date.now()}`);
      fs.mkdirSync(backupPath, { recursive: true });
      
      // Backup only the chunks we're about to delete
      for (const chunk of chunks) {
        const mapFile = path.join(savePath, 'map', chunk.file);
        if (fs.existsSync(mapFile)) {
          // Handle B42's subdirectory structure (e.g., "1000/1208.bin" -> "map_1000_1208.bin")
          const backupName = `map_${chunk.file.replace(/[/\\]/g, '_')}`;
          fs.copyFileSync(mapFile, path.join(backupPath, backupName));
        }
        
        // Also backup from chunkdata if exists
        if (chunk.source === 'chunkdata') {
          const chunkDataFile = path.join(savePath, 'chunkdata', chunk.file);
          if (fs.existsSync(chunkDataFile)) {
            const backupName = `chunkdata_${chunk.file.replace(/[/\\]/g, '_')}`;
            fs.copyFileSync(chunkDataFile, path.join(backupPath, backupName));
          }
        }
      }
      
      logger.info(`Created chunk backup at ${backupPath}`);
    }
    
    // Delete chunks
    let deleted = 0;
    let errors = [];
    
    for (const chunk of chunks) {
      try {
        // Delete from map folder
        const mapFile = path.join(savePath, 'map', chunk.file);
        if (fs.existsSync(mapFile)) {
          fs.unlinkSync(mapFile);
          deleted++;
        }
        
        // Related data folders use flat file naming: prefix_X_Y.bin
        // Unlike map/ which uses B42's subdirectory structure (X/Y.bin)
        const chunkDataFile = path.join(savePath, 'chunkdata', `chunkdata_${chunk.x}_${chunk.y}.bin`);
        if (fs.existsSync(chunkDataFile)) {
          fs.unlinkSync(chunkDataFile);
        }
        
        // isoregiondata uses datachunk_X_Y.bin format
        const isoFile = path.join(savePath, 'isoregiondata', `datachunk_${chunk.x}_${chunk.y}.bin`);
        if (fs.existsSync(isoFile)) {
          fs.unlinkSync(isoFile);
        }
        
        // zpop uses zpop_X_Y.bin format
        const zpopFile = path.join(savePath, 'zpop', `zpop_${chunk.x}_${chunk.y}.bin`);
        if (fs.existsSync(zpopFile)) {
          fs.unlinkSync(zpopFile);
        }
      } catch (err) {
        errors.push({ file: chunk.file, error: err.message });
      }
    }
    
    logger.info(`Deleted ${deleted} chunks from save ${saveName}`);
    
    res.json({
      success: true,
      deleted,
      errors: errors.length > 0 ? errors : undefined,
      backupCreated: createBackup
    });
  } catch (error) {
    logger.error(`Failed to delete chunks: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Delete chunks by region (x/y coordinate range)
router.post('/delete-region', async (req, res) => {
  try {
    const { saveName, minX, maxX, minY, maxY, createBackup = true, invert = false } = req.body;
    
    if (!saveName || minX === undefined || maxX === undefined || minY === undefined || maxY === undefined) {
      return res.status(400).json({ error: 'Save name and region bounds required' });
    }
    
    // Sanitize saveName to prevent path traversal
    const sanitizedSaveName = path.basename(saveName);
    if (!sanitizedSaveName || sanitizedSaveName !== saveName) {
      return res.status(400).json({ error: 'Invalid save name' });
    }
    
    // Validate bounds are numbers
    if (typeof minX !== 'number' || typeof maxX !== 'number' || 
        typeof minY !== 'number' || typeof maxY !== 'number') {
      return res.status(400).json({ error: 'Region bounds must be numbers' });
    }
    
    const zomboidDataPath = await getZomboidDataPath();
    if (!zomboidDataPath) {
      return res.status(400).json({ error: 'Zomboid data path not set' });
    }
    
    const savePath = path.join(zomboidDataPath, 'Saves', 'Multiplayer', sanitizedSaveName);
    const mapPath = path.join(savePath, 'map');
    
    if (!fs.existsSync(mapPath)) {
      return res.status(404).json({ error: 'Save map folder not found' });
    }
    
    // Get all chunks - handle both B42 directory structure and legacy flat files
    const chunksToDelete = [];
    const mapContents = fs.readdirSync(mapPath, { withFileTypes: true });
    const xDirs = mapContents.filter(d => d.isDirectory() && /^\d+$/.test(d.name));
    
    if (xDirs.length > 0) {
      // B42 structure: map/{X}/{Y}.bin
      for (const xDir of xDirs) {
        const x = parseInt(xDir.name, 10);
        const xPath = path.join(mapPath, xDir.name);
        
        try {
          const yFiles = fs.readdirSync(xPath).filter(f => f.endsWith('.bin'));
          for (const yFile of yFiles) {
            const yMatch = yFile.match(/^(\d+)\.bin$/);
            if (yMatch) {
              const y = parseInt(yMatch[1], 10);
              
              const inRegion = x >= minX && x <= maxX && y >= minY && y <= maxY;
              const shouldDelete = invert ? !inRegion : inRegion;
              
              if (shouldDelete) {
                chunksToDelete.push({ file: `${x}/${yFile}`, x, y });
              }
            }
          }
        } catch (err) {
          logger.warn(`Error reading chunk directory ${xPath}: ${err.message}`);
        }
      }
    } else {
      // Legacy flat file structure
      const files = mapContents.filter(f => f.isFile() && f.name.endsWith('.bin')).map(f => f.name);
      
      for (const file of files) {
        const match = file.match(/(?:map_|chunkdata_|chunk_)?(\d+)_(\d+)(?:_\d+)?\.bin$/i);
        if (match) {
          const x = parseInt(match[1], 10);
          const y = parseInt(match[2], 10);
          
          const inRegion = x >= minX && x <= maxX && y >= minY && y <= maxY;
          const shouldDelete = invert ? !inRegion : inRegion;
          
          if (shouldDelete) {
            chunksToDelete.push({ file, x, y });
          }
        }
      }
    }
    
    if (chunksToDelete.length === 0) {
      return res.json({ success: true, deleted: 0, message: 'No chunks in selected region' });
    }
    
    // Create backup if requested
    if (createBackup) {
      const backupPath = path.join(zomboidDataPath, 'backups', `${saveName}_region_${Date.now()}`);
      fs.mkdirSync(backupPath, { recursive: true });
      
      for (const chunk of chunksToDelete) {
        const srcFile = path.join(mapPath, chunk.file);
        if (fs.existsSync(srcFile)) {
          // Handle B42's subdirectory structure (e.g., "1000/1208.bin" -> "map_1000_1208.bin")
          const backupName = `map_${chunk.file.replace(/[/\\]/g, '_')}`;
          fs.copyFileSync(srcFile, path.join(backupPath, backupName));
        }
      }
      
      // Save region info
      fs.writeFileSync(
        path.join(backupPath, 'region_info.json'),
        JSON.stringify({ minX, maxX, minY, maxY, invert, chunksDeleted: chunksToDelete.length }, null, 2)
      );
      
      logger.info(`Created region backup at ${backupPath}`);
    }
    
    // Delete chunks
    let deleted = 0;
    for (const chunk of chunksToDelete) {
      try {
        fs.unlinkSync(path.join(mapPath, chunk.file));
        deleted++;
        
        // Related data folders use flat file naming with specific prefixes
        // Unlike map/ which uses B42's subdirectory structure (X/Y.bin)
        const relatedFiles = [
          { folder: 'chunkdata', file: `chunkdata_${chunk.x}_${chunk.y}.bin` },
          { folder: 'isoregiondata', file: `datachunk_${chunk.x}_${chunk.y}.bin` },
          { folder: 'zpop', file: `zpop_${chunk.x}_${chunk.y}.bin` }
        ];
        
        for (const { folder, file } of relatedFiles) {
          const relatedPath = path.join(savePath, folder, file);
          if (fs.existsSync(relatedPath)) {
            fs.unlinkSync(relatedPath);
          }
        }
      } catch (err) {
        logger.warn(`Failed to delete chunk ${chunk.file}: ${err.message}`);
      }
    }
    
    logger.info(`Deleted ${deleted} chunks in region [${minX},${minY}]-[${maxX},${maxY}] from ${saveName}`);
    
    res.json({
      success: true,
      deleted,
      region: { minX, maxX, minY, maxY },
      inverted: invert
    });
  } catch (error) {
    logger.error(`Failed to delete region: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get save statistics
router.get('/stats/:saveName', async (req, res) => {
  try {
    const { saveName } = req.params;
    
    // Sanitize saveName to prevent path traversal
    const sanitizedSaveName = path.basename(saveName);
    if (!sanitizedSaveName || sanitizedSaveName !== saveName) {
      return res.status(400).json({ error: 'Invalid save name' });
    }
    
    const zomboidDataPath = await getZomboidDataPath();
    
    if (!zomboidDataPath) {
      return res.status(400).json({ error: 'Zomboid data path not set' });
    }
    
    const savePath = path.join(zomboidDataPath, 'Saves', 'Multiplayer', sanitizedSaveName);
    
    if (!fs.existsSync(savePath)) {
      return res.status(404).json({ error: 'Save not found' });
    }
    
    const stats = {
      saveName,
      totalSize: getDirSize(savePath),
      folders: {}
    };
    
    const folders = ['map', 'chunkdata', 'isoregiondata', 'zpop', 'metagrid', 'apop', 'radio'];
    
    for (const folder of folders) {
      const folderPath = path.join(savePath, folder);
      if (fs.existsSync(folderPath)) {
        const fileCount = countFiles(folderPath);
        const size = getDirSize(folderPath);
        stats.folders[folder] = {
          fileCount,
          size,
          sizeFormatted: formatBytes(size)
        };
      }
    }
    
    // Players count
    const playersDb = path.join(savePath, 'players.db');
    if (fs.existsSync(playersDb)) {
      stats.playersDbSize = fs.statSync(playersDb).size;
    }
    
    // Vehicles db
    const vehiclesDb = path.join(savePath, 'vehicles.db');
    if (fs.existsSync(vehiclesDb)) {
      stats.vehiclesDbSize = fs.statSync(vehiclesDb).size;
    }
    
    stats.totalSizeFormatted = formatBytes(stats.totalSize);
    
    res.json(stats);
  } catch (error) {
    logger.error(`Failed to get save stats: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Helper functions
function getDirSize(dirPath) {
  let size = 0;
  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
      const filePath = path.join(dirPath, file.name);
      if (file.isDirectory()) {
        size += getDirSize(filePath);
      } else {
        size += fs.statSync(filePath).size;
      }
    }
  } catch (err) {
    // Ignore errors
  }
  return size;
}

// Count files recursively (handles B42's subdirectory structure)
function countFiles(dirPath) {
  let count = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += countFiles(path.join(dirPath, entry.name));
      } else {
        count++;
      }
    }
  } catch (err) {
    // Ignore errors
  }
  return count;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export default router;
