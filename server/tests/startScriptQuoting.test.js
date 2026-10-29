import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// The start scripts the panel writes used to "sanitize" the data folder, the
// admin password and the server name by deleting every shell metacharacter,
// "..", and control characters. Nothing said so, and the game then ran with
// something else than what the panel stored:
//   - D:\Games (x86)\PZ Data became D:\Games x86\PZ Data, so the process's
//     -cachedir no longer matched the profile's folder and process ownership
//     scored it -1 for the panel's own server;
//   - P@ss%w0rd!&x$y became P@ssw0rdxy in the script;
//   - a trailing backslash ("D:\Zomboid Data\") swallowed the closing quote of
//     -cachedir="..." in the Java launcher's argument parsing;
//   - /install and /quick-setup validated the trimmed server name but used
//     the untrimmed one ("MyServer .ini").
// Values are now quoted for the script they go into; what cannot be quoted (a
// double quote, a control character) is refused where it is saved.

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  createServer: vi.fn(async (config) => ({ id: "created-1", ...config })),
  setActiveServer: vi.fn(async () => null),
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

vi.mock("../services/serverManager.js", async () => {
  const actual = await vi.importActual("../services/serverManager.js");
  return {
    ...actual,
    ServerManager: vi.fn().mockImplementation(function () {
      this.scanHostForServerProcesses = vi.fn(async () => ({ scanFailed: false, matched: [] }));
    }),
  };
});

vi.mock("../utils/containerMountInfo.js", async () => {
  const actual = await vi.importActual("../utils/containerMountInfo.js");
  return {
    ...actual,
    inspectSelfContainerMounts: vi.fn(async () => ({ available: false, reason: "no-docker-socket" })),
  };
});

const { setSetting } = await import("../database/init.js");
const { default: router, generateStartupScripts, resolveZomboidPaths } = await import("../routes/server.js");
const { ErrorCode } = await import("../utils/errorCodes.js");
const { scoreServerProcessOwnership } = await import("../services/serverManager.js");
const { checkZomboidDataPath } = await import("../services/zomboidDataPath.js");
const { adminPasswordStartScriptRefusal } = await import("../services/startScriptValues.js");
const {
  quoteForBatch,
  quoteForShell,
  startScriptValueProblem,
  textForScriptComment,
} = await import("../utils/startScriptQuoting.js");

const isWindows = process.platform === "win32";
const FORBIDDEN = ["\"", "\n", "\r", "\u0000", "\u0007", "\u007f"];

describe("quoteForBatch()", () => {
  it("keeps a path with parentheses and spaces exactly as stored", () => {
    expect(quoteForBatch("D:\\Games (x86)\\PZ Data")).toBe('"D:\\Games (x86)\\PZ Data"');
  });

  it("doubles % (cmd.exe expands %VAR% even inside quotes) and nothing else", () => {
    expect(quoteForBatch("P@ss%w0rd!&x$y")).toBe('"P@ss%%w0rd!&x$y"');
    expect(quoteForBatch("a^b|c<d>e(f)g")).toBe('"a^b|c<d>e(f)g"');
    expect(quoteForBatch("50%")).toBe('"50%%"');
  });

  it("doubles a trailing run of backslashes so the closing quote still closes", () => {
    expect(quoteForBatch("D:\\Zomboid Data\\")).toBe('"D:\\Zomboid Data\\\\"');
    expect(quoteForBatch("D:\\Zomboid Data\\\\")).toBe('"D:\\Zomboid Data\\\\\\\\"');
    expect(quoteForBatch("D:\\")).toBe('"D:\\\\"');
  });

  it("leaves backslashes inside the value alone", () => {
    expect(quoteForBatch("C:\\a\\b\\c")).toBe('"C:\\a\\b\\c"');
  });

  it("refuses what cannot be represented, rather than changing it", () => {
    for (const bad of FORBIDDEN) {
      expect(() => quoteForBatch(`a${bad}b`)).toThrow(/cannot carry/);
    }
  });
});

