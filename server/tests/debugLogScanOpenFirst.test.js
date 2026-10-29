import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

// Security audit 2026-10-28: scanRecentCrash() and readTailText() checked
// server-console.txt with stat() and then opened it by path. A FIFO put at
// that name between the two (the Zomboid folder can belong to another OS
// account) blocked the open, and a libuv thread with it, for good; a log
// replaced in between was read with the old file's size. Both now open
// first (non-blocking) and check the descriptor.
const { scanRecentCrash, readTailText } = await import("../routes/debug.js");

const OOM = "java.lang.OutOfMemoryError: Java heap space";

describe("game log scans check the file they opened", () => {
  let dir;
  let logPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-logscan-"));
    logPath = path.join(dir, "server-console.txt");
    fs.writeFileSync(logPath, "boot ok\n");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The game rotates server-console.txt on start: the log can be replaced
  // between a stat and an open.
  function replaceOnOpen(content) {
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementation(async (filePath, ...rest) => {
      if (String(filePath) === logPath) fs.writeFileSync(logPath, content);
      return realOpen(filePath, ...rest);
    });
  }

  it("scanRecentCrash reads the log it opened, not the one it checked before", async () => {
    replaceOnOpen(`${"x".repeat(4000)}\n${OOM}\n`);
    const result = await scanRecentCrash(dir);
    expect(result).toMatchObject({ kind: "oom", line: OOM });
  });

  it("readTailText reads the log it opened, not the one it checked before", async () => {
    replaceOnOpen(`${"x".repeat(4000)}\nArrayIndexOutOfBoundsException\n`);
    expect(await readTailText(logPath)).toContain("ArrayIndexOutOfBoundsException");
  });

  it("still reads the tail of a real log and ignores a folder or a missing file", async () => {
    fs.writeFileSync(logPath, `${"y".repeat(300 * 1024)}\n${OOM}\n`);
    expect(await scanRecentCrash(dir)).toMatchObject({ kind: "oom" });
    expect(await readTailText(logPath, 64)).toBe(`${"y".repeat(64 - OOM.length - 2)}\n${OOM}\n`);

    fs.rmSync(logPath);
    expect(await scanRecentCrash(dir)).toBeNull();
    expect(await readTailText(logPath)).toBeNull();
    fs.mkdirSync(logPath);
    expect(await scanRecentCrash(dir)).toBeNull();
    expect(await readTailText(logPath)).toBeNull();
  });

  // Adversary pass: a FIFO the checks are told is a file (what a swap right
  // after a stat() looks like) must not block the scan.
  it.skipIf(process.platform === "win32").each([
    ["scanRecentCrash", () => scanRecentCrash(dir)],
    ["readTailText", () => readTailText(logPath)],
  ])("%s does not wait on a FIFO at the log's name", async (_label, scan) => {
    fs.rmSync(logPath);
    execFileSync("mkfifo", [logPath]);
    const regular = fs.statSync(fileURLToPath(import.meta.url));
    vi.spyOn(fs.promises, "stat").mockResolvedValue(regular);

    const outcome = await Promise.race([
      scan(),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 3000)),
    ]);
    if (outcome === "blocked") {
      // Release the blocked open so the worker can exit.
      fs.closeSync(fs.openSync(logPath, "r+"));
    }
    expect(outcome).toBeNull();
  });
});
