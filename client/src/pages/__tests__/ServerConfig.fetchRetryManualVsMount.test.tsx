import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { serversApi } from '@/lib/api'

// 2026-09-08 (retry-stacking sweep, page 5 of 5): same shape as the other
// four pages -- see Servers.fetchRetryManualVsMount.test.tsx for the full
// reasoning. loadData() awaits serverFilesApi's 5 GET methods SEQUENTIALLY
// (not Promise.all/allSettled), so a persistent getPaths() failure alone
// short-circuits the rest and is sufficient to drive the error banner --
// confirmed against ServerConfig.remoteServerLoadError.test.tsx, which
// proves the same thing for a DIFFERENT reason (a coded rejection, not a
// transport retry). This page has THREE human-initiated triggers for
// loadData(): two Retry buttons (the load-error banner, the
// server-changed banner) and the page header's own Refresh button.
//
// serverFilesApi.getPaths is deliberately left real (not mocked/spied) so
// this exercises the actual apiGet()/fetchWithRetry() chain; only global
// fetch is mocked at the network boundary. serversApi.getResolvedActive is
// spied (not part of this fix -- it already catches its own failures) so
// it resolves immediately without touching the network at all.

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

const getResolvedActive = vi.spyOn(serversApi, 'getResolvedActive')

function renderServerConfig() {
  return render(
    <MemoryRouter>
      <ServerConfig />
    </MemoryRouter>,
  )
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('ServerConfig.tsx: loadData() retries on mount, but not on any of its three manual triggers', () => {
  it('mount: a persistently-failing /server-files/paths gets the full automatic retry treatment (more than one request)', async () => {
    getResolvedActive.mockResolvedValue({ server: { id: 1, name: 'Test Server', isRemote: false } } as never)
    let pathsCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/server-files/paths')) {
          pathsCallCount++
          return response({ error: 'boom' }, 500)
        }
        return response({}, 404)
      }),
    )

    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderServerConfig()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })

    await waitFor(() => expect(pathsCallCount).toBeGreaterThan(1))
  })

  it('manual Retry click: issues exactly ONE request to /server-files/paths, not the automatic-retry count', async () => {
    getResolvedActive.mockResolvedValue({ server: { id: 1, name: 'Test Server', isRemote: false } } as never)
    let pathsCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/server-files/paths')) {
          pathsCallCount++
          return response({ error: 'boom' }, 500)
        }
        return response({}, 404)
      }),
    )

    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderServerConfig()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })
    const retryButton = await screen.findByRole('button', { name: /retry/i })
    const countBeforeManualClick = pathsCallCount
    expect(countBeforeManualClick).toBeGreaterThan(1) // sanity: mount did retry

    act(() => { retryButton.click() })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })

    expect(pathsCallCount - countBeforeManualClick).toBe(1)
  })

  it('page header Refresh button: also issues exactly ONE request, proving the fix is not tied to just the error banner', async () => {
    getResolvedActive.mockResolvedValue({ server: { id: 1, name: 'Test Server', isRemote: false } } as never)
    let pathsCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/server-files/paths')) {
          pathsCallCount++
          return response({ error: 'boom' }, 500)
        }
        return response({}, 404)
      }),
    )

    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderServerConfig()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })
    const refreshButton = await screen.findByRole('button', { name: /refresh/i })
    const countBeforeManualClick = pathsCallCount
    expect(countBeforeManualClick).toBeGreaterThan(1) // sanity: mount did retry

    act(() => { refreshButton.click() })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })

    expect(pathsCallCount - countBeforeManualClick).toBe(1)
  })
})
