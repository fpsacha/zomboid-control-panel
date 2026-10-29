/**
 * Auth Routes — /api/auth/*
 * Handles login, setup, token refresh, and auth status.
 */

import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import os from "os";
import authService, { USER_ROLES, requireRole } from "../services/auth.js";
import { createLogger } from "../utils/logger.js";
import { escapeLogText } from "../utils/logText.js";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.js";
import { getDataPaths } from "../utils/paths.js";
import { setSetting } from "../database/init.js";
import { verifySetupToken, clearSetupToken } from "../utils/setupToken.js";
import { getRefreshCookieOptions } from "../utils/refreshCookie.js";
import { isExtensionOrigin } from "../utils/extensionOrigin.js";
import { requirePermission, getCapabilitiesForRole } from "../services/permissions.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { requireLoginsOn } from "../middleware/requireLoginsOn.js";
import {
  decodeResetTokenFile,
  prepareResetTokenChecks,
  resetTokenHexDigits,
  resetTokenWeakness,
} from "../utils/resetTokenStrength.js";

const log = createLogger("Auth");
const router = Router();

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

const RESET_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_MAX_BYTES = 1024;
// A reset token stands in for the admin password, so it has to be one
// nobody can guess: the local button writes 48 random hex characters, and
// a hand-made one must be at least this long. The minimum used to be 8,
// and the remote-recovery instructions said "any token", so a remote panel
// could end up guarded by "changeme".
//
// SECURITY (2026-10-05, A2): and a generator's hex output, unpredictable
// (utils/resetTokenStrength.js); for one written in groups like a UUID,
// this many hex digits. That, the per-address resetLimiter and the file's
// 24-hour lifetime are what keep guessing infeasible. It used to be a
// count instead: 5 wrong tokens from any mix of addresses deleted the file,
// so a stranger could delete each token as soon as the operator made it
// (GET /reset-status told them when one existed) and keep remote recovery
// from ever working. A wrong token now changes nothing on disk.
export const RESET_TOKEN_MIN_LENGTH = 32;
const LOOPBACK_REMOTE_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

function normalizeIpAddress(address) {
  if (typeof address !== "string") return "";
  const trimmed = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!trimmed) return "";
  const withoutZone = trimmed.split("%")[0];
  return withoutZone.startsWith("::ffff:") ? withoutZone.slice(7) : withoutZone;
}

// Docker's default bridge network pool (172.17.0.0/16 through
// 172.31.0.0/16, i.e. all of 172.16.0.0/12). When this process runs
// directly on a Docker host, os.networkInterfaces() includes the docker0 /
// custom-bridge gateway addresses as "this machine's own" addresses. Docker
// hairpin NAT can make a connection FROM any container TO a host-published
// port on this panel arrive with a source address rewritten to the bridge
// gateway IP — so trusting those addresses as "local" would let any
// container on the host bypass the local-only reset-token protection.
// Loopback is unaffected: it's added separately below and always trusted.
function isDockerBridgeAddress(address) {
  const match = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(address);
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return first === 172 && second >= 16 && second <= 31;
}

function getLocalPanelAddresses() {
  const addresses = new Set(
    [...LOOPBACK_REMOTE_ADDRESSES]
      .map((address) => normalizeIpAddress(address))
      .filter(Boolean),
  );

  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      const normalized = normalizeIpAddress(entry.address);
      if (normalized && !isDockerBridgeAddress(normalized)) {
        addresses.add(normalized);
      }
    }
  }

  return addresses;
}

function getResetTokenPath() {
  const { dataDir } = getDataPaths();
  return path.join(dataDir, "reset-token.txt");
}

// When trust proxy is configured (server/index.js, TRUST_PROXY env var), the
// TCP peer on every request is the reverse proxy itself, not the real
// client -- the panel has no way to tell a local caller from a remote one at
// the socket layer. Trusting a forwarded header instead would let a remote
// caller spoof local trust (see bugfixes.test.js's "does not trust
// proxy-derived IP fields" test, which defends against exactly that). Fail
// closed rather than guess in either direction: under a proxy, nothing is
// ever treated as local.
export function isPanelBehindTrustProxy(req) {
  return Boolean(req.app?.get?.("trust proxy"));
}

// SECURITY (2026-10-08, #17): headers a reverse proxy or tunnel adds and a
// browser talking to the panel directly never sends. Behind a proxy on the
// same machine with TRUST_PROXY unset, every visitor arrives from 127.0.0.1,
// so the socket address alone counted the whole internet as "on the panel
// host" -- undoing the 1.4.6 hiding of whether a reset-token file exists.
// Best effort: a bare nginx proxy_pass adds none of these, which is why the
// warning below points at TRUST_PROXY. A caller who adds one itself only
// makes itself non-local.
const PROXY_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
  "x-real-ip",
  "cf-connecting-ip",
];
let warnedProxyWithoutTrustProxy = false;

export function requestCameThroughProxy(req) {
  return PROXY_HEADERS.some((header) => req.headers?.[header] !== undefined);
}

export function isLocalPanelRequest(req) {
  if (isPanelBehindTrustProxy(req)) {
    return false;
  }

  if (requestCameThroughProxy(req)) {
    if (!warnedProxyWithoutTrustProxy) {
      warnedProxyWithoutTrustProxy = true;
      log.warn(
        "A request reached the panel through a reverse proxy or tunnel (it carries X-Forwarded-For or a similar header), " +
          "but TRUST_PROXY isn't set. Recovery that only works on the panel host is off for proxied requests; " +
          "set TRUST_PROXY to the proxy's address (for example TRUST_PROXY=loopback) so sign-in limits tell visitors apart.",
      );
    }
    return false;
  }

  const candidateAddresses = [
    req.socket?.remoteAddress,
    req.connection?.remoteAddress,
  ]
    .map((address) => normalizeIpAddress(address))
    .filter(Boolean);

  const localAddresses = getLocalPanelAddresses();
  return candidateAddresses.some((address) => localAddresses.has(address));
}

export function createLocalResetResponse(message) {
  return {
    success: true,
    resetAvailable: true,
    message,
  };
}

