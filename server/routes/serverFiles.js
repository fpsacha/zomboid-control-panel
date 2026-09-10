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
  maskSecretValue,
} from "../utils/sanitize.js";
import { withFileLock, writeFileAtomic } from "../utils/fileWriteQueue.js";
import {
  getBackupPath,
  createBackup,
  backupWarningFor,
  writeIniWithBackup,
  parseAnyBackupFilename,
} from "../utils/configBackup.js";
import { escapeRegExp } from "../utils/regex.js";
import { findDuplicateIniKeys } from "../utils/iniDuplicateKeys.js";
import { confineToRoots } from "../utils/browseRoots.js";
import {
  SFTP_CONFIG_PATH_KEY,
  acquireMirrorLock,
  beginRemoteConfigSession,
  getMirrorPath,
  isRemoteConfigConfigured,
  pushRemoteConfigFiles,
  validateRemoteConfigTransport,
} from "../services/remoteConfigFiles.js";
import {
  requireStoppedForLocalConfigMutation,
  warnRunningForLocalConfigEdit,
} from "../services/configMutationGuard.js";
import { requirePermission } from "../services/permissions.js";
import { ErrorCode } from "../utils/errorCodes.js";

const router = express.Router();

// INI/sandbox/spawn config editing, file backups/restore, and templates —
// "config" and "backups" are explicitly technician's job per the role
// brief; moderator has no server-config editing role. Applied once at the
// router level rather than per-route (25 endpoints). Previously any
// logged-in role, including moderator, could edit sandbox vars or restore
// a server file backup.
router.use(requirePermission("serverfiles.manage"));

// PUT /ini writes any key in the submitted settings object to the same
// Server/<name>.ini file server.js's own /configure-rcon and
// /configure-network routes edit under server.configure -- RCONPassword,
// RCONPort, DefaultPort, UDPPort and UPnP. serverfiles.manage's description
// ("Edit sandbox options, spawn points and other server config files") gives
// no hint that holding it also lets a caller rewrite the RCON password or
// the game's listen port through this generic editor, bypassing
// server.configure's own dedicated gate on those exact fields. Found in the
// 2026-08-26 capability-description sweep, finding 4.
const INI_KEY_CAPABILITY = {
  RCONPassword: "server.configure",
  RCONPort: "server.configure",
  DefaultPort: "server.configure",
  UDPPort: "server.configure",
  UPnP: "server.configure",
};

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
  next();
});

