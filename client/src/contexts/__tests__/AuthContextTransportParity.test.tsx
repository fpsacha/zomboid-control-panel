import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { AuthProvider, useAuth, LOGIN_FAILED_MESSAGE } from '../AuthContext'

// 2026-09-08 (auth-transport-parity): login()/setup() used to construct their
// own ApiError by hand after a raw fetch() that bypassed lib/api.ts's shared
// apiFetch/handleResponse entirely -- the exact "3 raw-fetch call sites miss
// the whole error envelope" gap god's retry-after-countdown-followup card
// flagged and closed as not worth building alone, reopened once the real
// cost turned out to be bigger than a missing Retry-After string (they also
// missed the fetchWithRetry timeout and consistent NETWORK_ERROR/TIMEOUT
// classification, on LOGIN, FIRST-RUN SETUP, and PASSWORD RESET specifically
// -- the three screens where a user has no session and no fallback page.
// This proves the migration to the shared transport preserved every
// caller-specific special case it had to: the account-enumeration collapse
// (401/400 -> one generic message), the SETUP_TOKEN_REQUIRED plain-Error
// passthrough Setup.tsx pattern-matches on, and the CORS-message mapping
// (now keyed off ApiError.code === 'NETWORK_ERROR' instead of a raw
// TypeError, since fetchWithRetry's own toApiError() converts one to the
// other before login()'s catch block ever sees it -- see getLoginErrorMessage's
// own updated comment in AuthContext.tsx).

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// Every AuthProvider mount runs checkAuth() (status -> refresh) before
// anything else -- routing every OTHER url through here lets the harness
// mount cleanly (ends at isAuthenticated:false, authEnabled:true, not
// blocking the login/setup calls under test) while a test's own fetchMock
// intercepts the ONE url it cares about.
function baseFetchRouter(overrides: Record<string, () => Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    for (const [match, respond] of Object.entries(overrides)) {
      if (url.includes(match)) return respond()
    }
    if (url.includes('/api/auth/status')) {
      return jsonResponse(200, { needsSetup: false, authEnabled: true })
    }
    if (url.includes('/api/auth/refresh')) {
      return jsonResponse(401, { error: 'no session' })
    }
    throw new Error(`Unhandled fetch in test: ${url}`)
  })
}

function LoginHarness() {
  const { login } = useAuth()
  const [message, setMessage] = useState<string | null>(null)
  return (
    <div>
      <button
        onClick={() => {
          login('someone', 'wrong').catch((e) => setMessage(e.message))
        }}
      >
        go
      </button>
      {message && <div data-testid="result">{message}</div>}
    </div>
  )
}

