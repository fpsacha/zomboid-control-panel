import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import Settings from '../Settings'
import { configApi, panelUpdateApi, systemApi } from '@/lib/api'
import { resetRuntimeInfoForTests } from '@/hooks/useRuntimeInfo'

// 2026-09-08, god-dispatched updater-UI-surfacing audit, mechanical half of
// findings B and C (see kevin's outbox report + god's follow-up approving
// the two fixes below):
//
// B: no_helper_log's hint text ("...Check Windows Defender protection
// history") is Windows-specific wording, but the branch previously had no
// runtimeInfo?.family gate -- unlike every sibling cause (av_quarantine,
// rename_locked is the one exception, helper_blocked, rollback_failed) that
// already restricts itself to Windows. Worse: readMostRecentApplyLog() on
// the server has no platform check either, so no_helper_log is the ONLY
// likelyCause value that can ever fire on a non-Windows apply failure --
// meaning a Linux/Mac operator's one possible message was unconditionally
// wrong-platform advice. Fix applies the same convention its siblings
// already use; posix-specific wording is deliberately NOT authored here
// (still the operator's call) -- non-Windows now renders nothing extra,
// same as e.g. av_quarantine already does off-Windows.
//
// C: likelyCause 'unknown' -- the fallback for any log classifyApplyFailure
// can't recognize, including the four already-documented-but-unmapped
// Supervisor v2 codes (see that function's own comment) -- had NO ui branch
// at all: total silence, identical to a total mystery. Fix adds a minimal,
// platform-agnostic hint pointing at the Refresh Log / Show Helper Log
// controls that already exist on the same card, strictly more true than
// nothing and not gated to any one platform since 'unknown' is reachable
// everywhere.

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
    panelUpdateApi: {
      ...actual.panelUpdateApi,
      getStatus: vi.fn(),
      preflight: vi.fn(),
    },
    systemApi: { ...actual.systemApi, getRuntime: vi.fn() },
  }
})

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

const getAppSettings = vi.mocked(configApi.getAppSettings)
const getStatus = vi.mocked(panelUpdateApi.getStatus)
const preflight = vi.mocked(panelUpdateApi.preflight)
const getRuntime = vi.mocked(systemApi.getRuntime)

function renderSettings(socket: Socket) {
  return render(
    <MemoryRouter initialEntries={['/settings?tab=updates']}>
      <SocketContext.Provider value={socket}>
        <TooltipProvider>
          <Settings />
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

function fakeSocket(): Socket {
  return {
    connected: true,
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  } as unknown as Socket
}

function statusWithApplyResult(lastApplyResult: Record<string, unknown>) {
  return {
    currentVersion: '1.2.14', updateAvailable: true, latestVersion: '1.2.15',
    releaseUrl: null, releaseNotes: null, publishedAt: null,
    isChecking: false, isDownloading: false, downloadProgress: 0,
    lastCheck: null, lastError: null, updateMode: 'direct',
    stagedUpdate: null,
    lastApplyResult,
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  resetRuntimeInfoForTests()
})

describe('Settings.tsx: no_helper_log is now Windows-gated like its siblings', () => {
  it('on Windows, shows the Windows-specific hint', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    preflight.mockResolvedValue({
      ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [],
      info: { isPackaged: true, platform: 'win32', updateMode: 'direct', restartAssessment: { gameServers: 'preserved', requiresConfirmation: false }, temporaryDirectory: 'C:/tmp', applyLogPath: 'C:/tmp/log.txt' },
    })
    getRuntime.mockResolvedValue({
      platform: 'win32', family: 'windows', pathSeparator: '\\',
      temporaryDirectory: 'C:/tmp', serviceManager: 'none',
      restartAssessment: { gameServers: 'preserved', requiresConfirmation: false },
    })
    getStatus.mockResolvedValue(
      statusWithApplyResult({
        status: 'failed', pendingVersion: '1.2.15', currentVersion: '1.2.14',
        at: new Date().toISOString(), stagedStillPresent: false,
        helperLog: null, likelyCause: 'no_helper_log',
        canRetryApply: false, panelFolder: 'C:/panel',
      }),
    )

    renderSettings(fakeSocket())

    await screen.findByText(/no helper log was written/i)
    expect(screen.getByText(/windows defender protection history/i)).toBeInTheDocument()
  })

  it('on a non-Windows runtime, no_helper_log renders nothing extra (falls through to the generic header)', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    preflight.mockResolvedValue({
      ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [],
      info: { isPackaged: true, platform: 'linux', updateMode: 'direct', restartAssessment: { gameServers: 'preserved', requiresConfirmation: false }, temporaryDirectory: '/tmp', applyLogPath: '/tmp/log.txt' },
    })
    getRuntime.mockResolvedValue({
      platform: 'linux', family: 'posix', pathSeparator: '/',
      temporaryDirectory: '/tmp', serviceManager: 'systemd',
      restartAssessment: { gameServers: 'preserved', requiresConfirmation: false },
    })
    getStatus.mockResolvedValue(
      statusWithApplyResult({
        status: 'failed', pendingVersion: '1.2.15', currentVersion: '1.2.14',
        at: new Date().toISOString(), stagedStillPresent: false,
        helperLog: null, likelyCause: 'no_helper_log',
        canRetryApply: false, panelFolder: '/opt/panel',
      }),
    )

    renderSettings(fakeSocket())

    await screen.findByText(/still running v1\.2\.14/i)
    expect(screen.queryByText(/no helper log was written/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/windows defender/i)).not.toBeInTheDocument()
  })
})

