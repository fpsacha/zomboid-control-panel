import { describe, expect, it, vi } from 'vitest';
import {
  classifyProcessKillError,
  isWindowsDedicatedServerCommandLine,
  scoreServerProcessOwnership,
  resolveConfiguredRconPort,
  ServerManager,
} from '../services/serverManager.js';

describe('ServerManager Windows detection', () => {
  it('should recognize WinGSM-style ProjectZomboid server launches', () => {
    const commandLine = '"C:\\WinGSM\\servers\\1\\serverfiles\\ProjectZomboid64.exe" -cachedir="C:\\WinGSM\\servers\\1\\Zomboid" -servername WheelerZoidB42';

    expect(isWindowsDedicatedServerCommandLine(commandLine)).toBe(true);
  });

  it('should recognize Java dedicated server launches', () => {
    const commandLine = '"C:\\serverfiles\\jre64\\bin\\java.exe" -cp %PZ_CLASSPATH% zombie.network.GameServer -servername WheelerZoidB42';

    expect(isWindowsDedicatedServerCommandLine(commandLine)).toBe(true);
  });

  it('should ignore plain client launches without dedicated-server markers', () => {
    const commandLine = '"C:\\Games\\ProjectZomboid\\ProjectZomboid64.exe"';

    expect(isWindowsDedicatedServerCommandLine(commandLine)).toBe(false);
  });
});

describe('ServerManager RCON port resolution', () => {
  it('rejects malformed persisted ports instead of truncating them', () => {
    expect(resolveConfiguredRconPort('27016junk')).toBeNull();
  });

  it('uses the default only when no port was configured', () => {
    expect(resolveConfiguredRconPort(undefined)).toBe(27015);
    expect(resolveConfiguredRconPort('27016')).toBe(27016);
  });
});

describe('ServerManager process ownership', () => {
  const serverA = {
    serverName: 'ServerA',
    savePath: 'C:\\Zomboid\\A',
    serverPath: 'C:\\pz\\a',
  };

  it('claims a process launched with its own -servername', () => {
    const commandLine =
      '"C:\\pz\\a\\jre64\\bin\\java.exe" -cp pz.jar zombie.network.GameServer -servername "ServerA" -cachedir="C:\\Zomboid\\A"';

    expect(scoreServerProcessOwnership(commandLine, serverA)).toBeGreaterThan(0);
  });

  it('disowns a process launched with a different -servername', () => {
    const commandLine =
      '"C:\\pz\\b\\jre64\\bin\\java.exe" -cp pz.jar zombie.network.GameServer -servername "ServerB" -cachedir="C:\\Zomboid\\B"';

    expect(scoreServerProcessOwnership(commandLine, serverA)).toBe(-1);
  });

  it('disowns a process whose -cachedir points at another save folder', () => {
    const commandLine =
      'java zombie.network.GameServer -servername ServerA -cachedir="C:\\Zomboid\\B"';

    expect(scoreServerProcessOwnership(commandLine, serverA)).toBe(-1);
  });

  it('claims a process by install path when no -servername is present', () => {
    const commandLine =
      '"C:\\pz\\a\\jre64\\bin\\java.exe" -cp pz.jar zombie.network.GameServer';

    expect(scoreServerProcessOwnership(commandLine, serverA)).toBeGreaterThan(0);
  });

  it('leaves an unidentifiable stock launch unattributed', () => {
    const commandLine =
      '.\\jre64\\bin\\java.exe -Djava.library.path=natives/ -cp java/. zombie.network.GameServer';

    expect(scoreServerProcessOwnership(commandLine, serverA)).toBe(0);
  });

  it('does not claim a sibling install whose name is a prefix of its own (no -servername present)', () => {
    // serverA.serverPath is "C:\pz\a" -- a naive substring check on the
    // normalized path would also match "C:\pz\ab", a real, different,
    // sibling server folder that merely starts with the same characters.
    const commandLine =
      '"C:\\pz\\ab\\jre64\\bin\\java.exe" -cp pz.jar zombie.network.GameServer';

    expect(scoreServerProcessOwnership(commandLine, serverA)).toBe(0);
  });

  it('still claims its own install path when followed by a real path separator or end of string', () => {
    const trailingSlash =
      '"C:\\pz\\a/jre64/bin/java.exe" -cp pz.jar zombie.network.GameServer';
    const exactEnd = 'java -cp pz.jar zombie.network.GameServer -installdir "C:\\pz\\a"';

    expect(scoreServerProcessOwnership(trailingSlash, serverA)).toBeGreaterThan(0);
    expect(scoreServerProcessOwnership(exactEnd, serverA)).toBeGreaterThan(0);
  });
});

