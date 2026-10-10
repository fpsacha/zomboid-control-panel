// Must be the FIRST import in this file: it refuses to start (with one
// clear diagnostic) if the root-first-run trap has left dataDir/logsDir
// unreachable to this account. server/utils/setupToken.js below already
// transitively imports database/init.js, which has its own unguarded
// fs.mkdirSync in top-level module code -- ESM evaluates that side effect
// during import resolution, before any of this file's own statements run,
// so this check has to be evaluated even earlier than that import. See
// server/utils/firstRunOwnershipCheck.js's header for the full reasoning.
import "./utils/firstRunOwnershipCheck.js";
import express from "express";
import compression from "compression";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { permissionsPolicy } from "./middleware/permissionsPolicy.js";
import { logSetupTokenIfNeeded } from "./utils/setupToken.js";
import { computeInlineScriptCspHash } from "./utils/cspScriptHash.js";
import { parseTrustProxySetting, trustProxyHopCountWarning } from "./utils/trustProxy.js";
import { isUncompressedBinaryProxyPath, isEventStreamResponse } from "./utils/compressionFilter.js";
import { createServer, STATUS_CODES } from "http";
import { createServer as createHttpsServer } from "https";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import os from "os";
import { isIP } from "net";
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
  flushForShutdown,
  recordPerformanceSnapshot,
  logServerEvent,
  peekServerDisplayName,
} from "./database/init.js";
import { RconService } from "./services/rcon.js";
import { findOtherRunningServers, ServerManager } from "./services/serverManager.js";
import { DockerClient } from "./services/dockerClient.js";
import {
  runManagedLifecycle,
  setDockerClient,
} from "./services/managedContainer.js";
import { ModChecker } from "./services/modChecker.js";
import { Scheduler } from "./services/scheduler.js";
import { DiscordBot } from "./services/discordBot.js";
import { BackupService, BACKUP_PROGRESS_ROOM } from "./services/backupService.js";
import { UpdateChecker } from "./services/updateChecker.js";
import { rehydrateActiveSteamOperationsFromDisk } from "./services/activeSteamOperations.js";
import {
  PanelUpdateChecker,
  createUpdateDataBackup,
  linuxServiceReinstallGuidance,
  redactUpdateStatus,
  restorePreUpdateDataBackup,
} from "./services/panelUpdateChecker.js";
import {
  acknowledgeUpdateBundle,
  applyUpdateBundle,
  inspectPendingUpdateBundle,
  PANEL_API_CONTRACT_VERSION as DEFAULT_API_CONTRACT_VERSION,
  recoverFromUnreadableJournal,
  recoverInterruptedUpdateBundle,
} from "./services/updateBundle.js";
import { LogTailer } from "./services/logTailer.js";
import { createPlayerDeathRouter } from "./services/playerDeathEvents.js";
import { DiskMonitor } from "./services/diskMonitor.js";
import authService, { onSessionRevoked } from "./services/auth.js";
import {
  getCapabilitiesForRole,
  getRoleByName,
  onRoleCapabilitiesChanged,
  requirePermission,
} from "./services/permissions.js";
import { requireRole } from "./services/auth.js";
import authRoutes from "./routes/auth.js";
import oidcRoutes from "./routes/oidc.js";
import { loadOrCreateCerts } from "./utils/certs.js";
import { sanitizeError, sanitizeErrorParams } from "./utils/sanitize.js";
import { escapeLogText } from "./utils/logText.js";
import { isExtensionOrigin } from "./utils/extensionOrigin.js";
import { ErrorCode } from "./utils/errorCodes.js";
import { getSftpCachePath } from "./services/panelBridgeSftp.js";
import { reconcileBridge } from "./services/bridgeDelivery.js";
import { prepareResetTokenChecks } from "./utils/resetTokenStrength.js";
import {
  clientDistMatchesMetadata,
  getEmbeddedClientDistPath,
  readClientDistMetadata,
  resolveClientDistPath,
} from "./utils/embeddedClient.js";
import { resolveObservedServerRunning, resolveServerPhase } from "./utils/serverStatus.js";
import { discoverMounts } from "./services/mountDiscovery.js";
import { shouldAutoOpenBrowser } from "./utils/browserLaunch.js";
import { isLinuxPanelSupervisor } from "./utils/restartSupervisor.js";
import {
  acquireLifecycleLock,
  setBeforeLaunchHook,
  setLaunchTargetRefresher,
  setServerDisplayNameResolver,
  setServerLaunchedHook,
} from "./services/lifecycleCoordinator.js";

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
  // gracefulShutdown() (SIGTERM/SIGINT) and the Windows Supervisor restart
  // path (60f4de4f) both close out every open player session via
  // panelBridge.stop() -> trackPlayerActivity([]) before the process goes
  // down. This is the third process-exit path and was missing that call: a
  // hard crash (uncaughtException/unhandledRejection) with players online
  // left their last_session_start dangling in the DB, silently discarded --
  // not stuck open forever, just clobbered by a fresh "connect" the next
  // time trackPlayerActivity's diff sees them still online post-restart --
  // the same playtime-loss pattern already closed on the other two paths.
  try {
    if (panelBridge?.isRunning) panelBridge.stop();
  } catch (stopErr) {
    log.error("Failed to close player sessions during fatal exit:", stopErr);
  }
  Promise.race([
    flushWrites().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]).finally(() => process.exit(1));
}

export { fatalExit };

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

    // Stop the Server Files janitor and the character and leaderboard
    // samplers, and close the file manager's SFTP connections (not awaited: a
    // remote host that stopped answering must not hold up shutdown)
    stopFileManagerJanitor();
    stopCharacterSnapshotSampler();
    stopLeaderboardSampler();
    closeFileManagerSftpPool().catch(() => {});

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

    // Flush any pending DB write before closing up. database/init.js's own
    // SIGTERM/SIGINT listener (registerShutdownHandlers) does this too, but
    // it's a second, unsynchronized listener on the same signal -- without
    // this explicit, awaited call here, httpServer.close()'s callback below
    // (which calls process.exit(0)) could win the race and kill the process
    // before that other listener's flush -- or its retry after a failed
    // first attempt -- ever gets to run. flushForShutdown() is bounded
    // (a few hundred ms worst case), so this cannot turn into a shutdown
    // that hangs waiting on a write that will never succeed.
    await flushForShutdown();

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
import serverRoutes, {
  isFirstBootMissingAdminPassword,
  refreshLaunchTargetForLaunch,
} from "./routes/server.js";
import discoveryRoutes from "./routes/discovery.js";
import serversRoutes from "./routes/servers.js";
import serverStatusRoutes from "./routes/serverStatus.js";
import serverFilesRoutes from "./routes/serverFiles.js";
import playerRoutes from "./routes/players.js";
import rconRoutes from "./routes/rcon.js";
import configRoutes from "./routes/config.js";
import schedulerRoutes from "./routes/scheduler.js";
import modsRoutes, { pruneModThumbnailCache } from "./routes/mods.js";
import chunksRoutes from "./routes/chunks.js";
import discordRoutes from "./routes/discord.js";
import debugRoutes, { addLogToBuffer } from "./routes/debug.js";
import { getDiskFree } from "./utils/diskSpace.js";
import { getSwapInfo } from "./utils/swapInfo.js";
import serverFinderRoutes from "./routes/serverFinder.js";
import panelBridgeRoutes, { bridgeFolderEventView } from "./routes/panelBridge.js";
import bridgeDeliveryRoutes from "./routes/bridgeDelivery.js";
import backupRoutes from "./routes/backup.js";
import mapProxyRoutes from "./routes/mapProxy.js";
import systemRoutes from "./routes/system.js";
import templatesRoutes from "./routes/templates.js";
import dockerRoutes from "./routes/docker.js";
import permissionsRoutes from "./routes/permissions.js";
import filesRoutes from "./routes/files.js";
import { PANEL_SERVER_TIMEOUTS, installRequestBodyDeadline } from "./utils/requestBodyDeadline.js";
import playerCharacterRoutes from "./routes/playerCharacter.js";
import panelBridge from "./services/panelBridge.js";
import {
  startFileManagerJanitor,
  stopFileManagerJanitor,
} from "./services/fileManagerJanitor.js";
import { closeFileManagerSftpPool } from "./services/fileManagerSftpBackend.js";
import {
  startCharacterSnapshotSampler,
  stopCharacterSnapshotSampler,
} from "./services/characterSnapshotSampler.js";
import { startLeaderboardSampler, stopLeaderboardSampler } from "./services/leaderboardSampler.js";
import { pruneCharacterStore } from "./services/characterStore.js";
import { waitForProcessExit } from "./utils/processScanRetry.js";

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
  const hopCountWarning = trustProxyHopCountWarning(trustProxyEnv);
  if (hopCountWarning) log.warn(hopCountWarning);
}
// Every request gets Node's 5 minutes to arrive, per request rather than
// Node's one server-wide requestTimeout, so that a Server Files upload
// alone can be given hours once it is authorised (utils/requestBodyDeadline.js,
// FILE_UPLOAD_REQUEST_TIMEOUT_MS in routes/files.js); headersTimeout keeps
// its 60 s.
const httpServer = installRequestBodyDeadline(createServer(PANEL_SERVER_TIMEOUTS, app));
let activePanelPort = null;

// SECURITY (2026-10-05, A2): round 5 of the reset-token verification. The
// table of well-known hashes the reset-token checks need
// (utils/resetTokenStrength.js) was worked out by whichever reset request
// came first, which waited most of a second for it: a stranger's first
// guess after a restart was slow unless the host's login page had already
// asked. It's worked out in the background, a slice at a time, as soon as
// the panel is listening.
httpServer.once("listening", () => {
  prepareResetTokenChecks().catch((error) => {
    log.warn(`Could not prepare the reset-token checks in advance: ${error.message}`);
  });
});

// HTTPS server — created during startup if certs are available
let httpsServer = null;

// Whether HTTPS is currently up, per the module-level `httpsServer` binding
// setupHttpsServer() nulls on any failure (cert error, EADDRINUSE, invalid
// port) so a later check (the boot-banner URL list, the protocol string
// used to build the printed panel URL) never reports HTTPS as available
// after it's actually failed closed. Exported narrowly so a test can
// observe this specific state transition -- bug hunt 2026-08-31-c
// (under-coverage sweep): a prior test asserted "does NOT crash" and
// "fails closed" correctly via the returned server object's own
// `.listening` property, but had no way to see whether this MODULE-level
// binding (a separate reference from what setupHttpsServer() returns) was
// actually reset, despite its own title explicitly claiming "(server nulls
// itself out)" as part of what it verifies.
export function isHttpsServerActive() {
  return httpsServer !== null;
}

// CORS — restrict to known development and production origins
// Must be declared before Socket.IO or Express CORS middleware reference it
const defaultAllowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3001",
];
const allowedOrigins = new Set(defaultAllowedOrigins);
// SECURITY (2026-10-08, auth audit #4): the origins the operator named
// (Settings > Remote Access, CORS_ORIGINS). Of the cross-origin callers,
// only these (plus allow-all and the browser extension) get credentialed
// CORS. A page on another port of the panel's host is same-site, so
// SameSite=Strict still sends it the refresh cookie; credentialed CORS for
// every private-network origin let such a page read an access token from
// /api/auth/refresh.
const credentialedOrigins = new Set();
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

// A dotted-quad IPv4 literal with every octet range-checked. Matching by
// string prefix ("10.", "192.168.") also admitted attacker-controlled
// hostnames like 10.evil.com (security audit L4).
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isPrivateNetworkHost(host) {
  if (!host) return false;
  const h = String(host).trim().toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]") return true;
  const match = IPV4_RE.exec(h);
  if (!match) return false; // a hostname is never private-by-shape, however it starts
  const octets = match.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  const [a, b] = octets;
  return (
    a === 10 || // 10.0.0.0/8
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 100 && b >= 64 && b <= 127) // CGNAT/Tailscale 100.64.0.0/10
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

// SECURITY (2026-10-05, H2): the Origin header is whatever the caller sent,
// signed in or not. Node's HTTP parser keeps bytes 0x80-0xFF in a header as
// latin1, so 0x85 arrives as U+0085 (NEL), a line break to some log viewers.
// Both this record (shown in Settings > Remote Access and support bundles)
// and the "CORS blocked" log line keep it escaped (utils/logText.js).
function describeBlockedOrigin(origin) {
  const normalizedOrigin = typeof origin === "string" ? origin.trim() : "";
  return normalizedOrigin
    ? escapeLogText(normalizedOrigin.slice(0, MAX_CORS_ORIGIN_LENGTH))
    : "null";
}

