import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { ZipArchive } from "archiver";

// Backups are written under <data folder>/backups, on the same volume as the
// live world, and retention only ran after a backup succeeded. A backup that
// did not fit failed part-way after minutes of archiving (filling the disk the
// running game saves to), and nothing checked a restore's extraction plus its
// safety backup either. They now compare the estimated size with the free
// space first and refuse with BACKUP_INSUFFICIENT_DISK_SPACE; a routine backup
// that has reached its count first deletes the oldest backup retention would
// delete anyway, but only when that frees enough; safety copies and uploads
// are never deleted for space; an unknown size or free space never blocks.

const disk = vi.hoisted(() => ({ root: null, capacity: null }));

// A fake volume: `capacity` bytes, of which everything under `root` is used.
vi.mock("../utils/diskSpace.js", async () => {
  const nodeFs = await import("fs");
  const nodePath = await import("path");
  function usedUnder(dir) {
    let total = 0;
    for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) total += usedUnder(full);
      else if (entry.isFile()) total += nodeFs.statSync(full).size;
    }
    return total;
  }
  return {
    getDiskFree: vi.fn(async () => {
      if (disk.capacity === null || !disk.root) return null;
      return { free: Math.max(disk.capacity - usedUnder(disk.root), 0), total: disk.capacity };
    }),
  };
});

const getActiveServer = vi.fn(async () => null);

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  flushWrites: vi.fn(async () => {}),
}));

