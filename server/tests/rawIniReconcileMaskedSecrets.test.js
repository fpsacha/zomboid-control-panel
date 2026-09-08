import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";
import { maskSecretValue } from "../utils/sanitize.js";
import { ErrorCode } from "../utils/errorCodes.js";

// bug-hunt-2026-08-27 (finding #2, /raw half): GET /server-files/raw/ini
// returned the live .ini's full text unmasked. Unlike the structured /ini
// route (a per-key merge -- see serverFilesIniMasksSecrets.test.js), the raw
// editor round-trips ONE FULL TEXT BLOB on every save, unconditionally,
// regardless of which line the operator actually touched. So masking the
// GET response alone would let ANY raw-mode save silently overwrite the
// live RCONPassword/Password line with the literal "••••••••xxxx"
// placeholder. reconcileMaskedIniLines() (serverFiles.js) fixes this by
// matching secret-shaped lines back to the live file BY KEY (immune to
// reordering/insertion) and REFUSING the entire save -- writing nothing --
// the instant a masked value can't be resolved to exactly one live value,
// rather than guessing. Deliberately not mocking fileWriteQueue.js/
// configBackup.js here: PUT /raw/ini now routes through the real
// writeIniWithBackup(), and these tests assert on its actual side effects
// (a .bak file appearing, or NOT appearing on a refused save).

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

const SERVER_NAME = "TestRaw";
const RCON_PASSWORD = "s3cr3t-rcon-pass";
const JOIN_PASSWORD = "s3cr3t-join-pass";
const MASKED_RCON = maskSecretValue(RCON_PASSWORD);
const MASKED_JOIN = maskSecretValue(JOIN_PASSWORD);
let configDir;
let iniPath;
let backupDir;