function recordCorsBlock(origin, source) {
  if (!corsState.debug) return;
  const safeOrigin = describeBlockedOrigin(origin);
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
// Capped as a backstop: every entry comes from settings or the environment,
// which are themselves capped (MAX_CORS_CUSTOM_ORIGINS).
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
  credentialedOrigins.clear();
  for (const origin of defaultAllowedOrigins) {
    addAllowedOrigin(origin);
  }

  const customOrigins = parseOriginList(settings.corsAllowedOrigins || "");
  corsState.customOrigins = new Set(customOrigins);
  for (const origin of customOrigins) {
    addAllowedOrigin(origin);
    credentialedOrigins.add(origin);
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
      credentialedOrigins.add(origin);
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

// CORS origin checker, shared between Express and Socket.IO. "credentialed":
// no Origin, allow-all, the extension or an origin the operator named.
// "uncredentialed": the built-in localhost origins, or a private/LAN address
// (192.168.x, 10.x, 100.x Tailscale, 172.16-31.x, LAN-style names) found by
// shape. Those are no longer remembered in allowedOrigins, which made them
// look operator-named. null: refused.
function classifyOrigin(origin) {
  if (!origin) return "credentialed";
  if (corsState.allowAll) return "credentialed";
  if (isExtensionOrigin(origin)) return "credentialed";

  const normalized = normalizeOrigin(origin);
  if (!normalized) return null;
  if (credentialedOrigins.has(normalized)) return "credentialed";
  if (allowedOrigins.has(normalized)) return "uncredentialed";

  try {
    const url = new URL(normalized);
    if (
      corsState.allowPrivateNetworks &&
      (isPrivateNetworkHost(url.hostname) || isLikelyLanHostname(url.hostname))
    ) {
      return "uncredentialed";
    }
  } catch (_) {
    // Unparseable origin: fall through and deny.
  }

  return null;
}

function isAllowedOrigin(origin) {
  return classifyOrigin(origin) !== null;
}

// The panel's own page: the browser says so (Sec-Fetch-Site, which no page
// can set), or the Origin names the scheme and host the request was sent
// to. Browsers ignore CORS headers on same-origin requests anyway; this
// keeps the answer honest for older browsers and the Vite dev proxy.
function isSameOriginRequest(req, origin) {
  if (req.headers["sec-fetch-site"] === "same-origin") return true;
  const host = req.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;
  try {
    const originUrl = new URL(origin);
    return (
      originUrl.protocol === `${req.protocol}:` &&
      originUrl.host === new URL(`${originUrl.protocol}//${host}`).host
    );
  } catch (_) {
    return false;
  }
}

// DNS-rebinding guard. With authentication disabled (authEnabled: false in
// db.json, a trusted-LAN setup), the API answers anyone who can reach it,
// and CORS does not stop a same-origin GET: a web page on a domain whose DNS
// the attacker then points at this panel's address IS same-origin with it,
// and its GETs carry no Origin header. What it can't change is the Host
// header, which still names the attacker's domain. So while auth is off,
// /api and Socket.IO answer only requests addressed to one of the panel's
// own names: any IP address (a page served from an IP address came from
// this panel), localhost, a LAN-style host name when private networks are
// allowed, or a host from the same origins list the CORS check uses
// (Settings > Remote Access, CORS_ORIGINS, the HTTPS origin). "Allow every
// origin" turns it off, the same as it turns off the CORS check: rebinding
// gains nothing that setting doesn't already give every web page.
export function isAllowedHostHeader(hostHeader) {
  if (corsState.allowAll) return true;
  if (typeof hostHeader !== "string" || !hostHeader || hostHeader.length > MAX_CORS_ORIGIN_LENGTH) {
    return false;
  }
  let url;
  try {
    url = new URL(`http://${hostHeader}`);
  } catch (_) {
    return false;
  }
  // A bare host[:port] parses to exactly that; anything else (user info, a
  // path, a query) is not a Host header a browser sends.
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  if (isIP(hostname.replace(/^\[|\]$/g, ""))) return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (corsState.allowPrivateNetworks && isLikelyLanHostname(hostname)) return true;
  for (const origin of allowedOrigins) {
    try {
      if (new URL(origin).hostname.toLowerCase() === hostname) return true;
    } catch (_) {
      // Not a parseable origin: it can't name this host.
    }
  }
  return false;
}

// Whether isAllowedHostHeader() applies right now: only while auth is
// explicitly off. Before first-run setup every route but the setup ones is
// already refused, and with auth on a rebinding page has no session to use
// (the access token lives in the real origin's storage, and the refresh
// cookie is only sent to the real host). Fails closed: if the auth state
// can't be read, the check applies.
async function hostCheckApplies() {
  try {
    if (await authService.needsSetup()) return false;
    return !(await authService.isAuthEnabled());
  } catch (error) {
    log.warn(`Host check: could not read the auth state, checking the Host header: ${error.message}`);
    return true;
  }
}

export async function isRequestHostAllowed(hostHeader) {
  if (!(await hostCheckApplies())) return true;
  return isAllowedHostHeader(hostHeader);
}

const HOST_DENY_MESSAGE =
  "This panel only answers to its own addresses while panel logins are off. Open it by its IP address or localhost, or add this address under Settings > Remote Access (CORS).";

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
  // Same Host-header guard as the /api middleware below (a rebinding page
  // can open a socket to the panel too). Runs on every handshake, polling
  // or WebSocket; io.attach() for HTTPS reuses these options.
  allowRequest: (req, callback) => {
    isRequestHostAllowed(req.headers.host).then(
      (allowed) => callback(allowed ? null : HOST_DENY_MESSAGE, allowed),
      () => callback(HOST_DENY_MESSAGE, false),
    );
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

  // loadOrCreateCerts() only confirms the custom paths are real, readable
  // FILES -- it never parses their content, so a file that satisfies both
  // checks but holds garbage/corrupted bytes (truncated on disk, or just
  // the wrong file) reaches here unchanged. createServer() parses the
  // PEM/DER synchronously and throws immediately on invalid content (e.g.
  // "PEM routines::no start line") -- same crash-the-whole-panel class as
  // the cert-path/EADDRINUSE cases above, just one call later, so it gets
  // the identical guard.
  try {
    httpsServer = installRequestBodyDeadline(createHttpsServer({ ...certs, ...PANEL_SERVER_TIMEOUTS }, app));
  } catch (error) {
    log.error(
      `HTTPS certificate/key content is invalid: ${error.message} — running HTTP only`,
    );
    httpsServer = null;
    return null;
  }
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
const externalClientDistPath =
  typeof process.pkg !== "undefined"
    ? path.join(path.dirname(process.execPath), "client", "dist")
    : path.join(__dirname, "../client/dist");
const embeddedClientDistPath =
  typeof process.pkg !== "undefined" ? getEmbeddedClientDistPath() : null;
const cspClientDistPath = resolveClientDistPath({
  packaged: typeof process.pkg !== "undefined",
  embeddedPath: embeddedClientDistPath,
  externalPath: externalClientDistPath,
});
// See utils/cspScriptHash.js: computed at startup by hashing the real
// shipped file rather than a hardcoded hash, so this can never go stale.
// Returns null if the script can't be found (dist not built, the tag
// renamed/restructured) — script-src deliberately does NOT fall back to
// 'unsafe-inline' in that case. A missing build is a build problem, not a
// security event, so the right failure shape is the page visibly breaking
// (blocked inline script, no theme flash prevention) rather than the
// protection silently loosening on exactly the deployments where
// something is already unusual.
//
// `let`, not `const`: the packaged Linux update-apply path swaps
// client/dist onto disk IN-PROCESS (updateBundle.js's applyUpdateBundle(),
// called from POST /api/panel/restart below) and then keeps this same
// process serving requests for a bit before it actually exits — unlike
// Windows, where an external supervisor does the swap only after this
// process has already exited. refreshInlineScriptCspHash() re-reads and
// re-hashes right after that in-process swap so this variable — and the
// header below, which reads it fresh per request — stops describing the
// pre-swap script the moment the swap completes, instead of staying stale
// until the process eventually restarts.
let inlineScriptCspSource = computeInlineScriptCspHash(
  cspClientDistPath,
  log,
);
function refreshInlineScriptCspHash() {
  inlineScriptCspSource = computeInlineScriptCspHash(cspClientDistPath, log);
  return inlineScriptCspSource;
}
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // A function element is re-evaluated by helmet on every single
        // request (see node_modules/helmet's getHeaderValue) rather than
        // captured once when app.use() ran — required so
        // refreshInlineScriptCspHash() above actually changes what the next
        // request receives, instead of only taking effect on next restart.
        // An empty string contributes nothing to the header (helmet joins
        // directive entries with a space and browsers ignore the resulting
        // extra whitespace), which is what "no hash could be computed"
        // needs — script-src 'self' alone, same as the ternary this
        // replaced.
        scriptSrc: ["'self'", () => inlineScriptCspSource || ""],
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

// Rate limiting — applied before auth to protect against unauthenticated floods.
// Also before cors() and the body parsers (auth audit #18): a refused
// Origin or a body that doesn't parse skips every middleware after the
// one that refused it, limiters included.
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 300, // 300 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});
app.use("/api/", apiLimiter);

// A refused Origin is logged once per origin, like the Host refusals below,
// and answered 403: anyone can send one, so a log line per request let a
// stranger rotate the panel's sign-in history out of the log files.
const loggedCorsRefusals = new Set();
function corsRefusal(origin) {
  const shown = describeBlockedOrigin(origin);
  if (!loggedCorsRefusals.has(shown) && loggedCorsRefusals.size < 50) {
    loggedCorsRefusals.add(shown);
    log.warn(`CORS blocked request from origin: ${shown}`);
  }
  return Object.assign(new Error(CORS_DENY_MESSAGE), { status: 403, corsRefused: true });
}

// Delegate form: whether credentials are allowed depends on the request
// (classifyOrigin, isSameOriginRequest), not only on the Origin. Without
// Access-Control-Allow-Credentials the browser keeps a credentialed
// response from the calling page.
app.use(
  cors((req, callback) => {
    const origin = req.headers.origin;
    const access = classifyOrigin(origin);
    if (!access) {
      recordCorsBlock(origin, "http");
      callback(corsRefusal(origin));
      return;
    }
    callback(null, {
      origin: true,
      methods: ["GET", "POST", "PUT", "DELETE"],
      credentials: access === "credentialed" || isSameOriginRequest(req, origin),
    });
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

// Server Files text saves carry a whole file (up to 2 MiB) as a JSON
// string; 6mb covers the worst-case JSON escaping of that. Same ordering
// rule as the client-errors parser above: it must run before the app-wide
// 1mb parser below, or that one reads the body first and refuses it.
app.put("/api/files/profiles/:profileId/text", express.json({ limit: "6mb" }));

// Body parser with explicit size limit
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// Compress all HTTP responses (gzip/deflate) EXCEPT the <img>-tag-loaded
// binary proxy routes and SSE streams -- see compressionFilter.js for why.
app.use(
  compression({
    threshold: 1024,
    filter: (req, res) => {
      if (isUncompressedBinaryProxyPath(req)) return false;
      if (isEventStreamResponse(res)) return false;
      return compression.filter(req, res);
    },
  }),
);

// DNS-rebinding guard while auth is disabled -- see isAllowedHostHeader().
// Before the auth middleware, which would otherwise hand this request the
// auth-disabled admin identity. Case-insensitive like that middleware's own
// /api prefix test (Express routes /API/... to the same handlers).
// Logged once per host name, not once per request: a page that keeps
// polling would otherwise fill the log.
const loggedRefusedHosts = new Set();
app.use(async (req, res, next) => {
  if (!req.path.toLowerCase().startsWith("/api")) return next();
  if (await isRequestHostAllowed(req.headers.host)) return next();
  // Escaped for the log line (utils/logText.js): the Host header is the
  // caller's, and this runs before any sign-in.
  const host = escapeLogText(String(req.headers.host || "").slice(0, 100));
  if (!loggedRefusedHosts.has(host) && loggedRefusedHosts.size < 50) {
    loggedRefusedHosts.add(host);
    log.warn(
      `Refused /api requests addressed to "${host}" while panel logins are off: not one of this panel's addresses. Add it under Settings > Remote Access if it should be.`,
    );
  }
  return res.status(403).json({ error: HOST_DENY_MESSAGE, code: ErrorCode.HOST_NOT_ALLOWED });
});

// Auth middleware — protects all /api/ routes except /api/auth/*
// SSE endpoints can't set custom headers, so we accept ?token= as a fallback —
// but ONLY for the endpoints that actually need it. Accepting it on every
// /api route put 15-minute access tokens in proxy access logs and browser
// history (security audit M2). originalUrl is used because req.path is
// mount-relative inside this app.use("/api/") layer.
export const QUERY_TOKEN_PATHS = new Set(["/api/mods/conflicts/stream"]);
export function acceptsQueryToken(req) {
  const fullPath = String(req.originalUrl || req.url || req.path || "")
    .split("?")[0]
    .toLowerCase();
  return QUERY_TOKEN_PATHS.has(fullPath);
}
app.use("/api/", (req, res, next) => {
  if (req.query.token && !req.headers.authorization && acceptsQueryToken(req)) {
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
// POST only: GET /delivery is a status read the Settings page polls.
app.post("/api/panel-bridge/delivery", strictLimiter);
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

// Server Files (/api/files). Per IP like every limiter here, on top of the
// global apiLimiter. Each kind of action gets its own bucket, so a folder
// upload (one request per file) can't starve edits, a burst of edits can't
// starve searches, and cleaning up files one delete at a time can't use up
// the strictLimiter budget of server Start/Stop/Restart.
const fmRateLimited = {
  error: "Too many file actions in a short time. Wait a moment and try again.",
  code: ErrorCode.FM_RATE_LIMITED,
};
const fmSearchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: fmRateLimited,
});
const fmMutationLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: fmRateLimited,
});
const fmTransferLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: fmRateLimited,
});
// A folder upload sends one request per file, so its files get a bucket of
// their own: 250 a minute before it pauses on a 429 (spec §A7), where the
// shared transfer bucket stopped it at its 120th file. The global
// apiLimiter (300/min) still caps everything together.
const fmUploadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 250,
  standardHeaders: true,
  legacyHeaders: false,
  message: fmRateLimited,
});
const fmDeleteLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: fmRateLimited,
});
app.use("/api/files/profiles/:profileId/search", fmSearchLimiter);
app.put("/api/files/profiles/:profileId/text", fmMutationLimiter);
app.post("/api/files/profiles/:profileId/mkdir", fmMutationLimiter);
app.post("/api/files/profiles/:profileId/rename", fmMutationLimiter);
app.post("/api/files/profiles/:profileId/move", fmMutationLimiter);
app.post("/api/files/profiles/:profileId/copy", fmMutationLimiter);
app.post("/api/files/profiles/:profileId/delete/preview", fmMutationLimiter);
app.post("/api/files/profiles/:profileId/trash/restore", fmMutationLimiter);
app.put("/api/files/profiles/:profileId/remote-roots", fmMutationLimiter);
app.post("/api/files/profiles/:profileId/delete", fmDeleteLimiter);
app.post("/api/files/profiles/:profileId/trash/purge", fmDeleteLimiter);
app.post("/api/files/profiles/:profileId/upload", fmUploadLimiter);
app.post("/api/files/profiles/:profileId/upload/preflight", fmTransferLimiter);
app.get("/api/files/profiles/:profileId/download", fmTransferLimiter);
app.post("/api/files/profiles/:profileId/zip", fmTransferLimiter);

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
// Lets lifecycleInProgressResponse()'s 409 message resolve a held lock's
// server DB id back to a display name, without lifecycleCoordinator.js
// statically importing database/init.js (see its own comment on why: dozens
// of test files mock that module with only the exports they need).
setServerDisplayNameResolver(peekServerDisplayName);
// Starts and restarts from the dashboard, the scheduler (scheduled, mod-
// update), Discord, boot auto-start and post-update funnel through
// serverManager.startServer() or managedContainer.runManagedLifecycle(),
// which call this right before the launch: PanelBridge is brought in line
// with the server's delivery method for the JVM about to start. The Servers
// page's per-container Start/Restart (routes/docker.js) calls it too. Never
// throws, bounded to 15 s.
setBeforeLaunchHook((server) => reconcileBridge(server, { reason: "launch" }));
// The other half of that same before-launch step, run just ahead of the hook
// above: RCON credentials into the ini and the generated launch script
// rewritten from the server's CURRENT settings (GH #167 -- the boot
// auto-start used to skip it). See refreshLaunchTargetForLaunch().
setLaunchTargetRefresher(refreshLaunchTargetForLaunch);
const modChecker = new ModChecker();
// Every launch the panel makes (the same paths as the before-launch hook
// above), reported once it has happened: a fresh start loads the updated
// Workshop mods, so a mod-update restart still pending from before it is
// cancelled instead of restarting the server a second time (GH #189).
setServerLaunchedHook((launch) => modChecker.noteServerLaunched(launch));
const logTailer = new LogTailer();
const scheduler = new Scheduler(rconService, serverManager);
const discordBot = new DiscordBot(
  rconService,
  serverManager,
  scheduler,
  logTailer,
);
// /leaderboard reads the stats PanelBridge keeps.
discordBot.panelBridge = panelBridge;
const backupService = new BackupService();

