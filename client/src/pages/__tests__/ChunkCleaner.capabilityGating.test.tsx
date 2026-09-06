import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ChunkCleaner from '../ChunkCleaner'
import { chunksApi, serversApi, panelBridgeApi, ApiError } from '@/lib/api'

// 2026-08-27 bug-hunt (god's f7ac68): ChunkCleaner had exactly one test file
// before this one, ChunkCleaner.canvasKeyboardClaim.test.ts, which pins
// locale copy and never renders the component -- its own comment says
// mounting was judged not worth the cost at the time. The page was gated
// for chunks.manage in 22743fe, hardened in 3e46b62, and had the
// removeVehiclesInArea 403-swallow bug fixed in 4a0b1dd -- none of that had
// coverage. Reusing WorldMap.capabilityGating.test.tsx's solved mounting
// problem (this page needs a no-op ResizeObserver only -- unlike WorldMap,
// none of the controls under test live inside the canvas, so a synchronous
// sized stub isn't needed here) plus the save -> scan -> chunks-loaded gate
// documented in the canvasKeyboardClaim comment block. Selection is driven
// through the "All" button (selectAll(), a plain JS Set built from `chunks`)
// rather than simulating canvas mouse-drag geometry -- same reachable
// end-state, far cheaper to set up.

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'technician', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => mockCan(capability),
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
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      sendCommand: vi.fn(),
    },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getSaves = vi.mocked(chunksApi.getSaves)
const getChunks = vi.mocked(chunksApi.getChunks)
const getStats = vi.mocked(chunksApi.getStats)
const deleteChunks = vi.mocked(chunksApi.deleteChunks)
const sendCommand = vi.mocked(panelBridgeApi.sendCommand)

// jsdom has no ResizeObserver. Unlike WorldMap, nothing under test here
// (Select All / the Delete button / the confirm dialog) lives inside the
// canvas or depends on a real measured size, so a no-op stub is enough --
// the same "stub only as strong as the code path traversed" rule god
// confirmed for the Events.tsx Slider stub.
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

const testChunk = {
  file: 'chunk_0_0.bin',
  x: 0,
  y: 0,
  size: 1024,
  modified: '2026-08-20T00:00:00.000Z',
}

const testStats = {
  saveName: 'Ashenwood',
  totalSize: 1024,
  totalSizeFormatted: '1.0 KB',
  folders: {},
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderChunkCleaner() {
  return render(<ChunkCleaner />)
}

function setUp() {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  getResolvedActive.mockResolvedValue({ server: null })
  getSaves.mockResolvedValue({ saves: [testSave], debug: null })
  getChunks.mockResolvedValue({ chunks: [testChunk], bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, isB42: false })
  getStats.mockResolvedValue(testStats)
  deleteChunks.mockResolvedValue({ deleted: 1, vehiclesDeleted: 0, errors: [] })
  sendCommand.mockImplementation((action: string) => {
    if (action === 'getVehiclesDetailed') return Promise.resolve({ success: true, data: { vehicles: [] } })
    if (action === 'getSafehouses') return Promise.resolve({ success: true, data: { safehouses: [] } })
    if (action === 'removeVehiclesInArea') return Promise.resolve({ success: true, data: {} })
    return Promise.resolve({ success: true, data: {} })
  })
}

// Waits for the mount-time fetchSaves -> auto-select -> loadChunks chain to
// settle, then selects every loaded chunk via the "All" button so the
// Delete button (which only renders once selectedChunks.size > 0) appears.
async function mountWithSelection() {
  renderChunkCleaner()
  const allButton = await screen.findByRole('button', { name: /^all$/i })
  await waitFor(() => expect(allButton).not.toBeDisabled())
  fireEvent.click(allButton)
}

describe('ChunkCleaner.tsx: chunks.manage gates the Delete flow', () => {
  it('disables the Delete button and a click never calls deleteChunks when the role lacks chunks.manage', async () => {
    mockCan = () => false
    setUp()
    await mountWithSelection()

    const deleteButton = await screen.findByRole('button', { name: /delete 1 chunk/i })
    expect(deleteButton).toBeDisabled()

    fireEvent.click(deleteButton)
    await waitFor(() => expect(deleteChunks).not.toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /delete selected chunks/i })).not.toBeInTheDocument()
  })

  it('opens the confirm dialog and clicking through calls deleteChunks when the role holds chunks.manage', async () => {
    mockCan = () => true
    setUp()
    await mountWithSelection()

    const deleteButton = await screen.findByRole('button', { name: /delete 1 chunk/i })
    expect(deleteButton).not.toBeDisabled()
    fireEvent.click(deleteButton)

    const confirmButton = await screen.findByRole('button', { name: /delete selected chunks/i })
    fireEvent.click(confirmButton)

    await waitFor(() =>
      expect(deleteChunks).toHaveBeenCalledWith(
        'Ashenwood',
        [{ file: 'chunk_0_0.bin', x: 0, y: 0, source: undefined, cellX: undefined, cellY: undefined }],
        true,
        undefined,
        true,
        false,
        // bug-hunt-2026-09-06: expectedServerId, threaded from the scan's
        // own resolvedServerId (getChunks' mock here returns none, so null).
        null,
      ),
    )
  })
})

describe('ChunkCleaner.tsx: removeVehiclesInArea 403 vs benign-failure toast (4a0b1dd)', () => {
  it('shows the no-permission toast on a 403 -- distinguishable from the benign server-stopped case', async () => {
    mockCan = () => true
    setUp()
    sendCommand.mockImplementation((action: string) => {
      if (action === 'getVehiclesDetailed') return Promise.resolve({ success: true, data: { vehicles: [] } })
      if (action === 'getSafehouses') return Promise.resolve({ success: true, data: { safehouses: [] } })
      if (action === 'removeVehiclesInArea') return Promise.reject(new ApiError('Forbidden', { status: 403 }))
      return Promise.resolve({ success: true, data: {} })
    })
    await mountWithSelection()

    fireEvent.click(await screen.findByRole('button', { name: /delete 1 chunk/i }))
    fireEvent.click(await screen.findByRole('button', { name: /delete selected chunks/i }))

    await waitFor(() => expect(deleteChunks).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Live Vehicle Cleanup Skipped' }),
      ),
    )
  })

  it('does not show the no-permission toast when removeVehiclesInArea fails for a benign reason (bridge unreachable)', async () => {
    mockCan = () => true
    setUp()
    sendCommand.mockImplementation((action: string) => {
      if (action === 'getVehiclesDetailed') return Promise.resolve({ success: true, data: { vehicles: [] } })
      if (action === 'getSafehouses') return Promise.resolve({ success: true, data: { safehouses: [] } })
      if (action === 'removeVehiclesInArea') return Promise.reject(new ApiError('Bridge not connected', { status: 503 }))
      return Promise.resolve({ success: true, data: {} })
    })
    await mountWithSelection()

    fireEvent.click(await screen.findByRole('button', { name: /delete 1 chunk/i }))
    fireEvent.click(await screen.findByRole('button', { name: /delete selected chunks/i }))

    await waitFor(() => expect(deleteChunks).toHaveBeenCalledTimes(1))
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Live Vehicle Cleanup Skipped' }),
    )
  })
})
