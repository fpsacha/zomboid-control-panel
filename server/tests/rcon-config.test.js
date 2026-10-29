import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Both defects here are the same shape as the startup fallback probe fixed in
// rcon-autoprobe.test.js, one layer deeper: RconService itself will happily
// fall back to the hardcoded default host/port (127.0.0.1:27015, empty
// password) whenever it can't fully resolve a configured server. That
// fallback is what the 60s auto-reconnect interval hits, forever, on a
// completely unconfigured install.

const getActiveServer = vi.fn();
const getServer = vi.fn();
const getSetting = vi.fn();
const logCommand = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getServer,
  getSetting,
  logCommand,
}));

const { RconService } = await import("../services/rcon.js");

function freshService() {
  const service = new RconService();
  // Constructor reads process.env.RCON_HOST/PORT/RCON_PASSWORD_FILE — pin to
  // known values so assertions aren't sensitive to the shell running the
  // suite happening to have one of those set.
  service.config = { host: "127.0.0.1", port: 27015, password: "" };
  service.passwordFromSecretFile = false;
  return service;
}

beforeEach(() => {
  getActiveServer.mockReset().mockResolvedValue(null);
  getServer.mockReset().mockResolvedValue(null);
  getSetting.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RconService.hasConfiguredTarget", () => {
  it("is false with no server row and no legacy global settings", async () => {
    const service = freshService();
    expect(await service.hasConfiguredTarget()).toBe(false);
  });

  it("is true when a server has been added, even with no RCON password", async () => {
    getActiveServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "10.20.30.40",
      rconPort: 27099,
      rconPassword: "",
    });
    const service = freshService();
    expect(await service.hasConfiguredTarget()).toBe(true);
  });

  it("is true from legacy global settings alone, with no server row (back-compat)", async () => {
    getSetting.mockImplementation(async (key) =>
      key === "rconHost" ? "legacy.example.com" : null,
    );
    const service = freshService();
    expect(await service.hasConfiguredTarget()).toBe(true);
  });
});

describe("RconService.loadConfig", () => {
  it("uses the active server's host, port and password when all are set", async () => {
    getActiveServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "10.20.30.40",
      rconPort: 27099,
      rconPassword: "correct-horse",
    });
    const service = freshService();
    await service.loadConfig();
    expect(service.config).toMatchObject({
      host: "10.20.30.40",
      port: 27099,
      password: "correct-horse",
    });
  });

  it("keeps the configured server's real host/port even with no RCON password set (the crack)", async () => {
    // A freshly added PZ server with no password yet is a completely normal
    // state. It must never look identical to "nothing configured at all".
    getActiveServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "10.20.30.40",
      rconPort: 27099,
      rconPassword: "",
    });
    const service = freshService();
    service.config.password = "stale-password-from-a-previous-server";
    await service.loadConfig();
    expect(service.config.host).toBe("10.20.30.40");
    expect(service.config.port).toBe(27099);
    // Doesn't silently keep authenticating as whatever this instance last
    // pointed at — an empty password is real state, not a value to inherit.
    expect(service.config.password).toBe("");
  });

  it("same crack, for a serverId-pinned lookup (Scheduler's throwaway instances)", async () => {
    getServer.mockResolvedValue({
      id: "srv-2",
      rconHost: "10.20.30.41",
      rconPort: 27100,
      rconPassword: "",
    });
    const service = freshService();
    await service.loadConfig("srv-2");
    expect(service.config.host).toBe("10.20.30.41");
    expect(service.config.port).toBe(27100);
    // continuous-bug-hunt round 22: this.serverId is the one thing
    // execute() reads to tag command_history with the REAL target, not
    // whatever getActiveServer() answers at log time.
    expect(service.serverId).toBe("srv-2");
  });

  // continuous-bug-hunt round 22 (closing round 21's own named limitation):
  // this.serverId must reflect the RESOLVED target, distinct from whatever
  // else happens to be active -- proven by pinning them to two DIFFERENT
  // servers in the same test, the exact shape scheduler.js's
  // _resolveServicesForTask() creates a throwaway instance for.
  it("tracks the pinned server's id even while a DIFFERENT server is the active one", async () => {
    getActiveServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "10.20.30.40",
      rconPort: 27099,
      rconPassword: "active-pw",
    });
    getServer.mockResolvedValue({
      id: "srv-2",
      rconHost: "10.20.30.41",
      rconPort: 27100,
      rconPassword: "target-pw",
    });
    const service = freshService();
    await service.loadConfig("srv-2");
    expect(service.serverId).toBe("srv-2");
    expect(service.config.password).toBe("target-pw");
  });

  it("tracks the active server's own id when no serverId is given (the shared singleton's normal case)", async () => {
    getActiveServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "10.20.30.40",
      rconPort: 27099,
      rconPassword: "correct-horse",
    });
    const service = freshService();
    await service.loadConfig();
    expect(service.serverId).toBe("srv-1");
  });

  it("still falls back to legacy global settings when there is no server row at all", async () => {
    getSetting.mockImplementation(async (key) => {
      if (key === "rconHost") return "legacy.example.com";
      if (key === "rconPort") return "27016";
      if (key === "rconPassword") return "legacy-pw";
      return null;
    });
    const service = freshService();
    await service.loadConfig();
    expect(service.config).toMatchObject({
      host: "legacy.example.com",
      port: 27016,
      password: "legacy-pw",
    });
  });

  it("does not truncate a malformed profile port into a different target", async () => {
    getActiveServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "10.20.30.40",
      rconPort: "27016junk",
      rconPassword: "correct-horse",
    });
    const service = freshService();
    service.checkPortOpen = vi.fn(async () => true);

    expect(await service.connect()).toBe(false);
    expect(service.config.port).toBeNull();
    expect(service.checkPortOpen).not.toHaveBeenCalled();
  });

  it("does not truncate a malformed legacy port into a different target", async () => {
    getSetting.mockImplementation(async (key) => {
      if (key === "rconHost") return "legacy.example.com";
      if (key === "rconPort") return "27016junk";
      return null;
    });
    const service = freshService();
    service.checkPortOpen = vi.fn(async () => true);

    expect(await service.connect()).toBe(false);
    expect(service.config.port).toBeNull();
    expect(service.checkPortOpen).not.toHaveBeenCalled();
  });

  it("a bad serverId lookup does NOT fall back to legacy/active settings (fails loudly instead)", async () => {
    getServer.mockResolvedValue(null);
    getSetting.mockImplementation(async (key) =>
      key === "rconHost" ? "should-not-be-used.example.com" : null,
    );
    const service = freshService();
    await service.loadConfig("does-not-exist");
    expect(service.config.host).toBe("127.0.0.1");
  });
});

