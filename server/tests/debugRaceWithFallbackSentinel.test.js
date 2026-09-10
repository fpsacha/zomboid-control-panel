import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  raceWithFallback,
  scanWorkshopFailures,
  scanRecentCrash,
  CHECK_TIMED_OUT,
} from "../routes/debug.js";

// timeout-handling-consistency-sweep, 2026-09-10 (rename + sentinel follow-up
// to god's fix #4/#2/#6): withTimeout was renamed to raceWithFallback (the
// old name implied a cancel guarantee this function structurally cannot
// give -- it's handed an already-created promise and can only stop waiting
// on it, never cancel whatever produced it, unlike diskSpace.js's own
// withTimeout which genuinely SIGTERMs a real child process). Separately,
// scanWorkshopFailures()/scanRecentCrash() both use `null` as their OWN
// "nothing wrong here" answer -- reusing `null` as the race's timeout
// fallback made an honest "couldn't check in time" indistinguishable from a
// genuine "checked, nothing wrong," reading as a false all-clear on a page
// whose whole job is telling the operator what's wrong.
//
// Reaching the full GET /diagnostics route to prove this end-to-end turned
// out to be its own, much larger job (its handler pulls in req.app-injected
// services plus a dozen other database/init.js lookups unrelated to this
// fix; a first attempt at mocking all of it hung real wall-clock time on an
// unrelated dependency deep in the handler, not this fix). Testing the
// exported primitives directly proves the same mechanism without that cost
// -- see debugProcessState.test.js for the established precedent of testing
// this file's internals directly rather than through the full route.

describe("raceWithFallback: renamed from withTimeout, same never-rejects/real-cancel-free contract", () => {
  it("resolves the real value when the promise settles before the timer", async () => {
    const result = await raceWithFallback(Promise.resolve("real answer"), 1000, "fallback");
    expect(result).toBe("real answer");
  });

  it("resolves the fallback when the promise never settles before the timer (a tiny real timeoutMs, matching debugProcessState.test.js's own convention -- no fake timers needed)", async () => {
    const result = await raceWithFallback(new Promise(() => {}), 1, "fallback");
    expect(result).toBe("fallback");
  });

  it("resolves the fallback (not a rejection) when the wrapped promise itself rejects -- never throws", async () => {
    await expect(
      raceWithFallback(Promise.reject(new Error("boom")), 1000, "fallback"),
    ).resolves.toBe("fallback");
  });

  it("can resolve a Symbol sentinel just as well as any other fallback value, distinguishable via ===", async () => {
    const result = await raceWithFallback(new Promise(() => {}), 1, CHECK_TIMED_OUT);
    expect(result).toBe(CHECK_TIMED_OUT);
    expect(result === null).toBe(false);
  });
});

describe("scanWorkshopFailures / scanRecentCrash: CHECK_TIMED_OUT cannot collide with their own real 'nothing wrong' answer", () => {
  it("scanWorkshopFailures resolves real null (not the sentinel) when there is genuinely no log file", async () => {
    const zPath = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-workshopscan-"));
    try {
      const result = await scanWorkshopFailures(zPath);
      expect(result).toBeNull();
      expect(result === CHECK_TIMED_OUT).toBe(false);
    } finally {
      fs.rmSync(zPath, { recursive: true, force: true });
    }
  });

  it("scanRecentCrash resolves real null (not the sentinel) when the log has no crash signature", async () => {
    const zPath = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-crashscan-"));
    fs.writeFileSync(path.join(zPath, "server-console.txt"), "server started fine\n");
    try {
      const result = await scanRecentCrash(zPath);
      expect(result).toBeNull();
      expect(result === CHECK_TIMED_OUT).toBe(false);
    } finally {
      fs.rmSync(zPath, { recursive: true, force: true });
    }
  });

  it("the real production wiring: racing either scan with CHECK_TIMED_OUT as fallback produces a value the caller can tell apart from a genuine clean result, even though both scans naturally return null for 'nothing wrong'", async () => {
    // Never-resolving stand-in for a hung fs read (broken NFS, dead SMB
    // share) -- proves the SAME raceWithFallback(..., CHECK_TIMED_OUT) shape
    // debug.js's GET /diagnostics handler now uses at both call sites
    // resolves the sentinel, not null, when the scan doesn't finish in time.
    const hungScan = new Promise(() => {});
    const result = await raceWithFallback(hungScan, 1, CHECK_TIMED_OUT);
    expect(result).toBe(CHECK_TIMED_OUT);

    // And the genuine clean-scan result (real null) is never mistaken for it.
    const zPath = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-realclean-"));
    try {
      const realResult = await raceWithFallback(scanWorkshopFailures(zPath), 1000, CHECK_TIMED_OUT);
      expect(realResult).toBeNull();
      expect(realResult === CHECK_TIMED_OUT).toBe(false);
    } finally {
      fs.rmSync(zPath, { recursive: true, force: true });
    }
  });
});
