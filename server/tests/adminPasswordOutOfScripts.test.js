import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Security audit R1-30 / R1-35 / CodeQL js/insufficient-password-hash 334:
// the panel wrote `-adminpassword <password>` into StartServer_<name>.bat and
// start-server_<name>.sh as text and passed it on every start. On Windows the
// .bat's 0600 mode is a no-op (the install folder's ACL lets every local
// account read it); on Linux the JVM carried it in argv (/proc/<pid>/cmdline)
// for its whole uptime; and .pz-panel-scripts.json kept a SHA-256 of both
// scripts at the umask default (0644). The scripts now read it from
// PZ_PANEL_ADMIN_PASSWORD, set by the panel only for the starts the game
// needs it for (a new world, a changed password).

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
}));
vi.mock("../routes/chunks.js", () => ({ invalidateMapFolderScan: vi.fn() }));
vi.mock("../services/serverManager.js", async () => {
  const actual = await vi.importActual("../services/serverManager.js");
  return {
    ...actual,
    ServerManager: vi.fn().mockImplementation(function () {
      this.scanHostForServerProcesses = vi.fn(async () => ({ scanFailed: false, matched: [] }));
    }),
  };
});

const { generateStartupScripts, refreshLaunchTargetBeforeStart } = await import("../routes/server.js");
const {
  ADMIN_PASSWORD_ENV,
  adminPasswordEnvValue,
  adminPasswordForLaunch,
  launchEnvWithAdminPassword,
  recordAdminPasswordPassed,
} = await import("../services/adminPasswordLaunch.js");

const PASSWORD = "Adm1n-S3cret-Value";
const isWindows = process.platform === "win32";
let root;

