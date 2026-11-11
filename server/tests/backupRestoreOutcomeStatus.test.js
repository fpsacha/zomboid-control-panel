import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ZipArchive } from "archiver";

// GH#166 ("World Recovery View do not get finished"): the Backups page's
// restore card spun forever after a restore that had actually finished.
// Server half of it: every restore's mandatory pre-restore safety backup
// reports its own backup:progress 'complete' while the restore is still
// running, the page re-reads GET /backup/status on that event, and the
// restoreInProgress:true it gets back was the last word the page ever had
// -- nothing about the restore's own end was readable from the status, only
// from the POST's own held-open response. A restore that outlived that
// response (client timeout, a proxy cutting the request, a reload, another
// tab) had no outcome anywhere. The status now carries the running restore
// and the last one's outcome, and 'restore:finished' says when it changed.

const logServerEvent = vi.fn(async () => {});

// backup:progress / restore:progress / restore:finished go to the backups
// room only (server/index.js's CAPABILITY_ROOMS), never to every socket.
function backupRoomIo(onEmit) {
  return {
    emit: () => {
      throw new Error("backup/restore events must go to the backups room, not every socket");
    },
    to: (room) => {
      if (room !== "backups") throw new Error(`unexpected room ${room}`);
      return { emit: onEmit };
    },
  };
}

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
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

function createService(processDetails = async () => ({ running: false, scanFailed: false })) {
  const service = new BackupService();
  service.getSavesPath = async () => savesPath;
  service.getBackupsPath = async () => backupsPath;
  service.getSettings = async () => ({
    enabled: false,
    schedule: "0 */6 * * *",
    maxBackups: 10,
    includeDb: false,
  });
  service.setServerManager({ getServerProcessDetails: processDetails });
  return service;
}

async function writeValidBackup(zipPath, marker) {
  const stagingWorld = path.join(root, "source", marker);
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-restore-outcome-"));
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

describe("GET /backup/status carries a restore's outcome, not just the POST's response (GH#166)", () => {
  it("a status read on the pre-restore backup's 'complete' still sees the restore running; the status after it ends says how it ended", async () => {
    await writeValidBackup(path.join(backupsPath, "good.zip"), "RESTORED");
    const service = createService();

    const events = [];
    let statusAtPreBackupComplete = null;
    let flagWhenFinished = null;
    const io = backupRoomIo((event, payload) => {
      events.push([event, payload]);
      // What Backups.tsx does on this exact event: re-read the status.
      if (event === "backup:progress" && payload.phase === "complete") {
        statusAtPreBackupComplete = service.getStatus();
      }
      if (event === "restore:finished") flagWhenFinished = service.restoreInProgress;
    });

    const result = await service.restoreBackup("good.zip", {
      createPreRestoreBackup: true,
      requestId: "page-request-0001",
      io,
    });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe("RESTORED");

    // The status the page got mid-restore: running, and now it says which.
    const during = await statusAtPreBackupComplete;
    expect(during.restoreInProgress).toBe(true);
    expect(during.currentRestore).toMatchObject({
      id: "page-request-0001",
      backupName: "good.zip",
      preRestoreBackup: true,
    });

    // And the status after: not running, with the outcome of that restore.
    const after = await service.getStatus();
    expect(after.restoreInProgress).toBe(false);
    expect(after.currentRestore).toBeNull();
    expect(after.lastRestore).toMatchObject({
      id: "page-request-0001",
      backupName: "good.zip",
      success: true,
      message: null,
      preRestoreBackup: true,
    });
    expect(typeof after.lastRestore.duration).toBe("number");
    expect(Date.parse(after.lastRestore.finishedAt)).toBeGreaterThanOrEqual(
      Date.parse(after.lastRestore.startedAt),
    );

    // The push comes last, once the flag is down and the outcome recorded
    // -- naming the restore, nothing more (see the next test).
    expect(events.at(-1)).toEqual(["restore:finished", { id: "page-request-0001" }]);
    expect(flagWhenFinished).toBe(false);
  });

  it("records a failure with its reason, path-redacted like the POST's own response", async () => {
    await writeValidBackup(path.join(backupsPath, "good.zip"), "RESTORED");
    // The saves folder's parent is a plain file: making the staging folder
    // beside it fails with Node's raw fs error, which names a full path.
    const blocker = path.join(root, "not-a-folder");
    fs.writeFileSync(blocker, "x");
    savesPath = path.join(blocker, SERVER_NAME);
    const service = createService();
    const events = [];

    const result = await service.restoreBackup("good.zip", {
      createPreRestoreBackup: false,
      // Not an id the page may pick: the server makes one instead.
      requestId: "../../etc",
      io: backupRoomIo((event, payload) => events.push([event, payload])),
    });

    expect(result.success).toBe(false);
    const { lastRestore } = await service.getStatus();
    expect(lastRestore.success).toBe(false);
    expect(lastRestore.backupName).toBe("good.zip");
    expect(lastRestore.id).not.toBe("../../etc");
    expect(lastRestore.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lastRestore.message).toBeTruthy();
    expect(lastRestore.message).not.toContain(root);
    // An API caller may skip the safety backup; a page that only watched
    // this restore must not claim one.
    expect(lastRestore.preRestoreBackup).toBe(false);
    expect(events.at(-1)).toEqual(["restore:finished", { id: lastRestore.id }]);
  });

  it("keeps a rollback failure's host path in the capability-gated status, out of the restore:finished broadcast", async () => {
    // restore:finished goes to the backups room, which a moderator (no
    // backup capability) can't join, but it is still a broadcast to every
    // socket in that room; GET /backup/status is gated per request. The
    // rollback-failure message deliberately keeps its path (it's where the
    // previous world now sits), so it may reach only the status.
    const { RESTORE_ROLLBACK_FAILED_PREFIX } = await import("../utils/restoreMessage.js");
    const preservedAt = path.join(root, "Saves", "Multiplayer", `${SERVER_NAME}.replaced-1`);
    const service = createService();
    service._runRestore = async () => ({
      success: false,
      message: `${RESTORE_ROLLBACK_FAILED_PREFIX} It is preserved at ${preservedAt}.`,
    });
    const events = [];

    await service.restoreBackup("good.zip", {
      requestId: "page-request-0002",
      io: backupRoomIo((event, payload) => events.push([event, payload])),
    });

    const { lastRestore } = await service.getStatus();
    expect(lastRestore.message).toContain(preservedAt);
    expect(events).toEqual([["restore:finished", { id: "page-request-0002" }]]);
    expect(JSON.stringify(events)).not.toContain(root);
  });

  it("a second restore refused while one runs leaves the running one's record alone", async () => {
    await writeValidBackup(path.join(backupsPath, "good.zip"), "RESTORED");
    let releaseCheck;
    const checkGate = new Promise((resolve) => (releaseCheck = resolve));
    const service = createService(async () => {
      await checkGate;
      return { running: false, scanFailed: false };
    });

    const first = service.restoreBackup("good.zip", {
      createPreRestoreBackup: false,
      requestId: "first-restore-01",
    });
    const second = await service.restoreBackup("good.zip", {
      createPreRestoreBackup: false,
      requestId: "second-restore-01",
    });

    expect(second).toEqual({ success: false, message: "Restore already in progress" });
    const during = await service.getStatus();
    expect(during.currentRestore.id).toBe("first-restore-01");
    expect(during.lastRestore).toBeNull();

    releaseCheck();
    expect((await first).success).toBe(true);
    const after = await service.getStatus();
    expect(after.lastRestore.id).toBe("first-restore-01");
  });
});