describe('Settings.tsx: likelyCause "unknown" now surfaces a generic fallback instead of total silence', () => {
  it('shows the generic could-not-determine hint', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    preflight.mockResolvedValue({
      ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [],
      info: { isPackaged: true, platform: 'win32', updateMode: 'direct', restartAssessment: { gameServers: 'preserved', requiresConfirmation: false }, temporaryDirectory: 'C:/tmp', applyLogPath: 'C:/tmp/log.txt' },
    })
    getRuntime.mockResolvedValue({
      platform: 'win32', family: 'windows', pathSeparator: '\\',
      temporaryDirectory: 'C:/tmp', serviceManager: 'none',
      restartAssessment: { gameServers: 'preserved', requiresConfirmation: false },
    })
    getStatus.mockResolvedValue(
      statusWithApplyResult({
        status: 'failed', pendingVersion: '1.2.15', currentVersion: '1.2.14',
        at: new Date().toISOString(), stagedStillPresent: false,
        helperLog: 'some log with no recognized signature',
        likelyCause: 'unknown',
        canRetryApply: false, panelFolder: 'C:/panel',
      }),
    )

    renderSettings(fakeSocket())

    await screen.findByText(/cause could not be determined automatically/i)
    expect(screen.getByText(/doesn't match a known failure signature/i)).toBeInTheDocument()
  })

  it('also fires on a non-Windows runtime -- unknown is not platform-gated', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    preflight.mockResolvedValue({
      ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [],
      info: { isPackaged: true, platform: 'linux', updateMode: 'direct', restartAssessment: { gameServers: 'preserved', requiresConfirmation: false }, temporaryDirectory: '/tmp', applyLogPath: '/tmp/log.txt' },
    })
    getRuntime.mockResolvedValue({
      platform: 'linux', family: 'posix', pathSeparator: '/',
      temporaryDirectory: '/tmp', serviceManager: 'systemd',
      restartAssessment: { gameServers: 'preserved', requiresConfirmation: false },
    })
    getStatus.mockResolvedValue(
      statusWithApplyResult({
        status: 'failed', pendingVersion: '1.2.15', currentVersion: '1.2.14',
        at: new Date().toISOString(), stagedStillPresent: false,
        helperLog: 'some log with no recognized signature',
        likelyCause: 'unknown',
        canRetryApply: false, panelFolder: '/opt/panel',
      }),
    )

    renderSettings(fakeSocket())

    await screen.findByText(/cause could not be determined automatically/i)
  })
})
