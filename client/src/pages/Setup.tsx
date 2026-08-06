import { useTranslation } from 'react-i18next';
import { useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Checkbox } from '../components/ui/checkbox'
import { AuthScreenLayout } from '../components/AuthScreenLayout'
import { AlertTriangle, ArrowRight, CheckCircle, Eye, EyeOff, KeyRound, Loader2, RadioTower, Server, ShieldCheck, XCircle } from 'lucide-react'

type PasswordStrength = {
  score: 0 | 1 | 2 | 3 | 4
  label: string
  tone: 'empty' | 'weak' | 'fair' | 'good' | 'strong'
}

function scorePassword(pw: string, t: (key: string) => string): PasswordStrength {
  if (!pw) return { score: 0, label: '', tone: 'empty' }
  let score = 0
  if (pw.length >= 6) score++
  if (pw.length >= 10) score++
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++
  if (pw.length >= 14) score = Math.min(4, score + 1)
  const map: Record<number, PasswordStrength> = {
    0: { score: 1, label: t('passwordStrength.tooShort'), tone: 'weak' },
    1: { score: 1, label: t('passwordStrength.weak'), tone: 'weak' },
    2: { score: 2, label: t('passwordStrength.fair'), tone: 'fair' },
    3: { score: 3, label: t('passwordStrength.good'), tone: 'good' },
    4: { score: 4, label: t('passwordStrength.strong'), tone: 'strong' },
  }
  return map[Math.min(4, score) as 0 | 1 | 2 | 3 | 4]
}