// Connect services for cross-communication
rconService.setServerManager(serverManager);
scheduler.setBackupService(backupService);

// Give scheduler and backupService a reference to discordBot so they can
// fire event notifications (scheduledRestart, backupComplete) without
// needing req.app access.
scheduler.setDiscordBot(discordBot);
scheduler.setIo(io);
backupService.setDiscordBot(discordBot);
// So createBackup() can refuse while a restart (manual or scheduled) is
// mid-flight -- see backupService.js's own comment on this check for why a
// backup taken during that window can silently archive a save mid-write.
backupService.setScheduler(scheduler);

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
 * (exported for panelBridgeBootReconcileOrder.test.js)
 */
export async function tryStartPanelBridge(trigger = "unknown") {
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

  let started = false;
  try {
    panelBridge.configure(result.path, true);
    panelBridge.start();
    log.info(`Started from ${result.source} (trigger: ${trigger})`);
    started = true;
  } catch (error) {
    log.warn(`Failed to start - ${error.message}`);
  }

  // Bring the active server's game folder in line with its PanelBridge
  // delivery method: keep the loose PanelBridge.lua current (gated by the
  // panelBridgeAutoUpdate setting), or, with Steam Workshop delivery, move
  // loose copies out and re-add the ini entries. The embedded-over-stale-
  // disk source priority this block used to carry itself now lives in
  // panelBridgeInstaller.installBridge(). Never throws.
  //
  // AFTER the bridge is configured, not before: reconcile touches the game
  // folder and the server's .ini, never the bridge folder the watcher
  // reads, and it can take up to its 15 s bound on a slow or network game
  // folder. Run first, it held off configure() past the status watchdog's
  // first tick (+10 s), whose first stopped observation is the only one
  // that pins a quietly stopped server's last heartbeat as dead
  // (PanelBridge.markServerExited()) -- with no bridge path yet it pinned
  // nothing and never retried, so that heartbeat read as alive for up to
  // statusStaleIdleMs once the bridge started. Still awaited, so callers
  // that start the game server next (boot auto-start) find it done.
  await reconcileBridge(await getActiveServer().catch(() => null), { reason: "boot" });
  return started;
}

// server-running-determination-convention sweep, 2026-09-08: panelBridge is
// a shared singleton, exactly like serverManager and rconService, that only
// ever points at ONE server's bridge folder (this.bridgePath) at a time --
// but unlike those two, nothing explicitly repointed it when the active
// server changed. tryStartPanelBridge() alone can't fix that: its very
// first line is `if (panelBridge.isRunning) return true`, so calling it
// after a switch is a guaranteed no-op whenever the bridge was already
// running for the PREVIOUS server, which is exactly the moment a resync is
// needed. The only thing that used to save this was rconService's own
// "connected" event re-triggering tryStartPanelBridge('rcon-connected') --
// conditional on the NEWLY active server having an RCON password
// configured at all. A server managed via PanelBridge/SFTP only, or simply
// not yet given a password, left panelBridge silently pointed at whichever
// server it last served, indefinitely. That is not a display-only bug:
// sendCommand() (weather control, player details, world stats, safehouses,
// vehicles, every PanelBridge-routed feature) writes straight to
// this.bridgePath's commands.json -- a stale bridgePath means a command
// the operator believes is going to the newly active server is actually
// delivered to, and executed by, the PREVIOUS one.
async function resyncPanelBridgeForActiveServer(trigger = "active-server-changed") {
  if (panelBridge.isRunning) {
    panelBridge.stop();
  }
  return tryStartPanelBridge(trigger);
}

// Auto-start PanelBridge when RCON connects (secondary trigger)
// An async EventEmitter listener that rejects becomes an unhandled rejection,
// which reaches process.on("unhandledRejection") and kills the panel — so
// this is wrapped in its own try/catch. The sibling "disconnected" handler
// below no longer needs the same treatment: it delegates entirely to
// checkServerStatusNow(), which already catches every error internally and
// never rejects (2026-08-31 consolidation).
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

rconService.on("disconnected", () => {
  // When RCON disconnects, check if server actually stopped. This gives
  // faster detection than the 10s watchdog interval. Routes through
  // checkServerStatusNow() (2026-08-31 bug hunt consolidation -- see that
  // function's own header comment) instead of independently reading,
  // comparing, mutating and emitting: this handler used to be a second,
  // independent writer of `lastKnownRunning` that would not have inherited
  // a future fix made only in checkServerStatusNow(). checkServerStatusNow()
  // already catches every error internally and never rejects, so this
  // needs no try/catch of its own, unlike before.
  setTimeout(() => {
    checkServerStatusNow("RCON disconnect");
  }, 3000); // wait 3s for process to fully exit
});

// Emit PanelBridge status changes to connected clients via Socket.IO.
// bridgePath is a host filesystem path, and the HTTP status route gates it
// behind bridge.setup / bridge.diagnostics (7ead08e0) — these rare events go
// only to sockets holding one of those, instead of every signed-in role
// (security audit M1). SECURITY (2026-10-05, H4 round 3): and a socket
// whose role only diagnoses the bridge gets the folder as the placeholder,
// as from GET /api/panel-bridge/status (bridgeFolderEventView()).
panelBridge.on("started", () => {
  emitToCapabilities(["bridge.setup", "bridge.diagnostics"], "panelBridge:status", (s) =>
    bridgeFolderEventView(s.user, { isRunning: true, bridgePath: panelBridge.bridgePath }),
  ).catch(() => {});
});

panelBridge.on("stopped", () => {
  emitToCapabilities(["bridge.setup", "bridge.diagnostics"], "panelBridge:status", (s) =>
    bridgeFolderEventView(s.user, { isRunning: false, bridgePath: panelBridge.bridgePath }),
  ).catch(() => {});
});

panelBridge.on("configured", ({ path }) => {
  emitToCapabilities(["bridge.setup", "bridge.diagnostics"], "panelBridge:configured", (s) =>
    bridgeFolderEventView(s.user, { bridgePath: path }),
  ).catch(() => {});
});

// The live heartbeat is consumed by the dashboard/bridge badges (alive,
// version, serverName, playerCount) for every role, but the internal
// modStatus also carries host paths (path, filePath, lastPath), raw error
// text that can quote a path, and a live player list. Only an allow-list of
// the fields those badges read is broadcast -- a delete-list re-leaks the
// next field someone adds, which is how lastPath slipped through (same
// rule as pingModStatusView() in services/panelBridge.js). The player list
// is third-party data gated like GET /api/players/, so it travels as its
// own event to players.view sockets only (security audit M1).
const PUBLIC_MOD_STATUS_FIELDS = [
  "alive",
  "waiting",
  "version",
  "serverName",
  "playerCount",
  "timestamp",
];
export function publicModStatusView(status) {
  const view = {};
  for (const field of PUBLIC_MOD_STATUS_FIELDS) {
    if (status?.[field] !== undefined) view[field] = status[field];
  }
  return view;
}

