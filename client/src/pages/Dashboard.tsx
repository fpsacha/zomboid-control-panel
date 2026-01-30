import { useEffect, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { 
  Play, 
  Square, 
  RotateCcw, 
  Save, 
  Users,
  Server,
  Wifi,
  WifiOff,
  Loader2,
  AlertTriangle,
  RefreshCw,
  AlertCircle,
  Link2,
  Link2Off,
  LogIn,
  LogOut,
  Activity,
  Archive,
  TrendingUp,
  Skull,
  Sword,
  ShieldAlert,
  Clock
} from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip as RTooltip } from 'recharts'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { serverApi, rconApi, playersApi, panelBridgeApi, backupApi, configApi } from '@/lib/api'
import { formatUptime } from '@/lib/utils'
import { useSocket } from '@/contexts/SocketContext'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

interface PlayerActivity {
  id: number
  player_name: string
  action: string
  details: string | null
  logged_at: string
}

interface BridgeStatus {
  configured: boolean
  isRunning: boolean
  modConnected: boolean
  modStatus: {
    alive: boolean
    version?: string
    serverName?: string
    playerCount?: number
  } | null
}

interface ServerStatus {
  running: boolean
  startTime: string | null
  uptime: number
  serverPath: string
  configured: boolean
  rcon: {
    host: string
    port: number
    connected: boolean
  }
}

interface Player {
  name: string
  online: boolean
}

interface PerformancePoint {
  time: string
  playerCount: number
  memoryMB: number
}

