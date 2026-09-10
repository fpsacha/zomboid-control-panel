import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";

// hunt-wave10-2026-08-29, suspect 4 (REAL): serveTile() set
// Cache-Control: public, max-age=604800 (7 days) on every tile response,
// but the browser-facing URL (/api/map/tiles/:level/:tile) has no
// component identifying WHICH resolved B42 build (getB42Dir()) produced
// the bytes -- only this server's own disk cache is namespaced by that
// build directory (relPath includes `dir`). If the resolved build changes
// while a browser still holds a 7-day-old cached response for the same
// URL, that browser keeps showing bytes from the OLD build indefinitely
// (up to the rest of the 7-day window) -- "operator regenerates map,
// browser keeps showing the old world", the exact shape god's card named.
//
// Fix: bound the browser-facing Cache-Control to the same freshness
// window as /resolve's own descriptor (1h), so staleness can never
// outlive the client's own belief about the current build by more than
// that -- serveTile's own disk/mem tiers stay correctly namespaced by
// `dir` and keep making a "miss" here instant, so this costs nothing on
// the hot path, only bounds how long a WRONG answer can survive.
//
// This test calls the real route handlers directly (same pattern as
// mapProxyRenderedMaxLevel.test.js's findRoute helper) against all three
// cache tiers (miss / hit-mem / hit-disk) for both tile routes that go
// through serveTile() with a `dir`-namespaced disk path (/tiles,
// /toptiles) plus /b41tiles (fixed build, still shares serveTile()).

const mockExecFile = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args) => mockExecFile(...args),
}));

function curlResult(status, body) {
  return { stdout: `${body}\n__CURL_HTTP_STATUS__:${status}`, stderr: "" };
}

function mockCurlRouter(impl) {
  mockExecFile.mockImplementation((_file, args, _options, callback) => {
    const url = args[args.length - 1];
    try {
      callback(null, impl(url));
    } catch (err) {
      callback(err);
    }
  });
}

const GEOMETRY_42_20_0 = { tileSize: 2048, width: 2318656, height: 1019040 };

function dziXml(g) {
  return `<?xml version="1.0"?><Image TileSize="${g.tileSize}" Overlap="0" Format="jpg"><Size Width="${g.width}" Height="${g.height}"/></Image>`;
}

function mapInfoJson() {
  return JSON.stringify({ x0: 1040384, y0: -139296, sqr: 128, skip: 0 });
}

function mockCurlForB42_20_0() {
  mockCurlRouter((url) => {
    if (url.endsWith("/api/builds/default")) {
      return curlResult(200, JSON.stringify({ directory: "42.20.0", default: true }));
    }
    if (url.includes("/base/layer0.dzi")) return curlResult(200, dziXml(GEOMETRY_42_20_0));
    if (url.includes("/base/map_info.json")) return curlResult(200, mapInfoJson());
    throw new Error(`unexpected curl URL in test: ${url}`);
  });
}

// Real upstream tile bytes for GET requests; HEAD requests (coverage
// probes / discoverRenderedMaxLevel's binary search) always report covered
// so build resolution completes without needing to model the search.
function mockFetchServingTiles() {
  return vi.fn(async (url, init) => {
    if ((init?.method || "GET") === "HEAD") return { ok: true };
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode("fake-jpeg-bytes").buffer,
    };
  });
}

