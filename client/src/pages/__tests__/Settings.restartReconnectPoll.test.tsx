import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import Settings from '../Settings'
import { configApi, panelUpdateApi, serverApi } from '@/lib/api'

// bug-hunt-2026-09-07 (client silent-failure lane, update-failure-states
// pass -- the exact incident this was written for, Charon/Discord, v1.2.16,
// invalid_bundle/exit 76): restartPanelWithReconnect() used to navigate the
// browser after a flat 3s delay regardless of whether the panel actually
// came back -- resolving the POST to /api/panel/restart only ever confirmed
// the OLD process accepted the request, never that a NEW one came up
// healthy. If the new process was crash-looping, the blind navigate sent the
// browser into a connection-refused wall with the panel's own UI gone and
// zero indication anything was wrong. These pin the fix: the client now
// polls /api/health before navigating, and gives an honest, in-app
// "hasn't come back" message (with a manual retry) instead of a silent dead
// navigate once the poll gives up.

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
    serverApi: { ...actual.serverApi, restartPanel: vi.fn() },
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
const restartPanel = vi.mocked(serverApi.restartPanel)

function createFakeSocket() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const socket = {
    connected: true,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler)
    }),
    emit: vi.fn(),
  }
  return { socket: socket as unknown as Socket }
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

function stubLocation() {
  const original = window.location
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...original, href: original.href },
  })
  return () => {
    Object.defineProperty(window, 'location', { configurable: true, value: original })
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Settings.tsx: restartPanelWithReconnect polls for the panel to come back instead of navigating blind', () => {
  it('navigates only once /api/health answers with the expected version -- not on a fixed timer', async () => {
    // Fake timers must be installed before the button click, since that's
    // what creates the setTimeout/setInterval this test drives (see
    // Servers.steamStallRecovery.test.tsx for the same lesson).
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const restoreLocation = stubLocation()

    getAppSettings.mockResolvedValue({ settings: { panelPort: '3001' } })
    preflight.mockResolvedValue({
      ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [],
      info: { isPackaged: true, platform: 'win32', updateMode: 'direct', restartAssessment: { gameServers: 'preserved', requiresConfirmation: false }, temporaryDirectory: 'C:/tmp', applyLogPath: 'C:/tmp/log.txt' },
    })
    getStatus.mockResolvedValue({
      currentVersion: '1.2.15', updateAvailable: true, latestVersion: '1.2.16',
      releaseUrl: null, releaseNotes: null, publishedAt: null,
      isChecking: false, isDownloading: false, downloadProgress: 0,
      lastCheck: null, lastError: null, updateMode: 'direct',
      stagedUpdate: { version: '1.2.16', path: 'C:/panel/update.new.exe' },
      lastApplyResult: null,
    })
    restartPanel.mockResolvedValue({ success: true })

    // First few health checks answer with the OLD version still running
    // (the handoff window -- old process hasn't exited yet), then the new
    // one comes up. This is exactly the case a fixed-delay navigate cannot
    // distinguish from "never comes back." Everything that ISN'T the health
    // check (Settings.tsx mounts with plenty of its own unrelated fetches --
    // bridge status, CORS diagnostics, etc.) resolves harmlessly instead of
    // being globally stubbed to fail -- a blanket failing stub sent every
    // one of those into fetchWithRetry's real backoff loop simultaneously,
    // which is what made the very first version of this test hang past its
    // own timeout.
    let healthCall = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (!url.includes('/api/health')) {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      healthCall += 1
      return new Response(
        JSON.stringify({ status: 'ok', version: healthCall < 3 ? '1.2.15' : '1.2.16' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const { socket } = createFakeSocket()
      renderSettings(socket)

      const restartButton = await screen.findByRole('button', { name: 'Restart and Apply Update' })
      restartButton.click()

      const confirmButton = await screen.findByRole('button', { name: 'Restart and apply' })
      confirmButton.click()

      await vi.waitFor(() => expect(restartPanel).toHaveBeenCalledTimes(1))

      // Nothing has navigated yet at the old flat-delay mark -- proves this
      // isn't just the old fixed setTimeout under a new name.
      await vi.advanceTimersByTimeAsync(3000)
      expect(window.location.href).not.toContain('3001')

      // Advance through several poll intervals -- health checks 1-2 report
      // the old version (ignored), the 3rd reports the new one.
      await vi.advanceTimersByTimeAsync(2000 * 3)

      await vi.waitFor(() => expect(window.location.href).toContain('3001'))
    } finally {
      restoreLocation()
    }
  })

  // Settings.tsx's own bridge-status polling (a recursive setTimeout,
  // separate from the reconnect poll under test) also advances along with
  // the fake clock and adds real wall-clock overhead across ~40-60 cycles
  // over the 3-minute span this test crosses -- needs more than the default
  // 60s test timeout to actually finish, not because anything is hung.
  it('shows an in-app "hasn\'t come back" message instead of navigating when health checks never succeed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const restoreLocation = stubLocation()

    getAppSettings.mockResolvedValue({ settings: { panelPort: '3001' } })
    preflight.mockResolvedValue({
      ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [],
      info: { isPackaged: true, platform: 'win32', updateMode: 'direct', restartAssessment: { gameServers: 'preserved', requiresConfirmation: false }, temporaryDirectory: 'C:/tmp', applyLogPath: 'C:/tmp/log.txt' },
    })
    getStatus.mockResolvedValue({
      currentVersion: '1.2.15', updateAvailable: true, latestVersion: '1.2.16',
      releaseUrl: null, releaseNotes: null, publishedAt: null,
      isChecking: false, isDownloading: false, downloadProgress: 0,
      lastCheck: null, lastError: null, updateMode: 'direct',
      stagedUpdate: { version: '1.2.16', path: 'C:/panel/update.new.exe' },
      lastApplyResult: null,
    })
    restartPanel.mockResolvedValue({ success: true })

    // The crash-loop case this whole lane was written for: the new process
    // never comes back up, ever. Only /api/health fails -- see the first
    // test's comment on why a blanket-failing stub hangs the whole page.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/health')) throw new TypeError('Failed to fetch')
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const { socket } = createFakeSocket()
      renderSettings(socket)

      const restartButton = await screen.findByRole('button', { name: 'Restart and Apply Update' })
      restartButton.click()
      const confirmButton = await screen.findByRole('button', { name: 'Restart and apply' })
      confirmButton.click()

      await vi.waitFor(() => expect(restartPanel).toHaveBeenCalledTimes(1))

      // Past the 3-minute reconnect ceiling with zero successful health
      // checks the whole time. Advanced in chunks, not one huge jump --
      // with shouldAdvanceTime a single ~185s advance across ~90 interval
      // firings reliably stalls past the test's own timeout; chunking is
      // the standard workaround for a fake-timer interval run this long.
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(10_000)
      }

      expect(await screen.findByRole('alert')).toHaveTextContent(/hasn't come back/i)
      // The honest failure never fabricated a navigate.
      expect(window.location.href).not.toContain('3001')

      // Manual retry is available and starts a fresh poll -- proves the
      // give-up isn't a dead end.
      const checkAgain = screen.getByRole('button', { name: 'Check Again' })
      expect(checkAgain).toBeEnabled()
    } finally {
      restoreLocation()
    }
  }, 120_000)
})
