import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Checkbox } from '../components/ui/checkbox'
import { Eye, EyeOff, Loader2, ArrowLeft, KeyRound } from 'lucide-react'

type PanelStatus = 'checking' | 'online' | 'unreachable'

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
  const { t } = useTranslation('login');
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const errorId = error ? 'login-error' : undefined

  const [resetMode, setResetMode] = useState(false)
  const [resetAvailable, setResetAvailable] = useState(false)
  const [resetToken, setResetToken] = useState('')
  const [recoveryCodesAvailable, setRecoveryCodesAvailable] = useState(false)
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
    fetchResetStatus(controller.signal)
      .catch(() => {
        setResetAvailable(false)
        setLocalResetSupported(false)
      })
    fetch('/api/auth/recovery-status', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => setRecoveryCodesAvailable(d?.recoveryCodesAvailable === true))
      .catch(() => setRecoveryCodesAvailable(false))
    return () => controller.abort()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(username, password, rememberMe)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.loginFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setResetSuccess('')
    if (!resetToken || resetToken.trim().length < 8) {
      setError(t('errors.tokenTooShort'))
      return
    }
    if (!newPassword || newPassword.length < 6) {
      setError(t('errors.passwordTooShort'))
      return
    }
    if (newPassword !== confirmPassword) {
      setError(t('errors.passwordsNoMatch'))
      return
    }
    setLoading(true)
    try {
      // A token file, when present, stays the primary path; otherwise fall back
      // to a saved recovery code so no host access is needed.
      const useRecoveryCode = !resetAvailable && recoveryCodesAvailable
      const res = await fetch(
        useRecoveryCode ? '/api/auth/recover-with-code' : '/api/auth/reset-password',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            useRecoveryCode
              ? { code: resetToken, newPassword }
              : { token: resetToken, newPassword },
          ),
        },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || t('errors.resetFailed'))
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
      setError(err instanceof Error ? err.message : t('errors.resetFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handleLostPassword = () => {
    setError('')
    setResetSuccess('')
    if (resetAvailable || recoveryCodesAvailable) {
      setShowRecoveryHelp(false)
      setResetMode(true)
      return
    }
    if (localResetSupported) {
      void handleCreateLocalReset()
      return
    }
    setShowRecoveryHelp(current => !current)
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

      setError(t('errors.recoveryTokenNotFound'))
    } catch {
      setError(t('errors.recoveryStatusCheckFailed'))
    } finally {
      setCheckingResetStatus(false)
    }
  }

  const handleCreateLocalReset = async () => {
    setError('')
    setResetSuccess('')
    setCreatingLocalReset(true)
    try {
      const res = await fetch('/api/auth/reset-token/local', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || t('errors.createTokenFailed'))

      setResetAvailable(true)
      setLocalResetSupported(true)
      setResetToken('')
      setShowRecoveryHelp(false)
      setResetSuccess(typeof data.message === 'string' ? data.message : t('recovery.tokenCreated'))
      setResetMode(true)
    } catch (err) {
      setShowRecoveryHelp(true)
      setError(err instanceof Error ? err.message : t('errors.createTokenFailed'))
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
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        {t('actions.skipToForm')}
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
          <p className="text-sm font-medium text-foreground">{t('projectZomboidControlPanel')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('adminAccess')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
          <span className={s.tone}>{s.label}</span>
          {version && <span className="hidden text-muted-foreground/70 sm:inline">v{version}</span>}
        </div>
      </header>

      <main className="relative mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-6xl items-center justify-center px-5 pb-12 pt-4 sm:px-8">
        <section
          className="w-full max-w-[420px] rounded-lg border border-border/70 bg-card/90 p-6 shadow-[0_24px_80px_-48px_hsl(var(--foreground)/0.45)] sm:p-7"
          aria-labelledby="login-title"
        >
          <div className="mb-6 space-y-2">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              {resetMode ? t('page.accountRecovery') : t('page.secureSignIn')}
            </p>
            <h1 id="login-title" className="text-2xl font-semibold tracking-normal text-foreground">
              {resetMode ? t('page.resetPassword') : t('actions.signIn')}
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">
              {resetMode
                ? t('page.resetDescription')
                : t('page.loginDescription')}
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
                  {t('recovery.tokenLabel')}
                </Label>
                <Input
                  id="resetToken"
                  type="text"
                  value={resetToken}
                  onChange={(e) => setResetToken(e.target.value)}
                  placeholder={t('recovery.tokenPlaceholder')}
                  autoFocus
                  disabled={loading}
                  required
                  minLength={8}
                  maxLength={512}
                  className="text-sm"
                />
                <p className="text-xs text-muted-foreground">{t('storedAtDataresettokentxtOnThePanelHost')}</p>
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
                    className="pr-10 text-sm"
                    disabled={loading}
                    required
                    minLength={6}
                    maxLength={128}
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    className="absolute inset-y-0 right-3 flex items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    aria-label={showNewPassword ? t('actions.hidePassword') : t('actions.showPassword')}
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
                {loading ? (<><Loader2 className="h-4 w-4 animate-spin" /> {t('recovery.resetting')}</>) : t('recovery.resetButton')}
              </Button>

              <Button
                type="button"
                variant="ghost"
                className="w-full text-muted-foreground hover:text-foreground"
                onClick={() => { setResetMode(false); setError(''); setResetSuccess('') }}
              >
                <ArrowLeft className="mr-1.5 h-4 w-4" />
                {t('recovery.backToLogin')}
              </Button>
            </form>
          ) : (
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

              <div className="space-y-1.5">
                <Label htmlFor="username" className="text-sm font-medium text-foreground">
                  {t('labels.username')}
                </Label>
                <Input
                  id="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={t('labels.username')}
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
                  {t('labels.password')}
                </Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('labels.password')}
                    autoComplete="current-password"
                    className="pr-10 text-sm"
                    disabled={loading}
                    aria-describedby={errorId}
                    aria-invalid={error ? true : undefined}
                    required
                    maxLength={128}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-3 flex items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    aria-label={showPassword ? t('actions.hidePassword') : t('actions.showPassword')}
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
                  {t('labels.keepSignedIn')}
                </Label>
              </div>

              <div className="space-y-2 pt-1">
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? (<><Loader2 className="h-4 w-4 animate-spin" /> {t('actions.signingIn')}</>) : t('actions.signIn')}
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
                    ? t('recovery.preparing')
                    : resetAvailable
                      ? t('recovery.useToken')
                      : localResetSupported
                        ? t('recovery.createFile')
                        : t('recovery.recoverAccount')}
                </Button>
              </div>

              {showRecoveryHelp && !resetAvailable && (
                <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">{t('recovery.title')}</p>
                  {localResetSupported ? (
                    <p className="mt-2 leading-6">
                      {t('recovery.localDescription')}
                    </p>
                  ) : (
                    <>
                      <p className="mt-2 leading-6">
                        {t('recovery.remoteDescription')}
                      </p>
                      <p className="mt-2 leading-6">
                        {t('recovery.altMethod')} <span className="font-mono text-foreground/85">--reset-password</span> {t('recovery.altMethodSuffix')}
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
                        {creatingLocalReset ? (<><Loader2 className="h-4 w-4 animate-spin" /> {t('recovery.preparingFile')}</>) : t('recovery.createFileButton')}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        className="sm:flex-1"
                        onClick={handleRecoveryCheck}
                        disabled={checkingResetStatus || loading}
                      >
                        {checkingResetStatus ? (<><Loader2 className="h-4 w-4 animate-spin" /> {t('recovery.checking')}</>) : t('recovery.checkToken')}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      className="sm:flex-1"
                      onClick={() => { setShowRecoveryHelp(false); setError('') }}
                      disabled={creatingLocalReset || checkingResetStatus || loading}
                    >
                      {t('recovery.cancel')}
                    </Button>
                  </div>
                </div>
              )}
            </form>
          )}
        </section>
      </main>
    </div>
  )
}


