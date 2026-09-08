import { describe, expect, it, vi } from "vitest";

// 2026-08-27 bug hunt: server/index.js's Socket.IO connection middleware
// only checked that a connection was AUTHENTICATED, never that it held any
// particular capability. socket.on("subscribe:logs"), subscribe:perf, and
// subscribe:players joined rooms carrying the exact same data as
// GET /api/debug/logs, POST /api/debug/performance-snapshot, and
// GET /api/players/ -- all three gated behind diagnostics.manage /
// players.view over HTTP -- with no equivalent check on the socket side.
// Concretely exploitable: MODERATOR_CAPABILITIES does not include
// diagnostics.manage, so a moderator refused GET /api/debug/logs over HTTP
// could get the identical live log stream (including RCON command text)
// by connecting a socket instead. socketHasCapability() is the fix, mirroring
// requirePermission()'s own getRoleByName(role) -> role.capabilities check.
// This file pins that mirror, independent of the real database.

const { getRoleByNameMock } = vi.hoisted(() => ({
  getRoleByNameMock: vi.fn(),
}));

vi.mock("../database/init.js", () => ({
  getRoleByName: getRoleByNameMock,
  // socketHasCapability doesn't touch these, but other module-load-time
  // code in index.js may -- keep the mock module shape harmless rather
  // than undefined.
  getDb: vi.fn(async () => ({ data: {} })),
  // index.js's own boot sequence wires this into lifecycleCoordinator.js's
  // setServerDisplayNameResolver() unconditionally at module scope --
  // referencing it here even without calling it is enough to throw against
  // an incomplete mock.
  peekServerDisplayName: vi.fn(() => null),
}));

const { socketHasCapability } = await import("../index.js");

describe("socketHasCapability() -- Socket.IO's capability gate for subscribe:* rooms", () => {
  it("returns false with no socket.user at all (unauthenticated / pre-setup connection)", async () => {
    getRoleByNameMock.mockClear();
    const result = await socketHasCapability({}, "diagnostics.manage");
    expect(result).toBe(false);
    expect(getRoleByNameMock).not.toHaveBeenCalled();
  });

  it("returns true when the socket's role holds the capability", async () => {
    getRoleByNameMock.mockResolvedValueOnce({
      name: "technician",
      capabilities: ["diagnostics.manage", "server.control"],
    });
    const socket = { user: { role: "technician" } };
    expect(await socketHasCapability(socket, "diagnostics.manage")).toBe(true);
    expect(getRoleByNameMock).toHaveBeenCalledWith("technician");
  });

  it("returns false when the socket's role exists but lacks the capability -- the moderator/diagnostics.manage case that was exploitable", async () => {
    getRoleByNameMock.mockResolvedValueOnce({
      name: "moderator",
      capabilities: ["players.moderate", "players.gm_tools", "players.view", "server.world_events"],
    });
    const socket = { user: { role: "moderator" } };
    expect(await socketHasCapability(socket, "diagnostics.manage")).toBe(false);
  });

  it("returns false when the role cannot be resolved (renamed/deleted role, or DB lookup returns null) -- fails closed, not open", async () => {
    getRoleByNameMock.mockResolvedValueOnce(null);
    const socket = { user: { role: "some-deleted-role" } };
    expect(await socketHasCapability(socket, "diagnostics.manage")).toBe(false);
  });

  it("returns false, not a thrown error, when the role lookup itself throws", async () => {
    getRoleByNameMock.mockRejectedValueOnce(new Error("db unavailable"));
    const socket = { user: { role: "admin" } };
    await expect(socketHasCapability(socket, "diagnostics.manage")).resolves.toBe(false);
  });

  it("the auth-disabled sentinel role (admin, authDisabled:true) resolves like any other admin socket", async () => {
    getRoleByNameMock.mockResolvedValueOnce({
      name: "admin",
      capabilities: ["diagnostics.manage", "players.view", "server.control"],
    });
    const socket = {
      user: { userId: null, username: null, role: "admin", tokenGen: null, authDisabled: true },
    };
    expect(await socketHasCapability(socket, "diagnostics.manage")).toBe(true);
  });
});