function baseIni() {
  return [
    "PVP=true",
    `RCONPassword=${RCON_PASSWORD}`,
    `Password=${JOIN_PASSWORD}`,
    "DefaultPort=16261",
    "",
  ].join("\n");
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-ini-reconcile-"));
  iniPath = path.join(configDir, `${SERVER_NAME}.ini`);
  backupDir = path.join(configDir, "backups");
  fs.writeFileSync(iniPath, baseIni());
  getActiveServer.mockReset().mockResolvedValue({
    serverConfigPath: configDir,
    serverName: SERVER_NAME,
  });
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

function getRawIni() {
  return runRoute("/raw/:type", "get", { user: { role: "admin" }, params: { type: "ini" } });
}

function putRawIni(content) {
  return runRoute("/raw/:type", "put", {
    user: { role: "admin" },
    params: { type: "ini" },
    body: { content },
  });
}

function backupCount() {
  if (!fs.existsSync(backupDir)) return 0;
  return fs.readdirSync(backupDir).filter((f) => f.endsWith(".bak")).length;
}

describe("serverFiles.js GET /raw/ini: secret-shaped lines are masked, format preserved", () => {
  it("masks RCONPassword and Password values only, leaves keys/other lines untouched", async () => {
    const res = await getRawIni();
    expect(res.getStatusCode()).toBe(200);
    const { content } = res.getBody();
    expect(content).toContain(`RCONPassword=${MASKED_RCON}`);
    expect(content).toContain(`Password=${MASKED_JOIN}`);
    expect(content).toContain("PVP=true");
    expect(content).toContain("DefaultPort=16261");
    expect(content).not.toContain(RCON_PASSWORD);
    expect(content).not.toContain(JOIN_PASSWORD);
  });
});

describe("serverFiles.js PUT /raw/ini: unmodified masked lines are preserved, not written as placeholders", () => {
  it("round-trips the masked GET response unchanged without corrupting the live secrets", async () => {
    const { content: masked } = (await getRawIni()).getBody();
    const res = await putRawIni(masked);
    expect(res.getStatusCode()).toBe(200);

    const onDisk = fs.readFileSync(iniPath, "utf-8");
    expect(onDisk).toContain(`RCONPassword=${RCON_PASSWORD}`);
    expect(onDisk).toContain(`Password=${JOIN_PASSWORD}`);
    expect(backupCount()).toBe(1);
  });

  it("preserves the masked secrets when an UNRELATED line is edited in the same save", async () => {
    const { content: masked } = (await getRawIni()).getBody();
    const edited = masked.replace("PVP=true", "PVP=false");

    const res = await putRawIni(edited);
    expect(res.getStatusCode()).toBe(200);

    const onDisk = fs.readFileSync(iniPath, "utf-8");
    expect(onDisk).toContain(`RCONPassword=${RCON_PASSWORD}`);
    expect(onDisk).toContain(`Password=${JOIN_PASSWORD}`);
    expect(onDisk).toContain("PVP=false");
  });

  it("still writes a genuinely new password when the operator types over the mask", async () => {
    const { content: masked } = (await getRawIni()).getBody();
    const NEW_PASSWORD = "brand-new-rcon-pass";
    const edited = masked.replace(`RCONPassword=${MASKED_RCON}`, `RCONPassword=${NEW_PASSWORD}`);

    const res = await putRawIni(edited);
    expect(res.getStatusCode()).toBe(200);

    const onDisk = fs.readFileSync(iniPath, "utf-8");
    expect(onDisk).toContain(`RCONPassword=${NEW_PASSWORD}`);
    expect(onDisk).not.toContain(RCON_PASSWORD);
  });

  it("resolves correctly when lines are REORDERED (matches by key, not position)", async () => {
    const { content: masked } = (await getRawIni()).getBody();
    const lines = masked.split("\n").filter(Boolean);
    const reordered = [...lines].reverse().join("\n") + "\n";

    const res = await putRawIni(reordered);
    expect(res.getStatusCode()).toBe(200);

    const onDisk = fs.readFileSync(iniPath, "utf-8");
    expect(onDisk).toContain(`RCONPassword=${RCON_PASSWORD}`);
    expect(onDisk).toContain(`Password=${JOIN_PASSWORD}`);
  });

  it("resolves correctly when a new line is INSERTED above the masked password", async () => {
    const { content: masked } = (await getRawIni()).getBody();
    const withInsertion = masked.replace(
      `RCONPassword=${MASKED_RCON}`,
      `PublicName=My Server\nRCONPassword=${MASKED_RCON}`,
    );

    const res = await putRawIni(withInsertion);
    expect(res.getStatusCode()).toBe(200);

    const onDisk = fs.readFileSync(iniPath, "utf-8");
    expect(onDisk).toContain(`RCONPassword=${RCON_PASSWORD}`);
    expect(onDisk).toContain("PublicName=My Server");
  });
});

describe("serverFiles.js PUT /raw/ini: ambiguous or destructive cases REFUSE the save and write nothing", () => {
  it("refuses when the masked key appears TWICE in the submitted content", async () => {
    const { content: masked } = (await getRawIni()).getBody();
    const duplicated = masked + `\nRCONPassword=${MASKED_RCON}\n`;

    const res = await putRawIni(duplicated);
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe(ErrorCode.RAW_INI_SECRET_UNRESOLVABLE);

    expect(fs.readFileSync(iniPath, "utf-8")).toBe(baseIni());
    expect(backupCount()).toBe(0);
  });

  it("refuses when the key already appears TWICE in the LIVE file on disk", async () => {
    fs.writeFileSync(iniPath, baseIni() + `RCONPassword=${RCON_PASSWORD}-dup\n`);
    const { content: masked } = (await getRawIni()).getBody();

    const res = await putRawIni(masked);
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe(ErrorCode.RAW_INI_SECRET_UNRESOLVABLE);
    expect(backupCount()).toBe(0);
  });

  it("refuses when the masked key no longer exists in the live file at all", async () => {
    const { content: masked } = (await getRawIni()).getBody();
    // Simulate the live file changing out from under the editor between
    // load and save (e.g. another process/route rewrote it).
    fs.writeFileSync(iniPath, "PVP=true\nDefaultPort=16261\n");

    const res = await putRawIni(masked);
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe(ErrorCode.RAW_INI_SECRET_UNRESOLVABLE);
    expect(fs.readFileSync(iniPath, "utf-8")).toBe("PVP=true\nDefaultPort=16261\n");
    expect(backupCount()).toBe(0);
  });

  it("refuses when the operator deletes the masked line entirely, rather than silently dropping or restoring the credential", async () => {
    const { content: masked } = (await getRawIni()).getBody();
    const deleted = masked
      .split("\n")
      .filter((line) => !line.startsWith("RCONPassword="))
      .join("\n");

    const res = await putRawIni(deleted);
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe(ErrorCode.RAW_INI_SECRET_LINE_REMOVED);
    expect(res.getBody().params).toMatchObject({ key: "RCONPassword" });

    expect(fs.readFileSync(iniPath, "utf-8")).toBe(baseIni());
    expect(backupCount()).toBe(0);
  });
});