panelBridge.on("modStatus", (status) => {
  if (!status) return;
  io.emit("panelBridge:modStatus", publicModStatusView(status));
  if (status.players) {
    emitToCapabilities(["players.view"], "panelBridge:players", status.players).catch(() => {});
  }
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

// Skill snapshots for the Players page's Character tab: one shortly after
// each login, then a slow periodic pass over whoever is online.
startCharacterSnapshotSampler(panelBridge);
// Leaderboard reads while players are online, for bridges (1.7.73 and older)
// that only read kills when asked; idle once the bridge sweeps by itself.
startLeaderboardSampler(panelBridge);

// Make services available to routes
app.set("rconService", rconService);
app.set("serverManager", serverManager);
app.set("resyncPanelBridgeForActiveServer", resyncPanelBridgeForActiveServer);
app.set("resetPlayerPollingBaseline", resetPlayerPollingBaseline);
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
// disk:critical / disk:normal over the same socket -- only to roles that can
// act on a full save disk (DISK_EVENT_CAPABILITIES), not every socket: the
// payload carries the save volume's host path. Everyone else's health banner
// still finds out from its own poll of /api/system/storage-health.
export const DISK_EVENT_CAPABILITIES = Object.freeze(["diagnostics.manage", "backups.manage"]);
const diskMonitor = new DiskMonitor({
  emit: (event, payload) => {
    emitToCapabilities(DISK_EVENT_CAPABILITIES, event, payload).catch((error) =>
      log.warn(`Could not send ${event}: ${error.message}`),
    );
  },
});
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
app.use("/api/files", filesRoutes);
app.use("/api/players", playerRoutes);
app.use("/api/player-character", playerCharacterRoutes);
app.use("/api/rcon", rconRoutes);
app.use("/api/config", configRoutes);
app.use("/api/scheduler", schedulerRoutes);
app.use("/api/mods", modsRoutes);
app.use("/api/chunks", chunksRoutes);
app.use("/api/discord", discordRoutes);
app.use("/api/debug", debugRoutes);
app.use("/api/server-finder", serverFinderRoutes);
// Above the /api/panel-bridge router so /delivery is never shadowed by it.
app.use("/api/panel-bridge/delivery", bridgeDeliveryRoutes);
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
let _buildSha;
// These are resolved SEPARATELY on purpose. They used to share one try/catch, which meant a
// failure resolving the build sha discarded an already-successful package.json read: in a
// container there is no .git and no git binary, `git rev-parse HEAD` throws, and the panel then
// reported itself as 0.0.0 even though its version was sitting right there in /app/package.json.
// That was harmless until the frontend/backend build-compatibility gate started comparing the
// two, at which point every Docker user got "Frontend and backend versions do not match" and a
// blocked UI. Never let an unknown sha cost us a known version.
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
try {
  const configuredBuildSha =
    typeof PANEL_BUILD_SHA !== "undefined"
      ? PANEL_BUILD_SHA
      : process.env.PANEL_BUILD_SHA;
  if (configuredBuildSha) {
    _buildSha = configuredBuildSha;
  } else if (fs.existsSync(path.join(process.cwd(), ".git"))) {
    _buildSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } else {
    _buildSha = "unknown";
  }
} catch {
  _buildSha = "unknown";
}
const _apiContractVersion =
  typeof PANEL_API_CONTRACT_VERSION !== "undefined"
    ? Number(PANEL_API_CONTRACT_VERSION)
    : DEFAULT_API_CONTRACT_VERSION;
const _buildMetadata = {
  panelVersion: _pkgVersion,
  buildSha: _buildSha,
  apiContractVersion: _apiContractVersion,
};

function updateBundleJournalPath() {
  return path.join(path.dirname(panelUpdateChecker.getExeBasePath()), "update-bundle.json");
}

let _pendingUpdateInspection = { pending: false, awaitingStartupAck: false };

function inspectPendingPanelUpdate() {
  const journalPath = updateBundleJournalPath();
  return inspectPendingUpdateBundle({
    journalPath,
    applyingMarkerPath: path.join(path.dirname(journalPath), ".update-applying"),
    runningMetadata: _buildMetadata,
  });
}

// State-machine sweep, 2026-09-07 (god's dispatch): inspectPendingPanelUpdate()
// runs BEFORE httpServer.listen() and calls ensureCompatibleBundle()
// internally the moment a journal is "awaiting_startup_ack" (or its Windows
// equivalent) -- so a real version_mismatch (the staged build's own
// metadata not matching what's actually running, the one integrity check
// this whole bundle system exists to catch) throws HERE, first, every
// single time. The ready-callback further down (search for
// "Update startup handshake failed") ALSO handles version_mismatch, by
// rolling the bundle back via acknowledgeUpdateBundle()'s own internal
// catch -- but it runs strictly LATER, after this exact check already threw
// and this process already called process.exit(76). That later code is
// unreachable for this condition: same journal, same runningMetadata, same
// comparison, so a real mismatch is always caught here first. Without this,
// every subsequent restart hits the identical throw with nothing ever
// having rolled back -- the one safety net actually catching the exact
// problem it was built for, then getting permanently stuck instead of
// healing, bounded only by whatever supervisor eventually gives up on
// repeated nonzero exits. Exported so it can be unit-tested directly
// against a real on-disk journal instead of through start()'s full
// listen()-and-banner sequence.
//
// Hotfix, 2026-09-07 ("hotfix-invalid-bundle"): widened beyond
// version_mismatch to also cover invalid_bundle -- thrown from roughly ten
// sites in updateBundle.js (unparseable JSON, a structurally-invalid
// journal, an installDir that no longer matches where the journal actually
// lives, an unreadable applying-marker) and, unlike version_mismatch, it
// was falling straight through this function and out to a bare
// process.exit(76) with nothing ever cleaned up -- so every single restart
// re-hit the identical throw, forever. Confirmed in the wild on v1.2.16.
//
// invalid_bundle is not one condition, it is two, and they need different
// recoveries:
//   - The journal itself is fine (parses, validates) but something ELSE
//     inspectPendingPanelUpdate() touched while checking it was bad (e.g.
//     the staged/applied frontend's own build-info.json is unreadable).
//     The journal still knows exactly what to roll back to here, so this
//     is really the same shape as version_mismatch -- try
//     recoverInterruptedUpdateBundle() first, unconditionally, for both
//     codes.
//   - The journal ITSELF is what's unreadable. recoverInterruptedUpdateBundle()
//     re-reads that same journalPath as its very first step, so it just
//     re-throws the identical invalid_bundle back at us -- that specific
//     failure shape (a *second* invalid_bundle, from the rollback attempt
//     itself) is exactly the signal that there is no journal left to trust,
//     and is the only case that falls through to recoverFromUnreadableJournal()'s
//     fixed-path, journal-less recovery.
export function recoverFromStartupInspectionFailure(error, journalPath) {
  if (error?.code === "version_mismatch") {
    try {
      recoverInterruptedUpdateBundle(journalPath, "version_mismatch");
      log.warn(
        "Rolled back the pending update bundle after a startup version-mismatch; the next restart should boot the previous, working build.",
      );
    } catch (rollbackError) {
      log.error(
        `Automatic rollback also failed [${rollbackError.code || "rollback_failed"}]: ${rollbackError.message}. ` +
          `To recover manually, delete ${journalPath} and any .update-applying marker next to it, then restart.`,
      );
    }
    return;
  }

  if (error?.code !== "invalid_bundle") return;

  try {
    const rolledBack = recoverInterruptedUpdateBundle(journalPath, "invalid_bundle");
    if (rolledBack) {
      log.warn(
        "Rolled back the pending update bundle after a startup validation failure; the next restart should boot the previous, working build.",
      );
    }
    // rolledBack === false means the journal parsed fine but said "staged"
    // (nothing was ever applied, so there is nothing to roll back) -- not
    // an error, nothing further to do; the operator's next start attempt
    // simply re-evaluates the same, still-merely-staged journal.
    return;
  } catch (rollbackError) {
    if (rollbackError?.code !== "invalid_bundle") {
      // The journal WAS readable; the rollback it described was attempted
      // and failed for its own reason (e.g. rollback_failed). Same
      // actionable shape as version_mismatch's failure branch.
      log.error(
        `Automatic rollback also failed [${rollbackError.code || "rollback_failed"}]: ${rollbackError.message}. ` +
          `To recover manually, delete ${journalPath} and any .update-applying marker next to it, then restart.`,
      );
      return;
    }
    // Second invalid_bundle in a row: recoverInterruptedUpdateBundle()
    // could not even re-read the journal. The journal is the corrupt thing
    // itself, not something it points at -- fall back to fixed-location,
    // journal-less recovery.
  }

  try {
    const outcome = recoverFromUnreadableJournal({
      journalPath,
      binaryPath: panelUpdateChecker.getExeBasePath(),
      liveClientPath: path.join(
        path.dirname(panelUpdateChecker.getExeBasePath()),
        "client",
        "dist",
      ),
    });
    const restoredParts = [
      outcome.restoredBinary ? "binary" : null,
      outcome.restoredClient ? "frontend" : null,
    ].filter(Boolean);
    const restoredSummary = restoredParts.length
      ? `Restored the previous ${restoredParts.join(" and ")} from backup. `
      : "No previous-build backup was found to restore (nothing was actually pending). ";
    const journalSummary = outcome.quarantinedJournalPath
      ? `Moved the unreadable journal aside to ${outcome.quarantinedJournalPath} so startup can proceed.`
      : `Could not move the unreadable journal aside; it is still at ${journalPath} and startup will keep tripping over it.`;
    log.warn(
      `Startup validation could not read the update bundle journal at all [${error.code}]: ${error.message}. ${restoredSummary}${journalSummary}`,
    );
  } catch (recoveryError) {
    log.error(
      `Could not recover from the unreadable update bundle journal [${recoveryError.code || "recovery_failed"}]: ${recoveryError.message}. ` +
        `To recover manually, delete ${journalPath} and any .update-applying marker or .bundle-previous/dist.previous backups next to it, then restart.`,
    );
  }
}
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    version: _pkgVersion,
    ..._buildMetadata,
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

  // Pre-update database snapshot, taken exactly once per restart-and-apply
  // request, right here -- before EITHER platform's destructive step
  // (Windows: writing the supervisor marker and exiting so Start.bat can
  // swap files; Linux: applyUpdateBundle() itself). This used to be taken
  // at download/stage time (see panelUpdateChecker.js's own comment on why
  // that became stale once download and apply became two separate,
  // arbitrarily-far-apart user actions). The path is persisted as a
  // setting, not just held in the journal or in memory, so it survives
  // independently of the bundle journal's own lifecycle (deleted on both
  // successful apply and successful rollback) -- see the acknowledge
  // handler below, which is the one path that can need it back.
  if (isPackaged && staged) {
    try {
      const dataBackupPath = createUpdateDataBackup(
        getDataPaths(),
        staged.version,
      );
      if (dataBackupPath) {
        log.info(`Backed up panel database before update: ${dataBackupPath}`);
        await setSetting("preUpdateDataBackupPath", dataBackupPath);
        await flushWrites();
      }
    } catch (backupErr) {
      // A failed pre-update snapshot must not block the update itself --
      // same posture as every other best-effort backup in this codebase --
      // but it DOES mean there is no safety net for this specific update,
      // so this is worth a warning, not a debug line.
      log.warn(`Could not back up panel database before update: ${backupErr.message}`);
    }
  }

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
        // Same gap gracefulShutdown() (SIGTERM/SIGINT) already closes for a
        // signal-triggered shutdown: this handler exits the process directly
        // and never went through that path, so every currently-connected
        // player's session (panelBridge.trackPlayerActivity's previousPlayers,
        // and the DB row it accumulates playtime into) was left open. The
        // next status poll after relaunch then reads the SAME still-connected
        // players as brand-new joins and silently overwrites their still-open
        // prior session -- the identical bug already fixed for "mod offline"
        // and "bridge stop" (2026-09-04), reachable here via a third,
        // previously-uncovered trigger: a plain panel restart/update-apply
        // with anyone online. Stop the bridge before exiting so the session
        // actually closes first.
        if (panelBridge?.isRunning) panelBridge.stop();
        // Exit code 75 tells Start.bat to apply the marker and relaunch.
        setTimeout(() => process.exit(75), 500);
        return;
      } catch (err) {
        // The Linux staged-update branch below resets this on every one of
        // its own failure paths; this branch didn't, so a failure here (the
        // marker write, the setSetting/flushWrites awaits above it, or
        // panelBridge.stop()) left isApplying stuck true forever in this
        // still-running process -- since nothing failed badly enough to
        // reach the process.exit(75) that would have made the flag moot.
        // Every later restart attempt then hit the guard above and was
        // rejected with "An update apply is already in progress" even
        // though nothing was: the panel telling the user something untrue.
        checker.isApplying = false;
        log.error(`Could not write supervisor marker: ${err.message}`);
        return res.status(500).json({ error: sanitizeError(err.message) });
      }
    }

    // A detached legacy helper can launch a binary, but cannot safely keep a
    // matching frontend transaction alive until startup acknowledgement.
    // Refuse that unsafe path instead of recreating the mixed-version bug.
    checker.isApplying = false;
    return res.status(409).json({
      error:
        "This update requires the packaged Start.bat supervisor. Stop the panel and launch Start.bat, then apply again.",
    });
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
      if (staged.version) {
        await setSetting("pendingPanelUpdate", staged.version);
        await flushWrites();
      }
      const appliedBundle = applyUpdateBundle(staged.journalPath);
      // client/dist was just renamed onto disk by the line above, in this
      // same still-running process (see the comment on
      // refreshInlineScriptCspHash's declaration) -- re-hash now so the very
      // next request, including the res.json() a few lines down, is already
      // describing the new script instead of the pre-swap one.
      refreshInlineScriptCspHash();
      const targetPath = appliedBundle.paths.binary;
      try {
        await fs.promises.chmod(targetPath, 0o755);
      } catch (chmodErr) {
        log.warn(`Could not chmod new binary: ${chmodErr.message}`);
      }
      try {
        await fs.promises.access(targetPath, fs.constants.X_OK);
      } catch (accessErr) {
        recoverInterruptedUpdateBundle(
          staged.journalPath,
          "binary_not_executable",
        );
        // The line above rolled client/dist back to the pre-apply backup --
        // this request returns 500 below and the process keeps running
        // (no restart follows on this branch), so the hash must go back to
        // matching that restored content now, not stay pinned to the new
        // build's hash this same handler just set a few lines up.
        refreshInlineScriptCspHash();
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
      linuxRespawnPath = targetPath;
      log.info(
        `Linux update bundle applied to ${targetPath}; awaiting startup acknowledgement after restart`,
      );
    } catch (err) {
      // updateBundle.js's applyUpdateBundle() rolls its own client/dist
      // rename back internally before rethrowing on any failure (see its
      // own try/catch around the phased rename sequence) -- so a swap may
      // already have happened and been undone by the time control reaches
      // here. Re-hash unconditionally rather than reasoning about which
      // specific phase failed; this process is not restarting on this path.
      refreshInlineScriptCspHash();
      // Release the apply guard so the user can retry after fixing whatever
      // failed (e.g. permission, disk full).
      checker.isApplying = false;
      // god-dispatched, 2026-09-08 (harden-updater-fileops #3): updateError()
      // (updateBundle.js) stores the real fs error -- EPERM/EBUSY/EACCES,
      // the actual reason a rename/copy failed -- only in `.cause`, and
      // overwrites `.code` with the semantic bucket name
      // (binary_swap_failed/frontend_swap_failed/...). Logging only
      // err.message here meant an AV-locked file, a permission problem and
      // a full disk all produced the byte-identical log line, same disease
      // as [powershell_unavailable] before that fix. LOG the raw cause in
      // full -- it can carry absolute paths, which is fine server-side.
      // Deliberately does NOT widen the RESPONSE: REGISTERED_ERROR_CODES's
      // own header comment above (~2203) already rules on this exact
      // question -- forwarding a raw Node/OS code to the client, even a
      // "harmless-looking" one, is the leak apiErrorHandler's allowlist
      // exists to prevent, and this catch's `code` field already goes
      // through that same allowlist via registeredErrorCode(). If the
      // operator-facing message should say more, that's a wording change
      // to report, not one to invent here.
      log.error(
        `Failed to apply Linux staged update: ${err.message}${describeErrorCause(err)}`,
      );
      const body = { error: sanitizeError(err.message) };
      const code = registeredErrorCode(err);
      if (code) {
        body.code = code;
      }
      return res.status(500).json(body);
    }
  }

  res.json({ success: true, message: "Panel is restarting..." });

  // Short delay so the response can be sent before exit
  setTimeout(async () => {
    // Same reasoning as the Windows supervisor-handoff branch above: this is
    // every OTHER restart (a plain manual restart with no staged update, and
    // the Linux staged-update-applied case), and it exits the process
    // directly without ever going through gracefulShutdown() -- so it never
    // closed out an in-flight player session either. Stop the bridge first
    // so the session record actually closes instead of silently getting
    // overwritten by a phantom "connect" once polling resumes post-restart.
    if (panelBridge?.isRunning) panelBridge.stop();
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
    const linuxSupervisor = isLinuxPanelSupervisor();
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

      if (!orchestrated && !linuxSupervisor) {
        // Running as packaged exe standalone — spawn self, then exit.
        // On Linux, prefer the freshly-applied binary path (linuxRespawnPath)
        // since process.execPath may point at a .new slot we just renamed away.
        // On Windows we don't reach this path when a staged update exists
        // (the helper handles it), so process.execPath is safe.
        const respawnTarget = linuxRespawnPath || process.execPath;
        spawn(respawnTarget, [], { detached: true, stdio: "ignore" }).unref();
      } else if (orchestrated) {
        log.info(
          "Running under orchestrator (systemd/Docker) — exiting for external restart",
        );
      } else {
        log.info(
          "Running under the Linux supervisor — exiting for start.sh to relaunch",
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
    process.exit(linuxSupervisor ? 75 : orchestrated ? 1 : 0);
  }, 1000);
});

