import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// Security audit 2026-10-28 (CodeQL js/path-injection, workshopModInfo.js):
// the Workshop readers joined whatever id they were given into a folder path.
// Routes that take an id from the request check /^\d{1,15}$/, but the ini's
// WorkshopItems= entries went straight through (GET /current-config, GET
// /validate-config, POST /repair-map-entries, the toggle routes), and a
// mods.manage holder could put "../.." there with PUT /presets/:id + apply.
// GET /current-config then listed any folder and returned the mod.info fields
// found there. getWorkshopPaths() now has no folder for anything but digits,
// and PUT /presets/:id takes digits-only workshopIds.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
  updateModPreset: vi.fn(),
}));

const { getActiveServer, updateModPreset } = await import("../database/init.js");
const { ErrorCode } = await import("../utils/errorCodes.js");
const { getWorkshopPaths, getModDetailsFromWorkshop, findMapFoldersFromWorkshop } = await import(
  "../services/workshopModInfo.js"
);
const { default: router } = await import("../routes/mods.js");
const runRoute = createRouteRunner(router);

// From <install>/steamapps/workshop/content/108600 up to <install>.
const UP_TO_INSTALL = "../../../..";
const ESCAPE = `${UP_TO_INSTALL}/elsewhere`;

describe("Workshop item ids are folder names only when digits", () => {
  let fx;

  beforeEach(() => {
    fx = makeServerFixture({ prefix: "ws-id-guard-" });
    // A folder outside the Workshop content folder, shaped like an item.
    const outsideMod = path.join(fx.installPath, "elsewhere", "mods", "Secret");
    fs.mkdirSync(outsideMod, { recursive: true });
    fs.writeFileSync(path.join(outsideMod, "mod.info"), "name=LeakedName\nid=LeakedSecretMod\n");
    const outsideMap = path.join(fx.installPath, "elsewhere", "mods", "Secret", "media", "maps", "HiddenTown");
    fs.mkdirSync(outsideMap, { recursive: true });
    fs.writeFileSync(path.join(outsideMap, "0_0.lotheader"), "");
    fx.writeMod("1234567890", "Real", "name=Real\nid=RealMod\n");
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
    updateModPreset.mockReset().mockImplementation(async (id, updates) => ({ id, ...updates }));
  });

  afterEach(() => fx.cleanup());

  it("reads nothing outside the Workshop folder for an id from the ini", () => {
    expect(getModDetailsFromWorkshop(ESCAPE, fx.installPath)).toEqual([]);
    expect(findMapFoldersFromWorkshop(ESCAPE, fx.installPath)).toEqual([]);
    // A real item is still read.
    expect(getModDetailsFromWorkshop("1234567890", fx.installPath).map((m) => m.id)).toEqual(["RealMod"]);
  });

  it("GET /current-config does not return mod.info fields from a folder WorkshopItems= escapes to", async () => {
    fx.writeIni(`Mods=RealMod\nWorkshopItems=1234567890;${ESCAPE}\n`);
    const res = await runRoute("/current-config", "get", { query: {} });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().workshopModMap["1234567890"].map((m) => m.id)).toEqual(["RealMod"]);
    expect(JSON.stringify(res.getBody())).not.toMatch(/LeakedSecretMod|LeakedName/);
  });

  // Adversary pass: shapes that are not a plain run of ASCII digits.
  it.each([
    ["a traversal after digits", `1234567890/${ESCAPE}`],
    ["a Windows traversal", "..\\..\\..\\..\\elsewhere"],
    ["an absolute path", path.resolve("/elsewhere")],
    ["a trailing newline", "1234567890\n"],
    ["padding", " 1234567890"],
    ["full-width digits", "１２３"],
    ["an array", ["1234567890"]],
    ["an empty id", ""],
  ])("has no folder for %s", (_label, id) => {
    expect(getWorkshopPaths(id, "/srv/pz")).toEqual([]);
  });

  it("still gives the folders of a digits-only id, as a string or a number", () => {
    const fromString = getWorkshopPaths("1234567890", "/srv/pz");
    expect(fromString[0]).toBe(path.join("/srv/pz", "steamapps", "workshop", "content", "108600", "1234567890"));
    expect(getWorkshopPaths(1234567890, "/srv/pz")).toEqual(fromString);
    expect(getWorkshopPaths("0", "/srv/pz").length).toBeGreaterThan(0);
  });

  it("PUT /presets/:id refuses a workshopIds entry that is not an item id", async () => {
    for (const bad of [[ESCAPE], ["1234567890", "../.."], [{ id: "1" }], ["12;34"]]) {
      const res = await runRoute("/presets/:id", "put", { params: { id: "p1" }, body: { workshopIds: bad } });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().code).toBe(ErrorCode.MODS_INVALID_WORKSHOP_ID_FORMAT);
    }
    expect(updateModPreset).not.toHaveBeenCalled();
  });

  it("PUT /presets/:id still saves digits-only workshopIds", async () => {
    const res = await runRoute("/presets/:id", "put", {
      params: { id: "p1" },
      body: { workshopIds: ["1234567890", 2222222222, " 3333333333 "] },
    });
    expect(res.getStatusCode()).toBe(200);
    expect(updateModPreset).toHaveBeenCalledWith("p1", { workshop_ids: ["1234567890", "2222222222", "3333333333"] });
  });
});
