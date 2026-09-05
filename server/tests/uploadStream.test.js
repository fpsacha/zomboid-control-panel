import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import crypto from "crypto";
import {
  streamUploadToFile,
  UPLOAD_TOO_LARGE_CODE,
  UPLOAD_BAD_SIGNATURE_CODE,
} from "../utils/uploadStream.js";

// bug hunt 2026-09-05 (backup-restore-round-trip sweep, item #5):
// routes/backup.js's POST /upload used to buffer the ENTIRE request body
// into one in-process Buffer (express.raw({ limit: 4GB })) before ever
// touching disk. This is the streaming replacement -- these tests prove
// the functional behavior (byte-identical output, signature/size
// enforcement, no leftover partial file) survives the switch; the memory
// property itself (peak usage bounded by chunk size, not upload size) is
// inherent to the code shape (no Buffer.concat over the whole body
// anywhere in uploadStream.js) rather than something a unit test can
// measure directly without actually sending gigabytes.

let root;
let tmpPath;

function fakeRequest(chunks) {
  const req = new Readable({
    read() {
      for (const chunk of chunks) this.push(chunk);
      this.push(null);
    },
  });
  return req;
}

// A request stream that never calls back read() again once paused/resumed
// naturally by pipe() -- Readable's default push-in-one-go above already
// works fine with pipe() for these test sizes, no need for a slower
// custom pull-based source.

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("streamUploadToFile", () => {
  it("streams a real zip's bytes to disk unchanged, split across many small chunks", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-stream-"));
    tmpPath = path.join(root, "out.zip.tmp");

    // Realistic local-file-header signature + enough bytes to force many
    // chunk boundaries, deliberately split so the signature itself
    // straddles two chunks (1 byte, then the rest) -- the exact case a
    // naive "check only the first data event" implementation would get
    // wrong.
    const body = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      crypto.randomBytes(500_000),
    ]);
    const chunks = [body.subarray(0, 1)];
    for (let i = 1; i < body.length; i += 4096) {
      chunks.push(body.subarray(i, i + 4096));
    }

    const req = fakeRequest(chunks);
    const totalBytes = await streamUploadToFile(req, tmpPath, 10 * 1024 * 1024);

    expect(totalBytes).toBe(body.length);
    expect(fs.readFileSync(tmpPath).equals(body)).toBe(true);
  });

  it("rejects a non-zip signature, even when it arrives split across chunks, and leaves no tmp file behind", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-stream-"));
    tmpPath = path.join(root, "out.zip.tmp");

    const body = Buffer.from("this is not a zip file at all, just text");
    const chunks = [body.subarray(0, 2), body.subarray(2)];
    const req = fakeRequest(chunks);

    await expect(
      streamUploadToFile(req, tmpPath, 10 * 1024 * 1024),
    ).rejects.toMatchObject({ code: UPLOAD_BAD_SIGNATURE_CODE });
    // The reject fires as soon as the violation is detected, which is
    // before writeStream's fd has actually finished closing (destroy() is
    // async) -- the unlink itself only happens once 'close' fires.
    await vi.waitFor(() => expect(fs.existsSync(tmpPath)).toBe(false));
  });

  it("rejects a body shorter than 4 bytes as an invalid signature rather than hanging or silently accepting it", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-stream-"));
    tmpPath = path.join(root, "out.zip.tmp");

    const req = fakeRequest([Buffer.from([0x50, 0x4b])]);

    await expect(
      streamUploadToFile(req, tmpPath, 10 * 1024 * 1024),
    ).rejects.toMatchObject({ code: UPLOAD_BAD_SIGNATURE_CODE });
  });

  it("resolves with 0 for a genuinely empty body, leaving the decision of what that means to the caller", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-stream-"));
    tmpPath = path.join(root, "out.zip.tmp");

    const req = fakeRequest([]);
    const totalBytes = await streamUploadToFile(req, tmpPath, 10 * 1024 * 1024);
    expect(totalBytes).toBe(0);
  });

  it("aborts once the configured size limit is exceeded, without ever buffering the full oversized body", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-stream-"));
    tmpPath = path.join(root, "out.zip.tmp");

    const maxBytes = 10_000;
    const body = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      crypto.randomBytes(maxBytes * 3),
    ]);
    const chunks = [];
    for (let i = 0; i < body.length; i += 2048) {
      chunks.push(body.subarray(i, i + 2048));
    }
    const req = fakeRequest(chunks);

    await expect(
      streamUploadToFile(req, tmpPath, maxBytes),
    ).rejects.toMatchObject({ code: UPLOAD_TOO_LARGE_CODE });
    // The partial bytes written before the abort must not survive it --
    // waits for the write stream's fd to actually close first (see the
    // function's own comment on why), so give it a moment.
    await vi.waitFor(() => expect(fs.existsSync(tmpPath)).toBe(false));
  });
});
