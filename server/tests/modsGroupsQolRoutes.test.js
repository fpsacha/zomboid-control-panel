import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";
import { UNPUBLISHED_WORKSHOP_RELEASE } from "./helpers/workshopRelease.js";

// Mod groups as the organising layer of the Mod Manager: enable or disable a
// whole group on the active server, suggested groups read off the enabled
// mods, and the notes kept on Workshop items.
//
// Real, unmocked database/init.js and mods router, with a real ini and real
// mod.info files on disk.
const db = await import("../database/init.js");
const { default: modsRouter } = await import("../routes/mods.js");
const { _resetWorkshopReleaseCacheForTests } = await import("../services/bridgeWorkshopRelease.js");
const runRoute = createRouteRunner(modsRouter);

const LISTED = "1111111111";
const UNLISTED = "2222222222";
const BRIDGE_WS = "3712345678";

let fx;

beforeAll(async () => {
  await db.initDatabase();
});

beforeEach(async () => {
  const state = await db.getDb();
  state.data.mod_groups = [];
  state.data.mod_notes = [];
  delete state.data.settings.modGroupsEnforce;
  delete state.data.settings.modGroupSuggestionsDismissed;
  fx = makeServerFixture({
    prefix: "mods-groups-qol-",
    ini: `Mods=x;core;y\nWorkshopItems=${LISTED}\nMap=Muldraugh, KY\n`,
  });
  state.data.servers = [{ ...fx.activeServer, name: "Test", isActive: true }];
});

afterEach(() => {
  fx.cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetWorkshopReleaseCacheForTests();
});

afterAll(async () => {
  const state = await db.getDb();
  state.data.mod_groups = [];
  state.data.mod_notes = [];
  state.data.servers = [];
});

const call = (path, method, req = {}) => runRoute(path, method, req);
const enable = (id) => call("/groups/:id/enable", "post", { params: { id }, body: {} });
const disable = (id, body = {}) => call("/groups/:id/disable", "post", { params: { id }, body });
const modInfo = (id, name, require) => `name=${name}\nid=${id}\n${require ? `require=${require}\n` : ""}`;

async function seed(...groups) {
  const state = await db.getDb();
  state.data.mod_groups = groups.map(([name, ...modIds], i) => ({
    id: `seed-${i}`,
    name,
    description: "",
    modIds,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  }));
}

async function setKeepTogether(id) {
  const state = await db.getDb();
  state.data.mod_groups.find((g) => g.id === id).keepTogether = true;
}

// PanelBridge delivered from the Steam Workshop on the active server: its
// Mods= / WorkshopItems= entries are managed in Settings > PanelBridge.
async function useWorkshopBridge() {
  vi.stubGlobal("PANEL_BRIDGE_WORKSHOP_JSON", UNPUBLISHED_WORKSHOP_RELEASE);
  vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", BRIDGE_WS);
  _resetWorkshopReleaseCacheForTests();
  const state = await db.getDb();
  state.data.servers = [
    {
      ...fx.activeServer,
      name: "Test",
      isActive: true,
      bridgeDelivery: "workshop",
      bridgeDeliverySwitch: { to: "workshop", at: "2026-01-01T00:00:00.000Z", by: null, bridgeStartedAt: null, workshopId: BRIDGE_WS },
    },
  ];
}

