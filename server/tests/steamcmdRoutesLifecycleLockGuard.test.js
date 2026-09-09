import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// steamcmd-ops-never-check-the-lifecycle-lock, 2026-09-09: /install,
// /quick-setup and /steam-update never checked lifecycleCoordinator's
// global lock at all, so any of them could start while wipe/restore/
// template-apply already held it FOR THE SAME SERVER. God's ruling
// (2026-09-08) rejected SteamCMD taking the global lock itself (would
// freeze every unrelated server's start/stop/restart for the whole
// download) in favor of a same-server comparison via serverId, gated on
// normalize-lifecycle-lock-server-identifier (08396dcd) making that field
// trustworthy. lifecycleCoordinatorSameServerGuard.test.js locks in the
// primitive (isLifecycleLockedForServer) in isolation; these tests prove
// the three real route handlers actually call it.
//
// Proven through the REAL route handlers (router.stack lookup, same
// technique steamUpdateConcurrency.test.js already established in this
// file), not a reimplementation.

const getSettingMock = vi.fn(async () => null);
const setSettingMock = vi.fn(async () => {});
const getServersMock = vi.fn(async () => []);

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(async () => {}),
  setSetting: (...args) => setSettingMock(...args),
  getSetting: (...args) => getSettingMock(...args),
  getActiveServer: vi.fn(async () => null),
  getServers: (...args) => getServersMock(...args),
}));

// checkSpecificServerStopped()'s non-managed branch does a real host-wide
// process scan via ServerManager.scanHostForServerProcesses() -- mocked to
// "nothing running anywhere" so these lock-focused tests never depend on
// (or are blocked by) a real OS process list.
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

const { default: router } = await import("../routes/server.js");
const { acquireLifecycleLock, LIFECYCLE_IN_PROGRESS_CODE } = await import(
  "../services/lifecycleCoordinator.js"
);

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

let root;
let steamcmdPath;
let installPath;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-steamcmd-lock-guard-"));
  steamcmdPath = path.join(root, "steamcmd");
  installPath = path.join(root, "install");
  fs.mkdirSync(steamcmdPath, { recursive: true });
  fs.mkdirSync(installPath, { recursive: true });

  getSettingMock.mockReset().mockResolvedValue(null);
  setSettingMock.mockReset().mockResolvedValue(undefined);
  getServersMock.mockReset().mockResolvedValue([
    { id: "server-same", installPath },
  ]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const app = { get: () => undefined };

describe("POST /api/server/install same-server lifecycle-lock guard", () => {
  it("refuses with 409 SERVER_LIFECYCLE_IN_PROGRESS when the held lock names the SAME resolved server (installPath matches a configured server's id)", async () => {
    const lock = acquireLifecycleLock("wipe", "server-same");
    try {
      const handler = getHandler("/install");
      const response = createResponse();
      await handler(
        {
          app,
          body: { steamcmdPath, installPath, serverName: "TestServer" },
        },
        response,
      );
      expect(response.status).toHaveBeenCalledWith(409);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: LIFECYCLE_IN_PROGRESS_CODE }),
      );
    } finally {
      lock.release();
    }
  });

  it("does NOT refuse via the lock guard when the held lock names a DIFFERENT server -- proceeds to a later, unrelated validation error instead", async () => {
    const lock = acquireLifecycleLock("wipe", "server-different");
    try {
      const handler = getHandler("/install");
      const response = createResponse();
      await handler(
        {
          app,
          // minMemory: 0 is invalid and is checked well after the lock
          // guard -- reaching it proves the guard did not short-circuit.
          body: {
            steamcmdPath,
            installPath,
            serverName: "TestServer",
            minMemory: 0,
          },
        },
        response,
      );
      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "INVALID_MIN_MEMORY" }),
      );
      expect(response.json).not.toHaveBeenCalledWith(
        expect.objectContaining({ code: LIFECYCLE_IN_PROGRESS_CODE }),
      );
    } finally {
      lock.release();
    }
  });
});

