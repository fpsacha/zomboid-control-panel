import { parseClampedInteger } from "../utils/queryNumbers.js";
import express from "express";
import os from "os";
import v8 from "v8";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import archiver from "archiver";
import { createLogger } from "../utils/logger.js";
import { getDiskFree } from "../utils/diskSpace.js";
import { resolveLaunchMode } from "../services/serverManager.js";
const log = createLogger("API:Debug");
import { getDataPaths, setDataPaths } from "../utils/paths.js";
import {
  getPerformanceHistory,
  recordPerformanceSnapshot,
  getDatabaseStats,
  createDatabaseBackup,
  compactDatabase,
  getCommandHistory,
  getBridgeLogs,
  getPlayerLogs,
  getDb,
  getActiveServer,
  getServers,
  getScheduledTasks,
  getTrackedMods,
  getAllSettings,
  getCircuitBreakerStatus,
  getRoleByName,
} from "../database/init.js";
import { sanitizeError, sanitizeErrorParams, SENSITIVE_FIELD_RE } from "../utils/sanitize.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { checkSandboxBraceBalance } from "./serverFiles.js";
import panelBridgeService from "../services/panelBridge.js";
import authService from "../services/auth.js";
import { listBackupRecords } from "../services/backupRecords.js";
import {
  getOidcSettings,
  getOidcEnvOverrides,
  isOidcConfigured,
} from "../services/oidc.js";
import {
  PZ_TILES_ROOT,
  getB42Dir,
  getB42TopFormat,
  getB42ResolutionStatus,
} from "./mapProxy.js";
import { getThumbnailResolutionStatus } from "./mods.js";
import {
  getCandidateZomboidPaths,
  inspectZomboidPath,
} from "../utils/zomboidPaths.js";
import { requirePermission, listRolesWithMemberCounts } from "../services/permissions.js";
import { getDockerClient } from "../services/managedContainer.js";
import { resolveProvider } from "../utils/serverStatusModel.js";
import {
  getLifecycleServiceName,
  isManagedLifecycleProvider,
} from "../services/linuxServiceLifecycle.js";
import { redactRconCommandSecrets } from "../utils/rconCommandRedaction.js";
import {
  collectKnownSecretValues,
  redactKnownSecrets,
} from "../utils/discordMessageRedaction.js";
import { getSteamApiKey } from "../services/steamApiKey.js";
import { hasActiveSteamOperation } from "../services/activeSteamOperations.js";
import { Transform } from "stream";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Every endpoint in this file is admin-only (requirePermission("diagnostics.manage") is
// applied to each route below), with one deliberate exception:
// POST /client-errors is client-side crash/error telemetry, and it is fully
// UNAUTHENTICATED — no login required at all, not even "any logged-in
// role". A frontend crash can happen before the client has authenticated,
// most notably on the login page itself, where there is no token to attach
// and no req.user to check — requiring login here would silently delete
// exactly the crash reports an operator most needs to see. What protects it
// instead: a per-IP rate limit, plus the fact that it only ever logs a
// message and mutates/exposes nothing sensitive. See the comment directly
// above that route for the full reasoning.
//
// This was previously the whole file's exposure: behind the central login
// gate only, so ANY authenticated role — including a moderator — could
// trigger a database backup, compact the database, or clear stale locks.

// In-memory log buffer for real-time streaming
const logBuffer = [];
const MAX_BUFFER_SIZE = 500;

// Hook into Winston to capture logs for streaming
export function addLogToBuffer(level, message, source = "server") {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    source,
  };

  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER_SIZE) {
    logBuffer.shift();
  }

  return entry;
}

// Get system RAM info for auto-configuration
router.get("/ram", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const totalMemBytes = os.totalmem();
    const freeMemBytes = os.freemem();
    const totalMemGB = Math.floor(totalMemBytes / (1024 * 1024 * 1024));
    const freeMemGB = Math.floor(freeMemBytes / (1024 * 1024 * 1024));

    // Calculate recommended settings
    // Reserve ~4GB for OS/other apps, use 50-75% of remaining for server
    const availableForServer = Math.max(1, totalMemGB - 4);
    const recommendedMax = Math.min(Math.floor(availableForServer * 0.75), 16); // Cap at 16GB
    const recommendedMin = Math.max(1, Math.floor(recommendedMax * 0.5)); // Min is 50% of max

    res.json({
      totalGB: totalMemGB,
      freeGB: freeMemGB,
      recommendedMin,
      recommendedMax,
    });
  } catch (error) {
    log.error(`Failed to get RAM info: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get system information
router.get("/system", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const paths = getDataPaths();

    // Redact full filesystem paths to relative/basename for security
    const redactPath = (p) => {
      if (!p) return "Not configured";
      // Show only the last 2 path segments (e.g., "data/db.json")
      const segments = p.replace(/\\/g, "/").split("/").filter(Boolean);
      return segments.length > 2
        ? ".../" + segments.slice(-2).join("/")
        : segments.join("/");
    };

    res.json({
      nodeVersion: process.version,
      platform: process.platform,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      dbPath: fs.existsSync(paths.dbPath)
        ? redactPath(paths.dbPath)
        : "Not found",
      logsPath: fs.existsSync(paths.logsDir)
        ? redactPath(paths.logsDir)
        : "Not found",
      dataDir: redactPath(paths.dataDir),
      pathsConfigurable: true,
      env: {
        NODE_ENV: process.env.NODE_ENV || "development",
        PORT: process.env.PORT || 3001,
        LOG_LEVEL: process.env.LOG_LEVEL || "info",
      },
    });
  } catch (error) {
    log.error(`Failed to get system info: ${error.message}`);
    res.status(500).json({ error: "Failed to get system info" });
  }
});

// Get recent logs from buffer
router.get("/logs", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const limit = parseClampedInteger(req.query.limit, 200, 1, 2000);
    res.json({
      logs: logBuffer.slice(-limit),
      total: logBuffer.length,
    });
  } catch (error) {
    log.error(`Failed to get logs: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

async function getAvailableLogFiles(logsDir) {
  const entries = await fs.promises.readdir(logsDir, { withFileTypes: true });

  const files = (
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
        .map(async (entry) => {
          try {
            const filePath = path.join(logsDir, entry.name);
            const stats = await fs.promises.stat(filePath);
            return {
              name: entry.name,
              size: stats.size,
              modified: stats.mtime.toISOString(),
            };
          } catch (error) {
            log.debug(
              `Stat failed for log file ${entry.name}: ${error.message}`,
            );
            return null;
          }
        }),
    )
  )
    .filter((file) => file !== null)
    .sort(
      (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
    );

  return files;
}

const SUPPORT_LOG_FILE_RE = /\.(log|txt)$/i;
const CRASH_FILE_RE =
  /^(hs_err_pid.*|.*(?:crash|error|exception).*)\.(log|txt)$/i;

async function resolveSearchRoot(candidate) {
  if (!candidate) return null;

  const resolved = path.resolve(candidate);

  try {
    const stats = await fs.promises.stat(resolved);
    return stats.isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    return path.extname(resolved) ? path.dirname(resolved) : resolved;
  }
}

async function collectBundleFilesFromDir(
  dir,
  matcher,
  archivePrefix,
  entries,
  seenFiles,
) {
  if (!dir) return;

  try {
    await fs.promises.access(dir);
  } catch {
    return;
  }

  const dirEntries = await fs.promises.readdir(dir, { withFileTypes: true });

  for (const entry of dirEntries) {
    if (!entry.isFile()) continue;
    if (!matcher(entry.name)) continue;

    const filePath = path.join(dir, entry.name);
    const dedupeKey = path.resolve(filePath).toLowerCase();
    if (seenFiles.has(dedupeKey)) continue;

    seenFiles.add(dedupeKey);
    entries.push({
      filePath,
      archivePath: `${archivePrefix}/${entry.name}`,
    });
  }
}

// ───────────────────────────────────────────────────────────────────────
// Support-bundle diagnostic collectors — every helper below is best-effort
// and must never throw, so the zip download keeps working even on bad data.
// ───────────────────────────────────────────────────────────────────────

// Shared with server/utils/sanitize.js (maskSensitiveObject) so every
// secret-shaped field — settings, server records, and this bundle — is
// masked by the same pattern instead of drifting out of sync.
const SECRET_FIELD_RE = SENSITIVE_FIELD_RE;
const ENV_VALUE_ALLOWLIST = [
  "NODE_ENV",
  "PORT",
  "LOG_LEVEL",
  "HTTPS",
  "FORCE_HSTS",
  "CORS_ORIGINS",
  "CORS_ALLOW_PRIVATE_NETWORKS",
  "CORS_ALLOW_ALL",
  "TZ",
  "LANG",
  "LC_ALL",
  "PUID",
  "PGID",
  "NODE_VERSION",
  "PATH_PREFIX",
  "TRUST_PROXY",
  "PWD",
];
const ENV_PRESENCE_ONLY = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "JWT_SECRET",
  "RCON_PASSWORD",
  "DISCORD_TOKEN",
  "STEAM_API_KEY",
  "PANEL_PASSWORD",
  "ADMIN_PASSWORD",
];

function maskValue(v) {
  return v == null ? v : "••••";
}

/** Deep-clone with any field whose key looks secret-like masked. */
function sanitizeForBundle(value, depth = 0) {
  if (value == null || depth > 8) return value;
  if (Array.isArray(value))
    return value.map((v) => sanitizeForBundle(v, depth + 1));
  if (typeof value !== "object") return value;

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_FIELD_RE.test(k) && typeof v === "string" && v.length > 0) {
      out[k] = maskValue(v);
    } else if (
      k === "discordWebhookUrl" &&
      typeof v === "string" &&
      v.includes("/webhooks/")
    ) {
      out[k] = v.replace(/\/webhooks\/(\d+)\/[^/?#]+/i, "/webhooks/$1/••••");
    } else {
      out[k] = sanitizeForBundle(v, depth + 1);
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────
// Raw-log redaction (support-bundle-2026-08-30 follow-up, operator ruling):
// sanitizeForBundle() above only ever runs on structured data this route
// itself builds, and is a no-op on free text -- it cannot touch a RAW log
// file's content. The operator's ruling was to redact ALL raw logs in the
// bundle uniformly (the four pre-existing filesystem categories AND the
// two container/service-log files added earlier tonight), biased toward
// false positives, but never at the cost of destroying the exact kind of
// evidence (a stack trace, a file path) this bundle exists to preserve --
// see redactRawLogText's own header for the two-layer design and the
// regression test built from the literal line that motivated this feature.
// ───────────────────────────────────────────────────────────────────────

// Discord bot tokens are three base64url segments joined by literal dots --
// a shape distinctive enough that it will not collide with a file path,
// stack trace, or ordinary log line. This is what lets it catch a ROTATED
// token that is no longer any server's *current* configured value (and so
// can't be caught by the known-secret-value scrub below).
const RAW_LOG_DISCORD_TOKEN_RE =
  /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,40}\b/g;

// The one place this panel ever puts a Steam Web API key on a line that
// could end up logged: GetServerList's own request URL (serverFinder.js,
// both call sites), built as `...?key=<key>&filter=...`. Anchored to the
// query-param shape, not a bare hex/alnum run, so it can't collide with an
// unrelated identifier that merely happens to be 16-64 characters long.
const RAW_LOG_STEAM_KEY_QUERY_RE = /([?&]key=)[0-9A-Za-z]{16,64}/g;

/**
 * Support-bundle-specific superset of discordMessageRedaction.js's own
 * known-secret list: everything that list already covers (RCON/join
 * passwords across every server profile, the Discord bot token, the
 * PanelBridge SFTP password, Steam session cookies) plus the Steam Web API
 * key, which that module has no reason to know about (a Discord message
 * could never echo it) but which serverFinder.js does put directly into a
 * request URL -- see RAW_LOG_STEAM_KEY_QUERY_RE above for why that value is
 * ALSO covered by shape, in case it's ever rotated out of settings.
 */
async function collectBundleKnownSecrets() {
  const values = new Set(await collectKnownSecretValues().catch(() => []));
  try {
    const apiKey = await getSteamApiKey();
    if (apiKey) values.add(String(apiKey));
  } catch {
    /* best-effort, matches collectKnownSecretValues' own precedent */
  }
  values.delete("");
  return [...values];
}

/**
 * Applied to every RAW log this bundle includes. Two independent layers,
 * cheapest/safest first:
 *
 *   1. Exact known-secret-value replacement (redactKnownSecrets). Zero
 *      false positives by construction -- it only ever matches a string
 *      this panel currently holds as a real credential -- but structurally
 *      blind to a secret that was never "known" to the panel (a player's
 *      own whitelist password, chosen through the RCON console and never
 *      persisted anywhere) or one that's since been rotated out.
 *   2. A short list of shape-based patterns for exactly the gaps (1) can't
 *      cover, each verified against real code in THIS repo rather than a
 *      generic guess: the `adduser "user" "pass"` RCON command shape
 *      (already precedented -- see rconCommandRedaction.js's own header
 *      for why a whitelist password can never be a "known" value), a
 *      Discord bot token's three-segment shape (covers a rotated token),
 *      and the Steam Web API key query-param shape serverFinder.js builds.
 *
 * MUST NOT touch ordinary diagnostic text -- proven by the regression test
 * built from the exact "Text file busy" .NET stack trace that motivated
 * tonight's Docker/systemd log capture in the first place. A scrubber that
 * mangled that line would have destroyed the one piece of evidence that
 * made the feature useful.
 */
function redactRawLogText(text, knownSecrets) {
  if (typeof text !== "string" || !text) return text;
  let out = redactKnownSecrets(text, knownSecrets);
  out = redactRconCommandSecrets(out);
  out = out.replace(RAW_LOG_DISCORD_TOKEN_RE, "[REDACTED-DISCORD-TOKEN]");
  out = out.replace(RAW_LOG_STEAM_KEY_QUERY_RE, "$1[REDACTED]");
  return out;
}

/**
 * Wraps a raw log file's read stream so each COMPLETE line is redacted
 * before it reaches the zip, without ever holding the whole file in
 * memory -- PZ's own server-console.txt is not rotated and can grow large
 * over a long uptime, unlike the panel's own winston-rotated combined.log/
 * error.log (10-25MB, capped). Buffers only the current (possibly partial)
 * line across chunk boundaries; every secret shape redactRawLogText
 * matches is expected to appear on a single line.
 */
function createRedactingLogStream(knownSecrets) {
  let carry = "";
  return new Transform({
    transform(chunk, _enc, callback) {
      carry += chunk.toString("utf-8");
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        this.push(redactRawLogText(line, knownSecrets) + "\n");
      }
      callback();
    },
    flush(callback) {
      if (carry) this.push(redactRawLogText(carry, knownSecrets));
      callback();
    },
  });
}

async function readPanelVersion() {
  if (typeof PANEL_VERSION !== "undefined" && PANEL_VERSION) {
    return String(PANEL_VERSION);
  }
  const candidates = [
    path.join(__dirname, "..", "..", "package.json"),
    path.join(process.cwd(), "package.json"),
    process.execPath
      ? path.join(path.dirname(process.execPath), "package.json")
      : null,
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const txt = await fs.promises.readFile(p, "utf8");
      const pkg = JSON.parse(txt);
      if (pkg?.version) return pkg.version;
    } catch {
      /* try next */
    }
  }
  return "unknown";
}

async function safeStatfs(target) {
  if (!target || typeof fs.promises.statfs !== "function") return null;
  try {
    const s = await fs.promises.statfs(target);
    const totalBytes = Number(s.blocks) * Number(s.bsize);
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    return {
      totalBytes,
      freeBytes,
      totalGB: +(totalBytes / 1024 ** 3).toFixed(2),
      freeGB: +(freeBytes / 1024 ** 3).toFixed(2),
      percentFree:
        totalBytes > 0 ? +((freeBytes / totalBytes) * 100).toFixed(1) : null,
    };
  } catch (e) {
    return { error: e.message };
  }
}

// The bundle-download request is the only place the panel's UI language
// reaches the server -- otherwise it lives only in the reporting browser's
// localStorage (see buildBundleReadme). Treated as untrusted input: bounded
// length and checked against a generic BCP-47-shaped pattern, not a
// hardcoded list of languages this build currently ships (client/src/i18n's
// LANGUAGE_CODES), which would go stale as languages are added without a
// server change. MUST degrade to "not reported" rather than guessing "en"
// for an older client, a direct curl request, or a garbage/oversized value
// -- a support artefact that guesses and is wrong is worse than one that
// admits it doesn't know.
const UI_LANGUAGE_HEADER = "x-ui-language";
const UI_LANGUAGE_MAX_LENGTH = 35; // BCP 47 language tags top out around here
const UI_LANGUAGE_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8}){0,4}$/;

function resolveReportedUiLanguage(req) {
  const raw = req?.headers?.[UI_LANGUAGE_HEADER];
  if (typeof raw !== "string") return "not reported";
  const value = raw.trim();
  if (!value || value.length > UI_LANGUAGE_MAX_LENGTH) return "not reported";
  if (!UI_LANGUAGE_RE.test(value)) return "not reported";
  return value;
}

async function buildSystemInfo(activeServer, serverManager, uiLanguage = "not reported") {
  const version = await readPanelVersion();
  const isPkg = typeof process.pkg !== "undefined";
  const paths = getDataPaths();
  const cpus = os.cpus();

  // Whether the dedicated server process was running at the moment this
  // bundle was generated -- nothing else in the bundle answered this before.
  // Distinguishes a confirmed-stopped server from "detection itself failed"
  // (scanFailed) the same way getServerProcessDetails()'s other callers do,
  // rather than collapsing an unknown state into a false "not running".
  // There is no PERSISTED "a config edit is pending a restart" flag anywhere
  // in the panel to report instead (config-guard's warning is computed fresh
  // per-request and never stored) -- this live snapshot is the closest
  // available substitute for "what state was the server actually in".
  let serverProcess = { checked: false };
  if (typeof serverManager?.getServerProcessDetails === "function") {
    try {
      const details = await serverManager.getServerProcessDetails();
      serverProcess = {
        checked: true,
        running: Boolean(details.running),
        scanFailed: Boolean(details.scanFailed),
      };
    } catch (e) {
      serverProcess = { checked: true, error: e.message };
    }
  }

  return {
    panel: {
      version,
      isPkg,
      execPath: process.execPath,
      cwd: process.cwd(),
      argv: process.argv
        .slice(1)
        .map((a) => (a.length > 200 ? a.slice(0, 200) + "…" : a)),
      uptimeSeconds: Math.round(process.uptime()),
      pid: process.pid,
      memoryUsage: process.memoryUsage(),
    },
    runtime: {
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      openssl: process.versions.openssl,
    },
    os: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      type: os.type(),
      hostname: os.hostname().replace(/[^a-zA-Z0-9._-]/g, "?"),
      uptimeSeconds: Math.round(os.uptime()),
      totalMemBytes: os.totalmem(),
      freeMemBytes: os.freemem(),
      totalMemGB: +(os.totalmem() / 1024 ** 3).toFixed(2),
      freeMemGB: +(os.freemem() / 1024 ** 3).toFixed(2),
      loadavg: os.loadavg(),
      cpu: cpus[0]?.model || "unknown",
      cpuCount: cpus.length,
      tmpdir: os.tmpdir(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    disk: {
      panelDataDir: await safeStatfs(paths.dataDir),
      zomboidDataDir: await safeStatfs(activeServer?.zomboidDataPath || null),
      installDir: await safeStatfs(activeServer?.installPath || null),
    },
    serverProcess,
    uiLanguage,
  };
}

async function buildEnvironmentReport() {
  const lines = [
    "# Environment variables (allow-listed)",
    "# Only values for explicitly safe vars are shown.",
    "# Other entries report PRESENCE ONLY (no value).",
    "",
  ];
  for (const key of ENV_VALUE_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      lines.push(`${key}=${process.env[key]}`);
    }
  }
  lines.push("");
  lines.push("# Presence-only (value redacted)");
  for (const key of ENV_PRESENCE_ONLY) {
    lines.push(
      `${key}=${process.env[key] !== undefined ? "<set>" : "<unset>"}`,
    );
  }
  lines.push("");
  lines.push("# All other env var NAMES present (no values)");
  const known = new Set([...ENV_VALUE_ALLOWLIST, ...ENV_PRESENCE_ONLY]);
  const others = Object.keys(process.env)
    .filter((k) => !known.has(k))
    .sort();
  for (const k of others) {
    lines.push(`${k}=<redacted>`);
  }
  return lines.join("\n") + "\n";
}

async function buildPanelConfig(activeServer) {
  let settings = {};
  let servers = [];
  let scheduledTasks = [];
  let trackedMods = [];
  try {
    settings = await getAllSettings();
  } catch (e) {
    settings = { _error: e.message };
  }
  try {
    const db = await getDb();
    servers = db?.data?.servers || [];
  } catch (e) {
    servers = [{ _error: e.message }];
  }
  try {
    scheduledTasks = await getScheduledTasks();
  } catch (e) {
    scheduledTasks = [{ _error: e.message }];
  }
  try {
    trackedMods = await getTrackedMods();
  } catch (e) {
    trackedMods = [{ _error: e.message }];
  }

  return {
    activeServerId: activeServer?.id || null,
    activeServerName: activeServer?.name || activeServer?.serverName || null,
    settings: sanitizeForBundle(settings),
    servers: sanitizeForBundle(servers),
    scheduledTasks: sanitizeForBundle(scheduledTasks),
    trackedMods: sanitizeForBundle(trackedMods),
  };
}

const SUPPORT_INI_KEYS = [
  "DefaultPort",
  "RCONPort",
  "Public",
  "Open",
  "PauseEmpty",
  "MaxPlayers",
  "MaxAccountsPerUser",
  "SteamVAC",
  "DoLuaChecksum",
  "UsernameDisguises",
  "HideDisguisedUserName",
  "AntiCheatProtectionType",
];

async function buildServerConfigSummary(activeServer) {
  const configDir = activeServer?.serverConfigPath;
  const serverName = activeServer?.serverName || activeServer?.name;
  if (!configDir || !serverName) {
    return { available: false, reason: "Active server configuration is not set" };
  }

  const iniPath = path.join(configDir, `${serverName}.ini`);
  const sandboxPath = path.join(configDir, `${serverName}_SandboxVars.lua`);
  const result = {
    available: false,
    serverName,
    ini: { path: iniPath, exists: false },
    sandbox: { path: sandboxPath, exists: false },
  };

  try {
    const iniContent = await fs.promises.readFile(iniPath, "utf8");
    const values = {};
    for (const raw of iniContent.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
    const splitList = (value) =>
      (value || "")
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean);
    const safeSettings = Object.fromEntries(
      SUPPORT_INI_KEYS.filter((key) => values[key] !== undefined).map((key) => [
        key,
        values[key],
      ]),
    );
    const mods = splitList(values.Mods);
    const workshopItems = splitList(values.WorkshopItems);
    result.available = true;
    result.ini = {
      ...result.ini,
      exists: true,
      sha256: crypto.createHash("sha256").update(iniContent).digest("hex"),
      settings: safeSettings,
      mods,
      workshopItems,
      map: splitList(values.Map),
      // Mods= and WorkshopItems= are meant to be parallel lists (same index
      // = same mod). A length mismatch is a cheap, real signal something
      // didn't resolve cleanly the last time mods were applied -- the actual
      // per-ID resolution result (unresolvedModIds) is computed only inside
      // POST /mods/apply-config's response and is never persisted anywhere,
      // so it can't be reconstructed after the fact; this is the closest
      // available substitute without re-running that resolution logic here.
      modsWorkshopCountMismatch: mods.length !== workshopItems.length,
    };
  } catch (error) {
    result.ini.error = error.message;
  }

  try {
    const sandboxContent = await fs.promises.readFile(sandboxPath, "utf8");
    const braces = checkSandboxBraceBalance(sandboxContent);
    result.sandbox = {
      ...result.sandbox,
      exists: true,
      bytes: Buffer.byteLength(sandboxContent),
      sha256: crypto.createHash("sha256").update(sandboxContent).digest("hex"),
      braceBalance: braces,
    };
  } catch (error) {
    result.sandbox.error = error.message;
  }

  return result;
}

async function buildPzBuildInfo(activeServer) {
  const installPath = activeServer?.installPath;
  if (!installPath) return { available: false, reason: "Install path is not set" };

  const manifestPath = path.join(
    installPath,
    "steamapps",
    "appmanifest_380870.acf",
  );
  try {
    const manifest = await fs.promises.readFile(manifestPath, "utf8");
    const valueFor = (key) =>
      manifest.match(new RegExp(`"${key}"\\s+"([^"]+)"`))?.[1] || null;
    const lastUpdated = valueFor("LastUpdated");
    return {
      available: true,
      appId: valueFor("appid") || "380870",
      buildId: valueFor("buildid"),
      branch: valueFor("BetaKey") || "public",
      lastUpdated: lastUpdated
        ? new Date(Number(lastUpdated) * 1000).toISOString()
        : null,
    };
  } catch (error) {
    return { available: false, manifestPath, error: error.message };
  }
}

async function listDir(target, { recurseInto = [], maxEntries = 200 } = {}) {
  if (!target) return null;
  try {
    const stat = await fs.promises.stat(target);
    if (!stat.isDirectory()) return { path: target, error: "not a directory" };
  } catch (e) {
    return { path: target, error: e.message };
  }
  try {
    const items = await fs.promises.readdir(target, { withFileTypes: true });
    const out = [];
    for (const it of items.slice(0, maxEntries)) {
      try {
        const full = path.join(target, it.name);
        const s = await fs.promises.stat(full);
        const entry = {
          name: it.name,
          type: it.isDirectory() ? "dir" : it.isFile() ? "file" : "other",
          size: s.size,
          modified: s.mtime.toISOString(),
        };
        if (it.isDirectory() && recurseInto.includes(it.name)) {
          entry.children = await listDir(full, { maxEntries: 100 });
        }
        out.push(entry);
      } catch {
        out.push({ name: it.name, error: "stat failed" });
      }
    }
    return {
      path: target,
      truncatedAt: items.length > maxEntries ? maxEntries : null,
      totalEntries: items.length,
      entries: out,
    };
  } catch (e) {
    return { path: target, error: e.message };
  }
}

