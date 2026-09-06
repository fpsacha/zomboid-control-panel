import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

// sweep-round2 (2026-09-06, dwight): Socket.IO connections authenticate
// once at handshake (server/index.js's io.use middleware, which calls
// authService.authenticateAccessToken()) and are never re-validated per
// event -- unlike every HTTP request, which re-runs that exact same check
// via authService.middleware() on every single call. Every documented
// session-invalidation path was therefore a no-op for any socket that had
// already completed its handshake: regenerate-jwt-secret's own route
// comment (server/routes/auth.js) promises it "Immediately invalidates
// EVERY existing session -- access and refresh tokens, every user, every
// device", but a socket connected before the regen kept its cached
// socket.user forever and stayed joined to whatever rooms it had already
// joined -- including rcon-live, which the code's own comment says carries
// whitelist passwords. Same gap for password change/reset (tokenGen bump),
// role change, and user deletion. Nothing in the codebase ever called
// disconnectSockets/socket.disconnect/fetchSockets to evict a live socket.
//
// Fix: services/auth.js's five revocation paths (regenerateJwtSecret,
// changePassword, resetPassword, changeUserRoleById, deleteUser) now emit
// through a tiny onSessionRevoked() pub/sub (same shape as
// utils/logger.js's onLog), and index.js subscribes with
// evictRevokedSockets(), which calls the real Socket.IO server's
// disconnectSockets(true) -- globally for a secret regen, or scoped to the
// `user:<id>` room every authenticated socket joins on connect for
// everything else (that room membership is index.js's own addition too).
//
// PRE-FIX BREAK-VERIFY: before this fix, `onSessionRevoked` was not an
// export of services/auth.js and `evictRevokedSockets` was not an export
// of index.js, so this file's imports below fail outright against pre-fix
// code. Patched around that, every assertion here would still fail: calling
// any of the five mutations produced zero observable signal for anything
// downstream to act on -- there was nothing in the codebase that could ever
// learn a revocation had happened and evict a socket for it, which is
// exactly why an already-open socket kept working forever.
//
// VERIFICATION LIMIT: socket.io-client is a client-only dependency (lives
// in client/node_modules, not resolvable from a server-side test), so this
// suite cannot drive a real network client through a real handshake and
// watch it actually get dropped. Instead it exercises the real production
// chain up to the exact boundary that would evict a live socket: real
// authService mutations -> the real onSessionRevoked bus -> the real
// evictRevokedSockets() -> the real (non-listening) Socket.IO `Server`
// instance's own disconnectSockets()/in() methods, spied on rather than
// reimplemented. index.js is never started (`start()` is gated behind
// `!process.env.VITEST`, which vitest sets automatically) -- only its
// module-level Socket.IO wiring runs.

const ADMIN_ROLE = {
  id: "role-admin",
  name: "admin",
  capabilities: ["users.manage", "roles.manage", "server.control"],
  isSeeded: true,
};
const TECHNICIAN_ROLE = {
  id: "role-technician",
  name: "technician",
  capabilities: ["server.control", "backups.manage"],
  isSeeded: true,
};

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

// Importing both from the SAME test file's module graph means this
// `authService` reference and the one index.js holds internally are the
// identical singleton -- index.js's own `onSessionRevoked(evictRevokedSockets)`
// call (made once, at its import time below) registers against the exact
// callback array these tests' authService calls fire into. This is the real
// wiring, not a reimplementation of it.
const { default: authService } = await import("../services/auth.js");
const { io, evictRevokedSockets } = await import("../index.js");

function resetWith({ roles = [], users = [] }) {
  settings.clear();
  db.data.roles = roles.map((r) => ({ ...r }));
  db.data.users = users.map((u) => ({ ...u }));
}

