import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Regression: server/routes/mods.js had an 18-route family (19 including
// resolve-orphan-workshop, which a route-name-based audit missed) that fully
// replaced the live Mods=/WorkshopItems=/Map= ini lines with NO backup
// anywhere, while server/routes/serverFiles.js -- one file over -- backed up
// every equivalent overwrite. Fixed by extracting serverFiles.js's backup
// logic into server/utils/configBackup.js and routing every ini write in
// mods.js through its writeIniWithBackup() wrapper, which also REMOVED the
// writeFileAtomic import from mods.js entirely so a future ini-rewriting
// route physically cannot skip the backup without first adding that import
// back (a visible, reviewable diff instead of a silent omission).
//
// These tests don't just read the code -- they run real routes against a
// real temp directory and assert a real .bak file lands on disk, then
// induce a real backup failure (fs.promises.copyFile rejecting) and assert
// the edit still succeeds while the response carries backupWarning, per
// serverFiles.js's established "never block on a failed backup" policy.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
  getTrackedMods: vi.fn(async () => []),
  addTrackedMod: vi.fn(),
  removeTrackedMod: vi.fn(),
  clearModUpdates: vi.fn(),
  getModPresets: vi.fn(async () => []),
  createModPreset: vi.fn(),
  updateModPreset: vi.fn(),
  deleteModPreset: vi.fn(),
  addIgnoredMod: vi.fn(),
  getIgnoredMods: vi.fn(async () => []),
  removeIgnoredMod: vi.fn(),
  clearAllIgnoredMods: vi.fn(),
  isModIgnored: vi.fn(async () => false),
  getIgnoredModPairs: vi.fn(async () => []),
  addIgnoredModPair: vi.fn(),
  removeIgnoredModPair: vi.fn(),
}));

const { getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getRouteHandlers(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(routePath, method, req) {
  const handlers = getRouteHandlers(routePath, method);
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

function readBackupFiles(configPath) {
  const backupDir = path.join(configPath, "backups");
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir).filter((f) => f.endsWith(".bak"));
}

describe("mods.js ini-rewriting routes back up the live ini before overwriting it", () => {
  let dataRoot;
  let configPath;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-ini-backup-"));
    configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    fs.writeFileSync(
      path.join(configPath, "TestServer.ini"),
      "Mods=ExistingMod\nWorkshopItems=1111111111\nMap=Muldraugh, KY\n",
    );
    getActiveServer.mockReset().mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
      isRemote: false,
    });
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("POST /toggle-mod-id backs up the ini before rewriting Mods=", async () => {
    expect(readBackupFiles(configPath)).toHaveLength(0);

    const res = await runRoute("/toggle-mod-id", "post", {
      body: { modId: "NewMod", enabled: true },
    });

    expect(res.getStatusCode()).toBe(200);
    const backups = readBackupFiles(configPath);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^TestServer\.ini\..*\.bak$/);
    // The backup is a snapshot of the PRE-write content, not the new one.
    const backedUpContent = fs.readFileSync(
      path.join(configPath, "backups", backups[0]),
      "utf-8",
    );
    expect(backedUpContent).toContain("Mods=ExistingMod");
    expect(backedUpContent).not.toContain("NewMod");
  });

  it("POST /write-to-ini backs up the ini before rewriting", async () => {
    const res = await runRoute("/write-to-ini", "post", {
      body: { mods: [{ workshopId: "2222222222", modId: "AnotherMod" }] },
    });

    expect(res.getStatusCode()).toBe(200);
    expect(readBackupFiles(configPath)).toHaveLength(1);
  });

  // resolve-orphan-workshop was the 19th ini-rewriting route -- present in
  // mods.js, absent from the 18-route enumeration that first surfaced this
  // bug, found only by grepping the write mechanism itself rather than
  // route names. It gets its own dedicated case rather than piggybacking on
  // a shared assertion, since it's the one route whose backup coverage
  // wasn't already implied by someone else's count.
  it("POST /resolve-orphan-workshop (the 19th, previously-uncounted route) backs up the ini before rewriting", async () => {
    const res = await runRoute("/resolve-orphan-workshop", "post", {
      body: { workshopIds: ["1111111111"] },
    });

    expect(res.getStatusCode()).toBe(200);
    expect(readBackupFiles(configPath)).toHaveLength(1);
  });

  // delete-disk-mod and purge both funnel through the shared
  // deleteModFromDiskAndIni() helper, which has its own single write site --
  // one fix here covers both routes at once.
  it("POST /delete-disk-mod (shared deleteModFromDiskAndIni helper) backs up the ini before rewriting", async () => {
    const res = await runRoute("/delete-disk-mod", "post", {
      body: { workshopId: "1111111111" },
    });

    expect(res.getStatusCode()).toBe(200);
    expect(readBackupFiles(configPath)).toHaveLength(1);
  });

  it("POST /batch-delete-disk-mods backs up the ini before rewriting", async () => {
    const res = await runRoute("/batch-delete-disk-mods", "post", {
      body: { workshopIds: ["1111111111"] },
    });

    expect(res.getStatusCode()).toBe(200);
    expect(readBackupFiles(configPath)).toHaveLength(1);
  });
});

