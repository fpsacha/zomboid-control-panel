import express from "express";
import compression from "compression";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { permissionsPolicy } from "./middleware/permissionsPolicy.js";
import { logSetupTokenIfNeeded } from "./utils/setupToken.js";
import { computeInlineScriptCspHash } from "./utils/cspScriptHash.js";
import { parseTrustProxySetting } from "./utils/trustProxy.js";
import { isUncompressedBinaryProxyPath } from "./utils/compressionFilter.js";
import { createServer } from "http";
import { createServer as createHttpsServer } from "https";
import { Server } from "socket.io";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import os from "os";
import readline from "readline";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { exec, execSync, spawn } from "child_process";
import cookieParser from "cookie-parser";

import {
  onLog,
  createLogger,
  logSection,
  logBanner,
  logReady,
} from "./utils/logger.js";
const log = createLogger("Panel");
import {
  initDatabase,
  getActiveServer,
  getAllSettings,
  getServers,
  getSetting,
  setSetting,
  flushWrites,
  recordPerformanceSnapshot,
  logServerEvent,
} from "./database/init.js";
import { RconService } from "./services/rcon.js";
import { ServerManager } from "./services/serverManager.js";
import { DockerClient } from "./services/dockerClient.js";
import { setDockerClient } from "./services/managedContainer.js";
import { ModChecker } from "./services/modChecker.js";
import { Scheduler } from "./services/scheduler.js";
import { DiscordBot } from "./services/discordBot.js";
import { BackupService } from "./services/backupService.js";
import { UpdateChecker } from "./services/updateChecker.js";
import { PanelUpdateChecker } from "./services/panelUpdateChecker.js";
import { LogTailer } from "./services/logTailer.js";
import { DiskMonitor } from "./services/diskMonitor.js";
import authService from "./services/auth.js";
import { getRoleByName } from "./services/permissions.js";
import { requireRole } from "./services/auth.js";
import authRoutes from "./routes/auth.js";
import oidcRoutes from "./routes/oidc.js";
import { loadOrCreateCerts } from "./utils/certs.js";
import { sanitizeError, sanitizeErrorParams } from "./utils/sanitize.js";
import { ErrorCode } from "./utils/errorCodes.js";
import { getSftpCachePath } from "./services/panelBridgeSftp.js";
import {
  getEmbeddedPanelBridgeLua,
  compareModVersions,
  writeLuaAtomic,
} from "./utils/embeddedLua.js";
import { isServerObservedRunning } from "./utils/serverStatus.js";
import { discoverMounts } from "./services/mountDiscovery.js";
import { shouldAutoOpenBrowser } from "./utils/browserLaunch.js";

// === Supervisor bootstrap ===
// If the .exe was double-clicked directly (no PANEL_SUPERVISOR_V env var) and
// a Start.bat exists next to it, re-launch ourselves via Start.bat and exit.
// This makes the supervisor path the one and only path on Windows: future
// in-app updates always have the .bat available to do the rename + relaunch.
// Opt out with PANEL_NO_SUPERVISOR=1 (services, nssm wrappers, advanced users).
(function maybeReexecViaSupervisor() {
  try {
    if (process.platform !== "win32") return;
    if (typeof process.pkg === "undefined") return; // dev mode, ignore
    if (process.env.PANEL_SUPERVISOR_V === "2") return; // already supervised
    if (process.env.PANEL_NO_SUPERVISOR === "1") return; // explicit opt-out
    // Strip .new/.new2 suffix when resolving the install dir — we may have
    // been launched from a staged slot.
    const exeDir = path.dirname(process.execPath.replace(/\.new2?$/i, ""));
    const startBat = path.join(exeDir, "Start.bat");
    if (!fs.existsSync(startBat)) return; // legacy install without supervisor
    // Detached so Start.bat survives our exit. windowsHide: false so the
    // user actually sees the supervisor console (closing it stops the panel,
    // which is the same UX as before).
    const child = spawn(
      process.env.ComSpec || "cmd.exe",
      ["/c", "start", "", startBat],
      {
        detached: true,
        stdio: "ignore",
        cwd: exeDir,
        windowsHide: false,
      },
    );
    child.unref();
    // Exit before any service init — we don't want two panels racing for port 3001.
    process.exit(0);
  } catch (err) {
    // Don't block startup on a bootstrap failure; fall through to direct boot.
    console.error(
      "Supervisor bootstrap failed, continuing without it:",
      err.message,
    );
  }
})();

// Prevent EPIPE on stdout/stderr from crashing the process
// (happens when terminal is closed while the exe keeps running)
process.stdout?.on?.("error", (err) => {
  if (err.code !== "EPIPE") throw err;
});
process.stderr?.on?.("error", (err) => {
  if (err.code !== "EPIPE") throw err;
});

// Global error handlers.
// Previously these only logged and deliberately did NOT exit ("keep the app
// running"). After a genuine invariant break the process could end up
// half-dead (leaked handles, a service stuck mid-mutation) yet still "up",
// so failures became silent and hard to diagnose, and the orchestrator
// (systemd/Docker) never got the non-zero exit that would restart a clean
// copy. Now: log, best-effort flush any pending DB writes (bounded by a
// short timeout so a stuck flush can't block the exit), then exit(1) so the
// orchestrator restarts us. EPIPE (broken stdout/stderr, e.g. terminal
// closed) is still swallowed — it's benign and would otherwise loop forever.
function fatalExit(label, err) {
  log.error(`${label}:`, err);
  Promise.race([
    flushWrites().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]).finally(() => process.exit(1));
}

process.on("uncaughtException", (error) => {
  if (error && error.code === "EPIPE") return;
  fatalExit("Uncaught Exception", error);
});

process.on("unhandledRejection", (reason) => {
  fatalExit("Unhandled Rejection", reason);
});