describe("Socket eviction wiring: real authService revocation calls reach the real Socket.IO server", () => {
  let disconnectSocketsSpy;
  let roomDisconnectSpy;
  let inSpy;

  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE, TECHNICIAN_ROLE],
      users: [
        {
          id: "u-tech",
          username: "tech",
          role: "technician",
          roleId: "role-technician",
          tokenGen: 0,
          password: bcrypt.hashSync("currentpw", 4),
        },
      ],
    });
    authService.jwtSecret = "test-socket-revocation-secret";

    disconnectSocketsSpy = vi
      .spyOn(io, "disconnectSockets")
      .mockImplementation(() => {});
    roomDisconnectSpy = vi.fn();
    inSpy = vi.spyOn(io, "in").mockReturnValue({ disconnectSockets: roomDisconnectSpy });
  });

  afterEach(() => {
    disconnectSocketsSpy.mockRestore();
    inSpy.mockRestore();
  });

  it("changePassword() evicts only that user's live sockets, by their own user:<id> room, not everyone's", async () => {
    await authService.changePassword("u-tech", "currentpw", "brandnewpassword1");

    expect(inSpy).toHaveBeenCalledWith("user:u-tech");
    expect(roomDisconnectSpy).toHaveBeenCalledWith(true);
    expect(disconnectSocketsSpy).not.toHaveBeenCalled();
  });

  it("resetPassword() evicts the reset user's live sockets", async () => {
    // No admin user seeded in this db -- resetPassword() falls through to
    // users[0], which is u-tech.
    await authService.resetPassword("anotherbrandnewpw1");

    expect(inSpy).toHaveBeenCalledWith("user:u-tech");
    expect(roomDisconnectSpy).toHaveBeenCalledWith(true);
    expect(disconnectSocketsSpy).not.toHaveBeenCalled();
  });

  it("changeUserRoleById() evicts the promoted/demoted user's live sockets", async () => {
    await authService.changeUserRoleById("u-tech", "role-admin");

    expect(inSpy).toHaveBeenCalledWith("user:u-tech");
    expect(roomDisconnectSpy).toHaveBeenCalledWith(true);
    expect(disconnectSocketsSpy).not.toHaveBeenCalled();
  });

  it("deleteUser() evicts the deleted user's live sockets", async () => {
    await authService.deleteUser("u-tech", { actingUserId: "someone-else" });

    expect(inSpy).toHaveBeenCalledWith("user:u-tech");
    expect(roomDisconnectSpy).toHaveBeenCalledWith(true);
    expect(disconnectSocketsSpy).not.toHaveBeenCalled();
  });

  it("regenerateJwtSecret() evicts EVERY live socket globally, not a single user's room -- matches its own route comment's 'every user, every device' claim", async () => {
    await authService.regenerateJwtSecret();

    expect(disconnectSocketsSpy).toHaveBeenCalledWith(true);
    expect(inSpy).not.toHaveBeenCalled();
  });

  it("a read that isn't a revocation path (getUsers) evicts nothing -- the wiring doesn't fire on every auth.js call", async () => {
    await authService.getUsers();

    expect(disconnectSocketsSpy).not.toHaveBeenCalled();
    expect(inSpy).not.toHaveBeenCalled();
  });
});

describe("evictRevokedSockets() fails safe on a malformed or unrecognized event", () => {
  let disconnectSocketsSpy;
  let inSpy;

  beforeEach(() => {
    disconnectSocketsSpy = vi
      .spyOn(io, "disconnectSockets")
      .mockImplementation(() => {});
    inSpy = vi.spyOn(io, "in").mockReturnValue({ disconnectSockets: vi.fn() });
  });

  afterEach(() => {
    disconnectSocketsSpy.mockRestore();
    inSpy.mockRestore();
  });

  it("does nothing for an unrecognized scope", () => {
    expect(() => evictRevokedSockets({ scope: "not-a-real-scope" })).not.toThrow();
    expect(disconnectSocketsSpy).not.toHaveBeenCalled();
    expect(inSpy).not.toHaveBeenCalled();
  });

  it("does nothing for scope:'user' with no userId -- refuses to guess a room to evict", () => {
    expect(() => evictRevokedSockets({ scope: "user" })).not.toThrow();
    expect(disconnectSocketsSpy).not.toHaveBeenCalled();
    expect(inSpy).not.toHaveBeenCalled();
  });
});
