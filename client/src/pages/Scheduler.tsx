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
  Loader2
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
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
import { schedulerApi, rconApi, ScheduleHistoryEntry } from '@/lib/api'

interface ScheduledTask {
  id: number
  name: string
  cron_expression: string
  command: string
  enabled: number
  last_run: string | null
  created_at: string
}

interface CronPreset {
  name: string
  cron: string
}

export default function Scheduler() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [history, setHistory] = useState<ScheduleHistoryEntry[]>([])
  const [presets, setPresets] = useState<CronPreset[]>([])
  const [status, setStatus] = useState<{
    activeTasks: number
    autoRestartEnabled: boolean
    modUpdateRestartPending: boolean
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [runningTaskId, setRunningTaskId] = useState<number | null>(null)
  const { toast } = useToast()

  // New task form
  const [newTaskName, setNewTaskName] = useState('')
  const [newTaskCron, setNewTaskCron] = useState('')
  const [newTaskCommand, setNewTaskCommand] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)

  // Restart form
  const [restartMinutes, setRestartMinutes] = useState(5)

  const fetchData = useCallback(async () => {
    try {
      const [tasksData, presetsData, statusData, historyData] = await Promise.all([
        schedulerApi.getTasks(),
        schedulerApi.getCronPresets(),
        schedulerApi.getStatus(),
        schedulerApi.getHistory(50)
      ])
      setTasks(tasksData.tasks || [])
      setPresets(presetsData.presets || [])
      setStatus(statusData)
      setHistory(historyData.history || [])
    } catch (error) {
      console.error('Failed to fetch scheduler data:', error)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Simple cron validation
  const isValidCron = (cron: string): boolean => {
    const parts = cron.trim().split(/\s+/)
    if (parts.length !== 5) return false
    // Each part should be a valid cron field (numbers, *, /, -, ,)
    return parts.every(p => /^[\d*,\/-]+$/.test(p))
  }

  const handleCreateTask = async () => {
    if (!newTaskName || !newTaskCron || !newTaskCommand) {
      toast({
        title: 'Error',
        description: 'Please fill in all fields',
        variant: 'destructive',
      })
      return
    }

    // Validate cron expression
    if (!isValidCron(newTaskCron)) {
      toast({
        title: 'Invalid Schedule',
        description: 'Please enter a valid cron expression (e.g., "0 */2 * * *")',
        variant: 'destructive',
      })
      return
    }

    setLoading(true)
    try {
      await schedulerApi.createTask(newTaskName, newTaskCron, newTaskCommand)
      toast({
        title: 'Success',
        description: 'Task created successfully',
        variant: 'success' as const,
      })
      setNewTaskName('')
      setNewTaskCron('')
      setNewTaskCommand('')
      setDialogOpen(false)
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create task',
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
        title: 'Success',
        description: `Task ${task.enabled ? 'disabled' : 'enabled'}`,
        variant: 'success' as const,
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update task',
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
        title: 'Success',
        description: 'Task deleted',
        variant: 'success' as const,
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete task',
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
          title: 'Task Executed',
          description: `"${task.name}" ran successfully`,
          variant: 'success' as const,
        })
        fetchData() // Refresh to update history
      } else {
        toast({
          title: 'Execution Failed',
          description: result.response || 'Command failed',
          variant: 'destructive',
        })
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to run task',
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
        title: 'Restart Initiated',
        description: `Server will restart in ${restartMinutes} minutes`,
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to initiate restart',
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
        title: 'Restart Initiated',
        description: `Server will restart in ${minutes} minutes with countdown warnings`,
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to initiate restart',
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
        title: 'Broadcast Sent',
        description: message,
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to broadcast',
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
        title: 'Success',
        description: 'History cleared',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to clear history',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const commonCommands = [
    { label: 'Restart Server', value: 'restart' },
    { label: 'Save World', value: 'save' },
    { label: 'Server Message', value: 'servermsg Server maintenance in progress' },
    { label: 'Check Mod Updates', value: 'checkModsNeedUpdate' },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Scheduler</h1>
          <p className="text-muted-foreground">Automate server tasks and restarts</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="w-4 h-4 mr-2" />
              New Task
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Scheduled Task</DialogTitle>
              <DialogDescription>
                Schedule a command to run automatically
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Task Name</Label>
                <Input
                  value={newTaskName}
                  onChange={(e) => setNewTaskName(e.target.value)}
                  placeholder="e.g., Daily Restart"
                />
              </div>
              <div>
                <Label>Schedule</Label>
                <Select onValueChange={(value) => setNewTaskCron(value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a preset or enter custom..." />
                  </SelectTrigger>
                  <SelectContent>
                    {presets.map((preset) => (
                      <SelectItem key={preset.cron} value={preset.cron}>
                        {preset.name} ({preset.cron})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  className="mt-2"
                  value={newTaskCron}
                  onChange={(e) => setNewTaskCron(e.target.value)}
                  placeholder="Or enter custom cron: 0 */2 * * *"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Format: minute hour day month weekday
                </p>
              </div>
              <div>
                <Label>Command</Label>
                <Select onValueChange={(value) => setNewTaskCommand(value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select common command..." />
                  </SelectTrigger>
                  <SelectContent>
                    {commonCommands.map((cmd) => (
                      <SelectItem key={cmd.value} value={cmd.value}>
                        {cmd.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  className="mt-2"
                  value={newTaskCommand}
                  onChange={(e) => setNewTaskCommand(e.target.value)}
                  placeholder="Or enter custom command"
                />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleCreateTask} disabled={loading}>
                Create Task
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Active Tasks
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold">{tasks.filter(t => t.enabled).length}</span>
            <p className="text-xs text-muted-foreground mt-1">
              {tasks.length} total tasks
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <RotateCcw className="w-4 h-4" />
              Restart Tasks
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold">
              {tasks.filter(t => t.enabled && t.command.toLowerCase() === 'restart').length > 0 ? 'Scheduled' : 'None'}
            </span>
            <p className="text-xs text-muted-foreground mt-1">
              {tasks.filter(t => t.command.toLowerCase() === 'restart').length} restart task(s)
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Calendar className="w-4 h-4" />
              Mod Update Restart
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold">
              {status?.modUpdateRestartPending ? 'Pending' : 'None'}
            </span>
            <p className="text-xs text-muted-foreground mt-1">
              Auto-restart on mod updates
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Manual Restart */}
      <Card>
        <CardHeader>
          <CardTitle>Manual Restart</CardTitle>
          <CardDescription>
            Trigger a server restart with warning messages
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Quick Restart Buttons */}
          <div className="flex flex-wrap gap-2">
            <Button 
              onClick={() => handleRestartWithWarning(15)} 
              disabled={loading}
              variant="outline"
              size="sm"
            >
              <Clock className="w-4 h-4 mr-2" />
              15 min
            </Button>
            <Button 
              onClick={() => handleRestartWithWarning(10)} 
              disabled={loading}
              variant="outline"
              size="sm"
            >
              <Clock className="w-4 h-4 mr-2" />
              10 min
            </Button>
            <Button 
              onClick={() => handleRestartWithWarning(5)} 
              disabled={loading}
              variant="outline"
              size="sm"
            >
              <Clock className="w-4 h-4 mr-2" />
              5 min
            </Button>
            <Button 
              onClick={() => handleRestartWithWarning(1)} 
              disabled={loading}
              variant="destructive"
              size="sm"
            >
              <Clock className="w-4 h-4 mr-2" />
              1 min
            </Button>
          </div>
          
          {/* Custom Time */}
          <div className="flex items-end gap-4">
            <div className="flex-1 max-w-xs">
              <Label>Custom Warning Time (minutes)</Label>
              <Input
                type="number"
                value={restartMinutes}
                onChange={(e) => setRestartMinutes(parseInt(e.target.value) || 5)}
                min={1}
                max={30}
              />
            </div>
            <Button 
              onClick={handleRestartNow} 
              disabled={loading}
              variant="warning"
            >
              <RotateCcw className="w-4 h-4 mr-2" />
              Restart Now
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Players will receive countdown warnings at 15m, 10m, 5m, and 1m before restart.
          </p>
        </CardContent>
      </Card>

      {/* Maintenance Mode */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Broadcasts</CardTitle>
          <CardDescription>
            Send common server announcements to all players
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button 
              onClick={() => handleBroadcast('Server entering MAINTENANCE MODE - Please save and disconnect')}
              variant="outline"
              size="sm"
              disabled={loading}
            >
              Maintenance Start
            </Button>
            <Button 
              onClick={() => handleBroadcast('Maintenance complete - Server is back online!')}
              variant="outline"
              size="sm"
              disabled={loading}
            >
              Maintenance End
            </Button>
            <Button 
              onClick={() => handleBroadcast('Server will save in 30 seconds - Brief lag expected')}
              variant="outline"
              size="sm"
              disabled={loading}
            >
              Save Warning
            </Button>
            <Button 
              onClick={() => handleBroadcast('Welcome! Please read the rules at spawn')}
              variant="outline"
              size="sm"
              disabled={loading}
            >
              Welcome
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Scheduled Tasks */}
      <Card>
        <CardHeader>
          <CardTitle>Scheduled Tasks</CardTitle>
          <CardDescription>
            Manage your automated tasks
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[400px]">
            {tasks.length === 0 ? (
              <div className="text-center py-8">
                <Clock className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">No scheduled tasks</p>
                <p className="text-sm text-muted-foreground">
                  Create a task to automate server commands
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    className={`p-4 rounded-lg border ${
                      task.enabled ? 'bg-card' : 'bg-muted/50 opacity-60'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3">
                          <h3 className="font-medium">{task.name}</h3>
                          <code className="text-xs bg-muted px-2 py-0.5 rounded">
                            {task.cron_expression}
                          </code>
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">
                          Command: <code className="text-primary">{task.command}</code>
                        </p>
                        {task.last_run && (
                          <p className="text-xs text-muted-foreground mt-1">
                            Last run: {new Date(task.last_run).toLocaleString()}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRunNow(task)}
                          disabled={loading || runningTaskId !== null}
                          title="Run task now"
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
                        />
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={loading}
                            >
                              <Trash2 className="w-4 h-4 text-destructive" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete Scheduled Task</AlertDialogTitle>
                              <AlertDialogDescription>
                                Are you sure you want to delete "{task.name}"? This action cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleDeleteTask(task.id)}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              >
                                Delete
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
                Execution History
              </CardTitle>
              <CardDescription>
                Log of all scheduled task executions
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
                Refresh
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loading || history.length === 0}
                  >
                    <Trash2 className="w-4 h-4 mr-1" />
                    Clear
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Clear Execution History</AlertDialogTitle>
                    <AlertDialogDescription>
                      Are you sure you want to clear all {history.length} execution history entries? This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleClearHistory}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Clear All
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[400px]">
            {history.length === 0 ? (
              <div className="text-center py-8">
                <History className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">No execution history</p>
                <p className="text-sm text-muted-foreground">
                  Task executions will appear here
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {history.map((entry) => (
                  <div
                    key={entry.id}
                    className={`p-3 rounded-lg border ${
                      entry.success ? 'bg-card' : 'bg-destructive/10 border-destructive/30'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        {entry.success ? (
                          <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                        ) : (
                          <XCircle className="w-4 h-4 text-destructive flex-shrink-0" />
                        )}
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
                          Duration: {(entry.duration / 1000).toFixed(1)}s
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

      {/* Cron Help */}
      <Card>
        <CardHeader>
          <CardTitle>Cron Expression Help</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-5 gap-4 text-sm">
            <div>
              <p className="font-medium">Minute</p>
              <p className="text-muted-foreground">0-59</p>
            </div>
            <div>
              <p className="font-medium">Hour</p>
              <p className="text-muted-foreground">0-23</p>
            </div>
            <div>
              <p className="font-medium">Day</p>
              <p className="text-muted-foreground">1-31</p>
            </div>
            <div>
              <p className="font-medium">Month</p>
              <p className="text-muted-foreground">1-12</p>
            </div>
            <div>
              <p className="font-medium">Weekday</p>
              <p className="text-muted-foreground">0-6 (Sun-Sat)</p>
            </div>
          </div>
          <div className="mt-4 space-y-2 text-sm">
            <p><code className="bg-muted px-1 rounded">*</code> = any value</p>
            <p><code className="bg-muted px-1 rounded">*/n</code> = every n units</p>
            <p><code className="bg-muted px-1 rounded">0 */2 * * *</code> = every 2 hours</p>
            <p><code className="bg-muted px-1 rounded">0 6 * * *</code> = daily at 6 AM</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
