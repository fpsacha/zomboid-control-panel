import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Scheduler from '../Scheduler'
import { backupApi, schedulerApi, serverApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'
import enScheduler from '../../locales/en/scheduler.json'

// SECURITY: the restart countdown text is a server broadcast, so writing
// one's own takes server.world_events (server/routes/scheduler.js PUT
// /restart-warning); a language's preset does not. The text field is read
// only without it, and says why.

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'scheduler', capabilities: [] },
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
    schedulerApi: {
      ...actual.schedulerApi,
      getTasks: vi.fn(),
      getCronPresets: vi.fn(),
      getStatus: vi.fn(),
      getHistory: vi.fn(),
      setRestartWarning: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    serverApi: { ...actual.serverApi, getStatus: vi.fn() },
    backupApi: { ...actual.backupApi, getStatus: vi.fn() },
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCan = () => true
})

function setUp() {
  vi.mocked(schedulerApi.getTasks).mockResolvedValue({ tasks: [] })
  vi.mocked(schedulerApi.getCronPresets).mockResolvedValue({ presets: [] })
  vi.mocked(schedulerApi.getHistory).mockResolvedValue({ history: [] })
  vi.mocked(schedulerApi.getStatus).mockResolvedValue({
    activeTasks: 0,
    autoRestartEnabled: false,
    modUpdateRestartPending: false,
    timezone: 'UTC',
    configuredTimezone: 'UTC',
    timezoneFallback: null,
    restartWarning: { locale: 'en', template: 'Restart in {count} {unit}' },
    restartWarningPresets: { en: 'Restart in {count} {unit}' },
  } as unknown as Awaited<ReturnType<typeof schedulerApi.getStatus>>)
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [] })
  vi.mocked(serverApi.getStatus).mockResolvedValue({ running: true } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  vi.mocked(backupApi.getStatus).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof backupApi.getStatus>>)
}

function renderScheduler() {
  return render(
    <MemoryRouter initialEntries={['/scheduler']}>
      <TooltipProvider>
        <Scheduler />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

describe('Scheduler.tsx: the restart warning text needs server.world_events', () => {
  it('keeps the text read only, and says why, without server.world_events', async () => {
    mockCan = (capability) => capability !== 'server.world_events'
    setUp()
    renderScheduler()

    const template = await screen.findByLabelText(enScheduler.restartWarning.templateLabel)
    await waitFor(() => expect(template).toHaveValue('Restart in {count} {unit}'))
    expect(template).toBeDisabled()
    expect(screen.getByText(enScheduler.restartWarning.templateNoPermission)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: enScheduler.restartWarning.presetButton })).not.toBeDisabled()
  })

  it('leaves it editable with server.world_events', async () => {
    mockCan = () => true
    setUp()
    renderScheduler()

    const template = await screen.findByLabelText(enScheduler.restartWarning.templateLabel)
    await waitFor(() => expect(template).toHaveValue('Restart in {count} {unit}'))
    expect(template).not.toBeDisabled()
    expect(screen.queryByText(enScheduler.restartWarning.templateNoPermission)).not.toBeInTheDocument()
  })
})