describe("RconService auto-reconnect gate (connect/_doConnect)", () => {
  it("makes zero connection attempts when nothing has ever been configured", async () => {
    const service = freshService();
    const checkPortOpen = vi.fn(async () => true);
    service.checkPortOpen = checkPortOpen;

    const result = await service.connect();

    expect(result).toBe(false);
    expect(checkPortOpen).not.toHaveBeenCalled();
    // Config was never touched — still the untouched fixture default, not
    // silently marked "loaded".
    expect(service.configLoaded).toBe(false);
  });

  it("still probes a configured server whose process couldn't be detected (the case that must keep working)", async () => {
    getActiveServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "10.20.30.40",
      rconPort: 27099,
      rconPassword: "correct-horse",
    });
    const service = freshService();
    const checkPortOpen = vi.fn(async () => false); // port genuinely closed; we only need to prove it was asked, not fake a full RCON handshake
    service.checkPortOpen = checkPortOpen;

    const result = await service.connect();

    expect(result).toBe(false);
    expect(checkPortOpen).toHaveBeenCalledTimes(1);
    expect(checkPortOpen).toHaveBeenCalledWith("10.20.30.40", 27099);
  });

  it("adapts within one reconnect attempt after a server is added mid-run, without a restart", async () => {
    const service = freshService();
    const checkPortOpen = vi.fn(async () => false);
    service.checkPortOpen = checkPortOpen;

    // Tick 1: still unconfigured.
    expect(await service.connect()).toBe(false);
    expect(checkPortOpen).not.toHaveBeenCalled();

    // Operator adds a server while the panel keeps running.
    getActiveServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "10.20.30.40",
      rconPort: 27099,
      rconPassword: "correct-horse",
    });

    // Tick 2 (the next 60s auto-reconnect attempt): no restart, no explicit
    // reloadConfig() call from this test — hasConfiguredTarget() is checked
    // fresh every attempt, so it's picked up immediately.
    expect(await service.connect()).toBe(false); // port still reported closed
    expect(checkPortOpen).toHaveBeenCalledWith("10.20.30.40", 27099);
  });
});

