import { beforeEach, describe, expect, it, vi } from "vitest";

// SECURITY (2026-10-28, audit R2-6): the player activity log (GET
// /players/activity) recorded the target player and the action only, so with
// several moderators nobody could tell which panel account granted an in-game
// access level, added an account or banned someone. Each deliberate action
// now stores the signed-in panel account as `actor`.
//
// Real, unmocked database/init.js: vitest.perFileDataDir.setup.mjs gives
// this file its own throwaway data folder.

vi.mock("../services/panelBridge.js", () => ({ default: { isRunning: false } }));
vi.mock("../utils/whitelistDb.js", () => ({
  listWhitelistAccounts: vi.fn(async () => ({ available: false, accounts: [] })),
  listServerRoleNames: vi.fn(async () => ({ available: false, roleNames: [] })),
}));

const { getDb, getPlayerLogs, logPlayerAction } = await import("../database/init.js");
const { default: router } = await import("../routes/players.js");

function handler(method, routePath) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack.at(-1).handle;
}

async function call(routePath, body, user, rconService) {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  await handler("post", routePath)({ body, user, app: { get: () => rconService } }, response);
  return response;
}

const ok = vi.fn(async () => ({ success: true, response: "ok" }));

beforeEach(async () => {
  const db = await getDb();
  db.data.player_logs = [];
});

describe("player activity log: who acted", () => {
  it("records the signed-in panel account for a kick", async () => {
    await call("/kick", { username: "Griefer", reason: "spam" }, { username: "alice", role: "moderator" }, { kickPlayer: ok });
    const [entry] = await getPlayerLogs();
    expect(entry).toMatchObject({ player_name: "Griefer", action: "kick", actor: "alice" });
  });

  it("records it for an access-level change and an account added", async () => {
    await call("/access-level", { username: "Newbie", level: "user" }, { username: "bob", role: "admin" }, { setAccessLevel: ok });
    await call("/adduser", { username: "Fresh", password: "pass1234" }, { username: "carol", role: "admin" }, { addUser: ok });
    const logs = await getPlayerLogs();
    expect(logs.find((l) => l.action === "access_level")).toMatchObject({ player_name: "Newbie", actor: "bob" });
    expect(logs.find((l) => l.action === "adduser")).toMatchObject({ player_name: "Fresh", actor: "carol" });
  });

  it("stores no actor while panel logins are off, nor on automatic rows", async () => {
    await call("/kick", { username: "Griefer" }, { username: null, role: "admin", authDisabled: true }, { kickPlayer: ok });
    await logPlayerAction("Joiner", "connect", "Player connected to server", null);
    for (const entry of await getPlayerLogs()) {
      expect(entry).not.toHaveProperty("actor");
    }
  });

  // Adversary pass: the actor comes from the session, never the request.
  it("ignores an actor named in the request body", async () => {
    await call("/kick", { username: "Griefer", actor: "admin", by: "admin" }, { username: "dave", role: "moderator" }, { kickPlayer: ok });
    const [entry] = await getPlayerLogs();
    expect(entry.actor).toBe("dave");
  });

  it("drops a non-text actor", async () => {
    await logPlayerAction("X", "kick", null, null, { toString: () => "spoof" });
    const [entry] = await getPlayerLogs();
    expect(entry).not.toHaveProperty("actor");
  });
});
