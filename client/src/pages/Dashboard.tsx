import { lazy, Suspense, useEffect, useState, useCallback, useRef } from 'react'
import type { ReactElement } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { usePageShortcut } from '../hooks/useKeyboardShortcuts'
import {
  Play, Square, RotateCcw, Save, Server, Wifi, Loader2, AlertTriangle, RefreshCw, AlertCircle,
  LogIn, LogOut, Activity, Archive, Skull, Sword, ShieldAlert, Copy, Gamepad2, Globe, FolderOpen,
  X, MoreHorizontal, Zap, Trash2, Download, Sparkles, CalendarClock, Monitor, ScrollText,
} from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
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
import { resolveClientProvider } from '@/lib/serverStatus'
import { useSocket } from '@/contexts/SocketContext'
import { useAuth } from '@/contexts/AuthContext'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Progress } from '@/components/ui/progress'
import { Label } from '@/components/ui/label'
import { HelpTip } from '@/components/HelpTip'
import { DisabledReason } from '@/components/DisabledReason'
import { AutoUpdateResultBanner } from '@/components/AutoUpdateResultBanner'
import { cn, copyText } from '@/lib/utils'
import { getUserErrorMessage, getRecoveryUrl } from '@/lib/errorMessage'
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
  hostSwapUsedGB?: number; hostSwapTotalGB?: number
}

const DashboardPerformanceCharts = lazy(() => import('@/components/DashboardPerformanceCharts'))
const DASHBOARD_ONBOARDING_DISMISSED_KEY = 'pz-dashboard-onboarding-dismissed-v1'

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

// These helpers live outside the component and can't use the useTranslation
// hook, so `t` is threaded through as a parameter instead — each is called
// from inside the component body, where `t` is already in scope.
function getDashboardSuccessCopy(t: TFunction<'dashboard'>, action: string) {
  switch (action) {
    case 'Start server':   return { title: t('successCopy.startServer.title'), description: t('successCopy.startServer.description') }
    case 'Stop server':    return { title: t('successCopy.stopServer.title'), description: t('successCopy.stopServer.description') }
    case 'Force stop server': return { title: t('successCopy.forceStopServer.title'), description: t('successCopy.forceStopServer.description') }
    case 'Restart server': return { title: t('successCopy.restartServer.title'), description: t('successCopy.restartServer.description') }
    case 'Restart server now': return { title: t('successCopy.restartServerNow.title'), description: t('successCopy.restartServerNow.description') }
    case 'Save world':     return { title: t('successCopy.saveWorld.title'), description: t('successCopy.saveWorld.description') }
    case 'Create backup':  return { title: t('successCopy.createBackup.title'), description: t('successCopy.createBackup.description') }
    case 'Connect RCON':   return { title: t('successCopy.connectRcon.title'), description: t('successCopy.connectRcon.description') }
    default:               return { title: t('successCopy.defaultTitle'), description: t('successCopy.defaultDescription', { action }) }
  }
}

// Force Stop attempts a bounded, fail-open save before killing the server
// (server.js's attemptBoundedSaveBeforeForceStop) and reports the outcome as
// saveOutcome on every response shape. "saved" uses the plain success copy
// (getDashboardSuccessCopy above) -- this only covers the other three, which
// must NOT be collapsed into one message: "the save was refused" and "the
// save didn't answer in time" mean different things about server state, and
// "skipped" has to say why rather than reading as a silent nothing. Returns
// null for "saved" or an unrecognized/absent value, telling the caller to
// fall through to the generic success toast instead.
export function getForceStopSaveOutcomeCopy(t: TFunction<'dashboard'>, saveOutcome: string | undefined) {
  switch (saveOutcome) {
    case 'failed':   return { title: t('successCopy.forceStopSaveFailed.title'), description: t('successCopy.forceStopSaveFailed.description') }
    case 'timedOut': return { title: t('successCopy.forceStopSaveTimedOut.title'), description: t('successCopy.forceStopSaveTimedOut.description') }
    case 'skipped':  return { title: t('successCopy.forceStopSaveSkipped.title'), description: t('successCopy.forceStopSaveSkipped.description') }
    default:         return null
  }
}

// 2026-08-26: unreachable for every current handleAction() caller (serverApi
// .start/.save, rconApi.connect, backupApi.createBackup) -- each resolves
// through apiPost, and lib/api.ts's handleResponse() already throws on any
// 200 body with success: false before this function's own .then() branch
// could ever see it (see the same note on Console.tsx/Events.tsx/etc.,
// which document the same centralized mechanism for their own call sites).
// Kept, and commented rather than deleted, because a check that WOULD fire
// if a future caller ever bypassed apiPost is a trap, not a safety net: it
// throws a bare Error with no status/code, which getUserErrorMessage()
// cannot translate -- strictly worse than what the live apiPost path
// already does automatically today. If this ever starts actually firing,
// that is a sign a new handleAction() caller skipped apiPost, not that this
// check earned its keep.
function isFailedActionResult(value: unknown): value is { success: false; error?: string; message?: string } {
  return typeof value === 'object'
    && value !== null
    && 'success' in value
    && (value as { success?: boolean }).success === false
}

function formatAge(t: TFunction<'dashboard'>, iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1)  return t('age.justNow')
  if (mins < 60) return t('age.minutesAgo', { count: mins })
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return t('age.hoursAgo', { count: hrs })
  return t('age.daysAgo', { count: Math.floor(hrs / 24) })
}

/** Like formatAge, but phrased as "since joined" rather than "X ago" -- kept
 * as its own function instead of deriving it from formatAge's output with
 * string manipulation, since stripping a hardcoded " ago" suffix silently
 * breaks the moment formatAge returns translated text. */
function formatSinceJoined(t: TFunction<'dashboard'>, iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return t('age.justJoined')
  if (mins < 60) return t('age.forMinutes', { count: mins })
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return t('age.forHours', { count: hrs })
  return t('age.forDays', { count: Math.floor(hrs / 24) })
}

/** Countdown to a future moment. Returns null once the moment has passed. */
function formatEta(t: TFunction<'dashboard'>, iso: string): string | null {
  const ms = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(ms) || ms < 0) return null
  const mins = Math.round(ms / 60000)
  if (mins < 1) return t('eta.anyMoment')
  if (mins < 60) return t('eta.inMinutes', { count: mins })
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  if (hrs < 24) return rem ? t('eta.inHoursMinutes', { hours: hrs, minutes: rem }) : t('eta.inHours', { count: hrs })
  return t('eta.inDays', { count: Math.floor(hrs / 24) })
}

function eventStyle(t: TFunction<'dashboard'>, action: string) {
  switch (action) {
    case 'connect':    return { icon: <LogIn       className="h-3 w-3" />, tone: 'text-success',         verb: t('liveActivity.verbs.joined') }
    case 'disconnect': return { icon: <LogOut      className="h-3 w-3" />, tone: 'text-destructive/85',  verb: t('liveActivity.verbs.left') }
    case 'death':      return { icon: <Skull       className="h-3 w-3" />, tone: 'text-warning',         verb: t('liveActivity.verbs.died') }
    case 'pvp_kill':   return { icon: <Sword       className="h-3 w-3" />, tone: 'text-warning',         verb: t('liveActivity.verbs.killed') }
    case 'ban':        return { icon: <ShieldAlert className="h-3 w-3" />, tone: 'text-destructive',     verb: t('liveActivity.verbs.banned') }
    case 'kick':       return { icon: <AlertCircle className="h-3 w-3" />, tone: 'text-warning',         verb: t('liveActivity.verbs.kicked') }
    // Raw log actions read as SCREAMING_SNAKE. Say them like words. Not
    // translated -- these are ad-hoc identifiers from scheduler/mod logs,
    // not a closed set of known verbs.
    default:           return { icon: <Activity    className="h-3 w-3" />, tone: 'text-muted-foreground', verb: action.replace(/_/g, ' ').toLowerCase() }
  }
}

