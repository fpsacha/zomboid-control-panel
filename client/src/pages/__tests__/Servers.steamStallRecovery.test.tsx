import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers from '../Servers'
import { serversApi, serversDetectApi, dockerApi, configApi, updateApi, serverApi } from '@/lib/api'
import en from '../../locales/en/servers.json'

// bug-hunt-2026-09-06 (client silent-failure lane, dispatched after tonight's
// server uploadStream crash): steamRunning is cleared ONLY by the
// 'steam:complete' socket event -- the awaited steamUpdate()/steamVerify()
// call only confirms SteamCMD was LAUNCHED, not that it finished. Before this
// fix, a dropped/never-emitted steam:complete left the dialog's onOpenChange
// AND its own Close/Cancel button both disabled with steamRunning stuck true
// -- no way out short of a full page reload. This is the client-side shape
// of the same "nobody's listening for the terminal event" class as the
// server's uploadStream crash, manifesting as "stuck" instead of "crash".
//
// This test proves the fix: after STEAM_STALL_MS of no steam:log/steam:start
// activity, the dialog surfaces an honest "may still be running" message and
// grants a real escape hatch -- it does NOT fabricate success or failure,
// per god's explicit instruction that a false failure on a real install
// would cause a needless, destructive re-run.

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'technician', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => mockCan(capability),
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
      getRconStatuses: vi.fn(),
      discoverMounts: vi.fn(),
      steamVerify: vi.fn(),
      steamUpdate: vi.fn(),
    },
    serversDetectApi: {
      ...actual.serversDetectApi,
      detect: vi.fn(),
      autoScan: vi.fn(),
    },
    dockerApi: {
      ...actual.dockerApi,
      getStatus: vi.fn(),
      getStats: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
      updateAppSettings: vi.fn(),
    },
    updateApi: {
      ...actual.updateApi,
      getStatus: vi.fn(),
    },
    // Same reason as Servers.capabilityGating.test.tsx: the Steam dialog's
    // own mount effect fires these immediately, and left real they hit a
    // genuine fetch that retries with backoff in this test env.
    serverApi: {
      ...actual.serverApi,
      detectSteamCmd: vi.fn(),
      getBranches: vi.fn(),
    },
  }
})

const getAll = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(serversApi.getStatus)
const getRconStatuses = vi.mocked(serversApi.getRconStatuses)
const discoverMounts = vi.mocked(serversApi.discoverMounts)
const steamUpdate = vi.mocked(serversApi.steamUpdate)
const detect = vi.mocked(serversDetectApi.detect)
const autoScan = vi.mocked(serversDetectApi.autoScan)
const dockerGetStatus = vi.mocked(dockerApi.getStatus)
const dockerGetStats = vi.mocked(dockerApi.getStats)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateAppSettings = vi.mocked(configApi.updateAppSettings)
const updateGetStatus = vi.mocked(updateApi.getStatus)
const detectSteamCmd = vi.mocked(serverApi.detectSteamCmd)
const getBranches = vi.mocked(serverApi.getBranches)