// A remote server has no local filesystem, but its Server/ folder is reachable
// over the SFTP credentials PanelBridge already uses. Mirror it in before the
// handler runs and push back whatever the handler changed, so every existing
// local-filesystem handler below works unmodified.
router.use(async (req, res, next) => {
  const { activeServer, serverName } = req.activeServerContext;
  if (!activeServer?.isRemote) return next();

  if (LOCAL_ONLY_PATHS.has(req.path)) {
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
    return res.status(502).json({
      error: `Could not read the remote server config folder: ${sanitizeError(err.message)}`,
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
function isLocalConfigOverwrite(req) {
  if (req.method === "POST" && /^\/templates\/[^/]+\/apply$/.test(req.path)) {
    return true;
  }
  return req.method === "POST" && /^\/restore\/[^/]+$/.test(req.path);
}

function isLocalConfigEdit(req) {
  return LOCAL_CONFIG_MUTATIONS.has(`${req.method} ${req.path}`);
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
    return requireStoppedForLocalConfigMutation(req, res, next);
  }
  if (isLocalConfigEdit(req)) {
    return warnRunningForLocalConfigEdit(req, res, next);
  }
  return next();
});

// Escape strings for safe interpolation into Lua source code
function escapeLuaString(str) {
  return String(str).replace(/[\\"'\n\r\t\0\[\]]/g, (c) => {
    const escapes = {
      "\\": "\\\\",
      '"': '\\"',
      "'": "\\'",
      "\n": "\\n",
      "\r": "\\r",
      "\t": "\\t",
      "\0": "\\0",
      "[": "\\[",
      "]": "\\]",
    };
    return escapes[c] || c;
  });
}

const LUA_UNESCAPES = {
  "\\": "\\",
  '"': '"',
  "'": "'",
  n: "\n",
  r: "\r",
  t: "\t",
  0: "\0",
  "[": "[",
  "]": "]",
};

// Inverse of escapeLuaString. Parsing must undo what writing escaped, otherwise
// every save re-escapes the same backslashes and doubles them until the file is
// corrupt (seen in the wild: StreetlightGen.ExcludeSprites grew to 16k slashes).
function unescapeLuaString(value) {
  const str = String(value);
  if (!/^"[\s\S]*"$|^'[\s\S]*'$/.test(str)) {
    return str.replace(/^["']|["']$/g, "");
  }
  return str
    .slice(1, -1)
    .replace(/\\([\s\S])/g, (match, c) =>
      Object.prototype.hasOwnProperty.call(LUA_UNESCAPES, c)
        ? LUA_UNESCAPES[c]
        : match,
    );
}

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

  const safe = path.basename(raw);
  if (safe !== raw || !safe) {
    throw new Error("Configured server name contains invalid path characters");
  }
  return safe;
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
  if (activeServer?.serverName) {
    serverName = activeServer.serverName;
  } else {
    const settings = await getAllSettings();
    serverName = settings.serverName;
  }
  if (!serverName) {
    throw new ServerNotConfiguredError();
  }
  const safeServerName = path.basename(serverName);
  if (safeServerName !== serverName || !safeServerName) {
    throw new Error("Configured server name contains invalid path characters");
  }

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
  if (!serverConfigPath) {
    const settings = await getAllSettings();
    if (settings.serverConfigPath) {
      serverConfigPath = settings.serverConfigPath;
    } else if (settings.zomboidDataPath) {
      serverConfigPath = path.join(settings.zomboidDataPath, "Server");
    }
  }
  if (!serverConfigPath) {
    if (activeServer?.isRemote) {
      throw new RemoteConfigNotConfiguredError();
    }
    throw new ServerNotConfiguredError();
  }

  return { activeServer, serverConfigPath, serverName: safeServerName };
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

// Drop any `Key=Value` line whose key looks secret-like (SENSITIVE_FIELD_RE
// -- same regex GET /app-settings already trusts, not a second hand-kept
// list) from a raw .ini file's text, preserving every other line -- comments,
// blank lines, formatting -- byte for byte. Used only when SAVING a template
// snapshot (POST /templates): that snapshot's `iniRaw` is later written
// VERBATIM into the live .ini on apply (writeFileAtomic(iniPath,
// template.iniRaw), no merge), so a masked placeholder string here would
// land in the live RCON/join password field on apply and break RCON --
// omitting the line entirely just means the applied server has no RCON
// password configured afterward (a normal, working, fixable state), not a
// bogus one. Line-level rather than parse-then-reserialize: reusing
// parseIni()/toIni() here would rewrite every OTHER line too, and toIni()'s
// own merge semantics keep an omitted key's ORIGINAL line untouched --
// exactly the opposite of what a strip needs.
export function stripSensitiveIniLines(content) {
  const lines = content.split(/\r?\n/);
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      return true;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) return true;
    const key = trimmed.substring(0, eqIndex).trim();
    return !SENSITIVE_FIELD_RE.test(key);
  });
  return kept.join("\n");
}

// GET /raw/:type=ini's read-side counterpart to the structured /ini route's
// maskSensitiveObject(): mask a secret-shaped `Key=Value` line's VALUE in
// place, byte-for-byte otherwise (everything up to and including the `=`,
// comments, blank lines, formatting). Unlike stripSensitiveIniLines() above,
// this can't drop the line -- the raw editor's PUT round-trips this exact
// text back, and reconcileMaskedIniLines() below needs the line to still be
// there (by key) to know what it's reconciling against.
export function maskSensitiveIniLines(content) {
  const lines = content.split(/\r?\n/);
  const masked = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      return line;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) return line;
    const key = line.substring(0, eqIndex).trim();
    const value = line.substring(eqIndex + 1);
    if (!SENSITIVE_FIELD_RE.test(key) || !value) return line;
    return `${line.substring(0, eqIndex + 1)}${maskSecretValue(value)}`;
  });
  return masked.join("\n");
}