export default function Dashboard() {
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [players, setPlayers] = useState<Player[]>([])
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null)
  const [playerActivity, setPlayerActivity] = useState<PlayerActivity[]>([])
  const [performanceHistory, setPerformanceHistory] = useState<PerformancePoint[]>([])
  const [loading, setLoading] = useState<string | null>(null)
  const [initialLoading, setInitialLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [autoStartServer, setAutoStartServer] = useState<boolean>(false)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [confirmAction, setConfirmAction] = useState<{
    title: string
    description: string
    action: () => Promise<unknown>
    variant?: 'destructive' | 'warning'
  } | null>(null)
  const { toast } = useToast()
  const socket = useSocket()

  const fetchStatus = useCallback(async () => {
    try {
      const data = await serverApi.getStatus()
      setStatus(data)
      setFetchError(null)
      setLastUpdated(new Date())
    } catch (error) {
      console.error('Failed to fetch status:', error)
      setFetchError('Failed to connect to server')
    }
  }, [])

  const fetchPlayers = useCallback(async () => {
    try {
      const data = await playersApi.getPlayers()
      if (data.players) {
        setPlayers(data.players)
      }
    } catch (error) {
      console.error('Failed to fetch players:', error)
    }
  }, [])

  const fetchBridgeStatus = useCallback(async () => {
    try {
      const data = await panelBridgeApi.getStatus()
      setBridgeStatus(data)
    } catch (error) {
      console.error('Failed to fetch bridge status:', error)
    }
  }, [])

  const fetchPlayerActivity = useCallback(async () => {
    try {
      const data = await playersApi.getActivityLogs(undefined, 15)
      if (data.logs) {
        // Show all event types for timeline
        setPlayerActivity(data.logs.slice(0, 10))
      }
    } catch (error) {
      console.error('Failed to fetch player activity:', error)
    }
  }, [])

  const fetchPerformanceHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/debug/performance-history?limit=30')
      const data = await res.json()
      if (data.history) {
        setPerformanceHistory(data.history.map((h: { timestamp: string; playerCount: number; memoryUsed: number }) => ({
          time: new Date(h.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
          playerCount: h.playerCount || 0,
          memoryMB: Math.round((h.memoryUsed || 0) / (1024 * 1024))
        })))
      }
    } catch {
      // Endpoint may not exist yet
    }
  }, [])

  const fetchAutoStartSetting = useCallback(async () => {
    try {
      const response = await configApi.getAppSettings()
      if (response?.settings?.autoStartServer !== undefined) {
        setAutoStartServer(response.settings.autoStartServer === true || response.settings.autoStartServer === 'true')
      }
    } catch {
      // Setting may not exist yet
    }
  }, [])

  const handleAutoStartChange = async (checked: boolean) => {
    setAutoStartServer(checked)
    try {
      await configApi.updateAppSettings({ autoStartServer: String(checked) })
      toast({
        title: checked ? 'Auto-start enabled' : 'Auto-start disabled',
        description: checked 
          ? 'Server will start automatically when the panel launches' 
          : 'Server will not start automatically',
      })
    } catch {
      // Revert on error
      setAutoStartServer(!checked)
      toast({
        title: 'Error',
        description: 'Failed to save auto-start setting',
        variant: 'destructive',
      })
    }
  }

  useEffect(() => {
    const loadInitialData = async () => {
      try {
        await Promise.all([fetchStatus(), fetchPlayers(), fetchBridgeStatus(), fetchPlayerActivity(), fetchPerformanceHistory(), fetchAutoStartSetting()])
      } catch (error) {
        console.error('Failed to load initial data:', error)
      } finally {
        setInitialLoading(false)
      }
    }
    loadInitialData()
    
    // Safety timeout to force exit loading state after 10 seconds
    const loadingTimeout = setTimeout(() => {
      if (initialLoading) {
        console.warn('Loading timeout reached, forcing exit from loading state')
        setInitialLoading(false)
      }
    }, 10000)
    
    const interval = setInterval(() => {
      fetchStatus()
      fetchPlayers()
      fetchBridgeStatus()
      fetchPlayerActivity()
      fetchPerformanceHistory()
    }, 10000)

    return () => {
      clearTimeout(loadingTimeout)
      clearInterval(interval)
      // Also clean up the poll interval on unmount
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [fetchStatus, fetchPlayers, fetchBridgeStatus, fetchPlayerActivity, fetchPerformanceHistory])

  useEffect(() => {
    if (socket) {
      const handleServerStatus = (data: Partial<ServerStatus>) => {
        // Safely merge data - only set if we have minimum required fields or existing state
        setStatus(prev => {
          if (prev) {
            return { ...prev, ...data }
          }
          // Only set initial state if data has required fields
          if ('running' in data && 'configured' in data) {
            return data as ServerStatus
          }
          return prev
        })
      }

      const handlePlayersUpdate = (data: Player[]) => {
        setPlayers(data)
      }

      const handleActiveServerChanged = () => {
        fetchStatus()
        fetchPlayers()
        fetchBridgeStatus()
      }

      const handleBridgeModStatus = (data: { alive: boolean; version?: string; serverName?: string; playerCount?: number }) => {
        setBridgeStatus(prev => ({
          configured: prev?.configured ?? true,
          isRunning: prev?.isRunning ?? true,
          modConnected: data.alive,
          modStatus: {
            alive: data.alive,
            version: data.version || prev?.modStatus?.version,
            serverName: data.serverName || prev?.modStatus?.serverName,
            playerCount: data.playerCount ?? 0
          }
        }))
      }

      socket.on('server:status', handleServerStatus)
      socket.on('players:update', handlePlayersUpdate)
      socket.on('activeServerChanged', handleActiveServerChanged)
      socket.on('panelBridge:modStatus', handleBridgeModStatus)

      return () => {
        socket.off('server:status', handleServerStatus)
        socket.off('players:update', handlePlayersUpdate)
        socket.off('activeServerChanged', handleActiveServerChanged)
        socket.off('panelBridge:modStatus', handleBridgeModStatus)
      }
    }
  }, [socket, fetchStatus, fetchPlayers, fetchBridgeStatus, fetchPlayerActivity, fetchPerformanceHistory])

  // Refetch data when page becomes visible (important for mobile background/foreground)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Page became visible, refetch data
        fetchStatus()
        fetchPlayers()
        fetchBridgeStatus()
        fetchPlayerActivity()
        fetchPerformanceHistory()
      }
    }
    
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [fetchStatus, fetchPlayers, fetchBridgeStatus, fetchPlayerActivity, fetchPerformanceHistory])

  const handleAction = async (action: string, fn: () => Promise<unknown>) => {
    setLoading(action)
    try {
      await fn()
      toast({
        title: 'Success',
        description: `${action} completed successfully`,
        variant: 'success' as const,
      })
      
      // After starting server, poll more frequently to detect when it's running
      if (action === 'Start server') {
        // Clear any existing poll interval
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current)
        }
        
        let attempts = 0
        pollIntervalRef.current = setInterval(async () => {
          attempts++
          try {
            const data = await serverApi.getStatus()
            setStatus(data)
            if (data?.running || attempts >= 15) {
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current)
                pollIntervalRef.current = null
              }
            }
          } catch {
            // Continue polling on error
            if (attempts >= 15 && pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current)
              pollIntervalRef.current = null
            }
          }
        }, 2000)
      } else {
        fetchStatus()
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Action failed',
        variant: 'destructive',
      })
    } finally {
      setLoading(null)
    }
  }

  const handleConnect = async () => {
    await handleAction('Connect RCON', () => rconApi.connect())
  }

  if (initialLoading) {
    return (
      <div className="space-y-8 page-transition">
        <div className="space-y-1">
          <h1 className="text-4xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-lg text-muted-foreground">Monitor and control your Project Zomboid server</p>
        </div>
        <div className="flex items-center justify-center py-24">
          <div className="flex flex-col items-center gap-4">
            <div className="relative">
              <div className="absolute inset-0 bg-primary/20 rounded-full blur-xl" />
              <RefreshCw className="relative w-10 h-10 animate-spin text-primary" />
            </div>
            <p className="text-muted-foreground font-medium">Loading server status...</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8 page-transition">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-4xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-lg text-muted-foreground">Monitor and control your Project Zomboid server</p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-muted-foreground">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={fetchStatus} disabled={loading !== null}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Error Banner */}
      {fetchError && (
        <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-xl p-4 flex items-center gap-4 shadow-lg shadow-destructive/5">
          <div className="w-10 h-10 rounded-full bg-destructive/15 flex items-center justify-center flex-shrink-0">
            <AlertCircle className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <p className="font-semibold">Connection Error</p>
            <p className="text-sm opacity-80">{fetchError}. Some features may be unavailable.</p>
          </div>
          <Button variant="outline" size="sm" onClick={fetchStatus} className="flex-shrink-0">
            <RefreshCw className="w-4 h-4 mr-2" />
            Retry
          </Button>
        </div>
      )}

      {/* Not Configured Warning */}
      {status && !status.configured && (
        <Link to="/server-setup" className="block">
          <div className="bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 rounded-xl p-4 flex items-center gap-4 shadow-lg shadow-amber-500/5 hover:bg-amber-500/15 transition-colors cursor-pointer">
            <div className="w-10 h-10 rounded-full bg-amber-500/15 flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <p className="font-semibold">Server Not Configured</p>
              <p className="text-sm opacity-80">Click here to go to Server Setup and add or configure a server.</p>
            </div>
          </div>
        </Link>
      )}

      {/* Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {/* Server Status */}
        <Card className="card-interactive overflow-hidden">
          <div className={`h-1.5 ${status?.running ? 'bg-gradient-to-r from-emerald-500 to-emerald-400' : 'bg-gradient-to-r from-red-500 to-red-400'}`} />
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Server className="w-4 h-4" />
              Server Status
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex items-center gap-4">
              <div className="relative">
                <div className={`w-4 h-4 rounded-full ${status?.running ? 'status-online' : 'status-offline'}`} />
              </div>
              <div>
                <span className="text-3xl font-bold tracking-tight">
                  {status?.running ? 'Online' : 'Offline'}
                </span>
                {status?.running && status.uptime > 0 && (
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Uptime: {formatUptime(status.uptime)}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* RCON Status */}
        <Card className="card-interactive overflow-hidden">
          <div className={`h-1.5 ${status?.rcon?.connected ? 'bg-gradient-to-r from-emerald-500 to-emerald-400' : 'bg-gradient-to-r from-red-500 to-red-400'}`} />
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              {status?.rcon?.connected ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
              RCON
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex items-center gap-4">
              <div className="relative">
                <div className={`w-4 h-4 rounded-full ${status?.rcon?.connected ? 'status-online' : 'status-offline'}`} />
              </div>
              <div>
                <span className="text-3xl font-bold tracking-tight">
                  {status?.rcon?.connected ? 'Connected' : 'Offline'}
                </span>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {status?.rcon?.host}:{status?.rcon?.port}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Panel Bridge Status */}
        <Card className="card-interactive overflow-hidden">
          <div className={`h-1.5 ${bridgeStatus?.modConnected ? 'bg-gradient-to-r from-emerald-500 to-emerald-400' : bridgeStatus?.configured ? 'bg-gradient-to-r from-amber-500 to-amber-400' : 'bg-gradient-to-r from-gray-400 to-gray-300'}`} />
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              {bridgeStatus?.modConnected ? <Link2 className="w-4 h-4" /> : <Link2Off className="w-4 h-4" />}
              Panel Bridge
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex items-center gap-4">
              <div className="relative">
                <div className={`w-4 h-4 rounded-full ${bridgeStatus?.modConnected ? 'status-online' : 'status-offline'}`} />
              </div>
              <div>
                <span className="text-3xl font-bold tracking-tight">
                  {bridgeStatus?.modConnected ? 'Connected' : bridgeStatus?.configured ? 'Waiting' : 'Not Set'}
                </span>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {bridgeStatus?.modConnected 
                    ? (bridgeStatus.modStatus?.version ? `v${bridgeStatus.modStatus.version}` : bridgeStatus.modStatus?.serverName || 'Active')
                    : bridgeStatus?.configured 
                      ? 'Waiting for server...' 
                      : <Link to="/settings" className="text-primary hover:underline">Configure →</Link>}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Players */}
        <Card className="card-interactive overflow-hidden">
          <div className="h-1.5 bg-gradient-to-r from-primary to-primary/70" />
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Users className="w-4 h-4" />
              Players
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                <Users className="w-6 h-6 text-primary" />
              </div>
              <div>
                <span className="text-3xl font-bold tracking-tight">{players.length}</span>
                {players.length > 0 && (
                  <p className="text-sm text-muted-foreground mt-0.5 max-w-[180px] truncate">
                    {players.slice(0, 3).map(p => p.name).join(', ')}
                    {players.length > 3 && ` +${players.length - 3} more`}
                  </p>
                )}
                {players.length === 0 && (
                  <p className="text-sm text-muted-foreground mt-0.5">No players online</p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Server Controls */}
      <Card className="card-interactive">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Server className="w-5 h-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">Server Controls</CardTitle>
              <CardDescription className="mt-0.5">Start, stop, and manage your server</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={() => handleAction('Start server', serverApi.start)}
              disabled={status?.running || loading !== null}
              variant="success"
              size="lg"
              className="gap-2"
            >
              {loading === 'Start server' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5" />}
              Start Server
            </Button>
            <Button
              onClick={() => setConfirmAction({
                title: 'Stop Server',
                description: 'Are you sure you want to stop the server? All connected players will be disconnected.',
                action: serverApi.stop,
                variant: 'destructive'
              })}
              disabled={!status?.running || loading !== null}
              variant="destructive"
              size="lg"
              className="gap-2"
            >
              {loading === 'Stop server' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Square className="w-5 h-5" />}
              Stop Server
            </Button>
            <Button
              onClick={() => setConfirmAction({
                title: 'Restart Server',
                description: 'This will send a 5-minute warning to all players, then restart the server.',
                action: () => serverApi.restart(5),
                variant: 'warning'
              })}
              disabled={!status?.running || loading !== null}
              variant="warning"
              size="lg"
              className="gap-2"
            >
              <RotateCcw className="w-5 h-5" />
              Restart (5min warning)
            </Button>
            <Button
              onClick={() => setConfirmAction({
                title: 'Restart Server Now',
                description: 'This will immediately restart the server without warning. All players will be disconnected!',
                action: () => serverApi.restart(0),
                variant: 'destructive'
              })}
              disabled={!status?.running || loading !== null}
              variant="destructive"
              size="lg"
              className="gap-2"
            >
              <RotateCcw className="w-5 h-5" />
              Restart Now
            </Button>
            <div className="flex-1 min-w-[200px]" />
            <Button
              onClick={() => handleAction('Save world', serverApi.save)}
              disabled={!status?.running || loading !== null}
              variant="secondary"
              size="lg"
              className="gap-2"
            >
              <Save className="w-5 h-5" />
              Save World
            </Button>
            <Button
              onClick={() => handleAction('Create backup', () => backupApi.createBackup({ includeDb: true }))}
              disabled={loading !== null}
              variant="outline"
              size="lg"
              className="gap-2"
            >
              <Archive className="w-5 h-5" />
              Backup Now
            </Button>
            {!status?.rcon?.connected && (
              <Button
                onClick={handleConnect}
                disabled={loading !== null}
                variant="outline"
                size="lg"
                className="gap-2"
              >
                <Wifi className="w-5 h-5" />
                Connect RCON
              </Button>
            )}
          </div>
          
          {/* Auto-start setting */}
          <div className="flex items-center gap-3 mt-4 pt-4 border-t border-border">
            <Checkbox 
              id="autoStartServer" 
              checked={autoStartServer}
              onCheckedChange={(checked) => handleAutoStartChange(checked === true)}
            />
            <Label htmlFor="autoStartServer" className="text-sm text-muted-foreground cursor-pointer">
              Auto-start server when panel launches
            </Label>
          </div>
        </CardContent>
      </Card>

      {/* Performance Charts */}
      {performanceHistory.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Player Count Chart */}
          <Card className="card-interactive">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <Users className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-lg">Player Count</CardTitle>
                  <CardDescription className="mt-0.5">Last 30 snapshots</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={150}>
                <LineChart data={performanceHistory}>
                  <XAxis dataKey="time" stroke="#888" fontSize={10} tickLine={false} axisLine={false} />
                  <YAxis stroke="#888" fontSize={10} tickLine={false} axisLine={false} width={30} />
                  <RTooltip />
                  <Line 
                    type="monotone" 
                    dataKey="playerCount" 
                    stroke="#22c55e" 
                    strokeWidth={2}
                    dot={false}
                    name="Players"
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Memory Usage Chart */}
          <Card className="card-interactive">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
                  <TrendingUp className="w-5 h-5 text-blue-500" />
                </div>
                <div>
                  <CardTitle className="text-lg">Memory Usage</CardTitle>
                  <CardDescription className="mt-0.5">Server memory (MB)</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={150}>
                <LineChart data={performanceHistory}>
                  <XAxis dataKey="time" stroke="#888" fontSize={10} tickLine={false} axisLine={false} />
                  <YAxis stroke="#888" fontSize={10} tickLine={false} axisLine={false} width={40} unit=" MB" />
                  <RTooltip />
                  <Line 
                    type="monotone" 
                    dataKey="memoryMB" 
                    stroke="#3b82f6" 
                    strokeWidth={2}
                    dot={false}
                    name="Memory"
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Events Timeline */}
      <Card className="card-interactive">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Clock className="w-5 h-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">Events Timeline</CardTitle>
              <CardDescription className="mt-0.5">Recent server and player events</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {playerActivity.length === 0 ? (
            <p className="text-muted-foreground text-sm">No recent events</p>
          ) : (
            <div className="space-y-2">
              {playerActivity.map((activity) => {
                // Define icon and colors based on action type
                const getEventStyle = (action: string) => {
                  switch (action) {
                    case 'connect':
                      return { icon: <LogIn className="w-4 h-4" />, bg: 'bg-emerald-500/15', text: 'text-emerald-500', label: 'joined' }
                    case 'disconnect':
                      return { icon: <LogOut className="w-4 h-4" />, bg: 'bg-red-500/15', text: 'text-red-500', label: 'left' }
                    case 'death':
                      return { icon: <Skull className="w-4 h-4" />, bg: 'bg-purple-500/15', text: 'text-purple-500', label: 'died' }
                    case 'pvp_kill':
                      return { icon: <Sword className="w-4 h-4" />, bg: 'bg-orange-500/15', text: 'text-orange-500', label: 'killed' }
                    case 'ban':
                      return { icon: <ShieldAlert className="w-4 h-4" />, bg: 'bg-red-500/15', text: 'text-red-500', label: 'was banned' }
                    case 'kick':
                      return { icon: <AlertCircle className="w-4 h-4" />, bg: 'bg-amber-500/15', text: 'text-amber-500', label: 'was kicked' }
                    default:
                      return { icon: <Activity className="w-4 h-4" />, bg: 'bg-blue-500/15', text: 'text-blue-500', label: action }
                  }
                }
                const style = getEventStyle(activity.action)
                
                return (
                  <div 
                    key={activity.id} 
                    className="flex items-center gap-3 py-2 px-3 rounded-lg bg-muted/30"
                  >
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center ${style.bg} ${style.text}`}>
                      {style.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="font-medium">{activity.player_name}</span>
                      <span className="text-muted-foreground ml-2">{style.label}</span>
                      {activity.details && (
                        <span className="text-muted-foreground ml-1 text-sm">({activity.details})</span>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(activity.logged_at).toLocaleString()}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Confirmation Dialog */}
      <AlertDialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <AlertDialogContent className="glass border-border/50">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-3 text-xl">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${confirmAction?.variant === 'destructive' ? 'bg-red-500/15' : 'bg-amber-500/15'}`}>
                <AlertTriangle className={`w-5 h-5 ${confirmAction?.variant === 'destructive' ? 'text-red-500' : 'text-amber-500'}`} />
              </div>
              {confirmAction?.title}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-base pl-[52px]">
              {confirmAction?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-2">
            <AlertDialogCancel className="mt-0">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={confirmAction?.variant === 'destructive' ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-600 hover:bg-amber-700'}
              onClick={async () => {
                if (confirmAction) {
                  await handleAction(confirmAction.title, confirmAction.action)
                  setConfirmAction(null)
                }
              }}
            >
              {confirmAction?.title}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
