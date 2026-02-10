import { useEffect, useState, useCallback, useRef } from 'react'
import { 
  Save,
  Server,
  Link,
  Clock,
  Shield,
  AlertTriangle,
  Eye,
  EyeOff,
  Loader2,
  Key,
  Cloud,
  Zap,
  CheckCircle2,
  XCircle,
  Download,
  RefreshCw,
  Archive,
  Trash2,
  HardDrive,
  RotateCcw,
  Settings2,
  Globe,
  RotateCw
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/components/ui/use-toast'
import { configApi, panelBridgeApi, backupApi, serversApi, serverApi, BackupStatus, BackupFile, ServerInstance } from '@/lib/api'
import { useSocket } from '@/contexts/SocketContext'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface AppSettings {
  // Mod Checker Settings
  modCheckInterval: string
  modAutoRestart: boolean
  modRestartDelay: string
  
  // API Keys
  steamApiKey: string
  
  // General Settings
  darkMode: boolean
  autoReconnect: boolean
  reconnectInterval: string
  
  // Panel Settings
  panelPort: string
}

export default function Settings() {
  const socket = useSocket()
  const [settings, setSettings] = useState<AppSettings>({
    modCheckInterval: '30',
    modAutoRestart: true,
    modRestartDelay: '5',
    steamApiKey: '',
    darkMode: true,
    autoReconnect: true,
    reconnectInterval: '5',
    panelPort: '3001',
  })
  const [originalSettings, setOriginalSettings] = useState<AppSettings | null>(null)
  const [loading, setLoading] = useState(false)
  const [showSteamApiKey, setShowSteamApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testingRcon, setTestingRcon] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const { toast } = useToast()
  
  // Panel Bridge state
  const [bridgeStatus, setBridgeStatus] = useState<{
    configured: boolean
    bridgePath: string | null
    isRunning: boolean
    pendingCommands: number
    modConnected: boolean
    consecutiveFailures?: number
    hasFileWatcher?: boolean
    config?: {
      statusStaleMs: number
      pollIntervalMs: number
      statusCheckMs: number
    }
    statusFile?: {
      exists: boolean
      path?: string
      size?: number
      modified?: string
      age?: number
      ageSeconds?: number
      error?: string
    }
    modStatus: {
      alive: boolean
      version: string
      serverName: string
      playerCount?: number
      players: string[]
      path: string
      timestamp: number
      age?: number
      error?: string
    } | null
    detectedPaths?: {
      serverName: string
      installPath: string
      zomboidDataPath: string
    } | null
  } | null>(null)
  const [bridgeLoading, setBridgeLoading] = useState(false)
  const [bridgeError, setBridgeError] = useState<string | null>(null)
  
  // Server list for install dropdown
  const [servers, setServers] = useState<ServerInstance[]>([])
  const [selectedInstallServerId, setSelectedInstallServerId] = useState<string>('')
  const [installingMod, setInstallingMod] = useState(false)
  
  // Backup state
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null)
  const [backups, setBackups] = useState<BackupFile[]>([])
  const [backupLoading, setBackupLoading] = useState(false)
  const [creatingBackup, setCreatingBackup] = useState(false)
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null)
  const [restoreConfirmBackup, setRestoreConfirmBackup] = useState<string | null>(null)
  const [backupSchedule, setBackupSchedule] = useState('0 */6 * * *')
  const [backupMaxCount, setBackupMaxCount] = useState(10)
  
  // Track if there are unsaved changes
  const isDirty = originalSettings !== null && JSON.stringify(settings) !== JSON.stringify(originalSettings)
  
  // Warn before leaving with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [isDirty])

  const fetchSettings = useCallback(async () => {
    setLoading(true)
    try {
      const data = await configApi.getAppSettings()
      if (data.settings) {
        // Use functional update to get current state and merge with loaded settings
        setSettings(prevSettings => {
          const loadedSettings = {
            ...prevSettings,
            ...data.settings
          }
          setOriginalSettings(loadedSettings)
          return loadedSettings
        })
      }
    } catch (error) {
      console.error('Failed to fetch settings:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  // Reload settings when active server changes
  useEffect(() => {
    if (!socket) return
    
    const handleActiveServerChanged = () => {
      fetchSettings()
    }
    
    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, fetchSettings])

  const handleSave = async () => {
    setSaving(true)
    try {
      await configApi.updateAppSettings(settings as unknown as Record<string, string>)
      setOriginalSettings(settings) // Reset dirty state after save
      toast({
        title: 'Success',
        description: 'Settings saved successfully',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save settings',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleTestRcon = async () => {
    setTestingRcon(true)
    try {
      await configApi.testRcon()
      toast({
        title: 'Success',
        description: 'RCON connection successful',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Connection Failed',
        description: error instanceof Error ? error.message : 'Could not connect to RCON',
        variant: 'destructive',
      })
    } finally {
      setTestingRcon(false)
    }
  }

  // Panel Bridge functions
  const fetchBridgeStatus = useCallback(async () => {
    try {
      const status = await panelBridgeApi.getStatus()
      setBridgeStatus(status)
      setBridgeError(null)
    } catch (error) {
      console.error('Failed to fetch bridge status:', error)
    }
  }, [])
  
  // Fetch servers list for install dropdown
  const fetchServers = useCallback(async () => {
    try {
      const data = await serversApi.getAll()
      setServers(data.servers || [])
      // Auto-select active server
      const activeServer = data.servers?.find((s) => s.isActive)
      if (activeServer && !selectedInstallServerId) {
        setSelectedInstallServerId(String(activeServer.id))
      }
    } catch (error) {
      console.error('Failed to fetch servers:', error)
    }
  }, [selectedInstallServerId])
  
  // Install PanelBridge mod to selected server
  const handleInstallMod = async () => {
    if (!selectedInstallServerId) {
      toast({
        title: 'Error',
        description: 'Please select a server to install to',
        variant: 'destructive',
      })
      return
    }
    
    setInstallingMod(true)
    try {
      const result = await panelBridgeApi.installModAuto(selectedInstallServerId)
      toast({
        title: 'Success',
        description: `PanelBridge.lua installed to ${result.serverName || 'server'}`,
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Installation Failed',
        description: error instanceof Error ? error.message : 'Failed to install mod',
        variant: 'destructive',
      })
    } finally {
      setInstallingMod(false)
    }
  }

  // Use ref for bridge polling interval to avoid recreation issues
  const bridgeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const bridgeStatusRef = useRef(bridgeStatus)
  
  // Keep ref in sync with state
  useEffect(() => {
    bridgeStatusRef.current = bridgeStatus
  }, [bridgeStatus])

  useEffect(() => {
    fetchBridgeStatus()
    fetchServers()
    
    // Use recursive setTimeout for adaptive interval based on current status
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    
    const scheduleNextFetch = () => {
      const status = bridgeStatusRef.current
      // Poll faster when waiting for mod to connect
      const interval = (status?.isRunning && !status?.modConnected) ? 3000 : 10000
      
      timeoutId = setTimeout(async () => {
        await fetchBridgeStatus()
        scheduleNextFetch()
      }, interval)
    }
    
    scheduleNextFetch()
    
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      if (bridgeIntervalRef.current) {
        clearInterval(bridgeIntervalRef.current)
        bridgeIntervalRef.current = null
      }
    }
  }, [fetchBridgeStatus])

  // Backup functions
  const fetchBackupStatus = useCallback(async () => {
    try {
      const status = await backupApi.getStatus()
      setBackupStatus(status)
      setBackupSchedule(status.schedule)
      setBackupMaxCount(status.maxBackups)
    } catch (error) {
      console.error('Failed to fetch backup status:', error)
    }
  }, [])

  const fetchBackups = useCallback(async () => {
    try {
      const data = await backupApi.listBackups()
      setBackups(data.backups || [])
    } catch (error) {
      console.error('Failed to fetch backups:', error)
    }
  }, [])

  useEffect(() => {
    fetchBackupStatus()
    fetchBackups()
  }, [fetchBackupStatus, fetchBackups])

  const handleCreateBackup = async () => {
    setCreatingBackup(true)
    try {
      const result = await backupApi.createBackup()
      if (result.success && result.backup) {
        toast({
          title: 'Backup Created',
          description: `Created ${result.backup.name} in ${result.duration?.toFixed(1)}s`,
          variant: 'success' as const,
        })
        await fetchBackups()
        await fetchBackupStatus()
      } else {
        throw new Error(result.message || 'Failed to create backup')
      }
    } catch (error) {
      toast({
        title: 'Backup Failed',
        description: error instanceof Error ? error.message : 'Failed to create backup',
        variant: 'destructive',
      })
    } finally {
      setCreatingBackup(false)
    }
  }

  const handleDeleteBackup = async (name: string) => {
    try {
      const result = await backupApi.deleteBackup(name)
      if (result.success) {
        toast({
          title: 'Backup Deleted',
          description: `Deleted ${name}`,
          variant: 'success' as const,
        })
        await fetchBackups()
      } else {
        throw new Error(result.message || 'Failed to delete backup')
      }
    } catch (error) {
      toast({
        title: 'Delete Failed',
        description: error instanceof Error ? error.message : 'Failed to delete backup',
        variant: 'destructive',
      })
    }
  }

  const handleRestoreBackup = async (name: string) => {
    setRestoringBackup(name)
    try {
      const result = await backupApi.restoreBackup(name, { createPreRestoreBackup: true })
      if (result.success) {
        toast({
          title: 'Backup Restored',
          description: `Restored ${name} in ${(result.duration || 0).toFixed(1)}s`,
          variant: 'success' as const,
        })
        await fetchBackups()
      } else {
        throw new Error(result.message || 'Failed to restore backup')
      }
    } catch (error) {
      toast({
        title: 'Restore Failed',
        description: error instanceof Error ? error.message : 'Failed to restore backup',
        variant: 'destructive',
      })
    } finally {
      setRestoringBackup(null)
      setRestoreConfirmBackup(null)
    }
  }

  // Basic cron validation helper
  const isValidCron = (cron: string): boolean => {
    const parts = cron.trim().split(/\s+/)
    if (parts.length !== 5) return false
    
    const patterns = [
      /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)*)$/, // minute
      /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)*)$/, // hour
      /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)*)$/, // day of month
      /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)*)$/, // month
      /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)*)$/, // day of week
    ]
    
    return parts.every((part, i) => patterns[i].test(part))
  }

  const handleSaveBackupSettings = async () => {
    // Validate cron expression before saving
    if (!isValidCron(backupSchedule)) {
      toast({
        title: 'Invalid Schedule',
        description: 'Please enter a valid cron expression (e.g., 0 */6 * * *)',
        variant: 'destructive',
      })
      return
    }
    
    setBackupLoading(true)
    try {
      await backupApi.updateSettings({
        enabled: backupStatus?.enabled || false,
        schedule: backupSchedule,
        maxBackups: backupMaxCount,
      })
      await fetchBackupStatus()
      toast({
        title: 'Backup Settings Saved',
        description: 'Backup schedule has been updated',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save backup settings',
        variant: 'destructive',
      })
    } finally {
      setBackupLoading(false)
    }
  }

  const toggleBackupEnabled = async (enabled: boolean) => {
    setBackupLoading(true)
    try {
      await backupApi.updateSettings({ enabled })
      await fetchBackupStatus()
      toast({
        title: enabled ? 'Scheduled Backups Enabled' : 'Scheduled Backups Disabled',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update backup settings',
        variant: 'destructive',
      })
    } finally {
      setBackupLoading(false)
    }
  }

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  }

  // Listen for real-time bridge status updates via Socket.IO
  // Use ref to avoid stale closure issues with fetchBridgeStatus
  const fetchBridgeStatusRef = useRef(fetchBridgeStatus)
  useEffect(() => {
    fetchBridgeStatusRef.current = fetchBridgeStatus
  }, [fetchBridgeStatus])

  useEffect(() => {
    if (!socket) return

    const handleBridgeStatus = (data: { isRunning: boolean; bridgePath: string }) => {
      setBridgeStatus(prev => prev ? { ...prev, isRunning: data.isRunning, bridgePath: data.bridgePath } : null)
      // Fetch full status to get all details
      fetchBridgeStatusRef.current()
    }

    const handleModStatus = (data: { alive: boolean; version?: string; serverName?: string; playerCount?: number; players?: string[] | Record<string, unknown>; path?: string; timestamp?: number }) => {
      setBridgeStatus(prev => {
        if (!prev) return null
        // Create a proper modStatus object, preserving previous values if new ones are missing
        const prevModStatus = prev.modStatus
        const newModStatus = {
          alive: data.alive,
          version: data.version || prevModStatus?.version || '',
          serverName: data.serverName || prevModStatus?.serverName || '',
          // When alive, use playerCount (defaulting to 0); when offline, leave undefined
          playerCount: data.alive ? (data.playerCount ?? 0) : undefined,
          players: Array.isArray(data.players) ? data.players : Object.keys(data.players || {}),
          path: data.path || prevModStatus?.path || '',
          timestamp: data.timestamp || Date.now()
        }
        return { 
          ...prev, 
          modConnected: data.alive,
          modStatus: newModStatus
        }
      })
    }

    const handleBridgeConfigured = (data: { bridgePath: string }) => {
      setBridgeStatus(prev => prev ? { ...prev, bridgePath: data.bridgePath, configured: true } : null)
      fetchBridgeStatusRef.current()
    }

    socket.on('panelBridge:status', handleBridgeStatus)
    socket.on('panelBridge:modStatus', handleModStatus)
    socket.on('panelBridge:configured', handleBridgeConfigured)

    return () => {
      socket.off('panelBridge:status', handleBridgeStatus)
      socket.off('panelBridge:modStatus', handleModStatus)
      socket.off('panelBridge:configured', handleBridgeConfigured)
    }
  }, [socket]) // Only depend on socket, use ref for fetchBridgeStatus

  // Auto-configure from active server settings (one-click setup)
  const handleAutoConfigure = async () => {
    setBridgeLoading(true)
    setBridgeError(null)
    try {
      const result = await panelBridgeApi.autoConfigure()
      if (result.success) {
        toast({
          title: 'Bridge Auto-Configured',
          description: `Connected to server: ${result.serverName}`,
          variant: 'success' as const,
        })
        await fetchBridgeStatus()
      } else {
        setBridgeError(result.error || 'Failed to auto-configure')
      }
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : 'Failed to auto-configure')
    } finally {
      setBridgeLoading(false)
    }
  }

  const handleStopBridge = async () => {
    setBridgeLoading(true)
    try {
      await panelBridgeApi.stop()
      toast({
        title: 'Bridge Stopped',
        description: 'Panel Bridge has been stopped',
        variant: 'success' as const,
      })
      await fetchBridgeStatus()
    } catch (error) {
      toast({
        title: 'Failed to Stop',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setBridgeLoading(false)
    }
  }

  const handlePingMod = async () => {
    try {
      const result = await panelBridgeApi.ping()
      if (result.success) {
        toast({
          title: 'Mod Connected!',
          description: `Connected to ${result.modStatus?.serverName || 'server'}`,
          variant: 'success' as const,
        })
      } else {
        toast({
          title: 'No Response',
          description: result.error || 'Mod did not respond',
          variant: 'destructive',
        })
      }
    } catch (error) {
      toast({
        title: 'Ping Failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    }
  }

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    // Validate numeric string fields
    if (typeof value === 'string' && ['modCheckInterval', 'modRestartDelay', 'reconnectInterval', 'panelPort'].includes(key)) {
      // Allow empty string but reject non-numeric values
      if (value !== '' && isNaN(parseInt(value))) {
        return // Don't update with invalid value
      }
    }
    setSettings(prev => ({ ...prev, [key]: value }))
  }

  if (loading && !originalSettings) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-8 page-transition">
      {/* Unsaved Changes Warning */}
      {isDirty && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 flex items-center gap-4 sticky top-0 z-10 shadow-lg shadow-amber-500/5">
          <div className="w-10 h-10 rounded-full bg-amber-500/15 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-amber-600 dark:text-amber-400">Unsaved Changes</p>
            <p className="text-sm text-muted-foreground">
              You have unsaved changes. Click "Save Settings" to apply them.
            </p>
          </div>
          <Button onClick={handleSave} disabled={saving} size="lg" className="gap-2">
            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
            Save Now
          </Button>
        </div>
      )}
      
      <PageHeader
        title="Settings"
        description="Configure the server management panel"
        icon={<Settings2 className="w-5 h-5" />}
        actions={
          <Button onClick={handleSave} disabled={saving || !isDirty} size="lg" className="w-full sm:w-auto gap-2">
            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
            {saving ? 'Saving...' : isDirty ? 'Save Settings' : 'Saved'}
          </Button>
        }
      />

      {/* Panel Settings */}
      <Card className="card-interactive">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
              <Globe className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <CardTitle className="text-lg">Panel Settings</CardTitle>
              <CardDescription className="mt-0.5">
                Configure how the control panel runs
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-xs">
            <Label>Panel Port</Label>
            <Input
              type="number"
              value={settings.panelPort}
              onChange={(e) => updateSetting('panelPort', e.target.value)}
              min="1024"
              max="65535"
              placeholder="3001"
            />
            <p className="text-xs text-muted-foreground mt-1">
              The port this panel listens on (default: 3001)
            </p>
          </div>
          {originalSettings && settings.panelPort !== originalSettings.panelPort && (
            <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
              <div className="text-sm">
                <p className="font-medium text-amber-600 dark:text-amber-400">Restart Required</p>
                <p className="text-muted-foreground mt-0.5">
                  Changing the port requires a panel restart to take effect. Save your settings first, then restart.
                </p>
              </div>
            </div>
          )}
          <div className="flex items-center gap-3">
            <Button 
              variant="outline" 
              onClick={async () => {
                setRestarting(true)
                try {
                  await serverApi.restartPanel()
                  toast({
                    title: 'Restarting Panel',
                    description: `Panel is restarting on port ${settings.panelPort}. Reconnecting...`,
                  })
                  // Wait then redirect to the (potentially new) port
                  setTimeout(() => {
                    const newPort = settings.panelPort || '3001'
                    const newUrl = `${window.location.protocol}//${window.location.hostname}:${newPort}${window.location.pathname}`
                    window.location.href = newUrl
                  }, 3000)
                } catch {
                  setRestarting(false)
                  toast({
                    title: 'Restart Failed',
                    description: 'Could not restart the panel. You may need to restart it manually.',
                    variant: 'destructive',
                  })
                }
              }}
              disabled={restarting || isDirty}
              className="gap-2"
            >
              {restarting ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCw className="w-4 h-4" />}
              {restarting ? 'Restarting...' : 'Restart Panel'}
            </Button>
            {isDirty && (
              <p className="text-xs text-muted-foreground">Save settings before restarting</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* RCON Settings */}
      <Card className="card-interactive">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Link className="w-5 h-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">RCON Connection</CardTitle>
              <CardDescription className="mt-0.5">
                RCON settings are configured per-server in the Servers page
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <Button variant="outline" onClick={handleTestRcon} disabled={testingRcon} className="w-full sm:w-auto">
              {testingRcon ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Test Connection
            </Button>
            <div className="flex items-center gap-2">
              <Switch
                checked={settings.autoReconnect}
                onCheckedChange={(value) => updateSetting('autoReconnect', value)}
              />
              <Label>Auto-reconnect on disconnect</Label>
            </div>
          </div>
          {settings.autoReconnect && (
            <div className="max-w-xs">
              <Label>Reconnect Interval (seconds)</Label>
              <Input
                type="number"
                value={settings.reconnectInterval}
                onChange={(e) => updateSetting('reconnectInterval', e.target.value)}
                min="1"
                max="60"
              />
            </div>
          )}
          <div className="p-4 bg-muted rounded-lg text-sm">
            <p className="font-medium mb-2">RCON is configured per-server:</p>
            <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
              <li>Go to <strong>Servers</strong> page</li>
              <li>Click <strong>Edit</strong> on your server</li>
              <li>Configure RCON host, port, and password there</li>
            </ol>
          </div>
        </CardContent>
      </Card>

      {/* Panel Bridge - Advanced Features */}
      <Card className="card-interactive">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center">
              <Zap className="w-5 h-5 text-purple-500" />
            </div>
            <div className="flex-1">
              <CardTitle className="text-lg">Panel Bridge</CardTitle>
              <CardDescription className="mt-0.5">
                Enables weather control and advanced features
              </CardDescription>
            </div>
            {bridgeStatus && (
              <div className="flex items-center gap-2">
                {bridgeStatus.modConnected ? (
                  <div className="flex items-center gap-2 text-emerald-500">
                    <CheckCircle2 className="w-5 h-5" />
                    <span className="text-sm font-medium">Connected</span>
                  </div>
                ) : bridgeStatus.isRunning ? (
                  <div className="flex items-center gap-2 text-amber-500">
                    <Cloud className="w-5 h-5" />
                    <span className="text-sm font-medium">Waiting for mod...</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <XCircle className="w-5 h-5" />
                    <span className="text-sm font-medium">Not running</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Status Display - when connected */}
          {bridgeStatus?.modConnected && bridgeStatus.modStatus && (
            <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
              <div className="flex items-center gap-3 mb-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  Connected to {bridgeStatus.modStatus.serverName || 'server'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Mod Version:</span>{' '}
                  <span className="font-medium">{bridgeStatus.modStatus.version || 'Unknown'}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Players Online:</span>{' '}
                  <span className="font-medium">{bridgeStatus.modStatus.alive ? (bridgeStatus.modStatus.playerCount ?? 0) : 'Offline'}</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Weather controls are now available on the Events page!
              </p>
            </div>
          )}

          {/* Not running - show auto-setup button */}
          {!bridgeStatus?.isRunning && (
            <div className="p-4 bg-muted rounded-xl space-y-4">
              <p className="text-sm text-muted-foreground">
                Panel Bridge connects your panel to the game server for advanced features like weather control.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button 
                  onClick={() => handleAutoConfigure()} 
                  disabled={bridgeLoading}
                  className="gap-2"
                >
                  {bridgeLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                  Auto Setup
                </Button>
                <p className="text-xs text-muted-foreground self-center">
                  Automatically configures and starts the bridge for your active server
                </p>
              </div>
            </div>
          )}

          {/* Waiting for mod */}
          {bridgeStatus?.isRunning && !bridgeStatus?.modConnected && (
            <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl space-y-3">
              <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-medium">
                <Cloud className="w-4 h-4" />
                Waiting for PZ mod to respond...
              </div>
              <p className="text-sm text-muted-foreground">
                Make sure your PZ server is running. The bridge will connect automatically when the mod starts.
              </p>
              {bridgeStatus?.bridgePath && (
                <p className="text-xs text-muted-foreground">
                  Watching: <code className="bg-background px-1 rounded">{bridgeStatus.bridgePath}</code>
                </p>
              )}
            </div>
          )}

          {/* Error display */}
          {bridgeError && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-600 dark:text-red-400 text-sm">
              {bridgeError}
            </div>
          )}

          {/* Control buttons when running */}
          {bridgeStatus?.isRunning && (
            <div className="flex flex-wrap gap-3">
              <Button 
                onClick={handleStopBridge} 
                disabled={bridgeLoading}
                variant="outline"
                size="sm"
                className="gap-2"
              >
                {bridgeLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                Stop
              </Button>
              <Button 
                onClick={handlePingMod}
                variant="outline"
                size="sm"
                className="gap-2"
                disabled={!bridgeStatus?.modConnected}
              >
                <RefreshCw className="w-4 h-4" />
                Test
              </Button>
              <Button 
                onClick={fetchBridgeStatus}
                variant="ghost"
                size="sm"
                className="gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                Refresh
              </Button>
            </div>
          )}

          {/* Info box */}
          <div className="p-4 bg-purple-500/10 border border-purple-500/20 rounded-lg text-sm">
            <p className="font-medium text-purple-600 dark:text-purple-400 mb-2">
              How it works
            </p>
            <ul className="list-disc list-inside space-y-1 text-muted-foreground">
              <li>Install PanelBridge.lua to your server using the button below</li>
              <li>The bridge auto-connects when you start your PZ server</li>
              <li>Enables weather control, real-time monitoring, and more</li>
            </ul>
          </div>
          
          {/* Install Mod Section */}
          <div className="p-4 bg-muted rounded-xl space-y-3">
            <p className="text-sm font-medium">Install PanelBridge.lua</p>
            <div className="flex flex-wrap gap-3 items-center">
              <Select value={selectedInstallServerId} onValueChange={setSelectedInstallServerId}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Select server..." />
                </SelectTrigger>
                <SelectContent>
                  {servers.map((server) => (
                    <SelectItem key={String(server.id)} value={String(server.id)}>
                      {server.name} {server.isActive ? '(Active)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                onClick={handleInstallMod}
                disabled={installingMod || !selectedInstallServerId}
                className="gap-2"
                variant="outline"
              >
                {installingMod ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                Install Mod
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Copies PanelBridge.lua to <code className="bg-background px-1 rounded">media/lua/server/</code> in the selected server's install folder
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Mod Update Settings */}
      <Card className="card-interactive">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
              <Clock className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <CardTitle className="text-lg">Mod Update Settings</CardTitle>
              <CardDescription className="mt-0.5">
                Configure automatic mod update checking and server restarts
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="max-w-xs space-y-2">
            <Label className="text-base">Check Interval (minutes)</Label>
            <Input
              type="number"
              value={settings.modCheckInterval}
              onChange={(e) => updateSetting('modCheckInterval', e.target.value)}
              min="5"
              max="120"
              className="h-11"
            />
            <p className="text-sm text-muted-foreground">
              How often to check Steam Workshop for mod updates
            </p>
          </div>
          <div className="flex items-center gap-3 p-4 rounded-xl bg-muted/50">
            <Switch
              checked={settings.modAutoRestart}
              onCheckedChange={(value) => updateSetting('modAutoRestart', value)}
            />
            <div>
              <Label className="text-base">Auto-restart server when mods update</Label>
              <p className="text-sm text-muted-foreground">Automatically restart the server when mod updates are detected</p>
            </div>
          </div>
          {settings.modAutoRestart && (
            <div className="max-w-xs space-y-2 pl-4 border-l-2 border-primary/30">
              <Label className="text-base">Restart Delay (minutes)</Label>
              <Input
                type="number"
                value={settings.modRestartDelay}
                onChange={(e) => updateSetting('modRestartDelay', e.target.value)}
                min="1"
                max="30"
                className="h-11"
              />
              <p className="text-sm text-muted-foreground">
                Warning time before restart (players will be notified)
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* API Keys */}
      <Card className="card-interactive">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center">
              <Key className="w-5 h-5 text-violet-400" />
            </div>
            <div>
              <CardTitle className="text-lg">API Keys</CardTitle>
              <CardDescription className="mt-0.5">
                Configure API keys for external services
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label className="text-base">Steam Web API Key</Label>
            <div className="relative max-w-md">
              <Input
                type={showSteamApiKey ? 'text' : 'password'}
                value={settings.steamApiKey}
                onChange={(e) => updateSetting('steamApiKey', e.target.value)}
                placeholder="Your Steam API key"
                className="h-11 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowSteamApiKey(!showSteamApiKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showSteamApiKey ? 'Hide API key' : 'Show API key'}
              >
                {showSteamApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-sm text-muted-foreground">
              Used for Steam Workshop mod information and server finder features.
            </p>
            <div className="p-4 bg-muted rounded-lg text-sm mt-3">
              <p className="font-medium mb-2">How to get a Steam API Key:</p>
              <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                <li>Go to <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Steam API Key Registration</a></li>
                <li>Log in with your Steam account</li>
                <li>Enter a domain name (can be "localhost" for personal use)</li>
                <li>Copy the key and paste it here</li>
              </ol>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* World Backups */}
      <Card className="card-interactive">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/10 flex items-center justify-center">
              <Archive className="w-5 h-5 text-cyan-500" />
            </div>
            <div className="flex-1">
              <CardTitle className="text-lg">World Backups</CardTitle>
              <CardDescription className="mt-0.5">
                Backup your server world data on a schedule
              </CardDescription>
            </div>
            <Button 
              onClick={handleCreateBackup} 
              disabled={creatingBackup || !backupStatus?.savesExists}
              className="gap-2"
            >
              {creatingBackup ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Archive className="w-4 h-4" />
              )}
              {creatingBackup ? 'Creating...' : 'Backup Now'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Status */}
          {backupStatus && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm">
                  {backupStatus.savesExists ? (
                    <span className="text-emerald-500">Saves folder found</span>
                  ) : (
                    <span className="text-red-400">Saves folder not found</span>
                  )}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Archive className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm">{backupStatus.backupCount} backup{backupStatus.backupCount !== 1 ? 's' : ''} stored</span>
              </div>
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm">
                  {backupStatus.lastBackup ? (
                    `Last: ${new Date(backupStatus.lastBackup.created).toLocaleString()}`
                  ) : (
                    'No backups yet'
                  )}
                </span>
              </div>
            </div>
          )}

          {/* Scheduled Backups */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-base">Scheduled Backups</Label>
                <p className="text-sm text-muted-foreground">
                  Automatically backup your world on a schedule
                </p>
              </div>
              <Switch
                checked={backupStatus?.enabled || false}
                onCheckedChange={toggleBackupEnabled}
                disabled={backupLoading}
              />
            </div>

            {backupStatus?.enabled && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pl-4 border-l-2 border-cyan-500/30">
                <div className="space-y-2">
                  <Label htmlFor="backup-schedule">Schedule (Cron)</Label>
                  <Input
                    id="backup-schedule"
                    value={backupSchedule}
                    onChange={(e) => setBackupSchedule(e.target.value)}
                    placeholder="0 */6 * * *"
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    Default: Every 6 hours. Format: minute hour day month weekday
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="backup-max">Max Backups to Keep</Label>
                  <Input
                    id="backup-max"
                    type="number"
                    min={1}
                    max={100}
                    value={backupMaxCount}
                    onChange={(e) => setBackupMaxCount(parseInt(e.target.value) || 10)}
                    className="max-w-24"
                  />
                  <p className="text-xs text-muted-foreground">
                    Oldest backups will be deleted when limit is reached
                  </p>
                </div>
                <div className="sm:col-span-2">
                  <Button 
                    onClick={handleSaveBackupSettings} 
                    disabled={backupLoading}
                    variant="outline"
                    size="sm"
                  >
                    {backupLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    Save Schedule Settings
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Backup List */}
          {backups.length > 0 && (
            <div className="space-y-2">
              <Label className="text-base">Existing Backups</Label>
              <ScrollArea className="h-[200px] rounded-lg border">
                <div className="p-2 space-y-2">
                  {backups.map((backup) => (
                    <div
                      key={backup.name}
                      className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <Archive className="w-4 h-4 text-cyan-500 flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{backup.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatBytes(backup.size)} • {new Date(backup.created).toLocaleString()}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <AlertDialog open={restoreConfirmBackup === backup.name} onOpenChange={(open) => !open && setRestoreConfirmBackup(null)}>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setRestoreConfirmBackup(backup.name)}
                              disabled={restoringBackup !== null}
                              className="text-amber-400 hover:text-amber-500 hover:bg-amber-500/10"
                              title="Restore this backup (server must be stopped)"
                            >
                              {restoringBackup === backup.name ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <RotateCcw className="w-4 h-4" />
                              )}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle className="flex items-center gap-2">
                                <AlertTriangle className="w-5 h-5 text-amber-500" />
                                Restore Backup
                              </AlertDialogTitle>
                              <AlertDialogDescription className="text-left space-y-2">
                                <p>This will restore <strong>{backup.name}</strong> and <strong>OVERWRITE</strong> the current world data.</p>
                                <ul className="list-disc list-inside text-sm space-y-1">
                                  <li>Server must be <strong>STOPPED</strong></li>
                                  <li>A pre-restore backup will be created</li>
                                  <li>This cannot be undone</li>
                                </ul>
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleRestoreBackup(backup.name)}
                                className="bg-amber-600 text-white hover:bg-amber-700"
                              >
                                Restore Backup
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                        <Button
                          variant="ghost"
                          size="sm"
                          asChild
                        >
                          <a href={backupApi.getDownloadUrl(backup.name)} download>
                            <Download className="w-4 h-4" />
                          </a>
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-red-400 hover:text-red-500 hover:bg-red-500/10"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete Backup</AlertDialogTitle>
                              <AlertDialogDescription>
                                Are you sure you want to delete "{backup.name}"? This action cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleDeleteBackup(backup.name)}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              >
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}

          {/* Path Info */}
          {backupStatus?.savesPath && (
            <div className="text-xs text-muted-foreground space-y-1">
              <p><strong>Saves:</strong> {backupStatus.savesPath}</p>
              <p><strong>Backups:</strong> {backupStatus.backupsPath}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Security Note */}
      <Card className="card-interactive">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center">
              <Shield className="w-5 h-5 text-red-400" />
            </div>
            <CardTitle className="text-lg">Security Information</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">Local Access Only:</strong> This panel is designed 
            for local use on the same machine as your server. Do not expose it to the internet 
            without proper security measures.
          </p>
          <p>
            <strong className="text-foreground">RCON Security:</strong> Your RCON password is 
            stored locally and is never transmitted outside of the RCON connection to your server.
          </p>
          <p>
            <strong className="text-foreground">Admin Commands:</strong> Be careful with admin 
            commands. Some actions like banning or kicking players cannot be easily undone.
          </p>
        </CardContent>
      </Card>

      {/* About */}
      <Card className="card-interactive">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
              <Server className="w-5 h-5 text-emerald-500" />
            </div>
            <CardTitle className="text-lg">About PZ Server Panel</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-muted-foreground">
            A web-based management panel for Project Zomboid dedicated servers.
          </p>
          <p className="text-muted-foreground">
            Features include RCON integration, player management, mod update detection, 
            scheduled restarts, and more.
          </p>
          <div className="mt-6 pt-4 border-t flex items-center gap-4">
            <span className="text-sm text-muted-foreground">
              Built with React, Node.js, and Socket.IO
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
