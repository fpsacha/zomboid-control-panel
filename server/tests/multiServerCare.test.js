import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServer,
  deleteServer,
  getSetting,
  logScheduleExecution,
  getLatestScheduleExecutionByCommand,
  recordPlayerSession,
  setSetting,
} from "../database/init.js";
import { hostMemoryLimitBytes, readProcessesMemory } from "../utils/processMemory.js";
import { DiskMonitor } from "../services/diskMonitor.js";
import { Scheduler, selectScheduledBackupServers } from "../services/scheduler.js";
import { autoStartOtherServers, parseAutoStartDelaySeconds } from "../index.js";

// Running several servers on one machine: their memory against the host's,
// the wait between auto-started launches, every server's disk, play time on
// servers other than the active one, and the scheduled backup of each
// chosen server, written to Schedule History under that server.

const { default: configRouter } = await import("../routes/config.js");
const { default: backupRouter } = await import("../routes/backup.js");

function handler(router, routePath, method) {
  const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function call(fn, req) {
  let statusCode = 200;
  let body = null;
  const res = {
    status(code) { statusCode = code; return res; },
    json(payload) { body = payload; return res; },
  };
  await fn({ app: { get: () => undefined }, user: null, query: {}, ...req }, res);
  return { statusCode, body };
}

describe("hostMemoryLimitBytes()", () => {
  it("is the container's cgroup limit when lower than the machine, the machine's memory otherwise", () => {
    const GB = 1024 ** 3;
    expect(hostMemoryLimitBytes({ totalmem: () => 32 * GB, readFile: (f) => (f.endsWith("memory.max") ? 8 * GB : null) })).toBe(8 * GB);
    expect(hostMemoryLimitBytes({ totalmem: () => 32 * GB, readFile: () => null })).toBe(32 * GB);
    // v1's "no limit" is a huge number.
    expect(hostMemoryLimitBytes({ totalmem: () => 32 * GB, readFile: () => 2 ** 62 })).toBe(32 * GB);
  });
});

describe("readProcessesMemory()", () => {
  it("reads nothing for PIDs that aren't PIDs", async () => {
    expect((await readProcessesMemory([null, "abc", -3, 0])).size).toBe(0);
  });
});

describe("the wait between auto-started servers", () => {
  it("parses whole seconds up to 10 minutes, and 0 for anything else", () => {
    expect(parseAutoStartDelaySeconds(30)).toBe(30);
    expect(parseAutoStartDelaySeconds("45")).toBe(45);
    for (const bad of [-1, 601, 1.5, "x", null]) expect(parseAutoStartDelaySeconds(bad)).toBe(0);
  });

  it("waits between launches, not before the first one or after a server that was already up", async () => {
    const events = [];
    const manager = { getServerProcessDetails: async () => ({ running: false, scanFailed: false }) };
    const servers = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }];
    await autoStartOtherServers(servers, {
      createManager: async () => manager,
      acquireLock: () => ({ release: () => {} }),
      start: async (server) => {
        events.push(`start ${server.id}`);
        return { success: true, alreadyRunning: server.id === "b" };
      },
      sleep: async (ms) => events.push(`wait ${ms}`),
      delayMs: 30000,
    });
    expect(events).toEqual(["start a", "wait 30000", "start b", "wait 30000", "start c"]);
  });

  it("is a setting of 0 to 600 seconds", async () => {
    const put = handler(configRouter, "/app-settings", "put");
    const original = await getSetting("autoStartDelaySeconds");
    try {
      expect((await call(put, { body: { settings: { autoStartDelaySeconds: 90 } } })).statusCode).toBe(200);
      expect(await getSetting("autoStartDelaySeconds")).toBe(90);
      const refused = await call(put, { body: { settings: { autoStartDelaySeconds: 601 } } });
      expect(refused.statusCode).toBe(400);
      expect(refused.body.code).toBe("CONFIG_INVALID_NUMERIC_FIELD");
    } finally {
      await setSetting("autoStartDelaySeconds", original);
    }
  });
});

describe("DiskMonitor.checkServers()", () => {
  it("reads every local server's data folder once per folder, with no path in what it keeps", async () => {
    const getStatus = vi.fn(async (p) => ({ ok: true, path: p, usedPercent: 91, freeBytes: 5, warning: true, critical: false }));
    const monitor = new DiskMonitor(null, {
      resolvePath: async () => null,
      getStatus,
      listServers: async () => [
        { id: "a", zomboidDataPath: "/data/one" },
        { id: "b", zomboidDataPath: "/data/one" },
        { id: "c", zomboidDataPath: "/data/two", isRemote: true },
        { id: "d" },
      ],
    });
    const statuses = await monitor.checkServers();

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual({
      a: { usedPercent: 91, freeBytes: 5, warning: true, critical: false },
      b: { usedPercent: 91, freeBytes: 5, warning: true, critical: false },
    });
  });
});

describe("recordPlayerSession({ keepOpenSession })", () => {
  it("continues a session already open instead of starting it over", async () => {
    const first = await recordPlayerSession("KeepOpenTester", "connect", "keep-open-server");
    const startedAt = first.last_session_start;
    await new Promise((r) => setTimeout(r, 5));
    const again = await recordPlayerSession("KeepOpenTester", "connect", "keep-open-server", { keepOpenSession: true });
    expect(again.last_session_start).toBe(startedAt);
    expect(again.session_count).toBe(1);
    await recordPlayerSession("KeepOpenTester", "disconnect", "keep-open-server");
  });
});

