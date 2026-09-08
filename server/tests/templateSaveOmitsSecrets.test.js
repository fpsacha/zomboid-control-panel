import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// bug-hunt-2026-08-26: POST /server-files/templates used to snapshot the
// CURRENT server.ini verbatim (both parsed into `.ini` and as raw text into
// `.iniRaw`) with no exclusion list, so RCONPassword/Password ended up
// persisted in plaintext inside the saved template JSON -- forever, since
// nothing expires or re-scrubs a template later, and a subsequent password
// rotation does not touch a copy nobody knows exists. Fixed at the write
// path: secret-shaped keys (SENSITIVE_FIELD_RE, the same regex GET
// /app-settings already trusts) are stripped, not masked, before the
// template is written to disk -- see stripSensitiveIniLines()'s own comment
// in routes/serverFiles.js for why a placeholder string would be unsafe
// here (POST /templates/:id/apply writes iniRaw back into the live .ini
// verbatim, so a masked value would land in the live RCON password field).

const writeFileAtomic = vi.fn();
vi.mock("../utils/fileWriteQueue.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, writeFileAtomic };
});

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
const RCON_PASSWORD = "s3cr3t-rcon-pass";
const JOIN_PASSWORD = "s3cr3t-join-pass";
let configDir;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-save-secrets-"));
  fs.writeFileSync(
    path.join(configDir, `${SERVER_NAME}.ini`),
    [
      "PVP=true",
      `RCONPassword=${RCON_PASSWORD}`,
      `Password=${JOIN_PASSWORD}`,
      "DefaultPort=16261",
      "; a comment line",
      "",
    ].join("\n"),
  );
  getActiveServer.mockReset().mockResolvedValue({
    serverConfigPath: configDir,
    serverName: SERVER_NAME,
  });
  writeFileAtomic.mockClear();
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

function postSave(body = {}) {
  return runRoute("/templates", "post", {
    user: { role: "admin" },
    body: { name: "My Template", includeIni: true, includeSandbox: false, ...body },
  });
}

function readSavedTemplateRaw(id) {
  return fs.readFileSync(path.join(configDir, "templates", `${id}.json`), "utf-8");
}

describe("serverFiles.js POST /templates: secret-shaped INI keys never reach the saved snapshot", () => {
  it("omits RCONPassword and Password from both the parsed and raw copies", async () => {
    const res = await postSave();
    expect(res.getStatusCode()).toBe(200);
    const id = res.getBody().id;

    const raw = readSavedTemplateRaw(id);
    expect(raw).not.toContain(RCON_PASSWORD);
    expect(raw).not.toContain(JOIN_PASSWORD);
    expect(raw).not.toMatch(/RCONPassword/i);
    // "Password=" itself (the key) is fine to have stripped; the VALUE
    // must never appear anywhere, checked above. Confirm the key line is
    // gone too, not just re-valued.
    expect(raw).not.toMatch(/^Password=/m);

    const saved = JSON.parse(raw);
    expect(saved.ini).not.toHaveProperty("RCONPassword");
    expect(saved.ini).not.toHaveProperty("Password");
  });

  it("keeps every non-secret key and preserves comments/formatting in iniRaw", async () => {
    const res = await postSave();
    const id = res.getBody().id;
    const saved = JSON.parse(readSavedTemplateRaw(id));

    expect(saved.ini.PVP).toBe("true");
    expect(saved.ini.DefaultPort).toBe("16261");
    expect(saved.iniRaw).toContain("PVP=true");
    expect(saved.iniRaw).toContain("DefaultPort=16261");
    expect(saved.iniRaw).toContain("; a comment line");
  });

  it("still saves a usable template when the ini has no secret-shaped keys at all", async () => {
    fs.writeFileSync(
      path.join(configDir, `${SERVER_NAME}.ini`),
      "PVP=false\nDefaultPort=16262\n",
    );
    const res = await postSave();
    expect(res.getStatusCode()).toBe(200);
    const saved = JSON.parse(readSavedTemplateRaw(res.getBody().id));
    expect(saved.ini).toEqual({ PVP: "false", DefaultPort: "16262" });
    expect(saved.iniRaw).toBe("PVP=false\nDefaultPort=16262\n");
  });
});

describe("serverFiles.js POST /templates/:id/apply: applying a secret-stripped template is a safe no-crash outcome, not a masked-value outage", () => {
  it("applies the remaining fields and leaves the live ini with no RCONPassword line at all (not a placeholder string)", async () => {
    const saveRes = await postSave();
    const id = saveRes.getBody().id;

    const applyRes = await runRoute("/templates/:id/apply", "post", {
      user: { role: "admin" },
      params: { id },
      body: {},
    });

    expect(applyRes.getStatusCode()).toBe(200);
    expect(writeFileAtomic).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContent] = writeFileAtomic.mock.calls[0];
    expect(String(writtenPath)).toContain(`${SERVER_NAME}.ini`);
    expect(writtenContent).not.toMatch(/RCONPassword/i);
    expect(writtenContent).not.toContain(RCON_PASSWORD);
    expect(writtenContent).toContain("PVP=true");
  });
});
