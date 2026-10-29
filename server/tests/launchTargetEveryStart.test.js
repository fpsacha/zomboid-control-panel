import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";

// GH #167 (v1.3.8, Docker all-in-one, Ubuntu 24.04). A db.json and save data
// restored onto a fresh machine with a freshly downloaded game:
//   1. On the panel's first boot start-server_<name>.sh didn't exist yet, so
//      loadConfig() picked the stock start-server.sh -- and kept it:
//      loadConfig() returns early once loaded and nothing asked again.
//   2. The boot auto-start called serverManager.startServer() directly,
//      without the launch-target refresh the dashboard's Start ran, and
//      launched start-server.sh: no -servername/-cachedir, so PZ opened
//      "servertest" in ~/Zomboid, found no admin account and died on its
//      stdin prompt (java.util.NoSuchElementException).
//   3. Start then wrote the named script ("Regenerated startup scripts...")
//      but still launched start-server.sh.
//   4. Follow-up: after changing the RCON and admin passwords in Edit
//      Server, `docker restart` brought the game back with the OLD ones --
//      the auto-start reused the old ini value and the old script.
// These tests replay those sequences against the real ServerManager, the
// real before-launch step (lifecycleCoordinator.prepareForLaunch()) and the
// real refresh (routes/server.js), with only the spawn and the database
// faked. Both launch platforms run on any host: serverManager.js reads
// process.platform once, at import, so each platform gets its own import.

const db = vi.hoisted(() => ({ server: null, active: null }));
const spawnCalls = vi.hoisted(() => []);
// File names whose atomic write fails, for a launch folder where the file is
// there but the panel can't replace it -- the one case a missing folder
// can't stand in for.
const failingWrites = vi.hoisted(() => new Set());

vi.mock("../utils/fileWriteQueue.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFileAtomic: (filePath, ...rest) => {
      if (failingWrites.has(String(filePath).split(/[\\/]/).pop())) {
        const error = new Error(`EACCES: permission denied, open '${filePath}'`);
        error.code = "EACCES";
        throw error;
      }
      return actual.writeFileAtomic(filePath, ...rest);
    },
  };
});

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      const child = new EventEmitter();
      child.pid = 4242;
      child.unref = () => {};
      child.kill = () => {};
      return child;
    },
  };
});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => {
    const active = db.active ?? db.server;
    return active ? { ...active } : null;
  }),
  getServer: vi.fn(async (id) =>
    db.server && String(db.server.id) === String(id) ? { ...db.server } : null,
  ),
  getServers: vi.fn(async () => (db.server ? [{ ...db.server }] : [])),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

