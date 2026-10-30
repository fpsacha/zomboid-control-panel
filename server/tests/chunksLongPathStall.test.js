import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// SECURITY (2026-10-28, R2-13 review): the network-share guard on Map
// Cleanup's custom path asked untrustedFolderReason(), whose Workshop rule
// climbs the path one folder at a time with a realpath per step: its cost
// grew with the square of the depth, synchronously. A customPath of
// C:\a\a\a\... (up to the 1 MB body limit) held the event loop for minutes.
// The guard is a string test now, a typed path longer than 4096 characters
// is refused before any work on it, and GET /browse runs the share test on
// Windows only.
//
// fs.realpathSync.native is counted here; past a few hundred calls the spy
// pretends the path exists so the old code's walk ends quickly and the test
// fails on its assertions instead of running for minutes.

const getRoleByName = vi.fn(async (name) =>
  name === "chunks_and_configure" ? { capabilities: ["chunks.manage", "server.configure"] } : mockGetRoleByName(name),
);

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getServers: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  updateServer: vi.fn(),
  getRoleByName,
}));

const { getActiveServer, getServers, getSetting, setSetting, updateServer } = await import(
  "../database/init.js"
);
const { default: router } = await import("../routes/chunks.js");

const BS = String.fromCharCode(92);

function createResponse() {
  const response = {};
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

async function runRoute(routePath, method, req) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  const handlers = layer.route.stack.map((s) => s.handle);
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

const app = { get: () => null };
const technician = { role: "technician" };
const configurer = { role: "chunks_and_configure" };

const ENTRY_POINTS = {
  "GET /saves": (customPath) => runRoute("/saves", "get", { user: technician, app, query: { customPath } }),
  "GET /chunks/:saveName": (customPath) =>
    runRoute("/chunks/:saveName", "get", {
      user: technician,
      app,
      params: { saveName: "TestSave" },
      query: { customPath },
    }),
  "GET /stats/:saveName": (customPath) =>
    runRoute("/stats/:saveName", "get", {
      user: technician,
      app,
      params: { saveName: "TestSave" },
      query: { customPath },
    }),
  "POST /save-path": (customPath) =>
    runRoute("/save-path", "post", { user: configurer, app, body: { path: customPath } }),
  "POST /delete-chunks": (customPath) =>
    runRoute("/delete-chunks", "post", {
      user: technician,
      app,
      body: {
        saveName: "TestSave",
        chunks: [{ file: "0/0.bin", x: 0, y: 0 }],
        customPath,
        force: true,
        createBackup: false,
      },
    }),
  "POST /delete-region": (customPath) =>
    runRoute("/delete-region", "post", {
      user: technician,
      app,
      body: {
        saveName: "TestSave",
        minX: 0,
        maxX: 1,
        minY: 0,
        maxY: 1,
        customPath,
        force: true,
        createBackup: false,
      },
    }),
};

function browse(browsePath) {
  return runRoute("/browse", "get", { user: technician, app, query: { path: browsePath } });
}

// "C:\a\a\a\..." of about `chars` characters, under a folder that doesn't exist.
function deepLocalPath(chars, drive = "C:") {
  const head = `${drive}${BS}zcp-missing-${process.pid}${BS}`;
  return head + `a${BS}`.repeat(Math.ceil((chars - head.length) / 2));
}

let realPlatform;
let dataRoot;
let nativeCalls;

function setPlatform(value) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

beforeEach(() => {
  realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-long-path-"));
  fs.mkdirSync(path.join(dataRoot, "Saves", "Multiplayer", "TestSave"), { recursive: true });
  getActiveServer.mockReset().mockResolvedValue({
    id: "server-1",
    zomboidDataPath: dataRoot,
    isRemote: false,
  });
  getServers.mockReset().mockResolvedValue([]);
  getSetting.mockReset().mockResolvedValue(null);
  setSetting.mockReset();
  updateServer.mockReset().mockResolvedValue({ id: "server-1" });
  nativeCalls = 0;
  const original = fs.realpathSync.native;
  vi.spyOn(fs.realpathSync, "native").mockImplementation((p, ...rest) => {
    nativeCalls++;
    if (nativeCalls > 300) return String(p);
    return original.call(fs.realpathSync, p, ...rest);
  });
});

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  vi.restoreAllMocks();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe("Map Cleanup custom path: an overlong path is refused before any work on it", () => {
  for (const [name, call] of Object.entries(ENTRY_POINTS)) {
    it(`${name} answers a 64 KB path in well under a second, without resolving it`, async () => {
      setPlatform("win32");
      const typed = deepLocalPath(64 * 1024);
      const started = Date.now();
      const res = await call(typed);
      const elapsed = Date.now() - started;
      const body = res.getBody();
      const code = body.code ?? body.debug?.code;
      expect(res.getStatusCode()).toBe(400);
      expect(code ?? body.debug?.rejection?.reason).toMatch(/CHUNKS_PATH_TOO_LONG|too-long/);
      expect(nativeCalls).toBe(0);
      expect(elapsed).toBeLessThan(1000);
      // The refusal doesn't echo 64 KB back.
      expect(JSON.stringify(body).length).toBeLessThan(4096);
    });
  }

  it("a path of exactly 4096 characters is not refused as too long", async () => {
    setPlatform("win32");
    const typed = deepLocalPath(4096).slice(0, 4096);
    expect(typed.length).toBe(4096);
    const res = await ENTRY_POINTS["GET /saves"](typed);
    expect(JSON.stringify(res.getBody())).not.toContain("CHUNKS_PATH_TOO_LONG");
    expect(res.getBody().debug?.rejection?.reason).toBe("not-found");
  });

  // Adversary pass: padding the typed value with spaces or quotes, which
  // normalizeUserPath() trims, doesn't slip a long value under the cap.
  it("padding that is trimmed later still counts toward the limit", async () => {
    setPlatform("win32");
    const res = await ENTRY_POINTS["POST /delete-chunks"](`"${" ".repeat(5000)}C:${BS}x${" ".repeat(5000)}"`);
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe("CHUNKS_PATH_TOO_LONG");
  });
});

describe("Map Cleanup custom path on Windows: the share test never resolves a local path", () => {
  it.each(["GET /saves", "POST /delete-chunks", "POST /delete-region"])(
    "%s with a deep local path under the limit makes no realpath call before refusing it as missing",
    async (name) => {
      setPlatform("win32");
      const typed = deepLocalPath(4000);
      const started = Date.now();
      const res = await ENTRY_POINTS[name](typed);
      expect(res.getStatusCode()).toBe(400);
      expect(JSON.stringify(res.getBody())).toMatch(/not-found|does not exist/);
      expect(nativeCalls).toBe(0);
      expect(Date.now() - started).toBeLessThan(1000);
    },
  );

  it("a share is still refused (the string test is the same rule)", async () => {
    setPlatform("win32");
    const res = await ENTRY_POINTS["GET /saves"](`${BS}${BS}attacker.invalid${BS}share`);
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe("CHUNKS_CUSTOM_PATH_NETWORK_REFUSED");
    expect(nativeCalls).toBe(0);
  });
});

describe("GET /browse: no realpath walk on the query string", () => {
  it.each(["win32", "linux"])("on %s, a deep path under the limit is answered without the Workshop walk", async (platform) => {
    setPlatform(platform);
    const started = Date.now();
    const res = await browse(dataRoot + `${path.sep}a`.repeat(1500));
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe("BROWSE_CHUNKS_PATH_NOT_FOUND");
    expect(nativeCalls).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it.each(["win32", "linux"])("on %s, a path over 4096 characters is refused before it is resolved", async (platform) => {
    setPlatform(platform);
    const res = await browse(dataRoot + `${path.sep}a`.repeat(8000));
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe("CHUNKS_PATH_TOO_LONG");
    expect(nativeCalls).toBe(0);
  });

  it("on Windows, a share outside the data folder is still refused", async () => {
    setPlatform("win32");
    const res = await browse(`${BS}${BS}attacker.invalid${BS}share`);
    expect(res.getStatusCode()).toBe(403);
    expect(res.getBody().code).toBe("BROWSE_CHUNKS_ACCESS_DENIED");
  });
});
