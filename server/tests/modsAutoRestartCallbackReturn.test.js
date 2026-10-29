import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async () => null),
  // Turning auto-restart on takes server.control on top of mods.manage.
  getRoleByName: vi.fn(async () => ({ capabilities: ["mods.manage", "server.control"] })),
}));

const { default: router } = await import("../routes/mods.js");

function getAutoRestartHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/auto-restart" && entry.route.methods.post,
  );
  if (!layer) throw new Error("POST /auto-restart route not registered");
  return layer.route.stack.at(-1).handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

// bughunt-2026-08-31-c: identical bug to modChecker.js's init() restore-path
// callback (e76cade9) -- POST /auto-restart's block-bodied callback never
// returned handleModUpdate()'s result, so checkForUpdates()'s markProcessed
// dedup check always saw undefined for a normal restart and the same update
// could retrigger another restart on the next check cycle. routes/config.js's
// bulk-save path (an implicit-return arrow) was the one call site that
// already got this right.
describe("POST /mods/auto-restart", () => {
  beforeEach(() => vi.clearAllMocks());

  it("the registered callback returns handleModUpdate's result instead of resolving undefined", async () => {
    const handleModUpdate = vi.fn(async () => ({
      success: true,
      markProcessed: true,
    }));
    const setUpdateCallback = vi.fn();
    const response = createResponse();

    await getAutoRestartHandler()(
      {
        user: { role: "technician" },
        body: { enabled: true },
        app: { get: () => ({ setUpdateCallback, handleModUpdate }) },
      },
      response,
    );

    expect(setUpdateCallback).toHaveBeenCalledOnce();
    const callback = setUpdateCallback.mock.calls[0][0];
    const result = await callback([{ workshopId: "123" }]);

    expect(handleModUpdate).toHaveBeenCalledWith([{ workshopId: "123" }]);
    expect(result).toEqual({ success: true, markProcessed: true });
  });

  it("still logs a warning on a failed handleModUpdate while returning its result", async () => {
    const handleModUpdate = vi.fn(async () => ({
      success: false,
      error: "RCON disconnected",
    }));
    const setUpdateCallback = vi.fn();
    const response = createResponse();

    await getAutoRestartHandler()(
      {
        user: { role: "technician" },
        body: { enabled: true },
        app: { get: () => ({ setUpdateCallback, handleModUpdate }) },
      },
      response,
    );

    const callback = setUpdateCallback.mock.calls[0][0];
    const result = await callback([{ workshopId: "456" }]);

    expect(result).toEqual({ success: false, error: "RCON disconnected" });
  });
});
