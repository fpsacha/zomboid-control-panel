import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { Trans, useTranslation } from 'react-i18next'
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
  Settings,
  AlertTriangle,
  Check,
  Upload,
  FileText,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { NumberInput } from '@/components/NumberInput'
import { Label } from '@/components/ui/label'
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
import { ScrollArea } from '@/components/ui/scroll-area'
import { Checkbox } from '@/components/ui/checkbox'
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
import { useToast } from '@/components/ui/use-toast'
import { useSocket } from '@/contexts/SocketContext'
import { backupApi, serversApi, BackupStatus, ServerBackupArchive, BackupHistoryRecord, BackupSnapshot } from '@/lib/api'
import { cn } from '@/lib/utils'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { PageHeader } from '@/components/PageHeader'
import { DisabledReason } from '@/components/DisabledReason'
import { useAuth } from '@/contexts/AuthContext'
import { EmptyState } from '@/components/EmptyState'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

interface BackupProgress {
  phase: 'preparing' | 'archiving' | 'finalizing' | 'complete' | 'error'
  percent: number
  message: string
  filesProcessed?: number
  totalFiles?: number
  currentFile?: string
}

export default function Backups() {
  const { t, i18n } = useTranslation('backups')
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

  // Refs for cleanup
  const progressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // State
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null)
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
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null)
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

  // Settings state
  const [showSettings, setShowSettings] = useState(false)
  const [backupSchedule, setBackupSchedule] = useState('0 */6 * * *')
  const [backupMaxCount, setBackupMaxCount] = useState(10)
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
  const fetchBackupStatus = useCallback(async () => {
    try {
      const status = await backupApi.getStatus()
      setBackupStatus(status)
      setBackupSchedule(status.schedule)
      setBackupMaxCount(status.maxBackups)
      setLoadError(null)
      // The server's own backupInProgress mutex (backupService.js) is the
      // one source of truth for whether a backup is actually running --
      // including one this browser session didn't start (the scheduler, a
      // second tab, or a backup already underway before this page loaded).
      // creatingBackup was local-only and defaulted to false on every
      // mount, so a page load or reload mid-backup showed no progress card
      // and left Create Backup clickable, inviting a second backup into the
      // server's own reject-on-conflict guard with no explanation on
      // screen. Only ever set TRUE here -- the existing socket
      // 'backup:progress' complete/error handlers and handleCreateBackup's
      // own `finally` already own turning it back off correctly, and racing
      // a false here against those would just reintroduce the bug sideways.
      if (status.backupInProgress) setCreatingBackup(true)
    } catch (error) {
      setLoadError(getUserErrorMessage(error, t('toasts.loadStatusFailed')))
    }
  }, [t])

  const fetchBackups = useCallback(async () => {
    try {
      const data = await backupApi.listBackups()
      setBackups(data.backups || [])
      setLoadError(null)
      // Clear selection for backups that no longer exist
      setSelectedBackups(prev => {
        const backupNames = new Set((data.backups || []).map(b => b.name))
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

  const fetchHistory = useCallback(async (serverId: string | number | null) => {
    if (serverId == null) {
      setHistory([])
      return
    }
    try {
      const data = await backupApi.getHistory(serverId)
      setHistory(data.records || [])
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
        progressTimeoutRef.current = setTimeout(() => setBackupProgress(null), 3000)
      }
    }

    socket.on('backup:progress', handleBackupProgress)

    return () => {
      socket.off('backup:progress', handleBackupProgress)
      // Clear timeout on unmount
      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current)
      }
    }
  }, [socket, fetchBackups, fetchBackupStatus])

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
    setCreatingBackup(true)
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
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.serverChangedSinceLoadTitle'),
        description: t('toasts.serverChangedSinceLoadDesc'),
        variant: 'destructive',
      })
      return
    }
    setRestoreDialog({ open: false, backupName: null })
    setRestoringBackup(name)
    try {
      // POST /backup/restore/:name always responds non-2xx on failure, so
      // handleResponse() throws into the catch below -- this never sees
      // result.success === false.
      const result = await backupApi.restoreBackup(name, { createPreRestoreBackup: true })
      toast({
        title: t('toasts.restoredTitle'),
        description: t('toasts.restoredDesc', { name, seconds: (result.duration || 0).toFixed(1) }),
        variant: 'success' as const,
      })
      await fetchBackups()
    } catch (error) {
      toast({
        title: t('toasts.restoreFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.restoreFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setRestoringBackup(null)
    }
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
      const result = await backupApi.deleteOlderThan(deleteOlderDays)
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

  const handleSaveSettings = async () => {
    if (!canManageBackups) return
    setSavingSettings(true)
    try {
      await backupApi.updateSettings({
        enabled: backupStatus?.enabled || false,
        schedule: backupSchedule,
        maxBackups: backupMaxCount,
      })
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
    try {
      await backupApi.updateSettings({ enabled })
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

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr)
    return date.toLocaleDateString(i18n.language) + ' ' + date.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })
  }

  // "Auto-Backup: On" alone can't tell an operator the scheduler is actually
  // succeeding -- lastBackup only updates on a SUCCESSFUL run, so a run of
  // failures (bad cron, unreachable backupsPath, disk full) leaves this
  // card looking identical to a healthy one. Surface the newest scheduled
  // attempt specifically when it failed.
  const lastScheduledAttemptFailed = Boolean(
    backupStatus?.enabled && backupStatus?.lastScheduledBackupAttempt && !backupStatus.lastScheduledBackupAttempt.success
  )

  // Translate the small set of cron presets we expose into a human label.
  // Falls back to the raw cron string for anything custom so the user
  // still gets meaningful information without us shipping a full parser.
  const describeSchedule = (cron: string | undefined): string => {
    if (!cron) return t('schedule.none')
    const map: Record<string, string> = {
      '*/15 * * * *': t('schedule.every15Min'),
      '*/30 * * * *': t('schedule.every30Min'),
      '0 * * * *': t('schedule.everyHour'),
      '0 */2 * * *': t('schedule.every2Hours'),
      '0 */4 * * *': t('schedule.every4Hours'),
      '0 */6 * * *': t('schedule.every6Hours'),
      '0 */8 * * *': t('schedule.every8Hours'),
      '0 */12 * * *': t('schedule.every12Hours'),
      '0 0 * * *': t('schedule.dailyMidnight'),
      '0 6 * * *': t('schedule.daily6am'),
      '0 12 * * *': t('schedule.dailyNoon'),
      '0 18 * * *': t('schedule.daily6pm'),
    }
    return map[cron] || cron
  }

  const totalSize = useMemo(() => {
    return backups.reduce((sum, b) => sum + b.size, 0)
  }, [backups])

  const isAnySelected = selectedBackups.size > 0
  const allSelected = backups.length > 0 && selectedBackups.size === backups.length

  // A restore this session didn't start (another tab, or already running
  // when this page loaded) has no backup name to show in the per-row
  // "Restoring <name>..." card, but it must still block new
  // create/upload/restore actions the same way a locally-tracked one does
  // -- the server's mutex (backupService.js) rejects a second restore or a
  // backup during one either way, so leaving these enabled just moves the
  // failure from "greyed out with a reason" to "clicked, then an error".
  const restoreInProgressElsewhere = restoringBackup === null && Boolean(backupStatus?.restoreInProgress)

  return (
    <div className="space-y-6 page-transition">
      {/* Header */}
      <PageHeader
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
        icon={<Archive className="w-5 h-5 text-primary" />}
        actions={
          <>
            <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : activeServerRemote ? t('pageHeader.remoteDisabledTitle') : null}>
              <Button
                onClick={handleCreateBackup}
                disabled={creatingBackup || restoringBackup !== null || restoreInProgressElsewhere || !backupStatus?.savesExists || activeServerRemote || !canManageBackups || serverChangedSinceLoad}
                className="gap-2"
              >
                {creatingBackup ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Archive className="w-4 h-4" />
                )}
                {creatingBackup ? t('pageHeader.creating') : t('pageHeader.createBackup')}
              </Button>
            </DisabledReason>
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
            <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : activeServerRemote ? t('pageHeader.uploadTitleRemote') : null}>
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingBackup || restoringBackup !== null || restoreInProgressElsewhere || activeServerRemote || !canManageBackups || serverChangedSinceLoad}
                className="gap-2"
                // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Upload an existing world_backup_*.zip from another machine"); the actual disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                title={t('pageHeader.uploadTitleLocal')}
              >
                {uploadingBackup ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
                {uploadingBackup ? t('pageHeader.uploading', { percent: uploadPercent }) : t('pageHeader.uploadZip')}
              </Button>
            </DisabledReason>
            <Button
              variant="outline"
              onClick={() => setShowSettings(!showSettings)}
              className="gap-2"
            >
              <Settings className="w-4 h-4" />
              {t('pageHeader.settings')}
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={refreshAll}
              disabled={loading}
              aria-label={t('pageHeader.refreshAria')}
              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; disables only transiently while a refresh is already in flight (the spinning icon is the self-evident "why"), not a permission gate needing DisabledReason. Triaged 2026-08-27.
              title={t('pageHeader.refreshTitle')}
            >
              <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
            </Button>
          </>
        }
      />

      {loadError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t('alerts.loadErrorTitle')}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={refreshAll} className="self-start sm:self-auto">
              <RefreshCw className="me-2 h-4 w-4" />
              {t('alerts.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {activeServerRemote && (
        <Alert className="border-warning/40 bg-warning/10">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertTitle>{t('alerts.remoteTitle')}</AlertTitle>
          <AlertDescription>
            {t('alerts.remoteDesc')}
          </AlertDescription>
        </Alert>
      )}

      {activeServerId != null && history.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-border/50 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{t('history.label')}</span>
          <span>{t('history.recordedCount', { count: history.length })}</span>
          <span>{t('history.latest', { date: formatDate(history[0].createdAt) })}</span>
          <span className="font-mono">{history[0].fileName}</span>
        </div>
      )}

      {/* Status Cards */}
      {backups.length > 0 && (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 stagger-in">
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div className="grid place-items-center w-10 h-10 rounded-md border border-primary/30 bg-primary/[0.06] text-primary shrink-0" aria-hidden="true">
              <Archive className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('statusCards.totalBackups')}</p>
              <p className="text-xl font-semibold leading-tight mt-0.5 text-foreground">{backups.length}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div className="grid place-items-center w-10 h-10 rounded-md border border-border/55 bg-muted/30 text-muted-foreground shrink-0" aria-hidden="true">
              <HardDrive className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('statusCards.totalSize')}</p>
              <p className="text-xl font-semibold leading-tight mt-0.5 text-foreground tabular-nums">{formatBytes(totalSize)}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div className="grid place-items-center w-10 h-10 rounded-md border border-primary/30 bg-primary/[0.06] text-primary shrink-0" aria-hidden="true">
              <Clock className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('statusCards.lastBackup')}</p>
              <p className="text-sm font-semibold leading-tight mt-0.5 text-foreground truncate">
                {backupStatus?.lastBackup ? formatDate(backupStatus.lastBackup.created) : t('statusCards.never')}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div
              className={cn(
                'grid place-items-center w-10 h-10 rounded-md border shrink-0',
                lastScheduledAttemptFailed
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                  : backupStatus?.enabled
                  ? 'border-primary/30 bg-primary/[0.06] text-primary'
                  : 'border-border/55 bg-muted/30 text-muted-foreground'
              )}
              aria-hidden="true"
            >
              {lastScheduledAttemptFailed ? <AlertTriangle className="w-4 h-4" /> : <Clock className="w-4 h-4" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('statusCards.autoBackup')}</p>
              <p className={cn('text-sm font-semibold leading-tight mt-0.5 truncate', backupStatus?.enabled ? 'text-foreground' : 'text-muted-foreground')}>
                {backupStatus?.enabled ? t('statusCards.on') : t('statusCards.off')}
              </p>
              {lastScheduledAttemptFailed ? (
                <p
                  className="text-[11px] text-amber-600 dark:text-amber-400 truncate"
                  title={backupStatus?.lastScheduledBackupAttempt?.message || ''}
                >
                  {t('statusCards.lastScheduledAttemptFailed', {
                    time: formatDate(backupStatus!.lastScheduledBackupAttempt!.executedAt),
                    message: backupStatus?.lastScheduledBackupAttempt?.message || '',
                  })}
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground/80 truncate" title={backupStatus?.schedule || ''}>
                  {backupStatus?.enabled
                    ? t('statusCards.runsSchedule', { schedule: describeSchedule(backupStatus?.schedule), count: backupStatus?.maxBackups ?? '?' })
                    : t('statusCards.noScheduled')}
                </p>
              )}
            </div>
            <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : null}>
              <Switch
                checked={backupStatus?.enabled || false}
                onCheckedChange={toggleBackupEnabled}
                disabled={!canManageBackups}
                aria-label={t('statusCards.toggleAria')}
              />
            </DisabledReason>
          </CardContent>
        </Card>
      </div>
      )}

      {/* Settings Panel (collapsible) */}
      {showSettings && (
        <Card className="border-primary/15">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Settings className="w-5 h-5" />
              {t('settingsPanel.title')}
            </CardTitle>
            <CardDescription>{t('settingsPanel.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="backup-schedule">{t('settingsPanel.frequencyLabel')}</Label>
                <Select value={backupSchedule} onValueChange={setBackupSchedule}>
                  <SelectTrigger id="backup-schedule" className="w-full">
                    <SelectValue placeholder={t('settingsPanel.frequencyPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="*/15 * * * *">{t('schedule.every15Min')}</SelectItem>
                    <SelectItem value="*/30 * * * *">{t('schedule.every30Min')}</SelectItem>
                    <SelectItem value="0 * * * *">{t('schedule.everyHour')}</SelectItem>
                    <SelectItem value="0 */2 * * *">{t('schedule.every2Hours')}</SelectItem>
                    <SelectItem value="0 */4 * * *">{t('schedule.every4Hours')}</SelectItem>
                    <SelectItem value="0 */6 * * *">{t('schedule.every6Hours')}</SelectItem>
                    <SelectItem value="0 */8 * * *">{t('schedule.every8Hours')}</SelectItem>
                    <SelectItem value="0 */12 * * *">{t('schedule.every12Hours')}</SelectItem>
                    <SelectItem value="0 0 * * *">{t('schedule.dailyMidnight')}</SelectItem>
                    <SelectItem value="0 6 * * *">{t('schedule.daily6am')}</SelectItem>
                    <SelectItem value="0 12 * * *">{t('schedule.dailyNoon')}</SelectItem>
                    <SelectItem value="0 18 * * *">{t('schedule.daily6pm')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t('settingsPanel.frequencyHelp')}
                </p>
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
                  className="max-w-24"
                />
                <p className="text-xs text-muted-foreground">
                  {t('settingsPanel.maxBackupsHelp')}
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 text-xs text-muted-foreground">
                {backupStatus?.savesPath && (
                  <span className="flex flex-wrap items-center gap-1 break-all">
                    <FolderOpen className="w-3 h-3" />
                    {t('settingsPanel.savesLabel', { path: backupStatus.savesPath })}
                  </span>
                )}
              </div>
              <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : null}>
                <Button onClick={handleSaveSettings} disabled={savingSettings || !canManageBackups} size="sm" className="h-10 gap-2 self-start sm:self-auto">
                  {savingSettings && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
                  {t('settingsPanel.saveButton')}
                </Button>
              </DisabledReason>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Restore Progress — the server emits no progress events for restore (it's a
          silent extract + pre-restore-backup sequence that can run minutes), so this
          is a static reassurance rather than a real progress readout. */}
      {restoringBackup && (
        <Card className="border-warning/15 bg-warning/5">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 animate-spin text-warning shrink-0" />
              <div className="min-w-0">
                <p className="font-medium truncate">{t('restoreProgress.title', { name: restoringBackup })}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t('restoreProgress.note')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Progress Bar */}
      {(creatingBackup || backupProgress) && (
        <Card className="border-primary/15 bg-primary/5">
          <CardContent className="pt-6">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {backupProgress?.phase === 'complete' ? (
                    <Check className="w-5 h-5 text-primary" />
                  ) : backupProgress?.phase === 'error' ? (
                    <AlertTriangle className="w-5 h-5 text-destructive" />
                  ) : (
                    <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  )}
                  <span className="font-medium">
                    {backupProgress?.message || t('progress.creatingFallback')}
                  </span>
                </div>
                <span className="text-sm text-muted-foreground">
                  {backupProgress?.percent || 0}%
                </span>
              </div>
              <Progress value={backupProgress?.percent || 0} className="h-2" />
              {backupProgress?.currentFile && (
                <p className="text-xs text-muted-foreground truncate">
                  {backupProgress.currentFile}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main Backup Card */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <CardTitle className="text-lg">{t('mainCard.title')}</CardTitle>
              {!backupStatus?.savesExists && (
                <span className="flex items-center gap-1 text-xs text-warning">
                  <AlertTriangle className="w-3 h-3" />
                  {t('mainCard.savesNotFound')}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {isAnySelected && (
                <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : null}>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setDeleteDialog({ open: true, names: Array.from(selectedBackups) })}
                    disabled={deletingBackups || !canManageBackups || serverChangedSinceLoad}
                    className="h-10 gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    {t('mainCard.deleteSelected', { count: selectedBackups.size })}
                  </Button>
                </DisabledReason>
              )}
              <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : null}>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setDeleteOlderDialog(true)}
                  disabled={deletingOlder || backups.length === 0 || !canManageBackups}
                  className="h-10 gap-2"
                >
                  {deletingOlder ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Clock className="w-4 h-4" />
                  )}
                  {t('mainCard.deleteOlder')}
                </Button>
              </DisabledReason>
            </div>
          </div>
        </CardHeader>
        <CardContent>
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
            <EmptyState
              type="empty"
              title={t('mainCard.noSavesFolderTitle')}
              description={t('mainCard.noSavesFolderDesc')}
              action={{ label: t('mainCard.noSavesFolderAction'), to: '/server-setup' }}
            />
          ) : loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          ) : backups.length === 0 ? (
            <EmptyState type="noData" title={t('mainCard.emptyTitle')} description={t('mainCard.emptyDesc')} action={canManageBackups ? { label: t('mainCard.emptyAction'), onClick: handleCreateBackup, variant: 'default' } : undefined} />
          ) : (
            <div className="space-y-2">
              {/* Select All Header */}
              <div className="flex items-center gap-3 px-3 py-2.5 border border-border/50 bg-muted/20 rounded-lg">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleSelectAll}
                  id="select-all"
                />
                <Label htmlFor="select-all" className="text-sm font-medium cursor-pointer flex-1">
                  {selectedBackups.size === 0
                    ? t('mainCard.selectAllLabel', { count: backups.length })
                    : allSelected
                      ? t('mainCard.allSelectedLabel', { count: backups.length })
                      : t('mainCard.partialSelectedLabel', { selected: selectedBackups.size, total: backups.length })}
                </Label>
                {selectedBackups.size > 0 && (
                  <span className="inline-flex h-5 items-center rounded-full bg-primary/15 px-2 font-mono text-[11px] tabular-nums text-primary">
                    {selectedBackups.size}
                  </span>
                )}
              </div>

              {/* Backup List */}
              <ScrollArea className="h-[300px] sm:h-[400px]">
                <div className="space-y-2 pe-4">
                  {backups.map((backup, idx) => {
                    const isSelected = selectedBackups.has(backup.name)
                    const isRestoring = restoringBackup === backup.name
                    const isLatest = idx === 0

                    return (
                      <div
                        key={backup.name}
                        className={cn(
                          'group/backup flex flex-col gap-3 p-3 rounded-lg border transition-colors sm:flex-row sm:items-center',
                          isSelected
                            ? 'border-primary/40 bg-primary/[0.08]'
                            : 'bg-muted/20 border-border/40 hover:border-primary/30 hover:bg-muted/40'
                        )}
                      >
                        <div className="flex flex-1 min-w-0 items-center gap-3">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleBackupSelection(backup.name)}
                            disabled={isRestoring}
                            aria-label={t('mainCard.selectBackupAria', { name: backup.name })}
                          />

                          {/* Leading archive tile — latest backup glows primary, others sit muted */}
                          <div
                            className={cn(
                              'grid place-items-center w-9 h-9 rounded-md border shrink-0',
                              isLatest
                                ? 'border-primary/40 bg-primary/[0.08] text-primary'
                                : 'border-border/55 bg-muted/30 text-muted-foreground'
                            )}
                            aria-hidden="true"
                          >
                            <Archive className="w-4 h-4" />
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <p className="font-medium text-sm text-foreground truncate">{backup.name}</p>
                              {isLatest && (
                                <span className="shrink-0 inline-flex h-5 items-center rounded-full bg-primary/15 px-2 text-[10px] font-medium uppercase tracking-wide text-primary">
                                  {t('mainCard.latestBadge')}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                              <span className="inline-flex items-center gap-1 tabular-nums">
                                <HardDrive className="w-3 h-3" />
                                {formatBytes(backup.size)}
                              </span>
                              <span className="inline-flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {formatDate(backup.created)}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1">
                          <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : null}>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleViewSnapshot(backup.name)}
                              disabled={!canManageBackups}
                              className="h-9 w-9"
                              aria-label={t('mainCard.viewSnapshotAria', { name: backup.name })}
                              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                              title={t('mainCard.viewSnapshotTitle')}
                            >
                              <FileText className="w-4 h-4" />
                            </Button>
                          </DisabledReason>
                          <DisabledReason reason={!canRestoreBackups ? t('permissions.noRestore') : null}>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openRestoreDialog(backup.name)}
                              disabled={isRestoring || restoringBackup !== null || restoreInProgressElsewhere || creatingBackup || !canRestoreBackups || serverChangedSinceLoad}
                              className="h-9 w-9 text-warning hover:text-warning hover:bg-warning/10"
                              aria-label={t('mainCard.restoreAria', { name: backup.name })}
                              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                              title={t('mainCard.restoreTitle')}
                            >
                              {isRestoring ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <RotateCcw className="w-4 h-4" />
                              )}
                            </Button>
                          </DisabledReason>
                          <DisabledReason reason={!canDownloadBackups ? t('permissions.noDownload') : null}>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => { if (canDownloadBackups) backupApi.downloadBackup(backup.name) }}
                              disabled={!canDownloadBackups}
                              className="h-9 w-9"
                              aria-label={t('mainCard.downloadAria', { name: backup.name })}
                              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                              title={t('mainCard.downloadTitle')}
                            >
                              <Download className="w-4 h-4" />
                            </Button>
                          </DisabledReason>
                          <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : null}>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setDeleteDialog({ open: true, names: [backup.name] })}
                              disabled={deletingBackups || !canManageBackups || serverChangedSinceLoad}
                              className="h-9 w-9 text-destructive hover:text-destructive hover:bg-destructive/10"
                              aria-label={t('mainCard.deleteAria', { name: backup.name })}
                              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                              title={t('mainCard.deleteTitle')}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </DisabledReason>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </ScrollArea>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={snapshotDialog !== null} onOpenChange={(open) => !open && setSnapshotDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('snapshotDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>{snapshotDialog?.name}</AlertDialogDescription>
          </AlertDialogHeader>
          {snapshotDialog && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
                <span>{t('snapshotDialog.serverLabel')}</span><span className="text-foreground">{snapshotDialog.snapshot.server.name}</span>
                <span>{t('snapshotDialog.providerLabel')}</span><span className="text-foreground">{snapshotDialog.snapshot.server.provider}</span>
                <span>{t('snapshotDialog.capturedLabel')}</span><span className="text-foreground">{new Date(snapshotDialog.snapshot.createdAt).toLocaleString(i18n.language)}</span>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">{t('snapshotDialog.serverIniLabel')}</p>
                <pre className="max-h-36 overflow-auto rounded border border-border/60 bg-muted/20 p-2 text-xs">{Object.entries(snapshotDialog.snapshot.serverIni).map(([key, value]) => `${key}=${value}`).join('\n') || t('snapshotDialog.noSettings')}</pre>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">{t('snapshotDialog.sandboxLabel')}</p>
                <pre className="max-h-36 overflow-auto rounded border border-border/60 bg-muted/20 p-2 text-xs">{Object.entries(snapshotDialog.snapshot.sandboxVars).map(([key, value]) => `${key}=${value}`).join('\n') || t('snapshotDialog.noSettings')}</pre>
              </div>
            </div>
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
                <div className="flex items-center gap-3">
                  <Label htmlFor="delete-days" className="text-foreground whitespace-nowrap">{t('deleteOlderDialog.olderThanLabel')}</Label>
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
    </div>
  )
}
