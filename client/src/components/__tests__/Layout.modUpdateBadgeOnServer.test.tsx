import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Layout from '../Layout'
import { serversApi, serverApi, updateApi, modsApi, panelUpdateApi } from '@/lib/api'

// Caldac (431 tracked, 415 in WorkshopItems=): the Mods page's Installed
// counts leave out a Deactivated item's update (it needs no server update or
// restart), but the Mod Manager nav badge still read the status's
// updatesAvailable, which counts it, and said "1 mod update available" over
// a Mods page showing none. The badge counts the server's own updates.

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
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    serverApi: { ...actual.serverApi, getStatus: vi.fn() },
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
    modsApi: { ...actual.modsApi, getStatus: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn() },
  }
})

const SERVER = {
  id: 1,
  name: 'caldac',
  serverName: 'caldac',
  installPath: '/srv/a',
  zomboidDataPath: '/srv/a/data',
  serverConfigPath: '/srv/a/data/Server',
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
}

function renderLayout(modStatus: Record<string, unknown>) {
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [SERVER] } as never)
  vi.mocked(serverApi.getStatus).mockResolvedValue({ running: true } as never)
  vi.mocked(updateApi.getStatus).mockResolvedValue({} as never)
  vi.mocked(modsApi.getStatus).mockResolvedValue(modStatus as never)
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({ updateAvailable: false } as never)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: '1.6.0' }) })))
  return render(
    <MemoryRouter initialEntries={['/mods']}>
      <Layout>
        <div>page content</div>
      </Layout>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe("Layout: the Mod Manager badge counts the server's own mod updates", () => {
  it('counts only the updates of items in WorkshopItems=', async () => {
    renderLayout({ updatesAvailable: 3, updatesOnServer: 2 })
    expect(await screen.findByTitle('2 mod updates available')).toBeInTheDocument()
  })

  it('shows no badge when the only update is on a Deactivated item', async () => {
    renderLayout({ updatesAvailable: 1, updatesOnServer: 0 })
    await vi.waitFor(() => expect(document.querySelector('a[href="/mods"]')).not.toBeNull())
    await vi.waitFor(() => expect(modsApi.getStatus).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByTitle(/mod updates? available/)).not.toBeInTheDocument()
  })
})
