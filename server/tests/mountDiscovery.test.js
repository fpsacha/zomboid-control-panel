import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  probeInstallPath,
  probeDataPath,
  findDataPath,
  discoverMounts,
  discoverMountIssues,
  scanAllCandidates,
  readServerIniSettings,
} from "../services/mountDiscovery.js";
import { isContainerized } from "../utils/dockerDetect.js";

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pz-mount-discovery-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("probeInstallPath", () => {
  it("rejects a missing or non-directory path", () => {
    expect(probeInstallPath(path.join(tmpRoot, "nope")).valid).toBe(false);
    expect(probeInstallPath("").valid).toBe(false);
  });

  it("rejects an unrelated empty directory", () => {
    expect(probeInstallPath(tmpRoot).valid).toBe(false);
  });

  it("distinguishes permission-denied from genuinely missing", () => {
    const denied = new Error("EACCES: permission denied");
    denied.code = "EACCES";
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw denied;
    });

    const result = probeInstallPath(path.join(tmpRoot, "locked"));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("permission-denied");
  });

  it("reports no reason for a genuinely missing path", () => {
    const result = probeInstallPath(path.join(tmpRoot, "nope"));
    expect(result.valid).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("detects a ProjectZomboid64 binary as a PZ signature", () => {
    fs.writeFileSync(path.join(tmpRoot, "ProjectZomboid64"), "");
    expect(probeInstallPath(tmpRoot).valid).toBe(true);
  });

  it("detects start-server.sh as a PZ signature", () => {
    fs.writeFileSync(path.join(tmpRoot, "start-server.sh"), "#!/bin/sh\n");
    const result = probeInstallPath(tmpRoot);
    expect(result.valid).toBe(true);
    expect(result.hasStartScript).toBe(true);
  });

  it("detects media/lua/ and steamapps/ as PZ signatures", () => {
    fs.mkdirSync(path.join(tmpRoot, "media", "lua"), { recursive: true });
    expect(probeInstallPath(tmpRoot).valid).toBe(true);

    const other = fs.mkdtempSync(path.join(os.tmpdir(), "pz-mount-discovery-"));
    fs.mkdirSync(path.join(other, "steamapps"), { recursive: true });
    expect(probeInstallPath(other).valid).toBe(true);
    fs.rmSync(other, { recursive: true, force: true });
  });

  it("reports the bundled PanelBridge mod when present", () => {
    fs.writeFileSync(path.join(tmpRoot, "start-server.sh"), "");
    fs.mkdirSync(path.join(tmpRoot, "media", "lua", "server"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpRoot, "media", "lua", "server", "PanelBridge.lua"),
      "",
    );
    expect(probeInstallPath(tmpRoot).hasPanelBridge).toBe(true);
  });
});

describe("probeDataPath", () => {
  it("rejects a missing path", () => {
    const result = probeDataPath(path.join(tmpRoot, "nope"));
    expect(result.valid).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("distinguishes permission-denied from genuinely missing", () => {
    const denied = new Error("EACCES: permission denied");
    denied.code = "EACCES";
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw denied;
    });

    const result = probeDataPath(path.join(tmpRoot, "locked"));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("permission-denied");
  });

  it("rejects a directory with no PZ data markers", () => {
    expect(probeDataPath(tmpRoot).valid).toBe(false);
  });

  it("accepts a folder with Saves/ or Lua/", () => {
    fs.mkdirSync(path.join(tmpRoot, "Saves"), { recursive: true });
    expect(probeDataPath(tmpRoot).valid).toBe(true);
  });

  it("reads server names from Server/*.ini, excluding sidecar files", () => {
    const serverDir = path.join(tmpRoot, "Server");
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, "servertest.ini"), "RCONPort=27015");
    fs.writeFileSync(path.join(serverDir, "servertest_SandboxVars.ini"), "");
    fs.writeFileSync(path.join(serverDir, "servertest_spawnpoints.ini"), "");

    const result = probeDataPath(tmpRoot);
    expect(result.valid).toBe(true);
    expect(result.serverNames).toEqual(["servertest"]);
  });
});

describe("findDataPath", () => {
  it("finds a Zomboid subdirectory under the install path", () => {
    fs.mkdirSync(path.join(tmpRoot, "Zomboid"), { recursive: true });
    expect(findDataPath(tmpRoot)).toBe(path.join(tmpRoot, "Zomboid"));
  });

  it("returns null when no Zomboid subdirectory exists", () => {
    expect(findDataPath(tmpRoot)).toBe(null);
  });
});

