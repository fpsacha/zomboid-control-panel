/**
 * Auth Routes — /api/auth/*
 * Handles login, setup, token refresh, and auth status.
 */

import { Router } from "express";
import rateLimit from "express-rate-limit";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import os from "os";
import authService, { USER_ROLES, requireRole } from "../services/auth.js";
import { createLogger } from "../utils/logger.js";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.js";
import { getDataPaths } from "../utils/paths.js";
import { setSetting } from "../database/init.js";
import { verifySetupToken, clearSetupToken } from "../utils/setupToken.js";
import { getRefreshCookieOptions } from "../utils/refreshCookie.js";
import { requirePermission, getCapabilitiesForRole } from "../services/permissions.js";
import { ErrorCode } from "../utils/errorCodes.js";

const log = createLogger("Auth");
const router = Router();

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

const RESET_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_MAX_BYTES = 1024;
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

export function isLocalPanelRequest(req) {
  if (isPanelBehindTrustProxy(req)) {
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

function getResetTokenState() {
  const tokenPath = getResetTokenPath();
  if (!fs.existsSync(tokenPath)) {
    return { tokenPath, available: false, reason: "missing", token: null };
  }

  const stat = fs.statSync(tokenPath);
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

  const token = fs.readFileSync(tokenPath, "utf-8").trim();
  if (!token || token.length < 8) {
    return {
      tokenPath,
      available: false,
      reason: "too-short",
      token: null,
      stat,
    };
  }

  return { tokenPath, available: true, reason: "ok", token, stat, ageMs };
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
    );

    // Set refresh token as httpOnly cookie
    if (result.refreshToken) {
      res.cookie(
        "refreshToken",
        result.refreshToken,
        getRefreshCookieOptions(req),
      );
    }

    log.info(`Setup complete — admin account created: ${username}`);
    res.status(201).json({
      success: true,
      user: result.user,
      accessToken: result.accessToken,
    });
  } catch (error) {
    log.error(`Setup failed: ${error.message}`);
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

/**
 * POST /api/auth/login
 * Authenticate and return access token. Sets refresh token cookie for auto-login.
 */
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { username, password, rememberMe = false } = req.body || {};
    if (!isNonEmptyString(username) || !isNonEmptyString(password)) {
      return res.status(400).json({
        error: "Username and password are required",
        code: ErrorCode.AUTH_USERNAME_PASSWORD_REQUIRED,
      });
    }
    const result = await authService.login(
      username,
      password,
      rememberMe === true,
    );

    // Set refresh token as httpOnly cookie for auto-login
    if (result.refreshToken) {
      res.cookie(
        "refreshToken",
        result.refreshToken,
        getRefreshCookieOptions(req),
      );
    }

    res.json({
      success: true,
      user: result.user,
      accessToken: result.accessToken,
    });
  } catch (error) {
    log.warn(`Login failed: ${error.message}`);
    res.status(401).json({ error: sanitizeError(error.message) });
  }
});

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token cookie.
 * This is how auto-login works — the browser sends the httpOnly cookie automatically.
 */