// Graceful shutdown handling
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info(`Received ${signal}, shutting down gracefully...`);

  try {
    // Stop player polling
    stopPlayerPolling();

    // Stop performance polling
    stopPerfPolling();

    // Stop scheduler jobs
    if (scheduler) {
      scheduler.stopAllJobs?.();
    }

    // Stop mod checker
    if (modChecker) {
      modChecker.stop();
    }

    // Stop log tailer
    if (logTailer) {
      logTailer.stopWatching();
    }

    // Stop update checker
    if (updateChecker) {
      updateChecker.stop();
    }

    // Stop panel update checker
    if (panelUpdateChecker) {
      panelUpdateChecker.stop();
    }

    // Stop disk monitor
    if (diskMonitor) {
      diskMonitor.stop();
    }

    // Stop PanelBridge
    if (panelBridge?.isRunning) {
      panelBridge.stop();
    }

    // Stop RCON auto-reconnect and disconnect
    if (rconService) {
      rconService.stopAutoReconnect();
      if (rconService.connected) {
        await rconService.disconnect();
      }
    }

    // Close HTTP server
    httpServer.close(() => {
      log.info("HTTP server closed");
      process.exit(0);
    });

    // Force exit after 10 seconds if graceful shutdown hangs
    setTimeout(() => {
      log.warn("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 10000);
  } catch (error) {
    log.error("Error during shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Routes
import serverRoutes from "./routes/server.js";
import discoveryRoutes from "./routes/discovery.js";
import serversRoutes from "./routes/servers.js";
import serverStatusRoutes from "./routes/serverStatus.js";
import serverFilesRoutes from "./routes/serverFiles.js";
import playerRoutes from "./routes/players.js";
import rconRoutes from "./routes/rcon.js";
import configRoutes from "./routes/config.js";
import schedulerRoutes from "./routes/scheduler.js";
import modsRoutes from "./routes/mods.js";
import chunksRoutes from "./routes/chunks.js";
import discordRoutes from "./routes/discord.js";
import debugRoutes, { addLogToBuffer } from "./routes/debug.js";
import { getDiskFree } from "./utils/diskSpace.js";
import { getSwapInfo } from "./utils/swapInfo.js";
import serverFinderRoutes from "./routes/serverFinder.js";
import panelBridgeRoutes from "./routes/panelBridge.js";
import backupRoutes from "./routes/backup.js";
import mapProxyRoutes from "./routes/mapProxy.js";
import systemRoutes from "./routes/system.js";
import templatesRoutes from "./routes/templates.js";
import dockerRoutes from "./routes/docker.js";
import permissionsRoutes from "./routes/permissions.js";
import panelBridge from "./services/panelBridge.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// trust proxy is OFF by default and must be explicitly opted into via the
// TRUST_PROXY env var (e.g. "1" for a single reverse-proxy hop like
// nginx/caddy in front on a VPS). Leaving this unconditionally on let any
// client that reaches the panel directly (no proxy in front — the common
// LAN/home-server deployment) spoof X-Forwarded-For to dodge IP-keyed rate
// limiting (login, setup, RCON limiters all key on req.ip) and to influence
// the x-forwarded-proto secure-cookie logic.
const trustProxyEnv = process.env.TRUST_PROXY || "";
let trustProxySetting = parseTrustProxySetting(trustProxyEnv);
try {
  app.set("trust proxy", trustProxySetting);
} catch (error) {
  log.warn(
    `Invalid TRUST_PROXY value (${trustProxyEnv}), proxy trust disabled: ${error.message}`,
  );
  trustProxySetting = false;
  app.set("trust proxy", false);
}
if (trustProxySetting) {
  const configuredProxy = Array.isArray(trustProxySetting)
    ? trustProxySetting.join(",")
    : trustProxySetting;
  log.info(
    `trust proxy enabled (${configuredProxy}) via TRUST_PROXY env var`,
  );
}
const httpServer = createServer(app);
let activePanelPort = null;

// HTTPS server — created during startup if certs are available
let httpsServer = null;

// CORS — restrict to known development and production origins
// Must be declared before Socket.IO or Express CORS middleware reference it
const defaultAllowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3001",
];
const allowedOrigins = new Set(defaultAllowedOrigins);
const MAX_CORS_BLOCK_EVENTS = 50;
const MAX_CORS_CUSTOM_ORIGINS = 100;
const MAX_CORS_ORIGIN_LENGTH = 256;
const CORS_DENY_MESSAGE =
  "Origin blocked by panel CORS policy. Open the panel from a local/LAN host, or for first-time reverse-proxy setup set CORS_ORIGINS=https://your-panel-host in the panel environment and restart it. After setup, this origin can be managed in Settings > Remote Access.";
const corsState = {
  allowAll: false,
  allowPrivateNetworks: true,
  debug: false,
  customOrigins: new Set(),
  blocked: [],
  lastLoadedAt: null,
};

function normalizeOrigin(origin) {
  if (typeof origin !== "string") return null;
  const trimmed = origin.trim();
  if (trimmed.length > MAX_CORS_ORIGIN_LENGTH) return null;
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch (_) {
    return null;
  }
}

function parseOriginList(rawOrigins) {
  if (typeof rawOrigins !== "string") return [];
  const parsed = rawOrigins
    .split(/[\n,;]+/)
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);
  return [...new Set(parsed)].slice(0, MAX_CORS_CUSTOM_ORIGINS);
}

function isPrivateNetworkHost(host) {
  if (!host) return false;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    // CGNAT/Tailscale range is 100.64.0.0/10 (second octet 64-127), NOT the
    // whole 100.0.0.0/8. `host.startsWith("100.")` used to match all of
    // 100.0.0.0-100.63.255.255 too, which are regular public IPv4 addresses.
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

function isLikelyLanHostname(host) {
  if (!host) return false;
  const normalized = String(host).trim().toLowerCase();
  if (!normalized) return false;

  // Single-label hostnames like "garage" are typical on home/LAN networks.
  if (/^[a-z0-9-]+$/.test(normalized) && !normalized.includes(".")) {
    return true;
  }

  // Common LAN-only suffixes.
  if (
    normalized.endsWith(".local") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".home") ||
    normalized.endsWith(".internal")
  ) {
    return true;
  }

  return false;
}

function recordCorsBlock(origin, source) {
  if (!corsState.debug) return;
  const normalizedOrigin = typeof origin === "string" ? origin.trim() : "";
  const safeOrigin = normalizedOrigin
    ? normalizedOrigin.slice(0, MAX_CORS_ORIGIN_LENGTH)
    : "null";
  const entry = {
    id: randomUUID(),
    origin: safeOrigin,
    source,
    blockedAt: new Date().toISOString(),
  };
  corsState.blocked.unshift(entry);
  if (corsState.blocked.length > MAX_CORS_BLOCK_EVENTS) {
    corsState.blocked = corsState.blocked.slice(0, MAX_CORS_BLOCK_EVENTS);
  }
}

// Allow dynamic HTTPS origins (will be populated at startup if HTTPS is enabled)
// Capped: this is memoisation of the private-network check, and the Origin
// header is caller-supplied, so an unbounded Set would grow forever. Refusing
// to memoise does not refuse the request.
const MAX_ALLOWED_ORIGINS = 200;
function addAllowedOrigin(origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return;
  if (
    allowedOrigins.size >= MAX_ALLOWED_ORIGINS &&
    !allowedOrigins.has(normalized)
  ) {
    return;
  }
  allowedOrigins.add(normalized);
}

function rebuildAllowedOriginsFromSettings(settings = {}) {
  allowedOrigins.clear();
  for (const origin of defaultAllowedOrigins) {
    addAllowedOrigin(origin);
  }

  const customOrigins = parseOriginList(settings.corsAllowedOrigins || "");
  corsState.customOrigins = new Set(customOrigins);
  for (const origin of customOrigins) {
    addAllowedOrigin(origin);
  }

  const httpsEnabled = settings.httpsEnabled === true;
  const httpsPort = parseInt(settings.httpsPort, 10);
  if (httpsEnabled) {
    addAllowedOrigin(
      `https://localhost:${Number.isNaN(httpsPort) ? 3443 : httpsPort}`,
    );
  }

  // Support CORS_ORIGINS env var for VPS first-time setup
  // (solves chicken-and-egg: can't reach Settings page if CORS blocks you)
  const envOrigins = process.env.CORS_ORIGINS;
  if (envOrigins) {
    const parsed = parseOriginList(envOrigins);
    for (const origin of parsed) {
      addAllowedOrigin(origin);
    }
  }
}

function getCorsDebugSnapshot() {
  return {
    allowAll: corsState.allowAll,
    allowPrivateNetworks: corsState.allowPrivateNetworks,
    debug: corsState.debug,
    customOrigins: [...corsState.customOrigins],
    effectiveAllowedOrigins: [...allowedOrigins].sort(),
    blocked: corsState.blocked,
    blockedCount: corsState.blocked.length,
    lastLoadedAt: corsState.lastLoadedAt,
  };
}

function clearCorsBlockedOrigins() {
  corsState.blocked = [];
}

async function refreshCorsConfig() {
  const settings = await getAllSettings();
  corsState.allowAll = settings?.corsAllowAll === true;
  corsState.allowPrivateNetworks = settings?.corsAllowPrivateNetworks !== false;
  corsState.debug = settings?.corsDebug === true;
  rebuildAllowedOriginsFromSettings(settings || {});
  corsState.lastLoadedAt = new Date().toISOString();

  log.info(
    `CORS config loaded: allowAll=${corsState.allowAll}, privateNetworks=${corsState.allowPrivateNetworks}, customOrigins=${corsState.customOrigins.size}, debug=${corsState.debug}`,
  );

  return getCorsDebugSnapshot();
}

// CORS origin checker — shared between Express and Socket.IO
// Allows localhost + any private/LAN IP (192.168.x, 10.x, 100.x Tailscale, 172.16-31.x)
function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (corsState.allowAll) return true;

  // Browser extension popups (chrome-extension://, moz-extension://,
  // safari-web-extension://) must be checked BEFORE normalizeOrigin, because
  // Node's URL.origin returns the literal string "null" for non-special
  // schemes, which would otherwise drop these origins on the floor.
  if (typeof origin === "string") {
    const lower = origin.toLowerCase();
    if (
      lower.startsWith("chrome-extension://") ||
      lower.startsWith("moz-extension://") ||
      lower.startsWith("safari-web-extension://")
    ) {
      return true;
    }
  }

  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (allowedOrigins.has(normalized)) return true;

  try {
    const url = new URL(normalized);
    // Browser extensions (popup pages) call the panel from origins like
    // chrome-extension://<id> or moz-extension://<id>. We trust these
    // because the request still has to carry a valid JWT to do anything.
    if (
      url.protocol === "chrome-extension:" ||
      url.protocol === "moz-extension:" ||
      url.protocol === "safari-web-extension:"
    ) {
      return true;
    }
    if (
      corsState.allowPrivateNetworks &&
      (isPrivateNetworkHost(url.hostname) || isLikelyLanHostname(url.hostname))
    ) {
      addAllowedOrigin(normalized);
      return true;
    }
  } catch (_) {
    // Unparseable origin: fall through and deny.
  }

  return false;
}

const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        recordCorsBlock(origin, "socket");
        callback(new Error(CORS_DENY_MESSAGE));
      }
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Sets up the optional HTTPS listener from stored settings. Extracted out
// of start() so it can be exercised directly in tests (server/tests/
// httpsSetup.test.js) without booting the rest of the panel (player
// polling, watchdogs, update checkers, etc.) -- the load-bearing case is
// that a bad customKeyPath/customCertPath/httpsPort must degrade to "HTTPS
// off, HTTP unaffected" rather than crashing the whole process, and a
// GOOD config must still actually bring HTTPS up (a fix that merely
// disabled HTTPS unconditionally would also "pass" the negative case).
// Mutates the module-level `httpsServer` binding directly (both here and,
// asynchronously, from the "error" handler below) rather than only
// returning a value, because the async failure case can only be observed
// after this function has already returned its initial result.
export function setupHttpsServer({
  httpsEnabled,
  httpsPort,
  customKeyPath,
  customCertPath,
}) {
  if (!httpsEnabled) return null;

  // loadOrCreateCerts() no longer throws on a bad custom cert/key path
  // (see utils/certs.js), but this try/catch is a second, independent
  // guard against anything unexpected in that path ever taking the whole
  // panel down again -- HTTPS is optional; nothing in here may ever be
  // allowed to reach the global uncaughtException handler and kill the
  // process.
  let certs = null;
  try {
    certs = loadOrCreateCerts(customKeyPath, customCertPath);
  } catch (error) {
    log.error(
      `HTTPS certificate setup failed unexpectedly: ${error.message} — running HTTP only`,
    );
    return null;
  }
  if (!certs) {
    log.warn(
      "HTTPS enabled but certificate generation failed — running HTTP only",
    );
    return null;
  }

  httpsServer = createHttpsServer(certs, app);
  // Add HTTPS origin to allowed list dynamically
  addAllowedOrigin(`https://localhost:${httpsPort}`);
  // Attach the SAME Socket.IO instance to the HTTPS server too, instead of
  // creating a second `Server`. A second instance would have its own auth
  // middleware, rooms, and connection handlers — every `.emit()` in this
  // app targets the module-level `io` (bound only to the HTTP server), so
  // WSS clients would authenticate successfully and then receive NO events
  // at all (no server:status, players:update, perf:snapshot, log:entry,
  // chat:message, panelBridge:*, etc). `io.attach()` binds the existing
  // engine (with its middleware and event handlers already registered) to
  // this additional http.Server.
  io.attach(httpsServer, {
    cors: {
      origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) {
          callback(null, true);
        } else {
          callback(new Error(CORS_DENY_MESSAGE));
        }
      },
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  // Registered BEFORE .listen() -- a listen failure (bad/colliding port,
  // permission denied on a privileged port, etc.) emits 'error'
  // asynchronously, and an httpsServer with no listener for it would
  // otherwise become an uncaught exception that reaches index.js's global
  // handler and calls process.exit(1) (same root cause as the cert-path
  // crash this whole fix addresses, just via .listen() instead of
  // loadOrCreateCerts()). Unlike httpServer's own "error" handler in
  // start(), this one never retries or picks a different port -- HTTPS is
  // the optional, secondary listener here; on any failure it just stays
  // off while HTTP keeps serving on its own already-bound port, loudly
  // logged so the operator can fix the setting.
  httpsServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log.error(
        `HTTPS port ${httpsPort} is already in use. Find the offender with: ${process.platform === "win32" ? `netstat -ano | findstr :${httpsPort}` : `ss -tlnp | grep :${httpsPort}  (or: lsof -i :${httpsPort})`}`,
      );
    }
    log.error(
      `HTTPS server error: ${err.message} — HTTPS disabled, HTTP is unaffected and continues starting normally`,
    );
    httpsServer = null;
  });

  // .listen() also validates its `port` argument SYNCHRONOUSLY before ever
  // reaching the socket layer -- an out-of-range or non-numeric value
  // throws a RangeError/TypeError immediately, which the "error" handler
  // above never sees (it only covers ASYNC failures like EADDRINUSE). Both
  // must be guarded; this is the synchronous half.
  try {
    httpsServer.listen(httpsPort, () => {
      log.info(`HTTPS server listening on port ${httpsPort}`);
    });
  } catch (error) {
    log.error(
      `Invalid HTTPS port ${JSON.stringify(httpsPort)}: ${error.message} — HTTPS disabled, HTTP is unaffected`,
    );
    httpsServer = null;
  }

  return httpsServer;
}

// Security middleware
// HSTS and upgrade-insecure-requests are conditionally enabled:
// - On LAN/HTTP setups: disabled (would break plain HTTP access)
// - On VPS/HTTPS setups: enabled (browser enforces HTTPS)
const httpsDetected =
  process.env.HTTPS === "true" || process.env.FORCE_HSTS === "true";

// Resolved again here (duplicated from the client-dist static-serving setup
// further down this file) because CSP has to be registered before that
// point — this is the one thing both need, computed early rather than
// reordering the rest of the file around it.
const cspClientDistPath =
  typeof process.pkg !== "undefined"
    ? path.join(path.dirname(process.execPath), "client", "dist")
    : path.join(__dirname, "../client/dist");
// See utils/cspScriptHash.js: computed at startup by hashing the real
// shipped file rather than a hardcoded hash, so this can never go stale.
// Returns null if the script can't be found (dist not built, the tag
// renamed/restructured) — script-src deliberately does NOT fall back to
// 'unsafe-inline' in that case. A missing build is a build problem, not a
// security event, so the right failure shape is the page visibly breaking
// (blocked inline script, no theme flash prevention) rather than the
// protection silently loosening on exactly the deployments where
// something is already unusual.
const inlineScriptCspSource = computeInlineScriptCspHash(
  cspClientDistPath,
  log,
);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: inlineScriptCspSource
          ? ["'self'", inlineScriptCspSource]
          : ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        // blob: is required by the World Map tile loader: it fetches each
        // tile, converts the response to a Blob and decodes it through
        // URL.createObjectURL (WorldMap.tsx) so a decode failure can be told
        // apart from a network failure. Without blob: the browser blocks
        // img.src, img.onerror fires, and every such tile is recorded as a
        // coverage failure even though its bytes arrived intact.
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "ws:", "wss:"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: httpsDetected ? [] : null,
      },
    },
    hsts: httpsDetected
      ? { maxAge: 31536000, includeSubDomains: false }
      : false,
    crossOriginEmbedderPolicy: false, // Allow loading resources
  }),
);
app.use(permissionsPolicy());

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        recordCorsBlock(origin, "http");
        log.warn(`CORS blocked request from origin: ${origin}`);
        callback(new Error(CORS_DENY_MESSAGE));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  }),
);

// Tighter body limit for the one route meant to be reachable without a
// login (see the client-errors rate limiter below for the full reasoning):
// message/error/url are truncated to under 2kb server-side regardless, so
// nothing legitimate needs more than a small multiple of that. MUST be
// registered before the app-wide express.json() two lines down — Express
// runs body parsers in registration order, and whichever one reads the
// request stream first is the one whose limit actually applies; a
// path-scoped parser registered after the app-wide one would never run.
app.use("/api/debug/client-errors", express.json({ limit: "16kb" }));

// Body parser with explicit size limit
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// Compress all HTTP responses (gzip/deflate) EXCEPT the <img>-tag-loaded
// binary proxy routes -- see compressionFilter.js for why.
app.use(
  compression({
    threshold: 1024,
    filter: (req, res) => {
      if (isUncompressedBinaryProxyPath(req)) return false;
      return compression.filter(req, res);
    },
  }),
);

// Rate limiting — applied before auth to protect against unauthenticated floods
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 300, // 300 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});
app.use("/api/", apiLimiter);

// Auth middleware — protects all /api/ routes except /api/auth/*
// SSE endpoints can't set custom headers, so we accept ?token= as a fallback
app.use("/api/", (req, res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
});
app.use(authService.middleware());

// Stricter rate limit for destructive/sensitive operations
const strictLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10, // 10 per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded for this operation." },
});
app.use("/api/server/install", strictLimiter);
app.use("/api/server/delete-files", strictLimiter);
// Also covers /wipe/preview, whose save-folder scan is not cheap either.
app.use("/api/server/wipe", strictLimiter);
app.use("/api/server/steam-update", strictLimiter);
app.use("/api/server/steamcmd/download", strictLimiter);
app.use("/api/server/start", strictLimiter);
app.use("/api/server/stop", strictLimiter);
app.use("/api/server/force-stop", strictLimiter);
app.use("/api/server/restart", strictLimiter);
app.use("/api/docker/containers", strictLimiter);
app.use("/api/backup/restore", strictLimiter);
app.use("/api/backup/delete-older-than", strictLimiter);
app.use("/api/backup/upload", strictLimiter);
app.delete("/api/backup/:name", strictLimiter);
app.use("/api/chunks/delete-chunks", strictLimiter);
app.use("/api/chunks/delete-region", strictLimiter);
app.use("/api/server-files/raw", strictLimiter);
app.use("/api/server-files/restore", strictLimiter);
app.use("/api/server-files/save-and-reload", strictLimiter);
app.use("/api/panel-bridge/install-mod", strictLimiter);
app.use("/api/panel-bridge/install-local", strictLimiter);
app.use("/api/panel-bridge/character/export", strictLimiter);
app.use("/api/panel-bridge/character/import", strictLimiter);
app.use("/api/panel/update-check", strictLimiter);
app.use("/api/panel/update-download", strictLimiter);
app.use("/api/panel/update-preflight", strictLimiter);
app.use("/api/panel/restart", strictLimiter);
// Writes server.ini and SandboxVars.lua directly — same risk class as
// server-files/save-and-reload above.
app.use("/api/templates/:id/apply", strictLimiter);
// Browser cookie extraction spawns PowerShell for DPAPI unwrap — expensive
// and platform-sensitive, so keep it under the destructive limiter too.
app.use("/api/mods/collection/extract-cookies", strictLimiter);

