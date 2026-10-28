import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SECURITY (2026-10-28): POST /command makes sendToGeneralChat,
// sendToAdminChat and createNoise need players.endanger_or_impersonate, but
// runEventSequence (bridge.command alone) runs the same three handlers from
// its steps: a chat step in General can post under any name, and a noise
// step can make noise at a player. Those steps now need that capability too.

const ROLES = {
  bridge_command_only: { capabilities: ["bridge.command"] },
  endanger_admin: { capabilities: ["bridge.command", "players.endanger_or_impersonate"] },
};
const getRoleByName = vi.fn(async (name) => ROLES[name] || null);

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(),
  getAllSettings: vi.fn(async () => ({})),
  setSetting: vi.fn(),
  getDb: vi.fn(),
  commitNow: vi.fn(),
  logBridgeCommand: vi.fn(async () => {}),
  getRoleByName,
}));

const { default: bridge } = await import("../services/panelBridge.js");
const { default: router } = await import("../routes/panelBridge.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function runSequence(steps, role) {
  const layer = router.stack.find((entry) => entry.route?.path === "/command" && entry.route.methods.post);
  const res = createResponse();
  await layer.route.stack[layer.route.stack.length - 1].handle(
    { user: { role }, body: { action: "runEventSequence", args: { steps } } },
    res,
    () => {},
  );
  return res;
}

describe("POST /command runEventSequence -- impersonating chat and noise steps need players.endanger_or_impersonate", () => {
  let sendCommand;

  beforeEach(() => {
    bridge.isRunning = true;
    bridge.bridgePath = "/fake/bridge/path";
    sendCommand = vi.spyOn(bridge, "sendCommand").mockResolvedValue({ success: true });
  });

  afterEach(() => {
    sendCommand.mockRestore();
    bridge.isRunning = false;
    bridge.bridgePath = null;
  });

  it.each([
    ["a General chat step with any author", { kind: "chat", channel: "general", message: "hi", author: "Admin" }],
    ["an Admin chat step", { kind: "chat", channel: "admin", message: "hi" }],
    ["a noise step at a player", { kind: "noise", username: "Bob", radius: 100 }],
    ["a noise step at coordinates", { kind: "noise", x: 100, y: 100 }],
  ])("refuses %s to bridge.command alone", async (_label, step) => {
    const res = await runSequence([{ kind: "weather", weatherType: "storm" }, step], "bridge_command_only");

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "PANELBRIDGE_ACTION_CAPABILITY_REQUIRED" }));
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("allows those steps with players.endanger_or_impersonate", async () => {
    const steps = [
      { kind: "chat", channel: "general", message: "hi", author: "Admin" },
      { kind: "noise", username: "Bob" },
    ];
    const res = await runSequence(steps, "endanger_admin");

    expect(res.status).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledWith("runEventSequence", expect.objectContaining({ steps }));
  });

  it("still lets bridge.command alone run server chat, weather, swarm and utilities steps", async () => {
    const steps = [
      { kind: "chat", message: "Storm incoming", alert: true },
      { kind: "chat", channel: "server", message: "hi" },
      { kind: "weather", weatherType: "storm", duration: 2 },
      { kind: "swarm", count: 5, x1: 1, y1: 1, x2: 2, y2: 2 },
    ];
    const res = await runSequence(steps, "bridge_command_only");

    expect(res.status).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  // Adversary pass: the gated step placed where it might be missed.
  it("refuses a gated step past the first 50, and one after a non-object step", async () => {
    const filler = Array.from({ length: 60 }, () => ({ kind: "weather", weatherType: "stop" }));
    const late = await runSequence([...filler, { kind: "chat", channel: "general", message: "x" }], "bridge_command_only");
    expect(late.status).toHaveBeenCalledWith(403);

    const afterJunk = await runSequence([null, "chat", ["noise"], { kind: "noise" }], "bridge_command_only");
    expect(afterJunk.status).toHaveBeenCalledWith(403);
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
