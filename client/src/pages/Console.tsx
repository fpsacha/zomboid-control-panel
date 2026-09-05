import { useEffect, useState, useRef, useCallback, useMemo, memo } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Terminal as TerminalIcon, Send, Trash2, WifiOff, Loader2, Megaphone, FileText, RefreshCw, Pause, Play, Filter, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/use-toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { rconApi, configApi, serverApi, serversApi, ApiError, type ServerInstance } from '@/lib/api'
import { useSocket } from '@/contexts/SocketContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useAuth } from '@/contexts/AuthContext'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { DisabledReason } from '@/components/DisabledReason'
import { HelpTip } from '@/components/HelpTip'
import { cn } from '@/lib/utils'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { usePageShortcut } from '@/hooks/useKeyboardShortcuts'

// rconService.execute() (server/services/rcon.js) attaches
// `code: ErrorCode.RCON_EXECUTE_DISCONNECTED` to its response whenever a
// failure represents the RCON session having dropped -- check THAT, not
// the accompanying prose. This used to substring-match a hand-maintained
// copy of the server's user-facing messages, which silently broke the
// moment either list was edited without updating the other: 2026-08-30,
// rcon-disconnect-detection-matches-prose-not-codes -- "Server is not
// running" was reworded to "Game server is not running." server-side and
// this file's phrase list was never told, so a real disconnect stopped
// being detected. A code can't drift out of sync with itself the way two
// independently-maintained strings can.
const RCON_EXECUTE_DISCONNECTED_CODE = 'RCON_EXECUTE_DISCONNECTED'
function isRconDisconnectError(code: string | undefined): boolean {
  return code === RCON_EXECUTE_DISCONNECTED_CODE
}

interface CommandEntry {
  id: number
  command: string
  response: string
  success: number
  executed_at: string
}

interface RconResponse {
  command: string
  response: string
  success: boolean
  timestamp: string
}

// Parse PZ server log line into structured parts
interface ParsedLogLine {
  type: 'LOG' | 'WARN' | 'ERROR' | 'DEBUG' | 'INFO' | 'UNKNOWN'
  category: string
  message: string
  raw: string
  /** Human-readable HH:mm:ss extracted from PZ's `t:<epoch_ms>` field, if present. */
  time?: string
}

// Convert a PZ epoch-ms timestamp to local HH:mm:ss. PZ logs `t:1777482455659`
// where the value is milliseconds since epoch. We render it as wall-clock time
// in the viewer's locale so admins can correlate events without doing math.
function formatLogTime(epochMs: number): string | undefined {
  if (!Number.isFinite(epochMs) || epochMs < 1_000_000_000_000) return undefined
  try {
    const d = new Date(epochMs)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    return `${hh}:${mm}:${ss}`
  } catch { return undefined }
}

function parseLogLine(line: string): ParsedLogLine {
  // PZ log format: "TYPE : Category    f:XXXXX, t:XXXXX, st:XXXXX> Source > Message"
  // or just plain text
  
  const trimmed = line.trim()
  if (!trimmed) {
    return { type: 'UNKNOWN', category: '', message: '', raw: line }
  }
  
  // Match: LOG/WARN/ERROR : Category  f:xxx, t:<epoch_ms>, st:xxx> Message
  // The `t:` field is epoch-ms — capture it so we can show a readable time.
  const match = trimmed.match(/^(LOG|WARN|ERROR|DEBUG|INFO)\s*:\s*(\w+)(?:[^>]*?\bt:(\d+))?[^>]*>\s*(.+)$/i)
  if (match) {
    let type = match[1].toUpperCase() as ParsedLogLine['type']
    const tField = match[3]
    const message = match[4]
    // Promote LOG → ERROR when the message body is a Java exception or stack trace.
    // PZ logs every exception as `LOG : General ... > java.lang.NullPointerException ...`
    // which makes them invisible against routine LOG spam.
    if (type === 'LOG' && /^(java\.|kotlin\.|zombie\.|com\.|org\.|at\s+\S+\.|Exception in thread|Caused by:|\S+(Exception|Error)(:|\s|$))/i.test(message)) {
      type = 'ERROR'
    }
    return {
      type,
      category: match[2],
      message,
      raw: line,
      time: tField ? formatLogTime(Number(tField)) : undefined,
    }
  }
  
  // Check for simple prefixes
  if (trimmed.startsWith('ERROR')) {
    return { type: 'ERROR', category: '', message: trimmed.replace(/^ERROR\s*:?\s*/i, ''), raw: line }
  }
  if (trimmed.startsWith('WARN')) {
    return { type: 'WARN', category: '', message: trimmed.replace(/^WARN\s*:?\s*/i, ''), raw: line }
  }
  if (trimmed.startsWith('LOG')) {
    return { type: 'LOG', category: '', message: trimmed.replace(/^LOG\s*:?\s*/i, ''), raw: line }
  }
  // Bare Java stack-trace continuation lines ("\tat zombie.network...", "Caused by: ...")
  if (/^(\s*at\s+\S+|Caused by:|\.{3}\s+\d+ more|Exception in thread)/.test(trimmed)) {
    return { type: 'ERROR', category: '', message: trimmed, raw: line }
  }
  
  return { type: 'UNKNOWN', category: '', message: trimmed, raw: line }
}

// Log line type → text color
const typeColors: Record<string, string> = {
  'ERROR': 'text-destructive',
  'WARN': 'text-warning',
  'LOG': 'text-foreground/90',
  'DEBUG': 'text-muted-foreground',
  'INFO': 'text-primary',
  'UNKNOWN': 'text-muted-foreground'
}

// Log line type → badge color
const typeBadgeColors: Record<string, string> = {
  'ERROR': 'border border-destructive/25 bg-destructive/10 text-destructive',
  'WARN': 'border border-warning/25 bg-warning/10 text-warning',
  'LOG': 'border border-border/60 bg-muted/40 text-foreground/90',
  'DEBUG': 'border border-border/50 bg-muted/25 text-muted-foreground',
  'INFO': 'border border-primary/20 bg-primary/10 text-primary',
  'UNKNOWN': 'border border-border/50 bg-muted/25 text-muted-foreground'
}

// Channel tag prefixes for server broadcasts. "all" = no prefix.
// All options become `servermsg` since RCON cannot route to real chat channels.
// `value` is the internal id sent to the backend and must stay untranslated;
// label/description are looked up from the console namespace at call time.
const chatChannelValues = ['all', 'admin', 'say', 'faction', 'safehouse'] as const

function getChatChannels(t: TFunction<'console'>) {
  return chatChannelValues.map((value) => ({
    value,
    label: t(`broadcast.channels.${value}.label`),
    description: t(`broadcast.channels.${value}.description`),
  }))
}

