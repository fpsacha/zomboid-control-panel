import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import archiver from "archiver";

const logServerEvent = vi.fn(async () => {});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent,
}));

const { invalidateMapFolderScanMock } = vi.hoisted(() => ({
  invalidateMapFolderScanMock: vi.fn(),
}));
vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: invalidateMapFolderScanMock,
}));

const { BackupService } = await import("../services/backupService.js");
const { Open } = await import("unzipper");

const SERVER_NAME = "servertest";

let root;
let savesPath;
let backupsPath;

function writeWorld(dir, marker) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "map_meta.bin"), marker);
  fs.writeFileSync(path.join(dir, "worldstats.txt"), marker);
}

function createService() {
  const service = new BackupService();
  service.getSavesPath = async () => savesPath;
  service.getBackupsPath = async () => backupsPath;
  service.setServerManager({
    getServerProcessDetails: async () => ({
      running: false,
      scanFailed: false,
    }),
  });
  return service;
}

async function writeValidBackup(zipPath, marker) {
  const stagingWorld = path.join(root, "source", SERVER_NAME);
  writeWorld(stagingWorld, marker);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 0 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(stagingWorld, SERVER_NAME);
    archive.finalize();
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-restore-"));
  savesPath = path.join(root, "Saves", "Multiplayer", SERVER_NAME);
  backupsPath = path.join(root, "backups");
  fs.mkdirSync(backupsPath, { recursive: true });
  writeWorld(savesPath, "LIVE");
  invalidateMapFolderScanMock.mockClear();
  logServerEvent.mockReset();
  logServerEvent.mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("restoreBackup archive safety", () => {
  it("refuses to restore when process detection cannot confirm the server is stopped", async () => {
    const service = createService();
    service.setServerManager({
      getServerProcessDetails: async () => ({
        running: false,
        scanFailed: true,
      }),
    });

    const result = await service.restoreBackup("good.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/process detection failed/i);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe(
      "LIVE",
    );
  });

  // Regression: a serverManager lacking getServerProcessDetails() (an older
  // or lighter injected manager -- see the comment above the check in
  // backupService.js) used to fall back to checkServerRunning(), which
  // collapses a failed scan into a plain `false` indistinguishable from a
  // confirmed-stopped server. It must refuse the same way scanFailed does,
  // not silently restore.
  it("refuses to restore when the injected serverManager has no process-detection method at all", async () => {
    const service = createService();
    service.setServerManager({});

    const result = await service.restoreBackup("good.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/process detection is unavailable/i);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe(
      "LIVE",
    );
  });

  // Regression: restoreBackup()'s own running-check used to be gated by
  // `if (this.serverManager && ...)` -- no serverManager wired meant the
  // ENTIRE check was skipped and the restore proceeded as if the server had
  // already been confirmed stopped, rather than refusing. Not exploitable
  // via the one production caller today (server/index.js wires the
  // serverManager at boot, before routes/backup.js is reachable, and that
  // route also runs its own independent running-check first) -- but this
  // method must not depend on that call-graph coincidence to be safe.
  it("refuses to restore when no server manager has been wired at all", async () => {
    const service = new BackupService();
    service.getSavesPath = async () => savesPath;
    service.getBackupsPath = async () => backupsPath;
    // Deliberately never call setServerManager().

    const result = await service.restoreBackup("good.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no server manager is available/i);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe(
      "LIVE",
    );
  });

  it("keeps the live save when the archive is corrupt", async () => {
    const corrupt = path.join(backupsPath, "corrupt.zip");
    // Valid zip signature, truncated body: fails partway through extraction.
    fs.writeFileSync(corrupt, Buffer.from("PK\u0003\u0004 truncated payload"));

    const result = await createService().restoreBackup("corrupt.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(savesPath, "map_meta.bin"))).toBe(true);
    expect(
      fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8"),
    ).toBe("LIVE");
  });

  it("keeps the live save when the archive holds no world folder", async () => {
    const emptyZip = path.join(backupsPath, "empty.zip");
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(emptyZip);
      const archive = archiver("zip", { zlib: { level: 0 } });
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);
      archive.append("nothing to see", { name: "readme.txt" });
      archive.finalize();
    });

    const result = await createService().restoreBackup("empty.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(false);
    expect(
      fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8"),
    ).toBe("LIVE");
  });

  it("replaces the live save from a valid archive", async () => {
    const good = path.join(backupsPath, "good.zip");
    await writeValidBackup(good, "RESTORED");

    const result = await createService().restoreBackup("good.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(true);
    expect(
      fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8"),
    ).toBe("RESTORED");
  });

  // 2026-08-26 bug hunt: createBackup can return success:true while having
  // silently skipped files that vanished mid-archive (a real race on a live
  // PZ directory) -- it surfaces that via skippedFiles rather than deciding
  // policy itself. The pre-restore backup is about to become the world's
  // ONLY copy while restore overwrites the live save, so this must refuse
  // exactly like an outright backup failure -- "mostly complete" is not a
  // safety net here.
  it("refuses to restore when the mandatory pre-restore backup completed but silently skipped a file", async () => {
    const good = path.join(backupsPath, "good.zip");
    await writeValidBackup(good, "RESTORED");

    const service = createService();
    service.createBackup = async () => ({
      success: true,
      backup: { name: "pre-restore.zip" },
      skippedFiles: ["servertest/map_meta.bin"],
    });

    const result = await service.restoreBackup("good.zip", {
      createPreRestoreBackup: true,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/pre-restore backup failed/i);
    expect(result.message).toContain("map_meta.bin");
    // Nothing about the live save should have moved -- restore must never
    // reach extraction when the safety net it depends on isn't real.
    expect(
      fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8"),
    ).toBe("LIVE");
  });

  it("still restores normally when the pre-restore backup completes with zero skips", async () => {
    const good = path.join(backupsPath, "good.zip");
    await writeValidBackup(good, "RESTORED");

    const service = createService();
    service.createBackup = async () => ({
      success: true,
      backup: { name: "pre-restore.zip" },
      skippedFiles: [],
    });

    const result = await service.restoreBackup("good.zip", {
      createPreRestoreBackup: true,
    });

    expect(result.success).toBe(true);
    expect(
      fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8"),
    ).toBe("RESTORED");
  });

  it("still reports a successful restore when the completion event cannot be logged", async () => {
    const good = path.join(backupsPath, "good.zip");
    await writeValidBackup(good, "RESTORED");
    logServerEvent.mockRejectedValueOnce(new Error("database unavailable"));

    const result = await createService().restoreBackup("good.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe(
      "RESTORED",
    );
  });

  it("keeps a failed restore structured when its failure event cannot be logged", async () => {
    const corrupt = path.join(backupsPath, "corrupt.zip");
    fs.writeFileSync(corrupt, Buffer.from("PK\u0003\u0004 truncated payload"));
    logServerEvent.mockRejectedValueOnce(new Error("database unavailable"));
    const service = createService();

    const result = await service.restoreBackup("corrupt.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/FILE_ENDED|end of central directory|unexpected end|corrupt|invalid/i);
    expect(service.restoreInProgress).toBe(false);
  });

  it("restores a world whose source archive has different nested folder names", async () => {
    const portable = path.join(backupsPath, "portable.zip");
    const nestedWorld = path.join(root, "source", "Saves", "Multiplayer", "DifferentName");
    writeWorld(nestedWorld, "PORTABLE");

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(portable);
      const archive = archiver("zip", { zlib: { level: 0 } });
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);
      archive.directory(path.join(root, "source", "Saves"), "Saves");
      archive.finalize();
    });

    const result = await createService().restoreBackup("portable.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe("PORTABLE");
  });

  it("invalidates chunks.js's cached map/ folder scan after a successful restore", async () => {
    // Regression: chunks.js's /chunks and /stats routes cache a scan of a
    // save's map/ folder for a few seconds (getMapFolderScan()'s TTL
    // backstop). A restore swaps the whole save in from the archive but has
    // no path to call into chunks.js's own explicit invalidation -- without
    // this, a page reload within the TTL window after a restore would show
    // chunk counts for the PRE-restore map/ contents.
    const good = path.join(backupsPath, "good.zip");
    await writeValidBackup(good, "RESTORED");

    const result = await createService().restoreBackup("good.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(true);
    expect(invalidateMapFolderScanMock).toHaveBeenCalledWith(
      path.join(savesPath, "map"),
    );
  });

  it("does not invalidate the map/ folder scan when the restore fails", async () => {
    const corrupt = path.join(backupsPath, "corrupt.zip");
    fs.writeFileSync(corrupt, Buffer.from("PK truncated payload"));

    const result = await createService().restoreBackup("corrupt.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(false);
    expect(invalidateMapFolderScanMock).not.toHaveBeenCalled();
  });

  it("leaves no staging folder behind", async () => {
    const good = path.join(backupsPath, "good.zip");
    await writeValidBackup(good, "RESTORED");

    await createService().restoreBackup("good.zip", {
      createPreRestoreBackup: false,
    });

    const leftovers = fs
      .readdirSync(path.dirname(savesPath))
      .filter((name) => name.startsWith(".restore-staging-"));

    expect(leftovers).toEqual([]);
  });

  // bug-hunt-2026-08-27, backup-restore hunt: restoreInProgress used to be
  // set only AFTER the async getServerProcessDetails() check resolved, not
  // before it. Two calls arriving close together (a double-click before the
  // UI disables the button, two admin sessions, a retried request) both read
  // restoreInProgress as false -- neither had reached the assignment yet --
  // both passed every guard, and both extracted + swapped the save directory
  // concurrently. The second rename to finish silently won; BOTH callers got
  // success:true with no error anywhere. Confirmed with a real race before
  // fixing it, not assumed: an artificial delay inside getServerProcessDetails
  // widened the window enough to prove it deterministically rather than
  // relying on real clock timing (same "control the clock" idea as tonight's
  // startup-script-collision fix, applied to a lock instead of a filename).
  it("a second restoreBackup() call arriving while the first is still checking the server-running state is refused, not run concurrently", async () => {
    const service = createService();
    // Widen the await window between the initial guard check and the flag
    // actually being set, so a genuine regression reproduces on demand
    // instead of depending on real scheduler timing.
    service.setServerManager({
      getServerProcessDetails: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { running: false, scanFailed: false };
      },
    });

    const backupA = path.join(backupsPath, "a.zip");
    const backupB = path.join(backupsPath, "b.zip");
    await writeValidBackup(backupA, "BACKUP_A");
    await writeValidBackup(backupB, "BACKUP_B");

    const [resultA, resultB] = await Promise.all([
      service.restoreBackup("a.zip", { createPreRestoreBackup: false }),
      service.restoreBackup("b.zip", { createPreRestoreBackup: false }),
    ]);

    const results = [resultA, resultB];
    const blocked = results.filter((r) => r.message === "Restore already in progress");
    const completed = results.filter((r) => r.success);

    // Exactly one call proceeds; the other is refused outright, not left to
    // race it to the finish line.
    expect(blocked.length).toBe(1);
    expect(completed.length).toBe(1);

    // The live save reflects exactly the one restore that was allowed to
    // run -- not a partial mix of both, and not silently overwritten by the
    // refused call (which must never have touched the filesystem at all).
    const finalMarker = fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8");
    expect(["BACKUP_A", "BACKUP_B"]).toContain(finalMarker);
    expect(finalMarker).toBe(completed[0].message.includes("a.zip") ? "BACKUP_A" : "BACKUP_B");
  });
});

describe("createBackup archive safety", () => {
  it("still resolves successfully when post-backup event logging fails", async () => {
    const service = createService();
    logServerEvent.mockRejectedValueOnce(new Error("database unavailable"));

    const result = await service.createBackup({});

    expect(result.success).toBe(true);
    expect(fs.existsSync(result.backup.path)).toBe(true);
    expect(service.backupInProgress).toBe(false);
  });

  // 2026-08-26 partial-failure-state/fatalExit hunt: cleanupOldBackups()
  // runs inside output.on("close", async () => {...}) -- an EventEmitter
  // listener whose returned promise nothing awaits or .catches. Before
  // this test existed, an uncaught throw here would have been an
  // unhandledRejection -> fatalExit() panel kill sitting directly
  // downstream of every successful backup, including the mandatory
  // pre-wipe and pre-restore ones. Same shape as the sibling test above
  // for logServerEvent, and it must resolve the same way: retention
  // housekeeping failing does not mean the backup failed.
  it("still resolves successfully when cleaning up old backups fails, instead of crashing the process", async () => {
    const service = createService();
    service.cleanupOldBackups = async () => {
      throw new Error("EACCES: permission denied");
    };

    const result = await service.createBackup({});

    expect(result.success).toBe(true);
    expect(fs.existsSync(result.backup.path)).toBe(true);
    expect(service.backupInProgress).toBe(false);
  });

  it("leaves no .tmp file behind after a successful backup, and lists a real .zip", async () => {
    const service = createService();

    const result = await service.createBackup({});

    expect(result.success).toBe(true);
    const files = fs.readdirSync(backupsPath);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(files.some((f) => f.endsWith(".zip"))).toBe(true);
  });

  it("removes orphaned backup temp files before starting", async () => {
    const service = createService();
    fs.writeFileSync(path.join(backupsPath, "old.zip.tmp"), "partial");
    fs.writeFileSync(path.join(backupsPath, ".central-old.tmp"), "partial");

    const result = await service.createBackup({});

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(backupsPath, "old.zip.tmp"))).toBe(false);
    expect(fs.existsSync(path.join(backupsPath, ".central-old.tmp"))).toBe(false);
  });

  it("uses a distinct name for sequential backups created in the same millisecond", async () => {
    const timestamp = "2026-08-25T12:00:00.000Z";
    const toISOString = vi
      .spyOn(Date.prototype, "toISOString")
      .mockReturnValue(timestamp);
    try {
      const service = createService();
      service.cleanupOldBackups = async () => {};
      const existing = path.join(
        backupsPath,
        "server_2026-08-25T12-00-00-000.zip",
      );
      fs.writeFileSync(existing, "existing backup");

      const result = await service.createBackup({});

      expect(result.success).toBe(true);
      expect(result.backup.name).toBe("server_2026-08-25T12-00-00-000-1.zip");
      expect(fs.existsSync(result.backup.path)).toBe(true);
      expect(fs.readFileSync(existing, "utf8")).toBe("existing backup");
    } finally {
      toISOString.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not follow symbolic links outside the save directory",
    async () => {
      const outsidePath = path.join(root, "outside-secret.txt");
      const linkPath = path.join(savesPath, "outside-secret.txt");
      fs.writeFileSync(outsidePath, "outside save data");
      fs.symlinkSync(outsidePath, linkPath);

      const result = await createService().createBackup({});
      const archive = await Open.file(result.backup.path);

      expect(result.success).toBe(true);
      expect(archive.files.map((entry) => entry.path)).not.toContain(
        `${SERVER_NAME}/outside-secret.txt`,
      );
    },
  );

  it("does not depend on readdir arrays while creating a backup", async () => {
    const service = createService();
    service.cleanupOldBackups = async () => {};
    const callbackReaddir = vi.spyOn(fs, "readdir").mockImplementation((...args) => {
      args.at(-1)(new Error("readdir must not be used for backup traversal"));
    });
    const promiseReaddir = vi
      .spyOn(fs.promises, "readdir")
      .mockRejectedValue(new Error("readdir must not be used for backup traversal"));

    try {
      const result = await service.createBackup({});
      expect(result.success).toBe(true);
      expect(fs.existsSync(result.backup.path)).toBe(true);
    } finally {
      callbackReaddir.mockRestore();
      promiseReaddir.mockRestore();
    }
  });

  it("includes every nested save entry in the archive", async () => {
    const nestedFiles = [
      "map/chunk.bin",
      "players/alpha/player.db",
      "vehicles/zone-1/vehicle.db",
    ];
    for (const relativePath of nestedFiles) {
      const filePath = path.join(savesPath, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, relativePath);
    }

    const result = await createService().createBackup({});
    const archive = await Open.file(result.backup.path);
    const entryNames = archive.files.map((entry) => entry.path);

    expect(result.success).toBe(true);
    expect(entryNames).toEqual(
      expect.arrayContaining([
        ...nestedFiles.map((relativePath) => `${SERVER_NAME}/${relativePath}`),
        "panel-server-snapshot.json",
      ]),
    );
  });

});

// 2026-08-27, operator directive relayed by god: "make sure backups works" --
// prove the whole create -> list -> restore lifecycle with actual content,
// not status codes. Every test above either restores a hand-built archive
// (writeValidBackup) or checks the archive's entry NAMES ("includes every
// nested save entry") -- none of them exercise the real createBackup() on a
// real multi-file, nested, binary-containing live save AND THEN compare the
// restored bytes back against the original. A restore that silently wrote
// the wrong file, truncated a binary entry, or mangled non-ASCII content
// could pass every existing assertion in this file and still hand an
// operator back the wrong world.
describe("full lifecycle: create -> list -> restore, byte-for-byte", () => {
  function listAllFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listAllFiles(full));
      else out.push(full);
    }
    return out.sort();
  }

  it("a real createBackup() -> listBackups() -> restoreBackup() round trip reproduces every file's exact bytes, not just its name", async () => {
    fs.rmSync(savesPath, { recursive: true, force: true });
    const nested = path.join(savesPath, "map", "chunks");
    fs.mkdirSync(nested, { recursive: true });

    // Every byte value 0-255 once, so any single-byte corruption (a
    // dropped high bit, a text-mode line-ending rewrite, an encoding
    // round-trip) is guaranteed to be caught, not just "looks textually
    // similar".
    const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const files = new Map([
      [path.join(savesPath, "map_meta.bin"), binary],
      [
        path.join(savesPath, "worldstats.txt"),
        Buffer.from("world stats content\r\nline two\nline three"),
      ],
      [path.join(nested, "0_0.bin"), Buffer.concat([binary, binary])],
      [
        path.join(nested, "1_1.bin"),
        Buffer.from("chunk marker with unicode: café ☃ 日本", "utf8"),
      ],
      [path.join(nested, "empty.bin"), Buffer.alloc(0)],
    ]);
    for (const [filePath, content] of files) {
      fs.writeFileSync(filePath, content);
    }
    const originalFileList = listAllFiles(savesPath);

    const service = createService();

    const createResult = await service.createBackup({
      createPreRestoreBackup: false,
    });
    expect(createResult.success).toBe(true);

    // What an operator actually sees and picks from -- not the raw create
    // result, the listing endpoint everything else in the UI is driven by.
    const listed = await service.listBackups();
    const listedEntry = listed.find((b) => b.name === createResult.backup.name);
    expect(listedEntry).toBeTruthy();

    // Simulate real data loss: wipe the live save so a restored file can
    // only be reconstructed from the archive, never coasting on a leftover
    // copy already sitting in savesPath.
    fs.rmSync(savesPath, { recursive: true, force: true });
    expect(fs.existsSync(savesPath)).toBe(false);

    const restoreResult = await service.restoreBackup(listedEntry.name, {
      createPreRestoreBackup: false,
    });
    expect(restoreResult.success).toBe(true);

    expect(listAllFiles(savesPath)).toEqual(originalFileList);
    for (const [filePath, originalContent] of files) {
      const restoredContent = fs.readFileSync(filePath);
      expect(Buffer.compare(restoredContent, originalContent)).toBe(0);
    }
  });
});