describe("POST /api/server/quick-setup same-server lifecycle-lock guard", () => {
  beforeEach(() => {
    // Quick-setup's own precondition requires server files to already
    // exist at installPath before it will proceed far enough to reach the
    // guard.
    fs.writeFileSync(path.join(installPath, "StartServer64.bat"), "");
  });

  it("refuses with 409 SERVER_LIFECYCLE_IN_PROGRESS when the held lock names the SAME resolved server", async () => {
    const lock = acquireLifecycleLock("restore", "server-same");
    try {
      const handler = getHandler("/quick-setup");
      const response = createResponse();
      await handler(
        { app, body: { installPath, serverName: "TestServer" } },
        response,
      );
      expect(response.status).toHaveBeenCalledWith(409);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: LIFECYCLE_IN_PROGRESS_CODE }),
      );
    } finally {
      lock.release();
    }
  });

  it("does NOT refuse via the lock guard when the held lock names a DIFFERENT server", async () => {
    const lock = acquireLifecycleLock("restore", "server-different");
    try {
      const handler = getHandler("/quick-setup");
      const response = createResponse();
      await handler(
        {
          app,
          body: { installPath, serverName: "TestServer", minMemory: 0 },
        },
        response,
      );
      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "INVALID_MIN_MEMORY" }),
      );
      expect(response.json).not.toHaveBeenCalledWith(
        expect.objectContaining({ code: LIFECYCLE_IN_PROGRESS_CODE }),
      );
    } finally {
      lock.release();
    }
  });
});

// isWindows-gated the same way steamUpdateConcurrency.test.js's own test
// is: on a missing/unresolvable steamcmd path this route answers
// deterministically with STEAMCMD_NOT_FOUND_AT_PATH on Windows without
// spawning anything; on Linux it instead attempts a real auto-download
// (ensureSteamCmdLinux), which is a different, heavier code path this file
// doesn't otherwise exercise.
const isWindows = process.platform === "win32";

describe("POST /api/server/steam-update same-server lifecycle-lock guard", () => {
  it.skipIf(!isWindows)(
    "refuses with 409 SERVER_LIFECYCLE_IN_PROGRESS when the held lock names the SAME resolved server",
    async () => {
      const lock = acquireLifecycleLock("template-apply", "server-same");
      try {
        const handler = getHandler("/steam-update");
        const response = createResponse();
        await handler({ app, body: { steamcmdPath, installPath } }, response);
        expect(response.status).toHaveBeenCalledWith(409);
        expect(response.json).toHaveBeenCalledWith(
          expect.objectContaining({ code: LIFECYCLE_IN_PROGRESS_CODE }),
        );
      } finally {
        lock.release();
      }
    },
  );

  it.skipIf(!isWindows)(
    "does NOT refuse via the lock guard when the held lock names a DIFFERENT server -- proceeds to the (deterministic on Windows) steamcmd-not-found error instead",
    async () => {
      const lock = acquireLifecycleLock("template-apply", "server-different");
      try {
        const handler = getHandler("/steam-update");
        const response = createResponse();
        await handler({ app, body: { steamcmdPath, installPath } }, response);
        expect(response.status).toHaveBeenCalledWith(400);
        expect(response.json).toHaveBeenCalledWith(
          expect.objectContaining({ code: "STEAMCMD_NOT_FOUND_AT_PATH" }),
        );
        expect(response.json).not.toHaveBeenCalledWith(
          expect.objectContaining({ code: LIFECYCLE_IN_PROGRESS_CODE }),
        );
      } finally {
        lock.release();
      }
    },
  );
});

describe("SteamCMD routes: the documented pre-existing gap holds -- an unconfigured install path (no matching server, no id) never refuses via this guard", () => {
  it("POST /install proceeds past the guard when installPath matches no configured server, even while a lock IS held (for a different, real server)", async () => {
    getServersMock.mockResolvedValue([]); // no configured server matches installPath
    const lock = acquireLifecycleLock("wipe", "server-same");
    try {
      const handler = getHandler("/install");
      const response = createResponse();
      await handler(
        {
          app,
          body: {
            steamcmdPath,
            installPath,
            serverName: "TestServer",
            minMemory: 0,
          },
        },
        response,
      );
      expect(response.json).not.toHaveBeenCalledWith(
        expect.objectContaining({ code: LIFECYCLE_IN_PROGRESS_CODE }),
      );
    } finally {
      lock.release();
    }
  });
});
