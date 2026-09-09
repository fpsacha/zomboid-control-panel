import { describe, expect, it } from 'vitest'
import {
  detectBridgeStaleness,
  getBridgeStalenessActionLabel,
  getBridgeStalenessBody,
  getBridgeStalenessTitle,
} from '../bridgeVersionStaleness'

// remote-bridge-version-staleness-is-never-surfaced-to-sftp-users: two
// signals GET /panel-bridge/status already computes (remoteBridgeVersionCheck
// / localInstall.needsUpdate, and modStatus.protocolVersionMismatch) had zero
// client readers. detectBridgeStaleness() is the one place that decides
// WHICH of the (up to three) possible signals wins when more than one is
// true at once -- these tests are about that priority decision and the
// per-case copy/action, not about rendering (Settings.bridgeStaleness
// .test.tsx covers the actual wiring into the page).

describe('detectBridgeStaleness', () => {
  it('returns null when the mod is not connected, even if every signal is true', () => {
    expect(
      detectBridgeStaleness({
        modConnected: false,
        modStatus: { protocolVersionMismatch: { expected: 'queue-v1', actual: 'queue-v2' } },
        remoteBridgeVersionCheck: { bundledVersion: '1.8.0', liveVersion: '1.7.0', behind: true },
      }),
    ).toBeNull()
  })

  it('returns null when nothing is stale', () => {
    expect(
      detectBridgeStaleness({
        modConnected: true,
        modStatus: {},
        localInstall: { needsUpdate: false, canAutoInstall: true, version: '1.8.0' },
      }),
    ).toBeNull()
  })

  it('prioritizes protocolVersionMismatch over a version-behind signal when both are true', () => {
    const info = detectBridgeStaleness({
      modConnected: true,
      modStatus: { protocolVersionMismatch: { expected: 'queue-v1', actual: 'queue-v2' } },
      localInstall: { needsUpdate: true, canAutoInstall: true, version: '1.7.0' },
    })
    expect(info).toEqual({ kind: 'protocolMismatch', expected: 'queue-v1', actual: 'queue-v2' })
  })

  it('falls back to remoteUpdateAvailable when there is no protocol mismatch', () => {
    const info = detectBridgeStaleness({
      modConnected: true,
      modStatus: {},
      remoteBridgeVersionCheck: { bundledVersion: '1.8.0', liveVersion: '1.7.0', behind: true },
    })
    expect(info).toEqual({ kind: 'remoteUpdateAvailable', liveVersion: '1.7.0', bundledVersion: '1.8.0' })
  })

  it('does not fire on remoteBridgeVersionCheck.behind === null (unknown, not behind)', () => {
    expect(
      detectBridgeStaleness({
        modConnected: true,
        modStatus: {},
        remoteBridgeVersionCheck: { bundledVersion: '1.8.0', liveVersion: null, behind: null },
      }),
    ).toBeNull()
  })

  it('falls back to localUpdateAvailable when there is no protocol mismatch or remote signal', () => {
    const info = detectBridgeStaleness({
      modConnected: true,
      modStatus: {},
      localInstall: { needsUpdate: true, canAutoInstall: false, version: '1.7.0' },
    })
    expect(info).toEqual({ kind: 'localUpdateAvailable', liveVersion: '1.7.0', canAutoInstall: false })
  })
})

describe('getBridgeStalenessActionLabel', () => {
  it('offers an action only for local + auto-installable (the one case with a real one-click fix)', () => {
    expect(
      getBridgeStalenessActionLabel({ kind: 'localUpdateAvailable', canAutoInstall: true }),
    ).not.toBeNull()
  })

  it('offers no action for local without write access -- there is no automated remedy to point a button at', () => {
    expect(
      getBridgeStalenessActionLabel({ kind: 'localUpdateAvailable', canAutoInstall: false }),
    ).toBeNull()
  })

  it('offers no action for a remote/SFTP server -- this panel cannot write to its filesystem', () => {
    expect(
      getBridgeStalenessActionLabel({ kind: 'remoteUpdateAvailable', liveVersion: '1.7.0', bundledVersion: '1.8.0' }),
    ).toBeNull()
  })

  it('offers no action for a protocol mismatch -- direction-agnostic, no single fix to trigger', () => {
    expect(
      getBridgeStalenessActionLabel({ kind: 'protocolMismatch', expected: 'queue-v1', actual: 'queue-v2' }),
    ).toBeNull()
  })
})

describe('getBridgeStalenessTitle / getBridgeStalenessBody -- every case has a non-empty title and a body that names a concrete next step', () => {
  const cases: Array<Parameters<typeof getBridgeStalenessTitle>[0]> = [
    { kind: 'protocolMismatch', expected: 'queue-v1', actual: 'queue-v2' },
    { kind: 'remoteUpdateAvailable', liveVersion: '1.7.0', bundledVersion: '1.8.0' },
    { kind: 'localUpdateAvailable', liveVersion: '1.7.0', canAutoInstall: false },
  ]

  it.each(cases)('$kind', (info) => {
    expect(getBridgeStalenessTitle(info).length).toBeGreaterThan(0)
    expect(getBridgeStalenessBody(info).length).toBeGreaterThan(0)
  })

  it('the remote body names the actual live and bundled versions, not a generic placeholder', () => {
    const body = getBridgeStalenessBody({ kind: 'remoteUpdateAvailable', liveVersion: '1.7.0', bundledVersion: '1.8.0' })
    expect(body).toContain('1.7.0')
    expect(body).toContain('1.8.0')
  })

  it('the protocol-mismatch body names both the expected and actual protocol strings', () => {
    const body = getBridgeStalenessBody({ kind: 'protocolMismatch', expected: 'queue-v1', actual: 'queue-v2' })
    expect(body).toContain('queue-v1')
    expect(body).toContain('queue-v2')
  })
})
