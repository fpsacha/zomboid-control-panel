import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// panelbridge-lua-version-handshake (2026-09-09): PanelBridge.lua has
// written its own protocolVersion into every status.json write since
// PROTOCOL_VERSION was added (status.protocolVersion = PanelBridge.
// PROTOCOL_VERSION, alongside status.version) -- this side (this.
// protocolVersion, checkModStatus()) never read it back. No mod-side
// change needed; the field already ships today, unread. Deliberately
// NOT a compatibility gate: mod and panel ship as one hand-synced pair
// with no version matrix behind them, so a mismatch is surfaced (logged
// once, exposed on modStatus.protocolVersionMismatch) and never used to
// reject a command or mark the mod unreachable.

const { warnCalls, mockLogger } = vi.hoisted(() => {
  const warnCalls = [];
  return {
    warnCalls,
    mockLogger: {
      info: () => {},
      warn: (msg) => warnCalls.push(msg),
      error: () => {},
      debug: () => {},
    },
  };
});

vi.mock("../utils/logger.js", () => ({
  createLogger: () => mockLogger,
}));

const { PanelBridge } = await import("../services/panelBridge.js");

function makeTempBridgeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-protocol-version-"));
}

function writeStatus(tmpDir, overrides = {}) {
  fs.writeFileSync(
    path.join(tmpDir, "status.json"),
    JSON.stringify({
      alive: true,
      version: "1.7.57",
      playerCount: 1,
      players: [],
      ...overrides,
    }),
  );
}

describe("PanelBridge.checkModStatus -- protocolVersion handshake", () => {
  let tmpDir;

  beforeEach(() => {
    warnCalls.length = 0;
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("marks modStatus.protocolVersionMismatch and logs a warning when the mod reports a different protocolVersion", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    writeStatus(tmpDir, { protocolVersion: "queue-v2" });

    bridge.checkModStatus();

    expect(bridge.modStatus.protocolVersionMismatch).toEqual({
      expected: "queue-v1",
      actual: "queue-v2",
    });
    expect(warnCalls.some((m) => m.includes("queue-v1") && m.includes("queue-v2"))).toBe(true);
  });

  it("does NOT set protocolVersionMismatch when the mod's protocolVersion matches the panel's", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    writeStatus(tmpDir, { protocolVersion: "queue-v1" });

    bridge.checkModStatus();

    expect(bridge.modStatus.protocolVersionMismatch).toBeUndefined();
    expect(warnCalls.length).toBe(0);
  });

  it("does NOT set protocolVersionMismatch when the mod's status omits protocolVersion entirely (older/unknown mod build) -- absence is not a claimed mismatch", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    writeStatus(tmpDir); // no protocolVersion field at all

    bridge.checkModStatus();

    expect(bridge.modStatus.protocolVersionMismatch).toBeUndefined();
    expect(warnCalls.length).toBe(0);
  });

  it("logs only once for a sustained, unchanged mismatch, but re-warns if the mismatch changes to a different version", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);

    writeStatus(tmpDir, { protocolVersion: "queue-v2" });
    bridge.checkModStatus();
    expect(warnCalls.length).toBe(1);

    // Same mismatched version again (mod ticked another status write, still
    // on queue-v2) -- force the full re-read path and confirm it does NOT
    // log a second time for the identical version.
    bridge.lastStatusFileCheck = 0;
    writeStatus(tmpDir, { protocolVersion: "queue-v2", timestamp: Date.now() });
    bridge.checkModStatus();
    expect(warnCalls.length).toBe(1);

    // Mod redeployed to a THIRD, still-mismatched version -- must re-warn,
    // not stay silent because "a" mismatch was already logged once.
    bridge.lastStatusFileCheck = 0;
    writeStatus(tmpDir, { protocolVersion: "queue-v3" });
    bridge.checkModStatus();
    expect(warnCalls.length).toBe(2);
    expect(bridge.loggedProtocolVersionMismatch).toBe("queue-v3");
  });

  it("clears loggedProtocolVersionMismatch once the mod redeploys back to a matching protocolVersion", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);

    writeStatus(tmpDir, { protocolVersion: "queue-v2" });
    bridge.checkModStatus();
    expect(bridge.loggedProtocolVersionMismatch).toBe("queue-v2");

    bridge.lastStatusFileCheck = 0;
    writeStatus(tmpDir, { protocolVersion: "queue-v1" });
    bridge.checkModStatus();

    expect(bridge.loggedProtocolVersionMismatch).toBeNull();
    expect(bridge.modStatus.protocolVersionMismatch).toBeUndefined();
  });
});
