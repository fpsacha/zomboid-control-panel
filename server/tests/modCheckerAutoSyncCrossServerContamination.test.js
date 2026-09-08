import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// discord-mods-24-updates-on-fresh-server: e4de1518 fixed the READ side of
// this bug (checkForUpdates()/getStatus() filtering) but rested on a premise
// that turned out false in practice -- "getTrackedMods() is already
// server-scoped, unlike the shared ACF". True by schema, but
// autoSyncModsOnStartup() (this file) is a WRITE site nobody had touched:
// called once from init() at process boot, it used to bulk-import EVERY
// entry in appworkshop_108600.acf (SteamCMD's own shared, NOT per-server
// content cache) into the active server's own tracked_mods table the moment
// that server had zero tracked mods -- true for any brand-new server. That
// permanently mislabels a previous server's leftover mods as this server's
// own, poisoning the exact signal e4de1518's read-side union filter trusts.
// A comparison-time fix can never see contamination baked into its own
// trusted source.
//
// Fix: only auto-track an ACF entry the active server's own ini
// WorkshopItems= actually lists. With no ini signal at all (a brand-new
// server before its first full config write -- the state the original
// Discord report was filed in), there's no per-server signal to trust at
// all, so this skips syncing entirely rather than guessing from a cache
// shared with every other server on the host.

const getTrackedMods = vi.fn(async () => []);
const addTrackedMod = vi.fn();
const isModIgnored = vi.fn(async () => false);

vi.mock("../database/init.js", () => ({
  getTrackedMods,
  addTrackedMod,
  isModIgnored,
}));

const { ModChecker } = await import("../services/modChecker.js");

function writeAcfFixture(acfPath, ids) {
  fs.mkdirSync(path.dirname(acfPath), { recursive: true });
  const installed = ids
    .map(
      (id) => `\t\t"${id}"
\t\t{
\t\t\t"size"\t\t"1234"
\t\t\t"timeupdated"\t\t"1000"
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

describe("modChecker.js autoSyncModsOnStartup(): does not write a different server's leftover ACF entries into this server's own tracked_mods", () => {
  let tempRoot;
  const MOD_OWN = "1111111111"; // belongs to (is configured for) the active/new server
  const MOD_PHANTOM = "2222222222"; // leftover from a different server on the same host

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "modchecker-autosync-"));
    getTrackedMods.mockReset().mockResolvedValue([]);
    addTrackedMod.mockReset();
    isModIgnored.mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function makeChecker({ acfMods }) {
    const acfPath = path.join(tempRoot, "appworkshop_108600.acf");
    writeAcfFixture(acfPath, acfMods);
    const checker = new ModChecker();
    checker.workshopAcfPath = acfPath;
    return checker;
  }

  it("a brand-new server with no ini signal at all: does NOT bulk-import the shared ACF (the exact state the Discord report was filed in)", async () => {
    const checker = makeChecker({ acfMods: [MOD_OWN, MOD_PHANTOM] });
    // No serverManager wired -- getConfiguredWorkshopIds() returns null,
    // exactly a fresh server's state before its first full config write.
    expect(checker.serverManager).toBeNull();

    await checker.autoSyncModsOnStartup();

    expect(addTrackedMod).not.toHaveBeenCalled();
  });

  it("a real, readable but empty ini: also skips syncing rather than trusting the ACF wholesale", async () => {
    const checker = makeChecker({ acfMods: [MOD_OWN, MOD_PHANTOM] });
    checker.serverManager = {
      getServerConfig: async () => ({ WorkshopItems: "" }),
    };

    await checker.autoSyncModsOnStartup();

    expect(addTrackedMod).not.toHaveBeenCalled();
  });

  it("only auto-tracks ACF entries this server's own ini actually lists -- a phantom entry from another server is never written", async () => {
    const checker = makeChecker({ acfMods: [MOD_OWN, MOD_PHANTOM] });
    checker.serverManager = {
      getServerConfig: async () => ({ WorkshopItems: MOD_OWN }),
    };

    await checker.autoSyncModsOnStartup();

    expect(addTrackedMod).toHaveBeenCalledTimes(1);
    expect(addTrackedMod).toHaveBeenCalledWith(MOD_OWN, expect.any(String));
    expect(addTrackedMod).not.toHaveBeenCalledWith(
      MOD_PHANTOM,
      expect.anything(),
    );
  });

  it("legitimate single-server case is unaffected: ini lists everything the ACF has, so everything still syncs", async () => {
    const checker = makeChecker({ acfMods: [MOD_OWN, MOD_PHANTOM] });
    checker.serverManager = {
      getServerConfig: async () => ({
        WorkshopItems: `${MOD_OWN};${MOD_PHANTOM}`,
      }),
    };

    await checker.autoSyncModsOnStartup();

    expect(addTrackedMod).toHaveBeenCalledTimes(2);
    expect(addTrackedMod).toHaveBeenCalledWith(MOD_OWN, expect.any(String));
    expect(addTrackedMod).toHaveBeenCalledWith(
      MOD_PHANTOM,
      expect.any(String),
    );
  });

  it("still respects the ignore list within the ini-filtered set", async () => {
    const checker = makeChecker({ acfMods: [MOD_OWN, MOD_PHANTOM] });
    checker.serverManager = {
      getServerConfig: async () => ({
        WorkshopItems: `${MOD_OWN};${MOD_PHANTOM}`,
      }),
    };
    isModIgnored.mockImplementation(async (id) => id === MOD_PHANTOM);

    await checker.autoSyncModsOnStartup();

    expect(addTrackedMod).toHaveBeenCalledTimes(1);
    expect(addTrackedMod).toHaveBeenCalledWith(MOD_OWN, expect.any(String));
  });

  it("still skips entirely when mods are already tracked for this server, regardless of ini contents (unchanged guard)", async () => {
    getTrackedMods.mockResolvedValue([
      { workshop_id: MOD_OWN, name: "Already Tracked" },
    ]);
    const checker = makeChecker({ acfMods: [MOD_OWN, MOD_PHANTOM] });
    checker.serverManager = {
      getServerConfig: async () => ({
        WorkshopItems: `${MOD_OWN};${MOD_PHANTOM}`,
      }),
    };

    await checker.autoSyncModsOnStartup();

    expect(addTrackedMod).not.toHaveBeenCalled();
  });

  it("the trap case: untracking everything back to zero and re-running auto-sync (as a second panel restart would) does not reintroduce the phantom", async () => {
    const checker = makeChecker({ acfMods: [MOD_OWN, MOD_PHANTOM] });
    checker.serverManager = {
      getServerConfig: async () => ({ WorkshopItems: MOD_OWN }),
    };

    // First boot.
    await checker.autoSyncModsOnStartup();
    expect(addTrackedMod).toHaveBeenCalledTimes(1);
    expect(addTrackedMod).toHaveBeenCalledWith(MOD_OWN, expect.any(String));

    // Operator untracks everything (or nothing legitimate was ever tracked),
    // count is back to zero, and the panel restarts again.
    addTrackedMod.mockClear();
    getTrackedMods.mockResolvedValue([]);
    await checker.autoSyncModsOnStartup();

    expect(addTrackedMod).not.toHaveBeenCalledWith(
      MOD_PHANTOM,
      expect.anything(),
    );
  });
});
