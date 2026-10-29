import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// SECURITY (2026-10-28): POST /panel-bridge/command handed the caller's args
// to the mod unchecked. A Moderator (players.gm_tools reaches setGodMode,
// setInvisible, setNoclip and healPlayer here) could queue up to 1 MB per
// command for the game thread to parse, and args nested deeper than
// JSON.stringify can go made the route's own log line throw, so the catch
// stored them in db.json's bridge_logs, where they broke every later save.

const getActiveServer = vi.fn(async () => null);
const logBridgeCommand = vi.fn(async () => {});
const ROLES = {
  gm_tools_only: { capabilities: ["players.gm_tools"] },
  bridge_command_only: { capabilities: ["bridge.command"] },
};
const getRoleByName = vi.fn(async (name) => ROLES[name] || null);

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getServer: vi.fn(),
  getAllSettings: vi.fn(async () => ({})),
  setSetting: vi.fn(),
  getDb: vi.fn(),
  commitNow: vi.fn(),
  logBridgeCommand,
  getRoleByName,
}));

const { default: bridge, PanelBridge } = await import("../services/panelBridge.js");
const { default: router } = await import("../routes/panelBridge.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function postCommand(action, args, role) {
  const res = createResponse();
  await getHandler("/command", "post")({ user: { role }, body: { action, args } }, res, () => {});
  return res;
}

function nested(depth) {
  return JSON.parse(`${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`);
}

describe("POST /panel-bridge/command bounds what it sends the mod", () => {
  let sendCommand;

  beforeEach(() => {
    bridge.isRunning = true;
    bridge.bridgePath = "/fake/bridge/path";
    sendCommand = vi.spyOn(bridge, "sendCommand").mockResolvedValue({ success: true });
    logBridgeCommand.mockClear();
  });

  afterEach(() => {
    sendCommand.mockRestore();
    bridge.isRunning = false;
    bridge.bridgePath = null;
  });

  it.each(["setGodMode", "setInvisible", "setNoclip"])(
    "sends %s only the username and enabled flag a Moderator gave it",
    async (action) => {
      const res = await postCommand(
        action,
        { username: "Bob", enabled: true, pad: " ".repeat(200000) },
        "gm_tools_only",
      );

      expect(res.status).not.toHaveBeenCalled();
      expect(sendCommand).toHaveBeenCalledWith(action, { username: "Bob", enabled: true });
    },
  );

  it("sends healPlayer only the username", async () => {
    await postCommand("healPlayer", { username: "Bob", extra: { deep: [1, 2, 3] } }, "gm_tools_only");
    expect(sendCommand).toHaveBeenCalledWith("healPlayer", { username: "Bob" });
  });

  // Adversary pass: the two kept fields are the ones left to stuff.
  it("refuses a GM command whose username is no player name, and drops an enabled that isn't a boolean", async () => {
    const longName = await postCommand("setGodMode", { username: "x".repeat(200000) }, "gm_tools_only");
    expect(longName.status).toHaveBeenCalledWith(400);
    expect(longName.json).toHaveBeenCalledWith(expect.objectContaining({ code: "BRIDGE_INVALID_OR_MISSING_USERNAME" }));

    const objectName = await postCommand("setGodMode", { username: { a: 1 } }, "gm_tools_only");
    expect(objectName.status).toHaveBeenCalledWith(400);

    await postCommand("setNoclip", { username: "Bob", enabled: [" ".repeat(100000)] }, "gm_tools_only");
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith("setNoclip", { username: "Bob" });
  });

  it("refuses args over 64 KB with 413 before anything is sent or logged", async () => {
    const res = await postCommand(
      "teleportPlayer",
      { username: "Bob", x: 1, y: 1, z: 0, pad: "x".repeat(70 * 1024) },
      "bridge_command_only",
    );

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "PANELBRIDGE_ARGS_TOO_LARGE" }));
    expect(sendCommand).not.toHaveBeenCalled();
    expect(logBridgeCommand).not.toHaveBeenCalled();
  });

  it("refuses args nested deeper than 32 levels with 400, and logs nothing", async () => {
    const res = await postCommand("teleportPlayer", { username: "Bob", deep: nested(20000) }, "bridge_command_only");

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "PANELBRIDGE_ARGS_TOO_LARGE" }));
    expect(sendCommand).not.toHaveBeenCalled();
    expect(logBridgeCommand).not.toHaveBeenCalled();
  });

  it("still sends ordinary args unchanged", async () => {
    const args = { username: "Bob", x: 100, y: 200, z: 0, note: "é".repeat(1000) };
    const res = await postCommand("teleportPlayer", args, "bridge_command_only");

    expect(res.status).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledWith("teleportPlayer", args);
  });
});

describe("PanelBridge.sendCommand bounds args for every caller, and writes compact files", () => {
  let tempDir;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  function liveBridge() {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-args-limit-"));
    const instance = new PanelBridge();
    instance.configure(tempDir, true);
    instance.isRunning = true;
    instance.getConnectionDiagnostics = vi.fn(() => ({ canSendCommands: true, summary: "healthy" }));
    return instance;
  }

  it.each([
    ["over 64 KB", "teleportPlayer", { pad: "x".repeat(65 * 1024) }],
    ["over 512 KB for a character import", "importPlayerData", { pad: "x".repeat(513 * 1024) }],
    ["nested 33 deep", "teleportPlayer", nested(33)],
    ["nested 20,000 deep", "teleportPlayer", nested(20000)],
  ])("refuses args %s and queues nothing", async (_label, action, args) => {
    const instance = liveBridge();
    const enqueue = vi.spyOn(instance, "_enqueueCommand");

    await expect(instance.sendCommand(action, args)).rejects.toMatchObject({ code: "PANELBRIDGE_ARGS_TOO_LARGE" });
    expect(enqueue).not.toHaveBeenCalled();
    expect(instance.pendingCommands.size).toBe(0);
  });

  it("queues a 500 KB character import", async () => {
    const instance = liveBridge();
    instance.config.commandTimeoutMs = 50;
    const enqueue = vi.spyOn(instance, "_enqueueCommand").mockImplementation(() => {});

    await expect(instance.sendCommand("importPlayerData", { pad: "x".repeat(500 * 1024) })).rejects.toThrow(/timeout/i);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("writes the inbox command file without indentation", () => {
    const instance = liveBridge();
    instance._enqueueCommand("id-1", "teleportPlayer", { username: "Bob", nested: { x: 1 } });

    const inbox = path.join(tempDir, "inbox");
    const [name] = fs.readdirSync(inbox).filter((file) => /^cmd-\d+\.json$/.test(file));
    const text = fs.readFileSync(path.join(inbox, name), "utf8");
    expect(text).not.toMatch(/\n/);
    expect(JSON.parse(text)).toMatchObject({ id: "id-1", action: "teleportPlayer", args: { username: "Bob", nested: { x: 1 } } });
  });
});