// Memoized log line to avoid re-rendering unchanged lines
const ServerLogLine = memo(function ServerLogLine({ line }: { line: string }) {
  const parsed = parseLogLine(line)
  if (!parsed.message && !parsed.raw.trim()) return null

  return (
    <div
      className={cn(
        'border-s px-2 py-0.5 leading-tight',
        parsed.type === 'ERROR'
          ? 'border-destructive/40 bg-destructive/8'
          : parsed.type === 'WARN'
            ? 'border-warning/40 bg-warning/8'
            : parsed.type === 'INFO'
              ? 'border-primary/20 bg-primary/5'
              : 'border-transparent'
      )}
    >
      <div className="flex items-baseline gap-1.5">
        {parsed.time && (
          <span className="shrink-0 text-muted-foreground/60 text-[11px] font-mono tabular-nums">
            {parsed.time}
          </span>
        )}
        {parsed.type !== 'UNKNOWN' && (
          <span className={`px-1 rounded text-[10px] font-semibold uppercase tracking-wide shrink-0 ${typeBadgeColors[parsed.type]}`}>
            {parsed.type}
          </span>
        )}
        {parsed.category && (
          <span className="shrink-0 text-muted-foreground/70 text-[11px]">[{parsed.category}]</span>
        )}
        <span className={`${typeColors[parsed.type]} break-words min-w-0`}>
          {parsed.message || parsed.raw}
        </span>
      </div>
    </div>
  )
})

// `command` is the literal RCON command text sent to the server and must
// stay untranslated; only the button label is looked up.
const quickCommandDefs = [
  { key: 'players', command: 'players' },
  { key: 'save', command: 'save' },
  { key: 'showOptions', command: 'showoptions' },
  { key: 'checkMods', command: 'checkModsNeedUpdate' },
  { key: 'help', command: 'help' },
  { key: 'serverInfo', command: 'serverinfo' },
  { key: 'getMemory', command: 'getmemory' },
] as const

function getQuickCommands(t: TFunction<'console'>) {
  return quickCommandDefs.map(({ key, command }) => ({ label: t(`quickCommands.${key}`), command }))
}

// Quick broadcast message templates -- these ARE sent into the game via
// RCON servermsg, so both the button label and the message text itself are
// translated (a French server's canned announcements should read in French).
const quickBroadcastKeys = ['restart15', 'restart5', 'restart1', 'maintenance', 'backOnline', 'saveWarning'] as const

function getQuickBroadcasts(t: TFunction<'console'>) {
  return quickBroadcastKeys.map((key) => ({
    label: t(`broadcast.templates.${key}.label`),
    message: t(`broadcast.templates.${key}.message`),
  }))
}

// No pagination on this panel -- when a fetch returns exactly this many
// rows, older commands may exist and be silently excluded (server allows
// up to 1000, see server/routes/rcon.js). Hint, not a hard truth: hitting
// the limit exactly by coincidence is possible too.
const COMMAND_HISTORY_FETCH_LIMIT = 50

