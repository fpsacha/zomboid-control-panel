import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// SECURITY (2026-10-28): copyRemote checked the 16 MB limit against the size
// a separate stat returned, then called fastGet, which copies as many bytes
// as the host reports when it opens the file. A hostile or compromised SFTP
// host (or a file that grew in between) could fill the panel's disk through
// panelbridge-sftp-cache, up to 100 outbox files per sync. The limit is now
// held on the transfer itself.

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { PanelBridgeSftpTransport, validateSftpBridgeConfig } = await import("../services/panelBridgeSftp.js");

const LIMIT = 16 * 1024 * 1024;
const config = {
  host: "pz.example.net",
  port: 22,
  username: "panelbridge",
  password: "not-a-real-secret",
  bridgePath: "/home/pz/Zomboid/Lua/panelbridge/Remote",
  pollIntervalSeconds: 3,
};

const temporaryDirectories = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// fastGet as ssh2 runs it: chunk after chunk of the size the host gives at
// open time, calling opts.step(total, chunk, fileSize) after each write. A
// dropped connection (client.client.destroy) fails the transfer.
function transportWithRemote({ statSize, openSize, honoursStep = true }) {
  const cachePath = fs.mkdtempSync(path.join(os.tmpdir(), "pz-sftp-download-cap-"));
  temporaryDirectories.push(cachePath);
  const transport = new PanelBridgeSftpTransport();
  transport.config = validateSftpBridgeConfig(config);
  transport.cachePath = cachePath;
  const connection = { destroyed: false, destroy() { this.destroyed = true; } };
  const chunk = Buffer.alloc(1024 * 1024, 120);
  transport.client = {
    client: connection,
    exists: vi.fn(async () => "-"),
    stat: vi.fn(async () => ({ size: statSize })),
    fastGet: vi.fn(async (_remote, localPath, opts) => {
      const fd = fs.openSync(localPath, "w");
      try {
        let total = 0;
        while (total < openSize) {
          if (connection.destroyed) throw new Error("Unexpected close");
          const length = Math.min(chunk.length, openSize - total);
          fs.writeSync(fd, chunk, 0, length);
          total += length;
          if (honoursStep) opts?.step?.(total, length, openSize);
        }
      } finally {
        fs.closeSync(fd);
      }
    }),
  };
  return { transport, cachePath, connection };
}

function filesIn(directory) {
  return fs.readdirSync(directory, { recursive: true }).filter((name) => fs.statSync(path.join(directory, name)).isFile());
}

describe("PanelBridgeSftpTransport.copyRemote holds the 16 MB limit on the transfer", () => {
  it("stops a file the host said was small but sends as 64 MB, and keeps nothing of it", async () => {
    const { transport, cachePath, connection } = transportWithRemote({ statSize: 10, openSize: 64 * 1024 * 1024 });

    await expect(transport.copyRemote("status.json.txt")).rejects.toThrow("download limit");
    expect(connection.destroyed).toBe(true);
    expect(transport.client).toBeNull();
    expect(filesIn(cachePath)).toEqual([]);
  });

  // Adversary pass: a transfer that never reports its progress.
  it("still refuses the result when the transfer reports no progress", async () => {
    const { transport, cachePath } = transportWithRemote({ statSize: 10, openSize: LIMIT + 1, honoursStep: false });

    await expect(transport.copyRemote("outbox/res-0000000001.json.txt")).rejects.toThrow("download limit");
    expect(filesIn(cachePath)).toEqual([]);
  });

  it("removes the partial download when the transfer fails for another reason", async () => {
    const { transport, cachePath } = transportWithRemote({ statSize: 10, openSize: 10 });
    transport.client.fastGet = vi.fn(async (_remote, localPath) => {
      fs.writeFileSync(localPath, "partial");
      throw new Error("connection reset");
    });

    await expect(transport.copyRemote("status.json.txt")).rejects.toThrow("connection reset");
    expect(filesIn(cachePath)).toEqual([]);
  });

  it("downloads a file of exactly 16 MB", async () => {
    const { transport, cachePath } = transportWithRemote({ statSize: LIMIT, openSize: LIMIT });

    await expect(transport.copyRemote("status.json.txt")).resolves.toBe(true);
    expect(fs.statSync(path.join(cachePath, "status.json.txt")).size).toBe(LIMIT);
  });
});