/**
 * Connection LED row.
 */
function ConnLine({
  label, state, value, hint,
}: { label: string; state: 'on' | 'off' | 'wait'; value?: string; hint?: string }) {
  const { t } = useTranslation('dashboard')
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
        {value ?? (state === 'on' ? t('connLine.connected') : state === 'wait' ? t('connLine.pending') : t('connLine.offline'))}
      </span>
      {hint && <span className="shrink-0 font-mono text-[10px] text-muted-foreground/50">{hint}</span>}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Dashboard                                                                 */
/* -------------------------------------------------------------------------- */

export default function Dashboard() {
  const { t, i18n } = useTranslation('dashboard')
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
    // actionId is the stable, untranslated key getDashboardSuccessCopy()
    // switches on and handleAction() uses for its `loading === ...` checks.
    // title is the translated text actually shown in the dialog -- they
    // used to be the same string, which would have broken the switch the
    // moment the dialog title was translated to anything but English.
    actionId: string; title: string; description: string
    action: () => Promise<unknown>
    variant?: 'destructive' | 'warning'
  } | null>(null)
  const [wipeDialog, setWipeDialog] = useState(false)
  const [wipeTargets, setWipeTargets] = useState<Record<string, boolean>>({ map: true, players: true, world: true, accounts: false })
  const [wipePreview, setWipePreview] = useState<{
    totalFiles: number; totalSize: number
    preview: Record<string, { files: number; size: number }>
    truncated?: boolean
  } | null>(null)
  const [wipeLoading, setWipeLoading] = useState(false)
  // Defaults to true, same as ChunkCleaner.tsx's chunk-delete backup switch --
  // the panel already has one convention for "destructive delete backs up
  // first unless you opt out," this just applies it here too.
  const [wipeCreateBackup, setWipeCreateBackup] = useState(true)
  const [wipeBackupProgress, setWipeBackupProgress] = useState<{
    phase: string; percent: number; message: string
  } | null>(null)

  const { toast } = useToast()
  const socket = useSocket()
  const navigate = useNavigate()
  const { can } = useAuth()
  // server.control gates Start/Stop/Force-Stop/Restart/Restart-Now/Save
  // (server/routes/server.js) -- one capability behind six triggers on this
  // page. server.wipe is a SEPARATE, more dangerous capability (server.js's
  // /wipe and /wipe/preview) -- holding server.control must never unlock
  // the Wipe control. can() fails open on unknown/null capabilities, same
  // convention as every other capability check in the app.
  const canControlServer = can('server.control')
  const canWipeServer = can('server.wipe')

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

  // Surfaces backupService's pre-wipe backup progress inside the wipe dialog.
  // `backup:progress` is a single global event (see Backups.tsx's identical
  // listener) with no id tying it to a specific caller -- gating on
  // wipeLoading is safe because backupService only ever runs one backup at a
  // time (its own internal mutex refuses a second), so any event that lands
  // while a wipe request is in flight is this wipe's own backup.
  useEffect(() => {
    if (!socket) return
    const handleBackupProgress = (data: { phase: string; percent: number; message: string }) => {
      if (!wipeLoading) return
      setWipeBackupProgress(data)
    }
    socket.on('backup:progress', handleBackupProgress)
    return () => { socket.off('backup:progress', handleBackupProgress) }
  }, [socket, wipeLoading])

  const copyToClipboard = async (text: string, label: string) => {
    try { await copyText(text); toast({ title: t('toasts.copied'), description: t('toasts.copiedDesc', { label }), duration: 2000 }) }
    catch { toast({ title: t('toasts.copyFailedTitle'), description: t('toasts.copyFailedDesc'), variant: 'destructive' }) }
  }

  const dismissQuickStart = () => {
    setShowQuickStart(false)
    try { localStorage.setItem(DASHBOARD_ONBOARDING_DISMISSED_KEY, 'true') } catch { /* ignore storage failures */ }
  }

  /* ---------------------------- fetchers ---------------------------------- */
  const fetchStatus = useCallback(async () => {
    try { const data = await serverApi.getStatus(); setStatus(data); setFetchError(null); setLastUpdated(new Date()) }
    catch { setFetchError(t('errors.failedToConnect')) }
  }, [t])

  const fetchComposedStatus = useCallback(async () => {
    try { setComposedStatus(await serversApi.getComposedStatus()) }
    catch { setComposedStatus(null) }
  }, [])

  usePageShortcut('r', () => { if (loading === null) { fetchStatus(); fetchComposedStatus() } })

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
          time: new Date(h.timestamp as string).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' }),
          timestamp: h.timestamp as string,
          playerCount: (h.playerCount as number) || 0,
          memoryMB: Math.round(((h.memoryUsed as number) || 0) / (1024 * 1024)),
          pzMemMB: h.pzMemUsed ? Math.round((h.pzMemUsed as number) / (1024 * 1024)) : undefined,
          cpuPercent: h.cpuUsage != null ? Math.round(h.cpuUsage as number) : undefined,
          hostMemUsedGB: h.hostMemUsed ? +((h.hostMemUsed as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
          hostMemTotalGB: h.hostMemTotal ? +((h.hostMemTotal as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
          hostDiskUsedGB: h.hostDiskUsed ? +((h.hostDiskUsed as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
          hostDiskTotalGB: h.hostDiskTotal ? +((h.hostDiskTotal as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
          // != null, not truthy: a real 0 (swap genuinely not configured) is
          // the answer this feature exists to surface, and must survive this
          // mapping rather than collapsing to undefined ("could not
          // determine") the way a truthy check would.
          hostSwapUsedGB: h.hostSwapUsed != null ? +((h.hostSwapUsed as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
          hostSwapTotalGB: h.hostSwapTotal != null ? +((h.hostSwapTotal as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
        })))
      }
    } catch {
      // Ignore missing telemetry history so the rest of the dashboard can render.
    }
  }, [i18n.language])
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
      await configApi.updateAppSettings({ autoStartServer: checked })
      toast({
        title: checked ? t('toasts.autoStartEnabledTitle') : t('toasts.autoStartDisabledTitle'),
        description: checked ? t('toasts.autoStartEnabledDesc') : t('toasts.autoStartDisabledDesc'),
      })
    } catch (error) {
      setAutoStartServer(!checked)
      toast({ title: t('toasts.errorTitle'), description: error instanceof Error ? error.message : t('toasts.autoStartSaveFailed'), variant: 'destructive' })
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
      } catch { setFetchError(t('errors.failedToLoad')); setInitialLoading(false) }
    }
    load()

    const loadingTimeout = setTimeout(() => {
      if (initialLoadingRef.current) {
        setFetchError((c) => c ?? t('errors.takingLongerThanExpected'))
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
      fetchAutoStartSetting, fetchActiveServer, fetchMaintenance, t])

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
        time: new Date().toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' }),
        timestamp: new Date().toISOString(),
        playerCount: (snap.playerCount as number) || 0,
        memoryMB: Math.round(((snap.memoryUsed as number) || 0) / (1024 * 1024)),
        pzMemMB: snap.pzMemUsed ? Math.round((snap.pzMemUsed as number) / (1024 * 1024)) : undefined,
        cpuPercent: snap.cpuUsage != null ? Math.round(snap.cpuUsage as number) : undefined,
        hostMemUsedGB: snap.hostMemUsed ? +((snap.hostMemUsed as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
        hostMemTotalGB: snap.hostMemTotal ? +((snap.hostMemTotal as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
        hostDiskUsedGB: snap.hostDiskUsed ? +((snap.hostDiskUsed as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
        hostDiskTotalGB: snap.hostDiskTotal ? +((snap.hostDiskTotal as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
        // != null, not truthy -- see the identical comment in
        // fetchPerformanceHistory above.
        hostSwapUsedGB: snap.hostSwapUsed != null ? +((snap.hostSwapUsed as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
        hostSwapTotalGB: snap.hostSwapTotal != null ? +((snap.hostSwapTotal as number) / (1024 * 1024 * 1024)).toFixed(1) : undefined,
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
  }, [socket, showPerformanceCharts, i18n.language])

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        fetchStatus(); fetchPlayers(); fetchBridgeStatus(); fetchPlayerActivity()
        if (showPerformanceCharts) fetchPerformanceHistory()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [fetchStatus, fetchPlayers, fetchBridgeStatus, fetchPlayerActivity, fetchPerformanceHistory, showPerformanceCharts])

  /* ---------------------------- actions ----------------------------------- */
  // errorAction lets one call site attach a toast action button specific to
  // the error it got back (e.g. "Open Servers" only for a fixable RCON
  // failure) without every OTHER handleAction caller needing to know it
  // exists -- returning undefined (the default for anyone who doesn't pass
  // it) renders no action, identical to today's behavior.
  const handleAction = async (
    action: string,
    fn: () => Promise<unknown>,
    options?: { errorAction?: (error: unknown) => ReactElement | undefined },
  ) => {
    setLoading(action)
    try {
      const result = await fn()
      if (isFailedActionResult(result)) {
        throw new Error(result.error || result.message || t('toasts.actionFailedFallback'))
      }
      const copy = getDashboardSuccessCopy(t, action)
      // 2026-08-26 bug hunt: POST /start regenerates the startup script on
      // every stopped-to-started transition and now backs up + reports any
      // existing content it didn't itself last write (a hand-edit, or a
      // pre-fix install) instead of silently discarding it. A silent log
      // line is what let that go unnoticed in the first place, so this gets
      // its own toast rather than folding into the generic success copy.
      const scriptWarnings = action === 'Start server' && result && typeof result === 'object'
        ? (result as { scriptWarnings?: string[] }).scriptWarnings
        : undefined
      // 2026-08-26 bug hunt: POST /stop used to report success:true (and this
      // toast used to say "Server stopped") the instant rconService.quit()
      // returned -- which only proves PZ accepted the quit command, not that
      // its save-and-exit has actually finished. Now the server marks this
      // response confirmed:false for exactly that case, so the toast can
      // stop claiming completion it doesn't have; the real "stopped" state
      // still arrives over the socket (Layout.tsx's status listener) once
      // the watchdog genuinely observes the process gone.
      const stopUnconfirmed = action === 'Stop server' && result && typeof result === 'object'
        && (result as { confirmed?: boolean }).confirmed === false
      // 2026-08-26 bug hunt: Force Stop now attempts a bounded, fail-open save
      // before killing the server (server.js's attemptBoundedSaveBeforeForceStop)
      // and reports the outcome as saveOutcome -- but the generic success toast
      // read nothing from the response, so a failed/timed-out/skipped save was
      // reported identically to a genuine save. "saved" still uses the plain
      // success copy below; the other three get their own warning-tier toast
      // (this operation's outer action DID succeed -- the server IS stopped --
      // so destructive-red would overstate it, and folding into success would
      // hide the one thing an operator needs to know after a force-stop).
      const forceStopSaveOutcome = action === 'Force stop server' && result && typeof result === 'object'
        ? (result as { saveOutcome?: string }).saveOutcome
        : undefined
      const forceStopOutcomeCopy = getForceStopSaveOutcomeCopy(t, forceStopSaveOutcome)
      if (scriptWarnings && scriptWarnings.length > 0) {
        toast({
          title: t('successCopy.startServerScriptBackup.title'),
          description: `${t('successCopy.startServerScriptBackup.description')} ${scriptWarnings.join(' ')}`,
          variant: 'success' as const,
        })
      } else if (stopUnconfirmed) {
        toast({
          title: t('successCopy.stopServerRequested.title'),
          description: t('successCopy.stopServerRequested.description'),
          variant: 'success' as const,
        })
      } else if (forceStopOutcomeCopy) {
        toast({ title: forceStopOutcomeCopy.title, description: forceStopOutcomeCopy.description, variant: 'warning' as const })
      } else {
        toast({ title: copy.title, description: copy.description, variant: 'success' as const })
      }
      if (action === 'Start server') {
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
        let attempts = 0
        pollIntervalRef.current = setInterval(async () => {
          attempts++
          try {
            const data = await serverApi.getStatus()
            setStatus(data)
            if (data?.running || attempts >= 15) {
              if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null }
            }
          } catch {
            if (attempts >= 15 && pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current); pollIntervalRef.current = null
            }
          }
        }, 2000)
      } else { fetchStatus() }
    } catch (error) {
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('toasts.actionFailedFallback')),
        variant: 'destructive',
        action: options?.errorAction?.(error),
      })
    } finally { setLoading(null) }
  }
  // Two of the six server.control triggers on this page (this Start button,
  // and the verdict band's shortcut for the same action below) call
  // handleAction() directly with no confirm dialog in between -- guarded
  // here, inside the function, not just on the buttons that call it. Same
  // lesson as Console.tsx's Enter-key path: a disabled attribute is an
  // affordance, the function guard is the actual gate.
  const startServer = () => {
    if (!canControlServer) return
    void handleAction('Start server', serverApi.start)
  }
  const saveWorld = () => {
    if (!canControlServer) return
    void handleAction('Save world', serverApi.save)
  }
  const handleConnect = async () => {
    await handleAction('Connect RCON', () => rconApi.connect(), {
      // getRecoveryUrl (lib/errorMessage.ts) is the single place that knows
      // RCON_CONNECT_AUTH_FAILED is fixable from Servers while
      // RCON_CONNECT_UNREACHABLE (install-level: server not running,
      // firewall never opened) isn't fixable from any in-app screen --
      // reusing it here instead of re-deriving that same classification
      // inline is what keeps the two from drifting apart the way
      // routes/rcon.js's OWN two error-reporting paths once did tonight.
      errorAction: (error) => {
        const url = getRecoveryUrl(error)
        if (url !== '/servers') return undefined
        return (
          <ToastAction altText={t('toasts.rconAuthFailed.openServersAlt')} onClick={() => navigate(url)}>
            {t('toasts.rconAuthFailed.openServers')}
          </ToastAction>
        )
      },
    })
  }

  /* ---------------------------- loading ----------------------------------- */
  if (initialLoading) {
    return (
      <div className="page-transition">
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
          <RefreshCw className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">{t('loading')}</p>
        </div>
      </div>
    )
  }

  /* ---------------------------- derived ----------------------------------- */
  const hasServer = !!activeServer
  // GH#114: status.running is a local process scan -- it can only ever see a
  // process in *this* container/host. That's a valid, freshest signal for a
  // native server, but for docker-local/docker-managed the mapped process
  // runs in a DIFFERENT container, so the scan always finds nothing and
  // (because isRemote is false for a Docker provider too, not just native)
  // used to win the ?? chain below over the provider-aware composedStatus --
  // a Docker container correctly shown running in the Docker panel could
  // still read "down" on this exact same page. isRemote only distinguishes
  // remote-SFTP from everything else; it was never a "this process is local
  // to this container" proxy, which is what this check actually needs.
  const provider = composedStatus?.provider ?? resolveClientProvider(activeServer)
  const localProcessStatus = provider === 'native' && typeof status?.running === 'boolean'
    ? status.running
    : null
  const hostRunning = hasServer && (localProcessStatus ?? (composedStatus ? composedStatus.host.status === 'running' : !!status?.running))
  const rconConnected = composedStatus
    ? composedStatus.server.status === 'connected'
    : Boolean(status?.rcon?.connected)
  const bridgeActive = composedStatus?.bridge.status === 'active'
  const hostUnknown = composedStatus ? ['unknown', 'not-applicable'].includes(composedStatus.host.status) : false
  const online = hasServer && (localProcessStatus ?? (composedStatus ? hostRunning || rconConnected || bridgeActive : !!status?.running))
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
    return { name: player.name, since: formatSinceJoined(t, joined) }
  })

  /* One verdict at a time, highest severity wins. Calm states say nothing at all. */
  const verdict: Verdict = (() => {
    if (!hasServer || (status && !status.configured)) {
      return {
        level: 'warning',
        headline: t('verdict.noServerConfigured'),
        action: { label: t('verdict.openSetup'), to: '/server-setup' },
      }
    }
    if (fetchError) {
      return {
        level: 'critical',
        headline: t('verdict.panelCannotReach'),
        detail: fetchError,
        action: { label: t('verdict.retry'), onClick: () => { void fetchStatus() } },
      }
    }
    if (!online) {
      return {
        level: hostUnknown ? 'warning' : 'critical',
        headline: hostUnknown ? t('verdict.serverStatusUnknown') : t('verdict.serverStopped'),
        // Omit the shortcut entirely rather than show it disabled with no
        // explanation -- VerdictAction has no reason/tooltip support, same
        // treatment isRemote/hostUnknown already get here. The header Start
        // button (which DOES carry a DisabledReason) remains the explained
        // affordance for why this operator can't start the server.
        action: hostUnknown || activeServer?.isRemote || !canControlServer
          ? undefined
          : {
              label: t('actions.start'),
              onClick: startServer,
              busy: loading === 'Start server',
              disabled: loading !== null,
            },
      }
    }
    if (!rconConnected) {
      return {
        level: 'warning',
        headline: t('verdict.rconDisconnected'),
        headlineHelp: (
          <HelpTip label={t('verdict.rconHelpLabel')} className="ml-1.5 align-[-2px]">
            {t('verdict.rconHelpTip')}
          </HelpTip>
        ),
        action: {
          label: t('actions.connectRcon'),
          onClick: () => { void handleConnect() },
          busy: loading === 'Connect RCON',
          disabled: loading !== null,
        },
      }
    }
    if (hostMemoryRatio != null && hostMemoryRatio >= 0.9) {
      return {
        level: 'critical',
        headline: t('verdict.hostMemory', { percent: Math.round(hostMemoryRatio * 100) }),
      }
    }
    /* A full disk corrupts saves and fails backups, so it outranks a busy CPU. */
    if (diskRatio != null && diskFreeGB != null && diskRatio >= 0.95) {
      return {
        level: 'critical',
        headline: t('verdict.diskAlmostFull', { gb: diskFreeGB.toFixed(0) }),
      }
    }
    if (diskRatio != null && diskFreeGB != null && diskRatio >= 0.9) {
      return {
        level: 'warning',
        headline: t('verdict.diskPercent', { percent: Math.round(diskRatio * 100), gb: diskFreeGB.toFixed(0) }),
      }
    }
    if (hostCpu != null && hostCpu >= 90) {
      return {
        level: 'warning',
        headline: t('verdict.hostCpu', { percent: hostCpu }),
      }
    }
    if (bridgeStatus?.configured && !bridgeStatus.modConnected) {
      return {
        level: 'warning',
        headline: t('verdict.bridgeOffline'),
        action: { label: t('verdict.bridgeSettingsLink'), to: '/settings' },
      }
    }
    if (modsPending) {
      return {
        level: 'warning',
        headline: t('verdict.modUpdatesWaiting', { count: maintenance.modUpdatesAvailable }),
        action: { label: t('verdict.reviewMods'), to: '/mods' },
      }
    }
    /* Game errors are reported by the Errors row, which is already coloured by
       severity. Repeating the count here would say the same thing twice. */
    if (maintenance.schedulerLoaded && maintenance.backupCount === 0 && !activeServer?.isRemote) {
      return {
        level: 'warning',
        headline: t('verdict.noBackups'),
        action: {
          label: t('actions.createBackup'),
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
    ? t('workItems.backupsStoredLast', { count: maintenance.backupCount, age: formatAge(t, maintenance.lastBackup.created) })
    : maintenance.backupCount > 0
      ? t('workItems.backupsStored', { count: maintenance.backupCount })
      : t('workItems.backupsNoneYet')

  /* A count of tasks is trivia. The next time something will happen is the
     thing that decides whether you can walk away from the server. */
  const nextRunEta = maintenance.nextRun ? formatEta(t, maintenance.nextRun.at) : null
  const scheduleState = nextRunEta && maintenance.nextRun
    ? `${maintenance.nextRun.label} ${nextRunEta}`
    : maintenance.scheduledTasksCount > 0
      ? t('workItems.scheduleActive', { count: maintenance.scheduledTasksCount })
      : t('workItems.scheduleNoneActive')

  const errorCount = maintenance.errorCount

  const workItems: WorkItem[] = [
    {
      to: '/players', icon: Activity, label: t('workItems.players'),
      state: online ? String(players.length) : t('liveActivity.offline'),
      tone: !online ? 'bad' : players.length > 0 ? 'good' : 'default',
    },
    {
      to: '/console', icon: Wifi, label: t('workItems.console'),
      state: status?.rcon?.connected ? t('workItems.rconReady') : t('workItems.rconOffline'),
      tone: status?.rcon?.connected ? 'good' : 'warning',
    },
    {
      to: '/mods', icon: Gamepad2, label: t('workItems.mods'),
      state: modsPending ? t('workItems.modsToUpdate', { count: maintenance.modUpdatesAvailable }) : t('workItems.modsTracked', { count: maintenance.modsTracked }),
      tone: modsPending ? 'warning' : 'default',
    },
    {
      to: '/scheduler', icon: CalendarClock, label: t('workItems.schedule'),
      state: scheduleState,
      tone: nextRunEta ? 'good' : maintenance.scheduledTasksCount > 0 ? 'good' : 'default',
    },
    ...(errorCount != null ? [{
      to: '/console', icon: ScrollText, label: t('workItems.errors'),
      state: errorCount === 0 ? t('workItems.errorsNone') : t('workItems.errorsLogged', { count: errorCount }),
      tone: errorCount === 0 ? 'good' : errorCount >= 50 ? 'warning' : 'default',
    } as WorkItem] : []),
    {
      to: '/backups', icon: Archive, label: t('workItems.backups'),
      state: backupState,
      tone: maintenance.backupCount === 0 ? 'warning' : 'good',
    },
    { to: '/server-config', icon: Server, label: t('workItems.config') },
  ]

  /* ====================================================================== */
  /*  RENDER                                                                  */
  /* ====================================================================== */
  return (
    <div className="page-transition pb-12">
      <AutoUpdateResultBanner />
      {/* ─── TOP STATUS BAR ───────────────────────────────────────── */}
      <header
        aria-label={t('header.ariaLabel')}
        className="overflow-hidden rounded-lg border border-border/55 bg-card/45 shadow-sm"
      >
        {/* Main row */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
          {/* Identity cluster: status + name + uptime */}
          <div className="flex min-w-0 items-center gap-3">
            {/* One light for the whole page: green calm, amber attention, red broken. */}
            <span
              className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center"
              title={verdict.headline ?? t('header.everythingNominal')}
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
              <span className="sr-only">{verdict.headline ?? t('header.everythingNominal')}</span>
            </span>

            <h1 className="min-w-0 truncate font-mono text-base font-semibold text-foreground" title={activeServer?.serverName ?? t('header.noActiveServer')}>
              {activeServer?.serverName ?? t('header.noActiveServer')}
            </h1>

            {/* Uptime */}
            {online && status && status.uptime > 0 && (
              <span className="hidden font-mono text-[11px] tabular-nums text-muted-foreground/60 sm:inline">
                {t('header.upPrefix', { uptime: formatUptime(status.uptime) })}
              </span>
            )}
            {activeServer?.isRemote && (
              <span className="rounded-sm bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t('header.remoteBadge')}</span>
            )}
          </div>

          {/* Address cluster — grouped, distinct background */}
          <div className="order-3 -mx-4 -mb-3 flex w-[calc(100%+2rem)] flex-wrap items-center gap-1 border-t border-border/30 bg-background/20 px-3 py-1.5">
            {status?.localIp && (
              <button
                onClick={() => copyToClipboard(`${status.localIp}${status.port ? `:${status.port}` : ''}`, t('addresses.lan.copyLabel'))}
                className="group inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                aria-label={t('addresses.lan.copyAria', { address: `${status.localIp}${status.port ? `:${status.port}` : ''}` })}
                title={t('addresses.lan.tooltip')}
              >
                <Wifi className="h-3 w-3 text-emerald-500/70" />
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-foreground/45">{t('addresses.lan.label')}</span>
                <span className="font-mono text-[11px] tabular-nums">{status.localIp}{status.port ? `:${status.port}` : ''}</span>
                <Copy className="h-2.5 w-2.5 shrink-0 opacity-35 transition-opacity group-hover:opacity-70" />
              </button>
            )}
            {status?.publicIp && (
              <button
                onClick={() => copyToClipboard(`${status.publicIp}${status.port ? `:${status.port}` : ''}`, t('addresses.wan.copyLabel'))}
                className="group inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                aria-label={t('addresses.wan.copyAria', { address: `${status.publicIp}${status.port ? `:${status.port}` : ''}` })}
                title={t('addresses.wan.tooltip')}
              >
                <Globe className="h-3 w-3 text-amber-500/70" />
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-foreground/45">{t('addresses.wan.label')}</span>
                <span className="font-mono text-[11px] tabular-nums">{status.publicIp}{status.port ? `:${status.port}` : ''}</span>
                <Copy className="h-2.5 w-2.5 shrink-0 opacity-35 transition-opacity group-hover:opacity-70" />
              </button>
            )}
            {panelInfo && (
              <button
                onClick={() => copyToClipboard(panelInfo.url, t('addresses.panel.copyLabel'))}
                className="group inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                aria-label={t('addresses.panel.copyAria', { address: panelInfo.url })}
                title={t('addresses.panel.tooltip')}
              >
                <Monitor className="h-3 w-3 text-primary/70" />
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-foreground/45">{t('addresses.panel.label')}</span>
                <span className="font-mono text-[11px] tabular-nums">{panelInfo.localIp}:{panelInfo.port}</span>
                <Copy className="h-2.5 w-2.5 shrink-0 opacity-35 transition-opacity group-hover:opacity-70" />
              </button>
            )}
            {status?.publicIp && status?.port && (
              <a
                href={`steam://connect/${status.publicIp}:${status.port}`}
                className="inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
                aria-label={t('addresses.join.aria', { address: `${status.publicIp}:${status.port}` })}
                title={t('addresses.join.tooltip')}
              >
                <Gamepad2 className="h-3 w-3 text-blue-400/70" />
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em]">{t('addresses.join.label')}</span>
              </a>
            )}
          </div>

          {/* primary controls — right-aligned */}
          <div className="order-2 ml-auto flex flex-wrap justify-end gap-1">
          {!online ? (
            <DisabledReason reason={
              !hasServer ? t('actions.addServerFirst')
              : activeServer?.isRemote ? t('actions.notAvailableRemote')
              : !canControlServer ? t('actions.noPermissionControl')
              : null
            }>
              <Button
                onClick={startServer}
                disabled={!hasServer || hostUnknown || loading !== null || activeServer?.isRemote || !canControlServer}
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 rounded-md border border-emerald-500/30 px-2.5 text-xs text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300 disabled:border-border/50 disabled:text-muted-foreground"
              >
                {loading === 'Start server' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                {t('actions.start')}
              </Button>
            </DisabledReason>
          ) : (
            <>
              <DisabledReason reason={!canControlServer ? t('actions.noPermissionControl') : null}>
                <Button
                  onClick={() => setConfirmAction({
                    actionId: 'Stop server',
                    title: t('confirm.stopServer.title'),
                    description: t('confirm.stopServer.description'),
                    action: serverApi.stop,
                    // Same severity class as the adjacent graceful Restart
                    // button (reversible, comes back with a click) -- was
                    // styled destructive-red while Restart uses warning-amber
                    // for the same "disconnects players, nothing is lost"
                    // outcome. Matches Restart's precedent instead of
                    // inventing a third tier.
                    variant: 'warning',
                  })}
                  disabled={loading !== null || !hostRunning || !canControlServer}
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 rounded-md border border-red-500/30 px-2.5 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300 disabled:border-border/50 disabled:text-muted-foreground"
                >
                  {loading === 'Stop server' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                  {t('actions.stop')}
                </Button>
              </DisabledReason>
              <DisabledReason reason={activeServer?.isRemote ? t('actions.notAvailableRemote') : !canControlServer ? t('actions.noPermissionControl') : null}>
                <Button
                  onClick={() => setConfirmAction({
                    actionId: 'Force stop server',
                    title: t('confirm.forceStopServer.title'),
                    description: t('confirm.forceStopServer.description') + (players.length > 0 ? t('confirm.forceStopServer.descriptionPlayers', { count: players.length }) : ''),
                    action: serverApi.forceStop,
                    variant: 'destructive',
                  })}
                  disabled={loading !== null || !hostRunning || activeServer?.isRemote || !canControlServer}
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 rounded-md border border-red-500/30 px-2.5 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300 disabled:border-border/50 disabled:text-muted-foreground"
                  title={activeServer?.isRemote ? undefined : t('actions.forceStopTooltip')}
                >
                  {loading === 'Force stop server' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Skull className="h-3.5 w-3.5" />}
                  {t('actions.forceStop')}
                </Button>
              </DisabledReason>
              <DisabledReason reason={activeServer?.isRemote ? t('actions.notAvailableRemote') : !canControlServer ? t('actions.noPermissionControl') : null}>
                <Button
                  onClick={() => setConfirmAction({
                    actionId: 'Restart server',
                    title: t('confirm.restartServer.title'),
                    description: t('confirm.restartServer.description'),
                    action: () => serverApi.restart(5),
                    variant: 'warning',
                  })}
                  disabled={loading !== null || !hostRunning || activeServer?.isRemote || !canControlServer}
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 rounded-md border border-amber-500/30 px-2.5 text-xs text-amber-400 hover:bg-amber-500/10 hover:text-amber-300 disabled:border-border/50 disabled:text-muted-foreground"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> {t('actions.restart')}
                </Button>
              </DisabledReason>
              <DisabledReason reason={!canControlServer ? t('actions.noPermissionControl') : null}>
                <Button
                  onClick={saveWorld}
                  disabled={loading !== null || !rconConnected || !canControlServer}
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 rounded-md border border-sky-500/30 px-2.5 text-xs text-sky-400 hover:bg-sky-500/10 hover:text-sky-300 disabled:border-border/50 disabled:text-muted-foreground"
                >
                  <Save className="h-3.5 w-3.5" /> {t('actions.save')}
                </Button>
              </DisabledReason>
            </>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="h-8 w-8 border-border/60 text-muted-foreground hover:text-foreground" aria-label={t('actions.moreActionsAria')}>
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => handleAction('Create backup', () => backupApi.createBackup({ includeDb: true }).then(() => fetchMaintenance()))}
                disabled={!hasServer || loading !== null || activeServer?.isRemote}
              >
                <Archive className="mr-2 h-4 w-4" /> {t('actions.createBackup')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={fetchStatus}>
                <RefreshCw className="mr-2 h-4 w-4" /> {t('actions.refreshStatus')}
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/settings" className="flex items-center"><Server className="mr-2 h-4 w-4" /> {t('actions.bridgeSettings')}</Link>
              </DropdownMenuItem>
              {!rconConnected && (
                <DisabledReason
                  className="w-full"
                  reason={
                    !hasServer
                      ? t('actions.addServerFirst')
                      : !activeServer?.isRemote && !hostRunning
                        ? t('actions.connectRconNeedsHostRunning')
                        : null
                  }
                >
                  <DropdownMenuItem onClick={handleConnect} disabled={!hasServer || loading !== null || (!activeServer?.isRemote && !hostRunning)}>
                    <Wifi className="mr-2 h-4 w-4" /> {t('actions.connectRcon')}
                  </DropdownMenuItem>
                </DisabledReason>
              )}
              <DropdownMenuSeparator />
              <DisabledReason
                className="w-full"
                reason={
                  activeServer?.isRemote ? t('actions.notAvailableRemote')
                  : !canControlServer ? t('actions.noPermissionControl')
                  : null
                }
              >
                <DropdownMenuItem
                  onClick={() => {
                    // Radix's MenuItem composes this onClick to fire BEFORE
                    // its own disabled check (which only guards its internal
                    // select/close behavior, not an arbitrary onClick prop) --
                    // the disabled attribute below is an affordance, this
                    // guard is the actual gate, same lesson as Console.tsx's
                    // Enter-key path.
                    if (!canControlServer) return
                    setConfirmAction({
                      actionId: 'Restart server now',
                      title: t('confirm.restartServerNow.title'),
                      description: t('confirm.restartServerNow.description') + (players.length > 0 ? t('confirm.restartServerNow.descriptionPlayers', { count: players.length }) : ''),
                      action: () => serverApi.restart(0),
                      variant: 'destructive',
                    })
                  }}
                  disabled={!hasServer || !hostRunning || loading !== null || activeServer?.isRemote || !canControlServer}
                  className="text-destructive focus:text-destructive"
                >
                  <Zap className="mr-2 h-4 w-4" /> {t('actions.restartNow')}
                </DropdownMenuItem>
              </DisabledReason>
              <DisabledReason
                className="w-full"
                reason={
                  !hasServer ? t('actions.addServerFirst')
                  : activeServer?.isRemote ? t('actions.notAvailableRemote')
                  // Capability before the transient "server is running" reason
                  // -- an operator who will never hold server.wipe gets told
                  // that, not sent to wait for a restart that wouldn't help them.
                  : !canWipeServer ? t('actions.noPermissionWipe')
                  : online ? t('actions.wipeMustStopFirst')
                  : null
                }
              >
                <DropdownMenuItem
                  onClick={() => {
                    // Same Radix quirk as Restart Now above: this onClick
                    // fires before the disabled prop is ever consulted, so
                    // the real gate on the single most destructive control
                    // in the product has to live here, not in the attribute.
                    if (!canWipeServer) return
                    setWipePreview(null)
                    setWipeDialog(true)
                  }}
                  disabled={!hasServer || online || loading !== null || activeServer?.isRemote || !canWipeServer}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" /> {t('actions.wipeServer')}
                </DropdownMenuItem>
              </DisabledReason>
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
        const ctaLabel = isStaged ? t('panelUpdateBanner.applyUpdate') : t('panelUpdateBanner.viewUpdate')
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
                {lastFailed ? t('panelUpdateBanner.applyFailed') : isStaged ? t('panelUpdateBanner.updateStaged') : t('panelUpdateBanner.panelUpdate')}
              </span>
              <span className="min-w-0 text-xs text-muted-foreground">
                {lastFailed
                  ? t('panelUpdateBanner.lastApplyFailedDesc')
                  : isStaged
                    ? t('panelUpdateBanner.stagedDesc')
                    : t('panelUpdateBanner.newVersionDesc')}
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
                aria-label={t('panelUpdateBanner.dismissAria')}
                onClick={dismiss}
                disabled={!latest}
                title={t('panelUpdateBanner.dismissTooltip')}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
              <Link to="/settings?tab=updates">
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
              {t('connectionError.label')}
            </span>
            <span className="min-w-0 truncate text-xs text-muted-foreground" title={fetchError}>
              {fetchError}{t('connectionError.suffix')}
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={fetchStatus} className="ml-auto h-7 gap-1.5 px-2.5 text-xs">
            <RefreshCw className="h-3 w-3" /> {t('connectionError.retry')}
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
              {t('notConfigured.label')}
            </span>
            <span className="text-xs text-muted-foreground">
              {t('notConfigured.description')}
            </span>
          </div>
          <span className="ml-auto text-xs font-medium text-warning/85">{t('notConfigured.openSetup')}</span>
        </Link>
      )}

      {/* ─── Quick-start onboarding ──────────────────────────────────────── */}
      {!hasServer && showQuickStart && (
        <section className="relative mt-3 overflow-hidden rounded-lg border border-primary/30 bg-card/50 px-4 py-4">
          <button
            onClick={dismissQuickStart}
            aria-label={t('quickStart.dismissAria')}
            className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary/85">{t('quickStart.eyebrow')}</p>
          <h2 className="mt-1 text-lg font-semibold leading-tight text-foreground">
            {t('quickStart.heading')}
          </h2>
          <ol className="mt-4 grid gap-2 list-none p-0 md:grid-cols-3">
            {[
              ['1', t('quickStart.step1Title'), t('quickStart.step1Desc')],
              ['2', t('quickStart.step2Title'), t('quickStart.step2Desc')],
              ['3', t('quickStart.step3Title'), t('quickStart.step3Desc')],
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
              <Server className="h-3.5 w-3.5" /> {t('quickStart.installNewServer')}
            </Link>
            <Link to="/servers" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-8 gap-1.5 text-xs')}>
              <FolderOpen className="h-3.5 w-3.5" /> {t('quickStart.addExistingServer')}
            </Link>
            <Link to="/servers" className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'h-8 gap-1.5 text-xs')}>
              <Globe className="h-3.5 w-3.5" /> {t('quickStart.addRemoteServer')}
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
              <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary/75">{t('liveActivity.heading')}</h3>
              {/* No status dot. Whether the server is up is answered by the verdict band, not repeated here. */}
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
                {playerActivity.length > 0 ? t('liveActivity.eventsCount', { count: playerActivity.length }) : online ? t('liveActivity.idle') : t('liveActivity.offline')}
              </span>
            </header>
            {playerActivity.length === 0 ? (
              <div className="flex items-center px-3 py-3">
                <p className="text-xs text-muted-foreground/75">
                  {online
                    ? t('liveActivity.emptyOnline')
                    : status?.configured
                      ? t('liveActivity.emptyConfiguredNotRunning')
                      : t('liveActivity.emptyNotConfigured')}
                </p>
              </div>
            ) : (
              <ol className="min-h-0 divide-y divide-border/15 overflow-y-auto">
                {playerActivity.map(a => {
                  const s = eventStyle(t, a.action)
                  return (
                    <li key={a.id} className="group grid grid-cols-[3.25rem_1rem_minmax(0,8rem)_minmax(0,1fr)] items-center gap-2 px-3 py-[3px] transition-colors hover:bg-muted/20">
                      <time className="font-mono text-[10px] tabular-nums text-muted-foreground/50">
                        {new Date(a.logged_at).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })}
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
              <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary/75">{t('telemetry.heading')}</h2>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
                {(() => {
                  if (performanceHistory.length === 0) return online ? t('telemetry.sampling') : t('telemetry.standby')
                  if (performanceHistory.length < 2) return t('telemetry.live')
                  const first = performanceHistory[0].timestamp
                  const last = performanceHistory[performanceHistory.length - 1].timestamp
                  if (first && last) {
                    const spanSec = (new Date(last).getTime() - new Date(first).getTime()) / 1000
                    if (spanSec < 120) return t('telemetry.lastSecondsLive', { seconds: Math.round(spanSec) })
                    return t('telemetry.lastMinutesLive', { minutes: Math.round(spanSec / 60) })
                  }
                  return t('telemetry.live')
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
                  ? t('telemetry.placeholderOnline')
                  : t('telemetry.placeholderOffline')}
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
              <ConnLine
                label={t('connLine.rcon')}
                state={status?.rcon?.connected ? 'on' : 'off'}
                value={status?.rcon ? `${status.rcon.host}:${status.rcon.port}` : undefined}
              />
              <ConnLine
                label={t('connLine.bridge')}
                state={bridgeStatus?.modConnected ? 'on' : bridgeStatus?.isRunning ? 'wait' : 'off'}
                value={
                  bridgeStatus?.modConnected && bridgeStatus.modStatus?.version
                    ? `v${bridgeStatus.modStatus.version.replace(/^v/, '')}`
                    : bridgeStatus?.isRunning ? t('connLine.pending') : t('connLine.offline')
                }
              />
            </div>
          </section>

          {/* MAINTENANCE */}
          {!activeServer?.isRemote && (
            <section>
              <h3 className="px-1 pb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary/75">{t('maintenance.heading')}</h3>
              <div className="space-y-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 w-full justify-start gap-2 text-xs"
                  onClick={fetchStatus}
                  disabled={loading !== null}
                >
                  <RefreshCw className={cn('h-3 w-3', loading ? 'animate-spin' : '')} />
                  {t('maintenance.refreshStatus')}
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground/65">
                    {lastUpdated ? lastUpdated.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' }) : '—'}
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
                  {t('maintenance.createBackup')}
                </Button>
                <DisabledReason
                  className="w-full"
                  reason={
                    // Same priority order and same Radix onClick-before-disabled
                    // guard as the "..." dropdown's Wipe item -- this sidebar
                    // button opens the identical destructive dialog and was
                    // missing both, which let a role without server.wipe
                    // open the wipe dialog only to strand on unexplained
                    // disabled Preview/Wipe Now buttons inside it.
                    !canWipeServer ? t('actions.noPermissionWipe')
                    : online ? t('maintenance.wipeTooltipOnline')
                    : null
                  }
                >
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-full justify-start gap-2 text-xs text-destructive hover:text-destructive"
                    disabled={!hasServer || online || loading !== null || activeServer?.isRemote || !canWipeServer}
                    onClick={() => {
                      if (!canWipeServer) return
                      setWipePreview(null)
                      setWipeDialog(true)
                    }}
                    title={online ? undefined : t('maintenance.wipeTooltipOffline')}
                  >
                    <Trash2 className="h-3 w-3" />
                    {t('maintenance.wipeServer')}
                  </Button>
                </DisabledReason>
                <label className="mt-1 flex cursor-pointer items-center gap-2 border-t border-border/30 px-1 pt-2">
                  <Checkbox
                    id="autoStartServer"
                    checked={autoStartServer}
                    onCheckedChange={(checked) => handleAutoStartChange(checked === true)}
                  />
                  <Label htmlFor="autoStartServer" className="cursor-pointer text-[11px] text-muted-foreground">
                    {t('maintenance.autoStartLabel')}
                  </Label>
                </label>
              </div>
            </section>
          )}

          {bridgeStatus && !bridgeStatus.configured && (
            <section className="rounded-md border border-warning/25 bg-warning/[0.04] p-3">
              <p className="text-xs font-medium text-warning/85">{t('bridgeOfflineNotice.title')}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('bridgeOfflineNotice.description')}{' '}
                <Link to="/settings" className="text-primary hover:underline">{t('bridgeOfflineNotice.configureLink')}</Link>.
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
            <AlertDialogCancel className="mt-0">{t('confirm.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={loading !== null}
              className={cn(buttonVariants({ variant: confirmAction?.variant === 'destructive' ? 'destructive' : 'warning' }))}
              onClick={async (e) => {
                // AlertDialogAction is Radix's own Close primitive -- it
                // auto-closes the dialog on click unless preventDefault()
                // is called, which otherwise leaves a narrow window (the
                // CSS exit-animation) where a second click can still land
                // and fire Stop/Force Stop a second time before the first
                // resolves (Stop/Force Stop have no server-side mutex,
                // unlike Restart's restartInProgress flag).
                e.preventDefault()
                if (!confirmAction) return
                // Stop/Force Stop/Restart/Restart Now all require
                // server.control and all share this one AlertDialogAction --
                // the buttons that stage confirmAction above only open this
                // dialog, so THIS is the real execution point and where the
                // gate actually has to live, same as Console.tsx's
                // executeCommand()/sendAnnouncement() guards.
                if (!canControlServer) { setConfirmAction(null); return }
                await handleAction(confirmAction.actionId, confirmAction.action)
                setConfirmAction(null)
              }}
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
              <Trash2 className="h-5 w-5 text-destructive" /> {t('wipeDialog.title')}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-base">
              <Trans
                t={t}
                i18nKey="wipeDialog.description"
                values={{ serverName: activeServer?.serverName || t('wipeDialog.defaultServerName') }}
                components={{ b: <span className="font-medium text-foreground" /> }}
              />
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3 py-2">
            {(['map', 'players', 'world', 'accounts'] as const).map((key) => (
              <label key={key} className="flex cursor-pointer items-start gap-3 rounded-md border border-border/50 p-3 hover:bg-muted/30">
                <Checkbox
                  checked={wipeTargets[key]}
                  disabled={wipeLoading}
                  onCheckedChange={(checked) => { setWipeTargets(prev => ({ ...prev, [key]: checked === true })); setWipePreview(null) }}
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{t(`wipeDialog.targets.${key}.label`)}</div>
                  <div className="text-xs text-muted-foreground">{t(`wipeDialog.targets.${key}.desc`)}</div>
                </div>
              </label>
            ))}
            <div className="px-3 pb-1 text-xs text-muted-foreground">{t('wipeDialog.notice')}</div>

            <div className="flex items-center justify-between rounded-lg bg-muted p-3">
              <div>
                <Label>{t('wipeDialog.backupLabel')}</Label>
                <p className="text-xs text-muted-foreground">{t('wipeDialog.backupDesc')}</p>
              </div>
              <Switch checked={wipeCreateBackup} disabled={wipeLoading} onCheckedChange={setWipeCreateBackup} />
            </div>

            {!wipeCreateBackup && (
              <div className="rounded-lg border border-destructive/25 bg-destructive/8 p-3 text-sm">
                <p className="font-medium text-destructive">{t('wipeDialog.noBackupTitle')}</p>
                <p className="text-muted-foreground">{t('wipeDialog.noBackupDesc')}</p>
              </div>
            )}
          </div>

          {wipeLoading && wipeBackupProgress && wipeBackupProgress.phase !== 'complete' && (
            <div className="space-y-1.5 rounded-md border border-border/50 bg-muted/30 p-3 text-sm">
              <div className="text-muted-foreground">{wipeBackupProgress.message}</div>
              <Progress value={wipeBackupProgress.percent} className="h-1.5" />
            </div>
          )}

          {wipePreview && (
            <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
              {wipePreview.totalFiles === 0 ? (
                <div className="text-muted-foreground">{t('wipeDialog.noFilesFound')}</div>
              ) : (
                <>
                  <div className="font-medium text-destructive">{t('wipeDialog.willDelete')}</div>
                  {(['map', 'players', 'world', 'leftovers', 'accounts'] as const).map(key => {
                    const data = wipePreview.preview?.[key]
                    if (!data) return null
                    const category = t(`wipeDialog.categoryLabels.${key}`)
                    if (key === 'leftovers') {
                      return data.files > 0
                        ? <div key={key}>{t('wipeDialog.filesCount', { count: data.files.toLocaleString(i18n.language), category, mb: (data.size / 1024 / 1024).toFixed(1) })}</div>
                        : null
                    }
                    return data.files > 0
                      ? <div key={key}>{t('wipeDialog.filesCount', { count: data.files.toLocaleString(i18n.language), category, mb: (data.size / 1024 / 1024).toFixed(1) })}</div>
                      : <div key={key} className="text-muted-foreground">{t('wipeDialog.noCategoryFilesFound', { category })}</div>
                  })}
                  <div className="pt-1 font-medium">{t('wipeDialog.total', { count: wipePreview.totalFiles.toLocaleString(i18n.language), mb: (wipePreview.totalSize / 1024 / 1024).toFixed(1) })}</div>
                  {wipePreview.truncated && (
                    <div className="pt-1 text-warning">{t('wipeDialog.truncatedWarning')}</div>
                  )}
                </>
              )}
            </div>
          )}

          <AlertDialogFooter className="gap-2 sm:gap-2">
            <AlertDialogCancel className="mt-0" disabled={wipeLoading} onClick={() => { setWipeDialog(false); setWipePreview(null) }}>{t('wipeDialog.cancel')}</AlertDialogCancel>
            {!wipePreview ? (
              <Button
                variant="warning"
                disabled={!Object.values(wipeTargets).some(Boolean) || wipeLoading || !canWipeServer}
                onClick={async () => {
                  // POST /server/wipe/preview requires server.wipe too --
                  // guarded here as well as on the DropdownMenuItem that
                  // opens this dialog, so this stays safe even if something
                  // else ever opens wipeDialog without checking first.
                  if (wipeLoading || !canWipeServer) return
                  setWipeLoading(true)
                  try {
                    const targets = Object.entries(wipeTargets).filter(([, v]) => v).map(([k]) => k)
                    const res = await serverApi.wipePreview(targets)
                    setWipePreview(res)
                  } catch (e: unknown) {
                    toast({ title: t('wipeDialog.previewFailedTitle'), description: e instanceof Error ? e.message : t('wipeDialog.previewFailedFallback'), variant: 'destructive' })
                  } finally { setWipeLoading(false) }
                }}
              >
                {wipeLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {t('wipeDialog.preview')}
              </Button>
            ) : (
              <Button
                variant="destructive"
                disabled={wipeLoading || wipePreview.totalFiles === 0 || !canWipeServer}
                onClick={async () => {
                  if (wipeLoading || !canWipeServer) return
                  setWipeLoading(true)
                  setWipeBackupProgress(wipeCreateBackup ? { phase: 'preparing', percent: 0, message: t('wipeDialog.backupStarting') } : null)
                  try {
                    const targets = Object.entries(wipeTargets).filter(([, v]) => v).map(([k]) => k)
                    const result = await serverApi.wipe(targets, wipeCreateBackup)
                    toast({
                      title: t('wipeDialog.wipedTitle'),
                      description: result.backupCreated
                        ? t('wipeDialog.wipedDescWithBackup', { targets: targets.join(', '), name: result.backupName || '' })
                        : t('wipeDialog.wipedDesc', { targets: targets.join(', ') }),
                    })
                    setWipeDialog(false); setWipePreview(null)
                  } catch (e: unknown) {
                    toast({ title: t('wipeDialog.wipeFailedTitle'), description: e instanceof Error ? e.message : t('wipeDialog.wipeFailedFallback'), variant: 'destructive' })
                  } finally { setWipeLoading(false); setWipeBackupProgress(null) }
                }}
              >
                {wipeLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                {t('wipeDialog.wipeNow')}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
