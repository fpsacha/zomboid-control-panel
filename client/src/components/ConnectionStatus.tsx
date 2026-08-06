import { Wifi, WifiOff, Loader2 } from 'lucide-react'
import { useConnectionStatus } from '@/contexts/SocketContext'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface ConnectionStatusProps {
  className?: string
  showLabel?: boolean
}

export function ConnectionStatus({ className, showLabel = false }: ConnectionStatusProps) {
  const { connected, reconnecting, reconnectAttempt, error } = useConnectionStatus()
  const { t } = useTranslation('common')

  // Only show when not connected — a permanently visible "Connected" badge is noise
  if (connected && !reconnecting) return null

  const getStatusInfo = () => {
    if (connected) {
      return {
        icon: Wifi,
        color: 'text-primary',
        surface: 'border-primary/20 bg-primary/10',
        label: t('connectionStatus.connected'),
        description: t('connectionStatus.connectedDescription'),
      }
    }
    if (reconnecting) {
      return {
        icon: Loader2,
        color: 'text-warning',
        surface: 'border-warning/24 bg-warning/10',
        label: t('connectionStatus.reconnecting'),
        description: t('connectionStatus.attempt', { count: reconnectAttempt }),
        animate: true,
      }
    }
    return {
      icon: WifiOff,
      color: 'text-destructive',
      surface: 'border-destructive/24 bg-destructive/10',
      label: t('connectionStatus.disconnected'),
      description: error || t('connectionStatus.disconnectedDescription'),
    }
  }

  const status = getStatusInfo()
  const Icon = status.icon

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div 
          className={cn(
            'flex items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors',
            status.surface,
            connected && 'conn-status-breathing',
            className
          )}
        >
          <Icon 
            className={cn(
              'h-4 w-4',
              status.color,
              status.animate && 'animate-spin'
            )}
            aria-hidden="true"
          />
          {showLabel && (
            <span className="text-sm font-medium text-foreground">
              {status.label}
            </span>
          )}
          {!showLabel && <span className="sr-only">{status.label}</span>}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="text-sm">
          <p className="font-medium">{status.label}</p>
          <p className="text-muted-foreground">{status.description}</p>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
