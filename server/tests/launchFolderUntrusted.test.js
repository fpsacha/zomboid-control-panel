import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// SECURITY (2026-10-28): a MANAGED launch runs the launch folder's own
// jre64/bin/java(.exe), the classes and jars in its java/ folder and, when
// the panel can't rewrite it, the start script already there. RCE-STARTCMD
// made a start command or launcher script need files.manage, but
// servers.manage alone could still point a server's install folder at a
// Steam Workshop download (anyone who owns the game can publish an item
// with any files in it, and mods.manage downloads it) or at a Windows
// network share, then Start ran whatever that folder held. Both kinds of
// folder are refused now, at start, before a Restart stops anything, and
// when saved (launchTargetAdminOnly.test.js covers the route).
//
// Mocks only database/init.js and the logger, like
// launchTargetConfinement.test.js; startServer() is driven only down the
// refusal path, and no start script is put in the folder, so nothing can
// be launched even on the old code.

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer: (...args) => getActiveServer(...args),
  getServer: (...args) => getActiveServer(...args),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { ServerManager, findLaunchTargetRefusal, launchTargetOf, untrustedLaunchFolderReason } =
  await import("../services/serverManager.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

const isWindows = process.platform === "win32";

let root;
let installDir;
let workshopItemDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-launch-folder-"));
  installDir = path.join(root, "pz-install");
  // Where SteamCMD and the game put a downloaded Workshop item.
  workshopItemDir = path.join(installDir, "steamapps", "workshop", "content", "108600", "3000000001");
  fs.mkdirSync(path.join(workshopItemDir, "jre64", "bin"), { recursive: true });
  fs.writeFileSync(path.join(workshopItemDir, "jre64", "bin", isWindows ? "java.exe" : "java"), "");
});

afterEach(() => {
  getActiveServer.mockReset();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("untrustedLaunchFolderReason()", () => {
  it("accepts the game's own install folder", () => {
    expect(untrustedLaunchFolderReason(installDir)).toBeNull();
    expect(untrustedLaunchFolderReason("")).toBeNull();
    expect(untrustedLaunchFolderReason(undefined)).toBeNull();
  });

  it("refuses a Steam Workshop download folder, whatever its case or depth", () => {
    expect(untrustedLaunchFolderReason(workshopItemDir)).toBe("workshop");
    expect(untrustedLaunchFolderReason(path.join(installDir, "SteamApps", "Workshop"))).toBe("workshop");
    expect(untrustedLaunchFolderReason(path.join(workshopItemDir, "mods", "Evil"))).toBe("workshop");
    // A name that only contains the words is not the Workshop tree.
    expect(untrustedLaunchFolderReason(path.join(root, "mysteamapps", "workshops"))).toBeNull();
  });

  it("refuses a Workshop folder reached through `..` or a link to it (adversary pass)", () => {
    const dotted = `${path.join(workshopItemDir, "mods")}${path.sep}..`;
    expect(untrustedLaunchFolderReason(dotted)).toBe("workshop");
    const link = path.join(root, "innocent-looking");
    fs.symlinkSync(workshopItemDir, link, isWindows ? "junction" : "dir");
    expect(untrustedLaunchFolderReason(link)).toBe("workshop");
  });

  it.skipIf(!isWindows)("refuses a Workshop folder spelled through an NTFS stream name (adversary pass)", () => {
    // `dir::$INDEX_ALLOCATION` opens the folder itself, so the written form
    // hides the "workshop" segment; the real path doesn't.
    const disguised = path.join(installDir, "steamapps", "workshop::$INDEX_ALLOCATION", "content", "108600", "3000000001");
    expect(fs.statSync(disguised).isDirectory()).toBe(true);
    expect(untrustedLaunchFolderReason(disguised)).toBe("workshop");
  });

  it("refuses a Windows network share, typed with either slash", () => {
    expect(untrustedLaunchFolderReason("\\\\attacker\\share\\pz", { windows: true })).toBe("networkShare");
    expect(untrustedLaunchFolderReason("//attacker/share/pz", { windows: true })).toBe("networkShare");
    expect(untrustedLaunchFolderReason("  \\\\attacker\\share", { windows: true })).toBe("networkShare");
    expect(untrustedLaunchFolderReason("\\\\?\\UNC\\attacker\\share", { windows: true })).toBe("networkShare");
    expect(untrustedLaunchFolderReason("C:\\Games\\PZ Server", { windows: true })).toBeNull();
    // On Linux `//srv/pz` is just /srv/pz.
    expect(untrustedLaunchFolderReason("//srv/pz", { windows: false })).toBeNull();
  });
});

describe("findLaunchTargetRefusal() judges the launch folder", () => {
  it("refuses a managed server whose install or launch folder is a Workshop item", () => {
    expect(findLaunchTargetRefusal(launchTargetOf({ installPath: workshopItemDir }))).toEqual({
      folder: "workshop",
    });
    expect(
      findLaunchTargetRefusal(launchTargetOf({ installPath: installDir, serverPath: workshopItemDir })),
    ).toEqual({ folder: "workshop" });
    expect(findLaunchTargetRefusal(launchTargetOf({ installPath: installDir }))).toBeNull();
  });

  it("refuses a custom launcher that sits in a Workshop item", () => {
    const launcher = path.join(workshopItemDir, isWindows ? "run.bat" : "run.sh");
    fs.writeFileSync(launcher, "");
    expect(findLaunchTargetRefusal(launchTargetOf({ installPath: launcher }))).toEqual({
      folder: "workshop",
    });
  });
});

describe("startServer() and Restart refuse an untrusted launch folder", () => {
  const record = () => ({
    id: "ws1",
    serverName: "WorkshopHosted",
    installPath: workshopItemDir,
  });

  it("refuses to start a managed server from a Workshop item, launching nothing", async () => {
    getActiveServer.mockResolvedValue(record());
    const manager = new ServerManager();
    await expect(manager.startServer({ skipRunningCheck: true })).rejects.toMatchObject({
      code: ErrorCode.SERVER_LAUNCH_FOLDER_REFUSED,
      params: { reason: "workshop" },
    });
    expect(manager.serverProcess).toBeNull();
    expect(manager.isRunning).toBe(false);
    // Refused before the launch script is written into the folder.
    expect(fs.readdirSync(workshopItemDir).filter((name) => /\.(bat|sh)$/i.test(name))).toEqual([]);
  });

  it("calls a Restart off before it stops the server", async () => {
    getActiveServer.mockResolvedValue(record());
    const manager = new ServerManager();
    await expect(manager.assertNamedStartupScriptLaunchable({ serverId: "ws1" })).rejects.toMatchObject({
      code: ErrorCode.SERVER_LAUNCH_FOLDER_REFUSED,
    });
  });
});