describe("POST /groups/:id/enable", () => {
  beforeEach(() => {
    fx.writeMod(LISTED, "KI5Core", modInfo("core", "KI5 Core"));
    fx.writeMod(LISTED, "KI5Addon", modInfo("addon", "KI5 Addon", "lib"));
    fx.writeMod(UNLISTED, "KI5Lib", modInfo("lib", "KI5 Library"));
  });

  it("adds the missing IDs in the group's order, adds their Workshop item, reports the rest, one write and one backup", async () => {
    await seed(["KI5", "lib", "core", "addon", "ghost"]);
    const res = await enable("seed-0");
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual({
      enabled: ["lib", "addon"],
      alreadyEnabled: ["core"],
      missing: ["ghost"],
      workshopItemsAdded: [UNLISTED],
      groupsAdjusted: [],
    });
    expect(fx.readIni()).toBe(`Mods=x;lib;core;addon;y\nWorkshopItems=${LISTED};${UNLISTED}\nMap=Muldraugh, KY\n`);
    expect(fx.backups()).toHaveLength(1);
  });

  it("does not write when every mod is enabled already, or none can be found", async () => {
    await seed(["On", "core", "x"], ["Nowhere", "ghost", "phantom"]);
    expect((await enable("seed-0")).getBody()).toEqual({
      enabled: [],
      alreadyEnabled: ["core", "x"],
      missing: [],
      workshopItemsAdded: [],
      groupsAdjusted: [],
    });
    expect((await enable("seed-1")).getBody()).toMatchObject({ enabled: [], missing: ["ghost", "phantom"] });
    expect(fx.backups()).toEqual([]);
    expect(fx.iniValue("Mods")).toBe("x;core;y");
  });

  // A map mod of the group came in without its map: Mods= and WorkshopItems=
  // got it, Map= did not, so the server loaded the mod and no map.
  it("puts the maps of a Workshop item it adds in front of Map=, like every add-mod flow", async () => {
    const mapDir = `${fx.writeMod(UNLISTED, "KI5Lib", modInfo("lib", "KI5 Library"))}/media/maps/KI5Town`;
    fs.mkdirSync(mapDir, { recursive: true });
    fs.writeFileSync(`${mapDir}/0_0.lotheader`, "");
    await seed(["KI5", "lib", "core"]);
    const res = await enable("seed-0");
    expect(res.getBody()).toMatchObject({ enabled: ["lib"], workshopItemsAdded: [UNLISTED], mapFoldersAdded: ["KI5Town"] });
    expect(fx.iniValue("Map")).toBe("KI5Town;Muldraugh, KY");
    expect(fx.backups()).toHaveLength(1);
  });

  it("places a group with no enabled member at the end, in the group's order", async () => {
    fx.writeIni(`Mods=x\nWorkshopItems=${LISTED}\n`);
    await seed(["KI5", "addon", "core"]);
    await enable("seed-0");
    expect(fx.iniValue("Mods")).toBe("x;addon;core");
  });

  it("then enforces the groups like a load-order save, and not when enforcement is off", async () => {
    fx.writeIni(`Mods=core;x;addon\nWorkshopItems=${LISTED}\n`);
    await seed(["KI5", "lib", "core", "addon"]);
    await setKeepTogether("seed-0");
    let res = await enable("seed-0");
    // lib went in before core; keepTogether then moved x after the block
    expect(res.getBody()).toMatchObject({ enabled: ["lib"], groupsAdjusted: ["addon", "x"] });
    expect(fx.iniValue("Mods")).toBe("lib;core;addon;x");

    fx.writeIni(`Mods=core;x;addon\nWorkshopItems=${LISTED}\n`);
    await call("/groups/enforce", "put", { body: { enforce: false } });
    res = await enable("seed-0");
    expect(res.getBody()).toMatchObject({ enabled: ["lib"], groupsAdjusted: [] });
    expect(fx.iniValue("Mods")).toBe("lib;core;x;addon");
  });

  it("keeps the other entries as they were written", async () => {
    fx.writeIni(`Mods=\\core; x \nWorkshopItems=${LISTED}\n`);
    await seed(["KI5", "core", "addon"]);
    await enable("seed-0");
    expect(fx.iniValue("Mods")).toBe("\\core;addon;x");
  });

  it("adds a Mods= and a WorkshopItems= line when the ini has none", async () => {
    fx.writeIni("PVP=true\n");
    await seed(["KI5", "lib"]);
    const res = await enable("seed-0");
    expect(res.getBody()).toMatchObject({ enabled: ["lib"], workshopItemsAdded: [UNLISTED] });
    expect(fx.readIni()).toBe(`PVP=true\nMods=lib\nWorkshopItems=${UNLISTED}\n`);
  });

  it("leaves PanelBridge's Workshop entries where they are", async () => {
    await useWorkshopBridge();
    fx.writeIni(`Mods=x;ZCPB;core\nWorkshopItems=${LISTED};${BRIDGE_WS}\n`);
    await seed(["KI5", "lib", "core", "addon"]);
    await enable("seed-0");
    expect(fx.iniValue("Mods")).toBe("x;ZCPB;lib;core;addon");
    expect(fx.iniValue("WorkshopItems")).toBe(`${LISTED};${BRIDGE_WS};${UNLISTED}`);
  });

  it("answers MODS_GROUP_NOT_FOUND for an unknown group and like the sibling routes without an ini", async () => {
    let res = await enable("nope");
    expect(res.getStatusCode()).toBe(404);
    expect(res.getBody().code).toBe("MODS_GROUP_NOT_FOUND");

    await seed(["KI5", "lib"]);
    fs.rmSync(fx.iniPath);
    res = await enable("seed-0");
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe("MODS_SERVER_INI_NOT_FOUND");
  });
});

