import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi, panelBridgeApi, BRIDGE_SLOW_ENUMERATION_TIMEOUT_MS } from '@/lib/api'

// mod-settings-timeout investigation, 2026-09-08 (god's follow-up): raising
// only the client's fetch timeout for getAllSandboxOptions is worthless on
// its own -- the server's OWN pendingCommands timeout (server/services/
// panelBridge.js) deletes its bookkeeping at commandTimeoutMs, 15000ms
// locally / 60000ms once a server is configured over SFTP. Whichever
// deadline fires first decides what the user sees: our own abort produces a
// generic, false "check your connection"; the server's own timeout produces
// an honest failure naming the real actor. This proves the CLIENT side of
// that fix actually shipped: loadModSettings() must request
// getAllSandboxOptions with a timeout comfortably above BOTH server-side
// ceilings, not the shared 15s default every other bridge command gets.

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
// Unrelated to this fix, but polled every 5s by a separate effect
// (refreshServerState) -- left unmocked it retries against a real network
// call jsdom can't make, which alone blows past any reasonable test timeout.
const getActive = vi.spyOn(serversApi, 'getActive')
const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getIni = vi.spyOn(serverFilesApi, 'getIni')
const sendCommand = vi.spyOn(panelBridgeApi, 'sendCommand')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderServerConfigOnModSettingsTab() {
  return render(
    <MemoryRouter initialEntries={['/server-config?tab=modsettings']}>
      <ServerConfig />
    </MemoryRouter>,
  )
}

describe('ServerConfig.tsx: Mod Settings requests getAllSandboxOptions with the slow-enumeration timeout', () => {
  it('overrides the default bridge command timeout instead of using the shared 15s default', async () => {
    getResolvedActive.mockResolvedValue({
      server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
    })
    getActive.mockResolvedValue({ server: null } as never)
    getPaths.mockResolvedValue({
      exists: { ini: true, sandbox: false, spawnpoints: false, spawnregions: false },
    } as never)
    getIni.mockResolvedValue({ settings: {}, path: '/a', serverName: 'servera' } as never)
    sendCommand.mockResolvedValue({
      success: true,
      data: { options: {}, groups: [], totalCount: 0, enumerated: true },
    } as never)

    renderServerConfigOnModSettingsTab()

    await waitFor(() => expect(sendCommand).toHaveBeenCalled())
    expect(sendCommand).toHaveBeenCalledWith(
      'getAllSandboxOptions',
      {},
      { timeout: BRIDGE_SLOW_ENUMERATION_TIMEOUT_MS },
    )
  })

  // Regression guard for the sizing itself, not just that an override is
  // passed: server/services/panelBridge.js's commandTimeoutMs is 60000ms
  // once a server is configured over SFTP (panelBridge.js:188/216) -- a
  // client timeout that "overrides the default" but still sits below that
  // ceiling would still lose the race on every remote install, which is
  // exactly the failure mode this fix exists to close.
  it('the override exceeds the server-side SFTP-mode commandTimeoutMs ceiling (60000ms), not just the local one (15000ms)', () => {
    expect(BRIDGE_SLOW_ENUMERATION_TIMEOUT_MS).toBeGreaterThan(60000)
  })
})
