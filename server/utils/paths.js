import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ErrorCode } from './errorCodes.js';
import { restrictExistingSecretFiles } from './secretFileAcl.js';
import { untrustedFolderReason } from './untrustedFolder.js';

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
 * The panel's own program folder: the directory holding the executable in a
 * packaged build, the project root otherwise. The Server Files file manager
 * seals it (changing it would run code as the panel) and refuses to open a
 * server root inside it.
 */
export function getPanelProgramDir() {
  return baseDir;
}

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

  // Ensure directories exist. This is the Windows analogue of Linux's
  // root-first-run trap (server/utils/firstRunOwnershipCheck.js): the
  // default location is a subfolder of wherever the exe lives, and nothing
  // upstream of this call has confirmed the current account can actually
  // write there. 2026-09-05, reproduced live (non-admin shell, no elevation):
  // pointing process.execPath at a path under "C:\Program Files\..." -- a
  // completely ordinary place for a Windows user to extract a "program" to,
  // and one this project's own docs steer away from by example but never
  // warn against -- throws a raw, uncaught EPERM out of this function with
  // no indication of WHY, at module-load time (database/init.js calls
  // getDataPaths() at its own top level), before index.js's body has even
  // started. There is no Windows equivalent of the Linux ownership check
  // that would turn that into one clear diagnostic instead of a bare node
  // stack trace. Fix: catch EPERM/EACCES specifically, name the two most
  // likely paths forward, and exit -- do NOT swallow any other error (disk
  // full, path too long, etc. should still surface as-is).
  for (const dir of [dataDir, logsDir]) {
    if (fs.existsSync(dir)) continue;
    try {
      fs.mkdirSync(dir, { recursive: true, ...(dir === dataDir ? { mode: 0o700 } : {}) });
    } catch (err) {
      if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES')) {
        console.error(
          `\nRefusing to start: could not create "${dir}".\n\n` +
          `This almost always means the panel is installed somewhere your Windows account ` +
          `cannot write to -- most commonly "Program Files" without running as Administrator.\n\n` +
          `Fix one of these, then restart:\n` +
          `  - Move the panel folder somewhere your account can write to (for example C:\\ZomboidPanel), or\n` +
          `  - Right-click Start.bat and choose "Run as administrator".\n\n` +
          `Underlying error: ${err.message}\n`
        );
        process.exit(77); // same code Linux's ownership check uses -- same class of problem
      }
      throw err;
    }
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

