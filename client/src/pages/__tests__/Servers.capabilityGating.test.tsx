import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers from '../Servers'
import { serversApi, serversDetectApi, dockerApi, configApi, updateApi, serverApi } from '@/lib/api'
import en from '../../locales/en/servers.json'

// bug-hunt-2026-08-27 (Tier 3 gating sweep): Servers.tsx had zero client-side
// capability gating. Six distinct capabilities gate its privileged actions --
// docker.manage, servers.manage, server.control, server.wipe, server.install,
// servers.discover -- see the mapping sent to god (dwight-tier3-table) for
// the full route-by-route trace. This suite asserts the ACTION is
// unreachable (mocked API never called), not just that a control has the
// `disabled` attribute -- a click on a disabled control still fires here,
// same discipline as Angela's Console.tsx lesson.
//
// Two rulings from god get their own dedicated tests, not just blanket
// deny/allow coverage: (1) inline Start/Stop needs BOTH servers.manage AND
// server.control -- holding only one must still leave it unreachable,
// because the two calls fire in sequence and a role with only one gets a
// PARTIAL execution (activate succeeds, start/stop 403s), not a clean
// refusal. (2) the delete dialog's "also delete files" checkbox is gated on
// server.wipe INDEPENDENTLY of the base Delete button (servers.manage) --
// panel-record-only deletion is a legitimately lower bar and must stay
// reachable even without server.wipe.

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
      create: vi.fn(),
      activate: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      steamVerify: vi.fn(),
      steamUpdate: vi.fn(),
    },
    serversDetectApi: {
      ...actual.serversDetectApi,
      detect: vi.fn(),
      autoScan: vi.fn(),
      deleteFiles: vi.fn(),
    },
    dockerApi: {
      ...actual.dockerApi,
      getStatus: vi.fn(),
      getStats: vi.fn(),
      runAction: vi.fn(),
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
    // The Steam dialog's own useEffect fires serverApi.detectSteamCmd()/
    // getBranches() as soon as it opens -- unmocked, these hit a real fetch
    // that fails in jsdom and retries 3x with backoff, eating enough wall
    // time to blow the suite's 60s test timeout on any test that opens the
    // dialog. Not asserted on directly, just needs to resolve fast.
    serverApi: {
      ...actual.serverApi,
      detectSteamCmd: vi.fn(),
      getBranches: vi.fn(),
    },
  }
})

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const getAll = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(serversApi.getStatus)
const getRconStatuses = vi.mocked(serversApi.getRconStatuses)
const discoverMounts = vi.mocked(serversApi.discoverMounts)
const create = vi.mocked(serversApi.create)
const activate = vi.mocked(serversApi.activate)
const update = vi.mocked(serversApi.update)
const del = vi.mocked(serversApi.delete)
const steamVerify = vi.mocked(serversApi.steamVerify)
const steamUpdate = vi.mocked(serversApi.steamUpdate)
const detect = vi.mocked(serversDetectApi.detect)
const autoScan = vi.mocked(serversDetectApi.autoScan)
const deleteFiles = vi.mocked(serversDetectApi.deleteFiles)
const dockerGetStatus = vi.mocked(dockerApi.getStatus)
const dockerGetStats = vi.mocked(dockerApi.getStats)
const dockerRunAction = vi.mocked(dockerApi.runAction)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateAppSettings = vi.mocked(configApi.updateAppSettings)
const updateGetStatus = vi.mocked(updateApi.getStatus)
const detectSteamCmd = vi.mocked(serverApi.detectSteamCmd)
const getBranches = vi.mocked(serverApi.getBranches)

