import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, updateApi, type ServerInstance,
} from '@/lib/api'

// bug-hunt-2026-09-04: 'subscribe:perf' was only ever emitted once, when the
// perf-subscription effect first ran. Room membership is server-side
// per-connection state, lost on every socket.io disconnect/reconnect even
// though the client reuses the same Socket object -- after any reconnect the
// server no longer had this client in the perf room, so perf:snapshot
// silently stopped arriving and the chart just went quiet with no error.
// Fixed by copying Console.tsx's own subscribeRcon pattern: re-emit on every
// 'connect', not just on mount. This proves the wiring, not just that it
// compiles -- without it, the next "simplify this effect back to mount-only"
// edit gets a green suite.

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
    serverApi: {
      ...actual.serverApi,
      getStatus: vi.fn(),
      getPanelInfo: vi.fn(),
      getConsoleErrorCount: vi.fn(),
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
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
  }
})

// A fake socket the test can fire 'connect' on directly, matching how the
// real socket.io client hands the app plain on/off/emit/connected.
const socketHandlers = vi.hoisted(() => new Map<string, Set<() => void>>())
const emitSpy = vi.hoisted(() => vi.fn())
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({
    connected: true,
    on: (event: string, handler: () => void) => {
      if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
      socketHandlers.get(event)!.add(handler)
    },
    off: (event: string, handler: () => void) => {
      socketHandlers.get(event)?.delete(handler)
    },
    emit: emitSpy,
  }),
}))
function fireSocketConnect() {
  socketHandlers.get('connect')?.forEach((h) => h())
}

const getStatus = vi.mocked(serverApi.getStatus)
const getPanelInfo = vi.mocked(serverApi.getPanelInfo)
const getConsoleErrorCount = vi.mocked(serverApi.getConsoleErrorCount)
const getComposedStatus = vi.mocked(serversApi.getComposedStatus)
const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
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
const getUpdateCheckStatus = vi.mocked(updateApi.getStatus)

function makeServer(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: 'C:/servers/ashenwood',
    zomboidDataPath: null, serverConfigPath: null, rconHost: '127.0.0.1', rconPort: 27015,
    rconPassword: 'hunter2', serverPort: 16261, minMemory: 2048, maxMemory: 4096,
    useNoSteam: false, useDebug: false, isRemote: false, isActive: true, startCommand: '',
    adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

function setUpCommon() {
  getComposedStatus.mockRejectedValue(new Error('no composed status in this fixture'))
  getPlayers.mockResolvedValue({ players: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getBridgeStatus.mockResolvedValue({ configured: false, isRunning: false, modConnected: false, modStatus: null })
  getZombieCount.mockRejectedValue(new Error('no bridge in this fixture'))
  getWorldStats.mockRejectedValue(new Error('no bridge in this fixture'))
  getUpdateCheckStatus.mockResolvedValue({
    updateAvailable: null, gameVersion: null, lastCheck: null,
    intervalMinutes: 60, isChecking: false, lastAutoUpdateResult: null,
  })
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
  getResolvedActive.mockResolvedValue({ server: makeServer() })
  getStatus.mockResolvedValue({
    running: false, startTime: null, uptime: 0, serverPath: 'C:/servers/ashenwood',
    serverPathConfigured: true, rcon: { host: '', port: 0, connected: false },
  } as Awaited<ReturnType<typeof serverApi.getStatus>>)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  socketHandlers.clear()
})

function renderDashboard() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Dashboard />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('Dashboard.tsx: perf-chart subscription survives a socket reconnect', () => {
  it('re-emits subscribe:perf on every connect event, not just on mount', async () => {
    setUpCommon()

    renderDashboard()
    // Real timers here, deliberately: the reveal effect races
    // requestIdleCallback (timeout: 1500) against a setTimeout(reveal, 300)
    // fallback, and whichever one jsdom/vitest actually provides isn't
    // worth pinning down -- waiting past the longer of the two in real
    // wall-clock time reaches the same state either way.
    await act(async () => { await sleep(1700) })

    await waitFor(() => expect(emitSpy).toHaveBeenCalledWith('subscribe:perf'))
    const callsBeforeReconnect = emitSpy.mock.calls.filter((c) => c[0] === 'subscribe:perf').length
    expect(callsBeforeReconnect).toBeGreaterThanOrEqual(1)

    act(() => { fireSocketConnect() })

    const callsAfterReconnect = emitSpy.mock.calls.filter((c) => c[0] === 'subscribe:perf').length
    expect(callsAfterReconnect).toBeGreaterThan(callsBeforeReconnect)
  }, 10000)
})
