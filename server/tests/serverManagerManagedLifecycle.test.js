import { beforeEach, describe, expect, it, vi } from "vitest";

const getServer = vi.fn();
const getActiveServer = vi.fn();
const logServerEvent = vi.fn();

vi.mock("../database/init.js", () => ({
  getServer,
  getActiveServer,
  getServers: vi.fn().mockResolvedValue([]),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  logServerEvent,
}));

const { ServerManager } = await import("../services/serverManager.js");

const profile = {
  id: "managed-1",
  name: "Managed",
  serverName: "servertest",
  installPath: "/opt/pz",
  lifecycleProvider: "systemd",
  rconHost: "127.0.0.1",
  rconPort: 27015,
};

describe("ServerManager managed Linux lifecycle", () => {
  let lifecycle;
  let manager;

  beforeEach(() => {
    getServer.mockReset().mockResolvedValue(profile);
    getActiveServer.mockReset().mockResolvedValue(profile);
    logServerEvent.mockReset().mockResolvedValue(undefined);
    lifecycle = {
      serviceName: "zomboid-panel-server-managed-1",
      status: vi.fn().mockResolvedValue({ running: true, scanFailed: false }),
      run: vi.fn().mockResolvedValue({
        success: true,
        confirmed: true,
        message: "ok",
      }),
    };
    manager = new ServerManager({ lifecycleFactory: () => lifecycle });
    manager.sleep = vi.fn().mockResolvedValue(undefined);
  });

  it("uses the service manager as status authority without returning an owned PID", async () => {
    await manager.reloadConfig(profile.id);

    const status = await manager.getServerProcessDetails();

    expect(lifecycle.status).toHaveBeenCalledOnce();
    expect(status).toMatchObject({
      running: true,
      scanFailed: false,
      provider: "systemd",
      owned: [],
      matched: [],
    });
  });

  it("starts through systemd and never retains a child-process handle", async () => {
    const result = await manager.startServer();

    expect(lifecycle.run).toHaveBeenCalledWith("start");
    expect(result.success).toBe(true);
    expect(manager.serverProcess).toBeNull();
  });

  it("force-stops through systemd instead of killing host PIDs", async () => {
    manager._killPids = vi.fn();
    manager._genericForceStop = vi.fn();

    const result = await manager.stopServer(false);

    expect(lifecycle.run).toHaveBeenCalledWith("stop");
    expect(manager._killPids).not.toHaveBeenCalled();
    expect(manager._genericForceStop).not.toHaveBeenCalled();
    expect(result.confirmed).toBe(true);
  });

  it("restarts through systemd after the normal warning and save flow", async () => {
    const rcon = {
      serverMessage: vi.fn().mockResolvedValue({ success: true }),
      save: vi.fn().mockResolvedValue({ success: true }),
      quit: vi.fn(),
    };

    const result = await manager.restartServer(rcon, 0);

    expect(rcon.save).toHaveBeenCalledOnce();
    expect(rcon.quit).not.toHaveBeenCalled();
    expect(lifecycle.run).toHaveBeenCalledWith("restart");
    expect(result.success).toBe(true);
    expect(manager.serverProcess).toBeNull();
  });
});
