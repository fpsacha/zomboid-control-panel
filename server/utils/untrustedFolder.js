import fs from "fs";
import path from "path";

// SECURITY (2026-10-28): folders whose files anyone can supply, so the panel
// never runs a program from one -- neither a server launch (its jre64 java,
// java/ classes, start script) nor SteamCMD:
//  - a Steam Workshop download folder (steamapps/workshop/...): anyone who
//    owns the game can publish an item with any files in it, and mods.manage
//    (or the game itself, from WorkshopItems=) downloads it there;
//  - on Windows, a network share (\\host\share): the share's server hands
//    out whatever file contents it likes.
// Neither is ever where the game or SteamCMD is installed. Judged on the
// folder as written and, for the Workshop rule, on its real path too (8.3
// names, links, NTFS stream spellings). A mapped network drive is not
// refused: only the typed form decides the network-share rule.

const WORKSHOP_TREE_RE = /(^|[\\/])steamapps[\\/]+workshop([\\/]|$)/i;
const NETWORK_SHARE_RE = /^[\\/]{2}/;

// No supported OS opens a longer path (Windows 32767 UTF-16 units, Linux
// 4096 bytes, macOS 1024), so nothing that long exists to resolve.
const MAX_OPENABLE_PATH_LENGTH = 32767;

function realpathOrNull(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

// realpath of the longest part of `target` that exists, with the rest
// appended as written.
//
// SECURITY (2026-10-28, R2-13 review): this used to climb one folder at a
// time, each step a realpath of the whole remaining string, so its cost grew
// with the square of the depth: a request path of C:\a\a\a\... (up to the
// 1 MB body limit) held the event loop for minutes. A folder exists only if
// its parent does, so the longest existing part is found by halving instead
// (about 20 realpath calls for any depth), and a path no OS can open is
// taken as written.
export function realpathOrNearest(target) {
  const resolved = path.resolve(target);
  if (resolved.length > MAX_OPENABLE_PATH_LENGTH) return resolved;
  const whole = realpathOrNull(resolved);
  if (whole) return whole;
  const { root } = path.parse(resolved);
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  const prefix = (count) => root + parts.slice(0, count).join(path.sep);
  // The longest count in [0, parts.length - 1] whose prefix resolves.
  let low = 0;
  let high = parts.length - 1;
  let found = -1;
  let foundReal = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const real = realpathOrNull(prefix(mid));
    if (real) {
      found = mid;
      foundReal = real;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (found < 0) return resolved;
  return path.join(foundReal, ...parts.slice(found));
}

/**
 * Whether `dir` names a Windows network share or device path (\\host\share,
 * //host, \\?\, \\.\), as written or once resolved the Windows way. A string
 * test only: it never touches the file system.
 */
export function isWindowsNetworkPath(dir) {
  if (typeof dir !== "string" || !dir.trim()) return false;
  const written = dir.trim();
  return NETWORK_SHARE_RE.test(written) || NETWORK_SHARE_RE.test(path.win32.resolve(written));
}

/** "workshop", "networkShare" or null for a folder the panel runs a program from. */
export function untrustedFolderReason(dir, { windows = process.platform === "win32" } = {}) {
  if (typeof dir !== "string" || !dir.trim()) return null;
  const written = dir.trim();
  const resolve = windows ? path.win32.resolve : path.resolve;
  if (windows && isWindowsNetworkPath(written)) {
    return "networkShare";
  }
  if (WORKSHOP_TREE_RE.test(resolve(written))) return "workshop";
  if (WORKSHOP_TREE_RE.test(realpathOrNearest(written))) return "workshop";
  return null;
}