async function getResetTokenState() {
  // SECURITY (2026-10-05, A2): round 4 of the verification. The table of
  // well-known hashes resetTokenWeakness() needs (utils/resetTokenStrength.js)
  // was worked out the first time a file of 32 characters or more turned
  // up, so the first remote guess after the operator wrote one took a few
  // hundred ms instead of a few: a one-off timing signal that a token file
  // now exists. It's worked out (once, without holding up the event loop)
  // before the file is looked at, whether or not there is one.
  await prepareResetTokenChecks();
  const tokenPath = getResetTokenPath();
  // One open file for every check and the read (CodeQL js/file-system-race):
  // the size and age judged are those of the bytes read, even if the file
  // is replaced or grows in between.
  let fd;
  try {
    fd = fs.openSync(tokenPath, "r");
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { tokenPath, available: false, reason: "missing", token: null };
    }
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size > RESET_TOKEN_MAX_BYTES) {
      return {
        tokenPath,
        available: false,
        reason: "too-large",
        token: null,
        stat,
      };
    }

    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > RESET_TOKEN_MAX_AGE_MS) {
      return {
        tokenPath,
        available: false,
        reason: "expired",
        token: null,
        stat,
      };
    }

    // SECURITY (2026-10-05, A2): round 3 of the verification. Read as bytes:
    // Windows PowerShell's `>` writes UTF-16, which read as UTF-8 was refused
    // as "not hex" (see decodeResetTokenFile()).
    const bytes = Buffer.alloc(stat.size);
    const length = stat.size > 0 ? fs.readSync(fd, bytes, 0, stat.size, 0) : 0;
    const token = decodeResetTokenFile(bytes.subarray(0, length));
    if (!token || (resetTokenHexDigits(token) ?? token).length < RESET_TOKEN_MIN_LENGTH) {
      return {
        tokenPath,
        available: false,
        reason: "too-short",
        token: null,
        stat,
      };
    }

    const weakness = resetTokenWeakness(token);
    if (weakness) {
      return {
        tokenPath,
        available: false,
        reason: weakness,
        token: null,
        stat,
      };
    }

    return { tokenPath, available: true, reason: "ok", token, stat, ageMs };
  } finally {
    fs.closeSync(fd);
  }
}
const RESET_TOKEN_TOO_WEAK_MESSAGE =
  "The token in data/reset-token.txt could be guessed. Replace it with random hex from a generator (0-9 and a-f, as openssl rand -hex 24 writes it); words, sentences, number sequences and repeated or sequential characters are refused. Or use the recovery button on the panel host.";

// What POST /reset-password tells a caller on the panel host when the token
// file can't be used. A caller anywhere else only ever gets
// RESET_TOKEN_INVALID (see that route).
const RESET_TOKEN_UNUSABLE_RESPONSES = {
  missing: {
    log: "no reset-token.txt exists",
    code: ErrorCode.RESET_TOKEN_NOT_FOUND,
    error: "No reset token found. Create data/reset-token.txt on the server first.",
  },
  "too-large": {
    log: "reset-token.txt is too large",
    code: ErrorCode.RESET_TOKEN_TOO_LARGE,
    error: "Reset token file is invalid (too large). Max 1KB.",
  },
  expired: {
    log: "reset-token.txt is older than 24 hours",
    code: ErrorCode.RESET_TOKEN_EXPIRED,
    error: "Reset token file is older than 24 hours. Recreate it on the server.",
  },
  "too-short": {
    log: `reset-token.txt holds fewer than ${RESET_TOKEN_MIN_LENGTH} characters`,
    code: ErrorCode.RESET_TOKEN_TOO_SHORT,
    error: `Reset token file is invalid. It must contain random hex of at least ${RESET_TOKEN_MIN_LENGTH} characters.`,
  },
  "not-hex": {
    log: "reset-token.txt isn't hex (only 0-9 and a-f, as a generator writes it): words, sentences and other characters are refused",
    code: ErrorCode.RESET_TOKEN_TOO_WEAK,
    error: RESET_TOKEN_TOO_WEAK_MESSAGE,
  },
  "too-weak": {
    log: "reset-token.txt is too predictable (all digits, too few digits, hex words, repeated, sequential or keyboard-pattern characters, a repeated stretch, or too few different characters)",
    code: ErrorCode.RESET_TOKEN_TOO_WEAK,
    error: RESET_TOKEN_TOO_WEAK_MESSAGE,
  },
  // SECURITY (2026-10-05, A2): round 3 of the verification; see
  // resetTokenReadsAsText() and isWellKnownResetToken().
  "hex-text": {
    log: "reset-token.txt is text written as hex (xxd -p, .hex(), ToHexString or a text-to-hex converter), which anyone who guesses the text can write too",
    code: ErrorCode.RESET_TOKEN_TOO_WEAK,
    error: RESET_TOKEN_TOO_WEAK_MESSAGE,
  },
  "well-known": {
    log: "reset-token.txt is a well-known value (a hash of bash's $RANDOM, of nothing or of a common word, or a UUID printed as an example)",
    code: ErrorCode.RESET_TOKEN_TOO_WEAK,
    error: RESET_TOKEN_TOO_WEAK_MESSAGE,
  },
};

// A wrong token, from anyone; and every refusal to a caller elsewhere.
const RESET_TOKEN_NOT_ACCEPTED = {
  error:
    "That reset token wasn't accepted. Check that data/reset-token.txt on the panel host holds exactly this token, is less than 24 hours old, and is random hex of at least 32 characters from a generator (words, sentences and number sequences are refused). The panel's log says which check failed.",
  code: ErrorCode.RESET_TOKEN_INVALID,
};

// Which client a sign-in attempt came from, for authService.login()'s
// per-(account, client) failure count: the address, with an IPv6 address
// reduced to its /56 the same way express-rate-limit keys loginLimiter, so
// one IPv6 network can't hand out a fresh count per address.
function loginClientKey(req) {
  const ip = typeof req.ip === "string" && req.ip ? req.ip : req.socket?.remoteAddress;
  if (typeof ip !== "string" || !ip) return "unknown";
  try {
    return ipKeyGenerator(ip);
  } catch {
    return ip;
  }
}

// SECURITY (2026-10-05, A1): a device token for the browser that just
// changed the password or rotated the JWT secret (see
// authService.issueDeviceTokenForUserId()). Only ever an extra: the change
// itself already succeeded, so failing to issue one must not turn its
// response into an error.
async function freshDeviceToken(userId) {
  try {
    return await authService.issueDeviceTokenForUserId(userId);
  } catch (error) {
    log.warn(`Could not issue a trusted-device token: ${error.message}`);
    return null;
  }
}

