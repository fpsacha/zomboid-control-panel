import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  describeAutoStartFailure,
  describeAutoStartSuccess,
  startServerForAutoStart,
} from "../index.js";
import { prepareForLaunch } from "../services/lifecycleCoordinator.js";
import { managedStartupScriptName } from "../services/serverManager.js";

// GH #167: the boot auto-start ("Auto-start is enabled - starting PZ
// server...") called serverManager.startServer() directly and so differed
// from the dashboard's Start in more than the launch-target refresh (which
// now lives inside startServer() itself -- see launchTargetEveryStart.test.js):
// a Docker-managed server was never routed to Docker, a never-booted server
// with no admin password was launched into a stdin prompt, and a failure was
// logged as "Error during auto-start:" with nothing after it -- the logger
// drops a second string argument.

describe("startServerForAutoStart()", () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function launchers({ managed = { handled: false } } = {}) {
    return {
      runManaged: vi.fn(async () => managed),
      serverManagerInstance: {
        startServer: vi.fn(async () => ({ success: true, message: "started" })),
      },
    };
  }

  it("starts a native server through serverManager.startServer() for that server", async () => {
    const deps = launchers();
    const server = { id: "s1", serverName: "One", adminPassword: "pw" };

    const result = await startServerForAutoStart(server, deps);

    expect(deps.runManaged).toHaveBeenCalledWith("start", { serverId: "s1" });
    expect(deps.serverManagerInstance.startServer).toHaveBeenCalledWith({ serverId: "s1" });
    expect(result).toEqual({ success: true, message: "started" });
  });

  it("starts a Docker-managed server through Docker and never spawns a native one beside it", async () => {
    const deps = launchers({ managed: { handled: true, success: true, message: "Container starting" } });

    const result = await startServerForAutoStart({ id: "s1", dockerContainerName: "pz" }, deps);

    expect(result).toMatchObject({ success: true });
    expect(deps.serverManagerInstance.startServer).not.toHaveBeenCalled();
  });

  it("reports a failed Docker start as a failure with its reason", async () => {
    const deps = launchers({ managed: { handled: true, success: false, error: "no such container" } });

    const result = await startServerForAutoStart({ id: "s1" }, deps);

    expect(result).toEqual({ success: false, error: "no such container" });
    expect(deps.serverManagerInstance.startServer).not.toHaveBeenCalled();
  });

  it("refuses a never-booted server with no admin password, the same way the dashboard's Start does", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gh167-autostart-"));
    const deps = launchers();
    const server = {
      id: "s1",
      name: "Fresh",
      serverName: "Fresh",
      zomboidDataPath: root, // no Saves/Multiplayer/Fresh yet
      adminPassword: "",
    };

    const result = await startServerForAutoStart(server, deps);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/never started before and has no admin password/);
    expect(deps.serverManagerInstance.startServer).not.toHaveBeenCalled();
  });

  it("lets an already-booted server without an admin password start", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gh167-autostart-"));
    fs.mkdirSync(path.join(root, "Saves", "Multiplayer", "Booted"), { recursive: true });
    const deps = launchers();

    await startServerForAutoStart(
      { id: "s1", serverName: "Booted", zomboidDataPath: root, adminPassword: "" },
      deps,
    );

    expect(deps.serverManagerInstance.startServer).toHaveBeenCalled();
  });
});

