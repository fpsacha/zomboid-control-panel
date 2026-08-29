import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// Regression coverage for the other "not a verification gap -- a lie" ruling
// from the full handler audit: handlers.spawnHordeNearPlayer/BehindPlayer's
// fallback branches (used when VirtualZombieManager isn't available) called a
// fire-and-forget horde API that returns no count, then set `spawned = count`
// anyway -- asserting the full requested amount as fact with zero evidence,
// while the code's own comment admits these APIs "may silently fail if the
// area isn't fully loaded on the server". That's a fabricated number, worse
// than no number, because the operator can't tell which branch produced it.

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

const COMMON_STUBS = `
ZombRand = function(n) return 0 end

FakePlayer = { x = 100, y = 100, z = 0, dir = "N", username = "Test" }
function FakePlayer:getX() return self.x end
function FakePlayer:getY() return self.y end
function FakePlayer:getZ() return self.z end
function FakePlayer:getDir() return self.dir end
function FakePlayer:getUsername() return self.username end

FakePlayerList = { FakePlayer }
function FakePlayerList:size() return 1 end
function FakePlayerList:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakePlayerList end
`;

const FALLBACK_ONLY_STUBS = COMMON_STUBS + `
FakeZPM = {}
function FakeZPM:createHordeInAreaTo(...) end
ZombiePopulationManager = { instance = FakeZPM }
`;

const VZM_STUBS = COMMON_STUBS + `
FakeVZM = {}
function FakeVZM:createRealZombieNow(x, y, z) return { x = x, y = y, z = z } end
VirtualZombieManager = { instance = FakeVZM }
`;

const NOOP_VZM_STUBS = COMMON_STUBS + `
FakeVZM = {}
function FakeVZM:createRealZombieNow(x, y, z) return nil end
VirtualZombieManager = { instance = FakeVZM }
`;

describe('PanelBridge.lua handlers.spawnHordeNearPlayer/BehindPlayer -- fallback branches must not fabricate a spawned count', () => {
  it('spawnHordeNearPlayer reports a real per-zombie count when VirtualZombieManager returns zombies (verified="confirmed")', () => {
    const bridge = loadPanelBridge(LUA_PATH, VZM_STUBS);
    const result = bridge.callHandler('spawnHordeNearPlayer', { username: 'Test', count: 5 });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
    expect(result.data.spawned).toBe(5);
    expect(result.data.method).toBe('VirtualZombieManager.createRealZombieNow');
  });

  it('does not report success when the coordinate spawn method creates no zombies', () => {
    const bridge = loadPanelBridge(LUA_PATH, NOOP_VZM_STUBS);
    const result = bridge.callHandler('spawnHordeNearPlayer', { username: 'Test', count: 5 });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/no zombies were created/);
  });

  it('spawnHordeNearPlayer must NOT claim a spawned count from the createHordeInAreaTo fallback (verified="unverifiable", spawned unset)', () => {
    const bridge = loadPanelBridge(LUA_PATH, FALLBACK_ONLY_STUBS);
    const result = bridge.callHandler('spawnHordeNearPlayer', { username: 'Test', count: 50 });

    expect(result.ok).toBe(true);
    expect(result.data.method).toBe('createHordeInAreaTo');
    // Before the fix, spawned was hardcoded to the requested count (50) here
    // with zero evidence any zombie actually appeared.
    expect(result.data.verified).toBe('unverifiable');
    expect(result.data.spawned == null).toBe(true);
  });

  it('spawnHordeBehindPlayer must NOT claim a spawned count from the createHordeInAreaTo fallback (verified="unverifiable", spawned unset)', () => {
    const bridge = loadPanelBridge(LUA_PATH, FALLBACK_ONLY_STUBS);
    const result = bridge.callHandler('spawnHordeBehindPlayer', { username: 'Test', count: 50 });

    expect(result.ok).toBe(true);
    expect(result.data.method).toBe('createHordeInAreaTo');
    expect(result.data.verified).toBe('unverifiable');
    expect(result.data.spawned == null).toBe(true);
  });

  it('spawnHordeBehindPlayer does not report success when the coordinate spawn method creates no zombies', () => {
    const bridge = loadPanelBridge(LUA_PATH, NOOP_VZM_STUBS);
    const result = bridge.callHandler('spawnHordeBehindPlayer', { username: 'Test', count: 5 });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/no zombies were created/);
  });
});
