import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import { configApi, serversApi } from '@/lib/api'

// bug-hunt-2026-09-04 (Settings.tsx edit-loss lead, approved design): the
// activeServerChanged handler reloaded configApi.getAppSettings()
// unconditionally, with no isDirty check -- a user mid-edit on this page
// (Panel Port, HTTPS, CORS, security fields) lost that typing the instant
// anyone switched the active server anywhere in the app. Unlike
// ServerConfig's fix, this doesn't need a block-and-warn banner:
// PUT /app-settings (server/routes/config.js) is a flat GLOBAL key/value
// store with no server-id resolution, so there is no "wrong target" risk --
// skipping the reload while dirty is simply safe. The adjacent bug this
// masked: the thing that DOES go stale on a switch (activeServer's
// rconHost/rconPort/name, from a separate fetchServers() call) was never
// refreshed by this listener at all.

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
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
  }
})

// A fake socket the test can fire activeServerChanged on directly. Must be a
// STABLE reference (module-level singleton) -- Settings.tsx's own listener
// effect depends on [socket, ...], and a fresh object identity every render
// would re-run (and re-fetch) the effect on every single render instead of
// once, an artifact with no real-Context equivalent.
const socketHandlers = vi.hoisted(() => new Map<string, Set<() => void>>())
const fakeSocket = vi.hoisted(() => ({
  connected: true,
  on: (event: string, handler: () => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: () => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
}))
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => fakeSocket,
}))
function emitActiveServerChanged() {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h())
}

const getAppSettings = vi.mocked(configApi.getAppSettings)
const getAllServers = vi.mocked(serversApi.getAll)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

function renderSettings() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Settings />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

describe('Settings.tsx: activeServerChanged respects unsaved edits, refreshes the servers list either way', () => {
  it('clean (no unsaved edits): both fetchServers and fetchSettings run again', async () => {
    getAppSettings.mockResolvedValue({ settings: { panelPort: '3001' } })
    getAllServers.mockResolvedValue({ servers: [] })

    renderSettings()
    await waitFor(() => expect(getAppSettings).toHaveBeenCalledTimes(1), { timeout: 2000 })
    await waitFor(() => expect(getAllServers).toHaveBeenCalledTimes(1), { timeout: 2000 })

    emitActiveServerChanged()

    await waitFor(() => expect(getAllServers).toHaveBeenCalledTimes(2), { timeout: 2000 })
    await waitFor(() => expect(getAppSettings).toHaveBeenCalledTimes(2), { timeout: 2000 })
  })

  it('dirty (unsaved edit in progress): fetchServers runs again, fetchSettings does NOT -- the typed value survives', async () => {
    getAppSettings.mockResolvedValue({ settings: { panelPort: '3001' } })
    getAllServers.mockResolvedValue({ servers: [] })

    renderSettings()
    await waitFor(() => expect(getAppSettings).toHaveBeenCalledTimes(1), { timeout: 2000 })
    await waitFor(() => expect(getAllServers).toHaveBeenCalledTimes(1), { timeout: 2000 })

    const portInput = await screen.findByRole('spinbutton') as HTMLInputElement
    fireEvent.change(portInput, { target: { value: '9999' } })
    expect(portInput.value).toBe('9999')

    emitActiveServerChanged()

    await waitFor(() => expect(getAllServers).toHaveBeenCalledTimes(2), { timeout: 2000 })
    // Give fetchSettings a fair chance to have fired if the guard were
    // missing, then assert it never did.
    await new Promise((r) => setTimeout(r, 50))
    expect(getAppSettings).toHaveBeenCalledTimes(1)
    expect(portInput.value).toBe('9999')
  })
})