vi.mock("../services/backupRecords.js", () => ({
  addBackupRecord: vi.fn(async () => {}),
  removeBackupRecord: vi.fn(async () => {}),
  listBackupRecords: vi.fn(async () => []),
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { BackupService } = await import("../services/backupService.js");

const SERVER_NAME = "servertest";
const KB = 1024;
const stamp = (n) => `2020-01-0${n}T00-00-00-000`;
const named = (n) => `${SERVER_NAME}_${stamp(n)}.zip`;

let root;
let savesPath;
let backupsPath;

function createService({ maxBackups = 10 } = {}) {
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

function fakeBackup(name, bytes) {
  fs.writeFileSync(path.join(backupsPath, name), Buffer.alloc(bytes, 1));
}

function usedBytes() {
  let total = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  walk(root);
  return total;
}

// Leave exactly `bytes` free on the fake volume.
function leaveFree(bytes) {
  disk.capacity = usedBytes() + bytes;
}

function backupNames() {
  return fs.readdirSync(backupsPath).sort();
}

function recordingIo() {
  const events = [];
  return {
    events,
    io: { to: () => ({ emit: (event, payload) => events.push({ event, payload }) }) },
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-freespace-"));
  savesPath = path.join(root, "Saves", "Multiplayer", SERVER_NAME);
  backupsPath = path.join(root, "backups");
  fs.mkdirSync(savesPath, { recursive: true });
  fs.mkdirSync(backupsPath, { recursive: true });
  // 400 KB of incompressible world.
  fs.writeFileSync(path.join(savesPath, "map_meta.bin"), crypto.randomBytes(200 * KB));
  fs.mkdirSync(path.join(savesPath, "map"));
  fs.writeFileSync(path.join(savesPath, "map", "0_0.bin"), crypto.randomBytes(200 * KB));
  disk.root = root;
  disk.capacity = null;
  getActiveServer.mockReset();
  getActiveServer.mockResolvedValue({ id: 1, serverName: SERVER_NAME });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("createBackup refuses a backup that clearly does not fit", () => {
  it("fails fast with BACKUP_INSUFFICIENT_DISK_SPACE and the sizes, writing nothing", async () => {
    fakeBackup(named(1), 10 * KB);
    leaveFree(50 * KB);
    const { io, events } = recordingIo();

    const result = await createService().createBackup({ io });

    expect(result.success).toBe(false);
    expect(result.code).toBe("BACKUP_INSUFFICIENT_DISK_SPACE");
    expect(result.params).toEqual({ needed: expect.stringMatching(/KB$/), free: "50.0 KB" });
    expect(result.message).toMatch(/not enough free disk space/i);
    expect(backupNames()).toEqual([named(1)]);
    const progress = events.filter((e) => e.event === "backup:progress").map((e) => e.payload);
    expect(progress[progress.length - 1].phase).toBe("error");
  });

  it("goes ahead when the free space is enough", async () => {
    leaveFree(5000 * KB);

    const result = await createService().createBackup({});

    expect(result.success).toBe(true);
  });

  it("goes ahead when the free space cannot be read", async () => {
    disk.capacity = null;

    const result = await createService().createBackup({});

    expect(result.success).toBe(true);
  });
});

describe("a routine backup that has reached its count makes room first, but only when that is enough", () => {
  it("deletes the oldest backup ahead of retention when that frees enough", async () => {
    fakeBackup(named(1), 300 * KB); // oldest, the one retention would delete
    fakeBackup(named(2), 10 * KB);
    leaveFree(100 * KB);

    const result = await createService({ maxBackups: 2 }).createBackup({});

    expect(result.success).toBe(true);
    expect(backupNames()).toEqual([named(2), result.backup.name].sort());
  });

  it("deletes nothing when even the oldest backup would not free enough", async () => {
    fakeBackup(named(1), 1 * KB);
    fakeBackup(named(2), 10 * KB);
    leaveFree(20 * KB);

    const result = await createService({ maxBackups: 2 }).createBackup({});

    expect(result.success).toBe(false);
    expect(result.code).toBe("BACKUP_INSUFFICIENT_DISK_SPACE");
    expect(backupNames()).toEqual([named(1), named(2)]);
  });

  it("deletes nothing while the count has not been reached", async () => {
    fakeBackup(named(1), 300 * KB);
    fakeBackup(named(2), 10 * KB);
    leaveFree(100 * KB);

    const result = await createService({ maxBackups: 10 }).createBackup({});

    expect(result.success).toBe(false);
    expect(result.code).toBe("BACKUP_INSUFFICIENT_DISK_SPACE");
    expect(backupNames()).toEqual([named(1), named(2)]);
  });

  it("never deletes a safety copy or an upload to make room", async () => {
    fakeBackup(`pre-wipe-${named(1)}`, 300 * KB);
    fakeBackup("uploaded-world.zip", 300 * KB);
    leaveFree(100 * KB);

    const result = await createService({ maxBackups: 1 }).createBackup({});

    expect(result.success).toBe(false);
    expect(result.code).toBe("BACKUP_INSUFFICIENT_DISK_SPACE");
    expect(backupNames()).toEqual([`pre-wipe-${named(1)}`, "uploaded-world.zip"].sort());
  });

  it("spares the safety copy but still removes the ordinary oldest when that is enough", async () => {
    fakeBackup(`pre-restore-${named(1)}`, 300 * KB);
    fakeBackup(named(2), 300 * KB);
    fakeBackup(named(3), 10 * KB);
    leaveFree(100 * KB);

    const result = await createService({ maxBackups: 1 }).createBackup({});

    expect(result.success).toBe(true);
    // (the routine retention that follows a successful backup removes the
    // older ordinary backup; only the safety copy and the new one stay)
    expect(backupNames()).toEqual([`pre-restore-${named(1)}`, result.backup.name].sort());
  });

  it("never deletes the only backup for its replacement, even with a count of 1: the backup is refused instead", async () => {
    // Deleting it would leave nothing if the new archive then failed.
    fakeBackup(named(1), 300 * KB);
    leaveFree(100 * KB);

    const result = await createService({ maxBackups: 1 }).createBackup({});

    expect(result.success).toBe(false);
    expect(result.code).toBe("BACKUP_INSUFFICIENT_DISK_SPACE");
    expect(backupNames()).toEqual([named(1)]);
  });

  it("with a count of 1 spares the newest backup even when the older ones alone would not free enough", async () => {
    // The next archive is estimated from the newest one (600 KB * 1.1 = 660 KB):
    // the 300 KB older backup plus 100 KB free is not enough, and the newest
    // backup is not taken to make up the rest.
    fakeBackup(named(1), 300 * KB);
    fakeBackup(named(2), 600 * KB);
    leaveFree(100 * KB);

    const result = await createService({ maxBackups: 1 }).createBackup({});

    expect(result.success).toBe(false);
    expect(result.code).toBe("BACKUP_INSUFFICIENT_DISK_SPACE");
    expect(backupNames()).toEqual([named(1), named(2)]);
  });

  it("does not delete any backup for a pre-restore or pre-wipe safety backup", async () => {
    fakeBackup(named(1), 300 * KB);
    leaveFree(100 * KB);

    const result = await createService({ maxBackups: 1 }).createBackup({ isPreWipe: true });

    expect(result.success).toBe(false);
    expect(result.code).toBe("BACKUP_INSUFFICIENT_DISK_SPACE");
    expect(backupNames()).toEqual([named(1)]);
  });
});

describe("restoreBackup checks the room its extraction and safety backup need", () => {
  async function writeArchive(name, entries) {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(path.join(backupsPath, name));
      const archive = new ZipArchive({ zlib: { level: 0 } });
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);
      for (const [entryName, bytes] of entries) {
        archive.append(Buffer.alloc(bytes, 7), { name: `${SERVER_NAME}/${entryName}` });
      }
      archive.finalize();
    });
  }

  it("refuses before touching anything when the staging copy will not fit", async () => {
    await writeArchive("old.zip", [
      ["map_meta.bin", 300 * KB],
      ["map/1_1.bin", 300 * KB],
    ]);
    leaveFree(200 * KB);

    const result = await createService().restoreBackup("old.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe("BACKUP_INSUFFICIENT_DISK_SPACE");
    expect(result.params).toEqual({ needed: expect.stringMatching(/KB$/), free: "200 KB" });
    expect(fs.readdirSync(path.join(root, "Saves", "Multiplayer"))).toEqual([SERVER_NAME]);
    expect(fs.statSync(path.join(savesPath, "map_meta.bin")).size).toBe(200 * KB);
  });

  it("counts the safety backup too: staging fits, staging plus the safety backup does not", async () => {
    await writeArchive("old.zip", [["map_meta.bin", 100 * KB]]);
    // 100 KB staging alone fits in 150 KB; ~200 KB (the safety backup of the
    // 400 KB world, estimated at half) on top of it does not.
    leaveFree(150 * KB);

    const withSafety = await createService().restoreBackup("old.zip", {
      createPreRestoreBackup: true,
    });
    const withoutSafety = await createService().restoreBackup("old.zip", {
      createPreRestoreBackup: false,
    });

    expect(withSafety.success).toBe(false);
    expect(withSafety.code).toBe("BACKUP_INSUFFICIENT_DISK_SPACE");
    expect(withoutSafety.success).toBe(true);
  });

  it("goes ahead when the free space cannot be read", async () => {
    await writeArchive("old.zip", [["map_meta.bin", 100 * KB]]);
    disk.capacity = null;

    const result = await createService().restoreBackup("old.zip", {
      createPreRestoreBackup: true,
    });

    expect(result.success).toBe(true);
  });
});
