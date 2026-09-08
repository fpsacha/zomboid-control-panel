import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// GH #147: a real user's Linux install failed with "Missing file
// permissions" (exit 8), and chmod'ing the GAME install directory only
// moved the error to "Missing configuration" rather than fixing it -- a
// permission change that moves the error is a sign the thing widened
// wasn't what SteamCMD was actually complaining about. His own log named
// the real target directly: `Redirecting stderr to
// '/home/pzuser/Steam/logs/stderr.txt'` -- SteamCMD resolves its OWN client
// state (login cache, depot/workshop staging, logs) from $HOME, entirely
// separate from wherever `+force_install_dir` points the actual game
// files. The panel's bundled systemd unit sandboxes the service with
// ProtectHome=read-only, which makes that $HOME write fail regardless of
// the game install directory's own filesystem permissions -- the install
// guide's existing "ReadWritePaths trap" section only ever covers the game
// install path, never SteamCMD's separate home-relative state.

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
}));

describe("buildLinuxSteamCmdEnv redirects SteamCMD's HOME away from the sandboxed real $HOME", () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steamcmd-home-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("sets HOME to a writable folder inside SteamCMD's own directory, not the real (possibly ProtectHome-sandboxed) $HOME", async () => {
    const { buildLinuxSteamCmdEnv } = await import("../routes/server.js");
    const steamcmdDir = path.join(tempRoot, "steamcmd");
    fs.mkdirSync(steamcmdDir, { recursive: true });

    const env = buildLinuxSteamCmdEnv(steamcmdDir);

    const expectedHome = path.join(steamcmdDir, ".steamhome");
    expect(env.HOME).toBe(expectedHome);
    expect(env.HOME).not.toBe(process.env.HOME);
    // Not just claimed -- the directory must actually exist for SteamCMD to
    // write into on its first launch.
    expect(fs.existsSync(expectedHome)).toBe(true);
    expect(fs.statSync(expectedHome).isDirectory()).toBe(true);
  });

  it("still builds the correct LD_LIBRARY_PATH for SteamCMD's bundled 32-bit libraries", async () => {
    const { buildLinuxSteamCmdEnv } = await import("../routes/server.js");
    const steamcmdDir = path.join(tempRoot, "steamcmd2");
    fs.mkdirSync(steamcmdDir, { recursive: true });

    const env = buildLinuxSteamCmdEnv(steamcmdDir);

    expect(env.LD_LIBRARY_PATH).toContain(path.join(steamcmdDir, "linux32"));
    expect(env.LD_LIBRARY_PATH).toContain(path.join(steamcmdDir, "linux64"));
    expect(env.LD_LIBRARY_PATH).toContain(steamcmdDir);
  });

  it("preserves every other inherited environment variable", async () => {
    const { buildLinuxSteamCmdEnv } = await import("../routes/server.js");
    const steamcmdDir = path.join(tempRoot, "steamcmd3");
    fs.mkdirSync(steamcmdDir, { recursive: true });

    const env = buildLinuxSteamCmdEnv(steamcmdDir);

    expect(env.PATH).toBe(process.env.PATH);
  });

  it("does not throw when the target directory can't be created -- SteamCMD still gets an env object to run with", async () => {
    const { buildLinuxSteamCmdEnv } = await import("../routes/server.js");
    const mkdirSpy = vi
      .spyOn(fs, "mkdirSync")
      .mockImplementation(() => {
        throw new Error("EACCES: permission denied");
      });

    let env;
    expect(() => {
      env = buildLinuxSteamCmdEnv(path.join(tempRoot, "unwritable"));
    }).not.toThrow();
    expect(env.HOME).toBe(path.join(tempRoot, "unwritable", ".steamhome"));

    mkdirSpy.mockRestore();
  });
});
