import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Support bundle 2026-09-08: 300+ of error.log's 429 lines were
// `[ERROR] [Panel] Unhandled API error on GET /mods/thumbnail/<id>: Not
// Found` -- by far the largest thing in the file, burying every other real
// error (the Discord DNS failures, the EACCES cluster) right next to it. A
// missing thumbnail is a completely normal, expected condition and every
// OTHER failure path in this route already falls back to the placeholder
// gif via sendEmptyThumbnail() instead of propagating -- this was the one
// path that didn't: res.sendFile(cacheFile) with no callback. Express's
// documented default when sendFile has no callback and the send fails is
// next(err) (Express binds a response to its own req/next internally, so
// this happens even with no explicit callback given) -- which lands in
// server/index.js's generic apiErrorHandler and gets logged at ERROR
// severity with the literal message "Not Found", matching the bundle
// exactly. The trigger (the cache file vanishing between the stat() a few
// lines above and this call, a permission problem, anything) doesn't
// matter for this test -- what matters is that a failed send must not
// escape as an unhandled error, the same way every other failure in this
// route already doesn't. The fake response below mirrors that real
// Express default (falls back to `next(err)` when no callback is given)
// so the test genuinely fails on the pre-fix code instead of accidentally
// routing around it.

vi.mock("../database/init.js", () => ({
  getTrackedMods: vi.fn(async () => []),
  setModPreviewUrl: vi.fn(),
}));

vi.mock("../utils/paths.js", () => ({
  getDataPaths: vi.fn(),
}));

// Same rationale as modThumbnailResolution.test.js: mock the logger so a
// real winston instance doesn't write actual log files into the mkdtemp'd
// tempRoot this test also fs.rmSync's in afterEach.
vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createResponse(next, { sendFileError } = {}) {
  const response = {};
  let statusCode = 200;
  let ended = null;
  const headers = {};
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.end = (body) => {
    ended = body ?? true;
    return response;
  };
  response.setHeader = (name, value) => {
    headers[name] = value;
  };
  response.headersSent = false;
  // Mirrors real Express: sendFile(path, callback) invokes the callback on
  // error when one is given; sendFile(path) with NO callback falls back to
  // next(err) -- exactly the escape hatch the pre-fix code relied on.
  response.sendFile = (filePath, callback) => {
    if (sendFileError) {
      if (callback) {
        callback(sendFileError);
      } else {
        next(sendFileError);
      }
      return response;
    }
    ended = fs.readFileSync(filePath);
    if (callback) callback();
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getEnded = () => ended;
  response.getHeaders = () => headers;
  return response;
}

function getRouteHandlers(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

async function runThumbnailRoute(router, workshopId, sendFileOpts) {
  const handlers = getRouteHandlers(router, "/thumbnail/:workshopId", "get");
  const req = { params: { workshopId } };
  let idx = -1;
  let escapedError = null;
  const next = async (err) => {
    if (err) {
      escapedError = err;
      return;
    }
    idx++;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  const res = createResponse(next, sendFileOpts);
  await next();
  return { res, escapedError };
}

async function freshModule(tempRoot) {
  vi.resetModules();
  const { getDataPaths } = await import("../utils/paths.js");
  getDataPaths.mockReturnValue({ dataDir: tempRoot, logsDir: tempRoot });
  return await import("../routes/mods.js");
}

describe("GET /thumbnail/:workshopId -- a cached file that fails to send falls back to the placeholder instead of escaping as an unhandled error", () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mod-thumb-sendfile-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("falls back to the placeholder gif and records the failure -- does NOT escape to next(err) as an unhandled 'Not Found'", async () => {
    const cacheDir = path.join(tempRoot, "mod-thumbnails");
    fs.mkdirSync(cacheDir, { recursive: true });
    // A real cached file, so the stat() above the sendFile call succeeds
    // and the route takes the sendFile branch this fix touches.
    fs.writeFileSync(path.join(cacheDir, "444.img"), Buffer.from([1, 2, 3]));

    const { default: router, getThumbnailResolutionStatus } = await freshModule(tempRoot);

    const notFoundErr = new Error("Not Found");
    notFoundErr.status = 404;

    const { res, escapedError } = await runThumbnailRoute(router, "444", {
      sendFileError: notFoundErr,
    });

    // The core assertion: this must NOT be the caller's job to handle via
    // next(err)/apiErrorHandler anymore.
    expect(escapedError).toBeNull();

    expect(res.getHeaders()["Content-Type"]).toBe("image/gif");
    const status = await getThumbnailResolutionStatus();
    expect(status.lastError).toMatchObject({ workshopId: "444" });
  });

  it("still streams the real cached bytes on the ordinary success path (additive only, not a shape change for the common case)", async () => {
    const cacheDir = path.join(tempRoot, "mod-thumbnails");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "555.img"), Buffer.from([9, 9, 9]));

    const { default: router } = await freshModule(tempRoot);

    const { res, escapedError } = await runThumbnailRoute(router, "555");

    expect(escapedError).toBeNull();
    expect(res.getHeaders()["Content-Type"]).toBe("image/jpeg");
    expect(Buffer.from(res.getEnded())).toEqual(Buffer.from([9, 9, 9]));
  });
});
