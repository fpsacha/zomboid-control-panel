import { useEffect, useState, useRef, useCallback, useMemo, memo } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Terminal as TerminalIcon, Send, Trash2, Loader2, Megaphone, FileText, RefreshCw, Pause, Play, Filter, History, ArrowDownToLine, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/use-toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SectionCard } from '@/components/ui/section-card'
import { StatusPill } from '@/components/ui/status-pill'
import { Skeleton } from '@/components/ui/skeleton'
import { rconApi, configApi, serverApi, serversApi, ApiError, type ServerInstance } from '@/lib/api'
import { useSocket } from '@/contexts/SocketContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useAuth } from '@/contexts/AuthContext'
import { EmptyState, type EmptyStateAction } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { PageAlerts, type PageAlert } from '@/components/PageAlerts'
import { DisabledReason } from '@/components/DisabledReason'
import { HelpTip } from '@/components/HelpTip'
import { cn } from '@/lib/utils'
import { getUserErrorMessage, getResultErrorMessage } from '@/lib/errorMessage'
import { formatTime, useDateFormat } from '@/lib/dateFormat'
import { usePageShortcut } from '@/hooks/useKeyboardShortcuts'
import { useRequestGuard } from '@/hooks/useRequestGuard'
import { useUrlParamState } from '@/hooks/useUrlParamState'

// The two tabs, kept in ?tab= so a reload, the command palette and the
// Dashboard's work items open the right one (/console?tab=rcon).
const CONSOLE_TABS = ['log', 'rcon'] as const
type ConsoleTab = (typeof CONSOLE_TABS)[number]

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
  // The server the command ran against (server/routes/rcon.js). The
  // "rcon-live" room is global, so this is what tells one server's output
  // apart from another's.
  serverId?: string | number | null
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
          ? 'border-destructive/40 bg-destructive/10'
          : parsed.type === 'WARN'
            ? 'border-warning/40 bg-warning/10'
            : parsed.type === 'INFO'
              ? 'border-primary/20 bg-primary/5'
              : 'border-transparent'
      )}
    >
      <div className="flex items-baseline gap-1.5">
        {parsed.time && (
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {parsed.time}
          </span>
        )}
        {parsed.type !== 'UNKNOWN' && (
          <span className={`px-1 rounded text-[10px] font-semibold uppercase tracking-wide shrink-0 ${typeBadgeColors[parsed.type]}`}>
            {parsed.type}
          </span>
        )}
        {parsed.category && (
          <span className="shrink-0 text-muted-foreground">[{parsed.category}]</span>
        )}
        <span className={`${typeColors[parsed.type]} break-words min-w-0`}>
          {parsed.message || parsed.raw}
        </span>
      </div>
    </div>
  )
})

// `command` is the literal RCON command text sent to the server and must
// stay untranslated; only the button label is looked up. Every entry must be a
// command the PZ server really registers (zombie.commands.serverCommands.*,
// checked with javap against projectzomboid.jar): this list used to also carry
// `serverinfo` and `getmemory`, which no PZ build defines -- both buttons just
// returned PZ's "unknown command" reply.
const quickCommandDefs = [
  { key: 'players', command: 'players' },
  { key: 'save', command: 'save' },
  { key: 'showOptions', command: 'showoptions' },
  { key: 'checkMods', command: 'checkModsNeedUpdate' },
  { key: 'help', command: 'help' },
] as const

// Raw RCON commands that disconnect players, change who can access the server,
// rewrite its settings, delete world data or stop it -- most cannot be undone
// from this console. Names checked with javap against projectzomboid.jar
// (zombie.commands.serverCommands.*, @CommandName/@CommandNames aliases
// included: `kick` and `kickuser` are the same command). Typing one of these
// asks for a confirmation that names the command and the target server first.
const DESTRUCTIVE_RCON_COMMANDS: ReadonlySet<string> = new Set([
  'quit',
  'kick',
  'kickuser',
  'banuser',
  'banid',
  'banip',
  'removeuserfromwhitelist',
  'removesteamid',
  'changeoption',
  'setaccesslevel',
  'grantadmin',
  'removeadmin',
  'setpassword',
  'remove',
  'removezombies',
  'removeitem',
  'removemapsymbolsforuser',
  'releasesafehouse',
  'kickfromsafehouse',
])

// The command word PZ dispatches on: first whitespace-delimited token, an
// optional leading `/` (in-game chat style) dropped, case-insensitive.
function getRconCommandName(commandLine: string): string {
  return (commandLine.trim().replace(/^\/+/, '').split(/\s+/)[0] ?? '').toLowerCase()
}

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