describe("quoteForShell()", () => {
  it("single-quotes, so $ ` \\ ! and % are all literal", () => {
    expect(quoteForShell("P@ss%w0rd!&x$y")).toBe("'P@ss%w0rd!&x$y'");
    expect(quoteForShell("a`b\\c$(d)")).toBe("'a`b\\c$(d)'");
    expect(quoteForShell("/srv/PZ Data (x86)")).toBe("'/srv/PZ Data (x86)'");
  });

  it("escapes a single quote by closing, escaping and reopening", () => {
    expect(quoteForShell("it's")).toBe("'it'\\''s'");
    expect(quoteForShell("'")).toBe("''\\'''");
  });

  it("refuses what cannot be represented", () => {
    for (const bad of FORBIDDEN) {
      expect(() => quoteForShell(`a${bad}b`)).toThrow(/cannot carry/);
    }
  });

  const bash = spawnSync("bash", ["-c", "true"], { encoding: "utf8" });
  (bash.error || bash.status !== 0 ? it.skip : it)("is read back by bash as the same text", () => {
    const awkward = [
      "P@ss%w0rd!&x$y",
      "it's a \\ test `ls` $(id) ; | & > <",
      "/home/user/PZ Data (x86)",
      "'''",
      "trailing\\",
      "\\",
    ];
    for (const value of awkward) {
      const run = spawnSync("bash", ["-c", `printf '%s' ${quoteForShell(value)}`], { encoding: "utf8" });
      expect(run.stdout).toBe(value);
    }
  });
});

describe("startScriptValueProblem() and the comment text", () => {
  it("reports a double quote and control characters, and nothing else", () => {
    expect(startScriptValueProblem("fine P@ss%w0rd!&x$y '")).toBeNull();
    expect(startScriptValueProblem('a"b')).toBe("quote");
    expect(startScriptValueProblem("a\nb")).toBe("control");
    expect(startScriptValueProblem(undefined)).toBeNull();
  });

  it("keeps a comment line a plain comment", () => {
    expect(textForScriptComment("My Server-1.b42")).toBe("My Server-1.b42");
    expect(textForScriptComment("a&b|c%d")).toBe("a_b_c_d");
  });
});

describe("generateStartupScripts()", () => {
  const base = {
    installPath: path.join(os.tmpdir(), "zcp-quoting-no-install"),
    serverName: "MyServer",
    minMemory: 2,
    maxMemory: 4,
    serverPort: 16261,
  };

  it("passes a data folder with parentheses and spaces through exactly (it used to lose the parentheses)", () => {
    const scripts = generateStartupScripts({ ...base, zomboidDataPath: "D:\\Games (x86)\\PZ Data" });
    expect(scripts.bat).toContain('-cachedir="D:\\Games (x86)\\PZ Data"');
    expect(scripts.sh).toContain("-cachedir='D:\\Games (x86)\\PZ Data'");
    expect(scripts.bat).not.toContain("x86)\\PZ Data\\");
  });

  // The admin password no longer goes into the scripts (security audit
  // R1-30/R1-35): the panel hands it over in PZ_PANEL_ADMIN_PASSWORD, and
  // adminPasswordOutOfScripts.test.js runs that through real cmd.exe and
  // bash with P@ss%w0rd!&x$y and friends. The one place it is still quoted
  // into a script is a systemd/OpenRC unit's .sh, for one start.
  it("quotes an admin password embedded for a systemd/OpenRC unit's .sh, single quote included", () => {
    const scripts = generateStartupScripts({ ...base, embeddedAdminPassword: "pa..ss'w%rd!&x$y" });
    expect(scripts.sh).toContain("PZ_ADMIN_PASSWORD='pa..ss'\\''w%rd!&x$y'");
    expect(scripts.bat).not.toContain("pa..ss");
  });

  it("doubles a trailing backslash in the .bat so -cachedir=\"...\" keeps its closing quote", () => {
    const scripts = generateStartupScripts({ ...base, zomboidDataPath: "D:\\Zomboid Data\\" });
    expect(scripts.bat).toContain('-cachedir="D:\\Zomboid Data\\\\"');
  });

  it("turns delayed expansion off in the .bat, so a ! in a value survives a machine that has it on", () => {
    const scripts = generateStartupScripts({ ...base });
    expect(scripts.bat).toContain("@setlocal enableextensions disabledelayedexpansion");
  });

  it("refuses a double quote or a control character anywhere, and writes no script", () => {
    for (const bad of FORBIDDEN) {
      expect(() => generateStartupScripts({ ...base, embeddedAdminPassword: `pw${bad}x` })).toThrow();
      expect(() => generateStartupScripts({ ...base, zomboidDataPath: `D:\\Data${bad}x` })).toThrow();
      expect(() => generateStartupScripts({ ...base, serverName: `My${bad}Server` })).toThrow();
    }
  });

  it("a line break in the admin password can't start a new script line (it is refused, not stripped)", () => {
    expect(() =>
      generateStartupScripts({ ...base, embeddedAdminPassword: "hunter2\r\necho INJECTED\r\nrem " }),
    ).toThrow();
    expect(() =>
      generateStartupScripts({ ...base, zomboidDataPath: "C:\\PZServer_Data\r\necho INJECTED" }),
    ).toThrow();
  });

  it("a server name can't break out of the comment line either", () => {
    const scripts = generateStartupScripts({ ...base, serverName: "a&b|c" });
    expect(scripts.bat).toContain("REM Server Name: a_b_c");
    expect(scripts.sh).toContain("# Server Name: a_b_c");
  });
});

