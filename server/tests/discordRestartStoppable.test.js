import { afterEach, describe, expect, it, vi } from "vitest";

// A Discord /restart took the lifecycle lock as "discord-restart", while Stop
// and Force stop only cancel a restart (routes/server.js's
// acquireLockForStop(), the Dashboard's lifecycleBlocker()) whose lock is
// named "restart". For the whole Discord countdown and restart both were
// refused with "A 'discord-restart' operation ... is already in progress",
// and the Dashboard greyed them out.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => ({ id: "srv-1", isRemote: false })),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: vi.fn(),
}));

const { DiscordBot } = await import("../services/discordBot.js");
const { acquireLockForStop } = await import("../routes/server.js");
const { isLifecycleLocked } = await import("../services/lifecycleCoordinator.js");

let stopLock = null;

afterEach(() => {
  stopLock?.release();
  stopLock = null;
});

describe("Stop during a restart started from Discord", () => {
  it("cancels that restart and takes the lock, as for any other restart", async () => {
    let endRestart = () => {};
    const scheduler = {
      on: vi.fn(),
      performRestart: vi.fn(
        () =>
          new Promise((resolve) => {
            endRestart = () => resolve({ success: false, message: "Restart cancelled" });
          }),
      ),
      cancelRestart: vi.fn(() => endRestart()),
    };
    const bot = new DiscordBot(
      { connected: true },
      { getServerProcessDetails: vi.fn(async () => ({ running: true, scanFailed: false })) },
      scheduler,
      null,
    );
    bot.sendNotification = vi.fn(async () => {});
    const interaction = {
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      options: { getInteger: () => 5 },
      user: { tag: "operator" },
    };

    const restarting = bot.handleRestart(interaction);
    await vi.waitFor(() => expect(scheduler.performRestart).toHaveBeenCalled());
    expect(isLifecycleLocked()).toBe(true);

    const app = { get: (key) => (key === "scheduler" ? scheduler : null) };
    stopLock = await acquireLockForStop("stop", "srv-1", app);

    expect(scheduler.cancelRestart).toHaveBeenCalledTimes(1);
    expect(stopLock).not.toBeNull();
    expect(stopLock.isHeld()).toBe(true);
    await restarting;
  });
});
