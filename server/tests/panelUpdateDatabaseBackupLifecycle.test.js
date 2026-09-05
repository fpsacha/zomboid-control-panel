import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  applyUpdateBundle,
  acknowledgeUpdateBundle,
  stageUpdateBundle,
} from "../services/updateBundle.js";
import {
  createUpdateDataBackup,
  restorePreUpdateDataBackup,
} from "../services/panelUpdateChecker.js";

// 2026-08-29, PR #122 rebase (operator ruling: fix in-house rather than
// send back to the contributor). #122 restructured the panel's self-update
// into a journaled bundle transaction (updateBundle.js) but branched before
// main picked up createUpdateDataBackup() -- the pre-update db.json
// snapshot taken before any update activity begins. Rebasing #122 as
// published would have silently dropped that guarantee, invisibly to CI
// (nothing fails when a call just isn't there).
//
// This file proves TWO things with the REAL bundle machinery (no mocks of
// updateBundle.js itself), not by reading the diff:
//   1. The snapshot is taken at the right NEW place -- immediately before
//      the bundle's destructive apply step, not at download/stage time
//      (which the old call site was, and which becomes stale once download
//      and apply are two separate, arbitrarily-far-apart user actions).
//   2. #122's version-mismatch rollback path only knows how to roll back
//      the BINARY and CLIENT (updateBundle.js has zero concept of a
//      database). That rollback fires AFTER the new binary has already
//      completed its own startup -- including any database migration --
//      so a binary-only rollback there is a HALF-rollback: the old binary
//      ends up running against a database the new version already
//      migrated. Simulates that exact migration with a real file mutation
//      and proves restorePreUpdateDataBackup() is what closes the gap --
//      the test asserts the WRONG (migrated) state exists right up until
//      the restore call, and only the CORRECT (pre-update) state exists
//      after it, so this doesn't just assert a happy ending, it proves the
//      restore step is load-bearing.
function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function metadata(version = "2.0.0", buildSha = "new-build") {
  return { panelVersion: version, buildSha, apiContractVersion: 1 };
}

let installDir;

function prepareBundleWithDatabase() {
  const binaryPath = path.join(installDir, "ZomboidControlPanel");
  const stagedBinaryPath = `${binaryPath}.new`;
  const liveClientPath = path.join(installDir, "client", "dist");
  const incomingClientPath = path.join(installDir, "incoming-client");
  const dbPath = path.join(installDir, "data", "db.json");
  writeFile(binaryPath, "old-binary");
  writeFile(stagedBinaryPath, "new-binary");
  writeFile(path.join(liveClientPath, "index.html"), "old-client");
  writeFile(path.join(incomingClientPath, "index.html"), "new-client");
  writeFile(
    path.join(incomingClientPath, "build-info.json"),
    JSON.stringify(metadata()),
  );
  writeFile(dbPath, '{"schemaVersion":1,"users":[{"username":"admin"}]}');
  const dataPaths = { dbPath };

  const journalPath = stageUpdateBundle({
    installDir,
    version: "2.0.0",
    binaryPath,
    stagedBinaryPath,
    liveClientPath,
    incomingClientPath,
    metadata: metadata(),
  });

  return { binaryPath, liveClientPath, journalPath, dataPaths, dbPath };
}

