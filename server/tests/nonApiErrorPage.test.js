import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";

// Auth audit 2026-10-08, #24: the CORS check and the JSON body parser run
// on every path, but the only error handler was mounted on /api. A refused
// Origin or a malformed body anywhere else fell through to Express's own
// handler, which prints the stack trace (absolute install and module paths)
// whenever NODE_ENV isn't "production" -- and only the Docker images set
// it, not the exe, start.sh, Start.bat or npm start.

const settings = new Map();
const db = { data: { users: [], roles: [] } };

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getAllSettings: async () => Object.fromEntries(settings),
  getDb: async () => db,
  commitNow: async () => {},
  scheduleWrite: () => {},
  getRoles: async () => db.data.roles,
  getRoleById: async () => null,
  getRoleByName: async () => null,
  getUsersForRole: async () => [],
  peekServerDisplayName: () => null,
}));

const { app, io } = await import("../index.js");

let port;
let previousEnv;

function request(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

// What a stack trace leaks: frames, and the paths in them.
const STACK = /\bat\s+\S+\s+\(|node_modules|[A-Za-z]:\\|\/server\//;

beforeAll(async () => {
  // As the exe and script-started installs run: no NODE_ENV, so Express's
  // own error page is its development one.
  previousEnv = app.get("env");
  app.set("env", "development");
  await new Promise((resolve) => io.httpServer.listen(0, "127.0.0.1", resolve));
  port = io.httpServer.address().port;
});

afterAll(async () => {
  app.set("env", previousEnv);
  await new Promise((resolve) => io.httpServer.close(resolve));
});

describe("errors outside /api never show a stack trace", () => {
  it("GET / with a refused Origin answers a plain 403", async () => {
    const res = await request("GET", "/", { Origin: "https://evil.example" });

    expect(res.status).toBe(403);
    expect(res.text).toBe("Forbidden");
    expect(res.text).not.toMatch(STACK);
  });

  it("POST / with a malformed JSON body is not parsed and shows no stack trace", async () => {
    // The JSON body parser only runs on /api, so this body is never read.
    const res = await request("POST", "/", { "Content-Type": "application/json" }, "{bad");

    expect(res.status).not.toBe(500);
    expect(res.text).not.toMatch(/SyntaxError|JSON/);
    expect(res.text).not.toMatch(STACK);
  });
});
