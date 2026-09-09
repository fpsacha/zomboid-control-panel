import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi, panelBridgeApi } from '@/lib/api'

// sandbox-live-ranges root cause, 2026-09-09 (god's dispatch, following the
// 547c625a lockout investigation): SANDBOX_SCHEMA's min/max
// (client/src/lib/serverConfigSchema.ts) is a build-time snapshot of Project
// Zomboid's engine-side bounds that can never track a PZ patch -- confirmed
// the game ships no min/max on disk to read instead (compiled engine-side,
// only obtainable from a running server). The Mod Settings tab's own
// getAllSandboxOptions bridge call already asks the running game for these
// bounds live, for every option including the vanilla ones it then filters
// out of its own UI. This proves the Sandbox tab now prefers that live bound
// over the stale schema table when the bridge can supply one, and correctly
// falls back to the schema (never blocking the tab) when it can't.

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

vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({ on: () => {}, off: () => {} }),
}))

const getResolvedActive = vi.spyOn(serversApi, 'getResolvedActive')
const getActive = vi.spyOn(serversApi, 'getActive')
const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getSandbox = vi.spyOn(serverFilesApi, 'getSandbox')
const sendCommand = vi.spyOn(panelBridgeApi, 'sendCommand')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

// SANDBOX_SCHEMA declares ZombiesCountBeforeDelete as { min: 10, max: 500,
// section: 'ZombieConfig' }. 600 is out of range against that stale table
// but within a live bound this test supplies (10-1000) -- exactly the
// "the table said 500, the running game allows more" scenario bernanas
// reported.
function sandboxDataWithZombieDeleteCount(value: number) {
  return {
    VERSION: 1,
    settings: {},
    ZombieLore: {},
    ZombieConfig: { ZombiesCountBeforeDelete: value },
    MultiplierConfig: {},
    Map: {},
    Basement: {},
  }
}

function renderServerConfigOnSandboxTab() {
  return render(
    <MemoryRouter initialEntries={['/server-config?tab=sandbox']}>
      <ServerConfig />
    </MemoryRouter>,
  )
}

// Deep-links straight to the one setting via the search query param
// (resolveServerConfigDeepLink) -- the row otherwise sits in the
// 'zombiePopulation' category, not the default 'time' rail tab, and would
// need a category click to become visible.
function renderServerConfigOnSandboxTabSearchingZombieDeleteCount() {
  return render(
    <MemoryRouter initialEntries={['/server-config?tab=sandbox&search=ZombiesCountBeforeDelete']}>
      <ServerConfig />
    </MemoryRouter>,
  )
}

function mockCommonLoads() {
  getResolvedActive.mockResolvedValue({
    server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
  })
  getActive.mockResolvedValue({ server: null } as never)
  getPaths.mockResolvedValue({
    exists: { ini: false, sandbox: true, spawnpoints: false, spawnregions: false },
  } as never)
}

describe('ServerConfig.tsx: Sandbox tab prefers a live PanelBridge range over the stale SANDBOX_SCHEMA table', () => {
  it('opening the Sandbox tab itself asks the bridge for live ranges (not just the Mod Settings tab)', async () => {
    mockCommonLoads()
    getSandbox.mockResolvedValue({ sandbox: sandboxDataWithZombieDeleteCount(300) } as never)
    sendCommand.mockResolvedValue({
      success: true,
      data: { options: {}, groups: [], totalCount: 0, enumerated: true },
    } as never)

    renderServerConfigOnSandboxTab()

    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('getAllSandboxOptions', {}, expect.anything()))
  })

  it('a value the stale schema rejects (600 > its hardcoded max 500) no longer blocks Save when the live bridge reports a wider bound', async () => {
    mockCommonLoads()
    getSandbox.mockResolvedValue({ sandbox: sandboxDataWithZombieDeleteCount(600) } as never)
    sendCommand.mockResolvedValue({
      success: true,
      data: {
        options: {
          ZombieConfig: [
            { name: 'ZombieConfig.ZombiesCountBeforeDelete', shortName: 'ZombiesCountBeforeDelete', tableName: 'ZombieConfig', type: 'number', min: 10, max: 1000, value: 600 },
          ],
        },
        groups: [{ name: 'ZombieConfig', count: 1 }],
        totalCount: 1,
        enumerated: true,
      },
    } as never)

    renderServerConfigOnSandboxTabSearchingZombieDeleteCount()

    await waitFor(() => expect(sendCommand).toHaveBeenCalled())

    // The live range must actually reach the row: the displayed range label
    // should read the live 10-1000, not the stale schema's 10-500.
    await waitFor(() => expect(screen.getByText('10 – 1000')).toBeInTheDocument())

    const saveButton = await screen.findByRole('button', { name: /save & reload/i })
    // No local edit was made (hasSandboxChanges is false), so this alone
    // doesn't prove the range fix -- the companion "still blocks with a
    // stale/unavailable range" test below is the contrast case.
    expect(saveButton).toBeDisabled()
    // The blocking reason must not be "600 is out of range" -- that alert
    // only renders when invalidSandboxSettings is non-empty.
    expect(screen.queryByText(/fix invalid values before saving/i)).not.toBeInTheDocument()
  })

  it('falls back to the stale schema range (and still flags 600 as invalid) when the bridge is unreachable -- never blocks the tab itself', async () => {
    mockCommonLoads()
    getSandbox.mockResolvedValue({ sandbox: sandboxDataWithZombieDeleteCount(600) } as never)
    sendCommand.mockRejectedValue(new Error('network error'))

    renderServerConfigOnSandboxTab()

    await waitFor(() => expect(sendCommand).toHaveBeenCalled())

    // Fallback notice shown, but the tab is still fully usable underneath.
    await waitFor(() => expect(screen.getByText(/showing built-in ranges/i)).toBeInTheDocument())
    expect(screen.getByText(/fix invalid values before saving/i)).toBeInTheDocument()

    const saveButton = screen.getAllByRole('button', { name: /save & reload/i })[0]
    expect(saveButton).toBeDisabled()
  })
})
