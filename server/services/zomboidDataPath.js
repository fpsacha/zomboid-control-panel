import fs from "fs";
import path from "path";
import { ErrorCode } from "../utils/errorCodes.js";
import { holdsSaveFiles, inspectZomboidPath, normalizeUserPath } from "../utils/zomboidPaths.js";
import { RENAME_TEMP_SUFFIX, TRASH_DIR_NAME, UPLOAD_TEMP_SUFFIX } from "./fileManagerContract.js";

// SECURITY (2026-10-05, PATHS-1): a server's Zomboid data folder (its
// zomboidDataPath, the game's -cachedir) is the folder chunks /browse lists
// every folder name under, Server Files reaches Server/ in, backups read
// Saves/ from and write backups/ into, and wipe deletes from. POST
// /api/servers saved it with no check at all, so servers.manage alone
// (technician) could name any folder on this computer as one. Every place
// that sets it -- POST and PUT /api/servers, /install and /quick-setup,
// create-from-discovery, chunks /save-path, and the legacy setting in PUT
// /config/app-settings -- now holds it to this one rule, and the features
// that list or read under it apply the rule again when they use it (a
// folder that didn't exist when it was saved can appear later):
//   - an absolute path, at most 1024 characters, no control characters;
//   - and nothing there yet (the game creates the folder on first start),
//     or a folder that already is one: a world save in its Saves (or
//     Multiplayer) folder, or save files directly in it (on-disk checks --
//     not inspectZomboidPath()'s name-only ones, which any folder whose
//     path says "zomboid" or "saves" passes, the panel's own folder
//     included), or nothing in it but what the game itself (and the
//     panel's File Manager) puts in a data folder (empty included), or
//     nothing in it but world saves and what the game and the panel put
//     there (a Saves/Multiplayer folder named directly, as Map Cleanup
//     allows).
// A server install folder is refused. The folder PZ_SAVE_PATH names comes
// from the operator's own environment (the Docker images set it), not from
// a request, and is taken as it is. Remote servers stay exempt at the
// setters: their paths are on another host. So a remote record's data
// folder is no folder of this computer's, and the features that use one
// here either apply zomboidDataFolderHolds() to it or don't use a remote
// server's at all. Applying it: chunks /browse, Server Files' image browser,
// the log tailer, and every reader and writer of the server's config folder
// (mods, /configure-rcon, /configure-network, the UPnP edit,
// ensureRconConfigured, templates, PanelBridge delivery, pre-restart config
// backups, backup snapshots, the Discord presence, the support bundle),
// through utils/serverConfigPath.js. Not using a remote server's: backups,
// the console-log routes, wipe. The legacy settings copy
// (setActiveServer()) takes no remote server's folders, and the features
// that fall back to it apply the rule to it as well (PATHS-1 verifier
// pass 2).
const ZOMBOID_DATA_PATH_MAX_LENGTH = 1024;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

// What the game puts in its data folder, read off the B42 projectzomboid.jar
// (the arguments ZomboidFileSystem.getCacheDirSub() is called with, and the
// getCacheDir() + separator + name paths its callers build: GameServer,
// GameWindow, ZipLogs, ZipBackup, DebugLog, LuaManager, InstanceTracker,
// RecipeMonitor, CraftRecipeManager, ...), checked against a real B42
// ~/Zomboid. Matched exactly, as the game names them.
const GAME_DATA_FOLDERS = new Set([
  "Saves",
  "Server",
  "Logs",
  "Lua",
  "db",
  "mods",
  "Workshop",
  "Sandbox Presets",
  "backups",
  "Screenshots",
  "messaging",
  "joypads",
  "InputBindings",
  "Crafting",
  "Recording",
  "RecipeLogs",
]);

