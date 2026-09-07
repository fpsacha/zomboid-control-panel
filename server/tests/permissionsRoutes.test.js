import { beforeEach, describe, expect, it, vi } from "vitest";

// API surface for Angela's matrix UI: list capabilities grouped, list
// roles with capabilities, create/update/delete a role. Every route sits
// behind requirePermission("roles.manage") -- this is the matrix itself,
// not a tool the matrix grants access to.

const rolesById = new Map();
let users = [];

function seedRole(id, name, capabilities) {
  rolesById.set(id, { id, name, capabilities, isSeeded: false });
}

vi.mock("../database/init.js", () => ({
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
  // Must set .role unconditionally (no isSeeded check) -- see
  // reassignRoleMembers.test.js for why.
  reassignRoleMembers: async (fromRole, toRole) => {
    let count = 0;
    for (const u of users) {
      if (u.roleId === fromRole.id) {
        u.roleId = toRole.id;
        u.role = toRole.name;
        count++;
      }
    }
    return count;
  },
}));

const { default: router } = await import("../routes/permissions.js");
const { CAPABILITIES } = await import("../services/permissions.js");

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

// Walks the WHOLE router.stack in order, the way Express actually
// dispatches -- not just the matched route's own handler stack. A
// router.use(requirePermission(...)) gate is a separate, path-less layer
// that never appears inside any individual route's layer.route.stack, so a
// helper that only looked at the matched route would silently skip it and
// every "refuses without the capability" test would pass for the wrong
// reason (never having run the gate at all).
function collectHandlers(routePath, method) {
  const handlers = [];
  for (const entry of router.stack) {
    if (!entry.route) {
      // router.use(fn) layer with no path -- applies to every request.
      handlers.push(entry.handle);
      continue;
    }
    if (entry.route.path === routePath && entry.route.methods[method]) {
      handlers.push(...entry.route.stack.map((s) => s.handle));
    }
  }
  return handlers;
}

