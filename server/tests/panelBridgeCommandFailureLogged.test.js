import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Support bundle 2026-09-08 (gortuniontwoelectricboogaloo, the mod-settings
// timeout report b7177e1b fixed): the POST /command catch block already
// called logBridgeCommand() on failure -- writing to db.json's bridgeLogs
// collection (surfaced in a support bundle as recent-events.json) -- but
// never called the module's own `log` at all. combined.log/error.log show
// the request line ("POST /command: action=X") for every one of 47 real
// bridge commands in that user's bundle and NOT ONE completion, timeout, or
// error line for any of them, success or failure alike -- the only place a
// failure was ever recorded was the structured history, never the two files
// the bundle's own README tells an admin to grep ("Failed to", "ERROR") when
// troubleshooting exactly this complaint. This test asserts a failed command
// now leaves a WARN line via the real winston logger (the same combined.log
// destination `[API:PanelBridge] POST /command: action=...` already writes
// to at startup), naming the action, how long it ran, and why it failed --
// not just the structured record nothing greps for.
//
// Log capture uses onLog() (utils/logger.js), the same real winston
// callback-transport mechanism other tests use to assert what actually
// reaches combined.log/error.log -- not a console.log spy, which would miss
// winston's real output path.

const getActiveServer = vi.fn(async () => null);
const logBridgeCommand = vi.fn(async () => {});
const getRoleByName = vi.fn(async () => ({ capabilities: ["bridge.command", "players.gm_tools"] }));

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

const { default: bridge } = await import("../services/panelBridge.js");
const { default: router } = await import("../routes/panelBridge.js");
const { onLog } = await import("../utils/logger.js");

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

const flush = () => new Promise((resolve) => setImmediate(resolve)); // CallbackTransport dispatches via setImmediate

describe("POST /command leaves a human-readable log line when the bridge command fails", () => {
  beforeEach(() => {
    bridge.isRunning = true;
    bridge.bridgePath = "/fake/bridge/path";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    bridge.isRunning = false;
    bridge.bridgePath = null;
  });

  it("logs a WARN naming the action, duration, and error for a real 15s bridge timeout", async () => {
    vi.spyOn(bridge, "sendCommand").mockRejectedValue(
      new Error("Command timeout: getAllSandboxOptions (no response from mod)"),
    );

    const logEntries = [];
    const unsubscribe = onLog((entry) => logEntries.push(entry));

    try {
      const res = createResponse();
      await getHandler("/command", "post")(
        { user: { role: "admin" }, body: { action: "getAllSandboxOptions", args: {} } },
        res,
        () => {},
      );
      await flush();
    } finally {
      unsubscribe();
    }

    // The structured record still fires -- this is additive, not a replacement.
    expect(logBridgeCommand).toHaveBeenCalledWith(
      "getAllSandboxOptions",
      {},
      { error: "Command timeout: getAllSandboxOptions (no response from mod)" },
      false,
      expect.any(Number),
    );

    const failureLine = logEntries.find(
      (e) => e.source === "API:PanelBridge" && e.level === "warn",
    );
    expect(failureLine).toBeDefined();
    expect(failureLine.message).toContain("action=getAllSandboxOptions");
    expect(failureLine.message).toContain("failed");
    expect(failureLine.message).toContain(
      "Command timeout: getAllSandboxOptions (no response from mod)",
    );
  });

  it("does not log a failure line when the command succeeds (additive only, not a shape change for the common case)", async () => {
    vi.spyOn(bridge, "sendCommand").mockResolvedValue({ success: true, data: {} });

    const logEntries = [];
    const unsubscribe = onLog((entry) => logEntries.push(entry));

    try {
      const res = createResponse();
      await getHandler("/command", "post")(
        { user: { role: "admin" }, body: { action: "getSafehouses", args: {} } },
        res,
        () => {},
      );
      await flush();
    } finally {
      unsubscribe();
    }

    const failureLine = logEntries.find(
      (e) => e.source === "API:PanelBridge" && e.level === "warn" && e.message.includes("failed"),
    );
    expect(failureLine).toBeUndefined();
  });
});
