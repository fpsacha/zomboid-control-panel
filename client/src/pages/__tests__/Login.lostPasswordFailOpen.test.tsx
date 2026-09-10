import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Login from '../Login'

// unknown-window-instances-outside-the-bridge, site 2, 2026-09-10:
// resetAvailable/recoveryCodesAvailable are fetched once on mount and
// default to false -- indistinguishable, at handleLostPassword's decision
// point, from "confirmed no reset path exists." Someone clicking "Lost
// password" before those two fetches settle (a slow connection, exactly
// the kind of thing a locked-out user under stress is more likely to hit)
// used to be routed into attempting a local reset-token creation instead
// of straight to the recovery entry screen, even if they already hold a
// real token or code. Fail open: while the checks are still loading, treat
// them the same as "available" and go to entry, same side as
// resolveServerRunning / WorldMap's hasActiveServer / Servers.tsx's
// dockerAvailable.

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ login: vi.fn() }),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderLogin() {
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  )
}

describe('Login.tsx: "Lost password" before the status checks settle must not assume no recovery path exists', () => {
  it('routes to the recovery entry screen, not local-reset creation, while reset/recovery status is still loading', async () => {
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    const resetStatusGate = deferred<Response>()
    const recoveryStatusGate = deferred<Response>()
    const localResetCreate = vi.fn()

    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const u = String(url)
      if (u.includes('/api/health')) {
        return Promise.resolve({ ok: true, json: async () => ({ version: '1.0.0' }) } as Response)
      }
      if (u.includes('/api/auth/reset-status')) return resetStatusGate.promise
      if (u.includes('/api/auth/recovery-status')) return recoveryStatusGate.promise
      if (u.includes('/api/auth/oidc/status')) {
        return Promise.resolve({ ok: true, json: async () => ({ configured: false }) } as Response)
      }
      throw new Error(`unexpected fetch in test: ${u}`)
    }))

    // apiFetch (used by handleCreateLocalReset, the WRONG branch this test
    // proves we no longer take while loading) goes through '../../lib/api' --
    // spying on it is enough to prove it's never called, without needing to
    // mock the whole module.
    const apiModule = await import('../../lib/api')
    vi.spyOn(apiModule, 'apiFetch').mockImplementation(localResetCreate)

    renderLogin()

    // Both status fetches are still pending (never resolved) when this
    // click happens -- the exact window under test.
    fireEvent.click(screen.getByRole('button', { name: /use recovery token|create recovery file|recover account/i }))

    // Proves the fix: routed straight to the token/code entry form...
    expect(screen.getByLabelText(/recovery token|recovery code/i)).toBeInTheDocument()
    // ...and did NOT attempt to create a local reset file.
    expect(localResetCreate).not.toHaveBeenCalled()

    // Let the two status fetches resolve so the effect's cleanup (abort)
    // doesn't fire against an unsettled promise after the test ends.
    resetStatusGate.resolve({ ok: true, json: async () => ({ resetAvailable: false, localResetSupported: false }) } as Response)
    recoveryStatusGate.resolve({ ok: true, json: async () => ({ recoveryCodesAvailable: false }) } as Response)
  })
})
