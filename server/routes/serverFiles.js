import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { createLogger } from "../utils/logger.js";
const log = createLogger("API:Files");
import { getActiveServer, getAllSettings, getRoleByName } from "../database/init.js";
import {
  sanitizeError,
  sanitizeErrorParams,
  SENSITIVE_FIELD_RE,
  omitSensitiveFields,
  maskSensitiveObject,
  isMaskedSecret,
} from "../utils/sanitize.js";
import {
  keepLiveSecretIniLines,
  maskSensitiveIniLines,
  reconcileMaskedIniLines,
  stripSensitiveIniLines,
} from "../utils/iniSecretLines.js";
import {
  INI_KEY_CAPABILITY,
  governedIniKeysChanged,
} from "../utils/iniKeyCapability.js";
import { withFileLock, writeFileAtomic } from "../utils/fileWriteQueue.js";
import {
  getBackupPath,
  createBackup,
  backupWarningFor,
  writeIniWithBackup,
  parseAnyBackupFilename,
} from "../utils/configBackup.js";
import {
  countSandboxBraces,
  editSandboxValues,
  escapeLuaString,
  findOverwrittenTableOpeners,
  isLuaIdentifier,
  sandboxSectionsFromLua,
  sectionsToEdits,
  validateSandboxLua,
} from "../utils/sandboxLua.js";
import { findDuplicateIniKeys } from "../utils/iniDuplicateKeys.js";
import {
  findIniFatalLines,
  iniValueChanges,
  javaTrimEnd,
  javaTrimStart,
  parseIniAsGame,
  readIniLineAsGame,
} from "../utils/iniGameView.js";
import { confineToRoots } from "../utils/browseRoots.js";
import { serverConfigDirRefusal, serverConfigPathIsConfined } from "../utils/serverConfigPath.js";
import {
  describeRefusal,
  logRefusalOnce,
  zomboidDataFolderHolds,
  zomboidDataFolderRefusal,
} from "../services/zomboidDataPath.js";
import {
  SFTP_CONFIG_PATH_KEY,
  acquireMirrorLock,
  beginRemoteConfigSession,
  getMirrorPath,
  isRemoteConfigConfigured,
  pushRemoteConfigFiles,
  retireRemoteWorldSandboxSnapshot,
  validateRemoteConfigTransport,
} from "../services/remoteConfigFiles.js";
import {
  requireStoppedForLocalConfigMutation,
  warnRunningForLocalConfigEdit,
} from "../services/configMutationGuard.js";
import { requirePermission } from "../services/permissions.js";
import { hostPathViewFor, worldSandboxSnapshotView } from "../utils/hostPathView.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { isHostKeyRefusal } from "../services/sftpHostKeys.js";
import {
  isServerFolderName,
  localGameDataDir,
  localWorldSandboxSnapshotPath,
  statLocalWorldSandboxSnapshot,
} from "../services/worldSandboxSnapshot.js";

const router = express.Router();

// INI/sandbox/spawn config editing, file backups/restore, and templates —
// "config" and "backups" are explicitly technician's job per the role
// brief; moderator has no server-config editing role. Applied once at the
// router level rather than per-route (25 endpoints). Previously any
// logged-in role, including moderator, could edit sandbox vars or restore
// a server file backup.
router.use(requirePermission("serverfiles.manage"));

// The server .ini keys that need server.configure on top of serverfiles.manage
// (INI_KEY_CAPABILITY, utils/iniKeyCapability.js) are checked by every route
// below that writes the .ini, not just PUT /ini: missingIniCapabilities()
// answers for the caller, governedIniKeysChanged() says which keys a write
// changes.
async function missingIniCapabilities(req, changedKeys) {
  if (changedKeys.length === 0) return [];
  const role = req.user ? await getRoleByName(req.user.role) : null;
  const held = Array.isArray(role?.capabilities) ? role.capabilities : [];
  return changedKeys
    .map((key) => ({ key, requiredCapability: INI_KEY_CAPABILITY[key] }))
    .filter(({ requiredCapability }) => !held.includes(requiredCapability));
}

function missingIniCapabilitiesBody(missing) {
  const detail = missing
    .map((m) => `"${m.key}" needs ${m.requiredCapability}`)
    .join(", ");
  return {
    error: `Cannot change ${detail} without holding that capability yourself.`,
    missing,
  };
}

// Thrown by getServerConfigPath()/getServerName() when no server is
// configured at all (no active server row, and no legacy settings fallback
// either) — every route below operates on a specific server's config
// directory (even /templates, which lives under it), so there is no
// meaningful response to give except "nothing is configured", never a
// fabricated default.
export class ServerNotConfiguredError extends Error {
  constructor() {
    super("No active server configured");
    this.code = ErrorCode.SERVER_NOT_CONFIGURED;
  }
}

// Thrown by getServerConfigPath() when the active server IS configured but
// is remote and its SFTP transport isn't — distinct from ServerNotConfiguredError
// (no server at all). Without this, getServerConfigPath() fell through to the
// local-path fallbacks below (which don't apply to a remote server) and ended
// up throwing ServerNotConfiguredError for a server that plainly IS configured,
// which is what the 404 SERVER_NOT_CONFIGURED response actually said. The
// second router.use() below already has the correct REMOTE_CONFIG_NOT_CONFIGURED
// handling for this exact case; it just never ran, because this function's own
// fallthrough answered first.
export class RemoteConfigNotConfiguredError extends Error {
  constructor() {
    super(
      "This server is remote. Add its SFTP details and the remote Server folder under Settings > PanelBridge to edit its configuration from here.",
    );
    this.code = ErrorCode.REMOTE_CONFIG_NOT_CONFIGURED;
  }
}

// These read or write the panel host's own filesystem, so an SFTP mirror of
// the remote Server/ folder cannot stand in for them.
const LOCAL_ONLY_PATHS = new Set(["/browse-files", "/image-preview"]);

// The path the guards in this file compare, matched the way Express routes
// it: case-insensitively and with or without a trailing slash (neither
// caseSensitive nor strict routing is on). Comparing req.path exactly let
// /RESTORE/x or /restore/x/ reach the restore handler without the "server
// must be stopped" gate (#193).
// Trailing slashes come off with a loop, not /\/+$/: that regex takes
// quadratic time on a long run of slashes that doesn't end the path, and
// req.path is whatever the caller sent.
export function guardPathOf(req) {
  const lowered = String(req.path || "").toLowerCase();
  let end = lowered.length;
  while (end > 0 && lowered[end - 1] === "/") end--;
  return lowered.slice(0, end) || "/";
}

export function isLocalOnlyPath(req) {
  return LOCAL_ONLY_PATHS.has(guardPathOf(req));
}

async function resolveRemoteConfigTransport() {
  const settings = await getAllSettings();
  if (!isRemoteConfigConfigured(settings)) return null;
  return validateRemoteConfigTransport({
    host: settings.panelBridgeSftpHost,
    port: settings.panelBridgeSftpPort,
    username: settings.panelBridgeSftpUsername,
    password: settings.panelBridgeSftpPassword,
    configPath: settings[SFTP_CONFIG_PATH_KEY],
  });
}

// Every route below resolves a specific server's config directory (directly,
// or via /templates living under it) -- and used to do it AGAIN, separately,
// several more times per request: this gate, the remote-mirror middleware
// below, and each of the ~20 handlers all called their own
// getActiveServer()-deriving helper independently. Each individual call was
// internally consistent (3f300f2a, 2026-09-07, already closed the WITHIN-
// one-call-site version of this -- getServerConfigPath()+getServerName()
// used to be two separate getActiveServer() reads, so "configPath from
// server A + name from server B" inside one handler was possible before that
// fix), but nothing made the SEPARATE call sites agree with EACH OTHER
// across one request's lifetime. getActiveServer() reads live, unlocked,
// mutable state; POST /:id/activate (routes/servers.js) mutates it under
// acquireLifecycleLock('server-profile-change', ...) -- a lock this router
// never acquires -- so a concurrent /activate is free to land in the real
// await points this file already has (this next() dispatch, the remote
// middleware's own getAllSettings() call, configMutationGuard's process
// scan). Concrete failure shape: the remote-mirror middleware below mirrors
// down server A's remote Server/ folder, a concurrent /activate lands, and a
// handler further down resolves server B's local path -- content prepared
// and validated against one server's shape gets written into a different
// server's actual files.
//
// Fixed by deriving ONCE, here, in the router's EARLIEST middleware (nothing
// registered above this one derives its own -- requirePermission() at the
// top of the file doesn't touch getActiveServer() at all), and hanging the
// result on req.activeServerContext for every downstream reader -- the
// remote-mirror middleware right below, and all handlers -- to share instead
// of re-deriving. This isn't blocking a concurrent /activate (the lifecycle
// lock already does that job for what IT protects, and grabbing it here
// would serialise every config read against every profile change for no
// reason, without even guaranteeing agreement if released mid-request); it's
// making every reader inside ONE request agree on which server they mean,
// which closes the window to zero regardless of what races it.
router.use(async (req, res, next) => {
  try {
    req.activeServerContext = await getActiveServerPaths();
  } catch (err) {
    if (err instanceof ServerNotConfiguredError) {
      return res.status(404).json({ error: err.message, code: err.code });
    }
    if (err instanceof RemoteConfigNotConfiguredError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    return next(err);
  }
  // SECURITY (2026-10-04, FILES-2 adversary pass): routes/servers.js only
  // checks a server's own config folder when it is saved, so one saved
  // before that check was still read and written here. A server record
  // whose config folder isn't inside its data folder's Server folder (the
  // same rule, utils/serverConfigPath.js) is refused by every Server Files
  // route until it is fixed in the server's settings. A remote server's
  // folder is the panel's own SFTP mirror.
  //
  // SECURITY (2026-10-05, PATHS-2): that check ran only when the record
  // had both folders, so a record with a config folder and no data folder,
  // and the legacy settings copy of the config folder (used when the record
  // has neither), were let through. It now judges the folder this request
  // will actually use against the data folder in effect (the record's,
  // else the legacy setting); with no data folder to anchor it, it is
  // refused. A folder derived as <data>/Server always passes.
  //
  // SECURITY (2026-10-05, PATHS-1): every route here reads or writes under
  // that data folder, so it is held to the data-folder rule
  // (services/zomboidDataPath.js) again here, where it is used.
  //
  // PT5 (verifier round 2): every Server Files request comes through here,
  // several per page load, so each refusal is logged at warn once per
  // folder, then at debug.
  const { activeServer, serverConfigPath, zomboidDataPath } = req.activeServerContext;
  if (!activeServer?.isRemote) {
    const refusal = localServerFolderRefusal(req.activeServerContext);
    if (refusal) {
      logRefusalOnce(
        log,
        `Refusing Server Files access to ${serverConfigPath || "the default config folder"} (Zomboid data folder: ${zomboidDataPath || "not set"}): ${describeRefusal(refusal)}`,
      );
      return res.status(400).json(refusal);
    }
  }
  next();
});

// The folder rule above, for a local server's folders as
// getActiveServerPaths() resolves them: the config folder inside the data
// folder in effect's Server folder (FILES-2, PATHS-2), and that data folder
// meeting the data-folder rule (PATHS-1). The refusal body, or null when
// both are usable. persistSandboxValues() applies it too: PanelBridge's
// writes never pass through this router.
function localServerFolderRefusal({ serverConfigPath, zomboidDataPath }) {
  if (!serverConfigPathIsConfined(serverConfigPath, zomboidDataPath)) {
    return serverConfigDirRefusal({ reason: "outside-data" });
  }
  if (!zomboidDataFolderHolds(zomboidDataPath)) {
    return zomboidDataFolderRefusal();
  }
  return null;
}

// A remote server has no local filesystem, but its Server/ folder is reachable
// over the SFTP credentials PanelBridge already uses. Mirror it in before the
// handler runs and push back whatever the handler changed, so every existing
// local-filesystem handler below works unmodified.
router.use(async (req, res, next) => {
  const { activeServer, serverName } = req.activeServerContext;
  if (!activeServer?.isRemote) return next();

  if (isLocalOnlyPath(req)) {
    return res.status(400).json({
      error:
        "Browsing the server filesystem is not available for remote servers.",
      code: ErrorCode.REMOTE_BROWSE_NOT_AVAILABLE,
    });
  }

  let transport;
  try {
    transport = await resolveRemoteConfigTransport();
  } catch (err) {
    return res.status(400).json({ error: sanitizeError(err.message) });
  }
  if (!transport) {
    return res.status(400).json({
      code: "REMOTE_CONFIG_NOT_CONFIGURED",
      error:
        "This server is remote. Add its SFTP details and the remote Server folder under Settings > PanelBridge to edit its configuration from here.",
    });
  }

  const release = await acquireMirrorLock();
  let session;
  try {
    session = await beginRemoteConfigSession(transport, serverName, {
      fresh: req.method !== "GET",
    });
  } catch (err) {
    release();
    log.error(`Remote config pull failed: ${err.message}`);
    const error = `Could not read the remote server config folder: ${sanitizeError(err.message)}`;
    // A refused host key gets the same code and guidance as the PanelBridge
    // SFTP routes, which point to Settings > PanelBridge > SFTP.
    return res.status(502).json({
      error,
      ...(isHostKeyRefusal(err)
        ? { code: ErrorCode.SFTP_HOST_KEY_MISMATCH, params: sanitizeErrorParams({ detail: error }) }
        : {}),
    });
  }

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    void (async () => {
      try {
        if (req.method !== "GET" && res.statusCode < 400) {
          await pushRemoteConfigFiles(transport, serverName, session);
        }
      } catch (err) {
        log.error(`Remote config push failed: ${err.message}`);
      } finally {
        release();
      }
    })();
  };
  const watchdog = setTimeout(finish, 60000);
  watchdog.unref?.();
  res.on("finish", finish);
  res.on("close", finish);
  // For the handlers that reach past Server/: the session also says whether
  // the world save has a map_sand.bin (#197).
  req.remoteConfigTransport = transport;
  req.remoteConfigSession = session;
  next();
});

// Ordinary edits to one of these files. The original justification for
// BLOCKING all of these outright while the server ran was the assumption
// that PZ rewrites its config files on shutdown and would discard a live
// edit — measured 2026-08-23 against a real B42 dedicated server (clean RCON
// `quit`, the same path server.js's POST /stop uses): a clean shutdown
// touches NEITHER SandboxVars.lua NOR the server .ini at all (byte-identical
// mtime/hash before and after), and the next startup rewrites both but
// PRESERVES an edit made on disk while the server was running — measured,
// not assumed. "PUT /sandbox-option" was the first removed on that evidence
// alone (a stuck-forever refusal was a real, reported bug).
//
// For these remaining nine, the operator has since RULED (2026-08-23, his
// own knowledge of the game, not derived from the measurement above): edits
// are always allowed while the server runs; a write just does not reach the
// live game until the next restart. That ruling is what changed the
// behavior below from "refuse" to "allow and say so" — the measurement only
// established that a clean shutdown/startup cycle doesn't lose the edit,
// which is necessary for the ruling to be safe but isn't by itself a claim
// about every route below applying live or requiring a restart uniformly.
// See warnRunningForLocalConfigEdit() in configMutationGuard.js for the
// mechanism, and each handler's own response for where restartRequired is
// attached.
//
// HONEST CAVEAT for whoever reads this next: the measurement covers a B42
// server only, both a clean RCON `quit` and a hard `taskkill /F` force-stop
// (dwight, 2026-08-23, replicating serverManager.stopServer()'s actual
// mechanism) — both behave identically for this question: neither rewrites
// either file, both preserve an edit made on disk while running, and
// startup afterward rewrites-but-preserves in both cases. Two things remain
// genuinely untested: a B41 server (no B41 dedicated-server install was
// available to test against), and whether a kill landing mid-write could
// corrupt an in-flight write specifically (no write was ever caught in
// flight in either session, clean or forced). The operator's ruling covers
// all of this from his own experience running these servers and outranks
// one narrow experiment — but it IS judgement layered on top of
// measurement, not measurement alone, and the two should stay
// distinguishable here.
const LOCAL_CONFIG_MUTATIONS = new Set([
  "PUT /ini",
  "PUT /sandbox",
  "POST /sandbox/repair",
  "PUT /spawnpoints",
  "PUT /spawnregions",
  "PUT /raw/ini",
  "PUT /raw/sandbox",
  "PUT /raw/spawnpoints",
  "PUT /raw/spawnregions",
]);

