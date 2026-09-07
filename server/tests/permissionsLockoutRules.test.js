import { beforeEach, describe, expect, it, vi } from "vitest";

// Lockout rules 1-3 (rule 4 is the migration itself, covered by
// rolesMigration.test.js). Rule 1 is a CAPABILITY check, not a role-name
// check -- these tests exercise it against roles.manage/users.manage
// directly, including via a second role that also grants the capability,
// to prove it isn't hardcoded to the name "admin".

const rolesById = new Map();
let users = [];

function seedRole(id, name, capabilities) {
  rolesById.set(id, { id, name, capabilities, isSeeded: false });
}

// Distinct from seedRole() above (which, confusingly, always creates a
// NON-seeded role -- it's named for "seeding test data", not "isSeeded").
// This one actually sets isSeeded: true, for the Rule 0 tests below.
function seedBuiltinRole(id, name, capabilities) {
  rolesById.set(id, { id, name, capabilities, isSeeded: true });
}

vi.mock("../database/init.js", () => ({
  getDb: async () => ({ data: { users } }),
  commitNow: async () => {},
  getRoles: async () => Array.from(rolesById.values()),
  getRoleById: async (id) => rolesById.get(String(id)) || null,
  getRoleByName: async (name) =>
    Array.from(rolesById.values()).find((r) => r.name === name) || null,
  insertRole: async (role) => {
    rolesById.set(role.id, role);
    return role;
  },
  replaceRoleById: async (id, role) => {
    rolesById.set(String(id), role);
    return role;
  },
  removeRoleById: async (id) => rolesById.delete(String(id)),
  getUsersForRole: async (role) =>
    users.filter((u) => u.roleId === role.id || (role.isSeeded && u.role === role.name)),
  getUsersForRoleAccounting: async () => users,
  // Mirrors database/init.js's real reassignRoleMembers -- must set .role
  // unconditionally (no isSeeded check), see reassignRoleMembers.test.js
  // for why: requirePermission() resolves capabilities via
  // getRoleByName(req.user.role), so a stale .role after reassigning to a
  // custom role kept authorizing the user against their old one forever.
  reassignRoleMembers: async (fromRole, toRole) => {
    let count = 0;
    for (const u of users) {
      if (u.roleId === fromRole.id || (fromRole.isSeeded && u.role === fromRole.name)) {
        u.roleId = toRole.id;
        u.role = toRole.name;
        count++;
      }
    }
    return count;
  },
}));

const { createRole, updateRole, deleteRole } = await import("../services/permissions.js");

beforeEach(() => {
  rolesById.clear();
  users = [];
});

describe("createRole", () => {
  it("rejects a missing name", async () => {
    await expect(createRole({ capabilities: [] })).rejects.toThrow(/name/i);
  });

  it("rejects an unknown capability key", async () => {
    await expect(
      createRole({ name: "Custom", capabilities: ["not.a.real.capability"] }),
    ).rejects.toMatchObject({ code: "INVALID_CAPABILITY" });
  });

  it("rejects a duplicate name", async () => {
    seedRole("role-a", "Custom", ["players.view"]);
    await expect(
      createRole({ name: "Custom", capabilities: ["players.view"] }),
    ).rejects.toMatchObject({ code: "ROLE_NAME_TAKEN" });
  });

  it("creates a role with deduplicated capabilities", async () => {
    const role = await createRole({
      name: "Event Runner",
      capabilities: ["players.gm_tools", "players.gm_tools", "players.view"],
    });
    expect(role.capabilities.slice().sort()).toEqual(["players.gm_tools", "players.view"]);
    expect(role.isSeeded).toBe(false);
  });
});

