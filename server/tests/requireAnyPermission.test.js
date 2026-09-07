import { describe, expect, it, vi } from "vitest";

// sweep-round5 (2026-09-07): requireAnyPermission(...capabilities) -- the
// missing "or" in this file's authorization vocabulary, built because its
// absence was the root cause of a real hole (backup.js's GET
// /status|/list|/history had NO capability check at all, because no single
// capability describes "may see what backups exist" -- see
// backupReadRoutesAnyCapability.test.js for that route-level proof). This
// file proves the helper itself: same fail-closed contract as
// requirePermission(), but OR instead of a single AND.

const db = { data: { roles: [] } };

vi.mock("../database/init.js", () => ({
  getRoleByName: async (name) => db.data.roles.find((r) => r.name === name) || null,
}));

const { requireAnyPermission } = await import("../services/permissions.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function runGate(gate, req) {
  const res = createResponse();
  let calledNext = false;
  await gate(req, res, () => {
    calledNext = true;
  });
  return { res, calledNext };
}

describe("requireAnyPermission", () => {
  it("admits a role holding ONLY the first listed capability", async () => {
    db.data.roles = [{ name: "r", capabilities: ["backups.manage"], isSeeded: false }];
    const { calledNext } = await runGate(
      requireAnyPermission("backups.manage", "backups.download", "backups.restore"),
      { user: { role: "r" } },
    );
    expect(calledNext).toBe(true);
  });

  it("admits a role holding ONLY the last listed capability", async () => {
    db.data.roles = [{ name: "r", capabilities: ["backups.restore"], isSeeded: false }];
    const { calledNext } = await runGate(
      requireAnyPermission("backups.manage", "backups.download", "backups.restore"),
      { user: { role: "r" } },
    );
    expect(calledNext).toBe(true);
  });

  it("admits a role holding ALL of the listed capabilities, not just tolerating it", async () => {
    db.data.roles = [
      {
        name: "r",
        capabilities: ["backups.manage", "backups.download", "backups.restore"],
        isSeeded: false,
      },
    ];
    const { calledNext } = await runGate(
      requireAnyPermission("backups.manage", "backups.download", "backups.restore"),
      { user: { role: "r" } },
    );
    expect(calledNext).toBe(true);
  });

  it("refuses a role holding NONE of the listed capabilities, even with an unrelated real one", async () => {
    db.data.roles = [{ name: "r", capabilities: ["players.view"], isSeeded: false }];
    const { res, calledNext } = await runGate(
      requireAnyPermission("backups.manage", "backups.download", "backups.restore"),
      { user: { role: "r" } },
    );
    expect(calledNext).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("refuses with no req.user at all -- 401, not a permission decision", async () => {
    db.data.roles = [];
    const { res, calledNext } = await runGate(
      requireAnyPermission("backups.manage", "backups.download"),
      {},
    );
    expect(calledNext).toBe(false);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("refuses when the role can't be resolved (renamed/deleted out from under an active session)", async () => {
    db.data.roles = [];
    const { res, calledNext } = await runGate(
      requireAnyPermission("backups.manage", "backups.download"),
      { user: { role: "ghost-role" } },
    );
    expect(calledNext).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("PROGRAMMING ERROR, fails closed: an unregistered capability in the list refuses every request, not just skips that one entry", async () => {
    db.data.roles = [
      {
        name: "r",
        capabilities: ["backups.manage", "not.a.real.capability"],
        isSeeded: false,
      },
    ];
    const { res, calledNext } = await runGate(
      requireAnyPermission("backups.manage", "not.a.real.capability"),
      { user: { role: "r" } },
    );
    expect(calledNext).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("PROGRAMMING ERROR, fails closed: called with zero capabilities refuses every request", async () => {
    db.data.roles = [{ name: "r", capabilities: ["backups.manage"], isSeeded: false }];
    const { res, calledNext } = await runGate(requireAnyPermission(), {
      user: { role: "r" },
    });
    expect(calledNext).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
