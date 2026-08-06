import { useTranslation } from 'react-i18next';
import { useEffect, useState, useCallback } from 'react'
import {
  Clock,
  Plus,
  Trash2,
  RotateCcw,
  Calendar,
  History,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Play,
  Loader2,
  AlertCircle,
  ChevronDown,
  HelpCircle
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { reportClientError } from '@/lib/client-errors'
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


import { schedulerApi, rconApi, serverApi, serversApi, ScheduleHistoryEntry, ServerInstance } from '@/lib/api'
import { EmptyState } from '@/components/EmptyState'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

interface ScheduledTask {
  id: number
  name: string
  cron_expression: string
  command: string
  server_id: string | number | null
  enabled: number
  last_run: string | null
  created_at: string
}

interface CronPreset {
  name: string
  cron: string
}

const commonCommands = [
  { labelKey: 'commands.restartServer', value: 'restart' },
  { labelKey: 'commands.saveWorld', value: 'save' },
  { labelKey: 'commands.serverMessage', value: 'servermsg Server maintenance in progress' },
  { labelKey: 'commands.checkModUpdates', value: 'checkModsNeedUpdate' },
  // PanelBridge actions \u2014 routed through the Lua mod via `bridge:<action>`.
  // JSON args after the action name are validated server-side.
  { labelKey: 'commands.triggerBlizzard', value: 'bridge:triggerBlizzard {"duration":2}' },
  { labelKey: 'commands.triggerStorm', value: 'bridge:triggerStorm {"duration":1}' },
  { labelKey: 'commands.triggerTropicalStorm', value: 'bridge:triggerTropicalStorm {"duration":1}' },
  { labelKey: 'commands.stopAllWeather', value: 'bridge:stopWeather' },
  { labelKey: 'commands.startRain', value: 'bridge:startRain {"intensity":0.7}' },
  { labelKey: 'commands.stopRain', value: 'bridge:stopRain' },
  { labelKey: 'commands.restoreUtilities', value: 'bridge:restoreUtilities' },
  { labelKey: 'commands.shutOffUtilities', value: 'bridge:shutOffUtilities' },
  { labelKey: 'commands.saveWorldPanelBridge', value: 'bridge:saveWorld' },
  { labelKey: 'commands.broadcastServerChat', value: 'bridge:sendToServerChat {"message":"Scheduled broadcast"}' },
]

export default function Scheduler() {
  const { t } = useTranslation('scheduler');
  
  
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [history, setHistory] = useState<ScheduleHistoryEntry[]>([])
  const [presets, setPresets] = useState<CronPreset[]>([])
  const [servers, setServers] = useState<ServerInstance[]>([])
  const [status, setStatus] = useState<{
    activeTasks: number
    autoRestartEnabled: boolean
    modUpdateRestartPending: boolean
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const [runningTaskId, setRunningTaskId] = useState<number | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const { toast } = useToast()

  // New task form
  const [newTaskName, setNewTaskName] = useState('')
  const [newTaskCron, setNewTaskCron] = useState('')
  const [newTaskCommand, setNewTaskCommand] = useState('')
  const [newTaskServerId, setNewTaskServerId] = useState<string>('')
  const [dialogOpen, setDialogOpen] = useState(false)

  // Simple Scheduler State
  const [scheduleMode, setScheduleMode] = useState<'simple' | 'advanced'>('simple')
  const [simpleIntervalType, setSimpleIntervalType] = useState<'hourly' | 'daily' | 'interval'>('daily')
  const [simpleHour, setSimpleHour] = useState('06')
  const [simpleMinute, setSimpleMinute] = useState('00')
  const [simpleHoursInterval, setSimpleHoursInterval] = useState('4')

  // Restart form
  const [restartMinutes, setRestartMinutes] = useState(5)
  const [serverRunning, setServerRunning] = useState<boolean>(false)

  const fetchData = useCallback(async () => {
    setFetchError(null)
    try {
      const [tasksData, presetsData, statusData, historyData, serversData] = await Promise.all([
        schedulerApi.getTasks(),
        schedulerApi.getCronPresets(),
        schedulerApi.getStatus(),
        schedulerApi.getHistory(50),
        serversApi.getAll().catch(() => ({ servers: [] as ServerInstance[] })),
      ])
      setTasks(tasksData.tasks || [])
      setPresets(presetsData.presets || [])
      setStatus(statusData)
      setHistory(historyData.history || [])
      const serverList: ServerInstance[] = serversData.servers || []
      setServers(serverList)
      // Default the create-task dialog's target server to the active one,
      // but only on first load — don't clobber an in-progress selection.
      setNewTaskServerId((prev) => {
        if (prev) return prev
        const active = serverList.find((s) => s.isActive)
        return active ? String(active.id) : (serverList[0] ? String(serverList[0].id) : '')
      })
    } catch (error) {
      reportClientError('Failed to fetch scheduler data.', error)
      setFetchError(t('errors.loadDataFailed'))
    } finally {
      setInitialLoading(false)
    }
  }, [t])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Poll server status so Manual Restart / Quick Broadcasts stay accurate.
  // Skipped while the tab is hidden to avoid pointless work in background tabs.
  useEffect(() => {
    let cancelled = false
    const pull = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      try {
        const s = await serverApi.getStatus()
        if (!cancelled) setServerRunning(!!s?.running)
      } catch {
        if (!cancelled) setServerRunning(false)
      }
    }
    pull()
    const id = setInterval(pull, 15000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Resolve a task's target server name for display — "Unknown server" if
  // it was deleted since the task was created, "This server" (no badge
  // shown, just falls back cleanly) if server_id is unset (legacy/no
  // multi-server setup yet).
  const getServerLabel = (serverId: string | number | null): string | null => {
    if (!serverId) return null
    const match = servers.find((s) => String(s.id) === String(serverId))
    return match ? (match.name || match.serverName || t('server.fallbackName', { id: serverId })) : t('server.unknown')
  }

  // Simple cron validation
  const isValidCron = (cron: string): boolean => {
    const parts = cron.trim().split(/\s+/)
    if (parts.length !== 5) return false
    // Each part should be a valid cron field (numbers, *, /, -, ,)
    return parts.every(p => /^[\d*,\/-]+$/.test(p))
  }

  // Shared by the submit path and the preview so they cannot disagree.
  const buildSimpleCron = (): string => {
    const clamp = (raw: string, min: number, max: number, fallback: number) => {
      const parsed = parseInt(raw, 10)
      if (!Number.isFinite(parsed)) return fallback
      return Math.min(Math.max(parsed, min), max)
    }
    if (simpleIntervalType === 'daily') {
      return `${clamp(simpleMinute, 0, 59, 0)} ${clamp(simpleHour, 0, 23, 0)} * * *`
    }
    if (simpleIntervalType === 'hourly') return `0 * * * *`
    return `0 */${clamp(simpleHoursInterval, 1, 23, 1)} * * *`
  }

  const handleCreateTask = async () => {
    let cronToUse = newTaskCron

    // Calculate cron if in simple mode
    if (scheduleMode === 'simple') {
      cronToUse = buildSimpleCron()
    }

    if (!newTaskName || !cronToUse || !newTaskCommand) {
      toast({
        title: t('toast.error'),
        description: t('errors.requiredFields'),
        variant: 'destructive',
      })
      return
    }

    // Validate cron expression
    if (!isValidCron(cronToUse)) {
      toast({
        title: t('errors.invalidSchedule'),
        description: t('errors.invalidCron', { cron: cronToUse }),
        variant: 'destructive',
      })
      return
    }

    setLoading(true)
    try {
      await schedulerApi.createTask(newTaskName, cronToUse, newTaskCommand, newTaskServerId || undefined)
      toast({
        title: t('toast.success'),
        description: t('toast.taskCreated'),
        variant: 'success' as const,
      })
      setNewTaskName('')
      setNewTaskCron('')
      setNewTaskCommand('')
      setNewTaskServerId('')
      setDialogOpen(false)
      fetchData()
    } catch (error) {
      toast({
        title: t('toast.error'),
        description: error instanceof Error ? error.message : t('errors.createTaskFailed'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleToggleTask = async (task: ScheduledTask) => {
    setLoading(true)
    try {
      await schedulerApi.updateTask(
        task.id,
        task.name,
        task.cron_expression,
        task.command,
        !task.enabled
      )
      toast({
        title: t('toast.success'),
        description: task.enabled ? t('toast.taskDisabled') : t('toast.taskEnabled'),
        variant: 'success' as const,
      })
      fetchData()
    } catch (error) {
      toast({
        title: t('toast.error'),
        description: error instanceof Error ? error.message : t('errors.updateTaskFailed'),
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
        title: t('toast.success'),
        description: t('toast.taskDeleted'),
        variant: 'success' as const,
      })
      fetchData()
    } catch (error) {
      toast({
        title: t('toast.error'),
        description: error instanceof Error ? error.message : t('errors.deleteTaskFailed'),
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
      const result = await rconApi.execute(task.command)
      if (result.success) {
        toast({
          title: t('toast.taskExecutedTitle'),
          description: t('toast.taskExecuted', { name: task.name }),
          variant: 'success' as const,
        })
        fetchData() // Refresh to update history
      } else {
        toast({
          title: t('errors.executionFailed'),
          description: result.response || t('errors.commandFailed'),
          variant: 'destructive',
        })
      }
    } catch (error) {
      toast({
        title: t('toast.error'),
        description: error instanceof Error ? error.message : t('errors.runTaskFailed'),
        variant: 'destructive',
      })
    } finally {
      setRunningTaskId(null)
    }
  }

  const handleRestartNow = async () => {
    setLoading(true)
    try {
      await schedulerApi.restartNow(restartMinutes)
      toast({
        title: t('toast.restartInitiated'),
        description: t('toast.serverRestartIn', { minutes: restartMinutes }),
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('toast.error'),
        description: error instanceof Error ? error.message : t('errors.restartFailed'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleRestartWithWarning = async (minutes: number) => {
    setLoading(true)
    try {
      await schedulerApi.restartNow(minutes)
      toast({
        title: t('toast.restartInitiated'),
        description: t('toast.serverRestartWithWarnings', { minutes }),
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('toast.error'),
        description: error instanceof Error ? error.message : t('errors.restartFailed'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleBroadcast = async (message: string) => {
    setLoading(true)
    try {
      await rconApi.execute(`servermsg "${message}"`)
      toast({
        title: t('toast.broadcastSent'),
        description: message,
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('toast.error'),
        description: error instanceof Error ? error.message : t('errors.broadcastFailed'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleClearHistory = async () => {
    setLoading(true)
    try {
      await schedulerApi.clearHistory()
      setHistory([])
      toast({
        title: t('toast.success'),
        description: t('toast.historyCleared'),
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('toast.error'),
        description: error instanceof Error ? error.message : t('errors.clearHistoryFailed'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }



  if (initialLoading) {
    return (
      <div className="flex items-center justify-center min-h-[320px] py-12">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6 page-transition">
      {fetchError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('schedulerDataCouldNotBeLoaded')}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0 break-words" dir="auto">{fetchError}</span>
            <Button variant="outline" size="sm" onClick={fetchData} className="self-start">
              <RefreshCw className="mr-2 h-4 w-4" /> {t('actions.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <PageHeader
          title={t("title")}
          description={t("description")}
          eyebrow={t('eyebrow')}
          tone="maintain"
          icon={<Clock className="w-5 h-5" />}
          actions={
            <DialogTrigger asChild>
              <Button variant="command">
                <Plus className="w-4 h-4 mr-2" />
                {t('actions.newTask')}
              </Button>
            </DialogTrigger>
          }
        />
        <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('createScheduledTask')}</DialogTitle>
              <DialogDescription>
                {t('createTaskDescription')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>{t('taskName')}</Label>
                <Input
                  value={newTaskName}
                  onChange={(e) => setNewTaskName(e.target.value)}
                  placeholder={t('placeholders.taskName')}
                  maxLength={100}
                />
              </div>
              <div>
                <Label className="mb-2 block">{t('scheduleType')}</Label>
                <Tabs value={scheduleMode} onValueChange={(v: string) => setScheduleMode(v as 'simple' | 'advanced')} className="w-full">
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="simple">{t('scheduleModes.simple')}</TabsTrigger>
                    <TabsTrigger value="advanced">{t('scheduleModes.advanced')}</TabsTrigger>
                  </TabsList>

                  <TabsContent value="simple" className="space-y-4 pt-4 border rounded-md p-4 mt-0 border-t-0 rounded-t-none">
                    <div className="space-y-2">
                      <Label>{t('frequency')}</Label>
                      <Select value={simpleIntervalType} onValueChange={(v) => setSimpleIntervalType(v as 'hourly' | 'daily' | 'interval')}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="hourly">{t('everyHourAtMinute0')}</SelectItem>
                          <SelectItem value="interval">{t('everyXHours')}</SelectItem>
                          <SelectItem value="daily">{t('dailyAtSpecificTime')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {simpleIntervalType === 'daily' && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>{t('hour023')}</Label>
                          <Input
                            type="number"
                            min={0}
                            max={23}
                            value={simpleHour}
                            onChange={e => setSimpleHour(e.target.value)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>{t('minute059')}</Label>
                          <Input
                            type="number"
                            min={0}
                            max={59}
                            value={simpleMinute}
                            onChange={e => setSimpleMinute(e.target.value)}
                          />
                        </div>
                      </div>
                    )}

                    {simpleIntervalType === 'interval' && (
                      <div className="space-y-2">
                        <Label>{t('everyXHours')}</Label>
                        <Input
                          type="number"
                          min={1}
                          max={23}
                          value={simpleHoursInterval}
                          onChange={e => setSimpleHoursInterval(e.target.value)}
                          placeholder={t('placeholders.interval')}
                        />
                      </div>
                    )}

                    <div className="bg-muted p-3 rounded text-xs flex items-center justify-between">
                      <span className="text-muted-foreground">{t('generatedCron')}</span>
                      <code className="font-mono bg-background px-2 py-1 rounded border">
                        {buildSimpleCron()}
                      </code>
                    </div>
                  </TabsContent>

                  <TabsContent value="advanced" className="space-y-3 pt-4 border rounded-md p-4 mt-0 border-t-0 rounded-t-none">
                    <div className="space-y-2">
                      <Label>{t('loadPreset')}</Label>
                      <Select onValueChange={(value) => setNewTaskCron(value)}>
                        <SelectTrigger>
                          <SelectValue placeholder={t('placeholders.selectPreset')} />
                        </SelectTrigger>
                        <SelectContent>
                          {presets.map((preset) => (
                            <SelectItem key={preset.cron} value={preset.cron}>
                              {preset.name} ({preset.cron})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>{t('customExpression')}</Label>
                      <Input
                        value={newTaskCron}
                        onChange={(e) => setNewTaskCron(e.target.value)}
                        placeholder={t('placeholders.cron')}
                        className="font-mono"
                        maxLength={100}
                        aria-label={t('labels.cronExpression')}
                        aria-describedby="cron-format-hint"
                      />
                    </div>
                    <p id="cron-format-hint" className="text-xs text-muted-foreground">
                      {t('cron.format')}
                    </p>
                  </TabsContent>
                </Tabs>
              </div>
              <div>
                <Label>{t('command')}</Label>
                <Select onValueChange={(value) => setNewTaskCommand(value)}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('placeholders.selectCommand')} />
                  </SelectTrigger>
                  <SelectContent>
                    {commonCommands.map((cmd) => (
                      <SelectItem key={cmd.value} value={cmd.value}>
                        {t(cmd.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  className="mt-2"
                  value={newTaskCommand}
                  onChange={(e) => setNewTaskCommand(e.target.value)}
                  placeholder={t('placeholders.customCommand')}
                  maxLength={2000}
                />
                {newTaskCommand.startsWith('bridge:') && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {t('bridge.format')}: <code className="text-foreground">bridge:&lt;action&gt; {'{json args}'}</code> — {t('bridge.example')}
                    <code className="ml-1 text-foreground">bridge:triggerBlizzard {'{"durationHours":2}'}</code>.
                    {t('bridge.description')}
                  </p>
                )}
              </div>
              <div>
                <Label>{t('targetServer')}</Label>
                <Select value={newTaskServerId} onValueChange={setNewTaskServerId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('placeholders.selectServer')} />
                  </SelectTrigger>
                  <SelectContent>
                    {servers.map((server) => (
                      <SelectItem key={server.id} value={String(server.id)}>
                        {server.name || server.serverName}
                        {server.isActive ? ` (${t('server.active')})` : ''}
                        {server.isRemote ? ` — ${t('server.remote')}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {t('targetServerDescription')}
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleCreateTask} disabled={loading}>
                {t('actions.createTask')}
              </Button>
            </DialogFooter>
          </DialogContent>
      </Dialog>

      {/* Status Cards — only when tasks exist */}
      {tasks.length > 0 && (() => {
        const activeCount = tasks.filter(t => t.enabled).length
        const totalCount = tasks.length
        const restartCount = tasks.filter(t => t.command.toLowerCase() === 'restart').length
        const restartActive = tasks.filter(t => t.enabled && t.command.toLowerCase() === 'restart').length > 0
        const modRestartPending = !!status?.modUpdateRestartPending
        const tiles = [
          {
            icon: <Clock className="w-4 h-4" />,
            label: t('statusCards.activeTasks'),
            value: String(activeCount),
            sub: t('statusCards.totalTasks', { count: totalCount }),
            tone: activeCount > 0 ? 'primary' : 'muted',
          },
          {
            icon: <RotateCcw className="w-4 h-4" />,
            label: t('statusCards.restartTasks'),
            value: restartActive ? t('statusCards.scheduled') : t('statusCards.none'),
            sub: t('statusCards.restartTaskCount', { count: restartCount }),
            tone: restartActive ? 'primary' : 'muted',
          },
          {
            icon: <Calendar className="w-4 h-4" />,
            label: t('statusCards.modUpdateRestart'),
            value: modRestartPending ? t('statusCards.pending') : t('statusCards.none'),
            sub: t('statusCards.modUpdateRestartDescription'),
            tone: modRestartPending ? 'warning' : 'muted',
          },
        ] as const
        const toneClasses = {
          primary: { tile: 'border-primary/30 bg-primary/[0.06] text-primary', value: 'text-foreground' },
          warning: { tile: 'border-warning/40 bg-warning/10 text-warning', value: 'text-warning' },
          muted: { tile: 'border-border/55 bg-muted/30 text-muted-foreground', value: 'text-muted-foreground' },
        }
        return (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {tiles.map(t => {
              const cls = toneClasses[t.tone]
              return (
                <Card key={t.label} className="overflow-hidden">
                  <CardContent className="flex items-center gap-3 p-4">
                    <div className={`grid place-items-center w-10 h-10 rounded-md border ${cls.tile}`} aria-hidden="true">
                      {t.icon}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t.label}</p>
                      <p className={`text-xl font-semibold leading-tight mt-0.5 ${cls.value}`}>{t.value}</p>
                      <p className="text-[11px] text-muted-foreground/80 mt-0.5 truncate">{t.sub}</p>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )
      })()}

      {/* Quick Actions — 2-col grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Manual Restart */}
        <Card>
        <CardHeader>
          <CardTitle>{t('manualRestart.title')}</CardTitle>
          <CardDescription>
            {serverRunning
              ? t('manualRestart.onlineDescription')
              : t('manualRestart.offlineDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Quick Restart Buttons — each triggers an immediate restart with that warning length */}
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => handleRestartWithWarning(15)}
              disabled={loading || !serverRunning}
              variant="outline"
              size="sm"
              title={t('presets.restart15')}
            >
              <Clock className="w-4 h-4 mr-2" />
              {t('manualRestart.restartIn', { minutes: 15 })}
            </Button>
            <Button
              onClick={() => handleRestartWithWarning(10)}
              disabled={loading || !serverRunning}
              variant="outline"
              size="sm"
              title={t('presets.restart10')}
            >
              <Clock className="w-4 h-4 mr-2" />
              {t('manualRestart.restartIn', { minutes: 10 })}
            </Button>
            <Button
              onClick={() => handleRestartWithWarning(5)}
              disabled={loading || !serverRunning}
              variant="outline"
              size="sm"
              title={t('presets.restart5')}
            >
              <Clock className="w-4 h-4 mr-2" />
              {t('manualRestart.restartIn', { minutes: 5 })}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  disabled={loading || !serverRunning}
                  variant="warning"
                  size="sm"
                  title={t('presets.restart1')}
                >
                  <Clock className="w-4 h-4 mr-2" />
                  {t('manualRestart.restartIn', { minutes: 1 })}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('restartServerIn1Minute')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('manualRestart.oneMinuteDescription')}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => handleRestartWithWarning(1)}
                    className="bg-warning text-warning-foreground hover:bg-warning/90"
                  >
                    {t('manualRestart.restartIn', { minutes: 1 })}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          {/* Custom Time */}
          <div className="flex items-end gap-4">
            <div className="flex-1 max-w-xs">
              <Label>{t('customCountdownMinutes')}</Label>
              <Input
                type="number"
                value={restartMinutes}
                onChange={(e) => setRestartMinutes(parseInt(e.target.value) || 5)}
                min={1}
                max={30}
              />
            </div>
            {restartMinutes < 5 ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button disabled={loading || !serverRunning} variant="warning">
                    <RotateCcw className="w-4 h-4 mr-2" />
                    {t('manualRestart.restartNow')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('manualRestart.restartConfirm', { minutes: restartMinutes })}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('manualRestart.shortCountdownDescription')}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                    <AlertDialogAction onClick={handleRestartNow} className="bg-warning text-warning-foreground hover:bg-warning/90">
                    {t('manualRestart.restartIn', { minutes: restartMinutes })}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              <Button
                onClick={handleRestartNow}
                disabled={loading || !serverRunning}
                variant="warning"
              >
                <RotateCcw className="w-4 h-4 mr-2" />
                    {t('manualRestart.restartNow')}
              </Button>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {t('manualRestart.countdownDescription')}
          </p>
        </CardContent>
      </Card>

      {/* Maintenance Mode */}
      <Card>
        <CardHeader>
          <CardTitle>{t('broadcasts.title')}</CardTitle>
          <CardDescription>
            {serverRunning
              ? t('broadcasts.onlineDescription')
              : t('broadcasts.offlineDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => handleBroadcast(t('broadcasts.messages.maintenanceStart'))}
              variant="outline"
              size="sm"
              disabled={loading || !serverRunning}
            >
              {t('broadcasts.buttons.maintenanceStart')}
            </Button>
            <Button
              onClick={() => handleBroadcast(t('broadcasts.messages.maintenanceEnd'))}
              variant="outline"
              size="sm"
              disabled={loading || !serverRunning}
            >
              {t('broadcasts.buttons.maintenanceEnd')}
            </Button>
            <Button
              onClick={() => handleBroadcast(t('broadcasts.messages.saveWarning'))}
              variant="outline"
              size="sm"
              disabled={loading || !serverRunning}
            >
              {t('broadcasts.buttons.saveWarning')}
            </Button>
            <Button
              onClick={() => handleBroadcast(t('broadcasts.messages.welcome'))}
              variant="outline"
              size="sm"
              disabled={loading || !serverRunning}
            >
              {t('broadcasts.buttons.welcome')}
            </Button>
          </div>
        </CardContent>
      </Card>
      </div>

      {/* Scheduled Tasks */}
      <Card>
        <CardHeader>
          <CardTitle>{t('scheduledTasks.title')}</CardTitle>
          <CardDescription>
            {t('scheduledTasks.description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[300px] sm:h-[400px]">
            {tasks.length === 0 ? (
              <EmptyState type="noSchedule" title={t('tasks.noTasks')} description={t('tasks.createDescription')} />
            ) : (
              <div className="space-y-3">
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    className={`group relative flex items-center gap-3 p-4 rounded-lg border transition-colors ${
                      task.enabled
                        ? 'bg-card border-border/60 hover:border-primary/40'
                        : 'bg-muted/30 border-border/40 text-muted-foreground'
                    }`}
                  >
                    {/* Leading status pip — solid + ping when active, hollow when disabled */}
                    <div className="shrink-0 self-stretch flex items-center" aria-hidden="true">
                      {task.enabled ? (
                        <span className="relative inline-flex">
                          <span className="absolute inset-0 rounded-full bg-primary/40 animate-ping motion-reduce:hidden" />
                          <span className="relative w-2 h-2 rounded-full bg-primary" />
                        </span>
                      ) : (
                        <span className="w-2 h-2 rounded-full border border-muted-foreground/50" />
                      )}
                    </div>
                    <div className="flex flex-1 items-center justify-between min-w-0">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <h3 className="font-medium truncate text-foreground">{task.name}</h3>
                          {getServerLabel(task.server_id) && (
                            <span
                              className="shrink-0 text-[11px] font-medium bg-primary/10 border border-primary/30 px-1.5 py-0.5 rounded text-primary truncate max-w-[140px]"
                              title={t('server.targetTooltip', { name: getServerLabel(task.server_id) })}
                            >
                              {getServerLabel(task.server_id)}
                            </span>
                          )}
                          <code className="shrink-0 text-[11px] font-mono bg-muted/70 border border-border/50 px-1.5 py-0.5 rounded text-muted-foreground truncate max-w-[180px]" title={task.cron_expression}>
                            {task.cron_expression}
                          </code>
                        </div>
                        <p className="text-sm text-muted-foreground mt-1 truncate">
                          <code className="text-primary/90 font-mono text-xs">{task.command}</code>
                        </p>
                        {task.last_run && (
                          <p className="text-[11px] text-muted-foreground/70 mt-1">
                            {t('scheduledTasks.lastRun')} · {new Date(task.last_run).toLocaleString()}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRunNow(task)}
                          disabled={loading || runningTaskId !== null}
                          title={t('tasks.runNow')}
                          aria-label={t('accessibility.runTask', { name: task.name })}
                        >
                          {runningTaskId === task.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Play className="w-4 h-4" />
                          )}
                        </Button>
                        <Switch
                          checked={!!task.enabled}
                          onCheckedChange={() => handleToggleTask(task)}
                          disabled={loading}
                          aria-label={t('accessibility.toggleTask', { name: task.name })}
                        />
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={loading}
                              aria-label={t('accessibility.deleteTask', { name: task.name })}
                            >
                              <Trash2 className="w-4 h-4 text-destructive" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>{t('deleteScheduledTask')}</AlertDialogTitle>
                              <AlertDialogDescription>
                                {t('scheduledTasks.deleteDescription', { name: task.name })}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleDeleteTask(task.id)}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              >
                                {t('actions.delete')}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Execution History */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
                <CardTitle className="flex items-center gap-2">
                <History className="w-5 h-5" />
                {t('history.title')}
              </CardTitle>
              <CardDescription>
                {t('history.recentDescription')}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={fetchData}
                disabled={loading}
              >
                <RefreshCw className="w-4 h-4 mr-1" />
                {t('actions.refresh')}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loading || history.length === 0}
                  >
                    <Trash2 className="w-4 h-4 mr-1" />
                    {t('actions.clear')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('clearExecutionHistory')}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('history.clearDescription', { count: history.length })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleClearHistory}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {t('actions.clearAll')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[300px] sm:h-[400px]">
            {history.length === 0 ? (
              <EmptyState type="noSchedule" title={t('history.noHistory')} description={t('history.description')} />
            ) : (
              <div className="space-y-2">
                {history.map((entry) => (
                  <div
                    key={entry.id}
                    className={`p-3 rounded-lg border-l-2 border-y border-r border-y-border/40 border-r-border/40 ${
                      entry.success
                        ? 'bg-card border-l-primary/50'
                        : 'bg-destructive/[0.06] border-l-destructive border-y-destructive/25 border-r-destructive/25'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        {entry.success ? (
                          <CheckCircle2 className="w-4 h-4 text-primary flex-shrink-0" aria-hidden="true" />
                        ) : (
                          <XCircle className="w-4 h-4 text-destructive flex-shrink-0" aria-hidden="true" />
                        )}
                        <span className="sr-only">{entry.success ? t('history.succeeded') : t('history.failed')}</span>
                        <div>
                          <span className="font-medium">{entry.task_name}</span>
                          <code className="ml-2 text-xs bg-muted px-1.5 py-0.5 rounded">
                            {entry.command}
                          </code>
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(entry.executed_at).toLocaleString()}
                      </span>
                    </div>
                    <div className="mt-1 ml-6 text-sm">
                      {entry.message && (
                        <p className={entry.success ? 'text-muted-foreground' : 'text-destructive'}>
                          {entry.message}
                        </p>
                      )}
                      {entry.duration !== null && (
                        <p className="text-xs text-muted-foreground">
                          {t('history.duration', { seconds: (entry.duration / 1000).toFixed(1) })}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Cron Help — collapsible reference */}
      <Collapsible>
        <div className="rounded-xl border border-border/40 bg-card/40">
          <CollapsibleTrigger className="flex w-full items-center justify-between px-5 py-3 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
            <span className="flex items-center gap-2">
              <HelpCircle className="w-4 h-4" />
              {t('cronHelp.title')}
            </span>
            <ChevronDown className="w-4 h-4 transition-transform duration-200 [[data-state=open]>&]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="px-5 pb-4 pt-0">
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-sm">
                <div>
                  <p className="font-medium">{t('minute')}</p>
                  <p className="text-muted-foreground">0-59</p>
                </div>
                <div>
                  <p className="font-medium">{t('hour')}</p>
                  <p className="text-muted-foreground">0-23</p>
                </div>
                <div>
                  <p className="font-medium">{t('day')}</p>
                  <p className="text-muted-foreground">1-31</p>
                </div>
                <div>
                  <p className="font-medium">{t('month')}</p>
                  <p className="text-muted-foreground">1-12</p>
                </div>
                <div>
                  <p className="font-medium">{t('weekday')}</p>
                  <p className="text-muted-foreground">{t('cronHelp.weekdayValues')}</p>
                </div>
              </div>
              <div className="mt-4 space-y-2 text-sm">
                <p><code className="bg-muted px-1 rounded">*</code> = {t('cronHelp.anyValue')}</p>
                <p><code className="bg-muted px-1 rounded">*/n</code> = {t('cronHelp.everyNUnits')}</p>
                <p><code className="bg-muted px-1 rounded">0 */2 * * *</code> = {t('cronHelp.everyTwoHours')}</p>
                <p><code className="bg-muted px-1 rounded">0 6 * * *</code> = {t('cronHelp.dailyAtSix')}</p>
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  )
}
