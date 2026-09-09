import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// backup-failure-visibility card (god), Q3: `this.lastBackup` is written
// ONLY by createBackup() succeeding in THIS process (backupService.js
// ~687) and starts null at construction -- never hydrated from disk. Every
// panel restart/update forgets it even though listBackups() (a live
// fs.readdir+stat scan, can't go stale) shows real backups sitting right
// there. Concretely: an operator with 20 real backups sees "Last Backup:
// Never" on the Backups page right next to a correct non-zero backupCount,
// on the exact card that already told them the truth once, right after
// every restart. getStatus() now lazily hydrates this.lastBackup from
// listBackups()[0] (newest-first) the first time it's asked and nothing
// has set it yet -- this test proves that against a REAL, isolated backups
// directory (real fs, not a mock of listBackups), that zero backups still
// reads null (not a false "Never" vs "loading" collapse), and that a
// backup this process actually just made is never clobbered by the disk
// scan.
//
// Same real-filesystem harness as backupUploadPruneExemption.test.js
// (services/backupRecords.js and utils/logger.js mocked for the same
// documented reasons there -- winston logsDir leak, addBackupRecord not
// under test here).

const settings = new Map();

vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
  getSetting: async (key) => settings.get(key),
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  logServerEvent: async () => {},
}));

vi.mock("../services/backupRecords.js", () => ({
  addBackupRecord: async () => {},
  removeBackupRecord: async () => {},
  listBackupRecords: async () => [],
}));

const initDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-backup-lastbackup-seed-"));
let tmpDir = initDir;
vi.mock("../utils/paths.js", () => ({
  getDataPaths: () => ({ dataDir: tmpDir, logsDir: tmpDir }),
}));

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { BackupService } = await import("../services/backupService.js");

function writeBackup(backupsPath, name, ageMs = 0) {
  const filePath = path.join(backupsPath, name);
  fs.writeFileSync(filePath, "dummy");
  if (ageMs) {
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, past, past);
  }
}

describe("BackupService.getStatus() -- lastBackup self-heals from disk instead of staying a false 'Never'", () => {
  let service;
  let backupsPath;

  beforeEach(async () => {
    settings.clear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-backup-lastbackup-"));
    service = new BackupService();
    backupsPath = await service.getBackupsPath();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hydrates lastBackup from the newest real file on disk when this.lastBackup is still null (the restart case)", async () => {
    writeBackup(backupsPath, "world_backup_older.zip", 60_000);
    writeBackup(backupsPath, "world_backup_newer.zip", 0);

    expect(service.lastBackup).toBeNull(); // fresh instance, exactly the post-restart state

    const status = await service.getStatus();

    expect(status.lastBackup).not.toBeNull();
    expect(status.lastBackup.name).toBe("world_backup_newer.zip");
    // Exact shape a raw disk entry produces -- listBackups() strips its
    // internal sortKey before returning, so this also guards against a
    // stray internal field leaking into what the UI renders.
    expect(Object.keys(status.lastBackup).sort()).toEqual(["created", "name", "path", "size"]);
    expect(typeof status.lastBackup.created).toBe("string");

    // And it's cached on the instance now, not just the one returned object.
    expect(service.lastBackup).toEqual(status.lastBackup);
  });

  it("stays null with zero backups on disk -- the UI's 'Never' must mean a real empty state, not a hydration miss", async () => {
    const status = await service.getStatus();

    expect(status.lastBackup).toBeNull();
    expect(status.backupCount).toBe(0);
  });

  it("never overwrites a backup this process actually just made with an older file from disk", async () => {
    writeBackup(backupsPath, "world_backup_disk.zip", 0);
    const sessionBackup = {
      name: "world_backup_this_session.zip",
      path: path.join(backupsPath, "world_backup_this_session.zip"),
      size: 42,
      created: new Date().toISOString(),
    };
    service.lastBackup = sessionBackup; // simulates createBackup() having already run this session

    const status = await service.getStatus();

    expect(status.lastBackup).toEqual(sessionBackup);
  });
});
