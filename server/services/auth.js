/**
 * Authentication Service
 * Handles user registration, login, JWT tokens, and session management.
 *
 * Design:
 * - bcryptjs for password hashing (pure JS, compatible with pkg)
 * - JWT access tokens (short-lived, 15m) + refresh tokens (long-lived, 30d)
 * - Auto-login via refresh token stored in httpOnly cookie
 * - First-run setup creates the admin account
 * - JWT secret: JWT_SECRET / JWT_SECRET_FILE env override if set (an
 *   operator-pinned value, e.g. a Docker/K8s secret mount, or to share one
 *   key across multiple panel instances behind a load balancer), otherwise
 *   auto-generated once and persisted at <dataDir>/jwt.secret -- NOT in
 *   db.json. See utils/jwtSecret.js for why it moved out: db.json is
 *   copied wholesale by two backup paths (the automatic rotation ring and
 *   the opt-in "include DB" game-backup zip), so a signing key kept there
 *   would ride along in both.
 *
 * 2026-08-29 (auth/sessions hunt, hunt-wave7): two things in the Design
 * block above were stale, found in two passes, not one.
 *
 * FIRST PASS fixed only the line I was explicitly told about: access
 * tokens used to be 24h, and this comment already called that
 * "short-lived" -- it never was. An access token can't be individually
 * revoked (logout only revokes the refresh SESSION, see logout() below;
 * authenticateAccessToken() only ever checks tokenGen, which logout
 * doesn't touch), so 24h was the real size of the "logout doesn't
 * actually log you out" window. 15m is anchored to two measured, real
 * properties of this app, not a round number that felt safe: (1)
 * client/src/lib/api.ts already does transparent, deduped refresh-on-401
 * (one extra round trip, replayed once, safe even for mutations since the
 * server rejects the original request first) -- the machinery that makes
 * a short TTL free was already built and working, so shortening this
 * completes a design that was three-quarters there rather than trading UX
 * for security; (2) the client's own busiest legitimate polling interval
 * observed in this codebase is 5s (ServerConfig.tsx), with most pages in
 * the 10-30s range -- 15m is roughly two orders of magnitude above every
 * one of them, so active use essentially never re-triggers a refresh more
 * than once per TTL window, not once per poll.
 *
 * SECOND PASS, after being asked to re-check the rest of the SAME block
 * rather than trust that fixing the one named line meant it was clean:
 * the "stored in db.json" line was ALSO stale -- pointed at a location
 * this service moved away from specifically for a security reason (see
 * utils/jwtSecret.js: db.json is copied wholesale by two backup paths, so
 * a signing key kept there would ride along in both), which made it
 * actively misleading to anyone reasoning about backups/restores, not
 * merely out of date. A named fix is a searchlight -- it lights one spot
 * and leaves its neighbors dark unless you deliberately read past the
 * edge of what was pointed at.
 */

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { createLogger } from "../utils/logger.js";
import { getSetting, setSetting, getDb, commitNow } from "../database/init.js";
import { verifySetupToken, clearSetupToken } from "../utils/setupToken.js";
import {
  loadOrCreateJwtSecret,
  getJwtSecretPath,
  regenerateJwtSecretFile,
} from "../utils/jwtSecret.js";
import { readSecret } from "../utils/secrets.js";
import { getCapabilitiesForRole } from "./permissions.js";
import {
  getRoleById,
  getRoleByName,
  getRoles,
  RECOVERY_CAPABILITIES,
} from "./permissions.js";
import { ErrorCode } from "../utils/errorCodes.js";

const log = createLogger("Auth");

// The ONLY /api/auth/* paths middleware() below lets through before
// req.user is set. This used to be a blanket `startsWith("/api/auth/")`
// exemption (comment: "login, setup, status"), which correctly covered
// those but ALSO silently exempted every route added under this prefix
// afterward, including ones gated by requireRole/requirePermission —
// whose own "no req.user, let it through" branch (meant for the
// auth-disabled case) then admitted EVERY request, authenticated or not.
// Confirmed live: an unauthenticated POST /api/auth/users with
// role:"admin" created a real admin account on a fully set-up install.
// /api/auth/oidc/status, /login and /callback are the ONLY OIDC paths in
// here — genuinely pre-session by design (the login screen checks status
// before auth exists; login/callback ARE the act of becoming authenticated)
// and neither uses requireRole/requirePermission. This used to be the
// whole `/api/auth/oidc/` prefix, exempted as a block on the reasoning that
// nothing under it would ever need a gate — that stopped being true the
// moment /settings and /test-connection were added (both authenticated,
// both requirePermission("panel.settings")): a blanket prefix exemption
// would have made them permanently unusable (req.user never set, so the
// gate always sees an absence and fails closed to 401) rather than
// insecure, but it is the exact same "add a route under an exempted
// prefix and get its assumption for free, whether wanted or not" shape
// that caused the live incident above. Enumerated explicitly for the same
// reason the rest of this list is. /me, /change-password and
// /recovery-codes are deliberately NOT in this list even though they used
// to be exempt too — they already verify the Bearer token themselves via
// getAuthenticatedUser() and are safe either way, but leaving them exempt
// would keep the same blanket-prefix shape that caused this in the first
// place for the next route someone adds.
const PUBLIC_AUTH_PATHS = new Set([
  "/api/auth/status",
  "/api/auth/setup",
  "/api/auth/login",
  "/api/auth/refresh",
  "/api/auth/logout",
  "/api/auth/reset-status",
  "/api/auth/reset-token/local",
  "/api/auth/reset-password",
  "/api/auth/recovery-status",
  "/api/auth/recover-with-code",
  "/api/auth/oidc/status",
  "/api/auth/oidc/login",
  "/api/auth/oidc/callback",
]);

// The three roles the operator asked for. admin = everything, including user
// management. technician = operate the server (start/stop/restart, backups,
// mods, config) but not manage users. moderator = in-game/player authority
// (kick/ban/chat/players) but not destructive server operations. See the
// requireRole() call sites in server/routes/*.js for where each is enforced.
export const USER_ROLES = ["admin", "technician", "moderator"];