const SERVER_A = {
  id: 1,
  name: 'server-a',
  serverName: 'server-a-cfg',
  installPath: '/srv/a',
  zomboidDataPath: '/srv/a/data',
  serverConfigPath: '/srv/a/data/Server/server-a.ini',
  rconHost: '127.0.0.1',
  rconPort: 27015,
  rconPassword: '',
  serverPort: 16261,
  minMemory: 2,
  maxMemory: 4,
  useNoSteam: false,
  useDebug: false,
  isRemote: false,
  isActive: false,
  startCommand: '',
  adminPassword: '',
  createdAt: new Date(0).toISOString(),
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

async function setUpFixtures() {
  getAll.mockResolvedValue({ servers: [SERVER_A] } as never)
  getStatus.mockResolvedValue({ servers: [] } as never)
  getRconStatuses.mockResolvedValue({ servers: [] } as never)
  discoverMounts.mockResolvedValue({ mounts: [] } as never)
  dockerGetStatus.mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
  dockerGetStats.mockResolvedValue({ containers: {} } as never)
  getAppSettings.mockResolvedValue({ settings: { steamcmdPath: '/opt/steamcmd' } } as never)
  updateAppSettings.mockResolvedValue({ success: true } as never)
  updateGetStatus.mockResolvedValue({} as never)
  detect.mockResolvedValue({ servers: [] } as never)
  autoScan.mockResolvedValue({ servers: [] } as never)
  detectSteamCmd.mockResolvedValue({ found: false, path: null } as never)
  getBranches.mockResolvedValue({ branches: [] } as never)
}

async function openCardMenu(serverName: string) {
  const trigger = await screen.findByRole('button', { name: new RegExp(`options for ${serverName}`, 'i') })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}

async function openSteamDialogForServerA() {
  const menu = await openCardMenu('server-a')
  fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.updateServer }))
  await screen.findByRole('heading', { name: en.steamDialog.updateTitle })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('Servers.tsx: steam dialog recovers if steam:complete never arrives', () => {
  it('stays wedged with no way out until STEAM_STALL_MS passes, then offers an honest "Close Anyway" without fabricating success/failure', async () => {
    mockCan = () => true
    await setUpFixtures()
    steamUpdate.mockResolvedValue({ success: true } as never)

    // shouldAdvanceTime keeps the fake clock ticking in lockstep with real
    // time, so RTL's waitFor/findBy (which poll via setTimeout) keep working
    // normally -- while still letting vi.advanceTimersByTimeAsync jump the
    // clock forward on demand below. Installed BEFORE the click that starts
    // the watchdog's setInterval: fake timers never retroactively adopt an
    // interval that was already created under real timers, so this has to
    // be in place from before steamRunning first goes true.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderServers()
      await screen.findByText('server-a')

      await openSteamDialogForServerA()
      fireEvent.click(screen.getByRole('button', { name: en.steamDialog.startUpdate }))
      await waitFor(() => expect(steamUpdate).toHaveBeenCalledTimes(1))

      // steamUpdate() resolved (SteamCMD launched) but no socket exists in
      // this render, so 'steam:complete' can never arrive -- steamRunning
      // stays true exactly as it would in production if that event were
      // dropped.
      //
      // Two buttons in this dialog both read "Running..." while steamRunning
      // is true (the primary Start Update button gains a spinner, and the
      // footer's outline Cancel/Close button -- the one with the
      // escape-hatch logic this test cares about -- shows the same label) --
      // disambiguate by variant.
      const findOutlineRunningButton = () =>
        screen.getAllByRole('button', { name: en.steamDialog.running }).find(
          (b) => b.getAttribute('data-variant') === 'outline',
        )
      await waitFor(() => expect(findOutlineRunningButton()).toBeDefined())
      expect(findOutlineRunningButton()).toBeDisabled()
      expect(screen.queryByText(en.steamDialog.stalledMessage)).not.toBeInTheDocument()

      // Just under the 3-minute stall threshold: still no escape, and no
      // false claim of success or failure yet.
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 - 1000)
      expect(findOutlineRunningButton()).toBeDisabled()
      expect(screen.queryByText(en.steamDialog.stalledMessage)).not.toBeInTheDocument()

      // Cross the threshold (watchdog ticks every 15s).
      await vi.advanceTimersByTimeAsync(20_000)
      await waitFor(() => expect(screen.getByText(en.steamDialog.stalledMessage)).toBeInTheDocument())

      const closeAnyway = screen.getByRole('button', { name: en.steamDialog.closeAnyway })
      expect(closeAnyway).not.toBeDisabled()

      // Closing does not claim the install succeeded or failed -- it just
      // lets the user leave. The dialog itself must actually be gone
      // afterward, not merely re-enabled.
      fireEvent.click(closeAnyway)
      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: en.steamDialog.updateTitle })).not.toBeInTheDocument(),
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
