import { describe, expect, it, vi } from "vitest";
import { PanelBridge } from "../services/panelBridge.js";

// sweep-round5 follow-up (2026-09-07, release-1-2-17): ping() used to
// spread the FULL this.modStatus into its response -- reachable by ANY
// authenticated session regardless of role, since GET /ping carries no
// requirePermission gate at all (see panelBridgeRoutesRoleSweep.test.js's
// "KNOWN GAP" describe block, now resolved by this fix). Two real leaks:
// modStatus.path/filePath (host and game-server filesystem paths, same
// class as 7ead08e0's /status fix) and modStatus.players (a live online
// -username list with no players.view check, unlike every other route
// that exposes player presence -- third-party data, not the operator's
// own, which is why god reversed the "ships tomorrow" call for this one
// specifically).
//
// Asserts ABSENCE explicitly, not just presence of what's expected -- a
// test that only checks serverName made it through would not notice
// players/path/filePath coming back too, which is exactly how this leak
// went unnoticed in the first place.

function buildBridgeWithModStatus(modStatus) {
  const bridge = new PanelBridge();
  bridge.isRunning = true;
  bridge.modStatus = modStatus;
  return bridge;
}

const LEAKY_MOD_STATUS = {
  alive: true,
  serverName: "Charon's Crossing",
  version: "1.4.2",
  playerCount: 2,
  players: ["ProbablyBob", "definitely_not_a_griefer"],
  path: "C:\\Users\\ServerHost\\Zomboid\\PanelBridge",
  filePath: "D:\\Panel\\bridge-mirror\\status.json",
  debugMode: false,
  stats: { processed: 10, succeeded: 10, failed: 0 },
  queue: { lastCommandSeq: 5, nextResultSeq: 6 },
};

describe("PanelBridge.ping() -- modStatus merged into the response is allow-listed, not the raw shared state", () => {
  it("connected/success path: response modStatus has ONLY serverName, not players/path/filePath/stats/queue", async () => {
    const bridge = buildBridgeWithModStatus(LEAKY_MOD_STATUS);
    bridge.sendCommand = vi.fn().mockResolvedValue({ success: true, message: "pong" });

    const result = await bridge.ping();

    expect(result.modStatus).toEqual({ serverName: "Charon's Crossing" });
    expect(result.modStatus).not.toHaveProperty("players");
    expect(result.modStatus).not.toHaveProperty("path");
    expect(result.modStatus).not.toHaveProperty("filePath");
    expect(result.modStatus).not.toHaveProperty("stats");
    expect(result.modStatus).not.toHaveProperty("queue");
    expect(result.modStatus).not.toHaveProperty("debugMode");
  });

  it("mod-not-connected path: response modStatus is still narrowed to serverName only", async () => {
    const bridge = buildBridgeWithModStatus({ ...LEAKY_MOD_STATUS, alive: false });

    const result = await bridge.ping();

    expect(result.success).toBe(false);
    expect(result.modStatus).toEqual({ serverName: "Charon's Crossing" });
    expect(result.modStatus).not.toHaveProperty("players");
    expect(result.modStatus).not.toHaveProperty("path");
    expect(result.modStatus).not.toHaveProperty("filePath");
  });

  it("no modStatus at all yet (bridge never received a status file): serverName is null, no throw", async () => {
    const bridge = buildBridgeWithModStatus(null);

    const result = await bridge.ping();

    expect(result.modStatus).toEqual({ serverName: null });
  });

  it("the internal this.modStatus instance field itself is untouched -- other consumers (getStatus(), the socket layer) still see the full object", async () => {
    const bridge = buildBridgeWithModStatus(LEAKY_MOD_STATUS);
    bridge.sendCommand = vi.fn().mockResolvedValue({ success: true, message: "pong" });

    await bridge.ping();

    expect(bridge.modStatus).toBe(LEAKY_MOD_STATUS);
    expect(bridge.modStatus.players).toEqual(LEAKY_MOD_STATUS.players);
    expect(bridge.modStatus.path).toBe(LEAKY_MOD_STATUS.path);
  });
});