describe("updateRole -- lockout rule 1 (hard block, capability check not role-name check)", () => {
  it("refuses removing roles.manage from the ONLY role that grants it", async () => {
    seedRole("role-admin", "admin", ["roles.manage", "users.manage", "server.control"]);
    users = [{ id: "u1", role: "admin", roleId: "role-admin" }];

    await expect(
      updateRole("role-admin", { capabilities: ["users.manage", "server.control"] }),
    ).rejects.toMatchObject({ code: "ROLE_LOCKOUT_LAST_MANAGER" });
  });

  it("refuses removing users.manage from the only role that grants it, even when roles.manage is untouched", async () => {
    seedRole("role-admin", "admin", ["roles.manage", "users.manage"]);
    users = [{ id: "u1", role: "admin", roleId: "role-admin" }];

    await expect(
      updateRole("role-admin", { capabilities: ["roles.manage"] }),
    ).rejects.toMatchObject({ code: "ROLE_LOCKOUT_LAST_MANAGER" });
  });

  it("allows the change once ANOTHER role also grants the capability -- not hardcoded to the name 'admin'", async () => {
    seedRole("role-admin", "admin", ["roles.manage", "users.manage"]);
    seedRole("role-super", "superuser", ["roles.manage", "users.manage"]);
    users = [
      { id: "u1", role: "admin", roleId: "role-admin" },
      { id: "u2", role: "superuser", roleId: "role-super" },
    ];

    const updated = await updateRole("role-admin", { capabilities: ["users.manage"] });
    expect(updated.capabilities).toEqual(["users.manage"]);
  });
});

describe("updateRole -- lockout rule 2 (soft block: acting user losing their own recovery capability)", () => {
  it("refuses without confirmSelfCapabilityLoss when the acting user is a member of the role being stripped, even though another role still grants it", async () => {
    seedRole("role-admin", "admin", ["roles.manage", "users.manage"]);
    seedRole("role-super", "superuser", ["roles.manage", "users.manage"]);
    users = [
      { id: "u1", role: "admin", roleId: "role-admin" },
      { id: "u2", role: "superuser", roleId: "role-super" },
    ];

    await expect(
      updateRole(
        "role-admin",
        { capabilities: ["users.manage"] },
        { actingUser: { userId: "u1", role: "admin" } },
      ),
    ).rejects.toMatchObject({ code: "ROLE_SELF_CAPABILITY_LOSS_CONFIRM" });
  });

  it("succeeds with confirmSelfCapabilityLoss: true", async () => {
    seedRole("role-admin", "admin", ["roles.manage", "users.manage"]);
    seedRole("role-super", "superuser", ["roles.manage", "users.manage"]);
    users = [
      { id: "u1", role: "admin", roleId: "role-admin" },
      { id: "u2", role: "superuser", roleId: "role-super" },
    ];

    const updated = await updateRole(
      "role-admin",
      { capabilities: ["users.manage"] },
      { actingUser: { userId: "u1", role: "admin" }, confirmSelfCapabilityLoss: true },
    );
    expect(updated.capabilities).toEqual(["users.manage"]);
  });

  it("does NOT require confirmation when the acting user belongs to a DIFFERENT role than the one being edited", async () => {
    seedRole("role-admin", "admin", ["roles.manage", "users.manage"]);
    seedRole("role-super", "superuser", ["roles.manage", "users.manage"]);
    users = [
      { id: "u1", role: "admin", roleId: "role-admin" },
      { id: "u2", role: "superuser", roleId: "role-super" },
    ];

    // Acting as the superuser, editing the admin role -- not self-affecting.
    const updated = await updateRole(
      "role-admin",
      { capabilities: ["users.manage"] },
      { actingUser: { userId: "u2", role: "superuser" } },
    );
    expect(updated.capabilities).toEqual(["users.manage"]);
  });
});

