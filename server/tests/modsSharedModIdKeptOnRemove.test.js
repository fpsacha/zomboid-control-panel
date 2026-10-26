import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// A mod re-uploaded under a new Workshop ID keeps its mod id (and map
// folder). With the new item in WorkshopItems= and the old one Deactivated or
// left downloaded, removing the old item from tracking, removing it from the
// config or deleting its download took the shared id out of Mods= (and the
// map out of Map=): the new item stopped loading. An id or map an item still
// listed ships too now stays.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
  getTrackedMods: vi.fn(async () => []),
  addTrackedMod: vi.fn(),
  removeTrackedMod: vi.fn(),
  clearModUpdates: vi.fn(),
  getModPresets: vi.fn(async () => []),
  createModPreset: vi.fn(),
  updateModPreset: vi.fn(),
  deleteModPreset: vi.fn(),
  addIgnoredMod: vi.fn(),
  getIgnoredMods: vi.fn(async () => []),
  removeIgnoredMod: vi.fn(),
  clearAllIgnoredMods: vi.fn(),
  isModIgnored: vi.fn(async () => false),
  getIgnoredModPairs: vi.fn(async () => []),
  addIgnoredModPair: vi.fn(),
  removeIgnoredModPair: vi.fn(),
}));

const { getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");
const runRoute = createRouteRunner(router);

const OLD = "1111111111"; // the first upload: Deactivated / downloaded only
const NEW = "2222222222"; // its re-upload, in WorkshopItems=
const OTHER = "3333333333";

function writeMap(fx, wsId, modFolder, mapFolder) {
  const dir = path.join(fx.workshopFolder(wsId), "mods", modFolder, "media", "maps", mapFolder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "0_0.lotheader"), "");
}

describe("removing or deleting one Workshop item keeps what a listed item ships too", () => {
  let fx;

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network disabled in test");
      }),
    );
    fx = makeServerFixture({
      prefix: "mods-shared-id-",
      ini: `Mods=Other;Shared;OldOnly\nWorkshopItems=${OTHER};${NEW}\nMap=SharedTown;Muldraugh, KY\n`,
    });
    for (const wsId of [OLD, NEW]) {
      fx.writeMod(wsId, "Shared", "name=Shared\nid=Shared\n");
      writeMap(fx, wsId, "Shared", "SharedTown");
    }
    fx.writeMod(OLD, "OldOnly", "name=Old only\nid=OldOnly\n");
    fx.writeMod(OTHER, "Other", "name=Other\nid=Other\n");
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
  });

  afterEach(() => {
    fx.cleanup();
    vi.unstubAllGlobals();
  });

  const cases = [
    { name: "POST /batch-remove (Deactivated: delete from tracking)", route: "/batch-remove", body: { workshopIds: [OLD] } },
    { name: "POST /delete-disk-mod", route: "/delete-disk-mod", body: { workshopId: OLD } },
    { name: "POST /batch-delete-disk-mods", route: "/batch-delete-disk-mods", body: { workshopIds: [OLD] } },
  ];

  for (const c of cases) {
    it(`${c.name} keeps the re-upload's mod id and map, drops what only the old item ships`, async () => {
      const res = await runRoute(c.route, "post", { body: c.body });
      expect(res.getStatusCode()).toBe(200);
      expect(fx.iniValue("Mods")).toBe("Other;Shared");
      expect(fx.iniValue("WorkshopItems")).toBe(`${OTHER};${NEW}`);
      expect(fx.iniValue("Map")).toBe("SharedTown;Muldraugh, KY");
    });
  }

  it("POST /remove-from-ini of the old item, while both are listed, keeps the shared id and map", async () => {
    fx.writeIni(`Mods=Other;Shared;OldOnly\nWorkshopItems=${OTHER};${OLD};${NEW}\nMap=SharedTown;Muldraugh, KY\n`);
    const res = await runRoute("/remove-from-ini", "post", { body: { workshopId: OLD } });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().modIdsRemoved).toEqual(["OldOnly"]);
    expect(fx.iniValue("Mods")).toBe("Other;Shared");
    expect(fx.iniValue("WorkshopItems")).toBe(`${OTHER};${NEW}`);
    expect(fx.iniValue("Map")).toBe("SharedTown;Muldraugh, KY");
  });

  it("removing the last item that ships an id still takes it out of Mods= and Map=", async () => {
    const res = await runRoute("/remove-from-ini", "post", { body: { workshopId: NEW } });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe("Other;OldOnly");
    expect(fx.iniValue("WorkshopItems")).toBe(OTHER);
    expect(fx.iniValue("Map")).toBe("Muldraugh, KY");
  });
});
