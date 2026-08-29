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

// Config file stores custom path overrides. PANEL_PATHS_CONFIG_PATH lets a
// caller point at a different config file entirely -- used by
// server/tests/vitest.globalSetup.mjs so each concurrent test run gets its
// own file instead of every process on the machine (every agent's test
// runs AND the real panel) racing on one shared path at the repo root.
// Unset (the normal case for the real panel) falls back to today's
// behaviour exactly.
const configPath = process.env.PANEL_PATHS_CONFIG_PATH
  ? path.resolve(process.env.PANEL_PATHS_CONFIG_PATH)
  : path.join(baseDir, 'paths.config.json');

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
      console.error(`[PATHS] Failed to load paths config (${configPath}): ${e.stack || e.message}`);
    }
  }
  
  const dataDir = config.dataDir || defaultDataDir;
  const logsDir = config.logsDir || defaultLogsDir;
  
  // Ensure directories exist
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // dataDir holds jwt.secret, server-secrets/, db.json and everything else
  // getDataPaths() callers treat as sensitive -- a 0600 secret file inside a
  // world-writable (or group/other-writable) directory can still be renamed
  // away, replaced, or have a symlink dropped in its place by any local
  // user, so the directory itself needs an explicit mode, not whatever
  // mkdirSync's mode (itself subject to umask, and never applied at all
  // when the directory already existed) happened to leave it at.
  //
  // Mirrors serverRconSecrets.js's ensureSecretsDir(): mkdirSync's mode is
  // only honored on the create path, so a chmodSync follow-up runs
  // unconditionally, on every call -- not just fresh installs. That is what
  // makes this take effect for an existing install's already-created
  // dataDir too, not only a brand-new one.
  try {
    fs.chmodSync(dataDir, 0o700);
  } catch {
    /* best-effort: Windows / network shares don't support POSIX modes */
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
  
  // codeql[js/path-injection] src/dest here are current.dataDir/newPaths.dataDir, both already validated (absolute, not a blocked system prefix, no overlap with a configured server's install/data dir) earlier in setDataPaths() before copyDirSync() is called.
  fs.mkdirSync(dest, { recursive: true });
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      // codeql[js/path-injection] src/dest here are current.dataDir/newPaths.dataDir, both already validated (absolute, not a blocked system prefix, no overlap with a configured server's install/data dir) earlier in setDataPaths() before copyDirSync() is called.
      fs.copyFileSync(srcPath, destPath);
    }
  }
  
  return true;
}

