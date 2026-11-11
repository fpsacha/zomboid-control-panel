import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ZipArchive } from "archiver";

// A restore whose extraction hits a write error (a full disk, an unwritable
// path) used to report the failure at once but leave the archive parser
// running: restoreBackup()'s finally removed the staging folder, then the
// parser carried on through the rest of the archive, re-creating
// .restore-staging-<uuid> and writing the remaining files into it (243 MB
// reappeared in one probe), with nothing to sweep it. The extraction now
// stops at the first error and only reports it once its write streams have
// closed; leftovers from a restore that never got to clean up are swept
// before the next restore and at boot.

const injected = vi.hoisted(() => ({ failName: null }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal();
  const base = actual.default;

  function createWriteStream(target, ...rest) {
    const stream = base.createWriteStream(target, ...rest);
    if (!injected.failName || path.basename(String(target)) !== injected.failName) {
      return stream;
    }
    stream._writev = null;
    stream._write = (_chunk, _encoding, callback) => {
      const error = new Error("ENOSPC: no space left on device, write");
      error.code = "ENOSPC";
      callback(error);
    };
    return stream;
  }

  const wrapped = { ...base, createWriteStream };
  return { ...actual, ...wrapped, default: wrapped };
});

const getServers = vi.fn(async () => []);

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServers,
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  flushWrites: vi.fn(async () => {}),
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { BackupService } = await import("../services/backupService.js");
const { sweepStaleRestoreStaging } = await import("../services/backupRestoreExtract.js");

const SERVER_NAME = "servertest";
const FILE_BYTES = 1024;

let root;
let multiplayerPath;
let savesPath;
let backupsPath;

function createService() {
  const service = new BackupService();
  service.getSavesPath = async () => savesPath;
  service.getBackupsPath = async () => backupsPath;
  service.setServerManager({
    getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
  });
  return service;
}

// Stored (level 0) so the archive is far larger than one 64 KB read chunk and
// the parser still has entries to read after the failing one.
async function writeArchive(zipPath, { before = 5, after = 400, failingEntry = null } = {}) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 0 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.append("RESTORED", { name: `${SERVER_NAME}/map_meta.bin` });
    for (let i = 0; i < before; i++) {
      archive.append(Buffer.alloc(FILE_BYTES, i), { name: `${SERVER_NAME}/map/a${i}.bin` });
    }
    if (failingEntry) {
      archive.append(Buffer.alloc(FILE_BYTES, 1), { name: `${SERVER_NAME}/map/${failingEntry}` });
    }
    for (let i = 0; i < after; i++) {
      archive.append(Buffer.alloc(FILE_BYTES, 7), { name: `${SERVER_NAME}/map/z${i}.bin` });
    }
    archive.finalize();
  });
}