describe("POST /groups/:id/disable", () => {
  beforeEach(() => {
    fx.writeIni(`Mods=lib;x;core;addon;fix;y\nWorkshopItems=${LISTED}\nMap=Muldraugh, KY\n`);
  });

  it("removes the group's mods from Mods=, leaves WorkshopItems= alone, one write and one backup", async () => {
    await seed(["KI5", "lib", "core", "addon", "ghost"]);
    const res = await disable("seed-0");
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual({ disabled: ["lib", "core", "addon"], keptShared: [], notEnabled: ["ghost"], keptManaged: [] });
    expect(fx.readIni()).toBe(`Mods=x;fix;y\nWorkshopItems=${LISTED}\nMap=Muldraugh, KY\n`);
    expect(fx.backups()).toHaveLength(1);
  });

  it("keeps a mod shared with another group that still has enabled mods, unless keepShared is false", async () => {
    await seed(["KI5", "lib", "core", "fix"], ["Fixes", "fix", "y"], ["Partly", "core", "ghost"]);
    let res = await disable("seed-0");
    // core's other group has no other enabled mod, so core goes
    expect(res.getBody()).toEqual({ disabled: ["lib", "core"], keptShared: ["fix"], notEnabled: [], keptManaged: [] });
    expect(fx.iniValue("Mods")).toBe("x;addon;fix;y");

    fx.writeIni(`Mods=lib;x;core;addon;fix;y\n`);
    res = await disable("seed-0", { keepShared: false });
    expect(res.getBody()).toMatchObject({ disabled: ["lib", "core", "fix"], keptShared: [] });
    expect(fx.iniValue("Mods")).toBe("x;addon;y");
  });

  it("keeps a library another group's enabled mods need, although that group has a member this server lacks", async () => {
    // Groups are shared by every server: "Cars" lists carB, which this server
    // does not have. Its enabled mods (x, addon) still need lib.
    await seed(["Fix", "lib", "fix"], ["Cars", "lib", "x", "addon", "carB"]);
    const res = await disable("seed-0");
    expect(res.getBody()).toEqual({ disabled: ["fix"], keptShared: ["lib"], notEnabled: [], keptManaged: [] });
    expect(fx.iniValue("Mods")).toBe("lib;x;core;addon;y");
  });

  it("lets a shared mod go when every other mod of the other group goes too", async () => {
    // The same group imported twice: nothing else keeps its mods on.
    await seed(["KI5", "lib", "core"], ["KI5 (2)", "lib", "core"]);
    const res = await disable("seed-0");
    expect(res.getBody()).toEqual({ disabled: ["lib", "core"], keptShared: [], notEnabled: [], keptManaged: [] });
  });

  it("removes every entry of a mod listed twice and keeps the others as written", async () => {
    fx.writeIni("Mods=\\lib;x;lib;\\y\n");
    await seed(["G", "lib"]);
    await disable("seed-0");
    expect(fx.iniValue("Mods")).toBe("x;\\y");
  });

  it("never removes PanelBridge's own mod while its Workshop delivery manages it", async () => {
    await useWorkshopBridge();
    fx.writeIni(`Mods=lib;ZCPB;core\nWorkshopItems=${LISTED};${BRIDGE_WS}\n`);
    await seed(["Everything", "lib", "ZCPB", "core"]);
    const res = await disable("seed-0");
    expect(res.getBody()).toEqual({ disabled: ["lib", "core"], keptShared: [], notEnabled: [], keptManaged: ["ZCPB"] });
    expect(fx.iniValue("Mods")).toBe("ZCPB");
    expect(fx.iniValue("WorkshopItems")).toBe(`${LISTED};${BRIDGE_WS}`);
  });

  it("treats PanelBridge's mod like any other with panel-installed delivery", async () => {
    fx.writeIni("Mods=lib;ZCPB\n");
    await seed(["Everything", "lib", "ZCPB"]);
    expect((await disable("seed-0")).getBody()).toMatchObject({ disabled: ["lib", "ZCPB"], keptManaged: [] });
    expect(fx.iniValue("Mods")).toBe("");
  });

  it("does not write when nothing of the group is enabled", async () => {
    await seed(["Off", "ghost"]);
    expect((await disable("seed-0")).getBody()).toEqual({ disabled: [], keptShared: [], notEnabled: ["ghost"], keptManaged: [] });
    expect(fx.backups()).toEqual([]);
  });

  it("refuses a keepShared that is not a boolean, and answers 404 for an unknown group", async () => {
    await seed(["KI5", "lib"]);
    for (const keepShared of ["false", 0, null]) {
      const res = await disable("seed-0", { keepShared });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toMatchObject({ code: "MODS_GROUP_INVALID", params: { field: "keepShared" } });
    }
    expect(fx.iniValue("Mods")).toBe("lib;x;core;addon;fix;y");
    const res = await disable("nope");
    expect(res.getStatusCode()).toBe(404);
    expect(res.getBody().code).toBe("MODS_GROUP_NOT_FOUND");
  });
});

