import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// SECURITY (2026-10-28): on Windows, merely checking whether
// \\host\share\... exists makes the panel's account sign in to that host,
// handing it the account's NTLM login, and a share serves whatever files it
// likes. isValidPath() (every SteamCMD/install path routes/server.js takes)
// and POST /api/servers/detect accepted one and touched it straight away;
// a technician could aim the panel at a host of their choosing. Windows-only:
// on Linux `//host/share` is just /host/share.

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
}));

const isWindows = process.platform === "win32";

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

function lastHandler(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(!isWindows)("Windows network paths are refused before anything touches them", () => {
  it("isValidPath() refuses \\\\host\\share and its other spellings", async () => {
    const { isValidPath } = await import("../routes/server.js");
    expect(isValidPath("\\\\attacker\\share\\steamcmd")).toBe(false);
    expect(isValidPath("//attacker/share/steamcmd")).toBe(false);
    expect(isValidPath("\\\\?\\UNC\\attacker\\share")).toBe(false);
    expect(isValidPath("C:\\steamcmd")).toBe(true);
  });

  it("POST /api/servers/detect refuses a network data or install path without touching it", async () => {
    const { default: router } = await import("../routes/servers.js");
    // A real data folder, so the install path is the one judged.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-unc-detect-"));
    fs.mkdirSync(path.join(dataDir, "Server"));
    // Recorded, never really looked up (no network traffic even on the old code).
    const realExistsSync = fs.existsSync;
    const isNetworkPath = (p) => /^[\\/]{2}/.test(String(p));
    const existsSync = vi
      .spyOn(fs, "existsSync")
      .mockImplementation((p) => (isNetworkPath(p) ? true : realExistsSync(p)));
    const realReaddirSync = fs.readdirSync;
    vi.spyOn(fs, "readdirSync").mockImplementation((p, ...rest) =>
      isNetworkPath(p) ? [] : realReaddirSync(p, ...rest),
    );
    try {
      for (const body of [
        { dataPath: "\\\\attacker\\share\\Zomboid" },
        { dataPath: dataDir, installPath: "\\\\attacker\\share\\pz" },
      ]) {
        existsSync.mockClear();
        const res = createResponse();
        await lastHandler(router, "/detect", "post")({ body, app: { get: () => undefined } }, res);
        expect(existsSync.mock.calls.filter(([p]) => isNetworkPath(p))).toEqual([]);
        expect(res.getStatusCode()).toBe(400);
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