// The refresh cookie for a session authService just created or rotated
// (auth audit 2026-10-08): a browser-session cookie when "Keep me signed in"
// was unticked (#21), otherwise one that ends when the session does (#10).
function setRefreshCookie(req, res, result) {
  const expiresAt = Date.parse(result.refreshExpiresAt || "");
  res.cookie(
    "refreshToken",
    result.refreshToken,
    getRefreshCookieOptions(
      req,
      result.refreshPersistent !== false,
      Number.isNaN(expiresAt) ? undefined : expiresAt - Date.now(),
    ),
  );
}

async function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  return authService.authenticateAccessToken(authHeader.substring(7));
}

// Strict rate limit on login attempts — 5 per minute per IP
const loginLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many login attempts. Please try again later.",
    code: ErrorCode.RATE_LIMIT_LOGIN,
  },
  // SECURITY (2026-10-05, A1): a sign-in carrying a valid device token for
  // the account it names gets that device's own 5 a minute, like
  // authService.login() counts its failures per device. Keyed by address
  // alone, one stranger sending 5 a minute from an address everyone shares
  // (a proxy without TRUST_PROXY, Docker's bridge gateway) refused every
  // sign-in, the owner's included. Anything else, an invalid token
  // included, is keyed by address as before.
  keyGenerator: async (req) => {
    const { username, deviceToken } = req.body || {};
    try {
      const deviceId = await authService.trustedDeviceIdForUsername(username, deviceToken);
      if (deviceId) return `device:${deviceId}`;
    } catch {
      // Fall back to the address.
    }
    return loginClientKey(req);
  },
});

/**
 * GET /api/auth/status
 * Returns whether setup is needed and if auth is enabled.
 * This is always accessible (no auth required).
 */
router.get("/status", async (req, res) => {
  try {
    const needsSetup = await authService.needsSetup();
    const authEnabled = await authService.isAuthEnabled();
    res.json({ needsSetup, authEnabled });
  } catch (error) {
    log.error(`Failed to get auth status: ${error.message}`);
    res.status(500).json({
      error: "Failed to get auth status",
      code: ErrorCode.AUTH_STATUS_CHECK_FAILED,
    });
  }
});

// Setup rate limit — prevent brute-force account creation on fresh VPS installs
const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many setup attempts. Please try again later.",
    code: ErrorCode.RATE_LIMIT_SETUP,
  },
});

/**
 * POST /api/auth/setup
 * First-run account creation. Only works if no users exist.
 */
router.post("/setup", setupLimiter, async (req, res) => {
  try {
    const needsSetup = await authService.needsSetup();
    if (!needsSetup) {
      return res.status(400).json({
        error: "Setup already completed. Use login instead.",
        code: ErrorCode.SETUP_ALREADY_COMPLETED,
      });
    }

    // "Zero users exist" is the dangerous state on a publicly reachable
    // panel, not this route specifically — see server/utils/setupToken.js.
    // Checked before touching anything else so a wrong/missing token never
    // gets as far as writing panelPort or creating an account.
    const { setupToken } = req.body || {};
    if (!(await verifySetupToken(setupToken))) {
      return res.status(403).json({
        error: "Invalid or missing setup token",
        code: "SETUP_TOKEN_REQUIRED",
      });
    }

    const { username, password, rememberMe = false, panelPort = 3001 } = req.body || {};
    if (!isNonEmptyString(username) || !isNonEmptyString(password)) {
      return res.status(400).json({
        error: "Username and password are required",
        code: ErrorCode.AUTH_USERNAME_PASSWORD_REQUIRED,
      });
    }
    const normalizedPanelPort = Number(panelPort);
    if (!Number.isInteger(normalizedPanelPort) || normalizedPanelPort < 1024 || normalizedPanelPort > 65535) {
      return res.status(400).json({
        error: "Panel port must be a whole number between 1024 and 65535",
        code: ErrorCode.SETUP_PANEL_PORT_INVALID,
      });
    }
    await setSetting("panelPort", normalizedPanelPort);
    await authService.createUser(username, password);
    await clearSetupToken();

    // Auto-login after setup — generate tokens
    const result = await authService.login(
      username,
      password,
      rememberMe === true,
      { clientKey: loginClientKey(req) },
    );

    // Set refresh token as httpOnly cookie
    if (result.refreshToken) {
      setRefreshCookie(req, res, result);
    }

    log.info(`Setup complete — admin account created: ${username}`);
    res.status(201).json({
      success: true,
      user: result.user,
      accessToken: result.accessToken,
      deviceToken: result.deviceToken,
    });
  } catch (error) {
    log.error(`Setup failed: ${escapeLogText(error.message)}`);
    const body = { error: sanitizeError(error.message) };
    if (error.code) body.code = error.code;
    res.status(400).json(body);
  }
});

/**
 * POST /api/auth/login
 * Authenticate and return access token. Sets refresh token cookie for auto-login.
 */
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { username, password, rememberMe = false, deviceToken, wantsPanelKey } = req.body || {};
    if (!isNonEmptyString(username) || !isNonEmptyString(password)) {
      return res.status(400).json({
        error: "Username and password are required",
        code: ErrorCode.AUTH_USERNAME_PASSWORD_REQUIRED,
      });
    }
    // deviceToken: what this browser got back from its last successful
    // sign-in on this account (see authService.login()).
    // The browser extension keeps only the access token. A refresh cookie
    // set for its sign-in would land in the browser's shared jar and replace
    // the panel tab's own (a remembered session cut to 12 hours, or the tab
    // switched to the extension's account), so it gets no session at all.
    const result = await authService.login(
      username,
      password,
      rememberMe === true,
      {
        clientKey: loginClientKey(req),
        deviceToken,
        refreshSession: !isExtensionOrigin(req.headers.origin),
      },
    );

    // Set refresh token as httpOnly cookie for auto-login
    if (result.refreshToken) {
      setRefreshCookie(req, res, result);
    }

    res.json({
      success: true,
      user: result.user,
      accessToken: result.accessToken,
      deviceToken: result.deviceToken,
      // The Steam Sync extension's proof key for this account (see
      // POST /extension-proof below).
      ...(wantsPanelKey === true ? { panelKey: authService.extensionPanelKey(result.user?.id) } : {}),
    });
  } catch (error) {
    // Escaped like every log line that can quote what an anonymous caller
    // sent (utils/logText.js, SECURITY 2026-10-05, H2).
    log.warn(`Login failed: ${escapeLogText(error.message)}`);
    res.status(401).json({ error: sanitizeError(error.message) });
  }
});