const { getDataPaths } = await import("../utils/paths.js");
const appliedFile = () => path.join(getDataPaths().dataDir, "admin-password-applied.json");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-admin-pw-"));
  fs.rmSync(appliedFile(), { force: true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function server(overrides = {}) {
  const installPath = path.join(root, "install");
  const zomboidDataPath = path.join(root, "data");
  fs.mkdirSync(installPath, { recursive: true });
  fs.mkdirSync(path.join(zomboidDataPath, "Server"), { recursive: true });
  return {
    id: "srv-1",
    serverName: "AdminPwTest",
    installPath,
    zomboidDataPath,
    adminPassword: PASSWORD,
    rconPassword: "rcon-pw",
    ...overrides,
  };
}

// The world after its first start: the account database and the world folder.
function bootWorld(srv, { dbWrittenAt = Date.now() } = {}) {
  const db = path.join(srv.zomboidDataPath, "db", `${srv.serverName}.db`);
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.writeFileSync(db, "sqlite");
  const when = new Date(dbWrittenAt);
  fs.utimesSync(db, when, when);
  fs.mkdirSync(path.join(srv.zomboidDataPath, "Saves", "Multiplayer", srv.serverName), { recursive: true });
  return db;
}

describe("the start scripts never carry the admin password", () => {
  it("a regenerated .bat, .sh and fingerprint sidecar hold no trace of it", async () => {
    const srv = server();
    await refreshLaunchTargetBeforeStart(srv, { platform: isWindows ? "win32" : "linux" });

    const files = fs.readdirSync(srv.installPath);
    expect(files).toEqual(
      expect.arrayContaining([`StartServer_${srv.serverName}.bat`, `start-server_${srv.serverName}.sh`]),
    );
    for (const name of files) {
      const text = fs.readFileSync(path.join(srv.installPath, name), "utf8");
      expect(text).not.toContain(PASSWORD);
    }
    const bat = fs.readFileSync(path.join(srv.installPath, `StartServer_${srv.serverName}.bat`), "utf8");
    expect(bat).toContain(`IF DEFINED ${ADMIN_PASSWORD_ENV} SET PZ_ADMIN_ARGS=-adminpassword "%${ADMIN_PASSWORD_ENV}%"`);
    expect(bat).toMatch(/GameServer .*%PZ_ADMIN_ARGS%/);
  });

  it("the scripts are the same whatever the password, so changing it rewrites nothing", () => {
    const base = { installPath: root, serverName: "Same", zomboidDataPath: "D:\\Data" };
    // An old caller still passing adminPassword gets no password either.
    const a = generateStartupScripts({ ...base, adminPassword: "first" });
    const b = generateStartupScripts({ ...base, adminPassword: "second" });
    expect(a).toEqual(b);
    expect(a.bat).not.toContain("first");
    expect(a.sh).not.toContain("first");
  });

  it.skipIf(isWindows)("the fingerprint sidecar is owner-only", async () => {
    const srv = server();
    const previous = process.umask(0o022);
    try {
      await refreshLaunchTargetBeforeStart(srv, { platform: "linux" });
    } finally {
      process.umask(previous);
    }
    const mode = fs.statSync(path.join(srv.installPath, ".pz-panel-scripts.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("a systemd/OpenRC unit's .sh carries it for the first start only, and the next start removes it", async () => {
    const srv = server({ lifecycleProvider: "systemd" });
    const shPath = path.join(srv.installPath, `start-server_${srv.serverName}.sh`);

    await refreshLaunchTargetBeforeStart(srv, { platform: "linux" });
    expect(fs.readFileSync(shPath, "utf8")).toContain(`PZ_ADMIN_PASSWORD='${PASSWORD}'`);

    // That start created the account and the world.
    bootWorld(srv, { dbWrittenAt: Date.now() + 5000 });
    await refreshLaunchTargetBeforeStart(srv, { platform: "linux" });
    const text = fs.readFileSync(shPath, "utf8");
    expect(text).not.toContain(PASSWORD);
    expect(text).toContain(`PZ_ADMIN_PASSWORD="\${${ADMIN_PASSWORD_ENV}:-}"`);
  });
});

describe("when a launch hands the game its password", () => {
  it("on a world's first start (no account database yet)", () => {
    expect(adminPasswordForLaunch(server())).toBe(PASSWORD);
  });

  it("when the account database exists but the world never got that far", () => {
    const srv = server();
    bootWorld(srv);
    fs.rmSync(path.join(srv.zomboidDataPath, "Saves"), { recursive: true });
    recordAdminPasswordPassed(srv, PASSWORD);
    expect(adminPasswordForLaunch(srv)).toBe(PASSWORD);
  });

  it("once, after an upgrade, for a world that booted with the old scripts", () => {
    const srv = server();
    bootWorld(srv);
    expect(adminPasswordForLaunch(srv)).toBe(PASSWORD);
  });

  it("not again once the game has written its account database since", () => {
    const srv = server();
    recordAdminPasswordPassed(srv, PASSWORD);
    bootWorld(srv, { dbWrittenAt: Date.now() + 5000 });
    expect(adminPasswordForLaunch(srv)).toBe("");
    // and stays settled
    expect(adminPasswordForLaunch(srv)).toBe("");
  });

  it("again when the start that passed it never reached the account database", () => {
    const srv = server();
    bootWorld(srv, { dbWrittenAt: Date.now() - 60_000 });
    recordAdminPasswordPassed(srv, PASSWORD);
    expect(adminPasswordForLaunch(srv)).toBe(PASSWORD);
  });

  it("again after the password changes", () => {
    const srv = server();
    recordAdminPasswordPassed(srv, PASSWORD);
    bootWorld(srv, { dbWrittenAt: Date.now() + 5000 });
    expect(adminPasswordForLaunch(srv)).toBe("");
    expect(adminPasswordForLaunch({ ...srv, adminPassword: "Changed-1" })).toBe("Changed-1");
  });

  it("never with no password set, or for a remote server", () => {
    expect(adminPasswordForLaunch(server({ adminPassword: "" }))).toBe("");
    expect(adminPasswordForLaunch(server({ isRemote: true }))).toBe("");
  });

  it("the record holds a salted fingerprint, never the password, and is owner-only", async () => {
    const srv = server();
    recordAdminPasswordPassed(srv, PASSWORD);
    const file = appliedFile();
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toContain(PASSWORD);
    expect(JSON.parse(text)["srv-1"].fingerprint).toMatch(/^scrypt:[0-9a-f]{32}:[0-9a-f]{64}$/);
    if (!isWindows) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("launchEnvWithAdminPassword() drops a value the panel inherited when none is due", () => {
    expect(launchEnvWithAdminPassword("", { PATH: "x", [ADMIN_PASSWORD_ENV]: "inherited" })).toEqual({ PATH: "x" });
    expect(launchEnvWithAdminPassword("due", { PATH: "x" }, "linux")).toEqual({ PATH: "x", [ADMIN_PASSWORD_ENV]: "due" });
  });

  it("the start's refresh hands a direct launch the password through its result, and a unit none", async () => {
    const direct = await refreshLaunchTargetBeforeStart(server(), { platform: "linux" });
    expect(direct.launchAdminPassword).toBe(PASSWORD);
    fs.rmSync(appliedFile(), { force: true });
    const unit = await refreshLaunchTargetBeforeStart(server({ lifecycleProvider: "openrc" }), { platform: "linux" });
    expect(unit.launchAdminPassword).toBe("");
  });
});

// The stanza the generated scripts use, run by the real interpreter.
function batchStanza() {
  const bat = generateStartupScripts({ installPath: root, serverName: "Probe" }).bat;
  return bat.split(/\r?\n/).filter((line) => /PZ_ADMIN_ARGS|PZ_PANEL_ADMIN_PASSWORD=/.test(line) && !/^REM/.test(line));
}

function batchArgv(envValue, baseEnv = process.env) {
  const script = path.join(root, "probe.bat");
  fs.writeFileSync(
    script,
    [
      "@echo off",
      "@setlocal enableextensions disabledelayedexpansion",
      ...batchStanza(),
      `"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" -- -servername "Probe" %PZ_ADMIN_ARGS% -nosteam`,
      "",
    ].join("\r\n"),
  );
  const env = { ...baseEnv };
  if (envValue !== null) delete env[ADMIN_PASSWORD_ENV];
  if (envValue !== undefined && envValue !== null) env[ADMIN_PASSWORD_ENV] = envValue;
  const run = spawnSync("cmd.exe", ["/d", "/c", script], { encoding: "utf8", env });
  return JSON.parse(run.stdout.trim().split(/\r?\n/).pop());
}

describe.skipIf(!isWindows)("the .bat stanza, read by cmd.exe and the C runtime's argument parser", () => {
  it.each([
    ["P@ss%w0rd!&x$y^(z)"],
    ["with spaces and | pipes > here"],
    ["trailing\\backslashes\\\\"],
    ["%PZ_CLASSPATH% and %PATH%"],
    ["!PZ_ADMIN_ARGS!"],
  ])("delivers %j intact as one argument", (password) => {
    const argv = batchArgv(adminPasswordEnvValue(password, "win32"));
    expect(argv).toEqual(["-servername", "Probe", "-adminpassword", password, "-nosteam"]);
  });

  it("passes no -adminpassword at all when the panel sets none", () => {
    expect(batchArgv(undefined)).toEqual(["-servername", "Probe", "-nosteam"]);
  });

  it("adversary: a saved password that would close the quote and chain a command is never handed to the script", () => {
    // A double quote is refused where the password is saved; one stored
    // before that rule must not reach the .bat, where it would end the quote.
    const marker = path.join(root, "pwned.txt");
    const hostile = `x" & echo pwned> "${marker}" & rem "`;
    const srv = server({ adminPassword: hostile });
    expect(adminPasswordForLaunch(srv)).toBe("");
    // and the env helper refuses it on its own too
    const env = launchEnvWithAdminPassword(hostile, process.env, "win32");
    expect(env[ADMIN_PASSWORD_ENV]).toBeUndefined();
    const argv = batchArgv(null, env);
    expect(argv).toEqual(["-servername", "Probe", "-nosteam"]);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

function bashAvailable() {
  try {
    return spawnSync("bash", ["-c", "exit 0"]).status === 0;
  } catch {
    return false;
  }
}

describe.skipIf(!bashAvailable())("the .sh stanza, run by bash", () => {
  function shellArgv(envValue) {
    const sh = generateStartupScripts({ installPath: root, serverName: "Probe" }).sh;
    const lines = sh.split(/\r?\n/).filter((line) => /^PZ_ADMIN_PASSWORD=|^unset /.test(line));
    const script = [
      ...lines,
      `printf '%s\\n' -servername Probe \${PZ_ADMIN_PASSWORD:+-adminpassword "$PZ_ADMIN_PASSWORD"} -nosteam`,
      `printf 'ENV:%s\\n' "\${${ADMIN_PASSWORD_ENV}-unset}"`,
    ].join("\n");
    const env = { ...process.env };
    delete env[ADMIN_PASSWORD_ENV];
    if (envValue !== undefined) env[ADMIN_PASSWORD_ENV] = envValue;
    const run = spawnSync("bash", ["-c", script], { encoding: "utf8", env });
    return run.stdout.split("\n").filter(Boolean);
  }

  it("delivers a hard password as one argument and keeps it out of the game's environment", () => {
    const password = "P@ss w0rd*?'$HOME`id`";
    expect(shellArgv(password)).toEqual(["-servername", "Probe", "-adminpassword", password, "-nosteam", "ENV:unset"]);
  });

  it("passes no -adminpassword when the panel sets none", () => {
    expect(shellArgv(undefined)).toEqual(["-servername", "Probe", "-nosteam", "ENV:unset"]);
    expect(shellArgv("")).toEqual(["-servername", "Probe", "-nosteam", "ENV:unset"]);
  });
});
