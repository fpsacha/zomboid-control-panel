import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers from '../Servers'
import { serversApi, dockerApi, configApi, updateApi, type MountDiscoveryCandidate } from '@/lib/api'

// docker-unraid-add-server-experience (2026-09-09, god's three rulings after
// reading the pain-point enumeration; updated same night once Angela's real
// ranked `candidates` field landed (fc74b688/c84f0f5c/99ed5c22) to replace
// the confirmedMounts/partialMounts stand-in this file originally tested):
//
// 1. KILL the boolean gate that used to hide any discovered mount without
//    BOTH a confirmed data path AND at least one server config -- a
//    near-miss ("right bind mount, unconfirmed contents") must show the
//    user something instead of nothing.
// 2. SHOW THE DISCOVERY BANNER ON EVERY VISIT, not just the very-first
//    empty-roster screen -- the underlying fetch already runs
//    unconditionally on every page load, so gating the render meant paying
//    for the answer and throwing it away for anyone adding a second server.
// 3. (covered in Servers.dockerContainerPicker.test.tsx)
//
// This file proves 1 and 2 at the page-composition level, which the
// isolated MountDiscoveryBanner.test.tsx cannot: whether Servers.tsx
// actually reaches the banner with a non-empty roster, and whether a
// review-tier candidate's action really opens and pre-fills the manual Add
// Server form (the only path available for a candidate create-from-discovery
// can't safely auto-complete).

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

const getAll = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(serversApi.getStatus)
const getRconStatuses = vi.mocked(serversApi.getRconStatuses)
const discoverMounts = vi.mocked(serversApi.discoverMounts)
const dockerGetStatus = vi.mocked(dockerApi.getStatus)
const dockerGetStats = vi.mocked(dockerApi.getStats)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateGetStatus = vi.mocked(updateApi.getStatus)

const EXISTING_SERVER = {
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

function candidate(overrides: Partial<MountDiscoveryCandidate> = {}): MountDiscoveryCandidate {
  return {
    installPath: '/pz-server',
    dataPath: '/zomboid',
    source: 'common-mount',
    status: 'ready',
    reason: 'Found a complete Project Zomboid server here.',
    serverNames: ['servertest'],
    hasStartScript: true,
    hasPanelBridge: false,
    ...overrides,
  }
}

async function setUpFixtures() {
  getStatus.mockResolvedValue({ servers: [] } as never)
  getRconStatuses.mockResolvedValue({ servers: [] } as never)
  dockerGetStatus.mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
  dockerGetStats.mockResolvedValue({ containers: {} } as never)
  getAppSettings.mockResolvedValue({ settings: {} } as never)
  updateGetStatus.mockResolvedValue({ updateAvailable: false } as never)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Servers.tsx: mount-discovery banner reach and review-tier candidates (Angela\'s real candidates field)', () => {
  it('ruling 2: shows the discovery banner even when the roster is NOT empty (a second-server add)', async () => {
    await setUpFixtures()
    getAll.mockResolvedValue({ servers: [EXISTING_SERVER] } as never)
    discoverMounts.mockResolvedValue({
      mounts: [], inaccessible: [],
      candidates: [candidate()],
    } as never)

    renderServers()

    await screen.findByText('server-a')
    // Would previously render nothing at all once serversConfirmedEmpty was
    // false -- this candidate is unrelated to the one existing server, so it
    // must still surface.
    expect(await screen.findByText('/pz-server')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
  })

  it('excludes a discovered candidate that already matches a REGISTERED server, so a connected one does not keep re-offering itself', async () => {
    await setUpFixtures()
    getAll.mockResolvedValue({ servers: [EXISTING_SERVER] } as never)
    discoverMounts.mockResolvedValue({
      mounts: [], inaccessible: [],
      // Same installPath as EXISTING_SERVER's own -- already connected.
      candidates: [candidate({ installPath: '/srv/a', dataPath: '/srv/a/data', serverNames: ['server-a-cfg'] })],
    } as never)

    renderServers()

    await screen.findByText('server-a')
    await waitFor(() => expect(discoverMounts).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
  })

  it('ruling 1: a review-tier candidate (status data-only, no confirmed server config) renders instead of being silently dropped, using the SERVER-WRITTEN reason, and "Review & Add" opens the manual form pre-filled with the discovered path', async () => {
    await setUpFixtures()
    getAll.mockResolvedValue({ servers: [] } as never)
    discoverMounts.mockResolvedValue({
      mounts: [], inaccessible: [],
      candidates: [candidate({
        installPath: '/data',
        dataPath: null,
        status: 'install-only',
        reason: 'Found the install, but no save data folder was found alongside it.',
        serverNames: [],
        hasStartScript: false,
      })],
    } as never)

    renderServers()

    const reviewButton = await screen.findByRole('button', { name: 'Review & Add' })
    // The banner must show the SERVER's own reason sentence, not a
    // client-guessed description -- proves the real candidates contract is
    // actually wired through, not just a renamed local heuristic.
    expect(screen.getByText('Found the install, but no save data folder was found alongside it.')).toBeInTheDocument()

    fireEvent.click(reviewButton)

    // The manual Add Server dialog opens with the discovered install path
    // already in one of its fields -- proves the hand-off, not just that a
    // dialog opened.
    await waitFor(() => expect(screen.getByDisplayValue('/data')).toBeInTheDocument())
  })

  it('a not-mounted candidate is NOT shown -- a checked-and-clear common path is not a signal worth a banner', async () => {
    await setUpFixtures()
    getAll.mockResolvedValue({ servers: [] } as never)
    discoverMounts.mockResolvedValue({
      mounts: [], inaccessible: [],
      candidates: [candidate({ installPath: '/pz-server', status: 'not-mounted', reason: 'Not mounted.' })],
    } as never)

    renderServers()

    await waitFor(() => expect(discoverMounts).toHaveBeenCalled())
    expect(screen.queryByText('/pz-server')).not.toBeInTheDocument()
  })

  it('shows a permission-denied candidate with the server-written reason and a Retry action that re-runs the scan', async () => {
    await setUpFixtures()
    getAll.mockResolvedValue({ servers: [] } as never)
    discoverMounts.mockResolvedValue({
      mounts: [], inaccessible: [],
      candidates: [candidate({
        installPath: '/pz-server',
        status: 'permission-denied',
        reason: 'Found something at /pz-server, but this container cannot read it.',
      })],
    } as never)

    renderServers()

    expect(await screen.findByText('Found something at /pz-server, but this container cannot read it.')).toBeInTheDocument()
    discoverMounts.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(discoverMounts).toHaveBeenCalled())
  })
})
