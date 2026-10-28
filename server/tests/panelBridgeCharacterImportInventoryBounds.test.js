import { afterEach, describe, expect, it, vi } from "vitest";

// SECURITY (2026-10-28): POST /character/import (players.gm_tools: the
// default Moderator) and POST /command importPlayerData handed the bridge
// the whole uploaded file. PanelBridge parses it on the game thread and
// tried each listed item up to 100 times whether the item type existed or
// not, so a 1 MB file of made-up items stalled the server. The panel now
// sends only what importPlayerData reads (perks, inventory and two options,
// each item's type, numbers and bag contents), and refuses more than 2000
// items or an item type that is no plain name. The bridge bounds its own
// attempts too (panelBridgeImportPlayerDataAddAttempts.test.js).
vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(),
  getAllSettings: vi.fn(async () => ({})),
  setSetting: vi.fn(),
  getDb: vi.fn(),
  commitNow: vi.fn(),
  logBridgeCommand: vi.fn(async () => {}),
  logPlayerAction: vi.fn(async () => ({})),
  getRoleByName: vi.fn(async () => ({ capabilities: ["bridge.command", "players.gm_tools"] })),
}));

const { default: bridge } = await import("../services/panelBridge.js");
const { default: router } = await import("../routes/panelBridge.js");
const { ErrorCode } = await import("../utils/errorCodes.js");
const { BRIDGE_IMPORT_ARGS_MAX_BYTES } = await import("../utils/bridgeCommandArgs.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function post(path, body) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods.post);
  const res = createResponse();
  await layer.route.stack[layer.route.stack.length - 1].handle(
    { body, user: { username: "gm", role: "admin" } },
    res,
    () => {},
  );
  return res;
}

