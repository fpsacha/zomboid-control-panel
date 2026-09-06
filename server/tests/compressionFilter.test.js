import { describe, expect, it } from "vitest";
import {
  isUncompressedBinaryProxyPath,
  isEventStreamResponse,
  UNCOMPRESSED_BINARY_PROXY_PREFIXES,
} from "../utils/compressionFilter.js";

// bug-hunt-2026-08-26 / VastayanWings: index.js's global compression()
// middleware had no exclusion, so every map tile and mod thumbnail response
// (already-compressed JPEG/PNG, routinely tens of KB) got gzip-encoded on
// top, forcing Express to drop Content-Length for chunked transfer encoding
// for zero real size benefit -- extra surface for a reverse proxy to get
// wrong. This is the pure predicate the compression filter is built on.

describe("isUncompressedBinaryProxyPath", () => {
  it("excludes all four <img>-tag-loaded binary proxy prefixes", () => {
    expect(isUncompressedBinaryProxyPath({ path: "/api/map/tiles/12/3_4.jpg" })).toBe(true);
    expect(isUncompressedBinaryProxyPath({ path: "/api/map/toptiles/12/3_4.jpg" })).toBe(true);
    expect(isUncompressedBinaryProxyPath({ path: "/api/map/b41tiles/12/3_4.jpg" })).toBe(true);
    expect(isUncompressedBinaryProxyPath({ path: "/api/mods/thumbnail/1234567890" })).toBe(true);
  });

  it("does not exclude ordinary JSON API routes", () => {
    expect(isUncompressedBinaryProxyPath({ path: "/api/mods/status" })).toBe(false);
    expect(isUncompressedBinaryProxyPath({ path: "/api/map/geometry" })).toBe(false);
    expect(isUncompressedBinaryProxyPath({ path: "/api/servers" })).toBe(false);
  });

  it("does not exclude a path that merely starts similarly but isn't the real prefix", () => {
    // Guards against an overly loose match -- e.g. a hypothetical
    // /api/map/tilesetc route should not accidentally match "/api/map/tiles".
    expect(isUncompressedBinaryProxyPath({ path: "/api/map/tilesetcetera" })).toBe(false);
    expect(isUncompressedBinaryProxyPath({ path: "/api/mods/thumbnails" })).toBe(false);
  });

  it("keeps the prefix list exactly as documented -- a change here is a deliberate change to what stays uncompressed", () => {
    expect(UNCOMPRESSED_BINARY_PROXY_PREFIXES).toEqual([
      "/api/map/tiles/",
      "/api/map/toptiles/",
      "/api/map/b41tiles/",
      "/api/mods/thumbnail/",
    ]);
  });
});

// bug-hunt-2026-09-06 / god: text/event-stream is compressible by the
// `compressible` package's own mime rules, so it went through the same
// global gzip stream as ordinary JSON responses with no exemption -- zlib's
// internal buffering (never flushed, since no SSE route calls the
// `res.flush()` `compression` attaches) held every event until the stream
// ended, making a healthy conflict scan look timed-out client-side.
describe("isEventStreamResponse", () => {
  const stubRes = (contentType) => ({
    getHeader: (name) => (name === "Content-Type" ? contentType : undefined),
  });

  it("recognizes an SSE response by its Content-Type header", () => {
    expect(isEventStreamResponse(stubRes("text/event-stream"))).toBe(true);
  });

  it("recognizes an SSE response whose Content-Type carries a charset parameter", () => {
    expect(isEventStreamResponse(stubRes("text/event-stream; charset=utf-8"))).toBe(true);
  });

  it("does not flag ordinary JSON or HTML responses", () => {
    expect(isEventStreamResponse(stubRes("application/json; charset=utf-8"))).toBe(false);
    expect(isEventStreamResponse(stubRes("text/html"))).toBe(false);
  });

  it("does not flag a response with no Content-Type set yet", () => {
    expect(isEventStreamResponse(stubRes(undefined))).toBe(false);
  });

  it("does not false-positive on a merely similar content type", () => {
    // Guards against an overly loose match, mirroring the path-prefix test
    // above for isUncompressedBinaryProxyPath.
    expect(isEventStreamResponse(stubRes("text/event-streaming"))).toBe(false);
  });
});
