import express from "express";
import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.js";
import { getDataPaths } from "../utils/paths.js";
import { getActiveServer } from "../database/init.js";
import { listPersistedVehicles } from "../utils/vehiclesDb.js";
const log = createLogger("API:MapProxy");

const router = express.Router();

// ─── Persistent disk-backed tile cache ───────────────────────────────────
// A given PZ map build's tiles never change once published, so unlike a
// typical HTTP cache these never need to expire — once a tile has been
// fetched from map.projectzomboid.com it's cached on disk indefinitely.
// Over time this turns the proxy into a self-hosted mirror of whatever
// parts of the map players have actually looked at, with zero upfront
// download and no dependency on the upstream host for anything already
// cached. A small in-memory LRU sits in front of disk to avoid a
// filesystem read on every request for hot tiles.
const TILE_CACHE_DIR = path.join(getDataPaths().dataDir, "map-tiles-cache");
const MEM_CACHE_MAX = 500;
const memCache = new Map(); // relPath -> { buffer, contentType }

function memCacheGet(relPath) {
  const entry = memCache.get(relPath);
  if (!entry) return null;
  // Refresh LRU position
  memCache.delete(relPath);
  memCache.set(relPath, entry);
  return entry;
}

function memCachePut(relPath, buffer, contentType) {
  if (memCache.size >= MEM_CACHE_MAX) {
    const oldestKey = memCache.keys().next().value;
    if (oldestKey !== undefined) memCache.delete(oldestKey);
  }
  memCache.set(relPath, { buffer, contentType });
}

function diskPathFor(relPath) {
  return path.join(TILE_CACHE_DIR, relPath);
}

async function readDiskCache(relPath) {
  try {
    return await fs.promises.readFile(diskPathFor(relPath));
  } catch {
    return null;
  }
}

// Fire-and-forget: a disk cache write failing (permissions, full disk) just
// means we re-fetch from upstream next time — never block the response on it.
function writeDiskCacheAsync(relPath, buffer) {
  const dest = diskPathFor(relPath);
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  fs.promises
    .mkdir(path.dirname(dest), { recursive: true })
    .then(() => fs.promises.writeFile(tmp, buffer))
    .then(() => fs.promises.rename(tmp, dest))
    .catch((err) => {
      log.debug(`Disk tile cache write failed for ${relPath}: ${err.message}`);
      fs.promises.unlink(tmp).catch(() => {});
    });
}

// ─── B42 map version resolution ──────────────────────────────────────────────
// b42map.com has migrated to map.projectzomboid.com. Tiles are now served at
// https://map.projectzomboid.com/maps/<version>/base/layer<floor>_files/<level>/<tile>
// We resolve the latest B42 version directory dynamically from build_list.json
// so tile loading stays current when PZ ships new map builds without a panel update.
const PZ_MAP_ROOT = "https://map.projectzomboid.com";
const B42_DIR_FALLBACK = "42.19.0";
const B42_DIR_TTL_MS = 24 * 60 * 60 * 1000; // re-resolve at most once per 24 h
const B42_DIR_RETRY_MS = 5 * 60 * 1000; // ...but retry a failed resolve sooner
// Geometry of B42_DIR_FALLBACK, used only when layer0.dzi can't be fetched.
// x0/y0/sqr/scale are the isometric projection origin, copied from 42.19.0's
// own base/map_info.json (skip:1 => scale 1<<1 = 2).
const B42_GEOMETRY_FALLBACK = {
  tileSize: 1024,
  width: 1157312,
  height: 509520,
  maxLevel: 21,
  x0: 1036288,
  y0: -139296,
  sqr: 128,
  scale: 2,
};

