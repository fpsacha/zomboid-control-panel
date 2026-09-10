import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";

// timeout-handling-consistency-sweep, 2026-09-10 (god's fix #6): fetchReleaseText
// (panelUpdateChecker.js, used by verifyChecksum() to fetch checksums.txt) is
// the third call site sharing GITHUB_API_TIMEOUT_MS -- fetchLatestReleaseOnce
// (~:491) and downloadFile (~:1714) both tag a fired timeout with
// .code="ETIMEDOUT"; this one didn't, so isRetryableGitHubError() (which
// branches on .code) silently bucketed a checksum-fetch timeout as
// non-retryable while the identical timeout anywhere else on the same
// constant was retried.
let mockReq;
let timeoutCallback;

vi.mock("https", () => ({
  default: {
    get: vi.fn((_url, _options, _callback) => {
      mockReq = new EventEmitter();
      mockReq.setTimeout = vi.fn((_ms, cb) => {
        timeoutCallback = cb;
      });
      // Real http(s) ClientRequest#destroy(err) emits 'error' with that err
      // asynchronously -- mirror that so req.on("error", reject) actually fires.
      mockReq.destroy = vi.fn((err) => {
        if (err) queueMicrotask(() => mockReq.emit("error", err));
      });
      return mockReq;
    }),
  },
}));

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

vi.mock("./dockerUpdateProxy.js", () => ({
  DockerUpdateProxy: vi.fn(function DockerUpdateProxy() {
    this.mode = "none";
  }),
}));

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");

describe("PanelUpdateChecker.fetchReleaseText: timeout is tagged .code=ETIMEDOUT like its GITHUB_API_TIMEOUT_MS siblings", () => {
  it("rejects with a .code=ETIMEDOUT error when the request's own timeout fires, and isRetryableGitHubError recognizes it", async () => {
    const checker = new PanelUpdateChecker({ emit: vi.fn() });
    checker.currentVersion = "1.0.0";

    const promise = checker.fetchReleaseText(
      "https://github.com/owner/repo/releases/download/v1/checksums.txt",
    );

    expect(timeoutCallback).toBeTypeOf("function");
    timeoutCallback();

    await expect(promise).rejects.toMatchObject({ code: "ETIMEDOUT" });
    await expect(promise).rejects.toBeInstanceOf(Error);

    // The actual downstream consumer this bug silently broke: a timeout
    // must classify as retryable the same way every other ETIMEDOUT does.
    expect(checker.isRetryableGitHubError({ code: "ETIMEDOUT" })).toBe(true);
  });
});