describe("readServerIniSettings", () => {
  it("parses RCON/port/name settings from the discovered ini", () => {
    const serverDir = path.join(tmpRoot, "Server");
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(
      path.join(serverDir, "servertest.ini"),
      ["RCONPort=27016", "RCONPassword=secret", "DefaultPort=16262", "PublicName=My Server"].join(
        "\n",
      ),
    );

    const settings = readServerIniSettings(tmpRoot, "servertest");
    expect(settings).toEqual({
      rconPort: 27016,
      rconPassword: "secret",
      serverPort: 16262,
      publicName: "My Server",
    });
  });

  it("returns null when the ini file does not exist", () => {
    expect(readServerIniSettings(tmpRoot, "missing")).toBe(null);
  });
});

describe("discoverMounts", () => {
  it("returns nothing when no candidate path is a valid PZ install", () => {
    expect(discoverMounts()).toEqual([]);
  });

  it("picks up an install path configured via PZ_SERVER_PATH / PZ_SAVE_PATH", () => {
    const installDir = path.join(tmpRoot, "install");
    const dataDir = path.join(tmpRoot, "data");
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, "start-server.sh"), "");
    fs.mkdirSync(path.join(dataDir, "Saves"), { recursive: true });

    vi.stubEnv("PZ_SERVER_PATH", installDir);
    vi.stubEnv("PZ_SAVE_PATH", dataDir);

    const mounts = discoverMounts();
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({
      installPath: installDir,
      dataPath: dataDir,
      source: "environment",
    });
  });

  it("falls back to a Zomboid subdirectory when no data path is configured", () => {
    const installDir = path.join(tmpRoot, "install");
    fs.mkdirSync(path.join(installDir, "Zomboid", "Saves"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(installDir, "start-server.sh"), "");

    vi.stubEnv("PZ_SERVER_PATH", installDir);

    const mounts = discoverMounts();
    expect(mounts).toHaveLength(1);
    expect(mounts[0].dataPath).toBe(path.join(installDir, "Zomboid"));
  });
});

