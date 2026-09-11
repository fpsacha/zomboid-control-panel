import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const mockExecFile = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args) => mockExecFile(...args),
}));

const {
  buildBundleDiagnostics,
  buildSystemInfo,
  buildServerConfigSummary,
  buildSandboxOptionsDiagnostics,
  buildOidcStatus,
  buildRolesAndPermissions,
  checkCurlAvailable,
  buildWorldMapDiagnostics,
  buildDbWriteHealth,
  buildBackupsSummary,
  buildDiscordBotStatus,
  buildDockerContainerLogsText,
  buildManagedServiceLogsText,
  collectBundleFilesFromDir,
} = await import("../routes/debug.js");
const { setDockerClient } = await import("../services/managedContainer.js");

function fakeReq(services = {}, headers = {}) {
  return { app: { get: (key) => services[key] }, headers };
}

describe("support bundle: recursive log discovery", () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-bundle-log-tree-"));
    fs.mkdirSync(path.join(root, "nested", "runtime"), { recursive: true });
    fs.mkdirSync(path.join(root, "Saves", "Multiplayer"), { recursive: true });
    fs.writeFileSync(path.join(root, "root.txt"), "root");
    fs.writeFileSync(path.join(root, "nested", "runtime", "server.err"), "err");
    fs.writeFileSync(path.join(root, "Saves", "Multiplayer", "ignored.log"), "save");
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("finds nested log extensions while skipping game data directories", async () => {
    const entries = [];
    const result = await collectBundleFilesFromDir(
      root,
      (name) => /\.(log|txt|err)$/i.test(name),
      "server-logs",
      entries,
      new Set(),
      { maxDepth: 3, skipDirectories: ["saves"] },
    );

    expect(result.addedFiles).toBe(2);
    expect(entries.map((entry) => entry.archivePath)).toEqual(
      expect.arrayContaining([
        "server-logs/root.txt",
        "server-logs/nested/runtime/server.err",
      ]),
    );
    expect(entries.some((entry) => entry.archivePath.includes("ignored.log"))).toBe(false);
  });
});

describe("support bundle: curl availability (World Map's runtime dependency)", () => {
  afterEach(() => mockExecFile.mockReset());

  it("reports available with a version string when curl is on PATH", async () => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      cb(null, "curl 8.4.0 (x86_64-pc-win32)\nRelease-Date: 2023-10-11", "");
    });
    const result = await checkCurlAvailable();
    expect(result.available).toBe(true);
    expect(result.version).toContain("curl 8.4.0");
  });

  it("reports unavailable with a clear reason when curl is missing (ENOENT)", async () => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      const err = new Error("spawn curl ENOENT");
      err.code = "ENOENT";
      cb(err);
    });
    const result = await checkCurlAvailable();
    expect(result).toEqual({ available: false, reason: "curl is not on PATH" });
  });

  it("buildWorldMapDiagnostics combines curl status with the B42 resolution contract shape", async () => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "curl 8.4.0", ""));
    const result = await buildWorldMapDiagnostics();
    expect(result.curl.available).toBe(true);
    // Contract fixed in conv-mapbuild: { source, directory, reason }.
    expect(result.b42Resolution).toHaveProperty("source");
    expect(result.b42Resolution).toHaveProperty("directory");
    expect(result.b42Resolution).toHaveProperty("reason");
  });
});

describe("support bundle: OIDC status never leaks the client secret value", () => {
  it("reports configuration only -- clientSecretSet is a boolean, the actual secret never appears anywhere in the output", async () => {
    const result = await buildOidcStatus();
    expect(result).not.toHaveProperty("_error");
    expect(typeof result.clientSecretSet).toBe("boolean");
    expect(JSON.stringify(result)).not.toMatch(/clientSecret"\s*:\s*"(?!.*Set)/);
    // The literal key "clientSecret" (the value) must never appear -- only
    // "clientSecretSet" (the boolean).
    expect(result).not.toHaveProperty("clientSecret");
    expect(result).toHaveProperty("envOverrides");
  });
});

