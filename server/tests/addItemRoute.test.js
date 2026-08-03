import { beforeEach, describe, expect, it, vi } from "vitest";

const logPlayerAction = vi.fn();

vi.mock("../database/init.js", () => ({
  logPlayerAction,
  getPlayerLogs: vi.fn(),
  getPlayerNotes: vi.fn(),
  getPlayerNote: vi.fn(),
  upsertPlayerNote: vi.fn(),
  deletePlayerNote: vi.fn(),
  getPlayerStats: vi.fn(),
  getPlayerStat: vi.fn(),
  getSteamIdBans: vi.fn(),
  addSteamIdBan: vi.fn(),
  removeSteamIdBan: vi.fn(),
}));

const { default: router } = await import("../routes/players.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(path) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods.post,
  );
  return layer.route.stack[0].handle;
}

const addItem = vi.fn();
const addVehicle = vi.fn();

function createRequest(body) {
  return {
    body,
    app: { get: () => ({ addItem, addVehicle }) },
  };
}

async function giveItem(item) {
  const response = createResponse();
  await getHandler("/add-item")(
    createRequest({ username: "Tester", item, count: 1 }),
    response,
  );
  return response;
}

describe("POST /api/players/add-item item ID validation", () => {
  beforeEach(() => {
    addItem.mockReset();
    addItem.mockResolvedValue({ success: true });
    logPlayerAction.mockReset();
  });

  // Plenty of real item names start with a digit -- all rifle/pistol ammunition
  // in the base game, and every vehicle part in mods that name parts by model
  // year. Rejecting them made roughly a quarter of a modded catalogue
  // un-giveable even though PZ's own /additem accepts these IDs happily.
  it.each([
    "Base.556Clip",
    "Base.3030Bullets",
    "Base.308Box",
    "Base.3rdGenChevyCKseriesBumperFront0",
    "Base.69fordMustangFenderFrame",
  ])("accepts item IDs whose name starts with a digit (%s)", async (item) => {
    const response = await giveItem(item);

    expect(addItem).toHaveBeenCalledWith("Tester", item, 1);
    expect(response.status).not.toHaveBeenCalledWith(400);
  });

  // Weapon-attachment mods use hyphens and ampersands in item names.
  it.each([
    "MarzGuns.M&P_Suppressor",
    "MarzGuns.LRX-7_Laser",
    "MarzGuns.BrightPoint-5_Light",
  ])("accepts item IDs containing - or & (%s)", async (item) => {
    const response = await giveItem(item);

    expect(addItem).toHaveBeenCalledWith("Tester", item, 1);
    expect(response.status).not.toHaveBeenCalledWith(400);
  });

  it("still accepts ordinary letter-initial IDs", async () => {
    const response = await giveItem("Base.AssaultRifle");

    expect(addItem).toHaveBeenCalledWith("Tester", "Base.AssaultRifle", 1);
    expect(response.status).not.toHaveBeenCalledWith(400);
  });

  // The value is interpolated into an RCON command, so the characters that
  // matter are quotes, backslashes and whitespace -- not digits.
  it.each([
    'Base.Axe" ',
    "Base.Axe\\",
    "Base.Axe Base.Nails",
    "NoDotHere",
    "Base.",
    ".Axe",
  ])("still rejects malformed or injection-prone IDs (%j)", async (item) => {
    const response = await giveItem(item);

    expect(addItem).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
  });

  it("accepts the same IDs the sibling add-vehicle route already allows", async () => {
    addVehicle.mockResolvedValue({ success: true });
    const vehicleResponse = createResponse();
    await getHandler("/add-vehicle")(
      createRequest({ username: "Tester", vehicle: "Base.49powerWagonMP" }),
      vehicleResponse,
    );

    expect(vehicleResponse.status).not.toHaveBeenCalledWith(400);
    // The item route should not be stricter than the vehicle route about digits.
    const itemResponse = await giveItem("Base.49powerWagonMP");
    expect(itemResponse.status).not.toHaveBeenCalledWith(400);
  });
});
