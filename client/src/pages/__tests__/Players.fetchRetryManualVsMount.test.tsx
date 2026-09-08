import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'

// 2026-09-08 (retry-stacking sweep, page 4 of 5): same shape as the other
// three pages -- see Servers.fetchRetryManualVsMount.test.tsx for the full
// reasoning. This page has FOUR functions gaining a `manual` parameter
// (fetchWhitelist, fetchData/perks, fetchNotesAndStats, fetchActivityLogs),
// each with its own human-initiated trigger(s) found by tracing every call
// site, not just grepping for "retry" -- fetchActivityLogs alone has three
// (a Retry button, an Enter-key filter search, and a filter button), all
// gated, while its fourth call site (opening the Notes/Log tab for the
// first time) is left on the default since that's navigation loading
// content, not a human retrying or refreshing something already visible.
//
// This file proves the mechanism once, on the page header's "Refresh"
// button -> fetchWhitelist(). playersApi.getWhitelist is deliberately left
// real; getPlayers (which already unconditionally passes {retries:0} for
// an unrelated reason -- it's polled every 15s, same shape as Dashboard.tsx)
// and everything else the page needs are mocked away.

const mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => mockCan(capability),
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    playersApi: {
      ...actual.playersApi,
      getPlayers: vi.fn().mockResolvedValue({ players: [] }),
      // getWhitelist: intentionally NOT overridden -- stays real.
      getPerks: vi.fn().mockResolvedValue({ catalog: [] }),
      getAccessLevels: vi.fn().mockResolvedValue({ levels: [], available: true }),
      getSteamIdBans: vi.fn().mockResolvedValue({ bans: [] }),
      getNotes: vi.fn().mockResolvedValue({ notes: [] }),
      getStats: vi.fn().mockResolvedValue({ stats: [] }),
      getExports: vi.fn().mockResolvedValue({ exports: [] }),
      getActivityLogs: vi.fn().mockResolvedValue({ logs: [] }),
    },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn().mockResolvedValue({ modConnected: false, isRunning: false }),
      getAllPlayerDetails: vi.fn().mockResolvedValue({ success: false }),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn().mockResolvedValue({ settings: {} }),
    },
  }
})

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

function renderPlayers() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Players />
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Players.tsx: fetchWhitelist() retries on mount, but not on the header Refresh button', () => {
  it('mount: a persistently-failing /players/whitelist gets the full automatic retry treatment (more than one request)', async () => {
    let whitelistCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/players/whitelist')) {
          whitelistCallCount++
          return response({ error: 'boom' }, 500)
        }
        return response({}, 404)
      }),
    )

    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderPlayers()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })

    await waitFor(() => expect(whitelistCallCount).toBeGreaterThan(1))
  })

  it('Refresh button click: issues exactly ONE request to /players/whitelist, not the automatic-retry count', async () => {
    let whitelistCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/players/whitelist')) {
          whitelistCallCount++
          return response({ error: 'boom' }, 500)
        }
        return response({}, 404)
      }),
    )

    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderPlayers()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })
    const refreshButton = await screen.findByRole('button', { name: /refresh/i })
    const countBeforeManualClick = whitelistCallCount
    expect(countBeforeManualClick).toBeGreaterThan(1) // sanity: mount did retry

    act(() => { refreshButton.click() })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })

    expect(whitelistCallCount - countBeforeManualClick).toBe(1)
  })
})
