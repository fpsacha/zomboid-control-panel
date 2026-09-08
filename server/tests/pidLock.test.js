import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

// bughunt-2026-08-31-c: pidLock.js had no test file at all. It also carried
// its own separate isProcessAlive() (now removed, folded onto the shared
// isPidAlive() in utils/pidLiveness.js) that got the ambiguous-signal
// direction backwards -- it treated any process.kill() error OTHER than
// EPERM as "not alive," i.e. safe to proceed and start a second panel
// instance. Operator ruling: this must fail the OTHER way -- an
// inconclusive liveness signal has to refuse to start, not proceed, because
// a false proceed risks the port-conflict/db.json-corruption pair this file
// exists to prevent, while a false refusal is a one-step recovery (delete
// the lock file, restart). These tests exercise both error branches
// directly, not just the happy path, since the ambiguous-error branch is
// the whole point of the fix and is exactly what the old code got backwards.
//
// pidLock.js's `_released` flag is a fire-once-per-process latch by design
// (matches its real production lifetime: one acquire, one release, then the
// process exits) -- it is never reset by acquireLock(). vi.resetModules()
// before every test gets a fresh module instance instead of fighting that
// latch across tests in one process.

function makeDeadPid() {
  // A real pid guaranteed to have exited by the time this returns --
  // spawnSync only returns once the child is gone. Same technique as
  // jimBackupOrphanTempPidLiveness.test.js's makeDeadPid().
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return result.pid;
}

