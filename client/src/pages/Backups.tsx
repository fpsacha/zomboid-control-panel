import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Archive,
  Download,
  Trash2,
  RotateCcw,
  Loader2,
  Clock,
  HardDrive,
  FolderOpen,
  RefreshCw,
  CalendarClock,
  AlertTriangle,
  Check,
  Upload,
  FileText,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NumberInput } from '@/components/NumberInput'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { HelpTip } from '@/components/HelpTip'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Progress } from '@/components/ui/progress'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { SectionCard } from '@/components/ui/section-card'
import { StatStrip, type StatStripItem } from '@/components/ui/stat-strip'
import { StatusPill } from '@/components/ui/status-pill'
import { Toolbar } from '@/components/ui/toolbar'
import { RowActions } from '@/components/ui/row-actions'
import { PageAlerts, type PageAlert } from '@/components/PageAlerts'
import { SaveBar } from '@/components/SaveBar'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogBody,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/components/ui/use-toast'
import { useSocket } from '@/contexts/SocketContext'
import { backupApi, serversApi, BackupStatus, ServerBackupArchive, BackupHistoryRecord, BackupSnapshot, type RestoreOutcome } from '@/lib/api'
import { ScheduledBackupServers } from '@/components/backups/ScheduledBackupServers'
import { cn } from '@/lib/utils'
import { getUserErrorMessage } from '@/lib/errorMessage'
import {
  RESTORE_STATUS_POLL_MS,
  RestoreNotStartedError,
  RestoreOutcomeUnknownError,
  newRestoreRequestId,
  restoreBackupAndConfirm,
} from '@/lib/restoreOutcome'
import { PageHeader } from '@/components/PageHeader'
import { DisabledReason } from '@/components/DisabledReason'
import { useAuth } from '@/contexts/AuthContext'
import { EmptyState } from '@/components/EmptyState'
import { BackupRestartOverlapNotice } from '@/components/BackupRestartOverlapNotice'
import { scheduledAttemptMessage, scheduledBackupHealth } from '@/lib/scheduledBackupHealth'
import { isolateLtrForRtl } from '@/lib/paramTranslation'
import { useBackupScheduleCheck, precheckBackupSchedule, backupScheduleErrorText } from '@/hooks/useBackupScheduleCheck'
import { BackupScheduleNextRun, BackupScheduleValidity } from '@/components/BackupSchedulePreview'
import { useDateFormat } from '@/lib/dateFormat'

// The Backup Frequency presets, in menu order -- one list for the <Select>
// and describeSchedule() so the two can't disagree about which expressions
// have a friendly name.
const SCHEDULE_PRESETS = [
  ['*/15 * * * *', 'schedule.every15Min'],
  ['*/30 * * * *', 'schedule.every30Min'],
  ['0 * * * *', 'schedule.everyHour'],
  ['0 */2 * * *', 'schedule.every2Hours'],
  ['0 */4 * * *', 'schedule.every4Hours'],
  ['0 */6 * * *', 'schedule.every6Hours'],
  ['0 */8 * * *', 'schedule.every8Hours'],
  ['0 */12 * * *', 'schedule.every12Hours'],
  ['0 0 * * *', 'schedule.dailyMidnight'],
  ['0 6 * * *', 'schedule.daily6am'],
  ['0 12 * * *', 'schedule.dailyNoon'],
  ['0 18 * * *', 'schedule.daily6pm'],
] as const
const PRESET_CRONS = new Set<string>(SCHEDULE_PRESETS.map(([cron]) => cron))
// Radix <Select> values must be non-empty strings and can't collide with a
// real cron expression.
const CUSTOM_SCHEDULE_VALUE = 'custom'

// ?panel=schedule opens the "Schedule & retention" card (and scrolls to
// it): the Scheduler's backup-health card and the Dashboard link here.
const SCHEDULE_PANEL = 'schedule'
const SCHEDULE_CARD_ID = 'backup-schedule'

// The saved schedule GET /status sent, '' when it sent none. A partial
// answer (the demo build's catch-all reply had no schedule at all) put
// undefined into the form's string state, and customCron.trim() then took
// the whole page down. '' leaves the frequency menu on its placeholder.
function savedScheduleOf(status: BackupStatus): string {
  return typeof status.schedule === 'string' ? status.schedule : ''
}

interface BackupProgress {
  phase: 'preparing' | 'archiving' | 'finalizing' | 'complete' | 'error'
  percent: number
  message: string
  filesProcessed?: number
  totalFiles?: number
  currentFile?: string
}

// How a restore this page showed ended (GH#166): the Restore card's
// finished state, kept on screen until dismissed or another restore starts
// -- a restore runs for minutes, and a toast alone is gone by the time the
// operator looks back. 'unknown' is the honest answer when nothing could
// say (see RestoreOutcomeUnknownError); its `requestId` is this page's own
// restore's, whose real outcome replaces it if the status records one
// later (see fetchBackupStatus). `safetyBackup`: the replaced world was
// backed up first -- always for this page's own restores, and for a
// watched one only when the status says so.
type RestoreResult =
  | { status: 'success'; backupName: string | null; seconds: number | null; safetyBackup: boolean }
  | { status: 'failed'; backupName: string | null; reason: string | null }
  | { status: 'unknown'; backupName: string | null; requestId: string | null }

function restoreResultFrom(outcome: RestoreOutcome | null, backupName: string | null): RestoreResult {
  if (!outcome) return { status: 'unknown', backupName, requestId: null }
  if (outcome.success) {
    return {
      status: 'success',
      backupName: outcome.backupName,
      seconds: outcome.duration,
      safetyBackup: outcome.preRestoreBackup === true,
    }
  }
  return { status: 'failed', backupName: outcome.backupName, reason: outcome.message }
}

// A backup progress card past its last event: finished or failed, and
// about to clear itself.
function isBackupProgressFinal(progress: BackupProgress | null) {
  return progress?.phase === 'complete' || progress?.phase === 'error'
}

