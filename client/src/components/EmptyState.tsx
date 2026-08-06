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
import { useTranslation } from 'react-i18next'

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

const emptyStateEyebrows = {
  noData: 'emptyState.noData',
  noResults: 'emptyState.noResults',
  serverOffline: 'emptyState.serverOffline',
  noPlayers: 'emptyState.noPlayers',
  noFile: 'emptyState.noFile',
  disconnected: 'emptyState.disconnected',
  noSchedule: 'emptyState.noSchedule',
  noMods: 'emptyState.noMods',
  noMessages: 'emptyState.noMessages',
  empty: 'emptyState.empty',
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
    variant?: 'default' | 'outline' | 'secondary' | 'ghost'
  }
  secondaryAction?: {
    label: string
    onClick: () => void
    variant?: 'default' | 'outline' | 'secondary' | 'ghost'
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
  secondaryAction,
  compact = false,
  className = ''
}: EmptyStateProps) {
  const { t } = useTranslation('common')
  const IconComponent = emptyStateIcons[type]
  const eyebrow = t(emptyStateEyebrows[type])
  const iconSize = compact ? 'w-10 h-10' : 'w-14 h-14'
  const containerSize = compact ? 'w-16 h-16' : 'w-20 h-20'
  const padding = compact ? 'py-8' : 'py-16'

  return (
    <div className={`flex flex-col items-center justify-center ${padding} px-4 text-center ${className}`} aria-live="polite" aria-atomic="true">
      <div className="relative mb-4">
        <div className={`${containerSize} empty-state-aura rounded-2xl border border-border/50 bg-muted/50 flex items-center justify-center empty-state-icon`} aria-hidden="true">
          {icon || <IconComponent className={`${iconSize} text-muted-foreground/40`} />}
        </div>
      </div>
      <p className="mb-2 text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground/80">{eyebrow}</p>
      <h3 className={`${compact ? 'text-base' : 'text-lg'} font-semibold text-foreground/80 mb-1`}>{title}</h3>
      {description && (
        <p className={`${compact ? 'text-xs' : 'text-sm'} max-w-sm leading-6 text-muted-foreground`}>{description}</p>
      )}
      {action && (
        <div className="mt-4 flex items-center gap-2">
          <Button
            variant={action.variant || 'outline'}
            size={compact ? 'sm' : 'default'}
            onClick={action.onClick}
            className="min-h-11"
          >
            {action.label}
          </Button>
          {secondaryAction && (
            <Button
              variant={secondaryAction.variant || 'ghost'}
              size={compact ? 'sm' : 'default'}
              onClick={secondaryAction.onClick}
              className="min-h-11"
            >
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
