import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import Settings from '../Settings'
import { configApi, panelUpdateApi } from '@/lib/api'

// bug-hunt-2026-09-07 (Windows updater hardening lane): once
// panelUpdatePreflight.ok is false (disk full, no write permission, etc),
// the Download and Restart-and-Apply buttons are disabled by that same
// stale preflight -- so the only buttons a blocked user can still click are
// the ones the block is preventing them from clicking. The effect that
// refreshes preflight only re-fires when hasActionablePanelUpdate/
// stagedPanelUpdatePath actually CHANGE, so if an update was already
// available before the block cleared in the real world (disk space freed,
// permissions fixed) and still is after, that effect never refires --
// leaving the user stuck until they reload the whole page. "Check for
// Updates" is the one button that was never preflight-gated; this proves
// it now also refreshes preflight, so a user who fixed the real problem has
// an in-app way back without a full reload.

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
    panelUpdateApi: {
      ...actual.panelUpdateApi,
      getStatus: vi.fn(),
      check: vi.fn(),
      preflight: vi.fn(),
    },
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
const check = vi.mocked(panelUpdateApi.check)
const preflight = vi.mocked(panelUpdateApi.preflight)

function createFakeSocket() {
  const socket = {
    connected: true,
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  }
  return socket as unknown as Socket
}

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

const baseStatus = {
  currentVersion: '1.2.14',
  updateAvailable: true,
  latestVersion: '1.2.15',
  releaseUrl: null,
  releaseNotes: null,
  publishedAt: null,
  isChecking: false,
  isDownloading: false,
  downloadProgress: 0,
  lastCheck: null,
  lastError: null,
  updateMode: 'direct' as const,
  stagedUpdate: null,
  lastApplyResult: null,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Settings.tsx: preflight re-checks on "Check for Updates", not just on mount', () => {
  it('clears a stale "Update Blocked" state once a re-check finds preflight passing again', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    getStatus.mockResolvedValue(baseStatus)
    preflight.mockResolvedValueOnce({
      ok: false,
      blockers: ['Not enough free disk space to stage the update.'],
      warnings: [],
      blockerDetails: [],
      warningDetails: [],
      info: {
        isPackaged: true,
        platform: 'win32',
        updateMode: 'direct',
        restartAssessment: { gameServers: 'preserved', requiresConfirmation: false },
        temporaryDirectory: 'C:/tmp',
        applyLogPath: 'C:/tmp/log.txt',
      },
    })

    renderSettings(createFakeSocket())

    await screen.findByText('Update Blocked')
    const downloadButton = await screen.findByRole('button', { name: 'Download Update' })
    expect(downloadButton).toBeDisabled()

    // Real-world fix (operator freed disk space) -- the next preflight call
    // should now pass. "Check for Updates" itself reports the same
    // updateAvailable:true/1.2.15 as before, so hasActionablePanelUpdate and
    // stagedPanelUpdatePath are both unchanged.
    check.mockResolvedValueOnce(baseStatus)
    preflight.mockResolvedValueOnce({
      ok: true,
      blockers: [],
      warnings: [],
      blockerDetails: [],
      warningDetails: [],
      info: {
        isPackaged: true,
        platform: 'win32',
        updateMode: 'direct',
        restartAssessment: { gameServers: 'preserved', requiresConfirmation: false },
        temporaryDirectory: 'C:/tmp',
        applyLogPath: 'C:/tmp/log.txt',
      },
    })

    const checkButton = await screen.findByRole('button', { name: 'Check for Updates' })
    await act(async () => {
      fireEvent.click(checkButton)
    })

    await waitFor(() => expect(screen.queryByText('Update Blocked')).not.toBeInTheDocument())
    await waitFor(() => expect(downloadButton).toBeEnabled())
    expect(preflight).toHaveBeenCalledTimes(2)
  })
})