// Per-item collection mutations are cheap to the panel, but each one writes
// to Steam. Do not share their bucket with cookie extraction: a normal sync
// flow can legitimately issue more than ten row actions in a minute. Steam
// writes remain serialized by the collection endpoints themselves.
const collectionMutationLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many collection changes. Please wait a minute and try again." },
});
app.use("/api/mods/collection/items", collectionMutationLimiter);

// Mid-tier rate limit for RCON commands (higher than strict, lower than general)
const rconLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60, // 60 commands per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many RCON commands, please slow down." },
});
app.use("/api/rcon/execute", rconLimiter);

// Mid-tier rate limit for direct PanelBridge command endpoint
const panelBridgeCommandLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60, // 60 commands per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many PanelBridge commands, please slow down." },
});
app.use("/api/panel-bridge/command", panelBridgeCommandLimiter);

// server/routes/debug.js's client-errors handler is meant to be reachable
// WITHOUT a login — a crash on the login screen itself is exactly the case
// it exists for — which makes it the one API route that genuinely needs an
// auth exemption on a public panel (that exemption itself lives in
// authService.middleware(), server/services/auth.js). An anonymous,
// always-open endpoint is an obvious abuse target — unbounded writes, log
// flooding, disk exhaustion — so it gets its own tight layer here on top of
// the route's existing per-IP counter and field-length truncation, rather
// than relying on either alone.
const clientErrorLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10, // 10 reports per minute per IP — a real crash storm from one tab
  // still gets through slowly enough to see; sustained abuse does not.
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many error reports, please slow down." },
});
app.use("/api/debug/client-errors", clientErrorLimiter);

// Initialize services
const rconService = new RconService();
const serverManager = new ServerManager();
const dockerClient = new DockerClient();
// Lets the scheduler and the Discord bot route lifecycle actions to Docker
// without threading the client through their constructors.
setDockerClient(dockerClient);
const modChecker = new ModChecker();
const logTailer = new LogTailer();
const scheduler = new Scheduler(rconService, serverManager);
const discordBot = new DiscordBot(
  rconService,
  serverManager,
  scheduler,
  logTailer,
);
const backupService = new BackupService();

// Connect services for cross-communication
rconService.setServerManager(serverManager);
scheduler.setBackupService(backupService);

// Give scheduler and backupService a reference to discordBot so they can
// fire event notifications (scheduledRestart, backupComplete) without
// needing req.app access.
scheduler.setDiscordBot(discordBot);
backupService.setDiscordBot(discordBot);

// Start RCON auto-reconnect for automatic recovery
rconService.startAutoReconnect();

/**
 * Find the PanelBridge path for the active server
 * PZ Lua mod writes to: {serverRuntimePath}/Lua/panelbridge/{serverName}/
 * For dedicated servers, this is usually a Server_files* folder (set via -cachedir)
 */
async function findPanelBridgePath() {
  const activeServer = await getActiveServer();
  if (!activeServer) {
    return { error: "No active server configured" };
  }

  const serverName = activeServer.serverName || activeServer.name;
  if (!serverName) {
    return { error: "Server name not configured" };
  }

  // Check if db.json has a saved bridgePath that exists and has files
  const settings = await getAllSettings();
  if (settings?.panelBridge?.bridgePath) {
    const savedPath = settings.panelBridge.bridgePath;
    const statusFile = path.join(savedPath, "status.json");
    if (fs.existsSync(statusFile)) {
      return { path: savedPath, source: "db.json (saved)", serverName };
    }
  }

  // Build list of possible paths - PZ Lua mod writes to Lua/panelbridge/
  const possiblePaths = [];

  // Helper to safely read directory contents
  const safeReadDir = (dirPath) => {
    try {
      return fs.existsSync(dirPath) ? fs.readdirSync(dirPath) : [];
    } catch (e) {
      return [];
    }
  };

  // PRIORITY 1: zomboidDataPath is where -cachedir points - this is where the mod WRITES status.json
  // This should be checked first since it's explicitly configured for the server
  if (activeServer.zomboidDataPath) {
    possiblePaths.push({
      p: path.join(
        activeServer.zomboidDataPath,
        "Lua",
        "panelbridge",
        serverName,
      ),
      source: "zomboidDataPath/Lua (cachedir)",
      priority: 1,
    });
  }

  // PRIORITY 2: Look for Server_files* folders at parent level (dedicated server runtime data)
  // This is where -cachedir typically points for dedicated servers with separate data folders
  if (activeServer.installPath) {
    const parentDir = path.dirname(activeServer.installPath);
    const parentContents = safeReadDir(parentDir);
    for (const item of parentContents) {
      if (item.startsWith("Server_files") || item.match(/Server.*files/i)) {
        possiblePaths.push({
          p: path.join(parentDir, item, "Lua", "panelbridge", serverName),
          source: `${item}/Lua`,
          priority: 2,
        });
      }
    }
  }

  // PRIORITY 3: Lua folder directly in install path (fallback)
  if (activeServer.installPath) {
    possiblePaths.push({
      p: path.join(activeServer.installPath, "Lua", "panelbridge", serverName),
      source: "installPath/Lua",
      priority: 3,
    });
  }

  // Find first path with existing status.json (bridge is active)
  for (const { p, source } of possiblePaths) {
    const statusFile = path.join(p, "status.json");
    if (fs.existsSync(statusFile)) {
      return { path: p, source, serverName };
    }
  }

  // Check for .init file (bridge initialized but not yet active)
  for (const { p, source } of possiblePaths) {
    const initFile = path.join(p, ".init");
    if (fs.existsSync(initFile)) {
      return { path: p, source: `${source} (.init)`, serverName };
    }
  }

  // Check if any of the paths exist (even if empty - mod may have started writing)
  for (const { p, source } of possiblePaths) {
    if (fs.existsSync(p)) {
      return { path: p, source: `${source} (exists)`, serverName };
    }
  }

  // No existing bridge found - return the best expected path but DON'T create it
  // The directory will be created by the PZ mod when it runs
  if (possiblePaths.length > 0) {
    possiblePaths.sort((a, b) => a.priority - b.priority);
    const bestPath = possiblePaths[0];
    return {
      path: bestPath.p,
      source: `${bestPath.source} (expected)`,
      serverName,
      notCreated: true,
    };
  }

  return {
    error: "No valid bridge path could be determined",
    searchedPaths: possiblePaths.map((x) => x.p),
    serverName,
  };
}

/**
 * Start PanelBridge if a valid bridge path is found
 * This is called both at startup and when RCON connects
 */
async function tryStartPanelBridge(trigger = "unknown") {
  if (panelBridge.isRunning) {
    log.debug(`Already running (trigger: ${trigger})`);
    return true;
  }

  const settings = await getAllSettings();
  if (settings?.panelBridgeSftpEnabled) {
    try {
      const sftpConfig = {
        host: settings.panelBridgeSftpHost,
        port: settings.panelBridgeSftpPort,
        username: settings.panelBridgeSftpUsername,
        password: settings.panelBridgeSftpPassword,
        bridgePath: settings.panelBridgeSftpBridgePath,
        pollIntervalSeconds: settings.panelBridgeSftpPollIntervalSeconds,
      };
      await panelBridge.configureSftp(sftpConfig, getSftpCachePath(sftpConfig));
      log.info(`Started SFTP transport (trigger: ${trigger})`);
      return true;
    } catch (error) {
      log.warn(`Could not start configured SFTP transport: ${error.message}`);
    }
  }

  const result = await findPanelBridgePath();

  if (result.error) {
    log.debug(`${result.error} (trigger: ${trigger})`);
    return false;
  }

  // Auto-update PanelBridge.lua on the PZ server if bundled version is newer
  const autoUpdateEnabled =
    (await getSetting("panelBridgeAutoUpdate")) !== false; // default true
  if (!autoUpdateEnabled) {
    log.debug("PanelBridge mod auto-update disabled by setting");
  }
  if (autoUpdateEnabled)
    try {
      const activeServer = await getActiveServer();
      const serverInstallDir =
        activeServer?.serverPath || activeServer?.installPath;
      if (serverInstallDir) {
        const installDir =
          serverInstallDir.endsWith(".bat") ||
          serverInstallDir.endsWith(".sh") ||
          serverInstallDir.endsWith(".exe")
            ? path.dirname(serverInstallDir)
            : serverInstallDir;
        const destLuaFile = path.join(
          installDir,
          "media",
          "lua",
          "server",
          "PanelBridge.lua",
        );

        // Prefer the Lua content embedded in the binary at bundle time — this is
        // the only source guaranteed to match the running panel version after a
        // binary-only auto-update. Falls back to on-disk pz-mod for dev mode and
        // legacy builds that lack the embedded string.
        let srcContent = getEmbeddedPanelBridgeLua();

        if (!srcContent) {
          const possibleModPaths = [
            path.join(__dirname, "..", "pz-mod", "PanelBridge"),
            path.join(process.cwd(), "pz-mod", "PanelBridge"),
            path.join(path.dirname(process.execPath), "pz-mod", "PanelBridge"),
          ];
          for (const modPath of possibleModPaths) {
            const candidate = path.join(
              modPath,
              "media",
              "lua",
              "server",
              "PanelBridge.lua",
            );
            if (fs.existsSync(candidate)) {
              srcContent = fs.readFileSync(candidate, "utf8");
              break;
            }
          }
        }

        if (srcContent && fs.existsSync(destLuaFile)) {
          const destContent = fs.readFileSync(destLuaFile, "utf8");
          const srcVersion = (srcContent.match(/VERSION\s*=\s*"([^"]+)"/) ||
            [])[1];
          const destVersion = (destContent.match(/VERSION\s*=\s*"([^"]+)"/) ||
            [])[1];
          // Only overwrite if embedded version is STRICTLY newer. If the on-disk
          // Lua is the same or newer (e.g. a dev hand-installed a newer build),
          // leave it alone — silently downgrading would clobber their work.
          if (
            srcVersion &&
            destVersion &&
            compareModVersions(srcVersion, destVersion) > 0
          ) {
            writeLuaAtomic(destLuaFile, srcContent);
            log.info(
              `PanelBridge mod auto-updated on server: ${destVersion} → ${srcVersion}`,
            );
          }
        } else if (srcContent && !fs.existsSync(destLuaFile)) {
          writeLuaAtomic(destLuaFile, srcContent);
          log.info("PanelBridge mod auto-installed to server");
        }
      }
    } catch (modError) {
      log.warn(`Auto-update mod check failed: ${modError.message}`);
    }

  try {
    panelBridge.configure(result.path, true);
    panelBridge.start();
    log.info(`Started from ${result.source} (trigger: ${trigger})`);
    return true;
  } catch (error) {
    log.warn(`Failed to start - ${error.message}`);
    return false;
  }
}

// Auto-start PanelBridge when RCON connects (secondary trigger)
// An async EventEmitter listener that rejects becomes an unhandled rejection,
// which reaches process.on("unhandledRejection") and kills the panel — so
// this is wrapped the same way the sibling "disconnected" handler below is.
rconService.on("connected", async () => {
  try {
    log.info("RCON connected - checking PanelBridge...");
    rconConnectedAt = Date.now();
    // Whoever is online at reconnect was not necessarily a new arrival.
    lastPlayerList = [];
    playerBaselineReady = false;
    await tryStartPanelBridge("rcon-connected");
  } catch (err) {
    log.debug(`RCON-connected PanelBridge check failed: ${err.message}`);
  }
});

rconService.on("disconnected", async () => {
  // When RCON disconnects, check if server actually stopped
  // This gives faster detection than the 10s watchdog interval
  setTimeout(async () => {
    try {
      const running = await getObservedServerRunning();
      if (running === null) {
        log.debug("RCON disconnect status check could not determine process state");
        return;
      }
      if (!running && lastKnownRunning !== false) {
        lastKnownRunning = false;
        log.info(
          "RCON disconnected and server process gone — emitting stopped status",
        );
        io.emit("server:status", { running: false });
        await logServerEvent(
          "server_stop",
          "Server process exited (detected after RCON disconnect)",
        );
        discordBot
          .sendEventNotification("serverStop", {})
          .catch((err) =>
            log.debug(`Discord serverStop notification failed: ${err.message}`),
          );
      }
    } catch (err) {
      log.debug(`Post-RCON-disconnect check failed: ${err.message}`);
    }
  }, 3000); // wait 3s for process to fully exit
});

// Emit PanelBridge status changes to connected clients via Socket.IO
panelBridge.on("started", () => {
  io.emit("panelBridge:status", {
    isRunning: true,
    bridgePath: panelBridge.bridgePath,
  });
});

panelBridge.on("stopped", () => {
  io.emit("panelBridge:status", {
    isRunning: false,
    bridgePath: panelBridge.bridgePath,
  });
});

