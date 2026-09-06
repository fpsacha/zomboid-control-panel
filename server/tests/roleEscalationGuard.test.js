import { beforeEach, describe, expect, it, vi } from "vitest";

// sweep-round2 (2026-09-06, dwight): auth.js:507 (POST /users) and auth.js:544
// (PATCH /users/:id/role) are both gated requirePermission("users.manage"),
// but neither the routes nor authService.createUser()/changeUserRoleById()
// underneath them restricted WHICH role could be granted relative to the
// caller's own privileges. A caller whose role holds users.manage but not
// roles.manage/admin could, in one API call, PATCH their own account (or a
// brand-new POST /users account) straight to admin -- self-service
// escalation with zero admin cooperation, worse than the already-fixed
// recovery-codes bug (auth.js:700-722) it precedent-matches: one call, not
// two, no plaintext-codes side channel a real admin might notice.
//
// This codebase already enforces the exact same "you cannot hand out an
// authority you do not hold yourself" rule for a SECONDARY door
// (DISCORD_PERMISSIONS_CAPABILITY_REQUIRED, routes/discord.js's PUT
// /permissions) -- role assignment is the PRIMARY door for that same
// authority and had no such rule at all. Fix: assertNoCapabilityEscalation
// (services/auth.js) refuses creating/reassigning a user into any role
// whose capabilities aren't a subset of the caller's own, per-capability,
// not special-cased to roles.manage/users.manage the way the existing
// last-manager lockout guard is. Plus an unconditional self-role-change
// refusal (USER_SELF_ROLE_CHANGE_REFUSED), closing the asymmetry with
// deleteUser's own pre-existing self-delete refusal.
//
// The new ErrorCode values (ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES,
// USER_SELF_ROLE_CHANGE_REFUSED) are deliberately NOT YET registered in
// errorCodes.js/the 9 locales' errors.json as of this commit -- god's
// instruction was to ship the guard now and leave client-facing
// registration as a follow-up once client/src/locales/ is free of another
// agent's concurrent work. The server-side behavior (throw, correct code
// string, correct status, correct params) is fully real and tested here
// regardless of that.

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

const { default: authService } = await import("../services/auth.js");

const ADMIN_ROLE = {
  id: "role-admin",
  name: "admin",
  capabilities: ["users.manage", "roles.manage", "server.control", "rcon.execute"],
  isSeeded: true,
};
const TECHNICIAN_ROLE = {
  id: "role-technician",
  name: "technician",
  capabilities: ["server.control", "rcon.execute"],
  isSeeded: true,
};
const MODERATOR_ROLE = {
  id: "role-moderator",
  name: "moderator",
  capabilities: ["players.moderate"],
  isSeeded: true,
};
// The vulnerable shape: an operator-built custom role that legitimately
// needs to manage accounts (users.manage) but was never meant to be
// admin-equivalent -- exactly the "Support" example from the fix's own
// design discussion. Also holds players.moderate so it can demonstrate the
// POSITIVE case (assigning a role it genuinely IS a superset of).
const SUPPORT_ROLE = {
  id: "role-support",
  name: "support",
  capabilities: ["users.manage", "players.moderate"],
};

function resetWith({ roles = [], users = [] }) {
  settings.clear();
  db.data.roles = roles.map((r) => ({ ...r }));
  db.data.users = users.map((u) => ({ ...u }));
}

