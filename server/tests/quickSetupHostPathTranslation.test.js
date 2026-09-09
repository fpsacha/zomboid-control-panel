import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// docker-unraid-onboarding, 2026-09-09 (god's rule 2: "a translatable host
// path must SUCCEED with a note saying we translated it, not fail
// politely"): POST /quick-setup is the manual "I already have server files
// at this path" flow -- before this, it rejected ANY path whose
// StartServer64.bat/start-server.sh/jre64 didn't exist with a bare "Server
// files not found", including a path that is perfectly real on the HOST but
// unreachable under that exact string from inside this container. This
// suite proves the three real outcomes: translated-and-succeeded (the new
// behaviour), no-socket-so-unchanged (the common case today), and
// socket-available-but-genuinely-nothing-there (an honest, enriched refusal
// instead of a dead end).

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const scanHostForServerProcesses = vi.fn(async () => ({
  scanFailed: false,
  matched: [],
}));
vi.mock("../services/serverManager.js", async () => {
  const actual = await vi.importActual("../services/serverManager.js");
  return {
    ...actual,
    ServerManager: vi.fn().mockImplementation(function () {
      this.scanHostForServerProcesses = scanHostForServerProcesses;
    }),
  };
});

const inspectSelfContainerMounts = vi.fn(async () => ({
  available: false,
  reason: "no-docker-socket",
}));
vi.mock("../utils/containerMountInfo.js", async () => {
  const actual = await vi.importActual("../utils/containerMountInfo.js");
  return {
    ...actual,
    inspectSelfContainerMounts: (...args) => inspectSelfContainerMounts(...args),
  };
});

const { default: router } = await import("../routes/server.js");
const { setSetting } = await import("../database/init.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(routePath) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function fakeReq(body, io = { emit: vi.fn() }) {
  return { app: { get: () => io }, body };
}

let root;
let realInstallDir;
let handler;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "quick-setup-translate-"));
  realInstallDir = path.join(root, "container", "pz-server");
  fs.mkdirSync(path.join(realInstallDir, "jre64"), { recursive: true });
  handler = getHandler("/quick-setup");
  inspectSelfContainerMounts.mockReset();
  inspectSelfContainerMounts.mockResolvedValue({ available: false, reason: "no-docker-socket" });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function baseBody(overrides = {}) {
  return {
    installPath: realInstallDir,
    serverName: "TestServer",
    ...overrides,
  };
}

describe("POST /quick-setup: host-vs-container path translation", () => {
  it("succeeds with a note when the typed host path translates to a real container directory", async () => {
    const typedHostPath = "/mnt/user/appdata/pzserver";
    inspectSelfContainerMounts.mockResolvedValue({
      available: true,
      mounts: [{ hostPath: typedHostPath, containerPath: realInstallDir, type: "bind", readOnly: false }],
    });

    const response = createResponse();
    await handler(fakeReq(baseBody({ installPath: typedHostPath })), response);

    expect(response.status).not.toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        installPath: realInstallDir,
        pathTranslatedFrom: typedHostPath,
      }),
    );
  });

  it("leaves the response and message unchanged when no Docker socket is available (the common, no-translation case)", async () => {
    inspectSelfContainerMounts.mockResolvedValue({ available: false, reason: "no-docker-socket" });

    const response = createResponse();
    await handler(fakeReq(baseBody({ installPath: "/mnt/user/appdata/pzserver" })), response);

    expect(response.status).toHaveBeenCalledWith(400);
    const body = response.json.mock.calls[0][0];
    expect(body.code).toBe("QUICK_SETUP_SERVER_FILES_NOT_FOUND");
    expect(body.error).toBe(
      "Server files not found. Make sure the path contains Project Zomboid dedicated server files.",
    );
    // Self-inspect never ran a translation the caller could act on.
    expect(body.error).not.toMatch(/can only see/);
  });

  it("names the container's actual mounted folders instead of a dead end when the socket is available but nothing matches", async () => {
    inspectSelfContainerMounts.mockResolvedValue({
      available: true,
      mounts: [
        { hostPath: "/mnt/user/appdata/completely-unrelated", containerPath: "/pz-server", type: "bind", readOnly: false },
      ],
    });

    const response = createResponse();
    await handler(
      fakeReq(baseBody({ installPath: "/mnt/user/appdata/does-not-exist-anywhere" })),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    const body = response.json.mock.calls[0][0];
    expect(body.code).toBe("QUICK_SETUP_SERVER_FILES_NOT_FOUND");
    expect(body.error).toContain("/pz-server");
    expect(body.error).toMatch(/can only see/);
  });

  it("never attempts self-inspect at all when the typed path already has real server files -- no socket call for the already-correct case", async () => {
    const response = createResponse();
    await handler(fakeReq(baseBody()), response);

    expect(inspectSelfContainerMounts).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, pathTranslatedFrom: null }),
    );
  });

  // docker-unraid-onboarding, 2026-09-09: this route hardcoded
  // setSetting("rconHost", "127.0.0.1") unconditionally even after
  // discovery.js's create-from-discovery got RCON_HOST-aware -- a fresh
  // quick-setup on the exact two-container Unraid topology the other route
  // was fixed for still wrote an address that could never connect.
  it("resolves rconHost from RCON_HOST for the two-container Unraid topology, not a hardcoded 127.0.0.1", async () => {
    vi.stubEnv("RCON_HOST", "projectzomboid");

    const response = createResponse();
    await handler(
      fakeReq(baseBody({ rconPassword: "brand-new-secret" })),
      response,
    );

    expect(setSetting).toHaveBeenCalledWith("rconHost", "projectzomboid");
    vi.unstubAllEnvs();
  });
});