const GAME_DATA_FILES = new Set([
  "console.txt",
  "server-console.txt",
  "coop-console.txt",
  "options.ini",
  "options2.bin",
  "debug-options.ini",
  "latestSave.ini",
  "logs.zip",
  "version.txt",
  "debuglog.cfg",
  "debuglog-server.cfg",
  "debuglog.ini",
  "sounds.ini",
  "screenresolution.ini",
  "translationProblems.txt",
  "AllRecipes.txt",
  "sound-event-instances.txt",
  "ItemTracker.log",
  "popman-options.ini",
  "isoregions-options.ini",
  "animationViewerState-options.ini",
  "bulletTracerEffect-options.ini",
  "debugChunkState-options.ini",
  "SeamEditorState-options.ini",
  "SpriteModelEditorState-options.ini",
  "TileGeometryState-options.ini",
]);

// Files too.
const GAME_DATA_FILE_PATTERNS = [
  /^log_\d+\.txt$/,
  // Java's zip file system (ZipLogs writes logs.zip through it) leaves
  // these next to the zip.
  /^zipfstmp\d+\.tmp$/,
  /^movables_stats_[^\\/]+\.txt$/,
  /^reset-mods-[^\\/]+\.txt$/,
];

// Left by the operating system, not the game: Finder, Explorer, and the
// root of an ext4 volume mounted as the data folder.
const OS_FOLDER_ENTRIES = new Set([".DS_Store", "Thumbs.db", "desktop.ini", "lost+found"]);

export function isGameDataFolderEntry(name) {
  return GAME_DATA_FOLDERS.has(name) || OS_FOLDER_ENTRIES.has(name) || isGameDataFileName(name);
}

function isGameDataFileName(name) {
  return GAME_DATA_FILES.has(name) || GAME_DATA_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

// SECURITY (2026-10-05, PT2 verifier round 2): what the panel's File
// Manager leaves in a folder it works in. Its "data" root is the server's
// data folder (fileManagerRoots.js, as in 1.4.5), and that root's Trash,
// .zcp-trash, sits at the top of it: made by the first delete there, by
// every edit or overwrite of a file there (the previous version is kept in
// it) and by a replacing upload, and never removed. An upload or a save in
// flight writes a temp file beside its target,
// .<name>.<pid>.<8 hex>.zcpupload or .zcptmp (fileManagerLocalFs.js
// createTempFile()), and a case-only rename moves the entry, a folder
// included, through .<name>.case.<8 hex>.zcptmp; one an interrupted request
// leaves stays until a later write into that folder sweeps it. So a 1.4.5
// Saves/Multiplayer data folder the File Manager had ever deleted or edited
// in, and a data folder with no world save yet, were refused everywhere.
// Each is let through as the kind of entry the File Manager makes (the Trash
// a folder, a temp a file, a case-rename temp either), by its exact name,
// and none ever counts as a game mode, a world or a world save.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FILE_MANAGER_TEMP_NAME = new RegExp(
  `^\\..+\\.(\\d+|case)\\.[0-9a-f]{8}(?:${escapeRegExp(UPLOAD_TEMP_SUFFIX)}|${escapeRegExp(RENAME_TEMP_SUFFIX)})$`,
);

function isFileManagerName(name) {
  return name === TRASH_DIR_NAME || FILE_MANAGER_TEMP_NAME.test(name);
}

function isFileManagerEntry(name, stat) {
  if (name === TRASH_DIR_NAME) return stat.isDirectory();
  const temp = FILE_MANAGER_TEMP_NAME.exec(name);
  if (!temp) return false;
  return stat.isFile() || (temp[1] === "case" && stat.isDirectory());
}

// Links are followed, as everywhere in the rule; null when the entry can't
// be looked at (a dangling link), which no check lets through.
function statOf(entryPath) {
  try {
    return fs.statSync(entryPath);
  } catch {
    return null;
  }
}

