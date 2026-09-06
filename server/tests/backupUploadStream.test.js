import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import crypto from "crypto";

// bug hunt 2026-09-05 (backup-restore-round-trip sweep, item #5): route
// coverage for POST /upload's switch from express.raw() (fully buffered)
// to streamUploadToFile() (streamed) -- server/tests/uploadStream.test.js
// already covers the streaming primitive itself in isolation; this file
// covers the route's own surrounding logic (content-type gate, name
// conflict, error-code-to-status mapping) still behaves the same way.

vi.mock("../database/init.js", () => ({ getActiveServer: vi.fn() }));

// Only the 413 test below needs this mocked (to exercise the route's
// error-code-to-status mapping without actually sending 4 GB) -- every
// other test in this file relies on the REAL streamUploadToFile() so the
// signature/size/streaming behavior itself stays covered against the real
// implementation, not a stand-in.
const streamUploadToFileMock = vi.fn();
vi.mock("../utils/uploadStream.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    streamUploadToFile: (...args) => streamUploadToFileMock(...args),
  };
});

const { getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/backup.js");
const { streamUploadToFile: realStreamUploadToFile } = await vi.importActual(
  "../utils/uploadStream.js",
);
// Default every test to the REAL implementation; the 413 test overrides
// this mock's return value for just that one call.
streamUploadToFileMock.mockImplementation(realStreamUploadToFile);

let root;
let backupsPath;

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getUploadHandler() {
  const layer = router.stack.find((entry) => entry.route?.path === "/upload");
  return layer.route.stack.at(-1).handle;
}

function fakeRequest(chunks, headers) {
  const req = new Readable({
    read() {
      for (const chunk of chunks) this.push(chunk);
      this.push(null);
    },
  });
  req.headers = headers;
  return req;
}

function makeApp(backupService) {
  return { get: (key) => (key === "backupService" ? backupService : {}) };
}

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.restoreAllMocks();
});

