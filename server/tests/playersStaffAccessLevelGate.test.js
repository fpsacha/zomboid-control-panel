import { beforeEach, describe, expect, it, vi } from "vitest";

// SECURITY (2026-10-28, audit R2-5): POST /players/access-level used to need
// players.moderate alone, which the built-in Moderator role holds. Over RCON,
// PZ's GameServer.changeRole skips its own "can't grant above your rank"
// check, so a Moderator could make any in-game account -- their own included
// -- an in-game admin, and from game chat run /quit, /changeoption (Mods=,
// WorkshopItems=, Password...), /reloadlua and targeted /createhorde, past
// every panel gate on those. A staff level (or changing an account that holds
// one) now also needs rcon.execute.

const getActiveServer = vi.fn();
const getRoleByName = vi.fn();
const listServerRoleNames = vi.fn();
const listWhitelistAccounts = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getRoleByName,
  logPlayerAction: vi.fn(),
  getPlayerLogs: vi.fn(),
  getPlayerNotes: vi.fn(),
  getPlayerNote: vi.fn(),
  upsertPlayerNote: vi.fn(),
  deletePlayerNote: vi.fn(),
  getPlayerStats: vi.fn(),
  getPlayerStat: vi.fn(),
  getSteamIdBans: vi.fn(),
  addSteamIdBan: vi.fn(),
  removeSteamIdBan: vi.fn(),
}));

vi.mock("../utils/whitelistDb.js", () => ({ listWhitelistAccounts, listServerRoleNames }));
vi.mock("../services/panelBridge.js", () => ({ default: { isRunning: false } }));

const { default: router, isStaffAccessLevel } = await import("../routes/players.js");

const ROLES = {
  moderator: { name: "moderator", capabilities: ["players.moderate", "players.gm_tools", "players.view"] },
  technician: { name: "technician", capabilities: ["players.moderate", "rcon.execute"] },
};

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack.at(-1).handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function post(body, role = "moderator") {
  const setAccessLevel = vi.fn().mockResolvedValue({ success: true });
  const response = createResponse();
  await getHandler("/access-level", "post")(
    {
      body,
      user: role ? { username: `${role}-user`, role } : undefined,
      app: { get: () => ({ setAccessLevel }) },
    },
    response,
  );
  return { setAccessLevel, response, payload: response.json.mock.calls[0]?.[0] };
}

const localServer = { id: "s1", serverName: "DoomerZ", zomboidDataPath: "/zomboid", isRemote: false };
const BUILTIN_NAMES = ["banned", "user", "priority", "observer", "gm", "moderator", "admin"];

function localTable({ extraRoles = [], capabilities = new Map(), accounts = [] } = {}) {
  getActiveServer.mockResolvedValue(localServer);
  listServerRoleNames.mockResolvedValue({
    available: true,
    roleNames: [...BUILTIN_NAMES, ...extraRoles],
    roleCapabilities: capabilities,
  });
  listWhitelistAccounts.mockResolvedValue({ available: true, accounts });
}

function expectRefused({ setAccessLevel, response, payload }) {
  expect(setAccessLevel).not.toHaveBeenCalled();
  expect(response.status).toHaveBeenCalledWith(403);
  expect(payload.code).toBe("PLAYERS_STAFF_ACCESS_LEVEL_NEEDS_RCON");
}

beforeEach(() => {
  getActiveServer.mockReset();
  listServerRoleNames.mockReset();
  listWhitelistAccounts.mockReset();
  getRoleByName.mockReset();
  getRoleByName.mockImplementation(async (name) => ROLES[name] || null);
});

