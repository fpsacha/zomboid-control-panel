import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

// backup-restore-round-trip hunt (2026-09-05, god): "does a backup actually
// restore" had never been proven end to end with the REAL createBackup/
// createDatabaseBackup code paths and a REAL corruption+recovery cycle --
// every existing test either hand-crafted backup file content directly
// (dbCorruptionRecoveryFallsThroughBackupRing.test.js) or exercised
// runMigrations() in isolation against a plain object
// (rolesMigration.test.js), never both together through the real getDb()
// singleton. This file closes that gap, and the first test below is what
// found the real bug: createDatabaseBackup() copied whatever was CURRENTLY
// ON DISK, with no visibility into a pending debounced write.
//
// Per-file dataDir/config already comes from vitest.perFileDataDir.setup.mjs
// (global setupFiles) -- this file deliberately does NOT mint its own
// tempRoot the way dbCorruptionRecoveryFallsThroughBackupRing.test.js does,
// because the round-trip test below needs the SAME dataDir across a
// simulated restart (vi.resetModules() + re-import), not a fresh one per
// scenario.
const { getDataPaths } = await import("../utils/paths.js");
const { dataDir, dbPath } = getDataPaths();
const backupDir = path.join(dataDir, "backups");

describe("db.json backup -> restore round trip: real code paths, not hand-crafted files", () => {
  it("FINDING (fixed 2026-09-05): createDatabaseBackup() used to snapshot a STALE on-disk db.json, silently missing a change made moments earlier", async () => {
    const { getDb, setSetting, createDatabaseBackup } = await import(
      "../database/init.js"
    );
    await getDb();

    // No commitNow()/flush in between -- setSetting() only schedules a
    // debounced write (WRITE_DEBOUNCE_MS=500ms). Before the fix,
    // createDatabaseBackup() copied dbPath via fs.copyFileSync with no
    // awareness of that pending write, so the backup captured whatever was
    // on disk from BEFORE this call -- reporting success:true with the
    // change silently absent.
    await setSetting("roundTripMarker", "the-just-made-change");

    const result = await createDatabaseBackup();
    expect(result.success).toBe(true);

    const backupContent = JSON.parse(
      fs.readFileSync(path.join(backupDir, result.file), "utf-8"),
    );
    expect(backupContent.settings.roundTripMarker).toBe(
      "the-just-made-change",
    );
  });

  it("a real backup, taken via the real createDatabaseBackup(), survives db.json corruption and getDb() recovers it with every field intact -- diffed against the original, not spot-checked", async () => {
    const {
      getDb,
      createDatabaseBackup,
      createServer,
      insertRole,
      setSetting,
      addTrackedMod,
    } = await import("../database/init.js");
    await getDb();

    // Realistic, varied data across several collections -- not a single
    // marker field, so a partial-restore bug (one collection's array
    // silently dropped) would actually show up in the diff below.
    await createServer({
      serverName: "round-trip-server",
      serverConfigPath: "/fake/path",
      // Non-empty on purpose: rconPassword is redacted out of what's
      // actually WRITTEN to disk and rehydrated from its own secret file on
      // load (same shape as panelBridgeSftpPassword) -- an empty string
      // isn't a "real" secret worth storing separately, so it would come
      // back genuinely absent after a round trip, which is correct existing
      // behavior, not something this test should treat as a mismatch. A
      // real value here proves the redact/rehydrate cycle itself survives
      // the round trip too, not just the plain fields.
      rconPassword: "round-trip-fake-rcon-password",
    });
    await insertRole({
      id: "role-custom-round-trip",
      name: "round-trip-custom",
      capabilities: ["players.view"],
      isSeeded: false,
    });
    await setSetting("roundTripMarker", "original-value");
    await addTrackedMod("123456", "Round Trip Mod");

    const result = await createDatabaseBackup();
    expect(result.success).toBe(true);
    const backupFile = result.file;

    const dbBeforeCorruption = await getDb();
    // Deep clone: dbBeforeCorruption.data is about to be replaced wholesale
    // by the next module instance's own load, not mutated in place, but
    // clone anyway so this comparison can never be accidentally vacuous
    // (comparing an object against itself).
    const originalData = JSON.parse(JSON.stringify(dbBeforeCorruption.data));

    // Simulate the live db.json becoming unreadable -- the scenario the
    // whole backup ring exists for.
    fs.writeFileSync(dbPath, "{ not valid json, simulating corruption");

    // Simulate a process restart: fresh module graph, same dataDir/config
    // (PANEL_PATHS_CONFIG_PATH is untouched here -- vi.resetModules() only
    // resets the module registry, not process.env).
    vi.resetModules();
    const freshMod = await import("../database/init.js");
    const recoveredDb = await freshMod.getDb();

    // Full-object diff, not a spot check -- this is the actual ask
    // ("diff the result against the original, not just the call returned
    // 200"). Excludes nothing: every collection the calls above touched.
    expect(recoveredDb.data.servers).toEqual(originalData.servers);
    expect(recoveredDb.data.roles).toEqual(originalData.roles);
    expect(recoveredDb.data.settings).toEqual(originalData.settings);
    expect(recoveredDb.data.tracked_mods).toEqual(originalData.tracked_mods);
    expect(recoveredDb.data._schemaVersion).toBe(originalData._schemaVersion);

    // And the recovery actually came from the backup this test made, not
    // some other candidate in the ring (only one exists at this point plus
    // the startup one from module init -- confirming this one is readable
    // and matches is still worth asserting directly). Compares the RAW file
    // on disk, so rconPassword is expected to differ here -- it's
    // deliberately redacted from what's written (same as the secrets check
    // above proves it correctly rehydrates back on load), this is checking
    // every OTHER field made the trip in the raw file itself.
    const backedUpContent = JSON.parse(
      fs.readFileSync(path.join(backupDir, backupFile), "utf-8"),
    );
    const { rconPassword: _omitted, ...originalServerSansSecret } =
      originalData.servers[0];
    expect(backedUpContent.servers).toEqual([originalServerSansSecret]);
    expect(backedUpContent.servers[0].rconPassword).toBeUndefined();
  });

  it("schema evolution: restoring a genuinely v1-shaped backup migrates it correctly, with no silent data loss on the custom role/user it already had", async () => {
    // A realistic snapshot from BEFORE the v2 (role seeding) and v3
    // (backups.download split) migrations existed -- not runMigrations()
    // exercised in isolation against a plain object (that's
    // rolesMigration.test.js's job), a real backup file restored through the
    // real getDb() corruption-recovery path, the same way an operator's
    // actual old backup would be.
    const v1Snapshot = {
      _schemaVersion: 1,
      settings: { customOldSetting: "still-here-after-migration" },
      servers: [{ id: "srv-old", serverName: "pre-v2-server" }],
      users: [{ username: "old-admin", role: "custom-pre-split-role" }],
      roles: [
        {
          id: "role-custom-pre-split",
          name: "custom-pre-split-role",
          // Pre-v3: had backups.manage, never had a chance to also get
          // backups.download since that capability didn't exist yet.
          capabilities: ["backups.manage", "server.control"],
          isSeeded: false,
        },
      ],
    };
    fs.mkdirSync(backupDir, { recursive: true });
    // Clear any backups an earlier test in this file left behind -- recovery
    // tries the ring newest-first by filename, and this snapshot's filename
    // deliberately carries an OLD-looking timestamp (matching its content's
    // age), which would otherwise lose to a same-run backup dated today and
    // never actually get exercised.
    for (const f of fs.readdirSync(backupDir)) {
      fs.unlinkSync(path.join(backupDir, f));
    }
    fs.writeFileSync(
      path.join(backupDir, "db-2020-01-01T00-00-00-000Z-manual.json"),
      JSON.stringify(v1Snapshot),
    );
    fs.writeFileSync(dbPath, "{ corrupt, forcing recovery from the v1 backup");

    vi.resetModules();
    const freshMod = await import("../database/init.js");
    const db = await freshMod.getDb();

    expect(db.data._schemaVersion).toBe(3);

    // Nothing the v1 snapshot already had was silently dropped.
    expect(db.data.settings.customOldSetting).toBe(
      "still-here-after-migration",
    );
    expect(db.data.servers).toEqual([
      { id: "srv-old", serverName: "pre-v2-server" },
    ]);

    // Migration 3: a role that already held backups.manage backfills
    // backups.download (same trust level it always had).
    const customRole = db.data.roles.find(
      (r) => r.id === "role-custom-pre-split",
    );
    expect(customRole.capabilities).toEqual(
      expect.arrayContaining(["backups.manage", "backups.download", "server.control"]),
    );

    // Migration 2: the v2 default-role seed runs alongside an existing
    // install's own custom role, not instead of it.
    expect(db.data.roles.some((r) => r.id === "role-admin")).toBe(true);

    // Migration 2's dual-write: the user's roleId backfilled from its role
    // name, without touching the existing `role` string field.
    const user = db.data.users.find((u) => u.username === "old-admin");
    expect(user.role).toBe("custom-pre-split-role");
    expect(user.roleId).toBe("role-custom-pre-split");
  });

  it("rotation boundary: pruning after MAX_BACKUPS+3 real backups keeps exactly the newest 5, by content -- not just by count", async () => {
    const { getDb, createDatabaseBackup, setSetting } = await import(
      "../database/init.js"
    );
    await getDb();

    const totalBackups = 8; // MAX_BACKUPS (5) + 3
    for (let i = 0; i < totalBackups; i++) {
      // Distinguishable content per call -- proves WHICH backups survived
      // pruning, not merely how many files remain (a filename-timestamp
      // collision between two calls would silently reduce the real count
      // below `totalBackups` while still passing a count-only check).
      await setSetting("rotationMarker", `backup-number-${i}`);
      const result = await createDatabaseBackup();
      expect(result.success).toBe(true);
    }

    const manualBackups = fs
      .readdirSync(backupDir)
      .filter((f) => f.endsWith("-manual.json"))
      .sort();
    expect(manualBackups).toHaveLength(5);

    const survivingMarkers = manualBackups
      .map((f) =>
        JSON.parse(fs.readFileSync(path.join(backupDir, f), "utf-8")).settings
          .rotationMarker,
      )
      .sort();
    expect(survivingMarkers).toEqual([
      "backup-number-3",
      "backup-number-4",
      "backup-number-5",
      "backup-number-6",
      "backup-number-7",
    ]);
  });

  it("partial/interrupted write: a backup truncated mid-write is detected as unreadable, never restored as valid", async () => {
    const { getDb, createDatabaseBackup, setSetting } = await import(
      "../database/init.js"
    );
    await getDb();

    await setSetting("truncationMarker", "good-backup-before-truncation");
    const goodResult = await createDatabaseBackup();
    const goodPath = path.join(backupDir, goodResult.file);
    const goodContent = fs.readFileSync(goodPath, "utf-8");

    // Simulate a crash mid fs.copyFileSync/mid-write: truncate at several
    // different byte offsets, including ones that land inside a completed
    // top-level field -- not just an arbitrary hand-typed invalid string,
    // an actual strict prefix of real backup bytes.
    const offsets = [
      1, // barely started
      Math.floor(goodContent.length / 3),
      Math.floor(goodContent.length / 2),
      goodContent.length - 5, // nearly complete
    ];

    for (const offset of offsets) {
      const truncated = goodContent.slice(0, offset);
      let parsedOk = true;
      try {
        JSON.parse(truncated);
      } catch {
        parsedOk = false;
      }
      // The real safety property: a truncated write must never happen to be
      // valid-but-wrong JSON. If this ever fails, a truncation at that exact
      // offset would be silently accepted as a real, complete backup.
      expect(parsedOk).toBe(false);
    }

    // And the actual recovery path: overwrite the live db.json with one
    // truncated candidate, with the still-good backup sitting right next to
    // it in the ring -- confirms getDb() falls through past the truncated
    // one rather than treating it as valid or giving up.
    const truncatedBackupPath = path.join(
      backupDir,
      "db-9999-99-99T99-99-99-999Z-manual.json",
    );
    fs.writeFileSync(
      truncatedBackupPath,
      goodContent.slice(0, Math.floor(goodContent.length / 2)),
    );
    fs.writeFileSync(dbPath, "{ also corrupt, forcing ring recovery");

    vi.resetModules();
    const freshMod = await import("../database/init.js");
    const recovered = await freshMod.getDb();
    expect(recovered.data.settings.truncationMarker).toBe(
      "good-backup-before-truncation",
    );
  });
});
