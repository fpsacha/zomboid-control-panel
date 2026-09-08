import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/toaster'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, type ServerInstance,
} from '@/lib/api'
import * as serverStatusLib from '@/lib/serverStatus'

// dashboard-loading-clears-on-acceptance-not-confirmation (medium, per god:
// "the panel reporting a thing as finished when it only STARTED... the same
// dishonesty we have been closing all night"): Start/Stop/Force-stop's
// `fn()` resolving only proves the request was ACCEPTED -- `loading` (which
// disables every action button on the page, not just the one clicked) used
// to clear the instant that happened, re-enabling every button before the
// server actually reached the expected state. Fix awaits Servers.tsx's own
// waitForServerState() (reused, not a second polling primitive) before
// clearing `loading`, bounded by that function's own timeout so a stuck
// button (worse than a premature one -- unrecoverable without a reload)
// can never happen.
//
// waitForServerState's OWN polling/timeout/scanFailed-exclusion behavior is
// already covered by lib/__tests__/serverStatus.test.ts -- these tests mock
// it as a black box and assert only Dashboard's USE of the result: does the
// button stay disabled while it's pending, does a timeout produce an honest
// render instead of a silent success claim, and does an unmount mid-poll
// avoid setState on the way out.

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

vi.mock('@/lib/serverStatus', async () => {
  const actual = await vi.importActual<typeof import('@/lib/serverStatus')>('@/lib/serverStatus')
  return { ...actual, waitForServerState: vi.fn() }
})

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
    },
    serversApi: { ...actual.serversApi, getComposedStatus: vi.fn(), getResolvedActive: vi.fn(), getStatus: vi.fn() },
    playersApi: { ...actual.playersApi, getPlayers: vi.fn(), getActivityLogs: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      getZombieCount: vi.fn(),
      getWorldStats: vi.fn(),
    },
    backupApi: { ...actual.backupApi, getStatus: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn(), updateAppSettings: vi.fn() },
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
const getComposedStatus = vi.mocked(serversApi.getComposedStatus)
const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getBulkStatus = vi.mocked(serversApi.getStatus)
const getPlayers = vi.mocked(playersApi.getPlayers)
const getActivityLogs = vi.mocked(playersApi.getActivityLogs)
const getBridgeStatus = vi.mocked(panelBridgeApi.getStatus)
const getZombieCount = vi.mocked(panelBridgeApi.getZombieCount)
const getWorldStats = vi.mocked(panelBridgeApi.getWorldStats)
const getBackupStatus = vi.mocked(backupApi.getStatus)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const getPerformanceHistory = vi.mocked(debugApi.getPerformanceHistory)
const getPanelUpdateStatus = vi.mocked(panelUpdateApi.getStatus)
const getModsStatus = vi.mocked(modsApi.getStatus)
const getSchedulerTasks = vi.mocked(schedulerApi.getTasks)
const getSchedulerStatus = vi.mocked(schedulerApi.getStatus)
const waitForServerState = vi.mocked(serverStatusLib.waitForServerState)

