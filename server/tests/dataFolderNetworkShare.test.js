import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// SECURITY (2026-10-28, R2-14): the data-folder rule
// (services/zomboidDataPath.js) took a Windows network share or device path
// as a server's Zomboid data folder and judged it on disk straight away, so
// a technician (servers.manage) made the panel's Windows account sign in to a
// host of their choosing, at save time and again at every use, a remote
// record's folder included (utils/serverConfigPath.js judges it here). A
// path like \\host\s\%VAR% also sent an environment variable's value to that
// host before the expansion refusal ran. Windows-only: on Linux //host/share
// is a local path.

const { checkZomboidDataPath, zomboidDataFolderHolds, zomboidFolderAround } = await import(
  "../services/zomboidDataPath.js"
);
const { resolveServerConfigDir } = await import("../utils/serverConfigPath.js");

const isNetworkPath = (p) => /^[\\/]{2}/.test(String(p));
let touched;

beforeEach(() => {
  touched = [];
  const guard = (name, real) =>
    vi.spyOn(fs, name).mockImplementation((p, ...rest) => {
      if (isNetworkPath(p)) {
        touched.push(`${name} ${p}`);
        const err = new Error("ENOENT (test: never really looked up)");
        err.code = "ENOENT";
        throw err;
      }
      return real(p, ...rest);
    });
  for (const name of ["statSync", "lstatSync", "readdirSync", "existsSync", "accessSync", "openSync"]) {
    guard(name, fs[name].bind(fs));
  }
  const realNative = fs.realpathSync.native.bind(fs);
  vi.spyOn(fs.realpathSync, "native").mockImplementation((p, ...rest) => {
    if (isNetworkPath(p)) {
      touched.push(`realpathSync.native ${p}`);
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    }
    return realNative(p, ...rest);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ZCP_SHARE_HOST;
  delete process.env.ZCP_SHARE_ROOT;
});

describe.skipIf(process.platform !== "win32")("a network share is never a server's data folder", () => {
  it("is refused when saved, before anything touches it", () => {
    for (const value of [
      "\\\\attacker\\share\\Zomboid",
      "//attacker/share/Zomboid",
      "\\\\?\\UNC\\attacker\\share\\Zomboid",
      "\\\\.\\pipe\\zomboid",
    ]) {
      const check = checkZomboidDataPath(value);
      expect(check.ok, value).toBe(false);
      expect(check.body.code).toBe("FOLDER_NETWORK_SHARE_REFUSED");
    }
    expect(touched).toEqual([]);
  });

  // Adversary pass: a network path built by an environment variable, in the
  // host name or as the whole root, so the typed value doesn't start with \\
  // or the expansion carries the value to the host.
  it("is refused when an environment variable builds it, and the value is never sent", () => {
    process.env.ZCP_SHARE_HOST = "secret-value";
    process.env.ZCP_SHARE_ROOT = "\\\\attacker\\share";
    for (const value of [
      "\\\\attacker\\s\\%ZCP_SHARE_HOST%",
      "\\\\%ZCP_SHARE_HOST%.attacker.example\\s",
      "%ZCP_SHARE_ROOT%\\Zomboid",
    ]) {
      const check = checkZomboidDataPath(value);
      expect(check.ok, value).toBe(false);
      expect(check.body.code).toBe("FOLDER_NETWORK_SHARE_REFUSED");
      expect(check.body.error).not.toContain("secret-value");
    }
    expect(touched).toEqual([]);
  });

  it("is refused where it is used, a remote record's folder included, without touching it", () => {
    expect(zomboidDataFolderHolds("\\\\attacker\\share\\Zomboid")).toBe(false);
    expect(zomboidFolderAround("\\\\attacker\\share\\Zomboid\\Saves\\Multiplayer")).toBeNull();
    expect(resolveServerConfigDir(null, "\\\\attacker\\share\\Zomboid")).toMatchObject({
      dir: null,
      refused: true,
      reason: "data-folder",
    });
    expect(touched).toEqual([]);
  });

  it("still takes a local folder, and the operator's own PZ_SAVE_PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-unc-data-"));
    const previous = process.env.PZ_SAVE_PATH;
    process.env.PZ_SAVE_PATH = "\\\\nas\\Zomboid";
    try {
      expect(checkZomboidDataPath(dir)).toEqual({ ok: true, path: dir });
      expect(zomboidDataFolderHolds(dir)).toBe(true);
      expect(zomboidDataFolderHolds("\\\\nas\\Zomboid")).toBe(true);
      expect(touched).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.PZ_SAVE_PATH;
      else process.env.PZ_SAVE_PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
