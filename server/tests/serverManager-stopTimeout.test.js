import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import { ServerManager } from '../services/serverManager.js';

// Covers the fix for: _killPids()/_genericForceStop() (both used by
// stopServer()) had no timeout on their taskkill/kill/pkill exec calls,
// unlike the process-scan exec calls elsewhere in the same file. If the OS
// kill wedged (AV interference, a hung syscall), the exec callback never
// fired, so `await this._killPids(...)` never returned, so stopServer()'s
// `finally { this._stopping = false; }` never ran, so the server became
// permanently un-start/stop/restartable until the whole panel was
// restarted -- a permanent lie about transient state.
//
// The fix bounds every taskkill/kill/pkill exec call with the same timeout
// convention the process-scan calls already use, and surfaces to the
// caller (via a `{ timedOut }` result) when that's what happened, so
// stopServer() can report an honest "couldn't confirm" message instead of
// silently asserting "Server stopped" as fact.

function makeManager(overrides = {}) {
  const manager = new ServerManager();
  Object.assign(manager, { configLoaded: true, serverName: 'StopTimeoutTest' }, overrides);
  manager._confirmProcessStopped = vi.fn().mockResolvedValue(true);
  return manager;
}

describe('stopServer: kill timeout cannot leave the server permanently stuck', () => {
  it.runIf(process.platform !== 'win32')('also stops the tracked detached launcher process group', async () => {
    const manager = makeManager({
      serverProcess: { pid: 4241, killed: false, exitCode: null },
    });
    manager.getServerProcessDetails = async () => ({
      running: true,
      matched: [{ pid: '4242', cmd: 'java zombie.network.GameServer -servername StopTimeoutTest' }],
      owned: [{ pid: '4242', cmd: 'java zombie.network.GameServer -servername StopTimeoutTest' }],
      scanFailed: false,
    });
    const groupKill = vi
      .spyOn(manager, '_killProcessGroup')
      .mockReturnValue({ failed: false, errors: [] });
    manager._killPids = async () => ({ timedOut: false });

    await manager.stopServer();

    expect(groupKill).toHaveBeenCalledWith(4241);
  });

  it('simulates a kill that never returns on its own: _stopping still clears and the caller is told the confirmation timed out', async () => {
    const manager = makeManager();
    manager.getServerProcessDetails = async () => ({
      running: true,
      matched: [{ pid: '4242', cmd: 'java zombie.network.GameServer -servername StopTimeoutTest' }],
      owned: [{ pid: '4242', cmd: 'java zombie.network.GameServer -servername StopTimeoutTest' }],
      scanFailed: false,
    });
    // Simulates exactly what the exec-level timeout now guarantees: the
    // promise still resolves (unlike the old code, where a hung exec
    // callback meant this await never returned at all), but flags that it
    // had to give up waiting rather than confirming the kill.
    manager._killPids = async () => ({ timedOut: true });

    const result = await stopServerWithGuard(manager);

    expect(result.success).toBe(true);
    expect(result.message.toLowerCase()).toContain('timed out');
    // This is the exact condition startServer() gates on
    // (`if (this._stopping) throw ...`) -- proving it's false is proving
    // the operator is NOT locked out of starting/stopping/restarting.
    expect(manager._stopping).toBe(false);
  });

  it('does the same for the generic (detection-failed) fallback path', async () => {
    const manager = makeManager();
    manager.getServerProcessDetails = async () => ({
      running: false,
      matched: [],
      owned: [],
      scanFailed: true,
    });
    manager._isOnlyLocalServer = async () => true;
    manager._genericForceStop = async () => ({ timedOut: true });

    const result = await stopServerWithGuard(manager);

    expect(result.success).toBe(true);
    expect(result.message.toLowerCase()).toContain('timed out');
    expect(manager._stopping).toBe(false);
  });

  it('regression: a kill that finishes normally still reports plain success, unchanged from before', async () => {
    const manager = makeManager();
    manager.getServerProcessDetails = async () => ({
      running: true,
      matched: [{ pid: '4242', cmd: 'java zombie.network.GameServer -servername StopTimeoutTest' }],
      owned: [{ pid: '4242', cmd: 'java zombie.network.GameServer -servername StopTimeoutTest' }],
      scanFailed: false,
    });
    manager._killPids = async () => ({ timedOut: false });

    const result = await stopServerWithGuard(manager);

    expect(result).toEqual({ success: true, message: 'Server stopped' });
    expect(manager._stopping).toBe(false);
  });

  it('regression: the generic fallback still reports plain success when it finishes normally', async () => {
    const manager = makeManager();
    manager.getServerProcessDetails = async () => ({
      running: false,
      matched: [],
      owned: [],
      scanFailed: true,
    });
    manager._isOnlyLocalServer = async () => true;
    manager._genericForceStop = async () => ({ timedOut: false });

    const result = await stopServerWithGuard(manager);

    expect(result).toEqual({ success: true, message: 'Forced fallback kill executed' });
    expect(manager._stopping).toBe(false);
  });

  it('does not claim success when the post-kill process scan still sees the server', async () => {
    const manager = makeManager();
    manager.getServerProcessDetails = async () => ({
      running: true,
      matched: [{ pid: '4242', cmd: 'java zombie.network.GameServer -servername StopTimeoutTest' }],
      owned: [{ pid: '4242', cmd: 'java zombie.network.GameServer -servername StopTimeoutTest' }],
      scanFailed: false,
    });
    manager._killPids = async () => ({ timedOut: false });
    manager._confirmProcessStopped = vi.fn().mockResolvedValue(false);

    const result = await stopServerWithGuard(manager);

    expect(result.success).toBe(true);
    expect(result.confirmed).toBe(false);
    expect(result.message).toContain('still running');
    expect(manager._stopping).toBe(false);
  });
});

// Runs stopServer() under a hard test-level watchdog so a REGRESSION
// back to "the exec never calls back" hangs this test with a clear timeout
// failure instead of hanging the whole suite indefinitely.
async function stopServerWithGuard(manager) {
  return Promise.race([
    manager.stopServer(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('stopServer() did not return — _stopping would be stuck')), 2000),
    ),
  ]);
}

// Validates the actual platform contract the fix depends on, not just this
// codebase's own logic: Node's child_process timeout option really does
// abort a genuinely long-running child and invoke the callback with
// err.killed === true, rather than hanging forever. This is what makes
// checking `killErr.killed` in _killPids/_genericForceStop a safe way to
// tell "we gave up waiting" apart from an ordinary fast kill error like
// "process already exited".
describe('underlying platform contract: execFile timeout aborts a hung child', () => {
  it.runIf(process.platform === 'win32')(
    'on Windows, a slow command is aborted within the configured timeout and the callback fires with killed=true',
    async () => {
      const err = await new Promise((resolve) => {
        execFile(
          'powershell',
          ['-Command', 'Start-Sleep -Seconds 30'],
          { timeout: 300 },
          (execErr) => resolve(execErr),
        );
      });

      expect(err).toBeTruthy();
      expect(err.killed).toBe(true);
    },
    5000,
  );

  it.runIf(process.platform !== 'win32')(
    'on POSIX, a slow command is aborted within the configured timeout and the callback fires with killed=true',
    async () => {
      const err = await new Promise((resolve) => {
        execFile('sleep', ['30'], { timeout: 300 }, (execErr) => resolve(execErr));
      });

      expect(err).toBeTruthy();
      expect(err.killed).toBe(true);
    },
    5000,
  );
});
