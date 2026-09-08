import { describe, expect, it } from "vitest";
import { ServerManager } from "../services/serverManager.js";

// Concurrency hunt 2026-08-29 (conversation hunt-wave5-2026-08-29). god's
// brief quoted Dashboard.tsx's own comment: "Stop/Force Stop have no
// server-side mutex, unlike Restart's restartInProgress flag." Confirmed by
// reading serverManager.js: startServer() checks BOTH `this._starting` and
// `this._stopping` before proceeding (throws "Server stop in progress, try
// again in a moment" / "Server start already in progress"), but stopServer()
// used to only ever SET `this._stopping = true` -- it never checked it at
// entry. So two overlapping stopServer() calls (two Force Stops, or a
// Force Stop racing the Docker/service-managed branch of a plain Stop) both
// proceeded past every guard: both scanned, both found the same PID, both
// called _killPids() with it -- redundant work, and on a real OS a second
// `kill -9` on an already-reaped PID is usually a silent no-op UNLESS that
// exact PID number has already been reused by an unrelated process in the
// interim (unconfirmed by necessity -- see the hunt report for why that
// couldn't be safely forced on this shared WSL kernel).
//
// FIXED by adding the same entry check startServer() already performs, one
// direction earlier: stopServer() now refuses immediately (before its
// first await, mirroring startServer()'s own guard) when `this._stopping`
// is already true, instead of racing a second scan+kill against whichever
// stop got there first.

function makeManager(overrides = {}) {
  const manager = new ServerManager();
  Object.assign(
    manager,
    { configLoaded: true, serverName: "ConcurrentStopTest" },
    overrides,
  );
  return manager;
}

describe("stopServer(): a second concurrent call (a second Force Stop) is refused, matching startServer()'s existing guard", () => {
  it("only the first call scans and kills; the second is refused immediately with a visible message, not raced", async () => {
    const manager = makeManager();
    let killCalls = [];
    let processKilled = false;

    // Real-ish timing: scanning takes a few ms (an OS process-list scan
    // always does), killing takes a few ms too. If the fix were absent,
    // both calls' scans would run before either kill took effect -- exactly
    // the shape god's brief described. With the fix, the entry check is
    // synchronous and runs before either call ever reaches this mock, so
    // the second call never gets far enough to matter.
    manager.getServerProcessDetails = async () => {
      await new Promise((r) => setTimeout(r, 10));
      return {
        running: !processKilled,
        matched: [{ pid: "9999", cmd: "java zombie.network.GameServer -servername ConcurrentStopTest" }],
        owned: [{ pid: "9999", cmd: "java zombie.network.GameServer -servername ConcurrentStopTest" }],
        scanFailed: false,
      };
    };
    manager._killPids = async (pids) => {
      killCalls.push(pids.slice());
      await new Promise((r) => setTimeout(r, 5));
      processKilled = true;
      return { timedOut: false, failed: false, errors: [] };
    };

    const [resultA, resultB] = await Promise.all([
      manager.stopServer(),
      manager.stopServer(),
    ]);

    // The fix: only ONE call ever reaches _killPids(), because the entry
    // guard (synchronous, before stopServer()'s first await) means whichever
    // call's synchronous prefix runs first sets `_stopping` before the
    // other's prefix gets a chance to check it -- deterministic, no race.
    expect(killCalls.length).toBe(1);
    expect(killCalls[0]).toEqual(["9999"]);

    // Exactly one call proceeds and succeeds; the other is refused outright,
    // with a visible reason -- not a silent no-op and not a redundant kill.
    const results = [resultA, resultB];
    const succeeded = results.filter((r) => r.success);
    const refused = results.filter((r) => !r.success);
    expect(succeeded.length).toBe(1);
    expect(refused.length).toBe(1);
    expect(refused[0].message).toMatch(/already in progress/i);
    expect(refused[0].error).toBe("Stop already in progress");

    // _stopping is released correctly (no permanent lockout).
    expect(manager._stopping).toBe(false);
  });

  it("contrast: startServer() DOES refuse a concurrent call outright -- the asymmetry Dashboard.tsx's comment describes is real", async () => {
    const manager = makeManager();
    manager._stopping = true; // simulates a stop already in flight

    await expect(manager.startServer({ skipRunningCheck: true })).rejects.toThrow(
      /stop in progress/i,
    );
  });
});