describe('ServerManager detection with two servers on one host', () => {
  // Only Server A is running.
  const running = [
    {
      pid: '111',
      cmd: 'java zombie.network.GameServer -servername "ServerA" -cachedir="C:\\Zomboid\\A"',
    },
  ];

  const makeManager = (config) => {
    const manager = new ServerManager();
    Object.assign(manager, config, { configLoaded: true });
    manager._scanDedicatedServerProcesses = async () => ({
      running: running.length > 0,
      matched: running,
    });
    return manager;
  };

  it('does not report Server B as running while only Server A is up', async () => {
    const serverB = makeManager({
      serverName: 'ServerB',
      savePath: 'C:\\Zomboid\\B',
      serverPath: 'C:\\pz\\b',
    });

    expect(await serverB.checkServerRunning()).toBe(false);
  });

  it('reports Server A as running and owning only its own PID', async () => {
    const serverA = makeManager({
      serverName: 'ServerA',
      savePath: 'C:\\Zomboid\\A',
      serverPath: 'C:\\pz\\a',
    });

    const details = await serverA.getServerProcessDetails();
    expect(details.running).toBe(true);
    expect(details.owned.map((entry) => entry.pid)).toEqual(['111']);
  });
});

describe('ServerManager status state', () => {
  it('classifies kill command outcomes without treating real errors as success', () => {
    expect(classifyProcessKillError({ killed: true })).toBe('timedOut');
    expect(classifyProcessKillError({ code: 'ESRCH', message: 'No such process' })).toBe('alreadyGone');
    expect(classifyProcessKillError({ code: 'EACCES', message: 'Permission denied' })).toBe('failed');
  });

  it('refuses to start when process detection cannot confirm the server is stopped', async () => {
    const manager = new ServerManager();
    manager.configLoaded = true;
    manager.serverPath = 'C:\\pz';
    manager.loadConfig = async () => {};
    manager.getServerProcessDetails = async () => ({
      running: false,
      scanFailed: true,
    });

    await expect(manager.startServer()).rejects.toThrow(/process detection failed/i);
  });

  it('refuses to restart when post-quit process detection cannot confirm the old server stopped', async () => {
    const manager = new ServerManager();
    manager.sleep = async () => {};
    manager.getServerProcessDetails = async () => ({
      running: false,
      scanFailed: true,
    });
    const rconService = {
      serverMessage: async () => ({ success: true }),
      save: async () => ({ success: true }),
      quit: async () => ({ success: true }),
    };

    await expect(manager.restartServer(rconService, 0)).rejects.toThrow(
      /old server stopped.*process detection failed/i,
    );
  });

  it('does not quit or restart when the pre-restart save reports failure', async () => {
    const manager = new ServerManager();
    manager.sleep = async () => {};
    const quit = vi.fn(async () => ({ success: true }));
    const startServer = vi.fn();
    manager.getServerProcessDetails = async () => ({
      running: true,
      scanFailed: false,
    });
    manager.startServer = startServer;
    const rconService = {
      serverMessage: async () => ({ success: true }),
      save: async () => ({ success: false, error: "disk full" }),
      quit,
    };

    await expect(manager.restartServer(rconService, 0)).rejects.toThrow(
      /Save before restart failed.*disk full/i,
    );
    expect(quit).not.toHaveBeenCalled();
    expect(startServer).not.toHaveBeenCalled();
  });

  it('does not report a force stop as successful when kill confirmation times out', async () => {
    const manager = new ServerManager();
    manager.serverName = 'ServerA';
    manager.configLoaded = true;
    manager.getServerProcessDetails = async () => ({
      owned: [{ pid: '111' }],
      scanFailed: false,
    });
    manager._killPids = async () => ({ timedOut: true });

    const result = await manager.stopServer();

    expect(result).toMatchObject({
      success: true,
      confirmed: false,
      timedOut: true,
    });
  });

  it('a bare stopServer() call with no arguments performs a real stop, not a no-op success', async () => {
    // Regression guard for the removed `graceful = true` default: stopServer()
    // used to take a boolean whose default skipped every check below and
    // returned {success:true} without killing anything or confirming
    // anything -- reachable via exactly this call shape, `stopServer()` with
    // no arguments, which reads like "stop the server" and used to do
    // nothing. Every real call site already passed `false` explicitly, so
    // the parameter was deleted rather than documented; this proves the
    // bare call now goes through the genuine kill path.
    const manager = new ServerManager();
    manager.serverName = 'ServerA';
    manager.configLoaded = true;
    manager.getServerProcessDetails = async () => ({
      owned: [{ pid: '111' }],
      scanFailed: false,
    });
    const killPids = vi.fn(async () => ({ timedOut: false, failed: false, errors: [] }));
    manager._killPids = killPids;
    manager._confirmProcessStopped = async () => true;

    const result = await manager.stopServer();

    expect(killPids).toHaveBeenCalledWith(['111']);
    expect(result).toMatchObject({ success: true });
    expect(manager.isRunning).toBe(false);
  });

  it('clears tracked process state when a graceful stop is accepted', () => {
    const manager = new ServerManager();
    manager.isRunning = true;
    manager.serverProcess = { pid: 1234 };
    manager.startTime = new Date();

    manager.markServerStopped();

    expect(manager.isRunning).toBe(false);
    expect(manager.serverProcess).toBeNull();
    expect(manager.startTime).toBeNull();
  });

  it('clears stale uptime after a confirmed stop', async () => {
    const manager = new ServerManager();
    manager.configLoaded = true;
    manager.configLoadedFor = null;
    manager.fetchingIp = true;
    manager.gamePort = 16261;
    manager.serverPath = 'C:\\pz';
    manager.startTime = new Date(Date.now() - 60_000);
    manager.loadConfig = async () => {};
    manager.getLocalIp = async () => null;
    manager.getServerProcessDetails = async () => ({
      running: false,
      matched: [],
      scanFailed: false,
    });

    const status = await manager.getServerStatus();

    expect(status.running).toBe(false);
    expect(status.startTime).toBeNull();
    expect(status.uptime).toBe(0);
  });

  it('does not corrupt the tracked running state when a scan fails to determine anything', async () => {
    // Regression: getServerProcessDetails() unconditionally set
    // `this.isRunning = resolved.length > 0` after every scan, including a
    // failed one (scan.matched is always [] on failure, so resolved.length
    // is always 0) -- silently latching a confident "not running" onto the
    // one cached field other code paths (server/routes/serverStatus.js, the
    // dashboard's host signal) trust directly, even though the scan itself
    // could not tell. A server that WAS running a moment ago looked
    // confidently stopped the instant detection started failing.
    const manager = new ServerManager();
    manager.configLoaded = true;
    manager.isRunning = true; // last known state, from a scan that succeeded
    manager._scanDedicatedServerProcesses = async () => ({
      running: false,
      matched: [],
      scanFailed: true,
    });

    const details = await manager.getServerProcessDetails();

    expect(details.scanFailed).toBe(true);
    expect(manager.isRunning).toBe(true);
  });

  it('surfaces scanFailed so callers can tell a failed scan from a confirmed stop', async () => {
    // Regression: getServerStatus() used to compute scanFailed internally
    // (to decide whether to clear run state) but never include it in the
    // object returned to callers -- so a hung/erroring process scan looked
    // identical to a real "server is stopped" to every consumer of /status.
    const manager = new ServerManager();
    manager.configLoaded = true;
    manager.configLoadedFor = null;
    manager.fetchingIp = true;
    manager.gamePort = 16261;
    manager.serverPath = 'C:\\pz';
    manager.startTime = new Date(Date.now() - 60_000);
    manager.loadConfig = async () => {};
    manager.getLocalIp = async () => null;
    manager.getServerProcessDetails = async () => ({
      running: false,
      matched: [],
      scanFailed: true,
    });

    const status = await manager.getServerStatus();

    expect(status.running).toBe(false);
    expect(status.scanFailed).toBe(true);
    // A failed scan must not be treated as a confirmed stop: startTime is
    // preserved rather than wiped, matching the existing _clearRunState guard.
    expect(status.startTime).not.toBeNull();
  });
});