describe("support bundle: roles and permissions", () => {
  it("returns an array of roles and an array of local users with no unexpected shape", async () => {
    const result = await buildRolesAndPermissions();
    expect(result).not.toHaveProperty("_error");
    expect(Array.isArray(result.roles)).toBe(true);
    expect(Array.isArray(result.users)).toBe(true);
    // Every role entry must carry what a support reader needs to answer
    // "what does this role grant".
    for (const role of result.roles) {
      expect(role).toHaveProperty("name");
      expect(Array.isArray(role.capabilities)).toBe(true);
      expect(typeof role.memberCount).toBe("number");
    }
    for (const user of result.users) {
      expect(user).toHaveProperty("username");
      expect(user).toHaveProperty("role");
      // No password/hash field of any kind should ever reach this collector.
      expect(user).not.toHaveProperty("password");
    }
  });
});

describe("support bundle: db write health", () => {
  it("surfaces db.json's circuit breaker state read-only, closed by default", async () => {
    const result = buildDbWriteHealth();
    expect(result).not.toHaveProperty("_error");
    expect(result).toHaveProperty("open");
    expect(result).toHaveProperty("failCount");
    expect(result).toHaveProperty("cooldownEndsAt");
  });
});

describe("support bundle: backups summary", () => {
  it("combines backup settings and recent run history, masking a credential-shaped field if one were ever present", async () => {
    const req = fakeReq({
      backupService: {
        getSettings: async () => ({
          enabled: true,
          schedule: "0 */6 * * *",
          maxBackups: 10,
          includeDb: true,
          // Deliberately injected to prove sanitizeForBundle is really
          // applied here, not just declared in a comment.
          apiKey: "sk-live-should-never-appear",
        }),
      },
    });
    const result = await buildBackupsSummary(req);
    expect(result).not.toHaveProperty("_error");
    expect(result.settings.schedule).toBe("0 */6 * * *");
    expect(result.settings.apiKey).toBe("••••");
    expect(Array.isArray(result.recentRuns)).toBe(true);
  });

  it("degrades to _error, not a thrown exception, when backupService itself throws", async () => {
    const req = fakeReq({});
    req.app.get = (key) => {
      if (key === "backupService") throw new Error("boom-backup-service");
      return null;
    };
    const result = await buildBackupsSummary(req);
    expect(result._error).toContain("boom-backup-service");
  });
});

describe("support bundle: Discord bot status", () => {
  it("passes through connection/guild/channel info and masks a token-shaped field", async () => {
    const req = fakeReq({
      discordBot: {
        getStatus: () => ({
          running: true,
          configured: true,
          username: "PZBot#1234",
          guildId: "111",
          channelId: "222",
          modRoleId: null,
          lastStartError: null,
          // getStatus() never actually returns this in real code, but if a
          // future change accidentally added it, sanitizeForBundle must
          // still catch it -- defense in depth, proven rather than assumed.
          token: "should-never-survive",
        }),
      },
    });
    const result = await buildDiscordBotStatus(req);
    expect(result.running).toBe(true);
    expect(result.guildId).toBe("111");
    expect(result.token).toBe("••••");
  });

  it("reports unavailable rather than throwing when no Discord bot is registered", async () => {
    const req = fakeReq({});
    const result = await buildDiscordBotStatus(req);
    expect(result).toEqual({ available: false });
  });
});

describe("support bundle: system info reports whether the server process was running", () => {
  it("reports running:true, scanFailed:false when the process check succeeds", async () => {
    const serverManager = {
      getServerProcessDetails: async () => ({ running: true, scanFailed: false }),
    };
    const result = await buildSystemInfo(null, serverManager);
    expect(result.serverProcess).toEqual({ checked: true, running: true, scanFailed: false });
  });

  it("reports scanFailed:true rather than a false 'not running' when detection itself fails", async () => {
    const serverManager = {
      getServerProcessDetails: async () => ({ running: false, scanFailed: true }),
    };
    const result = await buildSystemInfo(null, serverManager);
    expect(result.serverProcess.scanFailed).toBe(true);
  });

  it("reports checked:false rather than throwing when no serverManager is available", async () => {
    const result = await buildSystemInfo(null, null);
    expect(result.serverProcess).toEqual({ checked: false });
  });

  it("defaults uiLanguage to 'not reported' when the caller doesn't supply one", async () => {
    const result = await buildSystemInfo(null, null);
    expect(result.uiLanguage).toBe("not reported");
  });
});