// SECURITY (2026-10-05, PT1 verifier round 2): "nothing in it but what the
// game puts in a data folder" was judged by name alone, so a folder whose
// entries merely carried the game's names passed whatever they were and
// held -- another program's Saves/slot1/notes.txt, Logs/ and mods/, say.
// Each entry is now the kind the game makes (one of its folders a folder,
// one of its files a file), and a Saves folder holds what the game keeps
// there: game mode folders, each holding world folders (what a world holds
// is the world-save check's business). The panel's File Manager entries are
// let through at each of those levels, as above.
function holdsOnlyGameEntries(folder, names) {
  return names.every((name) => {
    if (OS_FOLDER_ENTRIES.has(name)) return true;
    const stat = statOf(path.join(folder, name));
    if (!stat) return false;
    if (isFileManagerEntry(name, stat)) return true;
    if (!stat.isDirectory()) return stat.isFile() && isGameDataFileName(name);
    if (!GAME_DATA_FOLDERS.has(name)) return false;
    return name !== "Saves" || holdsOnlyFolders(path.join(folder, name), 2);
  });
}

// `depth` levels of nothing but folders (and the OS's and the File
// Manager's own entries); an unreadable folder doesn't pass.
function holdsOnlyFolders(folder, depth) {
  let names;
  try {
    names = fs.readdirSync(folder);
  } catch {
    return false;
  }
  return names.every((name) => {
    if (OS_FOLDER_ENTRIES.has(name)) return true;
    const entry = path.join(folder, name);
    const stat = statOf(entry);
    if (!stat) return false;
    if (isFileManagerEntry(name, stat)) return true;
    if (!stat.isDirectory()) return false;
    return depth <= 1 || holdsOnlyFolders(entry, depth - 1);
  });
}

function hasPathShape(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= ZOMBOID_DATA_PATH_MAX_LENGTH &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function isOperatorDataPath(resolved) {
  const configured = process.env.PZ_SAVE_PATH;
  if (!configured || !path.isAbsolute(configured)) return false;
  const own = path.resolve(configured);
  return process.platform === "win32"
    ? own.toLowerCase() === resolved.toLowerCase()
    : own === resolved;
}

// The rule's on-disk half, for an absolute, resolved path. Links are
// followed (statSync, readdirSync), so a link is judged by the folder it
// leads to.
function holdsGameFolders(folder, names) {
  if (!names.includes("Saves")) return false;
  const isFolder = (name) => statOf(path.join(folder, name))?.isDirectory() === true;
  if (!isFolder("Saves")) return false;
  // Saves/ must still hold only what the game keeps there (game mode folders
  // holding world folders): another program's Saves/slot1/notes.txt is refused.
  if (!holdsOnlyFolders(path.join(folder, "Saves"), 2)) return false;
  return names.filter((name) => name !== "Saves" && GAME_DATA_FOLDERS.has(name) && isFolder(name)).length >= 2;
}

function judgeFolder(resolved) {
  if (isOperatorDataPath(resolved)) return { ok: true, missing: false };
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, missing: true };
    return { ok: false, reason: "unreadable" };
  }
  if (!stat.isDirectory()) return { ok: false, reason: "not-a-directory" };
  let names;
  try {
    names = fs.readdirSync(resolved);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  // The common case first: a data folder the game has run in holds a world
  // save under Saves/.
  if (holdsWorldSave(resolved, names)) return { ok: true, missing: false };
  const verdict = inspectZomboidPath(resolved);
  if (verdict.reason === "install-folder") return { ok: false, reason: "install-folder" };
  // Save files directly in the folder (a world save folder), not its
  // hasSaveArtifacts: that one also looks inside every folder just under
  // this one, so any folder holding, say, some-project/map/ passed, whatever
  // else it held (PATHS-1 verifier pass). A real data folder's save files
  // sit under Saves/, which the check above already accepts.
  if (holdsSaveFiles(resolved, names)) return { ok: true, missing: false };
  if (holdsOnlyGameEntries(resolved, names)) return { ok: true, missing: false };
  // A data folder the game has run in, with other things beside its own:
  // a Saves folder plus at least two more of the game's folders, each a real
  // folder. Strict "nothing but game entries" refused real installs (v1.4.9:
  // "the panel no longer recognizes the Zomboid folder") because the folder
  // also held a file or folder this list doesn't know, from the game itself,
  // a mod or the user. Another program's folder doesn't have Saves/, Lua/,
  // db/ and Server/ together.
  if (holdsGameFolders(resolved, names)) return { ok: true, missing: false };
  // A Saves/Multiplayer folder named directly, as Map Cleanup's custom path
  // and "Save as default" allow (its hint names this shape, and
  // routes/chunks.js's resolveSavesPath() reads one): named as the game
  // names it, and nothing in it but world saves. Counting save files only
  // directly in the folder (the first PATHS-1 verifier pass) stopped one
  // holding saves from passing, while an empty one still did (verifier
  // pass 2). Both halves count: the name alone is any
  // .../Saves/Multiplayer folder, and "every folder in it has save files"
  // alone is any folder of projects that each have a map/ folder. Judged
  // entry by entry, so one that also holds anything else is still refused.
  return isSavesMultiplayerFolder(resolved) && multiplayerFolderHoldsOnlyWorlds(resolved, names)
    ? { ok: true, missing: false }
    : { ok: false, reason: "not-a-data-folder" };
}