// Non-docker, non-remote -- exercises servers.manage (activate/save/delete),
// server.control (inline start), servers.discover (scan/detect/auto-scan),
// server.install + server.wipe (Steam dialog + Clear Folder, opened via its
// card's dropdown menu).
const SERVER_A = {
  id: 1,
  // name and serverName deliberately differ (CardTitle shows name,
  // CardDescription shows serverName) -- identical values here would make
  // every text query match two elements and hang findBy/waitFor until its
  // timeout instead of failing fast (diagnosed via zzdiag.test.tsx).
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

// Docker-managed -- hasManagedContainer becomes true for this server, which
// suppresses its inline Start/Stop card buttons (Docker's own controls take
// over) so docker.manage can be isolated cleanly from server.control.
const SERVER_B = {
  ...(SERVER_A as object),
  id: 2,
  name: 'server-b',
  serverName: 'server-b-cfg',
  installPath: '/srv/b',
  zomboidDataPath: '/srv/b/data',
  dockerContainerName: 'docker-b',
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
  getAll.mockResolvedValue({ servers: [SERVER_A, SERVER_B] } as never)
  getStatus.mockResolvedValue({ servers: [] } as never)
  getRconStatuses.mockResolvedValue({ servers: [] } as never)
  discoverMounts.mockResolvedValue({ mounts: [] } as never)
  dockerGetStatus.mockResolvedValue({
    enabled: true,
    available: true,
    containers: [{ id: 'docker-b', name: 'docker-b', image: 'zomboid', state: 'exited', status: 'Exited' }],
  } as never)
  dockerGetStats.mockResolvedValue({ containers: {} } as never)
  // Pre-populate steamcmdPath so the Steam dialog's Start Verify/Update
  // button's OTHER disabled condition (!steamcmdPath.trim()) never masks
  // the capability gate under test.
  getAppSettings.mockResolvedValue({ settings: { steamcmdPath: '/opt/steamcmd' } } as never)
  updateGetStatus.mockResolvedValue({} as never)
  create.mockResolvedValue({ server: { id: 3 } } as never)
  activate.mockResolvedValue({} as never)
  update.mockResolvedValue({ warnings: [] } as never)
  del.mockResolvedValue({} as never)
  deleteFiles.mockResolvedValue({} as never)
  detectSteamCmd.mockResolvedValue({ found: false, path: null } as never)
  getBranches.mockResolvedValue({ branches: [] } as never)
}

// Radix's DropdownMenuTrigger opens on pointerdown, not click (see
// Dashboard.capabilityGating.test.tsx's identical helper) -- a plain
// fireEvent.click never dispatches pointerdown, so the menu would never
// open.
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
})

