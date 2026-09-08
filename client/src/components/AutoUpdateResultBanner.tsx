import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Clock, X } from 'lucide-react'
import { updateApi, type AutoUpdateResult } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { getAutoUpdateReasonMessage, getAutoUpdateServerStateMessage, getAutoUpdateSuccessMessage } from '@/lib/autoUpdateResult'
import { useToast } from '@/components/ui/use-toast'
import { useSocket } from '@/contexts/SocketContext'
import { cn } from '@/lib/utils'

interface AutoUpdateScheduled {
  warningMinutes: number
}

// 2026-08-26: renders the outcome of the UNATTENDED automatic server
// update (server/services/updateChecker.js's runAutoUpdate()) -- the one
// panel-managed job that stops and restarts a live server with nobody
// reviewing the result. A cold fetch on mount covers the operator who
// enabled this and walked away (a live event alone only reaches whoever
// is watching at that instant), and a persisted result is what dismissal
// round-trips against -- see updateApi.dismissAutoUpdateResult's own
// comment for why a per-browser dismissal would be wrong here.
//
// 2026-09-08: that cold fetch was the ONLY thing driving this banner --
// `server:autoUpdateScheduled`/`server:autoUpdateComplete` were emitted
// into zero listeners anywhere in the client. Leaving the Dashboard open
// through an entire cycle gave no in-app signal at all: no "restarting in
// N minutes", no live notice on completion, nothing until you navigated
// away and back. This subscribes to both existing events -- the server
// side already works and is untouched.
export function AutoUpdateResultBanner() {
  const { t } = useTranslation('dashboard')
  const { toast } = useToast()
  const socket = useSocket()
  const [result, setResult] = useState<AutoUpdateResult | null>(null)
  const [scheduled, setScheduled] = useState<AutoUpdateScheduled | null>(null)
  const [dismissing, setDismissing] = useState(false)
  // Bumped by every live `autoUpdateComplete` refetch so a slower, older
  // fetch (the initial mount fetch, or an earlier completion's own
  // refetch) can't land after it and stomp fresher state -- the exact
  // mount-race this file was flagged for.
  const resultFetchGenerationRef = useRef(0)

  const refreshResult = useCallback(() => {
    const generation = ++resultFetchGenerationRef.current
    updateApi.getStatus()
      .then((status) => {
        if (resultFetchGenerationRef.current === generation) setResult(status.lastAutoUpdateResult)
      })
      .catch(() => { /* keep whatever is currently shown; this is best-effort */ })
  }, [])

  useEffect(() => {
    refreshResult()
  }, [refreshResult])

  useEffect(() => {
    if (!socket) return
    const handleScheduled = (data: { warningMinutes: number }) => {
      setScheduled({ warningMinutes: data.warningMinutes })
    }
    const handleComplete = () => {
      // The persisted record (reason/phase/serverUp/appliedVersion) is
      // what renders an accurate outcome -- the event itself only carries
      // success/error, so refetch rather than rendering off the event.
      setScheduled(null)
      refreshResult()
    }
    socket.on('server:autoUpdateScheduled', handleScheduled)
    socket.on('server:autoUpdateComplete', handleComplete)
    return () => {
      socket.off('server:autoUpdateScheduled', handleScheduled)
      socket.off('server:autoUpdateComplete', handleComplete)
    }
  }, [socket, refreshResult])

  const dismiss = useCallback(async () => {
    setDismissing(true)
    try {
      const status = await updateApi.dismissAutoUpdateResult()
      setResult(status.lastAutoUpdateResult)
    } catch (error) {
      toast({
        title: t('autoUpdateResult.dismissFailedTitle'),
        description: getUserErrorMessage(error, t('autoUpdateResult.dismissFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setDismissing(false)
    }
  }, [t, toast])

  const showResult = !!result && !result.dismissed
  if (!scheduled && !showResult) return null

  const isFailure = result?.status === 'failed'

  return (
    <>
      {scheduled && (
        <div
          role="status"
          aria-live="polite"
          className="mb-3 flex items-start gap-3 rounded-md border border-warning/35 bg-warning/[0.05] px-3 py-2.5"
        >
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium text-warning">{t('autoUpdateResult.scheduledTitle')}</p>
            <p className="text-sm text-muted-foreground">
              {scheduled.warningMinutes > 0
                ? t('autoUpdateResult.scheduledDescription', { count: scheduled.warningMinutes })
                : t('autoUpdateResult.scheduledDescriptionNow')}
            </p>
          </div>
        </div>
      )}
      {showResult && result && (
        <div
          role={isFailure ? 'alert' : 'status'}
          aria-live={isFailure ? 'assertive' : 'polite'}
          className={cn(
            'mb-3 flex items-start gap-3 rounded-md border px-3 py-2.5',
            isFailure ? 'border-destructive/35 bg-destructive/[0.05]' : 'border-success/35 bg-success/[0.05]'
          )}
        >
          {isFailure
            ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
            : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />}
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className={cn('text-sm font-medium', isFailure ? 'text-destructive' : 'text-success')}>
              {isFailure ? t('autoUpdateResult.failedTitle') : t('autoUpdateResult.successTitle')}
            </p>
            {isFailure && (
              <p className="text-sm font-medium text-foreground">
                {getAutoUpdateServerStateMessage(t, result.serverUp)}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {isFailure ? getAutoUpdateReasonMessage(t, result) : getAutoUpdateSuccessMessage(t, result)}
            </p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            disabled={dismissing}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            aria-label={t('autoUpdateResult.dismissAria')}
            // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; disables only transiently while the dismiss action itself is in flight (self-evident, not a permission gate). Triaged 2026-08-27.
            title={t('autoUpdateResult.dismiss')}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  )
}