// Every launch path's refresh -- dashboard Start, boot auto-start, scheduler,
// Discord, post-update, Docker -- rests on the one
// setLaunchTargetRefresher(refreshLaunchTargetForLaunch) call in
// server/index.js; the other tests wire the refresher themselves. So this
// runs the real before-launch step against the wiring index.js did when it
// was imported above. The record isn't in this file's database, so the
// refresher falls back to it as passed.
describe("server/index.js wires the launch-target refresh into prepareForLaunch()", () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("writes the server's current RCON password into its ini and its named script, with no other setup", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gh167-wiring-"));
    const installPath = path.join(root, "pz");
    const zomboidDataPath = path.join(root, "Zomboid");
    fs.mkdirSync(installPath, { recursive: true });
    fs.mkdirSync(path.join(zomboidDataPath, "Server"), { recursive: true });
    const iniPath = path.join(zomboidDataPath, "Server", "Wired.ini");
    fs.writeFileSync(iniPath, "RCONPort=27015\nRCONPassword=old-rcon\n");

    await prepareForLaunch({
      id: "gh167-wiring-not-in-db",
      name: "Wired",
      serverName: "Wired",
      installPath,
      zomboidDataPath,
      rconPassword: "new-rcon",
      rconPort: 27015,
      adminPassword: "admin-pw",
      isRemote: false,
    });

    expect(fs.readFileSync(iniPath, "utf8")).toContain("RCONPassword=new-rcon");
    const script = fs.readFileSync(path.join(installPath, managedStartupScriptName("Wired")), "utf8");
    // The named script is written from current settings; the admin password
    // reaches the game through the launch environment, never the file
    // (security audit R1-30/R1-35, services/adminPasswordLaunch.js).
    expect(script).toContain(process.platform === "win32" ? '-servername "Wired"' : "-servername 'Wired'");
    expect(script).not.toContain("admin-pw");
  });
});

describe("describeAutoStartFailure()", () => {
  it("keeps a thrown start error's whole message, including the game's own output tail", () => {
    const error = new Error(
      "Server process exited immediately after starting (code=1, signal=none) — startup failed.\n" +
        "User admin not found, creating it\njava.util.NoSuchElementException: No line found",
    );
    expect(describeAutoStartFailure(error)).toContain("NoSuchElementException: No line found");
    expect(describeAutoStartFailure(error)).toContain("code=1");
  });

  it("reads a { success: false } result's error", () => {
    expect(describeAutoStartFailure({ success: false, error: "Container start failed" })).toBe(
      "Container start failed",
    );
  });

  it("never comes back empty", () => {
    expect(describeAutoStartFailure(new Error(""))).toBe("no reason was given");
    expect(describeAutoStartFailure(undefined)).toBe("no reason was given");
    expect(describeAutoStartFailure("plain string")).toBe("plain string");
  });

  it("is what the auto-start's two failure lines interpolate -- one template string, not a second logger argument", () => {
    const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
    expect(source).toContain("log.error(`Error during auto-start: ${describeAutoStartFailure(e)}`)");
    expect(source).toMatch(/Failed to auto-start PZ server: \$\{describeAutoStartFailure\(startResult\)\}/);
    expect(source).not.toMatch(/log\.error\(\s*"Error during auto-start:",/);
  });
});

// A Docker-managed container that is already up when the panel boots:
// runManagedLifecycle("start") answers success with alreadyRunning and
// starts nothing, and the auto-start used to log "PZ server auto-started
// successfully" for it anyway.
describe("describeAutoStartSuccess()", () => {
  it("says a container that was already running was not started", async () => {
    const managed = {
      handled: true,
      success: true,
      alreadyRunning: true,
      message: "Container is already running",
    };
    const result = await startServerForAutoStart(
      { id: "s1", dockerContainerName: "pz" },
      {
        runManaged: vi.fn(async () => managed),
        serverManagerInstance: { startServer: vi.fn() },
      },
    );

    expect(describeAutoStartSuccess(result)).toBe(
      "PZ server container was already running - connecting RCON",
    );
    expect(describeAutoStartSuccess(result)).not.toMatch(/auto-started/);
  });

  it("says auto-started for a start that happened", () => {
    expect(describeAutoStartSuccess({ success: true, message: "started" })).toBe(
      "PZ server auto-started successfully",
    );
    expect(describeAutoStartSuccess({ handled: true, success: true })).toBe(
      "PZ server auto-started successfully",
    );
  });

  it("is what the auto-start's success line logs", () => {
    const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
    expect(source).toContain("log.info(describeAutoStartSuccess(startResult));");
    expect(source).not.toContain('log.info("PZ server auto-started successfully")');
  });
});