describe("createUser() -- refuses creating a user in a role that exceeds the caller's own capabilities", () => {
  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE, TECHNICIAN_ROLE, MODERATOR_ROLE, SUPPORT_ROLE],
      users: [
        { id: "u-admin", username: "realadmin", role: "admin", roleId: "role-admin" },
        { id: "u-support", username: "support1", role: "support", roleId: "role-support" },
      ],
    });
  });

  it("refuses a users.manage-only (support) caller minting a brand-new ADMIN account -- the exploit this closes", async () => {
    await expect(
      authService.createUser("newadmin", "password123", "admin", {
        actingUserId: "u-support",
      }),
    ).rejects.toMatchObject({
      code: "ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES",
      status: 403,
    });
    expect(db.data.users.find((u) => u.username === "newadmin")).toBeUndefined();
  });

  it("allows a users.manage-only (support) caller creating a MODERATOR account -- support's own capabilities are a superset of moderator's, so this is the delegation feature working as intended", async () => {
    const user = await authService.createUser("newmod", "password123", "moderator", {
      actingUserId: "u-support",
    });
    expect(user.role).toBe("moderator");
    expect(db.data.users.find((u) => u.username === "newmod")).toBeTruthy();
  });

  it("allows a real admin caller minting a new admin account -- the fix does not regress the legitimate case", async () => {
    const user = await authService.createUser("newadmin2", "password123", "admin", {
      actingUserId: "u-admin",
    });
    expect(user.role).toBe("admin");
  });
});

describe("changeUserRoleById() -- self-change refusal and escalation guard", () => {
  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE, TECHNICIAN_ROLE, MODERATOR_ROLE, SUPPORT_ROLE],
      users: [
        { id: "u-admin", username: "realadmin", role: "admin", roleId: "role-admin" },
        { id: "u-support", username: "support1", role: "support", roleId: "role-support" },
        { id: "u-target", username: "target", role: "technician", roleId: "role-technician" },
      ],
    });
  });

  it("refuses a caller changing their OWN role, even a real admin -- closes the asymmetry with deleteUser's existing self-delete refusal", async () => {
    await expect(
      authService.changeUserRoleById("u-admin", "role-technician", {
        actingUserId: "u-admin",
      }),
    ).rejects.toMatchObject({
      code: "USER_SELF_ROLE_CHANGE_REFUSED",
      status: 400,
    });
    // Refused before any DB mutation -- the target user's row is untouched.
    expect(db.data.users.find((u) => u.id === "u-admin").role).toBe("admin");
  });

  it("refuses a users.manage-only (support) caller promoting a DIFFERENT user to admin -- the exploit this closes", async () => {
    await expect(
      authService.changeUserRoleById("u-target", "role-admin", {
        actingUserId: "u-support",
      }),
    ).rejects.toMatchObject({
      code: "ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES",
      status: 403,
    });
    expect(db.data.users.find((u) => u.id === "u-target").role).toBe("technician");
  });

  it("allows a users.manage-only (support) caller reassigning a DIFFERENT user to MODERATOR -- a subset of support's own capabilities", async () => {
    const user = await authService.changeUserRoleById("u-target", "role-moderator", {
      actingUserId: "u-support",
    });
    expect(user.role).toBe("moderator");
  });

  it("allows a real admin caller promoting a different user to admin -- the fix does not regress the legitimate case", async () => {
    const user = await authService.changeUserRoleById("u-target", "role-admin", {
      actingUserId: "u-admin",
    });
    expect(user.role).toBe("admin");
  });

  it("callers with no actingUserId at all (internal/legacy callers) are unaffected -- no caller context means no escalation check to run", async () => {
    const user = await authService.changeUserRoleById("u-target", "role-admin");
    expect(user.role).toBe("admin");
  });
});

describe("changeUserRole() (legacy fixed-name wrapper) threads actingUserId through to changeUserRoleById", () => {
  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE, TECHNICIAN_ROLE, MODERATOR_ROLE, SUPPORT_ROLE],
      users: [
        { id: "u-support", username: "support1", role: "support", roleId: "role-support" },
        { id: "u-target", username: "target", role: "technician", roleId: "role-technician" },
      ],
    });
  });

  it("refuses the same escalation via the legacy role-NAME path, not just the roleId path", async () => {
    await expect(
      authService.changeUserRole("u-target", "admin", { actingUserId: "u-support" }),
    ).rejects.toMatchObject({
      code: "ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES",
      status: 403,
    });
  });
});
