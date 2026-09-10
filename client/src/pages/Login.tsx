import { useState, useEffect, useRef } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { rawErrorMessageIntentional, getUserErrorMessage } from '../lib/errorMessage'
import { apiFetch, handleResponse } from '../lib/api'
import { Button, buttonVariants } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Checkbox } from '../components/ui/checkbox'
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { Eye, EyeOff, Loader2, ArrowLeft, KeyRound } from 'lucide-react'

type PanelStatus = 'checking' | 'online' | 'unreachable'

// Device-scoped only: counts failed login SUBMISSIONS from this browser,
// never the submitted username or any per-account state. The mechanism this
// hints at (10 failed attempts on ONE account -> 15 minute lock, see
// services/auth.js) never changes what it shows the user either way --
// "Invalid username or password" reads identically whether the account
// exists, is currently locked, or the password was simply wrong. That's a
// deliberate anti-enumeration property and stays; what was actually missing
// is that a stuck user has no way to learn the mechanism exists at all. This
// hint fixes that without becoming an account oracle: it reacts only to "did
// this browser's last few submissions fail," never to who or what was typed,
// so it reads identically for a real account, a locked account, or a typo'd
// username that doesn't exist. See conv install-idiot-proofing-2026-08.
const LOGIN_DEVICE_FAILURE_KEY = 'pz-login-failed-attempts'
const DEVICE_HINT_THRESHOLD = 3

function readDeviceFailureCount(): number {
  try {
    return Number(localStorage.getItem(LOGIN_DEVICE_FAILURE_KEY)) || 0
  } catch {
    return 0
  }
}

function usePanelHealth() {
  const [status, setStatus] = useState<PanelStatus>('checking')
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const poll = async () => {
      try {
        const r = await fetch('/api/health', { signal: controller.signal })
        if (!r.ok) throw new Error('http')
        const data = await r.json()
        if (cancelled) return
        setStatus('online')
        if (typeof data?.version === 'string') setVersion(data.version)
      } catch {
        if (!cancelled) setStatus('unreachable')
      }
    }
    poll()
    const id = window.setInterval(poll, 15000)
    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(id)
    }
  }, [])
  return { status, version }
}

