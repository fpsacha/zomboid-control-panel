import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// path-resolution sweep, 2026-09-06: /wipe and /wipe/preview derived their
// delete target (and, via serverManager.getServerProcessDetails(), their
// "server must be stopped" safety check) from serverManager.savePath /
// serverManager.serverName -- fields that only ever change on an explicit
// serverManager.reloadConfig() call (servers.js's /:id/activate and PUT
// /servers/:id, both of which treat a reload failure as best-effort: the
// active-server DB write is never rolled back, only a warning is added to
// the response -- see servers.js:1706-1710's own comment). Meanwhile
// backupService.js's getSavesPath()/getBackupsPath() -- used by /wipe's own
// mandatory pre-wipe backup -- independently re-read getActiveServer()
// fresh from the DB on every call, with no dependency on serverManager at
// all. Same conceptual value ("the active server's save path"), two
// completely different refresh mechanisms: this is bbde44a9's shape.
//
// The two real temp trees below stand in for "server A" (what a stale
// serverManager still thinks is active, after an earlier reloadConfig()
// silently failed) and "server B" (what getActiveServer() -- and therefore
// backupService -- correctly reports as active right now). Before the fix,
// this reproduces the worst-case pairing: the pre-wipe backup faithfully
// backs up B (never touched by the wipe), while the actual delete destroys
// A (never backed up in this operation) -- a destructive route whose entire
// safety story is "we took a backup first" backing up the wrong world.

const getActiveServerMock = vi.fn();
const addBackupRecordMock = vi.fn(async () => {});

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(async () => {}),
  setSetting: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  getActiveServer: getActiveServerMock,
  getLatestScheduleExecutionByCommand: vi.fn(async () => null),
  flushWrites: vi.fn(async () => {}),
}));

