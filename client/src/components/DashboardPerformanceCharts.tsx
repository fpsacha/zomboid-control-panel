import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export interface DashboardPerformancePoint {
  time: string
  timestamp?: string
  playerCount: number
  memoryMB: number
  pzMemMB?: number
  cpuPercent?: number
  hostMemUsedGB?: number
  hostMemTotalGB?: number
  hostDiskUsedGB?: number
  hostDiskTotalGB?: number
  /** Host swap/pagefile, GB. undefined means "could not be determined" --
   * NOT the same as 0, which means swap is genuinely not configured. */
  hostSwapUsedGB?: number
  hostSwapTotalGB?: number
}

interface DashboardPerformanceChartsProps {
  performanceHistory: DashboardPerformancePoint[]
  serverRunning?: boolean
  maxMemoryGB?: number
}

type MetricTone = 'neutral' | 'good' | 'warn' | 'bad'

interface Metric {
  key: string
  label: string
  value: string | number
  unit?: string
  dataKey: string
  alert?: boolean
  tone?: MetricTone
  /** 0..1 of capacity. Present only where the metric is genuinely a fraction. */
  ratio?: number | null
}
/** Colour is a reading of the number, not a slot in a palette. */
function loadTone(ratio: number | null | undefined): MetricTone {
  if (ratio == null || Number.isNaN(ratio)) return 'neutral'
  if (ratio >= 0.9) return 'bad'
  if (ratio >= 0.7) return 'warn'
  return 'good'
}

const TONE_VALUE: Record<MetricTone, string> = {
  neutral: 'text-foreground/90',
  good: 'text-foreground',
  warn: 'text-warning',
  bad: 'text-destructive',
}

const TONE_BAR: Record<MetricTone, string> = {
  neutral: 'bg-muted-foreground/50',
  good: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-destructive',
}

const TONE_CELL: Record<MetricTone, string> = {
  neutral: '',
  good: '',
  warn: 'bg-warning/[0.05]',
  bad: 'bg-destructive/[0.07]',
}