// A wholesale file replacement, not an edit: applying a template or
// restoring a backup overwrites everything in one of these files at once,
// without the operator reviewing each changed value the way a form save
// implies. The operator's "edits are fine while running" ruling above was
// about editing, and the 2026-08-23 measurement says nothing about whether
// the running game tolerates one of its own open config files being
// replaced wholesale underneath it — a restore in particular is the one
// operation where getting that wrong destroys the very thing the operator
// was trying to protect. Left gated (409 while running) deliberately,
// pending its own evidence rather than inheriting the edit ruling by
// assumption.
// Retiring the world's map_sand.bin belongs here too: it swaps which copy of
// every sandbox setting the next start uses, all at once (#197).
// Both checks match the path the way Express's routing does (guardPathOf):
// /RESTORE/x and /restore/x/ reach the same handler as /restore/x, so they
// must meet the same gate (#193).
function isWorldSandboxSnapshotRetire(req) {
  return req.method === "POST" && guardPathOf(req) === "/sandbox/world-snapshot/retire";
}

function isLocalConfigOverwrite(req) {
  const routePath = guardPathOf(req);
  if (req.method === "POST" && /^\/templates\/[^/]+\/apply$/.test(routePath)) {
    return true;
  }
  if (isWorldSandboxSnapshotRetire(req)) {
    return true;
  }
  return req.method === "POST" && /^\/restore\/[^/]+$/.test(routePath);
}

function isLocalConfigEdit(req) {
  return LOCAL_CONFIG_MUTATIONS.has(`${req.method} ${guardPathOf(req)}`);
}

export function isLocalConfigMutation(req) {
  return isLocalConfigEdit(req) || isLocalConfigOverwrite(req);
}

export {
  requireStoppedForLocalConfigMutation,
  isLocalConfigEdit,
  isLocalConfigOverwrite,
};
router.use((req, res, next) => {
  if (isLocalConfigOverwrite(req)) {
    // A remote server's map_sand.bin is on its host, reached over the
    // mirror session above, and its handler refuses while the server's
    // RCON answers. The local check scans this computer's processes and,
    // for a remote profile whose local paths are set but absent here,
    // answers SERVER_STATE_UNKNOWN about a server it was never going to
    // see (#197).
    if (req.remoteConfigSession && isWorldSandboxSnapshotRetire(req)) return next();
    return requireStoppedForLocalConfigMutation(req, res, next);
  }
  if (isLocalConfigEdit(req)) {
    return warnRunningForLocalConfigEdit(req, res, next);
  }
  return next();
});

// Get the server config directory path. Not exported -- see
// getActiveServerPaths()'s own comment below; this exists only for that
// function (and its own remote branch's internal call to getServerName()
// below) to compose from, never for a handler to call directly.
async function getServerConfigPath() {
  const activeServer = await getActiveServer();

  // A remote server's Server/ folder lives on the host; the handlers below
  // work against its local SFTP mirror instead.
  if (activeServer?.isRemote) {
    const transport = await resolveRemoteConfigTransport();
    if (transport) {
      return getMirrorPath(transport, await getServerName());
    }
  }

  // First, use explicitly configured serverConfigPath if available
  if (activeServer?.serverConfigPath) {
    return activeServer.serverConfigPath;
  }

  // Fallback to zomboidDataPath + Server
  if (activeServer?.zomboidDataPath) {
    return path.join(activeServer.zomboidDataPath, "Server");
  }

  // Fallback to legacy settings
  const settings = await getAllSettings();
  if (settings.serverConfigPath) {
    return settings.serverConfigPath;
  }
  if (settings.zomboidDataPath) {
    return path.join(settings.zomboidDataPath, "Server");
  }

  // A remote server with no usable path anywhere (SFTP transport unresolved
  // above, and no local/legacy path fallback either) is a DIFFERENT
  // situation from no server at all — it IS configured, just not reachable
  // yet. Previously this fell all the way through to ServerNotConfiguredError
  // below, which made the router's dedicated REMOTE_CONFIG_NOT_CONFIGURED
  // gate further down unreachable for exactly the case it exists to catch.
  if (activeServer?.isRemote) {
    throw new RemoteConfigNotConfiguredError();
  }

  // Nothing configured anywhere — no active server row and no legacy
  // settings fallback either. Do NOT default to ~/Zomboid/Server: that is
  // the vanilla path Project Zomboid itself uses, so on a machine that
  // happens to have a real (unrelated, never-added-to-the-panel) install
  // there, this would present its real data as the panel's "active server"
  // — invented, not merely empty.
  throw new ServerNotConfiguredError();
}

// Get server name from active server. serverName is interpolated directly
// into filesystem paths all over this file (`${serverName}.ini`, etc.), so a
// value containing "../" — e.g. written via a PUT /api/servers/:id that
// skipped validation — would let those paths escape the server config
// directory. path.basename() strips any directory component; if that
// changes the value at all, reject it outright rather than silently using
// a mangled name.
// Not exported -- same rule as getServerConfigPath() just above.
async function getServerName() {
  const activeServer = await getActiveServer();
  let raw;
  if (activeServer?.serverName) {
    raw = activeServer.serverName;
  } else {
    const settings = await getAllSettings();
    raw = settings.serverName;
  }
  if (!raw) {
    // No active server and no legacy settings name either — there is no
    // real server this could refer to. "servertest" used to fill in here,
    // which is how an empty database ended up presenting a fully-populated,
    // fully-editable server that was never configured.
    throw new ServerNotConfiguredError();
  }

  // "." and ".." pass the basename test but name a folder above or at the
  // save's own (Saves/Multiplayer/<name>, #197).
  if (!isServerFolderName(raw)) {
    throw new Error("Configured server name contains invalid path characters");
  }
  return raw;
}

// split-derivation sweep, 2026-09-07 (same class as /wipe's pre-fix bug,
// 5c2e73e9): getServerConfigPath() and getServerName() above are kept
// BYTE-IDENTICAL -- getServerConfigPath()'s own remote branch calls
// getServerName() internally (line 357), and a naive combined helper that
// eagerly derived both for every caller would change the router.use() gate's
// behavior: a LOCAL server with a fine configPath but no configured name
// would newly 404 at the gate instead of only failing later, inside a
// handler that actually needs the name. This is a NEW function used only by
// the ~17 call sites below that already call BOTH functions together --
// replicating both originals' exact fallback/throw behavior from a SINGLE
// getActiveServer() read instead of two, so a concurrent active-server
// switch between what used to be two separate calls can no longer produce
// e.g. serverConfigPath from server A + serverName from server B.
// Not exported (deliberately, 2026-09-08 quadruple-read sweep -- see the
// req.activeServerContext comment on the router.use() gate above): the only
// caller allowed to invoke this is that ONE gate middleware, which runs it
// once per request and hangs the result on req for everything downstream to
// share. Nothing outside this file ever imported it (checked before making
// this change), so removing `export` here makes a second, independent
// derivation elsewhere in this router a build-time ReferenceError instead of
// a silent, working-until-it-races bug the 26th call site quietly reopens.
async function getActiveServerPaths() {
  const activeServer = await getActiveServer();

  // serverName first -- getServerConfigPath()'s own remote branch needs it
  // to build the local SFTP mirror path, and every consolidated call site
  // needs both values together anyway.
  let serverName;
  // A legacy setup with no profile row keeps its data folder in the flat
  // settings: the world save (map_sand.bin, #197) is found under it.
  let legacyDataPath = null;
  if (activeServer?.serverName) {
    serverName = activeServer.serverName;
  } else {
    const settings = await getAllSettings();
    serverName = settings.serverName;
    if (!activeServer) legacyDataPath = settings.zomboidDataPath || null;
  }
  if (!serverName) {
    throw new ServerNotConfiguredError();
  }
  // "." and ".." pass a basename test but name a folder above or at the
  // world save's own (Saves/Multiplayer/<name>).
  if (!isServerFolderName(serverName)) {
    throw new Error("Configured server name contains invalid path characters");
  }
  const safeServerName = serverName;

  let serverConfigPath;
  if (activeServer?.isRemote) {
    const transport = await resolveRemoteConfigTransport();
    if (transport) {
      serverConfigPath = getMirrorPath(transport, safeServerName);
    }
  }
  if (!serverConfigPath && activeServer?.serverConfigPath) {
    serverConfigPath = activeServer.serverConfigPath;
  }
  if (!serverConfigPath && activeServer?.zomboidDataPath) {
    serverConfigPath = path.join(activeServer.zomboidDataPath, "Server");
  }
  // PATHS-2: the data folder in effect -- the record's, else the legacy
  // setting -- which the gate above holds serverConfigPath to.
  let zomboidDataPath = activeServer?.zomboidDataPath || null;
  if (!serverConfigPath || !zomboidDataPath) {
    const settings = await getAllSettings();
    if (!serverConfigPath) {
      if (settings.serverConfigPath) {
        serverConfigPath = settings.serverConfigPath;
      } else if (settings.zomboidDataPath) {
        serverConfigPath = path.join(settings.zomboidDataPath, "Server");
      }
    }
    zomboidDataPath = zomboidDataPath || settings.zomboidDataPath || null;
  }
  if (!serverConfigPath) {
    if (activeServer?.isRemote) {
      throw new RemoteConfigNotConfiguredError();
    }
    throw new ServerNotConfiguredError();
  }

  // zomboidDataPath: the data folder in effect (record, else legacy settings).
  // legacyDataPath: the settings one, only for a setup with no profile row
  // (services/worldSandboxSnapshot.js localGameDataDir()).
  return { activeServer, serverConfigPath, serverName: safeServerName, zomboidDataPath, legacyDataPath };
}

// Exposed ONLY so the existing unit tests that already verify these three
// functions' own fallback/error behavior in isolation
// (serverFilesGetServerName.test.js, serverFilesGetActiveServerPathsSingleRead.test.js)
// can keep doing so directly, without re-deriving that coverage through a
// full router request. A normal `import { getServerConfigPath } from
// "./serverFiles.js"` still fails -- that's the actual guarantee the
// removed `export` keywords above protect -- only a caller reaching in
// through this explicit, clearly-test-shaped name can still call them
// directly. Do not import this from a route handler.
export const __testOnlyDirectReads = {
  getServerConfigPath,
  getServerName,
  getActiveServerPaths,
};

// getBackupPath/createBackup/backupWarningFor moved to
// ../utils/configBackup.js (parameterized on configPath instead of calling
// getServerConfigPath() internally) so server/routes/mods.js's ini-rewriting
// routes can reuse the exact same backup logic. Imported below.

// Parse INI file to object
export function parseIni(content) {
  const result = {};
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      result[key] = value;
    }
  }

  return result;
}

// stripSensitiveIniLines / maskSensitiveIniLines / reconcileMaskedIniLines live
// in ../utils/iniSecretLines.js (with keepLiveSecretIniLines, which template
// apply uses); re-exported so this file's importers keep working.
export { stripSensitiveIniLines, maskSensitiveIniLines, reconcileMaskedIniLines };

// Convert object back to INI format
export function toIni(obj, originalContent = "") {
  // Preserve comments and order from original
  if (originalContent) {
    // Unconditionally joining with "\n" below used to silently convert an
    // entire CRLF-written file to LF on every structured save, even one
    // that changes a single field -- confirmed empirically (2026-08-29,
    // config-editing hunt). mods.js's own INI writers never have this
    // problem: they patch one line in place via regex-replace on the raw
    // string, so every OTHER line's original terminator survives by
    // construction. This file's split-then-rejoin approach needs to
    // preserve that terminator explicitly instead. PZ's own line reader is
    // very likely tolerant of either style, so this was probably cosmetic
    // for the engine itself -- but it's still a needless, avoidable
    // difference from the file's own prior state on every save, and the
    // asymmetry with mods.js's sibling writer on the SAME file is exactly
    // the shape worth closing rather than leaving to chance.
    //
    // Lines are split where the game splits them (BufferedReader.readLine:
    // "\r\n", "\n" or a lone "\r", see iniGameView.js), and each keeps its
    // own end. Splitting on "\n" alone took "A=1\rB=2", two options to the
    // game, for one line and rewrote it on an unrelated save as "A=1B=2".
    // A line this appends ends with the file's own style.
    const lineEnding = originalContent.includes("\r\n") ? "\r\n" : "\n";
    const pieces = originalContent.split(/(\r\n|\r|\n)/);
    const lines = pieces.filter((_, index) => index % 2 === 0);
    const lineEnds = pieces.filter((_, index) => index % 2 === 1);
    const result = [];
    const written = new Set();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
        result.push(line);
        continue;
      }

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.substring(0, eqIndex).trim();
        if (key in obj) {
          // Strip newlines from values to prevent INI injection
          const safeValue = String(obj[key]).replace(/[\r\n]/g, "");
          // A submitted value is the exact text that goes after "=" -- GET
          // /ini's rawSettings, not parseIni()'s trimmed one. The form sends
          // every key the file has on every save, so a line whose value and
          // key the game already reads as submitted stays byte-for-byte
          // (its indentation, and a value like " true" that the game rejects
          // but the operator didn't touch). Any other line is
          // rewritten as `Key=value`, keeping only its indentation: the game
          // reads no whitespace around "=" as part of the key or the value,
          // so re-adding the old line's " " here (as this used to) wrote
          // "Public= true" again when the operator switched Public on, and
          // "PVP = false" for a line the game skips. iniGameView.js has the
          // details; iniValueChanges() is the same test per key.
          const lineEqIndex = line.indexOf("=");
          const current = readIniLineAsGame(line, lineEqIndex);
          if (current.gameName === key && current.value === safeValue) {
            result.push(line);
          } else {
            const indent = line.slice(0, line.length - javaTrimStart(line).length);
            result.push(`${indent}${key}=${safeValue}`);
          }
          written.add(key);
        } else {
          result.push(line);
        }
      } else {
        result.push(line);
      }
    }

    // Add any new keys (only if they have a non-empty value)
    for (const [key, value] of Object.entries(obj)) {
      if (!written.has(key)) {
        // Skip empty values for keys that weren't in the original file
        if (value === "" || value === undefined || value === null) continue;
        // Validate key is a safe INI identifier
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          log.warn(`Invalid INI key skipped: ${key}`);
          continue;
        }
        const safeValue = String(value).replace(/[\r\n]/g, "");
        result.push(`${key}=${safeValue}`);
      }
    }

    // result holds one entry per original line, in order, then the appended
    // ones: original line i keeps lineEnds[i]; the last original line (which
    // had no end) and the appended lines are joined with lineEnding.
    return result
      .map((line, index) => (index === 0 ? line : `${lineEnds[index - 1] ?? lineEnding}${line}`))
      .join("");
  }

  // Generate from scratch
  return Object.entries(obj)
    .filter(([key]) => {
      if (obj[key] === "" || obj[key] === undefined || obj[key] === null) {
        return false;
      }
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        log.warn(`Invalid INI key skipped: ${key}`);
        return false;
      }
      return true;
    })
    .map(([key, value]) => {
      const safeValue = String(value).replace(/[\r\n]/g, "");
      return `${key}=${safeValue}`;
    })
    .join("\n");
}