export default function Setup() {
  const { t } = useTranslation('setup');
  const { setup } = useAuth()
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(true)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [capsLockOn, setCapsLockOn] = useState(false)
  const errorId = error ? 'setup-error' : undefined
  const usernameHintId = 'setup-username-hint'
  const passwordHintId = 'setup-password-hint'
  const confirmHintId = 'setup-confirm-hint'

  const passwordsMatch = password === confirmPassword
  const passwordLongEnough = password.length >= 6
  const usernameValid = /^[a-zA-Z0-9_-]{3,32}$/.test(username)
  const strength = useMemo(() => scorePassword(password, t), [password, t])

  const detectCaps = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // getModifierState is supported across all evergreen browsers; guard for safety.
    if (typeof e.getModifierState === 'function') {
      setCapsLockOn(e.getModifierState('CapsLock'))
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!usernameValid) {
      setError(t('errors.usernameInvalid'))
      return
    }
    if (!passwordLongEnough) {
      setError(t('errors.passwordTooShort'))
      return
    }
    if (!passwordsMatch) {
      setError(t('errors.passwordsNoMatch'))
      return
    }

    setLoading(true)
    try {
      await setup(username, password, rememberMe)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.setupFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthScreenLayout
      badge={t('badge')}
      title={t('title')}
      description={t('description')}
      cardTitle={t('cardTitle')}
      cardDescription={t('cardDescription')}
      footer={
        <span className="inline-flex items-start gap-1.5 text-left">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning/80" aria-hidden="true" />
          <span>
            {t('footer')}
          </span>
        </span>
      }
    >
      {/* ─── Step indicator ─── */}
      <ol
        className="-mt-1 mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground"
        aria-label={t('steps.progress')}
      >
        <li className="flex items-center gap-1.5">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-primary/40 bg-primary/15 text-[10px] font-semibold text-primary">1</span>
          <span className="text-foreground/80">{t('steps.account')}</span>
        </li>
        <span aria-hidden="true" className="h-px w-6 bg-border/60" />
        <li className="flex items-center gap-1.5 opacity-70">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border/60 bg-muted/20 text-[10px] font-semibold text-muted-foreground">2</span>
          <span>{t('steps.server')}</span>
        </li>
        <span aria-hidden="true" className="h-px w-6 bg-border/60" />
        <li className="flex items-center gap-1.5 opacity-50">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border/60 bg-muted/20 text-[10px] font-semibold text-muted-foreground">3</span>
          <span>{t('status.online')}</span>
        </li>
      </ol>

      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div
            id="setup-error"
            role="alert"
            aria-live="assertive"
            className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/8 px-3 py-2.5 text-sm text-destructive"
          >
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="username">{t('labels.username')}</Label>
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
            aria-describedby={[usernameHintId, errorId].filter(Boolean).join(' ')}
            aria-invalid={Boolean(error && !usernameValid)}
            required
          />
          <div id={usernameHintId} className="flex items-center gap-1.5 text-xs leading-5">
            {username.length === 0 ? (
              <span className="text-muted-foreground">
                {t('labels.usernameHint')}
              </span>
            ) : usernameValid ? (
              <>
                <CheckCircle className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                <span className="text-primary">{t('status.looksGood')}</span>
              </>
            ) : (
              <>
                <div className="h-3.5 w-3.5 rounded-full border border-destructive" aria-hidden="true" />
                <span className="text-destructive">{t('status.usernameFormat')}</span>
              </>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">{t('labels.password')}</Label>
            {capsLockOn && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning" role="status">
                <KeyRound className="h-3 w-3" aria-hidden="true" />
                {t('status.capsLockOn')}
              </span>
            )}
          </div>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={detectCaps}
              onKeyUp={detectCaps}
              onBlur={() => setCapsLockOn(false)}
              placeholder={t('placeholders.password')}
              autoComplete="new-password"
              disabled={loading}
              aria-describedby={[passwordHintId, errorId].filter(Boolean).join(' ')}
              aria-invalid={Boolean(error && !passwordLongEnough)}
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              aria-label={showPassword ? t('actions.hidePassword') : t('actions.showPassword')}
              aria-pressed={showPassword}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          {/* Strength meter — 4 segments */}
          <div id={passwordHintId} className="space-y-1.5">
            <div className="flex items-center gap-1" aria-hidden="true">
              {[1, 2, 3, 4].map((i) => {
                const filled = strength.score >= i
                const tone = strength.tone
                const cls = !filled
                  ? 'bg-muted/40'
                  : tone === 'weak'
                    ? 'bg-destructive/70'
                    : tone === 'fair'
                      ? 'bg-warning/70'
                      : tone === 'good'
                        ? 'bg-primary/70'
                        : 'bg-success/80'
                return (
                  <span
                    key={i}
                    className={`h-1 flex-1 rounded-full transition-colors duration-200 ${cls}`}
                  />
                )
              })}
            </div>
            <div className="flex items-center justify-between text-xs leading-5">
              <span className="flex items-center gap-1.5">
                {passwordLongEnough ? (
                  <CheckCircle className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                ) : (
                  <div className="h-3.5 w-3.5 rounded-full border border-muted-foreground/30" aria-hidden="true" />
                )}
                <span className={passwordLongEnough ? 'text-primary' : 'text-muted-foreground'}>
                  {t('status.passwordMinimum')}
                </span>
              </span>
              {strength.label && (
                <span
                  className={
                    strength.tone === 'weak'
                      ? 'text-destructive'
                      : strength.tone === 'fair'
                        ? 'text-warning'
                        : strength.tone === 'good'
                          ? 'text-primary'
                          : 'text-success'
                  }
                  aria-live="polite"
                >
                  {strength.label}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirmPassword">{t('labels.confirmPassword')}</Label>
          <Input
            id="confirmPassword"
            type={showPassword ? 'text' : 'password'}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            onKeyDown={detectCaps}
            onKeyUp={detectCaps}
            onBlur={() => setCapsLockOn(false)}
            placeholder={t('placeholders.password')}
            autoComplete="new-password"
            disabled={loading}
            aria-describedby={[confirmHintId, errorId].filter(Boolean).join(' ')}
            aria-invalid={Boolean(confirmPassword && !passwordsMatch)}
            required
          />
          {confirmPassword && (
            <div id={confirmHintId} className="flex items-center gap-1.5 text-xs leading-5">
              {passwordsMatch ? (
                <CheckCircle className="w-3.5 h-3.5 text-primary" aria-hidden="true" />
              ) : (
                <div className="h-3.5 w-3.5 rounded-full border border-destructive" aria-hidden="true" />
              )}
              <span className={passwordsMatch ? 'text-primary' : 'text-destructive'}>
                {passwordsMatch ? t('passwordMatch.match') : t('passwordMatch.noMatch')}
              </span>
            </div>
          )}
          {!confirmPassword && (
            <p id={confirmHintId} className="text-xs leading-5 text-muted-foreground">
              {t('labels.confirmHint')}
            </p>
          )}
        </div>

        <div className="flex items-center space-x-2 rounded-lg border border-border/60 bg-muted/15 px-3 py-2.5">
          <Checkbox
            id="rememberMe"
            checked={rememberMe}
            onCheckedChange={(checked) => setRememberMe(checked === true)}
          />
          <Label htmlFor="rememberMe" className="cursor-pointer text-sm font-normal text-foreground/90">
            {t('labels.keepSignedIn')}
          </Label>
        </div>

        <Button
          type="submit"
          className="w-full onboarding-cta"
          disabled={loading || !usernameValid || !passwordLongEnough || !passwordsMatch}
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('actions.creating')}
            </>
          ) : (
            <>
              {t('actions.createAccount')}
              <ArrowRight className="ml-1 h-4 w-4" aria-hidden="true" />
            </>
          )}
        </Button>

        <div className="mission-brief rounded-xl border border-border/60 bg-muted/10 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <ArrowRight className="h-4 w-4 text-primary" aria-hidden="true" />
              {t('afterStep.title')}
            </div>
            <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              {t('afterStep.preview')}
            </span>
          </div>
          <div className="mission-step-grid mt-3 space-y-2">
            <div className="mission-step-card flex items-start gap-3 rounded-lg border border-border/50 bg-background/35 px-3 py-2.5">
              <div className="mission-step-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                <Server className="h-3.5 w-3.5" aria-hidden="true" />
              </div>
              <div className="min-w-0 pt-0.5">
                <p className="text-[13px] font-medium leading-tight text-foreground">{t('afterStep.bringServer.title')}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  {t('afterStep.bringServer.description')}
                </p>
              </div>
            </div>

            <div className="mission-step-card flex items-start gap-3 rounded-lg border border-border/50 bg-background/35 px-3 py-2.5">
              <div className="mission-step-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              </div>
              <div className="min-w-0 pt-0.5">
                <p className="text-[13px] font-medium leading-tight text-foreground">{t('afterStep.confirmRCON.title')}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  {t('afterStep.confirmRCON.description')}
                </p>
              </div>
            </div>

            <div className="mission-step-card flex items-start gap-3 rounded-lg border border-border/50 bg-background/35 px-3 py-2.5">
              <div className="mission-step-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                <RadioTower className="h-3.5 w-3.5" aria-hidden="true" />
              </div>
              <div className="min-w-0 pt-0.5">
                <p className="text-[13px] font-medium leading-tight text-foreground">{t('afterStep.takeLive.title')}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  {t('afterStep.takeLive.description')}
                </p>
              </div>
            </div>
          </div>
        </div>
      </form>
    </AuthScreenLayout>
  )
}
