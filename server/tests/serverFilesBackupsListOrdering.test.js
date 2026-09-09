import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { parseAnyBackupFilename } from "../utils/configBackup.js";

// display-order-tie-breaks-nine-sites-cosmetic, 2026-09-09: GET /backups
// (server/routes/serverFiles.js) used to sort by fs birthtime alone --
// the exact method utils/configBackup.js's listBackupsFor() documents as
// unsafe over this same directory (real same-millisecond ext4 collisions
// confirmed; see that file's own comment on listBackupsFor). Now sorts by
// each backup's own embedded timestamp + collision suffix instead, via
// the new parseAnyBackupFilename() export, matching createBackup()'s own
// collision semantics: a higher suffix on an identical timestamp means
// created later, regardless of what the filesystem's own birthtime says.

describe("parseAnyBackupFilename()", () => {
  it("parses a plain (no-collision) backup name", () => {
    expect(parseAnyBackupFilename("server.ini.2026-09-09T22-15-30-123Z.bak")).toEqual({
      originalFilename: "server.ini",
      timestampKey: "2026-09-09T22-15-30-123Z",
      suffix: 1,
    });
  });

  it("parses a collision-suffixed backup name", () => {
    expect(parseAnyBackupFilename("server.ini.2026-09-09T22-15-30-123Z-2.bak")).toEqual({
      originalFilename: "server.ini",
      timestampKey: "2026-09-09T22-15-30-123Z",
      suffix: 2,
    });
  });

  it("handles an original filename that itself contains dots", () => {
    expect(parseAnyBackupFilename("TestServer_SandboxVars.lua.2026-09-09T22-15-30-123Z.bak")).toEqual({
      originalFilename: "TestServer_SandboxVars.lua",
      timestampKey: "2026-09-09T22-15-30-123Z",
      suffix: 1,
    });
  });

  it("returns null for a name that doesn't match the createBackup() naming convention", () => {
    expect(parseAnyBackupFilename("not-a-real-backup.bak")).toBeNull();
    expect(parseAnyBackupFilename("server.ini.bak")).toBeNull();
  });
});

const getActiveServer = vi.fn();
const getAllSettings = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings,
}));

vi.mock("../services/remoteConfigFiles.js", () => ({
  SFTP_CONFIG_PATH_KEY: "panelBridgeSftpConfigPath",
  acquireMirrorLock: vi.fn(),
  beginRemoteConfigSession: vi.fn(),
  getMirrorPath: vi.fn(),
  isRemoteConfigConfigured: vi.fn(() => false),
  pushRemoteConfigFiles: vi.fn(),
  validateRemoteConfigTransport: vi.fn(),
}));

const { default: router } = await import("../routes/serverFiles.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getGateMiddleware() {
  return router.stack.filter((entry) => !entry.route)[1].handle;
}

async function runHandler(routePath, method, req) {
  const res = createResponse();
  await getGateMiddleware()(req, res, () => {});
  await getHandler(routePath, method)(req, res, () => {});
  return res;
}

describe("GET /backups: orders by each backup's own embedded timestamp, not fs birthtime", () => {
  let tmpDir;
  let backupDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-backups-order-"));
    backupDir = path.join(tmpDir, "backups");
    fs.mkdirSync(backupDir);
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue({
      serverConfigPath: tmpDir,
      serverName: "TestServer",
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ranks the higher collision suffix as newer even when its real fs birthtime is EARLIER than the plain file's", async () => {
    // birthtime is deliberately mocked to the OPPOSITE of what createBackup()
    // itself would ever produce on disk (the plain file always precedes a
    // collision in real write order) and deliberately made platform/timing-
    // independent -- alphabetically AND by any incidental disk-write speed,
    // "-2.bak" already sorts before ".bak" (a stray break-verify finding:
    // an earlier, unmocked version of this test passed against the pre-fix
    // code for that reason alone, not because the fix worked. Controlling
    // birthtime explicitly is what makes this test actually discriminate).
    const collisionName = "server.ini.2026-09-09T22-15-30-123Z-2.bak";
    const plainName = "server.ini.2026-09-09T22-15-30-123Z.bak";
    fs.writeFileSync(path.join(backupDir, collisionName), "collision content");
    fs.writeFileSync(path.join(backupDir, plainName), "plain content");

    const realStat = fs.promises.stat.bind(fs.promises);
    const statSpy = vi.spyOn(fs.promises, "stat").mockImplementation(async (p) => {
      const real = await realStat(p);
      if (String(p).endsWith(collisionName)) {
        return { ...real, birthtime: new Date("2020-01-01T00:00:00.000Z") };
      }
      if (String(p).endsWith(plainName)) {
        return { ...real, birthtime: new Date("2029-01-01T00:00:00.000Z") };
      }
      return real;
    });

    try {
      const res = await runHandler("/backups", "get", {});

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          backups: [
            expect.objectContaining({ filename: collisionName }),
            expect.objectContaining({ filename: plainName }),
          ],
        }),
      );
    } finally {
      statSpy.mockRestore();
    }
  });

  it("orders two different timestamps correctly regardless of collision suffix", async () => {
    const older = "server.ini.2026-09-09T20-00-00-000Z.bak";
    const newer = "server.ini.2026-09-09T22-00-00-000Z-3.bak";
    fs.writeFileSync(path.join(backupDir, older), "old");
    fs.writeFileSync(path.join(backupDir, newer), "new");

    const res = await runHandler("/backups", "get", {});

    const payload = res.json.mock.calls[0][0];
    expect(payload.backups.map((b) => b.filename)).toEqual([newer, older]);
  });

  it("falls back gracefully for a file that doesn't match the naming convention, without crashing", async () => {
    const real = "server.ini.2026-09-09T22-00-00-000Z.bak";
    const foreign = "hand-placed.bak";
    fs.writeFileSync(path.join(backupDir, real), "real");
    fs.writeFileSync(path.join(backupDir, foreign), "foreign");

    const res = await runHandler("/backups", "get", {});

    const payload = res.json.mock.calls[0][0];
    expect(payload.backups.map((b) => b.filename).sort()).toEqual(
      [real, foreign].sort(),
    );
    // Never leaks the internal sort-key field onto the wire.
    for (const backup of payload.backups) {
      expect(backup._parsed).toBeUndefined();
    }
  });
});
