import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'

// bridge-tri-state sweep (2026-09-10): Players.tsx called
// panelBridgeApi.getStatus() exactly once, on mount, and never again --
// unlike Events.tsx (10s interval) and WorldMap.tsx (re-checked on its own
// poll), which both notice a bridge connecting or dropping after mount. A
// bridge that connected after this page mounted left every GM control and
// the import/export gate stuck on the stale mount-time read until the user
// navigated away and back and read as "the panel is broken." Proven here by
// mocking getStatus false-then-true and advancing one interval tick: without
// the re-poll, getStatus is called exactly once no matter how much time
// passes, and the God Mode "Enable" button never becomes clickable.

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

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    playersApi: {
      ...actual.playersApi,
      getPlayers: vi.fn(),
      getWhitelist: vi.fn(),
      getPerks: vi.fn(),
      getAccessLevels: vi.fn(),
      getSteamIdBans: vi.fn(),
      getNotes: vi.fn(),
      getStats: vi.fn(),
      getExports: vi.fn(),
      getActivityLogs: vi.fn(),
    },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      sendCommand: vi.fn(),
      getAllPlayerDetails: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
      updateAppSettings: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getWhitelist = vi.mocked(playersApi.getWhitelist)
const getPerks = vi.mocked(playersApi.getPerks)
const getAccessLevels = vi.mocked(playersApi.getAccessLevels)
const getSteamIdBans = vi.mocked(playersApi.getSteamIdBans)
const getNotes = vi.mocked(playersApi.getNotes)
const getStats = vi.mocked(playersApi.getStats)
const getExports = vi.mocked(playersApi.getExports)
const getActivityLogs = vi.mocked(playersApi.getActivityLogs)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getAllPlayerDetails = vi.mocked(panelBridgeApi.getAllPlayerDetails)
const getAppSettings = vi.mocked(configApi.getAppSettings)

function renderPlayers() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Players />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function setUpFixtures() {
  getPlayers.mockResolvedValue({ players: [{ name: 'TestPlayer', online: true }] })
  getWhitelist.mockResolvedValue({ success: true, available: true, accounts: [], allowedSteamIds: [] })
  getPerks.mockResolvedValue({ catalog: [] })
  getAccessLevels.mockResolvedValue({ levels: ['admin', 'moderator', 'gm', 'observer', 'priority', 'user', 'none'], available: true })
  getSteamIdBans.mockResolvedValue({ bans: [] })
  getNotes.mockResolvedValue({ notes: [] })
  getStats.mockResolvedValue({ stats: [] })
  getExports.mockResolvedValue({ exports: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getAllPlayerDetails.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  getAppSettings.mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
}

async function selectTestPlayerAndOpenPowers() {
  await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
  fireEvent.click(screen.getByText('TestPlayer'))
  await waitFor(() => expect(screen.getAllByText('TestPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Enable' })[0]).toBeInTheDocument(), { timeout: 3000 })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('Players.tsx: bridge status re-polls after mount, matching Events.tsx/WorldMap.tsx', () => {
  it('picks up a bridge connecting after mount on the next 15s poll tick, without a remount', async () => {
    await setUpFixtures()
    getStatus.mockResolvedValue({ modConnected: false, isRunning: false } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)

    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderPlayers()

    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1))
    await selectTestPlayerAndOpenPowers()
    expect(screen.getAllByRole('button', { name: 'Enable' })[0]).toBeDisabled()

    // Bridge connects sometime after mount -- the next poll tick should see it.
    getStatus.mockResolvedValue({ modConnected: true, isRunning: true } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })

    await waitFor(() => expect(getStatus.mock.calls.length).toBeGreaterThan(1))
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Enable' })[0]).not.toBeDisabled())
  })
})
