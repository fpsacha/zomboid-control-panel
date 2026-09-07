import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PanelBridge } from "../services/panelBridge.js";

// 2026-08-31 bug hunt (PanelBridge Lua mod + bridge protocol): tryResyncOutboxCursor
// (the results/outbox direction) was the one resync function in this file's
// three-way symmetric set that did NOT guard against moving its cursor
// BACKWARD. Its two siblings both do, and both say why in their own
// comments:
//   - PanelBridge.lua's tryResyncInboxCursor (commands direction, Lua side):
//     "A read of .queue-state-node.json that's stale or racing a second
//     writer ... can only ever show a LOWER panelHighWater than the truth,
//     never a fabricated higher one. Refusing to move lastCommandSeq
//     backward makes rewinding into already-processed commands structurally
//     impossible."
//   - tryResyncInboxCommandCursor (commands direction, Node side, this
//     file): "Forward-only: it only ever raises nextCommandSeq, never
//     lowers it, so it can't undo real in-flight work even if this read
//     races a moment where Lua's file is stale."
//
// tryResyncOutboxCursor (results direction, Node side) had no equivalent
// guard: if queue-state-lua.json's nextResultSeq was ever read as LOWER
// than what this process had already consumed (a stale/racing read over
// SFTP, or a freshly-regenerated state file), it would rewind
// lastConsumedResultSeq backward. pollQueueResults() would then re-walk
// every seq between the rewound point and where it actually was -- each
// one either already-cleared-but-undeleted (stalls ~1.5s per file in the
// empty-read retry path) or already deleted by cleanupOutboxFiles (stalls
// resyncStuckMs=20000ms per file, re-triggering this same check) -- while
// the bridge still reports itself connected, silently stalling every
// pending command's real response until that backlog fully re-drains.

function makeTempBridgeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-outbox-resync-"));
}

// tryResyncOutboxCursor only proceeds past its own "have we been stuck at
// this exact seq for resyncStuckMs" gate on a SECOND call at the same seq,
// after outboxStuckState.nextCheckAt has passed -- mirrors the real caller
// (pollQueueResults, which calls this once per poll while stuck waiting on
// a missing result file). Drive it through that gate explicitly rather than
// waiting on real wall-clock time.
function armStuckGate(bridge, seq) {
  const first = bridge.tryResyncOutboxCursor(seq);
  expect(first).toBe(false); // first call only records the stuck state
  bridge.outboxStuckState.nextCheckAt = 0; // force the gate open immediately
}

describe("PanelBridge.tryResyncOutboxCursor", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resyncs lastConsumedResultSeq forward when Lua is genuinely ahead", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    bridge.queueState.lastConsumedResultSeq = 5;

    fs.writeFileSync(
      path.join(tmpDir, "queue-state-lua.json.txt"),
      JSON.stringify({ protocolVersion: "queue-v1", lastCommandSeq: 0, nextResultSeq: 51 }),
    );

    armStuckGate(bridge, 6);
    const resynced = bridge.tryResyncOutboxCursor(6);

    expect(resynced).toBe(true);
    expect(bridge.queueState.lastConsumedResultSeq).toBe(50);
  });

  it("never lowers lastConsumedResultSeq -- forward-only, so a stale/racing read of Lua's state file can't manufacture a stall", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    bridge.queueState.lastConsumedResultSeq = 500;

    // Lua's persisted state claims it has only ever produced through seq 49
    // -- e.g. a freshly-regenerated queue-state-lua.json, or a stale read
    // racing a second writer -- while this process has already genuinely
    // consumed through 500.
    fs.writeFileSync(
      path.join(tmpDir, "queue-state-lua.json.txt"),
      JSON.stringify({ protocolVersion: "queue-v1", lastCommandSeq: 0, nextResultSeq: 50 }),
    );

    armStuckGate(bridge, 501);
    const resynced = bridge.tryResyncOutboxCursor(501);

    expect(resynced).toBe(false);
    expect(bridge.queueState.lastConsumedResultSeq).toBe(500);
  });

  it("does nothing when already in sync (genuinely idle)", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    bridge.queueState.lastConsumedResultSeq = 10;

    fs.writeFileSync(
      path.join(tmpDir, "queue-state-lua.json.txt"),
      JSON.stringify({ protocolVersion: "queue-v1", lastCommandSeq: 0, nextResultSeq: 11 }),
    );

    armStuckGate(bridge, 11);
    const resynced = bridge.tryResyncOutboxCursor(11);

    expect(resynced).toBe(false);
    expect(bridge.queueState.lastConsumedResultSeq).toBe(10);
  });

  it("does nothing when Lua's state file does not exist yet", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    bridge.queueState.lastConsumedResultSeq = 3;

    armStuckGate(bridge, 4);
    const resynced = bridge.tryResyncOutboxCursor(4);

    expect(resynced).toBe(false);
    expect(bridge.queueState.lastConsumedResultSeq).toBe(3);
  });

  // bug hunt 2026-09-07 (Date.now()-for-elapsed-time sweep): the stuck-gate
  // used to be Date.now()-based -- a wall-clock step BACKWARD (NTP
  // correction, DST, a manual clock change) landing between the first call
  // (which records the stuck state) and a later one would keep
  // `now < nextCheckAt` true far longer than resyncStuckMs actually
  // elapsed, delaying the self-heal this function exists to provide. Fixed
  // by switching to performance.now() (monotonic, cannot step backward).
  // Proves it by making Date.now() report something wildly inconsistent
  // (a huge step backward) while advancing the MOCKED monotonic clock past
  // resyncStuckMs -- the resync must still fire, driven only by the
  // monotonic clock.
  it("the stuck-duration gate is immune to a Date.now() backward jump -- it runs on performance.now(), not wall clock", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    bridge.queueState.lastConsumedResultSeq = 5;

    let mockPerfNow = 1_000;
    const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => mockPerfNow);
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);

    const first = bridge.tryResyncOutboxCursor(6);
    expect(first).toBe(false); // records the stuck state at mockPerfNow=1000

    // Wall clock steps backward by a huge amount -- a Date.now()-based gate
    // would never see `now >= nextCheckAt` again after this.
    dateSpy.mockReturnValue(-1_000_000_000);
    // Real (monotonic) time advances past resyncStuckMs (20000ms default).
    mockPerfNow += 21_000;

    fs.writeFileSync(
      path.join(tmpDir, "queue-state-lua.json.txt"),
      JSON.stringify({ protocolVersion: "queue-v1", lastCommandSeq: 0, nextResultSeq: 51 }),
    );

    const resynced = bridge.tryResyncOutboxCursor(6);

    perfSpy.mockRestore();
    dateSpy.mockRestore();

    expect(resynced).toBe(true);
    expect(bridge.queueState.lastConsumedResultSeq).toBe(50);
  });
});
