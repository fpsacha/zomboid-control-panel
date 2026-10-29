import { beforeEach, describe, expect, it, vi } from "vitest";

const getActiveServer = vi.fn();
const listServerRoleNames = vi.fn();
const listWhitelistAccounts = vi.fn();

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

vi.mock("../utils/whitelistDb.js", () => ({ listWhitelistAccounts, listServerRoleNames }));
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

// continuous-bug-hunt round 29 (card: guard-against-removing-last-admin):
// POST /access-level had no guard at all against demoting the only PZ
// in-game account holding the 'admin' access level -- unlike the panel's
// own users/roles lockout (services/permissions.js's
// checkLockoutRulesForCapabilityChange, services/auth.js's
// assertNoRecoveryLockout), which already refuses outright. This is a WARN,
// not a refuse (the panel's own RCON connection can always re-grant admin
// afterward, so this is recoverable) -- the route now returns 409 +
// PLAYERS_LAST_ADMIN_ACCESS_LEVEL_CONFIRM the first time, and proceeds when
// the caller resubmits with confirm: true.
describe("POST /players/access-level: warns before demoting the only local admin account", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    listServerRoleNames.mockReset();
    listWhitelistAccounts.mockReset();
  });

  const localServer = {
    id: "server-1",
    serverName: "DoomerZ",
    zomboidDataPath: "/zomboid",
    isRemote: false,
  };

  it("refuses with a 409 + confirm code when the target is the only admin account, without calling RCON", async () => {
    getActiveServer.mockResolvedValue(localServer);
    listServerRoleNames.mockResolvedValue({ available: true, roleNames: ["user", "admin", "moderator"] });
    listWhitelistAccounts.mockResolvedValue({
      available: true,
      accounts: [
        { username: "Alice", role: "admin" },
        { username: "Bob", role: "moderator" },
      ],
    });
    const setAccessLevel = vi.fn();
    const response = createResponse();

    await getHandler("/access-level", "post")(
      createRequest({ username: "Alice", level: "moderator" }, { setAccessLevel }),
      response,
    );

    expect(setAccessLevel).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(409);
    const payload = response.json.mock.calls[0][0];
    expect(payload.code).toBe("PLAYERS_LAST_ADMIN_ACCESS_LEVEL_CONFIRM");
    expect(payload.params.username).toBe("Alice");
  });

  it("proceeds when the caller resubmits with confirm: true", async () => {
    getActiveServer.mockResolvedValue(localServer);
    listServerRoleNames.mockResolvedValue({ available: true, roleNames: ["user", "admin", "moderator"] });
    listWhitelistAccounts.mockResolvedValue({
      available: true,
      accounts: [{ username: "Alice", role: "admin" }],
    });
    const setAccessLevel = vi.fn().mockResolvedValue({ success: true });
    const response = createResponse();

    await getHandler("/access-level", "post")(
      createRequest({ username: "Alice", level: "moderator", confirm: true }, { setAccessLevel }),
      response,
    );

    expect(setAccessLevel).toHaveBeenCalledWith("Alice", "moderator");
    expect(response.status).not.toHaveBeenCalledWith(409);
  });

  it("does not warn when another account still holds admin after the change", async () => {
    getActiveServer.mockResolvedValue(localServer);
    listServerRoleNames.mockResolvedValue({ available: true, roleNames: ["user", "admin", "moderator"] });
    listWhitelistAccounts.mockResolvedValue({
      available: true,
      accounts: [
        { username: "Alice", role: "admin" },
        { username: "Carol", role: "admin" },
      ],
    });
    const setAccessLevel = vi.fn().mockResolvedValue({ success: true });
    const response = createResponse();

    await getHandler("/access-level", "post")(
      createRequest({ username: "Alice", level: "moderator" }, { setAccessLevel }),
      response,
    );

    expect(setAccessLevel).toHaveBeenCalledWith("Alice", "moderator");
    expect(response.status).not.toHaveBeenCalledWith(409);
  });

  it("does not warn when promoting TO admin, even for the only admin account", async () => {
    getActiveServer.mockResolvedValue(localServer);
    listServerRoleNames.mockResolvedValue({ available: true, roleNames: ["user", "admin"] });
    listWhitelistAccounts.mockResolvedValue({
      available: true,
      accounts: [{ username: "Alice", role: "admin" }],
    });
    const setAccessLevel = vi.fn().mockResolvedValue({ success: true });
    const response = createResponse();

    await getHandler("/access-level", "post")(
      createRequest({ username: "Alice", level: "admin" }, { setAccessLevel }),
      response,
    );

    expect(setAccessLevel).toHaveBeenCalledWith("Alice", "admin");
    expect(response.status).not.toHaveBeenCalledWith(409);
  });

  it("skips the check for a remote server (no local whitelist db to verify against) rather than guessing", async () => {
    getActiveServer.mockResolvedValue({ ...localServer, isRemote: true });
    const setAccessLevel = vi.fn().mockResolvedValue({ success: true });
    const response = createResponse();

    await getHandler("/access-level", "post")(
      createRequest({ username: "Alice", level: "moderator" }, { setAccessLevel }),
      response,
    );

    expect(listWhitelistAccounts).not.toHaveBeenCalled();
    expect(setAccessLevel).toHaveBeenCalledWith("Alice", "moderator");
    expect(response.status).not.toHaveBeenCalledWith(409);
  });

  it("falls through to RCON when the whitelist db read itself fails, rather than blocking the action", async () => {
    getActiveServer.mockResolvedValue(localServer);
    listServerRoleNames.mockResolvedValue({ available: true, roleNames: ["user", "admin", "moderator"] });
    listWhitelistAccounts.mockRejectedValue(new Error("db locked"));
    const setAccessLevel = vi.fn().mockResolvedValue({ success: true });
    const response = createResponse();

    await getHandler("/access-level", "post")(
      createRequest({ username: "Alice", level: "moderator" }, { setAccessLevel }),
      response,
    );

    expect(setAccessLevel).toHaveBeenCalledWith("Alice", "moderator");
    expect(response.status).not.toHaveBeenCalledWith(409);
  });
});
