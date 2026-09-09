import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi, panelBridgeApi } from '@/lib/api'
import { ALLOW_OUT_OF_RANGE_SANDBOX_STORAGE_KEY } from '@/lib/serverConfigSchema'

// sandbox-range-override toggle, 2026-09-09 dispatch, objective 2: the
// escape hatch bernanas asked for (client/src/pages/Settings.tsx), scoped
// to warn-not-block per the operator's own "let the game reject it" framing
// applied to the panel side too. Three properties this suite protects:
//   1. ON lets a real, out-of-range NUMBER through Save (warned, not
//      blocked) -- the actual ask.
//   2. ON does NOT let a MALFORMED (non-numeric) value through -- the
//      toggle only ever widens the bounds check, never the "is this a
//      number at all" check.
//   3. Turning it back OFF must never stalemate the field: it can still be
//      edited back in range and Save re-enables -- the exact lockout shape
//      547c625a fixed (a validation gate the workaround's own state can't
//      escape) must not be reintroduced through this new door.

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

// SANDBOX_SCHEMA says { min: 10, max: 500 }; the bridge is left unreachable
// in this suite (rejects) so effectiveSandboxSchema falls back to that
// exact schema range -- isolates the toggle's own effect from the live-
// range fix covered by ServerConfig.sandboxLiveRanges.test.tsx.
function sandboxDataWithZombieDeleteCount(value: number | string) {
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

function renderServerConfigSearchingZombieDeleteCount() {
  return render(
    <MemoryRouter initialEntries={['/server-config?tab=sandbox&search=ZombiesCountBeforeDelete']}>
      <ServerConfig />
    </MemoryRouter>,
  )
}

function mockCommonLoads(zombieDeleteCount: number | string) {
  getResolvedActive.mockResolvedValue({
    server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
  })
  getActive.mockResolvedValue({ server: null } as never)
  getPaths.mockResolvedValue({
    exists: { ini: false, sandbox: true, spawnpoints: false, spawnregions: false },
  } as never)
  getSandbox.mockResolvedValue({ sandbox: sandboxDataWithZombieDeleteCount(zombieDeleteCount) } as never)
  sendCommand.mockRejectedValue(new Error('bridge unreachable'))
}

describe('ServerConfig.tsx: sandboxRangeOverride toggle (client/src/pages/Settings.tsx)', () => {
  it('OFF (default): an out-of-range persisted value still blocks Save, same as before this feature existed', async () => {
    mockCommonLoads(600)
    renderServerConfigSearchingZombieDeleteCount()

    await waitFor(() => expect(getSandbox).toHaveBeenCalled())
    expect(screen.getByText(/fix invalid values before saving/i)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /save & reload/i })[0]).toBeDisabled()
    // The warn-only banner is toggle-gated and must not appear while off.
    expect(screen.queryByText(/will still be saved/i)).not.toBeInTheDocument()
  })

  it('ON: the same out-of-range value no longer blocks Save, and is surfaced as a warning instead', async () => {
    localStorage.setItem(ALLOW_OUT_OF_RANGE_SANDBOX_STORAGE_KEY, 'true')
    mockCommonLoads(600)
    renderServerConfigSearchingZombieDeleteCount()

    await waitFor(() => expect(getSandbox).toHaveBeenCalled())
    // Blocking alert gone...
    expect(screen.queryByText(/fix invalid values before saving/i)).not.toBeInTheDocument()
    // ...replaced by the non-blocking one.
    expect(await screen.findByText(/will still be saved/i)).toBeInTheDocument()
  })

  it('ON: a MALFORMED value (not a number at all) still blocks Save -- the toggle only widens the range check, not "is this a number"', async () => {
    localStorage.setItem(ALLOW_OUT_OF_RANGE_SANDBOX_STORAGE_KEY, 'true')
    mockCommonLoads('not-a-number')
    renderServerConfigSearchingZombieDeleteCount()

    await waitFor(() => expect(getSandbox).toHaveBeenCalled())
    expect(screen.getByText(/fix invalid values before saving/i)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /save & reload/i })[0]).toBeDisabled()
  })

  it('turning it back OFF does not strand the out-of-range field: it stays editable and Save re-enables once fixed', async () => {
    localStorage.setItem(ALLOW_OUT_OF_RANGE_SANDBOX_STORAGE_KEY, 'false')
    mockCommonLoads(600)
    renderServerConfigSearchingZombieDeleteCount()

    await waitFor(() => expect(getSandbox).toHaveBeenCalled())
    expect(screen.getAllByRole('button', { name: /save & reload/i })[0]).toBeDisabled()

    // The field itself must remain a live, editable input (not disabled) --
    // fix it back within the fallback schema range.
    const input = await screen.findByDisplayValue('600')
    expect(input).not.toBeDisabled()
    fireEvent.change(input, { target: { value: '300' } })

    await waitFor(() => {
      expect(screen.queryByText(/fix invalid values before saving/i)).not.toBeInTheDocument()
    })
    const saveButtonsFixed = screen.getAllByRole('button', { name: /save & reload/i })
    for (const button of saveButtonsFixed) {
      expect(button).not.toBeDisabled()
    }
  })
})