describe("acquireLock / releaseLock", () => {
  let dataDir;
  let killSpy;
  let acquireLock;
  let releaseLock;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-pidlock-"));
    vi.resetModules();
    ({ acquireLock, releaseLock } = await import("../utils/pidLock.js"));
  });

  afterEach(() => {
    killSpy?.mockRestore();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("acquires the lock when no lock file exists yet, and writes this process's own pid into it", () => {
    const result = acquireLock(dataDir);
    expect(result.acquired).toBe(true);
    expect(fs.readFileSync(result.lockPath, "utf8")).toBe(String(process.pid));
  });

  it("acquires the lock when the existing lock file names this SAME process's pid (re-entrant start)", () => {
    fs.writeFileSync(path.join(dataDir, "panel.lock"), String(process.pid));
    const result = acquireLock(dataDir);
    expect(result.acquired).toBe(true);
  });

  it("acquires the lock when the existing lock file's pid is CONFIRMED dead (ESRCH) -- a stale lock is silently replaced", () => {
    const deadPid = makeDeadPid();
    fs.writeFileSync(path.join(dataDir, "panel.lock"), String(deadPid));

    const result = acquireLock(dataDir);

    expect(result.acquired).toBe(true);
    expect(fs.readFileSync(result.lockPath, "utf8")).toBe(String(process.pid));
  });

  it("refuses to acquire when the existing lock file's pid is genuinely alive (no error at all from process.kill)", () => {
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    fs.writeFileSync(path.join(dataDir, "panel.lock"), "424242");

    const result = acquireLock(dataDir);

    expect(result.acquired).toBe(false);
    expect(result.existingPid).toBe(424242);
    expect(result.reason).toMatch(/already running/i);
  });

  // The branch this whole fix is about: an INCONCLUSIVE signal, neither a
  // confirmed-dead ESRCH nor a confirmed-alive success/EPERM. Pre-fix, this
  // fell through to "not alive" and let a second instance start. Post-fix,
  // it must refuse -- an ambiguous signal is never grounds to proceed.
  it("REFUSES to acquire on an ambiguous process.kill() error (neither ESRCH nor EPERM) -- the direction the old code got backwards", () => {
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("something unexpected");
      err.code = "EINVAL";
      throw err;
    });
    fs.writeFileSync(path.join(dataDir, "panel.lock"), "424242");

    const result = acquireLock(dataDir);

    expect(result.acquired).toBe(false);
    expect(result.existingPid).toBe(424242);
  });

  it("treats EPERM (exists, just not owned by us) as alive -- refuses to acquire", () => {
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("Operation not permitted");
      err.code = "EPERM";
      throw err;
    });
    fs.writeFileSync(path.join(dataDir, "panel.lock"), "424242");

    const result = acquireLock(dataDir);

    expect(result.acquired).toBe(false);
  });

  it("ignores a lock file whose content isn't a positive integer pid, and proceeds", () => {
    fs.writeFileSync(path.join(dataDir, "panel.lock"), "not-a-pid");

    const result = acquireLock(dataDir);

    expect(result.acquired).toBe(true);
  });

  it("releaseLock() removes the lock file this process created", () => {
    const result = acquireLock(dataDir);
    expect(fs.existsSync(result.lockPath)).toBe(true);

    releaseLock();

    expect(fs.existsSync(result.lockPath)).toBe(false);
  });

  it("releaseLock() does NOT remove a lock file that no longer contains our pid (another instance took over)", () => {
    const result = acquireLock(dataDir);
    fs.writeFileSync(result.lockPath, "999999");

    releaseLock();

    expect(fs.existsSync(result.lockPath)).toBe(true);
    expect(fs.readFileSync(result.lockPath, "utf8")).toBe("999999");
  });

  // god's dispatch, 2026-09-08: the catch block below (lock file cannot be
  // WRITTEN at all) predates bughunt-2026-08-31-c above and was never
  // revisited by it -- confirmed via git history (that fix's own commit
  // message scopes itself to the ambiguous-liveness-signal branch, and its
  // test file above covers every OTHER branch but not this one). It
  // unconditionally proceeded without a lock on ANY write failure, the
  // opposite direction from the ruling three lines above it in source.
  // These test the fix: the specific, empirically-verified codes
  // (EXPECTED_UNWRITABLE_CODES in pidLock.js -- verified against real
  // environments, not derived: a real Linux read-only bind mount, a real
  // Linux chmod-000 directory, a real Windows ACL-deny) still proceed
  // (refusing would turn a supported read-only-mount deployment into its
  // own outage), but anything NOT on that list now refuses, matching the
  // ruling instead of silently bypassing it.
  describe("lock file cannot be written at all (data directory unwritable)", () => {
    let writeSpy;

    afterEach(() => {
      writeSpy?.mockRestore();
    });

    function mockWriteFailure(code, message) {
      writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
        const err = new Error(message || `${code}: mocked failure`);
        err.code = code;
        throw err;
      });
    }

    it.each(["EROFS", "EACCES", "EPERM", "EBUSY"])(
      "proceeds without a lock on %s (the documented, accepted read-only/access-restricted case) and records why",
      (code) => {
        mockWriteFailure(code);

        const result = acquireLock(dataDir);

        expect(result.acquired).toBe(true);
        expect(result.lockPath).toBeNull();
      },
    );

    it.each(["ENOSPC", "EIO", "EMFILE"])(
      "REFUSES to start on %s -- an unexpected write failure, never a considered exception to the fail-toward-refuse ruling",
      (code) => {
        mockWriteFailure(code);

        const result = acquireLock(dataDir);

        expect(result.acquired).toBe(false);
        expect(result.reason).toContain(code);
      },
    );

    it("isLockProtectionDisabled() reflects the accepted-code case persistently, for a diagnostics check to read later", async () => {
      const { isLockProtectionDisabled } = await import("../utils/pidLock.js");
      expect(isLockProtectionDisabled()).toBeFalsy();

      mockWriteFailure("EROFS", "read-only file system, open 'panel.lock'");
      acquireLock(dataDir);

      const disabled = isLockProtectionDisabled();
      expect(disabled).toBeTruthy();
      expect(disabled.code).toBe("EROFS");
    });

    it("isLockProtectionDisabled() is null again after a SUBSEQUENT successful real acquisition", async () => {
      const { isLockProtectionDisabled } = await import("../utils/pidLock.js");

      mockWriteFailure("EROFS");
      acquireLock(dataDir);
      expect(isLockProtectionDisabled()).toBeTruthy();

      writeSpy.mockRestore();
      acquireLock(dataDir);

      expect(isLockProtectionDisabled()).toBeFalsy();
    });

    it("does not refuse on an unexpected code just because a live-lock refusal would also refuse -- reason text distinguishes the two", () => {
      mockWriteFailure("ENOSPC", "no space left on device");

      const result = acquireLock(dataDir);

      expect(result.acquired).toBe(false);
      expect(result.reason).not.toMatch(/already running/i);
      expect(result.existingPid).toBeUndefined();
    });
  });
});