// The projection origin is NOT derivable from the image dimensions: 42.20.0 is
// exactly 2x the height of 42.19.0 but 4032 px wider, because the renderer
// crops/pads each build independently. map.projectzomboid.com publishes the
// real origin per build in base/map_info.json and its own viewer projects with
//   imageX = (x0 + (sx - sy) * sqr / 2) / scale
//   imageY = (y0 + (sx + sy) * sqr / 4) / scale
// where scale = 1 << skip. Scaling a previous build's origin by the width
// ratio instead puts markers ~2300 px (~36 tiles) west of where they are.
async function fetchMapProjection(directory) {
  try {
    const resp = await fetch(
      `${PZ_MAP_ROOT}/maps/${directory}/base/map_info.json`,
      {
        signal: AbortSignal.timeout(5000),
        headers: {
          "User-Agent":
            "ZomboidControlPanel/1.0 (+https://github.com/fpsacha/zomboid-control-panel)",
        },
      },
    );
    if (!resp.ok) return null;
    const info = await resp.json();
    const x0 = Number(info?.x0);
    const y0 = Number(info?.y0);
    const sqr = Number(info?.sqr);
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !sqr) return null;
    const skip = Number(info?.skip);
    return { x0, y0, sqr, scale: 1 << (Number.isFinite(skip) ? skip : 0) };
  } catch {
    return null;
  }
}
// Map builds are not all rendered at the same resolution: 42.19.0 is
// TileSize=1024 / 1157312x509520, while 42.20.0 doubled to TileSize=2048 /
// 2318656x1019040. Nothing about the geometry can be assumed, so read it from
// the build's own DZI descriptor and hand it to the client.
async function fetchMapGeometry(directory) {
  try {
    const resp = await fetch(
      `${PZ_MAP_ROOT}/maps/${directory}/base/layer0.dzi`,
      {
        signal: AbortSignal.timeout(5000),
        headers: {
          "User-Agent":
            "ZomboidControlPanel/1.0 (+https://github.com/fpsacha/zomboid-control-panel)",
        },
      },
    );
    if (!resp.ok) return null;
    const xml = await resp.text();
    const tileSize = Number(xml.match(/TileSize="(\d+)"/)?.[1]);
    const width = Number(xml.match(/Width="(\d+)"/)?.[1]);
    const height = Number(xml.match(/Height="(\d+)"/)?.[1]);
    if (!tileSize || !width || !height) return null;
    return {
      tileSize,
      width,
      height,
      maxLevel: Math.ceil(Math.log2(Math.max(width, height))),
      ...((await fetchMapProjection(directory)) || {}),
    };
  } catch {
    return null;
  }
}

// A brand-new PZ build's tiles can be listed as the "default" entry in
// build_list.json before map.projectzomboid.com has actually finished
// rendering full world coverage for it. Probing a few inhabited-area tiles
// lets us detect "listed but not rendered yet" and fall back to the previous
// build instead of showing an empty map.
//
// The probe coordinates are derived from the build's own geometry rather than
// hardcoded: a fixed `15/9_3.jpg`-style path is only meaningful for a
// TileSize=1024 build and silently false-negatives on a 2048 one, which would
// pin every install to an outdated build forever.
const COVERAGE_PROBE_FRACTIONS = [
  [0.51, 0.4],
  [0.56, 0.45],
  [0.61, 0.5],
];
let _b42Map = null;
let _b42DirFetchedAt = 0;

async function hasTileCoverage(directory, geometry) {
  const level = Math.max(0, geometry.maxLevel - 6);
  const levelScale = 2 ** (geometry.maxLevel - level);
  const levelW = Math.ceil(geometry.width / levelScale);
  const levelH = Math.ceil(geometry.height / levelScale);
  for (const [fx, fy] of COVERAGE_PROBE_FRACTIONS) {
    const col = Math.floor((levelW * fx) / geometry.tileSize);
    const row = Math.floor((levelH * fy) / geometry.tileSize);
    try {
      const resp = await fetch(
        `${PZ_MAP_ROOT}/maps/${directory}/base/layer0_files/${level}/${col}_${row}.jpg`,
        {
          method: "HEAD",
          signal: AbortSignal.timeout(4000),
          headers: {
            "User-Agent":
              "ZomboidControlPanel/1.0 (+https://github.com/fpsacha/zomboid-control-panel)",
          },
        },
      );
      if (resp.ok) return true;
    } catch {
      // Treat as not-covered and try the next probe tile.
    }
  }
  return false;
}