// SECURITY (2026-10-05, PT1): a Saves or Multiplayer folder used to be
// enough on its own (existsSync(), which on Windows and macOS also matched
// "saves" or "SAVES"), and so was any folder named like a save file, "map"
// included. The panel itself creates folders inside a data folder (backups/,
// Server/ ...), and a data folder that doesn't exist yet is accepted, so a
// technician saved <folder>/Saves as one, opened Backups (which created
// <folder>/Saves/backups), and then saved <folder> itself, whatever else it
// held. Such a folder counts now only when it holds what the game writes
// there: a world save -- a folder holding save files (holdsSaveFiles(), the
// files themselves, by their exact names) -- in Saves/<game mode>/, or in
// Multiplayer/ when the data folder named is a Saves folder. Names are
// compared as the folder lists them, never through existsSync(). Nothing
// the panel creates holds save files, so nothing it creates counts.
//
// SECURITY (2026-10-05, PT1 verifier round 1): what the game writes counts
// only where the game writes a world. A server's data folder is the game's
// -cachedir, so a technician who saves <folder>/Saves (missing, so
// accepted) and starts the server has the game create its own folders --
// Lua, db, mods, Server ... -- where the rule looks for game modes, and
// with <folder>/Saves/x, where it looks for worlds. In Lua/ a server-side
// mod writes files by any name it likes (getFileOutput() checks only for
// ".."), map_t.bin included, and a local mod in mods/ writes into its own
// folder. A real game mode or world is never named like one of the game's
// own data-folder entries (modes are Sandbox, Apocalypse, Multiplayer ...;
// a dedicated server's world is named after the server), so a folder named
// like one never counts as either. Nor does one the panel's File Manager
// names (PT2 verifier round 2).
function holdsWorldSave(folder, names) {
  if (names.includes("Saves")) {
    const saves = path.join(folder, "Saves");
    // Multiplayer first: a dedicated server's own world is there.
    const modes = listNames(saves)
      .filter(isWorldOrModeName)
      .sort((a, b) => (b === "Multiplayer") - (a === "Multiplayer"));
    if (modes.some((mode) => folderHoldsAWorld(path.join(saves, mode)))) return true;
  }
  return names.includes("Multiplayer") && folderHoldsAWorld(path.join(folder, "Multiplayer"));
}

function folderHoldsAWorld(folder) {
  return listNames(folder).some((name) => isWorldSaveFolder(folder, name));
}

function isWorldOrModeName(name) {
  return !isGameDataFolderEntry(name) && !isFileManagerName(name);
}

function isWorldSaveFolder(folder, name) {
  return isWorldOrModeName(name) && holdsSaveFiles(path.join(folder, name));
}

function listNames(folder) {
  try {
    return fs.readdirSync(folder);
  } catch {
    return [];
  }
}

