import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi,
} from '@/lib/api'

// docker-unraid-add-server-experience, Q1 routing fix (2026-09-09, god):
// "the visually PRIMARY button on the first screen a new user sees
// (Dashboard.tsx:1649-1657) sends an Unraid user with existing files to
// /server-setup, which never attempts discovery at all... fix the ROUTING,
// not just the banner." Two changes under test: (1) exactly one
// status:'ready' discovery candidate replaces the generic 3-button choice
// with a single specific action (Angela's mechanical rule, rule 3: one
// confident match means auto-use it, not a picker); (2) with zero or
// multiple candidates, a containerized deployment swaps which of the two
// remaining buttons is visually primary, since "existing files" is the
// overwhelmingly common case for that topology.

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

let mockServiceManager: 'systemd' | 'openrc' | 'container' | 'none' | 'unknown' = 'none'
vi.mock('@/hooks/useRuntimeInfo', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useRuntimeInfo')>('@/hooks/useRuntimeInfo')
  return {
    ...actual,
    useRuntimeInfo: () => ({
      platform: 'linux',
      family: 'posix' as const,
      pathSeparator: '/',
      temporaryDirectory: '/tmp',
      serviceManager: mockServiceManager,
      restartAssessment: { safe: true, reasons: [] },
    }),
  }
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
    },
    serversApi: {
      ...actual.serversApi,
      getComposedStatus: vi.fn(),
      getResolvedActive: vi.fn(),
      discoverMounts: vi.fn(),
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
const getComposedStatus = vi.mocked(serversApi.getComposedStatus)
const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const discoverMounts = vi.mocked(serversApi.discoverMounts)
const getPlayers = vi.mocked(playersApi.getPlayers)
const getActivityLogs = vi.mocked(playersApi.getActivityLogs)
const getBridgeStatus = vi.mocked(panelBridgeApi.getStatus)
const getBackupStatus = vi.mocked(backupApi.getStatus)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const getPerformanceHistory = vi.mocked(debugApi.getPerformanceHistory)
const getPanelUpdateStatus = vi.mocked(panelUpdateApi.getStatus)
const getModsStatus = vi.mocked(modsApi.getStatus)
const getSchedulerTasks = vi.mocked(schedulerApi.getTasks)
const getSchedulerStatus = vi.mocked(schedulerApi.getStatus)

async function setUpCommon() {
  getComposedStatus.mockRejectedValue(new Error('no composed status in this fixture'))
  getStatus.mockResolvedValue({} as never)
  getResolvedActive.mockResolvedValue({ server: null })
  discoverMounts.mockResolvedValue({ mounts: [], inaccessible: [], candidates: [] })
  getPlayers.mockResolvedValue({ players: [] } as never)
  getActivityLogs.mockResolvedValue({ logs: [] } as never)
  getBridgeStatus.mockResolvedValue({ configured: false, isRunning: false, modConnected: false, modStatus: null } as never)
  getPanelInfo.mockResolvedValue({ localIp: '10.0.0.5', port: 8080, url: 'http://10.0.0.5:8080' })
  getConsoleErrorCount.mockResolvedValue({ exists: false, count: 0 } as never)
  getAppSettings.mockResolvedValue({ settings: {} } as never)
  getBackupStatus.mockResolvedValue({ lastBackup: null, backupCount: 1 } as never)
  getModsStatus.mockResolvedValue({ updatesAvailable: 0, totalModsTracked: 0 } as never)
  getSchedulerTasks.mockResolvedValue({ tasks: [] } as never)
  getSchedulerStatus.mockResolvedValue({ nextRun: null } as never)
  getPerformanceHistory.mockResolvedValue({ history: [] } as never)
  getPanelUpdateStatus.mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null,
    releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
    downloadProgress: 0, lastCheck: null, lastError: null, stagedUpdate: null, lastApplyResult: null,
  } as never)
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockServiceManager = 'none'
  try { localStorage.clear() } catch { /* ignore */ }
})

describe('Dashboard.tsx Quick-Start card: routes toward discovery instead of always defaulting to the SteamCMD wizard', () => {
  it('exactly one ready discovery candidate replaces the generic choice with a single specific action naming the found path', async () => {
    await setUpCommon()
    discoverMounts.mockResolvedValue({
      mounts: [],
      inaccessible: [],
      candidates: [{
        installPath: '/pz-server',
        dataPath: '/zomboid',
        source: 'common-mount',
        status: 'ready',
        reason: 'Found a complete Project Zomboid server here.',
        serverNames: ['servertest'],
        hasStartScript: true,
        hasPanelBridge: false,
      }],
    })

    renderDashboard()

    expect(await screen.findByText('We found an existing Project Zomboid server')).toBeInTheDocument()
    expect(screen.getByText('/pz-server')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Review & Connect/i })).toHaveAttribute('href', '/servers')
    // The generic 3-step layout and its 3-button choice must be GONE, not
    // just supplemented -- one decision per screen.
    expect(screen.queryByRole('link', { name: /Add Remote Server/i })).not.toBeInTheDocument()
  })

  it('two ready candidates (genuine ambiguity) keep the generic layout instead of guessing which one', async () => {
    await setUpCommon()
    const candidate = {
      installPath: '/pz-server',
      dataPath: '/zomboid',
      source: 'common-mount',
      status: 'ready' as const,
      reason: 'Found a complete Project Zomboid server here.',
      serverNames: ['servertest'],
      hasStartScript: true,
      hasPanelBridge: false,
    }
    discoverMounts.mockResolvedValue({
      mounts: [],
      inaccessible: [],
      candidates: [candidate, { ...candidate, installPath: '/pz-server-2' }],
    })

    renderDashboard()

    expect(await screen.findByRole('link', { name: /Add Remote Server/i })).toBeInTheDocument()
    expect(screen.queryByText('We found an existing Project Zomboid server')).not.toBeInTheDocument()
  })

  it('containerized with no ready candidate: "Add Existing Server" becomes the visually primary button, not "Install New Server"', async () => {
    mockServiceManager = 'container'
    await setUpCommon()

    renderDashboard()

    const installNew = await screen.findByRole('link', { name: /Install New Server/i })
    const addExisting = screen.getByRole('link', { name: /Add Existing Server/i })
    await waitFor(() => expect(discoverMounts).toHaveBeenCalled())

    expect(addExisting.className).toContain('bg-primary')
    expect(installNew.className).not.toContain('bg-primary')
  })

  it('NOT containerized: "Install New Server" stays the primary button, unchanged from before this fix', async () => {
    mockServiceManager = 'none'
    await setUpCommon()

    renderDashboard()

    const installNew = await screen.findByRole('link', { name: /Install New Server/i })
    const addExisting = screen.getByRole('link', { name: /Add Existing Server/i })

    expect(installNew.className).toContain('bg-primary')
    expect(addExisting.className).not.toContain('bg-primary')
  })
})
