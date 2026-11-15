import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, total-audit batch 3, item 3 -- panelbridge-total-audit-2026-08-30.
// exportPlayerData's worn-container bag scanner keys its `bagItems` table
// directly on `worn.location` -- WornItem.getLocation()'s raw return value --
// with no normalization. json.encode's own tostring(key) only runs at final
// serialization, AFTER this grouping decision has already been made, so it
// can't fix a key that never merged the way a stable string would have.
//
// This test does NOT claim to know the real B42 jar's getLocation() identity
// semantics (that would need a live server) -- it proves the shape of the
// bug directly: two worn containers that represent the SAME conceptual body
// location, via two DIFFERENT (but each internally stable) location objects
// that both stringify to "Torso", must merge into one bagInventory entry
// once the key is normalized. Without normalization, Lua's raw table keying
// treats the two different references as two DIFFERENT keys -- silently
// duplicative in Lua itself, and exactly the shape that produces a
// duplicate-key JSON object once json.encode's tostring(key) stringifies
// each independently at serialization time (a real client's JSON.parse
// would then silently keep only the last one).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_PATH = path.join(
  __dirname,
  '..',
  '..',
  'pz-mod',
  'PanelBridge',
  'media',
  'lua',
  'server',
  'PanelBridge.lua',
);

// Two worn containers that both sit at "Torso" (a backpack and a bag), via
// two DISTINCT table references that both stringify the same way -- stands
// in for "getLocation() returns a fresh, non-interned object for the same
// conceptual location" without asserting that's actually what the real jar
// does.
const BASE = `
getServerName = function() return "TestServer" end

LocationTorsoA = setmetatable({}, { __tostring = function() return "Torso" end })
LocationTorsoB = setmetatable({}, { __tostring = function() return "Torso" end })

FakeSubItem1 = {}
function FakeSubItem1:getFullType() return "Base.Bandage" end
function FakeSubItem1:getType() return "Bandage" end
function FakeSubItem1:getName() return "Bandage" end
FakeSubItemList1 = { FakeSubItem1 }
function FakeSubItemList1:size() return 1 end
function FakeSubItemList1:get(i) return self[i + 1] end
FakeContainer1 = {}
function FakeContainer1:getItems() return FakeSubItemList1 end

FakeSubItem2 = {}
function FakeSubItem2:getFullType() return "Base.Nails" end
function FakeSubItem2:getType() return "Nails" end
function FakeSubItem2:getName() return "Nails" end
FakeSubItemList2 = { FakeSubItem2 }
function FakeSubItemList2:size() return 1 end
function FakeSubItemList2:get(i) return self[i + 1] end
FakeContainer2 = {}
function FakeContainer2:getItems() return FakeSubItemList2 end

FakeBackpackItem = {}
function FakeBackpackItem:getFullType() return "Base.Backpack" end
function FakeBackpackItem:getCondition() return 100 end
function FakeBackpackItem:IsInventoryContainer() return true end
function FakeBackpackItem:getItemContainer() return FakeContainer1 end

FakeBagItem = {}
function FakeBagItem:getFullType() return "Base.Bag" end
function FakeBagItem:getCondition() return 100 end
function FakeBagItem:IsInventoryContainer() return true end
function FakeBagItem:getItemContainer() return FakeContainer2 end

FakeWorn1 = {}
function FakeWorn1:getItem() return FakeBackpackItem end
function FakeWorn1:getLocation() return LocationTorsoA end

FakeWorn2 = {}
function FakeWorn2:getItem() return FakeBagItem end
function FakeWorn2:getLocation() return LocationTorsoB end

FakeWornList = { FakeWorn1, FakeWorn2 }
function FakeWornList:size() return 2 end
function FakeWornList:get(i) return self[i + 1] end

FakePlayer = {}
function FakePlayer:getUsername() return "Fielder" end
function FakePlayer:getDisplayName() return "Fielder" end
function FakePlayer:getWornItems() return FakeWornList end
function FakePlayer:getInventory() return nil end
function FakePlayer:getCharacterTraits() return nil end
function FakePlayer:getDescriptor() return nil end
function FakePlayer:getTraits() return nil end

FakeOnlinePlayers = { FakePlayer }
function FakeOnlinePlayers:size() return 1 end
function FakeOnlinePlayers:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakeOnlinePlayers end
`;

describe('PanelBridge.lua handlers.exportPlayerData -- worn-container bagItems keying (Finding 4)', () => {
  it('two containers at the same conceptual location merge into one bagInventory entry, measured at the Lua table level itself', () => {
    const bridge = loadPanelBridge(LUA_PATH, BASE);
    // Measure pairs()-count directly in Lua rather than through the JS test
    // harness's own table conversion (which independently collapses ANY raw
    // table key -- unrelated to this bug -- so it can't distinguish "merged
    // because normalized" from "collapsed because the harness stringified a
    // plain object the same way regardless of content").
    bridge.run(`
      local ok, data = PanelBridgeModule.handlers.exportPlayerData({ username = "Fielder" })
      local count = 0
      for _ in pairs(data.bagInventory) do count = count + 1 end
      __BAG_KEY_COUNT = count
      __BAG_DIAG = data._diagnostics.bagItems
    `);

    const bagKeyCount = bridge.getGlobal('__BAG_KEY_COUNT');
    const bagDiag = bridge.getGlobal('__BAG_DIAG');

    // Both containers were found and scanned (2 sub-items total) -- that
    // part of the pipeline is unaffected by this fix either way.
    expect(bagDiag).toMatch(/^2 items in/);
    // The two "Torso" keys must merge into ONE entry once normalized --
    // not silently stay as two separate, never-to-be-reconciled raw-object
    // keys that would produce a duplicate "Torso" key in the final JSON.
    expect(bagKeyCount).toBe(1);
  });
});