// sweep-round5 (2026-09-07): assertNoRoleEditEscalation(). Mirrors
// roleEscalationGuard.test.js's coverage of services/auth.js's
// assertNoCapabilityEscalation() (ff17ee11), but for the OTHER path into
// the same hole -- editing a role's OWN capabilities array directly,
// rather than assigning a user to a different role. Before this guard,
// a caller holding only roles.manage (no users.manage, no anything else)
// could PUT /roles/:id their own role and add every capability in the
// catalogue; requirePermission() re-resolves capabilities fresh from the
// DB every request, so their very next call was granted under the
// expanded list. Neither assertNoCapabilityEscalation() nor
// changeUserRoleById's self-role-change refusal ever runs on this path --
// no user record is touched, only the role's own definition.
describe("createRole / updateRole -- capability-escalation guard (assertNoRoleEditEscalation)", () => {
  it("PRE-FIX BREAK-VERIFY SHAPE: a caller holding only roles.manage cannot add users.manage to their OWN role -- the exact self-escalation this guard closes", async () => {
    seedRole("role-limited", "Limited Roles Editor", ["roles.manage"]);
    users = [{ id: "u1", role: "Limited Roles Editor", roleId: "role-limited" }];

    await expect(
      updateRole(
        "role-limited",
        { capabilities: ["roles.manage", "users.manage"] },
        { actingUser: { userId: "u1", role: "Limited Roles Editor" } },
      ),
    ).rejects.toMatchObject({
      code: "ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES",
      params: { detail: "users.manage", missing: ["users.manage"] },
    });
    // Untouched -- the refusal must be BEFORE any write, not a rollback.
    expect(rolesById.get("role-limited").capabilities).toEqual(["roles.manage"]);
  });

  it("also refuses granting an unheld capability to a DIFFERENT role, not just the acting user's own -- this is not a self-edit-only check", async () => {
    seedRole("role-limited", "Limited Roles Editor", ["roles.manage"]);
    seedRole("role-target", "Target", ["players.view"]);
    users = [{ id: "u1", role: "Limited Roles Editor", roleId: "role-limited" }];

    await expect(
      updateRole(
        "role-target",
        { capabilities: ["players.view", "server.control"] },
        { actingUser: { userId: "u1", role: "Limited Roles Editor" } },
      ),
    ).rejects.toMatchObject({ code: "ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES" });
  });

  it("createRole refuses a brand-new role granting a capability the caller doesn't hold", async () => {
    seedRole("role-limited", "Limited Roles Editor", ["roles.manage"]);

    await expect(
      createRole(
        { name: "New Role", capabilities: ["roles.manage", "diagnostics.manage"] },
        { actingUser: { userId: "u1", role: "Limited Roles Editor" } },
      ),
    ).rejects.toMatchObject({
      code: "ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES",
      params: { detail: "diagnostics.manage" },
    });
  });

  it("allows granting a capability that IS within the acting user's own reach", async () => {
    seedRole("role-limited", "Limited Roles Editor", ["roles.manage", "server.control"]);
    users = [{ id: "u1", role: "Limited Roles Editor", roleId: "role-limited" }];

    const updated = await updateRole(
      "role-limited",
      { capabilities: ["roles.manage", "server.control"] },
      { actingUser: { userId: "u1", role: "Limited Roles Editor" } },
    );
    expect(updated.capabilities.slice().sort()).toEqual(["roles.manage", "server.control"]);
  });

  it("is a DELTA check, not a full-list check: leaves a role's PRE-EXISTING over-reach (capabilities the acting user never held) untouched when the edit doesn't add anything new", async () => {
    // A role wider than the acting user's own reach, created by someone
    // else (an admin) before this edit -- e.g. technician, which holds
    // rcon.execute that "Limited Roles Editor" never held.
    seedRole("role-tech", "technician", ["server.control", "rcon.execute"]);
    seedRole("role-limited", "Limited Roles Editor", ["roles.manage", "server.control"]);
    users = [{ id: "u1", role: "Limited Roles Editor", roleId: "role-limited" }];

    // Renaming it, or leaving capabilities exactly as they were, must stay
    // legal -- this edit adds nothing beyond what the role already granted.
    const updated = await updateRole(
      "role-tech",
      { capabilities: ["server.control", "rcon.execute"] },
      { actingUser: { userId: "u1", role: "Limited Roles Editor" } },
    );
    expect(updated.capabilities.slice().sort()).toEqual(["rcon.execute", "server.control"]);
  });

  it("skips the check entirely with no actingUser -- internal/bootstrap callers are not this guard's job", async () => {
    seedRole("role-empty", "Empty", []);
    const updated = await updateRole("role-empty", {
      capabilities: ["roles.manage", "users.manage", "server.control"],
    });
    expect(updated.capabilities.slice().sort()).toEqual([
      "roles.manage",
      "server.control",
      "users.manage",
    ]);
  });
});

