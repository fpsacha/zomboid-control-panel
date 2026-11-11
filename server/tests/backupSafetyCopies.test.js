import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ZipArchive } from "archiver";

// The backup taken right before a restore or a wipe is the operator's only
// copy of the world that is about to be replaced. It used to be named like any
// other backup, so with backupMaxCount=1 (or just enough routine backups) the
// next scheduled backup pruned it. They are now named pre-restore-<server>_...
// / pre-wipe-<server>_..., exempt from the maxBackups prune and kept to the
// newest three; everything that reads backup names keeps working.

const getActiveServer = vi.fn(async () => null);
const addBackupRecord = vi.fn(async () => {});

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  flushWrites: vi.fn(async () => {}),
}));

vi.mock("../services/backupRecords.js", () => ({
  addBackupRecord,
  removeBackupRecord: vi.fn(async () => {}),
  listBackupRecords: vi.fn(async () => []),
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { BackupService } = await import("../services/backupService.js");
const { attributeBackupFilename, isSafetyBackupName, safetyBackupPrefix, backupSortKey } =
  await import("../services/backupNames.js");

const SERVER_NAME = "servertest";
const stamp = (n) => `2020-01-0${n}T00-00-00-000`;

let root;
let savesPath;
let backupsPath;

function createService({ maxBackups = 1 } = {}) {
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

function touch(name) {
  fs.writeFileSync(path.join(backupsPath, name), "x");
}

function backupNames() {
  return fs.readdirSync(backupsPath).sort();
}

async function writeValidBackup(zipPath, marker) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 0 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.append(marker, { name: `${SERVER_NAME}/map_meta.bin` });
    archive.finalize();
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-safety-copies-"));
  savesPath = path.join(root, "Saves", "Multiplayer", SERVER_NAME);
  backupsPath = path.join(root, "backups");
  fs.mkdirSync(savesPath, { recursive: true });
  fs.mkdirSync(backupsPath, { recursive: true });
  fs.writeFileSync(path.join(savesPath, "map_meta.bin"), "LIVE");
  getActiveServer.mockReset();
  getActiveServer.mockResolvedValue({ id: 1, serverName: SERVER_NAME });
  addBackupRecord.mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("safety copy names", () => {
  it("prefixes only the pre-restore and pre-wipe backups", async () => {
    const service = createService({ maxBackups: 10 });

    const routine = await service.createBackup({});
    const preRestore = await service.createBackup({ isPreRestore: true });
    const preWipe = await service.createBackup({ isPreWipe: true });

    expect(routine.backup.name).toMatch(new RegExp(`^${SERVER_NAME}_\\d{4}-`));
    expect(preRestore.backup.name).toMatch(new RegExp(`^pre-restore-${SERVER_NAME}_\\d{4}-.*\\.zip$`));
    expect(preWipe.backup.name).toMatch(new RegExp(`^pre-wipe-${SERVER_NAME}_\\d{4}-.*\\.zip$`));
    expect(safetyBackupPrefix({})).toBe("");
  });

  it("is told apart from an ordinary backup by name alone", () => {
    expect(isSafetyBackupName(`pre-wipe-${SERVER_NAME}_${stamp(1)}.zip`)).toBe(true);
    expect(isSafetyBackupName(`pre-restore-${SERVER_NAME}_${stamp(1)}-2.zip`)).toBe(true);
    expect(isSafetyBackupName(`${SERVER_NAME}_${stamp(1)}.zip`)).toBe(false);
    expect(isSafetyBackupName("uploaded-pre-wipe-x.zip")).toBe(false);
    expect(isSafetyBackupName("pre-wipe-notes.zip")).toBe(false);
  });

  it("leaves a server named like a safety prefix its ordinary retention", () => {
    const ordinary = `pre-wipe-x_${stamp(1)}.zip`;
    expect(isSafetyBackupName(ordinary)).toBe(true);
    expect(isSafetyBackupName(ordinary, "pre-wipe-x")).toBe(false);
    // ...while that server's own pre-wipe copy still is one.
    expect(isSafetyBackupName(`pre-wipe-pre-wipe-x_${stamp(1)}.zip`, "pre-wipe-x")).toBe(true);
  });
});

describe("retention leaves the safety copies alone", () => {
  it("does not let a routine backup with backupMaxCount=1 prune the pre-wipe copy", async () => {
    touch(`pre-wipe-${SERVER_NAME}_${stamp(1)}.zip`);
    touch(`pre-restore-${SERVER_NAME}_${stamp(2)}.zip`);
    touch(`${SERVER_NAME}_${stamp(3)}.zip`);
    touch(`${SERVER_NAME}_${stamp(4)}.zip`);

    const result = await createService({ maxBackups: 1 }).createBackup({});

    expect(result.success).toBe(true);
    // Only the newest ordinary backup stays; both safety copies do.
    expect(backupNames()).toEqual(
      [
        `pre-restore-${SERVER_NAME}_${stamp(2)}.zip`,
        `pre-wipe-${SERVER_NAME}_${stamp(1)}.zip`,
        result.backup.name,
      ].sort(),
    );
  });

  it("keeps the newest three safety copies and prunes the older ones", async () => {
    touch(`pre-wipe-${SERVER_NAME}_${stamp(1)}.zip`);
    touch(`pre-restore-${SERVER_NAME}_${stamp(2)}.zip`);
    touch(`pre-wipe-${SERVER_NAME}_${stamp(3)}.zip`);
    touch(`pre-restore-${SERVER_NAME}_${stamp(4)}.zip`);
    touch(`pre-wipe-${SERVER_NAME}_${stamp(5)}.zip`);

    const result = await createService({ maxBackups: 10 }).createBackup({});

    expect(result.success).toBe(true);
    expect(backupNames()).toEqual(
      [
        `pre-wipe-${SERVER_NAME}_${stamp(3)}.zip`,
        `pre-restore-${SERVER_NAME}_${stamp(4)}.zip`,
        `pre-wipe-${SERVER_NAME}_${stamp(5)}.zip`,
        result.backup.name,
      ].sort(),
    );
  });

  it("does not prune anything on a pre-restore or pre-wipe backup itself", async () => {
    for (let n = 1; n <= 5; n++) touch(`${SERVER_NAME}_${stamp(n)}.zip`);

    const result = await createService({ maxBackups: 1 }).createBackup({ isPreWipe: true });

    expect(result.success).toBe(true);
    expect(backupNames()).toHaveLength(6);
  });

  it("still prunes old-style safety copies (ordinary names) like any backup, and still spares uploads", async () => {
    touch(`${SERVER_NAME}_${stamp(1)}.zip`);
    touch(`${SERVER_NAME}_${stamp(2)}.zip`);
    touch("uploaded-keep.zip");

    const result = await createService({ maxBackups: 1 }).createBackup({});

    expect(result.success).toBe(true);
    expect(backupNames()).toEqual(["uploaded-keep.zip", result.backup.name].sort());
  });

  it("keeps a server named like a safety prefix on its ordinary retention", async () => {
    getActiveServer.mockResolvedValue({ id: 1, serverName: "pre-wipe-x" });
    touch(`pre-wipe-x_${stamp(1)}.zip`);
    touch(`pre-wipe-x_${stamp(2)}.zip`);

    const result = await createService({ maxBackups: 1 }).createBackup({});

    expect(result.success).toBe(true);
    expect(backupNames()).toEqual([result.backup.name]);
  });
});

describe("everything else that reads backup names still recognises them", () => {
  it("lists them newest first by their timestamp, whatever the prefix", async () => {
    touch(`${SERVER_NAME}_${stamp(1)}.zip`);
    touch(`pre-wipe-${SERVER_NAME}_${stamp(3)}.zip`);
    touch(`${SERVER_NAME}_${stamp(2)}.zip`);
    touch(`pre-restore-${SERVER_NAME}_${stamp(4)}.zip`);

    const listed = (await createService().listBackups()).map((b) => b.name);

    expect(listed).toEqual([
      `pre-restore-${SERVER_NAME}_${stamp(4)}.zip`,
      `pre-wipe-${SERVER_NAME}_${stamp(3)}.zip`,
      `${SERVER_NAME}_${stamp(2)}.zip`,
      `${SERVER_NAME}_${stamp(1)}.zip`,
    ]);
    expect(backupSortKey(`pre-wipe-${SERVER_NAME}_${stamp(3)}-2.zip`, null)).toEqual({
      key: stamp(3),
      suffix: 2,
    });
  });

  it("attributes them to their server, the longest matching name winning", () => {
    const file = `pre-wipe-my_server_${stamp(1)}.zip`;
    expect(attributeBackupFilename(file, ["my", "my_server"])).toBe("my_server");
    expect(attributeBackupFilename(`pre-restore-my_${stamp(1)}-3.zip`, ["my", "my_server"])).toBe("my");
    expect(attributeBackupFilename(`pre-wipe-other_${stamp(1)}.zip`, ["my"])).toBeNull();
  });

  it("refuses to restore or delete another server's safety copy in a shared folder", async () => {
    const service = createService();
    getActiveServer.mockResolvedValue({ id: 1, serverName: SERVER_NAME });
    const { getServers } = await import("../database/init.js");
    getServers.mockResolvedValue([
      { id: 1, serverName: SERVER_NAME, zomboidDataPath: root },
      { id: 2, serverName: "other", zomboidDataPath: root },
    ]);
    service._resolveServerDataBasePath = async (server) => server?.zomboidDataPath ?? root;
    touch(`pre-wipe-other_${stamp(1)}.zip`);
    touch(`pre-wipe-${SERVER_NAME}_${stamp(2)}.zip`);

    expect(await service._findForeignBackupOwner(`pre-wipe-other_${stamp(1)}.zip`, backupsPath)).toBe("other");
    expect(await service._findForeignBackupOwner(`pre-wipe-${SERVER_NAME}_${stamp(2)}.zip`, backupsPath)).toBeNull();
    expect((await service.listBackups()).map((b) => b.name)).toEqual([
      `pre-wipe-${SERVER_NAME}_${stamp(2)}.zip`,
    ]);
    expect((await service.deleteBackup(`pre-wipe-other_${stamp(1)}.zip`)).success).toBe(false);
    expect(fs.existsSync(path.join(backupsPath, `pre-wipe-other_${stamp(1)}.zip`))).toBe(true);
    getServers.mockResolvedValue([]);
  });

  it("restores a safety copy and deletes it by its name", async () => {
    const name = `pre-wipe-${SERVER_NAME}_${stamp(1)}.zip`;
    await writeValidBackup(path.join(backupsPath, name), "FROM SAFETY COPY");
    const service = createService();

    const restored = await service.restoreBackup(name, { createPreRestoreBackup: false });

    expect(restored.success).toBe(true);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe("FROM SAFETY COPY");
    expect((await service.deleteBackup(name)).success).toBe(true);
    expect(fs.existsSync(path.join(backupsPath, name))).toBe(false);
  });

  it("names a restore's own safety backup pre-restore- and leaves it in the list", async () => {
    await writeValidBackup(path.join(backupsPath, `${SERVER_NAME}_${stamp(1)}.zip`), "OLD");
    const service = createService({ maxBackups: 1 });

    const restored = await service.restoreBackup(`${SERVER_NAME}_${stamp(1)}.zip`, {
      createPreRestoreBackup: true,
    });

    expect(restored.success).toBe(true);
    const names = (await service.listBackups()).map((b) => b.name);
    expect(names.filter((n) => n.startsWith(`pre-restore-${SERVER_NAME}_`))).toHaveLength(1);
    expect(names).toContain(`${SERVER_NAME}_${stamp(1)}.zip`);
  });
});

describe("POST /backup/create", () => {
  it("does not let a request body choose the service-only safety flags (or the panel database: see backupIncludeDbRedaction.test.js)", async () => {
    vi.resetModules();
    vi.doMock("../database/init.js", () => ({ getActiveServer: vi.fn(async () => ({ isRemote: false })) }));
    const { default: router } = await import("../routes/backup.js");
    const layer = router.stack.find(
      (entry) => entry.route?.path === "/create" && entry.route.methods.post,
    );
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const createBackup = vi.fn(async () => ({ success: true, backup: { name: "x.zip" }, skippedFiles: [] }));
    const response = { status: vi.fn(), json: vi.fn() };
    response.status.mockReturnValue(response);

    await handler(
      {
        body: { includeDb: true, isPreRestore: true, isPreWipe: true },
        app: { get: (key) => (key === "backupService" ? { createBackup } : undefined) },
      },
      response,
    );

    expect(createBackup).toHaveBeenCalledTimes(1);
    const options = createBackup.mock.calls[0][0];
    expect(options.includeDb).toBeUndefined();
    expect(options.isPreRestore).toBeUndefined();
    expect(options.isPreWipe).toBeUndefined();
  });
});
