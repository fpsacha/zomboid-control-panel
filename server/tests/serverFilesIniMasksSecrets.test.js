import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";
import { maskSecretValue } from "../utils/sanitize.js";

// bug-hunt-2026-08-27 (finding #2, GET /ini half): GET /server-files/ini
// used to return the live RCONPassword/Password in plaintext to any role
// gated onto serverfiles.manage -- opening the structured Server Config
// editor put the live RCON password on screen in a normal text field.
// PUT /server-files/ini round-trips this SAME settings object back on
// every save (the client always resubmits the full map, not just the
// field the operator touched), so masking the GET response only becomes
// safe once PUT also learns to recognise and drop an unmodified masked
// value instead of writing the placeholder string into the live file --
// same skip-write-if-masked-echoed-back idiom already used by
// config.js/oidc.js/servers.js, applied here for the first time.

// fileWriteQueue.js is deliberately left unmocked here: PUT /ini re-reads
// the file it just wrote for its own write-verification step, so a mock
// that doesn't actually touch disk would make that verification compare
// against stale content. templateSaveOmitsSecrets.test.js could mock it
// because POST /templates never reads its own write back; this route does.

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
// router's own gate (a non-route router.use() layer, so getRouteHandlers()
// above -- which only walks a specific route's OWN handler stack -- never
// ran it). Run that gate first, on the same req, before the route's own
// handlers, matching what Express's real dispatch does.
function getGateMiddleware() {
  return router.stack.filter((entry) => !entry.route)[1].handle;
}

async function runRoute(routePath, method, req) {
  const res = createResponse();
  await getGateMiddleware()(req, res, () => {});
  const handlers = getRouteHandlers(routePath, method);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

const SERVER_NAME = "TestIni";
const RCON_PASSWORD = "s3cr3t-rcon-pass";
const JOIN_PASSWORD = "s3cr3t-join-pass";
const MASKED_RCON = maskSecretValue(RCON_PASSWORD);
const MASKED_JOIN = maskSecretValue(JOIN_PASSWORD);
let configDir;
let iniPath;

function writeIni() {
  fs.writeFileSync(
    iniPath,
    [
      "PVP=true",
      `RCONPassword=${RCON_PASSWORD}`,
      `Password=${JOIN_PASSWORD}`,
      "DefaultPort=16261",
      "",
    ].join("\n"),
  );
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ini-mask-secrets-"));
  iniPath = path.join(configDir, `${SERVER_NAME}.ini`);
  writeIni();
  getActiveServer.mockReset().mockResolvedValue({
    serverConfigPath: configDir,
    serverName: SERVER_NAME,
  });
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

function getIni() {
  return runRoute("/ini", "get", { user: { role: "admin" } });
}

function putIni(settings) {
  return runRoute("/ini", "put", { user: { role: "admin" }, body: { settings } });
}

describe("serverFiles.js GET /ini: secret-shaped keys never reach the response in plaintext", () => {
  it("masks RCONPassword and Password, keeps everything else as-is", async () => {
    const res = await getIni();
    expect(res.getStatusCode()).toBe(200);
    const { settings } = res.getBody();
    expect(settings.RCONPassword).toBe(MASKED_RCON);
    expect(settings.Password).toBe(MASKED_JOIN);
    expect(settings.PVP).toBe("true");
    expect(settings.DefaultPort).toBe("16261");
  });
});

describe("serverFiles.js PUT /ini: an unmodified masked value never overwrites the stored secret", () => {
  it("preserves the live RCONPassword/Password when the client echoes the mask back unchanged", async () => {
    const { settings: loaded } = (await getIni()).getBody();

    const res = await putIni({ ...loaded, PVP: "false" });
    expect(res.getStatusCode()).toBe(200);

    const onDisk = fs.readFileSync(iniPath, "utf-8");
    expect(onDisk).toContain(`RCONPassword=${RCON_PASSWORD}`);
    expect(onDisk).toContain(`Password=${JOIN_PASSWORD}`);
    expect(onDisk).toContain("PVP=false");

    // The response itself must also mask, not just the disk write.
    const { settings: returned } = res.getBody();
    expect(returned.RCONPassword).toBe(MASKED_RCON);
    expect(returned.Password).toBe(MASKED_JOIN);
    expect(JSON.stringify(res.getBody())).not.toContain(RCON_PASSWORD);
  });

  it("still writes a genuinely new password when the client sends a real (non-masked) value", async () => {
    const { settings: loaded } = (await getIni()).getBody();
    const NEW_PASSWORD = "brand-new-rcon-pass";

    const res = await putIni({ ...loaded, RCONPassword: NEW_PASSWORD });
    expect(res.getStatusCode()).toBe(200);

    const onDisk = fs.readFileSync(iniPath, "utf-8");
    expect(onDisk).toContain(`RCONPassword=${NEW_PASSWORD}`);
    expect(onDisk).not.toContain(RCON_PASSWORD);
  });

  it("still saves normally when the ini has no secret-shaped keys at all", async () => {
    fs.writeFileSync(iniPath, "PVP=false\nDefaultPort=16262\n");
    const res = await putIni({ PVP: "true", DefaultPort: "16262" });
    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("PVP=true");
  });
});