describe("pre-update database backup lifecycle around a real bundle transaction", () => {
  beforeEach(() => {
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-update-db-lifecycle-"));
  });

  afterEach(() => {
    fs.rmSync(installDir, { recursive: true, force: true });
  });

  it("the snapshot exists before the destructive apply step, and survives a clean successful update", () => {
    const { binaryPath, liveClientPath, journalPath, dataPaths, dbPath } =
      prepareBundleWithDatabase();
    const originalDbContent = fs.readFileSync(dbPath, "utf8");

    // This is the NEW, correct call site: right before applyUpdateBundle(),
    // mirroring server/index.js's POST /api/panel/restart.
    const backupPath = createUpdateDataBackup(dataPaths, "2.0.0");
    expect(backupPath).toBeTruthy();
    expect(fs.readFileSync(backupPath, "utf8")).toBe(originalDbContent);

    applyUpdateBundle(journalPath);
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("new-binary");
    expect(
      fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8"),
    ).toBe("new-client");

    // Successful acknowledgement (matching metadata) -- transaction
    // complete, nothing to roll back. The snapshot must still be sitting
    // on disk afterward -- it is the operator's data, not a temp file the
    // transaction owns and cleans up.
    acknowledgeUpdateBundle(journalPath, metadata());
    expect(fs.existsSync(journalPath)).toBe(false);
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.readFileSync(backupPath, "utf8")).toBe(originalDbContent);
  });

  it("closes the half-rollback gap: restores the pre-migration database after a version-mismatch rollback", () => {
    const { binaryPath, liveClientPath, journalPath, dataPaths, dbPath } =
      prepareBundleWithDatabase();
    const preUpdateDbContent = fs.readFileSync(dbPath, "utf8");

    const backupPath = createUpdateDataBackup(dataPaths, "2.0.0");
    applyUpdateBundle(journalPath);

    // Simulate the new binary completing its OWN startup after the restart
    // -- including a database migration -- before it ever reaches the
    // acknowledgement handshake. This is the real sequence: index.js's
    // acknowledgeUpdateBundle() call happens inside the httpServer.listen()
    // callback, i.e. AFTER the whole startup sequence (which would include
    // any migration) has already run.
    const migratedDbContent = '{"schemaVersion":2,"users":[{"username":"admin","migrated":true}]}';
    fs.writeFileSync(dbPath, migratedDbContent);

    // The new binary's build doesn't match what the bundle expects --
    // acknowledgeUpdateBundle() rolls the BINARY and CLIENT back, but has
    // no idea the database exists at all.
    expect(() =>
      acknowledgeUpdateBundle(journalPath, metadata("2.0.1", "other-build")),
    ).toThrowError(expect.objectContaining({ code: "version_mismatch" }));
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(
      fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8"),
    ).toBe("old-client");

    // THE HALF-ROLLBACK, proven: binary and client are back to the OLD
    // version, but the database is still sitting at the NEW (migrated)
    // schema updateBundle.js's own rollback never touched.
    expect(fs.readFileSync(dbPath, "utf8")).toBe(migratedDbContent);
    expect(fs.readFileSync(dbPath, "utf8")).not.toBe(preUpdateDbContent);

    // The fix: server/index.js's catch block calls this with the same
    // backupPath it persisted before apply. Proves the restore step itself
    // is what closes the gap -- not just that things happen to end up
    // right.
    const restored = restorePreUpdateDataBackup(dataPaths, backupPath);
    expect(restored).toBe(true);
    expect(fs.readFileSync(dbPath, "utf8")).toBe(preUpdateDbContent);
  });

  it("the mid-apply rollback path (new binary never ran) needs no database restore at all", () => {
    // Contrast case for the same question god asked ("should the database
    // snapshot participate in the rollback path?") -- the OTHER rollback
    // path, inside applyUpdateBundle() itself, runs entirely BEFORE the new
    // binary is ever executed, so nothing could have touched the database.
    // Restoring here would be a no-op; asserting that explicitly is what
    // makes "we only wired the restore into the version-mismatch path" a
    // deliberate choice rather than an oversight.
    const { binaryPath, stagedBinaryPath, dataPaths, dbPath, journalPath } = (() => {
      const b = prepareBundleWithDatabase();
      return { ...b, stagedBinaryPath: `${b.binaryPath}.new` };
    })();
    const originalDbContent = fs.readFileSync(dbPath, "utf8");
    createUpdateDataBackup(dataPaths, "2.0.0");

    // Force the mid-apply failure the existing panelUpdateBundle.test.js
    // suite already covers (missing staged binary -> hash_unverifiable,
    // main-is-red 2026-09-05: distinct from av_quarantine's genuine
    // computed mismatch), before any binary/client swap happens.
    fs.unlinkSync(stagedBinaryPath);
    expect(() => applyUpdateBundle(journalPath)).toThrowError(
      expect.objectContaining({ code: "hash_unverifiable" }),
    );
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    // The database was never touched -- still exactly the pre-update
    // content, with no restore call needed or made.
    expect(fs.readFileSync(dbPath, "utf8")).toBe(originalDbContent);
  });
});

describe("restorePreUpdateDataBackup() -- edge cases", () => {
  let dir;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns false and touches nothing when no backup path was recorded", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-restore-nobackup-"));
    const dbPath = path.join(dir, "db.json");
    fs.writeFileSync(dbPath, "live-content");

    expect(restorePreUpdateDataBackup({ dbPath }, null)).toBe(false);
    expect(restorePreUpdateDataBackup({ dbPath }, undefined)).toBe(false);
    expect(fs.readFileSync(dbPath, "utf8")).toBe("live-content");
  });

  it("returns false without throwing when the recorded backup no longer exists on disk", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-restore-missing-"));
    const dbPath = path.join(dir, "db.json");
    fs.writeFileSync(dbPath, "live-content");
    const goneBackupPath = path.join(dir, "db.json.pre-update-1.0.0-123");

    expect(restorePreUpdateDataBackup({ dbPath }, goneBackupPath)).toBe(false);
    expect(fs.readFileSync(dbPath, "utf8")).toBe("live-content");
  });
});
