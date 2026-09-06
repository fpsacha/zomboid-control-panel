import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { modsApi, serversApi } from '@/lib/api'

// bug-hunt-2026-09-04/05 (confirmed by an independent overnight sweep,
// concrete scenario named at Mods.tsx:913): "Save load order" writes the
// PREVIOUS server's mod list into the NEW active server's real INI.
// saveModOrder(orderedModIds) takes no server id -- it resolves the active
// server fresh server-side per request, same pattern as ServerConfig's
// ini/sandbox routes -- and this page never listened for activeServerChanged
// at all (mount-only). Reorder mods on server A, switch to server B
// elsewhere, hit Save: A's order lands in B's config.

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
    modsApi: {
      ...actual.modsApi,
      getTrackedMods: vi.fn(),
      getStatus: vi.fn(),
      getCurrentConfig: vi.fn(),
      getIgnoredMods: vi.fn(),
      getIgnoredModPairs: vi.fn(),
      collectionDiff: vi.fn(),
      getPresets: vi.fn(),
      getCachedConflicts: vi.fn(),
      listDiskOnly: vi.fn(),
      saveModOrder: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getActive: vi.fn() },
  }
})

// A fake socket the test can fire activeServerChanged on directly. STABLE
// module-level reference -- a fresh object literal per useSocket() call
// thrashes any effect depending on [socket, ...] (re-fetches on every
// render instead of once -- see tonight's Console.tsx mount-test for the
// full story of that failure mode).
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

const getTrackedMods = vi.mocked(modsApi.getTrackedMods)
const getStatus = vi.mocked(modsApi.getStatus)
const getCurrentConfig = vi.mocked(modsApi.getCurrentConfig)
const getIgnoredMods = vi.mocked(modsApi.getIgnoredMods)
const getIgnoredModPairs = vi.mocked(modsApi.getIgnoredModPairs)
const collectionDiff = vi.mocked(modsApi.collectionDiff)
const getPresets = vi.mocked(modsApi.getPresets)
const getCachedConflicts = vi.mocked(modsApi.getCachedConflicts)
const listDiskOnly = vi.mocked(modsApi.listDiskOnly)
const saveModOrder = vi.mocked(modsApi.saveModOrder)
const getActive = vi.mocked(serversApi.getActive)

function primeReadMocks() {
  getTrackedMods.mockResolvedValue({ mods: [] } as never)
  getStatus.mockResolvedValue({ totalModsTracked: 2, workshopAcfConfigured: false, autoRestartEnabled: false } as never)
  getCurrentConfig.mockResolvedValue({
    configured: true,
    modIds: ['modA', 'modB'],
    workshopIds: [],
    maps: [],
    totalMods: 2,
  } as never)
  getIgnoredMods.mockResolvedValue([] as never)
  getIgnoredModPairs.mockResolvedValue([] as never)
  collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  getPresets.mockResolvedValue([] as never)
  getCachedConflicts.mockResolvedValue(null as never)
  listDiskOnly.mockResolvedValue({ mods: [] } as never)
  getActive.mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as never)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

function renderMods() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Mods />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function waitForLoaded() {
  await waitFor(() => expect(getTrackedMods).toHaveBeenCalled())
}

describe('Mods.tsx: activeServerChanged blocks Save Load Order while a reorder is unsaved', () => {
  it('does not let Save Order write the previous server\'s list into the new active server', async () => {
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    fireEvent.click(await screen.findByRole('button', { name: /load order/i }))
    // Two mods -> two rows, each with its own Move up/Move down button --
    // pick row 0's Move down (only disabled on the last row).
    const moveDownButtons = await screen.findAllByRole('button', { name: /move down/i })
    fireEvent.click(moveDownButtons[0])

    const saveButton = await screen.findByRole('button', { name: /save order/i })
    expect(saveButton).not.toBeDisabled()

    act(() => { emitActiveServerChanged() })

    await waitFor(() => expect(screen.getByRole('button', { name: /save order/i })).toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: /save order/i }))
    expect(saveModOrder).not.toHaveBeenCalled()
  })

  it('reloads unconditionally when there is no pending reorder', async () => {
    primeReadMocks()
    renderMods()
    await waitForLoaded()
    expect(getCurrentConfig).toHaveBeenCalledTimes(1)

    act(() => { emitActiveServerChanged() })

    await waitFor(() => expect(getCurrentConfig).toHaveBeenCalledTimes(2))
  })
})
