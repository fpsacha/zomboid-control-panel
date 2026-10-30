import fs from "fs";
import path from "path";
import { ErrorCode } from "./errorCodes.js";
import { untrustedFolderReason } from "./untrustedFolder.js";
import {
  zomboidDataFolderHolds,
  zomboidDataFolderRefusal,
  zomboidFolderAround,
} from "../services/zomboidDataPath.js";

// SECURITY (2026-10-04, FILES-2): serverConfigPath is the folder Server
// Config reads and writes (<name>.ini, the .lua files, their .bak backups,
// templates). It was saved with no check at all, so servers.manage alone
// (technician) could point it at any folder on this computer, then list it,
// fetch images from it and write .ini/.lua files into it through
// /api/server-files. Every flow that sets it (detect, auto-scan, both
// install routes) sends <zomboidDataPath>/Server, so a value is accepted
// only when it resolves, links followed, to that folder or one inside it.
// The server's own data folder is the anchor, so one is required. The value
// is checked as typed (no %VAR% expansion, unlike zomboidDataPath), so
// nothing about the environment can be read back through this check.
//
// routes/servers.js applies it when the folder is saved; routes/
// serverFiles.js applies it again when the folder is used, so one saved
// before the check existed is refused there too.
const SERVER_CONFIG_PATH_MAX_LENGTH = 1024;

