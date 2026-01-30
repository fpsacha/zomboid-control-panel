import { Wifi, WifiOff, Loader2 } from 'lucide-react'
import { useConnectionStatus } from '@/contexts/SocketContext'
import { cn } from '@/lib/utils'
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

  const getStatusInfo = () => {
    if (connected) {
      return {
        icon: Wifi,
        color: 'text-green-500',
        bgColor: 'bg-green-500/10',
        label: 'Connected',
        description: 'Real-time updates active',
      }
    }
    if (reconnecting) {
      return {
        icon: Loader2,
        color: 'text-yellow-500',
        bgColor: 'bg-yellow-500/10',
        label: 'Reconnecting...',
        description: `Attempt ${reconnectAttempt}/10`,
        animate: true,
      }
    }
    return {
      icon: WifiOff,
      color: 'text-red-500',
      bgColor: 'bg-red-500/10',
      label: 'Disconnected',
      description: error || 'Connection lost',
    }
  }

  const status = getStatusInfo()
  const Icon = status.icon

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div 
          className={cn(
            'flex items-center gap-2 px-2 py-1 rounded-md transition-colors',
            status.bgColor,
            className
          )}
        >
          <Icon 
            className={cn(
              'h-4 w-4',
              status.color,
              status.animate && 'animate-spin'
            )} 
          />
          {showLabel && (
            <span className={cn('text-sm font-medium', status.color)}>
              {status.label}
            </span>
          )}
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