export default function Login() {
  const { t } = useTranslation('login')
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const errorId = error ? 'login-error' : undefined
  const [deviceFailedAttempts, setDeviceFailedAttempts] = useState(readDeviceFailureCount)

  const [resetMode, setResetMode] = useState(false)
  const [resetAvailable, setResetAvailable] = useState(false)
  const [resetToken, setResetToken] = useState('')
  const [recoveryCodesAvailable, setRecoveryCodesAvailable] = useState(false)
  // unknown-window-instances-outside-the-bridge, 2026-09-10: distinguishes
  // "the two mount-time status fetches haven't settled yet" from "confirmed
  // unavailable" at handleLostPassword's decision point below -- same split
  // Debug.tsx's bridge tab already uses (there, loading only delays showing
  // a premature negative; here, on the fail-open side, loading is treated
  // the same as a confirmed-available answer instead of the same as false).
  const [recoveryStatusLoading, setRecoveryStatusLoading] = useState(true)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [resetSuccess, setResetSuccess] = useState('')
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [localResetSupported, setLocalResetSupported] = useState(false)
  const [showRecoveryHelp, setShowRecoveryHelp] = useState(false)
  const [checkingResetStatus, setCheckingResetStatus] = useState(false)
  const [creatingLocalReset, setCreatingLocalReset] = useState(false)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { status, version } = usePanelHealth()

  // null = not known yet -- deliberately renders no SSO button while loading
  // rather than a flash of one that then disappears.
  const [oidcStatus, setOidcStatus] = useState<{ configured: boolean; providerName: string } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/auth/oidc/status', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) =>
        setOidcStatus({
          configured: d?.configured === true,
          providerName: typeof d?.providerName === 'string' && d.providerName ? d.providerName : 'SSO',
        }),
      )
      .catch(() => setOidcStatus({ configured: false, providerName: 'SSO' }))
    return () => controller.abort()
  }, [])

  // The OIDC callback redirects the browser back here with ?oidcError=<reason>
  // on any failure (see server/routes/oidc.js) -- surface it once, then strip
  // it from the URL so a reload doesn't keep re-showing a stale error.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const oidcError = params.get('oidcError')
    if (!oidcError) return
    setError(t(`errors.oidc.${oidcError}`, { defaultValue: t('errors.oidc.generic') }))
    params.delete('oidcError')
    const query = params.toString()
    window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash)
  }, [t])

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    }
  }, [])

  const fetchResetStatus = async (signal?: AbortSignal) => {
    const response = await fetch('/api/auth/reset-status', signal ? { signal } : undefined)
    const data = await response.json()
    const available = data.resetAvailable === true
    const localSupported = data.localResetSupported === true
    setResetAvailable(available)
    setLocalResetSupported(localSupported)
    return { available, localSupported }
  }

  useEffect(() => {
    const controller = new AbortController()
    let resetSettled = false
    let recoverySettled = false
    const maybeDoneLoading = () => {
      if (resetSettled && recoverySettled) setRecoveryStatusLoading(false)
    }
    fetchResetStatus(controller.signal)
      .catch(() => {
        setResetAvailable(false)
        setLocalResetSupported(false)
      })
      .finally(() => { resetSettled = true; maybeDoneLoading() })
    fetch('/api/auth/recovery-status', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => setRecoveryCodesAvailable(d?.recoveryCodesAvailable === true))
      .catch(() => setRecoveryCodesAvailable(false))
      .finally(() => { recoverySettled = true; maybeDoneLoading() })
    return () => controller.abort()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(username, password, rememberMe)
      // Succeeded -- this device no longer needs the hint below on a future
      // visit, regardless of how many failures came before it.
      setDeviceFailedAttempts(0)
      try { localStorage.removeItem(LOGIN_DEVICE_FAILURE_KEY) } catch { /* ignore */ }
    } catch (err) {
      // 2026-08-26: NOT a getUserErrorMessage() site -- AuthContext's
      // login() already resolves and translates the final message itself
      // (see its getLoginErrorMessage(), which routes a genuine 5xx through
      // getUserErrorMessage() before this ever sees it, and keeps the
      // account-enumeration-safe generic text for an actual auth failure).
      // Calling getUserErrorMessage() here too would double-process an
      // already-translated string. rawErrorMessageIntentional() documents
      // that this is a deliberate exception, not a missed conversion.
      setError(rawErrorMessageIntentional(err, t('errors.loginFailed')))
      setDeviceFailedAttempts((prev) => {
        const next = prev + 1
        try { localStorage.setItem(LOGIN_DEVICE_FAILURE_KEY, String(next)) } catch { /* ignore */ }
        return next
      })
    } finally {
      setLoading(false)
    }
  }

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setResetSuccess('')
    if (!resetToken || resetToken.trim().length < 8) {
      setError(t('errors.resetTokenTooShort'))
      return
    }
    if (!newPassword || newPassword.length < 6) {
      setError(t('errors.passwordTooShort'))
      return
    }
    if (newPassword !== confirmPassword) {
      setError(t('errors.passwordsDontMatch'))
      return
    }
    setLoading(true)
    try {
      // A token file, when present, stays the primary path; otherwise fall back
      // to a saved recovery code so no host access is needed.
      const useRecoveryCode = !resetAvailable && recoveryCodesAvailable
      // 2026-09-08 (auth-transport-parity): was a raw fetch() manually
      // rebuilding an ApiError from status/code -- apiFetch/handleResponse
      // does the same thing via buildResponseError, plus the fetchWithRetry
      // timeout and consistent NETWORK_ERROR/TIMEOUT classification this
      // route never had before.
      const data = await handleResponse<{ message: string }>(
        await apiFetch(useRecoveryCode ? '/auth/recover-with-code' : '/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            useRecoveryCode
              ? { code: resetToken, newPassword }
              : { token: resetToken, newPassword },
          ),
        }),
      )
      setResetSuccess(data.message)
      setResetToken('')
      setNewPassword('')
      setConfirmPassword('')
      setShowRecoveryHelp(false)
      setResetAvailable(false)
      const timer = setTimeout(() => {
        setResetMode(false)
        setResetSuccess('')
      }, 3000)
      resetTimerRef.current = timer
    } catch (err) {
      setError(getUserErrorMessage(err, t('errors.resetFailed')))
    } finally {
      setLoading(false)
    }
  }

  const handleLostPassword = () => {
    setError('')
    setResetSuccess('')
    // Fail open, same side as resolveServerRunning/WorldMap's hasActiveServer/
    // Servers.tsx's dockerAvailable: the two status fetches this screen's
    // mount effect kicks off default both flags to false and haven't
    // necessarily settled by the time someone clicks this on a slow
    // connection -- exactly the situation a locked-out user under stress is
    // more likely to hit. Treating "still loading" the same as "confirmed
    // available" routes to the token/code entry screen instead of attempting
    // a local reset that was never going to find anything for someone who
    // actually holds a real token or code. Checked the alternative isn't
    // worse for someone who holds neither: reset-password's own
    // RESET_TOKEN_NOT_FOUND response ("No reset token found. Create
    // data/reset-token.txt on the server first.") is at least as specific
    // and actionable as handleCreateLocalReset's LOCAL_RESET_NOT_LOCAL/
    // BEHIND_PROXY errors below -- neither path is a dead end.
    if (recoveryStatusLoading || resetAvailable || recoveryCodesAvailable) {
      setShowRecoveryHelp(false)
      setResetMode(true)
      return
    }
    // Always ask the server rather than branching on this browser's own
    // (necessarily coarse) "am I local" guess: a genuinely remote visitor
    // and one stuck behind a reverse proxy get two DIFFERENT, more specific
    // messages back (LOCAL_RESET_NOT_LOCAL vs LOCAL_RESET_BEHIND_PROXY,
    // server/routes/auth.js), which never reached this screen before --
    // the localResetSupported shortcut used to skip the request entirely
    // for anyone it already assumed would fail, silently discarding the
    // more useful, more specific reason before it could ever be shown. This
    // is safe to always attempt: a rejection here makes no server-side
    // change at all, only success does (creating the reset-token file),
    // which is exactly the wanted behavior when it does succeed.
    void handleCreateLocalReset()
  }

  const handleRecoveryCheck = async () => {
    setError('')
    setCheckingResetStatus(true)
    try {
      const { available } = await fetchResetStatus()

      if (available) {
        setShowRecoveryHelp(false)
        setResetMode(true)
        return
      }

      setError(t('errors.noRecoveryTokenYet'))
    } catch {
      setError(t('errors.couldNotCheckStatus'))
    } finally {
      setCheckingResetStatus(false)
    }
  }

  const handleCreateLocalReset = async () => {
    setError('')
    setResetSuccess('')
    setCreatingLocalReset(true)
    try {
      // 2026-09-08 (auth-transport-parity): same swap as handleReset above.
      const data = await handleResponse<{ message?: string }>(
        await apiFetch('/auth/reset-token/local', { method: 'POST' }),
      )

      setResetAvailable(true)
      setLocalResetSupported(true)
      setResetToken('')
      setShowRecoveryHelp(false)
      setResetSuccess(typeof data.message === 'string' ? data.message : t('resetTokenCreated'))
      setResetMode(true)
    } catch (err) {
      setShowRecoveryHelp(true)
      setError(getUserErrorMessage(err, t('errors.couldNotCreateToken')))
    } finally {
      setCreatingLocalReset(false)
    }
  }

  const statusMap: Record<PanelStatus, { label: string; tone: string; dot: string }> = {
    checking: { label: t('status.checking'), tone: 'text-muted-foreground', dot: 'bg-muted-foreground/60' },
    online: { label: t('status.online'), tone: 'text-success', dot: 'bg-success' },
    unreachable: { label: t('status.offline'), tone: 'text-destructive', dot: 'bg-destructive' },
  }
  const s = statusMap[status]

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <a
        href="#login-form"
        className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        {t('skipToForm')}
      </a>

      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,hsl(var(--primary)/0.10),transparent_34rem),linear-gradient(180deg,hsl(var(--background)),hsl(24_8%_4%))]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-border/70"
      />

      <header className="relative mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 text-sm sm:px-8">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{t('brand.title')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('brand.subtitle')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
          <LanguageSwitcher />
          <span className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
            <span className={s.tone}>{s.label}</span>
            {version && <span className="hidden text-muted-foreground/70 sm:inline">v{version}</span>}
          </span>
        </div>
      </header>

      <main className="relative mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-6xl items-center justify-center px-5 pb-12 pt-4 sm:px-8">
        <section
          className="w-full max-w-[420px] rounded-lg border border-border/70 bg-card/90 p-6 shadow-[0_24px_80px_-48px_hsl(var(--foreground)/0.45)] sm:p-7"
          aria-labelledby="login-title"
        >
          <div className="mb-6 space-y-2">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              {resetMode ? t('recovery.eyebrow') : t('signIn.eyebrow')}
            </p>
            <h1 id="login-title" className="text-2xl font-semibold tracking-normal text-foreground">
              {resetMode ? t('recovery.title') : t('signIn.title')}
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">
              {resetMode ? t('recovery.description') : t('signIn.description')}
            </p>
          </div>

          {resetMode ? (
            <form id="login-form" onSubmit={handleReset} className="space-y-4">
              {error && (
                <div
                  role="alert"
                  aria-live="assertive"
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {error}
                </div>
              )}
              {resetSuccess && (
                <div
                  role="status"
                  aria-live="polite"
                  className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success"
                >
                  {resetSuccess}
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="resetToken" className="text-sm font-medium text-foreground">
                  {resetAvailable ? t('recovery.tokenLabel') : t('recovery.codeLabel')}
                </Label>
                <Input
                  id="resetToken"
                  type="text"
                  value={resetToken}
                  onChange={(e) => setResetToken(e.target.value)}
                  placeholder={resetAvailable ? t('recovery.tokenPlaceholder') : t('recovery.codePlaceholder')}
                  autoFocus
                  disabled={loading}
                  required
                  minLength={8}
                  maxLength={512}
                  className="text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  {resetAvailable ? t('recovery.tokenHelp') : t('recovery.codeHelp')}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="newPassword" className="text-sm font-medium text-foreground">
                  {t('recovery.newPasswordLabel')}
                </Label>
                <div className="relative">
                  <Input
                    id="newPassword"
                    type={showNewPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder={t('recovery.newPasswordPlaceholder')}
                    className="pe-10 text-sm"
                    disabled={loading}
                    required
                    minLength={6}
                    maxLength={128}
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    className="absolute inset-y-0 end-3 flex items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    title={showNewPassword ? t('signIn.hidePassword') : t('signIn.showPassword')}
                    aria-label={showNewPassword ? t('signIn.hidePassword') : t('signIn.showPassword')}
                    aria-pressed={showNewPassword}
                  >
                    {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="confirmPassword" className="text-sm font-medium text-foreground">
                  {t('recovery.confirmPasswordLabel')}
                </Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder={t('recovery.confirmPasswordPlaceholder')}
                  disabled={loading}
                  required
                  minLength={6}
                  maxLength={128}
                  className="text-sm"
                />
              </div>

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? (<><Loader2 className="h-4 w-4 animate-spin" /> {t('recovery.submitting')}</>) : t('recovery.submit')}
              </Button>

              <Button
                type="button"
                variant="ghost"
                className="w-full text-muted-foreground hover:text-foreground"
                onClick={() => { setResetMode(false); setError(''); setResetSuccess('') }}
              >
                <ArrowLeft className="me-1.5 h-4 w-4" />
                {t('recovery.back')}
              </Button>
            </form>
          ) : (
            <>
              {oidcStatus?.configured && (
                <div className="mb-4 space-y-4">
                  <a
                    href="/api/auth/oidc/login"
                    className={buttonVariants({ variant: 'outline' }) + ' w-full'}
                  >
                    {t('sso.continueWith', { provider: oidcStatus.providerName })}
                  </a>
                  <div className="relative text-center text-xs uppercase tracking-wide text-muted-foreground">
                    <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border/60" aria-hidden="true" />
                    <span className="relative bg-card/90 px-2">{t('sso.divider')}</span>
                  </div>
                </div>
              )}
              <form id="login-form" onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div
                  id="login-error"
                  role="alert"
                  aria-live="assertive"
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {error}
                </div>
              )}

              {deviceFailedAttempts >= DEVICE_HINT_THRESHOLD && (
                <div
                  role="status"
                  className="rounded-md border border-border/70 bg-muted/20 px-3 py-2.5 text-xs leading-5 text-muted-foreground"
                >
                  <p className="font-medium text-foreground">{t('repeatedFailureHint.title')}</p>
                  <p className="mt-1">
                    <Trans
                      t={t}
                      i18nKey="repeatedFailureHint.body"
                      components={{ code: <span className="font-mono text-foreground/85" /> }}
                    />
                  </p>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="username" className="text-sm font-medium text-foreground">
                  {t('signIn.usernameLabel')}
                </Label>
                <Input
                  id="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  autoComplete="username"
                  autoFocus
                  maxLength={32}
                  disabled={loading}
                  aria-describedby={errorId}
                  aria-invalid={error ? true : undefined}
                  required
                  className="text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-sm font-medium text-foreground">
                  {t('signIn.passwordLabel')}
                </Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('signIn.passwordLabel')}
                    autoComplete="current-password"
                    className="pe-10 text-sm"
                    disabled={loading}
                    aria-describedby={errorId}
                    aria-invalid={error ? true : undefined}
                    required
                    maxLength={128}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 end-3 flex items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    title={showPassword ? t('signIn.hidePassword') : t('signIn.showPassword')}
                    aria-label={showPassword ? t('signIn.hidePassword') : t('signIn.showPassword')}
                    aria-pressed={showPassword}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-0.5">
                <Checkbox
                  id="rememberMe"
                  checked={rememberMe}
                  onCheckedChange={(checked) => setRememberMe(checked === true)}
                />
                <Label htmlFor="rememberMe" className="cursor-pointer text-sm font-normal text-muted-foreground">
                  {t('signIn.rememberMe')}
                </Label>
              </div>

              <div className="space-y-2 pt-1">
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? (<><Loader2 className="h-4 w-4 animate-spin" /> {t('signIn.submitting')}</>) : t('signIn.submit')}
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  className="w-full text-muted-foreground hover:text-foreground"
                  onClick={handleLostPassword}
                  disabled={loading || checkingResetStatus || creatingLocalReset}
                >
                  {creatingLocalReset ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                  {creatingLocalReset
                    ? t('lostPassword.creatingLocalReset')
                    : (resetAvailable || recoveryCodesAvailable)
                      ? t('lostPassword.useRecoveryToken')
                      : localResetSupported
                        ? t('lostPassword.createRecoveryFile')
                        : t('lostPassword.recoverAccount')}
                </Button>
              </div>

              {showRecoveryHelp && !resetAvailable && (
                <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">{t('lostPassword.helpTitle')}</p>
                  {localResetSupported ? (
                    <p className="mt-2 leading-6">
                      {t('lostPassword.helpLocal')}
                    </p>
                  ) : (
                    <>
                      <p className="mt-2 leading-6">
                        {t('lostPassword.helpRemote1')}
                      </p>
                      <p className="mt-2 leading-6">
                        <Trans
                          t={t}
                          i18nKey="lostPassword.helpRemote2"
                          components={{ code: <span className="font-mono text-foreground/85" /> }}
                        />
                      </p>
                    </>
                  )}
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    {localResetSupported ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="sm:flex-1"
                        onClick={() => void handleCreateLocalReset()}
                        disabled={creatingLocalReset || checkingResetStatus || loading}
                      >
                        {creatingLocalReset ? (<><Loader2 className="h-4 w-4 animate-spin" /> {t('lostPassword.creatingFile')}</>) : t('lostPassword.createFile')}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        className="sm:flex-1"
                        onClick={handleRecoveryCheck}
                        disabled={checkingResetStatus || loading}
                      >
                        {checkingResetStatus ? (<><Loader2 className="h-4 w-4 animate-spin" /> {t('lostPassword.checkingToken')}</>) : t('lostPassword.checkToken')}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      className="sm:flex-1"
                      onClick={() => { setShowRecoveryHelp(false); setError('') }}
                      disabled={creatingLocalReset || checkingResetStatus || loading}
                    >
                      {t('lostPassword.cancel')}
                    </Button>
                  </div>
                </div>
              )}
              </form>
            </>
          )}
        </section>
      </main>
    </div>
  )
}
