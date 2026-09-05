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
