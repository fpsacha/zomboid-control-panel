import { useEffect, useState, useRef, useCallback, useMemo, memo } from 'react'
import { Terminal as TerminalIcon, Send, Trash2, WifiOff, Loader2, Megaphone, FileText, RefreshCw, Pause, Play, Filter, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/use-toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { rconApi, configApi, serverApi, serversApi, type ServerInstance } from '@/lib/api'
import { useSocket } from '@/contexts/SocketContext'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { cn } from '@/lib/utils'
import { usePageShortcut } from '@/hooks/useKeyboardShortcuts'
import { useTranslation } from 'react-i18next';



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
const chatChannels = [
  { value: 'all',       labelKey: 'channels.all',       descriptionKey: 'channels.allDescription' },
  { value: 'admin',     labelKey: 'channels.admin',     descriptionKey: 'channels.adminDescription' },
  { value: 'say',       labelKey: 'channels.say',       descriptionKey: 'channels.sayDescription' },
  { value: 'faction',   labelKey: 'channels.faction',   descriptionKey: 'channels.factionDescription' },
  { value: 'safehouse', labelKey: 'channels.safehouse', descriptionKey: 'channels.safehouseDescription' },
]

// Memoized log line to avoid re-rendering unchanged lines
const ServerLogLine = memo(function ServerLogLine({ line }: { line: string }) {
  const parsed = parseLogLine(line)
  if (!parsed.message && !parsed.raw.trim()) return null

  return (
    <div
      className={cn(
        'border-l px-2 py-0.5 leading-tight',
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

const quickCommands = [
  { labelKey: 'quickCommands.players', command: 'players' },
  { labelKey: 'quickCommands.save', command: 'save' },
  { labelKey: 'quickCommands.showOptions', command: 'showoptions' },
  { labelKey: 'quickCommands.checkMods', command: 'checkModsNeedUpdate' },
  { labelKey: 'quickCommands.help', command: 'help' },
  { labelKey: 'quickCommands.serverInfo', command: 'serverinfo' },
  { labelKey: 'quickCommands.getMemory', command: 'getmemory' },
]

// Quick broadcast message templates
const quickBroadcasts = [
  { labelKey: 'quickBroadcasts.restart15', messageKey: 'quickBroadcasts.restart15Message' },
  { labelKey: 'quickBroadcasts.restart5', messageKey: 'quickBroadcasts.restart5Message' },
  { labelKey: 'quickBroadcasts.restart1', messageKey: 'quickBroadcasts.restart1Message' },
  { labelKey: 'quickBroadcasts.maintenance', messageKey: 'quickBroadcasts.maintenanceMessage' },
  { labelKey: 'quickBroadcasts.backOnline', messageKey: 'quickBroadcasts.backOnlineMessage' },
  { labelKey: 'quickBroadcasts.saveWarning', messageKey: 'quickBroadcasts.saveWarningMessage' },
]

export default function Console() {
  const { t } = useTranslation('console');
  
  
  
  
  const [command, setCommand] = useState('')
  const [activeServer, setActiveServer] = useState<ServerInstance | null>(null)
  const [consoleTargetLoading, setConsoleTargetLoading] = useState(true)
  const [history, setHistory] = useState<CommandEntry[]>([])
  const [liveLog, setLiveLog] = useState<RconResponse[]>([])
  const [loading, setLoading] = useState(false)
  const [commandHistoryIndex, setCommandHistoryIndex] = useState(-1)
  const [commandCache, setCommandCache] = useState<string[]>([])
  const [rconConnected, setRconConnected] = useState<boolean | null>(null)
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
          title: t('serverLogUnavailable.remoteTitle'),
          description: t('serverLogUnavailable.remoteDescription'),
        }
      : {
          title: t('serverLogUnavailable.pathTitle'),
          description: t('serverLogUnavailable.pathDescription'),
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

    return () => {
      cancelled = true
    }
  }, [])

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
      const data = await rconApi.getHistory(50)
      setHistory(data.history || [])
      setCommandCache(data.history?.map((h: CommandEntry) => h.command).reverse() || [])
    } catch {
      toast({
        title: t('messages.historyUnavailableTitle'),
        description: t('messages.historyUnavailable'),
        variant: 'destructive',
      })
    }
  }, [hasActiveServer, t, toast])

  const testRconConnection = useCallback(async () => {
    if (!hasRconConfig) {
      setRconConnected(null)
      setTestingConnection(false)
      return
    }

    setTestingConnection(true)
    try {
      const result = await configApi.testRcon()
      setRconConnected(result.success && result.connected)
    } catch {
      setRconConnected(false)
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
        setServerLogError(t('messages.logStreamUnavailable'))
      }
    } finally {
      setServerLogLoading(false)
    }
  }, [hasServerLogSource, t])

  const clearServerLog = async () => {
    try {
      await serverApi.clearConsoleLog()
      setServerLogLines([])
      setServerLogSize(0)
      toast({
        title: t('messages.logClearedTitle'),
        description: t('messages.logCleared'),
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('messages.error'),
        description: t('messages.clearLogFailed'),
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
    }
    // Auto-focus input on mount
    inputRef.current?.focus()
  }, [fetchHistory, hasActiveServer, hasRconConfig, testRconConnection])

  useEffect(() => {
    if (socket) {
      const handleRconResponse = (data: RconResponse) => {
        const entry = { ...data, _id: ++liveLogIdRef.current } as RconResponse & { _id: number }
        setLiveLog(prev => [...prev, entry].slice(-100))
        // If we get a response, RCON is connected
        setRconConnected(true)
      }

      socket.on('rcon:response', handleRconResponse)

      return () => {
        socket.off('rcon:response', handleRconResponse)
      }
    }
  }, [socket])

  useEffect(() => {
    // Auto-scroll to bottom
    if (scrollRef.current) {
      const el = scrollRef.current
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
    }
  }, [liveLog])

  const executeCommand = async () => {
    if (!command.trim()) return

    setLoading(true)
    try {
      const result = await rconApi.execute(command)
      
      // Update connection status based on result
      if (result.error?.includes('Server is not running') || result.error?.includes('ECONNREFUSED')) {
        setRconConnected(false)
      } else if (result.success) {
        setRconConnected(true)
      }
      
      // Add to live log only when socket updates are unavailable to avoid duplicates.
      if (!socket?.connected) {
        setLiveLog(prev => [...prev, {
          command,
          response: result.response || result.error || t('messages.noResponse'),
          success: result.success,
          timestamp: new Date().toISOString(),
          _id: ++liveLogIdRef.current,
        } as RconResponse & { _id: number }].slice(-100))
      }

      // Add to command cache (limit to 100 entries)
      setCommandCache(prev => [...prev.slice(-99), command])
      setCommandHistoryIndex(-1)
      setCommand('')
      
      // Re-focus input after command execution
      inputRef.current?.focus()
      
      fetchHistory()
    } catch (error) {
      setRconConnected(false)
      toast({
        title: t('messages.error'),
        description: error instanceof Error ? error.message : t('messages.commandFailed'),
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

    setSendingAnnouncement(true)
    try {
      const cleaned = announcement.replace(/"/g, '\\"')
      const cmd = selectedChannel === 'all'
        ? `servermsg "${cleaned}"`
        : `servermsg "[${selectedChannel.toUpperCase()}] ${cleaned}"`
      const result = await rconApi.execute(cmd)

      setLiveLog(prev => [...prev, {
        command: cmd,
        response: result.response || result.error || t('messages.broadcastSent'),
        success: result.success,
        timestamp: new Date().toISOString(),
        _id: ++liveLogIdRef.current,
      } as RconResponse & { _id: number }].slice(-100))

      if (result.success) {
        toast({
          title: t('messages.broadcastSentTitle'),
          description: selectedChannel === 'all'
            ? t('messages.broadcastSentToAll')
            : t('messages.broadcastSentWithTag', { tag: selectedChannel.toUpperCase() }),
          variant: 'success' as const,
        })
        setAnnouncement('')
        setRconConnected(true)
      } else {
        throw new Error(result.error || t('messages.broadcastFailed'))
      }
    } catch (error) {
      toast({
        title: t('messages.error'),
        description: error instanceof Error ? error.message : t('messages.broadcastFailed'),
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
          title={t('title')}
          description={t('descriptions.serverLogAndRcon')}
          tone="ops"
          icon={<TerminalIcon className="w-5 h-5" />}
        />
        <div className="flex min-h-[18rem] items-center justify-center rounded-md border border-border/50 bg-card/50">
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('status.checkingTarget')}
          </div>
        </div>
      </div>
    )
  }

  if (!hasActiveServer) {
    return (
      <div className="space-y-6 page-transition">
        <PageHeader
          title={t('title')}
          description={t('descriptions.serverLogAndRcon')}
          tone="ops"
          icon={<TerminalIcon className="w-5 h-5" />}
        />
        <div className="rounded-md border border-border/50 bg-card/50 p-4">
          <EmptyState
            type="empty"
            title={t('emptyStates.noActiveServer')}
            description={t('descriptions.addOrSelectServer')}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={t('title')}
        description={t('descriptions.serverLogAndRcon')}
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
            {t('tabs.logs')}
          </TabsTrigger>
          <TabsTrigger
            value="rcon"
            className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-none rounded-sm"
          >
            <TerminalIcon className="w-3.5 h-3.5" />
            {t('tabs.console')}
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
              <span className="font-mono text-[9px] uppercase tracking-[0.24em] text-primary/60 shrink-0">{t('path')}</span>
              <p className="text-xs text-foreground/80 font-mono truncate">
                {serverLogPath ? serverLogPath : <span className="text-muted-foreground/50">{t('loading')}</span>}
              </p>
              {serverLogLoading && <Loader2 className="w-3 h-3 animate-spin text-primary/70 shrink-0" />}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em]"
                onClick={() => setServerLogPaused(!serverLogPaused)}
                aria-label={serverLogPaused ? t('status.resumeAutoUpdate') : t('status.pauseAutoUpdate')}
              >
                {serverLogPaused
                  ? <><Play className="w-3 h-3 mr-1" />{t('actions.resume')}</>
                  : <><Pause className="w-3 h-3 mr-1" />{t('actions.pause')}</>}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setServerLogFiltered(!serverLogFiltered)}
                aria-label={serverLogFiltered ? t('filter.showAllAria') : t('filter.repetitiveAria')}
                title={serverLogFiltered
                  ? t('filter.hiddenTitle', { count: Math.max(0, serverLogLines.length - filteredLogLines.length) })
                  : t('filter.repetitiveTitle')}
                className={cn('h-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em]', serverLogFiltered && 'text-primary')}
              >
                <Filter className="w-3 h-3 mr-1" />
                {serverLogFiltered
                  ? (serverLogLines.length > filteredLogLines.length
                      ? t('filter.count', { count: serverLogLines.length - filteredLogLines.length })
                      : t('filter.label'))
                  : t('filter.all')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setServerLogAutoScroll(!serverLogAutoScroll)}
                aria-label={serverLogAutoScroll ? t('autoScroll.disable') : t('autoScroll.enable')}
                title={serverLogAutoScroll ? t('autoScroll.on') : t('autoScroll.off')}
                className={cn('h-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em]', serverLogAutoScroll ? 'text-primary' : 'text-muted-foreground')}
              >
                {t('autoScroll.follow', { state: serverLogAutoScroll ? t('autoScroll.onShort') : t('autoScroll.offShort') })}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => fetchServerLog(true)}
                aria-label={t('ariaLabels.refreshLog')}
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="destructive" size="sm" className="h-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em]" onClick={clearServerLog}>
                    <Trash2 className="w-3 h-3 mr-1" />
                    {t('actions.clear')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('clearTheLogDisplayDoesNotDeleteTheServerLogFile')}</TooltipContent>
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
                {t('actions.retry')}
              </Button>
            </div>
          )}

          {/* Terminal pane — framed tactical viewer */}
          {!serverLogExists ? (
            <div className="flex h-[calc(100vh-360px)] min-h-[300px] items-center justify-center rounded-md border border-border/50 bg-muted/20 p-4">
              <EmptyState type="serverOffline" title={t('emptyStates.serverOffline')} description={t('emptyStates.serverOfflineDesc')} compact />
            </div>
          ) : (
            <div className="relative rounded-md border border-border/55 bg-card/85 overflow-hidden shadow-lg">
              {/* corner brackets */}
              <div aria-hidden className="absolute top-1 left-1 w-2.5 h-2.5 border-l-2 border-t-2 border-primary/45 pointer-events-none z-10" />
              <div aria-hidden className="absolute top-1 right-1 w-2.5 h-2.5 border-r-2 border-t-2 border-primary/45 pointer-events-none z-10" />
              <div aria-hidden className="absolute bottom-1 left-1 w-2.5 h-2.5 border-l-2 border-b-2 border-primary/45 pointer-events-none z-10" />
              <div aria-hidden className="absolute bottom-1 right-1 w-2.5 h-2.5 border-r-2 border-b-2 border-primary/45 pointer-events-none z-10" />
              {/* header strip */}
              <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border/50 bg-muted/30 font-mono text-[9px] uppercase tracking-[0.24em] select-none">
                <span className="flex items-center gap-1.5 text-primary/65">
                  <span>{t('stream')}</span>
                  <span className="text-muted-foreground/40 normal-case tracking-normal">·</span>
                  <span className="text-muted-foreground/80 normal-case tracking-normal">{serverLogPaused ? t('status.paused') : t('status.live')}</span>
                </span>
                <span className="flex items-center gap-1.5 text-muted-foreground/60">
                  <span className={cn('w-1.5 h-1.5 rounded-full', serverLogPaused ? 'bg-amber-400/70' : 'bg-emerald-400/80 animate-pulse')} />
                  <span>{serverLogPaused ? t('status.paused') : t('status.streaming')}</span>
                </span>
              </div>
              <div
                ref={serverLogRef}
                role="log"
                aria-live="polite"
                aria-label={t('ariaLabels.serverConsoleOutput')}
                className="h-[calc(100vh-400px)] min-h-[280px] overflow-auto bg-black/60 p-3 font-mono text-xs terminal-output"
              >
                {filteredLogLines.length === 0 ? (
                  <div className="p-2 font-mono text-[11px] text-muted-foreground/70">
                    {serverLogFiltered && serverLogLines.length > 0 ? (
                      <span>
                        {t('filter.linesHidden', { count: serverLogLines.length })} ·{' '}
                        <button
                          type="button"
                          className="underline underline-offset-2 text-primary/80 hover:text-primary"
                          onClick={() => setServerLogFiltered(false)}
                        >
                          {t('filter.showAll')}
                        </button>
                      </span>
                    ) : (
                      <span>{t('noStreamOutput')}</span>
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
                    ? <>{t('counts.shown')} <span className="text-foreground/80">{filteredLogLines.length}</span> · {t('counts.hidden')} <span className="text-muted-foreground/50">{serverLogLines.length - filteredLogLines.length}</span></>
                    : <>{t('counts.loaded')} <span className="text-foreground/80">{serverLogLines.length}</span></>}
                </span>
                <span>{serverLogPaused ? t('status.updatesSuspended') : t('status.polling')}</span>
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
              <span className="font-mono text-[9px] uppercase tracking-[0.24em] text-primary/60 shrink-0">{t('link')}</span>
              {testingConnection ? (
                <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {t('status.checking')}
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
              <RefreshCw className={cn('w-3 h-3 mr-1', testingConnection && 'animate-spin')} />
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
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-warning">{t('rconNotConfigured')}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t('rcon.configureDescription')}
                </p>
              </div>
            </div>
          )}

          {/* RCON Disconnected Warning */}
          {hasRconConfig && rconConnected === false && (
            <div
              role="alert"
              className="flex items-center gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2"
            >
              <WifiOff className="w-4 h-4 shrink-0 text-destructive" />
              <div className="min-w-0">
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-destructive">{t('hostUnreachable')}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t('rcon.unreachableDescription')}
                </p>
              </div>
            </div>
          )}

          {/* Console Output (primary surface) */}
          <div className="relative rounded-md border border-border/55 bg-card/85 overflow-hidden shadow-lg">
            <div aria-hidden className="absolute top-1 left-1 w-2.5 h-2.5 border-l-2 border-t-2 border-primary/45 pointer-events-none z-10" />
            <div aria-hidden className="absolute top-1 right-1 w-2.5 h-2.5 border-r-2 border-t-2 border-primary/45 pointer-events-none z-10" />
            <div aria-hidden className="absolute bottom-1 left-1 w-2.5 h-2.5 border-l-2 border-b-2 border-primary/45 pointer-events-none z-10" />
            <div aria-hidden className="absolute bottom-1 right-1 w-2.5 h-2.5 border-r-2 border-b-2 border-primary/45 pointer-events-none z-10" />
            {/* header strip */}
            <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border/50 bg-muted/30 font-mono text-[9px] uppercase tracking-[0.24em] select-none">
              <span className="flex items-center gap-1.5 text-primary/65">
                <span>{t('rconOutput')}</span>
                <span className="text-muted-foreground/40 normal-case tracking-normal">·</span>
                <span className="text-muted-foreground/80 normal-case tracking-normal tabular-nums">{t('counts.entries', { count: liveLog.length })}</span>
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
                    <Trash2 className="w-3 h-3 mr-1" />
                    {t('actions.clear')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('clearTheVisibleOutputDoesNotDeleteHistory')}</TooltipContent>
              </Tooltip>
            </div>
            <div
              ref={scrollRef}
              role="log"
              aria-live="polite"
              aria-label={t('ariaLabels.rconCommandOutput')}
              className="h-[18rem] min-h-[220px] sm:h-[22rem] lg:h-[26rem] overflow-auto bg-black/60 p-3 terminal-output"
            >
              {liveLog.length === 0 ? (
                <EmptyState compact type="noMessages" title={t('emptyStates.noCommands')} description={t('emptyStates.noCommandsDesc')} />
              ) : (
                liveLog.map((entry, idx) => (
                  <div key={(entry as RconResponse & { _id?: number })._id ?? `${entry.timestamp}-${idx}`} className="mb-3 font-mono text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-primary">$</span>
                      <span className="text-foreground/90">{entry.command}</span>
                      <span className="text-muted-foreground/60 text-[10px] ml-auto tabular-nums font-mono">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className={cn('ml-4 mt-0.5 text-xs border-l-2 pl-2', entry.success ? 'border-primary/30 text-foreground/85' : 'border-destructive/50 text-destructive')}>
                      {entry.response.split('\n').map((line, i) => (
                        <div key={`line-${i}`}>{line || '\u00A0'}</div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Quick Commands */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[9px] uppercase tracking-[0.24em] text-primary/60 mr-1">{t('quick')}</span>
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
                {t(qc.labelKey)}
              </Button>
            ))}
          </div>

          {/* Command Input */}
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[11px] uppercase tracking-[0.18em] text-primary/70 pointer-events-none select-none" aria-hidden="true">
                rcon $
              </span>
              <Input
                ref={inputRef}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('input.placeholder')}
                className="pl-[5.5rem] font-mono bg-card/70 border-border/55 focus-visible:border-primary/60"
                disabled={loading || !hasRconConfig}
                maxLength={2000}
                aria-label={t('ariaLabels.rconCommandInput')}
              />
            </div>
            <Button
              onClick={executeCommand}
              disabled={loading || !command.trim() || !hasRconConfig}
              aria-label={t('ariaLabels.executeCommand')}
              className="font-mono text-[11px] uppercase tracking-[0.18em]"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Send className="w-3.5 h-3.5 mr-1.5" />{t('input.run')}</>}
            </Button>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60">
            // {t('input.keyboardHint')}
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
                <span>{t('broadcast')}</span>
                <span className="text-muted-foreground/40 normal-case tracking-normal">·</span>
                <span className="text-muted-foreground/70 normal-case tracking-normal">{t('messageAllOnline')}</span>
              </span>
              <ChevronDown className={cn('w-3.5 h-3.5 text-muted-foreground transition-transform', showBroadcast && 'rotate-180')} />
            </button>
            {showBroadcast && (
              <div className="border-t border-border/40 p-4 space-y-3">
                {/* Quick templates */}
                <div className="flex flex-wrap gap-1.5">
                  {quickBroadcasts.map((qb) => (
                    <Button
                      key={qb.labelKey}
                      variant="outline"
                      size="sm"
                      className="text-xs h-7"
                      onClick={() => setAnnouncement(t(qb.messageKey))}
                      disabled={!hasRconConfig || rconConnected === false}
                    >
                      {t(qb.labelKey)}
                    </Button>
                  ))}
                </div>

                {/* Channel tag selector */}
                <div className="grid gap-2 sm:grid-cols-[180px_1fr] sm:items-start">
                  <Select value={selectedChannel} onValueChange={setSelectedChannel}>
                    <SelectTrigger aria-label={t('ariaLabels.channelTag')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {chatChannels.map((channel) => (
                        <SelectItem key={channel.value} value={channel.value}>
                          <div className="flex flex-col">
                            <span>{t(channel.labelKey)}</span>
                            <span className="text-xs text-muted-foreground">{t(channel.descriptionKey)}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Textarea
                    value={announcement}
                    onChange={(e) => setAnnouncement(e.target.value)}
                    placeholder={selectedChannel === 'all'
                      ? t('broadcastInput.allPlaceholder')
                      : t('broadcastInput.taggedPlaceholder', { tag: selectedChannel.toUpperCase() })}
                    aria-label={t('ariaLabels.broadcastMessage')}
                    className="min-h-[80px]"
                    maxLength={500}
                    disabled={sendingAnnouncement || !hasRconConfig || rconConnected === false}
                  />
                </div>

                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    {t('broadcastInput.servermsgPrefix')} <code className="text-foreground/80">servermsg</code>. {t('broadcastInput.servermsgSuffix')}
                  </p>
                  <Button
                    onClick={sendAnnouncement}
                    disabled={sendingAnnouncement || !announcement.trim() || !hasRconConfig || rconConnected === false}
                  >
                    {sendingAnnouncement ? (
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    ) : (
                      <Send className="w-4 h-4 mr-2" />
                    )}
                    {t('input.sendButton')}
                  </Button>
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
                <span>{t('input.history')}</span>
                {history.length > 0 && (
                  <>
                    <span className="text-muted-foreground/40 normal-case tracking-normal">·</span>
                            <span className="text-muted-foreground/70 normal-case tracking-normal tabular-nums">{t('counts.entries', { count: history.length })}</span>
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
                    className="pl-8 h-8 text-sm"
                    aria-label={t('history.searchPlaceholder')}
                  />
                </div>
                <ScrollArea className="h-[16rem] min-h-[200px] sm:h-[20rem] rounded-lg border border-border/30 bg-black/40">
                  {history.length === 0 ? (
                    <EmptyState compact type="noData" title={t('emptyStates.noHistory')} description={t('emptyStates.noHistoryDesc')} />
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
                          className="w-full text-left p-2.5 rounded-md hover:bg-muted/30 cursor-pointer transition-colors"
                          onClick={() => {
                            setCommand(entry.command)
                            inputRef.current?.focus()
                          }}
                        >
                          <div className="flex items-center justify-between">
                            <code className="text-sm font-mono text-primary truncate">{entry.command}</code>
                            <span className="text-xs text-muted-foreground">
                              {new Date(entry.executed_at).toLocaleString()}
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
