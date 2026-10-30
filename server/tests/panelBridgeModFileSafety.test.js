import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// SECURITY (2026-10-28): the bridge folder belongs to the game server's
// account, which is not always the panel's (a game on the host, or in another
// container, sharing its Zomboid folder with the panel's container).
// - readModFileCapped took the size from a stat of the path, then read the
//   path to its end in a second open: a file swapped or grown in between, a
//   symlink to /dev/zero or a pipe was read without limit.
// - A consumed result was emptied with writeFileSync(resultFile, ''), which
//   follows a symlink (or shares a hard link's data): a res-N file linked to
//   db.json emptied db.json.
// - The panel's own temporary files there (inbox cmd-N.json.tmp, queue state)
//   were written through whatever already sat at that name.
// - The inbox cursor and GET /scan-paths' status.json were read whole with no
//   size limit at all.

const LIMIT = 16 * 1024 * 1024;

const getActiveServer = vi.fn(async () => null);
vi.mock("../database/init.js", () => ({
  getActiveServer,
  getServer: vi.fn(),
  getAllSettings: vi.fn(async () => ({})),
  setSetting: vi.fn(),
  getDb: vi.fn(),
  commitNow: vi.fn(),
  logBridgeCommand: vi.fn(async () => {}),
  getRoleByName: vi.fn(async () => ({ capabilities: [] })),
  logPlayerAction: vi.fn(async () => ({})),
  recordPlayerSession: vi.fn(async () => ({})),
  logServerEvent: vi.fn(async () => ({})),
  applySuspendGapToInFlightSessions: vi.fn(async () => {}),
}));

const { PanelBridge, readModFileCapped } = await import("../services/panelBridge.js");
const { default: router } = await import("../routes/panelBridge.js");
const { writeModFileNoFollow } = await import("../utils/bridgeModFile.js");

function writeOversized(file, head = '{"lastProcessedSeq":5,"pad":"') {
  const fd = fs.openSync(file, "w");
  fs.writeSync(fd, head);
  fs.ftruncateSync(fd, LIMIT + 1);
  fs.closeSync(fd);
}

function canSymlink(dir) {
  try {
    fs.symlinkSync(path.join(dir, "nowhere"), path.join(dir, ".probe"));
    fs.rmSync(path.join(dir, ".probe"));
    return true;
  } catch {
    return false;
  }
}

