import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// PUT /discord/config reported success even when the reconnect it triggers
// (stop() then start()) actually failed -- diagnosed in
// docs/qa/kevin-route-hunt.md Finding 1, confirmed still present.
// discordBot.start()'s return value was discarded even though the sibling
// route POST /start (30 lines below) already checks it correctly.

const START_ALREADY_IN_PROGRESS = Symbol("discord-start-already-in-progress");

vi.mock("../services/discordBot.js", () => ({
  normalizeChatRelayScope: vi.fn((value) => value),
  START_ALREADY_IN_PROGRESS,
}));

vi.mock("../database/init.js", () => ({
  getRoleByName: mockGetRoleByName,
  setSetting: vi.fn(async () => {}),
}));

const { default: router } = await import("../routes/discord.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandlers(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(routePath, method, req) {
  const res = createResponse();
  const handlers = getHandlers(routePath, method);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

const NEW_TOKEN = "new-token-value";
const NEW_GUILD_ID = "123456789012345678";

function mockDiscordBot({ startResult, lastStartError = null }) {
  return {
    token: "old-token-value", // different from NEW_TOKEN -> credentialsChanged
    guildId: "111111111111111111",
    isRunning: true,
    lastStartError,
    loadConfig: vi.fn(async () => {}),
    updateConfig: vi.fn(async () => {}),
    updateChatRelay: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => startResult),
    // Passthrough, not a real mutex -- these tests each exercise a single
    // request, not concurrency (that's covered separately in
    // discordConfigMutex.test.js). Real shape: (fn) => Promise resolving fn().
    withConfigMutex: vi.fn((fn) => fn()),
  };
}

function putConfig(discordBot) {
  return runRoute("/config", "put", {
    user: { role: "admin" },
    app: { get: () => discordBot },
    body: { token: NEW_TOKEN, guildId: NEW_GUILD_ID },
  });
}

describe("discord.js PUT /config: the response must reflect whether the reconnect actually succeeded", () => {
  it("reports botStarted:false with a real reason when the post-save reconnect fails, while still saying the config itself saved", async () => {
    const discordBot = mockDiscordBot({
      startResult: false,
      lastStartError: { kind: "TokenInvalid", message: "An invalid token was provided." },
    });

    const res = await putConfig(discordBot);

    expect(discordBot.start).toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true); // config really did save
    expect(payload.botStarted).toBe(false);
    expect(payload.botStartError).toMatch(/invalid token/i);
  });

  it("reports success cleanly with no botStarted field when the reconnect succeeds", async () => {
    const discordBot = mockDiscordBot({ startResult: true });

    const res = await putConfig(discordBot);

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.botStarted).toBeUndefined();
  });

  // re-entrancy sweep finding #5 follow-up: start() now returns a
  // distinguishable sentinel (not bare `true`) when it was refused because
  // a DIFFERENT start() call was already in flight -- see
  // discordBotStartConcurrency.test.js. Before this, a refused start()
  // looked identical to a genuine one and this branch would have silently
  // claimed "Discord bot configuration updated" with no hint that its own
  // reconnect attempt never actually ran.
  it("says the reconnect it triggered did not actually run when start() was refused by a concurrent start already in flight, instead of silently claiming plain success", async () => {
    const discordBot = mockDiscordBot({ startResult: START_ALREADY_IN_PROGRESS });

    const res = await putConfig(discordBot);

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true); // config itself really did save
    expect(payload.botStarted).toBe(null); // genuinely unknown from this request's own view
    expect(payload.message).toMatch(/already in progress/i);
    expect(payload.message).not.toBe("Discord bot configuration updated"); // not the plain success message -- would overclaim a reconnect this request never performed
  });
});
