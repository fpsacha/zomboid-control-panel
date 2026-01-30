import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Detect if running as a pkg-compiled executable
// In pkg, process.pkg exists and __dirname points to snapshot filesystem
const isPkg = typeof process.pkg !== 'undefined';

// Get the base directory - for pkg use exe location, otherwise use project root
const baseDir = isPkg 
  ? path.dirname(process.execPath)  // Directory containing the exe
  : path.join(__dirname, '../..');   // Project root (server/utils -> project)

// Default paths (relative to base directory)
const defaultDataDir = path.join(baseDir, 'data');
const defaultLogsDir = path.join(baseDir, 'logs');

// Config file stores custom path overrides
const configPath = path.join(baseDir, 'paths.config.json');

// Current paths (loaded at startup)
let currentPaths = null;

/**
 * Load paths from config file or use defaults
 */
export function getDataPaths() {
  if (currentPaths) {
    return currentPaths;
  }
  
  let config = {};
  
  // Try to load custom paths from config
  if (fs.existsSync(configPath)) {
    try {
      const configData = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(configData);
    } catch (e) {
      console.error('Failed to load paths config:', e.message);
    }
  }
  
  const dataDir = config.dataDir || defaultDataDir;
  const logsDir = config.logsDir || defaultLogsDir;
  
  // Ensure directories exist
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  
  currentPaths = {
    dataDir,
    logsDir,
    dbPath: path.join(dataDir, 'db.json'),
    configPath
  };
  
  return currentPaths;
}

/**
 * Copy directory recursively
 */
function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) return false;
  
  fs.mkdirSync(dest, { recursive: true });
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
  
  return true;
}

/**
 * Update paths and optionally move files
 */
export async function setDataPaths(newPaths, moveFiles = true) {
  const current = getDataPaths();
  const filesMoved = { data: false, logs: false };
  
  const updatedConfig = {
    dataDir: newPaths.dataDir || current.dataDir,
    logsDir: newPaths.logsDir || current.logsDir
  };
  
  // Validate paths
  try {
    // Check if paths are valid (can create directories)
    if (newPaths.dataDir) {
      const testPath = path.join(newPaths.dataDir, '.test');
      fs.mkdirSync(newPaths.dataDir, { recursive: true });
      fs.writeFileSync(testPath, 'test');
      fs.unlinkSync(testPath);
    }
    
    if (newPaths.logsDir) {
      const testPath = path.join(newPaths.logsDir, '.test');
      fs.mkdirSync(newPaths.logsDir, { recursive: true });
      fs.writeFileSync(testPath, 'test');
      fs.unlinkSync(testPath);
    }
  } catch (e) {
    return { success: false, error: `Invalid path: ${e.message}` };
  }
  
  // Move files if requested
  if (moveFiles) {
    try {
      // Move data files
      if (newPaths.dataDir && newPaths.dataDir !== current.dataDir) {
        if (fs.existsSync(current.dataDir)) {
          // Copy all files from old data dir to new
          const files = fs.readdirSync(current.dataDir);
          for (const file of files) {
            const srcFile = path.join(current.dataDir, file);
            const destFile = path.join(newPaths.dataDir, file);
            
            if (fs.statSync(srcFile).isFile()) {
              fs.copyFileSync(srcFile, destFile);
            }
          }
          filesMoved.data = true;
        }
      }
      
      // Move log files
      if (newPaths.logsDir && newPaths.logsDir !== current.logsDir) {
        if (fs.existsSync(current.logsDir)) {
          // Copy all log files to new location
          const files = fs.readdirSync(current.logsDir);
          for (const file of files) {
            const srcFile = path.join(current.logsDir, file);
            const destFile = path.join(newPaths.logsDir, file);
            
            if (fs.statSync(srcFile).isFile()) {
              fs.copyFileSync(srcFile, destFile);
            }
          }
          filesMoved.logs = true;
        }
      }
    } catch (e) {
      return { success: false, error: `Failed to move files: ${e.message}` };
    }
  }
  
  // Save config
  try {
    fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));
  } catch (e) {
    return { success: false, error: `Failed to save config: ${e.message}` };
  }
  
  // Clear cached paths so they reload on next call
  currentPaths = null;
  
  return {
    success: true,
    paths: getDataPaths(),
    filesMoved
  };
}

/**
 * Reset paths to defaults
 */
export function resetPaths() {
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
  currentPaths = null;
  return getDataPaths();
}