describe("mods.js ini writes: a failed backup warns but never blocks the edit", () => {
  let dataRoot;
  let configPath;
  let copyFileSpy;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-ini-backup-fail-"));
    configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    fs.writeFileSync(
      path.join(configPath, "TestServer.ini"),
      "Mods=ExistingMod\nWorkshopItems=1111111111\nMap=Muldraugh, KY\n",
    );
    getActiveServer.mockReset().mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
      isRemote: false,
    });
    // Induce a real backup failure -- disk full, permissions, whatever --
    // rather than trusting the failure branch reads correctly.
    copyFileSpy = vi
      .spyOn(fs.promises, "copyFile")
      .mockRejectedValue(new Error("ENOSPC: no space left on device"));
  });

  afterEach(() => {
    copyFileSpy.mockRestore();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("POST /toggle-mod-id still applies the edit and reports backupWarning when the backup fails", async () => {
    const res = await runRoute("/toggle-mod-id", "post", {
      body: { modId: "NewMod", enabled: true },
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.success).toBe(true);
    expect(body.backupWarning).toMatch(/could not back up/i);
    expect(body.backupWarning).toMatch(/ENOSPC/);

    // The edit itself was NOT blocked by the backup failure.
    const iniContent = fs.readFileSync(
      path.join(configPath, "TestServer.ini"),
      "utf-8",
    );
    expect(iniContent).toMatch(/^Mods=.*NewMod/m);
  });
});

// sibling-convention sweep, 2026-09-08: /batch-remove caps its own
// workshopIds array at 500 "to prevent abuse". /batch-delete-disk-mods
// (the more destructive of the two -- it deletes real files from disk, not
// just an INI/DB edit) and /resolve-orphan-workshop both had no cap at
// all, found by reading the two routes directly after god's "check the
// sibling" dispatch. Fixed with the same 500-item cap, own error code per
// this file's per-call-site convention.
describe("mods.js batch workshopIds routes cap array size the same way /batch-remove already does", () => {
  let dataRoot;
  let configPath;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-batch-cap-"));
    configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    fs.writeFileSync(
      path.join(configPath, "TestServer.ini"),
      "Mods=ExistingMod\nWorkshopItems=1111111111\nMap=Muldraugh, KY\n",
    );
    getActiveServer.mockReset().mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
      isRemote: false,
    });
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  // Real, distinct 10-digit-shaped IDs -- not just a length count -- so a
  // regression that only checks .length after some other filter couldn't
  // pass by accident.
  function manyWorkshopIds(count) {
    return Array.from({ length: count }, (_, i) =>
      String(1000000000 + i),
    );
  }

  it("POST /batch-delete-disk-mods refuses more than 500 IDs and deletes nothing", async () => {
    const res = await runRoute("/batch-delete-disk-mods", "post", {
      body: { workshopIds: manyWorkshopIds(501) },
    });

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toEqual(
      expect.objectContaining({
        code: "MODS_BATCH_DELETE_DISK_MODS_TOO_MANY",
      }),
    );
    // Refusal must be real, not a wrong status with the edit happening anyway.
    expect(
      fs.readFileSync(path.join(configPath, "TestServer.ini"), "utf-8"),
    ).toContain("WorkshopItems=1111111111");
  });

  it("POST /batch-delete-disk-mods accepts exactly 500 IDs (the boundary itself is not refused)", async () => {
    const res = await runRoute("/batch-delete-disk-mods", "post", {
      body: { workshopIds: manyWorkshopIds(500) },
    });

    expect(res.getStatusCode()).toBe(200);
  });

  it("POST /resolve-orphan-workshop refuses more than 500 IDs and rewrites nothing", async () => {
    const res = await runRoute("/resolve-orphan-workshop", "post", {
      body: { workshopIds: manyWorkshopIds(501) },
    });

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toEqual(
      expect.objectContaining({
        code: "MODS_RESOLVE_ORPHAN_WORKSHOP_TOO_MANY",
      }),
    );
    expect(readBackupFiles(configPath)).toHaveLength(0);
  });

  it("POST /resolve-orphan-workshop accepts exactly 500 IDs (the boundary itself is not refused)", async () => {
    const res = await runRoute("/resolve-orphan-workshop", "post", {
      body: { workshopIds: manyWorkshopIds(500) },
    });

    expect(res.getStatusCode()).toBe(200);
  });
});