describe("discoverMountIssues", () => {
  it("returns nothing when no common-mount candidate is even present", () => {
    expect(discoverMountIssues()).toEqual([]);
  });

  it("reports a common-mount install candidate that exists but can't be read", () => {
    const denied = new Error("EACCES: permission denied");
    denied.code = "EACCES";
    vi.spyOn(fs, "statSync").mockImplementation((p) => {
      if (p === "/pz-server") throw denied;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const issues = discoverMountIssues();
    expect(issues).toContainEqual({
      path: "/pz-server",
      source: "common-mount",
      reason: "permission-denied",
    });
  });

  it("does not report a candidate that simply isn't mounted", () => {
    // Default fs behaviour in the tmp-only test environment: nothing at the
    // hardcoded common-mount paths, which should be silent (not an issue).
    expect(discoverMountIssues()).toEqual([]);
  });
});

// server-detection-lifecycle-hardening, 2026-09-09: the operator's own
// ask -- "a validator that says 'path not found' for a path that
// demonstrably exists is the bug we are fixing" -- so scanAllCandidates()
// reports EVERY common Docker/Unraid/env candidate this module knows
// about, ranked best-first, each with a `status` and a plain-language
// `reason`, instead of discoverMounts()'s existing "silently skip anything
// that isn't a complete, ready server" contract (which stays unchanged for
// its own callers -- see the tests above).
describe("scanAllCandidates", () => {
  it("reports 'ready' with a human reason when both install and data are present", () => {
    const installDir = path.join(tmpRoot, "install");
    const dataDir = path.join(tmpRoot, "data");
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, "start-server.sh"), "");
    fs.mkdirSync(path.join(dataDir, "Saves"), { recursive: true });

    vi.stubEnv("PZ_SERVER_PATH", installDir);
    vi.stubEnv("PZ_SAVE_PATH", dataDir);

    const results = scanAllCandidates();
    const env = results.find((r) => r.source === "environment");
    expect(env.status).toBe("ready");
    expect(env.installPath).toBe(installDir);
    expect(env.dataPath).toBe(dataDir);
    expect(env.reason).toMatch(/complete project zomboid server/i);
  });

  it("reports 'install-only' with a human reason when the server install exists but no data path resolves", () => {
    const installDir = path.join(tmpRoot, "install");
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, "start-server.sh"), "");

    vi.stubEnv("PZ_SERVER_PATH", installDir);

    const results = scanAllCandidates();
    const env = results.find((r) => r.source === "environment");
    expect(env.status).toBe("install-only");
    expect(env.reason).toMatch(/no matching save-data folder/i);
  });

  it("reports 'data-only' with a human reason when only a save-data path is configured", () => {
    const dataDir = path.join(tmpRoot, "data");
    fs.mkdirSync(path.join(dataDir, "Saves"), { recursive: true });

    vi.stubEnv("PZ_SAVE_PATH", dataDir);

    const results = scanAllCandidates();
    const env = results.find((r) => r.source === "environment");
    expect(env.status).toBe("data-only");
    expect(env.dataPath).toBe(dataDir);
    expect(env.reason).toMatch(/no server install files/i);
  });

  it("reports 'empty' with a human reason for a path that exists but has no PZ markers at all", () => {
    const installDir = path.join(tmpRoot, "install");
    fs.mkdirSync(installDir, { recursive: true }); // exists, but nothing PZ-shaped inside

    vi.stubEnv("PZ_SERVER_PATH", installDir);

    const results = scanAllCandidates();
    const env = results.find((r) => r.source === "environment");
    expect(env.status).toBe("empty");
    expect(env.reason).toMatch(/doesn't look like a project zomboid/i);
  });

  it("reports 'not-mounted' with a human reason for a candidate path that doesn't exist at all", () => {
    vi.stubEnv("PZ_SERVER_PATH", path.join(tmpRoot, "does-not-exist"));

    const results = scanAllCandidates();
    const env = results.find((r) => r.source === "environment");
    expect(env.status).toBe("not-mounted");
    expect(env.reason).toMatch(/not mounted/i);
  });

  it("reports 'permission-denied' with a human reason distinct from 'not-mounted', and never silently drops the candidate", () => {
    const installDir = path.join(tmpRoot, "locked");
    const denied = new Error("EACCES: permission denied");
    denied.code = "EACCES";
    vi.spyOn(fs, "statSync").mockImplementation((p) => {
      if (p === installDir) throw denied;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    vi.stubEnv("PZ_SERVER_PATH", installDir);

    const results = scanAllCandidates();
    const env = results.find((r) => r.source === "environment");
    expect(env.status).toBe("permission-denied");
    expect(env.reason).toMatch(/doesn't have permission/i);
  });

  it("ranks 'ready' before 'not-mounted' even when it appears LATER in the raw candidate list -- proves this is a real sort, not just insertion order", () => {
    // The env candidate is always first in the raw candidate list, so
    // making IT the "ready" one would pass even with sorting disabled
    // entirely -- not a real test of the sort. Instead, make the THIRD
    // hardcoded common-mount candidate ("/steam/pz", checked after
    // "/pz-server" and "/serverdata/serverfiles") the ready one, leaving
    // everything before it not-mounted (the default on a machine with none
    // of these paths). Matched by a path-separator-agnostic prefix check
    // (path.join uses backslashes on win32, forward slashes elsewhere) so
    // this passes identically on this repo's Windows dev machines and
    // god's Linux gate -- see the standing rule on platform-branching
    // fixtures.
    const normalize = (p) => String(p).replace(/\\/g, "/");
    const isUnderSteamPz = (p) => normalize(p).startsWith("/steam/pz");

    vi.spyOn(fs, "statSync").mockImplementation((p) => {
      if (isUnderSteamPz(p)) return { isDirectory: () => true };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    vi.spyOn(fs, "existsSync").mockImplementation((p) => isUnderSteamPz(p));
    vi.spyOn(fs, "readdirSync").mockImplementation((p) =>
      normalize(p) === "/steam/pz" ? ["start-server.sh"] : [],
    );

    const results = scanAllCandidates();
    const steamPz = results.find((r) => r.installPath === "/steam/pz");
    expect(steamPz.status).toBe("ready");
    expect(results[0]).toBe(steamPz);
  });

  it("includes the new generic single-mount candidates (/data, /config, /serverfiles) that computeCandidateZomboidPaths-adjacent code did not previously know about", () => {
    const results = scanAllCandidates();
    const sources = results.map((r) => r.source);
    expect(sources).toContain("generic-single-mount");
    expect(results.filter((r) => r.source === "generic-single-mount")).toHaveLength(3);
  });
});

describe("isContainerized", () => {
  it("returns true when /.dockerenv exists", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((p) => p === "/.dockerenv");
    expect(isContainerized()).toBe(true);
  });

  it("returns false with no dockerenv marker and no docker cgroup entry", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readFileSync").mockReturnValue("0::/\n");
    expect(isContainerized()).toBe(false);
  });

  it("falls back to a cgroup scan for docker/containerd markers", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readFileSync").mockReturnValue("0::/docker/abc123\n");
    expect(isContainerized()).toBe(true);
  });
});
