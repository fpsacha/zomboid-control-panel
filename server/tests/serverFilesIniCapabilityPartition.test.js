import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Capability-description sweep finding 4: PUT /server-files/ini writes any
// key in the submitted settings object, RCONPassword/RCONPort/DefaultPort/
// UDPPort/UPnP included -- the same Server/<name>.ini fields server.js's own
// /configure-rcon and /configure-network write under server.configure.
// serverfiles.manage's description ("Edit sandbox options, spawn points and
// other server config files") gives no hint that holding it also lets a
// caller rewrite the RCON password or the game's listen port, bypassing
// server.configure's own dedicated gate on those exact fields.
//
// Fix: an inline server.configure check for the 5 governed keys, enforced on
// CHANGE (against the file's own current value) not presence -- the
// structured editor round-trips the whole settings object on every save.

const ROLES = {
  admin: { capabilities: ["serverfiles.manage", "server.configure"] },
  // Holds serverfiles.manage (passes the route's own gate) and NOTHING
  // else -- the exact caller this fix exists to stop.
  serverfiles_only: { capabilities: ["serverfiles.manage"] },
};
const getRoleByName = vi.fn(async (name) => ROLES[name] || null);
const getActiveServer = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings: vi.fn(async () => ({})),
  getRoleByName,
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

// 2026-09-08 quadruple-read sweep: PUT /ini now reads req.activeServerContext
// instead of re-deriving it, populated once by the router's own gate (a
// non-route layer getRouteHandlers() above never reaches). Run it first, on
// the same req.
function getGateMiddleware() {
  return router.stack.filter((entry) => !entry.route)[1].handle;
}

async function putIni(settings, role) {
  const res = createResponse();
  const req = { user: { role }, body: { settings } };
  await getGateMiddleware()(req, res, () => {});
  const handlers = getRouteHandlers("/ini", "put");
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

function writeIni(extra = "") {
  fs.writeFileSync(
    iniPath,
    [
      "PVP=true",
      "RCONPassword=old-rcon-pass",
      "RCONPort=27015",
      "DefaultPort=16261",
      "UDPPort=16262",
      "UPnP=true",
      extra,
      "",
    ].join("\n"),
  );
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ini-cap-partition-"));
  iniPath = path.join(configDir, `${SERVER_NAME}.ini`);
  writeIni();
  getActiveServer.mockReset().mockResolvedValue({
    serverConfigPath: configDir,
    serverName: SERVER_NAME,
  });
  getRoleByName.mockClear();
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("PUT /server-files/ini -- RCON/network keys require server.configure in addition to serverfiles.manage", () => {
  it("refuses to change RCONPassword for a caller who holds serverfiles.manage but not server.configure", async () => {
    const res = await putIni({ RCONPassword: "new-pass" }, "serverfiles_only");

    expect(res.getStatusCode()).toBe(403);
    expect(res.getBody().missing).toEqual([
      { key: "RCONPassword", requiredCapability: "server.configure" },
    ]);
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("RCONPassword=old-rcon-pass");
  });

  it("allows the same change for a caller who also holds server.configure", async () => {
    const res = await putIni({ RCONPassword: "new-pass" }, "admin");

    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("RCONPassword=new-pass");
  });

  it("re-submitting the whole settings object with UNCHANGED governed values is a no-op for the check, not a refusal (whole-object resend must not lock out saves)", async () => {
    const res = await putIni(
      {
        RCONPassword: "old-rcon-pass",
        RCONPort: "27015",
        DefaultPort: "16261",
        UDPPort: "16262",
        UPnP: "true",
        PVP: "false", // a real, allowed change alongside the unchanged governed keys
      },
      "serverfiles_only",
    );

    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("PVP=false");
  });

  it("a request touching multiple governed keys names every offending one and rejects atomically -- no partial write", async () => {
    const res = await putIni(
      { RCONPort: "27016", DefaultPort: "16265", PVP: "false" },
      "serverfiles_only",
    );

    expect(res.getStatusCode()).toBe(403);
    expect(res.getBody().missing).toEqual(
      expect.arrayContaining([
        { key: "RCONPort", requiredCapability: "server.configure" },
        { key: "DefaultPort", requiredCapability: "server.configure" },
      ]),
    );
    const onDisk = fs.readFileSync(iniPath, "utf-8");
    expect(onDisk).toContain("PVP=true"); // unchanged -- nothing partially applied
    expect(onDisk).toContain("RCONPort=27015");
  });

  it("an unowned, genuinely sandbox/spawn-shaped key needs nothing beyond serverfiles.manage itself", async () => {
    const res = await putIni({ PVP: "false" }, "serverfiles_only");

    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("PVP=false");
  });

  it("a masked-placeholder resend of RCONPassword never reaches the capability check at all (filtered upstream before the diff)", async () => {
    const res = await putIni({ RCONPassword: "••••••••1234" }, "serverfiles_only");

    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("RCONPassword=old-rcon-pass");
  });
});