async function runRoute(routePath, method, req) {
  const handlers = collectHandlers(routePath, method);
  if (!handlers.length) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

const ADMIN_ROLE_ID = "role-admin";

beforeEach(() => {
  rolesById.clear();
  users = [];
  // Every capability, matching real admin (DEFAULT_ROLE_CAPABILITIES.admin =
  // every CAPABILITIES key) -- not a hardcoded handful. sweep-round5's
  // assertNoRoleEditEscalation() now refuses PUT/POST /roles from an acting
  // user who doesn't already hold whatever capability is being added to a
  // role, so a trimmed-down fixture admin would spuriously fail any test
  // that creates or edits a role with a capability the fixture happened not
  // to list, for a reason that has nothing to do with what that test means
  // to check.
  seedRole(
    ADMIN_ROLE_ID,
    "admin",
    CAPABILITIES.map((c) => c.key),
  );
  users.push({ id: "u-admin", role: "admin", roleId: ADMIN_ROLE_ID });
});

describe("router-level gate: requires roles.manage", () => {
  it("refuses a role without roles.manage", async () => {
    seedRole("role-tech", "technician", ["server.control"]);
    const res = await runRoute("/capabilities", "get", {
      user: { userId: "u2", role: "technician" },
      query: {},
      params: {},
      body: {},
    });
    expect(res.getStatusCode()).toBe(403);
  });

  it("does not refuse a role with roles.manage", async () => {
    const res = await runRoute("/capabilities", "get", {
      user: { userId: "u-admin", role: "admin" },
      query: {},
      params: {},
      body: {},
    });
    expect(res.getStatusCode()).toBe(200);
  });
});

describe("GET /capabilities", () => {
  it("returns the catalogue grouped, with the known groups present", async () => {
    const res = await runRoute("/capabilities", "get", {
      user: { userId: "u-admin", role: "admin" },
    });
    const body = res.getBody();
    expect(Array.isArray(body.groups)).toBe(true);
    const groupNames = body.groups.map((g) => g.group);
    expect(groupNames).toContain("Server Lifecycle");
    expect(groupNames).toContain("Player Authority");
    const serverGroup = body.groups.find((g) => g.group === "Server Lifecycle");
    expect(serverGroup.capabilities.map((c) => c.key)).toEqual(
      expect.arrayContaining(["server.control", "server.wipe"]),
    );
  });
});

describe("GET /roles", () => {
  it("lists roles with member counts", async () => {
    const res = await runRoute("/roles", "get", { user: { userId: "u-admin", role: "admin" } });
    const body = res.getBody();
    expect(body.roles).toHaveLength(1);
    expect(body.roles[0]).toEqual(expect.objectContaining({ name: "admin", memberCount: 1 }));
  });
});

describe("POST /roles", () => {
  it("creates a role", async () => {
    const res = await runRoute("/roles", "post", {
      user: { userId: "u-admin", role: "admin" },
      body: { name: "Event Runner", capabilities: ["players.gm_tools"] },
    });
    expect(res.getStatusCode()).toBe(201);
    expect(res.getBody().role).toEqual(
      expect.objectContaining({ name: "Event Runner", capabilities: ["players.gm_tools"] }),
    );
  });

  it("surfaces INVALID_CAPABILITY as a 400 with the named code and the offending capability as a param", async () => {
    const res = await runRoute("/roles", "post", {
      user: { userId: "u-admin", role: "admin" },
      body: { name: "Broken", capabilities: ["not.a.capability"] },
    });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe("INVALID_CAPABILITY");
    expect(res.getBody().params).toEqual({ capability: "not.a.capability" });
  });

  it("omits params for INVALID_CAPABILITY when there's no single offending value to report", async () => {
    const res = await runRoute("/roles", "post", {
      user: { userId: "u-admin", role: "admin" },
      body: { name: "Broken", capabilities: "not-an-array" },
    });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe("INVALID_CAPABILITY");
    expect(res.getBody().params).toBeUndefined();
  });
});

describe("PUT /roles/:id", () => {
  it("surfaces ROLE_LOCKOUT_LAST_MANAGER as a 409 with the named code and the stable capability key as a param", async () => {
    const res = await runRoute("/roles/:id", "put", {
      user: { userId: "u-admin", role: "admin" },
      params: { id: ADMIN_ROLE_ID },
      body: { capabilities: ["server.control"] }, // drops roles.manage and users.manage
    });
    expect(res.getStatusCode()).toBe(409);
    expect(res.getBody().code).toBe("ROLE_LOCKOUT_LAST_MANAGER");
    expect(res.getBody().params).toEqual({ action: "roles.manage" });
  });
});

describe("DELETE /roles/:id", () => {
  it("surfaces ROLE_HAS_MEMBERS as a 409 with the named code and the member count as a param", async () => {
    const res = await runRoute("/roles/:id", "delete", {
      user: { userId: "u-admin", role: "admin" },
      params: { id: ADMIN_ROLE_ID },
      query: {},
    });
    expect(res.getStatusCode()).toBe(409);
    expect(res.getBody().code).toBe("ROLE_HAS_MEMBERS");
    expect(res.getBody().params).toEqual({ count: expect.any(Number) });
  });

  // docs/qa/kevin-access-control-french-usability.md Finding 1: a seeded
  // role used to be deletable via this exact route (no isSeeded check
  // anywhere in the stack) as long as it had zero members. Confirms the
  // service-level refusal actually reaches an HTTP caller as a 403 with
  // the named code, not just that deleteRole() itself throws.
  it("surfaces ROLE_IS_SEEDED as a 403 for a seeded role with ZERO members -- the exact gap that was reachable before this fix", async () => {
    const seededId = "role-seeded-technician";
    seedRole(seededId, "technician", ["server.control"]);
    rolesById.get(seededId).isSeeded = true; // seedRole() always sets false; flip it for this one role
    // No users hold it -- this was the reachable case: ROLE_HAS_MEMBERS
    // never fired, so nothing else stood between the request and deletion.

    const res = await runRoute("/roles/:id", "delete", {
      user: { userId: "u-admin", role: "admin" },
      params: { id: seededId },
      query: {},
    });

    expect(res.getStatusCode()).toBe(403);
    expect(res.getBody().code).toBe("ROLE_IS_SEEDED");
    expect(rolesById.has(seededId)).toBe(true); // untouched
  });
});
