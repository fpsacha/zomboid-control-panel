import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Test PanelBridge command serialization logic
// Tests the command queue and file write serialization without actual file I/O

describe('PanelBridge command serialization', () => {
  let commands;

  beforeEach(() => {
    commands = { commands: [] };
  });

  function appendCommand(id, action, args) {
    commands.commands.push({
      id,
      action,
      args,
      timestamp: Date.now()
    });
    return commands;
  }

  it('should append commands to the queue', () => {
    appendCommand('cmd-1', 'ping', {});
    appendCommand('cmd-2', 'getServerInfo', {});
    expect(commands.commands).toHaveLength(2);
    expect(commands.commands[0].action).toBe('ping');
    expect(commands.commands[1].action).toBe('getServerInfo');
  });

  it('should include all required fields', () => {
    appendCommand('cmd-1', 'healPlayer', { username: 'TestUser' });
    const cmd = commands.commands[0];
    expect(cmd).toHaveProperty('id', 'cmd-1');
    expect(cmd).toHaveProperty('action', 'healPlayer');
    expect(cmd).toHaveProperty('args');
    expect(cmd.args.username).toBe('TestUser');
    expect(cmd).toHaveProperty('timestamp');
    expect(typeof cmd.timestamp).toBe('number');
  });

  it('should serialize to valid JSON', () => {
    appendCommand('cmd-1', 'teleportPlayer', { username: 'P1', x: 100, y: 200, z: 0 });
    const json = JSON.stringify(commands, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.commands).toHaveLength(1);
    expect(parsed.commands[0].args.x).toBe(100);
  });

  it('should handle special characters in args safely', () => {
    appendCommand('cmd-1', 'sendToServerChat', { message: 'Hello "world" & <friends>' });
    const json = JSON.stringify(commands);
    const parsed = JSON.parse(json);
    expect(parsed.commands[0].args.message).toBe('Hello "world" & <friends>');
  });
});

// Test result deduplication logic
describe('PanelBridge result deduplication', () => {
  let processedResults;

  beforeEach(() => {
    processedResults = new Map();
  });

  it('should detect duplicate results', () => {
    const id = 'result-1';
    processedResults.set(id, Date.now());

    const isDuplicate = processedResults.has(id);
    expect(isDuplicate).toBe(true);
  });

  it('should not flag new results as duplicates', () => {
    processedResults.set('result-1', Date.now());
    const isDuplicate = processedResults.has('result-2');
    expect(isDuplicate).toBe(false);
  });

  it('should clean up old entries', () => {
    const oldTime = Date.now() - 60000; // 1 minute ago
    processedResults.set('old-1', oldTime);
    processedResults.set('old-2', oldTime);
    processedResults.set('new-1', Date.now());

    // Simulate cleanup (remove entries older than 30s)
    const cutoff = Date.now() - 30000;
    for (const [id, timestamp] of processedResults) {
      if (timestamp < cutoff) {
        processedResults.delete(id);
      }
    }

    expect(processedResults.size).toBe(1);
    expect(processedResults.has('new-1')).toBe(true);
  });
});

// Test pending command timeout tracking
describe('PanelBridge pending commands', () => {
  let pendingCommands;

  beforeEach(() => {
    pendingCommands = new Map();
  });

  afterEach(() => {
    // Clear all timeouts
    for (const [, cmd] of pendingCommands) {
      if (cmd.timeout) clearTimeout(cmd.timeout);
    }
    pendingCommands.clear();
  });

  it('should track pending commands with timeout', () => {
    const timeout = setTimeout(() => {}, 10000);
    pendingCommands.set('cmd-1', {
      resolve: vi.fn(),
      reject: vi.fn(),
      timeout,
      action: 'ping',
      timestamp: Date.now()
    });

    expect(pendingCommands.size).toBe(1);
    expect(pendingCommands.get('cmd-1').action).toBe('ping');
    clearTimeout(timeout);
  });

  it('should resolve and clean up on result', () => {
    const resolveFn = vi.fn();
    const timeout = setTimeout(() => {}, 10000);
    pendingCommands.set('cmd-1', {
      resolve: resolveFn,
      reject: vi.fn(),
      timeout,
      action: 'ping',
      timestamp: Date.now()
    });

    // Simulate result received
    const pending = pendingCommands.get('cmd-1');
    clearTimeout(pending.timeout);
    pending.resolve({ success: true });
    pendingCommands.delete('cmd-1');

    expect(resolveFn).toHaveBeenCalledWith({ success: true });
    expect(pendingCommands.size).toBe(0);
  });

  it('should reject all pending on stop', () => {
    const rejectFns = [];
    for (let i = 0; i < 3; i++) {
      const reject = vi.fn();
      rejectFns.push(reject);
      const timeout = setTimeout(() => {}, 10000);
      pendingCommands.set(`cmd-${i}`, {
        resolve: vi.fn(),
        reject,
        timeout,
        action: 'test',
        timestamp: Date.now()
      });

    }

    // Simulate bridge stop
    for (const [id, pending] of pendingCommands) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Bridge stopped'));
    }
    pendingCommands.clear();

    rejectFns.forEach(fn => {
      expect(fn).toHaveBeenCalledWith(expect.objectContaining({ message: 'Bridge stopped' }));
    });
    expect(pendingCommands.size).toBe(0);
  });
});