function SetupHarness() {
  const { setup } = useAuth()
  const [message, setMessage] = useState<string | null>(null)
  return (
    <div>
      <button
        onClick={() => {
          setup('admin', 'password123').catch((e) => setMessage(e.message))
        }}
      >
        go
      </button>
      {message && <div data-testid="result">{message}</div>}
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AuthContext login()/setup(): shared-transport migration preserves every special case', () => {
  it('login(): still collapses a 401 into the enumeration-safe generic message', async () => {
    vi.stubGlobal(
      'fetch',
      baseFetchRouter({
        '/api/auth/login': () => jsonResponse(401, { error: 'Invalid username or password', code: 'INVALID_CREDENTIALS' }),
      }),
    )
    render(<AuthProvider><LoginHarness /></AuthProvider>)
    await waitFor(() => expect(screen.getByRole('button')).toBeInTheDocument())

    act(() => { screen.getByRole('button').click() })
    await waitFor(() => expect(screen.getByTestId('result')).toBeInTheDocument())

    expect(screen.getByTestId('result').textContent).toBe(LOGIN_FAILED_MESSAGE)
  })

  it("login(): does NOT collapse a genuine 5xx into the generic auth-failed text", async () => {
    vi.stubGlobal(
      'fetch',
      baseFetchRouter({
        '/api/auth/login': () => jsonResponse(500, { error: 'Database connection failed' }),
      }),
    )
    render(<AuthProvider><LoginHarness /></AuthProvider>)
    await waitFor(() => expect(screen.getByRole('button')).toBeInTheDocument())

    act(() => { screen.getByRole('button').click() })
    await waitFor(() => expect(screen.getByTestId('result')).toBeInTheDocument())

    const message = screen.getByTestId('result').textContent
    expect(message).not.toBe(LOGIN_FAILED_MESSAGE)
    expect(message).toContain('Database connection failed')
  })

  it('login(): a network-level failure (CORS or otherwise) still shows the CORS/connectivity message, now via the transport\'s NETWORK_ERROR classification', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/api/auth/login')) throw new TypeError('Failed to fetch')
        if (url.includes('/api/auth/status')) return jsonResponse(200, { needsSetup: false, authEnabled: true })
        if (url.includes('/api/auth/refresh')) return jsonResponse(401, { error: 'no session' })
        throw new Error(`Unhandled fetch in test: ${url}`)
      }),
    )
    render(<AuthProvider><LoginHarness /></AuthProvider>)
    await waitFor(() => expect(screen.getByRole('button')).toBeInTheDocument())

    act(() => { screen.getByRole('button').click() })
    await waitFor(() => expect(screen.getByTestId('result')).toBeInTheDocument())

    expect(screen.getByTestId('result').textContent).toContain('Connection blocked by browser origin policy')
  })

  it('setup(): SETUP_TOKEN_REQUIRED still surfaces as a plain Error with that exact message, for Setup.tsx to pattern-match on', async () => {
    vi.stubGlobal(
      'fetch',
      baseFetchRouter({
        '/api/auth/setup': () => jsonResponse(400, { error: 'Setup token required', code: 'SETUP_TOKEN_REQUIRED' }),
      }),
    )
    render(<AuthProvider><SetupHarness /></AuthProvider>)
    await waitFor(() => expect(screen.getByRole('button')).toBeInTheDocument())

    act(() => { screen.getByRole('button').click() })
    await waitFor(() => expect(screen.getByTestId('result')).toBeInTheDocument())

    expect(screen.getByTestId('result').textContent).toBe('SETUP_TOKEN_REQUIRED')
  })

  it('setup(): a different coded failure still surfaces with its own server-provided message, not the SETUP_TOKEN_REQUIRED short-circuit', async () => {
    vi.stubGlobal(
      'fetch',
      baseFetchRouter({
        '/api/auth/setup': () => jsonResponse(400, { error: 'Password does not meet requirements', code: 'WEAK_PASSWORD' }),
      }),
    )
    render(<AuthProvider><SetupHarness /></AuthProvider>)
    await waitFor(() => expect(screen.getByRole('button')).toBeInTheDocument())

    act(() => { screen.getByRole('button').click() })
    await waitFor(() => expect(screen.getByTestId('result')).toBeInTheDocument())

    expect(screen.getByTestId('result').textContent).toContain('Password does not meet requirements')
  })

  it('login(): a 429 still shows its own registered rate-limit text, not the generic collapse', async () => {
    vi.stubGlobal(
      'fetch',
      baseFetchRouter({
        '/api/auth/login': () => jsonResponse(429, { error: 'Too many login attempts. Please try again later.', code: 'RATE_LIMIT_LOGIN' }),
      }),
    )
    render(<AuthProvider><LoginHarness /></AuthProvider>)
    await waitFor(() => expect(screen.getByRole('button')).toBeInTheDocument())

    act(() => { screen.getByRole('button').click() })
    await waitFor(() => expect(screen.getByTestId('result')).toBeInTheDocument())

    const message = screen.getByTestId('result').textContent
    expect(message).not.toBe(LOGIN_FAILED_MESSAGE)
    expect(message).toContain('Too many login attempts')
  })
})
