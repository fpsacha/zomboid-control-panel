import { Link } from 'react-router-dom'
import { ChevronRight, Loader2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

/* -------------------------------------------------------------------------- */
/*  Verdict                                                                   */
/* -------------------------------------------------------------------------- */

export type VerdictLevel = 'calm' | 'warning' | 'critical'

export interface VerdictAction {
  label: string
  to?: string
  onClick?: () => void
  disabled?: boolean
  busy?: boolean
}

export interface Verdict {
  level: VerdictLevel
  /**
   * Terse statement of what is wrong. Omitted entirely when nothing is wrong,
   * because a panel that announces its own health is just noise you learn to
   * skip past.
   */
  headline?: string
  /** Raw technical text, only where the operator genuinely needs it. */
  detail?: string
  action?: VerdictAction
}

export interface PresencePlayer {
  name: string
  /** Human readable join age, omitted when the join event is not known. */
  since?: string
}

function VerdictActionButton({ action }: { action: VerdictAction }) {
  if (action.to) {
    return (
      <Link
        to={action.to}
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-7 gap-1.5 px-2.5 text-xs')}
      >
        {action.label}
        <ChevronRight className="h-3 w-3" aria-hidden="true" />
      </Link>
    )
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 px-2.5 text-xs"
      onClick={action.onClick}
      disabled={action.disabled || action.busy}
    >
      {action.busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
      {action.label}
    </Button>
  )
}

/**
 * Freshness signal. The dot ticks once per successful status update, which is
 * what separates "healthy" from "the panel lost the link and is showing you
 * numbers from four minutes ago".
 */
function Freshness({ lastUpdated, stale }: { lastUpdated: Date | null; stale: boolean }) {
  const { t } = useTranslation('dashboard')
  const label = (() => {
    if (!lastUpdated) return t('freshness.noUpdateYet')
    const secs = Math.max(0, Math.round((Date.now() - lastUpdated.getTime()) / 1000))
    if (secs < 10) return t('freshness.updatedJustNow')
    if (secs < 60) return t('freshness.updatedSAgo', { count: secs })
    const mins = Math.floor(secs / 60)
    if (mins < 60) return t('freshness.updatedMAgo', { count: mins })
    return t('freshness.updatedHAgo', { count: Math.floor(mins / 60) })
  })()

  return (
    <p className="flex items-center gap-2 font-mono text-[11px] tabular-nums text-foreground/35">
      <span className="relative inline-flex h-1.5 w-1.5" aria-hidden="true">
        {!stale && (
          <span
            key={lastUpdated ? lastUpdated.getTime() : 'none'}
            className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/70 motion-reduce:hidden"
            style={{ animationIterationCount: 1, animationDuration: '900ms' }}
          />
        )}
        <span
          className={cn(
            'relative inline-flex h-1.5 w-1.5 rounded-full',
            stale ? 'bg-warning/70' : 'bg-success/80',
          )}
        />
      </span>
      {stale ? t('freshness.linkMayBeStale', { label }) : label}
    </p>
  )
}

export function VerdictBand({
  verdict,
  players,
  showPresence,
  lastUpdated,
  stale,
}: {
  verdict: Verdict
  players: PresencePlayer[]
  showPresence: boolean
  lastUpdated: Date | null
  stale: boolean
}) {
  const { t } = useTranslation('dashboard')
  // With nothing wrong and nobody online the band is just the freshness line,
  // so it should not reserve the space of a full section.
  const hasBody = Boolean(verdict.headline || verdict.action) || (showPresence && players.length > 0)
  return (
    <section
      aria-label={t('verdictBand.serverVerdict')}
      role={verdict.level === 'critical' ? 'alert' : 'status'}
      className={cn(
        'px-1',
        hasBody ? 'mt-3 border-b pb-2.5 pt-2' : 'mt-2 pb-1 pt-1',
        verdict.level === 'critical'
          ? 'border-destructive/25'
          : verdict.level === 'warning'
            ? 'border-warning/25'
            : 'border-border/40',
      )}
    >
      {(verdict.headline || verdict.action) && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="min-w-0 flex-1">
            {verdict.headline && (
              <h2
                className={cn(
                  'max-w-[46ch] text-[13px] font-medium leading-snug',
                  verdict.level === 'critical'
                    ? 'text-destructive'
                    : verdict.level === 'warning'
                      ? 'text-warning'
                      : 'text-foreground/95',
                )}
              >
                {verdict.headline}
              </h2>
            )}
            {verdict.detail && (
              <p className="mt-1 max-w-[70ch] font-mono text-[10px] leading-4 text-foreground/45">
                {verdict.detail}
              </p>
            )}
          </div>
          {verdict.action && (
            <div className="shrink-0">
              <VerdictActionButton action={verdict.action} />
            </div>
          )}
        </div>
      )}

      {showPresence && players.length > 0 && (
          <ul className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
            {players.slice(0, 10).map(player => (
              <li key={player.name} className="min-w-0">
                <Link
                  to="/players"
                  className="group flex items-baseline gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                >
                  <span className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-success" aria-hidden="true" />
                  <span
                    className="truncate text-[13px] font-medium text-foreground/90 transition-colors group-hover:text-primary"
                    dir="auto"
                    title={player.name}
                  >
                    {player.name}
                  </span>
                  {player.since && (
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground/35">{player.since}</span>
                  )}
                </Link>
              </li>
            ))}
            {players.length > 10 && (
              <li className="font-mono text-[11px] tabular-nums text-foreground/35">
                {t('verdictBand.andNMore', { count: players.length - 10 })}
              </li>
            )}
          </ul>
      )}

      <div className={hasBody ? 'mt-2' : ''}>
        <Freshness lastUpdated={lastUpdated} stale={stale} />
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Work list                                                                 */
/* -------------------------------------------------------------------------- */

export interface WorkItem {
  to: string
  icon: LucideIcon
  label: string
  /** Live state for this destination, rendered right aligned. */
  state?: string
  tone?: 'default' | 'good' | 'warning' | 'bad'
}

const WORK_STATE_TONE: Record<'default' | 'good' | 'warning' | 'bad', string> = {
  default: 'text-foreground/40',
  good: 'text-success/80',
  warning: 'text-warning',
  bad: 'text-destructive',
}

/**
 * Destinations carrying their own state, so the numbers sit on the thing you
 * act on instead of in a separate read-only panel.
 */
export function WorkList({ items }: { items: WorkItem[] }) {
  const { t } = useTranslation('dashboard')
  return (
    <nav aria-label={t('verdictBand.serverSections')} className="divide-y divide-border/25">
      {items.map(({ to, icon: Icon, label, state, tone }) => (
        <Link
          key={to}
          to={to}
          className="group flex items-center gap-3 py-2.5 pl-1 pr-1.5 transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          <Icon className="h-3.5 w-3.5 shrink-0 text-foreground/35 transition-colors group-hover:text-foreground/70" aria-hidden="true" />
          <span className="shrink-0 text-sm text-foreground/85 transition-colors group-hover:text-foreground">{label}</span>
          {state && (
            <span
              className={cn(
                'ml-auto min-w-0 truncate text-right font-mono text-[11px] tabular-nums',
                WORK_STATE_TONE[tone ?? 'default'],
              )}
            >
              {state}
            </span>
          )}
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-foreground/20 transition-colors group-hover:text-foreground/50',
              !state && 'ml-auto',
            )}
            aria-hidden="true"
          />
        </Link>
      ))}
    </nav>
  )
}