/**
 * POST /api/auth/extension-proof
 * SECURITY (2026-10-28, audit R2-31): before the Steam Sync extension sends
 * the Steam cookies or a password to a plain-http:// panel address again,
 * the address proves it is the panel that signed the extension in:
 * HMAC(the account's panel key, challenge), which nothing else answering
 * at that address can compute. No sign-in: it gives out nothing but that
 * answer, for a challenge the caller picked.
 */
const extensionProofLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many login attempts. Please try again later.",
    code: ErrorCode.RATE_LIMIT_LOGIN,
  },
  keyGenerator: (req) => loginClientKey(req),
});

const EXTENSION_PROOF_CHALLENGE_RE = /^[A-Za-z0-9_-]{22,128}$/;

router.post("/extension-proof", extensionProofLimiter, async (req, res) => {
  try {
    const { username, challenge } = req.body || {};
    if (
      !isNonEmptyString(username) ||
      username.length > 128 ||
      typeof challenge !== "string" ||
      !EXTENSION_PROOF_CHALLENGE_RE.test(challenge)
    ) {
      return res.status(400).json({ error: "A username and a challenge are required" });
    }
    const proof = await authService.extensionPanelProof(username, challenge);
    if (!proof) {
      return res.status(503).json({ error: "The panel is still starting" });
    }
    res.json({ proof });
  } catch (error) {
    log.error(`Extension proof failed: ${escapeLogText(error.message)}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// SECURITY (2026-10-08, auth audit #4): a page on another port of the
// panel's host is same-site, so SameSite=Strict still sends it the refresh
// cookie. Browsers label its requests Sec-Fetch-Site: same-site (cross-site
// for anything further); only the panel's own page (same-origin) or a typed
// URL (none) may spend the cookie. A client that sends no such header is not
// a browser page and has no cookie to steal.
function refuseCrossSiteCookieUse(req, res, next) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") {
    return res.status(403).json({ error: "Cross-origin request refused" });
  }
  return next();
}

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token cookie.
 * This is how auto-login works — the browser sends the httpOnly cookie automatically.
 */
router.post("/refresh", refuseCrossSiteCookieUse, async (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
      return res
        .status(401)
        .json({ error: "No refresh token", code: "NO_REFRESH_TOKEN" });
    }

    const result = await authService.refreshAccessToken(refreshToken);
    // sweep-round4: services/auth.js's refreshAccessToken() now distinguishes
    // a session dropped only to enforce MAX_REFRESH_SESSIONS (a product
    // fact, `{ refreshFailureReason: "capacity" }`, no accessToken) from
    // every other reason a session can be missing (a security fact, plain
    // `null`) -- see createRefreshSession()'s tombstone comment. Wiring the
    // capacity case into its OWN distinct HTTP response needs a new wire
    // code, which is a nine-file change (errorCodes.js + one entry per
    // locale); parked pending a go/no-go per god's "no new ErrorCode
    // without telling me first" ruling, rather than landing it as an
    // unregistered literal that errorCodeRegistry.test.js would rightly
    // flag. Until that lands this still has to be treated as a failure
    // here -- `!result.accessToken` catches BOTH shapes, so a
    // capacity-evicted refresh gets today's generic 401 rather than a
    // broken 200 with an undefined accessToken.
    //
    // SECURITY (2026-10-08, #19): another request (another tab) refreshed
    // with this same cookie a moment ago and won. The browser's cookie jar
    // already holds the winner's token, so the cookie is left alone -- a
    // late clear could wipe it and sign every tab out -- and the client
    // retries once.
    if (result?.refreshFailureReason === "race") {
      return res.status(401).json({
        error: "This session was just refreshed by another tab. Try again.",
        code: ErrorCode.REFRESH_RACE,
      });
    }
    if (!result || !result.accessToken) {
      // Clear invalid cookie
      res.clearCookie("refreshToken", getRefreshCookieOptions(req, false));
      return res
        .status(401)
        .json({
          error: "Invalid refresh token",
          code: "INVALID_REFRESH_TOKEN",
        });
    }

    // Rotate the refresh token — set updated cookie
    if (result.refreshToken) {
      setRefreshCookie(req, res, result);
    }

    res.json({
      success: true,
      user: result.user,
      accessToken: result.accessToken,
      deviceToken: result.deviceToken,
    });
  } catch (error) {
    log.error(`Token refresh failed: ${escapeLogText(error?.message || error)}`);
    // Always clear stale cookie on any failure
    try {
      res.clearCookie("refreshToken", getRefreshCookieOptions(req, false));
    } catch {
      // Headers may already be sent; the 401 below is what matters.
    }
    res.status(401).json({
      error: "Token refresh failed",
      code: ErrorCode.TOKEN_REFRESH_FAILED,
    });
  }
});

/**
 * POST /api/auth/logout
 * Clear refresh token cookie.
 */
router.post("/logout", refuseCrossSiteCookieUse, async (req, res) => {
  await authService.logout(req.cookies?.refreshToken);
  res.clearCookie("refreshToken", getRefreshCookieOptions(req, false));
  res.json({ success: true });
});

/**
 * POST /api/auth/sessions/revoke-all
 * Sign the caller's own account out everywhere: every kept-signed-in
 * browser, this one included, and every live connection (auth audit
 * 2026-10-08, #10). Before this, the only ways were changing the password,
 * deleting the account, or rotating the JWT secret for everyone.
 */
router.post("/sessions/revoke-all", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(401).json({
        error: "Not authenticated",
        code: ErrorCode.NOT_AUTHENTICATED,
      });
    }
    await authService.revokeAllSessions(user.userId);
    res.clearCookie("refreshToken", getRefreshCookieOptions(req, false));
    res.json({ success: true });
  } catch (error) {
    log.warn(`Sign-out everywhere failed: ${error.message}`);
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

/**
 * GET /api/auth/me
 * Get current user info (requires valid access token).
 */
router.get("/me", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(401).json({
        error: "Not authenticated",
        code: ErrorCode.NOT_AUTHENTICATED,
      });
    }

    // Additive field -- UX ONLY, not an access-control boundary. See
    // getCapabilitiesForRole()'s doc comment: requirePermission() on each
    // route remains the only thing that actually enforces anything. A
    // client-side check MUST treat null (unknown role, lookup failure) as
    // "don't hide anything", never as "hide everything".
    const capabilities = await getCapabilitiesForRole(user.role);

    res.json({
      user: { id: user.userId, username: user.username, role: user.role, capabilities },
    });
  } catch (error) {
    res.status(401).json({
      error: "Authentication error",
      code: ErrorCode.AUTHENTICATION_ERROR,
    });
  }
});

/**
 * POST /api/auth/change-password
 * Change password for the authenticated user.
 */
router.post("/change-password", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(401).json({
        error: "Not authenticated",
        code: ErrorCode.NOT_AUTHENTICATED,
      });
    }

    const { currentPassword, newPassword } = req.body || {};
    if (!isNonEmptyString(currentPassword) || !isNonEmptyString(newPassword)) {
      return res.status(400).json({
        error: "Current and new password are required",
        code: ErrorCode.CHANGE_PASSWORD_FIELDS_REQUIRED,
      });
    }
    // Every other password-setting path in this file caps the maximum at
    // 128 chars (createUser in services/auth.js, POST /reset-password both
    // here and in authService.resetPassword) -- this route was the one
    // missing it. Two real consequences of an unbounded length reaching
    // bcrypt.hash(): bcrypt silently truncates at 72 BYTES, so two
    // passwords sharing the same first 72 bytes become interchangeable for
    // login with no warning; and bcrypt is deliberately slow, so this was
    // an available (if authenticated) way to spend meaningfully more server
    // CPU per request than any other password-setting path permits.
    // Reusing RESET_PASSWORD_TOO_LONG's code: its locale text is already
    // fully generic ("Password must be 128 characters or fewer"), no
    // reset-specific wording to mismatch.
    if (newPassword.length > 128) {
      return res.status(400).json({
        error: "Password must be 128 characters or fewer",
        code: ErrorCode.RESET_PASSWORD_TOO_LONG,
      });
    }
    await authService.changePassword(user.userId, currentPassword, newPassword);
    res.clearCookie("refreshToken", getRefreshCookieOptions(req, false));

    // SECURITY (2026-10-05, A1): the change retired this browser's device
    // token with all the others; it gets a fresh one (see
    // issueDeviceTokenForUserId()) so its next sign-in still counts on its
    // own.
    res.json({
      success: true,
      message: "Password changed successfully",
      username: user.username,
      deviceToken: await freshDeviceToken(user.userId),
    });
  } catch (error) {
    const body = { error: sanitizeError(error.message) };
    if (error.code) body.code = error.code;
    res.status(error.status || 400).json(body);
  }
});

/**
 * GET /api/auth/users
 * List all local accounts. Gated on users.manage — the same capability
 * PATCH /users/:id/role already requires — rather than a hardcoded
 * admin-only check. Without this, an operator could grant a custom role
 * users.manage (the matrix would show it granted, the server would store
 * it), and that role still couldn't list users or populate a role picker,
 * because this route checked a literal role name instead of the
 * capability it was gating. Usernames, roles and login history for every
 * account are exactly the kind of thing a role without users.manage must
 * not be able to enumerate.
 */
router.get("/users", requirePermission("users.manage"), async (req, res) => {
  try {
    const users = await authService.getUsers();
    res.json({ users });
  } catch (error) {
    log.error(`Failed to list users: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

/**
 * POST /api/auth/users
 * Create an additional account with an explicit role. Gated on
 * users.manage, consistent with GET /users and PATCH /users/:id/role
 * beside it — see the comment on GET /users for why this moved off
 * requireRole("admin"). Unlike /api/auth/setup, this does not auto-login
 * or set a session cookie for the caller — it creates an account for
 * someone else to log in with.
 *
 * Escalation: refuses to create a user in a role whose capabilities aren't
 * a subset of the caller's own (authService.createUser's
 * assertNoCapabilityEscalation, sweep-round2 2026-09-06) — same policy this
 * codebase already enforces for Discord's authorization tiers
 * (DISCORD_PERMISSIONS_CAPABILITY_REQUIRED), applied to the primary door
 * for the same authority instead of only the secondary one. Without it, a
 * users.manage holder could mint a brand-new admin account outright, zero
 * cooperation from an actual admin needed.
 */
router.post("/users", requirePermission("users.manage"), requireLoginsOn, async (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    if (!isNonEmptyString(username) || !isNonEmptyString(password)) {
      return res.status(400).json({
        error: "Username and password are required",
        code: ErrorCode.AUTH_USERNAME_PASSWORD_REQUIRED,
      });
    }
    if (!USER_ROLES.includes(role)) {
      return res.status(400).json({
        error: `role must be one of: ${USER_ROLES.join(", ")}`,
        code: ErrorCode.AUTH_INVALID_ROLE,
      });
    }
    const user = await authService.createUser(username, password, role, {
      actingUserId: req.user?.userId,
    });
    log.info(`User created by admin: ${username} (role: ${role})`);
    res.status(201).json({ success: true, user });
  } catch (error) {
    log.warn(`User creation failed: ${error.message}`);
    const body = { error: sanitizeError(error.message) };
    if (error.code) body.code = error.code;
    if (error.params) body.params = sanitizeErrorParams(error.params);
    res.status(error.status || 400).json(body);
  }
});

/**
 * PATCH /api/auth/users/:id/role
 * Change an existing account's role — by roleId (any role, including a
 * custom one from the matrix) or by the legacy fixed-name role string
 * (kept for whatever still sends that shape). Gated on users.manage
 * rather than the old admin-only requireRole: that capability's own
 * catalogue description is literally "change which role each one holds",
 * and today only the seeded admin role grants it, so this is a no-op
 * change for every existing install until an operator grants users.manage
 * to a custom role. Refuses to remove the last user able to manage roles
 * or users (enforced in authService.changeUserRoleById) and refuses an
 * unknown roleId outright rather than falling through to a default.
 *
 * Self-change and escalation: also refuses the caller targeting their own
 * account (USER_SELF_ROLE_CHANGE_REFUSED, same two-party-action reasoning
 * as DELETE .../:id below) and refuses assigning ANY user a role whose
 * capabilities aren't a subset of the caller's own
 * (assertNoCapabilityEscalation, sweep-round2 2026-09-06) — without these,
 * a users.manage holder could PATCH themselves, or anyone else, straight to
 * admin in one call.
 */
router.patch(
  "/users/:id/role",
  requirePermission("users.manage"),
  requireLoginsOn,
  async (req, res) => {
    try {
      const { roleId, role } = req.body || {};
      const actingUserId = req.user?.userId;
      let user;
      if (typeof roleId === "string" && roleId.trim()) {
        user = await authService.changeUserRoleById(
          req.params.id,
          roleId.trim(),
          { actingUserId },
        );
      } else {
        if (!USER_ROLES.includes(role)) {
          return res.status(400).json({
            error: `role must be one of: ${USER_ROLES.join(", ")}`,
            code: ErrorCode.AUTH_INVALID_ROLE,
          });
        }
        user = await authService.changeUserRole(req.params.id, role, { actingUserId });
      }
      log.info(`Role changed by admin: ${user.username} -> ${user.role}`);
      res.json({ success: true, user });
    } catch (error) {
      log.warn(`Role change failed: ${error.message}`);
      const body = { error: sanitizeError(error.message) };
      if (error.code) body.code = error.code;
      if (error.params) body.params = sanitizeErrorParams(error.params);
      res.status(error.status || 400).json(body);
    }
  },
);

/**
 * DELETE /api/auth/users/:id
 * Remove an account outright. Gated on users.manage, matching GET/POST
 * /users and PATCH /users/:id/role beside it. Refuses to delete the
 * caller's own account (see authService.deleteUser's own comment for why —
 * unlike a capability edit, self-deletion logs the caller out mid-action
 * with no account left to log back into) and refuses to delete the last
 * user able to manage roles or users, reusing the exact same lockout rule
 * PATCH .../role already enforces rather than a second copy of it.
 * Deletion alone handles session invalidation: authService.
 * authenticateAccessToken/refreshAccessToken both look the user up by id
 * fresh on every call, so a deleted user's existing tokens stop working on
 * their very next request, not at natural token expiry.
 */
router.delete("/users/:id", requirePermission("users.manage"), requireLoginsOn, async (req, res) => {
  try {
    const user = await authService.deleteUser(req.params.id, {
      actingUserId: req.user?.userId,
    });
    log.info(`User deleted by admin: ${user.username}`);
    res.json({ success: true, user });
  } catch (error) {
    log.warn(`User deletion failed: ${error.message}`);
    const body = { error: sanitizeError(error.message) };
    if (error.code) body.code = error.code;
    if (error.params) body.params = sanitizeErrorParams(error.params);
    res.status(error.status || 400).json(body);
  }
});

/**
 * POST /api/auth/users/:id/sessions/revoke
 * Sign another account out everywhere without deleting it or changing its
 * password (auth audit 2026-10-08, #10). Gated on users.manage like the
 * routes beside it, and refused for an account whose role holds more than
 * the caller's (ROLE_TARGET_EXCEEDS_CALLER_CAPABILITIES, #3).
 */
router.post(
  "/users/:id/sessions/revoke",
  requirePermission("users.manage"),
  requireLoginsOn,
  async (req, res) => {
    try {
      const user = await authService.revokeAllSessions(req.params.id, {
        actingUserId: req.user?.userId,
      });
      log.info(`Every session of ${user.username} signed out by ${req.user?.username || "an admin"}`);
      res.json({ success: true, user: { id: user.id, username: user.username } });
    } catch (error) {
      log.warn(`Signing a user out failed: ${error.message}`);
      const body = { error: sanitizeError(error.message) };
      if (error.code) body.code = error.code;
      if (error.params) body.params = sanitizeErrorParams(error.params);
      res.status(error.status || 400).json(body);
    }
  },
);

/**
 * DELETE /api/auth/users/:id/identities
 * Remove every SSO identity linked to an account and end its sessions
 * (SECURITY 2026-10-08, #13). Admin-only and refused while logins are off,
 * the same bar as POST /api/auth/oidc/link: linking and unlinking decide
 * who can sign in as the account.
 */
router.delete("/users/:id/identities", requireRole("admin"), async (req, res) => {
  if (req.user?.authDisabled || !req.user?.userId) {
    return res.status(403).json({
      error: "SSO unlinking requires an authenticated administrator",
    });
  }
  try {
    const result = await authService.unlinkExternalIdentities(req.params.id);
    log.info(
      `SSO identities unlinked by ${req.user.username || "admin"}: ${result.username} (${result.removed})`,
    );
    res.json({
      success: true,
      user: { id: result.id, username: result.username },
      removed: result.removed,
    });
  } catch (error) {
    log.warn(`SSO unlink failed: ${error.message}`);
    res
      .status(error.message === "User not found" ? 404 : 400)
      .json({ error: sanitizeError(error.message) });
  }
});

/**
 * POST /api/auth/regenerate-jwt-secret
 * Deliberately still requireRole("admin"), not requirePermission — the one
 * survivor of the users.manage sweep left as a CHOICE, not an oversight.
 *
 * Immediately invalidates EVERY existing session — access and refresh
 * tokens, every user, every device, including the caller's own. Exists for
 * an operator who has ever shared or offsited a backup taken before the
 * JWT secret moved out of db.json (older backups still contain the old key
 * in plaintext — see CHANGELOG). There is no automatic or scheduled
 * rotation by design; this is a deliberate, rare, explicit action.
 *
 * Why it stays admin-only rather than becoming a delegable capability:
 * every other entry in the matrix (including roles.manage/users.manage,
 * the permission model's own root) governs something with routine,
 * operational use. This has none — it exists purely as incident response
 * for one specific historical exposure — and unlike a capability edit or
 * removal, there is no RECOVERY_CAPABILITIES-style protection possible for
 * it: the harm isn't "nobody can recover a locked-out role" (which has a
 * safety net), it's "every other admin, including the seeded one, is
 * logged out right now, by someone else, with no cooldown." Delegating it
 * would hand a lesser role the power to unilaterally sever the real
 * admin's access to their own panel, which is a different risk category
 * from "this role can also run the server" or "this role can also manage
 * accounts." If a future multi-admin operator genuinely needs to delegate
 * this, it should get its own capability (something like
 * "security.rotate_secrets") rather than be folded into users.manage,
 * which is scoped to accounts and role assignment, not session/security
 * infrastructure — but that is a decision for whoever needs it, not a
 * default this sweep should make silently.
 */
router.post(
  "/regenerate-jwt-secret",
  requireRole("admin"),
  requireLoginsOn,
  async (req, res) => {
    try {
      await authService.regenerateJwtSecret();
      log.warn(
        `JWT secret regenerated by admin: ${req.user?.username || "unknown"}`,
      );
      res.clearCookie("refreshToken", getRefreshCookieOptions(req, false));
      res.json({
        success: true,
        message:
          "JWT signing key regenerated. Every session has been invalidated, including this one — you will need to log in again.",
        // SECURITY (2026-10-05, A1): signed with the new key; see
        // POST /change-password.
        username: req.user?.username,
        deviceToken: await freshDeviceToken(req.user?.userId),
      });
    } catch (error) {
      log.error(`JWT secret regeneration failed: ${error.message}`);
      res.status(400).json({ error: sanitizeError(error.message) });
    }
  },
);

// Rate limit for reset — 3 attempts per 15 minutes
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many reset attempts. Please try again later.",
    code: ErrorCode.RATE_LIMIT_RESET,
  },
});

