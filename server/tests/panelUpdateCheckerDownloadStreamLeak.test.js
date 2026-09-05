import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";

// main-is-red overnight-sweep follow-up, 2026-09-05: downloadFile()'s fail()
// (panelUpdateChecker.js ~:1420) unlinked the destination file on any
// failure but never closed the write stream piping into it. pipe() only
// auto-ends its destination when the SOURCE ends normally -- never on a
// source error -- so a timeout or abort partway through a download left the
// write stream open, holding the file descriptor, while fail() tried to
// delete the very file that handle still held open. On Windows specifically,
// unlinking a file with an open handle can silently fail (the callback here
// swallows the error), leaving a corrupt partial download on disk for the
// next attempt to trip over, on top of the leaked descriptor itself.
let mockReq;
let mockRes;
let capturedFile = null;

vi.mock("https", () => ({
  default: {
    get: vi.fn((_url, _options, callback) => {
      mockReq = new EventEmitter();
      mockReq.destroy = vi.fn((err) => {
        mockReq.emit("error", err);
      });
      mockReq.setTimeout = vi.fn();
      mockRes = new EventEmitter();
      mockRes.statusCode = 200;
      mockRes.headers = {};
      mockRes.resume = vi.fn();
      // The real code does res.pipe(file) -- captured here instead of
      // actually piping, so the test can inspect the real WriteStream
      // fail() is responsible for closing, without needing real bytes to
      // flow through it.
      mockRes.pipe = (dest) => {
        capturedFile = dest;
        return dest;
      };
      setTimeout(() => callback(mockRes), 0);
      return mockReq;
    }),
  },
}));

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

vi.mock("./dockerUpdateProxy.js", () => ({
  DockerUpdateProxy: vi.fn(function DockerUpdateProxy() {
    this.mode = "none";
  }),
}));

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");

let tempDir;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("PanelUpdateChecker.downloadFile closes its write stream instead of leaking it on abort", () => {
  it("destroys the real write stream (and only then unlinks) when the download is aborted mid-transfer", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-download-"));
    const destPath = path.join(tempDir, "staged.exe");
    const checker = new PanelUpdateChecker({ emit: vi.fn() });
    checker.currentVersion = "1.0.0";

    const downloadPromise = checker.downloadFile(
      "https://github-releases.githubusercontent.com/asset",
      destPath,
      0,
      "binary",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    mockRes.emit("data", Buffer.from("partial"));
    expect(capturedFile).toBeTruthy();
    expect(capturedFile.destroyed).toBe(false);

    const timeoutError = new Error("Download timed out");
    timeoutError.code = "ETIMEDOUT";
    mockReq.destroy(timeoutError);

    await expect(downloadPromise).rejects.toThrow("Download timed out");
    // The stream's own "close" fires asynchronously after destroy().
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(capturedFile.destroyed).toBe(true);
    expect(fs.existsSync(destPath)).toBe(false);
  });
});