describe("the panel recognises the process its own script starts", () => {
  const launchLine = (script) => script.split("\n").find((line) => line.includes("zombie.network.GameServer"));
  const base = {
    installPath: path.join(os.tmpdir(), "zcp-quoting-no-install"),
    serverName: "MyServer",
    minMemory: 2,
    maxMemory: 4,
    serverPort: 16261,
  };

  it.each([
    ["D:\\Games (x86)\\PZ Data", "D:\\Games (x86)\\PZ Data"],
    ["D:\\Zomboid Data\\", "D:\\Zomboid Data"],
    ["D:\\Zomboid Data", "D:\\Zomboid Data"],
  ])("a .bat for %s scores positive against the profile's folder %s (it used to score -1)", (written, stored) => {
    const { bat } = generateStartupScripts({ ...base, zomboidDataPath: written });
    const cmd = launchLine(bat);
    expect(cmd).toBeTruthy();
    expect(scoreServerProcessOwnership(cmd, { serverName: "MyServer", savePath: stored })).toBeGreaterThan(0);
  });

  it("and against a different folder it still scores -1", () => {
    const { bat } = generateStartupScripts({ ...base, zomboidDataPath: "D:\\Games (x86)\\PZ Data" });
    expect(
      scoreServerProcessOwnership(launchLine(bat), { serverName: "MyServer", savePath: "D:\\Games x86\\PZ Data" }),
    ).toBe(-1);
  });
});

// The Java launcher splits its command line with the C runtime's rules, as
// node.exe does: a real cmd.exe + real argument parser round trip.
(isWindows ? describe : describe.skip)("a generated .bat, read by cmd.exe and an argv parser", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-bat-argv-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function argvOf(args) {
    const script = path.join(dir, "probe.bat");
    fs.writeFileSync(
      script,
      `@echo off\r\n@setlocal enableextensions disabledelayedexpansion\r\n"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" -- ${args}\r\n`,
    );
    const run = spawnSync("cmd.exe", ["/d", "/c", script], { encoding: "utf8" });
    return JSON.parse(run.stdout.trim().split(/\r?\n/).pop());
  }

  it("delivers a trailing-backslash folder, a parenthesised one and a hard password intact, and keeps the arguments after them", () => {
    const folder = "D:\\Zomboid Data\\";
    const password = "P@ss%w0rd!&x$y^(z)";
    const argv = argvOf(
      [
        `-servername ${quoteForBatch("My Server")}`,
        `-cachedir=${quoteForBatch(folder)}`,
        `-adminpassword ${quoteForBatch(password)}`,
        "-nosteam",
      ].join(" "),
    );
    expect(argv).toEqual(["-servername", "My Server", `-cachedir=${folder}`, "-adminpassword", password, "-nosteam"]);
    const parens = argvOf(`-cachedir=${quoteForBatch("D:\\Games (x86)\\PZ Data")} -nosteam`);
    expect(parens).toEqual(["-cachedir=D:\\Games (x86)\\PZ Data", "-nosteam"]);
  });

  it("the unquoted-trailing-backslash form is what used to swallow the rest of the line", () => {
    const argv = argvOf('-cachedir="D:\\Zomboid Data\\" -nosteam');
    expect(argv).not.toEqual(["-cachedir=D:\\Zomboid Data\\", "-nosteam"]);
  });
});