let sent;
function bridgeAnswers() {
  sent = [];
  bridge.isRunning = true;
  bridge.bridgePath = bridge.bridgePath || "/tmp/bridge";
  vi.spyOn(bridge, "sendCommand").mockImplementation(async (action, args) => {
    sent.push({ action, args });
    if (action === "exportPlayerData") return { success: true, data: { perks: {} } };
    return { success: true, data: { restored: { perks: 1, items: 0 } } };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  bridge.isRunning = false;
});

// Shaped like PanelBridge's exportPlayerData (serializeInventory): its own
// cap is 1000 items, bag contents included.
function exportedItem(i) {
  return {
    fullType: "Base.Nails",
    type: "Nails",
    name: `Nails #${i}`,
    count: 1,
    isFavorite: false,
    isEquipped: false,
    condition: 7,
    uses: 3,
    jobDelta: 0.30000001192093,
    useDelta: 0.10000000149012,
  };
}

function fullExport() {
  const bag = { ...exportedItem(0), fullType: "Base.Bag_ALICEpack_Army", contents: [] };
  for (let i = 1; i < 400; i++) bag.contents.push(exportedItem(i));
  const inventory = [bag];
  for (let i = 400; i < 1000; i++) inventory.push(exportedItem(i));
  return {
    version: "1.3",
    username: "Vet",
    perks: { Fitness: { level: 5, xp: 1234.5 }, Strength: { level: 3, xp: 99 } },
    traits: ["Athletic"],
    recipes: Array.from({ length: 400 }, (_, i) => `Make Something ${i}`),
    wornItems: [{ location: "Back", fullType: "Base.Bag_ALICEpack_Army", condition: 9 }],
    kills: { zombies: 12345 },
    inventory,
    bagInventory: { Back: bag.contents },
    _diagnostics: { inventory: "ok" },
  };
}

describe("POST /character/import sends the bridge only what it restores", () => {
  it("imports a full 1000-item export, without names, worn items, bag copies or recipes", async () => {
    bridgeAnswers();
    const res = await post("/character/import", { username: "Vet", data: fullExport(), options: { restoreInventory: true, junk: "x".repeat(1000) } });

    expect(res.status).not.toHaveBeenCalled();
    const { args } = sent.find((s) => s.action === "importPlayerData");
    expect(Object.keys(args.data).sort()).toEqual(["inventory", "perks"]);
    expect(args.options).toEqual({ restoreInventory: true });
    expect(args.data.perks).toEqual({ Fitness: { level: 5, xp: 1234.5 }, Strength: { level: 3, xp: 99 } });
    expect(args.data.inventory).toHaveLength(601);
    expect(args.data.inventory[1]).toEqual({
      fullType: "Base.Nails", count: 1, condition: 7, uses: 3, jobDelta: 0.30000001192093, useDelta: 0.10000000149012,
    });
    expect(args.data.inventory[0].contents).toHaveLength(399);
    expect(Buffer.byteLength(JSON.stringify(args))).toBeLessThan(BRIDGE_IMPORT_ARGS_MAX_BYTES / 2);
  });

  it("refuses more than 2000 items, bag contents included, before anything is sent", async () => {
    bridgeAnswers();
    const contents = Array.from({ length: 2000 }, (_, i) => ({ fullType: `Fake.Nope${i}`, count: 100 }));
    const res = await post("/character/import", {
      username: "Vet",
      data: { inventory: [{ fullType: "Base.Bag_Schoolbag", contents }] },
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: ErrorCode.PANELBRIDGE_CHARACTER_INVENTORY_INVALID }));
    expect(sent).toEqual([]);
  });

  it.each([
    ["a quote", 'Base.Nails"'],
    ["a backslash", "Base.\\Nails"],
    ["a control character", `Base.Nails${String.fromCharCode(1)}`],
    ["a 200-character name", `Base.${"N".repeat(200)}`],
    ["a number", 42],
  ])("refuses an item type with %s", async (_label, fullType) => {
    bridgeAnswers();
    const res = await post("/character/import", { username: "Vet", data: { inventory: [{ fullType }] } });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: ErrorCode.PANELBRIDGE_CHARACTER_INVENTORY_INVALID }));
    expect(sent).toEqual([]);
  });

  it("refuses an inventory that is not a list", async () => {
    bridgeAnswers();
    const res = await post("/character/import", { username: "Vet", data: { inventory: { a: { fullType: "Base.Axe" } } } });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(sent).toEqual([]);
  });

  // Adversary pass: the fields that are kept, stuffed.
  it("drops number fields that are no short number, and contents nested past four levels", async () => {
    bridgeAnswers();
    let deep = [{ fullType: "Base.Axe" }];
    for (let i = 0; i < 10; i++) deep = [{ fullType: "Base.Bag_Schoolbag", contents: deep }];
    const res = await post("/character/import", {
      username: "Vet",
      data: {
        perks: { Fitness: { level: 2, xp: "9".repeat(100000), note: "x".repeat(100000) } },
        inventory: [
          { fullType: "Base.Axe", count: "1".repeat(100000), condition: { a: 1 }, uses: "5" },
          ...deep,
        ],
      },
    });

    expect(res.status).not.toHaveBeenCalled();
    const { args } = sent.find((s) => s.action === "importPlayerData");
    expect(args.data.perks).toEqual({ Fitness: { level: 2 } });
    expect(args.data.inventory[0]).toEqual({ fullType: "Base.Axe", uses: "5" });
    let depth = 0;
    for (let level = args.data.inventory[1]; level; level = level.contents?.[0]) depth++;
    expect(depth).toBe(4);
    expect(Buffer.byteLength(JSON.stringify(args))).toBeLessThan(2048);
  });
});

describe("POST /command importPlayerData gets the same treatment", () => {
  it("refuses more than 2000 items", async () => {
    bridgeAnswers();
    const inventory = Array.from({ length: 2001 }, () => ({ fullType: "Base.Axe" }));
    const res = await post("/command", { action: "importPlayerData", args: { username: "Vet", data: { inventory } } });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: ErrorCode.PANELBRIDGE_CHARACTER_INVENTORY_INVALID }));
    expect(sent).toEqual([]);
  });

  it("sends a full export reduced to what the bridge reads", async () => {
    bridgeAnswers();
    const res = await post("/command", { action: "importPlayerData", args: { username: "Vet", data: fullExport() } });

    expect(res.status).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0].args.data).sort()).toEqual(["inventory", "perks"]);
    expect(sent[0].args.data.inventory[2]).not.toHaveProperty("name");
  });
});
