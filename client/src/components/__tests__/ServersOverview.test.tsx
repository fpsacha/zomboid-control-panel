import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ServersOverview } from '@/components/dashboard/ServersOverview'
import { ApiError, backupApi, serversApi, type ServerInstance } from '@/lib/api'

// Every server on the Dashboard at once: state, players, auto-start and
// restart-if-it-goes-down for each, and Start, Stop and Restart for the
// servers other than the active one, without switching to them.

let mockCanManage = true
let mockCanControl = true
let mockCanRcon = true
type Handler = () => void
let mockSocket: { on: (event: string, handler: Handler) => void; off: (event: string, handler: Handler) => void } | null = null
const mockToast = vi.fn()

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    can: (capability: string) =>
      capability === 'servers.manage' ? mockCanManage
        : capability === 'server.control' ? mockCanControl
        : capability === 'rcon.execute' ? mockCanRcon
        : true,
  }),
}))

vi.mock('@/contexts/SocketContext', () => ({ useSocket: () => mockSocket }))

vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serversApi: {
      ...actual.serversApi,
      getAll: vi.fn(),
      getStatus: vi.fn(),
      getRconStatuses: vi.fn(),
      activate: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      getUpdates: vi.fn(),
      getLifecycle: vi.fn(),
    },
    backupApi: {
      ...actual.backupApi,
      getSummary: vi.fn(),
      updateSettings: vi.fn(),
    },
  }
})

const getAll = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(serversApi.getStatus)
const getRconStatuses = vi.mocked(serversApi.getRconStatuses)
const activate = vi.mocked(serversApi.activate)
const startServer = vi.mocked(serversApi.start)
const stopServer = vi.mocked(serversApi.stop)
const restartServer = vi.mocked(serversApi.restart)
const getUpdates = vi.mocked(serversApi.getUpdates)
const getLifecycle = vi.mocked(serversApi.getLifecycle)
const getBackupSummary = vi.mocked(backupApi.getSummary)
const updateBackupSettings = vi.mocked(backupApi.updateSettings)

function server(id: string, name: string, extra: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id, name, serverName: name, installPath: `/pz-servers/${name}`, zomboidDataPath: null, serverConfigPath: null,
    rconHost: '127.0.0.1', rconPort: 27015, rconPassword: '', serverPort: 16261, minMemory: 1, maxMemory: 8,
    useNoSteam: false, useDebug: false, isRemote: false, isActive: false, startCommand: '', adminPassword: '',
    createdAt: new Date(0).toISOString(), ...extra,
  }
}

const ALIVE = server('s1', 'LNKAlive', { isActive: true, serverPort: 16261 })
const OUTBREAK = server('s2', 'LNK-OUTBREAK', { serverPort: 16263 })
const HOSTED = server('s3', 'Hosted', { isRemote: true, serverPort: 16300 })
const ARENA = server('s4', 'Arena', { serverPort: 16265 })
const MYSTERY = server('s5', 'Mystery', { serverPort: 16267 })

function prime(servers: ServerInstance[], extra: { hostMemoryBytes?: number; memory?: Record<string, number>; disk?: Record<string, object> } = {}) {
  getLifecycle.mockResolvedValue({ lock: null, servers: [] })
  getUpdates.mockResolvedValue({ servers: [] } as never)
  getBackupSummary.mockResolvedValue({ servers: [], schedule: { enabled: true, serverIds: null } } as never)
  getAll.mockResolvedValue({ servers } as never)
  getStatus.mockResolvedValue({
    servers: [
      { id: 's1', name: 'LNKAlive', running: true, pid: '1', isActive: true, startedAt: null },
      { id: 's2', name: 'LNK-OUTBREAK', running: false, pid: null, isActive: false, startedAt: null },
      { id: 's3', name: 'Hosted', running: false, pid: null, isActive: false, startedAt: null },
      { id: 's4', name: 'Arena', running: true, pid: '4', isActive: false, startedAt: null },
      { id: 's5', name: 'Mystery', running: false, pid: null, isActive: false, startedAt: null, stateUnknown: true },
    ].map((row) => ({
      ...row,
      ...(extra.memory?.[row.id] ? { memoryBytes: extra.memory[row.id] } : {}),
      ...(extra.disk?.[row.id] ? { disk: extra.disk[row.id] } : {}),
    })),
    detectedProcesses: 2,
    detectionError: null,
    ...(extra.hostMemoryBytes ? { hostMemoryBytes: extra.hostMemoryBytes } : {}),
  } as never)
  getRconStatuses.mockResolvedValue({
    servers: [
      { id: 's1', status: 'connected', players: 3 },
      { id: 's2', status: 'unreachable', players: null },
      { id: 's3', status: 'connected', players: 7 },
      { id: 's4', status: 'connected', players: 0 },
      { id: 's5', status: 'unreachable', players: null },
    ],
  } as never)
}

