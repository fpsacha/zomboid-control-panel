import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import { Readable } from "stream";

// unlistened-emitter class sweep, 2026-09-07 (god's dispatch, same shape as
// server/utils/uploadStream.js's CI-crashing bug): GET
// /api/mods/collection/extension-bundle did
// `fs.createReadStream(zipPath).pipe(res);` with zero 'error' handler.
// createReadStream opens ASYNCHRONOUSLY -- a stat a few lines up does not
// guarantee the file is still readable by the time the real open/read
// happens -- and pipe() does not forward the source stream's own errors to
// its destination. An EventEmitter that emits 'error' with no listener
// throws OUT OF THE PROCESS, not just out of this one request: exactly the
// failure shape CI caught on server/utils/uploadStream.js the same night
// (all tests passed, Vitest still exited 1 on "1 error").
//
// Verification technique: capture the real stream instance createReadStream()
// hands back, then emit a real 'error' on it directly. Node's own documented
// semantics are the oracle here -- .emit("error", err) throws synchronously
// out of that call when there are zero listeners, and does not throw when at
// least one exists -- so wrapping the emit in try/catch proves the mechanism
// without any risk of actually crashing this test run (unlike letting a real
// async fs failure hit an unfixed handler would).

const { default: router } = await import("../routes/mods.js");

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
    ended: false,
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
        end: () => {
          this.ended = true;
        },
      };
    },
    destroy() {
      this.destroyed = true;
    },
    // Minimal Writable-shaped surface so Readable#pipe() can attach to it
    // without throwing -- this test never lets real bytes flow.
    on() {
      return this;
    },
    once() {
      return this;
    },
    write() {
      return true;
    },
    end() {
      this.ended = true;
    },
    emit() {
      return false;
    },
  };
  return res;
}

describe("GET /api/mods/collection/extension-bundle attaches an error handler to its zip read stream", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a real stream error after the handler runs does not throw unhandled, and fails the request instead of the process", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "statSync").mockReturnValue({ size: 42 });
    let capturedStream;
    vi.spyOn(fs, "createReadStream").mockImplementation(() => {
      capturedStream = new Readable({ read() {} });
      return capturedStream;
    });

    const handler = getHandler("/collection/extension-bundle");
    const res = makeRes();
    await handler({}, res);

    expect(capturedStream).toBeDefined();
    // The whole point of the fix: at least one 'error' listener must be on
    // the stream BEFORE anything can go wrong with it, not attached
    // reactively after the fact.
    expect(capturedStream.listenerCount("error")).toBeGreaterThan(0);

    let threw = false;
    try {
      capturedStream.emit("error", new Error("simulated read failure"));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(res.statusCode).toBe(500);
  });
});