/**
 * GET /api/auth/reset-status
 * Whether this caller can use the local recovery button, and -- for a caller
 * on the panel host only -- whether a usable reset token file exists.
 *
 * SECURITY (2026-10-05, A2): resetAvailable used to go to anyone, which told
 * a stranger the moment the operator created reset-token.txt. Everyone else
 * gets no resetAvailable at all; the login screen always lets them enter a
 * token (client/src/pages/Login.tsx).
 */
router.get("/reset-status", async (req, res) => {
  try {
    if (!isLocalPanelRequest(req)) {
      return res.json({ localResetSupported: false });
    }
    res.json({
      resetAvailable: (await getResetTokenState()).available,
      localResetSupported: true,
    });
  } catch (error) {
    res.json({ localResetSupported: false });
  }
});

const localResetTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many local recovery attempts. Please try again later.",
    code: ErrorCode.RATE_LIMIT_LOCAL_RECOVERY,
  },
});

/**
 * Recovery codes — the no-filesystem-access path.
 *
 * Generated while signed in, redeemable from the login screen. Only hashes are
 * stored, and each code works exactly once.
 *
 * SECURITY (2026-10-08, #1): each admin's codes now belong to their own
 * account and reset only that account, while it is still admin; generating
 * them asks for the current password (see generateRecoveryCodes()).
 *
 * requireRole("admin") on both routes below, added deliberately: the codes
 * reset an admin password from the login screen without the old one. They
 * used to target "the" admin account
 * (`users.find(u => u.role === "admin") || users[0]`) whoever generated them.
 * Before this, POST here only checked "is this a valid token for ANY
 * account" (getAuthenticatedUser, below) — so a moderator or technician,
 * using nothing but their own ordinary login, could call it directly,
 * receive a fresh batch of PLAINTEXT admin recovery codes in the response
 * (overwriting and invalidating whatever the real admin had saved), then
 * hit the unauthenticated POST /recover-with-code with one of those codes
 * to set the admin account's password to whatever they chose. That is a
 * complete, self-service moderator-to-admin privilege escalation in two
 * API calls, no admin cooperation needed. Same sensitivity class as
 * /regenerate-jwt-secret above — worse, actually: that one only forces a
 * re-login, this one hands out the admin account outright — so it gets the
 * same requireRole("admin"), not a delegable requirePermission capability.
 * GET is gated too: `remaining`/`configured`/`createdAt` for the admin
 * account's own recovery net is reconnaissance a non-admin has no
 * legitimate reason to see either.
 */
