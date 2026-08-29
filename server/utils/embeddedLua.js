// Access the PanelBridge.lua content embedded at bundle time via esbuild `define`.
// In packaged pkg builds this returns the exact Lua source that shipped with the
// running binary, which is the only way to guarantee the on-disk mod matches the
// panel version after a binary-only auto-update.
//
// In dev mode (non-bundled ESM) PANEL_BRIDGE_LUA_B64 is undefined, so this returns
// null and callers must fall back to on-disk pz-mod lookup.

import fs from 'fs';
import path from 'path';

let cached;

export function getEmbeddedPanelBridgeLua() {
  if (cached !== undefined) return cached;
  try {
    const b64 = typeof PANEL_BRIDGE_LUA_B64 !== 'undefined' ? PANEL_BRIDGE_LUA_B64 : '';
    cached = (b64 && b64.length > 0) ? Buffer.from(b64, 'base64').toString('utf8') : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function getEmbeddedPanelBridgeVersion() {
  const content = getEmbeddedPanelBridgeLua();
  if (!content) return null;
  const m = content.match(/VERSION\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * Compare two "major.minor.patch[.hotfix]" version strings.
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Falls back to string compare if either side is unparseable.
 */
export function compareModVersions(a, b) {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const parse = (v) => String(v).split('.').map((n) => {
    const x = parseInt(n, 10);
    return Number.isFinite(x) ? x : -1;
  });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

// Creates `dir` and any missing parents, giving each NEWLY created level an
// explicit 0755 -- never touching a directory that already existed. The PZ
// server process is very often a different, unprivileged user than the
// panel (2026-08-29 Linux PanelBridge hunt), so a directory this function
// creates must stay traversable by "other" regardless of the panel's
// process umask; an already-existing directory (the overwhelmingly common
// case -- PZ itself creates media/lua/server/ at first launch) is left
// exactly as the operator/game already has it.
function ensureReadableDirTree(dir) {
  if (fs.existsSync(dir)) return;
  const parent = path.dirname(dir);
  if (parent !== dir) ensureReadableDirTree(parent);
  fs.mkdirSync(dir);
  try {
    fs.chmodSync(dir, 0o755);
  } catch {
    /* best-effort: Windows / network shares */
  }
}

/**
 * Atomically write PanelBridge.lua to the target path:
 *   1. Write to `.tmp.<pid>` alongside the destination.
 *   2. fsync, then rename over the destination.
 * If anything goes wrong before the rename, the old Lua is untouched.
 * If the rename itself fails (Windows file lock, antivirus), we clean up
 * the temp file and propagate the error.
 *
 * Mode is unconditionally 0644 (2026-08-29 Linux PanelBridge hunt): this is
 * a mod the PZ server process must be able to read, and that process is
 * very often a DIFFERENT, unprivileged user than the panel -- confirmed on
 * real Linux with two real users (panelsvc writing, pzgame reading) that a
 * plausible hardened umask (0077, the same style of hardening this repo's
 * own zomboid-panel.service already applies elsewhere) left the installed
 * file at 0600, unreadable by the actual game-server user, while the
 * installer still reported success. open()'s `mode` argument is masked by
 * the process umask, so passing 0o644 there alone is not a guarantee;
 * fchmodSync, unlike open()'s mode, is NOT masked by umask and is the
 * actual enforcement here.
 */
export function writeLuaAtomic(destPath, content) {
  const dir = path.dirname(destPath);
  // codeql[js/path-injection] destPath here traces back to only one currently-flagged caller, panelBridge.js's POST /install-mod, where targetPath is required absolute, realpath'd, and required to end in /media/lua/server(/) before writeLuaAtomic() is ever called.
  ensureReadableDirTree(dir);
  const tmpPath = path.join(dir, `.PanelBridge.lua.tmp.${process.pid}`);
  let fd;
  try {
    // codeql[js/path-injection] destPath here traces back to only one currently-flagged caller, panelBridge.js's POST /install-mod, where targetPath is required absolute, realpath'd, and required to end in /media/lua/server(/) before writeLuaAtomic() is ever called.
    fd = fs.openSync(tmpPath, 'w', 0o644);
    fs.writeSync(fd, content, 0, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* best-effort; some FS/OSes reject */ }
    try { fs.fchmodSync(fd, 0o644); } catch { /* best-effort: Windows / network shares */ }
    fs.closeSync(fd);
    fd = null;
    // codeql[js/path-injection] destPath here traces back to only one currently-flagged caller, panelBridge.js's POST /install-mod, where targetPath is required absolute, realpath'd, and required to end in /media/lua/server(/) before writeLuaAtomic() is ever called.
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    try { if (fd != null) fs.closeSync(fd); } catch { /* ignore */ }
    // codeql[js/path-injection] destPath here traces back to only one currently-flagged caller, panelBridge.js's POST /install-mod, where targetPath is required absolute, realpath'd, and required to end in /media/lua/server(/) before writeLuaAtomic() is ever called.
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

