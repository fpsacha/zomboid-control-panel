import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { EventEmitter } from "events";

// spawn() is mocked at module scope (not per-test) because server.js binds
// it as a live import at module load time; a mock installed after import
// wouldn't be seen. exec is left as the real implementation via
// importOriginal -- nothing under test here calls it.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

// GET /api/server/branches derived an executable path from
// req.query.steamcmdPath and spawned it directly -- the only path-taking
// route in server.js that skipped the isValidPath() check every sibling
// route applies. Once role-gated to admin+technician that was reachable
// authority to run an attacker-chosen binary as the panel process, not just
// a known one in a validated location (per god's ruling: identical role
// labels hiding different authority is how an escalation stays invisible).
// Same class of bug existed in panelBridge.js's /configure and /auto-detect,
// which fed an unvalidated path straight into bridge.configure()/autoDetect()
// -- no validation there either, and it flows into mkdirSync/writeFileSync
// once the bridge starts. This file exercises the fix, not just the role gate.

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async (key) => (key === "steamcmdPath" ? null : null)),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
}));

function createResponse() {
  const response = { status: () => response, json: () => response };
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

function getRouteHandler(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  // Last handler in the stack: requireRole runs first, the real logic last.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe("GET /api/server/branches rejects an unvalidated steamcmdPath", () => {
  it("refuses a relative path with 400 instead of deriving an executable from it", async () => {
    const { default: router } = await import("../routes/server.js");
    const res = createResponse();
    await getRouteHandler(router, "/branches", "get")(
      { query: { steamcmdPath: "relative/not/absolute" }, app: { get: () => undefined } },
      res,
    );
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toEqual({
      error: "Invalid SteamCMD path",
      code: "STEAMCMD_PATH_INVALID",
    });
  });

  it("falls back normally for a valid absolute path that just doesn't exist", async () => {
    const { default: router } = await import("../routes/server.js");
    const res = createResponse();
    await getRouteHandler(router, "/branches", "get")(
      {
        query: { steamcmdPath: process.platform === "win32" ? "C:\\nonexistent-steamcmd" : "/nonexistent/steamcmd" },
        app: { get: () => undefined },
      },
      res,
    );
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(
      expect.objectContaining({ source: "fallback" }),
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // The validation gate above only proves an invalid path never reaches
  // getSteamCmdExe()/spawn() -- it does not prove a VALID path still does.
  // A check that's too strict would silently break every legitimate branch
  // lookup while looking identical in the refusal tests. Mock fs.existsSync
  // so the derived executable path "exists" and mock spawn so nothing real
  // runs, then assert spawn was actually invoked with it.
  it("a valid, existing steamcmd path still reaches the spawn call", async () => {
    const validPath =
      process.platform === "win32" ? "C:\\steamcmd" : "/opt/steamcmd";
    const existsSpy = vi
      .spyOn(fs, "existsSync")
      .mockImplementation((p) => String(p).toLowerCase().includes("steamcmd"));

    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });

    try {
      const { default: router } = await import("../routes/server.js");
      const res = createResponse();
      await getRouteHandler(router, "/branches", "get")(
        { query: { steamcmdPath: validPath }, app: { get: () => undefined } },
        res,
      );

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledWith(
        expect.stringContaining("steamcmd"),
        expect.arrayContaining(["+login", "anonymous"]),
        expect.any(Object),
      );
    } finally {
      existsSpy.mockRestore();
      spawnMock.mockReset();
    }
  });
});

describe("server path validation rejects raw traversal segments", () => {
  it("rejects an absolute path containing a parent segment before normalization erases it", async () => {
    const { isValidPath } = await import("../routes/server.js");
    const absolutePath =
      process.platform === "win32"
        ? "C:\\pz\\..\\Windows\\System32"
        : "/var/lib/../etc";

    expect(isValidPath(absolutePath)).toBe(false);
  });
});

// path-resolution sweep, 2026-09-06: resolveZomboidPaths()'s default data
// path used to be a naive template string (`${installPath}_Data`), which
// only produces the intended SIBLING folder when installPath has no
// trailing separator. isValidPath() rejects ".." and non-absolute paths but
// not a trailing one, and path.normalize() does not strip a single trailing
// separator either -- so an installPath copy-pasted from an Explorer
// address bar (which often carries one) silently nested the default data
// folder INSIDE the install folder instead of beside it, exactly the
// condition /delete-files's own nested-data-path check exists to refuse.
describe("resolveZomboidPaths default data path survives a trailing separator", () => {
  it("derives the same sibling _Data folder whether or not installPath has a trailing separator", async () => {
    const { resolveZomboidPaths } = await import("../routes/server.js");
    const withoutSep =
      process.platform === "win32" ? "D:\\Servers\\MyServer" : "/srv/pz/MyServer";
    const withSep = withoutSep + path.sep;

    const resultWithoutSep = resolveZomboidPaths(withoutSep, null);
    const resultWithSep = resolveZomboidPaths(withSep, null);

    expect(resultWithSep.zomboidPath).toBe(resultWithoutSep.zomboidPath);
    expect(resultWithSep.zomboidPath).toBe(withoutSep + "_Data");
    // The bug's exact wrong shape: a trailing separator used to make this a
    // subdirectory named "_Data" INSIDE the install folder instead of a
    // sibling next to it.
    expect(resultWithSep.zomboidPath).not.toBe(path.join(withoutSep, "_Data"));
  });

  it("still honors an explicit zomboidDataPath regardless of installPath's separator", async () => {
    const { resolveZomboidPaths } = await import("../routes/server.js");
    const installPath =
      (process.platform === "win32" ? "D:\\Servers\\MyServer" : "/srv/pz/MyServer") +
      path.sep;
    const explicitData =
      process.platform === "win32" ? "D:\\Data\\Custom" : "/srv/data/custom";

    const result = resolveZomboidPaths(installPath, explicitData);

    expect(result.zomboidPath).toBe(explicitData);
  });
});

describe("panelBridge.js /configure and /auto-detect reject an unvalidated path", () => {
  it("POST /configure refuses a relative zomboidSavePath", async () => {
    const { default: router } = await import("../routes/panelBridge.js");
    const res = createResponse();
    await getRouteHandler(router, "/configure", "post")(
      { body: { zomboidSavePath: "relative/save/path" } },
      res,
    );
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toEqual({
      error: "Invalid zomboidSavePath",
      code: "PANELBRIDGE_INVALID_SAVE_PATH",
    });
  });

  it("POST /configure refuses a protected system directory", async () => {
    const { default: router } = await import("../routes/panelBridge.js");
    const res = createResponse();
    const systemPath = process.platform === "win32" ? "C:\\Windows\\evil" : "/etc/evil";
    await getRouteHandler(router, "/configure", "post")(
      { body: { zomboidSavePath: systemPath } },
      res,
    );
    expect(res.getStatusCode()).toBe(400);
  });

  it("POST /auto-detect refuses a relative zomboidUserFolder when provided", async () => {
    const { default: router } = await import("../routes/panelBridge.js");
    const res = createResponse();
    await getRouteHandler(router, "/auto-detect", "post")(
      { body: { serverName: "servertest", zomboidUserFolder: "relative/folder" } },
      res,
    );
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toEqual({
      error: "Invalid zomboidUserFolder path",
      code: "PANELBRIDGE_INVALID_ZOMBOID_USER_FOLDER",
    });
  });

  it("POST /configure-direct refuses a relative bridgePath (the isAbsolute check was checking path.resolve()'s result, which is always absolute -- a no-op that never rejected anything)", async () => {
    const { default: router } = await import("../routes/panelBridge.js");
    const res = createResponse();
    await getRouteHandler(router, "/configure-direct", "post")(
      { body: { bridgePath: "relative/bridge/path" } },
      res,
    );
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toEqual({
      error: "Path must be absolute",
      code: "PANELBRIDGE_PATH_MUST_BE_ABSOLUTE",
    });
  });

  it("POST /configure-direct still refuses a protected system directory (pre-existing check, now sharing the same blocklist)", async () => {
    const { default: router } = await import("../routes/panelBridge.js");
    const res = createResponse();
    const systemPath = process.platform === "win32" ? "C:\\Windows\\evil" : "/etc/evil";
    await getRouteHandler(router, "/configure-direct", "post")(
      { body: { bridgePath: systemPath } },
      res,
    );
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toEqual({
      error: "Path targets a protected system directory",
      code: "PANELBRIDGE_PATH_PROTECTED_SYSTEM_DIR",
    });
  });
});