// PZ's RCON parser (zombie.commands.CommandBase, javap-checked against
// projectzomboid.jar) tokenizes the command line with ([^"]\S*|".*?")\s* and
// then deletes every double quote from each token -- there is NO escape syntax.
// A message containing `"` therefore split into extra tokens (the old
// `\"` escaping here did nothing), servermsg's single-argument pattern no
// longer matched, and PZ answered with servermsg's help text instead of
// broadcasting. Same for a newline typed into the broadcast box. Mirrors
// RconService.sanitizeServerMessage (server/services/rcon.js), which the
// scheduler's announcements already go through: quotes/backslashes/control
// characters are removed and whitespace runs collapse to one space.
function sanitizeBroadcastText(input: string): string {
  return input
    .replace(/[‘’]/g, "'")
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["“”\\]|\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// PZ answers a servermsg whose arguments it could not parse with the command's
// help text ("... Use: /servermsg "My Message""), which arrives as an ordinary
// successful RCON reply. rconService.serverMessage() detects the same reply
// server-side for scheduled broadcasts; this is the console page's own copy.
const SERVERMSG_REJECTED_PATTERN = /Use:\s*\/servermsg/i

// No pagination on this panel -- when a fetch returns exactly this many
// rows, older commands may exist and be silently excluded (server allows
// up to 1000, see server/routes/rcon.js). Hint, not a hard truth: hitting
// the limit exactly by coincidence is possible too.
const COMMAND_HISTORY_FETCH_LIMIT = 50

export default function Console() {
  const { t } = useTranslation('console')
  const { formatDateTime } = useDateFormat()
  const chatChannels = useMemo(() => getChatChannels(t), [t])
  const quickCommands = useMemo(() => getQuickCommands(t), [t])
  const quickBroadcasts = useMemo(() => getQuickBroadcasts(t), [t])
  const [command, setCommand] = useState('')
  const [activeServer, setActiveServer] = useState<ServerInstance | null>(null)
  const [consoleTargetLoading, setConsoleTargetLoading] = useState(true)
  const [history, setHistory] = useState<CommandEntry[]>([])
  // bug-hunt-2026-09-18 (round 5): fetchHistory's failure branch used to only
  // pop a toast (gone in a few seconds) and leave `history` at its initial
  // `[]` -- indistinguishable from a server that genuinely has no command
  // history yet. Opening this panel after the toast expired (or never seeing
  // it because the panel was collapsed on load, its default state) showed a
  // confident "No command history" with no way to tell the fetch had failed
  // or retry it short of an unrelated action that happens to call
  // fetchHistory again. historyLoading/historyLoadError make that a real
  // loading/error state instead of a silent empty one.
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyLoadError, setHistoryLoadError] = useState<string | null>(null)
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
  const [commandDraft, setCommandDraft] = useState('') // saves in-progress text while browsing history
  const liveLogIdRef = useRef(0) // monotonic counter for stable liveLog keys
  // bug-hunt-2026-09-18 (round 8): loadConsoleTarget runs once on mount AND
  // again on every 'activeServerChanged' socket event, all sharing this one
  // effect's `cancelled` flag -- but that flag only flips on UNMOUNT, not
  // between two overlapping calls to the same function while it's still
  // mounted. Switching the active server twice in quick succession (or once,
  // right after mount, before the initial GET /servers lands) fires two
  // overlapping requests; whichever RESPONSE arrives last wins regardless of
  // which request was SENT last -- an older, slower response can overwrite
  // the newer one it should have lost to. Mirrors RolesPermissions.tsx's
  // pendingCapabilitiesRef guard: a monotonic counter bumped at the start of
  // each call, checked again when it resolves, so a stale response that
  // lands after a newer call has already started is dropped instead of
  // applied.
  const consoleTargetRequestIdRef = useRef(0)
  // bug-hunt-2026-09-18 (round 20): clearServerLog()'s confirm() dialog is a
  // Promise that only resolves once the operator clicks Confirm/Cancel --
  // while it's open, the active server can switch elsewhere (another tab,
  // another admin), and serverApi.clearConsoleLog() resolves "the active
  // server" server-side with no server id, same shape as Backups.tsx's own
  // serverChangedSinceLoad fixes (pz-bughunt round 17). Confirming a dialog
  // opened for server A while the backend has already moved on to server B
  // silently cleared B's log, not A's -- the operator had no way to know.
  // Same pattern: set true on activeServerChanged, checked right before the
  // destructive call, cleared once loadConsoleTarget's fresh read for the
  // new server lands.
  const [serverChangedSinceLoad, setServerChangedSinceLoad] = useState(false)
  // clearServerLog() reads THIS, not the state variable above, after its
  // `await confirm(...)` -- a value read from a closure captured back when
  // the button was clicked (i.e. the render active at click-time) would
  // still see the OLD, pre-switch "false" no matter how many renders and
  // state updates happened while the dialog sat open awaiting the
  // operator's click. A ref has no such staleness: `.current` is always
  // the value as of the exact instant it's read, not as of the instant the
  // enclosing async function was invoked.
  const serverChangedSinceLoadRef = useRef(false)
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
  // bug-hunt-2026-09-18 (round 19, client-vs-server permission gate sweep):
  // testRconConnection() below calls configApi.testRcon(), which hits POST
  // /config/test-rcon -- gated server-side on server.configure, NOT
  // rcon.execute (a distinct route from rcon.js's own /rcon/test, which IS
  // double-gated rcon.execute+servers.manage). The Recheck button had no
  // permission check at all, so a role holding rcon.execute but not
  // server.configure saw it fully enabled and only found out with a 403.
  const canConfigureServer = can('server.configure')
  // GET /server/console-log and /console-log/stream (server/routes/server.js)
  // require server.world_events. A role without it used to poll them every 2s
  // anyway, collecting a 403 each time and, after three, a "stream
  // unavailable" banner that blamed the stream instead of the missing
  // permission.
  const canViewServerLog = can('server.world_events')

  // Server Console Log state
  const [serverLogLines, setServerLogLines] = useState<string[]>([])
  const [_serverLogSize, setServerLogSize] = useState(0)
  const [serverLogPath, setServerLogPath] = useState('')
  const [serverLogExists, setServerLogExists] = useState(false)
  const [serverLogDownloading, setServerLogDownloading] = useState(false)
  // PT3: why the panel won't read the log ({ error, code } from the server:
  // the data folder no longer meets the data-folder rule, or none is set),
  // instead of "not found" while the server writes it somewhere else.
  const [serverLogRefusal, setServerLogRefusal] = useState<{ error?: string; code?: string } | null>(null)
  const [serverLogLoading, setServerLogLoading] = useState(false)
  const [serverLogError, setServerLogError] = useState<string | null>(null)
  const serverLogErrorCountRef = useRef(0)
  const [serverLogAutoScroll, setServerLogAutoScroll] = useState(true)
  const [serverLogPaused, setServerLogPaused] = useState(false)
  const [serverLogFiltered, setServerLogFiltered] = useState(true) // Filter out noise by default
  const [consoleTab, setConsoleTab] = useUrlParamState<ConsoleTab>('tab', CONSOLE_TABS, 'log')

  // Console keyboard shortcuts
  usePageShortcut('a', () => setServerLogAutoScroll(prev => !prev))
  usePageShortcut('`', () => setConsoleTab(consoleTab === 'log' ? 'rcon' : 'log'))
  const serverLogRef = useRef<HTMLDivElement>(null)
  const serverLogIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const serverLogSizeRef = useRef(0) // Track size without recreating interval
  // Identity token of the log file serverLogSizeRef belongs to, echoed back to
  // /console-log/stream so a recreated log is reported to THIS page too
  // (empty until the server has given one).
  const serverLogIdentityRef = useRef('')
  const hasActiveServer = !!activeServer
  // Identity of the server every panel below is showing. hasActiveServer /
  // hasServerLogSource / hasRconConfig are booleans, so they do NOT change when
  // the operator switches between two servers that are both set up -- the
  // effects keyed only on them never re-ran, leaving the previous server's log
  // lines, command history, RCON status and log offset on screen (and the
  // stream polling the new server's file from the old server's byte offset).
  const activeServerId = activeServer?.id ?? null
  // Read by the socket listener below, which is registered once per socket and
  // would otherwise close over the server that was active when it was created.
  const activeServerIdRef = useRef<string | number | null>(activeServerId)
  useEffect(() => {
    activeServerIdRef.current = activeServerId
  }, [activeServerId])
  // One guard per fetch flow (see useRequestGuard): a response that lands after
  // a newer call for the same flow started -- typically one issued for the
  // server that was active a moment ago -- is dropped instead of applied.
  const historyGuard = useRequestGuard()
  const rconStatusGuard = useRequestGuard()
  // Same idea for the server log, whose initial load and 2s stream polls share
  // one flow: bumped every time the polling effect (re)starts or stops, so a
  // response requested before that moment is ignored.
  const serverLogGenerationRef = useRef(0)
  const hasServerLogSource = !!activeServer && !activeServer.isRemote && Boolean(activeServer.zomboidDataPath || activeServer.installPath)
  // A readable log needs a source AND the capability to read it; everything
  // that fetches or polls keys on this, not on the source alone.
  const canPollServerLog = hasServerLogSource && canViewServerLog
  // GET /servers/active leaves the RCON host and port out for a role that
  // isn't shown where RCON connects (ServerInstance): for that role they are
  // hidden, not unset, and the masked password still says whether RCON is
  // set up -- reading them as missing put "RCON not configured" in front of
  // every moderator.
  const rconTargetHidden = !!activeServer && activeServer.rconHost === undefined && activeServer.rconPort === undefined
  const hasRconConfig = !!activeServer && Boolean(
    activeServer.rconPassword && (rconTargetHidden || (activeServer.rconHost && activeServer.rconPort)),
  )
  const serverLogUnavailable = !canViewServerLog
    ? {
        title: t('unavailable.noPermissionTitle'),
        description: t('unavailable.noPermissionDesc'),
      }
    : !hasServerLogSource
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
      const requestId = ++consoleTargetRequestIdRef.current
      try {
        const data = await serversApi.getAll()
        if (cancelled || requestId !== consoleTargetRequestIdRef.current) return

        const nextActiveServer = data.servers.find(server => server.isActive) ?? data.servers[0] ?? null
        setActiveServer(nextActiveServer)
      } catch {
        if (!cancelled && requestId === consoleTargetRequestIdRef.current) {
          setActiveServer(null)
        }
      } finally {
        if (!cancelled && requestId === consoleTargetRequestIdRef.current) {
          setConsoleTargetLoading(false)
          // See serverChangedSinceLoad's own comment above -- the brief
          // guard window closes once this reload (whether it was the
          // activeServerChanged-triggered one or a later one) has landed.
          serverChangedSinceLoadRef.current = false
          setServerChangedSinceLoad(false)
        }
      }
    }

    // bug-hunt-2026-09-18 (round 20): sets the guard BEFORE the reload
    // starts, not after -- clearServerLog()'s confirm() dialog can resolve
    // at any point during loadConsoleTarget()'s own await, and the guard
    // must already be true for that entire window, not just once the fresh
    // data has landed.
    const handleActiveServerChanged = () => {
      serverChangedSinceLoadRef.current = true
      setServerChangedSinceLoad(true)
      loadConsoleTarget()
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
    if (socket) socket.on('activeServerChanged', handleActiveServerChanged)

    return () => {
      cancelled = true
      if (socket) socket.off('activeServerChanged', handleActiveServerChanged)
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

  // Command history filtered by the search box below -- pulled into its own
  // memo (rather than inlined in the JSX .filter().map()) so the "history
  // has entries but none match this search" case can be told apart from
  // "history is genuinely empty" and get its own empty-state copy instead of
  // silently rendering a blank scroll area with no explanation.
  const filteredHistory = useMemo(() => {
    if (!historySearch) return history
    const q = historySearch.toLowerCase()
    return history.filter(entry =>
      entry.command.toLowerCase().includes(q) ||
      entry.response?.toLowerCase().includes(q)
    )
  }, [history, historySearch])

  const fetchHistory = useCallback(async () => {
    const ticket = historyGuard.next()
    // GET /rcon/history requires rcon.execute (it returns every command ever
    // typed, secrets included -- server/routes/rcon.js). Without it the fetch
    // could only 403 and pop a "History Unavailable" toast on every visit.
    if (!hasActiveServer || !canExecuteRcon) {
      setHistory([])
      setCommandCache([])
      setHistoryLoadError(null)
      setHistoryLoading(false)
      return
    }

    setHistoryLoading(true)
    setHistoryLoadError(null)
    try {
      const data = await rconApi.getHistory(COMMAND_HISTORY_FETCH_LIMIT)
      if (historyGuard.isStale(ticket)) return
      setHistory(data.history || [])
      setCommandCache(data.history?.map((h: CommandEntry) => h.command).reverse() || [])
    } catch {
      if (historyGuard.isStale(ticket)) return
      setHistoryLoadError(t('toasts.historyUnavailableDesc'))
      toast({
        title: t('toasts.historyUnavailableTitle'),
        description: t('toasts.historyUnavailableDesc'),
        variant: 'destructive',
      })
    } finally {
      if (!historyGuard.isStale(ticket)) setHistoryLoading(false)
    }
  }, [hasActiveServer, canExecuteRcon, historyGuard, toast, t])

  const testRconConnection = useCallback(async () => {
    const ticket = rconStatusGuard.next()
    // POST /config/test-rcon requires server.configure (not rcon.execute). A
    // role without it used to hit a 403 on mount, which the catch below reads
    // as "host unreachable" -- a false red banner that also disables the
    // command input for a role that CAN run commands. Leave the status
    // unknown instead; running a command still updates it.
    if (!hasRconConfig || !canConfigureServer) {
      setRconConnected(null)
      setRconFailureReason(null)
      setTestingConnection(false)
      return
    }

    setTestingConnection(true)
    try {
      const result = await configApi.testRcon()
      if (rconStatusGuard.isStale(ticket)) return
      setRconConnected(result.success && result.connected)
      setRconFailureReason(null)
    } catch (err) {
      if (rconStatusGuard.isStale(ticket)) return
      setRconConnected(false)
      // handleResponse() (lib/api.ts) throws on a 200 `{success:false}` body
      // too, so the unreachable/auth_failed split from the response payload
      // survives on err.data even though this is a caught throw, not a
      // resolved result.
      const data = err instanceof ApiError ? (err.data as { error?: string } | undefined) : undefined
      setRconFailureReason(data?.error === 'auth_failed' ? 'auth_failed' : 'unreachable')
    } finally {
      if (!rconStatusGuard.isStale(ticket)) setTestingConnection(false)
    }
  }, [hasRconConfig, canConfigureServer, rconStatusGuard])

  // Server Console Log functions
  const fetchServerLog = useCallback(async (initial = false) => {
    const generation = serverLogGenerationRef.current
    if (!canPollServerLog) {
      if (initial) {
        setServerLogLines([])
        setServerLogSize(0)
        setServerLogPath('')
        setServerLogExists(false)
        setServerLogRefusal(null)
        setServerLogError(null)
        serverLogErrorCountRef.current = 0
        serverLogSizeRef.current = 0
        serverLogIdentityRef.current = ''
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
        if (generation !== serverLogGenerationRef.current) return
        setServerLogLines(data.lines || [])
        setServerLogSize(data.size || 0)
        serverLogSizeRef.current = data.size || 0
        serverLogIdentityRef.current = typeof data.identity === 'string' ? data.identity : ''
        setServerLogPath(data.path || '')
        setServerLogExists(data.exists || false)
        setServerLogRefusal(data.refusal ?? null)
      } else {
        // Stream new content - use ref to avoid stale closure
        const data = serverLogIdentityRef.current
          ? await serverApi.streamConsoleLog(serverLogSizeRef.current, serverLogIdentityRef.current)
          : await serverApi.streamConsoleLog(serverLogSizeRef.current)
        if (generation !== serverLogGenerationRef.current) return
        if (typeof data.identity === 'string') serverLogIdentityRef.current = data.identity
        // The log can first appear after this page loaded (the game had not
        // started yet): the initial fetch said "no file" and nothing else
        // ever turned the pane on, so the lines the stream returned stayed
        // hidden behind the empty state.
        if (data.exists !== false && typeof data.currentSize === 'number') {
          setServerLogExists(true)
        }
        if (data.newLines && data.newLines.length > 0) {
          setServerLogLines(prev => [...prev, ...data.newLines].slice(-500))
        }
        if (data.rotated) {
          // File was rotated, replace all content (the same 500-line window
          // as above: the pane renders every line it holds)
          setServerLogLines((data.newLines || []).slice(-500))
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
      if (generation !== serverLogGenerationRef.current) return
      serverLogErrorCountRef.current += 1
      if (serverLogErrorCountRef.current >= 3) {
        setServerLogError(t('serverLog.streamUnavailable'))
      }
    } finally {
      if (generation === serverLogGenerationRef.current) setServerLogLoading(false)
    }
  }, [canPollServerLog, t])

  const clearServerLog = async () => {
    // POST /server/console-log/clear is gated server-side on server.configure
    // (server/routes/server.js); the button's disabled state alone is not a
    // gate, so the handler refuses too.
    if (!canConfigureServer) return
    const confirmed = await confirm({
      // Names the server the same way every other destructive confirm in
      // this app does (Mods.tsx, ServerConfig.tsx, Servers.tsx, Users.tsx) --
      // a bare "Erase the server console log?" gives no way to tell, from
      // the dialog alone, which server's log is about to be erased if the
      // operator has switched servers recently or has multiple tabs open.
      title: t('serverLog.clearConfirmTitle', { server: activeServer?.name || '' }),
      description: t('serverLog.clearConfirmDesc'),
      confirmLabel: t('serverLog.clearConfirmButton'),
    })
    if (!confirmed) return
    // bug-hunt-2026-09-18 (round 20): checked AFTER the confirm() await, not
    // before -- the switch this guards against can happen at any point
    // while the dialog was open, including after the operator had already
    // started reading it. Reads the REF, not the state variable -- see
    // serverChangedSinceLoadRef's own comment above for why the state
    // value alone would still be stale here.
    if (serverChangedSinceLoadRef.current) {
      toast({
        title: t('toasts.serverChangedSinceLoadTitle'),
        description: t('toasts.serverChangedSinceLoadDesc'),
        variant: 'destructive',
      })
      return
    }

    try {
      await serverApi.clearConsoleLog()
      setServerLogLines([])
      setServerLogSize(0)
      // The file is empty again, so the stream offset restarts at 0. Left at
      // the pre-clear size, the next poll asked for bytes past the end of the
      // shrunk file and only recovered through the server's "rotated"
      // fallback, which replaces the whole view. Bumping the generation drops
      // any poll already in flight for the old offset (it would otherwise put
      // the stale size back).
      serverLogSizeRef.current = 0
      serverLogGenerationRef.current += 1
      setServerLogLoading(false)
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

  // The whole server-console.txt, without building the support bundle.
  const downloadServerLog = async () => {
    setServerLogDownloading(true)
    try {
      await serverApi.downloadConsoleLog()
    } catch (error) {
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('toasts.downloadLogFailed')),
        variant: 'destructive',
      })
    } finally {
      setServerLogDownloading(false)
    }
  }

  // The active server changed to a different one: everything below that
  // describes the previous server -- its log lines, log path/offset, RCON
  // output, command history, connection status -- is cleared before the
  // effects further down (declared after this one, so they run after it in the
  // same commit) load the new server's data. Without this the old server's
  // output stayed under the new server's name until (and unless) fresh data
  // replaced it. `undefined` = first render, nothing to reset yet.
  const shownServerIdRef = useRef<string | number | null | undefined>(undefined)
  useEffect(() => {
    const previous = shownServerIdRef.current
    shownServerIdRef.current = activeServerId
    if (previous === undefined || previous === activeServerId) return
    setLiveLog([])
    setHistory([])
    setCommandCache([])
    setCommandHistoryIndex(-1)
    setCommandDraft('')
    setHistoryLoadError(null)
    setRconConnected(null)
    setRconFailureReason(null)
    setServerLogLines([])
    setServerLogSize(0)
    serverLogSizeRef.current = 0
    serverLogIdentityRef.current = ''
    setServerLogPath('')
    setServerLogExists(false)
    setServerLogRefusal(null)
    setServerLogError(null)
    serverLogErrorCountRef.current = 0
  }, [activeServerId])

  // Ref to track paused state for interval callback (avoids stale closure)
  const serverLogPausedRef = useRef(serverLogPaused)
  useEffect(() => {
    serverLogPausedRef.current = serverLogPaused
  }, [serverLogPaused])

  // Start/stop server log polling
  useEffect(() => {
    // Any response requested before this (re)start belongs to the previous
    // server / source and must not be applied -- see serverLogGenerationRef.
    serverLogGenerationRef.current += 1
    if (!canPollServerLog) {
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
      serverLogGenerationRef.current += 1
      if (serverLogIntervalRef.current) {
        clearInterval(serverLogIntervalRef.current)
        serverLogIntervalRef.current = null
      }
    }
  }, [fetchServerLog, canPollServerLog, activeServerId])

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
      // Drop an in-flight probe issued for the server that was active before.
      rconStatusGuard.next()
      setTestingConnection(false)
      setRconConnected(null)
      setRconFailureReason(null)
    }
    // Auto-focus input on mount
    inputRef.current?.focus()
  }, [fetchHistory, hasActiveServer, hasRconConfig, testRconConnection, rconStatusGuard, activeServerId])

  useEffect(() => {
    if (socket) {
      const handleRconResponse = (data: RconResponse) => {
        // "rcon-live" is one global room: an /execute against another server
        // reaches this page too. Untagged events (no serverId) are kept.
        if (data.serverId != null && String(data.serverId) !== String(activeServerIdRef.current)) return
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

  // RCON commands and broadcasts carry no server id: the backend resolves
  // "the active server" when the request arrives. Between an activeServerChanged
  // event and the reload that lands the new server's data, this page still
  // shows the previous server, so a command sent in that window would run on a
  // server other than the one the operator is looking at (same window
  // clearServerLog guards). Reads the ref, not the state -- see
  // serverChangedSinceLoadRef.
  const warnIfServerChanged = () => {
    if (!serverChangedSinceLoadRef.current) return false
    toast({
      title: t('toasts.serverChangedSinceLoadTitle'),
      description: t('toasts.serverChangedSinceLoadDesc'),
      variant: 'destructive',
    })
    return true
  }

  const executeCommand = async () => {
    if (!command.trim()) return
    if (!canExecuteRcon) return
    if (warnIfServerChanged()) return

    // Destructive raw commands (quit, banuser, changeoption, ...) run the
    // instant Enter is pressed, on whichever server the backend has active --
    // ask first, naming both the command and the server. Only the command
    // word goes in the dialog: the arguments can carry secrets (setpassword).
    const commandName = getRconCommandName(command)
    if (DESTRUCTIVE_RCON_COMMANDS.has(commandName)) {
      const confirmed = await confirm({
        title: t('rcon.destructiveConfirmTitle', { command: commandName, server: activeServer?.name || '' }),
        description: t('rcon.destructiveConfirmDesc'),
        confirmLabel: t('rcon.destructiveConfirmButton'),
      })
      if (!confirmed) return
      // The dialog can sit open while the active server changes -- same
      // window clearServerLog() re-checks after its own confirm().
      if (warnIfServerChanged()) return
    }

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
        // bug-hunt-2026-09-18 (round 13, client error-code display sweep;
        // round 15: switched from a getUserErrorMessage({code, message})
        // proxy to getResultErrorMessage(result) once round 14's Debug.tsx
        // fix found that getUserErrorMessage()'s params extraction only
        // works on a real ApiError instance -- a plain object like the
        // proxy this used to build would silently drop any {{placeholder}}
        // param a future coded result could carry, even though `result`
        // here is already the exact "parsed response body" shape
        // getResultErrorMessage() exists for): result.code was already read
        // three lines up (isRconDisconnectError) to update connection
        // state, but the toast below used to show result.error's raw prose
        // regardless -- for every disconnect shape rconService.execute()
        // can return (RCON_EXECUTE_DISCONNECTED covers several distinct
        // English strings: "Server is not running", "RCON reconnection
        // failed", and whatever getUserFriendlyError() classified it as), a
        // non-English operator saw untranslated English instead of the
        // already-registered, already-translated
        // errors.json:RCON_EXECUTE_DISCONNECTED string. getResultErrorMessage()
        // resolves result.code through the SAME registry every other error
        // path in this app uses, and falls back to result.error unchanged
        // for the bucket-C case (no code, e.g. "Server is starting, please
        // wait...") -- byte-identical behavior to before for that case.
        toast({
          title: t('toasts.errorTitle'),
          description: getResultErrorMessage(result, result.error || t('toasts.commandFailedFallback')),
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
    // Enter that picks a candidate in an IME (Chinese input) is not a send.
    if (e.nativeEvent.isComposing) return
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
    if (warnIfServerChanged()) return

    const cleaned = sanitizeBroadcastText(announcement)
    if (!cleaned) {
      // Nothing but quotes/control characters -- there is no message to send.
      toast({
        title: t('toasts.errorTitle'),
        description: t('toasts.broadcastFailedFallback'),
        variant: 'destructive',
      })
      return
    }

    setSendingAnnouncement(true)
    try {
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

      if (result.success && typeof result.response === 'string' && SERVERMSG_REJECTED_PATTERN.test(result.response)) {
        // PZ replied with servermsg's help text: nothing was broadcast, so
        // keep the draft in the box instead of announcing success.
        toast({
          title: t('toasts.errorTitle'),
          description: t('toasts.broadcastFailedFallback'),
          variant: 'destructive',
        })
      } else if (result.success) {
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
        // Same fix as executeCommand above: translate through result.code
        // instead of showing its raw English prose unconditionally.
        toast({
          title: t('toasts.errorTitle'),
          description: getResultErrorMessage(result, result.error || t('toasts.broadcastFailedFallback')),
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



  // Live RCON state for the header: one pill on both tabs, so the operator
  // sees whether commands can run before switching to the RCON console.
  // "Not configured" links straight to where it is fixed.
  const rconStatus = consoleTargetLoading || !hasActiveServer
    ? null
    : testingConnection
      ? <StatusPill tone="busy" label={t('rcon.checking')} />
      : !hasRconConfig
        ? <StatusPill tone="warn" label={t('rcon.notConfigured')} to="/servers" title={t('actions.editServer')} />
        : rconConnected === null
          ? <StatusPill tone="idle" label={t('rcon.unknown')} />
          : rconConnected
            ? <StatusPill tone="ok" label={t('rcon.online')} />
            : <StatusPill tone="error" label={t('rcon.offline')} />

  // RCON problems, each with its fix. Title/desc branch on WHY the probe
  // failed (see rconFailureReason above) so a reachable host with a stale
  // password isn't told to go debug its network, and a mid-session
  // transport drop -- host/port/password just proven correct -- isn't told
  // to go re-check them either. Host, port and password are set per server
  // on the Servers page, so that is where "Edit server" goes.
  const rconAlerts: PageAlert[] = []
  if (!hasRconConfig) {
    rconAlerts.push({
      id: 'rcon-not-configured',
      tone: 'warning',
      title: t('rcon.notConfiguredTitle'),
      description: t('rcon.notConfiguredDesc'),
      action: { label: t('actions.editServer'), to: '/servers' },
    })
  } else if (rconConnected === false) {
    if (rconFailureReason === 'dropped') {
      rconAlerts.push({
        id: 'rcon-dropped',
        tone: 'error',
        title: t('rcon.droppedTitle'),
        description: t('rcon.droppedDesc'),
      })
    } else if (rconFailureReason === 'auth_failed') {
      rconAlerts.push({
        id: 'rcon-auth-failed',
        tone: 'error',
        title: t('rcon.authFailedTitle'),
        description: t('rcon.authFailedDesc'),
        action: { label: t('actions.editServer'), to: '/servers' },
      })
    } else {
      rconAlerts.push({
        id: 'rcon-unreachable',
        tone: 'error',
        title: t('rcon.hostUnreachableTitle'),
        description: t('rcon.hostUnreachableDesc'),
        action: { label: t('actions.editServer'), to: '/servers' },
      })
    }
  }

  const logAlerts: PageAlert[] = serverLogError
    ? [{ id: 'log-stream', tone: 'error', title: serverLogError, action: { label: t('serverLog.retry'), onClick: () => fetchServerLog(true) } }]
    : []

  // Where an unreadable log is fixed: the server's paths live on the
  // Servers page; a remote server has only RCON.
  const serverLogUnavailableAction: EmptyStateAction | undefined = !canViewServerLog
    ? undefined
    : activeServer?.isRemote
      ? { label: t('actions.openRcon'), onClick: () => setConsoleTab('rcon') }
      : { label: t('actions.editServer'), to: '/servers' }

  const hiddenLineCount = Math.max(0, serverLogLines.length - filteredLogLines.length)

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
        status={rconStatus}
        meta={!consoleTargetLoading && activeServer ? <span>{t('pageHeader.target', { server: activeServer.name })}</span> : undefined}
        actions={!consoleTargetLoading && hasActiveServer ? (
          <DisabledReason reason={!canConfigureServer ? t('rcon.recheckNoPermission') : null}>
            <Button
              variant="outline"
              size="sm"
              onClick={testRconConnection}
              disabled={testingConnection || !hasRconConfig || !canConfigureServer}
              aria-label={t('rcon.recheckAria')}
            >
              <RefreshCw className={cn(testingConnection && 'animate-spin')} aria-hidden="true" />
              <span className="hidden sm:inline">{t('rcon.recheck')}</span>
            </Button>
          </DisabledReason>
        ) : undefined}
      />

      {consoleTargetLoading ? (
        <div role="status" aria-busy="true" className="space-y-3">
          <span className="sr-only">{t('checkingServerTarget')}</span>
          <Skeleton className="h-9 w-full sm:w-72" />
          <Skeleton className="h-[calc(100vh-360px)] min-h-[300px] w-full rounded-xl" />
        </div>
      ) : !hasActiveServer ? (
        <div className="rounded-xl border border-border/60 bg-card">
          <EmptyState
            type="empty"
            title={t('emptyState.title')}
            description={t('emptyState.description')}
            action={{ label: t('emptyState.action'), to: '/servers' }}
          />
        </div>
      ) : (
        <Tabs value={consoleTab} onValueChange={(value) => setConsoleTab(value as ConsoleTab)} className="w-full space-y-4">
          <TabsList className="w-full sm:w-auto">
            <TabsTrigger value="log" className="flex-1 gap-2 sm:flex-none">
              <FileText className="h-4 w-4" aria-hidden="true" />
              {t('tabs.serverLog')}
            </TabsTrigger>
            <TabsTrigger value="rcon" className="flex-1 gap-2 sm:flex-none">
              <TerminalIcon className="h-4 w-4" aria-hidden="true" />
              {t('tabs.rconConsole')}
            </TabsTrigger>
          </TabsList>

          {/* Server log */}
          <TabsContent value="log" className="mt-0 space-y-3">
            {serverLogUnavailable ? (
              <div className="flex h-[calc(100vh-360px)] min-h-[300px] items-center justify-center rounded-xl border border-border/60 bg-card p-4">
                <EmptyState
                  type="noFile"
                  title={serverLogUnavailable.title}
                  description={serverLogUnavailable.description}
                  action={serverLogUnavailableAction}
                  compact
                />
              </div>
            ) : (
              <>
                <PageAlerts alerts={logAlerts} />
                <section aria-label={t('tabs.serverLog')} className="overflow-hidden rounded-xl border border-border/60 bg-card">
                  <div className="flex flex-col gap-2 border-b border-border/60 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="label-micro shrink-0">{t('serverLog.pathLabel')}</span>
                      <p className="min-w-0 truncate font-mono text-xs text-foreground" title={serverLogPath || undefined}>
                        {serverLogPath ? serverLogPath : <span className="font-sans text-muted-foreground">{t('serverLog.loadingPath')}</span>}
                      </p>
                      {serverLogLoading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />}
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setServerLogPaused(!serverLogPaused)}
                        aria-label={serverLogPaused ? t('serverLog.resumeAria') : t('serverLog.pauseAria')}
                      >
                        {serverLogPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                        {serverLogPaused ? t('serverLog.resume') : t('serverLog.pause')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setServerLogFiltered(!serverLogFiltered)}
                        aria-label={serverLogFiltered ? t('serverLog.showAllAria') : t('serverLog.filterAria')}
                        title={serverLogFiltered
                          ? t('serverLog.hidingTooltip', { count: hiddenLineCount })
                          : t('serverLog.filterOffTooltip')}
                        className={cn(serverLogFiltered && 'text-primary')}
                      >
                        <Filter aria-hidden="true" />
                        {serverLogFiltered
                          ? (hiddenLineCount > 0 ? t('serverLog.filterWithCount', { count: hiddenLineCount }) : t('serverLog.filter'))
                          : t('serverLog.all')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setServerLogAutoScroll(!serverLogAutoScroll)}
                        aria-label={serverLogAutoScroll ? t('serverLog.disableAutoScrollAria') : t('serverLog.enableAutoScrollAria')}
                        title={serverLogAutoScroll ? t('serverLog.autoScrollOnTooltip') : t('serverLog.autoScrollOffTooltip')}
                        className={cn(serverLogAutoScroll ? 'text-primary' : 'text-muted-foreground')}
                      >
                        <ArrowDownToLine aria-hidden="true" />
                        {serverLogAutoScroll ? t('serverLog.followOn') : t('serverLog.followOff')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="iconDense"
                        onClick={() => fetchServerLog(true)}
                        aria-label={t('serverLog.refreshAria')}
                        title={t('serverLog.refreshAria')}
                      >
                        <RefreshCw aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={downloadServerLog}
                        disabled={!serverLogExists || serverLogDownloading || serverChangedSinceLoad}
                        aria-label={t('serverLog.downloadAria')}
                      >
                        {serverLogDownloading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
                        {t('serverLog.download')}
                      </Button>
                      <DisabledReason reason={!canConfigureServer ? t('serverLog.clearNoPermission') : null}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="destructive" size="sm" onClick={clearServerLog} disabled={serverChangedSinceLoad || !canConfigureServer}>
                              <Trash2 aria-hidden="true" />
                              {t('serverLog.clear')}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{t('serverLog.clearTooltip')}</TooltipContent>
                        </Tooltip>
                      </DisabledReason>
                    </div>
                  </div>

                  {!serverLogExists ? (
                    <div className="flex h-[calc(100vh-400px)] min-h-[280px] items-center justify-center bg-background/60 p-4">
                      {serverLogRefusal ? (
                        <EmptyState
                          type="serverOffline"
                          title={t('serverLog.unavailableTitle')}
                          description={getResultErrorMessage(serverLogRefusal, t('serverLog.notFoundDesc'))}
                          action={{ label: t('actions.editServer'), to: '/servers' }}
                          compact
                        />
                      ) : (
                        <EmptyState type="serverOffline" title={t('serverLog.notFoundTitle')} description={t('serverLog.notFoundDesc')} compact />
                      )}
                    </div>
                  ) : (
                    <>
                      <div
                        ref={serverLogRef}
                        role="log"
                        aria-live="polite"
                        aria-label={t('serverLog.serverOutputAria')}
                        className="h-[calc(100vh-400px)] min-h-[280px] overflow-auto bg-background/60 p-3 font-mono text-xs terminal-output"
                      >
                        {filteredLogLines.length === 0 ? (
                          <div className="p-2 font-sans text-xs text-muted-foreground">
                            {serverLogFiltered && serverLogLines.length > 0 ? (
                              <span>
                                {t('serverLog.linesHidden', { count: serverLogLines.length })}
                                <button
                                  type="button"
                                  className="rounded-sm text-primary underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                                  onClick={() => setServerLogFiltered(false)}
                                >
                                  {t('serverLog.showAll')}
                                </button>
                              </span>
                            ) : serverLogError ? (
                              // Distinct from the genuinely-quiet case below: the error
                              // alert above already explains the stream is down, so this
                              // must not also claim anything about the server itself --
                              // an empty body here is caused by OUR broken connection,
                              // not by the server having nothing to say.
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
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
                        <span className="tabular-nums">
                          {serverLogFiltered
                            ? <>{t('serverLog.shown')} <span className="text-foreground">{filteredLogLines.length}</span> · {t('serverLog.hidden')} {hiddenLineCount}</>
                            : <>{t('serverLog.loaded')} <span className="text-foreground">{serverLogLines.length}</span></>}
                        </span>
                        {serverLogPaused
                          ? <StatusPill size="sm" tone="idle" label={t('serverLog.paused')} />
                          : <StatusPill size="sm" tone="ok" pulse label={t('serverLog.live')} detail={t('serverLog.pollInterval')} />}
                      </div>
                    </>
                  )}
                </section>
              </>
            )}
          </TabsContent>

          {/* RCON console */}
          <TabsContent value="rcon" className="mt-0 space-y-4">
            <PageAlerts alerts={rconAlerts} />

            <section aria-labelledby="console-rcon-output-heading" className="overflow-hidden rounded-xl border border-border/60 bg-card">
              <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
                <div className="flex min-w-0 items-baseline gap-2">
                  <h2 id="console-rcon-output-heading" className="text-sm font-semibold text-foreground">{t('rcon.outputLabel')}</h2>
                  <span className="text-xs tabular-nums text-muted-foreground">{t('rcon.entries', { count: liveLog.length })}</span>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="sm" onClick={clearLog} disabled={liveLog.length === 0}>
                      <Trash2 aria-hidden="true" />
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
                className="h-[18rem] min-h-[220px] overflow-auto bg-background/60 p-3 terminal-output sm:h-[22rem] lg:h-[26rem]"
              >
                {liveLog.length === 0 ? (
                  // The terminal sets the mono face; the empty state is a message, not output.
                  <div className="font-sans">
                    <EmptyState compact type="noMessages" title={t('rcon.noCommandsTitle')} description={t('rcon.noCommandsDesc')} />
                  </div>
                ) : (
                  liveLog.map((entry, idx) => (
                    <div key={(entry as RconResponse & { _id?: number })._id ?? `${entry.timestamp}-${idx}`} className="mb-3 font-mono text-sm">
                      <div className="flex items-start gap-2">
                        <span className="shrink-0 text-primary" aria-hidden="true">$</span>
                        <span className="min-w-0 grow break-all text-foreground">{entry.command}</span>
                        <span className="ms-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                          {formatTime(entry.timestamp, { seconds: true })}
                        </span>
                      </div>
                      <div className={cn('ms-4 mt-0.5 break-words border-s ps-2 text-xs', entry.success ? 'border-primary/30 text-foreground/90' : 'border-destructive/50 text-destructive')}>
                        {entry.response.split('\n').map((line, i) => (
                          <div key={`line-${i}`} className="whitespace-pre-wrap break-words">{line || ' '}</div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="space-y-3 border-t border-border/60 p-3">
                {/* Quick commands fill the box below; they don't run until Run. */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{t('rcon.quickLabel')}</span>
                  {/* These buttons read like "Save" runs Save immediately -- they
                      actually just fill the command box below, same as clicking a
                      history entry, and still require Run/Enter to send. Without
                      this, a first-time operator has no way to tell that apart
                      from an execute-on-click button. */}
                  <HelpTip label={t('rcon.quickLabel')} className="me-1">{t('rcon.quickTip')}</HelpTip>
                  {quickCommands.map((qc) => (
                    <DisabledReason key={qc.command} reason={!canExecuteRcon ? t('rcon.noPermission') : null}>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setCommand(qc.command)
                          inputRef.current?.focus()
                        }}
                        disabled={!hasRconConfig || rconConnected === false || !canExecuteRcon}
                      >
                        {qc.label}
                      </Button>
                    </DisabledReason>
                  ))}
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">{t('rcon.commandLabel')}</span>
                    <HelpTip label={t('rcon.commandLabel')}>{t('rcon.commandTip')}</HelpTip>
                  </div>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <span className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 select-none font-mono text-xs text-primary" aria-hidden="true">
                        {t('rcon.promptPrefix')}
                      </span>
                      <Input
                        ref={inputRef}
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={t('rcon.placeholder')}
                        className="ps-16 font-mono"
                        disabled={loading || !hasRconConfig || rconConnected === false || !canExecuteRcon}
                        maxLength={2000}
                        aria-label={t('rcon.inputAria')}
                      />
                    </div>
                    <DisabledReason reason={
                      !canExecuteRcon ? t('rcon.noPermission')
                        : serverChangedSinceLoad ? t('toasts.serverChangedSinceLoadDesc')
                          : rconConnected === false ? t('rcon.disconnectedUseRecheck')
                            : null
                    }>
                      <Button
                        onClick={executeCommand}
                        disabled={loading || !command.trim() || !hasRconConfig || rconConnected === false || !canExecuteRcon || serverChangedSinceLoad}
                        aria-label={t('rcon.executeAria')}
                      >
                        {loading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
                        {t('rcon.run')}
                      </Button>
                    </DisabledReason>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('rcon.keyboardHint')}</p>
                </div>
              </div>
            </section>

            <SectionCard
              collapsible
              defaultOpen={false}
              density="compact"
              icon={Megaphone}
              title={t('broadcast.toggleLabel')}
              description={t('broadcast.toggleSubtitle')}
            >
              <div className="flex flex-wrap gap-1.5">
                {quickBroadcasts.map((qb) => (
                  <Button
                    key={qb.label}
                    variant="outline"
                    size="sm"
                    onClick={() => setAnnouncement(qb.message)}
                    disabled={!hasRconConfig || rconConnected === false}
                  >
                    {qb.label}
                  </Button>
                ))}
              </div>

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

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  <Trans i18nKey="broadcast.sendsVia" t={t} components={{ code: <code className="font-mono text-foreground" /> }} />
                </p>
                <DisabledReason reason={!canExecuteRcon ? t('rcon.noPermission') : serverChangedSinceLoad ? t('toasts.serverChangedSinceLoadDesc') : null}>
                  <Button
                    onClick={sendAnnouncement}
                    disabled={sendingAnnouncement || !announcement.trim() || !hasRconConfig || rconConnected === false || !canExecuteRcon || serverChangedSinceLoad}
                  >
                    {sendingAnnouncement ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
                    {t('broadcast.send')}
                  </Button>
                </DisabledReason>
              </div>
            </SectionCard>

            <SectionCard
              collapsible
              defaultOpen={false}
              density="compact"
              icon={History}
              title={t('history.toggleLabel')}
              status={history.length > 0 ? (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {t('history.entries', { count: history.length })}
                  {history.length >= COMMAND_HISTORY_FETCH_LIMIT && <> {t('history.truncatedHint')}</>}
                </span>
              ) : undefined}
            >
              <div className="relative">
                <Filter className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  placeholder={t('history.searchPlaceholder')}
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  className="ps-8 text-sm sm:h-8"
                  aria-label={t('history.searchAria')}
                />
              </div>
              <ScrollArea className="h-[16rem] min-h-[200px] rounded-lg border border-border/60 bg-background/40 sm:h-[20rem]">
                {historyLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
                  </div>
                ) : historyLoadError ? (
                  <EmptyState
                    compact
                    type="noData"
                    title={t('toasts.historyUnavailableTitle')}
                    description={historyLoadError}
                    action={{ label: t('serverLog.retry'), onClick: fetchHistory }}
                  />
                ) : history.length === 0 ? (
                  <EmptyState compact type="noData" title={t('history.emptyTitle')} description={t('history.emptyDesc')} />
                ) : filteredHistory.length === 0 ? (
                  // history has entries, but none match the current search --
                  // distinct from the genuinely-empty case above, which would
                  // otherwise be indistinguishable from a blank scroll area
                  // with nothing explaining why nothing's showing.
                  <EmptyState
                    compact
                    type="noResults"
                    title={t('history.noMatchesTitle')}
                    description={t('history.noMatchesDesc', { query: historySearch })}
                    action={{ label: t('history.clearSearch'), onClick: () => setHistorySearch('') }}
                  />
                ) : (
                  <div className="space-y-1 p-2">
                    {filteredHistory.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        className="w-full rounded-md p-2.5 text-start transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                        onClick={() => {
                          setCommand(entry.command)
                          inputRef.current?.focus()
                        }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <code className="min-w-0 flex-1 truncate font-mono text-sm text-primary">{entry.command}</code>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {formatDateTime(entry.executed_at, { seconds: true })}
                          </span>
                        </div>
                        {entry.response && (
                          <p className={cn('mt-1 truncate font-mono text-xs', entry.success ? 'text-muted-foreground' : 'text-destructive')}>
                            {entry.response}
                          </p>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </SectionCard>
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}