vi.mock("../services/backupRecords.js", () => ({
  addBackupRecord: addBackupRecordMock,
  removeBackupRecord: vi.fn(async () => {}),
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { default: router } = await import("../routes/server.js");
const { BackupService } = await import("../services/backupService.js");

const SERVER_A = "ServerA";
const SERVER_B = "ServerB";

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

let rootA;
let rootB;
let saveDirA;
let saveDirB;

beforeEach(() => {
  rootA = fs.mkdtempSync(path.join(os.tmpdir(), "pz-wipe-stale-a-"));
  rootB = fs.mkdtempSync(path.join(os.tmpdir(), "pz-wipe-fresh-b-"));
  saveDirA = path.join(rootA, "Saves", "Multiplayer", SERVER_A);
  saveDirB = path.join(rootB, "Saves", "Multiplayer", SERVER_B);
  fs.mkdirSync(path.join(saveDirA, "map"), { recursive: true });
  fs.writeFileSync(path.join(saveDirA, "map", "0_0.bin"), "A-live-chunk");
  fs.mkdirSync(path.join(saveDirB, "map"), { recursive: true });
  fs.writeFileSync(path.join(saveDirB, "map", "0_0.bin"), "B-live-chunk");

  // getActiveServer() -- and therefore backupService -- always reports B:
  // the DB's real, currently-active server.
  getActiveServerMock.mockReset();
  getActiveServerMock.mockResolvedValue({
    id: "server-b",
    name: SERVER_B,
    serverName: SERVER_B,
    zomboidDataPath: rootB,
  });
  addBackupRecordMock.mockReset();
  addBackupRecordMock.mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(rootA, { recursive: true, force: true });
  fs.rmSync(rootB, { recursive: true, force: true });
});

// Stale serverManager stub: still configured for A (as if an earlier
// reloadConfig() during activation to B silently failed, per
// servers.js:1706-1710's documented best-effort posture), and its own
// loadConfig() is the REAL guarded no-op (mirrors serverManager.js:525's
// `if (this.configLoaded) return;`) -- calling it does not self-heal.
function buildStaleServerManager({ reloadThrows = false } = {}) {
  const manager = {
    configLoaded: true,
    savePath: rootA,
    serverName: SERVER_A,
    loadConfig: async () => {
      /* real behavior once configLoaded: a no-op, does not re-read the DB */
    },
    getServerProcessDetails: async () => ({
      running: false,
      scanFailed: false,
    }),
  };
  manager.reloadConfig = vi.fn(async () => {
    if (reloadThrows) {
      throw new Error("simulated: reloadConfig failed, same as servers.js:1706-1710's documented case");
    }
    // A successful reload catches the manager up to the real active server.
    manager.savePath = rootB;
    manager.serverName = SERVER_B;
  });
  return manager;
}

function buildRealBackupService() {
  const service = new BackupService();
  return service;
}

describe("POST /api/server/wipe derives its target from the same fresh source as its pre-wipe backup", () => {
  it("wipes B (the real active server) and never touches A, when serverManager successfully catches up via reloadConfig()", async () => {
    const serverManager = buildStaleServerManager({ reloadThrows: false });
    const backupService = buildRealBackupService();
    const app = {
      get: (key) => {
        if (key === "serverManager") return serverManager;
        if (key === "backupService") return backupService;
        return undefined;
      },
    };

    const handler = getHandler("/wipe", "post");
    const response = createResponse();
    await handler(
      { app, body: { targets: ["map"], confirm: true, createBackup: true } },
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, backupCreated: true }),
    );
    // The real, currently-active server (B) is what got wiped...
    expect(fs.existsSync(path.join(saveDirB, "map", "0_0.bin"))).toBe(false);
    // ...and A, which a stale manager used to target, was never touched.
    expect(fs.existsSync(path.join(saveDirA, "map", "0_0.bin"))).toBe(true);
    // The pre-wipe backup landed under B's own backups folder -- backup and
    // delete agree on which server they're operating on.
    const backupsDir = path.join(rootB, "backups");
    const backups = fs.existsSync(backupsDir)
      ? fs.readdirSync(backupsDir).filter((f) => f.endsWith(".zip"))
      : [];
    expect(backups.length).toBe(1);
  });

  it("refuses to wipe (fails closed) instead of silently acting on stale state when reloadConfig() fails", async () => {
    const serverManager = buildStaleServerManager({ reloadThrows: true });
    const backupService = buildRealBackupService();
    const app = {
      get: (key) => {
        if (key === "serverManager") return serverManager;
        if (key === "backupService") return backupService;
        return undefined;
      },
    };

    const handler = getHandler("/wipe", "post");
    const response = createResponse();
    await handler(
      { app, body: { targets: ["map"], confirm: true, createBackup: true } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
    );
    // Neither server was touched -- refusing beats guessing.
    expect(fs.existsSync(path.join(saveDirA, "map", "0_0.bin"))).toBe(true);
    expect(fs.existsSync(path.join(saveDirB, "map", "0_0.bin"))).toBe(true);
  });
});

describe("POST /api/server/wipe/preview previews the same fresh server the wipe itself would target", () => {
  it("previews B's directory, not A's, when serverManager successfully catches up via reloadConfig()", async () => {
    const serverManager = buildStaleServerManager({ reloadThrows: false });
    const app = {
      get: (key) => (key === "serverManager" ? serverManager : undefined),
    };

    const handler = getHandler("/wipe/preview", "post");
    const response = createResponse();
    await handler({ app, body: { targets: ["map"] } }, response);

    expect(response.status).not.toHaveBeenCalledWith(404);
    const [body] = response.json.mock.calls[response.json.mock.calls.length - 1];
    // The discriminating fact: which directory got scanned. An operator
    // acting on this preview believing it describes "the active server"
    // must see B's saveDir, not A's stale one.
    expect(body.saveDir).toBe(saveDirB);
    expect(body.preview?.map?.files).toBe(1);
  });

  it("refuses to preview (fails closed) instead of previewing stale state when reloadConfig() fails", async () => {
    const serverManager = buildStaleServerManager({ reloadThrows: true });
    const app = {
      get: (key) => (key === "serverManager" ? serverManager : undefined),
    };

    const handler = getHandler("/wipe/preview", "post");
    const response = createResponse();
    await handler({ app, body: { targets: ["map"] } }, response);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
    );
  });
});
