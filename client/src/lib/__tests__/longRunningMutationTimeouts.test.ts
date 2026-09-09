import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backupApi, serverApi, panelBridgeApi, BRIDGE_SLOW_ENUMERATION_TIMEOUT_MS } from "../api";
import { clearAccessToken } from "../authToken";

// bug-hunt-2026-09-07 (Windows updater hardening lane, widened by god to a
// floor-wide sweep after panelUpdateApi.download's fix turned out to be a
// CLASS, not a one-off): fetchWithRetry's default timeout is 15s, sized for
// an ordinary API call. Several mutations hold the HTTP request open for a
// server operation that can legitimately outlive that on a bad day --
// confirmed for each of these by reading the actual route handler, not by
// guessing from the endpoint name (several similarly-named siblings, e.g.
// /server/start and /server/restart, were checked and are correctly
// fire-and-forget already, so were NOT touched):
//
//   - POST /backup/create   -- backupService.createBackup() (walk + zip the
//     save directory) is awaited before responding.
//   - POST /backup/restore/:name -- same shape, backupService.restoreBackup().
//   - POST /server/wipe -- server/routes/server.js's own comment calls out
//     "the multi-minute pre-wipe backup" awaited before the destructive
//     delete even starts.
//   - POST /server/stop, /server/force-stop -- await RCON save (rcon.js's
//     commandTimeout: 10s) then either RCON quit (another ~10s) or, for a
//     Docker-managed server, dockerClient.js's lifecycleTimeoutMs (the
//     container's StopTimeout, operator-configurable and uncapped here,
//     plus a 30s grace period) before responding. /server/start and
//     /server/restart are already correctly fire-and-forget (checked) and
//     were deliberately left on the generic default.
//
// This guards that each of the five uses a timeout long enough to survive
// the legitimate worst case, not the generic 15s default.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Mimics real fetch's abort behavior under vitest fake timers: resolves
// after `delayMs` unless the request's AbortSignal fires first.
function slowFetchMock(delayMs: number) {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(
        () => resolve(jsonResponse(200, { success: true })),
        delayMs,
      );
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  });
}

describe("long-running mutation timeouts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearAccessToken();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearAccessToken();
  });

  const tenMinuteCases: Array<[string, () => Promise<unknown>]> = [
    ["backupApi.createBackup", () => backupApi.createBackup()],
    ["backupApi.restoreBackup", () => backupApi.restoreBackup("save.zip")],
    ["serverApi.wipe", () => serverApi.wipe(["world"])],
  ];

  it.each(tenMinuteCases)(
    "%s does not abort before its 10-minute timeout",
    async (_name, call) => {
      const fetchMock = slowFetchMock(4 * 60 * 1000); // past the generic 15s default, well under 10 minutes
      vi.stubGlobal("fetch", fetchMock);

      const request = call();
      const resolution = expect(request).resolves.toMatchObject({ success: true });
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);

      await resolution;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  const threeMinuteCases: Array<[string, () => Promise<unknown>]> = [
    ["serverApi.stop", () => serverApi.stop()],
    ["serverApi.forceStop", () => serverApi.forceStop()],
  ];

  it.each(threeMinuteCases)(
    "%s does not abort before its 3-minute timeout (Docker StopTimeout + grace)",
    async (_name, call) => {
      const fetchMock = slowFetchMock(60_000); // past the generic 15s default, well under 3 minutes
      vi.stubGlobal("fetch", fetchMock);

      const request = call();
      const resolution = expect(request).resolves.toMatchObject({ success: true });
      await vi.advanceTimersByTimeAsync(60_000);

      await resolution;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("serverApi.stop still gives up if the server genuinely never responds within 3 minutes", async () => {
    const fetchMock = slowFetchMock(10 * 60 * 1000);
    vi.stubGlobal("fetch", fetchMock);

    const request = serverApi.stop();
    const rejection = expect(request).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 1000);
    await rejection;
  });

  it("backupApi.createBackup still gives up if the server genuinely never responds within 10 minutes", async () => {
    const fetchMock = slowFetchMock(30 * 60 * 1000);
    vi.stubGlobal("fetch", fetchMock);

    const request = backupApi.createBackup();
    const rejection = expect(request).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);
    await rejection;
  });

  // mod-settings-timeout investigation, 2026-09-08: getAllSandboxOptions is
  // panelBridgeApi.sendCommand's ONE caller that passes a timeout override
  // (ServerConfig.tsx's loadModSettings) instead of the shared 15s default
  // every other bridge command still gets. The override exists specifically
  // to sit above BOTH of server/services/panelBridge.js's own
  // commandTimeoutMs ceilings (15000ms local, 60000ms once a server is
  // configured over SFTP -- panelBridge.js:134/188/216) so the server's own
  // honest timeout response wins the race against our generic client abort,
  // rather than the reverse. This proves the override actually reaches the
  // real AbortController (not just that ServerConfig passes the right
  // literal to a mocked spy, which ServerConfig.modSettingsSlowTimeout.
  // test.tsx already covers) -- and that it is still bounded, not infinite.
  it("panelBridgeApi.sendCommand('getAllSandboxOptions', ...) does not abort before its slow-enumeration timeout, past both server-side ceilings", async () => {
    const fetchMock = slowFetchMock(65_000); // past 15s AND past the 60s SFTP ceiling
    vi.stubGlobal("fetch", fetchMock);

    const request = panelBridgeApi.sendCommand(
      "getAllSandboxOptions",
      {},
      { timeout: BRIDGE_SLOW_ENUMERATION_TIMEOUT_MS },
    );
    const resolution = expect(request).resolves.toMatchObject({ success: true });
    await vi.advanceTimersByTimeAsync(65_000);

    await resolution;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("panelBridgeApi.sendCommand('getAllSandboxOptions', ...) still gives up if the bridge genuinely never responds", async () => {
    const fetchMock = slowFetchMock(10 * 60 * 1000);
    vi.stubGlobal("fetch", fetchMock);

    const request = panelBridgeApi.sendCommand(
      "getAllSandboxOptions",
      {},
      { timeout: BRIDGE_SLOW_ENUMERATION_TIMEOUT_MS },
    );
    const rejection = expect(request).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(BRIDGE_SLOW_ENUMERATION_TIMEOUT_MS + 1000);
    await rejection;
  });
});
