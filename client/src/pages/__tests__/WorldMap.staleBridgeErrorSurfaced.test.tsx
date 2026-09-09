import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import WorldMap from '../WorldMap'
import { panelBridgeApi, serversApi, updateApi, mapApi, type ServerInstance } from '@/lib/api'

// surface-stale-bridge-in-ui-for-remote-servers, UI half (2026-09-09, god's
// dispatch): production evidence from the real support bundle (Jim,
// analyse-real-production-support-bundle-2026-09-08) showed
// "Bridge file connection is unhealthy: Status file is stale (1h old)" at
// duration_ms:0, SEVEN calls back-to-back in 20 seconds, recurring on four
// separate days -- getConnectionDiagnostics() correctly and instantly knows
// the bridge is dead, but god's explicit question was whether the USER ever
// sees that reason, or just "seven identical failures and no explanation."
//
// Root cause found here: WorldMap.tsx's dossier Heal button, dossier God
// button, and context-menu Heal item are the ONLY three panelBridgeApi.
// sendCommand() call sites in this entire file (out of eleven) whose .catch()
// swallows the error completely -- a bare `toast({ title: t('errorTitle') })`
// with no description -- while every sibling action in the SAME file
// (teleportPlayer, vehicleRepair, vehicleSetFuel, vehicleSetBattery,
// vehicleHotwire, removeVehicle, spawnVehicleAt) and every GM-tools action on
// Players.tsx (setGodMode/setInvisible/setNoclip/healPlayer via its shared
// handleAction) already call getUserErrorMessage(err, ...) and show a real
// description. Heal/God's buttons are gated on the players.gm_tools
// capability only, never on bridge connectivity, so a user can keep clicking
// them for as long as they like while the bridge is known-unreachable --
// exactly the shape of the seven-in-20-seconds production burst.

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

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serversApi: { ...actual.serversApi, getResolvedActive: vi.fn() },
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
    mapApi: { ...actual.mapApi, resolve: vi.fn(), vehicles: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getServerInfo: vi.fn(),
      getStatus: vi.fn(),
      sendCommand: vi.fn(),
      getCatalogItems: vi.fn().mockRejectedValue(new Error('no catalog in test env')),
      triggerAirdrop: vi.fn(),
    },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getUpdateStatus = vi.mocked(updateApi.getStatus)
const mapResolve = vi.mocked(mapApi.resolve)
const mapVehicles = vi.mocked(mapApi.vehicles)
const getServerInfo = vi.mocked(panelBridgeApi.getServerInfo)
const getBridgeStatus = vi.mocked(panelBridgeApi.getStatus)
const sendCommand = vi.mocked(panelBridgeApi.sendCommand)

const testServer: ServerInstance = {
  id: 1,
  name: 'Ashenwood',
  serverName: 'Ashenwood',
  installPath: '',
  zomboidDataPath: null,
  serverConfigPath: null,
  rconHost: '10.0.0.5',
  rconPort: 27015,
  rconPassword: 'hunter2',
  serverPort: 16261,
  minMemory: 2048,
  maxMemory: 4096,
  useNoSteam: false,
  useDebug: false,
  isRemote: false,
  isActive: true,
  startCommand: '',
  adminPassword: '',
  createdAt: '2026-01-01T00:00:00.000Z',
}

class StubResizeObserver {
  private cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
  }
  observe() {
    this.cb(
      [{ contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderWorldMap() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <SocketContext.Provider value={null}>
          <WorldMap />
        </SocketContext.Provider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

const STALE_BRIDGE_MESSAGE = 'Bridge file connection is unhealthy: Status file is stale (1h old).'

async function setUp(players: Array<{ name: string; x: number; y: number }>) {
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
  getResolvedActive.mockResolvedValue({ server: testServer })
  getUpdateStatus.mockResolvedValue({} as Awaited<ReturnType<typeof updateApi.getStatus>>)
  mapResolve.mockResolvedValue({
    root: '/tiles',
    b42Dir: 'b42',
    b41Path: '/tiles/b41',
    tileSize: 1024,
    width: 1157312,
    height: 509520,
    maxLevel: 21,
    renderedMaxLevel: 10,
  })
  mapVehicles.mockResolvedValue({ vehicles: [] })
  getServerInfo.mockResolvedValue({ success: true, data: { players } } as Awaited<ReturnType<typeof panelBridgeApi.getServerInfo>>)
  getBridgeStatus.mockResolvedValue({ modConnected: true, modStatus: { version: '1.7.40' } } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
}

describe('WorldMap.tsx: a known-unreachable bridge must be explained to the user, not swallowed', () => {
  it('dossier Heal button shows the real bridge-unhealthy reason on failure, not a bare "Error" toast', async () => {
    await setUp([{ name: 'Kate', x: 10000, y: 10000 }])
    sendCommand.mockRejectedValue(new Error(STALE_BRIDGE_MESSAGE))

    renderWorldMap()

    fireEvent.click(await screen.findByRole('button', { name: /pan to kate/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Heal' }))

    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('healPlayer', { username: 'Kate' }))
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ description: STALE_BRIDGE_MESSAGE, variant: 'destructive' }),
      ),
    )
  })

  it('dossier God button shows the real bridge-unhealthy reason on failure, not a bare "Error" toast', async () => {
    await setUp([{ name: 'Kate', x: 10000, y: 10000 }])
    sendCommand.mockRejectedValue(new Error(STALE_BRIDGE_MESSAGE))

    renderWorldMap()

    fireEvent.click(await screen.findByRole('button', { name: /pan to kate/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'God' }))

    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setGodMode', { username: 'Kate', enabled: true }))
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ description: STALE_BRIDGE_MESSAGE, variant: 'destructive' }),
      ),
    )
  })

  // The third fixed site -- the context-menu Heal item at a player marker's
  // right-click position -- is the identical code shape as the dossier Heal
  // button above (same sendCommand('healPlayer', ...) call, same swallowed
  // .catch() before this fix), reached only via canvas hit-testing against a
  // player's rendered pixel position. Not covered by its own test here:
  // driving that hit-test would depend on WorldMap's internal
  // world-to-canvas projection, making the test fragile against unrelated
  // rendering changes for no additional defect coverage beyond what the two
  // tests above already prove for the exact same bug class.
})
