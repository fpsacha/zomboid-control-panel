import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// SECURITY (2026-10-28): the Steam branch a request names (POST /install,
// POST /steam-update) went to SteamCMD as the value after -beta with no
// check, and SteamCMD reads its own command line (quotes, +commands) by its
// own rules. Only a real branch name -- letters, digits, dots, dashes and
// underscores -- reaches SteamCMD now.

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

vi.mock("../database/init.js", () => ({
  getAllSettings: vi.fn(async () => ({})),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
}));

const { ErrorCode } = await import("../utils/errorCodes.js");
const { default: router, getBetaArgs, isValidSteamBranch } = await import("../routes/server.js");

const binaryName = process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh";

function createResponse() {
  const response = {};
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function lastHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

let root;
let steamcmdDir;

beforeEach(() => {
  spawnMock.mockReset();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-steam-branch-"));
  steamcmdDir = path.join(root, "steamcmd");
  fs.mkdirSync(steamcmdDir);
  fs.writeFileSync(path.join(steamcmdDir, binaryName), "");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function post(routePath, body) {
  const res = createResponse();
  await lastHandler(routePath, "post")({ body, app: { get: () => undefined } }, res);
  return res;
}

describe("Steam branch names", () => {
  it("accepts real branch names, Stable and the legacy flag", () => {
    for (const name of ["public", "stable", "unstable", "42.19", "legacy41", "iwillbackupmysave", "b41_multiplayer", "", undefined, true]) {
      expect(isValidSteamBranch(name)).toBe(true);
    }
    expect(getBetaArgs("42.19")).toEqual(["-beta", "42.19"]);
    expect(getBetaArgs("stable")).toEqual(["-beta", "public"]);
  });

  it("refuses anything that could reach SteamCMD as more than a branch name (adversary pass)", () => {
    for (const name of [
      "public +workshop_download_item 108600 1",
      '"public" +quit',
      "+runscript",
      "-betapassword",
      "x\ny",
      "a;b",
      "a b",
      "x".repeat(65),
      42,
      ["public"],
      { name: "public" },
    ]) {
      expect(isValidSteamBranch(name)).toBe(false);
    }
    expect(() => getBetaArgs("public +quit")).toThrow(/branch/i);
  });

  it("POST /install refuses a bad branch before SteamCMD runs", async () => {
    const res = await post("/install", {
      steamcmdPath: steamcmdDir,
      installPath: path.join(root, "pz"),
      serverName: "servertest",
      branch: "public +workshop_download_item 108600 1",
    });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe(ErrorCode.STEAM_BRANCH_INVALID);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("POST /steam-update refuses a bad branch before SteamCMD runs", async () => {
    const res = await post("/steam-update", {
      steamcmdPath: steamcmdDir,
      installPath: path.join(root, "pz"),
      branch: 'unstable" +quit "',
    });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe(ErrorCode.STEAM_BRANCH_INVALID);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