// 2026-08-31, flake-class-fixed-margin-sync follow-up: the poll loop this
// replaces (freshModule() -> re-invoke the full handler -> sleep 10ms ->
// repeat, up to a 10s deadline) has an observer-effect bug, not just a slow
// margin. Each retry that still sees a disk miss re-enters serveTile()'s
// miss branch, which is NOT idempotent -- it calls writeDiskCacheAsync()
// AGAIN, kicking off a brand new mkdir/writeFile/rename chain racing the
// original one for the SAME destination path. Measured directly (temporary
// call-counting instrumentation on fs.promises.rename during this test):
// writeFile and rename were each invoked 9 TIMES for what should be exactly
// one real write, before the loop happened to observe a landed file. Under
// real multi-agent CPU/IO contention (the exact scenario the artificial
// delay below simulates), a bigger pile of colliding, silently-caught
// (writeDiskCacheAsync's own .catch()) renames competing for the same
// destination is a far more direct explanation for an occasional 10s
// timeout than raw CPU cost from re-importing the module -- the poll was
// multiplying the very I/O it was waiting to observe finish.
// Fix: instead of re-triggering the write path on every retry, capture the
// Promise of the ONE real rename() call the initial (warm) request kicks
// off, and await that directly. No retries, no duplicate writes, and the
// fresh-module cold-cache check now runs exactly once, after the real
// write is confirmed complete -- matching what these tests actually meant
// to assert (a disk hit is found once the write has landed), not "keep
// re-asking until it happens to look landed."
//
// MUST filter by destination filename, not just "the first rename() call
// observed". Found this the hard way: an earlier version captured the
// bare first call and, under stress-looped runs, intermittently threw an
// uncaught EPERM from a completely unrelated tile -- an EARLIER test's own
// unawaited writeDiskCacheAsync chain (fire-and-forget, still in flight
// when the next test starts) called rename() while this spy happened to be
// active, and the untargeted version happily captured THAT call instead of
// this test's own. Matching on the destination's filename makes the spy
// only ever resolve on the rename this specific test actually triggered.
function captureFirstRename({ tileFileName, extraDelayMs = 0 }) {
  const realRename = fs.promises.rename;
  let resolveFirst;
  const firstRenamePromise = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  let seenFirst = false;
  const renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (...args) => {
    const dest = args[1];
    if (typeof dest !== "string" || !dest.endsWith(tileFileName)) {
      return realRename.apply(fs.promises, args);
    }
    if (extraDelayMs > 0) await new Promise((r) => setTimeout(r, extraDelayMs));
    const result = realRename.apply(fs.promises, args);
    if (!seenFirst) {
      seenFirst = true;
      resolveFirst(result);
    }
    return result;
  });
  async function awaitFirstRename(timeoutMs = 10000) {
    let timeoutHandle;
    const timeout = new Promise((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`No rename() call observed within ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([firstRenamePromise, timeout]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
  return { renameSpy, awaitFirstRename };
}

function findRoute(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRes() {
  const headers = {};
  let statusCode = 200;
  let sentBody = null;
  return {
    headers,
    get statusCode() {
      return statusCode;
    },
    get sentBody() {
      return sentBody;
    },
    set(name, value) {
      headers[name] = value;
      return this;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    end() {
      return this;
    },
    send(body) {
      sentBody = body;
      return this;
    },
    json(body) {
      sentBody = body;
      return this;
    },
  };
}

async function freshModule() {
  vi.resetModules();
  return await import("../routes/mapProxy.js");
}

beforeEach(() => {
  mockExecFile.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

describe("suspect 4 (REAL): tile Cache-Control must not outlive the build-resolution freshness window", () => {
  it("/tiles: a fresh upstream fetch (tier-3 miss) is capped at the /resolve freshness window, not 7 days", async () => {
    mockCurlForB42_20_0();
    const originalFetch = global.fetch;
    global.fetch = mockFetchServingTiles();
    // A tile path not shared with any other test (see captureFirstRename's
    // header comment) -- this test's own disk write must be awaited before
    // returning, and if it shared "2_3.jpg" with the in-memory-hit test
    // below, awaiting here would make that test's own tier-1 miss land on
    // disk first and turn it into a false "hit-disk".
    const { renameSpy, awaitFirstRename } = captureFirstRename({ tileFileName: "0_0.jpg" });
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/tiles/:level/:tile", "get");
      const res = makeRes();
      await handler({ params: { level: "5", tile: "0_0.jpg" }, query: {} }, res);

      expect(res.headers["X-Tile-Cache"]).toBe("miss");
      expect(res.headers["Cache-Control"]).not.toMatch(/604800/);
      expect(res.headers["Cache-Control"]).toBe("public, max-age=3600");

      // writeDiskCacheAsync() is fire-and-forget in production (correct --
      // a live request never blocks on it) but this test must not return
      // while it's still landing a file: vitest.perFileDataDir.setup.mjs's
      // afterAll deletes this file's own temp dataDir the moment every
      // `it()` here has returned, and a write still in flight at that
      // instant can lose an ENOTEMPTY race against that rmSync on Windows
      // (reproduced directly, see that file's own comment).
      await awaitFirstRename();
    } finally {
      global.fetch = originalFetch;
      renameSpy.mockRestore();
    }
  });

  it("/tiles: an in-memory hit (tier-1) reports the SAME bounded Cache-Control as a miss, not the old long-lived value", async () => {
    mockCurlForB42_20_0();
    const originalFetch = global.fetch;
    global.fetch = mockFetchServingTiles();
    const { renameSpy, awaitFirstRename } = captureFirstRename({ tileFileName: "2_3.jpg" });
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/tiles/:level/:tile", "get");

      const first = makeRes();
      await handler({ params: { level: "5", tile: "2_3.jpg" }, query: {} }, first);
      expect(first.headers["X-Tile-Cache"]).toBe("miss");
      // The second call below hits tier-1 (in-memory) regardless of disk
      // state, so awaiting here doesn't affect it -- it just makes sure
      // this test's own write has landed before the test (and eventually
      // the file's afterAll) returns.
      await awaitFirstRename();

      const second = makeRes();
      await handler({ params: { level: "5", tile: "2_3.jpg" }, query: {} }, second);
      expect(second.headers["X-Tile-Cache"]).toBe("hit-mem");
      expect(second.headers["Cache-Control"]).toBe("public, max-age=3600");
    } finally {
      global.fetch = originalFetch;
      renameSpy.mockRestore();
    }
  });

  it("/tiles: a disk hit (tier-2, fresh module instance so tier-1 is cold) ALSO reports the bounded Cache-Control -- proving the fix covers all three tiers, not just the miss path", async () => {
    mockCurlForB42_20_0();
    const originalFetch = global.fetch;
    global.fetch = mockFetchServingTiles();
    // writeDiskCacheAsync is fire-and-forget (mkdir -> writeFile -> rename,
    // three real fs calls the request handler deliberately never awaits).
    // Capture the one real rename() this request's write chain makes and
    // await it directly instead of polling by re-invoking the handler --
    // see captureFirstRename's comment for why re-invoking was itself the
    // bug, not just a slow margin.
    const { renameSpy, awaitFirstRename } = captureFirstRename({ tileFileName: "1_1.jpg" });
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/tiles/:level/:tile", "get");
      // A tile path not used by the two tests above (both use 2_3.jpg) --
      // discovered directly, not theorised: awaiting the real rename here
      // instead of retrying surfaced an intermittent EPERM on Windows
      // (~2/15 runs), because 2_3.jpg's OWN earlier fire-and-forget writes
      // from those two tests are not guaranteed to have finished landing by
      // the time this test starts, and their rename can collide with this
      // test's rename to the same destination. The old poll silently
      // absorbed that exact collision (writeDiskCacheAsync's own .catch())
      // and just retried until some write eventually won; awaiting one
      // specific rename directly means a real collision surfaces instead of
      // getting silently retried away. Same reasoning already applied to
      // the test below (9_9.jpg) -- give each test its own tile so
      // cross-test fire-and-forget writes never target the same path.
      const warm = makeRes();
      await handler({ params: { level: "5", tile: "1_1.jpg" }, query: {} }, warm);
      expect(warm.headers["X-Tile-Cache"]).toBe("miss");

      await awaitFirstRename();

      mockCurlForB42_20_0();
      const { default: freshRouter } = await freshModule();
      const freshHandler = findRoute(freshRouter, "/tiles/:level/:tile", "get");
      const cold = makeRes();
      await freshHandler({ params: { level: "5", tile: "1_1.jpg" }, query: {} }, cold);

      expect(cold.headers["X-Tile-Cache"]).toBe("hit-disk");
      expect(cold.headers["Cache-Control"]).toBe("public, max-age=3600");
    } finally {
      global.fetch = originalFetch;
      renameSpy.mockRestore();
    }
  });

  it("/tiles: a disk hit is still found when the real write is slower than the old fixed 50ms margin (regression coverage for the flake this poll replaced)", async () => {
    mockCurlForB42_20_0();
    const originalFetch = global.fetch;
    global.fetch = mockFetchServingTiles();
    // Simulate the exact contention this floor sees in practice: the real
    // rename() step of writeDiskCacheAsync's fire-and-forget chain lands
    // ~200ms late -- four times the old fixed margin. The old
    // `await sleep(50)` version of this test would have read "miss" here;
    // awaiting the real rename directly must still find "hit-disk" well
    // inside a generous bound, without re-triggering the write path (see
    // captureFirstRename's comment).
    const { renameSpy, awaitFirstRename } = captureFirstRename({ tileFileName: "9_9.jpg", extraDelayMs: 200 });
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/tiles/:level/:tile", "get");
      // A tile path not used by any other test in this file -- the disk
      // cache directory is real, persistent filesystem state that survives
      // across tests (only in-memory module state resets), so reusing
      // 2_3.jpg here would find the earlier tests' own cached file and
      // short-circuit straight to "hit-disk" before this test's delayed
      // rename() is ever relevant.
      const warm = makeRes();
      await handler({ params: { level: "5", tile: "9_9.jpg" }, query: {} }, warm);
      expect(warm.headers["X-Tile-Cache"]).toBe("miss");

      await awaitFirstRename();

      mockCurlForB42_20_0();
      const { default: freshRouter } = await freshModule();
      const freshHandler = findRoute(freshRouter, "/tiles/:level/:tile", "get");
      const cold = makeRes();
      await freshHandler({ params: { level: "5", tile: "9_9.jpg" }, query: {} }, cold);

      expect(cold.headers["X-Tile-Cache"]).toBe("hit-disk");
    } finally {
      global.fetch = originalFetch;
      renameSpy.mockRestore();
    }
  });

  it("/toptiles: a fresh fetch is also capped, not 7 days (proves the fix isn't scoped to only the /tiles call site)", async () => {
    mockCurlRouter((url) => {
      if (url.endsWith("/api/builds/default")) {
        return curlResult(200, JSON.stringify({ directory: "42.20.0", default: true }));
      }
      if (url.includes("/base/layer0.dzi")) return curlResult(200, dziXml(GEOMETRY_42_20_0));
      if (url.includes("/base/map_info.json")) return curlResult(200, mapInfoJson());
      if (url.endsWith("/base_top/layer0.dzi")) {
        return curlResult(200, '<?xml version="1.0"?><Image Format="webp"/>');
      }
      throw new Error(`unexpected curl URL in test: ${url}`);
    });
    const originalFetch = global.fetch;
    global.fetch = mockFetchServingTiles();
    const { renameSpy, awaitFirstRename } = captureFirstRename({ tileFileName: "2_3.webp" });
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/toptiles/:level/:tile", "get");
      const res = makeRes();
      await handler({ params: { level: "5", tile: "2_3.webp" }, query: {} }, res);

      expect(res.headers["X-Tile-Cache"]).toBe("miss");
      expect(res.headers["Cache-Control"]).toBe("public, max-age=3600");
      await awaitFirstRename();
    } finally {
      global.fetch = originalFetch;
      renameSpy.mockRestore();
    }
  });

  it("/b41tiles: also capped, even though B41's directory is a fixed constant -- the freshness bound is uniform across all three tile routes since they share serveTile()", async () => {
    const originalFetch = global.fetch;
    global.fetch = mockFetchServingTiles();
    const { renameSpy, awaitFirstRename } = captureFirstRename({ tileFileName: "2_3.jpg" });
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/b41tiles/:level/:tile", "get");
      const res = makeRes();
      await handler({ params: { level: "5", tile: "2_3.jpg" }, query: {} }, res);

      expect(res.headers["X-Tile-Cache"]).toBe("miss");
      expect(res.headers["Cache-Control"]).toBe("public, max-age=3600");
      await awaitFirstRename();
    } finally {
      global.fetch = originalFetch;
      renameSpy.mockRestore();
    }
  });
});

// hunt-wave12-2026-08-30 (version-the-tile-url-by-resolved-b42-build): the
// 1h cap above bounds staleness, it doesn't eliminate it. The complete fix
// is to put the resolved B42 build into the browser-facing tile URL
// (WorldMap.tsx / ChunkCleaner.tsx append `?v=<b42Dir>` once they know it --
// see worldMapTileUrl.ts) so two different builds are two different URLs,
// making the URL itself an accurate cache key. Once true, correctness no
// longer trades against cache lifetime, so a request carrying that marker
// can safely be cached indefinitely -- these tests cover the SERVER half:
// presence of `?v=` (any non-empty value; the server never inspects it
// past that, see requestIsVersioned's own comment) switches the response
// to the long/immutable Cache-Control, while its absence keeps the
// original bounded value as the safe fallback for anything that hasn't
// opted in (an old cached JS bundle from before this change, a manual
// request). /b41tiles never switches regardless of `v` -- its directory is
// a hardcoded literal, never dynamically resolved, so there's nothing to
// version there.
describe("suspect 4 follow-up (REAL): a versioned request (?v=<build>) gets a long-lived Cache-Control, matching the accurate cache key", () => {
  it("/tiles: a request WITH ?v= gets the long/immutable Cache-Control instead of the bounded fallback", async () => {
    mockCurlForB42_20_0();
    const originalFetch = global.fetch;
    global.fetch = mockFetchServingTiles();
    const { renameSpy, awaitFirstRename } = captureFirstRename({ tileFileName: "3_4.jpg" });
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/tiles/:level/:tile", "get");
      const res = makeRes();
      await handler(
        { params: { level: "6", tile: "3_4.jpg" }, query: { v: "42.20.0" } },
        res,
      );

      expect(res.headers["X-Tile-Cache"]).toBe("miss");
      expect(res.headers["Cache-Control"]).toBe("public, max-age=604800, immutable");
      await awaitFirstRename();
    } finally {
      global.fetch = originalFetch;
      renameSpy.mockRestore();
    }
  });

  it("/tiles: an in-memory hit for a versioned request ALSO reports the long-lived Cache-Control -- the upgrade applies uniformly across cache tiers, same discipline as the original bounded fix", async () => {
    mockCurlForB42_20_0();
    const originalFetch = global.fetch;
    global.fetch = mockFetchServingTiles();
    const { renameSpy, awaitFirstRename } = captureFirstRename({ tileFileName: "3_5.jpg" });
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/tiles/:level/:tile", "get");

      const first = makeRes();
      await handler(
        { params: { level: "6", tile: "3_5.jpg" }, query: { v: "42.20.0" } },
        first,
      );
      expect(first.headers["X-Tile-Cache"]).toBe("miss");
      await awaitFirstRename();

      const second = makeRes();
      await handler(
        { params: { level: "6", tile: "3_5.jpg" }, query: { v: "42.20.0" } },
        second,
      );
      expect(second.headers["X-Tile-Cache"]).toBe("hit-mem");
      expect(second.headers["Cache-Control"]).toBe("public, max-age=604800, immutable");
    } finally {
      global.fetch = originalFetch;
      renameSpy.mockRestore();
    }
  });

  it("/tiles: a request WITHOUT ?v= still gets the original bounded Cache-Control -- the safe fallback for anything that hasn't opted in", async () => {
    mockCurlForB42_20_0();
    const originalFetch = global.fetch;
    global.fetch = mockFetchServingTiles();
    const { renameSpy, awaitFirstRename } = captureFirstRename({ tileFileName: "3_6.jpg" });
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/tiles/:level/:tile", "get");
      const res = makeRes();
      await handler({ params: { level: "6", tile: "3_6.jpg" }, query: {} }, res);

      expect(res.headers["Cache-Control"]).toBe("public, max-age=3600");
      await awaitFirstRename();
    } finally {
      global.fetch = originalFetch;
      renameSpy.mockRestore();
    }
  });

  it("/tiles: an empty-string ?v= is treated the same as absent -- not a signal of anything", async () => {
    mockCurlForB42_20_0();
    const originalFetch = global.fetch;
    global.fetch = mockFetchServingTiles();
    const { renameSpy, awaitFirstRename } = captureFirstRename({ tileFileName: "3_7.jpg" });
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/tiles/:level/:tile", "get");
      const res = makeRes();
      await handler({ params: { level: "6", tile: "3_7.jpg" }, query: { v: "" } }, res);

      expect(res.headers["Cache-Control"]).toBe("public, max-age=3600");
      await awaitFirstRename();
    } finally {
      global.fetch = originalFetch;
      renameSpy.mockRestore();
    }
  });

  it("/toptiles: a request WITH ?v= also gets the long-lived Cache-Control", async () => {
    mockCurlRouter((url) => {
      if (url.endsWith("/api/builds/default")) {
        return curlResult(200, JSON.stringify({ directory: "42.20.0", default: true }));
      }
      if (url.includes("/base/layer0.dzi")) return curlResult(200, dziXml(GEOMETRY_42_20_0));
      if (url.includes("/base/map_info.json")) return curlResult(200, mapInfoJson());
      if (url.endsWith("/base_top/layer0.dzi")) {
        return curlResult(200, '<?xml version="1.0"?><Image Format="webp"/>');
      }
      throw new Error(`unexpected curl URL in test: ${url}`);
    });
    const originalFetch = global.fetch;
    global.fetch = mockFetchServingTiles();
    const { renameSpy, awaitFirstRename } = captureFirstRename({ tileFileName: "3_8.webp" });
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/toptiles/:level/:tile", "get");
      const res = makeRes();
      await handler(
        { params: { level: "6", tile: "3_8.webp" }, query: { v: "42.20.0" } },
        res,
      );

      expect(res.headers["Cache-Control"]).toBe("public, max-age=604800, immutable");
      await awaitFirstRename();
    } finally {
      global.fetch = originalFetch;
      renameSpy.mockRestore();
    }
  });

  it("/b41tiles: NEVER switches to the long-lived value, even with ?v= supplied -- its directory is a hardcoded literal, not dynamically resolved, so there's nothing to accurately version against", async () => {
    const originalFetch = global.fetch;
    global.fetch = mockFetchServingTiles();
    const { renameSpy, awaitFirstRename } = captureFirstRename({ tileFileName: "3_9.jpg" });
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/b41tiles/:level/:tile", "get");
      const res = makeRes();
      await handler(
        { params: { level: "6", tile: "3_9.jpg" }, query: { v: "41.78.16" } },
        res,
      );

      expect(res.headers["Cache-Control"]).toBe("public, max-age=3600");
      await awaitFirstRename();
    } finally {
      global.fetch = originalFetch;
      renameSpy.mockRestore();
    }
  });
});
