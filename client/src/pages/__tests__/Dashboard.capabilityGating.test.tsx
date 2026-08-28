import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, type ServerInstance,
} from '@/lib/api'

// bug-hunt-2026-08-26 Tier 1: server.control gates Start/Stop/Force-Stop/
// Restart/Restart-Now/Save (server/routes/server.js), server.wipe is a
// SEPARATE, more dangerous capability gating /wipe and /wipe/preview --
// confirmed by reading both routes with my own eyes, not inferred from the
// capabilities list. Dashboard.tsx had zero client-side awareness of
// either. Two things this page needed that Console.tsx's single-capability
// fix didn't: (1) Start has TWO entry points that both call handleAction
// directly (the header button AND the verdict band's shortcut for the same
// action) -- omitting the verdict shortcut when ungated, rather than
// showing it disabled with no explanation, since VerdictAction has no
// tooltip support; (2) Stop/Force Stop/Restart/Restart Now all share ONE
// real execution point (the confirm dialog's AlertDialogAction) -- guarded
// there, not just on the four buttons that stage confirmAction, mirroring
// Console.tsx's executeCommand()/sendAnnouncement() guards.

let mockCanControl = true
let mockCanWipe = true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'moderator', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => {
      if (capability === 'server.control') return mockCanControl
      if (capability === 'server.wipe') return mockCanWipe
      return true
    },
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serverApi: {
      ...actual.serverApi,
      getStatus: vi.fn(),
      getPanelInfo: vi.fn(),
      getConsoleErrorCount: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      forceStop: vi.fn(),
      restart: vi.fn(),
      save: vi.fn(),
      wipePreview: vi.fn(),
      wipe: vi.fn(),
    },
    serversApi: {
      ...actual.serversApi,
      getComposedStatus: vi.fn(),
      getResolvedActive: vi.fn(),
    },
    playersApi: {
      ...actual.playersApi,
      getPlayers: vi.fn(),
      getActivityLogs: vi.fn(),
    },
    panelBridgeApi: { ...actual.panelBridgeApi, getStatus: vi.fn() },
    backupApi: { ...actual.backupApi, getStatus: vi.fn() },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
      updateAppSettings: vi.fn(),
    },
    debugApi: { ...actual.debugApi, getPerformanceHistory: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn() },
    modsApi: { ...actual.modsApi, getStatus: vi.fn() },
    schedulerApi: { ...actual.schedulerApi, getTasks: vi.fn(), getStatus: vi.fn() },
  }
})

const getStatus = vi.mocked(serverApi.getStatus)
const getPanelInfo = vi.mocked(serverApi.getPanelInfo)
const getConsoleErrorCount = vi.mocked(serverApi.getConsoleErrorCount)
const start = vi.mocked(serverApi.start)
const stop = vi.mocked(serverApi.stop)
const forceStop = vi.mocked(serverApi.forceStop)
const restart = vi.mocked(serverApi.restart)
const save = vi.mocked(serverApi.save)
const wipePreview = vi.mocked(serverApi.wipePreview)
const wipe = vi.mocked(serverApi.wipe)
const getComposedStatus = vi.mocked(serversApi.getComposedStatus)
const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getPlayers = vi.mocked(playersApi.getPlayers)
const getActivityLogs = vi.mocked(playersApi.getActivityLogs)
const getBridgeStatus = vi.mocked(panelBridgeApi.getStatus)
const getBackupStatus = vi.mocked(backupApi.getStatus)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateAppSettings = vi.mocked(configApi.updateAppSettings)
const getPerformanceHistory = vi.mocked(debugApi.getPerformanceHistory)
const getPanelUpdateStatus = vi.mocked(panelUpdateApi.getStatus)
const getModsStatus = vi.mocked(modsApi.getStatus)
const getSchedulerTasks = vi.mocked(schedulerApi.getTasks)
const getSchedulerStatus = vi.mocked(schedulerApi.getStatus)

