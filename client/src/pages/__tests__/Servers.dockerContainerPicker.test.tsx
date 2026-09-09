import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers from '../Servers'
import { serversApi, dockerApi, configApi, updateApi } from '@/lib/api'
import en from '../../locales/en/servers.json'

// docker-unraid-add-server-experience, ruling 3 (2026-09-09, god): "the
// free-text container name: make it a picker from the list already in
// memory, with free text still allowed as a fallback. Rule 3 -- guess, then
// let them change it." dockerContainers is already fetched on this same
// page (for the container-management cards) while dockerContainerName used
// to be a bare <Input> three thousand lines away, ignoring it completely.

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

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

// jsdom has no layout engine, so it never implements scrollIntoView --
// Radix Select's own open/highlight-selected-item effect calls it
// unconditionally, throwing an unhandled rejection the instant the
// dropdown opens. No test in this codebase drives a Select's open listbox
// today (grepped first), so this is a local, narrow stub rather than a
// shared test-setup.ts change nobody asked for.
Element.prototype.scrollIntoView = vi.fn()

const getAll = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(serversApi.getStatus)
const getRconStatuses = vi.mocked(serversApi.getRconStatuses)
const discoverMounts = vi.mocked(serversApi.discoverMounts)
const dockerGetStatus = vi.mocked(dockerApi.getStatus)
const dockerGetStats = vi.mocked(dockerApi.getStats)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateGetStatus = vi.mocked(updateApi.getStatus)

const SERVER_A = {
  id: 1,
  name: 'server-a',
  serverName: 'server-a-cfg',
  installPath: '/srv/a',
  zomboidDataPath: '/srv/a/data',
  serverConfigPath: '/srv/a/data/Server/server-a.ini',
  dockerContainerName: null,
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

async function openCardMenu(serverName: string) {
  const trigger = await screen.findByRole('button', { name: new RegExp(`options for ${serverName}`, 'i') })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}

async function openEditDialogForServerA() {
  const menu = await openCardMenu('server-a')
  fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.edit }))
  await screen.findByRole('heading', { name: en.editDialog.title })
}

async function setUpFixtures() {
  getAll.mockResolvedValue({ servers: [SERVER_A] } as never)
  getStatus.mockResolvedValue({ servers: [] } as never)
  getRconStatuses.mockResolvedValue({ servers: [] } as never)
  discoverMounts.mockResolvedValue({ mounts: [], inaccessible: [] } as never)
  getAppSettings.mockResolvedValue({ settings: {} } as never)
  updateGetStatus.mockResolvedValue({ updateAvailable: false } as never)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Servers.tsx edit dialog: dockerContainerName is a picker when containers are known, not a bare text box', () => {
  it('shows a Select populated from the already-fetched container list, and picking one sets dockerContainerName', async () => {
    await setUpFixtures()
    dockerGetStatus.mockResolvedValue({
      enabled: true,
      available: true,
      containers: [
        { id: 'c1', name: 'projectzomboid', image: 'pz', state: 'running', status: 'Up 2 hours' },
        { id: 'c2', name: 'other-container', image: 'other', state: 'exited', status: 'Exited' },
      ],
    } as never)
    dockerGetStats.mockResolvedValue({ containers: {} } as never)

    renderServers()
    await openEditDialogForServerA()

    // The bare free-text input must be GONE, replaced by a picker offering
    // both real containers.
    expect(screen.queryByPlaceholderText(en.editDialog.dockerContainerPlaceholder)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('combobox'))
    expect(await screen.findByRole('option', { name: /projectzomboid/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /other-container/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('option', { name: /projectzomboid/ }))

    // The Select's own trigger now reflects the picked value.
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('projectzomboid'))
  })

  it('falls back to the free-text input when no containers are known at all', async () => {
    await setUpFixtures()
    dockerGetStatus.mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
    dockerGetStats.mockResolvedValue({ containers: {} } as never)

    renderServers()
    await openEditDialogForServerA()

    expect(screen.getByPlaceholderText(en.editDialog.dockerContainerPlaceholder)).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('"Type it in manually..." switches to free text, and a value that later matches a container can be picked again', async () => {
    await setUpFixtures()
    dockerGetStatus.mockResolvedValue({
      enabled: true,
      available: true,
      containers: [{ id: 'c1', name: 'projectzomboid', image: 'pz', state: 'running', status: 'Up' }],
    } as never)
    dockerGetStats.mockResolvedValue({ containers: {} } as never)

    renderServers()
    await openEditDialogForServerA()

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(await screen.findByRole('option', { name: /Type it in manually/ }))

    const manualInput = await screen.findByPlaceholderText(en.editDialog.dockerContainerPlaceholder)
    fireEvent.change(manualInput, { target: { value: 'hand-typed-name' } })
    expect(manualInput).toHaveValue('hand-typed-name')

    fireEvent.click(screen.getByText('Pick from detected containers instead'))
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })
})
