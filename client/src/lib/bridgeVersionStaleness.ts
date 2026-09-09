import { resolveRegisteredTranslation } from './paramTranslation'

// remote-bridge-version-staleness-is-never-surfaced-to-sftp-users (2026-09-09):
// two signals GET /panel-bridge/status already computes and forwards --
// modStatus.protocolVersionMismatch (Kevin's 71e45705) and
// remoteBridgeVersionCheck / localInstall.needsUpdate -- were read by
// nothing in client/src. Own file rather than client/src/lib/
// serverConfigSchema.ts (that module is a server-config SCHEMA already
// carrying one unrelated tenant of UI copy; this would have been a second).
//
// translatedOrFallback's own pattern (serverConfigSchema.ts), not a bare
// useTranslation() key: resolves a registered locale translation if one
// exists, else the plain-English string below, with zero locale-file
// change required to ship. Chosen specifically because a locale render
// pass can be in flight on any given night -- this way there is nothing
// in the nine locale JSON files for that work and this card to collide
// over, and localeParity.test.ts (which walks the locale JSON files
// directly via import.meta.glob, never resolveRegisteredTranslation
// calls) has no visibility into these keys either way.
function translatedOrFallback(key: string, fallback: string): string {
  return resolveRegisteredTranslation('settings', key, undefined) ?? fallback
}

export type BridgeStalenessKind = 'protocolMismatch' | 'localUpdateAvailable' | 'remoteUpdateAvailable'

export interface BridgeStalenessInfo {
  kind: BridgeStalenessKind
  /** protocolMismatch only */
  expected?: string
  actual?: string
  /** localUpdateAvailable / remoteUpdateAvailable */
  liveVersion?: string | null
  bundledVersion?: string | null
  /** localUpdateAvailable only -- whether the existing one-click fix applies */
  canAutoInstall?: boolean
}

interface BridgeStatusForStaleness {
  modConnected: boolean
  modStatus?: { protocolVersionMismatch?: { expected: string; actual: string } } | null
  localInstall?: { needsUpdate: boolean; canAutoInstall: boolean; version: string | null } | null
  remoteBridgeVersionCheck?: { bundledVersion: string | null; liveVersion: string | null; behind: boolean | null } | null
}

// Priority order, not two banners (per the card's own brief): a protocol
// mismatch is direction-agnostic and more likely to cause a silent
// wire-format failure than a plain version lag, and in practice the two
// will usually co-occur anyway (an old mod build carries an old protocol
// version too) -- showing both would almost always be the same underlying
// event said twice. Only evaluated while the mod is actually connected:
// this rides on the same status row that already shows the connected mod's
// version, and a disconnected/never-configured bridge has its own,
// unrelated messaging elsewhere on this page.
export function detectBridgeStaleness(status: BridgeStatusForStaleness | null | undefined): BridgeStalenessInfo | null {
  if (!status?.modConnected) return null

  const mismatch = status.modStatus?.protocolVersionMismatch
  if (mismatch) {
    return { kind: 'protocolMismatch', expected: mismatch.expected, actual: mismatch.actual }
  }

  if (status.remoteBridgeVersionCheck?.behind) {
    return {
      kind: 'remoteUpdateAvailable',
      liveVersion: status.remoteBridgeVersionCheck.liveVersion,
      bundledVersion: status.remoteBridgeVersionCheck.bundledVersion,
    }
  }

  if (status.localInstall?.needsUpdate) {
    return {
      kind: 'localUpdateAvailable',
      liveVersion: status.localInstall.version,
      canAutoInstall: status.localInstall.canAutoInstall,
    }
  }

  return null
}

export function getBridgeStalenessTitle(info: BridgeStalenessInfo): string {
  if (info.kind === 'protocolMismatch') {
    return translatedOrFallback('bridge.staleness.protocolMismatchTitle', "Panel and bridge mod don't match")
  }
  return translatedOrFallback('bridge.staleness.updateAvailableTitle', 'Bridge mod update available')
}

export function getBridgeStalenessBody(info: BridgeStalenessInfo): string {
  if (info.kind === 'protocolMismatch') {
    return resolveRegisteredTranslation('settings', 'bridge.staleness.protocolMismatchBody', {
      expected: info.expected ?? '',
      actual: info.actual ?? '',
    }) ??
      `This panel expects bridge protocol '${info.expected}', but the mod on your server reports '${info.actual}'. They ship as a matched pair, so some features may not work correctly until they're back in sync.`
  }

  if (info.kind === 'remoteUpdateAvailable') {
    return resolveRegisteredTranslation('settings', 'bridge.staleness.remoteUpdateBody', {
      liveVersion: info.liveVersion ?? '',
      bundledVersion: info.bundledVersion ?? '',
    }) ??
      `Your server is running bridge mod v${info.liveVersion}, older than the v${info.bundledVersion} this panel bundles. This panel can't update a remote/SFTP-managed server's files for you -- re-upload the updated PanelBridge.lua the same way you installed it.`
  }

  // localUpdateAvailable
  return resolveRegisteredTranslation('settings', 'bridge.staleness.localUpdateBody', {
    liveVersion: info.liveVersion ?? '',
  }) ??
    `The installed bridge mod (v${info.liveVersion}) is older than what this panel bundles.`
}

export function getBridgeStalenessActionLabel(info: BridgeStalenessInfo): string | null {
  // Only the local + auto-installable case has a real one-click fix today
  // (the existing handleAutoConfigure()/POST /auto-configure flow, which
  // genuinely re-copies the file -- see its own modUpdated response field).
  // Remote/SFTP and local-without-write-access have no automated remedy;
  // their body text points at the existing manual instructions instead of
  // offering a button that would do nothing.
  if (info.kind === 'localUpdateAvailable' && info.canAutoInstall) {
    return translatedOrFallback('bridge.staleness.updateNowButton', 'Update Now')
  }
  return null
}
