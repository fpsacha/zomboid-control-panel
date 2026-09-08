import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Discord report, #panel-general, user y0cam: "My mods list insists I have
// 24 updates ready despite the fact I setup a NEW server and these are all
// freshly installed. It is reading from my previous server still possibly?"
//
// The mechanism: the Workshop ACF file (appworkshop_108600.acf) is
// SteamCMD's own content cache, not something the panel scopes per
// configured server -- a host that has ever run more than one server
// through the same SteamCMD install can have ACF entries for servers that
// aren't the currently active one at all. checkForUpdates()'s comparison
// (and getStatus()'s separate updatesAvailable count) iterated every entry
// in that file with no server-relevance filter beyond a fail-open "if the
// ini can't be read, don't filter" -- exactly the state a brand-new server
// is in before its first full config write.
//
// The fix's relevance set is the UNION of the active server's own .ini
// WorkshopItems= list and its own tracked mods (server-scoped in the DB),
// not "ini, falling back to tracked only when the ini is unreadable" --
// god's explicit ruling: a mod that's tracked/downloaded but not yet
// reflected in a regenerated ini must still report its update, since a
// silently missing update is a failure mode no user would ever think to
// report, unlike the noisy phantom-mod flood this fix exists for.

const getTrackedMods = vi.fn(async () => []);
const addTrackedMod = vi.fn();
const isModIgnored = vi.fn(async () => false);
const markModsChecked = vi.fn();

vi.mock("../database/init.js", () => ({
  getTrackedMods,
  updateModTimestamp: vi.fn(),
  logServerEvent: vi.fn(),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(),
  addTrackedMod,
  getActiveServer: vi.fn(async () => null),
  isModIgnored,
  markModsChecked,
}));

const { ModChecker } = await import("../services/modChecker.js");

function writeAcfFixture(acfPath, mods) {
  fs.mkdirSync(path.dirname(acfPath), { recursive: true });
  const installed = mods
    .map(
      ({ workshopId, timeupdated }) => `\t\t"${workshopId}"
\t\t{
\t\t\t"size"\t\t"1234"
\t\t\t"timeupdated"\t\t"${timeupdated}"
\t\t}`,
    )
    .join("\n");
  fs.writeFileSync(
    acfPath,
    `"AppWorkshop"
{
\t"appid"\t\t"108600"
\t"WorkshopItemsInstalled"
\t{
${installed}
\t}
}
`,
  );
}

