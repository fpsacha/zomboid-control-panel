import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// SECURITY (2026-10-28): GET /api/server/branches saves the folder its query
// names as the SteamCMD folder and runs steamcmd from it. A GET is what any
// web page can make the operator's browser send unasked (an <img>, no Origin
// for the CORS check), and with panel logins off every request is an
// admin's, so a page could make the panel run a steamcmd.exe it had the
// browser download. A browser's cross-site / same-site request is refused.

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

const settingsStore = {};
vi.mock("../database/init.js", () => ({
  getAllSettings: vi.fn(async () => ({ ...settingsStore })),
  getSetting: vi.fn(async (key) => settingsStore[key] ?? null),
  setSetting: vi.fn(async (key, value) => {
    settingsStore[key] = value;
  }),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
}));

const { default: router } = await import("../routes/server.js");

const binaryName = process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh";

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

function lastHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

let root;
let downloads;

beforeEach(() => {
  spawnMock.mockReset();
  for (const key of Object.keys(settingsStore)) delete settingsStore[key];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-branches-cross-site-"));
  // A folder holding a steamcmd binary someone else put there.
  downloads = path.join(root, "Downloads");
  fs.mkdirSync(downloads);
  fs.writeFileSync(path.join(downloads, binaryName), "");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function getBranches(query, headers) {
  const res = createResponse();
  await lastHandler("/branches", "get")({ query, headers, app: { get: () => undefined } }, res);
  return res;
}

describe("GET /api/server/branches from another site's page", () => {
  it("refuses a cross-site request: the named folder is neither saved nor run", async () => {
    const res = await getBranches({ steamcmdPath: downloads }, { "sec-fetch-site": "cross-site" });
    expect(res.getStatusCode()).toBe(403);
    expect(settingsStore.steamcmdPath).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses a same-site page too (another port of the panel's host; adversary pass)", async () => {
    const res = await getBranches({ steamcmdPath: downloads }, { "sec-fetch-site": "same-site" });
    expect(res.getStatusCode()).toBe(403);
    expect(settingsStore.steamcmdPath).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request with no query either: the saved SteamCMD is not run (adversary pass)", async () => {
    settingsStore.steamcmdPath = downloads;
    const res = await getBranches({}, { "sec-fetch-site": "cross-site" });
    expect(res.getStatusCode()).toBe(403);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("still answers the panel's own page (same-origin), a typed address (none) and a non-browser client", async () => {
    for (const headers of [{ "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "none" }, {}]) {
      const res = await getBranches({ steamcmdPath: path.join(root, "not-steamcmd") }, headers);
      expect(res.getStatusCode()).toBe(200);
      expect(res.getBody().source).toBe("fallback");
    }
  });
});