router.get("/recovery-codes", requireRole("admin"), requireLoginsOn, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user)
      return res.status(401).json({
        error: "Not authenticated",
        code: ErrorCode.NOT_AUTHENTICATED,
      });
    res.json(await authService.getRecoveryCodeStatus(user.userId));
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/recovery-codes", requireRole("admin"), requireLoginsOn, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user)
      return res.status(401).json({
        error: "Not authenticated",
        code: ErrorCode.NOT_AUTHENTICATED,
      });
    const { currentPassword } = req.body || {};
    if (!isNonEmptyString(currentPassword)) {
      return res.status(400).json({
        error: "Enter your current password to generate recovery codes.",
        code: ErrorCode.RECOVERY_CODES_PASSWORD_REQUIRED,
      });
    }
    const result = await authService.generateRecoveryCodes(user.userId, currentPassword);
    log.info(`New recovery codes generated for ${user.username}`);
    res.json({ success: true, ...result });
  } catch (error) {
    const body = { error: sanitizeError(error.message) };
    if (error.code) body.code = error.code;
    res.status(error.status || 400).json(body);
  }
});

// Whether any admin has an unused code: the login screen offers recovery
// with a code only then.
router.get("/recovery-status", async (req, res) => {
  try {
    res.json({ recoveryCodesAvailable: await authService.hasUsableRecoveryCodes() });
  } catch {
    res.json({ recoveryCodesAvailable: false });
  }
});

