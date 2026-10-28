import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// SECURITY: PUT /presets/:id stored workshopIds/modIds as sent once they
// were arrays: any JSON value, nested to any depth (JSON.stringify of the
// whole database then throws, so no panel change is saved again) or of any
// size. Applying the preset wrote them into WorkshopItems=/Mods=, which
// every other writer limits to Workshop IDs and Mods= ids. Both are now
// checked when stored, and filtered again when applied (presets saved
// before the check).

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
  getModPresets: vi.fn(),
  updateModPreset: vi.fn(),
}));

const { getActiveServer, getModPresets, updateModPreset } = await import("../database/init.js");
const { ErrorCode } = await import("../utils/errorCodes.js");
const { default: router } = await import("../routes/mods.js");
const runRoute = createRouteRunner(router);

const put = (body) => runRoute("/presets/:id", "put", { params: { id: "p1" }, body });

function nested(depth) {
  let value = "1";
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

describe("PUT /presets/:id checks the ids it stores", () => {
  beforeEach(() => {
    updateModPreset.mockReset().mockImplementation(async (id, updates) => ({ id, ...updates }));
  });

  it("refuses a Workshop ID list holding a non-ID element, nested arrays included", async () => {
    for (const bad of [nested(5000), { a: 1 }, "../x", "abc", "", null, true]) {
      const res = await put({ workshopIds: ["1111111111", bad] });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().code).toBe(ErrorCode.MODS_INVALID_WORKSHOP_ID_TEMPLATE);
    }
    expect(updateModPreset).not.toHaveBeenCalled();
  });

  it("refuses a mod ID list holding a non-string or a value Mods= cannot hold", async () => {
    for (const bad of [nested(5000), { a: 1 }, 42, "", "x".repeat(201)]) {
      const res = await put({ modIds: ["Base", bad] });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().code).toBe(ErrorCode.MODS_SAVE_ORDER_MODID_STRING_REQUIRED);
    }
    expect(updateModPreset).not.toHaveBeenCalled();
  });

  it("refuses more than 2000 entries in either list", async () => {
    const workshop = await put({ workshopIds: Array.from({ length: 2001 }, (_, i) => String(100000 + i)) });
    expect(workshop.getStatusCode()).toBe(400);
    expect(workshop.getBody().code).toBe(ErrorCode.MODS_SAVE_ORDER_TOO_MANY);
    const mods = await put({ modIds: Array.from({ length: 2001 }, (_, i) => `Mod${i}`) });
    expect(mods.getStatusCode()).toBe(400);
    expect(mods.getBody().code).toBe(ErrorCode.MODS_SAVE_ORDER_TOO_MANY);
    expect(updateModPreset).not.toHaveBeenCalled();
  });

  it("stores valid lists, cleaned like Mods= reads them and without duplicates", async () => {
    const res = await put({
      workshopIds: ["1111111111", "2222222222", "1111111111"],
      modIds: ["Base", "\\Town", "Base", "3519629457"],
    });
    expect(res.getStatusCode()).toBe(200);
    expect(updateModPreset).toHaveBeenCalledWith("p1", {
      workshop_ids: ["1111111111", "2222222222"],
      mods: ["Base", "Town", "3519629457"],
    });
  });

  // Adversary pass: ids that look harmless but would add an entry or a key
  // to the ini line, or are not the digits they seem.
  it("refuses ids that carry list or key separators, padding, or number forms", async () => {
    for (const bad of ["123;456", "123=4", "123\n456", " 123", "0x1F", "1e5", "1".repeat(16), 1e20, -5, 1.5]) {
      const res = await put({ workshopIds: [bad] });
      expect(res.getStatusCode(), JSON.stringify(bad)).toBe(400);
    }
    for (const bad of ["A;B", "A=B", "A\nB", "A\rB", "A\u0000B", "A\u0085B"]) {
      const res = await put({ modIds: [bad] });
      expect(res.getStatusCode(), JSON.stringify(bad)).toBe(400);
    }
    expect(updateModPreset).not.toHaveBeenCalled();
  });
});

describe("POST /presets/:id/apply writes only valid ids from a preset saved before the check", () => {
  let fx;

  beforeEach(() => {
    fx = makeServerFixture({ prefix: "mods-preset-validate-" });
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
  });

  afterEach(() => fx.cleanup());

  it("drops the elements no other writer would put in WorkshopItems= or Mods=", async () => {
    fx.writeIni("Mods=Base\nWorkshopItems=1111111111\nMap=Muldraugh, KY\n");
    getModPresets.mockResolvedValue([
      {
        id: "p1",
        name: "Old",
        workshop_ids: ["2222222222", "../x", { a: 1 }, [["1"]], 3333333333, "2222222222"],
        mods: ["Town", { a: 1 }, "", ["Base"], 7, "Town", "Farm"],
      },
    ]);
    const res = await runRoute("/presets/:id/apply", "post", { params: { id: "p1" }, body: {} });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("WorkshopItems")).toBe("2222222222;3333333333");
    expect(fx.iniValue("Mods")).toBe("Town;Farm");
    expect(res.getBody()).toMatchObject({ workshopCount: 2, modCount: 2 });
  });
});
