import { beforeEach, describe, expect, it, vi } from "vitest";

// re-entrancy sweep finding #5 (2026-09-10): routes/discord.js's PUT
// /config, PUT /webhook-events, and PUT /permissions each read this
// DiscordBot singleton's current persisted config and write back a merge,
// with no guard serializing overlapping saves against each other.
//
// The mechanism this test proves is specifically loadConfig() (called at
// the top of PUT /config, and made of several SEQUENTIALLY AWAITED
// getSetting() calls) interleaving with a concurrent PUT /webhook-events
// save: loadConfig()'s last step re-reads discordWebhookEvents from the DB
// and unconditionally overwrites this.webhookEvents with whatever it
// finds. If a webhook-events save commits its own change to memory AND the
// DB while loadConfig()'s read is already in flight (query issued before
// the save committed), loadConfig() resolves with the OLD value and
// clobbers the just-saved change back out of memory -- even though the DB
// write itself succeeded. (A pure webhook-events-vs-webhook-events overlap
// does NOT reproduce this: that route's own read+merge+in-memory-commit
// happen in one synchronous span with no await between them, so two such
// saves can't actually interleave with each other -- verified while
// writing this test, see the memory.md report for this finding.)
//
// discordBot.withConfigMutex() (services/discordBot.js) fixes this by
// serializing PUT /config's entire loadConfig()-through-writes critical
// section against PUT /webhook-events' (and PUT /permissions') critical
// section, same promise-chain-mutex shape as AuthService._withMutex.

const { getSettingMock, setSettingMock, loadUiSecretMock } = vi.hoisted(
  () => ({
    getSettingMock: vi.fn(),
    setSettingMock: vi.fn(async () => {}),
    loadUiSecretMock: vi.fn(async () => null),
  }),
);

vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, Client: class {} };
});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: getSettingMock,
  setSetting: setSettingMock,
}));

vi.mock("../utils/uiSecretFile.js", () => ({
  loadUiSecret: (...args) => loadUiSecretMock(...args),
  writeUiSecretFile: vi.fn(() => {}),
}));

const { DiscordBot } = await import("../services/discordBot.js");

// A promise the test controls the resolution of, standing in for the DB
// read racing a concurrent writer's not-yet-committed change.
function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeBot() {
  return new DiscordBot({ connected: false }, {}, { on: vi.fn() }, null);
}

const EXISTING_EVENTS = { existing: { enabled: true, template: "x" } };
const NEW_EVENT = { newKey: { enabled: true, template: "y" } };

describe("DiscordBot.withConfigMutex(): serializes loadConfig() against a concurrent webhook-events save", () => {
  let gate;

  beforeEach(() => {
    getSettingMock.mockReset();
    setSettingMock.mockClear();
    loadUiSecretMock.mockReset().mockResolvedValue(null);
    gate = deferred();
    // Every getSetting() call inside loadConfig() resolves immediately
    // EXCEPT discordWebhookEvents, its last read -- that one hangs on the
    // gate so loadConfig() can be paused at the exact point where it is
    // about to overwrite this.webhookEvents from a (by then) stale query.
    getSettingMock.mockImplementation(async (key) => {
      if (key === "discordWebhookEvents") return gate.promise;
      return null;
    });
  });

  it("mechanism: a concurrent webhook-events save cannot even START until loadConfig()'s critical section fully finishes, so it can never be reverted by a stale re-read", async () => {
    const bot = makeBot();
    bot.webhookEvents = { ...EXISTING_EVENTS };

    // Represents PUT /config's critical section: the query for
    // discordWebhookEvents is issued now (while EXISTING_EVENTS is still
    // the true DB value) and hangs on the gate.
    const configSection = bot.withConfigMutex(() => bot.loadConfig());

    // Represents PUT /webhook-events' critical section, queued while
    // configSection is still in flight -- same pattern as
    // discordBotStartConcurrency.test.js's back-to-back, unawaited calls.
    let webhookSectionRan = false;
    const webhookSection = bot.withConfigMutex(async () => {
      webhookSectionRan = true;
      const merged = { ...(bot.webhookEvents || {}), ...NEW_EVENT };
      await bot.saveWebhookEvents(merged);
    });

    // Give the event loop every chance to run webhookSection if the mutex
    // were not actually enforcing order -- it must not have started.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(webhookSectionRan).toBe(false);
    expect(bot.webhookEvents).toEqual(EXISTING_EVENTS);

    // Release loadConfig()'s query -- it resolves to the stale value that
    // was true when the query was issued (before webhookSection ever got a
    // chance to write).
    gate.resolve(JSON.stringify(EXISTING_EVENTS));
    await configSection;
    await webhookSection;

    expect(webhookSectionRan).toBe(true);
    // webhookSection's merge ran AFTER loadConfig() fully committed, so it
    // read the post-loadConfig value and its own change survives.
    expect(bot.webhookEvents).toEqual({ ...EXISTING_EVENTS, ...NEW_EVENT });
  });

  it("documents the pre-fix bug: WITHOUT serialization, the same interleaving silently reverts the webhook-events save", async () => {
    const bot = makeBot();
    bot.webhookEvents = { ...EXISTING_EVENTS };

    // Unserialized -- calls the exact same critical-section bodies
    // directly, bypassing withConfigMutex(), to prove the race is real
    // absent the fix (this is what routes/discord.js did before finding
    // #5's fix landed).
    const configSection = bot.loadConfig();

    const merged = { ...(bot.webhookEvents || {}), ...NEW_EVENT };
    await bot.saveWebhookEvents(merged); // commits NEW_EVENT immediately, no mutex to wait on
    expect(bot.webhookEvents).toEqual({ ...EXISTING_EVENTS, ...NEW_EVENT });

    gate.resolve(JSON.stringify(EXISTING_EVENTS)); // the stale query resolves...
    await configSection;

    // ...and clobbers the just-saved change back out of memory. This is
    // finding #5's bug, reproduced directly -- the DB write from
    // saveWebhookEvents succeeded, but the in-memory singleton (and every
    // future read/merge based on it) has silently lost the change.
    expect(bot.webhookEvents).toEqual(EXISTING_EVENTS);
    expect(bot.webhookEvents.newKey).toBeUndefined();
  });
});
