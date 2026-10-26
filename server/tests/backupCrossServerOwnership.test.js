import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// continuous-bug-hunt round 18 (backups and server ownership): a server's
// backups/ folder is just `<zomboidDataPath>/backups` -- no serverName
// segment in the PATH itself, only encoded in each backup FILE's own name.
// getBackupsPath() falls back to the app-wide legacy zomboidDataPath
// setting (or PZ_SAVE_PATH, via routes/servers.js's own default) whenever a
// server profile doesn't have its own zomboidDataPath configured -- an
// ordinary state for a newly added second server profile. When that
// happens, two server profiles can resolve to the EXACT SAME backups/
// directory, and before this fix nothing anywhere checked which file
// belonged to which server: listBackups() showed every .zip in the shared
// folder regardless of owner, cleanupOldBackups() could prune (delete)
// another server's real archive while counting toward its own
// maxBackups, and restoreBackup()/deleteBackup() would act on a
// client-supplied filename with no ownership check at all.

const getActiveServerMock = vi.fn();
const getServersMock = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer: (...args) => getActiveServerMock(...args),
  getServers: (...args) => getServersMock(...args),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getLatestScheduleExecutionByCommand: vi.fn(async () => null),
  flushWrites: vi.fn(async () => {}),
}));

vi.mock("../services/backupRecords.js", () => ({
  addBackupRecord: vi.fn(async () => {}),
  removeBackupRecord: vi.fn(async () => {}),
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { BackupService } = await import("../services/backupService.js");

let root;
let sharedDataPath;
let serverA;
let serverB;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-cross-server-"));
  sharedDataPath = path.join(root, "shared");
  fs.mkdirSync(sharedDataPath, { recursive: true });

  // Both server profiles point at the SAME zomboidDataPath -- exactly the
  // "server didn't get its own data path configured yet" state that makes
  // their backups/ directory collide.
  serverA = { id: "a", serverName: "ServerA", zomboidDataPath: sharedDataPath };
  serverB = { id: "b", serverName: "ServerB", zomboidDataPath: sharedDataPath };

  getActiveServerMock.mockReset();
  getServersMock.mockReset().mockResolvedValue([serverA, serverB]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Filename shape must match BACKUP_TIMESTAMP_PATTERN exactly (3-digit
// milliseconds, no trailing "Z") -- backupService.js's own ownership
// attribution now anchors the WHOLE filename against it (round 18b), so a
// fixture using a shape the real service would never write does not
// exercise the fix under test at all.
function writeBackupFile(serverName, millis, dataPath = sharedDataPath) {
  const backupsDir = path.join(dataPath, "backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  const ms = String(millis).padStart(3, "0");
  const filePath = path.join(backupsDir, `${serverName}_2026-09-18T00-00-00-${ms}.zip`);
  fs.writeFileSync(filePath, "zip-bytes");
  return filePath;
}

describe("backupService.js: cross-server ownership in a shared backups folder", () => {
  it("listBackups() excludes another currently-existing server's own backups", async () => {
    writeBackupFile("ServerA", 1);
    writeBackupFile("ServerB", 2);
    getActiveServerMock.mockResolvedValue(serverA);

    const service = new BackupService();
    const backups = await service.listBackups();

    expect(backups.map((b) => b.name)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^ServerA_/)]),
    );
    expect(backups.some((b) => b.name.startsWith("ServerB_"))).toBe(false);
  });

  it("does not filter anything when every server has its own distinct backups directory (no regression for the normal, correctly-configured case)", async () => {
    const ownDataPath = path.join(root, "own");
    fs.mkdirSync(ownDataPath, { recursive: true });
    const distinctServerA = { id: "a", serverName: "ServerA", zomboidDataPath: ownDataPath };
    getServersMock.mockResolvedValue([distinctServerA, serverB]);
    getActiveServerMock.mockResolvedValue(distinctServerA);

    const backupsDir = path.join(ownDataPath, "backups");
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.writeFileSync(path.join(backupsDir, "ServerA_2026-09-18T00-00-00-001.zip"), "zip-bytes");

    const service = new BackupService();
    const backups = await service.listBackups();

    expect(backups.map((b) => b.name)).toEqual(["ServerA_2026-09-18T00-00-00-001.zip"]);
  });

  it("cleanupOldBackups() never deletes another server's backup even while pruning by count", async () => {
    writeBackupFile("ServerA", 1);
    writeBackupFile("ServerA", 2);
    writeBackupFile("ServerB", 3); // would be the "oldest" by readdir order in a naive prune
    getActiveServerMock.mockResolvedValue(serverA);

    const service = new BackupService();
    // Force maxBackups down to 1 so pruning has something to do.
    vi.spyOn(service, "getSettings").mockResolvedValue({
      enabled: true,
      schedule: "0 */6 * * *",
      maxBackups: 1,
      includeDb: false,
    });

    await service.cleanupOldBackups(serverA);

    const remaining = fs.readdirSync(path.join(sharedDataPath, "backups"));
    // ServerB's backup must survive no matter how aggressively ServerA prunes.
    expect(remaining).toContain("ServerB_2026-09-18T00-00-00-003.zip");
  });

  it("restoreBackup() refuses to restore a backup that belongs to another currently-colliding server", async () => {
    const foreignPath = writeBackupFile("ServerB", 1);
    // restoreBackup() resolves savesPath before reaching the ownership
    // check -- give ServerA a real saves folder so that step succeeds and
    // the ownership refusal is what's actually under test here.
    fs.mkdirSync(path.join(sharedDataPath, "Saves", "Multiplayer", "ServerA"), {
      recursive: true,
    });
    getActiveServerMock.mockResolvedValue(serverA);

    const service = new BackupService();
    const result = await service.restoreBackup("ServerB_2026-09-18T00-00-00-001.zip", {
      force: true,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/belongs to another server profile.*ServerB/i);
    // The file itself must be untouched -- refused before any extraction.
    expect(fs.existsSync(foreignPath)).toBe(true);
  });

  it("deleteBackup() refuses to delete a backup that belongs to another currently-colliding server", async () => {
    const foreignPath = writeBackupFile("ServerB", 1);
    getActiveServerMock.mockResolvedValue(serverA);

    const service = new BackupService();
    const result = await service.deleteBackup("ServerB_2026-09-18T00-00-00-001.zip");

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/belongs to another server profile.*ServerB/i);
    expect(fs.existsSync(foreignPath)).toBe(true);
  });

  it("deleteBackup() still deletes the server's own backup normally (no false refusal)", async () => {
    const ownPath = writeBackupFile("ServerA", 1);
    getActiveServerMock.mockResolvedValue(serverA);

    const service = new BackupService();
    const result = await service.deleteBackup("ServerA_2026-09-18T00-00-00-001.zip");

    expect(result.success).toBe(true);
    expect(fs.existsSync(ownPath)).toBe(false);
  });

  // round 18b (god-caught follow-up): SERVER_NAME_REGEX allows underscores,
  // so a plain startsWith(`${name}_`) substring check misattributes files
  // between two servers where one name is a literal prefix of the other
  // (e.g. "my" and "my_server") -- the exact class of bug already fixed
  // for nested SandboxVars keys twice this same hunt (rounds 3, 16).
  describe("prefix-of-another-name collisions ('my' vs 'my_server')", () => {
    let myServer;
    let myServerServer;

    beforeEach(() => {
      myServer = { id: "short", serverName: "my", zomboidDataPath: sharedDataPath };
      myServerServer = {
        id: "long",
        serverName: "my_server",
        zomboidDataPath: sharedDataPath,
      };
      getServersMock.mockResolvedValue([myServer, myServerServer]);
    });

    it("listBackups() for 'my_server' does not hide its OWN file just because it starts with 'my_'", async () => {
      const ownFile = writeBackupFile("my_server", 1);
      getActiveServerMock.mockResolvedValue(myServerServer);

      const service = new BackupService();
      const backups = await service.listBackups();

      expect(backups.map((b) => b.name)).toEqual([path.basename(ownFile)]);
    });

    it("listBackups() for 'my' does not show 'my_server's own backup (correctly attributed to the longer name)", async () => {
      writeBackupFile("my_server", 1);
      getActiveServerMock.mockResolvedValue(myServer);

      const service = new BackupService();
      const backups = await service.listBackups();

      expect(backups).toEqual([]);
    });

    it("deleteBackup() for 'my_server' deletes its OWN file without being refused as foreign", async () => {
      const ownFile = writeBackupFile("my_server", 1);
      getActiveServerMock.mockResolvedValue(myServerServer);

      const service = new BackupService();
      const result = await service.deleteBackup(path.basename(ownFile));

      expect(result.success).toBe(true);
      expect(fs.existsSync(ownFile)).toBe(false);
    });

    it("deleteBackup() for 'my' refuses 'my_server's file as foreign (longest name still wins the other direction)", async () => {
      const foreignFile = writeBackupFile("my_server", 1);
      getActiveServerMock.mockResolvedValue(myServer);

      const service = new BackupService();
      const result = await service.deleteBackup(path.basename(foreignFile));

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/belongs to another server profile.*my_server/i);
      expect(fs.existsSync(foreignFile)).toBe(true);
    });
  });

  // A server name containing a regex metacharacter allowed by
  // SERVER_NAME_REGEX (letters, digits, underscore, hyphen, space -- "-" is
  // the one that's also regex-special) must not corrupt the anchored
  // ownership pattern (escapeRegExp() is what protects this).
  it("attributes filenames correctly for a server name containing a regex metacharacter ('-')", async () => {
    const hyphenServer = { id: "h", serverName: "my-server", zomboidDataPath: sharedDataPath };
    const otherServer = { id: "o", serverName: "other", zomboidDataPath: sharedDataPath };
    getServersMock.mockResolvedValue([hyphenServer, otherServer]);
    getActiveServerMock.mockResolvedValue(hyphenServer);

    const ownFile = writeBackupFile("my-server", 1);
    writeBackupFile("other", 2);

    const service = new BackupService();
    const backups = await service.listBackups();

    expect(backups.map((b) => b.name)).toEqual([path.basename(ownFile)]);
  });
});

// v1.6.0 backs up every chosen server on the schedule, each through
// createBackup({ server }), whose retention runs cleanupOldBackups(server).
// That listed the chosen server's backups but deleted each through
// deleteBackup(name), which looks in the ACTIVE server's folder: "Backup not
// found" for a server with its own data folder, a "belongs to another server
// profile" refusal for one sharing the active server's -- either way the
// chosen server's backups were never pruned and grew until the disk filled.
describe("retention of a scheduled backup of a server other than the active one", () => {
  function keepOne(service) {
    vi.spyOn(service, "getSettings").mockResolvedValue({
      enabled: true,
      schedule: "0 */6 * * *",
      maxBackups: 1,
      includeDb: false,
    });
  }

  it("prunes that server's own backups folder, not the active server's", async () => {
    const dataA = path.join(root, "a");
    const dataB = path.join(root, "b");
    const ownA = { id: "a", serverName: "ServerA", zomboidDataPath: dataA };
    const ownB = { id: "b", serverName: "ServerB", zomboidDataPath: dataB };
    getServersMock.mockResolvedValue([ownA, ownB]);
    getActiveServerMock.mockResolvedValue(ownA);
    writeBackupFile("ServerA", 1, dataA);
    writeBackupFile("ServerB", 2, dataB);
    writeBackupFile("ServerB", 3, dataB);

    const service = new BackupService();
    keepOne(service);
    await service.cleanupOldBackups(ownB);

    expect(fs.readdirSync(path.join(dataB, "backups"))).toEqual([
      "ServerB_2026-09-18T00-00-00-003.zip",
    ]);
    expect(fs.readdirSync(path.join(dataA, "backups"))).toEqual([
      "ServerA_2026-09-18T00-00-00-001.zip",
    ]);
  });

  it("prunes it in a backups folder shared with the active server, leaving the active server's alone", async () => {
    getActiveServerMock.mockResolvedValue(serverA);
    writeBackupFile("ServerA", 1);
    writeBackupFile("ServerB", 2);
    writeBackupFile("ServerB", 3);

    const service = new BackupService();
    keepOne(service);
    await service.cleanupOldBackups(serverB);

    expect(fs.readdirSync(path.join(sharedDataPath, "backups")).sort()).toEqual([
      "ServerA_2026-09-18T00-00-00-001.zip",
      "ServerB_2026-09-18T00-00-00-003.zip",
    ]);
  });
});
