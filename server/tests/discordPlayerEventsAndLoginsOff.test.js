import { beforeEach, describe, expect, it, vi } from "vitest";

// SECURITY (2026-10-28):
// - Audit R1-23: PUT /discord/webhook-events needed integrations.manage
//   only, so a custom role without players.view could turn on join, leave
//   and death notifications (player names, times, death coordinates) and,
//   through PUT /config, point them at a channel of its choice. Turning one
//   on, changing an enabled one's message, or moving the channel while one is
//   on now needs players.view.
// - Audit R1-51: with panel logins off every request acts as admin, so a
//   bot token, guild or role ID set then -- or a command tier lowered --
//   kept handing out bot commands after logins came back. Those changes now
//   wait for logins; unchanged resends and raised tiers still save.
//
// The real route and the real DiscordBot; only the settings store, the
// secret file and the discord.js Client are faked (same harness as
// discordConfigCapabilityGate.test.js).

const { settings, secrets } = vi.hoisted(() => ({
  settings: new Map(),
  secrets: new Map(),
}));

const ROLES = {
  admin: {
    capabilities: [
      "integrations.manage",
      "players.view",
      "server.control",
      "server.world_events",
      "players.moderate",
      "rcon.execute",
    ],
  },
  integrations_only: { capabilities: ["integrations.manage"] },
  integrations_and_view: { capabilities: ["integrations.manage", "players.view"] },
};

vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, Client: class {} };
});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async (key) => (settings.has(key) ? settings.get(key) : null)),
  setSetting: vi.fn(async (key, value) => {
    settings.set(key, value);
  }),
  getRoleByName: vi.fn(async (name) => ROLES[name] || null),
}));

vi.mock("../utils/uiSecretFile.js", () => ({
  loadUiSecret: vi.fn(async (name) => secrets.get(name) || null),
  writeUiSecretFile: vi.fn((name, value) => {
    secrets.set(name, value);
  }),
}));

const { DiscordBot } = await import("../services/discordBot.js");
const { default: router } = await import("../routes/discord.js");

const GUILD = "100000000000000001";
const OTHER_GUILD = "100000000000000099";
const ADMIN_ROLE = "200000000000000001";
const CHANNEL = "400000000000000001";
const OTHER_CHANNEL = "400000000000000002";

const JOIN_ON = { playerJoin: { enabled: true, template: "{player} joined" } };

function seed({ token = "operators-bot-token", events = null, commandPermissions = null } = {}) {
  settings.clear();
  secrets.clear();
  if (token) secrets.set("discordBotToken", token);
  settings.set("discordGuildId", GUILD);
  settings.set("discordAdminRoleId", ADMIN_ROLE);
  settings.set("discordModRoleId", "");
  settings.set("discordChannelId", CHANNEL);
  if (events) settings.set("discordWebhookEvents", JSON.stringify(events));
  if (commandPermissions) settings.set("discordCommandPermissions", JSON.stringify(commandPermissions));
}

async function makeBot() {
  const bot = new DiscordBot({ connected: false }, {}, { on: vi.fn() }, null);
  await bot.loadConfig();
  return bot;
}

const LOGINS_OFF = { userId: null, username: null, role: "admin", tokenGen: null, authDisabled: true };

// Runs the router-level integrations.manage gate, then the route.
async function run(bot, method, routePath, body, user) {
  const useLayer = router.stack.find((entry) => !entry.route && typeof entry.handle === "function");
  const routeLayer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const handlers = [useLayer.handle, ...routeLayer.route.stack.map((s) => s.handle)];
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  const request = { user: typeof user === "string" ? { role: user } : user, app: { get: () => bot }, body };
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](request, response, next);
  };
  await next();
  return response;
}

function codeOf(response) {
  return response.json.mock.calls[0]?.[0]?.code;
}

function savedEvents() {
  const raw = settings.get("discordWebhookEvents");
  return raw ? JSON.parse(raw) : {};
}

function configBody(overrides = {}) {
  return {
    token: "KEEP_EXISTING",
    guildId: GUILD,
    adminRoleId: ADMIN_ROLE,
    modRoleId: undefined,
    channelId: CHANNEL,
    autoStart: true,
    chatRelayEnabled: false,
    chatRelayScope: "public",
    ...overrides,
  };
}