// PUT /raw/:type=ini's write-side counterpart. Unlike the structured /ini
// route, the raw editor round-trips ONE FULL TEXT BLOB on every save with no
// per-line diff against what the operator actually touched -- Save always
// resubmits the whole thing, regardless of which line changed. So masking
// the read alone would let ANY raw-mode save (editing an unrelated line)
// silently overwrite a live secret with the "••••••••xxxx"
// placeholder text the moment that key's line comes back unchanged.
//
// This reconciles by KEY, never by line position -- reordering lines or
// inserting a new one above a secret must not misalign the match -- and it
// REFUSES the entire save (returns ok:false, writes nothing) the instant a
// masked value can't be resolved unambiguously, rather than guessing or
// best-effort patching part of the file. A rejected save costs the operator
// one retry; a half-reconciled write costs them their live server config,
// which is a strictly worse failure than the secret leak this exists to
// close. Three ways a masked line fails to resolve, all refused the same
// way: the key doesn't exist in the live file any more; the key exists more
// than once in either the live file or the incoming submission (which one
// would even be "the" secret to restore?); or -- the case a naive line-diff
// would miss entirely -- the key existed live with a real value but is
// ABSENT from the incoming content altogether, meaning the operator deleted
// a line that reads as bullets, quite possibly without realizing it was a
// real credential. All four are treated as "can't safely tell what the
// operator intended" rather than silently picking a side.
export function reconcileMaskedIniLines(incomingContent, liveContent) {
  const indexIniLines = (text) => {
    const lines = text.split(/\r?\n/);
    const byKey = new Map();
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex <= 0) return;
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ index, line, value });
    });
    return byKey;
  };

  const incomingByKey = indexIniLines(incomingContent);
  const liveByKey = indexIniLines(liveContent);
  const outLines = incomingContent.split(/\r?\n/);

  for (const [key, entries] of incomingByKey) {
    if (!SENSITIVE_FIELD_RE.test(key)) continue;
    const maskedEntries = entries.filter((e) => isMaskedSecret(e.value));
    if (maskedEntries.length === 0) continue;

    const liveEntries = liveByKey.get(key) || [];
    if (maskedEntries.length > 1 || liveEntries.length !== 1) {
      return { ok: false, reason: "unresolvable", key };
    }
    outLines[maskedEntries[0].index] = liveEntries[0].line;
  }

  for (const [key, liveEntries] of liveByKey) {
    if (!SENSITIVE_FIELD_RE.test(key)) continue;
    if (liveEntries.length !== 1 || !liveEntries[0].value) continue;
    if (!incomingByKey.has(key)) {
      return { ok: false, reason: "removed", key };
    }
  }

  return { ok: true, content: outLines.join("\n") };
}

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
    const lineEnding = originalContent.includes("\r\n") ? "\r\n" : "\n";
    const lines = originalContent.split(/\r?\n/);
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
          // Rewrite only the value token, keeping the line's own leading
          // indentation, key spelling, and whitespace around "=" exactly as
          // written -- the submitted settings object always contains every
          // key GET returned (the client resends the whole thing on every
          // save), so this branch runs for every unchanged line too. A
          // hardcoded "key=value" rebuild here silently strips any spacing
          // an operator's hand-edited file had (e.g. "PVP = true") the first
          // time ANY field is saved from the structured editor -- same shape
          // as the CRLF bug (573f63fd), one level down.
          const lineEqIndex = line.indexOf("=");
          const afterEq = line.slice(lineEqIndex + 1);
          const valueMatch = afterEq.match(/^(\s*)([\s\S]*?)(\s*)$/);
          const [, leadingWs, , trailingWs] = valueMatch;
          result.push(
            `${line.slice(0, lineEqIndex + 1)}${leadingWs}${safeValue}${trailingWs}`,
          );
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

    return result.join(lineEnding);
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

// Parse SandboxVars.lua
export function parseSandboxVars(content) {
  const result = {
    VERSION: 4,
    settings: {},
    ZombieLore: {},
    ZombieConfig: {},
    MultiplierConfig: {},
    Map: {},
    Basement: {},
    Music: {},
    Debug: {},
  };

  // Known nested blocks to skip when parsing top-level settings
  const nestedBlocks = [
    "ZombieLore",
    "ZombieConfig",
    "MultiplierConfig",
    "Map",
    "Basement",
    "Music",
    "Debug",
  ];

  try {
    // Extract VERSION
    const versionMatch = content.match(/VERSION\s*=\s*(\d+)/);
    if (versionMatch) {
      result.VERSION = parseInt(versionMatch[1], 10);
    }

    // Strip nested block regions from content so the top-level regex
    // doesn't accidentally capture keys that belong inside ZombieLore,
    // ZombieConfig, MultiplierConfig, Map, or Basement.
    let topLevelContent = content;
    for (const blockName of nestedBlocks) {
      const blockPattern = new RegExp(
        escapeRegExp(blockName) + "\\s*=\\s*\\{[\\s\\S]*?\\n\\s*\\}",
        "m",
      );
      topLevelContent = topLevelContent.replace(blockPattern, "");
    }

    // Parse simple key=value pairs (top-level settings only).
    // The value alternation tries a quoted string first so values like
    // WorldItemRemovalList = "Base.Hat,Base.Glasses,..." aren't truncated
    // at the first comma *inside* the quotes.
    const simplePattern =
      /^\s*(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,{}\n]+),?\s*(?:--.*)?$/gm;
    let match;
    while ((match = simplePattern.exec(topLevelContent)) !== null) {
      const key = match[1];
      let value = match[2].trim();

      // Skip nested objects and VERSION
      if (nestedBlocks.includes(key) || key === "VERSION") continue;

      // Parse value type
      if (value === "true") value = true;
      else if (value === "false") value = false;
      else if (!isNaN(parseFloat(value))) value = parseFloat(value);
      else value = unescapeLuaString(value);

      result.settings[key] = value;
    }

    // Helper function to parse a nested block
    function parseNestedBlock(blockName) {
      // Match nested blocks - handle both simple and complex nested structures
      const blockPattern = new RegExp(
        `${blockName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\}`,
        "m",
      );
      const blockMatch = content.match(blockPattern);

      if (blockMatch) {
        const blockContent = blockMatch[1];
        // Strip Lua comment lines to avoid parsing comment text as keys
        // (e.g. "-- 1 = Sprinters" or "-- Default = Random")
        const strippedContent = blockContent.replace(/^\s*--.*$/gm, "");
        const valuePattern = /(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,\n]+)/g;
        let valueMatch;
        while ((valueMatch = valuePattern.exec(strippedContent)) !== null) {
          let value = valueMatch[2].trim();
          // Remove trailing comma if present
          value = value.replace(/,\s*$/, "");

          if (value === "true") value = true;
          else if (value === "false") value = false;
          else if (!isNaN(parseFloat(value))) value = parseFloat(value);
          else value = unescapeLuaString(value);

          result[blockName][valueMatch[1]] = value;
        }
      }
    }

    // Parse all nested blocks
    nestedBlocks.forEach(parseNestedBlock);
  } catch (error) {
    log.error("Failed to parse SandboxVars:", error);
  }

  return result;
}