async function buildZomboidPaths(activeServer) {
  const configured = activeServer?.zomboidDataPath || null;
  const inspection = configured ? inspectZomboidPath(configured) : null;
  let candidates = [];
  try {
    candidates = getCandidateZomboidPaths();
  } catch (e) {
    candidates = [{ _error: e.message }];
  }

  const root = configured;

  // 2026-09-04, god's finding in Charon's real bundle: installPath is not
  // always a directory. "Custom launcher" mode (operator ruling 2026-08-27,
  // custom-launcher-as-a-real-supported-mode-not-an-accident) legitimately
  // stores a .bat/.sh/.exe FILE path in installPath -- resolveLaunchMode()
  // is the shared, already-correct detector for this (serverManager.js's
  // own launch-mode selection uses it). Joining "logs" straight onto a
  // custom-launcher installPath produces a path like
  // "...\StartServer_CharonWorld.bat\logs" (ENOENT, and listDir(installPath)
  // itself would fail the same way trying to readdir a file) -- the
  // install DIRECTORY for a custom launcher is the folder the script lives
  // in, exactly the same relationship scanForPzPaths() already relies on
  // (a discovered installPaths entry is the folder containing the launcher
  // script it found alongside it).
  const { mode: launchMode } = resolveLaunchMode({
    installPath: activeServer?.installPath,
  });
  const installDir =
    launchMode === "custom" && activeServer?.installPath
      ? path.dirname(activeServer.installPath)
      : activeServer?.installPath || null;

  return {
    configuredPath: configured,
    installPath: activeServer?.installPath || null,
    inspection,
    candidates,
    listings: {
      root: await listDir(root),
      saves: root
        ? await listDir(path.join(root, "Saves"), {
            recurseInto: ["Multiplayer"],
          })
        : null,
      server: root ? await listDir(path.join(root, "Server")) : null,
      logs: root ? await listDir(path.join(root, "Logs")) : null,
      mods: root ? await listDir(path.join(root, "mods")) : null,
      workshop: root ? await listDir(path.join(root, "Workshop")) : null,
      panelBridge: root
        ? await listDir(path.join(root, "panelbridge"), {
            recurseInto: ["default"],
          })
        : null,
      install: installDir ? await listDir(installDir) : null,
      installLogs: installDir
        ? await listDir(path.join(installDir, "logs"))
        : null,
    },
  };
}

function sanitizeCommandHistoryEntry(entry) {
  if (!entry) return entry;
  const cloned = { ...entry };
  if (typeof cloned.command === "string") {
    // Mask anything that looks like an auth/password literal in raw RCON strings
    cloned.command = cloned.command.replace(
      /(password\s*[:=]\s*)\S+/gi,
      "$1••••",
    );
  }
  return cloned;
}

async function buildRecentEvents() {
  let serverEvents = [];
  let commandHistory = [];
  let playerLogs = [];
  let scheduleHistory = [];
  let bridgeLogs = [];

  try {
    const db = await getDb();
    serverEvents = (db?.data?.server_events || []).slice(0, 50);
    scheduleHistory = (db?.data?.schedule_history || []).slice(0, 50);
  } catch (e) {
    serverEvents = [{ _error: e.message }];
  }
  try {
    commandHistory = (await getCommandHistory(100)).map(
      sanitizeCommandHistoryEntry,
    );
  } catch (e) {
    commandHistory = [{ _error: e.message }];
  }
  try {
    playerLogs = await getPlayerLogs(null, 100);
  } catch (e) {
    playerLogs = [{ _error: e.message }];
  }
  try {
    bridgeLogs = await getBridgeLogs(100);
  } catch (e) {
    bridgeLogs = [{ _error: e.message }];
  }

  return {
    serverEvents: sanitizeForBundle(serverEvents),
    commandHistory: sanitizeForBundle(commandHistory),
    playerLogs: sanitizeForBundle(playerLogs),
    scheduleHistory: sanitizeForBundle(scheduleHistory),
    bridgeLogs: sanitizeForBundle(bridgeLogs),
  };
}

async function buildPerformanceHistory() {
  try {
    return await getPerformanceHistory(180); // up to 3h at 1-min samples
  } catch (e) {
    return { _error: e.message };
  }
}

async function buildDbStats() {
  try {
    const stats = await getDatabaseStats();
    return sanitizeForBundle(stats);
  } catch (e) {
    return { _error: e.message };
  }
}

function buildBridgeStatus() {
  try {
    const status = panelBridgeService?.getStatus?.() || null;
    if (!status) return { available: false };

    const enriched = { ...status };
    // Add mtimes of the IPC files for forensics
    if (status.bridgePath) {
      const probe = ["commands.json", "results.json", "status.json"];
      enriched.ipcFiles = {};
      for (const name of probe) {
        const fp = path.join(status.bridgePath, name);
        try {
          if (fs.existsSync(fp)) {
            const s = fs.statSync(fp);
            enriched.ipcFiles[name] = {
              exists: true,
              size: s.size,
              modified: s.mtime.toISOString(),
              ageSeconds: Math.round((Date.now() - s.mtimeMs) / 1000),
            };
          } else {
            enriched.ipcFiles[name] = { exists: false };
          }
        } catch (e) {
          enriched.ipcFiles[name] = { error: e.message };
        }
      }
    }
    return sanitizeForBundle(enriched);
  } catch (e) {
    return { _error: e.message };
  }
}

async function buildSftpDiagnostics() {
  try {
    const settings = await getAllSettings();
    const status = panelBridgeService?.getStatus?.() || {};
    return sanitizeForBundle({
      configured: Boolean(settings?.panelBridgeSftpEnabled),
      host: settings?.panelBridgeSftpHost || null,
      port: settings?.panelBridgeSftpPort || null,
      username: settings?.panelBridgeSftpUsername || null,
      remotePath: settings?.panelBridgeSftpBridgePath || null,
      activeTransport: status.transport || null,
      lastSftpTransport: status.lastSftpTransport || null,
      fellBackToLocal: status.transport?.type !== "sftp" && Boolean(status.lastSftpTransport),
    });
  } catch (e) {
    return { _error: e.message };
  }
}

async function buildProcessSnapshot() {
  return {
    title: process.title,
    versions: process.versions,
    features: process.features,
    resourceUsage:
      typeof process.resourceUsage === "function"
        ? process.resourceUsage()
        : null,
    activeRequests:
      typeof process._getActiveRequests === "function"
        ? process._getActiveRequests().length
        : null,
    activeHandles:
      typeof process._getActiveHandles === "function"
        ? process._getActiveHandles().length
        : null,
  };
}

async function buildNetworkInterfaces() {
  try {
    const ifaces = os.networkInterfaces();
    // Strip MAC + scopeid so we don't ship hardware identifiers
    const sanitized = {};
    for (const [name, addrs] of Object.entries(ifaces || {})) {
      sanitized[name] = (addrs || []).map((a) => ({
        address: a.address,
        family: a.family,
        internal: a.internal,
        cidr: a.cidr,
      }));
    }
    return sanitized;
  } catch (e) {
    return { _error: e.message };
  }
}

// Config values only, sanitized -- never a live discovery/test-connection
// call. Every other collector in this file is a local read (DB, settings,
// filesystem); making this one reach out to a third-party IdP would be the
// only network dependency in the whole bundle, adding unpredictable latency
// (or a timeout) to what is otherwise a fast, fully local diagnostic
// collection. There is also no PERSISTED "last test authentication
// succeeded" fact anywhere to report even if it did -- testOidcDiscovery()
// is stateless and returns its result only to the caller of Settings' own
// "Test connection" button; it is never written to the DB. clientSecret
// itself is never read out of the UI secret file here at all -- only
// whether OIDC is configured (which already requires it to be present) is
// reported, matching how every other secret in this bundle is presence-only.
async function buildOidcStatus() {
  try {
    const settings = await getOidcSettings();
    return {
      configured: isOidcConfigured(settings),
      issuerUrl: settings.issuerUrl || null,
      clientId: settings.clientId || null,
      clientSecretSet: Boolean(settings.clientSecret),
      redirectUri: settings.redirectUri || null,
      scope: settings.scope || null,
      providerName: settings.providerName || null,
      allowInsecureHttp: settings.allowInsecureHttp,
      // Which of the above are pinned by an environment variable (Docker/
      // systemd/compose) rather than editable through Settings -- an
      // operator asking "why won't my Settings edit stick" is a config-guard-
      // shaped support question this answers directly.
      envOverrides: getOidcEnvOverrides(),
    };
  } catch (e) {
    return { _error: e.message };
  }
}

// Which roles exist, what each grants, how many users hold each, and the
// username -> role mapping -- "why can this person not see X" was
// previously unanswerable from a bundle at all. Local usernames are not
// secret-shaped (no password/token/hash), so they pass sanitizeForBundle
// unchanged like every other non-credential field in this bundle; still
// worth a support reader knowing this bundle names local accounts, so the
// README says so explicitly.
async function buildRolesAndPermissions() {
  try {
    const [roles, users] = await Promise.all([
      listRolesWithMemberCounts(),
      authService.getUsers(),
    ]);
    return sanitizeForBundle({
      roles: roles.map((r) => ({
        id: r.id,
        name: r.name,
        isSeeded: Boolean(r.isSeeded),
        capabilities: r.capabilities || [],
        memberCount: r.memberCount,
      })),
      users: users.map((u) => ({ username: u.username, role: u.role, roleId: u.roleId })),
    });
  } catch (e) {
    return { _error: e.message };
  }
}

// curl is a RUNTIME dependency the World Map build-resolution path shipped
// on this now (see mapProxy.js's fetchViaCurl) -- a host missing it is
// probably this release's single most likely new support ticket, and until
// now a bundle had no way to tell us. `curl --version` is a cheap, local,
// no-network subprocess call (distinct from the discovery/tile fetches
// fetchViaCurl itself makes), so this stays consistent with every other
// collector being local-only.
function checkCurlAvailable() {
  return new Promise((resolve) => {
    execFile("curl", ["--version"], { timeout: 3000 }, (err, stdout) => {
      if (err) {
        resolve({
          available: false,
          reason: err.code === "ENOENT" ? "curl is not on PATH" : err.message,
        });
        return;
      }
      resolve({ available: true, version: stdout.split("\n")[0]?.trim() || null });
    });
  });
}

async function buildWorldMapDiagnostics() {
  try {
    const [curl, resolution] = await Promise.all([
      checkCurlAvailable(),
      Promise.resolve(getB42ResolutionStatus()),
    ]);
    return { curl, b42Resolution: resolution };
  } catch (e) {
    return { _error: e.message };
  }
}

// db.json's own write path (server/database/init.js) already tracks retry
// count / circuit-breaker state for exactly this "silent write failure"
// question -- getCircuitBreakerStatus() surfaces it read-only, no new
// tracking added here. writeFileAtomic (server/utils/fileWriteQueue.js,
// used for the INI/Lua config files, not db.json) has NO equivalent
// counters to report -- its retry path has nothing that persists across
// calls to read. Extending it to track that would mean editing a second
// file outside this task's boundary; noted in the report rather than done
// unasked.
function buildDbWriteHealth() {
  try {
    return getCircuitBreakerStatus();
  } catch (e) {
    return { _error: e.message };
  }
}

// Schedule/retention are already visible inside panel-config.json's
// settings (backupSchedule, backupMaxCount) -- this collector's actual job
// is the piece that ISN'T anywhere else yet: the recent run history.
// Failed runs are not structurally recorded (only a successful backup ever
// gets a record — see backupRecords.js's addBackupRecord), so a failure
// still only shows up in the raw admin-panel logs already in this bundle;
// documented as a known gap in the README rather than silently implied to
// be covered here.
async function buildBackupsSummary(req) {
  try {
    const backupService = req?.app?.get?.("backupService");
    const [settings, recent] = await Promise.all([
      backupService?.getSettings?.() ?? null,
      listBackupRecords({ limit: 20 }),
    ]);
    return sanitizeForBundle({ settings, recentRuns: recent });
  } catch (e) {
    return { _error: e.message };
  }
}

// support-bundle-2026-08-30: a real production report (Discord #bug_report,
// see hive/agents/god/research/discord-restart-etxtbsy-2026-08-30.md) was
// only diagnosable because of one decisive line -- a "Text file busy"
// .NET stack trace from DepotDownloader -- that a user happened to paste
// by hand from `docker logs`. None of the collectors above would have
// caught it -- not because every one of them scans the filesystem
// (bug hunt 2026-08-31: buildProcessSnapshot() is pure process-API,
// buildBridgeStatus()'s core comes from an in-memory getStatus(), and
// buildNetworkInterfaces() is an OS call, none of those touch disk --
// the false claim didn't change the conclusion below, only the reasoning
// for it) -- but because a container's stdout/stderr is not a file
// anywhere on disk regardless of source: it is owned by Docker's log
// driver (or, for a systemd/OpenRC managed lifecycle, by journald or
// whatever the service supervisor does with it), and none of this
// bundle's collectors -- file-based, in-memory, or OS-API -- reach it.
// A bundle generated at the moment of that report would not have
// contained the line that solved the case.
//
// Bounded the same way as every other raw-log collector in this bundle:
// last N lines, not the full history, so one chatty deployment can't
// balloon bundle size (DockerClient.getContainerLogs also enforces a hard
// byte cap independently of the line count, since `tail=` bounds lines,
// not bytes).
const SUPPORT_BUNDLE_LOG_TAIL_LINES = 500;

async function buildDockerContainerLogsText(activeServer) {
  const ref = activeServer?.dockerContainerName || activeServer?.dockerContainerId || null;
  if (!ref) {
    return "Docker container logs\n=====================\n\nNo Docker container is mapped to the active server -- skipped.\n";
  }
  const dockerClient = getDockerClient();
  if (!dockerClient?.enabled || !dockerClient.available) {
    return `Docker container logs\n=====================\n\nContainer "${ref}" is mapped to the active server, but Docker control is disabled or the Docker socket is unavailable on this panel host -- skipped.\n`;
  }
  const logs = await dockerClient.getContainerLogs(ref, {
    tail: SUPPORT_BUNDLE_LOG_TAIL_LINES,
  });
  if (logs == null) {
    return `Docker container logs\n=====================\n\nContainer "${ref}" is mapped to the active server, but its logs could not be fetched (not managed by this panel, or the Docker API call failed) -- skipped.\n`;
  }
  if (!logs.trim()) {
    return `Docker container logs\n=====================\nContainer: ${ref}\n\nFetched successfully -- no stdout/stderr history yet.\n`;
  }
  return `Docker container logs\n=====================\nContainer: ${ref}\nLast ${SUPPORT_BUNDLE_LOG_TAIL_LINES} lines, stdout+stderr, timestamps included.\n\n${logs}`;
}

// Mirrors linuxServiceLifecycle.js's own defaultExecFile() (systemctl/rc-
// service --user calls need XDG_RUNTIME_DIR set even when the panel process
// itself was started without a login session) rather than importing it --
// that function is private to a file this task does not own, and the logic
// is small and stable enough that duplicating it here is cheaper than
// widening that file's exported surface for one caller.
function execLinuxUserCommand(command, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const env = { ...process.env };
    if (!env.XDG_RUNTIME_DIR && Number.isInteger(uid)) {
      env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
    }
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env },
      (error, stdout, stderr) => {
        resolve({
          code: Number.isInteger(error?.code) ? error.code : error ? 1 : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || error?.message || ""),
        });
      },
    );
  });
}

async function buildManagedServiceLogsText(activeServer) {
  const provider = activeServer?.lifecycleProvider;
  if (!isManagedLifecycleProvider(provider)) {
    return "Managed service logs\n=====================\n\nThe active server is not running under a systemd/OpenRC managed lifecycle -- skipped.\n";
  }
  if (provider !== "systemd") {
    // OpenRC's supervise-daemon can be configured to log to a file, syslog,
    // or nowhere, and the destination is not tracked anywhere in this
    // panel today -- an honest, reported gap rather than a guessed command
    // that might silently return nothing (or someone else's logs) on a
    // real OpenRC host. Verify supervise-daemon's actual log destination
    // on a real system before adding a path here.
    return "Managed service logs\n=====================\n\nThe active server runs under OpenRC. This panel does not yet capture OpenRC service output here (supervise-daemon's log destination is not currently tracked) -- known gap, not fetched.\n";
  }
  if (process.platform !== "linux") {
    return "Managed service logs\n=====================\n\nsystemd lifecycle is Linux-only; this panel host is not Linux -- skipped.\n";
  }

  let serviceName;
  try {
    serviceName = getLifecycleServiceName(activeServer);
  } catch (e) {
    return `Managed service logs\n=====================\n\nCould not determine the systemd unit name: ${e.message}\n`;
  }
  const unit = `${serviceName}.service`;
  const result = await execLinuxUserCommand("journalctl", [
    "--user",
    "-u",
    unit,
    "--no-pager",
    "-n",
    String(SUPPORT_BUNDLE_LOG_TAIL_LINES),
  ]);
  if (result.code !== 0) {
    return `Managed service logs\n=====================\n\nCould not read the journal for systemd --user unit "${unit}": ${
      result.stderr.trim() || `journalctl exited ${result.code}`
    }\n`;
  }
  if (!result.stdout.trim()) {
    return `Managed service logs\n=====================\nUnit: ${unit}\n\nFetched successfully -- the journal has no entries for this unit yet.\n`;
  }
  return `Managed service logs\n=====================\nUnit: ${unit} (systemd --user)\nLast ${SUPPORT_BUNDLE_LOG_TAIL_LINES} lines.\n\n${result.stdout}`;
}

async function buildDiscordBotStatus(req) {
  try {
    const discordBot = req?.app?.get?.("discordBot");
    if (!discordBot?.getStatus) return { available: false };
    // getStatus() already excludes the token itself (only a `configured`
    // boolean) -- sanitizeForBundle is defense in depth, not the only guard.
    return sanitizeForBundle(discordBot.getStatus());
  } catch (e) {
    return { _error: e.message };
  }
}

function buildBundleReadme() {
  return [
    "# Project Zomboid Control Panel — Support Bundle",
    "",
    "## Where to look first",
    "",
    "1. `support-bundle-info.txt` — high-level summary, paths used.",
    "2. `system-info.json` — panel version, OS, RAM, disk free, whether the dedicated server process was running when this bundle was generated, and which UI language the browser reported when requesting this bundle (`uiLanguage`; \"not reported\" if the request didn't include it — never guessed).",
    "3. `panel-config.json` — sanitized settings + servers list (passwords/tokens masked). Also where backup schedule/retention and scheduled-task configuration live (`settings.backupSchedule`, `settings.backupMaxCount`, `scheduledTasks`).",
    "4. `zomboid-paths.json` — what the panel thinks the data/install paths are, all probed candidates, and dir listings of `Saves/`, `Saves/Multiplayer/`, `Server/`, `Logs/`, etc.",
    "5. `bridge-status.json` — PanelBridge connection, IPC file ages, and active transport.",
    "6. `sftp-diagnostics.json` — sanitized remote SFTP configuration and the last SFTP attempt, including failures after local fallback.",
    "7. `recent-events.json` — last server starts/stops, RCON commands, player join/leave, scheduled task runs (`scheduleHistory` is the last-result history for scheduler entries).",
    "8. `db-stats.json` — record counts per collection.",
    "9. `performance-history.json` — recent CPU/RAM samples.",
    "10. `environment.txt` — relevant env vars (secrets show as `<set>`/`<unset>` only).",
    "11. `network-interfaces.json` — local IPs (no MACs).",
    "12. `process.json` — process flags, versions, active handle counts.",
    "13. `server-config-summary.json` — sanitized effective server settings, mod/map lists, sandbox integrity, and whether the Mods/WorkshopItems lists are the same length (a mismatch is a cheap signal of an unresolved mod).",
    "14. `pz-build-info.json` — installed Project Zomboid branch and Steam build ID.",
    "15. `oidc-status.json` — whether SSO is configured, issuer/client/redirect/scope, which fields are pinned by an env var, and whether a client secret is set (never its value). No live IdP check — see the file's own notes.",
    "16. `roles-and-permissions.json` — every role, what it grants, how many/which local users hold it. Start here for \"why can't this person see X\".",
    "17. `world-map-diagnostics.json` — whether `curl` is present on this host (a missing one is the most likely new World Map support ticket this release) and the resolved B42 tile-build source/directory/reason.",
    "18. `db-write-health.json` — db.json's write circuit-breaker state and retry count. Does NOT cover config-file (INI/Lua) writes — see the file's own notes for why.",
    "19. `backups-summary.json` — the last 20 backup runs. Only successful runs are recorded; a failed scheduled backup shows up in `admin-panel/error.log` instead, not here.",
    "20. `discord-bot-status.json` — connected or not, which guild/channel/mod-role it's wired to, and the last start failure if any (token presence only, never the value).",
    "",
    "## Then the raw logs",
    "",
    "- `admin-panel/` — `combined.log`, `error.log` from the panel itself.",
    "  Grep for `ERROR`, `rejection`, `ECONN`, `EACCES`, `Failed to`.",
    "- `zomboid-server/` — `server-console.txt` and runtime logs from PZ.",
    "  Grep for `ERROR`, `Exception`, `Object tried to call nil`, `Stack trace`.",
    "- `zomboid-install/` — connection/workshop/system logs from the install side.",
    "- `crash-logs/` — Java/JVM crash dumps (`hs_err_pid*.log`) and matching error logs.",
    "- `docker-container-logs.txt` — last 500 lines of the mapped Docker container's own stdout/stderr (only if the active server is Docker-managed and Docker control is on). This is the ONLY place an early startup crash from a container's own entrypoint script, or a JVM that died before writing its own log file, ever shows up -- none of the filesystem-scanning logs above can see it. Says why it's missing when it is (not mapped, Docker control off, socket unavailable, fetch failed).",
    "- `managed-service-logs.txt` — last 500 lines from `journalctl --user` for a systemd-managed server (same reasoning as the Docker file, for a systemd `--user` unit instead of a container). OpenRC-managed servers are a known, reported gap here -- supervise-daemon's log destination is not currently tracked by this panel.",
    "",
    "**Every raw log above is now scanned for known credential shapes before it's zipped**, uniformly -- `admin-panel/`, `zomboid-server/`, `zomboid-install/`, `crash-logs/`, `docker-container-logs.txt`, and `managed-service-logs.txt` all go through the same scrub, not a subset of them. It catches: RCON/join passwords and the PanelBridge SFTP password (exact match against this panel's own current values), the Discord bot token (exact match, plus a shape check that also catches a token that's since been rotated), and the Steam Web API key (exact match, plus the one query-string shape this panel's own code ever puts it in).",
    "",
    "**REDACTION IS NOT A PROMISE OF SAFETY.** These are still real, mostly-unstructured logs written by the panel, the game server, or (for the two files above) a container/service supervisor this panel doesn't control the output of. The scrub above only catches secrets that are exact-known-current-values or match one of a short, verified list of shapes -- it cannot catch every way a credential, a player's real name, an IP address, or anything else sensitive might show up in free text. **Review this bundle yourself before forwarding it to anyone outside your team.** Only the JSON files (`panel-config.json`, `sftp-diagnostics.json`, `environment.txt`, etc.) go through the separate field-based redaction described above, which is a stricter, schema-aware guarantee that the raw-log scrub can't offer.",
    "",
    "## What is NOT in this bundle",
    "",
    "- Plaintext RCON / Discord / Steam / OIDC client secret credentials (masked or presence-only).",
    "- Full environment variable values (only allow-listed keys show values).",
    "- MAC addresses (network interfaces list IPs only).",
    "- The LowDB file itself (`db.json`) — only sanitized excerpts.",
    "- A guarantee that the raw logs contain nothing sensitive beyond the credential shapes described above — see the warning in that section.",
    "- Whether a config edit is still waiting on a restart to take effect. The panel computes that live per-request and never stores it — `system-info.json`'s `serverProcess` (was the server running right now) is the closest fact actually available.",
    "- A record of the OIDC \"Test connection\" button's last result, or a live check against the identity provider run while building this bundle — `oidc-status.json` reports configuration only.",
    "- Failed backup attempts as structured data (only successful runs are recorded) — check `admin-panel/error.log` for those.",
    "- Retry/failure counters for config-file (INI/Lua) writes specifically — only db.json's own write health is tracked today.",
    "- OpenRC service output (`managed-service-logs.txt` reports this explicitly rather than guessing at a log path).",
    "",
    "Generated by ZomboidControlPanel — see https://github.com/fpsacha/zomboid-control-panel",
    "",
  ].join("\n");
}

async function buildBundleDiagnostics(activeServer, req, knownSecrets) {
  // Run all collectors in parallel — each one is wrapped so a single failure
  // doesn't kill the whole bundle.
  const wrap = async (name, fn) => {
    try {
      return [name, await fn()];
    } catch (e) {
      return [name, { _error: e?.message || String(e) }];
    }
  };

  const serverManager = req?.app?.get?.("serverManager") || null;
  const uiLanguage = resolveReportedUiLanguage(req);

  const results = await Promise.all([
    wrap("system-info.json", () => buildSystemInfo(activeServer, serverManager, uiLanguage)),
    wrap("panel-config.json", () => buildPanelConfig(activeServer)),
    wrap("zomboid-paths.json", () => buildZomboidPaths(activeServer)),
    wrap("recent-events.json", () => buildRecentEvents()),
    wrap("performance-history.json", () => buildPerformanceHistory()),
    wrap("db-stats.json", () => buildDbStats()),
    wrap("bridge-status.json", async () => buildBridgeStatus()),
    wrap("sftp-diagnostics.json", () => buildSftpDiagnostics()),
    wrap("process.json", () => buildProcessSnapshot()),
    wrap("network-interfaces.json", () => buildNetworkInterfaces()),
    wrap("server-config-summary.json", () => buildServerConfigSummary(activeServer)),
    wrap("pz-build-info.json", () => buildPzBuildInfo(activeServer)),
    wrap("oidc-status.json", () => buildOidcStatus()),
    wrap("roles-and-permissions.json", () => buildRolesAndPermissions()),
    wrap("world-map-diagnostics.json", () => buildWorldMapDiagnostics()),
    wrap("db-write-health.json", async () => buildDbWriteHealth()),
    wrap("backups-summary.json", () => buildBackupsSummary(req)),
    wrap("discord-bot-status.json", () => buildDiscordBotStatus(req)),
    wrap("in-memory-log-buffer.json", async () => ({
      total: logBuffer.length,
      entries: logBuffer.slice(-MAX_BUFFER_SIZE),
    })),
  ]);

  const files = [
    { name: "README.md", content: buildBundleReadme() },
    {
      name: "environment.txt",
      content: await buildEnvironmentReport().catch(
        (e) => `# error: ${e.message}\n`,
      ),
    },
    {
      name: "docker-container-logs.txt",
      content: redactRawLogText(
        await buildDockerContainerLogsText(activeServer).catch(
          (e) => `# error: ${e.message}\n`,
        ),
        knownSecrets,
      ),
    },
    {
      name: "managed-service-logs.txt",
      content: redactRawLogText(
        await buildManagedServiceLogsText(activeServer).catch(
          (e) => `# error: ${e.message}\n`,
        ),
        knownSecrets,
      ),
    },
  ];
  for (const [name, value] of results) {
    files.push({ name, content: JSON.stringify(value, null, 2) });
  }
  return files;
}

