import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 1 finding (Oscar, 2026-08-29): the status watchdog's
// getObservedServerRunning() (server/index.js) called
// serverManager.getServerProcessDetails() unconditionally for every
// provider -- a LOCAL host process scan. For docker-local/docker-managed
// servers, PZ runs as PID 1 of a *different* container, so that scan can
// never see it (GH#114, same limitation server/routes/serverStatus.js's
// dashboard badge already accounts for). Result: Docker deployments got
// ZERO server-initiated status correction, ever, for any transition
// (start, stop-outside-the-panel, restart, crash) -- 100% dependent on the
// client's own 10-15s polling. Fixed by branching on resolveProvider() and
// consulting resolveDockerHostSignal() (server/services/managedContainer.js)
// instead of the local scan for those two providers.

const getActiveServer = vi.fn();
// peekServerDisplayName: index.js's own boot sequence wires this into
// lifecycleCoordinator.js's setServerDisplayNameResolver() unconditionally
// at module scope -- referencing it here even without calling it is enough
// to throw against an incomplete mock.
vi.mock("../database/init.js", () => ({ getActiveServer, peekServerDisplayName: () => null }));

const resolveDockerHostSignal = vi.fn();
vi.mock("../services/managedContainer.js", () => ({
  setDockerClient: vi.fn(),
  resolveDockerHostSignal,
}));

const { getObservedServerRunning } = await import("../index.js");
const { ServerManager } = await import("../services/serverManager.js");

describe("status watchdog -- Docker provider awareness", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    resolveDockerHostSignal.mockReset();
    vi.spyOn(ServerManager.prototype, "getServerProcessDetails").mockResolvedValue({
      running: false,
      scanFailed: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("trusts the Docker signal over the (always-blind) local process scan for docker-local", async () => {
    getActiveServer.mockResolvedValue({
      id: "docker-server",
      dockerContainerName: "pz-container",
      isRemote: false,
    });
    resolveDockerHostSignal.mockResolvedValue({ running: true, scanFailed: false });

    const running = await getObservedServerRunning();

    expect(running).toBe(true);
    expect(resolveDockerHostSignal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "docker-server", dockerContainerName: "pz-container" }),
      expect.anything(),
    );
    // The local scan is provider-blind and would confidently (and wrongly)
    // report this container-hosted process as not running -- must not be
    // consulted at all for this provider.
    expect(ServerManager.prototype.getServerProcessDetails).not.toHaveBeenCalled();
  });

  it("reports unknown (not a confident stopped) when Docker control can't verify", async () => {
    getActiveServer.mockResolvedValue({
      id: "docker-server",
      dockerContainerName: "pz-container",
      isRemote: false,
    });
    resolveDockerHostSignal.mockResolvedValue({ running: false, scanFailed: true });

    expect(await getObservedServerRunning()).toBeNull();
  });

  it("still uses the local process scan for a native server, not the Docker signal", async () => {
    getActiveServer.mockResolvedValue({ id: "native-server", isRemote: false });
    ServerManager.prototype.getServerProcessDetails.mockResolvedValue({
      running: true,
      scanFailed: false,
    });

    expect(await getObservedServerRunning()).toBe(true);
    expect(resolveDockerHostSignal).not.toHaveBeenCalled();
  });
});
