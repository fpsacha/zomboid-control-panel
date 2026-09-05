import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi } from '@/lib/api'

// bug-hunt-2026-09-04 (overnight sweep, reported by god as the worst
// unrouted finding of the night): GET/PUT /server-files/ini and /sandbox
// both resolve "the active server" fresh on the server per-request rather
// than taking a server id, and this page never listened for
// activeServerChanged (unlike Settings.tsx/Dashboard.tsx/Servers.tsx/
// WorldMap.tsx/Layout.tsx, which all do). Switch the active server after
// this page has loaded server A's config, hit Save, and the PUT carries
// server A's full settings object to whichever server is active NOW --
// server B's real config is silently overwritten. This proves the fix:
// with no unsaved edits, an activeServerChanged event safely triggers a
// reload (matching the other five pages' own handlers); with unsaved
// edits, reloading would silently discard them instead, so Save is
// blocked and a banner is shown rather than the app choosing for the user.

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

// A fake socket the test can fire activeServerChanged on directly, matching
// how the real socket.io client hands the app plain on/off/emit.
const socketHandlers = vi.hoisted(() => new Map<string, Set<() => void>>())
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({
    on: (event: string, handler: () => void) => {
      if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
      socketHandlers.get(event)!.add(handler)
    },
    off: (event: string, handler: () => void) => {
      socketHandlers.get(event)?.delete(handler)
    },
  }),
}))
function emitActiveServerChanged() {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h())
}

const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getIni = vi.spyOn(serverFilesApi, 'getIni')
const saveIni = vi.spyOn(serverFilesApi, 'saveIni')
const getRaw = vi.spyOn(serverFilesApi, 'getRaw')
const getResolvedActive = vi.spyOn(serversApi, 'getResolvedActive')
// Unrelated to this fix, but polled every 5s by a separate effect
// (refreshServerState) -- left unmocked it retries 3x against a real
// network call jsdom can't make, which alone blows past any reasonable
// test timeout.
const getActive = vi.spyOn(serversApi, 'getActive')

const emptyPaths = {
  exists: { ini: true, sandbox: false, spawnpoints: false, spawnregions: false },
} as never

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

function renderServerConfig() {
  return render(
    <MemoryRouter>
      <ServerConfig />
    </MemoryRouter>,
  )
}

describe('ServerConfig.tsx: activeServerChanged guards the cross-server overwrite', () => {
  it('reloads from the new active server when nothing is unsaved (matches every other page)', async () => {
    getResolvedActive.mockResolvedValue({
      server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
    })
    getPaths.mockResolvedValue(emptyPaths)
    getIni.mockResolvedValue({ settings: { PVP: 'false' }, path: '/a', serverName: 'servera' } as never)
    getActive.mockResolvedValue({ server: null } as never)

    renderServerConfig()
    await waitFor(() => expect(getIni).toHaveBeenCalledTimes(1))

    act(() => { emitActiveServerChanged() })

    await waitFor(() => expect(getIni).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/Active server changed/i)).not.toBeInTheDocument()
  })

  it('blocks Save and warns instead of silently overwriting the new active server when there are unsaved edits', async () => {
    getResolvedActive.mockResolvedValue({
      server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
    })
    getPaths.mockResolvedValue(emptyPaths)
    getIni.mockResolvedValue({ settings: { PVP: 'false' }, path: '/a', serverName: 'servera' } as never)
    getActive.mockResolvedValue({ server: null } as never)
    getRaw.mockResolvedValue({ content: 'PVP=false' } as never)

    renderServerConfig()
    await waitFor(() => expect(getIni).toHaveBeenCalledTimes(1))

    // Force an unsaved edit the same way the raw-editor escape hatch does,
    // without depending on which structured category the schema currently
    // sorts PVP into: flip to the raw tab and edit the textarea directly.
    const rawToggles = await screen.findAllByRole('button', { name: /raw/i })
    await act(async () => { fireEvent.click(rawToggles[0]) })
    await waitFor(() => expect(getRaw).toHaveBeenCalled())
    const textarea = await screen.findByRole('textbox')
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'PVP=true\nedited=true' } })
    })

    act(() => { emitActiveServerChanged() })

    expect(await screen.findByText('Active server changed')).toBeInTheDocument()
    // getIni must NOT be called again -- a silent reload here would discard
    // the edit instead of asking the user, which is its own data loss.
    expect(getIni).toHaveBeenCalledTimes(1)

    // "Saved Configs" (the templates nav button) also matches /save/i and is
    // correctly unaffected -- it doesn't write settings, so exclude it here.
    const saveButtons = screen
      .getAllByRole('button', { name: /save/i })
      .filter((b) => !/saved configs/i.test(b.textContent || ''))
    expect(saveButtons.length).toBeGreaterThan(0)
    for (const btn of saveButtons) {
      expect(btn).toBeDisabled()
    }
    expect(saveIni).not.toHaveBeenCalled()
  })
})
