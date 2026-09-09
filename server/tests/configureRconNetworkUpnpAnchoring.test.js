import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-08-31: /configure-rcon, applyUpnpToIni(), and /configure-network each
// hand-rolled the same unanchored content.includes("Key=")/content.replace(
// /Key=.*/g, ...) pair server.js's ensureRconConfigured() had (fixed
// separately, see ensureRconConfigured.test.js's own free-text-collision
// case) -- .includes() matches that substring anywhere in the file and the
// unanchored replace rewrites every line containing it, including inside an
// operator's own free-text field. These three call sites now go through the
// same anchored server/utils/iniKeyWrite.js helper; this file proves each
// of them at the route/function level (not just the shared helper's own
// unit tests) leaves a free-text collision line alone.

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  getActiveServer: vi.fn(async () => null),
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { default: router, applyUpnpToIni } = await import("../routes/server.js");
const { getActiveServer, setSetting } = await import("../database/init.js");

function getHandler(routePath) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function fakeReq(body, io = { emit: vi.fn() }) {
  return { app: { get: () => io }, body };
}

let root;
let serverConfigPath;
let iniPath;
const welcomeLine =
  'ServerWelcomeMessage="RCONPassword=notthepassword UPnP=false DefaultPort=9999 UDPPort=9999 are all decoys, ignore them."';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-configure-anchor-"));
  serverConfigPath = path.join(root, "Server");
  fs.mkdirSync(serverConfigPath, { recursive: true });
  iniPath = path.join(serverConfigPath, "servertest.ini");
  fs.writeFileSync(
    iniPath,
    `PVP=false\n${welcomeLine}\nRCONPassword=old\nRCONPort=27015\nUPnP=true\nDefaultPort=16261\nUDPPort=16262\n`,
    "utf-8",
  );
  getActiveServer.mockResolvedValue({ serverConfigPath, serverName: "servertest" });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  getActiveServer.mockReset();
});

describe("POST /configure-rcon leaves a free-text RCONPassword=/RCONPort= collision untouched", () => {
  it("updates the real RCON lines, not the welcome message", async () => {
    const handler = getHandler("/configure-rcon");
    const response = createResponse();

    await handler(
      fakeReq({ rconPassword: "brand-new-secret", rconPort: 27020 }),
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    const content = fs.readFileSync(iniPath, "utf-8");
    expect(content).toContain(welcomeLine);
    expect(content).toContain("RCONPassword=brand-new-secret");
    expect(content).toContain("RCONPort=27020");
    expect(content.match(/^RCONPassword=/gm)).toHaveLength(1);
    expect(content.match(/^RCONPort=/gm)).toHaveLength(1);
  });

  // docker-unraid-onboarding, 2026-09-09: this route hardcoded
  // setSetting("rconHost", "127.0.0.1") unconditionally even after
  // discovery.js's create-from-discovery got RCON_HOST-aware -- a manual
  // RCON reconfigure on the exact two-container Unraid topology the other
  // route was fixed for still wrote an address that could never connect.
  it("resolves rconHost from RCON_HOST for the two-container Unraid topology, not a hardcoded 127.0.0.1", async () => {
    vi.stubEnv("RCON_HOST", "projectzomboid");
    const handler = getHandler("/configure-rcon");
    const response = createResponse();

    await handler(
      fakeReq({ rconPassword: "brand-new-secret", rconPort: 27020 }),
      response,
    );

    expect(setSetting).toHaveBeenCalledWith("rconHost", "projectzomboid");
    vi.unstubAllEnvs();
  });
});

describe("POST /configure-network leaves a free-text DefaultPort=/UDPPort=/UPnP= collision untouched", () => {
  it("updates the real port + UPnP lines, not the welcome message", async () => {
    const handler = getHandler("/configure-network");
    const response = createResponse();

    await handler(fakeReq({ serverPort: 17000, useUpnp: false }), response);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    const content = fs.readFileSync(iniPath, "utf-8");
    expect(content).toContain(welcomeLine);
    expect(content).toContain("DefaultPort=17000");
    expect(content).toContain("UDPPort=17001");
    expect(content).toContain("UPnP=false");
    expect(content.match(/^DefaultPort=/gm)).toHaveLength(1);
    expect(content.match(/^UDPPort=/gm)).toHaveLength(1);
    expect(content.match(/^UPnP=/gm)).toHaveLength(1);
  });
});

describe("applyUpnpToIni() leaves a free-text UPnP= collision untouched", () => {
  it("updates the real UPnP line, not the welcome message", async () => {
    const result = await applyUpnpToIni(serverConfigPath, "servertest", false);
    expect(result).toEqual({ applied: true });

    const content = fs.readFileSync(iniPath, "utf-8");
    expect(content).toContain(welcomeLine);
    expect(content).toContain("UPnP=false");
    expect(content.match(/^UPnP=/gm)).toHaveLength(1);
  });
});