async function getSupportBundleEntries() {
  const paths = getDataPaths();
  const activeServer = await getActiveServer().catch(() => null);

  const installRoot = await resolveSearchRoot(activeServer?.installPath || "");
  const zomboidDataRoot = await resolveSearchRoot(
    activeServer?.zomboidDataPath || "",
  );

  const entries = [];
  const seenFiles = new Set();

  await collectBundleFilesFromDir(
    paths.logsDir,
    (name) => SUPPORT_LOG_FILE_RE.test(name) && !name.startsWith("."),
    "admin-panel",
    entries,
    seenFiles,
  );

  await collectBundleFilesFromDir(
    zomboidDataRoot,
    (name) => SUPPORT_LOG_FILE_RE.test(name),
    "zomboid-server/root",
    entries,
    seenFiles,
  );

  await collectBundleFilesFromDir(
    zomboidDataRoot ? path.join(zomboidDataRoot, "Logs") : null,
    (name) => SUPPORT_LOG_FILE_RE.test(name),
    "zomboid-server/Logs",
    entries,
    seenFiles,
  );

  await collectBundleFilesFromDir(
    installRoot ? path.join(installRoot, "logs") : null,
    (name) => SUPPORT_LOG_FILE_RE.test(name),
    "zomboid-install/logs",
    entries,
    seenFiles,
  );

  await collectBundleFilesFromDir(
    installRoot,
    (name) => CRASH_FILE_RE.test(name),
    "crash-logs/install-root",
    entries,
    seenFiles,
  );

  await collectBundleFilesFromDir(
    installRoot ? path.join(installRoot, "logs") : null,
    (name) => CRASH_FILE_RE.test(name),
    "crash-logs/install-logs",
    entries,
    seenFiles,
  );

  await collectBundleFilesFromDir(
    zomboidDataRoot,
    (name) => CRASH_FILE_RE.test(name),
    "crash-logs/server-root",
    entries,
    seenFiles,
  );

  await collectBundleFilesFromDir(
    zomboidDataRoot ? path.join(zomboidDataRoot, "Logs") : null,
    (name) => CRASH_FILE_RE.test(name),
    "crash-logs/server-logs",
    entries,
    seenFiles,
  );

  return {
    entries,
    activeServer,
    sources: {
      panelLogsDir: paths.logsDir,
      installRoot,
      zomboidDataRoot,
    },
  };
}