// Exactly as the game names them (ZomboidFileSystem.getSaveDir() is
// getCacheDirSub("Saves"), and a multiplayer world goes in its
// Core.gameMode "Multiplayer" folder) and as resolveSavesPath() matches them.
//
// SECURITY (2026-10-05, W5-P1): the names were compared as the stored path
// spells them. 1.4.5 stored a data folder as it was typed, and Windows and
// macOS ignore letter case, so a record whose data folder reads
// ...\saves\multiplayer is the game's own Saves\Multiplayer folder -- yet
// it was refused after the update, and every feature for that server with
// it. A name spelled as the game spells it still matches; one spelled in
// another letter case matches only when the folder is listed in its parent
// under the game's name (a listing carries the real case, macOS's
// included) and the path leads to that same folder (carriesGameName()). On
// a case-sensitive file system such a path leads to no folder, or to a
// folder of its own, so matching stays exact there.
//
// SECURITY (2026-10-05, W5-P1 verifier round 1): and a name spelled as the
// game spells it matched by its spelling alone, so on Windows and macOS a
// folder listed as saves\multiplayer -- someone else's, the game names its
// own Saves\Multiplayer -- still passed when the path spelled it the game's
// way. The name a folder is listed under is what counts now, however the
// path spells it. Only a folder that isn't there (or a parent that can't be
// listed) still goes by the path's spelling: nothing in it to judge yet.
export function isSavesMultiplayerFolder(folder) {
  const resolved = path.resolve(folder);
  return carriesGameName(resolved, "Multiplayer") && carriesGameName(path.dirname(resolved), "Saves");
}

export function carriesGameName(folder, gameName) {
  const given = path.basename(folder);
  if (given.toLowerCase() !== gameName.toLowerCase()) return false;
  const listed = onDiskName(folder);
  return listed === null ? given === gameName : listed === gameName;
}

// The name `folder` is listed under in its parent folder: as spelled, or
// the entry of another letter case the path leads to; null when there is
// none.
function onDiskName(folder) {
  const parent = path.dirname(folder);
  const given = path.basename(folder);
  const names = listNames(parent);
  if (names.includes(given)) return given;
  const lower = given.toLowerCase();
  return names.find((name) => name.toLowerCase() === lower && isSameFolder(folder, path.join(parent, name))) ?? null;
}

