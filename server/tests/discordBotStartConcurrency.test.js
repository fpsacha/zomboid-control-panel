import { beforeEach, describe, expect, it, vi } from "vitest";

// re-entrancy sweep, 2026-09-10 (god-dispatched, HIGH #1): start()'s
// double-start guard checked `this.isRunning || this.client`, but
// this.client isn't assigned until after the first await (loadConfig())
// and this.isRunning not until much later still (post-login). Two
// near-simultaneous start() calls both passed the check before either
// assigned this.client, and both went on to construct their own Client
// and attach their own messageCreate listener -- doubling every in-game
// chat relay message. Fixed by claiming a new `_starting` flag
// SYNCHRONOUSLY, before the first await, mirroring panelUpdateChecker.js's
// isDownloading. Proven here through the REAL DiscordBot class and its
// REAL start() method (not a reimplementation) -- only discord.js's own
// Client and the database/uiSecretFile layers underneath it are mocked.

const { ClientMock, loadUiSecretMock } = vi.hoisted(() => ({
  ClientMock: vi.fn(),
  loadUiSecretMock: vi.fn(async () => "fake-bot-token"),
}));

vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    Client: class {
      constructor(opts) {
        ClientMock(opts);
        this.on = vi.fn();
        // Never invokes the clientReady callback -- start() hangs at the
        // login-wait promise below, exactly like a real multi-second
        // gateway handshake in flight. Nothing awaits this class's own
        // internals from the test, so a hung call A is fine to leave
        // pending.
        this.once = vi.fn();
        this.login = vi.fn(() => new Promise(() => {}));
        this.destroy = vi.fn();
      }
    },
  };
});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

vi.mock("../utils/uiSecretFile.js", () => ({
  loadUiSecret: (...args) => loadUiSecretMock(...args),
  writeUiSecretFile: vi.fn(() => {}),
}));

const { DiscordBot } = await import("../services/discordBot.js");

function makeBot() {
  const rconService = { connected: false };
  const serverManager = {};
  const scheduler = { on: vi.fn() };
  return new DiscordBot(rconService, serverManager, scheduler, null);
}

describe("DiscordBot.start(): concurrency guard", () => {
  beforeEach(() => {
    ClientMock.mockClear();
    loadUiSecretMock.mockReset().mockResolvedValue("fake-bot-token");
  });

  it("a second overlapping start() call is refused while the first is still connecting, and never constructs its own Client", async () => {
    const bot = makeBot();

    // Not awaited individually -- start()'s guard is claimed synchronously
    // before its first await, so by the time this line returns control,
    // call A has already claimed it; call B, called next, sees it live
    // immediately (same reasoning as
    // server/tests/steamcmdDownloadConcurrency.test.js's guard test).
    const callA = bot.start();
    const callB = bot.start();

    const resultB = await callB;
    expect(resultB).toBe(true);

    // Let call A's own chain of awaits (loadConfig()'s several getSetting
    // calls) actually reach the point of constructing a Client, so the
    // "never constructs its own" assertion below is checking real
    // progress, not just an early return.
    await vi.waitFor(() => expect(ClientMock).toHaveBeenCalledTimes(1));

    // The actual property under test: B was refused BEFORE it ever
    // reached its own Client construction. Pre-fix, both A and B would
    // have constructed their own Client and attached their own
    // messageCreate listener.
    expect(ClientMock).toHaveBeenCalledTimes(1);

    // Call A is still legitimately in flight (its login() never resolves)
    // -- not awaited to completion, by design.
  });

  it("does not refuse a fresh start() once a prior attempt has fully finished", async () => {
    const bot = makeBot();
    // No token configured -> _doStart() resolves quickly (false) without
    // ever reaching Client construction/login, so this attempt genuinely
    // finishes instead of hanging like the mock in the test above.
    loadUiSecretMock.mockResolvedValue(null);

    const first = await bot.start();
    expect(first).toBe(false); // no token

    const second = await bot.start();
    expect(second).toBe(false); // guard released after the first call, not stuck refusing forever
  });
});