// Format a number for Lua, preserving the original file's decimal format
function formatLuaNumber(newValue, originalValueStr) {
  const trimmed = originalValueStr
    ? originalValueStr.trim().replace(/,\s*$/, "")
    : "";
  // If the original value had a decimal point and the new value is a whole number, add .0
  if (Number.isInteger(newValue) && trimmed.includes(".")) {
    return newValue.toFixed(1);
  }
  return newValue.toString();
}

// Modify a single value in the SandboxVars file content in-place
// Preserves all comments and file structure
function modifySandboxValue(
  originalContent,
  key,
  newValue,
  nestedBlock = null,
) {
  let content = originalContent;

  // Validate key is a valid identifier (alphanumeric and underscore only)
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
    log.warn(`Invalid sandbox key skipped: ${key}`);
    return content;
  }

  // Format the value for Lua (base format, may be refined by context)
  function formatValue(originalValueStr) {
    if (typeof newValue === "boolean") {
      return newValue.toString();
    } else if (typeof newValue === "number") {
      return formatLuaNumber(newValue, originalValueStr);
    } else {
      return `"${escapeLuaString(String(newValue))}"`;
    }
  }

  // Escape key for use in regex (even though we validate, this is defense in depth)
  const escapedKey = escapeRegExp(key);

  if (nestedBlock) {
    // For nested blocks (ZombieLore, ZombieConfig, etc.)
    // Only match actual assignment lines (not comment lines starting with --)
    const escapedBlock = escapeRegExp(nestedBlock);
    const blockStartPattern = new RegExp(`${escapedBlock}\\s*=\\s*\\{`);
    const blockStartMatch = content.match(blockStartPattern);
    if (blockStartMatch) {
      const blockStart = blockStartMatch.index;
      const blockEnd = content.indexOf(
        "}",
        blockStart + blockStartMatch[0].length,
      );
      if (blockEnd !== -1) {
        const before = content.substring(0, blockStart);
        const blockSection = content.substring(blockStart, blockEnd + 1);
        const after = content.substring(blockEnd + 1);
        // Replace only on non-comment lines within the block.
        // The value alternation matches a full quoted string first so
        // values containing commas (e.g. comma-separated lists) aren't
        // truncated mid-string, which would corrupt the Lua syntax.
        const updatedBlock = blockSection.replace(
          new RegExp(
            `(^(?!\\s*--)[^\\n]*?)(${escapedKey})(\\s*=\\s*)("(?:[^"\\\\]|\\\\.)*"|[^,\\n}]+)(,?)`,
            "m",
          ),
          (_, prefix, k, eq, oldVal, comma) =>
            `${prefix}${k}${eq}${formatValue(oldVal)}${comma}`,
        );
        content = before + updatedBlock + after;
      }
    }
  } else {
    // For top-level settings, only replace occurrences OUTSIDE nested blocks
    // to avoid accidentally modifying keys that share a name with a nested key.
    const knownBlocks = [
      "ZombieLore",
      "ZombieConfig",
      "MultiplierConfig",
      "Map",
      "Basement",
      "Music",
      "Debug",
    ];
    const blockRanges = [];
    for (const bn of knownBlocks) {
      const bp = new RegExp(escapeRegExp(bn) + "\\s*=\\s*\\{");
      const bm = content.match(bp);
      if (bm) {
        const start = bm.index;
        const end = content.indexOf("}", start + bm[0].length);
        if (end !== -1) blockRanges.push({ start, end: end + 1 });
      }
    }

    // The value alternation matches a full quoted string first so values
    // containing commas (e.g. comma-separated lists like
    // WorldItemRemovalList) aren't truncated mid-string, which would
    // corrupt the Lua syntax.
    const pattern = new RegExp(
      `(^\\s*)(${escapedKey})(\\s*=\\s*)("(?:[^"\\\\]|\\\\.)*"|[^,\\n}]+)(,?)(\\s*(?:--.*)?$)`,
      "gm",
    );
    content = content.replace(
      pattern,
      (fullMatch, indent, k, eq, oldVal, comma, comment, offset) => {
        // Skip matches inside nested blocks
        for (const range of blockRanges) {
          if (offset >= range.start && offset < range.end) return fullMatch;
        }
        return `${indent}${k}${eq}${formatValue(oldVal)}${comma}${comment}`;
      },
    );
  }

  return content;
}

