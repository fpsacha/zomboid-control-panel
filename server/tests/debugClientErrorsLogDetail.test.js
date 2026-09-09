import { afterEach, describe, expect, it } from "vitest";

// Support bundle 2026-09-08: combined.log had `[ClientError] Request failed,
// retrying (1/3)...` 17+ times and `[ClientError] Diagnostics auto-fix
// failed.` once, neither ever naming what actually failed. Both calls
// (client/src/lib/api.ts's reportClientWarning in its retry loop,
// client/src/pages/Debug.tsx's reportClientError in the auto-fix catch
// block) already send the real caught error's .message as `error` and the
// page the user was on as `url` -- client/src/lib/client-errors.ts's
// sendToServer() always populates both. This route received them, handed
// them to winston as the metadata argument, and BOTH printf formatters in
// server/utils/logger.js (consolePrintf/filePrintf) only ever interpolate
// level/message/timestamp/stack/source -- the detail was captured and then
// silently never written to combined.log/error.log. This test proves the
// fix folds it into the message text itself, the only part either printf
// renders, using the real winston logger via onLog() the same way other
// tests in this suite assert what actually reaches the log files (not a
// console.log spy, which would miss winston's real output path).

const { default: debugRouter } = await import("../routes/debug.js");
const { onLog } = await import("../utils/logger.js");

function createResponse() {
  const response = { status: () => response, json: () => response };
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  return response;
}

function getLayer(router, routePath, method) {
  return router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

async function runRoute(router, routePath, method, req) {
  const res = createResponse();
  const layer = getLayer(router, routePath, method);
  const handlers = layer.route.stack.map((s) => s.handle);
  let idx = -1;
  const next = async () => {
    idx++;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

const flush = () => new Promise((resolve) => setImmediate(resolve)); // CallbackTransport dispatches via setImmediate

describe("POST /debug/client-errors folds the real error detail and page URL into the logged line", () => {
  afterEach(() => {
    // Each test's rate-limit entry lives in module state keyed by req.ip;
    // using a distinct fake IP per test avoids needing to reach in and
    // reset it.
  });

  it("logs the error detail and page URL, not just the bare retry message", async () => {
    const logEntries = [];
    const unsubscribe = onLog((entry) => logEntries.push(entry));

    try {
      await runRoute(debugRouter, "/client-errors", "post", {
        ip: "10.0.0.1",
        body: {
          message: "Request failed, retrying (1/3)...",
          error: "Failed to fetch",
          url: "https://panel.example/servers/config",
        },
      });
      await flush();
    } finally {
      unsubscribe();
    }

    const line = logEntries.find(
      (e) => e.level === "warn" && e.message.includes("Request failed, retrying"),
    );
    expect(line).toBeDefined();
    expect(line.message).toContain("Failed to fetch");
    expect(line.message).toContain("https://panel.example/servers/config");
  });

  it("logs a bare message with no dangling separators when no error/url is sent (additive only)", async () => {
    const logEntries = [];
    const unsubscribe = onLog((entry) => logEntries.push(entry));

    try {
      await runRoute(debugRouter, "/client-errors", "post", {
        ip: "10.0.0.2",
        body: { message: "Something minor happened" },
      });
      await flush();
    } finally {
      unsubscribe();
    }

    const line = logEntries.find(
      (e) => e.level === "warn" && e.message.includes("Something minor happened"),
    );
    expect(line).toBeDefined();
    expect(line.message).toBe("[ClientError] Something minor happened");
  });
});