describe("GET /groups/suggestions", () => {
  const LIB_WS = "3000000001";
  const PACK_WS = "3000000002";

  beforeEach(() => {
    fx.writeMod(LIB_WS, "Damn", modInfo("damnlib", "DAMN Library"));
    // one Workshop item per car; require= written the Build 42 way
    for (const [wsId, id, name] of [
      ["3000000011", "jeep", "[KI5] '82 Jeep J10"],
      ["3000000012", "bronco", "[KI5] '93 Ford Bronco"],
      ["3000000013", "pierce", "KI5 '90 Pierce Arrow"],
    ]) {
      fx.writeMod(wsId, id, modInfo(id, name, "\\damnlib"));
    }
    for (const n of [1, 2, 3, 4]) fx.writeMod(PACK_WS, `vfe${n}`, modInfo(`vfe${n}`, `Vanilla Firearms part ${n}`));
    // downloaded but not in WorkshopItems=: not part of the suggestions
    fx.writeMod(UNLISTED, "KI5Extra", modInfo("ki5extra", "KI5 Extra", "damnlib"));
    const listed = [LIB_WS, "3000000011", "3000000012", "3000000013", PACK_WS];
    fx.writeIni(`Mods=damnlib;jeep;x;bronco;pierce;vfe1;vfe2;vfe3;vfe4;ki5extra\nWorkshopItems=${listed.join(";")}\n`);
  });

  const suggestions = async () => {
    const res = await call("/groups/suggestions", "get");
    expect(res.getStatusCode()).toBe(200);
    return res.getBody().suggestions;
  };

  it("suggests a library with its dependents and a multi-mod Workshop item; the KI5 name family folds into the library's", async () => {
    const list = await suggestions();
    expect(list.map(({ kind, name, modIds }) => ({ kind, name, modIds }))).toEqual([
      { kind: "dependency", name: "DAMN Library", modIds: ["damnlib", "jeep", "bronco", "pierce"] },
      { kind: "workshop-item", name: "Vanilla Firearms part 1", modIds: ["vfe1", "vfe2", "vfe3", "vfe4"] },
    ]);
    for (const s of list) {
      expect(s.key).toMatch(/^(dependency|workshop-item|prefix)-[0-9a-f]{16}$/);
      expect(typeof s.reason).toBe("string");
    }
    expect((await suggestions()).map((s) => s.key)).toEqual(list.map((s) => s.key));
  });

  it("takes the Workshop item's title from the tracked mods when the panel has one", async () => {
    const state = await db.getDb();
    const before = state.data.tracked_mods;
    state.data.tracked_mods = [{ id: "t1", workshop_id: PACK_WS, name: "VFE: Vanilla Firearms Expansion", server_id: "server-1" }];
    try {
      const item = (await suggestions()).find((s) => s.kind === "workshop-item");
      expect(item.name).toBe("VFE: Vanilla Firearms Expansion");
    } finally {
      state.data.tracked_mods = before;
    }
  });

  it("leaves out a member set an existing group holds", async () => {
    await seed(["KI5 cars", "damnlib", "jeep", "bronco", "pierce", "ki5extra"]);
    expect((await suggestions()).map((s) => s.kind)).toEqual(["workshop-item"]);
  });

  it("remembers a dismissal for every admin", async () => {
    const [first, ...rest] = await suggestions();
    const res = await call("/groups/suggestions/dismiss", "post", { body: { key: first.key } });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual({ success: true });
    expect((await suggestions()).map((s) => s.key)).toEqual(rest.map((s) => s.key));
    expect(await db.getSetting("modGroupSuggestionsDismissed")).toEqual([first.key]);
    // dismissing twice keeps one entry
    await call("/groups/suggestions/dismiss", "post", { body: { key: first.key } });
    expect(await db.getSetting("modGroupSuggestionsDismissed")).toEqual([first.key]);
  });

  it("keeps the newest 500 dismissed keys", async () => {
    const keys = Array.from({ length: 501 }, (_, i) => `prefix-${i.toString(16).padStart(16, "0")}`);
    for (const key of keys) await call("/groups/suggestions/dismiss", "post", { body: { key } });
    const stored = await db.getSetting("modGroupSuggestionsDismissed");
    expect(stored).toHaveLength(500);
    expect(stored[0]).toBe(keys[1]);
    expect(stored[499]).toBe(keys[500]);
  });

  it("refuses a key that is not a suggestion key", async () => {
    for (const body of [undefined, {}, { key: "" }, { key: "prefix-xyz" }, { key: 5 }, { key: "x".repeat(100) }]) {
      const res = await call("/groups/suggestions/dismiss", "post", { body });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toMatchObject({ code: "MODS_GROUP_INVALID", params: { field: "key" } });
    }
    expect(await db.getSetting("modGroupSuggestionsDismissed")).toBeNull();
  });

  it("answers like the sibling routes without an ini", async () => {
    fs.rmSync(fx.iniPath);
    const res = await call("/groups/suggestions", "get");
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe("MODS_SERVER_INI_NOT_FOUND");
  });
});

