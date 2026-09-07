import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

// unlistened-emitter class sweep, 2026-09-07 (god's dispatch, same shape as
// server/utils/uploadStream.js's CI-crashing bug): GET /logs/download-zip
// (the support-bundle download) did
// `archive.append(fs.createReadStream(entry.filePath).pipe(createRedactingLogStream(...)), ...)`
// per entry, with no error handler on the raw read stream. pipe() does not
// forward a source's own 'error' events to its destination -- archiver's own
// archive.on("error", ...) only ever sees errors from the Transform it was
// given, never from the raw fs stream feeding it. Any one of the enumerated
// log files rotating, being deleted, or hitting a read error mid-bundle
// (a real race with the sibling POST /logs/clear route) crashed the whole
// process, not just this one request -- exactly uploadStream.js's shape,
// found the same night.
//
// This file already has the correct convention 80 lines up, on the singular
// /logs/download route (attach .on("error", ...) before .pipe()) -- the zip
// route was the one that missed applying it per-entry. Fix factors that
// handler out as handleArchiveFailure and attaches it to each entry's raw
// read stream too.
//
// Verification technique (same as modsExtensionBundleStreamError.test.js):
// capture the real stream instance createReadStream() hands back and emit a
// real 'error' on it directly. Node's own documented semantics are the
// oracle -- .emit("error", err) throws synchronously with zero listeners and
// doesn't with at least one -- so wrapping the emit in try/catch proves the
// mechanism without any risk of actually crashing this test run.

// getDataPaths() is read at MODULE-LOAD time by several other server
// modules (logger.js, database/init.js, serverManager.js) to set up real
// directories/DB files -- redirecting it with a partial vi.mock() shape
// breaks those unrelated modules (they need dataDir/dbPath too, not just
// logsDir). Simplest safe route: use the REAL getDataPaths(), which this
// project's own per-file setupFiles already points at an isolated temp dir
// via PANEL_PATHS_CONFIG_PATH -- just drop the fixture log file into
// wherever that real (isolated) logsDir actually resolves to.
const { getDataPaths } = await import("../utils/paths.js");
const logsDir = getDataPaths().logsDir;
fs.mkdirSync(logsDir, { recursive: true });
fs.writeFileSync(path.join(logsDir, "combined.log"), "hello world\n");

const { default: router } = await import("../routes/debug.js");

function getHandler(routePath) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods.get,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function makeRes() {
  const res = {
    headersSent: false,
    statusCode: null,
    jsonBody: null,
    destroyed: false,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return {
        json: (body) => {
          this.jsonBody = body;
        },
        end: () => {},
      };
    },
    destroy() {
      this.destroyed = true;
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    write() {
      return true;
    },
    end() {},
    emit() {
      return false;
    },
  };
  return res;
}

describe("GET /logs/download-zip attaches an error handler to each entry's raw read stream", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a real stream error after the handler runs does not throw unhandled, and fails the bundle instead of the process", async () => {
    const capturedStreams = [];
    const realCreateReadStream = fs.createReadStream.bind(fs);
    vi.spyOn(fs, "createReadStream").mockImplementation((...args) => {
      const real = realCreateReadStream(...args);
      capturedStreams.push(real);
      return real;
    });

    const handler = getHandler("/logs/download-zip");
    const res = makeRes();
    await handler({}, res);

    // At least the fixture combined.log was staged -- the real winston
    // logger active during this very request may also have written its own
    // error.log by request time, so more than one entry is possible; every
    // one of them still needs its own error handler.
    expect(capturedStreams.length).toBeGreaterThan(0);
    const [entryStream] = capturedStreams;

    // The whole point of the fix: at least one 'error' listener must be on
    // EVERY per-entry raw read stream BEFORE anything can go wrong with it.
    for (const stream of capturedStreams) {
      expect(stream.listenerCount("error")).toBeGreaterThan(0);
    }

    let threw = false;
    try {
      entryStream.emit("error", new Error("simulated read failure"));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // Either branch of handleArchiveFailure proves it ran: 500 (headers not
    // sent yet in this fake res) or a destroy (headers already "sent").
    expect(res.statusCode === 500 || res.destroyed).toBe(true);
  });
});
