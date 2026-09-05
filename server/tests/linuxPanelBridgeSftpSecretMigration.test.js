import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

// 2026-08-29 auth/session/DB bug hunt (god): panelBridgeSftpPassword was the
// one settings-field credential that never moved out of db.json the way
// discordBotToken, steamSessionId/steamLoginSecure and rconPassword all did
// -- both db.json backup paths (createDatabaseBackup() below, and the #122
// pre-update snapshot in panelUpdateChecker.js) copy db.json as a raw file,
// so the plaintext password rode along in every one of them. Fixed by
// giving panelBridgeSftpPassword the SAME rehydrate-on-load/redact-on-write
// shape as rconPassword (not the discordBotToken/steamSessionId shape --
// see the doc comment on rehydratePanelBridgeSftpPassword in
// database/init.js for why the two existing precedents don't match equally
// well here). Real database/init.js (not mocked), per-test-file real
// dataDir via vitest.perFileDataDir.setup.mjs -- same approach as
// circuitBreakerStatus.test.js / linuxDbFileModes.test.js.
const {
  getDb,
  commitNow,
  setSetting,
  createDatabaseBackup,
  rehydratePanelBridgeSftpPassword,
  redactPanelBridgeSftpPasswordForWrite,
} = await import("../database/init.js");
const { getDataPaths } = await import("../utils/paths.js");
const { readUiSecretFile, writeUiSecretFile } = await import(
  "../utils/uiSecretFile.js"
);

const { dataDir, dbPath } = getDataPaths();
const backupDir = path.join(dataDir, "backups");
const isWindows = process.platform === "win32";

// An obviously-fake placeholder, never a real credential -- same convention
// as the other secrets-card tests today.
const FAKE_PASSWORD = "obviously-fake-sftp-password-do-not-use";

function secretFilePath(name) {
  return path.join(dataDir, `${name}.secret`);
}

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(secretFilePath("panelBridgeSftpPassword"), { force: true });
});

describe("panelBridgeSftpPassword — migrates out of db.json on the very first write, like rconPassword", () => {
  it("a legacy plaintext value is redacted from db.json and lands in its own file on the next flush", async () => {
    await getDb();
    await setSetting("panelBridgeSftpPassword", FAKE_PASSWORD);
    await commitNow();

    const onDisk = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
    expect(onDisk.settings.panelBridgeSftpPassword).toBeUndefined();
    expect(readUiSecretFile("panelBridgeSftpPassword")).toBe(FAKE_PASSWORD);
  });

  // Split out from the test above (was an in-body `if (!isWindows)` around
  // this assertion) -- that made the mode check silently never run on
  // Windows while the test still reported PASSED, not SKIPPED, matching
  // this codebase's it.skipIf(isWindows) convention (see
  // linuxSecretsFileModes.test.js) so the skip is visible in the reporter
  // instead of invisible inside a passing test.
  it.skipIf(isWindows)(
    "the secret file the legacy value lands in is 0600",
    async () => {
      await getDb();
      await setSetting("panelBridgeSftpPassword", FAKE_PASSWORD);
      await commitNow();

      const mode = fs.statSync(secretFilePath("panelBridgeSftpPassword")).mode & 0o777;
      expect(mode).toBe(0o600);
    },
  );

  it("survives a restart -- the in-memory value is re-attached from the secret file, not lost", async () => {
    await getDb();
    await setSetting("panelBridgeSftpPassword", FAKE_PASSWORD);
    await commitNow();

    // Simulate the next process boot: rehydrate against a settings object
    // that has nothing (matches what db.json actually holds post-flush).
    const rehydrated = rehydratePanelBridgeSftpPassword({ settings: {} }, console);
    expect(rehydrated.settings.panelBridgeSftpPassword).toBe(FAKE_PASSWORD);
  });
});

