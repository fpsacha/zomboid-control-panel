import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert, X } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { isPlainHttpExposed } from '@/lib/plainHttpExposure'

const DISMISS_KEY = 'zcp:plainHttpBanner:dismissed'

function readDismissed(): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
}

// Shown to administrators who reach the panel over plain http from a public address.
export function PlainHttpBanner() {
  const { t } = useTranslation('systemHealthBanner')
  const { can } = useAuth()
  const [dismissed, setDismissed] = useState(readDismissed)

  if (dismissed || !can('users.manage')) return null
  if (!isPlainHttpExposed(window.location.protocol, window.location.hostname)) return null

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* per-viewer convenience only */ }
    setDismissed(true)
  }

  return (
    <div role="status" aria-live="polite" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-warning/35 bg-warning/[0.04] px-3 py-2">
      <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-warning">{t('plainHttpTitle')}</span>
        <span className="min-w-0 text-xs text-muted-foreground">{t('plainHttpMessage')}</span>
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="ms-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
        aria-label={t('plainHttpDismissAria')}
        title={t('dismiss')}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}
