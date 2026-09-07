import { describe, expect, it, vi } from "vitest";
import {
  apiErrorHandler,
  handlePanelUpdateDownload,
  registeredErrorCode,
} from "../index.js";
import { ErrorCode } from "../utils/errorCodes.js";

// Wire-level coverage for the 2026-08-22 code-reachability trace: the
// registry-membership test (errorCodeRegistry.test.js) proves a `code:`
// literal is registered, but says nothing about whether it actually
// survives to the JSON body a real client reads. These tests call the real,
// exported production functions with fake req/res and assert on the actual
// argument passed to res.json() -- not on source text.

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

// This is the fix from the 2026-08-22 reachability trace: without it, a
// thrown error's code was dropped here unconditionally (only err.message
// survived) -- the exact shape of the ServerNotConfiguredError bug found
// and fixed the same day. The allowlist is the point: it has to work BOTH
// ways, or it isn't an allowlist, it's a leak.
describe("apiErrorHandler: registry is an allowlist, not a passthrough", () => {
  it("forwards err.code when it is a registered ErrorCode value (uses APPLY_IN_PROGRESS_LEGACY -- the one code whose only other protection was a hand-written per-catch-site check)", () => {
    const res = createResponse();
    const err = new Error("An update apply is already in progress.");
    err.code = ErrorCode.APPLY_IN_PROGRESS_LEGACY;
    err.status = 409;

    apiErrorHandler(err, { method: "POST", path: "/api/panel/update-apply" }, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "apply_in_progress" }),
    );
  });

  it("does NOT forward an unregistered code (e.g. ENOENT, a raw Node internal) -- the load-bearing direction", () => {
    const res = createResponse();
    const err = new Error("ENOENT: no such file or directory, open '/some/path'");
    err.code = "ENOENT";

    apiErrorHandler(err, { method: "GET", path: "/api/some-route" }, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body).not.toHaveProperty("code");
    expect(body.error).toBeTypeOf("string");
  });

  it("does not forward a non-string err.code either (defensive -- a code should never be anything else, but the allowlist must not choke on it)", () => {
    const res = createResponse();
    const err = new Error("boom");
    err.code = 500;

    apiErrorHandler(err, { method: "GET", path: "/api/some-route" }, res, vi.fn());

    expect(res.json.mock.calls[0][0]).not.toHaveProperty("code");
  });
});

// handlePanelUpdateDownload hands checker.downloadUpdate()'s return value to
// res.json() unmodified in every failure branch -- these tests exist because
// that pass-through is exactly the kind of code a later, unrelated refactor
// narrows by accident ("just pull out success/error, why send the whole
// object") with nothing here today to notice.
describe("handlePanelUpdateDownload: downloadUpdate()'s result reaches res.json() intact", () => {
  function createRequest(checker) {
    return {
      body: {},
      app: { get: (key) => (key === "panelUpdateChecker" ? checker : undefined) },
    };
  }

  it("already_downloading: code survives to the named 409 branch", async () => {
    const res = createResponse();
    const checker = {
      dockerUpdateProxy: { enabled: false },
      downloadUpdate: vi.fn(async () => ({
        success: false,
        error: "Download already in progress",
        code: "already_downloading",
      })),
    };

    await handlePanelUpdateDownload(createRequest(checker), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "already_downloading" }),
    );
  });

  it("no_update: code survives to the named 400 branch", async () => {
    const res = createResponse();
    const checker = {
      dockerUpdateProxy: { enabled: false },
      downloadUpdate: vi.fn(async () => ({
        success: false,
        error: "No update available",
        code: "no_update",
      })),
    };

    await handlePanelUpdateDownload(createRequest(checker), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "no_update" }),
    );
  });

  // docker_updater_not_configured is set inside DockerUpdateProxy.apply()'s
  // own `if (!this.enabled)` branch -- but downloadUpdate() only ever calls
  // apply() from behind its OWN `if (this.dockerUpdateProxy.enabled)` guard
  // (panelUpdateChecker.js ~364-368), and `enabled` is a pure getter over
  // constructor-time env vars with nothing in between the two checks that
  // could change it. That makes this specific code effectively dead via its
  // only real call path today -- a separate finding from what this test
  // covers. This test proves the ROUTE's pass-through is safe for this code
  // IF it is ever produced (by a future caller of apply() outside
  // downloadUpdate(), or if that guard is ever loosened), independent of
  // whether it can happen today.
  it("docker_updater_not_configured: code survives to the generic fallback branch (currently unreachable via downloadUpdate()'s own guard -- see comment above)", async () => {
    const res = createResponse();
    const checker = {
      dockerUpdateProxy: { enabled: false },
      downloadUpdate: vi.fn(async () => ({
        success: false,
        error: "Docker update controller is not configured",
        code: "docker_updater_not_configured",
      })),
    };

    await handlePanelUpdateDownload(createRequest(checker), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "docker_updater_not_configured" }),
    );
  });

  it("success: the result object (no code) still passes through unmodified", async () => {
    const res = createResponse();
    const checker = {
      dockerUpdateProxy: { enabled: false },
      downloadUpdate: vi.fn(async () => ({ success: true, version: "1.2.3" })),
    };

    await handlePanelUpdateDownload(createRequest(checker), res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, version: "1.2.3" });
  });
});