describe("the scheduled backup of each chosen server", () => {
  it("picks the chosen local servers, the active one first", () => {
    const servers = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C", isRemote: true },
      { id: "d", name: "D" },
    ];
    expect(
      selectScheduledBackupServers({ serverIds: ["d", "b", "c"], servers, activeServer: { id: "b" } }).map((s) => s.id),
    ).toEqual(["b", "d"]);
  });

  it("backs up each chosen server under its own name in Schedule History, and only the active one without a choice", async () => {
    const scheduler = new Scheduler({}, {});
    const createBackup = vi.fn(async ({ server }) => ({ success: true, backup: { name: `${server?.id ?? "active"}.zip` } }));
    scheduler.backupService = { createBackup };
    const one = await createServer({ name: "BackupOne", serverName: "BackupOne" });
    const two = await createServer({ name: "BackupTwo", serverName: "BackupTwo" });
    try {
      await scheduler._runScheduledBackup({ includeDb: false, serverIds: [String(two.id), String(one.id)] });
      const backedUp = createBackup.mock.calls.map(([options]) => String(options.server.id));
      expect(new Set(backedUp)).toEqual(new Set([String(one.id), String(two.id)]));
      const row = await getLatestScheduleExecutionByCommand("backup", two.id);
      expect(row.message).toContain(`${two.id}.zip`);

      createBackup.mockClear();
      await scheduler._runScheduledBackup({ includeDb: false, serverIds: null });
      expect(createBackup).toHaveBeenCalledTimes(1);
      expect(createBackup.mock.calls[0][0].server).toBeUndefined();
    } finally {
      await deleteServer(one.id).catch(() => {});
      await deleteServer(two.id).catch(() => {});
    }
  });

  // A restart never waits for a backup: one that begins while the first
  // server is zipped must hold the next server's backup, not fail it.
  it("waits for a restart that began during an earlier server's backup before the next one", async () => {
    const scheduler = new Scheduler({}, {});
    const order = [];
    const createBackup = vi.fn(async ({ server }) => {
      order.push(`backup:${server.name}:${scheduler.restartInProgress ? "mid-restart" : "clear"}`);
      // Another server's restart starts while this one is zipped.
      if (server.name === "HoldOne") scheduler.restartInProgress = true;
      return { success: true, backup: { name: `${server.id}.zip` } };
    });
    scheduler.backupService = { createBackup, getSettings: vi.fn(async () => ({ enabled: true })) };
    scheduler.sleep = vi.fn(async () => {
      order.push("wait");
      scheduler.restartInProgress = false;
    });
    const one = await createServer({ name: "HoldOne", serverName: "HoldOne" });
    const two = await createServer({ name: "HoldTwo", serverName: "HoldTwo" });
    try {
      await scheduler._runScheduledBackup({ includeDb: false, serverIds: [String(one.id), String(two.id)] });
      expect(order).toEqual(["backup:HoldOne:clear", "wait", "backup:HoldTwo:clear"]);
    } finally {
      await deleteServer(one.id).catch(() => {});
      await deleteServer(two.id).catch(() => {});
    }
  });

  it("reads Schedule History per server", async () => {
    await logScheduleExecution(null, "Scheduled Backup", "backup", false, "other failed", 1, { serverId: "history-other" });
    await logScheduleExecution(null, "Scheduled Backup", "backup", true, "mine ok", 1, { serverId: "history-mine" });
    expect((await getLatestScheduleExecutionByCommand("backup", "history-other")).message).toBe("other failed");
    expect((await getLatestScheduleExecutionByCommand("backup")).message).toBe("mine ok");
  });

  it("stores the chosen servers from the backup settings, refuses anything else, and summarizes per server", async () => {
    const post = handler(backupRouter, "/settings", "post");
    const original = await getSetting("backupServerIds");
    const backupService = {
      updateSettings: vi.fn(async (s) => s),
      getSettings: vi.fn(async () => ({ enabled: true, serverIds: ["x"] })),
    };
    const app = { get: (key) => (key === "backupService" ? backupService : undefined) };
    try {
      const ok = await call(post, { app, body: { serverIds: ["x", 7] } });
      expect(ok.statusCode).toBe(200);
      expect(backupService.updateSettings).toHaveBeenCalledWith({ serverIds: ["x", 7] });

      const refused = await call(post, { app, body: { serverIds: "x" } });
      expect(refused.statusCode).toBe(400);
      expect(refused.body.code).toBe("BACKUP_SERVER_IDS_INVALID");

      const summary = await call(handler(backupRouter, "/summary", "get"), { app });
      expect(summary.statusCode).toBe(200);
      expect(summary.body.schedule).toEqual({ enabled: true, serverIds: ["x"] });
      expect(Array.isArray(summary.body.servers)).toBe(true);
    } finally {
      await setSetting("backupServerIds", original);
    }
  });

  it("drops a deleted server from the list", async () => {
    const gone = await createServer({ name: "BackupGone", serverName: "BackupGone" });
    await setSetting("backupServerIds", [String(gone.id), "kept"]);
    await deleteServer(gone.id);
    expect(await getSetting("backupServerIds")).toEqual(["kept"]);
    await setSetting("backupServerIds", undefined);
  });
});

afterEach(() => vi.restoreAllMocks());