describe("R1-23: player notifications need players.view", () => {
  it("refuses turning on death notifications with coordinates for integrations.manage alone", async () => {
    seed();
    const bot = await makeBot();
    const response = await run(bot, "put", "/webhook-events", {
      events: { playerDeath: { enabled: true, template: "{player} died at {x},{y},{z} ({location})" } },
    }, "integrations_only");
    expect(response.status).toHaveBeenCalledWith(403);
    expect(codeOf(response)).toBe("DISCORD_PLAYER_EVENTS_CAPABILITY_REQUIRED");
    expect(savedEvents()).toEqual({});
    expect(bot.webhookEvents.playerDeath).toBeUndefined();
  });

  it("refuses changing an enabled join notification's message", async () => {
    seed({ events: JOIN_ON });
    const bot = await makeBot();
    const response = await run(bot, "put", "/webhook-events", {
      events: { playerJoin: { enabled: true, template: "{player} joined at {x}" } },
    }, "integrations_only");
    expect(codeOf(response)).toBe("DISCORD_PLAYER_EVENTS_CAPABILITY_REQUIRED");
    expect(savedEvents().playerJoin.template).toBe("{player} joined");
  });

  it("still lets it turn them off, resend them unchanged, and manage the other events", async () => {
    seed({ events: JOIN_ON });
    const bot = await makeBot();
    for (const events of [
      JOIN_ON,
      { serverStart: { enabled: true, template: "Server up" } },
      { playerJoin: { enabled: false, template: "{player} joined" } },
    ]) {
      const response = await run(bot, "put", "/webhook-events", { events }, "integrations_only");
      expect(response.status).not.toHaveBeenCalled();
    }
    expect(savedEvents().playerJoin.enabled).toBe(false);
    expect(savedEvents().serverStart.enabled).toBe(true);
  });

  it("lets a role with players.view turn them on", async () => {
    seed();
    const bot = await makeBot();
    const response = await run(bot, "put", "/webhook-events", { events: JOIN_ON }, "integrations_and_view");
    expect(response.status).not.toHaveBeenCalled();
    expect(savedEvents().playerJoin.enabled).toBe(true);
  });

  it("refuses moving the notification channel while a player notification is on", async () => {
    seed({ events: JOIN_ON });
    const bot = await makeBot();
    const response = await run(bot, "put", "/config", configBody({ channelId: OTHER_CHANNEL }), "integrations_only");
    expect(codeOf(response)).toBe("DISCORD_PLAYER_EVENTS_CAPABILITY_REQUIRED");
    expect(settings.get("discordChannelId")).toBe(CHANNEL);
  });

  // Adversary pass: the relay-channel pin that skips the chat relay's own
  // channel check doesn't skip this one.
  it("refuses it even with the relay pinned to the old channel", async () => {
    seed({ events: JOIN_ON });
    const bot = await makeBot();
    const response = await run(bot, "put", "/config", configBody({
      channelId: OTHER_CHANNEL,
      chatRelayEnabled: true,
      chatRelayChannelId: CHANNEL,
    }), "integrations_only");
    expect(codeOf(response)).toBe("DISCORD_PLAYER_EVENTS_CAPABILITY_REQUIRED");
    expect(settings.get("discordChannelId")).toBe(CHANNEL);
  });

  it("lets the channel move when no player notification is on", async () => {
    seed({ events: { playerJoin: { enabled: false, template: "x" } } });
    const bot = await makeBot();
    const response = await run(bot, "put", "/config", configBody({ channelId: OTHER_CHANNEL }), "integrations_only");
    expect(response.status).not.toHaveBeenCalledWith(403);
    expect(settings.get("discordChannelId")).toBe(OTHER_CHANNEL);
  });
});

describe("R1-51: bot identity and tiers wait for panel logins", () => {
  it("refuses a guild change while logins are off", async () => {
    seed();
    const bot = await makeBot();
    const response = await run(bot, "put", "/config", configBody({ guildId: OTHER_GUILD }), LOGINS_OFF);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(codeOf(response)).toBe("DISCORD_CHANGES_NEED_LOGINS");
    expect(settings.get("discordGuildId")).toBe(GUILD);
  });

  it("refuses a new token and an admin role change while logins are off", async () => {
    seed({ token: null });
    const bot = await makeBot();
    let response = await run(bot, "put", "/config", configBody({ token: "attacker-token" }), LOGINS_OFF);
    expect(codeOf(response)).toBe("DISCORD_CHANGES_NEED_LOGINS");
    expect(secrets.has("discordBotToken")).toBe(false);

    seed();
    response = await run(await makeBot(), "put", "/config", configBody({ adminRoleId: "300000000000000001" }), LOGINS_OFF);
    expect(codeOf(response)).toBe("DISCORD_CHANGES_NEED_LOGINS");
    expect(settings.get("discordAdminRoleId")).toBe(ADMIN_ROLE);
  });

  it("still saves an unchanged resend while logins are off", async () => {
    seed();
    const bot = await makeBot();
    const response = await run(bot, "put", "/config", configBody({ autoStart: false }), LOGINS_OFF);
    expect(response.status).not.toHaveBeenCalled();
    expect(settings.get("discordAutoStart")).toBe(false);
  });

  it("refuses lowering a command tier while logins are off, but saves raising one", async () => {
    seed();
    const bot = await makeBot();
    let response = await run(bot, "put", "/permissions", { permissions: { rcon: "everyone" } }, LOGINS_OFF);
    expect(codeOf(response)).toBe("DISCORD_CHANGES_NEED_LOGINS");
    expect(bot.getCommandPermissions().rcon).toBe("admin");

    response = await run(bot, "put", "/permissions", { permissions: { players: "moderator" } }, LOGINS_OFF);
    expect(response.status).not.toHaveBeenCalled();
    expect(bot.getCommandPermissions().players).toBe("moderator");
  });

  // Adversary pass: a value that isn't a tier counts as lowering it.
  it("refuses an unknown tier value while logins are off", async () => {
    seed();
    const bot = await makeBot();
    for (const tier of ["nobody", "constructor", "__proto__"]) {
      const response = await run(bot, "put", "/permissions", { permissions: { rcon: tier } }, LOGINS_OFF);
      expect(codeOf(response)).toBe("DISCORD_CHANGES_NEED_LOGINS");
    }
    expect(bot.getCommandPermissions().rcon).toBe("admin");
  });

  it("lets a signed-in admin change the guild", async () => {
    seed();
    const bot = await makeBot();
    const response = await run(bot, "put", "/config", configBody({ guildId: OTHER_GUILD }), "admin");
    expect(codeOf(response)).not.toBe("DISCORD_CHANGES_NEED_LOGINS");
    expect(settings.get("discordGuildId")).toBe(OTHER_GUILD);
  });
});
