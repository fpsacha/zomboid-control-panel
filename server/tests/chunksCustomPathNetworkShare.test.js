import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// SECURITY (2026-10-28, R2-13): on Windows, a Map Cleanup custom path naming
// \\host\share made the panel open it (existsSync/statSync/readdirSync), so
// Windows signed in to that host with the panel account's NTLM response, and
// a typed %VAR% was expanded into the host or share name first. These tests
// stand in for Windows (process.platform) and stub every fs entry point the
// routes reach so that a network path is never really opened: a call that
// gets one is recorded, and the test fails on it.

// A custom role holding chunks.manage and nothing else.
const getRoleByName = vi.fn(async (name) =>
  name === "chunks_manage_only" ? { capabilities: ["chunks.manage"] } : mockGetRoleByName(name),
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

const NETWORK_RE = /^[\\/]{2}/;

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
const user = { role: "technician" };

function getSaves(customPath) {
  return runRoute("/saves", "get", { user, app, query: { customPath } });
}

const ENTRY_POINTS = {
  "GET /saves": (customPath) => getSaves(customPath),
  "GET /chunks/:saveName": (customPath) =>
    runRoute("/chunks/:saveName", "get", {
      user,
      app,
      params: { saveName: "TestSave" },
      query: { customPath },
    }),
  "GET /stats/:saveName": (customPath) =>
    runRoute("/stats/:saveName", "get", {
      user,
      app,
      params: { saveName: "TestSave" },
      query: { customPath },
    }),
  "POST /save-path": (customPath) =>
    runRoute("/save-path", "post", { user, app, body: { path: customPath } }),
  "POST /delete-chunks": (customPath) =>
    runRoute("/delete-chunks", "post", {
      user,
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
      user,
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

let networkCalls;
let realPlatform;
let dataRoot;

function stubFs(name, target = fs) {
  const original = target[name];
  vi.spyOn(target, name).mockImplementation((p, ...rest) => {
    if (typeof p === "string" && NETWORK_RE.test(p)) {
      networkCalls.push(`${name}(${p})`);
      if (name === "existsSync") return false;
      const error = new Error(`ENOENT: stubbed network path ${p}`);
      error.code = "ENOENT";
      throw error;
    }
    return original.call(target, p, ...rest);
  });
}

function asWindows() {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
}

beforeEach(() => {
  networkCalls = [];
  realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-unc-"));
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
  for (const name of ["existsSync", "statSync", "readdirSync", "realpathSync", "lstatSync"]) {
    stubFs(name);
  }
  stubFs("native", fs.realpathSync);
  stubFs("stat", fs.promises);
  stubFs("readdir", fs.promises);
  stubFs("unlink", fs.promises);
  stubFs("access", fs.promises);
});

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  vi.restoreAllMocks();
  delete process.env.ZCP_TEST_UNC_TARGET;
  delete process.env.ZCP_TEST_UNC_SECRET;
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

function expectRefused(res, typed) {
  expect(res.getStatusCode()).toBe(400);
  expect(res.getBody()).toMatchObject({ code: "CHUNKS_CUSTOM_PATH_NETWORK_REFUSED" });
  expect(networkCalls).toEqual([]);
  if (typed !== undefined) {
    const tried = res.getBody().rejection?.tried ?? res.getBody().debug?.rejection?.tried;
    if (tried !== undefined) expect(tried).toBe(typed);
  }
}

describe("Map Cleanup custom path on Windows: network shares and device paths are refused before any file-system call", () => {
  for (const [name, call] of Object.entries(ENTRY_POINTS)) {
    it(`${name} refuses \\\\host\\share without opening it`, async () => {
      asWindows();
      const res = await call("\\\\attacker.invalid\\share");
      expectRefused(res, "\\\\attacker.invalid\\share");
    });
  }

  it.each([
    ["forward slashes", "//attacker.invalid/share"],
    ["mixed slashes", "\\/attacker.invalid/share"],
    ["surrounding quotes and spaces", '  "\\\\attacker.invalid\\share"  '],
    ["the long-path UNC form", "\\\\?\\UNC\\attacker.invalid\\share"],
    ["a device path", "\\\\.\\pipe\\zcp-test"],
    ["a WebDAV host form", "\\\\attacker.invalid@80\\dav"],
  ])("refuses %s", async (_label, typed) => {
    asWindows();
    expectRefused(await getSaves(typed));
  });

  it("refuses a variable that expands to a share, before the share is opened", async () => {
    asWindows();
    process.env.ZCP_TEST_UNC_TARGET = "\\\\attacker.invalid\\share";
    expectRefused(await getSaves("%ZCP_TEST_UNC_TARGET%\\Zomboid"), "%ZCP_TEST_UNC_TARGET%\\Zomboid");
    expectRefused(await getSaves("${ZCP_TEST_UNC_TARGET}"));
    expectRefused(await getSaves("$ZCP_TEST_UNC_TARGET"));
  });

  it("never sends an expanded variable to the network: the share name carrying it is refused and the value is not echoed", async () => {
    asWindows();
    process.env.ZCP_TEST_UNC_SECRET = "s3cr3t-value";
    const typed = "\\\\%ZCP_TEST_UNC_SECRET%.attacker.invalid\\x";
    const res = await getSaves(typed);
    expectRefused(res, typed);
    expect(JSON.stringify(res.getBody())).not.toContain("s3cr3t-value");
  });

  it("GET /browse refuses a share outside the data folder before resolving it", async () => {
    asWindows();
    const res = await runRoute("/browse", "get", {
      user,
      app,
      query: { path: "\\\\attacker.invalid\\share" },
    });
    expect(res.getStatusCode()).toBe(403);
    expect(res.getBody()).toMatchObject({ code: "BROWSE_CHUNKS_ACCESS_DENIED" });
    expect(networkCalls).toEqual([]);
  });
});

describe("Map Cleanup custom path on Windows: a share an operator already set stays usable", () => {
  it("a server's data folder on a share, and a folder inside it, pass this check (and are then looked up as before)", async () => {
    asWindows();
    getServers.mockResolvedValue([{ id: "nas", zomboidDataPath: "\\\\nas.invalid\\pz\\Zomboid" }]);
    for (const typed of [
      "\\\\nas.invalid\\pz\\Zomboid",
      "\\\\NAS.invalid\\PZ\\zomboid\\Saves\\Multiplayer",
    ]) {
      networkCalls = [];
      const res = await getSaves(typed);
      expect(res.getBody().code).toBeUndefined();
      expect(res.getBody().debug?.rejection?.reason).toBe("not-found");
    }
  });

  it("the saved data-folder setting and PZ_SAVE_PATH count as set by an operator too", async () => {
    asWindows();
    getSetting.mockResolvedValue("\\\\nas.invalid\\legacy\\Zomboid");
    let res = await getSaves("\\\\nas.invalid\\legacy\\Zomboid");
    expect(res.getBody().code).toBeUndefined();
    const previous = process.env.PZ_SAVE_PATH;
    process.env.PZ_SAVE_PATH = "\\\\nas.invalid\\env\\Zomboid";
    try {
      res = await getSaves("\\\\nas.invalid\\env\\Zomboid");
      expect(res.getBody().code).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PZ_SAVE_PATH;
      else process.env.PZ_SAVE_PATH = previous;
    }
  });

  // Adversary pass: names that only LOOK like the configured share.
  it.each([
    ["a sibling sharing the folder name as a prefix", "\\\\nas.invalid\\pz\\Zomboid2"],
    ["a climb out of the configured folder", "\\\\nas.invalid\\pz\\Zomboid\\..\\..\\other\\x"],
    ["another host with the same share", "\\\\attacker.invalid\\pz\\Zomboid"],
    ["the configured host's parent share", "\\\\nas.invalid\\pz"],
  ])("still refuses %s", async (_label, typed) => {
    asWindows();
    getServers.mockResolvedValue([{ id: "nas", zomboidDataPath: "\\\\nas.invalid\\pz\\Zomboid" }]);
    expectRefused(await getSaves(typed), typed);
  });
});

describe("Map Cleanup custom path: what stays as it was", () => {
  it("a local folder is looked up as before on Windows (no refusal)", async () => {
    asWindows();
    const res = await getSaves(dataRoot);
    expect(res.getStatusCode()).toBe(200);
    expect(networkCalls).toEqual([]);
  });

  it("Linux and Docker are untouched: //host/share is a local path there", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const res = await getSaves("//host.invalid/share");
    expect(res.getBody().code).toBeUndefined();
  });

  it("the expanded value of a variable is no longer echoed back in a rejection's 'tried'", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "plain-"));
    try {
      process.env.ZCP_TEST_UNC_TARGET = plain;
      const res = await getSaves("%ZCP_TEST_UNC_TARGET%");
      expect(res.getBody().debug.rejection.reason).toBe("no-zomboid-markers");
      expect(res.getBody().debug.rejection.tried).toBe("%ZCP_TEST_UNC_TARGET%");
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

// codeql js/path-injection (zomboidPaths.js / zomboidDataPath.js probes):
// POST /save-path ran the data-folder rule on any folder before it checked
// server.configure, so chunks.manage alone could read that rule's verdict on
// an arbitrary folder. Without server.configure only the path already in
// effect may be saved again, so anything else is refused before it is opened.
describe("POST /save-path without server.configure", () => {
  function postAs(role, typed) {
    return runRoute("/save-path", "post", { user: { role }, app, body: { path: typed } });
  }

  function existsCallsFor(dir) {
    const wanted = path.resolve(dir).toLowerCase();
    return fs.existsSync.mock.calls.filter(
      ([p]) => typeof p === "string" && path.resolve(p).toLowerCase().startsWith(wanted),
    );
  }

  it("refuses a different folder before looking at it", async () => {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), "zomboid-probe-"));
    try {
      const res = await postAs("chunks_manage_only", probe);
      expect(res.getStatusCode()).toBe(403);
      expect(res.getBody()).toMatchObject({ code: "CHUNKS_SAVE_PATH_CAPABILITY_REQUIRED" });
      expect(existsCallsFor(probe)).toEqual([]);
      expect(updateServer).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  });

  it("still re-saves the path already in effect, however it is typed", async () => {
    const resolved = path.resolve(dataRoot);
    getActiveServer.mockResolvedValue({ id: "server-1", zomboidDataPath: resolved, isRemote: false });
    for (const typed of [dataRoot, `"${dataRoot}"`, `  ${dataRoot}  `]) {
      updateServer.mockClear();
      const res = await postAs("chunks_manage_only", typed);
      expect(res.getStatusCode()).toBe(200);
      expect(updateServer).toHaveBeenCalledWith("server-1", { zomboidDataPath: resolved });
    }
  });

  // Adversary pass: a variable or a climb that only spells the current path
  // differently gets through the early check, and the late exact check still
  // holds; a climb that lands elsewhere is refused before it is opened.
  it("a climb that lands outside the current folder is refused before it is opened", async () => {
    const resolved = path.resolve(dataRoot);
    getActiveServer.mockResolvedValue({ id: "server-1", zomboidDataPath: resolved, isRemote: false });
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "zomboid-sibling-"));
    try {
      const typed = path.join(resolved, "..", path.basename(sibling));
      const res = await postAs("chunks_manage_only", typed);
      expect(res.getStatusCode()).toBe(403);
      expect(existsCallsFor(sibling)).toEqual([]);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("a role with server.configure still repoints the server as before", async () => {
    getActiveServer.mockResolvedValue({ id: "server-1", zomboidDataPath: path.join(os.tmpdir(), "zcp-old-data-path"), isRemote: false });
    const res = await postAs("technician", dataRoot);
    expect(res.getStatusCode()).toBe(200);
    expect(updateServer).toHaveBeenCalledWith("server-1", { zomboidDataPath: path.resolve(dataRoot) });
  });
});
