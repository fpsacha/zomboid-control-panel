import express from 'express';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger.js';
const log = createLogger('API:Chunks');
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
    
    const entries = await fs.promises.readdir(savesPath, { withFileTypes: true });
    
    const saves = await Promise.all(entries
      .filter(d => d.isDirectory())
      .map(async d => {
        const savePath = path.join(savesPath, d.name);
        const stats = await fs.promises.stat(savePath);
        
        // Count chunk files (uses recursive count for B42's subdirectory structure)
        let chunkCount = 0;
        const mapPath = path.join(savePath, 'map');
        if (fs.existsSync(mapPath)) {
          chunkCount = await countFiles(mapPath);
        }
        
        // Get save size
        const size = await getDirSize(savePath);
        
        return {
          name: d.name,
          modified: stats.mtime,
          chunkCount,
          size,
          sizeFormatted: formatBytes(size)
        };
      }));
    
    res.json({ saves });
  } catch (error) {
    log.error(`Failed to get saves: ${error.message}`);
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
    const mapContents = await fs.promises.readdir(mapPath, { withFileTypes: true });
    const xDirs = mapContents.filter(d => d.isDirectory() && /^\d+$/.test(d.name));
    
    // Limit maximum chunks to prevent memory issues with very large maps
    const MAX_CHUNKS = 50000;
    
    if (xDirs.length > 0) {
      // B42 structure: map/{X}/{Y}.bin
      // Use sequential for-of loop to avoid overwhelming FS with parallel requests
      for (const xDir of xDirs) {
        if (chunks.length >= MAX_CHUNKS) break;
        
        const x = parseInt(xDir.name, 10);
        const xPath = path.join(mapPath, xDir.name);
        
        try {
          // Read Y files in this X directory
          const yFiles = await fs.promises.readdir(xPath);
          
          // Filter and process files in parallel for this directory
          // (Batch size usually reasonable for one directory)
          const filePromises = yFiles
            .filter(f => f.endsWith('.bin'))
            .map(async yFile => {
               if (chunks.length >= MAX_CHUNKS) return null; // Soft limit check
               
               const yMatch = yFile.match(/^(\d+)\.bin$/);
               if (!yMatch) return null;

               const y = parseInt(yMatch[1], 10);
               const filePath = path.join(xPath, yFile);
               
               try {
                 const stats = await fs.promises.stat(filePath);
                 return {
                    file: `${x}/${yFile}`,
                    x,
                    y,
                    size: stats.size,
                    modified: stats.mtime
                 };
               } catch (e) { return null; }
            });

          const results = await Promise.all(filePromises);
          
          for (const chunk of results) {
               if (chunk && chunks.length < MAX_CHUNKS) {
                   chunks.push(chunk);
                   minX = Math.min(minX, chunk.x);
                   maxX = Math.max(maxX, chunk.x);
                   minY = Math.min(minY, chunk.y);
                   maxY = Math.max(maxY, chunk.y);
               }
          }

        } catch (err) {
          log.warn(`Error reading chunk directory ${xPath}: ${err.message}`);
        }
      }
    } else {
      // Legacy flat file structure: map_X_Y.bin or X_Y.bin
      const files = mapContents.filter(f => f.isFile() && f.name.endsWith('.bin')).map(f => f.name);
      
      const legacyPromises = files.map(async file => {
        // Common formats: map_X_Y.bin, chunkdata_X_Y.bin, X_Y.bin
        const match = file.match(/(?:map_|chunkdata_|chunk_)?(\d+)_(\d+)(?:_\d+)?\.bin$/i);
        if (match) {
          try {
              const x = parseInt(match[1], 10);
              const y = parseInt(match[2], 10);
              const stats = await fs.promises.stat(path.join(mapPath, file));
              
              return {
                file, x, y, size: stats.size, modified: stats.mtime
              };
          } catch(e) { return null; }
        }
        return null;
      });

      const legacyResults = await Promise.all(legacyPromises);
      for (const res of legacyResults) {
        if (res) {
            chunks.push(res);
            minX = Math.min(minX, res.x);
            maxX = Math.max(maxX, res.x);
            minY = Math.min(minY, res.y);
            maxY = Math.max(maxY, res.y);
        }
      }
    }
    
    // Also check chunkdata folder — but ONLY for legacy (B41) saves.
    // In B42 (directory-based map/), chunkdata files use a different coordinate
    // system (cell-based, not chunk-based) and would corrupt bounds if mixed in.
    const isB42 = xDirs.length > 0;
    if (!isB42) {
      const chunkDataPath = path.join(savePath, 'chunkdata');
      if (fs.existsSync(chunkDataPath)) {
        // Create a Set for O(1) lookup of existing chunks to prevent O(N^2) complexity
        const existingCoords = new Set(chunks.map(c => `${c.x},${c.y}`));

        const chunkDataFiles = await fs.promises.readdir(chunkDataPath);
        const validFiles = chunkDataFiles.filter(f => f.endsWith('.bin'));

        const chunkDataPromises = validFiles.map(async file => {
          const match = file.match(/(\d+)_(\d+)(?:_\d+)?\.bin$/i);
          if (match) {
            const x = parseInt(match[1], 10);
            const y = parseInt(match[2], 10);
            
            // Check if we already have this chunk from map folder
            if (!existingCoords.has(`${x},${y}`)) {
              try {
                  const stats = await fs.promises.stat(path.join(chunkDataPath, file));
                  return {
                    file, x, y, size: stats.size, modified: stats.mtime, source: 'chunkdata'
                  };
              } catch(e) { return null; }
            }
          }
          return null;
        });

        const chunkDataResults = await Promise.all(chunkDataPromises);
        for(const res of chunkDataResults) {
            if (res) {
              chunks.push(res);
              minX = Math.min(minX, res.x);
              maxX = Math.max(maxX, res.x);
              minY = Math.min(minY, res.y);
              maxY = Math.max(maxY, res.y);
            }
        }
      }
    }
    
    const bounds = chunks.length > 0 ? { minX, maxX, minY, maxY } : null;
    
    // Sort chunks by coordinate for consistent rendering order
    chunks.sort((a, b) => a.x - b.x || a.y - b.y);
    
    res.json({
      saveName,
      chunks,
      totalChunks: chunks.length,
      bounds,
      limitReached: chunks.length >= MAX_CHUNKS,
      maxChunks: MAX_CHUNKS
    });
  } catch (error) {
    log.error(`Failed to get chunks: ${error.message}`);
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
      const backupPath = path.join(zomboidDataPath, 'backups', `${sanitizedSaveName}_chunks_${Date.now()}`);
      await fs.promises.mkdir(backupPath, { recursive: true });
      
      // Backup only the chunks we're about to delete
      // Do this in parallel but with error handling
      await Promise.all(chunks.map(async chunk => {
        try {
            const mapFile = path.join(savePath, 'map', chunk.file);
            // Use try/catch for existence check + copy to avoid race conditions
            try {
                // Handle B42's subdirectory structure (e.g., "1000/1208.bin" -> "map_1000_1208.bin")
                const backupName = `map_${chunk.file.replace(/[/\\]/g, '_')}`;
                await fs.promises.copyFile(mapFile, path.join(backupPath, backupName), fs.constants.COPYFILE_EXCL);
            } catch (e) {
                // Ignore ENOENT (file not found), effectively "if exists"
                if (e.code !== 'ENOENT') throw e;
            }
            
            // Also backup from chunkdata if exists
            if (chunk.source === 'chunkdata') {
              const chunkDataFile = path.join(savePath, 'chunkdata', chunk.file);
              try {
                  const backupName = `chunkdata_${chunk.file.replace(/[/\\]/g, '_')}`;
                  await fs.promises.copyFile(chunkDataFile, path.join(backupPath, backupName), fs.constants.COPYFILE_EXCL);
              } catch (e) {
                  if (e.code !== 'ENOENT') throw e;
              }
            }
        } catch (e) {
            log.warn(`Failed to backup chunk ${chunk.file}: ${e.message}`);
        }
      }));
      
      log.info(`Created chunk backup at ${backupPath}`);
    }
    
    // Delete chunks
    let deleted = 0;
    let errors = [];
    
    // Process deletions in parallel
    const deleteResults = await Promise.all(chunks.map(async chunk => {
      let wasDeleted = false;
      const chunkErrors = [];
      
      try {
        // Delete from map folder
        const mapFile = path.join(savePath, 'map', chunk.file);
        try {
            await fs.promises.unlink(mapFile);
            wasDeleted = true;
        } catch (e) {
            // Ignore if file doesn't exist
            if (e.code !== 'ENOENT') chunkErrors.push(e.message);
        }
        
        // Related data folders use flat file naming: prefix_X_Y.bin
        // Unlike map/ which uses B42's subdirectory structure (X/Y.bin)
        const chunkDataFile = path.join(savePath, 'chunkdata', `chunkdata_${chunk.x}_${chunk.y}.bin`);
        try { await fs.promises.unlink(chunkDataFile); } catch (e) {}
        
        // isoregiondata uses datachunk_X_Y.bin format
        const isoFile = path.join(savePath, 'isoregiondata', `datachunk_${chunk.x}_${chunk.y}.bin`);
        try { await fs.promises.unlink(isoFile); } catch (e) {}
        
        // zpop uses zpop_X_Y.bin format
        const zpopFile = path.join(savePath, 'zpop', `zpop_${chunk.x}_${chunk.y}.bin`);
        try { await fs.promises.unlink(zpopFile); } catch (e) {}
        
        return { success: true, wasDeleted };
      } catch (err) {
        return { success: false, error: err.message, file: chunk.file };
      }
    }));

    for (const res of deleteResults) {
        if (res.success) {
            if (res.wasDeleted) deleted++;
        } else {
            errors.push(`${res.file}: ${res.error}`);
        }
    }
    
    // Clean up empty X directories after B42 chunk deletion
    const deletedXDirs = new Set();
    for (const chunk of chunks) {
      const parts = chunk.file.split('/');
      if (parts.length === 2) deletedXDirs.add(parts[0]);
    }
    for (const xDir of deletedXDirs) {
      try {
        const xPath = path.join(savePath, 'map', xDir);
        const remaining = await fs.promises.readdir(xPath);
        if (remaining.length === 0) await fs.promises.rmdir(xPath);
      } catch (e) { /* ignore */ }
    }
    
    log.info(`Deleted ${deleted} chunks from save ${sanitizedSaveName}`);
    
    res.json({
      success: true,
      deleted,
      errors: errors.length > 0 ? errors : undefined,
      backupCreated: createBackup
    });
  } catch (error) {
    log.error(`Failed to delete chunks: ${error.message}`);
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
    const mapContents = await fs.promises.readdir(mapPath, { withFileTypes: true });
    const xDirs = mapContents.filter(d => d.isDirectory() && /^\d+$/.test(d.name));
    
    if (xDirs.length > 0) {
      // B42 structure: map/{X}/{Y}.bin
      await Promise.all(xDirs.map(async xDir => {
        const x = parseInt(xDir.name, 10);
        // Quick AABB check: if entire X row is out of X bounds, skip it
        if (!invert && (x < minX || x > maxX)) return;
        
        const xPath = path.join(mapPath, xDir.name);
        
        try {
          const yFiles = await fs.promises.readdir(xPath);
          const binFiles = yFiles.filter(f => f.endsWith('.bin'));
          
          for (const yFile of binFiles) {
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
          log.warn(`Error reading chunk directory ${xPath}: ${err.message}`);
        }
      }));
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
    
    // Safety limit to prevent accidental mass deletion
    if (chunksToDelete.length > 100000) {
      return res.status(400).json({ 
        error: `Region too large (${chunksToDelete.length.toLocaleString()} chunks). Maximum is 100,000 at a time.` 
      });
    }
    
    // Create backup if requested
    if (createBackup) {
      const backupPath = path.join(zomboidDataPath, 'backups', `${sanitizedSaveName}_region_${Date.now()}`);
      await fs.promises.mkdir(backupPath, { recursive: true });
      
      // Parallel backup
      await Promise.all(chunksToDelete.map(async chunk => {
        const srcFile = path.join(mapPath, chunk.file);
        try {
             const backupName = `map_${chunk.file.replace(/[/\\]/g, '_')}`;
             await fs.promises.copyFile(srcFile, path.join(backupPath, backupName));
        } catch (e) {
            // Ignore missing files or errors
        }
      }));
      
      // Save region info
      await fs.promises.writeFile(
        path.join(backupPath, 'region_info.json'),
        JSON.stringify({ minX, maxX, minY, maxY, invert, chunksDeleted: chunksToDelete.length }, null, 2)
      );
      
      log.info(`Created region backup at ${backupPath}`);
    }
    
    // Delete chunks
    let deleted = 0;
    
    await Promise.all(chunksToDelete.map(async chunk => {
      try {
        await fs.promises.unlink(path.join(mapPath, chunk.file));
        // Atomic increment? JS is single threaded event loop, so yes this is safe.
        // But `deleted` is a simple var captured in closure.
        // It's safe in Node.js main thread.
        deleted++;
        
        // Related data folders use flat file naming with specific prefixes
        const relatedFiles = [
          { folder: 'chunkdata', file: `chunkdata_${chunk.x}_${chunk.y}.bin` },
          { folder: 'isoregiondata', file: `datachunk_${chunk.x}_${chunk.y}.bin` },
          { folder: 'zpop', file: `zpop_${chunk.x}_${chunk.y}.bin` }
        ];
        
        await Promise.all(relatedFiles.map(async ({ folder, file }) => {
            try {
                const relatedPath = path.join(savePath, folder, file);
                await fs.promises.unlink(relatedPath);
            } catch(e) {}
        }));
      } catch (err) {
        log.warn(`Failed to delete chunk ${chunk.file}: ${err.message}`);
      }
    }));
    
    // Clean up empty X directories after B42 chunk deletion
    const deletedXDirs = new Set();
    for (const chunk of chunksToDelete) {
      const parts = chunk.file.split('/');
      if (parts.length === 2) deletedXDirs.add(parts[0]);
    }
    for (const xDir of deletedXDirs) {
      try {
        const xDirPath = path.join(mapPath, xDir);
        const remaining = await fs.promises.readdir(xDirPath);
        if (remaining.length === 0) await fs.promises.rmdir(xDirPath);
      } catch (e) { /* ignore */ }
    }
    
    log.info(`Deleted ${deleted} chunks in region [${minX},${minY}]-[${maxX},${maxY}] from ${sanitizedSaveName}`);
    
    res.json({
      success: true,
      deleted,
      region: { minX, maxX, minY, maxY },
      inverted: invert
    });
  } catch (error) {
    log.error(`Failed to delete region: ${error.message}`);
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
      totalSize: await getDirSize(savePath), // Now awaited
      folders: {}
    };
    
    const folders = ['map', 'chunkdata', 'isoregiondata', 'zpop', 'metagrid', 'apop', 'radio'];
    
    for (const folder of folders) {
      const folderPath = path.join(savePath, folder);
      try {
        if (fs.existsSync(folderPath)) {
            const fileCount = await countFiles(folderPath);
            const size = await getDirSize(folderPath);
            stats.folders[folder] = {
            fileCount,
            size,
            sizeFormatted: formatBytes(size)
            };
        }
      } catch (e) {}
    }
    
    // Players count
    const playersDb = path.join(savePath, 'players.db');
    if (fs.existsSync(playersDb)) {
      try {
        const s = await fs.promises.stat(playersDb);
        stats.playersDbSize = s.size;
      } catch (e) {}
    }
    
    // Vehicles db
    const vehiclesDb = path.join(savePath, 'vehicles.db');
    if (fs.existsSync(vehiclesDb)) {
      try {
        const s = await fs.promises.stat(vehiclesDb);
        stats.vehiclesDbSize = s.size;
      } catch (e) {}
    }
    
    stats.totalSizeFormatted = formatBytes(stats.totalSize);
    
    res.json(stats);
  } catch (error) {
    log.error(`Failed to get save stats: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Helper functions
async function getDirSize(dirPath) {
  let totalSize = 0;
  try {
    const files = await fs.promises.readdir(dirPath, { withFileTypes: true });
    
    for (const file of files) {
      const filePath = path.join(dirPath, file.name);
      if (file.isDirectory()) {
         totalSize += await getDirSize(filePath);
      } else {
         // Optimization: We could just ignore stat failures
         try {
           const stats = await fs.promises.stat(filePath);
           totalSize += stats.size;
         } catch (e) {}
      }
    }
  } catch (err) {
    // Ignore errors (permission denied, etc)
  }
  return totalSize;
}

// Count files recursively (handles B42's subdirectory structure)
async function countFiles(dirPath) {
  let count = 0;
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += await countFiles(path.join(dirPath, entry.name));
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