function makeServer(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: 1,
    name: 'Ashenwood',
    serverName: 'Ashenwood',
    installPath: 'C:/servers/ashenwood',
    zomboidDataPath: null,
    serverConfigPath: null,
    rconHost: '127.0.0.1',
    rconPort: 27015,
    rconPassword: 'hunter2',
    serverPort: 16261,
    minMemory: 2048,
    maxMemory: 4096,
    useNoSteam: false,
    useDebug: false,
    isRemote: false,
    isActive: true,
    startCommand: '',
    adminPassword: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

async function setUpCommon() {
  getComposedStatus.mockRejectedValue(new Error('no composed status in this fixture'))
  getPlayers.mockResolvedValue({ players: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getBridgeStatus.mockResolvedValue({ configured: false, isRunning: false, modConnected: false, modStatus: null })
  getPanelInfo.mockResolvedValue({ localIp: '10.0.0.5', port: 8080, url: 'http://10.0.0.5:8080' })
  getConsoleErrorCount.mockResolvedValue({ exists: false, count: 0 })
  getAppSettings.mockResolvedValue({ settings: {} })
  getBackupStatus.mockResolvedValue({ lastBackup: null, backupCount: 1 })
  getModsStatus.mockResolvedValue({ updatesAvailable: 0, totalModsTracked: 0 })
  getSchedulerTasks.mockResolvedValue({ tasks: [] })
  getSchedulerStatus.mockResolvedValue({ nextRun: null })
  getPerformanceHistory.mockResolvedValue({ history: [] })
  getPanelUpdateStatus.mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null,
    releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
    downloadProgress: 0, lastCheck: null, lastError: null, stagedUpdate: null, lastApplyResult: null,
  })
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Dashboard />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

describe('Dashboard.tsx: Auto-start sends a boolean setting', () => {
  it('sends both checked states as JSON booleans, not strings', async () => {
    await setUpCommon()
    const offline = makeServer()
    getResolvedActive.mockResolvedValue({ server: offline })
    getStatus.mockResolvedValue({
      running: false, startTime: null, uptime: 0, serverPath: 'C:/servers/ashenwood',
      configured: true, rcon: { host: '', port: 0, connected: false },
    } as Awaited<ReturnType<typeof serverApi.getStatus>>)
    updateAppSettings.mockResolvedValue({ success: true })

    renderDashboard()

    await screen.findAllByRole('button', { name: 'Start' })
    const checkbox = document.getElementById('autoStartServer')
    expect(checkbox).toBeInTheDocument()
    fireEvent.click(checkbox!)

    await waitFor(() => {
      expect(updateAppSettings).toHaveBeenCalledWith({ autoStartServer: true })
    }, { timeout: 500 })

    fireEvent.click(checkbox!)

    await waitFor(() => {
      expect(updateAppSettings).toHaveBeenLastCalledWith({ autoStartServer: false })
    }, { timeout: 500 })
  })
})

async function openMoreActionsMenu() {
  // Radix's DropdownMenuTrigger opens on pointerdown, not click (same
  // family of quirk as Tabs switching on mousedown -- see
  // Console.test.tsx's openRconTab) -- a plain fireEvent.click never
  // dispatches pointerdown, so the menu would never open and
  // findByRole('menu') would sit at the suite's 60000ms asyncUtilTimeout
  // instead of failing fast.
  const trigger = await screen.findByRole('button', { name: /more server actions/i })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCanControl = true
  mockCanWipe = true
})

describe('Dashboard.tsx: Start is gated on server.control at BOTH of its entry points', () => {
  it('lacking server.control: only the header Start button renders, disabled, and clicking it never calls the API', async () => {
    mockCanControl = false
    await setUpCommon()
    const offline = makeServer()
    getResolvedActive.mockResolvedValue({ server: offline })
    getStatus.mockResolvedValue({
      running: false, startTime: null, uptime: 0, serverPath: 'C:/servers/ashenwood',
      configured: true, rcon: { host: '', port: 0, connected: false },
    } as Awaited<ReturnType<typeof serverApi.getStatus>>)

    renderDashboard()

    const startButtons = await screen.findAllByRole('button', { name: 'Start' })
    // The verdict band's shortcut is OMITTED (not shown disabled) when the
    // capability is missing -- it has no tooltip support, so only the
    // header button (which does) should exist.
    expect(startButtons).toHaveLength(1)
    expect(startButtons[0]).toBeDisabled()

    fireEvent.click(startButtons[0])
    expect(start).not.toHaveBeenCalled()
  })

  it('holding server.control: both the header Start button and the verdict shortcut render, enabled', async () => {
    mockCanControl = true
    await setUpCommon()
    const offline = makeServer()
    getResolvedActive.mockResolvedValue({ server: offline })
    getStatus.mockResolvedValue({
      running: false, startTime: null, uptime: 0, serverPath: 'C:/servers/ashenwood',
      configured: true, rcon: { host: '', port: 0, connected: false },
    } as Awaited<ReturnType<typeof serverApi.getStatus>>)

    renderDashboard()

    // findAllByRole resolves as soon as it finds ANY match, not once the
    // render has settled -- activeServer/status arrive async, so the
    // verdict band's second Start button can still be one render behind
    // the header's. waitFor to the final, stable count instead.
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Start' })).toHaveLength(2))
    for (const button of screen.getAllByRole('button', { name: 'Start' })) expect(button).not.toBeDisabled()
  })
})

describe('Dashboard.tsx: Stop/Force Stop/Restart/Save share server.control, gated at the real execution point', () => {
  async function setUpOnlineServer() {
    const online = makeServer()
    getResolvedActive.mockResolvedValue({ server: online })
    getStatus.mockResolvedValue({
      running: true, startTime: '2026-08-27T00:00:00.000Z', uptime: 120, serverPath: 'C:/servers/ashenwood',
      configured: true, rcon: { host: '127.0.0.1', port: 27015, connected: true },
    } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  }

  it('lacking server.control: Stop, Force Stop, Restart, and Save are all disabled, and none of them reach the API', async () => {
    mockCanControl = false
    await setUpCommon()
    await setUpOnlineServer()

    renderDashboard()

    const stopButton = await screen.findByRole('button', { name: 'Stop' })
    const forceStopButton = screen.getByRole('button', { name: /force stop/i })
    const restartButton = screen.getByRole('button', { name: 'Restart' })
    const saveButton = screen.getByRole('button', { name: 'Save' })

    for (const button of [stopButton, forceStopButton, restartButton, saveButton]) {
      expect(button).toBeDisabled()
    }

    for (const button of [stopButton, forceStopButton, restartButton, saveButton]) {
      fireEvent.click(button)
    }

    // Disabled buttons never open the confirm dialog -- no
    // handleAction()/AlertDialogAction path is reachable at all.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(stop).not.toHaveBeenCalled()
    expect(forceStop).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('lacking server.control: the Restart Now dropdown item is disabled and never calls restart', async () => {
    mockCanControl = false
    await setUpCommon()
    await setUpOnlineServer()

    renderDashboard()
    const menu = await openMoreActionsMenu()
    const restartNowItem = within(menu).getByRole('menuitem', { name: /restart now/i })
    expect(restartNowItem).toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(restartNowItem)
    // Not just "restart was never called" -- Radix's MenuItem fires this
    // onClick before ever consulting its own disabled prop, so the real
    // proof is that clicking it doesn't even open the confirm dialog that
    // would eventually call restart.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(restart).not.toHaveBeenCalled()
  })

  it('holding server.control: Stop, Force Stop, Restart, and Save are enabled, and confirming Stop calls the API', async () => {
    mockCanControl = true
    await setUpCommon()
    await setUpOnlineServer()

    renderDashboard()

    const stopButton = await screen.findByRole('button', { name: 'Stop' })
    expect(stopButton).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /force stop/i })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Restart' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled()

    fireEvent.click(stopButton)
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /stop server/i }))

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
  })

  // bug-hunt-2026-08-27: Pam found DisabledReason-inside-Trigger-asChild
  // silently breaks the GRANTED case (not the disabled one) on Players.tsx,
  // and flagged that a suite which only asserts toBeDisabled()/
  // not.toBeDisabled() would sit green through exactly that kind of break.
  // This page doesn't use that composition (grep confirms zero
  // AlertDialogTrigger/DialogTrigger usage -- both dialogs here are
  // open={state}-controlled), but the lesson applies regardless: prove the
  // granted path reaches the real API end to end, not just that the
  // control looks enabled.
  it('holding server.control: Restart Now opens its confirm dialog and calls restart(0) once confirmed', async () => {
    mockCanControl = true
    await setUpCommon()
    await setUpOnlineServer()

    renderDashboard()
    const menu = await openMoreActionsMenu()
    const restartNowItem = within(menu).getByRole('menuitem', { name: /restart now/i })
    expect(restartNowItem).not.toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(restartNowItem)
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /restart server now/i }))

    await waitFor(() => expect(restart).toHaveBeenCalledWith(0))
  })
})

