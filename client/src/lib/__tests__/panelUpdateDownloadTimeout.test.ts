import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { panelUpdateApi } from "../api";
import { clearAccessToken } from "../authToken";

// server/index.js's handlePanelUpdateDownload awaits the FULL binary +
// client-dist archive download (panelUpdateChecker.js's downloadUpdate())
// before responding at all -- there is no fire-and-poll split the way
// restart/apply has. A real download over a slow connection can easily
// exceed apiPost's default 15s fetchWithRetry timeout, which would abort
// the client's view of an update that is still legitimately in progress
// server-side and report a false "Download failed". This guards the fix:
// the download call must use a long (STALL_MS-class) timeout, not the
// generic API default.
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
        () => resolve(jsonResponse(200, { success: true, message: "staged" })),
        delayMs,
      );
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  });
}

describe("panelUpdateApi.download timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearAccessToken();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearAccessToken();
  });

  it("does not abort a download that takes longer than the generic 15s API timeout", async () => {
    const fetchMock = slowFetchMock(60_000); // 1 minute: past the old 15s default, well under 5 minutes
    vi.stubGlobal("fetch", fetchMock);

    const request = panelUpdateApi.download(false);
    const resolution = expect(request).resolves.toMatchObject({ success: true });
    await vi.advanceTimersByTimeAsync(60_000);

    await resolution;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still gives up if the server genuinely never responds within 5 minutes", async () => {
    const fetchMock = slowFetchMock(10 * 60 * 1000); // never resolves within the timeout window
    vi.stubGlobal("fetch", fetchMock);

    const request = panelUpdateApi.download(false);
    const rejection = expect(request).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
    await rejection;
  });
});
