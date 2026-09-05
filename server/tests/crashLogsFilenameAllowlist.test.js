import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// SECURITY (2026-09-05, crash-logs-arbitrary-read): GET /crash-logs/:filename
// validated `filename` only against "..", "/" and "\\" -- a name-shaped
// blacklist, not an allow-list of what a crash log actually looks like.
// searchDirs' FIRST entry is the raw PZ install root (serverManager.serverPath),
// so any real file living there was readable by name, including a
// panel-generated StartServer_<name>.bat/.sh, which embeds -adminpassword in
// plaintext. Confirmed live over HTTP against a throwaway loopback instance
// before this fix. The fix reuses the exact same crash-log shape check GET
// /crash-logs already enumerates by (hs_err_pid* / *crash*.log / *error*.log)
// so a non-crash-log file is refused with 400 regardless of which searchDir
// it lives in.
//
// Custom role holding ONLY diagnostics.manage, no other admin capability --
// the exact caller this route is supposed to still serve (crash-log reading
// is a real, intentional non-admin diagnostics feature), and the exact
// caller who must NOT be able to read arbitrary install-root files.
const getRoleByName = vi.fn(async (name) =>
  name === "diagnostics_manage_only"
    ? { capabilities: ["diagnostics.manage"] }
    : mockGetRoleByName(name),
);

vi.mock("../database/init.js", async () => {
  const actual = await vi.importActual("../database/init.js");
  return { ...actual, getRoleByName };
});

const { default: debugRouter } = await import("../routes/debug.js");

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

function getRouteHandlers(routePath, method) {
  const layer = debugRouter.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

async function getCrashLog(filename, installRoot) {
  const handlers = getRouteHandlers("/crash-logs/:filename", "get");
  const res = createResponse();
  const req = {
    user: { role: "diagnostics_manage_only" },
    params: { filename },
    query: {},
    body: {},
    app: {
      get: (key) =>
        key === "serverManager" ? { serverPath: installRoot } : undefined,
    },
  };
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

describe("GET /crash-logs/:filename filename allow-list", () => {
  let installRoot;

  beforeEach(() => {
    getRoleByName.mockClear();
    installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pz-install-root-"));
  });

  afterEach(() => {
    fs.rmSync(installRoot, { recursive: true, force: true });
  });

  it("refuses a non-crash-log file sitting in the install root, e.g. a generated start script with a plaintext admin password", async () => {
    const scriptName = "StartServer_TestServer.bat";
    fs.writeFileSync(
      path.join(installRoot, scriptName),
      '@echo off\nstart ProjectZomboid64.exe -adminpassword "SuperSecretPlaintextPassword123"\n',
    );

    const res = await getCrashLog(scriptName, installRoot);

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).not.toHaveProperty("content");
    expect(JSON.stringify(res.getBody())).not.toContain("SuperSecretPlaintextPassword123");
  });

  it("refuses an arbitrary non-log file with no crash/error/hs_err_pid marker in its name", async () => {
    fs.writeFileSync(path.join(installRoot, "servertest.ini"), "RCONPassword=hunter2\n");
    const res = await getCrashLog("servertest.ini", installRoot);
    expect(res.getStatusCode()).toBe(400);
  });

  it("still serves a genuine hs_err_pid Java crash dump", async () => {
    const name = "hs_err_pid12345.log";
    fs.writeFileSync(path.join(installRoot, name), "# A fatal error has been detected");
    const res = await getCrashLog(name, installRoot);
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().content).toContain("fatal error");
  });

  it("still serves a genuine *crash*.log file", async () => {
    const name = "zomboid-crash.log";
    fs.writeFileSync(path.join(installRoot, name), "crash details here");
    const res = await getCrashLog(name, installRoot);
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().content).toBe("crash details here");
  });

  it("still serves a genuine *error*.log file", async () => {
    const name = "console-error.log";
    fs.writeFileSync(path.join(installRoot, name), "error details here");
    const res = await getCrashLog(name, installRoot);
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().content).toBe("error details here");
  });
});
