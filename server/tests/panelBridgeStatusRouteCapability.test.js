import { describe, expect, it, vi } from "vitest";

// sweep-round5 (2026-09-07): GET /panel-bridge/status returns bridgePath
// and (nested) statusFile.path -- both genuinely rendered in Settings.tsx's
// PanelBridge card -- and was completely ungated before this. Gated to any
// of bridge.setup/bridge.diagnostics rather than either alone: an operator
// holding only the ability to diagnose the bridge still has a real reason
// to see whether it's even connected, same as one who can only configure
// it. Mirrors backupReadRoutesAnyCapability.test.js's pattern for the
// identical shape of fix in backup.js.
const db = { data: { roles: [] } };

vi.mock("../database/init.js", () => ({
  getRoleByName: async (name) => db.data.roles.find((r) => r.name === name) || null,
  getActiveServer: vi.fn(async () => null),
}));

vi.mock("../services/panelBridge.js", () => ({
  default: {
    getStatus: () => ({ alive: false }),
    isModConnected: () => false,
  },
}));

const { default: panelBridgeRouter } = await import("../routes/panelBridge.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getGate(routePath, method) {
  const layer = panelBridgeRouter.stack.find(
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

describe("GET /panel-bridge/status -- any of bridge.setup/bridge.diagnostics", () => {
  it("refuses a role holding NEITHER, even a real unrelated capability", async () => {
    db.data.roles = [{ name: "outsider", capabilities: ["players.view"], isSeeded: false }];
    const { res, calledNext } = await runGate("/status", "get", { user: { role: "outsider" } });
    expect(calledNext).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("admits a role holding ONLY bridge.setup", async () => {
    db.data.roles = [{ name: "configurer", capabilities: ["bridge.setup"], isSeeded: false }];
    const { calledNext } = await runGate("/status", "get", { user: { role: "configurer" } });
    expect(calledNext).toBe(true);
  });

  it("admits a role holding ONLY bridge.diagnostics", async () => {
    db.data.roles = [
      { name: "diagnostician", capabilities: ["bridge.diagnostics"], isSeeded: false },
    ];
    const { calledNext } = await runGate("/status", "get", { user: { role: "diagnostician" } });
    expect(calledNext).toBe(true);
  });

  it("refuses with no req.user at all -- 401, not a permission decision", async () => {
    db.data.roles = [];
    const { res, calledNext } = await runGate("/status", "get", {});
    expect(calledNext).toBe(false);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