// sweep-findings, panelBridge #1: cleanupResultTracking()'s stale-pending
// sweep used to clearTimeout(cmd.timeout) and delete the map entry WITHOUT
// ever calling cmd.reject() -- same failure class as an isChecking latch
// left set on an early return. sendCommand()'s real timeout closure captures
// reject directly (not through the map), so this was normally harmless, but
// after a long stall/suspend Node fires every now-overdue timer in one
// catch-up burst, and this interval-driven sweep's tick (triggers on
// wall-clock age > maxPendingAge, already true for anything in flight across
// a real suspend) can win the race against the individual command's own
// timeout. When it wins, the real timeout never fires, the sweep deletes the
// map entry instead, and the sendCommand() promise is left with no path left
// to ever settle -- it hangs forever, and a late-arriving real result finds
// no pending entry in processResult() and is silently dropped too.
describe('PanelBridge cleanupResultTracking: stale pending commands must be rejected, not just dropped', () => {
  it('rejects a stale pending command instead of leaving its promise unsettled forever (regression guard)', async () => {
    const { PanelBridge } = await import('../services/panelBridge.js');
    const bridge = new PanelBridge();

    const resolveFn = vi.fn();
    const rejectFn = vi.fn();
    const timeout = setTimeout(() => {}, 10000);
    // Older than maxPendingAge (commandTimeoutMs default 15000 * 2 = 30000ms).
    const staleTimestamp = Date.now() - 31000;
    bridge.pendingCommands.set('cmd-stale', {
      resolve: resolveFn,
      reject: rejectFn,
      timeout,
      action: 'ping',
      timestamp: staleTimestamp,
    });

    bridge.cleanupResultTracking();

    expect(bridge.pendingCommands.has('cmd-stale')).toBe(false);
    expect(rejectFn).toHaveBeenCalledTimes(1);
    expect(rejectFn.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(rejectFn.mock.calls[0][0].message).toMatch(/ping/);
    expect(resolveFn).not.toHaveBeenCalled();
  });

  it('leaves a fresh pending command untouched', async () => {
    const { PanelBridge } = await import('../services/panelBridge.js');
    const bridge = new PanelBridge();

    const rejectFn = vi.fn();
    const timeout = setTimeout(() => {}, 10000);
    bridge.pendingCommands.set('cmd-fresh', {
      resolve: vi.fn(),
      reject: rejectFn,
      timeout,
      action: 'ping',
      timestamp: Date.now(),
    });

    try {
      bridge.cleanupResultTracking();

      expect(bridge.pendingCommands.has('cmd-fresh')).toBe(true);
      expect(rejectFn).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timeout);
    }
  });
});

