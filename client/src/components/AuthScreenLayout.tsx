import { ReactNode, useEffect, useState } from 'react'

import { Card, CardContent } from '../components/ui/card'
import { useTranslation } from 'react-i18next'

interface AuthScreenLayoutProps {
  /** Optional small uppercase tag rendered above the title (e.g. "Account Recovery"). Use sparingly. */
  badge?: string
  title: string
  description: string
  /** Optional secondary card header rendered above the form (only used when the inner content needs explicit naming). */
  cardTitle?: string
  cardDescription?: string
  children: ReactNode
  /** Optional fine-print rendered below the card. Kept short — anything longer belongs in the form itself. */
  footer?: ReactNode
}

type PanelStatus = 'checking' | 'online' | 'unreachable'

/**
 * Auth shell used by Login + Setup + Reset.
 *
 * Visual direction (see .github/copilot-instructions.md → Design Context):
 * survival-control-room. Warm smoked neutrals, moss/olive primaries, scanline
 * grain, broadcast-style stamps. Status indicators are REAL (driven by
 * /api/health) — never decorative.
 */
export function AuthScreenLayout({
  badge,
  title,
  description,
  cardTitle,
  cardDescription,
  children,
  footer,
}: AuthScreenLayoutProps) {
  const { t } = useTranslation('common')
  const [status, setStatus] = useState<PanelStatus>('checking')
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    const poll = async () => {
      try {
        const r = await fetch('/api/health', { signal: controller.signal })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const data = await r.json()
        if (cancelled) return
        setStatus('online')
        if (typeof data?.version === 'string') setVersion(data.version)
      } catch {
        if (cancelled) return
        setStatus('unreachable')
      }
    }

    poll()
    const id = setInterval(poll, 15000)
    return () => {
      cancelled = true
      controller.abort()
      clearInterval(id)
    }
  }, [])

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <a
        href="#auth-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground focus:text-sm"
      >
        {t('auth.skipToContent')}
      </a>

      {/* Warm ember + moss radial wash */}
      <div
        aria-hidden="true"
        className="auth-bg-gradient absolute inset-0 opacity-90 [contain:layout_style_paint]"
      />

      {/* Scanlines — committed, not whisper-thin */}
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none [contain:layout_style_paint] opacity-[0.18] mix-blend-overlay [background-image:repeating-linear-gradient(0deg,hsl(var(--foreground)/0.6)_0px,hsl(var(--foreground)/0.6)_1px,transparent_1px,transparent_3px)]"
      />

      {/* Paper grain */}
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none [contain:layout_style_paint] opacity-[0.07] [background-image:url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22180%22 height=%22180%22><filter id=%22n%22><feTurbulence type=%22fractalNoise%22 baseFrequency=%220.85%22 numOctaves=%222%22 stitchTiles=%22stitch%22/><feColorMatrix values=%220 0 0 0 0.95 0 0 0 0 0.85 0 0 0 0 0.55 0 0 0 0.8 0%22/></filter><rect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23n)%22/></svg>')]"
      />

      {/* Corner stamps — only signals that carry real information stay. */}
      <div
        aria-hidden="true"
        className="absolute top-4 left-4 right-4 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/70 [contain:layout_style_paint]"
      >
        <span>// ZCP_CTRL</span>
        <span>{t('auth.node')}: {status === 'online' ? '01' : '--'}</span>
      </div>
      <div
        aria-hidden="true"
        className="absolute bottom-4 left-4 right-4 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/55 [contain:layout_style_paint]"
      >
        <span>{version ? t('auth.build', { version }) : t('auth.buildUnknown')}</span>
        <span>{t('auth.signature')}: {status === 'online' ? 'ack' : status === 'checking' ? '...' : 'lost'}</span>
      </div>

      <main
        id="auth-content"
        className="relative mx-auto flex min-h-screen w-full max-w-md flex-col items-stretch justify-center px-4 py-12 sm:px-6"
      >
        {/* Hero — stencilled brand mark + ONE supporting line */}
        <div className="mb-8 flex flex-col items-center text-center">
          <BrandMark className="mb-5" />

          {badge ? (
            <div
              aria-hidden="true"
              className="mb-3 inline-flex items-center rounded-sm border border-warning/40 bg-warning/8 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.32em] text-warning"
            >
              {badge}
            </div>
          ) : null}

          <h1 className="font-mono text-2xl font-semibold uppercase tracking-[0.18em] text-foreground sm:text-[1.6rem]">
            {title}
          </h1>
          <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>
        </div>

        {/* Card — minimal chrome, just the form */}
        <Card className="relative overflow-hidden border-border/55 bg-card/85 backdrop-blur-[2px] shadow-[0_28px_90px_-40px_hsl(var(--background)/0.9)]">
          {/* Hairline accent strip — moss with an ember spark */}
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent_0%,hsl(var(--primary)/0.55)_20%,hsl(var(--warning)/0.7)_50%,hsl(var(--primary)/0.55)_80%,transparent_100%)]"
          />
          {cardTitle || cardDescription ? (
            <div className="border-b border-border/40 px-6 pt-5 pb-4">
              {cardTitle ? (
                <h2 className="font-mono text-xs uppercase tracking-[0.28em] text-muted-foreground">{cardTitle}</h2>
              ) : null}
              {cardDescription ? (
                <p className="mt-1 text-sm leading-6 text-foreground/80">{cardDescription}</p>
              ) : null}
            </div>
          ) : null}
          <CardContent className="space-y-5 px-6 py-6">{children}</CardContent>
        </Card>

        {/* Live panel status — REAL signal from /api/health */}
        <PanelStatusPill status={status} className="mx-auto mt-5" />

        {footer ? (
          <p className="mx-auto mt-3 max-w-sm text-center text-xs leading-5 text-muted-foreground">{footer}</p>
        ) : null}
      </main>
    </div>
  )
}

