import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Regression suite for the 2026-08-23 validateInt-coerces audit: server.js's
// validateInt() silently substituted a default for an out-of-range value
// instead of refusing it, so a human-typed port (Install/Quick Setup) could
// be swapped for a different one with nothing telling the operator. These
// four routes are the human-typed-field call sites that now use
// requireIntInRange() and must return a 400 + named ErrorCode instead of a
// 200 carrying a substituted value. The horde-count and stats-period call
// sites deliberately keep coercing (machine/optional inputs) -- not covered
// here, no behaviour change to regress.

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

// steamcmd-routes-running-check, 2026-09-08: /install and /quick-setup now
// call checkSpecificServerStopped() (via resolveTargetServerForRunningCheck)
// BEFORE the numeric-field validation this file exists to test, via a
// throwaway ServerManager instance's real host scan. Same pattern as
// deleteFilesGuards.test.js -- default to "no PZ processes anywhere" so
// requests reach the numeric validation under test instead of a real OS scan.
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

const { default: router, requireIntInRange } = await import("../routes/server.js");

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
let steamcmdPath;
let installPath;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-numeric-"));
  steamcmdPath = path.join(root, "steamcmd");
  installPath = path.join(root, "server");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function baseInstallBody(overrides = {}) {
  return {
    steamcmdPath,
    installPath,
    serverName: "TestServer",
    ...overrides,
  };
}

describe("POST /api/server/install refuses an out-of-range numeric field", () => {
  it("refuses an out-of-range game port with a named error instead of substituting 16261", async () => {
    const handler = getHandler("/install");
    const response = createResponse();
    await handler(fakeReq(baseInstallBody({ serverPort: 80 })), response);

    expect(response.status).toHaveBeenCalledWith(400);
    const payload = response.json.mock.calls[0][0];
    expect(payload.code).toBe("INVALID_SERVER_PORT");
    expect(payload.error).toMatch(/Game port/);
  });

  it("refuses game port 65535 because the derived UDP port would be 65536", async () => {
    const handler = getHandler("/configure-network");
    const response = createResponse();
    await handler(fakeReq({ serverPort: 65535 }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].error).toMatch(/65534/);
  });

  it("refuses an out-of-range RCON port with a named error instead of substituting 27015", async () => {
    const handler = getHandler("/install");
    const response = createResponse();
    await handler(fakeReq(baseInstallBody({ rconPort: 99 })), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].code).toBe("INVALID_RCON_PORT");
  });

  it("refuses a non-numeric game port", async () => {
    const handler = getHandler("/install");
    const response = createResponse();
    await handler(fakeReq(baseInstallBody({ serverPort: "not-a-port" })), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].code).toBe("INVALID_SERVER_PORT");
  });

  it("refuses an over-cap minimum memory value", async () => {
    const handler = getHandler("/install");
    const response = createResponse();
    await handler(fakeReq(baseInstallBody({ minMemory: 256 })), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].code).toBe("INVALID_MIN_MEMORY");
  });

  it("refuses an over-cap maximum memory value", async () => {
    const handler = getHandler("/install");
    const response = createResponse();
    await handler(fakeReq(baseInstallBody({ maxMemory: 9999 })), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].code).toBe("INVALID_MAX_MEMORY");
  });

  it("passes valid numeric fields through to the next validation stage (not rejected as a numeric error)", async () => {
    const handler = getHandler("/install");
    const response = createResponse();
    fs.mkdirSync(steamcmdPath, { recursive: true });
    const steamcmdExecutable = path.join(
      steamcmdPath,
      process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh",
    );
    fs.writeFileSync(
      steamcmdExecutable,
      process.platform === "win32"
        ? "@echo off\r\nexit /b 1\r\n"
        : "#!/bin/sh\nexit 1\n",
    );
    if (process.platform !== "win32") fs.chmodSync(steamcmdExecutable, 0o755);

    await handler(
      fakeReq(
        baseInstallBody({
          serverPort: 16261,
          rconPort: 27015,
          minMemory: 4,
          maxMemory: 8,
        }),
        { emit: vi.fn() },
      ),
      response,
    );

    expect(response.json).toHaveBeenCalled();
    const payload = response.json.mock.calls[0][0];
    expect(payload.code).not.toBe("INVALID_SERVER_PORT");
    expect(payload.code).not.toBe("INVALID_RCON_PORT");
    expect(payload.code).not.toBe("INVALID_MIN_MEMORY");
    expect(payload.code).not.toBe("INVALID_MAX_MEMORY");
  });
});

