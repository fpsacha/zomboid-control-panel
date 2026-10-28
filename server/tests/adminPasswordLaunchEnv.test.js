import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";

// Security audit R1-30 / R1-35: the panel's start scripts no longer hold the
// admin password; ServerManager.startServer() hands it to the generated
// script through PZ_PANEL_ADMIN_PASSWORD, for the starts the game needs it
// for (services/adminPasswordLaunch.js; prepareForLaunch() decides from the
// record as it is now), and never to a script it didn't write. This suite
// intercepts child_process.spawn and checks the environment each launch gets.

const spawnCalls = [];
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      const child = new EventEmitter();
      child.pid = 4343;
      child.unref = vi.fn();
      child.kill = vi.fn();
      return child;
    },
  };
});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { ServerManager, managedStartupScriptName } = await import("../services/serverManager.js");
const { ADMIN_PASSWORD_ENV, adminPasswordForLaunch, recordAdminPasswordPassed } = await import(
  "../services/adminPasswordLaunch.js"
);
const { setLaunchTargetRefresher } = await import("../services/lifecycleCoordinator.js");

const PASSWORD = "Spawn-Admin-Pw";
const SERVER_NAME = "EnvTest";
let root;

function record(overrides = {}) {
  return {
    id: "env-1",
    serverName: SERVER_NAME,
    installPath: path.join(root, "install"),
    zomboidDataPath: path.join(root, "data"),
    adminPassword: PASSWORD,
    lifecycleProvider: "direct",
    ...overrides,
  };
}

function makeManager(serverRecord, serverBat = managedStartupScriptName(SERVER_NAME)) {
  fs.mkdirSync(serverRecord.installPath, { recursive: true });
  fs.writeFileSync(path.join(serverRecord.installPath, serverBat), "@echo off\r\n");
  const manager = new ServerManager();
  Object.assign(manager, {
    configLoaded: true,
    serverName: SERVER_NAME,
    serverPath: serverRecord.installPath,
    serverBat,
    startCommand: "",
    lifecycleProvider: "direct",
    launchMode: "managed",
    _serverRecord: serverRecord,
  });
  manager.isJvmExecutableBusy = () => false;
  return manager;
}

async function launchEnv(manager) {
  spawnCalls.length = 0;
  const started = manager.startServer({ skipRunningCheck: true });
  await vi.advanceTimersByTimeAsync(4000);
  await started;
  expect(spawnCalls).toHaveLength(1);
  return spawnCalls[0].options.env;
}

// What routes/server.js's refreshLaunchTargetBeforeStart() answers for a
// direct launch, without writing scripts.
const refresher = vi.fn(async (server) => ({ scriptBackupWarnings: [], launchAdminPassword: adminPasswordForLaunch(server) }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-admin-env-"));
  refresher.mockClear();
  setLaunchTargetRefresher(refresher);
});
afterEach(() => {
  setLaunchTargetRefresher(null);
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("ServerManager.startServer() hands the generated script its admin password only when due", () => {
  it("sets it for a world's first start", async () => {
    const env = await launchEnv(makeManager(record()));
    expect(env[ADMIN_PASSWORD_ENV]).toBe(PASSWORD);
  });

  it("leaves it out once the game has applied it", async () => {
    const srv = record();
    recordAdminPasswordPassed(srv, PASSWORD);
    const db = path.join(srv.zomboidDataPath, "db", `${SERVER_NAME}.db`);
    fs.mkdirSync(path.dirname(db), { recursive: true });
    fs.writeFileSync(db, "sqlite");
    const later = new Date(Date.now() + 10_000);
    fs.utimesSync(db, later, later);
    fs.mkdirSync(path.join(srv.zomboidDataPath, "Saves", "Multiplayer", SERVER_NAME), { recursive: true });

    const env = await launchEnv(makeManager(srv));
    expect(env).toBeDefined();
    expect(env[ADMIN_PASSWORD_ENV]).toBeUndefined();
    expect(env.PATH ?? env.Path).toBeDefined();
  });

  it("hands it what the refresh decided from the current record, not the one the manager loaded", async () => {
    refresher.mockImplementationOnce(async () => ({ scriptBackupWarnings: [], launchAdminPassword: "Edited-Since" }));
    const env = await launchEnv(makeManager(record()));
    expect(env[ADMIN_PASSWORD_ENV]).toBe("Edited-Since");
  });

  it("drops a value the panel process itself inherited", async () => {
    process.env[ADMIN_PASSWORD_ENV] = "inherited";
    try {
      refresher.mockImplementationOnce(async () => ({ scriptBackupWarnings: [], launchAdminPassword: "" }));
      const env = await launchEnv(makeManager(record()));
      expect(env[ADMIN_PASSWORD_ENV]).toBeUndefined();
    } finally {
      delete process.env[ADMIN_PASSWORD_ENV];
    }
  });

  it("never hands it to a launcher the panel didn't write", async () => {
    const manager = makeManager(record(), process.platform === "win32" ? "MyOwnLauncher.bat" : "my-own.sh");
    const env = await launchEnv(manager);
    expect(env[ADMIN_PASSWORD_ENV]).toBeUndefined();
  });
});