describe("bridge files: one descriptor, no links, a hard cap", () => {
  let dir;
  let outside;
  let bridge;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-modfile-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-outside-"));
    fs.mkdirSync(path.join(dir, "outbox"), { recursive: true });
    fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
    bridge = new PanelBridge();
    bridge.configure(dir, true);
    bridge.ensureQueueProtocol();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    bridge.stop?.();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const resultPath = (seq) => path.join(dir, "outbox", `res-${String(seq).padStart(10, "0")}.json.txt`);

  it("stops reading at the limit when the size it was told is wrong", () => {
    const file = path.join(dir, "status.json.txt");
    writeOversized(file, '{"version":"1.7.78","pad":"');
    const small = { size: 10, isFile: () => true, nlink: 1, mtimeMs: Date.now() };
    const realStat = fs.statSync;
    const realFstat = fs.fstatSync;
    vi.spyOn(fs, "statSync").mockImplementation((p, ...rest) => (path.resolve(String(p)) === file ? { ...realStat(p, ...rest), size: 10 } : realStat(p, ...rest)));
    vi.spyOn(fs, "fstatSync").mockImplementation((fd, ...rest) => ({ ...realFstat(fd, ...rest), ...small }));

    expect(() => readModFileCapped(file)).toThrow(expect.objectContaining({ code: "BRIDGE_FILE_TOO_LARGE" }));
  });

  it("never empties what a hard-linked result file shares, and moves past it", () => {
    const database = path.join(outside, "db.json");
    const original = JSON.stringify({ result: { id: "not-a-command" }, users: ["admin"] });
    fs.writeFileSync(database, original);
    const seq = bridge.queueState.lastConsumedResultSeq + 1;
    fs.linkSync(database, resultPath(seq));

    bridge.pollQueueResults();

    expect(fs.readFileSync(database, "utf8")).toBe(original);
    expect(bridge.queueState.lastConsumedResultSeq).toBe(seq);
  });

  it("moves past a directory sitting at a result file's name instead of stalling on it", () => {
    const seq = bridge.queueState.lastConsumedResultSeq + 1;
    fs.mkdirSync(resultPath(seq));
    fs.writeFileSync(resultPath(seq + 1), JSON.stringify({ protocolVersion: "queue-v1", seq: seq + 1, result: { id: "nobody" } }));

    bridge.pollQueueResults();

    expect(bridge.queueState.lastConsumedResultSeq).toBe(seq + 1);
  });

  it("does not write a queued command through a link left at its temporary name", () => {
    const target = path.join(outside, "victim.json");
    fs.writeFileSync(target, '{"keep":true}');
    const seq = bridge.queueState.nextCommandSeq;
    fs.linkSync(target, `${bridge.getCommandFileBySeq(seq)}.tmp`);

    bridge._enqueueCommand("id-1", "ping", {});

    expect(fs.readFileSync(target, "utf8")).toBe('{"keep":true}');
    expect(JSON.parse(fs.readFileSync(bridge.getCommandFileBySeq(seq), "utf8"))).toMatchObject({ id: "id-1" });
  });

  it("does not empty or overwrite what a hard link at a directly written name shares", () => {
    const database = path.join(outside, "db.json");
    fs.writeFileSync(database, '{"users":["admin"]}');
    const stateFile = path.join(dir, "queue-state.json");
    fs.linkSync(database, stateFile);

    expect(() => writeModFileNoFollow(stateFile, '{"seq":1}')).toThrow(expect.objectContaining({ code: "BRIDGE_FILE_NOT_REGULAR" }));
    expect(fs.readFileSync(database, "utf8")).toBe('{"users":["admin"]}');
  });

  it("still writes a plain file at a directly written name, shorter than before", () => {
    const stateFile = path.join(dir, "queue-state.json");
    fs.writeFileSync(stateFile, '{"seq":12345,"pad":"xxxxxxxx"}');
    writeModFileNoFollow(stateFile, '{"seq":1}');
    expect(fs.readFileSync(stateFile, "utf8")).toBe('{"seq":1}');
  });

  it("does not read an oversized inbox cursor", () => {
    const cursor = path.join(dir, "inbox", "cursor.json.txt");
    writeOversized(cursor);
    const reads = vi.spyOn(fs, "readFileSync");

    bridge.cleanupInboxFiles();

    expect(reads.mock.calls.filter(([p]) => path.resolve(String(p)) === path.resolve(cursor))).toHaveLength(0);
  });

  describe("with symlinks", () => {
    it("refuses a result file that is a symlink, leaves its target alone, and moves on", (ctx) => {
      if (!canSymlink(dir)) ctx.skip();
      const database = path.join(outside, "db.json");
      const original = JSON.stringify({ result: { id: "not-a-command" } });
      fs.writeFileSync(database, original);
      const seq = bridge.queueState.lastConsumedResultSeq + 1;
      fs.symlinkSync(database, resultPath(seq));

      bridge.pollQueueResults();

      expect(fs.readFileSync(database, "utf8")).toBe(original);
      expect(bridge.queueState.lastConsumedResultSeq).toBe(seq);
    });

    // Adversary pass: a device reports size 0, so a stat-only cap passes it.
    it("refuses a status file linked to a device", (ctx) => {
      if (!canSymlink(dir) || !fs.existsSync("/dev/zero")) ctx.skip();
      const status = path.join(dir, "status.json.txt");
      fs.symlinkSync("/dev/zero", status);
      expect(() => readModFileCapped(status)).toThrow(expect.objectContaining({ code: "BRIDGE_FILE_NOT_REGULAR" }));
    });
  });
});

describe("GET /scan-paths caps the status files it finds", () => {
  let zomboid;

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(zomboid, { recursive: true, force: true });
  });

  it("does not read an oversized status.json, and still lists the bridge", async () => {
    zomboid = fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-scan-"));
    const serverDir = path.join(zomboid, "Lua", "panelbridge", "Srv");
    fs.mkdirSync(serverDir, { recursive: true });
    const status = path.join(serverDir, "status.json");
    writeOversized(status, '{"version":"1.7.78","pad":"');
    getActiveServer.mockResolvedValue({ zomboidDataPath: path.join(zomboid, "Lua") });
    const reads = vi.spyOn(fs, "readFileSync");

    const layer = router.stack.find((entry) => entry.route?.path === "/scan-paths" && entry.route.methods.get);
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    await layer.route.stack[layer.route.stack.length - 1].handle({ user: { role: "admin" } }, res, () => {});

    expect(reads.mock.calls.filter(([p]) => path.resolve(String(p)) === path.resolve(status))).toHaveLength(0);
    const payload = res.json.mock.calls[0][0];
    const found = JSON.stringify(payload);
    expect(found).toContain("Srv");
  });
});