// The top-down (base_top) view is rendered separately from the isometric base
// and does not use the same image format across builds: 42.19.0 publishes webp
// while 42.20.0 publishes jpg. Requesting the wrong extension is a hard 404, so
// read the format from the build's own base_top descriptor.
const TOP_FORMAT_FALLBACK = "jpg";
const TOP_CONTENT_TYPES = {
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};
const _topFormatCache = new Map(); // directory -> format

async function getB42TopFormat(directory) {
  const cached = _topFormatCache.get(directory);
  if (cached) return cached;
  try {
    const resp = await fetch(
      `${PZ_MAP_ROOT}/maps/${directory}/base_top/layer0.dzi`,
      {
        signal: AbortSignal.timeout(5000),
        headers: {
          "User-Agent":
            "ZomboidControlPanel/1.0 (+https://github.com/fpsacha/zomboid-control-panel)",
        },
      },
    );
    if (resp.ok) {
      const xml = await resp.text();
      const format = xml.match(/Format="(\w+)"/)?.[1]?.toLowerCase();
      if (format && TOP_CONTENT_TYPES[format]) {
        _topFormatCache.set(directory, format);
        return format;
      }
    }
  } catch {
    // Fall through to the default below.
  }
  return TOP_FORMAT_FALLBACK;
}

