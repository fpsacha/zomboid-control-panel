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
import { escapeLogText } from "../utils/logText.js";
import { getSetting, setSetting, getDb, commitNow } from "../database/init.js";
import { verifySetupToken, clearSetupToken } from "../utils/setupToken.js";
import {
  loadOrCreateJwtSecret,
  getJwtSecretPath,
  regenerateJwtSecretFile,
} from "../utils/jwtSecret.js";
import { readSecret } from "../utils/secrets.js";
import { getCapabilitiesForRole, withRoleMutex } from "./permissions.js";
import {
  delegableCapabilities,
  getRoleById,
  getRoleByName,
  getRoles,
  RECOVERY_CAPABILITIES,
} from "./permissions.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { assertNewPasswordPolicy } from "./passwordPolicy.js";

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
  "/api/auth/extension-proof",
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
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
// SECURITY (2026-10-08, #10): how long a kept-signed-in session lasts from
// sign-in, however often it is refreshed. Each rotation used to start a fresh
// 30 days, so a copied refresh cookie kept working for as long as someone
// used it at least once a month, and an account disabled at the SSO provider
// kept its panel access the same way.
export const REFRESH_SESSION_ABSOLUTE_LIFETIME_MS = REFRESH_TOKEN_LIFETIME_MS;
// #21: a sign-in with "Keep me signed in" unticked gets a browser-session
// cookie and at most this long. It used to get no refresh session at all,
// which since access tokens last 15 minutes meant a hard sign-out 15 minutes
// after sign-in however active the user was.
export const BROWSER_SESSION_ABSOLUTE_LIFETIME_MS = 12 * 60 * 60 * 1000;
// #19: how long a session id replaced by a refresh still answers
// REFRESH_RACE (another tab got there first; retry with the new cookie)
// instead of counting as the reuse of a stolen token.
export const REFRESH_RACE_GRACE_MS = 30 * 1000;
const MAX_ROTATION_RECORDS = 5;
// Per kind (#21): up to this many remembered sessions AND this many browser
// sessions, so neither kind's sign-ins push out the other's.
const MAX_REFRESH_SESSIONS = 5;
const MAX_EVICTION_TOMBSTONES = 2 * MAX_REFRESH_SESSIONS;
export const MAX_FAILED_LOGINS = 10;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
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

// The rules every password set without the old one follows (reset token,
// recovery code, --reset-password): the same as for any new password
// (services/passwordPolicy.js).
function assertResetPasswordPolicy(newPassword) {
  assertNewPasswordPolicy(newPassword);
}

// Kept across browser restarts ("Keep me signed in"); a session stored
// before #21 has no flag and was one.
function isPersistentSession(session) {
  return session.persistent !== false;
}

// What routes/auth.js needs to set the refresh cookie for `session`: a
// browser-session cookie when it isn't kept (#21), otherwise one that ends
// when the session does (#10).
function refreshCookieFields(session) {
  return {
    refreshPersistent: isPersistentSession(session),
    refreshExpiresAt: session.expiresAt,
  };
}