// Parse SandboxVars.lua into the Server Config page's shape: { VERSION,
// settings: { top-level values }, ZombieLore: {...}, ..., <ModBlock>: {...} }.
// Every key is reported under the table it really lives in. A mod table's
// "Explosives = 1.0" used to come back as a top-level setting, and the page
// then saved it as one over a same-named top-level table (#197).
export function parseSandboxVars(content) {
  const { sandbox, error } = sandboxSectionsFromLua(content);
  if (error) {
    log.warn(`SandboxVars.lua does not parse (${error.message}); returning empty sections`);
  }
  return sandbox;
}

// Why an edit from editSandboxValues() was not written, for logs and API
// responses.
function describeSandboxEditStatus(status, error) {
  switch (status) {
    case "not-found":
      return "not present in SandboxVars.lua";
    case "table":
      return "is a table in SandboxVars.lua, not a single value";
    case "invalid-value":
      return "value must be true/false, a finite number or text";
    case "invalid-path":
      return "not a valid option name";
    default:
      return `SandboxVars.lua does not parse (${error?.message || "unknown error"})`;
  }
}

// Write one value into SandboxVars.lua in place. `nestedBlock` null means a
// top-level key. Returns the content unchanged when the key is not in the
// file, is a table, or the file does not parse (editSandboxValues() has the
// rules); only the value's own characters ever change.
export function modifySandboxValue(
  originalContent,
  key,
  newValue,
  nestedBlock = null,
) {
  const path = nestedBlock ? [nestedBlock, key] : [key];
  const result = editSandboxValues(originalContent, [{ path, value: newValue }]);
  const status = result.ok ? result.results[0].status : "unparseable";
  if (status !== "changed" && status !== "unchanged") {
    log.warn(
      `Sandbox value ${path.join(".")} not written: ${describeSandboxEditStatus(status, result.error)}`,
    );
  }
  return result.content;
}

// Count { / } in a SandboxVars.lua content string, skipping strings and
// comments (a mod tooltip comment with a brace in it is not corruption). A
// healthy file always has an equal number of each with the running depth
// never going negative. This catches the exact class of corruption PZ's own
// dedicated server crashes on: an orphaned/dropped block header that leaves
// a dangling closing brace (see "Exiting due to errors loading ..." crashes
// with a KahluaException "'}' expected"). validateSandboxLua() is the full
// check; this count still works on a file that does not parse.
export function checkSandboxBraceBalance(content) {
  return countSandboxBraces(content);
}

// Repair the damage #197 left in files: a table's opening line "<Name> = {"
// with its "{" overwritten by a value ("Explosives = 1"). The table's
// entries and its closing "}" are still below it, indented one level deeper,
// so the file has one "}" too many and the game refuses to load it.
//
// Repair: a "key = value" line with no trailing comma, followed by an entry
// indented deeper than it, gets "{" back in place of its value
// (findOverwrittenTableOpeners() has the exact rule). Nothing else in the
// file changes, line endings included. The value is dropped: it is what the
// old writer put over the "{", and the table under its real name is what the
// game reads. (This used to wrap the line in a synthetic
// "_RepairedBlockN = { ... }" table instead. The file then loaded, but the
// game found no table under the real name, so every option in it went back
// to its default and was dropped when the game next saved the file; a
// damaged "SandboxVars = 1" root line ended up inside the wrapper.)
//
// Lines are found on the tokenizer's tokens, not by matching text line by
// line: a long string or a --[[ ]] comment can hold a line that reads like
// "Speed = 2" above a deeper one, and putting a "{" there rewrote another
// option's text while the file still loaded. Nothing is written unless the
// result is a file the game loads (validateSandboxLua().valid).
export function repairSandboxSyntax(content) {
  const before = checkSandboxBraceBalance(content);
  if (before.balanced) {
    return { content, fixed: false, changes: [] };
  }

  const openers = findOverwrittenTableOpeners(content);
  const pieces = [];
  let at = 0;
  for (const { start, end } of openers) {
    pieces.push(content.slice(at, start), "{");
    at = end;
  }
  pieces.push(content.slice(at));
  const repaired = pieces.join("");
  const changes = openers.map(
    ({ line, key, value }) =>
      `Line ${line}: '${key} = ${value}' stood where the opening of the '${key}' table belongs — put its '{' back.`,
  );

  // Balanced braces are not enough to write it, and neither is parsing: the
  // result needs a SandboxVars table too. A file without one parses, but
  // the game finds nothing to load and exits on boot.
  const after = validateSandboxLua(repaired);
  return {
    content: repaired,
    fixed: after.valid && changes.length > 0,
    changes,
  };
}

// Apply the Server Config page's sections ({ settings: {...}, <Block>: {...} })
// to existing file content. Each value is written at its own path, only where
// the file already has that entry, and only when it differs: saving an
// untouched form leaves the file byte-for-byte as it was. `refused` lists the
// entries that were not written and why.
export function planSandboxChanges(originalContent, changes) {
  const edits = sectionsToEdits(changes);
  const result = editSandboxValues(originalContent, edits);
  const refused = [];
  result.results.forEach((r, i) => {
    if (r.status === "changed" || r.status === "unchanged") return;
    const { section, key } = edits[i];
    refused.push({
      name: section === "settings" ? key : `${section}.${key}`,
      status: r.status,
      reason: describeSandboxEditStatus(r.status),
    });
  });
  return { ...result, refused };
}

// Same as planSandboxChanges(), content only.
export function applySandboxChanges(originalContent, changes) {
  return planSandboxChanges(originalContent, changes).content;
}

// planSandboxChanges() writes only entries the file already has, and refuses
// a value over a table. Compares `submitted` (the request body's `sandbox`
// object) against `persisted` (the freshly re-parsed on-disk content, via
// parseSandboxVars -- the same reader the writer uses) and returns the keys
// that were requested but did not land, formatted as "key" for top-level
// settings or "Section.key" for a block.
export function findUnpersistedSandboxKeys(submitted, persisted) {
  const own = (obj, key) =>
    obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key)
      ? obj[key]
      : undefined;
  return sectionsToEdits(submitted)
    .filter(({ section, key, value }) => own(own(persisted, section), key) !== value)
    .map(({ section, key }) => (section === "settings" ? key : `${section}.${key}`));
}

function createSandboxVars(sandbox) {
  const sections = [
    "settings",
    "ZombieLore",
    "ZombieConfig",
    "MultiplierConfig",
    "Map",
    "Basement",
  ];
  const lines = ["SandboxVars = {"];
  const version = Number.isInteger(sandbox.VERSION) ? sandbox.VERSION : 4;
  lines.push(`    VERSION = ${version},`);

  const formatValue = (value) => {
    if (typeof value === "boolean") return String(value);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return `"${escapeLuaString(String(value))}"`;
  };

  for (const sectionName of sections) {
    const values = sandbox[sectionName];
    if (!values || typeof values !== "object") continue;

    if (sectionName === "settings") {
      for (const [key, value] of Object.entries(values)) {
        if (isLuaIdentifier(key)) {
          lines.push(`    ${key} = ${formatValue(value)},`);
        }
      }
      continue;
    }

    lines.push(`    ${sectionName} = {`);
    for (const [key, value] of Object.entries(values)) {
      if (isLuaIdentifier(key)) {
        lines.push(`        ${key} = ${formatValue(value)},`);
      }
    }
    lines.push("    },");
  }

  lines.push("}");
  return lines.join("\n") + "\n";
}

// Parse spawn points lua - handles profession-based structure
function parseSpawnPoints(content) {
  const professions = {};

  try {
    // First, find profession blocks like: unemployed = { ... }
    // The format is: professionName = { { worldX = ..., ... }, { worldX = ..., ... } }
    const professionPattern = /(\w+)\s*=\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
    let profMatch;

    while ((profMatch = professionPattern.exec(content)) !== null) {
      const profName = profMatch[1];
      const profContent = profMatch[2];

      // Skip 'return' as it's not a profession
      if (profName === "return") continue;

      const points = [];
      // Match spawn point entries - posZ is optional
      const pointPattern =
        /\{\s*worldX\s*=\s*(\d+)\s*,\s*worldY\s*=\s*(\d+)\s*,\s*posX\s*=\s*([\d.]+)\s*,\s*posY\s*=\s*([\d.]+)(?:\s*,\s*posZ\s*=\s*(\d+))?\s*\}/g;
      let pointMatch;

      while ((pointMatch = pointPattern.exec(profContent)) !== null) {
        points.push({
          worldX: parseInt(pointMatch[1], 10),
          worldY: parseInt(pointMatch[2], 10),
          posX: parseFloat(pointMatch[3]),
          posY: parseFloat(pointMatch[4]),
          posZ: pointMatch[5] ? parseInt(pointMatch[5], 10) : 0,
        });
      }

      if (points.length > 0) {
        professions[profName] = points;
      }
    }
  } catch (error) {
    log.error("Failed to parse spawn points:", error);
  }

  return professions;
}

// Convert spawn points to Lua - handles profession-based structure
function toSpawnPoints(professions, serverName) {
  const lines = [`function SpawnPoints()`];
  lines.push(`\treturn {`);

  for (const [profName, points] of Object.entries(professions)) {
    // Validate profession name is a safe Lua identifier
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(profName)) {
      log.warn(`Invalid profession name skipped in spawnpoints: ${profName}`);
      continue;
    }
    lines.push(`\t\t${profName} = {`);
    for (const p of points) {
      // Validate coordinates are finite numbers to prevent Lua injection
      const wx = Number.isFinite(Number(p.worldX)) ? Number(p.worldX) : 0;
      const wy = Number.isFinite(Number(p.worldY)) ? Number(p.worldY) : 0;
      const px = Number.isFinite(Number(p.posX)) ? Number(p.posX) : 0;
      const py = Number.isFinite(Number(p.posY)) ? Number(p.posY) : 0;
      const pz = Number.isFinite(Number(p.posZ)) ? Number(p.posZ) : 0;
      if (pz && pz !== 0) {
        lines.push(
          `\t\t\t{ worldX = ${wx}, worldY = ${wy}, posX = ${px}, posY = ${py}, posZ = ${pz} }`,
        );
      } else {
        lines.push(
          `\t\t\t{ worldX = ${wx}, worldY = ${wy}, posX = ${px}, posY = ${py} }`,
        );
      }
    }
    lines.push(`\t\t}`);
  }

  lines.push(`\t}`);
  lines.push(`end`);
  return lines.join("\n");
}

// Parse spawn regions lua
function parseSpawnRegions(content) {
  const regions = [];

  try {
    // Match patterns like { name = "Muldraugh, KY", file = "path" } or { name = "...", serverfile = "..." }
    // Handle both 'file' and 'serverfile' keys
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      // Skip comments
      if (line.trim().startsWith("--")) continue;

      // Try to match file or serverfile
      const nameMatch = line.match(/name\s*=\s*"([^"]+)"/);
      const fileMatch = line.match(/(?:server)?file\s*=\s*"([^"]+)"/);

      if (nameMatch && fileMatch) {
        regions.push({
          name: nameMatch[1],
          file: fileMatch[1],
          isServerFile: line.includes("serverfile"),
        });
      }
    }
  } catch (error) {
    log.error("Failed to parse spawn regions:", error);
  }

  return regions;
}

// Convert spawn regions to Lua
function toSpawnRegions(regions, serverName) {
  const lines = [`function SpawnRegions()`];
  lines.push(`        return {`);

  for (const r of regions) {
    const safeName = escapeLuaString(r.name);
    const safeFile = escapeLuaString(r.file);
    if (r.isServerFile) {
      lines.push(
        `                { name = "${safeName}", serverfile = "${safeFile}" },`,
      );
    } else {
      lines.push(
        `                { name = "${safeName}", file = "${safeFile}" },`,
      );
    }
  }

  lines.push(`        }`);
  lines.push(`end`);
  return lines.join("\n");
}

// ===== ROUTES =====