// Panel self-update endpoints
app.get("/api/panel/update-check", requirePermission("panel.settings"), async (req, res) => {
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

// Login-only on purpose: Layout and Dashboard poll it for every role. The
// helper log and host paths in it are panel.settings content (the same gate
// as update-apply-log), so other roles get the status without them (#193).
app.get("/api/panel/update-status", async (req, res) => {
  try {
    const checker = req.app.get("panelUpdateChecker");
    if (!checker)
      return res
        .status(500)
        .json({ error: "Panel update checker not available" });
    const status = checker.getStatus();
    const capabilities = await getCapabilitiesForRole(req.user?.role);
    res.json(
      Array.isArray(capabilities) && capabilities.includes("panel.settings")
        ? status
        : redactUpdateStatus(status),
    );
  } catch (error) {
    // The only inline update route with no try/catch, found by comparing it
    // against its three siblings (update-check, update-preflight,
    // update-apply-log) directly above and below it, which all wrap the
    // same "call a checker method, hand the result to res.json()" shape.
    // getStatus() calls getStagedUpdate() (real file I/O) internally; a
    // synchronous throw here would still be caught by Express's own
    // handler-dispatch and forwarded to apiErrorHandler today, so this
    // wasn't a live crash, but it meant this one route alone produced a
    // generic 500 instead of the same structured error shape every sibling
    // route gives for the same failure.
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

app.get("/api/panel/update-preflight", requirePermission("panel.settings"), async (req, res) => {
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

app.get("/api/panel/update-apply-log", requirePermission("panel.settings"), (req, res) => {
  try {
    const checker = req.app.get("panelUpdateChecker");
    if (!checker)
      return res
        .status(500)
        .json({ error: "Panel update checker not available" });
    const log = checker.readMostRecentApplyLog();
    res.json({
      log,
      logPath: path.join(getDataPaths().logsDir, "panel-update-last.log"),
    });
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

      // Set only once this request has actually stopped a running server
      // (below) -- used to tell the truth about it if downloadUpdate()
      // itself then fails, rather than leaving that consequential, already-
      // happened side effect unmentioned in an error about something else.
      let stoppedServerForThisRequest = false;

      if (checker.dockerUpdateProxy?.enabled) {
        if (req.body?.confirm !== true) {
          return res.status(400).json({
            error:
              "Confirm the Docker update before recreating the all-in-one container.",
            code: "confirmation_required",
          });
        }

        // Recreating the container stops every Project Zomboid server in
        // it, and only the active one is saved and stopped below. Checked
        // first, so a refusal here never leaves the active server stopped.
        const otherRunning = await findOtherRunningServers(await getActiveServer());
        if (otherRunning.scanFailed) {
          return res.status(503).json({
            success: false,
            error:
              "Can't verify whether the server is stopped because process detection failed. The Docker update was not started.",
            code: ErrorCode.SERVER_STATE_UNKNOWN,
          });
        }
        if (otherRunning.servers.length > 0 || otherRunning.unattributed.length > 0) {
          const names = [
            ...otherRunning.servers.map((server) => server.name || server.serverName),
            ...otherRunning.unattributed.map((entry) => `PID ${entry.pid}`),
          ].join(", ");
          return res.status(409).json({
            error: `Stop ${names} before applying a Docker update. Recreating the container stops every Project Zomboid server in it, and only the active server is saved and stopped for you.`,
            code: ErrorCode.OTHER_SERVERS_RUNNING,
            params: sanitizeErrorParams({ names }),
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
          // The three refusals below each end with the next step. A game
          // server whose main thread died (42.21's UnsatisfiedLinkError
          // during a save, 2026-10-01) keeps its process up while RCON keeps
          // dropping, so the save or the quit fails every time and the
          // update can't go ahead until the operator uses Force stop -- the
          // panel never does that for them, since it can lose everything
          // since the last successful save.
          const rconService = req.app.get("rconService");
          if (!rconService?.connected) {
            return res.status(409).json({
              error:
                "Stop the Project Zomboid server before applying a Docker update. RCON is not connected, so the panel can't save the world and stop it for you. If the server is stuck, use Force stop on the Dashboard: while RCON is disconnected it can't save first and stops the server straight away, so anything since the last successful save will be lost.",
              code: ErrorCode.SERVER_RUNNING_RCON_UNAVAILABLE,
            });
          }

          const saved = await rconService.save();
          if (!saved?.success) {
            const reason = saved?.error || "unknown error";
            return res.status(409).json({
              error: `The world could not be saved (${reason}), so the server was left running and the update was not applied. If the server is stuck, use Force stop on the Dashboard, then apply the update again. Force stop tries one quick save, then stops the server either way, so anything since the last successful save can be lost.`,
              code: "save_failed",
              params: sanitizeErrorParams({ reason }),
            });
          }
          const quit = await rconService.quit();
          if (!quit?.success) {
            const reason = quit?.error || "unknown error";
            return res.status(502).json({
              error: `The world was saved, but the server could not be shut down (${reason}). It is still running, so the update was not applied. Use Force stop on the Dashboard to stop it, then apply the update again.`,
              code: "stop_failed",
              params: sanitizeErrorParams({ reason }),
            });
          }

          // quit()'s success:true means the RCON "quit" command was
          // acknowledged or its connection reset -- see rcon.js's own
          // comment on quit(). Neither proves the JVM has actually finished
          // exiting: PZ can spend many more seconds flushing world state to
          // disk after the RCON listener already dropped. downloadUpdate()
          // below recreates the all-in-one container this same process runs
          // in, which would kill that in-flight write exactly like starting
          // a new JVM over a still-running one elsewhere in this codebase
          // (/wipe, /delete-files, template-apply) -- same corruption class,
          // just triggered by a container recreation instead of a second
          // process. Poll the same process-state check those routes rely on
          // before letting the destructive step proceed: 30 looks a second
          // apart, never past a minute. A look that can't tell -- likeliest
          // right as the JVM exits -- doesn't end the wait (GH #190); only
          // the answer it ends on counts -- see waitForProcessExit().
          const recheck = await waitForProcessExit(
            () => serverManager.getServerProcessDetails(),
            {
              polls: 29,
              intervalMs: 1000,
              maxElapsedMs: 60 * 1000,
              sleep: (ms) => serverManager.sleep(ms),
              context: "Docker update",
              ownProcesses: processDetails.owned,
            },
          );
          const recheckScanFailed = Boolean(recheck.scanFailed);
          const stopConfirmed = !recheckScanFailed && !recheck.running;
          // Two different outcomes, two codes: the scan itself failing is
          // SERVER_STATE_UNKNOWN (whose copy is about process detection),
          // while a process still there after 30 s is a server hanging in
          // its shutdown -- the other way a server gets stuck, with Force
          // stop as the next step (SERVER_STOP_NOT_CONFIRMED, which Settings
          // › Updates offers the Dashboard for).
          if (!stopConfirmed && recheckScanFailed) {
            return res.status(503).json({
              success: false,
              error:
                "The world was saved and a shutdown was sent, but process detection failed while waiting for the server to exit, so the panel can't confirm it stopped. The Docker update was not applied.",
              code: ErrorCode.SERVER_STATE_UNKNOWN,
            });
          }
          if (!stopConfirmed) {
            return res.status(503).json({
              success: false,
              error:
                "The world was saved and a shutdown was sent, but the server process still hasn't exited, so the Docker update was not applied. Wait a little and try again. If it doesn't exit, use Force stop on the Dashboard, then apply the update again; anything since that save can be lost.",
              code: ErrorCode.SERVER_STOP_NOT_CONFIRMED,
            });
          }

          await logServerEvent(
            "server_stop",
            "Server stopped before Docker panel update",
          );
          stoppedServerForThisRequest = true;
        }
      }

      const result = await checker.downloadUpdate();
      if (!result.success) {
        // god's ruling, 2026-09-08: do NOT auto-restart the server here on a
        // failed apply -- a failed apply can leave a half-written install,
        // and launching the game server's JVM over that is exactly the
        // corruption activeSteamOperations' own crash-survival work exists
        // to prevent. Auto-restarting would also override an operator who
        // may have wanted the server down. Say so instead: the world was
        // already saved and the server already stopped (a real,
        // consequential action) as part of this request, and the download/
        // apply failure below is otherwise silent about that -- a user
        // reading only "update failed" has no way to know their server
        // needs a manual restart.
        if (stoppedServerForThisRequest) {
          result.error = `${result.error} Your game server was stopped to prepare for this update and was NOT restarted -- restart it manually.`;
          result.serverStoppedNotRestarted = true;
        }
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
const clientDistPath = cspClientDistPath;
const legacyClientMetadata =
  isPackaged && !embeddedClientDistPath
    ? readClientDistMetadata(clientDistPath)
    : null;
const legacyClientMismatch =
  isPackaged &&
  !embeddedClientDistPath &&
  !clientDistMatchesMetadata(clientDistPath, _buildMetadata);

function buildLegacyClientRecoveryPage() {
  const escapeHtml = (value) =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const frontendMetadata = legacyClientMetadata || "unavailable";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Panel update required</title></head>
<body><main>
<h1>Panel update required</h1>
<p>The executable and web interface are from different releases.</p>
<p>Executable: ${escapeHtml(`${_buildMetadata.panelVersion} / ${_buildMetadata.buildSha.slice(0, 12)}`)}</p>
<p>Frontend: ${escapeHtml(typeof frontendMetadata === "string" ? frontendMetadata : `${frontendMetadata.panelVersion} / ${frontendMetadata.buildSha.slice(0, 12)}`)}</p>
<p>Download the latest full package, extract it over this installation without replacing the <code>data</code> folder, then start the panel again.</p>
<p><a href="https://github.com/fpsacha/zomboid-control-panel/releases/latest">Download the latest release</a></p>
</main></body>
</html>`;
}

if (legacyClientMismatch) {
  log.error(
    `Packaged frontend does not match executable ${_buildMetadata.panelVersion}/${_buildMetadata.buildSha}; serving recovery page instead of mixed client/dist`,
  );
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.toLowerCase().startsWith("/api")) return next();
    res.status(503).type("html").send(buildLegacyClientRecoveryPage());
  });
}

log.debug(`Serving client from: ${clientDistPath}`);
// Serve hashed assets with long cache, HTML with no-cache
if (!legacyClientMismatch) {
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
}

export function sendClientIndex(res, clientDistPath, callback) {
  return res.sendFile("index.html", { root: clientDistPath }, callback);
}

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
// Same allowlist gate apiErrorHandler enforces below, factored out so a
// route that builds its own res.json() directly instead of calling
// next(err) -- and so never reaches apiErrorHandler at all -- can apply the
// identical check instead of a hand-rolled copy. That's how the Linux
// update-apply catch (POST /api/panel/restart) lost hash_unverifiable /
// binary_swap_failed / rollback_failed silently: it builds its 500 body
// locally and never called next(err), so this allowlist never ran for it.
export function registeredErrorCode(err) {
  return typeof err?.code === "string" && REGISTERED_ERROR_CODES.has(err.code)
    ? err.code
    : undefined;
}

// god-dispatched, 2026-09-08 (harden-updater-fileops #3): updateBundle.js's
// updateError() overwrites `.code` with a semantic bucket name
// (binary_swap_failed, frontend_swap_failed, ...) and keeps the REAL fs
// error -- the actual EPERM/EBUSY/EACCES/ENOSPC a rename/copy failed with
// -- only on `.cause`. Nothing read `.cause` anywhere, so a locked-by-AV
// rename, a permission problem and a full disk all logged the identical
// line: an operator with the log open had no more information than one
// without it. Server-log-only, deliberately -- see the Linux-apply catch's
// own comment for why this never reaches the client response.
export function describeErrorCause(err) {
  if (!err?.cause) return "";
  return ` (cause: ${err.cause.code || "no code"}: ${err.cause.message})`;
}
// Longest piece of caller text a log line quotes (auth audit #18). The path
// is the caller's, up to Node's 16 KB header limit, and so is an error
// message that quotes it (the router's "Failed to decode param '<segment>'");
// errors from before any sign-in reach the log on every request.
const MAX_LOGGED_TEXT_LENGTH = 200;
function loggedText(value) {
  const text = String(value ?? "");
  return text.length > MAX_LOGGED_TEXT_LENGTH
    ? `${escapeLogText(text.slice(0, MAX_LOGGED_TEXT_LENGTH))}...`
    : escapeLogText(text);
}
export function loggedRequestPath(req) {
  return loggedText(req.path);
}

// A request the parsers refused (bad JSON, too large, unknown charset, a
// path segment that is not valid percent-encoding): the caller's mistake,
// answered with its 4xx, nothing for the operator to fix.
function isRefusedRequestBody(err) {
  return (typeof err?.type === "string" || err instanceof URIError) && err.status >= 400 && err.status < 500;
}

// Exported so server/tests/errorCodeReachability.test.js can assert the
// allowlist both ways directly against the real handler, not a reimplementation.
export function apiErrorHandler(err, req, res, next) {
  // Escaped (utils/logText.js): this also catches errors from before any
  // sign-in -- a body the JSON parser rejects quotes that body in
  // err.message -- and req.path keeps bytes 0x80-0xFF from the request line.
  // A refused Origin was logged once already (corsRefusal()), and a refused
  // body only at debug level: anyone can send either, as often as they like.
  if (!err?.corsRefused) {
    const line = `Unhandled API error on ${escapeLogText(req.method)} ${loggedRequestPath(req)}: ${loggedText(err.message)}`;
    if (isRefusedRequestBody(err)) {
      log.debug(line);
    } else {
      log.error(line);
    }
  }
  const status = err.status || 500;
  const body = { error: sanitizeError(err.message) };
  const code = registeredErrorCode(err);
  if (code) {
    body.code = code;
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
  if (req.path.toLowerCase().startsWith("/api")) {
    res.status(404).json({ error: "API endpoint not found" });
  } else {
    sendClientIndex(res, clientDistPath, (err) => {
      if (err) {
        log.error(`Failed to serve index.html: ${err.message}`);
        res.status(500).send("Page not available");
      }
    });
  }
});

// Last stop for errors outside /api (auth audit #24): a refused Origin or an
// unreadable body reaches every path, not only /api. Express's own handler
// answers with the stack trace, absolute install paths included, unless
// NODE_ENV is "production", which only the Docker images set.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status =
    Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) {
    log.error(
      `Request error on ${escapeLogText(req.method)} ${loggedRequestPath(req)}: ${loggedText(err?.message)}`,
    );
  }
  res.status(status).type("text/plain").send(STATUS_CODES[status] || "Error");
});

// Socket.IO authentication middleware
io.use(async (socket, next) => {
  try {
    // No account exists yet: refuse, same as every /api route but the setup
    // ones (authService.middleware()'s SETUP_REQUIRED). This used to admit
    // the socket with no identity at all, and nothing ever dropped it once
    // setup locked the HTTP side, so it kept every broadcast afterwards. The
    // setup page doesn't use a socket (client/src/App.tsx connects one only
    // after setup), and createUser() drops every socket when the first
    // account is made, in case one got in some other way.
    const needsSetup = await authService.needsSetup();
    if (needsSetup) return next(new Error("First-run setup required"));

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
    // Signature already checked just above; decode only reads its expiry.
    socket.data.accessTokenExp = jwt.decode(token)?.exp;
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

// Socket.IO rooms that carry capability-gated broadcasts, and the capability
// each subscribe:* handler below checks before joining. Membership is
// decided once, at join time, so a role edit re-checks it
// (recheckCapabilityRooms below): otherwise a member kept receiving install,
// chunk-scan, log, perf, player and live-RCON events after the capability
// was taken off their role, until they reconnected.
export const CAPABILITY_ROOMS = Object.freeze({
  players: "players.view",
  install: "server.install",
  chunkscan: "chunks.manage",
  logs: "diagnostics.manage",
  perf: "diagnostics.manage",
  "rcon-live": "rcon.execute",
  // Backup/restore progress (backupService.js). Any one of these, like
  // GET /api/backup/status, which any backup capability may read -- plus
  // server.wipe, whose pre-wipe backup reports its progress in the wipe
  // dialog.
  [BACKUP_PROGRESS_ROOM]: Object.freeze([
    "backups.manage",
    "backups.download",
    "backups.restore",
    "server.wipe",
  ]),
});

// Whether `socket` may be in `room`: its role holds the room's capability,
// or one of them when the room lists several.
export async function socketMayJoinRoom(socket, room) {
  const required = CAPABILITY_ROOMS[room];
  if (!required) return false;
  for (const capability of [].concat(required)) {
    if (await socketHasCapability(socket, capability)) return true;
  }
  return false;
}

// Remove the sockets of `roleName`'s members (every socket when null) from
// each capability room their role no longer allows. Fail closed like the
// join checks: a role that no longer resolves leaves every gated room.
export async function recheckCapabilityRooms(roleName = null, server = io) {
  for (const s of [...server.sockets.sockets.values()]) {
    if (!s.user || (roleName && s.user.role !== roleName)) continue;
    for (const room of Object.keys(CAPABILITY_ROOMS)) {
      if (s.rooms.has(room) && !(await socketMayJoinRoom(s, room))) {
        s.leave(room);
      }
    }
  }
}
onRoleCapabilitiesChanged((roleName) => {
  recheckCapabilityRooms(roleName).catch((error) =>
    log.warn(`Could not re-check socket rooms after a role edit: ${error.message}`),
  );
});

// Socket.IO connection handling
// Emit an event only to sockets whose role holds one of `capabilities`.
// Fail closed: a socket with no resolvable role receives nothing. Used for
// broadcasts that cannot use a pre-joined room (rare events, or per-socket
// field selection) — security audit M1: several broadcasts sent privileged
// content (admin chat, bridge host paths, live player lists) to every
// authenticated socket regardless of role, bypassing the HTTP gates that
// protect the same data. `payload` may be a function of the receiving
// socket, for an event whose fields depend on who gets it.
export async function emitToCapabilities(capabilities, event, payload, server = io) {
  // Resolve each distinct role once per broadcast, not once per socket.
  const roleAllowed = new Map();
  const allowed = async (s) => {
    const roleName = s.user.role;
    if (!roleAllowed.has(roleName)) {
      roleAllowed.set(
        roleName,
        (async () => {
          for (const capability of capabilities) {
            if (await socketHasCapability(s, capability)) return true;
          }
          return false;
        })(),
      );
    }
    return roleAllowed.get(roleName);
  };
  for (const s of [...server.sockets.sockets.values()]) {
    if (!s.user) continue;
    if (await allowed(s)) s.emit(event, typeof payload === "function" ? await payload(s) : payload);
  }
}

// SECURITY (2026-10-08, auth audit #11): a socket's token is checked once,
// at connect, so a 15-minute token (a ?token= from a proxy log, one copied
// before sign-out) kept a live feed (rcon-live, logs, players) until a
// revocation or a restart. At the token's expiry the transport is closed
// rather than the socket disconnected: the panel's own client then
// reconnects by itself and its auth provider refreshes the token first
// (client/src/lib/socketAuth.ts), while io.use refuses a stolen one.
// auth:token-expired goes out first so the client can treat that reconnect
// as routine (client/src/App.tsx shows no "Reconnected" toast for it).
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
function closeSocketAtTokenExpiry(socket, expSeconds) {
  if (!Number.isFinite(expSeconds)) return;
  const delay = Math.min(Math.max(0, expSeconds * 1000 - Date.now()), MAX_TIMER_DELAY_MS);
  const timer = setTimeout(() => {
    socket.emit("auth:token-expired");
    socket.conn.close();
  }, delay);
  timer.unref?.();
  socket.once("disconnect", () => clearTimeout(timer));
}

io.on("connection", (socket) => {
  log.debug(
    `Client connected: ${socket.id}${socket.user ? ` (${socket.user.username})` : ""}`,
  );

  closeSocketAtTokenExpiry(socket, socket.data?.accessTokenExp);

  // Membership for the per-user eviction room used by the
  // onSessionRevoked() subscription below (password change/reset, role
  // change, user delete). Auth-disabled connections have no real userId
  // (socket.user.userId is null) and are intentionally left out -- there is
  // no DB user row for them to be revoked against. (Connections from before
  // first-run setup, which had no socket.user at all, are refused by io.use
  // now.)
  if (socket.user?.userId) {
    socket.join(`user:${socket.user.userId}`);
  }

  socket.on("disconnect", () => {
    log.debug(`Client disconnected: ${socket.id}`);
  });

  // Subscribe to server status updates. GET /api/server/status has no
  // permission gate at all (deliberate -- every logged-in role, and the
  // dashboard itself, needs it), so this room is intentionally open too.
  socket.on("subscribe:status", () => {
    // Signed in (or auth disabled) only; io.use above no longer admits a
    // socket without a user, so this is the second lock on the same door.
    if (!socket.user) return;
    socket.join("server-status");
  });

  // Subscribe to player updates. Mirrors GET /api/players/ (players.js),
  // which requires players.view -- this room carries the same data and
  // must not be reachable by a role that route refuses.
  socket.on("subscribe:players", async () => {
    if (!(await socketHasCapability(socket, CAPABILITY_ROOMS.players))) return;
    socket.join("players");
  });

  // Subscribe to server-install progress (install:* and steamcmd:* events).
  // Mirrors the install routes' server.install gate: the payloads carry host
  // paths and raw SteamCMD output, so they must not reach every signed-in
  // role (security audit M1).
  socket.on("subscribe:install", async () => {
    if (!(await socketHasCapability(socket, CAPABILITY_ROOMS.install))) return;
    socket.join("install");
  });

  // Subscribe to chunk-scan progress. Mirrors routes/chunks.js's
  // chunks.manage gate (security audit M1).
  socket.on("subscribe:chunkscan", async () => {
    if (!(await socketHasCapability(socket, CAPABILITY_ROOMS.chunkscan))) return;
    socket.join("chunkscan");
  });

  // Subscribe to logs. Mirrors GET /api/debug/logs (debug.js), which
  // requires diagnostics.manage -- that route's own gate is what this
  // socket has to match. Not "every route in debug.js requires it": that
  // was asserted here once (bughunt-2026-08-31-b, completeness-claims
  // audit) and was already false the day it was written -- POST
  // /debug/client-errors is a deliberate, separately-documented
  // unauthenticated exception (write-only crash-report intake, returns no
  // data, doesn't undermine this socket's purpose either way). A second
  // exception added later would make a re-stated "every route but that
  // one" claim just as stale. Check GET /api/debug/logs's own gate
  // directly if this ever needs re-verifying, not a count of the file.
  // Without this check, moderator (which does not hold diagnostics.manage)
  // could get the identical live log stream just by connecting a socket
  // instead of calling the HTTP route. RCON command
  // text used to ride along in this room too (rcon.js's rcon:response
  // event) -- moved to its own rcon-live room below (2026-08-31 bug hunt),
  // since that content is gated rcon.execute everywhere else it's exposed
  // (see /rcon/history's own header comment) and diagnostics.manage is a
  // different, broader capability that never mentions RCON at all.
  socket.on("subscribe:logs", async () => {
    if (!(await socketHasCapability(socket, CAPABILITY_ROOMS.logs))) return;
    socket.join("logs");
  });

  // Subscribe to performance snapshots. Mirrors POST
  // /api/debug/performance-snapshot (debug.js), also diagnostics.manage.
  socket.on("subscribe:perf", async () => {
    if (!(await socketHasCapability(socket, CAPABILITY_ROOMS.perf))) return;
    socket.join("perf");
  });
  socket.on("unsubscribe:perf", () => {
    socket.leave("perf");
  });

  // Subscribe to live RCON command/response traffic (rcon.js's
  // rcon:response event). Mirrors GET /api/rcon/history, which requires
  // rcon.execute specifically -- not diagnostics.manage, a different and
  // broader capability -- because that route's own header comment records
  // a past fix: an ungated history endpoint let any logged-in role read
  // every admin/technician's past RCON console session and every
  // whitelist password ever set. The live broadcast of the identical
  // content class must not reopen that through a narrower-looking but
  // still-too-broad gate (2026-08-31 bug hunt).
  socket.on("subscribe:rcon", async () => {
    if (!(await socketHasCapability(socket, CAPABILITY_ROOMS["rcon-live"]))) return;
    socket.join("rcon-live");
  });

  // Subscribe to backup/restore progress (backup:progress, restore:progress,
  // restore:finished). Those went to every socket whatever its role, with
  // raw error text; the backup routes that start them, and GET
  // /api/backup/status that reports them, are all gated on a backup
  // capability.
  socket.on("subscribe:backups", async () => {
    if (!(await socketMayJoinRoom(socket, BACKUP_PROGRESS_ROOM))) return;
    socket.join(BACKUP_PROGRESS_ROOM);
  });
});

// Sockets authenticate once at handshake (io.use above) and are never
// re-validated per event, so without this, regenerate-jwt-secret,
// change-password/reset-password, role changes, and user deletion (the
// revocation paths in services/auth.js) would all be no-ops for any socket
// that connected before the change -- e.g. a revoked user's already-open
// socket would keep receiving the rcon-live room's whitelist passwords
// indefinitely. disconnectSockets(true) closes them, and socket.io-client
// does not reconnect by itself after a server-side disconnect; the next
// connect (Retry in the client's connection status, or a reload) re-runs
// io.use and picks up the new state (or fails closed if the user is gone).
// Exported (not an inline closure) so tests can call it directly against
// the real `io` instance and assert the disconnect calls it makes, without
// needing a live network socket to prove the wiring is correct.
export function evictRevokedSockets(event) {
  if (event.scope === "all") {
    io.disconnectSockets(true);
  } else if (event.scope === "user" && event.userId) {
    io.in(`user:${event.userId}`).disconnectSockets(true);
  }
}
onSessionRevoked(evictRevokedSockets);

// Stream logs to Socket.IO clients
onLog((logEntry) => {
  addLogToBuffer(logEntry.level, logEntry.message, logEntry.source);
  io.to("logs").emit("log:entry", logEntry);
});

// ============================================
// Auto-export player data on login
// ============================================
import { getDataPaths } from "./utils/paths.js";
import { encodeExportFolderName, legacyExportFolderName } from "./utils/exportFolderName.js";

// Exported so tests can call it directly against real fs/database state
// without needing a live PanelBridge mod connection -- see
// server/tests/autoExportPlayerCollision.test.js.
export async function autoExportPlayer(username) {
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

    // One folder per exact username (utils/exportFolderName.js): the
    // rotation below deletes from this folder, so a folder shared with a
    // differently-named player would rotate out THEIR exports.
    const exportFolder = encodeExportFolderName(username);
    if (!exportFolder) {
      log.warn(`Auto-export skipped for ${username}: the name can't be used as an export folder`);
      return;
    }
    const { dataDir } = getDataPaths();
    const exportDir = path.join(dataDir, "exports", exportFolder);
    fs.mkdirSync(exportDir, { recursive: true });

    // Write timestamped export file. toISOString() is millisecond-resolution
    // -- two auto-exports for the SAME player landing in the same
    // millisecond (e.g. a rapid disconnect/reconnect scheduling two
    // 10-second-delayed timers close together) would otherwise silently
    // overwrite one export with the other. Same collision-suffix convention
    // as configBackup.js/database/init.js's backup rings -- the suffix goes
    // BEFORE the .json extension (name-<n>.json), not after, so the
    // rotation filter/sort below (which matches on ".json") still sees the
    // file: an earlier draft of this fix appended "-<n>" after ".json" and
    // silently exempted every collided export from rotation forever.
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeUsername = legacyExportFolderName(username);
    const exportBaseName = `${safeUsername}_${timestamp}`;
    let exportPath = path.join(exportDir, `${exportBaseName}.json`);
    for (let collision = 2; fs.existsSync(exportPath); collision++) {
      exportPath = path.join(exportDir, `${exportBaseName}-${collision}.json`);
    }
    fs.writeFileSync(exportPath, JSON.stringify(result.data || result, null, 2));

    // Rotate — keep only the last N exports. Same (timestampKey,
    // collisionSuffix)-parsing sort as database/init.js's
    // sortBackupFilenamesNewestFirst(): a raw string sort would put
    // "-2.json" before ".json" ('-' < '.'), treating a collision's later
    // duplicate as older than the original it collided with.
    const maxExports = Number(await getSetting("autoExportMaxPerPlayer")) || 3;
    const files = fs
      .readdirSync(exportDir)
      .filter((f) => f.endsWith(".json"))
      .map((name) => {
        const withoutExt = name.slice(0, -".json".length);
        const match = withoutExt.match(/^(.*)-(\d+)$/);
        return match
          ? { name, key: match[1], suffix: parseInt(match[2], 10) }
          : { name, key: withoutExt, suffix: 1 };
      })
      .sort((a, b) => {
        if (a.key !== b.key) return a.key < b.key ? 1 : -1; // newest first
        return b.suffix - a.suffix; // higher collision suffix = created later
      })
      .map((c) => c.name);

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

// continuous-bug-hunt round 21 (other per-server data kept in one global
// store): lastPlayerList/playerBaselineReady are module-level state fed by
// this SAME rconService singleton reloadServicesForNewActiveServer()
// (routes/servers.js) already repoints on every active-server switch --
// but nothing ever reset THESE two, so for up to 5s after switching
// servers (this poll's own interval), the player count fed into perf
// snapshots (index.js's own startPerfPolling(), round 20) and every
// 'players:update' socket emission still showed the PREVIOUS server's
// roster. Exposed the same reset startPlayerPolling() already does on
// ordinary startup so reloadServicesForNewActiveServer() can call it too,
// via the same req.app.get(...) pattern that function already uses for
// LogTailer/PanelBridge -- registered right below, next to the function.
function resetPlayerPollingBaseline() {
  lastPlayerList = [];
  playerBaselineReady = false;
}

function startPlayerPolling() {
  // Poll every 5 seconds for player changes
  if (playerPollingInterval) {
    clearInterval(playerPollingInterval);
  }
  resetPlayerPollingBaseline();

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
      // continuous-bug-hunt round 20 (charts mixing samples from two
      // servers after a switch): every recorded/broadcast snapshot used to
      // carry no server identity at all -- performance_history was one
      // single global array shared across every managed server. On a panel
      // with more than one server, switching the active server never
      // scoped this collection in any way: the next chart read (GET
      // /debug/performance-history) returned a straight time-ordered mix
      // of whichever server(s) happened to be active during each sample's
      // window, with nothing distinguishing a Server A sample from a
      // Server B one. Tagging every snapshot with the server that was
      // active AT SAMPLE TIME is the minimal fix that needs no schema
      // migration -- getPerformanceHistory() (below) can now filter by it,
      // and pre-fix legacy rows (serverId undefined) are treated as
      // "unknown, don't exclude" rather than silently disappearing.
      const activeServerForSnapshot = await getActiveServer().catch(() => null);

      const snapshot = {
        serverId: activeServerForSnapshot?.id ?? null,
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
        //
        // is-running-enumeration sweep, 2026-09-08: was serverManager.isRunning
        // -- a local-scan-only cached field, always false for a docker-local/
        // docker-managed/remote active server no matter what RCON or the
        // bridge report, the exact GH#114 shape already fixed at every other
        // "is the active server running" site (see getObservedServerRunning()
        // below, which discordBot.js and the watchdog already use). This was
        // the one remaining unswept site -- display-only (feeds the
        // performance-history chart's running/stopped annotation, nothing
        // gates on it), but it perpetuated the same wrong answer those other
        // sites were fixed to stop giving.
        playerCount: lastPlayerList.length,
        serverRunning: Boolean(await getObservedServerRunning()),
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
let lastKnownPhase = null;
// Distinct from `lastKnownRunning === null` (which also means "never
// observed anything yet"). See checkServerStatusNow()'s own comment on the
// `running === null` branch for why a THIRD state is needed here.
let lastObservationWasUnknown = false;

// Thin, no-arg wrapper over utils/serverStatus.js's shared
// resolveObservedServerRunning() -- see that function's own doc comment for
// why the branching logic (remote / docker-local / docker-managed / local
// process+RCON+bridge) lives there now instead of here: discordBot.js needed
// the identical verdict and could not import this module (circular).
export async function getObservedServerRunning() {
  return resolveObservedServerRunning(serverManager, rconService, dockerClient);
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
// something false. That specific bypass -- a route asserting a competing
// claim without ever touching `lastKnownRunning` -- is closed now: routes
// ask this function to re-check instead of emitting their own.
//
// 2026-08-31 bug hunt (consolidation, carded by Pam's completeness-claims
// audit and Dwight's own file): the rconService "disconnected" handler
// below (:1219-1244) used to be a SECOND, independent reader/writer of
// `lastKnownRunning` -- same comparison shape, same guard, so the two never
// actually drifted, but a future fix made only here would not have reached
// it. That handler now calls this function instead (with `detectionReason`
// identifying itself), so there is genuinely only one place left that reads,
// compares, mutates and emits this decision -- the property this function's
// own name has always implied.
// continuous-bug-hunt round 28 (ux-proposals-need-backend-data): a native
// crash and a deliberate stop looked identical to every client -- both just
// showed "stopped". Called once, right when the watchdog below observes a
// running:true -> false transition, never on every tick (see its own call
// site) so it always reflects the specific stop that just happened, not a
// stale earlier one.
//
// Precedence, most to least specific:
// 1. serverManager.stopIntent -- set by ServerManager.restartServer() or
//    scheduler.js's performRestart() (both set 'restart' before they do
//    anything) or ServerManager.stopServer() (sets 'stop', but only if
//    nothing more specific already claimed it -- see that method's own
//    comment) BEFORE the process actually goes down. The single most
//    reliable signal because it comes from the exact code that decided to
//    stop the process, not an inference after the fact.
// 2. rconService.lastQuitAttemptAt -- set unconditionally by every call to
//    rcon.js's quit(), the one command that actually asks PZ to shut down
//    gracefully. A quit attempt with no more specific stopIntent recorded
//    (routes/server.js's ordinary /stop, or a Discord-triggered stop --
//    neither goes through ServerManager.stopServer()/restartServer() for a
//    graceful shutdown) is still a deliberate stop, just one this file
//    can't name any more precisely than that. Time-bounded so a quit
//    attempt from an unrelated, long-past request can't misattribute a
//    LATER, genuinely unexpected exit.
// 3. serverManager.lastExitInfo -- the real exit code/signal from the
//    spawned child (best-effort, see _attachExitTracking's own comment on
//    its Windows-wrapper caveat). A non-zero code or a signal with no
//    deliberate-stop signal above it is the actual definition of "crashed"
//    this feature exists to surface.
// 4. Anything else: 'unknown' -- no confident claim, matches this codebase's
//    existing fail-closed-to-"we don't know" convention (scanFailed,
//    dockerContainer unresolved, etc.) rather than guessing.
//
// Both stopIntent and lastQuitAttemptAt are CONSUMED (cleared) here so the
// next stop is judged fresh instead of inheriting this one's leftovers.
const QUIT_ATTEMPT_RECENCY_MS = 60000;

// Exported (and parameterized rather than reading the module-level
// serverManager/rconService singletons directly) so this can be unit
// tested against plain fake objects instead of needing to reach into
// index.js's own unexported instances -- see
// server/tests/classifyStopReason.test.js.
export function classifyStopReason(serverManager, rconService) {
  const intent = serverManager.stopIntent;
  serverManager.stopIntent = null;
  if (intent === "stop" || intent === "restart") {
    return { reason: intent, exitCode: null, signal: null, at: new Date().toISOString() };
  }

  const quitAt = rconService.lastQuitAttemptAt;
  rconService.lastQuitAttemptAt = null;
  const quitRecent =
    typeof quitAt === "string" &&
    Date.now() - new Date(quitAt).getTime() < QUIT_ATTEMPT_RECENCY_MS;
  if (quitRecent) {
    return { reason: "stop", exitCode: null, signal: null, at: new Date().toISOString() };
  }

  const exitInfo = serverManager.lastExitInfo;
  if (exitInfo && (exitInfo.exitCode !== 0 || exitInfo.signal)) {
    return {
      reason: "crash",
      exitCode: exitInfo.exitCode ?? null,
      signal: exitInfo.signal ?? null,
      at: new Date().toISOString(),
    };
  }

  return { reason: "unknown", exitCode: null, signal: null, at: new Date().toISOString() };
}

export async function checkServerStatusNow(detectionReason = "watchdog") {
  try {
    const running = await getObservedServerRunning();
    if (running === null) {
      // round-6 bug hunt: this used to return here unconditionally, with no
      // emit and no state mutation at all. Fine the FIRST time this watchdog
      // ever runs (there is no known state yet to contradict) -- but once a
      // REAL value has been observed and observation then stops working
      // (scan failure, RCON drop, and bridge all down at once -- see
      // isServerObservedRunning()'s own null branch), every client relying
      // solely on this push for its live state -- Layout.tsx's native-
      // provider sidebar dot has no independent REST poll, unlike
      // Dashboard.tsx's 15s interval -- was stuck showing the stale
      // last-known value forever, silently disagreeing with what a fresh
      // GET /active/status would have honestly reported as scanFailed/
      // unknown. Emit once per unknown streak so clients fall back to their
      // own scanFailed-aware fetch (Layout.tsx's onStatus already does this
      // for anything that isn't a plain running boolean/known phase --
      // `running` is deliberately omitted here, not sent as `null`, so a
      // client whose merge logic assumes a boolean is untouched rather than
      // handed a value it never expected).
      if (lastKnownRunning !== null && !lastObservationWasUnknown) {
        log.info(
          `Server state became unknown (detected by ${detectionReason})`,
        );
        io.emit("server:status", { phase: "unknown" });
      } else {
        log.debug("Status watchdog: server state is unknown; skipping transition");
      }
      lastObservationWasUnknown = true;
      return;
    }
    // Display-only refinement of `running` -- see resolveServerPhase()'s own
    // comment. Never read for any decision in this function: the
    // running/stopped comparisons and Discord notifications below are
    // unchanged, so a starting/unresponsive server can't newly block or skip
    // anything that a plain running:true already didn't.
    const phase = resolveServerPhase({
      running,
      serverStarting: Boolean(rconService.serverStarting),
      rconConnected: Boolean(rconService.connected),
    });
    const runningChanged = lastKnownRunning !== null && running !== lastKnownRunning;
    // `running` stays true across the whole starting -> unresponsive/running
    // handoff (host process is up the entire time), so without this the dot
    // would freeze on whatever phase it first saw and never update -- the
    // exact "starting forever" lie this feature exists to avoid.
    const phaseChanged = lastKnownPhase !== null && phase !== lastKnownPhase;
    // A recovery FROM unknown back to the exact same value clients were
    // last confidently told (it was "running", went unknown for a tick, and
    // is confirmed "running" again -- no genuine runningChanged/phaseChanged
    // at all) must still be RE-ANNOUNCED over the socket: clients were just
    // shown "unknown" in between and need the correction back. Kept
    // deliberately separate from runningChanged/phaseChanged below (rather
    // than OR'd into them) so a mere unknown-blip recovery can trigger the
    // client-facing re-emit without ALSO firing a spurious Discord
    // serverStart/serverStop notification for a server that never actually
    // transitioned.
    const reannounceAfterUnknown = lastObservationWasUnknown;
    lastObservationWasUnknown = false;
    // A stopped verdict that is new -- a running -> stopped transition, or
    // this panel process's first observation (a panel restarted minutes
    // after a quiet stop) -- means the PanelBridge heartbeat on disk was
    // written by a process that is gone, and must stop counting as a live
    // mod now, not up to five minutes from now (PanelBridge.markServerExited()).
    // Not repeated on every stopped tick, so a live mod the scan can't
    // attribute is never re-expired every 10s. Ordered BEFORE the
    // server:status emit below: every page refetches the composed status
    // (host/RCON/PanelBridge) on that push, and it must already read
    // PanelBridge offline when they do.
    if (running === false && lastKnownRunning !== false) {
      panelBridge.markServerExited();
    }
    // The other half: a running server stops being described as stopped in
    // the bridge diagnostics (PanelBridge.markServerRunning()), while the
    // exited write itself stays dead until the new process writes. Every
    // running tick rather than only a transition: a restart that pushes its
    // own verified transitions can stop and relaunch the server between two
    // ticks, so this watchdog never sees it stopped. Idempotent, and it
    // never changes whether the mod counts as connected.
    if (running === true) {
      panelBridge.markServerRunning();
    }
    if (runningChanged || phaseChanged || reannounceAfterUnknown) {
      log.info(
        runningChanged || phaseChanged
          ? `Server state changed → ${running ? "running" : "stopped"}${runningChanged ? "" : ` (phase: ${phase})`} (detected by ${detectionReason})`
          : `Server state confirmed ${running ? "running" : "stopped"} (phase: ${phase}) after a brief unknown period (detected by ${detectionReason})`,
      );
      io.emit("server:status", { running, phase });
      if (runningChanged && !running) {
        const stopReason = classifyStopReason(serverManager, rconService);
        serverManager.lastStopReason = stopReason;
        logServerEvent(
          "server_stop",
          // "(detected by X)" stays an intact, standalone parenthetical --
          // checkServerStatusNowDetectionReason.test.js already asserts on
          // that exact substring for the pre-existing detectionReason
          // feature; the new stop-reason info is appended after it rather
          // than folded inside the same parens, so this addition can't
          // silently break that existing contract.
          `Server process exited (detected by ${detectionReason}) — reason: ${stopReason.reason}`,
        );
        discordBot
          .sendEventNotification("serverStop", {})
          .catch((err) =>
            log.debug(
              `Discord serverStop notification failed: ${err.message}`,
            ),
          );
      } else if (runningChanged) {
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
    lastKnownPhase = phase;
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

// The boot auto-start's launch, made the same as the dashboard's Start (POST
// /api/server/start) where the two used to differ (GH #167): a Docker-managed
// server starts through Docker -- calling serverManager.startServer() for one
// spawned a second, native server beside its container -- and a server that
// has never booted without an admin password is refused with the same reason
// instead of launched into a console prompt nobody can answer. The launch
// target refresh itself happens inside both launch paths
// (lifecycleCoordinator.prepareForLaunch()). Exported for testing, with the
// two launchers injectable the same way as probeRconFallbackIfConfigured().
export async function startServerForAutoStart(
  activeServer,
  {
    serverManagerInstance = serverManager,
    runManaged = runManagedLifecycle,
  } = {},
) {
  const serverId = activeServer?.id ?? null;
  const managed = await runManaged("start", { serverId });
  if (managed.handled) {
    return managed.success
      ? managed
      : { success: false, error: managed.error || "Container start failed" };
  }
  if (isFirstBootMissingAdminPassword(activeServer)) {
    const name = activeServer.name || activeServer.serverName;
    return {
      success: false,
      error:
        `${name} has never started before and has no admin password set, so Project Zomboid would stop at a ` +
        `console prompt for one that the panel can't answer. Set an admin password for this server (My Servers → ` +
        `${name} → Admin Password), then press Start or restart the panel.`,
    };
  }
  return serverManagerInstance.startServer({ serverId });
}

// The auto-start's success line. runManagedLifecycle("start") answers for a
// Docker-managed container that is already up with success and
// alreadyRunning, having started nothing, so "auto-started" would log a
// start that never happened.
export function describeAutoStartSuccess(startResult) {
  return startResult?.alreadyRunning
    ? "PZ server container was already running - connecting RCON"
    : "PZ server auto-started successfully";
}

// A failed start's reason for the auto-start log line -- a thrown Error or a
// { success: false, error } result, never an empty string.
export function describeAutoStartFailure(failure) {
  const detail =
    typeof failure === "string"
      ? failure
      : failure instanceof Error
        ? failure.message
        : failure?.error || failure?.message;
  return String(detail || "").trim() || "no reason was given";
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

// Startup-failure-mode sweep, 2026-09-07 (god's dispatch): resolves the
// configured HTTP port, falling back to 3001 for anything out of range --
// same fallback this always had, but now WARNS when that fallback actually
// discards an operator-set value instead of silently substituting it. A
// bad PORT env var (a typo, a stray quote from a .env file, a value copied
// from a different app) or a corrupted `panelPort` setting used to just
// become 3001 with nothing in the log to explain why the panel wasn't
// listening where the operator expected -- SILENT-OR-GENERIC in the exact
// sense this sweep is looking for: it doesn't fail, so there's nothing to
// investigate, and it doesn't do what was asked either. Exported so the
// resolution logic is directly testable without booting start()'s full
// listen()-and-banner sequence.
export function resolvePanelPort(rawValue, { onInvalid } = {}) {
  const configuredPort = Number(rawValue);
  if (
    Number.isInteger(configuredPort) &&
    configuredPort >= 1 &&
    configuredPort <= 65535
  ) {
    return configuredPort;
  }
  if (rawValue !== undefined && rawValue !== null && rawValue !== "") {
    onInvalid?.(rawValue);
  }
  return 3001;
}

// Shapes the socket.io "chat:message" payload sent for each logTailer
// 'chatMessage' event. Pulled out as its own function (rather than inlined
// in the listener below) so the mapping -- in particular, that
// sourceChatType survives the trip -- is unit-testable without booting the
// whole server. sourceChatType is the PZ chat room's real title (e.g.
// "Private" for a whisper, "Faction", "Safehouse", "Radio", "Shout"), not
// just the 3-way admin/server/general `type` bucket Chat.tsx styles by --
// dropping it here (as this payload used to) meant the client had no way to
// tell a private whisper between two players apart from ordinary public
// chat, even though logTailer.js had already done the work of computing it
// (see chatMessageKey/collectChatRoomIds) and discordBot.js's chat relay
// already depends on this exact same field to keep private channels out of
// Discord (PUBLIC_CHAT_TYPES in discordBot.js).
export function buildChatSocketPayload(data, id) {
  return {
    id,
    type: data.type || "general",
    author: data.author,
    message: data.message,
    timestamp: data.timestamp,
    sourceChatType: data.sourceChatType,
  };
}

// Room types every signed-in role may watch: they are visible in-game to
// every player anyway. Admin chat, and any room type not in this list
// (Faction, Safehouse, Radio, a Private whisper...), goes only to roles
// holding PRIVATE_CHAT_CAPABILITIES (security audit M1). That is
// players.moderate -- the in-game moderation authority moderators,
// technicians and admins all hold -- not rcon.execute, which would have cut
// the moderator role off from the very admin chat it exists to take part in.
export const PUBLIC_CHAT_ROOM_TYPES = new Set([
  "Local",
  "Shout",
  "Say",
  "General",
  "Roleplay",
  "Server Alert",
  "Server chat",
]);
export const PRIVATE_CHAT_CAPABILITIES = ["players.moderate"];

export function isPublicChatMessage(data) {
  if (data?.type === "admin") return false;
  const roomType = String(data?.sourceChatType || "").trim();
  return !roomType || PUBLIC_CHAT_ROOM_TYPES.has(roomType);
}

// Every message -- public or not -- goes through one promise chain, so a
// restricted message whose recipients are still being resolved (async role
// lookups) cannot be overtaken by the public line that followed it in the
// log. A failed send is reported and the chain keeps going.
export function createChatBroadcaster({ emitPublic, emitRestricted, onError = () => {} }) {
  let chain = Promise.resolve();
  return (data, payload) => {
    chain = chain
      .then(() => (isPublicChatMessage(data) ? emitPublic(payload) : emitRestricted(payload)))
      .catch(onError);
    return chain;
  };
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

    if (typeof process.pkg !== "undefined") {
      try {
        _pendingUpdateInspection = inspectPendingPanelUpdate();
      } catch (error) {
        // A log line is the ENTIRE interface for a failure this early --
        // there is no HTTP server yet for a UI to report through. Naming
        // the journal path here is the difference between "delete the
        // right file" and "go find it yourself" for whichever of the two
        // outcomes below actually applies (a version_mismatch that just
        // got rolled back, or anything else that didn't).
        const journalPath = updateBundleJournalPath();
        log.error(
          `Update startup validation failed [${error.code || "invalid_bundle"}]: ${error.message}. Journal: ${journalPath}`,
        );
        recoverFromStartupInspectionFailure(error, journalPath);
        process.exit(76);
        return;
      }
    }

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

    // Rehydrate any Steam operation (install/update/auto-update) that was
    // still recorded as in-flight when this process last exited -- if that
    // was a genuine crash (not a clean shutdown, which never leaves one
    // behind) rather than the operation actually finishing, an orphaned
    // SteamCMD could still be writing to the install directory right now.
    // Must run before anything in this process could ever call
    // startServer() or start a second Steam operation on the same path --
    // both check the same in-memory guard this seeds. See
    // activeSteamOperations.js's own header for why: the alternative is the
    // JVM launching over a half-written install, a corrupted server, not a
    // retryable failure.
    await rehydrateActiveSteamOperationsFromDisk();

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
    // Public rooms go to every socket; admin chat and private rooms go only
    // to moderation roles (see isPublicChatMessage). Every message -- public
    // or not -- goes through one promise chain, so a restricted message whose
    // recipients are still being resolved cannot be overtaken by the public
    // line that followed it in the log.
    const broadcastChat = createChatBroadcaster({
      emitPublic: (payload) => io.emit("chat:message", payload),
      emitRestricted: (payload) =>
        emitToCapabilities(PRIVATE_CHAT_CAPABILITIES, "chat:message", payload),
      onError: (error) => log.debug(`Chat broadcast failed: ${error.message}`),
    });
    logTailer.on("chatMessage", (data) => {
      broadcastChat(data, buildChatSocketPayload(data, `${Date.now()}-${chatMessageSeq++}`));
    });

    // Player deaths -- forward to Discord and persist as a player action so
    // they show up in player history. PanelBridge reports them when it can;
    // the B42 user.txt lines are only the fallback, since a crafted co-op
    // name can forge them (services/playerDeathEvents.js).
    const handlePlayerDeath = async (data) => {
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
      io.to("players").emit("player:death", data);
    };
    const playerDeaths = createPlayerDeathRouter({
      bridge: panelBridge,
      onDeath: handlePlayerDeath,
    });
    logTailer.on("playerDeath", playerDeaths.fromUserLog);
    panelBridge.on("playerDeath", playerDeaths.fromBridge);

    // Initialize scheduler first (needed by modChecker for auto-restart)
    await scheduler.init();

    // Initialize mod checker with scheduler, serverManager, and socket.io
    await modChecker.init(scheduler, serverManager, io);

    // Thumbnails cached for Workshop items no server tracks -- older
    // versions cached any id an anonymous caller named (routes/mods.js,
    // SECURITY 2026-10-05, H3). In the background: startup doesn't wait.
    pruneModThumbnailCache().catch((err) =>
      log.warn(`Could not prune the mod thumbnail cache: ${err.message}`),
    );

    // Start mod checker if workshop ACF file is found. Otherwise it starts
    // by itself once one appears: the server writes its own on its first
    // Workshop download (ModChecker.watchForWorkshopAcf()).
    if (!modChecker.workshopAcfPath || !modChecker.start()) {
      log.info(
        "Mod checker: Workshop ACF not found yet — it starts once the server has downloaded a Workshop item, or configure the server install path",
      );
      modChecker.watchForWorkshopAcf();
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
              const lifecycleLock = acquireLifecycleLock(
                "startup-auto-start",
                activeServer?.id ?? null,
              );
              if (!lifecycleLock) {
                log.warn(
                  "Auto-start skipped because another lifecycle operation is in progress",
                );
                rconService.setServerStarting(false);
              } else {
                log.info("Auto-start is enabled - starting PZ server...");

                // Set flag to prevent auto-reconnect from interfering
                rconService.setServerStarting(true);

                try {
                  const startResult = await startServerForAutoStart(activeServer);
                  if (startResult.success) {
                    log.info(describeAutoStartSuccess(startResult));

                    // Wait for server to fully start before connecting RCON
                    // Monitor the TCP port instead of hard waiting
                    log.info("Auto-start: monitoring the RCON port...");

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
                    // One template string, not log.error(msg, detail): the
                    // logger (winston, no splat format) drops a second string
                    // argument, which is why GH #167's log read "Error
                    // during auto-start:" with nothing after it.
                    log.error(
                      `Failed to auto-start PZ server: ${describeAutoStartFailure(startResult)}`,
                    );
                  }
                } catch (e) {
                  // startServer()'s error already carries the exit code and
                  // the tail of the game's own output (server-launch.log)
                  // when the process died right after launching.
                  log.error(`Error during auto-start: ${describeAutoStartFailure(e)}`);
                } finally {
                  // Clear the flag so auto-reconnect can resume normally
                  rconService.setServerStarting(false);
                  lifecycleLock.release();
                }
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

    // Server Files: hourly Trash retention (7 days) for local roots
    startFileManagerJanitor();

    // Drop character sheet caches for players not seen in a long time
    pruneCharacterStore().catch(() => {});

    // Read panel port from DB (saved via Settings UI), fallback to env or 3001
    const savedPort = await getSetting("panelPort");
    const PORT = resolvePanelPort(process.env.PORT || savedPort || 3001, {
      onInvalid: (value) =>
        log.warn(
          `Configured panel port "${value}" is not valid (must be a number 1-65535) -- using 3001 instead.`,
        ),
    });
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
        try {
          const journalPath = updateBundleJournalPath();
          if (
            _pendingUpdateInspection.awaitingStartupAck &&
            acknowledgeUpdateBundle(journalPath, _buildMetadata, {
              transactionId: _pendingUpdateInspection.transactionId,
              expectedMetadata: _pendingUpdateInspection.metadata,
              applyingMarkerPath: _pendingUpdateInspection.applyingMarkerPath,
            })
          ) {
            log.info("Update bundle startup acknowledged; previous artifacts removed");
            // Transaction complete -- the pre-update snapshot stays on disk
            // (it's the operator's, not ours to delete), but the pointer to
            // it as a "pending restore candidate" is cleared so a LATER,
            // unrelated incident can never find and restore a stale
            // snapshot from an update that already succeeded.
            await setSetting("preUpdateDataBackupPath", null);
            await flushWrites();

            // Only now -- after the binary/client can no longer be rolled
            // back -- swap in the staged start.sh/unit/install-script, if
            // this release staged any (see panelUpdateChecker.js's
            // stageLinuxLauncherFiles()/activateStagedLinuxLauncherFiles()
            // for why this can't happen any earlier). process.execPath is
            // resolved fresh here rather than reusing the module-scoped
            // `exeDir` at the top of this file -- that one is local to the
            // Windows-only supervisor-reexec IIFE and is not in scope by
            // this point. Best-effort: this does not undo the update that
            // just succeeded either way.
            if (process.platform !== "win32") {
              const linuxExeDir = path.dirname(process.execPath);
              try {
                const activated =
                  panelUpdateChecker.activateStagedLinuxLauncherFiles(linuxExeDir);
                if (activated) {
                  log.info("Linux launcher and reference service templates updated.");
                }
              } catch (activateErr) {
                // Never point root at the panel folder's own copy of the
                // installer here: the service account can rewrite it, and
                // can make this activation fail on purpose to get the line
                // logged (DOCKER-1, see linuxServiceReinstallGuidance()).
                log.error(
                  `Could not update Linux launcher/service templates: ${activateErr.message}. ` +
                    `The installed systemd unit is unchanged. ${linuxServiceReinstallGuidance(linuxExeDir)}`,
                );
              }
            }
          }
        } catch (error) {
          // Same reasoning as inspectPendingPanelUpdate()'s catch above:
          // this is a log-only failure path (the process exits a few lines
          // down, before any client can ever see a response), so the
          // journal path belongs in the message itself, not left for an
          // operator to rediscover.
          log.error(
            `Update startup handshake failed [${error.code || "startup_handshake_failed"}]: ${error.message}. Journal: ${updateBundleJournalPath()}`,
          );
          if (error.code === "version_mismatch") {
            // client/dist was just rolled back to the previous version by
            // acknowledgeUpdateBundle() (see below) -- this process still
            // exits a few lines down, but not until after the awaited
            // restore calls that follow, so re-hash now rather than let a
            // request that lands in that gap see a header for the version
            // that just got rolled away.
            refreshInlineScriptCspHash();
            // This process already completed its own full startup --
            // including any database migration -- before reaching this
            // handshake. acknowledgeUpdateBundle() has already rolled the
            // BINARY and CLIENT back to the previous version by the time
            // this catch runs, but it has no concept of a database at all
            // (updateBundle.js is deliberately decoupled from it) -- a
            // binary-only rollback here would leave the OLD binary running
            // against a database this NEW version may have already
            // migrated. Restore db.json from the pre-update snapshot taken
            // in POST /api/panel/restart to close that half-rollback gap.
            try {
              const backupPath = await getSetting("preUpdateDataBackupPath");
              if (restorePreUpdateDataBackup(getDataPaths(), backupPath)) {
                log.warn(
                  `Restored the pre-update database snapshot after a version-mismatch rollback: ${backupPath}`,
                );
              } else {
                log.error(
                  "Version-mismatch rollback occurred but no pre-update database snapshot was recorded to restore.",
                );
              }
            } catch (restoreErr) {
              log.error(
                `Could not restore the pre-update database snapshot: ${restoreErr.message}`,
              );
            }
          }
          process.exitCode = 76;
          setImmediate(() => process.exit(76));
          return;
        }
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

// Exported for tests only, same rationale as oidcRoutes.test.js's
// getHandler() helper: an Express Application's route table is walkable via
// its own `.stack` the same way a Router's is, so a test can find a route's
// registered handler and call it directly with hand-built req/res -- no
// real HTTP server, no supertest (deliberately not a dependency here; see
// that same test file's comment on why).
export { app, io };