describe("mod notes", () => {
  const put = (workshopId, body, user = { username: "alice" }) =>
    call("/notes/:workshopId", "put", { params: { workshopId }, body, user });
  const notes = async () => (await call("/notes", "get")).getBody().notes;

  it("starts empty", async () => {
    expect((await call("/notes", "get")).getBody()).toEqual({ notes: {} });
  });

  it("saves a note by Workshop id with who wrote it, and lists it", async () => {
    const res = await put("2392709985", { text: "  Needs the B42.13 patch \r\nAsk Sam first  " });
    expect(res.getStatusCode()).toBe(200);
    const { note } = res.getBody();
    expect(note).toEqual({ text: "Needs the B42.13 patch \nAsk Sam first", updatedAt: expect.any(String), updatedBy: "alice" });
    expect(new Date(note.updatedAt).toISOString()).toBe(note.updatedAt);
    expect(await notes()).toEqual({ 2392709985: note });
  });

  it("replaces a note and records the new author (null without a user)", async () => {
    await put("2392709985", { text: "first" });
    const { note } = (await put("2392709985", { text: "second" }, null)).getBody();
    expect(note).toMatchObject({ text: "second", updatedBy: null });
    expect(Object.keys(await notes())).toEqual(["2392709985"]);
  });

  it("deletes a note on an empty or blank text", async () => {
    await put("2392709985", { text: "keep me" });
    await put("2169435993", { text: "other" });
    let res = await put("2392709985", { text: "  \n " });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual({ note: null });
    expect(Object.keys(await notes())).toEqual(["2169435993"]);
    res = await put("2392709985", { text: "" });
    expect(res.getBody()).toEqual({ note: null });
  });

  it("takes 1000 characters and refuses 1001 with MODS_NOTE_TOO_LONG", async () => {
    expect((await put("1", { text: ` ${"n".repeat(1000)} ` })).getStatusCode()).toBe(200);
    const res = await put("2", { text: "n".repeat(1001) });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toMatchObject({ code: "MODS_NOTE_TOO_LONG", params: { max: 1000 } });
    expect(Object.keys(await notes())).toEqual(["1"]);
  });

  it("refuses a Workshop id that is not 1-15 digits", async () => {
    for (const id of ["abc", "12a", "1234567890123456", "", "-1", "1.5"]) {
      const res = await put(id, { text: "x" });
      expect(res.getStatusCode(), id).toBe(400);
      expect(res.getBody().code).toBe("MODS_INVALID_WORKSHOP_ID_LOWER");
    }
    expect(await notes()).toEqual({});
  });

  it("refuses a text that is not a string or holds a control character", async () => {
    for (const body of [undefined, {}, { text: 5 }, { text: null }, { text: ["x"] }, { text: `a${String.fromCharCode(7)}b` }]) {
      const res = await put("2392709985", body);
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().code).toBe("MODS_NOTE_INVALID");
    }
    expect((await put("2392709985", { text: "tab\tand\nline" })).getStatusCode()).toBe(200);
  });

  it("stops at 5000 notes with MODS_NOTE_LIMIT_REACHED, and still edits one", async () => {
    const state = await db.getDb();
    state.data.mod_notes = Array.from({ length: 5000 }, (_, i) => ({
      workshopId: String(i + 1),
      text: "n",
      updatedAt: "2026-10-01T00:00:00.000Z",
      updatedBy: null,
    }));
    let res = await put("999999", { text: "one too many" });
    expect(res.getStatusCode()).toBe(409);
    expect(res.getBody()).toMatchObject({ code: "MODS_NOTE_LIMIT_REACHED", params: { max: 5000 } });
    res = await put("1", { text: "edited" });
    expect(res.getStatusCode()).toBe(200);
    expect(state.data.mod_notes).toHaveLength(5000);
  });

  it("survives a database load (mod_notes is a known collection)", () => {
    const stored = [{ workshopId: "1", text: "kept", updatedAt: "2026-10-01T00:00:00.000Z", updatedBy: "alice" }];
    expect(db.validateData({ mod_notes: stored }).mod_notes).toEqual(stored);
    expect(db.validateData({}).mod_notes).toEqual([]);
  });
});