function normalizeForCompare(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// True if `a` and `b` are the same directory, or one contains the other --
// checked both directions, since a target that's an ANCESTOR of a blocked
// path (e.g. pointing dataDir at "D:\SteamLibrary") is just as dangerous as
// one that's inside it.
function pathsOverlap(a, b) {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (na === nb) return true;
  const relAB = path.relative(na, nb);
  const relBA = path.relative(nb, na);
  const aContainsB = relAB !== '' && !relAB.startsWith('..') && !path.isAbsolute(relAB);
  const bContainsA = relBA !== '' && !relBA.startsWith('..') && !path.isAbsolute(relBA);
  return aContainsB || bContainsA;
}

/**
 * Update paths and optionally move files.
 *
 * moveFiles defaults to false -- 2026-08-27: this used to default to true
 * (`moveFiles !== false` at the one call site, server/routes/debug.js's
 * POST /paths), so a request that named a new dataDir but never mentioned
 * moveFiles at all got the destructive option by omission, not by choice.
 * The only real caller (Debug.tsx) always sends moveFiles explicitly, so
 * flipping this costs it nothing; a caller that doesn't know to ask for a
 * file move no longer gets one silently.
 *
 * extraBlockedPaths (installPath/zomboidDataPath for every configured PZ
 * server, supplied by the route -- this module has no database access of
 * its own) blocks pointing the panel's own data/logs directory at, into,
 * or around a live PZ install or save location. Checked in ADDITION to the
 * built-in system-directory blocklist below.
 */
export async function setDataPaths(newPaths, moveFiles = false, options = {}) {
  const current = getDataPaths();
  const filesMoved = { data: false, logs: false };
  const extraBlockedPaths = Array.isArray(options.extraBlockedPaths)
    ? options.extraBlockedPaths.filter((p) => typeof p === 'string' && p.trim())
    : [];

  // Validate paths — block system-critical directories
  const BLOCKED_PREFIXES = process.platform === 'win32'
    ? [
        'c:\\windows', 'c:\\program files', 'c:\\program files (x86)',
        'c:\\programdata', 'c:\\users\\public'
      ]
    : [
        '/etc', '/usr', '/bin', '/sbin', '/var', '/boot', '/proc', '/sys', '/dev'
      ];

  for (const dir of [newPaths.dataDir, newPaths.logsDir]) {
    if (!dir) continue;
    if (typeof dir !== 'string' || dir.length > 500) {
      return { success: false, error: 'Invalid path format' };
    }
    // Must be absolute -- checked on the RAW input. path.resolve() always
    // returns an absolute path (it resolves a relative one against CWD),
    // so checking isAbsolute() on the resolved value here used to always
    // pass regardless of what was submitted -- a relative path silently
    // became "wherever the server process happens to be running from"
    // instead of being rejected. Found 2026-08-27 while fixing the
    // defaulted-on file move; fixed alongside it since it's the same
    // function and the same "validate before moving" requirement.
    if (!path.isAbsolute(dir)) {
      return { success: false, error: 'Path must be absolute' };
    }
    const resolved = process.platform === 'win32'
      ? path.resolve(dir).toLowerCase()
      : path.resolve(dir);
    if (BLOCKED_PREFIXES.some(p => resolved.startsWith(p))) {
      return { success: false, error: 'Path targets a protected system directory' };
    }
    const overlappingBlocked = extraBlockedPaths.find((blocked) => pathsOverlap(dir, blocked));
    if (overlappingBlocked) {
      return {
        success: false,
        error: `Path overlaps a configured PZ server's install or data directory (${overlappingBlocked})`,
      };
    }
  }

  const updatedConfig = {
    dataDir: newPaths.dataDir || current.dataDir,
    logsDir: newPaths.logsDir || current.logsDir
  };

  // Validate paths — can they actually be created and written to. This is
  // the one check that can't be done without a real side effect (a
  // read-only stat can't prove a directory is writable, especially on
  // Windows) -- it creates the directory and writes/deletes a probe file.
  // Deliberately still a no-op with respect to the DECISION to move or
  // switch paths: nothing here commits anything, so a failure here aborts
  // cleanly before either the move or the config write below.
  try {
    if (newPaths.dataDir) {
      const testPath = path.join(newPaths.dataDir, '.test');
      // codeql[js/path-injection] newPaths.dataDir/logsDir passed setDataPaths()'s own guard chain above -- string+length check, isAbsolute(), BLOCKED_PREFIXES system-directory check, and pathsOverlap() against every configured PZ server's install/data dir -- before this line runs.
      fs.mkdirSync(newPaths.dataDir, { recursive: true });
      // codeql[js/path-injection] newPaths.dataDir/logsDir passed setDataPaths()'s own guard chain above -- string+length check, isAbsolute(), BLOCKED_PREFIXES system-directory check, and pathsOverlap() against every configured PZ server's install/data dir -- before this line runs.
      fs.writeFileSync(testPath, 'test');
      // codeql[js/path-injection] newPaths.dataDir/logsDir passed setDataPaths()'s own guard chain above -- string+length check, isAbsolute(), BLOCKED_PREFIXES system-directory check, and pathsOverlap() against every configured PZ server's install/data dir -- before this line runs.
      fs.unlinkSync(testPath);
    }

    if (newPaths.logsDir) {
      const testPath = path.join(newPaths.logsDir, '.test');
      // codeql[js/path-injection] newPaths.dataDir/logsDir passed setDataPaths()'s own guard chain above -- string+length check, isAbsolute(), BLOCKED_PREFIXES system-directory check, and pathsOverlap() against every configured PZ server's install/data dir -- before this line runs.
      fs.mkdirSync(newPaths.logsDir, { recursive: true });
      // codeql[js/path-injection] newPaths.dataDir/logsDir passed setDataPaths()'s own guard chain above -- string+length check, isAbsolute(), BLOCKED_PREFIXES system-directory check, and pathsOverlap() against every configured PZ server's install/data dir -- before this line runs.
      fs.writeFileSync(testPath, 'test');
      // codeql[js/path-injection] newPaths.dataDir/logsDir passed setDataPaths()'s own guard chain above -- string+length check, isAbsolute(), BLOCKED_PREFIXES system-directory check, and pathsOverlap() against every configured PZ server's install/data dir -- before this line runs.
      fs.unlinkSync(testPath);
    }
  } catch (e) {
    return { success: false, error: `Invalid path: ${e.message}` };
  }

  // Move files if requested. The config write below is the point of no
  // return (it's what makes the app actually start reading from the new
  // location on next restart) -- everything above and in this block must
  // succeed, or return early, before that happens.
  if (moveFiles) {
    try {
      // Move data files
      if (newPaths.dataDir && newPaths.dataDir !== current.dataDir) {
        if (fs.existsSync(current.dataDir)) {
          // Copy all files and folders from old data dir to new
          copyDirSync(current.dataDir, newPaths.dataDir);
          filesMoved.data = true;

          // The one file whose absence is a lockout, not an inconvenience:
          // if the source had a database and the copy didn't produce one
          // at the destination -- copyDirSync silently returning false for
          // a source that vanished mid-copy, a permissions quirk on one
          // file, a sync tool watching the target and interfering -- abort
          // here, before the config below switches the app over to a
          // dataDir with no database in it. filesMoved.data=true above is
          // about what was ATTEMPTED, not proof of what actually landed;
          // this is the proof.
          const sourceDb = path.join(current.dataDir, 'db.json');
          const destDb = path.join(newPaths.dataDir, 'db.json');
          // codeql[js/path-injection] newPaths.dataDir/logsDir passed setDataPaths()'s own guard chain above -- string+length check, isAbsolute(), BLOCKED_PREFIXES system-directory check, and pathsOverlap() against every configured PZ server's install/data dir -- before this line runs.
          if (fs.existsSync(sourceDb) && !fs.existsSync(destDb)) {
            return {
              success: false,
              error: 'Data directory move did not produce a database file at the new location -- aborted before switching paths. The old location is untouched.',
            };
          }
        }
      }

      // Move log files
      if (newPaths.logsDir && newPaths.logsDir !== current.logsDir) {
        if (fs.existsSync(current.logsDir)) {
          // Copy all log files and folders to new location
          copyDirSync(current.logsDir, newPaths.logsDir);
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