describe("saving what a start script cannot carry", () => {
  it("adminPasswordStartScriptRefusal(): a quote or a control character is refused with its own code; anything else passes", () => {
    expect(adminPasswordStartScriptRefusal('pa"ss').code).toBe(ErrorCode.ADMIN_PASSWORD_UNSUPPORTED_CHARACTERS);
    expect(adminPasswordStartScriptRefusal("pa\nss").code).toBe(ErrorCode.ADMIN_PASSWORD_UNSUPPORTED_CHARACTERS);
    expect(adminPasswordStartScriptRefusal("P@ss%w0rd!&x$y'`\\")).toBeNull();
    expect(adminPasswordStartScriptRefusal("")).toBeNull();
    expect(adminPasswordStartScriptRefusal(undefined)).toBeNull();
  });

  it("checkZomboidDataPath(): a double quote inside the path is refused with its own code", () => {
    const folder = path.join(os.tmpdir(), 'zcp-"quoted"-data');
    const verdict = checkZomboidDataPath(folder, { expand: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.body.code).toBe(ErrorCode.ZOMBOID_DATA_PATH_UNSUPPORTED_CHARACTERS);
  });
});

describe("resolveZomboidPaths(): the folder as the game gets it", () => {
  it("drops a trailing separator from a pasted data folder, so the script, the profile and the process agree", () => {
    const base = path.join(os.tmpdir(), "zcp-resolve-data");
    const withSeparator = base + path.sep;
    expect(resolveZomboidPaths(path.join(os.tmpdir(), "install"), withSeparator).zomboidPath).toBe(base);
    expect(resolveZomboidPaths(path.join(os.tmpdir(), "install"), withSeparator).serverConfigPath).toBe(
      path.join(base, "Server"),
    );
  });
});

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

function fakeIo() {
  let resolveComplete;
  const completePromise = new Promise((resolve) => {
    resolveComplete = resolve;
  });
  const io = {
    emit: vi.fn((event, payload) => {
      if (event === "install:complete") resolveComplete(payload);
    }),
  };
  io.to = vi.fn(() => io);
  return { io, completePromise };
}

function fakeReq(body, io = fakeIo().io) {
  return { app: { get: (key) => (key === "io" ? io : undefined) }, body };
}

describe("POST /quick-setup and POST /install", () => {
  let root;
  let installDir;
  let steamcmdDir;
  let previousSavePath;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-start-quoting-"));
    installDir = path.join(root, "pz-server");
    fs.mkdirSync(path.join(installDir, "jre64"), { recursive: true });
    fs.writeFileSync(path.join(installDir, "ProjectZomboid64.json"), "{}");
    steamcmdDir = path.join(root, "steamcmd");
    fs.mkdirSync(steamcmdDir, { recursive: true });
    fs.writeFileSync(path.join(steamcmdDir, isWindows ? "steamcmd.exe" : "steamcmd.sh"), "");
    previousSavePath = process.env.PZ_SAVE_PATH;
    delete process.env.PZ_SAVE_PATH;
    spawnMock.mockReset();
    vi.mocked(setSetting).mockClear();
  });

  afterEach(() => {
    if (previousSavePath === undefined) delete process.env.PZ_SAVE_PATH;
    else process.env.PZ_SAVE_PATH = previousSavePath;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const savedSetting = (key) => vi.mocked(setSetting).mock.calls.filter(([k]) => k === key).map(([, v]) => v);

  it("/quick-setup uses the trimmed server name for the ini, the scripts and the settings", async () => {
    const data = path.join(root, "data");
    const response = createResponse();
    await getHandler("/quick-setup")(
      fakeReq({ installPath: installDir, serverName: "  MyServer ", zomboidDataPath: data, rconPassword: "pw" }),
      response,
    );
    expect(response.status).not.toHaveBeenCalledWith(400);
    expect(fs.existsSync(path.join(data, "Server", "MyServer.ini"))).toBe(true);
    expect(fs.readdirSync(path.join(data, "Server")).filter((f) => f.includes(" "))).toEqual([]);
    expect(fs.existsSync(path.join(installDir, "StartServer_MyServer.bat"))).toBe(true);
    expect(fs.existsSync(path.join(installDir, "start-server_MyServer.sh"))).toBe(true);
    expect(fs.readdirSync(installDir).filter((f) => f.includes(" "))).toEqual([]);
    expect(savedSetting("serverName")).toEqual(["MyServer"]);
    expect(fs.readFileSync(path.join(installDir, "StartServer_MyServer.bat"), "utf8")).toContain(
      '-servername "MyServer"',
    );
    const body = response.json.mock.calls[0][0];
    expect(body.serverName).toBe("MyServer");
  });

  it("/quick-setup stores and launches with the data folder without its trailing separator", async () => {
    const data = path.join(root, "My Data");
    const response = createResponse();
    await getHandler("/quick-setup")(
      fakeReq({ installPath: installDir, serverName: "MyServer", zomboidDataPath: data + path.sep, rconPassword: "pw" }),
      response,
    );
    expect(response.status).not.toHaveBeenCalledWith(400);
    expect(savedSetting("zomboidDataPath")).toEqual([data]);
    expect(response.json.mock.calls[0][0].zomboidDataPath).toBe(data);
    const bat = fs.readFileSync(path.join(installDir, "StartServer_MyServer.bat"), "utf8");
    expect(bat).toContain(`-cachedir="${data}"`);
    const sh = fs.readFileSync(path.join(installDir, "start-server_MyServer.sh"), "utf8");
    expect(sh).toContain(`-cachedir='${data}'`);
  });

  it("/quick-setup keeps the admin password out of the scripts it writes", async () => {
    const response = createResponse();
    await getHandler("/quick-setup")(
      fakeReq({
        installPath: installDir,
        serverName: "MyServer",
        zomboidDataPath: path.join(root, "data"),
        adminPassword: "P@ss%w0rd!&x$y",
        rconPassword: "pw",
      }),
      response,
    );
    expect(response.status).not.toHaveBeenCalledWith(400);
    for (const name of ["StartServer_MyServer.bat", "start-server_MyServer.sh"]) {
      const text = fs.readFileSync(path.join(installDir, name), "utf8");
      expect(text).toContain("-servername");
      expect(text).not.toContain("w0rd");
    }
  });

  it("/quick-setup refuses an admin password a script cannot carry, before writing anything", async () => {
    const response = createResponse();
    await getHandler("/quick-setup")(
      fakeReq({ installPath: installDir, serverName: "MyServer", adminPassword: 'pa"ss', rconPassword: "pw" }),
      response,
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].code).toBe(ErrorCode.ADMIN_PASSWORD_UNSUPPORTED_CHARACTERS);
    expect(fs.existsSync(path.join(installDir, "StartServer_MyServer.bat"))).toBe(false);
    expect(vi.mocked(setSetting)).not.toHaveBeenCalled();
  });

  it("/quick-setup refuses a data folder with a double quote in it", async () => {
    const response = createResponse();
    await getHandler("/quick-setup")(
      fakeReq({
        installPath: installDir,
        serverName: "MyServer",
        zomboidDataPath: path.join(root, 'da"ta'),
        rconPassword: "pw",
      }),
      response,
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].code).toBe(ErrorCode.ZOMBOID_DATA_PATH_UNSUPPORTED_CHARACTERS);
  });

  it("/install uses the trimmed server name and the resolved data folder everywhere", async () => {
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });
    const data = path.join(root, "Zomboid Data");
    fs.mkdirSync(data, { recursive: true });
    const { io, completePromise } = fakeIo();
    const response = createResponse();
    await getHandler("/install")(
      fakeReq(
        {
          steamcmdPath: steamcmdDir,
          installPath: installDir,
          serverName: " MyServer  ",
          zomboidDataPath: data + path.sep,
          adminPassword: "P@ss%w0rd!&x$y",
          rconPassword: "rconpassword123",
          branch: "public",
          serverPort: 16261,
          minMemory: 2,
          maxMemory: 4,
        },
        io,
      ),
      response,
    );
    expect(response.status).not.toHaveBeenCalledWith(400);
    const payload = await completePromise;
    expect(payload.success).toBe(true);
    expect(payload.serverName).toBe("MyServer");
    expect(fs.existsSync(path.join(data, "Server", "MyServer.ini"))).toBe(true);
    expect(fs.readdirSync(path.join(data, "Server")).filter((f) => f.includes(" "))).toEqual([]);
    expect(fs.readdirSync(installDir).filter((f) => f.includes(" "))).toEqual([]);
    expect(savedSetting("serverName")).toEqual(["MyServer"]);
    expect(savedSetting("zomboidDataPath")).toEqual([data]);
    const bat = fs.readFileSync(path.join(installDir, "StartServer_MyServer.bat"), "utf8");
    expect(bat).toContain('-servername "MyServer"');
    expect(bat).toContain(`-cachedir="${data}"`);
    expect(bat).not.toContain("w0rd");
    const sh = fs.readFileSync(path.join(installDir, "start-server_MyServer.sh"), "utf8");
    expect(sh).not.toContain("w0rd");
  });

  it("/install refuses an admin password a script cannot carry, before SteamCMD runs", async () => {
    const response = createResponse();
    await getHandler("/install")(
      fakeReq({
        steamcmdPath: steamcmdDir,
        installPath: installDir,
        serverName: "MyServer",
        adminPassword: "pa\nss",
      }),
      response,
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].code).toBe(ErrorCode.ADMIN_PASSWORD_UNSUPPORTED_CHARACTERS);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
