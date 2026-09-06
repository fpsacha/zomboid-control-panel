import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import {
  Users,
  UserX,
  Ban,
  Shield,
  UserPlus,
  UserMinus,
  Car,
  Package,
  Ghost,
  Eye,
  Layers,
  RefreshCw,
  AlertTriangle,
  Loader2,
  Download,
  Upload,
  Copy,
  Check,
  MapPin,
  Mic,
  MicOff,
  Search,
  TrendingUp,
  Clock,
  ChevronRight,
  MoreHorizontal,
  StickyNote,
  Tag,
  X,
  Plus,
  Save,
  Trash2,
  Heart,
  Skull,
  Moon,
  Thermometer,
} from 'lucide-react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
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
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useToast } from '@/components/ui/use-toast'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { EmptyState } from '@/components/EmptyState'
import { HelpTip } from '@/components/HelpTip'
import { SpawnBrowser } from '@/components/SpawnBrowser'
import { NumberInput } from '@/components/NumberInput'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'
import { getBridgeVerifiedState } from '@/lib/bridgeVerify'
import { PageHeader } from '@/components/PageHeader'
import { DisabledReason } from '@/components/DisabledReason'
import { useAuth } from '@/contexts/AuthContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useSocket } from '@/contexts/SocketContext'
import { cn, copyText } from '@/lib/utils'

interface PerkChoice {
  id: string
  label: string
  category: string
}

interface Player {
  name: string
  online: boolean
}

interface WhitelistAccount {
  id: number
  username: string
  lastConnection: string | null
  role: string
  authType: number
  steamId: string | null
  ownerId: string | null
  displayName: string | null
}

// Mirrors server/routes/players.js's own SteamID64 check (/^\d{17}$/ on both
// /banid and /unbanid) so a manually-typed SteamID can't reach a submit
// button in a shape the server will reject.
export function sanitizeSteamId(value: string): string {
  return value.replace(/\D/g, '').slice(0, 17);
}

// Whether the whitelist has loaded successfully and confirms the given
// player is NOT on it -- used to gate "Remove from whitelist". Fails open
// (returns false, leaving the control enabled) while the fetch is still in
// flight or failed, since a wrong disable here costs a real capability
// (can't remove someone who genuinely is whitelisted, no explanation)
// while a wrong enable costs one failed click and an error message.
export function isPlayerConfirmedNotWhitelisted(
  selectedPlayer: string | null,
  whitelistAccounts: Array<{ username: string }>,
  whitelistLoading: boolean,
  whitelistError: string | null,
): boolean {
  return (
    !whitelistLoading &&
    !whitelistError &&
    !!selectedPlayer &&
    !whitelistAccounts.some(account => account.username === selectedPlayer)
  );
}

// The activity log table has no pagination -- when a fetch returns exactly
// this many rows, older entries may exist and be silently excluded (the
// server retains up to 1000, see server/database/init.js). Shown as a hint
// rather than a hard truth ("logs.length === LIMIT" could also mean the
// real total happens to equal the limit) because there's no cheap way to
// distinguish the two without a separate total-count query.
const ACTIVITY_LOG_FETCH_LIMIT = 200

function getAccessLevelLabels(t: TFunction): Record<string, string> {
  return {
    admin: t('accessLevels.admin'),
    moderator: t('accessLevels.moderator'),
    gm: t('accessLevels.gm'),
    observer: t('accessLevels.observer'),
    // 'priority' has no translated entry, deliberately -- it falls through
    // to the raw-token capitalize fallback below ("Priority"). A wire token
    // and its display label have already diverged unpredictably once on
    // this floor (bug-hunt-2026-08-27, 16 of 35 PZ perk ids differed from
    // their label by no rule); the real in-game name is "PriorityUser", not
    // "Priority", so this is a deliberate "close enough and honest" choice,
    // not an oversight -- adding a real translated label would mean
    // touching every locale file, out of this fix's scope.
    user: t('accessLevels.user'),
    none: t('accessLevels.none'),
  }
}

// Common teleport locations in Project Zomboid
const TELEPORT_PRESETS = [
  { name: 'Muldraugh', x: '10500', y: '9700', z: '0' },
  { name: 'West Point', x: '11800', y: '6900', z: '0' },
  { name: 'Riverside', x: '6500', y: '5300', z: '0' },
  { name: 'Rosewood', x: '8000', y: '11300', z: '0' },
  { name: 'Louisville', x: '12500', y: '3500', z: '0' },
  { name: 'March Ridge', x: '9900', y: '12800', z: '0' },
  { name: 'Ekron', x: '4500', y: '9000', z: '0' },
  { name: 'Military Base', x: '10300', y: '12900', z: '0' },
]

