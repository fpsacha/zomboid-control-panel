import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// SECURITY (2026-10-28): the game thread reads every inbox command file with
// PanelBridge.readPath and json.decode. readPath trimmed the file with
// gsub("^%s*(.-)%s*$"), which tries the trailing %s*$ at every character, so
// a run of k spaces anywhere in the file (inside a JSON string too) cost k^2
// steps: 8,000 spaces took 7 s in the game's own Kahlua, 16,000 ran it out of
// memory. json.decode rebuilt a string with `result = result .. piece` at
// every escape, copying everything decoded so far each time. A role allowed
// to send one bridge command could freeze the server with one request, and
// again after every restart (the cursor only moves after the decode).
//
// pcall can't stop a slow parse and fengari's instruction hook can't see
// inside gsub or a string concat, so these measure wall time: the inputs are
// sized so the old code needs several seconds here and the linear one a few
// hundred milliseconds at most.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_PATH = path.join(__dirname, '..', '..', 'pz-mod', 'PanelBridge', 'media', 'lua', 'server', 'PanelBridge.lua');

const BUDGET_MS = 1000;

const FILE_STUBS = `
FILES = {}
function getServerName() return "TestServer" end
function getFileReader(path)
  local value = FILES[path]
  if value == nil then return nil end
  local reader = { value = value, done = false }
  function reader:readLine()
    if self.done then return nil end
    self.done = true
    return self.value
  end
  function reader:close() end
  return reader
end
function getFileWriter(path)
  local writer = { path = path, value = "" }
  function writer:write(value) self.value = self.value .. value end
  function writer:close() FILES[self.path] = self.value end
  return writer
end
`;

const CMD1 = 'panelbridge/TestServer/inbox/cmd-0000000001.json';
const CMD2 = 'panelbridge/TestServer/inbox/cmd-0000000002.json';

function timed(fn) {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

describe('PanelBridge.lua reads a command file in linear time', () => {
  it('trims a file holding a 20,000-space run quickly, and keeps its content', () => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    const ms = timed(() => bridge.run(`
      FILES["x"] = '  {"a":"' .. string.rep(" ", 20000) .. '"}' .. string.rep(" ", 20000)
      local content = PanelBridgeModule.readPath("x")
      CONTENT_LENGTH = #content
      FIRST = content:sub(1, 1)
      LAST = content:sub(-1)
    `));

    expect(ms).toBeLessThan(BUDGET_MS);
    expect(bridge.getGlobal('CONTENT_LENGTH')).toBe(20008);
    expect(bridge.getGlobal('FIRST')).toBe('{');
    expect(bridge.getGlobal('LAST')).toBe('}');
  });

  it('trims every whitespace character the old pattern did, and an all-space file to ""', () => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    bridge.run(`
      FILES["ws"] = " \\t\\r\\n\\v\\f{}\\f\\v\\n\\r\\t "
      FILES["blank"] = string.rep(" ", 30000)
      TRIMMED = PanelBridgeModule.readPath("ws")
      BLANK = PanelBridgeModule.readPath("blank")
    `);
    expect(bridge.getGlobal('TRIMMED')).toBe('{}');
    expect(bridge.getGlobal('BLANK')).toBe('');
  });

  it('decodes a string of 60,000 escapes quickly, and right', () => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    const ms = timed(() => bridge.run(`
      local B = string.char(92)
      local doc = '{"a":"' .. string.rep(B .. '"' .. B .. 'n', 30000) .. '"}'
      local decoded = PanelBridgeModule.json.decode(doc)
      DECODED_LENGTH = #decoded.a
      DECODED_START = decoded.a:sub(1, 4)
    `));

    expect(ms).toBeLessThan(BUDGET_MS);
    expect(bridge.getGlobal('DECODED_LENGTH')).toBe(60000);
    expect(bridge.getGlobal('DECODED_START')).toBe('"\n"\n');
  });

  it('runs the next command after a padded and escape-heavy one, within one quick tick', () => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    const ms = timed(() => bridge.run(`
      local B = string.char(92)
      FILES["${CMD1}"] = '{"id":"c1","action":"ping","args":{"pad":"' .. string.rep(" ", 20000)
        .. '","esc":"' .. string.rep(B .. B, 30000) .. '"}}'
      FILES["${CMD2}"] = '{"id":"c2","action":"unknown"}'
      PanelBridgeModule.processCommands()
    `));

    expect(ms).toBeLessThan(BUDGET_MS);
    const state = bridge.getGlobal('PanelBridgeModule');
    expect(state.queueState.lastCommandSeq).toBe(2);
    expect(state.stats.commandsProcessed).toBe(2);
  });

  // Adversary pass: the other long runs a file can hold. Whitespace between
  // tokens, a long number and a long object key go through other scans.
  it('also stays quick on 200,000 spaces between tokens, a 200,000-digit number and an escape-heavy key', () => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    const ms = timed(() => bridge.run(`
      local B = string.char(92)
      local doc = '{' .. string.rep(" ", 200000) .. '"n":' .. string.rep("1", 200000)
        .. ',"' .. string.rep(B .. 't', 30000) .. '":true}'
      local decoded = PanelBridgeModule.json.decode(doc)
      HAS_NUMBER = type(decoded.n) == "number"
      HAS_KEY = decoded[string.rep("\\t", 30000)] == true
    `));

    expect(ms).toBeLessThan(BUDGET_MS);
    expect(bridge.getGlobal('HAS_NUMBER')).toBe(true);
    expect(bridge.getGlobal('HAS_KEY')).toBe(true);
  });
});

describe('PanelBridge.lua refuses what no panel writes', () => {
  it('skips an inbox command file over the size limit unread, and runs the next one', () => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    bridge.run(`
      PanelBridgeModule.MAX_INBOX_COMMAND_BYTES = 1000
      FILES["${CMD1}"] = '{"id":"c1","action":"ping","args":{"pad":"' .. string.rep("x", 2000) .. '"}}'
      FILES["${CMD2}"] = '{"id":"c2","action":"ping"}'
      PanelBridgeModule.processCommands()
    `);

    const state = bridge.getGlobal('PanelBridgeModule');
    expect(state.queueState.lastCommandSeq).toBe(2);
    // Only the second file reached a handler.
    expect(state.stats.commandsProcessed).toBe(1);
  });

  it('keeps reading a file at the limit', () => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    bridge.run(`
      local doc = '{"id":"c1","action":"ping","args":{"pad":"' .. string.rep("x", 900) .. '"}}'
      PanelBridgeModule.MAX_INBOX_COMMAND_BYTES = #doc + 1
      FILES["${CMD1}"] = doc
      PanelBridgeModule.processCommands()
    `);

    const state = bridge.getGlobal('PanelBridgeModule');
    expect(state.queueState.lastCommandSeq).toBe(1);
    expect(state.stats.commandsProcessed).toBe(1);
  });

  it('fails a document nested deeper than 128 levels, and still decodes 100', () => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    bridge.run(`
      local json = PanelBridgeModule.json
      DEEP = json.decode(string.rep("[", 200) .. string.rep("]", 200))
      DEEP_OBJECT = json.decode(string.rep('{"a":', 200) .. "1" .. string.rep("}", 200))
      local fine = json.decode(string.rep("[", 100) .. "7" .. string.rep("]", 100))
      for _ = 1, 99 do fine = fine[1] end
      FINE = fine[1]
    `);

    expect(bridge.getGlobal('DEEP')).toBeNull();
    expect(bridge.getGlobal('DEEP_OBJECT')).toBeNull();
    expect(bridge.getGlobal('FINE')).toBe(7);
  });
});
