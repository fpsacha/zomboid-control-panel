import { beforeEach, describe, expect, it, vi } from "vitest";

// PUT /discord/permissions could retune ANY Discord slash command's
// authorization tier, including dropping /rcon (default "admin") all the
// way to "everyone" -- letting any member of the Discord guild run
// arbitrary RCON, start/stop/restart the server, kick players, or
// broadcast, entirely outside the panel's own rcon.execute / server.control
// / players.moderate / server.world_events gates, with no panel account at
// all. integrations.manage's own description ("Configure the Discord bot")
// gave no hint this reaches that far -- flagged in tonight's
// capability-description sweep and reordered to the top fix because,
// unlike every other finding that night, this one crosses the panel's own
// account boundary entirely.
//
// Fix: changing a command's Discord tier now requires the caller to already
// hold the panel capability that command maps to (DISCORD_COMMAND_CAPABILITY
// in routes/discord.js), mirroring services/scheduler.js's
// requiredCapabilityForScheduledCommand() shape from earlier tonight -- you
// cannot hand out an authority through Discord that you do not hold
// yourself in the panel.

const ROLES = {
  admin: {
    capabilities: [
      "integrations.manage",
      "rcon.execute",
      "server.control",
      "server.world_events",
      "players.moderate",
      "players.view",
    ],
  },
  // Holds integrations.manage (passes the router-level gate that guards this
  // whole file) and NOTHING else -- the exact caller this fix exists to
  // stop: someone who can open the Discord permissions screen but holds
  // none of the panel-side capabilities the commands themselves require.
  integrations_only: { capabilities: ["integrations.manage"] },
  // integrations.manage + rcon.execute only, to prove the check is
  // per-command, not all-or-nothing.
  integrations_and_rcon: {
    capabilities: ["integrations.manage", "rcon.execute"],
  },
};

const getRoleByName = vi.fn(async (name) => ROLES[name] || null);

vi.mock("../database/init.js", () => ({ getRoleByName }));
vi.mock("../services/discordBot.js", () => ({
  normalizeChatRelayScope: vi.fn((value) => value),
}));

const { default: router } = await import("../routes/discord.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

// Runs the router-level requirePermission("integrations.manage") gate
// (router.use, index 0 -- no `.route`, invisible to a route-stack-only
// lookup) AHEAD of PUT /permissions' own handler stack, so both layers this
// fix relies on are actually exercised, not just the inline one.
async function runPutPermissions(discordBot, permissions, role) {
  const useLayer = router.stack.find(
    (entry) => !entry.route && typeof entry.handle === "function",
  );
  const routeLayer = router.stack.find(
    (entry) => entry.route?.path === "/permissions" && entry.route.methods.put,
  );
  const handlers = [useLayer.handle, ...routeLayer.route.stack.map((s) => s.handle)];

  const response = createResponse();
  const request = {
    user: { role },
    app: { get: () => discordBot },
    body: { permissions },
  };
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](request, response, next);
  };
  await next();
  return response;
}

function mockDiscordBot(current) {
  return {
    getCommandPermissions: vi.fn(() => ({ ...current })),
    updateCommandPermissions: vi.fn(async (perms) => ({ ...current, ...perms })),
    // re-entrancy sweep finding #5: the route now serializes its
    // read-check-write critical section via withConfigMutex(). Passthrough
    // here -- this file tests the capability gate, not concurrency.
    withConfigMutex: vi.fn((fn) => fn()),
  };
}

describe("PUT /discord/permissions -- per-command capability gate", () => {
  beforeEach(() => {
    getRoleByName.mockClear();
  });

  it("refuses to lower /rcon's tier for a caller who holds integrations.manage but not rcon.execute", async () => {
    const discordBot = mockDiscordBot({ rcon: "admin" });

    const response = await runPutPermissions(
      discordBot,
      { rcon: "everyone" },
      "integrations_only",
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        missing: [{ command: "rcon", requiredCapability: "rcon.execute" }],
      }),
    );
    expect(discordBot.updateCommandPermissions).not.toHaveBeenCalled();
  });

  it("allows the same change for a caller who holds rcon.execute", async () => {
    const discordBot = mockDiscordBot({ rcon: "admin" });

    const response = await runPutPermissions(
      discordBot,
      { rcon: "everyone" },
      "integrations_and_rcon",
    );

    expect(discordBot.updateCommandPermissions).toHaveBeenCalledWith({
      rcon: "everyone",
    });
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("re-submitting the SAME tier for a command the caller lacks the capability for is a no-op, not a refusal (whole-object resend must not lock out saves)", async () => {
    const discordBot = mockDiscordBot({ rcon: "admin", start: "admin" });

    // integrations_only holds neither rcon.execute nor server.control, but
    // resends every current tier unchanged alongside one real edit it IS
    // allowed to make.
    const response = await runPutPermissions(
      discordBot,
      { rcon: "admin", start: "admin", status: "moderator" },
      "integrations_only",
    );

    expect(discordBot.updateCommandPermissions).toHaveBeenCalledWith({
      rcon: "admin",
      start: "admin",
      status: "moderator",
    });
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("changing /status's tier needs nothing beyond integrations.manage (status has no panel-side capability gate to match)", async () => {
    const discordBot = mockDiscordBot({ status: "everyone" });

    const response = await runPutPermissions(
      discordBot,
      { status: "admin" },
      "integrations_only",
    );

    expect(discordBot.updateCommandPermissions).toHaveBeenCalledWith({
      status: "admin",
    });
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("a multi-command request names every offending command and rejects atomically -- no partial apply", async () => {
    const discordBot = mockDiscordBot({
      rcon: "admin",
      start: "admin",
      kick: "moderator",
    });

    const response = await runPutPermissions(
      discordBot,
      { rcon: "everyone", start: "everyone", kick: "everyone" },
      "integrations_only",
    );

    expect(response.status).toHaveBeenCalledWith(403);
    const payload = response.json.mock.calls[0][0];
    expect(payload.missing).toEqual(
      expect.arrayContaining([
        { command: "rcon", requiredCapability: "rcon.execute" },
        { command: "start", requiredCapability: "server.control" },
        { command: "kick", requiredCapability: "players.moderate" },
      ]),
    );
    expect(discordBot.updateCommandPermissions).not.toHaveBeenCalled();
  });

  it("the router-level integrations.manage gate still applies underneath -- a role without it never reaches the inline check", async () => {
    const discordBot = mockDiscordBot({ rcon: "admin" });

    const response = await runPutPermissions(
      discordBot,
      { rcon: "everyone" },
      "no_such_role",
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(discordBot.updateCommandPermissions).not.toHaveBeenCalled();
  });

  it("admin (holds every capability) can change any command's tier in one request", async () => {
    const discordBot = mockDiscordBot({
      rcon: "admin",
      start: "admin",
      broadcast: "moderator",
      kick: "moderator",
      players: "everyone",
    });

    const response = await runPutPermissions(
      discordBot,
      {
        rcon: "everyone",
        start: "everyone",
        broadcast: "everyone",
        kick: "everyone",
        players: "moderator",
      },
      "admin",
    );

    expect(discordBot.updateCommandPermissions).toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });
});
