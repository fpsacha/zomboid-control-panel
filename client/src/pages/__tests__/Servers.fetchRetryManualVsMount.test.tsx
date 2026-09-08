import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers from '../Servers'
import { serversApi, serversDetectApi, dockerApi, configApi, updateApi } from '@/lib/api'

// 2026-09-08 (retry-stacking sweep, god's ruling): serversApi.getAll() is the
// first of 5 pages proving the {retries:0}-on-manual-only shape before it's
// threaded through the other 8 wrapper methods. The trap this test exists to
// catch: fetchServers() serves BOTH the mount effect AND the Retry button --
// passing {retries:0} unconditionally would fix the button by breaking the
// exact transient-blip tolerance auto-retry exists for on cold load. This
// proves both halves in one file: a mount that fails persistently still
// retries (the machine decided to fetch, auto-retry is right), and a Retry
// click issues exactly ONE request (a human already IS the retry, and they
// are watching a button that would otherwise look dead for ~7s).
//
// serversApi.getAll is deliberately left REAL (not mocked) so this exercises
// the actual apiGet()/fetchWithRetry() chain the fix lives in -- every other
// API this page calls on mount is mocked away since only getAll's retry
// behavior is under test here.

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
    serversApi: {
      ...actual.serversApi,
      // getAll: intentionally NOT overridden -- stays real.
      getStatus: vi.fn().mockResolvedValue({ servers: [] }),
      getRconStatuses: vi.fn().mockResolvedValue({ servers: [] }),
      discoverMounts: vi.fn().mockResolvedValue({ mounts: [] }),
    },
    serversDetectApi: {
      ...actual.serversDetectApi,
    },
    dockerApi: {
      ...actual.dockerApi,
      getStatus: vi.fn().mockResolvedValue({ enabled: false, available: false, containers: [] }),
      getStats: vi.fn().mockResolvedValue({ containers: {} }),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn().mockResolvedValue({ settings: {} }),
    },
    updateApi: {
      ...actual.updateApi,
      getStatus: vi.fn().mockResolvedValue({ updateAvailable: false }),
    },
  }
})

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

function renderServers() {
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={null}>
        <TooltipProvider>
          <ConfirmProvider>
            <Servers />
          </ConfirmProvider>
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

function serverErrorResponse(): Response {
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

describe('Servers.tsx: fetchServers() retries on mount, but not on a manual Retry click', () => {
  it('mount: a persistently-failing /api/servers gets the full automatic retry treatment (more than one request)', async () => {
    let serversCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/servers')) {
          serversCallCount++
          return serverErrorResponse()
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }),
    )

    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderServers()

    // fetchWithRetry's own backoff: baseDelay 1000ms doubling to a 5000ms
    // cap across up to 3 retries -- 15s of fake-clock advance comfortably
    // covers all 4 attempts (1 initial + 3 retries) plus their delays.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })

    await waitFor(() => expect(serversCallCount).toBeGreaterThan(1))
  })

  it('manual Retry click: issues exactly ONE request to /api/servers, not the automatic-retry count', async () => {
    let serversCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/servers')) {
          serversCallCount++
          return serverErrorResponse()
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }),
    )

    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderServers()

    // Let the mount's own auto-retry sequence fully exhaust and the error
    // banner appear before touching the Retry button -- otherwise a click
    // during the mount's in-flight retries would be indistinguishable from
    // one of its own attempts.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })
    const retryButton = await screen.findByRole('button', { name: /retry/i })
    const countBeforeManualClick = serversCallCount
    expect(countBeforeManualClick).toBeGreaterThan(1) // sanity: mount did retry

    act(() => { retryButton.click() })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })

    expect(serversCallCount - countBeforeManualClick).toBe(1)
  })
})