describe('Dashboard.tsx: Wipe is gated on server.wipe, independently of server.control', () => {
  async function setUpOnlineServer() {
    const online = makeServer()
    getResolvedActive.mockResolvedValue({ server: online })
    getStatus.mockResolvedValue({
      running: true, startTime: '2026-08-27T00:00:00.000Z', uptime: 120, serverPath: 'C:/servers/ashenwood',
      configured: true, rcon: { host: '127.0.0.1', port: 27015, connected: true },
    } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  }

  it('holding server.control but lacking server.wipe: Wipe stays disabled while Stop stays enabled, and Wipe never opens its dialog', async () => {
    mockCanControl = true
    mockCanWipe = false
    await setUpCommon()
    await setUpOnlineServer()

    renderDashboard()

    const stopButton = await screen.findByRole('button', { name: 'Stop' })
    expect(stopButton).not.toBeDisabled()

    const menu = await openMoreActionsMenu()
    const wipeItem = within(menu).getByRole('menuitem', { name: /wipe server/i })
    expect(wipeItem).toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(wipeItem)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(wipePreview).not.toHaveBeenCalled()
    expect(wipe).not.toHaveBeenCalled()
  })

  // bug-hunt-2026-08-27, floor-wide re-check: the test above renders an
  // ONLINE server, so its `toHaveAttribute('aria-disabled', 'true')` check
  // is confounded -- `online` alone already satisfies this item's disabled
  // expression regardless of canWipeServer, same fixture bug found on the
  // sidebar Wipe button. Deleting only `|| !canWipeServer` from the
  // dropdown item's disabled prop left the test above still green (its
  // click-through assertion survives on the onClick guard alone, which
  // this edit didn't touch). This dedicated offline-fixture test isolates
  // canWipeServer as the ONLY thing keeping the item disabled.
  it('lacking server.wipe with the server OFFLINE (so canWipeServer is the only reason left): the dropdown Wipe item is still disabled and never opens its dialog', async () => {
    mockCanControl = true
    mockCanWipe = false
    await setUpCommon()
    const offline = makeServer()
    getResolvedActive.mockResolvedValue({ server: offline })
    getStatus.mockResolvedValue({
      running: false, startTime: null, uptime: 0, serverPath: 'C:/servers/ashenwood',
      configured: true, rcon: { host: '', port: 0, connected: false },
    } as Awaited<ReturnType<typeof serverApi.getStatus>>)

    renderDashboard()

    const menu = await openMoreActionsMenu()
    const wipeItem = within(menu).getByRole('menuitem', { name: /wipe server/i })
    expect(wipeItem).toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(wipeItem)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(wipePreview).not.toHaveBeenCalled()
    expect(wipe).not.toHaveBeenCalled()
  })

  it('holding both server.control and server.wipe: Wipe opens its dialog and reaches the real wipe API end to end', async () => {
    mockCanControl = true
    mockCanWipe = true
    await setUpCommon()
    // Wipe's menu item is also disabled while the server is online -- stop
    // it in this fixture so the capability grant is what's under test, not
    // the pre-existing running-server guard this fix must not weaken.
    const offline = makeServer()
    getResolvedActive.mockResolvedValue({ server: offline })
    getStatus.mockResolvedValue({
      running: false, startTime: null, uptime: 0, serverPath: 'C:/servers/ashenwood',
      configured: true, rcon: { host: '', port: 0, connected: false },
    } as Awaited<ReturnType<typeof serverApi.getStatus>>)
    wipePreview.mockResolvedValue({ totalFiles: 5, totalSize: 1024, preview: {} })
    wipe.mockResolvedValue({ success: true, backupCreated: false, backupName: null })

    renderDashboard()

    const menu = await openMoreActionsMenu()
    const wipeItem = within(menu).getByRole('menuitem', { name: /wipe server/i })
    expect(wipeItem).not.toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(wipeItem)
    const dialog = await screen.findByRole('alertdialog')

    // Not just "the dialog opened" -- the granted path has to survive both
    // steps of the existing preview-then-wipe flow this fix must not weaken.
    fireEvent.click(within(dialog).getByRole('button', { name: /^preview$/i }))
    const wipeNowButton = await within(dialog).findByRole('button', { name: /wipe now/i })
    expect(wipeNowButton).not.toBeDisabled()
    fireEvent.click(wipeNowButton)

    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1))
  })

  // bug-hunt-2026-08-27, stock-role hunt: this sidebar Maintenance-panel
  // button opens the exact same wipe dialog as the "..." dropdown item
  // above, but was missing canWipeServer entirely -- neither disabled nor
  // onClick-guarded -- so a role without server.wipe (both stock
  // TECHNICIAN and MODERATOR) could open the destructive dialog and only
  // hit unexplained disabled Preview/Wipe Now buttons inside it. Found by
  // an independent capability-gate audit, not by a user report.
  it('lacking server.wipe: the sidebar Maintenance Wipe Server button is disabled and never opens the dialog', async () => {
    mockCanControl = true
    mockCanWipe = false
    await setUpCommon()
    // Offline, not setUpOnlineServer() -- the button is already disabled
    // while online for an unrelated reason (must stop first), which would
    // mask whether canWipeServer is doing anything. An earlier draft of
    // this test used the online fixture and stayed green even with the
    // capability check removed entirely from the disabled prop -- caught
    // by break-verify, fixed by isolating the actual condition under test.
    const offline = makeServer()
    getResolvedActive.mockResolvedValue({ server: offline })
    getStatus.mockResolvedValue({
      running: false, startTime: null, uptime: 0, serverPath: 'C:/servers/ashenwood',
      configured: true, rcon: { host: '', port: 0, connected: false },
    } as Awaited<ReturnType<typeof serverApi.getStatus>>)

    renderDashboard()

    const wipeButton = await screen.findByRole('button', { name: /wipe server/i })
    expect(wipeButton).toBeDisabled()

    fireEvent.click(wipeButton)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(wipePreview).not.toHaveBeenCalled()
    expect(wipe).not.toHaveBeenCalled()
  })

  it('holding server.wipe: the sidebar Maintenance Wipe Server button opens the dialog and reaches the real wipe API end to end', async () => {
    mockCanControl = true
    mockCanWipe = true
    await setUpCommon()
    const offline = makeServer()
    getResolvedActive.mockResolvedValue({ server: offline })
    getStatus.mockResolvedValue({
      running: false, startTime: null, uptime: 0, serverPath: 'C:/servers/ashenwood',
      configured: true, rcon: { host: '', port: 0, connected: false },
    } as Awaited<ReturnType<typeof serverApi.getStatus>>)
    wipePreview.mockResolvedValue({ totalFiles: 5, totalSize: 1024, preview: {} })
    wipe.mockResolvedValue({ success: true, backupCreated: false, backupName: null })

    renderDashboard()

    const wipeButton = await screen.findByRole('button', { name: /wipe server/i })
    expect(wipeButton).not.toBeDisabled()

    fireEvent.click(wipeButton)
    const dialog = await screen.findByRole('alertdialog')

    fireEvent.click(within(dialog).getByRole('button', { name: /^preview$/i }))
    const wipeNowButton = await within(dialog).findByRole('button', { name: /wipe now/i })
    expect(wipeNowButton).not.toBeDisabled()
    fireEvent.click(wipeNowButton)

    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1))
  })
})