export default function Console() {
  const { t, i18n } = useTranslation('console')
  const chatChannels = useMemo(() => getChatChannels(t), [t])
  const quickCommands = useMemo(() => getQuickCommands(t), [t])
  const quickBroadcasts = useMemo(() => getQuickBroadcasts(t), [t])
  const [command, setCommand] = useState('')
  const [activeServer, setActiveServer] = useState<ServerInstance | null>(null)
  const [consoleTargetLoading, setConsoleTargetLoading] = useState(true)
  const [history, setHistory] = useState<CommandEntry[]>([])
  const [liveLog, setLiveLog] = useState<RconResponse[]>([])
  const [loading, setLoading] = useState(false)
  const [commandHistoryIndex, setCommandHistoryIndex] = useState(-1)
  const [commandCache, setCommandCache] = useState<string[]>([])
  const [rconConnected, setRconConnected] = useState<boolean | null>(null)
  // Only meaningful while rconConnected === false -- distinguishes three
  // different reasons the banner below needs different words for:
  // 'unreachable' (host never reachable), 'auth_failed' (reachable, but the
  // saved password is wrong -- see 2026-08-26 bug hunt finding 1), and
  // 'dropped' (a mid-session transport drop detected from a failed command,
  // not a fresh probe -- host/port/password were just proven correct
  // seconds ago, so telling this operator to go re-check them is
  // confidently wrong advice; see 2026-08-31 bug hunt).
  const [rconFailureReason, setRconFailureReason] = useState<'unreachable' | 'auth_failed' | 'dropped' | null>(null)
  const [testingConnection, setTestingConnection] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [selectedChannel, setSelectedChannel] = useState('all')
  const [sendingAnnouncement, setSendingAnnouncement] = useState(false)
  const [historySearch, setHistorySearch] = useState('')
  const [showBroadcast, setShowBroadcast] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [commandDraft, setCommandDraft] = useState('') // saves in-progress text while browsing history
  const liveLogIdRef = useRef(0) // monotonic counter for stable liveLog keys
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const { toast } = useToast()
  const socket = useSocket()
  const confirm = useConfirm()
  const { can } = useAuth()
  // POST /rcon/execute (server/routes/rcon.js) requires rcon.execute -- both
  // the typed-command path (executeCommand) and the broadcast path
  // (sendAnnouncement) end up calling it. can() fails OPEN when capabilities
  // are unknown/null, same convention as every other capability check in
  // the app -- this only ever blocks the action when the answer is a
  // confirmed no. Guarded inside the handlers themselves, not just on the
  // visible buttons: the command input's Enter key calls executeCommand
  // directly, bypassing whatever the Run button's disabled state says.
  const canExecuteRcon = can('rcon.execute')

  // Server Console Log state
  const [serverLogLines, setServerLogLines] = useState<string[]>([])
  const [_serverLogSize, setServerLogSize] = useState(0)
  const [serverLogPath, setServerLogPath] = useState('')
  const [serverLogExists, setServerLogExists] = useState(false)
  const [serverLogLoading, setServerLogLoading] = useState(false)
  const [serverLogError, setServerLogError] = useState<string | null>(null)
  const serverLogErrorCountRef = useRef(0)
  const [serverLogAutoScroll, setServerLogAutoScroll] = useState(true)
  const [serverLogPaused, setServerLogPaused] = useState(false)
  const [serverLogFiltered, setServerLogFiltered] = useState(true) // Filter out noise by default
  const [consoleTab, setConsoleTab] = useState('server-log')

  // Console keyboard shortcuts
  usePageShortcut('a', () => setServerLogAutoScroll(prev => !prev))
  usePageShortcut('`', () => setConsoleTab(prev => prev === 'server-log' ? 'rcon' : 'server-log'))
  const serverLogRef = useRef<HTMLDivElement>(null)
  const serverLogIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const serverLogSizeRef = useRef(0) // Track size without recreating interval
  const hasActiveServer = !!activeServer
  const hasServerLogSource = !!activeServer && !activeServer.isRemote && Boolean(activeServer.zomboidDataPath || activeServer.installPath)
  const hasRconConfig = !!activeServer && Boolean(activeServer.rconHost && activeServer.rconPort && activeServer.rconPassword)
  const serverLogUnavailable = !hasServerLogSource
    ? activeServer?.isRemote
      ? {
          title: t('unavailable.remoteTitle'),
          description: t('unavailable.remoteDesc'),
        }
      : {
          title: t('unavailable.notConfiguredTitle'),
          description: t('unavailable.notConfiguredDesc'),
        }
    : null

  useEffect(() => {
    let cancelled = false

    const loadConsoleTarget = async () => {
      try {
        const data = await serversApi.getAll()
        if (cancelled) return

        const nextActiveServer = data.servers.find(server => server.isActive) ?? data.servers[0] ?? null
        setActiveServer(nextActiveServer)
      } catch {
        if (!cancelled) {
          setActiveServer(null)
        }
      } finally {
        if (!cancelled) {
          setConsoleTargetLoading(false)
        }
      }
    }

    loadConsoleTarget()

    // bug-hunt-2026-09-04: this page never re-read the active server after
    // mount, unlike Settings.tsx/Dashboard.tsx/Servers.tsx/WorldMap.tsx/
    // Layout.tsx, which all listen for activeServerChanged. Switching
    // servers elsewhere left Console showing the PREVIOUS server's name and
    // "log source available"/RCON-configured gating, while RCON commands
    // (routed against whichever server the backend resolves as active right
    // now, same per-request-resolution pattern as ServerConfig's ini/sandbox
    // routes) would actually reach the NEW server -- the UI and the real
    // target silently diverging. No unsaved-edit risk here (liveLog/history
    // are just a display of past activity, not something a reload discards
    // meaningfully), so this can reload unconditionally like the other five
    // pages do, no ServerConfig-style block-and-warn needed.
    if (socket) socket.on('activeServerChanged', loadConsoleTarget)

    return () => {
      cancelled = true
      if (socket) socket.off('activeServerChanged', loadConsoleTarget)
    }
  }, [socket])

  // Patterns to filter out (uninteresting/repetitive messages) - memoized to prevent recreation
  const noisePatterns = useMemo(() => [
    /moveZombie: There are no zombies/i,
    /ItemPickInfo -> cannot get ID for container/i,
    /IsoThumpable not found on square/i,
    /SpriteConfig\.initObjectInfo.*Invalid SpriteConfig/i,
    /MOWoodenWalFrame\.lua: replacing isoObject/i,
    /OreVein\{startPoint/i,
    /SkeletonBone not resolved for bone/i,
    /action was null, object: null/i,
    /Could not find item type for/i,
    /Canceled loading wrong transition/i,
  ], [])

  // Get filtered lines - memoized to prevent recalculation on every render
  const filteredLogLines = useMemo(() => {
    if (!serverLogFiltered) return serverLogLines
    return serverLogLines.filter(line => !noisePatterns.some(pattern => pattern.test(line)))
  }, [serverLogLines, serverLogFiltered, noisePatterns])

  const fetchHistory = useCallback(async () => {
    if (!hasActiveServer) {
      setHistory([])
      setCommandCache([])
      return
    }

    try {
      const data = await rconApi.getHistory(COMMAND_HISTORY_FETCH_LIMIT)
      setHistory(data.history || [])
      setCommandCache(data.history?.map((h: CommandEntry) => h.command).reverse() || [])
    } catch {
      toast({
        title: t('toasts.historyUnavailableTitle'),
        description: t('toasts.historyUnavailableDesc'),
        variant: 'destructive',
      })
    }
  }, [hasActiveServer, toast, t])

  const testRconConnection = useCallback(async () => {
    if (!hasRconConfig) {
      setRconConnected(null)
      setRconFailureReason(null)
      setTestingConnection(false)
      return
    }

    setTestingConnection(true)
    try {
      const result = await configApi.testRcon()
      setRconConnected(result.success && result.connected)
      setRconFailureReason(null)
    } catch (err) {
      setRconConnected(false)
      // handleResponse() (lib/api.ts) throws on a 200 `{success:false}` body
      // too, so the unreachable/auth_failed split from the response payload
      // survives on err.data even though this is a caught throw, not a
      // resolved result.
      const data = err instanceof ApiError ? (err.data as { error?: string } | undefined) : undefined
      setRconFailureReason(data?.error === 'auth_failed' ? 'auth_failed' : 'unreachable')
    } finally {
      setTestingConnection(false)
    }
  }, [hasRconConfig])

  // Server Console Log functions
  const fetchServerLog = useCallback(async (initial = false) => {
    if (!hasServerLogSource) {
      if (initial) {
        setServerLogLines([])
        setServerLogSize(0)
        setServerLogPath('')
        setServerLogExists(false)
        setServerLogError(null)
        serverLogErrorCountRef.current = 0
        serverLogSizeRef.current = 0
      }
      setServerLogLoading(false)
      return
    }

    if (serverLogPausedRef.current && !initial) return
    
    try {
      if (initial) {
        setServerLogLoading(true)
        setServerLogError(null)
        serverLogErrorCountRef.current = 0
        const data = await serverApi.getConsoleLog(1000)
        setServerLogLines(data.lines || [])
        setServerLogSize(data.size || 0)
        serverLogSizeRef.current = data.size || 0
        setServerLogPath(data.path || '')
        setServerLogExists(data.exists || false)
      } else {
        // Stream new content - use ref to avoid stale closure
        const data = await serverApi.streamConsoleLog(serverLogSizeRef.current)
        if (data.newLines && data.newLines.length > 0) {
          setServerLogLines(prev => [...prev, ...data.newLines].slice(-500))
        }
        if (data.rotated) {
          // File was rotated, replace all content
          setServerLogLines(data.newLines || [])
        }
        setServerLogSize(data.currentSize || serverLogSizeRef.current)
        serverLogSizeRef.current = data.currentSize || serverLogSizeRef.current
        // Clear error state on any successful poll
        if (serverLogErrorCountRef.current > 0) {
          serverLogErrorCountRef.current = 0
          setServerLogError(null)
        }
      }
    } catch {
      serverLogErrorCountRef.current += 1
      if (serverLogErrorCountRef.current >= 3) {
        setServerLogError(t('serverLog.streamUnavailable'))
      }
    } finally {
      setServerLogLoading(false)
    }
  }, [hasServerLogSource, t])

  const clearServerLog = async () => {
    const confirmed = await confirm({
      title: t('serverLog.clearConfirmTitle'),
      description: t('serverLog.clearConfirmDesc'),
      confirmLabel: t('serverLog.clearConfirmButton'),
    })
    if (!confirmed) return

    try {
      await serverApi.clearConsoleLog()
      setServerLogLines([])
      setServerLogSize(0)
      toast({
        title: t('toasts.logClearedTitle'),
        description: t('toasts.logClearedDesc'),
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('toasts.clearLogFailed')),
        variant: 'destructive',
      })
    }
  }

  // Ref to track paused state for interval callback (avoids stale closure)
  const serverLogPausedRef = useRef(serverLogPaused)
  useEffect(() => {
    serverLogPausedRef.current = serverLogPaused
  }, [serverLogPaused])

  // Start/stop server log polling
  useEffect(() => {
    if (!hasServerLogSource) {
      if (serverLogIntervalRef.current) {
        clearInterval(serverLogIntervalRef.current)
        serverLogIntervalRef.current = null
      }
      return undefined
    }

    // Initial fetch
    fetchServerLog(true)
    
    // Poll every 2 seconds for new log content
    serverLogIntervalRef.current = setInterval(() => {
      if (!serverLogPausedRef.current && document.visibilityState !== 'hidden') {
        fetchServerLog(false)
      }
    }, 2000)
    
    return () => {
      if (serverLogIntervalRef.current) {
        clearInterval(serverLogIntervalRef.current)
        serverLogIntervalRef.current = null
      }
    }
  }, [fetchServerLog, hasServerLogSource])

  // Auto-scroll server log
  useEffect(() => {
    if (serverLogAutoScroll && serverLogRef.current) {
      const el = serverLogRef.current
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
    }
  }, [serverLogLines, serverLogAutoScroll])

  useEffect(() => {
    if (!hasActiveServer) return

    fetchHistory()
    if (hasRconConfig) {
      testRconConnection()
    } else {
      setRconConnected(null)
      setRconFailureReason(null)
    }
    // Auto-focus input on mount
    inputRef.current?.focus()
  }, [fetchHistory, hasActiveServer, hasRconConfig, testRconConnection])

  useEffect(() => {
    if (socket) {
      const handleRconResponse = (data: RconResponse) => {
        const entry = { ...data, _id: ++liveLogIdRef.current } as RconResponse & { _id: number }
        setLiveLog(prev => [...prev, entry].slice(-100))
        // This event broadcasts to the whole "rcon-live" room for EVERY
        // /execute call, including failed/disconnected ones (data.success:
        // false) -- only a successful response actually proves the
        // connection is live. Forcing "connected" on any message here could
        // mask a real drop (someone else's failed command, or this one's
        // own failure echo) behind a stale "online" banner.
        if (data.success) {
          setRconConnected(true)
          setRconFailureReason(null)
        }
      }

      socket.on('rcon:response', handleRconResponse)

      // 2026-08-31: 'rcon:response' broadcasts into "rcon-live", gated
      // server-side on rcon.execute (server/index.js) -- the same
      // capability that already gates every caller of
      // executeCommand/sendAnnouncement below, and the same one POST
      // /rcon/history uses for the STORED copy of this content. Moved off
      // the diagnostics.manage-gated "logs" room App.tsx subscribes to
      // app-wide, which let any diagnostics.manage holder read every
      // admin's live console output whether or not they could run commands
      // themselves -- the exact leak /rcon/history's own capability check
      // already existed to prevent. Re-emitted on every reconnect, not just
      // once per mount: room membership is server-side per-connection
      // state, lost whenever the underlying socket.io connection drops and
      // re-establishes, even though the client reuses the same Socket
      // object.
      const subscribeRcon = () => socket.emit('subscribe:rcon')
      if (canExecuteRcon) {
        if (socket.connected) subscribeRcon()
        socket.on('connect', subscribeRcon)
      }

      return () => {
        socket.off('rcon:response', handleRconResponse)
        socket.off('connect', subscribeRcon)
      }
    }
  }, [socket, canExecuteRcon])

  useEffect(() => {
    // Auto-scroll to bottom
    if (scrollRef.current) {
      const el = scrollRef.current
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
    }
  }, [liveLog])

  const executeCommand = async () => {
    if (!command.trim()) return
    if (!canExecuteRcon) return

    setLoading(true)
    try {
      // handleResponse() throws on a non-2xx status or an HTTP 200 body
      // with success: false -- rconService.execute() resolves
      // { success: false, error } for "server not running"/"unknown
      // command"/etc rather than rejecting, so every RCON failure used to
      // arrive as a caught exception here, skipping the live-log/command-
      // cache/connection-status handling below entirely (a failed command
      // just vanished instead of showing up in the console like a real
      // terminal would). Reconstruct the { success, error } shape from the
      // caught error so failures go through the same handling as successes.
      let result: { success: boolean; response?: string; error?: string; code?: string }
      try {
        result = await rconApi.execute(command)
      } catch (error) {
        result = {
          success: false,
          error: getUserErrorMessage(error, t('toasts.commandFailedFallback')),
          code: error instanceof ApiError ? error.code : undefined,
        }
      }

      // Update connection status based on result. A mid-session drop
      // detected here is a transport-level signal, not the classified
      // unreachable-vs-auth_failed probe testRconConnection() runs -- 2026-08-31:
      // this used to reset to null so the banner fell back to its
      // unreachable copy rather than showing a stale auth_failed reason from
      // an earlier test -- sound reasoning, wrong fallback. The connection
      // just ran a command successfully seconds before it dropped, so
      // "unreachable, check host/port/password" is confidently wrong advice
      // for this specific case, not just an absent one. 'dropped' is its own
      // real reason with its own copy (borrowed from the toast below, which
      // already has the right words for this exact event).
      if (isRconDisconnectError(result.code)) {
        setRconConnected(false)
        setRconFailureReason('dropped')
      } else if (result.success) {
        setRconConnected(true)
        setRconFailureReason(null)
      }

      if (!result.success) {
        toast({
          title: t('toasts.errorTitle'),
          description: result.error || t('toasts.commandFailedFallback'),
          variant: 'destructive',
        })
      }

      // No manual live-log push here: the server-side 'rcon:response'
      // broadcast (handled above) now goes to the "rcon-live" room, gated on
      // rcon.execute -- the exact capability this function already requires
      // to reach this point (see the early return above), so every caller
      // who can get this far is guaranteed to be a room member and receive
      // the broadcast. A manual push here as well would double the entry,
      // not fill a gap -- that used to be a real gap, back when the
      // broadcast went to the diagnostics.manage-gated "logs" room instead,
      // which a caller could hold rcon.execute without ever joining.

      // Add to command cache (limit to 100 entries)
      setCommandCache(prev => [...prev.slice(-99), command])
      setCommandHistoryIndex(-1)
      setCommand('')

      // Re-focus input after command execution
      inputRef.current?.focus()

      fetchHistory()
    } catch (error) {
      setRconConnected(false)
      setRconFailureReason(null)
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('toasts.commandFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      executeCommand()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (commandCache.length > 0) {
        // Stash the user's in-progress text the first time they leave the live input.
        if (commandHistoryIndex === -1) setCommandDraft(command)
        const newIndex = commandHistoryIndex < commandCache.length - 1
          ? commandHistoryIndex + 1
          : commandHistoryIndex
        setCommandHistoryIndex(newIndex)
        setCommand(commandCache[commandCache.length - 1 - newIndex] || '')
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (commandHistoryIndex > 0) {
        const newIndex = commandHistoryIndex - 1
        setCommandHistoryIndex(newIndex)
        setCommand(commandCache[commandCache.length - 1 - newIndex] || '')
      } else if (commandHistoryIndex === 0) {
        // Restore the draft they had typed before browsing history.
        setCommandHistoryIndex(-1)
        setCommand(commandDraft)
        setCommandDraft('')
      }
    }
  }

  const clearLog = () => {
    setLiveLog([])
  }



  const sendAnnouncement = async () => {
    if (!announcement.trim()) return
    if (!canExecuteRcon) return

    setSendingAnnouncement(true)
    try {
      const cleaned = announcement.replace(/"/g, '\\"')
      const cmd = selectedChannel === 'all'
        ? `servermsg "${cleaned}"`
        : `servermsg "[${selectedChannel.toUpperCase()}] ${cleaned}"`
      // Same shape as executeCommand above: rconService.execute() resolves
      // { success: false, error } for a genuine RCON failure rather than
      // rejecting, so handleResponse() throws before this ever sees
      // result.success === false. Reconstruct it here too, so a failed
      // broadcast still gets logged instead of silently vanishing.
      let result: { success: boolean; response?: string; error?: string; code?: string }
      try {
        result = await rconApi.execute(cmd)
      } catch (error) {
        result = {
          success: false,
          error: getUserErrorMessage(error, t('toasts.broadcastFailedFallback')),
          code: error instanceof ApiError ? error.code : undefined,
        }
      }

      // Same shape as executeCommand above: no manual live-log push here --
      // the 'rcon:response' broadcast goes to "rcon-live", gated on
      // rcon.execute, which this function already requires (see the early
      // return above). A manual push would double the entry.

      if (result.success) {
        toast({
          title: t('toasts.broadcastSentTitle'),
          description: selectedChannel === 'all'
            ? t('toasts.broadcastSentAll')
            : t('toasts.broadcastSentTagged', { tag: selectedChannel.toUpperCase() }),
          variant: 'success' as const,
        })
        setAnnouncement('')
        setRconConnected(true)
        setRconFailureReason(null)
      } else {
        if (isRconDisconnectError(result.code)) {
          setRconConnected(false)
          setRconFailureReason(null)
        }
        toast({
          title: t('toasts.errorTitle'),
          description: result.error || t('toasts.broadcastFailedFallback'),
          variant: 'destructive',
        })
      }
    } catch (error) {
      const message = getUserErrorMessage(error, t('toasts.broadcastFailedFallback'))
      if (isRconDisconnectError(error instanceof ApiError ? error.code : undefined)) {
        setRconConnected(false)
        setRconFailureReason(null)
      }
      toast({
        title: t('toasts.errorTitle'),
        description: message,
        variant: 'destructive',
      })
    } finally {
      setSendingAnnouncement(false)
    }
  }



  if (consoleTargetLoading) {
    return (
      <div className="space-y-6 page-transition">
        <PageHeader
          title={t('pageHeader.title')}
          description={t('pageHeader.description')}
          tone="ops"
          icon={<TerminalIcon className="w-5 h-5" />}
        />
        <div className="flex min-h-[18rem] items-center justify-center rounded-md border border-border/50 bg-card/50">
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('checkingServerTarget')}
          </div>
        </div>
      </div>
    )
  }

  if (!hasActiveServer) {
    return (
      <div className="space-y-6 page-transition">
        <PageHeader
          title={t('pageHeader.title')}
          description={t('pageHeader.description')}
          tone="ops"
          icon={<TerminalIcon className="w-5 h-5" />}
        />
        <div className="rounded-md border border-border/50 bg-card/50 p-4">
          <EmptyState
            type="empty"
            title={t('emptyState.title')}
            description={t('emptyState.description')}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
        tone="ops"
        icon={<TerminalIcon className="w-5 h-5" />}
      />
      <Tabs value={consoleTab} onValueChange={setConsoleTab} className="w-full">
        <TabsList className="grid w-full grid-cols-2 bg-muted/30 border border-border/50 rounded-md p-0.5">
          <TabsTrigger
            value="server-log"
            className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-none rounded-sm"
          >
            <FileText className="w-3.5 h-3.5" />
            {t('tabs.serverLog')}
          </TabsTrigger>
          <TabsTrigger
            value="rcon"
            className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-none rounded-sm"
          >
            <TerminalIcon className="w-3.5 h-3.5" />
            {t('tabs.rconConsole')}
          </TabsTrigger>
        </TabsList>

        {/* Server Console Log Tab */}
        <TabsContent value="server-log" className="space-y-3 mt-4">
          {serverLogUnavailable ? (
            <div className="flex h-[calc(100vh-360px)] min-h-[300px] items-center justify-center rounded-md border border-border/50 bg-muted/20 p-4">
              <EmptyState type="noFile" title={serverLogUnavailable.title} description={serverLogUnavailable.description} compact />
            </div>
          ) : (
            <>
          {/* Tactical toolbar strip */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 py-2 rounded-md border border-border/50 bg-card/70 backdrop-blur-sm">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-[9px] uppercase tracking-[0.24em] text-primary/60 shrink-0">{t('serverLog.pathLabel')}</span>
              <p className="text-xs text-foreground/80 font-mono truncate" title={serverLogPath || undefined}>
                {serverLogPath ? serverLogPath : <span className="text-muted-foreground/50">{t('serverLog.loadingPath')}</span>}
              </p>
              {serverLogLoading && <Loader2 className="w-3 h-3 animate-spin text-primary/70 shrink-0" />}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em]"
                onClick={() => setServerLogPaused(!serverLogPaused)}
                aria-label={serverLogPaused ? t('serverLog.resumeAria') : t('serverLog.pauseAria')}
              >
                {serverLogPaused
                  ? <><Play className="w-3 h-3 me-1" />{t('serverLog.resume')}</>
                  : <><Pause className="w-3 h-3 me-1" />{t('serverLog.pause')}</>}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setServerLogFiltered(!serverLogFiltered)}
                aria-label={serverLogFiltered ? t('serverLog.showAllAria') : t('serverLog.filterAria')}
                title={serverLogFiltered
                  ? t('serverLog.hidingTooltip', { count: Math.max(0, serverLogLines.length - filteredLogLines.length) })
                  : t('serverLog.filterOffTooltip')}
                className={cn('h-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em]', serverLogFiltered && 'text-primary')}
              >
                <Filter className="w-3 h-3 me-1" />
                {serverLogFiltered
                  ? (serverLogLines.length > filteredLogLines.length
                      ? t('serverLog.filterWithCount', { count: serverLogLines.length - filteredLogLines.length })
                      : t('serverLog.filter'))
                  : t('serverLog.all')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setServerLogAutoScroll(!serverLogAutoScroll)}
                aria-label={serverLogAutoScroll ? t('serverLog.disableAutoScrollAria') : t('serverLog.enableAutoScrollAria')}
                title={serverLogAutoScroll ? t('serverLog.autoScrollOnTooltip') : t('serverLog.autoScrollOffTooltip')}
                className={cn('h-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em]', serverLogAutoScroll ? 'text-primary' : 'text-muted-foreground')}
              >
                {serverLogAutoScroll ? t('serverLog.followOn') : t('serverLog.followOff')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => fetchServerLog(true)}
                aria-label={t('serverLog.refreshAria')}
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="destructive" size="sm" className="h-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em]" onClick={clearServerLog}>
                    <Trash2 className="w-3 h-3 me-1" />
                    {t('serverLog.clear')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('serverLog.clearTooltip')}</TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Error banner when log polling fails repeatedly */}
          {serverLogError && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-destructive"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" />
              <span className="flex-1">// {serverLogError}</span>
              <Button variant="ghost" size="sm" className="h-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em]" onClick={() => fetchServerLog(true)}>
                {t('serverLog.retry')}
              </Button>
            </div>
          )}

          {/* Terminal pane — framed tactical viewer */}
          {!serverLogExists ? (
            <div className="flex h-[calc(100vh-360px)] min-h-[300px] items-center justify-center rounded-md border border-border/50 bg-muted/20 p-4">
              <EmptyState type="serverOffline" title={t('serverLog.notFoundTitle')} description={t('serverLog.notFoundDesc')} compact />
            </div>
          ) : (
            <div className="relative rounded-md border border-border/55 bg-card/85 overflow-hidden shadow-lg">
              {/* corner brackets */}
              <div aria-hidden className="absolute top-1 left-1 w-2.5 h-2.5 border-s-2 border-t-2 border-primary/45 pointer-events-none z-10" />
              <div aria-hidden className="absolute top-1 right-1 w-2.5 h-2.5 border-e-2 border-t-2 border-primary/45 pointer-events-none z-10" />
              <div aria-hidden className="absolute bottom-1 left-1 w-2.5 h-2.5 border-s-2 border-b-2 border-primary/45 pointer-events-none z-10" />
              <div aria-hidden className="absolute bottom-1 right-1 w-2.5 h-2.5 border-e-2 border-b-2 border-primary/45 pointer-events-none z-10" />
              {/* header strip */}
              <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border/50 bg-muted/30 font-mono text-[9px] uppercase tracking-[0.24em] select-none">
                <span className="flex items-center gap-1.5 text-primary/65">
                  <span>{t('serverLog.streamLabel')}</span>
                  <span className="text-muted-foreground/40 normal-case tracking-normal">·</span>
                  <span className="text-muted-foreground/80 normal-case tracking-normal">{serverLogPaused ? t('serverLog.paused') : t('serverLog.live')}</span>
                </span>
                <span className="flex items-center gap-1.5 text-muted-foreground/60">
                  <span className={cn('w-1.5 h-1.5 rounded-full', serverLogPaused ? 'bg-amber-400/70' : 'bg-emerald-400/80 animate-pulse')} />
                  <span>{serverLogPaused ? t('serverLog.paused') : t('serverLog.streaming')}</span>
                </span>
              </div>
              <div
                ref={serverLogRef}
                role="log"
                aria-live="polite"
                aria-label={t('serverLog.serverOutputAria')}
                className="h-[calc(100vh-400px)] min-h-[280px] overflow-auto bg-background/60 p-3 font-mono text-xs terminal-output"
              >
                {filteredLogLines.length === 0 ? (
                  <div className="p-2 font-mono text-[11px] text-muted-foreground/70">
                    {serverLogFiltered && serverLogLines.length > 0 ? (
                      <span>
                        {t('serverLog.linesHidden', { count: serverLogLines.length })}
                        <button
                          type="button"
                          className="underline underline-offset-2 text-primary/80 hover:text-primary"
                          onClick={() => setServerLogFiltered(false)}
                        >
                          {t('serverLog.showAll')}
                        </button>
                      </span>
                    ) : serverLogError ? (
                      // Distinct from the genuinely-quiet case below: the error
                      // banner right above already explains the stream is down,
                      // so this must not also claim anything about the server
                      // itself -- an empty body here is caused by OUR broken
                      // connection, not by the server having nothing to say.
                      <span>{t('serverLog.noOutputStreamDown')}</span>
                    ) : (
                      <span>{t('serverLog.noStreamOutput')}</span>
                    )}
                  </div>
                ) : (
                  filteredLogLines.map((line, index) => (
                    <ServerLogLine key={index} line={line} />
                  ))
                )}
              </div>
              {/* footer strip */}
              <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-t border-border/50 bg-muted/20 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70 select-none">
                <span className="tabular-nums">
                  {serverLogFiltered
                    ? <>{t('serverLog.shown')} <span className="text-foreground/80">{filteredLogLines.length}</span> · {t('serverLog.hidden')} <span className="text-muted-foreground/50">{serverLogLines.length - filteredLogLines.length}</span></>
                    : <>{t('serverLog.loaded')} <span className="text-foreground/80">{serverLogLines.length}</span></>}
                </span>
                <span>{serverLogPaused ? t('serverLog.updatesSuspended') : t('serverLog.pollInterval')}</span>
              </div>
            </div>
          )}
            </>
          )}
        </TabsContent>

        {/* RCON Console Tab */}
        <TabsContent value="rcon" className="space-y-3 mt-4">
          <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-md border border-border/50 bg-card/70 backdrop-blur-sm">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-[9px] uppercase tracking-[0.24em] text-primary/60 shrink-0">{t('rcon.linkLabel')}</span>
              {testingConnection ? (
                <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {t('rcon.checking')}
                </span>
              ) : !hasRconConfig ? (
                <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-warning">
                  <WifiOff className="w-3 h-3" />
                  {t('rcon.notConfigured')}
                </span>
              ) : rconConnected === null ? (
                <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
                  {t('rcon.unknown')}
                </span>
              ) : rconConnected ? (
                <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  {t('rcon.online')}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-destructive">
                  <WifiOff className="w-3 h-3" />
                  {t('rcon.offline')}
                </span>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em]"
              onClick={testRconConnection}
              disabled={testingConnection || !hasRconConfig}
            >
              <RefreshCw className={cn('w-3 h-3 me-1', testingConnection && 'animate-spin')} />
              {t('rcon.recheck')}
            </Button>
          </div>

          {!hasRconConfig && (
            <div
              role="status"
              className="flex items-center gap-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2"
            >
              <WifiOff className="w-4 h-4 shrink-0 text-warning" />
              <div className="min-w-0">
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-warning">{t('rcon.notConfiguredTitle')}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t('rcon.notConfiguredDesc')}
                </p>
              </div>
            </div>
          )}

          {/* RCON Disconnected Warning -- title/desc branch on WHY the test
              failed (see rconFailureReason above) so a reachable host with a
              stale password isn't told to go debug its network, and a
              mid-session transport drop -- host/port/password just proven
              correct -- isn't told to go re-check them either. */}
          {hasRconConfig && rconConnected === false && (
            <div
              role="alert"
              className="flex items-center gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2"
            >
              <WifiOff className="w-4 h-4 shrink-0 text-destructive" />
              <div className="min-w-0">
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-destructive">
                  {rconFailureReason === 'auth_failed' ? t('rcon.authFailedTitle')
                    : rconFailureReason === 'dropped' ? t('rcon.droppedTitle')
                      : t('rcon.hostUnreachableTitle')}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {rconFailureReason === 'auth_failed' ? t('rcon.authFailedDesc')
                    : rconFailureReason === 'dropped' ? t('rcon.droppedDesc')
                      : t('rcon.hostUnreachableDesc')}
                </p>
              </div>
            </div>
          )}

          {/* Console Output (primary surface) */}
          <div className="relative rounded-md border border-border/55 bg-card/85 overflow-hidden shadow-lg">
            <div aria-hidden className="absolute top-1 left-1 w-2.5 h-2.5 border-s-2 border-t-2 border-primary/45 pointer-events-none z-10" />
            <div aria-hidden className="absolute top-1 right-1 w-2.5 h-2.5 border-e-2 border-t-2 border-primary/45 pointer-events-none z-10" />
            <div aria-hidden className="absolute bottom-1 left-1 w-2.5 h-2.5 border-s-2 border-b-2 border-primary/45 pointer-events-none z-10" />
            <div aria-hidden className="absolute bottom-1 right-1 w-2.5 h-2.5 border-e-2 border-b-2 border-primary/45 pointer-events-none z-10" />
            {/* header strip */}
            <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border/50 bg-muted/30 font-mono text-[9px] uppercase tracking-[0.24em] select-none">
              <span className="flex items-center gap-1.5 text-primary/65">
                <span>{t('rcon.outputLabel')}</span>
                <span className="text-muted-foreground/40 normal-case tracking-normal">·</span>
                <span className="text-muted-foreground/80 normal-case tracking-normal tabular-nums">{t('rcon.entries', { count: liveLog.length })}</span>
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 -my-1 font-mono text-[10px] uppercase tracking-[0.16em]"
                    onClick={clearLog}
                    disabled={liveLog.length === 0}
                  >
                    <Trash2 className="w-3 h-3 me-1" />
                    {t('rcon.clear')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('rcon.clearTooltip')}</TooltipContent>
              </Tooltip>
            </div>
            <div
              ref={scrollRef}
              role="log"
              aria-live="polite"
              aria-label={t('rcon.outputAria')}
              className="h-[18rem] min-h-[220px] sm:h-[22rem] lg:h-[26rem] overflow-auto bg-background/60 p-3 terminal-output"
            >
              {liveLog.length === 0 ? (
                <EmptyState compact type="noMessages" title={t('rcon.noCommandsTitle')} description={t('rcon.noCommandsDesc')} />
              ) : (
                liveLog.map((entry, idx) => (
                  <div key={(entry as RconResponse & { _id?: number })._id ?? `${entry.timestamp}-${idx}`} className="mb-3 font-mono text-sm">
                    <div className="flex items-start gap-2">
                      <span className="text-primary shrink-0">$</span>
                      <span className="text-foreground/90 break-all min-w-0 grow">{entry.command}</span>
                      <span className="text-muted-foreground/60 text-[10px] ms-auto shrink-0 tabular-nums font-mono">
                        {new Date(entry.timestamp).toLocaleTimeString(i18n.language)}
                      </span>
                    </div>
                    <div className={cn('ms-4 mt-0.5 text-xs border-s-2 ps-2 break-words', entry.success ? 'border-primary/30 text-foreground/85' : 'border-destructive/50 text-destructive')}>
                      {entry.response.split('\n').map((line, i) => (
                        <div key={`line-${i}`} className="break-words">{line || '\u00A0'}</div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Quick Commands */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[9px] uppercase tracking-[0.24em] text-primary/60 me-1">{t('rcon.quickLabel')}</span>
            {quickCommands.map((qc) => (
              <Button
                key={qc.command}
                variant="outline"
                size="sm"
                className="h-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em] border-border/55 hover:border-primary/55"
                onClick={() => {
                  setCommand(qc.command)
                  inputRef.current?.focus()
                }}
                disabled={!hasRconConfig || rconConnected === false}
              >
                {qc.label}
              </Button>
            ))}
          </div>

          {/* Command Input */}
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[9px] uppercase tracking-[0.24em] text-primary/60">{t('rcon.commandLabel')}</span>
            <HelpTip label={t('rcon.commandLabel')}>{t('rcon.commandTip')}</HelpTip>
          </div>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[11px] uppercase tracking-[0.18em] text-primary/70 pointer-events-none select-none" aria-hidden="true">
                {t('rcon.promptPrefix')}
              </span>
              <Input
                ref={inputRef}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('rcon.placeholder')}
                className="ps-[5.5rem] font-mono bg-card/70 border-border/55 focus-visible:border-primary/60"
                disabled={loading || !hasRconConfig || rconConnected === false || !canExecuteRcon}
                maxLength={2000}
                aria-label={t('rcon.inputAria')}
              />
            </div>
            <DisabledReason reason={
              !canExecuteRcon ? t('rcon.noPermission')
                : rconConnected === false ? t('rcon.disconnectedUseRecheck')
                  : null
            }>
              <Button
                onClick={executeCommand}
                disabled={loading || !command.trim() || !hasRconConfig || rconConnected === false || !canExecuteRcon}
                aria-label={t('rcon.executeAria')}
                className="font-mono text-[11px] uppercase tracking-[0.18em]"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Send className="w-3.5 h-3.5 me-1.5" />{t('rcon.run')}</>}
              </Button>
            </DisabledReason>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60">
            {t('rcon.keyboardHint')}
          </p>

          {/* Broadcast (collapsible) */}
          <div className="rounded-md border border-border/55 bg-card/70 backdrop-blur-sm overflow-hidden">
            <button
              type="button"
              onClick={() => setShowBroadcast(v => !v)}
              aria-expanded={showBroadcast}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.22em] hover:bg-muted/40 transition-colors"
            >
              <span className="flex items-center gap-1.5 text-primary/70">
                <Megaphone className="w-3 h-3" />
                <span>{t('broadcast.toggleLabel')}</span>
                <span className="text-muted-foreground/40 normal-case tracking-normal">·</span>
                <span className="text-muted-foreground/70 normal-case tracking-normal">{t('broadcast.toggleSubtitle')}</span>
              </span>
              <ChevronDown className={cn('w-3.5 h-3.5 text-muted-foreground transition-transform', showBroadcast && 'rotate-180')} />
            </button>
            {showBroadcast && (
              <div className="border-t border-border/40 p-4 space-y-3">
                {/* Quick templates */}
                <div className="flex flex-wrap gap-1.5">
                  {quickBroadcasts.map((qb) => (
                    <Button
                      key={qb.label}
                      variant="outline"
                      size="sm"
                      className="text-xs h-7"
                      onClick={() => setAnnouncement(qb.message)}
                      disabled={!hasRconConfig || rconConnected === false}
                    >
                      {qb.label}
                    </Button>
                  ))}
                </div>

                {/* Channel tag selector */}
                <div className="grid gap-2 sm:grid-cols-[180px_1fr] sm:items-start">
                  <Select value={selectedChannel} onValueChange={setSelectedChannel}>
                    <SelectTrigger aria-label={t('broadcast.channelTagAria')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {chatChannels.map((channel) => (
                        <SelectItem key={channel.value} value={channel.value}>
                          <div className="flex flex-col">
                            <span>{channel.label}</span>
                            <span className="text-xs text-muted-foreground">{channel.description}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Textarea
                    value={announcement}
                    onChange={(e) => setAnnouncement(e.target.value)}
                    placeholder={selectedChannel === 'all'
                      ? t('broadcast.placeholderAll')
                      : t('broadcast.placeholderTagged', { tag: selectedChannel.toUpperCase() })}
                    aria-label={t('broadcast.messageAria')}
                    className="min-h-[80px]"
                    maxLength={500}
                    disabled={sendingAnnouncement || !hasRconConfig || rconConnected === false}
                  />
                </div>

                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    <Trans i18nKey="broadcast.sendsVia" t={t} components={{ code: <code className="text-foreground/80" /> }} />
                  </p>
                  <DisabledReason reason={!canExecuteRcon ? t('rcon.noPermission') : null}>
                    <Button
                      onClick={sendAnnouncement}
                      disabled={sendingAnnouncement || !announcement.trim() || !hasRconConfig || rconConnected === false || !canExecuteRcon}
                    >
                      {sendingAnnouncement ? (
                        <Loader2 className="w-4 h-4 animate-spin me-2" />
                      ) : (
                        <Send className="w-4 h-4 me-2" />
                      )}
                      {t('broadcast.send')}
                    </Button>
                  </DisabledReason>
                </div>
              </div>
            )}
          </div>

          {/* Command History (collapsible) */}
          <div className="rounded-md border border-border/55 bg-card/70 backdrop-blur-sm overflow-hidden">
            <button
              type="button"
              onClick={() => setShowHistory(v => !v)}
              aria-expanded={showHistory}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.22em] hover:bg-muted/40 transition-colors"
            >
              <span className="flex items-center gap-1.5 text-primary/70">
                <FileText className="w-3 h-3" />
                <span>{t('history.toggleLabel')}</span>
                {history.length > 0 && (
                  <>
                    <span className="text-muted-foreground/40 normal-case tracking-normal">·</span>
                    <span className="text-muted-foreground/70 normal-case tracking-normal tabular-nums">{t('history.entries', { count: history.length })}</span>
                    {history.length >= COMMAND_HISTORY_FETCH_LIMIT && (
                      <span className="text-muted-foreground/50 normal-case tracking-normal">{t('history.truncatedHint')}</span>
                    )}
                  </>
                )}
              </span>
              <ChevronDown className={cn('w-3.5 h-3.5 text-muted-foreground transition-transform', showHistory && 'rotate-180')} />
            </button>
            {showHistory && (
              <div className="border-t border-border/40 p-3 space-y-2">
                <div className="relative">
                  <Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder={t('history.searchPlaceholder')}
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                    className="ps-8 h-8 text-sm"
                    aria-label={t('history.searchAria')}
                  />
                </div>
                <ScrollArea className="h-[16rem] min-h-[200px] sm:h-[20rem] rounded-lg border border-border/30 bg-background/40">
                  {history.length === 0 ? (
                    <EmptyState compact type="noData" title={t('history.emptyTitle')} description={t('history.emptyDesc')} />
                  ) : (
                    <div className="space-y-1 p-2">
                      {history
                        .filter(entry =>
                          !historySearch ||
                          entry.command.toLowerCase().includes(historySearch.toLowerCase()) ||
                          entry.response?.toLowerCase().includes(historySearch.toLowerCase())
                        )
                        .map((entry) => (
                        <button
                          key={entry.id}
                          type="button"
                          className="w-full text-start p-2.5 rounded-md hover:bg-muted/30 cursor-pointer transition-colors"
                          onClick={() => {
                            setCommand(entry.command)
                            inputRef.current?.focus()
                          }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <code className="text-sm font-mono text-primary truncate min-w-0 flex-1">{entry.command}</code>
                            <span className="text-xs text-muted-foreground shrink-0">
                              {new Date(entry.executed_at).toLocaleString(i18n.language)}
                            </span>
                          </div>
                          {entry.response && (
                            <p className={cn('mt-1 truncate text-xs font-mono', entry.success ? 'text-muted-foreground' : 'text-destructive')}>
                              {entry.response}
                            </p>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
