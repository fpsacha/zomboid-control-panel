import { ReactNode } from 'react'
import { 
  InboxIcon, 
  SearchX, 
  ServerOff, 
  UsersRound, 
  FileQuestion, 
  WifiOff,
  CalendarX,
  Package,
  MessageSquareOff,
  FolderOpen
} from 'lucide-react'
import { Button } from '@/components/ui/button'

// Pre-built icon sets for common empty states
const emptyStateIcons = {
  noData: InboxIcon,
  noResults: SearchX,
  serverOffline: ServerOff,
  noPlayers: UsersRound,
  noFile: FileQuestion,
  disconnected: WifiOff,
  noSchedule: CalendarX,
  noMods: Package,
  noMessages: MessageSquareOff,
  empty: FolderOpen,
} as const

export type EmptyStateType = keyof typeof emptyStateIcons

interface EmptyStateProps {
  type?: EmptyStateType
  icon?: ReactNode
  title: string
  description?: string
  action?: {
    label: string
    onClick: () => void
    variant?: 'default' | 'outline' | 'secondary'
  }
  compact?: boolean
  className?: string
}

export function EmptyState({ 
  type = 'noData', 
  icon, 
  title, 
  description, 
  action,
  compact = false,
  className = ''
}: EmptyStateProps) {
  const IconComponent = emptyStateIcons[type]
  const iconSize = compact ? 'w-10 h-10' : 'w-14 h-14'
  const containerSize = compact ? 'w-16 h-16' : 'w-20 h-20'
  const padding = compact ? 'py-8' : 'py-16'

  return (
    <div className={`flex flex-col items-center justify-center ${padding} px-4 text-center ${className}`}>
      <div className={`${containerSize} rounded-2xl bg-muted/50 border border-border/50 flex items-center justify-center mb-4 empty-state-icon`}>
        {icon || <IconComponent className={`${iconSize} text-muted-foreground/40`} />}
      </div>
      <h3 className={`${compact ? 'text-base' : 'text-lg'} font-semibold text-foreground/80 mb-1`}>{title}</h3>
      {description && (
        <p className={`${compact ? 'text-xs' : 'text-sm'} text-muted-foreground max-w-sm`}>{description}</p>
      )}
      {action && (
        <Button
          variant={action.variant || 'outline'}
          size={compact ? 'sm' : 'default'}
          onClick={action.onClick}
          className="mt-4"
        >
          {action.label}
        </Button>
      )}
    </div>
  )
}