// realpath of the deepest part of `target` that exists, with the missing
// rest put back: a folder that isn't there yet still can't leave the anchor
// through a link in the part that is.
function resolveThroughLinks(target) {
  const resolved = path.resolve(target);
  let existing = resolved;
  const missing = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...missing);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return resolved;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function isSameOrInside(child, parent) {
  const rel = path.relative(parent, child);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

export function serverConfigPathIsConfined(value, zomboidDataPath) {
  if (
    typeof value !== "string" ||
    value.length > SERVER_CONFIG_PATH_MAX_LENGTH ||
    /[\x00-\x1f]/.test(value) ||
    !path.isAbsolute(value)
  ) {
    return false;
  }
  if (typeof zomboidDataPath !== "string" || !zomboidDataPath.trim()) {
    return false;
  }
  // SECURITY (2026-10-28): a Windows network path (\\host\share, \\?\, \\.\)
  // is judged on its text before anything below touches it: resolving one
  // makes the panel's account sign in to that host. A data folder on one is
  // refused unread, as the data-folder rule refuses it -- a remote record's
  // data folder never meets that rule when it is saved -- except the
  // operator's own PZ_SAVE_PATH, which that rule accepts. A config folder on
  // one goes on only when it is inside, as written, a Server folder this
  // check accepts; any other is refused unread.
  if (isNetworkPath(zomboidDataPath) && !isOperatorDataFolder(zomboidDataPath)) {
    return false;
  }
  if (isNetworkPath(value)) {
    const written = path.resolve(value);
    if (!writtenAnchors(zomboidDataPath).some((anchor) => isSameOrInside(written, anchor))) {
      return false;
    }
  }
  const target = resolveThroughLinks(value);
  return configAnchors(zomboidDataPath).some((anchor) => isSameOrInside(target, anchor));
}

function isNetworkPath(value) {
  return untrustedFolderReason(value) === "networkShare";
}

// The data folder PZ_SAVE_PATH names: the operator's own, which the
// data-folder rule accepts wherever it is.
function isOperatorDataFolder(zomboidDataPath) {
  const configured = process.env.PZ_SAVE_PATH;
  if (!configured || !path.isAbsolute(configured)) return false;
  const own = path.resolve(configured);
  const given = path.resolve(zomboidDataPath);
  return process.platform === "win32" ? own.toLowerCase() === given.toLowerCase() : own === given;
}

// configAnchors() below as written, links not followed.
function writtenAnchors(zomboidDataPath) {
  const anchors = [path.resolve(zomboidDataPath, "Server")];
  const root = zomboidFolderAround(zomboidDataPath);
  if (root) anchors.push(path.join(root, "Server"));
  return anchors;
}

// SECURITY (2026-10-05, PT2 verifier round 1): the Server folder of the
// data folder, and for a data folder named Saves/Multiplayer, also the
// Server folder of the Zomboid folder it sits in -- only when that one meets
// the data-folder rule on its own (zomboidFolderAround()), so it is a
// folder a technician could have named as the data folder anyway. In 1.4.5
// Map Cleanup's "Save as default" set such a data folder and left the
// record's config folder, <Zomboid>/Server, as it was; Server Files and Mods
// refused it after the update (SERVER_CONFIG_PATH_OUTSIDE_DATA). With no
// config folder set, the default stays <data folder>/Server: that is where
// the game reads its ini when the panel starts it with the data folder as
// its -cachedir.
//
// SECURITY (2026-10-05, W5-P2): the same for the other two folders "Save
// as default" stored in 1.4.5 -- a Saves folder and a single world save --
// and for a stored path in another letter case on Windows and macOS
// (W5-P1), each only as zomboidFolderAround() verifies it on disk.
function configAnchors(zomboidDataPath) {
  const anchors = [resolveThroughLinks(path.join(path.resolve(zomboidDataPath), "Server"))];
  const root = zomboidFolderAround(zomboidDataPath);
  if (root) anchors.push(resolveThroughLinks(path.join(root, "Server")));
  return anchors;
}

// SECURITY (2026-10-05, PATHS-2): the save-time check above stops new
// records from naming a config folder outside their data folder, but a
// record saved before it -- or one with a config folder and no data folder,
// or the legacy settings copy -- still reached every reader that took
// serverConfigPath as it was: Server Files' gate held a record to the rule
// only when it had both folders, and the other readers never did. Every
// reader that reads or writes a server's .ini/.lua files now goes through
// serverConfigDirOf() or activeServerConfigDir() below (or the check above,
// directly), so they agree on which folder that is:
//   - a config folder that is named is used only while it is inside
//     <dataPath>/Server; otherwise it is refused, never swapped for another
//     folder (the operator would be editing files they didn't pick);
//   - with none named, <dataPath>/Server, as before.
// `refused` tells a caller to answer serverConfigDirRefusal() below.
//
// SECURITY (2026-10-05, PATHS-1/PATHS-2 verifier pass 2): holding the
// config folder to <dataPath>/Server protects nothing while the data folder
// itself goes unjudged -- and a remote server's never is when it is saved
// (its path names a folder on its own host), nor is the legacy settings
// copy setActiveServer() made of one. So a technician saved a remote server
// whose data folder was any folder here, and the mods routes,
// /configure-rcon, /configure-network and the UPnP edit read and rewrote
// <that folder>/Server/<name>.ini on this computer. The data folder in
// effect is now held to the data-folder rule (services/zomboidDataPath.js)
// here, where every one of those readers and writers resolves the folder:
// refused (`reason: "data-folder"`), there is no config folder. A
// same-host "remote" profile whose data folder is a real one keeps working,
// and one on another host names a path that isn't here (nothing to judge).
export function resolveServerConfigDir(configPath, dataPath) {
  const hasDataPath = typeof dataPath === "string" && dataPath.trim() !== "";
  if (hasDataPath && !zomboidDataFolderHolds(dataPath)) {
    return { dir: null, refused: true, reason: "data-folder" };
  }
  if (configPath) {
    return serverConfigPathIsConfined(configPath, dataPath)
      ? { dir: configPath, refused: false, reason: null }
      : { dir: null, refused: true, reason: "outside-data" };
  }
  return { dir: hasDataPath ? path.join(dataPath, "Server") : null, refused: false, reason: null };
}

const SERVER_CONFIG_PATH_OUTSIDE_DATA_MESSAGE =
  "The server config folder must be the Server folder inside this server's Zomboid data folder, or a folder inside it. Set the Zomboid data folder first, or leave the config folder empty.";

// The response body for a config folder resolveServerConfigDir() refused:
// SERVER_CONFIG_PATH_OUTSIDE_DATA, or ZOMBOID_DATA_FOLDER_REFUSED when
// it was the data folder that failed.
export function serverConfigDirRefusal(resolved) {
  if (resolved?.reason === "data-folder") return zomboidDataFolderRefusal();
  return {
    error: SERVER_CONFIG_PATH_OUTSIDE_DATA_MESSAGE,
    code: ErrorCode.SERVER_CONFIG_PATH_OUTSIDE_DATA,
  };
}

// For log lines: why a config folder was refused.
export function serverConfigDirRefusalReason(resolved) {
  return resolved?.reason === "data-folder"
    ? "the Zomboid data folder doesn't look like one"
    : "the config folder is outside the Zomboid data folder";
}

// A server record's own config folder, held to its own data folder -- for
// the services that act on a given server (start, scheduled restarts,
// templates, PanelBridge delivery, backups), which may not be the active
// one, so the legacy settings (a copy of the active server's) don't apply.
export function serverConfigDirOf(server) {
  return resolveServerConfigDir(server?.serverConfigPath || null, server?.zomboidDataPath || null);
}

// The active server's config folder, the legacy settings standing in for
// what the record leaves empty -- the chain Server Files, mods and the
// Discord presence read through (record's config folder, else
// <record's data folder>/Server, else the legacy config folder, else
// <legacy data folder>/Server). The config folder is held to the data
// folder in effect: the record's, else the legacy one.
export function activeServerConfigDir(activeServer, legacy = {}) {
  const dataPath = activeServer?.zomboidDataPath || legacy?.zomboidDataPath || null;
  const configPath =
    activeServer?.serverConfigPath ||
    (activeServer?.zomboidDataPath ? null : legacy?.serverConfigPath) ||
    null;
  return { ...resolveServerConfigDir(configPath, dataPath), dataPath };
}

// SECURITY (2026-10-05, PT3): after the update, a server whose data folder
// no longer meets the data-folder rule, or whose record has a config folder
// but no data folder, lost features with no word why: Server Files, chunks
// and backups answered the refusal, but the Mods page read "Server config
// path not set", the Console page showed no log, the Discord presence
// dropped MaxPlayers and a start skipped writing the RCON settings with one
// log line. This is that refusal for one server record -- the body the
// features answer (ZOMBOID_DATA_FOLDER_REFUSED or
// SERVER_CONFIG_PATH_OUTSIDE_DATA, each saying what to set) -- or null when
// its folders are usable, unset, or on another host (a remote server).
// Judged as serverConfigDirOf() judges them, which is what
// ensureRconConfigured() uses at a start. The server list carries it for
// the Servers page's warning, and POST /start answers it.
export function serverFolderProblem(server) {
  if (!server || server.isRemote) return null;
  const resolved = serverConfigDirOf(server);
  return resolved.refused ? serverConfigDirRefusal(resolved) : null;
}
