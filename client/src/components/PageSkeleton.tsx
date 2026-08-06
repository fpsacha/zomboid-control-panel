import { Skeleton } from '@/components/ui/skeleton'
import { useTranslation } from 'react-i18next'

const SKELETON_WIDTHS = ['w-[62%]', 'w-[78%]', 'w-[55%]', 'w-[90%]', 'w-[68%]', 'w-[82%]', 'w-[47%]', 'w-[73%]', 'w-[60%]', 'w-[85%]', 'w-[52%]', 'w-[76%]']

interface PageSkeletonProps {
  variant?: 'dashboard' | 'list' | 'form' | 'console' | 'map' | 'default'
  title?: string
  description?: string
  eyebrow?: string
  metrics?: string[]
}

function SkeletonHeader({
  title,
  description,
  eyebrow,
  metrics = ['route', 'auth', 'socket'],
}: Omit<PageSkeletonProps, 'variant'>) {
  const { t } = useTranslation('common')
  const displayMetrics = metrics?.length
    ? metrics
    : [t('pageLoader.metrics.route'), t('pageLoader.metrics.auth'), t('pageLoader.metrics.socket')]
  title ??= t('pageLoader.defaultTitle')
  description ??= t('pageLoader.defaultDescription')
  eyebrow ??= t('pageLoader.defaultEyebrow')
  return (
    <section className="page-header-shell rounded-lg border border-border/40 bg-card/40 px-4 py-3 sm:px-5 sm:py-4" aria-hidden="true">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="page-eyebrow text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">{eyebrow}</p>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="h-2 w-2 rounded-full bg-primary/70 shadow-[0_0_7px_hsl(var(--primary)/0.45)]" />
              <h1 className="page-title text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{title}</h1>
            </div>
            <p className="page-description max-w-3xl text-xs leading-5 text-muted-foreground sm:text-sm">{description}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 self-start sm:justify-end sm:self-auto">
          {displayMetrics.map(metric => (
            <span key={metric} className="inline-flex h-6 items-center gap-1.5 rounded border border-border/50 bg-muted/30 px-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-primary/70" />
              {metric}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}

export function PageSkeleton({ variant = 'default', title, description, eyebrow, metrics }: PageSkeletonProps) {
  const { t } = useTranslation('common')
  const displayTitle = title ?? t('pageLoader.defaultTitle')
  const header = <SkeletonHeader title={displayTitle} description={description} eyebrow={eyebrow} metrics={metrics} />

  if (variant === 'dashboard') {
    return (
      <div className="space-y-6 page-transition" role="status" aria-live="polite" aria-label={t('pageLoader.dashboardAria')} aria-busy="true">
        {header}
        {/* Stat cards skeleton */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card p-6 space-y-3">
              <Skeleton className="h-1.5 w-full -mt-6 -mx-6 mb-4 rounded-none rounded-t-xl" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-3 w-32" />
            </div>
          ))}
        </div>
        {/* Content skeleton */}
        <div className="rounded-xl border bg-card p-6 space-y-4">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-64" />
          <div className="flex gap-3 pt-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-32 rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (variant === 'list') {
    return (
      <div className="space-y-6 page-transition" role="status" aria-live="polite" aria-label={t('pageLoader.listAria', { title: displayTitle })} aria-busy="true">
        {header}
        <div className="rounded-xl border bg-card">
          <div className="p-4 border-b">
            <Skeleton className="h-10 w-full max-w-sm" />
          </div>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="p-4 border-b last:border-0 flex items-center gap-4">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-8 w-20" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (variant === 'console') {
    return (
      <div className="space-y-6 page-transition" role="status" aria-live="polite" aria-label={t('pageLoader.consoleAria', { title: displayTitle })} aria-busy="true">
        {header}
        <div className="flex gap-2">
          <Skeleton className="h-10 flex-1 max-w-[200px]" />
          <Skeleton className="h-10 flex-1 max-w-[200px]" />
        </div>
        <div className="rounded-xl border bg-card p-4 space-y-2">
          <div className="flex justify-between mb-4">
            <Skeleton className="h-5 w-40" />
            <div className="flex gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-8" />
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className={`h-4 ${SKELETON_WIDTHS[i]}`} />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (variant === 'form') {
    return (
      <div className="space-y-6 page-transition" role="status" aria-live="polite" aria-label={t('pageLoader.formAria', { title: displayTitle })} aria-busy="true">
        {header}
        <div className="rounded-xl border bg-card p-6 space-y-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
          <Skeleton className="h-10 w-32" />
        </div>
      </div>
    )
  }

  if (variant === 'map') {
    return (
      <div className="space-y-6 page-transition" role="status" aria-live="polite" aria-label={t('pageLoader.mapAria', { title: displayTitle })} aria-busy="true">
        {header}
        <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
          <div className="rounded-xl border bg-card p-4 space-y-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-4 w-28" />
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded" />
                <Skeleton className={`h-3 ${SKELETON_WIDTHS[i]}`} />
              </div>
            ))}
          </div>
          <div className="relative min-h-[26rem] overflow-hidden rounded-xl border bg-card">
            <div className="absolute inset-0 opacity-40" style={{ backgroundImage: 'linear-gradient(hsl(var(--border)/0.55) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border)/0.55) 1px, transparent 1px)', backgroundSize: '32px 32px' }} />
            <div className="absolute left-4 top-4 flex gap-2">
              <Skeleton className="h-9 w-24" />
              <Skeleton className="h-9 w-24" />
            </div>
            <Skeleton className="absolute bottom-4 left-4 h-4 w-48" />
          </div>
        </div>
      </div>
    )
  }

  // Default
  return (
    <div className="space-y-6 page-transition" role="status" aria-live="polite" aria-label={t('pageLoader.pageAria', { title: displayTitle })} aria-busy="true">
      {header}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-6 space-y-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-8 w-24" />
          </div>
        ))}
      </div>
    </div>
  )
}
