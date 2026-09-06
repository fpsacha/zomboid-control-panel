import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { getDataPaths } from "../utils/paths.js";

// 2026-09-06 (kevin, ms-filename-sweep): POST /character/import's pre-import
// safety snapshot (server/routes/panelBridge.js, ~line 3752) had the exact
// same bare-toISOString()-filename defect as autoExportPlayer()'s own ring
// (server/index.js) before that one was fixed -- both write into the same
// exports/<username>/ directory using the same naming convention, and this
// site never got the equivalent fix. Two imports for the same player in the
// same millisecond (a double-submit before the button disables, or a
// retried request) made the second import's "recovery copy" silently
// overwrite the first one -- worse than the failure this snapshot exists to
// guard against, since the route still reports success.
//
// Reuses the getHandler/runHandler pattern from panelBridgeErrorParams.test.js
// (skips the requirePermission gate, same as that file).
vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(),
  getAllSettings: vi.fn(async () => ({})),
  setSetting: vi.fn(),
  getDb: vi.fn(),
  commitNow: vi.fn(),
  logBridgeCommand: vi.fn(async () => {}),
}));

const { default: bridge } = await import("../services/panelBridge.js");
const { default: router } = await import("../routes/panelBridge.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) {
    throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  }
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function runHandler(routePath, method, req) {
  const res = createResponse();
  await getHandler(routePath, method)(req, res, () => {});
  return res;
}

describe("POST /character/import: pre-import snapshot collision handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    bridge.isRunning = false;
  });

  it("gives two same-millisecond imports for the same player distinct snapshot files, not a silent overwrite", async () => {
    bridge.isRunning = true;
    vi.spyOn(bridge, "sendCommand").mockImplementation(async (action) => {
      if (action === "exportPlayerData") {
        return { success: true, data: { perks: { Fitness: 1 } } };
      }
      if (action === "importPlayerData") return { success: true };
      throw new Error(`unexpected bridge action: ${action}`);
    });

    const fixedNow = new Date("2026-09-06T14:00:00.000Z");
    const realToISOString = Date.prototype.toISOString;
    vi.spyOn(Date.prototype, "toISOString").mockImplementation(function () {
      return realToISOString.call(fixedNow);
    });

    const body = { username: "ImportSnapshotUser", data: { perks: {} } };
    const firstRes = await runHandler("/character/import", "post", { body });
    const secondRes = await runHandler("/character/import", "post", { body });

    expect(firstRes.status).not.toHaveBeenCalled();
    expect(secondRes.status).not.toHaveBeenCalled();

    const { dataDir } = getDataPaths();
    const exportDir = path.join(dataDir, "exports", "ImportSnapshotUser");
    const snapshots = fs
      .readdirSync(exportDir)
      .filter((f) => f.includes("pre-import"));

    expect(snapshots).toHaveLength(2);
    // The bug this pins: without a collision suffix, the second snapshot's
    // filename is byte-identical to the first and fs.writeFileSync silently
    // clobbers it -- only one file would exist here instead of two.
    expect(snapshots.some((f) => /-2\.json$/.test(f))).toBe(true);

    const firstSnapshotFile = firstRes.json.mock.calls[0][0].snapshotFile;
    const secondSnapshotFile = secondRes.json.mock.calls[0][0].snapshotFile;
    expect(firstSnapshotFile).not.toBe(secondSnapshotFile);
    expect(fs.existsSync(path.join(exportDir, firstSnapshotFile))).toBe(true);
    expect(fs.existsSync(path.join(exportDir, secondSnapshotFile))).toBe(true);
  });
});
