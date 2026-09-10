import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import WorldMap from '../WorldMap'
import { panelBridgeApi, serversApi, updateApi, mapApi, type ServerInstance } from '@/lib/api'

// unknown-window-instances-outside-the-bridge, 2026-09-10: detectServerVersion
// used to assert setHasActiveServer(false) on a REJECTED getResolvedActive
// call -- indistinguishable from a genuinely confirmed "no active server."
// That false cascades through every hasActiveServer-gated effect
// (checkBridgeStatus, fetchPlayerPositions, the players/vehicles/safehouses
// cleanup effect), including forcibly zeroing bridgeConnected -- an
// otherwise-independent, already-correctly-fail-closed signal -- before it
// ever gets to report its own honest status. Unlike Docker's dockerAvailable
// (a 10s poll that self-heals), this only re-runs on mount or an
// 'activeServerChanged' socket event, so a wrong false here can be
// effectively permanent for the rest of the page load.
//
// This test proves the fix by its OBSERVABLE consequence: with the bug,
// hasActiveServer getting stuck at false permanently disables the
// fetchPlayerPositions poll (`if (!hasActiveServer) return`, WorldMap.tsx),
// so the player marker and "Bridge connected" badge never come back even
// once the bridge itself is answering again. With the fix, hasActiveServer
// stays true across the rejected refetch, so the very next poll tick
// (POLL_INTERVAL = 3000ms, real timers -- not simulated) recovers both.

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

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
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
      sendCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
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

// Minimal fake socket -- just enough of the on/off/emit shape WorldMap uses
// (socket.on('activeServerChanged', handler) / socket.off(...)) to trigger
// detectServerVersion a second time without a real socket.io connection.
function makeFakeSocket() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const fake = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(cb)
      return fake
    }),
    off: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(cb)
      return fake
    }),
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach((cb) => cb(...args))
    },
  }
  return fake
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderWorldMap(socket: ReturnType<typeof makeFakeSocket>) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <SocketContext.Provider value={socket as unknown as Socket}>
          <WorldMap />
        </SocketContext.Provider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function setUp() {
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
  getBridgeStatus.mockResolvedValue({ modConnected: true, modStatus: { version: '1.7.40' } } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
}

describe('WorldMap.tsx: a rejected active-server check must not permanently kill live tracking', () => {
  it('recovers player tracking on the next poll after a transient active-server-check failure, instead of staying stuck', async () => {
    await setUp()
    getResolvedActive.mockResolvedValueOnce({ server: testServer })
    getServerInfo.mockResolvedValue({ success: true, data: { players: [{ name: 'Kate', x: 10000, y: 10000 }] } } as Awaited<ReturnType<typeof panelBridgeApi.getServerInfo>>)

    const socket = makeFakeSocket()
    renderWorldMap(socket)

    // Initial load succeeds: player marker present, bridge shows connected.
    await screen.findByRole('button', { name: /pan to kate/i }, { timeout: 5000 })
    await waitFor(() => expect(screen.getByRole('link', { name: /bridge connected/i })).toBeInTheDocument())

    // Simulate the active server "changing" (the only other trigger for
    // detectServerVersion besides mount) with the status check itself
    // failing this time -- a transient blip, not a real removal.
    getResolvedActive.mockRejectedValueOnce(new Error('network blip'))
    socket.emit('activeServerChanged')

    // handleActiveServerChanged clears players unconditionally up front
    // (existing, intentional behavior, unrelated to this fix) -- confirm
    // that happened, so the recovery we check next is genuinely from the
    // NEXT poll tick, not a marker that was simply never removed.
    await waitFor(() => expect(screen.queryByRole('button', { name: /pan to kate/i })).toBeNull())

    // The real fix under test: hasActiveServer must have stayed true
    // despite the rejected check, so the 3s poll interval is still running
    // and recovers the marker + badge on its own, with no further socket
    // event and no page reload. Real timers -- this is the actual interval
    // firing, not a simulated one.
    await waitFor(
      () => expect(screen.getByRole('link', { name: /bridge connected/i })).toBeInTheDocument(),
      { timeout: 6000 },
    )
    await waitFor(
      () => expect(screen.getByRole('button', { name: /pan to kate/i })).toBeInTheDocument(),
      { timeout: 6000 },
    )
  }, 15000)
})
