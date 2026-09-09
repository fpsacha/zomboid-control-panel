import { describe, it, expect, vi, beforeEach } from 'vitest';

// GH mod-settings-timeout investigation, 2026-09-08: processResult() found a
// matching pendingCommands entry, handled it, and otherwise did NOTHING --
// silently. A result that arrives for an id already deleted (its own
// setTimeout in sendCommand() fired first, rejected the caller with "no
// response from mod", and deleted the pendingCommands entry) vanished with
// zero trace, even on SUCCESS. panelBridge.test.js's cleanupResultTracking
// describe block already named this exact gap in its header comment ("a
// late-arriving real result finds no pending entry in processResult() and is
// silently dropped too") without a test proving it. This file is that test,
// for the fix that logs a warning instead of dropping silently.

const { warnCalls, mockLogger } = vi.hoisted(() => {
  const warnCalls = [];
  return {
    warnCalls,
    mockLogger: {
      info: () => {},
      warn: (msg) => warnCalls.push(msg),
      error: () => {},
      debug: () => {},
    },
  };
});

vi.mock('../utils/logger.js', () => ({
  createLogger: () => mockLogger,
}));

const { PanelBridge } = await import('../services/panelBridge.js');

beforeEach(() => {
  warnCalls.length = 0;
});

describe('PanelBridge processResult: orphaned results (no matching pendingCommands entry) are logged, not silently dropped', () => {
  it('logs a warning when a result arrives for an id with no pending entry (already timed out and deleted)', () => {
    const bridge = new PanelBridge();
    expect(bridge.pendingCommands.has('cmd-late')).toBe(false);

    bridge.processResult({
      id: 'cmd-late',
      success: true,
      data: { options: {}, groups: [], totalCount: 0, enumerated: true },
      timestamp: Date.now() - 5000,
    });

    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]).toMatch(/orphaned result/);
    expect(warnCalls[0]).toMatch(/cmd-late/);
    expect(warnCalls[0]).toMatch(/success=true/);
  });

  it('logs a warning for an orphaned FAILURE result too, not just success', () => {
    const bridge = new PanelBridge();

    bridge.processResult({
      id: 'cmd-late-fail',
      success: false,
      error: 'SandboxOptions not available',
      timestamp: Date.now() - 2000,
    });

    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]).toMatch(/orphaned result/);
    expect(warnCalls[0]).toMatch(/cmd-late-fail/);
    expect(warnCalls[0]).toMatch(/success=false/);
  });

  it('includes how late the result was when result.timestamp is present', () => {
    const bridge = new PanelBridge();
    const staleness = 12345;

    bridge.processResult({
      id: 'cmd-late-timed',
      success: true,
      data: {},
      timestamp: Date.now() - staleness,
    });

    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]).toMatch(/\d+ms/);
  });

  it('does NOT log an orphan warning when a matching pending entry exists (normal, on-time path)', () => {
    const bridge = new PanelBridge();
    const resolve = vi.fn();
    const reject = vi.fn();
    const timeout = setTimeout(() => {}, 10000);
    bridge.pendingCommands.set('cmd-1', {
      resolve, reject, timeout, action: 'ping', timestamp: Date.now(),
    });

    try {
      bridge.processResult({ id: 'cmd-1', success: true, data: { alive: true } });

      expect(resolve).toHaveBeenCalledWith({ success: true, data: { alive: true } });
      expect(warnCalls.length).toBe(0);
    } finally {
      clearTimeout(timeout);
    }
  });

  it('does NOT double-log for a duplicate/already-processed result id', () => {
    const bridge = new PanelBridge();

    bridge.processResult({ id: 'cmd-dup', success: true, data: {}, timestamp: Date.now() });
    expect(warnCalls.length).toBe(1);

    bridge.processResult({ id: 'cmd-dup', success: true, data: {}, timestamp: Date.now() });
    expect(warnCalls.length).toBe(1);
  });
});
