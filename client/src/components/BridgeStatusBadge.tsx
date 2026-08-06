import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

type BridgeState = 'connected' | 'waiting' | 'offline' | 'loading'

interface BridgeStatusBadgeProps {
  connected: boolean
  running?: boolean
  loading?: boolean
  bridgePath?: string | null
  summary?: string | null
  className?: string
}

export function BridgeStatusBadge({ connected, running, loading, bridgePath, summary, className }: BridgeStatusBadgeProps) {
  const { t } = useTranslation('common')
  const state: BridgeState = loading ? 'loading' : connected ? 'connected' : running ? 'waiting' : 'offline'

  const config: Record<BridgeState, { surface: string; dot: string; label: string; hint?: string }> = {
    connected: {
      surface: 'border-primary/15 bg-primary/8',
      dot: 'bg-primary',
      label: t('bridgeStatus.connected'),
    },
    waiting: {
      surface: 'border-warning/20 bg-warning/8',
      dot: 'bg-warning animate-pulse',
      label: t('bridgeStatus.waiting'),
      hint: t('bridgeStatus.waitingHint'),
    },
    offline: {
      surface: 'border-destructive/20 bg-destructive/8',
      dot: 'bg-destructive',
      label: t('bridgeStatus.offline'),
      hint: t('bridgeStatus.offlineHint'),
    },
    loading: {
      surface: 'border-border/40 bg-muted/30',
      dot: '',
      label: t('bridgeStatus.checking'),
    },
  }

  const c = config[state]
  const tooltip = [
    summary || c.hint,
    bridgePath ? t('bridgeStatus.path', { path: bridgePath }) : null,
  ].filter(Boolean).join('\n')

  return (
    <div
      role="status"
      aria-live="polite"
      title={tooltip || undefined}
      className={cn('flex items-center gap-2 rounded-lg border px-3 py-1.5 cursor-default', c.surface, className)}
    >
      {state === 'loading' ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
      ) : (
        <div className={cn('w-2 h-2 rounded-full shrink-0', c.dot)} aria-hidden="true" />
      )}
      <span className="text-sm font-medium text-foreground">{c.label}</span>
    </div>
  )
}
