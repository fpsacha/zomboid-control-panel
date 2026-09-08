import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Servers from '../Servers'
import { serversApi, dockerApi, configApi, updateApi } from '@/lib/api'
import type { Socket } from 'socket.io-client'

// 2026-09-08, client half of Angela's updateChecker.js lastError finding
// (server SHA 319a1144): checkForUpdates() ran unattended forever with every
// failure path only logging server-side and returning null. The card's
// "Update Available" badge renders purely off updateInfo?.updateAvailable
// being truthy, so a silently-failing checker meant the badge simply never
// appeared -- indistinguishable from a confident "you are up to date."
//
// god's ruling on the design question this raised: a check that succeeded
// once and then started failing must KEEP showing the stale-but-real
// result, not flip to "unknown" -- "is there an update" and "is that answer
// current" are two different questions, and conflating them is what caused
// the bug in the first place. Angela's contract (getStatus()'s
// updateAvailable/lastError pair) makes this derivable without a third
// field: updateAvailable is written ONLY on a successful check, so it
// retains the last real result across a later failure.
//
// Three cases proven here: never-succeeded renders the new muted "Update
// status unknown" badge (never the amber one); succeeded-then-failed keeps
// showing the stale real result and does NOT show "unknown"; a live
// server:updateAvailable/server:updateCheck socket event (which can only
// ever be emitted from checkForUpdates()'s success path) clears an existing
// "unknown" state even before any getStatus() re-fetch would.

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
    serversApi: {
      ...actual.serversApi,
      getAll: vi.fn(),
      getStatus: vi.fn(),
      getComposedStatus: vi.fn(),
      getRconStatuses: vi.fn(),
      discoverMounts: vi.fn(),
    },
    dockerApi: {
      ...actual.dockerApi,
      getStatus: vi.fn(),
      getStats: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
    },
    updateApi: {
      ...actual.updateApi,
      getStatus: vi.fn(),
    },
  }
})

const getAll = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(serversApi.getStatus)
const getComposedStatus = vi.mocked(serversApi.getComposedStatus)
const getRconStatuses = vi.mocked(serversApi.getRconStatuses)
const discoverMounts = vi.mocked(serversApi.discoverMounts)
const dockerGetStatus = vi.mocked(dockerApi.getStatus)
const dockerGetStats = vi.mocked(dockerApi.getStats)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateGetStatus = vi.mocked(updateApi.getStatus)

const ACTIVE_SERVER = {
  id: 1,
  name: 'active-server',
  serverName: 'a-cfg',
  installPath: '/srv/a',
  zomboidDataPath: '/srv/a/data',
  serverConfigPath: '/srv/a/data/Server/a.ini',
  rconHost: '127.0.0.1',
  rconPort: 27015,
  rconPassword: '',
  serverPort: 16261,
  minMemory: 2,
  maxMemory: 4,
  useNoSteam: false,
  useDebug: false,
  isRemote: false,
  isActive: true,
  startCommand: '',
  adminPassword: '',
  createdAt: new Date(0).toISOString(),
} as never

function fakeSocket(): { socket: Socket; handlers: Record<string, (data: unknown) => void> } {
  const handlers: Record<string, (data: unknown) => void> = {}
  const socket = {
    connected: true,
    on: vi.fn((event: string, cb: (data: unknown) => void) => { handlers[event] = cb }),
    off: vi.fn(),
    emit: vi.fn(),
  } as unknown as Socket
  return { socket, handlers }
}

