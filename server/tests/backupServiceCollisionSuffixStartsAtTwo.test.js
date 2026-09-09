import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-09-09 (Kevin's cross-ring sweep, timestamp-tie-breaks): the fourth
// instance of the same-millisecond-collision class fixed once already in
// database/init.js (3cf2b36a) and utils/configBackup.js -- this is the one
// ring holding the user's actual game saves, not panel config.
//
// _doCreateBackup()'s collision loop started its suffix counter at 1, so
// the FIRST real collision produced "<base>-1.zip" -- but backupSortKey()
// already treats an UNSUFFIXED name as suffix 1 too (matching every sibling
// ring's convention). On a real same-millisecond collision (a fast or
// near-empty world backs up in well under a second, and createBackup()'s
// own mutex serializes back-to-back calls close enough in time to tie), the
// original and its first collision land on an IDENTICAL sort key, and
// listBackups()'s sort can't tell them apart -- falling back to whatever
// order fs.promises.readdir() happens to return, unrelated to creation
// order. cleanupOldBackups()'s .slice(maxBackups) deletion trusts that
// order completely: it can prune the genuinely NEWER of the two and keep
// the older one. Freezing Date forces the exact collision deterministically
// on every run, matching the method used for the sibling database/init.js
// fix (3cf2b36a) rather than depending on real disk-timing luck.

const logServerEvent = vi.fn(async () => {});
const settingsStore = new Map();

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async (key) => settingsStore.get(key) ?? null),
  setSetting: vi.fn(async () => {}),
  logServerEvent,
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { BackupService } = await import("../services/backupService.js");

let root;
let savesPath;
let backupsPath;

function createService() {
  const service = new BackupService();
  service.getSavesPath = async () => savesPath;
  service.getBackupsPath = async () => backupsPath;
  return service;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backupservice-collision-"));
  savesPath = path.join(root, "Saves", "Multiplayer", "servertest");
  backupsPath = path.join(root, "backups");
  fs.mkdirSync(backupsPath, { recursive: true });
  fs.mkdirSync(savesPath, { recursive: true });
  fs.writeFileSync(path.join(savesPath, "map_meta.bin"), "seed");
  settingsStore.clear();
  settingsStore.set("backupMaxCount", 1);
  logServerEvent.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("BackupService: two backups landing in the SAME millisecond", () => {
  it("names the first collision '-2.zip' (never '-1.zip'), and pruning keeps the truly newer one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const service = createService();

    const first = await service.createBackup({ createPreRestoreBackup: false });
    expect(first.success).toBe(true);
    const firstName = first.backup.name;

    // Date is still frozen to the IDENTICAL instant -- without the fix this
    // collides with `firstName` on the exact same millisecond and the
    // collision loop names it "-1.zip", tying firstName's implied suffix 1.
    const second = await service.createBackup({ createPreRestoreBackup: false });
    expect(second.success).toBe(true);
    const secondName = second.backup.name;

    expect(firstName).not.toBe(secondName);
    expect(secondName).not.toMatch(/-1\.zip$/);
    expect(secondName).toMatch(/-2\.zip$/);

    // maxBackups=1: pruning must keep the truly newer backup (created
    // SECOND, in real call order) and delete the truly older one (created
    // FIRST) -- not whichever one fs.promises.readdir() happens to list
    // first, which is what an identical (key, suffix) tie would fall back
    // to.
    await service.cleanupOldBackups();

    const remaining = fs
      .readdirSync(backupsPath)
      .filter((f) => f.endsWith(".zip"));
    expect(remaining).toHaveLength(1);
    expect(remaining).toContain(secondName);
    expect(remaining).not.toContain(firstName);
  });
});
