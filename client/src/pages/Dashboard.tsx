import { lazy, Suspense, useEffect, useState, useCallback, useRef } from 'react'
import type { ReactElement } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { usePageShortcut } from '../hooks/useKeyboardShortcuts'
import {
  Play, Square, RotateCcw, Save, Wifi, Loader2, AlertTriangle, RefreshCw, AlertCircle, Check,
  LogIn, LogOut, Activity, Archive, Skull, Sword, ShieldAlert, Copy, Gamepad2, Globe, FolderOpen,
  X, Zap, Trash2, CalendarClock, Monitor, ScrollText, FileCog, Plus, Cpu, ListChecks, Wrench, HeartPulse,
  Map as MapIcon,
} from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import {
  AlertDialog, AlertDialogAction, AlertDialogBody, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { SectionCard } from '@/components/ui/section-card'
import type { StatusPillProps } from '@/components/ui/status-pill'
import { ServerHeader, type ServerHeaderMenuItem } from '@/components/ServerHeader'
import { PageAlerts, type PageAlert } from '@/components/PageAlerts'
import { RoutePageSkeleton } from '@/components/PageSkeleton'
import { AddServerChoices } from '@/components/AddServerChoices'
import {
  ApiError, serverApi, rconApi, playersApi, panelBridgeApi, backupApi, configApi, serversApi, debugApi,
  panelUpdateApi, modsApi, schedulerApi, ServerInstance, PanelUpdateStatus, ComposedServerStatus,
  MountDiscoveryCandidate, ScheduledBackupAttempt,
} from '@/lib/api'
import { scheduledAttemptMessage, scheduledBackupHealth } from '@/lib/scheduledBackupHealth'
import { useRuntimeInfo } from '@/hooks/useRuntimeInfo'
import { useRequestGuard } from '@/hooks/useRequestGuard'
import { isStatusEventForServer, resolveClientProvider, deriveDashboardStatus, waitForServerState } from '@/lib/serverStatus'
import { autoStartEnabled, autoStartServerIds, restartOnCrashServerIds, withAutoStartServer, type AutoStartSettings } from '@/lib/autoStartServers'
import { ServersOverview } from '@/components/dashboard/ServersOverview'
import { ServerUptime } from '@/components/ServerUptime'
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
import { getResultErrorMessage, getUserErrorMessage, getRecoveryUrl } from '@/lib/errorMessage'
import { lifecycleBusyFromError, lifecycleBusyReason } from '@/lib/lifecycleBusy'
import { useLifecycleState } from '@/hooks/useLifecycleState'
import { formatTime } from '@/lib/dateFormat'
import { modUpdatesOnServer } from '@/lib/modsShared'
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
  // See server/services/serverManager.js's getServerStatus() comment: true
  // when the OS process scan itself failed (AV interference, WMI timeout,
  // ps/pgrep unavailable), distinct from a confirmed stop. deriveDashboardStatus
  // (lib/serverStatus.ts) reads this to avoid treating a scan hiccup as a
  // confident "server is down."
  scanFailed?: boolean
  // When the local process started (the OS's answer -- see
  // serverManager.js's resolveStartTime()), or null when unknown. The
  // header's uptime reads it through deriveDashboardStatus() and counts
  // from it live; `uptime` is the same fact as a duration frozen at poll
  // time (null when unknown), kept for API compatibility and not read here.
  startTime: string | null
  uptime: number | null
  serverPath: string
  // Renamed from `configured` server-side (2026-08-31): this has only ever
  // meant "does the local process-launch path have a directory to run in"
  // (server/services/serverManager.js's startServer() guard), not "is this
  // server profile complete". A remote server's launch happens on a
  // different host and correctly never sets serverPath, so under the old
  // name it read as permanently unconfigured everywhere this field was
  // read without already special-casing isRemote -- see the three call
  // sites below, all still gated on !activeServer?.isRemote for exactly
  // that reason. The value was already right for what it actually gates;
  // only the name over-promised.
  serverPathConfigured: boolean
  publicIp?: string
  localIp?: string
  port?: number
  // host/port are left out for a role holding none of servers.manage,
  // rcon.execute and server.configure (server/utils/rconTargetView.js).
  rcon: { host?: string; port?: number; connected: boolean }
}
interface Player { name: string; online: boolean }
interface PerformancePoint {
  time: string; timestamp?: string; playerCount: number; maxPlayers?: number; memoryMB: number
  pzMemMB?: number; cpuPercent?: number; hostMemUsedGB?: number; hostMemTotalGB?: number
  hostDiskUsedGB?: number; hostDiskTotalGB?: number
  hostSwapUsedGB?: number; hostSwapTotalGB?: number
}

const DashboardPerformanceCharts = lazy(() => import('@/components/DashboardPerformanceCharts'))
const DASHBOARD_ONBOARDING_DISMISSED_KEY = 'pz-dashboard-onboarding-dismissed-v1'

// Stores the exact lastError STRING that was dismissed, not a boolean --
// so dismissing "cannot reach GitHub" (the common air-gapped-install case)
// does not also silence a completely different failure that shows up later
// (e.g. after the machine gets network access and a real bug surfaces). If
// panelUpdate.lastError ever changes to different text, the stored value
// no longer matches and the indicator reappears. localStorage (not the
// sessionStorage the update-available banner above uses) because "never
// see this again" needs to survive closing the browser, not just a reload.
const PANEL_UPDATE_ERROR_DISMISSED_KEY = 'pz-panel-update-error-dismissed'

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
 * Connection LED row. `mono` when the value is data (host:port, a version),
 * not a state word.
 */
