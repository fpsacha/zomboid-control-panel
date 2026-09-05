import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";

// main-is-red overnight-sweep follow-up, 2026-09-05: fetchLatestReleaseOnce()
// (panelUpdateChecker.js ~:369) attaches res.on("data")/res.on("end") for
// both the success and non-200 branches, but never a res-level "error" or
// "aborted" handler, and relies solely on req.on("error", reject) to catch
// everything else. If the underlying connection dies mid-body-read (the
// response already exists, headers already arrived) in a way Node surfaces
// on `res` rather than re-propagating to `req`, neither "end" nor the req
// error listener ever fires -- the promise this function returns never
// settles. checkForUpdate()'s own try/finally (line ~278) only resets
// isChecking once its `await this.fetchLatestRelease()` actually settles,
// so a promise that never settles latches isChecking true forever and no
// later scheduled check ever runs (getStatus()'s isChecking gate at ~:274
// short-circuits every subsequent call).
let mockReq;
let mockRes;

vi.mock("https", () => ({
  default: {
    get: vi.fn((_options, callback) => {
      mockReq = new EventEmitter();
      mockReq.setTimeout = vi.fn();
      mockReq.destroy = vi.fn();
      mockRes = new EventEmitter();
      mockRes.statusCode = 500;
      mockRes.resume = vi.fn();
      // Real https.get invokes the response callback asynchronously; a
      // synchronous call here would let the test attach its "data"/abort
      // emissions before fetchLatestReleaseOnce()'s own res.on() calls run.
      setTimeout(() => callback(mockRes), 0);
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

describe("PanelUpdateChecker.checkForUpdate settles even when the GitHub response aborts mid-body", () => {
  it("resets isChecking instead of hanging forever when res never fires 'end' and req never fires 'error'", async () => {
    const checker = new PanelUpdateChecker({ emit: vi.fn() });
    checker.currentVersion = "1.0.0";

    const checkPromise = checker.checkForUpdate();
    // Wait for https.get's callback (scheduled via setTimeout(0) above) to
    // actually run and attach fetchLatestReleaseOnce()'s own listeners.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Non-200 status; some body arrives, then the connection dies without
    // "end" ever firing on res and without an "error" ever firing on req --
    // exactly the class of abort this function does not currently handle.
    mockRes.emit("data", Buffer.from("partial error body"));
    mockRes.emit("aborted");
    mockRes.emit("close");

    const result = await Promise.race([
      checkPromise.then(() => "SETTLED"),
      new Promise((resolve) => setTimeout(() => resolve("HUNG"), 1000)),
    ]);

    expect(result).toBe("SETTLED");
    expect(checker.isChecking).toBe(false);
  });
});