async function importForPlatform(platform) {
  vi.resetModules();
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    const serverManagerModule = await import("../services/serverManager.js");
    const coordinator = await import("../services/lifecycleCoordinator.js");
    const routes = await import("../routes/server.js");
    // The same registry's logger, so onLog() sees what these modules log.
    const { onLog } = await import("../utils/logger.js");
    return { ...serverManagerModule, ...coordinator, ...routes, onLog };
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

// Everything a real launch touches outside the spawn itself: the process
// scan (skipRunningCheck), the ETXTBSY wait, the launch log, the 4 s
// immediate-crash window and the PID file.
function quietManager(ServerManager) {
  const manager = new ServerManager();
  manager.isJvmExecutableBusy = () => false;
  manager._openLaunchLog = function openLaunchLog() {
    this._launchLogFd = "ignore";
    return null;
  };
  manager._waitForImmediateCrash = async () => null;
  manager._writePidFile = () => {};
  return manager;
}

const PLATFORMS = [
  {
    platform: "linux",
    // A .sh single-quotes its values; a .bat double-quotes them.
    quote: (value) => "'" + value + "'",
    named: "start-server_Restored.sh",
    stock: "start-server.sh",
    spawnedScript: (call) => (call.command === "bash" ? call.args[0] : null),
  },
  {
    platform: "win32",
    quote: (value) => '"' + value + '"',
    named: "StartServer_Restored.bat",
    stock: "StartServer64.bat",
    // cmd.exe /c "<full path to the .bat>" > log 2>&1 -- see
    // buildWindowsCmdLine().
    spawnedScript: (call) =>
      call.command === "cmd.exe" ? path.basename(call.args[1].match(/"([^"]+\.bat)"/)[1]) : null,
  },
];

let root;
let installPath;
let zomboidDataPath;

beforeEach(() => {
  spawnCalls.length = 0;
  failingWrites.clear();
  root =fs.mkdtempSync(path.join(os.tmpdir(), "gh167-"));
  installPath = path.join(root, "pz");
  zomboidDataPath = path.join(root, "Zomboid");
  fs.mkdirSync(installPath, { recursive: true });
  fs.mkdirSync(path.join(zomboidDataPath, "Server"), { recursive: true });
  // A fresh game download ships both stock launchers.
  fs.writeFileSync(path.join(installPath, "start-server.sh"), "#!/bin/bash\n");
  fs.writeFileSync(path.join(installPath, "StartServer64.bat"), "@echo off\r\n");
  // The restored ini, still carrying the password from the old machine.
  fs.writeFileSync(
    path.join(zomboidDataPath, "Server", "Restored.ini"),
    "PVP=true\nRCONPort=27015\nRCONPassword=old-rcon\n",
  );
  db.active = null;
  db.server = {
    id: "srv-1",
    name: "Restored server",
    serverName: "Restored",
    installPath,
    zomboidDataPath,
    adminPassword: "admin-pw",
    rconPassword: "old-rcon",
    rconPort: 27015,
    isActive: true,
    isRemote: false,
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function readIni() {
  return fs.readFileSync(path.join(zomboidDataPath, "Server", "Restored.ini"), "utf8");
}

describe.each(PLATFORMS)("GH #167 on $platform", ({ platform, quote, named, stock, spawnedScript }) => {
  let m;

  beforeEach(async () => {
    m = await importForPlatform(platform);
  });

  afterEach(() => {
    m.setLaunchTargetRefresher(null);
    m.setBeforeLaunchHook(null);
  });

  it("boot config load on a fresh install picks the named script even though only the stock one exists yet", async () => {
    const manager = quietManager(m.ServerManager);
    await manager.loadConfig();

    expect(fs.existsSync(path.join(installPath, named))).toBe(false);
    expect(manager.serverBat).toBe(named);
    expect(manager.serverBat).not.toBe(stock);
  });

  it("the boot auto-start's start writes the named script from current settings and launches it, not the stock one", async () => {
    m.setLaunchTargetRefresher(m.refreshLaunchTargetForLaunch);
    const manager = quietManager(m.ServerManager);
    // Loaded at boot, while the named script is still absent (step 1).
    await manager.loadConfig();

    const result = await manager.startServer({ skipRunningCheck: true, serverId: null });

    expect(result.success).toBe(true);
    const script = fs.readFileSync(path.join(installPath, named), "utf8");
    expect(script).toContain(`-servername ${quote("Restored")}`);
    expect(script).toContain(`-cachedir=${quote(zomboidDataPath)}`);
    // The admin password reaches the game through the launch's environment,
    // never the script file (security audit R1-30/R1-35).
    expect(script).not.toContain("admin-pw");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].options.env.PZ_PANEL_ADMIN_PASSWORD).toBe("admin-pw");
    expect(spawnedScript(spawnCalls[0])).toBe(named);
  });

  it("a script written after the config load is the one launched, even with no refresh wired (step 3: Start wrote it, then ran the stock one)", async () => {
    const manager = quietManager(m.ServerManager);
    await manager.loadConfig();
    fs.writeFileSync(path.join(installPath, named), "written after boot\n");

    await manager.startServer({ skipRunningCheck: true });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnedScript(spawnCalls[0])).toBe(named);
  });

  it("refuses to launch -- with a coded, translatable reason -- when the named script still isn't there, instead of running the stock one", async () => {
    // No refresh wired: nothing writes the named script before the spawn,
    // the same as a refresh that couldn't write into the install folder.
    const manager = quietManager(m.ServerManager);
    await manager.loadConfig();

    const error = await manager
      .startServer({ skipRunningCheck: true })
      .then(() => null, (caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("SERVER_START_SCRIPT_MISSING");
    expect(error.params).toEqual({ script: named, fallback: stock });
    expect(error.message).toContain(named);
    expect(error.message).toContain(installPath);
    expect(spawnCalls).toHaveLength(0);
  });

  it("an RCON and admin password edit reaches the next auto-start without a panel restart (the follow-up report)", async () => {
    m.setLaunchTargetRefresher(m.refreshLaunchTargetForLaunch);
    // The panel ran before with the old passwords: the named script exists
    // and was generated with them.
    db.server = { ...db.server, adminPassword: "old-admin" };
    const before = await m.refreshLaunchTargetBeforeStart(db.server);
    expect(before.launchAdminPassword).toBe("old-admin");
    expect(fs.readFileSync(path.join(installPath, named), "utf8")).not.toContain("old-admin");
    const manager = quietManager(m.ServerManager);
    await manager.loadConfig();
    // Servers > Edit Server changes both passwords. PUT /servers/:id does not
    // reload the shared ServerManager for a password-only edit, so the record
    // it holds keeps the old ones.
    db.server = { ...db.server, rconPassword: "new-rcon", adminPassword: "new-admin" };
    expect(manager._serverRecord.rconPassword).toBe("old-rcon");

    // What server/index.js's boot auto-start calls after `docker restart`.
    const result = await manager.startServer({ skipRunningCheck: true });

    expect(result.success).toBe(true);
    expect(readIni()).toContain("RCONPassword=new-rcon");
    expect(readIni()).not.toContain("RCONPassword=old-rcon");
    const script = fs.readFileSync(path.join(installPath, named), "utf8");
    expect(script).not.toContain("new-admin");
    expect(script).not.toContain("old-admin");
    expect(spawnedScript(spawnCalls[0])).toBe(named);
    // The edited password, from the record as it is now, not the manager's.
    expect(spawnCalls[0].options.env.PZ_PANEL_ADMIN_PASSWORD).toBe("new-admin");
  });

  it("names the no-Steam stock launcher when that's what the server would have fallen back to", async () => {
    db.server = { ...db.server, useNoSteam: true };
    const manager = quietManager(m.ServerManager);
    await manager.loadConfig();

    const error = await manager
      .startServer({ skipRunningCheck: true })
      .then(() => null, (caught) => caught);

    expect(error?.code).toBe("SERVER_START_SCRIPT_MISSING");
    expect(error.params.fallback).toBe(
      platform === "win32" ? "StartServer64_nosteam.bat" : "start-server.sh",
    );
  });

  it("a server whose serverPath is a folder of its own gets its script written, checked and launched there", async () => {
    // serverPath (API-only) wins over installPath for the launch folder in
    // loadConfig() and in a systemd/OpenRC unit. The refresh used to write
    // into installPath regardless, so this server was refused every start.
    const launchFolder = path.join(root, "launch");
    fs.mkdirSync(launchFolder);
    db.server = { ...db.server, serverPath: launchFolder };
    m.setLaunchTargetRefresher(m.refreshLaunchTargetForLaunch);
    const manager = quietManager(m.ServerManager);
    await manager.loadConfig();

    const result = await manager.startServer({ skipRunningCheck: true });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(launchFolder, named), "utf8")).toContain(`-servername ${quote("Restored")}`);
    expect(fs.existsSync(path.join(installPath, named))).toBe(false);
    expect(spawnedScript(spawnCalls[0])).toBe(named);
  });

  it("a script the refresh couldn't write is logged as a failure, never as regenerated, before the refusal", async () => {
    // A launch folder the panel can't write to: it doesn't exist.
    const unwritable = path.join(root, "not-there");
    db.server = { ...db.server, installPath: unwritable };
    m.setLaunchTargetRefresher(m.refreshLaunchTargetForLaunch);
    const manager = quietManager(m.ServerManager);
    await manager.loadConfig();
    const entries = [];
    const unsubscribe = m.onLog((entry) => entries.push(entry));

    let error;
    try {
      error = await manager
        .startServer({ skipRunningCheck: true })
        .then(() => null, (caught) => caught);
      // CallbackTransport delivers through setImmediate.
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    } finally {
      unsubscribe();
    }

    expect(error?.code).toBe("SERVER_START_SCRIPT_MISSING");
    const messages = entries.map((entry) => `${entry.level}: ${entry.message}`);
    expect(messages.some((line) => line.includes("Regenerated startup scripts"))).toBe(false);
    // The write's own reason, which the refusal's "the panel log has the
    // exact error" points to.
    expect(messages).toContainEqual(
      expect.stringContaining(`warn: Could not write ${path.join(unwritable, named)}: `),
    );
    expect(messages).toContainEqual(
      expect.stringContaining(`warn: Could not write ${named} (see the warning above) -- the start refuses to run without it`),
    );
    expect(spawnCalls).toHaveLength(0);
  });

  it("an older copy the refresh couldn't replace is launched, with a warning that it may carry older settings", async () => {
    // The start only stops when there is no copy at all. With one on disk
    // it goes ahead, and the log is the only place that says the new
    // admin password didn't reach the script -- what the docs and the
    // SERVER_START_SCRIPT_MISSING troubleshooting entry describe.
    fs.writeFileSync(path.join(installPath, named), "older copy\n");
    failingWrites.add(named);
    m.setLaunchTargetRefresher(m.refreshLaunchTargetForLaunch);
    const manager = quietManager(m.ServerManager);
    await manager.loadConfig();
    const entries = [];
    const unsubscribe = m.onLog((entry) => entries.push(entry));

    let result;
    try {
      result = await manager.startServer({ skipRunningCheck: true });
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    } finally {
      unsubscribe();
    }

    expect(result.success).toBe(true);
    expect(spawnedScript(spawnCalls[0])).toBe(named);
    expect(fs.readFileSync(path.join(installPath, named), "utf8")).toBe("older copy\n");
    const messages = entries.map((entry) => `${entry.level}: ${entry.message}`);
    expect(messages.some((line) => line.includes("Regenerated startup scripts"))).toBe(false);
    expect(messages).toContainEqual(
      expect.stringContaining(
        `warn: Could not regenerate ${named} (see the warning above) -- this start runs the copy already in ${installPath}, which may carry older settings`,
      ),
    );
  });

  it("a custom launcher is still launched as-is -- never swapped for the named script", async () => {
    const launcher = path.join(installPath, platform === "win32" ? "MyLauncher.bat" : "my-launcher.sh");
    fs.writeFileSync(launcher, "custom\n");
    db.server = { ...db.server, installPath: launcher };
    const manager = quietManager(m.ServerManager);
    await manager.loadConfig();

    expect(manager.serverBat).toBe(path.basename(launcher));
    await manager.startServer({ skipRunningCheck: true });
    expect(spawnedScript(spawnCalls[0])).toBe(path.basename(launcher));
  });

  it("a manager reloaded for another server never keeps the previous server's script", async () => {
    const manager = quietManager(m.ServerManager);
    await manager.loadConfig();
    expect(manager.serverBat).toBe(named);

    db.server = { ...db.server, id: "srv-2", serverName: "Other" };
    manager.configLoaded = false;
    await manager.loadConfig("srv-2");

    expect(manager.serverBat).toBe(m.managedStartupScriptName("Other", platform === "win32"));
  });
});

describe("prepareForLaunch()", () => {
  let m;
  let order;

  beforeEach(async () => {
    m = await importForPlatform(process.platform);
    order = [];
  });

  afterEach(() => {
    m.setLaunchTargetRefresher(null);
    m.setBeforeLaunchHook(null);
  });

  it("refreshes the launch target first, then runs the PanelBridge hook -- both write the ini, never together", async () => {
    m.setLaunchTargetRefresher(async (server, options) => {
      order.push(`refresh:${server.id}:${options.managedHandled}`);
      return { scriptBackupWarnings: ["backed up"] };
    });
    m.setBeforeLaunchHook(async (server) => order.push(`hook:${server.id}`));

    const result = await m.prepareForLaunch({ id: "a" });

    expect(order).toEqual(["refresh:a:false", "hook:a"]);
    expect(result).toEqual({ scriptWarnings: ["backed up"], launchSeq: expect.any(Number), launchAdminPassword: "" });
  });

  it("tells the refresher a container launch owns its own command (ini only, no script)", async () => {
    m.setLaunchTargetRefresher(async (_server, options) => {
      order.push(options.managedHandled);
    });
    await m.prepareForLaunch({ id: "a" }, { container: true });
    expect(order).toEqual([true]);
  });

  it("a throwing refresher never blocks the launch or the bridge hook", async () => {
    m.setLaunchTargetRefresher(async () => {
      throw new Error("disk full");
    });
    m.setBeforeLaunchHook(async () => order.push("hook"));
    const entries = [];
    const unsubscribe = m.onLog((entry) => entries.push(entry));

    try {
      await expect(m.prepareForLaunch({ id: "a" })).resolves.toEqual({
        scriptWarnings: [],
        launchSeq: expect.any(Number),
        launchAdminPassword: "",
      });
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    } finally {
      unsubscribe();
    }

    expect(order).toEqual(["hook"]);
    // Logged, so a SERVER_START_SCRIPT_MISSING refusal that follows ("the
    // panel log has the exact reason") has a reason to point at.
    expect(entries.map((entry) => `${entry.level}: ${entry.message}`)).toContainEqual(
      expect.stringContaining("warn: Could not refresh the launch target before this start: disk full"),
    );
  });

  it("is a no-op without a server", async () => {
    m.setLaunchTargetRefresher(async () => order.push("refresh"));
    await expect(m.prepareForLaunch(null)).resolves.toEqual({
      scriptWarnings: [],
      launchSeq: expect.any(Number),
      launchAdminPassword: "",
    });
    expect(order).toEqual([]);
  });

  it("startServer() hands the refresh's backup notices back on its result, for the dashboard's toast", async () => {
    m.setLaunchTargetRefresher(async () => ({ scriptBackupWarnings: ["saved your edit"] }));
    // The stub refresher writes nothing; a managed start checks for the
    // script before calling the service manager.
    fs.writeFileSync(path.join(installPath, m.managedStartupScriptName("Restored")), "");
    db.server = { ...db.server, lifecycleProvider: "systemd" };
    const manager = new m.ServerManager({
      lifecycleFactory: () => ({ run: async () => ({ success: true }) }),
    });
    manager._deletePidFile = () => {};

    const result = await manager.startServer();

    expect(result).toMatchObject({ success: true, scriptWarnings: ["saved your edit"] });
  });

  it("refreshes before a systemd/OpenRC start too -- the unit runs start-server_<name>.sh, the script the refresh writes", async () => {
    m.setLaunchTargetRefresher(async () => order.push("refresh"));
    fs.writeFileSync(path.join(installPath, m.managedStartupScriptName("Restored")), "");
    db.server = { ...db.server, lifecycleProvider: "systemd" };
    const manager = new m.ServerManager({
      lifecycleFactory: () => ({
        run: async (action) => (order.push(`managed:${action}`), { success: true }),
      }),
    });
    manager._deletePidFile = () => {};

    await manager.startServer();

    expect(order).toEqual(["refresh", "managed:start"]);
  });

  it("refreshes before a systemd/OpenRC restart, which relaunches the game without startServer()", async () => {
    m.setLaunchTargetRefresher(async () => order.push("refresh"));
    fs.writeFileSync(path.join(installPath, m.managedStartupScriptName("Restored")), "");
    db.server = { ...db.server, lifecycleProvider: "systemd" };
    const manager = new m.ServerManager({
      lifecycleFactory: () => ({
        run: async (action) => (order.push(`managed:${action}`), { success: true }),
      }),
    });
    manager.sleep = async () => {};
    manager._deletePidFile = () => {};
    const rcon = { serverMessage: async () => ({}), save: async () => ({ success: true }) };

    await manager.restartServer(rcon, 0);

    expect(order).toEqual(["refresh", "managed:restart"]);
  });
});

describe("a Docker-managed server's RCON password reaches the ini before the container starts", () => {
  let m;
  let managedContainer;
  let order;

  beforeEach(async () => {
    m = await importForPlatform(process.platform);
    managedContainer = await import("../services/managedContainer.js");
    order = [];
    db.server = { ...db.server, dockerContainerName: "pz", rconPassword: "new-rcon" };
  });

  afterEach(() => {
    m.setLaunchTargetRefresher(null);
  });

  function dockerClient() {
    return {
      enabled: true,
      available: true,
      inspectManagedContainer: vi.fn(async () => ({ State: { Running: false } })),
      runManagedAction: vi.fn(async (_ref, action) => {
        order.push(`docker:${action}:${readIni().match(/RCONPassword=(.*)/)[1]}`);
        return { success: true };
      }),
    };
  }

  it.each(["start", "restart"])("docker %s runs after the ini was rewritten, and no script is generated", async (action) => {
    m.setLaunchTargetRefresher(m.refreshLaunchTargetForLaunch);

    await managedContainer.runManagedLifecycle(action, {
      serverId: "srv-1",
      dockerClient: dockerClient(),
    });

    expect(order).toEqual([`docker:${action}:new-rcon`]);
    expect(fs.existsSync(path.join(installPath, "start-server_Restored.sh"))).toBe(false);
    expect(fs.existsSync(path.join(installPath, "StartServer_Restored.bat"))).toBe(false);
  });
});

describe("the refresh targets the server being launched", () => {
  let m;

  beforeEach(async () => {
    m = await importForPlatform(process.platform);
  });

  it("ensureRconConfigured(server) writes that server's ini, not the active server's", async () => {
    const otherData = path.join(root, "OtherZomboid");
    fs.mkdirSync(path.join(otherData, "Server"), { recursive: true });
    fs.writeFileSync(path.join(otherData, "Server", "Other.ini"), "RCONPassword=x\nRCONPort=27015\n");
    db.active = { ...db.server, id: "srv-active" };

    await m.ensureRconConfigured({
      id: "srv-2",
      serverName: "Other",
      zomboidDataPath: otherData,
      rconPassword: "pinned-rcon",
      rconPort: 27015,
    });

    expect(fs.readFileSync(path.join(otherData, "Server", "Other.ini"), "utf8")).toContain(
      "RCONPassword=pinned-rcon",
    );
    expect(readIni()).toContain("RCONPassword=old-rcon");
  });

  it("refreshLaunchTargetForLaunch() reads the record again instead of trusting the one it was handed", async () => {
    db.server = { ...db.server, rconPassword: "fresh-rcon", adminPassword: "fresh-admin" };

    const result = await m.refreshLaunchTargetForLaunch({ ...db.server, rconPassword: "stale", adminPassword: "stale" });

    expect(readIni()).toContain("RCONPassword=fresh-rcon");
    expect(result.launchAdminPassword).toBe("fresh-admin");
  });

  it("refreshLaunchTargetForLaunch() leaves a remote server alone", async () => {
    db.server = { ...db.server, isRemote: true, rconPassword: "remote-rcon" };

    await expect(m.refreshLaunchTargetForLaunch({ ...db.server })).resolves.toBeNull();

    expect(readIni()).toContain("RCONPassword=old-rcon");
    expect(fs.existsSync(path.join(installPath, "start-server_Restored.sh"))).toBe(false);
  });

  it("never writes StartServer_undefined.bat for a server with no name", async () => {
    const { serverName: _unused, ...unnamed } = db.server;

    await m.refreshLaunchTargetBeforeStart(unnamed);

    expect(fs.readdirSync(installPath).filter((f) => /undefined/.test(f))).toEqual([]);
  });
});

describe("POST /api/server/start forwards the refusal's code", () => {
  it("SERVER_START_SCRIPT_MISSING reaches the dashboard with its params (path-free)", async () => {
    const m = await importForPlatform(process.platform);
    const router = m.default;
    const layer = router.stack.find(
      (entry) => entry.route?.path === "/start" && entry.route.methods.post,
    );
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    const serverManager = {
      startServer: vi.fn(async () => {
        throw m.namedStartupScriptMissingError({
          script: "start-server_Restored.sh",
          folder: installPath,
          fallback: "start-server.sh",
        });
      }),
    };
    const app = { get: (key) => ({ serverManager, rconService: {} })[key] };

    await handler({ app }, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe("SERVER_START_SCRIPT_MISSING");
    expect(body.params).toEqual({ script: "start-server_Restored.sh", fallback: "start-server.sh" });
    expect(body.error).not.toContain(installPath);
  });

  it("SERVER_START_GAME_PORT_IN_USE reaches the dashboard with the other server's name and the port", async () => {
    const m = await importForPlatform(process.platform);
    const router = m.default;
    const layer = router.stack.find(
      (entry) => entry.route?.path === "/start" && entry.route.methods.post,
    );
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    const serverManager = {
      startServer: vi.fn(async () => {
        throw m.gamePortInUseError({ port: 16261, serverName: "Main" });
      }),
    };
    const app = { get: (key) => ({ serverManager, rconService: {} })[key] };

    await handler({ app }, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe("SERVER_START_GAME_PORT_IN_USE");
    expect(body.params).toEqual({ port: 16261, name: "Main" });
  });

  it("SERVER_START_STATE_UNKNOWN reaches the dashboard, and only a literal ignoreUnknownState: true is passed on", async () => {
    const m = await importForPlatform(process.platform);
    const layer = m.default.stack.find(
      (entry) => entry.route?.path === "/start" && entry.route.methods.post,
    );
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const serverManager = {
      startServer: vi.fn(async () => {
        throw m.serverStateUnknownError();
      }),
    };
    const app = { get: (key) => ({ serverManager, rconService: {} })[key] };
    const call = async (body) => {
      const res = { status: vi.fn(), json: vi.fn() };
      res.status.mockReturnValue(res);
      await handler({ app, body }, res);
      return res;
    };

    const res = await call(undefined);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].code).toBe("SERVER_START_STATE_UNKNOWN");
    await call({ ignoreUnknownState: "true" });
    await call({ ignoreUnknownState: true });

    expect(serverManager.startServer.mock.calls.map(([options]) => options.ignoreUnknownState)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("an uncoded start failure keeps the plain-message shape", async () => {
    const m = await importForPlatform(process.platform);
    const router = m.default;
    const layer = router.stack.find(
      (entry) => entry.route?.path === "/start" && entry.route.methods.post,
    );
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    const failure = new Error("Server path not configured");
    failure.code = "ENOENT";
    const serverManager = { startServer: vi.fn(async () => { throw failure; }) };
    const app = { get: (key) => ({ serverManager, rconService: {} })[key] };

    await handler({ app }, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0]).toEqual({ error: "Server path not configured" });
  });
});
