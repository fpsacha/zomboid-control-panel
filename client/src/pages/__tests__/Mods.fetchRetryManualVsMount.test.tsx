import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { modsApi, serverApi, serversApi } from '@/lib/api'

// 2026-09-08 (retry-stacking sweep, page 2 of 5): same shape as
// Servers.fetchRetryManualVsMount.test.tsx -- see that file's comment for
// the full reasoning. fetchData() here batches 5 modsApi GETs through
// Promise.allSettled; getTrackedMods (index 0) also has its own bespoke
// 1500ms-later inner retry on failure, independent of fetchWithRetry and
// NOT part of this fix's scope (it's a different, pre-existing mechanism,
// and it isn't gated by `manual` either way). To keep this test's counting
// unambiguous, the assertions track /mods/status instead -- the same
// Promise.allSettled batch, same {manual}-driven {retries:0}, but with no
// extra retry logic layered on top to confound the count.
//
// modsApi's 5 GET methods (getTrackedMods/getStatus/getCurrentConfig/
// getIgnoredMods/getIgnoredModPairs) are deliberately left REAL; everything
// else the page needs on mount is mocked away.

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
      // getTrackedMods/getStatus/getCurrentConfig/getIgnoredMods/
      // getIgnoredModPairs: intentionally NOT overridden -- stay real.
      collectionDiff: vi.fn().mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false }),
      getPresets: vi.fn().mockResolvedValue([]),
      getCachedConflicts: vi.fn().mockResolvedValue(null),
      listDiskOnly: vi.fn().mockResolvedValue({ mods: [] }),
    },
    serversApi: {
      ...actual.serversApi,
      getActive: vi.fn().mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } }),
    },
    serverApi: {
      ...actual.serverApi,
      listDirectory: vi.fn().mockReturnValue(new Promise(() => {})),
    },
  }
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

function errorResponse(): Response {
  return new Response(JSON.stringify({ error: 'boom' }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Mods.tsx: fetchData() retries on mount, but not on a manual Retry click', () => {
  it('mount: a persistently-failing batch gets the full automatic retry treatment on /mods/status (more than one request)', async () => {
    let statusCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/mods/status')) {
          statusCallCount++
          return errorResponse()
        }
        return errorResponse() // every mods endpoint fails, so the banner shows
      }),
    )

    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderMods()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })

    await waitFor(() => expect(statusCallCount).toBeGreaterThan(1))
  })

  it('manual Retry click: issues exactly ONE request to /mods/status, not the automatic-retry count', async () => {
    let statusCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/mods/status')) {
          statusCallCount++
        }
        return errorResponse()
      }),
    )

    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderMods()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })
    const retryButton = await screen.findByRole('button', { name: /retry/i })
    const countBeforeManualClick = statusCallCount
    expect(countBeforeManualClick).toBeGreaterThan(1) // sanity: mount did retry

    act(() => { retryButton.click() })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })

    expect(statusCallCount - countBeforeManualClick).toBe(1)
  })
})