// docs/qa/kevin-access-control-french-usability.md Finding 1: deleteRole()
// used to have no isSeeded check at all -- a seeded role with zero current
// members could be deleted outright via a direct call/API request, even
// though RolesPermissions.tsx's delete button is disabled for isSeeded
// roles. "Test both directions" per god's own framing: a seeded role must
// be refused regardless of members, AND a custom role must still delete
// normally -- the second is what proves this isn't a fix that just passes
// by refusing everything.
describe("deleteRole -- rule 0 (seeded roles can never be deleted, independent of member count)", () => {
  it("refuses a seeded role with ZERO members -- the exact gap that was reachable before this fix", async () => {
    seedBuiltinRole("role-admin", "admin", ["roles.manage", "users.manage"]);
    users = []; // no members at all

    await expect(deleteRole("role-admin")).rejects.toMatchObject({
      code: "ROLE_IS_SEEDED",
      status: 403,
    });
    expect(rolesById.has("role-admin")).toBe(true); // untouched
  });

  it("refuses a seeded role WITH members too, and the code says isSeeded, not has-members", async () => {
    seedBuiltinRole("role-tech", "technician", ["server.control"]);
    users = [{ id: "u1", role: "technician", roleId: "role-tech" }];

    await expect(deleteRole("role-tech")).rejects.toMatchObject({
      code: "ROLE_IS_SEEDED",
    });
  });

  it("refuses even with a valid reassignTo given -- seeded status is checked before member/reassignment logic runs at all", async () => {
    seedBuiltinRole("role-mod", "moderator", ["players.moderate"]);
    seedRole("role-custom", "Custom", ["players.view"]);
    users = [{ id: "u1", role: "moderator", roleId: "role-mod" }];

    await expect(
      deleteRole("role-mod", { reassignTo: "role-custom" }),
    ).rejects.toMatchObject({ code: "ROLE_IS_SEEDED" });
    expect(users[0].roleId).toBe("role-mod"); // never reassigned
  });

  it("a CUSTOM role with zero members still deletes normally -- the fix does not overreach", async () => {
    seedRole("role-empty-custom", "Empty Custom", ["players.view"]);

    const result = await deleteRole("role-empty-custom");

    expect(result.deleted).toBe(true);
    expect(rolesById.has("role-empty-custom")).toBe(false);
  });
});

describe("deleteRole -- lockout rule 3 (must not orphan members)", () => {
  it("refuses to delete a role with members and no reassignTo", async () => {
    seedRole("role-custom", "Custom", ["players.view"]);
    users = [{ id: "u1", role: "Custom", roleId: "role-custom" }];

    await expect(deleteRole("role-custom")).rejects.toMatchObject({ code: "ROLE_HAS_MEMBERS" });
  });

  it("deletes and reassigns members when reassignTo is given", async () => {
    seedRole("role-custom", "Custom", ["players.view"]);
    seedRole("role-tech", "technician", ["server.control"]);
    users = [{ id: "u1", role: "Custom", roleId: "role-custom" }];

    const result = await deleteRole("role-custom", { reassignTo: "role-tech" });

    expect(result).toEqual({ deleted: true, reassigned: 1, reassignedTo: "role-tech" });
    expect(users[0].roleId).toBe("role-tech");
    expect(users[0].role).toBe("technician");
    expect(rolesById.has("role-custom")).toBe(false);
  });

  it("updates user.role to the target's name when reassignTo is ANOTHER CUSTOM role -- the branch the isSeeded-only bug lived in", async () => {
    seedRole("role-old", "Old Custom", ["players.view"]);
    seedRole("role-new", "New Custom", ["players.view", "players.gm_tools"]);
    users = [{ id: "u1", role: "Old Custom", roleId: "role-old" }];

    await deleteRole("role-old", { reassignTo: "role-new" });

    expect(users[0]).toEqual(
      expect.objectContaining({ roleId: "role-new", role: "New Custom" }),
    );
  });

  it("deletes with no members and no reassignTo needed", async () => {
    seedRole("role-empty", "Empty", ["players.view"]);
    const result = await deleteRole("role-empty");
    expect(result.deleted).toBe(true);
    expect(rolesById.has("role-empty")).toBe(false);
  });

  it("still enforces rule 1 on delete: refuses deleting the only role granting roles.manage, even with reassignTo pointing at a role that doesn't grant it", async () => {
    seedRole("role-admin", "admin", ["roles.manage", "users.manage"]);
    seedRole("role-tech", "technician", ["server.control"]);
    users = [{ id: "u1", role: "admin", roleId: "role-admin" }];

    await expect(deleteRole("role-admin", { reassignTo: "role-tech" })).rejects.toMatchObject({
      code: "ROLE_LOCKOUT_LAST_MANAGER",
    });
  });

  it("404s for a role that does not exist", async () => {
    await expect(deleteRole("role-nonexistent")).rejects.toMatchObject({
      code: "ROLE_NOT_FOUND",
    });
  });
});

