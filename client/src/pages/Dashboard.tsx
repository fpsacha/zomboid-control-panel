import { lazy, Suspense, useEffect, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { usePageShortcut } from '../hooks/useKeyboardShortcuts'
import {
  Play, Square, RotateCcw, Save, Server, Wifi, Loader2, AlertTriangle, RefreshCw, AlertCircle,
  LogIn, LogOut, Activity, Archive, Skull, Sword, ShieldAlert, Copy, Gamepad2, Globe, FolderOpen,
  X, MoreHorizontal, Zap, Trash2, Download, Sparkles, CalendarClock, Monitor, ScrollText,
} from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  serverApi, rconApi, playersApi, panelBridgeApi, backupApi, configApi, serversApi, debugApi,
  panelUpdateApi, modsApi, schedulerApi, ServerInstance, PanelUpdateStatus, ComposedServerStatus,
} from '@/lib/api'
import { formatUptime } from '@/lib/utils'
import { useSocket } from '@/contexts/SocketContext'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { cn, copyText } from '@/lib/utils'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { VerdictBand, WorkList } from '@/components/dashboard/DashboardVerdict'
import type { Verdict, WorkItem } from '@/components/dashboard/DashboardVerdict'

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface PlayerActivity { id: number; player_name: string; action: string; details: string | null; logged_at: string }
interface BridgeStatus {
  configured: boolean
  isRunning: boolean
  modConnected: boolean
  modStatus: { alive: boolean; version?: string; serverName?: string; playerCount?: number } | null
}
interface ServerStatus {
  running: boolean
  startTime: string | null
  uptime: number
  serverPath: string
  configured: boolean
  publicIp?: string
  localIp?: string
  port?: number
  rcon: { host: string; port: number; connected: boolean }
}
interface Player { name: string; online: boolean }
interface PerformancePoint {
  time: string; timestamp?: string; playerCount: number; memoryMB: number
  pzMemMB?: number; cpuPercent?: number; hostMemUsedGB?: number; hostMemTotalGB?: number
  hostDiskUsedGB?: number; hostDiskTotalGB?: number
}

const DashboardPerformanceCharts = lazy(() => import('@/components/DashboardPerformanceCharts'))
const DASHBOARD_ONBOARDING_DISMISSED_KEY = 'pz-dashboard-onboarding-dismissed-v1'

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function getDashboardSuccessCopy(action: string) {
  switch (action) {
    case 'Start server':   return { title: 'Server starting',     description: 'Watch the dashboard for live status.' }
    case 'Stop server':    return { title: 'Server stopped',      description: 'Session closed cleanly.' }
    case 'Force stop server': return { title: 'Server force stopped', description: 'The game process was terminated without RCON.' }
    case 'Restart server': return { title: 'Restart scheduled',   description: 'The server will restart shortly.' }
    case 'Restart server now': return { title: 'Restart triggered', description: 'Hard restart command sent.' }
    case 'Save world':     return { title: 'World saved',         description: 'Current state written to disk.' }
    case 'Create backup':  return { title: 'Backup started',      description: 'Packaging a fresh recovery point.' }
    case 'Connect RCON':   return { title: 'RCON connected',      description: 'Remote command control ready.' }
    default:               return { title: 'Action complete',     description: `${action} completed successfully.` }
  }
}

function isFailedActionResult(value: unknown): value is { success: false; error?: string; message?: string } {
  return typeof value === 'object'
    && value !== null
    && 'success' in value
    && (value as { success?: boolean }).success === false
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/** Countdown to a future moment. Returns null once the moment has passed. */
function formatEta(iso: string): string | null {
  const ms = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(ms) || ms < 0) return null
  const mins = Math.round(ms / 60000)
  if (mins < 1) return 'any moment'
  if (mins < 60) return `in ${mins}m`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  if (hrs < 24) return rem ? `in ${hrs}h ${rem}m` : `in ${hrs}h`
  return `in ${Math.floor(hrs / 24)}d`
}

function eventStyle(action: string) {
  switch (action) {
    case 'connect':    return { icon: <LogIn       className="h-3 w-3" />, tone: 'text-success',         verb: 'joined' }
    case 'disconnect': return { icon: <LogOut      className="h-3 w-3" />, tone: 'text-destructive/85',  verb: 'left' }
    case 'death':      return { icon: <Skull       className="h-3 w-3" />, tone: 'text-warning',         verb: 'died' }
    case 'pvp_kill':   return { icon: <Sword       className="h-3 w-3" />, tone: 'text-warning',         verb: 'killed' }
    case 'ban':        return { icon: <ShieldAlert className="h-3 w-3" />, tone: 'text-destructive',     verb: 'banned' }
    case 'kick':       return { icon: <AlertCircle className="h-3 w-3" />, tone: 'text-warning',         verb: 'kicked' }
    // Raw log actions read as SCREAMING_SNAKE. Say them like words.
    default:           return { icon: <Activity    className="h-3 w-3" />, tone: 'text-muted-foreground', verb: action.replace(/_/g, ' ').toLowerCase() }
  }
}

/**
 * Connection LED row.
 */
