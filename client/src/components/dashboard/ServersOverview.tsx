import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowRightLeft, Download, HardDrive, Loader2, MemoryStick, Package, Play, RotateCcw, Server as ServerIcon, Square, Users } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { SectionCard } from '@/components/ui/section-card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { DisabledReason } from '@/components/DisabledReason'
import { ServerUptime } from '@/components/ServerUptime'
import { useToast } from '@/components/ui/use-toast'
import { useSocket } from '@/contexts/SocketContext'
import { useAuth } from '@/contexts/AuthContext'
import { backupApi, serversApi, type OtherServerUpdate, type ServerInstance } from '@/lib/api'
import {
  autoStartEnabled, autoStartServerIds, restartOnCrashServerIds, withAutoStartServer, type AutoStartSettings,
} from '@/lib/autoStartServers'
import { BYTES_PER_GB, formatGb, heapOfServers, portConflicts } from '@/lib/serversTogether'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { lifecycleBusyFromError, lifecycleBusyReason } from '@/lib/lifecycleBusy'
import { useLifecycleState } from '@/hooks/useLifecycleState'
import { cn } from '@/lib/utils'

// Every server at a glance on the Dashboard, so running several doesn't mean
// switching between them to see which are up: state and uptime from the
// per-server process scan (GET /servers/status), players from a one-off RCON
// count per server (GET /servers/rcon-status?players=1) -- the panel's own
// RCON connection reaches the active server only -- each one's place in the
// auto-start list and the restart-if-it-goes-down list, and Start, Stop and
// Restart for the servers other than the active one (POST
// /servers/:id/start|stop|restart; the active one's are the Dashboard's own,
// below). Shown only with two servers or more; with one, the rest of the
// Dashboard already is that server. The server watch pushes servers:status
// when one of them starts or stops, and the list refreshes on it.

const POLL_MS = 15_000
// The server list, updates and backups change rarely.
const DETAILS_POLL_MS = 5 * 60_000
// The Dashboard's own Restart warns players this long first.
const RESTART_WARNING_MINUTES = 5

type StatusRow = Awaited<ReturnType<typeof serversApi.getStatus>>['servers'][number]
type RconRow = Awaited<ReturnType<typeof serversApi.getRconStatuses>>['servers'][number]
type RowState = 'running' | 'stopped' | 'unknown'
type ServerAction = 'start' | 'stop' | 'restart'
type BackupSummary = Awaited<ReturnType<typeof backupApi.getSummary>>