const BCRYPT_ROUNDS = 12;
// Exported so a test can assert the real value directly rather than
// decoding a generated token's exp-minus-iat to infer it -- see this
// file's own top-of-file comment for why 15m, not 24h.
export const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY = "30d";
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REFRESH_SESSIONS = 5;
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
// Fixed dummy hash used to keep the "user not found" branch of login() at the
// same cost as the "user found, wrong password" branch (bcrypt.compare is the
// expensive step, ~200-300ms at BCRYPT_ROUNDS). Without this, an attacker can
// enumerate valid usernames by measuring response time. This hash matches no
// real password — it's just a fixed bcrypt digest to compare against.
const DUMMY_BCRYPT_HASH =
  "$2a$12$CwTycUXWue0Thq9StjUM0uJ8u2H8ekjqOGWjF/9JMlSlL5C.tZgqe";

function makeRoleError(code, message, status = 400, params) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  if (params) err.params = params;
  return err;
}

// How many users OTHER than excludingUserId currently hold `capability`
// via their role (roleId if set, else the legacy name — same resolution
// order as everywhere else in this file). Deliberately per-USER, not
// per-ROLE like services/permissions.js's own countUsersWithCapability:
// reassigning one user doesn't change what anyone else's role grants them,
// so excluding a whole role (as the role-edit lockout check does) would
// undercount when that role has other members who aren't moving.
async function countOtherUsersWithCapability(capability, excludingUserId) {
  const db = await getDb();
  const users = db.data.users || [];
  const roles = await getRoles();
  const roleById = new Map(roles.map((r) => [String(r.id), r]));
  const roleByName = new Map(roles.map((r) => [r.name, r]));

  let count = 0;
  for (const u of users) {
    if (String(u.id) === String(excludingUserId)) continue;
    const role = u.roleId ? roleById.get(String(u.roleId)) : roleByName.get(u.role);
    if (role?.capabilities?.includes(capability)) count++;
  }
  return count;
}

// Refuses a per-user capability change that would leave zero OTHER users
// able to roles.manage or users.manage. Shared by changeUserRoleById
// (moving a user to a DIFFERENT role) and deleteUser (moving a user to NO
// role at all -- nextCapabilities: []) -- one rule, one place, not one
// copy per caller. Same shared RECOVERY_CAPABILITIES policy
// services/permissions.js's own role-EDIT lockout check uses; this is the
// per-user-exclusion analog of that per-role-exclusion rule (see
// countOtherUsersWithCapability's own comment for why the counting itself
// has to differ).
async function assertNoRecoveryLockout(userId, currentCapabilities, nextCapabilities) {
  for (const capability of RECOVERY_CAPABILITIES) {
    const currentlyGrants = currentCapabilities.includes(capability);
    const willStillGrant = nextCapabilities.includes(capability);
    // Nothing is being taken away for this capability — either this user's
    // current role never granted it, or the next state still does.
    if (!currentlyGrants || willStillGrant) continue;

    const others = await countOtherUsersWithCapability(capability, userId);
    if (others === 0) {
      throw makeRoleError(
        ErrorCode.ROLE_LOCKOUT_LAST_MANAGER,
        `This change would leave no user able to ${
          capability === "roles.manage" ? "manage roles" : "manage user accounts"
        }.`,
        409,
        // Same convention as services/permissions.js's own copy of this
        // check: `action` carries the stable capability key, not English
        // prose -- the client resolves it through capabilities.<key>.label
        // (client/src/locales/*/roles.json) via errorMessage.ts's
        // CAPABILITY_KEY_PARAM_NAMES.
        { action: capability },
      );
    }
  }
}

// Session-revocation event bus. Socket.IO connections authenticate once at
// handshake (index.js's io.use middleware) and are never re-validated per
// event, so the tokenGen/secret/role/deletion checks below -- all of which
// authenticateAccessToken and refreshAccessToken re-run on every HTTP
// request -- are otherwise no-ops for any socket that connected before the
// change. This lets index.js's Socket.IO layer evict live sockets when one
// of those paths fires, without auth.js importing the `io` instance
// (circular). Same shape as utils/logger.js's onLog.
const sessionRevocationCallbacks = [];

export function onSessionRevoked(callback) {
  sessionRevocationCallbacks.push(callback);
  return () => {
    const index = sessionRevocationCallbacks.indexOf(callback);
    if (index > -1) sessionRevocationCallbacks.splice(index, 1);
  };
}

function emitSessionRevoked(event) {
  sessionRevocationCallbacks.forEach((cb) => {
    try {
      cb(event);
    } catch (error) {
      log.warn(`Session-revocation callback failed: ${error.message}`);
    }
  });
}

class AuthService {
  constructor() {
    this.jwtSecret = null;
    this.initialized = false;
    // Serializes setup/createUser to prevent a race where two concurrent
    // /api/auth/setup requests both pass the needsSetup() check.
    this._writeMutex = Promise.resolve();
  }

  // Run a critical section serialized against other mutex holders.
  _withMutex(fn) {
    const run = this._writeMutex.then(fn, fn);
    this._writeMutex = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  ensureUserAuthState(user) {
    if (!Number.isInteger(user.tokenGen)) {
      user.tokenGen = 0;
    }

    if (!Array.isArray(user.refreshSessions)) {
      user.refreshSessions = [];
    }

    const now = Date.now();
    user.refreshSessions = user.refreshSessions
      .filter((session) => session && typeof session.id === "string")
      .filter((session) => {
        const expiresAt = Date.parse(session.expiresAt || "");
        return Number.isNaN(expiresAt) || expiresAt > now;
      })
      .slice(-MAX_REFRESH_SESSIONS);
  }

  createRefreshSession(user) {
    this.ensureUserAuthState(user);

    const timestamp = new Date().toISOString();
    const session = {
      id: crypto.randomUUID(),
      createdAt: timestamp,
      lastUsedAt: timestamp,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_LIFETIME_MS).toISOString(),
    };

    user.refreshSessions.push(session);
    if (user.refreshSessions.length > MAX_REFRESH_SESSIONS) {
      user.refreshSessions = user.refreshSessions.slice(-MAX_REFRESH_SESSIONS);
    }

    return session;
  }

  findRefreshSession(user, sessionId) {
    this.ensureUserAuthState(user);
    return (
      user.refreshSessions.find((session) => session.id === sessionId) || null
    );
  }