// Whether two paths lead to the same folder: the same real path on Windows
// (fs.realpathSync.native() gives the real letter case there), the same
// device and inode elsewhere (an inode of 0, which some network file
// systems report for everything, proves nothing).
function isSameFolder(first, second) {
  try {
    if (!fs.statSync(first).isDirectory()) return false;
    if (process.platform === "win32") {
      return fs.realpathSync.native(first) === fs.realpathSync.native(second);
    }
    const a = fs.statSync(first, { bigint: true });
    const b = fs.statSync(second, { bigint: true });
    return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

// What the game keeps in Saves/Multiplayer: one folder per world save --
// a dedicated server's own (named after the server, save files in it), and
// on a machine that also plays, the client's per-server cache, which
// ConnectToServerState names "<id>_<name>_player", the id a Java long the
// server sends (read off the B42 jar). The OS's own entries are let through
// as above.
//
// PT2 verifier round 2: and the two other names the B42 jar gives a cache --
// GameClient.doConnect()'s "<host>_<port>_<hash>" (the hash
// ServerWorldDatabase.encrypt()'s lower-case MD5 hex, empty for an empty
// input), the one real client caches carry, and CoopMaster's
// "<server>_player" -- each also as IngameState's "<folder>_crash" copy.
// A cache the game has saved into counts as a world save either way; these
// only let one through before it has.
const MULTIPLAYER_PLAYER_CACHE_FOLDERS = [/^.+_player(?:_crash)?$/, /^.+_\d{1,5}_(?:[0-9a-f]{32})?(?:_crash)?$/];

// SECURITY (2026-10-05, PT2): what the panel itself creates in a
// Saves/Multiplayer folder. Map Cleanup's "Save as default" stored one as a
// server's data folder in 1.4.5, and the panel then created backups/ in it
// (the Backups page, and Map Cleanup's delete-with-backup backups,
// backups/<save>_chunks_<stamp> and backups/<save>_region_<stamp>), so after
// the update that server's data folder was refused everywhere. A restore
// leaves its staging folder (.restore-staging-<uuid>; <ms>-<pid> before
// 1.4.6) or the world it replaced (<world>.replaced-<ms>) next to the world
// in Saves/Multiplayer when it can't clean up. Let through, as the OS's
// entries are, but none of them counts as the world save the folder must
// hold: the panel makes them whatever the folder is.
//
// SECURITY (2026-10-05, PT2 verifier round 1): the panel also makes the
// server's config folder there. With no config folder set, a record's is
// <data folder>/Server, so the Server Config Templates dialog (1.4.5's GET
// /api/server-files/templates, and saving a template now) creates
// Server/templates, a start writes the RCON settings into Server/<name>.ini
// (ensureRconConfigured()), and an edit keeps its .bak copies in
// Server/backups. And PanelBridge's queue goes to <data folder>/Lua/
// panelbridge/<server>/ (inbox/, outbox/), created when the panel first
// sends the bridge a command. A 1.4.5 Saves/Multiplayer data folder holding
// either one was refused everywhere again. Both are let through, as
// folders only; neither ever counts as a world save.
const PANEL_MULTIPLAYER_FOLDER_ENTRIES = [
  /^backups$/,
  /^Server$/,
  /^Lua$/,
  /^\.restore-staging-[0-9a-f-]+$/,
  /^.+\.replaced-\d+$/,
];

// Folders, as the game and the panel make them. At least one must be a
// world save (save files in it); a player cache counts once the game has
// saved into it. The panel's own entries are looked at first, so none ever
// counts as the world save, not even one holding a world (a replaced world,
// a staging folder).
//
// SECURITY (2026-10-05, PT2 verifier round 1): and what the game writes in
// its own data folder, each as the kind of entry the game makes (a folder
// as a folder, a file as a file), never counted either. The panel starts the
// game with a server's data folder as its -cachedir, as 1.4.5 did, so once
// it has started a server whose data folder is a Saves/Multiplayer folder,
// the game's console.txt, server-console.txt, Logs/, db/ ... are in it too.
//
// SECURITY (2026-10-05, PT2 verifier round 2): and the File Manager's
// Trash and temps (isFileManagerEntry()), looked at before anything else,
// so neither ever counts as the world save.
function multiplayerFolderHoldsOnlyWorlds(folder, names) {
  let worlds = 0;
  for (const name of names) {
    if (OS_FOLDER_ENTRIES.has(name)) continue;
    const stat = statOf(path.join(folder, name));
    if (!stat) return false;
    if (isFileManagerEntry(name, stat)) continue;
    if (!stat.isDirectory()) {
      if (stat.isFile() && isGameDataFileName(name)) continue;
      return false;
    }
    if (PANEL_MULTIPLAYER_FOLDER_ENTRIES.some((pattern) => pattern.test(name))) continue;
    if (GAME_DATA_FOLDERS.has(name)) continue;
    if (isWorldSaveFolder(folder, name)) {
      worlds++;
    } else if (!MULTIPLAYER_PLAYER_CACHE_FOLDERS.some((pattern) => pattern.test(name))) {
      return false;
    }
  }
  return worlds > 0;
}

// SECURITY (2026-10-05, PT2 verifier round 1): the Zomboid folder a
// Saves/Multiplayer data folder sits in (two levels up), when that folder
// exists and meets the rule on its own -- or null. A 1.4.5 record whose data
// folder Map Cleanup's "Save as default" set to <Zomboid>/Saves/Multiplayer
// kept the config folder it had, <Zomboid>/Server, which isn't inside the
// data folder; and a server the game runs with <Zomboid> as its -cachedir
// writes its console log there. utils/serverConfigPath.js accepts a config
// folder under this one's Server folder too, and the console log is looked
// for here when the data folder holds none.
//
// SECURITY (2026-10-05, W5-P2): and for the two other folders "Save as
// default" stored as they were typed, which its hint named and
// resolveSavesPath() reads: a Saves folder (<Zomboid>/Saves) and a single
// world save (<Zomboid>/Saves/Multiplayer/<world>). Those records kept
// <Zomboid>/Server as well, and Server Files, Mods, the RCON settings and
// templates answered SERVER_CONFIG_PATH_OUTSIDE_DATA after the update. Each
// shape counts only as the game makes it: folders listed under the game's
// names (letter case as in isSavesMultiplayerFolder()), and a world save --
// save files, by their exact names -- in the Saves folder's Multiplayer
// folder, or in the world folder named, whose name isn't one of the game's
// own data-folder entries. Never for a data folder of no such shape, nor
// for a Zomboid folder that is missing or doesn't meet the rule on its own:
// then nothing outside the data folder is used. So it is always a folder
// that could have been named as the data folder itself.
export function zomboidFolderAround(dataPath) {
  if (!hasPathShape(dataPath) || !path.isAbsolute(dataPath)) return null;
  const root = mapCleanupShapeRoot(path.resolve(dataPath));
  if (!root || path.dirname(root) === root) return null;
  const verdict = judgeFolder(root);
  return verdict.ok && !verdict.missing ? root : null;
}

function mapCleanupShapeRoot(resolved) {
  // <Zomboid>/Saves/Multiplayer
  if (isSavesMultiplayerFolder(resolved)) return path.dirname(path.dirname(resolved));
  // <Zomboid>/Saves, its Multiplayer folder holding a world save
  if (carriesGameName(resolved, "Saves")) {
    const multiplayer = path.join(resolved, "Multiplayer");
    return listNames(resolved).includes("Multiplayer") && folderHoldsAWorld(multiplayer)
      ? path.dirname(resolved)
      : null;
  }
  // <Zomboid>/Saves/Multiplayer/<world>, a world save
  const multiplayer = path.dirname(resolved);
  if (!isSavesMultiplayerFolder(multiplayer)) return null;
  const world = onDiskName(resolved);
  return world && isWorldSaveFolder(multiplayer, world) ? path.dirname(path.dirname(multiplayer)) : null;
}

// Where the game writes a server's server-console.txt (and Logs/), for a
// data folder that meets the rule: the data folder itself, the game's
// -cachedir when the panel starts it -- unless it holds no console log and
// it is one of Map Cleanup's 1.4.5 shapes whose Zomboid folder
// (zomboidFolderAround()) holds one. A server the game runs with the
// Zomboid folder as its -cachedir writes it there; a 1.4.5 record Map
// Cleanup's "Save as default" repointed to a folder inside it is one.
const CONSOLE_LOG_FILE = "server-console.txt";

export function gameLogFolderOf(dataPath) {
  if (fs.existsSync(path.join(dataPath, CONSOLE_LOG_FILE))) return dataPath;
  const root = zomboidFolderAround(dataPath);
  return root && fs.existsSync(path.join(root, CONSOLE_LOG_FILE)) ? root : dataPath;
}

const NOT_A_DATA_FOLDER_MESSAGE =
  "This folder holds files the game doesn't keep in a Zomboid data folder, so it can't be a server's data folder. Choose the server's own data folder (the one with a world save in its Saves folder), an empty folder, or a folder that doesn't exist yet: the game creates it when the server first starts.";

/**
 * Save time: judge a data folder a request is about to store.
 *
 * `expand` (default true) applies normalizeUserPath() first (quotes, "~",
 * %VAR%/$VAR), as PUT /api/servers and chunks /save-path always have; the
 * install routes pass false because they use the value exactly as sent.
 * A value that names an environment variable must already exist: stored
 * as an expanded path that isn't there, it would hand the variable's value
 * back to anyone who can read the server's paths (env-var-expansion-oracle,
 * 2026-09-05). Error text only ever echoes the caller's own value.
 *
 * @returns {{ ok: true, path: string } | { ok: false, body: { error: string, code?: string } }}
 */
export function checkZomboidDataPath(value, { expand = true } = {}) {
  const raw = typeof value === "string" ? value : "";
  const target = expand ? normalizeUserPath(raw) : raw;
  if (!hasPathShape(raw) || !hasPathShape(target) || !path.isAbsolute(target)) {
    return {
      ok: false,
      body: {
        error: hasPathShape(raw)
          ? `Invalid Zomboid data path: ${raw}. Use the folder's full path.`
          : "Invalid Zomboid data path",
        code: ErrorCode.ZOMBOID_DATA_PATH_INVALID,
      },
    };
  }
  const resolved = path.resolve(target);
  const verdict = judgeFolder(resolved);
  if (verdict.ok && verdict.missing && expand && target !== normalizeUserPath(raw, { expandEnv: false })) {
    return {
      ok: false,
      body: {
        error: `Zomboid data path does not exist: ${raw}. Check for typos and verify the panel has read access to this folder.`,
      },
    };
  }
  if (verdict.ok) return { ok: true, path: resolved };
  if (verdict.reason === "not-a-directory") {
    return {
      ok: false,
      body: {
        error: `Zomboid data path is not a directory: ${raw}`,
        code: ErrorCode.ZOMBOID_DATA_PATH_INVALID,
      },
    };
  }
  return {
    ok: false,
    body: {
      error:
        verdict.reason === "install-folder"
          ? "This folder looks like a Project Zomboid server install, not a user data folder. Point at the Zomboid user data folder instead."
          : NOT_A_DATA_FOLDER_MESSAGE,
      code: ErrorCode.ZOMBOID_DATA_PATH_NOT_DATA_FOLDER,
    },
  };
}

/**
 * Use time: whether a data folder a feature is about to list or read under
 * still meets the rule. Takes the path as the feature will use it -- no
 * normalization.
 */
export function zomboidDataFolderHolds(dataPath) {
  if (!hasPathShape(dataPath) || !path.isAbsolute(dataPath)) return false;
  return judgeFolder(path.resolve(dataPath)).ok;
}

// The response body for a data folder refused at use time.
//
// SECURITY (2026-10-05, PT3 verifier round 1): its own code. With the
// save-time code (ZOMBOID_DATA_PATH_NOT_DATA_FOLDER) the client showed the
// save-time text, which doesn't say where to set the folder, wherever a
// feature refused a stored one (Mods, Console, the Servers page, the
// Dashboard's start warning, chunks, Server Files, backups).
export function zomboidDataFolderRefusal() {
  return {
    error:
      "This server's Zomboid data folder holds files the game doesn't keep in a data folder, so the panel won't list or read it. On the My Servers page, edit the server and set its Zomboid Data Path to the game's own data folder: the one with a world save in its Saves folder.",
    code: ErrorCode.ZOMBOID_DATA_FOLDER_REFUSED,
  };
}

// SECURITY (2026-10-05, PT5): the features that apply the rule at use time
// run on every request, and some of those are polled -- GET
// /api/backup/status applies it up to three times, every 15 s -- so a
// refused folder wrote the same warning over and over. Each line (it names
// the feature, the folder and the reason) is logged at warn the first time,
// then at debug. The set is capped so a long-running panel can't grow it
// without bound; clearing it only means a line warns once more.
const REPORTED_REFUSALS_MAX = 256;
const reportedRefusals = new Set();

export function logRefusalOnce(logger, line) {
  if (reportedRefusals.has(line)) {
    logger.debug(line);
    return;
  }
  if (reportedRefusals.size >= REPORTED_REFUSALS_MAX) reportedRefusals.clear();
  reportedRefusals.add(line);
  logger.warn(line);
}

// For log lines: a refusal body as one sentence with its code, which says
// what to set.
export function describeRefusal(body) {
  return `${body.error} [${body.code}]`;
}
