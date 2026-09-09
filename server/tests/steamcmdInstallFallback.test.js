import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// steamcmd-install-detect-fallback, 2026-09-09: POST /install 400ed with
// "Missing required fields" whenever steamcmdPath was absent, even though
// GET /steamcmd/detect (findSteamCmdPath()) already exists, already works,
// and -- inside our own all-in-one image -- resolves to a deterministic
// path (docker/all-in-one/entrypoint.sh installs SteamCMD to
// /home/steam/steamcmd). This suite proves: (1) an absent steamcmdPath now
// falls back to that same detection instead of 400ing, (2) an explicitly
// supplied steamcmdPath still wins over detection, (3) when detection also
// fails the error names the paths that were checked instead of just
// failing silently.
//
// Deliberately does NOT mock findSteamCmdPath() itself -- only getSetting()
// -- so these tests exercise the real detection function against a real
// filesystem, per the "a mock with a convenient shape can pin a bug" lesson
// from the same night's bridge-version-staleness card.

let configuredSteamcmdPath = null;

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(async () => {}),
  getSetting: vi.fn(async (key) =>
    key === "steamcmdPath" ? configuredSteamcmdPath : null,
  ),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { default: router } = await import("../routes/server.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(routePath, method = "post") {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function fakeReq(body, io = { emit: vi.fn() }) {
  return { app: { get: () => io }, body };
}

let root;
let installPath;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-steamcmd-fallback-"));
  installPath = path.join(root, "server");
  configuredSteamcmdPath = null;
  delete process.env.STEAMCMD_PATH;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeFakeSteamCmdExe(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const exe =
    process.platform === "win32"
      ? path.join(dir, "steamcmd.exe")
      : path.join(dir, "steamcmd.sh");
  fs.writeFileSync(exe, "");
  return dir;
}

describe("POST /api/server/install falls back to SteamCMD detection", () => {
  it("resolves steamcmdPath from findSteamCmdPath() when the body omits it, instead of 400ing", async () => {
    const detected = writeFakeSteamCmdExe(path.join(root, "steamcmd"));
    configuredSteamcmdPath = detected;

    const handler = getHandler("/install");
    const response = createResponse();
    // serverName is deliberately invalid so the request 400s AFTER the
    // missing-fields gate but before the running-check/writable-directory
    // machinery this suite isn't set up to exercise -- proving steamcmdPath
    // was resolved and passed isValidPath, not that the whole install
    // pipeline succeeded.
    await handler(
      fakeReq({ installPath, serverName: "bad/name!" }),
      response,
    );

    // This route still 400s -- serverName is deliberately invalid -- but on
    // the SERVER_NAME_FORMAT_INVALID check further down, which only runs
    // after steamcmdPath cleared the missing-fields gate. If detection had
    // NOT kicked in, this would fail on INSTALL_MISSING_FIELDS instead.
    const payload = response.json.mock.calls[0]?.[0];
    expect(payload?.code).not.toBe("INSTALL_MISSING_FIELDS");
    expect(payload?.code).toBe("SERVER_NAME_FORMAT_INVALID");
  });

  it("still lets an explicitly supplied steamcmdPath win over detection", async () => {
    // A valid, detectable path is configured -- if the fallback wrongly
    // ran anyway and overrode the body value, this relative path would
    // never reach isValidPath() and the STEAMCMD_PATH_INVALID branch.
    configuredSteamcmdPath = writeFakeSteamCmdExe(path.join(root, "steamcmd"));

    const handler = getHandler("/install");
    const response = createResponse();
    await handler(
      fakeReq({
        steamcmdPath: "relative/not-absolute",
        installPath,
        serverName: "TestServer",
      }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    const payload = response.json.mock.calls[0][0];
    expect(payload.code).toBe("STEAMCMD_PATH_INVALID");
  });

  it("names the candidate paths it checked when steamcmdPath is absent and detection also fails", async () => {
    // No configured setting, no STEAMCMD_PATH env var, and none of the
    // three fixed candidates exist on the machine running this test --
    // findSteamCmdPath() genuinely returns null here.
    const handler = getHandler("/install");
    const response = createResponse();
    await handler(
      fakeReq({ installPath, serverName: "TestServer" }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    const payload = response.json.mock.calls[0][0];
    expect(payload.code).toBe("INSTALL_MISSING_FIELDS");
    expect(payload.error).toContain("steamcmdPath");
    expect(payload.error).toContain("/home/steam/steamcmd");
    expect(payload.error).toContain("/home/steam/Steam/steamcmd");
    expect(payload.error).toContain("/opt/steamcmd");
  });
});