// continuous-bug-hunt round 22 (scheduled tasks tag logs with the wrong
// server): a scheduled task targeting a server OTHER than the active one
// runs through a THROWAWAY RconService instance (scheduler.js's
// _resolveServicesForTask()), pinned via loadConfig(task.server_id) -- but
// execute() used to call database/init.js's logCommand() with no server
// identity at all, so command_history tagged every entry with
// getActiveServerId() (whatever's active AT LOG TIME), not the task's real
// target. execute() now passes this.serverId (set for real by
// loadConfig(), see that method's own comment) explicitly. These tests
// call the REAL execute() (not a stub), with only the lowest-level
// this.client.execute() faked, so the actual command -> logCommand wiring
// this round fixed is genuinely exercised end to end.
describe("RconService.execute() tags command_history with the REAL target server, not whatever is active", () => {
  it("passes the pinned server's id, not the currently-active one, to logCommand", async () => {
    getActiveServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "10.20.30.40",
      rconPort: 27099,
      rconPassword: "active-pw",
    });
    getServer.mockResolvedValue({
      id: "srv-2",
      rconHost: "10.20.30.41",
      rconPort: 27100,
      rconPassword: "target-pw",
    });
    const service = freshService();
    await service.loadConfig("srv-2"); // the task's real target, not the active server
    service.connected = true;
    service.client = {
      connected: true,
      execute: vi.fn().mockResolvedValue("2 players connected"),
    };

    logCommand.mockClear();
    const result = await service.execute("players");

    expect(result.success).toBe(true);
    expect(logCommand).toHaveBeenCalledWith(
      "players",
      "2 players connected",
      true,
      "srv-2",
    );
  });

  it("passes the active server's own id for the shared singleton's ordinary case (no explicit target)", async () => {
    getActiveServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "10.20.30.40",
      rconPort: 27099,
      rconPassword: "correct-horse",
    });
    const service = freshService();
    await service.loadConfig();
    service.connected = true;
    service.client = {
      connected: true,
      execute: vi.fn().mockResolvedValue("saved"),
    };

    logCommand.mockClear();
    await service.execute("save");

    expect(logCommand).toHaveBeenCalledWith("save", "saved", true, "srv-1");
  });
});

// SECURITY (audit R1-6): with RCON_PASSWORD_FILE set, loadConfig() used to
// keep the file's password whatever host the server record named, so a
// record pointed at another host (or a "retyped" dummy password for it) sent
// the secret there. The secret now only goes to this machine or RCON_HOST.
describe("RconService.loadConfig with RCON_PASSWORD_FILE", () => {
  const savedEnv = {};
  let secretPath;

  beforeEach(() => {
    for (const key of ["RCON_PASSWORD_FILE", "RCON_HOST", "RCON_PORT"]) {
      savedEnv[key] = process.env[key];
    }
    secretPath = path.join(
      os.tmpdir(),
      `zcp-rcon-secret-${process.pid}-${Date.now()}.txt`,
    );
    fs.writeFileSync(secretPath, "file-secret\n");
    process.env.RCON_PASSWORD_FILE = secretPath;
    process.env.RCON_HOST = "pz-game";
    delete process.env.RCON_PORT;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(secretPath, { force: true });
  });

  it("never sends the secret to a host a server record names", async () => {
    getServer.mockResolvedValue({
      id: "srv-9",
      rconHost: "203.0.113.5",
      rconPort: 27015,
      rconPassword: "typed-for-this-host",
    });
    const service = new RconService();
    await service.loadConfig("srv-9");
    expect(service.config.host).toBe("203.0.113.5");
    expect(service.config.password).toBe("typed-for-this-host");
  });

  it("does not keep the secret for a record with no password of its own", async () => {
    getActiveServer.mockResolvedValue({
      id: "srv-9",
      rconHost: "attacker.example",
      rconPort: 27015,
      rconPassword: "",
    });
    const service = new RconService();
    await service.loadConfig();
    expect(service.config.password).toBe("");
  });

  it("still uses the secret for this machine and RCON_HOST, on any port", async () => {
    for (const rconHost of ["127.0.0.1", " localhost ", "PZ-GAME", "::1"]) {
      getServer.mockResolvedValue({
        id: "srv-1",
        rconHost,
        rconPort: 27016,
        rconPassword: "stored-value",
      });
      const service = new RconService();
      await service.loadConfig("srv-1");
      expect(service.config.password).toBe("file-secret");
    }
  });

  it("goes back to the secret after switching from a remote record to a local one", async () => {
    getActiveServer.mockResolvedValue({
      id: "srv-9",
      rconHost: "203.0.113.5",
      rconPort: 27015,
      rconPassword: "remote-pw",
    });
    const service = new RconService();
    await service.loadConfig();
    expect(service.config.password).toBe("remote-pw");
    getActiveServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "127.0.0.1",
      rconPort: 27015,
      rconPassword: "remote-pw",
    });
    await service.reloadConfig();
    expect(service.config.password).toBe("file-secret");
  });

  // Adversary pass: look-alike hosts that start or end like a local one.
  it("treats look-alike hosts as other hosts", async () => {
    for (const rconHost of [
      "127.0.0.1.attacker.example",
      "localhost.attacker.example",
      "pz-game.attacker.example",
      "0.0.0.0",
    ]) {
      getServer.mockResolvedValue({
        id: "srv-9",
        rconHost,
        rconPort: 27015,
        rconPassword: "own-pw",
      });
      const service = new RconService();
      await service.loadConfig("srv-9");
      expect(service.config.password).toBe("own-pw");
    }
  });

  it("applies the same rule to legacy global settings", async () => {
    getSetting.mockImplementation(async (key) =>
      key === "rconHost"
        ? "198.51.100.7"
        : key === "rconPassword"
          ? "legacy-pw"
          : null,
    );
    const service = new RconService();
    await service.loadConfig();
    expect(service.config.host).toBe("198.51.100.7");
    expect(service.config.password).toBe("legacy-pw");
  });
});
