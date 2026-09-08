import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Servers from '../Servers'
import { serversApi, dockerApi, configApi, updateApi } from '@/lib/api'

// three-state-audit-2026-09-08 (dispatched off the operator's own "start/
// stop/detection has been really crap" complaint, and the night's full
// server-side effort to preserve "confirmed stopped" vs "could not tell"
// through scanFailed/stateUnknown): the SERVER side of that distinction was
// solid (server/routes/servers.js's GET /status sets stateUnknown, and it is
// carried all the way into Servers.tsx's serverStatuses state -- see
// fetchServerStatuses' `stateUnknown: s.stateUnknown === true`). The button-
// enablement path already respected it correctly (resolveServerCardRunning
// in lib/serverStatus.ts returns null on stateUnknown, disabling the
// button). But the BADGE right next to that same button did its own,
// separate, un-guarded `status.running ? 'running' : 'stopped'` ternary --
// so a card could show a disabled Start button (correctly unsure) sitting
// directly beside a confident grey "Process Down" badge (incorrectly sure),
// undoing the exact distinction the server worked all night to preserve.
//
// This proves the fix: a non-active native-provider server whose status row
// carries stateUnknown:true renders an 'Unknown' badge, not 'Down'/'Up'.

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

const SERVER_A = {
  id: 1,
  name: 'active-native-server',
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

const SERVER_B = {
  ...(SERVER_A as object),
  id: 2,
  name: 'inactive-native-server-with-unknown-state',
  serverName: 'b-cfg',
  installPath: '/srv/b',
  zomboidDataPath: '/srv/b/data',
  isActive: false,
} as never

function renderServers() {
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={null}>
        <TooltipProvider>
          <ConfirmProvider>
            <Servers />
          </ConfirmProvider>
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// Servers.tsx renders each server inside a Card with no test id -- scope by
// walking up from the server's own name text to the nearest ancestor
// carrying the Card's own class fragment, then search within that subtree
// only. Avoids a false pass from matching the OTHER card's badge text.
function cardFor(serverName: string): HTMLElement {
  const title = screen.getByText(serverName)
  const card = title.closest('.overflow-hidden.transition-colors')
  if (!card) throw new Error(`could not find card container for ${serverName}`)
  return card as HTMLElement
}

describe('Servers.tsx: a stateUnknown status row renders an Unknown badge, not a confident Stopped/Running one', () => {
  it('non-active native server, stateUnknown:true -- badge reads Unknown, never Down', async () => {
    getAll.mockResolvedValue({ servers: [SERVER_A, SERVER_B] } as never)
    getStatus.mockResolvedValue({
      servers: [
        { id: 1, running: true, pid: '111', stateUnknown: false },
        { id: 2, running: false, pid: null, stateUnknown: true },
      ],
    } as never)
    getComposedStatus.mockRejectedValue(new Error('no composed status in this fixture'))
    getRconStatuses.mockResolvedValue({ servers: [] } as never)
    discoverMounts.mockResolvedValue({ mounts: [] } as never)
    dockerGetStatus.mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
    dockerGetStats.mockResolvedValue({ containers: {} } as never)
    getAppSettings.mockResolvedValue({ settings: {} } as never)
    updateGetStatus.mockResolvedValue({} as never)

    renderServers()

    const card = await (async () => {
      // wait for the server list (and its status fetch) to actually land
      await screen.findByText(SERVER_B.name)
      return cardFor(SERVER_B.name)
    })()

    expect(card.textContent).toMatch(/Unknown/)
    expect(card.textContent).not.toMatch(/Process\s*Down/)
    expect(card.textContent).not.toMatch(/Process\s*Up/)
  })
})
