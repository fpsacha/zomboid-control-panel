import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// lifecycle-lock-set sweep, 2026-09-07 (Kevin's finding, backup-restore
// lane, relayed by god): POST /create takes no lifecycle lock, so nothing
// stops the active server being switched (POST /servers/:id/activate) mid-
// backup. _doCreateBackup() used to call getActiveServer() THREE separate
// times -- once each via getSavesPath(), getBackupsPath(), and its own
// direct call for the filename label/snapshot -- so a switch landing
// between any of them could produce an archive whose DATA comes from one
// server while its FILENAME LABEL (and the addBackupRecord() entry) names
// a different one. A backup is only useful if its label tells you what
// it's a backup OF; a mislabelled archive is discovered at the worst
// possible moment (restore time).
//
// Fixed by reading getActiveServer() exactly ONCE in _doCreateBackup() and
// passing it into getSavesPath()/getBackupsPath() via a new optional
// override parameter (every other existing caller of those two methods
// passes nothing and keeps its own always-fresh read, unchanged).
// restoreBackup()'s own two getActiveServer() calls are untouched
// deliberately: restore holds the process-wide lifecycle lock for its
// whole duration, and /servers/:id/activate takes that same lock, so the
// active server provably cannot change under a restore already -- this
// fix is scoped to createBackup(), the one call chain that had no such
// protection.
//
// This test forces the interleaving rather than hoping for it (the same
// discipline as getActiveServerPathsSingleRead.test.js and friends): the
// mocked getActiveServer() returns Server A on its first call and Server B
// on any subsequent call, modeling a concurrent activate(). Asserting the
// call COUNT as well as the resulting values is what makes this a
// single-read test rather than a lucky-agreement test -- the pre-fix code
// (three independent calls, all happening to land before any switch) would
// also pass a test that only checked the happy-path values.

const getActiveServerMock = vi.fn();
const addBackupRecordMock = vi.fn(async () => {});

vi.mock("../database/init.js", () => ({
  getActiveServer: getActiveServerMock,
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getLatestScheduleExecutionByCommand: vi.fn(async () => null),
  flushWrites: vi.fn(async () => {}),
}));

vi.mock("../services/backupRecords.js", () => ({
  addBackupRecord: addBackupRecordMock,
  removeBackupRecord: vi.fn(async () => {}),
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { BackupService } = await import("../services/backupService.js");

let root;
let serverA;
let serverB;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-single-read-"));
  const dataPathA = path.join(root, "A");
  const dataPathB = path.join(root, "B");
  fs.mkdirSync(path.join(dataPathA, "Saves", "Multiplayer", "ServerA"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dataPathA, "Saves", "Multiplayer", "ServerA", "map_meta.bin"),
    "a",
  );
  fs.mkdirSync(path.join(dataPathB, "Saves", "Multiplayer", "ServerB"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dataPathB, "Saves", "Multiplayer", "ServerB", "map_meta.bin"),
    "b",
  );
  serverA = { id: 1, serverName: "ServerA", zomboidDataPath: dataPathA };
  serverB = { id: 2, serverName: "ServerB", zomboidDataPath: dataPathB };
  getActiveServerMock.mockReset();
  addBackupRecordMock.mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("backupService.js createBackup() reads the active server exactly once", () => {
  it("does not let a concurrent active-server switch split the archive's data from its filename label", async () => {
    let calls = 0;
    getActiveServerMock.mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? serverA : serverB;
    });

    const service = new BackupService();
    const result = await service.createBackup({});

    expect(getActiveServerMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.backup.name.startsWith("ServerA_")).toBe(true);
    expect(result.backup.path).toContain(path.join(root, "A", "backups"));
    expect(result.backup.path).not.toContain(path.join(root, "B"));

    expect(addBackupRecordMock).toHaveBeenCalledTimes(1);
    expect(addBackupRecordMock.mock.calls[0][0].server).toBe(serverA);
  });
});
