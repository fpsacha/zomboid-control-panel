import { beforeEach, describe, expect, it, vi } from "vitest";

// sweep-round3 (2026-09-06, dwight): auth-session lens beyond sockets. Two
// questions god asked to be proven empirically rather than settled by
// reading the code, because "the code can look correct either way":
//
//   1. Refresh-token replay: does redeeming a refresh token invalidate the
//      one that was redeemed, or can the SAME token be replayed to mint a
//      second, independent session? If rotation doesn't actually invalidate
//      the old token, a token captured once (XSS, a synced browser profile,
//      a leaked log line) works indefinitely with nothing in the UI ever
//      showing it.
//   2. Does logout emit onSessionRevoked (services/auth.js, built for
//      c0017c7b's socket-eviction fix)? Confirmed by reading first: it does
//      not. A socket opened before logout keeps its rooms -- including
//      rcon-live, which carries RCON whitelist passwords -- because the
//      only thing that currently tears it down is the WEB CLIENT'S OWN
//      cleanup effect (client/src/App.tsx, `createdSocket?.close()` in the
//      socket useEffect's cleanup, keyed on `isAuthenticated`), not
//      anything server-enforced. Every one of the five triggers this bus
//      already covers (secret regen, password change/reset, role change,
//      delete) works regardless of what the client does; logout is the one
//      action that currently doesn't, and it's the one action a user takes
//      SPECIFICALLY to end their session.

const settings = new Map();
const db = { data: { users: [], roles: [] } };

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getDb: async () => db,
  commitNow: async () => {},
  getRoles: async () => db.data.roles,
  getRoleById: async (id) =>
    db.data.roles.find((r) => String(r.id) === String(id)) || null,
  getRoleByName: async (name) =>
    db.data.roles.find((r) => r.name === name) || null,
  getUsersForRole: async (role) =>
    db.data.users.filter(
      (u) => u.roleId === role.id || (role.isSeeded && u.role === role.name),
    ),
}));

const { default: authService, onSessionRevoked } = await import(
  "../services/auth.js"
);

const TECHNICIAN_ROLE = {
  id: "role-technician",
  name: "technician",
  capabilities: ["server.control", "rcon.execute"],
  isSeeded: true,
};

function resetWith({ roles = [], users = [] }) {
  settings.clear();
  db.data.roles = roles.map((r) => ({ ...r }));
  db.data.users = users.map((u) => ({ ...u }));
}

describe("Refresh-token replay: redeeming a token must invalidate it, proven empirically", () => {
  beforeEach(() => {
    resetWith({
      roles: [TECHNICIAN_ROLE],
      users: [
        { id: "u-tech", username: "tech", role: "technician", roleId: "role-technician", tokenGen: 0 },
      ],
    });
    authService.jwtSecret = "test-replay-secret";
  });

  it("the SAME refresh token cannot be redeemed twice -- the second attempt is refused, not treated as a fresh, independent session", async () => {
    const user = db.data.users[0];
    const session = authService.createRefreshSession(user);
    const originalRefreshToken = authService.generateRefreshToken(user, session.id);

    // First redemption: exactly what POST /api/auth/refresh does with a
    // legitimate, not-yet-used token.
    const first = await authService.refreshAccessToken(originalRefreshToken);
    expect(first).not.toBeNull();
    expect(first.accessToken).toBeTruthy();
    expect(first.refreshToken).toBeTruthy();
    expect(first.refreshToken).not.toBe(originalRefreshToken);

    // Second redemption of the EXACT SAME (now-stale) token -- the replay
    // attempt. If rotation is real, this must fail: the session it pointed
    // at no longer exists (it was revoked and replaced during the first
    // redemption above).
    const replay = await authService.refreshAccessToken(originalRefreshToken);
    expect(replay).toBeNull();
  });

  it("the NEW token issued by rotation keeps working where the old one is dead -- proves rotation issues a real, usable replacement, not just revocation", async () => {
    const user = db.data.users[0];
    const session = authService.createRefreshSession(user);
    const originalRefreshToken = authService.generateRefreshToken(user, session.id);

    const first = await authService.refreshAccessToken(originalRefreshToken);
    const second = await authService.refreshAccessToken(first.refreshToken);

    expect(second).not.toBeNull();
    expect(second.accessToken).toBeTruthy();
  });

  it("two concurrent redemptions of the same token: exactly one succeeds, the other is refused -- no double-issuance from a race", async () => {
    const user = db.data.users[0];
    const session = authService.createRefreshSession(user);
    const originalRefreshToken = authService.generateRefreshToken(user, session.id);

    const [a, b] = await Promise.all([
      authService.refreshAccessToken(originalRefreshToken),
      authService.refreshAccessToken(originalRefreshToken),
    ]);

    const results = [a, b];
    const succeeded = results.filter((r) => r !== null);
    const failed = results.filter((r) => r === null);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
  });
});

describe("logout() and the session-revocation bus (onSessionRevoked)", () => {
  beforeEach(() => {
    resetWith({
      roles: [TECHNICIAN_ROLE],
      users: [
        { id: "u-tech", username: "tech", role: "technician", roleId: "role-technician", tokenGen: 0 },
      ],
    });
    authService.jwtSecret = "test-logout-secret";
  });

  it("logout() DOES emit onSessionRevoked for the logging-out user when it actually revokes a session", async () => {
    const user = db.data.users[0];
    const session = authService.createRefreshSession(user);
    const refreshToken = authService.generateRefreshToken(user, session.id);

    const events = [];
    const unsubscribe = onSessionRevoked((event) => events.push(event));
    try {
      const result = await authService.logout(refreshToken);
      expect(result).toBe(true);
      expect(events).toEqual([{ scope: "user", userId: "u-tech" }]);
    } finally {
      unsubscribe();
    }
  });

  it("logout() does NOT emit onSessionRevoked when there was nothing to revoke (invalid/already-used token) -- no false eviction from a no-op call", async () => {
    const events = [];
    const unsubscribe = onSessionRevoked((event) => events.push(event));
    try {
      const result = await authService.logout("not-a-real-token");
      expect(result).toBe(false);
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("the logged-out session's refresh token is genuinely dead afterward (not just an event with no effect)", async () => {
    const user = db.data.users[0];
    const session = authService.createRefreshSession(user);
    const refreshToken = authService.generateRefreshToken(user, session.id);

    await authService.logout(refreshToken);

    const afterLogout = await authService.refreshAccessToken(refreshToken);
    expect(afterLogout).toBeNull();
  });
});