router.post("/recover-with-code", resetLimiter, async (req, res) => {
  try {
    const { code, newPassword } = req.body || {};
    if (!isNonEmptyString(code) || !isNonEmptyString(newPassword)) {
      return res.status(400).json({
        error: "A recovery code and a new password are required",
        code: ErrorCode.RECOVERY_CODE_FIELDS_REQUIRED,
      });
    }
    const result = await authService.redeemRecoveryCode(code, newPassword);
    log.info(`Password recovered via recovery code for ${result.username}`);
    res.json({
      success: true,
      message: `Password reset for ${result.username}`,
      remaining: result.remaining,
      // SECURITY (2026-10-05, A1): see authService.resetPassword().
      username: result.username,
      deviceToken: result.deviceToken,
    });
  } catch (error) {
    log.warn(`Recovery code redemption failed: ${escapeLogText(error.message)}`);
    // A new password the policy refuses (services/passwordPolicy.js) is a 400
    // with its code; anything about the code itself stays a bare 403.
    if (error.code && error.status === 400) {
      return res.status(400).json({ error: sanitizeError(error.message), code: error.code });
    }
    res.status(403).json({ error: sanitizeError(error.message) });
  }
});

/**
 * POST /api/auth/reset-token/local
 * Create or reuse a reset token when the panel is opened locally on the server host.
 *
 * Security model: this is only allowed for requests that originate from the server itself
 * (loopback or one of the machine's own assigned IP addresses). The response never
 * includes the token value; the caller must still read data/reset-token.txt on disk.
 */
