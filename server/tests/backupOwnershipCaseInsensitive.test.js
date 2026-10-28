import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

// Security audit R1-61: the guard that keeps one server profile from
// downloading, reading, deleting or restoring another profile's backup in a
// shared backups folder attributed the name AS REQUESTED, with a
// case-sensitive pattern. Windows (and macOS) ignore case in file names and
// Windows also opens a file by its 8.3 short name, so "serverb_..." or
// "SERVER~1.ZIP" reached ServerB's archive while the guard saw no owner. Two
// profiles whose data folders differ only in case (C:\PZ vs c:\pz) were not
// even seen as sharing a folder.

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

const FOREIGN = "ServerB_2026-09-18T00-00-00-001.zip";

function caseInsensitiveFolder(dir) {
  const probe = path.join(dir, "CaseProbe");
  fs.writeFileSync(probe, "");
  try {
    return fs.existsSync(path.join(dir, "caseprobe"));
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

// The 8.3 short name Windows gives `file`, or null when the volume makes none.
function shortNameOf(file) {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync("cmd.exe", ["/d", "/c", `for %I in ("${file}") do @echo %~snxI`], {
      encoding: "utf8",
      windowsVerbatimArguments: true,
    }).trim();
    return out && out !== path.basename(file) && out.includes("~") ? out : null;
  } catch {
    return null;
  }
}

const tmpCaseInsensitive = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-case-probe-"));
  try {
    return caseInsensitiveFolder(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-case-"));
  sharedDataPath = path.join(root, "shared");
  fs.mkdirSync(path.join(sharedDataPath, "backups"), { recursive: true });
  serverA = { id: "a", serverName: "ServerA", zomboidDataPath: sharedDataPath };
  serverB = { id: "b", serverName: "ServerB", zomboidDataPath: sharedDataPath };
  getActiveServerMock.mockReset().mockResolvedValue(serverA);
  getServersMock.mockReset().mockResolvedValue([serverA, serverB]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeForeign() {
  const file = path.join(sharedDataPath, "backups", FOREIGN);
  fs.writeFileSync(file, "zip-bytes");
  return file;
}

describe.skipIf(!tmpCaseInsensitive)("backup ownership on a case-insensitive file system", () => {
  it("deleteBackup() refuses another profile's backup asked for in lower case", async () => {
    const foreign = writeForeign();
    const result = await new BackupService().deleteBackup(FOREIGN.toLowerCase());
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/belongs to another server profile.*ServerB/i);
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it("deleteBackup() refuses it with only the timestamp's T lowered (the .zip suffix kept)", async () => {
    const foreign = writeForeign();
    const result = await new BackupService().deleteBackup(FOREIGN.replace("T", "t"));
    expect(result.success).toBe(false);
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it("getBackupSnapshot() refuses a case variant too", async () => {
    writeForeign();
    const result = await new BackupService().getBackupSnapshot(FOREIGN.toUpperCase().replace(".ZIP", ".zip"));
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/another server profile/i);
  });

  it("its own backup asked for in another case is still its own", async () => {
    const own = path.join(sharedDataPath, "backups", "ServerA_2026-09-18T00-00-00-002.zip");
    fs.writeFileSync(own, "zip-bytes");
    const result = await new BackupService().deleteBackup("servera_2026-09-18t00-00-00-002.zip");
    expect(result.success).toBe(true);
    expect(fs.existsSync(own)).toBe(false);
  });

  it.skipIf(process.platform !== "win32")(
    "two profiles whose data folders differ only in case share one backups folder",
    async () => {
      serverB = { ...serverB, zomboidDataPath: sharedDataPath.toUpperCase() };
      getServersMock.mockResolvedValue([serverA, serverB]);
      const foreign = writeForeign();
      const result = await new BackupService().deleteBackup(FOREIGN);
      expect(result.success).toBe(false);
      expect(fs.existsSync(foreign)).toBe(true);
    },
  );

  it.skipIf(process.platform !== "win32")("deleteBackup() refuses the Windows 8.3 short name", async (ctx) => {
    const foreign = writeForeign();
    const short = shortNameOf(foreign);
    if (!short) {
      ctx.skip();
      return;
    }
    const result = await new BackupService().deleteBackup(short.toLowerCase());
    expect(result.success).toBe(false);
    expect(fs.existsSync(foreign)).toBe(true);
  });
});

describe("backup ownership everywhere", () => {
  it("a name that is not on disk in any spelling is not found, not attributed", async () => {
    writeForeign();
    const result = await new BackupService().deleteBackup("ServerB_2026-09-18T00-00-00-999.zip");
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });
});
