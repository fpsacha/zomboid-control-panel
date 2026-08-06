import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
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
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { useTranslation } from 'react-i18next'


import { useSocket } from '@/contexts/SocketContext'
import { backupApi, serversApi, BackupStatus, BackupFile } from '@/lib/api'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/PageHeader'
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
  const { t } = useTranslation('backups')
  
  
  
  
  
  const { toast } = useToast()
  const socket = useSocket()

  // Refs for cleanup
  const progressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // State
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null)
  const [backups, setBackups] = useState<BackupFile[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creatingBackup, setCreatingBackup] = useState(false)
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null)
  const [deletingBackups, setDeletingBackups] = useState(false)
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null)
  const [uploadingBackup, setUploadingBackup] = useState(false)
  const [uploadPercent, setUploadPercent] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Active server context 鈥?backups don't apply to remote servers because
  // the panel can't reach the remote filesystem. We fetch this on mount
  // and refresh when the server-changed socket event fires (handled via
  // socket effect below) so the banner / button-disable stays accurate.
  const [activeServerRemote, setActiveServerRemote] = useState(false)

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

  // Fetch functions
  const fetchBackupStatus = useCallback(async () => {
    try {
      const status = await backupApi.getStatus()
      setBackupStatus(status)
      setBackupSchedule(status.schedule)
      setBackupMaxCount(status.maxBackups)
      setLoadError(null)
    } catch {
      setLoadError(t('messages.loadStatusFailed'))
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
    } catch {
      setLoadError(t('messages.loadBackupsFailed'))
    }
  }, [t])

  const refreshAll = useCallback(async () => {
    setLoading(true)
    try {
      await Promise.all([
        fetchBackupStatus(),
        fetchBackups(),
        // Active server may change between visits to this page 鈥?always re-check.
        serversApi.getResolvedActive()
          .then(({ server }) => setActiveServerRemote(!!server?.isRemote))
          .catch(() => setActiveServerRemote(false)),
      ])
    } finally {
      setLoading(false)
    }
  }, [fetchBackupStatus, fetchBackups])

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

  // Actions
  const handleCreateBackup = async () => {
    setCreatingBackup(true)
    setBackupProgress({ phase: 'preparing', percent: 0, message: t('messages.startingBackup') })
    try {
      const result = await backupApi.createBackup()
      if (result.success && result.backup) {
        toast({
          title: t('messages.safehouseSnapshotCreatedTitle'),
          description: t('messages.storedBackup', { name: result.backup.name, duration: result.duration?.toFixed(1) }),
          variant: 'success' as const,
        })
        await fetchBackups()
        await fetchBackupStatus()
      } else {
        throw new Error(result.message || t('messages.createFailed'))
      }
    } catch (error) {
      toast({
        title: t('messages.backupFailedTitle'),
        description: error instanceof Error ? error.message : t('messages.createFailed'),
        variant: 'destructive',
      })
      setBackupProgress({ phase: 'error', percent: 0, message: t('messages.backupFailedProgress') })
    } finally {
      setCreatingBackup(false)
    }
  }

  // Upload an existing .zip from the user's machine into the backups folder.
  // The file gets stored with an "uploaded-" prefix and shows up in the list
  // alongside scheduled backups; the user then clicks Restore to apply it.
  const handleUploadFile = async (file: File) => {
    if (!file) return
    if (activeServerRemote) {
      toast({ title: t('messages.remoteUnavailableTitle'), description: t('messages.remoteUploadDescription'), variant: 'destructive' })
      return
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      toast({ title: t('messages.invalidFileTitle'), description: t('messages.onlyZipDescription'), variant: 'destructive' })
      return
    }
    // Hard cap matches the server-side express.raw limit (4 GB). Anything
    // larger would upload for minutes and then 413 鈥?fail fast instead.
    const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024
    if (file.size > MAX_UPLOAD_BYTES) {
      toast({ title: t('messages.fileTooLargeTitle'), description: t('messages.fileTooLargeDescription', { size: (file.size / (1024 * 1024 * 1024)).toFixed(2) }), variant: 'destructive' })
      return
    }
    if (file.size === 0) {
      toast({ title: t('messages.emptyFileTitle'), description: t('messages.emptyFileDescription'), variant: 'destructive' })
      return
    }
    setUploadingBackup(true)
    setUploadPercent(0)
    try {
      const result = await backupApi.uploadBackup(file, setUploadPercent)
      toast({
        title: t('messages.backupUploadedTitle'),
        description: t('messages.storedAsDescription', { name: result.name }),
        variant: 'success' as const,
      })
      await fetchBackups()
      await fetchBackupStatus()
    } catch (error) {
      toast({
        title: t('messages.uploadFailedTitle'),
        description: error instanceof Error ? error.message : t('messages.uploadFailed'),
        variant: 'destructive',
      })
    } finally {
      setUploadingBackup(false)
      setUploadPercent(0)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleRestoreBackup = async (name: string) => {
    setRestoreDialog({ open: false, backupName: null })
    setRestoringBackup(name)
    try {
      const result = await backupApi.restoreBackup(name, { createPreRestoreBackup: true })
      if (result.success) {
        toast({
          title: t('messages.recoveryPointRestoredTitle'),
          description: t('messages.rolledBackDescription', { name, duration: (result.duration || 0).toFixed(1) }),
          variant: 'success' as const,
        })
        await fetchBackups()
      } else {
        throw new Error(result.message || t('messages.restoreFailed'))
      }
    } catch (error) {
      toast({
        title: t('messages.restoreFailedTitle'),
        description: error instanceof Error ? error.message : t('messages.restoreFailed'),
        variant: 'destructive',
      })
    } finally {
      setRestoringBackup(null)
    }
  }

  const handleDeleteBackups = async (names: string[]) => {
    setDeleteDialog({ open: false, names: [] })
    setDeletingBackups(true)
    try {
      let successCount = 0
      let failCount = 0
      for (const name of names) {
        try {
          const result = await backupApi.deleteBackup(name)
          if (result.success) {
            successCount++
          } else {
            failCount++
          }
        } catch {
          failCount++
        }
      }

      if (successCount > 0) {
        toast({
          title: t('messages.oldSnapshotsClearedTitle'),
          description: t('messages.removedBackups', { count: successCount }) + (failCount > 0 ? t('messages.failuresSuffix', { count: failCount }) : ''),
          variant: 'success' as const,
        })
      }
      if (failCount > 0 && successCount === 0) {
        toast({
          title: t('messages.deleteFailedTitle'),
          description: t('messages.failedToDeleteBackups', { count: failCount }),
          variant: 'destructive',
        })
      }

      setSelectedBackups(new Set())
      await fetchBackups()
    } catch (error) {
      toast({
        title: t('messages.deleteFailedTitle'),
        description: error instanceof Error ? error.message : t('messages.deleteFailed'),
        variant: 'destructive',
      })
    } finally {
      setDeletingBackups(false)
    }
  }

  const handleDeleteOlderThan = async () => {
    setDeleteOlderDialog(false)
    setDeletingOlder(true)
    try {
      const result = await backupApi.deleteOlderThan(deleteOlderDays)
      if (result.success) {
        toast({
          title: t('messages.oldBackupsRemovedTitle'),
          description: result.message || t('messages.removedAgingBackups', { count: result.deleted || 0 }),
          variant: 'success' as const,
        })
        await fetchBackups()
      } else {
        toast({
          title: t('messages.deleteFailedTitle'),
          description: result.message || t('messages.failedToDeleteOldBackups'),
          variant: 'destructive',
        })
      }
    } catch (error) {
      toast({
        title: t('messages.deleteFailedTitle'),
        description: error instanceof Error ? error.message : t('messages.failedToDeleteOldBackups'),
        variant: 'destructive',
      })
    } finally {
      setDeletingOlder(false)
    }
  }

  const handleSaveSettings = async () => {
    setSavingSettings(true)
    try {
      await backupApi.updateSettings({
        enabled: backupStatus?.enabled || false,
        schedule: backupSchedule,
        maxBackups: backupMaxCount,
      })
      await fetchBackupStatus()
      toast({
        title: t('messages.backupPlanUpdatedTitle'),
        description: t('messages.backupPlanUpdatedDescription'),
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('messages.backupPlanUpdateFailedTitle'),
        description: error instanceof Error ? error.message : t('messages.saveSettingsFailed'),
        variant: 'destructive',
      })
    } finally {
      setSavingSettings(false)
    }
  }

  const toggleBackupEnabled = async (enabled: boolean) => {
    try {
      await backupApi.updateSettings({ enabled })
      await fetchBackupStatus()
      toast({
        title: enabled ? t('messages.automaticSnapshotsArmedTitle') : t('messages.automaticSnapshotsStoodDownTitle'),
        description: enabled ? t('messages.recurringBackupActive') : t('messages.recurringBackupPaused'),
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('messages.automaticBackupUpdateFailedTitle'),
        description: error instanceof Error ? error.message : t('messages.updateSettingsFailed'),
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
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  // Translate the small set of cron presets we expose into a human label.
  // Falls back to the raw cron string for anything custom so the user
  // still gets meaningful information without us shipping a full parser.
  const describeSchedule = (cron: string | undefined): string => {
    if (!cron) return t('schedule.none')
    const map: Record<string, string> = {
      '*/15 * * * *': t('every15Minutes'),
      '*/30 * * * *': t('every30Minutes'),
      '0 * * * *': t('everyHour'),
      '0 */2 * * *': t('every2Hours'),
      '0 */4 * * *': t('every4Hours'),
      '0 */6 * * *': t('every6Hours'),
      '0 */8 * * *': t('every8Hours'),
      '0 */12 * * *': t('every12Hours'),
      '0 0 * * *': t('dailyAtMidnight'),
      '0 6 * * *': t('dailyAt6Am'),
      '0 12 * * *': t('dailyAtNoon'),
      '0 18 * * *': t('dailyAt6Pm'),
    }
    return map[cron] || cron
  }

  const totalSize = useMemo(() => {
    return backups.reduce((sum, b) => sum + b.size, 0)
  }, [backups])

  const isAnySelected = selectedBackups.size > 0
  const allSelected = backups.length > 0 && selectedBackups.size === backups.length

  return (
    <div className="space-y-6 page-transition">
      {/* Header */}
      <PageHeader
        title={t('title')}
        description={t('pageHeader.description')}
        icon={<Archive className="w-5 h-5 text-primary" />}
        actions={
          <div className="flex items-center gap-2">
            <Button
              onClick={handleCreateBackup}
              disabled={creatingBackup || restoringBackup !== null || !backupStatus?.savesExists || activeServerRemote}
              className="gap-2"
              title={activeServerRemote ? t('ui.remoteBackupsUnavailable') : undefined}
            >
              {creatingBackup ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Archive className="w-4 h-4" />
              )}
              {creatingBackup ? t('ui.creating') : t('actions.createBackup')}
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
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingBackup || restoringBackup !== null || activeServerRemote}
              className="gap-2"
              title={activeServerRemote ? t('ui.remoteBackupsUnavailable') : t('ui.uploadExistingTitle')}
            >
              {uploadingBackup ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              {uploadingBackup ? t('ui.uploading', { percent: uploadPercent }) : t('ui.uploadZip')}
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowSettings(!showSettings)}
              className="gap-2"
            >
              <Settings className="w-4 h-4" />
              {t('ui.settings')}
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={refreshAll}
              disabled={loading}
              aria-label={t('labels.refreshStatus')}
              title={t('actions.refresh')}
            >
              <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
            </Button>
          </div>
        }
      />

      {loadError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t('backupDataUnavailable')}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={refreshAll} className="self-start sm:self-auto">
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('ui.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {activeServerRemote && (
        <Alert className="border-warning/40 bg-warning/10">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertTitle>{t('backupsDisabledForRemoteServers')}</AlertTitle>
          <AlertDescription>
            {t('ui.remoteServerDescription')}
          </AlertDescription>
        </Alert>
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
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('totalBackups')}</p>
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
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('totalSize')}</p>
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
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('lastBackup')}</p>
              <p className="text-sm font-semibold leading-tight mt-0.5 text-foreground truncate">
                {backupStatus?.lastBackup ? formatDate(backupStatus.lastBackup.created) : t('ui.never')}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div
              className={cn(
                'grid place-items-center w-10 h-10 rounded-md border shrink-0',
                backupStatus?.enabled
                  ? 'border-primary/30 bg-primary/[0.06] text-primary'
                  : 'border-border/55 bg-muted/30 text-muted-foreground'
              )}
              aria-hidden="true"
            >
              <Clock className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('autobackup')}</p>
              <p className={cn('text-sm font-semibold leading-tight mt-0.5 truncate', backupStatus?.enabled ? 'text-foreground' : 'text-muted-foreground')}>
                {backupStatus?.enabled ? t('ui.on') : t('ui.off')}
              </p>
              <p className="text-[11px] text-muted-foreground/80 truncate" title={backupStatus?.schedule || ''}>
                {backupStatus?.enabled
                  ? t('ui.scheduleSummary', { schedule: describeSchedule(backupStatus?.schedule), count: backupStatus?.maxBackups ?? '?' })
                  : t('ui.noScheduledBackups')}
              </p>
            </div>
            <Switch
              checked={backupStatus?.enabled || false}
              onCheckedChange={toggleBackupEnabled}
              aria-label={t('labels.toggleScheduled')}
            />
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
              {t('ui.backupSettings')}
            </CardTitle>
            <CardDescription>{t('configureScheduledBackupSettings')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="backup-schedule">{t('backupFrequency')}</Label>
                <Select value={backupSchedule} onValueChange={setBackupSchedule}>
                  <SelectTrigger id="backup-schedule" className="w-full">
                    <SelectValue placeholder={t('placeholders.selectFrequency')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="*/15 * * * *">{t('every15Minutes')}</SelectItem>
                    <SelectItem value="*/30 * * * *">{t('every30Minutes')}</SelectItem>
                    <SelectItem value="0 * * * *">{t('everyHour')}</SelectItem>
                    <SelectItem value="0 */2 * * *">{t('every2Hours')}</SelectItem>
                    <SelectItem value="0 */4 * * *">{t('every4Hours')}</SelectItem>
                    <SelectItem value="0 */6 * * *">{t('every6Hours')}</SelectItem>
                    <SelectItem value="0 */8 * * *">{t('every8Hours')}</SelectItem>
                    <SelectItem value="0 */12 * * *">{t('every12Hours')}</SelectItem>
                    <SelectItem value="0 0 * * *">{t('dailyAtMidnight')}</SelectItem>
                    <SelectItem value="0 6 * * *">{t('dailyAt6Am')}</SelectItem>
                    <SelectItem value="0 12 * * *">{t('dailyAtNoon')}</SelectItem>
                    <SelectItem value="0 18 * * *">{t('dailyAt6Pm')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t('ui.frequencyHelp')}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="backup-max">{t('maximumBackupsToKeep')}</Label>
                <Input
                  id="backup-max"
                  type="number"
                  min={1}
                  max={100}
                  value={backupMaxCount}
                  onChange={(e) => {
                    const parsed = parseInt(e.target.value, 10)
                    // Only update if valid number in range
                    if (!isNaN(parsed) && parsed >= 1 && parsed <= 100) {
                      setBackupMaxCount(parsed)
                    } else if (e.target.value === '') {
                      setBackupMaxCount(10) // Reset to default if cleared
                    }
                  }}
                  className="max-w-24"
                />
                <p className="text-xs text-muted-foreground">
                  {t('ui.retentionHelp')}
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 text-xs text-muted-foreground">
                {backupStatus?.savesPath && (
                  <span className="flex flex-wrap items-center gap-1 break-all">
                    <FolderOpen className="w-3 h-3" />
                    {t('ui.savesPath')}: {backupStatus.savesPath}
                  </span>
                )}
              </div>
              <Button onClick={handleSaveSettings} disabled={savingSettings} size="sm" className="h-10 gap-2 self-start sm:self-auto">
                {savingSettings && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {t('ui.saveSettings')}
              </Button>
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
                    {backupProgress?.message || t('messages.creatingBackup')}
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
              <CardTitle className="text-lg">{t('ui.backupFiles')}</CardTitle>
              {!backupStatus?.savesExists && (
                <span className="flex items-center gap-1 text-xs text-warning">
                  <AlertTriangle className="w-3 h-3" />
                  {t('ui.savesFolderNotFound')}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {isAnySelected && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setDeleteDialog({ open: true, names: Array.from(selectedBackups) })}
                  disabled={deletingBackups}
                  className="h-10 gap-2"
                >
                  <Trash2 className="w-4 h-4" />
                  {t('ui.deleteSelected', { count: selectedBackups.size })}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeleteOlderDialog(true)}
                disabled={deletingOlder || backups.length === 0}
                className="h-10 gap-2"
              >
                {deletingOlder ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Clock className="w-4 h-4" />
                )}
                {t('ui.deleteOlder')}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          ) : backups.length === 0 ? (
            <EmptyState type="noData" title={t('safety.noSafetyNet')} description={t('safety.description')} action={{ label: t('actions.createBackup'), onClick: handleCreateBackup, variant: 'default' }} />
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
                    ? t('ui.selectAll', { count: backups.length })
                    : allSelected
                      ? t('ui.allSelectedClear', { count: backups.length })
                      : t('ui.selectionOf', { selected: selectedBackups.size, total: backups.length })}
                </Label>
                {selectedBackups.size > 0 && (
                  <span className="inline-flex h-5 items-center rounded-full bg-primary/15 px-2 font-mono text-[11px] tabular-nums text-primary">
                    {selectedBackups.size}
                  </span>
                )}
              </div>

              {/* Backup List */}
              <ScrollArea className="h-[300px] sm:h-[400px]">
                <div className="space-y-2 pr-4">
                  {backups.map((backup, idx) => {
                    const isSelected = selectedBackups.has(backup.name)
                    const isRestoring = restoringBackup === backup.name
                    const isLatest = idx === 0

                    return (
                      <div
                        key={backup.name}
                        className={cn(
                          'group/backup flex items-center gap-3 p-3 rounded-lg border transition-colors',
                          isSelected
                            ? 'border-primary/40 bg-primary/[0.08]'
                            : 'bg-muted/20 border-border/40 hover:border-primary/30 hover:bg-muted/40'
                        )}
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleBackupSelection(backup.name)}
                          disabled={isRestoring}
                          aria-label={t('aria.selectBackup', { name: backup.name })}
                        />

                        {/* Leading archive tile 鈥?latest backup glows primary, others sit muted */}
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
                                {t('ui.latest')}
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

                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRestoreDialog({ open: true, backupName: backup.name })}
                            disabled={isRestoring || restoringBackup !== null || creatingBackup}
                            className="h-9 w-9 text-warning hover:text-warning hover:bg-warning/10"
                            aria-label={t('aria.restoreBackup', { name: backup.name })}
                            title={t('actions.restore')}
                          >
                            {isRestoring ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <RotateCcw className="w-4 h-4" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => backupApi.downloadBackup(backup.name)}
                            className="h-9 w-9"
                            aria-label={t('aria.downloadBackup', { name: backup.name })}
                            title={t('actions.download')}
                          >
                            <Download className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeleteDialog({ open: true, names: [backup.name] })}
                            disabled={deletingBackups}
                            className="h-9 w-9 text-destructive hover:text-destructive hover:bg-destructive/10"
                            aria-label={t('aria.deleteBackup', { name: backup.name })}
                            title={t('actions.delete')}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
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

      {/* Restore Confirmation Dialog */}
      <AlertDialog open={restoreDialog.open} onOpenChange={(open) => setRestoreDialog({ open, backupName: null })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-warning">
              <AlertTriangle className="w-5 h-5" />
              {t('dialogs.restoreTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                {t('dialogs.restoreDescription', { name: restoreDialog.backupName })}
              </p>
              <ul className="list-disc list-inside text-sm space-y-1 mt-2">
                <li>{t('stopTheServerFirst')}</li>
                <li>{t('thePanelWillCreateASafetyBackupBeforeRestoring')}</li>
                <li>{t('thisActionCannotBeUndone')}</li>
              </ul>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => restoreDialog.backupName && handleRestoreBackup(restoreDialog.backupName)}
              className="bg-warning text-warning-foreground hover:bg-warning/90"
            >
              {t('dialogs.restoreAction')}
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
              {t('dialogs.deleteTitle', { count: deleteDialog.names.length })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteDialog.names.length === 1 ? (
                <p>
                  {t('dialogs.deleteSingleDescription', { name: deleteDialog.names[0] })}
                </p>
              ) : (
                <p>
                  {t('dialogs.deleteMultipleDescription', { count: deleteDialog.names.length })}
                </p>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => handleDeleteBackups(deleteDialog.names)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('dialogs.deleteAction', { count: deleteDialog.names.length })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Older Than Dialog */}
      <AlertDialog open={deleteOlderDialog} onOpenChange={setDeleteOlderDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-warning">
              <Clock className="w-5 h-5" />
              {t('dialogs.deleteOldTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4">
                <p>{t('deleteEveryBackupOlderThanTheNumberOfDaysYouChooseHere')}</p>
                <div className="flex items-center gap-3">
                  <Label htmlFor="delete-days" className="text-foreground whitespace-nowrap">{t('deleteBackupsOlderThan')}</Label>
                  <Input
                    id="delete-days"
                    type="number"
                    min={1}
                    max={365}
                    value={deleteOlderDays}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10)
                      if (!isNaN(val) && val >= 1 && val <= 365) {
                        setDeleteOlderDays(val)
                      }
                    }}
                    className="w-20"
                  />
                  <span className="text-foreground">{t('days')}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('dialogs.deleteOldDescription', { days: deleteOlderDays })}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteOlderThan}
              className="bg-warning text-warning-foreground hover:bg-warning/90"
            >
              {t('dialogs.deleteOldAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
