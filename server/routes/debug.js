import express from 'express';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';
const log = createLogger('API:Debug');
import { getDataPaths, setDataPaths } from '../utils/paths.js';
import { getPerformanceHistory, recordPerformanceSnapshot, getDatabaseStats, createDatabaseBackup, compactDatabase } from '../database/init.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// In-memory log buffer for real-time streaming
const logBuffer = [];
const MAX_BUFFER_SIZE = 500;

// Hook into Winston to capture logs for streaming
export function addLogToBuffer(level, message, source = 'server') {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    source
  };
  
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER_SIZE) {
    logBuffer.shift();
  }
  
  return entry;
}

// Get system RAM info for auto-configuration
router.get('/ram', async (req, res) => {
  try {
    const totalMemBytes = os.totalmem();
    const freeMemBytes = os.freemem();
    const totalMemGB = Math.floor(totalMemBytes / (1024 * 1024 * 1024));
    const freeMemGB = Math.floor(freeMemBytes / (1024 * 1024 * 1024));
    
    // Calculate recommended settings
    // Reserve ~4GB for OS/other apps, use 50-75% of remaining for server
    const availableForServer = Math.max(1, totalMemGB - 4);
    const recommendedMax = Math.min(Math.floor(availableForServer * 0.75), 16); // Cap at 16GB
    const recommendedMin = Math.max(1, Math.floor(recommendedMax * 0.5)); // Min is 50% of max
    
    res.json({
      totalGB: totalMemGB,
      freeGB: freeMemGB,
      recommendedMin,
      recommendedMax
    });
  } catch (error) {
    log.error(`Failed to get RAM info: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get system information
router.get('/system', async (req, res) => {
  try {
    const paths = getDataPaths();
    
    res.json({
      nodeVersion: process.version,
      platform: process.platform,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      dbPath: fs.existsSync(paths.dbPath) ? paths.dbPath : 'Not found',
      logsPath: fs.existsSync(paths.logsDir) ? paths.logsDir : 'Not found',
      dataDir: paths.dataDir,
      pathsConfigurable: true,
      env: {
        NODE_ENV: process.env.NODE_ENV || 'development',
        PORT: process.env.PORT || 3001,
        LOG_LEVEL: process.env.LOG_LEVEL || 'info'
      }
    });
  } catch (error) {
    log.error(`Failed to get system info: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get recent logs from buffer
router.get('/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 200;
    res.json({
      logs: logBuffer.slice(-limit),
      total: logBuffer.length
    });
  } catch (error) {
    log.error(`Failed to get logs: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// List available log files
router.get('/logs/files', async (req, res) => {
  try {
    const paths = getDataPaths();
    const logsDir = paths.logsDir;
    
    try {
        await fs.promises.access(logsDir);
    } catch {
        return res.json({ files: [] });
    }
    
    const fileList = await fs.promises.readdir(logsDir);
    
    const files = (await Promise.all(fileList
      .filter(f => f.endsWith('.log'))
      .map(async name => {
        try {
            const filePath = path.join(logsDir, name);
            const stats = await fs.promises.stat(filePath);
            return {
            name,
            size: stats.size,
            modified: stats.mtime.toISOString()
            };
        } catch(e) { return null; }
      })))
      .filter(f => f !== null)
      .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    
    res.json({ files });
  } catch (error) {
    log.error(`Failed to list log files: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Download combined log file
router.get('/logs/download', async (req, res) => {
  try {
    const paths = getDataPaths();
    const logsPath = path.join(paths.logsDir, 'combined.log');
    
    if (!fs.existsSync(logsPath)) {
      return res.status(404).json({ error: 'Log file not found' });
    }
    
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename=combined.log');
    
    const readStream = fs.createReadStream(logsPath);
    readStream.pipe(res);
  } catch (error) {
    log.error(`Failed to download logs: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Download specific log file by name
router.get('/logs/download/:filename', async (req, res) => {
  try {
    const paths = getDataPaths();
    const filename = req.params.filename;
    
    // Security: prevent path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    
    const logsPath = path.join(paths.logsDir, filename);
    
    if (!fs.existsSync(logsPath)) {
      return res.status(404).json({ error: 'Log file not found' });
    }
    
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    
    const readStream = fs.createReadStream(logsPath);
    readStream.pipe(res);
  } catch (error) {
    log.error(`Failed to download log file: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Clear in-memory log buffer
router.post('/logs/clear', async (req, res) => {
  try {
    logBuffer.length = 0;
    res.json({ success: true, message: 'Log buffer cleared' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update data paths (database and logs location)
router.post('/paths', async (req, res) => {
  try {
    const { dataDir, logsDir, moveFiles } = req.body;
    
    if (!dataDir && !logsDir) {
      return res.status(400).json({ error: 'At least one path must be provided' });
    }
    
    const result = await setDataPaths({ dataDir, logsDir }, moveFiles !== false);
    
    if (result.success) {
      log.info(`Data paths updated - Data: ${result.paths.dataDir}, Logs: ${result.paths.logsDir}`);
      res.json({
        success: true,
        message: 'Paths updated successfully. Restart the application to apply changes.',
        paths: result.paths,
        filesMoved: result.filesMoved,
        requiresRestart: true
      });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    log.error(`Failed to update paths: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Health check with details
router.get('/health', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const serverManager = req.app.get('serverManager');
    const modChecker = req.app.get('modChecker');
    
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        rcon: {
          connected: rconService?.isConnected?.() || false,
          host: rconService?.host || 'not configured'
        },
        server: {
          running: await serverManager?.checkServerRunning?.() || false
        },
        modChecker: {
          running: modChecker?.isRunning || false,
          interval: modChecker?.checkInterval || 0
        }
      },
      memory: process.memoryUsage(),
      uptime: process.uptime()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get performance history for charts
router.get('/performance-history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 60;
    const history = await getPerformanceHistory(limit);
    res.json({ history });
  } catch (error) {
    log.error(`Failed to get performance history: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Record current performance snapshot (called periodically)
router.post('/performance-snapshot', async (req, res) => {
  try {
    const { memoryUsed, memoryTotal, cpuUsage, playerCount, serverRunning } = req.body;
    await recordPerformanceSnapshot({
      memoryUsed: memoryUsed || process.memoryUsage().heapUsed,
      memoryTotal: memoryTotal || process.memoryUsage().heapTotal,
      cpuUsage: cpuUsage || 0,
      playerCount: playerCount || 0,
      serverRunning: serverRunning ?? false
    });
    res.json({ success: true });
  } catch (error) {
    log.error(`Failed to record performance snapshot: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Database stats
router.get('/database', async (req, res) => {
  try {
    const stats = await getDatabaseStats();
    res.json(stats);
  } catch (error) {
    log.error(`Failed to get database stats: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Create manual database backup
router.post('/database/backup', async (req, res) => {
  try {
    const result = await createDatabaseBackup();
    res.json(result);
  } catch (error) {
    log.error(`Failed to create database backup: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Compact database (apply retention policies)
router.post('/database/compact', async (req, res) => {
  try {
    const result = await compactDatabase();
    res.json(result);
  } catch (error) {
    log.error(`Failed to compact database: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get crash logs (hs_err files from Java crashes)
router.get('/crash-logs', async (req, res) => {
  try {
    const serverManager = req.app.get('serverManager');
    const serverPath = serverManager?.serverPath || '';
    
    // Look for crash logs in common locations
    const crashDirs = [
      serverPath,
      path.join(serverPath, 'logs'),
      process.cwd(),
      path.join(process.cwd(), 'logs')
    ].filter(Boolean);
    
    const crashLogs = [];
    const seenFiles = new Set(); // Prevent duplicates
    
    for (const dir of crashDirs) {
      try {
        // Check dir exists
        try { await fs.promises.access(dir); } catch { continue; }

        const files = await fs.promises.readdir(dir);
        
        await Promise.all(files.map(async file => {
            // Skip if already seen
            if (seenFiles.has(file)) return;
            
            // Match Java crash dumps and common crash log patterns
            if (file.startsWith('hs_err_pid') || 
                (file.includes('crash') && file.endsWith('.log')) ||
                (file.includes('error') && file.endsWith('.log'))) {
                
                try {
                    const filePath = path.join(dir, file);
                    const stats = await fs.promises.stat(filePath);
                    if (!seenFiles.has(file)) { // Check again after await
                        seenFiles.add(file);
                        crashLogs.push({
                        name: file,
                        path: filePath,
                        size: stats.size,
                        modified: stats.mtime.toISOString()
                        });
                    }
                } catch(e) {}
            }
        }));
      } catch (e) {
        // Directory not accessible
      }
    }
    
    // Sort by modified date, newest first
    crashLogs.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    
    res.json({ crashLogs: crashLogs.slice(0, 20) });
  } catch (error) {
    log.error(`Failed to get crash logs: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get crash log content
router.get('/crash-logs/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const serverManager = req.app.get('serverManager');
    const serverPath = serverManager?.serverPath || '';
    
    // Security: prevent path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    
    const searchDirs = [
      serverPath,
      path.join(serverPath, 'logs'),
      process.cwd(),
      path.join(process.cwd(), 'logs')
    ].filter(Boolean);
    
    for (const dir of searchDirs) {
      const filePath = path.join(dir, filename);
      try {
        await fs.promises.access(filePath);
        
        // Read only first 100KB using file handle to prevent OOM on large files
        const handle = await fs.promises.open(filePath, 'r');
        try {
            const stats = await handle.stat();
            const readSize = Math.min(stats.size, 100000);
            const buffer = Buffer.alloc(readSize);
            
            await handle.read(buffer, 0, readSize, 0);
            const content = buffer.toString('utf-8');
            
            return res.json({ 
                content,
                truncated: stats.size > 100000,
                size: stats.size
            });
        } finally {
            await handle.close();
        }
      } catch (e) {
          // File not found in this dir, try next
      }
    }
    
    res.status(404).json({ error: 'Crash log not found' });
  } catch (error) {
    log.error(`Failed to read crash log: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;
export { logBuffer };