describe("support bundle: UI language reported by the bundle-download request", () => {
  // buildBundleDiagnostics also runs buildWorldMapDiagnostics, which shells
  // out to curl -- give the mock a working implementation so that Promise.all
  // resolves instead of hanging on an unconfigured child_process mock.
  beforeEach(() => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "curl 8.4.0", ""));
  });
  afterEach(() => mockExecFile.mockReset());

  it("threads a plausible BCP-47-shaped header value straight through system-info.json", async () => {
    const req = fakeReq({}, { "x-ui-language": "zh-CN" });
    const files = await buildBundleDiagnostics(null, req);
    const systemInfo = JSON.parse(files.find((f) => f.name === "system-info.json").content);
    expect(systemInfo.uiLanguage).toBe("zh-CN");
  });

  it("degrades to 'not reported' rather than guessing 'en' when the header is absent", async () => {
    const req = fakeReq({});
    const files = await buildBundleDiagnostics(null, req);
    const systemInfo = JSON.parse(files.find((f) => f.name === "system-info.json").content);
    expect(systemInfo.uiLanguage).toBe("not reported");
  });

  it("degrades to 'not reported' for a garbage or oversized header rather than writing it through unvalidated", async () => {
    const tooLong = fakeReq({}, { "x-ui-language": "a".repeat(200) });
    const notALocale = fakeReq({}, { "x-ui-language": "<script>alert(1)</script>" });

    const tooLongResult = await buildBundleDiagnostics(null, tooLong);
    const notALocaleResult = await buildBundleDiagnostics(null, notALocale);

    expect(
      JSON.parse(tooLongResult.find((f) => f.name === "system-info.json").content).uiLanguage,
    ).toBe("not reported");
    expect(
      JSON.parse(notALocaleResult.find((f) => f.name === "system-info.json").content).uiLanguage,
    ).toBe("not reported");
  });

  it("README describes the new field and no longer carries the stale 'not included' exclusion", async () => {
    const req = fakeReq({});
    const files = await buildBundleDiagnostics(null, req);
    const readme = files.find((f) => f.name === "README.md").content;
    expect(readme).toContain("uiLanguage");
    expect(readme).not.toContain("Which UI language the reporting user had selected");
  });
});

describe("support bundle: server config summary flags a Mods/WorkshopItems length mismatch", () => {
  let configDir;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-bundle-config-"));
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  function writeIni(mods, workshopItems) {
    fs.writeFileSync(
      path.join(configDir, "servertest.ini"),
      `Mods=${mods}\nWorkshopItems=${workshopItems}\n`,
    );
  }

  it("flags true when the two lists have different lengths", async () => {
    writeIni("ModA;ModB", "111111");
    const result = await buildServerConfigSummary({
      serverConfigPath: configDir,
      serverName: "servertest",
    });
    // Also pins a real, pre-existing bug found while adding this field:
    // debug.js called crypto.createHash() with no `import crypto` anywhere
    // in the file. Node's ESM-global `crypto` is the Web Crypto API only
    // (no createHash), so this threw on every real request and was silently
    // swallowed by the collector's own try/catch -- ini.sha256/settings/
    // mods/workshopItems/map (and this new field) were ALWAYS missing in
    // practice, masked as a generic ini.error. Fixed alongside this task
    // since it directly blocked the new field from ever being reachable.
    expect(result.ini.error).toBeUndefined();
    expect(result.ini.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.ini.modsWorkshopCountMismatch).toBe(true);
  });

  it("flags false when the two lists are the same length", async () => {
    writeIni("ModA;ModB", "111111;222222");
    const result = await buildServerConfigSummary({
      serverConfigPath: configDir,
      serverName: "servertest",
    });
    expect(result.ini.modsWorkshopCountMismatch).toBe(false);
  });
});