// Count { / } in a SandboxVars.lua content string. A healthy file always has
// an equal number of each with the running depth never going negative. This
// is the cheapest possible syntax sanity check we can do without a real Lua
// parser, but it happens to catch the exact class of corruption PZ's own
// dedicated server crashes on: an orphaned/dropped block header that leaves
// a dangling closing brace (see "Exiting due to errors loading ..." crashes
// with a KahluaException "'}' expected").
export function checkSandboxBraceBalance(content) {
  let depth = 0;
  let wentNegative = false;
  for (const ch of content) {
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) wentNegative = true;
    }
  }
  return { balanced: depth === 0 && !wentNegative, depth };
}

// Attempt to auto-repair the most common SandboxVars.lua corruption pattern:
// a nested block's "<Name> = {" header line (and the trailing comma on the
// first entry) got dropped somewhere upstream (mod schema migration, manual
// editing, etc.), leaving an orphaned scalar entry at a shallower indent
// than its former siblings — with the original closing "}" still present
// further down. That desyncs the whole file's brace count and makes PZ's
// Lua loader refuse to parse the file at all.
//
// Repair strategy: whenever a scalar "key = value" line (no trailing comma)
// is immediately followed by a more-deeply-indented entry line, treat it as
// an orphaned block opener. Add the missing comma and synthesize a wrapper
// table around it so the existing (now-dangling) closing brace has
// something to match again. This is deliberately conservative — it never
// deletes or reinterprets existing content, only restores brace balance —
// and every attempt is re-validated for balance before anything is written.
export function repairSandboxSyntax(content) {
  const before = checkSandboxBraceBalance(content);
  if (before.balanced) {
    return { content, fixed: false, changes: [] };
  }

  const lines = content.split(/\r?\n/);
  const changes = [];
  const scalarLine =
    /^(\s*)(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|true|false|-?\d+(?:\.\d+)?)\s*(--.*)?$/;
  const entryLine = /^(\s*)(\w+)\s*=\s*/;
  let syntheticCounter = 0;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(scalarLine);
    if (!m) continue;
    const indent = m[1];

    // Find the next non-blank, non-comment line.
    let j = i + 1;
    while (
      j < lines.length &&
      (lines[j].trim() === "" || /^\s*--/.test(lines[j]))
    ) {
      j++;
    }
    if (j >= lines.length) continue;

    const nextEntry = lines[j].match(entryLine);
    if (!nextEntry) continue;
    if (nextEntry[1].length <= indent.length) continue; // normal sibling/closing — not orphaned

    syntheticCounter += 1;
    changes.push(
      `Line ${i + 1}: '${m[2]} = ${m[3]}' looked like an orphaned block entry (missing block header and comma) — wrapped it in a synthetic '_RepairedBlock${syntheticCounter}' table so the file parses again.`,
    );
    lines[i] =
      `${indent}_RepairedBlock${syntheticCounter} = {\n${indent}    ${m[2]} = ${m[3]},`;
  }

  const repaired = lines.join("\n");
  const after = checkSandboxBraceBalance(repaired);
  return {
    content: repaired,
    fixed: after.balanced && changes.length > 0,
    changes,
  };
}

// Apply multiple sandbox changes to file content in-place
export function applySandboxChanges(originalContent, changes) {
  let content = originalContent;

  // Apply settings changes
  if (changes.settings) {
    for (const [key, value] of Object.entries(changes.settings)) {
      content = modifySandboxValue(content, key, value, null);
    }
  }

  // Apply ZombieLore changes
  if (changes.ZombieLore) {
    for (const [key, value] of Object.entries(changes.ZombieLore)) {
      content = modifySandboxValue(content, key, value, "ZombieLore");
    }
  }

  // Apply ZombieConfig changes
  if (changes.ZombieConfig) {
    for (const [key, value] of Object.entries(changes.ZombieConfig)) {
      content = modifySandboxValue(content, key, value, "ZombieConfig");
    }
  }

  // Apply MultiplierConfig changes
  if (changes.MultiplierConfig) {
    for (const [key, value] of Object.entries(changes.MultiplierConfig)) {
      content = modifySandboxValue(content, key, value, "MultiplierConfig");
    }
  }

  // Apply Map changes
  if (changes.Map) {
    for (const [key, value] of Object.entries(changes.Map)) {
      content = modifySandboxValue(content, key, value, "Map");
    }
  }

  // Apply Basement changes
  if (changes.Basement) {
    for (const [key, value] of Object.entries(changes.Basement)) {
      content = modifySandboxValue(content, key, value, "Basement");
    }
  }

  return content;
}

// The 6 top-level shapes applySandboxChanges()/createSandboxVars() actually
// know how to write. Music and Debug are parsed by parseSandboxVars() (read
// path) but neither writer touches them, so they're deliberately excluded
// here too -- checking them would report every Music/Debug key as
// "unpersisted" even though no write was ever attempted for them.
const SANDBOX_WRITABLE_SECTIONS = [
  "settings",
  "ZombieLore",
  "ZombieConfig",
  "MultiplierConfig",
  "Map",
  "Basement",
];

