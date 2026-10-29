import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import {
  Archive,
  ArrowRight,
  CalendarClock,
  Clock,
  Copy,
  Globe,
  HelpCircle,
  History,
  ListChecks,
  Loader2,
  Megaphone,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  Settings2,
  Trash2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { PageAlerts, type PageAlert } from '@/components/PageAlerts'
import { SaveBar } from '@/components/SaveBar'
import { SectionCard } from '@/components/ui/section-card'
import { StatusPill } from '@/components/ui/status-pill'
import { StatStrip, type StatStripItem } from '@/components/ui/stat-strip'
import { Segmented } from '@/components/ui/segmented'
import { RowActions } from '@/components/ui/row-actions'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useDateFormat } from '@/lib/dateFormat'
import { formatRelativeTime } from '@/lib/cronSchedule'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useToast } from '@/components/ui/use-toast'
import { schedulerApi, rconApi, serverApi, serversApi, backupApi, ScheduleHistoryEntry, ServerInstance, BackupStatus } from '@/lib/api'
import { resolveServerRunning } from '@/lib/serverStatus'
import { EmptyState } from '@/components/EmptyState'
import { NumberInput } from '@/components/NumberInput'
import { DisabledReason } from '@/components/DisabledReason'
import { HelpTip } from '@/components/HelpTip'
import { BackupRestartOverlapNotice } from '@/components/BackupRestartOverlapNotice'
import { scheduledAttemptMessage, scheduledBackupHealth } from '@/lib/scheduledBackupHealth'
import { useAuth } from '@/contexts/AuthContext'
import { cn } from '@/lib/utils'
import { TimezonePicker } from '@/components/scheduler/TimezonePicker'
import { TaskDialog } from '@/components/scheduler/TaskDialog'
import { draftFromTask, emptyTaskDraft, type CronPreset, type TaskDraft } from '@/components/scheduler/taskDraft'
import { TASK_TYPE_ICONS, getCommandSuggestions, taskTypeOfCommand, useScheduleText } from '@/components/scheduler/scheduleText'

const RESTART_WARNING_LOCALES = ['en', 'zh-CN', 'fr', 'de', 'es', 'ht', 'pt-BR'] as const
// Manual restart countdowns, in minutes, plus a custom length.
const RESTART_PRESETS = [15, 10, 5, 1, 'custom'] as const
type RestartPreset = typeof RESTART_PRESETS[number]
const QUICK_BROADCASTS = ['maintenanceStart', 'maintenanceEnd', 'saveWarning', 'welcome'] as const

interface ScheduledTask {
  id: number
  name: string
  cron_expression: string
  command: string
  server_id: string | number | null
  enabled: number
  last_run: string | null
  created_at: string
  // Computed server-side by GET /scheduler/tasks (scheduler.getTaskNextRun):
  // the live node-cron job's next fire for an enabled task. null when the
  // schedule has no upcoming run (or an old cached response).
  next_run?: string | null
}

// No pagination on this panel -- when a fetch returns exactly this many
// rows, older executions may exist and be silently excluded (server
// retains up to 500, see server/database/init.js). A hint, not a hard
// truth: hitting the limit exactly by coincidence is possible too.
const EXECUTION_HISTORY_FETCH_LIMIT = 50

// The task list's columns from md up: the task, its next run, its last run,
// then the switch and the row's actions.
const TASK_GRID = 'md:grid-cols-[minmax(0,1fr)_9.5rem_10.5rem_auto]'

