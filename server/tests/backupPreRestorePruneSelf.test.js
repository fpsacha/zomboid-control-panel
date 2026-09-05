import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import archiver from "archiver";

// bug hunt 2026-09-05 (backup-restore-round-trip sweep, item #1): the
// mandatory pre-restore backup's completion runs cleanupOldBackups() --
// the SAME retention prune a routine scheduled backup runs -- with no
// awareness that one of the backups on disk right now is the very archive
// this restore is about to read from. When that archive happens to be
// among the oldest (exactly the case for a user restoring their OLDEST
// backup, which is a completely ordinary thing to do), the fresh
// pre-restore backup pushes the count over maxBackups and the prune
// deletes the archive being restored, out from under the restore that is
// still mid-flight.

const logServerEvent = vi.fn(async () => {});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent,
  flushWrites: vi.fn(async () => {}),
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { BackupService } = await import("../services/backupService.js");

const SERVER_NAME = "servertest";

let root;
let savesPath;
let backupsPath;

function writeWorld(dir, marker) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "map_meta.bin"), marker);
  fs.writeFileSync(path.join(dir, "worldstats.txt"), marker);
}

function createService(maxBackups) {
  const service = new BackupService();
  service.getSavesPath = async () => savesPath;
  service.getBackupsPath = async () => backupsPath;
  service.getSettings = async () => ({
    enabled: false,
    schedule: "0 */6 * * *",
    maxBackups,
    includeDb: false,
  });
  service.setServerManager({
    getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
  });
  return service;
}

async function writeValidBackup(zipPath, marker) {
  const stagingWorld = path.join(root, "source", marker);
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-selfprune-"));
  savesPath = path.join(root, "Saves", "Multiplayer", SERVER_NAME);
  backupsPath = path.join(root, "backups");
  fs.mkdirSync(backupsPath, { recursive: true });
  writeWorld(savesPath, "LIVE");
  logServerEvent.mockReset();
  logServerEvent.mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("restoreBackup does not let its own pre-restore backup prune the archive being restored", () => {
  it("restoring the single oldest backup with maxBackups=1 must not delete that backup before extraction reads it", async () => {
    const oldPath = path.join(backupsPath, "old.zip");
    await writeValidBackup(oldPath, "OLD");
    // Real filesystem timestamp ordering matters for backupSortKey's
    // birthtime fallback -- make sure the pre-restore backup this test
    // triggers is unambiguously newer than "old.zip" (mtime/birthtime
    // resolution can be coarse on some filesystems).
    await new Promise((r) => setTimeout(r, 20));

    const service = createService(1);

    expect(fs.existsSync(oldPath)).toBe(true);

    const result = await service.restoreBackup("old.zip", {
      createPreRestoreBackup: true,
    });

    // The archive being restored must still exist after the operation --
    // whether or not the restore itself reports success, its own
    // housekeeping must never be the thing that deletes the source archive
    // out from under it.
    expect(fs.existsSync(oldPath)).toBe(true);
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe(
      "OLD",
    );
  });
});