// A role's .name is also the exact string every current member's user.role
// field stores -- requirePermission() resolves capabilities via
// getRoleByName(req.user.role), a plain name match, not roleId (same
// constraint reassignRoleMembers already has to honor above). Renaming a
// role without fixing up its members desyncs that string from the row that
// now defines their capabilities: getRoleByName(oldName) finds nothing, and
// every member fails every requirePermission check on their very next
// request -- for a seeded role, that is every admin/technician/moderator on
// the panel at once, and it bypasses rules 1/2 entirely since neither one
// fires on a name-only change.
describe("updateRole -- renaming a role", () => {
  it("refuses to rename a seeded role, even with no capability change", async () => {
    seedBuiltinRole("role-admin", "admin", ["roles.manage", "users.manage"]);
    users = [{ id: "u1", role: "admin", roleId: "role-admin" }];

    await expect(
      updateRole("role-admin", { name: "Administrator" }),
    ).rejects.toThrow(/renamed/i);
    expect(rolesById.get("role-admin").name).toBe("admin"); // untouched
    expect(users[0].role).toBe("admin"); // untouched
  });

  it("refuses to rename a seeded role even when capabilities are unchanged in the same request", async () => {
    seedBuiltinRole("role-mod", "moderator", ["players.moderate"]);

    await expect(
      updateRole("role-mod", { name: "Moderator+", capabilities: ["players.moderate"] }),
    ).rejects.toThrow(/renamed/i);
  });

  it("renames a custom role and propagates the new name to every current member", async () => {
    seedRole("role-custom", "Old Name", ["players.view"]);
    users = [
      { id: "u1", role: "Old Name", roleId: "role-custom" },
      { id: "u2", role: "Old Name", roleId: "role-custom" },
    ];

    const result = await updateRole("role-custom", { name: "New Name" });

    expect(result.name).toBe("New Name");
    expect(users[0].role).toBe("New Name");
    expect(users[1].role).toBe("New Name");
  });

  it("does not touch an unrelated role's members when renaming", async () => {
    seedRole("role-a", "Role A", ["players.view"]);
    seedRole("role-b", "Role B", ["players.view"]);
    users = [
      { id: "u1", role: "Role A", roleId: "role-a" },
      { id: "u2", role: "Role B", roleId: "role-b" },
    ];

    await updateRole("role-a", { name: "Role A Renamed" });

    expect(users[0].role).toBe("Role A Renamed");
    expect(users[1].role).toBe("Role B"); // untouched
  });

  it("leaves members alone when the request does not actually change the name", async () => {
    seedRole("role-custom", "Same Name", ["players.view"]);
    users = [{ id: "u1", role: "Same Name", roleId: "role-custom" }];

    await updateRole("role-custom", { name: "Same Name", capabilities: ["players.view", "players.gm_tools"] });

    expect(users[0].role).toBe("Same Name");
  });
});