panelBridge.on("modStatus", (status) => {
  io.emit("panelBridge:modStatus", status);
});

panelBridge.on("configured", ({ path }) => {
  io.emit("panelBridge:configured", { bridgePath: path });
});

// PanelBridge is the preferred source of truth for player presence (its
// heartbeat-gated trackPlayerActivity() is more reliable than RCON polling,
// which can see a player transiently vanish from the list on a network
// hiccup). When the bridge is alive, route Discord join/leave notifications
// and auto-export through ITS connect/disconnect events instead of RCON's —
// see the corresponding guard in startPlayerPolling() below that skips these
// same side effects while the bridge is alive, so they fire exactly once.
panelBridge.on("playerConnect", (playerName) => {
  discordBot
    .sendEventNotification("playerJoin", { player: playerName })
    .catch((err) =>
      log.debug(`Discord playerJoin notification failed: ${err.message}`),
    );
  getSetting("autoExportOnLogin")
    .then((autoExport) => {
      if (autoExport === true || autoExport === "true") {
        setTimeout(() => autoExportPlayer(playerName), 10000);
      }
    })
    .catch(() => {});
});

panelBridge.on("playerDisconnect", (playerName) => {
  discordBot
    .sendEventNotification("playerLeave", { player: playerName })
    .catch((err) =>
      log.debug(`Discord playerLeave notification failed: ${err.message}`),
    );
});

// Make services available to routes
app.set("rconService", rconService);
app.set("serverManager", serverManager);
app.set("dockerClient", dockerClient);
app.set("modChecker", modChecker);
app.set("scheduler", scheduler);
app.set("discordBot", discordBot);
backupService.setServerManager(serverManager);
app.set("backupService", backupService);
app.set("io", io);
app.set("refreshCorsConfig", refreshCorsConfig);
app.set("getCorsDebugSnapshot", getCorsDebugSnapshot);
app.set("clearCorsBlockedOrigins", clearCorsBlockedOrigins);
// A route that just made an unconfirmed claim (e.g. a graceful stop request
// accepted, not yet confirmed) can call this to ask for a prompt re-check
// instead of emitting its own server:status claim -- see checkServerStatusNow's
// own comment below for why that second option is the bug this exists to fix.
app.set("checkServerStatusNow", checkServerStatusNow);

// Initialize update checker (needs io for socket events)
const updateChecker = new UpdateChecker(io, { rconService, serverManager });
app.set("updateChecker", updateChecker);

// Initialize panel self-update checker
const panelUpdateChecker = new PanelUpdateChecker(io);
app.set("panelUpdateChecker", panelUpdateChecker);

// Disk-space monitor for the active server's save volume (P0: a full disk
// during save corrupts worlds). Polls every 60s and emits disk:warning /
// disk:critical / disk:normal over the same socket.
const diskMonitor = new DiskMonitor(io);
app.set("diskMonitor", diskMonitor);

// Auth routes (must be before other API routes)
app.use("/api/auth", authRoutes);
app.use("/api/auth/oidc", oidcRoutes);

// API Routes
app.use("/api/server", serverRoutes);
// Mounted BEFORE serversRoutes: its literal /discover-mounts and
// /create-from-discovery paths must match before servers.js's GET /:id
// catch-all would otherwise swallow them as a server-id lookup.
app.use("/api/servers", discoveryRoutes);
app.use("/api/servers", serversRoutes);
app.use("/api/servers", serverStatusRoutes);
app.use("/api/server-files", serverFilesRoutes);
app.use("/api/players", playerRoutes);
app.use("/api/rcon", rconRoutes);
app.use("/api/config", configRoutes);
app.use("/api/scheduler", schedulerRoutes);
app.use("/api/mods", modsRoutes);
app.use("/api/chunks", chunksRoutes);
app.use("/api/discord", discordRoutes);
app.use("/api/debug", debugRoutes);
app.use("/api/server-finder", serverFinderRoutes);
app.use("/api/panel-bridge", panelBridgeRoutes);
app.use("/api/backup", backupRoutes);
app.use("/api/map", mapProxyRoutes);
app.use("/api/system", systemRoutes);
app.use("/api/templates", templatesRoutes);
app.use("/api/docker", dockerRoutes);
app.use("/api/permissions", permissionsRoutes);

// Health check + panel version
// In exe builds, PANEL_VERSION is injected by esbuild at compile time.
// In dev mode, fall back to reading package.json.
let _pkgVersion;
try {
  _pkgVersion =
    typeof PANEL_VERSION !== "undefined"
      ? PANEL_VERSION
      : JSON.parse(
          fs.readFileSync(path.join(__dirname, "../package.json"), "utf-8"),
        ).version;
} catch {
  _pkgVersion = "0.0.0";
}
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    version: _pkgVersion,
    timestamp: new Date().toISOString(),
  });
});

// Panel info - returns the panel's own address for remote access
app.get("/api/panel-info", async (req, res) => {
  const savedPort = await getSetting("panelPort");
  const PORT = activePanelPort || process.env.PORT || savedPort || 3001;
  const localIp = await serverManager.getLocalIp();
  res.json({
    localIp,
    port: parseInt(PORT, 10),
    url: `http://${localIp}:${PORT}`,
  });
});

// Panel restart endpoint — restarts the panel process (works with exe or node)
// If a downloaded-but-not-applied panel update is staged, hand off to the
// external helper so the exe swap happens after this process exits.
app.post("/api/panel/restart", requireRole("admin"), async (req, res) => {
  log.info("Panel restart requested via API");

  const checker = req.app.get("panelUpdateChecker");
  const isPackaged = typeof process.pkg !== "undefined";
  const isWindows = process.platform === "win32";
  const staged =
    checker && typeof checker.getStagedUpdate === "function"
      ? checker.getStagedUpdate()
      : null;

  // Windows + packaged + staged update → supervisor (Start.bat v2) handoff
  // when available, otherwise legacy spawned-helper.
  if (isPackaged && isWindows && staged) {
    // Preferred path: the panel was launched by Start.bat v2 (PANEL_SUPERVISOR_V=2).
    // We don't run a detached cmd helper at all — we just write a marker and
    // exit with code 75. The .bat handles the rename + relaunch. This avoids
    // every failure mode of the old helper (ASR/AV killing detached scripts,
    // .exe.new having no shell association, TIME_WAIT races on port 3001).
    if (
      typeof checker.isSupervisorAvailable === "function" &&
      checker.isSupervisorAvailable()
    ) {
      try {
        if (checker.isApplying) {
          log.warn(
            "Supervisor restart-and-apply request rejected: another apply is in progress",
          );
          return res.status(409).json({
            error: "An update apply is already in progress.",
            code: "apply_in_progress",
          });
        }
        checker.isApplying = true;
        if (staged.version) {
          await setSetting("pendingPanelUpdate", staged.version);
          await flushWrites();
        }
        const markerPath = checker.writeSupervisorMarker(staged);
        log.info(
          `Staged update will be applied by supervisor (Start.bat v2). Marker: ${markerPath}`,
        );
        res.json({
          success: true,
          message: "Stopping panel for supervisor to apply update...",
          applyingUpdate: true,
          supervisor: true,
        });
        // Exit code 75 tells Start.bat to apply the marker and relaunch.
        setTimeout(() => process.exit(75), 500);
        return;
      } catch (err) {
        log.error(`Could not write supervisor marker: ${err.message}`);
        return res.status(500).json({ error: sanitizeError(err.message) });
      }
    }

    // Legacy path: spawn a detached cmd helper. Kept for installs that
    // haven't yet picked up Start.bat v2 (first run after upgrading from
    // pre-supervisor releases).
    try {
      // Commit the apply: write the pending marker FIRST and flush to disk
      // before we exit. reconcilePendingUpdate() on next boot uses this to
      // detect success/failure. If the flush is skipped we silently lose the
      // ability to warn the user that apply failed.
      if (staged.version) {
        await setSetting("pendingPanelUpdate", staged.version);
        await flushWrites();
      }
      const { helperPath, logPath } = await checker.spawnWindowsApplyHelper();
      log.info(
        `Staged update will be applied by helper: ${helperPath} (log: ${logPath})`,
      );
      res.json({
        success: true,
        message: "Applying staged update...",
        applyingUpdate: true,
      });
      setTimeout(() => process.exit(0), 500);
      return;
    } catch (err) {
      // 409 Conflict for the specific "already in progress" race so the UI
      // can show a tailored message instead of a generic 500.
      if (err.code === "apply_in_progress") {
        log.warn(
          "Restart-and-apply request rejected: another apply is in progress",
        );
        return res.status(409).json({
          error: "An update apply is already in progress.",
          code: "apply_in_progress",
        });
      }
      log.error(`Could not spawn update apply helper: ${err.message}`);
      return res.status(500).json({ error: sanitizeError(err.message) });
    }
  }

  // Linux + packaged + staged update → overwrite in place (safe on Linux), then restart.
  // Track the path to spawn after apply — may differ from process.execPath if we
  // were launched from a .new/.new2 slot (that file gets renamed away).
  let linuxRespawnPath = null;
  if (isPackaged && !isWindows && staged) {
    // Same race protection as Windows: don't let two restart calls both
    // rename the staged file (second call would EEXIST or worse).
    if (checker.isApplying) {
      log.warn(
        "Linux restart-and-apply request rejected: another apply is in progress",
      );
      return res.status(409).json({
        error: "An update apply is already in progress.",
        code: "apply_in_progress",
      });
    }
    checker.isApplying = true;
    try {
      // NOTE: use the statically-imported `fs` here. A runtime `await
      // import('fs')` is emitted by esbuild as a native dynamic import that
      // fails inside the pkg binary with "A dynamic import callback was not
      // specified", which previously broke Restart-and-Apply on Linux.
      const fsp = fs.promises;
      if (staged.version) {
        await setSetting("pendingPanelUpdate", staged.version);
        await flushWrites();
      }
      // Target the canonical binary path (strip any .new/.new2 suffix — if
      // we were launched from a staged file the running execPath may carry
      // that suffix). On Linux overwriting the running binary is safe: the
      // kernel keeps the old inode mapped until this process exits, and the
      // next spawn picks up the new file.
      const targetPath =
        typeof checker.getExeBasePath === "function"
          ? checker.getExeBasePath()
          : staged.exePath;
      // Try atomic rename first. If staged and target are on different
      // filesystems (e.g. /opt vs /home with a tmpfs in between), rename
      // throws EXDEV. Fall back to copy+unlink in that case.
      try {
        await fsp.rename(staged.stagedPath, targetPath);
      } catch (renameErr) {
        if (renameErr.code === "EXDEV") {
          log.warn(
            `Cross-device rename (EXDEV); falling back to copy+unlink for ${staged.stagedPath} → ${targetPath}`,
          );
          await fsp.copyFile(staged.stagedPath, targetPath);
          try {
            await fsp.unlink(staged.stagedPath);
          } catch (unlinkErr) {
            log.warn(
              `Could not remove staged source after copy: ${unlinkErr.message}`,
            );
          }
        } else {
          throw renameErr;
        }
      }
      // chmod is best-effort, but if it fails we MUST verify the file is
      // still executable — otherwise the respawn below will silently die
      // with EACCES and leave the user with no panel.
      try {
        await fsp.chmod(targetPath, 0o755);
      } catch (chmodErr) {
        log.warn(`Could not chmod new binary: ${chmodErr.message}`);
      }
      try {
        await fsp.access(targetPath, fs.constants.X_OK);
      } catch (accessErr) {
        checker.isApplying = false;
        log.error(
          `New binary at ${targetPath} is not executable: ${accessErr.message}`,
        );
        return res.status(500).json({
          error: sanitizeError(
            `Applied update is not executable: ${accessErr.message}`,
          ),
        });
      }
      // Best-effort cleanup of the OTHER staging slot if it exists (e.g.,
      // a previous .new2 left behind by a long-ago apply). Stale staging
      // files would otherwise confuse getStagedUpdate() on next boot.
      try {
        const otherSlot = `${targetPath}.new2`;
        if (fs.existsSync(otherSlot) && otherSlot !== staged.stagedPath) {
          await fsp.unlink(otherSlot);
        }
      } catch (cleanErr) {
        log.debug(`Could not clean other staging slot: ${cleanErr.message}`);
      }
      linuxRespawnPath = targetPath;
      log.info(`Linux staged update applied to ${targetPath}; restarting`);
    } catch (err) {
      // Release the apply guard so the user can retry after fixing whatever
      // failed (e.g. permission, disk full).
      checker.isApplying = false;
      log.error(`Failed to apply Linux staged update: ${err.message}`);
      return res.status(500).json({ error: sanitizeError(err.message) });
    }
  }

  res.json({ success: true, message: "Panel is restarting..." });

  // Short delay so the response can be sent before exit
  setTimeout(async () => {
    try {
      await flushWrites();
    } catch {
      /* best effort */
    }
    // Detect if we're running under an orchestrator that will restart us.
    // - systemd sets INVOCATION_ID (service unit) or NOTIFY_SOCKET
    // - Docker creates /.dockerenv at root (or /run/.containerenv on podman)
    // In those cases we don't self-respawn — the orchestrator handles respawn.
    // Respawning ourselves under systemd causes a duplicate process; under
    // Docker (PID 1) the detached child dies with the container anyway.
    let orchestrated = false;
    if (isPackaged) {
      try {
        if (process.env.INVOCATION_ID || process.env.NOTIFY_SOCKET)
          orchestrated = true;
        if (
          fs.existsSync("/.dockerenv") ||
          fs.existsSync("/run/.containerenv")
        ) {
          orchestrated = true;
        }
      } catch {
        /* best effort */
      }

      if (!orchestrated) {
        // Running as packaged exe standalone — spawn self, then exit.
        // On Linux, prefer the freshly-applied binary path (linuxRespawnPath)
        // since process.execPath may point at a .new slot we just renamed away.
        // On Windows we don't reach this path when a staged update exists
        // (the helper handles it), so process.execPath is safe.
        const respawnTarget = linuxRespawnPath || process.execPath;
        spawn(respawnTarget, [], { detached: true, stdio: "ignore" }).unref();
      } else {
        log.info(
          "Running under orchestrator (systemd/Docker) — exiting for external restart",
        );
      }
    }
    // Exit code matters under an orchestrator. The shipped systemd unit uses
    // `Restart=on-failure` (zomboid-panel.service), which treats exit 0 as a
    // clean shutdown and will NOT restart the panel — so a plain exit(0) here
    // leaves the panel DOWN after every restart or Linux update-apply. Exit
    // non-zero so `on-failure`/`always` units respawn us; Docker
    // `restart: unless-stopped`/`always` restart regardless of code, so this is
    // safe there too. Standalone (already self-respawned) exits 0 as normal.
    process.exit(orchestrated ? 1 : 0);
  }, 1000);
});

