import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// SECURITY (2026-10-28): importPlayerData's MAX_ITEMS = 500 counted items
// that were made. ItemContainer.AddItem(String) returns nil for a type that
// doesn't exist (after a ScriptManager lookup across every loaded mod, plus a
// DebugLog line), so a list of made-up item types ran AddItem up to 100 times
// per entry with no overall end: a 1 MB import held ~35,000 entries, about
// 3.5 million calls on the game thread. An entry now stops at its first
// failed add, and an import makes at most 1000 attempts over 2000 entries.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_PATH = path.join(__dirname, '..', '..', 'pz-mod', 'PanelBridge', 'media', 'lua', 'server', 'PanelBridge.lua');

const STUBS = `
CALLS = 0
ADDED = 0

FakeBag = {}
function FakeBag:getItemContainer() return FakeInventory end

FakeItem = {}

KNOWN = { ["Base.Axe"] = FakeItem, ["Base.Bag_Schoolbag"] = FakeBag }

FakeInventory = {}
function FakeInventory:AddItem(fullType)
  CALLS = CALLS + 1
  if CALLS > 200000 then error("runaway AddItem loop") end
  local item = KNOWN[fullType]
  if item then ADDED = ADDED + 1 end
  return item
end

FakePlayer = {}
function FakePlayer:getUsername() return "Fielder" end
function FakePlayer:getInventory() return FakeInventory end

FakeOnlinePlayers = { FakePlayer }
function FakeOnlinePlayers:size() return 1 end
function FakeOnlinePlayers:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakeOnlinePlayers end
`;

function importInventory(inventory) {
  const bridge = loadPanelBridge(LUA_PATH, STUBS);
  bridge.run(`
    local inventory = {}
    ${inventory}
    local ok, data = PanelBridgeModule.handlers.importPlayerData({ username = "Fielder", data = { inventory = inventory } })
    RESULT_OK = ok
    RESTORED = data and data.restored and data.restored.items
  `);
  return {
    ok: bridge.getGlobal('RESULT_OK'),
    restored: bridge.getGlobal('RESTORED'),
    calls: bridge.getGlobal('CALLS'),
    added: bridge.getGlobal('ADDED'),
  };
}

describe('PanelBridge.lua importPlayerData bounds AddItem calls, not only the items it made', () => {
  it('tries a missing item type once per entry, and 1000 times at most', () => {
    const outcome = importInventory(`
      for i = 1, 5000 do inventory[i] = { fullType = "Fake.Nope" .. i, count = 100 } end
    `);

    expect(outcome.ok).toBe(true);
    expect(outcome.calls).toBe(1000);
    expect(outcome.restored).toBe(0);
  });

  it('still adds the real items after a missing one', () => {
    const outcome = importInventory(`
      inventory[1] = { fullType = "Fake.Nope", count = 100 }
      inventory[2] = { fullType = "Base.Axe", count = 3 }
    `);

    expect(outcome.calls).toBe(4);
    expect(outcome.added).toBe(3);
    expect(outcome.restored).toBe(3);
  });

  it('still stops at 500 items made', () => {
    const outcome = importInventory(`
      for i = 1, 10 do inventory[i] = { fullType = "Base.Axe", count = 100 } end
    `);

    expect(outcome.added).toBe(500);
    expect(outcome.restored).toBe(500);
  });

  // Adversary pass: bags multiply their contents, once per bag made.
  it('caps attempts across bag contents too', () => {
    const outcome = importInventory(`
      local contents = {}
      for i = 1, 50 do contents[i] = { fullType = "Fake.Nope" .. i, count = 100 } end
      inventory[1] = { fullType = "Base.Bag_Schoolbag", count = 100, contents = contents }
    `);

    expect(outcome.calls).toBeLessThanOrEqual(1000);
  });

  it('walks at most 2000 entries that are not items at all', () => {
    const bridge = loadPanelBridge(LUA_PATH, `${STUBS}
      VISITS = 0
      local realType = type
      type = function(v)
        if realType(v) == "table" and rawget(v, "probe") then VISITS = VISITS + 1 end
        return realType(v)
      end
    `);
    bridge.run(`
      local inventory = {}
      for i = 1, 5000 do inventory[i] = { probe = true } end
      PanelBridgeModule.handlers.importPlayerData({ username = "Fielder", data = { inventory = inventory } })
    `);
    expect(bridge.getGlobal('VISITS')).toBe(2000);
  });
});
