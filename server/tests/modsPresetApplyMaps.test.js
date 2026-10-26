import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// A preset keeps Mods= and WorkshopItems= only, and applying one left Map=
// as it was: after a preset without the map mod its map stayed in Map= (a
// folder no loaded mod ships), and a preset with one loaded the mod without
// its map. Map= now follows the items that come and go, as when they are
// added or removed one by one.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
  getModPresets: vi.fn(),
}));

const { getActiveServer, getModPresets } = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");
const runRoute = createRouteRunner(router);

const BASE = "1111111111";
const MAP_ITEM = "2222222222";
const REUPLOAD = "3333333333";

function writeMapMod(fx, wsId, modId, mapFolder) {
  const modDir = fx.writeMod(wsId, modId, `name=${modId}\nid=${modId}\n`);
  const dir = path.join(modDir, "media", "maps", mapFolder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "0_0.lotheader"), "");
}

const apply = (preset) => {
  getModPresets.mockResolvedValue([{ id: "p1", name: "P", ...preset }]);
  return runRoute("/presets/:id/apply", "post", { params: { id: "p1" }, body: {} });
};

describe("POST /presets/:id/apply keeps Map= in step with the items", () => {
  let fx;

  beforeEach(() => {
    fx = makeServerFixture({ prefix: "mods-preset-maps-" });
    fx.writeMod(BASE, "Base", "name=Base\nid=Base\n");
    writeMapMod(fx, MAP_ITEM, "Town", "Townsville");
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
  });

  afterEach(() => fx.cleanup());

  it("takes the map of an item the preset drops out of Map=", async () => {
    fx.writeIni(`Mods=Base;Town\nWorkshopItems=${BASE};${MAP_ITEM}\nMap=Townsville;Muldraugh, KY\n`);
    expect((await apply({ workshop_ids: [BASE], mods: ["Base"] })).getStatusCode()).toBe(200);
    expect(fx.iniValue("WorkshopItems")).toBe(BASE);
    expect(fx.iniValue("Map")).toBe("Muldraugh, KY");
  });

  it("puts the map of an item the preset adds in front of Map=", async () => {
    fx.writeIni(`Mods=Base\nWorkshopItems=${BASE}\nMap=Muldraugh, KY\n`);
    expect((await apply({ workshop_ids: [BASE, MAP_ITEM], mods: ["Base", "Town"] })).getStatusCode()).toBe(200);
    expect(fx.iniValue("Map")).toBe("Townsville;Muldraugh, KY");
  });

  it("keeps a map an item the preset keeps ships too, and leaves Map= alone when no item comes or goes", async () => {
    writeMapMod(fx, REUPLOAD, "Town", "Townsville");
    fx.writeIni(`Mods=Base;Town\nWorkshopItems=${BASE};${MAP_ITEM};${REUPLOAD}\nMap=Townsville;Muldraugh, KY\n`);
    await apply({ workshop_ids: [BASE, REUPLOAD], mods: ["Base", "Town"] });
    expect(fx.iniValue("Map")).toBe("Townsville;Muldraugh, KY");

    fx.writeIni(`Mods=Base\nWorkshopItems=${BASE}\nMap=Hand Picked;Muldraugh, KY\n`);
    await apply({ workshop_ids: [BASE], mods: ["Base"] });
    expect(fx.iniValue("Map")).toBe("Hand Picked;Muldraugh, KY");
  });
});