function renderServers(socket: Socket | null) {
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={socket}>
        <TooltipProvider>
          <ConfirmProvider>
            <Servers />
          </ConfirmProvider>
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

function cardFor(serverName: string): HTMLElement {
  const title = screen.getByText(serverName)
  const card = title.closest('.overflow-hidden.transition-colors')
  if (!card) throw new Error(`could not find card container for ${serverName}`)
  return card as HTMLElement
}

function mockCommonServerFetches() {
  getStatus.mockResolvedValue({ servers: [{ id: 1, running: true, pid: '111', stateUnknown: false }] } as never)
  getComposedStatus.mockRejectedValue(new Error('no composed status in this fixture'))
  getRconStatuses.mockResolvedValue({ servers: [] } as never)
  discoverMounts.mockResolvedValue({ mounts: [] } as never)
  dockerGetStatus.mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
  dockerGetStats.mockResolvedValue({ containers: {} } as never)
  getAppSettings.mockResolvedValue({ settings: {} } as never)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Servers.tsx: the active server card distinguishes never-succeeded from succeeded-then-failed', () => {
  it('never-succeeded (updateAvailable: null): shows "Update status unknown", never the amber Update Available badge', async () => {
    getAll.mockResolvedValue({ servers: [ACTIVE_SERVER] } as never)
    mockCommonServerFetches()
    updateGetStatus.mockResolvedValue({
      updateAvailable: null,
      gameVersion: null,
      lastCheck: null,
      lastError: 'Could not get the latest build info from Steam (steamcmd query failed)',
      intervalMinutes: 60,
      isChecking: false,
      lastAutoUpdateResult: null,
    } as never)

    renderServers(null)

    await screen.findByText(ACTIVE_SERVER.name)
    const card = cardFor(ACTIVE_SERVER.name)
    expect(await screen.findByText(/update status unknown/i)).toBeInTheDocument()
    expect(card.textContent).not.toMatch(/update available/i)
  })

  it('succeeded-then-failed (updateAvailable set, lastError set): keeps showing the stale-but-real result, does NOT show "unknown"', async () => {
    getAll.mockResolvedValue({ servers: [ACTIVE_SERVER] } as never)
    mockCommonServerFetches()
    updateGetStatus.mockResolvedValue({
      updateAvailable: {
        updateAvailable: true,
        installed: { buildId: '100', branch: 'public', lastUpdated: null },
        latest: { buildId: '200', branch: 'public', timeUpdated: null, description: null },
        lastCheck: new Date(0).toISOString(),
      },
      gameVersion: null,
      lastCheck: new Date(0).toISOString(),
      lastError: 'Could not get the latest build info from Steam (steamcmd query failed)',
      intervalMinutes: 60,
      isChecking: false,
      lastAutoUpdateResult: null,
    } as never)

    renderServers(null)

    await screen.findByText(ACTIVE_SERVER.name)
    const card = cardFor(ACTIVE_SERVER.name)
    expect(await screen.findByText(/update available/i)).toBeInTheDocument()
    expect(card.textContent).not.toMatch(/update status unknown/i)
  })

  it('a live update-check socket event clears an existing "unknown" state, even for a clean no-update result', async () => {
    getAll.mockResolvedValue({ servers: [ACTIVE_SERVER] } as never)
    mockCommonServerFetches()
    updateGetStatus.mockResolvedValue({
      updateAvailable: null,
      gameVersion: null,
      lastCheck: null,
      lastError: null,
      intervalMinutes: 60,
      isChecking: false,
      lastAutoUpdateResult: null,
    } as never)

    const { socket, handlers } = fakeSocket()
    renderServers(socket)

    await screen.findByText(ACTIVE_SERVER.name)
    expect(await screen.findByText(/update status unknown/i)).toBeInTheDocument()

    // server:updateCheck fires ONLY from checkForUpdates()'s success path
    // (forceEmit + no update found) -- receiving it at all is proof a check
    // just succeeded, independent of its own updateAvailable:false payload.
    act(() => {
      handlers['server:updateCheck']({
        updateAvailable: false,
        installed: { buildId: '200', branch: 'public', lastUpdated: null },
        latest: { buildId: '200', branch: 'public', timeUpdated: null, description: null },
        lastCheck: new Date().toISOString(),
      })
    })

    const card = cardFor(ACTIVE_SERVER.name)
    expect(card.textContent).not.toMatch(/update status unknown/i)
    expect(card.textContent).not.toMatch(/update available/i)
  })
})
