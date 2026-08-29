import { beforeEach, describe, expect, it, vi } from "vitest";

const getServer = vi.fn();
const updateServer = vi.fn();
const preflightActivation = vi.fn();
const managedStatus = vi.fn();
const directStatus = vi.fn();

vi.mock("../database/init.js", () => ({
  getServers: vi.fn().mockResolvedValue([]),
  getServer,
  getActiveServer: vi.fn(),
  createServer: vi.fn(),
  updateServer,
  deleteServer: vi.fn(),
  setActiveServer: vi.fn(),
  getAllSettings: vi.fn().mockResolvedValue({}),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("../services/permissions.js", () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));

vi.mock("../services/serverManager.js", () => ({
  resolveLaunchMode: () => ({ mode: "managed" }),
  ServerManager: class {
    async reloadConfig() {}
    async getServerProcessDetails() {
      return directStatus();
    }
  },
}));

vi.mock("../services/linuxServiceLifecycle.js", () => ({
  LIFECYCLE_PROVIDERS: ["direct", "systemd", "openrc"],
  getLinuxLifecycleCapabilities: () => ({
    supported: true,
    platform: "linux",
    containerized: false,
    providers: ["direct", "systemd", "openrc"],
  }),
  isManagedLifecycleProvider: (provider) =>
    provider === "systemd" || provider === "openrc",
  buildLifecycleTemplate: vi.fn((_server, provider) => ({
    provider,
    serviceName: "zomboid-panel-server-one",
    filename:
      provider === "systemd"
        ? "zomboid-panel-server-one.service"
        : "zomboid-panel-server-one",
    installPath: "/etc/example",
    content: "# generated",
    commands: [],
  })),
  createLinuxServiceLifecycle: () => ({
    preflightActivation,
    status: managedStatus,
  }),
}));

vi.mock("../services/rcon.js", () => ({
  normalizeRconHost: (host) => host,
  testRconConnection: vi.fn(),
}));

const { default: router } = await import("../routes/servers.js");

function handler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function response() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

const localProfile = {
  id: "one",
  name: "One",
  serverName: "servertest",
  installPath: "/opt/pz",
  isRemote: false,
  lifecycleProvider: "direct",
};

describe("Linux lifecycle migration routes", () => {
  beforeEach(() => {
    getServer.mockReset().mockResolvedValue(localProfile);
    updateServer.mockReset().mockImplementation(async (_id, updates) => ({
      ...localProfile,
      ...updates,
      isActive: false,
    }));
    preflightActivation.mockReset().mockResolvedValue({
      ready: true,
      registered: true,
      running: false,
    });
    managedStatus.mockReset().mockResolvedValue({
      running: false,
      scanFailed: false,
    });
    directStatus.mockReset().mockResolvedValue({
      running: false,
      scanFailed: false,
    });
  });

  it("returns a generated service file without installing it", async () => {
    const res = response();

    await handler("/:id/lifecycle-template", "get")(
      { params: { id: "one" }, query: { provider: "systemd" } },
      res,
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "zomboid-panel-server-one.service",
        content: "# generated",
        warning: expect.stringMatching(/will not modify the filesystem/i),
      }),
    );
    expect(updateServer).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation before changing lifecycle ownership", async () => {
    const res = response();

    await handler("/:id/lifecycle-provider", "post")(
      {
        params: { id: "one" },
        body: { provider: "systemd" },
        app: { get: vi.fn() },
      },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(updateServer).not.toHaveBeenCalled();
  });

  it("activates an installed stopped service only after the direct process is confirmed stopped", async () => {
    const res = response();

    await handler("/:id/lifecycle-provider", "post")(
      {
        params: { id: "one" },
        body: { provider: "systemd", confirm: true },
        app: { get: vi.fn() },
      },
      res,
    );

    expect(preflightActivation).toHaveBeenCalledOnce();
    expect(directStatus).toHaveBeenCalledOnce();
    expect(updateServer).toHaveBeenCalledWith("one", {
      lifecycleProvider: "systemd",
    });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Lifecycle provider changed to systemd" }),
    );
  });

  it("refuses to adopt a running direct process", async () => {
    directStatus.mockResolvedValue({ running: true, scanFailed: false });
    const res = response();

    await handler("/:id/lifecycle-provider", "post")(
      {
        params: { id: "one" },
        body: { provider: "systemd", confirm: true },
        app: { get: vi.fn() },
      },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(updateServer).not.toHaveBeenCalled();
  });

  it("surfaces an installed-service ownership conflict", async () => {
    preflightActivation.mockResolvedValue({
      ready: false,
      conflict: true,
      running: false,
      error: "Service belongs to another server profile",
    });
    const res = response();

    await handler("/:id/lifecycle-provider", "post")(
      {
        params: { id: "one" },
        body: { provider: "systemd", confirm: true },
        app: { get: vi.fn() },
      },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ conflict: true }),
    );
    expect(updateServer).not.toHaveBeenCalled();
  });
});
