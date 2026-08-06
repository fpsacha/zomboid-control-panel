import express from "express";
import os from "os";
import v8 from "v8";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import archiver from "archiver";
import { createLogger } from "../utils/logger.js";
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
  getScheduledTasks,
  getTrackedMods,
  getAllSettings,
} from "../database/init.js";
import { sanitizeError } from "../utils/sanitize.js";
import { checkSandboxBraceBalance } from "./serverFiles.js";
import panelBridgeService from "../services/panelBridge.js";
import {
  PZ_MAP_ROOT,
  getB42Dir,
  getB42TopFormat,
} from "./mapProxy.js";
import {
  getCandidateZomboidPaths,
  inspectZomboidPath,
} from "../utils/zomboidPaths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

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
router.get("/ram", async (req, res) => {
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
router.get("/system", async (req, res) => {
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
router.get("/logs", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 200;
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

const SECRET_FIELD_RE =
  /(password|secret|token|apikey|api_key|jwt|sessionid|loginsecure|cookie|webhook)/i;
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

async function readPanelVersion() {
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

async function buildSystemInfo(activeServer) {
  const version = await readPanelVersion();
  const isPkg = typeof process.pkg !== "undefined";
  const paths = getDataPaths();
  const cpus = os.cpus();

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
    result.available = true;
    result.ini = {
      ...result.ini,
      exists: true,
      sha256: crypto.createHash("sha256").update(iniContent).digest("hex"),
      settings: safeSettings,
      mods: splitList(values.Mods),
      workshopItems: splitList(values.WorkshopItems),
      map: splitList(values.Map),
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
      install: activeServer?.installPath
        ? await listDir(activeServer.installPath)
        : null,
      installLogs: activeServer?.installPath
        ? await listDir(path.join(activeServer.installPath, "logs"))
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

function buildBundleReadme() {
  return [
    "# Project Zomboid Control Panel — Support Bundle",
    "",
    "## Where to look first",
    "",
    "1. `support-bundle-info.txt` — high-level summary, paths used.",
    "2. `system-info.json` — panel version, OS, RAM, disk free.",
    "3. `panel-config.json` — sanitized settings + servers list (passwords/tokens masked).",
    "4. `zomboid-paths.json` — what the panel thinks the data/install paths are, all probed candidates, and dir listings of `Saves/`, `Saves/Multiplayer/`, `Server/`, `Logs/`, etc.",
    "5. `bridge-status.json` — PanelBridge connection, IPC file ages.",
    "6. `recent-events.json` — last server starts/stops, RCON commands, player join/leave, scheduled task runs.",
    "7. `db-stats.json` — record counts per collection.",
    "8. `performance-history.json` — recent CPU/RAM samples.",
    "9. `environment.txt` — relevant env vars (secrets show as `<set>`/`<unset>` only).",
    "10. `network-interfaces.json` — local IPs (no MACs).",
    "11. `process.json` — process flags, versions, active handle counts.",
    "12. `server-config-summary.json` — sanitized effective server settings, mod/map lists, and sandbox integrity.",
    "13. `pz-build-info.json` — installed Project Zomboid branch and Steam build ID.",
    "",
    "## Then the raw logs",
    "",
    "- `admin-panel/` — `combined.log`, `error.log` from the panel itself.",
    "  Grep for `ERROR`, `rejection`, `ECONN`, `EACCES`, `Failed to`.",
    "- `zomboid-server/` — `server-console.txt` and runtime logs from PZ.",
    "  Grep for `ERROR`, `Exception`, `Object tried to call nil`, `Stack trace`.",
    "- `zomboid-install/` — connection/workshop/system logs from the install side.",
    "- `crash-logs/` — Java/JVM crash dumps (`hs_err_pid*.log`) and matching error logs.",
    "",
    "## What is NOT in this bundle",
    "",
    "- Plaintext RCON / Discord / Steam credentials (masked).",
    "- Full environment variable values (only allow-listed keys show values).",
    "- MAC addresses (network interfaces list IPs only).",
    "- The LowDB file itself (`db.json`) — only sanitized excerpts.",
    "",
    "Generated by ZomboidControlPanel — see https://github.com/fpsacha/zomboid-control-panel",
    "",
  ].join("\n");
}

async function buildBundleDiagnostics(activeServer) {
  // Run all collectors in parallel — each one is wrapped so a single failure
  // doesn't kill the whole bundle.
  const wrap = async (name, fn) => {
    try {
      return [name, await fn()];
    } catch (e) {
      return [name, { _error: e?.message || String(e) }];
    }
  };

  const results = await Promise.all([
    wrap("system-info.json", () => buildSystemInfo(activeServer)),
    wrap("panel-config.json", () => buildPanelConfig(activeServer)),
    wrap("zomboid-paths.json", () => buildZomboidPaths(activeServer)),
    wrap("recent-events.json", () => buildRecentEvents()),
    wrap("performance-history.json", () => buildPerformanceHistory()),
    wrap("db-stats.json", () => buildDbStats()),
    wrap("bridge-status.json", async () => buildBridgeStatus()),
    wrap("process.json", () => buildProcessSnapshot()),
    wrap("network-interfaces.json", () => buildNetworkInterfaces()),
    wrap("server-config-summary.json", () => buildServerConfigSummary(activeServer)),
    wrap("pz-build-info.json", () => buildPzBuildInfo(activeServer)),
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
router.get("/logs/files", async (req, res) => {
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
router.get("/logs/download", async (req, res) => {
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
router.get("/logs/download-zip", async (req, res) => {
  try {
    log.info("GET /logs/download-zip");

    const { entries, activeServer, sources } = await getSupportBundleEntries();
    if (entries.length === 0) {
      return res.status(404).json({ error: "No support logs found" });
    }

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
      "Contents:",
      "- admin-panel: panel combined/error logs",
      "- zomboid-server: server-console and runtime logs",
      "- zomboid-install: install-side connection/workshop/system logs",
      "- crash-logs: matching crash/error dump files",
    ].join("\n");

    archive.append(manifest, { name: "support-bundle-info.txt" });

    for (const entry of entries) {
      archive.file(entry.filePath, { name: entry.archivePath });
    }

    // ── Diagnostic JSON files (best-effort; collectors never throw) ──
    try {
      const diagnostics = await buildBundleDiagnostics(activeServer);
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
router.get("/logs/download/:filename", async (req, res) => {
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
router.post("/logs/clear", async (req, res) => {
  try {
    log.info("POST /logs/clear");
    logBuffer.length = 0;
    res.json({ success: true, message: "Log buffer cleared" });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Update data paths (database and logs location)
router.post("/paths", async (req, res) => {
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

    const result = await setDataPaths(
      { dataDir, logsDir },
      moveFiles !== false,
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
router.get("/health", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const serverManager = req.app.get("serverManager");
    const modChecker = req.app.get("modChecker");

    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      services: {
        rcon: {
          connected: rconService?.isConnected?.() || false,
          host: rconService?.config?.host || "not configured",
        },
        server: {
          running: (await serverManager?.checkServerRunning?.()) || false,
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
// MAX_FILES to keep huge saves from making diagnostics hang.
async function scanSaveStats(saveDir) {
  if (!saveDir) return null;
  const exists = await safePathExists(saveDir);
  if (!exists) return null;
  const MAX_FILES = 50000;
  const staleAfterMs = 60 * 60 * 1000;
  const now = Date.now();
  let totalBytes = 0;
  let chunks = 0;
  let staleLocks = [];
  let visited = 0;
  let truncated = false;

  const walk = async (dir) => {
    if (visited >= MAX_FILES) {
      truncated = true;
      return;
    }
    const names = await safeReaddir(dir);
    if (!names) return;
    for (const name of names) {
      if (++visited > MAX_FILES) {
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

async function getDiskFree(targetPath) {
  try {
    if (!targetPath) return null;
    // Preferred path: fs.promises.statfs (Node 18.15+). The pkg-bundled Node
    // is 18.5 and lacks this method, so we fall through to platform shells.
    if (typeof fs.promises.statfs === "function") {
      // statfs can hang on dead mounts on Linux — wrap with timeout.
      const stats = await withTimeout(
        fs.promises.statfs(targetPath),
        FS_TIMEOUT_MS,
        null,
      );
      if (stats) {
        return {
          free: stats.bavail * stats.bsize,
          total: stats.blocks * stats.bsize,
        };
      }
    }
    return await getDiskFreeFallback(targetPath);
  } catch {
    return null;
  }
}

function execFileP(file, args, opts = {}) {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { timeout: FS_TIMEOUT_MS, windowsHide: true, ...opts },
        (err, stdout, stderr) => {
          if (err)
            resolve({ ok: false, stdout: stdout || "", stderr: stderr || "" });
          else
            resolve({ ok: true, stdout: stdout || "", stderr: stderr || "" });
        },
      );
    } catch {
      resolve({ ok: false, stdout: "", stderr: "" });
    }
  });
}

async function getDiskFreeFallback(targetPath) {
  try {
    const resolved = path.resolve(targetPath);
    if (process.platform === "win32") {
      // wmic is deprecated but still present on most Windows installs; fall
      // back to PowerShell Get-PSDrive when it isn't.
      const drive = resolved.slice(0, 2); // e.g. "E:"
      if (!/^[A-Za-z]:$/.test(drive)) return null;
      const letter = drive[0].toUpperCase();
      // Try PowerShell first (works on Win10/11 and Server 2016+).
      const ps = await execFileP("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$d = Get-PSDrive -Name '${letter}' -ErrorAction SilentlyContinue; if ($d) { '{0} {1}' -f $d.Free, ($d.Free + $d.Used) }`,
      ]);
      if (ps.ok) {
        const parts = ps.stdout.trim().split(/\s+/);
        if (parts.length === 2) {
          const free = Number(parts[0]);
          const total = Number(parts[1]);
          if (Number.isFinite(free) && Number.isFinite(total) && total > 0) {
            return { free, total };
          }
        }
      }
      // wmic fallback.
      const wmic = await execFileP("wmic", [
        "logicaldisk",
        "where",
        `DeviceID='${letter}:'`,
        "get",
        "FreeSpace,Size",
        "/value",
      ]);
      if (wmic.ok) {
        const freeMatch = wmic.stdout.match(/FreeSpace=(\d+)/);
        const sizeMatch = wmic.stdout.match(/Size=(\d+)/);
        if (freeMatch && sizeMatch) {
          const free = Number(freeMatch[1]);
          const total = Number(sizeMatch[1]);
          if (Number.isFinite(free) && Number.isFinite(total) && total > 0) {
            return { free, total };
          }
        }
      }
      return null;
    }
    // POSIX: df -Pk <path> → blocks (1K), used, available, capacity, mounted
    const df = await execFileP("df", ["-Pk", resolved]);
    if (!df.ok) return null;
    const lines = df.stdout.trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    const cols = lines[1].trim().split(/\s+/);
    if (cols.length < 4) return null;
    const totalKb = Number(cols[1]);
    const freeKb = Number(cols[3]);
    if (!Number.isFinite(totalKb) || !Number.isFinite(freeKb)) return null;
    return { free: freeKb * 1024, total: totalKb * 1024 };
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

router.get("/diagnostics", async (req, res) => {
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

    // checkServerRunning may probe the OS process list and can hang on a
    // misbehaving system — keep it bounded.
    const checkRunningPromise = serverManager?.checkServerRunning?.()
      ? withTimeout(serverManager.checkServerRunning(), FS_TIMEOUT_MS, false)
      : Promise.resolve(false);

    const [
      activeServer,
      settings,
      trackedMods,
      scheduledTasks,
      serverRunning,
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
      Promise.resolve(checkRunningPromise)
        .then((v) => v || false)
        .catch(() => false),
      withTimeout(
        getDatabaseStats().catch(() => null),
        FS_TIMEOUT_MS,
        null,
      ),
    ]);

    // ─── Core Services ────────────────────────────────────────────────
    try {
      const remoteRconOnly =
        !activeServer?.installPath &&
        !activeServer?.serverPath &&
        !activeServer?.zomboidDataPath &&
        Boolean(activeServer?.rconHost || rconService?.config?.host);

      if (remoteRconOnly) {
        checks.push(
          diagSkip(
            "server.process",
            "Remote server process",
            "Managed by the hosting provider; local process monitoring is unavailable. RCON controls remain available.",
            { category: "services" },
          ),
        );
      } else if (serverRunning) {
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
        checks.push(
          diagOk(
            "rcon.connected",
            "RCON connected",
            `Connected to ${rconService.config?.host || "127.0.0.1"}:${rconService.config?.port || 27015}.`,
            { category: "services" },
          ),
        );
      } else if (!serverRunning) {
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

      if (modChecker?.isRunning) {
        const interval = Math.round((modChecker.checkInterval || 0) / 60000);
        checks.push(
          diagOk(
            "modChecker",
            "Mod update checker",
            `Polling Steam Workshop every ${interval || "?"} min.`,
            { category: "services" },
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
              { category: "services" },
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
          checks.push(
            diagOk(
              "discord.bot",
              "Discord bot connected",
              `Logged in as ${discordBot.client.user.tag}.`,
              { category: "services" },
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
    } catch (e) {
      checks.push(
        diagWarn(
          "services.error",
          "Service checks errored",
          `Some service checks could not run: ${e?.message || "unknown"}`,
          { category: "services" },
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
        checks.push(
          diagOk(
            "server.active",
            "Active server",
            `${activeServer.name || activeServer.serverName || "Unnamed"}.`,
            { category: "server" },
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
          checks.push(
            diagFail(
              "server.installPath",
              "Install path not found",
              isNetMount
                ? "Network share or mount not reachable. Check VPN, mount, or share availability."
                : "Configured install path does not exist or is unreadable.",
              {
                category: "server",
                hint: isNetMount
                  ? "Verify the share is mounted and credentials are valid"
                  : "Check the path in Servers → Edit",
              },
            ),
          );
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
          checks.push(
            diagFail(
              "server.zomboidData",
              "Zomboid data path not found",
              "Configured saves/config path does not exist.",
              {
                category: "server",
                hint:
                  process.platform === "linux"
                    ? "On Linux this is usually ~/Zomboid"
                    : "On Windows this is usually %USERPROFILE%/Zomboid",
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
              checks.push(
                diagWarn(
                  "server.startScript",
                  "Start script not executable",
                  `${foundScript} exists but has no executable bit. The panel cannot launch it.`,
                  { category: "server", hint: `Run: chmod +x ${foundScript}` },
                ),
              );
            } else {
              checks.push(
                diagOk(
                  "server.startScript",
                  "Start script found",
                  `Using ${foundScript}.`,
                  { category: "server" },
                ),
              );
            }
          } else {
            checks.push(
              diagWarn(
                "server.startScript",
                "Start script not found",
                `No ${isWin ? "StartServer*.bat" : "start-server*.sh"} in install path. Server can't be started from the panel.`,
                { category: "server" },
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
                { category: "server" },
              ),
            );
          } else {
            checks.push(
              diagWarn(
                "server.jre",
                "Bundled JRE not found",
                `Could not locate jre64/bin/${isWin ? "java.exe" : "java"} under the install path. Server may fail to start unless system Java is on PATH.`,
                {
                  category: "server",
                  hint: isLinux
                    ? "Most installs ship a JRE under jre64/. Re-run SteamCMD if missing."
                    : "Re-run SteamCMD to restore the bundled JRE",
                },
              ),
            );
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
                { category: "server" },
              ),
            );
          } else {
            checks.push(
              diagWarn(
                "server.ini",
                "server.ini not found",
                `${activeServer.serverName}.ini is not in <zomboidData>/Server/. The server will create defaults on first run.`,
                { category: "server" },
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
            const hint =
              rc.kind === "oom"
                ? "Raise the server's Java heap (-Xmx in the start script) or reduce mod count."
                : "Open the Logs page and read the stack trace around the timestamp.";
            checks.push(
              diagFail(
                "server.recentCrash",
                `Recent crash: ${rc.label}`,
                `Found in server-console.txt (last update ${ageLabel}): ${rc.line}`,
                {
                  category: "server",
                  hint,
                  meta: { kind: rc.kind, logMtime: rc.logMtime },
                },
              ),
            );
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
                { category: "server" },
              ),
            );
          } else if (unresolvedMods.length > 0) {
            const shown = unresolvedMods.slice(0, 5).join(", ");
            const list =
              unresolvedMods.length > 5
                ? `${shown}, +${unresolvedMods.length - 5} more`
                : shown;
            checks.push(
              diagFail(
                "mods.resolved",
                "Mods= entries do not resolve",
                `${unresolvedMods.length} of ${ini.Mods.length} Mods= entries don't match any installed mod folder: ${list}.`,
                {
                  category: "server",
                  hint: "Usually a typo, missing WorkshopItems= ID, or the mod hasn't finished downloading. Fix in Server Config.",
                  meta: { unresolvedMods },
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
            checks.push(
              diagWarn(
                "mods.orphanWorkshop",
                "Subscribed Workshop items not enabled",
                `${all.length} Workshop item${all.length === 1 ? " is" : "s are"} listed in WorkshopItems= but won't load: ${parts.join(", ")}. IDs: ${list}.`,
                {
                  category: "server",
                  hint: "Auto-fix triages each ID: downloaded → resolves and adds to Mods=; ignored or missing → removes from WorkshopItems=.",
                  meta: {
                    orphanWorkshop: all,
                    downloadedOrphans: orphanWorkshop,
                    deadOrphans: deadWorkshop,
                  },
                },
              ),
            );
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
            checks.push(
              diagWarn(
                "mods.duplicates",
                "Duplicate mod entries",
                `${parts.join(", ")} in the server config.`,
                {
                  category: "server",
                  hint: "Tidy up Server Config — duplicates can confuse mod-load order.",
                  meta: {
                    dupMods: [...new Set(dupMods)],
                    dupWs: [...new Set(dupWs)],
                  },
                },
              ),
            );
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
                { category: "server" },
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
            const hint =
              modsInMap.length > 0 && trulyMissing.length === 0
                ? "These names are mods, not maps. Remove them from Map= — they only need to be in Mods=."
                : trulyMissing.length > 0 && modsInMap.length === 0
                  ? "Players will spawn into the void. Add the matching map mod or fix the spelling in Server Config."
                  : "Remove mod names from Map=, and add the matching map mod or fix spelling for the rest.";
            checks.push(
              diagFail(
                "mods.maps",
                "Map= entries do not resolve",
                `${missingMaps.length} entr${missingMaps.length === 1 ? "y" : "ies"} in Map= cannot be found. ${parts.join(". ")}.`,
                {
                  category: "server",
                  hint,
                  meta: { missingMaps, modsInMap, trulyMissing },
                },
              ),
            );
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
                  },
                ),
              );
            } else {
              checks.push(
                diagOk(
                  "server.sandboxVars",
                  "SandboxVars present",
                  `${activeServer.serverName}_SandboxVars.lua is in place.`,
                  { category: "server" },
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
              saveStats = await withTimeout(
                scanSaveStats(sp),
                FS_TIMEOUT_MS * 4,
                null,
              );
              saveDirUsed = sp;
              break;
            }
          }
          if (saveStats && saveStats.staleLocks.length > 0) {
            checks.push(
              diagFail(
                "server.staleLocks",
                "Stale lock files in save folder",
                `${saveStats.staleLocks.length} .lock file${saveStats.staleLocks.length === 1 ? "" : "s"} older than 1 hour in ${saveDirUsed}. PZ will refuse to load the save until they are removed.`,
                {
                  category: "server",
                  hint: "Stop the server, delete every *.lock file under the save folder, then restart.",
                  meta: { staleLocks: saveStats.staleLocks.slice(0, 10) },
                },
              ),
            );
          }
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
              checks.push(
                diagOk(
                  "server.jreWorks",
                  "Bundled JRE runs",
                  probe.version || "java -version executed successfully.",
                  { category: "server" },
                ),
              );
            } else {
              checks.push(
                diagFail(
                  "server.jreWorks",
                  "Bundled JRE failed to run",
                  `java -version did not succeed: ${probe.error || "unknown"}.${probe.output ? " Output: " + probe.output : ""}`,
                  {
                    category: "server",
                    hint: "Re-run SteamCMD to reinstall the JRE, or ensure the bundled libraries are present alongside the binary.",
                  },
                ),
              );
            }
          }
        }
      }
    } catch (e) {
      checks.push(
        diagWarn(
          "server.error",
          "Server checks errored",
          `Some active-server checks could not run: ${e?.message || "unknown"}`,
          { category: "server" },
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
          } else {
            checks.push(
              diagFail(
                "bridge.writable",
                "Bridge directory not writable",
                "Panel can't write to the bridge directory. Mod won't receive commands.",
                {
                  category: "bridge",
                  hint:
                    process.platform === "linux"
                      ? "Check ownership / chmod on the Zomboid Lua folder (often needs the panel user to own ~/Zomboid)"
                      : "Check filesystem permissions on the Lua write folder",
                },
              ),
            );
          }

          const status = bridgeStatus.modStatus;
          const conn = bridgeStatus.connection;
          if (status?.alive) {
            checks.push(
              diagOk(
                "bridge.heartbeat",
                "Mod heartbeat fresh",
                `Status from mod ${fmtAge(status.age || 0)}.`,
                { category: "bridge" },
              ),
            );
          } else if (!serverRunning) {
            checks.push(
              diagSkip(
                "bridge.heartbeat",
                "Mod heartbeat",
                "Server is offline — heartbeat resumes when it starts.",
                { category: "bridge" },
              ),
            );
          } else if (conn?.statusFile?.exists) {
            checks.push(
              diagFail(
                "bridge.heartbeat",
                "Mod heartbeat stale",
                `Last heartbeat ${fmtAge(conn.statusFile.age || 0)}. Mod may have crashed or be unloaded.`,
                {
                  category: "bridge",
                  hint: "Check server console.txt for PanelBridge errors",
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
                },
              ),
            );
          }
        }
      }
    } catch (e) {
      checks.push(
        diagWarn(
          "bridge.error",
          "Bridge checks errored",
          `Bridge IPC checks could not run: ${e?.message || "unknown"}`,
          { category: "bridge" },
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
        checks.push(
          diagFail(
            "db.writable",
            "Database not writable",
            "db.json exists but is read-only. Settings changes will fail.",
            {
              category: "storage",
              hint:
                process.platform === "linux"
                  ? "Run: chmod u+w data/db.json (and check the data/ directory is owned by the panel user)"
                  : "Check file permissions on data/db.json",
            },
          ),
        );
      } else {
        checks.push(
          diagOk(
            "db.writable",
            "Database accessible",
            `${dbStats?.collections?.length || "?"} collections, ${fmtMB(dbStats?.size || 0)}.`,
            { category: "storage" },
          ),
        );
      }
    } catch (e) {
      checks.push(
        diagWarn(
          "db.exists",
          "Database check failed",
          `Could not inspect db.json: ${e?.message || "unknown error"}`,
          { category: "storage" },
        ),
      );
    }

    try {
      const backupsDir = path.join(paths.dataDir, "backups");
      if (await safePathExists(backupsDir)) {
        const files = await safeReaddir(backupsDir);
        if (!files) {
          checks.push(
            diagWarn(
              "db.backup",
              "Backup status unknown",
              "Could not read the backup directory (timeout or permission denied).",
              { category: "storage" },
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
                },
              ),
            );
          } else if (age < 24 * 3600_000) {
            checks.push(
              diagOk(
                "db.backup",
                "Database backup recent",
                `Newest backup ${fmtAge(age)}.`,
                { category: "storage" },
              ),
            );
          } else {
            checks.push(
              diagWarn(
                "db.backup",
                "Database backup old",
                `Newest backup ${fmtAge(age)}. Consider creating a fresh one.`,
                {
                  category: "storage",
                  hint: "Debug → Database → Create Backup",
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
      checks.push(
        diagWarn(
          "db.backup",
          "Backup status unknown",
          `Could not inspect backups: ${e?.message || "unknown error"}`,
          { category: "storage" },
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
          checks.push(
            diagFail(
              "disk.free",
              "Disk almost full",
              `Only ${fmtGB(disk.free)} free of ${fmtGB(disk.total)} on data drive.`,
              {
                category: "storage",
                hint: "Free up disk space — saves and backups will fail",
              },
            ),
          );
        } else if (disk.free < 5 * 1024 * 1024 * 1024) {
          checks.push(
            diagWarn(
              "disk.free",
              "Low disk space",
              `${fmtGB(disk.free)} free of ${fmtGB(disk.total)} on data drive.`,
              { category: "storage" },
            ),
          );
        } else {
          checks.push(
            diagOk(
              "disk.free",
              "Disk space healthy",
              `${fmtGB(disk.free)} free of ${fmtGB(disk.total)}.`,
              { category: "storage" },
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
                },
              ),
            );
          } else if (sizeGb > 10) {
            checks.push(
              diagInfo("storage.saveSize", "Save folder large", `${summary}.`, {
                category: "storage",
                meta,
              }),
            );
          } else {
            checks.push(
              diagOk("storage.saveSize", "Save folder healthy", `${summary}.`, {
                category: "storage",
                meta,
              }),
            );
          }
        }
      }
    } catch (e) {
      checks.push(
        diagWarn(
          "storage.error",
          "Storage checks errored",
          `Logs/disk checks could not run: ${e?.message || "unknown"}`,
          { category: "storage" },
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
        if (heapPct >= 90) {
          checks.push(
            diagFail(
              "runtime.heap",
              "Heap usage critical",
              `Heap at ${heapPct.toFixed(0)}% of its limit. ${detail} Restart recommended.`,
              { category: "runtime" },
            ),
          );
        } else if (heapPct >= 75) {
          checks.push(
            diagWarn(
              "runtime.heap",
              "Heap usage high",
              `Heap at ${heapPct.toFixed(0)}% of its limit. ${detail}`,
              { category: "runtime" },
            ),
          );
        } else {
          checks.push(
            diagOk(
              "runtime.heap",
              "Heap usage healthy",
              `${heapPct.toFixed(0)}% of limit. ${detail}`,
              { category: "runtime" },
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
              { category: "runtime" },
            ),
          );
        } else if (usedPct > 90) {
          checks.push(
            diagWarn(
              "runtime.hostMem",
              "Host RAM pressure",
              `${usedPct.toFixed(0)}% used (${fmtGB(totalHostMem - freeHostMem)} / ${fmtGB(totalHostMem)}).`,
              { category: "runtime" },
            ),
          );
        } else {
          checks.push(
            diagOk(
              "runtime.hostMem",
              "Host RAM healthy",
              `${usedPct.toFixed(0)}% used of ${fmtGB(totalHostMem)}.`,
              { category: "runtime" },
            ),
          );
        }

        checks.push(
          diagInfo(
            "runtime.uptime",
            "Panel uptime",
            `${fmtAge(process.uptime() * 1000).replace(" ago", "")}.`,
            { category: "runtime" },
          ),
        );
      }
    } catch (e) {
      checks.push(
        diagWarn(
          "runtime.error",
          "Runtime checks errored",
          `Memory/uptime checks could not run: ${e?.message || "unknown"}`,
          { category: "runtime" },
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
            { category: "updates" },
          ),
        );
      } else {
        checks.push(
          diagWarn(
            "update.steamApi",
            "Steam Workshop API unreachable",
            `Could not reach api.steampowered.com (${steamProbe.error || `HTTP ${steamProbe.statusCode}`}). Mod-update polling and the Workshop crash detector will both go blind.`,
            {
              category: "updates",
              hint: "Check the panel host's outbound HTTPS access.",
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
          checks.push(
            diagFail(
              "runtime.timeSkew",
              "Host clock is wrong",
              `Panel host clock is ${fmt} ${direction} of Steam time. Scheduled tasks will fire at the wrong wall-clock time and HTTPS handshakes may fail.`,
              {
                category: "runtime",
                hint:
                  process.platform === "linux"
                    ? "Run: sudo timedatectl set-ntp true"
                    : "Settings → Date & Time → Set time automatically",
                meta: { skewMs },
              },
            ),
          );
        } else if (absSkew >= 30 * 1000) {
          checks.push(
            diagWarn(
              "runtime.timeSkew",
              "Host clock slightly off",
              `Panel host clock is ${fmt} ${direction} of Steam time.`,
              { category: "runtime", meta: { skewMs } },
            ),
          );
        } else {
          checks.push(
            diagOk(
              "runtime.timeSkew",
              "Host clock in sync",
              `Within ${fmt} of Steam time.`,
              { category: "runtime", meta: { skewMs } },
            ),
          );
        }
      }

      if (panelUpdateChecker?.updateAvailable) {
        const latest =
          panelUpdateChecker.latestRelease?.tag_name ||
          panelUpdateChecker.latestRelease?.name ||
          "newer version";
        checks.push(
          diagInfo(
            "update.panel",
            "Panel update available",
            `${latest} is newer than your installed v${panelUpdateChecker.currentVersion || "?"}.`,
            { category: "updates", hint: "Settings → Updates" },
          ),
        );
      } else if (panelUpdateChecker) {
        checks.push(
          diagOk(
            "update.panel",
            "Panel up to date",
            `Running v${panelUpdateChecker.currentVersion || "?"}.`,
            { category: "updates" },
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
              { category: "updates", hint: "Mods → Update Subscriptions" },
            ),
          );
        } else if ((trackedMods || []).length > 0) {
          checks.push(
            diagOk(
              "update.mods",
              "All mods current",
              `${trackedMods.length} tracked, none flagged for update.`,
              { category: "updates" },
            ),
          );
        }
      }
    } catch (e) {
      checks.push(
        diagWarn(
          "updates.error",
          "Update checks errored",
          `Update checks could not run: ${e?.message || "unknown"}`,
          { category: "updates" },
        ),
      );
    }

    // ─── Aggregate ─────────────────────────────────────────────────────
    const summary = { ok: 0, warn: 0, fail: 0, info: 0, skip: 0 };
    for (const c of checks) summary[c.status] = (summary[c.status] || 0) + 1;
    const overall =
      summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "ok";

    res.json({
      timestamp: new Date().toISOString(),
      overall,
      summary,
      categories: DIAG_CATEGORIES,
      checks,
      durationMs: Date.now() - t0,
    });
  } catch (error) {
    log.error(`Diagnostics failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ─── World Map Diagnostics ───────────────────────────────────────────
// Dedicated checks for everything the World Map page depends on:
// tile CDNs (b42map.com / map.projectzomboid.com), PanelBridge handlers
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

router.get("/worldmap", async (req, res) => {
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
      [b42Probe, b41Probe, b42TopProbe] = await Promise.all([
        probeTile(
          `${PZ_MAP_ROOT}/maps/${b42Dir || "42.19.0"}/base/layer0_files/0/0_0.jpg`,
        ),
        probeTile(
          `${PZ_MAP_ROOT}/maps/41.78.16/base/layer0_files/0/0_0.jpg`,
        ),
        b42Dir && b42TopFormat
          ? probeTile(
              `${PZ_MAP_ROOT}/maps/${b42Dir}/base_top/layer0_files/10/0_0.${b42TopFormat}`,
            )
          : Promise.resolve(null),
      ]);

      if (b42Probe.reachable) {
        checks.push(
          diagOk(
            "worldmap.tiles.b42",
            "B42 tile CDN reachable",
            `Build ${b42Dir || "42.19.0"} responded in ${b42Probe.latencyMs} ms (HTTP ${b42Probe.statusCode}).`,
            { category: "worldmap" },
          ),
        );
      } else {
        checks.push(
          diagFail(
            "worldmap.tiles.b42",
            "B42 tile CDN unreachable",
            `Could not reach map.projectzomboid.com for B42 tiles (${b42Probe.error || `HTTP ${b42Probe.statusCode}`}). The B42 base map will not load.`,
            {
              category: "worldmap",
              hint: "Check the panel host's outbound HTTPS access. The /api/map/tiles proxy fetches tiles server-side.",
            },
          ),
        );
      }

      if (b41Probe.reachable) {
        checks.push(
          diagOk(
            "worldmap.tiles.b41",
            "B41 tile CDN reachable",
            `map.projectzomboid.com responded in ${b41Probe.latencyMs} ms (HTTP ${b41Probe.statusCode}).`,
            { category: "worldmap" },
          ),
        );
      } else {
        checks.push(
          diagWarn(
            "worldmap.tiles.b41",
            "B41 tile CDN unreachable",
            `Could not reach map.projectzomboid.com (${b41Probe.error || `HTTP ${b41Probe.statusCode}`}). B41 fallback tiles will not load.`,
            {
              category: "worldmap",
              hint: "Only relevant if you run a B41 server. Outbound HTTPS to map.projectzomboid.com is required.",
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
            { category: "worldmap" },
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
      checks.push(
        diagWarn(
          "worldmap.tiles.error",
          "Tile reachability probe failed",
          `Tile probe could not complete: ${e?.message || "unknown"}`,
          { category: "worldmap" },
        ),
      );
    }

    // ─── PanelBridge live data ────────────────────────────────────────
    const bridgeStatus = panelBridgeService?.getStatus?.() || null;
    const bridgeRunning = !!bridgeStatus?.isRunning;
    const modConnected = !!bridgeStatus?.modStatus;
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
      checks.push(
        diagWarn(
          "worldmap.bridge.heartbeat",
          "Mod heartbeat stale",
          `Last status.json update was ${Math.round(statusAge / 1000)}s ago. Live map data may be stale.`,
          { category: "worldmap" },
        ),
      );
    } else {
      checks.push(
        diagOk(
          "worldmap.bridge",
          "Live data feed healthy",
          `PanelBridge running, mod connected${statusAge !== null ? `, last heartbeat ${Math.round(statusAge / 1000)}s ago` : ""}.`,
          { category: "worldmap" },
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
              { category: "worldmap" },
            ),
          );
        } else if (saveBuild === "b41") {
          checks.push(
            diagOk(
              "worldmap.save.build",
              "B41 save detected",
              `${saveCount} save(s); using ${saveName} (map_X_Y.bin layout). Map will switch to B41 tile source.`,
              { category: "worldmap" },
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

    res.json({
      timestamp: new Date().toISOString(),
      overall,
      summary,
      checks,
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
router.get("/performance-history", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 60;
    const history = await getPerformanceHistory(limit);
    res.json({ history });
  } catch (error) {
    log.error(`Failed to get performance history: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Record current performance snapshot (called periodically)
router.post("/performance-snapshot", async (req, res) => {
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
router.get("/database", async (req, res) => {
  try {
    const stats = await getDatabaseStats();
    res.json(stats);
  } catch (error) {
    log.error(`Failed to get database stats: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Create manual database backup
router.post("/database/backup", async (req, res) => {
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
router.post("/database/compact", async (req, res) => {
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
router.post("/clear-stale-locks", async (req, res) => {
  try {
    log.info("POST /clear-stale-locks");
    const serverManager = req.app.get("serverManager");
    let running = false;
    try {
      if (typeof serverManager?.checkServerRunning === "function") {
        running = await serverManager.checkServerRunning();
      } else {
        running = !!serverManager?.isRunning;
      }
    } catch {
      running = !!serverManager?.isRunning;
    }
    if (running) {
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
    const deleted = [];
    const failed = [];
    let visited = 0;
    let truncated = false;

    const walk = async (dir) => {
      if (visited >= MAX_FILES) {
        truncated = true;
        return;
      }
      let names;
      try {
        names = await fs.promises.readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (++visited > MAX_FILES) {
          truncated = true;
          return;
        }
        const full = path.join(dir, name);
        let st;
        try {
          st = await fs.promises.stat(full);
        } catch {
          continue;
        }
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
      `Cleared ${deleted.length} stale lock file(s) from ${saveDir} (${failed.length} failed)`,
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
        ".",
    });
  } catch (error) {
    log.error(`Failed to clear stale locks: ${error.message}`);
    res
      .status(500)
      .json({ success: false, error: sanitizeError(error.message) });
  }
});

// Get crash logs (hs_err files from Java crashes)
router.get("/crash-logs", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    const serverPath = serverManager?.serverPath || "";

    // Look for crash logs in common locations
    const crashDirs = [
      serverPath,
      path.join(serverPath, "logs"),
      process.cwd(),
      path.join(process.cwd(), "logs"),
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
            if (
              file.startsWith("hs_err_pid") ||
              (file.includes("crash") && file.endsWith(".log")) ||
              (file.includes("error") && file.endsWith(".log"))
            ) {
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

    res.json({ crashLogs: crashLogs.slice(0, 20) });
  } catch (error) {
    log.error(`Failed to get crash logs: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get crash log content
router.get("/crash-logs/:filename", async (req, res) => {
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

    const searchDirs = [
      serverPath,
      path.join(serverPath, "logs"),
      process.cwd(),
      path.join(process.cwd(), "logs"),
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
router.get("/activity", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const source = req.query.source || "all"; // 'all' | 'rcon' | 'bridge' | 'player' | 'server'

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

    // Player action logs
    if (source === "all" || source === "player") {
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

export default router;
export { logBuffer, getDiskFree };
