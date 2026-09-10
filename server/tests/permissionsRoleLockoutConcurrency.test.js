import { beforeEach, describe, expect, it, vi } from "vitest";

// re-entrancy sweep, 2026-09-10 (god-dispatched, HIGH #3, the only one of
// the three that cannot be undone): updateRole()/deleteRole() each run
// checkLockoutRulesForCapabilityChange() (the "at least one user must
// still hold roles.manage/users.manage" invariant) BEFORE writing, with a
// real await gap between the check and the write. Two concurrent edits to
// DIFFERENT roles that both currently grant the same recovery capability
// each validate "at least one OTHER role still grants it" against
// pre-change state -- each sees the other role still granting it, both
// pass, both write, and together they zero out who can manage roles/users
// at all. services/auth.js's changeUserRoleById/deleteUser already close
// this exact class of race for the per-USER side via
// AuthService._withMutex; permissions.js's createRole/updateRole/deleteRole
// now get the same shape via withRoleMutex (services/permissions.js) --
// the whole check-then-write critical section serialized, not just the
// final write, so the SECOND caller's check runs against the FIRST
// caller's already-written state instead of stale pre-change state.
//
// Deterministic by construction, no suspend-and-release timing dance
// needed: withRoleMutex chains onto its module-level `roleMutex` promise
// SYNCHRONOUSLY at call time (before either body's first await), so
// calling updateRole(A) then updateRole(B) back-to-back without awaiting
// between them guarantees A's entire critical section completes before
// B's even starts -- same reasoning as
// server/tests/steamcmdDownloadConcurrency.test.js's own claim-is-
// synchronous argument for that guard.

const rolesById = new Map();
const usersById = new Map();

function seedRole(id, name, capabilities, isSeeded = false) {
  rolesById.set(id, { id, name, capabilities, isSeeded });
}

function seedUser(id, roleId) {
  usersById.set(id, { id, roleId });
}

const { replaceRoleById, removeRoleById } = vi.hoisted(() => ({
  replaceRoleById: vi.fn(),
  removeRoleById: vi.fn(),
}));

vi.mock("../database/init.js", () => ({
  getDb: async () => ({ data: { users: Array.from(usersById.values()) } }),
  commitNow: async () => {},
  getRoles: async () => Array.from(rolesById.values()),
  getRoleById: async (id) => rolesById.get(String(id)) || null,
  getRoleByName: async (name) =>
    Array.from(rolesById.values()).find((r) => r.name === name) || null,
  insertRole: async (role) => {
    rolesById.set(role.id, role);
    return role;
  },
  replaceRoleById,
  removeRoleById,
  // countUsersWithCapability's only other input besides getRoles() above.
  getUsersForRoleAccounting: async () => Array.from(usersById.values()),
  getUsersForRole: async (role) =>
    Array.from(usersById.values()).filter((u) => String(u.roleId) === String(role.id)),
  reassignRoleMembers: async () => 0,
}));

const { updateRole } = await import("../services/permissions.js");

beforeEach(() => {
  rolesById.clear();
  usersById.clear();
  replaceRoleById.mockReset().mockImplementation(async (id, role) => {
    rolesById.set(String(id), role);
    return role;
  });
  removeRoleById.mockReset().mockImplementation(async (id) => rolesById.delete(String(id)));
});

describe("updateRole: concurrent edits to two DIFFERENT roles that both grant roles.manage", () => {
  it("refuses the second edit instead of letting both proceed and zeroing out roles.manage", async () => {
    seedRole("role-a", "Custom A", ["roles.manage"]);
    seedRole("role-b", "Custom B", ["roles.manage"]);
    seedUser("user-a", "role-a");
    seedUser("user-b", "role-b");

    // Not awaited individually -- see file header for why calling these
    // back-to-back is deterministic under the mutex.
    const callA = updateRole("role-a", { capabilities: [] });
    const callB = updateRole("role-b", { capabilities: [] });

    const [resultA, resultB] = await Promise.allSettled([callA, callB]);

    // Exactly one must be refused -- which one depends only on call order
    // (A first), not on a race, since the mutex makes B's check run after
    // A's write has already landed.
    expect(resultA.status).toBe("fulfilled");
    expect(resultB.status).toBe("rejected");
    expect(resultB.reason).toMatchObject({ code: "ROLE_LOCKOUT_LAST_MANAGER" });

    // The actual invariant: at least one role still grants roles.manage
    // after both calls have settled.
    const stillGranting = Array.from(rolesById.values()).filter((r) =>
      r.capabilities.includes("roles.manage"),
    );
    expect(stillGranting.length).toBeGreaterThanOrEqual(1);
  });

  it("both edits succeed when they don't touch the same recovery capability (no false refusal)", async () => {
    seedRole("role-a", "Custom A", ["roles.manage", "players.view"]);
    seedRole("role-b", "Custom B", ["roles.manage"]);
    seedUser("user-a", "role-a");
    seedUser("user-b", "role-b");

    // role-a keeps roles.manage, only touches an unrelated capability --
    // must not be refused just because a concurrent edit is in flight.
    const callA = updateRole("role-a", { capabilities: ["roles.manage"] });
    const callB = updateRole("role-b", { capabilities: ["roles.manage"] });

    const [resultA, resultB] = await Promise.allSettled([callA, callB]);
    expect(resultA.status).toBe("fulfilled");
    expect(resultB.status).toBe("fulfilled");
  });
});
