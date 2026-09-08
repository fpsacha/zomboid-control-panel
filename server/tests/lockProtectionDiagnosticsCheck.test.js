import { afterEach, describe, expect, it, vi } from "vitest";

// god's dispatch, 2026-09-08 (part 2 of the pidLock.js fix, ea286e15): a
// data directory that's deliberately read-only/access-restricted makes
// acquireLock() proceed WITHOUT a lock, and until now that was only ever
// logged once as a warn -- invisible to anyone not already watching logs
// at that exact moment. buildLockProtectionCheck() (server/routes/debug.js)
// surfaces that state persistently through the diagnostics check registry
// instead. Mocks utils/pidLock.js's isLockProtectionDisabled() directly
// (the same primitive server/tests/pidLock.test.js exercises for real) so
// this test doesn't need to fight the full /diagnostics handler's many
// other dependencies (rconService, serverManager, modChecker, ...) just to
// check this one small, pure function.
vi.mock("../utils/pidLock.js", () => ({
  isLockProtectionDisabled: vi.fn(),
}));

describe("buildLockProtectionCheck (server.storage.lockProtection diagnostics check)", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("returns null when duplicate-instance protection is active (the normal case)", async () => {
    const pidLock = await import("../utils/pidLock.js");
    pidLock.isLockProtectionDisabled.mockReturnValue(null);
    const { buildLockProtectionCheck } = await import("../routes/debug.js");

    expect(buildLockProtectionCheck()).toBeNull();
  });

  it("warns, naming the specific error code, when protection is disabled", async () => {
    const pidLock = await import("../utils/pidLock.js");
    pidLock.isLockProtectionDisabled.mockReturnValue({
      code: "EROFS",
      message: "EROFS: read-only file system, open 'panel.lock'",
      lockPath: "/data/panel.lock",
    });
    const { buildLockProtectionCheck } = await import("../routes/debug.js");

    const check = buildLockProtectionCheck();

    expect(check).not.toBeNull();
    expect(check.id).toBe("storage.lockProtection");
    expect(check.status).toBe("warn");
    expect(check.category).toBe("storage");
    expect(check.message).toContain("EROFS");
    expect(check.params).toEqual({ code: "EROFS" });
  });

  it("reflects a different code when that's what pidLock reports (not hardcoded to one value)", async () => {
    const pidLock = await import("../utils/pidLock.js");
    pidLock.isLockProtectionDisabled.mockReturnValue({
      code: "EPERM",
      message: "EPERM: operation not permitted, open 'panel.lock'",
      lockPath: "C:\\data\\panel.lock",
    });
    const { buildLockProtectionCheck } = await import("../routes/debug.js");

    const check = buildLockProtectionCheck();

    expect(check.message).toContain("EPERM");
    expect(check.params).toEqual({ code: "EPERM" });
  });
});