  revokeRefreshSession(user, sessionId) {
    this.ensureUserAuthState(user);
    const initialLength = user.refreshSessions.length;
    user.refreshSessions = user.refreshSessions.filter(
      (session) => session.id !== sessionId,
    );
    return user.refreshSessions.length !== initialLength;
  }

  async authenticateAccessToken(token) {
    try {
      const payload = jwt.verify(token, this.jwtSecret);
      if (payload.type === "refresh") {
        return null;
      }

      const db = await getDb();
      const users = db.data.users || [];
      const user = users.find((entry) => entry.id === payload.userId);
      if (!user) {
        return null;
      }

      this.ensureUserAuthState(user);
      const currentGen = user.tokenGen || 0;
      const tokenGen = payload.tokenGen ?? 0;
      if (tokenGen !== currentGen) {
        return null;
      }

      return {
        userId: user.id,
        username: user.username,
        role: user.role,
        tokenGen: currentGen,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Initialize the auth service — loads or generates JWT secret
   */
  async init() {
    try {
      // db.json is copied wholesale by two backup paths (see
      // utils/jwtSecret.js), so the signing key lives in its own file now.
      // legacySecret is only non-null on an install that predates this —
      // loadOrCreateJwtSecret migrates it VERBATIM (same bytes), it never
      // regenerates just because a legacy value happened to exist.
      const legacySecret = await getSetting("jwtSecret");
      const { secret, source } = await loadOrCreateJwtSecret({
        legacyValue: legacySecret || null,
      });
      this.jwtSecret = secret;
      this.initialized = true;

      if (legacySecret) {
        // Whatever we resolved to, the db.json copy is no longer read —
        // clearing it removes a redundant plaintext copy of a live secret.
        await setSetting("jwtSecret", null);
        await commitNow();
        if (source === "env") {
          log.warn(
            "Removed a leftover JWT secret from db.json — a JWT_SECRET " +
              "environment override is in effect, so the db.json copy was " +
              "already unused.",
          );
        } else {
          log.warn(
            `Moved the JWT signing key out of db.json into ${getJwtSecretPath()}. ` +
              "Existing sessions are unaffected — same key, safer location. " +
              "Backups taken before this upgrade still contain the old copy " +
              "in db.json; this change does not retroactively clean those up.",
          );
        }
      } else if (source === "generated") {
        log.info("Generated new JWT secret");
      }

      log.info("Auth service initialized");
    } catch (error) {
      log.error(`Failed to initialize auth service: ${error.message}`);
      throw error;
    }
  }

  /**
   * Admin-triggered key rotation. Unlike init()'s migration, this ALWAYS
   * changes the signing key, so it always invalidates every existing
   * access/refresh token — every user, every device. It exists for an
   * operator who has ever shared or offsited a backup taken before the
   * JWT secret moved out of db.json: migration can't undo that historical
   * exposure, only this can.
   */
  async regenerateJwtSecret() {
    if (readSecret("JWT_SECRET")) {
      throw new Error(
        "JWT secret is set via the JWT_SECRET environment variable — rotate " +
          "it there and restart the panel instead. This action only manages " +
          "the auto-generated key file.",
      );
    }
    const { secret, path: secretPath } = regenerateJwtSecretFile();
    this.jwtSecret = secret;
    log.warn(
      `JWT signing key regenerated by admin action (${secretPath}). Every ` +
        "existing access and refresh token is now invalid — every user, on " +
        "every device, must log in again.",
    );
    emitSessionRevoked({ scope: "all" });
    return { path: secretPath };
  }

  /**
   * Check if setup is needed (no users exist)
   */
  async needsSetup() {
    const db = await getDb();
    const users = db.data.users || [];
    return users.length === 0;
  }

  /**
   * Check if authentication is enabled
   */
  async isAuthEnabled() {
    const authEnabled = await getSetting("authEnabled");
    // Default to true once users exist
    if (authEnabled === undefined || authEnabled === null) {
      const needsSetup = await this.needsSetup();
      return !needsSetup; // Auth enabled only if users exist
    }
    return authEnabled !== false;
  }

  /**
   * Create a new user account.
   *
   * The FIRST user ever created (first-run setup) always becomes admin,
   * regardless of what `role` is passed — this is enforced here, not just at
   * the call site, so the operator can never be locked out of their own
   * panel by a bad request. Every subsequent user must have an explicit,
   * valid role — there is no silent default, because silently defaulting a
   * new account to "admin" would be a privilege-escalation bug and silently
   * defaulting it to a low-privilege role is a decision that belongs to the
   * caller, not this function.
   */
  async createUser(username, password, role) {
    return this._withMutex(async () => {
      if (!username || !password) {
        throw new Error("Username and password are required");
      }

      if (username.length < 3 || username.length > 32) {
        throw new Error("Username must be 3-32 characters");
      }

      if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
        throw new Error(
          "Username can only contain letters, numbers, underscores and hyphens",
        );
      }

      if (password.length < 6) {
        throw new Error("Password must be at least 6 characters");
      }

      if (password.length > 128) {
        throw new Error("Password must be 128 characters or fewer");
      }

      const db = await getDb();
      if (!db.data.users) {
        db.data.users = [];
      }

      const isFirstUser = db.data.users.length === 0;
      let resolvedRole;
      if (isFirstUser) {
        resolvedRole = "admin";
      } else {
        if (!USER_ROLES.includes(role)) {
          throw new Error(`role must be one of: ${USER_ROLES.join(", ")}`);
        }
        resolvedRole = role;
      }

      // Check for duplicate username
      const existing = db.data.users.find(
        (u) => u.username.toLowerCase() === username.toLowerCase(),
      );
      if (existing) {
        throw new Error("Username already exists");
      }

      const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const user = {
        id: crypto.randomUUID(),
        username,
        password: hashedPassword,
        role: resolvedRole,
        createdAt: new Date().toISOString(),
        lastLogin: null,
      };

      db.data.users.push(user);
      await commitNow();

      log.info(`User created: ${username} (role: ${resolvedRole})`);
      return { id: user.id, username: user.username, role: user.role };
    });
  }

  /**
   * Change an existing user's role by the legacy fixed-name string
   * (admin/technician/moderator) — the shape PATCH /users/:id/role falls
   * back to whenever the caller sends `role` instead of `roleId`.
   *
   * Used to carry its OWN lockout check here, independent of
   * changeUserRoleById()'s: "refuse if the target user is literally
   * role === 'admin' and no OTHER user is literally role === 'admin'
   * either." That was a real gap, not a redundant second copy of the same
   * rule: it only ever looked at the fixed name "admin", never at whether
   * the user's role — seeded or a custom one built through the matrix —
   * actually GRANTS roles.manage/users.manage right now. A user placed on
   * a custom role that holds those capabilities is exactly as load-bearing
   * for recovery as a literal admin, but moving THEM to "moderator" via
   * this path sailed straight through with no check at all, because
   * `user.role === "admin"` was false. That could zero out the last holder
   * of roles.manage/users.manage while this function's own guard stayed
   * silent — the same class of bug as updateRole()'s rename gap above,
   * just reached through the sibling role-CHANGE path instead of a
   * role-RENAME. Now resolves the target's real, live capabilities (same
   * as changeUserRoleById) and delegates to it entirely, so the two paths
   * share one lockout rule and can't independently drift again. Not
   * wrapped in this._withMutex itself — changeUserRoleById already
   * acquires it, and this method's own async work above that call is
   * read-only lookups, not a write that needs serializing.
   */
  async changeUserRole(userId, newRole) {
    if (!USER_ROLES.includes(newRole)) {
      throw new Error(`role must be one of: ${USER_ROLES.join(", ")}`);
    }

    const targetRole = await getRoleByName(newRole);
    if (!targetRole) {
      throw new Error(
        `Role "${newRole}" is not configured on this panel. Contact an administrator.`,
      );
    }

    return this.changeUserRoleById(userId, targetRole.id);
  }

  /**
   * Change an existing user's role by roleId — the path a custom role
   * (one the fixed USER_ROLES enum has no name for) needs, since
   * changeUserRole() above can only ever assign admin/technician/moderator.
   *
   * user.role is ALWAYS set to the resolved role's exact .name, seeded or
   * custom, no exceptions: requirePermission() (services/permissions.js)
   * still resolves a user's capabilities via getRoleByName(user.role)
   * today, not roleId (roleId is dual-written for a future switch to
   * id-based resolution — see database/init.js's schema v2 migration
   * comment, "not read by anything yet"). Leaving user.role stale for a
   * role with no legacy equivalent would silently keep authorizing this
   * user against their OLD role's capabilities forever — the exact
   * silent-old-role failure a permission system can least afford.
   *
   * Lockout: refuses any change that would leave zero OTHER users able to
   * roles.manage or users.manage. This is the per-user-reassignment analog
   * of services/permissions.js's own rule 1 for role EDITS — same shared
   * RECOVERY_CAPABILITIES policy (imported, not duplicated), a necessarily
   * different count (excluding one user, not one role) because moving a
   * single user between two EXISTING roles doesn't change what either role
   * grants to anyone else.
   */
  async changeUserRoleById(userId, roleId) {
    return this._withMutex(async () => {
      const targetRole = await getRoleById(roleId);
      if (!targetRole) {
        throw makeRoleError(
          ErrorCode.ROLE_NOT_FOUND,
          "That role does not exist.",
          404,
        );
      }

      const db = await getDb();
      const users = db.data.users || [];
      const user = users.find((u) => u.id === userId);
      if (!user) {
        throw new Error("User not found");
      }

      const currentRole = user.roleId
        ? await getRoleById(user.roleId)
        : await getRoleByName(user.role);
      const currentCapabilities = currentRole?.capabilities || [];
      const nextCapabilities = targetRole.capabilities || [];

      await assertNoRecoveryLockout(userId, currentCapabilities, nextCapabilities);

      user.role = targetRole.name;
      user.roleId = targetRole.id;
      await commitNow();

      log.info(
        `Role changed for user ${user.username}: ${user.role} (roleId: ${user.roleId})`,
      );
      emitSessionRevoked({ scope: "user", userId: user.id });
      return {
        id: user.id,
        username: user.username,
        role: user.role,
        roleId: user.roleId,
      };
    });
  }

  /**
   * Delete a user account outright.
   *
   * Self-deletion: refused, no override. Editing your OWN role's
   * capabilities (ROLE_SELF_CAPABILITY_LOSS_CONFIRM, permissions.js) still
   * leaves you signed in with reduced access, recoverable by asking someone
   * else to re-grant it. Deleting your own account is strictly worse: the
   * very next request you make fails to find your user row (see
   * authenticateAccessToken/refreshAccessToken, both do a fresh lookup by
   * id on every call), so you are logged out mid-action with no account
   * left to log back into. There is no routine reason an operator needs to
   * delete their own account while signed in as it — another admin doing
   * it instead is a deliberate two-party action, not a one-click accident.
   *
   * Lockout: reuses assertNoRecoveryLockout, the exact same rule
   * changeUserRoleById enforces — deletion is that function's
   * nextCapabilities: [] case (a user who is deleted keeps none of their
   * former role's capabilities, same as one moved to a role that grants
   * neither roles.manage nor users.manage). Refuses to delete the last
   * user able to manage roles or manage users.
   *
   * Sessions: deleting the row is the whole mechanism for HTTP — no
   * separate tokenGen bump is needed. Both authenticateAccessToken (every
   * authenticated request) and refreshAccessToken look the user up by id
   * fresh, every call, and already refuse when no row matches; there is
   * nothing left to check once the row is gone. Takes effect on the deleted
   * user's very next request, not at their access token's natural expiry.
   * Socket.IO connections authenticate once at handshake and never re-run
   * that lookup, so a live socket opened before the delete would otherwise
   * keep working forever with the deleted user's stale identity/rooms —
   * emitSessionRevoked below closes that gap by evicting it.
   */
  async deleteUser(userId, { actingUserId } = {}) {
    return this._withMutex(async () => {
      if (actingUserId && String(actingUserId) === String(userId)) {
        throw makeRoleError(
          ErrorCode.USER_SELF_DELETE_REFUSED,
          "You cannot delete your own account. Ask another administrator to do it instead.",
          400,
        );
      }

      const db = await getDb();
      const users = db.data.users || [];
      const user = users.find((u) => u.id === userId);
      if (!user) {
        throw new Error("User not found");
      }

      const currentRole = user.roleId
        ? await getRoleById(user.roleId)
        : await getRoleByName(user.role);
      const currentCapabilities = currentRole?.capabilities || [];

      await assertNoRecoveryLockout(userId, currentCapabilities, []);

      db.data.users = users.filter((u) => u.id !== userId);
      await commitNow();

      log.info(`Deleted user: ${user.username} (${user.id})`);
      emitSessionRevoked({ scope: "user", userId: user.id });
      return { id: user.id, username: user.username };
    });
  }

  /**
   * Authenticate user and return tokens
   */
  async login(username, password, rememberMe = true) {
    if (!username || !password) {
      throw new Error("Username and password are required");
    }

    const db = await getDb();
    const users = db.data.users || [];
    const user = users.find(
      (u) => u.username.toLowerCase() === username.toLowerCase(),
    );

    if (!user) {
      // Run a bcrypt compare against a fixed dummy hash so this branch costs
      // about the same as the "wrong password" branch below — otherwise an
      // attacker can enumerate valid usernames by measuring response time
      // (missing user ~1ms vs. existing user ~200-300ms for bcrypt.compare).
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      throw new Error("Invalid username or password");
    }

    // Account lockout: reject early if the account is currently locked.
    // Generic error message keeps username enumeration impossible. Also run
    // the dummy compare here so a locked account doesn't become a distinct,
    // faster timing signature from a normal wrong-password attempt.
    const lockedUntil = user.lockedUntil ? Date.parse(user.lockedUntil) : 0;
    if (lockedUntil && lockedUntil > Date.now()) {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      throw new Error("Invalid username or password");
    }

    // OIDC-only accounts (bootstrapped via bootstrapAdminFromExternalIdentity)
    // have no local password hash. Still run the dummy compare so this
    // branch costs the same as a real wrong-password attempt.
    let valid;
    if (user.password) {
      valid = await bcrypt.compare(password, user.password);
    } else {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      valid = false;
    }
    if (!valid) {
      user.failedLoginCount = (user.failedLoginCount || 0) + 1;
      if (user.failedLoginCount >= MAX_FAILED_LOGINS) {
        user.lockedUntil = new Date(
          Date.now() + LOCKOUT_DURATION_MS,
        ).toISOString();
        user.failedLoginCount = 0;
        log.warn(
          `Account locked due to repeated failed logins: ${user.username}`,
        );
      }
      try {
        await commitNow();
      } catch (error) {
        // Losing this write silently would let brute-force lockout state vanish.
        log.error(
          `Failed to persist failed-login state for ${user.username}: ${error.message}`,
        );
      }
      throw new Error("Invalid username or password");
    }

    // Successful auth — clear lockout state.
    user.failedLoginCount = 0;
    user.lockedUntil = null;

    this.ensureUserAuthState(user);

    // Update last login
    user.lastLogin = new Date().toISOString();
    const refreshSession = rememberMe ? this.createRefreshSession(user) : null;
    await commitNow();

    // Generate tokens
    const accessToken = this.generateAccessToken(user);
    const refreshToken = refreshSession
      ? this.generateRefreshToken(user, refreshSession.id)
      : null;

    log.info(`User logged in: ${username}`);
    // UX-only field -- see getCapabilitiesForRole()'s doc comment.
    const capabilities = await getCapabilitiesForRole(user.role);
    return {
      user: { id: user.id, username: user.username, role: user.role, capabilities },
      accessToken,
      refreshToken,
    };
  }

  /**
   * Generate a short-lived access token
   */
  generateAccessToken(user) {
    return jwt.sign(
      {
        userId: user.id,
        username: user.username,
        role: user.role,
        tokenGen: user.tokenGen || 0,
      },
      this.jwtSecret,
      { expiresIn: ACCESS_TOKEN_EXPIRY },
    );
  }

  /**
   * Generate a long-lived refresh token (for auto-login / remember me)
   * Includes tokenGen counter so tokens can be invalidated by incrementing the counter.
   */
  generateRefreshToken(user, sessionId) {
    return jwt.sign(
      {
        userId: user.id,
        type: "refresh",
        tokenGen: user.tokenGen || 0,
        sessionId,
      },
      this.jwtSecret,
      { expiresIn: REFRESH_TOKEN_EXPIRY },
    );
  }

  /**
   * Verify an access token and return the payload
   */
  verifyAccessToken(token) {
    try {
      const payload = jwt.verify(token, this.jwtSecret);
      // Reject refresh tokens used as access tokens (token type confusion)
      if (payload.type === "refresh") return null;
      return payload;
    } catch (error) {
      return null;
    }
  }

  /**
   * Refresh the access token using a refresh token.
   * Also rotates the refresh token (issues a new one, old one becomes invalid on next gen bump).
   */
  async refreshAccessToken(refreshToken) {
    try {
      const payload = jwt.verify(refreshToken, this.jwtSecret);
      if (payload.type !== "refresh") {
        throw new Error("Invalid token type");
      }

      const db = await getDb();
      const users = db.data.users || [];
      const user = users.find((u) => u.id === payload.userId);

      if (!user) {
        throw new Error("User not found");
      }

      this.ensureUserAuthState(user);

      // Validate tokenGen — reject tokens from before a password change or logout-all
      const currentGen = user.tokenGen || 0;
      const tokenGen = payload.tokenGen ?? 0;
      if (tokenGen !== currentGen) {
        throw new Error("Refresh token has been revoked");
      }

      if (!payload.sessionId) {
        throw new Error("Refresh token session is missing");
      }

      if (!this.findRefreshSession(user, payload.sessionId)) {
        throw new Error("Refresh token session is no longer active");
      }

      this.revokeRefreshSession(user, payload.sessionId);
      const newSession = this.createRefreshSession(user);
      await commitNow();

      const accessToken = this.generateAccessToken(user);
      const newRefreshToken = this.generateRefreshToken(user, newSession.id);
      // UX-only field -- see getCapabilitiesForRole()'s doc comment.
      const capabilities = await getCapabilitiesForRole(user.role);
      return {
        user: { id: user.id, username: user.username, role: user.role, capabilities },
        accessToken,
        refreshToken: newRefreshToken,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Change user password
   */
  async changePassword(userId, currentPassword, newPassword) {
    if (!newPassword || newPassword.length < 6) {
      throw new Error("New password must be at least 6 characters");
    }

    const db = await getDb();
    const users = db.data.users || [];
    const user = users.find((u) => u.id === userId);

    if (!user) {
      throw new Error("User not found");
    }

    if (!user.password) {
      throw new Error(
        "This account has no local password set (it signs in via an external provider). Use password reset/recovery to set one instead.",
      );
    }

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) {
      throw new Error("Current password is incorrect");
    }

    user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    // Bump tokenGen to invalidate all existing refresh tokens
    user.tokenGen = (user.tokenGen || 0) + 1;
    user.refreshSessions = [];
    await commitNow();

    log.info(`Password changed for user: ${user.username}`);
    emitSessionRevoked({ scope: "user", userId: user.id });
    return true;
  }

  /**
   * Get all users (without password hashes)
   */
  async getUsers() {
    const db = await getDb();
    const users = db.data.users || [];
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      roleId: u.roleId || null,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin,
    }));
  }

  // ============================================
  // OIDC seam — for Dwight's OIDC work. These methods do NO token
  // verification of their own; the caller must have already verified the
  // external provider's ID token / userinfo response before calling any of
  // these. They only map an already-verified external identity to a local
  // account (and issue a normal panel session, for the login path).
  // ============================================

  /**
   * Look up a local user by external identity and, if found, log them in —
   * same access/refresh token issuance as password login(). Refuse-by-
   * default: an identity with no local account already linked to it is NOT
   * auto-created. On a panel reachable from the internet, "anyone who can
   * complete an external login" and "anyone who should have panel access"
   * are not the same set.
   *
   * @param {{issuer: string, subject: string, email?: string}} identity
   * @param {boolean} rememberMe
   * @returns {Promise<{linked: true, user, accessToken, refreshToken} | {linked: false, canBootstrapAdmin: boolean}>}
   */
  async loginWithExternalIdentity({ issuer, subject } = {}, rememberMe = true) {
    if (!issuer || !subject) {
      throw new Error("issuer and subject are required");
    }

    const db = await getDb();
    const users = db.data.users || [];
    const existing = users.find(
      (u) =>
        Array.isArray(u.externalIdentities) &&
        u.externalIdentities.some(
          (ext) => ext.issuer === issuer && ext.subject === subject,
        ),
    );

    if (!existing) {
      return { linked: false, canBootstrapAdmin: users.length === 0 };
    }

    this.ensureUserAuthState(existing);
    existing.lastLogin = new Date().toISOString();
    const refreshSession = rememberMe
      ? this.createRefreshSession(existing)
      : null;
    await commitNow();

    const accessToken = this.generateAccessToken(existing);
    const refreshToken = refreshSession
      ? this.generateRefreshToken(existing, refreshSession.id)
      : null;

    log.info(`User logged in via OIDC: ${existing.username}`);
    return {
      linked: true,
      user: { id: existing.id, username: existing.username, role: existing.role },
      accessToken,
      refreshToken,
    };
  }

  /**
   * Bootstrap the FIRST local account directly from an external identity.
   * Only succeeds while zero local users exist — same trust boundary
   * createUser()/the /api/auth/setup route already rely on for the
   * password path (whoever gets there first, while the panel has zero
   * users, owns it). Refuses once any user exists; an admin must link the
   * identity to an existing account via linkExternalIdentity() instead.
   *
   * setupToken is required here for the same reason it's required by the
   * password path: "zero users exist" is the dangerous state, not any one
   * route that happens to be reachable from it. This function IS the state
   * transition out of that state, so gating it here — rather than only on
   * /api/auth/setup — means a second bootstrap door (OIDC, or whatever
   * comes next) can't be used to route around the guard.
   */
  async bootstrapAdminFromExternalIdentity({
    issuer,
    subject,
    email,
    username,
    setupToken,
  } = {}) {
    return this._withMutex(async () => {
      // Same information hierarchy as the /api/auth/setup route: check
      // WHETHER bootstrap is even still possible before checking WHETHER
      // this particular caller is allowed to do it. A stale/reused token
      // after a real admin already exists should report "already done",
      // not "bad token" — the two mean different things to whoever is
      // reading the error, and only one of them is actionable.
      const db = await getDb();
      if (!db.data.users) {
        db.data.users = [];
      }
      if (db.data.users.length > 0) {
        throw new Error(
          "Setup already completed. An admin must link this identity instead.",
        );
      }

      if (!(await verifySetupToken(setupToken))) {
        throw new Error("Invalid or missing setup token");
      }
      if (!issuer || !subject) {
        throw new Error("issuer and subject are required");
      }
      if (!username || typeof username !== "string") {
        throw new Error("username is required");
      }
      if (username.length < 3 || username.length > 32) {
        throw new Error("Username must be 3-32 characters");
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
        throw new Error(
          "Username can only contain letters, numbers, underscores and hyphens",
        );
      }

      const user = {
        id: crypto.randomUUID(),
        username,
        password: null, // OIDC-only account — no local password set
        role: "admin",
        externalIdentities: [
          {
            issuer,
            subject,
            email: email || null,
            linkedAt: new Date().toISOString(),
          },
        ],
        createdAt: new Date().toISOString(),
        lastLogin: null,
      };

      db.data.users.push(user);
      await commitNow();
      await clearSetupToken();

      log.info(`First admin account bootstrapped via OIDC: ${username}`);
      return { id: user.id, username: user.username, role: user.role };
    });
  }

  /**
   * Link an external identity to an EXISTING local account. This is the
   * data operation only — the route that calls this is responsible for
   * enforcing it's admin-only, the same way the requireRole("admin")
   * routes elsewhere in this app do.
   */
  async linkExternalIdentity(userId, { issuer, subject, email } = {}) {
    if (!issuer || !subject) {
      throw new Error("issuer and subject are required");
    }

    const db = await getDb();
    const users = db.data.users || [];
    const user = users.find((u) => u.id === userId);
    if (!user) {
      throw new Error("User not found");
    }

    const claimedElsewhere = users.some(
      (u) =>
        u.id !== userId &&
        Array.isArray(u.externalIdentities) &&
        u.externalIdentities.some(
          (ext) => ext.issuer === issuer && ext.subject === subject,
        ),
    );
    if (claimedElsewhere) {
      throw new Error(
        "This external identity is already linked to a different account",
      );
    }

    if (!Array.isArray(user.externalIdentities)) {
      user.externalIdentities = [];
    }
    const alreadyLinked = user.externalIdentities.some(
      (ext) => ext.issuer === issuer && ext.subject === subject,
    );
    if (!alreadyLinked) {
      user.externalIdentities.push({
        issuer,
        subject,
        email: email || null,
        linkedAt: new Date().toISOString(),
      });
      await commitNow();
    }

    log.info(`Linked external identity to user: ${user.username}`);
    return { id: user.id, username: user.username, role: user.role };
  }

  async logout(refreshToken) {
    if (!refreshToken) {
      return false;
    }

    try {
      const payload = jwt.verify(refreshToken, this.jwtSecret);
      if (
        !payload ||
        typeof payload !== "object" ||
        payload.type !== "refresh" ||
        !payload.sessionId ||
        !payload.userId
      ) {
        return false;
      }

      const db = await getDb();
      const users = db.data.users || [];
      const user = users.find((entry) => entry.id === payload.userId);
      if (!user) {
        return false;
      }

      this.ensureUserAuthState(user);
      const currentGen = user.tokenGen || 0;
      if ((payload.tokenGen ?? 0) !== currentGen) {
        return false;
      }

      if (!this.findRefreshSession(user, payload.sessionId)) {
        return false;
      }

      const revoked = this.revokeRefreshSession(user, payload.sessionId);
      if (revoked) {
        await commitNow();
      }

      return revoked;
    } catch (error) {
      return false;
    }
  }

  /**
   * Reset password for the first admin user (no auth required).
   * Caller must verify the reset token before calling this.
   */
  async resetPassword(newPassword) {
    if (
      !newPassword ||
      typeof newPassword !== "string" ||
      newPassword.length < 6
    ) {
      throw new Error("Password must be at least 6 characters");
    }
    if (newPassword.length > 128) {
      throw new Error("Password must be 128 characters or fewer");
    }

    const db = await getDb();
    const users = db.data.users || [];
    if (users.length === 0) {
      throw new Error("No user accounts exist. Use setup instead.");
    }

    // Reset the first admin account
    const user = users.find((u) => u.role === "admin") || users[0];
    user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    user.tokenGen = (user.tokenGen || 0) + 1;
    user.refreshSessions = [];
    await commitNow();

    log.info(`Password reset for user: ${user.username}`);
    emitSessionRevoked({ scope: "user", userId: user.id });
    return { username: user.username };
  }

  /**
   * Generate single-use recovery codes for the admin account.
   *
   * Only the hashes are stored, so a database copy cannot be turned back into
   * usable codes. The plaintext is returned once and never recoverable after.
   */
  async generateRecoveryCodes(count = 10) {
    const db = await getDb();
    const users = db.data.users || [];
    const user = users.find((u) => u.role === "admin") || users[0];
    if (!user) throw new Error("No user accounts exist. Use setup instead.");

    const codes = [];
    const hashes = [];
    for (let i = 0; i < count; i++) {
      const raw = crypto.randomBytes(15).toString("base64url").slice(0, 20).toUpperCase();
      const code = `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}`;
      codes.push(code);
      hashes.push({
        hash: crypto.createHash("sha256").update(code, "utf8").digest("hex"),
        usedAt: null,
      });
    }

    await setSetting("authRecoveryCodes", JSON.stringify(hashes));
    await setSetting("authRecoveryCodesCreatedAt", new Date().toISOString());
    log.info(`Generated ${count} recovery codes for user: ${user.username}`);
    return { codes, createdAt: new Date().toISOString() };
  }

  async getRecoveryCodeStatus() {
    const stored = await getSetting("authRecoveryCodes");
    const createdAt = await getSetting("authRecoveryCodesCreatedAt");
    let entries = [];
    try {
      entries = stored ? JSON.parse(stored) : [];
    } catch {
      entries = [];
    }
    const remaining = entries.filter((entry) => !entry.usedAt).length;
    return { configured: entries.length > 0, remaining, total: entries.length, createdAt: createdAt || null };
  }

  /**
   * Consume a recovery code and set a new password. The code is burned whether
   * or not the caller knows the old password, so each one works exactly once.
   *
   * Wrapped in _withMutex for the same reason createUser/changeUserRoleById/
   * deleteUser/bootstrapAdminFromExternalIdentity are: this is a check-then-
   * write (is this code still unused? -> mark it used) with an await
   * (resetPassword's real bcrypt.hash, ~150-300ms) between the check and the
   * write. Without serializing, two concurrent redemptions of the SAME code
   * each read their own independent JSON.parse of the stored entries, so
   * neither sees the other's not-yet-persisted usedAt mark -- both pass
   * validation and both successfully reset the password, defeating "each
   * code works exactly once" on an unauthenticated, admin-password-reset
   * endpoint. Reproduced in server/tests/recoveryCodeRedeemRace.test.js.
   */
  async redeemRecoveryCode(code, newPassword) {
    return this._withMutex(async () => {
      if (typeof code !== "string" || !code.trim()) {
        throw new Error("A recovery code is required");
      }
      const stored = await getSetting("authRecoveryCodes");
      let entries = [];
      try {
        entries = stored ? JSON.parse(stored) : [];
      } catch {
        entries = [];
      }
      if (entries.length === 0) {
        throw new Error("No recovery codes have been generated for this panel.");
      }

      const candidate = crypto
        .createHash("sha256")
        .update(code.trim().toUpperCase(), "utf8")
        .digest();
      const match = entries.find((entry) => {
        if (entry.usedAt) return false;
        const storedDigest = Buffer.from(entry.hash, "hex");
        if (storedDigest.length !== candidate.length) return false;
        return crypto.timingSafeEqual(storedDigest, candidate);
      });
      if (!match) {
        throw new Error("That recovery code is not valid or has already been used.");
      }

      const result = await this.resetPassword(newPassword);
      match.usedAt = new Date().toISOString();
      await setSetting("authRecoveryCodes", JSON.stringify(entries));
      const remaining = entries.filter((entry) => !entry.usedAt).length;
      log.info(`Recovery code redeemed for ${result.username}; ${remaining} remaining`);
      return { ...result, remaining };
    });
  }

  /**
   * Express middleware — verifies JWT and attaches user to req
   * Skips auth check if auth is disabled or setup is needed
   */
  middleware() {
    return async (req, res, next) => {
      try {
        // Only protect API routes — let static files and SPA page routes through
        if (!req.path.startsWith("/api")) {
          return next();
        }

        // Only these specific /api/auth/* paths (including the three
        // /api/auth/oidc/* ones) run before req.user is set — NOT any
        // whole prefix (see PUBLIC_AUTH_PATHS above for why).
        if (PUBLIC_AUTH_PATHS.has(req.path)) {
          return next();
        }

        // Allow health check
        if (req.path === "/api/health") {
          return next();
        }

        // Allow map tile proxy (loaded via <img> tags, can't send auth headers).
        // Both /tiles/ (B42 iso via map.projectzomboid.com) and /b41tiles/ (B41) and
        // /toptiles/ (B42 top-down for ChunkCleaner) must bypass — the proxy itself
        // only forwards to the hardcoded public domain, so there's no SSRF surface.
        if (
          req.path.startsWith("/api/map/tiles/") ||
          req.path.startsWith("/api/map/b41tiles/") ||
          req.path.startsWith("/api/map/toptiles/")
        ) {
          return next();
        }

        // Allow mod thumbnail proxy (also loaded via <img> tags). Only proxies
        // Steam Workshop preview URLs already stored in our DB — no arbitrary SSRF.
        // req.user is never set for this path — routes/mods.js carves this
        // exact path out of its router-level requirePermission("mods.manage")
        // gate to match (see the comment above that router.use() there); if
        // that carve-out is ever removed, this route 401s for everyone again
        // (9c6ce2e / v1.2.0, conv-mods-thumbnails).
        if (req.path.startsWith("/api/mods/thumbnail/")) {
          return next();
        }

        // Client-side crash reporting must work even before/during login —
        // that is precisely when a broken auth flow needs to be visible —
        // so it gets its own narrow exemption rather than inheriting one.
        // Its own rate limit and body-size cap live in server/index.js;
        // nothing here trusts its content.
        if (req.path === "/api/debug/client-errors") {
          return next();
        }

        // While no admin account exists, do NOT blanket-exempt every route
        // the way this used to. That let an unauthenticated stranger reach
        // /api/debug/system (leaking real filesystem paths) and every other
        // route during the window before first-run setup completes — fine
        // on a LAN, a real race-to-become-admin risk on the internet.
        // /api/auth/* already has its own permanent exemption above for
        // exactly what the setup wizard needs; nothing outside /api/auth/*
        // is called during first-run setup (verified against
        // client/src/pages/Setup.tsx and App.tsx's needsSetup gate), so
        // nothing else needs to be reachable here either.
        const needsSetup = await this.needsSetup();
        if (needsSetup) {
          return res
            .status(401)
            .json({ error: "First-run setup required", code: "SETUP_REQUIRED" });
        }

        // Auth explicitly disabled: grant full access, but EXPLICITLY —
        // set a real req.user rather than leaving it unset and relying on
        // every requireRole/requirePermission call site to treat "no
        // req.user" as "this must be the auth-disabled case, let it
        // through". That implicit meaning is exactly what made the
        // /api/auth/* prefix hole (see PUBLIC_AUTH_PATHS above) turn into
        // unauthenticated admin creation: something else set req.user
        // aside without meaning to grant access, and every gate downstream
        // read the absence as permission anyway. With this, "no req.user"
        // can mean only one thing everywhere in the app — not
        // authenticated, refuse — and requireRole/requirePermission below
        // are written to do exactly that unconditionally.
        const authEnabled = await this.isAuthEnabled();
        if (!authEnabled) {
          req.user = {
            userId: null,
            username: null,
            role: "admin",
            tokenGen: null,
            authDisabled: true,
          };
          return next();
        }

        // Extract token from Authorization header
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return res
            .status(401)
            .json({ error: "Authentication required", code: "AUTH_REQUIRED" });
        }

        const token = authHeader.substring(7);
        const payload = await this.authenticateAccessToken(token);

        if (!payload) {
          return res
            .status(401)
            .json({ error: "Invalid or expired token", code: "TOKEN_EXPIRED" });
        }

        // Attach user info to request
        req.user = payload;
        next();
      } catch (error) {
        log.error(`Auth middleware error: ${error.message}`);
        return res.status(500).json({ error: "Authentication error" });
      }
    };
  }
}

