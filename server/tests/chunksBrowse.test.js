import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const getActiveServer = vi.fn();
const getSetting = vi.fn();

vi.mock("../database/init.js", () => ({
  getSetting,
  setSetting: vi.fn(),
  getActiveServer,
  updateServer: vi.fn(),
}));

const { copyChunkBackup, default: router } = await import("../routes/chunks.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getBrowseHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/browse" && entry.route.methods.get,
  );
  // Route-logic handler is always LAST in the stack: chunks.manage was
  // added in front of it (hunt-wave12, 2026-08-30, operator ruling to gate
  // the previously-unpermissioned reads), same shape
  // chunksRoutesCapability.test.js already documents for the gate itself
  // (stack[0]). This test exercises the business logic directly, bypassing
  // the gate -- chunksRoutesCapability.test.js is what proves the gate.
  return layer.route.stack.at(-1).handle;
}

describe("GET /api/chunks/browse", () => {
  let dataRoot;
  let insideDir;
  let outsideDir;

  beforeEach(() => {
    getActiveServer.mockReset();
    getSetting.mockReset();

    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-browse-data-"));
    insideDir = path.join(dataRoot, "Saves", "Multiplayer");
    fs.mkdirSync(insideDir, { recursive: true });
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-browse-outside-"));

    getActiveServer.mockResolvedValue({ zomboidDataPath: dataRoot });
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("allows browsing inside the configured zomboidDataPath", async () => {
    const response = createResponse();
    await getBrowseHandler()({ query: { path: insideDir } }, response);

    expect(response.status).not.toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ currentPath: insideDir }),
    );
  });

  it("rejects a path outside the configured zomboidDataPath", async () => {
    const response = createResponse();
    await getBrowseHandler()({ query: { path: outsideDir } }, response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringMatching(/access denied/i) }),
    );
  });

  it("rejects a traversal attempt that escapes via ..", async () => {
    const response = createResponse();
    const traversal = path.join(insideDir, "..", "..", "..", "..", "..", "etc");
    await getBrowseHandler()({ query: { path: traversal } }, response);

    expect(response.status).toHaveBeenCalledWith(403);
  });

  it("rejects browsing when no zomboidDataPath is configured", async () => {
    getActiveServer.mockResolvedValue(null);
    getSetting.mockResolvedValue(null);
    const response = createResponse();

    await getBrowseHandler()({ query: { path: outsideDir } }, response);

    expect(response.status).toHaveBeenCalledWith(400);
  });
});

describe("chunk backup safety", () => {
  let dataRoot;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-backup-data-"));
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("rejects a backup collision instead of allowing deletion to continue", async () => {
    const source = path.join(dataRoot, "chunk.bin");
    const destination = path.join(dataRoot, "backup.bin");
    fs.writeFileSync(source, "chunk");
    fs.writeFileSync(destination, "existing backup");

    await expect(copyChunkBackup(source, destination, true)).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  // vehicles audit (2026-10-28, R2-20): chunk files are the game server's to
  // write and backups/ is in the folder it shares, so a copy never follows a
  // link (or blocks on a FIFO) planted at either end.
  it("legit: copies a regular chunk file", async () => {
    const source = path.join(dataRoot, "chunk.bin");
    const destination = path.join(dataRoot, "backup.bin");
    fs.writeFileSync(source, "chunk bytes");

    await expect(copyChunkBackup(source, destination, true)).resolves.toBe(true);
    expect(fs.readFileSync(destination, "utf8")).toBe("chunk bytes");
  });

  it("skips a source that is not a regular file, like a missing one", async () => {
    const source = path.join(dataRoot, "0.bin");
    fs.mkdirSync(source);
    const destination = path.join(dataRoot, "backup.bin");

    await expect(copyChunkBackup(source, destination, true)).resolves.toBe(false);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("never copies through a symlinked chunk file", async () => {
    const secret = path.join(dataRoot, "jwt.secret");
    fs.writeFileSync(secret, "jwt-signing-secret");
    const source = path.join(dataRoot, "0.bin");
    fs.symlinkSync(secret, source);
    const destination = path.join(dataRoot, "backup.bin");

    await expect(copyChunkBackup(source, destination, true)).resolves.toBe(false);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("never writes through a symlink planted at the backup path", async () => {
    const source = path.join(dataRoot, "chunk.bin");
    fs.writeFileSync(source, "chunk bytes");
    const panelFile = path.join(dataRoot, "db.json");
    fs.writeFileSync(panelFile, "{}");
    const destination = path.join(dataRoot, "chunkdata_0_0.bin");
    fs.symlinkSync(panelFile, destination);

    await expect(copyChunkBackup(source, destination)).rejects.toMatchObject({ code: "ELOOP" });
    expect(fs.readFileSync(panelFile, "utf8")).toBe("{}");
  });

  it.skipIf(process.platform === "win32")("skips a FIFO without blocking", async () => {
    const { spawnSync } = await import("child_process");
    const source = path.join(dataRoot, "fifo.bin");
    expect(spawnSync("mkfifo", [source]).status).toBe(0);

    await expect(copyChunkBackup(source, path.join(dataRoot, "backup.bin"), true)).resolves.toBe(false);
  }, 10000);
});
