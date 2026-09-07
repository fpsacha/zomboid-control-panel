import { describe, expect, it, vi } from "vitest";

// sweep-round5 (2026-09-07): GET /status, /list and /history had NO
// capability check at all -- any authenticated user, even one holding zero
// backup capabilities via a custom role, could read savesPath/backupsPath
// (absolute host filesystem paths) and backup filenames. Every mutation in
// this file, and the sibling GET /:name/snapshot, already required
// backups.manage. Fixed with requireAnyPermission("backups.manage",
// "backups.download", "backups.restore") -- an "any of" gate, not
// backups.manage alone, because a download-only or restore-only custom
// role legitimately needs /list before it can call /download/:name or
// /restore/:name. Mirrors backupDownloadCapability.test.js's pattern
// exactly, extended to prove all three OR'd capabilities individually
// suffice, not just that a role with none of them is refused.
const db = { data: { roles: [] } };

vi.mock("../database/init.js", () => ({
  getRoleByName: async (name) => db.data.roles.find((r) => r.name === name) || null,
}));

const { default: backupRouter } = await import("../routes/backup.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getGate(routePath, method) {
  const layer = backupRouter.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[0].handle;
}

async function runGate(routePath, method, req) {
  const res = createResponse();
  let calledNext = false;
  await getGate(routePath, method)(req, res, () => {
    calledNext = true;
  });
  return { res, calledNext };
}

const READ_ROUTES = [
  ["/status", "get"],
  ["/list", "get"],
  ["/history", "get"],
];

describe.each(READ_ROUTES)("GET %s -- any of backups.manage/download/restore", (routePath) => {
  it("refuses a role holding NONE of the three, even a real unrelated capability", async () => {
    db.data.roles = [{ name: "outsider", capabilities: ["players.view"], isSeeded: false }];
    const { res, calledNext } = await runGate(routePath, "get", { user: { role: "outsider" } });
    expect(calledNext).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("admits a role holding ONLY backups.manage", async () => {
    db.data.roles = [
      { name: "housekeeper", capabilities: ["backups.manage"], isSeeded: false },
    ];
    const { calledNext } = await runGate(routePath, "get", { user: { role: "housekeeper" } });
    expect(calledNext).toBe(true);
  });

  it("admits a role holding ONLY backups.download -- the exact role this fix was written not to break", async () => {
    db.data.roles = [
      { name: "offsite-courier", capabilities: ["backups.download"], isSeeded: false },
    ];
    const { calledNext } = await runGate(routePath, "get", {
      user: { role: "offsite-courier" },
    });
    expect(calledNext).toBe(true);
  });

  it("admits a role holding ONLY backups.restore", async () => {
    db.data.roles = [
      { name: "disaster-recovery", capabilities: ["backups.restore"], isSeeded: false },
    ];
    const { calledNext } = await runGate(routePath, "get", {
      user: { role: "disaster-recovery" },
    });
    expect(calledNext).toBe(true);
  });

  it("refuses with no req.user at all -- 401, not a permission decision", async () => {
    db.data.roles = [];
    const { res, calledNext } = await runGate(routePath, "get", {});
    expect(calledNext).toBe(false);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe("GET /info -- unchanged, still ungated (static description text, no host paths, no secrets)", () => {
  it("has no capability gate as its first handler", async () => {
    const layer = backupRouter.stack.find(
      (entry) => entry.route?.path === "/info" && entry.route.methods.get,
    );
    const res = createResponse();
    let calledNext = false;
    // The route's own handler (not a gate) is first -- calling it with a
    // minimal req/res should reach app.get(...) rather than a 401/403.
    // We only assert this doesn't throw synchronously for lack of req.user,
    // proving no auth/permission gate was accidentally added here too.
    const firstHandle = layer.route.stack[0].handle;
    const req = { app: { get: () => ({ getBackupContentsInfo: () => ({ description: "x" }) }) } };
    await firstHandle(req, res, () => {
      calledNext = true;
    });
    expect(res.json).toHaveBeenCalled();
  });
});
