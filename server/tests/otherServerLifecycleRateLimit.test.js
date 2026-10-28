import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import rateLimit from "express-rate-limit";

// Security audit 2026-10-28: Start/Stop/Restart of a server other than the
// active one (POST /api/servers/:id/start|stop|restart, the Dashboard's
// server list) had no strict rate limit, while the active server's
// /api/server/start|stop|restart did; a server.control holder could start
// and kill game servers in a tight loop. Both now share the strict budget.
// The limiter block is lifted out of index.js, so an edit there changes this
// test.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const startMarker = "const strictLimiter = rateLimit({";
const endMarker = 'app.use("/api/mods/collection/extract-cookies", strictLimiter);';
const start = indexSource.indexOf(startMarker);
const limiterBlock = indexSource.slice(start, indexSource.indexOf(endMarker, start) + endMarker.length);

let server;
let baseUrl;

beforeEach(async () => {
  const app = express();
  new Function("app", "rateLimit", limiterBlock)(app, rateLimit);
  const ok = (_req, res) => res.json({ success: true });
  app.post("/api/server/start", ok);
  app.post("/api/servers/:id/start", ok);
  app.post("/api/servers/:id/stop", ok);
  app.post("/api/servers/:id/restart", ok);
  app.post("/api/servers/:id/activate", ok);
  app.get("/api/servers/:id", ok);
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const call = async (method, url) => (await fetch(`${baseUrl}${url}`, { method })).status;

describe("Start/Stop/Restart of another server is rate limited like the active server's", () => {
  it.each(["start", "stop", "restart"])("POST /api/servers/:id/%s stops after 10 a minute", async (verb) => {
    for (let i = 0; i < 10; i++) expect(await call("POST", `/api/servers/${i % 3}/${verb}`)).toBe(200);
    expect(await call("POST", `/api/servers/7/${verb}`)).toBe(429);
  });

  // Adversary pass: switching between the active server's buttons and
  // another server's (or between servers) does not get a fresh budget.
  it("shares one budget with the active server's Start", async () => {
    for (let i = 0; i < 5; i++) expect(await call("POST", "/api/server/start")).toBe(200);
    for (let i = 0; i < 5; i++) expect(await call("POST", `/api/servers/${i}/stop`)).toBe(200);
    expect(await call("POST", "/api/server/start")).toBe(429);
    expect(await call("POST", "/api/servers/99/restart")).toBe(429);
  });

  it("leaves reads and other server routes alone", async () => {
    for (let i = 0; i < 10; i++) await call("POST", "/api/servers/1/start");
    expect(await call("GET", "/api/servers/1")).toBe(200);
    expect(await call("POST", "/api/servers/1/activate")).toBe(200);
  });
});
