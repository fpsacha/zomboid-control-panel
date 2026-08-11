import { beforeEach, describe, expect, it, vi } from "vitest";

const { getServer, getActiveServer } = vi.hoisted(() => ({
  getServer: vi.fn(),
  getActiveServer: vi.fn(),
}));

vi.mock("../database/init.js", () => ({ getServer, getActiveServer }));

const { runManagedLifecycle, resolveManagedContainer, setDockerClient } =
  await import("../services/managedContainer.js");

function createClient(overrides = {}) {
  return {
    enabled: true,
    available: true,
    inspectManagedContainer: vi.fn(async () => ({ State: { Running: true } })),
    runManagedAction: vi.fn(async () => ({ success: true })),
    ...overrides,
  };
}

beforeEach(() => {
  getServer.mockReset();
  getActiveServer.mockReset();
  setDockerClient(null);
});

describe("resolveManagedContainer", () => {
  it("declines when Docker control is disabled", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });
    const client = createClient({ enabled: false });

    expect(await resolveManagedContainer({ dockerClient: client })).toEqual({
      handled: false,
    });
    expect(client.inspectManagedContainer).not.toHaveBeenCalled();
  });

  it("declines when the socket is not reachable", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });

    expect(
      await resolveManagedContainer({ dockerClient: createClient({ available: false }) }),
    ).toEqual({ handled: false });
  });

  it("declines when the server maps no container", async () => {
    getActiveServer.mockResolvedValue({ id: "s1", dockerContainerName: null });

    expect(await resolveManagedContainer({ dockerClient: createClient() })).toEqual({
      handled: false,
    });
  });

  it("falls back to the container id when no name is mapped", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerId: "abc123" });
    const client = createClient();

    const resolved = await resolveManagedContainer({ dockerClient: client });

    expect(client.inspectManagedContainer).toHaveBeenCalledWith("abc123");
    expect(resolved.ref).toBe("abc123");
  });

  it("reads the pinned server rather than the active one when given an id", async () => {
    getServer.mockResolvedValue({ dockerContainerName: "pinned" });
    const client = createClient();

    await resolveManagedContainer({ serverId: "s9", dockerClient: client });

    expect(getServer).toHaveBeenCalledWith("s9");
    expect(getActiveServer).not.toHaveBeenCalled();
  });

  it("claims the action but fails when the mapped container is unmanageable", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });
    const client = createClient({ inspectManagedContainer: vi.fn(async () => null) });

    const resolved = await resolveManagedContainer({ dockerClient: client });

    // Must not decline: falling back to RCON would kill the process and let the
    // restart policy bring the container straight back up.
    expect(resolved.handled).toBe(true);
    expect(resolved.error).toMatch(/zomboid-panel\.managed=true/);
  });
});

describe("runManagedLifecycle", () => {
  it("stops through Docker instead of the process path", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });
    const client = createClient();

    const result = await runManagedLifecycle("stop", { dockerClient: client });

    expect(client.runManagedAction).toHaveBeenCalledWith("pz", "stop");
    expect(result).toEqual({ handled: true, success: true });
  });

  it("treats an already stopped container as a successful stop", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });
    const client = createClient({
      inspectManagedContainer: vi.fn(async () => ({ State: { Running: false } })),
    });

    const result = await runManagedLifecycle("stop", { dockerClient: client });

    expect(client.runManagedAction).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("treats an already running container as a successful start", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });
    const client = createClient();

    const result = await runManagedLifecycle("start", { dockerClient: client });

    expect(client.runManagedAction).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("restarts a running container through Docker", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });
    const client = createClient();

    await runManagedLifecycle("restart", { dockerClient: client });

    expect(client.runManagedAction).toHaveBeenCalledWith("pz", "restart");
  });

  it("surfaces a Docker failure instead of silently declining", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });
    const client = createClient({
      runManagedAction: vi.fn(async () => ({ success: false, error: "Docker action failed" })),
    });

    expect(await runManagedLifecycle("stop", { dockerClient: client })).toEqual({
      handled: true,
      success: false,
      error: "Docker action failed",
    });
  });

  it("uses the client wired through setDockerClient", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });
    const client = createClient();
    setDockerClient(client);

    await runManagedLifecycle("stop");

    expect(client.runManagedAction).toHaveBeenCalledWith("pz", "stop");
  });

  it("declines when no client has been wired at all", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });

    expect(await runManagedLifecycle("stop")).toEqual({ handled: false });
  });
});
