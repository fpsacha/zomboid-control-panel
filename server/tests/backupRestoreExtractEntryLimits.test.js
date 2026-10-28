import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { craftZip } from "./helpers/craftZip.js";

// Security audit R1-34: the restore extraction counted bytes only. An
// archive of very many empty entries, or one name nesting thousands of
// folders, records about 0 bytes, passes every byte check and creates as
// many files and folders as it likes on the saves volume (inodes, MFT
// records), each empty file holding a write stream open while the parser
// races ahead. Each file and folder now counts against the free space and
// the free inodes, deep nesting is refused, and the number of files open at
// once is bounded.

const opened = { now: 0, max: 0 };
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal();
  const createWriteStream = (...args) => {
    const stream = actual.createWriteStream(...args);
    opened.now++;
    opened.max = Math.max(opened.max, opened.now);
    stream.on("close", () => {
      opened.now--;
    });
    return stream;
  };
  return { ...actual, default: { ...actual, createWriteStream }, createWriteStream };
});

const { extractArchiveToStaging, createRestoreStagingDir, freeInodesAt } = await import(
  "../services/backupRestoreExtract.js"
);
const { ErrorCode } = await import("../utils/errorCodes.js");
const unzip = await import("unzipper");

let root;
let parent;
let zipPath;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-extract-entries-"));
  parent = path.join(root, "Saves", "Multiplayer");
  fs.mkdirSync(parent, { recursive: true });
  zipPath = path.join(root, "uploaded-test.zip");
  opened.now = 0;
  opened.max = 0;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function emptyEntries(count, prefix = "servertest/map/") {
  return Array.from({ length: count }, (_, i) => ({ path: `${prefix}${i}.bin`, data: "", method: 0 }));
}

async function extract(entries, limits = {}) {
  fs.writeFileSync(zipPath, craftZip(entries));
  const staging = createRestoreStagingDir(parent);
  let error = null;
  try {
    await extractArchiveToStaging(unzip, zipPath, staging, limits);
  } catch (e) {
    error = e;
  }
  const count = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).reduce(
      (sum, e) => sum + 1 + (e.isDirectory() ? count(path.join(dir, e.name)) : 0),
      0,
    );
  const made = count(staging);
  fs.rmSync(staging, { recursive: true, force: true });
  return { error, made };
}

describe("restore extraction counts the files and folders it creates", () => {
  it("stops an archive of empty files past the free inodes", async () => {
    // 200 free inodes: 180 usable after the margin.
    const { error, made } = await extract(emptyEntries(400), { freeInodes: 200 });
    expect(error?.errorCode).toBe(ErrorCode.BACKUP_ARCHIVE_LAYOUT_REFUSED);
    expect(made).toBeLessThanOrEqual(181);
  });

  it("refuses up front when the directory already lists more entries than free inodes", async () => {
    const { error, made } = await extract(emptyEntries(50), { freeInodes: 20, declaredEntries: 50 });
    expect(error?.errorCode).toBe(ErrorCode.BACKUP_ARCHIVE_LAYOUT_REFUSED);
    expect(made).toBe(0);
  });

  it("charges each empty file against the free space", async () => {
    // 400 KB free leaves 360 KB after the margin: room for ~350 entries at 1 KB each.
    const { error, made } = await extract(emptyEntries(1000), { freeBytes: 400 * 1024 });
    expect(error?.errorCode).toBe(ErrorCode.BACKUP_INSUFFICIENT_DISK_SPACE);
    expect(made).toBeLessThan(400);
  });

  it("charges each folder a long name creates against the free inodes (adversary: one entry, many folders)", async () => {
    const deep = `servertest/${"d/".repeat(40)}x.bin`;
    const { error } = await extract([{ path: deep, data: "", method: 0 }], { freeInodes: 30 });
    expect(error?.errorCode).toBe(ErrorCode.BACKUP_ARCHIVE_LAYOUT_REFUSED);
  });

  it("refuses an entry nested deeper than any world save", async () => {
    const deep = `servertest/${"a/".repeat(70)}x.bin`;
    const { error, made } = await extract([{ path: deep, data: "x", method: 0 }]);
    expect(error?.errorCode).toBe(ErrorCode.BACKUP_ARCHIVE_LAYOUT_REFUSED);
    expect(made).toBe(0);
  });

  it("refuses a deep directory entry too", async () => {
    const deep = `servertest/${"b/".repeat(70)}`;
    const { error } = await extract([{ path: deep, data: "" }]);
    expect(error?.errorCode).toBe(ErrorCode.BACKUP_ARCHIVE_LAYOUT_REFUSED);
  });

  it("still restores a world-shaped archive with every limit known", async () => {
    const entries = [
      { path: "servertest/", data: "" },
      { path: "servertest/map_meta.bin", data: "meta" },
      ...emptyEntries(300, "servertest/map/12/"),
      { path: "servertest/players.db", data: "x".repeat(5000) },
    ];
    const { error, made } = await extract(entries, {
      freeBytes: 10 * 1024 * 1024 * 1024,
      freeInodes: 1_000_000,
      declaredEntries: entries.length,
    });
    expect(error).toBeNull();
    // servertest, map, 12, 300 chunk files, map_meta.bin, players.db
    expect(made).toBe(305);
  });

  it("keeps the number of files open at once bounded, and still writes every one", async () => {
    // Long names: fewer entries fit in the one chunk the parser still holds
    // once reading stops (64 KB), so the bound shows. Without one, every
    // empty file of the archive was open at the same time.
    const { error, made } = await extract(emptyEntries(1500, `s/${"n".repeat(120)}-`));
    expect(error).toBeNull();
    expect(made).toBe(1501);
    expect(opened.max).toBeLessThan(800);
  });
});

describe("freeInodesAt", () => {
  it("answers a number or null, never throws", () => {
    const value = freeInodesAt(root);
    expect(value === null || (Number.isFinite(value) && value >= 0)).toBe(true);
    expect(freeInodesAt(path.join(root, "missing", "folder"))).toBeNull();
  });
});