function ConnLine({
  label, state, value, mono,
}: { label: string; state: 'on' | 'off' | 'wait'; value?: string; mono?: boolean }) {
  const { t } = useTranslation('dashboard')
  const dot =
    state === 'on'   ? 'bg-success'
  : state === 'wait' ? 'bg-warning'
                     : 'bg-destructive/70'
  const valueTone =
    state === 'on'   ? 'text-success/80'
  : state === 'wait' ? 'text-warning'
                     : 'text-muted-foreground'
  return (
    <div className="flex min-w-0 items-center gap-2.5 py-1.5">
      <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', dot)} aria-hidden="true" />
      <span className="shrink-0 text-xs font-medium text-foreground">{label}</span>
      <span className={cn('min-w-0 flex-1 truncate text-end text-xs tabular-nums', mono && 'font-mono', valueTone)}>
        {value ?? (state === 'on' ? t('connLine.connected') : state === 'wait' ? t('connLine.pending') : t('connLine.offline'))}
      </span>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Dashboard                                                                 */
/* -------------------------------------------------------------------------- */

export default function Dashboard() {
  const { t, i18n } = useTranslation('dashboard')
  const { t: tHealth } = useTranslation('modHealth')
  const runtimeInfo = useRuntimeInfo()
  /* ---------------------------- state ------------------------------------- */
  // docker-unraid-add-server-experience, Q1 routing fix (2026-09-09, god):
  // the Quick-Start card's visually-primary button used to send a Docker/
  // Unraid user with existing files straight to /server-setup (the
  // steamcmd-install wizard, no discovery attempted at all) -- the exact
  // user this workstream targets got the wrong default action. Discovery
  // already runs unconditionally on Servers.tsx's mount; running the same
  // cheap call here lets the Quick-Start card route around that dead end
  // instead of just describing it. See the Quick-Start section's render
  // logic below for what candidates.length does to the card.
  const [discoveryCandidates, setDiscoveryCandidates] = useState<MountDiscoveryCandidate[]>([])
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [composedStatus, setComposedStatus] = useState<ComposedServerStatus | null>(null)
  const [players, setPlayers] = useState<Player[]>([])
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null)
  // hunt-wave12-2026-08-30: getZombieCount and getWorldStats were both
  // confirmed working by Kevin's engine-side audit but had no caller
  // anywhere in the client -- nothing on the Dashboard showed a zombie or
  // survivor count from any source. Checked first (per the same
  // precondition as the visual controls, 1c6ea6cc): neither value arrives
  // via any existing poll or the panelBridge:modStatus socket push (that
  // push only carries alive/version/serverName/playerCount), so this is a
  // genuine new poll, not five fields nobody was reading out of one that
  // already ran.
  const [zombieCount, setZombieCount] = useState<number | null>(null)
  const [worldMap, setWorldMap] = useState<string | null>(null)
  const [playerActivity, setPlayerActivity] = useState<PlayerActivity[]>([])
  const [performanceHistory, setPerformanceHistory] = useState<PerformancePoint[]>([])
  const [loading, setLoading] = useState<string | null>(null)
  // The header's Refresh: spins while the status is re-read (at least long
  // enough to see), then shows a check for a moment.
  const [refreshState, setRefreshState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [initialLoading, setInitialLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [, setTick] = useState(0)
  const [autoStartSettings, setAutoStartSettings] = useState<AutoStartSettings>({})
  // With two servers or more, the servers overview holds every auto-start
  // checkbox, the active server's included, so Maintenance drops its own.
  const [serversOverviewShown, setServersOverviewShown] = useState(false)
  const [panelInfo, setPanelInfo] = useState<{ localIp: string; port: number; url: string } | null>(null)
  const [activeServer, setActiveServer] = useState<ServerInstance | null>(null)
  // Critical problems in the active server's mod list (GET /mods/health),
  // for one Work list row; null until known or when it could not be read.
  const [modHealthCritical, setModHealthCritical] = useState<number | null>(null)
  const [showPerformanceCharts, setShowPerformanceCharts] = useState(false)
  const [showQuickStart, setShowQuickStart] = useState<boolean>(() => {
    try { return localStorage.getItem(DASHBOARD_ONBOARDING_DISMISSED_KEY) !== 'true' } catch { return true }
  })
  const [panelUpdate, setPanelUpdate] = useState<PanelUpdateStatus | null>(null)
  const [panelUpdateDismissedVersion, setPanelUpdateDismissedVersion] = useState<string | null>(() => {
    try { return sessionStorage.getItem('panel-update-banner-dismissed') } catch { return null }
  })
  const [panelUpdateErrorDismissed, setPanelUpdateErrorDismissed] = useState<string | null>(() => {
    try { return localStorage.getItem(PANEL_UPDATE_ERROR_DISMISSED_KEY) } catch { return null }
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
    // "no backups yet" (backupCount === 0) says nothing about a scheduler
    // that HAS been running and failing every attempt (bad cron, unreachable
    // backupsPath, disk full) -- lastBackup only ever updates on a success,
    // so that case looked identical to a healthy one until now. Mirrors the
    // exact same fields Backups.tsx's own statusCards already reads off
    // BackupStatus (see that page's lastScheduledAttemptFailed), so this
    // page's wording can't drift from that one's.
    backupsEnabled: boolean
    lastScheduledBackupAttempt: ScheduledBackupAttempt | null
  }>({
    lastBackup: null, backupCount: 0, modUpdatesAvailable: 0, modsTracked: 0,
    scheduledTasksCount: 0, nextRun: null, errorCount: null, schedulerLoaded: false,
    backupsEnabled: false, lastScheduledBackupAttempt: null,
  })

  const initialLoadingRef = useRef(true)
  // dashboard-loading-clears-on-acceptance-not-confirmation: handleAction's
  // Start/Stop/Force-stop branches now await a real confirmation poll
  // (waitForServerState, up to 30s) before clearing `loading` -- an operator
  // can navigate away from Dashboard entirely while that poll is still
  // running. Checked before every setState the poll's resolution leads to
  // (fetchStatus's own setStatus, and handleAction's finally clearing
  // `loading`), never inside waitForServerState itself, which stays a plain
  // shared primitive with no knowledge of any one caller's mount lifecycle.
  const mountedRef = useRef(true)

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
  // continuous-bug-hunt round 17 (every write that trusts the server-side
  // active server): serverApi.wipePreview()/wipe() both resolve "the active
  // server" server-side with no server id in the request, same shape as
  // Mods.tsx's saveModOrder() (see that page's serverChangedSinceLoad).
  // Preview shows file counts/paths for whichever server was active when
  // Preview was clicked; if the active server changes while this dialog is
  // still open (another operator/tab switches it), clicking "Wipe Now"
  // would silently delete the NEW active server's saves using targets
  // chosen while looking at the OLD server's preview -- worse than the mod
  // load-order case, since this is destructive and irreversible without a
  // backup. Set true by the activeServerChanged handler below ONLY while
  // this dialog is open; disables Preview/Wipe Now and shows an inline
  // warning until the user cancels and reopens for the now-active server.
  const [wipeServerChangedSinceOpen, setWipeServerChangedSinceOpen] = useState(false)
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
  // The preview renders at the end of the wipe dialog's scrolling body; bring
  // it into view when it arrives, so clicking Preview visibly does something.
  const wipePreviewRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (wipePreview) wipePreviewRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [wipePreview])

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
  // Why Start/Stop/Restart are unavailable while another lifecycle operation
  // runs, or while this server waits for its RCON: said on the control
  // instead of a click into a SERVER_LIFECYCLE_IN_PROGRESS error.
  const lifecycleState = useLifecycleState()
  const busyStart = lifecycleBusyReason(lifecycleState, activeServer?.id, 'start')
  const busyStop = lifecycleBusyReason(lifecycleState, activeServer?.id, 'stop')
  const busyForceStop = lifecycleBusyReason(lifecycleState, activeServer?.id, 'forceStop')
  const busyRestart = lifecycleBusyReason(lifecycleState, activeServer?.id, 'restart')
  // POST /rcon/connect needs rcon.execute: without it Connect RCON is not offered.
  const canExecuteRcon = can('rcon.execute')
  const canWipeServer = can('server.wipe')
  // pz-bughunt round 19 (client-vs-server permission gate sweep): PUT
  // /config/app-settings (handleAutoStartChange below) is gated
  // panel.settings server-side -- this checkbox had no client-side check
  // at all, unlike the wipe/control actions above.
  const canChangePanelSettings = can('panel.settings')
  // pz-pam-r23 (remaining client-side capability gates): POST
  // /backup/create (Create backup, all 3 call sites below -- verdict
  // action, the "..." dropdown, and the Maintenance sidebar button) is
  // gated requirePermission("backups.manage") server-side, confirmed via
  // server/routes/backup.js. None of the 3 had any client-side check.
  const canManageBackups = can('backups.manage')

  /* ---------------------------- effects ----------------------------------- */
  useEffect(() => { initialLoadingRef.current = initialLoading }, [initialLoading])
  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 10000); return () => clearInterval(t) }, [])
  // Q1 routing fix (see discoveryCandidates' own comment above): only
  // relevant with no active server. Fires once on mount (activeServer
  // starts null) and again only if activeServer flips server->null, never
  // re-fires null->null -- no extra cost once a server exists.
  useEffect(() => {
    if (activeServer) return
    serversApi.discoverMounts()
      .then((data) => setDiscoveryCandidates(data.candidates || []))
      .catch(() => { /* Quick-Start card just falls back to its default copy. */ })
  }, [activeServer])

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
    // backup:progress goes only to sockets in the backups room (a role
    // with server.wipe or a backup capability may join; server/index.js).
    // Joined again on every reconnect.
    const subscribeBackups = () => socket.emit('subscribe:backups')
    if (socket.connected) subscribeBackups()
    socket.on('connect', subscribeBackups)
    socket.on('backup:progress', handleBackupProgress)
    return () => {
      socket.off('connect', subscribeBackups)
      socket.off('backup:progress', handleBackupProgress)
    }
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
  // bug-hunt-2026-09-18 (round 9, activeServerChanged race sweep): fetchStatus
  // runs both on a 15s poll (below) and on activeServerChanged (onActiveServer
  // above) with no ordering guard between the two -- a poll tick fired for
  // the server that was active a moment ago, still in flight, could resolve
  // AFTER the activeServerChanged-triggered call for the NEW server and
  // silently overwrite it. statusGuard drops a response once a newer call
  // for this same fetcher has already started.
  const statusGuard = useRequestGuard()
  const fetchStatus = useCallback(async () => {
    const requestId = statusGuard.next()
    try {
      const data = await serverApi.getStatus({ retries: 0 })
      if (statusGuard.isStale(requestId)) return
      setStatus(data); setFetchError(null); setLastUpdated(new Date())
    } catch {
      if (!statusGuard.isStale(requestId)) setFetchError(t('errors.failedToConnect'))
    }
  }, [t, statusGuard])

  // bug-hunt-2026-09-18 (round 10, activeServerChanged race sweep continued):
  // same shape as fetchStatus above -- runs on both the 15s poll and
  // activeServerChanged, so a slow poll response for the old server can
  // still land after the new server's activeServerChanged-triggered call.
  const composedStatusGuard = useRequestGuard()
  const fetchComposedStatus = useCallback(async () => {
    const requestId = composedStatusGuard.next()
    try {
      const data = await serversApi.getComposedStatus({ retries: 0 })
      if (composedStatusGuard.isStale(requestId)) return
      setComposedStatus(data)
    } catch {
      if (!composedStatusGuard.isStale(requestId)) setComposedStatus(null)
    }
  }, [composedStatusGuard])

  usePageShortcut('r', () => { if (loading === null) { fetchStatus(); fetchComposedStatus() } })

  const playersGuard = useRequestGuard()
  const fetchPlayers = useCallback(async () => {
    const requestId = playersGuard.next()
    try {
      const d = await playersApi.getPlayers({ retries: 0 })
      if (playersGuard.isStale(requestId)) return
      if (d.players) setPlayers(d.players)
    } catch {
      if (!playersGuard.isStale(requestId)) setPlayers([])
    }
  }, [playersGuard])
  const bridgeStatusGuard = useRequestGuard()
  const fetchBridgeStatus = useCallback(async () => {
    const requestId = bridgeStatusGuard.next()
    try {
      const data = await panelBridgeApi.getStatus()
      if (bridgeStatusGuard.isStale(requestId)) return
      setBridgeStatus(data)
    } catch {
      if (!bridgeStatusGuard.isStale(requestId)) setBridgeStatus(null)
    }
  }, [bridgeStatusGuard])
  // Uses two distinct getters rather than one: getZombieCount is the
  // purpose-built number for the tile below; getWorldStats' only
  // non-duplicate field is the map name, shown next to the server name in
  // the header. Neither result is seeded with a plausible-looking default
  // on failure -- null means "unknown", not "0".
  const fetchWorldZombieStats = useCallback(async () => {
    const [zc, ws] = await Promise.allSettled([
      panelBridgeApi.getZombieCount(),
      panelBridgeApi.getWorldStats(),
    ])
    setZombieCount(
      zc.status === 'fulfilled' && zc.value?.success && typeof zc.value.data?.zombieCount === 'number'
        ? zc.value.data.zombieCount
        : null,
    )
    setWorldMap(
      ws.status === 'fulfilled' && ws.value?.success && ws.value.data?.map ? ws.value.data.map : null,
    )
  }, [])
  const fetchPlayerActivity = useCallback(async () => {
    try { const d = await playersApi.getActivityLogs(undefined, 15); if (d.logs) setPlayerActivity(d.logs.slice(0, 12)) }
    catch { setPlayerActivity([]) }
  }, [])
  // The history is the ACTIVE server's: a fetch still in flight when the
  // operator switches servers must not put the old server's samples back
  // after onActiveServer has cleared them.
  const perfHistoryGuard = useRequestGuard()
  const fetchPerformanceHistory = useCallback(async () => {
    const requestId = perfHistoryGuard.next()
    try {
      const data = await debugApi.getPerformanceHistory(60)
      if (perfHistoryGuard.isStale(requestId)) return
      if (data.history) {
        setPerformanceHistory(data.history.map((h: Record<string, unknown>) => ({
          time: formatTime(h.timestamp as string, { language: i18n.language }),
          timestamp: h.timestamp as string,
          playerCount: (h.playerCount as number) || 0,
          maxPlayers: (h.maxPlayers as number) || undefined,
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
  }, [i18n.language, perfHistoryGuard])
  const fetchAutoStartSetting = useCallback(async () => {
    try {
      const r = await configApi.getAppSettings()
      if (r?.settings) {
        setAutoStartSettings({
          autoStartServer: r.settings.autoStartServer,
          autoStartServerIds: r.settings.autoStartServerIds,
          restartOnCrashServerIds: r.settings.restartOnCrashServerIds,
        })
      }
    } catch {
      // Ignore settings fetch failures and keep the current fallback value.
    }
  }, [])
  // fetchActiveServer runs on mount/bootstrap and again from onActiveServer
  // below when activeServerChanged arrives with no `server` payload -- two
  // overlapping calls can race the same way as fetchStatus's sibling
  // fetchers above.
  const activeServerGuard = useRequestGuard()
  const fetchActiveServer = useCallback(async () => {
    const requestId = activeServerGuard.next()
    try {
      const d = await serversApi.getResolvedActive()
      if (activeServerGuard.isStale(requestId)) return
      setActiveServer(d.server ?? null)
    } catch {
      if (!activeServerGuard.isStale(requestId)) setActiveServer(null)
    }
  }, [activeServerGuard])
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
      backupsEnabled: backupRes.status === 'fulfilled' ? !!backupRes.value.enabled : prev.backupsEnabled,
      lastScheduledBackupAttempt: backupRes.status === 'fulfilled' ? (backupRes.value.lastScheduledBackupAttempt ?? null) : prev.lastScheduledBackupAttempt,
      // The server's own (WorkshopItems=) updates, as the Mods page counts them.
      modUpdatesAvailable: modsRes.status === 'fulfilled' ? (modUpdatesOnServer(modsRes.value as { updatesAvailable?: number; updatesOnServer?: number }) ?? 0) : prev.modUpdatesAvailable,
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

  // The checkbox is the active server's place in the list of servers the
  // panel starts (Settings › Connection lists them all); it used to be the
  // switch itself, which only ever started whichever server was active.
  // Checking it also turns the switch on. Unchecking takes this server out
  // and leaves the switch, and any other chosen server, alone.
  const activeServerId = activeServer ? String(activeServer.id) : null
  const autoStartThisServer = autoStartEnabled(autoStartSettings) && (activeServerId === null
    ? !Array.isArray(autoStartSettings.autoStartServerIds)
    : autoStartServerIds(autoStartSettings, activeServerId).includes(activeServerId))
  // `server`: a row of the servers overview below; none means the active one.
  const handleAutoStartChange = async (checked: boolean, server?: ServerInstance) => {
    if (!canChangePanelSettings) return
    const previous = autoStartSettings
    const serverId = server ? String(server.id) : activeServerId
    // No server record (a settings-only install): the switch alone, as before.
    const update: AutoStartSettings = serverId === null
      ? { autoStartServer: checked }
      : {
          ...(checked ? { autoStartServer: true } : {}),
          autoStartServerIds: withAutoStartServer(autoStartServerIds(previous, activeServerId), serverId, checked),
        }
    setAutoStartSettings({ ...previous, ...update })
    try {
      await configApi.updateAppSettings(update)
      const name = server ? server.name || server.serverName : null
      toast({
        title: checked ? t('toasts.autoStartEnabledTitle') : t('toasts.autoStartDisabledTitle'),
        description: name
          ? t(checked ? 'serversOverview.autoStartOnDesc' : 'serversOverview.autoStartOffDesc', { name })
          : checked ? t('toasts.autoStartEnabledDesc') : t('toasts.autoStartDisabledDesc'),
      })
    } catch (error) {
      setAutoStartSettings(previous)
      toast({ title: t('toasts.errorTitle'), description: getUserErrorMessage(error, t('toasts.autoStartSaveFailed')), variant: 'destructive' })
    }
  }

  // Whether the panel starts a server again when it goes down without being
  // asked (server/services/serverWatch.js). `server`: a row of the servers
  // overview; none means the active one.
  const restartOnCrashThisServer = activeServerId !== null && restartOnCrashServerIds(autoStartSettings).includes(activeServerId)
  const handleRestartOnCrashChange = async (checked: boolean, server?: ServerInstance) => {
    if (!canChangePanelSettings) return
    const target = server ?? activeServer
    if (!target) return
    const previous = autoStartSettings
    const next = withAutoStartServer(restartOnCrashServerIds(previous), target.id, checked)
    setAutoStartSettings({ ...previous, restartOnCrashServerIds: next })
    try {
      await configApi.updateAppSettings({ restartOnCrashServerIds: next })
      const name = target.name || target.serverName
      toast({
        title: t(checked ? 'serversOverview.restartOnCrashOnTitle' : 'serversOverview.restartOnCrashOffTitle'),
        description: t(checked ? 'serversOverview.restartOnCrashOnDesc' : 'serversOverview.restartOnCrashOffDesc', { name }),
      })
    } catch (error) {
      setAutoStartSettings(previous)
      toast({ title: t('toasts.errorTitle'), description: getUserErrorMessage(error, t('serversOverview.restartOnCrashSaveFailed')), variant: 'destructive' })
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
      mountedRef.current = false
    }
  }, [fetchStatus, fetchComposedStatus, fetchPlayers, fetchBridgeStatus, fetchPlayerActivity,
      fetchAutoStartSetting, fetchActiveServer, fetchMaintenance, t])

  // The mod health check (mods.manage, like the route): read when the active
  // server is known or changes, then every 5 minutes while visible. A failure
  // only hides the row; a reply for a server no longer active is dropped.
  const canManageMods = can('mods.manage')
  // activeServerId: the active server's id as a string, declared with the
  // auto-start checkbox above.
  const modHealthGuard = useRequestGuard()
  useEffect(() => {
    if (activeServerId === null || !canManageMods) {
      modHealthGuard.next()
      setModHealthCritical(null)
      return
    }
    const load = async () => {
      const requestId = modHealthGuard.next()
      try {
        const health = await modsApi.getModHealth()
        if (!modHealthGuard.isStale(requestId)) setModHealthCritical(health?.counts?.critical ?? 0)
      } catch {
        if (!modHealthGuard.isStale(requestId)) setModHealthCritical(null)
      }
    }
    void load()
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load()
    }, 5 * 60_000)
    return () => {
      clearInterval(interval)
      modHealthGuard.next()
    }
  }, [activeServerId, canManageMods, modHealthGuard])

  useEffect(() => {
    if (!socket) return
    const onStatus = (data: Partial<ServerStatus> & { serverId?: string | number | null }) => {
      // A restart of a server other than the active one (scheduler.js names
      // it in serverId) says nothing about the one shown here.
      if (!isStatusEventForServer(data, activeServer?.id)) return
      setStatus(prev => {
        if (prev) return { ...prev, ...data }
        // Every real server:status emit (server/index.js, routes/server.js,
        // services/scheduler.js) sends only { running, phase } -- never
        // enough fields to safely stand in for a full ServerStatus (rcon/
        // startTime/uptime/serverPath/serverPathConfigured all missing;
        // `phase` -- 2026-09-07, see resolveServerPhase() -- is display-only
        // refinement of `running` for Layout.tsx's sidebar dot, not read
        // here). Before prev
        // exists there is nothing to merge onto, so an early push here is
        // dropped; fetchStatus()'s REST call populates the first real
        // snapshot instead. (This used to check for a `configured` field
        // that would have made a full-snapshot payload acceptable, but no
        // server:status emission has ever sent one, under either that name
        // or its 2026-08-31 rename to serverPathConfigured -- removed
        // rather than "fixed" to the new name, since accepting a partial
        // payload here would cast it to ServerStatus and crash the first
        // render that reads e.g. status.rcon.connected.)
        return prev
      })
      setLastUpdated(new Date())
      // The merge above only reaches the plain `status`; Start vs Stop reads
      // `online`, which is composedStatus's host/RCON/PanelBridge whenever
      // composedStatus exists. Without this refetch a server that had just
      // stopped kept its Stop button until the 15s poll (Servers.tsx's card
      // already refetches on this same push).
      void fetchComposedStatus()
    }
    const onPlayers = (d: Player[]) => setPlayers(d)
    const onActiveServer = (d?: { server?: ServerInstance | null }) => {
      if (d?.server !== undefined) setActiveServer(d.server); else fetchActiveServer()
      fetchStatus(); fetchComposedStatus(); fetchPlayers(); fetchBridgeStatus()
      // The telemetry rows read the LAST sample, which is the previous
      // server's for up to a minute (the next tick) unless it is dropped and
      // the new server's history fetched. The guard bump also discards a
      // fetch still in flight for the old server when the charts are hidden.
      perfHistoryGuard.next()
      setPerformanceHistory([])
      if (showPerformanceCharts) void fetchPerformanceHistory()
      // See wipeServerChangedSinceOpen's own comment above.
      if (wipeDialog) setWipeServerChangedSinceOpen(true)
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
  }, [socket, fetchStatus, fetchComposedStatus, fetchPlayers, fetchBridgeStatus, fetchActiveServer, fetchPerformanceHistory, perfHistoryGuard, showPerformanceCharts, wipeDialog, activeServer?.id])

  // Zombie count changes continuously while the server runs -- unlike
  // bridgeStatus (pushed live over the socket), nothing pushes this, so it
  // needs its own poll. Same cadence and visibility-pause as Events.tsx's
  // own bridge-data poll. Only runs while the mod is actually connected --
  // an offline bridge would just 400 every 10s for nothing.
  useEffect(() => {
    if (!bridgeStatus?.modConnected) {
      setZombieCount(null)
      setWorldMap(null)
      return
    }
    fetchWorldZombieStats()
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') fetchWorldZombieStats()
    }, 10000)
    return () => clearInterval(interval)
  }, [bridgeStatus?.modConnected, fetchWorldZombieStats])

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
    // bug-hunt-2026-09-04: 'subscribe:perf' was only ever emitted once, when
    // this effect first ran -- but room membership is server-side
    // per-connection state, lost whenever the underlying socket.io
    // connection drops and re-establishes, even though the client reuses
    // the same Socket object (see Console.tsx's identical subscribeRcon
    // fix/comment for 'subscribe:rcon', same root cause). After any
    // reconnect the server no longer had this client in the perf room, so
    // perf:snapshot stopped arriving and the chart just went quiet with no
    // error -- re-subscribing on every 'connect', not just on mount, fixes it.
    const subscribePerf = () => socket.emit('subscribe:perf')
    if (socket.connected) subscribePerf()
    socket.on('connect', subscribePerf)
    const onSnapshot = (snap: Record<string, unknown>) => {
      // pz-bughunt round 17 (Dashboard live perf chart after a server
      // switch): perf:snapshot now carries a serverId (server/index.js's
      // perfPollingInterval, mirroring getPerformanceHistory()'s own
      // filter in database/init.js -- entry.serverId == null || entry.
      // serverId === serverId). The "perf" room is one shared broadcast
      // room, not scoped per server, so every subscribed client gets
      // every tick regardless of which server it's for -- without this
      // check, switching the active server kept appending the OLD
      // server's samples into what still looks like a live chart for the
      // NEW one. Same acceptance rule as the server-side filter: drop a
      // snapshot tagged for a DIFFERENT server, but accept one with no
      // serverId at all (null/undefined -- pre-fix legacy senders, or no
      // active server known) rather than silently going quiet.
      const snapServerId = snap.serverId as string | number | null | undefined
      if (snapServerId != null && (activeServer == null || String(snapServerId) !== String(activeServer.id))) {
        return
      }
      const point: PerformancePoint = {
        time: formatTime(new Date(), { language: i18n.language }),
        timestamp: new Date().toISOString(),
        playerCount: (snap.playerCount as number) || 0,
        maxPlayers: (snap.maxPlayers as number) || undefined,
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
      socket.off('connect', subscribePerf)
      socket.emit('unsubscribe:perf')
    }
  }, [socket, showPerformanceCharts, i18n.language, activeServer])

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
    options?: {
      errorAction?: (error: unknown) => ReactElement | undefined
      // true when it dealt with the error itself (no error toast)
      handleError?: (error: unknown) => boolean
    },
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
      // its save-and-exit has actually finished. The server marking that
      // response confirmed:false for exactly that case is what stopped the
      // toast claiming completion it doesn't have -- but a REAL confirmation
      // is strictly better than a same-tick guess either way, so this is
      // now folded into the poll-driven `confirmed` check below rather than
      // read directly off this one response.
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
      // honest-unknown class (dashboard-loading-clears-on-acceptance-not-
      // confirmation, medium): fn() resolving only proves Start/Stop/Force-
      // stop's request was ACCEPTED -- POST /stop in particular already
      // marks this confirmed:false when rconService.quit() merely returned
      // (see stopUnconfirmed's own history above), and even a confirmed:true
      // response only proves the command landed, not that the process has
      // actually reached the expected state yet. `loading` (which disables
      // every action button on this page, not just the one clicked -- see
      // the `loading !== null` checks below) used to clear the instant this
      // promise resolved regardless, so the operator could click Start again
      // before Stop had actually finished. Reuses Servers.tsx's own
      // waitForActionState()/waitForServerState() bound (30s timeout, 1s
      // poll, scanFailed/stateUnknown excluded from a match) rather than a
      // second polling primitive or an invented timeout number.
      const isLifecycleAction = action === 'Start server' || action === 'Stop server' || action === 'Force stop server'
      let confirmed: boolean | null = null
      if (isLifecycleAction && activeServer?.id != null) {
        // Refresh the dashboard immediately after the request is accepted.
        // The confirmation poll below intentionally waits for the final state,
        // but it must not postpone the visible starting/stopping transition
        // until that potentially long poll completes.
        if (mountedRef.current) void fetchStatus()
        confirmed = await waitForServerState(
          () => serversApi.getStatus({ retries: 0 }),
          activeServer.id,
          action === 'Start server',
        )
      }
      // waitForServerState's own onStatus callback writes into the bulk
      // list's shape (id/running/pid/stateUnknown), not this page's richer
      // singular ServerStatus (uptime, memory, ...) -- fetchStatus() here
      // refreshes the real display state once, after the wait, instead of
      // live-writing a shape mismatch during it.
      if (isLifecycleAction && mountedRef.current) {
        // Start vs Stop reads `online`, which comes from composedStatus
        // whenever it exists -- refreshing only the plain status left the
        // button on the pre-action answer until the next 15s poll. Awaited,
        // not fired off: the plain status fetched right after the request
        // was accepted still says running, so letting `loading` clear first
        // re-enabled Stop/Force Stop/Restart on that stale answer for a
        // second or two (Servers.tsx's inline refreshAfterInlineAction
        // awaits for the same reason). And awaited before the toast below:
        // the Stop/Force Stop confirm dialog stays open until this function
        // returns, and both fetches run a fresh process scan (~1.5s on
        // Windows), so toasting first said "Server stopped" beside a dialog
        // that was still busy.
        await Promise.allSettled([fetchStatus(), fetchComposedStatus()])
      }
      // A stuck disabled button is worse than a premature success claim --
      // an operator can recover from a wrong label by clicking again, not
      // from a dead control without a reload. On timeout (confirmed===false)
      // this still falls through to the SAME toasts already below, not a
      // silent no-op: Stop reuses stopServerRequested (already written for
      // exactly this "requested, not yet confirmed" case) and Start reuses
      // its own success copy, which was already honest -- "Server starting
      // -- watch the dashboard for live status" never claimed completion --
      // just with the variant downgraded from success to the same neutral
      // 'default' Servers.tsx uses for its own unconfirmed case, instead of
      // inventing new copy.
      // bug-hunt-2026-09-18 (round 23, operator design call:
      // force-stop-has-no-unconfirmed-copy): force-stop's copy USED TO stay
      // unvaried here -- there was no "force-stop requested, unconfirmed"
      // string anywhere in the codebase to reuse, and this floor doesn't
      // invent new user-facing copy on its own. Flagged to the operator
      // instead; they picked reusing the Stop wording's shape. New
      // successCopy.forceStopRequested below, checked before
      // forceStopOutcomeCopy so a known bad save outcome (a more specific,
      // more urgent fact) still wins when both are true at once.
      if (scriptWarnings && scriptWarnings.length > 0) {
        toast({
          title: t('successCopy.startServerScriptBackup.title'),
          description: `${t('successCopy.startServerScriptBackup.description')} ${scriptWarnings.join(' ')}`,
          variant: 'success' as const,
        })
      } else if (action === 'Stop server' && confirmed === false) {
        toast({
          title: t('successCopy.stopServerRequested.title'),
          description: t('successCopy.stopServerRequested.description'),
          variant: 'default' as const,
        })
      } else if (forceStopOutcomeCopy) {
        toast({ title: forceStopOutcomeCopy.title, description: forceStopOutcomeCopy.description, variant: 'warning' as const })
      } else if (action === 'Force stop server' && confirmed === false) {
        toast({
          title: t('successCopy.forceStopRequested.title'),
          description: t('successCopy.forceStopRequested.description'),
          variant: 'default' as const,
        })
      } else {
        const honestlyUnconfirmed = action === 'Start server' && confirmed === false
        toast({ title: copy.title, description: copy.description, variant: honestlyUnconfirmed ? 'default' as const : 'success' as const })
      }
      // SECURITY (2026-10-05, PT3): the server started, but the panel won't
      // use its folders (the data folder no longer meets the data-folder
      // rule, or a config folder has no data folder), so it didn't write the
      // RCON settings into the server's ini. POST /start answers why as
      // `folderWarning`; said here, beside the start, with what to set.
      const folderWarning = action === 'Start server' && result && typeof result === 'object'
        ? (result as { folderWarning?: { error?: string; code?: string } | null }).folderWarning
        : undefined
      if (folderWarning) {
        toast({
          title: t('successCopy.startServerFolderWarning.title'),
          description: getResultErrorMessage(folderWarning, t('successCopy.startServerFolderWarning.title')),
          variant: 'warning' as const,
        })
      }
      // Every other action refreshes after its toast, as it always has.
      if (!isLifecycleAction && mountedRef.current) fetchStatus()
    } catch (error) {
      if (options?.handleError?.(error)) return
      // Refused because something else holds the lifecycle lock: not a
      // failure, so said plainly with what holds it.
      const busy = lifecycleBusyFromError(error)
      if (busy) {
        toast({ title: t('lifecycleBusy.title', { ns: 'shell' }), description: busy })
        return
      }
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('toasts.actionFailedFallback')),
        variant: 'destructive',
        action: options?.errorAction?.(error),
      })
    } finally {
      // Guards specifically the new await above: a component that unmounted
      // mid-poll (operator navigated away while Stop was still confirming)
      // must not setState on the way out. Every other caller of handleAction
      // still clears synchronously on the same tick as before -- this only
      // changes WHETHER it's safe to clear, never WHEN, for anything that
      // isn't one of the three lifecycle actions above.
      if (mountedRef.current) setLoading(null)
    }
  }
  // Two of the six server.control triggers on this page (this Start button,
  // and the verdict band's shortcut for the same action below) call
  // handleAction() directly with no confirm dialog in between -- guarded
  // here, inside the function, not just on the buttons that call it. Same
  // lesson as Console.tsx's Enter-key path: a disabled attribute is an
  // affordance, the function guard is the actual gate.
  // Process detection can't tell whether the server is running and nothing
  // else proved it stopped (SERVER_START_STATE_UNKNOWN): the operator may
  // start it anyway, after a confirm, instead of a Start that never works.
  const startServer = () => {
    if (!canControlServer) return
    void handleAction('Start server', () => serverApi.start(), {
      handleError: (error) => {
        if (!(error instanceof ApiError) || error.code !== 'SERVER_START_STATE_UNKNOWN') return false
        setConfirmAction({
          actionId: 'Start server',
          title: t('confirm.startUnknownState.title'),
          description: t('confirm.startUnknownState.description'),
          action: () => serverApi.start({ ignoreUnknownState: true }),
          variant: 'warning',
        })
        return true
      },
    })
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
  // The header comes first in every state: until the first status lands,
  // the route's own skeleton mirrors it (registry title, icon, description)
  // instead of a spinner in the middle of an empty page.
  if (initialLoading) {
    return <RoutePageSkeleton pathname="/" />
  }

  /* ---------------------------- derived ----------------------------------- */
  const hasServer = !!activeServer
  // Angela's mechanical rule (2026-09-09 bar broadcast, rule 3): exactly one
  // confident match means AUTO-USE it, not a picker -- reserve a picker for
  // genuine ambiguity (2+ ready, or nothing ready but several worth a
  // human's judgment call). The Quick-Start card only needs the boolean
  // "did we find exactly one" -- Servers.tsx (already shipped, 3cf1b5e6)
  // owns actually rendering and disambiguating the full candidate list.
  const readyCandidates = discoveryCandidates.filter((c) => c.status === 'ready')
  const isContainerized = runtimeInfo?.serviceManager === 'container'
  const quickStartVisible = !hasServer && showQuickStart
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
  const { hostRunning, rconConnected, hostUnknown, online, startedAt } = deriveDashboardStatus({
    hasServer,
    provider,
    status,
    composedStatus,
  })
  // Unknown only because this PC's process scan failed: Start stays usable
  // (the server checks other signs, then startServer() offers a confirm).
  const scanUnknown = hostUnknown && provider === 'native' && composedStatus?.host.status === 'unknown'
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

  // Shared by the verdict and the Backups row below -- see
  // scheduledBackupHealth() for what each state means and why a manual
  // backup now clears a failed scheduled attempt.
  const backupHealth = scheduledBackupHealth(maintenance.backupsEnabled, maintenance.lastScheduledBackupAttempt)
  // One click that fixes both backup verdicts that have no deeper cause to
  // chase: an empty archive, and a scheduled backup a restart skipped (any
  // later successful backup clears that one).
  const createBackupVerdictAction = {
    label: t('actions.createBackup'),
    onClick: () => {
      if (!canManageBackups) return
      void handleAction('Create backup', () => backupApi.createBackup().then(() => fetchMaintenance()))
    },
    busy: loading === 'Create backup',
    disabled: loading !== null || !canManageBackups,
    reason: !canManageBackups ? t('actions.noPermissionCreateBackup') : undefined,
  }

  /* One verdict at a time, highest severity wins. Calm states say nothing at all. */
  const verdict: Verdict = (() => {
    // status.serverPathConfigured (server-side rename of `configured`, see
    // the ServerStatus interface above) means "the local process-launch
    // path has a directory to run in" -- correctly, structurally false for
    // every remote server, since a remote server's launch happens on a
    // different host and never sets serverPath (installPath isn't required
    // for isRemote:true in server/routes/servers.js's create validation).
    // This verdict used to read that as "remote == unconfigured" before the
    // rename made the narrower meaning explicit (2026-08-31 visual sweep:
    // "NOT CONFIGURED" sitting under a named, addressed, REMOTE-badged
    // server). Same family as Layout.tsx's servers-as-[] fix (3665aa20): a
    // signal that cannot represent one real case was trusted for all cases
    // instead of being scoped to the ones it actually describes.
    if (!hasServer || (status && !status.serverPathConfigured && !activeServer?.isRemote)) {
      return {
        level: 'warning',
        headline: t('verdict.noServerConfigured'),
        // The fix differs: with no server at all it is adding one (and the
        // "Add a server" block right below already offers that, so the band
        // doesn't repeat it); a server without a launch folder is fixed by
        // editing it on Servers. This replaces the separate "Not configured"
        // banner, which only ever said the same thing a second time.
        action: !hasServer
          ? (quickStartVisible ? undefined : { label: t('actions.addServer'), to: '/server-setup' })
          : { label: t('verdict.editServer'), to: '/servers' },
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
        // bug-hunt-2026-09-18 (round 23, dashboard-crash-vs-stop-surface):
        // composedStatus.host.detail already carries Jim's r28
        // describeStopReason() line (1a460da9) -- "Stopped by an operator"
        // vs "Crashed (exit code 1)" etc -- and Servers.tsx's own server
        // card already renders the identical field via
        // ServerStatusBadge.tsx's signal.detail. The Dashboard verdict
        // never rendered it at all, so a crash and a deliberate stop looked
        // identical here even though the data distinguishing them was
        // already being fetched. Excluded for hostUnknown: that status
        // carries its own different detail (e.g. "Process detection
        // failed"), already fully explained by serverStatusUnknown above.
        detail: !hostUnknown ? (composedStatus?.host.detail ?? undefined) : undefined,
        // Omit the shortcut entirely rather than show it disabled with no
        // explanation -- VerdictAction has no reason/tooltip support, same
        // treatment isRemote/hostUnknown already get here. The header Start
        // button (which DOES carry a DisabledReason) remains the explained
        // affordance for why this operator can't start the server.
        action: (hostUnknown && !scanUnknown) || activeServer?.isRemote || !canControlServer
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
          <HelpTip label={t('verdict.rconHelpLabel')} className="ms-1.5 align-[-2px]">
            {t('verdict.rconHelpTip')}
          </HelpTip>
        ),
        action: canExecuteRcon ? {
          label: t('actions.connectRcon'),
          onClick: () => { void handleConnect() },
          busy: loading === 'Connect RCON',
          disabled: loading !== null,
        } : undefined,
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
        action: { label: t('verdict.bridgeSettingsLink'), to: '/settings?tab=bridge' },
      }
    }
    if (modsPending) {
      return {
        level: 'warning',
        headline: t('verdict.modUpdatesWaiting', { count: maintenance.modUpdatesAvailable }),
        action: { label: t('verdict.reviewMods'), to: '/mods' },
      }
    }
    // "No backups" (below) only fires on an empty archive -- it says nothing
    // when the scheduler HAS produced backups before but every attempt since
    // has been failing (bad cron target, unreachable backupsPath, disk
    // full). lastBackup only ever updates on a success, so that failure was
    // invisible here even though Backups.tsx's own status card already
    // catches it (see BackupStatus.lastScheduledBackupAttempt's comment in
    // lib/api.ts). Checked ahead of the empty-archive case: a specific "why
    // it's failing" beats a generic "you have none yet" whenever both would
    // otherwise be true at once.
    if (maintenance.schedulerLoaded && !activeServer?.isRemote && backupHealth === 'failing') {
      const attempt = maintenance.lastScheduledBackupAttempt
      return {
        level: 'warning',
        headline: t('verdict.backupAttemptFailing'),
        // Translated where the panel wrote the message itself (a restart
        // that looked stuck, and what to do about it); a raw error as is.
        detail: scheduledAttemptMessage(attempt?.message, attempt?.messageKey, attempt?.messageParams) || undefined,
        action: { label: t('verdict.reviewBackups'), to: '/backups' },
      }
    }
    // A backup a restart pushed aside is not a broken backup (2026-09-27
    // Discord report: "Scheduled backup failing -- Skipped: a restart was in
    // progress", on every tick, because a restart schedule fired at the same
    // times). Still worth a warning -- that backup didn't happen -- but it
    // says what actually happened and offers the click that clears it,
    // instead of sending the operator to hunt for a fault that isn't there.
    // The why goes in a HelpTip like the RCON verdict's, not in `detail`:
    // that slot is drawn as faint 10px log text, for raw server messages.
    if (maintenance.schedulerLoaded && !activeServer?.isRemote && backupHealth === 'skippedForRestart') {
      return {
        level: 'warning',
        headline: t('verdict.backupSkippedForRestart'),
        headlineHelp: (
          <HelpTip label={t('verdict.backupSkippedForRestart')} className="ms-1.5 align-[-2px]">
            {t('verdict.backupSkippedForRestartHelp')}
          </HelpTip>
        ),
        action: createBackupVerdictAction,
      }
    }
    /* Game errors are reported by the Errors row, which is already coloured by
       severity. Repeating the count here would say the same thing twice. */
    if (maintenance.schedulerLoaded && maintenance.backupCount === 0 && !activeServer?.isRemote) {
      return {
        level: 'warning',
        headline: t('verdict.noBackups'),
        action: createBackupVerdictAction,
      }
    }
    return { level: 'calm' }
  })()

  /* Readiness numbers live on the thing you act on, not in a read-only panel. */
  // Same states as the verdict's own backup cases above -- an active
  // scheduler failure outranks even a healthy-looking stored count, since a
  // past success doesn't mean the NEXT scheduled attempt will land.
  const backupAttemptFailed = backupHealth === 'failing'
  const lastAttemptAge = maintenance.lastScheduledBackupAttempt
    ? formatAge(t, maintenance.lastScheduledBackupAttempt.executedAt)
    : null
  const backupState = backupAttemptFailed && lastAttemptAge
    ? t('workItems.backupsAttemptFailed', { age: lastAttemptAge })
    : backupHealth === 'skippedForRestart' && lastAttemptAge
      ? t('workItems.backupsSkippedForRestart', { age: lastAttemptAge })
      : maintenance.lastBackup
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

  // A row that names a page uses that page's sidebar label (one name per
  // page everywhere); Zombies and Errors name a fact, not a page.
  const pageLabel = (key: string) => t(`nav.items.${key}`, { ns: 'shell' })
  const workItems: WorkItem[] = [
    {
      id: 'players',
      to: '/players', icon: Activity, label: pageLabel('onlinePlayers'),
      state: online ? String(players.length) : t('liveActivity.offline'),
      tone: !online ? 'bad' : players.length > 0 ? 'good' : 'default',
    },
    {
      id: 'zombies',
      to: '/events', icon: Skull, label: t('workItems.zombies'),
      state: bridgeStatus?.modConnected ? (zombieCount !== null ? String(zombieCount) : t('connLine.pending')) : t('liveActivity.offline'),
      tone: !bridgeStatus?.modConnected ? 'default' : zombieCount !== null ? 'good' : 'default',
    },
    {
      // RCON state: straight to the Console's RCON tab.
      id: 'console',
      to: '/console?tab=rcon', icon: Wifi, label: pageLabel('serverConsole'),
      state: status?.rcon?.connected ? t('workItems.rconReady') : t('workItems.rconOffline'),
      tone: status?.rcon?.connected ? 'good' : 'warning',
    },
    {
      id: 'mods',
      to: '/mods', icon: Gamepad2, label: pageLabel('modManager'),
      state: modsPending ? t('workItems.modsToUpdate', { count: maintenance.modUpdatesAvailable }) : t('workItems.modsTracked', { count: maintenance.modsTracked }),
      tone: modsPending ? 'warning' : 'default',
    },
    // Only while the health check finds problems that stop mods from loading.
    ...(modHealthCritical ? [{
      id: 'mod-health',
      to: '/mods?view=health', icon: HeartPulse, label: tHealth('dashboard.label'),
      state: tHealth('dashboard.critical', { count: modHealthCritical }),
      tone: 'bad',
    } as WorkItem] : []),
    {
      id: 'schedule',
      to: '/scheduler', icon: CalendarClock, label: pageLabel('scheduledTasks'),
      state: scheduleState,
      tone: nextRunEta ? 'good' : maintenance.scheduledTasksCount > 0 ? 'good' : 'default',
    },
    ...(errorCount != null ? [{
      // Logged errors live in the server log: the Console's log tab.
      id: 'errors',
      to: '/console?tab=log', icon: ScrollText, label: t('workItems.errors'),
      state: errorCount === 0 ? t('workItems.errorsNone') : t('workItems.errorsLogged', { count: errorCount }),
      tone: errorCount === 0 ? 'good' : errorCount >= 50 ? 'warning' : 'default',
    } as WorkItem] : []),
    {
      id: 'backups',
      to: '/backups', icon: Archive, label: pageLabel('worldBackups'),
      state: backupState,
      tone: backupAttemptFailed ? 'bad' : backupHealth === 'skippedForRestart' || maintenance.backupCount === 0 ? 'warning' : 'good',
    },
    { id: 'config', to: '/server-config', icon: FileCog, label: pageLabel('serverConfiguration') },
  ]

  // WORK_STATE_TONE (DashboardVerdict.tsx) already colors each row by
  // severity, but color alone doesn't pull a 'bad' row up past several
  // calm ones above it in a 7-row list -- the operator has to read every
  // row to find it. Sorting by severity (stable, so same-tone rows keep
  // their original relative order) puts what needs attention where the
  // operator's own "actionable items on top" ask actually lands: the top
  // of the list, not just a different color partway down it.
  //
  // 'warning' collapses into the same bucket as 'default'/'good' rather
  // than getting its own rank (GH#137): 'warning' is the tone a normal
  // Stop/Restart passes through on the way to disconnecting RCON, so
  // ranking it above 'default' reshuffled the whole list on every
  // ordinary status poll while a server was merely stopping or starting
  // -- rows visibly swapping places for a state the operator caused
  // themselves and already knows about, not something that needed
  // surfacing. 'bad' (the server is actually unreachable) is the state
  // worth interrupting the list's order for; the rest stay in place and
  // let color alone carry the signal, same as they always did.
  const WORK_ITEM_SEVERITY: Record<'bad' | 'warning' | 'default' | 'good', number> = {
    bad: 0, warning: 1, default: 1, good: 1,
  }
  const sortedWorkItems = [...workItems].sort(
    (a, b) => WORK_ITEM_SEVERITY[a.tone ?? 'default'] - WORK_ITEM_SEVERITY[b.tone ?? 'default'],
  )

  /* ---------------------------- header ------------------------------------ */
  const isRemote = !!activeServer?.isRemote
  const refreshNow = async () => {
    if (refreshState === 'busy') return
    setRefreshState('busy')
    const startedAt = Date.now()
    await Promise.allSettled([fetchStatus(), fetchComposedStatus()])
    window.setTimeout(() => {
      setRefreshState('done')
      window.setTimeout(() => setRefreshState('idle'), 1500)
    }, Math.max(0, 600 - (Date.now() - startedAt)))
  }
  const openWipeDialog = () => {
    // The disabled flag is the affordance; this guard is the gate (a
    // disabled Radix menu item never selects, but the dialog it opens is
    // the single most destructive control in the product).
    if (!canWipeServer || !hasServer || online || isRemote) return
    setWipePreview(null)
    setWipeServerChangedSinceOpen(false)
    setWipeDialog(true)
  }
  const createBackupNow = () => {
    if (!canManageBackups) return
    void handleAction('Create backup', () => backupApi.createBackup().then(() => fetchMaintenance()))
  }

  // The server's own state, next to its name. Problems (crash reason,
  // RCON help, disk) are the verdict band's job just below.
  const statusPill: StatusPillProps = !hasServer
    ? { tone: 'idle', label: t('header.state.none') }
    : loading === 'Start server'
      ? { tone: 'busy', label: t('header.state.starting') }
      : loading === 'Stop server' || loading === 'Force stop server'
        ? { tone: 'busy', label: t('header.state.stopping') }
        : online
          ? rconConnected
            ? { tone: 'ok', label: t('header.state.running') }
            : { tone: 'warn', label: t('header.state.running'), detail: t('header.state.rconOffline') }
          : hostUnknown
            ? { tone: 'warn', label: t('header.state.unknown') }
            : { tone: 'error', label: t('header.state.stopped') }

  const addressChip = (key: 'lan' | 'wan' | 'panel', Icon: typeof Wifi, address: string, copyValue: string) => (
    <button
      type="button"
      onClick={() => copyToClipboard(copyValue, t(`addresses.${key}.copyLabel`))}
      className="group inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
      aria-label={t(`addresses.${key}.copyAria`, { address: copyValue })}
      title={t(`addresses.${key}.tooltip`)}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="font-medium">{t(`addresses.${key}.label`)}</span>
      <span className="font-mono tabular-nums text-foreground">{address}</span>
      <Copy className="h-3 w-3 shrink-0 opacity-50 transition-opacity group-hover:opacity-100" aria-hidden="true" />
    </button>
  )
  const gamePort = status?.port ? `:${status.port}` : ''

  const headerMeta = (
    <>
      {/* Uptime, counted live from the start time, with "started at" on
          hover, and an explicit "uptime unknown" when the server is up but
          the panel can't tell since when -- except for a remote SFTP
          server, which can never have a start time and whose remote badge
          already says why. In the meta row, so it never squeezes the name. */}
      {online && <ServerUptime startedAt={startedAt} showUnknown={provider !== 'remote-sftp'} />}
      {/* Map name, from PanelBridge: unknown (hidden) rather than guessed. */}
      {worldMap && (
        <span className="inline-flex items-center gap-1" title={t('header.mapTooltip')}>
          <MapIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {worldMap}
        </span>
      )}
      {isRemote && (
        <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          {t('header.remoteBadge')}
        </span>
      )}
      {status?.localIp && addressChip('lan', Wifi, `${status.localIp}${gamePort}`, `${status.localIp}${gamePort}`)}
      {status?.publicIp && addressChip('wan', Globe, `${status.publicIp}${gamePort}`, `${status.publicIp}${gamePort}`)}
      {panelInfo && addressChip('panel', Monitor, `${panelInfo.localIp}:${panelInfo.port}`, panelInfo.url)}
      {status?.publicIp && status?.port && (
        <a
          href={`steam://connect/${status.publicIp}:${status.port}`}
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          aria-label={t('addresses.join.aria', { address: `${status.publicIp}:${status.port}` })}
          title={t('addresses.join.tooltip')}
        >
          <Gamepad2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="font-medium">{t('addresses.join.label')}</span>
        </a>
      )}
    </>
  )

  // Contextual command: Start when stopped, Restart when running. With no
  // server at all it is "Add a server" -- unless the Add a server block is
  // already on screen, which is that same action spelled out.
  const headerPrimary = !hasServer ? (
    quickStartVisible ? undefined : (
      <Link to="/server-setup" className={buttonVariants({ variant: 'command', size: 'sm' })}>
        <Plus aria-hidden="true" /> {t('actions.addServer')}
      </Link>
    )
  ) : !online ? (
    <DisabledReason reason={
      isRemote ? t('actions.notAvailableRemote')
      : !canControlServer ? t('actions.noPermissionControl')
      : busyStart
    }>
      <Button
        onClick={startServer}
        disabled={(hostUnknown && !scanUnknown) || loading !== null || isRemote || !canControlServer || busyStart !== null}
        variant="command"
        size="sm"
      >
        {loading === 'Start server' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
        {t('actions.start')}
      </Button>
    </DisabledReason>
  ) : (
    <DisabledReason reason={isRemote ? t('actions.notAvailableRemote') : !canControlServer ? t('actions.noPermissionControl') : busyRestart}>
      <Button
        onClick={() => setConfirmAction({
          actionId: 'Restart server',
          title: t('confirm.restartServer.title'),
          description: t('confirm.restartServer.description'),
          action: () => serverApi.restart(5),
          variant: 'warning',
        })}
        disabled={loading !== null || !online || isRemote || !canControlServer || busyRestart !== null}
        variant="command"
        size="sm"
      >
        <RotateCcw aria-hidden="true" /> {t('actions.restart')}
      </Button>
    </DisabledReason>
  )

  // Refresh (icon, also the R key), then Stop as the one outline action.
  const headerSecondary = (
    <>
      <Button
        variant="ghost"
        size="iconDense"
        onClick={() => { void refreshNow() }}
        disabled={loading !== null}
        aria-label={t('actions.refreshStatus')}
        aria-keyshortcuts="R"
        aria-busy={refreshState === 'busy'}
        title={t('actions.refreshStatus')}
        data-refresh-state={refreshState}
      >
        {refreshState === 'done'
          ? <Check className="text-success" aria-hidden="true" />
          : <RefreshCw className={refreshState === 'busy' ? 'animate-spin' : undefined} aria-hidden="true" />}
      </Button>
      {online && (
        <DisabledReason reason={!canControlServer ? t('actions.noPermissionControl') : busyStop}>
          <Button
            onClick={() => setConfirmAction({
              actionId: 'Stop server',
              title: t('confirm.stopServer.title'),
              description: t('confirm.stopServer.description'),
              action: serverApi.stop,
              // Same severity class as Restart (reversible, comes back with
              // a click): warning, not destructive-red.
              variant: 'warning',
            })}
            disabled={loading !== null || !online || !canControlServer || busyStop !== null}
            variant="outline"
            size="sm"
          >
            {loading === 'Stop server' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Square aria-hidden="true" />}
            {t('actions.stop')}
          </Button>
        </DisabledReason>
      )}
    </>
  )

  // Everything else, in the "…" menu: a disabled item shows its reason
  // under its label. Each onSelect re-checks its gate (the disabled flag is
  // the affordance, the guard is the gate).
  const headerMenu: ServerHeaderMenuItem[] = []
  if (online) {
    headerMenu.push(
      {
        label: t('actions.forceStop'),
        icon: Skull,
        onSelect: () => {
          if (!canControlServer || isRemote) return
          setConfirmAction({
            actionId: 'Force stop server',
            title: t('confirm.forceStopServer.title'),
            description: t('confirm.forceStopServer.description') + (players.length > 0 ? t('confirm.forceStopServer.descriptionPlayers', { count: players.length }) : ''),
            action: serverApi.forceStop,
            variant: 'destructive',
          })
        },
        disabled: loading !== null || isRemote || !canControlServer || busyForceStop !== null,
        reason: isRemote ? t('actions.notAvailableRemote') : !canControlServer ? t('actions.noPermissionControl') : busyForceStop ?? undefined,
        hint: t('actions.forceStopTooltip'),
      },
      {
        label: t('actions.saveWorld'),
        icon: Save,
        onSelect: saveWorld,
        // Save goes over RCON (serverApi.save): say so instead of a grey item.
        disabled: loading !== null || !rconConnected || !canControlServer,
        reason: !canControlServer ? t('actions.noPermissionControl') : !rconConnected ? t('actions.saveNeedsRcon') : undefined,
      },
      {
        label: t('actions.restartNow'),
        icon: Zap,
        onSelect: () => {
          if (!canControlServer || isRemote) return
          setConfirmAction({
            actionId: 'Restart server now',
            title: t('confirm.restartServerNow.title'),
            description: t('confirm.restartServerNow.description') + (players.length > 0 ? t('confirm.restartServerNow.descriptionPlayers', { count: players.length }) : ''),
            action: () => serverApi.restart(0),
            variant: 'destructive',
          })
        },
        disabled: loading !== null || isRemote || !canControlServer || busyRestart !== null,
        reason: isRemote ? t('actions.notAvailableRemote') : !canControlServer ? t('actions.noPermissionControl') : busyRestart ?? undefined,
      },
    )
  }
  if (!rconConnected && canExecuteRcon) {
    headerMenu.push({
      label: t('actions.connectRcon'),
      icon: Wifi,
      onSelect: () => { void handleConnect() },
      disabled: !hasServer || loading !== null || (!isRemote && !hostRunning),
      reason: !hasServer ? t('actions.addServerFirst') : !isRemote && !hostRunning ? t('actions.connectRconNeedsHostRunning') : undefined,
    })
  }
  headerMenu.push(
    {
      label: t('actions.createBackup'),
      icon: Archive,
      onSelect: createBackupNow,
      disabled: !hasServer || loading !== null || isRemote || !canManageBackups,
      reason: !hasServer ? t('actions.addServerFirst')
        : isRemote ? t('actions.notAvailableRemote')
        : !canManageBackups ? t('actions.noPermissionCreateBackup')
        : undefined,
    },
    {
      label: t('verdict.bridgeSettingsLink'),
      icon: Wrench,
      onSelect: () => navigate('/settings?tab=bridge'),
    },
    {
      label: t('actions.wipeServer'),
      icon: Trash2,
      destructive: true,
      onSelect: openWipeDialog,
      disabled: !hasServer || online || loading !== null || isRemote || !canWipeServer,
      // Capability before the transient "server is running" reason: a role
      // that will never hold server.wipe is told that, not sent to wait.
      reason: !hasServer ? t('actions.addServerFirst')
        : isRemote ? t('actions.notAvailableRemote')
        : !canWipeServer ? t('actions.noPermissionWipe')
        : online ? t('actions.wipeMustStopFirst')
        : undefined,
    },
  )

  /* ---------------------------- alerts ------------------------------------ */
  // One stack under the header, errors first; the verdict band below keeps
  // the server's own state. A connection error the verdict already states
  // ("Panel cannot reach the server", with Retry) is not repeated here.
  const alerts: PageAlert[] = []
  if (fetchError && verdict.headline !== t('verdict.panelCannotReach')) {
    alerts.push({
      id: 'connection',
      tone: 'error',
      title: t('connectionError.label'),
      description: `${fetchError}${t('connectionError.suffix')}`,
      action: { label: t('connectionError.retry'), onClick: () => { void fetchStatus() } },
    })
  }
  if (panelUpdate?.updateAvailable) {
    const latest = panelUpdate.latestVersion
    const sameVersion = !!latest && latest === panelUpdate.currentVersion
    const dismissed = !!latest && panelUpdateDismissedVersion === latest
    if (!sameVersion && !dismissed) {
      const isStaged = !!panelUpdate.stagedUpdate && (!latest || panelUpdate.stagedUpdate.version === latest)
      const lastFailed = panelUpdate.lastApplyResult?.status === 'failed'
        && (!latest || panelUpdate.lastApplyResult.pendingVersion === latest)
      alerts.push({
        id: 'panel-update',
        tone: lastFailed ? 'error' : 'info',
        title: lastFailed ? t('panelUpdateBanner.applyFailed') : isStaged ? t('panelUpdateBanner.updateStaged') : t('panelUpdateBanner.panelUpdate'),
        description: (
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span>
              {lastFailed
                ? t('panelUpdateBanner.lastApplyFailedDesc')
                : isStaged
                  ? t('panelUpdateBanner.stagedDesc')
                  : t('panelUpdateBanner.newVersionDesc')}
            </span>
            {latest && (
              <span className="font-mono text-xs tabular-nums text-foreground">
                v{panelUpdate.currentVersion} → v{latest}
              </span>
            )}
            {/* updateAvailable stays true across later failed checks, so the
                result carries its age instead of reading as fresh. */}
            {panelUpdate.lastCheck && (
              <span className="text-xs">{t('panelUpdateBanner.checkedAgo', { age: formatAge(t, panelUpdate.lastCheck) })}</span>
            )}
          </span>
        ),
        action: { label: isStaged ? t('panelUpdateBanner.applyUpdate') : t('panelUpdateBanner.viewUpdate'), to: '/settings?tab=updates' },
        onDismiss: latest
          ? () => {
              try { sessionStorage.setItem('panel-update-banner-dismissed', latest) } catch { /* ignore storage failures */ }
              setPanelUpdateDismissedVersion(latest)
            }
          : undefined,
      })
    }
  }
  // Quiet on purpose: the panel works, it just can't tell whether a newer
  // version exists (an air-gapped install). Dismissed per error text, so a
  // different failure later shows again.
  if (panelUpdate && !panelUpdate.updateAvailable && panelUpdate.lastError && panelUpdateErrorDismissed !== panelUpdate.lastError) {
    const lastError = panelUpdate.lastError
    alerts.push({
      id: 'update-check',
      tone: 'info',
      title: t('updateCheckError.label'),
      description: <span className="line-clamp-2 break-words" title={lastError}>{lastError}</span>,
      action: { label: t('nav.items.panelSettings', { ns: 'shell' }), to: '/settings?tab=updates' },
      onDismiss: () => {
        try { localStorage.setItem(PANEL_UPDATE_ERROR_DISMISSED_KEY, lastError) } catch { /* ignore storage failures */ }
        setPanelUpdateErrorDismissed(lastError)
      },
    })
  }

  /* ---------------------------- telemetry label --------------------------- */
  // The history comes from the server's own persisted log, independent of
  // the online check -- recent samples can survive while that check can't
  // confirm the server, and calling those "live" contradicted the verdict.
  const telemetryLabel = (() => {
    if (performanceHistory.length === 0) return online ? t('telemetry.sampling') : t('telemetry.standby')
    const first = performanceHistory[0].timestamp
    const last = performanceHistory[performanceHistory.length - 1].timestamp
    const spanSec = performanceHistory.length >= 2 && first && last
      ? (new Date(last).getTime() - new Date(first).getTime()) / 1000
      : null
    if (!online) {
      if (spanSec === null) return t('telemetry.unconfirmed')
      return spanSec < 120
        ? t('telemetry.lastSecondsUnconfirmed', { seconds: Math.round(spanSec) })
        : t('telemetry.lastMinutesUnconfirmed', { minutes: Math.round(spanSec / 60) })
    }
    if (spanSec === null) return t('telemetry.live')
    return spanSec < 120
      ? t('telemetry.lastSecondsLive', { seconds: Math.round(spanSec) })
      : t('telemetry.lastMinutesLive', { minutes: Math.round(spanSec / 60) })
  })()

  /* ====================================================================== */
  /*  RENDER                                                                  */
  /* ====================================================================== */
  return (
    <div className="page-transition space-y-6 pb-12">
      {/* The header names the server and owns its controls. <header> with
          the "Server status" name, so the controls are findable as one group. */}
      <header aria-label={t('header.ariaLabel')}>
        <ServerHeader
          name={activeServer?.serverName ?? t('header.noActiveServer')}
          status={statusPill}
          meta={headerMeta}
          secondary={headerSecondary}
          primary={headerPrimary}
          menu={headerMenu}
        />
      </header>

      <AutoUpdateResultBanner />
      <PageAlerts alerts={alerts} />

      {/* ─── VERDICT ────────────────────────────────────────────────────── */}
      <VerdictBand
        verdict={verdict}
        players={presence}
        showPresence={online}
        lastUpdated={lastUpdated}
        stale={staleLink}
      />

      {/* ─── Add a server (first run) ──────────────────────────────────────
          Exactly one confident discovery match: one specific next action,
          not a picker (rule 3). Otherwise the same three choices as the
          Servers page and the Add a Server page, with the one that fits
          this install marked: a container overwhelmingly means existing
          files mounted in, not a SteamCMD download inside it. */}
      {quickStartVisible && (
        <SectionCard
          title={readyCandidates.length === 1 ? t('quickStart.foundHeading') : t('quickStart.title')}
          icon={readyCandidates.length === 1 ? FolderOpen : Plus}
          description={readyCandidates.length === 1 ? (
            <>
              <code className="font-mono text-xs text-foreground">{readyCandidates[0].installPath}</code>
              {' — '}
              {t('quickStart.foundDesc')}
            </>
          ) : t('quickStart.description')}
          actions={
            <Button variant="ghost" size="iconDense" onClick={dismissQuickStart} aria-label={t('quickStart.dismissAria')}>
              <X aria-hidden="true" />
            </Button>
          }
        >
          {readyCandidates.length === 1 ? (
            <div className="flex flex-wrap gap-2">
              <Link to="/servers" className={buttonVariants({ variant: 'command', size: 'sm' })}>
                <FolderOpen aria-hidden="true" /> {t('quickStart.reviewAndConnect')}
              </Link>
              <Link to="/server-setup" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                {t('quickStart.setUpDifferently')}
              </Link>
            </div>
          ) : (
            <AddServerChoices recommended={isContainerized ? 'existing' : 'fresh'} className="max-w-2xl" />
          )}
        </SectionCard>
      )}
      {/* ─── EVERY SERVER (two or more) ───────────────────────────────────── */}
      <ServersOverview
        activeServerId={activeServerId}
        autoStartSettings={autoStartSettings}
        canChangeAutoStart={canChangePanelSettings}
        onAutoStartChange={(server, chosen) => handleAutoStartChange(chosen, server)}
        onRestartOnCrashChange={(server, chosen) => handleRestartOnCrashChange(chosen, server)}
        onShownChange={setServersOverviewShown}
      />

      {/* ─── EVIDENCE AND WORK ──────────────────────────────────────────── */}
      <div className="grid content-start gap-6 xl:grid-cols-[minmax(0,1fr)_19rem] xl:items-start">

        {/* ════ CENTER ════ */}
        <div className="grid min-w-0 content-start gap-6 2xl:grid-cols-2 2xl:items-start">

          {/* TELEMETRY */}
          <SectionCard
            title={t('telemetry.heading')}
            icon={Cpu}
            status={<span className="text-xs text-muted-foreground">{telemetryLabel}</span>}
            density="compact"
            flush
          >
            {performanceHistory.length > 0 ? (
              <Suspense
                fallback={
                  <div className="space-y-2 p-4">
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
              <p className="px-4 py-3 text-sm text-muted-foreground">
                {online ? t('telemetry.placeholderOnline') : t('telemetry.placeholderOffline')}
              </p>
            )}
          </SectionCard>

          {/* LIVE ACTIVITY */}
          <SectionCard
            title={t('liveActivity.heading')}
            icon={Activity}
            // No status dot: whether the server is up is the header's answer.
            status={
              <span className="text-xs text-muted-foreground">
                {playerActivity.length > 0 ? t('liveActivity.eventsCount', { count: playerActivity.length }) : online ? t('liveActivity.idle') : t('liveActivity.offline')}
              </span>
            }
            density="compact"
            flush
          >
            {playerActivity.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                {/* Same !isRemote rule as the verdict: a remote server never
                    has a local launch folder, so it is "not running", not
                    "not configured". */}
                {online
                  ? t('liveActivity.emptyOnline')
                  : status?.serverPathConfigured || isRemote
                    ? t('liveActivity.emptyConfiguredNotRunning')
                    : t('liveActivity.emptyNotConfigured')}
              </p>
            ) : (
              <ol className="max-h-[15rem] min-h-0 divide-y divide-border/30 overflow-y-auto">
                {playerActivity.map(a => {
                  const s = eventStyle(t, a.action)
                  return (
                    <li key={a.id} className="grid grid-cols-[3.5rem_1rem_minmax(0,8rem)_minmax(0,1fr)] items-center gap-2 px-4 py-1.5 transition-colors hover:bg-accent/20">
                      <time className="font-mono text-xs tabular-nums text-muted-foreground">
                        {formatTime(a.logged_at, { pad: true })}
                      </time>
                      <span className={cn('flex justify-center', s.tone)} aria-hidden="true">{s.icon}</span>
                      <span className="truncate text-xs font-medium text-foreground" dir="auto" title={a.player_name}>
                        {a.player_name}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {s.verb}
                      </span>
                    </li>
                  )
                })}
              </ol>
            )}
          </SectionCard>
        </div>

        {/* ════ WORK ════ */}
        <aside className="grid content-start gap-6">

          {/* DESTINATIONS — each one carries its own live state */}
          <SectionCard title={t('workItems.heading')} icon={ListChecks} density="compact" flush>
            <WorkList items={sortedWorkItems} />
            <div className="border-t border-border/40 px-4 py-1.5">
              <ConnLine
                label={t('connLine.rcon')}
                state={status?.rcon?.connected ? 'on' : 'off'}
                value={status?.rcon?.host && status.rcon.port ? `${status.rcon.host}:${status.rcon.port}` : undefined}
                mono={!!(status?.rcon?.host && status.rcon.port)}
              />
              <ConnLine
                label={t('connLine.bridge')}
                state={bridgeStatus?.modConnected ? 'on' : bridgeStatus?.isRunning ? 'wait' : 'off'}
                value={
                  bridgeStatus?.modConnected && bridgeStatus.modStatus?.version
                    ? `v${bridgeStatus.modStatus.version.replace(/^v/, '')}`
                    : bridgeStatus?.isRunning ? t('connLine.pending') : t('connLine.offline')
                }
                mono={!!(bridgeStatus?.modConnected && bridgeStatus.modStatus?.version)}
              />
            </div>
          </SectionCard>

          {/* MAINTENANCE: refresh is the header's icon (and R), Wipe is in
              the header's menu; what stays here is the routine pair. */}
          {!isRemote && (
            <SectionCard title={t('maintenance.heading')} icon={Wrench} density="compact">
              <DisabledReason
                className="w-full"
                reason={!canManageBackups ? t('actions.noPermissionCreateBackup') : null}
              >
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full justify-start"
                  disabled={!hasServer || loading !== null || isRemote || !canManageBackups}
                  onClick={createBackupNow}
                >
                  {loading === 'Create backup' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Archive aria-hidden="true" />}
                  {t('maintenance.createBackup')}
                </Button>
              </DisabledReason>
              {/* With the servers overview on screen, each row has its own. */}
              {!serversOverviewShown && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/25 p-3">
                <div className="min-w-0">
                  <Label htmlFor="autoStartServer" className="text-sm font-medium">
                    {t('maintenance.autoStartLabel')}
                  </Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t('maintenance.autoStartDesc')}</p>
                </div>
                <DisabledReason reason={!canChangePanelSettings ? t('actions.noPermissionAutoStart') : null}>
                  <Switch
                    id="autoStartServer"
                    checked={autoStartThisServer}
                    disabled={!canChangePanelSettings}
                    onCheckedChange={(checked) => handleAutoStartChange(checked === true)}
                  />
                </DisabledReason>
              </div>
              )}
              {!serversOverviewShown && activeServer && !activeServer.isRemote && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/25 p-3">
                <div className="min-w-0">
                  <Label htmlFor="restartOnCrash" className="text-sm font-medium">
                    {t('serversOverview.restartOnCrashLabel')}
                  </Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t('serversOverview.restartOnCrashHint')}</p>
                </div>
                <DisabledReason reason={!canChangePanelSettings ? t('actions.noPermissionAutoStart') : null}>
                  <Switch
                    id="restartOnCrash"
                    checked={restartOnCrashThisServer}
                    disabled={!canChangePanelSettings}
                    onCheckedChange={(checked) => handleRestartOnCrashChange(checked === true)}
                  />
                </DisabledReason>
              </div>
              )}
            </SectionCard>
          )}

          {bridgeStatus && !bridgeStatus.configured && (
            <div className="rounded-lg border border-border/60 bg-muted/40 p-3 text-sm">
              <p className="font-medium text-foreground">{t('bridgeOfflineNotice.title')}</p>
              <p className="mt-1 text-muted-foreground">
                {t('bridgeOfflineNotice.description')}{' '}
                <Link to="/settings?tab=bridge" className="text-primary underline-offset-2 hover:underline">{t('bridgeOfflineNotice.configureLink')}</Link>.
              </p>
            </div>
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
      <AlertDialog open={wipeDialog} onOpenChange={(open) => { if (!open && !wipeLoading) { setWipeDialog(false); setWipePreview(null); setWipeServerChangedSinceOpen(false) } }}>
        {/* 2026-09 dialog sweep: this scrolled as a whole under its own
            85vh cap, so Preview and "Wipe now" were below the fold at every
            common size and the preview itself appeared off-screen. It now
            takes AlertDialogContent's own bound, and only the targets,
            backup and preview scroll, in an AlertDialogBody; the backup
            progress and the buttons stay put. */}
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

          {wipeServerChangedSinceOpen && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{t('wipeDialog.serverChangedSinceOpen')}</span>
            </div>
          )}

          <AlertDialogBody className="space-y-3">
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
              <div className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm">
                <p className="font-medium text-destructive">{t('wipeDialog.noBackupTitle')}</p>
                <p className="text-muted-foreground">{t('wipeDialog.noBackupDesc')}</p>
              </div>
            )}

            {wipePreview && (
              <div ref={wipePreviewRef} className="space-y-1 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
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
          </AlertDialogBody>

          {wipeLoading && wipeBackupProgress && wipeBackupProgress.phase !== 'complete' && (
            <div className="space-y-1.5 rounded-md border border-border/50 bg-muted/30 p-3 text-sm">
              <div className="text-muted-foreground">{wipeBackupProgress.message}</div>
              <Progress value={wipeBackupProgress.percent} className="h-1.5" />
            </div>
          )}

          <AlertDialogFooter className="gap-2 sm:gap-2">
            <AlertDialogCancel className="mt-0" disabled={wipeLoading} onClick={() => { setWipeDialog(false); setWipePreview(null); setWipeServerChangedSinceOpen(false) }}>{t('wipeDialog.cancel')}</AlertDialogCancel>
            {!wipePreview ? (
              <Button
                variant="warning"
                disabled={!Object.values(wipeTargets).some(Boolean) || wipeLoading || !canWipeServer || wipeServerChangedSinceOpen}
                onClick={async () => {
                  // POST /server/wipe/preview requires server.wipe too --
                  // guarded here as well as on the DropdownMenuItem that
                  // opens this dialog, so this stays safe even if something
                  // else ever opens wipeDialog without checking first.
                  // wipeServerChangedSinceOpen: see that state's own comment --
                  // the function guard is the real gate, disabled= is only
                  // the affordance (same convention as Console.tsx).
                  if (wipeLoading || !canWipeServer || wipeServerChangedSinceOpen) return
                  setWipeLoading(true)
                  try {
                    const targets = Object.entries(wipeTargets).filter(([, v]) => v).map(([k]) => k)
                    const res = await serverApi.wipePreview(targets)
                    setWipePreview(res)
                  } catch (e: unknown) {
                    toast({ title: t('wipeDialog.previewFailedTitle'), description: getUserErrorMessage(e, t('wipeDialog.previewFailedFallback')), variant: 'destructive' })
                  } finally { setWipeLoading(false) }
                }}
              >
                {wipeLoading ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : null}
                {t('wipeDialog.preview')}
              </Button>
            ) : (
              <Button
                variant="destructive"
                disabled={wipeLoading || wipePreview.totalFiles === 0 || !canWipeServer || wipeServerChangedSinceOpen}
                onClick={async () => {
                  if (wipeLoading || !canWipeServer || wipeServerChangedSinceOpen) return
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
                    toast({ title: t('wipeDialog.wipeFailedTitle'), description: getUserErrorMessage(e, t('wipeDialog.wipeFailedFallback')), variant: 'destructive' })
                  } finally { setWipeLoading(false); setWipeBackupProgress(null) }
                }}
              >
                {wipeLoading ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Trash2 className="me-2 h-4 w-4" />}
                {t('wipeDialog.wipeNow')}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
