import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
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
  Pencil,
  Loader2,
  AlertCircle,
  ChevronDown,
  HelpCircle,
  Search,
  SearchX
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
import { getUserErrorMessage } from '@/lib/errorMessage'
import { resolveRegisteredTranslation } from '@/lib/paramTranslation'
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
import { resolveServerRunning } from '@/lib/serverStatus'
import { EmptyState } from '@/components/EmptyState'
import { NumberInput } from '@/components/NumberInput'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { DisabledReason } from '@/components/DisabledReason'
import { HelpTip } from '@/components/HelpTip'
import { useAuth } from '@/contexts/AuthContext'
import { cn } from '@/lib/utils'

const RESTART_WARNING_LOCALES = ['en', 'zh-CN', 'fr', 'de', 'es', 'ht'] as const

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

function getWeekDays(t: TFunction) {
  return [
    { value: '1', short: t('weekdays.mon.short'), name: t('weekdays.mon.name') },
    { value: '2', short: t('weekdays.tue.short'), name: t('weekdays.tue.name') },
    { value: '3', short: t('weekdays.wed.short'), name: t('weekdays.wed.name') },
    { value: '4', short: t('weekdays.thu.short'), name: t('weekdays.thu.name') },
    { value: '5', short: t('weekdays.fri.short'), name: t('weekdays.fri.name') },
    { value: '6', short: t('weekdays.sat.short'), name: t('weekdays.sat.name') },
    { value: '0', short: t('weekdays.sun.short'), name: t('weekdays.sun.name') },
  ]
}

function getCommonCommands(t: TFunction) {
  return [
    { label: t('commands.restartServer'), value: 'restart' },
    { label: t('commands.saveWorld'), value: 'save' },
    { label: t('commands.serverMessage'), value: 'servermsg Server maintenance in progress' },
    { label: t('commands.checkModUpdates'), value: 'checkModsNeedUpdate' },
    // PanelBridge actions \u2014 routed through the Lua mod via `bridge:<action>`.
    // JSON args after the action name are validated server-side.
    { label: t('commands.triggerBlizzard'), value: 'bridge:triggerBlizzard {"duration":2}' },
    { label: t('commands.triggerStorm'), value: 'bridge:triggerStorm {"duration":1}' },
    { label: t('commands.triggerTropicalStorm'), value: 'bridge:triggerTropicalStorm {"duration":1}' },
    { label: t('commands.stopAllWeather'), value: 'bridge:stopWeather' },
    { label: t('commands.startRain'), value: 'bridge:startRain {"intensity":0.7}' },
    { label: t('commands.stopRain'), value: 'bridge:stopRain' },
    { label: t('commands.restoreUtilities'), value: 'bridge:restoreUtilities' },
    { label: t('commands.shutOffUtilities'), value: 'bridge:shutOffUtilities' },
    { label: t('commands.saveWorldBridge'), value: 'bridge:saveWorld' },
    { label: t('commands.broadcastServerChat'), value: 'bridge:sendToServerChat {"message":"Scheduled broadcast"}' },
  ]
}

// No pagination on this panel -- when a fetch returns exactly this many
// rows, older executions may exist and be silently excluded (server
// retains up to 500, see server/database/init.js). A hint, not a hard
// truth: hitting the limit exactly by coincidence is possible too.
const EXECUTION_HISTORY_FETCH_LIMIT = 50

// Timezone picker's candidate pool (2026-08-31, whitespace/picker card).
// Intl.supportedValuesOf('timeZone') is deliberately NOT the sole source of
// truth here -- server/utils/cronValidation.js's isValidIanaTimezone()
// already documents that this canonical list is narrower than what
// Intl.DateTimeFormat (and therefore node-cron) actually accepts, and
// omits some valid legacy/alias names real installs use. Confirmed
// concretely: 'UTC' itself -- the exact fallback value this page's own
// status object reports and the server's own invalid-timezone error message
// cites as an example -- is NOT in supportedValuesOf()'s output. Prepended
// by hand rather than pulled from a second Intl call so the gap is explicit
// and doesn't silently reappear if ICU data changes again. Computed once at
// module load, not per-render or per-mount.
//
// Typed via a local cast, not a tsconfig "lib" bump: this project's ts
// target (ES2020) predates the ES2022 Intl types that declare
// supportedValuesOf, but the method itself has shipped in every real engine
// (Node 18+, all evergreen browsers) since well before that -- a runtime
// feature gap, not a real absence, so a narrow cast here is more honest than
// widening "lib" project-wide for one call site.
type IntlWithSupportedValuesOf = typeof Intl & {
  supportedValuesOf?: (key: 'timeZone') => string[]
}

const TIMEZONE_POOL: string[] = (() => {
  let canonical: string[] = []
  try {
    const supportedValuesOf = (Intl as IntlWithSupportedValuesOf).supportedValuesOf
    if (typeof supportedValuesOf === 'function') {
      canonical = supportedValuesOf('timeZone')
    }
  } catch {
    // Unsupported engine (pre-2022 Safari, etc.) -- degrade to just the
    // hand-picked entries below rather than crashing the whole page.
  }
  return Array.from(new Set(['UTC', ...canonical]))
})()

// Groups by the IANA area prefix ("America/New_York" -> "America"). A zone
// with no "/" (currently only the hand-added 'UTC') becomes its own
// single-entry group labeled with the zone name itself.
function timezoneGroup(zone: string): string {
  const slash = zone.indexOf('/')
  return slash === -1 ? zone : zone.slice(0, slash).replace(/_/g, ' ')
}

interface TimezonePickerProps {
  id: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

// Searchable timezone combobox. Deliberately built on a single always-
// present <input> (not a separate closed-trigger + hidden-search-input
// split like ItemPicker/VehiclePicker) so the input's value IS the
// committed value at every moment -- typing both filters the dropdown AND
// sets the real value, so a saved zone that isn't in TIMEZONE_POOL (a
// dropped legacy name, or this panel restored from another machine) is
// still shown verbatim rather than getting silently blanked or reset.
function TimezonePicker({ id, value, onChange, disabled }: TimezonePickerProps) {
  const { t } = useTranslation('scheduler')
  const [open, setOpen] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [dropUp, setDropUp] = useState(false)
  // Opening on a field that already has a saved value (the normal case --
  // this field is seeded from the operator's current zone) must NOT filter
  // the dropdown down to just that one self-match; a "choice picker" needs
  // to show every choice on open. Only real typing narrows the list --
  // false again on every fresh open, so clicking away and back re-browses
  // the full set instead of staying pinned to whatever was last typed.
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => { setHighlightIndex(-1) }, [value, open])