/** Stencilled control-room mark. No Lucide; no shield. */
function BrandMark({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`relative inline-flex h-[72px] w-[72px] items-center justify-center ${className}`}
    >
      {/* Bracket frame */}
      <svg
        viewBox="0 0 72 72"
        className="absolute inset-0 h-full w-full text-primary/85"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
      >
        <path d="M2 2 L2 16 M2 2 L16 2" />
        <path d="M70 2 L70 16 M70 2 L56 2" />
        <path d="M2 70 L2 56 M2 70 L16 70" />
        <path d="M70 70 L70 56 M70 70 L56 70" />
      </svg>
      {/* Inner stamp */}
      <div className="flex h-[54px] w-[54px] items-center justify-center rounded-sm border border-primary/45 bg-primary/12 font-mono text-base font-bold uppercase tracking-[0.14em] text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.18),inset_0_-12px_24px_-12px_hsl(var(--warning)/0.18)]">
        ZCP
      </div>
    </div>
  )
}

function PanelStatusPill({ status, className = '' }: { status: PanelStatus; className?: string }) {
  const { t } = useTranslation('common')
  const map: Record<PanelStatus, { label: string; dot: string; text: string; ring: string }> = {
    checking: {
      label: t('auth.reachingPanelService'),
      dot: 'bg-muted-foreground/70 animate-pulse',
      text: 'text-muted-foreground',
      ring: 'border-border/55 bg-card/40',
    },
    online: {
      label: t('auth.panelServiceOnline'),
      dot: 'bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.55)]',
      text: 'text-foreground/85',
      ring: 'border-primary/30 bg-primary/8',
    },
    unreachable: {
      label: t('auth.panelServiceUnreachable'),
      dot: 'bg-destructive shadow-[0_0_8px_hsl(var(--destructive)/0.6)] animate-pulse',
      text: 'text-destructive',
      ring: 'border-destructive/40 bg-destructive/8',
    },
  }
  const s = map[status]

  return (
    <div
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-2 rounded-sm border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.24em] ${s.ring} ${s.text} ${className}`}
    >
      <span className={`inline-flex h-2 w-2 rounded-full ${s.dot}`} />
      {s.label}
    </div>
  )
}
