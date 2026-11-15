import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// Issue #312: on B42 the game logs a RuntimeException with a stack trace for
// every Java call that fails, even inside pcall. exportPlayerData used to call
// getType() on each trait (CharacterTrait has none) and getItemContainer() on
// every worn item (InventoryContainer only), flooding the server log.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_PATH = path.join(__dirname, '..', '..', 'pz-mod', 'PanelBridge', 'media', 'lua', 'server', 'PanelBridge.lua');

const BASE = `
getServerName = function() return "TestServer" end
CALLS = {}
local function track(name) CALLS[#CALLS + 1] = name end

FakeTrait = {}
function FakeTrait:toString() track("trait.toString") return "base:keen" end
function FakeTrait:getType() track("trait.getType") error("no getType on CharacterTrait") end

FakeTraitList = { FakeTrait }
function FakeTraitList:size() return 1 end
function FakeTraitList:get(i) return self[i + 1] end
FakeCharTraits = {}
function FakeCharTraits:getKnownTraits() return FakeTraitList end

FakeShirt = {}
function FakeShirt:getFullType() return "Base.Shirt" end
function FakeShirt:IsInventoryContainer() return false end
function FakeShirt:getItemContainer() track("shirt.getItemContainer") error("no getItemContainer") end

FakeWorn = {}
function FakeWorn:getItem() return FakeShirt end
function FakeWorn:getLocation() return "Shirt" end
FakeWornList = { FakeWorn }
function FakeWornList:size() return 1 end
function FakeWornList:get(i) return self[i + 1] end

FakePlayer = {}
function FakePlayer:getUsername() return "Fielder" end
function FakePlayer:getDisplayName() return "Fielder" end
function FakePlayer:getWornItems() return FakeWornList end
function FakePlayer:getInventory() return nil end
function FakePlayer:getCharacterTraits() return FakeCharTraits end
function FakePlayer:getDescriptor() return nil end

FakeOnlinePlayers = { FakePlayer }
function FakeOnlinePlayers:size() return 1 end
function FakeOnlinePlayers:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakeOnlinePlayers end
`;

describe('PanelBridge.lua exportPlayerData avoids calls that always fail on B42', () => {
  it('reads trait names with toString and never calls getType or getItemContainer on clothing', () => {
    const bridge = loadPanelBridge(LUA_PATH, BASE);
    bridge.run(`
      local ok, data = PanelBridgeModule.handlers.exportPlayerData({ username = "Fielder" })
      __TRAITS = table.concat(data.traits or {}, ",")
      __CALLS = table.concat(CALLS, ",")
    `);
    expect(bridge.getGlobal('__TRAITS')).toBe('base:keen');
    expect(bridge.getGlobal('__CALLS')).toBe('trait.toString');
  });
});