function DashboardPerformanceCharts({
  performanceHistory,
  serverRunning = true,
  maxMemoryGB,
}: DashboardPerformanceChartsProps) {
  const { t } = useTranslation('dashboardPerformanceCharts')

  // Every hook must run on every render. Returning before the useMemo below
  // changed the hook count from 0 to 1 the moment history arrived, which React
  // rejects with "Rendered more hooks than during the previous render".
  const latest = performanceHistory[performanceHistory.length - 1]

  const pzMem = latest?.pzMemMB ?? latest?.memoryMB ?? 0
  const cpu = latest?.cpuPercent ?? 0
  const hostUsed = latest?.hostMemUsedGB
  const hostTotal = latest?.hostMemTotalGB
  const diskUsed = latest?.hostDiskUsedGB
  const diskTotal = latest?.hostDiskTotalGB
  const swapUsed = latest?.hostSwapUsedGB
  const swapTotal = latest?.hostSwapTotalGB

  const pzMemoryGB = pzMem / 1024
  const pzRatio = maxMemoryGB != null ? pzMemoryGB / maxMemoryGB : null
  const hostRatio = hostUsed != null && hostTotal != null ? hostUsed / hostTotal : null
  const diskRatio = diskUsed != null && diskTotal != null && diskTotal > 0 ? diskUsed / diskTotal : null
  // total === 0 (swap genuinely not configured) deliberately leaves this
  // null -- a real, calm reading, not a ratio to alert on.
  const swapRatio = swapUsed != null && swapTotal != null && swapTotal > 0 ? swapUsed / swapTotal : null
  const cpuAlert = cpu >= 90
  const hostRamAlert = hostRatio != null && hostRatio > 0.9
  const diskAlert = diskRatio != null && diskRatio >= 0.9
  const swapAlert = swapRatio != null && swapRatio >= 0.9

  const metrics: Metric[] = useMemo(() => {
    const m: Metric[] = []
    if (!latest) return m

    if (serverRunning) {
      const pzDataKey = latest.pzMemMB != null ? 'pzMemMB' : 'memoryMB'
      m.push({
        key: 'pzMem',
        label: t('pzMemory'),
        value: maxMemoryGB != null
          ? `${pzMemoryGB.toFixed(1)} / ${maxMemoryGB}`
          : pzMem > 1024 ? pzMemoryGB.toFixed(1) : pzMem,
        unit: maxMemoryGB != null || pzMem > 1024 ? 'GB' : 'MB',
        dataKey: pzDataKey,
        tone: 'neutral',
        ratio: pzRatio,
      })

      // A flat line at zero is a dead cell. Who is online is answered in the verdict band.
      if (performanceHistory.some(point => point.playerCount > 0)) {
        m.push({
          key: 'players',
          label: t('players'),
          value: latest.playerCount,
          unit: t('onlineUnit'),
          dataKey: 'playerCount',
          tone: latest.playerCount > 0 ? 'good' : 'neutral',
        })
      }
    }

    m.push({
      key: 'cpu',
      label: t('hostCpu'),
      value: cpu,
      unit: '%',
      dataKey: 'cpuPercent',
      alert: cpuAlert,
      tone: loadTone(cpu / 100),
      ratio: cpu / 100,
    })

    if (hostUsed != null && hostTotal != null) {
      m.push({
        key: 'hostMem',
        label: t('hostMemory'),
        value: `${hostUsed.toFixed(1)} / ${hostTotal}`,
        unit: 'GB',
        dataKey: 'hostMemUsedGB',
        alert: hostRamAlert,
        tone: loadTone(hostRatio),
        ratio: hostRatio,
      })
    }

    // Answers "is that host-memory percentage fine or an emergency" -- if
    // swap is absorbing the pressure, high RAM usage is normal; if swap is
    // also exhausted (or there simply isn't any), the next allocation has
    // nowhere left to go. Placed right after Host memory since it exists to
    // interpret that number. Shown whenever a reading exists, including a
    // real total===0 ("no swap configured" IS the answer here) -- hidden
    // only when the lookup could not determine an answer at all (undefined).
    if (swapUsed != null && swapTotal != null) {
      m.push({
        key: 'swap',
        label: t('hostSwap'),
        value: `${swapUsed.toFixed(1)} / ${swapTotal}`,
        unit: 'GB',
        dataKey: 'hostSwapUsedGB',
        alert: swapAlert,
        tone: loadTone(swapRatio),
        ratio: swapRatio,
      })
    }

    // A full disk corrupts saves and kills backups silently, so it earns a row
    // even though it barely moves from one sample to the next.
    if (diskUsed != null && diskTotal != null) {
      m.push({
        key: 'disk',
        label: t('disk'),
        value: `${diskUsed.toFixed(0)} / ${diskTotal.toFixed(0)}`,
        unit: 'GB',
        dataKey: 'hostDiskUsedGB',
        alert: diskAlert,
        tone: loadTone(diskRatio),
        ratio: diskRatio,
      })
    }

    return m
  }, [t, performanceHistory, serverRunning, maxMemoryGB, latest, pzMem, pzMemoryGB, cpu, hostUsed, hostTotal, diskUsed, diskTotal, swapUsed, swapTotal, cpuAlert, hostRamAlert, diskAlert, swapAlert, pzRatio, hostRatio, diskRatio, swapRatio])

  if (!latest) return null

  /* Collapsed: every metric is a fraction of a ceiling, so the bar is the
     reading and the number is the detail. Rows use the full width. */
  /* One row shape in both modes. Expanding traces swaps the bar for the shape
     over time, it does not change the size of anything. */
  return (
    <div className="divide-y divide-border/20">
      {metrics.map(m => {
        const tone = m.tone ?? 'neutral'
        const pct = m.ratio != null ? Math.min(100, Math.max(0, m.ratio * 100)) : null
        return (
          <div
            key={m.key}
            className={cn(
              'grid h-10 grid-cols-[6.5rem_minmax(0,1fr)_auto_2.75rem] items-center gap-4 px-4',
              TONE_CELL[tone],
            )}
          >
            <span className="truncate font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground/65">
              {m.label}
            </span>

            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/35">
              {pct != null && (
                <div
                  className={cn('h-full rounded-full transition-[width] duration-700 ease-out', TONE_BAR[tone])}
                  style={{ width: `${pct}%` }}
                />
              )}
            </div>

            <div className="flex items-baseline justify-end gap-1 whitespace-nowrap">
              <span className={cn('text-[15px] font-medium leading-none tabular-nums', TONE_VALUE[tone])}>
                {/* bug-hunt-2026-09-08 (operator screenshot, Arabic UI):
                    "23.8 / 31.3" rendered as "31.3 / 23.8" -- not our layout,
                    the Unicode bidi algorithm reorders a `number / number`
                    neutral run inside an RTL paragraph. <bdi> isolates it
                    from the surrounding direction regardless of which
                    locale is active; this is the codebase's one idiom for
                    it, see [[bidi-isolate-numeric-pairs]]. */}
                <bdi>{m.value}</bdi>
              </span>
              {m.unit && (
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55">
                  {m.unit}
                </span>
              )}
            </div>

            <span className="text-end font-mono text-[11px] tabular-nums text-muted-foreground/50">
              {m.key === 'pzMem' ? t('normal') : pct != null && m.unit !== '%' ? `${Math.round(pct)}%` : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export default memo(DashboardPerformanceCharts)