describe('PanelBridge queue recovery', () => {
  it('resumes command numbering after a cleared SFTP cache', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-bridge-test-'));
    try {
      const { PanelBridge } = await import('../services/panelBridge.js');
      fs.writeFileSync(
        path.join(temporaryDirectory, 'queue-state-lua.json.txt'),
        JSON.stringify({ lastCommandSeq: 42 }),
      );
      const bridge = new PanelBridge();
      bridge.configure(temporaryDirectory, true);

      bridge.ensureQueueProtocol();

      expect(bridge.queueState.nextCommandSeq).toBe(43);
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe('PanelBridge vehicle compatibility', () => {
  it('reads the vehicle list by calling get, not by testing it as a field', async () => {
    const luaPath = path.resolve(process.cwd(), 'pz-mod/PanelBridge/media/lua/server/PanelBridge.lua');
    const lua = await readFile(luaPath, 'utf8');
    const vehicleAt = lua.match(/local function vehicleAt\(vehicles, i\)([\s\S]*?)\nend/);

    // Build 42 exposes get(i) as a callable method while `vehicles.get`
    // reads nil, so a field test silently returns zero vehicles (v1.7.23).
    expect(vehicleAt?.[1]).toContain('PanelBridge.invoke(vehicles, "get", i)');
    expect(vehicleAt?.[1]).not.toContain('vehicles.get');
  });

  it('never guards a Java method by reading it as a field', async () => {
    const luaPath = path.resolve(process.cwd(), 'pz-mod/PanelBridge/media/lua/server/PanelBridge.lua');
    const lua = await readFile(luaPath, 'utf8');

    // `obj.method and obj:method()` substitutes a fallback value whenever the
    // method is callable but not readable as a field. That produced empty
    // collections in v1.7.17/v1.7.21/v1.7.23 and fabricated game-time values.
    const offenders = lua
      .split(/\r?\n/)
      .map((line, index) => ({ line: line.replace(/--.*$/, ''), number: index + 1 }))
      .filter(({ line }) => /(\w+)\.(\w+)\s+and\s+\1:\2\s*\(/.test(line))
      .map(({ line, number }) => `${number}: ${line.trim()}`);

    expect(offenders).toEqual([]);
  });

  it('uses a stringified Java class wrapper for capability cache keys', async () => {
    const luaPath = path.resolve(process.cwd(), 'pz-mod/PanelBridge/media/lua/server/PanelBridge.lua');
    const lua = await readFile(luaPath, 'utf8');
    const capabilityKey = lua.match(/local function capabilityKey\(obj, methodName\)([\s\S]*?)\nend/);

    expect(capabilityKey?.[1]).toContain('if type(obj) == "table" then');
    expect(capabilityKey?.[1]).toContain('obj:getClass()');
    expect(capabilityKey?.[1]).toContain('tostring(classValue) .. "#" .. methodName');
    expect(capabilityKey?.[1]).not.toContain(':getName()');
  });

  it('never gates a Java call on an `if obj.method then` field test', async () => {
    const luaPath = path.resolve(process.cwd(), 'pz-mod/PanelBridge/media/lua/server/PanelBridge.lua');
    const lua = await readFile(luaPath, 'utf8');
    const lines = lua.split(/\r?\n/).map(line => line.replace(/--.*$/, ''));

    // Same defect as above in statement form: the guarded block is skipped
    // entirely when the method is callable but the field reads nil, so the
    // handler silently does nothing and still reports success. Ratcheted at
    // zero — use PanelBridge.invoke/tryGet, which probe by calling.
    const offenders = [];
    lines.forEach((line, index) => {
      const guard = line.match(/(?:if|elseif)\s+(\w+)\.(\w+)\s+then/);
      if (!guard) return;
      const [, base, method] = guard;
      const window = lines.slice(index, index + 4).join('\n');
      if (new RegExp(`\\b${base}:${method}\\s*\\(`).test(window)) {
        offenders.push(`${index + 1}: ${line.trim()}`);
      }
    });

    expect(offenders).toEqual([]);
  });

  it('keeps the Lua runtime version aligned with the manifest', async () => {
    const luaPath = path.resolve(process.cwd(), 'pz-mod/PanelBridge/media/lua/server/PanelBridge.lua');
    const modInfoPath = path.resolve(process.cwd(), 'pz-mod/PanelBridge/mod.info');
    const [lua, modInfo] = await Promise.all([readFile(luaPath, 'utf8'), readFile(modInfoPath, 'utf8')]);
    const headerVersion = lua.match(/^ {4}Version: ([^\r\n]+)/m)?.[1];
    const runtimeVersion = lua.match(/^ {4}VERSION = "([^"]+)",/m)?.[1];
    const manifestVersion = modInfo.match(/^modversion=(.+)$/m)?.[1];

    expect(runtimeVersion).toBe(headerVersion);
    expect(manifestVersion).toBe(headerVersion);
  });
});

describe('PanelBridge climate compatibility', () => {
  it('uses the direct Build 42 ThunderStorm event for lightning', async () => {
    const luaPath = path.resolve(
      process.cwd(),
      'pz-mod/PanelBridge/media/lua/server/PanelBridge.lua',
    );
    const source = await readFile(luaPath, 'utf8');
    const start = source.indexOf('handlers.triggerLightning = function(args)');
    const end = source.indexOf('-- Applies a climate float', start);
    const handler = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(handler).toContain('getThunderStorm');
    expect(handler).toContain('triggerThunderEvent');
    expect(handler.indexOf('triggerThunderEvent')).toBeLessThan(
      handler.indexOf('transmitServerTriggerLightning'),
    );
  });
});

describe('PanelBridge player healing compatibility', () => {
  const bridgePath = path.resolve(
    import.meta.dirname,
    '../../pz-mod/PanelBridge/media/lua/server/PanelBridge.lua',
  );

  it('uses the documented body-part collection without probing unavailable APIs', async () => {
    const source = await readFile(bridgePath, 'utf8');
    const healStart = source.indexOf('handlers.healPlayer = function(args)');
    const killStart = source.indexOf('-- Kill a player', healStart);
    const healHandler = source.slice(healStart, killStart);

    expect(healStart).toBeGreaterThanOrEqual(0);
    expect(killStart).toBeGreaterThan(healStart);
    expect(healHandler).toContain('bodyDamage:getBodyParts()');
    expect(healHandler).toContain('part:RestoreToFullHealth()');
    expect(healHandler).toContain('part:SetFakeInfected(false)');
    expect(healHandler).not.toContain('setFakeInfected');
    expect(healHandler).not.toContain('getNumOfBodyParts');
    expect(healHandler).not.toContain('PanelBridge.invoke(');
    expect(healHandler).not.toContain('player:getStats()');
    expect(healHandler).not.toContain('player:getMoodles()');
  });

  it('uses Build 42 native death and reports a failed verification', async () => {
    const source = await readFile(bridgePath, 'utf8');
    const killStart = source.indexOf('handlers.killPlayer = function(args)');
    const godModeStart = source.indexOf('-- Set player\'s godmode', killStart);
    const killHandler = source.slice(killStart, godModeStart);

    expect(killStart).toBeGreaterThanOrEqual(0);
    expect(godModeStart).toBeGreaterThan(killStart);
    expect(killHandler).toContain('PanelBridge.invoke(player, "Kill", nil)');
    // 2026-08-30 (total-audit return-contract fix): the old single
    // `return isDead, { ... }` never populated a third (error) value on
    // failure, so the dispatcher forwarded a null error to the panel while
    // the real reason sat unread in data.message. Now branches explicitly
    // and puts a real error string in the failure path's third slot, same
    // shape as handlers.teleportPlayer. See
    // panelBridgeKillPlayerHonestFailure.test.js for the behavioural
    // coverage this source-shape check can't provide on its own.
    expect(killHandler).toContain('if not isDead then');
    expect(killHandler).toMatch(/return false, \{[\s\S]*?\}, "/);
    expect(killHandler).toContain('return true, {');
    expect(killHandler).not.toContain('setOverallBodyHealth');
    expect(killHandler).not.toContain('DoDeath');
  });
});

describe('PanelBridge Java capability caching', () => {
  const bridgePath = path.resolve(
    import.meta.dirname,
    '../../pz-mod/PanelBridge/media/lua/server/PanelBridge.lua',
  );

  it('stops retrying a method that never succeeds, even without an error message', async () => {
    const source = await readFile(bridgePath, 'utf8');
    const invoke = source.match(/function PanelBridge\.invoke\(obj, methodName, \.\.\.\)([\s\S]*?)\nend/);

    // Build 42 raises an empty RuntimeException for a missing method, so the
    // error-text test alone never matched and the engine retraced every call.
    expect(invoke?.[1]).toContain('failures >= MAX_METHOD_FAILURES');
    expect(invoke?.[1]).toContain('PanelBridge.methodCapabilities[key] = false');
    // A method that already worked must survive one broken modded object.
    expect(invoke?.[1]).toContain('PanelBridge.methodCapabilities[key] ~= true');
    expect(invoke?.[1]).toContain('PanelBridge.methodFailures[key] = nil');
  });

  it('still identifies a class when the Java wrapper rejects getClass', async () => {
    const source = await readFile(bridgePath, 'utf8');
    const capabilityKey = source.match(/local function capabilityKey\(obj, methodName\)([\s\S]*?)\nend/);

    // Without a key nothing can be cached, so the call retraces forever.
    expect(capabilityKey?.[1]).toContain('@%x+');
  });
});

describe('PanelBridge game-time compatibility', () => {
  it('uses only documented Build 42 clock methods without speculative probes', async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, '../../pz-mod/PanelBridge/media/lua/server/PanelBridge.lua'),
      'utf8',
    );
    const handlerStart = source.indexOf('handlers.getGameTime = function(args)');
    const handlerEnd = source.indexOf('-- Set game time', handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handler).toContain('gameTime:getTimeOfDay()');
    expect(handler).toContain('gameTime:getWorldAgeHours()');
    expect(handler).toContain('gameTime:getNightsSurvived()');
    expect(handler).toContain('math.floor((timeOfDay - hour) * 60)');
    expect(handler).not.toContain('safeGetValue(');
    expect(handler).not.toContain('PanelBridge.invoke(');
    expect(handler).not.toContain('getMinutes');
    expect(handler).not.toContain('getDayOfWeek');
    expect(handler).not.toContain('getTimeSinceApo');
    expect(handler).not.toContain('getMoon');
  });
});