function SummaryCard({
  icon,
  label,
  value,
  tone = 'default',
  caption,
  help,
}: {
  icon: React.ReactNode
  label: string
  value: string | number
  tone?: 'default' | 'success' | 'warning' | 'danger'
  caption?: string
  help?: React.ReactNode
}) {
  const toneMap = {
    default: {
      iconWrap: 'border-border/60 bg-muted/40 text-muted-foreground',
      accent: 'bg-border/60',
      value: 'text-foreground',
    },
    success: {
      iconWrap: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
      accent: 'bg-emerald-500/60',
      value: 'text-foreground',
    },
    warning: {
      iconWrap: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
      accent: 'bg-amber-500/60',
      value: 'text-foreground',
    },
    danger: {
      iconWrap: 'border-destructive/30 bg-destructive/10 text-destructive',
      accent: 'bg-destructive/60',
      value: 'text-foreground',
    },
  }
  const t = toneMap[tone]
  return (
    <div className="group relative flex flex-1 items-center gap-3 overflow-hidden rounded-md border border-border/55 bg-card/70 px-4 py-3 shadow-sm">
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-[2px] ${t.accent}`} />
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border ${t.iconWrap}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          <p className={`text-xl font-semibold tabular-nums leading-none tracking-tight ${t.value}`}>{value}</p>
          {caption ? (
            <span className="text-xs font-medium text-muted-foreground/70">{caption}</span>
          ) : null}
        </div>
        <div className="mt-1 flex items-center gap-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/75">{label}</p>
          {help}
        </div>
      </div>
    </div>
  )
}

function ActionTile({
  icon,
  label,
  description,
  disabled,
  emphasis = 'default',
  compact = false,
}: {
  icon: React.ReactNode
  label: string
  description?: string
  disabled?: boolean
  emphasis?: 'default' | 'primary' | 'warning' | 'danger'
  compact?: boolean
}) {
  const emphasisMap = {
    default: {
      base: 'border-border/60 bg-card/50 hover:bg-accent/30 hover:border-border',
      iconWrap: 'border-border/60 bg-muted/40 text-muted-foreground group-hover:text-foreground',
      label: 'text-foreground/90',
    },
    primary: {
      base: 'border-primary/30 bg-primary/[0.04] hover:bg-primary/10 hover:border-primary/50',
      iconWrap: 'border-primary/30 bg-primary/10 text-primary',
      label: 'text-foreground',
    },
    warning: {
      base: 'border-amber-500/30 bg-amber-500/[0.04] hover:bg-amber-500/10 hover:border-amber-500/50',
      iconWrap: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
      label: 'text-foreground',
    },
    danger: {
      base: 'border-destructive/35 bg-destructive/[0.04] hover:bg-destructive/10 hover:border-destructive/55',
      iconWrap: 'border-destructive/30 bg-destructive/10 text-destructive',
      label: 'text-destructive',
    },
  }
  const e = emphasisMap[emphasis]
  return (
    <div
      className={cn(
        'group flex w-full items-center gap-3 rounded-md border text-start transition-colors',
        compact ? 'px-2.5 py-2' : 'px-3 py-2.5',
        e.base,
        disabled ? 'opacity-50' : '',
      )}
    >
      <div className={cn('flex shrink-0 items-center justify-center rounded-sm border', compact ? 'h-7 w-7' : 'h-8 w-8', e.iconWrap)}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className={cn('font-medium leading-tight', compact ? 'text-[12px]' : 'text-sm', e.label)}>{label}</p>
        {/* line-clamp-2, not truncate: truncate's single-line ellipsis cut
            real meaning out of short phrases ("Permanent · two-step" ->
            "Permanent · two-s...") specifically in the desktop 3/4-column
            grid, where these cards are narrower than they are on mobile's
            single column -- the same content read complete one viewport
            over (2026-08-31 visual sweep). Two lines is enough headroom for
            every description these tiles actually carry. */}
        {description && !compact ? (
          <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </div>
  )
}

// A 0-1 severity bar for a PZ stat (health, hunger/thirst/fatigue).
// goodWhenLow=true means higher is worse (hunger/thirst/fatigue -- PZ's own
// scale, confirmed against vanilla Lua thresholds like FATIGUE <= 0.3/0.85
// gating sleep); goodWhenLow=false means higher is better (health).
function VitalBar({ label, value, goodWhenLow }: { label: string; value: number; goodWhenLow: boolean }) {
  const pct = Math.max(0, Math.min(100, value * 100))
  const severity = goodWhenLow ? value : 1 - value
  const color =
    severity < 0.5 ? 'hsl(var(--success))'
    : severity < 0.75 ? 'hsl(var(--warning))'
    : 'hsl(var(--destructive))'
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">{label}</span>
      <div className="flex flex-1 items-center gap-1.5">
        <div className="h-1.5 flex-1 overflow-hidden rounded-sm bg-muted/60 ring-1 ring-black/20">
          <div className="h-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
        </div>
        <span className="w-8 shrink-0 text-end font-mono text-xs tabular-nums text-foreground/85">{Math.round(pct)}%</span>
      </div>
    </div>
  )
}

export default function Players() {
  const { t, i18n } = useTranslation('players')
  const accessLevelLabels = useMemo(() => getAccessLevelLabels(t), [t])
  // Two server gates, not three -- kick/ban/whitelist/access-level require
  // players.moderate; teleport/spawn/character import-export AND
  // godmode/invisible/noclip/heal all require players.gm_tools.
  // godmode/invisible/noclip/heal route through the generic PanelBridge
  // passthrough (POST /panel-bridge/command), but as of an operator ruling
  // (bug-hunt-2026-08-27, reverses server commit c3083d5 from earlier the
  // same day) players.gm_tools ALONE gates them there too -- bridge.command
  // is not required. c3083d5 had briefly made it "gm_tools AND
  // bridge.command"; the operator ruled bridge.command was only ever an
  // accidental side effect of these four routing through the passthrough,
  // not a deliberate second gate, and requiring it would deny Technician
  // (who holds gm_tools but not bridge.command by default) the GM tools
  // it's meant to have. See server/routes/panelBridge.js's
  // BRIDGE_ACTION_CAPABILITY / GM_TOOLS_ONLY_ACTIONS.
  const { can } = useAuth()
  const [searchParams] = useSearchParams()
  const requestedPlayer = searchParams.get('player')?.trim() || ''
  const canModerate = can('players.moderate')
  const canGmTools = can('players.gm_tools')
  const [players, setPlayers] = useState<Player[]>([])
  const [perks, setPerks] = useState<PerkChoice[]>([])
  const [selectedPlayer, setSelectedPlayer] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const { toast } = useToast()
  const confirm = useConfirm()
  const socket = useSocket()

  // Stats tracking
  const [peakPlayers, setPeakPlayers] = useState(0)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  // Dialog states
  const [kickDialogOpen, setKickDialogOpen] = useState(false)
  const [banDialogOpen, setBanDialogOpen] = useState(false)
  const [banConfirmOpen, setBanConfirmOpen] = useState(false)
  const [unbanDialogOpen, setUnbanDialogOpen] = useState(false)
  const [teleportDialogOpen, setTeleportDialogOpen] = useState(false)
  const [steamIdBanDialogOpen, setSteamIdBanDialogOpen] = useState(false)
  const [voiceBanDialogOpen, setVoiceBanDialogOpen] = useState(false)
  const [addUserDialogOpen, setAddUserDialogOpen] = useState(false)
  const [itemBrowserOpen, setItemBrowserOpen] = useState(false)
  const [vehicleBrowserOpen, setVehicleBrowserOpen] = useState(false)

  // Form states
  const [kickReason, setKickReason] = useState('')
  const [banReason, setBanReason] = useState('')
  const [banIp, setBanIp] = useState(false)
  const [accessLevel, setAccessLevel] = useState('')
  const [selectedPerk, setSelectedPerk] = useState('')
  const [xpAmount, setXpAmount] = useState(100)
  const [unbanUsername, setUnbanUsername] = useState('')
  const [unbanSteamIdDialogOpen, setUnbanSteamIdDialogOpen] = useState(false)
  const [unbanSteamId, setUnbanSteamId] = useState('')
  const [bannedSteamIds, setBannedSteamIds] = useState<Array<{ steamId: string; banned_at: string; reason?: string }>>([])
  const [loadingBans, setLoadingBans] = useState(false)

  // Add User states
  const [addUserUsername, setAddUserUsername] = useState('')
  const [addUserPassword, setAddUserPassword] = useState('')

  // Teleport states
  const [teleportX, setTeleportX] = useState('')
  const [teleportY, setTeleportY] = useState('')
  const [teleportZ, setTeleportZ] = useState('0')
  const [teleportTarget, setTeleportTarget] = useState('')

  // SteamID Ban states
  const [banSteamId, setBanSteamId] = useState('')
  const [steamBanReason, setSteamBanReason] = useState('')

  // Voice Ban states
  const [voiceBanUsername, setVoiceBanUsername] = useState('')
  const [voiceBanEnabled, setVoiceBanEnabled] = useState(true)

  // Power states (local tracking since server doesn't report these)
  const [playerPowers, setPlayerPowers] = useState<Record<string, { godMode: boolean; invisible: boolean; noclip: boolean }>>({})

  // Player search filter
  const [playerSearchFilter, setPlayerSearchFilter] = useState('')

  // Character Export/Import states
  const [characterData, setCharacterData] = useState<string>('')
  const [importCharacterData, setImportCharacterData] = useState('')
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [importExportOpen, setImportExportOpen] = useState(false)
  const [importConfirmOpen, setImportConfirmOpen] = useState(false)
  const [pendingImportData, setPendingImportData] = useState<Record<string, unknown> | null>(null)

  // Bridge status for character export/import
  const [bridgeConnected, setBridgeConnected] = useState(false)

  // Auto-export on login
  const [autoExportEnabled, setAutoExportEnabled] = useState(false)
  const [savedExports, setSavedExports] = useState<Array<{ username: string; filename: string; size: number; timestamp: string }>>([])

  // Ref for copy timeout cleanup
  const copiedTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Cleanup copy timeout on unmount
  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current) {
        clearTimeout(copiedTimeoutRef.current)
      }
    }
  }, [])

  // Activity Log states
  interface ActivityLog {
    id: number
    player_name: string
    action: string
    details: string | null
    logged_at: string
  }
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [logPlayerFilter, setLogPlayerFilter] = useState('')

  // Player Notes & Tags states
  interface PlayerNote {
    playerName: string
    note: string
    tags: string[]
    updated_at: string
  }
  interface PlayerStat {
    playerName: string
    player_name?: string
    total_playtime_seconds: number
    session_count: number
    first_seen: string
    last_seen: string
  }
  const [playerNotes, setPlayerNotes] = useState<Record<string, PlayerNote>>({})
  const [playerStats, setPlayerStats] = useState<Record<string, PlayerStat>>({})
  const [currentNote, setCurrentNote] = useState('')
  const [currentTags, setCurrentTags] = useState<string[]>([])
  const [newTag, setNewTag] = useState('')
  const [notesLoading, setNotesLoading] = useState(false)
  const [savingNote, setSavingNote] = useState(false)
  const [deleteNoteConfirmOpen, setDeleteNoteConfirmOpen] = useState(false)
  const [playersLoadError, setPlayersLoadError] = useState<string | null>(null)
  const [toolsLoadError, setToolsLoadError] = useState<string | null>(null)
  const [notesError, setNotesError] = useState<string | null>(null)
  const [logsError, setLogsError] = useState<string | null>(null)

  // Live vitals (Vitals tab) -- PanelBridge.getPlayerDetails for the
  // selected online player: position, health, and the eight
  // stats:get(CharacterStat.X) fields.
  interface PlayerVitals {
    x?: number
    y?: number
    z?: number
    accessLevel?: string
    isAsleep?: boolean
    isSneaking?: boolean
    isRunning?: boolean
    stats?: {
      hunger?: number
      thirst?: number
      fatigue?: number
      stress?: number
      boredom?: number
      unhappiness?: number
      pain?: number
      endurance?: number
    }
    health?: {
      overallBodyHealth?: number
      isInfected?: boolean
      isBleeding?: boolean
      temperature?: number
      wetness?: number
    }
  }
  const [playerVitals, setPlayerVitals] = useState<PlayerVitals | null>(null)
  const [playerVitalsLoading, setPlayerVitalsLoading] = useState(false)
  const [playerVitalsError, setPlayerVitalsError] = useState<string | null>(null)

  // At-a-glance roster health -- PanelBridge.getAllPlayerDetails (the
  // PLURAL bulk endpoint, distinct from getPlayerDetails above, which is
  // one player at a time and only fetched for whoever is currently
  // selected). Nothing else on this page or elsewhere reads it: the roster
  // list itself comes from RCON's `players` command, which reports only
  // {name, online} -- no health, hunger, or infection status at all, so
  // this is genuinely new data, not a second view of something already
  // shown. Keyed by username, keyed off the SAME 15s interval fetchPlayers
  // already uses but fired independently (own .then/.catch, not part of
  // any awaited Promise.all) so a slow or failing bridge call can never
  // delay the roster list itself from rendering.
  const [rosterVitals, setRosterVitals] = useState<Record<string, { health?: number; isInfected?: boolean }>>({})

  const getErrorMessage = (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback

  // Filter players by search term (memoized to avoid recalculation on every render)
  const filteredPlayers = useMemo(() =>
    players.filter(player =>
      player.name.toLowerCase().includes(playerSearchFilter.toLowerCase())
    ),
    [players, playerSearchFilter]
  )

  // "Roster" view: every player we've ever seen on this server, minus the
  // ones currently online. Sorted by most recently seen first so familiar
  // names sit at the top. Drives the Roster tab and lets admins moderate
  // (note, ban-by-name) players who are not currently connected.
  const [rosterTab, setRosterTab] = useState<'online' | 'roster' | 'banned' | 'whitelist'>('online')
  const [whitelistAccounts, setWhitelistAccounts] = useState<WhitelistAccount[]>([])
  const [allowedSteamIds, setAllowedSteamIds] = useState<string[]>([])
  const [allowedSteamIdInput, setAllowedSteamIdInput] = useState('')
  const [whitelistAvailable, setWhitelistAvailable] = useState(true)
  const [whitelistError, setWhitelistError] = useState<string | null>(null)
  const [whitelistLoading, setWhitelistLoading] = useState(false)
  // Sourced from GET /players/access-levels, which reads the server's own
  // live role table (access-levels-should-come-from-the-server-not-a-
  // hardcoded-array) -- no client-side fallback copy. The server already
  // falls back to its own static list when the db is unavailable or the
  // server is remote, so an empty array here only ever means "not loaded
  // yet", not "the feature is unavailable".
  const [accessLevelOptions, setAccessLevelOptions] = useState<string[]>([])
  const offlineRoster = useMemo(() => {
    const onlineLower = new Set(players.map(p => p.name.toLowerCase()))
    const stats = Object.values(playerStats) as PlayerStat[]
    const filtered = stats.filter(s => {
      const name = s.player_name || s.playerName
      return name && !onlineLower.has(name.toLowerCase())
    })
    const search = playerSearchFilter.trim().toLowerCase()
    const matched = search
      ? filtered.filter(s => (s.player_name || s.playerName || '').toLowerCase().includes(search))
      : filtered
    return matched.sort((a, b) => {
      const ta = a.last_seen ? new Date(a.last_seen).getTime() : 0
      const tb = b.last_seen ? new Date(b.last_seen).getTime() : 0
      return tb - ta
    })
  }, [players, playerStats, playerSearchFilter])

  const filteredBans = useMemo(() => {
    const search = playerSearchFilter.trim().toLowerCase()
    if (!search) return bannedSteamIds
    return bannedSteamIds.filter(b =>
      b.steamId.toLowerCase().includes(search) ||
      (b.reason || '').toLowerCase().includes(search)
    )
  }, [bannedSteamIds, playerSearchFilter])

  const filteredWhitelist = useMemo(() => {
    const search = playerSearchFilter.trim().toLowerCase()
    if (!search) return whitelistAccounts
    return whitelistAccounts.filter(account =>
      [account.username, account.displayName, account.steamId, account.role]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(search)),
    )
  }, [playerSearchFilter, whitelistAccounts])

  // Update peak players
  useEffect(() => {
    if (players.length > peakPlayers) {
      setPeakPlayers(players.length)
    }
  }, [players.length, peakPlayers])

  const fetchPlayers = useCallback(async () => {
    try {
      const data = await playersApi.getPlayers({ retries: 0 })
      if (data.players) {
        setPlayers(data.players)
        setLastRefresh(new Date())
      }
      setPlayersLoadError(null)
    } catch (error) {
      reportClientError('Failed to fetch players.', error)
      setPlayersLoadError(getErrorMessage(error, t('loadErrors.players')))
    }
  }, [t])

  // Gated on players.gm_tools -- the same capability GET /panel-bridge/players
  // (the route getAllPlayerDetails lives behind) actually requires, not the
  // players.view the base roster list itself uses. Silent no-op on failure
  // (bridge down, permission denied): the roster still renders fine without
  // this, it just won't show the health/infection indicator.
  const fetchRosterVitals = useCallback(async () => {
    try {
      const res = await panelBridgeApi.getAllPlayerDetails()
      if (!res.success || !res.data?.players) return
      const next: Record<string, { health?: number; isInfected?: boolean }> = {}
      for (const p of res.data.players) {
        next[p.username] = { health: p.health, isInfected: p.isInfected }
      }
      setRosterVitals(next)
    } catch {
      // Bridge down or unreachable -- leave whatever was last fetched (or
      // nothing) rather than clearing it on a single transient failure.
    }
  }, [])

  const fetchActivityLogs = useCallback(async (playerFilter?: string) => {
    setLogsLoading(true)
    try {
      const data = await playersApi.getActivityLogs(playerFilter, ACTIVITY_LOG_FETCH_LIMIT)
      if (data.logs) {
        setActivityLogs(data.logs)
      }
      setLogsError(null)
    } catch (error) {
      reportClientError('Failed to fetch activity logs.', error)
      setLogsError(getErrorMessage(error, t('loadErrors.activityLogs')))
    } finally {
      setLogsLoading(false)
    }
  }, [t])

  const fetchNotesAndStats = useCallback(async () => {
    setNotesLoading(true)
    try {
      const [notesData, statsData] = await Promise.all([
        playersApi.getNotes(),
        playersApi.getStats()
      ])
      // Convert arrays to lookup objects
      const notesMap: Record<string, PlayerNote> = {}
      if (notesData.notes) {
        notesData.notes.forEach((n: PlayerNote) => { notesMap[n.playerName] = n })
      }
      const statsMap: Record<string, PlayerStat> = {}
      if (statsData.stats) {
        // The server stores stats with snake_case `player_name`. Older code
        // here keyed off `playerName` which silently produced an empty map.
        // Normalize so both shapes resolve to the same lookup key.
        statsData.stats.forEach((s: PlayerStat) => {
          const key = s.player_name || s.playerName
          if (key) {
            statsMap[key] = { ...s, playerName: key, player_name: key }
          }
        })
      }
      setPlayerNotes(notesMap)
      setPlayerStats(statsMap)
      setNotesError(null)
    } catch (error) {
      reportClientError('Failed to fetch notes and stats.', error)
      setNotesError(getErrorMessage(error, t('loadErrors.notesAndStats')))
    } finally {
      setNotesLoading(false)
    }
  }, [t])

  const handleSaveNote = async () => {
    if (!selectedPlayer) return
    const normalizedNote = currentNote.trim()
    setSavingNote(true)
    try {
      await playersApi.saveNote(selectedPlayer, normalizedNote, currentTags)
      toast({
        title: t('toasts.noteSavedTitle'),
        description: t('toasts.noteSavedDesc', { player: selectedPlayer }),
        variant: 'success' as const,
      })
      // Update local state
      setPlayerNotes(prev => ({
        ...prev,
        [selectedPlayer]: {
          playerName: selectedPlayer,
          note: normalizedNote,
          tags: currentTags,
          updated_at: new Date().toISOString()
        }
      }))
    } catch (error) {
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('toasts.saveNoteFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setSavingNote(false)
    }
  }

  const handleDeleteNote = async () => {
    if (!selectedPlayer) return
    setSavingNote(true)
    try {
      await playersApi.deleteNote(selectedPlayer)
      toast({
        title: t('toasts.noteDeletedTitle'),
        description: t('toasts.noteDeletedDesc', { player: selectedPlayer }),
        variant: 'success' as const,
      })
      // Update local state
      setPlayerNotes(prev => {
        const updated = { ...prev }
        delete updated[selectedPlayer]
        return updated
      })
      setCurrentNote('')
      setCurrentTags([])
    } catch (error) {
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('toasts.deleteNoteFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setSavingNote(false)
      setDeleteNoteConfirmOpen(false)
    }
  }

  const addTag = () => {
    const tag = newTag.trim().toLowerCase().slice(0, 24)
    if (tag && !currentTags.includes(tag) && currentTags.length < 10) {
      setCurrentTags([...currentTags, tag])
    }
    setNewTag('')
  }

  const removeTag = (tag: string) => {
    setCurrentTags(currentTags.filter(t => t !== tag))
  }

  // Format playtime in human-readable format
  const formatPlaytime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    if (hours > 0) {
      return `${hours}h ${minutes}m`
    }
    return `${minutes}m`
  }

  const perkGroups = useMemo(() => {
    const byCategory = new Map<string, PerkChoice[]>()
    for (const perk of perks) {
      const group = byCategory.get(perk.category)
      if (group) group.push(perk)
      else byCategory.set(perk.category, [perk])
    }
    return [...byCategory.entries()]
  }, [perks])

  const fetchData = useCallback(async () => {
    try {
      const perksData = await playersApi.getPerks()
      // `catalog` carries the in-game skill names; older backends only send ids.
      setPerks(
        perksData.catalog ??
          (perksData.perks || []).map((id: string) => ({ id, label: id, category: t('spawn.skillsCategoryFallback') })),
      )
      setToolsLoadError(null)
    } catch (error) {
      reportClientError('Failed to fetch player data.', error)
      setToolsLoadError(getErrorMessage(error, t('loadErrors.toolsAndReference')))
    } finally {
      setInitialLoading(false)
    }
  }, [t])

  const fetchBannedSteamIds = useCallback(async () => {
    setLoadingBans(true)
    try {
      const res = await playersApi.getSteamIdBans()
      setBannedSteamIds(res.bans || [])
    } catch {
      // Silently fail — list will be empty, manual input still works
    } finally {
      setLoadingBans(false)
    }
  }, [])

  const fetchWhitelist = useCallback(async () => {
    setWhitelistLoading(true)
    try {
      const result = await playersApi.getWhitelist()
      setWhitelistAccounts(result.accounts || [])
      setAllowedSteamIds(result.allowedSteamIds || [])
      setWhitelistAvailable(result.available !== false)
      setWhitelistError(result.available === false ? result.reason || t('loadErrors.whitelistUnavailableFallback') : null)
    } catch (error) {
      reportClientError('Failed to fetch whitelist accounts.', error)
      setWhitelistError(getErrorMessage(error, t('loadErrors.whitelist')))
    } finally {
      setWhitelistLoading(false)
    }
  }, [t])

  const fetchAccessLevels = useCallback(async () => {
    try {
      const result = await playersApi.getAccessLevels()
      setAccessLevelOptions(result.levels || [])
    } catch (error) {
      reportClientError('Failed to fetch access levels.', error)
    }
  }, [])

  useEffect(() => {
    Promise.all([fetchPlayers(), fetchData(), fetchNotesAndStats(), fetchBannedSteamIds(), fetchWhitelist(), fetchAccessLevels()]).catch(err => {
      reportClientError('Failed to load initial player data.', err)
    })
    let isMounted = true
    // Check bridge status for character export/import
    panelBridgeApi.getStatus().then(status => {
      if (isMounted) setBridgeConnected(Boolean(status.modConnected && status.isRunning))
    }).catch(() => { if (isMounted) setBridgeConnected(false) })
    // Load auto-export setting
    configApi.getAppSettings().then(response => {
      if (isMounted && response?.settings) {
        setAutoExportEnabled(response.settings.autoExportOnLogin === true || response.settings.autoExportOnLogin === 'true')
      }
    }).catch(() => {})
    // Load saved exports
    playersApi.getExports().then(response => {
      if (isMounted && response?.exports) setSavedExports(response.exports)
    }).catch(() => {})
    if (canGmTools) fetchRosterVitals()
    const interval = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      fetchPlayers()
      if (canGmTools) fetchRosterVitals()
    }, 15000)
    return () => {
      isMounted = false
      clearInterval(interval)
    }
  }, [fetchPlayers, fetchData, fetchNotesAndStats, fetchBannedSteamIds, fetchWhitelist, fetchAccessLevels, fetchRosterVitals, canGmTools])

  // bug-hunt-2026-09-04/06 (activeServerChanged sweep): this page never
  // re-read the active server after mount, same gap as Console.tsx/
  // Dashboard.tsx before their own fixes. Roster/bans/whitelist/access
  // levels are read-only displays of the PREVIOUS server's data with no
  // unsaved-edit risk, so this reloads unconditionally rather than
  // block-and-warn (ServerConfig/Backups/Mods-shape) -- matches the
  // Console-shape precedent exactly. fetchData() (perks) is deliberately
  // excluded: GET /players/perks returns a static hardcoded catalog, not
  // server-scoped data (server/routes/players.js:713-715), so refetching it
  // would be pure waste, not a correctness fix.
  useEffect(() => {
    if (!socket) return
    const handleActiveServerChanged = () => {
      fetchPlayers()
      fetchNotesAndStats()
      fetchBannedSteamIds()
      fetchWhitelist()
      fetchAccessLevels()
      if (canGmTools) fetchRosterVitals()
    }
    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, fetchPlayers, fetchNotesAndStats, fetchBannedSteamIds, fetchWhitelist, fetchAccessLevels, fetchRosterVitals, canGmTools])

  const requestedPlayerAppliedRef = useRef(false)
  useEffect(() => {
    if (requestedPlayerAppliedRef.current || !requestedPlayer || initialLoading) return
    requestedPlayerAppliedRef.current = true
    const matchingPlayer = players.find((player) => player.name.toLowerCase() === requestedPlayer.toLowerCase())
    setSelectedPlayer(matchingPlayer?.name || requestedPlayer)
  }, [initialLoading, players, requestedPlayer])

  // Load note/tags when selected player changes
  useEffect(() => {
    if (selectedPlayer && playerNotes[selectedPlayer]) {
      setCurrentNote(playerNotes[selectedPlayer].note)
      setCurrentTags(playerNotes[selectedPlayer].tags || [])
    } else {
      setCurrentNote('')
      setCurrentTags([])
    }
  }, [selectedPlayer, playerNotes])

  // `fn` normally resolves to something the caller doesn't inspect (kick,
  // ban, teleport, etc. -- unrelated to bridge verification). A handler that
  // DOES need to override the generic success toast (the godmode/invisible/
  // noclip/teleport bridge actions below, when the mod couldn't confirm the
  // change) resolves to `{ toastOverride }` instead -- runtime-checked here
  // rather than widening `fn`'s type, so every other caller is unaffected.
  const handleAction = async (
    action: string,
    fn: () => Promise<unknown>,
    closeDialog?: () => void,
  ) => {
    setLoading(true)
    try {
      const result = await fn()
      const override =
        result && typeof result === 'object' && 'toastOverride' in result
          ? (result as { toastOverride: { title: string; description?: string; variant?: 'default' | 'destructive' | 'success' } }).toastOverride
          : null
      toast(
        override ?? {
          title: t('toasts.successTitle'),
          description: t('toasts.successDesc', { action }),
          variant: 'success' as const,
        },
      )
      fetchPlayers()
      closeDialog?.()
    } catch (error) {
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('toasts.actionFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleKick = () => {
    if (!selectedPlayer) return
    handleAction(t('actions.kickPlayer'), () => playersApi.kick(selectedPlayer, kickReason), () => {
      setKickDialogOpen(false)
      setKickReason('')
      setSelectedPlayer('')
      searchInputRef.current?.focus()
    })
  }

  // Overwrites the target player's XP/perks/skills/traits/inventory/wornItems --
  // split out of the Apply button so the confirm dialog can hold the parsed
  // data until the operator confirms the target player by name.
  const runCharacterImport = async (data: Record<string, unknown>) => {
    setImporting(true)
    try {
      const { panelBridgeApi } = await import('@/lib/api')
      const response = await panelBridgeApi.importCharacter(selectedPlayer, data)
      const restored = response.data?.restored
      // Submitted a non-empty perks/inventory section but restored
      // nothing from it: the Lua side counts honestly (see
      // PanelBridge.lua importPlayerData) but a caller that only
      // reads the counts from the description, not the title,
      // would still see an unconditionally success-styled toast.
      const submittedPerks = data && typeof data.perks === 'object' && data.perks !== null && Object.keys(data.perks).length > 0
      const submittedItems = Array.isArray((data as { inventory?: unknown[] })?.inventory) && (data as { inventory: unknown[] }).inventory.length > 0
      const noneApplied = (restored?.perks ?? 0) === 0 && (restored?.items ?? 0) === 0 && (submittedPerks || submittedItems)
      toast({
        title: t(noneApplied ? 'toasts.characterImportedTitleNoneApplied' : 'toasts.characterImportedTitle'),
        description: noneApplied
          ? t('toasts.characterImportedDescNoneApplied', { player: selectedPlayer })
          : t('toasts.characterImportedDesc', { perks: restored?.perks ?? 0, items: restored?.items ?? 0, player: selectedPlayer }),
      })
      setImportCharacterData('')
    } catch (error) {
      toast({
        title: t('toasts.importFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.importFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setImporting(false)
      setImportConfirmOpen(false)
      setPendingImportData(null)
    }
  }

  const handleBan = () => {
    if (!selectedPlayer) return
    handleAction(t('actions.banPlayer'), () => playersApi.ban(selectedPlayer, banIp, banReason), () => {
      setBanDialogOpen(false)
      setBanConfirmOpen(false)
      setBanReason('')
      setBanIp(false)
      setSelectedPlayer('')
      searchInputRef.current?.focus()
    })
  }

  const handleUnban = () => {
    if (!unbanUsername) return
    handleAction(t('actions.unbanPlayer'), () => playersApi.unban(unbanUsername), () => {
      setUnbanUsername('')
      setUnbanDialogOpen(false)
    })
  }

  const handleUnbanSteamId = () => {
    if (!unbanSteamId) return
    handleAction(t('actions.unbanSteamId'), () => playersApi.unbanSteamId(unbanSteamId), () => {
      setUnbanSteamId('')
      setUnbanSteamIdDialogOpen(false)
      setBannedSteamIds(prev => prev.filter(b => b.steamId !== unbanSteamId))
    })
  }

  // Builds the { toastOverride } handleAction reads instead of its default
  // success toast, for a bridge-verify-gated action that came back
  // 'unverifiable' or 'old-bridge'. 'confirmed' and null (action isn't
  // verify-gated at all) both return undefined -- no override, plain
  // success toast, exactly as before this fix.
  const bridgeVerifyToastOverride = (actionLabel: string, actionKey: string, data: unknown) => {
    const state = getBridgeVerifiedState(actionKey, data as { verified?: unknown } | null | undefined)
    if (state === 'unverifiable') {
      return {
        toastOverride: {
          title: actionLabel,
          description: t('toasts.bridgeUnverifiedDesc', { action: actionLabel }),
          variant: 'default' as const,
        },
      }
    }
    if (state === 'old-bridge') {
      return {
        toastOverride: {
          title: actionLabel,
          description: t('toasts.bridgeOldBridgeDesc', { action: actionLabel }),
          variant: 'default' as const,
        },
      }
    }
    return undefined
  }

  const handleTeleport = (targetOverride?: string) => {
    const target = (targetOverride ?? teleportTarget ?? '').trim() || selectedPlayer
    if (!target || !teleportX || !teleportY) return
    const label = t('actions.teleportPlayer')
    handleAction(label, async () => {
      const response = await playersApi.teleport(target, {
        x: Number(teleportX),
        y: Number(teleportY),
        z: Number(teleportZ || '0'),
      })
      return bridgeVerifyToastOverride(label, 'teleportPlayer', response?.data)
    }, () => {
      setTeleportDialogOpen(false)
      setTeleportX('')
      setTeleportY('')
      setTeleportZ('0')
      setTeleportTarget('')
    })
  }

  const handleSteamIdBan = () => {
    const steamId = banSteamId.trim()
    const reason = steamBanReason.trim()
    if (!steamId) return
    handleAction(t('actions.banSteamId'), () => playersApi.banSteamId(steamId, reason), () => {
      setSteamIdBanDialogOpen(false)
      setBanSteamId('')
      setSteamBanReason('')
      void fetchBannedSteamIds()
    })
  }

  const handleAddUser = () => {
    if (!addUserUsername.trim()) {
      toast({
        title: t('toasts.errorTitle'),
        description: t('toasts.usernameRequired'),
        variant: 'destructive',
      })
      return
    }
    if (addUserPassword.length > 0 && addUserPassword.length < 4) {
      toast({
        title: t('toasts.errorTitle'),
        description: t('toasts.passwordLengthError'),
        variant: 'destructive',
      })
      return
    }
    handleAction(t('actions.addUser'), () => playersApi.addUser(addUserUsername.trim(), addUserPassword), () => {
      setAddUserDialogOpen(false)
      setAddUserUsername('')
      setAddUserPassword('')
      void fetchWhitelist()
    })
  }

  const handleAddAllowedSteamId = () => {
    const steamId = allowedSteamIdInput.trim()
    if (!/^\d{17}$/.test(steamId)) {
      toast({
        title: t('toasts.invalidSteamIdTitle'),
        description: t('toasts.invalidSteamIdDesc'),
        variant: 'destructive',
      })
      return
    }
    handleAction(t('actions.addAllowedSteamId'), () => playersApi.addAllowedSteamId(steamId), () => {
      setAllowedSteamIdInput('')
      void fetchWhitelist()
    })
  }

  const handleSetAccessLevel = () => {
    if (!selectedPlayer || !accessLevel) return
    handleAction(t('actions.setAccessLevel'), () => playersApi.setAccessLevel(selectedPlayer, accessLevel))
  }

  // Direct spawn handlers used by the SpawnBrowser dialog. They intentionally
  // rethrow on failure so the dialog keeps the current selection (user can retry),
  // and resolve silently on success so the dialog shows its own in-place confirmation.
  const spawnItemFromBrowser = async (id: string, qty?: number) => {
    if (!selectedPlayer) throw new Error(t('spawn.noPlayerSelected'))
    const count = qty ?? 1
    setLoading(true)
    try {
      await playersApi.addItem(selectedPlayer, id, count)
      toast({
        title: t('toasts.itemGivenTitle'),
        description: t('toasts.itemGivenDesc', {
          item: id.replace(/^Base\./, ''),
          qty: count > 1 ? ` × ${count}` : '',
          player: selectedPlayer,
        }),
        variant: 'success' as const,
      })
      fetchPlayers()
    } catch (error) {
      toast({
        title: t('toasts.giveItemFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.giveItemFailedFallback')),
        variant: 'destructive',
      })
      throw error
    } finally {
      setLoading(false)
    }
  }

  const spawnVehicleFromBrowser = async (id: string) => {
    setLoading(true)
    try {
      await playersApi.addVehicle(id, selectedPlayer || undefined)
      const vehicle = id.replace(/^Base\./, '')
      toast({
        title: t('toasts.vehicleSpawnedTitle'),
        description: selectedPlayer
          ? t('toasts.vehicleSpawnedDescWithPlayer', { vehicle, player: selectedPlayer })
          : t('toasts.vehicleSpawnedDescNoPlayer', { vehicle }),
        variant: 'success' as const,
      })
      fetchPlayers()
    } catch (error) {
      toast({
        title: t('toasts.vehicleSpawnFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.vehicleSpawnFailedFallback')),
        variant: 'destructive',
      })
      throw error
    } finally {
      setLoading(false)
    }
  }

  const handleAddXp = () => {
    if (!selectedPlayer || !selectedPerk) return
    handleAction(t('actions.addXp'), () => playersApi.addXp(selectedPlayer, selectedPerk, xpAmount))
  }

  const handleGodMode = (enabled: boolean) => {
    const player = selectedPlayer
    if (!player) return
    const label = enabled ? t('actions.enableGodMode') : t('actions.disableGodMode')
    handleAction(label, async () => {
      const response = await panelBridgeApi.sendCommand('setGodMode', { username: player, enabled })
      const state = getBridgeVerifiedState('setGodMode', response?.data)
      // Only reflect the new state on the control once the mod actually
      // confirmed it -- an 'unverifiable'/'old-bridge' response leaves the
      // toggle showing its last KNOWN state instead of one nobody confirmed.
      if (state === null || state === 'confirmed') {
        setPlayerPowers(prev => ({
          ...prev,
          [player]: { ...prev[player], godMode: enabled }
        }))
      }
      return bridgeVerifyToastOverride(label, 'setGodMode', response?.data)
    })
  }

  const handleInvisible = (enabled: boolean) => {
    const player = selectedPlayer
    if (!player) return
    const label = enabled ? t('actions.enableInvisible') : t('actions.disableInvisible')
    handleAction(label, async () => {
      const response = await panelBridgeApi.sendCommand('setInvisible', { username: player, enabled })
      const state = getBridgeVerifiedState('setInvisible', response?.data)
      if (state === null || state === 'confirmed') {
        setPlayerPowers(prev => ({
          ...prev,
          [player]: { ...prev[player], invisible: enabled }
        }))
      }
      return bridgeVerifyToastOverride(label, 'setInvisible', response?.data)
    })
  }

  const handleNoclip = (enabled: boolean) => {
    const player = selectedPlayer
    if (!player) return
    const label = enabled ? t('actions.enableNoclip') : t('actions.disableNoclip')
    handleAction(label, async () => {
      const response = await panelBridgeApi.sendCommand('setNoclip', { username: player, enabled })
      const state = getBridgeVerifiedState('setNoclip', response?.data)
      if (state === null || state === 'confirmed') {
        setPlayerPowers(prev => ({
          ...prev,
          [player]: { ...prev[player], noclip: enabled }
        }))
      }
      return bridgeVerifyToastOverride(label, 'setNoclip', response?.data)
    })
  }

  const handleHealPlayer = () => {
    const player = selectedPlayer
    if (!player) return
    handleAction(t('actions.healPlayer'),
      async () => {
        await panelBridgeApi.sendCommand('healPlayer', { username: player })
      })
  }

  // Permanent character loss in a permadeath game, inflicted on someone
  // else -- the only destructive one of these five GM-tools actions. Guarded
  // by requiring the operator to type the TARGET's username (not just click
  // through), so a fast-clicking admin can't kill the wrong player they
  // happened to have selected. killPlayer has no players.js-native route and
  // isn't bridge-verify-gated (see bridgeVerify.ts), unlike heal/godmode/
  // invisible/noclip -- it goes through panelBridgeApi.killPlayer (the
  // dedicated PanelBridge route), not the generic sendCommand passthrough.
  const handleKillPlayer = async () => {
    const player = selectedPlayer
    if (!player) return
    const confirmed = await confirm({
      title: t('powers.killConfirmTitle', { player }),
      description: t('powers.killConfirmDesc', { player }),
      confirmLabel: t('powers.killConfirmButton'),
      destructive: true,
      requireTypedConfirmation: {
        value: player,
        label: t('powers.killConfirmTypeLabel', { player }),
        // ConfirmContext.tsx defaults an omitted placeholder to the
        // required value itself -- here that would render the exact
        // string "Kate" in placeholder-gray inside an untouched input,
        // pixel-indistinguishable at a glance from having already typed
        // it (2026-08-31 impeccable pass, verified by cropping the
        // rendered screenshot and comparing text color against the
        // Cancel button's real text). An explicit empty placeholder
        // leaves the box genuinely blank instead.
        placeholder: '',
      },
    })
    if (!confirmed) return
    handleAction(t('actions.killPlayer'),
      async () => {
        await panelBridgeApi.killPlayer(player)
      })
  }

  // Get selected player's current powers
  const selectedPlayerPowers = useMemo(() =>
    selectedPlayer ? playerPowers[selectedPlayer] : null,
    [selectedPlayer, playerPowers]
  )

  const isSelectedPlayerOnline = useMemo(
    () => !!selectedPlayer && players.some(p => p.name === selectedPlayer),
    [selectedPlayer, players]
  )

  // Poll getPlayerDetails while an online player is selected and the bridge
  // is up. Keyed on the boolean (not the `players` array itself) so a
  // reference-only change from the 15s roster poll doesn't restart this.
  useEffect(() => {
    if (!selectedPlayer || !isSelectedPlayerOnline || !bridgeConnected) {
      setPlayerVitals(null)
      setPlayerVitalsError(null)
      setPlayerVitalsLoading(false)
      return
    }
    let cancelled = false
    const load = async () => {
      setPlayerVitalsLoading(true)
      try {
        const response = await panelBridgeApi.getPlayerDetails(selectedPlayer)
        if (cancelled) return
        if (response.success) {
          setPlayerVitals(response.data)
          setPlayerVitalsError(null)
        } else {
          setPlayerVitalsError(response.error || t('vitals.loadError'))
        }
      } catch (err) {
        if (!cancelled) setPlayerVitalsError(getErrorMessage(err, t('vitals.loadError')))
      } finally {
        if (!cancelled) setPlayerVitalsLoading(false)
      }
    }
    load()
    const interval = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      load()
    }, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [selectedPlayer, isSelectedPlayerOnline, bridgeConnected, t])

  const selectedPlayerConfirmedNotWhitelisted = useMemo(() =>
    isPlayerConfirmedNotWhitelisted(selectedPlayer, whitelistAccounts, whitelistLoading, whitelistError),
    [selectedPlayer, whitelistAccounts, whitelistLoading, whitelistError]
  )

  return (
    <div className="space-y-6 page-transition">
      {/* Header */}
      <PageHeader
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
        icon={<Users className="w-5 h-5 text-primary" />}
        actions={
          <div className="flex items-center gap-2">
            {lastRefresh && (
              <span className="text-xs text-muted-foreground">
                {t('pageHeader.updated', { time: lastRefresh.toLocaleTimeString(i18n.language) })}
              </span>
            )}
            <Button onClick={() => { fetchPlayers(); void fetchWhitelist() }} variant="outline" size="sm" className="gap-2">
              <RefreshCw className="w-4 h-4" />
              {t('pageHeader.refresh')}
            </Button>
          </div>
        }
      />

      {(playersLoadError || toolsLoadError) && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t('errorBanner.title')}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0 break-words">
              {playersLoadError || toolsLoadError}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                fetchPlayers()
                fetchData()
              }}
              className="self-start"
            >
              <RefreshCw className="me-2 h-4 w-4" /> {t('errorBanner.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Stats summary — tactical signal strip */}
      <div className="flex flex-col gap-2 stagger-in sm:flex-row sm:flex-wrap">
        <SummaryCard
          icon={<Users className="h-4 w-4" />}
          label={t('summary.online')}
          value={players.length}
          tone={players.length > 0 ? 'success' : 'default'}
          caption={t('summary.onlineCaption', { count: players.length })}
        />
        <SummaryCard
          icon={<TrendingUp className="h-4 w-4" />}
          label={t('summary.peakToday')}
          value={peakPlayers}
          tone="default"
        />
        <SummaryCard
          icon={<Users className="h-4 w-4" />}
          label={t('summary.roster')}
          value={offlineRoster.length}
          caption={t('summary.rosterCaption')}
          help={<HelpTip label={t('summary.roster')}>{t('summary.rosterTip')}</HelpTip>}
        />
        {bannedSteamIds.length > 0 && (
          <DisabledReason className="flex-1" reason={!canModerate ? t('permissions.noModerate') : null}>
          <button
            type="button"
            onClick={() => setUnbanSteamIdDialogOpen(true)}
            disabled={!canModerate}
            className="group relative flex flex-1 items-center gap-3 overflow-hidden rounded-md border border-border/55 bg-card/70 px-4 py-3 text-start shadow-sm transition-colors hover:border-destructive/45 hover:bg-destructive/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label={t('summary.bannedAria', { count: bannedSteamIds.length })}
          >
            <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[2px] bg-destructive/60" />
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-destructive/30 bg-destructive/10 text-destructive">
              <Ban className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5">
                <p className="text-xl font-semibold tabular-nums leading-none tracking-tight">{bannedSteamIds.length}</p>
                <span className="text-xs font-medium text-muted-foreground/70">{t('summary.bannedManage')}</span>
              </div>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.22em] text-destructive/80">{t('summary.bannedLabel')}</p>
            </div>
          </button>
          </DisabledReason>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Player List */}
        <Card className="lg:col-span-1 overflow-hidden border-border/55 bg-card/70">
          <div className="flex items-center justify-between border-b border-border/40 bg-muted/20 px-4 py-2">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
              <span className="text-primary/80">//</span>
              <span>{t('roster.headerLabel')}</span>
              <span className="text-muted-foreground/50">·</span>
              <span>
                {rosterTab === 'online' ? t('roster.subheaderLive') : rosterTab === 'roster' ? t('roster.subheaderHistory') : rosterTab === 'banned' ? t('roster.subheaderBans') : t('roster.subheaderAccounts')}
              </span>
            </div>
            <span className="font-mono text-[11px] tabular-nums text-foreground/80">
              {rosterTab === 'online' ? players.length : rosterTab === 'roster' ? offlineRoster.length : rosterTab === 'banned' ? bannedSteamIds.length : whitelistAccounts.length}
            </span>
          </div>
          <CardHeader className="space-y-3 pb-3 pt-4">
            {/* Tab strip: online / roster / banned */}
            <div className="grid grid-cols-4 gap-1 rounded-md border border-border/55 bg-muted/30 p-1">
              <button
                type="button"
                onClick={() => setRosterTab('online')}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium transition-colors',
                  rosterTab === 'online'
                    ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <span>{t('roster.tabOnline')}</span>
                <span className="tabular-nums text-foreground/70">{players.length}</span>
              </button>
              <button
                type="button"
                onClick={() => setRosterTab('roster')}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium transition-colors',
                  rosterTab === 'roster'
                    ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <span>{t('roster.tabRoster')}</span>
                <span className="tabular-nums text-foreground/70">{offlineRoster.length}</span>
              </button>
              <button
                type="button"
                onClick={() => { setRosterTab('banned'); fetchBannedSteamIds() }}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium transition-colors',
                  rosterTab === 'banned'
                    ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <span>{t('roster.tabBanned')}</span>
                <span className="tabular-nums text-foreground/70">{bannedSteamIds.length}</span>
              </button>
              <button
                type="button"
                onClick={() => { setRosterTab('whitelist'); void fetchWhitelist() }}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium transition-colors',
                  rosterTab === 'whitelist'
                    ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <span>{t('roster.tabWhitelist')}</span>
                <span className="tabular-nums text-foreground/70">{whitelistAccounts.length}</span>
              </button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Search */}
            <div className="relative">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                placeholder={
                  rosterTab === 'online'
                    ? t('roster.searchOnline')
                    : rosterTab === 'roster'
                      ? t('roster.searchRoster')
                      : rosterTab === 'banned'
                        ? t('roster.searchBanned')
                        : t('roster.searchWhitelist')
                }
                value={playerSearchFilter}
                onChange={(e) => setPlayerSearchFilter(e.target.value)}
                className="ps-9"
                aria-label={t('roster.searchAria')}
              />
            </div>

            <ScrollArea className="h-[250px] sm:h-[320px]">
              {rosterTab === 'online' && (
                initialLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  </div>
                ) : players.length === 0 ? (
                  <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border/60 bg-muted/30">
                      <Users className="h-6 w-6 text-muted-foreground/70" />
                    </div>
                    <p className="mt-3 text-sm font-medium">{t('roster.onlineEmptyTitle')}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('roster.onlineEmptyDesc')}
                    </p>
                    {offlineRoster.length > 0 && (
                      <Button variant="ghost" size="sm" className="mt-4 text-xs text-muted-foreground" onClick={() => setRosterTab('roster')}>
                        <Users className="me-1.5 h-3.5 w-3.5" />
                        {t('roster.seePreviouslySeen', { count: offlineRoster.length })}
                      </Button>
                    )}
                    {bannedSteamIds.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-1 text-xs text-muted-foreground"
                        onClick={() => setRosterTab('banned')}
                      >
                        <Ban className="me-1.5 h-3.5 w-3.5" />
                        {t('roster.reviewBanned', { count: bannedSteamIds.length })}
                      </Button>
                    )}
                  </div>
                ) : filteredPlayers.length === 0 ? (
                  <EmptyState type="noResults" title={t('roster.noMatchesTitle', { query: playerSearchFilter })} description={t('roster.noMatchesDesc')} compact />
                ) : (
                  <div className="space-y-1">
                    {filteredPlayers.map((player) => {
                      const isSelected = selectedPlayer === player.name
                      const powers = playerPowers[player.name]
                      const hasPowers = powers && (powers.godMode || powers.invisible || powers.noclip)
                      const note = playerNotes[player.name]
                      const stat = playerStats[player.name]
                      const vitals = rosterVitals[player.name]

                      return (
                        <button
                          key={player.name}
                          type="button"
                          className={`group w-full text-start p-3 rounded-lg border cursor-pointer transition-[background-color,border-color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 ${
                            isSelected
                              ? 'bg-primary/10 border-primary shadow-sm'
                              : 'hover:bg-muted/50 border-transparent hover:border-border'
                          }`}
                          onClick={() => setSelectedPlayer(player.name)}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="w-2 h-2 rounded-full bg-primary motion-safe:animate-pulse shrink-0" aria-hidden="true" />
                              <span className="font-medium truncate">{player.name}</span>
                              <span className="sr-only">{t('roster.tabOnline')}</span>
                              {note && note.tags && note.tags.length > 0 && (
                                <div className="flex gap-1">
                                  {note.tags.slice(0, 2).map(tag => (
                                    <Badge key={tag} variant="outline" className="text-xs px-1.5 py-0 h-4">
                                      {tag}
                                    </Badge>
                                  ))}
                                  {note.tags.length > 2 && (
                                    <Badge variant="outline" className="text-xs px-1.5 py-0 h-4">
                                      +{note.tags.length - 2}
                                    </Badge>
                                  )}
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-1">
                              {vitals && typeof vitals.health === 'number' && (
                                <span
                                  className={cn(
                                    'flex items-center gap-0.5 text-xs font-mono tabular-nums me-1',
                                    vitals.health >= 60 ? 'text-emerald-500' : vitals.health >= 30 ? 'text-amber-500' : 'text-destructive',
                                  )}
                                  title={t('roster.rosterHealthTooltip', { health: Math.round(vitals.health) })}
                                >
                                  <Heart className="w-3 h-3" />
                                  {Math.round(vitals.health)}%
                                </span>
                              )}
                              {vitals?.isInfected && (
                                <Skull className="w-3 h-3 text-destructive me-1" aria-label={t('vitals.infected')} />
                              )}
                              {stat && (
                                <span className="text-xs text-muted-foreground me-1">
                                  {formatPlaytime(stat.total_playtime_seconds)}
                                </span>
                              )}
                              {note && <StickyNote className="w-3 h-3 text-muted-foreground" />}
                              {hasPowers && (
                                <div className="flex gap-0.5">
                                  {powers.godMode && (
                                    <Badge variant="secondary" className="px-1 py-0 text-xs">
                                      <Ghost className="w-3 h-3" />
                                    </Badge>
                                  )}
                                  {powers.invisible && (
                                    <Badge variant="secondary" className="px-1 py-0 text-xs">
                                      <Eye className="w-3 h-3" />
                                    </Badge>
                                  )}
                                  {powers.noclip && (
                                    <Badge variant="secondary" className="px-1 py-0 text-xs">
                                      <Layers className="w-3 h-3" />
                                    </Badge>
                                  )}
                                </div>
                              )}
                              <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${isSelected ? 'rotate-90' : ''}`} />
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )
              )}

              {rosterTab === 'roster' && (
                offlineRoster.length === 0 ? (
                  <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
                    <Users className="h-6 w-6 text-muted-foreground/70" />
                    <p className="mt-3 text-sm font-medium">
                      {playerSearchFilter ? t('roster.rosterEmptySearchTitle') : t('roster.rosterEmptyNoSearchTitle')}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {playerSearchFilter
                        ? t('roster.rosterEmptySearchDesc')
                        : t('roster.rosterEmptyNoSearchDesc')}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {offlineRoster.map((stat) => {
                      const name = stat.player_name || stat.playerName || ''
                      const isSelected = selectedPlayer === name
                      const note = playerNotes[name]
                      const lastSeen = stat.last_seen ? new Date(stat.last_seen) : null
                      return (
                        <button
                          key={name}
                          type="button"
                          className={`w-full text-start p-3 rounded-lg border transition-[background-color,border-color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 ${
                            isSelected
                              ? 'bg-primary/10 border-primary shadow-sm'
                              : 'hover:bg-muted/50 border-transparent hover:border-border'
                          }`}
                          onClick={() => setSelectedPlayer(name)}
                          title={t('roster.lastSeenTitle', { when: lastSeen ? lastSeen.toLocaleString(i18n.language) : t('roster.lastSeenUnknown') })}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="w-2 h-2 rounded-full bg-muted-foreground/40 shrink-0" aria-hidden="true" />
                              <span className="font-medium truncate">{name}</span>
                              {note && note.tags && note.tags.length > 0 && (
                                <Badge variant="outline" className="text-xs px-1.5 py-0 h-4">
                                  {note.tags[0]}
                                </Badge>
                              )}
                            </div>
                            <div className="flex flex-col items-end text-end">
                              <span className="text-xs text-muted-foreground">
                                {formatPlaytime(stat.total_playtime_seconds)}
                              </span>
                              {lastSeen && (
                                <span className="text-[10px] text-muted-foreground/70">
                                  {lastSeen.toLocaleDateString(i18n.language)}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )
              )}

              {rosterTab === 'banned' && (
                filteredBans.length === 0 ? (
                  <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
                    <Ban className="h-6 w-6 text-muted-foreground/70" />
                    <p className="mt-3 text-sm font-medium">
                      {playerSearchFilter ? t('roster.bannedEmptySearchTitle') : t('roster.bannedEmptyNoSearchTitle')}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {playerSearchFilter
                        ? t('roster.bannedEmptySearchDesc')
                        : t('roster.bannedEmptyNoSearchDesc')}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {filteredBans.map((ban) => (
                      <div
                        key={ban.steamId}
                        className="w-full p-3 rounded-lg border border-transparent hover:bg-muted/40 hover:border-border"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-mono text-sm truncate">{ban.steamId}</p>
                            {(ban.reason || ban.banned_at) && (
                              <p className="text-[11px] text-muted-foreground truncate" title={ban.reason || ''}>
                                {ban.reason ? `\u201c${ban.reason}\u201d` : ''}
                                {ban.reason && ban.banned_at ? ' \u00b7 ' : ''}
                                {ban.banned_at ? new Date(ban.banned_at).toLocaleDateString(i18n.language) : ''}
                              </p>
                            )}
                          </div>
                          <DisabledReason reason={!canModerate ? t('permissions.noModerate') : null}>
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            disabled={!canModerate}
                            onClick={() => {
                              setUnbanSteamId(ban.steamId)
                              setUnbanSteamIdDialogOpen(true)
                            }}
                            // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Unban {steamId}"); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                            title={t('roster.unbanTitle', { steamId: ban.steamId })}
                          >
                            {t('roster.unbanButton')}
                          </Button>
                          </DisabledReason>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              )}

              {rosterTab === 'whitelist' && (
                !whitelistAvailable ? (
                  <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
                    <Shield className="h-6 w-6 text-muted-foreground/70" />
                    <p className="mt-3 text-sm font-medium">{t('roster.whitelistUnavailableTitle')}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{whitelistError || t('roster.whitelistUnavailableFallback')}</p>
                  </div>
                ) : whitelistLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  </div>
                ) : filteredWhitelist.length === 0 ? (
                  <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
                    <Shield className="h-6 w-6 text-muted-foreground/70" />
                    <p className="mt-3 text-sm font-medium">{playerSearchFilter ? t('roster.whitelistEmptySearchTitle') : t('roster.whitelistEmptyNoSearchTitle')}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{playerSearchFilter ? t('roster.whitelistEmptySearchDesc') : t('roster.whitelistEmptyNoSearchDesc')}</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {filteredWhitelist.map((account) => {
                      const online = players.some(player => player.name.toLowerCase() === account.username.toLowerCase())
                      return (
                        <div key={`${account.id}-${account.username}`} className="w-full rounded-lg border border-transparent p-3 hover:border-border hover:bg-muted/40">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className={cn('h-2 w-2 shrink-0 rounded-full', online ? 'bg-primary' : 'bg-muted-foreground/40')} />
                                <span className="truncate font-medium">{account.username}</span>
                                <Badge variant="outline" className="px-1.5 py-0 text-[10px] uppercase">{account.role}</Badge>
                              </div>
                              <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
                                {account.steamId && <span className="font-mono">{account.steamId}</span>}
                                {account.lastConnection && <span>{t('roster.whitelistLastConnection', { date: new Date(account.lastConnection).toLocaleDateString(i18n.language) })}</span>}
                                <span>{online ? t('roster.whitelistOnline') : t('roster.whitelistOffline')}</span>
                              </div>
                            </div>
                            <DisabledReason reason={!canModerate ? t('permissions.noModerate') : null}>
                            <Button
                              variant="outline"
                              size="sm"
                              className="shrink-0"
                              onClick={() => handleAction(t('actions.removeFromWhitelist'), () => playersApi.removeFromWhitelist(account.username), () => { void fetchWhitelist() })}
                              disabled={loading || !canModerate}
                              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Remove {username} from whitelist"); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                              title={t('roster.removeTitle', { username: account.username })}
                            >
                              <UserMinus className="me-1.5 h-3.5 w-3.5" />
                              {t('roster.removeButton')}
                            </Button>
                            </DisabledReason>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              )}

              {rosterTab === 'whitelist' && whitelistAvailable && !whitelistLoading && (
                <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{t('roster.allowedSteamIdsLabel')}</span>
                    <span className="font-mono text-[11px] tabular-nums text-foreground/70">{allowedSteamIds.length}</span>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      value={allowedSteamIdInput}
                      onChange={(event) => setAllowedSteamIdInput(sanitizeSteamId(event.target.value))}
                      placeholder="76561198XXXXXXXXX"
                      inputMode="numeric"
                      className="h-8 font-mono text-xs"
                      aria-label={t('roster.allowedSteamIdAria')}
                    />
                    <DisabledReason reason={!canModerate ? t('permissions.noModerate') : null}>
                    <Button onClick={handleAddAllowedSteamId} disabled={loading || !canModerate || allowedSteamIdInput.length !== 17} size="sm" className="shrink-0">
                      <Plus className="me-1.5 h-3.5 w-3.5" /> {t('roster.addButton')}
                    </Button>
                    </DisabledReason>
                  </div>
                  {allowedSteamIds.filter(id => !playerSearchFilter.trim() || id.includes(playerSearchFilter.trim())).map((steamId) => (
                    <div key={steamId} className="flex items-center justify-between gap-2 rounded-md border border-transparent px-2 py-1.5 hover:border-border hover:bg-muted/30">
                      <span className="font-mono text-xs">{steamId}</span>
                      <DisabledReason reason={!canModerate ? t('permissions.noModerate') : null}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                        onClick={() => handleAction(t('actions.removeAllowedSteamId'), () => playersApi.removeAllowedSteamId(steamId), () => { void fetchWhitelist() })}
                        disabled={loading || !canModerate}
                        // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Remove allowed Steam ID {steamId}"); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                        title={t('roster.removeAllowedTitle', { steamId })}
                      >
                        <Trash2 className="me-1 h-3.5 w-3.5" /> {t('roster.removeAllowedButton')}
                      </Button>
                      </DisabledReason>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>

            {/* Manual entry — for offline or unlisted usernames */}
            <div className="space-y-1.5 border-t border-border/40 pt-3">
              <Label className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/80">
                <span className="text-primary/70">›</span> {t('roster.manualTargetLabelText')}
              </Label>
              <Input
                placeholder={t('roster.manualTargetPlaceholder')}
                value={selectedPlayer}
                onChange={(e) => setSelectedPlayer(e.target.value)}
                className="h-9 font-mono text-sm"
              />
            </div>
          </CardContent>
        </Card>

        {/* Player Actions */}
        <Card className="lg:col-span-2 overflow-hidden border-border/55 bg-card/70">
          {/* Header strip */}
          <div className="flex items-center justify-between border-b border-border/40 bg-muted/20 px-4 py-2">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
              <span className="text-primary/80">//</span>
              <span>{t('dossier.subheaderLabel')}</span>
              <span className="text-muted-foreground/50">·</span>
              <span className={selectedPlayer ? 'text-foreground/85' : 'text-amber-400/85'}>
                {selectedPlayer ? t('dossier.targetAcquired') : t('dossier.standby')}
              </span>
            </div>
            {selectedPlayer && (
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/70">
                {(() => {
                  const online = players.some(p => p.name === selectedPlayer)
                  return online ? t('dossier.online') : t('dossier.offline')
                })()}
              </span>
            )}
          </div>
          <CardHeader className="space-y-3 pb-3 pt-4">
            {selectedPlayer ? (
              <>
                {/* Dossier hero: identity + key stats */}
                {(() => {
                  const isOnline = players.some(p => p.name === selectedPlayer)
                  const note = playerNotes[selectedPlayer]
                  const stat = playerStats[selectedPlayer]
                  return (
                    <div className="relative overflow-hidden rounded-md border border-border/50 bg-gradient-to-br from-muted/30 via-card to-card p-4">
                      {/* Corner ticks */}
                      <span aria-hidden="true" className="pointer-events-none absolute -left-px -top-px h-3 w-3 border-s-2 border-t-2 border-primary/40" />
                      <span aria-hidden="true" className="pointer-events-none absolute -right-px -top-px h-3 w-3 border-e-2 border-t-2 border-primary/40" />
                      <span aria-hidden="true" className="pointer-events-none absolute -left-px -bottom-px h-3 w-3 border-b-2 border-s-2 border-primary/40" />
                      <span aria-hidden="true" className="pointer-events-none absolute -right-px -bottom-px h-3 w-3 border-b-2 border-e-2 border-primary/40" />
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              aria-hidden="true"
                              className={cn(
                                'h-2 w-2 rounded-full',
                                isOnline ? 'bg-emerald-400 motion-safe:animate-pulse shadow-[0_0_8px_hsl(var(--primary)/0.65)]' : 'bg-muted-foreground/40'
                              )}
                            />
                            <h2 className="truncate text-xl font-semibold tracking-tight">{selectedPlayer}</h2>
                            <span className="text-xs font-medium text-muted-foreground/80">
                              {isOnline ? t('dossier.connected') : t('dossier.lastSeen')}
                            </span>
                          </div>
                          {/* Inline stats */}
                          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground/85">
                            {stat ? (
                              <>
                                <span className="flex items-center gap-1.5">
                                  <Clock className="h-3 w-3 text-primary/70" />
                                  <span className="tabular-nums text-foreground/85">{formatPlaytime(stat.total_playtime_seconds)}</span>
                                  <span className="text-muted-foreground/70">{t('dossier.played')}</span>
                                </span>
                                <span className="flex items-center gap-1.5">
                                  <TrendingUp className="h-3 w-3 text-primary/70" />
                                  <span className="tabular-nums text-foreground/85">{stat.session_count}</span>
                                  <span className="text-muted-foreground/70">{t('dossier.sessions')}</span>
                                </span>
                                {stat.last_seen && (
                                  <span className="text-muted-foreground/70">
                                    {t('dossier.lastLabel')} <span className="text-foreground/80">{new Date(stat.last_seen).toLocaleDateString(i18n.language)}</span>
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="text-muted-foreground/60">{t('dossier.noHistory')}</span>
                            )}
                          </div>
                          {/* Tags + powers row */}
                          {((note?.tags && note.tags.length > 0) || (selectedPlayerPowers && (selectedPlayerPowers.godMode || selectedPlayerPowers.invisible || selectedPlayerPowers.noclip))) && (
                            <div className="mt-3 flex flex-wrap items-center gap-1.5">
                              {selectedPlayerPowers?.godMode && (
                                <Badge variant="outline" className="gap-1 border-primary/40 bg-primary/10 px-1.5 py-0 text-[10px] font-mono uppercase tracking-wider text-primary">
                                  <Ghost className="h-3 w-3" /> {t('dossier.godBadge')}
                                </Badge>
                              )}
                              {selectedPlayerPowers?.invisible && (
                                <Badge variant="outline" className="gap-1 border-primary/40 bg-primary/10 px-1.5 py-0 text-[10px] font-mono uppercase tracking-wider text-primary">
                                  <Eye className="h-3 w-3" /> {t('dossier.invisibleBadge')}
                                </Badge>
                              )}
                              {selectedPlayerPowers?.noclip && (
                                <Badge variant="outline" className="gap-1 border-primary/40 bg-primary/10 px-1.5 py-0 text-[10px] font-mono uppercase tracking-wider text-primary">
                                  <Layers className="h-3 w-3" /> {t('dossier.noclipBadge')}
                                </Badge>
                              )}
                              {note?.tags?.map(tag => (
                                <Badge key={tag} variant="secondary" className="px-1.5 py-0 text-[10px] font-mono uppercase tracking-wider">
                                  {tag}
                                </Badge>
                              ))}
                              {note?.note && (
                                <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                                  <StickyNote className="h-3 w-3" /> {t('dossier.noteBadge')}
                                </Badge>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Quick danger actions */}
                        <div className="flex shrink-0 items-center gap-1.5">
                          <DisabledReason reason={!canModerate ? t('permissions.noModerate') : null}>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setKickDialogOpen(true)}
                            disabled={!canModerate}
                            className="h-8 gap-1.5 border-amber-500/40 text-xs font-medium text-amber-300 hover:border-amber-500/60 hover:bg-amber-500/10 hover:text-amber-200"
                            // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Kick player"); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                            title={t('dossier.kickTitle')}
                          >
                            <UserX className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">{t('dossier.kickButton')}</span>
                          </Button>
                          </DisabledReason>
                          <DisabledReason reason={!canModerate ? t('permissions.noModerate') : null}>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setBanDialogOpen(true)}
                            disabled={!canModerate}
                            className="h-8 gap-1.5 border-destructive/45 text-xs font-medium text-destructive hover:border-destructive/65 hover:bg-destructive/10"
                            // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Ban player"); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                            title={t('dossier.banTitle')}
                          >
                            <Ban className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">{t('dossier.banButton')}</span>
                          </Button>
                          </DisabledReason>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="outline" size="sm" className="h-8 w-8 p-0" aria-label={t('dossier.moreActionsAria')}>
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DisabledReason className="w-full" reason={!canGmTools ? t('permissions.noGmTools') : (!bridgeConnected ? t('powers.bridgeRequiredTooltip') : null)}>
                                <DropdownMenuItem onClick={() => { if (!canGmTools) return; handleGodMode(!selectedPlayerPowers?.godMode) }} disabled={loading || !bridgeConnected || !canGmTools}>
                                  <Ghost className="w-4 h-4 me-2" />
                                  {selectedPlayerPowers?.godMode ? t('dossier.disableGodMode') : t('dossier.enableGodMode')}
                                </DropdownMenuItem>
                              </DisabledReason>
                              <DisabledReason className="w-full" reason={!canGmTools ? t('permissions.noGmTools') : (!bridgeConnected ? t('powers.bridgeRequiredTooltip') : null)}>
                                <DropdownMenuItem onClick={() => { if (!canGmTools) return; handleInvisible(!selectedPlayerPowers?.invisible) }} disabled={loading || !bridgeConnected || !canGmTools}>
                                  <Eye className="w-4 h-4 me-2" />
                                  {selectedPlayerPowers?.invisible ? t('dossier.disableInvisible') : t('dossier.enableInvisible')}
                                </DropdownMenuItem>
                              </DisabledReason>
                              <DisabledReason className="w-full" reason={!canGmTools ? t('permissions.noGmTools') : (!bridgeConnected ? t('powers.bridgeRequiredTooltip') : null)}>
                                <DropdownMenuItem onClick={() => { if (!canGmTools) return; handleNoclip(!selectedPlayerPowers?.noclip) }} disabled={loading || !bridgeConnected || !canGmTools}>
                                  <Layers className="w-4 h-4 me-2" />
                                  {selectedPlayerPowers?.noclip ? t('dossier.disableNoclip') : t('dossier.enableNoclip')}
                                </DropdownMenuItem>
                              </DisabledReason>
                              <DropdownMenuSeparator />
                              <DisabledReason className="w-full" reason={!canModerate ? t('permissions.noModerate') : null}>
                              <DropdownMenuItem
                                onClick={() => {
                                  if (!canModerate) return
                                  setAddUserUsername(selectedPlayer)
                                  setAddUserPassword('')
                                  setAddUserDialogOpen(true)
                                }}
                                disabled={loading || !canModerate}
                              >
                                <UserPlus className="w-4 h-4 me-2" />
                                {t('dossier.addToWhitelist')}
                              </DropdownMenuItem>
                              </DisabledReason>
                              <DisabledReason className="w-full" reason={!canModerate ? t('permissions.noModerate') : null}>
                              <DropdownMenuItem
                                onClick={() => { if (!canModerate) return; handleAction(t('actions.removeFromWhitelist'), () => playersApi.removeFromWhitelist(selectedPlayer), () => { void fetchWhitelist() }) }}
                                disabled={loading || !canModerate || selectedPlayerConfirmedNotWhitelisted}
                              >
                                <UserMinus className="w-4 h-4 me-2" />
                                {t('dossier.removeFromWhitelist')}
                              </DropdownMenuItem>
                              </DisabledReason>
                              <DropdownMenuSeparator />
                              <DisabledReason className="w-full" reason={!canGmTools ? t('permissions.noGmTools') : (!bridgeConnected ? t('powers.bridgeRequiredTooltip') : null)}>
                                <DropdownMenuItem
                                  onClick={() => { if (!canGmTools) return; setImportExportOpen(true) }}
                                  disabled={!bridgeConnected || !canGmTools}
                                >
                                  <Download className="w-4 h-4 me-2" />
                                  {t('dossier.importExportCharacter')}
                                </DropdownMenuItem>
                              </DisabledReason>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    </div>
                  )
                })()}
              </>
            ) : (
              <div className="relative overflow-hidden rounded-md border border-dashed border-border/50 bg-muted/10 px-6 py-10 text-center">
                <span aria-hidden="true" className="pointer-events-none absolute -left-px -top-px h-3 w-3 border-s-2 border-t-2 border-border/60" />
                <span aria-hidden="true" className="pointer-events-none absolute -right-px -top-px h-3 w-3 border-e-2 border-t-2 border-border/60" />
                <span aria-hidden="true" className="pointer-events-none absolute -left-px -bottom-px h-3 w-3 border-b-2 border-s-2 border-border/60" />
                <span aria-hidden="true" className="pointer-events-none absolute -right-px -bottom-px h-3 w-3 border-b-2 border-e-2 border-border/60" />
                <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/70">
                  {t('dossier.noTargetTitle')}
                </p>
                <p className="mx-auto mt-3 max-w-xs text-sm text-muted-foreground">
                  <Trans i18nKey="dossier.noTargetDesc" t={t} components={{ 1: <span className="font-mono text-foreground/80" /> }} />
                </p>
              </div>
            )}
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="moderation">
              {/* flex-wrap, not horizontal scroll: the previous overflow-x-auto
                  strip clipped "Notes & Log" down to a bare "N" on mobile,
                  with only a 12px edge mask as the sole cue that there was
                  more to scroll to -- easy to miss, no arrow or shadow, and
                  the strip starts scrolled to the clipped position by
                  default (2026-08-31 visual sweep). These five tabs are
                  label-only, same shape as Debug.tsx's own tab strip, which
                  already wraps instead of scrolling -- matching that
                  existing, already-proven convention here instead of tuning
                  the mask/adding scroll arrows. */}
              <TabsList className="flex h-auto flex-wrap items-center gap-1 rounded-md border border-border/55 bg-muted/30 p-1">
                <TabsTrigger value="vitals" className="min-h-8 shrink-0 px-3 text-xs font-medium">{t('tabs.vitals')}</TabsTrigger>
                <TabsTrigger value="moderation" className="min-h-8 shrink-0 px-3 text-xs font-medium">{t('tabs.moderation')}</TabsTrigger>
                <TabsTrigger value="spawn" className="min-h-8 shrink-0 px-3 text-xs font-medium">{t('tabs.spawn')}</TabsTrigger>
                <TabsTrigger value="powers" className="min-h-8 shrink-0 px-3 text-xs font-medium">{t('tabs.powers')}</TabsTrigger>
                <TabsTrigger value="notes" className="min-h-8 shrink-0 px-3 text-xs font-medium" onClick={() => fetchActivityLogs()}>{t('tabs.notesLog')}</TabsTrigger>
              </TabsList>

              {/* Vitals Tab -- live PanelBridge.getPlayerDetails read-back:
                  position, health, and the eight stats:get(CharacterStat.X)
                  fields. 2026-08-30: this data has been correctly served by
                  the server since the same-day stats-repair fix, but had no
                  UI consumer at all until now. */}
              <TabsContent value="vitals" className="space-y-4 mt-4">
                {!selectedPlayer ? (
                  <p className="text-sm text-muted-foreground">{t('vitals.noTarget')}</p>
                ) : !isSelectedPlayerOnline ? (
                  <p className="text-sm text-muted-foreground">{t('vitals.offline')}</p>
                ) : !bridgeConnected ? (
                  <p className="text-sm text-muted-foreground">{t('vitals.bridgeRequired')}</p>
                ) : playerVitalsLoading && !playerVitals ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> {t('vitals.loading')}
                  </div>
                ) : playerVitalsError && !playerVitals ? (
                  <p className="text-sm text-destructive">{playerVitalsError}</p>
                ) : !playerVitals ? (
                  <p className="text-sm text-muted-foreground">{t('vitals.unavailable')}</p>
                ) : (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {playerVitals.accessLevel && playerVitals.accessLevel !== 'none' && playerVitals.accessLevel !== 'user' && (
                        <Badge variant="outline" className="text-[10px] font-mono uppercase tracking-wider text-amber-400">
                          {playerVitals.accessLevel}
                        </Badge>
                      )}
                      {playerVitals.health?.isInfected && (
                        <Badge variant="outline" className="gap-1 border-destructive/40 text-[10px] font-mono uppercase tracking-wider text-destructive">
                          <Skull className="h-3 w-3" /> {t('vitals.infected')}
                        </Badge>
                      )}
                      {playerVitals.health?.isBleeding && (
                        <Badge variant="outline" className="border-destructive/40 text-[10px] font-mono uppercase tracking-wider text-destructive">
                          {t('vitals.bleeding')}
                        </Badge>
                      )}
                      {playerVitals.isAsleep && (
                        <Badge variant="outline" className="gap-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                          <Moon className="h-3 w-3" /> {t('vitals.asleep')}
                        </Badge>
                      )}
                      {playerVitals.isSneaking && (
                        <Badge variant="outline" className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                          {t('vitals.sneaking')}
                        </Badge>
                      )}
                      {playerVitals.isRunning && (
                        <Badge variant="outline" className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                          {t('vitals.running')}
                        </Badge>
                      )}
                    </div>

                    {typeof playerVitals.x === 'number' && typeof playerVitals.y === 'number' && (
                      <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground/85">
                        <MapPin className="h-3.5 w-3.5 text-primary/70" />
                        <span className="tabular-nums">{Math.round(playerVitals.x)}, {Math.round(playerVitals.y)}{typeof playerVitals.z === 'number' ? `, ${playerVitals.z}` : ''}</span>
                      </div>
                    )}

                    <div className="space-y-2">
                      {playerVitals.health?.overallBodyHealth !== undefined && (
                        <VitalBar
                          label={t('vitals.health')}
                          value={playerVitals.health.overallBodyHealth / 100}
                          goodWhenLow={false}
                        />
                      )}
                      {([
                        { key: 'hunger', value: playerVitals.stats?.hunger, label: t('vitals.hunger') },
                        { key: 'thirst', value: playerVitals.stats?.thirst, label: t('vitals.thirst') },
                        { key: 'fatigue', value: playerVitals.stats?.fatigue, label: t('vitals.fatigue') },
                      ] as const).map(({ key, value, label }) => value === undefined ? null : (
                        <VitalBar key={key} label={label} value={value} goodWhenLow />
                      ))}
                    </div>

                    {/* Endurance/stress/boredom/unhappiness/pain: real values
                        the bridge sends, but PZ's 0-1 vs 0-100 scale per stat
                        isn't confirmed against the jar the way hunger/thirst/
                        fatigue is (see statGet's comment in PanelBridge.lua)
                        -- shown as raw numbers rather than a bar that could
                        misrepresent the scale. That reasoning was invisible on
                        screen (2026-08-31 impeccable pass) -- the HelpTip below
                        surfaces it instead of just the comment here. */}
                    {playerVitals.stats && (
                      <div className="border-t border-border/40 pt-2">
                        <div className="mb-1 flex items-center gap-1">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                            {t('vitals.otherStatsLabel')}
                          </span>
                          <HelpTip label={t('vitals.otherStatsLabel')}>{t('vitals.otherStatsTip')}</HelpTip>
                        </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground/85 sm:grid-cols-3">
                        {([
                          ['endurance', playerVitals.stats.endurance, t('vitals.endurance')],
                          ['stress', playerVitals.stats.stress, t('vitals.stress')],
                          ['boredom', playerVitals.stats.boredom, t('vitals.boredom')],
                          ['unhappiness', playerVitals.stats.unhappiness, t('vitals.unhappiness')],
                          ['pain', playerVitals.stats.pain, t('vitals.pain')],
                        ] as const).map(([key, value, label]) => value === undefined ? null : (
                          <div key={key} className="flex items-center justify-between gap-2">
                            <span className="uppercase tracking-wide text-[10px] text-muted-foreground/70">{label}</span>
                            <span className="tabular-nums text-foreground/85">{Math.round(value * 100) / 100}</span>
                          </div>
                        ))}
                      </div>
                      </div>
                    )}

                    {(playerVitals.health?.temperature !== undefined || playerVitals.health?.wetness !== undefined) && (
                      <div className="flex items-center gap-4 border-t border-border/40 pt-2 font-mono text-xs text-muted-foreground/85">
                        {playerVitals.health?.temperature !== undefined && (
                          <span className="flex items-center gap-1.5">
                            <Thermometer className="h-3.5 w-3.5 text-primary/70" />
                            <span className="tabular-nums">{Math.round(playerVitals.health.temperature * 10) / 10}°</span>
                          </span>
                        )}
                        {playerVitals.health?.wetness !== undefined && (
                          <span className="tabular-nums">{t('vitals.wetness')}: {Math.round(playerVitals.health.wetness * 100)}%</span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </TabsContent>

              {/* Moderation Tab */}
              <TabsContent value="moderation" className="space-y-4 mt-4">
                {/* Primary actions — visible when a player is selected */}
                {selectedPlayer ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                  {/* Kick */}
                  <DisabledReason className="w-full" reason={selectedPlayer && !canModerate ? t('permissions.noModerate') : null}>
                  <Dialog open={kickDialogOpen} onOpenChange={setKickDialogOpen}>
                    <DialogTrigger asChild>
                      <button type="button" disabled={!selectedPlayer || !canModerate} className="block h-auto w-full p-0 text-start">
                        <ActionTile icon={<UserX className="w-4 h-4" />} label={t('dossier.kickButton')} description={t('actionTiles.kickDesc')} disabled={!selectedPlayer || !canModerate} emphasis="warning" />
                      </button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{t('kickDialog.title')}</DialogTitle>
                        <DialogDescription>
                          {t('kickDialog.description', { player: selectedPlayer })}
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label htmlFor="kick-reason">{t('kickDialog.reasonLabel')}</Label>
                          <Input
                            id="kick-reason"
                            value={kickReason}
                            onChange={(e) => setKickReason(e.target.value)}
                            placeholder={t('kickDialog.reasonPlaceholder')}
                          />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant="destructive" onClick={handleKick} disabled={loading}>
                          {loading ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : null}
                          {t('kickDialog.submit')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  </DisabledReason>

                  {/* Ban */}
                  <DisabledReason className="w-full" reason={selectedPlayer && !canModerate ? t('permissions.noModerate') : null}>
                  <Dialog open={banDialogOpen} onOpenChange={setBanDialogOpen}>
                    <DialogTrigger asChild>
                      <button type="button" disabled={!selectedPlayer || !canModerate} className="block h-auto w-full p-0 text-start">
                        <ActionTile icon={<Ban className="w-4 h-4" />} label={t('dossier.banButton')} description={t('actionTiles.banDesc')} disabled={!selectedPlayer || !canModerate} emphasis="danger" />
                      </button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                          <AlertTriangle className="w-5 h-5 text-destructive" />
                          {t('banDialog.title')}
                        </DialogTitle>
                        <DialogDescription>
                          {t('banDialog.description', { player: selectedPlayer })}
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label htmlFor="ban-reason">{t('banDialog.reasonLabel')}</Label>
                          <Input
                            id="ban-reason"
                            value={banReason}
                            onChange={(e) => setBanReason(e.target.value)}
                            placeholder={t('banDialog.reasonPlaceholder')}
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id="banIp"
                            checked={banIp}
                            onCheckedChange={(checked) => setBanIp(checked === true)}
                          />
                          <Label htmlFor="banIp">{t('banDialog.banIpLabel')}</Label>
                          <HelpTip label={t('banDialog.banIpLabel')}>{t('banDialog.banIpTip')}</HelpTip>
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant="outline" onClick={() => setBanDialogOpen(false)}>
                          {t('banDialog.cancel')}
                        </Button>
                        <Button variant="destructive" onClick={() => setBanConfirmOpen(true)}>
                          {t('banDialog.continue')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  </DisabledReason>

                  {/* Ban Confirmation */}
                  <AlertDialog open={banConfirmOpen} onOpenChange={setBanConfirmOpen}>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t('banConfirm.title')}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {banIp ? (
                            <Trans i18nKey="banConfirm.descriptionWithIp" t={t} values={{ player: selectedPlayer }} components={{ 1: <strong /> }} />
                          ) : (
                            <Trans i18nKey="banConfirm.description" t={t} values={{ player: selectedPlayer }} components={{ 1: <strong /> }} />
                          )}
                          {banReason && <><br />{t('banConfirm.reasonLine', { reason: banReason })}</>}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t('banConfirm.cancel')}</AlertDialogCancel>
                        <AlertDialogAction
                          disabled={loading}
                          onClick={(e) => { e.preventDefault(); handleBan() }}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          {loading ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : null}
                          {t('banConfirm.confirm')}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>

                  {/* Access Level */}
                  <DisabledReason className="w-full" reason={selectedPlayer && !canModerate ? t('permissions.noModerate') : null}>
                  <Dialog>
                    <DialogTrigger asChild>
                      <button type="button" disabled={!selectedPlayer || !canModerate} className="block h-auto w-full p-0 text-start">
                        <ActionTile icon={<Shield className="w-4 h-4" />} label={t('actionTiles.accessLevelLabel')} description={t('actionTiles.accessLevelDesc')} disabled={!selectedPlayer || !canModerate} emphasis="primary" />
                      </button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{t('accessLevelDialog.title')}</DialogTitle>
                        <DialogDescription>
                          {t('accessLevelDialog.description', { player: selectedPlayer })}
                        </DialogDescription>
                      </DialogHeader>
                      <div>
                        <Label htmlFor="access-level">{t('accessLevelDialog.label')}</Label>
                        <Select value={accessLevel} onValueChange={setAccessLevel}>
                          <SelectTrigger id="access-level">
                            <SelectValue placeholder={t('accessLevelDialog.placeholder')} />
                          </SelectTrigger>
                          <SelectContent>
                            {accessLevelOptions.map((level) => (
                              <SelectItem key={level} value={level}>
                                {accessLevelLabels[level] || level.charAt(0).toUpperCase() + level.slice(1)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <DialogFooter>
                        <Button onClick={handleSetAccessLevel} disabled={loading || !accessLevel}>
                          {t('accessLevelDialog.submit')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  </DisabledReason>

                  {/* Teleport — requires PanelBridge; syncs via teleportTo + setNetworkTeleportEnabled.
                      Note: known unreliable in B42 multiplayer; we still surface the dialog so admins can try. */}
                  <DisabledReason className="w-full" reason={!canGmTools ? t('permissions.noGmTools') : null}>
                  <Dialog open={teleportDialogOpen} onOpenChange={(open) => {
                    setTeleportDialogOpen(open)
                    if (open && !teleportTarget) setTeleportTarget(selectedPlayer)
                  }}>
                    <DialogTrigger asChild>
                      <button type="button" disabled={!canGmTools} className="block h-auto w-full p-0 text-start">
                        <ActionTile icon={<MapPin className="w-4 h-4" />} label={t('actionTiles.teleportLabel')} description={t('actionTiles.teleportDesc')} />
                      </button>
                    </DialogTrigger>
                    <DialogContent className="max-w-md">
                      <DialogHeader>
                        <DialogTitle>{t('teleportDialog.title')}</DialogTitle>
                        <DialogDescription>
                          {t('teleportDialog.description', { player: selectedPlayer })}
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label htmlFor="teleport-target">{t('teleportDialog.targetLabel')}</Label>
                          <Input
                            id="teleport-target"
                            value={teleportTarget || selectedPlayer}
                            onChange={(e) => setTeleportTarget(e.target.value)}
                            placeholder={t('teleportDialog.targetPlaceholder')}
                          />
                        </div>

                        {/* Quick Location Presets */}
                        <div>
                          <Label className="text-xs text-muted-foreground mb-2 block">{t('teleportDialog.quickLocations')}</Label>
                          <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
                            {TELEPORT_PRESETS.map((preset) => (
                              <Button
                                key={preset.name}
                                variant="outline"
                                size="sm"
                                className="h-8 min-w-0 text-xs"
                                onClick={() => {
                                  setTeleportX(preset.x)
                                  setTeleportY(preset.y)
                                  setTeleportZ(preset.z)
                                }}
                              >
                                {preset.name}
                              </Button>
                            ))}
                          </div>
                        </div>

                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <Label htmlFor="teleport-x">{t('teleportDialog.xLabel')}</Label>
                            <Input
                              id="teleport-x"
                              type="number"
                              value={teleportX}
                              onChange={(e) => setTeleportX(e.target.value)}
                              placeholder="10500"
                              min={0}
                              max={24000}
                            />
                          </div>
                          <div>
                            <Label htmlFor="teleport-y">{t('teleportDialog.yLabel')}</Label>
                            <Input
                              id="teleport-y"
                              type="number"
                              value={teleportY}
                              onChange={(e) => setTeleportY(e.target.value)}
                              placeholder="9700"
                              min={0}
                              max={24000}
                            />
                          </div>
                          <div>
                            <div className="flex items-center gap-1.5">
                              <Label htmlFor="teleport-z">{t('teleportDialog.zLabel')}</Label>
                              <HelpTip label={t('teleportDialog.zLabel')}>{t('teleportDialog.zTip')}</HelpTip>
                            </div>
                            <Input
                              id="teleport-z"
                              type="number"
                              value={teleportZ}
                              onChange={(e) => setTeleportZ(e.target.value)}
                              placeholder="0"
                              min={0}
                              max={8}
                            />
                          </div>
                        </div>
                      </div>
                      <DialogFooter>
                        <Button
                          onClick={() => handleTeleport(teleportTarget || selectedPlayer)}
                          disabled={loading || !teleportX || !teleportY || !(teleportTarget || selectedPlayer)}
                        >
                          {loading ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : null}
                          {t('teleportDialog.submit')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  </DisabledReason>
                </div>
                ) : null}

                {/* Secondary actions — less frequent operations */}
                <div className="pt-4 mt-2 border-t border-border/30">
                  <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground/80">
                    <span className="text-primary/70">//</span>
                    <span>{t('secondaryOpsHeader')}</span>
                    <span className="h-px flex-1 bg-border/40" aria-hidden="true" />
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  {/* Voice Ban */}
                  <DisabledReason className="w-full" reason={!canModerate ? t('permissions.noModerate') : null}>
                  <Dialog open={voiceBanDialogOpen} onOpenChange={setVoiceBanDialogOpen}>
                    <DialogTrigger asChild>
                      {/* eslint-disable-next-line local/no-dead-disabled-title -- pure hint (explains what voice-banning does); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27. */}
                      <button type="button" disabled={!canModerate} title={t('actionTiles.voiceBanTooltip')} className="block h-auto w-full p-0 text-start">
                        <ActionTile icon={<MicOff className="w-4 h-4" />} label={t('actionTiles.voiceBanLabel')} compact />
                      </button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{t('voiceBanDialog.title')}</DialogTitle>
                        <DialogDescription>
                          {t('voiceBanDialog.description')}
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label>{t('voiceBanDialog.usernameLabel')}</Label>
                          <Input
                            value={voiceBanUsername || selectedPlayer}
                            onChange={(e) => setVoiceBanUsername(e.target.value)}
                            placeholder={t('voiceBanDialog.usernamePlaceholder')}
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id="voiceBanEnabled"
                            checked={voiceBanEnabled}
                            onCheckedChange={(checked) => setVoiceBanEnabled(checked === true)}
                          />
                          <Label htmlFor="voiceBanEnabled">
                            {voiceBanEnabled ? t('voiceBanDialog.banLabel') : t('voiceBanDialog.unbanLabel')}
                          </Label>
                        </div>
                      </div>
                      <DialogFooter>
                        <Button
                          onClick={() => {
                            const target = voiceBanUsername || selectedPlayer
                            if (!target) return
                            setVoiceBanUsername(target)
                            handleAction(voiceBanEnabled ? t('actions.voiceBan') : t('actions.voiceUnban'),
                              () => playersApi.voiceBan(target, voiceBanEnabled), () => {
                                setVoiceBanDialogOpen(false)
                                setVoiceBanUsername('')
                              })
                          }}
                          disabled={loading || (!voiceBanUsername && !selectedPlayer)}
                        >
                          {loading ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : null}
                          {voiceBanEnabled ? (
                            <><MicOff className="w-4 h-4 me-2" /> {t('voiceBanDialog.muteButton')}</>
                          ) : (
                            <><Mic className="w-4 h-4 me-2" /> {t('voiceBanDialog.unmuteButton')}</>
                          )}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  </DisabledReason>

                  {/* SteamID Ban */}
                  <DisabledReason className="w-full" reason={!canModerate ? t('permissions.noModerate') : null}>
                  <Dialog open={steamIdBanDialogOpen} onOpenChange={setSteamIdBanDialogOpen}>
                    <DialogTrigger asChild>
                      {/* eslint-disable-next-line local/no-dead-disabled-title -- pure hint (explains what SteamID banning does); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27. */}
                      <button type="button" disabled={!canModerate} title={t('actionTiles.steamIdBanTooltip')} className="block h-auto w-full p-0 text-start">
                        <ActionTile icon={<Ban className="w-4 h-4" />} label={t('actionTiles.steamIdBanLabel')} emphasis="danger" compact />
                      </button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                          <AlertTriangle className="w-5 h-5 text-destructive" />
                          {t('steamIdBanDialog.title')}
                        </DialogTitle>
                        <DialogDescription>
                          {t('steamIdBanDialog.description')}
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label>{t('steamIdBanDialog.steamIdLabel')}</Label>
                          <Input
                            value={banSteamId}
                            onChange={(e) => setBanSteamId(sanitizeSteamId(e.target.value))}
                            placeholder="76561198XXXXXXXXX"
                          />
                        </div>
                        <div>
                          <Label>{t('steamIdBanDialog.reasonLabel')}</Label>
                          <Input
                            value={steamBanReason}
                            onChange={(e) => setSteamBanReason(e.target.value)}
                            placeholder={t('steamIdBanDialog.reasonPlaceholder')}
                          />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant="outline" onClick={() => setSteamIdBanDialogOpen(false)}>
                          {t('steamIdBanDialog.cancel')}
                        </Button>
                        <Button
                          variant="destructive"
                          onClick={handleSteamIdBan}
                          disabled={loading || banSteamId.length !== 17}
                        >
                          {loading ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : null}
                          {t('steamIdBanDialog.submit')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  </DisabledReason>

                  {/* Add User */}
                  <DisabledReason className="w-full" reason={!canModerate ? t('permissions.noModerate') : null}>
                  <Dialog open={addUserDialogOpen} onOpenChange={setAddUserDialogOpen}>
                    <DialogTrigger asChild>
                      {/* eslint-disable-next-line local/no-dead-disabled-title -- pure hint (explains what adding a user does); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27. */}
                      <button type="button" disabled={!canModerate} title={t('actionTiles.addUserTooltip')} className="block h-auto w-full p-0 text-start">
                        <ActionTile icon={<UserPlus className="w-4 h-4" />} label={t('actionTiles.addUserLabel')} compact />
                      </button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{t('addUserDialog.title')}</DialogTitle>
                        <DialogDescription>
                          {t('addUserDialog.description')}
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label>{t('addUserDialog.usernameLabel')}</Label>
                          <Input
                            value={addUserUsername}
                            onChange={(e) => setAddUserUsername(e.target.value)}
                            placeholder={t('addUserDialog.usernamePlaceholder')}
                            maxLength={64}
                          />
                        </div>
                        <div>
                          <Label>{t('addUserDialog.passwordLabel')}</Label>
                          <Input
                            type="password"
                            value={addUserPassword}
                            onChange={(e) => setAddUserPassword(e.target.value)}
                            placeholder={t('addUserDialog.passwordPlaceholder')}
                            maxLength={128}
                          />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant="outline" onClick={() => setAddUserDialogOpen(false)}>
                          {t('addUserDialog.cancel')}
                        </Button>
                        <Button
                          onClick={handleAddUser}
                          disabled={loading || !addUserUsername.trim() || (addUserPassword.length > 0 && addUserPassword.length < 4)}
                        >
                          {loading ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : null}
                          {t('addUserDialog.submit')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  </DisabledReason>

                  {/* Unban */}
                  <DisabledReason className="w-full" reason={!canModerate ? t('permissions.noModerate') : null}>
                  <Dialog open={unbanDialogOpen} onOpenChange={setUnbanDialogOpen}>
                    <DialogTrigger asChild>
                      {/* eslint-disable-next-line local/no-dead-disabled-title -- pure hint (explains what unbanning by username does); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27. */}
                      <button type="button" disabled={!canModerate} title={t('actionTiles.unbanTooltip')} className="block h-auto w-full p-0 text-start">
                        <ActionTile icon={<UserPlus className="w-4 h-4" />} label={t('actionTiles.unbanLabel')} compact />
                      </button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{t('unbanDialog.title')}</DialogTitle>
                      </DialogHeader>
                      <div>
                        <Label htmlFor="unban-username">{t('unbanDialog.usernameLabel')}</Label>
                        <Input
                          id="unban-username"
                          value={unbanUsername}
                          onChange={(e) => setUnbanUsername(e.target.value)}
                          placeholder={t('unbanDialog.usernamePlaceholder')}
                        />
                      </div>
                      <DialogFooter>
                        <Button onClick={handleUnban} disabled={loading || !unbanUsername}>
                          {t('unbanDialog.submit')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  </DisabledReason>

                  {/* Unban SteamID */}
                  <DisabledReason className="w-full" reason={!canModerate ? t('permissions.noModerate') : null}>
                  <Dialog open={unbanSteamIdDialogOpen} onOpenChange={(open) => {
                    setUnbanSteamIdDialogOpen(open)
                    if (open) fetchBannedSteamIds()
                    else setUnbanSteamId('')
                  }}>
                    <DialogTrigger asChild>
                      {/* eslint-disable-next-line local/no-dead-disabled-title -- pure hint (explains what lifting a SteamID ban does); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27. */}
                      <button type="button" disabled={!canModerate} title={t('actionTiles.unbanSteamIdTooltip')} className="block h-auto w-full p-0 text-start">
                        <ActionTile icon={<UserPlus className="w-4 h-4" />} label={t('actionTiles.unbanSteamIdLabel')} compact />
                      </button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{t('unbanSteamIdDialog.title')}</DialogTitle>
                      </DialogHeader>
                      <div className="space-y-3">
                        {bannedSteamIds.length > 0 && (
                          <div>
                            <Label>{t('unbanSteamIdDialog.selectLabel')}</Label>
                            <Select value={unbanSteamId} onValueChange={setUnbanSteamId}>
                              <SelectTrigger>
                                <SelectValue placeholder={loadingBans ? t('unbanSteamIdDialog.selectPlaceholderLoading') : t('unbanSteamIdDialog.selectPlaceholder')} />
                              </SelectTrigger>
                              <SelectContent>
                                {bannedSteamIds.map((ban) => (
                                  <SelectItem key={ban.steamId} value={ban.steamId}>
                                    {ban.steamId}
                                    {ban.banned_at && <span className="ms-2 text-xs text-muted-foreground">{new Date(ban.banned_at).toLocaleDateString(i18n.language)}</span>}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                        <div>
                          <Label htmlFor="unban-steamid">{bannedSteamIds.length > 0 ? t('unbanSteamIdDialog.orEnterManually') : t('unbanSteamIdDialog.steamIdLabel')}</Label>
                          <Input
                            id="unban-steamid"
                            value={unbanSteamId}
                            onChange={(e) => setUnbanSteamId(sanitizeSteamId(e.target.value))}
                            placeholder={t('unbanSteamIdDialog.placeholder')}
                          />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button onClick={handleUnbanSteamId} disabled={loading || unbanSteamId.length !== 17}>
                          {t('unbanSteamIdDialog.submit')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  </DisabledReason>
                </div>
                </div>
              </TabsContent>
              {/* Spawn Tab — Items, Vehicles, XP */}
              <TabsContent value="spawn" className="space-y-3 mt-4">
                {/* Give Item */}
                <DisabledReason className="w-full" reason={selectedPlayer && !canGmTools ? t('permissions.noGmTools') : null}>
                <button
                  type="button"
                  onClick={() => setItemBrowserOpen(true)}
                  disabled={!selectedPlayer || loading || !canGmTools}
                  className={cn(
                    'group w-full rounded-xl border bg-card/50 p-4 text-start',
                    'motion-safe:transition-all duration-150',
                    'border-border/60',
                    selectedPlayer && !loading && 'hover:border-primary/50 hover:bg-card/80 hover:shadow-sm',
                    (!selectedPlayer || loading) && 'opacity-60 cursor-not-allowed'
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      'rounded-lg border p-2.5 shrink-0',
                      'motion-safe:transition-colors duration-150',
                      selectedPlayer && !loading
                        ? 'border-primary/20 bg-primary/10 text-primary group-hover:bg-primary/15 group-hover:border-primary/30'
                        : 'border-border/40 bg-muted/30 text-muted-foreground'
                    )}>
                      <Package className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-foreground flex items-center gap-2">
                        {t('spawn.giveItemsTitle')}
                        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60 font-semibold">
                          {t('spawn.browserBadge')}
                        </span>
                      </p>
                      {/* line-clamp-2, not truncate -- same defect class as the moderation
                          ActionTile descriptions fixed earlier tonight, found here too on the
                          2026-08-31 impeccable pass ("...without closing the dial…" was
                          genuinely clipping mid-word). CANNOT be verified by reshooting:
                          scripts/ui-shot-tour.mjs's expandMainForCapture() forces
                          overflow:visible/height:auto on any element whose scrollHeight
                          exceeds its clientHeight before every screenshot (to keep genuinely
                          scrollable panels from being clipped by fullPage capture) -- which
                          also defeats -webkit-line-clamp's own overflow:hidden the moment
                          there's real text to cut, so a reshoot of this row shows spilled
                          text overlapping the next card even though the class is correct and
                          the real app renders it properly clamped. (First-pass mistake here:
                          reshot, saw the spillover, chased it as a real bug, shortened this
                          copy and its three siblings across all 6 locales to dodge the
                          symptom, and stripped the <Trans> nested player-name span suspecting
                          it as the cause -- none of that was the actual defect. Reverted; the
                          class alone is the fix.) Verified instead via the compiled CSS
                          (.line-clamp-2 correctly emits display:-webkit-box;
                          -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden)
                          and the RTL test below, which never runs the tour's capture-time DOM
                          rewrite. */}
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                        {selectedPlayer
                          ? <Trans i18nKey="spawn.giveItemsDescWithPlayer" t={t} values={{ player: selectedPlayer }} components={{ 1: <span className="text-primary font-medium" /> }} />
                          : t('spawn.giveItemsDescNoPlayer')}
                      </p>
                    </div>
                    <div className={cn(
                      'flex items-center gap-1 text-xs shrink-0',
                      'motion-safe:transition-all duration-150',
                      selectedPlayer && !loading
                        ? 'text-muted-foreground/60 group-hover:text-primary group-hover:translate-x-0.5'
                        : 'text-muted-foreground/30'
                    )}>
                      <span className="uppercase tracking-wider text-[10px] font-semibold">{t('spawn.browse')}</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </div>
                  </div>
                </button>
                </DisabledReason>

                {/* Spawn Vehicle */}
                <DisabledReason className="w-full" reason={!canGmTools ? t('permissions.noGmTools') : null}>
                <button
                  type="button"
                  onClick={() => setVehicleBrowserOpen(true)}
                  disabled={loading || !canGmTools}
                  className={cn(
                    'group w-full rounded-xl border bg-card/50 p-4 text-start',
                    'motion-safe:transition-all duration-150',
                    'border-border/60',
                    !loading && 'hover:border-primary/50 hover:bg-card/80 hover:shadow-sm',
                    loading && 'opacity-60 cursor-not-allowed'
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      'rounded-lg border p-2.5 shrink-0',
                      'motion-safe:transition-colors duration-150',
                      !loading
                        ? 'border-primary/20 bg-primary/10 text-primary group-hover:bg-primary/15 group-hover:border-primary/30'
                        : 'border-border/40 bg-muted/30 text-muted-foreground'
                    )}>
                      <Car className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-foreground flex items-center gap-2">
                        {t('spawn.spawnVehiclesTitle')}
                        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60 font-semibold">
                          {t('spawn.browserBadge')}
                        </span>
                      </p>
                      {/* line-clamp-2, not truncate -- see the matching comment on the
                          Give Items row above. */}
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                        {selectedPlayer
                          ? <Trans i18nKey="spawn.spawnVehiclesDescWithPlayer" t={t} values={{ player: selectedPlayer }} components={{ 1: <span className="text-primary font-medium" /> }} />
                          : t('spawn.spawnVehiclesDescNoPlayer')}
                      </p>
                    </div>
                    <div className={cn(
                      'flex items-center gap-1 text-xs shrink-0',
                      'motion-safe:transition-all duration-150',
                      !loading
                        ? 'text-muted-foreground/60 group-hover:text-primary group-hover:translate-x-0.5'
                        : 'text-muted-foreground/30'
                    )}>
                      <span className="uppercase tracking-wider text-[10px] font-semibold">{t('spawn.browse')}</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </div>
                  </div>
                </button>
                </DisabledReason>

                {/* Give XP */}
                <div className="rounded-xl border border-border/60 bg-card/50 p-4 transition-colors">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="rounded-lg border border-primary/20 bg-primary/10 p-2 text-primary">
                      <TrendingUp className="w-5 h-5" />
                    </div>
                    <div>
                      <p className="font-medium">{t('spawn.giveXpTitle')}</p>
                      <p className="text-xs text-muted-foreground">
                        {selectedPlayer
                          ? <Trans i18nKey="spawn.giveXpDescWithPlayer" t={t} values={{ player: selectedPlayer }} components={{ 1: <span className="text-foreground font-medium" /> }} />
                          : t('spawn.giveXpDescNoPlayer')}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-2">
                    <div className="flex-1 min-w-0">
                      <Select value={selectedPerk} onValueChange={setSelectedPerk}>
                        <SelectTrigger>
                          <SelectValue placeholder={t('spawn.perkPlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          {perkGroups.map(([category, items]) => (
                            <SelectGroup key={category}>
                              <SelectLabel>{category}</SelectLabel>
                              {items.map((perk) => (
                                <SelectItem key={perk.id} value={perk.id}>
                                  {perk.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="w-full sm:w-24 shrink-0">
                      <Label className="text-xs text-muted-foreground">{t('spawn.amountLabel')}</Label>
                      <NumberInput
                        value={xpAmount}
                        onChange={setXpAmount}
                        min={1}
                        max={10000}
                      />
                    </div>
                    <DisabledReason reason={!canGmTools ? t('permissions.noGmTools') : null}>
                    <Button
                      onClick={handleAddXp}
                      disabled={loading || !canGmTools || !selectedPlayer || !selectedPerk || !Number.isFinite(xpAmount)}
                      size="sm"
                      className="shrink-0 sm:min-w-[100px]"
                    >
                      <TrendingUp className="w-4 h-4 me-2" />
                      {t('spawn.giveXpButton')}
                    </Button>
                    </DisabledReason>
                  </div>
                </div>
              </TabsContent>

              {/* Powers Tab */}
              <TabsContent value="powers" className="space-y-4 mt-4">
                <p className="text-sm text-muted-foreground">
                  {selectedPlayer ? t('powers.introWithPlayer', { player: selectedPlayer }) : t('powers.introNoPlayer')}
                </p>
                <div className="grid gap-3">
                  {/* God Mode */}
                  <div className="flex items-center justify-between rounded-xl border border-border/60 bg-card/50 p-4 transition-colors hover:bg-accent/30">
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg border border-primary/20 bg-primary/10 p-2 text-primary">
                        <Ghost className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="font-medium">{t('powers.godModeLabel')}</p>
                        <p className="text-xs text-muted-foreground">{t('powers.godModeDesc')}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {selectedPlayer && (
                        <Badge
                          variant={selectedPlayerPowers?.godMode === undefined ? 'outline' : selectedPlayerPowers.godMode ? 'default' : 'secondary'}
                          className={cn('text-xs', selectedPlayerPowers?.godMode === undefined && 'border-dashed text-muted-foreground')}
                        >
                          {selectedPlayerPowers?.godMode === undefined ? t('powers.unknown') : selectedPlayerPowers.godMode ? t('powers.on') : t('powers.off')}
                        </Badge>
                      )}
                      <DisabledReason reason={!canGmTools ? t('permissions.noGmTools') : (selectedPlayer && !bridgeConnected ? t('powers.bridgeRequiredTooltip') : null)}>
                        {selectedPlayerPowers?.godMode === undefined ? (
                          // Nothing has reported this player's real current state yet --
                          // true on every page load until the operator toggles it once
                          // this session (no fetch populates playerPowers, only the
                          // optimistic update after a bridge-confirmed toggle). A single
                          // "Enable" button here would silently assume "currently off",
                          // which is exactly the state the operator can't actually see.
                          // Offering both directions keeps each button's own outcome
                          // predictable instead of guessing one on the operator's behalf.
                          <div className="flex items-center gap-1.5">
                            <Button variant="outline" size="sm" disabled={!selectedPlayer || loading || !bridgeConnected || !canGmTools} onClick={() => handleGodMode(true)}>
                              {t('powers.enable')}
                            </Button>
                            <Button variant="outline" size="sm" disabled={!selectedPlayer || loading || !bridgeConnected || !canGmTools} onClick={() => handleGodMode(false)}>
                              {t('powers.disable')}
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant={selectedPlayerPowers.godMode ? 'default' : 'outline'}
                            size="sm"
                            disabled={!selectedPlayer || loading || !bridgeConnected || !canGmTools}
                            onClick={() => handleGodMode(!selectedPlayerPowers.godMode)}
                          >
                            {selectedPlayerPowers.godMode ? t('powers.disable') : t('powers.enable')}
                          </Button>
                        )}
                      </DisabledReason>
                    </div>
                  </div>

                  {/* Invisible */}
                  <div className="flex items-center justify-between rounded-xl border border-border/60 bg-card/50 p-4 transition-colors hover:bg-accent/30">
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg border border-primary/20 bg-primary/10 p-2 text-primary">
                        <Eye className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="font-medium">{t('powers.invisibleLabel')}</p>
                        <p className="text-xs text-muted-foreground">{t('powers.invisibleDesc')}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {selectedPlayer && (
                        <Badge
                          variant={selectedPlayerPowers?.invisible === undefined ? 'outline' : selectedPlayerPowers.invisible ? 'default' : 'secondary'}
                          className={cn('text-xs', selectedPlayerPowers?.invisible === undefined && 'border-dashed text-muted-foreground')}
                        >
                          {selectedPlayerPowers?.invisible === undefined ? t('powers.unknown') : selectedPlayerPowers.invisible ? t('powers.on') : t('powers.off')}
                        </Badge>
                      )}
                      <DisabledReason reason={!canGmTools ? t('permissions.noGmTools') : (selectedPlayer && !bridgeConnected ? t('powers.bridgeRequiredTooltip') : null)}>
                        {selectedPlayerPowers?.invisible === undefined ? (
                          <div className="flex items-center gap-1.5">
                            <Button variant="outline" size="sm" disabled={!selectedPlayer || loading || !bridgeConnected || !canGmTools} onClick={() => handleInvisible(true)}>
                              {t('powers.enable')}
                            </Button>
                            <Button variant="outline" size="sm" disabled={!selectedPlayer || loading || !bridgeConnected || !canGmTools} onClick={() => handleInvisible(false)}>
                              {t('powers.disable')}
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant={selectedPlayerPowers.invisible ? 'default' : 'outline'}
                            size="sm"
                            disabled={!selectedPlayer || loading || !bridgeConnected || !canGmTools}
                            onClick={() => handleInvisible(!selectedPlayerPowers.invisible)}
                          >
                            {selectedPlayerPowers.invisible ? t('powers.disable') : t('powers.enable')}
                          </Button>
                        )}
                      </DisabledReason>
                    </div>
                  </div>

                  {/* Noclip */}
                  <div className="flex items-center justify-between rounded-xl border border-border/60 bg-card/50 p-4 transition-colors hover:bg-accent/30">
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg border border-primary/20 bg-primary/10 p-2 text-primary">
                        <Layers className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="font-medium">{t('powers.noclipLabel')}</p>
                        <p className="text-xs text-muted-foreground">{t('powers.noclipDesc')}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {selectedPlayer && (
                        <Badge
                          variant={selectedPlayerPowers?.noclip === undefined ? 'outline' : selectedPlayerPowers.noclip ? 'default' : 'secondary'}
                          className={cn('text-xs', selectedPlayerPowers?.noclip === undefined && 'border-dashed text-muted-foreground')}
                        >
                          {selectedPlayerPowers?.noclip === undefined ? t('powers.unknown') : selectedPlayerPowers.noclip ? t('powers.on') : t('powers.off')}
                        </Badge>
                      )}
                      <DisabledReason reason={!canGmTools ? t('permissions.noGmTools') : (selectedPlayer && !bridgeConnected ? t('powers.bridgeRequiredTooltip') : null)}>
                        {selectedPlayerPowers?.noclip === undefined ? (
                          <div className="flex items-center gap-1.5">
                            <Button variant="outline" size="sm" disabled={!selectedPlayer || loading || !bridgeConnected || !canGmTools} onClick={() => handleNoclip(true)}>
                              {t('powers.enable')}
                            </Button>
                            <Button variant="outline" size="sm" disabled={!selectedPlayer || loading || !bridgeConnected || !canGmTools} onClick={() => handleNoclip(false)}>
                              {t('powers.disable')}
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant={selectedPlayerPowers.noclip ? 'default' : 'outline'}
                            size="sm"
                            disabled={!selectedPlayer || loading || !bridgeConnected || !canGmTools}
                            onClick={() => handleNoclip(!selectedPlayerPowers.noclip)}
                          >
                            {selectedPlayerPowers.noclip ? t('powers.disable') : t('powers.enable')}
                          </Button>
                        )}
                      </DisabledReason>
                    </div>
                  </div>

                  {/* Heal */}
                  <div className="flex items-center justify-between rounded-xl border border-border/60 bg-card/50 p-4 transition-colors hover:bg-accent/30">
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg border border-green-500/20 bg-green-500/10 p-2 text-green-500">
                        <Heart className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="font-medium">{t('powers.healLabel')}</p>
                        <p className="text-xs text-muted-foreground">{t('powers.healDesc')}</p>
                      </div>
                    </div>
                    <DisabledReason reason={!canGmTools ? t('permissions.noGmTools') : (selectedPlayer && !bridgeConnected ? t('powers.bridgeRequiredTooltip') : null)}>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!selectedPlayer || loading || !bridgeConnected || !canGmTools}
                        onClick={handleHealPlayer}
                      >
                        {t('powers.healButton')}
                      </Button>
                    </DisabledReason>
                  </div>

                  {/* Kill -- destructive, permanent in permadeath. Only power on this
                      tab that can inflict irreversible harm on someone other than the
                      admin, so it gets a red treatment the others don't. */}
                  <div className="flex items-center justify-between rounded-xl border border-destructive/30 bg-destructive/5 p-4 transition-colors hover:bg-destructive/10">
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-2 text-destructive">
                        <Skull className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <p className="font-medium">{t('powers.killLabel')}</p>
                          <HelpTip label={t('powers.killLabel')}>{t('powers.killTip')}</HelpTip>
                        </div>
                        <p className="text-xs text-muted-foreground">{t('powers.killDesc')}</p>
                      </div>
                    </div>
                    <DisabledReason reason={!canGmTools ? t('permissions.noGmTools') : (selectedPlayer && !bridgeConnected ? t('powers.bridgeRequiredTooltip') : null)}>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={!selectedPlayer || loading || !bridgeConnected || !canGmTools}
                        onClick={handleKillPlayer}
                      >
                        {t('powers.killButton')}
                      </Button>
                    </DisabledReason>
                  </div>
                </div>
              </TabsContent>

              {/* Notes & Log Tab */}
              <TabsContent value="notes" className="space-y-4 mt-4">
                {notesLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  </div>
                ) : !selectedPlayer ? (
                  <EmptyState type="noData" title={t('notes.selectPlayerEmpty')} />
                ) : (
                  <div className="space-y-4">
                    {/* Player Stats Card */}
                    {playerStats[selectedPlayer] && (
                      <Card className="border-border/60 bg-muted/20">
                        <CardContent className="pt-4">
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                            <div className="flex items-center gap-2">
                              <Clock className="w-4 h-4 text-primary" />
                              <div>
                                <div className="text-muted-foreground text-xs">{t('notes.totalPlaytime')}</div>
                                <div className="font-medium">{formatPlaytime(playerStats[selectedPlayer].total_playtime_seconds)}</div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <TrendingUp className="w-4 h-4 text-primary" />
                              <div>
                                <div className="text-muted-foreground text-xs">{t('notes.sessions')}</div>
                                <div className="font-medium">{playerStats[selectedPlayer].session_count}</div>
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground text-xs">{t('notes.firstSeen')}</div>
                              <div className="font-medium text-xs">{new Date(playerStats[selectedPlayer].first_seen).toLocaleDateString(i18n.language)}</div>
                            </div>
                            <div>
                              <div className="text-muted-foreground text-xs">{t('notes.lastSeen')}</div>
                              <div className="font-medium text-xs">{new Date(playerStats[selectedPlayer].last_seen).toLocaleString(i18n.language)}</div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    )}

                    {/* Tags */}
                    <div className="space-y-2">
                      <Label className="text-sm font-medium flex items-center gap-2">
                        <Tag className="w-4 h-4" />
                        {t('notes.tagsLabel')}
                      </Label>
                      <div className="flex flex-wrap gap-2 min-h-[32px]">
                        {currentTags.map(tag => (
                          <Badge key={tag} variant="secondary" className="gap-1 pe-1">
                            {tag}
                            <button
                              type="button"
                              onClick={() => removeTag(tag)}
                              className="ms-1 rounded p-1.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                              aria-label={t('notes.removeTagAria', { tag })}
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </Badge>
                        ))}
                        <div className="flex items-center gap-1">
                          <Input
                            value={newTag}
                            onChange={(e) => setNewTag(e.target.value.slice(0, 24))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                addTag()
                              }
                            }}
                            placeholder={t('notes.addTagPlaceholder')}
                            className="h-8 w-28 text-xs"
                            maxLength={24}
                          />
                          <Button size="sm" variant="ghost" onClick={addTag} className="h-8 w-8 p-0" aria-label={t('notes.addTagAria')}>
                            <Plus className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t('notes.commonTagsHint')}
                      </p>
                    </div>

                    {/* Note */}
                    <div className="space-y-2">
                      {notesError && (
                        <Alert variant="destructive">
                          <AlertTriangle className="h-4 w-4" />
                          <AlertTitle>{t('notes.notesErrorTitle')}</AlertTitle>
                          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <span className="min-w-0 break-words">{notesError}</span>
                            <Button variant="outline" size="sm" onClick={() => fetchNotesAndStats()} className="self-start">
                              <RefreshCw className="me-2 h-4 w-4" /> {t('notes.retry')}
                            </Button>
                          </AlertDescription>
                        </Alert>
                      )}
                      <Label className="text-sm font-medium flex items-center gap-2">
                        <StickyNote className="w-4 h-4" />
                        {t('notes.adminNoteLabel')}
                      </Label>
                      <Textarea
                        value={currentNote}
                        onChange={(e) => setCurrentNote(e.target.value.slice(0, 1000))}
                        placeholder={t('notes.notePlaceholder')}
                        className="min-h-[120px] resize-y"
                        maxLength={1000}
                      />
                      <p className="text-xs text-muted-foreground">{t('notes.charCount', { count: currentNote.length })}</p>
                    </div>

                    {/* Actions */}
                    <div className="flex justify-between items-center pt-2">
                      <div className="text-xs text-muted-foreground">
                        {playerNotes[selectedPlayer]?.updated_at && (
                          <span>{t('notes.lastUpdated', { date: new Date(playerNotes[selectedPlayer].updated_at).toLocaleString(i18n.language) })}</span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        {playerNotes[selectedPlayer] && (
                          <DisabledReason reason={!canModerate ? t('permissions.noModerate') : null}>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setDeleteNoteConfirmOpen(true)}
                            disabled={savingNote || !canModerate}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="w-4 h-4 me-1" />
                            {t('notes.deleteButton')}
                          </Button>
                          </DisabledReason>
                        )}
                        <AlertDialog open={deleteNoteConfirmOpen} onOpenChange={setDeleteNoteConfirmOpen}>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>{t('notes.deleteConfirmTitle')}</AlertDialogTitle>
                              <AlertDialogDescription>
                                {t('notes.deleteConfirmDesc', { player: selectedPlayer })}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel disabled={savingNote}>{t('notes.deleteConfirmCancel')}</AlertDialogCancel>
                              <AlertDialogAction
                                disabled={savingNote}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                onClick={(e) => { e.preventDefault(); void handleDeleteNote() }}
                              >
                                {savingNote ? <Loader2 className="w-4 h-4 me-1 animate-spin" /> : null}
                                {t('notes.deleteConfirmConfirm')}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                        <DisabledReason reason={!canModerate ? t('permissions.noModerate') : null}>
                        <Button
                          size="sm"
                          onClick={handleSaveNote}
                          disabled={savingNote || !canModerate || (!currentNote.trim() && currentTags.length === 0)}
                        >
                          {savingNote ? <Loader2 className="w-4 h-4 me-1 animate-spin" /> : <Save className="w-4 h-4 me-1" />}
                          {t('notes.saveButton')}
                        </Button>
                        </DisabledReason>
                      </div>
                    </div>
                  </div>
                )}

                {/* Activity Log */}
                <div className="pt-4 border-t space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium flex items-center gap-2">
                      <Clock className="w-4 h-4" />
                      {t('notes.activityLogTitle')}
                    </h4>
                  </div>
                  {logsError && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>{t('notes.logsErrorTitle')}</AlertTitle>
                      <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <span className="min-w-0 break-words">{logsError}</span>
                        <Button variant="outline" size="sm" onClick={() => fetchActivityLogs(logPlayerFilter || undefined)} className="self-start">
                          <RefreshCw className="me-2 h-4 w-4" /> {t('notes.retry')}
                        </Button>
                      </AlertDescription>
                    </Alert>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        placeholder={t('notes.filterPlaceholder')}
                        value={logPlayerFilter}
                        onChange={(e) => setLogPlayerFilter(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') fetchActivityLogs(logPlayerFilter || undefined)
                        }}
                        className="ps-9"
                        aria-label={t('notes.filterAria')}
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => fetchActivityLogs(logPlayerFilter || undefined)}
                      disabled={logsLoading}
                      className="w-full sm:w-auto"
                    >
                      {logsLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    </Button>
                  </div>

                  <div className="rounded-md border max-h-[280px] overflow-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 sticky top-0">
                        <tr>
                          <th className="text-start p-2 font-medium text-xs">{t('notes.tableTime')}</th>
                          <th className="text-start p-2 font-medium text-xs">{t('notes.tablePlayer')}</th>
                          <th className="text-start p-2 font-medium text-xs">{t('notes.tableAction')}</th>
                          <th className="text-start p-2 font-medium text-xs hidden sm:table-cell">{t('notes.tableDetails')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {activityLogs.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="p-4 text-center text-muted-foreground text-sm">
                              {logsLoading ? t('notes.loadingRow') : t('notes.noLogsRow')}
                            </td>
                          </tr>
                        ) : (
                          activityLogs.map((log) => (
                            <tr key={log.id} className="hover:bg-muted/50">
                              <td className="p-2 whitespace-nowrap text-xs text-muted-foreground">
                                {new Date(log.logged_at).toLocaleString(i18n.language)}
                              </td>
                              <td className="p-2 text-xs font-medium break-words">{log.player_name}</td>
                              <td className="p-2">
                                <Badge
                                  variant={
                                    log.action === 'connect'
                                      ? 'success'
                                      : log.action === 'disconnect' || log.action === 'ban'
                                        ? 'destructive'
                                        : log.action === 'kick'
                                          ? 'warning'
                                          : 'secondary'
                                  }
                                  className="text-xs"
                                >
                                  {log.action}
                                </Badge>
                                {/* The dedicated Details column is hidden below
                                    sm (no room for a 4th column at 390px) --
                                    fold it in here instead of dropping it
                                    outright, so a real entry's details are
                                    still readable on mobile once this table
                                    actually has data (2026-08-31 visual
                                    sweep: empty today hid that nothing was
                                    reachable there at all). */}
                                <p className="mt-1 max-w-[220px] text-[11px] text-muted-foreground break-words sm:hidden">
                                  {log.details || t('notes.detailsFallback')}
                                </p>
                              </td>
                              <td className="max-w-[220px] p-2 text-xs text-muted-foreground break-words hidden sm:table-cell">
                                {log.details || t('notes.detailsFallback')}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                  {activityLogs.length >= ACTIVITY_LOG_FETCH_LIMIT && (
                    <p className="text-xs text-muted-foreground">
                      {t('notes.activityLogTruncatedHint', { count: activityLogs.length })}
                    </p>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>

      {/* Import/Export Character Dialog */}
      <Dialog open={importExportOpen} onOpenChange={setImportExportOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Download className="w-5 h-5" />
              {t('importExport.title')}
            </DialogTitle>
            <DialogDescription>
              {t('importExport.description')}
            </DialogDescription>
          </DialogHeader>
          {!bridgeConnected && (
            <Alert className="border-warning/40 bg-warning/10">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertTitle className="text-warning">{t('importExport.bridgeOfflineTitle')}</AlertTitle>
              <AlertDescription>
                <Trans
                  i18nKey="importExport.bridgeOfflineDesc"
                  t={t}
                  components={{ 1: <Link to="/settings" className="text-primary underline hover:text-foreground" /> }}
                />
              </AlertDescription>
            </Alert>
          )}
          <div className={cn("grid grid-cols-1 md:grid-cols-2 gap-4", !bridgeConnected && 'opacity-60 pointer-events-none')}>
            {/* Export */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium flex items-center gap-2">
                <Download className="w-4 h-4" />
                {t('importExport.exportTitle')}
              </h4>
              <p className="text-xs text-muted-foreground">{t('importExport.exportDesc')}</p>
              <Button
                variant="outline"
                disabled={!selectedPlayer || exporting}
                onClick={async () => {
                  setExporting(true)
                  try {
                    const { panelBridgeApi } = await import('@/lib/api')
                    const response = await panelBridgeApi.exportCharacter(selectedPlayer)
                    const exportData = response.data || response
                    const jsonStr = JSON.stringify(exportData, null, 2)
                    setCharacterData(jsonStr)
                    toast({
                      title: t('toasts.characterExportedTitle'),
                      description: t('toasts.characterExportedDesc', { player: selectedPlayer }),
                    })
                  } catch (error) {
                    toast({
                      title: t('toasts.exportFailedTitle'),
                      description: getUserErrorMessage(error, t('toasts.exportFailedFallback')),
                      variant: 'destructive',
                    })
                  } finally {
                    setExporting(false)
                  }
                }}
                size="sm"
                className="w-full"
              >
                {exporting ? (
                  <Loader2 className="w-4 h-4 me-2 animate-spin" />
                ) : (
                  <Download className="w-4 h-4 me-2" />
                )}
                {t('importExport.exportButton', { player: selectedPlayer || t('importExport.exportButtonFallback') })}
              </Button>

              {characterData && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">{t('importExport.characterDataLabel')}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      aria-label={copied ? t('importExport.copiedAria') : t('importExport.copyCharacterDataAria')}
                      onClick={() => {
                        copyText(characterData)
                        setCopied(true)
                        if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current)
                        copiedTimeoutRef.current = setTimeout(() => setCopied(false), 2000)
                      }}
                    >
                      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    </Button>
                  </div>
                  <Textarea
                    readOnly
                    value={characterData}
                    className="h-32 resize-none font-mono text-xs"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      const blob = new Blob([characterData], { type: 'application/json' })
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement('a')
                      a.href = url
                      a.download = `${selectedPlayer}_character.json`
                      a.click()
                      URL.revokeObjectURL(url)
                    }}
                  >
                    <Download className="w-4 h-4 me-2" />
                    {t('importExport.downloadFileButton')}
                  </Button>
                </div>
              )}
            </div>

            {/* Import */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium flex items-center gap-2">
                <Upload className="w-4 h-4" />
                {t('importExport.importTitle')}
              </h4>
              <p className="text-xs text-muted-foreground">{t('importExport.importDesc')}</p>
              <Textarea
                value={importCharacterData}
                onChange={(e) => setImportCharacterData(e.target.value)}
                placeholder={t('importExport.importPlaceholder')}
                className="h-24 resize-none font-mono text-xs"
              />
              <div className="flex gap-2">
                <Button
                  disabled={importing || !selectedPlayer || !importCharacterData.trim()}
                  onClick={() => {
                    let data
                    try {
                      data = JSON.parse(importCharacterData)
                    } catch {
                      toast({
                        title: t('toasts.invalidJsonTitle'),
                        description: t('toasts.invalidJsonDesc'),
                        variant: 'destructive',
                      })
                      return
                    }
                    setPendingImportData(data)
                    setImportConfirmOpen(true)
                  }}
                  size="sm"
                  className="flex-1"
                >
                  {importing ? (
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                  ) : (
                    <Upload className="w-4 h-4 me-2" />
                  )}
                  {t('importExport.applyButton')}
                </Button>
                <label className="cursor-pointer">
                  <Button variant="outline" size="sm" asChild>
                    <span>
                      <Upload className="w-4 h-4 me-1" />
                      {t('importExport.fileButton')}
                    </span>
                  </Button>
                  <input
                    type="file"
                    accept=".json"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) {
                        if (file.size > 5 * 1024 * 1024) {
                          toast({
                            title: t('toasts.fileTooLargeTitle'),
                            description: t('toasts.fileTooLargeDesc'),
                            variant: 'destructive',
                          })
                          e.target.value = ''
                          return
                        }
                        const reader = new FileReader()
                        reader.onload = (ev) => {
                          setImportCharacterData(ev.target?.result as string || '')
                        }
                        reader.readAsText(file)
                      }
                      e.target.value = ''
                    }}
                  />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">{t('importExport.playerMustBeOnline')}</p>
            </div>
          </div>

          {/* Auto-export on login */}
          <div className="border-t border-border/40 pt-4 mt-2 space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <h4 className="text-sm font-medium">{t('importExport.autoExportTitle')}</h4>
                <p className="text-xs text-muted-foreground">{t('importExport.autoExportDesc')}</p>
              </div>
              <Checkbox
                id="autoExportOnLogin"
                checked={autoExportEnabled}
                onCheckedChange={async (checked: boolean) => {
                  setAutoExportEnabled(checked)
                  try {
                    await configApi.updateAppSettings({ autoExportOnLogin: checked })
                  } catch {
                    setAutoExportEnabled(!checked)
                    toast({ title: t('toasts.updateSettingFailed'), variant: 'destructive' })
                  }
                }}
              />
            </div>

            {savedExports.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-medium text-muted-foreground">{t('importExport.savedExportsTitle', { count: savedExports.length })}</h4>
                <ScrollArea className="max-h-[180px]">
                  <div className="space-y-1">
                    {savedExports.map((exp) => (
                      <div key={`${exp.username}-${exp.filename}`} className="flex items-center justify-between gap-2 rounded-md border border-border/40 px-3 py-1.5 text-xs">
                        <div className="min-w-0 flex-1">
                          <span className="font-medium">{exp.username}</span>
                          <span className="text-muted-foreground ms-2">{new Date(exp.timestamp).toLocaleString(i18n.language)}</span>
                          <span className="text-muted-foreground ms-2">{t('importExport.sizeKb', { size: (exp.size / 1024).toFixed(1) })}</span>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            title={t('importExport.downloadTitle')}
                            aria-label={t('importExport.downloadExportAria', { username: exp.username })}
                            onClick={async () => {
                              try {
                                const data = await playersApi.getExport(exp.username, exp.filename)
                                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
                                const url = URL.createObjectURL(blob)
                                const a = document.createElement('a')
                                a.href = url
                                a.download = exp.filename
                                a.click()
                                URL.revokeObjectURL(url)
                              } catch {
                                toast({ title: t('toasts.downloadFailed'), variant: 'destructive' })
                              }
                            }}
                          >
                            <Download className="w-3 h-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                            title={t('importExport.deleteTitle')}
                            aria-label={t('importExport.deleteExportAria', { username: exp.username })}
                            onClick={async () => {
                              try {
                                await playersApi.deleteExport(exp.username, exp.filename)
                                setSavedExports(prev => prev.filter(e => e.filename !== exp.filename || e.username !== exp.username))
                              } catch {
                                toast({ title: t('toasts.deleteFailed'), variant: 'destructive' })
                              }
                            }}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Character Import Confirmation -- the failure mode here is the wrong
          player, so the target's name is the title, not a line inside the
          body. Pam's panelBridge.js snapshots the target's current data to
          Saved Exports before overwriting; if that snapshot fails the server
          refuses the import instead of proceeding, so this is honestly
          recoverable and the copy says so. */}
      <AlertDialog open={importConfirmOpen} onOpenChange={(open) => { if (!open) { setImportConfirmOpen(false); setPendingImportData(null) } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('importConfirm.title', { player: selectedPlayer })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('importConfirm.description', { player: selectedPlayer })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={importing}>{t('importConfirm.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={importing}
              onClick={(e) => { e.preventDefault(); if (pendingImportData) runCharacterImport(pendingImportData) }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {importing ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : null}
              {t('importConfirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Spawn browser dialogs — items + vehicles, stay-open workflow */}
      <SpawnBrowser
        mode="items"
        open={itemBrowserOpen}
        onOpenChange={setItemBrowserOpen}
        playerName={selectedPlayer}
        onSpawn={spawnItemFromBrowser}
      />
      <SpawnBrowser
        mode="vehicles"
        open={vehicleBrowserOpen}
        onOpenChange={setVehicleBrowserOpen}
        playerName={selectedPlayer}
        onSpawn={spawnVehicleFromBrowser}
      />
    </div>
  )
}