export default function Scheduler() {
  const { t } = useTranslation('scheduler')
  const { formatDateTime, locale } = useDateFormat()
  const scheduleText = useScheduleText()
  const commandSuggestions = useMemo(() => getCommandSuggestions(t), [t])
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [history, setHistory] = useState<ScheduleHistoryEntry[]>([])
  const [presets, setPresets] = useState<CronPreset[]>([])
  const [servers, setServers] = useState<ServerInstance[]>([])
  // The backup-health card's last attempt comes from backup's OWN status
  // endpoint (backupApi.getStatus()), not the scheduler's.
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null)
  const [status, setStatus] = useState<{
    activeTasks: number
    autoRestartEnabled: boolean
    // The backup schedule's own next run (scheduler.getBackupNextRun()).
    backupNextRun?: string | null
    // Optional because older cached/mocked responses may predate it.
    backupScheduleEnabled?: boolean
    modUpdateRestartPending: boolean
    // `timezone` is the EFFECTIVE zone every schedule runs in right now;
    // `configuredTimezone` is the operator's saved choice (normally the
    // same). `timezoneFallback` is non-null only when the saved zone stopped
    // being valid and the panel fell back to the process default.
    timezone?: string
    configuredTimezone?: string | null
    timezoneFallback?: { configured: string; effective: string } | null
    restartWarning?: { locale: typeof RESTART_WARNING_LOCALES[number]; template: string }
    restartWarningPresets?: Record<typeof RESTART_WARNING_LOCALES[number], string>
  } | null>(null)
  const [timezoneInput, setTimezoneInput] = useState('')
  const [timezoneSaving, setTimezoneSaving] = useState(false)
  const [restartWarningLocale, setRestartWarningLocale] = useState<typeof RESTART_WARNING_LOCALES[number]>('en')
  const [restartWarningTemplate, setRestartWarningTemplate] = useState('')
  const [restartWarningSaving, setRestartWarningSaving] = useState(false)
  const restartWarningDirtyRef = useRef(false)
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const [runningTaskId, setRunningTaskId] = useState<number | null>(null)
  const [broadcastingKey, setBroadcastingKey] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [historyFilter, setHistoryFilter] = useState<'all' | 'failed'>('all')
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTask | null>(null)
  // Relative times ("in 3 hr.") move on without a refetch.
  const [now, setNow] = useState(() => Date.now())
  const { toast } = useToast()
  const { can } = useAuth()
  // POST /scheduler/restart-now is an immediate, direct restart -- it
  // requires server.control on the server (server/routes/scheduler.js),
  // the same capability POST /server/restart requires, not just
  // automation.manage (which merely gates this whole page). can() fails
  // OPEN when capabilities are unknown/null, same convention as every
  // other capability check in the app -- this only ever disables the
  // button when the answer is a confirmed no.
  const canRestartNow = can('server.control')
  // The countdown text is a server broadcast: writing one's own takes
  // server.world_events (PUT /scheduler/restart-warning). A language's
  // preset, picked below, does not.
  const canWriteRestartWarning = can('server.world_events')

  // Task dialog: one draft per open, keyed so the form starts from it.
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogKey, setDialogKey] = useState(0)
  const [draft, setDraft] = useState<TaskDraft>(() => emptyTaskDraft(''))
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null)

  // Restart form
  const [restartMinutes, setRestartMinutes] = useState(5)
  const [restartPreset, setRestartPreset] = useState<RestartPreset>(5)
  const [serverRunning, setServerRunning] = useState<boolean>(false)

  // 2026-09-08 (retry-stacking sweep): `manual` distinguishes a human
  // pressing Retry or the Execution History card's Refresh button (both
  // call this function directly) from the mount effect and every
  // post-action refetch elsewhere on this page -- see Servers.tsx's
  // fetchServers() for the full reasoning.
  const fetchData = useCallback(async (opts?: { manual?: boolean }) => {
    const retries = opts?.manual ? { retries: 0 } : undefined
    setFetchError(null)
    try {
      // Only getTasks() may fail the whole load -- the page can't work
      // without it. The others are best-effort, so a hiccup in one of them
      // can't throw away a good task list and show "no tasks scheduled".
      const [tasksData, presetsData, statusData, historyData, serversData, backupStatusData] = await Promise.all([
        schedulerApi.getTasks(retries),
        schedulerApi.getCronPresets(retries).catch(() => ({ presets: [] as CronPreset[] })),
        schedulerApi.getStatus(retries).catch(() => null),
        schedulerApi.getHistory(EXECUTION_HISTORY_FETCH_LIMIT, undefined, retries).catch(() => ({ history: [] as ScheduleHistoryEntry[] })),
        serversApi.getAll(retries).catch(() => ({ servers: [] as ServerInstance[] })),
        backupApi.getStatus().catch(() => null),
      ])
      setTasks(tasksData.tasks || [])
      setPresets(presetsData.presets || [])
      setStatus(statusData)
      // Seed the settings fields in the same render as the status they are
      // compared with: filled by an effect a render later, the SaveBar flashed
      // "Unsaved changes" on every load.
      if (statusData?.configuredTimezone) {
        const saved = statusData.configuredTimezone
        setTimezoneInput((prev) => (prev === '' ? saved : prev))
      }
      if (statusData?.restartWarning && !restartWarningDirtyRef.current) {
        setRestartWarningLocale(statusData.restartWarning.locale)
        setRestartWarningTemplate(statusData.restartWarning.template)
      }
      setHistory(historyData.history || [])
      setBackupStatus(backupStatusData)
      setServers(serversData.servers || [])
      setNow(Date.now())
    } catch (error) {
      reportClientError('Failed to fetch scheduler data.', error)
      setFetchError(getUserErrorMessage(error, t('fetchError.fallback')))
    } finally {
      setInitialLoading(false)
    }
  }, [t])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // Seeds the timezone picker's input from the operator's saved choice --
  // only while untouched, so an explicit refetch after an unrelated action
  // (creating a task, etc.) can't clobber an edit still in progress.
  useEffect(() => {
    if (timezoneInput === '' && status?.configuredTimezone) {
      setTimezoneInput(status.configuredTimezone)
    }
  }, [status?.configuredTimezone, timezoneInput])

  useEffect(() => {
    if (!restartWarningDirtyRef.current && status?.restartWarning) {
      setRestartWarningLocale(status.restartWarning.locale)
      setRestartWarningTemplate(status.restartWarning.template)
    }
  }, [status?.restartWarning])

  const handleSaveTimezone = async () => {
    const trimmed = timezoneInput.trim()
    if (!trimmed) return
    setTimezoneSaving(true)
    try {
      const result = await schedulerApi.setTimezone(trimmed)
      setStatus((prev) => (prev ? { ...prev, ...result } : prev))
      toast({
        title: t('toasts.successTitle'),
        description: t('timezone.savedDesc', { tz: result.timezone }),
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('timezone.saveFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setTimezoneSaving(false)
    }
  }

  const selectRestartWarningLocale = (locale: typeof RESTART_WARNING_LOCALES[number]) => {
    restartWarningDirtyRef.current = true
    setRestartWarningLocale(locale)
    setRestartWarningTemplate(status?.restartWarningPresets?.[locale] || '')
  }

  const resetRestartWarningTemplate = () => {
    restartWarningDirtyRef.current = true
    setRestartWarningTemplate(status?.restartWarningPresets?.[restartWarningLocale] || '')
  }

  const handleSaveRestartWarning = async () => {
    if (!restartWarningTemplate.trim()) return
    setRestartWarningSaving(true)
    try {
      const result = await schedulerApi.setRestartWarning({
        locale: restartWarningLocale,
        template: restartWarningTemplate,
      })
      restartWarningDirtyRef.current = false
      setRestartWarningTemplate(result.restartWarning.template)
      setStatus((previous) => previous
        ? { ...previous, restartWarning: result.restartWarning }
        : previous)
      toast({
        title: t('toasts.successTitle'),
        description: t('restartWarning.saved'),
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('restartWarning.saveFailed')),
        variant: 'destructive',
      })
    } finally {
      setRestartWarningSaving(false)
    }
  }

  // Poll server status so Manual Restart / Quick Broadcasts stay accurate.
  // Skipped while the tab is hidden to avoid pointless work in background tabs.
  //
  // GH#114-shaped (2026-09-08): a raw local process scan can't see a
  // docker-managed or remote server's process, which left these actions
  // disabled on a server that was genuinely up. resolveServerRunning()
  // shares ServerConfig.tsx's provider-aware fix; null (indeterminate) is
  // treated as "may be running" -- restarting an already-stopped server or
  // broadcasting to an unconnected RCON just fails cleanly server-side.
  useEffect(() => {
    let cancelled = false
    const pull = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const activeServer = servers.find((s) => s.isActive) ?? null
      const running = await resolveServerRunning(activeServer, serverApi.getStatus, serversApi.getComposedStatus)
      if (!cancelled) setServerRunning(running !== false)
    }
    pull()
    const id = setInterval(pull, 15000)
    return () => { cancelled = true; clearInterval(id) }
  }, [servers])

  // A task's own `last_run` column is only written on the SUCCESS path of
  // runTaskNow() -- a failed or refused run never touches it, so a failing
  // task could sit there with a stale "Last run" and no sign anything is
  // wrong. Execution History rows ARE written on every outcome, so the
  // latest one per task_id says what actually happened last. A task whose
  // last attempt fell outside the fetched window falls back to `last_run`.
  const latestRunByTaskId = useMemo(() => {
    const map = new Map<number, ScheduleHistoryEntry>()
    for (const entry of history) {
      if (entry.task_id == null) continue
      const existing = map.get(entry.task_id)
      if (!existing || new Date(entry.executed_at).getTime() > new Date(existing.executed_at).getTime()) {
        map.set(entry.task_id, entry)
      }
    }
    return map
  }, [history])

  // A task's target server name: "Unknown server" if it was deleted since
  // the task was created, nothing if server_id is unset (legacy tasks).
  const getServerLabel = (serverId: string | number | null): string | null => {
    if (!serverId) return null
    const match = servers.find((s) => String(s.id) === String(serverId))
    return match ? (match.name || match.serverName || `Server ${serverId}`) : t('scheduledTasks.unknownServer')
  }

  // New tasks target the active server: a task with no target follows
  // whichever server is active when it fires, not the one the operator meant.
  const defaultServerId = () => {
    const active = servers.find((s) => s.isActive)
    return active ? String(active.id) : (servers[0] ? String(servers[0].id) : '')
  }

  const openTaskDialog = (next: TaskDraft, task: ScheduledTask | null) => {
    setEditingTask(task)
    setDraft(next)
    setDialogKey((key) => key + 1)
    setDialogOpen(true)
  }
  const openNewTask = (overrides: Partial<TaskDraft> = {}) =>
    openTaskDialog({ ...emptyTaskDraft(defaultServerId()), ...overrides }, null)
  const handleEditTask = (task: ScheduledTask) => openTaskDialog(draftFromTask(task), task)
  const handleDuplicateTask = (task: ScheduledTask) =>
    openTaskDialog(draftFromTask(task, t('rows.copyName', { name: task.name }).slice(0, 100)), null)

  const handleToggleTask = async (task: ScheduledTask) => {
    setLoading(true)
    try {
      await schedulerApi.updateTask(
        task.id,
        task.name,
        task.cron_expression,
        task.command,
        !task.enabled,
        task.server_id != null ? task.server_id : undefined
      )
      toast({
        title: t('toasts.successTitle'),
        description: task.enabled ? t('toasts.taskDisabled') : t('toasts.taskEnabled'),
        variant: 'success' as const,
      })
      fetchData()
    } catch (error) {
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('toasts.taskUpdateFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteTask = async (taskId: number) => {
    setLoading(true)
    try {
      await schedulerApi.deleteTask(taskId)
      toast({
        title: t('toasts.successTitle'),
        description: t('toasts.taskDeleted'),
        variant: 'success' as const,
      })
      fetchData()
    } catch (error) {
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('toasts.taskDeleteFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleRunNow = async (task: ScheduledTask) => {
    if (runningTaskId !== null) return // Prevent double-click
    setRunningTaskId(task.id)
    try {
      // Goes through the same restart/save/servermsg/bridge: dispatch as a
      // cron fire, instead of sending task.command to RCON as a raw string.
      await schedulerApi.runTask(task.id)
      toast({
        title: t('toasts.taskTriggeredTitle'),
        description: t('toasts.taskTriggeredDesc', { name: task.name }),
        variant: 'success' as const,
      })
      fetchData() // Refresh to update history
    } catch (error) {
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('toasts.taskRunFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setRunningTaskId(null)
    }
  }

  // One path for every countdown, preset or custom. The custom field's
  // min/max are only native <input> attributes and the server caps the
  // countdown at 60, so the toast reports the countdown the server actually
  // applied, not the one asked for.
  const handleRestart = async (minutes: number) => {
    setLoading(true)
    try {
      const result = await schedulerApi.restartNow(minutes)
      const applied = result.warningMinutes
      if (applied !== minutes) {
        toast({
          title: t('toasts.restartInitiatedTitle'),
          description: t('toasts.restartMinutesClampedDesc', { requested: minutes, applied }),
          variant: 'warning' as const,
        })
      } else {
        toast({
          title: t('toasts.restartInitiatedTitle'),
          // Pluralized key: i18next resolves _one/_other only from `count`.
          description: t('toasts.restartInitiatedWithWarningsDesc', { count: applied, minutes: applied }),
          variant: 'success' as const,
        })
      }
    } catch (error) {
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('toasts.restartFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleBroadcast = async (key: string, message: string) => {
    setBroadcastingKey(key)
    try {
      await rconApi.execute(`servermsg "${message}"`)
      toast({
        title: t('toasts.broadcastSentTitle'),
        description: message,
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('toasts.broadcastFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setBroadcastingKey(null)
    }
  }

  const handleClearHistory = async () => {
    setLoading(true)
    try {
      await schedulerApi.clearHistory()
      setHistory([])
      toast({
        title: t('toasts.successTitle'),
        description: t('toasts.historyClearedDesc'),
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('toasts.historyClearFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const restartCountdown = restartPreset === 'custom' ? restartMinutes : restartPreset
  const restartBlocked = loading || !serverRunning || !canRestartNow
  // An emptied custom field is NaN until it's filled in again.
  const restartButtonLabel = Number.isFinite(restartCountdown)
    ? t('manualRestart.confirmShortRestart', { count: restartCountdown })
    : t('manualRestart.customCountdownLabel')
  const activeTaskCount = tasks.filter((task) => task.enabled).length
  const focusField = (id: string) => {
    const field = document.getElementById(id)
    if (!field) return
    field.scrollIntoView({ block: 'center' })
    field.focus({ preventScroll: true })
  }
  const focusRestartWarningTemplate = () => focusField('restart-warning-template')

  // Settings card: the timezone and the restart warning are two small forms
  // with one Save, the SaveBar at the bottom of the page.
  const timezoneDirty = !!status && timezoneInput.trim() !== (status.configuredTimezone ?? '')
  const restartWarningBaseline = status?.restartWarning ?? { locale: 'en' as const, template: '' }
  const restartWarningDirty = !!status && (
    restartWarningLocale !== restartWarningBaseline.locale || restartWarningTemplate !== restartWarningBaseline.template
  )
  const settingsDirty = timezoneDirty || restartWarningDirty
  const settingsSaving = timezoneSaving || restartWarningSaving
  const settingsDisabledReason = timezoneDirty && !timezoneInput.trim()
    ? t('timezone.emptyReason')
    : restartWarningDirty && !restartWarningTemplate.trim()
      ? t('restartWarning.emptyReason')
      : undefined
  const saveSettings = async () => {
    if (timezoneDirty) await handleSaveTimezone()
    if (restartWarningDirty) await handleSaveRestartWarning()
  }
  const discardSettings = () => {
    setTimezoneInput(status?.configuredTimezone ?? '')
    restartWarningDirtyRef.current = false
    setRestartWarningLocale(restartWarningBaseline.locale)
    setRestartWarningTemplate(restartWarningBaseline.template)
  }

  const pageAlerts: PageAlert[] = []
  if (fetchError) {
    pageAlerts.push({
      id: 'fetch-error',
      tone: 'error',
      title: t('fetchError.title'),
      description: <span className="break-words" dir="auto">{fetchError}</span>,
      action: { label: t('fetchError.retry'), onClick: () => fetchData({ manual: true }) },
    })
  }
  if (status?.timezoneFallback) {
    pageAlerts.push({
      id: 'timezone-fallback',
      tone: 'error',
      title: t('timezone.fallbackTitle'),
      description: t('timezone.fallbackDesc', {
        configured: status.timezoneFallback.configured,
        effective: status.timezoneFallback.effective,
      }),
      action: { label: t('timezone.fallbackAction'), onClick: () => focusField('scheduler-timezone-input') },
    })
  }

  // --- What the page says at a glance -------------------------------------

  const historyName = (entry: ScheduleHistoryEntry) =>
    entry.task_name_key
      ? t(`executionHistory.systemTasks.${entry.task_name_key}`, { defaultValue: entry.task_name })
      : entry.task_name

  const upcomingTask = tasks
    .filter((task) => task.enabled && task.next_run)
    .sort((a, b) => Date.parse(a.next_run as string) - Date.parse(b.next_run as string))[0]
  const lastEntry = history.reduce<ScheduleHistoryEntry | null>(
    (latest, entry) => (!latest || Date.parse(entry.executed_at) > Date.parse(latest.executed_at) ? entry : latest),
    null,
  )
  const backupAttempt = backupStatus?.lastScheduledBackupAttempt ?? null
  const backupHealth = scheduledBackupHealth(status?.backupScheduleEnabled, backupAttempt)

  const overview: StatStripItem[] = [
    {
      id: 'active',
      label: t('statusTiles.activeTasks'),
      icon: ListChecks,
      value: activeTaskCount,
      detail: t('overview.ofTotal', { total: tasks.length }),
    },
    {
      id: 'next',
      label: t('rows.colNext'),
      icon: CalendarClock,
      value: upcomingTask ? formatRelativeTime(upcomingTask.next_run, locale, now) : '—',
      detail: upcomingTask
        ? <span title={formatDateTime(upcomingTask.next_run)}>{upcomingTask.name}</span>
        : t('overview.nothingScheduled'),
    },
    {
      id: 'last',
      label: t('rows.colLast'),
      icon: lastEntry ? (lastEntry.success ? CheckCircle2 : XCircle) : History,
      tone: lastEntry ? (lastEntry.success ? 'success' : 'danger') : 'default',
      value: lastEntry ? (lastEntry.success ? t('executionHistory.succeeded') : t('executionHistory.failed')) : '—',
      detail: lastEntry
        ? <span title={formatDateTime(lastEntry.executed_at, { seconds: true })}>{`${historyName(lastEntry)} · ${formatRelativeTime(lastEntry.executed_at, locale, now)}`}</span>
        : t('overview.noRuns'),
    },
    {
      id: 'backups',
      label: t('overview.backups'),
      icon: Archive,
      to: '/backups?panel=schedule',
      tone: !status?.backupScheduleEnabled ? 'default' : backupHealth === 'failing' ? 'danger' : backupHealth === 'skippedForRestart' ? 'warning' : 'success',
      value: status?.backupScheduleEnabled ? t('overview.on') : t('overview.off'),
      detail: status?.backupScheduleEnabled
        ? status.backupNextRun ? t('overview.backupNext', { when: formatRelativeTime(status.backupNextRun, locale, now) }) : t('overview.backupsManaged')
        : t('overview.backupsSetUp'),
    },
  ]

  // A task's action in a few words: the type for restart and save, the
  // message for a broadcast, the suggestion's name or the raw command.
  const describeTaskAction = (command: string) => {
    const kind = taskTypeOfCommand(command)
    if (kind.type === 'restart') return { type: kind.type, text: t('commands.restartServer'), mono: false }
    if (kind.type === 'save') return { type: kind.type, text: t('commands.saveWorld'), mono: false }
    if (kind.type === 'broadcast') return { type: kind.type, text: kind.message, mono: false }
    const known = commandSuggestions.find((suggestion) => suggestion.value === command)
    return known ? { type: kind.type, text: known.label, mono: false } : { type: kind.type, text: command, mono: true }
  }

  const quickStarts = [
    { id: 'dailyRestart', icon: RotateCcw, cron: '0 6 * * *', draft: { type: 'restart' as const, name: t('presets.dailyRestart'), nameAuto: false, mode: 'daily' as const, time: '06:00' } },
    { id: 'hourlySave', icon: Save, cron: '0 * * * *', draft: { type: 'save' as const, name: t('presets.hourlySave'), nameAuto: false, mode: 'interval' as const, everyHours: '1' } },
    { id: 'restartNotice', icon: Megaphone, cron: '50 5 * * *', draft: { type: 'broadcast' as const, name: t('presets.restartNotice'), nameAuto: false, message: t('presets.restartNoticeMessage'), mode: 'daily' as const, time: '05:50' } },
  ]

  const failedCount = history.filter((entry) => !entry.success).length
  const visibleHistory = historyFilter === 'failed' ? history.filter((entry) => !entry.success) : history
  const multipleServers = servers.length > 1

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
        status={status?.modUpdateRestartPending
          ? <StatusPill size="sm" tone="warn" label={t('scheduledTasks.modUpdatePending')} />
          : undefined}
        meta={status?.timezone ? (
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{t('pageHeader.timezoneMeta', { tz: status.timezone })}</span>
            <button
              type="button"
              onClick={() => focusField('scheduler-timezone-input')}
              className="rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('pageHeader.changeTimezone')}
            </button>
          </span>
        ) : undefined}
        actions={
          // The form defaults its target server from the loaded list: opened
          // before that, an untouched dialog claimed unsaved edits.
          <Button variant="command" size="sm" onClick={() => openNewTask()} disabled={initialLoading}>
            <Plus aria-hidden="true" />
            {t('pageHeader.newTask')}
          </Button>
        }
      />

      <TaskDialog
        key={dialogKey}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        draft={draft}
        editingTask={editingTask}
        servers={servers}
        presets={presets}
        timezone={status?.timezone}
        backupScheduleEnabled={status?.backupScheduleEnabled}
        backupNextRun={status?.backupNextRun}
        onSaved={() => { void fetchData() }}
      />

      {initialLoading ? (
        <div aria-busy="true" className="space-y-6">
          <Skeleton className="h-20 w-full rounded-xl" />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <Skeleton className="h-72 w-full rounded-xl" />
            <Skeleton className="h-72 w-full rounded-xl" />
          </div>
        </div>
      ) : (
        <>
          <PageAlerts alerts={pageAlerts} />

          <StatStrip items={overview} />

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
            {/* The page's own subject: what runs when, and what ran. */}
            <div className="min-w-0 space-y-6">
              <SectionCard
                title={t('scheduledTasks.title')}
                description={t('scheduledTasks.description')}
                flush={tasks.length > 0}
              >
                {tasks.length === 0 ? (
                  <div className="space-y-5">
                    <EmptyState
                      compact
                      type="noSchedule"
                      title={t('scheduledTasks.emptyTitle')}
                      description={t('scheduledTasks.emptyDesc')}
                      action={{ label: t('scheduledTasks.emptyActionLabel'), onClick: () => openNewTask() }}
                    />
                    <div className="space-y-2 border-t border-border/40 pt-4">
                      <h3 className="text-sm font-medium">{t('presets.heading')}</h3>
                      <p className="text-xs text-muted-foreground">{t('presets.description')}</p>
                      <ul className="grid gap-2 pt-1 sm:grid-cols-2">
                        {quickStarts.map((quick) => {
                          const Icon = quick.icon
                          return (
                            <li key={quick.id}>
                              <button
                                type="button"
                                onClick={() => openNewTask(quick.draft)}
                                className="group flex w-full items-center gap-3 rounded-lg border border-border/60 bg-muted/25 p-3 text-start transition-colors hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                                <span className="min-w-0 flex-1">
                                  <span className="block text-sm font-medium text-foreground">{quick.draft.name}</span>
                                  <span className="block truncate text-xs text-muted-foreground">{scheduleText.describeCron(quick.cron)}</span>
                                </span>
                                <Plus className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary" aria-hidden="true" />
                              </button>
                            </li>
                          )
                        })}
                        <li>
                          <Link
                            to="/backups?panel=schedule"
                            className="group flex w-full items-center gap-3 rounded-lg border border-border/60 bg-muted/25 p-3 text-start transition-colors hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Archive className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium text-foreground">{t('presets.backups')}</span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {status?.backupScheduleEnabled ? t('presets.backupsOn') : t('presets.backupsOff')}
                              </span>
                            </span>
                            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary rtl:-scale-x-100" aria-hidden="true" />
                          </Link>
                        </li>
                      </ul>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div aria-hidden="true" className={cn('hidden gap-x-4 border-b border-border/60 px-5 py-2 md:grid', TASK_GRID)}>
                      <span className="label-micro">{t('rows.colTask')}</span>
                      <span className="label-micro">{t('rows.colNext')}</span>
                      <span className="label-micro">{t('rows.colLast')}</span>
                      <span className="label-micro text-end">{t('rows.colOn')}</span>
                    </div>
                    <ul className="divide-y divide-border/60">
                      {tasks.map((task) => {
                        const action = describeTaskAction(task.command)
                        const TypeIcon = TASK_TYPE_ICONS[action.type]
                        const schedule = scheduleText.describeCron(task.cron_expression)
                        const serverLabel = getServerLabel(task.server_id)
                        const showServer = serverLabel && (multipleServers || !servers.some((s) => String(s.id) === String(task.server_id)))
                        const latestRun = latestRunByTaskId.get(task.id)
                        const running = runningTaskId === task.id
                        const lastAt = latestRun?.executed_at ?? task.last_run
                        const lastOk = latestRun ? !!latestRun.success : true
                        const failReason = latestRun && !latestRun.success
                          ? latestRun.message || t('scheduledTasks.lastRunFailedUnknownReason')
                          : null
                        const nextRun = task.enabled && task.next_run ? task.next_run : null
                        return (
                          <li
                            key={task.id}
                            className={cn(
                              'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-3 px-5 py-3.5 md:items-center',
                              TASK_GRID,
                              !task.enabled && 'bg-muted/20',
                            )}
                          >
                            <div className="flex min-w-0 items-start gap-3">
                              <span
                                className={cn(
                                  'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border',
                                  task.enabled ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border/60 bg-muted/30 text-muted-foreground',
                                )}
                                aria-hidden="true"
                              >
                                <TypeIcon className="h-4 w-4" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                  <h3 className={cn('min-w-0 truncate text-sm font-medium', task.enabled ? 'text-foreground' : 'text-muted-foreground')}>
                                    {task.name}
                                  </h3>
                                  {showServer && (
                                    <span
                                      className="max-w-[140px] shrink-0 truncate rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-xs text-muted-foreground"
                                      title={t('scheduledTasks.targetServerTitle', { server: serverLabel })}
                                    >
                                      {serverLabel}
                                    </span>
                                  )}
                                </div>
                                <p className={cn('mt-0.5 truncate text-sm', task.enabled ? 'text-foreground/90' : 'text-muted-foreground')}>
                                  {schedule ?? (
                                    <code className="font-mono text-xs" dir="ltr" title={task.cron_expression}>{task.cron_expression}</code>
                                  )}
                                </p>
                                <p className="truncate text-xs text-muted-foreground" title={task.command}>
                                  {action.mono ? (
                                    <code className="font-mono" dir="ltr">{action.text}</code>
                                  ) : (
                                    <span dir="auto">{action.text}</span>
                                  )}
                                </p>
                              </div>
                            </div>

                            {/* Next and last run: two columns of their own from
                                md up, side by side under the task on phones. */}
                            <div className="col-span-2 grid grid-cols-2 gap-4 md:contents">
                              <div className="min-w-0 text-sm">
                                {nextRun && (
                                  <span className="sr-only">{t('scheduledTasks.nextRun', { date: formatDateTime(nextRun, { seconds: true }) })}</span>
                                )}
                                <div aria-hidden="true" className="flex min-w-0 flex-col">
                                  <span className="label-micro md:hidden">{t('rows.colNext')}</span>
                                  {nextRun ? (
                                    <>
                                      <span className="truncate text-foreground">{formatRelativeTime(nextRun, locale, now)}</span>
                                      <span className="truncate text-xs text-muted-foreground">{formatDateTime(nextRun)}</span>
                                    </>
                                  ) : (
                                    <span className="text-muted-foreground">{task.enabled ? '—' : t('rows.paused')}</span>
                                  )}
                                </div>
                              </div>
                              <div className="min-w-0 text-sm">
                                {running ? (
                                  <StatusPill size="sm" tone="busy" label={t('rows.running')} />
                                ) : lastAt ? (
                                  <>
                                    <span className="sr-only">
                                      {failReason
                                        ? t('scheduledTasks.lastRunFailed', { date: formatDateTime(lastAt, { seconds: true }), reason: failReason })
                                        : t('scheduledTasks.lastRun', { date: formatDateTime(lastAt, { seconds: true }) })}
                                    </span>
                                    <div aria-hidden="true" className="flex min-w-0 flex-col" title={failReason ?? formatDateTime(lastAt, { seconds: true })}>
                                      <span className="label-micro md:hidden">{t('rows.colLast')}</span>
                                      <span className="flex min-w-0 items-center gap-1.5 text-foreground">
                                        {lastOk ? (
                                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                                        ) : (
                                          <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                                        )}
                                        <span className="truncate">{lastOk ? t('executionHistory.succeeded') : t('executionHistory.failed')}</span>
                                      </span>
                                      <span className="truncate text-xs text-muted-foreground">
                                        {formatRelativeTime(lastAt, locale, now)}
                                        {failReason && <span dir="auto">{` · ${failReason}`}</span>}
                                      </span>
                                    </div>
                                  </>
                                ) : (
                                  <div className="flex flex-col">
                                    <span className="label-micro md:hidden" aria-hidden="true">{t('rows.colLast')}</span>
                                    <span className="text-muted-foreground">{t('rows.neverRun')}</span>
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="col-start-2 row-start-1 flex items-center justify-end gap-2 md:col-start-auto md:row-start-auto">
                              <Switch
                                checked={!!task.enabled}
                                onCheckedChange={() => handleToggleTask(task)}
                                disabled={loading}
                                aria-label={t('scheduledTasks.toggleAria', { name: task.name })}
                              />
                              <RowActions
                                ariaLabel={t('rows.actionsAria', { name: task.name })}
                                primary={
                                  <Button
                                    variant="ghost"
                                    size="iconDense"
                                    onClick={() => handleEditTask(task)}
                                    disabled={loading}
                                    // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Edit task"); disables only on the page-wide loading flag, not a permission gate -- no DisabledReason-worthy reason to lose. Triaged 2026-08-27.
                                    title={t('scheduledTasks.editTitle')}
                                    aria-label={t('scheduledTasks.editAria', { name: task.name })}
                                  >
                                    <Pencil aria-hidden="true" />
                                  </Button>
                                }
                                items={[
                                  {
                                    label: t('scheduledTasks.runNowTitle'),
                                    icon: Play,
                                    onSelect: () => { void handleRunNow(task) },
                                    disabled: loading || runningTaskId !== null,
                                    reason: runningTaskId !== null ? t('rows.runBusy') : undefined,
                                  },
                                  { label: t('rows.duplicate'), icon: Copy, onSelect: () => handleDuplicateTask(task), disabled: loading },
                                  { label: t('scheduledTasks.deleteTitle'), icon: Trash2, destructive: true, onSelect: () => setDeleteTarget(task), disabled: loading },
                                ]}
                              />
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
              </SectionCard>

              <SectionCard
                density="compact"
                icon={History}
                title={t('executionHistory.title')}
                description={
                  <>
                    {t('executionHistory.description')}
                    {history.length >= EXECUTION_HISTORY_FETCH_LIMIT && (
                      <span className="block text-xs">{t('executionHistory.truncatedHint', { count: history.length })}</span>
                    )}
                  </>
                }
                actions={
                  <>
                    <Button variant="outline" size="sm" onClick={() => fetchData({ manual: true })} disabled={loading}>
                      <RefreshCw aria-hidden="true" />
                      {t('executionHistory.refresh')}
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" size="sm" disabled={loading || history.length === 0}>
                          <Trash2 aria-hidden="true" />
                          {t('executionHistory.clear')}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t('executionHistory.clearDialogTitle')}</AlertDialogTitle>
                          <AlertDialogDescription>
                            {t('executionHistory.clearDialogDesc', { count: history.length })}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t('manualRestart.cancel')}</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={handleClearHistory}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            {t('executionHistory.clearAllConfirm')}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </>
                }
              >
                {failedCount > 0 && (
                  <Segmented
                    value={historyFilter}
                    onValueChange={setHistoryFilter}
                    ariaLabel={t('executionHistory.filterAria')}
                    items={[
                      { value: 'all', label: t('executionHistory.filterAll'), count: history.length },
                      { value: 'failed', label: t('executionHistory.failed'), count: failedCount },
                    ]}
                  />
                )}
                {/* A cap, not a height: a short history leaves no empty block. */}
                <ScrollArea className="max-h-[320px] sm:max-h-[420px]">
                  {visibleHistory.length === 0 ? (
                    <EmptyState compact type="noData" title={t('executionHistory.emptyTitle')} description={t('executionHistory.emptyDesc')} />
                  ) : (
                    <ul className="divide-y divide-border/60">
                      {visibleHistory.map((entry) => (
                        <li key={entry.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 py-2.5">
                          {entry.success ? (
                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                          ) : (
                            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                          )}
                          <div className="min-w-0">
                            <p className="flex min-w-0 items-baseline gap-2">
                              <span className="sr-only">{entry.success ? t('executionHistory.succeeded') : t('executionHistory.failed')}</span>
                              <span className="truncate text-sm font-medium">{historyName(entry)}</span>
                              <code className="min-w-0 truncate font-mono text-xs text-muted-foreground" dir="ltr" title={entry.command}>
                                {entry.command}
                              </code>
                            </p>
                            {entry.message && (
                              <p className={cn('mt-0.5 break-words text-xs', entry.success ? 'text-muted-foreground' : 'text-destructive')} dir="auto">
                                {/* Translated where the panel wrote the message
                                    itself (message_key); a raw error as is. */}
                                {scheduledAttemptMessage(entry.message, entry.message_key, entry.message_params)}
                              </p>
                            )}
                          </div>
                          <div className="text-end text-xs tabular-nums text-muted-foreground">
                            <p className="whitespace-nowrap">{formatDateTime(entry.executed_at, { seconds: true })}</p>
                            {entry.duration !== null && (
                              <p className="whitespace-nowrap">{t('executionHistory.duration', { seconds: (entry.duration / 1000).toFixed(1) })}</p>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </ScrollArea>
              </SectionCard>
            </div>

            {/* Act now, then what shapes every schedule: looked at less often
                than the tasks, so they sit beside them. */}
            <div className="min-w-0 space-y-6">
              <SectionCard
                density="compact"
                icon={RotateCcw}
                title={t('manualRestart.title')}
                description={serverRunning ? t('manualRestart.descRunning') : t('manualRestart.descOffline')}
              >
                {/* One countdown choice: picking a length doesn't restart, the
                    single action below does. */}
                <fieldset className="space-y-2" disabled={restartBlocked}>
                  <legend className="text-sm font-medium">{t('manualRestart.countdownLabel')}</legend>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex flex-wrap rounded-lg border border-border/60 bg-muted/25 p-0.5">
                      {RESTART_PRESETS.map((preset) => (
                        <label key={preset} className="relative">
                          <input
                            type="radio"
                            name="restart-countdown"
                            value={preset}
                            checked={restartPreset === preset}
                            onChange={() => setRestartPreset(preset)}
                            className="peer sr-only"
                          />
                          <span className="inline-flex h-8 min-w-[3rem] cursor-pointer items-center justify-center rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground peer-checked:bg-background peer-checked:font-medium peer-checked:text-foreground peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:cursor-not-allowed peer-disabled:opacity-60 peer-disabled:hover:text-muted-foreground [@media(pointer:coarse)]:h-11">
                            {preset === 'custom'
                              ? t('manualRestart.customOption')
                              : t('manualRestart.minutesShort', { count: preset })}
                          </span>
                        </label>
                      ))}
                    </div>
                    {restartPreset === 'custom' && (
                      <NumberInput
                        id="restart-custom-minutes"
                        aria-label={t('manualRestart.customCountdownLabel')}
                        value={restartMinutes}
                        onChange={setRestartMinutes}
                        min={1}
                        max={30}
                        className="w-24"
                        onWheel={(e) => e.currentTarget.blur()}
                      />
                    )}
                  </div>
                </fieldset>
                <div className="space-y-2">
                  <DisabledReason reason={!canRestartNow ? t('manualRestart.noPermission') : null}>
                    {Number.isFinite(restartCountdown) && restartCountdown < 5 ? (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="warning" disabled={restartBlocked}>
                            <RotateCcw aria-hidden="true" />
                            {restartButtonLabel}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t('manualRestart.shortCountdownDialogTitle', { count: restartCountdown })}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {t('manualRestart.shortCountdownDialogDesc')}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t('manualRestart.cancel')}</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleRestart(restartCountdown)}
                              className="bg-warning text-warning-foreground hover:bg-warning/90"
                            >
                              {t('manualRestart.confirmShortRestart', { count: restartCountdown })}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : (
                      <Button
                        variant="warning"
                        onClick={() => handleRestart(restartCountdown)}
                        disabled={restartBlocked || !Number.isFinite(restartCountdown)}
                      >
                        <RotateCcw aria-hidden="true" />
                        {restartButtonLabel}
                      </Button>
                    )}
                  </DisabledReason>
                  <p className="text-xs text-muted-foreground">
                    {t('manualRestart.countdownWarningsNote')}{' '}
                    <button
                      type="button"
                      onClick={focusRestartWarningTemplate}
                      className="rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {t('manualRestart.editWarningMessage')}
                    </button>
                  </p>
                </div>
              </SectionCard>

              <SectionCard
                density="compact"
                icon={Send}
                title={t('quickBroadcasts.title')}
                description={serverRunning ? t('quickBroadcasts.descRunning') : t('quickBroadcasts.descOffline')}
              >
                {/* Each row shows the message players will read, so the
                    operator never sends one blind. */}
                <ul className="space-y-2">
                  {QUICK_BROADCASTS.map((key) => (
                    <li key={key}>
                      <button
                        type="button"
                        onClick={() => handleBroadcast(key, t(`broadcastMessages.${key}`))}
                        disabled={broadcastingKey !== null || loading || !serverRunning}
                        aria-labelledby={`broadcast-${key}-label`}
                        aria-describedby={`broadcast-${key}-message`}
                        // eslint-disable-next-line local/no-dead-disabled-title -- pure hint: the full message, which the row truncates. Why it's disabled (server offline) is the card's own description, and a send in flight shows its spinner.
                        title={t(`broadcastMessages.${key}`)}
                        className="group flex w-full items-center gap-3 rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-start transition-colors hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border/60 disabled:hover:bg-muted/25"
                      >
                        <span className="min-w-0 flex-1">
                          <span id={`broadcast-${key}-label`} className="block text-sm font-medium text-foreground">
                            {t(`quickBroadcasts.${key}`)}
                          </span>
                          <span id={`broadcast-${key}-message`} className="block truncate text-xs text-muted-foreground" dir="auto">
                            {t(`broadcastMessages.${key}`)}
                          </span>
                        </span>
                        {broadcastingKey === key ? (
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
                        ) : (
                          <Send className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary group-disabled:text-muted-foreground rtl:-scale-x-100" aria-hidden="true" />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </SectionCard>

              {/* Whether the automatic backup schedule is succeeding, when it
                  last tried and when it tries next. Only while backups are
                  on: an off schedule has nothing to show. The schedule itself
                  lives on Backups. */}
              {status?.backupScheduleEnabled && (
                <SectionCard
                  density="compact"
                  icon={Archive}
                  title={t('timezone.backupHealthTitle')}
                  description={t('timezone.backupHealthDesc')}
                  actions={
                    <Link
                      to="/backups?panel=schedule"
                      className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                    >
                      {t('timezone.backupHealthLink')}
                      <ArrowRight className="h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden="true" />
                    </Link>
                  }
                >
                  <div className="space-y-1">
                    {backupAttempt ? (() => {
                      const date = formatDateTime(backupAttempt.executedAt, { seconds: true })
                      // Colour from scheduledBackupHealth(), the same verdict the
                      // Dashboard and Backups page use: a restart skip is amber,
                      // a real failure red, and either is muted once a backup
                      // has succeeded since (recoveredAt).
                      const recoveredAt = backupAttempt.success ? null : backupAttempt.recoveredAt ?? null
                      const attemptText = backupAttempt.success
                        ? t('timezone.backupLastAttemptOk', { date })
                        : backupAttempt.skipReason === 'restart'
                          ? t('timezone.backupLastAttemptSkippedForRestart', { date })
                          : t('timezone.backupLastAttemptFailed', {
                              date,
                              reason: scheduledAttemptMessage(backupAttempt.message, backupAttempt.messageKey, backupAttempt.messageParams)
                                || t('scheduledTasks.lastRunFailedUnknownReason'),
                            })
                      return (
                        <>
                          <p className={cn(
                            'flex items-center gap-1.5 text-xs',
                            backupHealth === 'skippedForRestart'
                              ? 'text-warning'
                              : backupHealth === 'failing'
                                ? 'text-destructive'
                                : 'text-muted-foreground',
                          )}>
                            {backupAttempt.success ? (
                              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            ) : backupAttempt.skipReason === 'restart' ? (
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            ) : (
                              <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            )}
                            <span className="truncate" title={attemptText}>{attemptText}</span>
                          </p>
                          {/* Its own line: the failure line above truncates. */}
                          {recoveredAt && (
                            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                              <span className="truncate">
                                {t('timezone.backupRecoveredSince', { date: formatDateTime(recoveredAt, { seconds: true }) })}
                              </span>
                            </p>
                          )}
                        </>
                      )
                    })() : (
                      <p className="text-xs text-muted-foreground">{t('timezone.backupNoAttemptYet')}</p>
                    )}
                    {status.backupNextRun && (
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span className="truncate">{t('timezone.backupNextRun', { date: formatDateTime(status.backupNextRun, { seconds: true }) })}</span>
                      </p>
                    )}
                  </div>
                  {/* Restarts get scheduled here, so this is where an operator
                      stacking one on the backup schedule hears that those
                      backups wait for it. The header names the zone. */}
                  <BackupRestartOverlapNotice overlaps={backupStatus?.restartOverlaps} hideTimeZone />
                </SectionCard>
              )}

              {/* The install-wide timezone and the restart warning text: one
                  card, two parts, one Save (the SaveBar below). */}
              <SectionCard
                density="compact"
                icon={Settings2}
                title={t('settings.title')}
                description={t('settings.description')}
              >
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <h3 className="text-sm font-medium">{t('timezone.title')}</h3>
                    <HelpTip label={t('timezone.title')}>{t('timezone.description')}</HelpTip>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="scheduler-timezone-input">{t('timezone.inputLabel')}</Label>
                    <TimezonePicker
                      id="scheduler-timezone-input"
                      value={timezoneInput}
                      onChange={setTimezoneInput}
                      disabled={timezoneSaving}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('timezone.currentlyEffective', { tz: status?.timezone || '...' })}
                  </p>
                  {/* Gated on `status` so a fetch failure shows nothing here
                      rather than a misleading "off". */}
                  {status && (
                    <p className="text-xs text-muted-foreground">
                      {t('timezone.systemSchedules', {
                        backup: status.backupScheduleEnabled ? t('timezone.backupScheduleOn') : t('timezone.backupScheduleOff'),
                        autoRestart: status.autoRestartEnabled ? t('timezone.autoRestartOn') : t('timezone.autoRestartOff'),
                      })}
                    </p>
                  )}
                </div>

                <div className="space-y-3 border-t border-border/60 pt-4">
                  <div className="flex items-center gap-1.5">
                    <h3 className="text-sm font-medium">{t('restartWarning.title')}</h3>
                    <HelpTip label={t('restartWarning.title')}>{t('restartWarning.description')}</HelpTip>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="restart-warning-language">{t('restartWarning.languageLabel')}</Label>
                    <Select
                      value={restartWarningLocale}
                      onValueChange={(locale: typeof RESTART_WARNING_LOCALES[number]) => selectRestartWarningLocale(locale)}
                      disabled={restartWarningSaving}
                    >
                      <SelectTrigger id="restart-warning-language">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RESTART_WARNING_LOCALES.map((locale) => (
                          <SelectItem key={locale} value={locale}>
                            {t(`restartWarning.languages.${locale}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="restart-warning-template">{t('restartWarning.templateLabel')}</Label>
                    <Textarea
                      id="restart-warning-template"
                      value={restartWarningTemplate}
                      onChange={(event) => {
                        restartWarningDirtyRef.current = true
                        setRestartWarningTemplate(event.target.value)
                      }}
                      maxLength={300}
                      disabled={restartWarningSaving || !canWriteRestartWarning}
                    />
                    <p className="text-xs text-muted-foreground">
                      {canWriteRestartWarning ? t('restartWarning.templateHint') : t('restartWarning.templateNoPermission')}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={resetRestartWarningTemplate}
                    disabled={restartWarningSaving || !status?.restartWarningPresets?.[restartWarningLocale]}
                  >
                    {t('restartWarning.presetButton')}
                  </Button>
                </div>
              </SectionCard>

              <SectionCard collapsible defaultOpen={false} density="compact" icon={HelpCircle} title={t('cronHelp.title')}>
                <dl className="grid grid-cols-5 gap-2 text-sm">
                  {(['minute', 'hour', 'day', 'month', 'weekday'] as const).map((field) => (
                    <div key={field} className="min-w-0">
                      <dt className="truncate font-medium">{t(`cronHelp.${field}Label`)}</dt>
                      <dd className="text-xs text-muted-foreground">{t(`cronHelp.${field}Range`)}</dd>
                    </div>
                  ))}
                </dl>
                <div className="space-y-2 text-sm">
                  <p><Trans i18nKey="cronHelp.anyValue" t={t} components={{ 1: <code className="rounded bg-muted px-1 font-mono" /> }} /></p>
                  <p><Trans i18nKey="cronHelp.everyNUnits" t={t} components={{ 1: <code className="rounded bg-muted px-1 font-mono" /> }} /></p>
                  <p><Trans i18nKey="cronHelp.every2HoursExample" t={t} components={{ 1: <code className="rounded bg-muted px-1 font-mono" /> }} /></p>
                  <p><Trans i18nKey="cronHelp.daily6amExample" t={t} components={{ 1: <code className="rounded bg-muted px-1 font-mono" /> }} /></p>
                </div>
              </SectionCard>
            </div>
          </div>
        </>
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('scheduledTasks.deleteDialogTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('scheduledTasks.deleteDialogDesc', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('manualRestart.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deleteTarget) void handleDeleteTask(deleteTarget.id) }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('scheduledTasks.deleteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SaveBar
        dirty={settingsDirty}
        saving={settingsSaving}
        onSave={() => { void saveSettings() }}
        onDiscard={discardSettings}
        disabledReason={settingsDisabledReason}
        saveLabel={t('timezone.saveButton')}
      />
    </div>
  )
}
