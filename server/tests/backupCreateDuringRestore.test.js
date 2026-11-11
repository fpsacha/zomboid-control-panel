import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ZipArchive } from "archiver";

// Concurrency hunt 2026-08-29 (conversation hunt-wave5-2026-08-29): god's brief
// flagged "a restart racing a backup, a backup racing a wipe" as an angle to
// check. restoreBackup() already refuses a second restore AND a concurrent
// createBackup() (bug-hunt-2026-08-27, see backupRestoreSafety.test.js line
// ~368 and the `if (this.backupInProgress)` guard at the top of
// restoreBackup()). But that guard is one-directional: createBackup() itself
// (backupService.js line ~355) only ever checks `this.backupInProgress`,
// never `this.restoreInProgress` -- so a NEW backup can start while a
// restore is mid-flight, extracting into a staging directory and then
// renaming the live saves folder out from under any in-progress read.
//
// This test does NOT need an artificial timing race to prove the gap:
// restoreBackup() sets `this.restoreInProgress = true` synchronously, before
// its first `await` (verified by reading the source -- lines 960-982 are a
// plain sequence of `if` checks and a bare assignment, no await ahead of it).
// So the instant `service.restoreBackup(...)` is called (even without
// awaiting the returned promise), the flag is already true for any code that
// runs after that call returns control to this test.

const logServerEvent = vi.fn(async () => {});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent,
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
  const stagingWorld = path.join(root, "source", `${SERVER_NAME}-${marker}`);
  writeWorld(stagingWorld, marker);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 0 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(stagingWorld, SERVER_NAME);
    archive.finalize();
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-vs-restore-"));
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

describe("createBackup() while a restore is in progress", () => {
  it("is refused, the same way a second restoreBackup() call is refused during an in-progress restore", async () => {
    const service = createService();
    const good = path.join(backupsPath, "good.zip");
    await writeValidBackup(good, "RESTORED");

    const restorePromise = service.restoreBackup("good.zip", {
      createPreRestoreBackup: false,
    });

    // restoreInProgress is set synchronously before restoreBackup()'s first
    // await, so by the time the call above returns control here, the flag
    // is already true -- no artificial delay needed to hit this window.
    expect(service.restoreInProgress).toBe(true);

    const backupResult = await service.createBackup();

    await restorePromise;

    expect(backupResult.success).toBe(false);
    expect(backupResult.message).toMatch(/restore.*progress/i);
  });
});

// Note (kevin, hunt-wave5-2026-08-29): I also tried to pin down what a
// concurrent backup actually CONTAINS when it slips through this gap --
// archiver's directory() (readdir-glob) walks the live tree incrementally,
// so in principle a file not yet reached when restore's swap (two
// renameSync calls, backupService.js ~1262-1271) fires gets read from
// whatever is at savesPath afterwards, i.e. the RESTORED world, silently,
// under the LIVE backup's expected filename. I could not safely force that
// exact interleaving in this harness: every product-code step between
// "extraction succeeded" and "swap complete" is synchronous (no await), so
// there is no legitimate awaited hook to delay right before the swap
// without changing product code or monkey-patching fs.renameSync globally,
// and I did not want to do either just to win a test. So this specific
// worst-case ("silently wrong content, not just a refused/failed call") is
// UNCONFIRMED, not proven -- report it as a plausible consequence of the
// proven missing guard above, not as its own demonstrated finding.
