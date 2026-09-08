import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import Settings from '../Settings'
import { configApi, panelUpdateApi, systemApi } from '@/lib/api'
import { resetRuntimeInfoForTests } from '@/hooks/useRuntimeInfo'

// GH#149, 2026-09-08 (god-dispatched, item 1+4 of the shape report): the
// swap can succeed completely (exe + client dist both activated) and the
// new binary still exit before acknowledging startup -- Start.bat stamps
// [startup_handshake_failed] on that, but classifyApplyFailure() used to
// leave it unmapped (its own dated comment admitted so), so the console and
// UI both said "unknown" while the real tag sat three lines away in the
// same log. This cost the real reporter three redundant 70MB re-downloads,
// because the OTHER half of the bug -- "stagedGone"'s unconditional
// "re-download" advice -- kept telling him the fix was a fresh download,
// when a re-download of the identical version reproduces the identical
// failure. Fix: a dedicated likelyCause bucket (Windows-only, since the tag
// is only ever stamped by build.js's Start.bat) with honest copy that does
// NOT claim to know the underlying throw code, and a stagedGone variant
// that stops implying redownloading will help.

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
    currentVersion: '1.2.15', updateAvailable: true, latestVersion: '1.2.17',
    releaseUrl: null, releaseNotes: null, publishedAt: null,
    isChecking: false, isDownloading: false, downloadProgress: 0,
    lastCheck: null, lastError: null, updateMode: 'direct',
    stagedUpdate: null,
    lastApplyResult,
  }
}

const windowsRuntime = {
  platform: 'win32' as const, family: 'windows' as const, pathSeparator: '\\',
  temporaryDirectory: 'C:/tmp', serviceManager: 'none' as const,
  restartAssessment: { gameServers: 'preserved' as const, requiresConfirmation: false },
}
const windowsPreflight = {
  ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [],
  info: { isPackaged: true, platform: 'win32', updateMode: 'direct', restartAssessment: { gameServers: 'preserved' as const, requiresConfirmation: false }, temporaryDirectory: 'C:/tmp', applyLogPath: 'C:/tmp/log.txt' },
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  resetRuntimeInfoForTests()
})

describe('Settings.tsx: likelyCause "startup_handshake_failed" (GH#149)', () => {
  it('on Windows, shows the honest handshake-failure hint and the non-loss "gone" wording, not "unknown"', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    preflight.mockResolvedValue(windowsPreflight)
    getRuntime.mockResolvedValue(windowsRuntime)
    getStatus.mockResolvedValue(
      statusWithApplyResult({
        status: 'failed', pendingVersion: '1.2.17', currentVersion: '1.2.15',
        at: new Date().toISOString(), stagedStillPresent: false,
        helperLog: '[startup_handshake_failed] ...',
        likelyCause: 'startup_handshake_failed',
        canRetryApply: false, panelFolder: 'C:/panel',
      }),
    )

    renderSettings(fakeSocket())

    await screen.findByText(/exited before finishing startup/i)
    expect(screen.getByText(/automatically rolled back to the previous version/i)).toBeInTheDocument()
    // The old unconditional "gone, re-download" wording must not appear --
    // it's exactly the advice that cost the real reporter three redundant
    // downloads of a version that will fail identically every time.
    expect(screen.queryByText(/re-download the update before retrying/i)).not.toBeInTheDocument()
    expect(screen.getByText(/very likely fail the same way/i)).toBeInTheDocument()
    expect(screen.queryByText(/cause could not be determined automatically/i)).not.toBeInTheDocument()
  })

  it('on a non-Windows runtime, the Windows-only hint box is suppressed (the tag can never legitimately fire there, but the value is defensively gated like its siblings)', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    preflight.mockResolvedValue({
      ...windowsPreflight,
      info: { ...windowsPreflight.info, platform: 'linux', temporaryDirectory: '/tmp', applyLogPath: '/tmp/log.txt' },
    })
    getRuntime.mockResolvedValue({
      platform: 'linux', family: 'posix', pathSeparator: '/',
      temporaryDirectory: '/tmp', serviceManager: 'systemd',
      restartAssessment: { gameServers: 'preserved', requiresConfirmation: false },
    })
    getStatus.mockResolvedValue(
      statusWithApplyResult({
        status: 'failed', pendingVersion: '1.2.17', currentVersion: '1.2.15',
        at: new Date().toISOString(), stagedStillPresent: false,
        helperLog: '[startup_handshake_failed] ...',
        likelyCause: 'startup_handshake_failed',
        canRetryApply: false, panelFolder: '/opt/panel',
      }),
    )

    renderSettings(fakeSocket())

    await screen.findByText(/still running v1\.2\.15/i)
    expect(screen.queryByText(/exited before finishing startup/i)).not.toBeInTheDocument()
    // The non-loss "gone" wording is keyed off likelyCause alone, not the
    // platform gate, so it still applies here.
    expect(screen.getByText(/very likely fail the same way/i)).toBeInTheDocument()
  })

  it('other causes (e.g. av_quarantine) keep the original "gone, re-download" wording unchanged', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    preflight.mockResolvedValue(windowsPreflight)
    getRuntime.mockResolvedValue(windowsRuntime)
    getStatus.mockResolvedValue(
      statusWithApplyResult({
        status: 'failed', pendingVersion: '1.2.17', currentVersion: '1.2.15',
        at: new Date().toISOString(), stagedStillPresent: false,
        helperLog: '[av_quarantine] ...',
        likelyCause: 'av_quarantine',
        canRetryApply: false, panelFolder: 'C:/panel',
      }),
    )

    renderSettings(fakeSocket())

    await screen.findByText(/re-download the update before retrying/i)
    expect(screen.queryByText(/very likely fail the same way/i)).not.toBeInTheDocument()
  })
})