// Panel self-update endpoints
app.get("/api/panel/update-check", async (req, res) => {
  try {
    const checker = req.app.get("panelUpdateChecker");
    if (!checker)
      return res
        .status(500)
        .json({ error: "Panel update checker not available" });
    const status = await checker.checkForUpdate();
    res.json(status);
  } catch (error) {
    log.error(`Panel update check failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

app.get("/api/panel/update-status", (req, res) => {
  const checker = req.app.get("panelUpdateChecker");
  if (!checker)
    return res
      .status(500)
      .json({ error: "Panel update checker not available" });
  res.json(checker.getStatus());
});

app.get("/api/panel/update-preflight", async (req, res) => {
  try {
    const checker = req.app.get("panelUpdateChecker");
    if (!checker)
      return res
        .status(500)
        .json({ error: "Panel update checker not available" });
    const result = await checker.preflight();
    res.json(result);
  } catch (error) {
    log.error(`Panel update preflight failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

app.get("/api/panel/update-apply-log", (req, res) => {
  try {
    const checker = req.app.get("panelUpdateChecker");
    if (!checker)
      return res
        .status(500)
        .json({ error: "Panel update checker not available" });
    const log = checker.readMostRecentApplyLog();
    res.json({ log });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Exported (not just inline) so server/tests/errorCodeReachability.test.js
// can call it directly with a fake req/res and assert on the actual res.json
// body -- the three non-Docker-running branches below (already_downloading,
// no_update, and the pass-through for anything else including
// docker_updater_not_configured) hand `result` straight to res.json()
// unmodified; that pass-through, not any single code literal, is the thing
// a future refactor could quietly break.
export async function handlePanelUpdateDownload(req, res) {
    try {
      const checker = req.app.get("panelUpdateChecker");
      if (!checker)
        return res
          .status(500)
          .json({ error: "Panel update checker not available" });

      if (checker.dockerUpdateProxy?.enabled) {
        if (req.body?.confirm !== true) {
          return res.status(400).json({
            error:
              "Confirm the Docker update before recreating the all-in-one container.",
            code: "confirmation_required",
          });
        }

        const processDetails =
          typeof serverManager.getServerProcessDetails === "function"
            ? await serverManager.getServerProcessDetails()
            : null;
        if (!processDetails || processDetails.scanFailed) {
          return res.status(503).json({
            success: false,
            error:
              "Can't verify whether the server is stopped because process detection failed. The Docker update was not started.",
            code: ErrorCode.SERVER_STATE_UNKNOWN,
          });
        }
        const isRunning = Boolean(processDetails.running);
        if (isRunning) {
          const rconService = req.app.get("rconService");
          if (!rconService?.connected) {
            return res.status(409).json({
              error:
                "Stop the Project Zomboid server before applying a Docker update. RCON is not connected, so the panel cannot safely stop it for you.",
              code: ErrorCode.SERVER_RUNNING_RCON_UNAVAILABLE,
            });
          }

          const saved = await rconService.save();
          if (!saved?.success) {
            const reason = saved?.error || "unknown error";
            return res.status(409).json({
              error: `The world could not be saved (${reason}), so the server was left running. Applying the update now would lose everything since the last save.`,
              code: "save_failed",
              params: sanitizeErrorParams({ reason }),
            });
          }
          const quit = await rconService.quit();
          if (!quit?.success) {
            const reason = quit?.error || "unknown error";
            return res.status(502).json({
              error: `The world was saved, but the server could not be shut down (${reason}). It is still running, so the update was not applied.`,
              code: "stop_failed",
              params: sanitizeErrorParams({ reason }),
            });
          }
          await logServerEvent(
            "server_stop",
            "Server stopped before Docker panel update",
          );
        }
      }

      const result = await checker.downloadUpdate();
      if (!result.success) {
        if (result.code === "already_downloading")
          return res.status(409).json(result);
        if (result.code === "no_update") return res.status(400).json(result);
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (error) {
      log.error(`Panel update download failed: ${error.message}`);
      res.status(500).json({ error: sanitizeError(error.message) });
    }
}

export function classifyStartupProcessState(processState, isRemote = false) {
  if (isRemote) {
    return { running: Boolean(processState?.running), unknown: false };
  }
  if (
    !processState ||
    processState.scanFailed ||
    typeof processState.running !== "boolean"
  ) {
    return { running: false, unknown: true };
  }
  return { running: processState.running, unknown: false };
}

app.post(
  "/api/panel/update-download",
  requireRole("admin"),
  handlePanelUpdateDownload,
);

// Serve static files in production
// Detect if running as packaged exe (pkg sets process.pkg)
const isPackaged = typeof process.pkg !== "undefined";
let clientDistPath;

if (isPackaged) {
  // When packaged, client/dist is next to the exe
  clientDistPath = path.join(path.dirname(process.execPath), "client", "dist");
} else {
  // Development mode
  clientDistPath = path.join(__dirname, "../client/dist");
}

log.debug(`Serving client from: ${clientDistPath}`);
// Serve hashed assets with long cache, HTML with no-cache
app.use(
  express.static(clientDistPath, {
    maxAge: "7d",
    immutable: true,
    setHeaders(res, filePath) {
      // HTML must not be cached — it references hashed assets
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

// Global API error handler — sanitize internal details from error responses
// Must be defined before the catch-all route but after all API routes
//
// err.code is forwarded ONLY when it's a member of the ErrorCode registry
// (server/utils/errorCodes.js) — deliberately, not by omission. Without the
// allowlist, forwarding err.code unconditionally would leak Node/third-party
// internals to the browser (ENOENT, ECONNREFUSED, ETIMEDOUT, whatever a
// library happens to throw) — a new exposure nobody asked for. With it, a
// thrown error carrying a REGISTERED code reaches the client with that code
// by default, so every future coded throw doesn't need its own hand-written
// forwarding check at whatever catch block happens to be between it and
// here (see server/tests/errorCodeReachability.test.js for why that
// mattered: it was the difference between the ServerNotConfiguredError bug
// -- code set, silently dropped here -- and the apply_in_progress code that
// only survived because index.js had a manual `err.code === "..."` check
// upstream of this handler). An unregistered code is dropped exactly as
// before this change -- do not "fix" that by widening the allowlist to
// everything; that's the leak this exists to prevent.
const REGISTERED_ERROR_CODES = new Set(Object.values(ErrorCode));
// Exported so server/tests/errorCodeReachability.test.js can assert the
// allowlist both ways directly against the real handler, not a reimplementation.
export function apiErrorHandler(err, req, res, next) {
  log.error(`Unhandled API error on ${req.method} ${req.path}: ${err.message}`);
  const status = err.status || 500;
  const body = { error: sanitizeError(err.message) };
  if (typeof err.code === "string" && REGISTERED_ERROR_CODES.has(err.code)) {
    body.code = err.code;
  }
  res.status(status).json(body);
}
app.use("/api", apiErrorHandler);

// SPA catch-all: serves index.html for any unmatched GET route so React
// Router can handle client-side routing. Uses a path-less app.use()
// middleware instead of app.get("*", ...) -- Express 5's path-to-regexp
// (v6/v8) no longer accepts a bare "*" wildcard route pattern ("Missing
// parameter name at index 1: *"); a path-less middleware sidesteps route
// pattern parsing entirely and works identically on Express 4 and 5. The
// explicit method check reproduces app.get()'s original GET-only behavior
// (non-GET requests to unmatched paths fall through to Express's default
// 404 handling, same as before).
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  if (req.path.startsWith("/api")) {
    res.status(404).json({ error: "API endpoint not found" });
  } else {
    res.sendFile(path.join(clientDistPath, "index.html"), (err) => {
      if (err) {
        log.error(`Failed to serve index.html: ${err.message}`);
        res.status(500).send("Page not available");
      }
    });
  }
});

// Socket.IO authentication middleware
io.use(async (socket, next) => {
  try {
    // Skip auth if no users exist (setup needed) or auth is disabled
    const needsSetup = await authService.needsSetup();
    if (needsSetup) return next();

    const authEnabled = await authService.isAuthEnabled();
    if (!authEnabled) {
      // Auth explicitly disabled: grant full access, but EXPLICITLY -- set a
      // real socket.user rather than leaving it unset, same fix and same
      // reasoning as authService.middleware()'s req.user (services/auth.js):
      // "no socket.user" must mean only one thing (not authenticated,
      // refuse) everywhere downstream, including the subscribe:* capability
      // checks below.
      socket.user = {
        userId: null,
        username: null,
        role: "admin",
        tokenGen: null,
        authDisabled: true,
      };
      return next();
    }

    // Check for token in handshake auth or query params
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) {
      return next(new Error("Authentication required"));
    }

    const payload = await authService.authenticateAccessToken(token);
    if (!payload) {
      return next(new Error("Invalid or expired token"));
    }

    socket.user = payload;
    next();
  } catch (error) {
    next(new Error("Authentication error"));
  }
});

// A room join has no HTTP-style response to refuse with, so the "no
// capability" outcome is simply not joining the room -- the client asked
// for a stream it can't have and silently gets none of it, same effective
// result as requirePermission()'s 403 without inventing a socket-only error
// shape. Mirrors requirePermission()'s own role -> capabilities lookup
// (services/permissions.js) rather than a second, divergent one; fails
// closed on any missing/unresolvable role, same as that function.
export async function socketHasCapability(socket, capability) {
  if (!socket.user) return false;
  try {
    const role = await getRoleByName(socket.user.role);
    return Array.isArray(role?.capabilities) && role.capabilities.includes(capability);
  } catch (error) {
    log.warn(`Could not resolve socket capability "${capability}": ${error.message}`);
    return false;
  }
}

// Socket.IO connection handling
io.on("connection", (socket) => {
  log.debug(
    `Client connected: ${socket.id}${socket.user ? ` (${socket.user.username})` : ""}`,
  );

  socket.on("disconnect", () => {
    log.debug(`Client disconnected: ${socket.id}`);
  });

  // Subscribe to server status updates. GET /api/server/status has no
  // permission gate at all (deliberate -- every logged-in role, and the
  // dashboard itself, needs it), so this room is intentionally open too.
  socket.on("subscribe:status", () => {
    socket.join("server-status");
  });

  // Subscribe to player updates. Mirrors GET /api/players/ (players.js),
  // which requires players.view -- this room carries the same data and
  // must not be reachable by a role that route refuses.
  socket.on("subscribe:players", async () => {
    if (!(await socketHasCapability(socket, "players.view"))) return;
    socket.join("players");
  });

  // Subscribe to logs. Mirrors GET /api/debug/logs (debug.js), which
  // requires diagnostics.manage -- every route in that file is admin-only
  // by design. Without this check, moderator (which does not hold
  // diagnostics.manage) could get the identical live log stream, including
  // RCON command text, just by connecting a socket instead of calling the
  // HTTP route.
  socket.on("subscribe:logs", async () => {
    if (!(await socketHasCapability(socket, "diagnostics.manage"))) return;
    socket.join("logs");
  });

  // Subscribe to performance snapshots. Mirrors POST
  // /api/debug/performance-snapshot (debug.js), also diagnostics.manage.
  socket.on("subscribe:perf", async () => {
    if (!(await socketHasCapability(socket, "diagnostics.manage"))) return;
    socket.join("perf");
  });
  socket.on("unsubscribe:perf", () => {
    socket.leave("perf");
  });
});

// Stream logs to Socket.IO clients
onLog((logEntry) => {
  addLogToBuffer(logEntry.level, logEntry.message, logEntry.source);
  io.to("logs").emit("log:entry", logEntry);
});

// ============================================
// Auto-export player data on login
// ============================================
import { getDataPaths } from "./utils/paths.js";

async function autoExportPlayer(username) {
  try {
    if (!panelBridge.isRunning || !panelBridge.isModConnected()) {
      log.debug(
        `Auto-export skipped for ${username}: PanelBridge not connected`,
      );
      return;
    }
    const result = await panelBridge.sendCommand("exportPlayerData", {
      username,
    });
    if (!result || !result.success) {
      log.warn(
        `Auto-export failed for ${username}: ${result?.error || "unknown error"}`,
      );
      return;
    }

    const { dataDir } = getDataPaths();
    const exportDir = path.join(
      dataDir,
      "exports",
      username.replace(/[^a-zA-Z0-9_-]/g, "_"),
    );
    fs.mkdirSync(exportDir, { recursive: true });

    // Write timestamped export file
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${username.replace(/[^a-zA-Z0-9_-]/g, "_")}_${timestamp}.json`;
    fs.writeFileSync(
      path.join(exportDir, filename),
      JSON.stringify(result.data || result, null, 2),
    );

    // Rotate — keep only the last N exports
    const maxExports = Number(await getSetting("autoExportMaxPerPlayer")) || 3;
    const files = fs
      .readdirSync(exportDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse(); // newest first by name (ISO timestamp)

    if (files.length > maxExports) {
      for (const old of files.slice(maxExports)) {
        fs.unlinkSync(path.join(exportDir, old));
      }
    }

    log.info(
      `Auto-exported character data for ${username} (${files.length > maxExports ? maxExports : files.length} kept)`,
    );
  } catch (err) {
    log.warn(`Auto-export error for ${username}: ${err.message}`);
  }
}

// ============================================
// Server-side player polling for real-time updates
// ============================================
let lastPlayerList = [];
// Set once the first successful poll has established who was already online.
// Inferring this from lastPlayerList being empty swallowed every join onto an
// empty server, which is most of them.
let playerBaselineReady = false;
let playerPollingInterval = null;
let rconConnectedAt = 0; // timestamp of last RCON connect — used for grace period

function startPlayerPolling() {
  // Poll every 5 seconds for player changes
  if (playerPollingInterval) {
    clearInterval(playerPollingInterval);
  }
  lastPlayerList = [];
  playerBaselineReady = false;

  playerPollingInterval = setInterval(async () => {
    try {
      // Only poll if RCON is connected
      if (!rconService.connected) {
        return;
      }

      // Grace period: skip polling for 15s after RCON connects
      // PZ server may accept RCON before it's ready to respond to commands
      if (rconConnectedAt && Date.now() - rconConnectedAt < 15000) {
        return;
      }

      const result = await rconService.getPlayers();
      if (result.success && result.players) {
        const baselineWasReady = playerBaselineReady;
        playerBaselineReady = true;

        // Check if player list has changed
        const currentNames = result.players
          .map((p) => p.name)
          .sort()
          .join(",");
        const lastNames = lastPlayerList
          .map((p) => p.name)
          .sort()
          .join(",");

        if (currentNames !== lastNames) {
          // Detect joins and leaves before updating the baseline
          const currentSet = new Set(result.players.map((p) => p.name));
          const lastSet = new Set(lastPlayerList.map((p) => p.name));
          const joined = result.players.filter((p) => !lastSet.has(p.name));
          const left = lastPlayerList.filter((p) => !currentSet.has(p.name));

          lastPlayerList = result.players;
          // Broadcast to all clients in the 'players' room
          io.to("players").emit("players:update", result.players);
          log.debug(
            `Player list updated: ${result.players.length} players online`,
          );

          // Notify Discord — only after we have an established baseline (skip on
          // the very first poll so we don't fire spurious join events for players
          // who were already online before the panel started).
          // Skip entirely while PanelBridge is alive: its own connect/disconnect
          // events (wired above) already send these same notifications from a
          // more reliable presence source, and firing both would double them up.
          if (baselineWasReady && !panelBridge.modStatus?.alive) {
            for (const p of joined) {
              discordBot
                .sendEventNotification("playerJoin", { player: p.name })
                .catch((err) =>
                  log.debug(
                    `Discord playerJoin notification failed: ${err.message}`,
                  ),
                );
            }
            for (const p of left) {
              discordBot
                .sendEventNotification("playerLeave", { player: p.name })
                .catch((err) =>
                  log.debug(
                    `Discord playerLeave notification failed: ${err.message}`,
                  ),
                );
            }

            // Auto-export character data on login (if enabled)
            const autoExport = await getSetting("autoExportOnLogin");
            if (autoExport === true || autoExport === "true") {
              for (const p of joined) {
                // Delay slightly — player needs to fully load before export works
                setTimeout(() => autoExportPlayer(p.name), 10000);
              }
            }
          }
        }
      }
    } catch (error) {
      // Silently ignore polling errors to avoid log spam
      log.debug(`Player polling error: ${error.message}`);
    }
  }, 5000);
  // Matches perfPollingInterval/statusWatchdogInterval below \u2014 don't let this
  // timer hold the event loop open on its own during graceful shutdown.
  if (playerPollingInterval.unref) playerPollingInterval.unref();

  log.info("Server-side player polling started (5s interval)");
}

function stopPlayerPolling() {
  if (playerPollingInterval) {
    clearInterval(playerPollingInterval);
    playerPollingInterval = null;
    log.info("Server-side player polling stopped");
  }
}

// ============================================
// Performance snapshot polling (host + PZ server)
// ============================================
let perfPollingInterval = null;
let lastCpuInfo = null;

function getCpuUsage() {
  const cpus = os.cpus();
  const total = cpus.reduce(
    (acc, cpu) => {
      const t = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const idle = cpu.times.idle;
      return { total: acc.total + t, idle: acc.idle + idle };
    },
    { total: 0, idle: 0 },
  );

  if (!lastCpuInfo) {
    lastCpuInfo = total;
    return 0;
  }

  const totalDiff = total.total - lastCpuInfo.total;
  const idleDiff = total.idle - lastCpuInfo.idle;
  lastCpuInfo = total;
  return totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;
}

// Disk headroom for the drive holding the world saves. A PZ server that runs
// out of space corrupts saves and silently fails backups, so this belongs on
// the dashboard next to memory. Sampled far less often than memory because it
// moves slowly and statfs can block on a dead mount.
let lastDiskSample = { at: 0, value: null };
const DISK_SAMPLE_INTERVAL_MS = 60000;

async function getDiskSnapshot() {
  const now = Date.now();
  if (now - lastDiskSample.at < DISK_SAMPLE_INTERVAL_MS) {
    return lastDiskSample.value;
  }
  lastDiskSample.at = now;
  try {
    // Measure where the saves actually live, not where the panel happens to
    // be installed. They are usually the same mount, but not always.
    const activeServer = await getActiveServer();
    const target =
      activeServer?.zomboidDataPath ||
      activeServer?.installPath ||
      getDataPaths().dataDir;
    const disk = await getDiskFree(target);
    lastDiskSample.value =
      disk && disk.total > 0
        ? { total: disk.total, used: disk.total - disk.free }
        : null;
  } catch {
    lastDiskSample.value = null;
  }
  return lastDiskSample.value;
}

// Swap headroom, same reasoning as disk above: Linux is a cheap /proc/meminfo
// read, but macOS and Windows shell out (sysctl / a PowerShell CIM query),
// which can be slow or hang on a stuck box -- sampled on its own schedule so
// a slow swap read can't drag down the memory/CPU numbers in the same tick.
let lastSwapSample = { at: 0, value: null };
const SWAP_SAMPLE_INTERVAL_MS = 60000;

async function getSwapSnapshot() {
  const now = Date.now();
  if (now - lastSwapSample.at < SWAP_SAMPLE_INTERVAL_MS) {
    return lastSwapSample.value;
  }
  lastSwapSample.at = now;
  try {
    lastSwapSample.value = await getSwapInfo();
  } catch {
    lastSwapSample.value = null;
  }
  return lastSwapSample.value;
}

async function getPzProcessMemory() {
  // Get PZ server Java process memory from OS
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 5000);

    if (process.platform === "win32") {
      // Windows: Get working set of java.exe processes, find the PZ one
      exec(
        'powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'java.exe\'\\" | Select-Object ProcessId, WorkingSetSize, CommandLine | Format-List"',
        { timeout: 8000 },
        (err, stdout) => {
          clearTimeout(timeout);
          if (err || !stdout) return resolve(null);

          // Parse output — look for PZ server process
          const blocks = stdout
            .split(/ProcessId/)
            .filter((b) =>
              b.toLowerCase().includes("zombie.network.gameserver"),
            );
          if (blocks.length === 0) return resolve(null);

          const wsMatch = blocks[0].match(/WorkingSetSize\s*:\s*(\d+)/i);
          if (!wsMatch) return resolve(null);

          resolve(parseInt(wsMatch[1], 10)); // bytes
        },
      );
    } else {
      // Linux: Use ps to find PZ server RSS
      exec(
        'ps aux --no-headers | grep -i "zombie.network.[Gg]ame[Ss]erver" | grep -v grep',
        { timeout: 5000 },
        (err, stdout) => {
          clearTimeout(timeout);
          if (err || !stdout || !stdout.trim()) return resolve(null);

          // RSS is the 6th column in ps aux (in KB)
          const parts = stdout.trim().split(/\s+/);
          if (parts.length >= 6) {
            const rssKB = parseInt(parts[5], 10);
            if (!isNaN(rssKB)) return resolve(rssKB * 1024); // convert to bytes
          }
          resolve(null);
        },
      );
    }
  });
}

async function startPerfPolling() {
  if (perfPollingInterval) clearInterval(perfPollingInterval);

  // NOTE: this used to wipe performance_history on every startup "so charts
  // start fresh". That meant every restart (including every auto-restart
  // and every update-apply) threw away all history, and a monitoring panel
  // could never show data spanning a restart. RETENTION already caps this
  // collection's size (see database/init.js), so the wipe wasn't needed to
  // bound growth — history now persists across restarts. Use
  // clearPerformanceHistory() from database/init.js for an explicit,
  // user-triggered reset instead.

  // Seed CPU info on first call
  getCpuUsage();

  perfPollingInterval = setInterval(async () => {
    try {
      const hostMem = os.totalmem();
      const hostMemFree = os.freemem();
      const cpuUsage = getCpuUsage();
      const panelMem = process.memoryUsage();

      const pzMemBytes = await getPzProcessMemory();
      const disk = await getDiskSnapshot();
      const swap = await getSwapSnapshot();

      const snapshot = {
        // Host machine
        hostMemTotal: hostMem,
        hostMemUsed: hostMem - hostMemFree,
        cpuUsage,
        // Storage on the drive holding the world saves (null if unreadable)
        hostDiskTotal: disk?.total ?? null,
        hostDiskUsed: disk?.used ?? null,
        // Swap/pagefile headroom (null if could not be determined -- NOT
        // the same as 0, which means swap is genuinely not configured; see
        // utils/swapInfo.js for why that distinction is the whole point)
        hostSwapTotal: swap?.total ?? null,
        hostSwapUsed: swap?.used ?? null,
        // Panel process
        panelMemHeap: panelMem.heapUsed,
        panelMemRss: panelMem.rss,
        // PZ server process (null if not running)
        pzMemUsed: pzMemBytes,
        // Legacy fields (kept for compat with existing charts)
        memoryUsed: panelMem.heapUsed,
        memoryTotal: panelMem.heapTotal,
        // Status
        playerCount: lastPlayerList.length,
        serverRunning: serverManager.isRunning,
      };

      await recordPerformanceSnapshot(snapshot);

      // Broadcast to clients subscribed to the perf room only. This used to
      // also emit to "logs" — anyone subscribed to the log stream got perf
      // spam they never asked for, for no reason (unrelated rooms, no
      // shared subscribers by design).
      io.to("perf").emit("perf:snapshot", snapshot);
    } catch (err) {
      log.debug(`Perf snapshot failed: ${err.message}`);
    }
  }, 60000); // every 60 seconds

  if (perfPollingInterval.unref) perfPollingInterval.unref();
  log.info("Performance polling started (60s interval)");
}

function stopPerfPolling() {
  if (perfPollingInterval) {
    clearInterval(perfPollingInterval);
    perfPollingInterval = null;
  }
}

// ============================================
// Server status watchdog — detects unexpected exits
// ============================================
let statusWatchdogInterval = null;
let lastKnownRunning = null;

export async function getObservedServerRunning() {
  const activeServer = await getActiveServer();
  if (activeServer?.isRemote) {
    return isServerObservedRunning({
      processRunning: false,
      rconConnected: rconService.connected,
      bridgeConnected: panelBridge.isModConnected(),
    });
  }

  const processDetails =
    typeof serverManager.getServerProcessDetails === "function"
      ? await serverManager.getServerProcessDetails()
      : null;

  // A systemd-launched local server can evade strict per-server ownership
  // attribution. RCON and the bridge remain direct evidence that it is alive.
  return isServerObservedRunning({
    processRunning: processDetails?.running,
    rconConnected: rconService.connected,
    bridgeConnected: panelBridge.isModConnected(),
    processScanFailed: !processDetails || processDetails.scanFailed,
  });
}

// One watchdog cycle: observe ground truth, and if it differs from what we
// last actually told clients, broadcast the correction. Runs on the 10s
// interval below AND is exported/registered on `app` (see app.set below) so
// a route that just made an unconfirmed claim -- "shutdown requested",
// not yet "shutdown confirmed" -- can ask for a prompt re-check instead of
// emitting its own competing server:status claim.
//
// 2026-08-26 bug hunt: that second option is what /stop used to do, and it
// created exactly the desync this function exists to prevent. A route-level
// io.emit("server:status", {running:false}) told every client the server
// was down the instant rconService.quit() returned -- which only proves the
// RCON command was accepted, not that PZ's save-and-exit has finished --
// but never touched `lastKnownRunning` below, because it lived in a
// different file and had no reason to know this variable existed. So the
// NEXT tick here observed the process still genuinely running (correct),
// compared it to `lastKnownRunning` which was ALSO still "true" (also
// correct, from this function's own point of view), saw no change, and
// said nothing -- it did not fail to notice, it correctly noticed nothing
// had changed, while a different module had already told every client
// something false. Routing every "did the running state actually change"
// decision through this ONE function, and having every caller ask it to
// re-check rather than assert its own answer, means there is no second copy
// of `lastKnownRunning` anywhere left to drift out of sync with this one.
export async function checkServerStatusNow() {
  try {
    const running = await getObservedServerRunning();
    if (running === null) {
      log.debug("Status watchdog: server state is unknown; skipping transition");
      return;
    }
    if (lastKnownRunning !== null && running !== lastKnownRunning) {
      log.info(
        `Status watchdog: server state changed → ${running ? "running" : "stopped"}`,
      );
      io.emit("server:status", { running });
      if (!running) {
        logServerEvent(
          "server_stop",
          "Server process exited (detected by watchdog)",
        );
        discordBot
          .sendEventNotification("serverStop", {})
          .catch((err) =>
            log.debug(
              `Discord serverStop notification failed: ${err.message}`,
            ),
          );
      } else {
        discordBot
          .sendEventNotification("serverStart", {})
          .catch((err) =>
            log.debug(
              `Discord serverStart notification failed: ${err.message}`,
            ),
          );
      }
    }
    lastKnownRunning = running;
  } catch (err) {
    log.debug(`Status watchdog error: ${err.message}`);
  }
}

function startStatusWatchdog() {
  if (statusWatchdogInterval) clearInterval(statusWatchdogInterval);
  statusWatchdogInterval = setInterval(checkServerStatusNow, 10000); // check every 10 seconds
  if (statusWatchdogInterval.unref) statusWatchdogInterval.unref();
  log.info("Server status watchdog started (10s interval)");
}

// Process detection can fail with wrappers (WinGSM) or restricted permissions.
// When that happens on startup, probe the RCON port directly as a fallback so we
// don't wait 60s for auto-reconnect. This only makes sense for a server the
// operator actually configured — without one, "host/port" is just the hardcoded
// default, and probing it means repeatedly trying to authenticate against
// whatever unrelated process happens to hold that port on the host.
// Exported for testing. `rconServiceInstance` is injected so tests can pass a
// stub instead of the real singleton; production always calls it with `rconService`.
// Returns whether the RCON port was found occupied.
export async function probeRconFallbackIfConfigured(
  activeServer,
  rconServiceInstance,
  timeoutMs,
) {
  if (!activeServer) {
    log.debug(
      "No server configured yet — skipping RCON port fallback probe",
    );
    return false;
  }

  let rconPortOccupied = false;
  try {
    await rconServiceInstance.loadConfig();
    const rconHost = rconServiceInstance.config.host || "127.0.0.1";
    const rconPort = rconServiceInstance.config.port || 27015;
    const portOpen = await rconServiceInstance.checkPortOpen(
      rconHost,
      rconPort,
    );
    if (portOpen) {
      rconPortOccupied = true;
      log.info(
        `RCON port ${rconHost}:${rconPort} is open even though process check failed — connecting...`,
      );
      try {
        await Promise.race([
          rconServiceInstance.connect(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("RCON connection timeout")),
              timeoutMs,
            ),
          ),
        ]);
        if (rconServiceInstance.connected) {
          log.info("RCON connected via port fallback probe");
        }
      } catch (e) {
        log.debug(`Fallback RCON connect failed: ${e.message}`);
      }
    }
  } catch (e) {
    log.debug(`Fallback RCON probe error: ${e.message}`);
  }
  return rconPortOccupied;
}

// Every /api/* route (except /api/auth/*, /api/health, and the two <img>-tag
// proxy allowlists) is unauthenticated while first-run setup is pending —
// see authService.middleware(). That's necessary so the setup wizard can run
// before any password exists, and on a LAN it closes in the seconds it takes
// to open the setup page. Exposed to the internet, it's a race: whoever
// reaches the panel first can complete setup and claim the admin account —
// or use any other route — before the real operator does. This can't be
// fixed by code alone (the panel can't know its own reachability), so it's
// surfaced as loudly as possible instead, at the exact moment an operator
// would otherwise assume "it's running, so it's protected".
// Exported for testing; authServiceInstance and loggerInstance are injected
// so tests don't need a real database or to reach into the shared Winston
// singleton (createLogger() returns a fresh child logger per call, so a test
// spying on its own instance would never see calls made through this file's
// own module-level `log`). Production always calls it with authService/log.
export async function logExposureWarningIfNeeded({
  needsSetup,
  boundPort,
  localIp,
  authServiceInstance = authService,
  loggerInstance = log,
}) {
  const reachableUrl =
    localIp && localIp !== "127.0.0.1"
      ? `http://${localIp}:${boundPort}`
      : `http://<this-machine>:${boundPort}`;

  if (needsSetup) {
    loggerInstance.warn(
      "SECURITY: no admin account exists yet. Every API route is open to " +
        `anyone who can reach ${reachableUrl} until first-run setup completes. ` +
        "If this port reaches the internet, complete setup immediately or " +
        "block the port at your firewall/router until you have.",
    );
    return;
  }

  const authEnabled = await authServiceInstance.isAuthEnabled();
  if (!authEnabled) {
    loggerInstance.warn(
      "SECURITY: authentication is disabled. Every API route is open to " +
        `anyone who can reach ${reachableUrl}. Re-enable authentication ` +
        "before exposing this port beyond a trusted LAN.",
    );
  }
}

// Initialize and start server
async function start() {
  try {
    // ── Banner ──
    let panelVersion;
    try {
      panelVersion =
        typeof PANEL_VERSION !== "undefined"
          ? PANEL_VERSION
          : JSON.parse(
              fs.readFileSync(path.join(__dirname, "../package.json"), "utf-8"),
            ).version;
    } catch {
      panelVersion = "0.0.0";
    }
    logBanner(panelVersion);

    // ── Single-instance lock ──
    // Prevents two panels racing on the same data folder, which causes
    // EADDRINUSE restart loops (systemd respawn vs. live process) and
    // db.json rename races.
    try {
      const { acquireLock } = await import("./utils/pidLock.js");
      const { getDataPaths } = await import("./utils/paths.js");
      const { dataDir } = getDataPaths();
      const lockResult = acquireLock(dataDir);
      if (!lockResult.acquired) {
        log.error(`Refusing to start: ${lockResult.reason}.`);
        log.error(
          `If you're sure no other panel is running, delete ${lockResult.lockPath} and try again.`,
        );
        // Dedicated exit code (not the generic 1) so Start.bat's supervisor
        // can tell "deliberately refused, retrying is pointless" apart from
        // a real crash -- retrying this exact condition is guaranteed to
        // fail identically every time, so it must not enter the crash-loop
        // backoff/relaunch path the way an unrecovered crash should.
        process.exit(78);
      }
    } catch (err) {
      log.warn(`Lock check skipped: ${err.message}`);
    }

    // ── Database ──
    logSection("Database");
    await initDatabase();
    await refreshCorsConfig();
    log.info("Database ready");

    // ── Authentication ──
    await authService.init();

    // ── CLI: --reset-password ──
    if (process.argv.includes("--reset-password")) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

      let users;
      try {
        users = await authService.getUsers();
      } catch (err) {
        console.log(`\n  ERROR: Could not read users: ${err.message}\n`);
        rl.close();
        process.exit(1);
      }

      if (users.length === 0) {
        console.log(
          "\n  No user accounts exist. Start the panel normally to run setup.\n",
        );
        rl.close();
        process.exit(0);
      }

      console.log("\n  ╔══════════════════════════════════════╗");
      console.log("  ║     Password Reset (CLI Mode)        ║");
      console.log("  ╚══════════════════════════════════════╝");
      console.log(`\n  Admin account: ${users[0].username}`);
      const newPassword = await ask("  Enter new password (min 6 chars): ");

      if (!newPassword || newPassword.length < 6) {
        console.log("  ERROR: Password must be at least 6 characters.\n");
        rl.close();
        process.exit(1);
      }

      if (newPassword.length > 128) {
        console.log("  ERROR: Password must be 128 characters or fewer.\n");
        rl.close();
        process.exit(1);
      }

      const confirm = await ask("  Confirm new password: ");
      if (newPassword !== confirm) {
        console.log("  ERROR: Passwords do not match.\n");
        rl.close();
        process.exit(1);
      }

      try {
        const result = await authService.resetPassword(newPassword);
        console.log(`\n  Password reset successful for: ${result.username}`);
        console.log("  All existing sessions have been invalidated.\n");
      } catch (err) {
        console.log(`  ERROR: ${err.message}\n`);
        rl.close();
        process.exit(1);
      }

      rl.close();
      process.exit(0);
    }

    const needsSetup = await authService.needsSetup();
    if (needsSetup) {
      log.info("No users found — first-run setup required");
    } else {
      const authEnabled = await authService.isAuthEnabled();
      log.info(`Authentication: ${authEnabled ? "enabled" : "disabled"}`);
    }

    // ── Services ──
    logSection("Services");

    // Initialize log tailer
    await logTailer.init();

    // Broadcast live chat messages to Socket.IO clients. The id needs a
    // counter: one log chunk emits several lines within the same millisecond,
    // and the client discards a message whose id it has already seen.
    let chatMessageSeq = 0;
    logTailer.on("chatMessage", (data) => {
      io.emit("chat:message", {
        id: `${Date.now()}-${chatMessageSeq++}`,
        type: data.type || "general",
        author: data.author,
        message: data.message,
        timestamp: data.timestamp,
      });
    });

    // Player death events parsed from B42 user.txt — forward to Discord
    // and persist as a player action so it shows up in player history.
    logTailer.on("playerDeath", async (data) => {
      try {
        const { logPlayerAction } = await import("./database/init.js");
        logPlayerAction(
          data.player,
          "death",
          `${data.pvp ? "PvP" : "non-pvp"} death at (${data.location})`,
        ).catch((err) =>
          log.debug(`Failed to log player death: ${err.message}`),
        );
      } catch (err) {
        log.debug(`playerDeath DB log failed: ${err.message}`);
      }
      discordBot
        .sendEventNotification("playerDeath", {
          player: data.player,
          x: String(data.x),
          y: String(data.y),
          z: String(data.z),
          location: data.location,
          pvp: data.pvp ? "PvP" : "non-pvp",
        })
        .catch((err) =>
          log.debug(`Discord playerDeath notification failed: ${err.message}`),
        );
      io.emit("player:death", data);
    });

    // Initialize scheduler first (needed by modChecker for auto-restart)
    await scheduler.init();

    // Initialize mod checker with scheduler, serverManager, and socket.io
    await modChecker.init(scheduler, serverManager, io);

    // Start mod checker if workshop ACF file is found
    if (modChecker.workshopAcfPath) {
      modChecker.start();
    } else {
      log.info(
        "Mod checker: Workshop ACF not found — configure server install path",
      );
    }

    // Initialize Discord bot
    await discordBot.loadConfig();
    const discordAutoStart = await getSetting("discordAutoStart");
    if (discordBot.token && discordBot.guildId && discordAutoStart !== false) {
      await discordBot.start();
    } else if (
      discordBot.token &&
      discordBot.guildId &&
      discordAutoStart === false
    ) {
      log.info("Discord bot configured but auto-start is disabled");
    }

    // ── Server Detection ──
    logSection("Server Detection");

    // Check if PZ server is already running and auto-configure services
    // Run this in the background so it doesn't block server startup
    (async () => {
      try {
        // Wait a moment for everything to initialize
        await new Promise((r) => setTimeout(r, 1000));

        // STEP 1: Try to start PanelBridge first (file-based, independent of RCON)
        // This works even if RCON isn't connected yet
        const bridgeStarted = await tryStartPanelBridge("startup");
        if (bridgeStarted) {
          log.info(
            "PanelBridge started on startup (found active bridge files)",
          );
        }

        // STEP 2: Check if PZ server is running and connect RCON
        const timeoutMs = 15000;
        const activeServer = await getActiveServer();
        const processState = await Promise.race([
          activeServer?.isRemote
            ? Promise.resolve({
                running: rconService.connected || panelBridge.isModConnected(),
                scanFailed: false,
              })
            : serverManager.getServerProcessDetails(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Server check timeout")),
              timeoutMs,
            ),
          ),
        ]);
        const startupState = classifyStartupProcessState(
          processState,
          Boolean(activeServer?.isRemote),
        );
        const processStateUnknown = startupState.unknown;
        const isRunning = startupState.running;

        if (isRunning || processStateUnknown) {
          log.info(
            processStateUnknown
              ? "PZ server process state is unknown - trying RCON but will not auto-start"
              : "PZ server detected running - connecting RCON...",
          );

          // Try to connect RCON with retries
          let connected = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              await Promise.race([
                rconService.connect(),
                new Promise((_, reject) =>
                  setTimeout(
                    () => reject(new Error("RCON connection timeout")),
                    timeoutMs,
                  ),
                ),
              ]);

              if (rconService.connected) {
                connected = true;
                log.info(`RCON connected on attempt ${attempt}`);
                break;
              }
            } catch (e) {
              log.debug(
                `RCON connection attempt ${attempt} failed: ${e.message}`,
              );
              if (attempt < 3) {
                await new Promise((r) => setTimeout(r, 5000)); // Wait 5s before retry
              }
            }
          }

          if (!connected) {
            log.warn(
              "RCON connection failed after 3 attempts - auto-reconnect will keep trying",
            );
          }
        } else {
          log.info("PZ server not detected running on startup");

          const rconPortOccupied = await probeRconFallbackIfConfigured(
            activeServer,
            rconService,
            timeoutMs,
          );

          // Check if auto-start is enabled
          const autoStartServer = await getSetting("autoStartServer");
          if (autoStartServer === true || autoStartServer === "true") {
            // SAFETY: Do NOT auto-start if the RCON port is occupied.
            // Something is already listening on it (likely the PZ server that process
            // detection missed). Starting a duplicate would crash on port conflict.
            if (rconPortOccupied) {
              log.warn(
                "Auto-start SKIPPED: RCON port is already occupied — a PZ server is likely running but process detection failed. Will keep retrying RCON connection.",
              );
              rconService.setServerStarting(false);
            } else {
              log.info("Auto-start is enabled - starting PZ server...");

              // Set flag to prevent auto-reconnect from interfering
              rconService.setServerStarting(true);

              try {
                const startResult = await serverManager.startServer();
                if (startResult.success) {
                  log.info("PZ server auto-started successfully");

                  // Wait for server to fully start before connecting RCON
                  // Monitor the TCP port instead of hard waiting
                  log.info("PZ server auto-started - Monitoring RCON port...");

                  await rconService.loadConfig(); // Ensure clean config
                  const rconHost = rconService.config.host || "127.0.0.1";
                  const rconPort = rconService.config.port || 27015;

                  const maxPollAttempts = 60; // 5 minutes max

                  for (let i = 0; i < maxPollAttempts; i++) {
                    // Check port readiness
                    const portOpen = await rconService.checkPortOpen(
                      rconHost,
                      rconPort,
                    );

                    if (!portOpen) {
                      // Log every 30s
                      if (i % 6 === 0) {
                        log.debug(
                          `Auto-start: Waiting for RCON port ${rconHost}:${rconPort}...`,
                        );
                      }
                      await new Promise((r) => setTimeout(r, 5000));
                      continue;
                    }

                    // Port is open, try to connect
                    log.info(`RCON port open! Attempting connection...`);

                    try {
                      await Promise.race([
                        rconService.connect(),
                        new Promise((_, reject) =>
                          setTimeout(
                            () => reject(new Error("RCON connection timeout")),
                            15000,
                          ),
                        ),
                      ]);

                      if (rconService.connected) {
                        log.info(
                          "RCON connected successfully after auto-start",
                        );
                        break;
                      } else {
                        // Port open but auth/handshake failed
                        log.debug(
                          "RCON port open but connection failed, retrying in 5s...",
                        );
                        await new Promise((r) => setTimeout(r, 5000));
                      }
                    } catch (e) {
                      log.debug(
                        `Auto-start RCON connection failed: ${e.message}`,
                      );
                      await new Promise((r) => setTimeout(r, 5000));
                    }
                  }
                } else {
                  log.error(
                    "Failed to auto-start PZ server:",
                    startResult.error,
                  );
                }
              } catch (e) {
                log.error("Error during auto-start:", e.message);
              } finally {
                // Clear the flag so auto-reconnect can resume normally
                rconService.setServerStarting(false);
              }
            }
          }

          // Even if server isn't running, Panel Bridge might have stale files
          // The bridge will detect the mod isn't responding via status timestamp
        }
      } catch (e) {
        log.debug(`Startup initialization: ${e.message}`);
      }
    })();

    // Start server-side player polling for real-time updates
    startPlayerPolling();

    // Start performance snapshot polling (host + PZ server stats)
    startPerfPolling();

    // Start status watchdog (detects unexpected server exits)
    startStatusWatchdog();

    // Start update checker for server updates
    updateChecker.start();

    // Start panel self-update checker
    panelUpdateChecker.start(_pkgVersion);

    // Start disk-space monitor for the active server's save volume
    diskMonitor.start();

    // Read panel port from DB (saved via Settings UI), fallback to env or 3001
    const savedPort = await getSetting("panelPort");
    const configuredPort = Number(process.env.PORT || savedPort || 3001);
    const PORT = Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535
      ? configuredPort
      : 3001;
    let listenPort = PORT;

    // ── HTTPS Setup ──
    const httpsEnabled = await getSetting("httpsEnabled");
    const httpsPort = (await getSetting("httpsPort")) || 3443;
    const customKeyPath = await getSetting("httpsKeyPath");
    const customCertPath = await getSetting("httpsCertPath");

    setupHttpsServer({ httpsEnabled, httpsPort, customKeyPath, customCertPath });

    // Retry logic for EADDRINUSE (nodemon restarts can overlap)
    let listenRetries = 0;
    const maxListenRetries = 5;
    const listenWithRetry = () => {
      httpServer.listen(listenPort, async () => {
        const address = httpServer.address();
        const boundPort = address && typeof address === "object" ? address.port : listenPort;
        activePanelPort = boundPort;
        if (listenPort === 0 && !process.env.PORT && boundPort !== PORT) {
          await setSetting("panelPort", boundPort);
          await flushWrites();
          log.warn(`Configured panel port ${PORT} was unavailable; switched to free port ${boundPort} and saved it.`);
        }
        logSection("Ready");
        const urls = [{ label: "Local: ", url: `http://localhost:${boundPort}` }];
        if (httpsServer) {
          urls.push({
            label: "HTTPS: ",
            url: `https://localhost:${httpsPort}`,
          });
        }

        // Use the configured host address in Docker rather than its bridge IP.
        const localIp = await serverManager.getLocalIp();
        if (localIp !== "127.0.0.1") {
          urls.push({
            label: "Network:",
            url: `http://${localIp}:${boundPort}`,
          });
        }
        logReady(urls);
        await logExposureWarningIfNeeded({ needsSetup, boundPort, localIp });
        await logSetupTokenIfNeeded(needsSetup);

        // If PZ server files were bind-mounted in but no server profile has
        // been created yet, point the user at Settings instead of leaving
        // them to guess a Docker mount path manually.
        try {
          const existingServers = await getServers();
          if (!existingServers || existingServers.length === 0) {
            const mounts = discoverMounts();
            if (mounts.length > 0) {
              log.info(
                `PZ server files detected at ${mounts[0].installPath} — visit Settings to connect`,
              );
            }
          }
        } catch (err) {
          log.debug(`Mount auto-discovery check failed: ${err.message}`);
        }

        // Linux/CentOS: Check for common issues at startup
        if (process.platform !== "win32") {
          // Warn if running as root
          if (process.getuid && process.getuid() === 0) {
            log.warn(
              "Running as root is not recommended. Create a dedicated user: useradd -r -m pzuser",
            );
          }
          // Check inotify limits (CentOS default is often too low)
          try {
            const maxWatches = fs
              .readFileSync("/proc/sys/fs/inotify/max_user_watches", "utf8")
              .trim();
            if (parseInt(maxWatches, 10) < 65536) {
              log.warn(
                `Low inotify limit (${maxWatches}). File watching may fail. Fix: sudo sysctl -w fs.inotify.max_user_watches=524288`,
              );
            }
          } catch (e) {
            log.debug(`inotify check skipped: ${e.message}`);
          }
          // Check glibc version (panel binary requires 2.28+)
          try {
            const lddOut = execSync("ldd --version 2>&1 || true", {
              encoding: "utf8",
              timeout: 5000,
            });
            const glibcMatch = lddOut.match(/(\d+)\.(\d+)/);
            if (glibcMatch) {
              const major = parseInt(glibcMatch[1], 10);
              const minor = parseInt(glibcMatch[2], 10);
              if (major < 2 || (major === 2 && minor < 28)) {
                log.warn(
                  `glibc ${major}.${minor} detected — panel requires glibc 2.28+. CentOS 7 is not supported, use CentOS Stream 8+ or Docker.`,
                );
              } else {
                log.info(`glibc ${major}.${minor} detected`);
              }
            }
          } catch (e) {
            log.debug(`glibc version check skipped: ${e.message}`);
          }
          if (!fs.existsSync("/proc/self/status")) {
            log.warn(
              "/proc not fully available — process detection may be limited (containerized environment?)",
            );
          }
          // Check for 32-bit libs (needed by SteamCMD)
          try {
            if (
              !fs.existsSync("/lib/ld-linux.so.2") &&
              !fs.existsSync("/usr/lib/ld-linux.so.2")
            ) {
              log.warn(
                "32-bit glibc not found (ld-linux.so.2). SteamCMD requires: sudo yum install glibc.i686 libstdc++.i686 (CentOS) or sudo dpkg --add-architecture i386 && sudo apt install lib32gcc-s1 (Ubuntu)",
              );
            }
          } catch (e) {
            log.debug(`32-bit libs check skipped: ${e.message}`);
          }
        }

        // Auto-open browser when running as packaged exe
        if (typeof process.pkg !== "undefined" && shouldAutoOpenBrowser()) {
          const protocol = httpsServer ? "https" : "http";
          const url = `${protocol}://localhost:${httpsServer ? httpsPort : boundPort}`;

          // Skip auto-open on headless Linux (no display server)
          if (
            process.platform !== "win32" &&
            process.platform !== "darwin" &&
            !process.env.DISPLAY &&
            !process.env.WAYLAND_DISPLAY
          ) {
            log.debug(
              `Panel running at ${url} (no display detected — skipping browser open)`,
            );
          } else {
            const openCmd =
              process.platform === "win32"
                ? `start "" "${url}"`
                : process.platform === "darwin"
                  ? `open "${url}"`
                  : `xdg-open "${url}"`;
            exec(openCmd, (err) => {
              if (err) log.error("Failed to open browser:", err);
            });
          }
        }
      });
    };

    httpServer.on("error", (err) => {
      if (err.code === "EADDRINUSE" && listenRetries < maxListenRetries) {
        listenRetries++;
        const delay = Math.min(1000 * listenRetries, 4000);
        log.warn(
          `Port ${PORT} busy, retrying in ${delay}ms (attempt ${listenRetries}/${maxListenRetries})...`,
        );
        setTimeout(listenWithRetry, delay);
      } else if (err.code === "EADDRINUSE") {
        if (!process.env.PORT) {
          listenRetries = 0;
          listenPort = 0;
          log.warn(
            `Port ${PORT} remained unavailable after ${maxListenRetries} retries; selecting a free port automatically.`,
          );
          setTimeout(listenWithRetry, 0);
          return;
        }
        log.error(`Port ${PORT} is in use and PORT is explicitly set; refusing to choose a different port.`);
        log.error(`Find the offender with: ${process.platform === "win32" ? `netstat -ano | findstr :${PORT}` : `ss -tlnp | grep :${PORT}  (or: lsof -i :${PORT})`}`);
        process.exit(1);
      } else {
        log.error(`Server error: ${err.message}`);
        process.exit(1);
      }
    });

    listenWithRetry();
  } catch (error) {
    log.error("Failed to start server:", error);
    process.exit(1);
  }
}

// Skip the real auto-start when this module is imported by the test runner
// (Vitest sets process.env.VITEST) — otherwise merely importing a function for
// unit testing would spin up the whole Express app, sockets and timers as a
// side effect. Vitest sets this var; it's never set in a real deployment, so
// production startup is unaffected.
//
// The more precise "was I run directly" ESM entry-point idiom (comparing
// process.argv[1] against this file, e.g. via path.resolve/realpathSync) was
// considered instead, since it asks the question we actually mean rather
// than inferring it from a test-runner env var. It's deliberately NOT used
// here: this app also ships as a pkg-bundled executable (see build.js /
// `npm run build:exe`, and utils/paths.js's own isPkg check above), where
// process.argv[1] and import.meta.url don't behave like a normal on-disk
// module — pkg snapshots the filesystem and rewrites module resolution, and
// that comparison is a known trouble spot in bundled builds. Getting it
// wrong there would mean the *packaged app* — the primary way operators run
// this — silently never calls start(). A stray VITEST=true in a real
// deployment is a far more contained and unlikely failure than that.
if (!process.env.VITEST) {
  start();
}

export { io };
