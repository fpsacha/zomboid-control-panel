import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

// bug hunt 2026-09-05 (backup-restore-round-trip sweep, items #3 and #4).
// Per-file dataDir/config comes from vitest.perFileDataDir.setup.mjs
// (global setupFiles) -- same convention as dbBackupRestoreRoundTrip.test.js.
const { getDataPaths } = await import("../utils/paths.js");
const { dataDir, dbPath } = getDataPaths();
const backupDir = path.join(dataDir, "backups");

describe("getDb() recovery: a missing db.json beside an intact ring, and a corrupt db.json beside an empty ring", () => {
  it("item #3: db.json missing (not corrupt) but the backup ring is intact -- recovers from backup instead of silently adopting empty defaults", async () => {
    const { getDb, setSetting, createDatabaseBackup } = await import(
      "../database/init.js"
    );
    await getDb();
    await setSetting("missingFileMarker", "real-data-that-must-survive");
    const backupResult = await createDatabaseBackup();
    expect(backupResult.success).toBe(true);

    // Simulate the file simply being gone -- a bad mount, a stray delete,
    // an interrupted move -- NOT corruption. The ring next to it is fully
    // intact.
    fs.unlinkSync(dbPath);
    expect(fs.existsSync(dbPath)).toBe(false);
    const backupsBeforeRestart = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith("db-") && f.endsWith(".json"));
    expect(backupsBeforeRestart.length).toBeGreaterThan(0);

    // Simulate a process restart against the SAME dataDir.
    vi.resetModules();
    const { getDb: getDbAfterRestart } = await import("../database/init.js");
    const restarted = await getDbAfterRestart();

    // The real fix under test: this must NOT be empty defaultData. Before
    // the fix, db.read() doesn't throw for a missing file, so this branch
    // looked identical to a genuine first boot.
    expect(restarted.data.settings.missingFileMarker).toBe(
      "real-data-that-must-survive",
    );

    // The recovered file now sitting at dbPath must itself be real content,
    // not an empty-defaults file the "startup" snapshot would otherwise
    // have captured and started rotating the real ring out in favour of.
    const recoveredOnDisk = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
    expect(recoveredOnDisk.settings.missingFileMarker).toBe(
      "real-data-that-must-survive",
    );
  });

  // 2026-09-09: item #3 above went flaky on a clean Linux CI gate for
  // 35fec946 -- an unrelated RCON-host commit -- then passed clean on an
  // immediate re-run of the identical SHA. Root cause: getDb()'s own
  // "startup" snapshot and this test's "manual" one can land in the exact
  // same millisecond on a filesystem fast enough for two sequential
  // synchronous writes to beat toISOString()'s ms resolution (common on a
  // clean CI clone's tmpfs-backed temp dir, rare on a real dev disk --
  // which is why it never reproduced locally). listBackupsNewestFirst()
  // then fell back to comparing LABEL TEXT alphabetically ("manual" <
  // "startup"), ranking the OLDER startup snapshot as "newest" and
  // recovering from it instead of the real one. Freezing Date makes the
  // collision deterministic on every run instead of hoping real disk
  // latency reproduces it -- a stronger proof than repeated real-timing
  // attempts, per the standard of proving a flake fix with more than one
  // pass.
  it("item #3b: a startup snapshot and a manual backup landing in the SAME millisecond still recover the newer one, not the older", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      // Fresh db singleton -- item #3 above left one cached with its own
      // data and its own (real-timestamped) backups already in the ring.
      // Without this, getDb()'s `if (!db)` guard would return item #3's
      // leftover instance and never take the first-load "startup" snapshot
      // this test needs to land at the frozen instant.
      vi.resetModules();
      for (const f of fs.readdirSync(backupDir)) {
        fs.unlinkSync(path.join(backupDir, f));
      }

      const { getDb, setSetting, createDatabaseBackup } = await import(
        "../database/init.js"
      );
      // getDb()'s own end-of-load snapshot (label "startup") lands at the
      // frozen instant above.
      await getDb();
      await setSetting("sameMsMarker", "the-newer-backup-must-win");
      // createDatabaseBackup()'s "manual" snapshot -- Date is still frozen
      // to the IDENTICAL instant, so without the fix this collides with
      // "startup" on the exact same millisecond.
      const backupResult = await createDatabaseBackup();
      expect(backupResult.success).toBe(true);

      const backups = fs
        .readdirSync(backupDir)
        .filter((f) => f.startsWith("db-") && f.endsWith(".json"));
      // Proves the collision actually happened (both landed at the frozen
      // instant) rather than this test accidentally not exercising it.
      expect(backups.some((f) => f.includes("-startup"))).toBe(true);
      expect(backups.some((f) => f.includes("-manual"))).toBe(true);

      fs.unlinkSync(dbPath);
      vi.resetModules();
      const { getDb: getDbAfterRestart } = await import("../database/init.js");
      const restarted = await getDbAfterRestart();

      expect(restarted.data.settings.sameMsMarker).toBe(
        "the-newer-backup-must-win",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("item #4: db.json corrupt AND the backup ring is empty -- still falls back to a fresh database, but now preserves the corrupt bytes for forensics first", async () => {
    // Shares this file's dataDir with the test above (per-file, not
    // per-test, isolation -- see vitest.perFileDataDir.setup.mjs). Get a
    // clean load first (getDb() itself always drops a "startup" snapshot
    // once dbPath exists -- there is no way to have a valid dbPath and
    // truly zero backups without going through one load), then clear
    // backupDir so THIS scenario's ring is genuinely empty before
    // corrupting dbPath directly.
    vi.resetModules();
    const { getDb } = await import("../database/init.js");
    await getDb();
    for (const f of fs.readdirSync(backupDir)) {
      fs.unlinkSync(path.join(backupDir, f));
    }

    // No backups exist yet in this test (nothing called createDatabaseBackup
    // before this point) -- an empty ring is the whole point of this case.
    const backupsBeforeCorruption = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith("db-") && f.endsWith(".json"));
    expect(backupsBeforeCorruption).toHaveLength(0);

    const corruptBytes = '{"servers": [ this is not valid JSON,,,';
    fs.writeFileSync(dbPath, corruptBytes, "utf-8");

    vi.resetModules();
    const { getDb: getDbAfterRestart } = await import("../database/init.js");
    const restarted = await getDbAfterRestart();

    // Existing, acceptable behaviour: no ring to recover from means a
    // fresh database -- this test is not challenging that half.
    expect(restarted.data.settings).toEqual({});
    expect(restarted.data.servers).toEqual([]);

    // The actual fix under test: the original corrupt bytes must now be
    // preserved somewhere under backupDir, OUTSIDE the rotation ring
    // (pruneBackups only ever touches "db-*.json"), so an operator has
    // something to hand-recover from. Before the fix this forensic
    // snapshot only ran when a backup ring existed to recover from --
    // with an empty ring, the corrupt bytes were simply overwritten by the
    // fresh empty database with no trace left anywhere.
    const corruptSnapshots = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith("corrupt-") && f.endsWith(".json"));
    expect(corruptSnapshots).toHaveLength(1);
    const preserved = fs.readFileSync(
      path.join(backupDir, corruptSnapshots[0]),
      "utf-8",
    );
    expect(preserved).toBe(corruptBytes);
  });
});