function renderOverview(props: Partial<Parameters<typeof ServersOverview>[0]> = {}) {
  const onAutoStartChange = vi.fn()
  const onRestartOnCrashChange = vi.fn()
  const onShownChange = vi.fn()
  render(
    <TooltipProvider>
      <ServersOverview
        activeServerId="s1"
        autoStartSettings={{ autoStartServer: true, autoStartServerIds: ['s2'], restartOnCrashServerIds: ['s4'] }}
        canChangeAutoStart
        onAutoStartChange={onAutoStartChange}
        onRestartOnCrashChange={onRestartOnCrashChange}
        onShownChange={onShownChange}
        {...props}
      />
    </TooltipProvider>,
  )
  return { onAutoStartChange, onRestartOnCrashChange, onShownChange }
}

const rowOf = (name: string) => screen.getByText(name).closest('li') as HTMLElement

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCanManage = true
  mockCanControl = true
  mockCanRcon = true
  mockSocket = null
})

describe('ServersOverview', () => {
  it('says why a row\'s controls wait while another server holds the lifecycle lock, and follows its changes', async () => {
    const handlers: Record<string, (state?: unknown) => void> = {}
    mockSocket = { on: (event, handler) => { handlers[event] = handler }, off: vi.fn() }
    prime([ALIVE, OUTBREAK])
    getLifecycle.mockResolvedValue({
      lock: { operation: 'start', serverId: 's1', serverName: 'LNKAlive', phase: null, since: 1 },
      servers: [],
    })
    renderOverview()

    await screen.findByText('LNK-OUTBREAK')
    const startOf = () => within(rowOf('LNK-OUTBREAK')).getByRole('button', { name: 'Start LNK-OUTBREAK' })
    await waitFor(() => expect(startOf()).toBeDisabled())
    fireEvent.focus(startOf().parentElement!)
    expect((await screen.findAllByText('Start of LNKAlive in progress.')).length).toBeGreaterThan(0)
    fireEvent.click(startOf())
    expect(startServer).not.toHaveBeenCalled()

    // LNKAlive is up and only waits for its RCON now: the other server is free.
    act(() => handlers['lifecycle:state']({
      lock: null,
      servers: [{ operation: 'start', serverId: 's1', serverName: 'LNKAlive', phase: 'waiting-for-rcon', since: 1 }],
    }))
    await waitFor(() => expect(startOf()).not.toBeDisabled())
  })

  it('says what holds the lock when a click races it, instead of an error', async () => {
    prime([ALIVE, OUTBREAK])
    startServer.mockRejectedValue(new ApiError('busy', {
      status: 409,
      code: 'SERVER_LIFECYCLE_IN_PROGRESS',
      data: { holder: { operation: 'restart', serverId: 's1', serverName: 'LNKAlive', phase: null, since: 1 } },
    }))
    renderOverview()

    await screen.findByText('LNK-OUTBREAK')
    fireEvent.click(within(rowOf('LNK-OUTBREAK')).getByRole('button', { name: 'Start LNK-OUTBREAK' }))
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith({ title: 'Wait a moment', description: 'Restart of LNKAlive in progress.' }))
  })

  it('stays out of the way with a single server', async () => {
    prime([ALIVE])
    const { onShownChange } = renderOverview()

    await waitFor(() => expect(getAll).toHaveBeenCalled())
    expect(screen.queryByText('Servers')).not.toBeInTheDocument()
    expect(onShownChange).not.toHaveBeenCalledWith(true)
  })

  it('lists every server with its state, players, port and auto-start', async () => {
    prime([ALIVE, OUTBREAK, HOSTED])
    const { onShownChange } = renderOverview()

    expect(await screen.findByText('LNK-OUTBREAK')).toBeInTheDocument()
    await waitFor(() => expect(onShownChange).toHaveBeenLastCalledWith(true))
    expect(screen.getByText('2 of 3 running')).toBeInTheDocument()

    const alive = rowOf('LNKAlive')
    expect(within(alive).getByText('Active')).toBeInTheDocument()
    expect(within(alive).getByText('Running')).toBeInTheDocument()
    expect(within(alive).getByText('Players online: 3')).toBeInTheDocument()
    expect(within(alive).getByText(':16261')).toBeInTheDocument()
    // On, but only LNK-OUTBREAK is chosen.
    expect(within(alive).getByRole('checkbox', { name: 'Start with the panel' })).not.toBeChecked()

    const outbreak = rowOf('LNK-OUTBREAK')
    expect(within(outbreak).getByText('Stopped')).toBeInTheDocument()
    expect(within(outbreak).getByText('Players: unknown (RCON isn\'t answering)')).toBeInTheDocument()
    expect(within(outbreak).getByRole('checkbox', { name: 'Start with the panel' })).toBeChecked()

    // A remote server: up when its RCON answers, and its host starts it.
    const hosted = rowOf('Hosted')
    expect(within(hosted).getByText('Running')).toBeInTheDocument()
    expect(within(hosted).queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('counts nobody on a stopped server whose RCON port another server answers', async () => {
    prime([ALIVE, OUTBREAK])
    getRconStatuses.mockResolvedValue({
      servers: [
        { id: 's1', status: 'connected', players: 3 },
        { id: 's2', status: 'connected', players: 3 },
      ],
    } as never)
    renderOverview()

    await waitFor(() => expect(within(rowOf('LNKAlive')).getByText('Players online: 3')).toBeInTheDocument())
    expect(within(rowOf('LNK-OUTBREAK')).queryByText('Players online: 3')).not.toBeInTheDocument()
  })

  it('lists many installed and linked servers in a scrolling list, the active one first', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      server(`m${i}`, `Server ${i}`, { isRemote: i % 3 === 0, isActive: i === 7, serverPort: 16261 + i * 2 }))
    prime(many)
    renderOverview({ activeServerId: 'm7', autoStartSettings: { autoStartServer: false } })

    await screen.findByText('Server 11')
    const list = screen.getByTestId('servers-overview-list')
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(12)
    expect(within(rows[0]).getByText('Server 7')).toBeInTheDocument()
    expect(within(rows[0]).getByText('Active')).toBeInTheDocument()
    // Bounded height and scrollable, by keyboard too.
    expect(list).toHaveClass('sm:max-h-[24rem]', 'sm:overflow-y-auto')
    expect(list).toHaveAttribute('tabindex', '0')
  })

  it('hands an auto-start change for that row\'s server to the Dashboard', async () => {
    prime([ALIVE, OUTBREAK])
    const { onAutoStartChange } = renderOverview()

    await screen.findByText('LNK-OUTBREAK')
    fireEvent.click(within(rowOf('LNKAlive')).getByRole('checkbox', { name: 'Start with the panel' }))

    expect(onAutoStartChange).toHaveBeenCalledWith(ALIVE, true)
  })

  it('shows and hands over each local server\'s restart-if-it-goes-down choice', async () => {
    prime([ALIVE, ARENA, HOSTED])
    const { onRestartOnCrashChange } = renderOverview()

    await screen.findByText('Arena')
    expect(within(rowOf('Arena')).getByRole('checkbox', { name: 'Restart if it goes down' })).toBeChecked()
    const activeBox = within(rowOf('LNKAlive')).getByRole('checkbox', { name: 'Restart if it goes down' })
    expect(activeBox).not.toBeChecked()
    expect(within(rowOf('Hosted')).queryByRole('checkbox', { name: 'Restart if it goes down' })).not.toBeInTheDocument()

    fireEvent.click(activeBox)
    expect(onRestartOnCrashChange).toHaveBeenCalledWith(ALIVE, true)
  })

  it('offers Start for a stopped server and Stop and Restart for a running one, never for the active, a remote or an unknown one', async () => {
    prime([ALIVE, OUTBREAK, HOSTED, ARENA, MYSTERY])
    renderOverview()

    await screen.findByText('Mystery')
    expect(within(rowOf('LNK-OUTBREAK')).getByRole('button', { name: 'Start LNK-OUTBREAK' })).toBeEnabled()
    expect(within(rowOf('LNK-OUTBREAK')).queryByRole('button', { name: 'Stop LNK-OUTBREAK' })).not.toBeInTheDocument()
    expect(within(rowOf('Arena')).getByRole('button', { name: 'Stop Arena' })).toBeEnabled()
    expect(within(rowOf('Arena')).getByRole('button', { name: 'Restart Arena' })).toBeEnabled()
    for (const name of ['LNKAlive', 'Hosted', 'Mystery']) {
      const row = rowOf(name)
      for (const action of ['Start', 'Stop', 'Restart']) {
        expect(within(row).queryByRole('button', { name: `${action} ${name}` })).not.toBeInTheDocument()
      }
    }
  })

  it('starts another server where it stands, and refreshes the list', async () => {
    prime([ALIVE, OUTBREAK])
    startServer.mockResolvedValue({ success: true })
    renderOverview()

    await screen.findByText('LNK-OUTBREAK')
    const pollsBefore = getAll.mock.calls.length
    fireEvent.click(within(rowOf('LNK-OUTBREAK')).getByRole('button', { name: 'Start LNK-OUTBREAK' }))

    await waitFor(() => expect(startServer).toHaveBeenCalledWith('s2'))
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith({ title: 'Starting LNK-OUTBREAK' }))
    expect(activate).not.toHaveBeenCalled()
    await waitFor(() => expect(getAll.mock.calls.length).toBeGreaterThan(pollsBefore))
  })

  it('asks before stopping or restarting another server', async () => {
    prime([ALIVE, ARENA])
    stopServer.mockResolvedValue({ success: true, confirmed: false })
    restartServer.mockResolvedValue({ success: true })
    renderOverview()

    await screen.findByText('Arena')
    fireEvent.click(within(rowOf('Arena')).getByRole('button', { name: 'Stop Arena' }))
    const stopDialog = await screen.findByRole('alertdialog')
    expect(within(stopDialog).getByText('Stop Arena')).toBeInTheDocument()
    expect(stopServer).not.toHaveBeenCalled()
    fireEvent.click(within(stopDialog).getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(stopServer).toHaveBeenCalledWith('s4'))

    fireEvent.click(within(rowOf('Arena')).getByRole('button', { name: 'Restart Arena' }))
    const restartDialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(restartDialog).getByRole('button', { name: 'Restart' }))
    // The Dashboard's own Restart's 5-minute warning.
    await waitFor(() => expect(restartServer).toHaveBeenCalledWith('s4', 5))
  })

  it('says why a start was refused, in the operator\'s language', async () => {
    prime([ALIVE, OUTBREAK])
    startServer.mockRejectedValue(new ApiError('state unknown', {
      status: 409,
      code: 'SERVERS_ACTION_STATE_UNKNOWN',
      data: { code: 'SERVERS_ACTION_STATE_UNKNOWN', params: { name: 'LNK-OUTBREAK' } },
    }))
    renderOverview()

    await screen.findByText('LNK-OUTBREAK')
    fireEvent.click(within(rowOf('LNK-OUTBREAK')).getByRole('button', { name: 'Start LNK-OUTBREAK' }))

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith({
      title: 'LNK-OUTBREAK didn\'t start',
      description: 'The panel can\'t tell whether LNK-OUTBREAK is running, so it did nothing. Try again in a moment.',
      variant: 'destructive',
    }))
  })

  it('offers Start, Stop and Restart only with server.control', async () => {
    mockCanControl = false
    prime([ALIVE, OUTBREAK])
    renderOverview()

    await screen.findByText('LNK-OUTBREAK')
    const start = within(rowOf('LNK-OUTBREAK')).getByRole('button', { name: 'Start LNK-OUTBREAK' })
    expect(start).toBeDisabled()
    fireEvent.click(start)
    expect(startServer).not.toHaveBeenCalled()
  })

  it('refreshes the states when the server watch reports a server starting or stopping, and the rest on an update check', async () => {
    const handlers: Record<string, Handler> = {}
    mockSocket = { on: (event, handler) => { handlers[event] = handler }, off: vi.fn() }
    prime([ALIVE, OUTBREAK])
    renderOverview()

    await screen.findByText('LNK-OUTBREAK')
    const statusBefore = getStatus.mock.calls.length
    const listBefore = getAll.mock.calls.length
    act(() => handlers['servers:status']())
    await waitFor(() => expect(getStatus.mock.calls.length).toBeGreaterThan(statusBefore))
    // The server list changes rarely: a state change doesn't reload it.
    expect(getAll.mock.calls.length).toBe(listBefore)

    const updatesBefore = getUpdates.mock.calls.length
    act(() => handlers['servers:updates']())
    await waitFor(() => expect(getUpdates.mock.calls.length).toBeGreaterThan(updatesBefore))
  })

  it('asks for player counts only for the roles the RCON probe lets in', async () => {
    mockCanManage = false
    mockCanRcon = false
    prime([ALIVE, OUTBREAK])
    renderOverview()

    await screen.findByText('LNK-OUTBREAK')
    await waitFor(() => expect(getStatus).toHaveBeenCalled())
    expect(getRconStatuses).not.toHaveBeenCalled()
    expect(within(rowOf('LNKAlive')).getByText("Players: unknown (RCON isn't answering)")).toBeInTheDocument()
  })

  it('shows each running server\'s memory, and the servers\' total against the machine', async () => {
    prime([ALIVE, ARENA], { hostMemoryBytes: 16 * 1024 ** 3, memory: { s1: 3.4 * 1024 ** 3, s4: 2 * 1024 ** 3 } })
    renderOverview()

    await screen.findByText('Arena')
    expect(within(rowOf('LNKAlive')).getByText('3.4 GB')).toBeInTheDocument()
    expect(within(rowOf('Arena')).getByText('2.0 GB')).toBeInTheDocument()
    expect(screen.getByText('RAM 5.4 / 16.0 GB')).toBeInTheDocument()
  })

  it('warns when the servers that start together are allowed more heap than the machine has, or share ports', async () => {
    const big = server('b1', 'Big', { maxMemory: 12, serverPort: 16261 })
    const bigger = server('b2', 'Bigger', { maxMemory: 12, serverPort: 16262 })
    prime([big, bigger], { hostMemoryBytes: 16 * 1024 ** 3 })
    renderOverview({ activeServerId: 'b1', autoStartSettings: { autoStartServer: true, autoStartServerIds: ['b1', 'b2'] } })

    const note = await screen.findByRole('note')
    expect(within(note).getByText(/can use up to 24 GB of heap together, more than the 16.0 GB/)).toBeInTheDocument()
    expect(within(note).getByText(/Big \(port 16261\) and Bigger \(port 16262\)/)).toBeInTheDocument()
  })

  it('marks mods behind Steam, a game update and a filling disk', async () => {
    prime([ALIVE, OUTBREAK], { disk: { s2: { usedPercent: 96.2, freeBytes: 1024 ** 3, warning: true, critical: true } } })
    getUpdates.mockResolvedValue({
      servers: [{
        serverId: 's2',
        mods: { outdated: [{ workshopId: '1', name: 'Brita', latestAt: '' }, { workshopId: '2', name: 'Arsenal', latestAt: '' }] },
        game: { installedBuild: '10', latestBuild: '12', updateAvailable: true },
      }],
    } as never)
    renderOverview()

    const row = (await screen.findByText('Mods behind: 2')).closest('li') as HTMLElement
    expect(within(row).getByText('Mods behind: 2')).toHaveAttribute('title', 'Brita, Arsenal')
    expect(within(row).getByText('Game update')).toBeInTheDocument()
    expect(within(row).getByText('Disk 96%')).toBeInTheDocument()
  })

  it('shows each server\'s last backup and chooses which ones the schedule backs up', async () => {
    prime([ALIVE, OUTBREAK])
    getBackupSummary.mockResolvedValue({
      servers: [{ serverId: 's1', lastBackupAt: new Date(Date.now() - 2 * 3600_000).toISOString(), count: 3 }],
      schedule: { enabled: true, serverIds: null },
    } as never)
    updateBackupSettings.mockResolvedValue({ success: true } as never)
    renderOverview()

    await screen.findByText('LNK-OUTBREAK')
    await waitFor(() => expect(within(rowOf('LNKAlive')).getByText('Backup: 2h ago')).toBeInTheDocument())
    expect(within(rowOf('LNK-OUTBREAK')).getByText('No backup yet')).toBeInTheDocument()
    // No list chosen yet: the schedule backs up the active server alone.
    expect(within(rowOf('LNKAlive')).getByRole('checkbox', { name: 'Scheduled backup' })).toBeChecked()
    const other = within(rowOf('LNK-OUTBREAK')).getByRole('checkbox', { name: 'Scheduled backup' })
    expect(other).not.toBeChecked()

    fireEvent.click(other)
    await waitFor(() => expect(updateBackupSettings).toHaveBeenCalledWith({ serverIds: ['s1', 's2'] }))
  })

  it('switches the Dashboard to another server, and offers it only with servers.manage', async () => {
    prime([ALIVE, OUTBREAK])
    activate.mockResolvedValue({ server: OUTBREAK, message: 'ok' } as never)
    renderOverview()

    await screen.findByText('LNK-OUTBREAK')
    expect(within(rowOf('LNKAlive')).queryByRole('button')).not.toBeInTheDocument()
    fireEvent.click(within(rowOf('LNK-OUTBREAK')).getByRole('button', { name: 'Show LNK-OUTBREAK on the Dashboard' }))

    await waitFor(() => expect(activate).toHaveBeenCalledWith('s2'))

    cleanup()
    mockCanManage = false
    renderOverview()
    await screen.findByText('LNK-OUTBREAK')
    expect(within(rowOf('LNK-OUTBREAK')).getByRole('button', { name: 'Show LNK-OUTBREAK on the Dashboard' })).toBeDisabled()
  })
})