function ConnLine({
  label, state, value, hint,
}: { label: string; state: 'on' | 'off' | 'wait'; value?: string; hint?: string }) {
  const dot =
    state === 'on'   ? 'bg-success'
  : state === 'wait' ? 'bg-warning'
                     : 'bg-destructive/70'
  const valueTone =
    state === 'on'   ? 'text-success/75'
  : state === 'wait' ? 'text-warning/80'
                     : 'text-destructive/80'
  return (
    <div className="flex min-w-0 items-center gap-2.5 py-1.5">
      <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', dot)} aria-hidden="true" />
      <span className="shrink-0 font-mono text-[11px] font-medium text-foreground/70">{label}</span>
      <span className={cn('min-w-0 flex-1 truncate text-right font-mono text-[11px] tabular-nums', valueTone)}>
        {value ?? (state === 'on' ? 'connected' : state === 'wait' ? 'pending' : 'offline')}
      </span>
      {hint && <span className="shrink-0 font-mono text-[10px] text-muted-foreground/50">{hint}</span>}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Dashboard                                                                 */
/* -------------------------------------------------------------------------- */

export default function Dashboard() {
  /* ---------------------------- state ------------------------------------- */
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [composedStatus, setComposedStatus] = useState<ComposedServerStatus | null>(null)
  const [players, setPlayers] = useState<Player[]>([])
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null)
  const [playerActivity, setPlayerActivity] = useState<PlayerActivity[]>([])
  const [performanceHistory, setPerformanceHistory] = useState<PerformancePoint[]>([])
  const [loading, setLoading] = useState<string | null>(null)
  const [initialLoading, setInitialLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [, setTick] = useState(0)
  const [autoStartServer, setAutoStartServer] = useState<boolean>(false)
  const [panelInfo, setPanelInfo] = useState<{ localIp: string; port: number; url: string } | null>(null)
  const [activeServer, setActiveServer] = useState<ServerInstance | null>(null)
  const [showPerformanceCharts, setShowPerformanceCharts] = useState(false)
  const [showQuickStart, setShowQuickStart] = useState<boolean>(() => {
    try { return localStorage.getItem(DASHBOARD_ONBOARDING_DISMISSED_KEY) !== 'true' } catch { return true }
  })
  const [panelUpdate, setPanelUpdate] = useState<PanelUpdateStatus | null>(null)
  const [panelUpdateDismissedVersion, setPanelUpdateDismissedVersion] = useState<string | null>(() => {
    try { return sessionStorage.getItem('panel-update-banner-dismissed') } catch { return null }
  })
  const [maintenance, setMaintenance] = useState<{
    lastBackup: { name: string; size: number; created: string } | null
    backupCount: number
    modUpdatesAvailable: number
    modsTracked: number
    scheduledTasksCount: number
    nextRun: { label: string; at: string } | null
    errorCount: number | null
    schedulerLoaded: boolean
  }>({
    lastBackup: null, backupCount: 0, modUpdatesAvailable: 0, modsTracked: 0,
    scheduledTasksCount: 0, nextRun: null, errorCount: null, schedulerLoaded: false,
  })

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const initialLoadingRef = useRef(true)

  const [confirmAction, setConfirmAction] = useState<{
    title: string; description: string
    action: () => Promise<unknown>
    variant?: 'destructive' | 'warning'
  } | null>(null)
  const [wipeDialog, setWipeDialog] = useState(false)
  const [wipeTargets, setWipeTargets] = useState<Record<string, boolean>>({ map: true, players: true, world: true, accounts: false })
  const [wipePreview, setWipePreview] = useState<{
    totalFiles: number; totalSize: number
    preview: Record<string, { files: number; size: number }>
  } | null>(null)
  const [wipeLoading, setWipeLoading] = useState(false)

  const { toast } = useToast()
  const socket = useSocket()

  /* ---------------------------- effects ----------------------------------- */
  useEffect(() => { initialLoadingRef.current = initialLoading }, [initialLoading])
  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 10000); return () => clearInterval(t) }, [])

  useEffect(() => {
    let cancelled = false
    panelUpdateApi.getStatus().then(s => { if (!cancelled) setPanelUpdate(s) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!socket) return
    const handleAvailable = (data: { latestVersion?: string; currentVersion?: string; releaseUrl?: string }) => {
      setPanelUpdate(prev => ({
        currentVersion: data.currentVersion || prev?.currentVersion || 'Unknown',
        updateAvailable: true,
        latestVersion: data.latestVersion || prev?.latestVersion || null,
        releaseUrl: data.releaseUrl || prev?.releaseUrl || null,
        releaseNotes: prev?.releaseNotes ?? null,
        publishedAt: prev?.publishedAt ?? null,
        isChecking: false,
        isDownloading: prev?.isDownloading ?? false,
        downloadProgress: prev?.downloadProgress ?? 0,
        lastCheck: prev?.lastCheck ?? null,
        lastError: null,
        stagedUpdate: prev?.stagedUpdate ?? null,
        lastApplyResult: prev?.lastApplyResult ?? null,
      }))
    }
    const handleApplied = () => setPanelUpdate(prev => prev ? { ...prev, updateAvailable: false } : prev)
    socket.on('panel:updateAvailable', handleAvailable)
    socket.on('panel:updateApplied', handleApplied)
    return () => {
      socket.off('panel:updateAvailable', handleAvailable)
      socket.off('panel:updateApplied', handleApplied)
    }
  }, [socket])

  const copyToClipboard = async (text: string, label: string) => {
    try { await copyText(text); toast({ title: 'Copied', description: `${label} copied to clipboard`, duration: 2000 }) }
    catch { toast({ title: 'Failed to copy', description: 'Could not copy to clipboard', variant: 'destructive' }) }
  }

  const dismissQuickStart = () => {
    setShowQuickStart(false)
    try { localStorage.setItem(DASHBOARD_ONBOARDING_DISMISSED_KEY, 'true') } catch { /* ignore storage failures */ }
  }

  /* ---------------------------- fetchers ---------------------------------- */
  const fetchStatus = useCallback(async () => {
    try { const data = await serverApi.getStatus(); setStatus(data); setFetchError(null); setLastUpdated(new Date()) }
    catch { setFetchError('Failed to connect to server.') }
  }, [])

  const fetchComposedStatus = useCallback(async () => {
    try { setComposedStatus(await serversApi.getComposedStatus()) }
    catch { setComposedStatus(null) }
  }, [])

  usePageShortcut('r', () => {
    if (loading === null) { fetchStatus(); fetchComposedStatus() }
  })

  const fetchPlayers = useCallback(async () => {
    try { const d = await playersApi.getPlayers(); if (d.players) setPlayers(d.players) } catch { setPlayers([]) }
  }, [])
  const fetchBridgeStatus = useCallback(async () => {
    try { setBridgeStatus(await panelBridgeApi.getStatus()) } catch { setBridgeStatus(null) }
  }, [])
  const fetchPlayerActivity = useCallback(async () => {
    try { const d = await playersApi.getActivityLogs(undefined, 15); if (d.logs) setPlayerActivity(d.logs.slice(0, 12)) }
    catch { setPlayerActivity([]) }
  }, [])
  const fetchPerformanceHistory = useCallback(async () => {
    try {
      const data = await debugApi.getPerformanceHistory(60)
      if (data.history) {
        setPerformanceHistory(data.history.map((h: Record<string, unknown>) => ({
          time: new Date(h.timestamp as string).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
          timestamp: h.timestamp as string,
          playerCount: (h.playerCount as number) || 0,
          memoryMB: Math.round(((h.memoryUsed as number) || 0) / (1024 * 1024)),
          pzMemMB: h.pzMemUsed ? Math.round((h.pzMemUsed as number) / (1024 * 1024)) : undefined,
          cpuPercent: h.cpuUsage != null ? Math.round(h.cpuUsage as number) : undefined,
          hostMemUsedGB: h.hostMemUsed ? +((h.hostMemUsed as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
          hostMemTotalGB: h.hostMemTotal ? +((h.hostMemTotal as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
          hostDiskUsedGB: h.hostDiskUsed ? +((h.hostDiskUsed as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
          hostDiskTotalGB: h.hostDiskTotal ? +((h.hostDiskTotal as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
        })))
      }
    } catch {
      // Ignore missing telemetry history so the rest of the dashboard can render.
    }
  }, [])
  const fetchAutoStartSetting = useCallback(async () => {
    try {
      const r = await configApi.getAppSettings()
      if (r?.settings?.autoStartServer !== undefined) {
        setAutoStartServer(r.settings.autoStartServer === true || r.settings.autoStartServer === 'true')
      }
    } catch {
      // Ignore settings fetch failures and keep the current fallback value.
    }
  }, [])
  const fetchActiveServer = useCallback(async () => {
    try { const d = await serversApi.getResolvedActive(); setActiveServer(d.server ?? null) } catch { setActiveServer(null) }
  }, [])
  const fetchMaintenance = useCallback(async () => {
    const [backupRes, modsRes, tasksRes, schedRes, errorRes] = await Promise.allSettled([
      backupApi.getStatus(),
      modsApi.getStatus(),
      schedulerApi.getTasks() as Promise<{ tasks: Array<{ enabled?: number | boolean }> }>,
      schedulerApi.getStatus() as Promise<{ nextRun?: { label: string; at: string } | null }>,
      serverApi.getConsoleErrorCount(),
    ])
    setMaintenance(prev => ({
      lastBackup: backupRes.status === 'fulfilled' ? backupRes.value.lastBackup : prev.lastBackup,
      backupCount: backupRes.status === 'fulfilled' ? (backupRes.value.backupCount ?? 0) : prev.backupCount,
      modUpdatesAvailable: modsRes.status === 'fulfilled' ? ((modsRes.value as { updatesAvailable?: number }).updatesAvailable ?? 0) : prev.modUpdatesAvailable,
      modsTracked: modsRes.status === 'fulfilled' ? ((modsRes.value as { totalModsTracked?: number }).totalModsTracked ?? 0) : prev.modsTracked,
      scheduledTasksCount: tasksRes.status === 'fulfilled'
        ? (tasksRes.value.tasks ?? []).filter(t => t.enabled === 1 || t.enabled === true).length
        : prev.scheduledTasksCount,
      nextRun: schedRes.status === 'fulfilled' ? (schedRes.value.nextRun ?? null) : prev.nextRun,
      errorCount: errorRes.status === 'fulfilled' && errorRes.value.exists
        ? errorRes.value.count
        : errorRes.status === 'fulfilled' ? null : prev.errorCount,
      schedulerLoaded: true,
    }))
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
      setAutoStartServer(!checked)
      toast({ title: 'Error', description: 'Failed to save auto-start setting', variant: 'destructive' })
    }
  }

  /* ---------------------------- bootstrap --------------------------------- */
  useEffect(() => {
    const load = async () => {
      try {
        await Promise.allSettled([fetchStatus(), fetchComposedStatus(), fetchPlayers(), fetchBridgeStatus()])
        setInitialLoading(false)
        void Promise.allSettled([
          fetchPlayerActivity(),
          fetchAutoStartSetting(),
          serverApi.getPanelInfo().then(setPanelInfo).catch(() => setPanelInfo(null)),
          fetchActiveServer(),
          fetchMaintenance(),
        ])
      } catch { setFetchError('Failed to load dashboard status.'); setInitialLoading(false) }
    }
    load()

    const loadingTimeout = setTimeout(() => {
      if (initialLoadingRef.current) {
        setFetchError((c) => c ?? 'The dashboard is taking longer than expected to respond.')
        setInitialLoading(false)
      }
    }, 5000)

    const interval = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      fetchStatus()
      fetchComposedStatus()
      fetchPlayers()
      fetchPlayerActivity()
    }, 15000)
    const maintenanceInterval = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      fetchMaintenance()
    }, 60000)

    return () => {
      clearTimeout(loadingTimeout)
      clearInterval(interval)
      clearInterval(maintenanceInterval)
      if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null }
    }
  }, [fetchStatus, fetchComposedStatus, fetchPlayers, fetchBridgeStatus, fetchPlayerActivity,
      fetchAutoStartSetting, fetchActiveServer, fetchMaintenance])

  useEffect(() => {
    if (!socket) return
    const onStatus = (data: Partial<ServerStatus>) => {
      setStatus(prev => {
        if (prev) return { ...prev, ...data }
        if ('running' in data && 'configured' in data) return data as ServerStatus
        return prev
      })
      setLastUpdated(new Date())
    }
    const onPlayers = (d: Player[]) => setPlayers(d)
    const onActiveServer = (d?: { server?: ServerInstance | null }) => {
      if (d?.server !== undefined) setActiveServer(d.server); else fetchActiveServer()
      fetchStatus(); fetchComposedStatus(); fetchPlayers(); fetchBridgeStatus()
    }
    const onBridgeMod = (d: { alive: boolean; version?: string; serverName?: string; playerCount?: number }) => {
      setBridgeStatus(prev => ({
        configured: prev?.configured ?? true,
        isRunning: prev?.isRunning ?? true,
        modConnected: d.alive,
        modStatus: {
          alive: d.alive,
          version: d.version || prev?.modStatus?.version,
          serverName: d.serverName || prev?.modStatus?.serverName,
          playerCount: d.playerCount ?? 0,
        },
      }))
    }
    socket.on('server:status', onStatus)
    socket.on('players:update', onPlayers)
    socket.on('activeServerChanged', onActiveServer)
    socket.on('panelBridge:modStatus', onBridgeMod)
    return () => {
      socket.off('server:status', onStatus)
      socket.off('players:update', onPlayers)
      socket.off('activeServerChanged', onActiveServer)
      socket.off('panelBridge:modStatus', onBridgeMod)
    }
  }, [socket, fetchStatus, fetchComposedStatus, fetchPlayers, fetchBridgeStatus, fetchActiveServer])

  useEffect(() => {
    if (initialLoading || showPerformanceCharts) return
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    let idleId: number | null = null
    const reveal = () => setShowPerformanceCharts(true)
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(reveal, { timeout: 1500 })
    } else { timeoutId = setTimeout(reveal, 300) }
    return () => {
      if (idleId !== null && typeof window !== 'undefined' && 'cancelIdleCallback' in window) window.cancelIdleCallback(idleId)
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [initialLoading, showPerformanceCharts])

  useEffect(() => { if (showPerformanceCharts) fetchPerformanceHistory() }, [showPerformanceCharts, fetchPerformanceHistory])

  // Real-time perf subscription via Socket.IO — appends each new snapshot
  useEffect(() => {
    if (!socket || !showPerformanceCharts) return
    socket.emit('subscribe:perf')
    const onSnapshot = (snap: Record<string, unknown>) => {
      const point: PerformancePoint = {
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        timestamp: new Date().toISOString(),
        playerCount: (snap.playerCount as number) || 0,
        memoryMB: Math.round(((snap.memoryUsed as number) || 0) / (1024 * 1024)),
        pzMemMB: snap.pzMemUsed ? Math.round((snap.pzMemUsed as number) / (1024 * 1024)) : undefined,
        cpuPercent: snap.cpuUsage != null ? Math.round(snap.cpuUsage as number) : undefined,
        hostMemUsedGB: snap.hostMemUsed ? +((snap.hostMemUsed as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
        hostMemTotalGB: snap.hostMemTotal ? +((snap.hostMemTotal as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
        hostDiskUsedGB: snap.hostDiskUsed ? +((snap.hostDiskUsed as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
        hostDiskTotalGB: snap.hostDiskTotal ? +((snap.hostDiskTotal as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
      }
      setPerformanceHistory(prev => {
        const next = [...prev, point]
        return next.length > 60 ? next.slice(-60) : next
      })
    }
    socket.on('perf:snapshot', onSnapshot)
    return () => {
      socket.off('perf:snapshot', onSnapshot)
      socket.emit('unsubscribe:perf')
    }
  }, [socket, showPerformanceCharts])

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        fetchStatus(); fetchComposedStatus(); fetchPlayers(); fetchBridgeStatus(); fetchPlayerActivity()
        if (showPerformanceCharts) fetchPerformanceHistory()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [fetchStatus, fetchComposedStatus, fetchPlayers, fetchBridgeStatus, fetchPlayerActivity, fetchPerformanceHistory, showPerformanceCharts])

  /* ---------------------------- actions ----------------------------------- */
  const handleAction = async (action: string, fn: () => Promise<unknown>) => {
    setLoading(action)
    try {
      const result = await fn()
      if (isFailedActionResult(result)) {
        throw new Error(result.error || result.message || 'Action failed.')
      }
      const copy = getDashboardSuccessCopy(action)
      toast({ title: copy.title, description: copy.description, variant: 'success' as const })
      if (action === 'Start server') {
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
        let attempts = 0
        pollIntervalRef.current = setInterval(async () => {
          attempts++
          try {
            const data = await serverApi.getStatus()
            setStatus(data)
            void fetchComposedStatus()
            if (data?.running || attempts >= 15) {
              if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null }
            }
          } catch {
            if (attempts >= 15 && pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current); pollIntervalRef.current = null
            }
          }
        }, 2000)
      } else { fetchStatus(); fetchComposedStatus() }
    } catch (error) {
      toast({ title: 'Error', description: getUserErrorMessage(error, 'Action failed. Please try again.'), variant: 'destructive' })
    } finally { setLoading(null) }
  }
  const handleConnect = async () => { await handleAction('Connect RCON', () => rconApi.connect()) }

  /* ---------------------------- loading ----------------------------------- */
  if (initialLoading) {
    return (
      <div className="page-transition">
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
          <RefreshCw className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">Establishing link…</p>
        </div>
      </div>
    )
  }

  /* ---------------------------- derived ----------------------------------- */
  const hasServer = !!activeServer
  const hostRunning = hasServer && (composedStatus ? composedStatus.host.status === 'running' : !!status?.running)
  const rconConnected = composedStatus
    ? composedStatus.server.status === 'connected'
    : Boolean(status && status.rcon && status.rcon.connected)
  const rconConnecting = composedStatus?.server.status === 'connecting'
  const bridgeActive = composedStatus?.bridge.status === 'active'
  const hostUnknown = composedStatus
    ? ['unknown', 'not-applicable'].includes(composedStatus.host.status)
    : false
  const online = hasServer && (composedStatus
    ? hostRunning || rconConnected || bridgeActive
    : !!status?.running)
  const modsPending = maintenance.modUpdatesAvailable > 0
  const staleLink = !lastUpdated || Date.now() - lastUpdated.getTime() > 60_000

  /* Thresholds drive the verdict. Colour follows a crossed threshold, never a palette slot. */
  const latestPerf = performanceHistory[performanceHistory.length - 1]
  const maxMemoryGB = activeServer?.maxMemory
  const hostMemoryRatio = latestPerf?.hostMemUsedGB != null && latestPerf?.hostMemTotalGB
    ? latestPerf.hostMemUsedGB / latestPerf.hostMemTotalGB
    : null
  const hostCpu = latestPerf?.cpuPercent ?? null
  const diskFreeGB = latestPerf?.hostDiskUsedGB != null && latestPerf?.hostDiskTotalGB
    ? latestPerf.hostDiskTotalGB - latestPerf.hostDiskUsedGB
    : null
  const diskRatio = latestPerf?.hostDiskUsedGB != null && latestPerf?.hostDiskTotalGB
    ? latestPerf.hostDiskUsedGB / latestPerf.hostDiskTotalGB
    : null

  /* Who is online, with a join age only where a real connect event exists. */
  const joinedAt = new Map<string, string>()
  for (const event of playerActivity) {
    if (event.action === 'connect' && !joinedAt.has(event.player_name)) joinedAt.set(event.player_name, event.logged_at)
  }
  const presence = players.map(player => {
    const joined = joinedAt.get(player.name)
    if (!joined) return { name: player.name }
    const age = formatAge(joined)
    return { name: player.name, since: age === 'just now' ? 'just joined' : `for ${age.replace(' ago', '')}` }
  })

  /* One verdict at a time, highest severity wins. Calm states say nothing at all. */
  const verdict: Verdict = (() => {
    if (!hasServer || (status && !status.configured)) {
      return {
        level: 'warning',
        headline: 'No server configured',
        action: { label: 'Open setup', to: '/server-setup' },
      }
    }
    if (fetchError) {
      return {
        level: 'critical',
        headline: 'Panel cannot reach the server',
        detail: fetchError,
        action: { label: 'Retry', onClick: () => { void fetchStatus() } },
      }
    }
    if (!online) {
      return {
        level: hostUnknown ? 'warning' : 'critical',
        headline: hostUnknown ? 'Server status unknown' : 'Server stopped',
        action: hostUnknown || activeServer?.isRemote
          ? undefined
          : {
              label: 'Start server',
              onClick: () => { void handleAction('Start server', serverApi.start) },
              busy: loading === 'Start server',
              disabled: loading !== null,
            },
      }
    }
    if (!rconConnected) {
      return {
        level: 'warning',
        headline: 'RCON disconnected',
        action: {
          label: 'Connect RCON',
          onClick: () => { void handleConnect() },
          busy: loading === 'Connect RCON',
          disabled: loading !== null,
        },
      }
    }
    if (hostMemoryRatio != null && hostMemoryRatio >= 0.9) {
      return {
        level: 'critical',
        headline: `Host memory ${Math.round(hostMemoryRatio * 100)}%`,
      }
    }
    /* A full disk corrupts saves and fails backups, so it outranks a busy CPU. */
    if (diskRatio != null && diskFreeGB != null && diskRatio >= 0.95) {
      return {
        level: 'critical',
        headline: `Disk almost full, ${diskFreeGB.toFixed(0)} GB left`,
      }
    }
    if (diskRatio != null && diskFreeGB != null && diskRatio >= 0.9) {
      return {
        level: 'warning',
        headline: `Disk ${Math.round(diskRatio * 100)}%, ${diskFreeGB.toFixed(0)} GB left`,
      }
    }
    if (hostCpu != null && hostCpu >= 90) {
      return {
        level: 'warning',
        headline: `Host CPU ${hostCpu}%`,
      }
    }
    if (bridgeStatus?.configured && !bridgeStatus.modConnected) {
      return {
        level: 'warning',
        headline: 'PanelBridge offline',
        action: { label: 'Bridge settings', to: '/settings' },
      }
    }
    if (modsPending) {
      return {
        level: 'warning',
        headline: `${maintenance.modUpdatesAvailable} mod update${maintenance.modUpdatesAvailable === 1 ? '' : 's'} waiting`,
        action: { label: 'Review mods', to: '/mods' },
      }
    }
    /* Game errors are reported by the Errors row, which is already coloured by
       severity. Repeating the count here would say the same thing twice. */
    if (maintenance.schedulerLoaded && maintenance.backupCount === 0 && !activeServer?.isRemote) {
      return {
        level: 'warning',
        headline: 'No backups',
        action: {
          label: 'Create backup',
          onClick: () => { void handleAction('Create backup', () => backupApi.createBackup({ includeDb: true }).then(() => fetchMaintenance())) },
          busy: loading === 'Create backup',
          disabled: loading !== null,
        },
      }
    }
    return { level: 'calm' }
  })()

  /* Readiness numbers live on the thing you act on, not in a read-only panel. */
  const backupState = maintenance.lastBackup
    ? `${maintenance.backupCount} stored, last ${formatAge(maintenance.lastBackup.created)}`
    : maintenance.backupCount > 0
      ? `${maintenance.backupCount} stored`
      : 'none yet'

  /* A count of tasks is trivia. The next time something will happen is the
     thing that decides whether you can walk away from the server. */
  const nextRunEta = maintenance.nextRun ? formatEta(maintenance.nextRun.at) : null
  const scheduleState = nextRunEta && maintenance.nextRun
    ? `${maintenance.nextRun.label} ${nextRunEta}`
    : maintenance.scheduledTasksCount > 0
      ? `${maintenance.scheduledTasksCount} active`
      : 'none active'

  const errorCount = maintenance.errorCount

  const workItems: WorkItem[] = [
    {
      to: '/players', icon: Activity, label: 'Players',
      state: online ? String(players.length) : 'offline',
      tone: !online ? 'bad' : players.length > 0 ? 'good' : 'default',
    },
    {
      to: '/console', icon: Wifi, label: 'Console',
      state: rconConnected ? 'rcon ready' : 'rcon offline',
      tone: rconConnected ? 'good' : 'warning',
    },
    {
      to: '/mods', icon: Gamepad2, label: 'Mods',
      state: modsPending ? `${maintenance.modUpdatesAvailable} to update` : `${maintenance.modsTracked} tracked`,
      tone: modsPending ? 'warning' : 'default',
    },
    {
      to: '/scheduler', icon: CalendarClock, label: 'Schedule',
      state: scheduleState,
      tone: nextRunEta ? 'good' : maintenance.scheduledTasksCount > 0 ? 'good' : 'default',
    },
    ...(errorCount != null ? [{
      to: '/console', icon: ScrollText, label: 'Errors',
      state: errorCount === 0 ? 'none' : `${errorCount} logged`,
      tone: errorCount === 0 ? 'good' : errorCount >= 50 ? 'warning' : 'default',
    } as WorkItem] : []),
    {
      to: '/backups', icon: Archive, label: 'Backups',
      state: backupState,
      tone: maintenance.backupCount === 0 ? 'warning' : 'good',
    },
    { to: '/server-config', icon: Server, label: 'Config' },
  ]

  /* ====================================================================== */
  /*  RENDER                                                                  */
  /* ====================================================================== */
  return (
    <div className="page-transition pb-12">
      {/* ─── TOP STATUS BAR ───────────────────────────────────────── */}
      <header
        aria-label="Server status"
        className="overflow-hidden rounded-lg border border-border/55 bg-card/45 shadow-sm"
      >
        {/* Main row */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
          {/* Identity cluster: status + name + uptime */}
          <div className="flex min-w-0 items-center gap-3">
            {/* One light for the whole page: green calm, amber attention, red broken. */}
            <span
              className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center"
              title={verdict.headline ?? 'Everything nominal'}
            >
              <span
                className={cn(
                  'absolute inline-flex h-2.5 w-2.5 rounded-full opacity-25',
                  verdict.level === 'critical' ? 'bg-destructive'
                    : verdict.level === 'warning' ? 'bg-warning'
                    : 'bg-success',
                )}
              />
              <span
                className={cn(
                  'relative inline-flex h-1.5 w-1.5 rounded-full',
                  verdict.level === 'critical' ? 'bg-destructive'
                    : verdict.level === 'warning' ? 'bg-warning'
                    : 'bg-success',
                )}
              />
              <span className="sr-only">{verdict.headline ?? 'Everything nominal'}</span>
            </span>

            <h1 className="min-w-0 truncate font-mono text-base font-semibold text-foreground" title={activeServer?.serverName ?? 'No active server'}>
              {activeServer?.serverName ?? 'No active server'}
            </h1>

            {/* Uptime */}
            {online && status && status.uptime > 0 && (
              <span className="hidden font-mono text-[11px] tabular-nums text-muted-foreground/60 sm:inline">
                up {formatUptime(status.uptime)}
              </span>
            )}
            {activeServer?.isRemote && (
              <span className="rounded-sm bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">remote</span>
            )}
          </div>

          {/* Address cluster — grouped, distinct background */}
          <div className="order-3 -mx-4 -mb-3 flex w-[calc(100%+2rem)] flex-wrap items-center gap-1 border-t border-border/30 bg-background/20 px-3 py-1.5">
            {status?.localIp && (
              <button
                onClick={() => copyToClipboard(`${status.localIp}${status.port ? `:${status.port}` : ''}`, 'LAN address')}
                className="group inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                aria-label={`Copy LAN address: ${status.localIp}${status.port ? `:${status.port}` : ''}`}
                title="Connect from your home network"
              >
                <Wifi className="h-3 w-3 text-emerald-500/70" />
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-foreground/45">LAN</span>
                <span className="font-mono text-[11px] tabular-nums">{status.localIp}{status.port ? `:${status.port}` : ''}</span>
                <Copy className="h-2.5 w-2.5 shrink-0 opacity-35 transition-opacity group-hover:opacity-70" />
              </button>
            )}
            {status?.publicIp && (
              <button
                onClick={() => copyToClipboard(`${status.publicIp}${status.port ? `:${status.port}` : ''}`, 'WAN address')}
                className="group inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                aria-label={`Copy WAN address: ${status.publicIp}${status.port ? `:${status.port}` : ''}`}
                title="Share this address with internet players"
              >
                <Globe className="h-3 w-3 text-amber-500/70" />
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-foreground/45">WAN</span>
                <span className="font-mono text-[11px] tabular-nums">{status.publicIp}{status.port ? `:${status.port}` : ''}</span>
                <Copy className="h-2.5 w-2.5 shrink-0 opacity-35 transition-opacity group-hover:opacity-70" />
              </button>
            )}
            {panelInfo && (
              <button
                onClick={() => copyToClipboard(panelInfo.url, 'Panel address')}
                className="group inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                aria-label={`Copy panel address: ${panelInfo.url}`}
                title="Open or copy the control panel address"
              >
                <Monitor className="h-3 w-3 text-primary/70" />
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-foreground/45">Panel</span>
                <span className="font-mono text-[11px] tabular-nums">{panelInfo.localIp}:{panelInfo.port}</span>
                <Copy className="h-2.5 w-2.5 shrink-0 opacity-35 transition-opacity group-hover:opacity-70" />
              </button>
            )}
            {status?.publicIp && status?.port && (
              <a
                href={`steam://connect/${status.publicIp}:${status.port}`}
                className="inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
                aria-label={`Join with Steam at ${status.publicIp}:${status.port}`}
                title="Connect with Steam"
              >
                <Gamepad2 className="h-3 w-3 text-blue-400/70" />
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em]">Join</span>
              </a>
            )}
          </div>

          {/* primary controls — right-aligned */}
          <div className="order-2 ml-auto flex flex-wrap justify-end gap-1">
          {!online ? (
            <Button
              onClick={() => handleAction('Start server', serverApi.start)}
              disabled={!hasServer || hostUnknown || loading !== null || activeServer?.isRemote}
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 rounded-md border border-emerald-500/30 px-2.5 text-xs text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300 disabled:border-border/50 disabled:text-muted-foreground"
              title={!hasServer ? 'Add or select a server first' : activeServer?.isRemote ? 'Not available for remote (RCON-only) servers' : undefined}
            >
              {loading === 'Start server' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Start
            </Button>
          ) : (
            <>
              <Button
                onClick={() => setConfirmAction({
                  title: 'Stop server',
                  description: 'Are you sure you want to stop the server? All connected players will be disconnected.',
                  action: serverApi.stop,
                  variant: 'destructive',
                })}
                disabled={loading !== null || !hostRunning}
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 rounded-md border border-red-500/30 px-2.5 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300 disabled:border-border/50 disabled:text-muted-foreground"
              >
                {loading === 'Stop server' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                Stop
              </Button>
              <Button
                onClick={() => setConfirmAction({
                  title: 'Force stop server',
                  description: `This will immediately kill the game process without saving.${players.length > 0 ? ` ${players.length} player(s) will be disconnected!` : ''}`,
                  action: serverApi.forceStop,
                  variant: 'destructive',
                })}
                disabled={loading !== null || !hostRunning || activeServer?.isRemote}
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 rounded-md border border-red-500/30 px-2.5 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300 disabled:border-border/50 disabled:text-muted-foreground"
                title={activeServer?.isRemote ? 'Not available for remote (RCON-only) servers' : 'Immediately stops the game without saving'}
              >
                {loading === 'Force stop server' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Skull className="h-3.5 w-3.5" />}
                Force stop
              </Button>
              <Button
                onClick={() => setConfirmAction({
                  title: 'Restart server',
                  description: 'This will send a 5-minute warning to all players, then restart the server.',
                  action: () => serverApi.restart(5),
                  variant: 'warning',
                })}
                disabled={loading !== null || !hostRunning || activeServer?.isRemote}
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 rounded-md border border-amber-500/30 px-2.5 text-xs text-amber-400 hover:bg-amber-500/10 hover:text-amber-300 disabled:border-border/50 disabled:text-muted-foreground"
                title={activeServer?.isRemote ? 'Not available for remote (RCON-only) servers' : undefined}
              >
                <RotateCcw className="h-3.5 w-3.5" /> Restart
              </Button>
              <Button
                onClick={() => handleAction('Save world', serverApi.save)}
                disabled={loading !== null || !rconConnected}
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 rounded-md border border-sky-500/30 px-2.5 text-xs text-sky-400 hover:bg-sky-500/10 hover:text-sky-300 disabled:border-border/50 disabled:text-muted-foreground"
              >
                <Save className="h-3.5 w-3.5" /> Save
              </Button>
            </>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="h-8 w-8 border-border/60 text-muted-foreground hover:text-foreground" aria-label="More server actions">
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => handleAction('Create backup', () => backupApi.createBackup({ includeDb: true }).then(() => fetchMaintenance()))}
                disabled={!hasServer || loading !== null || activeServer?.isRemote}
              >
                <Archive className="mr-2 h-4 w-4" /> Create backup
              </DropdownMenuItem>
              <DropdownMenuItem onClick={fetchStatus}>
                <RefreshCw className="mr-2 h-4 w-4" /> Refresh status
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/settings" className="flex items-center"><Server className="mr-2 h-4 w-4" /> Bridge settings</Link>
              </DropdownMenuItem>
              {!rconConnected && (
                <DropdownMenuItem onClick={handleConnect} disabled={!hasServer || loading !== null}>
                  <Wifi className="mr-2 h-4 w-4" /> Connect RCON
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setConfirmAction({
                  title: 'Restart server now',
                  description: `This will immediately restart the server without warning.${players.length > 0 ? ` ${players.length} player(s) will be disconnected!` : ''}`,
                  action: () => serverApi.restart(0),
                  variant: 'destructive',
                })}
                disabled={!hasServer || !hostRunning || loading !== null || activeServer?.isRemote}
                className="text-destructive focus:text-destructive"
              >
                <Zap className="mr-2 h-4 w-4" /> Restart now
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => { setWipePreview(null); setWipeDialog(true) }}
                disabled={!hasServer || online || loading !== null || activeServer?.isRemote}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" /> Wipe server
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        </div>
      </header>

      {/* ─── Panel update banner ─────────────────────────────────────────── */}
      {(() => {
        if (!panelUpdate?.updateAvailable) return null
        const latest = panelUpdate.latestVersion
        if (latest && latest === panelUpdate.currentVersion) return null
        if (latest && panelUpdateDismissedVersion === latest) return null
        const isStaged = !!panelUpdate.stagedUpdate && (!latest || panelUpdate.stagedUpdate.version === latest)
        const lastFailed = panelUpdate.lastApplyResult?.status === 'failed'
          && (!latest || panelUpdate.lastApplyResult.pendingVersion === latest)
        const ctaLabel = isStaged ? 'Apply update' : 'View update'
        void lastFailed
        const dismiss = () => {
          if (!latest) return
          try { sessionStorage.setItem('panel-update-banner-dismissed', latest) } catch { /* ignore storage failures */ }
          setPanelUpdateDismissedVersion(latest)
        }
        const accent = lastFailed ? 'destructive' : 'primary'
        return (
          <div
            role="status"
            className={cn(
              'mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border py-2 pl-3 pr-2',
              lastFailed
                ? 'border-destructive/35 bg-destructive/[0.05] shadow-[inset_2px_0_0_hsl(var(--destructive))]'
                : 'border-primary/35 bg-primary/[0.04] shadow-[inset_2px_0_0_hsl(var(--primary))]',
            )}
          >
            <Sparkles className={cn('h-3.5 w-3.5 shrink-0', `text-${accent}`)} />
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className={cn('font-mono text-[10px] font-semibold uppercase tracking-[0.18em]', `text-${accent}`)}>
                {lastFailed ? 'Apply failed' : isStaged ? 'Update staged' : 'Panel update'}
              </span>
              <span className="min-w-0 text-xs text-muted-foreground">
                {lastFailed
                  ? 'Last apply attempt failed — see Settings for diagnostics.'
                  : isStaged
                    ? 'Downloaded and ready. Restart the panel to apply.'
                    : 'A new panel version is available.'}
              </span>
              {latest && (
                <span className="font-mono text-[11px] tabular-nums text-foreground/85">
                  v{panelUpdate.currentVersion} <span className="text-muted-foreground/60">→</span> v{latest}
                </span>
              )}
            </div>
            <div className="ml-auto flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                aria-label="Dismiss update notification"
                onClick={dismiss}
                disabled={!latest}
                title="Dismiss until next version"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
              <Link to="/settings?tab=panel">
                <Button
                  size="sm"
                  variant={lastFailed ? 'destructive' : 'default'}
                  className="h-7 gap-1.5 px-2.5 text-xs font-semibold"
                >
                  <Download className="h-3 w-3" /> {ctaLabel}
                </Button>
              </Link>
            </div>
          </div>
        )
      })()}

      {/* ─── Error banner ────────────────────────────────────────────────── */}
      {fetchError && (
        <div
          role="alert"
          className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-destructive/40 bg-destructive/[0.05] py-2 pl-3 pr-2 shadow-[inset_2px_0_0_hsl(var(--destructive))]"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-destructive">
              Connection error
            </span>
            <span className="min-w-0 truncate text-xs text-muted-foreground" title={fetchError}>
              {fetchError}. Some features may be unavailable.
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={fetchStatus} className="ml-auto h-7 gap-1.5 px-2.5 text-xs">
            <RefreshCw className="h-3 w-3" /> Retry
          </Button>
        </div>
      )}

      {/* ─── Not configured ──────────────────────────────────────────────── */}
      {status && !status.configured && (
        <Link
          to="/server-setup"
          className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-warning/40 bg-warning/[0.04] py-2 pl-3 pr-2 shadow-[inset_2px_0_0_hsl(var(--warning))] transition-colors hover:bg-warning/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-warning">
              Not configured
            </span>
            <span className="text-xs text-muted-foreground">
              Open Server Setup to add or configure a server.
            </span>
          </div>
          <span className="ml-auto text-xs font-medium text-warning/85">open setup →</span>
        </Link>
      )}

      {/* ─── Quick-start onboarding ──────────────────────────────────────── */}
      {!hasServer && showQuickStart && (
        <section className="relative mt-3 overflow-hidden rounded-lg border border-primary/30 bg-card/50 px-4 py-4">
          <button
            onClick={dismissQuickStart}
            aria-label="Dismiss quick start guide"
            className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary/85">First server</p>
          <h2 className="mt-1 text-lg font-semibold leading-tight text-foreground">
            Get one server up, RCON working, then layer on the rest.
          </h2>
          <ol className="mt-4 grid gap-2 list-none p-0 md:grid-cols-3">
            {[
              ['1', 'Bring in a server', 'Add an existing install, connect remote RCON, or create a new server.'],
              ['2', 'Verify connectivity', 'Confirm paths, RCON credentials, and active server.'],
              ['3', 'Reach live control',  'When status, players, and chat update, live control is ready.'],
            ].map(([n, title, body]) => (
              <li key={n} className="rounded-md border border-border/50 bg-background/40 p-3">
                <p className="text-sm font-semibold text-foreground">
                  <span className="mr-1.5 inline-flex h-4 w-4 items-center justify-center rounded text-[10px] font-bold bg-primary/15 text-primary" aria-hidden="true">{n}</span>
                  {title}
                </p>
                <p className="mt-1 pl-[1.4rem] text-xs leading-5 text-muted-foreground">{body}</p>
              </li>
            ))}
          </ol>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to="/server-setup" className={cn(buttonVariants({ variant: 'default', size: 'sm' }), 'h-8 gap-1.5 text-xs')}>
              <Server className="h-3.5 w-3.5" /> Install new server
            </Link>
            <Link to="/servers" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-8 gap-1.5 text-xs')}>
              <FolderOpen className="h-3.5 w-3.5" /> Add existing server
            </Link>
            <Link to="/servers" className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'h-8 gap-1.5 text-xs')}>
              <Globe className="h-3.5 w-3.5" /> Add remote server
            </Link>
          </div>
        </section>
      )}

      {/* ─── VERDICT ────────────────────────────────────────────────────── */}
      <VerdictBand
        verdict={verdict}
        players={presence}
        showPresence={online}
        lastUpdated={lastUpdated}
        stale={staleLink}
      />

      {/* ─── EVIDENCE AND WORK ──────────────────────────────────────────── */}
      <div className="mt-6 grid content-start gap-6 xl:grid-cols-[minmax(0,1fr)_19rem] xl:items-start">

        {/* ════ CENTER ════ */}
        <main className="grid min-w-0 content-start gap-4 2xl:grid-cols-2 2xl:items-start">

          {/* LIVE ACTIVITY */}
          <section className={cn(
            'order-2 flex flex-col overflow-hidden rounded-lg border border-border/45 bg-card/25',
            playerActivity.length > 0 && 'max-h-[15rem]',
          )}>
            <header className="flex items-center justify-between border-b border-border/30 px-3 py-1.5">
              <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary/75">Live activity</h3>
              {/* No status dot. Whether the server is up is answered by the verdict band, not repeated here. */}
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
                {playerActivity.length > 0 ? `${playerActivity.length} events` : online ? 'idle' : 'offline'}
              </span>
            </header>
            {playerActivity.length === 0 ? (
              <div className="flex items-center px-3 py-3">
                <p className="text-xs text-muted-foreground/75">
                  {online
                    ? 'Listening for player joins, departures, deaths, and moderation events.'
                    : status?.configured
                      ? 'Start the server to begin tracking player activity.'
                      : 'Configure a server to start tracking activity.'}
                </p>
              </div>
            ) : (
              <ol className="min-h-0 divide-y divide-border/15 overflow-y-auto">
                {playerActivity.map(a => {
                  const s = eventStyle(a.action)
                  return (
                    <li key={a.id} className="group grid grid-cols-[3.25rem_1rem_minmax(0,8rem)_minmax(0,1fr)] items-center gap-2 px-3 py-[3px] transition-colors hover:bg-muted/20">
                      <time className="font-mono text-[10px] tabular-nums text-muted-foreground/50">
                        {new Date(a.logged_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                      </time>
                      <span className={cn('flex justify-center', s.tone)} aria-hidden="true">{s.icon}</span>
                      <span className="truncate text-[11px] font-medium text-foreground/85" dir="auto" title={a.player_name}>
                        {a.player_name}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground/55">
                        {s.verb}
                      </span>
                    </li>
                  )
                })}
              </ol>
            )}
          </section>

          {/* TELEMETRY */}
          <section className="order-1 overflow-hidden rounded-lg border border-border/65 bg-card/50 shadow-sm">
            <header className="flex items-center justify-between gap-3 border-b border-border/35 px-4 py-2">
              <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary/75">Server telemetry</h2>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
                {(() => {
                  if (performanceHistory.length === 0) return online ? 'sampling' : 'standby'
                  if (performanceHistory.length < 2) return 'live'
                  const first = performanceHistory[0].timestamp
                  const last = performanceHistory[performanceHistory.length - 1].timestamp
                  if (first && last) {
                    const spanSec = (new Date(last).getTime() - new Date(first).getTime()) / 1000
                    if (spanSec < 120) return `last ${Math.round(spanSec)}s · live`
                    return `last ${Math.round(spanSec / 60)} min · live`
                  }
                  return 'live'
                })()}
              </span>
            </header>
            {performanceHistory.length > 0 ? (
              <Suspense
                fallback={
                  <div className="space-y-2 p-3">
                    {[0, 1, 2, 3].map(i => (
                      <div key={i} className="flex items-center gap-2 py-1">
                        <div className="h-2.5 w-16 rounded bg-muted/40" />
                        <div className="h-5 flex-1 animate-pulse rounded bg-muted/30" />
                        <div className="h-4 w-10 rounded bg-muted/40" />
                      </div>
                    ))}
                  </div>
                }
              >
                {showPerformanceCharts ? (
                  <DashboardPerformanceCharts
                    performanceHistory={performanceHistory}
                    serverRunning={online}
                    maxMemoryGB={maxMemoryGB}
                  />
                ) : null}
              </Suspense>
            ) : (
              <p className="px-3 py-3 text-xs text-muted-foreground/80">
                {online
                  ? 'Telemetry will appear within the next sample cycle.'
                  : 'Start the server to track CPU, RAM, and player metrics.'}
              </p>
            )}
          </section>
        </main>

        {/* ════ WORK ════ */}
        <aside className="grid content-start gap-6">

          {/* DESTINATIONS — each one carries its own live state */}
          <section>
            <WorkList items={workItems} />
            <div className="mt-2 border-t border-border/25 px-1 pt-1">
              {composedStatus && (
                <ConnLine
                  label={composedStatus.host.label}
                  state={hostRunning ? 'on' : ['unknown', 'not-applicable'].includes(composedStatus.host.status) ? 'wait' : 'off'}
                  value={composedStatus.host.status.replace('-', ' ')}
                />
              )}
              <ConnLine
                label="RCON"
                state={rconConnected ? 'on' : rconConnecting ? 'wait' : 'off'}
                value={composedStatus?.server.detail ?? (status?.rcon ? `${status.rcon.host}:${status.rcon.port}` : undefined)}
              />
              <ConnLine
                label="Bridge"
                state={bridgeStatus?.modConnected ? 'on' : bridgeStatus?.isRunning ? 'wait' : 'off'}
                value={
                  bridgeStatus?.modConnected && bridgeStatus.modStatus?.version
                    ? `v${bridgeStatus.modStatus.version.replace(/^v/, '')}`
                    : bridgeStatus?.isRunning ? 'pending' : 'offline'
                }
              />
            </div>
          </section>

          {/* MAINTENANCE */}
          {!activeServer?.isRemote && (
            <section>
              <h3 className="px-1 pb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary/75">Maintenance</h3>
              <div className="space-y-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 w-full justify-start gap-2 text-xs"
                  onClick={fetchStatus}
                  disabled={loading !== null}
                >
                  <RefreshCw className={cn('h-3 w-3', loading ? 'animate-spin' : '')} />
                  Refresh status
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground/65">
                    {lastUpdated ? lastUpdated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—'}
                  </span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 w-full justify-start gap-2 text-xs"
                  disabled={!hasServer || loading !== null || activeServer?.isRemote}
                  onClick={() => handleAction('Create backup', () => backupApi.createBackup({ includeDb: true }).then(() => fetchMaintenance()))}
                >
                  {loading === 'Create backup' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Archive className="h-3 w-3" />}
                  Create backup
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 w-full justify-start gap-2 text-xs text-destructive hover:text-destructive"
                  disabled={!hasServer || online || loading !== null || activeServer?.isRemote}
                  onClick={() => { setWipePreview(null); setWipeDialog(true) }}
                  title={online ? 'Stop the server before wiping' : 'Delete map / players / world state'}
                >
                  <Trash2 className="h-3 w-3" />
                  Wipe server
                </Button>
                <label className="mt-1 flex cursor-pointer items-center gap-2 border-t border-border/30 px-1 pt-2">
                  <Checkbox
                    id="autoStartServer"
                    checked={autoStartServer}
                    onCheckedChange={(checked) => handleAutoStartChange(checked === true)}
                  />
                  <Label htmlFor="autoStartServer" className="cursor-pointer text-[11px] text-muted-foreground">
                    Auto-start on launch
                  </Label>
                </label>
              </div>
            </section>
          )}

          {bridgeStatus && !bridgeStatus.configured && (
            <section className="rounded-md border border-warning/25 bg-warning/[0.04] p-3">
              <p className="text-xs font-medium text-warning/85">Bridge offline</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Advanced world controls require PanelBridge.{' '}
                <Link to="/settings" className="text-primary hover:underline">Configure bridge</Link>.
              </p>
            </section>
          )}
        </aside>
      </div>

      {/* ─── Confirm dialog ──────────────────────────────────────────────── */}
      <AlertDialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <AlertDialogContent className="glass border-border/50">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-3 text-xl">
              <AlertTriangle className={cn('h-5 w-5', confirmAction?.variant === 'destructive' ? 'text-destructive' : 'text-warning')} />
              {confirmAction?.title}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-base">{confirmAction?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-2">
            <AlertDialogCancel className="mt-0">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(buttonVariants({ variant: confirmAction?.variant === 'destructive' ? 'destructive' : 'warning' }))}
              onClick={async () => { if (confirmAction) { await handleAction(confirmAction.title, confirmAction.action); setConfirmAction(null) } }}
            >
              {confirmAction?.title}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Wipe dialog ─────────────────────────────────────────────────── */}
      <AlertDialog open={wipeDialog} onOpenChange={(open) => { if (!open && !wipeLoading) { setWipeDialog(false); setWipePreview(null) } }}>
        <AlertDialogContent className="glass border-border/50">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-3 text-xl">
              <Trash2 className="h-5 w-5 text-destructive" /> Wipe server
            </AlertDialogTitle>
            <AlertDialogDescription className="text-base">
              Select what data to delete from <span className="font-medium text-foreground">{activeServer?.serverName || 'the active server'}</span>. The server must be stopped.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3 py-2">
            {([
              ['map',      'Map & terrain',       'Chunks, terrain, buildings, zombie population, iso regions.'],
              ['players',  'Players & vehicles',  'Player saves, inventories, positions, vehicle data.'],
              ['world',    'World state',         'World dictionary, metadata, erosion, game object states, radio.'],
              ['accounts', 'Accounts & bans',     'User accounts, passwords, roles, whitelist and ban lists. Everyone re-registers on next join.'],
            ] as const).map(([key, label, desc]) => (
              <label key={key} className="flex cursor-pointer items-start gap-3 rounded-md border border-border/50 p-3 hover:bg-muted/30">
                <Checkbox
                  checked={wipeTargets[key]}
                  disabled={wipeLoading}
                  onCheckedChange={(checked) => { setWipeTargets(prev => ({ ...prev, [key]: checked === true })); setWipePreview(null) }}
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{label}</div>
                  <div className="text-xs text-muted-foreground">{desc}</div>
                </div>
              </label>
            ))}
            <div className="px-3 pb-1 text-xs text-muted-foreground">Selecting map, players and world empties the save folder completely, including anything mods left behind. Server .ini and sandbox settings are stored separately and will not be affected.</div>
          </div>

          {wipePreview && (
            <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
              {wipePreview.totalFiles === 0 ? (
                <div className="text-muted-foreground">No files found for the selected targets.</div>
              ) : (
                <>
                  <div className="font-medium text-destructive">This will permanently delete:</div>
                  {(['map', 'players', 'world', 'leftovers', 'accounts'] as const).map(key => {
                    const data = wipePreview.preview?.[key]
                    if (!data) return null
                    const labels = { map: 'map/terrain', players: 'player/vehicle', world: 'world state', leftovers: 'other leftover', accounts: 'account database' }
                    if (key === 'leftovers') {
                      return data.files > 0
                        ? <div key={key}>{data.files.toLocaleString()} {labels[key]} files ({(data.size / 1024 / 1024).toFixed(1)} MB)</div>
                        : null
                    }
                    return data.files > 0
                      ? <div key={key}>{data.files.toLocaleString()} {labels[key]} files ({(data.size / 1024 / 1024).toFixed(1)} MB)</div>
                      : <div key={key} className="text-muted-foreground">No {labels[key]} files found</div>
                  })}
                  <div className="pt-1 font-medium">Total: {wipePreview.totalFiles.toLocaleString()} files ({(wipePreview.totalSize / 1024 / 1024).toFixed(1)} MB)</div>
                </>
              )}
            </div>
          )}

          <AlertDialogFooter className="gap-2 sm:gap-2">
            <AlertDialogCancel className="mt-0" disabled={wipeLoading} onClick={() => { setWipeDialog(false); setWipePreview(null) }}>Cancel</AlertDialogCancel>
            {!wipePreview ? (
              <Button
                variant="warning"
                disabled={!Object.values(wipeTargets).some(Boolean) || wipeLoading}
                onClick={async () => {
                  if (wipeLoading) return
                  setWipeLoading(true)
                  try {
                    const targets = Object.entries(wipeTargets).filter(([, v]) => v).map(([k]) => k)
                    const res = await serverApi.wipePreview(targets)
                    setWipePreview(res)
                  } catch (e: unknown) {
                    toast({ title: 'Preview failed', description: e instanceof Error ? e.message : 'Could not scan save directory', variant: 'destructive' })
                  } finally { setWipeLoading(false) }
                }}
              >
                {wipeLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Preview
              </Button>
            ) : (
              <Button
                variant="destructive"
                disabled={wipeLoading || wipePreview.totalFiles === 0}
                onClick={async () => {
                  if (wipeLoading) return
                  setWipeLoading(true)
                  try {
                    const targets = Object.entries(wipeTargets).filter(([, v]) => v).map(([k]) => k)
                    await serverApi.wipe(targets)
                    toast({ title: 'Server wiped', description: `Deleted: ${targets.join(', ')}` })
                    setWipeDialog(false); setWipePreview(null)
                  } catch (e: unknown) {
                    toast({ title: 'Wipe failed', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' })
                  } finally { setWipeLoading(false) }
                }}
              >
                {wipeLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                Wipe now
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