  useEffect(() => {
    if (!open || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    setDropUp(window.innerHeight - rect.bottom < 320)
  }, [open])

  const query = searching ? value.trim().toLowerCase().replace(/_/g, ' ') : ''
  const { visible, grouped } = useMemo(() => {
    if (!query) {
      const groups = new Map<string, string[]>()
      for (const zone of TIMEZONE_POOL) {
        const g = timezoneGroup(zone)
        if (!groups.has(g)) groups.set(g, [])
        groups.get(g)!.push(zone)
      }
      for (const list of groups.values()) list.sort((a, b) => a.localeCompare(b))
      const sortedGroups = Array.from(groups.entries()).sort(([a], [b]) =>
        a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)
      )
      return { visible: sortedGroups.flatMap(([, zones]) => zones), grouped: sortedGroups }
    }
    const filtered = TIMEZONE_POOL
      .filter((z) => z.toLowerCase().replace(/_/g, ' ').includes(query))
      .sort((a, b) => a.localeCompare(b))
    return { visible: filtered, grouped: null as [string, string[]][] | null }
  }, [query])

  const handleSelect = (zone: string) => {
    onChange(zone)
    setOpen(false)
    setHighlightIndex(-1)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightIndex((prev) => Math.min(prev + 1, visible.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightIndex((prev) => Math.max(prev - 1, 0))
        break
      case 'Enter':
        // No fallback to "select the first visible item" on a bare Enter --
        // unlike ItemPicker/VehiclePicker, a value that isn't in the pool is
        // a legitimate outcome here, so an un-highlighted Enter just keeps
        // whatever was typed instead of silently substituting a guess.
        if (highlightIndex >= 0 && highlightIndex < visible.length) {
          e.preventDefault()
          handleSelect(visible[highlightIndex])
        }
        break
      case 'Escape':
        setOpen(false)
        setHighlightIndex(-1)
        break
    }
  }

  useEffect(() => {
    if (highlightIndex < 0 || !listRef.current) return
    const el = listRef.current.querySelector(`[data-tz-index="${highlightIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  const renderOption = (zone: string) => {
    const idx = visible.indexOf(zone)
    return (
      <button
        key={zone}
        type="button"
        role="option"
        id={`${id}-opt-${idx}`}
        aria-selected={zone === value}
        data-tz-index={idx}
        onClick={() => handleSelect(zone)}
        className={cn(
          'w-full px-3 py-1.5 text-start text-xs font-mono truncate motion-safe:transition-colors',
          'hover:bg-accent/10',
          zone === value && 'bg-primary/10 text-primary',
          idx === highlightIndex && 'bg-accent/15'
        )}
      >
        {zone}
      </button>
    )
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" aria-hidden="true" />
        <Input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={`${id}-listbox`}
          aria-autocomplete="list"
          aria-activedescendant={open && highlightIndex >= 0 && visible[highlightIndex] ? `${id}-opt-${highlightIndex}` : undefined}
          value={value}
          onChange={(e) => { onChange(e.target.value); setOpen(true); setSearching(true) }}
          onFocus={(e) => { setOpen(true); setSearching(false); e.target.select() }}
          onKeyDown={handleKeyDown}
          placeholder="America/New_York"
          className="font-mono ps-8 pe-8"
          maxLength={100}
          disabled={disabled}
          autoComplete="off"
        />
        <ChevronDown
          className={cn(
            'pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/60 motion-safe:transition-transform',
            open && 'rotate-180'
          )}
          aria-hidden="true"
        />
      </div>
      {open && !disabled && (
        <div
          className={cn(
            'absolute z-50 w-full min-w-[260px] rounded-md border border-border bg-popover shadow-lg',
            dropUp ? 'bottom-full mb-1' : 'top-full mt-1'
          )}
        >
          <div
            ref={listRef}
            role="listbox"
            id={`${id}-listbox`}
            aria-label={t('timezone.inputLabel')}
            className="max-h-64 overflow-y-auto overscroll-contain py-1"
          >
            {visible.length === 0 ? (
              <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                <SearchX className="w-3.5 h-3.5 shrink-0 opacity-50" aria-hidden="true" />
                {t('timezone.noMatches')}
              </p>
            ) : grouped ? (
              grouped.map(([group, zones]) => (
                <div key={group}>
                  {/* Skip the header for a single-entry group whose only
                      zone IS the group label (currently just 'UTC') --
                      showing "UTC" as both a section header and the one
                      option under it is a redundant, not a clarifying, line. */}
                  {!(zones.length === 1 && zones[0] === group) && (
                    <div className="sticky top-0 z-10 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70 bg-muted/70 backdrop-blur-sm">
                      {group}
                    </div>
                  )}
                  {zones.map(renderOption)}
                </div>
              ))
            ) : (
              visible.map(renderOption)
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function Scheduler() {
  const { t, i18n } = useTranslation('scheduler')
  const weekDays = useMemo(() => getWeekDays(t), [t])
  const commonCommands = useMemo(() => getCommonCommands(t), [t])
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [history, setHistory] = useState<ScheduleHistoryEntry[]>([])
  const [presets, setPresets] = useState<CronPreset[]>([])
  const [servers, setServers] = useState<ServerInstance[]>([])
  const [status, setStatus] = useState<{
    activeTasks: number
    autoRestartEnabled: boolean
    modUpdateRestartPending: boolean
    // Timezone-picker card (2026-08-29, hunt-wave5 follow-up): `timezone`
    // is the EFFECTIVE zone every schedule below actually runs in right
    // now. `configuredTimezone` is the operator's saved choice (normally
    // identical). `timezoneFallback` is non-null only when the saved zone
    // stopped being valid (tzdata dropped a deprecated name, or db.json
    // was restored from a different machine) -- the panel falls back to
    // the process default rather than refusing to schedule, and this is
    // how the UI shows that mismatch instead of staying quiet about it.
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

  // New task form
  const [newTaskName, setNewTaskName] = useState('')
  const [newTaskCron, setNewTaskCron] = useState('')
  const [newTaskCommand, setNewTaskCommand] = useState('')
  const [newTaskServerId, setNewTaskServerId] = useState<string>('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null)

  // Advisory-only preview of the custom cron field via POST /validate-cron --
  // never gates Save. The server re-validates independently and is the real
  // source of truth, so a failed/slow preview call must never block or
  // second-guess what create/update will actually decide.
  const [cronValidation, setCronValidation] = useState<{ valid: boolean; error?: string; code?: string } | null>(null)
  const cronValidationIdRef = useRef(0)

  // Simple Scheduler State
  const [scheduleMode, setScheduleMode] = useState<'simple' | 'advanced'>('simple')
  const [simpleIntervalType, setSimpleIntervalType] = useState<'hourly' | 'daily' | 'weekly' | 'interval'>('daily')
  const [simpleHour, setSimpleHour] = useState('06')
  const [simpleMinute, setSimpleMinute] = useState('00')
  const [simpleHoursInterval, setSimpleHoursInterval] = useState('4')
  const [simpleWeekday, setSimpleWeekday] = useState('1')

  // Restart form
  const [restartMinutes, setRestartMinutes] = useState(5)
  const [serverRunning, setServerRunning] = useState<boolean>(false)

  const fetchData = useCallback(async () => {
    setFetchError(null)
    try {
      // Only getTasks() is allowed to fail the whole load -- it's the one
      // thing this page can't function without. The other three used to have
      // no catch of their own, so an unrelated hiccup (e.g. the presets or
      // history endpoint 500ing) rejected the entire Promise.all and threw
      // away a perfectly good task list, replacing it with an empty-state
      // "no tasks scheduled" even though real tasks existed and loaded fine.
      const [tasksData, presetsData, statusData, historyData, serversData] = await Promise.all([
        schedulerApi.getTasks(),
        schedulerApi.getCronPresets().catch(() => ({ presets: [] as CronPreset[] })),
        schedulerApi.getStatus().catch(() => null),
        schedulerApi.getHistory(EXECUTION_HISTORY_FETCH_LIMIT).catch(() => ({ history: [] as ScheduleHistoryEntry[] })),
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
      setFetchError(getUserErrorMessage(error, t('fetchError.fallback')))
    } finally {
      setInitialLoading(false)
    }
  }, [t])

  useEffect(() => {
    fetchData()
  }, [fetchData])

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

  // Preview the custom cron field as the operator types, so an invalid
  // expression is caught here instead of only on Save. Advanced-only: the
  // simple builder always produces a cron string it already knows is valid,
  // so validating it too would just be an extra request for no signal.
  // Debounced via the effect's own cleanup (a new keystroke cancels the
  // still-pending timer before it fires) -- but that alone doesn't cover a
  // slower-typed request resolving AFTER a faster-typed later one, so the
  // generation counter below still gates every state update. Same
  // shape as the fetch-race hunt's loadIdRef fixes tonight, applied to a
  // debounce instead of a mount-triggered fetch.
  useEffect(() => {
    if (scheduleMode !== 'advanced' || !newTaskCron.trim()) {
      setCronValidation(null)
      return
    }
    const validationId = ++cronValidationIdRef.current
    const timer = setTimeout(() => {
      schedulerApi.validateCron(newTaskCron)
        .then((result) => {
          if (cronValidationIdRef.current !== validationId) return
          setCronValidation(result)
        })
        // Advisory only -- a failed preview call says nothing about whether
        // the expression is actually valid, so it clears any stale verdict
        // rather than showing a wrong one. Save still works either way: the
        // server validates independently at submit time.
        .catch(() => {
          if (cronValidationIdRef.current !== validationId) return
          setCronValidation(null)
        })
    }, 400)
    return () => clearTimeout(timer)
  }, [newTaskCron, scheduleMode])

  // Poll server status so Manual Restart / Quick Broadcasts stay accurate.
  // Skipped while the tab is hidden to avoid pointless work in background tabs.
  //
  // GH#114-shaped (2026-09-08, Angela's is-running enumeration): this used
  // to trust serverApi.getStatus()'s raw local process scan unconditionally,
  // which can only ever see a process on THIS host -- a docker-managed
  // server's process runs in a different container the scan can't see at
  // all, and a remote-sftp server isn't on this host to begin with. Either
  // one would leave serverRunning permanently false, disabling Manual
  // Restart and Quick Broadcasts on a server that is genuinely up -- a
  // legitimate-action-blocked bug, the mirror image of the Stop-button
  // version of this same defect. resolveServerRunning() shares
  // ServerConfig.tsx's provider-aware fix; null (indeterminate) is treated
  // as "may be running" (`!== false`, same collapse ServerConfig.tsx's own
  // serverMayBeRunning uses) rather than disabling these non-destructive
  // actions on an uncertain read -- restarting an already-stopped server or
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

  // Resolve a task's target server name for display — "Unknown server" if
  // it was deleted since the task was created, "This server" (no badge
  // shown, just falls back cleanly) if server_id is unset (legacy/no
  // multi-server setup yet).
  const getServerLabel = (serverId: string | number | null): string | null => {
    if (!serverId) return null
    const match = servers.find((s) => String(s.id) === String(serverId))
    return match ? (match.name || match.serverName || `Server ${serverId}`) : t('scheduledTasks.unknownServer')
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
    if (simpleIntervalType === 'weekly') {
      return `${clamp(simpleMinute, 0, 59, 0)} ${clamp(simpleHour, 0, 23, 0)} * * ${simpleWeekday}`
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
        title: t('toasts.errorTitle'),
        description: t('toasts.fillAllFields'),
        variant: 'destructive',
      })
      return
    }

    // Validate the cron expression against the server's own validator
    // (scheduler-cron-client-validator-weaker-than-server) -- a local regex
    // here used to diverge from node-cron's real rules in both directions:
    // it accepted out-of-range/too-frequent/impossible-date expressions the
    // server rejects (a green tick that fails one round-trip later), and it
    // rejected named months/weekdays and L/W/#-token expressions the server
    // happily accepts (denying the operator a schedule they were entitled
    // to). Delegating to the same /validate-cron endpoint the live preview
    // above already calls gets exact parity by construction instead of
    // hand-porting node-cron's bounds/name tables and keeping them in sync.
    try {
      const cronCheck = await schedulerApi.validateCron(cronToUse)
      if (!cronCheck.valid) {
        toast({
          title: t('toasts.invalidScheduleTitle'),
          description:
            (cronCheck.code && resolveRegisteredTranslation('errors', cronCheck.code, undefined)) ||
            cronCheck.error ||
            t('toasts.invalidCronDesc', { cron: cronToUse }),
          variant: 'destructive',
        })
        return
      }
    } catch {
      // Pre-check unreachable (network/500) -- fall through and let
      // create/update's own server-side validation be the final word,
      // same advisory-only philosophy as the live preview above.
    }

    setLoading(true)
    try {
      if (editingTask) {
        await schedulerApi.updateTask(
          editingTask.id,
          newTaskName,
          cronToUse,
          newTaskCommand,
          !!editingTask.enabled,
          newTaskServerId || undefined,
        )
      } else {
        await schedulerApi.createTask(newTaskName, cronToUse, newTaskCommand, newTaskServerId || undefined)
      }
      toast({
        title: t('toasts.successTitle'),
        description: editingTask ? t('toasts.taskUpdated') : t('toasts.taskCreated'),
        variant: 'success' as const,
      })
      resetTaskForm()
      setDialogOpen(false)
      fetchData()
    } catch (error) {
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, editingTask ? t('toasts.taskUpdateFailedFallback') : t('toasts.taskCreateFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const resetTaskForm = () => {
    setEditingTask(null)
    setNewTaskName('')
    setNewTaskCron('')
    setNewTaskCommand('')
    // Re-default to the active server rather than blanking the field — otherwise
    // every task after the first requires a manual reselect, and a task created
    // with no target silently follows whichever server is active when it fires
    // instead of the one the operator was looking at.
    setNewTaskServerId(() => {
      const active = servers.find((s) => s.isActive)
      return active ? String(active.id) : (servers[0] ? String(servers[0].id) : '')
    })
    setScheduleMode('simple')
    setSimpleIntervalType('daily')
    setSimpleHour('06')
    setSimpleMinute('00')
    setSimpleHoursInterval('4')
    setSimpleWeekday('1')
  }

  // Reopen an existing schedule in the builder when its cron matches one the
  // simple tab can express; anything else falls back to the raw cron field.
  const applyCronToForm = (cronExpression: string) => {
    setNewTaskCron(cronExpression)
    const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cronExpression)
    if (daily) {
      setScheduleMode('simple')
      setSimpleIntervalType('daily')
      setSimpleMinute(daily[1])
      setSimpleHour(daily[2])
      return
    }
    const weekly = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/.exec(cronExpression)
    if (weekly) {
      setScheduleMode('simple')
      setSimpleIntervalType('weekly')
      setSimpleMinute(weekly[1])
      setSimpleHour(weekly[2])
      setSimpleWeekday(weekly[3])
      return
    }
    if (/^0 \* \* \* \*$/.test(cronExpression)) {
      setScheduleMode('simple')
      setSimpleIntervalType('hourly')
      return
    }
    const interval = /^0 \*\/(\d{1,2}) \* \* \*$/.exec(cronExpression)
    if (interval) {
      setScheduleMode('simple')
      setSimpleIntervalType('interval')
      setSimpleHoursInterval(interval[1])
      return
    }
    setScheduleMode('advanced')
  }

  const handleEditTask = (task: ScheduledTask) => {
    setEditingTask(task)
    setNewTaskName(task.name)
    setNewTaskCommand(task.command)
    setNewTaskServerId(task.server_id != null ? String(task.server_id) : '')
    applyCronToForm(task.cron_expression)
    setDialogOpen(true)
  }

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

  const handleRestartNow = async () => {
    setLoading(true)
    try {
      const result = await schedulerApi.restartNow(restartMinutes)
      const applied = result.warningMinutes
      // The NumberInput's min/max are decorative (native <input> attrs
      // only, no client-side clamp function passed) -- an operator can type
      // past them, and the server silently caps at 60. Compare what was
      // requested against what the server actually used instead of just
      // echoing back the client's own state, which used to say e.g. "500
      // minutes" when the real countdown was 60.
      if (applied !== restartMinutes) {
        toast({
          title: t('toasts.restartInitiatedTitle'),
          description: t('toasts.restartMinutesClampedDesc', { requested: restartMinutes, applied }),
          variant: 'warning' as const,
        })
      } else {
        toast({
          title: t('toasts.restartInitiatedTitle'),
          // Pre-existing bug, caught while touching this code (2026-08-27):
          // restartInitiatedDesc/_WithWarningsDesc are pluralized keys
          // (_one/_other), which i18next only resolves via a `count` param
          // -- passing `minutes` alone silently returned the raw key
          // string, invisible until something actually asserted on the
          // rendered toast text.
          description: t('toasts.restartInitiatedDesc', { count: applied, minutes: applied }),
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

  const handleRestartWithWarning = async (minutes: number) => {
    setLoading(true)
    try {
      const result = await schedulerApi.restartNow(minutes)
      toast({
        title: t('toasts.restartInitiatedTitle'),
        description: t('toasts.restartInitiatedWithWarningsDesc', { count: result.warningMinutes, minutes: result.warningMinutes }),
        variant: 'success' as const,
      })
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



  if (initialLoading) {
    return (
      <div className="flex items-center justify-center min-h-[320px] py-12">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-4 page-transition">
      {fetchError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('fetchError.title')}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0 break-words" dir="auto">{fetchError}</span>
            <Button variant="outline" size="sm" onClick={fetchData} className="self-start">
              <RefreshCw className="me-2 h-4 w-4" /> {t('fetchError.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) resetTaskForm()
        }}
      >
        <PageHeader
          title={t('pageHeader.title')}
          description={t('pageHeader.description')}
          eyebrow={t('pageHeader.eyebrow')}
          tone="maintain"
          icon={<Clock className="w-5 h-5" />}
          actions={
            <DialogTrigger asChild>
              <Button variant="command" onClick={resetTaskForm}>
                <Plus className="w-4 h-4 me-2" />
                {t('pageHeader.newTask')}
              </Button>
            </DialogTrigger>
          }
        />
        <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingTask ? t('dialog.editTitle') : t('dialog.createTitle')}</DialogTitle>
              <DialogDescription>
                {editingTask
                  ? t('dialog.editDescription', { name: editingTask.name })
                  : t('dialog.createDescription')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>{t('dialog.taskNameLabel')}</Label>
                <Input
                  value={newTaskName}
                  onChange={(e) => setNewTaskName(e.target.value)}
                  placeholder={t('dialog.taskNamePlaceholder')}
                  maxLength={100}
                />
              </div>
              <div>
                <Label className="mb-2 block">{t('dialog.scheduleTypeLabel')}</Label>
                <Tabs value={scheduleMode} onValueChange={(v: string) => setScheduleMode(v as 'simple' | 'advanced')} className="w-full">
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="simple">{t('dialog.tabSimple')}</TabsTrigger>
                    <TabsTrigger value="advanced">{t('dialog.tabAdvanced')}</TabsTrigger>
                  </TabsList>

                  <TabsContent value="simple" className="space-y-4 pt-4 border rounded-md p-4 mt-0 border-t-0 rounded-t-none">
                    <div className="space-y-2">
                      <Label>{t('dialog.frequencyLabel')}</Label>
                      <Select value={simpleIntervalType} onValueChange={(v) => setSimpleIntervalType(v as 'hourly' | 'daily' | 'weekly' | 'interval')}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="hourly">{t('dialog.freqHourly')}</SelectItem>
                          <SelectItem value="interval">{t('dialog.freqInterval')}</SelectItem>
                          <SelectItem value="daily">{t('dialog.freqDaily')}</SelectItem>
                          <SelectItem value="weekly">{t('dialog.freqWeekly')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {status?.timezone && (
                      <p className="text-xs text-muted-foreground">
                        {t('dialog.timezoneNotice', { tz: status.timezone })}
                      </p>
                    )}

                    {simpleIntervalType === 'weekly' && (
                      <div className="space-y-2">
                        <Label>{t('dialog.dayOfWeekLabel')}</Label>
                        <div className="grid grid-cols-4 gap-2 sm:grid-cols-7" role="group" aria-label={t('dialog.dayOfWeekAria')}>
                          {weekDays.map((day) => {
                            const selected = simpleWeekday === day.value
                            return (
                              <Button
                                key={day.value}
                                type="button"
                                variant={selected ? 'default' : 'outline'}
                                size="sm"
                                className="h-10 px-2 text-[11px] tracking-[0.12em]"
                                aria-pressed={selected}
                                aria-label={day.name}
                                onClick={() => setSimpleWeekday(day.value)}
                              >
                                {day.short}
                              </Button>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {(simpleIntervalType === 'daily' || simpleIntervalType === 'weekly') && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>{t('dialog.hourLabel')}</Label>
                          <Input
                            type="number"
                            min={0}
                            max={23}
                            value={simpleHour}
                            onChange={e => setSimpleHour(e.target.value)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>{t('dialog.minuteLabel')}</Label>
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
                        <Label>{t('dialog.everyXHoursLabel')}</Label>
                        <Input
                          type="number"
                          min={1}
                          max={23}
                          value={simpleHoursInterval}
                          onChange={e => setSimpleHoursInterval(e.target.value)}
                          placeholder={t('dialog.everyXHoursPlaceholder')}
                        />
                      </div>
                    )}

                    <div className="bg-muted p-3 rounded text-xs flex items-center justify-between">
                      <span className="text-muted-foreground">{t('dialog.generatedCronLabel')}</span>
                      <code className="font-mono bg-background px-2 py-1 rounded border">
                        {buildSimpleCron()}
                      </code>
                    </div>
                  </TabsContent>

                  <TabsContent value="advanced" className="space-y-3 pt-4 border rounded-md p-4 mt-0 border-t-0 rounded-t-none">
                    <div className="space-y-2">
                      <Label>{t('dialog.loadPresetLabel')}</Label>
                      <Select onValueChange={(value) => setNewTaskCron(value)}>
                        <SelectTrigger>
                          <SelectValue placeholder={t('dialog.loadPresetPlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          {presets.map((preset) => (
                            <SelectItem key={preset.cron} value={preset.cron}>
                              {t('dialog.presetOption', { name: preset.name, cron: preset.cron })}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>{t('dialog.customExpressionLabel')}</Label>
                      <Input
                        value={newTaskCron}
                        onChange={(e) => setNewTaskCron(e.target.value)}
                        placeholder={t('dialog.customExpressionPlaceholder')}
                        className="font-mono"
                        maxLength={100}
                        aria-label={t('dialog.cronExpressionAria')}
                        aria-describedby="cron-format-hint"
                      />
                    </div>
                    <p id="cron-format-hint" className="text-xs text-muted-foreground">
                      {t('dialog.cronFormatHint')}
                    </p>
                    {cronValidation && (
                      <p
                        className={`flex items-center gap-1.5 text-xs ${cronValidation.valid ? 'text-primary' : 'text-destructive'}`}
                        aria-live="polite"
                      >
                        {cronValidation.valid ? (
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        ) : (
                          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        )}
                        {cronValidation.valid
                          ? t('dialog.cronValidExpression')
                          : (cronValidation.code && resolveRegisteredTranslation('errors', cronValidation.code, undefined)) || cronValidation.error}
                      </p>
                    )}
                  </TabsContent>
                </Tabs>
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <Label>{t('dialog.commandLabel')}</Label>
                  <HelpTip label={t('dialog.commandLabel')}>{t('dialog.commandTip')}</HelpTip>
                </div>
                <Select onValueChange={(value) => setNewTaskCommand(value)}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('dialog.commandSelectPlaceholder')} />
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
                  placeholder={t('dialog.commandCustomPlaceholder')}
                  maxLength={2000}
                />
                {newTaskCommand.startsWith('bridge:') && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    <Trans
                      i18nKey="dialog.bridgeFormatHint"
                      t={t}
                      components={{ 1: <code className="text-foreground" />, 2: <code className="ms-1 text-foreground" /> }}
                    />
                  </p>
                )}
              </div>
              <div>
                <Label>{t('dialog.targetServerLabel')}</Label>
                <Select value={newTaskServerId} onValueChange={setNewTaskServerId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('dialog.targetServerPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {servers.map((server) => (
                      <SelectItem key={server.id} value={String(server.id)}>
                        {server.name || server.serverName}
                        {server.isActive ? t('dialog.targetServerActiveSuffix') : ''}
                        {server.isRemote ? t('dialog.targetServerRemoteSuffix') : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {t('dialog.targetServerHelp')}
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleCreateTask} disabled={loading} className="gap-2">
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                {editingTask ? t('dialog.saveChanges') : t('dialog.createTaskButton')}
              </Button>
            </DialogFooter>
          </DialogContent>
      </Dialog>

      {/* Timezone-picker card (2026-08-29, hunt-wave5 follow-up): the
          install-wide zone EVERY schedule below (user tasks, the backup
          job, AUTO_RESTART_CRON) runs in. Migrated automatically on
          upgrade to whatever was already effective, so this section shows
          a real, already-correct value even for an operator who never
          opens it -- it only needs to be touched to CHANGE the zone. */}
      <Card>
        <CardHeader className="p-4 pb-3">
          <div className="flex items-center gap-1.5">
            <CardTitle className="text-base">{t('timezone.title')}</CardTitle>
            <HelpTip label={t('timezone.title')}>{t('timezone.description')}</HelpTip>
          </div>
        </CardHeader>
        <CardContent className="p-4 pt-0 space-y-2">
          {status?.timezoneFallback && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t('timezone.fallbackTitle')}</AlertTitle>
              <AlertDescription>
                {t('timezone.fallbackDesc', {
                  configured: status.timezoneFallback.configured,
                  effective: status.timezoneFallback.effective,
                })}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="scheduler-timezone-input">{t('timezone.inputLabel')}</Label>
              <TimezonePicker
                id="scheduler-timezone-input"
                value={timezoneInput}
                onChange={setTimezoneInput}
                disabled={timezoneSaving}
              />
            </div>
            <Button
              onClick={handleSaveTimezone}
              disabled={timezoneSaving || !timezoneInput.trim() || timezoneInput.trim() === status?.configuredTimezone}
            >
              {timezoneSaving ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : null}
              {t('timezone.saveButton')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('timezone.currentlyEffective', { tz: status?.timezone || '...' })}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 pb-3">
          <div className="flex items-center gap-1.5">
            <CardTitle className="text-base">{t('restartWarning.title')}</CardTitle>
            <HelpTip label={t('restartWarning.title')}>{t('restartWarning.description')}</HelpTip>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0">
          <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
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
                disabled={restartWarningSaving}
              />
              <p className="text-xs text-muted-foreground">{t('restartWarning.templateHint')}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={resetRestartWarningTemplate}
              disabled={restartWarningSaving || !status?.restartWarningPresets?.[restartWarningLocale]}
            >
              {t('restartWarning.presetButton')}
            </Button>
            <Button
              onClick={handleSaveRestartWarning}
              disabled={restartWarningSaving || !restartWarningTemplate.trim()}
            >
              {restartWarningSaving ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : null}
              {t('restartWarning.saveButton')}
            </Button>
          </div>
        </CardContent>
      </Card>

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
            label: t('statusTiles.activeTasks'),
            value: String(activeCount),
            sub: t('statusTiles.totalTasksSub', { count: totalCount }),
            tone: activeCount > 0 ? 'primary' : 'muted',
          },
          {
            icon: <RotateCcw className="w-4 h-4" />,
            label: t('statusTiles.restartTasks'),
            value: restartActive ? t('statusTiles.restartScheduled') : t('statusTiles.restartNone'),
            sub: t('statusTiles.restartTasksSub', { count: restartCount }),
            tone: restartActive ? 'primary' : 'muted',
          },
          {
            icon: <Calendar className="w-4 h-4" />,
            label: t('statusTiles.modUpdateRestart'),
            value: modRestartPending ? t('statusTiles.modUpdatePending') : t('statusTiles.modUpdateNone'),
            sub: t('statusTiles.modUpdateSub'),
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
            {tiles.map(tile => {
              const cls = toneClasses[tile.tone]
              return (
                <Card key={tile.label} className="overflow-hidden">
                  <CardContent className="flex items-center gap-3 p-4">
                    <div className={`grid place-items-center w-10 h-10 rounded-md border ${cls.tile}`} aria-hidden="true">
                      {tile.icon}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{tile.label}</p>
                      <p className={`text-xl font-semibold leading-tight mt-0.5 ${cls.value}`}>{tile.value}</p>
                      <p className="text-[11px] text-muted-foreground/80 mt-0.5 truncate">{tile.sub}</p>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )
      })()}

      {/* Quick Actions — 2-col grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Manual Restart */}
        <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle>{t('manualRestart.title')}</CardTitle>
          <CardDescription>
            {serverRunning
              ? t('manualRestart.descRunning')
              : t('manualRestart.descOffline')}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0 space-y-3">
          {/* Quick Restart Buttons — each triggers an immediate restart with that warning length */}
          <div className="flex flex-wrap gap-2">
            <DisabledReason reason={!canRestartNow ? t('manualRestart.noPermission') : null}>
              <Button
                onClick={() => handleRestartWithWarning(15)}
                disabled={loading || !serverRunning || !canRestartNow}
                variant="outline"
                size="sm"
                // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Restart in 15 minutes with countdown warnings"); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                title={t('manualRestart.restartIn15Title')}
              >
                <Clock className="w-4 h-4 me-2" />
                {t('manualRestart.restartIn15')}
              </Button>
            </DisabledReason>
            <DisabledReason reason={!canRestartNow ? t('manualRestart.noPermission') : null}>
              <Button
                onClick={() => handleRestartWithWarning(10)}
                disabled={loading || !serverRunning || !canRestartNow}
                variant="outline"
                size="sm"
                // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Restart in 10 minutes with countdown warnings"); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                title={t('manualRestart.restartIn10Title')}
              >
                <Clock className="w-4 h-4 me-2" />
                {t('manualRestart.restartIn10')}
              </Button>
            </DisabledReason>
            <DisabledReason reason={!canRestartNow ? t('manualRestart.noPermission') : null}>
              <Button
                onClick={() => handleRestartWithWarning(5)}
                disabled={loading || !serverRunning || !canRestartNow}
                variant="outline"
                size="sm"
                // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Restart in 5 minutes with countdown warnings"); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                title={t('manualRestart.restartIn5Title')}
              >
                <Clock className="w-4 h-4 me-2" />
                {t('manualRestart.restartIn5')}
              </Button>
            </DisabledReason>
            <DisabledReason reason={!canRestartNow ? t('manualRestart.noPermission') : null}>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  disabled={loading || !serverRunning || !canRestartNow}
                  variant="warning"
                  size="sm"
                  // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Restart in 1 minute — short warning, requires confirmation", describing the action's own confirm-dialog behavior, not why it's disabled); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                  title={t('manualRestart.restartIn1Title')}
                >
                  <Clock className="w-4 h-4 me-2" />
                  {t('manualRestart.restartIn1')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('manualRestart.restartIn1DialogTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('manualRestart.restartIn1DialogDesc')}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('manualRestart.cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => handleRestartWithWarning(1)}
                    className="bg-warning text-warning-foreground hover:bg-warning/90"
                  >
                    {t('manualRestart.restartIn1')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            </DisabledReason>
          </div>

          {/* Custom Time */}
          <div className="flex items-end gap-4">
            <div className="flex-1 max-w-xs">
              <Label>{t('manualRestart.customCountdownLabel')}</Label>
              <NumberInput
                value={restartMinutes}
                onChange={setRestartMinutes}
                min={1}
                max={30}
              />
            </div>
            {restartMinutes < 5 ? (
              <DisabledReason reason={!canRestartNow ? t('manualRestart.noPermission') : null}>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button disabled={loading || !serverRunning || !Number.isFinite(restartMinutes) || !canRestartNow} variant="warning">
                    <RotateCcw className="w-4 h-4 me-2" />
                    {t('manualRestart.restartNow')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('manualRestart.shortCountdownDialogTitle', { count: restartMinutes })}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('manualRestart.shortCountdownDialogDesc')}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('manualRestart.cancel')}</AlertDialogCancel>
                    <AlertDialogAction onClick={handleRestartNow} className="bg-warning text-warning-foreground hover:bg-warning/90">
                      {t('manualRestart.confirmShortRestart', { count: restartMinutes })}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              </DisabledReason>
            ) : (
              <DisabledReason reason={!canRestartNow ? t('manualRestart.noPermission') : null}>
                <Button
                  onClick={handleRestartNow}
                  disabled={loading || !serverRunning || !Number.isFinite(restartMinutes) || !canRestartNow}
                  variant="warning"
                >
                  <RotateCcw className="w-4 h-4 me-2" />
                  {t('manualRestart.restartNow')}
                </Button>
              </DisabledReason>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {t('manualRestart.countdownWarningsNote')}
          </p>
        </CardContent>
      </Card>

      {/* Maintenance Mode */}
      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle>{t('quickBroadcasts.title')}</CardTitle>
          <CardDescription>
            {serverRunning
              ? t('quickBroadcasts.descRunning')
              : t('quickBroadcasts.descOffline')}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => handleBroadcast('maintenanceStart', t('broadcastMessages.maintenanceStart'))}
              variant="outline"
              size="sm"
              disabled={broadcastingKey !== null || loading || !serverRunning}
              className="gap-2"
            >
              {broadcastingKey === 'maintenanceStart' && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('quickBroadcasts.maintenanceStart')}
            </Button>
            <Button
              onClick={() => handleBroadcast('maintenanceEnd', t('broadcastMessages.maintenanceEnd'))}
              variant="outline"
              size="sm"
              disabled={broadcastingKey !== null || loading || !serverRunning}
              className="gap-2"
            >
              {broadcastingKey === 'maintenanceEnd' && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('quickBroadcasts.maintenanceEnd')}
            </Button>
            <Button
              onClick={() => handleBroadcast('saveWarning', t('broadcastMessages.saveWarning'))}
              variant="outline"
              size="sm"
              disabled={broadcastingKey !== null || loading || !serverRunning}
              className="gap-2"
            >
              {broadcastingKey === 'saveWarning' && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('quickBroadcasts.saveWarning')}
            </Button>
            <Button
              onClick={() => handleBroadcast('welcome', t('broadcastMessages.welcome'))}
              variant="outline"
              size="sm"
              disabled={broadcastingKey !== null || loading || !serverRunning}
              className="gap-2"
            >
              {broadcastingKey === 'welcome' && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('quickBroadcasts.welcome')}
            </Button>
          </div>
        </CardContent>
      </Card>
      </div>

      {/* Scheduled Tasks */}
      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle>{t('scheduledTasks.title')}</CardTitle>
          <CardDescription>
            {t('scheduledTasks.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <ScrollArea className="h-[300px] sm:h-[400px]">
            {tasks.length === 0 ? (
              <EmptyState type="noSchedule" title={t('scheduledTasks.emptyTitle')} description={t('scheduledTasks.emptyDesc')} />
            ) : (
              <div className="space-y-3">
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    className={`group relative flex flex-col gap-3 p-4 rounded-lg border transition-colors sm:flex-row sm:items-center ${
                      task.enabled
                        ? 'bg-card border-border/60 hover:border-primary/40'
                        : 'bg-muted/30 border-border/40 text-muted-foreground'
                    }`}
                  >
                    <div className="flex flex-1 min-w-0 items-center gap-3">
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
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <h3 className="font-medium truncate text-foreground">{task.name}</h3>
                          {getServerLabel(task.server_id) && (
                            <span
                              className="shrink-0 text-[11px] font-medium bg-primary/10 border border-primary/30 px-1.5 py-0.5 rounded text-primary truncate max-w-[140px]"
                              title={t('scheduledTasks.targetServerTitle', { server: getServerLabel(task.server_id) })}
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
                            {t('scheduledTasks.lastRun', { date: new Date(task.last_run).toLocaleString(i18n.language) })}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 self-end sm:self-auto">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRunNow(task)}
                        disabled={loading || runningTaskId !== null}
                        // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Run task now"); disables only on transient UI state (a page-wide loading flag, or another task already running), not a permission gate -- no DisabledReason-worthy reason to lose. Triaged 2026-08-27.
                        title={t('scheduledTasks.runNowTitle')}
                        aria-label={t('scheduledTasks.runNowAria', { name: task.name })}
                      >
                        {runningTaskId === task.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Play className="w-4 h-4" />
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleEditTask(task)}
                        disabled={loading}
                        // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Edit task"); disables only on the page-wide loading flag, not a permission gate -- no DisabledReason-worthy reason to lose. Triaged 2026-08-27.
                        title={t('scheduledTasks.editTitle')}
                        aria-label={t('scheduledTasks.editAria', { name: task.name })}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Switch
                        checked={!!task.enabled}
                        onCheckedChange={() => handleToggleTask(task)}
                        disabled={loading}
                        aria-label={t('scheduledTasks.toggleAria', { name: task.name })}
                      />
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={loading}
                            aria-label={t('scheduledTasks.deleteAria', { name: task.name })}
                          >
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t('scheduledTasks.deleteDialogTitle')}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {t('scheduledTasks.deleteDialogDesc', { name: task.name })}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t('manualRestart.cancel')}</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleDeleteTask(task.id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              {t('scheduledTasks.deleteConfirm')}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
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
        <CardHeader className="p-4 pb-3">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                <History className="w-5 h-5" />
                {t('executionHistory.title')}
              </CardTitle>
              <CardDescription>
                {t('executionHistory.description')}
                {history.length >= EXECUTION_HISTORY_FETCH_LIMIT && (
                  <span className="block text-xs text-muted-foreground/80">
                    {t('executionHistory.truncatedHint', { count: history.length })}
                  </span>
                )}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={fetchData}
                disabled={loading}
              >
                <RefreshCw className="w-4 h-4 me-1" />
                {t('executionHistory.refresh')}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loading || history.length === 0}
                  >
                    <Trash2 className="w-4 h-4 me-1" />
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
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <ScrollArea className="h-[300px] sm:h-[400px]">
            {history.length === 0 ? (
              <EmptyState type="noSchedule" title={t('executionHistory.emptyTitle')} description={t('executionHistory.emptyDesc')} />
            ) : (
              <div className="space-y-2">
                {history.map((entry) => (
                  <div
                    key={entry.id}
                    className={`p-3 rounded-lg border border-border/40 ${
                      entry.success ? 'bg-card' : 'bg-destructive/[0.06]'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        {entry.success ? (
                          <CheckCircle2 className="w-4 h-4 text-primary flex-shrink-0" aria-hidden="true" />
                        ) : (
                          <XCircle className="w-4 h-4 text-destructive flex-shrink-0" aria-hidden="true" />
                        )}
                        <span className="sr-only">{entry.success ? t('executionHistory.succeeded') : t('executionHistory.failed')}</span>
                        <div>
                          <span className="font-medium">{entry.task_name}</span>
                          <code className="ms-2 text-xs bg-muted px-1.5 py-0.5 rounded">
                            {entry.command}
                          </code>
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(entry.executed_at).toLocaleString(i18n.language)}
                      </span>
                    </div>
                    <div className="mt-1 ms-6 text-sm">
                      {entry.message && (
                        <p className={entry.success ? 'text-muted-foreground' : 'text-destructive'}>
                          {entry.message}
                        </p>
                      )}
                      {entry.duration !== null && (
                        <p className="text-xs text-muted-foreground">
                          {t('executionHistory.duration', { seconds: (entry.duration / 1000).toFixed(1) })}
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
                  <p className="font-medium">{t('cronHelp.minuteLabel')}</p>
                  <p className="text-muted-foreground">{t('cronHelp.minuteRange')}</p>
                </div>
                <div>
                  <p className="font-medium">{t('cronHelp.hourLabel')}</p>
                  <p className="text-muted-foreground">{t('cronHelp.hourRange')}</p>
                </div>
                <div>
                  <p className="font-medium">{t('cronHelp.dayLabel')}</p>
                  <p className="text-muted-foreground">{t('cronHelp.dayRange')}</p>
                </div>
                <div>
                  <p className="font-medium">{t('cronHelp.monthLabel')}</p>
                  <p className="text-muted-foreground">{t('cronHelp.monthRange')}</p>
                </div>
                <div>
                  <p className="font-medium">{t('cronHelp.weekdayLabel')}</p>
                  <p className="text-muted-foreground">{t('cronHelp.weekdayRange')}</p>
                </div>
              </div>
              <div className="mt-4 space-y-2 text-sm">
                <p><Trans i18nKey="cronHelp.anyValue" t={t} components={{ 1: <code className="bg-muted px-1 rounded" /> }} /></p>
                <p><Trans i18nKey="cronHelp.everyNUnits" t={t} components={{ 1: <code className="bg-muted px-1 rounded" /> }} /></p>
                <p><Trans i18nKey="cronHelp.every2HoursExample" t={t} components={{ 1: <code className="bg-muted px-1 rounded" /> }} /></p>
                <p><Trans i18nKey="cronHelp.daily6amExample" t={t} components={{ 1: <code className="bg-muted px-1 rounded" /> }} /></p>
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  )
}
