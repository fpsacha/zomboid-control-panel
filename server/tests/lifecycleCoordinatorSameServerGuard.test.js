import { describe, expect, it } from "vitest";
import {
  acquireLifecycleLock,
  isLifecycleLockedForServer,
} from "../services/lifecycleCoordinator.js";

// steamcmd-ops-never-check-the-lifecycle-lock, 2026-09-09: /install,
// /quick-setup and /steam-update never checked the global lifecycle lock at
// all, so a SteamCMD op could start while wipe/restore/template-apply
// already held it for the SAME server's install path. God's ruling
// (2026-09-08) rejected making SteamCMD take the GLOBAL lock itself (would
// freeze every unrelated server's start/stop/restart for the whole
// download) in favor of a same-server comparison, gated on the
// normalize-lifecycle-lock-server-identifier pass (08396dcd) making
// serverId trustworthy at 19/20 sites. These tests lock in
// isLifecycleLockedForServer()'s contract before any route calls it.
//
// activeLock is module-level state shared with every other test file
// importing this module in the same worker -- every acquire here is
// released in a try/finally exactly like the sibling holder-message tests,
// so a failed assertion can't leak a held lock into an unrelated file.
describe("lifecycleCoordinator: same-server SteamCMD guard", () => {
  it("refuses when the held lock names the SAME server", () => {
    const lock = acquireLifecycleLock("wipe", "server-uuid-1");
    try {
      expect(isLifecycleLockedForServer("server-uuid-1")).toBe(true);
    } finally {
      lock.release();
    }
  });

  it("does NOT refuse when the held lock names a DIFFERENT server -- this is the whole point of the ruling: no global blocking", () => {
    const lock = acquireLifecycleLock("wipe", "server-uuid-1");
    try {
      expect(isLifecycleLockedForServer("server-uuid-2")).toBe(false);
    } finally {
      lock.release();
    }
  });

  it("does not refuse when nothing is held", () => {
    expect(isLifecycleLockedForServer("server-uuid-1")).toBe(false);
  });

  it("does not refuse when the HELD lock has no serverId (e.g. boot auto-start, an automatic update with no single server) -- a known gap, not a false negative introduced here", () => {
    const lock = acquireLifecycleLock("automatic-update");
    try {
      expect(isLifecycleLockedForServer("server-uuid-1")).toBe(false);
    } finally {
      lock.release();
    }
  });

  it("does not refuse when the CALLER has no serverId to compare (null/undefined) even though a lock is held for a real server", () => {
    const lock = acquireLifecycleLock("wipe", "server-uuid-1");
    try {
      expect(isLifecycleLockedForServer(null)).toBe(false);
      expect(isLifecycleLockedForServer(undefined)).toBe(false);
    } finally {
      lock.release();
    }
  });

  it("compares by value across string/number representations, matching acquireLifecycleLock's own String() coercion", () => {
    const lock = acquireLifecycleLock("wipe", 7);
    try {
      expect(isLifecycleLockedForServer(7)).toBe(true);
      expect(isLifecycleLockedForServer("7")).toBe(true);
      expect(isLifecycleLockedForServer(8)).toBe(false);
    } finally {
      lock.release();
    }
  });

  it("after release, no longer refuses for the previously-held server", () => {
    const lock = acquireLifecycleLock("wipe", "server-uuid-1");
    lock.release();
    expect(isLifecycleLockedForServer("server-uuid-1")).toBe(false);
  });
});
