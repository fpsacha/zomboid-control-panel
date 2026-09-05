import { useCallback, useContext, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ShieldAlert, HelpCircle, X } from 'lucide-react'
import { SocketContext } from '@/contexts/SocketContext'
import { systemApi, type StorageHealth } from '@/lib/api'
import { cn } from '@/lib/utils'

const POLL_INTERVAL_MS = 30_000
// Any threshold crossing DiskMonitor emits — we don't try to merge the
// partial payload, just treat it as a signal to refetch full storage health.
const DISK_SOCKET_EVENTS = ['disk:warning', 'disk:critical', 'disk:normal'] as const

type Level = 'warning' | 'critical'

interface Banner {
  level: Level
  title: string
  message: string
  dismissible: boolean
}

function deriveBanner(health: StorageHealth | null, t: (key: string, opts?: Record<string, unknown>) => string): Banner | null {
  if (!health) return null
  const { diskSpace, circuitBreaker } = health
  const save = diskSpace?.saveVolume

  if (circuitBreaker?.open) {
    return {
      level: 'critical',
      title: t('writesBlockedTitle'),
      message: t('writesBlockedMessage'),
      dismissible: false,
    }
  }
  if (save?.critical) {
    return {
      level: 'critical',
      title: t('saveVolumeCriticalTitle'),
      message: t('usedPercent', { percent: save.usedPercent }),
      dismissible: false,
    }
  }
  if (save?.warning) {
    return {
      level: 'warning',
      title: t('saveVolumeWarningTitle'),
      message: t('usedPercent', { percent: save.usedPercent }),
      dismissible: true,
    }
  }
  return null
}

export function SystemHealthBanner() {
  const { t } = useTranslation('systemHealthBanner')
  const [health, setHealth] = useState<StorageHealth | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const socket = useContext(SocketContext)
  const navigate = useNavigate()

  const refresh = useCallback(() => {
    systemApi.getStorageHealth().then((next) => {
      // ok:false means the server couldn't verify this reading (unreachable
      // mount, permission error) and forces warning/critical to false on
      // that path -- diskMonitor.js's own socket-emit path already guards
      // against treating that as a real all-clear (it holds the last known
      // level rather than firing "disk:normal"), but this REST poll doesn't
      // go through that guard. Apply the same "unknown, not cleared" rule
      // here too: keep whichever reading we last trusted instead of
      // silently dropping a live banner because one check briefly failed.
      setHealth((prev) => {
        if (!prev) return next
        const saveVolume = next.diskSpace.saveVolume?.ok === false
          ? prev.diskSpace.saveVolume
          : next.diskSpace.saveVolume
        const panelData = next.diskSpace.panelData.ok === false
          ? prev.diskSpace.panelData
          : next.diskSpace.panelData
        return { ...next, diskSpace: { saveVolume, panelData } }
      })
    }).catch(() => { /* keep last-known state */ })
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [refresh])

  useEffect(() => {
    if (!socket) return
    DISK_SOCKET_EVENTS.forEach((evt) => socket.on(evt, refresh))
    return () => { DISK_SOCKET_EVENTS.forEach((evt) => socket.off(evt, refresh)) }
  }, [socket, refresh])

  const banner = deriveBanner(health, t)

  // Reset dismissal once the condition clears so a future warning isn't pre-dismissed.
  useEffect(() => {
    if (!banner) setDismissed(false)
  }, [banner])

  if (!banner || (dismissed && banner.dismissible)) return null

  const isCritical = banner.level === 'critical'
  const Icon = isCritical ? ShieldAlert : AlertTriangle

  return (
    <div
      role={isCritical ? 'alert' : 'status'}
      aria-live={isCritical ? 'assertive' : 'polite'}
      className={cn(
        'mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border px-3 py-2',
        isCritical
          ? 'border-destructive/35 bg-destructive/[0.05]'
          : 'border-warning/35 bg-warning/[0.04]'
      )}
    >
      <Icon
        className={cn('h-3.5 w-3.5 shrink-0', isCritical ? 'text-destructive' : 'text-warning')}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span
          className={cn(
            'font-mono text-[10px] font-semibold uppercase tracking-[0.18em]',
            isCritical ? 'text-destructive' : 'text-warning'
          )}
        >
          {banner.title}
        </span>
        <span className="min-w-0 text-xs text-muted-foreground">{banner.message}</span>
      </div>
      <div className="ms-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => navigate('/debug')}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <HelpCircle className="h-3 w-3" aria-hidden="true" />
          {t('diagnostics')}
        </button>
        {banner.dismissible && (
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
            aria-label={t('dismissAria')}
            title={t('dismiss')}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  )
}