router.post("/reset-token/local", localResetTokenLimiter, async (req, res) => {
  try {
    if (!isLocalPanelRequest(req)) {
      if (isPanelBehindTrustProxy(req) || requestCameThroughProxy(req)) {
        return res.status(403).json({
          error:
            "This panel is running behind a reverse proxy, so it can't verify a request came from the server itself. Create data/reset-token.txt on the host directly, or use a recovery code instead.",
          code: ErrorCode.LOCAL_RESET_BEHIND_PROXY,
        });
      }
      return res.status(403).json({
        error:
          "This recovery action is only available when the panel is opened from the server itself.",
        code: ErrorCode.LOCAL_RESET_NOT_LOCAL,
      });
    }

    const tokenState = await getResetTokenState();
    if (tokenState.available && tokenState.token) {
      return res.json(
        createLocalResetResponse(
          "A recovery token is already available at data/reset-token.txt. Paste it below to continue.",
        ),
      );
    }

    // A file that's there but unusable, for any reason getResetTokenState()
    // gives: removed first so the new one is created with mode 0600
    // (writeFileSync keeps an existing file's mode). This listed the reasons
    // one by one, and a new one would have been left out.
    if (tokenState.reason !== "missing") {
      try {
        fs.unlinkSync(tokenState.tokenPath);
      } catch (error) {
        log.warn(
          `Could not remove ${tokenState.reason} reset token file: ${error.message}`,
        );
      }
    }

    // Random bytes read as text, by chance, about once in five million
    // tokens (utils/resetTokenStrength.js); the panel's own token mustn't be
    // one its checks then refuse.
    await prepareResetTokenChecks();
    let token;
    do {
      token = crypto.randomBytes(24).toString("hex");
    } while (resetTokenWeakness(token));
    fs.writeFileSync(tokenState.tokenPath, `${token}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });

    log.info(
      "Local recovery token created from a request originating on the server",
    );
    res.json(
      createLocalResetResponse(
        "Recovery token created at data/reset-token.txt. Paste it below to continue.",
      ),
    );
  } catch (error) {
    log.error(`Local recovery token creation failed: ${error.message}`);
    res.status(500).json({
      error: "Could not create a recovery token on this server.",
      code: ErrorCode.LOCAL_RESET_TOKEN_CREATE_FAILED,
    });
  }
});

/**
 * POST /api/auth/reset-password
 * Reset the admin password using a reset token file.
 *
 * Security model: The caller must provide the exact token from data/reset-token.txt.
 * This proves they have filesystem access to the server machine.
 * The token file is deleted after a successful reset, and only then. A file
 * holding fewer than RESET_TOKEN_MIN_LENGTH characters, anything but a
 * generator's hex, a predictable token, hex that reads as text or a
 * well-known value (utils/resetTokenStrength.js), is refused outright.
 *
 * SECURITY (2026-10-05, A2): a wrong token no longer counts toward deleting
 * the file (see RESET_TOKEN_MIN_LENGTH's comment). And a caller that isn't
 * on the panel host gets the same RESET_TOKEN_INVALID whether the file is
 * missing, unusable or simply holds a different token: telling those apart
 * ("No reset token found" vs "Invalid reset token") was a second way to
 * learn whether a token file exists. The log says which; a caller on the
 * host still gets the specific reason.
 */
router.post("/reset-password", resetLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (
      !token ||
      !newPassword ||
      typeof token !== "string" ||
      typeof newPassword !== "string"
    ) {
      return res.status(400).json({
        error: "Token and new password are required",
        code: ErrorCode.RESET_PASSWORD_FIELDS_REQUIRED,
      });
    }

    if (newPassword.length > 128) {
      return res.status(400).json({
        error: "Password must be 128 characters or fewer",
        code: ErrorCode.RESET_PASSWORD_TOO_LONG,
      });
    }

    // SECURITY (2026-10-05, A2): a token file that exists but can't be read
    // (owned by another account, mode 0600) made this throw, and the catch
    // below answered with the filesystem error -- telling anyone that the
    // file exists. Elsewhere that's the same refusal as every other case;
    // the host still gets the error itself.
    let tokenState;
    try {
      tokenState = await getResetTokenState();
    } catch (error) {
      if (isLocalPanelRequest(req)) throw error;
      log.warn(`Password reset attempted but reset-token.txt can't be read: ${error.message}`);
      return res.status(403).json(RESET_TOKEN_NOT_ACCEPTED);
    }
    if (!tokenState.available) {
      const unusable = RESET_TOKEN_UNUSABLE_RESPONSES[tokenState.reason] || RESET_TOKEN_UNUSABLE_RESPONSES.missing;
      log.warn(`Password reset attempted but ${unusable.log}`);
      const refusal = isLocalPanelRequest(req) ? unusable : RESET_TOKEN_NOT_ACCEPTED;
      return res.status(403).json({ error: refusal.error, code: refusal.code });
    }

    // Hash both sides to a constant-length digest before timing-safe comparison.
    // This avoids leaking the token's length via the length-mismatch short-circuit.
    const candidateDigest = crypto
      .createHash("sha256")
      .update(token.trim(), "utf8")
      .digest();
    const storedDigest = crypto
      .createHash("sha256")
      .update(tokenState.token, "utf8")
      .digest();
    if (!crypto.timingSafeEqual(candidateDigest, storedDigest)) {
      log.warn("Password reset attempted with incorrect token");
      return res.status(403).json(RESET_TOKEN_NOT_ACCEPTED);
    }

    const result = await authService.resetPassword(newPassword);

    // Delete the token file after successful reset
    try {
      fs.unlinkSync(tokenState.tokenPath);
    } catch (unlinkErr) {
      log.warn(`Could not delete reset-token.txt: ${unlinkErr.message}`);
    }

    log.info(`Password reset successful for user: ${result.username}`);
    res.json({
      success: true,
      message: `Password reset for ${result.username}`,
      // SECURITY (2026-10-05, A1): see authService.resetPassword().
      username: result.username,
      deviceToken: result.deviceToken,
    });
  } catch (error) {
    log.error(`Password reset failed: ${escapeLogText(error.message)}`);
    const body = { error: sanitizeError(error.message) };
    if (error.code) body.code = error.code;
    res.status(400).json(body);
  }
});

export default router;
