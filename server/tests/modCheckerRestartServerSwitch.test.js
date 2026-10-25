import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Several servers on one panel: a mod update found for server One while
// players were on left a restart waiting for them to leave (up to the
// maximum delay). The operator then made server Two active. The waiting
// loop kept going, counted Two's players over the RCON that now reaches Two,
// and restarted Two -- the scheduler's restart is the active server's --
// while One, which has the update, was never restarted. The loop now drops
// the restart once another server is active and leaves the updates for the
// next check with One active.

const db = vi.hoisted(() => ({ active: { id: "s1", name: "One" } }));

vi.mock("../database/init.js", () => ({
  getTrackedMods: vi.fn(async () => []),
  updateModTimestamp: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  addTrackedMod: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => db.active),
  getServer: vi.fn(async () => db.active),
  isModIgnored: vi.fn(async () => false),
  markModsChecked: vi.fn(async () => {}),
}));

const { ModChecker } = await import("../services/modChecker.js");

const MOD = { workshopId: "2001", name: "Better Sorting" };

function makeChecker() {
  const checker = new ModChecker();
  checker.delayIfPlayersOnline = true;
  checker.maxDelayMinutes = 120;
  checker.restartWarningMinutes = 5;
  const rconService = {
    connected: true,
    playerCount: 3,
    getPlayers: vi.fn(async () => ({
      success: true,
      players: Array.from({ length: rconService.playerCount }, (_, i) => `p${i}`),
    })),
    serverMessage: vi.fn(async () => ({ success: true })),
  };
  checker.scheduler = {
    rconService,
    restartWarning: { locale: "en" },
    performRestart: vi.fn(async () => ({ success: true })),
    cancelRestart: vi.fn(),
  };
  checker.serverManager = {
    getServerProcessDetails: vi.fn(async () => ({ running: true, scanFailed: false, matched: [{ pid: "4242" }] })),
    resolveStartTime: vi.fn(async () => new Date(Date.now() - 60 * 60 * 1000)),
  };
  checker.io = { emit: vi.fn() };
  return { checker, rconService };
}

let ticks;

beforeEach(() => {
  db.active = { id: "s1", name: "One" };
  ticks = [];
  vi.spyOn(globalThis, "setInterval").mockImplementation((callback) => {
    ticks.push(callback);
    return ticks.length;
  });
  vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a mod-update restart waiting for players is the found server's, not the active one's", () => {
  it("drops the restart when another server is made active, and never restarts that one", async () => {
    const { checker, rconService } = makeChecker();
    expect(await checker.handleModUpdate([MOD])).toMatchObject({ pending: true, reason: "waiting_for_players" });
    checker.processedUpdates.set(MOD.workshopId, 1234);

    // Server Two is active now, and nobody is on it.
    db.active = { id: "s2", name: "Two" };
    rconService.playerCount = 0;
    await ticks[0]();

    expect(checker.scheduler.performRestart).not.toHaveBeenCalled();
    expect(checker.pendingRestart).toBe(false);
    expect(checker.processedUpdates.has(MOD.workshopId)).toBe(false);
    expect(checker.io.emit).toHaveBeenCalledWith("mods:restart_cancelled", { reason: "server_switched" });
  });

  it("still restarts when the players leave and the same server is active", async () => {
    const { checker, rconService } = makeChecker();
    await checker.handleModUpdate([MOD]);
    rconService.playerCount = 0;
    await ticks[0]();

    expect(checker.scheduler.performRestart).toHaveBeenCalledTimes(1);
  });
});