function stagingFolders() {
  return fs.readdirSync(multiplayerPath).filter((name) => name.startsWith(".restore-staging-"));
}

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-restore-abort-"));
  multiplayerPath = path.join(root, "Saves", "Multiplayer");
  savesPath = path.join(multiplayerPath, SERVER_NAME);
  backupsPath = path.join(root, "backups");
  fs.mkdirSync(savesPath, { recursive: true });
  fs.mkdirSync(backupsPath, { recursive: true });
  fs.writeFileSync(path.join(savesPath, "map_meta.bin"), "LIVE");
  injected.failName = null;
  getServers.mockReset();
  getServers.mockResolvedValue([]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("restoreBackup: an extraction error stops the extraction", () => {
  it("leaves no staging folder behind, not even after the rest of the archive would have been read", async () => {
    await writeArchive(path.join(backupsPath, "big.zip"), { failingEntry: "boom.bin" });
    injected.failName = "boom.bin";

    const result = await createService().restoreBackup("big.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/ENOSPC|no space/i);
    expect(stagingFolders()).toEqual([]);
    // The old parser kept going after the cleanup and re-created the folder.
    await settle();
    expect(stagingFolders()).toEqual([]);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe("LIVE");
    expect(fs.readdirSync(multiplayerPath)).toEqual([SERVER_NAME]);
  });

  it("still restores an archive with no error", async () => {
    await writeArchive(path.join(backupsPath, "big.zip"));

    const result = await createService().restoreBackup("big.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe("RESTORED");
    expect(fs.readdirSync(path.join(savesPath, "map"))).toHaveLength(405);
    expect(stagingFolders()).toEqual([]);
  });
});

describe("leftover restore staging folders", () => {
  function plantStaging(name) {
    const dir = path.join(multiplayerPath, name);
    fs.mkdirSync(path.join(dir, SERVER_NAME), { recursive: true });
    fs.writeFileSync(path.join(dir, SERVER_NAME, "map_meta.bin"), "STALE");
    return dir;
  }

  it("are swept before a restore, and only the panel's own staging folders", async () => {
    const stale = plantStaging(".restore-staging-0b5f9a52-6d7e-4c1e-9d0a-2f6a1c3e8b44");
    const legacy = plantStaging(".restore-staging-1700000000000-4242");
    const notOurs = plantStaging(".restore-staging-notahexname");
    const rollback = path.join(multiplayerPath, `${SERVER_NAME}.replaced-1700000000000`);
    fs.mkdirSync(rollback);
    fs.writeFileSync(path.join(rollback, "map_meta.bin"), "PREVIOUS WORLD");
    const otherWorld = path.join(multiplayerPath, "OtherWorld");
    fs.mkdirSync(otherWorld);
    await writeArchive(path.join(backupsPath, "big.zip"), { after: 3 });

    const result = await createService().restoreBackup("big.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(notOurs)).toBe(true);
    // A rollback folder can hold the only copy of a world: never swept.
    expect(fs.readFileSync(path.join(rollback, "map_meta.bin"), "utf8")).toBe("PREVIOUS WORLD");
    expect(fs.existsSync(otherWorld)).toBe(true);
  });

  it("are swept at boot for the active server's and every other local server's saves folder", async () => {
    const otherData = path.join(root, "other");
    const otherMultiplayer = path.join(otherData, "Saves", "Multiplayer");
    fs.mkdirSync(path.join(otherMultiplayer, "Other"), { recursive: true });
    const staleHere = plantStaging(".restore-staging-aaaa-bbbb");
    const staleThere = path.join(otherMultiplayer, ".restore-staging-cccc-dddd");
    fs.mkdirSync(path.join(staleThere, "Other"), { recursive: true });
    fs.writeFileSync(path.join(staleThere, "Other", "x.bin"), "STALE");
    getServers.mockResolvedValue([
      { id: "a", serverName: SERVER_NAME, zomboidDataPath: root },
      { id: "b", serverName: "Other", zomboidDataPath: otherData },
      { id: "c", serverName: "Remote", isRemote: true, zomboidDataPath: path.join(root, "nowhere") },
    ]);
    const service = createService();
    service._resolveServerDataBasePath = async (server) => server.zomboidDataPath;

    await service.sweepRestoreStaging();

    expect(fs.existsSync(staleHere)).toBe(false);
    expect(fs.existsSync(staleThere)).toBe(false);
    expect(fs.existsSync(path.join(otherMultiplayer, "Other"))).toBe(true);
    expect(fs.existsSync(savesPath)).toBe(true);
  });

  it("are not swept at boot while a restore is running", async () => {
    const stale = plantStaging(".restore-staging-eeee-ffff");
    const service = createService();
    service.restoreInProgress = true;

    await service.sweepRestoreStaging();

    expect(fs.existsSync(stale)).toBe(true);
  });

  it("unlink a link of that name instead of following it", () => {
    const precious = path.join(root, "precious");
    fs.mkdirSync(precious);
    fs.writeFileSync(path.join(precious, "keep.txt"), "KEEP");
    const link = path.join(multiplayerPath, ".restore-staging-1234-5678");
    fs.symlinkSync(precious, link, "junction");

    const result = sweepStaleRestoreStaging(multiplayerPath);

    expect(result.removed).toEqual([".restore-staging-1234-5678"]);
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(path.join(precious, "keep.txt"), "utf8")).toBe("KEEP");
  });
});
