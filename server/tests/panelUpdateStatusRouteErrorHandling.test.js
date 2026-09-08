import { describe, expect, it } from "vitest";

// Hunt dispatch, 2026-09-08: sibling comparison across the five update
// routes. update-check, update-preflight, and update-apply-log all wrap
// "call a checker method, hand the result to res.json()" in a try/catch.
// update-status was the one that didn't -- found by reading it next to its
// three siblings, the same technique that found 45d9674d. Express's own
// dispatch would still catch a synchronous throw here and forward it to
// apiErrorHandler (confirmed separately via a real app.listen() probe), so
// this was never a live crash -- but it meant this one route produced a
// generic apiErrorHandler 500 instead of the same structured
// { error: sanitizeError(...) } shape every sibling gives for the same
// failure, and it depended on framework behavior nothing here asserted.
const { app } = await import("../index.js");

function getHandler(method, path) {
  const layer = app.router.stack.find(
    (l) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRes() {
  const res = { statusCode: 200, jsonBody: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.jsonBody = body;
    return res;
  };
  return res;
}

describe("GET /api/panel/update-status", () => {
  it("returns a structured 500 instead of throwing when checker.getStatus() throws", () => {
    const handler = getHandler("get", "/api/panel/update-status");
    const throwingChecker = {
      getStatus: () => {
        throw new TypeError("Cannot read properties of undefined (reading 'mode')");
      },
    };
    const req = {
      app: { get: (key) => (key === "panelUpdateChecker" ? throwingChecker : undefined) },
    };
    const res = makeRes();

    expect(() => handler(req, res)).not.toThrow();
    expect(res.statusCode).toBe(500);
    expect(res.jsonBody).toEqual(
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it("still returns the real status on the happy path", () => {
    const handler = getHandler("get", "/api/panel/update-status");
    const checker = { getStatus: () => ({ currentVersion: "1.0.0" }) };
    const req = {
      app: { get: (key) => (key === "panelUpdateChecker" ? checker : undefined) },
    };
    const res = makeRes();

    handler(req, res);

    expect(res.jsonBody).toEqual({ currentVersion: "1.0.0" });
  });
});
