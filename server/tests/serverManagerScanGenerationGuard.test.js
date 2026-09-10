import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// timeout-handling-consistency-sweep, 2026-09-10 (god's fix, generation-guard
// follow-up to the deferred-findings card): _scanDedicatedServerProcesses()'s
// outer guard (widened to 18000ms, see that function's own comment) races the
// real OS scan -- on the rare pathological-host path where the outer guard
// still wins, the real scan's callback can land LATER and unconditionally
// write this.isRunning, superseding whatever the caller already decided to
// do with the timeout's own scanFailed:true answer. Widening the timeout
// alone makes this rarer, not gone -- god's own framing, and the reason this
// file exists: the assertion that proves the MECHANISM (a late write is
// structurally refused), not just the margin (it happens less often).
//
// execFile mocked at module scope, matching serverManagerEmptyScanWindows.
// test.js's own established convention for this exact function.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: (...args) => execFileMock(...args) };
});

const { ServerManager } = await import('../services/serverManager.js');

// A real command line isWindowsDedicatedServerCommandLine recognizes (see
// serverManager.test.js's own "Java dedicated server launches" case), with
// no internal quotes so the CSV line below needs no escaping.
const MATCHING_CSV =
  '"ProcessId","CommandLine"\n"1234","java.exe -cp X zombie.network.GameServer -servername Test"';

describe('ServerManager._scanDedicatedServerProcesses: generation guard against a late-arriving scan callback', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.runIf(process.platform === 'win32')(
    "a scan callback that lands AFTER its own outer timeout already fired does NOT flip this.isRunning, even with a result that would otherwise report a running server",
    async () => {
      let capturedCallback;
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        // Never invoke synchronously -- simulates a hung/slow exec whose
        // real answer arrives only much later, after the scan itself has
        // already given up.
        capturedCallback = callback;
      });

      const manager = new ServerManager();
      manager.isRunning = false; // known baseline

      vi.useFakeTimers();
      const scanPromise = manager._scanDedicatedServerProcesses();

      await vi.advanceTimersByTimeAsync(18001); // past the 18000ms outer guard
      const timedOutResult = await scanPromise;
      expect(timedOutResult.scanFailed).toBe(true);
      expect(manager.isRunning).toBe(false);

      // The real OS call is still "in flight" underneath -- its callback
      // finally arrives now, well after the scan already resolved, carrying
      // a result that WOULD set isRunning=true if the write weren't guarded.
      expect(capturedCallback).toBeTypeOf('function');
      capturedCallback(null, MATCHING_CSV, '');

      // Still false: the generation guard recognized this attempt was
      // already superseded by its own timeout and refused the write.
      expect(manager.isRunning).toBe(false);
    },
  );

  it.runIf(process.platform === 'win32')(
    'a scan that completes before its own timeout still writes this.isRunning normally -- the guard does not break the common, fast path',
    async () => {
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callback(null, MATCHING_CSV, '');
      });

      const manager = new ServerManager();
      manager.isRunning = false;

      const result = await manager._scanDedicatedServerProcesses();

      expect(result.scanFailed).toBeFalsy();
      expect(result.running).toBe(true);
      expect(manager.isRunning).toBe(true);
    },
  );

  it.runIf(process.platform === 'win32')(
    'a NEWER scan call supersedes an older in-flight one -- the older scan\'s late callback does not overwrite what the newer scan already decided',
    async () => {
      let firstCallback;
      let callCount = 0;
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callCount += 1;
        if (callCount === 1) {
          firstCallback = callback; // first scan: held, never fires on its own
        } else {
          // second (newer) scan resolves immediately with a clean host
          callback(null, '', '');
        }
      });

      const manager = new ServerManager();
      manager.isRunning = true; // pretend a server was running before either scan

      const firstScanPromise = manager._scanDedicatedServerProcesses();
      // Start a second scan while the first is still "in flight" -- this
      // alone bumps the generation counter past the first scan's stamp.
      const secondResult = await manager._scanDedicatedServerProcesses();
      expect(secondResult.scanFailed).toBeFalsy();
      expect(manager.isRunning).toBe(false); // newer scan's real, current answer

      // The first scan's real (now stale) callback finally arrives, with a
      // result that would otherwise report a running server.
      expect(firstCallback).toBeTypeOf('function');
      firstCallback(null, MATCHING_CSV, '');

      // Must not resurrect the older scan's answer over the newer one's.
      expect(manager.isRunning).toBe(false);
      await firstScanPromise;
    },
  );
});