// modifySandboxValue() (used by applySandboxChanges for an existing file)
// silently returns its input unchanged when a submitted key's regex finds no
// matching line to update -- key not present in this file, lives in a block
// modifySandboxValue doesn't know about, unusual formatting, etc. Compares
// `submitted` (the request body's `sandbox` object) against `persisted` (the
// freshly re-parsed on-disk content, via parseSandboxVars) and returns the
// list of keys that were requested but did not actually change, formatted as
// "key" for top-level settings or "Section.key" for a nested block.
export function findUnpersistedSandboxKeys(submitted, persisted) {
  const unpersistedKeys = [];
  for (const section of SANDBOX_WRITABLE_SECTIONS) {
    const submittedSection = submitted[section];
    if (!submittedSection || typeof submittedSection !== "object") continue;
    const persistedSection =
      section === "settings" ? persisted.settings : persisted[section];
    for (const [key, value] of Object.entries(submittedSection)) {
      if ((persistedSection || {})[key] !== value) {
        unpersistedKeys.push(section === "settings" ? key : `${section}.${key}`);
      }
    }
  }
  return unpersistedKeys;
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
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          lines.push(`    ${key} = ${formatValue(value)},`);
        }
      }
      continue;
    }

    lines.push(`    ${sectionName} = {`);
    for (const [key, value] of Object.entries(values)) {
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
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

    res.json({ configPath, serverName, files, exists });
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
    res.json({
      settings: maskSensitiveObject(parsed),
      path: filePath,
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
    // value, never GET's masked response.
    const touchesGovernedIniKey = Object.keys(submittedSettings).some(
      (key) => key in INI_KEY_CAPABILITY,
    );
    if (touchesGovernedIniKey) {
      const currentIni = parseIni(currentIniContent);
      const missingCapabilities = [];
      let callerCapabilities = null;
      for (const [key, value] of Object.entries(submittedSettings)) {
        const requiredCapability = INI_KEY_CAPABILITY[key];
        if (!requiredCapability) continue;
        if (String(currentIni[key] ?? "") === String(value ?? "")) continue;
        if (callerCapabilities === null) {
          const role = req.user ? await getRoleByName(req.user.role) : null;
          callerCapabilities = Array.isArray(role?.capabilities) ? role.capabilities : [];
        }
        if (!callerCapabilities.includes(requiredCapability)) {
          missingCapabilities.push({ key, requiredCapability });
        }
      }
      if (missingCapabilities.length > 0) {
        const detail = missingCapabilities
          .map((m) => `"${m.key}" needs ${m.requiredCapability}`)
          .join(", ");
        return res.status(403).json({
          error: `Cannot change ${detail} without holding that capability yourself.`,
          missing: missingCapabilities,
        });
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
      const persisted = parseIni(fs.readFileSync(filePath, "utf-8"));
      const original = parseIni(originalContent);
      for (const [key, value] of Object.entries(submittedSettings)) {
        const isExistingKey = Object.prototype.hasOwnProperty.call(original, key);
        const isNewNonEmptyKey = value !== "" && value !== null && value !== undefined;
        if ((isExistingKey || isNewNonEmptyKey) && persisted[key] !== String(value).replace(/[\r\n]/g, "")) {
          throw new Error(`INI write verification failed for ${key}`);
        }
      }
      return persisted;
    });

    log.info("Saved INI file");
    res.json({
      success: true,
      message: "Settings saved",
      path: filePath,
      settings: maskSensitiveObject(persistedSettings),
      ...(backupWarning ? { backupWarning } : {}),
      ...(req.configEditRestartWarning ? { restartRequired: true } : {}),
    });
  } catch (error) {
    log.error("Failed to save INI:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

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
    const parsed = parseSandboxVars(content);

    res.json({ sandbox: parsed, path: filePath, serverName });
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
    await withFileLock(filePath, async () => {
      fileExists = fs.existsSync(filePath);
      const newContent = fileExists
        ? applySandboxChanges(fs.readFileSync(filePath, "utf-8"), sandbox)
        : createSandboxVars(sandbox);
      if (fileExists) {
        backupWarning = backupWarningFor(
          await createBackup(configPath, `${serverName}_SandboxVars.lua`),
        );
      }
      writeFileAtomic(filePath, newContent, "utf-8");

      // Without this read-back, a key modifySandboxValue() couldn't find a
      // line for was silently dropped and this route still reported success
      // (this route's own PUT /ini sibling already verifies its writes this
      // way; this route did not).
      const persisted = parseSandboxVars(fs.readFileSync(filePath, "utf-8"));
      unpersistedKeys = findUnpersistedSandboxKeys(sandbox, persisted);
    });

    if (unpersistedKeys.length > 0) {
      log.warn(
        `SandboxVars keys did not persist (no matching entry found to update): ${unpersistedKeys.join(", ")}`,
      );
    }
    log.info(`${fileExists ? "Saved" : "Created"} SandboxVars file`);
    res.json({
      success: true,
      created: !fileExists,
      message: fileExists ? "Sandbox settings saved" : "SandboxVars file created",
      path: filePath,
      ...(unpersistedKeys.length > 0 ? { unpersistedKeys } : {}),
      ...(backupWarning ? { backupWarning } : {}),
      ...(req.configEditRestartWarning ? { restartRequired: true } : {}),
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
    let backupWarning = null;
    await withFileLock(filePath, async () => {
      const originalContent = fs.readFileSync(filePath, "utf-8");
      const newContent = modifySandboxValue(originalContent, key, value, block);
      if (newContent === originalContent) return;
      backupWarning = backupWarningFor(
        await createBackup(configPath, `${serverName}_SandboxVars.lua`),
      );
      writeFileAtomic(filePath, newContent, "utf-8");
      persisted = true;
    });

    log.info(`Sandbox option ${name} persisted: ${persisted}`);
    res.json({
      success: true,
      persisted,
      ...(backupWarning ? { backupWarning } : {}),
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
  // remote server has to pull and push around its own write.
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
    const { serverConfigPath, serverName } = await getActiveServerPaths();
    return await writeSandboxValues(entries, serverConfigPath, serverName);
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
    let content = originalContent;

    // modifySandboxValue only rewrites existing assignments, so a key that
    // isn't in the file would no-op and look like "already correct".
    const missing = entries
      .map(([key]) => key)
      .filter(
        (key) => !new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "m").test(content),
      );
    if (missing.length > 0) {
      reason = `not present in SandboxVars.lua: ${missing.join(", ")}`;
      return;
    }

    for (const [key, value] of entries) {
      content = modifySandboxValue(content, key, value, null);
    }
    if (content === originalContent) {
      reason = "values already match";
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

// Check whether SandboxVars.lua is syntactically well-formed (brace balance
// only — we don't have a real Lua parser). A corrupt file here is a classic
// cause of "server won't boot, no obvious reason" reports.
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
    const { balanced, depth } = checkSandboxBraceBalance(content);
    res.json({ valid: balanced, braceDepth: depth });
  } catch (error) {
    log.error("Failed to validate SandboxVars:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Attempt to auto-repair SandboxVars.lua. Refuses to write anything unless
// BOTH the repaired content is verified brace-balanced AND a real backup of
// the broken file was made first — if the corruption doesn't match a known
// repair pattern, or the backup can't be created, nothing is written and
// the caller is told exactly why and what to do about it. This route
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
      const before = checkSandboxBraceBalance(originalContent);
      if (before.balanced) {
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

// Get spawn points
router.get("/spawnpoints", async (req, res) => {
  try {
    const { serverConfigPath: configPath, serverName } = req.activeServerContext;
    const filePath = path.join(configPath, `${serverName}_spawnpoints.lua`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: "Spawn points file not found",
        path: filePath,
        code: ErrorCode.SPAWNPOINTS_FILE_NOT_FOUND,
      });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const points = parseSpawnPoints(content);

    res.json({ spawnpoints: points, path: filePath });
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
        path: filePath,
        code: ErrorCode.SPAWNREGIONS_FILE_NOT_FOUND,
      });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const regions = parseSpawnRegions(content);

    res.json({ spawnregions: regions, path: filePath });
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
    res.json({
      content: type === "ini" ? maskSensitiveIniLines(content) : content,
      filename: fileMap[type],
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
    await withFileLock(filePath, async () => {
      let contentToWrite = content;

      // Only the ini type is Key=Value text that GET /raw ever masks --
      // sandbox/spawnpoints/spawnregions are Lua table syntax, not INI
      // lines, so running line-based reconciliation on them would at best
      // no-op and at worst corrupt them. SandboxVars also has no RCON
      // field to protect in the first place.
      if (type === "ini" && fs.existsSync(filePath)) {
        const liveContent = fs.readFileSync(filePath, "utf-8");
        const reconciled = reconcileMaskedIniLines(content, liveContent);
        if (!reconciled.ok) {
          reconcileFailure = reconciled;
          return;
        }
        contentToWrite = reconciled.content;
      }

      if (type === "ini") {
        backupWarning = backupWarningFor(await writeIniWithBackup(filePath, contentToWrite));
      } else {
        if (fs.existsSync(filePath)) {
          backupWarning = backupWarningFor(await createBackup(configPath, fileMap[type]));
        }
        writeFileAtomic(filePath, contentToWrite, "utf-8");
      }
    });

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

    res.json({ backups: files, path: backupDir });
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
    await withFileLock(targetPath, async () => {
      if (fs.existsSync(targetPath)) {
        const backup = await createBackup(configPath, originalName);
        if (!backup.backedUp && backup.reason !== "no-source") {
          preRestoreBackupWarning = `Could not back up the current ${originalName} before restoring over it: ${backup.error}. The version that was in place before this restore is not recoverable through this panel.`;
        }
      }

      writeFileAtomic(targetPath, backupData);
    });

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
    const templatesPath = await ensureTemplatesDir(req);

    const files = fs
      .readdirSync(templatesPath)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const filePath = path.join(templatesPath, f);
          const stats = fs.statSync(filePath);
          const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
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

    if (!fs.existsSync(templateFile)) {
      return res.status(404).json({
        error: "Template not found",
        code: ErrorCode.TEMPLATE_NOT_FOUND,
      });
    }

    const content = JSON.parse(fs.readFileSync(templateFile, "utf-8"));
    res.json(content);
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
    // placeholder, is the safe choice given how POST /templates/:id/apply
    // writes iniRaw back.
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
    fs.writeFileSync(templateFile, JSON.stringify(template, null, 2));
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

    if (!fs.existsSync(templateFile)) {
      return res.status(404).json({
        error: "Template not found",
        code: ErrorCode.TEMPLATE_NOT_FOUND,
      });
    }

    const template = JSON.parse(fs.readFileSync(templateFile, "utf-8"));
    const { serverConfigPath: configPath, serverName } = req.activeServerContext;

    const backupWarnings = [];

    // Apply INI settings
    if (applyIni && template.iniRaw) {
      const iniPath = path.join(configPath, `${serverName}.ini`);

      await withFileLock(iniPath, async () => {
        // Create backup first
        const iniBackupWarning = backupWarningFor(
          await createBackup(configPath, `${serverName}.ini`),
        );
        if (iniBackupWarning) backupWarnings.push(iniBackupWarning);

        // Write the template INI
        writeFileAtomic(iniPath, template.iniRaw);
      });
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

    if (!fs.existsSync(templateFile)) {
      return res.status(404).json({
        error: "Template not found",
        code: ErrorCode.TEMPLATE_NOT_FOUND,
      });
    }

    const template = JSON.parse(fs.readFileSync(templateFile, "utf-8"));

    if (name) template.name = name;
    if (description !== undefined) template.description = description;
    template.modified = new Date().toISOString();

    fs.writeFileSync(templateFile, JSON.stringify(template, null, 2));

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
 * Restricts browsing to the server config path, server install path,
 * and Zomboid data path — prevents arbitrary filesystem traversal.
 *
 * Takes req (2026-09-08 quadruple-read sweep): used to independently
 * re-derive the active server via its own getActiveServer() call, which is
 * exactly the bug this sweep fixed everywhere else in this file -- the
 * security boundary these roots exist to enforce could be computed against
 * a DIFFERENT server than the one the calling handler's own path resolution
 * already agreed on via req.activeServerContext, if /activate landed between
 * the two. Reads the same single per-request snapshot instead.
 */
async function getAllowedBrowseRoots(req) {
  const roots = [];
  const { activeServer } = req.activeServerContext;
  if (activeServer?.serverConfigPath)
    roots.push(path.resolve(activeServer.serverConfigPath));
  if (activeServer?.zomboidDataPath)
    roots.push(path.resolve(activeServer.zomboidDataPath));
  if (activeServer?.serverPath)
    roots.push(path.resolve(activeServer.serverPath));
  const settings = await getAllSettings();
  if (settings.serverConfigPath)
    roots.push(path.resolve(settings.serverConfigPath));
  if (settings.zomboidDataPath)
    roots.push(path.resolve(settings.zomboidDataPath));
  // Always allow the default Zomboid config directory
  const defaultConfig = path.join(os.homedir(), "Zomboid");
  roots.push(path.resolve(defaultConfig));
  // De-duplicate
  return [...new Set(roots)];
}

// GET /browse-files - List directories and files at a given path
router.get("/browse-files", async (req, res) => {
  try {
    const browsePath = req.query.path ? String(req.query.path) : null;
    const filterExts = req.query.extensions
      ? String(req.query.extensions)
          .split(",")
          .map((e) => e.toLowerCase().trim())
      : null;

    const allowedRoots = await getAllowedBrowseRoots(req);
    let targetPath;
    if (browsePath) {
      targetPath = confineToRoots(browsePath, allowedRoots);
      if (!targetPath) {
        return res.status(403).json({
          error: "Access denied: path is outside allowed server directories",
          code: ErrorCode.BROWSE_ACCESS_DENIED,
        });
      }
    } else {
      // Default to the server config directory
      const { serverConfigPath: configPath } = req.activeServerContext;
      targetPath = configPath || "";
    }

    if (!targetPath) {
      return res.status(400).json({
        error: "No path provided and server config path not set",
        code: ErrorCode.BROWSE_NO_PATH,
      });
    }

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

    res.json({
      currentPath: targetPath,
      parent:
        path.dirname(targetPath) !== targetPath &&
        confineToRoots(path.dirname(targetPath), allowedRoots)
          ? path.dirname(targetPath)
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

    const allowedRoots = await getAllowedBrowseRoots(req);
    const resolved = confineToRoots(filePath, allowedRoots);
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
