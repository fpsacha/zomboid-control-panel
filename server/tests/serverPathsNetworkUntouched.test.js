import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// SECURITY (2026-10-28): on Windows, merely resolving or checking
// \\host\share\... makes the panel's account sign in to that host, handing
// it the account's NTLM login. Server-path checks still did that to a value
// they were about to refuse, or to one a servers.manage caller picked:
//  - serverConfigPathIsConfined() (POST/PUT /api/servers, servers.manage)
//    resolved the config folder through links before comparing it to the
//    data folder, and resolved the data folder itself -- a remote record's,
//    which the data-folder rule never judges at save, included;
//  - POST /api/servers/auto-scan (servers.discover) checked the scan folder
//    exists before anything else (/detect already refused a network path);
//  - POST /api/servers with importIniFrom (servers.discover) checked
//    <dataPath>/Server exists.
// Windows-only: on Linux `//host/share` is just /host/share.

const getServer = vi.fn(async () => null);
const createServer = vi.fn(async () => ({ id: 1, name: "created" }));
const updateServer = vi.fn(async () => ({ id: 1 }));

import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  getServer,
  createServer,
  updateServer,
  getRoleByName: mockGetRoleByName,
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
let savedPzSavePath;

function notFound(p) {
  return Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
}

function recordNetwork(name, fn) {
  return (p, ...rest) => {
    if (isNetworkPath(p)) {
      networkCalls.push([name, String(p)]);
      throw notFound(p);
    }
    return fn(p, ...rest);
  };
}