describe('Servers.tsx: capability gating', () => {
  it('shows managed lifecycle controls only when the backend supports them', async () => {
    mockCan = () => true
    await setUpFixtures()
    getAll.mockResolvedValue({
      servers: [SERVER_A, SERVER_B],
      lifecycleCapabilities: {
        supported: true,
        platform: 'linux',
        containerized: false,
        providers: ['direct', 'systemd', 'openrc'],
      },
    } as never)
    renderServers()
    await screen.findByText('server-a')

    const menu = await openCardMenu('server-a')
    fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.edit }))
    await screen.findByRole('heading', { name: en.editDialog.title })

    expect(screen.getByText(en.editDialog.lifecycleProviderLabel)).toBeInTheDocument()
  })

  it('hides managed lifecycle controls on unsupported hosts', async () => {
    mockCan = () => true
    await setUpFixtures()
    renderServers()
    await screen.findByText('server-a')

    const menu = await openCardMenu('server-a')
    fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.edit }))
    await screen.findByRole('heading', { name: en.editDialog.title })

    expect(screen.queryByText(en.editDialog.lifecycleProviderLabel)).not.toBeInTheDocument()
  })

  it('disables every gated trigger, and clicking any of them never calls the API, when the role holds none of the six capabilities', async () => {
    mockCan = () => false
    await setUpFixtures()
    renderServers()
    await screen.findByText('server-a')

    // servers.manage -- "Switch to this server" inline card button.
    const switchButtons = screen.getAllByRole('button', { name: en.card.switchToThisServer })
    switchButtons.forEach(b => expect(b).toBeDisabled())
    switchButtons.forEach(b => fireEvent.click(b))
    expect(activate).not.toHaveBeenCalled()

    // server.control composite (both false here too) -- inline Start.
    const startButtons = screen.getAllByRole('button', { name: en.card.start })
    expect(startButtons.length).toBeGreaterThan(0)
    startButtons.forEach(b => expect(b).toBeDisabled())
    startButtons.forEach(b => fireEvent.click(b))
    await waitFor(() => expect(activate).not.toHaveBeenCalled())

    // docker.manage -- Restart is unconditional on run-state, unlike
    // Start/Stop, so it isolates the capability check cleanly.
    const restartButton = await screen.findByRole('button', { name: /restart docker-b/i })
    expect(restartButton).toBeDisabled()
    fireEvent.click(restartButton)
    expect(dockerRunAction).not.toHaveBeenCalled()

    // servers.discover -- header scan-mounts button. Clear the mount that
    // fired automatically on mount before asserting on the click.
    await waitFor(() => expect(discoverMounts).toHaveBeenCalled())
    discoverMounts.mockClear()
    const scanButton = screen.getByRole('button', { name: en.pageHeader.scanAria })
    expect(scanButton).toBeDisabled()
    fireEvent.click(scanButton)
    expect(discoverMounts).not.toHaveBeenCalled()

    // Open Edit dialog for server-a -- servers.manage.
    const menu = await openCardMenu('server-a')
    fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.edit }))
    await screen.findByRole('heading', { name: en.editDialog.title })
    const saveButton = screen.getByRole('button', { name: en.editDialog.saveChanges })
    expect(saveButton).toBeDisabled()
    fireEvent.click(saveButton)
    expect(update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.editDialog.cancel }))

    // Open Delete dialog for server-a -- servers.manage on the base button,
    // server.wipe on the checkbox independently (ruling 2).
    const menu2 = await openCardMenu('server-a')
    fireEvent.click(within(menu2).getByRole('menuitem', { name: en.card.removeFromPanel }))
    await screen.findByRole('heading', { name: en.deleteDialog.title })
    const deleteFilesCheckbox = screen.getByRole('checkbox', { name: new RegExp(en.deleteDialog.alsoDeleteFilesLabel) })
    expect(deleteFilesCheckbox).toBeDisabled()
    const removeButton = screen.getByRole('button', { name: en.deleteDialog.removeFromPanel })
    expect(removeButton).toBeDisabled()
    fireEvent.click(removeButton)
    expect(del).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.deleteDialog.cancel }))

    // Open Steam dialog for server-a -- server.install on Start Verify, and
    // the Clear Folder confirm dialog behind it on server.wipe.
    await openSteamDialogForServerA()
    const startUpdateButton = screen.getByRole('button', { name: en.steamDialog.startUpdate })
    expect(startUpdateButton).toBeDisabled()
    fireEvent.click(startUpdateButton)
    expect(steamUpdate).not.toHaveBeenCalled()
    expect(steamVerify).not.toHaveBeenCalled()

    // Fixed 2026-08-27 (stock-role hunt): this button used to stay fully
    // clickable regardless of permission -- only the confirm dialog's own
    // button checked server.wipe, so an unauthorized role could open the
    // dialog and just not complete it. Now the opener itself is gated too,
    // so the dialog never opens at all.
    const clearFolderButton = screen.getByRole('button', { name: en.steamDialog.clearFolderButton })
    expect(clearFolderButton).toBeDisabled()
    fireEvent.click(clearFolderButton)
    expect(screen.queryByRole('heading', { name: en.clearInstallDialog.title })).not.toBeInTheDocument()
    expect(deleteFiles).not.toHaveBeenCalled()
  })

  it('enables every gated trigger once the role holds the matching capability', async () => {
    mockCan = () => true
    await setUpFixtures()
    renderServers()
    await screen.findByText('server-a')

    screen.getAllByRole('button', { name: en.card.switchToThisServer }).forEach(b => expect(b).not.toBeDisabled())
    screen.getAllByRole('button', { name: en.card.start }).forEach(b => expect(b).not.toBeDisabled())

    const restartButton = await screen.findByRole('button', { name: /restart docker-b/i })
    expect(restartButton).not.toBeDisabled()
    fireEvent.click(restartButton)
    await waitFor(() => expect(dockerRunAction).toHaveBeenCalledWith('docker-b', 'restart', 2))

    await waitFor(() => expect(discoverMounts).toHaveBeenCalled())
    discoverMounts.mockClear()
    const scanButton = screen.getByRole('button', { name: en.pageHeader.scanAria })
    expect(scanButton).not.toBeDisabled()
    fireEvent.click(scanButton)
    await waitFor(() => expect(discoverMounts).toHaveBeenCalledTimes(1))

    const menu = await openCardMenu('server-a')
    fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.edit }))
    await screen.findByRole('heading', { name: en.editDialog.title })
    expect(screen.getByRole('button', { name: en.editDialog.saveChanges })).not.toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: en.editDialog.saveChanges }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))

    const menu2 = await openCardMenu('server-a')
    fireEvent.click(within(menu2).getByRole('menuitem', { name: en.card.removeFromPanel }))
    await screen.findByRole('heading', { name: en.deleteDialog.title })
    expect(screen.getByRole('checkbox', { name: new RegExp(en.deleteDialog.alsoDeleteFilesLabel) })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: en.deleteDialog.removeFromPanel })).not.toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: en.deleteDialog.cancel }))

    await openSteamDialogForServerA()
    // Clear Folder BEFORE Start Update: once a real steamUpdate resolves,
    // steamRunning stays true until a 'steam:complete' socket event that
    // never fires in this test, which correctly (and unrelatedly to
    // capability gating) disables Clear Folder afterward -- test that
    // control first, while nothing is running yet.
    fireEvent.click(screen.getByRole('button', { name: en.steamDialog.clearFolderButton }))
    await screen.findByRole('heading', { name: en.clearInstallDialog.title })
    expect(screen.getByRole('button', { name: en.clearInstallDialog.clearFolder })).not.toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: en.clearInstallDialog.clearFolder }))
    await waitFor(() => expect(deleteFiles).toHaveBeenCalledTimes(1))

    expect(screen.getByRole('button', { name: en.steamDialog.startUpdate })).not.toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: en.steamDialog.startUpdate }))
    await waitFor(() => expect(steamUpdate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(deleteFiles).toHaveBeenCalledTimes(1))
  })

  it('ruling 1: inline Start/Stop stays unreachable holding only servers.manage, without server.control (partial-execution risk)', async () => {
    mockCan = (capability) => capability === 'servers.manage'
    await setUpFixtures()
    renderServers()
    await screen.findByText('server-a')

    const startButtons = screen.getAllByRole('button', { name: en.card.start })
    startButtons.forEach(b => expect(b).toBeDisabled())
    startButtons.forEach(b => fireEvent.click(b))
    await waitFor(() => expect(activate).not.toHaveBeenCalled())
  })

  it('ruling 1: inline Start/Stop stays unreachable holding only server.control, without servers.manage', async () => {
    mockCan = (capability) => capability === 'server.control'
    await setUpFixtures()
    renderServers()
    await screen.findByText('server-a')

    const startButtons = screen.getAllByRole('button', { name: en.card.start })
    startButtons.forEach(b => expect(b).toBeDisabled())
    startButtons.forEach(b => fireEvent.click(b))
    await waitFor(() => expect(activate).not.toHaveBeenCalled())
  })

  it('ruling 2: the delete-files checkbox is gated on server.wipe independently -- lacking it still allows the base panel-record delete', async () => {
    mockCan = (capability) => capability !== 'server.wipe'
    await setUpFixtures()
    renderServers()
    await screen.findByText('server-a')

    const menu = await openCardMenu('server-a')
    fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.removeFromPanel }))
    await screen.findByRole('heading', { name: en.deleteDialog.title })

    // The checkbox itself is unreachable...
    const checkbox = screen.getByRole('checkbox', { name: new RegExp(en.deleteDialog.alsoDeleteFilesLabel) })
    expect(checkbox).toBeDisabled()

    // ...but the base Delete button is NOT blocked by the missing
    // server.wipe -- servers.manage alone is enough for the lower-bar,
    // panel-record-only deletion.
    const removeButton = screen.getByRole('button', { name: en.deleteDialog.removeFromPanel })
    expect(removeButton).not.toBeDisabled()
    fireEvent.click(removeButton)
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1))
    // And the file-delete step was never attempted.
    expect(deleteFiles).not.toHaveBeenCalled()
  })
})
