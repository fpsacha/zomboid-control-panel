import { describe, expect, it, vi } from "vitest";
import { OtherServerUpdates, workshopIdsOf } from "../services/otherServerUpdates.js";

// The servers other than the active one: Workshop mods behind Steam and
// game builds behind the branch's latest, which the mod and update checkers
// (active server only) never looked at -- and, with the mod checker's
// automatic restart on, a restart of a running server to load its updates.

const ACF = "/pz/steamapps/workshop/appworkshop_108600.acf";

function setup({
  config = { WorkshopItems: "111;222" },
  local = { 111: 100, 222: 200, 333: 100 },
  steam = { 111: 150, 222: 200, 333: 999 },
  running = true,
  startedAt = null,
  autoRestart = true,
  restartResult = { success: true },
  installed = { buildId: "10", branch: "public" },
  latest = { buildId: "12" },
} = {}) {
  const servers = [{ id: "active", name: "Main" }, { id: "s2", name: "Second", installPath: "/pz" }];
  const deps = {
    getServers: vi.fn(async () => servers),
    getActiveServer: vi.fn(async () => servers[0]),
    readServerConfig: vi.fn(async () => config),
    acfCandidates: vi.fn(() => [ACF]),
    fileExists: vi.fn((file) => file === ACF),
    readFile: vi.fn(async () => "acf"),
    parseAcf: vi.fn(() => ({
      installedMods: Object.fromEntries(Object.entries(local).map(([id, t]) => [id, { timeupdated: t }])),
      modDetails: {},
    })),
    fetchWorkshop: vi.fn(async (ids) => ({
      result: new Map(ids.filter((id) => steam[id]).map((id) => [id, { time_updated: steam[id], title: `Mod ${id}` }])),
    })),
    installedBuild: vi.fn(async () => installed),
    latestBuild: vi.fn(async () => latest),
    readStatuses: vi.fn(async () => [{ id: "s2", running, stateUnknown: false, startedAt }]),
    modRestartSettings: vi.fn(() => ({ autoRestart, warningMinutes: 3 })),
    restartServer: vi.fn(async () => restartResult),
    logEvent: vi.fn(async () => {}),
    emit: vi.fn(),
    now: () => 1_000_000,
  };
  return { updates: new OtherServerUpdates(deps), deps };
}

describe("workshopIdsOf()", () => {
  it("reads WorkshopItems=, and null without it", () => {
    expect(workshopIdsOf({ WorkshopItems: "1; 2;;x" })).toEqual(["1", "2"]);
    expect(workshopIdsOf({})).toBeNull();
  });
});

describe("OtherServerUpdates.checkAll()", () => {
  it("lists the mods its ini names that are behind Steam, and leaves the active server to the mod checker", async () => {
    const { updates, deps } = setup();
    const results = await updates.checkAll();

    expect(results).toHaveLength(1);
    expect(results[0].serverId).toBe("s2");
    // 333 is behind too, but another server's: not in this one's ini.
    expect(results[0].mods.outdated.map((mod) => mod.workshopId)).toEqual(["111"]);
    expect(deps.fetchWorkshop).toHaveBeenCalledWith(["111", "222"]);
    expect(deps.emit).toHaveBeenCalled();
  });

  it("reports the game build against the branch's latest, asking Steam once per branch", async () => {
    const { updates, deps } = setup();
    await updates.checkAll();
    const [result] = await updates.checkAll();

    expect(result.game).toMatchObject({ installedBuild: "10", latestBuild: "12", branch: "public", updateAvailable: true });
    expect(deps.latestBuild).toHaveBeenCalledTimes(1);
  });

  it("says why when there is no Workshop file or no ini to read", async () => {
    const noIni = setup({ config: null });
    expect((await noIni.updates.checkAll())[0].mods.error).toBe("noServerConfig");

    const noAcf = setup();
    noAcf.deps.fileExists.mockReturnValue(false);
    expect((await noAcf.updates.checkAll())[0].mods.error).toBe("noWorkshopFile");
  });

  it("restarts a running server with mods behind once per set of updates, with the mod checker's warning", async () => {
    const { updates, deps } = setup();
    await updates.checkAll();
    await updates.checkAll();

    expect(deps.restartServer).toHaveBeenCalledTimes(1);
    expect(deps.restartServer).toHaveBeenCalledWith(expect.objectContaining({ id: "s2" }), 3);
    expect(deps.logEvent).toHaveBeenCalledWith("mod_update_restart", expect.stringContaining("Mod 111"), "s2");
  });

  // Two servers on one install share its Workshop folder: the other one's
  // restart downloaded 222's update there, so the ACF matches Steam, but this
  // server has run since before that version was published.
  it("counts a mod installed after the server started as behind, and restarts the server for it", async () => {
    const { updates, deps } = setup({
      local: { 111: 150, 222: 300 },
      steam: { 111: 150, 222: 300 },
      startedAt: new Date(200 * 1000).toISOString(),
    });
    const [result] = await updates.checkAll();

    expect(result.mods.outdated.map((mod) => mod.workshopId)).toEqual(["222"]);
    expect(deps.restartServer).toHaveBeenCalledTimes(1);

    // Started again after that version: up to date.
    const fresh = setup({
      local: { 111: 150, 222: 300 },
      steam: { 111: 150, 222: 300 },
      startedAt: new Date(400 * 1000).toISOString(),
    });
    expect((await fresh.updates.checkAll())[0].mods.outdated).toEqual([]);
  });

  it("tries again on the next check when the restart didn't happen", async () => {
    const { updates, deps } = setup({ restartResult: { success: false, message: "Restart already in progress" } });
    await updates.checkAll();
    await updates.checkAll();

    expect(deps.restartServer).toHaveBeenCalledTimes(2);
    expect(deps.logEvent).toHaveBeenCalledWith("mod_update_restart_error", expect.stringContaining("already in progress"), "s2");
  });

  it("restarts nothing when the automatic restart is off, or the server is down", async () => {
    const off = setup({ autoRestart: false });
    await off.updates.checkAll();
    expect(off.deps.restartServer).not.toHaveBeenCalled();

    const down = setup({ running: false });
    await down.updates.checkAll();
    expect(down.deps.restartServer).not.toHaveBeenCalled();
  });
});