// SECURITY (2026-10-05, H4 round 3): serverfiles.manage edits the config
// files but doesn't set the server's folders up, and GET /api/servers
// already gave a custom role holding only it the placeholder for the config
// folder. This route and the file routes below still answered with it. A
// role without the host-path capabilities (utils/hostPathView.js) now gets
// the config folder as the placeholder and each file by name, like GET
// /raw/:type's `filename`. GET /browse-files and /image-preview name
// folders the same way for that role since HT3: by a root id and the path
// below it (browseRefFor() below).
// Get server file paths info
router.get("/paths", async (req, res) => {
  try {
    log.info("GET /paths");
    const { serverConfigPath: configPath, serverName } = req.activeServerContext;

    const files = {
      ini: path.join(configPath, `${serverName}.ini`),
      sandbox: path.join(configPath, `${serverName}_SandboxVars.lua`),
      spawnpoints: path.join(configPath, `${serverName}_spawnpoints.lua`),
      spawnregions: path.join(configPath, `${serverName}_spawnregions.lua`),
    };

    const exists = {
      ini: fs.existsSync(files.ini),
      sandbox: fs.existsSync(files.sandbox),
      spawnpoints: fs.existsSync(files.spawnpoints),
      spawnregions: fs.existsSync(files.spawnregions),
    };

    const view = await hostPathViewFor(req.user);
    res.json({
      configPath: view.folder(configPath),
      serverName,
      files: Object.fromEntries(Object.entries(files).map(([kind, file]) => [kind, view.file(file)])),
      exists,
    });
  } catch (error) {
    log.error("Failed to get paths:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get INI file (parsed)
router.get("/ini", async (req, res) => {
  try {
    const { serverConfigPath: configPath, serverName } = req.activeServerContext;
    const filePath = path.join(configPath, `${serverName}.ini`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: "INI file not found",
        code: ErrorCode.INI_FILE_NOT_FOUND,
      });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = parseIni(content);

    // A key appearing more than once means `settings` below silently holds
    // whichever occurrence parseIni()'s last-write-wins loop landed on --
    // not necessarily the one the operator thinks they're editing, and not
    // necessarily the one mods.js's own (first-occurrence) reads/writes
    // agree with. Reported, not blocked: the file is still readable, and
    // refusing to load it would lock the operator out of the only tool
    // that could help them fix it. See utils/iniDuplicateKeys.js.
    const duplicateKeys = findDuplicateIniKeys(content);

    // This is the LIVE config, unlike a template snapshot -- mask rather
    // than omit, since the structured editor's PUT /ini round-trips this
    // same object back and toIni() only preserves a key's original line
    // when the key is ABSENT from the submitted settings, not when it's
    // present-but-blank. Omitting here would make every unrelated field
    // edit look like "delete the RCON password" once it reached PUT.
    //
    // `settings` stays parseIni()'s trimmed reading for its other reader
    // (CreateTemplateDialog's capture). The Server Settings
    // form edits `rawSettings` instead: the same keys with each value as the
    // game reads it (" true" stays " true"), plus `misnamedKeys` for the
    // lines the game skips ("Public = true"). It sends those raw values back,
    // which is what lets toIni() keep an untouched line byte-for-byte.
    //
    // `fatalLines`: the lines that make the game ignore the whole file and
    // run on every default ("= x", see findIniFatalLines); the form can't
    // show them, so it says so and points at the raw editor.
    // `maskedCutAtEqualsKeys`: the masked secrets whose value has an "=",
    // which the game cuts there (an RCONPassword "ab=cd" is "ab" to it). The
    // form warns from the value itself for every other key; for these it
    // only has the mask, so it gets the key and never the value.
    const gameView = parseIniAsGame(content);
    res.json({
      settings: maskSensitiveObject(parsed),
      rawSettings: maskSensitiveObject(gameView.values),
      misnamedKeys: gameView.misnamed,
      fatalLines: findIniFatalLines(content),
      maskedCutAtEqualsKeys: Object.keys(gameView.values).filter(
        (key) => SENSITIVE_FIELD_RE.test(key) && gameView.values[key].includes("="),
      ),
      path: (await hostPathViewFor(req.user)).file(filePath),
      serverName,
      duplicateKeys,
    });
  } catch (error) {
    log.error("Failed to read INI:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Save INI file
router.put("/ini", async (req, res) => {
  try {
    const { serverConfigPath: configPath, serverName } = req.activeServerContext;
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
    log.info(
      `PUT /ini: serverName=${serverName}, keys=${Object.keys(body.settings || {}).length}`,
    );
    const filePath = path.join(configPath, `${serverName}.ini`);
    const { settings } = body;

    if (!settings || typeof settings !== "object") {
      return res.status(400).json({
        error: "Settings object required",
        code: ErrorCode.INI_SETTINGS_REQUIRED,
      });
    }

    // Guard against prototype pollution
    if (
      Object.prototype.hasOwnProperty.call(settings, "__proto__") ||
      Object.prototype.hasOwnProperty.call(settings, "constructor") ||
      Object.prototype.hasOwnProperty.call(settings, "prototype")
    ) {
      return res.status(400).json({
        error: "Invalid settings",
        code: ErrorCode.INI_SETTINGS_INVALID,
      });
    }

    // A key duplicated across two config blocks makes the structured save
    // silently destructive (see utils/iniDuplicateKeys.js's own header):
    // toIni() below reconstructs the file from this flat settings object,
    // rewriting EVERY line matching a submitted key to that key's one
    // value -- and since every key is always present (the client resends
    // the whole object on every save), that fires on EVERY save, even one
    // that never touched this key, permanently discarding whichever copy
    // parseIni()'s last-occurrence-wins didn't surface. Refuse outright
    // rather than risk it; the raw tab is a genuine escape hatch for the
    // exact same caller (same serverfiles.manage gate, no extra
    // restriction, mirrored identically for a remote/SFTP server -- not in
    // LOCAL_ONLY_PATHS) and round-trips the file byte-for-byte instead of
    // reconstructing it, so it stays available to fix the duplicate first.
    const currentIniContent = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, "utf-8")
      : "";
    const duplicateKeysOnDisk = findDuplicateIniKeys(currentIniContent);
    if (duplicateKeysOnDisk.length > 0) {
      return res.status(409).json({
        error:
          "This file has a key duplicated across two config blocks. Saving from the structured editor would permanently discard one copy's value. Use the raw editor tab to fix the duplicate first.",
        duplicateKeys: duplicateKeysOnDisk,
        code: ErrorCode.INI_DUPLICATE_KEY_BLOCKS_STRUCTURED_SAVE,
      });
    }

    // GET /ini masks secret-shaped values, so an unmodified field echoes
    // back here as the "••••••••1234" placeholder rather than the real
    // password -- never let that placeholder overwrite the stored value.
    // Same skip-write-if-masked-echoed-back guard as config.js/oidc.js/
    // servers.js already use; dropping the key here (rather than passing
    // it through) is what makes toIni() below preserve the live line
    // unchanged, since toIni() only overwrites keys present in `settings`.
    const submittedSettings = {};
    for (const [key, value] of Object.entries(settings)) {
      if (SENSITIVE_FIELD_RE.test(key) && isMaskedSecret(value)) {
        log.info(`Preserving stored value for sensitive key "${key}" (masked input ignored)`);
        continue;
      }
      submittedSettings[key] = value;
    }

    // Enforced on CHANGE, not presence: the structured editor round-trips
    // GET /ini's whole settings object back on every save (same trap
    // Angela hit in this same editor for the RCON-masking fix above), so
    // gating on mere presence would refuse every non-admin save that
    // touches this tab at all. Compared against the file's own CURRENT
    // value, never GET's masked response -- and as the game reads it, the
    // same test toIni() uses to decide whether it rewrites the line, so a
    // line it would rewrite (even "RCONPort =27015" to "RCONPort=27015",
    // which the game then reads for the first time) always needs the
    // capability.
    const touchesGovernedIniKey = Object.keys(submittedSettings).some(
      (key) => Object.hasOwn(INI_KEY_CAPABILITY, key),
    );
    if (touchesGovernedIniKey) {
      const currentIni = parseIniAsGame(currentIniContent);
      const changedGovernedKeys = Object.entries(submittedSettings)
        .filter(([key]) => Object.hasOwn(INI_KEY_CAPABILITY, key))
        .filter(([key, value]) => iniValueChanges(currentIni, key, value))
        .map(([key]) => key);
      const missingCapabilities = await missingIniCapabilities(req, changedGovernedKeys);
      if (missingCapabilities.length > 0) {
        return res.status(403).json(missingIniCapabilitiesBody(missingCapabilities));
      }
    }

    // Read original to preserve comments/structure. Locked per-path so two
    // overlapping PUTs to the same INI can't interleave their read-modify-write.
    let backupWarning = null;
    const persistedSettings = await withFileLock(filePath, async () => {
      let originalContent = "";
      if (fs.existsSync(filePath)) {
        originalContent = fs.readFileSync(filePath, "utf-8");
        backupWarning = backupWarningFor(await createBackup(configPath, `${serverName}.ini`));
      }

      const content = toIni(submittedSettings, originalContent);
      writeFileAtomic(filePath, content, "utf-8");
      const persistedContent = fs.readFileSync(filePath, "utf-8");
      // Verified as the game will read it: the key's line is one the game
      // reads under that name, holding the submitted text (less what the
      // game's line trim drops from its end).
      const persisted = parseIniAsGame(persistedContent);
      const original = parseIniAsGame(originalContent).values;
      for (const [key, value] of Object.entries(submittedSettings)) {
        const isExistingKey = Object.prototype.hasOwnProperty.call(original, key);
        const isNewNonEmptyKey = value !== "" && value !== null && value !== undefined;
        const expected = javaTrimEnd(String(value).replace(/[\r\n]/g, ""));
        if (
          (isExistingKey || isNewNonEmptyKey) &&
          (persisted.values[key] !== expected ||
            Object.prototype.hasOwnProperty.call(persisted.misnamed, key))
        ) {
          throw new Error(`INI write verification failed for ${key}`);
        }
      }
      return parseIni(persistedContent);
    });

    log.info("Saved INI file");
    res.json({
      success: true,
      message: "Settings saved",
      path: (await hostPathViewFor(req.user)).file(filePath),
      settings: maskSensitiveObject(persistedSettings),
      ...(backupWarning ? { backupWarning } : {}),
      ...(req.configEditRestartWarning ? { restartRequired: true } : {}),
    });
  } catch (error) {
    log.error("Failed to save INI:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// The world save's own copy of the sandbox settings (#197). Build 42 loads
// SandboxVars.lua, then SandboxOptions.load() reads map_sand.bin from the
// save and applies every option in it on top, on every start. Only the
// single-player save path (Lua saveGame()) writes it -- a vanilla dedicated
// server never does, PanelBridge did on each live edit until #197 -- so once
// it exists, edits to SandboxVars.lua (this editor, the in-game admin panel)
// are undone at the next start. Without it the game falls back to
// SandboxVars.lua. The save is under the data folder the server starts with
// (-cachedir); localWorldSandboxSnapshotPath() (services/worldSandboxSnapshot.js)
// finds it the way the start does, default folder included, and only in a
// folder that meets the data-folder rule (PATHS-1). A record whose folders
// the gate above refuses never gets this far. A remote server's save is
// checked over SFTP by the mirror session.
// { path, mtime } when this world has a map_sand.bin, else null.
async function findWorldSandboxSnapshot(req) {
  if (req.activeServerContext.activeServer?.isRemote) {
    return req.remoteConfigSession?.worldSandboxSnapshot ?? null;
  }
  return statLocalWorldSandboxSnapshot(localWorldSandboxSnapshotPath(req.activeServerContext));
}

// Get SandboxVars (parsed)
router.get("/sandbox", async (req, res) => {
  try {
    const { serverConfigPath: configPath, serverName } = req.activeServerContext;
    const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: "SandboxVars file not found",
        code: ErrorCode.SANDBOXVARS_FILE_NOT_FOUND,
      });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    // A file that does not parse, or has no SandboxVars table, comes back as
    // empty sections plus `parseError`, so the page can still open (the INI
    // tab shares it) and PUT /sandbox refuses to edit it.
    const { sandbox, error: parseError } = sandboxSectionsFromLua(content);
    const worldSandboxSnapshot = await findWorldSandboxSnapshot(req);

    res.json({
      sandbox,
      path: (await hostPathViewFor(req.user)).file(filePath),
      serverName,
      ...(parseError ? { parseError } : {}),
      ...(worldSandboxSnapshot ? { worldSandboxSnapshot: await worldSandboxSnapshotView(req.user, worldSandboxSnapshot) } : {}),
    });
  } catch (error) {
    log.error("Failed to read SandboxVars:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Save SandboxVars
router.put("/sandbox", async (req, res) => {
  try {
    log.info("PUT /sandbox");
    const { serverConfigPath: configPath, serverName } = req.activeServerContext;
    const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);
    const { sandbox } = req.body || {};

    if (!sandbox || typeof sandbox !== "object") {
      return res.status(400).json({
        error: "Sandbox object required",
        code: ErrorCode.SANDBOX_OBJECT_REQUIRED,
      });
    }

    // Guard against prototype pollution
    if (
      Object.prototype.hasOwnProperty.call(sandbox, "__proto__") ||
      Object.prototype.hasOwnProperty.call(sandbox, "constructor") ||
      Object.prototype.hasOwnProperty.call(sandbox, "prototype")
    ) {
      return res.status(400).json({
        error: "Invalid sandbox data",
        code: ErrorCode.SANDBOX_DATA_INVALID,
      });
    }

    // Guard nested sections against prototype pollution
    for (const section of Object.values(sandbox)) {
      if (section && typeof section === "object") {
        if (
          Object.prototype.hasOwnProperty.call(section, "__proto__") ||
          Object.prototype.hasOwnProperty.call(section, "constructor") ||
          Object.prototype.hasOwnProperty.call(section, "prototype")
        ) {
          return res.status(400).json({
            error: "Invalid sandbox data",
            code: ErrorCode.SANDBOX_DATA_INVALID,
          });
        }
      }
    }

    // Size limit: reject payloads > 1MB
    const payloadSize = JSON.stringify(sandbox).length;
    if (payloadSize > 1024 * 1024) {
      return res.status(400).json({
        error: "Sandbox data too large (max 1MB)",
        code: ErrorCode.SANDBOX_DATA_TOO_LARGE,
      });
    }

    // Modify an existing file in-place to preserve comments and structure.
    // On a fresh server, create a valid sandbox file from the submitted schema
    // values so the editor works before the game's first boot.
    let fileExists;
    let backupWarning = null;
    let unpersistedKeys = [];
    let parseError = null;
    await withFileLock(filePath, async () => {
      fileExists = fs.existsSync(filePath);
      let newContent;
      let unchanged = false;
      if (fileExists) {
        const originalContent = fs.readFileSync(filePath, "utf-8");
        const plan = planSandboxChanges(originalContent, sandbox);
        if (!plan.ok) {
          parseError = plan.error;
          return;
        }
        if (plan.refused.length > 0) {
          log.warn(
            `Sandbox values not written: ${plan.refused.map((r) => `${r.name} (${r.reason})`).join(", ")}`,
          );
        }
        newContent = plan.content;
        // Nothing to change: no backup, no rewrite. A rewrite would also turn
        // bytes that are not valid UTF-8 (a file saved from a cp1252 editor)
        // into U+FFFD.
        unchanged = newContent === originalContent;
      } else {
        newContent = createSandboxVars(sandbox);
        const check = validateSandboxLua(newContent);
        if (!check.valid) {
          parseError = check.error;
          return;
        }
      }
      if (!unchanged) {
        if (fileExists) {
          backupWarning = backupWarningFor(
            await createBackup(configPath, `${serverName}_SandboxVars.lua`),
          );
        }
        writeFileAtomic(filePath, newContent, "utf-8");
      }

      // Without this read-back, a key the writer couldn't place was silently
      // dropped and this route still reported success (this route's own PUT
      // /ini sibling already verifies its writes this way; this route did
      // not). Same reader as the writer, so a value refused over a table
      // shows up here too.
      const persisted = parseSandboxVars(fs.readFileSync(filePath, "utf-8"));
      unpersistedKeys = findUnpersistedSandboxKeys(sandbox, persisted);
    });

    if (parseError) {
      log.warn(`PUT /sandbox refused, SandboxVars.lua does not parse: ${parseError.message}`);
      return res.status(422).json({
        error: `SandboxVars.lua can't be edited safely (${parseError.message}). Fix it in the raw editor, run the repair under Checks & Fixes, or restore a backup. Nothing was written.`,
        code: ErrorCode.SANDBOX_FILE_UNPARSEABLE,
        params: sanitizeErrorParams({ detail: parseError.message }),
      });
    }
    if (unpersistedKeys.length > 0) {
      log.warn(`SandboxVars keys did not persist: ${unpersistedKeys.join(", ")}`);
    }
    log.info(`${fileExists ? "Saved" : "Created"} SandboxVars file`);
    // The save landed, but a world with map_sand.bin will not use it.
    const worldSandboxSnapshot = await findWorldSandboxSnapshot(req);
    res.json({
      success: true,
      created: !fileExists,
      message: fileExists ? "Sandbox settings saved" : "SandboxVars file created",
      path: (await hostPathViewFor(req.user)).file(filePath),
      ...(unpersistedKeys.length > 0 ? { unpersistedKeys } : {}),
      ...(backupWarning ? { backupWarning } : {}),
      ...(req.configEditRestartWarning ? { restartRequired: true } : {}),
      ...(worldSandboxSnapshot ? { worldSandboxSnapshot: await worldSandboxSnapshotView(req.user, worldSandboxSnapshot) } : {}),
    });
  } catch (error) {
    log.error("Failed to save SandboxVars:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Write one option into SandboxVars.lua. Mod options live in blocks the
// sandbox schema knows nothing about, so they are addressed as "Block.Key" and
// rewritten in place; a key that is not already in the file is left alone,
// since PZ regenerates those from the mod's own defaults.
router.put("/sandbox-option", async (req, res) => {
  try {
    const { name, value } = req.body || {};

    if (typeof name !== "string" || !name) {
      return res.status(400).json({
        error: "Option name required",
        code: ErrorCode.SANDBOX_OPTION_NAME_REQUIRED,
      });
    }
    if (!["string", "number", "boolean"].includes(typeof value)) {
      return res.status(400).json({
        error: "Option value must be a primitive",
        code: ErrorCode.SANDBOX_OPTION_VALUE_INVALID,
      });
    }

    const parts = name.split(".");
    const isIdentifier = (p) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p);
    if (parts.length > 2 || !parts.every(isIdentifier)) {
      return res.status(400).json({
        error: "Invalid option name",
        code: ErrorCode.SANDBOX_OPTION_NAME_INVALID,
      });
    }
    const block = parts.length === 2 ? parts[0] : null;
    const key = parts.length === 2 ? parts[1] : parts[0];

    const { serverConfigPath: configPath, serverName } = req.activeServerContext;
    const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error:
          "SandboxVars file not found. Start the server once to generate it.",
        code: ErrorCode.SANDBOX_OPTION_FILE_NOT_FOUND,
      });
    }

    let persisted = false;
    let reason = null;
    let backupWarning = null;
    await withFileLock(filePath, async () => {
      const originalContent = fs.readFileSync(filePath, "utf-8");
      const result = editSandboxValues(originalContent, [
        { path: block ? [block, key] : [key], value },
      ]);
      const status = result.ok ? result.results[0].status : "unparseable";
      if (status === "unchanged") {
        // Already what the file says; nothing to write, nothing lost.
        persisted = true;
        return;
      }
      if (status !== "changed") {
        reason = describeSandboxEditStatus(status, result.error);
        return;
      }
      backupWarning = backupWarningFor(
        await createBackup(configPath, `${serverName}_SandboxVars.lua`),
      );
      writeFileAtomic(filePath, result.content, "utf-8");
      persisted = true;
    });

    log.info(
      `Sandbox option ${name} persisted: ${persisted}${reason ? ` (${reason})` : ""}`,
    );
    // Mod Settings writes here after each live edit. A PanelBridge older
    // than #197 has just written map_sand.bin for that edit (saveGame()),
    // so say whether the world has one now, as PUT /sandbox does.
    const worldSandboxSnapshot = await findWorldSandboxSnapshot(req);
    res.json({
      success: true,
      persisted,
      ...(reason ? { reason } : {}),
      ...(backupWarning ? { backupWarning } : {}),
      ...(worldSandboxSnapshot ? { worldSandboxSnapshot: await worldSandboxSnapshotView(req.user, worldSandboxSnapshot) } : {}),
    });
  } catch (error) {
    log.error("Failed to save sandbox option:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Write top-level sandbox keys straight to disk. The in-game bridge can only
// change SandboxOptions in memory, so without this every change is lost on the
// next server start.
// Called from routes/panelBridge.js, not from this router's own request
// pipeline -- there is no single HTTP request here for req.activeServerContext
// to belong to, so this deliberately keeps its own independent
// getActiveServer()-deriving reads (getServerName()/getActiveServerPaths()
// below) rather than reading from req like every handler in this file now
// does. Not an exception to the quadruple-read fix; outside its scope
// entirely -- there's nothing else in the same request to disagree with.
export async function persistSandboxValues(values) {
  const entries = Object.entries(values || {});
  if (entries.length === 0) return { persisted: false, reason: "nothing to do" };

  const activeServer = await getActiveServer();
  // Called from the PanelBridge routes, outside the mirror middleware, so a
  // remote server has to pull and push around its own write. As there, the
  // write goes to the panel's own mirror of the remote Server/ folder; the
  // local folders a remote record names are never used.
  if (activeServer?.isRemote) {
    const transport = await resolveRemoteConfigTransport();
    if (!transport) {
      return { persisted: false, reason: "remote server filesystem" };
    }
    const serverName = await getServerName();
    const release = await acquireMirrorLock();
    try {
      const session = await beginRemoteConfigSession(transport, serverName, {
        fresh: true,
      });
      const result = await writeSandboxValues(entries, session.mirrorDir, serverName);
      if (result.persisted) {
        await pushRemoteConfigFiles(transport, serverName, session);
      }
      return result;
    } catch (err) {
      return { persisted: false, reason: sanitizeError(err.message) };
    } finally {
      release();
    }
  }

  try {
    const context = await getActiveServerPaths();
    // SECURITY (2026-10-05, PR #200 review): the router's gate never sees
    // this write (POST /panel-bridge/utilities/restore and /shutoff, under
    // server.world_events), so it applies the gate's folder rule itself. A
    // config folder Server Config refuses is neither written nor backed up.
    const refusal = localServerFolderRefusal(context);
    if (refusal) {
      logRefusalOnce(
        log,
        `Not writing sandbox values to ${context.serverConfigPath} (Zomboid data folder: ${context.zomboidDataPath || "not set"}): ${describeRefusal(refusal)}`,
      );
      return { persisted: false, reason: refusal.error };
    }
    return await writeSandboxValues(entries, context.serverConfigPath, context.serverName);
  } catch (err) {
    if (err instanceof ServerNotConfiguredError) {
      return { persisted: false, reason: "no server configured" };
    }
    throw err;
  }
}

async function writeSandboxValues(entries, configPath, serverName) {
  const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);
  if (!fs.existsSync(filePath)) {
    return { persisted: false, reason: "SandboxVars.lua not found" };
  }

  let persisted = false;
  let reason = null;
  await withFileLock(filePath, async () => {
    const originalContent = fs.readFileSync(filePath, "utf-8");
    const result = editSandboxValues(
      originalContent,
      entries.map(([key, value]) => ({ path: [key], value })),
    );
    if (!result.ok) {
      reason = describeSandboxEditStatus("unparseable", result.error);
      return;
    }

    // Only existing top-level entries are rewritten, so a key that isn't in
    // the file (or only exists inside some block) would no-op and look like
    // "already correct". All or nothing: a partial utilities write would
    // leave power and its modifier disagreeing.
    const refused = new Map();
    for (const r of result.results) {
      if (r.status === "changed" || r.status === "unchanged") continue;
      refused.set(r.status, [...(refused.get(r.status) || []), r.path.join(".")]);
    }
    if (refused.size > 0) {
      reason = [...refused]
        .map(([status, keys]) => `${keys.join(", ")}: ${describeSandboxEditStatus(status)}`)
        .join("; ");
      return;
    }

    const content = result.content;
    if (content === originalContent) {
      // SandboxVars.lua already holds these values: nothing to write, and
      // nothing a restart undoes (PUT /sandbox-option says the same).
      persisted = true;
      return;
    }
    const backupWarning = backupWarningFor(
      await createBackup(configPath, `${serverName}_SandboxVars.lua`),
    );
    writeFileAtomic(filePath, content, "utf-8");
    persisted = true;
    // persisted stays true -- the edit is intentional and did happen; the
    // caller (PanelBridge) still needs to see the backup failure though.
    if (backupWarning) reason = backupWarning;
  });

  return { persisted, reason };
}

// Check whether the game can load SandboxVars.lua: it has to parse (the same
// tokenizer every editor here uses) and its braces have to balance. A corrupt
// file here is a classic cause of "server won't boot, no obvious reason"
// reports.
router.get("/sandbox/validate", async (req, res) => {
  try {
    const { serverConfigPath: configPath, serverName } = req.activeServerContext;
    const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: "SandboxVars file not found",
        code: ErrorCode.SANDBOXVARS_FILE_NOT_FOUND,
      });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const { valid, depth, error } = validateSandboxLua(content);
    res.json({ valid, braceDepth: depth, ...(error ? { parseError: error.message } : {}) });
  } catch (error) {
    log.error("Failed to validate SandboxVars:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Attempt to auto-repair SandboxVars.lua. Refuses to write anything unless
// BOTH the repaired content is a file the game loads (it parses and has a
// SandboxVars table) AND a real backup of the broken file was made first —
// if the corruption doesn't match a known repair pattern, or the backup
// can't be created, nothing is written and the caller is told exactly why
// and what to do about it. This route
// rewrites an already-corrupted file with a heuristic the repair function
// itself admits can miss (see repairSandboxSyntax's own comment) -- with no
// backup, a wrong result has no way back, so this is the one call site in
// this file that refuses rather than proceeding on a failed backup.
router.post("/sandbox/repair", async (req, res) => {
  try {
    log.info("POST /sandbox/repair");
    const { serverConfigPath: configPath, serverName } = req.activeServerContext;
    const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: "SandboxVars file not found",
        code: ErrorCode.SANDBOXVARS_FILE_NOT_FOUND,
      });
    }

    const result = await withFileLock(filePath, async () => {
      const originalContent = fs.readFileSync(filePath, "utf-8");
      // "Already valid" means the game loads it: it parses and has a
      // SandboxVars table.
      if (validateSandboxLua(originalContent).valid) {
        return { alreadyValid: true };
      }

      const {
        content: repaired,
        fixed,
        changes,
      } = repairSandboxSyntax(originalContent);
      if (!fixed) {
        return {
          alreadyValid: false,
          repaired: false,
          error:
            "Could not automatically repair this file — the corruption doesn't match a known pattern. Restore from a backup or fix it manually.",
          code: ErrorCode.SANDBOX_REPAIR_PATTERN_UNKNOWN,
        };
      }

      const backup = await createBackup(configPath, `${serverName}_SandboxVars.lua`);
      if (!backup.backedUp) {
        // reason === "no-source" can't happen here (existsSync already
        // confirmed the file above), so this is always the "failed" case.
        return {
          alreadyValid: false,
          repaired: false,
          error:
            `Could not back up SandboxVars.lua before repairing it, so nothing was changed: ${backup.error}. ` +
            "Free up disk space or fix the backups folder's permissions, or copy the file aside yourself, then try again.",
          code: ErrorCode.SANDBOX_REPAIR_BACKUP_FAILED,
          params: { reason: backup.error },
        };
      }

      writeFileAtomic(filePath, repaired, "utf-8");
      return { alreadyValid: false, repaired: true, changes, backupName: backup.name };
    });

    if (result.alreadyValid) {
      return res.json({
        success: true,
        alreadyValid: true,
        message: "SandboxVars.lua is already valid — no repair needed.",
      });
    }
    if (!result.repaired) {
      const body = { success: false, error: result.error, code: result.code };
      if (result.params) body.params = sanitizeErrorParams(result.params);
      return res.status(422).json(body);
    }

    log.info(
      `Repaired SandboxVars.lua: ${result.changes.length} fix(es) applied`,
    );
    res.json({
      success: true,
      repaired: true,
      changes: result.changes,
      message: `Repaired ${result.changes.length} issue${result.changes.length === 1 ? "" : "s"} in SandboxVars.lua. A backup of the broken file was saved first (${result.backupName}).`,
      ...(req.configEditRestartWarning ? { restartRequired: true } : {}),
    });
  } catch (error) {
    log.error("Failed to repair SandboxVars:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Move the world's map_sand.bin out of the save, so every start from now on
// uses SandboxVars.lua (#197). Refused while the server runs
// (isLocalConfigOverwrite). Nothing is deleted: the file goes to the config
// backups folder under a name GET /backups doesn't list, since restoring it
// from there would put it in Server/, where the game never reads it. With no
// map_sand.bin, SandboxOptions.load() falls back to SandboxVars.lua, and
// neither the server's save nor its quit writes the file again (42.21, live);
// only Lua saveGame() does, e.g. a live edit through a pre-#197 PanelBridge.
// A remote server's file moves the same way over SFTP, into the backups
// folder of its Server/ folder on the host.
const WORLD_SANDBOX_SNAPSHOT_UNAVAILABLE_BODY = {
  error:
    "The panel can't tell where this server's world save is, so it can't reach its map_sand.bin. Set the server's data folder. For a remote server, the remote Server folder under Settings > PanelBridge must be the game's Server folder.",
  code: ErrorCode.WORLD_SANDBOX_SNAPSHOT_UNAVAILABLE,
};
const NO_WORLD_SANDBOX_SNAPSHOT_BODY = {
  success: true,
  retired: false,
  message: "This world has no map_sand.bin, so it already uses SandboxVars.lua.",
};
const WORLD_SANDBOX_SNAPSHOT_RETIRED_MESSAGE =
  "map_sand.bin was moved out of the world save. The next start uses SandboxVars.lua.";

async function retireRemoteWorldSandboxSnapshotRoute(req, res) {
  // The local stopped check (requireStoppedForLocalConfigMutation) can't
  // scan a remote host's processes, so the router's gate leaves this to
  // the server itself: a connected RCON is that server answering, so it is
  // running. Refuse as for a local one.
  if (req.app?.get?.("rconService")?.connected) {
    return res.status(409).json({
      code: ErrorCode.SERVER_RUNNING,
      error: "Stop the server before editing configuration.",
    });
  }
  const result = await retireRemoteWorldSandboxSnapshot(
    req.remoteConfigTransport,
    req.activeServerContext.serverName,
  );
  if (!result.available) return res.status(400).json(WORLD_SANDBOX_SNAPSHOT_UNAVAILABLE_BODY);
  if (!result.retired) return res.json(NO_WORLD_SANDBOX_SNAPSHOT_BODY);
  log.info(`Retired the remote world's sandbox copy -> ${result.movedTo}`);
  return res.json({
    success: true,
    retired: true,
    // A folder on the server's host, shown like the local one below.
    movedTo: (await hostPathViewFor(req.user)).file(result.movedTo),
    message: WORLD_SANDBOX_SNAPSHOT_RETIRED_MESSAGE,
  });
}

router.post("/sandbox/world-snapshot/retire", async (req, res) => {
  try {
    if (req.activeServerContext.activeServer?.isRemote) {
      return await retireRemoteWorldSandboxSnapshotRoute(req, res);
    }
    const { serverConfigPath: configPath, serverName } = req.activeServerContext;
    const snapshotPath = localWorldSandboxSnapshotPath(req.activeServerContext);
    if (!snapshotPath) {
      // A folder the save would be in that the data-folder rule refuses
      // (the game's default one, say, which the gate above never judged)
      // gets that refusal; nothing under it is touched.
      return res
        .status(400)
        .json(localGameDataDir(req.activeServerContext) ? zomboidDataFolderRefusal() : WORLD_SANDBOX_SNAPSHOT_UNAVAILABLE_BODY);
    }
    if (!(await findWorldSandboxSnapshot(req))) {
      return res.json(NO_WORLD_SANDBOX_SNAPSHOT_BODY);
    }

    const backupDir = await getBackupPath(configPath);
    await fs.promises.mkdir(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    let movedTo = path.join(backupDir, `${serverName}_map_sand.bin.${timestamp}.retired`);
    for (let n = 2; fs.existsSync(movedTo); n++) {
      movedTo = path.join(backupDir, `${serverName}_map_sand.bin.${timestamp}-${n}.retired`);
    }
    try {
      await fs.promises.rename(snapshotPath, movedTo);
    } catch (error) {
      if (error.code !== "EXDEV") throw error;
      // Saves/ and the config folder sit on different drives or mounts.
      await fs.promises.copyFile(snapshotPath, movedTo, fs.constants.COPYFILE_EXCL);
      await fs.promises.unlink(snapshotPath);
    }

    log.info(`Retired the world's sandbox copy: ${snapshotPath} -> ${movedTo}`);
    res.json({
      success: true,
      retired: true,
      movedTo: (await hostPathViewFor(req.user)).file(movedTo),
      message: WORLD_SANDBOX_SNAPSHOT_RETIRED_MESSAGE,
    });
  } catch (error) {
    log.error("Failed to retire map_sand.bin:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get spawn points
router.get("/spawnpoints", async (req, res) => {
  try {
    const { serverConfigPath: configPath, serverName } = req.activeServerContext;
    const filePath = path.join(configPath, `${serverName}_spawnpoints.lua`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: "Spawn points file not found",
        path: (await hostPathViewFor(req.user)).file(filePath),
        code: ErrorCode.SPAWNPOINTS_FILE_NOT_FOUND,
      });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const points = parseSpawnPoints(content);

    res.json({ spawnpoints: points, path: (await hostPathViewFor(req.user)).file(filePath) });
  } catch (error) {
    log.error("Failed to read spawn points:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Save spawn points
router.put("/spawnpoints", async (req, res) => {
  try {
    log.info("PUT /spawnpoints");
    const { serverConfigPath: configPath, serverName } = req.activeServerContext;
    const filePath = path.join(configPath, `${serverName}_spawnpoints.lua`);
    const { spawnpoints } = req.body || {};

    if (!spawnpoints || typeof spawnpoints !== "object") {
      return res.status(400).json({
        error: "Spawn points object required (keyed by profession)",
        code: ErrorCode.SPAWNPOINTS_OBJECT_REQUIRED,
      });
    }

    let backupWarning = null;
    await withFileLock(filePath, async () => {
      if (fs.existsSync(filePath)) {
        backupWarning = backupWarningFor(
          await createBackup(configPath, `${serverName}_spawnpoints.lua`),
        );
      }

      const newContent = toSpawnPoints(spawnpoints, serverName);
      writeFileAtomic(filePath, newContent, "utf-8");
    });

    log.info("Saved spawn points file");
    res.json({
      success: true,
      message: "Spawn points saved",
      ...(backupWarning ? { backupWarning } : {}),
      ...(req.configEditRestartWarning ? { restartRequired: true } : {}),
    });
  } catch (error) {
    log.error("Failed to save spawn points:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get spawn regions
router.get("/spawnregions", async (req, res) => {
  try {
    const { serverConfigPath: configPath, serverName } = req.activeServerContext;
    const filePath = path.join(configPath, `${serverName}_spawnregions.lua`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: "Spawn regions file not found",
        path: (await hostPathViewFor(req.user)).file(filePath),
        code: ErrorCode.SPAWNREGIONS_FILE_NOT_FOUND,
      });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const regions = parseSpawnRegions(content);

    res.json({ spawnregions: regions, path: (await hostPathViewFor(req.user)).file(filePath) });
  } catch (error) {
    log.error("Failed to read spawn regions:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Save spawn regions
router.put("/spawnregions", async (req, res) => {
  try {
    const { serverConfigPath: configPath, serverName } = req.activeServerContext;
    const filePath = path.join(configPath, `${serverName}_spawnregions.lua`);
    const { spawnregions } = req.body || {};

    if (!Array.isArray(spawnregions)) {
      return res.status(400).json({
        error: "Spawn regions array required",
        code: ErrorCode.SPAWNREGIONS_ARRAY_REQUIRED,
      });
    }

    let backupWarning = null;
    await withFileLock(filePath, async () => {
      if (fs.existsSync(filePath)) {
        backupWarning = backupWarningFor(
          await createBackup(configPath, `${serverName}_spawnregions.lua`),
        );
      }

      const newContent = toSpawnRegions(spawnregions, serverName);
      writeFileAtomic(filePath, newContent, "utf-8");
    });

    log.info("Saved spawn regions file");
    res.json({
      success: true,
      message: "Spawn regions saved",
      ...(backupWarning ? { backupWarning } : {}),
      ...(req.configEditRestartWarning ? { restartRequired: true } : {}),
    });
  } catch (error) {
    log.error("Failed to save spawn regions:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get raw file content
router.get("/raw/:type", async (req, res) => {
  log.info(`GET /raw/${req.params.type}`);
  try {
    const { serverConfigPath: configPath, serverName } = req.activeServerContext;
    const type = req.params.type;

    const fileMap = {
      ini: `${serverName}.ini`,
      sandbox: `${serverName}_SandboxVars.lua`,
      spawnpoints: `${serverName}_spawnpoints.lua`,
      spawnregions: `${serverName}_spawnregions.lua`,
    };

    if (!fileMap[type]) {
      return res.status(400).json({
        error: "Invalid file type",
        code: ErrorCode.RAW_FILE_INVALID_TYPE,
      });
    }

    const filePath = path.join(configPath, fileMap[type]);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: "File not found",
        code: ErrorCode.FILE_NOT_FOUND,
      });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const worldSandboxSnapshot =
      type === "sandbox" ? await findWorldSandboxSnapshot(req) : null;
    res.json({
      content: type === "ini" ? maskSensitiveIniLines(content) : content,
      filename: fileMap[type],
      ...(worldSandboxSnapshot ? { worldSandboxSnapshot: await worldSandboxSnapshotView(req.user, worldSandboxSnapshot) } : {}),
    });
  } catch (error) {
    log.error("Failed to read raw file:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Save raw file content
router.put("/raw/:type", async (req, res) => {
  try {
    const { serverConfigPath: configPath, serverName } = req.activeServerContext;
    const type = req.params.type;
    const { content } = req.body || {};
    log.info(`PUT /raw/${type}: contentLength=${content?.length || 0}`);

    const fileMap = {
      ini: `${serverName}.ini`,
      sandbox: `${serverName}_SandboxVars.lua`,
      spawnpoints: `${serverName}_spawnpoints.lua`,
      spawnregions: `${serverName}_spawnregions.lua`,
    };

    if (!fileMap[type]) {
      return res.status(400).json({
        error: "Invalid file type",
        code: ErrorCode.RAW_FILE_INVALID_TYPE,
      });
    }

    if (typeof content !== "string") {
      return res.status(400).json({
        error: "Content string required",
        code: ErrorCode.RAW_CONTENT_STRING_REQUIRED,
      });
    }

    if (content.length > 512 * 1024) {
      return res.status(400).json({
        error: "Content too large (max 512KB)",
        code: ErrorCode.RAW_CONTENT_TOO_LARGE,
      });
    }

    const filePath = path.join(configPath, fileMap[type]);

    let backupWarning = null;
    let reconcileFailure = null;
    let missingCapabilities = [];
    await withFileLock(filePath, async () => {
      let contentToWrite = content;
      let liveContent = "";

      // Only the ini type is Key=Value text that GET /raw ever masks --
      // sandbox/spawnpoints/spawnregions are Lua table syntax, not INI
      // lines, so running line-based reconciliation on them would at best
      // no-op and at worst corrupt them. SandboxVars also has no RCON
      // field to protect in the first place.
      if (type === "ini" && fs.existsSync(filePath)) {
        liveContent = fs.readFileSync(filePath, "utf-8");
        const reconciled = reconcileMaskedIniLines(content, liveContent);
        if (!reconciled.ok) {
          reconcileFailure = reconciled;
          return;
        }
        contentToWrite = reconciled.content;
      }

      if (type === "ini") {
        // The same server.configure keys PUT /ini guards: this route writes
        // the same file, so it could set RCONPassword or a port without the
        // capability. Judged on what the game reads from the text that will
        // be written (the masked lines are already the live values) against
        // the live file, so a save that leaves them alone needs nothing more.
        missingCapabilities = await missingIniCapabilities(
          req,
          governedIniKeysChanged(liveContent, contentToWrite),
        );
        if (missingCapabilities.length > 0) return;
        backupWarning = backupWarningFor(await writeIniWithBackup(filePath, contentToWrite));
      } else {
        if (fs.existsSync(filePath)) {
          backupWarning = backupWarningFor(await createBackup(configPath, fileMap[type]));
        }
        writeFileAtomic(filePath, contentToWrite, "utf-8");
      }
    });

    if (missingCapabilities.length > 0) {
      return res.status(403).json(missingIniCapabilitiesBody(missingCapabilities));
    }

    if (reconcileFailure) {
      const isRemoved = reconcileFailure.reason === "removed";
      return res.status(400).json({
        error: isRemoved
          ? `The "${reconcileFailure.key}" line was removed, but it holds a live secret that can't be silently dropped. To clear it, write "${reconcileFailure.key}=" explicitly instead of deleting the line, or use the structured editor.`
          : `Could not safely save: the "${reconcileFailure.key}" line's masked value could not be matched back to exactly one live value. Nothing was written.`,
        code: isRemoved
          ? ErrorCode.RAW_INI_SECRET_LINE_REMOVED
          : ErrorCode.RAW_INI_SECRET_UNRESOLVABLE,
        params: sanitizeErrorParams({ key: reconcileFailure.key }),
      });
    }

    log.info(`Saved raw file: ${fileMap[type]}`);
    res.json({
      success: true,
      message: "File saved",
      ...(backupWarning ? { backupWarning } : {}),
      ...(req.configEditRestartWarning ? { restartRequired: true } : {}),
    });
  } catch (error) {
    log.error("Failed to save raw file:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// List backups
router.get("/backups", async (req, res) => {
  try {
    const { serverConfigPath: configPath } = req.activeServerContext;
    const backupDir = await getBackupPath(configPath);

    if (!fs.existsSync(backupDir)) {
      return res.json({ backups: [] });
    }

    const fileList = await fs.promises.readdir(backupDir);
    const files = (
      await Promise.all(
        fileList
          .filter((f) => f.endsWith(".bak"))
          .map(async (filename) => {
            try {
              const stats = await fs.promises.stat(
                path.join(backupDir, filename),
              );
              return {
                filename,
                size: stats.size,
                created: stats.birthtime,
                // Not part of the response shape -- sort key only, see
                // the .sort() below.
                _parsed: parseAnyBackupFilename(filename),
              };
            } catch (e) {
              log.debug(
                `Stat failed for backup file ${filename}: ${e.message}`,
              );
              return null;
            }
          }),
      )
    )
      .filter((f) => f !== null)
      // display-order-tie-breaks-nine-sites-cosmetic, 2026-09-09: this
      // used to sort by fs birthtime alone -- the exact method utils/
      // configBackup.js's listBackupsFor() documents as unsafe for this
      // same directory (real ext4 same-millisecond collisions confirmed;
      // see that file's comment), re-derived here after being explicitly
      // rejected there. Every backup in this directory is written by
      // configBackup.js's createBackup(), so _parsed is expected to
      // succeed for all of them; the birthtime/filename fallback below
      // only matters for a foreign or hand-placed file that doesn't match
      // the naming convention.
      .sort((a, b) => {
        if (a._parsed && b._parsed) {
          if (a._parsed.timestampKey !== b._parsed.timestampKey) {
            return a._parsed.timestampKey < b._parsed.timestampKey ? 1 : -1;
          }
          return b._parsed.suffix - a._parsed.suffix;
        }
        if (Boolean(a._parsed) !== Boolean(b._parsed)) {
          return a._parsed ? -1 : 1; // a parsed, real name always wins
        }
        // Neither parses -- fall back to birthtime, then filename.
        const dateA = new Date(a.created);
        const dateB = new Date(b.created);
        if (isNaN(dateA.getTime()) !== isNaN(dateB.getTime())) {
          return isNaN(dateA.getTime()) ? 1 : -1;
        }
        return dateB - dateA || b.filename.localeCompare(a.filename);
      })
      .map(({ _parsed, ...rest }) => rest);

    res.json({ backups: files, path: (await hostPathViewFor(req.user)).folder(backupDir) });
  } catch (error) {
    log.error("Failed to list backups:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Restore from backup
router.post("/restore/:filename", async (req, res) => {
  try {
    const { serverConfigPath: configPath } = req.activeServerContext;
    const backupDir = await getBackupPath(configPath);

    // Sanitize filename to prevent path traversal
    const filename = path.basename(req.params.filename);
    log.info(`POST /restore: filename=${filename}`);

    if (!filename.endsWith(".bak")) {
      return res.status(400).json({
        error: "Invalid backup file extension",
        code: ErrorCode.RESTORE_INVALID_EXTENSION,
      });
    }

    const backupPath = path.join(backupDir, filename);

    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({
        error: "Backup not found",
        code: ErrorCode.RESTORE_BACKUP_NOT_FOUND,
      });
    }

    // Extract original filename from backup name (e.g., "servertest.ini.2024-01-01T12-00-00.bak")
    const parts = filename.split(".");
    if (parts.length < 3) {
      return res.status(400).json({
        error: "Invalid backup filename",
        code: ErrorCode.RESTORE_INVALID_FILENAME,
      });
    }

    // Get original filename (everything before the timestamp)
    const bakIndex = filename.lastIndexOf(".bak");
    const timestampStart = filename.lastIndexOf(".", bakIndex - 1);
    const originalName = filename.substring(0, timestampStart);

    // originalName is a SUBSTRING of filename, never independently
    // re-validated -- unlike filename itself (protected by the .bak-only
    // check above, which incidentally also rejects bare "." and ".."
    // since neither ends in ".bak"). A crafted name like "....bak" makes
    // the lastIndexOf/substring math above land on originalName === "..".
    // Explicit, not incidental: this must hold regardless of whether
    // fs.copyFile below happens to refuse a directory target on a given
    // platform. path.basename() would leave "." and ".." unchanged (same
    // caveat as chunks.js's saveName sanitization), so check for those
    // and any separator explicitly rather than re-deriving via basename.
    if (
      !originalName ||
      originalName === "." ||
      originalName === ".." ||
      originalName.includes("/") ||
      originalName.includes("\\")
    ) {
      return res.status(400).json({
        error: "Invalid backup filename",
        code: ErrorCode.RESTORE_INVALID_ORIGINAL_NAME,
      });
    }

    const targetPath = path.join(configPath, originalName);

    // re-entrancy-followups, 2026-09-10: every sibling writer in this file
    // (PUT /ini, /sandbox, /sandbox-option, /spawnpoints, /spawnregions,
    // /raw/:type) wraps its write in withFileLock(filePath, ...) and writes
    // via writeFileAtomic (temp file in the same dir, then rename) -- this
    // route was the one exception, writing straight onto targetPath with
    // fs.promises.copyFile: no lock (a concurrent PUT/restore on the same
    // targetPath could interleave with this one) AND no temp+rename (a
    // reader mid-copy could observe a partially-restored file, since
    // copyFile streams directly onto the live path rather than replacing it
    // atomically). Read the backup into memory first so writeFileAtomic --
    // the same helper every sibling already uses, not a second mechanism --
    // can do the temp+rename for us, keyed on the same targetPath the lock
    // guards.
    const backupData = await fs.promises.readFile(backupPath);

    // Create backup of current before restoring. The restore itself is a
    // deliberate, well-defined choice (the operator picked this exact
    // backup file), not a guess -- so a failed pre-restore backup doesn't
    // block it. But it must be said plainly: if this failed, the state as
    // of right before this restore is not recoverable through this panel.
    let preRestoreBackupWarning = null;
    let missingCapabilities = [];
    await withFileLock(targetPath, async () => {
      // A restored .ini can carry another RCON password, RCON port or game
      // port than the live one: the same server.configure keys PUT /ini
      // guards, so the restore needs that capability for any it would change
      // (judged on what the game reads, against the file it replaces).
      if (/\.ini$/i.test(originalName)) {
        const liveContent = fs.existsSync(targetPath)
          ? fs.readFileSync(targetPath, "utf-8")
          : "";
        missingCapabilities = await missingIniCapabilities(
          req,
          governedIniKeysChanged(liveContent, backupData.toString("utf-8")),
        );
        if (missingCapabilities.length > 0) return;
      }

      if (fs.existsSync(targetPath)) {
        const backup = await createBackup(configPath, originalName);
        if (!backup.backedUp && backup.reason !== "no-source") {
          preRestoreBackupWarning = `Could not back up the current ${originalName} before restoring over it: ${backup.error}. The version that was in place before this restore is not recoverable through this panel.`;
        }
      }

      writeFileAtomic(targetPath, backupData);
    });

    if (missingCapabilities.length > 0) {
      return res.status(403).json(missingIniCapabilitiesBody(missingCapabilities));
    }

    log.info(`Restored from backup: ${filename} -> ${originalName}`);
    res.json({
      success: true,
      message: `Restored ${originalName} from backup`,
      ...(preRestoreBackupWarning ? { backupWarning: preRestoreBackupWarning } : {}),
    });
  } catch (error) {
    log.error("Failed to restore backup:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Save and reload (calls RCON reloadoptions)
router.post("/save-and-reload", async (req, res) => {
  try {
    log.info("POST /save-and-reload");
    const rconService = req.app.get("rconService");

    if (!rconService || !rconService.isConnected()) {
      return res.status(400).json({
        error: "RCON not connected. Changes saved but not reloaded.",
        code: ErrorCode.SAVE_AND_RELOAD_RCON_NOT_CONNECTED,
      });
    }

    // Reflect what RCON actually reported, not a hardcoded success. execute()
    // (which reloadOptions() wraps) already distinguishes success from
    // failure ({success:false, error} on a timeout, disconnect, or rejected
    // command) -- this used to discard that and always claim "Options
    // reloaded", so a failed live reload was invisible: the file on disk was
    // correct, but the running server silently kept its old settings.
    const result = await rconService.reloadOptions();
    if (!result?.success) {
      return res.json({
        success: false,
        error: result?.error || "Failed to reload options via RCON",
        result,
      });
    }
    res.json({ success: true, message: "Options reloaded", result });
  } catch (error) {
    log.error("Failed to reload options:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ===== CONFIG TEMPLATES =====

// Get templates directory. Takes req explicitly (not implicit like the
// handlers below) since this is a plain helper, not a route handler itself --
// reads the SAME req.activeServerContext every caller below already has,
// never re-derives.
async function getTemplatesPath(req) {
  const { serverConfigPath: configPath } = req.activeServerContext;
  return path.join(configPath, "templates");
}

// How a saved template is opened: never through a symlink (O_NOFOLLOW) and
// without blocking on a FIFO (O_NONBLOCK); POSIX only, 0 on Windows. The
// templates folder sits in the game's own Zomboid/Server folder, which
// another account or container can share.
const TEMPLATE_READ_FLAGS =
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

// A saved template, read through one descriptor (nothing can be swapped in
// between the check and the read), or null when the name is not a regular
// file. Templates saved before v1.2.7 kept the RCON and join passwords: they
// are stripped here on every read, so no route returns or rewrites them.
// Apply alone reads them as stored (`keepSecretLines`): it never returns the
// template, and keepLiveSecretIniLines() swaps every stale secret line for
// the live one in place, so an old template keeps its key order.
function readTemplateFile(templateFile, { keepSecretLines = false } = {}) {
  let fd;
  try {
    // codeql[js/path-injection] templateFile is <config folder>/templates/<safeId>.json, safeId reduced to [a-z0-9_-] by every caller.
    fd = fs.openSync(templateFile, TEMPLATE_READ_FLAGS);
  } catch (error) {
    if (["ENOENT", "ELOOP", "ENOTDIR", "ENXIO", "EISDIR"].includes(error.code)) return null;
    throw error;
  }
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) return null;
    // Windows has no O_NOFOLLOW: a link at the name is refused after the fact.
    if (process.platform === "win32" && fs.lstatSync(templateFile).isSymbolicLink()) return null;
    const content = JSON.parse(fs.readFileSync(fd, "utf-8"));
    if (!keepSecretLines && content && typeof content === "object") {
      if (content.ini && typeof content.ini === "object") {
        content.ini = omitSensitiveFields(content.ini);
      }
      if (typeof content.iniRaw === "string") {
        content.iniRaw = stripSensitiveIniLines(content.iniRaw);
      }
    }
    return { content, stats };
  } finally {
    fs.closeSync(fd);
  }
}

// Ensure templates directory exists
async function ensureTemplatesDir(req) {
  const templatesPath = await getTemplatesPath(req);
  if (!fs.existsSync(templatesPath)) {
    fs.mkdirSync(templatesPath, { recursive: true });
  }
  return templatesPath;
}

// GET /templates - List all saved templates
router.get("/templates", async (req, res) => {
  try {
    // SECURITY (2026-10-05, PT1): a listing only reads. It used to create
    // <config folder>/templates -- and the config and data folders above it
    // when they didn't exist yet -- so opening the page made folders in a
    // data folder saved before it existed. POST /templates, which writes
    // one, still creates it.
    const templatesPath = await getTemplatesPath(req);
    if (!fs.existsSync(templatesPath)) {
      return res.json({ templates: [] });
    }

    const files = fs
      .readdirSync(templatesPath)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const filePath = path.join(templatesPath, f);
          const read = readTemplateFile(filePath);
          if (!read) return null;
          const { content, stats } = read;
          return {
            id: f.replace(".json", ""),
            name: content.name || f.replace(".json", ""),
            description: content.description || "",
            type: content.type || "both", // 'ini', 'sandbox', or 'both'
            created: content.created || stats.birthtime.toISOString(),
            modified: stats.mtime.toISOString(),
            hasIni: !!content.ini,
            hasSandbox: !!content.sandbox,
          };
        } catch (e) {
          log.debug(`Template read failed for ${f}: ${e.message}`);
          return null;
        }
      })
      .filter(Boolean)
      // display-order-tie-breaks-nine-sites-cosmetic, 2026-09-09: id
      // (the template's filename) tie-break -- a mtime tie previously
      // fell through to readdir order, which has no ordering meaning.
      .sort(
        (a, b) =>
          new Date(b.modified) - new Date(a.modified) ||
          b.id.localeCompare(a.id),
      );

    res.json({ templates: files });
  } catch (error) {
    log.error("Failed to list templates:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// GET /templates/:id - Get a specific template
router.get("/templates/:id", async (req, res) => {
  try {
    // Sanitize template ID to prevent path traversal
    const safeId = path.basename(req.params.id).replace(/[^a-z0-9_-]/gi, "");
    if (!safeId || safeId !== req.params.id) {
      return res.status(400).json({
        error: "Invalid template ID",
        code: ErrorCode.TEMPLATE_ID_INVALID,
      });
    }

    const templatesPath = await getTemplatesPath(req);
    const templateFile = path.join(templatesPath, `${safeId}.json`);

    const read = readTemplateFile(templateFile);
    if (!read) {
      return res.status(404).json({
        error: "Template not found",
        code: ErrorCode.TEMPLATE_NOT_FOUND,
      });
    }

    res.json(read.content);
  } catch (error) {
    log.error("Failed to get template:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// POST /templates - Save current config as a template
router.post("/templates", async (req, res) => {
  log.info("POST /templates (create)");
  try {
    const {
      name,
      description,
      includeIni = true,
      includeSandbox = true,
    } = req.body;

    if (!name) {
      return res.status(400).json({
        error: "Template name is required",
        code: ErrorCode.TEMPLATE_NAME_REQUIRED,
      });
    }

    const templatesPath = await ensureTemplatesDir(req);
    const { serverConfigPath: configPath, serverName } = req.activeServerContext;

    // Generate safe filename from name with uniqueness check
    const baseId = name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_")
      .substring(0, 50);
    let safeId = baseId;
    let counter = 1;
    // codeql[js/path-injection] safeId/templateFile is derived from name via .toLowerCase().replace(/[^a-z0-9]/g, '_') a few lines above before being joined into a path here.
    while (fs.existsSync(path.join(templatesPath, `${safeId}.json`))) {
      safeId = `${baseId}_${counter++}`;
      if (counter > 100) {
        return res.status(400).json({
          error: "Too many templates with similar names",
          code: ErrorCode.TEMPLATE_NAME_CONFLICT_LIMIT,
        });
      }
    }
    const templateFile = path.join(templatesPath, `${safeId}.json`);

    const template = {
      name,
      description: description || "",
      type:
        includeIni && includeSandbox ? "both" : includeIni ? "ini" : "sandbox",
      created: new Date().toISOString(),
      serverName,
    };

    // Read current INI settings. A saved template is a persisted snapshot
    // with no exclusion list and no expiry -- unlike a live GET, this copy
    // outlives the credential it was taken from and survives a later
    // password rotation, so secret-shaped keys (RCONPassword, the server
    // join Password, ...) are stripped here rather than masked: see
    // stripSensitiveIniLines()'s own comment for why omission, not a
    // placeholder, is the safe choice. POST /templates/:id/apply puts the
    // live file's own secret lines back (keepLiveSecretIniLines()).
    if (includeIni) {
      const iniPath = path.join(configPath, `${serverName}.ini`);
      if (fs.existsSync(iniPath)) {
        const iniContent = fs.readFileSync(iniPath, "utf-8");
        template.ini = omitSensitiveFields(parseIni(iniContent));
        template.iniRaw = stripSensitiveIniLines(iniContent);
      }
    }

    // Read current Sandbox settings
    if (includeSandbox) {
      const sandboxPath = path.join(
        configPath,
        `${serverName}_SandboxVars.lua`,
      );
      if (fs.existsSync(sandboxPath)) {
        template.sandboxRaw = fs.readFileSync(sandboxPath, "utf-8");
      }
    }

    // codeql[js/path-injection] safeId/templateFile is derived from name via .toLowerCase().replace(/[^a-z0-9]/g, '_') a few lines above before being joined into a path here.
    // "wx": created here or not at all -- a name that turned up since the
    // check above (a symlink included) is never followed or overwritten.
    fs.writeFileSync(templateFile, JSON.stringify(template, null, 2), { flag: "wx" });
    log.info(`Created template: ${name} (${safeId})`);

    res.json({
      success: true,
      id: safeId,
      name,
      message: `Template "${name}" saved successfully`,
    });
  } catch (error) {
    log.error("Failed to save template:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// POST /templates/:id/apply - Apply a template to current config
router.post("/templates/:id/apply", async (req, res) => {
  log.info(`POST /templates/${req.params.id}/apply`);
  // Declared OUTSIDE the try block, not inside it: the catch below needs to
  // see whatever landed before a later step threw, so a partial apply (INI
  // written, Sandbox write then failed) can be reported honestly instead of
  // reading as "nothing happened".
  const applied = [];
  try {
    // Sanitize template ID to prevent path traversal
    const safeId = path.basename(req.params.id).replace(/[^a-z0-9_-]/gi, "");
    if (!safeId || safeId !== req.params.id) {
      return res.status(400).json({
        error: "Invalid template ID",
        code: ErrorCode.TEMPLATE_ID_INVALID,
      });
    }

    const { applyIni = true, applySandbox = true } = req.body || {};

    const templatesPath = await getTemplatesPath(req);
    const templateFile = path.join(templatesPath, `${safeId}.json`);

    const read = readTemplateFile(templateFile, { keepSecretLines: true });
    if (!read) {
      return res.status(404).json({
        error: "Template not found",
        code: ErrorCode.TEMPLATE_NOT_FOUND,
      });
    }

    const template = read.content;
    const { serverConfigPath: configPath, serverName } = req.activeServerContext;

    // A template stores the whole SandboxVars.lua as it was when saved, so
    // one saved from a corrupted file would put the corruption straight back.
    // Checked before anything is written, INI included.
    if (applySandbox && template.sandboxRaw) {
      const check = validateSandboxLua(template.sandboxRaw);
      if (!check.valid) {
        const detail = check.error?.message || "unbalanced braces";
        log.warn(`Template ${safeId} not applied: its SandboxVars.lua does not parse (${detail})`);
        return res.status(422).json({
          error: `This template's saved SandboxVars.lua is not valid Lua (${detail}), so nothing was applied. Apply its INI settings only, or save a new template from a working configuration.`,
          code: ErrorCode.TEMPLATE_SANDBOX_UNPARSEABLE,
          params: sanitizeErrorParams({ detail }),
        });
      }
    }

    const backupWarnings = [];

    // Apply INI settings
    if (applyIni && template.iniRaw) {
      const iniPath = path.join(configPath, `${serverName}.ini`);
      let missingCapabilities = [];

      await withFileLock(iniPath, async () => {
        // The template holds no secrets (POST /templates leaves them out), so
        // the live file's own secret lines -- the RCON password, the join
        // password, every token -- go into what is written. Writing the
        // template as it was removed them from a running server.
        const liveContent = fs.existsSync(iniPath)
          ? fs.readFileSync(iniPath, "utf-8")
          : "";
        const iniToWrite = keepLiveSecretIniLines(template.iniRaw, liveContent);

        // A template can carry another RCON port or game port than the live
        // file's: the server.configure keys PUT /ini guards. Checked before
        // anything is written, the Sandbox half included.
        missingCapabilities = await missingIniCapabilities(
          req,
          governedIniKeysChanged(liveContent, iniToWrite),
        );
        if (missingCapabilities.length > 0) return;

        // Create backup first
        const iniBackupWarning = backupWarningFor(
          await createBackup(configPath, `${serverName}.ini`),
        );
        if (iniBackupWarning) backupWarnings.push(iniBackupWarning);

        // Write the template INI
        writeFileAtomic(iniPath, iniToWrite);
      });
      if (missingCapabilities.length > 0) {
        return res.status(403).json(missingIniCapabilitiesBody(missingCapabilities));
      }
      applied.push("INI");
      log.info(`Applied INI from template: ${template.name}`);
    }

    // Apply Sandbox settings
    if (applySandbox && template.sandboxRaw) {
      const sandboxPath = path.join(
        configPath,
        `${serverName}_SandboxVars.lua`,
      );

      await withFileLock(sandboxPath, async () => {
        // Create backup first
        const sandboxBackupWarning = backupWarningFor(
          await createBackup(configPath, `${serverName}_SandboxVars.lua`),
        );
        if (sandboxBackupWarning) backupWarnings.push(sandboxBackupWarning);

        // Write the template sandbox
        writeFileAtomic(sandboxPath, template.sandboxRaw);
      });
      applied.push("Sandbox");
      log.info(`Applied Sandbox from template: ${template.name}`);
    }

    if (applied.length === 0) {
      return res.status(400).json({
        error: "No settings to apply from this template",
        code: ErrorCode.TEMPLATE_APPLY_NOTHING_TO_APPLY,
      });
    }

    res.json({
      success: true,
      applied,
      message: `Applied ${applied.join(" and ")} settings from "${template.name}"`,
      ...(backupWarnings.length > 0 ? { backupWarnings } : {}),
    });
  } catch (error) {
    log.error("Failed to apply template:", error);
    // `applied` tracks each write as it actually lands (pushed right after
    // its own withFileLock call returns), so if INI succeeded and Sandbox
    // then threw, `applied` already says so here -- a flat 500 with no
    // reference to it reads as "nothing happened" when part of the template
    // really did land on disk.
    res.status(500).json({
      error: sanitizeError(error.message),
      ...(applied.length > 0 ? { success: false, partiallyApplied: applied } : {}),
    });
  }
});

// PUT /templates/:id - Update template metadata
router.put("/templates/:id", async (req, res) => {
  try {
    // Sanitize template ID to prevent path traversal
    const safeId = path.basename(req.params.id).replace(/[^a-z0-9_-]/gi, "");
    if (!safeId || safeId !== req.params.id) {
      return res.status(400).json({
        error: "Invalid template ID",
        code: ErrorCode.TEMPLATE_ID_INVALID,
      });
    }

    const { name, description } = req.body || {};

    const templatesPath = await getTemplatesPath(req);
    const templateFile = path.join(templatesPath, `${safeId}.json`);

    const read = readTemplateFile(templateFile);
    if (!read) {
      return res.status(404).json({
        error: "Template not found",
        code: ErrorCode.TEMPLATE_NOT_FOUND,
      });
    }

    // Secret lines of a pre-v1.2.7 template are already gone from `template`
    // (readTemplateFile), so this edit also cleans the stored file.
    const template = read.content;

    if (name) template.name = name;
    if (description !== undefined) template.description = description;
    template.modified = new Date().toISOString();

    // Temp file + rename: a symlink swapped in at this name is replaced,
    // never written through.
    writeFileAtomic(templateFile, JSON.stringify(template, null, 2));

    res.json({ success: true, message: "Template updated" });
  } catch (error) {
    log.error("Failed to update template:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// DELETE /templates/:id - Delete a template
router.delete("/templates/:id", async (req, res) => {
  log.info(`DELETE /templates/${req.params.id}`);
  try {
    // Sanitize template ID to prevent path traversal
    const safeId = path.basename(req.params.id).replace(/[^a-z0-9_-]/gi, "");
    if (!safeId || safeId !== req.params.id) {
      return res.status(400).json({
        error: "Invalid template ID",
        code: ErrorCode.TEMPLATE_ID_INVALID,
      });
    }

    const templatesPath = await getTemplatesPath(req);
    const templateFile = path.join(templatesPath, `${safeId}.json`);

    if (!fs.existsSync(templateFile)) {
      return res.status(404).json({
        error: "Template not found",
        code: ErrorCode.TEMPLATE_NOT_FOUND,
      });
    }

    fs.unlinkSync(templateFile);
    log.info(`Deleted template: ${req.params.id}`);

    res.json({ success: true, message: "Template deleted" });
  } catch (error) {
    log.error("Failed to delete template:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ===== FILE BROWSER (for image path fields) =====

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".webp",
]);

/**
 * Build the list of directories the file browser is allowed to access.
 * Restricts browsing to the Zomboid data folder's Server folder (the whole
 * data folder for a files.manage holder) and ~/Zomboid — prevents arbitrary
 * filesystem traversal.
 *
 * Takes req (2026-09-08 quadruple-read sweep): used to independently
 * re-derive the active server via its own getActiveServer() call, which is
 * exactly the bug this sweep fixed everywhere else in this file -- the
 * security boundary these roots exist to enforce could be computed against
 * a DIFFERENT server than the one the calling handler's own path resolution
 * already agreed on via req.activeServerContext, if /activate landed between
 * the two. Reads the same single per-request snapshot instead.
 *
 * SECURITY (2026-10-04, FILES-2): the server config folder and serverPath
 * used to be roots of their own. Both were plain servers.manage edits with
 * no confinement (serverPath only has to be shaped like a folder), so
 * either one made any folder on this computer browsable here: every file
 * name in it, and any image in it through /image-preview. The config
 * folder is now confined to <zomboidDataPath>/Server when saved
 * (routes/servers.js's serverConfigPathIsConfined()), which the data
 * folder's own root already covers; serverPath is no longer a root at all,
 * and neither is the legacy settings copy of the config folder.
 */
// SECURITY (2026-10-04, FILES-2 adversary pass): the data folder itself is
// as much a servers.manage edit as the config folder was, and POST
// /api/servers, the install routes and chunks.js's /save-path all set it
// to a folder of the caller's choosing. As a root it made that whole folder
// browsable, so a technician named any folder on this computer as a
// server's data folder and listed it and fetched its images here. A role
// without files.manage now gets only the data folder's Server folder (where
// the game keeps the files Server Config edits, and the config folder sits
// in it): a folder the game creates, not one that was already there. A
// files.manage holder, who can already reach the game's files through the
// file manager, keeps the whole data folder.
async function holdsFilesManage(req) {
  if (!req.user) return false;
  try {
    const role = await getRoleByName(req.user.role);
    return Array.isArray(role?.capabilities) && role.capabilities.includes("files.manage");
  } catch {
    return false;
  }
}

// Each root with the id GET /browse-files and /image-preview name it by for
// a role that doesn't see host folders (browseRefFor() below): "data" for
// the active server's data folder, "settings" for the legacy setting's,
// "zomboid" for ~/Zomboid, "config" for the config folder in effect when
// none of those holds it. The first id for a folder wins.
//
// SECURITY (2026-10-05, W5-P2 verifier round 1): a 1.4.5 record whose data
// folder Map Cleanup's "Save as default" set to a folder inside the Zomboid
// folder -- <Zomboid>/Saves/Multiplayer, <Zomboid>/Saves or a world save in
// it -- kept its config folder, <Zomboid>/Server, which the gate above
// accepts (utils/serverConfigPath.js's configAnchors()). No root held it,
// so the image browser, which opens on the config folder, answered
// BROWSE_ACCESS_DENIED for every role wherever the Zomboid folder isn't
// ~/Zomboid; 1.4.5 had the config folder as a root of its own. So did a
// record whose config folder spells the data folder's path in another letter
// case on Windows or macOS (the gate compares real paths, the roots compare
// as spelled). The config folder in effect is a root again, but only when
// no other root holds it and it passes the gate's own checks here too: the
// data folder in effect meets the data-folder rule, and the config folder is
// inside its Server folder or, for those 1.4.5 shapes, inside the Server
// folder of a Zomboid folder that meets the rule on its own
// (zomboidFolderAround()). That is the folder a role gets as "data" by
// setting the data folder to that Zomboid folder, so nothing else is
// reached.
async function getAllowedBrowseRoots(req) {
  const roots = [];
  const { activeServer, serverConfigPath, zomboidDataPath } = req.activeServerContext;
  const wholeDataFolder = await holdsFilesManage(req);
  const dataFolderRoot = (dataPath) =>
    wholeDataFolder
      ? path.resolve(dataPath)
      : path.join(path.resolve(dataPath), "Server");
  // PATHS-1: a data folder is a root only while it meets the data-folder
  // rule (services/zomboidDataPath.js); the legacy setting's can differ from
  // the record's, so each is judged.
  if (activeServer?.zomboidDataPath && zomboidDataFolderHolds(activeServer.zomboidDataPath))
    roots.push({ id: "data", path: dataFolderRoot(activeServer.zomboidDataPath) });
  const settings = await getAllSettings();
  if (settings.zomboidDataPath && zomboidDataFolderHolds(settings.zomboidDataPath))
    roots.push({ id: "settings", path: dataFolderRoot(settings.zomboidDataPath) });
  // Always allow the default Zomboid config directory
  const defaultConfig = path.join(os.homedir(), "Zomboid");
  roots.push({ id: "zomboid", path: path.resolve(defaultConfig) });
  if (
    !activeServer?.isRemote &&
    serverConfigPath &&
    zomboidDataFolderHolds(zomboidDataPath) &&
    serverConfigPathIsConfined(serverConfigPath, zomboidDataPath) &&
    !confineToRoots(serverConfigPath, roots.map((root) => root.path))
  ) {
    roots.push({ id: "config", path: path.resolve(serverConfigPath) });
  }
  // De-duplicate
  const seen = new Set();
  return roots.filter((root) => !seen.has(root.path) && seen.add(root.path));
}

// SECURITY (2026-10-05, HT3): GET /browse-files answered with absolute
// folders (currentPath, parent) to serverfiles.manage, the config folder
// GET /paths gives a role without the host-path capabilities as the
// placeholder (H4 round 3) among them. Round 3 kept them because the image
// picker wrote the absolute path it picked into the ini. Nothing needs one
// any more: the picker was for ServerImageLoginScreen/LoadingScreen/Icon,
// which Build 42's ServerOptions no longer declares (nothing in the 42.21
// jar or the game's Lua reads them) and Server Config hasn't offered since
// 1.1.25, so no field saves a picked path. Such a role now names a folder
// or image by a root id and the path below it ("data:/servertest/x.png"):
// GET /browse-files answers in that form and both routes take it, and an
// absolute path from it is refused like one outside the roots, so a guess
// at a folder's name isn't confirmed either. The host-path roles keep
// absolute paths and may send either form. A field that ever saves a
// picked image again must map the reference back with resolveBrowseRef()
// before writing it.
const BROWSE_REF_RE = /^([a-z]+):(.*)$/s;

// The path of `target` below `folder` ("" for the folder itself), or null
// when it isn't inside it.
function pathBelow(folder, target) {
  const relative = path.relative(folder, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

function realpathOrSelf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

// "<root id>:/<path below it>" for a folder or file inside a root -- the
// innermost one holding it, links followed when the plain path doesn't
// say -- or null when it is in none.
function browseRefFor(target, roots) {
  const resolved = path.resolve(target);
  const innermostFirst = [...roots].sort((a, b) => b.path.length - a.path.length);
  for (const [rootOf, targetPath] of [
    [(root) => root.path, resolved],
    [(root) => realpathOrSelf(root.path), realpathOrSelf(resolved)],
  ]) {
    for (const root of innermostFirst) {
      const relative = pathBelow(rootOf(root), targetPath);
      if (relative !== null) return `${root.id}:/${relative.split(path.sep).join("/")}`;
    }
  }
  return null;
}

// The absolute folder or file a browse reference names, held to its root
// (links followed, as confineToRoots() does); null for anything else. A
// "." or ".." name, or one holding ':', is refused rather than resolved.
function resolveBrowseRef(ref, roots) {
  const match = typeof ref === "string" ? BROWSE_REF_RE.exec(ref) : null;
  if (!match) return null;
  const root = roots.find((entry) => entry.id === match[1]);
  if (!root) return null;
  const names = match[2].split(/[\\/]+/).filter(Boolean);
  if (names.some((name) => name === "." || name === ".." || /[:\0]/.test(name))) return null;
  return confineToRoots(path.join(root.path, ...names), [root.path]);
}

// What a request's `path` names: a browse reference from anyone, an
// absolute path only from a role that sees host folders.
function resolveBrowseTarget(requested, roots, view) {
  const fromRef = resolveBrowseRef(requested, roots);
  if (fromRef) return fromRef;
  if (!view.full) return null;
  return confineToRoots(requested, roots.map((root) => root.path));
}

// GET /browse-files - List directories and files at a given path
router.get("/browse-files", async (req, res) => {
  try {
    const browsePath = req.query.path ? String(req.query.path) : null;
    // Image files only, whatever the caller asks for: the browser picks
    // image paths for the .ini, and listing every file name in a folder is
    // more than that needs (FILES-2).
    const filterExts = req.query.extensions
      ? String(req.query.extensions)
          .split(",")
          .map((e) => e.toLowerCase().trim())
          .filter((e) => IMAGE_EXTENSIONS.has(e))
      : null;

    const roots = await getAllowedBrowseRoots(req);
    const allowedRoots = roots.map((root) => root.path);
    // HT3: how this caller names folders (see browseRefFor()).
    const view = await hostPathViewFor(req.user);
    const shown = (folder) => (view.full ? folder : browseRefFor(folder, roots));
    const accessDenied = () =>
      res.status(403).json({
        error: "Access denied: path is outside allowed server directories",
        code: ErrorCode.BROWSE_ACCESS_DENIED,
      });
    let targetPath;
    if (browsePath) {
      targetPath = resolveBrowseTarget(browsePath, roots, view);
      if (!targetPath) return accessDenied();
    } else {
      // Default to the server config directory -- held to the same roots as
      // a requested path, so a config folder saved before FILES-2's check
      // can't be listed through the default either.
      const { serverConfigPath: configPath } = req.activeServerContext;
      if (configPath && !confineToRoots(configPath, allowedRoots)) return accessDenied();
      targetPath = configPath || "";
    }

    if (!targetPath) {
      return res.status(400).json({
        error: "No path provided and server config path not set",
        code: ErrorCode.BROWSE_NO_PATH,
      });
    }
    // A folder this caller can't be shown by reference isn't listed.
    const currentPath = shown(targetPath);
    if (!currentPath) return accessDenied();

    if (!fs.existsSync(targetPath)) {
      return res.status(400).json({
        error: "Path does not exist",
        code: ErrorCode.BROWSE_PATH_NOT_FOUND,
      });
    }

    const stat = await fs.promises.stat(targetPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({
        error: "Path is not a directory",
        code: ErrorCode.BROWSE_PATH_NOT_DIRECTORY,
      });
    }

    const entries = await fs.promises.readdir(targetPath, {
      withFileTypes: true,
    });

    const directories = [];
    const files = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Skip hidden/system directories
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
          directories.push(entry.name);
        }
      } else {
        // Treat everything that's not a directory as a potential file
        // (avoids issues with pkg/Dirent.isFile() not working for some entries)
        const ext = path.extname(entry.name).toLowerCase();
        // If extension filter is provided, only show matching files
        if (filterExts) {
          if (filterExts.includes(ext)) {
            files.push({ name: entry.name, ext });
          }
        } else {
          // Default: show image files only
          if (IMAGE_EXTENSIONS.has(ext)) {
            files.push({ name: entry.name, ext });
          }
        }
      }
    }

    directories.sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
    files.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

    const parentPath = path.dirname(targetPath);
    res.json({
      currentPath,
      parent:
        parentPath !== targetPath && confineToRoots(parentPath, allowedRoots)
          ? shown(parentPath)
          : null,
      directories,
      files,
    });
  } catch (error) {
    log.error(`Failed to browse files: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// GET /image-preview - Serve an image file for preview (limited to image types, max 5MB)
router.get("/image-preview", async (req, res) => {
  try {
    const filePath = req.query.path ? String(req.query.path) : null;
    if (!filePath) {
      return res.status(400).json({
        error: "Path is required",
        code: ErrorCode.IMAGE_PREVIEW_PATH_REQUIRED,
      });
    }

    // HT3: a browse reference, or an absolute path from a role that sees
    // host folders (resolveBrowseTarget()).
    const resolved = resolveBrowseTarget(
      filePath,
      await getAllowedBrowseRoots(req),
      await hostPathViewFor(req.user),
    );
    if (!resolved) {
      return res.status(403).json({
        error: "Access denied: path is outside allowed server directories",
        code: ErrorCode.BROWSE_ACCESS_DENIED,
      });
    }

    if (!fs.existsSync(resolved)) {
      return res.status(404).json({
        error: "File not found",
        code: ErrorCode.FILE_NOT_FOUND,
      });
    }

    const ext = path.extname(resolved).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      return res.status(400).json({
        error: "Not an image file",
        code: ErrorCode.IMAGE_PREVIEW_NOT_IMAGE,
      });
    }

    const stat = await fs.promises.stat(resolved);
    if (stat.size > 5 * 1024 * 1024) {
      return res.status(400).json({
        error: "Image file exceeds 5MB limit",
        code: ErrorCode.IMAGE_PREVIEW_TOO_LARGE,
      });
    }

    const mimeMap = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".bmp": "image/bmp",
      ".webp": "image/webp",
    };
    const contentType = mimeMap[ext] || "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=60");
    const previewStream = fs.createReadStream(resolved);
    previewStream.on("error", (err) => {
      log.error(`Image preview stream error: ${err.message}`);
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    previewStream.pipe(res);
  } catch (error) {
    log.error(`Failed to serve image preview: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
