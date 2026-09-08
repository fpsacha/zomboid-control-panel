import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SocketContext } from '@/contexts/SocketContext'
import Layout from '../Layout'
import { serversApi, serverApi, updateApi, modsApi, panelUpdateApi } from '@/lib/api'

// honest-unknown-renderings-have-no-regression-coverage (2026-09-09):
// this is the first render-test coverage for Layout.tsx's sidebar "Active
// Server" status dot, named explicitly as an unguarded gap by 4da160bd's
// commit message (Servers.tsx's sibling collapse got a dedicated test;
// Layout.tsx's did not, "full mount harness ... judged disproportionate
// to the risk"). a106a2d4 and the 2026-09-08 three-state audit both landed
// fixes here (refreshServerRunState's `if (data?.scanFailed) { setServerRunState
// ('unknown'); return }`, Layout.tsx:460) with no test verifying the dot
// actually renders "unknown" and not a confident "stopped" -- exactly the
// shape this card was opened to close: a correct fix that a future refactor
// could silently revert (the dot LOOKS tidier collapsed to plain stopped/
// running) without anything going red.
//
// Break-verified: reverting Layout.tsx:460's `if (data?.scanFailed) { ... }`
// guard (back to the pre-4da160bd `const data = await serverApi.getStatus()`
// with no scanFailed check) trips the first test below -- the fixture uses
// `{ running: false, scanFailed: true }`, matching server/services/
// serverManager.js's real scanFailed shape (it always resolves
// `running: false` alongside `scanFailed: true`, never `running:
// undefined`), so the old ternary's `typeof data.running === 'boolean'`
// check passes and lands on a confident 'stopped'. Restored after
// confirming the predicted failure.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: false,
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
    },
    serverApi: {
      ...actual.serverApi,
      getStatus: vi.fn(),
    },
    updateApi: {
      ...actual.updateApi,
      getStatus: vi.fn(),
    },
    modsApi: {
      ...actual.modsApi,
      getStatus: vi.fn(),
    },
    panelUpdateApi: {
      ...actual.panelUpdateApi,
      getStatus: vi.fn(),
    },
  }
})

const getAll = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(serverApi.getStatus)
const updateGetStatus = vi.mocked(updateApi.getStatus)
const modsGetStatus = vi.mocked(modsApi.getStatus)
const panelUpdateGetStatus = vi.mocked(panelUpdateApi.getStatus)

const NATIVE_ACTIVE_SERVER = {
  id: 1,
  name: 'the-only-server',
  serverName: 'a-cfg',
  installPath: '/srv/a',
  zomboidDataPath: '/srv/a/data',
  serverConfigPath: '/srv/a/data/Server/a.ini',
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

function renderLayout() {
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={null}>
        <Layout>
          <div>page content</div>
        </Layout>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

function mockCommonFetches() {
  updateGetStatus.mockResolvedValue({} as never)
  modsGetStatus.mockResolvedValue({ updatesAvailable: 0 } as never)
  panelUpdateGetStatus.mockResolvedValue({ updateAvailable: false } as never)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ version: '1.2.19' }) })),
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('Layout.tsx: sidebar Active Server dot honors scanFailed, does not collapse to a confident state', () => {
  it('native provider, getStatus() scanFailed:true -- sr-only status text and strip class read Unknown, never Stopped', async () => {
    getAll.mockResolvedValue({ servers: [NATIVE_ACTIVE_SERVER] } as never)
    // Matches server/services/serverManager.js's real scanFailed shape --
    // it resolves `{ running: false, matched: [], scanFailed: true }`,
    // never `running: undefined`. running:false is what makes the old
    // buggy ternary (`data.running ? 'running' : 'stopped'`, no scanFailed
    // check at all) land on a CONFIDENT 'stopped' instead of just staying
    // at the initial 'unknown' -- a running:undefined fixture would not
    // have reproduced the real bug.
    getStatus.mockResolvedValue({ running: false, scanFailed: true } as never)
    mockCommonFetches()

    renderLayout()

    await screen.findByText('the-only-server')

    const label = await screen.findByText('Server status unknown', {}, { timeout: 5000 })
    expect(label).toBeInTheDocument()
    expect(screen.queryByText('Server is stopped')).not.toBeInTheDocument()
    expect(screen.queryByText('Server is running')).not.toBeInTheDocument()

    const strip = label.closest('.active-server-strip')
    expect(strip).not.toBeNull()
    expect(strip!.className).toMatch(/active-server-strip--unknown/)
    expect(strip!.className).not.toMatch(/active-server-strip--(stopped|running)/)
  })

  it('break-verify control: native provider, getStatus() a confirmed running:true -- dot reads Running, proving the harness detects a real state change', async () => {
    getAll.mockResolvedValue({ servers: [NATIVE_ACTIVE_SERVER] } as never)
    getStatus.mockResolvedValue({ running: true } as never)
    mockCommonFetches()

    renderLayout()

    await screen.findByText('the-only-server')

    const label = await screen.findByText('Server is running', {}, { timeout: 5000 })
    const strip = label.closest('.active-server-strip')
    expect(strip!.className).toMatch(/active-server-strip--running/)
  })
})
