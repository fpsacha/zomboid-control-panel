import React from 'react'
import { AlertTriangle, RefreshCw, Home } from 'lucide-react'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card'
import { Link } from 'react-router-dom'
import { reportClientError } from '@/lib/client-errors'
import i18n from '@/i18n'

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
    reportClientError(`[${this.props.featureName || 'Feature'}] Error.`, { error, errorInfo })
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

      const { featureName = 'thisFeature', compact = false } = this.props
      const featureLabel = i18n.t(`common:features.${featureName}`)

      if (compact) {
        return (
          <div className="p-4 border border-destructive/50 bg-destructive/10 rounded-lg">
            <div className="flex items-center gap-2 text-destructive mb-2">
              <AlertTriangle className="w-4 h-4" />
              <span className="font-medium">{i18n.t('common:errorBoundary.featureCompact', { feature: featureLabel })}</span>
            </div>
            <Button size="sm" variant="outline" onClick={this.handleReset}>
              <RefreshCw className="w-3 h-3 mr-1" />
              {i18n.t('common:actions.retry')}
            </Button>
          </div>
        )
      }

      return (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              {i18n.t('common:errorBoundary.featureTitle', { feature: featureLabel })}
            </CardTitle>
            <CardDescription>
              {i18n.t('common:errorBoundary.featureDescription')}
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
                {i18n.t('common:errorBoundary.retry')}
              </Button>
              <Button variant="ghost" asChild>
                <Link to="/">
                  <Home className="w-4 h-4 mr-2" />
                  {i18n.t('common:errorBoundary.dashboard')}
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