function ageOf(t: (key: string, options?: Record<string, unknown>) => string, iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (minutes < 1) return t('age.justNow')
  if (minutes < 60) return t('age.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('age.hoursAgo', { count: hours })
  return t('age.daysAgo', { count: Math.floor(hours / 24) })
}

interface ServersOverviewProps {
  activeServerId: string | null
  autoStartSettings: AutoStartSettings
  canChangeAutoStart: boolean
  onAutoStartChange: (server: ServerInstance, chosen: boolean) => void
  onRestartOnCrashChange: (server: ServerInstance, chosen: boolean) => void
  /** Whether the overview is on screen (two servers or more). */
  onShownChange?: (shown: boolean) => void
}

function rowState(server: ServerInstance, status: StatusRow | undefined, rcon: RconRow | undefined): RowState {
  // The process scan only sees this machine: a remote server is up when its
  // RCON answers.
  if (server.isRemote) return rcon?.status === 'connected' ? 'running' : 'stopped'
  if (!status || status.stateUnknown) return 'unknown'
  return status.running ? 'running' : 'stopped'
}

export function ServersOverview({
  activeServerId, autoStartSettings, canChangeAutoStart, onAutoStartChange, onRestartOnCrashChange, onShownChange,
}: ServersOverviewProps) {
  const { t } = useTranslation('dashboard')
  const { toast } = useToast()
  const socket = useSocket()
  const { can } = useAuth()
  const canSwitch = can('servers.manage')
  const canControl = can('server.control')
  // What holds the lifecycle lock, or which servers wait for their RCON:
  // each row's controls say so instead of failing when clicked.
  const lifecycleState = useLifecycleState()
  // Backups: what every backup role reads (GET /backup/summary), and the
  // schedule's list of servers, which backups.manage changes.
  const canSeeBackups = can('backups.manage') || can('backups.download') || can('backups.restore')
  const canManageBackups = can('backups.manage')
  const [servers, setServers] = useState<ServerInstance[]>([])
  const [hostMemoryBytes, setHostMemoryBytes] = useState<number | null>(null)
  const [updates, setUpdates] = useState<Record<string, OtherServerUpdate>>({})
  const [backups, setBackups] = useState<BackupSummary | null>(null)
  const [statuses, setStatuses] = useState<Record<string, StatusRow>>({})
  const [rcon, setRcon] = useState<Record<string, RconRow>>({})
  const [switching, setSwitching] = useState<string | null>(null)
  // One action at a time, like the panel's lifecycle lock.
  const [pending, setPending] = useState<{ id: string; action: ServerAction } | null>(null)
  const [toConfirm, setToConfirm] = useState<{ server: ServerInstance; action: 'stop' | 'restart' } | null>(null)

  // Two cadences, so a Dashboard left open stays well inside the API's
  // per-address budget (300 requests a minute, shared with the rest of the
  // page and every other tab): what changes from one moment to the next --
  // each server's state and players -- every 15 s; the server list, the
  // other servers' updates and the backups on mount, on a push, and every 5
  // minutes. The RCON count is asked only by the roles its route lets in.
  const canCountPlayers = can('servers.manage') || can('rcon.execute')
  const fastSeq = useRef(0)
  const slowSeq = useRef(0)
  // With one server the list isn't shown: nothing to poll beyond the server
  // list itself (which tells when a second server appears).
  const serverCount = useRef(0)

  const refreshState = useCallback(async () => {
    const seq = ++fastSeq.current
    const [status, rconStatus] = await Promise.allSettled([
      serversApi.getStatus(),
      canCountPlayers ? serversApi.getRconStatuses({ players: true }) : Promise.resolve(null),
    ])
    // An older poll answering after a newer one must not put its rows back.
    if (seq !== fastSeq.current) return
    if (status.status === 'fulfilled') {
      setStatuses(Object.fromEntries((status.value?.servers ?? []).map((row) => [String(row.id), row])))
      if (typeof status.value?.hostMemoryBytes === 'number') setHostMemoryBytes(status.value.hostMemoryBytes)
    }
    if (rconStatus.status === 'fulfilled' && rconStatus.value) {
      setRcon(Object.fromEntries((rconStatus.value.servers ?? []).map((row) => [String(row.id), row])))
    }
  }, [canCountPlayers])

  const refreshDetails = useCallback(async () => {
    const seq = ++slowSeq.current
    const [list, updateList, backupSummary] = await Promise.allSettled([
      serversApi.getAll(),
      serversApi.getUpdates(),
      canSeeBackups ? backupApi.getSummary() : Promise.resolve(null),
    ])
    if (seq !== slowSeq.current) return
    if (list.status === 'fulfilled') {
      setServers(list.value?.servers ?? [])
      serverCount.current = list.value?.servers?.length ?? 0
    }
    if (updateList.status === 'fulfilled') {
      setUpdates(Object.fromEntries((updateList.value?.servers ?? []).map((row) => [String(row.serverId), row])))
    }
    if (backupSummary.status === 'fulfilled') setBackups(backupSummary.value ?? null)
  }, [canSeeBackups])

  const refresh = useCallback(async () => {
    await refreshDetails()
    if (serverCount.current > 1) await refreshState()
  }, [refreshState, refreshDetails])

  useEffect(() => {
    void refresh()
    const visible = () => document.visibilityState !== 'hidden'
    const fast = setInterval(() => { if (visible() && serverCount.current > 1) void refreshState() }, POLL_MS)
    const slow = setInterval(() => { if (visible()) void refreshDetails() }, DETAILS_POLL_MS)
    return () => {
      clearInterval(fast)
      clearInterval(slow)
    }
  }, [refresh, refreshState, refreshDetails, activeServerId])

  useEffect(() => {
    if (!socket) return
    const onActiveChange = () => { void refresh() }
    const onState = () => { if (serverCount.current > 1) void refreshState() }
    const onUpdates = () => { void refreshDetails() }
    socket.on('activeServerChanged', onActiveChange)
    socket.on('servers:status', onState)
    socket.on('servers:updates', onUpdates)
    return () => {
      socket.off('activeServerChanged', onActiveChange)
      socket.off('servers:status', onState)
      socket.off('servers:updates', onUpdates)
    }
  }, [socket, refresh, refreshState, refreshDetails])

  const shown = servers.length > 1
  useEffect(() => { onShownChange?.(shown) }, [shown, onShownChange])

  const handleSwitch = async (server: ServerInstance) => {
    if (!canSwitch) return
    setSwitching(String(server.id))
    try {
      // The Dashboard follows the active server through activeServerChanged.
      await serversApi.activate(server.id)
    } catch (error) {
      const busy = lifecycleBusyFromError(error)
      if (busy) {
        toast({ title: t('lifecycleBusy.title', { ns: 'shell' }), description: busy })
        return
      }
      toast({
        title: t('serversOverview.switchFailed', { name: server.name || server.serverName }),
        description: getUserErrorMessage(error, t('toasts.errorTitle')),
        variant: 'destructive',
      })
    } finally {
      setSwitching(null)
    }
  }

  const runAction = async (server: ServerInstance, action: ServerAction) => {
    if (!canControl || pending) return
    const name = server.name || server.serverName
    setPending({ id: String(server.id), action })
    try {
      if (action === 'start') {
        const result = await serversApi.start(server.id)
        toast({ title: t(result?.alreadyRunning ? 'serversOverview.alreadyRunningTitle' : 'serversOverview.startedTitle', { name }) })
      } else if (action === 'stop') {
        const result = await serversApi.stop(server.id)
        toast(result?.alreadyStopped
          ? { title: t('serversOverview.alreadyStoppedTitle', { name }) }
          : { title: t('serversOverview.stopRequestedTitle', { name }), description: t('serversOverview.stopRequestedDesc') })
      } else {
        await serversApi.restart(server.id, RESTART_WARNING_MINUTES)
        // The outcome comes later, as the Dashboard's own Restart's does.
        toast({ title: t('serversOverview.restartRequestedTitle', { name }), description: t('serversOverview.restartRequestedDesc', { minutes: RESTART_WARNING_MINUTES }) })
      }
    } catch (error) {
      const busy = lifecycleBusyFromError(error)
      if (busy) {
        toast({ title: t('lifecycleBusy.title', { ns: 'shell' }), description: busy })
        return
      }
      toast({
        title: t(`serversOverview.${action}Failed`, { name }),
        description: getUserErrorMessage(error, t('toasts.errorTitle')),
        variant: 'destructive',
      })
    } finally {
      setPending(null)
      void refresh()
    }
  }

  // The scheduled backup's servers: its list, or the active server alone
  // while nobody chose (backupServerIds).
  const scheduledBackupIds = (activeId: string | null) =>
    Array.isArray(backups?.schedule.serverIds)
      ? backups.schedule.serverIds.map(String)
      : activeId !== null ? [activeId] : []
  const handleScheduledBackupChange = async (server: ServerInstance, chosenNow: boolean) => {
    if (!canManageBackups || !backups) return
    const previous = backups
    const next = withAutoStartServer(scheduledBackupIds(activeServerId), server.id, chosenNow)
    setBackups({ ...previous, schedule: { ...previous.schedule, serverIds: next } })
    try {
      await backupApi.updateSettings({ serverIds: next })
      toast({
        title: t(chosenNow ? 'serversOverview.scheduledBackupOnTitle' : 'serversOverview.scheduledBackupOffTitle'),
        description: t(chosenNow ? 'serversOverview.scheduledBackupOnDesc' : 'serversOverview.scheduledBackupOffDesc', { name: server.name || server.serverName }),
      })
    } catch (error) {
      setBackups(previous)
      toast({ title: t('toasts.errorTitle'), description: getUserErrorMessage(error, t('serversOverview.scheduledBackupSaveFailed')), variant: 'destructive' })
    }
  }

  if (!shown) return null

  const autoStartOn = autoStartEnabled(autoStartSettings)
  const chosen = autoStartServerIds(autoStartSettings, activeServerId)
  const restartChosen = restartOnCrashServerIds(autoStartSettings)
  const isActiveServer = (server: ServerInstance) =>
    activeServerId !== null ? String(server.id) === activeServerId : server.isActive
  // The active server first -- with many servers the list scrolls, and the
  // one the rest of the Dashboard shows stays in view -- then My Servers order.
  const ordered = [...servers.filter(isActiveServer), ...servers.filter((server) => !isActiveServer(server))]
  const confirmName = toConfirm ? toConfirm.server.name || toConfirm.server.serverName : ''
  // What the servers that start together share: the machine's memory and
  // its ports.
  const startingTogether = autoStartOn ? servers.filter((server) => !server.isRemote && chosen.includes(String(server.id))) : []
  const heapTogetherGb = heapOfServers(startingTogether)
  const hostGb = hostMemoryBytes ? hostMemoryBytes / BYTES_PER_GB : null
  const heapOver = hostGb !== null && startingTogether.length > 1 && heapTogetherGb > hostGb
  const conflicts = portConflicts(startingTogether)
  const memoryInUse = Object.values(statuses).reduce((sum, row) => sum + (row.running && row.memoryBytes ? row.memoryBytes : 0), 0)
  const backupIds = scheduledBackupIds(activeServerId)
  const lastBackupOf = (id: string) => backups?.servers.find((entry) => String(entry.serverId) === id)?.lastBackupAt ?? null
  const nameOf = (server: ServerInstance) => server.name || server.serverName

  const actionButton = (server: ServerInstance, action: ServerAction) => {
    const id = String(server.id)
    const name = server.name || server.serverName
    const Icon = action === 'start' ? Play : action === 'stop' ? Square : RotateCcw
    const busy = lifecycleBusyReason(lifecycleState, id, action)
    return (
      <DisabledReason key={action} reason={!canControl ? t('actions.noPermissionControl') : busy}>
        <Button
          size="sm"
          variant="outline"
          className={cn(
            'h-7 gap-1.5 px-2 text-xs',
            action === 'start' && 'border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300',
            action === 'stop' && 'border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300',
            action === 'restart' && 'border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300',
          )}
          disabled={!canControl || pending !== null || busy !== null}
          onClick={() => (action === 'start' ? runAction(server, action) : setToConfirm({ server, action }))}
          aria-label={t(`serversOverview.${action}Aria`, { name })}
        >
          {pending?.id === id && pending.action === action
            ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            : <Icon className="h-3 w-3" aria-hidden="true" />}
          {t(`actions.${action}`)}
        </Button>
      </DisabledReason>
    )
  }

  return (
    <SectionCard
      id="servers-overview"
      title={t('serversOverview.heading')}
      icon={ServerIcon}
      density="compact"
      flush
      status={
        <span className="flex items-center gap-3 text-xs tabular-nums text-muted-foreground">
          {hostGb !== null && memoryInUse > 0 && (
            <span title={t('serversOverview.memoryTotalTitle')}>
              {t('serversOverview.memoryTotal', { used: formatGb(memoryInUse), host: hostGb.toFixed(1) })}
            </span>
          )}
          <span>
          {t('serversOverview.runningCount', {
            running: servers.filter((server) => rowState(server, statuses[String(server.id)], rcon[String(server.id)]) === 'running').length,
            total: servers.length,
          })}
          </span>
        </span>
      }
    >
      {(heapOver || conflicts.length > 0) && (
        <div className="space-y-1 border-b border-border/60 bg-warning/[0.06] px-4 py-2 text-xs text-warning" role="note">
          {heapOver && (
            <p>{t('serversOverview.heapOver', { heap: heapTogetherGb, host: hostGb?.toFixed(1) })}</p>
          )}
          {conflicts.map((conflict) => (
            <p key={`${conflict.kind}-${conflict.first.id}-${conflict.second.id}`}>
              {conflict.kind === 'game'
                ? t('serversOverview.gamePortConflict', {
                    first: nameOf(conflict.first), second: nameOf(conflict.second),
                    firstPort: conflict.first.serverPort, secondPort: conflict.second.serverPort,
                  })
                : t('serversOverview.rconPortConflict', {
                    first: nameOf(conflict.first), second: nameOf(conflict.second), port: conflict.first.rconPort,
                  })}
            </p>
          ))}
        </div>
      )}
      {/* About six rows, then it scrolls (many installed or linked servers).
          Focusable so the keyboard can scroll it too. */}
      <ul
        data-testid="servers-overview-list"
        tabIndex={0}
        aria-label={t('serversOverview.heading')}
        className="divide-y divide-border/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring sm:max-h-[24rem] sm:overflow-y-auto sm:overscroll-contain"
      >
        {ordered.map((server) => {
          const id = String(server.id)
          const status = statuses[id]
          const rconRow = rcon[id]
          const state = rowState(server, status, rconRow)
          const isActive = isActiveServer(server)
          // A local server the scan confirms stopped has nobody on it: what
          // answers on its RCON port is another server sharing that port.
          const players = rconRow?.status === 'connected' && state !== 'stopped' ? rconRow.players ?? null : null
          const name = server.name || server.serverName
          const checkboxId = `servers-overview-autostart-${id}`
          const restartCheckboxId = `servers-overview-restart-${id}`
          const backupCheckboxId = `servers-overview-backup-${id}`
          const update = updates[id]
          const lastBackupAt = lastBackupOf(id)
          const backedUpOnSchedule = Boolean(backups?.schedule.enabled) && backupIds.includes(id)
          // The active server's Start/Stop/Restart are the Dashboard's own; a
          // remote one is run by its host; an unknown state offers neither.
          const actions: ServerAction[] = isActive || server.isRemote || state === 'unknown'
            ? []
            : state === 'running' ? ['stop', 'restart'] : ['start']
          return (
            <li key={id} className="space-y-2 px-4 py-2.5">
              {/* What the server is and does on top, with its actions at the
                  end; its options below, so a phone-width row stays readable. */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex min-w-0 flex-1 basis-48 items-center gap-2.5">
                  <span
                    className={cn(
                      'h-2 w-2 shrink-0 rounded-full',
                      state === 'running' ? 'bg-success' : state === 'unknown' ? 'bg-warning' : 'bg-muted-foreground/40',
                    )}
                    aria-hidden="true"
                  />
                  <span className="truncate text-sm font-medium" title={name}>{name}</span>
                  {isActive && (
                    <span className="inline-flex shrink-0 items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                      {t('serversOverview.activeBadge')}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className={cn(state === 'running' && 'text-success/80', state === 'unknown' && 'text-warning/80')}>
                    {t(`serversOverview.state.${state}`)}
                  </span>
                  {state === 'running' && !server.isRemote && <ServerUptime startedAt={status?.startedAt} />}
                  <span
                    className="inline-flex items-center gap-1 tabular-nums"
                    title={players !== null ? t('serversOverview.playersTitle', { players }) : t('serversOverview.playersUnknown')}
                  >
                    <Users className="h-3 w-3" aria-hidden="true" />
                    <span className="sr-only">
                      {players !== null ? t('serversOverview.playersTitle', { players }) : t('serversOverview.playersUnknown')}
                    </span>
                    <span aria-hidden="true">{players ?? '–'}</span>
                  </span>
                  <span className="font-mono tabular-nums" title={t('serversOverview.gamePortTitle')}>:{server.serverPort}</span>
                  {state === 'running' && typeof status?.memoryBytes === 'number' && (
                    <span className="inline-flex items-center gap-1 tabular-nums" title={t('serversOverview.memoryTitle', { max: server.maxMemory })}>
                      <MemoryStick className="h-3 w-3" aria-hidden="true" />
                      {t('serversOverview.memory', { gb: formatGb(status.memoryBytes) })}
                    </span>
                  )}
                  {(update?.mods?.outdated?.length ?? 0) > 0 && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] text-warning"
                      title={update!.mods!.outdated.map((mod) => mod.name).join(', ')}
                    >
                      <Package className="h-3 w-3" aria-hidden="true" />
                      {t('serversOverview.modsOutdated', { mods: update!.mods!.outdated.length })}
                    </span>
                  )}
                  {update?.game?.updateAvailable && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] text-warning"
                      title={t('serversOverview.gameUpdateTitle', { installed: update.game.installedBuild, latest: update.game.latestBuild })}
                    >
                      <Download className="h-3 w-3" aria-hidden="true" />
                      {t('serversOverview.gameUpdate')}
                    </span>
                  )}
                  {status?.disk && (status.disk.warning || status.disk.critical) && (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]',
                        status.disk.critical ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-warning/30 bg-warning/10 text-warning',
                      )}
                      title={t('serversOverview.diskTitle', { free: formatGb(status.disk.freeBytes) })}
                    >
                      <HardDrive className="h-3 w-3" aria-hidden="true" />
                      {t('serversOverview.disk', { percent: Math.round(status.disk.usedPercent) })}
                    </span>
                  )}
                </div>
                {(actions.length > 0 || !isActive) && (
                  <div className="ms-auto flex flex-wrap items-center gap-1.5">
                    {actions.map((action) => actionButton(server, action))}
                    {!isActive && (
                      <DisabledReason reason={!canSwitch ? t('serversOverview.noPermissionSwitch') : lifecycleBusyReason(lifecycleState, id, 'switch')}>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1.5 px-2 text-xs"
                          disabled={!canSwitch || switching !== null || lifecycleBusyReason(lifecycleState, id, 'switch') !== null}
                          onClick={() => handleSwitch(server)}
                          aria-label={t('serversOverview.showAria', { name })}
                        >
                          {switching === id
                            ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                            : <ArrowRightLeft className="h-3 w-3" aria-hidden="true" />}
                          {t('serversOverview.show')}
                        </Button>
                      </DisabledReason>
                    )}
                  </div>
                )}
              </div>
              {!server.isRemote && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <DisabledReason reason={!canChangeAutoStart ? t('actions.noPermissionAutoStart') : null}>
                      <Checkbox
                        id={checkboxId}
                        checked={autoStartOn && chosen.includes(id)}
                        disabled={!canChangeAutoStart}
                        onCheckedChange={(checked) => onAutoStartChange(server, checked === true)}
                      />
                    </DisabledReason>
                    <Label htmlFor={checkboxId} className="cursor-pointer text-[11px] text-muted-foreground">
                      {t('serversOverview.autoStartLabel')}
                    </Label>
                  </div>
                  <div className="flex items-center gap-1.5" title={t('serversOverview.restartOnCrashHint')}>
                    <DisabledReason reason={!canChangeAutoStart ? t('actions.noPermissionAutoStart') : null}>
                      <Checkbox
                        id={restartCheckboxId}
                        checked={restartChosen.includes(id)}
                        disabled={!canChangeAutoStart}
                        onCheckedChange={(checked) => onRestartOnCrashChange(server, checked === true)}
                      />
                    </DisabledReason>
                    <Label htmlFor={restartCheckboxId} className="cursor-pointer text-[11px] text-muted-foreground">
                      {t('serversOverview.restartOnCrashLabel')}
                    </Label>
                  </div>
                  {backups && (
                    <div className="flex items-center gap-1.5">
                      <DisabledReason
                        reason={!canManageBackups ? t('serversOverview.noPermissionBackups')
                          : !backups.schedule.enabled ? t('serversOverview.scheduledBackupsOff')
                          : null}
                      >
                        <Checkbox
                          id={backupCheckboxId}
                          checked={backupIds.includes(id)}
                          disabled={!canManageBackups || !backups.schedule.enabled}
                          onCheckedChange={(checked) => handleScheduledBackupChange(server, checked === true)}
                        />
                      </DisabledReason>
                      <Label htmlFor={backupCheckboxId} className="cursor-pointer text-[11px] text-muted-foreground">
                        {t('serversOverview.scheduledBackupLabel')}
                      </Label>
                      <span className={cn('text-[11px]', backedUpOnSchedule || lastBackupAt ? 'text-muted-foreground/70' : 'text-warning')}>
                        {lastBackupAt
                          ? t('serversOverview.lastBackup', { age: ageOf(t as never, lastBackupAt) })
                          : t('serversOverview.noBackup')}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <AlertDialog open={toConfirm !== null} onOpenChange={(open) => !open && setToConfirm(null)}>
        <AlertDialogContent className="glass border-border/50">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-3 text-xl">
              <AlertTriangle className="h-5 w-5 text-warning" aria-hidden="true" />
              {toConfirm?.action === 'restart'
                ? t('serversOverview.confirmRestartTitle', { name: confirmName })
                : t('serversOverview.confirmStopTitle', { name: confirmName })}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-base">
              {toConfirm?.action === 'restart' ? t('confirm.restartServer.description') : t('confirm.stopServer.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-2">
            <AlertDialogCancel className="mt-0">{t('confirm.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className={cn(buttonVariants({ variant: 'warning' }))}
              onClick={() => {
                const target = toConfirm
                setToConfirm(null)
                if (target) void runAction(target.server, target.action)
              }}
            >
              {toConfirm?.action === 'restart' ? t('actions.restart') : t('actions.stop')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  )
}