describe("support bundle: sandbox-options diagnostics identify the failure and candidate mods", () => {
  let dataDir;
  let configDir;
  let installDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-bundle-sandbox-data-"));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-bundle-sandbox-config-"));
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-bundle-sandbox-install-"));
    const modRoot = path.join(
      installDir,
      "steamapps",
      "workshop",
      "content",
      "108600",
      "123",
      "mods",
      "ExampleMod",
      "42",
    );
    fs.mkdirSync(path.join(modRoot, "media"), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "servertest.ini"),
      "Mods=ExampleMod\nWorkshopItems=123\n",
    );
    fs.writeFileSync(
      path.join(dataDir, "server-console.txt"),
      [
        "version=42.20.4 b0bbce05d5 demo=false",
        "[PanelBridge] Initializing v1.7.57",
        "POST /command: action=getAllSandboxOptions args={}",
        "java.lang.ArrayIndexOutOfBoundsException at SandboxOptions$EnumSandboxOption.getValueTranslationByIndexOrNull(SandboxOptions.java:1270).",
        "Lua(Vanilla).getAllSandboxOptions(PanelBridge.lua:4864)",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(modRoot, "mod.info"),
      "name=Example Mod\nid=ExampleMod\nmodversion=2.4.1\npzversion=42.20\n",
    );
    fs.writeFileSync(
      path.join(modRoot, "media", "sandbox-options.txt"),
      "option=ExampleMod.SomeOption\n",
    );
  });

  afterEach(() => {
    for (const directory of [dataDir, configDir, installDir]) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("captures the PZ exception, versions, and installed mod metadata", async () => {
    const result = await buildSandboxOptionsDiagnostics({
      name: "servertest",
      serverName: "servertest",
      serverConfigPath: configDir,
      zomboidDataPath: dataDir,
      installPath: installDir,
    });

    expect(result.detected).toBe(true);
    expect(result.pzVersion).toBe("42.20.4");
    expect(result.panelBridgeVersion).toBe("1.7.57");
    expect(result.error.javaMethod).toContain("getValueTranslationByIndexOrNull");
    expect(result.error.optionName).toBeNull();
    expect(result.candidateMods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Example Mod",
          modversion: "2.4.1",
          workshopId: "123",
          sandboxOptionFiles: expect.arrayContaining([
            expect.stringContaining("sandbox-options.txt"),
          ]),
        }),
      ]),
    );
  });
});

describe("support bundle assembly: one collector throwing never breaks the rest", () => {
  it("degrades exactly the failing file to _error and leaves every other file intact", async () => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "curl 8.4.0", ""));
    const req = fakeReq({});
    req.app.get = (key) => {
      if (key === "backupService") throw new Error("boom-backup-service");
      return null;
    };

    const files = await buildBundleDiagnostics(null, req);
    const byName = Object.fromEntries(files.map((f) => [f.name, f.content]));

    expect(JSON.parse(byName["backups-summary.json"])._error).toContain(
      "boom-backup-service",
    );
    // Every other new collector still produced a real result, not an error.
    for (const name of [
      "oidc-status.json",
      "roles-and-permissions.json",
      "world-map-diagnostics.json",
      "db-write-health.json",
      "discord-bot-status.json",
      "system-info.json",
    ]) {
      expect(byName[name]).toBeDefined();
      expect(JSON.parse(byName[name])._error).toBeUndefined();
    }
    // README.md was updated to describe every file actually produced.
    expect(byName["README.md"]).toContain("roles-and-permissions.json");
    expect(byName["README.md"]).toContain("oidc-status.json");
  });
});

// support-bundle-2026-08-30: hive/agents/god/research/discord-restart-etxtbsy-2026-08-30.md --
// a real production report was only diagnosable from a "Text file busy"
// stack trace a user pasted BY HAND from `docker logs`. None of the
// filesystem-scanning collectors above would have captured it -- container
// stdout/stderr is not a file on disk anywhere this panel looks.
describe("support bundle: Docker container logs", () => {
  afterEach(() => setDockerClient(null));

  it("skips with a clear reason when no container is mapped to the active server", async () => {
    const text = await buildDockerContainerLogsText({ id: "s1" });
    expect(text).toContain("No Docker container is mapped");
  });

  it("skips with a clear reason when a container is mapped but Docker control is off", async () => {
    setDockerClient({ enabled: false, available: false });
    const text = await buildDockerContainerLogsText({
      id: "s1",
      dockerContainerName: "pz-server",
    });
    expect(text).toContain('"pz-server"');
    expect(text).toContain("Docker control is disabled");
  });

  it("includes the fetched log text -- the whole point of this file", async () => {
    const getContainerLogs = vi.fn(async (ref, opts) => {
      expect(ref).toBe("pz-server");
      expect(opts.tail).toBe(500);
      return "Unhandled exception. System.IO.IOException: Text file busy : '/project-zomboid/jre64/bin/java'\n";
    });
    setDockerClient({ enabled: true, available: true, getContainerLogs });
    const text = await buildDockerContainerLogsText({
      id: "s1",
      dockerContainerName: "pz-server",
    });
    expect(text).toContain("Text file busy");
    expect(text).toContain("pz-server");
    expect(getContainerLogs).toHaveBeenCalledOnce();
  });

  it("reports a fetch failure rather than silently omitting the file", async () => {
    setDockerClient({
      enabled: true,
      available: true,
      getContainerLogs: vi.fn(async () => null),
    });
    const text = await buildDockerContainerLogsText({
      id: "s1",
      dockerContainerName: "pz-server",
    });
    expect(text).toContain("could not be fetched");
  });

  it("reports an empty history distinctly from a fetch failure", async () => {
    setDockerClient({
      enabled: true,
      available: true,
      getContainerLogs: vi.fn(async () => ""),
    });
    const text = await buildDockerContainerLogsText({
      id: "s1",
      dockerContainerName: "pz-server",
    });
    expect(text).toContain("no stdout/stderr history yet");
  });

  it("falls back to dockerContainerId when no name is set", async () => {
    const getContainerLogs = vi.fn(async (ref) => {
      expect(ref).toBe("abc123");
      return "hello\n";
    });
    setDockerClient({ enabled: true, available: true, getContainerLogs });
    await buildDockerContainerLogsText({ id: "s1", dockerContainerId: "abc123" });
    expect(getContainerLogs).toHaveBeenCalledOnce();
  });
});

