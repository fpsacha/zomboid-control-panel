import { beforeEach, describe, expect, it, vi } from "vitest";

const getActiveServer = vi.fn();
const listServerRoleNames = vi.fn();

vi.mock("../database/init.js", () => ({
  // R2-5: these tests act as a role that may grant staff levels.
  getRoleByName: vi.fn(async () => ({ capabilities: ["players.moderate", "rcon.execute"] })),
  getActiveServer,
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

vi.mock("../utils/whitelistDb.js", () => ({ listWhitelistAccounts: vi.fn(), listServerRoleNames }));
vi.mock("../services/panelBridge.js", () => ({ isRunning: false }));

const { default: router } = await import("../routes/players.js");

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

function createRequest(body = {}, rconService = {}) {
  return {
    body,
    user: { username: "tech", role: "technician" },
    app: { get: () => rconService },
  };
}

// 2026-08-30, release-runup: access-levels-should-come-from-the-server-not-a-
// hardcoded-array Phase 2. GET /access-levels used to return the static
// ACCESS_LEVELS array unconditionally; POST /access-level's own validation
// gate used the same static array. Both now source from the server's live
// role table (via listServerRoleNames), falling back to the static list only
// when the db is unavailable or the server is remote -- matching GET
// /whitelist's own available/reason fallback shape.
describe("GET /players/access-levels", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    listServerRoleNames.mockReset();
  });

  it("returns the live role table's names plus 'none' when the server's db is available", async () => {
    getActiveServer.mockResolvedValue({
      id: "server-1",
      serverName: "DoomerZ",
      zomboidDataPath: "/zomboid",
      isRemote: false,
    });
    listServerRoleNames.mockResolvedValue({
      available: true,
      roleNames: ["user", "admin", "vip"],
    });
    const response = createResponse();

    await getHandler("/access-levels", "get")({}, response);

    expect(listServerRoleNames).toHaveBeenCalledWith("/zomboid", "DoomerZ");
    expect(response.json).toHaveBeenCalledWith({
      levels: ["user", "admin", "vip", "none"],
      // R2-5: without the capability table a custom role counts as staff.
      staffLevels: ["admin", "vip"],
      available: true,
    });
  });

  it("falls back to the static list when the server's db is unavailable, without erroring", async () => {
    getActiveServer.mockResolvedValue({
      id: "server-1",
      serverName: "NeverStartedServer",
      zomboidDataPath: "/zomboid",
      isRemote: false,
    });
    listServerRoleNames.mockResolvedValue({
      available: false,
      roleNames: [],
      reason: "Server database not found",
    });
    const response = createResponse();

    await getHandler("/access-levels", "get")({}, response);

    const payload = response.json.mock.calls[0][0];
    expect(payload.available).toBe(false);
    expect(payload.reason).toBe("Server database not found");
    expect(payload.levels).toEqual(
      expect.arrayContaining(["admin", "moderator", "gm", "observer", "priority", "user", "none"]),
    );
  });

  it("falls back to the static list for a remote server without calling the local db reader", async () => {
    getActiveServer.mockResolvedValue({
      id: "server-1",
      serverName: "RemoteBox",
      zomboidDataPath: "/zomboid",
      isRemote: true,
    });
    const response = createResponse();

    await getHandler("/access-levels", "get")({}, response);

    expect(listServerRoleNames).not.toHaveBeenCalled();
    const payload = response.json.mock.calls[0][0];
    expect(payload.available).toBe(false);
    expect(payload.levels).toContain("none");
  });
});

describe("POST /players/access-level: validation gate matches what GET /access-levels just offered", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    listServerRoleNames.mockReset();
  });

  it("accepts a custom role the live table has but the static list does not", async () => {
    getActiveServer.mockResolvedValue({
      id: "server-1",
      serverName: "DoomerZ",
      zomboidDataPath: "/zomboid",
      isRemote: false,
    });
    listServerRoleNames.mockResolvedValue({ available: true, roleNames: ["user", "admin", "vip"] });
    const setAccessLevel = vi.fn().mockResolvedValue({ success: true });
    const response = createResponse();

    await getHandler("/access-level", "post")(
      createRequest({ username: "Alice", level: "vip" }, { setAccessLevel }),
      response,
    );

    expect(setAccessLevel).toHaveBeenCalledWith("Alice", "vip");
    expect(response.status).not.toHaveBeenCalledWith(400);
  });

  // bug-hunt-2026-09-18 (round: whitelist/access-level/admin accounts):
  // a custom role's real name can carry uppercase letters (PZ's own
  // in-game role editor doesn't force lowercase) -- confirmed via javap
  // against the real B42 jar that zombie.characters.Roles.getRole(String)
  // resolves by String.equals, case-sensitive, so "VIP" and "vip" are
  // different roles as far as the game server is concerned. This route
  // used to compare level.toLowerCase() against validLevels (which holds
  // roles in their REAL case, unmodified, straight from listServerRoleNames
  // -- the exact same data GET /access-levels' dropdown offers) -- so
  // submitting the EXACT value the dropdown just gave the operator
  // ("VIP") was wrongly rejected as "Invalid access level" purely because
  // of case-folding on only one side of the comparison.
  it("accepts a custom role's EXACT real-case name -- the same value GET /access-levels just offered -- without folding case", async () => {
    getActiveServer.mockResolvedValue({
      id: "server-1",
      serverName: "DoomerZ",
      zomboidDataPath: "/zomboid",
      isRemote: false,
    });
    listServerRoleNames.mockResolvedValue({ available: true, roleNames: ["user", "admin", "VIP"] });
    const setAccessLevel = vi.fn().mockResolvedValue({ success: true });
    const response = createResponse();

    await getHandler("/access-level", "post")(
      createRequest({ username: "Alice", level: "VIP" }, { setAccessLevel }),
      response,
    );

    // Not just "not a 400" -- RCON must receive the SAME case PZ's own
    // case-sensitive role lookup requires, not a silently lowercased guess.
    expect(setAccessLevel).toHaveBeenCalledWith("Alice", "VIP");
    expect(response.status).not.toHaveBeenCalledWith(400);
  });

  it("still rejects a level that is neither in the live table nor the static fallback", async () => {
    getActiveServer.mockResolvedValue({
      id: "server-1",
      serverName: "DoomerZ",
      zomboidDataPath: "/zomboid",
      isRemote: false,
    });
    listServerRoleNames.mockResolvedValue({ available: true, roleNames: ["user", "admin"] });
    const setAccessLevel = vi.fn();
    const response = createResponse();

    await getHandler("/access-level", "post")(
      createRequest({ username: "Alice", level: "nonexistent" }, { setAccessLevel }),
      response,
    );

    expect(setAccessLevel).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
  });
});