// List available log files
router.get("/logs/files", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const paths = getDataPaths();
    const logsDir = paths.logsDir;

    try {
      await fs.promises.access(logsDir);
    } catch (e) {
      log.debug(`Logs directory not accessible (${logsDir}): ${e.message}`);
      return res.json({ files: [] });
    }

    const files = await getAvailableLogFiles(logsDir);

    res.json({ files });
  } catch (error) {
    log.error(`Failed to list log files: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Download combined log file
router.get("/logs/download", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const paths = getDataPaths();
    const logsPath = path.join(paths.logsDir, "combined.log");

    if (!fs.existsSync(logsPath)) {
      return res.status(404).json({ error: "Log file not found" });
    }

    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Disposition", "attachment; filename=combined.log");

    const readStream = fs.createReadStream(logsPath);
    readStream.on("error", (err) => {
      log.error(`Log file read error: ${err.message}`);
      if (!res.headersSent)
        res.status(500).json({ error: "Failed to read log file" });
      else res.destroy();
    });
    readStream.pipe(res);
  } catch (error) {
    log.error(`Failed to download logs: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Download all log files as a zip archive
router.get("/logs/download-zip", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    log.info("GET /logs/download-zip");

    const { entries, activeServer, sources } = await getSupportBundleEntries();
    if (entries.length === 0) {
      return res.status(404).json({ error: "No support logs found" });
    }

    const knownSecrets = await collectBundleKnownSecrets().catch(() => []);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveName = `pz-support-bundle-${timestamp}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${archiveName}"`,
    );

    const archive = archiver("zip", {
      zlib: { level: 6 },
    });

    archive.on("warning", (error) => {
      log.warn(`Log zip warning: ${error.message}`);
    });

    archive.on("error", (error) => {
      log.error(`Failed to create log archive: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to create log archive" });
      } else {
        res.destroy(error);
      }
    });

    archive.pipe(res);

    const manifest = [
      "Project Zomboid Control Panel Support Bundle",
      `Generated: ${new Date().toISOString()}`,
      `Active Server: ${activeServer?.name || activeServer?.serverName || "Not configured"}`,
      `Panel Logs Dir: ${sources.panelLogsDir || "n/a"}`,
      `Zomboid Data Dir: ${sources.zomboidDataRoot || "n/a"}`,
      `Install Dir: ${sources.installRoot || "n/a"}`,
      `Included Files: ${entries.length}`,
      "",
      "WARNING: This bundle contains real logs. Known credential shapes",
      "(RCON/join/SFTP passwords, the Discord bot token, the Steam Web API",
      "key) are redacted, but that is not a promise of safety -- review the",
      "contents yourself before sharing this bundle outside your team. See",
      "README.md for exactly what is and isn't scrubbed.",
      "",
      "Contents:",
      "- admin-panel: panel combined/error logs",
      "- zomboid-server: server-console and runtime logs",
      "- zomboid-install: install-side connection/workshop/system logs",
      "- crash-logs: matching crash/error dump files",
      "- docker-container-logs.txt / managed-service-logs.txt: container/service stdout+stderr for a Docker- or systemd-managed server (see README.md)",
    ].join("\n");

    archive.append(manifest, { name: "support-bundle-info.txt" });

    for (const entry of entries) {
      archive.append(
        fs.createReadStream(entry.filePath).pipe(createRedactingLogStream(knownSecrets)),
        { name: entry.archivePath },
      );
    }

    // ── Diagnostic JSON files (best-effort; collectors never throw) ──
    try {
      const diagnostics = await buildBundleDiagnostics(activeServer, req, knownSecrets);
      for (const f of diagnostics) {
        archive.append(f.content, { name: f.name });
      }
      log.info(
        `Support bundle: appended ${diagnostics.length} diagnostic files + ${entries.length} log files`,
      );
    } catch (diagErr) {
      log.warn(`Support bundle diagnostics failed: ${diagErr.message}`);
      archive.append(
        `Diagnostic collection failed: ${diagErr.message}\nStack:\n${diagErr.stack || "(no stack)"}\n`,
        { name: "diagnostics-error.txt" },
      );
    }

    archive.finalize();
  } catch (error) {
    log.error(`Failed to download log archive: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Download specific log file by name
router.get("/logs/download/:filename", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const paths = getDataPaths();
    const filename = req.params.filename;
    log.info(`GET /logs/download/${filename}`);

    // Security: prevent path traversal
    if (
      filename.includes("..") ||
      filename.includes("/") ||
      filename.includes("\\")
    ) {
      return res.status(400).json({ error: "Invalid filename" });
    }

    const logsPath = path.join(paths.logsDir, filename);

    if (!fs.existsSync(logsPath)) {
      return res.status(404).json({ error: "Log file not found" });
    }

    res.setHeader("Content-Type", "text/plain");
    const safeFilename = filename.replace(/["\r\n]/g, "");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeFilename}"`,
    );

    const readStream = fs.createReadStream(logsPath);
    readStream.on("error", (err) => {
      log.error(`Log file read error: ${err.message}`);
      if (!res.headersSent)
        res.status(500).json({ error: "Failed to read log file" });
      else res.destroy();
    });
    readStream.pipe(res);
  } catch (error) {
    log.error(`Failed to download log file: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Clear in-memory log buffer
router.post("/logs/clear", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    log.info("POST /logs/clear");
    logBuffer.length = 0;
    res.json({ success: true, message: "Log buffer cleared" });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Update data paths (database and logs location)
router.post("/paths", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const { dataDir, logsDir, moveFiles } = req.body;

    if (!dataDir && !logsDir) {
      return res
        .status(400)
        .json({ error: "At least one path must be provided" });
    }

    // Validate path format and length
    if (dataDir && (typeof dataDir !== "string" || dataDir.length > 500)) {
      return res.status(400).json({ error: "Invalid data directory path" });
    }
    if (logsDir && (typeof logsDir !== "string" || logsDir.length > 500)) {
      return res.status(400).json({ error: "Invalid logs directory path" });
    }

    // The panel's own data/logs directory must never overlap a configured
    // PZ server's install or save location -- moving the database into a
    // live PZ install (or vice versa) is exactly the kind of "wrong, not
    // just unwritable" target that passes a plain writability check.
    const configuredServers = await getServers();
    const extraBlockedPaths = configuredServers
      .flatMap((server) => [server.installPath, server.zomboidDataPath])
      .filter((p) => typeof p === "string" && p.trim());

    // 2026-08-27: moveFiles now defaults to false, not true. It used to be
    // `moveFiles !== false`, so a request naming a new dataDir with no
    // moveFiles key at all silently moved db.json and every *.secret file
    // -- the destructive option by omission, not by choice. Debug.tsx (the
    // only real caller) always sends this explicitly, so this costs the
    // UI nothing.
    const result = await setDataPaths(
      { dataDir, logsDir },
      moveFiles === true,
      { extraBlockedPaths },
    );

    if (result.success) {
      log.info(
        `Data paths updated - Data: ${result.paths.dataDir}, Logs: ${result.paths.logsDir}`,
      );
      res.json({
        success: true,
        message:
          "Paths updated successfully. Restart the application to apply changes.",
        paths: result.paths,
        filesMoved: result.filesMoved,
        requiresRestart: true,
      });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    log.error(`Failed to update paths: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Health check with details
router.get("/health", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const serverManager = req.app.get("serverManager");
    const modChecker = req.app.get("modChecker");
    const serverState = await getServerProcessState(serverManager);

    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      services: {
        rcon: {
          connected: rconService?.isConnected?.() || false,
          host: rconService?.config?.host || "not configured",
        },
        server: {
          running: serverState.running,
          scanFailed: serverState.scanFailed,
        },
        modChecker: {
          running: modChecker?.isRunning || false,
          interval: modChecker?.checkInterval || 0,
        },
      },
      // heapLimit is the real V8 ceiling (what --max-old-space-size controls);
      // heapTotal is just the currently-allocated segment size, which grows
      // on demand and is not a meaningful "how close to OOM" signal on its
      // own — see the runtime.heap diagnostic check for why.
      memory: {
        ...process.memoryUsage(),
        heapLimit: v8.getHeapStatistics().heap_size_limit,
      },
      uptime: process.uptime(),
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: sanitizeError(error.message),
      timestamp: new Date().toISOString(),
    });
  }
});

// ============================================
// Smart Diagnostics
// ============================================
//
// Runs ~25 health checks across services, paths, storage, and updates.
// Each check returns:
//   { id, label, status, message, hint?, category, severity }
// status: 'ok' | 'warn' | 'fail' | 'info' | 'skip'
// severity: 'critical' | 'warning' | 'info'
//
// The frontend renders this as a checklist with green/amber/red icons and
// per-check fix hints.

const DIAG_CATEGORIES = {
  services: { label: "Core Services", order: 1 },
  bridge: { label: "PanelBridge IPC", order: 2 },
  server: { label: "Active Server", order: 3 },
  storage: { label: "Storage & Database", order: 4 },
  runtime: { label: "Runtime & Memory", order: 5 },
  updates: { label: "Updates", order: 6 },
};

function diagOk(id, label, message, extras = {}) {
  return { id, label, status: "ok", message, severity: "info", ...extras };
}
function diagFail(id, label, message, extras = {}) {
  return {
    id,
    label,
    status: "fail",
    message,
    severity: "critical",
    ...extras,
  };
}
function diagWarn(id, label, message, extras = {}) {
  return { id, label, status: "warn", message, severity: "warning", ...extras };
}
function diagInfo(id, label, message, extras = {}) {
  return { id, label, status: "info", message, severity: "info", ...extras };
}
function diagSkip(id, label, message, extras = {}) {
  return { id, label, status: "skip", message, severity: "info", ...extras };
}

// GET /diagnostics's server.process check picks one of these 5 modes.
// remoteRconOnly already treats "no local process is visible" as an
// EXPECTED condition, not a fault, for a remote-SFTP server with no local
// paths at all -- skip-with-note, not a warning. docker-local/docker-managed
// is the same condition for the same underlying reason (GH#114 / 2026-09-01
// Discord split-container report: PZ runs as PID 1 of a *different*
// container, so this page's local scan can never see it either) -- the gap
// was that the exemption enumerated one topology and not the other, not a
// question of what the check should mean. The RCON/PanelBridge checks
// elsewhere on this same page still run and reflect real, live status; this
// row alone would otherwise show a false "Server process not running"
// warning to precisely the operator troubleshooting that exact confusion.
//
// Pure decision only, no diagOk/diagWarn/diagSkip call inside -- those stay
// literal, inline calls in the /diagnostics handler below (see this call
// site's own comment), where diagnosticsCheckRegistry.test.js's
// self-enforcing locale-completeness scanner needs to find them as such:
// it regex-scans the route handler's own source text for
// diag(Ok|Fail|Warn|Skip|Info)("server.process", ...) literals, so an id
// registered as translated (KNOWN_TRANSLATED_IDS) whose calls moved behind
// an opaque helper function reads to that scanner as REMOVED, not relocated.
export function resolveServerProcessCheckMode({
  remoteRconOnly,
  dockerManagedProvider,
  serverRunning,
}) {
  if (remoteRconOnly) return "remote";
  if (dockerManagedProvider) return "docker";
  if (serverRunning === null) return "unknown";
  return serverRunning ? "running" : "stopped";
}

// Per-ID triage for the mods.resolved check below -- classifies WHY a single
// Mods= entry doesn't resolve instead of leaving the operator with a bare
// list. Levenshtein distance, standard DP over two rolling rows (no need to
// keep the full matrix -- only ever compare against the previous row).
export function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

// A near-miss typo of a mod ID that's already resolving (installed via
// Workshop or local). Threshold scales gently with length so a single
// character slip in a long ID like RepairAnyClothesSearchModeAPI41 still
// counts as "near" without a short ID like "Ok" matching half the mod list.
// A pure case difference is treated as distance 1 regardless of length --
// PZ mod IDs are case-sensitive on Linux, but a pasted ID that only differs
// by case is still almost certainly meant to be the same mod.
export function findNearMissTypo(modId, candidateNames) {
  let best = null;
  let bestDistance = Infinity;
  const threshold = Math.max(2, Math.floor(modId.length * 0.1));
  for (const candidate of candidateNames) {
    if (candidate === modId) continue;
    const distance =
      candidate.toLowerCase() === modId.toLowerCase()
        ? 1
        : levenshteinDistance(modId, candidate);
    if (distance <= threshold && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

// Classifies each unresolved Mods= entry into exactly one cause. Order
// matters: a typo match is checked first because it's the most specific,
// actionable signal -- an entry that's ALSO true (loosely) because a
// download happens to be running elsewhere shouldn't hide a clean typo fix.
// "stillDownloading" and "workshopNotOnDisk" are deliberately coarse (whole-
// batch signals, not per-ID): there is no on-disk data that ties an
// unresolved mod ID to a specific not-yet-downloaded Workshop item before
// that item's mod.info actually exists on disk, so this doesn't pretend to
// know more than it does.
export function triageUnresolvedMods(
  unresolvedMods,
  installedModNames,
  { steamOperationActive, anyWorkshopMissingFromDisk },
) {
  return unresolvedMods.map((modId) => {
    const suggestion = findNearMissTypo(modId, installedModNames);
    if (suggestion) return { modId, cause: "typo", suggestion };
    if (steamOperationActive) return { modId, cause: "stillDownloading" };
    if (anyWorkshopMissingFromDisk)
      return { modId, cause: "workshopNotOnDisk" };
    return { modId, cause: "absent" };
  });
}

async function pathExistsAsync(p) {
  if (!p) return false;
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function pathWritableAsync(p) {
  if (!p) return false;
  try {
    await fs.promises.access(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Tail-read `server-console.txt` and look for failed Workshop downloads.
// PZ's GameServerWorkshopItems.Install() crashes with a NullPointerException
// the moment a subscribed mod cannot be installed (delisted, private, region
// blocked, etc). We detect both the failure lines and whether the install
// step actually crashed.
//
// Returns null if no log; otherwise { ids, results, crashed, logMtime }.
async function scanWorkshopFailures(zPath) {
  if (!zPath) return null;
  const logPath = path.join(zPath, "server-console.txt");
  let stat;
  try {
    stat = await fs.promises.stat(logPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;

  // Only the tail matters — the relevant lines come from the most recent
  // server start. Cap at 256 KB to keep this cheap on huge log files.
  const MAX_TAIL = 256 * 1024;
  const start = Math.max(0, stat.size - MAX_TAIL);
  const length = stat.size - start;
  let text = "";
  let fd;
  try {
    fd = await fs.promises.open(logPath, "r");
    const buf = Buffer.alloc(length);
    await fd.read(buf, 0, length, start);
    text = buf.toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd) {
      try {
        await fd.close();
      } catch {
        /* ignore */
      }
    }
  }

  // Pattern: `Workshop: onItemNotDownloaded itemID=<ID> result=<N>`
  // result=9 is the common "item unavailable" / delisted case, but any
  // non-zero result lands here — we surface them all.
  const failedIds = [];
  const resultByFailedId = {};
  const re = /Workshop:\s+onItemNotDownloaded\s+itemID=(\d+)\s+result=(\d+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!resultByFailedId[m[1]]) {
      failedIds.push(m[1]);
      resultByFailedId[m[1]] = parseInt(m[2], 10);
    }
  }

  // Crash chain: `GameServerWorkshopItems.Install` appears in the stack
  // when the install step actually aborted the server boot.
  const crashed =
    /GameServerWorkshopItems\.Install/.test(text) ||
    /Workshop:\s+item state DownloadPending\s+->\s+Fail/.test(text);

  return {
    ids: failedIds,
    results: resultByFailedId,
    crashed,
    logPath,
    logMtime: stat.mtime,
  };
}

// Generic crash scanner. Tail server-console.txt and report the most
// recent fatal symptom (OOM, main-thread exception, FATAL log line).
// Returns null when nothing notable is in the tail.
async function scanRecentCrash(zPath) {
  if (!zPath) return null;
  const logPath = path.join(zPath, "server-console.txt");
  let stat;
  try {
    stat = await fs.promises.stat(logPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;

  const MAX_TAIL = 256 * 1024;
  const start = Math.max(0, stat.size - MAX_TAIL);
  const length = stat.size - start;
  let text = "";
  let fd;
  try {
    fd = await fs.promises.open(logPath, "r");
    const buf = Buffer.alloc(length);
    await fd.read(buf, 0, length, start);
    text = buf.toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd) {
      try {
        await fd.close();
      } catch {
        /* ignore */
      }
    }
  }

  // Search in priority order — OOM is more actionable than a generic
  // "Exception in thread main". Each pattern keeps a short matched line
  // so the UI can show the smoking-gun text without dumping the stack.
  const patterns = [
    {
      kind: "oom",
      label: "Out of memory",
      re: /java\.lang\.OutOfMemoryError[^\n]*/,
    },
    {
      kind: "workshop",
      label: "Workshop install crash",
      re: /GameServerWorkshopItems\.Install[^\n]*/,
    },
    {
      kind: "mainException",
      label: "Uncaught main-thread exception",
      re: /Exception in thread "main"[^\n]*/,
    },
    {
      kind: "fatal",
      label: "FATAL log entry",
      re: /(?:^|\n)[^\n]*\bFATAL\b[^\n]*/,
    },
  ];
  for (const p of patterns) {
    const m = text.match(p.re);
    if (m)
      return {
        kind: p.kind,
        label: p.label,
        line: m[0].trim().slice(0, 240),
        logMtime: stat.mtime,
      };
  }
  return null;
}

// Parse a PZ dedicated-server .ini. PZ uses `key=value` lines and
// semicolon-separated lists for Mods / WorkshopItems / Map. Returns
// null when the file can't be read.
async function parseServerIni(iniPath) {
  let text;
  try {
    text = await fs.promises.readFile(iniPath, "utf-8");
  } catch {
    return null;
  }
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  const splitSemi = (v) =>
    (v || "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    raw: out,
    Mods: splitSemi(out.Mods),
    WorkshopItems: splitSemi(out.WorkshopItems),
    Map: splitSemi(out.Map),
    RCONPort: parseInt(out.RCONPort, 10) || null,
    RCONPassword: out.RCONPassword || "",
    DefaultPort: parseInt(out.DefaultPort, 10) || null,
    PublicName: out.PublicName || "",
  };
}

// Walk steamapps/workshop/content/108600/<id>/mods/<modName> and return
// Map<workshopId, { mods: string[], maps: string[] }>. Skips items that
// haven't finished downloading (no mod.info inside).
//
// PZ resolves Mods= against the `id=` value(s) declared in each mod.info,
// NOT the folder name. A single mod.info can declare MULTIPLE `id=` lines
// (sub-mods bundled in one folder). We collect every declared id and also
// include the folder name as a fallback for legacy / non-conforming mods.
//
// B42 introduced a multi-version layout where mod.info and media/maps/
// can live under versioned subfolders like `common/`, `41/`, `42/`
// (e.g. <mod>/42/mod.info and <mod>/common/media/maps/<name>/). We
// therefore probe the mod root AND each direct subdirectory.
async function readModIds(modInfoPath, fallbackName) {
  try {
    const text = await fs.promises.readFile(modInfoPath, "utf-8");
    const ids = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      const m = line.match(/^id\s*=\s*(.+?)\s*$/i);
      if (m && m[1]) ids.push(m[1]);
    }
    if (ids.length === 0 && fallbackName) ids.push(fallbackName);
    else if (fallbackName && !ids.includes(fallbackName))
      ids.push(fallbackName);
    return ids;
  } catch {
    return fallbackName ? [fallbackName] : [];
  }
}

// Collect declared mod ids + map folder names from a single mod folder,
// handling both legacy (<mod>/mod.info, <mod>/media/maps/) and B42
// versioned layouts (<mod>/<version>/mod.info, <mod>/<version>/media/maps/).
async function collectModContent(modDir, fallbackName) {
  const ids = new Set();
  const maps = new Set();

  // Candidate roots: the mod dir itself plus every direct subdirectory.
  // B42 conventions use `common`, `41`, `42`, but mods sometimes use other
  // names too (e.g. `43`), so we don't whitelist — we just probe one level.
  const candidateRoots = [modDir];
  const children = await safeReaddir(modDir);
  if (children) {
    await Promise.all(
      children.map(async (child) => {
        const childPath = path.join(modDir, child);
        const st = await safeStat(childPath);
        if (st && st.isDirectory()) candidateRoots.push(childPath);
      }),
    );
  }

  await Promise.all(
    candidateRoots.map(async (root) => {
      const miPath = path.join(root, "mod.info");
      const mi = await safeStat(miPath);
      if (mi && mi.isFile()) {
        const declared = await readModIds(miPath, fallbackName);
        for (const id of declared) ids.add(id);
      }
      const mapDir = path.join(root, "media", "maps");
      const mapNames = await safeReaddir(mapDir);
      if (mapNames) for (const m of mapNames) maps.add(m);
    }),
  );

  return { ids: [...ids], maps: [...maps] };
}

async function scanWorkshopMods(installPath) {
  const out = new Map();
  if (!installPath) return out;
  const root = path.join(
    installPath,
    "steamapps",
    "workshop",
    "content",
    "108600",
  );
  const ids = await safeReaddir(root);
  if (!ids) return out;
  await Promise.all(
    ids.map(async (id) => {
      if (!/^\d+$/.test(id)) return;
      const modsRoot = path.join(root, id, "mods");
      const modNames = await safeReaddir(modsRoot);
      if (!modNames) return;
      const entry = { mods: [], maps: [] };
      await Promise.all(
        modNames.map(async (name) => {
          const collected = await collectModContent(
            path.join(modsRoot, name),
            name,
          );
          for (const declaredId of collected.ids) entry.mods.push(declaredId);
          for (const m of collected.maps) entry.maps.push(m);
        }),
      );
      if (entry.mods.length || entry.maps.length) out.set(id, entry);
    }),
  );
  return out;
}

// Local (non-Workshop) mods live under <zPath>/mods/<name>/mod.info.
// Returns { mods: Set<string>, maps: Set<string> }. Same B42-aware layout
// probing as scanWorkshopMods.
async function scanLocalMods(zPath) {
  const mods = new Set();
  const maps = new Set();
  if (!zPath) return { mods, maps };
  for (const dir of ["mods", "Mods"]) {
    const root = path.join(zPath, dir);
    const names = await safeReaddir(root);
    if (!names) continue;
    await Promise.all(
      names.map(async (name) => {
        const collected = await collectModContent(path.join(root, name), name);
        for (const declaredId of collected.ids) mods.add(declaredId);
        for (const m of collected.maps) maps.add(m);
      }),
    );
  }
  return { mods, maps };
}

// Recursively scan a save folder. Returns total bytes, .bin chunk count,
// and any stale lock files (>1h old, which prevent boot). Bounded by
// MAX_FILES AND by `budgetMs` (wall-clock) so huge saves can't make
// diagnostics hang -- and so the walk itself self-terminates well before
// the caller's own outer timeout, instead of relying on that outer race to
// kill it. Each individual readdir/stat is already time-boxed by
// safeReaddir/safeStat (FS_TIMEOUT_MS), so the walk checks its deadline
// BEFORE issuing the next one rather than mid-flight -- Node's fs.promises
// readdir/stat don't accept an AbortSignal, so a call already in flight
// when the deadline passes can't be cancelled, only not-followed-by-another.
// That bounds the "still running after the caller stopped waiting" tail to
// at most one FS_TIMEOUT_MS, not the open-ended rest of a 50,000-file walk.
async function scanSaveStats(saveDir, budgetMs) {
  if (!saveDir) return null;
  const exists = await safePathExists(saveDir);
  if (!exists) return null;
  const MAX_FILES = 50000;
  const staleAfterMs = 60 * 60 * 1000;
  const now = Date.now();
  const deadline = now + budgetMs;
  let totalBytes = 0;
  let chunks = 0;
  let staleLocks = [];
  let visited = 0;
  let truncated = false;

  const walk = async (dir) => {
    if (visited >= MAX_FILES || Date.now() >= deadline) {
      truncated = true;
      return;
    }
    const names = await safeReaddir(dir);
    if (!names) return;
    for (const name of names) {
      if (++visited > MAX_FILES || Date.now() >= deadline) {
        truncated = true;
        return;
      }
      const full = path.join(dir, name);
      const st = await safeStat(full);
      if (!st) continue;
      if (st.isDirectory()) {
        await walk(full);
      } else if (st.isFile()) {
        totalBytes += st.size;
        if (name.endsWith(".bin")) chunks++;
        if (
          (name.endsWith(".lock") || name === ".lock") &&
          now - st.mtimeMs > staleAfterMs
        ) {
          staleLocks.push({ path: full, ageMs: now - st.mtimeMs });
        }
      }
    }
  };
  await walk(saveDir);
  return { totalBytes, chunks, staleLocks, truncated };
}

// Execute the bundled JRE with `-version`. PZ prints to stderr. Returns
// { ok, version, error } with a hard timeout so we never block the
// diagnostics request on a wedged Java.
function probeJre(javaPath) {
  return new Promise((resolve) => {
    if (!javaPath) return resolve({ ok: false, error: "no path" });
    let done = false;
    let child;
    const finish = (result) => {
      if (done) return;
      done = true;
      try {
        child?.kill?.("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: "timeout" }),
      4000,
    );
    try {
      child = execFile(
        javaPath,
        ["-version"],
        { timeout: 4000, windowsHide: true },
        (err, stdout, stderr) => {
          clearTimeout(timer);
          const text = (stderr || stdout || "").toString();
          const first = text.split(/\r?\n/).find(Boolean) || "";
          if (err) {
            return finish({
              ok: false,
              error:
                err.code === "ENOENT"
                  ? "binary missing"
                  : err.message || "exec failed",
              output: first || null,
            });
          }
          finish({ ok: true, version: first });
        },
      );
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, error: e?.message || "exec failed" });
    }
  });
}

// Single HTTP probe to Steam Web API. Used for both reachability and
// host-clock skew (we read the Date response header).
async function probeSteamWorkshopApi() {
  const t0 = Date.now();
  try {
    if (
      typeof fetch !== "function" ||
      typeof AbortSignal === "undefined" ||
      typeof AbortSignal.timeout !== "function"
    ) {
      return { reachable: false, error: "fetch unavailable", latencyMs: 0 };
    }
    const ctrl = AbortSignal.timeout(5000);
    const resp = await fetch(
      "https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v0001/",
      {
        method: "GET",
        signal: ctrl,
      },
    );
    const dateHeader = resp.headers.get("date");
    let serverTime = null;
    if (dateHeader) {
      const parsed = Date.parse(dateHeader);
      if (Number.isFinite(parsed)) serverTime = parsed;
    }
    return {
      reachable: resp.ok,
      statusCode: resp.status,
      latencyMs: Date.now() - t0,
      serverTime,
      localTime: Date.now(),
    };
  } catch (e) {
    return {
      reachable: false,
      statusCode: null,
      latencyMs: Date.now() - t0,
      error: e?.name === "TimeoutError" ? "timeout" : e?.message || "unknown",
    };
  }
}

// Wrap a promise with a timeout. Used to keep slow / unreachable mounts
// (broken NFS, dead SMB share, suspended VM) from hanging the entire
// diagnostics request. Returns `fallback` on timeout instead of throwing.
function withTimeout(promise, ms, fallback) {
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        return v;
      },
      () => {
        clearTimeout(timer);
        return fallback;
      },
    ),
    timeoutPromise,
  ]);
}

export async function getServerProcessState(
  serverManager,
  timeoutMs = FS_TIMEOUT_MS,
) {
  if (!serverManager) return { running: false, scanFailed: false };

  if (typeof serverManager.getServerProcessDetails === "function") {
    const details = await withTimeout(
      Promise.resolve().then(() => serverManager.getServerProcessDetails()),
      timeoutMs,
      null,
    );
    if (!details || details.scanFailed) {
      return { running: null, scanFailed: true };
    }
    return { running: Boolean(details.running), scanFailed: false };
  }

  if (typeof serverManager.checkServerRunning === "function") {
    const running = await withTimeout(
      Promise.resolve().then(() => serverManager.checkServerRunning()),
      timeoutMs,
      null,
    );
    return typeof running === "boolean"
      ? { running, scanFailed: false }
      : { running: null, scanFailed: true };
  }

  return { running: null, scanFailed: true };
}

const FS_TIMEOUT_MS = 2000;
const safePathExists = (p) =>
  withTimeout(pathExistsAsync(p), FS_TIMEOUT_MS, false);
const safePathWritable = (p) =>
  withTimeout(pathWritableAsync(p), FS_TIMEOUT_MS, false);

async function safeReaddir(p) {
  try {
    return await withTimeout(fs.promises.readdir(p), FS_TIMEOUT_MS, null);
  } catch {
    return null;
  }
}

async function safeStat(p) {
  try {
    return await withTimeout(fs.promises.stat(p), FS_TIMEOUT_MS, null);
  } catch {
    return null;
  }
}

// Run a single check function, catching any unexpected throw and converting
// it into a 'fail' diag entry rather than aborting the whole report.
// Each check function returns a diag object (or null to skip).
// eslint-disable-next-line no-unused-vars
async function runCheck(label, fn, ctx = {}) {
  try {
    const result = await fn();
    return result;
  } catch (e) {
    return diagFail(
      `error.${label}`,
      label,
      `Check failed: ${e?.message || "unknown error"}`,
      ctx,
    );
  }
}

function fmtMB(bytes) {
  if (!Number.isFinite(bytes)) return "?";
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

// Extracted from the inline template it used to be so this specific
// formatting can be unit tested directly, rather than only reachable
// through the whole /diagnostics handler's many other dependencies.
export function formatDbAccessibleMessage(dbStats) {
  const collectionCount = dbStats ? Object.keys(dbStats.collections).length : "?";
  return `${collectionCount} collections, ${fmtMB(dbStats?.fileSizeBytes)}.`;
}

function fmtGB(bytes) {
  if (!Number.isFinite(bytes)) return "?";
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Mod thumbnails silently fail on every real request (GET /thumbnail/:id
// returns HTTP 200 with a 1x1 transparent GIF on every failure path, so the
// browser's onError can never fire), so this check is the only place a
// failed resolution is ever surfaced. DELIBERATE DEVIATION from every other
// check in this file: it counts ALL tracked mods host-wide, not just the
// active server's. If it were server-scoped, a host with zero Steam access
// whose active server happens to track no mods would report "0 of 0
// failing" -- a clean green tick while everything is actually broken.
// Thumbnails resolve per-mod, not per-server, and
// getThumbnailResolutionStatus() itself counts unscoped -- this follows that
// rather than re-scoping it to match the rest of the tab. Extracted as its
// own function (mirrors buildSystemInfo/buildServerConfigSummary etc.
// earlier in this file) so it's independently testable without invoking the
// whole GET /diagnostics handler.
function buildThumbnailResolutionCheck(thumbStatus) {
  const failing = thumbStatus?.failing;
  const total = thumbStatus?.total;
  const lastError = thumbStatus?.lastError ?? null;

  if (typeof failing !== "number" || typeof total !== "number") {
    // Unrecognised shape from getThumbnailResolutionStatus() -- fail closed
    // to warn, not ok, same rule as worldmap.tiles.buildDetect.
    return diagWarn(
      "mods.thumbnailResolution",
      "Mod thumbnail status unavailable",
      "Could not determine mod thumbnail resolution status.",
      { category: "services" },
    );
  }

  if (failing === 0) {
    return diagOk(
      "mods.thumbnailResolution",
      "Mod thumbnails resolving normally",
      total > 0
        ? `${total} tracked mod${total === 1 ? "" : "s"}, all thumbnails resolving.`
        : "No thumbnail resolution failures.",
      { category: "services", params: { total } },
    );
  }

  if (failing < total) {
    const reason = lastError?.reason || "unknown reason";
    const workshopId = lastError?.workshopId || "unknown";
    const age = lastError ? fmtAge(Date.now() - lastError.at).replace(/ ago$/, "") : "unknown";
    return diagWarn(
      "mods.thumbnailResolution",
      "Some mod thumbnails are not resolving",
      `${failing} of ${total} tracked mods currently have no thumbnail. Last failure: ${reason} (Workshop ID ${workshopId}, ${age} ago).`,
      {
        category: "services",
        hint: "Usually means those specific Workshop items were deleted, made private, or region-restricted on Steam — check the Workshop ID above on steamcommunity.com. Resolution retries automatically every 5 minutes; this clears on its own if the item is public and Steam is reachable.",
        params: { failing, total, reason, workshopId, age },
      },
    );
  }

  const reason = lastError?.reason || "unknown reason";
  return diagFail(
    "mods.thumbnailResolution",
    "No mod thumbnails are resolving",
    `All ${total} tracked mods currently have no thumbnail. Last failure: ${reason}.`,
    {
      category: "services",
      hint: "Every mod failing at once, rather than just a few, usually means this host cannot reach Steam at all rather than a problem with any individual mod — check outbound HTTPS to api.steampowered.com and steamuserimages-a.akamaihd.net / *.steamstatic.com / *.akamaihd.net / images.steamusercontent.com (firewall, proxy, or DNS). Once reachable, thumbnails resolve automatically within 5 minutes — no restart needed.",
      params: { total, reason },
    },
  );
}

// Windowed inspection of the panel's own RCON command history (the same log
// the Console page's History panel renders) for a real refusal FROM THE
// GAME -- deliberately EXCLUDES connection/timeout failures, which the
// rcon.connected check above already covers; reporting one outage through
// two checks would be redundant, not more informative.
//
// A game-side rejection re-matches one of RconService.classifyRconResponse's
// known patterns even after being persisted: logCommand() stores
// rejection.error (the already-describe()-transformed text), not the raw
// RCON reply, and each of the 4 known patterns still matches its own
// transformed output (verified against server/services/rcon.js's
// KNOWN_RCON_REJECTIONS literally, not guessed). A connection-error entry
// (e.g. "Server is starting...") also carries success:0 but was never run
// through classifyRconResponse in the first place, so re-classifying it here
// correctly returns null and excludes it.
const RCON_REJECTION_WINDOW_MS = 24 * 60 * 60 * 1000;
const RCON_REJECTION_HISTORY_SCAN_LIMIT = 500; // matches RETENTION.command_history's own cap

// Keyed to the SAME 4 rejection shapes rcon.js's KNOWN_RCON_REJECTIONS
// classifies, matched here against the persisted (already-transformed) text
// since classifyRconResponse itself only reports THAT something matched,
// not WHICH pattern.
const RCON_REJECTION_REASON_HINTS = [
  {
    match: /^Unknown command\b/i,
    hint: "The command does not exist on this build — commands are added and removed between PZ versions, so it's worth checking it is still right for the installed build.",
  },
  {
    match: /^Wrong arguments\b/i,
    hint: "The game rejected the arguments. If this started recently, the syntax may have changed in an update — report the exact action to the panel developers.",
  },
  {
    match: /^Not enough rights\b/i,
    hint: "The RCON account lacks permission on the GAME SERVER. This is the game's own admin access level, separate from this panel's Roles & Permissions — fix in-game or via setaccesslevel.",
  },
  {
    match: /can only be run from in-game/i,
    hint: "Only works typed in-game, never over RCON. Expected for releasing a safehouse until PanelBridge supports it — not a misconfiguration.",
  },
];

// Always present, both states -- not filler: there is no reliable way to
// flag an UNRECOGNISED rejection shape without an unproven heuristic, so
// this names where a human should look instead of pretending to cover it.
const RCON_REJECTIONS_CLOSING_LINE =
  "Everything the panel can positively identify as a rejection is listed above. For anything that looks wrong but is not, the Console page's command history shows the exact raw response every RCON command received, so a person can spot something no automated check catches.";

// Pure summarizer -- no live RconService needed, `classify` is injected so
// this (and buildRconCommandRejectionsCheck below) are testable without a
// real RCON connection. `history` is getCommandHistory()'s raw array
// (newest first, per appendCapped's default). Returns null if `classify`
// itself isn't available (no rconService registered) -- distinct from a
// clean zero-rejections result.
function summarizeRconRejections(history, classify, { windowMs = RCON_REJECTION_WINDOW_MS, now = Date.now() } = {}) {
  if (typeof classify !== "function") return null;
  const cutoff = now - windowMs;
  const byCommand = new Map();
  let total = 0;
  const reasonHints = new Set();

  for (const entry of history || []) {
    if (entry?.success) continue; // classifyRconResponse only ever fails a success:0 entry
    const executedAt = new Date(entry?.executed_at).getTime();
    if (!Number.isFinite(executedAt) || executedAt < cutoff) continue;
    const rejection = classify(entry?.response);
    if (!rejection) continue; // a connection/timeout failure, not a game rejection

    total++;
    byCommand.set(entry.command, (byCommand.get(entry.command) || 0) + 1);
    const known = RCON_REJECTION_REASON_HINTS.find((r) => r.match.test(entry.response));
    if (known) reasonHints.add(known.hint);
  }

  return {
    total,
    breakdown: [...byCommand.entries()].map(([command, count]) => ({ command, count })),
    reasonHints: [...reasonHints],
  };
}

function buildRconCommandRejectionsCheck(summary) {
  if (!summary || typeof summary.total !== "number" || !Array.isArray(summary.breakdown)) {
    // Unrecognised/unavailable -- fail closed to warn, not ok, same rule as
    // worldmap.tiles.buildDetect and mods.thumbnailResolution.
    return diagWarn(
      "rcon.commandRejections",
      "RCON command rejection status unavailable",
      "Could not determine whether the game server has rejected any RCON commands recently.",
      { category: "rcon", hint: RCON_REJECTIONS_CLOSING_LINE },
    );
  }

  if (summary.total === 0) {
    return diagOk(
      "rcon.commandRejections",
      "No RCON command rejections",
      "No RCON commands have been rejected by the game server recently.",
      { category: "rcon", hint: RCON_REJECTIONS_CLOSING_LINE },
    );
  }

  const list = summary.breakdown.map((b) => `${b.command} (x${b.count})`).join(", ");
  const hint = [...summary.reasonHints, RCON_REJECTIONS_CLOSING_LINE].join(" ");
  return diagWarn(
    "rcon.commandRejections",
    "The game server has rejected some RCON commands",
    `${summary.total} commands were rejected by the game server in the last 24 hours: ${list}.`,
    {
      category: "rcon",
      hint,
      params: { total: summary.total, list },
    },
  );
}

router.get("/diagnostics", requirePermission("diagnostics.manage"), async (req, res) => {
  const t0 = Date.now();
  try {
    const rconService = req.app.get("rconService");
    const serverManager = req.app.get("serverManager");
    const modChecker = req.app.get("modChecker");
    const scheduler = req.app.get("scheduler");
    const discordBot = req.app.get("discordBot");
    const panelUpdateChecker = req.app.get("panelUpdateChecker");

    const checks = [];
    const paths = getDataPaths();

    // Process detection may probe the OS process list and can hang on a
    // misbehaving system — keep it bounded and preserve an unknown result.
    const serverStatePromise = getServerProcessState(
      serverManager,
      FS_TIMEOUT_MS,
    );

    const [
      activeServer,
      settings,
      trackedMods,
      scheduledTasks,
      serverState,
      dbStats,
    ] = await Promise.all([
      withTimeout(
        getActiveServer().catch(() => null),
        FS_TIMEOUT_MS,
        null,
      ),
      withTimeout(
        getAllSettings().catch(() => ({})),
        FS_TIMEOUT_MS,
        {},
      ),
      withTimeout(
        getTrackedMods().catch(() => []),
        FS_TIMEOUT_MS,
        [],
      ),
      withTimeout(
        getScheduledTasks().catch(() => []),
        FS_TIMEOUT_MS,
        [],
      ),
      serverStatePromise,
      withTimeout(
        getDatabaseStats().catch(() => null),
        FS_TIMEOUT_MS,
        null,
      ),
    ]);

    const serverRunning = serverState.running;

    // ─── Core Services ────────────────────────────────────────────────
    try {
      const remoteRconOnly =
        !activeServer?.installPath &&
        !activeServer?.serverPath &&
        !activeServer?.zomboidDataPath &&
        Boolean(activeServer?.rconHost || rconService?.config?.host);

      const dockerManagedProvider = ["docker-local", "docker-managed"].includes(
        resolveProvider(activeServer),
      );

      // resolveServerProcessCheckMode() (defined above, near diagSkip) makes
      // the decision; the actual diagOk/diagWarn/diagSkip("server.process",
      // ...) calls stay literal and inline here on purpose -- see that
      // function's own comment for why.
      const serverProcessMode = resolveServerProcessCheckMode({
        remoteRconOnly,
        dockerManagedProvider,
        serverRunning,
      });
      if (serverProcessMode === "remote") {
        checks.push(
          diagSkip(
            "server.process",
            "Remote server process",
            "Managed by the hosting provider; local process monitoring is unavailable. RCON controls remain available.",
            { category: "services" },
          ),
        );
      } else if (serverProcessMode === "docker") {
        checks.push(
          diagSkip(
            "server.process",
            "Containerized server process",
            "Runs in a separate Docker container this page cannot scan directly. RCON/PanelBridge checks below reflect real status.",
            { category: "services" },
          ),
        );
      } else if (serverProcessMode === "unknown") {
        checks.push(
          diagSkip(
            "server.process",
            "Server process state",
            "Unable to determine whether the server process is running.",
            { category: "services" },
          ),
        );
      } else if (serverProcessMode === "running") {
        checks.push(
          diagOk(
            "server.process",
            "Server process running",
            "Project Zomboid dedicated server is alive.",
            { category: "services" },
          ),
        );
      } else {
        checks.push(
          diagWarn(
            "server.process",
            "Server process",
            "Server is stopped. Start it from the dashboard.",
            { category: "services", hint: "Dashboard → Start Server" },
          ),
        );
      }

      if (rconService?.isConnected?.()) {
        const rconHost = rconService.config?.host || "127.0.0.1";
        const rconPort = rconService.config?.port || 27015;
        checks.push(
          diagOk(
            "rcon.connected",
            "RCON connected",
            `Connected to ${rconHost}:${rconPort}.`,
            { category: "services", params: { host: rconHost, port: rconPort } },
          ),
        );
      } else if (serverRunning === null) {
        checks.push(
          diagSkip(
            "rcon.connected",
            "RCON",
            "Server process state is unknown — RCON status cannot be inferred from it.",
            { category: "services" },
          ),
        );
      } else if (serverRunning === false) {
        checks.push(
          diagSkip(
            "rcon.connected",
            "RCON",
            "Server is offline — RCON will connect when it starts.",
            { category: "services" },
          ),
        );
      } else {
        checks.push(
          diagFail(
            "rcon.connected",
            "RCON disconnected",
            "Server is running but RCON is not connected. Check RCON port and password.",
            {
              category: "services",
              hint: "Settings → RCON · server.ini → RCONPassword",
            },
          ),
        );
      }

      // Deliberately excludes connection/timeout failures -- rcon.connected
      // above already covers that outage; reporting it through both checks
      // would double-report the same thing. Own try/catch so a failure here
      // can't take out checks already pushed above it.
      try {
        const summary = summarizeRconRejections(
          await getCommandHistory(RCON_REJECTION_HISTORY_SCAN_LIMIT),
          rconService?.classifyRconResponse
            ? rconService.classifyRconResponse.bind(rconService)
            : null,
        );
        checks.push(buildRconCommandRejectionsCheck(summary));
      } catch (e) {
        checks.push(
          diagWarn(
            "rcon.commandRejections",
            "RCON command rejection status unavailable",
            `Could not determine whether the game server has rejected any RCON commands recently: ${e?.message || "unknown"}`,
            { category: "rcon" },
          ),
        );
      }

      if (modChecker?.isRunning) {
        const interval = Math.round((modChecker.checkInterval || 0) / 60000);
        checks.push(
          diagOk(
            "modChecker",
            "Mod update checker",
            `Polling Steam Workshop every ${interval || "?"} min.`,
            { category: "services", params: { interval: interval || "?" } },
          ),
        );
      } else if (!modChecker?.workshopAcfPath) {
        // No workshop folder yet — checker can't run until server is installed/configured.
        // This is a normal "skipped" state, not a warning.
        checks.push(
          diagSkip(
            "modChecker",
            "Mod update checker",
            "Waiting for Steam Workshop folder — checker starts after the server install path is configured.",
            { category: "services", hint: "Settings → Server Path" },
          ),
        );
      } else {
        checks.push(
          diagWarn(
            "modChecker",
            "Mod update checker stopped",
            "Workshop polling is not running — mod updates won't be detected.",
            { category: "services" },
          ),
        );
      }

      {
        const enabledTasks = (scheduledTasks || []).filter(
          (t) => t.enabled,
        ).length;
        if (scheduler) {
          checks.push(
            diagOk(
              "scheduler",
              "Scheduler",
              `${enabledTasks} enabled task${enabledTasks === 1 ? "" : "s"}.`,
              { category: "services", params: { count: enabledTasks } },
            ),
          );
        } else {
          checks.push(
            diagWarn(
              "scheduler",
              "Scheduler unavailable",
              "Scheduler service did not initialize.",
              { category: "services" },
            ),
          );
        }
      }

      if (discordBot?.token || settings?.discordBotToken) {
        if (discordBot?.isRunning && discordBot?.client?.user) {
          const botTag = discordBot.client.user.tag;
          checks.push(
            diagOk(
              "discord.bot",
              "Discord bot connected",
              `Logged in as ${botTag}.`,
              { category: "services", params: { tag: botTag } },
            ),
          );
        } else {
          checks.push(
            diagFail(
              "discord.bot",
              "Discord bot offline",
              "Bot token configured but not connected. Token may be invalid.",
              { category: "services", hint: "Settings → Discord" },
            ),
          );
        }
      } else {
        checks.push(
          diagSkip("discord.bot", "Discord bot", "Not configured (optional).", {
            category: "services",
          }),
        );
      }

      // Mod thumbnails silently fail (the endpoint returns HTTP 200 with a
      // 1x1 transparent GIF on every failure path), so this is the only
      // place a failed resolution is ever surfaced. Own try/catch (not the
      // shared services.error catch below) so a failure here can't take out
      // the checks already pushed above it, matching every other
      // collector's degrade-alone contract.
      try {
        checks.push(buildThumbnailResolutionCheck(await getThumbnailResolutionStatus()));
      } catch (e) {
        checks.push(
          diagWarn(
            "mods.thumbnailResolution",
            "Mod thumbnail status unavailable",
            `Could not determine mod thumbnail resolution status: ${e?.message || "unknown"}`,
            { category: "services" },
          ),
        );
      }
    } catch (e) {
      const reason = e?.message || "unknown";
      checks.push(
        diagWarn(
          "services.error",
          "Service checks errored",
          `Some service checks could not run: ${reason}`,
          { category: "services", params: { reason } },
        ),
      );
    }

    // ─── Active Server ────────────────────────────────────────────────
    try {
      if (!activeServer) {
        checks.push(
          diagFail(
            "server.active",
            "No active server",
            "Configure a server to enable most panel features.",
            { category: "server", hint: "Servers → Add Server" },
          ),
        );
      } else {
        const activeServerName = activeServer.name || activeServer.serverName || "Unnamed";
        checks.push(
          diagOk(
            "server.active",
            "Active server",
            `${activeServerName}.`,
            { category: "server", params: { name: activeServerName } },
          ),
        );

        const installPath = activeServer.installPath || activeServer.serverPath;
        if (!installPath) {
          checks.push(
            diagFail(
              "server.installPath",
              "Install path missing",
              "Active server has no installPath configured.",
              { category: "server", hint: "Servers → Edit → Install Path" },
            ),
          );
        } else if (await safePathExists(installPath)) {
          checks.push(
            diagOk(
              "server.installPath",
              "Install path exists",
              "Server installation directory is accessible.",
              { category: "server" },
            ),
          );
        } else {
          // Distinguish "not mounted / unreachable" (UNC, NFS) vs "plain missing".
          const isUnc = /^\\\\/.test(installPath) || /^\/\//.test(installPath);
          const isNetMount =
            isUnc ||
            installPath.startsWith("/mnt/") ||
            installPath.startsWith("/media/");
          // Two literal branches, not one call with a ternary message/hint --
          // `variant` (below) must be a call-site string literal so the
          // self-enforcing registry test (server/tests/
          // diagnosticsCheckRegistry.test.js) can statically find every
          // (id, status, variant) the handler can actually emit, the same
          // way errorCodeRegistry.test.js requires literal `code:` values.
          if (isNetMount) {
            checks.push(
              diagFail(
                "server.installPath",
                "Install path not found",
                "Network share or mount not reachable. Check VPN, mount, or share availability.",
                {
                  category: "server",
                  hint: "Verify the share is mounted and credentials are valid",
                  variant: "netMount",
                },
              ),
            );
          } else {
            checks.push(
              diagFail(
                "server.installPath",
                "Install path not found",
                "Configured install path does not exist or is unreadable.",
                {
                  category: "server",
                  hint: "Check the path in Servers → Edit",
                  variant: "local",
                },
              ),
            );
          }
        }

        const zPath = activeServer.zomboidDataPath;
        if (!zPath) {
          checks.push(
            diagWarn(
              "server.zomboidData",
              "Zomboid data path not set",
              "Set the Zomboid user data folder so saves and config can be located.",
              {
                category: "server",
                hint: "Servers → Edit → Zomboid Data Path",
              },
            ),
          );
        } else if (await safePathExists(zPath)) {
          checks.push(
            diagOk(
              "server.zomboidData",
              "Zomboid data path exists",
              "Saves and server config directory is accessible.",
              { category: "server" },
            ),
          );
        } else {
          const isLinuxPlatform = process.platform === "linux";
          checks.push(
            diagFail(
              "server.zomboidData",
              "Zomboid data path not found",
              "Configured saves/config path does not exist.",
              {
                category: "server",
                hint: isLinuxPlatform
                  ? "On Linux this is usually ~/Zomboid"
                  : "On Windows this is usually %USERPROFILE%/Zomboid",
                // Same substitution in every language ("On {{platform}}
                // this is usually {{typicalPath}}") -- a param, not a
                // variant, since only the filled-in values change, not the
                // sentence's structure or informational content.
                params: {
                  platform: isLinuxPlatform ? "Linux" : "Windows",
                  typicalPath: isLinuxPlatform ? "~/Zomboid" : "%USERPROFILE%/Zomboid",
                },
              },
            ),
          );
        }

        if (installPath && (await safePathExists(installPath))) {
          const isWin = process.platform === "win32";
          const serverName = activeServer.serverName || "";
          // Linux is case-sensitive — list each script variant explicitly.
          const candidates = isWin
            ? [
                serverName ? `StartServer_${serverName}.bat` : null,
                "StartServer64.bat",
                "StartServer64_nosteam.bat",
                "StartServer32.bat",
              ]
            : [
                serverName ? `start-server_${serverName}.sh` : null,
                "start-server.sh",
                "start-server-nosteam.sh",
              ];
          let foundScript = null;
          let scriptStat = null;
          for (const name of candidates) {
            if (!name) continue;
            const p = path.join(installPath, name);
            const st = await safeStat(p);
            if (st && st.isFile()) {
              foundScript = name;
              scriptStat = st;
              break;
            }
          }
          if (foundScript) {
            // On Linux, verify the executable bit. On Windows, mode bits are
            // meaningless so we just confirm presence.
            if (!isWin && scriptStat && (scriptStat.mode & 0o111) === 0) {
              // Two different "warn" scenarios for this id (not-executable
              // vs not-found below) need distinct label/message text, not
              // just different data in the same template -- variant, not
              // params, same reasoning as server.installPath above.
              checks.push(
                diagWarn(
                  "server.startScript",
                  "Start script not executable",
                  `${foundScript} exists but has no executable bit. The panel cannot launch it.`,
                  {
                    category: "server",
                    hint: `Run: chmod +x ${foundScript}`,
                    params: { script: foundScript },
                    variant: "notExecutable",
                  },
                ),
              );
            } else {
              checks.push(
                diagOk(
                  "server.startScript",
                  "Start script found",
                  `Using ${foundScript}.`,
                  { category: "server", params: { script: foundScript } },
                ),
              );
            }
          } else {
            const scriptPattern = isWin ? "StartServer*.bat" : "start-server*.sh";
            checks.push(
              diagWarn(
                "server.startScript",
                "Start script not found",
                `No ${scriptPattern} in install path. Server can't be started from the panel.`,
                { category: "server", params: { pattern: scriptPattern }, variant: "notFound" },
              ),
            );
          }

          // Java/JRE check — PZ ships its own JRE under jre64/.
          const isLinux = process.platform === "linux";
          const jreCandidates = isWin
            ? ["jre64/bin/java.exe", "jre/bin/java.exe"]
            : ["jre64/bin/java", "jre/bin/java"];
          let foundJre = null;
          for (const rel of jreCandidates) {
            const p = path.join(installPath, ...rel.split("/"));
            if (await safePathExists(p)) {
              foundJre = rel;
              break;
            }
          }
          if (foundJre) {
            checks.push(
              diagOk(
                "server.jre",
                "Bundled JRE present",
                `Found ${foundJre}.`,
                { category: "server", params: { path: foundJre } },
              ),
            );
          } else {
            const javaBin = isWin ? "java.exe" : "java";
            // hint's content genuinely differs by platform (not just a
            // filled-in value) -- variant, not params, for the hint; two
            // literal-variant branches so the registry test can statically
            // find both, same reasoning as server.installPath above.
            if (isLinux) {
              const jreNotFoundMessage = `Could not locate jre64/bin/${javaBin} under the install path. Run command -v java to check the service user's PATH.`;
              checks.push(
                diagWarn(
                  "server.jre",
                  "Bundled JRE not found",
                  jreNotFoundMessage,
                  {
                    category: "server",
                    hint: "Most installs ship a JRE under jre64/. Re-run SteamCMD if missing.",
                    params: { javaBin },
                    variant: "linux",
                  },
                ),
              );
            } else {
              const jreNotFoundMessage = `Could not locate jre64/bin/${javaBin} under the install path. Run where java to check the service account's PATH.`;
              checks.push(
                diagWarn(
                  "server.jre",
                  "Bundled JRE not found",
                  jreNotFoundMessage,
                  {
                    category: "server",
                    hint: "Re-run SteamCMD to restore the bundled JRE",
                    params: { javaBin },
                    variant: "windows",
                  },
                ),
              );
            }
          }
        }

        // server.ini lives under <zomboidDataPath>/Server/<serverName>.ini
        if (zPath && activeServer.serverName) {
          const iniPath = path.join(
            zPath,
            "Server",
            `${activeServer.serverName}.ini`,
          );
          if (await safePathExists(iniPath)) {
            checks.push(
              diagOk(
                "server.ini",
                "server.ini found",
                `${activeServer.serverName}.ini is in place.`,
                { category: "server", params: { serverName: activeServer.serverName } },
              ),
            );
          } else {
            checks.push(
              diagWarn(
                "server.ini",
                "server.ini not found",
                `${activeServer.serverName}.ini is not in <zomboidData>/Server/. The server will create defaults on first run.`,
                { category: "server", params: { serverName: activeServer.serverName } },
              ),
            );
          }
        }

        if (
          !activeServer.rconPassword ||
          activeServer.rconPassword.length === 0
        ) {
          checks.push(
            diagWarn(
              "server.rconPassword",
              "RCON password not set",
              "No RCON password configured. RCON commands will fail.",
              {
                category: "server",
                hint: "Servers → Edit → RCON Password (must match server.ini)",
              },
            ),
          );
        } else {
          checks.push(
            diagOk(
              "server.rconPassword",
              "RCON password configured",
              "RCON password is set in panel config.",
              { category: "server" },
            ),
          );
        }

        if (zPath || installPath) {
          // Cover both case variants (Linux is case-sensitive) and both
          // mods/ + Workshop/ trees + the server install media path.
          const bridgeCandidates = [];
          if (zPath) {
            for (const root of ["mods", "Mods"]) {
              bridgeCandidates.push(
                path.join(zPath, root, "PanelBridge", "mod.info"),
              );
              bridgeCandidates.push(
                path.join(
                  zPath,
                  root,
                  "PanelBridge",
                  "media",
                  "lua",
                  "server",
                  "PanelBridge.lua",
                ),
              );
            }
            bridgeCandidates.push(
              path.join(zPath, "Workshop", "PanelBridge", "mod.info"),
            );
            bridgeCandidates.push(
              path.join(zPath, "workshop", "PanelBridge", "mod.info"),
            );
          }
          if (installPath) {
            bridgeCandidates.push(
              path.join(
                installPath,
                "media",
                "lua",
                "server",
                "PanelBridge.lua",
              ),
            );
            bridgeCandidates.push(
              path.join(
                installPath,
                "steamapps",
                "workshop",
                "content",
                "108600",
              ),
            );
          }
          let bridgeInstalled = false;
          for (const p of bridgeCandidates) {
            if (await safePathExists(p)) {
              bridgeInstalled = true;
              break;
            }
          }
          if (bridgeInstalled) {
            checks.push(
              diagOk(
                "server.bridgeMod",
                "PanelBridge mod present",
                "PanelBridge.lua is deployed on the server.",
                { category: "server" },
              ),
            );
          } else {
            checks.push(
              diagWarn(
                "server.bridgeMod",
                "PanelBridge mod not detected",
                "Couldn't find PanelBridge.lua under the server. Advanced features (teleport, weather, character export) will be unavailable.",
                {
                  category: "server",
                  hint: "Copy pz-mod/PanelBridge into the server's media/lua/server folder",
                },
              ),
            );
          }
        }

        // Workshop install crash / failed-mod detector.
        // PZ aborts on boot with a NullPointerException if any subscribed
        // Workshop mod fails to download (delisted, private, region locked).
        // We tail server-console.txt for the smoking-gun lines and flag the
        // offending IDs so the user can remove them from the .ini.
        let workshopCrashed = false;
        if (zPath) {
          const wf = await withTimeout(
            scanWorkshopFailures(zPath),
            FS_TIMEOUT_MS,
            null,
          );
          if (wf && wf.ids.length > 0) {
            const shown = wf.ids.slice(0, 5).join(", ");
            const idList =
              wf.ids.length > 5
                ? `${shown}, +${wf.ids.length - 5} more`
                : shown;
            const ageMin = Math.max(
              0,
              Math.round((Date.now() - wf.logMtime.getTime()) / 60000),
            );
            const ageLabel =
              ageMin < 60
                ? `${ageMin}m ago`
                : ageMin < 1440
                  ? `${Math.round(ageMin / 60)}h ago`
                  : `${Math.round(ageMin / 1440)}d ago`;
            const plural = wf.ids.length > 1 ? "s" : "";
            const meta = {
              failedIds: wf.ids,
              results: wf.results,
              crashed: wf.crashed,
              logMtime: wf.logMtime,
            };
            // Grammar agreement (item/items, ID/IDs, is/are, this/these) is
            // simplified to a single always-readable phrasing rather than
            // modeled as params or variants -- these are English pluralization
            // rules that don't transfer to French's own (different) ones, so
            // a param carrying "is"/"are" would just be a second un-
            // translated-English-word problem like runtime.timeSkew's
            // direction. The count and list themselves are still real params.
            if (wf.crashed) {
              workshopCrashed = true;
              checks.push(
                diagFail(
                  "mods.workshopCrash",
                  "Workshop mod download failed — server boot aborted",
                  `${wf.ids.length} Workshop item${plural} could not be downloaded and the server crashed during install (last log update ${ageLabel}). Failing ID${plural}: ${idList}. The mod${plural} ${plural ? "are" : "is"} most likely delisted, made private, or region-restricted.`,
                  {
                    category: "server",
                    hint: `Open Server Config and remove ${wf.ids.length > 1 ? "these IDs" : "this ID"} from both WorkshopItems= and Mods=, then restart.`,
                    meta,
                    params: { count: wf.ids.length, ageLabel, idList },
                  },
                ),
              );
            } else {
              checks.push(
                diagWarn(
                  "mods.workshopCrash",
                  "Workshop download warnings",
                  `${wf.ids.length} Workshop item${plural} recently failed to download but the server did not crash (last log update ${ageLabel}). ID${plural}: ${idList}.`,
                  {
                    category: "server",
                    hint: "Verify each ID is still public on the Steam Workshop, or remove it from the server config.",
                    meta,
                    params: { count: wf.ids.length, ageLabel, idList },
                  },
                ),
              );
            }
          }
        }

        // Generic recent-crash detector. Catches OOMs, main-thread exceptions,
        // and FATAL log entries that aren't the Workshop install crash (which
        // we already flagged above with richer detail).
        if (zPath) {
          const rc = await withTimeout(
            scanRecentCrash(zPath),
            FS_TIMEOUT_MS,
            null,
          );
          if (rc && !(workshopCrashed && rc.kind === "workshop")) {
            const ageMin = Math.max(
              0,
              Math.round((Date.now() - rc.logMtime.getTime()) / 60000),
            );
            const ageLabel =
              ageMin < 60
                ? `${ageMin}m ago`
                : ageMin < 1440
                  ? `${Math.round(ageMin / 60)}h ago`
                  : `${Math.round(ageMin / 1440)}d ago`;
            // rc.kind is a small fixed enum (oom/workshop/mainException/
            // fatal), but `variant: rc.kind` would be a VARIABLE reference at
            // the call site -- invisible to the registry test's regex scan
            // the same way a ternary or template literal is, even though the
            // set of values is closed. Four literal branches instead, so
            // every kind is statically findable. Label differs per kind
            // (baked into each variant's own locale entry, not a param);
            // hint only really differs oom-vs-not, but each variant still
            // carries its own complete hint per the "variants are self-
            // contained" rule -- some duplication, deliberately.
            const recentCrashMessage = `Found in server-console.txt (last update ${ageLabel}): ${rc.line}`;
            const recentCrashParams = { ageLabel, line: rc.line };
            if (rc.kind === "oom") {
              checks.push(
                diagFail("server.recentCrash", `Recent crash: ${rc.label}`, recentCrashMessage, {
                  category: "server",
                  hint: "Raise the server's Java heap (-Xmx in the start script) or reduce mod count.",
                  meta: { kind: rc.kind, logMtime: rc.logMtime },
                  params: recentCrashParams,
                  variant: "oom",
                }),
              );
            } else if (rc.kind === "workshop") {
              checks.push(
                diagFail("server.recentCrash", `Recent crash: ${rc.label}`, recentCrashMessage, {
                  category: "server",
                  hint: "Open the Logs page and read the stack trace around the timestamp.",
                  meta: { kind: rc.kind, logMtime: rc.logMtime },
                  params: recentCrashParams,
                  variant: "workshop",
                }),
              );
            } else if (rc.kind === "mainException") {
              checks.push(
                diagFail("server.recentCrash", `Recent crash: ${rc.label}`, recentCrashMessage, {
                  category: "server",
                  hint: "Open the Logs page and read the stack trace around the timestamp.",
                  meta: { kind: rc.kind, logMtime: rc.logMtime },
                  params: recentCrashParams,
                  variant: "mainException",
                }),
              );
            } else {
              checks.push(
                diagFail("server.recentCrash", `Recent crash: ${rc.label}`, recentCrashMessage, {
                  category: "server",
                  hint: "Open the Logs page and read the stack trace around the timestamp.",
                  meta: { kind: rc.kind, logMtime: rc.logMtime },
                  params: recentCrashParams,
                  variant: "fatal",
                }),
              );
            }
          }
        }

        // INI-driven checks (mods/workshop consistency, map validity, drift,
        // sandbox vars). Parsed once and reused.
        const iniPathForActive =
          zPath && activeServer.serverName
            ? path.join(zPath, "Server", `${activeServer.serverName}.ini`)
            : null;
        const ini = iniPathForActive
          ? await withTimeout(
              parseServerIni(iniPathForActive),
              FS_TIMEOUT_MS,
              null,
            )
          : null;

        if (ini && installPath) {
          // Resolve every Mods= entry to either a Workshop mod folder or a
          // local mod folder. Anything unresolved means "this mod will not
          // load" — silent and one of the most painful PZ-server gotchas.
          const [wsScan, localScan] = await Promise.all([
            withTimeout(
              scanWorkshopMods(installPath),
              FS_TIMEOUT_MS,
              new Map(),
            ),
            withTimeout(scanLocalMods(zPath), FS_TIMEOUT_MS, {
              mods: new Set(),
              maps: new Set(),
            }),
          ]);
          const wsModNames = new Set();
          const wsMapNames = new Set();
          for (const v of wsScan.values()) {
            for (const m of v.mods) wsModNames.add(m);
            for (const m of v.maps) wsMapNames.add(m);
          }

          const allUnresolved = ini.Mods.filter(
            (m) => !wsModNames.has(m) && !localScan.mods.has(m),
          );
          // Numeric "Mods=" entries are almost always Workshop IDs that the
          // user pasted into the wrong field. They can never resolve as mod
          // folder names, so flag them separately with a safe auto-fix.
          const numericInMods = allUnresolved.filter((m) => /^\d{5,}$/.test(m));
          const unresolvedMods = allUnresolved.filter(
            (m) => !/^\d{5,}$/.test(m),
          );

          if (numericInMods.length > 0) {
            const shown = numericInMods.slice(0, 5).join(", ");
            const list =
              numericInMods.length > 5
                ? `${shown}, +${numericInMods.length - 5} more`
                : shown;
            const plural = numericInMods.length === 1 ? "y" : "ies";
            checks.push(
              diagWarn(
                "mods.numericInMods",
                "Workshop IDs misplaced in Mods=",
                `${numericInMods.length} numeric entr${plural} in Mods= look like Workshop IDs, not mod folder names: ${list}. These belong in WorkshopItems= and will never load from Mods=.`,
                {
                  category: "server",
                  hint: "Remove these from Mods= and add them to WorkshopItems= instead.",
                  meta: { numericInMods },
                  params: { count: numericInMods.length, list },
                },
              ),
            );
          }

          if (allUnresolved.length === 0 && ini.Mods.length > 0) {
            checks.push(
              diagOk(
                "mods.resolved",
                "Mods= entries all resolve",
                `${ini.Mods.length} mod${ini.Mods.length === 1 ? "" : "s"} listed, all match an installed Workshop or local mod folder.`,
                { category: "server", params: { count: ini.Mods.length } },
              ),
            );
          } else if (unresolvedMods.length > 0) {
            const shown = unresolvedMods.slice(0, 5).join(", ");
            const list =
              unresolvedMods.length > 5
                ? `${shown}, +${unresolvedMods.length - 5} more`
                : shown;
            // Per-ID triage so the Server Config deep-link can say WHY each
            // entry failed instead of just listing it -- see
            // triageUnresolvedMods's own comment above for what each cause
            // does and doesn't claim to know.
            const normalizedInstallPathForOp = path
              .normalize(installPath)
              .toLowerCase();
            const steamOperationActive = hasActiveSteamOperation(
              normalizedInstallPathForOp,
            );
            const anyWorkshopMissingFromDisk = ini.WorkshopItems.some(
              (id) => /^\d{1,15}$/.test(id) && !wsScan.has(id),
            );
            const installedModNames = [...wsModNames, ...localScan.mods];
            const unresolvedTriage = triageUnresolvedMods(
              unresolvedMods,
              installedModNames,
              { steamOperationActive, anyWorkshopMissingFromDisk },
            );
            checks.push(
              diagFail(
                "mods.resolved",
                "Mods= entries do not resolve",
                `${unresolvedMods.length} of ${ini.Mods.length} Mods= entries don't match any installed Workshop or local mod ID: ${list}.`,
                {
                  category: "server",
                  hint: "Usually a typo, missing WorkshopItems= ID, or the mod hasn't finished downloading. Fix in Server Config.",
                  meta: { unresolvedMods, unresolvedTriage },
                  params: { count: unresolvedMods.length, total: ini.Mods.length, list },
                },
              ),
            );
          }

          // WorkshopItems= entries that don't appear in Mods= are subscribed
          // but disabled — usually intentional, sometimes a bug. Warn quietly.
          const modSet = new Set(ini.Mods);
          const orphanWorkshop = [];
          // Also flag IDs in WorkshopItems= that don't exist on disk at all —
          // these are "dead subscriptions" that will never load and just waste
          // Steam bandwidth on every server start.
          const deadWorkshop = [];
          for (const id of ini.WorkshopItems) {
            if (!/^\d{1,15}$/.test(id)) continue;
            const v = wsScan.get(id);
            if (!v) {
              // Subscribed but no folder on disk → dead.
              deadWorkshop.push(id);
              continue;
            }
            const provides = [...v.mods, ...v.maps];
            if (provides.length === 0) continue;
            if (!provides.some((name) => modSet.has(name)))
              orphanWorkshop.push(id);
          }
          if (orphanWorkshop.length > 0 || deadWorkshop.length > 0) {
            const all = [...orphanWorkshop, ...deadWorkshop];
            const shown = all.slice(0, 5).join(", ");
            const list =
              all.length > 5 ? `${shown}, +${all.length - 5} more` : shown;
            const parts = [];
            if (orphanWorkshop.length)
              parts.push(
                `${orphanWorkshop.length} downloaded but not in Mods=`,
              );
            if (deadWorkshop.length)
              parts.push(
                `${deadWorkshop.length} not on disk (dead subscription)`,
              );
            const orphanWorkshopHint =
              "Auto-fix triages each ID: downloaded → resolves and adds to Mods=; ignored or missing → removes from WorkshopItems=.";
            const orphanWorkshopMeta = {
              orphanWorkshop: all,
              downloadedOrphans: orphanWorkshop,
              deadOrphans: deadWorkshop,
            };
            const orphanWorkshopMessage = `${all.length} Workshop item${all.length === 1 ? " is" : "s are"} listed in WorkshopItems= but won't load: ${parts.join(", ")}. IDs: ${list}.`;
            // Which two-of-three-clauses combination the sentence needs is
            // itself the thing that varies (downloaded-only / dead-only /
            // both), not just the numbers inside one fixed template --
            // variant, three literal branches.
            if (orphanWorkshop.length > 0 && deadWorkshop.length > 0) {
              checks.push(
                diagWarn("mods.orphanWorkshop", "Subscribed Workshop items not enabled", orphanWorkshopMessage, {
                  category: "server",
                  hint: orphanWorkshopHint,
                  meta: orphanWorkshopMeta,
                  params: { count: all.length, downloadedCount: orphanWorkshop.length, deadCount: deadWorkshop.length, list },
                  variant: "both",
                }),
              );
            } else if (orphanWorkshop.length > 0) {
              checks.push(
                diagWarn("mods.orphanWorkshop", "Subscribed Workshop items not enabled", orphanWorkshopMessage, {
                  category: "server",
                  hint: orphanWorkshopHint,
                  meta: orphanWorkshopMeta,
                  params: { count: all.length, downloadedCount: orphanWorkshop.length, list },
                  variant: "downloadedOnly",
                }),
              );
            } else {
              checks.push(
                diagWarn("mods.orphanWorkshop", "Subscribed Workshop items not enabled", orphanWorkshopMessage, {
                  category: "server",
                  hint: orphanWorkshopHint,
                  meta: orphanWorkshopMeta,
                  params: { count: all.length, deadCount: deadWorkshop.length, list },
                  variant: "deadOnly",
                }),
              );
            }
          }

          // Duplicate Mods= / WorkshopItems= entries (cosmetic but confusing).
          const dupMods = ini.Mods.filter((m, i, a) => a.indexOf(m) !== i);
          const dupWs = ini.WorkshopItems.filter(
            (m, i, a) => a.indexOf(m) !== i,
          );
          if (dupMods.length || dupWs.length) {
            const parts = [];
            if (dupMods.length)
              parts.push(
                `${dupMods.length} duplicate Mods= entr${dupMods.length === 1 ? "y" : "ies"}`,
              );
            if (dupWs.length)
              parts.push(
                `${dupWs.length} duplicate WorkshopItems= entr${dupWs.length === 1 ? "y" : "ies"}`,
              );
            const dupMessage = `${parts.join(", ")} in the server config.`;
            const dupHint = "Tidy up Server Config — duplicates can confuse mod-load order.";
            const dupMeta = {
              dupMods: [...new Set(dupMods)],
              dupWs: [...new Set(dupWs)],
            };
            // Same "which clauses does the sentence need" variance as
            // orphanWorkshop above -- three literal branches.
            if (dupMods.length && dupWs.length) {
              checks.push(
                diagWarn("mods.duplicates", "Duplicate mod entries", dupMessage, {
                  category: "server",
                  hint: dupHint,
                  meta: dupMeta,
                  params: { dupModsCount: dupMods.length, dupWsCount: dupWs.length },
                  variant: "both",
                }),
              );
            } else if (dupMods.length) {
              checks.push(
                diagWarn("mods.duplicates", "Duplicate mod entries", dupMessage, {
                  category: "server",
                  hint: dupHint,
                  meta: dupMeta,
                  params: { dupModsCount: dupMods.length },
                  variant: "modsOnly",
                }),
              );
            } else {
              checks.push(
                diagWarn("mods.duplicates", "Duplicate mod entries", dupMessage, {
                  category: "server",
                  hint: dupHint,
                  meta: dupMeta,
                  params: { dupWsCount: dupWs.length },
                  variant: "workshopOnly",
                }),
              );
            }
          }

          // Map= validity. `Muldraugh, KY` is the built-in base map; everything
          // else has to come from a mod's media/maps/ folder. Match case-
          // insensitively because PZ's Windows resolver is case-insensitive
          // and many map mods use mixed case folder names.
          const BUILTIN_MAPS = new Set(["Muldraugh, KY"]);
          const mapNamesKnownLower = new Set();
          for (const m of BUILTIN_MAPS) mapNamesKnownLower.add(m.toLowerCase());
          for (const m of wsMapNames) mapNamesKnownLower.add(m.toLowerCase());
          for (const m of localScan.maps)
            mapNamesKnownLower.add(m.toLowerCase());
          // Build a lowercase set of every *mod folder name* so we can detect
          // the classic confusion: "I put my mod name in Map=" (it belongs in
          // Mods= only).
          const modNamesKnownLower = new Set();
          for (const m of wsModNames) modNamesKnownLower.add(m.toLowerCase());
          for (const m of localScan.mods)
            modNamesKnownLower.add(m.toLowerCase());

          const missingMaps = ini.Map.filter(
            (m) => !mapNamesKnownLower.has(m.toLowerCase()),
          );
          if (ini.Map.length > 0 && missingMaps.length === 0) {
            checks.push(
              diagOk(
                "mods.maps",
                "Map= entries resolve",
                `${ini.Map.length} map layer${ini.Map.length === 1 ? "" : "s"} configured.`,
                { category: "server", params: { count: ini.Map.length } },
              ),
            );
          } else if (missingMaps.length > 0) {
            const modsInMap = missingMaps.filter((m) =>
              modNamesKnownLower.has(m.toLowerCase()),
            );
            const trulyMissing = missingMaps.filter(
              (m) => !modNamesKnownLower.has(m.toLowerCase()),
            );
            const parts = [];
            if (modsInMap.length > 0) {
              parts.push(
                `${modsInMap.length} entr${modsInMap.length === 1 ? "y is a mod" : "ies are mods"}, not a map (belong only in Mods=): ${modsInMap.join(", ")}`,
              );
            }
            if (trulyMissing.length > 0) {
              parts.push(
                `${trulyMissing.length} not found in any installed mod: ${trulyMissing.join(", ")}`,
              );
            }
            const mapsMessage = `${missingMaps.length} entr${missingMaps.length === 1 ? "y" : "ies"} in Map= cannot be found. ${parts.join(". ")}.`;
            const mapsMeta = { missingMaps, modsInMap, trulyMissing };
            const modsInMapList = modsInMap.join(", ");
            const trulyMissingList = trulyMissing.join(", ");
            // Same "which clauses" variance as orphanWorkshop/duplicates
            // above -- three literal branches, each with its own hint (the
            // hint ternary already picked a different sentence per case, so
            // this was already effectively three scenarios before params
            // ever entered the picture).
            if (modsInMap.length > 0 && trulyMissing.length > 0) {
              checks.push(
                diagFail("mods.maps", "Map= entries do not resolve", mapsMessage, {
                  category: "server",
                  hint: "Remove mod names from Map=, and add the matching map mod or fix spelling for the rest.",
                  meta: mapsMeta,
                  params: {
                    count: missingMaps.length,
                    modsInMapCount: modsInMap.length,
                    modsInMapList,
                    trulyMissingCount: trulyMissing.length,
                    trulyMissingList,
                  },
                  variant: "both",
                }),
              );
            } else if (modsInMap.length > 0) {
              checks.push(
                diagFail("mods.maps", "Map= entries do not resolve", mapsMessage, {
                  category: "server",
                  hint: "These names are mods, not maps. Remove them from Map= — they only need to be in Mods=.",
                  meta: mapsMeta,
                  params: { count: missingMaps.length, modsInMapCount: modsInMap.length, modsInMapList },
                  variant: "modsOnly",
                }),
              );
            } else {
              checks.push(
                diagFail("mods.maps", "Map= entries do not resolve", mapsMessage, {
                  category: "server",
                  hint: "Players will spawn into the void. Add the matching map mod or fix the spelling in Server Config.",
                  meta: mapsMeta,
                  params: { count: missingMaps.length, trulyMissingCount: trulyMissing.length, trulyMissingList },
                  variant: "missingOnly",
                }),
              );
            }
          }
        }

        // Config drift — panel settings vs server.ini ground truth.
        if (ini) {
          const drift = [];
          const panelRconPort = parseInt(activeServer.rconPort, 10);
          if (
            Number.isFinite(panelRconPort) &&
            ini.RCONPort &&
            panelRconPort !== ini.RCONPort
          ) {
            drift.push(
              `RCON port: panel ${panelRconPort} vs ini ${ini.RCONPort}`,
            );
          }
          if (
            activeServer.rconPassword &&
            ini.RCONPassword &&
            activeServer.rconPassword !== ini.RCONPassword
          ) {
            drift.push("RCON password differs from server.ini");
          }
          const panelGamePort = parseInt(
            activeServer.gamePort || activeServer.port,
            10,
          );
          if (
            Number.isFinite(panelGamePort) &&
            ini.DefaultPort &&
            panelGamePort !== ini.DefaultPort
          ) {
            drift.push(
              `Game port: panel ${panelGamePort} vs ini DefaultPort ${ini.DefaultPort}`,
            );
          }
          if (drift.length > 0) {
            checks.push(
              diagFail(
                "server.configDrift",
                "Panel config differs from server.ini",
                drift.join("; ") + ".",
                {
                  category: "server",
                  hint: "Edit Servers → Edit to match server.ini, or update server.ini via Server Config.",
                  meta: { drift },
                },
              ),
            );
          } else {
            checks.push(
              diagOk(
                "server.configDrift",
                "Panel config matches server.ini",
                "RCON port, password, and game port agree with server.ini.",
                { category: "server" },
              ),
            );
          }
        }

        // Sandbox vars file — admins edit this to set server-wide defaults.
        // Server boots without it (uses built-in defaults), which silently
        // ignores any tuning the user thought they applied.
        if (zPath && activeServer.serverName) {
          const sbxPath = path.join(
            zPath,
            "Server",
            `${activeServer.serverName}_SandboxVars.lua`,
          );
          if (await safePathExists(sbxPath)) {
            let braceCheck = null;
            try {
              const sbxContent = await fs.promises.readFile(sbxPath, "utf-8");
              braceCheck = checkSandboxBraceBalance(sbxContent);
            } catch {
              braceCheck = null;
            }

            if (braceCheck && !braceCheck.balanced) {
              checks.push(
                diagFail(
                  "server.sandboxCorrupt",
                  "SandboxVars.lua is corrupt",
                  `${activeServer.serverName}_SandboxVars.lua has mismatched braces and will fail to load — the dedicated server exits immediately on boot with a Lua syntax error.`,
                  {
                    category: "server",
                    hint: "Use the automated repair below, or restore from a .bak backup in the same folder.",
                    params: { serverName: activeServer.serverName },
                  },
                ),
              );
            } else {
              checks.push(
                diagOk(
                  "server.sandboxVars",
                  "SandboxVars present",
                  `${activeServer.serverName}_SandboxVars.lua is in place.`,
                  { category: "server", params: { serverName: activeServer.serverName } },
                ),
              );
            }
          } else {
            checks.push(
              diagWarn(
                "server.sandboxVars",
                "SandboxVars missing",
                `${activeServer.serverName}_SandboxVars.lua not found. Server will boot with built-in defaults; any custom sandbox tuning will be ignored.`,
                {
                  category: "server",
                  hint: "Open Server Config → Sandbox to generate one, or copy from another server.",
                  params: { serverName: activeServer.serverName },
                },
              ),
            );
          }
        }

        // Stale .lock files in the save folder — these block PZ from
        // resuming a save and are a classic "server won't boot, no obvious
        // error" symptom after a hard crash.
        if (zPath && activeServer.serverName) {
          const savesRoot = path.join(zPath, "Saves");
          const saveDirCandidates = [
            path.join(savesRoot, "Multiplayer", activeServer.serverName),
          ];
          if (
            activeServer.savename &&
            activeServer.savename !== activeServer.serverName
          ) {
            saveDirCandidates.push(
              path.join(savesRoot, "Multiplayer", activeServer.savename),
            );
          }
          let saveStats = null;
          let saveDirUsed = null;
          for (const sp of saveDirCandidates) {
            const st = await safeStat(sp);
            if (st && st.isDirectory()) {
              // scanSaveStats gets a budget comfortably under the outer
              // withTimeout below, so it almost always finishes (with
              // truncated: true if it ran out of room) rather than being
              // raced away -- the outer wrap stays only as a last-resort
              // safety net. Both `null` (raced away) and `truncated: true`
              // (self-bounded early exit) mean the same thing to the check
              // below: this scan could not fully confirm the save is clean.
              saveStats = await withTimeout(
                scanSaveStats(sp, FS_TIMEOUT_MS * 3),
                FS_TIMEOUT_MS * 4,
                null,
              );
              saveDirUsed = sp;
              break;
            }
          }
          const staleLocksCheck = buildStaleLocksCheck(saveStats, saveDirUsed);
          if (staleLocksCheck) checks.push(staleLocksCheck);
          // Save-size info is emitted in the Storage section below — we
          // stash the stats on the response context via a per-request var.
          req._diagSaveStats = saveStats ? { ...saveStats, saveDirUsed } : null;
        }

        // Actually run the bundled JRE to make sure it's not a truncated
        // SteamCMD install. The existing `server.jre` check only verifies
        // the binary file is present.
        if (installPath) {
          const isWin = process.platform === "win32";
          const jreCandidates = isWin
            ? ["jre64/bin/java.exe", "jre/bin/java.exe"]
            : ["jre64/bin/java", "jre/bin/java"];
          let javaBin = null;
          for (const rel of jreCandidates) {
            const p = path.join(installPath, ...rel.split("/"));
            if (await safePathExists(p)) {
              javaBin = p;
              break;
            }
          }
          if (javaBin) {
            const probe = await withTimeout(probeJre(javaBin), 5000, {
              ok: false,
              error: "timeout",
            });
            if (probe.ok) {
              // probe.version, when present, is raw `java -version` tool
              // output -- language-agnostic, embedded as-is via a param.
              // The fallback phrase for the rare case where nothing was
              // captured stays untranslated English in that one case; not
              // worth a variant for how narrow it is.
              checks.push(
                diagOk(
                  "server.jreWorks",
                  "Bundled JRE runs",
                  probe.version || "java -version executed successfully.",
                  {
                    category: "server",
                    params: { version: probe.version || "java -version executed successfully." },
                  },
                ),
              );
            } else {
              const reason = probe.error || "unknown";
              // Whether there's captured stdout/stderr to show is a
              // structural difference (a whole extra clause), not just a
              // data difference -- variant, two branches.
              if (probe.output) {
                checks.push(
                  diagFail(
                    "server.jreWorks",
                    "Bundled JRE failed to run",
                    `java -version did not succeed: ${reason}. Output: ${probe.output}`,
                    {
                      category: "server",
                      hint: "Re-run SteamCMD to reinstall the JRE, or ensure the bundled libraries are present alongside the binary.",
                      params: { reason, output: probe.output },
                      variant: "withOutput",
                    },
                  ),
                );
              } else {
                checks.push(
                  diagFail(
                    "server.jreWorks",
                    "Bundled JRE failed to run",
                    `java -version did not succeed: ${reason}.`,
                    {
                      category: "server",
                      hint: "Re-run SteamCMD to reinstall the JRE, or ensure the bundled libraries are present alongside the binary.",
                      params: { reason },
                      variant: "withoutOutput",
                    },
                  ),
                );
              }
            }
          }
        }
      }
    } catch (e) {
      const reason = e?.message || "unknown";
      checks.push(
        diagWarn(
          "server.error",
          "Server checks errored",
          `Some active-server checks could not run: ${reason}`,
          { category: "server", params: { reason } },
        ),
      );
    }

    // ─── PanelBridge IPC ──────────────────────────────────────────────
    try {
      {
        const bridgeStatus = panelBridgeService?.getStatus?.() || null;
        if (!bridgeStatus?.configured) {
          checks.push(
            diagSkip(
              "bridge.configured",
              "PanelBridge bridge path",
              "Bridge path not yet configured (server may be starting up).",
              { category: "bridge" },
            ),
          );
        } else {
          checks.push(
            diagOk(
              "bridge.configured",
              "Bridge path configured",
              "Bridge IPC directory is set.",
              { category: "bridge" },
            ),
          );

          const bridgePath = bridgeStatus.bridgePath;
          if (await safePathWritable(bridgePath)) {
            checks.push(
              diagOk(
                "bridge.writable",
                "Bridge directory writable",
                "Panel can write commands.json for the mod.",
                { category: "bridge" },
              ),
            );
          } else if (!(await safePathExists(bridgePath))) {
            checks.push(
              diagWarn(
                "bridge.writable",
                "Bridge directory missing",
                "Bridge folder does not exist yet — it will be created when the mod first writes status.json.",
                { category: "bridge" },
              ),
            );
          } else if (process.platform === "linux") {
            checks.push(
              diagFail(
                "bridge.writable",
                "Bridge directory not writable",
                "Panel can't write to the bridge directory. Mod won't receive commands.",
                {
                  category: "bridge",
                  hint: "Check ownership / chmod on the Zomboid Lua folder (often needs the panel user to own ~/Zomboid)",
                  variant: "linux",
                },
              ),
            );
          } else {
            checks.push(
              diagFail(
                "bridge.writable",
                "Bridge directory not writable",
                "Panel can't write to the bridge directory. Mod won't receive commands.",
                {
                  category: "bridge",
                  hint: "Check filesystem permissions on the Lua write folder",
                  variant: "other",
                },
              ),
            );
          }

          const status = bridgeStatus.modStatus;
          const conn = bridgeStatus.connection;
          if (status?.alive) {
            const ageText = fmtAge(status.age || 0);
            checks.push(
              diagOk(
                "bridge.heartbeat",
                "Mod heartbeat fresh",
                `Status from mod ${ageText}.`,
                { category: "bridge", params: { age: ageText } },
              ),
            );
          } else if (serverRunning === null) {
            checks.push(
              diagSkip(
                "bridge.heartbeat",
                "Mod heartbeat",
                "Server process state is unknown — heartbeat status cannot be inferred from it.",
                { category: "bridge" },
              ),
            );
          } else if (serverRunning === false) {
            checks.push(
              diagSkip(
                "bridge.heartbeat",
                "Mod heartbeat",
                "Server is offline — heartbeat resumes when it starts.",
                { category: "bridge" },
              ),
            );
          } else if (conn?.statusFile?.exists) {
            // Two distinct "fail" scenarios (stale vs never-written) with
            // different messages -- variant, same discipline as db.backup's
            // four-way warn fan-out in batch 3.
            const ageText = fmtAge(conn.statusFile.age || 0);
            checks.push(
              diagFail(
                "bridge.heartbeat",
                "Mod heartbeat stale",
                `Last heartbeat ${ageText}. Mod may have crashed or be unloaded.`,
                {
                  category: "bridge",
                  hint: "Check server console.txt for PanelBridge errors",
                  params: { age: ageText },
                  variant: "stale",
                },
              ),
            );
          } else {
            checks.push(
              diagFail(
                "bridge.heartbeat",
                "No mod heartbeat",
                "status.json has never been written. Mod is not loaded on the server.",
                {
                  category: "bridge",
                  hint: "Verify PanelBridge is in the server's mod list and Workshop subscription",
                  variant: "never",
                },
              ),
            );
          }
        }
      }
    } catch (e) {
      const reason = e?.message || "unknown";
      checks.push(
        diagWarn(
          "bridge.error",
          "Bridge checks errored",
          `Bridge IPC checks could not run: ${reason}`,
          { category: "bridge", params: { reason } },
        ),
      );
    }

    // ─── Storage & Database ────────────────────────────────────────────
    try {
      const exists = await safePathExists(paths.dbPath);
      if (!exists) {
        checks.push(
          diagFail(
            "db.exists",
            "Database file missing",
            "data/db.json does not exist. Panel cannot persist any settings.",
            { category: "storage" },
          ),
        );
      } else if (!(await safePathWritable(paths.dbPath))) {
        // hint's content genuinely differs by platform (a real command vs a
        // generic phrase) -- variant, not params; message is identical
        // either way, so it's written once per variant rather than shared.
        if (process.platform === "linux") {
          checks.push(
            diagFail(
              "db.writable",
              "Database not writable",
              "db.json exists but is read-only. Settings changes will fail.",
              {
                category: "storage",
                hint: "Run: chmod u+w data/db.json (and check the data/ directory is owned by the panel user)",
                variant: "linux",
              },
            ),
          );
        } else {
          checks.push(
            diagFail(
              "db.writable",
              "Database not writable",
              "db.json exists but is read-only. Settings changes will fail.",
              {
                category: "storage",
                hint: "Check file permissions on data/db.json",
                variant: "other",
              },
            ),
          );
        }
      } else {
        checks.push(
          diagOk(
            "db.writable",
            "Database accessible",
            // dbStats.collections is a { name: count } map, not an array --
            // .length was always undefined, and .size was never a field on
            // this object at all (it's fileSizeBytes) -- so this check was
            // structurally incapable of ever printing anything but "?
            // collections, 0 MB", on the one screen whose whole purpose is
            // being trustworthy about the panel's own state.
            formatDbAccessibleMessage(dbStats),
            {
              category: "storage",
              params: {
                count: dbStats ? Object.keys(dbStats.collections).length : "?",
                size: fmtMB(dbStats?.fileSizeBytes),
              },
            },
          ),
        );
      }
    } catch (e) {
      const reason = e?.message || "unknown error";
      checks.push(
        diagWarn(
          "db.exists",
          "Database check failed",
          `Could not inspect db.json: ${reason}`,
          { category: "storage", params: { reason } },
        ),
      );
    }

    try {
      const backupsDir = path.join(paths.dataDir, "backups");
      if (await safePathExists(backupsDir)) {
        const files = await safeReaddir(backupsDir);
        if (!files) {
          // Same "warn" status as the unreadable-directory catch below and
          // the no-backups/old-backup branches further down -- four
          // genuinely different sentences under one id+status, so each
          // gets its own variant rather than colliding at one locale key.
          checks.push(
            diagWarn(
              "db.backup",
              "Backup status unknown",
              "Could not read the backup directory (timeout or permission denied).",
              { category: "storage", variant: "unreadable" },
            ),
          );
        } else {
          const stats = await Promise.all(
            files
              .filter((f) => f.endsWith(".json"))
              .map(async (f) => {
                const st = await safeStat(path.join(backupsDir, f));
                return st ? st.mtimeMs : 0;
              }),
          );
          const newest = stats.length > 0 ? Math.max(...stats) : 0;
          const age = newest ? Date.now() - newest : Infinity;
          if (!newest) {
            checks.push(
              diagWarn(
                "db.backup",
                "No database backups",
                "No db.json backups found. Manual backup recommended before risky changes.",
                {
                  category: "storage",
                  hint: "Debug → Database → Create Backup",
                  variant: "none",
                },
              ),
            );
          } else if (age < 24 * 3600_000) {
            const ageText = fmtAge(age);
            checks.push(
              diagOk(
                "db.backup",
                "Database backup recent",
                `Newest backup ${ageText}.`,
                { category: "storage", params: { age: ageText } },
              ),
            );
          } else {
            const ageText = fmtAge(age);
            checks.push(
              diagWarn(
                "db.backup",
                "Database backup old",
                `Newest backup ${ageText}. Consider creating a fresh one.`,
                {
                  category: "storage",
                  hint: "Debug → Database → Create Backup",
                  params: { age: ageText },
                  variant: "old",
                },
              ),
            );
          }
        }
      } else {
        checks.push(
          diagInfo(
            "db.backup",
            "Backup directory not yet created",
            "Will be created on first backup.",
            { category: "storage" },
          ),
        );
      }
    } catch (e) {
      const reason = e?.message || "unknown error";
      checks.push(
        diagWarn(
          "db.backup",
          "Backup status unknown",
          `Could not inspect backups: ${reason}`,
          { category: "storage", params: { reason }, variant: "error" },
        ),
      );
    }

    try {
      if (await safePathWritable(paths.logsDir)) {
        checks.push(
          diagOk(
            "logs.writable",
            "Logs directory writable",
            "Panel can write logs.",
            { category: "storage" },
          ),
        );
      } else {
        checks.push(
          diagFail(
            "logs.writable",
            "Logs directory not writable",
            "Cannot write to logs folder — log capture and downloads will fail.",
            { category: "storage" },
          ),
        );
      }

      {
        const disk = await getDiskFree(paths.dataDir);
        if (!disk) {
          checks.push(
            diagSkip(
              "disk.free",
              "Disk space",
              "Free space check not supported on this platform.",
              { category: "storage" },
            ),
          );
        } else if (disk.free < 500 * 1024 * 1024) {
          const freeText = fmtGB(disk.free);
          const totalText = fmtGB(disk.total);
          checks.push(
            diagFail(
              "disk.free",
              "Disk almost full",
              `Only ${freeText} free of ${totalText} on data drive.`,
              {
                category: "storage",
                hint: "Free up disk space — saves and backups will fail",
                params: { free: freeText, total: totalText },
              },
            ),
          );
        } else if (disk.free < 5 * 1024 * 1024 * 1024) {
          const freeText = fmtGB(disk.free);
          const totalText = fmtGB(disk.total);
          checks.push(
            diagWarn(
              "disk.free",
              "Low disk space",
              `${freeText} free of ${totalText} on data drive.`,
              { category: "storage", params: { free: freeText, total: totalText } },
            ),
          );
        } else {
          const freeText = fmtGB(disk.free);
          const totalText = fmtGB(disk.total);
          checks.push(
            diagOk(
              "disk.free",
              "Disk space healthy",
              `${freeText} free of ${totalText}.`,
              { category: "storage", params: { free: freeText, total: totalText } },
            ),
          );
        }
      }

      // Save folder size + chunk count. Computed in the active-server block
      // and stashed on req for us so we don't walk the tree twice.
      {
        const ss = req._diagSaveStats;
        if (ss) {
          const sizeGb = ss.totalBytes / 1024 / 1024 / 1024;
          const summary =
            `${fmtGB(ss.totalBytes)} across ${ss.chunks.toLocaleString()} chunk${ss.chunks === 1 ? "" : "s"}` +
            (ss.truncated ? " (scan truncated)" : "");
          const meta = {
            totalBytes: ss.totalBytes,
            chunks: ss.chunks,
            truncated: ss.truncated,
            saveDir: ss.saveDirUsed,
          };
          // Same three params for all three statuses below -- "chunk(s)"
          // follows this codebase's existing count-suffix convention (see
          // errors.json's ROLE_HAS_MEMBERS) rather than real i18next
          // pluralization; truncatedSuffix is "" when not truncated, a
          // valid param value (present, just empty), not treated as missing.
          const sizeParams = {
            size: fmtGB(ss.totalBytes),
            chunks: ss.chunks.toLocaleString(),
            truncatedSuffix: ss.truncated ? " (scan truncated)" : "",
          };
          if (sizeGb > 30) {
            checks.push(
              diagWarn(
                "storage.saveSize",
                "Save folder very large",
                `${summary}. Backups, restores, and chunk cleanups will be slow.`,
                {
                  category: "storage",
                  hint: "Run the Chunk Cleaner to trim unloaded cells, or archive old saves.",
                  meta,
                  params: sizeParams,
                },
              ),
            );
          } else if (sizeGb > 10) {
            checks.push(
              diagInfo("storage.saveSize", "Save folder large", `${summary}.`, {
                category: "storage",
                meta,
                params: sizeParams,
              }),
            );
          } else {
            checks.push(
              diagOk("storage.saveSize", "Save folder healthy", `${summary}.`, {
                category: "storage",
                meta,
                params: sizeParams,
              }),
            );
          }
        }
      }
    } catch (e) {
      const reason = e?.message || "unknown";
      checks.push(
        diagWarn(
          "storage.error",
          "Storage checks errored",
          `Logs/disk checks could not run: ${reason}`,
          { category: "storage", params: { reason } },
        ),
      );
    }

    // ─── Runtime ───────────────────────────────────────────────────────
    try {
      {
        const mem = process.memoryUsage();
        // heapTotal is just the size of the V8 segment currently allocated —
        // it grows on demand (in chunks) as heapUsed approaches it, so
        // heapUsed/heapTotal routinely sits at 80-95% under completely
        // normal, healthy operation (most visible right after startup or
        // under light load, before V8 has needed to grow the segment much).
        // That ratio was previously used directly as the health-check
        // percentage, which fired constant false "heap usage high/critical"
        // warnings unrelated to actual memory pressure. The only ratio that
        // means anything is heapUsed against the real ceiling — V8's actual
        // configured heap_size_limit (what --max-old-space-size controls,
        // several GB by default) — since that's the number that matters for
        // "is this process actually at risk of an out-of-memory crash".
        const heapLimit = v8.getHeapStatistics().heap_size_limit;
        const heapPct = heapLimit > 0 ? (mem.heapUsed / heapLimit) * 100 : 0;
        const detail = `${fmtMB(mem.heapUsed)} used of ${fmtMB(heapLimit)} limit (${fmtMB(mem.heapTotal)} currently allocated).`;
        // "detail" embeds English words ("used of", "limit", "currently
        // allocated") -- passing it as one opaque param would leave that
        // English fragment inside translated text. Broken into its three
        // numbers instead so the whole sentence is real French.
        const heapParams = {
          pct: heapPct.toFixed(0),
          heapUsed: fmtMB(mem.heapUsed),
          heapLimit: fmtMB(heapLimit),
          heapTotal: fmtMB(mem.heapTotal),
        };
        if (heapPct >= 90) {
          checks.push(
            diagFail(
              "runtime.heap",
              "Heap usage critical",
              `Heap at ${heapPct.toFixed(0)}% of its limit. ${detail} Restart recommended.`,
              { category: "runtime", params: heapParams },
            ),
          );
        } else if (heapPct >= 75) {
          checks.push(
            diagWarn(
              "runtime.heap",
              "Heap usage high",
              `Heap at ${heapPct.toFixed(0)}% of its limit. ${detail}`,
              { category: "runtime", params: heapParams },
            ),
          );
        } else {
          checks.push(
            diagOk(
              "runtime.heap",
              "Heap usage healthy",
              `${heapPct.toFixed(0)}% of limit. ${detail}`,
              { category: "runtime", params: heapParams },
            ),
          );
        }

        const totalHostMem = os.totalmem();
        const freeHostMem = os.freemem();
        const usedPct = ((totalHostMem - freeHostMem) / totalHostMem) * 100;
        if (freeHostMem < 256 * 1024 * 1024) {
          checks.push(
            diagFail(
              "runtime.hostMem",
              "Host RAM exhausted",
              `Only ${fmtMB(freeHostMem)} free of ${fmtGB(totalHostMem)}. Server may crash.`,
              { category: "runtime", params: { free: fmtMB(freeHostMem), total: fmtGB(totalHostMem) } },
            ),
          );
        } else if (usedPct > 90) {
          checks.push(
            diagWarn(
              "runtime.hostMem",
              "Host RAM pressure",
              `${usedPct.toFixed(0)}% used (${fmtGB(totalHostMem - freeHostMem)} / ${fmtGB(totalHostMem)}).`,
              {
                category: "runtime",
                params: {
                  pct: usedPct.toFixed(0),
                  used: fmtGB(totalHostMem - freeHostMem),
                  total: fmtGB(totalHostMem),
                },
              },
            ),
          );
        } else {
          checks.push(
            diagOk(
              "runtime.hostMem",
              "Host RAM healthy",
              `${usedPct.toFixed(0)}% used of ${fmtGB(totalHostMem)}.`,
              { category: "runtime", params: { pct: usedPct.toFixed(0), total: fmtGB(totalHostMem) } },
            ),
          );
        }

        const uptimeText = fmtAge(process.uptime() * 1000).replace(" ago", "");
        checks.push(
          diagInfo(
            "runtime.uptime",
            "Panel uptime",
            `${uptimeText}.`,
            { category: "runtime", params: { uptime: uptimeText } },
          ),
        );
      }
    } catch (e) {
      const reason = e?.message || "unknown";
      checks.push(
        diagWarn(
          "runtime.error",
          "Runtime checks errored",
          `Memory/uptime checks could not run: ${reason}`,
          { category: "runtime", params: { reason } },
        ),
      );
    }

    // ─── Updates ───────────────────────────────────────────────────────
    // Steam Workshop API probe is needed by both update.steamApi and the
    // host-clock check (we read its Date response header). Compute once.
    const steamProbe = await withTimeout(probeSteamWorkshopApi(), 6000, {
      reachable: false,
      error: "timeout",
    });
    try {
      if (steamProbe.reachable) {
        checks.push(
          diagOk(
            "update.steamApi",
            "Steam Workshop API reachable",
            `api.steampowered.com responded in ${steamProbe.latencyMs} ms (HTTP ${steamProbe.statusCode}).`,
            {
              category: "updates",
              params: { latencyMs: steamProbe.latencyMs, statusCode: steamProbe.statusCode },
            },
          ),
        );
      } else {
        const reason = steamProbe.error || `HTTP ${steamProbe.statusCode}`;
        checks.push(
          diagWarn(
            "update.steamApi",
            "Steam Workshop API unreachable",
            `Could not reach api.steampowered.com (${reason}). Mod-update polling and the Workshop crash detector will both go blind.`,
            {
              category: "updates",
              hint: "Check the panel host's outbound HTTPS access.",
              params: { reason },
            },
          ),
        );
      }

      // Host-clock skew vs Steam's server-side time. Cron-scheduled tasks
      // depend on the local clock being correct; mod publish timestamps too.
      if (steamProbe.serverTime) {
        const skewMs = steamProbe.localTime - steamProbe.serverTime;
        const absSkew = Math.abs(skewMs);
        const direction = skewMs > 0 ? "ahead" : "behind";
        const fmt =
          absSkew < 60000
            ? `${Math.round(absSkew / 1000)}s`
            : `${Math.round(absSkew / 60000)}m`;
        if (absSkew >= 5 * 60 * 1000) {
          // Two independent axes -- which way the clock is off, and which
          // platform's fix instructions apply -- need four literal-variant
          // branches, not a template-built "`${direction}_${platform}`"
          // string: that would be exactly the same invisible-to-static-scan
          // problem as a ternary variant, just spelled differently. Message
          // itself only needs `skew` as a param; the direction word is part
          // of each variant's own pre-written sentence, not substituted, so
          // French can phrase "en avance sur"/"en retard sur" naturally
          // instead of forcing one template to accept either.
          const isLinuxPlatform = process.platform === "linux";
          const failMessage = `Panel host clock is ${fmt} ${direction} of Steam time. Scheduled tasks will fire at the wrong wall-clock time and HTTPS handshakes may fail.`;
          if (direction === "ahead" && isLinuxPlatform) {
            checks.push(
              diagFail("runtime.timeSkew", "Host clock is wrong", failMessage, {
                category: "runtime",
                hint: "Run: sudo timedatectl set-ntp true",
                meta: { skewMs },
                params: { skew: fmt },
                variant: "ahead_linux",
              }),
            );
          } else if (direction === "ahead") {
            checks.push(
              diagFail("runtime.timeSkew", "Host clock is wrong", failMessage, {
                category: "runtime",
                hint: "Settings → Date & Time → Set time automatically",
                meta: { skewMs },
                params: { skew: fmt },
                variant: "ahead_other",
              }),
            );
          } else if (isLinuxPlatform) {
            checks.push(
              diagFail("runtime.timeSkew", "Host clock is wrong", failMessage, {
                category: "runtime",
                hint: "Run: sudo timedatectl set-ntp true",
                meta: { skewMs },
                params: { skew: fmt },
                variant: "behind_linux",
              }),
            );
          } else {
            checks.push(
              diagFail("runtime.timeSkew", "Host clock is wrong", failMessage, {
                category: "runtime",
                hint: "Settings → Date & Time → Set time automatically",
                meta: { skewMs },
                params: { skew: fmt },
                variant: "behind_other",
              }),
            );
          }
        } else if (absSkew >= 30 * 1000) {
          const warnMessage = `Panel host clock is ${fmt} ${direction} of Steam time.`;
          if (direction === "ahead") {
            checks.push(
              diagWarn("runtime.timeSkew", "Host clock slightly off", warnMessage, {
                category: "runtime",
                meta: { skewMs },
                params: { skew: fmt },
                variant: "ahead",
              }),
            );
          } else {
            checks.push(
              diagWarn("runtime.timeSkew", "Host clock slightly off", warnMessage, {
                category: "runtime",
                meta: { skewMs },
                params: { skew: fmt },
                variant: "behind",
              }),
            );
          }
        } else {
          checks.push(
            diagOk(
              "runtime.timeSkew",
              "Host clock in sync",
              `Within ${fmt} of Steam time.`,
              { category: "runtime", meta: { skewMs }, params: { skew: fmt } },
            ),
          );
        }
      }

      if (panelUpdateChecker?.updateAvailable) {
        const latest =
          panelUpdateChecker.latestRelease?.tag_name ||
          panelUpdateChecker.latestRelease?.name ||
          "newer version";
        const currentVersion = panelUpdateChecker.currentVersion || "?";
        checks.push(
          diagInfo(
            "update.panel",
            "Panel update available",
            `${latest} is newer than your installed v${currentVersion}.`,
            {
              category: "updates",
              hint: "Settings → Updates",
              params: { latest, version: currentVersion },
            },
          ),
        );
      } else if (panelUpdateChecker) {
        const currentVersion = panelUpdateChecker.currentVersion || "?";
        checks.push(
          diagOk(
            "update.panel",
            "Panel up to date",
            `Running v${currentVersion}.`,
            { category: "updates", params: { version: currentVersion } },
          ),
        );
      }

      {
        const outdated = (trackedMods || []).filter(
          (m) => m.updateAvailable,
        ).length;
        if (outdated > 0) {
          checks.push(
            diagInfo(
              "update.mods",
              "Mod updates available",
              `${outdated} mod${outdated === 1 ? "" : "s"} have updates on Steam Workshop.`,
              { category: "updates", hint: "Mods → Update Subscriptions", params: { count: outdated } },
            ),
          );
        } else if ((trackedMods || []).length > 0) {
          checks.push(
            diagOk(
              "update.mods",
              "All mods current",
              `${trackedMods.length} tracked, none flagged for update.`,
              { category: "updates", params: { count: trackedMods.length } },
            ),
          );
        }
      }
    } catch (e) {
      const reason = e?.message || "unknown";
      checks.push(
        diagWarn(
          "updates.error",
          "Update checks errored",
          `Update checks could not run: ${reason}`,
          { category: "updates", params: { reason } },
        ),
      );
    }

    // ─── Aggregate ─────────────────────────────────────────────────────
    const summary = { ok: 0, warn: 0, fail: 0, info: 0, skip: 0 };
    for (const c of checks) summary[c.status] = (summary[c.status] || 0) + 1;
    const overall =
      summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "ok";

    // Every check's optional `params` (interpolation data for the client's
    // translated version of `message`/`label`/`hint` — see
    // client/src/lib/diagnosticsTranslation.ts) goes through the same
    // path-redaction as any other error param before it leaves the server.
    const sanitizedChecks = checks.map((c) =>
      c.params ? { ...c, params: sanitizeErrorParams(c.params) } : c,
    );

    res.json({
      timestamp: new Date().toISOString(),
      overall,
      summary,
      categories: DIAG_CATEGORIES,
      checks: sanitizedChecks,
      durationMs: Date.now() - t0,
    });
  } catch (error) {
    log.error(`Diagnostics failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ─── World Map Diagnostics ───────────────────────────────────────────
// Dedicated checks for everything the World Map page depends on:
// tile CDNs (tiles.pzmap.org), PanelBridge handlers
// for live player/vehicle/safehouse data, save folder layout (B41 vs B42),
// and the local /api/map proxy itself.
const TILE_PROBE_TIMEOUT_MS = 5000;
const WORLDMAP_HANDLERS = [
  "getServerInfo",
  "getVehiclesDetailed",
  "getSafehouses",
  "triggerAirdrop",
];

async function probeTile(url) {
  const t0 = Date.now();
  try {
    const ctrl = AbortSignal.timeout(TILE_PROBE_TIMEOUT_MS);
    // HEAD avoids transferring the full image. Some CDNs reject HEAD —
    // fall back to a ranged GET for the first byte.
    let resp = await fetch(url, { method: "HEAD", signal: ctrl }).catch(
      () => null,
    );
    if (!resp || !resp.ok) {
      resp = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        signal: AbortSignal.timeout(TILE_PROBE_TIMEOUT_MS),
      });
    }
    return {
      url,
      reachable: resp.ok || resp.status === 206,
      statusCode: resp.status,
      latencyMs: Date.now() - t0,
      error: null,
    };
  } catch (e) {
    return {
      url,
      reachable: false,
      statusCode: null,
      latencyMs: Date.now() - t0,
      error: e?.name === "TimeoutError" ? "timeout" : e?.message || "unknown",
    };
  }
}

async function detectSaveBuild(savePath) {
  // B42 stores chunks as map/X/Y.bin, B41 stores them as map_X_Y.bin in the save root.
  if (!(await safePathExists(savePath))) return "unknown";
  const mapDir = path.join(savePath, "map");
  if (await safePathExists(mapDir)) {
    const entries = await safeReaddir(mapDir);
    if (entries && entries.some((e) => /^\d+$/.test(e))) return "b42";
  }
  const rootEntries = await safeReaddir(savePath);
  if (rootEntries && rootEntries.some((e) => /^map_\d+_\d+\.bin$/.test(e)))
    return "b41";
  return "unknown";
}

// Turns a scanSaveStats() result into the server.staleLocks diagnostics
// check (or null, when there's nothing to report). Kept as a standalone,
// module-level function (not inlined at its call site above, and NOT moved
// up near scanSaveStats itself) so this decision -- fail on a confirmed
// finding, warn honestly when the scan couldn't finish, stay silent only
// when it actually confirmed the save is clean -- can be unit tested
// directly (see server/tests/scanSaveStatsDeadline.test.js), while still
// living inside the GET /diagnostics-to-GET /worldmap textual range that
// server/tests/diagnosticsCheckRegistry.test.js scans for
// diagOk/Fail/Warn/Skip/Info calls to enforce locale coverage -- a call
// site outside that range is invisible to it. (Deliberately not spelling
// out that route-registration literal here, so this comment itself can't
// be mistaken by that test's own indexOf() scan for the boundary it's
// looking for -- exactly the bug this comment used to cause.)
function buildStaleLocksCheck(saveStats, saveDirUsed) {
  if (saveStats && saveStats.staleLocks.length > 0) {
    return diagFail(
      "server.staleLocks",
      "Stale lock files in save folder",
      `${saveStats.staleLocks.length} .lock file${saveStats.staleLocks.length === 1 ? "" : "s"} older than 1 hour in ${saveDirUsed}. PZ will refuse to load the save until they are removed.`,
      {
        category: "server",
        hint: "Stop the server, delete every *.lock file under the save folder, then restart.",
        meta: { staleLocks: saveStats.staleLocks.slice(0, 10) },
        // NOTE (flagged to god, not inherited by accident): `dir` is the
        // save folder's absolute path. The English fallback `message`
        // above already ships it unredacted (message/label/hint were never
        // sanitized, only `params` is) -- but sanitizeErrorParams() WILL
        // redact this specific param to "[path]" before a French client
        // ever sees it, since it's an absolute path. Net effect: French
        // users see strictly less detail here than English users for this
        // one check (a translation-richness gap, not a new security
        // exposure -- English was already unredacted).
        params: { count: saveStats.staleLocks.length, dir: saveDirUsed },
      },
    );
  }
  if (saveDirUsed && (!saveStats || saveStats.truncated)) {
    // The check could not finish (raced away by the outer timeout, or
    // self-truncated at MAX_FILES/the wall-clock budget) -- report that
    // honestly instead of silently omitting the check. A blank space here
    // previously meant "confirmed clean" and "gave up looking" identically;
    // they are not the same finding.
    return diagWarn(
      "server.staleLocks",
      "Could not fully check for stale lock files",
      `${saveDirUsed} is too large to fully scan for stale lock files within the diagnostics time budget. Stale lock files may be present but undetected.`,
      {
        category: "server",
        hint: "Run \"Delete stale lock files\" to scan and clear in one pass -- it gets a much larger time budget than this automatic check -- or check the save folder manually if the server won't boot.",
        params: { dir: saveDirUsed },
      },
    );
  }
  return null;
}

router.get("/worldmap", requirePermission("diagnostics.manage"), async (req, res) => {
  const t0 = Date.now();
  const checks = [];

  try {
    // Gather context with the same hard timeout we use for /diagnostics.
    const [activeServer] = await Promise.all([
      withTimeout(
        getActiveServer().catch(() => null),
        FS_TIMEOUT_MS,
        null,
      ),
    ]);

    if (!activeServer) {
      checks.push(
        diagWarn(
          "worldmap.activeServer",
          "No active server",
          "No server is currently active in the panel. The map will load tiles but cannot show players, vehicles, or safehouses.",
          {
            category: "worldmap",
            hint: "Servers → select one and click “Set active”.",
          },
        ),
      );
    }

    // ─── Tile sources ─────────────────────────────────────────────────
    // Probe the build and format the proxy actually resolves. A hardcoded
    // build/extension can report "reachable" while every real tile request
    // 404s, which is exactly how the top-down map broke silently.
    let b42Probe = null;
    let b41Probe = null;
    let b42TopProbe = null;
    let b42Dir = null;
    let b42TopFormat = null;
    try {
      b42Dir = await getB42Dir().catch(() => null);
      b42TopFormat = b42Dir ? await getB42TopFormat(b42Dir).catch(() => null) : null;

      // Build auto-detect can fail while tile serving still looks healthy: the
      // hardcoded fallback directory happens to match the live build today, so
      // a plain tile probe below would report "reachable" even though
      // discovery itself is dead and will silently pin the panel to an old
      // build the moment PZ ships a new one. Report on discovery itself,
      // separately from whether tiles for whatever build we landed on load.
      // Two states: getB42ResolutionStatus().source is 'dynamic' (the panel
      // resolved it from upstream itself) or 'fallback' (nobody resolved it;
      // the hardcoded build is in use, and this is the state that goes stale
      // silently -- see the warn branch). A third 'client' state (the
      // browser resolving what the panel couldn't) was investigated and
      // cancelled -- upstream sends no CORS headers on one host and
      // inconsistent bot-challenge behavior on the other, so it could not be
      // demonstrated to work. Do not resurrect it without new evidence.
      const resolution = getB42ResolutionStatus();
      if (resolution.source === "dynamic") {
        checks.push(
          diagOk(
            "worldmap.tiles.buildDetect",
            "B42 build auto-detect healthy",
            `Build ${resolution.directory} was resolved dynamically from build_list.json.`,
            {
              category: "worldmap",
              // Resolution goes through curl now (Node's fetch and https
              // share one blocked TLS stack) and only succeeds with a
              // realistic browser user-agent -- a generic or missing one
              // gets a 403. That's an upstream heuristic this panel does
              // not control and two independent checks tonight found it
              // behaving inconsistently across identical requests, so this
              // is "working right now", not a permanent fix.
              hint: "Resolution depends on an upstream bot-detection heuristic outside the panel's control, which has been observed responding inconsistently to identical requests. Treat this as working right now, not permanently solved -- it can start failing again with no change on the panel's side.",
              // i18n param key stays `build` (reads better in the message
              // template) even though the source property is `directory`.
              params: { build: resolution.directory },
            },
          ),
        );
      } else {
        // 'fallback', or any value outside the current contract -- treat as
        // the failure state rather than as healthy.
        checks.push(
          diagWarn(
            "worldmap.tiles.buildDetect",
            "B42 build auto-detect failed",
            `Using hardcoded build ${resolution.directory} because discovery failed: ${resolution.reason || "unknown reason"}. This will not track the next PZ map build until discovery starts working again.`,
            {
              category: "worldmap",
              hint: "Discovery reads build_list.json and each candidate's layer0.dzi from tiles.pzmap.org. If upstream is blocking the panel's requests specifically (e.g. bot protection keyed on the HTTP client), this may not be fixable from the panel side — watch for this warning after the next PZ map release, since that's when a stale build actually shows up as wrong map geometry.",
              params: { build: resolution.directory, reason: resolution.reason || "unknown reason" },
            },
          ),
        );
      }

      [b42Probe, b41Probe, b42TopProbe] = await Promise.all([
        probeTile(
          `${PZ_TILES_ROOT}/${b42Dir || "42.19.0"}/base/layer0_files/0/0_0.jpg`,
        ),
        probeTile(
          `${PZ_TILES_ROOT}/41.78.16/base/layer0_files/0/0_0.jpg`,
        ),
        b42Dir && b42TopFormat
          ? probeTile(
              `${PZ_TILES_ROOT}/${b42Dir}/base_top/layer0_files/10/0_0.${b42TopFormat}`,
            )
          : Promise.resolve(null),
      ]);

      if (b42Probe.reachable) {
        checks.push(
          diagOk(
            "worldmap.tiles.b42",
            "B42 tile CDN reachable",
            `Build ${b42Dir || "42.19.0"} responded in ${b42Probe.latencyMs} ms (HTTP ${b42Probe.statusCode}).`,
            {
              category: "worldmap",
              params: {
                build: b42Dir || "42.19.0",
                latencyMs: b42Probe.latencyMs,
                statusCode: b42Probe.statusCode,
              },
            },
          ),
        );
      } else {
        checks.push(
          diagFail(
            "worldmap.tiles.b42",
            "B42 tile CDN unreachable",
            `Could not reach tiles.pzmap.org for B42 tiles (${b42Probe.error || `HTTP ${b42Probe.statusCode}`}). The B42 base map will not load.`,
            {
              category: "worldmap",
              hint: "Check the panel host's outbound HTTPS access. The /api/map/tiles proxy fetches tiles server-side.",
              params: { detail: b42Probe.error || `HTTP ${b42Probe.statusCode}` },
            },
          ),
        );
      }

      if (b41Probe.reachable) {
        checks.push(
          diagOk(
            "worldmap.tiles.b41",
            "B41 tile CDN reachable",
            `tiles.pzmap.org responded in ${b41Probe.latencyMs} ms (HTTP ${b41Probe.statusCode}).`,
            {
              category: "worldmap",
              params: { latencyMs: b41Probe.latencyMs, statusCode: b41Probe.statusCode },
            },
          ),
        );
      } else {
        checks.push(
          diagWarn(
            "worldmap.tiles.b41",
            "B41 tile CDN unreachable",
            `Could not reach tiles.pzmap.org (${b41Probe.error || `HTTP ${b41Probe.statusCode}`}). B41 fallback tiles will not load.`,
            {
              category: "worldmap",
              hint: "Only relevant if you run a B41 server. Outbound HTTPS to tiles.pzmap.org is required.",
              params: { detail: b41Probe.error || `HTTP ${b41Probe.statusCode}` },
            },
          ),
        );
      }

      // The Chunk Cleaner uses the top-down render, which is published
      // separately from the isometric base and has changed image format
      // between builds. Probe it explicitly so a format/build mismatch is
      // reported instead of showing an empty map.
      if (b42TopProbe && b42TopProbe.reachable) {
        checks.push(
          diagOk(
            "worldmap.tiles.b42Top",
            "B42 top-down tiles reachable",
            `Build ${b42Dir} serves .${b42TopFormat} top-down tiles (HTTP ${b42TopProbe.statusCode}, ${b42TopProbe.latencyMs} ms).`,
            {
              category: "worldmap",
              params: {
                build: b42Dir,
                format: b42TopFormat,
                statusCode: b42TopProbe.statusCode,
                latencyMs: b42TopProbe.latencyMs,
              },
            },
          ),
        );
      } else if (b42TopProbe) {
        checks.push(
          diagFail(
            "worldmap.tiles.b42Top",
            "B42 top-down tiles unavailable",
            `Build ${b42Dir} did not serve a .${b42TopFormat} top-down tile (${b42TopProbe.error || `HTTP ${b42TopProbe.statusCode}`}). The Map Cleanup page will show chunks with no base map.`,
            {
              category: "worldmap",
              hint: "Upstream may have republished this build in a different image format. Re-run diagnostics after a few minutes; the panel re-reads the format from base_top/layer0.dzi every 24h or on restart.",
              params: {
                build: b42Dir,
                format: b42TopFormat,
                detail: b42TopProbe.error || `HTTP ${b42TopProbe.statusCode}`,
              },
            },
          ),
        );
      } else {
        checks.push(
          diagWarn(
            "worldmap.tiles.b42Top",
            "B42 top-down format unresolved",
            "Could not read base_top/layer0.dzi to determine the top-down tile format.",
            {
              category: "worldmap",
              hint: "Check outbound HTTPS access from the panel host.",
            },
          ),
        );
      }

      // Node 18+ AbortSignal.timeout availability
      if (
        typeof AbortSignal === "undefined" ||
        typeof AbortSignal.timeout !== "function"
      ) {
        checks.push(
          diagFail(
            "worldmap.runtime",
            "Tile proxy needs Node 18+",
            "AbortSignal.timeout is unavailable on this runtime. Every tile fetch will throw and return 502.",
            {
              category: "worldmap",
              hint: "Upgrade the panel host to Node 18+ (the bundled .exe already ships with this).",
            },
          ),
        );
      }
    } catch (e) {
      const reason = e?.message || "unknown";
      checks.push(
        diagWarn(
          "worldmap.tiles.error",
          "Tile reachability probe failed",
          `Tile probe could not complete: ${reason}`,
          { category: "worldmap", params: { reason } },
        ),
      );
    }

    // ─── PanelBridge live data ────────────────────────────────────────
    const bridgeStatus = panelBridgeService?.getStatus?.() || null;
    const bridgeRunning = !!bridgeStatus?.isRunning;
    // Call the service's own isModConnected() rather than re-deriving it from
    // bridgeStatus.modStatus -- this route used to check object-existence
    // (`!!bridgeStatus?.modStatus`), which is true even for the
    // {alive:false, waiting:true} placeholder handleStatusFailure() creates
    // on the very first failed poll, so it read "connected" forever once a
    // status object existed at all, no matter how many polls kept failing.
    // isModConnected() (`.modStatus?.alive === true`) is already used
    // correctly in five places in server/index.js; this was the one site
    // that reimplemented the check instead of calling the helper.
    const modConnected = panelBridgeService?.isModConnected?.() === true;
    const statusAge = bridgeStatus?.statusFile?.age ?? null;

    if (!bridgeStatus || !bridgeStatus.configured) {
      checks.push(
        diagFail(
          "worldmap.bridge.configured",
          "PanelBridge not configured",
          "The map gets live player positions, vehicles and safehouses from PanelBridge. Without it, the map will show only the static base tiles.",
          {
            category: "worldmap",
            hint: "Configure the active server's Zomboid Data Path so the bridge folder can be located.",
          },
        ),
      );
    } else if (!bridgeRunning) {
      checks.push(
        diagWarn(
          "worldmap.bridge.running",
          "PanelBridge service not running",
          "The bridge service is configured but not currently polling. Live map data will be empty.",
          { category: "worldmap" },
        ),
      );
    } else if (!modConnected) {
      checks.push(
        diagWarn(
          "worldmap.bridge.mod",
          "Mod not connected",
          "PanelBridge is running but the in-game mod has not written status.json yet. Players, vehicles and safehouses will not appear.",
          {
            category: "worldmap",
            hint: "Start the PZ server and confirm the PanelBridge mod is in the active mod list.",
          },
        ),
      );
    } else if (statusAge !== null && statusAge > 15_000) {
      const ageSeconds = Math.round(statusAge / 1000);
      checks.push(
        diagWarn(
          "worldmap.bridge.heartbeat",
          "Mod heartbeat stale",
          `Last status.json update was ${ageSeconds}s ago. Live map data may be stale.`,
          { category: "worldmap", params: { ageSeconds } },
        ),
      );
    } else if (statusAge !== null) {
      // Two genuinely different sentences (a trailing heartbeat-age clause
      // that either exists or doesn't), not a hole to fill in one sentence
      // -- variant, not params. See worldMapCheckRegistry.test.js's header
      // comment for the params-vs-variant rule.
      const ageSeconds = Math.round(statusAge / 1000);
      checks.push(
        diagOk(
          "worldmap.bridge",
          "Live data feed healthy",
          `PanelBridge running, mod connected, last heartbeat ${ageSeconds}s ago.`,
          { category: "worldmap", variant: "withHeartbeat", params: { ageSeconds } },
        ),
      );
    } else {
      checks.push(
        diagOk(
          "worldmap.bridge",
          "Live data feed healthy",
          "PanelBridge running, mod connected.",
          { category: "worldmap", variant: "withoutHeartbeat" },
        ),
      );
    }

    // Verify expected handler list — surfaced in the dedicated UI card,
    // no need to push an info check that inflates the summary count.

    // ─── Server build + active save ───────────────────────────────────
    let saveBuild = "unknown";
    let saveName = null;
    let savePath = null;
    let savesDir = null;
    let saveCount = 0;

    if (activeServer?.zomboidDataPath) {
      // PZ saves live under <zomboidData>/Saves/<gameMode>/<saveName>
      // We don't know which game mode, so just enumerate candidates.
      const savesRoot = path.join(activeServer.zomboidDataPath, "Saves");
      if (await safePathExists(savesRoot)) {
        try {
          const modes = (await safeReaddir(savesRoot)) || [];
          for (const mode of modes) {
            const modeDir = path.join(savesRoot, mode);
            const st = await safeStat(modeDir);
            if (!st || !st.isDirectory()) continue;
            const saves = (await safeReaddir(modeDir)) || [];
            for (const s of saves) {
              const sp = path.join(modeDir, s);
              const sst = await safeStat(sp);
              if (sst && sst.isDirectory()) {
                saveCount++;
                if (!savePath) {
                  savePath = sp;
                  saveName = s;
                  savesDir = modeDir;
                }
              }
            }
          }
        } catch {
          // ignore enumeration errors
        }
      }

      if (saveCount === 0) {
        checks.push(
          diagInfo(
            "worldmap.save.none",
            "No save found yet",
            "No save folder under <zomboidData>/Saves. The server hasn't generated a world yet — the map will still render but without chunk data.",
            { category: "worldmap" },
          ),
        );
      } else {
        if (savePath) {
          saveBuild = await detectSaveBuild(savePath);
        }
        if (saveBuild === "b42") {
          checks.push(
            diagOk(
              "worldmap.save.build",
              "B42 save detected",
              `${saveCount} save(s); using ${saveName} for build detection (map/X/Y.bin layout).`,
              {
                category: "worldmap",
                variant: "b42",
                params: { saveCount, saveName },
              },
            ),
          );
        } else if (saveBuild === "b41") {
          checks.push(
            diagOk(
              "worldmap.save.build",
              "B41 save detected",
              `${saveCount} save(s); using ${saveName} (map_X_Y.bin layout). Map will switch to B41 tile source.`,
              {
                category: "worldmap",
                variant: "b41",
                params: { saveCount, saveName },
              },
            ),
          );
        } else {
          checks.push(
            diagWarn(
              "worldmap.save.build",
              "Save build not detected",
              `Found ${saveCount} save folder(s) but couldn\'t identify B41 vs B42 layout. Map will default to B42 origin and player coords may render off-screen on a B41 save.`,
              {
                category: "worldmap",
                hint: "Start the server once to materialise chunk files.",
                params: { saveCount },
              },
            ),
          );
        }
      }
    } else {
      checks.push(
        diagWarn(
          "worldmap.save.dataPath",
          "No Zomboid data path set",
          "Cannot locate save folders. Map auto-detection of B41/B42 will be skipped.",
          { category: "worldmap", hint: "Servers → Edit → Zomboid Data Path" },
        ),
      );
    }

    // ─── Map proxy (local) ────────────────────────────────────────────
    // The /api/map/tiles route is mounted unconditionally in index.js. Its
    // upstream URLs are already surfaced in the response payload, so we
    // skip pushing an info-only check here to keep the summary actionable.

    // ─── Aggregate ────────────────────────────────────────────────────
    const summary = { ok: 0, warn: 0, fail: 0, info: 0, skip: 0 };
    for (const c of checks) summary[c.status] = (summary[c.status] || 0) + 1;
    const overall =
      summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "ok";

    // Same params redaction pass as GET /diagnostics — see the comment
    // there (client/src/lib/diagnosticsTranslation.ts is the consumer).
    const sanitizedChecks = checks.map((c) =>
      c.params ? { ...c, params: sanitizeErrorParams(c.params) } : c,
    );

    res.json({
      timestamp: new Date().toISOString(),
      overall,
      summary,
      checks: sanitizedChecks,
      durationMs: Date.now() - t0,
      // Extra structured data the UI surfaces in dedicated panels.
      tileSources: {
        b42: b42Probe,
        b41: b41Probe,
      },
      bridge: bridgeStatus
        ? {
            configured: bridgeStatus.configured,
            isRunning: bridgeStatus.isRunning,
            modConnected,
            statusAgeMs: statusAge,
            bridgePath: bridgeStatus.bridgePath,
            consecutiveFailures: bridgeStatus.consecutiveFailures,
          }
        : null,
      handlers: WORLDMAP_HANDLERS,
      save: {
        zomboidDataPath: activeServer?.zomboidDataPath || null,
        savesDir,
        activeSaveName: saveName,
        activeSavePath: savePath,
        saveCount,
        build: saveBuild,
      },
      activeServer: activeServer
        ? {
            id: activeServer.id,
            name: activeServer.name || activeServer.serverName,
            serverName: activeServer.serverName,
          }
        : null,
      proxy: {
        b42: "/api/map/tiles/:level/:tile?floor=N",
        b41: "/api/map/b41tiles/:level/:tile",
      },
    });
  } catch (error) {
    log.error(`World map diagnostics failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});
router.get("/performance-history", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const limit = parseClampedInteger(req.query.limit, 60, 1, 1440);
    const history = await getPerformanceHistory(limit);
    res.json({ history });
  } catch (error) {
    log.error(`Failed to get performance history: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Record current performance snapshot (called periodically)
router.post("/performance-snapshot", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const { memoryUsed, memoryTotal, cpuUsage, playerCount, serverRunning } =
      req.body || {};
    // Coerce + clamp each metric to a sane range. Unknown / missing values fall back to defaults.
    const toNum = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
    await recordPerformanceSnapshot({
      memoryUsed: clamp(
        toNum(memoryUsed, process.memoryUsage().heapUsed),
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      memoryTotal: clamp(
        toNum(memoryTotal, process.memoryUsage().heapTotal),
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      cpuUsage: clamp(toNum(cpuUsage, 0), 0, 100),
      playerCount: clamp(Math.floor(toNum(playerCount, 0)), 0, 10_000),
      serverRunning: typeof serverRunning === "boolean" ? serverRunning : false,
    });
    res.json({ success: true });
  } catch (error) {
    log.error(`Failed to record performance snapshot: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Database stats
router.get("/database", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const stats = await getDatabaseStats();
    res.json(stats);
  } catch (error) {
    log.error(`Failed to get database stats: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Create manual database backup
router.post("/database/backup", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    log.info("POST /database/backup");
    const result = await createDatabaseBackup();
    res.json(result);
  } catch (error) {
    log.error(`Failed to create database backup: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Compact database (apply retention policies)
router.post("/database/compact", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    log.info("POST /database/compact");
    const result = await compactDatabase();
    res.json(result);
  } catch (error) {
    log.error(`Failed to compact database: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Remove stale *.lock files from the active save folder. Refuses to run
// while the server is still alive so we don't yank a lock the JVM still
// holds open. Only deletes files older than 1 hour (matches the
// diagnostics threshold in scanSaveStats).
router.post("/clear-stale-locks", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    log.info("POST /clear-stale-locks");
    const serverManager = req.app.get("serverManager");
    // getServerProcessDetails(), not checkServerRunning() -- the latter
    // discards the scan's own scanFailed flag and returns a plain boolean,
    // so a scan that completed but couldn't determine the server's state
    // (timeout, PowerShell/exec error) came back indistinguishable from
    // "confirmed stopped" and let this delete proceed, exactly the "yank a
    // lock the JVM still holds open" case this route's own comment warns
    // about. Same fail-open class already fixed at /wipe, /delete-files,
    // chunks.js's delete-chunks/delete-region, backup.js's restore, and
    // templates.js's apply. A thrown check (or no serverManager at all) also
    // fails closed now, instead of falling back to the unrelated
    // serverManager.isRunning flag.
    let details;
    try {
      if (typeof serverManager?.getServerProcessDetails === "function") {
        details = await serverManager.getServerProcessDetails();
      } else {
        return res.status(503).json({
          success: false,
          error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
        });
      }
    } catch {
      return res.status(503).json({
        success: false,
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
      });
    }
    if (details.scanFailed) {
      return res.status(503).json({
        success: false,
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
      });
    }
    if (details.running) {
      return res.status(409).json({
        success: false,
        error:
          "Stop the server before clearing lock files. PZ holds these open while running.",
      });
    }

    const activeServer = await getActiveServer().catch(() => null);
    if (!activeServer) {
      return res
        .status(400)
        .json({ success: false, error: "No active server is configured." });
    }
    const zPath = activeServer.zomboidDataPath || null;
    if (!zPath || !activeServer.serverName) {
      return res.status(400).json({
        success: false,
        error:
          "Active server has no Zomboid data path or server name configured.",
      });
    }

    const savesRoot = path.join(zPath, "Saves");
    const candidates = [
      path.join(savesRoot, "Multiplayer", activeServer.serverName),
    ];
    if (
      activeServer.savename &&
      activeServer.savename !== activeServer.serverName
    ) {
      candidates.push(
        path.join(savesRoot, "Multiplayer", activeServer.savename),
      );
    }
    let saveDir = null;
    for (const sp of candidates) {
      try {
        const st = await fs.promises.stat(sp);
        if (st.isDirectory()) {
          saveDir = sp;
          break;
        }
      } catch {
        /* not present */
      }
    }
    if (!saveDir) {
      return res
        .status(404)
        .json({ success: false, error: "Active save folder not found." });
    }

    const MAX_FILES = 50000;
    const staleAfterMs = 60 * 60 * 1000;
    const now = Date.now();
    // User-triggered, not a background poll -- generous budget compared to
    // scanSaveStats's diagnostics-cycle one, since letting a deliberate
    // delete run longer is better than truncating it early. Still bounded:
    // same reasoning as scanSaveStats above, an unbounded raw
    // fs.promises.readdir/stat here could hang the whole request forever on
    // a dead network mount, so this walk gets the same FS_TIMEOUT_MS-bounded
    // safeReaddir/safeStat plus its own wall-clock deadline.
    const deadline = now + 30000;
    const deleted = [];
    const failed = [];
    let visited = 0;
    let truncated = false;

    const walk = async (dir) => {
      if (visited >= MAX_FILES || Date.now() >= deadline) {
        truncated = true;
        return;
      }
      const names = await safeReaddir(dir);
      if (!names) return;
      for (const name of names) {
        if (++visited > MAX_FILES || Date.now() >= deadline) {
          truncated = true;
          return;
        }
        const full = path.join(dir, name);
        const st = await safeStat(full);
        if (!st) continue;
        if (st.isDirectory()) {
          await walk(full);
        } else if (
          st.isFile() &&
          (name.endsWith(".lock") || name === ".lock")
        ) {
          if (now - st.mtimeMs > staleAfterMs) {
            try {
              await fs.promises.unlink(full);
              deleted.push(full);
            } catch (err) {
              failed.push({ path: full, error: err.message });
            }
          }
        }
      }
    };
    await walk(saveDir);

    log.info(
      `Cleared ${deleted.length} stale lock file(s) from ${saveDir} (${failed.length} failed)` +
        (truncated ? " -- scan stopped early, save too large to fully check in one pass" : ""),
    );
    res.json({
      success: true,
      deleted: deleted.length,
      failed: failed.length,
      truncated,
      saveDir,
      message:
        `Removed ${deleted.length} stale lock file${deleted.length === 1 ? "" : "s"}` +
        (failed.length > 0 ? ` (${failed.length} could not be deleted)` : "") +
        (truncated
          ? ". Stopped early -- this save is too large to fully check in one pass, so some stale lock files may remain undetected."
          : ".") ,
    });
  } catch (error) {
    log.error(`Failed to clear stale locks: ${error.message}`);
    res
      .status(500)
      .json({ success: false, error: sanitizeError(error.message) });
  }
});

// Get crash logs (hs_err files from Java crashes)
// Shared shape check for both crash-log routes below: what actually counts
// as a "crash log", not just "no .. or / or \". Used to gate GET
// /crash-logs/:filename's arbitrary-read (a name-shaped blacklist alone
// can't be made correct -- searchDirs below includes the PZ install ROOT,
// so any non-crash-log file sitting there, e.g. a generated
// StartServer_<name>.bat with -adminpassword in plaintext, was readable by
// name) and kept identical to the enumeration below so the two routes never
// disagree on what a crash log is.
function isCrashLogFilename(file) {
  return (
    typeof file === "string" &&
    (file.startsWith("hs_err_pid") ||
      (file.includes("crash") && file.endsWith(".log")) ||
      (file.includes("error") && file.endsWith(".log")))
  );
}

router.get("/crash-logs", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    const serverPath = serverManager?.serverPath || "";

    // Look for crash logs in common locations. The panel's own logs dir
    // must come from getDataPaths(), not process.cwd() -- the panel has a
    // "move data/logs directory" setting, and cwd is wherever the process
    // happened to be launched from, not that configured location. Using
    // cwd here meant a moved instance would scan (and this route would
    // then present as "crash logs") whatever unrelated logs/ directory
    // happened to sit next to the executable -- on a shared dev machine,
    // that included another process's error.log, test-mock strings and
    // all.
    const crashDirs = [
      serverPath,
      path.join(serverPath, "logs"),
      getDataPaths().logsDir,
    ].filter(Boolean);

    const crashLogs = [];
    const seenFiles = new Set(); // Prevent duplicates

    for (const dir of crashDirs) {
      try {
        // Check dir exists
        try {
          await fs.promises.access(dir);
        } catch (e) {
          log.debug(`Crash log dir not accessible (${dir}): ${e.message}`);
          continue;
        }

        const files = await fs.promises.readdir(dir);

        await Promise.all(
          files.map(async (file) => {
            // Skip if already seen
            if (seenFiles.has(file)) return;

            // Match Java crash dumps and common crash log patterns
            if (isCrashLogFilename(file)) {
              try {
                const filePath = path.join(dir, file);
                const stats = await fs.promises.stat(filePath);
                if (!seenFiles.has(file)) {
                  // Check again after await
                  seenFiles.add(file);
                  crashLogs.push({
                    name: file,
                    path: filePath,
                    size: stats.size,
                    modified: stats.mtime.toISOString(),
                  });
                }
              } catch (e) {
                log.debug(`Stat failed for crash log ${file}: ${e.message}`);
              }
            }
          }),
        );
      } catch (e) {
        log.debug(
          `Directory not accessible for crash logs: ${dir} — ${e.message}`,
        );
      }
    }

    // Sort by modified date, newest first
    crashLogs.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    // totalCount is the real count before the cap -- the client showed the
    // capped array's length as if it were the total, so a server with more
    // than 20 crash dumps (common with mod incompatibilities) displayed a
    // stuck "20" that masked how many actually exist.
    res.json({ crashLogs: crashLogs.slice(0, 20), totalCount: crashLogs.length });
  } catch (error) {
    log.error(`Failed to get crash logs: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get crash log content
router.get("/crash-logs/:filename", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const { filename } = req.params;
    const serverManager = req.app.get("serverManager");
    const serverPath = serverManager?.serverPath || "";

    // Security: prevent path traversal
    if (
      filename.includes("..") ||
      filename.includes("/") ||
      filename.includes("\\")
    ) {
      return res.status(400).json({ error: "Invalid filename" });
    }

    // SECURITY (2026-09-05, crash-logs-arbitrary-read): the traversal check
    // above only rejects a SHAPE of attack, not an untrusted TARGET -- it
    // says nothing about which files under searchDirs are actually crash
    // logs. searchDirs' first entry is the PZ install ROOT, so without this
    // an authenticated caller holding only diagnostics.manage (not admin)
    // could read any file there by name, e.g.
    // GET /crash-logs/StartServer_<name>.bat, which embeds -adminpassword
    // in plaintext -- confirmed live over HTTP before this fix.
    if (!isCrashLogFilename(filename)) {
      return res.status(400).json({ error: "Invalid filename" });
    }

    const searchDirs = [
      serverPath,
      path.join(serverPath, "logs"),
      getDataPaths().logsDir,
    ].filter(Boolean);

    for (const dir of searchDirs) {
      const filePath = path.join(dir, filename);
      try {
        await fs.promises.access(filePath);

        // Read only first 100KB using file handle to prevent OOM on large files
        const handle = await fs.promises.open(filePath, "r");
        try {
          const stats = await handle.stat();
          const readSize = Math.min(stats.size, 100000);
          const buffer = Buffer.alloc(readSize);

          await handle.read(buffer, 0, readSize, 0);
          const content = buffer.toString("utf-8");

          return res.json({
            content,
            truncated: stats.size > 100000,
            size: stats.size,
          });
        } finally {
          await handle.close();
        }
      } catch (e) {
        // File not found in this dir, try next
      }
    }

    res.status(404).json({ error: "Crash log not found" });
  } catch (error) {
    log.error(`Failed to read crash log: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// POST /client-errors - Accept frontend error reports for server-side logging
// Production builds can't console.error, so this makes client crashes visible.
const CLIENT_ERROR_RATE = new Map(); // IP -> { count, resetAt }
const CLIENT_ERROR_MAX = 30; // max reports per minute per IP
// Entries expire logically but were never removed, so every distinct client IP
// left a permanent entry. Sweep expired ones once the map gets large.
const CLIENT_ERROR_RATE_MAX_ENTRIES = 5000;

// Deliberately unauthenticated -- no requirePermission gate at all, not
// even "any logged-in role" (compare the file header above, which
// undersells this). A frontend crash can happen before the client has
// authenticated at all, most notably on the login page itself, where
// there is no token to attach and no req.user to check -- gating this
// route would silently delete exactly the crash reports an operator most
// needs to see. What protects it instead: the per-IP rate limit right
// below (CLIENT_ERROR_MAX = 30/min), plus the fact that it only ever
// logs a message and mutates/exposes nothing sensitive.
router.post("/client-errors", (req, res) => {
  try {
    // Simple per-IP rate limit to prevent abuse
    const ip = req.ip || "unknown";
    const now = Date.now();
    if (CLIENT_ERROR_RATE.size > CLIENT_ERROR_RATE_MAX_ENTRIES) {
      for (const [key, tracked] of CLIENT_ERROR_RATE) {
        if (now > tracked.resetAt) CLIENT_ERROR_RATE.delete(key);
      }
    }
    const entry = CLIENT_ERROR_RATE.get(ip) || {
      count: 0,
      resetAt: now + 60000,
    };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + 60000;
    }
    entry.count++;
    CLIENT_ERROR_RATE.set(ip, entry);
    if (entry.count > CLIENT_ERROR_MAX) {
      return res.status(429).json({ error: "Too many error reports" });
    }

    const { message, error: errorDetail, url } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    log.warn(`[ClientError] ${message.slice(0, 500)}`, {
      error:
        typeof errorDetail === "string"
          ? errorDetail.slice(0, 1000)
          : undefined,
      url: typeof url === "string" ? url.slice(0, 200) : undefined,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to process error report" });
  }
});

// ============================================
// Unified Activity Log
// ============================================

// GET /api/debug/activity — Merge all log sources into a single chronological feed
router.get("/activity", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const limit = parseClampedInteger(req.query.limit, 200, 1, 500);
    const source = req.query.source || "all"; // 'all' | 'rcon' | 'bridge' | 'player' | 'server'

    // Player action logs are players.view's own territory (its description:
    // "Read player details, status and history") -- merging them into this
    // diagnostics.manage-gated feed let a custom role holding diagnostics.manage
    // without players.view read full player moderation history through a door
    // labeled "logs, performance history... and CORS diagnostics." Only resolved
    // when a player source could actually appear -- avoids a role lookup on
    // every rcon/bridge/server-only request. Explicitly requested is a refusal
    // (the caller asked for something they don't hold); folded into "all" it's
    // a silent omission (the rest of the feed is still theirs to see) rather
    // than refusing the whole request over one source.
    let canViewPlayers = true;
    if (source === "all" || source === "player") {
      const role = req.user ? await getRoleByName(req.user.role) : null;
      canViewPlayers = Array.isArray(role?.capabilities) && role.capabilities.includes("players.view");
    }

    if (source === "player" && !canViewPlayers) {
      return res.status(403).json({
        error: "Viewing player activity history also requires players.view.",
      });
    }

    const entries = [];

    // RCON command history
    if (source === "all" || source === "rcon") {
      const rconHistory = await getCommandHistory(limit);
      for (const cmd of rconHistory) {
        entries.push({
          id: cmd.id,
          source: "rcon",
          action: cmd.command,
          detail: cmd.response || "",
          success: cmd.success === 1,
          timestamp: cmd.executed_at,
        });
      }
    }

    // Bridge command history
    if (source === "all" || source === "bridge") {
      const bridgeHistory = await getBridgeLogs(limit);
      for (const cmd of bridgeHistory) {
        const detail =
          cmd.success === 1
            ? cmd.result?.data
              ? JSON.stringify(cmd.result.data).substring(0, 300)
              : "ok"
            : cmd.result?.error || "failed";
        entries.push({
          id: cmd.id,
          source: "bridge",
          action: cmd.action,
          args: cmd.args,
          detail,
          success: cmd.success === 1,
          duration_ms: cmd.duration_ms,
          timestamp: cmd.executed_at,
        });
      }
    }

    // Player action logs -- gated on players.view above; source === "player"
    // without it already returned. source === "all" without it just skips
    // this block, same as if no player logs existed.
    if ((source === "all" || source === "player") && canViewPlayers) {
      const playerLogs = await getPlayerLogs(null, limit);
      for (const log of playerLogs) {
        entries.push({
          id: log.id,
          source: "player",
          action: log.action,
          detail: log.player_name + (log.details ? ` — ${log.details}` : ""),
          success: true,
          timestamp: log.logged_at,
        });
      }
    }

    // Server events
    if (source === "all" || source === "server") {
      const db = await getDb();
      const serverEvents = (db.data.server_events || []).slice(0, limit);
      for (const evt of serverEvents) {
        entries.push({
          id: evt.id,
          source: "server",
          action: evt.event_type,
          detail: evt.message || "",
          success: !/(crash|error|fail)/i.test(evt.event_type),
          timestamp: evt.created_at,
        });
      }
    }

    // Sort by timestamp (newest first) and trim
    entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const trimmed = entries.slice(0, limit);

    res.json({ entries: trimmed, total: trimmed.length });
  } catch (error) {
    log.error(`Activity log failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ============================================
// Diagnostics: one targeted automated fix
// ============================================
//
// POST /api/debug/fix-writability -- clears the read-only attribute on ONE
// specific, server-resolved file and re-checks writability. `target` is a
// closed enum, never a client-supplied path: accepting an arbitrary path
// here would let any caller with diagnostics.manage chmod anything on disk
// the panel process can reach, which is a far bigger blast radius than the
// one check this exists to fix.
//
// Deliberately narrow to db.json (a single FILE). The logs DIRECTORY fails
// the same diagnostic (logs.writable) but is NOT in scope here on purpose:
// chmod on a directory has broader, less predictable effects than one file
// (Windows' read-only attribute on a directory doesn't even mean what it
// means on a file, and clearing it can touch how the whole tree is
// enumerated), and the existing manual hint (check filesystem permissions)
// is the safer answer there. See getDiagnosticsFixAction's own comment on
// the "db.writable" case in Debug.tsx for the operator-facing half of this
// same reasoning.
//
// fs.chmod on Windows can only toggle the read-only ATTRIBUTE, not NTFS
// ACLs -- it fixes the common case (file extracted from a zip, copied from
// read-only media, etc.) but a genuine ownership/ACL denial will still fail
// the chmod call itself (usually EPERM) or leave the file unwritable even
// after chmod succeeds. Both are reported honestly below, not swallowed.
router.post(
  "/fix-writability",
  requirePermission("diagnostics.manage"),
  async (req, res) => {
    try {
      const { target } = req.body || {};
      if (target !== "db") {
        return res.status(400).json({
          error: "Unknown or unsupported writability target",
          code: ErrorCode.WRITABILITY_TARGET_UNSUPPORTED,
        });
      }

      const paths = getDataPaths();
      const targetPath = paths.dbPath;
      if (!(await safePathExists(targetPath))) {
        return res.status(404).json({
          error: "Database file does not exist",
          code: ErrorCode.WRITABILITY_TARGET_MISSING,
        });
      }

      try {
        // u+w only -- this file never needs to be group/world-writable, and
        // a permissive 0o666 would widen access beyond what's needed to fix
        // the one thing this route is for.
        await fs.promises.chmod(targetPath, 0o600);
      } catch (chmodError) {
        return res.status(400).json({
          success: false,
          error: `Could not change file permissions: ${chmodError.message}`,
          code: ErrorCode.WRITABILITY_CHMOD_FAILED,
        });
      }

      if (!(await safePathWritable(targetPath))) {
        return res.status(400).json({
          success: false,
          error:
            "The file is still not writable after clearing the read-only attribute -- this looks like an ownership or ACL issue, which this automated fix can't resolve.",
          code: ErrorCode.WRITABILITY_STILL_BLOCKED,
        });
      }

      log.info(`Cleared read-only attribute on ${targetPath}`);
      res.json({
        success: true,
        message: "Database file is writable again.",
        path: targetPath,
      });
    } catch (error) {
      log.error(`Failed to fix writability: ${error.message}`);
      res.status(500).json({ error: sanitizeError(error.message) });
    }
  },
);

export default router;
export { logBuffer, getDiskFree };
// Exported for direct unit testing of the support-bundle collectors --
// see server/tests/supportBundleCollectors.test.js. Not used by any other
// route in this file, which continues to call them as plain module-local
// functions.
export {
  buildBundleDiagnostics,
  buildSystemInfo,
  buildServerConfigSummary,
  buildOidcStatus,
  buildRolesAndPermissions,
  checkCurlAvailable,
  buildWorldMapDiagnostics,
  buildDbWriteHealth,
  buildBackupsSummary,
  buildDiscordBotStatus,
  buildDockerContainerLogsText,
  buildManagedServiceLogsText,
};
// Exported for direct unit testing of the support-bundle raw-log redaction
// (operator ruling, support-bundle-2026-08-30 follow-up) -- see
// server/tests/supportBundleRedaction.test.js.
export {
  redactRawLogText,
  collectBundleKnownSecrets,
  createRedactingLogStream,
};
// Exported for direct unit testing of the GET /diagnostics thumbnail-
// resolution check -- see server/tests/thumbnailResolutionCheck.test.js.
export { buildThumbnailResolutionCheck };
// Exported for direct unit testing of the GET /diagnostics RCON
// command-rejection check -- see server/tests/rconCommandRejectionsCheck.test.js.
export { summarizeRconRejections, buildRconCommandRejectionsCheck };
// Exported for direct unit testing of the stale-lock save-folder walk's
// deadline behavior and its diagnostics-check decision -- see
// server/tests/scanSaveStatsDeadline.test.js.
export { scanSaveStats, buildStaleLocksCheck };
// Exported for direct unit testing of the zomboid-paths.json bundle
// section's custom-launcher installPath handling -- see
// server/tests/zomboidPathsInstallLogs.test.js.
export { buildZomboidPaths };