describe("modChecker.js does not treat every mod in a (possibly host-shared) Workshop ACF as belonging to the active server", () => {
  let tempRoot;
  const MOD_RELEVANT = "1111111111"; // belongs to the active/new server
  const MOD_PHANTOM = "2222222222"; // leftover from a different/previous server

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "modchecker-phantom-"));
    getTrackedMods.mockReset().mockResolvedValue([]);
    addTrackedMod.mockReset();
    isModIgnored.mockReset().mockResolvedValue(false);
    markModsChecked.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function makeChecker({ acfMods, steamUpdates }) {
    const acfPath = path.join(tempRoot, "appworkshop_108600.acf");
    writeAcfFixture(
      acfPath,
      acfMods.map((id) => ({ workshopId: id, timeupdated: 1000 })),
    );
    const checker = new ModChecker();
    checker.workshopAcfPath = acfPath;
    checker.fetchSteamTimestamps = vi.fn(async () => {
      const map = new Map();
      for (const id of steamUpdates) map.set(id, { time_updated: 2000 });
      return map;
    });
    return checker;
  }

  describe("checkForUpdates()", () => {
    it("reports only this server's own tracked mod, not a phantom entry the ACF shares with a different server, when the ini can't be read", async () => {
      getTrackedMods.mockResolvedValue([
        { workshop_id: MOD_RELEVANT, name: "Relevant Mod" },
      ]);
      const checker = makeChecker({
        acfMods: [MOD_RELEVANT, MOD_PHANTOM],
        steamUpdates: [MOD_RELEVANT, MOD_PHANTOM],
      });
      // No serverManager wired -- getConfiguredWorkshopIds() returns null,
      // exactly a fresh server's state before its first full config write.
      expect(checker.serverManager).toBeNull();

      const result = await checker.checkForUpdates();

      const reportedIds = result.mods.map((m) => m.workshopId);
      expect(reportedIds).toEqual([MOD_RELEVANT]);
      expect(reportedIds).not.toContain(MOD_PHANTOM);
      // The real, compounding half of the bug: a phantom mod must not get
      // silently written into this server's own tracked_mods table either.
      expect(addTrackedMod).not.toHaveBeenCalledWith(
        MOD_PHANTOM,
        expect.anything(),
      );
    });

    // god's condition, explicit: the SUPPRESSION direction must not swallow
    // a real update. A mod that's tracked/downloaded for this server but
    // not (yet) listed in a real, readable ini -- a normal, transient state
    // right after adding a mod, before the ini is regenerated -- must still
    // report. A silently missing update is a failure mode no user would
    // ever think to report, unlike the noisy phantom flood this fix exists
    // for.
    it("still reports a mod that is tracked for this server even though the (readable, non-empty) ini doesn't list it yet", async () => {
      const OTHER_INI_MOD = "3333333333";
      getTrackedMods.mockResolvedValue([
        { workshop_id: MOD_RELEVANT, name: "Just Added Mod" },
      ]);
      const checker = makeChecker({
        acfMods: [MOD_RELEVANT],
        steamUpdates: [MOD_RELEVANT],
      });
      // The ini is real and readable, and does NOT mention MOD_RELEVANT --
      // simulating "added via the UI, ini not regenerated yet".
      checker.serverManager = {
        getServerConfig: async () => ({ WorkshopItems: OTHER_INI_MOD }),
      };

      const result = await checker.checkForUpdates();

      expect(result.mods.map((m) => m.workshopId)).toEqual([MOD_RELEVANT]);
    });

    it("still excludes a genuine phantom (neither in the ini nor tracked for this server) even when the ini IS readable and lists something else", async () => {
      getTrackedMods.mockResolvedValue([
        { workshop_id: MOD_RELEVANT, name: "Relevant Mod" },
      ]);
      const checker = makeChecker({
        acfMods: [MOD_RELEVANT, MOD_PHANTOM],
        steamUpdates: [MOD_RELEVANT, MOD_PHANTOM],
      });
      checker.serverManager = {
        getServerConfig: async () => ({ WorkshopItems: MOD_RELEVANT }),
      };

      const result = await checker.checkForUpdates();

      expect(result.mods.map((m) => m.workshopId)).toEqual([MOD_RELEVANT]);
      expect(addTrackedMod).not.toHaveBeenCalledWith(
        MOD_PHANTOM,
        expect.anything(),
      );
    });

    it("falls back to the OLD unfiltered behavior when there is truly no signal at all (no INI, nothing tracked) -- preserves existing single-server/no-config-yet behavior", async () => {
      getTrackedMods.mockResolvedValue([]);
      const checker = makeChecker({
        acfMods: [MOD_RELEVANT, MOD_PHANTOM],
        steamUpdates: [MOD_RELEVANT, MOD_PHANTOM],
      });

      const result = await checker.checkForUpdates();

      expect(result.mods.map((m) => m.workshopId).sort()).toEqual(
        [MOD_RELEVANT, MOD_PHANTOM].sort(),
      );
    });
  });

  describe("getStatus()", () => {
    it("counts updatesAvailable only for this server's own relevant mods, not every mod in a shared ACF", async () => {
      getTrackedMods.mockResolvedValue([
        { workshop_id: MOD_RELEVANT, name: "Relevant Mod" },
      ]);
      const checker = makeChecker({
        acfMods: [MOD_RELEVANT, MOD_PHANTOM],
        steamUpdates: [],
      });
      // getWorkshopInfo() reads lastSteamTimestamps directly -- set it so
      // both mods resolve as needing an update, same as if a check had just
      // run against a shared ACF.
      checker.lastSteamTimestamps = new Map([
        [MOD_RELEVANT, { time_updated: 2000 }],
        [MOD_PHANTOM, { time_updated: 2000 }],
      ]);

      const status = await checker.getStatus();

      expect(status.totalModsInWorkshop).toBe(2);
      expect(status.updatesAvailable).toBe(1);
    });

    it("still counts a mod that is tracked but not (yet) in the ini -- the suppression direction must not swallow a real update", async () => {
      const OTHER_INI_MOD = "3333333333";
      getTrackedMods.mockResolvedValue([
        { workshop_id: MOD_RELEVANT, name: "Just Added Mod" },
      ]);
      const checker = makeChecker({
        acfMods: [MOD_RELEVANT],
        steamUpdates: [],
      });
      // A real, readable, non-empty ini that simply doesn't mention
      // MOD_RELEVANT yet -- not an empty/unreadable ini, which would fall
      // back to trackedWorkshopIds under either design and prove nothing.
      checker.serverManager = {
        getServerConfig: async () => ({ WorkshopItems: OTHER_INI_MOD }),
      };
      checker.lastSteamTimestamps = new Map([
        [MOD_RELEVANT, { time_updated: 2000 }],
      ]);

      const status = await checker.getStatus();

      expect(status.updatesAvailable).toBe(1);
    });
  });
});