describe("ASK 1 -- the backup win, measured (not deduced)", () => {
  it("a real backup taken AFTER the fix does not contain the plaintext password anywhere in the file", async () => {
    await getDb();
    await setSetting("panelBridgeSftpPassword", FAKE_PASSWORD);
    await commitNow();

    const result = await createDatabaseBackup();
    expect(result.success).toBe(true);
    const backupContent = fs.readFileSync(path.join(backupDir, result.file), "utf-8");
    expect(backupContent).not.toContain(FAKE_PASSWORD);
  });

  it("BREAK-VERIFY CONTROL: a real backup taken with the redact step disabled DOES contain the plaintext -- proves the win is real, not vacuous", async () => {
    const db = await getDb();

    // Simulate "before the fix": flushWrites() without the new redact step.
    // Reaches into the same write path flushWrites() itself uses so this is
    // a faithful stand-in for the pre-fix code, not a hand-rolled write.
    //
    // Mutates db.data directly (NOT setSetting(), which calls scheduleWrite()
    // and would leave _dirty=true) -- createDatabaseBackup() itself now
    // flushes pending writes before snapshotting (2026-09-05,
    // backup-restore-round-trip hunt: a real flush always redacts, so a
    // _dirty=true backup call would silently overwrite this test's
    // deliberately-unredacted file with a properly-redacted one before the
    // copy, defeating the control). Leaving _dirty=false here means that
    // flush is a no-op and the raw file below is what actually gets backed up.
    db.data.settings.panelBridgeSftpPassword = FAKE_PASSWORD;
    const raw = JSON.stringify(db.data, null, 2); // no redaction at all
    fs.writeFileSync(dbPath, raw, { encoding: "utf-8", mode: 0o600 });

    const result = await createDatabaseBackup();
    expect(result.success).toBe(true);
    const backupContent = fs.readFileSync(path.join(backupDir, result.file), "utf-8");
    expect(backupContent).toContain(FAKE_PASSWORD);

    // Restore real state for subsequent tests in this file.
    await setSetting("panelBridgeSftpPassword", FAKE_PASSWORD);
    await commitNow();
  });
});

describe("ASK 2 -- restoring an old (pre-migration) backup that still carries the plaintext", () => {
  it("the restored plaintext is used as-is, not clobbered by a stale/absent secret file, and gets redacted again on the next flush", async () => {
    // A stale secret file left over from before the restore -- must NOT win
    // over the just-restored value.
    writeUiSecretFile("panelBridgeSftpPassword", "stale-value-from-before-restore");

    // Simulate db.read() loading an old-shaped db.json that still has the
    // plaintext (this is exactly what a restored pre-migration backup looks
    // like once loaded into memory).
    const restored = rehydratePanelBridgeSftpPassword(
      { settings: { panelBridgeSftpPassword: FAKE_PASSWORD } },
      console,
    );
    expect(restored.settings.panelBridgeSftpPassword).toBe(FAKE_PASSWORD);

    // The next flush redacts whatever is actually in memory -- the restored
    // value, not the stale file.
    const redacted = redactPanelBridgeSftpPasswordForWrite(restored);
    expect(redacted.settings.panelBridgeSftpPassword).toBeUndefined();
    expect(readUiSecretFile("panelBridgeSftpPassword")).toBe(FAKE_PASSWORD);
  });
});

describe("ASK 3 -- the one god is worried about: db.json restored, but panelBridgeSftpPassword.secret did not make the trip", () => {
  it("resolves to undefined silently -- no thrown error, no warning logged. Same shape as rconPassword's pre-existing analogous gap (see report; not fixed here, filed separately).", () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    // db.json shape after a successful prior migration: no plaintext, and
    // (simulating the restore) no secret file on disk either.
    expect(fs.existsSync(secretFilePath("panelBridgeSftpPassword"))).toBe(false);

    const result = rehydratePanelBridgeSftpPassword({ settings: {} }, log);

    expect(result.settings.panelBridgeSftpPassword).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
