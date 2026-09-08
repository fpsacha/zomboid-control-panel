import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// Angela's trace (bug-hunt-2026-08-27, priority insert): PUT /server-files/ini
// submits the WHOLE iniSettings object every save, never a diff. toIni()
// re-walks the original file and, for any key present in the submitted
// object (which is every key, always), rewrites EVERY line matching that
// key name to the one submitted value. parseIni() is last-occurrence-wins,
// so the form always shows (and would resave) the LAST copy of a
// duplicated key -- permanently overwriting the FIRST copy's distinct
// value, on every save, including one where the operator never opened
// that tab or touched that key. The value was never even visible to them:
// parseIni() hid the first copy at load time too.
//
// Fix: refuse the structured save outright while a duplicate key exists on
// disk, pointing at the raw tab (which round-trips the file byte-for-byte
// and is a genuine escape hatch -- confirmed same serverfiles.manage gate,
// no extra restriction, works identically for a remote/SFTP-mirrored
// server). The raw tab itself is untouched by this guard.

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
let configDir;
let iniPath;

function putIni(settings) {
  return runRoute("/ini", "put", { user: { role: "admin" }, body: { settings } });
}

function putRaw(content) {
  return runRoute("/raw/:type", "put", {
    user: { role: "admin" },
    params: { type: "ini" },
    body: { content },
  });
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ini-dup-guard-"));
  iniPath = path.join(configDir, `${SERVER_NAME}.ini`);
  getActiveServer.mockReset().mockResolvedValue({
    serverConfigPath: configDir,
    serverName: SERVER_NAME,
  });
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("PUT /server-files/ini -- refuses a structured save while a duplicate key exists on disk", () => {
  it("refuses even a save that never touches the duplicated key, and does not write anything", async () => {
    fs.writeFileSync(
      iniPath,
      ["PVP=true", "PublicName=First", "DefaultPort=16261", "PublicName=Second", ""].join("\n"),
    );

    const res = await putIni({ PVP: "false" });

    expect(res.getStatusCode()).toBe(409);
    expect(res.getBody().code).toBe("INI_DUPLICATE_KEY_BLOCKS_STRUCTURED_SAVE");
    expect(res.getBody().duplicateKeys).toEqual([{ key: "PublicName", count: 2 }]);
    // The file must be completely untouched -- both copies still present.
    const onDisk = fs.readFileSync(iniPath, "utf-8");
    expect(onDisk).toContain("PublicName=First");
    expect(onDisk).toContain("PublicName=Second");
    expect(onDisk).toContain("PVP=true"); // unchanged, not "false"
  });

  it("succeeds once the duplicate is gone", async () => {
    fs.writeFileSync(iniPath, ["PVP=true", "PublicName=Second", ""].join("\n"));

    const res = await putIni({ PVP: "false" });

    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("PVP=false");
  });

  it("still saves normally when the file has no duplicate keys at all", async () => {
    fs.writeFileSync(iniPath, "PVP=true\n");

    const res = await putIni({ PVP: "false" });

    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("PVP=false");
  });

  it("the raw tab remains a real escape hatch: PUT /raw/ini still writes byte-for-byte while a duplicate exists", async () => {
    fs.writeFileSync(
      iniPath,
      ["PVP=true", "PublicName=First", "PublicName=Second", ""].join("\n"),
    );

    const fixed = ["PVP=true", "PublicName=Second", ""].join("\n");
    const res = await putRaw(fixed);

    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(iniPath, "utf-8")).toBe(fixed);
  });
});