async function getB42Map() {
  const now = Date.now();
  if (_b42Map && now - _b42DirFetchedAt < B42_DIR_TTL_MS) {
    return _b42Map;
  }
  try {
    const resp = await fetch(`${PZ_MAP_ROOT}/build_list.json`, {
      signal: AbortSignal.timeout(5000),
      headers: {
        "User-Agent":
          "ZomboidControlPanel/1.0 (+https://github.com/fpsacha/zomboid-control-panel)",
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const list = await resp.json();
    // Entries are ordered newest-first. Walk B42+ candidates until one
    // actually has rendered tile coverage, not just a build_list.json entry.
    // The full string (not just a prefix) must match a plain version
    // pattern — this now also becomes a disk cache path segment, so a
    // malformed/adversarial value from upstream must never reach fs calls.
    const candidates = Array.isArray(list)
      ? list.filter((e) => /^4[2-9][\w.\-]*$/.test(e.directory || ""))
      : [];
    for (const entry of candidates) {
      if (!entry?.directory) continue;
      const geometry = await fetchMapGeometry(entry.directory);
      if (!geometry) {
        log.warn(
          `B42 map directory ${entry.directory} has no readable layer0.dzi — trying older build.`,
        );
        continue;
      }
      if (await hasTileCoverage(entry.directory, geometry)) {
        if (_b42Map?.directory !== entry.directory) {
          log.info(
            `B42 map directory resolved: ${entry.directory} (${geometry.width}x${geometry.height}, tile ${geometry.tileSize}, max level ${geometry.maxLevel})`,
          );
        }
        _b42Map = { directory: entry.directory, ...geometry };
        _b42DirFetchedAt = now;
        return _b42Map;
      }
      log.warn(
        `B42 map directory ${entry.directory} listed but has no rendered tile coverage yet — trying older build.`,
      );
    }
  } catch (err) {
    log.warn(
      `Failed to resolve B42 map directory from build_list.json: ${err.message}. Falling back to ${_b42Map?.directory || B42_DIR_FALLBACK}.`,
    );
  }
  _b42Map = _b42Map || { directory: B42_DIR_FALLBACK, ...B42_GEOMETRY_FALLBACK };
  // Stamp the fallback too, not just a successful resolve — otherwise a
  // backend that can never reach map.projectzomboid.com (e.g. a blocked
  // cluster egress policy) eats the full fetch timeout on every single tile
  // request forever. Retry sooner than a successful resolve so a transient
  // upstream outage doesn't pin us to the fallback build for a whole day.
  _b42DirFetchedAt = now - B42_DIR_TTL_MS + B42_DIR_RETRY_MS;
  return _b42Map;
}

async function getB42Dir() {
  return (await getB42Map()).directory;
}

// Max time we'll wait for an upstream tile fetch. Without this a slow/dead
// upstream can hold an Express handler open forever, eventually starving the
// pool on a busy map view.
const TILE_FETCH_TIMEOUT_MS = 10_000;

// ─── Circuit breaker for the upstream tile hosts ─────────────────────────
// Without this, a truly dead upstream (e.g. a Cloudflare outage on the map
// host) makes EVERY tile request pay the full timeout+retry cost
// (~10-20s each) with no backpressure, and the map view fires dozens of
// tile requests per pan/zoom — piling up slow handlers. After enough
// consecutive failures we fail fast for a cooldown instead of continuing to
// hammer (and wait on) a host that's already down.
const CIRCUIT_FAILURE_THRESHOLD = 8;
const CIRCUIT_COOLDOWN_MS = 30_000;
let circuitConsecutiveFailures = 0;
let circuitOpenUntil = 0;

function isCircuitOpen() {
  return Date.now() < circuitOpenUntil;
}

function recordTileSuccess() {
  circuitConsecutiveFailures = 0;
}

function recordTileFailure() {
  circuitConsecutiveFailures++;
  if (
    circuitConsecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD &&
    !isCircuitOpen()
  ) {
    circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    log.warn(
      `Tile proxy circuit breaker OPEN for ${CIRCUIT_COOLDOWN_MS / 1000}s after ${circuitConsecutiveFailures} consecutive upstream failures`,
    );
  }
}

async function fetchTileWithTimeout(url) {
  // Node 18+ supports AbortSignal.timeout; older runtimes throw a TypeError
  // which propagates to the caller's catch block and is surfaced as a 502
  // (same shape as any network error).
  return fetch(url, {
    signal: AbortSignal.timeout(TILE_FETCH_TIMEOUT_MS),
    headers: {
      // Some upstreams (Cloudflare on b42map.com) return 403/503 when the
      // User-Agent header is missing entirely. Send a neutral identifier.
      "User-Agent":
        "ZomboidControlPanel/1.0 (+https://github.com/fpsacha/zomboid-control-panel)",
      Accept: "image/*,*/*;q=0.8",
    },
  });
}

// Fetch with one retry on transient upstream failures (502/503/504/network).
// 404 is NOT retried — it just means the tile is outside the map bounds.
async function fetchTileWithRetry(url) {
  if (isCircuitOpen()) {
    throw new Error(
      "Tile proxy circuit breaker is open (upstream has been failing repeatedly)",
    );
  }
  try {
    const r = await fetchTileWithTimeout(url);
    if (r.ok || r.status === 404) {
      recordTileSuccess();
      return r;
    }
    if (r.status >= 500 && r.status < 600) {
      // Brief backoff before single retry — Cloudflare 503 on rate-limit
      // typically clears within a few hundred ms.
      await new Promise((res) => setTimeout(res, 250));
      const retried = await fetchTileWithTimeout(url);
      if (retried.ok || retried.status === 404) recordTileSuccess();
      else recordTileFailure();
      return retried;
    }
    // Other 4xx (not 404) isn't a "broken upstream" signal — don't count it
    // toward the circuit breaker.
    return r;
  } catch (err) {
    try {
      await new Promise((res) => setTimeout(res, 250));
      const retried = await fetchTileWithTimeout(url);
      if (retried.ok || retried.status === 404) recordTileSuccess();
      else recordTileFailure();
      return retried;
    } catch (retryErr) {
      recordTileFailure();
      throw retryErr;
    }
  }
}

async function serveTile(req, res, url, contentType, relPath) {
  // Tier 1: in-memory LRU — fastest, no I/O at all.
  const hot = memCacheGet(relPath);
  if (hot) {
    res.set("Content-Type", hot.contentType);
    res.set("Cache-Control", "public, max-age=604800"); // 7 days
    res.set("X-Tile-Cache", "hit-mem");
    res.send(hot.buffer);
    return;
  }

  // Tier 2: disk — this PZ map version's tiles are immutable, so a disk hit
  // means we never have to touch map.projectzomboid.com for this tile again.
  const onDisk = await readDiskCache(relPath);
  if (onDisk) {
    memCachePut(relPath, onDisk, contentType);
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=604800");
    res.set("X-Tile-Cache", "hit-disk");
    res.send(onDisk);
    return;
  }

  try {
    const response = await fetchTileWithRetry(url);
    if (!response.ok) {
      // Pass 404 through quietly — that's "tile out of map bounds", not an error.
      // Map upstream 5xx to 502 so the client knows the panel itself is fine.
      const status =
        response.status === 404
          ? 404
          : response.status >= 500
            ? 502
            : response.status;
      return res.status(status).end();
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    memCachePut(relPath, buffer, contentType);
    writeDiskCacheAsync(relPath, buffer);
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=604800");
    res.set("X-Tile-Cache", "miss");
    res.send(buffer);
  } catch (err) {
    log.debug(`Tile proxy failed for ${url}: ${err.message}`);
    if (!res.headersSent) res.status(502).end();
  }
}

// Exposes the resolved B42 build: its geometry, which the client needs to
// address tiles at all (tile size and full-res dimensions differ between map
// builds, so neither side can hardcode them), plus enough to build
// direct-to-upstream tile URLs and load them straight from the browser
// instead of always routing through this server's proxy. Some deployments
// (e.g. a Kubernetes cluster with a restrictive Gateway API egress policy)
// block outbound access to map.projectzomboid.com for the panel's own pod
// while the admin's browser has no such restriction — in that case every
// tile-proxy fetch here fails no matter how good the retry/cache/circuit
// breaker logic is, but the browser can just fetch tiles itself.
router.get("/resolve", async (req, res) => {
  const map = await getB42Map();
  res.set("Cache-Control", "public, max-age=3600");
  res.json({
    root: PZ_MAP_ROOT,
    b42Dir: map.directory,
    b41Path: "maps/41.78.16/base/layer0_files",
    tileSize: map.tileSize,
    width: map.width,
    height: map.height,
    maxLevel: map.maxLevel,
    x0: map.x0,
    y0: map.y0,
    sqr: map.sqr,
    scale: map.scale,
  });
});

let persistedVehicleCache = { key: null, expiresAt: 0, vehicles: [] };

router.get("/vehicles", async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    if (!activeServer || activeServer.isRemote || !activeServer.zomboidDataPath) {
      return res.json({ vehicles: [] });
    }
    const serverName = activeServer.serverName || activeServer.name;
    if (!serverName) return res.json({ vehicles: [] });
    const savePath = path.join(activeServer.zomboidDataPath, "Saves", "Multiplayer", serverName);
    const cacheKey = `${savePath}`;
    if (persistedVehicleCache.key !== cacheKey || Date.now() >= persistedVehicleCache.expiresAt) {
      persistedVehicleCache = {
        key: cacheKey,
        expiresAt: Date.now() + 15000,
        vehicles: await listPersistedVehicles(savePath),
      };
    }
    res.json({ vehicles: persistedVehicleCache.vehicles });
  } catch (err) {
    log.warn(`Persisted vehicle lookup failed: ${err.message}`);
    res.json({ vehicles: [] });
  }
});

// Proxy DZI tiles from map.projectzomboid.com (migrated from b42map.com) to
// avoid CORS restrictions. Resolves the latest B42 map directory dynamically
// from build_list.json so new PZ map builds are picked up automatically.
// Validates inputs to prevent SSRF — only allows numeric level 0-22,
// floor -17..30, and tile filenames matching the DZI convention.
router.get("/tiles/:level/:tile", async (req, res) => {
  const level = parseInt(req.params.level, 10);
  const tile = req.params.tile;
  const floorRaw = Array.isArray(req.query.floor)
    ? req.query.floor[0]
    : req.query.floor;
  const floor = parseInt(String(floorRaw ?? "0"), 10);

  if (isNaN(level) || level < 0 || level > 22) {
    return res.status(400).json({ error: "Invalid level" });
  }
  // Client clamps floor to -17..29 (WorldMap.tsx changeFloor); keep the
  // backend in sync so anything outside the real range is rejected early.
  if (isNaN(floor) || floor < -17 || floor > 29) {
    return res.status(400).json({ error: "Invalid floor" });
  }
  // Every B42 layer DZI declares JPEG tiles, including basements and upper floors.
  const ext = "jpg";
  if (!new RegExp(`^\\d+_\\d+\\.${ext}$`).test(tile)) {
    return res.status(400).json({ error: "Invalid tile" });
  }

  const dir = await getB42Dir();
  const url = `${PZ_MAP_ROOT}/maps/${dir}/base/layer${floor}_files/${level}/${tile}`;
  const contentType = "image/jpeg";
  const relPath = path.join("b42", dir, `layer${floor}`, String(level), tile);
  await serveTile(req, res, url, contentType, relPath);
});

// Proxy B42 top-down DZI tiles (used by ChunkCleaner for overhead map view).
// These tiles use webp format at all levels.
// Only floor 0 is available in the top-down view.
router.get("/toptiles/:level/:tile", async (req, res) => {
  const level = parseInt(req.params.level, 10);
  const tile = req.params.tile;

  if (isNaN(level) || level < 0 || level > 22) {
    return res.status(400).json({ error: "Invalid level" });
  }
  const parsed = /^(\d+_\d+)\.(webp|jpe?g|png)$/.exec(tile);
  if (!parsed) {
    return res.status(400).json({ error: "Invalid tile" });
  }

  const dir = await getB42Dir();
  // The requested extension is ignored: the client cannot know which format a
  // given build was rendered in, so the upstream descriptor decides.
  const format = await getB42TopFormat(dir);
  const upstreamTile = `${parsed[1]}.${format}`;
  const url = `${PZ_MAP_ROOT}/maps/${dir}/base_top/layer0_files/${level}/${upstreamTile}`;
  const relPath = path.join("b42-top", dir, String(level), upstreamTile);
  await serveTile(req, res, url, TOP_CONTENT_TYPES[format], relPath);
});

// Proxy B41 DZI tiles from map.projectzomboid.com.
router.get("/b41tiles/:level/:tile", async (req, res) => {
  const level = parseInt(req.params.level, 10);
  const tile = req.params.tile;

  if (isNaN(level) || level < 0 || level > 22) {
    return res.status(400).json({ error: "Invalid level" });
  }
  if (!/^\d+_\d+\.jpg$/.test(tile)) {
    return res.status(400).json({ error: "Invalid tile" });
  }

  const url = `${PZ_MAP_ROOT}/maps/41.78.16/base/layer0_files/${level}/${tile}`;
  const relPath = path.join("b41", String(level), tile);
  await serveTile(req, res, url, "image/jpeg", relPath);
});

export default router;

// Exposed so the diagnostics route can probe the exact URLs this proxy would
// request, instead of a hardcoded build that may not be the one in use.
export { PZ_MAP_ROOT, getB42Dir, getB42TopFormat };