// 2026-09-07, updateBundle reachability follow-up: POST /api/panel/restart's
// Linux-apply catch (index.js, "Failed to apply Linux staged update") built
// its own 500 body directly and never called next(err), so it never went
// through apiErrorHandler's allowlist above -- it just dropped err.code
// outright, silently, for every code applyUpdateBundle()/
// recoverInterruptedUpdateBundle() can throw (hash_unverifiable,
// binary_swap_failed, rollback_failed -- all three registered by Kevin in
// 11fe8dea, and still unobservable on the wire until this). Fixed by
// factoring the allowlist gate itself out of apiErrorHandler into
// registeredErrorCode() and having both call sites use the one
// implementation, instead of a second hand-rolled copy that could drift out
// of sync the same way this one silently did. This does not exercise the
// restart route's full handler directly (that handler runs 200+ lines deep
// into process.exit/spawn territory on its success path -- pulling it out
// for a supertest-style proof would be a much larger, riskier refactor of a
// shared, contended file for a 3-line fix); apiErrorHandler's own tests
// above already prove this exact function correct when reached via
// next(err), and the Linux-apply catch is a one-line call to the same
// function -- verified by reading index.js, not re-derived by a second
// implementation here.
describe("registeredErrorCode: the shared allowlist gate both apiErrorHandler and the Linux update-apply catch use", () => {
  it("forwards a registered code (one of the three the Linux-apply catch specifically needed: hash_unverifiable)", () => {
    const err = new Error("hash mismatch");
    err.code = ErrorCode.HASH_UNVERIFIABLE_LEGACY;
    expect(registeredErrorCode(err)).toBe("hash_unverifiable");
  });

  it("forwards the other two codes the Linux-apply catch can throw", () => {
    const binaryErr = new Error("swap failed");
    binaryErr.code = ErrorCode.BINARY_SWAP_FAILED_LEGACY;
    expect(registeredErrorCode(binaryErr)).toBe("binary_swap_failed");

    const rollbackErr = new Error("rollback failed");
    rollbackErr.code = ErrorCode.ROLLBACK_FAILED_LEGACY;
    expect(registeredErrorCode(rollbackErr)).toBe("rollback_failed");
  });

  it("does NOT forward a raw Node internal code -- e.g. EACCES/ENOSPC, exactly what chmod()/rename() set on a real disk-full or permission failure in this same code path", () => {
    const err = new Error("EACCES: permission denied, chmod '/opt/panel/app'");
    err.code = "EACCES";
    expect(registeredErrorCode(err)).toBeUndefined();
  });

  it("does not forward a non-string code", () => {
    const err = new Error("boom");
    err.code = 500;
    expect(registeredErrorCode(err)).toBeUndefined();
  });

  it("does not throw on an error with no code at all", () => {
    expect(registeredErrorCode(new Error("boom"))).toBeUndefined();
  });
});