describe("POST /upload streams the body to disk", () => {
  it("stores a valid zip byte-for-byte and reports its real size", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-route-"));
    backupsPath = path.join(root, "backups");
    fs.mkdirSync(backupsPath, { recursive: true });
    getActiveServer.mockResolvedValue({ isRemote: false });

    const body = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      crypto.randomBytes(200_000),
    ]);
    const req = fakeRequest([body], {
      "content-type": "application/zip",
      "x-backup-filename": "world.zip",
    });
    req.app = makeApp({ getBackupsPath: async () => backupsPath });
    const response = createResponse();

    await getUploadHandler()(req, response);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, name: "uploaded-world.zip", size: body.length }),
    );
    const stored = fs.readFileSync(path.join(backupsPath, "uploaded-world.zip"));
    expect(stored.equals(body)).toBe(true);
    expect(fs.existsSync(path.join(backupsPath, "uploaded-world.zip.tmp"))).toBe(false);
  });

  it("refuses a non-application/zip content type before touching the body", async () => {
    getActiveServer.mockResolvedValue({ isRemote: false });
    const req = fakeRequest([Buffer.from("irrelevant")], { "content-type": "text/plain" });
    req.app = makeApp({});
    const response = createResponse();

    await getUploadHandler()(req, response);

    expect(response.status).toHaveBeenCalledWith(400);
  });

  it("refuses with 409 and never touches the stream when the target name already exists", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-route-"));
    backupsPath = path.join(root, "backups");
    fs.mkdirSync(backupsPath, { recursive: true });
    fs.writeFileSync(path.join(backupsPath, "uploaded-world.zip"), "existing");
    getActiveServer.mockResolvedValue({ isRemote: false });

    const req = fakeRequest([Buffer.from([0x50, 0x4b, 0x03, 0x04])], {
      "content-type": "application/zip",
      "x-backup-filename": "world.zip",
    });
    req.app = makeApp({ getBackupsPath: async () => backupsPath });
    const response = createResponse();

    await getUploadHandler()(req, response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(fs.readFileSync(path.join(backupsPath, "uploaded-world.zip"), "utf8")).toBe(
      "existing",
    );
  });

  it("rejects a bad zip signature with 400 and leaves no tmp file behind", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-route-"));
    backupsPath = path.join(root, "backups");
    fs.mkdirSync(backupsPath, { recursive: true });
    getActiveServer.mockResolvedValue({ isRemote: false });

    const req = fakeRequest([Buffer.from("not a zip at all")], {
      "content-type": "application/zip",
      "x-backup-filename": "world.zip",
    });
    req.app = makeApp({ getBackupsPath: async () => backupsPath });
    const response = createResponse();

    await getUploadHandler()(req, response);

    expect(response.status).toHaveBeenCalledWith(400);
    await vi.waitFor(() =>
      expect(fs.readdirSync(backupsPath)).toEqual([]),
    );
  });

  it("refuses 409 if a same-name upload lands DURING the stream, not just before it started", async () => {
    // 2026-09-06 (kevin, concatenated-identifier sweep): the earlier
    // existsSync(targetPath) check above only rules out a conflict at
    // request START -- it says nothing about a second upload for the same
    // x-backup-filename that finishes and lands its own file WHILE this
    // one is still streaming (a multi-GB upload can take minutes, a much
    // bigger window than the millisecond one this codebase already knows
    // to guard timestamped filenames against). Simulates that by writing
    // the "concurrent winner"'s file to targetPath from inside the mocked
    // streamUploadToFile() call, i.e. after this request's own existsSync
    // check already passed.
    root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-route-"));
    backupsPath = path.join(root, "backups");
    fs.mkdirSync(backupsPath, { recursive: true });
    getActiveServer.mockResolvedValue({ isRemote: false });

    const body = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    streamUploadToFileMock.mockImplementationOnce(async (req, tmpPath) => {
      fs.writeFileSync(
        path.join(backupsPath, "uploaded-world.zip"),
        "concurrent winner",
      );
      fs.writeFileSync(tmpPath, body);
      return body.length;
    });

    const req = fakeRequest([body], {
      "content-type": "application/zip",
      "x-backup-filename": "world.zip",
    });
    req.app = makeApp({ getBackupsPath: async () => backupsPath });
    const response = createResponse();

    await getUploadHandler()(req, response);

    expect(response.status).toHaveBeenCalledWith(409);
    // The concurrent winner's file must survive untouched -- this
    // request's own (now-orphaned) upload must not clobber it.
    expect(
      fs.readFileSync(path.join(backupsPath, "uploaded-world.zip"), "utf8"),
    ).toBe("concurrent winner");
    // No leftover tmp file after the refusal.
    expect(fs.readdirSync(backupsPath)).toEqual(["uploaded-world.zip"]);
  });

  it("maps a size-limit rejection from streamUploadToFile() to 413", async () => {
    // The route's own MAX_UPLOAD_BYTES is 4 GB and not overridable from a
    // test -- exercising the real 413 path end-to-end would mean actually
    // sending 4 GB. server/tests/uploadStream.test.js already proves
    // streamUploadToFile() itself enforces an arbitrary limit correctly
    // against real streamed bytes; this test only needs to prove the
    // ROUTE maps that specific rejection code to a 413, so the one call
    // is mocked to reject the way the real function does on that path.
    root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-route-"));
    backupsPath = path.join(root, "backups");
    fs.mkdirSync(backupsPath, { recursive: true });
    getActiveServer.mockResolvedValue({ isRemote: false });

    const { UPLOAD_TOO_LARGE_CODE } = await vi.importActual(
      "../utils/uploadStream.js",
    );
    streamUploadToFileMock.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(new Error("Upload exceeds the configured size limit."), {
          code: UPLOAD_TOO_LARGE_CODE,
        }),
      ),
    );

    const req = fakeRequest([Buffer.from([0x50, 0x4b, 0x03, 0x04])], {
      "content-type": "application/zip",
      "x-backup-filename": "world.zip",
    });
    req.app = makeApp({ getBackupsPath: async () => backupsPath });
    const response = createResponse();

    await getUploadHandler()(req, response);

    expect(response.status).toHaveBeenCalledWith(413);
  });
});
