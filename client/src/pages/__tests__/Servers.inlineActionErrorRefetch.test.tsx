import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Servers from '../Servers'
import { serversApi, dockerApi, configApi, updateApi, serverApi } from '@/lib/api'
import en from '../../locales/en/servers.json'

// bug-hunt-2026-09-08 (start/stop reconcile audit, dispatched off the
// operator's own "start/stop has been really crap" complaint): the
// optimistic-flip-that-never-reconciles hypothesis was ruled out (every
// status write traces to a real payload), but handleInlineStart/
// handleInlineStop/handleDockerAction's catch blocks did not force a
// refetch on failure -- only their success paths did. Harmless when the
// action genuinely failed (nothing changed, stale state is still correct),
// wrong in the narrower "client-side error, server actually succeeded
// anyway" case (this codebase's own timeout-class sweep shape from
// earlier the same night) -- and that wrong state sits on screen in the
// seconds right after the click, exactly when an operator is watching and
// most likely to click the same action again. This proves the refetch
// actually fires from the real catch block, not just that it compiles.

// Every test here needs the full capability set granted (start/stop and
// docker actions both gated) -- unlike the capabilityGating file, this one
// never varies it per test, so no let/reassignment is needed.
const mockCan = (_capability: string) => true

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
      activate: vi.fn(),
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
    },
    updateApi: {
      ...actual.updateApi,
      getStatus: vi.fn(),
    },
    serverApi: {
      ...actual.serverApi,
      start: vi.fn(),
      stop: vi.fn(),
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
const activate = vi.mocked(serversApi.activate)
const dockerGetStatus = vi.mocked(dockerApi.getStatus)
const dockerGetStats = vi.mocked(dockerApi.getStats)
const dockerRunAction = vi.mocked(dockerApi.runAction)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateGetStatus = vi.mocked(updateApi.getStatus)
const start = vi.mocked(serverApi.start)
const stop = vi.mocked(serverApi.stop)

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
  isActive: true,
  startCommand: '',
  adminPassword: '',
  createdAt: new Date(0).toISOString(),
} as never

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
  getStatus.mockResolvedValue({
    servers: [{ id: 1, running: false, pid: null, stateUnknown: false }],
  } as never)
  getRconStatuses.mockResolvedValue({ servers: [] } as never)
  discoverMounts.mockResolvedValue({ mounts: [] } as never)
  dockerGetStatus.mockResolvedValue({
    enabled: true,
    available: true,
    containers: [{ id: 'docker-b', name: 'docker-b', image: 'zomboid', state: 'exited', status: 'Exited' }],
  } as never)
  dockerGetStats.mockResolvedValue({ containers: {} } as never)
  getAppSettings.mockResolvedValue({ settings: {} } as never)
  updateGetStatus.mockResolvedValue({} as never)
  activate.mockResolvedValue({} as never)
}

async function openCardMenu(serverName: string) {
  const trigger = await screen.findByRole('button', { name: new RegExp(`options for ${serverName}`, 'i') })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}
void openCardMenu

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// Both fetchServerStatuses and fetchDockerState also run once on mount
// (independent of any click), so capturing a "before" call count right
// after the button appears is a race against that mount fetch's own
// resolution -- whichever happens to land inside a later open-ended
// waitFor's polling window can produce a false "it grew" positive with
// nothing to do with the click. Settling well past every mount-time
// fetch's resolution before capturing the baseline removes that race.
async function settleMountEffects() {
  await new Promise((r) => setTimeout(r, 500))
}

// A SECOND, sharper trap than the mount race above: this page also runs
// fetchServerStatuses on its own 15s setInterval and fetchDockerState on a
// 10s one, entirely independent of any click. An open-ended
// `await waitFor(() => expect(count).toBeGreaterThan(before))` doesn't
// just wait for the catch block's own refetch -- it happily waits long
// enough for one of THOSE unrelated ticks to land too, so the assertion
// passes even with the catch-block refetch commented out (confirmed: a
// break-verify run with the fix disabled still went green, taking ~40s --
// exactly consistent with outlasting the periodic interval). Bounding the
// wait well under both intervals (2s) makes the assertion discriminate
// "the catch block itself did this" from "something eventually did this,"
// which is the actual thing under test.
async function assertRefetchHappened(readCount: () => number, before: number) {
  await new Promise((r) => setTimeout(r, 2000))
  expect(readCount()).toBeGreaterThan(before)
}

describe('Servers.tsx: a failed inline action refetches real state instead of leaving stale state on screen', () => {
  it('handleInlineStart: a rejected serverApi.start() still triggers a fresh getStatus() call', async () => {
    start.mockRejectedValue(new Error('network drop'))
    await setUpFixtures()
    renderServers()

    const startButton = await screen.findByRole('button', { name: en.card.start })
    expect(startButton).not.toBeDisabled()
    await settleMountEffects()

    const callsBefore = getStatus.mock.calls.length
    fireEvent.click(startButton)

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: en.toasts.startFailedTitle })))
    await assertRefetchHappened(() => getStatus.mock.calls.length, callsBefore)
  })

  it('handleInlineStop: a rejected serverApi.stop() still triggers a fresh getStatus() call', async () => {
    stop.mockRejectedValue(new Error('network drop'))
    await setUpFixtures()
    // Stop only renders in place of Start when the card believes the
    // server is running -- setUpFixtures' default (running: false) would
    // show Start here instead.
    getStatus.mockResolvedValue({
      servers: [{ id: 1, running: true, pid: '123', stateUnknown: false }],
    } as never)
    renderServers()

    const stopButton = await screen.findByRole('button', { name: en.card.stop })
    expect(stopButton).not.toBeDisabled()
    await settleMountEffects()
    fireEvent.click(stopButton)

    const dialog = await screen.findByRole('alertdialog')
    const callsBefore = getStatus.mock.calls.length
    fireEvent.click(within(dialog).getByRole('button', { name: en.card.stop }))

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: en.toasts.stopFailedTitle })))
    await assertRefetchHappened(() => getStatus.mock.calls.length, callsBefore)
  })

  it('handleDockerAction: a rejected dockerApi.runAction() still triggers a fresh dockerApi.getStatus() call', async () => {
    dockerRunAction.mockRejectedValue(new Error('docker daemon unreachable'))
    await setUpFixtures()
    renderServers()

    const startContainerButton = await screen.findByRole('button', { name: en.card.startContainerAria.replace('{{name}}', 'docker-b') })
    expect(startContainerButton).not.toBeDisabled()
    await settleMountEffects()

    const callsBefore = dockerGetStatus.mock.calls.length
    fireEvent.click(startContainerButton)

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Container start failed' })))
    await assertRefetchHappened(() => dockerGetStatus.mock.calls.length, callsBefore)
  })
})