describe("support bundle: managed-service (systemd/OpenRC) logs", () => {
  // The systemd branch is gated on process.platform === "linux" (systemd
  // --user is a Linux-only concept). Pin the platform explicitly for each
  // test rather than skipping on a non-Linux CI runner, so this suite's
  // pass/fail doesn't depend on which OS happens to run it -- mirrors
  // server/tests/swapInfo.test.js's own process.platform stub pattern.
  const originalPlatform = process.platform;
  function setPlatform(value) {
    Object.defineProperty(process, "platform", { value, configurable: true });
  }
  // A test earlier in this file (the "one collector throwing" suite) sets
  // mockExecFile's implementation and calls it via buildWorldMapDiagnostics()
  // but has no afterEach of its own to clear the call history -- reset here
  // too so this suite's not.toHaveBeenCalled() assertions don't depend on
  // execution order across describe blocks.
  beforeEach(() => mockExecFile.mockReset());
  afterEach(() => {
    setPlatform(originalPlatform);
    mockExecFile.mockReset();
  });

  it("skips with a clear reason when the server is not lifecycle-managed", async () => {
    const text = await buildManagedServiceLogsText({ id: "s1", lifecycleProvider: "direct" });
    expect(text).toContain("not running under a systemd/OpenRC managed lifecycle");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("reports OpenRC as a known, honest gap rather than guessing a log path", async () => {
    const text = await buildManagedServiceLogsText({ id: "s1", lifecycleProvider: "openrc" });
    expect(text).toContain("known gap");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("skips with a clear reason on a non-Linux panel host", async () => {
    setPlatform("win32");
    const text = await buildManagedServiceLogsText({ id: "s1", lifecycleProvider: "systemd" });
    expect(text).toContain("Linux-only");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("includes journalctl's output for a systemd-managed server", async () => {
    setPlatform("linux");
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      expect(cmd).toBe("journalctl");
      expect(args).toContain("--user");
      expect(args).toContain("-u");
      expect(args.find((a) => a.endsWith(".service"))).toBe(
        "zomboid-panel-server-s1.service",
      );
      cb(null, "Aug 30 sacha bash[1]: server ready\n", "");
    });
    const text = await buildManagedServiceLogsText({ id: "s1", lifecycleProvider: "systemd" });
    expect(text).toContain("server ready");
    expect(text).toContain("zomboid-panel-server-s1.service");
  });

  it("reports a journalctl failure (e.g. permission denied) instead of pretending the file is empty", async () => {
    setPlatform("linux");
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      const err = new Error("Command failed");
      err.code = 1;
      cb(err, "", "Failed to query journal: Permission denied");
    });
    const text = await buildManagedServiceLogsText({ id: "s1", lifecycleProvider: "systemd" });
    expect(text).toContain("Permission denied");
  });

  it("reports an empty journal distinctly from a failure", async () => {
    setPlatform("linux");
    mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "", ""));
    const text = await buildManagedServiceLogsText({ id: "s1", lifecycleProvider: "systemd" });
    expect(text).toContain("no entries for this unit yet");
  });
});
