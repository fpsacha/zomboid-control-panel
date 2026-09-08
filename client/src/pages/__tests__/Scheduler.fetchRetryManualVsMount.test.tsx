import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Scheduler from '../Scheduler'
import { serverApi } from '@/lib/api'

// 2026-09-08 (retry-stacking sweep, page 3 of 5): same shape as
// Servers.fetchRetryManualVsMount.test.tsx and Mods.fetchRetryManualVsMount
// .test.tsx -- see the former's comment for the full reasoning. This page
// has TWO human-initiated triggers for fetchData(): the error banner's
// Retry button, and the Execution History card's always-visible Refresh
// button -- god's own addition to the sweep ("a Retry button is not the
// only human-initiated fetch"), and this page is the one that actually has
// a second one.
//
// schedulerApi.getTasks() is the one call in fetchData()'s Promise.all that
// is allowed to reject the whole batch (the other three .catch() their own
// failures) -- persistently failing it is what makes the error banner (and
// therefore the Retry button) appear. schedulerApi's 4 methods and
// serversApi.getAll are all left real; serverApi.getStatus (an unrelated
// per-server check elsewhere on the page) is mocked away.

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
    serverApi: {
      ...actual.serverApi,
      getStatus: vi.fn().mockResolvedValue({ servers: [] }),
    },
  }
})

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

function renderScheduler() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Scheduler />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function tasksErrorResponse(): Response {
  return response({ error: 'boom' }, 500)
}

function benignFallback(url: string): Response | null {
  if (url.endsWith('/api/scheduler/cron-presets')) return response({ presets: [] })
  if (url.endsWith('/api/scheduler/status')) return response({})
  if (url.includes('/api/scheduler/history')) return response({ history: [] })
  if (url.endsWith('/api/servers')) return response({ servers: [] })
  return null
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Scheduler.tsx: fetchData() retries on mount, but not on manual triggers', () => {
  it('mount: a persistently-failing /scheduler/tasks gets the full automatic retry treatment (more than one request)', async () => {
    let tasksCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/scheduler/tasks')) {
          tasksCallCount++
          return tasksErrorResponse()
        }
        return benignFallback(url) ?? response({}, 404)
      }),
    )

    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderScheduler()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })

    await waitFor(() => expect(tasksCallCount).toBeGreaterThan(1))
  })

  it('manual Retry click: issues exactly ONE request to /scheduler/tasks', async () => {
    let tasksCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/scheduler/tasks')) {
          tasksCallCount++
          return tasksErrorResponse()
        }
        return benignFallback(url) ?? response({}, 404)
      }),
    )

    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderScheduler()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })
    const retryButton = await screen.findByRole('button', { name: /retry/i })
    const countBeforeManualClick = tasksCallCount
    expect(countBeforeManualClick).toBeGreaterThan(1) // sanity: mount did retry

    act(() => { retryButton.click() })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })

    expect(tasksCallCount - countBeforeManualClick).toBe(1)
  })

  it('Execution History Refresh button: also issues exactly ONE request, not the automatic-retry count', async () => {
    let tasksCallCount = 0
    let failTasks = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/scheduler/tasks')) {
          tasksCallCount++
          return failTasks ? tasksErrorResponse() : response({ tasks: [] })
        }
        return benignFallback(url) ?? response({}, 404)
      }),
    )

    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderScheduler()

    // Let mount fail and exhaust its own retries, then let a SUCCESSFUL
    // load happen so the page's normal (non-error) view -- including the
    // Execution History card -- actually renders.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })
    failTasks = false
    const countAfterMountFailed = tasksCallCount
    const refreshButton = await screen.findByRole('button', { name: /refresh/i })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })

    failTasks = true
    const countBeforeManualClick = tasksCallCount
    act(() => { refreshButton.click() })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })

    expect(countAfterMountFailed).toBeGreaterThan(0)
    expect(tasksCallCount - countBeforeManualClick).toBe(1)
  })
})