function makeServer(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: 'C:/servers/ashenwood',
    zomboidDataPath: null, serverConfigPath: null, rconHost: '127.0.0.1', rconPort: 27015,
    rconPassword: 'hunter2', serverPort: 16261, minMemory: 2048, maxMemory: 4096,
    useNoSteam: false, useDebug: false, isRemote: false, isActive: true, startCommand: '',
    adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

async function setUpCommon(running: boolean) {
  const server = makeServer()
  getResolvedActive.mockResolvedValue({ server })
  getStatus.mockResolvedValue({
    running, startTime: running ? new Date().toISOString() : null, uptime: running ? 600 : 0,
    serverPath: 'C:/servers/ashenwood', serverPathConfigured: true,
    rcon: { host: '127.0.0.1', port: 27015, connected: running },
  } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  getComposedStatus.mockRejectedValue(new Error('no composed status in this fixture'))
  getBulkStatus.mockResolvedValue({ servers: [], detectedProcesses: 0, detectionError: null })
  getPlayers.mockResolvedValue({ players: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getPanelInfo.mockResolvedValue({ localIp: '10.0.0.5', port: 8080, url: 'http://10.0.0.5:8080' })
  getConsoleErrorCount.mockResolvedValue({ exists: true, count: 0 })
  getAppSettings.mockResolvedValue({ settings: {} })
  getBackupStatus.mockResolvedValue({ lastBackup: null, backupCount: 8 })
  getModsStatus.mockResolvedValue({ updatesAvailable: 0, totalModsTracked: 108 })
  getSchedulerTasks.mockResolvedValue({ tasks: [{ id: 1 }] })
  getSchedulerStatus.mockResolvedValue({ nextRun: null })
  getPerformanceHistory.mockResolvedValue({ history: [] })
  getPanelUpdateStatus.mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null,
    releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
    downloadProgress: 0, lastCheck: null, lastError: null, stagedUpdate: null, lastApplyResult: null,
  })
  getBridgeStatus.mockResolvedValue({
    configured: true, isRunning: true, modConnected: true,
    modStatus: { alive: true, version: '1.7.50', serverName: 'Ashenwood', playerCount: 0 },
  })
  getZombieCount.mockResolvedValue({ success: true, data: { zombieCount: 0, note: '' } })
  getWorldStats.mockResolvedValue({ success: true, data: { serverName: 'Ashenwood', map: 'Muldraugh, KY', zombiesInCell: 0 } })
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Dashboard />
        <Toaster />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

// VerdictBand renders its own "Start" shortcut for the same action (see
// Dashboard.tsx's own comment: "Two of the six server.control triggers on
// this page ... call handleAction() directly" -- this header button and
// that one) -- a bare name match finds both. Scope to the status header's
// own primary controls, which is the one under test.
async function findPrimaryStartButton() {
  const header = await screen.findByRole('banner', { name: /server status/i })
  return within(header).getByRole('button', { name: /^start$/i })
}

// A promise this test controls the resolution of -- lets a test observe
// Dashboard's state WHILE the confirmation poll is still pending, something
// a plain mockResolvedValue can't do.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Dashboard.tsx: Start/Stop/Force-stop stay disabled through confirmation, not just acceptance', () => {
  it('Start button stays disabled while the confirmation poll is pending, and re-enables only once it resolves', async () => {
    await setUpCommon(false)
    start.mockResolvedValue({ success: true })
    const gate = deferred<boolean>()
    waitForServerState.mockReturnValue(gate.promise)

    renderDashboard()
    const startBtn = await findPrimaryStartButton()
    expect(startBtn).not.toBeDisabled()

    fireEvent.click(startBtn)

    // fn() (serverApi.start) has resolved by now, but the poll has not --
    // this is exactly the window the old code cleared `loading` in.
    await waitFor(() => expect(start).toHaveBeenCalled())
    expect(startBtn).toBeDisabled()

    gate.resolve(true)
    await waitFor(() => expect(startBtn).not.toBeDisabled())
  })

  it('break-verify control: Start button re-enables immediately once the (already-resolved) poll confirms -- proves the harness detects re-enable, not just disable', async () => {
    await setUpCommon(false)
    start.mockResolvedValue({ success: true })
    waitForServerState.mockResolvedValue(true)

    renderDashboard()
    const startBtn = await findPrimaryStartButton()
    fireEvent.click(startBtn)

    await waitFor(() => expect(startBtn).not.toBeDisabled())
    expect(waitForServerState).toHaveBeenCalled()
  })

  it('Stop: on poll timeout (confirmed:false), shows the existing "Shutdown requested" copy instead of a silent/confident success claim', async () => {
    await setUpCommon(true)
    stop.mockResolvedValue({ success: true })
    waitForServerState.mockResolvedValue(false)

    renderDashboard()
    fireEvent.click(await screen.findByRole('button', { name: /^stop$/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop server', hidden: true }))

    await waitFor(() => expect(stop).toHaveBeenCalled())
    // Reused verbatim from the server-reported confirmed:false case this
    // fix folds into -- no new copy invented for Stop.
    await screen.findByText('Shutdown requested')
    await screen.findByText(/status badge will update once it's confirmed stopped/i)
  })

  // React 18 removed the classic "Can't perform a React state update on an
  // unmounted component" console warning outright (confirmed by hand: the
  // console.error-spy version of this test still passed with the guards
  // deleted -- a genuinely broken break-verify, caught before landing
  // rather than after). setState after unmount is now a silent no-op with
  // nothing to catch via a console spy, so this asserts the guard's actual
  // OBSERABLE effect instead: fetchStatus() (which the mountedRef check
  // wraps) calls serverApi.getStatus() -- if the guard is doing nothing,
  // that call fires again after unmount; if it's load-bearing, it doesn't.
  it('unmount guard: fetchStatus() (and therefore setStatus) does not run again after unmounting mid-poll', async () => {
    await setUpCommon(true)
    stop.mockResolvedValue({ success: true })
    const gate = deferred<boolean>()
    waitForServerState.mockReturnValue(gate.promise)

    const { unmount } = renderDashboard()
    fireEvent.click(await screen.findByRole('button', { name: /^stop$/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop server', hidden: true }))
    await waitFor(() => expect(stop).toHaveBeenCalled())
    const callsBeforeUnmount = getStatus.mock.calls.length

    unmount()
    // Resolve the poll AFTER unmount -- this is the exact window
    // mountedRef guards. Flush microtasks so handleAction's continuation
    // actually runs before asserting nothing fired.
    gate.resolve(false)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(getStatus.mock.calls.length).toBe(callsBeforeUnmount)
  })
})
