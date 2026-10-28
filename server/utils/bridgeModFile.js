import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';

const log = createLogger('Bridge');

// The files the mod writes (status.json, outbox res-N.json,
// queue-state-lua.json, results.json) sit in a folder the game server's
// account can write: one that size must not be read whole into memory on
// every poll. Same ceiling as the SFTP transport's downloads
// (panelBridgeSftp.js MAX_BRIDGE_FILE_BYTES); logged once per file until it
// is back under it.
const MAX_LOCAL_BRIDGE_FILE_BYTES = 16 * 1024 * 1024;
export const BRIDGE_FILE_TOO_LARGE = 'BRIDGE_FILE_TOO_LARGE';
const oversizedBridgeFilesLogged = new Set();

// SECURITY (2026-10-28): the size used to come from a stat of the path and
// the read from a second open of it, which read to the end whatever the stat
// said (a file swapped or grown in between, a symlink to /dev/zero, a pipe).
// One descriptor now does both, opened without following a symlink, and the
// read stops one byte past the limit. A symlink, device, pipe or directory
// is refused like an oversized file. The folder belongs to the game server's
// account, which isn't always the panel's (a game on the host or in another
// container sharing the Zomboid folder with the panel's container).
export const BRIDGE_FILE_NOT_REGULAR = 'BRIDGE_FILE_NOT_REGULAR';
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NON_BLOCKING = fs.constants.O_NONBLOCK ?? 0;

function notRegularBridgeFile(filePath) {
  return Object.assign(new Error(`Bridge file ${path.basename(filePath)} is not a regular file`), { code: BRIDGE_FILE_NOT_REGULAR });
}

// Opens a bridge file for `access` (O_RDONLY / O_WRONLY), refusing anything
// but a regular file with one name. Windows has no O_NOFOLLOW: a symlink is
// refused from lstat there.
function openModFile(filePath, access) {
  if (!NO_FOLLOW && fs.lstatSync(filePath).isSymbolicLink()) throw notRegularBridgeFile(filePath);
  let fd;
  try {
    fd = fs.openSync(filePath, access | NO_FOLLOW | NON_BLOCKING);
  } catch (error) {
    if (['ELOOP', 'EMLINK', 'EISDIR', 'ENXIO'].includes(error?.code)) throw notRegularBridgeFile(filePath);
    throw error;
  }
  const stats = fs.fstatSync(fd);
  if (!stats.isFile() || stats.nlink > 1) {
    fs.closeSync(fd);
    throw notRegularBridgeFile(filePath);
  }
  return { fd, size: stats.size };
}

function oversizedBridgeFile(filePath, size) {
  if (!oversizedBridgeFilesLogged.has(filePath)) {
    oversizedBridgeFilesLogged.add(filePath);
    log.warn(`Bridge file ${path.basename(filePath)} is ${size} bytes, over the ${MAX_LOCAL_BRIDGE_FILE_BYTES / (1024 * 1024)} MB limit -- not read`);
  }
  return Object.assign(new Error(`Bridge file ${path.basename(filePath)} exceeds the size limit`), { code: BRIDGE_FILE_TOO_LARGE });
}

export function readModFileCapped(filePath) {
  const { fd, size } = openModFile(filePath, fs.constants.O_RDONLY);
  try {
    if (size > MAX_LOCAL_BRIDGE_FILE_BYTES) throw oversizedBridgeFile(filePath, size);
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(Math.max(size + 1 - total, 64 * 1024), MAX_LOCAL_BRIDGE_FILE_BYTES + 1 - total));
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      chunks.push(read === chunk.length ? chunk : chunk.subarray(0, read));
      total += read;
      if (total > MAX_LOCAL_BRIDGE_FILE_BYTES) throw oversizedBridgeFile(filePath, total);
    }
    oversizedBridgeFilesLogged.delete(filePath);
    return Buffer.concat(chunks, total).toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

// Empties a consumed result file through the same checks: writeFileSync
// followed a symlink and emptied whatever it pointed at (db.json, say).
export function clearModFile(filePath) {
  const { fd } = openModFile(filePath, fs.constants.O_WRONLY);
  try {
    fs.ftruncateSync(fd, 0);
  } finally {
    fs.closeSync(fd);
  }
}

// The panel's own files in that folder (inbox commands, queue state) are
// written to a temporary name and renamed. A symlink left at the temporary
// (or, for the fallback, the final) name was followed, so the write landed in
// whatever it pointed at. The temporary file is now created fresh (it must
// not exist), and a direct write refuses a symlink.
export function writeFreshModFile(filePath, text) {
  fs.rmSync(filePath, { force: true });
  fs.writeFileSync(filePath, text, { mode: 0o600, flag: 'wx' });
}

export function writeModFileNoFollow(filePath, text) {
  let existing = null;
  try {
    existing = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing && !existing.isFile()) throw notRegularBridgeFile(filePath);
  const { O_WRONLY, O_CREAT, O_TRUNC } = fs.constants;
  fs.writeFileSync(filePath, text, { mode: 0o600, flag: O_WRONLY | O_CREAT | O_TRUNC | NO_FOLLOW | NON_BLOCKING });
}

export function isUnreadableBridgeFile(error) {
  return error?.code === BRIDGE_FILE_TOO_LARGE || error?.code === BRIDGE_FILE_NOT_REGULAR;
}
