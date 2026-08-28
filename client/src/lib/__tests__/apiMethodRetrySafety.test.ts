import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../api";
import { clearAccessToken, setAccessToken } from "../authToken";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("API retry method safety", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearAccessToken();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearAccessToken();
  });

  it.each(["GET", "HEAD", "OPTIONS"])(
    "retries transient %s requests",
    async (method) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(503, { error: "temporary" }))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
      vi.stubGlobal("fetch", fetchMock);

      const request = apiFetch("/safe", { method });
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(request).resolves.toMatchObject({ status: 200 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "sends a %s mutation only once after a server failure",
    async (method) => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse(503, { error: "result is unknown" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const request = apiFetch("/mutation", { method });
      await vi.advanceTimersByTimeAsync(20_000);
      const response = await request;

      expect(response.status).toBe(503);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retry a mutation after a network failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const request = apiFetch("/mutation", { method: "POST" });
    const rejection = expect(request).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a rate-limited safe request but not a rate-limited mutation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "slow down" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
      .mockResolvedValueOnce(jsonResponse(429, { error: "slow down" }));
    vi.stubGlobal("fetch", fetchMock);

    const safeRequest = apiFetch("/safe");
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await safeRequest).status).toBe(200);

    const mutation = apiFetch("/mutation", { method: "POST" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await mutation).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("replays a mutation once when the server explicitly reports TOKEN_EXPIRED", async () => {
    setAccessToken("expired-token");
    let targetCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/refresh")) {
        return jsonResponse(200, { accessToken: "fresh-token" });
      }
      targetCalls += 1;
      return targetCalls === 1
        ? jsonResponse(401, { code: "TOKEN_EXPIRED", error: "expired" })
        : jsonResponse(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await apiFetch("/mutation", { method: "POST" });

    expect(response.status).toBe(200);
    expect(targetCalls).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not refresh or replay an unrelated 401", async () => {
    setAccessToken("valid-token");
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(401, { code: "ACCOUNT_DISABLED", error: "disabled" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await apiFetch("/protected");

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a transient failure after the single authentication replay", async () => {
    setAccessToken("expired-token");
    let targetCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/refresh")) {
        return jsonResponse(200, { accessToken: "fresh-token" });
      }
      targetCalls += 1;
      return targetCalls === 1
        ? jsonResponse(401, { code: "TOKEN_EXPIRED", error: "expired" })
        : jsonResponse(503, { error: "result is unknown" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = apiFetch("/safe");
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await request;

    expect(response.status).toBe(503);
    expect(targetCalls).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
