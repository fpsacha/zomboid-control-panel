import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// LINUX BUG HUNT (2026-08-29, "raw EACCES with no pointer to the fix"):
// operator report -- EACCES: permission denied, open '/pz-server/servertest.ini'
// -- with nothing anywhere pointing at PUID/PGID, even though docker-
// compose.yml's own Quick Start comments document it right above the
// bind-mount lines. ensureRconConfigured() is the exact function that
// writes/updates that INI file (candidateIniPaths() includes servertest.ini
// by name), and until this fix it silently swallowed EACCES with a bare
// log.error(error.message) -- no operator-facing guidance at all, not even
// an unfriendly one, since this function has no HTTP response path (it's
// called from refreshLaunchTargetBeforeStart() before a manual/scheduled
// start).
//
// Only mocks database/init.js and the logger; fs/chmod/directory ownership
// are all real, run against a real ext4 permission mismatch -- a directory
// this test process genuinely cannot write to, matching the dispatch's own
// suggested repro ("a directory owned by another user on real ext4 gives
// you the same errno").

const isPosix = process.platform !== "win32";

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer: (...args) => getActiveServer(...args),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

const { logSpy } = vi.hoisted(() => ({
  logSpy: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../utils/logger.js", () => ({
  createLogger: () => logSpy,
}));

const { ensureRconConfigured } = await import("../routes/server.js");

afterEach(() => {
  getActiveServer.mockReset();
  logSpy.error.mockReset();
  logSpy.warn.mockReset();
  logSpy.info.mockReset();
  logSpy.debug.mockReset();
});

(isPosix ? describe : describe.skip)(
  "ensureRconConfigured(): translates an EACCES into operator-facing guidance",
  () => {
    it("a serverConfigPath this process genuinely cannot write to logs BOTH the raw errno AND the friendly chown/chmod guidance", async () => {
      // Requires a directory this test process truly cannot write into.
      // Running as root defeats normal permission bits entirely, so this
      // specific assertion only means something when NOT root -- CI and a
      // real operator's panel process both run unprivileged. When running
      // as root (e.g. an ad-hoc local check), the write silently succeeds
      // instead of throwing, which the test below verifies explicitly
      // rather than silently passing for the wrong reason.
      const unwritableDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "pz-eacces-guidance-"),
      );
      fs.chmodSync(unwritableDir, 0o500); // r-x, no write, even for the owner

      const probePath = path.join(unwritableDir, ".write-probe");
      let reallyBlocked = true;
      try {
        fs.writeFileSync(probePath, "x");
        fs.unlinkSync(probePath);
        reallyBlocked = false;
      } catch {
        reallyBlocked = true;
      }

      getActiveServer.mockResolvedValue({
        serverName: "TestServer",
        serverConfigPath: unwritableDir,
        rconPassword: "hunter2",
        rconPort: 27015,
      });

      const result = await ensureRconConfigured();

      if (!reallyBlocked) {
        // Running with elevated privileges (e.g. root) -- the write
        // actually succeeded, so there is nothing to translate. Assert
        // that positive-control fact explicitly instead of silently
        // passing an assertion that never ran for the intended reason.
        expect(result).toBe(true);
        fs.rmSync(unwritableDir, { recursive: true, force: true });
        return;
      }

      expect(result).toBe(false);
      const loggedError = logSpy.error.mock.calls
        .map((call) => call[0])
        .find((msg) => msg.includes("EACCES") || msg.includes("Failed to pre-create"));
      expect(loggedError).toBeTruthy();
      // The raw errno survives (someone debugging still needs it)...
      expect(loggedError).toMatch(/EACCES/);
      // ...alongside the friendly, actionable guidance naming the actual fix.
      expect(loggedError).toMatch(/chown|chmod/i);

      fs.chmodSync(unwritableDir, 0o700);
      fs.rmSync(unwritableDir, { recursive: true, force: true });
    });

    it("positive control: a genuinely writable serverConfigPath configures RCON normally with no guidance text logged", async () => {
      const writableDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "pz-eacces-guidance-ok-"),
      );

      getActiveServer.mockResolvedValue({
        serverName: "TestServer",
        serverConfigPath: writableDir,
        rconPassword: "hunter2",
        rconPort: 27015,
      });

      const result = await ensureRconConfigured();

      expect(result).toBe(true);
      const guidanceLogged = logSpy.error.mock.calls
        .map((call) => call[0])
        .some((msg) => /chown|chmod/i.test(msg));
      expect(guidanceLogged).toBe(false);

      fs.rmSync(writableDir, { recursive: true, force: true });
    });
  },
);