// One account's recovery codes ({hash, usedAt} entries), stored on its own
// row since 2026-10-08 (#1); [] when it has none.
function recoveryCodeEntries(user) {
  const codes = user?.recoveryCodes?.codes;
  return Array.isArray(codes) ? codes : [];
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

// What the acting user may hand out or take away: their role's capabilities,
// or every capability for the built-in admin role (permissions.js's
// delegableCapabilities()). Null when there is no caller context to compare
// against.
async function getActingCapabilities(actingUserId) {
  if (!actingUserId) return null; // no caller context (e.g. first-user setup bootstrap) -- nothing to compare against, nothing to guard
  const db = await getDb();
  const users = db.data.users || [];
  const actingUser = users.find((u) => String(u.id) === String(actingUserId));
  if (!actingUser) return null; // acting user's own row not found -- not this check's job to invent a refusal for that
  const actingRole = actingUser.roleId
    ? await getRoleById(actingUser.roleId)
    : await getRoleByName(actingUser.role);
  return delegableCapabilities(actingRole);
}

// Per-capability "no escalation through a second door" rule. Same policy
// this codebase already enforces for Discord's own authorization tiers
// (ErrorCode.DISCORD_PERMISSIONS_CAPABILITY_REQUIRED, routes/discord.js's
// PUT /permissions): "Setting a Discord tier is handing out an authority
// through a second, unaudited door; you cannot hand out one you do not
// hold yourself in the panel." Role ASSIGNMENT (createUser/
// changeUserRoleById below) is the PRIMARY door for that exact same
// authority -- there was never a reason the primary door should be less
// guarded than a secondary one layered on top of it. Without this, a
// users.manage holder (a capability an operator can delegate to a custom
// role via the roles.manage-gated matrix, same as any other) could create
// or reassign a user into ANY role, including one carrying capabilities --
// up to and including roles.manage/users.manage themselves, i.e. full
// admin -- the caller doesn't hold, with zero admin cooperation. Deliberately
// per-capability, not special-cased to RECOVERY_CAPABILITIES the way
// assertNoRecoveryLockout above is: this rule is about not handing out MORE
// than you have at all, not just the two "keys to the kingdom" capabilities
// -- the same subset check that keeps someone from granting roles.manage
// they don't hold also stops them granting server.control or rcon.execute
// they don't hold, matching how the Discord precedent works per-command,
// not just for its own most-sensitive tier.
//
// actingUserId, not a pre-resolved actingUser object: matches
// deleteUser(userId, { actingUserId })'s existing signature rather than
// inventing a second shape, and re-reads the acting user's role fresh from
// the DB itself rather than trusting whatever the caller passed in, same
// discipline as every other capability check in this file.
//
// SECURITY (2026-10-08, #5): the built-in admin role counts as holding every
// capability here (getActingCapabilities() above). So callers pass a target
// role through delegableCapabilities() as well: joining or leaving that role
// is worth every capability, whatever its stored row (which an admin may have
// narrowed) says, and comparing against the row let a role covering it mint
// or depose admins.
async function assertNoCapabilityEscalation(actingUserId, targetCapabilities) {
  const actingCapabilities = await getActingCapabilities(actingUserId);
  if (!actingCapabilities) return;
  const missing = (targetCapabilities || []).filter(
    (capability) => !actingCapabilities.includes(capability),
  );
  if (missing.length > 0) {
    // `params.detail` is deliberately JUST the joined capability list, not
    // a full sentence -- same shape as DISCORD_PERMISSIONS_CAPABILITY_REQUIRED's
    // own `detail` param (routes/discord.js), which is the precedent this
    // whole guard follows. Keeping the variable part isolated to `detail`
    // and the surrounding sentence in the locale template, rather than
    // baking the full sentence into `detail` itself, is what lets that
    // template exist in 10 languages instead of only English leaking
    // through untranslated. `message` (the thrown Error's own .message,
    // used server-side in logs) stays the full English sentence --
    // only `params.detail` needs to match the template's {{detail}} shape.
    const detail = missing.join(", ");
    const message = `Cannot grant a role that holds ${detail} without already holding ${
      missing.length === 1 ? "it" : "them"
    } yourself.`;
    throw makeRoleError(
      ErrorCode.ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES,
      message,
      403,
      { detail, missing },
    );
  }
}

// SECURITY (2026-10-08, #3): the ceiling on the TARGET. The check above only
// limits what a caller hands out, so a users.manage delegate could demote or
// delete every admin (and, with roles.manage, strip the admin role too) and
// end up the only account manager left. Demoting, deleting or signing out an
// account takes power away from it, so the caller must hold everything that
// account's current role holds. An admin acting on another admin passes.
async function assertCallerCoversTarget(actingUserId, targetCurrentCapabilities) {
  const actingCapabilities = await getActingCapabilities(actingUserId);
  if (!actingCapabilities) return;
  const missing = (targetCurrentCapabilities || []).filter(
    (capability) => !actingCapabilities.includes(capability),
  );
  if (missing.length === 0) return;
  const detail = missing.join(", ");
  throw makeRoleError(
    ErrorCode.ROLE_TARGET_EXCEEDS_CALLER_CAPABILITIES,
    `Cannot change, sign out or remove an account whose role holds ${detail} without holding ${
      missing.length === 1 ? "it" : "them"
    } yourself.`,
    403,
    { detail, missing },
  );
}

// Failed password sign-ins, counted per (account, client address) -- not
// per account. A per-account lock (what this used to be: 10 failures
// locked the account for 15 minutes, for everyone) let anyone who knew a
// username keep that account locked out for good, admin included, from a
// single address, and it blocked SSO sign-in too. Counting per client
// address means MAX_FAILED_LOGINS wrong passwords from one address pause
// that address's attempts on that account, while the owner signing in
// from anywhere else is not affected. The tradeoff is the usual one: many
// addresses each get MAX_FAILED_LOGINS guesses per window (on top of
// routes/auth.js's per-address loginLimiter), which a strong password
// absorbs and an account lock nobody can get out of does not.
//
// Kept in memory, not in db.json: the old lock wrote the database on
// every failed attempt, and a restart forgetting a pause harms nobody.
// Bounded by MAX_LOGIN_THROTTLE_ENTRIES, and only accounts that exist get
// an entry.
//
// An attempt is counted when it starts, before the bcrypt compare, not
// when it fails: checking a lock and then comparing for ~250ms let any
// number of concurrent guesses all pass the check before the first failure
// was written, so a burst got far more than MAX_FAILED_LOGINS tries.
//
// SECURITY (2026-10-05, A1): a browser that signed in before is counted on
// its own, not by address -- see the trusted-device notes below
// (deviceLoginThrottle). Without that, someone with about
// MAX_LOGIN_THROTTLE_ENTRIES addresses (cheap with IPv6) could fill this
// table and keep the overflow entry paused, so the owner signing in from a
// new address was refused; and where every client arrives from one address
// (a proxy or tunnel without TRUST_PROXY, Docker's bridge gateway for IPv6),
// the per-address count was account-wide anyway.
let MAX_LOGIN_THROTTLE_ENTRIES = 10000;
const loginThrottle = new Map();

function loginThrottleKey(userId, clientKey) {
  return `${userId}\u0000${clientKey || "unknown"}`;
}

// Where a new address's attempts are counted once the table is full of
// entries that still matter (see reserveLoginAttempt()). Not an address.
const OVERFLOW_CLIENT_KEY = "\u0001overflow";

function newThrottleEntry() {
  return { failures: 0, inFlight: 0, lockedUntil: 0, lastFailureAt: 0 };
}

// Nothing in flight, not paused, no failure within the window: nothing
// depends on this entry any more.
function isStaleThrottleEntry(entry, now) {
  return (
    entry.inFlight === 0 &&
    entry.lockedUntil <= now &&
    now - entry.lastFailureAt > LOCKOUT_DURATION_MS
  );
}

// Drops only stale entries. It used to drop the oldest other entries too
// when that wasn't enough, paused ones included, so an attacker with about
// MAX_LOGIN_THROTTLE_ENTRIES / (number of accounts) addresses could cycle
// them and give each address a fresh count -- roughly loginLimiter's 5
// guesses a minute per address instead of MAX_FAILED_LOGINS per window
// (security sweep 2026-10-04, adversary pass).
function pruneLoginThrottle(now) {
  if (loginThrottle.size < MAX_LOGIN_THROTTLE_ENTRIES) return;
  for (const [key, entry] of loginThrottle) {
    if (isStaleThrottleEntry(entry, now)) loginThrottle.delete(key);
  }
}

// Counts one attempt against `entry` if the client may try now.
function admitLoginAttempt(entry, now) {
  if (entry.lockedUntil > now) return false;
  if (entry.lockedUntil && entry.lockedUntil <= now) entry.lockedUntil = 0;
  if (entry.failures > 0 && now - entry.lastFailureAt > LOCKOUT_DURATION_MS) {
    entry.failures = 0;
  }
  if (entry.failures + entry.inFlight >= MAX_FAILED_LOGINS) return false;
  entry.inFlight += 1;
  return true;
}

// Counts one attempt for this (account, client) and returns { entry,
// forget }, or null when the client must not try this account right now.
// When the table is still full after pruning, a client with no entry of its
// own shares the account's overflow entry: all such addresses together get
// MAX_FAILED_LOGINS per window, and a client that already has an entry is
// not affected.
function reserveLoginAttempt(userId, clientKey, now = Date.now()) {
  let key = loginThrottleKey(userId, clientKey);
  let entry = loginThrottle.get(key);
  if (!entry) {
    pruneLoginThrottle(now);
    if (loginThrottle.size >= MAX_LOGIN_THROTTLE_ENTRIES) {
      key = loginThrottleKey(userId, OVERFLOW_CLIENT_KEY);
      entry = loginThrottle.get(key);
    }
  }
  if (!entry) {
    entry = newThrottleEntry();
    loginThrottle.set(key, entry);
  }
  if (!admitLoginAttempt(entry, now)) return null;
  return { entry, forget: () => loginThrottle.delete(key) };
}

// SECURITY (2026-10-05, A1): trusted devices (OWASP "device cookies").
// A successful sign-in hands the browser a device token (issueDeviceToken()
// below) that it sends with later attempts on the same account. An attempt
// carrying a valid one is counted here, under that device's own entry with
// its own MAX_FAILED_LOGINS window -- never under the address or overflow
// entry above -- so neither a full address table nor an address shared with
// strangers can refuse a browser that signed in before. A stolen device
// token is worth exactly one more address to an attacker: one entry, the
// same MAX_FAILED_LOGINS per window, and routes/auth.js's loginLimiter
// gives it its own per-minute budget the same way.
//
// Kept apart from loginThrottle so strangers can't crowd it out, and bounded
// per account: only holders of a valid token for an account can add entries
// to that account's map, so one account's holders (say, a moderator minting
// tokens for their own account) can't fill the room another account's
// devices need. Like the address table, a full map never forgets a pause: a
// device with no entry of its own then shares the account's device overflow
// entry.
let MAX_DEVICE_THROTTLE_ENTRIES_PER_ACCOUNT = 100;
const deviceLoginThrottle = new Map(); // userId -> Map(deviceId -> entry)
const DEVICE_OVERFLOW_ID = "\u0001overflow";

function reserveDeviceLoginAttempt(userId, deviceId, now = Date.now()) {
  let devices = deviceLoginThrottle.get(userId);
  if (!devices) {
    devices = new Map();
    deviceLoginThrottle.set(userId, devices);
  }
  let id = deviceId;
  let entry = devices.get(id);
  if (!entry && devices.size >= MAX_DEVICE_THROTTLE_ENTRIES_PER_ACCOUNT) {
    for (const [key, candidate] of devices) {
      if (isStaleThrottleEntry(candidate, now)) devices.delete(key);
    }
    if (devices.size >= MAX_DEVICE_THROTTLE_ENTRIES_PER_ACCOUNT) {
      id = DEVICE_OVERFLOW_ID;
      entry = devices.get(id);
    }
  }
  if (!entry) {
    entry = newThrottleEntry();
    devices.set(id, entry);
  }
  if (!admitLoginAttempt(entry, now)) return null;
  return {
    entry,
    forget: () => {
      devices.delete(id);
      if (devices.size === 0 && deviceLoginThrottle.get(userId) === devices) {
        deviceLoginThrottle.delete(userId);
      }
    },
  };
}

// How long a device token stays valid. Every successful sign-in, and every
// refresh of a kept-signed-in session, hands out a fresh one, so this only
// runs out for a browser nobody used for that long.
export const DEVICE_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const DEVICE_TOKEN_MAX_LENGTH = 1024;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

function newDeviceId() {
  return crypto.randomBytes(16).toString("base64url");
}

function isDeviceId(value) {
  return typeof value === "string" && DEVICE_ID_PATTERN.test(value);
}

// Records how a reserved attempt ended. Returns true when this failure
// paused the client.
function settleLoginAttempt({ entry, forget }, succeeded, now = Date.now()) {
  entry.inFlight = Math.max(0, entry.inFlight - 1);
  if (succeeded) {
    entry.failures = 0;
    entry.lockedUntil = 0;
    if (entry.inFlight === 0) forget();
    return false;
  }
  entry.failures += 1;
  entry.lastFailureAt = now;
  if (entry.failures >= MAX_FAILED_LOGINS) {
    entry.lockedUntil = now + LOCKOUT_DURATION_MS;
    entry.failures = 0;
    return true;
  }
  return false;
}

// SECURITY (2026-10-08, #8): POST /change-password compared the current
// password with no limit but the panel-wide 300 requests a minute, so anyone
// holding a session could guess it at bcrypt speed (about 3 a second, against
// MAX_FAILED_LOGINS per window at sign-in) and confirm a guess by sending it
// as the new password too. Checks of the signed-in account's own password
// (verifyCurrentPassword()) now count the same way sign-in does, in one entry
// per account: only someone signed in as that account can spend it, so it
// needs no address, and it is kept apart from loginThrottle so a table full
// of strangers' addresses can't push it into the shared overflow entry.
const currentPasswordThrottle = new Map(); // userId -> entry

function reserveCurrentPasswordAttempt(userId, now = Date.now()) {
  for (const [key, candidate] of currentPasswordThrottle) {
    if (isStaleThrottleEntry(candidate, now)) currentPasswordThrottle.delete(key);
  }
  let entry = currentPasswordThrottle.get(userId);
  if (!entry) {
    entry = newThrottleEntry();
    currentPasswordThrottle.set(userId, entry);
  }
  if (!admitLoginAttempt(entry, now)) return null;
  return {
    entry,
    forget: () => {
      if (currentPasswordThrottle.get(userId) === entry) currentPasswordThrottle.delete(userId);
    },
  };
}

// Every pause on one account, whichever address it was for: setting a new
// password through reset/recovery is the documented way back in, so it has
// to clear the pause its owner may have caused themselves by forgetting it.
function clearLoginThrottleForUser(userId) {
  const prefix = `${userId}\u0000`;
  for (const key of [...loginThrottle.keys()]) {
    if (key.startsWith(prefix)) loginThrottle.delete(key);
  }
  deviceLoginThrottle.delete(userId);
  currentPasswordThrottle.delete(userId);
}

// Account-wide lock fields from before the throttle above. Never read now;
// removed whenever the row is written for a sign-in or reset.
function clearLegacyAccountLock(user) {
  delete user.failedLoginCount;
  delete user.lockedUntil;
}

// The last four characters of a provider subject: enough to tell two linked
// identities apart, not enough to put in a forged ID token. A short subject
// is masked whole, since four characters would be most of it.
function maskExternalSubject(subject) {
  if (typeof subject !== "string" || subject.length < 12) return "••••";
  return `••••${subject.slice(-4)}`;
}

// For tests only.
export function _resetLoginThrottleForTests() {
  loginThrottle.clear();
  deviceLoginThrottle.clear();
  currentPasswordThrottle.clear();
  MAX_LOGIN_THROTTLE_ENTRIES = 10000;
  MAX_DEVICE_THROTTLE_ENTRIES_PER_ACCOUNT = 100;
}

// For tests only: a small table, so filling it doesn't take 10000 logins.
export function _setLoginThrottleCapacityForTests(capacity) {
  MAX_LOGIN_THROTTLE_ENTRIES = capacity;
}

// For tests only: the same for one account's trusted devices.
export function _setDeviceThrottleCapacityForTests(capacity) {
  MAX_DEVICE_THROTTLE_ENTRIES_PER_ACCOUNT = capacity;
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

// Exported for services/permissions.js: a role edit or delete changes what
// every member is authorized for without touching any user row here, so it
// has to fire the same per-user eviction itself.
export function emitSessionRevoked(event) {
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
    const live = user.refreshSessions
      .filter((session) => session && typeof session.id === "string")
      .filter((session) => {
        const expiresAt = Date.parse(session.expiresAt || "");
        return Number.isNaN(expiresAt) || expiresAt > now;
      });
    // The newest MAX_REFRESH_SESSIONS of each kind (#21), in stored order.
    const newestOfKind = (persistent) =>
      live.filter((session) => isPersistentSession(session) === persistent).slice(-MAX_REFRESH_SESSIONS);
    const kept = new Set([...newestOfKind(true), ...newestOfKind(false)]);
    user.refreshSessions = live.filter((session) => kept.has(session));

    // sweep-round4 (2026-09-07): tombstones for sessions dropped by
    // createRefreshSession() to stay under MAX_REFRESH_SESSIONS -- see that
    // method's own comment for why this exists and why it records only
    // "capacity", never the security reasons. Bounded and expired the same
    // way refreshSessions itself is, immediately above: a tombstone that
    // outlives the token it describes is a leak, not a record, so it is
    // capped at MAX_EVICTION_TOMBSTONES entries (one kind's worth each) and
    // pruned the instant the session it describes would itself have
    // expired -- never later.
    if (!Array.isArray(user.evictedRefreshSessions)) {
      user.evictedRefreshSessions = [];
    }
    user.evictedRefreshSessions = user.evictedRefreshSessions
      .filter((tombstone) => tombstone && typeof tombstone.id === "string")
      .filter((tombstone) => {
        const expiresAt = Date.parse(tombstone.expiresAt || "");
        return Number.isNaN(expiresAt) || expiresAt > now;
      })
      .slice(-MAX_EVICTION_TOMBSTONES);
  }

  // deviceId: SECURITY (2026-10-05, A1), the trusted-device id this session
  // hands out (issueDeviceToken()). refreshAccessToken() passes the old
  // session's on, so a session keeps one device id for its whole life. Each
  // refresh used to mint a new one, so whoever held a session cookie could
  // collect a fresh failed-sign-in budget per refresh -- up to the
  // per-account device table's size -- and fill that table with paused
  // entries.
  //
  // SECURITY (2026-10-08): the rest is carried through rotation the same way.
  // - persistent (#21): false for a sign-in with "Keep me signed in"
  //   unticked: a browser-session cookie and BROWSER_SESSION_ABSOLUTE_LIFETIME_MS.
  // - absoluteExpiresAt (#10): when the session ends however often it is
  //   refreshed, set at sign-in. expiresAt (and the refresh JWT and cookie)
  //   never run past it.
  // - familyId (#10): one id for the chain of sessions a sign-in rotates
  //   through, also carried in the refresh JWT, so a replaced token presented
  //   again is recognised as reuse (findReplacedSession()).
  // - rotatedFrom (#19): the ids this session replaced in the last
  //   REFRESH_RACE_GRACE_MS, for another tab's refresh that lost the race.
  createRefreshSession(
    user,
    { deviceId, persistent = true, absoluteExpiresAt, familyId, rotatedFrom } = {},
  ) {
    this.ensureUserAuthState(user);

    const now = Date.now();
    const keep = persistent !== false;
    const givenAbsolute = Date.parse(absoluteExpiresAt || "");
    const absolute = Number.isNaN(givenAbsolute)
      ? now + (keep ? REFRESH_SESSION_ABSOLUTE_LIFETIME_MS : BROWSER_SESSION_ABSOLUTE_LIFETIME_MS)
      : givenAbsolute;
    const timestamp = new Date(now).toISOString();
    const session = {
      id: crypto.randomUUID(),
      createdAt: timestamp,
      lastUsedAt: timestamp,
      expiresAt: new Date(Math.min(now + REFRESH_TOKEN_LIFETIME_MS, absolute)).toISOString(),
      absoluteExpiresAt: new Date(absolute).toISOString(),
      persistent: keep,
      familyId: typeof familyId === "string" && familyId ? familyId : crypto.randomUUID(),
      deviceId: isDeviceId(deviceId) ? deviceId : newDeviceId(),
    };
    if (Array.isArray(rotatedFrom) && rotatedFrom.length > 0) {
      session.rotatedFrom = rotatedFrom;
    }

    user.refreshSessions.push(session);
    // #21: each kind is capped on its own, oldest first and never the
    // session just created, so a shared PC's sign-ins (or the browser
    // extension's, which never keep one) can't push out a user's remembered
    // devices, and remembered sign-ins can't push out a browser session.
    const sameKind = user.refreshSessions.filter((s) => isPersistentSession(s) === keep);
    if (sameKind.length > MAX_REFRESH_SESSIONS) {
      // A capacity eviction is the one case where the thing doing the
      // dropping (here) is also the only thing that will ever know *why* --
      // findRefreshSession() later sees nothing but a missing id, same as it
      // would for an expired, revoked, or forged one. Record the reason at
      // this single site rather than let a caller downstream guess it: a
      // guess can be wrong, and a false "just capacity" told to a genuinely
      // compromised user is strictly worse than today's silence.
      const evicted = sameKind
        .filter((s) => s !== session)
        .slice(0, sameKind.length - MAX_REFRESH_SESSIONS);
      user.refreshSessions = user.refreshSessions.filter((s) => !evicted.includes(s));
      user.evictedRefreshSessions.push(
        ...evicted.map((evictedSession) => ({
          id: evictedSession.id,
          reason: "capacity",
          expiresAt: evictedSession.expiresAt,
        })),
      );
      if (user.evictedRefreshSessions.length > MAX_EVICTION_TOMBSTONES) {
        user.evictedRefreshSessions =
          user.evictedRefreshSessions.slice(-MAX_EVICTION_TOMBSTONES);
      }
    }

    return session;
  }

  findRefreshSession(user, sessionId) {
    this.ensureUserAuthState(user);
    return (
      user.refreshSessions.find((session) => session.id === sessionId) || null
    );
  }

  // Returns "capacity" if `sessionId` is missing from refreshSessions
  // *because* it was evicted to enforce MAX_REFRESH_SESSIONS, or null for
  // every other reason a session can be missing (expired, revoked by a
  // security action, or simply never existed / forged). Callers must treat
  // null as "say nothing more than usual" -- it is the only response that
  // does not tell a forged-token holder whether the id it guessed was ever
  // real.
  findCapacityEvictionReason(user, sessionId) {
    this.ensureUserAuthState(user);
    const tombstone = user.evictedRefreshSessions.find(
      (entry) => entry.id === sessionId,
    );
    return tombstone && tombstone.reason === "capacity" ? "capacity" : null;
  }

  revokeRefreshSession(user, sessionId) {
    this.ensureUserAuthState(user);
    const initialLength = user.refreshSessions.length;
    user.refreshSessions = user.refreshSessions.filter(
      (session) => session.id !== sessionId,
    );
    return user.refreshSessions.length !== initialLength;
  }

  // For a refresh token whose session is gone (#10, #19): "race" when a live
  // session replaced it within REFRESH_RACE_GRACE_MS -- another tab refreshed
  // first with the same cookie, and a retry sends the new one; "reuse" when
  // its sign-in's chain has moved on longer ago than that, so whoever sends
  // it holds a token its owner (or a thief) already exchanged; null for every
  // other reason (signed out, expired, evicted, forged).
  findReplacedSession(user, payload, now = Date.now()) {
    this.ensureUserAuthState(user);
    for (const session of user.refreshSessions) {
      const rotation = (session.rotatedFrom || []).find((entry) => entry.id === payload.sessionId);
      if (rotation) {
        return now - Date.parse(rotation.at) <= REFRESH_RACE_GRACE_MS ? "race" : "reuse";
      }
    }
    if (
      typeof payload.fam === "string" &&
      user.refreshSessions.some((session) => session.familyId === payload.fam)
    ) {
      return "reuse";
    }
    return null;
  }

  // Ends every session the account has: the tokenGen bump retires its access
  // and refresh tokens alike, and the sessions themselves go.
  endAllSessions(user) {
    this.ensureUserAuthState(user);
    user.tokenGen = (user.tokenGen || 0) + 1;
    user.refreshSessions = [];
  }

  async authenticateAccessToken(token) {
    try {
      const payload = jwt.verify(token, this.jwtSecret, { algorithms: ["HS256"] });
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

      // SECURITY (2026-10-08, #1): the one global recovery-code set older
      // versions kept, aimed at the first admin whoever made it. Nobody can
      // tell who holds those codes, so they are retired rather than moved to
      // an account; redeemRecoveryCode() never read them anyway.
      if (await getSetting("authRecoveryCodes")) {
        await setSetting("authRecoveryCodes", null);
        await setSetting("authRecoveryCodesCreatedAt", null);
        await commitNow();
        log.warn(
          "Recovery codes made before this version no longer work. Each admin can " +
            "generate codes for their own account in Settings > Security.",
        );
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
  async createUser(username, password, role, { actingUserId } = {}) {
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

      // services/passwordPolicy.js: length (10 characters, 72 bytes) and the
      // common-password list; coded errors the routes pass on.
      assertNewPasswordPolicy(password);

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

      // No-op on first-user bootstrap: isFirstUser forces admin
      // unconditionally above (there's no OTHER role to escalate to, and no
      // actingUserId exists yet either -- assertNoCapabilityEscalation
      // returns early on that alone regardless).
      if (!isFirstUser) {
        const targetRole = await getRoleByName(resolvedRole);
        await assertNoCapabilityEscalation(actingUserId, delegableCapabilities(targetRole));
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
      // The panel just stopped being open to everyone: a socket that
      // connected before any account existed carries no identity at all,
      // and it would otherwise stay connected and keep every broadcast
      // after setup locked the HTTP side.
      if (isFirstUser) emitSessionRevoked({ scope: "all" });
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
  async changeUserRole(userId, newRole, { actingUserId } = {}) {
    if (!USER_ROLES.includes(newRole)) {
      throw new Error(`role must be one of: ${USER_ROLES.join(", ")}`);
    }

    const targetRole = await getRoleByName(newRole);
    if (!targetRole) {
      throw new Error(
        `Role "${newRole}" is not configured on this panel. Contact an administrator.`,
      );
    }

    return this.changeUserRoleById(userId, targetRole.id, { actingUserId });
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
   *
   * Self-change: refused unconditionally, no override — independent of and
   * not redundant with the escalation check below. Same reasoning
   * deleteUser's own self-delete refusal already states for itself: there's
   * no routine reason an operator needs to change their own role while
   * signed in as it, and another admin doing it instead is a deliberate
   * two-party action, not a one-click accident. This closes a real
   * structural asymmetry (sweep-round2, 2026-09-06) — deleteUser had this
   * check and changeUserRoleById didn't — not just a gap the escalation
   * rule below happens to leave: an actual admin (who by definition already
   * holds every capability, so the escalation check never refuses them)
   * could still move themselves to a different role with zero cooperation,
   * exactly the one-click-accident shape deleteUser's own comment already
   * rejected for account deletion.
   *
   * Escalation: refuses assigning ANYONE — self or otherwise — a role whose
   * capabilities aren't a subset of the caller's own
   * (assertNoCapabilityEscalation above). This is the check that stops a
   * users.manage-only caller promoting a DIFFERENT account to admin, which
   * the self-change block above has nothing to say about.
   *
   * Ceiling: refuses moving anyone whose CURRENT role holds more than the
   * caller does (assertCallerCoversTarget above, 2026-10-08 #3).
   */
  async changeUserRoleById(userId, roleId, { actingUserId } = {}) {
    // continuous-bug-hunt, 2026-09-18: nested inside permissions.js's
    // withRoleMutex, not just this._withMutex -- see that function's own
    // comment for the cross-file race this closes. this._withMutex alone
    // only ever serialized this against OTHER auth.js user mutations
    // (another changeUserRoleById/deleteUser call); it has no way to wait
    // out a concurrent permissions.js updateRole/deleteRole that is
    // checking the exact same roles.manage/users.manage headcount this
    // function's own assertNoRecoveryLockout below reads.
    return this._withMutex(() => withRoleMutex(async () => {
      if (actingUserId && String(actingUserId) === String(userId)) {
        throw makeRoleError(
          ErrorCode.USER_SELF_ROLE_CHANGE_REFUSED,
          "You cannot change your own role. Ask another administrator to do it instead.",
          400,
        );
      }

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
      // The lockout headcount reads what the roles actually grant; the two
      // caller checks read what they are worth (delegableCapabilities()).
      await assertNoRecoveryLockout(
        userId,
        currentRole?.capabilities || [],
        targetRole.capabilities || [],
      );
      await assertNoCapabilityEscalation(actingUserId, delegableCapabilities(targetRole));
      await assertCallerCoversTarget(actingUserId, delegableCapabilities(currentRole));

      user.role = targetRole.name;
      user.roleId = targetRole.id;
      // Recovery codes reset an admin's password from the login screen; an
      // account leaving the admin role takes its set with it (#1).
      if (user.role !== "admin") delete user.recoveryCodes;
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
    }));
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
   * user able to manage roles or manage users, and (2026-10-08 #3) anyone
   * whose role holds more than the caller does.
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
    // continuous-bug-hunt, 2026-09-18: nested inside permissions.js's
    // withRoleMutex too -- see changeUserRoleById's identical nesting and
    // withRoleMutex's own comment for the cross-file race this closes
    // (a concurrent updateRole/deleteRole checking the same recovery
    // headcount this function's assertNoRecoveryLockout reads below).
    return this._withMutex(() => withRoleMutex(async () => {
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
      await assertCallerCoversTarget(actingUserId, delegableCapabilities(currentRole));
      await assertNoRecoveryLockout(userId, currentRole?.capabilities || [], []);

      db.data.users = users.filter((u) => u.id !== userId);
      await commitNow();

      log.info(`Deleted user: ${user.username} (${user.id})`);
      emitSessionRevoked({ scope: "user", userId: user.id });
      return { id: user.id, username: user.username };
    }));
  }

  // SECURITY (2026-10-05, A1): trusted-device tokens -- see the
  // deviceLoginThrottle comment at the top of this file for what they
  // change. A JWT signed with a key derived from the JWT secret, never the
  // secret itself, so a device token can't pass as an access or refresh
  // token (and rotating the JWT secret retires every device token too). It
  // carries a random id (jti), the account's id, the issue time (iat), an
  // expiry, and a stamp of the account's current password hash: changing,
  // resetting or recovering the password writes a new hash (new salt, even
  // for the same password), so every device token issued before stops
  // counting. Sent back by the client in the login request body, not as a
  // cookie: a cross-site page can't attach it to a forged sign-in to spend
  // the device's attempts, and nothing about CORS or cookie flags changes.
  _deviceTokenKey() {
    return crypto
      .createHmac("sha256", String(this.jwtSecret))
      .update("zcp-trusted-device-token-v1")
      .digest("hex");
  }

  _devicePasswordStamp(user, key) {
    return crypto
      .createHmac("sha256", key)
      .update(`password:${user.password || ""}`)
      .digest("base64url")
      .slice(0, 22);
  }

  // deviceId: the id to put in the token; a new random one when it's
  // missing. A kept-signed-in session reuses its own (see
  // createRefreshSession()).
  issueDeviceToken(user, deviceId) {
    if (!this.jwtSecret || !user?.id) return null;
    const key = this._deviceTokenKey();
    return jwt.sign(
      {
        type: "device",
        userId: user.id,
        pwd: this._devicePasswordStamp(user, key),
      },
      key,
      {
        algorithm: "HS256",
        expiresIn: Math.floor(DEVICE_TOKEN_LIFETIME_MS / 1000),
        jwtid: isDeviceId(deviceId) ? deviceId : newDeviceId(),
      },
    );
  }

  /**
   * A device token for the browser that just set an account's password
   * while signed in (POST /change-password) or rotated the JWT secret: both
   * retire every device token the account had, this browser's included, and
   * sign it out. Without a fresh one its next sign-in was counted by
   * address -- the very count a stranger may be keeping paused, so an owner
   * who changed the password because of a guessing attack was refused from
   * the browser they had just used (security sweep 2026-10-05, A1).
   */
  async issueDeviceTokenForUserId(userId) {
    const db = await getDb();
    const user = (db.data.users || []).find((u) => u.id === userId);
    return user ? this.issueDeviceToken(user) : null;
  }

  // SECURITY (2026-10-28, audit R2-31): over plain http:// nothing tells
  // this panel from whatever else answers at its address -- on another
  // network a 192.168.x address or a .lan name can be anybody, and the
  // Steam Sync extension sent the Steam cookies and the remembered password
  // to it on one click. A sign-in that asks for it gets this per-account
  // key (POST /login, wantsPanelKey); before the extension sends anything
  // to a plain-http:// panel again, the address has to prove it holds the
  // key (extensionPanelProof(), POST /extension-proof). Derived, never
  // stored: it changes only with the JWT secret.
  extensionPanelKey(userId) {
    if (!this.jwtSecret || !userId) return null;
    return crypto
      .createHmac("sha256", this._deviceTokenKey())
      .update(`zcp-steam-sync-panel-key-v1:${userId}`)
      .digest("base64url");
  }

  // HMAC(key, challenge) for the account named. An unknown name gets an
  // answer from a key no account has, at the same cost, so it can't be used
  // to find out who has an account.
  async extensionPanelProof(username, challenge) {
    if (!this.jwtSecret) return null;
    const db = await getDb();
    const user = (db.data.users || []).find(
      (u) => u.username.toLowerCase() === username.toLowerCase(),
    );
    const key = user
      ? this.extensionPanelKey(user.id)
      : crypto
          .createHmac("sha256", this._deviceTokenKey())
          .update(`zcp-steam-sync-no-account-v1:${username.toLowerCase()}`)
          .digest("base64url");
    return crypto
      .createHmac("sha256", key)
      .update(`zcp-steam-sync-proof-v1:${challenge}`)
      .digest("base64url");
  }

  /**
   * The device id a sign-in attempt on `user` is counted under, or null
   * when deviceToken is missing, malformed, expired, issued for another
   * account or from before the account's current password -- those attempts
   * are counted by address, the same as a browser that never signed in.
   * Synchronous on purpose: login() reserves the attempt right after this,
   * with nothing awaited in between.
   */
  trustedDeviceId(user, deviceToken) {
    if (
      !user ||
      !this.jwtSecret ||
      typeof deviceToken !== "string" ||
      !deviceToken ||
      deviceToken.length > DEVICE_TOKEN_MAX_LENGTH
    ) {
      return null;
    }
    try {
      const key = this._deviceTokenKey();
      const payload = jwt.verify(deviceToken, key, { algorithms: ["HS256"] });
      if (
        !payload ||
        typeof payload !== "object" ||
        payload.type !== "device" ||
        payload.userId !== user.id ||
        typeof payload.jti !== "string" ||
        !DEVICE_ID_PATTERN.test(payload.jti) ||
        payload.pwd !== this._devicePasswordStamp(user, key)
      ) {
        return null;
      }
      return payload.jti;
    } catch {
      return null;
    }
  }

  /**
   * trustedDeviceId() for the account a sign-in names, for routes/auth.js's
   * loginLimiter, which runs before login() and only has the request body.
   */
  async trustedDeviceIdForUsername(username, deviceToken) {
    if (typeof username !== "string" || !username) return null;
    if (typeof deviceToken !== "string" || !deviceToken) return null;
    const db = await getDb();
    const user = (db.data.users || []).find(
      (u) => u.username.toLowerCase() === username.toLowerCase(),
    );
    return user ? this.trustedDeviceId(user, deviceToken) : null;
  }

  /**
   * Authenticate user and return tokens.
   *
   * clientKey identifies where the attempt came from (routes/auth.js passes
   * the client address) -- failed attempts are counted per account AND
   * client, see the loginThrottle comment at the top of this file. Callers
   * that pass none share one "unknown" client. deviceToken is the one this
   * browser got from an earlier successful sign-in, if any: a valid one
   * counts the attempt under that device instead of the address. The result
   * carries a fresh deviceToken for the browser to keep. refreshSession:
   * false (the browser extension, which keeps only the access token) creates
   * no refresh session, so the result has no refreshToken and the route sets
   * no cookie.
   */
  async login(
    username,
    password,
    rememberMe = true,
    { clientKey, deviceToken, refreshSession: wantRefreshSession = true } = {},
  ) {
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

    // Counted before the compare, with nothing awaited in between, so a
    // burst of concurrent guesses can't all get past this check first.
    // Paused: same generic error, and the dummy compare so a paused client
    // doesn't get a distinct, faster timing signature from a normal
    // wrong-password attempt.
    const deviceId = this.trustedDeviceId(user, deviceToken);
    const reserved = deviceId
      ? reserveDeviceLoginAttempt(user.id, deviceId)
      : reserveLoginAttempt(user.id, clientKey);
    if (!reserved) {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      throw new Error("Invalid username or password");
    }
    const attempt = reserved.entry;

    // SECURITY (2026-10-08, #9): the compare below takes ~250ms and checks
    // the hash as it was when it started. A password change or reset that
    // lands meanwhile (new hash, tokenGen bumped, sessions cleared) used to
    // be followed by this sign-in minting a session under the NEW tokenGen,
    // so someone signing in with a leaked password could outlive the very
    // change meant to shut them out.
    const hashAtStart = user.password;
    const genAtStart = user.tokenGen || 0;

    // OIDC-only accounts (bootstrapped via bootstrapAdminFromExternalIdentity)
    // have no local password hash. Still run the dummy compare so this
    // branch costs the same as a real wrong-password attempt.
    let valid;
    try {
      if (user.password) {
        valid = await bcrypt.compare(password, user.password);
      } else {
        await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
        valid = false;
      }
    } catch (error) {
      settleLoginAttempt(reserved, false);
      throw error;
    }
    // Re-checked after the compare: a pause that began while this attempt
    // was being checked still refuses it, and so does a password change or
    // reset, or the account's deletion (#9).
    const changedMeanwhile =
      user.password !== hashAtStart ||
      (user.tokenGen || 0) !== genAtStart ||
      !(db.data.users || []).includes(user);
    if (!valid || changedMeanwhile || attempt.lockedUntil > Date.now()) {
      if (settleLoginAttempt(reserved, false)) {
        // SECURITY (2026-10-05, H2): behind TRUST_PROXY the address is the
        // X-Forwarded-For value as sent, so it is escaped for the log line.
        const from = clientKey ? escapeLogText(clientKey) : "an unknown address";
        log.warn(
          `Sign-in to ${user.username} ${
            deviceId ? `from a browser that signed in before (now at ${from})` : `from ${from}`
          } paused for ${LOCKOUT_DURATION_MS / 60000} minutes after ${MAX_FAILED_LOGINS} failed attempts`,
        );
      }
      throw new Error("Invalid username or password");
    }

    settleLoginAttempt(reserved, true);
    clearLegacyAccountLock(user);
    // The right password at sign-in proves what verifyCurrentPassword()
    // checks, which someone holding only a session can't: their wrong guesses
    // mustn't keep the owner from changing it afterwards.
    currentPasswordThrottle.delete(user.id);

    this.ensureUserAuthState(user);

    // Update last login
    user.lastLogin = new Date().toISOString();
    // Unticked "Keep me signed in" still gets a session, a browser-session
    // one (#21); without it the sign-in ended when the access token did.
    const refreshSession = wantRefreshSession
      ? this.createRefreshSession(user, { persistent: rememberMe !== false })
      : null;

    // Signed before the write below (#9): a change or reset landing during
    // it bumps tokenGen, and these then fail like every older token.
    const accessToken = this.generateAccessToken(user);
    const refreshToken = refreshSession ? this.generateRefreshToken(user, refreshSession.id) : null;
    const newDeviceToken = this.issueDeviceToken(user, refreshSession?.deviceId);
    await commitNow();

    // The stored name (letters, digits, _ and - only), not the one typed,
    // which only has to match it ignoring case -- U+212A KELVIN SIGN
    // lower-cases to "k" -- so the log names the account exactly
    // (SECURITY 2026-10-05, H2: no request text in log lines unescaped).
    log.info(`User logged in: ${user.username}`);
    // UX-only field -- see getCapabilitiesForRole()'s doc comment.
    const capabilities = await getCapabilitiesForRole(user.role);
    return {
      user: { id: user.id, username: user.username, role: user.role, capabilities },
      accessToken,
      refreshToken,
      deviceToken: newDeviceToken,
      ...(refreshSession ? refreshCookieFields(refreshSession) : {}),
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
      { algorithm: "HS256", expiresIn: ACCESS_TOKEN_EXPIRY },
    );
  }

  /**
   * Generate a long-lived refresh token (for auto-login / remember me)
   * Includes tokenGen counter so tokens can be invalidated by incrementing the counter.
   */
  generateRefreshToken(user, sessionId) {
    // Expires with its session, never past the session's absolute limit
    // (#10), and names its sign-in's chain of sessions (`fam`) so a replaced
    // token sent again is recognised (findReplacedSession()).
    const session = (user.refreshSessions || []).find((entry) => entry.id === sessionId);
    const expiresAt = Date.parse(session?.expiresAt || "");
    const expiresIn = Number.isNaN(expiresAt)
      ? Math.floor(REFRESH_TOKEN_LIFETIME_MS / 1000)
      : Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
    return jwt.sign(
      {
        userId: user.id,
        type: "refresh",
        tokenGen: user.tokenGen || 0,
        sessionId,
        ...(session?.familyId ? { fam: session.familyId } : {}),
      },
      this.jwtSecret,
      { algorithm: "HS256", expiresIn },
    );
  }

  /**
   * Verify an access token and return the payload
   */
  verifyAccessToken(token) {
    try {
      const payload = jwt.verify(token, this.jwtSecret, { algorithms: ["HS256"] });
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
      const payload = jwt.verify(refreshToken, this.jwtSecret, { algorithms: ["HS256"] });
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

      // Validate tokenGen — reject tokens from before a password change,
      // reset, or sign-out everywhere (revokeAllSessions())
      const currentGen = user.tokenGen || 0;
      const tokenGen = payload.tokenGen ?? 0;
      if (tokenGen !== currentGen) {
        throw new Error("Refresh token has been revoked");
      }

      if (!payload.sessionId) {
        throw new Error("Refresh token session is missing");
      }

      const now = Date.now();
      const session = this.findRefreshSession(user, payload.sessionId);
      if (!session) {
        // sweep-round4: distinguish "kicked for capacity" from every other
        // reason this id could be missing (expired / revoked / forged) --
        // see findCapacityEvictionReason()'s own comment for why those three
        // stay indistinguishable from each other on purpose.
        const reason = this.findCapacityEvictionReason(user, payload.sessionId);
        if (reason === "capacity") {
          const capacityError = new Error("Refresh token session was evicted for capacity");
          capacityError.refreshFailureReason = "capacity";
          throw capacityError;
        }
        const replaced = this.findReplacedSession(user, payload, now);
        if (replaced === "race") {
          // #19: not reuse, and the browser's cookie jar already holds the
          // winner's token -- the route answers REFRESH_RACE and leaves the
          // cookie alone.
          const raceError = new Error("Refresh token was just replaced by another request");
          raceError.refreshFailureReason = "race";
          throw raceError;
        }
        if (replaced === "reuse") {
          // #10: a token already exchanged, sent again after the grace
          // window: either its owner or a thief holds a copy. Nothing tells
          // which, so every session of the account ends.
          this.endAllSessions(user);
          await commitNow();
          emitSessionRevoked({ scope: "user", userId: user.id });
          log.warn(
            `A refresh token for ${user.username} that had already been replaced was used again; every session of that account was signed out.`,
          );
        }
        throw new Error("Refresh token session is no longer active");
      }

      // #10: the session ends at its absolute limit however often it is
      // refreshed. One stored before sessions had a limit gets one from now.
      const absoluteExpiresAt = Date.parse(session.absoluteExpiresAt || "");
      if (!Number.isNaN(absoluteExpiresAt) && absoluteExpiresAt <= now) {
        this.revokeRefreshSession(user, payload.sessionId);
        await commitNow();
        throw new Error("Refresh token session reached its absolute limit");
      }

      this.revokeRefreshSession(user, payload.sessionId);
      // The same trusted-device id as the session it replaces (see
      // createRefreshSession()); a session stored before sessions had one
      // gets a new one here and keeps it from then on. The same goes for its
      // persistence, absolute limit and chain of sessions (#10, #21), and it
      // remembers the id it replaced for REFRESH_RACE_GRACE_MS (#19).
      const rotatedFrom = [
        ...(session.rotatedFrom || []).filter(
          (entry) => now - Date.parse(entry.at) <= REFRESH_RACE_GRACE_MS,
        ),
        { id: session.id, at: new Date(now).toISOString() },
      ].slice(-MAX_ROTATION_RECORDS);
      const newSession = this.createRefreshSession(user, {
        deviceId: session.deviceId,
        persistent: session.persistent !== false,
        absoluteExpiresAt: Number.isNaN(absoluteExpiresAt) ? undefined : session.absoluteExpiresAt,
        familyId: session.familyId,
        rotatedFrom,
      });

      // Signed before the write, as in login() (#9): a password change or
      // reset landing during it must not leave these valid.
      const accessToken = this.generateAccessToken(user);
      const newRefreshToken = this.generateRefreshToken(user, newSession.id);
      // SECURITY (2026-10-05, A1): a kept-signed-in browser, and one that
      // just came back from SSO (oidc.js's callback can only redirect, so
      // the client's first refresh is where it gets one), keeps a current
      // device token for when it next has to type the password -- always
      // with its session's device id.
      const newDeviceToken = this.issueDeviceToken(user, newSession.deviceId);
      await commitNow();

      // UX-only field -- see getCapabilitiesForRole()'s doc comment.
      const capabilities = await getCapabilitiesForRole(user.role);
      return {
        user: { id: user.id, username: user.username, role: user.role, capabilities },
        accessToken,
        refreshToken: newRefreshToken,
        deviceToken: newDeviceToken,
        ...refreshCookieFields(newSession),
      };
    } catch (error) {
      // Every failure returns null (the pre-existing, deliberately
      // uninformative contract for the security cases) EXCEPT a capacity
      // eviction, which is a product fact, not a security one -- see
      // createRefreshSession()'s tombstone comment -- and a lost race between
      // two refreshes with the same cookie (#19), which only ever tells the
      // holder of a token just replaced that it was just replaced.
      if (error.refreshFailureReason === "capacity" || error.refreshFailureReason === "race") {
        return { refreshFailureReason: error.refreshFailureReason };
      }
      return null;
    }
  }

  /**
   * Sign one account out everywhere (#10): POST /api/auth/sessions/revoke-all
   * for the caller's own account, and the users.manage "sign out" action for
   * another one. Ends every refresh session and, through tokenGen, every
   * access token; live sockets are evicted. Signing out someone else is held
   * to the same ceiling as demoting them (assertCallerCoversTarget).
   */
  async revokeAllSessions(userId, { actingUserId } = {}) {
    return this._withMutex(async () => {
      const db = await getDb();
      const user = (db.data.users || []).find((u) => u.id === userId);
      if (!user) {
        throw new Error("User not found");
      }
      if (actingUserId && String(actingUserId) !== String(userId)) {
        const role = user.roleId ? await getRoleById(user.roleId) : await getRoleByName(user.role);
        await assertCallerCoversTarget(actingUserId, delegableCapabilities(role));
      }

      this.ensureUserAuthState(user);
      const sessions = user.refreshSessions.length;
      this.endAllSessions(user);
      // The current-password pause (#8) stays: an SSO sign-in mints a fresh
      // session without the password, so whoever holds a linked identity
      // could otherwise spend the allowance, sign out everywhere and start
      // again. The owner's next sign-in with the password lifts it (login()).
      await commitNow();
      emitSessionRevoked({ scope: "user", userId: user.id });
      log.info(`Signed out every session of ${user.username}`);
      return { id: user.id, username: user.username, sessions };
    });
  }

  /**
   * Checks the signed-in account's own password before an action that asks
   * for it (changing it, generating recovery codes). Counted against the
   * account's own allowance (currentPasswordThrottle, #8): a wrong password
   * and a paused account get the same CURRENT_PASSWORD_INCORRECT, the paused
   * one after a dummy compare so it takes as long.
   */
  async verifyCurrentPassword(user, currentPassword) {
    const incorrect = () =>
      makeRoleError(ErrorCode.CURRENT_PASSWORD_INCORRECT, "Current password is incorrect", 400);
    const guess = typeof currentPassword === "string" ? currentPassword : "";
    const reserved = reserveCurrentPasswordAttempt(user.id);
    if (!reserved) {
      await bcrypt.compare(guess, DUMMY_BCRYPT_HASH);
      throw incorrect();
    }
    let valid;
    try {
      valid = Boolean(user.password) && (await bcrypt.compare(guess, user.password));
    } catch (error) {
      settleLoginAttempt(reserved, false);
      throw error;
    }
    if (!valid || reserved.entry.lockedUntil > Date.now()) {
      if (settleLoginAttempt(reserved, false)) {
        log.warn(
          `Password checks for ${user.username} (changing it, generating recovery codes) paused for ${
            LOCKOUT_DURATION_MS / 60000
          } minutes after ${MAX_FAILED_LOGINS} wrong current passwords`,
        );
      }
      throw incorrect();
    }
    settleLoginAttempt(reserved, true);
  }

  /**
   * Change user password
   */
  async changePassword(userId, currentPassword, newPassword) {
    assertNewPasswordPolicy(newPassword);

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

    await this.verifyCurrentPassword(user, currentPassword);

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
      // SECURITY (2026-10-08, #13): linked SSO identities, so a wrong or
      // unexpected link can be seen and removed. The subject is masked:
      // issuer + subject is what a forged ID token would need to sign in
      // as this account, and users.manage alone can read this list.
      externalIdentities: (Array.isArray(u.externalIdentities) ? u.externalIdentities : []).map(
        (ext) => ({
          issuer: ext.issuer,
          subject: maskExternalSubject(ext.subject),
          email: typeof ext.email === "string" ? ext.email : null,
          linkedAt: ext.linkedAt || null,
        }),
      ),
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
    if (
      typeof issuer !== "string" ||
      !issuer ||
      typeof subject !== "string" ||
      !subject
    ) {
      throw new Error("issuer and subject are required");
    }

    return this._withMutex(async () => {
      const db = await getDb();
      const users = db.data.users || [];
      const matches = users.filter(
        (u) =>
          Array.isArray(u.externalIdentities) &&
          u.externalIdentities.some(
            (ext) => ext.issuer === issuer && ext.subject === subject,
          ),
      );

      if (matches.length > 1) {
        log.error(
          `Refusing OIDC login: identity ${escapeLogText(issuer)}/${escapeLogText(subject)} is linked to multiple accounts`,
        );
        throw new Error("External identity is linked to multiple accounts");
      }

      const existing = matches[0];

      if (!existing) {
        return { linked: false, canBootstrapAdmin: users.length === 0 };
      }

      // No password-guessing pause here. Failed password attempts slow down
      // password guessing (login() above); a verified provider identity is
      // not a password guess. This used to refuse SSO while the account was
      // locked, which let anyone who knew the username lock its owner out of
      // SSO too, just by typing wrong passwords.
      clearLegacyAccountLock(existing);
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
    });
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
      if (
        typeof issuer !== "string" ||
        !issuer ||
        typeof subject !== "string" ||
        !subject
      ) {
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
            email: typeof email === "string" ? email : null,
            linkedAt: new Date().toISOString(),
          },
        ],
        createdAt: new Date().toISOString(),
        lastLogin: null,
      };

      db.data.users.push(user);
      await commitNow();
      await clearSetupToken();
      // Same as createUser()'s first account: drop every socket that
      // connected while the panel had no accounts.
      emitSessionRevoked({ scope: "all" });

      log.info(`First admin account bootstrapped via OIDC: ${username}`);
      return { id: user.id, username: user.username, role: user.role };
    });
  }

  /**
   * Link an external identity to an EXISTING local account. This is the
   * data operation only — the route that calls this is responsible for
   * enforcing it's admin-only, the same way the requireRole("admin")
   * routes elsewhere in this app do. actingTokenGen: the initiator's
   * tokenGen when the flow started; a flow outlives neither that admin being
   * signed out everywhere nor a password change, reset or reuse detection,
   * so a stolen session can't land a link after its owner was revoked.
   */
  async linkExternalIdentity(
    userId,
    { issuer, subject, email } = {},
    { actingUserId, actingTokenGen } = {},
  ) {
    if (
      typeof issuer !== "string" ||
      !issuer ||
      typeof subject !== "string" ||
      !subject
    ) {
      throw new Error("issuer and subject are required");
    }

    return this._withMutex(async () => {
      const db = await getDb();
      const users = db.data.users || [];
      const user = users.find((u) => u.id === userId);
      if (!user) {
        throw new Error("User not found");
      }
      if (actingUserId) {
        const actingUser = users.find((candidate) => candidate.id === actingUserId);
        if (actingUser?.role !== "admin") {
          throw new Error("The initiating administrator is no longer authorized");
        }
        if (actingTokenGen !== undefined && (actingUser.tokenGen || 0) !== actingTokenGen) {
          throw new Error("The initiating administrator's session has ended");
        }
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
          email: typeof email === "string" ? email : null,
          linkedAt: new Date().toISOString(),
        });
        await commitNow();
      }

      log.info(`Linked external identity to user: ${user.username}`);
      return { id: user.id, username: user.username, role: user.role };
    });
  }

  /**
   * Remove every external identity linked to an account (SECURITY
   * 2026-10-08, #13): before this, a wrong or hijacked link could only be
   * undone by deleting the account. The route enforces admin-only, like
   * linking. Ends the account's sessions too: one may have been started
   * with the identity being removed, and nothing records which.
   */
  async unlinkExternalIdentities(userId) {
    return this._withMutex(async () => {
      const db = await getDb();
      const users = db.data.users || [];
      const user = users.find((u) => u.id === userId);
      if (!user) {
        throw new Error("User not found");
      }

      const removed = Array.isArray(user.externalIdentities)
        ? user.externalIdentities.length
        : 0;
      if (removed > 0) {
        user.externalIdentities = [];
        user.tokenGen = (user.tokenGen || 0) + 1;
        user.refreshSessions = [];
        await commitNow();
        log.info(`Unlinked ${removed} external identit${removed === 1 ? "y" : "ies"} from user: ${user.username}`);
        emitSessionRevoked({ scope: "user", userId: user.id });
      }
      return { id: user.id, username: user.username, removed };
    });
  }

  /**
   * Sessions: logout is the one revocation trigger that isn't reached by
   * searching for "what invalidates a credential" -- it doesn't bump
   * tokenGen or touch the password, it just removes one refresh session
   * (single-device, by design; see the class comment above this method's
   * neighbors for why a full-fleet wipe belongs to changePassword/
   * regenerateJwtSecret/revokeAllSessions instead). That's exactly why it was missing from
   * the socket-eviction bus (sweep-round2, c0017c7b) until now: every one
   * of the five triggers that bus already covered was found by asking
   * "where does this file invalidate a credential" -- logout ends a
   * session WITHOUT touching one. A socket opened before logout kept its
   * rooms (including rcon-live, which carries RCON whitelist passwords)
   * indefinitely, with nothing server-side enforcing the disconnect --
   * only the web client's own cleanup (client/src/App.tsx's socket
   * useEffect closes the socket when isAuthenticated flips false), which
   * is incidental client behavior, not something the server can rely on
   * for a security boundary (a different client, a modified bundle, or a
   * crash before that cleanup runs would all skip it).
   *
   * Scope tradeoff, deliberate: emits scope:"user" (every socket for this
   * user, all devices), not scope tied to just the one refresh session
   * that was revoked -- sockets authenticate off the access token, whose
   * payload carries userId/role/tokenGen but no sessionId, so there is no
   * per-device room to target more narrowly without a bigger change to
   * what the access token carries. A user logging out on device A also
   * disconnects device B's socket, and it stays down: socket.io-client
   * treats a server-side disconnect as final and does not reconnect by
   * itself. Device B's access/refresh tokens are untouched, so its next
   * connect (Retry in the connection status, or a reload) goes through
   * socketAuth.ts with them and succeeds. Same shape and same tradeoff
   * every one of the other four triggers already accepts. Other tabs of
   * the browser that signed out hear it from the client itself
   * (AuthContext.tsx's 'pz-auth' channel) and show the sign-in screen;
   * their HTTP calls would otherwise keep working until the access token
   * expires, since this does not revoke access tokens.
   */
  async logout(refreshToken) {
    if (!refreshToken) {
      return false;
    }

    try {
      const payload = jwt.verify(refreshToken, this.jwtSecret, { algorithms: ["HS256"] });
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
        emitSessionRevoked({ scope: "user", userId: user.id });
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
    assertResetPasswordPolicy(newPassword);

    const db = await getDb();
    const users = db.data.users || [];
    if (users.length === 0) {
      throw new Error("No user accounts exist. Use setup instead.");
    }

    // Reset the first admin account
    const user = users.find((u) => u.role === "admin") || users[0];
    return this.resetPasswordForUser(user, newPassword);
  }

  /**
   * Set `user`'s password without the old one: the reset token and
   * --reset-password reach it through resetPassword() above, a recovery code
   * for the account it belongs to (redeemRecoveryCode() below).
   */
  async resetPasswordForUser(user, newPassword) {
    assertResetPasswordPolicy(newPassword);
    user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    user.tokenGen = (user.tokenGen || 0) + 1;
    user.refreshSessions = [];
    // Recovery (reset token, recovery code, --reset-password) is the way
    // back in after failed sign-ins, so it lifts every pause on the
    // account; it used to leave the lock in place, so the new password
    // was refused too.
    clearLegacyAccountLock(user);
    clearLoginThrottleForUser(user.id);
    await commitNow();

    log.info(`Password reset for user: ${user.username}`);
    emitSessionRevoked({ scope: "user", userId: user.id });
    // SECURITY (2026-10-05, A1): the browser that did the reset (a reset
    // token or recovery code proves as much as the new password does) keeps
    // a device token that counts, like after POST /change-password -- see
    // issueDeviceTokenForUserId().
    return { username: user.username, deviceToken: this.issueDeviceToken(user) };
  }

  /**
   * Generate single-use recovery codes for the signed-in admin's own account.
   *
   * Only the hashes are stored, so a database copy cannot be turned back into
   * usable codes. The plaintext is returned once and never recoverable after.
   *
   * SECURITY (2026-10-08, #1): codes used to be one global set aimed at the
   * first admin, whoever generated them, and nothing ever cleared them. A
   * co-admin, or anyone holding an admin's access token for a few minutes,
   * could mint a set, silently replacing the owner's own, and after being
   * deleted or demoted reset the owner's password from the login screen. A
   * set now belongs to the account that generated it (user.recoveryCodes),
   * resets only that account, works only while it is still admin, and goes
   * with the account when it is deleted or leaves the admin role. Asking for
   * the current password first means a stolen access token alone can't mint
   * a set either.
   */
  async generateRecoveryCodes(userId, currentPassword, count = 10) {
    if (!userId) {
      throw new Error("Recovery codes belong to an account; sign in to generate them.");
    }
    const db = await getDb();
    const caller = (db.data.users || []).find((u) => u.id === userId);
    if (!caller) throw new Error("User not found");
    await this.verifyCurrentPassword(caller, currentPassword);

    return this._withMutex(async () => {
      // Re-read inside the mutex: a demotion or delete that landed after the
      // password check must not be followed by a fresh set for the account.
      const user = (db.data.users || []).find((u) => u.id === userId);
      if (!user || user.role !== "admin") {
        throw new Error("Only an administrator can generate recovery codes.");
      }

      const codes = [];
      const entries = [];
      for (let i = 0; i < count; i++) {
        const raw = crypto.randomBytes(15).toString("base64url").slice(0, 20).toUpperCase();
        const code = `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}`;
        codes.push(code);
        entries.push({
          hash: crypto.createHash("sha256").update(code, "utf8").digest("hex"),
          usedAt: null,
        });
      }

      const createdAt = new Date().toISOString();
      user.recoveryCodes = { createdAt, codes: entries };
      await commitNow();
      log.info(`Generated ${count} recovery codes for user: ${user.username}`);
      return { codes, createdAt };
    });
  }

  /** The signed-in account's own set: how many codes are left and when it was made. */
  async getRecoveryCodeStatus(userId) {
    const db = await getDb();
    const user = (db.data.users || []).find((u) => u.id === userId);
    const entries = recoveryCodeEntries(user);
    const remaining = entries.filter((entry) => !entry.usedAt).length;
    return {
      configured: entries.length > 0,
      remaining,
      total: entries.length,
      createdAt: entries.length > 0 ? user.recoveryCodes.createdAt || null : null,
    };
  }

  /** Whether any admin has an unused code, for the login screen's recovery choice. */
  async hasUsableRecoveryCodes() {
    const db = await getDb();
    return (db.data.users || []).some(
      (user) => user.role === "admin" && recoveryCodeEntries(user).some((entry) => !entry.usedAt),
    );
  }

  /**
   * Consume a recovery code and set a new password for the account it
   * belongs to. The code is burned whether or not the caller knows the old
   * password, so each one works exactly once. Refused with the same message
   * as a wrong code when that account is no longer an admin; the global set
   * older versions kept (settings.authRecoveryCodes) is never read, so it
   * redeems nothing (#1).
   *
   * Wrapped in _withMutex for the same reason createUser/changeUserRoleById/
   * deleteUser/bootstrapAdminFromExternalIdentity are: this is a check-then-
   * write (is this code still unused? -> mark it used) with an await
   * (resetPasswordForUser's real bcrypt.hash, ~150-300ms) between the check
   * and the write. Without serializing, two concurrent redemptions of the
   * SAME code both pass validation and both successfully reset the password,
   * defeating "each code works exactly once" on an unauthenticated,
   * admin-password-reset endpoint. Reproduced in
   * server/tests/recoveryCodeRedeemRace.test.js.
   */
  async redeemRecoveryCode(code, newPassword) {
    return this._withMutex(async () => {
      // The new password is judged first, so a refused one never spends
      // the code, and the answer says nothing about the code.
      assertNewPasswordPolicy(newPassword);
      if (typeof code !== "string" || !code.trim()) {
        throw new Error("A recovery code is required");
      }
      const db = await getDb();
      const admins = (db.data.users || []).filter((user) => user.role === "admin");
      if (!admins.some((user) => recoveryCodeEntries(user).length > 0)) {
        throw new Error("No recovery codes have been generated for this panel.");
      }

      const candidate = crypto
        .createHash("sha256")
        .update(code.trim().toUpperCase(), "utf8")
        .digest();
      let owner = null;
      let match = null;
      for (const user of admins) {
        match = recoveryCodeEntries(user).find((entry) => {
          if (entry.usedAt || typeof entry.hash !== "string") return false;
          const storedDigest = Buffer.from(entry.hash, "hex");
          if (storedDigest.length !== candidate.length) return false;
          return crypto.timingSafeEqual(storedDigest, candidate);
        });
        if (match) {
          owner = user;
          break;
        }
      }
      if (!match) {
        throw new Error("That recovery code is not valid or has already been used.");
      }

      const result = await this.resetPasswordForUser(owner, newPassword);
      match.usedAt = new Date().toISOString();
      await commitNow();
      const remaining = recoveryCodeEntries(owner).filter((entry) => !entry.usedAt).length;
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
        // Only protect API routes — let static files and SPA page routes through.
        // Express matches routes case-insensitively, so /API/... and /Api/...
        // reach the same handlers as /api/...: the prefix test must ignore case
        // too, or any other spelling skips authentication entirely (reported in
        // #193). The exemptions below still compare the path exactly, so an
        // odd spelling of a public path just has to sign in.
        if (!req.path.toLowerCase().startsWith("/api")) {
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

        // Allow mod thumbnail proxy (also loaded via <img> tags). Like the tile
        // proxy above, the upstream host is fixed (Steam), so it is not an SSRF
        // surface -- but both fetch from the internet and write a disk cache
        // for anyone who can reach the panel, signed in or not, so whatever
        // bounds that work (which items, how much is kept) has to live in
        // routes/mods.js and routes/mapProxy.js themselves, not here.
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