// True when `child` is `parent` or inside it.
function isWithinDir(parent, child) {
  const rel = path.relative(normalizeForCompare(parent), normalizeForCompare(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The real path of `p`, or of its nearest existing ancestor with the rest
// appended: a folder that does not exist yet still resolves through a link
// (a junction or symlink) higher up.
function realishPath(p) {
  let current = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

// Secret files named by *_FILE environment variables (Docker secrets), as
// fileManagerProtectedAreas.js counts them.
function envSecretFiles() {
  return Object.entries(process.env)
    .filter(([name, value]) => name.endsWith('_FILE') && typeof value === 'string' && path.isAbsolute(value))
    .slice(0, 8)
    .map(([, value]) => value);
}

/**
 * Why `logsDir` can't be the panel's logs folder, or null when it can.
 *
 * GET /api/debug/logs/download/:filename serves files from the logs folder to
 * any role holding diagnostics.manage, so the logs folder must never be,
 * hold, or sit inside the data folder (db.json, jwt.secret, server-secrets/),
 * the program folder (the panel's own code and paths.config.json), or the
 * folder of a secret file. The default <program>/logs is the one folder
 * inside the program folder it may be. Compared both as typed and through
 * links, so a junction to the data folder is refused too.
 *
 * @param {string} logsDir
 * @param {{ dataDirs?: string[], secretPaths?: string[], checkProgramDir?: boolean }} [opts]
 */
export function logsDirRefusal(logsDir, { dataDirs = [], secretPaths = [], checkProgramDir = true } = {}) {
  const forms = [path.resolve(logsDir), realishPath(logsDir)];
  const both = (p) => [path.resolve(p), realishPath(p)];
  const dataForms = dataDirs.filter((d) => typeof d === 'string' && d.trim()).flatMap(both);
  const programForms = both(baseDir);
  const defaultLogsForms = both(defaultLogsDir);
  const secretFiles = [...secretPaths, ...envSecretFiles()]
    .filter((p) => typeof p === 'string' && p.trim() && path.isAbsolute(p))
    .flatMap(both);
  for (const form of forms) {
    if (dataForms.some((dataDir) => pathsOverlap(form, dataDir))) {
      return "The logs folder can't be the panel's data folder, a folder inside it, or a folder that holds it";
    }
    if (
      checkProgramDir &&
      programForms.some((programDir) => pathsOverlap(form, programDir)) &&
      !defaultLogsForms.some((defaultLogs) => isWithinDir(defaultLogs, form))
    ) {
      return "The logs folder can't be the panel's program folder, a folder inside it (other than its own logs folder), or a folder that holds it";
    }
    if (secretFiles.some((secret) => isWithinDir(form, secret))) {
      return "The logs folder can't hold one of the panel's secret files";
    }
  }
  return null;
}

/**
 * Why `dataDir` can't be the panel's new data folder, or null when it can.
 *
 * SECURITY (2026-10-28): the data folder holds db.json, jwt.secret and the
 * *.secret files, and the panel serves its web client to anyone, signed in
 * or not: <program>/client/dist, or <data>/.embedded-client in a packaged
 * build. A data folder inside either was downloadable by anyone. So, like
 * the logs folder, it can't be, hold, or sit inside the program folder --
 * its own default <program>/data excepted -- nor sit inside a served
 * client folder. Compared both as typed and through links.
 *
 * @param {string} dataDir
 * @param {{ currentDataDir?: string }} [opts]
 */
export function dataDirRefusal(dataDir, { currentDataDir } = {}) {
  const both = (p) => [path.resolve(p), realishPath(p)];
  const forms = both(dataDir);
  const programForms = both(baseDir);
  const defaultDataForms = both(defaultDataDir);
  const servedForms = [defaultDataDir, currentDataDir]
    .filter((d) => typeof d === 'string' && d.trim())
    .flatMap((d) => both(path.join(d, '.embedded-client')));
  for (const form of forms) {
    const inProgramDir =
      programForms.some((programDir) => pathsOverlap(form, programDir)) &&
      !defaultDataForms.some((defaultData) => isWithinDir(defaultData, form));
    if (inProgramDir || servedForms.some((served) => isWithinDir(served, form))) {
      return "The data folder can't be the panel's program folder, a folder inside it (other than its own data folder), a folder that holds it, or a folder the panel serves to browsers";
    }
  }
  return null;
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
    // SECURITY (2026-10-28): no Windows network share or device path
    // (\\host\share, \\?\..., \\.\...), refused before any file call below:
    // merely touching one signs the panel's account in to that host, and a
    // share's owner reads, or supplies, the database and signing secret.
    if (untrustedFolderReason(dir) === 'networkShare') {
      return {
        success: false,
        error: "The panel's data and logs folders must be on this computer, not a network share or device path",
        code: ErrorCode.FOLDER_NETWORK_SHARE_REFUSED,
      };
    }
    // The blocklist is matched as typed and through links (a junction into
    // C:\Windows is still C:\Windows).
    const lower = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const resolvedForms = [lower(path.resolve(dir)), lower(realishPath(dir))];
    if (resolvedForms.some((resolved) => BLOCKED_PREFIXES.some((p) => resolved.startsWith(p)))) {
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

  if (newPaths.dataDir) {
    const refusal = dataDirRefusal(newPaths.dataDir, { currentDataDir: current.dataDir });
    if (refusal) {
      return { success: false, error: refusal, code: ErrorCode.PANEL_DATA_FOLDER_REFUSED };
    }
  }

  const updatedConfig = {
    dataDir: newPaths.dataDir || current.dataDir,
    logsDir: newPaths.logsDir || current.logsDir
  };

  // The logs folder is served file by file (see logsDirRefusal()). A new
  // logs folder is checked against the data folder it will sit beside (and
  // the current one, which keeps its files when they are not moved), the
  // program folder and the secret files; a new data folder against the logs
  // folder the panel keeps using.
  if (newPaths.logsDir || newPaths.dataDir) {
    const refusal = logsDirRefusal(updatedConfig.logsDir, {
      dataDirs: newPaths.logsDir ? [updatedConfig.dataDir, current.dataDir] : [updatedConfig.dataDir],
      secretPaths: Array.isArray(options.secretPaths) ? options.secretPaths : [],
      checkProgramDir: Boolean(newPaths.logsDir),
    });
    if (refusal) {
      return { success: false, error: refusal };
    }
  }

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
          // A copy takes its new folder's ACL on Windows: restrict the copied
          // secret files again (utils/secretFileAcl.js).
          await restrictExistingSecretFiles(newPaths.dataDir);

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
    // codeql[js/http-to-file-access] the target is the panel's own fixed paths.config.json; the request only supplies the two folder paths, JSON-encoded, after the checks above refused a relative, network-share or device path, a system folder (as typed and through links), the program folder and the web client the panel serves, a configured server's folders, and a logs/data overlap.
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