describe("deleteBackupsOlderThan result contract", () => {
  it.each([0, -1])("rejects a non-positive retention age (%s)", async (days) => {
    const service = createService();
    const listBackups = vi.spyOn(service, "listBackups");

    await expect(service.deleteBackupsOlderThan(days)).resolves.toEqual({
      success: false,
      message: "Invalid days parameter. Must be a whole number >= 1",
    });
    expect(listBackups).not.toHaveBeenCalled();
  });

  it("reports partial deletion failures as unsuccessful", async () => {
    const service = createService();
    service.listBackups = async () => [
      {
        name: "old-a.zip",
        created: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        name: "old-b.zip",
        created: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ];
    service.deleteBackup = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: "locked" });

    const result = await service.deleteBackupsOlderThan(1);

    expect(result).toEqual(
      expect.objectContaining({ success: false, deleted: 1, failed: 1 }),
    );
  });
});

describe("getBackupSnapshot", () => {
  it("reads the embedded panel server snapshot", async () => {
    const backupPath = path.join(backupsPath, "snapshot.zip");
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(backupPath);
      const archive = archiver("zip", { zlib: { level: 0 } });
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);
      archive.append(
        JSON.stringify({
          schemaVersion: 1,
          server: { name: SERVER_NAME },
          serverIni: { PVP: "false" },
        }),
        { name: "panel-server-snapshot.json" },
      );
      archive.finalize();
    });

    const result = await createService().getBackupSnapshot("snapshot.zip");

    expect(result).toEqual({
      success: true,
      snapshot: {
        schemaVersion: 1,
        server: { name: SERVER_NAME },
        serverIni: { PVP: "false" },
      },
    });
  });

  it("reports a legacy archive without a panel snapshot", async () => {
    await writeValidBackup(path.join(backupsPath, "legacy.zip"), "LEGACY");

    await expect(createService().getBackupSnapshot("legacy.zip")).resolves.toEqual({
      success: false,
      message: "This backup has no panel snapshot",
    });
  });
});
