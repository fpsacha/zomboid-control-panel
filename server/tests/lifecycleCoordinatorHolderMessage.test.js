import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
  LIFECYCLE_IN_PROGRESS_CODE,
  setServerDisplayNameResolver,
} from "../services/lifecycleCoordinator.js";

// normalize-lifecycle-lock-server-identifier follow-up, 2026-09-08:
// acquireLifecycleLock's second argument is now always a server DB id (a
// UUID), not a display name -- so lifecycleInProgressResponse() resolves it
// back to a name via an INJECTED resolver (setServerDisplayNameResolver,
// wired at real boot to database/init.js's peekServerDisplayName) rather
// than interpolating the raw id. Deliberately not a static import of
// database/init.js in lifecycleCoordinator.js itself -- see that file's own
// comment: dozens of test files mock that module with only the exports they
// need, and a static import would throw "no such export" in every one of
// them the instant this function ran. Controlled here via the same
// injection real boot uses, reset in afterEach so a resolver configured by
// one test can't leak into another test in this file or another importing
// this same module in the same worker (module-level state, same leak class
// activeLock itself already guards against).
const peekServerDisplayName = vi.fn();

// 2026-09-04, lifecycle-lock investigation follow-up: the lock itself was
// never the bug (traced every acquire/release path -- all correct, process-
// wide scope is intentional). The actual defect was the refusal message:
// "Another server lifecycle operation is already in progress" names neither
// the operation nor the server holding the lock. Dwight, having just
// instrumented this exact code path, still read a correct 409 as a
// probable lock leak because the message gave him nothing to check it
// against. These tests lock in the fix: the message now names the holder
// when one was recorded, and degrades to the original generic wording
// (never "for 'undefined'") when it wasn't.
//
// `activeLock` is module-level state, so every test that acquires a lock
// must release it before the test ends (a leaked lock here would fail
// every subsequent test in this file AND in any other file importing this
// same module in the same worker) -- there is no vi.resetModules() escape
// hatch for a module-level singleton that other production code also holds
// live references into during a real run.

describe("lifecycleCoordinator: refusal message names the holder", () => {
  beforeEach(() => {
    peekServerDisplayName.mockReset();
    setServerDisplayNameResolver(peekServerDisplayName);
  });

  afterEach(() => {
    setServerDisplayNameResolver(null);
  });

  it("names both the operation and the server, resolving the held id to a display name via peekServerDisplayName", () => {
    peekServerDisplayName.mockImplementation((id) =>
      id === "server-uuid-1" ? "DoomerZ" : null,
    );
    const lock = acquireLifecycleLock("start", "server-uuid-1");
    try {
      const response = lifecycleInProgressResponse();
      expect(peekServerDisplayName).toHaveBeenCalledWith("server-uuid-1");
      expect(response.error).toBe(
        "A 'start' operation for 'DoomerZ' is already in progress",
      );
      expect(response.code).toBe(LIFECYCLE_IN_PROGRESS_CODE);
    } finally {
      lock.release();
    }
  });

  // Break-verify per the card's own boundary: a lock held with a real id
  // that DOESN'T resolve (deleted server, or -- as here -- this test's mock
  // simply has nothing for it) must fall back to the existing generic
  // wording, never print the bare id/UUID itself.
  it("falls back to the existing generic wording, never the raw id, when the held id doesn't resolve to a name", () => {
    peekServerDisplayName.mockReturnValue(null);
    const lock = acquireLifecycleLock("start", "some-uuid-with-no-matching-server");
    try {
      const response = lifecycleInProgressResponse();
      expect(response.error).toBe("A 'start' operation is already in progress");
      expect(response.error).not.toContain("some-uuid-with-no-matching-server");
    } finally {
      lock.release();
    }
  });

  it("names just the operation, without a stray 'for undefined', when no serverName was given", () => {
    const lock = acquireLifecycleLock("automatic-update");
    try {
      const response = lifecycleInProgressResponse();
      expect(response.error).toBe(
        "A 'automatic-update' operation is already in progress",
      );
      expect(response.error).not.toMatch(/undefined|null/i);
    } finally {
      lock.release();
    }
  });

  it("degrades to the original generic wording when nothing is currently held (defensive -- lifecycleInProgressResponse should only ever be called after a failed acquire, but must not crash or say 'undefined' if called otherwise)", () => {
    const response = lifecycleInProgressResponse();
    expect(response.error).toBe(
      "Another server lifecycle operation is already in progress",
    );
  });

  it("an empty or whitespace-only serverName degrades the same way a missing one does", () => {
    const lock = acquireLifecycleLock("restart", "   ");
    try {
      const response = lifecycleInProgressResponse();
      expect(response.error).toBe(
        "A 'restart' operation is already in progress",
      );
    } finally {
      lock.release();
    }
  });

  it("a second acquire attempt while the first is held still refuses (unchanged locking behavior) and the refusal names the FIRST holder, not the attempted second operation", () => {
    peekServerDisplayName.mockImplementation((id) => ({
      "uuid-a": "ServerA",
      "uuid-b": "ServerB",
    })[id] ?? null);
    const first = acquireLifecycleLock("start", "uuid-a");
    try {
      const second = acquireLifecycleLock("start", "uuid-b");
      expect(second).toBeNull();
      const response = lifecycleInProgressResponse();
      expect(response.error).toBe(
        "A 'start' operation for 'ServerA' is already in progress",
      );
    } finally {
      first.release();
    }
  });

  it("after release, the message reverts to the generic wording (no stale holder leaking into a later refusal)", () => {
    const lock = acquireLifecycleLock("start", "DoomerZ");
    lock.release();
    // Nothing is held now -- a caller mis-invoking this without a fresh
    // failed acquire (defensive case, matches the earlier "nothing held"
    // test) must not still describe the just-released DoomerZ start.
    const response = lifecycleInProgressResponse();
    expect(response.error).not.toContain("DoomerZ");
    expect(response.error).toBe(
      "Another server lifecycle operation is already in progress",
    );
  });
});
