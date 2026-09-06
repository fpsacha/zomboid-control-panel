// <img>-tag-loaded binary proxy routes (map tiles, mod thumbnails -- see
// services/auth.js's own comment grouping these as the same "loaded via
// <img>, no auth headers" category). Their bytes are already-compressed
// JPEG/PNG: gzipping them again buys near-zero size reduction, and forces
// Express to drop Content-Length in favour of chunked transfer encoding
// purely to save a few bytes it can't actually save -- extra surface for a
// misbehaving reverse proxy to get wrong for zero upside. If a proxy strips
// or mishandles Content-Encoding on a chunked response, the browser can end
// up decoding the still-gzip'd bytes directly as an image and fail (see
// client/src/pages/WorldMap.tsx's loadViaProxy, which detects and reports
// this specific case client-side).
export const UNCOMPRESSED_BINARY_PROXY_PREFIXES = [
  "/api/map/tiles/",
  "/api/map/toptiles/",
  "/api/map/b41tiles/",
  "/api/mods/thumbnail/",
];

// req is anything with a `.path` string (a real Express req, or a plain
// { path } object in a unit test) -- kept minimal so this stays testable
// without spinning up an app.
export function isUncompressedBinaryProxyPath(req) {
  return UNCOMPRESSED_BINARY_PROXY_PREFIXES.some((prefix) => req.path.startsWith(prefix));
}

// Server-Sent Event responses (Content-Type: text/event-stream) must never
// go through gzip/deflate/br. `compressible` classifies text/event-stream as
// compressible (it's text/*), so express's global compression() middleware
// wraps res.write in a real zlib Transform unless something opts it out --
// and zlib buffers written bytes internally until it decides to flush or the
// stream ends. Nothing in an SSE handler calls the `res.flush()` that
// `compression` attaches for exactly this case, so every event queued up
// behind zlib's buffer instead of reaching the client as it's produced,
// making a healthy long-running scan look hung/timed-out client-side.
// Setting `X-Accel-Buffering: no` does not help here -- that header is a
// signal to an nginx reverse proxy, not to this in-process compressor.
//
// res is anything with a `.getHeader` function (a real Express/http res, or
// a plain stub in a unit test) -- kept minimal so this stays testable
// without spinning up an app. Checked by content-type rather than by route
// path so any current or future SSE endpoint is covered without needing its
// own entry here.
export function isEventStreamResponse(res) {
  const contentType = res.getHeader("Content-Type");
  if (typeof contentType !== "string") return false;
  const mimeType = contentType.split(";")[0].trim();
  return mimeType === "text/event-stream";
}
