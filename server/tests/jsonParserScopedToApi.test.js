import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import http from "http";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";
import express from "express";

// SECURITY: the app-wide 1 MB JSON parser had no path, while the /api rate
// limiter has one, so a POST to any other path had its body read and parsed
// before its 404 with no per-address limit; and a compressed body was only
// measured once inflated (a few bytes of brotli, 1 MB of parsing). The
// parser is now mounted where the limiter is, and refuses compressed
// bodies.
//
// The two blocks are lifted out of server/index.js and run against a test
// app, so an edit there changes this test. The limiter is a stand-in that
// marks the request: a body may be parsed only where it ran.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

function lift(startMarker, endMarker) {
  const start = indexSource.indexOf(startMarker);
  const end = indexSource.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`marker not found in index.js: ${startMarker} / ${endMarker}`);
  return indexSource.slice(start, end + endMarker.length);
}

const limiterBlock = lift("const apiLimiter = rateLimit({", 'app.use("/api/", apiLimiter);');
const parserBlock = lift('app.use("/api/debug/client-errors", express.json(', "appJsonParser(req, res, next)));");

let server;
let port;

beforeAll(async () => {
  const app = express();
  const rateLimit = () => (req, _res, next) => {
    req.limited = true;
    next();
  };
  new Function("app", "rateLimit", limiterBlock)(app, rateLimit);
  new Function("app", "express", parserBlock)(app, express);
  app.use((req, res) => res.json({ limited: Boolean(req.limited), parsed: req.body !== undefined }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.type || "error" }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// Raw http.request so the path is sent exactly as written (fetch would
// normalise "/api/../x" and friends).
function post(rawPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: rawPath, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("the app-wide JSON parser", () => {
  it("leaves the body of a request outside /api unread", async () => {
    for (const p of ["/", "/login", "/assets/x.js"]) {
      const res = await post(p, JSON.stringify({ a: 1 }));
      expect(res.body, p).toEqual({ limited: false, parsed: false });
    }
  });

  it("still parses an /api request, behind the limiter", async () => {
    const res = await post("/api/auth/login", JSON.stringify({ a: 1 }));
    expect(res.body).toEqual({ limited: true, parsed: true });
  });

  // Adversary pass: paths that might reach the parser but not the limiter.
  it("never parses a body the limiter did not see, whatever the path looks like", async () => {
    for (const p of ["/api", "/api/", "/API/x", "/Api/X", "/apix", "/api.x", "/%61pi/x", "//api/x", "/api/../x", "/x/../api/y", "/api%2Fx", "/api;x"]) {
      const res = await post(p, JSON.stringify({ a: 1 }));
      expect(res.status, p).toBe(200);
      if (res.body.parsed) expect(res.body.limited, `${p} parsed without the limiter`).toBe(true);
    }
  });

  it("refuses a compressed body instead of inflating it", async () => {
    const big = JSON.stringify(Array.from({ length: 50_000 }, () => ({})));
    for (const [encoding, data] of [
      ["gzip", zlib.gzipSync(big)],
      ["br", zlib.brotliCompressSync(big)],
      ["deflate", zlib.deflateSync(big)],
    ]) {
      const res = await post("/api/auth/login", data, { "content-encoding": encoding });
      expect(res.status, encoding).toBe(415);
    }
    const errors = await post("/api/debug/client-errors", zlib.gzipSync("{}"), { "content-encoding": "gzip" });
    expect(errors.status).toBe(415);
  });
});
