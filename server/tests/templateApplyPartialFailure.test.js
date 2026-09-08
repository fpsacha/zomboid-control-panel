import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// POST /server-files/templates/:id/apply writes INI then Sandbox settings as
// two separate steps. If the INI write succeeds and the Sandbox write then
// fails, the route falls into its outer catch and responds with a flat
// { error } -- reading as "nothing happened" -- even though the INI file was
// already overwritten. Diagnosed in docs/qa/kevin-route-hunt.md Finding 4,
// confirmed still present: the `applied` array that WOULD tell the truth is
// only ever read on the success path.

const withFileLock = vi.fn(async (filePath, fn) => {
  if (String(filePath).includes("SandboxVars")) {
    throw new Error("boom-sandbox-write");
  }
  return fn();
});
const writeFileAtomic = vi.fn();

vi.mock("../utils/fileWriteQueue.js", () => ({ withFileLock, writeFileAtomic }));

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings: vi.fn(async () => ({})),
  getRoleByName: mockGetRoleByName,
}));

const { default: router } = await import("../routes/serverFiles.js");

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
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

// 2026-09-08 quadruple-read sweep: every handler now reads
// req.activeServerContext instead of re-deriving it, populated once by the
// router's own gate (a non-route layer getRouteHandlers() above never
// reaches). Run it first, on the same req.
function getGateMiddleware() {
  return router.stack.filter((entry) => !entry.route)[1].handle;
}

async function runRoute(routePath, method, req) {
  const handlers = getRouteHandlers(routePath, method);
  const res = createResponse();
  await getGateMiddleware()(req, res, () => {});
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

const SERVER_NAME = "TestSave";
let configDir;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-apply-partial-"));
  fs.mkdirSync(path.join(configDir, "templates"), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "templates", "tpl-1.json"),
    JSON.stringify({
      name: "My Template",
      iniRaw: "PVP=true\n",
      sandboxRaw: "SandboxVars = {\n  Zombies = 1,\n}\n",
    }),
  );
  getActiveServer.mockReset().mockResolvedValue({
    serverConfigPath: configDir,
    serverName: SERVER_NAME,
  });
  withFileLock.mockClear();
  writeFileAtomic.mockClear();
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

function postApply() {
  return runRoute("/templates/:id/apply", "post", {
    user: { role: "admin" },
    params: { id: "tpl-1" },
    body: {},
  });
}

describe("serverFiles.js POST /templates/:id/apply: a partial apply must not read as total failure", () => {
  it("reports which settings actually landed when the INI write succeeds but the Sandbox write then fails", async () => {
    const res = await postApply();

    // The INI write really did happen (writeFileAtomic was called for it)
    // before the Sandbox write threw.
    expect(writeFileAtomic).toHaveBeenCalledTimes(1);
    expect(String(writeFileAtomic.mock.calls[0][0])).toContain(`${SERVER_NAME}.ini`);

    const body = res.getBody();
    expect(body.success).toBe(false);
    expect(body.partiallyApplied).toEqual(["INI"]);
  });
});