router.post("/refresh", async (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
      return res
        .status(401)
        .json({ error: "No refresh token", code: "NO_REFRESH_TOKEN" });
    }

    const result = await authService.refreshAccessToken(refreshToken);
    if (!result) {
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
      res.cookie(
        "refreshToken",
        result.refreshToken,
        getRefreshCookieOptions(req),
      );
    }

    res.json({
      success: true,
      user: result.user,
      accessToken: result.accessToken,
    });
  } catch (error) {
    log.error(`Token refresh failed: ${error?.message || error}`);
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
router.post("/logout", async (req, res) => {
  await authService.logout(req.cookies?.refreshToken);
  res.clearCookie("refreshToken", getRefreshCookieOptions(req, false));
  res.json({ success: true });
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

    res.json({ success: true, message: "Password changed successfully" });
  } catch (error) {
    res.status(400).json({ error: sanitizeError(error.message) });
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
router.post("/users", requirePermission("users.manage"), async (req, res) => {
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
router.delete("/users/:id", requirePermission("users.manage"), async (req, res) => {
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
 * Check if a password reset token file exists on disk.
 * This tells the frontend whether to show the "Reset Password" option.
 */
router.get("/reset-status", async (req, res) => {
  try {
    const tokenState = getResetTokenState();
    res.json({
      resetAvailable: tokenState.available,
      localResetSupported: isLocalPanelRequest(req),
    });
  } catch (error) {
    res.json({ resetAvailable: false, localResetSupported: false });
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
 * requireRole("admin") on both routes below, added deliberately: unlike
 * every other per-account action in this file, generateRecoveryCodes()/
 * getRecoveryCodeStatus()/resetPassword() (services/auth.js) do NOT operate
 * on the calling user's own account — they always target "the" admin
 * account (`users.find(u => u.role === "admin") || users[0]`), full stop.
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
router.get("/recovery-codes", requireRole("admin"), async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user)
      return res.status(401).json({
        error: "Not authenticated",
        code: ErrorCode.NOT_AUTHENTICATED,
      });
    res.json(await authService.getRecoveryCodeStatus());
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/recovery-codes", requireRole("admin"), async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user)
      return res.status(401).json({
        error: "Not authenticated",
        code: ErrorCode.NOT_AUTHENTICATED,
      });
    const result = await authService.generateRecoveryCodes(10);
    log.info("New recovery codes generated");
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

router.get("/recovery-status", async (req, res) => {
  try {
    const status = await authService.getRecoveryCodeStatus();
    res.json({ recoveryCodesAvailable: status.remaining > 0 });
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
    });
  } catch (error) {
    log.warn(`Recovery code redemption failed: ${error.message}`);
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
      if (isPanelBehindTrustProxy(req)) {
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

    const tokenState = getResetTokenState();
    if (tokenState.available && tokenState.token) {
      return res.json(
        createLocalResetResponse(
          "A recovery token is already available at data/reset-token.txt. Paste it below to continue.",
        ),
      );
    }

    if (
      tokenState.reason === "expired" ||
      tokenState.reason === "too-large" ||
      tokenState.reason === "too-short"
    ) {
      try {
        fs.unlinkSync(tokenState.tokenPath);
      } catch (error) {
        log.warn(
          `Could not remove ${tokenState.reason} reset token file: ${error.message}`,
        );
      }
    }

    const token = crypto.randomBytes(24).toString("hex");
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
 * The token file is deleted after a successful reset.
 */
router.post("/reset-password", resetLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body;
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

    const tokenPath = getResetTokenPath();

    if (!fs.existsSync(tokenPath)) {
      log.warn("Password reset attempted but no reset-token.txt exists");
      return res.status(403).json({
        error:
          "No reset token found. Create data/reset-token.txt on the server first.",
        code: ErrorCode.RESET_TOKEN_NOT_FOUND,
      });
    }

    // Guard against oversized token files
    const stat = fs.statSync(tokenPath);
    if (stat.size > RESET_TOKEN_MAX_BYTES) {
      log.warn("Password reset token file is too large");
      return res.status(403).json({
        error: "Reset token file is invalid (too large). Max 1KB.",
        code: ErrorCode.RESET_TOKEN_TOO_LARGE,
      });
    }

    // Token files older than 24h are rejected to prevent stale reset files from being abused.
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > RESET_TOKEN_MAX_AGE_MS) {
      log.warn("Password reset attempted with expired token file (>24h old)");
      try {
        fs.unlinkSync(tokenPath);
      } catch (error) {
        log.warn(`Could not remove expired reset token file: ${error.message}`);
      }
      return res.status(403).json({
        error:
          "Reset token file is older than 24 hours. Recreate it on the server.",
        code: ErrorCode.RESET_TOKEN_EXPIRED,
      });
    }

    const storedToken = fs.readFileSync(tokenPath, "utf-8").trim();
    if (!storedToken || storedToken.length < 8) {
      log.warn("Password reset attempted with invalid token file (too short)");
      return res.status(403).json({
        error:
          "Reset token file is invalid. It must contain at least 8 characters.",
        code: ErrorCode.RESET_TOKEN_TOO_SHORT,
      });
    }

    // Hash both sides to a constant-length digest before timing-safe comparison.
    // This avoids leaking the token's length via the length-mismatch short-circuit.
    const candidateDigest = crypto
      .createHash("sha256")
      .update(token.trim(), "utf8")
      .digest();
    const storedDigest = crypto
      .createHash("sha256")
      .update(storedToken, "utf8")
      .digest();
    if (!crypto.timingSafeEqual(candidateDigest, storedDigest)) {
      log.warn("Password reset attempted with incorrect token");
      return res.status(403).json({
        error: "Invalid reset token",
        code: ErrorCode.RESET_TOKEN_INVALID,
      });
    }

    const result = await authService.resetPassword(newPassword);

    // Delete the token file after successful reset
    try {
      fs.unlinkSync(tokenPath);
    } catch (unlinkErr) {
      log.warn(`Could not delete reset-token.txt: ${unlinkErr.message}`);
    }

    log.info(`Password reset successful for user: ${result.username}`);
    res.json({
      success: true,
      message: `Password reset for ${result.username}`,
    });
  } catch (error) {
    log.error(`Password reset failed: ${error.message}`);
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

export default router;