describe("POST /players/access-level: staff levels need rcon.execute", () => {
  it("refuses a Moderator granting admin to its own fresh account on a local server", async () => {
    localTable({ accounts: [{ username: "mod2", role: "user" }] });
    expectRefused(await post({ username: "mod2", level: "admin" }));
  });

  it("refuses moderator, gm and observer too, which carry console commands, cheats and targeted events", async () => {
    for (const level of ["moderator", "gm", "observer"]) {
      localTable({ accounts: [{ username: "Bob", role: "user" }] });
      expectRefused(await post({ username: "Bob", level }));
    }
  });

  it("refuses staff levels on a remote server, where the role table can't be read", async () => {
    getActiveServer.mockResolvedValue({ ...localServer, isRemote: true });
    for (const level of ["admin", "moderator", "gm", "observer"]) {
      expectRefused(await post({ username: "Bob", level }));
    }
    expect(listWhitelistAccounts).not.toHaveBeenCalled();
  });

  it("still lets a Moderator set the plain levels", async () => {
    for (const level of ["user", "priority", "banned", "none"]) {
      localTable({ accounts: [{ username: "Bob", role: "user" }] });
      const { setAccessLevel, response } = await post({ username: "Bob", level });
      expect(response.status).not.toHaveBeenCalledWith(403);
      expect(setAccessLevel).toHaveBeenCalledWith("Bob", level);
    }
  });

  it("lets a Moderator grant a custom role that only carries login rights", async () => {
    localTable({
      extraRoles: ["VIP"],
      capabilities: new Map([["VIP", ["LoginOnServer", "PriorityLogin", "CantBeKickedIfTooLaggy"]]]),
    });
    const { setAccessLevel } = await post({ username: "Bob", level: "VIP" });
    expect(setAccessLevel).toHaveBeenCalledWith("Bob", "VIP");
  });

  it("refuses a custom role with more than login rights", async () => {
    localTable({
      extraRoles: ["Helper"],
      capabilities: new Map([["Helper", ["LoginOnServer", "AddItem"]]]),
    });
    expectRefused(await post({ username: "Bob", level: "Helper" }));
  });

  it("refuses a custom role when the server's capability table can't be read", async () => {
    localTable({ extraRoles: ["VIP"], capabilities: null });
    expectRefused(await post({ username: "Bob", level: "VIP" }));
  });

  it("lets a role with rcon.execute grant admin", async () => {
    localTable({ accounts: [{ username: "Bob", role: "user" }] });
    const { setAccessLevel, response } = await post({ username: "Bob", level: "admin" }, "technician");
    expect(response.status).not.toHaveBeenCalledWith(403);
    expect(setAccessLevel).toHaveBeenCalledWith("Bob", "admin");
  });

  // Adversary pass: ways around the gate that were tried.
  describe("bypass attempts", () => {
    it("demoting the in-game admin to user is refused (a level it can't grant, it can't take away)", async () => {
      localTable({
        accounts: [
          { username: "Owner", role: "admin" },
          { username: "Other", role: "admin" },
        ],
      });
      expectRefused(await post({ username: "owner", level: "user" }));
    });

    it("changing an account whose role the table doesn't name counts as staff", async () => {
      localTable({ accounts: [{ username: "Ghost", role: "role-42" }] });
      expectRefused(await post({ username: "Ghost", level: "user" }));
    });

    it("a second role table row named like a plain built-in role, carrying staff capabilities, is staff", async () => {
      localTable({ capabilities: new Map([["user", ["LoginOnServer", "QuitWorld"]]]) });
      expectRefused(await post({ username: "Bob", level: "user" }));
    });

    it("case and whitespace variants of admin never reach RCON", async () => {
      for (const level of ["Admin", "ADMIN", "admin ", " admin"]) {
        localTable();
        const { setAccessLevel, response } = await post({ username: "Bob", level });
        expect(setAccessLevel).not.toHaveBeenCalled();
        expect(response.status).toHaveBeenCalledWith(400);
      }
    });

    it("a request with no resolvable role holds nothing", async () => {
      localTable();
      expectRefused(await post({ username: "Bob", level: "admin" }, null));
      getRoleByName.mockRejectedValue(new Error("db gone"));
      localTable();
      expectRefused(await post({ username: "Bob", level: "admin" }, "technician"));
    });
  });
});

describe("GET /players/access-levels lists which levels are staff", () => {
  it("marks the built-in staff levels and custom roles by their capabilities", async () => {
    localTable({
      extraRoles: ["VIP", "Helper"],
      capabilities: new Map([
        ["VIP", ["LoginOnServer"]],
        ["Helper", ["AddItem"]],
      ]),
    });
    const response = createResponse();
    await getHandler("/access-levels", "get")({}, response);
    const payload = response.json.mock.calls[0][0];
    expect(payload.staffLevels).toEqual(["observer", "gm", "moderator", "admin", "Helper"]);
    expect(payload.levels).toContain("VIP");
  });

  it("marks every non-plain static level staff for a remote server", async () => {
    getActiveServer.mockResolvedValue({ ...localServer, isRemote: true });
    const response = createResponse();
    await getHandler("/access-levels", "get")({}, response);
    expect(response.json.mock.calls[0][0].staffLevels).toEqual(["admin", "moderator", "gm", "observer"]);
  });
});

describe("isStaffAccessLevel", () => {
  it("judges built-in roles by name and custom roles by the table, failing closed", () => {
    const table = new Map([["VIP", ["LoginOnServer"]]]);
    expect(isStaffAccessLevel("none", null)).toBe(false);
    expect(isStaffAccessLevel("user", null)).toBe(false);
    expect(isStaffAccessLevel("priority", table)).toBe(false);
    expect(isStaffAccessLevel("admin", table)).toBe(true);
    expect(isStaffAccessLevel("overseer", table)).toBe(true);
    expect(isStaffAccessLevel("VIP", table)).toBe(false);
    expect(isStaffAccessLevel("VIP", null)).toBe(true);
    expect(isStaffAccessLevel("NoRows", table)).toBe(false);
    expect(isStaffAccessLevel("admin", new Map([["admin", ["LoginOnServer"]]]))).toBe(true);
  });
});
