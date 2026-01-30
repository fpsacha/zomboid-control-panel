import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { discordApi } from '@/lib/api'
import { 
  MessageSquare, 
  Bot, 
  Play, 
  Square, 
  RefreshCw, 
  CheckCircle2, 
  AlertCircle,
  Eye,
  EyeOff,
  Send,
  ExternalLink,
  Shield,
  Hash,
  Server,
  Bell
} from 'lucide-react'

interface DiscordStatus {
  running: boolean
  configured: boolean
  connected?: boolean
  guildName?: string
  channelName?: string
  error?: string
}

interface DiscordConfig {
  token: string | null
  hasToken: boolean
  guildId: string
  adminRoleId: string
  channelId: string
}

interface BotInfo {
  username: string
  id: string
  discriminator: string
}

interface WebhookEvent {
  enabled: boolean
  template: string
}

type WebhookEvents = Record<string, WebhookEvent>

export default function Discord() {
  const [status, setStatus] = useState<DiscordStatus | null>(null)
  const [config, setConfig] = useState<DiscordConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [botInfo, setBotInfo] = useState<BotInfo | null>(null)
  const [webhookEvents, setWebhookEvents] = useState<WebhookEvents>({})
  const [savingEvents, setSavingEvents] = useState(false)
  
  // Form state
  const [token, setToken] = useState('')
  const [guildId, setGuildId] = useState('')
  const [adminRoleId, setAdminRoleId] = useState('')
  const [channelId, setChannelId] = useState('')
  
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null)

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      setLoading(true)
      const [statusData, configData, eventsData] = await Promise.all([
        discordApi.getStatus().catch(() => ({ running: false, configured: false })),
        discordApi.getConfig().catch(() => null),
        discordApi.getWebhookEvents().catch(() => ({ events: {} }))
      ])
      
      setStatus(statusData)
      setConfig(configData)
      setWebhookEvents(eventsData.events || {})
      
      if (configData) {
        setGuildId(configData.guildId || '')
        setAdminRoleId(configData.adminRoleId || '')
        setChannelId(configData.channelId || '')
      }
    } catch (error) {
      console.error('Failed to load Discord data:', error)
    } finally {
      setLoading(false)
    }
  }

  // Discord ID validation (snowflake format - 17-19 digit number)
  const isValidDiscordId = (id: string): boolean => {
    if (!id) return true // Empty is allowed for optional fields
    return /^\d{17,19}$/.test(id)
  }

  const handleSaveConfig = async () => {
    try {
      setSaving(true)
      setMessage(null)
      
      // If no new token provided, check if one already exists
      if (!token && !config?.hasToken) {
        setMessage({ type: 'error', text: 'Bot token is required' })
        return
      }
      
      if (!guildId) {
        setMessage({ type: 'error', text: 'Guild ID is required' })
        return
      }
      
      // Validate Guild ID format
      if (!isValidDiscordId(guildId)) {
        setMessage({ type: 'error', text: 'Invalid Guild ID format (should be 17-19 digit number)' })
        return
      }
      
      // Validate Channel ID format if provided
      if (channelId && !isValidDiscordId(channelId)) {
        setMessage({ type: 'error', text: 'Invalid Channel ID format (should be 17-19 digit number)' })
        return
      }
      
      // Validate Admin Role ID format if provided
      if (adminRoleId && !isValidDiscordId(adminRoleId)) {
        setMessage({ type: 'error', text: 'Invalid Admin Role ID format (should be 17-19 digit number)' })
        return
      }
      
      // Only send token if user entered a new one, otherwise send special marker
      const tokenToSave = token || 'KEEP_EXISTING'
      
      await discordApi.updateConfig(
        tokenToSave,
        guildId,
        adminRoleId || undefined,
        channelId || undefined
      )
      
      setMessage({ type: 'success', text: 'Discord configuration saved successfully' })
      setToken('')
      await loadData()
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Failed to save configuration' })
    } finally {
      setSaving(false)
    }
  }

  const handleTestToken = async () => {
    try {
      setTesting(true)
      setMessage(null)
      setBotInfo(null)
      
      if (!token) {
        setMessage({ type: 'error', text: 'Enter a token to test' })
        return
      }
      
      const result = await discordApi.testToken(token)
      setBotInfo(result.bot)
      setMessage({ type: 'success', text: `Token valid! Bot: ${result.bot.username}` })
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Invalid token' })
    } finally {
      setTesting(false)
    }
  }

  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [sendingTest, setSendingTest] = useState(false)

  const handleStart = async () => {
    if (starting) return // Prevent double-click
    try {
      setStarting(true)
      setMessage(null)
      await discordApi.start()
      setMessage({ type: 'success', text: 'Discord bot started' })
      await loadData()
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Failed to start bot' })
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    if (stopping) return // Prevent double-click
    try {
      setStopping(true)
      setMessage(null)
      await discordApi.stop()
      setMessage({ type: 'success', text: 'Discord bot stopped' })
      await loadData()
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Failed to stop bot' })
    } finally {
      setStopping(false)
    }
  }

  const handleSendTestMessage = async () => {
    if (sendingTest) return // Prevent double-click
    try {
      setSendingTest(true)
      setMessage(null)
      await discordApi.sendTestMessage()
      setMessage({ type: 'success', text: 'Test message sent to Discord channel' })
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Failed to send test message' })
    } finally {
      setSendingTest(false)
    }
  }

  const handleToggleEvent = (eventKey: string, enabled: boolean) => {
    setWebhookEvents(prev => ({
      ...prev,
      [eventKey]: { ...prev[eventKey], enabled }
    }))
  }

  const handleUpdateTemplate = (eventKey: string, template: string) => {
    setWebhookEvents(prev => ({
      ...prev,
      [eventKey]: { ...prev[eventKey], template }
    }))
  }

  const handleSaveWebhookEvents = async () => {
    try {
      setSavingEvents(true)
      await discordApi.updateWebhookEvents(webhookEvents)
      setMessage({ type: 'success', text: 'Webhook events saved' })
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Failed to save webhook events' })
    } finally {
      setSavingEvents(false)
    }
  }

  const eventLabels: Record<string, { label: string; description: string; variables: string }> = {
    serverStart: { label: 'Server Start', description: 'When server starts', variables: 'None' },
    serverStop: { label: 'Server Stop', description: 'When server stops', variables: 'None' },
    playerJoin: { label: 'Player Join', description: 'When a player connects', variables: '{player}' },
    playerLeave: { label: 'Player Leave', description: 'When a player disconnects', variables: '{player}' },
    scheduledRestart: { label: 'Scheduled Restart', description: 'Before scheduled restart', variables: '{minutes}' },
    backupComplete: { label: 'Backup Complete', description: 'After backup finishes', variables: 'None' },
    playerDeath: { label: 'Player Death', description: 'When a player dies', variables: '{player}' }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MessageSquare className="w-7 h-7" />
            Discord Bot
          </h1>
          <p className="text-muted-foreground">
            Configure Discord integration for server management commands
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={status?.running ? 'default' : 'secondary'}>
            {status?.running ? (
              <>
                <CheckCircle2 className="w-3 h-3 mr-1" />
                Running
              </>
            ) : (
              <>
                <AlertCircle className="w-3 h-3 mr-1" />
                Stopped
              </>
            )}
          </Badge>
          <Button variant="outline" size="icon" onClick={loadData}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Status Message */}
      {message && (
        <Alert variant={message.type === 'error' ? 'destructive' : 'default'}>
          {message.type === 'error' ? (
            <AlertCircle className="h-4 w-4" />
          ) : (
            <CheckCircle2 className="h-4 w-4" />
          )}
          <AlertTitle>{message.type === 'error' ? 'Error' : 'Success'}</AlertTitle>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Bot Status */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="w-5 h-5" />
              Bot Status
            </CardTitle>
            <CardDescription>
              Current status of the Discord bot
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-muted rounded-lg">
                <p className="text-sm text-muted-foreground">Status</p>
                <p className="text-lg font-semibold">
                  {status?.running ? 'Online' : 'Offline'}
                </p>
              </div>
              <div className="p-4 bg-muted rounded-lg">
                <p className="text-sm text-muted-foreground">Configured</p>
                <p className="text-lg font-semibold">
                  {config?.hasToken ? 'Yes' : 'No'}
                </p>
              </div>
            </div>
            
            {status?.guildName && (
              <div className="p-4 bg-muted rounded-lg">
                <p className="text-sm text-muted-foreground">Connected Server</p>
                <p className="text-lg font-semibold">{status.guildName}</p>
              </div>
            )}
            
            {status?.error && (
              <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
                <p className="text-sm text-destructive font-medium">Bot Error</p>
                <p className="text-sm text-destructive/80">{status.error}</p>
              </div>
            )}
            
            <div className="flex gap-2">
              {status?.running ? (
                <Button variant="destructive" onClick={handleStop} className="flex-1" disabled={stopping}>
                  {stopping ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Square className="w-4 h-4 mr-2" />}
                  {stopping ? 'Stopping...' : 'Stop Bot'}
                </Button>
              ) : (
                <Button 
                  onClick={handleStart} 
                  className="flex-1"
                  disabled={!config?.hasToken || starting}
                >
                  {starting ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                  {starting ? 'Starting...' : 'Start Bot'}
                </Button>
              )}
              
              {status?.running && config?.channelId && (
                <Button variant="outline" onClick={handleSendTestMessage} disabled={sendingTest}>
                  {sendingTest ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
                  {sendingTest ? 'Sending...' : 'Test Message'}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Available Commands */}
        <Card>
          <CardHeader>
            <CardTitle>Available Slash Commands</CardTitle>
            <CardDescription>
              Commands that server moderators can use in Discord
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between p-2 bg-muted rounded">
                <code>/status</code>
                <span className="text-muted-foreground">View server status</span>
              </div>
              <div className="flex justify-between p-2 bg-muted rounded">
                <code>/players</code>
                <span className="text-muted-foreground">List online players</span>
              </div>
              <div className="flex justify-between p-2 bg-muted rounded">
                <code>/start</code>
                <span className="text-muted-foreground">Start the server</span>
              </div>
              <div className="flex justify-between p-2 bg-muted rounded">
                <code>/stop</code>
                <span className="text-muted-foreground">Stop the server</span>
              </div>
              <div className="flex justify-between p-2 bg-muted rounded">
                <code>/restart</code>
                <span className="text-muted-foreground">Restart with warning</span>
              </div>
              <div className="flex justify-between p-2 bg-muted rounded">
                <code>/save</code>
                <span className="text-muted-foreground">Save the world</span>
              </div>
              <div className="flex justify-between p-2 bg-muted rounded">
                <code>/broadcast</code>
                <span className="text-muted-foreground">Send server message</span>
              </div>
              <div className="flex justify-between p-2 bg-muted rounded">
                <code>/kick</code>
                <span className="text-muted-foreground">Kick a player</span>
              </div>
              <div className="flex justify-between p-2 bg-muted rounded">
                <code>/rcon</code>
                <span className="text-muted-foreground">Execute RCON command</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Configuration */}
      <Card>
        <CardHeader>
          <CardTitle>Bot Configuration</CardTitle>
          <CardDescription>
            Set up your Discord bot credentials and permissions.
            <a 
              href="https://discord.com/developers/applications" 
              target="_blank" 
              rel="noopener noreferrer"
              className="ml-2 text-primary hover:underline inline-flex items-center"
            >
              Create a bot <ExternalLink className="w-3 h-3 ml-1" />
            </a>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Bot Token */}
          <div className="space-y-2">
            <Label htmlFor="token" className="flex items-center gap-2">
              <Bot className="w-4 h-4" />
              Bot Token
              {config?.hasToken && (
                <Badge variant="outline" className="text-xs">Configured</Badge>
              )}
            </Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="token"
                  type={showToken ? 'text' : 'password'}
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value)
                    setBotInfo(null) // Clear stale bot info when token changes
                  }}
                  placeholder={config?.hasToken ? '••••••••••••••••' : 'Enter bot token'}
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full"
                  onClick={() => setShowToken(!showToken)}
                >
                  {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>
              <Button variant="outline" onClick={handleTestToken} disabled={testing || !token}>
                {testing ? <RefreshCw className="w-4 h-4 animate-spin" /> : 'Test'}
              </Button>
            </div>
            {botInfo && (
              <p className="text-sm text-green-600">✓ Valid token for bot: {botInfo.username}</p>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Guild ID */}
            <div className="space-y-2">
              <Label htmlFor="guildId" className="flex items-center gap-2">
                <Server className="w-4 h-4" />
                Guild (Server) ID *
              </Label>
              <Input
                id="guildId"
                value={guildId}
                onChange={(e) => setGuildId(e.target.value)}
                placeholder="123456789012345678"
              />
              <p className="text-xs text-muted-foreground">
                Right-click your server → Copy Server ID
              </p>
            </div>

            {/* Admin Role ID */}
            <div className="space-y-2">
              <Label htmlFor="adminRoleId" className="flex items-center gap-2">
                <Shield className="w-4 h-4" />
                Admin Role ID
              </Label>
              <Input
                id="adminRoleId"
                value={adminRoleId}
                onChange={(e) => setAdminRoleId(e.target.value)}
                placeholder="Optional"
              />
              <p className="text-xs text-muted-foreground">
                Role required to use commands
              </p>
            </div>

            {/* Channel ID */}
            <div className="space-y-2">
              <Label htmlFor="channelId" className="flex items-center gap-2">
                <Hash className="w-4 h-4" />
                Notification Channel ID
              </Label>
              <Input
                id="channelId"
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                placeholder="Optional"
              />
              <p className="text-xs text-muted-foreground">
                Channel for server notifications
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={loadData}>
              Cancel
            </Button>
            <Button onClick={handleSaveConfig} disabled={saving}>
              {saving ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Configuration'
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Webhook Events */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="w-5 h-5" />
            Webhook Events
          </CardTitle>
          <CardDescription>
            Configure automatic notifications for server events
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {Object.entries(eventLabels).map(([eventKey, { label, description, variables }]) => {
            const event = webhookEvents[eventKey] || { enabled: false, template: '' }
            return (
              <div key={eventKey} className="space-y-3 p-4 border rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-base font-medium">{label}</Label>
                    <p className="text-sm text-muted-foreground">{description}</p>
                  </div>
                  <Switch
                    checked={event.enabled}
                    onCheckedChange={(checked) => handleToggleEvent(eventKey, checked)}
                  />
                </div>
                {event.enabled && (
                  <div className="space-y-2">
                    <Label className="text-sm">Message Template</Label>
                    <Textarea
                      value={event.template}
                      onChange={(e) => handleUpdateTemplate(eventKey, e.target.value)}
                      placeholder="Enter notification message..."
                      rows={2}
                    />
                    <p className="text-xs text-muted-foreground">
                      Available variables: {variables}
                    </p>
                  </div>
                )}
              </div>
            )
          })}
          <div className="flex justify-end">
            <Button onClick={handleSaveWebhookEvents} disabled={savingEvents}>
              {savingEvents ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Events'
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Setup Instructions */}
      <Card>
        <CardHeader>
          <CardTitle>Setup Instructions</CardTitle>
        </CardHeader>
        <CardContent className="prose prose-sm dark:prose-invert max-w-none">
          <ol className="space-y-3">
            <li>
              <strong>Create a Discord Application:</strong> Go to the{' '}
              <a 
                href="https://discord.com/developers/applications" 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Discord Developer Portal
              </a>{' '}
              and create a new application.
            </li>
            <li>
              <strong>Create a Bot:</strong> In your application, go to the "Bot" section and create a bot.
              Copy the bot token and paste it above.
            </li>
            <li>
              <strong>Enable Intents:</strong> Under "Privileged Gateway Intents", enable:
              <ul className="mt-2 ml-4">
                <li>Server Members Intent</li>
                <li>Message Content Intent (optional, for future features)</li>
              </ul>
            </li>
            <li>
              <strong>Invite the Bot:</strong> Go to OAuth2 → URL Generator:
              <ul className="mt-2 ml-4">
                <li>Select scopes: <code>bot</code> and <code>applications.commands</code></li>
                <li>Select permissions: <code>Send Messages</code>, <code>Use Slash Commands</code></li>
                <li>Open the generated URL to invite the bot to your server</li>
              </ul>
            </li>
            <li>
              <strong>Get IDs:</strong> Enable Developer Mode in Discord settings, then right-click to copy IDs:
              <ul className="mt-2 ml-4">
                <li>Server → Copy Server ID (Guild ID)</li>
                <li>Role → Copy Role ID (Admin Role)</li>
                <li>Channel → Copy Channel ID (Notifications)</li>
              </ul>
            </li>
            <li>
              <strong>Start the Bot:</strong> Save your configuration and click "Start Bot".
            </li>
          </ol>
        </CardContent>
      </Card>
    </div>
  )
}
