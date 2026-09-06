import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ChunkCleaner from '../ChunkCleaner'
import { chunksApi, serversApi, ApiError } from '@/lib/api'

// bug-hunt-2026-09-06 (god-approved reachability walk, both halves built):
// delete-chunks/delete-region take no server id -- same
// implicit-active-server-resolution shape as Mods.tsx's saveModOrder, except
// irreversible (real chunk files, not an overwritable INI field). Unlike
// Mods/Console's reload-unconditionally shape, refreshing the saves list
// mid-scan would swap the file listing out from under an in-progress chunk
// selection -- a second quiet-corruption bug stacked on the first -- so
// ChunkCleaner instead INVALIDATES the scan (clears it, closes the delete
// dialog, forces a fresh /saves fetch) rather than silently reloading it.
// Half 2 (server-side CHUNKS_STALE_SERVER_SCAN re-check) has its own
// real-temp-dir break-verified coverage in
// server/tests/chunksDeletionLogic.test.js; this file covers only the
// client-side half: the invalidate itself, its customPath no-op, and the
// client's recovery when Half 2 catches a race Half 1 missed.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'technician', capabilities: [] },
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
    chunksApi: {
      ...actual.chunksApi,
      getSaves: vi.fn(),
      getChunks: vi.fn(),
      getStats: vi.fn(),
      deleteChunks: vi.fn(),
    },
  }
})

// A fake socket the test can fire activeServerChanged on directly. STABLE
// module-level reference -- a fresh object literal per useSocket() call
// thrashes any effect depending on [socket, ...] (re-fetches every render
// instead of once; see Mods.activeServerChanged.test.tsx / Console.tsx's
// mount-test for the full story of that failure mode).
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

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getSaves = vi.mocked(chunksApi.getSaves)
const getChunks = vi.mocked(chunksApi.getChunks)
const getStats = vi.mocked(chunksApi.getStats)
const deleteChunks = vi.mocked(chunksApi.deleteChunks)

// jsdom has no ResizeObserver; nothing under test here lives inside the
// canvas or depends on a real measured size (same call as
// ChunkCleaner.capabilityGating.test.tsx).
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const testSave = {
  name: 'Ashenwood',
  modified: '2026-08-20T00:00:00.000Z',
  chunkCount: 1,
  size: 1024,
  sizeFormatted: '1.0 KB',
}

const testChunk = { file: 'chunk_0_0.bin', x: 0, y: 0, size: 1024, modified: '2026-08-20T00:00:00.000Z' }

const testStats = { saveName: 'Ashenwood', totalSize: 1024, totalSizeFormatted: '1.0 KB', folders: {} }

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

function setUp() {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  getResolvedActive.mockResolvedValue({ server: null })
  getSaves.mockResolvedValue({ saves: [testSave], debug: null })
  getChunks.mockResolvedValue({
    chunks: [testChunk],
    bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    isB42: false,
    resolvedServerId: 'server-A',
  })
  getStats.mockResolvedValue(testStats)
}

async function mountWithSelection() {
  render(<ChunkCleaner />)
  const allButton = await screen.findByRole('button', { name: /^all$/i })
  await waitFor(() => expect(allButton).not.toBeDisabled())
  fireEvent.click(allButton)
  await screen.findByRole('button', { name: /delete 1 chunk/i })
}

describe('ChunkCleaner.tsx: activeServerChanged invalidates an in-progress scan instead of reloading it', () => {
  it('clears the loaded scan, closes an open delete confirm dialog, and forces a fresh /saves fetch', async () => {
    setUp()
    await mountWithSelection()

    // Open the delete confirm dialog so the invalidate handler's
    // dialog-closing behavior is actually exercised, not just assumed.
    fireEvent.click(await screen.findByRole('button', { name: /delete 1 chunk/i }))
    await screen.findByRole('button', { name: /delete selected chunks/i })

    getSaves.mockClear()
    getSaves.mockResolvedValue({ saves: [testSave], debug: null })

    emitActiveServerChanged()

    // The confirm dialog closes and the Delete trigger disappears -- the
    // scan (chunks/selectedChunks) was cleared, same as god's Half 1 spec.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /delete selected chunks/i })).not.toBeInTheDocument(),
    )
    expect(screen.queryByRole('button', { name: /delete \d+ chunks?/i })).not.toBeInTheDocument()

    // A fresh /saves fetch was forced, not a silent one -- this is the
    // "require a fresh fetch and re-scan" half of the spec.
    await waitFor(() => expect(getSaves).toHaveBeenCalled())

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Active server changed', variant: 'destructive' }),
    )
  })

  it('is a no-op while a customPath is set -- a customPath scan is pinned to a folder, not the active server', async () => {
    setUp()
    render(<ChunkCleaner />)
    await screen.findByRole('button', { name: /^all$/i })

    fireEvent.click(screen.getByRole('button', { name: /custom path/i }))
    const input = await screen.findByRole('textbox', { name: /custom server path/i })
    getSaves.mockClear()
    getSaves.mockResolvedValue({ saves: [testSave], debug: null })
    fireEvent.change(input, { target: { value: 'D:\\CustomZomboidData' } })
    fireEvent.click(screen.getByRole('button', { name: /^load$/i }))
    await waitFor(() => expect(getSaves).toHaveBeenCalledWith('D:\\CustomZomboidData'))

    getSaves.mockClear()
    emitActiveServerChanged()

    // Nothing should have happened: no extra /saves fetch, no toast --
    // this page isn't server-scoped at all while pinned to a custom path.
    await new Promise((r) => setTimeout(r, 50))
    expect(getSaves).not.toHaveBeenCalled()
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Active server changed' }),
    )
  })
})

describe('ChunkCleaner.tsx: CHUNKS_STALE_SERVER_SCAN recovers the UI the same way the socket event would have', () => {
  it('treats a stale-scan delete refusal as an invalidate, not a generic error toast', async () => {
    setUp()
    await mountWithSelection()

    deleteChunks.mockRejectedValue(
      new ApiError(
        'The active server changed since these chunks were scanned. Refresh the save list and re-select chunks before deleting.',
        { status: 409, code: 'CHUNKS_STALE_SERVER_SCAN' },
      ),
    )
    getSaves.mockClear()
    getSaves.mockResolvedValue({ saves: [testSave], debug: null })

    fireEvent.click(await screen.findByRole('button', { name: /delete 1 chunk/i }))
    fireEvent.click(await screen.findByRole('button', { name: /delete selected chunks/i }))

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Active server changed', variant: 'destructive' }),
      ),
    )
    // The recovery path, not the generic failure toast.
    expect(toastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Error' }))
    await waitFor(() => expect(getSaves).toHaveBeenCalled())
  })
})
