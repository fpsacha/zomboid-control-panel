import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';
import { PanelBridge } from '../services/panelBridge.js';

// SECURITY (2026-10-28): playWorldSound and playSoundNearPlayer passed the
// caller's radius and volume straight to addSound (createNoise clamped
// them). On a dedicated server the game sends the sound to every client
// within the radius, and each client then walks every chunk inside it: a
// radius of 1e7 from POST /sound/world (server.world_events, a default
// Moderator capability) froze every player's game. Both sides now keep
// radius to 10..500 and volume to 1..500.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_PATH = path.join(__dirname, '..', '..', 'pz-mod', 'PanelBridge', 'media', 'lua', 'server', 'PanelBridge.lua');

const STUBS = `
SOUNDS = {}
function addSound(player, x, y, z, radius, volume)
  SOUNDS[#SOUNDS + 1] = { radius = radius, volume = volume }
end
FakePlayer = {}
function FakePlayer:getUsername() return "Bob" end
function FakePlayer:getX() return 100 end
function FakePlayer:getY() return 200 end
function FakePlayer:getZ() return 0 end
FakeOnlinePlayers = { FakePlayer }
function FakeOnlinePlayers:size() return 1 end
function FakeOnlinePlayers:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakeOnlinePlayers end
`;

describe('PanelBridge.lua keeps a sound radius and volume in range', () => {
  it.each([
    ['playWorldSound', { x: 100, y: 200 }],
    ['playSoundNearPlayer', { username: 'Bob' }],
  ])('%s clamps a huge radius and volume', (handler, base) => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const result = bridge.callHandler(handler, { ...base, radius: 1e7, volume: 1e9 });

    expect(result.ok).toBe(true);
    expect(bridge.getGlobal('SOUNDS')).toEqual([{ radius: 500, volume: 500 }]);
    expect(result.data.radius).toBe(500);
  });

  // Adversary pass: values tonumber() still accepts.
  it.each([
    [{ radius: -1e7, volume: -5 }, { radius: 10, volume: 1 }],
    [{ radius: '1e7', volume: '0x7fffffff' }, { radius: 500, volume: 500 }],
    [{ radius: 'lots', volume: 'loud' }, { radius: 50, volume: 100 }],
    [{ radius: 200.7, volume: 80 }, { radius: 200, volume: 80 }],
    [{}, { radius: 50, volume: 100 }],
  ])('playWorldSound %j sounds as %j', (given, expected) => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.callHandler('playWorldSound', { x: 100, y: 200, ...given });
    expect(bridge.getGlobal('SOUNDS')).toEqual([expected]);
  });

  it('playWorldSound turns a NaN radius into the default and an infinite volume into 500', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run('PanelBridgeModule.handlers.playWorldSound({ x = 1, y = 1, radius = 0/0, volume = 1/0 })');
    expect(bridge.getGlobal('SOUNDS')).toEqual([{ radius: 50, volume: 500 }]);
  });
});

describe('the panel clamps sound commands for older PanelBridge versions too', () => {
  let tempDir;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  async function queuedArgs(action, args) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panelbridge-sound-clamp-'));
    const instance = new PanelBridge();
    instance.configure(tempDir, true);
    instance.isRunning = true;
    instance.config.commandTimeoutMs = 20;
    instance.getConnectionDiagnostics = vi.fn(() => ({ canSendCommands: true, summary: 'healthy' }));
    const enqueue = vi.spyOn(instance, '_enqueueCommand').mockImplementation(() => {});
    await instance.sendCommand(action, args).catch(() => {});
    return enqueue.mock.calls[0][2];
  }

  it.each(['playWorldSound', 'playSoundNearPlayer', 'createNoise'])('%s', async (action) => {
    expect(await queuedArgs(action, { x: 1, y: 2, username: 'Bob', radius: 1e7, volume: -3 }))
      .toEqual({ x: 1, y: 2, username: 'Bob', radius: 500, volume: 1 });
  });

  it('drops a radius that is no number, and leaves other commands alone', async () => {
    expect(await queuedArgs('playWorldSound', { x: 1, y: 2, radius: 'lots', volume: true }))
      .toEqual({ x: 1, y: 2 });
    expect(await queuedArgs('triggerSwarmEvent', { radius: 1e7 })).toEqual({ radius: 1e7 });
  });
});
