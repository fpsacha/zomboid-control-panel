import { describe, expect, it, vi } from "vitest";

// A `quit` typed in the Console, or run by a scheduled task, is a stop the
// panel was asked for. It takes no lifecycle lock, so the status watchdog
// read the stop that followed as "unknown" and the server watch as a stop
// "without the panel asking" -- and with "Restart if it goes down" on, the
// server was started again 15 seconds after the operator stopped it.
vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
  getSetting: async () => null,
  setSetting: async () => {},
  logCommand: () => {},
}));

const { RconService } = await import("../services/rcon.js");
const { lifecycleActivityCovers } = await import("../services/lifecycleCoordinator.js");
const { PANEL_STOP_WINDOW_MS } = await import("../services/serverWatch.js");

function connectedService(serverId) {
  const service = new RconService();
  service.connected = true;
  service.serverStarting = false;
  service.serverId = serverId;
  service.client = { execute: vi.fn().mockResolvedValue("") };
  return service;
}

describe("a quit the panel sends over RCON", () => {
  it("counts as the panel's own stop of that server, however it was typed", async () => {
    const service = connectedService("console-quit");
    expect(lifecycleActivityCovers("console-quit", PANEL_STOP_WINDOW_MS)).toBe(false);

    await service.execute(" QUIT ", { skipLog: true });

    expect(service.lastQuitAttemptAt).toEqual(expect.any(String));
    expect(lifecycleActivityCovers("console-quit", PANEL_STOP_WINDOW_MS)).toBe(true);
    // Only that server's, and only for the window.
    expect(lifecycleActivityCovers("another-server", PANEL_STOP_WINDOW_MS)).toBe(false);
    expect(
      lifecycleActivityCovers("console-quit", PANEL_STOP_WINDOW_MS, Date.now() + PANEL_STOP_WINDOW_MS + 1000),
    ).toBe(false);
  });

  it("leaves any other command alone", async () => {
    const service = connectedService("console-players");
    await service.execute("players", { skipLog: true });
    await service.execute("quitter", { skipLog: true });

    expect(service.lastQuitAttemptAt ?? null).toBeNull();
    expect(lifecycleActivityCovers("console-players", PANEL_STOP_WINDOW_MS)).toBe(false);
  });
});