// Singleton instance
const authService = new AuthService();
export default authService;

/**
 * Express middleware factory — requires req.user.role to be one of the
 * given roles. Must run AFTER authService.middleware() so req.user is set.
 *
 * req.user.role is always the LIVE role from the database (see
 * authenticateAccessToken() above, which re-reads it on every request
 * rather than trusting the role embedded in the JWT at login time) — so a
 * role change via changeUserRole() takes effect on the user's very next
 * request, no re-login required.
 *
 * FAILS CLOSED: a missing req.user refuses (401), full stop — it does NOT
 * mean "auth disabled, let it through" the way it used to. That reading
 * used to be correct (middleware() genuinely never set req.user when auth
 * was off), right up until a route was added under a path middleware()
 * exempted from authentication ENTIRELY without also exempting it from
 * requireRole — at which point "no req.user" silently meant "nobody
 * checked" instead of "auth is off", and every requireRole-gated route on
 * that path admitted every request. middleware() now sets an explicit
 * req.user even when auth is disabled (see the authEnabled branch above),
 * so this function no longer needs — or trusts — an implicit meaning for
 * absence. A future exemption mistake now produces a locked door, not an
 * open one.
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res
        .status(401)
        .json({ error: "Authentication required", code: ErrorCode.AUTH_REQUIRED });
    }
    if (roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: "Insufficient permissions" });
  };
}