export default function Backups() {
  // 'settings' loaded alongside 'backups' only to reuse settings.json's
  // existing backups.statusLoadFailed copy (see the badge/switch block
  // below) -- Settings.tsx's own scheduled-backups toggle already shipped
  // that exact "couldn't check, disabled until it loads" string in all 9
  // locales; reusing it here needed no new translation.
  const { t } = useTranslation(['backups', 'settings'])
  const { formatDateTime } = useDateFormat()
  const { toast } = useToast()
  const socket = useSocket()
  const { can } = useAuth()
  // Bound to routes/backup.js's own requirePermission() gates, not to what
  // the button label implies -- restore/download are deliberately split
  // out from backups.manage (see that route file's header comments: restore
  // overwrites a live world, download exfiltrates a full copy).
  const canManageBackups = can('backups.manage')
  const canRestoreBackups = can('backups.restore')
  const canDownloadBackups = can('backups.download')
  const canOpenDiagnostics = can('diagnostics.manage')

  // Refs for cleanup
  const progressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // State
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null)
  // bug-hunt-2026-09-08 (honest-unknown class, GH#149 siblings sweep):
  // backupStatus is null both before the first fetch resolves AND after one
  // fails -- the status card's badge/switch below used to read
  // `backupStatus?.enabled` as a bare boolean either way, so a slow or
  // failed status fetch rendered a confident "Off, no scheduled backups"
  // with the toggle still clickable. Same shape as Settings.tsx's own
  // scheduled-backups toggle had before it was fixed with this exact flag.
  const [backupStatusLoadError, setBackupStatusLoadError] = useState(false)
  const [backups, setBackups] = useState<ServerBackupArchive[]>([])
  // Set once fetchBackups() itself has settled (success or failure), distinct
  // from the shared `loading` flag below which only clears once ALL THREE of
  // refreshAll()'s concurrent fetches finish. Without this, `backups.length
  // === 0` is ambiguous between "confirmed empty" and "not fetched yet" --
  // exactly the gap that let the main card show an infinite spinner even
  // after backupStatus (a DIFFERENT one of those three fetches) had already
  // resolved to a definitive "no saves folder" answer visible in the header
  // above it (2026-08-30 visual sweep).
  const [backupsLoaded, setBackupsLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creatingBackup, setCreatingBackup] = useState(false)
  // bug-hunt-2026-09-06: fetchBackupStatus below only ever sets this TRUE
  // (see its own comment) when it detects a backup already running
  // elsewhere at mount/refresh -- if that backup's terminal backup:progress
  // event never reaches THIS session, nothing else was polling
  // backupInProgress to correct it, so creatingBackup could stay stuck true
  // indefinitely (Create/Restore disabled, no error, page still navigable
  // but silently wrong). ownBackupInFlightRef distinguishes that path from
  // THIS session's own handleCreateBackup call, which already has its own
  // finally clearing creatingBackup regardless of the socket -- the
  // watchdog below must never interfere with that one.
  const ownBackupInFlightRef = useRef(false)
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null)
  // GH#166 ("World Recovery View do not get finished"): the Restore card
  // used to spin forever after a restore that had finished fine. Every
  // restore's safety backup reports its own backup:progress 'complete'
  // mid-restore, the handler below re-reads the status then, and that read
  // says restoreInProgress:true -- a restore IS running. When this page's
  // restore returned, nothing read the status again, so the moment
  // restoringBackup cleared, that stale flag turned the card into "A
  // restore is already in progress" with nothing left that could ever end
  // it: no poll, no listener for the restore's own events. A page that only
  // SAW a restore (another tab, or loaded mid-restore) had the same dead
  // end. Now: this page's own restore ends through restoreBackupAndConfirm()
  // (its request, or the outcome read back from the status when that
  // request's answer is lost); any other is followed through the status
  // (see fetchBackupStatus) until it ends; both leave restoreResult.
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null)
  // This page's own restore lost its request's answer and is now reading
  // the outcome back from the status (see restoreBackupAndConfirm()).
  const [restoreResponseLost, setRestoreResponseLost] = useState(false)
  // The id this page gave its latest restore -- a status read taken while
  // it ran still names it, and that's not a restore "elsewhere". State for
  // the render-time check, mirrored in a ref for the status callback.
  const [ownRestoreId, setOwnRestoreId] = useState<string | null>(null)
  const ownRestoreIdRef = useRef<string | null>(null)
  const ownRestoreInFlightRef = useRef(false)
  // A restore this page didn't start, seen running in the status: which one,
  // so its end can be read off lastRestore.
  const watchedRestoreRef = useRef<{ id: string | null; backupName: string | null } | null>(null)
  // This page's own restore that ended "couldn't confirm": the panel was
  // unreachable too long, and may well record how it ended once it's back.
  const unknownRestoreIdRef = useRef<string | null>(null)
  // Status reads overlap (socket events, the restore re-check, a refresh);
  // an answer older than one already applied is dropped -- a read taken
  // mid-restore landing after the restore ended would put it back on
  // screen as still running.
  const statusReadSeqRef = useRef(0)
  const appliedStatusReadSeqRef = useRef(0)
  // The last status read sent before this page's own restore request
  // settled: a later read that still shows that restore running means the
  // request's answer was wrong (see fetchBackupStatus), an earlier one is
  // just from mid-restore.
  const ownRestoreSettledAtReadRef = useRef(0)
  // The same boundary for the backup progress card: the last status read
  // sent before the card last changed. Only a later read's "no backup
  // running" may clear it.
  const backupProgressAtReadRef = useRef(0)
  const [deletingBackups, setDeletingBackups] = useState(false)
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null)
  const [uploadingBackup, setUploadingBackup] = useState(false)
  const [uploadPercent, setUploadPercent] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Active server context — backups don't apply to remote servers because
  // the panel can't reach the remote filesystem. Fetched on mount and
  // refreshed by the activeServerChanged socket effect below.
  const [activeServerRemote, setActiveServerRemote] = useState(false)
  const [activeServerId, setActiveServerId] = useState<string | number | null>(null)
  const [history, setHistory] = useState<BackupHistoryRecord[]>([])
  // bug-hunt-2026-09-04: the comment on activeServerRemote/activeServerId
  // above CLAIMED this already refreshed on the server-changed socket event
  // "via socket effect below" -- it didn't; only backup:progress was ever
  // subscribed. createBackup()/restoreBackup(name)/deleteBackup(name) all
  // resolve the active server fresh server-side per-request (same pattern
  // as ServerConfig's ini/sandbox routes), so a stale display here isn't
  // just cosmetic: restoreBackup is a live-world overwrite. True only for
  // the brief window between the switch and refreshAll() landing, and used
  // to also close any destructive dialog left open across a switch, since
  // its own local state (a specific backup name) doesn't update just
  // because the list behind it refreshed.
  const [serverChangedSinceLoad, setServerChangedSinceLoad] = useState(false)
  // Named in the restore confirmation itself, read fresh at the moment the
  // dialog opens -- not from activeServerId/mount state -- because the
  // named confirm is meant to protect every path to an accidental restore,
  // including ones the switch-then-click banner above doesn't cover. The
  // last thing a user reads before an irreversible world overwrite should
  // never be able to lie about which world that is.
  const [restoreTargetServerName, setRestoreTargetServerName] = useState<string | null>(null)

  // Selection state
  const [selectedBackups, setSelectedBackups] = useState<Set<string>>(new Set())

  // Settings state. The "Schedule & retention" card is open while the URL
  // says ?panel=schedule, so a link (Scheduler, Dashboard) or a reload
  // lands on it; toggling it replaces the history entry and keeps every
  // other parameter.
  const [searchParams, setSearchParams] = useSearchParams()
  const showSettings = searchParams.get('panel') === SCHEDULE_PANEL
  const setShowSettings = useCallback((open: boolean) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous)
      if (open) next.set('panel', SCHEDULE_PANEL)
      else next.delete('panel')
      return next
    }, { replace: true })
  }, [setSearchParams])
  const [backupSchedule, setBackupSchedule] = useState('0 */6 * * *')
  // Custom cron option (2026-09-27 community request): the frequency menu
  // only offered presets, while Settings > Backups has always taken a raw
  // cron expression -- the two pages edit the same saved schedule, so a
  // custom one set there showed up here as an empty menu. `customSchedule`
  // is the menu's own "Custom" choice; `customCron` is what's typed.
  const [customSchedule, setCustomSchedule] = useState(false)
  const [customCron, setCustomCron] = useState('')
  // The last schedule loaded from the server. Status refetches happen on
  // their own (a scheduled backup finishing, another tab's save) -- only a
  // CHANGED saved schedule may overwrite the form, never one the operator
  // is halfway through typing.
  const loadedScheduleRef = useRef<string | null>(null)
  // Same rule for the other field in that form, Maximum Backups to Keep.
  const loadedMaxBackupsRef = useRef<number | null>(null)
  const [backupMaxCount, setBackupMaxCount] = useState(10)
  // And the third: whether each backup carries a copy of the panel database
  // (backupIncludeDb; backupService.createBackup() adds a redacted db.json).
  // Up to v1.4.17 the Dashboard's and Diagnostics' backups always included
  // it; now this setting alone decides, and it starts off on an upgrade.
  const loadedIncludeDbRef = useRef<boolean | null>(null)
  const [backupIncludeDb, setBackupIncludeDb] = useState(false)
  // And whether the schedule skips a server that is stopped
  // (backupOnlyWhenOnline; the scheduler checks before each server).
  const loadedOnlyWhenOnlineRef = useRef<boolean | null>(null)
  const [backupOnlyWhenOnline, setBackupOnlyWhenOnline] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)

  // Dialog state
  const [restoreDialog, setRestoreDialog] = useState<{ open: boolean; backupName: string | null }>({
    open: false,
    backupName: null,
  })
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; names: string[] }>({
    open: false,
    names: [],
  })
  const [deleteOlderDialog, setDeleteOlderDialog] = useState(false)
  const [deleteOlderDays, setDeleteOlderDays] = useState(7)
  const [deletingOlder, setDeletingOlder] = useState(false)
  const [snapshotDialog, setSnapshotDialog] = useState<{ name: string; snapshot: BackupSnapshot } | null>(null)

  // Fetch functions
  const fetchBackups = useCallback(async () => {
    try {
      const data = await backupApi.listBackups()
      // An answer without a list (the demo build's catch-all reply, a proxy
      // page) reads as no backups, not as a crash further down.
      const list = Array.isArray(data?.backups) ? data.backups : []
      setBackups(list)
      setLoadError(null)
      // Clear selection for backups that no longer exist
      setSelectedBackups(prev => {
        const backupNames = new Set(list.map(b => b.name))
        const newSelection = new Set<string>()
        prev.forEach(name => {
          if (backupNames.has(name)) {
            newSelection.add(name)
          }
        })
        return newSelection
      })
    } catch (error) {
      setLoadError(getUserErrorMessage(error, t('toasts.loadBackupsFailed')))
    } finally {
      setBackupsLoaded(true)
    }
  }, [t])

  const fetchBackupStatus = useCallback(async () => {
    const seq = ++statusReadSeqRef.current
    try {
      const status = await backupApi.getStatus()
      if (seq < appliedStatusReadSeqRef.current) return
      appliedStatusReadSeqRef.current = seq
      setBackupStatus(status)
      const schedule = savedScheduleOf(status)
      if (loadedScheduleRef.current !== schedule) {
        loadedScheduleRef.current = schedule
        setBackupSchedule(schedule)
        const isPreset = PRESET_CRONS.has(schedule)
        setCustomSchedule(schedule !== '' && !isPreset)
        setCustomCron(isPreset ? '' : schedule)
      }
      if (loadedMaxBackupsRef.current !== status.maxBackups) {
        loadedMaxBackupsRef.current = status.maxBackups
        setBackupMaxCount(status.maxBackups)
      }
      const includeDb = status.includeDb === true
      if (loadedIncludeDbRef.current !== includeDb) {
        loadedIncludeDbRef.current = includeDb
        setBackupIncludeDb(includeDb)
      }
      const onlyWhenOnline = status.onlyWhenOnline === true
      if (loadedOnlyWhenOnlineRef.current !== onlyWhenOnline) {
        loadedOnlyWhenOnlineRef.current = onlyWhenOnline
        setBackupOnlyWhenOnline(onlyWhenOnline)
      }
      setLoadError(null)
      setBackupStatusLoadError(false)
      // The server's own backupInProgress mutex (backupService.js) is the
      // one source of truth for whether a backup is actually running --
      // including one this browser session didn't start (the scheduler, a
      // second tab, or a backup already underway before this page loaded).
      // creatingBackup was local-only and defaulted to false on every
      // mount, so a page load or reload mid-backup showed no progress card
      // and left Create Backup clickable, inviting a second backup into the
      // server's own reject-on-conflict guard with no explanation on
      // screen.
      if (status.backupInProgress) {
        setCreatingBackup(true)
      } else if (seq > backupProgressAtReadRef.current) {
        // GH#166: the backup card ends on its own 'complete'/'error' event
        // -- and a socket that reconnected meanwhile never gets it: the
        // card for a restore's safety backup then spun on at "Archiving
        // files…" after the restore itself had finished. A read sent after
        // the card last changed that finds no backup running outranks it.
        // Sent after, because one sent before a backup started can land
        // after that backup's first event (reads are applied in the order
        // they were sent -- see statusReadSeqRef -- so an older one never
        // undoes a newer one's "running"). A finished/failed card clears
        // itself. This page's own backup turns creatingBackup off in its
        // own `finally`, so that's left to it.
        setBackupProgress((prev) => (isBackupProgressFinal(prev) ? prev : null))
        if (!ownBackupInFlightRef.current) setCreatingBackup(false)
      }
      // GH#166: a restore this page didn't start -- another tab's, or one
      // already running when the page loaded (this page's own too, after a
      // navigation away and back) -- is followed through the status alone:
      // its card spins while the status says it runs, and turns into its
      // outcome once the status says it ended. This page's own restore ends
      // through its own handler instead, so it's left alone here.
      if (!ownRestoreInFlightRef.current) {
        const running = status.restoreInProgress ? (status.currentRestore ?? null) : null
        if (status.restoreInProgress) {
          const id = running?.id ?? null
          // This page's own restore, still running in a read sent after its
          // request settled: the answer that request got was wrong (an
          // error page in front of the panel that looked like the panel's
          // own), or there was none (the panel unreachable too long, the
          // card at "couldn't confirm"), so it's followed like any other
          // restore instead of leaving "Restore failed" or "couldn't
          // confirm" over a world still being replaced.
          if (id !== null && id === ownRestoreIdRef.current && seq > ownRestoreSettledAtReadRef.current) {
            ownRestoreIdRef.current = null
            setOwnRestoreId(null)
          }
          if ((id === null || id !== ownRestoreIdRef.current) && watchedRestoreRef.current?.id !== id) {
            watchedRestoreRef.current = { id, backupName: running?.backupName ?? null }
            // The card now follows this restore -- this page's own
            // "couldn't confirm" one among them, still running after all.
            unknownRestoreIdRef.current = null
            setRestoreResult(null)
          }
        } else if (watchedRestoreRef.current) {
          const watched = watchedRestoreRef.current
          watchedRestoreRef.current = null
          const last = status.lastRestore ?? null
          const outcome = last && (watched.id === null || last.id === watched.id) ? last : null
          setRestoreResult(restoreResultFrom(outcome, watched.backupName))
          // Its safety backup is new in the list.
          void fetchBackups()
        } else if (unknownRestoreIdRef.current !== null && status.lastRestore?.id === unknownRestoreIdRef.current) {
          // This page's own restore ended "couldn't confirm" because the
          // panel stayed unreachable (a long network drop, a laptop asleep)
          // -- and the panel, reachable again (a socket reconnect reads the
          // status), has recorded how it ended after all: that's the answer.
          const outcome = status.lastRestore
          unknownRestoreIdRef.current = null
          setRestoreResult((prev) => (
            prev?.status === 'unknown' && prev.requestId === outcome.id
              ? restoreResultFrom(outcome, prev.backupName)
              : prev
          ))
          void fetchBackups()
        }
      }
    } catch (error) {
      if (seq < appliedStatusReadSeqRef.current) return
      appliedStatusReadSeqRef.current = seq
      setLoadError(getUserErrorMessage(error, t('toasts.loadStatusFailed')))
      setBackupStatusLoadError(true)
    }
  }, [t, fetchBackups])

  const fetchHistory = useCallback(async (serverId: string | number | null) => {
    if (serverId == null) {
      setHistory([])
      return
    }
    try {
      const data = await backupApi.getHistory(serverId)
      setHistory(Array.isArray(data?.records) ? data.records : [])
    } catch {
      setHistory([])
    }
  }, [])

  const refreshAll = useCallback(async () => {
    setLoading(true)
    try {
      const active = await serversApi.getResolvedActive().catch(() => ({ server: null }))
      setActiveServerRemote(!!active.server?.isRemote)
      setActiveServerId(active.server?.id ?? null)
      await Promise.all([
        fetchBackupStatus(),
        fetchBackups(),
        fetchHistory(active.server?.id ?? null),
      ])
    } finally {
      setLoading(false)
    }
  }, [fetchBackupStatus, fetchBackups, fetchHistory])

  // Initial load
  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  // Socket.IO for progress updates
  useEffect(() => {
    if (!socket) return

    const handleBackupProgress = (data: BackupProgress) => {
      backupProgressAtReadRef.current = statusReadSeqRef.current
      setBackupProgress(data)

      // Clear any existing timeout
      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current)
        progressTimeoutRef.current = null
      }
      
      if (data.phase === 'complete') {
        setCreatingBackup(false)
        fetchBackups()
        fetchBackupStatus()
        progressTimeoutRef.current = setTimeout(() => setBackupProgress(null), 2000)
      } else if (data.phase === 'error') {
        setCreatingBackup(false)
        // Only a MANUAL backup reports here: scheduled runs, held-for-a-
        // restart ones included, call createBackup() without `io` and emit
        // no backup:progress at all -- 'backup:deferred' below and the
        // 15 s re-check while one waits keep the Auto-Backup card current
        // for those. A failed manual run still changes the status (its
        // backupInProgress flag, which the page reads back for a run
        // started in another tab), so re-read it like 'complete' does.
        fetchBackupStatus()
        progressTimeoutRef.current = setTimeout(() => setBackupProgress(null), 3000)
      }
    }

    // A scheduled backup starting to wait on a restart, or that wait ending
    // (scheduler.js _emitBackupDeferralChanged()) -- a change to
    // backupDeferredSince that no progress event announces.
    const handleBackupDeferred = () => { void fetchBackupStatus() }

    // GH#166: a restore starting, moving on, or ending anywhere
    // (restore:progress, restore:finished) means "read the status again"
    // (see fetchBackupStatus for what it does with a restore). Not for this
    // page's own restore, which ends through its own request.
    const handleRestoreChanged = () => {
      if (!ownRestoreInFlightRef.current) void fetchBackupStatus()
    }
    // A reconnect always does: events sent while the socket was down are
    // gone for good -- a restore's end, a backup's 'complete' -- this
    // page's own restore running or not. It also has to join the backups
    // room again: backup/restore progress goes only to sockets in it (a
    // role without a backup capability is refused, server/index.js).
    const subscribeBackups = () => socket.emit('subscribe:backups')
    const handleReconnect = () => {
      subscribeBackups()
      void fetchBackupStatus()
    }
    if (socket.connected) subscribeBackups()

    socket.on('backup:progress', handleBackupProgress)
    socket.on('backup:deferred', handleBackupDeferred)
    socket.on('restore:progress', handleRestoreChanged)
    socket.on('restore:finished', handleRestoreChanged)
    socket.on('connect', handleReconnect)

    return () => {
      socket.off('backup:progress', handleBackupProgress)
      socket.off('backup:deferred', handleBackupDeferred)
      socket.off('restore:progress', handleRestoreChanged)
      socket.off('restore:finished', handleRestoreChanged)
      socket.off('connect', handleReconnect)
      // Clear timeout on unmount
      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current)
      }
    }
  }, [socket, fetchBackups, fetchBackupStatus])

  // Watchdog for the externally-started-backup case ownBackupInFlightRef
  // documents above: independently re-checks the server's actual
  // backupInProgress state rather than trusting the socket event to
  // eventually arrive. Never runs while THIS session's own
  // handleCreateBackup is in flight -- that path already self-corrects via
  // its own finally regardless of this effect.
  useEffect(() => {
    if (!creatingBackup || ownBackupInFlightRef.current) return
    const interval = setInterval(async () => {
      if (ownBackupInFlightRef.current) return
      try {
        const status = await backupApi.getStatus()
        if (!status.backupInProgress) {
          setCreatingBackup(false)
          setBackupProgress(null)
          fetchBackups()
        }
      } catch {
        // Transient -- next tick tries again.
      }
    }, 10000)
    return () => clearInterval(interval)
  }, [creatingBackup, fetchBackups])

  // A scheduled backup held for a restart (backupDeferredSince) announces
  // each change on 'backup:deferred' (above) -- but a socket that dropped
  // and reconnected meanwhile misses it, and a restart that hangs is exactly
  // when the operator is watching this page. So while the card says
  // "waiting", it also re-checks on its own, and can't keep saying so after
  // the wait is over.
  const backupDeferred = Boolean(backupStatus?.enabled && backupStatus.backupDeferredSince)
  useEffect(() => {
    if (!backupDeferred) return
    const interval = setInterval(() => { void fetchBackupStatus() }, 15000)
    return () => clearInterval(interval)
  }, [backupDeferred, fetchBackupStatus])

  // A restore this session didn't start (another tab, or already running
  // when this page loaded) must still block new create/upload/restore
  // actions the same way a locally-tracked one does -- the server's mutex
  // (backupService.js) rejects a second restore or a backup during one
  // either way, so leaving these enabled just moves the failure from
  // "greyed out with a reason" to "clicked, then an error". The status's
  // currentRestore names it (an older server's doesn't, hence the unnamed
  // card title). GH#166: a status read while this page's own restore ran
  // still names that restore until the next read lands -- not one running
  // elsewhere.
  const runningRestore = backupStatus?.restoreInProgress ? (backupStatus.currentRestore ?? null) : null
  const restoreInProgressElsewhere =
    restoringBackup === null &&
    Boolean(backupStatus?.restoreInProgress) &&
    (runningRestore === null || runningRestore.id !== ownRestoreId)

  // GH#166: restore:progress/restore:finished say when a restore running
  // elsewhere moves on; this re-check is for a socket that missed them (or
  // isn't connected) -- without it, that card could only ever end on a
  // reload.
  useEffect(() => {
    if (!restoreInProgressElsewhere) return
    const interval = setInterval(() => { void fetchBackupStatus() }, RESTORE_STATUS_POLL_MS)
    return () => clearInterval(interval)
  }, [restoreInProgressElsewhere, fetchBackupStatus])

  // The same re-check for this page's own "couldn't confirm" restore while
  // the panel still can't be reached: the socket's reconnect read is no
  // promise here -- socket.io gives up after 10 attempts (see App.tsx),
  // well before the 10 minutes it takes to get here, and only retries once
  // the tab is shown again or the network comes back. The
  // first read that gets through says it all (see fetchBackupStatus): the
  // restore running still, how it ended, or -- no record of it, the panel
  // restarted -- nothing more to wait for.
  const unknownOwnRestoreUnreachable =
    restoreResult?.status === 'unknown' && restoreResult.requestId !== null && backupStatusLoadError
  useEffect(() => {
    if (!unknownOwnRestoreUnreachable) return
    const interval = setInterval(() => { void fetchBackupStatus() }, RESTORE_STATUS_POLL_MS)
    return () => clearInterval(interval)
  }, [unknownOwnRestoreUnreachable, fetchBackupStatus])

  // See serverChangedSinceLoad's own comment above for why this exists.
  useEffect(() => {
    if (!socket) return
    const handleActiveServerChanged = () => {
      setServerChangedSinceLoad(true)
      // A dialog's own local state (a specific backup name/list) doesn't
      // update just because the data behind it refreshes -- close it rather
      // than let a confirm click resolve against whichever server the
      // backend considers active now, not whichever one the dialog was
      // opened against.
      setRestoreDialog({ open: false, backupName: null })
      setDeleteDialog({ open: false, names: [] })
      // pz-bughunt round 17 (every write that trusts the server-side active
      // server): deleteOlderDialog's age threshold isn't tied to a specific
      // backup name the way restoreDialog/deleteDialog are, but it's the
      // same shape -- close it too rather than let a stale confirm apply to
      // whichever server the backend now considers active.
      setDeleteOlderDialog(false)
      // A finished restore's result is about the server this page showed
      // until now.
      unknownRestoreIdRef.current = null
      setRestoreResult(null)
      refreshAll().finally(() => setServerChangedSinceLoad(false))
    }
    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, refreshAll])

  // Actions
  const handleCreateBackup = async () => {
    // Function-level guard, not just the button's `disabled` -- the button
    // is an affordance, this is the gate. 2026-08-27 bug-hunt floor rule:
    // assert the action is unreachable, don't just make the control look
    // disabled (Angela's Console.tsx Enter-key bypass finding).
    if (!canManageBackups) return
    // One backup at a time: the empty state's Create Backup has no disabled
    // state, and a double click sent a second POST /create whose refusal
    // put an error card over the first backup's live progress and ended
    // its "creating" state while it was still running.
    if (ownBackupInFlightRef.current || creatingBackup) return
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.serverChangedSinceLoadTitle'),
        description: t('toasts.serverChangedSinceLoadDesc'),
        variant: 'destructive',
      })
      return
    }
    // A PRIOR backup's 'complete'/'error' socket handler (or this
    // function's own catch block, below) may have scheduled an auto-clear
    // timeout that hasn't fired yet -- e.g. a second click within its 2-3s
    // window. Without this, that leftover timer wipes THIS backup's live
    // progress out from under it partway through, well before it's done.
    if (progressTimeoutRef.current) {
      clearTimeout(progressTimeoutRef.current)
      progressTimeoutRef.current = null
    }
    ownBackupInFlightRef.current = true
    setCreatingBackup(true)
    backupProgressAtReadRef.current = statusReadSeqRef.current
    setBackupProgress({ phase: 'preparing', percent: 0, message: t('progress.startingFallback') })
    try {
      const result = await backupApi.createBackup()
      if (result.success && result.backup) {
        toast({
          title: t('toasts.backupCreatedTitle'),
          description: t('toasts.backupCreatedDesc', { name: result.backup.name, seconds: result.duration?.toFixed(1) }),
          variant: 'success' as const,
        })
        await fetchBackups()
        await fetchBackupStatus()
      } else {
        throw new Error(result.message || t('toasts.createBackupFailedFallback'))
      }
    } catch (error) {
      toast({
        title: t('toasts.backupFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.createBackupFailedFallback')),
        variant: 'destructive',
      })
      setBackupProgress({ phase: 'error', percent: 0, message: t('toasts.backupFailedMessage') })
      // Mirror the 'backup:progress' socket handler's error-phase behavior
      // above -- without this, a failure that never gets a corresponding
      // socket event (e.g. the createBackup() call itself rejects before
      // the server ever emits progress) leaves this error card on screen
      // indefinitely instead of auto-clearing like every other transition.
      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current)
      }
      progressTimeoutRef.current = setTimeout(() => setBackupProgress(null), 3000)
    } finally {
      setCreatingBackup(false)
      ownBackupInFlightRef.current = false
    }
  }

  // downloadBackup() throws on a refused or failed download (403, a backup
  // gone from disk, another server's backup): say so instead of nothing.
  const handleDownload = async (name: string) => {
    try {
      await backupApi.downloadBackup(name)
    } catch (error) {
      toast({
        title: t('toasts.downloadFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.downloadFailedFallback')),
        variant: 'destructive',
      })
    }
  }

  // Upload an existing .zip from the user's machine into the backups folder.
  // The file gets stored with an "uploaded-" prefix and shows up in the list
  // alongside scheduled backups; the user then clicks Restore to apply it.
  const handleUploadFile = async (file: File) => {
    if (!canManageBackups) return
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.serverChangedSinceLoadTitle'),
        description: t('toasts.serverChangedSinceLoadDesc'),
        variant: 'destructive',
      })
      return
    }
    if (!file) return
    if (activeServerRemote) {
      toast({ title: t('toasts.notAvailableRemoteTitle'), description: t('toasts.notAvailableRemoteDesc'), variant: 'destructive' })
      return
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      toast({ title: t('toasts.invalidFileTitle'), description: t('toasts.invalidFileDesc'), variant: 'destructive' })
      return
    }
    // Hard cap matches the server-side express.raw limit (4 GB). Anything
    // larger would upload for minutes and then 413 — fail fast instead.
    const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024
    if (file.size > MAX_UPLOAD_BYTES) {
      toast({ title: t('toasts.fileTooLargeTitle'), description: t('toasts.fileTooLargeDesc', { size: (file.size / (1024 * 1024 * 1024)).toFixed(2) }), variant: 'destructive' })
      return
    }
    if (file.size === 0) {
      toast({ title: t('toasts.emptyFileTitle'), description: t('toasts.emptyFileDesc'), variant: 'destructive' })
      return
    }
    setUploadingBackup(true)
    setUploadPercent(0)
    try {
      const result = await backupApi.uploadBackup(file, setUploadPercent)
      toast({
        title: t('toasts.uploadedTitle'),
        description: t('toasts.uploadedDesc', { name: result.name }),
        variant: 'success' as const,
      })
      await fetchBackups()
      await fetchBackupStatus()
    } catch (error) {
      toast({
        title: t('toasts.uploadFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.uploadFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setUploadingBackup(false)
      setUploadPercent(0)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // Fetches the CURRENT active server name at the moment the dialog opens
  // (not from mount-time state) so the confirmation can name the real
  // target -- see restoreTargetServerName's own comment above.
  const openRestoreDialog = (name: string) => {
    setRestoreDialog({ open: true, backupName: name })
    setRestoreTargetServerName(null)
    serversApi.getResolvedActive()
      .then((d) => setRestoreTargetServerName(d.server?.name || d.server?.serverName || null))
      .catch(() => setRestoreTargetServerName(null))
  }

  const handleRestoreBackup = async (name: string) => {
    if (!canRestoreBackups) return
    // Both disable the Restore button; the function is the gate. The server
    // refuses a second restore anyway, just later and as an error -- the
    // Restore card already on the page says why nothing happens.
    if (restoringBackup !== null || restoreInProgressElsewhere) {
      setRestoreDialog({ open: false, backupName: null })
      return
    }
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.serverChangedSinceLoadTitle'),
        description: t('toasts.serverChangedSinceLoadDesc'),
        variant: 'destructive',
      })
      return
    }
    setRestoreDialog({ open: false, backupName: null })
    const requestId = newRestoreRequestId()
    ownRestoreInFlightRef.current = true
    ownRestoreIdRef.current = requestId
    watchedRestoreRef.current = null
    unknownRestoreIdRef.current = null
    setOwnRestoreId(requestId)
    setRestoreResult(null)
    setRestoreResponseLost(false)
    setRestoringBackup(name)
    let result: RestoreResult
    try {
      // Resolves with the real outcome even when the POST's own answer is
      // lost (see restoreBackupAndConfirm()); a failed or refused restore
      // lands in the catch below, never as success: false here.
      const { duration } = await restoreBackupAndConfirm(name, requestId, {
        onResponseLost: () => setRestoreResponseLost(true),
      })
      result = { status: 'success', backupName: name, seconds: duration, safetyBackup: true }
      // The card's own words, so the toast and the card agree.
      toast({
        title: t('restoreResult.successTitle'),
        description: t('toasts.restoredDesc', { name, seconds: (duration || 0).toFixed(1) }),
        variant: 'success' as const,
      })
    } catch (error) {
      if (error instanceof RestoreOutcomeUnknownError) {
        result = { status: 'unknown', backupName: name, requestId }
        // Unknown includes "the panel was unreachable too long". The status
        // this page last read is then likely the one its safety backup's
        // 'complete' took mid-restore, naming this very restore as running
        // -- and a failed read never replaces it. So this restore stays
        // this page's own (ownRestoreId): dropping it would turn that stale
        // read into "a restore is in progress elsewhere", hiding this card
        // behind a spinner for as long as the panel can't be reached. Once
        // it can, a read that still shows this restore running hands it to
        // the watcher (see fetchBackupStatus), and one that shows how it
        // ended replaces this card with that.
        unknownRestoreIdRef.current = requestId
        toast({
          title: t('restoreResult.unknownTitle'),
          description: t('restoreResult.unknownDetail'),
          variant: 'warning',
        })
      } else {
        const reason = error instanceof RestoreNotStartedError
          ? t('restoreResult.notStartedProxy', { status: error.status })
          : getUserErrorMessage(error, t('toasts.restoreFailedFallback'))
        result = { status: 'failed', backupName: name, reason }
        toast({
          title: t('restoreResult.failedTitle'),
          description: reason,
          variant: 'destructive',
        })
      }
    }
    ownRestoreInFlightRef.current = false
    ownRestoreSettledAtReadRef.current = statusReadSeqRef.current
    setRestoringBackup(null)
    setRestoreResponseLost(false)
    setRestoreResult(result)
    // GH#166: the status this page last read is likely from mid-restore
    // (see restoreResult's comment above) -- read it again, or Create,
    // Upload and Restore stay blocked by a restore that's over. The same
    // read clears a safety-backup card whose 'complete' this socket missed,
    // and follows the restore on if it's somehow still running.
    void fetchBackupStatus()
    await fetchBackups()
  }

  const handleViewSnapshot = async (name: string) => {
    if (!canManageBackups) return
    try {
      const result = await backupApi.getSnapshot(name)
      if (!result.success || !result.snapshot) throw new Error(result.message || t('toasts.snapshotMissingFallback'))
      setSnapshotDialog({ name, snapshot: result.snapshot })
    } catch (error) {
      toast({
        title: t('toasts.snapshotUnavailableTitle'),
        description: getUserErrorMessage(error, t('toasts.snapshotUnavailableFallback')),
        variant: 'destructive',
      })
    }
  }

  const handleDeleteBackups = async (names: string[]) => {
    if (!canManageBackups) return
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.serverChangedSinceLoadTitle'),
        description: t('toasts.serverChangedSinceLoadDesc'),
        variant: 'destructive',
      })
      return
    }
    setDeleteDialog({ open: false, names: [] })
    setDeletingBackups(true)
    try {
      let successCount = 0
      let failCount = 0
      for (const name of names) {
        try {
          // DELETE /backup/:name always responds non-2xx on failure, so
          // handleResponse() throws -- result.success is always true here.
          await backupApi.deleteBackup(name)
          successCount++
        } catch {
          failCount++
        }
      }

      if (successCount > 0) {
        toast({
          title: t('toasts.oldSnapshotsClearedTitle'),
          description: t('toasts.oldSnapshotsClearedDesc', { count: successCount })
            + (failCount > 0 ? t('toasts.oldSnapshotsClearedFailSuffix', { count: failCount }) : ''),
          variant: 'success' as const,
        })
      }
      if (failCount > 0 && successCount === 0) {
        toast({
          title: t('toasts.deleteFailedTitle'),
          description: t('toasts.deleteFailedCount', { count: failCount }),
          variant: 'destructive',
        })
      }

      setSelectedBackups(new Set())
      await fetchBackups()
    } catch (error) {
      toast({
        title: t('toasts.deleteFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.deleteFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setDeletingBackups(false)
    }
  }

  const handleDeleteOlderThan = async () => {
    if (!canManageBackups) return
    // pz-bughunt round 17 (every write that trusts the server-side active
    // server): backupApi.deleteOlderThan() resolves "the active server"
    // server-side with no server id, same shape as handleCreateBackup/
    // handleRestoreBackup/handleDeleteBackups above -- this one was missed.
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.serverChangedSinceLoadTitle'),
        description: t('toasts.serverChangedSinceLoadDesc'),
        variant: 'destructive',
      })
      return
    }
    setDeleteOlderDialog(false)
    setDeletingOlder(true)
    try {
      // POST /backup/delete-older-than relays backupService's result as-is
      // over HTTP 200, and that service CAN return { success: false, ... }
      // on a partial failure -- but handleResponse() throws on any 200
      // body with success: false (see lib/api.ts), so that case lands in
      // the catch below too, never in a result.success === false branch
      // here. Confirmed no other codepath in this handler returns
      // success: false with a 2xx status.
      // pz-bughunt round 18: expectedServerId is defense in depth alongside
      // the serverChangedSinceLoad guard above -- see server/routes/
      // backup.js's POST /delete-older-than for the server-side check this
      // enables (409 BACKUP_ACTIVE_SERVER_CHANGED on a real mismatch).
      const result = await backupApi.deleteOlderThan(deleteOlderDays, activeServerId)
      toast({
        title: t('toasts.oldBackupsRemovedTitle'),
        description: result.message || t('toasts.oldBackupsRemovedFallback', { count: result.deleted || 0 }),
        variant: 'success' as const,
      })
      await fetchBackups()
    } catch (error) {
      toast({
        title: t('toasts.deleteFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.deleteOldFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setDeletingOlder(false)
    }
  }

  // What Save stores: the typed expression in Custom mode, else the preset.
  const scheduleToSave = customSchedule ? customCron.trim() : backupSchedule
  // Live preview of the schedule being edited (POST /backup/validate-schedule):
  // validity for a custom expression, next run, and the scheduled restarts it
  // would land inside -- through the same hook as Settings > Backups'
  // Schedule field, so the two editors can't disagree. The newest verdict
  // stays on screen while the check for a newer edit is pending (dimmed and
  // aria-busy) instead of the whole preview collapsing on every keystroke
  // and moving the Save button with it. Only while the settings panel is
  // open, the only place it shows; never for a role without backups.manage
  // (the endpoint's own gate) -- the panel shows the saved schedule's
  // overlaps instead (below).
  const { check: shownScheduleCheck, pending: scheduleCheckPending } =
    useBackupScheduleCheck(scheduleToSave, showSettings && canManageBackups)
  // Until the panel has a verdict of its own -- the first check after it
  // opens, or never, for a role that can't run it -- the saved schedule's
  // overlaps from GET /status stand in, so opening the panel doesn't drop
  // the warning the page was already showing and bring it back a round
  // trip later. None while scheduled backups are off: no scheduled backup
  // runs to land inside anything (GET /status sends none then either), and
  // "every scheduled backup lands inside..." under an Auto-Backup card that
  // says "Off" would be false.
  const panelRestartOverlaps = !backupStatus?.enabled
    ? undefined
    : shownScheduleCheck
      ? shownScheduleCheck.valid ? shownScheduleCheck.restartOverlaps : undefined
      : scheduleToSave === backupStatus.schedule ? backupStatus.restartOverlaps : undefined

  const handleFrequencyChange = (value: string) => {
    if (value === CUSTOM_SCHEDULE_VALUE) {
      setCustomSchedule(true)
      // Start from whatever was selected: turning "0 */4 * * *" into
      // "30 */4 * * *" beats typing an expression from nothing.
      setCustomCron((previous) => previous || backupSchedule)
      return
    }
    setCustomSchedule(false)
    setBackupSchedule(value)
  }

  const handleSaveSettings = async () => {
    if (!canManageBackups || savingSettings) return
    // pz-bughunt round 17: backupApi.updateSettings() resolves "the active
    // server" server-side with no server id -- schedule/maxBackups shown
    // here were loaded for whichever server was active at that time.
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.serverChangedSinceLoadTitle'),
        description: t('toasts.serverChangedSinceLoadDesc'),
        variant: 'destructive',
      })
      return
    }
    // Busy from here, before the first await: the custom-schedule pre-check
    // below is a round trip of its own, and a Save button left enabled
    // during it lets a double click send two POST /backup/settings.
    setSavingSettings(true)
    try {
      // A custom expression is checked against the server's own validator
      // first, the same pre-check Scheduler.tsx runs before saving a task,
      // so a typo gets its specific reason ("more often than every 5
      // minutes") instead of a generic failed save. Unreachable pre-check:
      // fall through and let POST /settings -- which applies the identical
      // rules -- decide.
      if (customSchedule) {
        const rejected = await precheckBackupSchedule(scheduleToSave)
        if (rejected) {
          toast({
            title: t('toasts.planUpdateFailedTitle'),
            description: backupScheduleErrorText(rejected, t('settingsPanel.customInvalid')),
            variant: 'destructive',
          })
          return
        }
      }
      // pz-bughunt round 18: expectedServerId is defense in depth alongside
      // the serverChangedSinceLoad guard above -- see server/routes/
      // backup.js's POST /settings for the server-side check this enables.
      await backupApi.updateSettings({
        enabled: backupStatus?.enabled || false,
        schedule: scheduleToSave,
        maxBackups: backupMaxCount,
        includeDb: backupIncludeDb,
        onlyWhenOnline: backupOnlyWhenOnline,
      }, activeServerId)
      await fetchBackupStatus()
      toast({
        title: t('toasts.planUpdatedTitle'),
        description: t('toasts.planUpdatedDesc'),
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('toasts.planUpdateFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.planUpdateFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setSavingSettings(false)
    }
  }

  const toggleBackupEnabled = async (enabled: boolean) => {
    if (!canManageBackups) return
    // pz-bughunt round 17: same shape as handleSaveSettings above -- this
    // toggle also calls backupApi.updateSettings() against "the active
    // server" with no server id sent.
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.serverChangedSinceLoadTitle'),
        description: t('toasts.serverChangedSinceLoadDesc'),
        variant: 'destructive',
      })
      return
    }
    try {
      // pz-bughunt round 18: same defense-in-depth expectedServerId as
      // handleSaveSettings above.
      await backupApi.updateSettings({ enabled }, activeServerId)
      await fetchBackupStatus()
      toast({
        title: enabled ? t('toasts.autoArmedTitle') : t('toasts.autoStoodDownTitle'),
        description: enabled ? t('toasts.autoArmedDesc') : t('toasts.autoStoodDownDesc'),
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('toasts.autoUpdateFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.autoUpdateFailedFallback')),
        variant: 'destructive',
      })
    }
  }

  // Selection handlers
  const toggleBackupSelection = (name: string) => {
    setSelectedBackups(prev => {
      const newSet = new Set(prev)
      if (newSet.has(name)) {
        newSet.delete(name)
      } else {
        newSet.add(name)
      }
      return newSet
    })
  }

  const toggleSelectAll = () => {
    if (selectedBackups.size === backups.length) {
      setSelectedBackups(new Set())
    } else {
      setSelectedBackups(new Set(backups.map(b => b.name)))
    }
  }

  // Helpers
  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  }

  const formatDate = (dateStr: string): string => formatDateTime(dateStr)

  // "Auto-Backup: On" alone can't tell an operator the scheduler is actually
  // succeeding -- lastBackup only updates on a SUCCESSFUL run, so a run of
  // failures (bad cron, unreachable backupsPath, disk full) leaves this
  // card looking identical to a healthy one. Surface the newest scheduled
  // attempt specifically when it failed -- unless a backup has succeeded
  // since, or it was only skipped for a restart (worded as that, not as a
  // failure); see scheduledBackupHealth(), which the Dashboard shares.
  const scheduledHealth = scheduledBackupHealth(backupStatus?.enabled, backupStatus?.lastScheduledBackupAttempt)
  const lastScheduledAttemptFailed = scheduledHealth === 'failing'
  const lastScheduledSkippedForRestart = scheduledHealth === 'skippedForRestart'
  const backupDeferredSince = backupStatus?.enabled ? backupStatus.backupDeferredSince ?? null : null
  // The two restart lines on the Auto-Backup card. Their point is the tail
  // ("waiting for the restart", "skipped for a restart"), which a one-line
  // truncate in that narrow card (the lg four-column grid, or beside the
  // switch on a phone) cuts off first -- so they wrap to two lines, and
  // carry the full text as a title like the failed-attempt line does.
  const deferredForRestartLine = backupDeferredSince
    ? t('statusCards.deferredForRestart', { time: formatDate(backupDeferredSince) })
    : null
  const skippedForRestartLine = lastScheduledSkippedForRestart && backupStatus?.lastScheduledBackupAttempt
    ? t('statusCards.lastScheduledSkippedForRestart', { time: formatDate(backupStatus.lastScheduledBackupAttempt.executedAt) })
    : null
  // The failed attempt's reason: translated where the panel wrote it (a
  // restart that looked stuck), a raw error as is.
  const lastScheduledAttemptMessage = scheduledAttemptMessage(
    backupStatus?.lastScheduledBackupAttempt?.message,
    backupStatus?.lastScheduledBackupAttempt?.messageKey,
    backupStatus?.lastScheduledBackupAttempt?.messageParams,
  ) ?? ''
  // bug-hunt-2026-09-08 (honest-unknown class): backupStatus is null both
  // before the first fetch resolves and after a confirmed failure -- only
  // the latter gets this treatment (matching Settings.tsx's own scheduled-
  // backups toggle), so a fast, uneventful mount still shows the plain
  // "on schedule" copy rather than flashing "couldn't check" for a moment.
  const statusUnknown = !backupStatus && backupStatusLoadError
  const savedSchedule = backupStatus ? savedScheduleOf(backupStatus) : ''

  // Translate the cron presets we expose into a human label. Anything else
  // is a custom expression, shown as one ("on a custom schedule (…)") rather
  // than a bare cron string that reads like a glitch in the sentence around
  // it -- no full cron-to-prose parser; the settings panel's next-run line
  // is where a custom schedule gets spelled out.
  const describeSchedule = (cron: string | undefined): string => {
    if (!cron) return t('schedule.none')
    const preset = SCHEDULE_PRESETS.find(([presetCron]) => presetCron === cron)
    // Isolated in Arabic: a bare cron in an RTL sentence reads reversed.
    return preset ? t(preset[1]) : t('schedule.custom', { cron: isolateLtrForRtl(cron) })
  }

  const totalSize = useMemo(() => {
    return backups.reduce((sum, b) => sum + b.size, 0)
  }, [backups])

  const isAnySelected = selectedBackups.size > 0
  const allSelected = backups.length > 0 && selectedBackups.size === backups.length

  // Unsaved edits in "Schedule & retention": the form against the schedule,
  // limit and panel-database choice GET /status last sent. The on/off
  // switch saves the moment it's flipped. A role that can't save has its
  // fields locked, so it never holds edits it couldn't keep.
  const scheduleChanged = backupStatus !== null && scheduleToSave !== savedSchedule
  // Object.is: an emptied field is NaN, and NaN !== NaN.
  const maxBackupsChanged = backupStatus !== null && !Object.is(backupMaxCount, backupStatus.maxBackups)
  const includeDbChanged = backupStatus !== null && backupIncludeDb !== (backupStatus.includeDb === true)
  const onlyWhenOnlineChanged = backupStatus !== null && backupOnlyWhenOnline !== (backupStatus.onlyWhenOnline === true)
  const settingsDirty = canManageBackups && (scheduleChanged || maxBackupsChanged || includeDbChanged || onlyWhenOnlineChanged)
  const maxBackupsInvalid = maxBackupsChanged
    && !(Number.isInteger(backupMaxCount) && backupMaxCount >= 1 && backupMaxCount <= 100)
  const saveSettingsBlockedReason = !canManageBackups
    ? t('permissions.noManage')
    : serverChangedSinceLoad
      ? t('toasts.serverChangedSinceLoadDesc')
      : maxBackupsInvalid
        ? t('settingsPanel.maxBackupsInvalid')
        : undefined

  // Discard: the form back to what is saved.
  const discardSettings = () => {
    if (!backupStatus) return
    const schedule = savedScheduleOf(backupStatus)
    const isPreset = PRESET_CRONS.has(schedule)
    setBackupSchedule(schedule)
    setCustomSchedule(schedule !== '' && !isPreset)
    setCustomCron(isPreset ? '' : schedule)
    setBackupMaxCount(backupStatus.maxBackups)
    setBackupIncludeDb(backupStatus.includeDb === true)
    setBackupOnlyWhenOnline(backupStatus.onlyWhenOnline === true)
  }

  // Opening the card (the header button, the Auto-backup cell, or a link
  // with ?panel=schedule) brings it into view -- for a link, once the
  // summary above it has loaded and stopped moving it down.
  const scrolledToScheduleRef = useRef(false)
  useEffect(() => {
    if (!showSettings) {
      scrolledToScheduleRef.current = false
      return
    }
    if (scrolledToScheduleRef.current || !backupsLoaded) return
    scrolledToScheduleRef.current = true
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById(SCHEDULE_CARD_ID)?.scrollIntoView?.({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' })
  }, [showSettings, backupsLoaded])

  const createBlockedReason = !canManageBackups
    ? t('permissions.noManage')
    : activeServerRemote
      ? t('pageHeader.remoteDisabledTitle')
      : restoreInProgressElsewhere
        ? t('permissions.restoreInProgress')
        : null
  const uploadBlockedReason = !canManageBackups
    ? t('permissions.noManage')
    : activeServerRemote
      ? t('pageHeader.uploadTitleRemote')
      : restoreInProgressElsewhere
        ? t('permissions.restoreInProgress')
        : serverChangedSinceLoad
          ? t('toasts.serverChangedSinceLoadDesc')
          : undefined
  const uploadDisabled = uploadingBackup || restoringBackup !== null || restoreInProgressElsewhere || activeServerRemote || !canManageBackups || serverChangedSinceLoad

  const pageAlerts: PageAlert[] = []
  if (loadError) {
    pageAlerts.push({
      id: 'load-error',
      tone: 'error',
      title: t('alerts.loadErrorTitle'),
      description: loadError,
      action: { label: t('alerts.retry'), onClick: () => { void refreshAll() } },
    })
  }
  if (activeServerRemote) {
    pageAlerts.push({
      id: 'remote',
      tone: 'warning',
      title: t('alerts.remoteTitle'),
      description: t('alerts.remoteDesc'),
      action: { label: t('alerts.remoteAction'), to: '/servers' },
    })
  }

  // The Auto-backup cell's second line: why it's in the state it's in.
  const autoBackupDetail = statusUnknown ? (
    <span className="block truncate">{t('backups.statusLoadFailed', { ns: 'settings' })}</span>
  ) : deferredForRestartLine ? (
    // Checked first: whatever the last attempt said, a backup is due right
    // now and only waiting for a restart to end. Two lines: the point is
    // the tail ("waiting for the restart"), which a one-line truncate cuts.
    <span className="block whitespace-normal line-clamp-2" title={deferredForRestartLine}>{deferredForRestartLine}</span>
  ) : skippedForRestartLine ? (
    <span className="block whitespace-normal text-warning line-clamp-2" title={skippedForRestartLine}>{skippedForRestartLine}</span>
  ) : lastScheduledAttemptFailed ? (
    <span className="block truncate text-warning" title={lastScheduledAttemptMessage}>
      {t('statusCards.lastScheduledAttemptFailed', {
        time: formatDate(backupStatus!.lastScheduledBackupAttempt!.executedAt),
        message: lastScheduledAttemptMessage,
      })}
    </span>
  ) : (
    <span className="block truncate" title={savedSchedule}>
      {backupStatus?.enabled
        ? t('statusCards.runsSchedule', { schedule: describeSchedule(savedSchedule), count: backupStatus?.maxBackups ?? '?' })
        : t('statusCards.noScheduled')}
    </span>
  )
  const autoBackupNeedsAttention = lastScheduledAttemptFailed || lastScheduledSkippedForRestart

  const summary: StatStripItem[] = [
    { id: 'count', label: t('statusCards.totalBackups'), value: backups.length, icon: Archive },
    { id: 'size', label: t('statusCards.totalSize'), value: formatBytes(totalSize), icon: HardDrive },
    {
      id: 'last',
      label: t('statusCards.lastBackup'),
      value: (
        <span className="block truncate text-base">
          {backupStatus?.lastBackup ? formatDate(backupStatus.lastBackup.created) : t('statusCards.never')}
        </span>
      ),
      icon: Clock,
    },
    {
      id: 'auto',
      label: t('statusCards.autoBackup'),
      // A bare "-" until the status is known -- not On or Off, since we
      // don't know which (the same placeholder Diagnostics uses).
      value: statusUnknown ? '-' : backupStatus?.enabled ? t('statusCards.on') : t('statusCards.off'),
      detail: autoBackupDetail,
      icon: autoBackupNeedsAttention ? AlertTriangle : CalendarClock,
      tone: autoBackupNeedsAttention ? 'warning' : backupStatus?.enabled ? 'success' : 'default',
      // Opens "Schedule & retention", where the switch is.
      onClick: () => openSchedule(),
    },
  ]

  function openSchedule() {
    if (showSettings) document.getElementById(SCHEDULE_CARD_ID)?.scrollIntoView?.({ block: 'nearest' })
    else setShowSettings(true)
  }

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
        status={uploadingBackup ? (
          <StatusPill tone="busy" size="sm" label={t('pageHeader.uploading', { percent: uploadPercent })} />
        ) : deletingOlder ? (
          // "Delete older…" runs from the More menu, which is closed by then.
          <StatusPill tone="busy" size="sm" label={t('pageHeader.deletingOlder')} />
        ) : undefined}
        meta={activeServerId != null && history.length > 0 ? (
          <>
            <span className="font-medium text-foreground">{t('history.label')}</span>
            <span>{t('history.recordedCount', { count: history.length })}</span>
            <span>{t('history.latest', { date: formatDate(history[0].createdAt) })}</span>
            <span className="min-w-0 truncate font-mono">{history[0].fileName}</span>
          </>
        ) : undefined}
        actions={
          <>
            <Button
              variant="ghost"
              size="iconDense"
              onClick={refreshAll}
              disabled={loading}
              aria-label={t('pageHeader.refreshAria')}
              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; disables only transiently while a refresh is already in flight (the spinning icon is the self-evident "why"), not a permission gate needing DisabledReason. Triaged 2026-08-27.
              title={t('pageHeader.refreshTitle')}
            >
              <RefreshCw className={cn(loading && 'animate-spin')} aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowSettings(!showSettings)}
              aria-expanded={showSettings}
              aria-controls={showSettings ? SCHEDULE_CARD_ID : undefined}
              aria-label={t('pageHeader.settings')}
            >
              <CalendarClock aria-hidden="true" />
              <span className="hidden sm:inline">{t('pageHeader.settings')}</span>
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleUploadFile(file)
              }}
            />
            <RowActions
              ariaLabel={t('pageHeader.moreAria')}
              items={[
                {
                  label: uploadingBackup ? t('pageHeader.uploading', { percent: uploadPercent }) : t('pageHeader.uploadZip'),
                  icon: Upload,
                  onSelect: () => fileInputRef.current?.click(),
                  disabled: uploadDisabled,
                  reason: uploadBlockedReason,
                },
              ]}
            />
            <DisabledReason reason={createBlockedReason}>
              <Button
                variant="command"
                size="sm"
                onClick={handleCreateBackup}
                disabled={creatingBackup || restoringBackup !== null || restoreInProgressElsewhere || !backupStatus?.savesExists || activeServerRemote || !canManageBackups || serverChangedSinceLoad}
              >
                {creatingBackup ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Archive aria-hidden="true" />}
                {creatingBackup ? t('pageHeader.creating') : t('pageHeader.createBackup')}
              </Button>
            </DisabledReason>
          </>
        }
      />

      <PageAlerts alerts={pageAlerts} />

      {/* One live region, always rendered, for the Restore card in both its
          states below: a screen reader announces a change inside a region
          that already exists, and often not one inserted with its content
          already there -- so the card appearing, moving to "the panel didn't
          answer", and turning into how the restore ended are all heard.
          Empty, it takes no room (its margin collapses into the next
          block's). At most one of the two cards shows at a time. Restore
          and backup progress sit here, with the page's alerts and above the
          summary, so the list moves down once, not twice. */}
      <div role="status" aria-live="polite">
        {/* Restore Progress — a static reassurance rather than a real progress
            readout: the longest step, the pre-restore safety backup, already
            shows its own progress in the backup card below, and the rest
            (extract, verify, swap) only reports coarse steps on restore:progress.
            Also covers restoreInProgressElsewhere (a restore this session didn't
            start -- another tab, or already running when this page loaded):
            before this, that case disabled Create/Upload/Restore with no visible
            explanation ANYWHERE on the page -- the operator just saw greyed-out
            buttons and had to guess why. See restoreInProgressElsewhere's own
            comment above. */}
        {(restoringBackup || restoreInProgressElsewhere) && (
          <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5">
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-warning" aria-hidden="true" />
            <div className="min-w-0 space-y-0.5">
              <p className="truncate text-sm font-medium text-foreground">
                {restoringBackup
                  ? t('restoreProgress.title', { name: restoringBackup })
                  : runningRestore?.backupName
                    ? t('restoreProgress.title', { name: runningRestore.backupName })
                    : t('restoreProgress.titleUnknown')}
              </p>
              <p className="text-sm text-muted-foreground">
                {restoreResponseLost ? t('restoreProgress.responseLost') : t('restoreProgress.note')}
              </p>
            </div>
          </div>
        )}

        {/* The same card once the restore has ended (GH#166 -- it used to only
            ever spin): what happened, and what to do next. */}
        {!restoringBackup && !restoreInProgressElsewhere && restoreResult && (
          <div
            className={cn(
              'flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5',
              restoreResult.status === 'success' && 'border-success/30 bg-success/10',
              restoreResult.status === 'failed' && 'border-destructive/40 bg-destructive/10',
              restoreResult.status === 'unknown' && 'border-warning/40 bg-warning/10',
            )}
          >
            <div className="flex min-w-[min(100%,16rem)] flex-1 items-start gap-3">
              {restoreResult.status === 'success' ? (
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
              ) : (
                <AlertTriangle
                  className={cn('mt-0.5 h-4 w-4 shrink-0', restoreResult.status === 'failed' ? 'text-destructive' : 'text-warning')}
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-medium text-foreground">
                  {restoreResult.status === 'success'
                    ? t('restoreResult.successTitle')
                    : restoreResult.status === 'failed'
                      ? t('restoreResult.failedTitle')
                      : t('restoreResult.unknownTitle')}
                </p>
                {restoreResult.backupName && (
                  <p className="truncate font-mono text-xs text-muted-foreground">{restoreResult.backupName}</p>
                )}
                {restoreResult.status === 'success' && (
                  <p className="text-sm text-muted-foreground">
                    {restoreResult.safetyBackup
                      ? t('restoreResult.successDetail', { seconds: (restoreResult.seconds || 0).toFixed(1) })
                      : t('restoreResult.successDetailNoSafetyBackup', { seconds: (restoreResult.seconds || 0).toFixed(1) })}
                  </p>
                )}
                {restoreResult.status === 'failed' && (
                  <>
                    <p className="text-sm break-words text-foreground">{restoreResult.reason || t('toasts.restoreFailedFallback')}</p>
                    <p className="text-sm text-muted-foreground">{t('restoreResult.failedNextStep')}</p>
                  </>
                )}
                {restoreResult.status === 'unknown' && (
                  <p className="text-sm text-muted-foreground">{t('restoreResult.unknownDetail')}</p>
                )}
              </div>
            </div>
            <div className="ms-auto flex shrink-0 items-center gap-1">
              {/* Where the answer is: the restore's entries in the activity log.
                  Diagnostics reads need diagnostics.manage; without it the
                  text above already says to ask an administrator. */}
              {restoreResult.status === 'unknown' && canOpenDiagnostics && (
                <Button variant="outline" size="sm" asChild>
                  <Link to="/debug?tab=activity">{t('restoreResult.openActivity')}</Link>
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRestoreResult(null)}
                aria-label={t('restoreResult.dismissAria')}
              >
                {t('restoreResult.dismiss')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Backup progress: this page's own backup, a scheduled or another
          tab's one, and a restore's safety backup. */}
      {(creatingBackup || backupProgress) && (
        <div
          className={cn(
            'space-y-2 rounded-lg border px-3 py-2.5',
            backupProgress?.phase === 'error' ? 'border-destructive/40 bg-destructive/10' : 'border-primary/30 bg-primary/5',
          )}
        >
          <div className="flex items-center gap-3">
            {backupProgress?.phase === 'complete' ? (
              <Check className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
            ) : backupProgress?.phase === 'error' ? (
              <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
            ) : (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {backupProgress?.message || t('progress.creatingFallback')}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {backupProgress?.percent || 0}%
            </span>
          </div>
          <Progress value={backupProgress?.percent || 0} className="h-1.5" />
          {backupProgress?.currentFile && (
            <p className="truncate font-mono text-xs text-muted-foreground">
              {backupProgress.currentFile}
            </p>
          )}
        </div>
      )}

      {/* The summary -- gated on backupsLoaded (the fetch has settled, whether
          it found zero backups or many), not on backups.length > 0. The
          Auto-backup cell is where the on/off state, its schedule and a
          failing-scheduled-attempt warning show, and it opens the card with
          the switch -- gating it on having at least one backup meant a server
          whose scheduled backups have been failing since before the first
          one ever succeeded (backups.length stays 0 forever) looked
          IDENTICAL to "auto-backup just isn't configured", and the switch --
          the only control on this page that turns scheduling on -- was
          unreachable until the operator manually created a first backup. */}
      {backupsLoaded && <StatStrip items={summary} />}

      {/* The saved schedule's restart collisions. While the schedule card is
          open it shows the same notice for the schedule being edited
          instead (starting from this one -- see panelRestartOverlaps), so
          the two never sit on screen together. Neutral here, a warning in
          the card -- see BackupRestartOverlapNotice's `tone`. */}
      {!showSettings && backupStatus?.enabled && (
        <BackupRestartOverlapNotice overlaps={backupStatus.restartOverlaps} tone="neutral" />
      )}

      {showSettings && (
        <SectionCard
          id={SCHEDULE_CARD_ID}
          className="scroll-mt-4"
          icon={CalendarClock}
          title={t('settingsPanel.title')}
          description={t('settingsPanel.description')}
        >
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/25 p-3">
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor="backup-enabled" className="text-sm font-medium">{t('settingsPanel.enabledLabel')}</Label>
              <p className="text-xs text-muted-foreground">{t('settingsPanel.enabledHelp')}</p>
            </div>
            <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : statusUnknown ? t('backups.statusLoadFailed', { ns: 'settings' }) : null}>
              <Switch
                id="backup-enabled"
                checked={backupStatus?.enabled || false}
                onCheckedChange={toggleBackupEnabled}
                disabled={!canManageBackups || statusUnknown || serverChangedSinceLoad}
                aria-label={t('statusCards.toggleAria')}
              />
            </DisabledReason>
          </div>
          {!canManageBackups && (
            <p className="text-xs text-muted-foreground">{t('permissions.noManage')}</p>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="backup-schedule">{t('settingsPanel.frequencyLabel')}</Label>
              <Select
                value={customSchedule ? CUSTOM_SCHEDULE_VALUE : backupSchedule}
                onValueChange={handleFrequencyChange}
                disabled={!canManageBackups}
              >
                <SelectTrigger id="backup-schedule" className="w-full">
                  <SelectValue placeholder={t('settingsPanel.frequencyPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULE_PRESETS.map(([cron, labelKey]) => (
                    <SelectItem key={cron} value={cron}>{t(labelKey)}</SelectItem>
                  ))}
                  <SelectItem value={CUSTOM_SCHEDULE_VALUE}>{t('schedule.customOption')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('settingsPanel.frequencyHelp')}
              </p>
              {/* In the frequency column, right under the menu that
                  reveals it -- not after the whole grid, where a phone's
                  single column put it below Maximum Backups and Tab
                  reached that field first. */}
              {customSchedule && (
                <div className="space-y-2 pt-1">
                  <Label htmlFor="backup-schedule-cron">{t('settingsPanel.customLabel')}</Label>
                  <Input
                    id="backup-schedule-cron"
                    value={customCron}
                    onChange={(e) => setCustomCron(e.target.value)}
                    disabled={!canManageBackups}
                    // The bare cron, as Settings > Backups has it: under
                    // dir="ltr" a translated "e.g." prefix in an RTL
                    // language reordered the example around it (Arabic
                    // painted the minute and hour swapped). The hint below
                    // already says it's an example.
                    placeholder="30 3 * * *"
                    // A cron is left-to-right in every language; in an RTL
                    // page its neutral '*' and '/' would otherwise lay out
                    // reversed as it's typed.
                    dir="ltr"
                    className="font-mono"
                    maxLength={100}
                    aria-describedby="backup-schedule-cron-hint"
                  />
                  <p id="backup-schedule-cron-hint" className="text-xs text-muted-foreground">
                    {t('settingsPanel.customHint', { example: isolateLtrForRtl('30 3 * * *') })}
                  </p>
                  <BackupScheduleValidity check={shownScheduleCheck} pending={scheduleCheckPending} />
                </div>
              )}
              <BackupScheduleNextRun
                check={shownScheduleCheck}
                pending={scheduleCheckPending}
                backupsEnabled={backupStatus?.enabled}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="backup-max">{t('settingsPanel.maxBackupsLabel')}</Label>
              <NumberInput
                id="backup-max"
                min={1}
                max={100}
                value={backupMaxCount}
                onChange={setBackupMaxCount}
                onWheel={(e) => e.currentTarget.blur()}
                disabled={!canManageBackups}
                invalid={maxBackupsInvalid}
                className="max-w-24"
              />
              <p className="text-xs text-muted-foreground">
                {t('settingsPanel.maxBackupsHelp')}
              </p>
            </div>
          </div>
          {/* Saved with the schedule and limit (the save bar), unlike the
              on/off switch above. */}
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/25 p-3">
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor="backup-only-when-online" className="text-sm font-medium">{t('settingsPanel.onlyWhenOnlineLabel')}</Label>
              <p id="backup-only-when-online-help" className="text-xs text-muted-foreground">{t('settingsPanel.onlyWhenOnlineHelp')}</p>
            </div>
            <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : null}>
              <Switch
                id="backup-only-when-online"
                checked={backupOnlyWhenOnline}
                onCheckedChange={setBackupOnlyWhenOnline}
                disabled={!canManageBackups || backupStatus === null}
                aria-describedby="backup-only-when-online-help"
              />
            </DisabledReason>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/25 p-3">
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor="backup-include-db" className="text-sm font-medium">{t('settingsPanel.includeDbLabel')}</Label>
              <p id="backup-include-db-help" className="text-xs text-muted-foreground">{t('settingsPanel.includeDbHelp')}</p>
            </div>
            <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : null}>
              <Switch
                id="backup-include-db"
                checked={backupIncludeDb}
                onCheckedChange={setBackupIncludeDb}
                disabled={!canManageBackups || backupStatus === null}
                aria-describedby="backup-include-db-help"
              />
            </DisabledReason>
          </div>
          {/* With two local servers or more: which of them the schedule
              backs up. Saved at once, on its own. */}
          <ScheduledBackupServers canManage={canManageBackups} />
          {/* The timezone line is already on screen, in the next-run
              block above, whenever the card has a verdict to show it. */}
          <BackupRestartOverlapNotice
            overlaps={panelRestartOverlaps}
            live
            stale={scheduleCheckPending}
            hideTimeZone={Boolean(shownScheduleCheck?.valid)}
          />
          {backupStatus?.savesPath && (
            <p className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-4 text-xs text-muted-foreground">
              <FolderOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="break-all">{t('settingsPanel.savesLabel', { path: backupStatus.savesPath })}</span>
            </p>
          )}
        </SectionCard>
      )}

      <SectionCard
        title={t('mainCard.title')}
        status={backupStatus && !backupStatus.savesExists ? (
          <StatusPill tone="warn" size="sm" label={t('mainCard.savesNotFound')} />
        ) : undefined}
        flush
      >
        {backupStatus && !backupStatus.savesExists && backupsLoaded && backups.length === 0 ? (
          // Known, actionable answer as soon as BOTH fetches it actually
          // depends on have resolved -- doesn't wait on the unrelated,
          // slower-or-not fetchHistory() call the generic `loading` flag
          // below is also gated on. Matches the informative "what was
          // tried, how to fix it, an action" pattern Chunks and Mods
          // already use for this identical no-saves-folder condition,
          // rather than inventing a fourth one (2026-08-30 visual sweep:
          // this card used to show an infinite spinner here even after
          // the header above had already resolved to the same fact).
          <div className="p-5">
            <EmptyState
              type="empty"
              title={t('mainCard.noSavesFolderTitle')}
              description={t('mainCard.noSavesFolderDesc')}
              action={{ label: t('mainCard.noSavesFolderAction'), to: '/server-setup' }}
            />
          </div>
        ) : !backupsLoaded ? (
          // The first load only: a refresh (or a server switch) keeps the
          // list on screen until the new one lands, instead of flashing it
          // away -- the actions stay gated meanwhile.
          <ul className="divide-y divide-border/60" aria-busy="true">
            {[0, 1, 2].map((row) => (
              <li key={row} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                <Skeleton className="h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/3 max-w-sm" />
                  <Skeleton className="h-3 w-40" />
                </div>
                <Skeleton className="h-8 w-20 shrink-0" />
              </li>
            ))}
          </ul>
        ) : backups.length === 0 ? (
          <div className="p-5">
            {/* "Turn on scheduled backups above": that switch is in the
                Schedule & retention card, closed unless ?panel=schedule, so
                the second button opens it. */}
            <EmptyState
              type="noData"
              title={t('mainCard.emptyTitle')}
              description={backupStatus?.enabled ? t('mainCard.emptyDescScheduled') : t('mainCard.emptyDesc')}
              action={canManageBackups ? { label: t('mainCard.emptyAction'), onClick: handleCreateBackup, variant: 'default' } : undefined}
              secondaryAction={canManageBackups && !backupStatus?.enabled && !showSettings ? { label: t('settingsPanel.enabledLabel'), onClick: openSchedule } : undefined}
            />
          </div>
        ) : (
          <>
            <Toolbar
              className="border-b border-border/60 px-4 py-2.5 sm:px-5"
              end={
                <>
                  {isAnySelected && (
                    <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : null}>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setDeleteDialog({ open: true, names: Array.from(selectedBackups) })}
                        disabled={deletingBackups || !canManageBackups || serverChangedSinceLoad}
                      >
                        <Trash2 aria-hidden="true" />
                        {t('mainCard.deleteSelected', { count: selectedBackups.size })}
                      </Button>
                    </DisabledReason>
                  )}
                  <RowActions
                    ariaLabel={t('mainCard.moreAria')}
                    items={[
                      {
                        label: t('mainCard.deleteOlder'),
                        icon: deletingOlder ? Loader2 : Clock,
                        destructive: true,
                        onSelect: () => setDeleteOlderDialog(true),
                        disabled: deletingOlder || backups.length === 0 || !canManageBackups || serverChangedSinceLoad,
                        reason: !canManageBackups
                          ? t('permissions.noManage')
                          : serverChangedSinceLoad
                            ? t('toasts.serverChangedSinceLoadDesc')
                            : undefined,
                      },
                    ]}
                  />
                </>
              }
            >
              <div className="flex min-w-0 items-center gap-3">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleSelectAll}
                  id="select-all"
                />
                <Label htmlFor="select-all" className="cursor-pointer text-sm font-medium">
                  {selectedBackups.size === 0
                    ? t('mainCard.selectAllLabel', { count: backups.length })
                    : allSelected
                      ? t('mainCard.allSelectedLabel', { count: backups.length })
                      : t('mainCard.partialSelectedLabel', { selected: selectedBackups.size, total: backups.length })}
                </Label>
              </div>
            </Toolbar>

            <ul className="divide-y divide-border/60">
              {backups.map((backup, idx) => {
                const isSelected = selectedBackups.has(backup.name)
                const isRestoring = restoringBackup === backup.name
                const isLatest = idx === 0

                return (
                  <li
                    key={backup.name}
                    className={cn(
                      'flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors sm:px-5',
                      isSelected ? 'bg-primary/5' : 'hover:bg-muted/20',
                    )}
                  >
                    <div className="flex min-w-[min(100%,15rem)] flex-1 items-center gap-3">
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleBackupSelection(backup.name)}
                        disabled={isRestoring}
                        aria-label={t('mainCard.selectBackupAria', { name: backup.name })}
                      />
                      <Archive className={cn('h-4 w-4 shrink-0', isLatest ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="truncate text-sm font-medium text-foreground" title={backup.name}>{backup.name}</p>
                          {isLatest && (
                            <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-primary/15 px-2 text-[10px] font-medium uppercase tracking-wide text-primary">
                              {t('mainCard.latestBadge')}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1 tabular-nums">
                            <HardDrive className="h-3 w-3" aria-hidden="true" />
                            {formatBytes(backup.size)}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" aria-hidden="true" />
                            {formatDate(backup.created)}
                          </span>
                        </div>
                      </div>
                    </div>

                    <RowActions
                      className="ms-auto"
                      ariaLabel={t('mainCard.actionsAria', { name: backup.name })}
                      primary={
                        <DisabledReason reason={!canRestoreBackups ? t('permissions.noRestore') : restoreInProgressElsewhere ? t('permissions.restoreInProgress') : null}>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openRestoreDialog(backup.name)}
                            disabled={isRestoring || restoringBackup !== null || restoreInProgressElsewhere || creatingBackup || !canRestoreBackups || serverChangedSinceLoad}
                            aria-label={t('mainCard.restoreAria', { name: backup.name })}
                          >
                            {isRestoring ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}
                            {t('mainCard.restore')}
                          </Button>
                        </DisabledReason>
                      }
                      items={[
                        {
                          label: t('mainCard.viewSnapshotTitle'),
                          icon: FileText,
                          onSelect: () => { void handleViewSnapshot(backup.name) },
                          disabled: !canManageBackups,
                          reason: !canManageBackups ? t('permissions.noManage') : undefined,
                        },
                        {
                          label: t('mainCard.downloadTitle'),
                          icon: Download,
                          onSelect: () => { if (canDownloadBackups) void handleDownload(backup.name) },
                          disabled: !canDownloadBackups,
                          reason: !canDownloadBackups ? t('permissions.noDownload') : undefined,
                        },
                        {
                          label: t('mainCard.deleteTitle'),
                          icon: Trash2,
                          destructive: true,
                          onSelect: () => setDeleteDialog({ open: true, names: [backup.name] }),
                          disabled: deletingBackups || !canManageBackups || serverChangedSinceLoad,
                          reason: !canManageBackups
                            ? t('permissions.noManage')
                            : serverChangedSinceLoad
                              ? t('toasts.serverChangedSinceLoadDesc')
                              : undefined,
                        },
                      ]}
                    />
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </SectionCard>

      <AlertDialog open={snapshotDialog !== null} onOpenChange={(open) => !open && setSnapshotDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('snapshotDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>{snapshotDialog?.name}</AlertDialogDescription>
          </AlertDialogHeader>
          {/* 2026-09 dialog sweep: a long SERVER.INI line (PublicName, Map)
              set the <pre>'s width, which widened the whole confirm past the
              screen at every size (fixed by AlertDialogContent's one-column
              template: each <pre> now scrolls sideways inside itself); and on
              a landscape phone its only button, Close -- the only way out of
              an AlertDialog on touch -- was below the fold, with the two
              <pre>s scrollers nested inside. The snapshot scrolls in one
              AlertDialogBody now (the <pre>s only scroll sideways), and the
              server values wrap. */}
          {snapshotDialog && (
            <AlertDialogBody className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
                <span>{t('snapshotDialog.serverLabel')}</span><span className="text-foreground [overflow-wrap:anywhere]">{snapshotDialog.snapshot.server.name}</span>
                <span>{t('snapshotDialog.providerLabel')}</span><span className="text-foreground [overflow-wrap:anywhere]">{snapshotDialog.snapshot.server.provider}</span>
                <span>{t('snapshotDialog.capturedLabel')}</span><span className="text-foreground">{formatDateTime(snapshotDialog.snapshot.createdAt, { seconds: true })}</span>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">{t('snapshotDialog.serverIniLabel')}</p>
                <pre className="overflow-x-auto rounded border border-border/60 bg-muted/20 p-2 text-xs">{Object.entries(snapshotDialog.snapshot.serverIni).map(([key, value]) => `${key}=${value}`).join('\n') || t('snapshotDialog.noSettings')}</pre>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">{t('snapshotDialog.sandboxLabel')}</p>
                <pre className="overflow-x-auto rounded border border-border/60 bg-muted/20 p-2 text-xs">{Object.entries(snapshotDialog.snapshot.sandboxVars).map(([key, value]) => `${key}=${value}`).join('\n') || t('snapshotDialog.noSettings')}</pre>
              </div>
            </AlertDialogBody>
          )}
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setSnapshotDialog(null)}>{t('snapshotDialog.close')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Restore Confirmation Dialog. Michelle's UX audit (2026-08-26): this
          used to be styled text-warning/bg-warning -- the same tier as
          "delete a few old backup files" below -- despite replacing the
          entire live world, arguably the highest-impact button in the app.
          Bumped to text-destructive/bg-destructive to match this file's own
          single-backup delete dialog and Dashboard's wipe confirm button,
          both of which already use destructive for a smaller blast radius
          than a full restore. Also fixed the bullet list's self-contradiction
          flagged by the same audit: bulletSafetyBackup ("the panel will
          create a safety backup") and the old bulletCannotUndo ("this action
          cannot be undone") asserted opposite things. Verified against
          backupService.js's restoreBackup() and this component's own
          handleRestoreBackup call (passes createPreRestoreBackup: true) --
          the safety-backup claim is true, so "cannot be undone" was the
          false one: a restore CAN be undone, just not automatically.
          Replaced with bulletUndoRequiresRestore, which keeps the real
          warning (undoing isn't one click) without the false claim. */}
      <AlertDialog open={restoreDialog.open} onOpenChange={(open) => setRestoreDialog({ open, backupName: null })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              {t('restoreDialog.title')}
              <HelpTip label={t('restoreDialog.title')}>{t('restoreDialog.scopeTip')}</HelpTip>
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                <Trans
                  i18nKey="restoreDialog.description"
                  t={t}
                  values={{
                    name: restoreDialog.backupName,
                    serverName: restoreTargetServerName || t('restoreDialog.unknownServerFallback'),
                  }}
                  components={{
                    1: <strong />,
                    2: <span className="font-medium text-destructive" />,
                    3: <strong className="text-destructive" />,
                  }}
                />
              </p>
              <ul className="list-disc list-inside text-sm space-y-1 mt-2">
                <li>{t('restoreDialog.bulletStopServer')}</li>
                <li>{t('restoreDialog.bulletSafetyBackup')}</li>
                <li>{t('restoreDialog.bulletUndoRequiresRestore')}</li>
              </ul>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('restoreDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => restoreDialog.backupName && handleRestoreBackup(restoreDialog.backupName)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('restoreDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialog.open} onOpenChange={(open) => setDeleteDialog({ open, names: [] })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="w-5 h-5" />
              {deleteDialog.names.length > 1 ? t('deleteDialog.titlePlural') : t('deleteDialog.titleSingle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteDialog.names.length === 1 ? (
                <p>
                  <Trans
                    i18nKey="deleteDialog.descSingle"
                    t={t}
                    values={{ name: deleteDialog.names[0] }}
                    components={{ 1: <strong /> }}
                  />
                </p>
              ) : (
                <p>
                  <Trans
                    i18nKey="deleteDialog.descPlural"
                    t={t}
                    values={{ count: deleteDialog.names.length }}
                    components={{ 1: <strong /> }}
                  />
                </p>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('deleteDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => handleDeleteBackups(deleteDialog.names)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteDialog.names.length > 1 ? t('deleteDialog.confirmPlural') : t('deleteDialog.confirmSingle')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Older Than Dialog -- same permanent-data-loss severity as
          the single/bulk delete dialog above (deleteDialog), just a
          different entry point. Styled destructive-red to match rather
          than the amber it had before, which understated a no-undo bulk
          delete relative to its sibling action. */}
      <AlertDialog open={deleteOlderDialog} onOpenChange={setDeleteOlderDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Clock className="w-5 h-5" />
              {t('deleteOlderDialog.title')}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4">
                <p>{t('deleteOlderDialog.description')}</p>
                {/* Wraps (2026-09 dialog sweep): the es/fr/ht labels are
                    wider than a 375px dialog beside the number input, and
                    a nowrap row pushed the input and the buttons off it. */}
                <div className="flex flex-wrap items-center gap-3">
                  <Label htmlFor="delete-days" className="text-foreground">{t('deleteOlderDialog.olderThanLabel')}</Label>
                  <NumberInput
                    id="delete-days"
                    min={1}
                    max={365}
                    value={deleteOlderDays}
                    onChange={setDeleteOlderDays}
                    onWheel={(e) => e.currentTarget.blur()}
                    className="w-20"
                  />
                  <span className="text-foreground">{t('deleteOlderDialog.daysUnit')}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('deleteOlderDialog.warningWithDays', { days: deleteOlderDays })}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('deleteOlderDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteOlderThan}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('deleteOlderDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* The schedule card's one Save: sticks to the bottom while the
          frequency or the limit differ from what's saved, with Ctrl+S, and
          asks before the page is left with them unsaved. */}
      <SaveBar
        dirty={settingsDirty}
        saving={savingSettings}
        onSave={() => { void handleSaveSettings() }}
        onDiscard={discardSettings}
        disabledReason={saveSettingsBlockedReason}
        saveLabel={t('settingsPanel.saveButton')}
      />
    </div>
  )
}