describe("requireIntInRange parses whole numbers strictly", () => {
  it.each(["27015junk", "4.9", "1e2", ""])(
    "rejects %s instead of accepting a parseInt prefix",
    (value) => {
      expect(requireIntInRange(value, 1, 65535, "Port").ok).toBe(false);
    },
  );

  it("accepts a trimmed integer string", () => {
    expect(requireIntInRange(" 27015 ", 1, 65535, "Port")).toEqual({
      ok: true,
      value: 27015,
    });
  });
});

describe("POST /api/server/quick-setup refuses an out-of-range numeric field", () => {
  function baseQuickSetupBody(overrides = {}) {
    return {
      installPath,
      serverName: "TestServer",
      ...overrides,
    };
  }

  beforeEach(() => {
    // Quick Setup requires PZ server marker files to already exist at
    // installPath before it will even look at the numeric fields.
    fs.mkdirSync(path.join(installPath, "jre64"), { recursive: true });
  });

  it("refuses an out-of-range game port", async () => {
    const handler = getHandler("/quick-setup");
    const response = createResponse();
    await handler(fakeReq(baseQuickSetupBody({ serverPort: 80 })), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].code).toBe("INVALID_SERVER_PORT");
  });

  it("refuses an out-of-range RCON port", async () => {
    const handler = getHandler("/quick-setup");
    const response = createResponse();
    await handler(fakeReq(baseQuickSetupBody({ rconPort: 100 })), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].code).toBe("INVALID_RCON_PORT");
  });

  it("refuses an out-of-range minimum memory value", async () => {
    const handler = getHandler("/quick-setup");
    const response = createResponse();
    await handler(fakeReq(baseQuickSetupBody({ minMemory: 0 })), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].code).toBe("INVALID_MIN_MEMORY");
  });

  it("refuses an out-of-range maximum memory value", async () => {
    const handler = getHandler("/quick-setup");
    const response = createResponse();
    await handler(fakeReq(baseQuickSetupBody({ maxMemory: 500 })), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].code).toBe("INVALID_MAX_MEMORY");
  });
});

describe("POST /api/server/configure-rcon refuses an out-of-range RCON port", () => {
  it("refuses an out-of-range RCON port before ever looking at the password", async () => {
    const handler = getHandler("/configure-rcon");
    const response = createResponse();
    await handler(fakeReq({ rconPort: 70000, rconPassword: "secret" }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    const payload = response.json.mock.calls[0][0];
    expect(payload.code).toBe("INVALID_RCON_PORT");
    expect(payload.error).toMatch(/RCON port/);
  });

  it("passes a valid RCON port through to the next validation stage", async () => {
    const handler = getHandler("/configure-rcon");
    const response = createResponse();
    await handler(fakeReq({ rconPort: 27015, rconPassword: "secret" }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    // No server configured in this test's mocked settings -- proof it moved
    // past the numeric gate rather than being rejected as a numeric error.
    expect(response.json.mock.calls[0][0].code).toBe("SERVER_CONFIG_PATH_NOT_SET");
  });
});

describe("POST /api/server/configure-network refuses an out-of-range game port", () => {
  it("rejects a stringified UPnP flag instead of treating false as true", async () => {
    const handler = getHandler("/configure-network");
    const response = createResponse();

    await handler(fakeReq({ serverPort: 16261, useUpnp: "false" }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].error).toBe(
      "useUpnp must be a boolean",
    );
  });

  it("refuses an out-of-range game port", async () => {
    const handler = getHandler("/configure-network");
    const response = createResponse();
    await handler(fakeReq({ serverPort: 1 }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    const payload = response.json.mock.calls[0][0];
    expect(payload.code).toBe("INVALID_SERVER_PORT");
    expect(payload.error).toMatch(/Game port/);
  });

  it("passes a valid game port through to the next validation stage", async () => {
    const handler = getHandler("/configure-network");
    const response = createResponse();
    await handler(fakeReq({ serverPort: 16261 }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].code).toBe("SERVER_CONFIG_PATH_NOT_SET");
  });

  it("uses the default restart warning when the body is omitted", async () => {
    const handler = getHandler("/restart");
    const performRestart = vi.fn().mockResolvedValue({ success: true });
    const response = createResponse();

    await handler(
      { body: null, app: { get: () => ({ performRestart }) } },
      response,
    );

    expect(performRestart).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ label: "Manual restart", lifecycleLock: expect.any(Object) }),
    );
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });
});
