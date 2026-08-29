/**
 * PanelBridge Auto-Install
 *
 * When the panel has local filesystem access to the PZ server's install
 * directory (bind mount, same-host install), PanelBridge.lua can be copied
 * into place automatically instead of requiring the user to do it by hand.
 * Remote/SFTP-managed servers are never touched here — the panel has no
 * local path to write to for those.
 *
 * Every function degrades to a clear `{ success: false, error }` rather than
 * throwing: install failures must never block server activation (see the
 * best-effort call in routes/servers.js POST /:id/activate).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { compareModVersions, writeLuaAtomic } from '../utils/embeddedLua.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('PanelBridgeInstaller');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VERSION_REGEX = /VERSION\s*=\s*"([^"]+)"/;

// Mirrors the candidate lookup used by the /install-mod-auto and
// /auto-configure routes (dev checkout vs. packaged pkg binary layouts).
function sourceCandidates() {
  return [
    path.join(process.cwd(), 'pz-mod', 'PanelBridge', 'media', 'lua', 'server', 'PanelBridge.lua'),
    path.join(path.dirname(process.execPath), 'pz-mod', 'PanelBridge', 'media', 'lua', 'server', 'PanelBridge.lua'),
    path.join(__dirname, '..', '..', 'pz-mod', 'PanelBridge', 'media', 'lua', 'server', 'PanelBridge.lua'),
  ];
}

export function resolveSourcePath() {
  return sourceCandidates().find((candidate) => fs.existsSync(candidate)) || null;
}

// The server's install directory, resolved the same way serverManager does:
// prefer serverPath, fall back to installPath, and if that names a launch
// script (.bat/.sh/.exe) rather than a directory, use its parent folder.
function resolveInstallDir(server) {
  let dir = server?.serverPath || server?.installPath;
  if (!dir) return null;
  const lower = dir.toLowerCase();
  if (lower.endsWith('.bat') || lower.endsWith('.sh') || lower.endsWith('.exe')) {
    dir = path.dirname(dir);
  }
  return dir;
}

export function resolveTargetPath(server) {
  const installDir = resolveInstallDir(server);
  return installDir ? path.join(installDir, 'media', 'lua', 'server', 'PanelBridge.lua') : null;
}

function isWritableDir(dirPath) {
  try {
    if (!fs.statSync(dirPath).isDirectory()) return false;
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function canAutoInstall(server) {
  if (!server || server.isRemote) return false;
  const installDir = resolveInstallDir(server);
  if (!installDir || !fs.existsSync(installDir) || !isWritableDir(installDir)) {
    return false;
  }
  return Boolean(resolveSourcePath());
}

function readVersion(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return (content.match(VERSION_REGEX) || [])[1] || null;
  } catch (error) {
    log.debug(`Could not read version from ${filePath}: ${error.message}`);
    return null;
  }
}

export function checkBridgeInstalled(server) {
  const sourcePath = resolveSourcePath();
  const targetPath = resolveTargetPath(server);
  const installed = Boolean(targetPath && fs.existsSync(targetPath));
  const sourceVersion = sourcePath ? readVersion(sourcePath) : null;
  const targetVersion = installed ? readVersion(targetPath) : null;
  const needsUpdate = Boolean(
    installed && sourceVersion &&
    (!targetVersion || compareModVersions(sourceVersion, targetVersion) > 0),
  );

  return { installed, version: targetVersion, needsUpdate, sourcePath, targetPath };
}

// Best-effort: match the copied file's ownership to the install directory's
// so a game server process running as a different, unprivileged user can
// still read it. chown requires elevated privileges on most systems and
// doesn't exist at all on Windows, so failures here are logged, not thrown.
function matchOwnership(targetPath, referencePath) {
  if (process.platform === 'win32' || !referencePath) return;
  try {
    const { uid, gid } = fs.statSync(referencePath);
    fs.chownSync(targetPath, uid, gid);
  } catch (error) {
    log.debug(`Could not match ownership for ${targetPath}: ${error.message}`);
  }
}

export function installBridge(server) {
  const sourcePath = resolveSourcePath();
  const targetPath = resolveTargetPath(server);
  if (!sourcePath) {
    return { success: false, error: 'PanelBridge source not found in panel install.' };
  }
  if (!targetPath) {
    return { success: false, error: 'Server install path not configured.' };
  }

  try {
    const sourceContent = fs.readFileSync(sourcePath, 'utf8');
    const sourceVersion = readVersion(sourcePath);
    if (!sourceVersion) {
      return { success: false, error: 'PanelBridge source has no readable version.' };
    }
    if (fs.existsSync(targetPath)) {
      const targetVersion = readVersion(targetPath);
      if (targetVersion && compareModVersions(targetVersion, sourceVersion) > 0) {
        return {
          success: true,
          targetPath,
          version: targetVersion,
          updated: false,
          message: `Existing PanelBridge v${targetVersion} is newer than the bundled v${sourceVersion}; it was left unchanged.`,
        };
      }
    }
    writeLuaAtomic(targetPath, sourceContent);
    matchOwnership(targetPath, resolveInstallDir(server));
    const installedContent = fs.readFileSync(targetPath, 'utf8');
    const version = readVersion(targetPath);
    if (installedContent !== sourceContent || version !== sourceVersion) {
      return { success: false, error: 'PanelBridge verification failed after install.' };
    }
    // Verifies the file the way the GAME will see it, not just the way the
    // panel's own (trivially-successful, same-process) read just did.
    // writeLuaAtomic() now enforces 0644 unconditionally, so this should
    // never actually fire -- it exists as a visible signal in case some
    // future change to that guarantee (or an unusual filesystem) silently
    // breaks it, rather than the mod just never loading with nothing in
    // the log to explain why (2026-08-29 Linux PanelBridge hunt).
    if (process.platform !== 'win32') {
      try {
        const { mode } = fs.statSync(targetPath);
        if ((mode & 0o004) === 0) {
          log.warn(
            `PanelBridge installed at ${targetPath}, but it is not world-readable ` +
              `(mode ${(mode & 0o777).toString(8)}). If the PZ server runs as a ` +
              'different user than the panel, it will not be able to load this mod.',
          );
        }
      } catch {
        /* best-effort */
      }
    }
    log.info(`PanelBridge installed at ${targetPath} (v${version || 'unknown'})`);
    return { success: true, targetPath, version, updated: true };
  } catch (error) {
    log.warn(`PanelBridge install failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}
