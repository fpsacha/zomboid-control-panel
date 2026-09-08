import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Scheduler from '../Scheduler'
import { schedulerApi, serverApi, serversApi, type ServerInstance } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'

// 2026-09-08 (Angela's is-running enumeration, GH#114-shaped): Manual
// Restart and Quick Broadcasts were disabled off the raw local process scan
// (serverApi.getStatus()) with no provider awareness at all -- for a
// docker-local or remote-sftp server the scan can never see the process,
// so `serverRunning` was permanently false and these non-destructive
// controls stayed disabled on a server that was genuinely up. The mirror
// image of the "Stop button disabled on a running docker server" bug.
// Fixed by routing through resolveServerRunning() (client/src/lib/
// serverStatus.ts), collapsing its tri-state answer the same way
// ServerConfig.tsx's own serverMayBeRunning does (`!== false` -- unknown
// stays enabled, since restarting/broadcasting to an already-stopped
// server just fails cleanly server-side).

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
    schedulerApi: {
      ...actual.schedulerApi,
      getTasks: vi.fn(),
      getCronPresets: vi.fn(),
      getStatus: vi.fn(),
      getHistory: vi.fn(),
      setTimezone: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getAll: vi.fn(), getComposedStatus: vi.fn() },
    serverApi: { ...actual.serverApi, getStatus: vi.fn() },
  }
})

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))

const getTasks = vi.mocked(schedulerApi.getTasks)
const getCronPresets = vi.mocked(schedulerApi.getCronPresets)
const getStatus = vi.mocked(schedulerApi.getStatus)
const getHistory = vi.mocked(schedulerApi.getHistory)
const serversGetAll = vi.mocked(serversApi.getAll)
const getComposedStatus = vi.mocked(serversApi.getComposedStatus)
const serverGetStatus = vi.mocked(serverApi.getStatus)

const dockerServer = {
  id: 1,
  name: 'Docker Server',
  serverName: 'Docker Server',
  isRemote: false,
  isActive: true,
  dockerContainerName: 'pz-container',
} as unknown as ServerInstance

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderScheduler() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Scheduler />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function baseMocks() {
  getTasks.mockResolvedValue({ tasks: [] })
  getCronPresets.mockResolvedValue({ presets: [] })
  getHistory.mockResolvedValue({ history: [] })
  getStatus.mockResolvedValue({ activeTasks: 0, autoRestartEnabled: false, modUpdateRestartPending: false })
}

describe('Scheduler.tsx: Manual Restart / Quick Broadcasts gate on the provider-aware running check', () => {
  it('enables Restart and Broadcast controls for a running docker-local server the raw scan reports as stopped', async () => {
    await baseMocks()
    serversGetAll.mockResolvedValue({ servers: [dockerServer] })
    // The raw local scan is blind to this container.
    serverGetStatus.mockResolvedValue({ running: false } as Awaited<ReturnType<typeof serverApi.getStatus>>)
    getComposedStatus.mockResolvedValue({
      provider: 'docker-local',
      host: { status: 'running' },
      server: { status: 'connected' },
      bridge: { status: 'active' },
    } as Awaited<ReturnType<typeof serversApi.getComposedStatus>>)

    renderScheduler()

    const restartButton = await screen.findByRole('button', { name: 'Restart in 15m' })
    expect(restartButton).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Maintenance Start' })).toBeEnabled()
  })

  it('keeps the controls disabled once the composed status confirms the docker-local server is actually stopped', async () => {
    await baseMocks()
    serversGetAll.mockResolvedValue({ servers: [dockerServer] })
    serverGetStatus.mockResolvedValue({ running: false } as Awaited<ReturnType<typeof serverApi.getStatus>>)
    getComposedStatus.mockResolvedValue({
      provider: 'docker-local',
      host: { status: 'stopped' },
      server: { status: 'disconnected' },
      bridge: { status: 'inactive' },
    } as Awaited<ReturnType<typeof serversApi.getComposedStatus>>)

    renderScheduler()

    const restartButton = await screen.findByRole('button', { name: 'Restart in 15m' })
    expect(restartButton).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Maintenance Start' })).toBeDisabled()
  })
})
