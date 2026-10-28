import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// SECURITY (2026-10-28): on Windows, merely resolving or checking
// \\host\share\... makes the panel's account sign in to that host, handing
// it the account's NTLM login. Two server-path checks still did that to a
// value they were about to refuse:
//  - serverConfigPathIsConfined() (POST/PUT /api/servers, servers.manage)
//    resolved the config folder through links before comparing it to the
//    data folder;
//  - POST /api/servers/auto-scan (servers.discover) checked the scan folder
//    exists before anything else (/detect already refused a network path).
// Windows-only: on Linux `//host/share` is just /host/share.

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
}));

const isWindows = process.platform === "win32";
const isNetworkPath = (p) => /^[\\/]{2}/.test(String(p));

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

// Every file-system call on a network path is recorded and answered as
// "not there" -- never really made, so no test sends network traffic even
// on the old code.
let networkCalls;
let dataDir;

function notFound(p) {
  return Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
}

beforeEach(() => {
  networkCalls = [];
  const realExistsSync = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((p) => {
    if (isNetworkPath(p)) {
      networkCalls.push(["existsSync", p]);
      return false;
    }
    return realExistsSync(p);
  });
  const realStatSync = fs.statSync;
  vi.spyOn(fs, "statSync").mockImplementation((p, ...rest) => {
    if (isNetworkPath(p)) {
      networkCalls.push(["statSync", p]);
      throw notFound(p);
    }
    return realStatSync(p, ...rest);
  });
  const realRealpathNative = fs.realpathSync.native;
  vi.spyOn(fs.realpathSync, "native").mockImplementation((p, ...rest) => {
    if (isNetworkPath(p)) {
      networkCalls.push(["realpathSync.native", p]);
      throw notFound(p);
    }
    return realRealpathNative(p, ...rest);
  });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-unc-serverpaths-"));
  fs.mkdirSync(path.join(dataDir, "Server"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe.skipIf(!isWindows)("server folder checks never touch a Windows network path they refuse", () => {
  it("serverConfigPathIsConfined() refuses a network config folder without resolving it", async () => {
    const { serverConfigPathIsConfined } = await import("../utils/serverConfigPath.js");
    expect(serverConfigPathIsConfined("\\\\attacker\\share\\Server", dataDir)).toBe(false);
    expect(networkCalls).toEqual([]);
  });

  it("refuses the other spellings of a network path unread too (adversary pass)", async () => {
    const { serverConfigPathIsConfined } = await import("../utils/serverConfigPath.js");
    for (const value of [
      "//attacker/share/Server",
      "\\\\?\\UNC\\attacker\\share\\Server",
      "\\\\.\\pipe\\Server",
      // Climbing out of the share as written stays on the share.
      `\\\\attacker\\share\\..\\..\\${dataDir.slice(3)}\\Server`,
    ]) {
      expect(serverConfigPathIsConfined(value, dataDir)).toBe(false);
    }
    expect(networkCalls).toEqual([]);
    // A local config folder inside the data folder still passes.
    expect(serverConfigPathIsConfined(path.join(dataDir, "Server"), dataDir)).toBe(true);
  });

  it("still judges a config folder inside a data folder that is itself on a share", async () => {
    const { serverConfigPathIsConfined } = await import("../utils/serverConfigPath.js");
    // Not refused unread: the data folder's own share is where its config is.
    expect(serverConfigPathIsConfined("\\\\nas\\Zomboid\\Server", "\\\\nas\\Zomboid")).toBe(true);
  });
});
