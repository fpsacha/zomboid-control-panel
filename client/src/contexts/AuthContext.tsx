import { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import { clearAccessToken, getAccessToken, setAccessToken } from '../lib/authToken'
import { ApiError, apiFetch, handleResponse } from '../lib/api'
import { getUserErrorMessage } from '../lib/errorMessage'

interface User {
  id: string
  username: string
  role: string
  // UX-only signal for hiding controls the caller's role can't use (e.g. a
  // Settings tab) -- NOT an access-control boundary; every route this could
  // gate is (and remains) independently enforced server-side via
  // requirePermission(). null means "couldn't resolve" (role renamed out
  // from under the session, a lookup failure, or an older cached response) --
  // treat that as "unknown", never as "no capabilities".
  capabilities: string[] | null
}

interface AuthState {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  needsSetup: boolean
  authEnabled: boolean
}

interface AuthContextType extends AuthState {
  login: (username: string, password: string, rememberMe?: boolean) => Promise<void>
  setup: (username: string, password: string, rememberMe?: boolean, panelPort?: string, setupToken?: string) => Promise<void>
  logout: () => Promise<void>
  getToken: () => string | null
  // Fails OPEN: unknown capabilities (null, or no user yet) return true.
  // Hiding a UI control from a real administrator because a field failed to
  // load is a lockout-shaped support problem with no security benefit --
  // the server still says no to anyone who shouldn't be there regardless of
  // what this returns.
  can: (capability: string) => boolean
}

const AuthContext = createContext<AuthContextType | null>(null)

const CORS_LOGIN_MESSAGE = 'Connection blocked by browser origin policy. For first-time reverse-proxy setup, set CORS_ORIGINS to this URL in the panel environment and restart it. Otherwise open the panel from a local/LAN address; after setup, manage origins in Settings > Remote Access.'

export const LOGIN_FAILED_MESSAGE = "We couldn't sign you in. Check your username and password and try again."

// Exported solely so its 5xx-vs-auth-failure branch can be unit tested
// directly (see __tests__/AuthContext.test.ts) without standing up a
// rendered AuthProvider + mocked fetch harness this file has never needed
// before -- the function itself has no dependency on component state.
export function getLoginErrorMessage(error: unknown): string {
  if (error instanceof TypeError) {
    return CORS_LOGIN_MESSAGE
  }
  if (error instanceof Error && /cors|origin policy|failed to fetch/i.test(error.message)) {
    return CORS_LOGIN_MESSAGE
  }
  // 2026-09-08 (auth-transport-parity): login() now goes through
  // lib/api.ts's shared apiFetch/fetchWithRetry instead of a raw fetch() --
  // that path already converts a browser-level CORS rejection (a TypeError,
  // usually "Failed to fetch") into an ApiError coded NETWORK_ERROR with a
  // different message ("Unable to reach the server...") before it ever
  // reaches this function, so neither check above can match it anymore. The
  // failure this branch exists to catch is unchanged; only its shape is.
  if (error instanceof ApiError && error.code === 'NETWORK_ERROR') {
    return CORS_LOGIN_MESSAGE
  }
  // 2026-09-08 (auth-transport-parity): login() now goes through
  // lib/api.ts's shared apiFetch/fetchWithRetry instead of a raw fetch() --
  // that path already converts a browser-level CORS rejection (a TypeError,
  // usually "Failed to fetch") into an ApiError coded NETWORK_ERROR with a
  // different message ("Unable to reach the server...") before it ever
  // reaches this function, so neither check above can match it anymore. The
  // failure this branch exists to catch is unchanged; only its shape is.
  // 2026-08-26: the enumeration ruling (revealing WHY authentication failed
  // -- wrong username vs. wrong password vs. locked account -- is an
  // account-enumeration oracle) only applies to an actual auth failure
  // (4xx). It says nothing about a genuine server error, which reveals no
  // information about the account either way -- collapsing a real 500 into
  // the identical "check your password" text was never required by that
  // ruling, just an accidental side effect of throwing a plain Error that
  // discarded the response status. A coded 5xx is preferred to the generic
  // fallback text here too, via getUserErrorMessage's normal precedence.
  if (error instanceof ApiError && typeof error.status === 'number' && error.status >= 500) {
    return getUserErrorMessage(error, LOGIN_FAILED_MESSAGE)
  }
  // bug-hunt-2026-09-07 (client silent-failure lane, error-code coverage
  // pass): a 429 from loginLimiter (server/routes/auth.js) used to fall
  // through this function's final `return LOGIN_FAILED_MESSAGE` right
  // alongside an actual wrong-password 401 -- the two are handled by the
  // same generic branch below, but that branch's text ("check your username
  // and password") is actively wrong for a rate-limited attempt, not merely
  // unspecific. The enumeration ruling this function exists to enforce is
  // about NOT revealing why an auth attempt failed; RATE_LIMIT_LOGIN doesn't
  // touch that at all -- "too many attempts" is identical regardless of
  // whether the account exists, so it can safely use its own already-
  // registered, already-translated text (errors.json) instead of being
  // swallowed into the credentials hint.
  if (error instanceof ApiError && error.status === 429) {
    return getUserErrorMessage(error, LOGIN_FAILED_MESSAGE)
  }
  return LOGIN_FAILED_MESSAGE
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    isAuthenticated: false,
    isLoading: true,
    needsSetup: false,
    authEnabled: true,
  })

  // Get stored token
  const getToken = useCallback((): string | null => {
    return getAccessToken()
  }, [])

  // Check auth status and try auto-login
  const checkAuth = useCallback(async () => {
    try {
      // Step 1: Check if auth is needed
      const statusRes = await fetch('/api/auth/status')
      if (!statusRes.ok) {
        // Server might not have auth routes yet — allow access
        setState(prev => ({ ...prev, isLoading: false, authEnabled: false }))
        return
      }
      const status = await statusRes.json()

      if (status.needsSetup) {
        setState(prev => ({
          ...prev,
          isLoading: false,
          needsSetup: true,
          authEnabled: false,
        }))
        return
      }

      if (!status.authEnabled) {
        setState(prev => ({
          ...prev,
          isLoading: false,
          isAuthenticated: true,
          authEnabled: false,
        }))
        return
      }

      // Step 2: Try existing token
      const token = getToken()
      if (token) {
        const meRes = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (meRes.ok) {
          const data = await meRes.json()
          setState({
            user: data.user,
            isAuthenticated: true,
            isLoading: false,
            needsSetup: false,
            authEnabled: true,
          })
          return
        }
        // Token expired — try refresh
        clearAccessToken()
      }

      // Step 3: Try refresh token (httpOnly cookie sent automatically)
      const refreshRes = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      if (refreshRes.ok) {
        const data = await refreshRes.json()
        setAccessToken(data.accessToken)
        setState({
          user: data.user,
          isAuthenticated: true,
          isLoading: false,
          needsSetup: false,
          authEnabled: true,
        })
        return
      }

      // Not authenticated
      setState(prev => ({
        ...prev,
        isLoading: false,
        isAuthenticated: false,
        authEnabled: true,
      }))
    } catch {
      // Network error — assume no auth needed (server might be starting)
      setState(prev => ({ ...prev, isLoading: false, authEnabled: false }))
    }
  }, [getToken])

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  const login = useCallback(async (username: string, password: string, rememberMe = true) => {
    try {
      // 2026-09-08 (auth-transport-parity): was a raw fetch() constructing
      // its own ApiError by hand on failure -- that got the status/code
      // distinction getLoginErrorMessage() needs, but missed everything else
      // the shared transport already does for every other route (Retry-After
      // parsing, the fetchWithRetry timeout, consistent NETWORK_ERROR/TIMEOUT
      // classification). apiFetch/handleResponse throws an equivalent-or-
      // better ApiError on failure via the same buildResponseError() every
      // other call site uses.
      const data = await handleResponse<{ accessToken: string; user: AuthState['user'] }>(
        await apiFetch('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include', // Send/receive cookies
          body: JSON.stringify({ username, password, rememberMe }),
        }),
      )
      setAccessToken(data.accessToken)
      setState({
        user: data.user,
        isAuthenticated: true,
        isLoading: false,
        needsSetup: false,
        authEnabled: true,
      })
    } catch (error) {
      throw new ApiError(getLoginErrorMessage(error), {
        status: error instanceof ApiError ? error.status : undefined,
      })
    }
  }, [])

  const setup = useCallback(async (username: string, password: string, rememberMe = true, panelPort = '3001', setupToken = '') => {
    let data: { accessToken: string; user: AuthState['user'] }
    try {
      // 2026-09-08 (auth-transport-parity): see login()'s own comment above
      // -- same swap, same reasoning.
      data = await handleResponse(
        await apiFetch('/auth/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username, password, rememberMe, panelPort, setupToken }),
        }),
      )
    } catch (error) {
      // Setup.tsx recognizes this exact message and swaps in a localized,
      // token-specific explanation instead of the generic setup-failed copy.
      // Untouched by the ApiError rethrow below: its own copy (see
      // setup.json's invalidSetupToken) is more specific than the
      // registered SETUP_TOKEN_REQUIRED translation, so it must keep
      // winning ahead of getUserErrorMessage() rather than being replaced
      // by it.
      if (error instanceof ApiError && error.code === 'SETUP_TOKEN_REQUIRED') {
        throw new Error('SETUP_TOKEN_REQUIRED')
      }
      if (error instanceof ApiError) throw error
      throw new ApiError("We couldn't create the admin account. Try again.")
    }
    setAccessToken(data.accessToken)
    setState({
      user: data.user,
      isAuthenticated: true,
      isLoading: false,
      needsSetup: false,
      authEnabled: true,
    })
  }, [])

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } catch {
      // Ignore logout errors
    }
    clearAccessToken()
    setState(prev => ({
      ...prev,
      user: null,
      isAuthenticated: false,
    }))
  }, [])

  const can = useCallback(
    (capability: string) => {
      const capabilities = state.user?.capabilities
      if (capabilities == null) return true
      return capabilities.includes(capability)
    },
    [state.user],
  )

  return (
    <AuthContext.Provider value={useMemo(() => ({ ...state, login, setup, logout, getToken, can }), [state, login, setup, logout, getToken, can])}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components -- hook intentionally co-located with its provider
export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
