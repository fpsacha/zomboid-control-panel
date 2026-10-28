import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer: (...args) => getActiveServer(...args),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

const { refreshLaunchTargetBeforeStart } = await import("../routes/server.js");

// 2026-08-27 root cause completion (loonE, Discord config-revert report):
// generateStartupScripts() bakes -cachedir/-servername as literal text into
// StartServer_<name>.bat/.sh at generation time, but that function was only
// ever called from the manual /start route and the install/setup-wizard
// flows -- NEVER from PUT /api/servers/:id (the Settings-UI edit route) and
// never from scheduler.js's performRestart(). So editing zomboidDataPath or
// serverName in Settings updated the database immediately but left the
// already-written launch script stale until the next MANUAL start
// regenerated it -- the next SCHEDULED restart in between launched PZ
// against the OLD baked cachedir, which found no ini there and generated a
// fresh default one. refreshLaunchTargetBeforeStart() is the fix: the
// single function both the manual /start route and performRestart() now
// call, so a scheduled restart refreshes RCON config and the launch script
// exactly the way a manual start always did.
describe("refreshLaunchTargetBeforeStart()", () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    getActiveServer.mockReset();
  });

  function baseServer(overrides = {}) {
    return {
      serverName: "TestServer",
      rconPassword: "secret123",
      rconPort: 27015,
      minMemory: 4,
      maxMemory: 8,
      serverPort: 16261,
      ...overrides,
    };
  }

  it("regenerates the launch script with the CURRENT zomboidDataPath, closing the stale-script gap", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-refresh-launch-"));
    const installPath = root;
    const oldDataPath = path.join(root, "ZomboidData_old");
    const newDataPath = path.join(root, "ZomboidData_new");

    const server = baseServer({ installPath, zomboidDataPath: oldDataPath });
    getActiveServer.mockResolvedValue(server);

    // Simulate an existing script baked with the OLD path (as if written by
    // an earlier manual start).
    await refreshLaunchTargetBeforeStart(server);
    const batPath = path.join(installPath, "StartServer_TestServer.bat");
    expect(fs.readFileSync(batPath, "utf8")).toContain(
      `-cachedir="${oldDataPath}"`,
    );

    // Operator edits zomboidDataPath in Settings (updates the DB record
    // only -- modeled here by passing the updated server object, exactly
    // what a fresh getServer()/getActiveServer() read after the edit would
    // return).
    const updatedServer = { ...server, zomboidDataPath: newDataPath };
    getActiveServer.mockResolvedValue(updatedServer);

    const result = await refreshLaunchTargetBeforeStart(updatedServer);

    const content = fs.readFileSync(batPath, "utf8");
    expect(content).toContain(`-cachedir="${newDataPath}"`);
    expect(content).not.toContain(`-cachedir="${oldDataPath}"`);
    expect(result.scriptBackupWarnings).toEqual([]);
  });

  it("also pre-configures RCON in the ini before the script regen completes", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-refresh-launch-"));
    const installPath = root;
    const zomboidDataPath = path.join(root, "Zomboid");
    const serverDir = path.join(zomboidDataPath, "Server");
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(
      path.join(serverDir, "TestServer.ini"),
      "PVP=true\nRCONPassword=old\nRCONPort=27015\n",
      "utf8",
    );

    const server = baseServer({ installPath, zomboidDataPath });
    getActiveServer.mockResolvedValue(server);

    await refreshLaunchTargetBeforeStart(server);

    const iniContent = fs.readFileSync(
      path.join(serverDir, "TestServer.ini"),
      "utf8",
    );
    expect(iniContent).toContain("RCONPassword=secret123");
  });

  it("skips script regen for a managed container, but still runs RCON pre-configure", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-refresh-launch-"));
    const installPath = root;
    const zomboidDataPath = path.join(root, "Zomboid");
    const serverDir = path.join(zomboidDataPath, "Server");
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(
      path.join(serverDir, "TestServer.ini"),
      "RCONPassword=old\nRCONPort=27015\n",
      "utf8",
    );

    const server = baseServer({ installPath, zomboidDataPath });
    getActiveServer.mockResolvedValue(server);

    const result = await refreshLaunchTargetBeforeStart(server, {
      managedHandled: true,
    });

    expect(fs.existsSync(path.join(installPath, "StartServer_TestServer.bat"))).toBe(
      false,
    );
    expect(result.scriptBackupWarnings).toEqual([]);
    expect(
      fs.readFileSync(path.join(serverDir, "TestServer.ini"), "utf8"),
    ).toContain("RCONPassword=secret123");
  });

  it("skips script regen when the server has a custom startCommand", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-refresh-launch-"));
    const installPath = root;
    const server = baseServer({
      installPath,
      startCommand: "custom-launcher.sh",
    });
    getActiveServer.mockResolvedValue(server);

    await refreshLaunchTargetBeforeStart(server);

    expect(fs.existsSync(path.join(installPath, "StartServer_TestServer.bat"))).toBe(
      false,
    );
  });

  it("skips script regen when installPath is missing, and does not throw", async () => {
    const server = baseServer({});
    getActiveServer.mockResolvedValue(server);

    await expect(refreshLaunchTargetBeforeStart(server)).resolves.toEqual({
      scriptBackupWarnings: [],
      launchAdminPassword: "",
    });
  });

  it("a script-regen failure is swallowed and reported as an empty warnings list, never thrown", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-refresh-launch-"));
    // installPath points at a file, not a directory -- regenerateStartupScriptsWithBackup's
    // internal writes will fail.
    const notADir = path.join(root, "not-a-directory");
    fs.writeFileSync(notADir, "x", "utf8");

    const server = baseServer({ installPath: notADir });
    getActiveServer.mockResolvedValue(server);

    await expect(refreshLaunchTargetBeforeStart(server)).resolves.not.toThrow();
  });
});
