import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 2026-09-04, overnight bug hunt (Angela's fence: panelBridge*):
// configureSftp() connects a brand-new PanelBridgeSftpTransport FIRST (its
// own try/catch already handles that failing cleanly, leaving the old
// bridge untouched -- see the comment above it). But once that new
// transport is confirmed connected, the swap that follows (stop the old
// bridge, stop the old transport, this.configure(), assign the new
// transport, this.start()) ran with no protection at all. If anything in
// that sequence threw -- this.configure() on a bad path, a future edit to
// this.start() that can throw -- the freshly-connected transport was
// silently leaked (its SFTP connection and poll timer keep running, owned
// by nothing) and this.sftpTransport was left either pointing at the OLD
// transport (already stopped two lines up -- the bridge would report
// itself configured against a transport that isn't running) or in
// whatever partial state the throw happened to catch it in.
//
// Fix: wrap the swap in its own try/catch. On failure: null out
// sftpTransport (the old one is guaranteed already stopped by this point,
// so keeping that reference would be misleading either way), stop the new
// transport so it isn't leaked, and rethrow the original error.

const mockTransport = {
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  getStatus: vi.fn(() => ({ type: "sftp", running: true })),
};

vi.mock("../services/panelBridgeSftp.js", () => ({
  PanelBridgeSftpTransport: vi.fn(function PanelBridgeSftpTransport() {
    return mockTransport;
  }),
}));

const { PanelBridge } = await import("../services/panelBridge.js");

beforeEach(() => {
  mockTransport.start.mockClear();
  mockTransport.stop.mockClear();
  mockTransport.getStatus.mockClear();
  mockTransport.start.mockImplementation(async () => {});
  mockTransport.stop.mockImplementation(async () => {});
});

describe("PanelBridge.configureSftp cleans up the new transport when the post-connect swap fails", () => {
  // this.configure(cachePath, true) sets this.bridgePath = cachePath, and
  // the control case below reaches this.start() -> ensureQueueProtocol(),
  // which really does `fs.mkdirSync(path.join(bridgePath, "inbox"))` on
  // disk. The literal "/cache" this used to pass is a real filesystem root
  // path -- root-only to create on a non-root runner (GitHub's ubuntu-latest
  // "runner" user), which is exactly why this passed on a WSL gate running
  // as root and failed as EACCES on CI at the same clean SHA. A real,
  // writable temp dir is what every other test that reaches real fs calls
  // in this suite already uses.
  let cacheDir;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-sftp-"));
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("stops the newly-connected transport and clears sftpTransport when this.configure() throws mid-swap", async () => {
    const bridge = new PanelBridge();
    vi.spyOn(bridge, "configure").mockImplementation(() => {
      throw new Error("swap failed");
    });

    await expect(
      bridge.configureSftp({ host: "h", username: "u", password: "p", bridgePath: "/b" }, cacheDir),
    ).rejects.toThrow("swap failed");

    // The transport DID connect successfully -- it must not be left running,
    // orphaned, with nothing tracking it.
    expect(mockTransport.stop).toHaveBeenCalled();
    expect(bridge.sftpTransport).toBeNull();
  });

  it("still succeeds normally when nothing in the swap throws (control)", async () => {
    const bridge = new PanelBridge();

    const result = await bridge.configureSftp(
      { host: "h", username: "u", password: "p", bridgePath: "/b" },
      cacheDir,
    );

    expect(result).toBe(bridge.bridgePath);
    expect(bridge.sftpTransport).toBe(mockTransport);
    // stop() was NOT called on the successful path -- there was no old
    // transport to replace and nothing failed.
    expect(mockTransport.stop).not.toHaveBeenCalled();
    bridge.stop();
  });

  it("leaves the previously-running bridge untouched when the NEW transport itself fails to connect (existing behavior, unchanged)", async () => {
    const bridge = new PanelBridge();
    mockTransport.start.mockImplementationOnce(async () => {
      throw new Error("connect failed");
    });

    await expect(
      bridge.configureSftp({ host: "h", username: "u", password: "p", bridgePath: "/b" }, cacheDir),
    ).rejects.toThrow("connect failed");

    expect(bridge.sftpTransport).toBeNull();
    expect(bridge.isRunning).toBe(false);
  });
});
