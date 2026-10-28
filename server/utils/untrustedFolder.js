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

// realpath of the longest part of `target` that exists, with the rest
// appended as written.
export function realpathOrNearest(target) {
  const rest = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** "workshop", "networkShare" or null for a folder the panel runs a program from. */
export function untrustedFolderReason(dir, { windows = process.platform === "win32" } = {}) {
  if (typeof dir !== "string" || !dir.trim()) return null;
  const written = dir.trim();
  const resolve = windows ? path.win32.resolve : path.resolve;
  if (windows && (NETWORK_SHARE_RE.test(written) || NETWORK_SHARE_RE.test(resolve(written)))) {
    return "networkShare";
  }
  if (WORKSHOP_TREE_RE.test(resolve(written))) return "workshop";
  if (WORKSHOP_TREE_RE.test(realpathOrNearest(written))) return "workshop";
  return null;
}
