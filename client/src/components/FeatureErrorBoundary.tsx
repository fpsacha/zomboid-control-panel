import React from 'react'
import { AlertTriangle, RefreshCw, Home } from 'lucide-react'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card'
import { Link } from 'react-router-dom'

// ============================================================================
// Base Error Boundary with customizable props
// ============================================================================

interface FeatureErrorBoundaryProps {
  children: React.ReactNode
  /** Feature name for context in error message */
  featureName?: string
  /** Custom fallback component */
  fallback?: React.ReactNode
  /** Callback when error occurs */
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
  /** Show compact version */
  compact?: boolean
}

interface FeatureErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class FeatureErrorBoundary extends React.Component<FeatureErrorBoundaryProps, FeatureErrorBoundaryState> {
  constructor(props: FeatureErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): FeatureErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(`[${this.props.featureName || 'Feature'}] Error:`, error, errorInfo)
    this.props.onError?.(error, errorInfo)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      const { featureName = 'This feature', compact = false } = this.props

      if (compact) {
        return (
          <div className="p-4 border border-destructive/50 bg-destructive/10 rounded-lg">
            <div className="flex items-center gap-2 text-destructive mb-2">
              <AlertTriangle className="w-4 h-4" />
              <span className="font-medium">{featureName} encountered an error</span>
            </div>
            <Button size="sm" variant="outline" onClick={this.handleReset}>
              <RefreshCw className="w-3 h-3 mr-1" />
              Retry
            </Button>
          </div>
        )
      }

      return (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              {featureName} Error
            </CardTitle>
            <CardDescription>
              An error occurred while loading this section
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {this.state.error && (
              <pre className="p-3 bg-muted rounded-lg text-sm overflow-auto max-h-24 text-muted-foreground">
                {this.state.error.message}
              </pre>
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={this.handleReset}>
                <RefreshCw className="w-4 h-4 mr-2" />
                Try Again
              </Button>
              <Button variant="ghost" asChild>
                <Link to="/">
                  <Home className="w-4 h-4 mr-2" />
                  Dashboard
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )
    }

    return this.props.children
  }
}

// ============================================================================
// Pre-configured Error Boundaries for specific features
// ============================================================================

export function DashboardErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <FeatureErrorBoundary featureName="Dashboard">
      {children}
    </FeatureErrorBoundary>
  )
}

export function PlayersErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <FeatureErrorBoundary featureName="Player Management">
      {children}
    </FeatureErrorBoundary>
  )
}

export function ModsErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <FeatureErrorBoundary featureName="Mod Manager">
      {children}
    </FeatureErrorBoundary>
  )
}

export function ConsoleErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <FeatureErrorBoundary featureName="Console">
      {children}
    </FeatureErrorBoundary>
  )
}

export function EventsErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <FeatureErrorBoundary featureName="Events & Weather">
      {children}
    </FeatureErrorBoundary>
  )
}

export function SchedulerErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <FeatureErrorBoundary featureName="Scheduler">
      {children}
    </FeatureErrorBoundary>
  )
}

export function BackupsErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <FeatureErrorBoundary featureName="Backups">
      {children}
    </FeatureErrorBoundary>
  )
}

export function SettingsErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <FeatureErrorBoundary featureName="Settings">
      {children}
    </FeatureErrorBoundary>
  )
}

export function ServerConfigErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <FeatureErrorBoundary featureName="Server Configuration">
      {children}
    </FeatureErrorBoundary>
  )
}

export function ChunkCleanerErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <FeatureErrorBoundary featureName="Chunk Cleaner">
      {children}
    </FeatureErrorBoundary>
  )
}

export function DiscordErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <FeatureErrorBoundary featureName="Discord Integration">
      {children}
    </FeatureErrorBoundary>
  )
}

export function ChatErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <FeatureErrorBoundary featureName="In-Game Chat">
      {children}
    </FeatureErrorBoundary>
  )
}

export function ServerSetupErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <FeatureErrorBoundary featureName="Server Setup">
      {children}
    </FeatureErrorBoundary>
  )
}

export function ServersErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <FeatureErrorBoundary featureName="Server Manager">
      {children}
    </FeatureErrorBoundary>
  )
}

// ============================================================================
// Compact error boundary for cards/widgets
// ============================================================================

export function WidgetErrorBoundary({ 
  children, 
  name = 'Widget' 
}: { 
  children: React.ReactNode
  name?: string 
}) {
  return (
    <FeatureErrorBoundary featureName={name} compact>
      {children}
    </FeatureErrorBoundary>
  )
}
