import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePanelUpdateDownload } from "../index.js";
import { ServerManager } from "../services/serverManager.js";

// god's ruling, 2026-09-08 (my own hunt-report design question): when the
// Docker update path saves the world and stops a running server, then
// checker.downloadUpdate() itself fails, the response used to report only
// the download failure -- with no mention that the server was already
// stopped as a real, consequential side effect of this same request. Do NOT
// auto-restart on failure (a failed apply can leave a half-written install;
// launching the game server's JVM over that is exactly the corruption
// activeSteamOperations' crash-survival work exists to prevent, and it
// would override an operator who may have wanted the server down). Instead,
// say so explicitly in the error response.
function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function createRequest(checker, rconService) {
  return {
    body: { confirm: true },
    app: {
      get: (key) => {
        if (key === "panelUpdateChecker") return checker;
        if (key === "rconService") return rconService;
        return undefined;
      },
    },
  };
}

describe("Docker panel update: a stopped server is reported, not silently left out of a later failure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tells the user the server was stopped and not restarted when the download/apply fails afterward", async () => {
    vi.spyOn(ServerManager.prototype, "getServerProcessDetails").mockResolvedValue({
      running: true,
      scanFailed: false,
    });
    const rconService = {
      connected: true,
      save: vi.fn(async () => ({ success: true })),
      quit: vi.fn(async () => ({ success: true })),
    };
    const downloadUpdate = vi.fn(async () => ({
      success: false,
      code: "no_update",
      error: "No update available",
    }));
    const response = createResponse();

    await handlePanelUpdateDownload(
      createRequest({ dockerUpdateProxy: { enabled: true }, downloadUpdate }, rconService),
      response,
    );

    expect(rconService.save).toHaveBeenCalledOnce();
    expect(rconService.quit).toHaveBeenCalledOnce();
    expect(response.status).toHaveBeenCalledWith(400);
    const body = response.json.mock.calls[0][0];
    expect(body.serverStoppedNotRestarted).toBe(true);
    expect(body.error).toContain("was NOT restarted");
    expect(body.error).toContain("restart it manually");
  });

  it("does not add the stopped-server notice when the server was never running (nothing was stopped)", async () => {
    vi.spyOn(ServerManager.prototype, "getServerProcessDetails").mockResolvedValue({
      running: false,
      scanFailed: false,
    });
    const downloadUpdate = vi.fn(async () => ({
      success: false,
      code: "no_update",
      error: "No update available",
    }));
    const response = createResponse();

    await handlePanelUpdateDownload(
      createRequest({ dockerUpdateProxy: { enabled: true }, downloadUpdate }, { connected: true }),
      response,
    );

    const body = response.json.mock.calls[0][0];
    expect(body.serverStoppedNotRestarted).toBeUndefined();
    expect(body.error).toBe("No update available");
  });

  it("does not add the stopped-server notice when the download/apply actually succeeds", async () => {
    vi.spyOn(ServerManager.prototype, "getServerProcessDetails").mockResolvedValue({
      running: true,
      scanFailed: false,
    });
    const rconService = {
      connected: true,
      save: vi.fn(async () => ({ success: true })),
      quit: vi.fn(async () => ({ success: true })),
    };
    const downloadUpdate = vi.fn(async () => ({ success: true, message: "Applied" }));
    const response = createResponse();

    await handlePanelUpdateDownload(
      createRequest({ dockerUpdateProxy: { enabled: true }, downloadUpdate }, rconService),
      response,
    );

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });
});