beforeEach(() => {
  networkCalls = [];
  savedPzSavePath = process.env.PZ_SAVE_PATH;
  delete process.env.PZ_SAVE_PATH;
  const realExistsSync = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((p) => {
    if (isNetworkPath(p)) {
      networkCalls.push(["existsSync", String(p)]);
      return false;
    }
    return realExistsSync(p);
  });
  // The originals are taken before any spy replaces them.
  const originals = {
    statSync: fs.statSync,
    lstatSync: fs.lstatSync,
    readdirSync: fs.readdirSync,
    readFileSync: fs.readFileSync,
    realpathNative: fs.realpathSync.native,
  };
  for (const name of ["statSync", "lstatSync", "readdirSync", "readFileSync"]) {
    vi.spyOn(fs, name).mockImplementation(recordNetwork(name, originals[name]));
  }
  vi.spyOn(fs.realpathSync, "native").mockImplementation(
    recordNetwork("realpathSync.native", originals.realpathNative),
  );
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-unc-serverpaths-"));
  fs.mkdirSync(path.join(dataDir, "Server"));
  getServer.mockReset();
  getServer.mockResolvedValue(null);
  createServer.mockClear();
  updateServer.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedPzSavePath === undefined) delete process.env.PZ_SAVE_PATH;
  else process.env.PZ_SAVE_PATH = savedPzSavePath;
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

  it("refuses a data folder on a share without resolving it, whatever the config folder", async () => {
    const { serverConfigPathIsConfined } = await import("../utils/serverConfigPath.js");
    // A local config folder held to a data folder on a share.
    expect(serverConfigPathIsConfined(path.join(dataDir, "Server"), "\\\\attacker\\share")).toBe(false);
    // Both on the same share.
    expect(serverConfigPathIsConfined("\\\\attacker\\share\\Server", "\\\\attacker\\share")).toBe(false);
    expect(serverConfigPathIsConfined("//attacker/share/Z/Server", "//attacker/share/Z")).toBe(false);
    // One of Map Cleanup's 1.4.5 shapes, its Zomboid folder on a share.
    expect(
      serverConfigPathIsConfined("\\\\attacker\\Zomboid\\Server", "\\\\attacker\\Zomboid\\Saves\\Multiplayer"),
    ).toBe(false);
    expect(networkCalls).toEqual([]);
  });

  it("still accepts the operator's own PZ_SAVE_PATH on a share, and nothing on another share", async () => {
    const { serverConfigPathIsConfined } = await import("../utils/serverConfigPath.js");
    process.env.PZ_SAVE_PATH = "\\\\nas\\Zomboid";
    expect(serverConfigPathIsConfined("\\\\nas\\Zomboid\\Server", "\\\\nas\\Zomboid")).toBe(true);
    networkCalls = [];
    expect(serverConfigPathIsConfined("\\\\attacker\\share\\Server", "\\\\nas\\Zomboid")).toBe(false);
    expect(networkCalls.filter(([, p]) => /attacker/i.test(p))).toEqual([]);
  });

  it("POST /api/servers/auto-scan refuses a network scan folder without touching it", async () => {
    const { default: router } = await import("../routes/servers.js");
    for (const scanPath of ["\\\\attacker\\share\\servers", "//attacker/share/servers"]) {
      const res = createResponse();
      await lastHandler(router, "/auto-scan", "post")({ body: { scanPath }, app: { get: () => undefined } }, res);
      expect(res.getStatusCode()).toBe(400);
    }
    expect(networkCalls).toEqual([]);
  });

  it("POST /api/servers refuses a network install folder without touching it (regression)", async () => {
    const { default: router } = await import("../routes/servers.js");
    const res = createResponse();
    await lastHandler(router, "/", "post")(
      {
        body: {
          name: "Share",
          installPath: "\\\\attacker\\share\\pz",
          rconHost: "127.0.0.1",
          rconPort: 27015,
          rconPassword: "secret",
        },
        app: { get: () => undefined },
      },
      res,
    );
    expect(res.getStatusCode()).toBe(400);
    expect(networkCalls).toEqual([]);
  });

  it("POST /api/servers refuses an importIniFrom folder on a share without touching it", async () => {
    const { default: router } = await import("../routes/servers.js");
    for (const dataPath of ["\\\\attacker\\share\\Z", "//attacker/share/Z"]) {
      const res = createResponse();
      await lastHandler(router, "/", "post")(
        {
          body: {
            name: "Imported",
            installPath: dataDir,
            rconHost: "127.0.0.1",
            rconPort: 27015,
            importIniFrom: { dataPath, serverName: "servertest" },
          },
          user: { role: "admin" },
          app: { get: () => undefined },
        },
        res,
      );
      expect(res.getStatusCode()).toBe(400);
    }
    expect(networkCalls).toEqual([]);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("POST /api/servers refuses a remote server whose data folder is on a share, unread", async () => {
    const { default: router } = await import("../routes/servers.js");
    for (const extra of [
      { serverConfigPath: "\\\\attacker\\share\\Z\\Server" },
      { serverConfigPath: path.join(dataDir, "Server") },
      {},
    ]) {
      const res = createResponse();
      await lastHandler(router, "/", "post")(
        {
          body: {
            name: "Remote",
            isRemote: true,
            zomboidDataPath: "\\\\attacker\\share\\Z",
            rconHost: "127.0.0.1",
            rconPort: 27015,
            rconPassword: "secret",
            ...extra,
          },
          user: { role: "technician" },
          app: { get: () => undefined },
        },
        res,
      );
      expect(res.getStatusCode()).toBe(400);
    }
    expect(networkCalls).toEqual([]);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("PUT /api/servers/:id refuses a remote record's data folder on a share, unread", async () => {
    const { default: router } = await import("../routes/servers.js");
    getServer.mockResolvedValue({
      id: 7,
      name: "Remote",
      isRemote: true,
      zomboidDataPath: "/home/pz/Zomboid",
      serverConfigPath: null,
      rconHost: "127.0.0.1",
      rconPort: 27015,
    });
    for (const body of [
      { zomboidDataPath: "\\\\attacker\\share\\Z", serverConfigPath: "\\\\attacker\\share\\Z\\Server" },
      { zomboidDataPath: "\\\\attacker\\share\\Z" },
      { isRemote: true, zomboidDataPath: "//attacker/share/Z", serverConfigPath: path.join(dataDir, "Server") },
    ]) {
      const res = createResponse();
      await lastHandler(router, "/:id", "put")(
        { params: { id: "7" }, body, user: { role: "technician" }, app: { get: () => undefined } },
        res,
      );
      expect(res.getStatusCode()).toBe(400);
    }
    expect(networkCalls).toEqual([]);
    expect(updateServer).not.toHaveBeenCalled();
  });

  it("PUT /api/servers/:id refuses a new config folder for a remote record already holding a share, unread", async () => {
    const { default: router } = await import("../routes/servers.js");
    // Saved before this check existed.
    getServer.mockResolvedValue({
      id: 8,
      name: "Remote",
      isRemote: true,
      zomboidDataPath: "\\\\attacker\\share\\Z",
      serverConfigPath: null,
      rconHost: "127.0.0.1",
      rconPort: 27015,
    });
    const res = createResponse();
    await lastHandler(router, "/:id", "put")(
      {
        params: { id: "8" },
        body: { serverConfigPath: "\\\\attacker\\share\\Z\\Server" },
        user: { role: "technician" },
        app: { get: () => undefined },
      },
      res,
    );
    expect(res.getStatusCode()).toBe(400);
    expect(networkCalls).toEqual([]);
    expect(updateServer).not.toHaveBeenCalled();
  });
});
