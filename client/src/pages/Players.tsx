import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useDateFormat } from '@/lib/dateFormat'
import { previewBanReason, banReasonWillBeAltered } from '@/lib/rconTextPreview'
import { useRequestGuard } from '@/hooks/useRequestGuard'
import {
  Users,
  UserX,
  Ban,
  Shield,
  UserPlus,
  UserMinus,
  UserCheck,
  Car,
  Package,
  Ghost,
  Eye,
  Layers,
  RefreshCw,
  AlertTriangle,
  Loader2,
  Download,
  Map as MapIcon,
  MapPin,
  Mic,
  MicOff,
  TrendingUp,
  Clock,
  ChevronRight,
  History,
  MoreHorizontal,
  StickyNote,
  Tag,
  X,
  Plus,
  Save,
  Trash2,
  Heart,
  Skull,
} from 'lucide-react'
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
  DialogBody,
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
import { useToast } from '@/components/ui/use-toast'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { SectionCard } from '@/components/ui/section-card'
import { StatStrip, type StatStripItem } from '@/components/ui/stat-strip'
import { StatusPill } from '@/components/ui/status-pill'
import { Toolbar } from '@/components/ui/toolbar'
import { RowActions, type RowActionItem } from '@/components/ui/row-actions'
import { EmptyState } from '@/components/EmptyState'
import { HelpTip } from '@/components/HelpTip'
import { SpawnBrowser } from '@/components/SpawnBrowser'
import { NumberInput } from '@/components/NumberInput'
import { playersApi, panelBridgeApi, configApi, ApiError } from '@/lib/api'
import { getBridgeVerifiedState } from '@/lib/bridgeVerify'
import { canReadFullBridgeStatus, readBridgeLiveness } from '@/lib/bridgeLiveness'
import { PageHeader } from '@/components/PageHeader'
import { PageAlerts, type PageAlert } from '@/components/PageAlerts'
import { DisabledReason } from '@/components/DisabledReason'
import { useUrlParamState } from '@/hooks/useUrlParamState'
import { useUnsavedChangesGuard } from '@/contexts/UnsavedChangesContext'
import { useAuth } from '@/contexts/AuthContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useSocket } from '@/contexts/SocketContext'
import { cn } from '@/lib/utils'
import { CharacterImportExportDialog, type SavedCharacterExport } from '@/components/players/CharacterImportExportDialog'
import { CharacterTab } from '@/components/players/CharacterTab'
import { CharacterHintsBadge } from '@/components/players/CharacterHintsBadge'
import { useCharacterSheet } from '@/components/players/useCharacterSheet'

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
// server keeps up to 1000 connect/disconnect/death rows plus up to 5000
// moderator actions, see server/database/init.js). Shown as a hint
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

// The Moderation tab's tiles: the trigger's own content (a <button> wraps
// it), so the label and description are the button's accessible name.
function ActionTile({
  icon,
  label,
  description,
  disabled,
  emphasis = 'default',
}: {
  icon: React.ReactNode
  label: string
  description?: string
  disabled?: boolean
  emphasis?: 'default' | 'primary'
}) {
  const emphasisMap = {
    default: {
      base: 'border-border/60 bg-muted/25 hover:bg-accent/30 hover:border-border',
      iconWrap: 'border-border/60 bg-muted/40 text-muted-foreground group-hover:text-foreground',
    },
    primary: {
      base: 'border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/50',
      iconWrap: 'border-primary/30 bg-primary/10 text-primary',
    },
  }
  const e = emphasisMap[emphasis]
  return (
    <div
      className={cn(
        'group flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-start transition-colors',
        e.base,
        disabled ? 'opacity-50' : '',
      )}
    >
      <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-md border', e.iconWrap)}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-tight text-foreground">{label}</p>
        {/* line-clamp-2, not truncate: a one-line ellipsis cut real meaning
            out of short phrases in the narrow desktop grid (2026-08-31 visual
            sweep). Two lines fit every description these tiles carry. */}
        {description ? (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </div>
  )
}

// The roster card's lists, kept in ?list= so a reload or a link (Dashboard,
// the palette) opens the same one.
const ROSTER_LISTS = ['online', 'roster', 'banned', 'whitelist', 'activity'] as const
type RosterList = (typeof ROSTER_LISTS)[number]
// From lg up the lists scroll inside the card so the manual target stays in
// reach; below lg the page scrolls instead (no box-in-a-box on a phone).
const ROSTER_LIST_CLASS = 'mt-3 lg:max-h-[28rem] lg:overflow-y-auto lg:pe-1'

function activityBadgeVariant(action: string): 'success' | 'destructive' | 'warning' | 'secondary' {
  if (action === 'connect') return 'success'
  if (action === 'disconnect' || action === 'ban') return 'destructive'
  if (action === 'kick') return 'warning'
  return 'secondary'
}

// A name typed in the manual target box reaches the Character tab once the
// typing pauses this long: each keystroke would otherwise be a bridge read
// (B, Ba, Bar...). Moderation actions still use the name as typed, at once.
const MANUAL_TARGET_SETTLE_MS = 500

const DOSSIER_TABS = ['character', 'moderation', 'spawn', 'powers', 'notes'] as const
type DossierTab = (typeof DOSSIER_TABS)[number]
function isDossierTab(value: string | null): value is DossierTab {
  return value !== null && (DOSSIER_TABS as readonly string[]).includes(value)
}

// Notes are keyed by lower-cased name: the server matches a note's player
// case-insensitively (upsertPlayerNote), so "bob" must show, and save on top
// of, the note stored for "Bob" instead of an empty box that replaces it.
function noteKey(playerName: string): string {
  return playerName.toLowerCase()
}

export default function Players() {
  const { t } = useTranslation('players')
  const { formatDate, formatDateTime, formatTime } = useDateFormat()
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
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedPlayer = searchParams.get('player')?.trim() || ''
  const canModerate = can('players.moderate')
  const canViewCharacter = can('players.view')
  // The dossier's tabs follow ?tab= (a deep link can open one directly);
  // without it, moderators land on Moderation and everyone else on
  // Character, the one tab every players.view role can use. A role without
  // players.view can't read a character (403), so it keeps Moderation.
  const requestedTab = searchParams.get('tab')
  const activeTab: DossierTab = isDossierTab(requestedTab)
    ? requestedTab
    : canModerate || !canViewCharacter
      ? 'moderation'
      : 'character'
  const setActiveTab = useCallback(
    (value: string) => {
      if (!isDossierTab(value)) return
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous)
          next.set('tab', value)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )
  // Writes ?player= (replace: picking a player isn't a step Back should
  // walk through). Each event writes the URL once: setSearchParams builds on
  // the parameters of the last render, so a second write in the same event
  // would undo the first.
  const writePlayerParam = useCallback(
    (name: string) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous)
          if (name.trim()) next.set('player', name.trim())
          else next.delete('player')
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )
  // For the socket handler and the manual box's settle timer, which outlive
  // the render they were set up in.
  const writePlayerParamRef = useRef(writePlayerParam)
  useEffect(() => {
    writePlayerParamRef.current = writePlayerParam
  }, [writePlayerParam])
  const canGmTools = can('players.gm_tools')
  const [players, setPlayers] = useState<Player[]>([])
  const [perks, setPerks] = useState<PerkChoice[]>([])
  const [selectedPlayer, setSelectedPlayer] = useState<string>('')
  const [typingManualTarget, setTypingManualTarget] = useState(false)
  const [settledManualTarget, setSettledManualTarget] = useState('')
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
  // bug-hunt-2026-09-18 (round 21, UX follow-up): the dossier's own "Add to
  // Whitelist" menu item reuses this exact dialog/state (same
  // playersApi.addUser() call either way -- there is no separate
  // "whitelist an existing player" endpoint) rather than opening a second
  // one, but the dialog's title/description/submit label always said "Add
  // User" regardless of which entry point opened it -- reading as "create a
  // brand new account" even when the operator just picked an ALREADY-KNOWN
  // player from the dossier to whitelist. Defaults to the standalone
  // ActionTile's own framing; the dossier's "Add to Whitelist" click sets
  // this to 'addToWhitelist' before opening.
  const [addUserDialogMode, setAddUserDialogMode] = useState<'createAccount' | 'addToWhitelist'>('createAccount')
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

  // Character Export/Import dialog (its own state lives in the component)
  const [importExportOpen, setImportExportOpen] = useState(false)

  // Bridge status for character export/import
  const [bridgeConnected, setBridgeConnected] = useState(false)
  // Distinct from bridgeConnected itself: true until the first getStatus()
  // answer lands, so "haven't checked yet" doesn't render as the same
  // confident false as "checked, and it's offline" (bridge-tri-state sweep,
  // 2026-09-10). Gates DISPLAY text only -- every disabled={!bridgeConnected}
  // GM/export control stays fail-closed on the raw boolean, unchanged.
  const [bridgeStatusLoading, setBridgeStatusLoading] = useState(true)

  // Auto-export on login
  const [autoExportEnabled, setAutoExportEnabled] = useState(false)
  const [savedExports, setSavedExports] = useState<SavedCharacterExport[]>([])

  const searchInputRef = useRef<HTMLInputElement>(null)
  // Guards checkBridgeStatus's setState calls the same way Events.tsx's own
  // mountedRef does -- it's called from the 15s interval and the
  // activeServerChanged handler, both of which can fire after unmount.
  const mountedRef = useRef(true)

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
  // GET /players/notes returns the stored rows, which key the player as
  // snake_case `player_name` (database/init.js upsertPlayerNote); the page's
  // own state uses `playerName`.
  type PlayerNoteRow = Omit<PlayerNote, 'playerName'> & { playerName?: string; player_name?: string }
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

  // At-a-glance roster health -- PanelBridge.getAllPlayerDetails (the
  // PLURAL bulk endpoint; the Character tab reads one player at a time,
  // and only whoever is currently selected). Nothing else on this page or elsewhere reads it: the roster
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
  const [rosterList, setRosterList] = useUrlParamState<RosterList>('list', ROSTER_LISTS, 'online')
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
  // Staff levels (admin, moderator, gm, observer, a custom role with more
  // than login rights) run server console commands in game, so the server
  // also requires rcon.execute to grant one; a role without it is offered
  // the plain levels only (GET /access-levels' staffLevels).
  const [staffAccessLevels, setStaffAccessLevels] = useState<string[]>([])
  const canGrantStaffLevels = can('rcon.execute')
  const grantableAccessLevels = useMemo(
    () => canGrantStaffLevels
      ? accessLevelOptions
      : accessLevelOptions.filter(level => !staffAccessLevels.includes(level)),
    [accessLevelOptions, staffAccessLevels, canGrantStaffLevels],
  )
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

  // bug-hunt-2026-09-18 (round 9, activeServerChanged race sweep): fetchPlayers
  // runs both on a 15s poll (below) and on activeServerChanged, with no guard
  // against the two overlapping -- a poll tick for the server that was active
  // a moment ago, still in flight, could resolve AFTER the
  // activeServerChanged-triggered call for the NEW server and overwrite it.
  // playersGuard drops a response once a newer call has already started.
  const playersGuard = useRequestGuard()
  const fetchPlayers = useCallback(async () => {
    const requestId = playersGuard.next()
    try {
      const data = await playersApi.getPlayers({ retries: 0 })
      if (playersGuard.isStale(requestId)) return
      if (data.players) {
        setPlayers(data.players)
        setLastRefresh(new Date())
      }
      setPlayersLoadError(null)
    } catch (error) {
      if (playersGuard.isStale(requestId)) return
      reportClientError('Failed to fetch players.', error)
      setPlayersLoadError(getErrorMessage(error, t('loadErrors.players')))
    }
  }, [t, playersGuard])

  // Gated on players.gm_tools -- the same capability GET /panel-bridge/players
  // (the route getAllPlayerDetails lives behind) actually requires, not the
  // players.view the base roster list itself uses. Silent no-op on failure
  // (bridge down, permission denied): the roster still renders fine without
  // this, it just won't show the health/infection indicator.
  const vitalsGuard = useRequestGuard()
  const fetchRosterVitals = useCallback(async () => {
    const requestId = vitalsGuard.next()
    try {
      const res = await panelBridgeApi.getAllPlayerDetails()
      if (vitalsGuard.isStale(requestId)) return
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
  }, [vitalsGuard])

  // bridge-tri-state sweep (2026-09-10): this used to run once, inline in
  // the mount effect below, and never again -- unlike Events.tsx (10s
  // interval) and WorldMap.tsx (re-checked on its own poll), Players.tsx had
  // no way to notice the bridge connecting or dropping after mount. A GM
  // control or the import/export gate would stay stuck on the mount-time
  // read until the user navigated away and back. Extracted so the 15s
  // roster interval and the activeServerChanged handler can both call it,
  // matching the siblings.
  // A Moderator can't read GET /panel-bridge/status (bridge.setup or
  // bridge.diagnostics only); readBridgeLiveness() then asks the status every
  // role may read, so God mode and the other powers aren't greyed out.
  const canReadBridgeStatus = canReadFullBridgeStatus(can)
  const checkBridgeStatus = useCallback(async () => {
    try {
      const live = await readBridgeLiveness(canReadBridgeStatus)
      if (mountedRef.current) setBridgeConnected(live.modConnected && live.isRunning)
    } catch {
      if (mountedRef.current) setBridgeConnected(false)
    } finally {
      if (mountedRef.current) setBridgeStatusLoading(false)
    }
  }, [canReadBridgeStatus])

  // 2026-09-08 (retry-stacking sweep): `manual` covers the Retry button,
  // the Enter-key filter search, and the filter button's own RefreshCw icon
  // -- all three are a human explicitly asking for a fresh/filtered fetch
  // right now. The Notes/Log tab's own load when it opens (the effect below)
  // is left on the default: opening a tab is navigation loading its content,
  // not a human retrying or refreshing something already on screen.
  //
  // The log is per server: a response for the server that was active when it
  // was requested must not land after a switch (activityGuard, same shape as
  // playersGuard above).
  const activityGuard = useRequestGuard()
  const fetchActivityLogs = useCallback(async (playerFilter?: string, opts?: { manual?: boolean }) => {
    const requestId = activityGuard.next()
    setLogsLoading(true)
    try {
      const data = await playersApi.getActivityLogs(
        playerFilter,
        ACTIVITY_LOG_FETCH_LIMIT,
        opts?.manual ? { retries: 0 } : undefined,
      )
      if (activityGuard.isStale(requestId)) return
      if (data.logs) {
        setActivityLogs(data.logs)
      }
      setLogsError(null)
    } catch (error) {
      if (activityGuard.isStale(requestId)) return
      reportClientError('Failed to fetch activity logs.', error)
      setLogsError(getErrorMessage(error, t('loadErrors.activityLogs')))
    } finally {
      if (!activityGuard.isStale(requestId)) setLogsLoading(false)
    }
  }, [t, activityGuard])

  // The Activity list reads the log whenever it opens, however it opens: a
  // click, the keyboard, or ?list=activity on a reload or Back (the list
  // follows the URL, so a trigger's onClick alone left it empty there).
  useEffect(() => {
    if (rosterList === 'activity') void fetchActivityLogs()
  }, [rosterList, fetchActivityLogs])

  // 2026-09-08 (retry-stacking sweep): `manual` gates only the notes tab's
  // own Retry button -- mount and the server-change handler keep the
  // default automatic retry.
  //
  // Playtime (the stats half) is per server, so this is guarded like the
  // roster (notesGuard): the answer for the server that was active when it
  // was requested must not overwrite the new server's.
  const notesGuard = useRequestGuard()
  const fetchNotesAndStats = useCallback(async (opts?: { manual?: boolean }) => {
    const requestId = notesGuard.next()
    const retries = opts?.manual ? { retries: 0 } : undefined
    setNotesLoading(true)
    try {
      const [notesData, statsData] = await Promise.all([
        playersApi.getNotes(retries),
        playersApi.getStats(retries)
      ])
      if (notesGuard.isStale(requestId)) return
      // Convert arrays to lookup objects
      const notesMap: Record<string, PlayerNote> = {}
      if (notesData.notes) {
        notesData.notes.forEach((n: PlayerNoteRow) => {
          const key = n.playerName ?? n.player_name
          if (key) notesMap[noteKey(key)] = { ...n, playerName: key }
        })
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
      if (notesGuard.isStale(requestId)) return
      reportClientError('Failed to fetch notes and stats.', error)
      setNotesError(getErrorMessage(error, t('loadErrors.notesAndStats')))
    } finally {
      if (!notesGuard.isStale(requestId)) setNotesLoading(false)
    }
  }, [t, notesGuard])

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
        [noteKey(selectedPlayer)]: {
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
        delete updated[noteKey(selectedPlayer)]
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

  // 2026-09-08 (retry-stacking sweep): `manual` gates only the error
  // banner's Retry button, the sole human-initiated caller -- mount is the
  // only other one and keeps the default automatic retry.
  const fetchData = useCallback(async (opts?: { manual?: boolean }) => {
    try {
      const perksData = await playersApi.getPerks(opts?.manual ? { retries: 0 } : undefined)
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

  // The SteamID ban list is per server too (bansGuard).
  const bansGuard = useRequestGuard()
  const fetchBannedSteamIds = useCallback(async () => {
    const requestId = bansGuard.next()
    setLoadingBans(true)
    try {
      const res = await playersApi.getSteamIdBans()
      if (bansGuard.isStale(requestId)) return
      setBannedSteamIds(res.bans || [])
    } catch {
      // Silently fail — list will be empty, manual input still works
    } finally {
      if (!bansGuard.isStale(requestId)) setLoadingBans(false)
    }
  }, [bansGuard])

  // bug-hunt-2026-09-18 (round: whitelist/access-level/admin accounts):
  // same shape as fetchPlayers' own playersGuard above -- fetchWhitelist
  // runs both on mount and on activeServerChanged (see that handler below),
  // with nothing stopping a slow mount-time load (or a manual Refresh click
  // for the server that was active a moment ago) from resolving AFTER the
  // activeServerChanged-triggered call for the NEW server and silently
  // reverting the roster back to the OLD server's whitelist. A separate
  // guard instance from playersGuard, per useRequestGuard's own contract --
  // this is an independent fetch stream and must not share staleness state.
  //
  // 2026-09-08 (retry-stacking sweep): `manual` distinguishes the page
  // header's Refresh button (the only human-initiated caller of this
  // function) from mount, server-change, and post-action refreshes -- see
  // Servers.tsx's fetchServers() for the full reasoning.
  const whitelistGuard = useRequestGuard()
  const fetchWhitelist = useCallback(async (opts?: { manual?: boolean }) => {
    const requestId = whitelistGuard.next()
    setWhitelistLoading(true)
    try {
      const result = await playersApi.getWhitelist(opts?.manual ? { retries: 0 } : undefined)
      if (whitelistGuard.isStale(requestId)) return
      setWhitelistAccounts(result.accounts || [])
      setAllowedSteamIds(result.allowedSteamIds || [])
      setWhitelistAvailable(result.available !== false)
      setWhitelistError(result.available === false ? result.reason || t('loadErrors.whitelistUnavailableFallback') : null)
    } catch (error) {
      if (whitelistGuard.isStale(requestId)) return
      reportClientError('Failed to fetch whitelist accounts.', error)
      setWhitelistError(getErrorMessage(error, t('loadErrors.whitelist')))
    } finally {
      if (!whitelistGuard.isStale(requestId)) setWhitelistLoading(false)
    }
  }, [t, whitelistGuard])

  // The access levels come from the active server's own role table
  // (accessLevelsGuard).
  const accessLevelsGuard = useRequestGuard()
  const fetchAccessLevels = useCallback(async () => {
    const requestId = accessLevelsGuard.next()
    try {
      const result = await playersApi.getAccessLevels()
      if (accessLevelsGuard.isStale(requestId)) return
      setAccessLevelOptions(result.levels || [])
      setStaffAccessLevels(Array.isArray(result.staffLevels) ? result.staffLevels : [])
    } catch (error) {
      if (accessLevelsGuard.isStale(requestId)) return
      reportClientError('Failed to fetch access levels.', error)
    }
  }, [accessLevelsGuard])

  useEffect(() => {
    mountedRef.current = true
    Promise.all([fetchPlayers(), fetchData(), fetchNotesAndStats(), fetchBannedSteamIds(), fetchWhitelist(), fetchAccessLevels()]).catch(err => {
      reportClientError('Failed to load initial player data.', err)
    })
    // Check bridge status for character export/import
    checkBridgeStatus()
    // Load auto-export setting
    configApi.getAppSettings().then(response => {
      if (mountedRef.current && response?.settings) {
        setAutoExportEnabled(response.settings.autoExportOnLogin === true || response.settings.autoExportOnLogin === 'true')
      }
    }).catch(() => {})
    // Load saved exports
    playersApi.getExports().then(response => {
      if (mountedRef.current && response?.exports) setSavedExports(response.exports)
    }).catch(() => {})
    if (canGmTools) fetchRosterVitals()
    const interval = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      fetchPlayers()
      checkBridgeStatus()
      if (canGmTools) fetchRosterVitals()
    }, 15000)
    return () => {
      mountedRef.current = false
      clearInterval(interval)
    }
  }, [fetchPlayers, fetchData, fetchNotesAndStats, fetchBannedSteamIds, fetchWhitelist, fetchAccessLevels, fetchRosterVitals, checkBridgeStatus, canGmTools])

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
  //
  // Everything the page holds about the OLD server is dropped first: the
  // selected player (and with it the open dialogs' targets), the GM-power
  // badges kept per player NAME (a same-named player on the new server would
  // show the old one's God/Invisible), the vitals, playtime, SteamID bans,
  // whitelist and the activity log. The log is refetched at once when its list
  // is open (otherwise when the list opens).
  const rosterListRef = useRef(rosterList)
  const logPlayerFilterRef = useRef(logPlayerFilter)
  useEffect(() => {
    rosterListRef.current = rosterList
    logPlayerFilterRef.current = logPlayerFilter
  }, [rosterList, logPlayerFilter])
  useEffect(() => {
    if (!socket) return
    const handleActiveServerChanged = () => {
      setSelectedPlayer('')
      writePlayerParamRef.current('')
      // The player dialogs live at the page root now: close them with the
      // selection, or Kick/Ban would sit open with no name, doing nothing.
      setKickDialogOpen(false)
      setBanDialogOpen(false)
      setBanConfirmOpen(false)
      setTeleportDialogOpen(false)
      setTypingManualTarget(false)
      setSettledManualTarget('')
      setPlayers([])
      setPlayerPowers({})
      setRosterVitals({})
      setPlayerStats({})
      setBannedSteamIds([])
      setWhitelistAccounts([])
      setAllowedSteamIds([])
      setActivityLogs([])
      setLogsError(null)
      activityGuard.next()
      if (rosterListRef.current === 'activity') void fetchActivityLogs(logPlayerFilterRef.current || undefined)
      fetchPlayers()
      fetchNotesAndStats()
      fetchBannedSteamIds()
      fetchWhitelist()
      fetchAccessLevels()
      checkBridgeStatus()
      if (canGmTools) fetchRosterVitals()
    }
    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, fetchPlayers, fetchNotesAndStats, fetchBannedSteamIds, fetchWhitelist, fetchAccessLevels, fetchRosterVitals, fetchActivityLogs, activityGuard, checkBridgeStatus, canGmTools])

  // ?player= opens a player (a link from the World Map, Chat or the
  // Leaderboard) and follows the selection, so a reload or a shared link
  // lands on the same one. The URL is written where the selection changes
  // (selectPlayer, the manual box once its typing settles) rather than from
  // an effect, so a deep link can't be wiped before it is read. This effect
  // only reacts when the parameter itself changes: a name half-typed in the
  // manual box must not be pulled back to the one still in the URL.
  const appliedPlayerParamRef = useRef<string | null>(null)
  useEffect(() => {
    if (initialLoading) return
    if (appliedPlayerParamRef.current === requestedPlayer) return
    appliedPlayerParamRef.current = requestedPlayer
    if (!requestedPlayer || requestedPlayer === selectedPlayer.trim()) return
    const matchingPlayer = players.find((player) => player.name.toLowerCase() === requestedPlayer.toLowerCase())
    setTypingManualTarget(false)
    setSelectedPlayer(matchingPlayer?.name || requestedPlayer)
  }, [initialLoading, players, requestedPlayer, selectedPlayer])

  // Load note/tags when selected player changes
  useEffect(() => {
    const existing = selectedPlayer ? playerNotes[noteKey(selectedPlayer)] : undefined
    if (existing) {
      setCurrentNote(existing.note)
      setCurrentTags(existing.tags || [])
    } else {
      setCurrentNote('')
      setCurrentTags([])
    }
  }, [selectedPlayer, playerNotes])

  // The dialogs' own inputs belong to the player they were filled in for. The
  // teleport target, the chosen access level and the voice-ban name are kept
  // while a dialog is closed again without submitting, so without this the
  // NEXT player's dialog opened pre-filled with the previous player's target
  // (heading Bob, teleport Alice) or with the level last granted (Set enabled,
  // already on "admin"). The character export has the same reset in
  // CharacterImportExportDialog.
  useEffect(() => {
    setTeleportTarget('')
    setAccessLevel('')
    setVoiceBanUsername('')
  }, [selectedPlayer])

  // `fn` normally resolves to something the caller doesn't inspect (kick,
  // ban, teleport, etc. -- unrelated to bridge verification). A handler that
  // DOES need to override the generic success toast (the godmode/invisible/
  // noclip/teleport bridge actions below, when the mod couldn't confirm the
  // change) resolves to `{ toastOverride }` instead -- runtime-checked here
  // rather than widening `fn`'s type, so every other caller is unaffected.
  // bug-hunt-2026-09-18 (round 21, UX follow-up): the generic success toast
  // used to say only "{{action}} completed" -- correct, but silent about
  // WHICH player it happened to, on a page whose whole job is acting on
  // one player at a time. `player` is optional (a create-a-new-account
  // action like Add User, or the rare handleAction call with no single
  // clear target, can omit it) and purely additive: every existing caller
  // that doesn't pass one keeps the exact prior toast text.
  const handleAction = async (
    action: string,
    fn: () => Promise<unknown>,
    closeDialog?: () => void,
    player?: string,
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
          description: player
            ? t('toasts.successDescForPlayer', { action, player })
            : t('toasts.successDesc', { action }),
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
      selectPlayer('')
      searchInputRef.current?.focus()
    }, selectedPlayer)
  }

  const handleBan = () => {
    if (!selectedPlayer) return
    handleAction(t('actions.banPlayer'), () => playersApi.ban(selectedPlayer, banIp, banReason), () => {
      setBanDialogOpen(false)
      setBanConfirmOpen(false)
      setBanReason('')
      setBanIp(false)
      selectPlayer('')
      searchInputRef.current?.focus()
    }, selectedPlayer)
  }

  const handleUnban = () => {
    if (!unbanUsername) return
    handleAction(t('actions.unbanPlayer'), () => playersApi.unban(unbanUsername), () => {
      setUnbanUsername('')
      setUnbanDialogOpen(false)
    }, unbanUsername)
  }

  const handleUnbanSteamId = () => {
    if (!unbanSteamId) return
    handleAction(t('actions.unbanSteamId'), () => playersApi.unbanSteamId(unbanSteamId), () => {
      setUnbanSteamId('')
      setUnbanSteamIdDialogOpen(false)
      setBannedSteamIds(prev => prev.filter(b => b.steamId !== unbanSteamId))
    }, unbanSteamId)
  }

  // Builds the { toastOverride } handleAction reads instead of its default
  // success toast, for a bridge-verify-gated action that came back
  // 'unverifiable' or 'old-bridge'. 'confirmed' and null (action isn't
  // verify-gated at all) both return undefined -- no override, plain
  // success toast, exactly as before this fix.
  const bridgeVerifyToastOverride = (actionLabel: string, actionKey: string, data: unknown) => {
    const responseData = data as { verified?: unknown; clientSync?: unknown } | null | undefined
    if (responseData?.clientSync === 'requested') {
      return {
        toastOverride: {
          title: actionLabel,
          description: t('toasts.bridgeUnverifiedDesc', { action: actionLabel }),
          variant: 'default' as const,
        },
      }
    }
    const state = getBridgeVerifiedState(actionKey, responseData)
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
    }, target)
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
    }, steamId)
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
    }, addUserUsername.trim())
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
    }, steamId)
  }

  // continuous-bug-hunt round 29 (card: guard-against-removing-last-admin):
  // server/routes/players.js's POST /access-level refuses a demotion away
  // from admin for a local server's only admin account UNLESS the request
  // carries confirm: true, returning PLAYERS_LAST_ADMIN_ACCESS_LEVEL_CONFIRM
  // so this can ask first rather than silently going through -- same
  // confirm-then-retry shape as RolesPermissions.tsx's
  // ROLE_SELF_CAPABILITY_LOSS_CONFIRM handling. Not routed through
  // handleAction: a cancelled confirm must not surface as a failure toast,
  // and handleAction has no hook for "the user said no, say nothing".
  const handleSetAccessLevel = async (confirmOverride = false) => {
    if (!selectedPlayer || !accessLevel) return
    setLoading(true)
    try {
      await playersApi.setAccessLevel(selectedPlayer, accessLevel, confirmOverride)
      toast({
        title: t('toasts.successTitle'),
        description: t('toasts.successDescForPlayer', { action: t('actions.setAccessLevel'), player: selectedPlayer }),
        variant: 'success' as const,
      })
      fetchPlayers()
    } catch (error) {
      if (!confirmOverride && error instanceof ApiError && error.code === 'PLAYERS_LAST_ADMIN_ACCESS_LEVEL_CONFIRM') {
        setLoading(false)
        const ok = await confirm({
          title: t('confirmLastAdmin.title'),
          description: t('confirmLastAdmin.description', { player: selectedPlayer }),
          confirmLabel: t('confirmLastAdmin.confirm'),
          cancelLabel: t('confirmLastAdmin.cancel'),
        })
        if (ok) await handleSetAccessLevel(true)
        return
      }
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('toasts.actionFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
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
    handleAction(t('actions.addXp'), () => playersApi.addXp(selectedPlayer, selectedPerk, xpAmount), undefined, selectedPlayer)
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
    }, undefined, player)
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
    }, undefined, player)
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
    }, undefined, player)
  }

  const handleHealPlayer = () => {
    const player = selectedPlayer
    if (!player) return
    handleAction(t('actions.healPlayer'),
      async () => {
        await panelBridgeApi.sendCommand('healPlayer', { username: player })
      }, undefined, player)
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
      }, undefined, player)
  }

  // Get selected player's current powers
  const selectedPlayerPowers = useMemo(() =>
    selectedPlayer ? playerPowers[selectedPlayer] : null,
    [selectedPlayer, playerPowers]
  )

  // The Character tab's player: the selection, except while a name is being
  // typed in the manual box, when it keeps the one before until the typing
  // settles (MANUAL_TARGET_SETTLE_MS).
  useEffect(() => {
    if (!typingManualTarget) return
    const timer = setTimeout(() => {
      setSettledManualTarget(selectedPlayer)
      setTypingManualTarget(false)
      writePlayerParamRef.current(selectedPlayer)
    }, MANUAL_TARGET_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [typingManualTarget, selectedPlayer])
  const characterTarget = typingManualTarget ? settledManualTarget : selectedPlayer
  // Every selection that isn't typing in the manual box: a roster or activity
  // row, a deselect after Kick or Ban.
  const selectPlayer = (name: string) => {
    setTypingManualTarget(false)
    setSelectedPlayer(name)
    writePlayerParam(name)
  }
  // On a phone the player card sits under the lists: bring it into view, or
  // the click seems to do nothing.
  const playerCardRef = useRef<HTMLDivElement>(null)
  const revealPlayerCard = () => {
    if (typeof window.matchMedia !== 'function') return
    if (!window.matchMedia('(max-width: 1023px)').matches) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    requestAnimationFrame(() => {
      playerCardRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
    })
  }
  // A roster click selects at once, even mid-typing.
  const pickRosterPlayer = (name: string) => {
    selectPlayer(name)
    revealPlayerCard()
  }
  // The bridge finds a player whatever the case of the name, so a typed
  // "bob" is the online Bob.
  const isCharacterTargetOnline = useMemo(() => {
    const lower = characterTarget.toLowerCase()
    return !!characterTarget && players.some(p => p.name.toLowerCase() === lower)
  }, [characterTarget, players])

  // Character tab data. Lifted here so the dossier's "Worth a look" badge
  // counts on every tab; it polls only while the Character tab is open (the
  // old Vitals poll ran on every tab).
  const characterSheet = useCharacterSheet({
    username: canViewCharacter ? characterTarget : '',
    online: isCharacterTargetOnline,
    active: activeTab === 'character',
  })

  const selectedPlayerConfirmedNotWhitelisted = useMemo(() =>
    isPlayerConfirmedNotWhitelisted(selectedPlayer, whitelistAccounts, whitelistLoading, whitelistError),
    [selectedPlayer, whitelistAccounts, whitelistLoading, whitelistError]
  )

  // Ignoring case like the Character tab: a typed "bob" is the online "Bob",
  // and the map link uses the roster's spelling.
  const selectedOnlineName = selectedPlayer
    ? players.find(p => p.name.toLowerCase() === selectedPlayer.toLowerCase())?.name
    : undefined
  const selectedIsOnline = !!selectedOnlineName
  const selectedNote = selectedPlayer ? playerNotes[noteKey(selectedPlayer)] : undefined
  const selectedStat = selectedPlayer ? playerStats[selectedPlayer] : undefined
  const selectedHasPowers = !!selectedPlayerPowers && (selectedPlayerPowers.godMode || selectedPlayerPowers.invisible || selectedPlayerPowers.noclip)

  // An admin note or tags typed but not saved: leaving the page asks first
  // (in-app links, the palette, a reload or closing the tab).
  const noteDirty = !!selectedPlayer && (
    currentNote.trim() !== (selectedNote?.note ?? '').trim() ||
    currentTags.join('\n') !== (selectedNote?.tags ?? []).join('\n')
  )
  // Only a role that can save a note (players.moderate) can hold unsaved
  // edits: the note box is read-only for the others.
  useUnsavedChangesGuard(canModerate && noteDirty)

  // Switching lists re-reads the ones that change behind the page's back
  // (the bans and the whitelist), as the old tab buttons did.
  //
  // A mouse click on a list tab reports the switch twice: Radix's trigger
  // focuses itself on mousedown, its focus handler (automatic activation)
  // still sees the tab unselected and switches, then mousedown switches
  // again -- both before a re-render. Each switch fetched, so every click
  // on Banned or Whitelist read that list twice and showed whichever
  // answer the request guard kept. The same switch within one event counts
  // once; a later click on the list already shown still re-reads it.
  const listSwitchInEvent = useRef<RosterList | null>(null)
  const changeList = (next: RosterList) => {
    if (listSwitchInEvent.current === next) return
    listSwitchInEvent.current = next
    queueMicrotask(() => { listSwitchInEvent.current = null })
    setRosterList(next)
    if (next === 'banned') void fetchBannedSteamIds()
    if (next === 'whitelist') void fetchWhitelist()
  }

  const rosterListTabs: { id: RosterList; label: string; count?: number }[] = [
    { id: 'online', label: t('roster.tabOnline'), count: players.length },
    { id: 'roster', label: t('roster.tabRoster'), count: offlineRoster.length },
    { id: 'banned', label: t('roster.tabBanned'), count: bannedSteamIds.length },
    { id: 'whitelist', label: t('roster.tabWhitelist'), count: whitelistAccounts.length },
    { id: 'activity', label: t('roster.tabActivity') },
  ]
  const rosterSearchPlaceholder = {
    online: t('roster.searchOnline'),
    roster: t('roster.searchRoster'),
    banned: t('roster.searchBanned'),
    whitelist: t('roster.searchWhitelist'),
    activity: t('notes.filterPlaceholder'),
  }[rosterList]

  // The search box filters the log rows already loaded; reloadActivity asks
  // the server for that name too, past the newest ACTIVITY_LOG_FETCH_LIMIT.
  const filteredActivity = useMemo(() => {
    const search = playerSearchFilter.trim().toLowerCase()
    if (!search) return activityLogs
    return activityLogs.filter(log =>
      [log.player_name, log.action, log.details]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(search)),
    )
  }, [activityLogs, playerSearchFilter])
  const reloadActivity = () => {
    const query = playerSearchFilter.trim()
    setLogPlayerFilter(query)
    void fetchActivityLogs(query || undefined, { manual: true })
  }

  const statItems: StatStripItem[] = [
    {
      id: 'online',
      label: t('summary.online'),
      value: players.length,
      icon: Users,
      tone: players.length > 0 ? 'success' : 'default',
      onClick: () => changeList('online'),
    },
    { id: 'peak', label: t('summary.peakToday'), value: peakPlayers, icon: TrendingUp },
    {
      id: 'roster',
      label: t('summary.roster'),
      value: offlineRoster.length,
      detail: t('summary.rosterDetail'),
      icon: History,
      onClick: () => changeList('roster'),
    },
    {
      id: 'banned',
      label: t('summary.bannedLabel'),
      value: bannedSteamIds.length,
      icon: Ban,
      tone: bannedSteamIds.length > 0 ? 'danger' : 'default',
      onClick: () => changeList('banned'),
      ariaLabel: t('summary.bannedAria', { count: bannedSteamIds.length }),
    },
  ]

  // Actions that take any name, not the selected player: one home, in the
  // header's "More" menu. RowActions runs onSelect only for an enabled item;
  // each still checks its capability first, like the dossier menu.
  const noModerateReason = !canModerate ? t('permissions.noModerate') : undefined
  const headerMenuItems: RowActionItem[] = [
    {
      label: t('headerMenu.addWhitelistUser'),
      icon: UserPlus,
      disabled: !canModerate,
      reason: noModerateReason,
      onSelect: () => {
        if (!canModerate) return
        setAddUserDialogMode('createAccount')
        setAddUserDialogOpen(true)
      },
    },
    {
      label: t('headerMenu.unban'),
      icon: UserCheck,
      disabled: !canModerate,
      reason: noModerateReason,
      onSelect: () => {
        if (!canModerate) return
        setUnbanDialogOpen(true)
      },
    },
    {
      label: t('headerMenu.unbanSteamId'),
      icon: UserCheck,
      disabled: !canModerate,
      reason: noModerateReason,
      onSelect: () => {
        if (!canModerate) return
        void fetchBannedSteamIds()
        setUnbanSteamIdDialogOpen(true)
      },
    },
    {
      label: t('headerMenu.voiceBan'),
      icon: MicOff,
      disabled: !canModerate,
      reason: noModerateReason,
      onSelect: () => {
        if (!canModerate) return
        setVoiceBanDialogOpen(true)
      },
    },
    {
      label: t('headerMenu.banSteamId'),
      icon: Ban,
      destructive: true,
      disabled: !canModerate,
      reason: noModerateReason,
      onSelect: () => {
        if (!canModerate) return
        setSteamIdBanDialogOpen(true)
      },
    },
  ]

  const [bridgeAlertDismissed, setBridgeAlertDismissed] = useState(false)
  const pageAlerts: PageAlert[] = []
  if (playersLoadError || toolsLoadError) {
    pageAlerts.push({
      id: 'load-error',
      tone: 'error',
      title: t('errorBanner.title'),
      description: <span className="break-words">{playersLoadError || toolsLoadError}</span>,
      action: {
        label: t('errorBanner.retry'),
        onClick: () => {
          fetchPlayers()
          fetchData({ manual: true })
        },
      },
    })
  }
  // Only for a role that could use what the bridge powers, and only once the
  // first status read is back (not while it is still unknown).
  if (canGmTools && !bridgeStatusLoading && !bridgeConnected && !bridgeAlertDismissed) {
    pageAlerts.push({
      id: 'bridge-offline',
      tone: 'info',
      title: t('alerts.bridgeOfflineTitle'),
      description: t('alerts.bridgeOfflineDesc'),
      action: { label: t('alerts.bridgeOfflineAction'), to: '/settings?tab=bridge' },
      onDismiss: () => setBridgeAlertDismissed(true),
    })
  }

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
        status={lastRefresh ? (
          <span className="text-xs text-muted-foreground">
            {t('pageHeader.updated', { time: formatTime(lastRefresh, { seconds: true }) })}
          </span>
        ) : undefined}
        actions={
          <>
            <Button
              variant="ghost"
              size="iconDense"
              onClick={() => { fetchPlayers(); void fetchWhitelist({ manual: true }) }}
              aria-label={t('pageHeader.refresh')}
              title={t('pageHeader.refresh')}
            >
              <RefreshCw aria-hidden="true" />
            </Button>
            <RowActions ariaLabel={t('pageHeader.moreActions')} items={headerMenuItems} />
          </>
        }
      />

      <PageAlerts alerts={pageAlerts} />

      <StatStrip items={statItems} />

      {/* From xl the lists get a fixed 25rem, wide enough for the five
          list tabs on one row; between lg and xl a third of the width. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 xl:grid-cols-[25rem_minmax(0,1fr)]">
        {/* The lists: who is online, who has been seen before, the SteamID
            bans, the whitelist and the server's activity log. */}
        <SectionCard title={t('roster.headerLabel')} density="compact" className="lg:col-span-1">
          <Tabs value={rosterList} onValueChange={(value) => changeList(value as RosterList)}>
            <TabsList aria-label={t('roster.listsAria')} className="flex h-auto w-full flex-wrap gap-1">
              {rosterListTabs.map((tab) => (
                <TabsTrigger key={tab.id} value={tab.id} className="flex-1 gap-1.5 px-2 text-xs">
                  <span>{tab.label}</span>
                  {tab.count !== undefined && (
                    <>
                      {' '}
                      <span className="tabular-nums text-muted-foreground">{tab.count}</span>
                    </>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
            <Toolbar
              className="mt-3"
              search={{
                value: playerSearchFilter,
                onChange: setPlayerSearchFilter,
                placeholder: rosterSearchPlaceholder,
                ariaLabel: t('roster.searchAria'),
                inputRef: searchInputRef,
                slashToFocus: true,
              }}
            />
            <TabsContent value="online" className={ROSTER_LIST_CLASS}>{
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
                      <Button variant="ghost" size="sm" className="mt-4 text-xs text-muted-foreground" onClick={() => changeList('roster')}>
                        <Users className="me-1.5 h-3.5 w-3.5" />
                        {t('roster.seePreviouslySeen', { count: offlineRoster.length })}
                      </Button>
                    )}
                    {bannedSteamIds.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-1 text-xs text-muted-foreground"
                        onClick={() => changeList('banned')}
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
                      const note = playerNotes[noteKey(player.name)]
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
                          onClick={() => pickRosterPlayer(player.name)}
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
                                    vitals.health >= 60 ? 'text-success' : vitals.health >= 30 ? 'text-warning' : 'text-destructive',
                                  )}
                                  title={t('roster.rosterHealthTooltip', { health: Math.round(vitals.health) })}
                                >
                                  <Heart className="w-3 h-3" />
                                  {Math.round(vitals.health)}%
                                </span>
                              )}
                              {vitals?.isInfected && (
                                <Skull className="w-3 h-3 text-destructive me-1" aria-label={t('character.condition.infected')} />
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
            }</TabsContent>

            <TabsContent value="roster" className={ROSTER_LIST_CLASS}>{
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
                      const note = playerNotes[noteKey(name)]
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
                          onClick={() => pickRosterPlayer(name)}
                          title={t('roster.lastSeenTitle', { when: lastSeen ? formatDateTime(lastSeen, { seconds: true }) : t('roster.lastSeenUnknown') })}
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
                                <span className="text-xs text-muted-foreground">
                                  {formatDate(lastSeen)}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )
            }</TabsContent>

            <TabsContent value="banned" className={ROSTER_LIST_CLASS}>{
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
                              <p className="text-xs text-muted-foreground truncate" title={ban.reason || ''}>
                                {ban.reason ? `\u201c${ban.reason}\u201d` : ''}
                                {ban.reason && ban.banned_at ? ' \u00b7 ' : ''}
                                {formatDate(ban.banned_at)}
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
            }</TabsContent>

            <TabsContent value="whitelist" className={ROSTER_LIST_CLASS}>{
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
                              <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                                {account.steamId && <span className="font-mono">{account.steamId}</span>}
                                {account.lastConnection && <span>{t('roster.whitelistLastConnection', { date: formatDate(account.lastConnection) })}</span>}
                                <span>{online ? t('roster.whitelistOnline') : t('roster.whitelistOffline')}</span>
                              </div>
                            </div>
                            <DisabledReason reason={!canModerate ? t('permissions.noModerate') : null}>
                            <Button
                              variant="outline"
                              size="sm"
                              className="shrink-0"
                              onClick={async () => {
                                const confirmed = await confirm({
                                  title: t('roster.removeFromWhitelistConfirmTitle'),
                                  description: t('roster.removeFromWhitelistConfirmDesc', { player: account.username }),
                                  confirmLabel: t('roster.removeFromWhitelistConfirmButton'),
                                  destructive: true,
                                })
                                if (!confirmed) return
                                void handleAction(t('actions.removeFromWhitelist'), () => playersApi.removeFromWhitelist(account.username), () => { void fetchWhitelist() }, account.username)
                              }}
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
              }

              {whitelistAvailable && !whitelistLoading && (
                <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                  <div className="flex items-center justify-between">
                    <span className="label-micro">{t('roster.allowedSteamIdsLabel')}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{allowedSteamIds.length}</span>
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
                        onClick={async () => {
                          const confirmed = await confirm({
                            title: t('roster.removeAllowedSteamIdConfirmTitle'),
                            description: t('roster.removeAllowedSteamIdConfirmDesc', { steamId }),
                            confirmLabel: t('roster.removeAllowedSteamIdConfirmButton'),
                            destructive: true,
                          })
                          if (!confirmed) return
                          void handleAction(t('actions.removeAllowedSteamId'), () => playersApi.removeAllowedSteamId(steamId), () => { void fetchWhitelist() }, steamId)
                        }}
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
            </TabsContent>

            {/* The server's activity log: connections, deaths and moderation
                actions. A row opens that player. The search box filters the
                rows already loaded; "Search the full log" asks the server for
                that name, past the newest ACTIVITY_LOG_FETCH_LIMIT rows. */}
            <TabsContent value="activity" className={cn(ROSTER_LIST_CLASS, 'space-y-3')}>
              {logsError && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>{t('notes.logsErrorTitle')}</AlertTitle>
                  <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <span className="min-w-0 break-words">{logsError}</span>
                    <Button variant="outline" size="sm" onClick={reloadActivity} className="self-start">
                      <RefreshCw className="me-2 h-4 w-4" /> {t('notes.retry')}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
              <Button variant="outline" size="sm" onClick={reloadActivity} disabled={logsLoading} className="w-full sm:w-auto">
                {logsLoading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                {playerSearchFilter.trim() ? t('roster.activitySearchAll') : t('roster.activityReload')}
              </Button>
              {filteredActivity.length === 0 ? (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                  {logsLoading
                    ? t('notes.loadingRow')
                    : activityLogs.length > 0
                      ? t('roster.rosterEmptySearchTitle')
                      : t('notes.noLogsRow')}
                </p>
              ) : (
                <ul className="divide-y divide-border/50" aria-label={t('notes.activityLogTitle')}>
                  {filteredActivity.map((log) => (
                    <li key={log.id}>
                      <button
                        type="button"
                        onClick={() => pickRosterPlayer(log.player_name)}
                        className="w-full rounded-md px-2 py-2.5 text-start transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-sm font-medium">{log.player_name}</span>
                          <Badge variant={activityBadgeVariant(log.action)} className="shrink-0 text-xs">
                            {log.action}
                          </Badge>
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {formatDateTime(log.logged_at, { seconds: true })}
                        </span>
                        {log.details && (
                          <span className="mt-0.5 block break-words text-xs text-muted-foreground">{log.details}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {activityLogs.length >= ACTIVITY_LOG_FETCH_LIMIT && (
                <p className="text-xs text-muted-foreground">
                  {t('notes.activityLogTruncatedHint', { count: activityLogs.length })}
                </p>
              )}
            </TabsContent>
          </Tabs>

          {/* Manual entry: for a player who is offline or not listed. */}
          <div className="space-y-1.5 border-t border-border/60 pt-4">
            <Label htmlFor="players-manual-target">{t('roster.manualTargetLabelText')}</Label>
            <Input
              id="players-manual-target"
              placeholder={t('roster.manualTargetPlaceholder')}
              value={selectedPlayer}
              onChange={(e) => {
                if (!typingManualTarget) setSettledManualTarget(selectedPlayer)
                setTypingManualTarget(true)
                setSelectedPlayer(e.target.value)
              }}
              autoComplete="off"
              spellCheck={false}
              className="h-9 text-sm"
            />
          </div>
        </SectionCard>

        {/* The selected player: who they are, Kick and Ban next to the name,
            then their tools. Nothing selected: one prompt, no empty tabs. */}
        <div ref={playerCardRef} className="scroll-mt-20 lg:col-span-2 xl:col-span-1">
          {!selectedPlayer ? (
            <div className="rounded-xl border border-dashed border-border/60 bg-card">
              {/* Not type="noPlayers": its "No players online" label would
                  contradict the roster right beside it. */}
              <EmptyState
                compact
                type="noData"
                icon={<Users className="h-10 w-10 text-muted-foreground/40" />}
                title={t('dossier.noTargetTitle')}
                description={t('dossier.noTargetDesc')}
              />
            </div>
          ) : (
            <SectionCard
              title={selectedPlayer}
              status={
                <>
                  <StatusPill
                    size="sm"
                    tone={selectedIsOnline ? 'ok' : 'idle'}
                    label={selectedIsOnline ? t('dossier.online') : t('dossier.offline')}
                  />
                  <CharacterHintsBadge hints={characterSheet.base?.hints} onOpen={() => setActiveTab('character')} />
                </>
              }
              description={
                <div className="space-y-2">
                  <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {selectedStat ? (
                      <>
                        <span className="inline-flex items-center gap-1.5">
                          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                          <span className="tabular-nums text-foreground">{formatPlaytime(selectedStat.total_playtime_seconds)}</span>
                          {t('dossier.played')}
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                          <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
                          <span className="tabular-nums text-foreground">{selectedStat.session_count}</span>
                          {t('dossier.sessions')}
                        </span>
                        {selectedStat.last_seen && (
                          <span>
                            {t('dossier.lastLabel')} <span className="text-foreground">{formatDate(selectedStat.last_seen)}</span>
                          </span>
                        )}
                      </>
                    ) : (
                      <span>{t('dossier.noHistory')}</span>
                    )}
                  </p>
                  {(selectedHasPowers || (selectedNote?.tags && selectedNote.tags.length > 0) || selectedNote?.note) && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {selectedPlayerPowers?.godMode && (
                        <Badge variant="outline" className="gap-1 border-primary/40 bg-primary/10 px-1.5 py-0 text-[10px] text-primary">
                          <Ghost className="h-3 w-3" aria-hidden="true" /> {t('dossier.godBadge')}
                        </Badge>
                      )}
                      {selectedPlayerPowers?.invisible && (
                        <Badge variant="outline" className="gap-1 border-primary/40 bg-primary/10 px-1.5 py-0 text-[10px] text-primary">
                          <Eye className="h-3 w-3" aria-hidden="true" /> {t('dossier.invisibleBadge')}
                        </Badge>
                      )}
                      {selectedPlayerPowers?.noclip && (
                        <Badge variant="outline" className="gap-1 border-primary/40 bg-primary/10 px-1.5 py-0 text-[10px] text-primary">
                          <Layers className="h-3 w-3" aria-hidden="true" /> {t('dossier.noclipBadge')}
                        </Badge>
                      )}
                      {selectedNote?.tags?.map(tag => (
                        <Badge key={tag} variant="secondary" className="px-1.5 py-0 text-[10px]">
                          {tag}
                        </Badge>
                      ))}
                      {selectedNote?.note && (
                        <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px] text-muted-foreground">
                          <StickyNote className="h-3 w-3" aria-hidden="true" /> {t('dossier.noteBadge')}
                        </Badge>
                      )}
                    </div>
                  )}
                </div>
              }
              actions={
                <>
                  <DisabledReason reason={!canModerate ? t('permissions.noModerate') : null}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setKickDialogOpen(true)}
                    disabled={!canModerate}
                    className="gap-1.5 border-warning/40 text-warning hover:bg-warning/10 hover:text-warning"
                    // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Kick player"); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                    title={t('dossier.kickTitle')}
                  >
                    <UserX aria-hidden="true" />
                    <span className="hidden sm:inline">{t('dossier.kickButton')}</span>
                  </Button>
                  </DisabledReason>
                  <DisabledReason reason={!canModerate ? t('permissions.noModerate') : null}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setBanDialogOpen(true)}
                    disabled={!canModerate}
                    className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Ban player"); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                    title={t('dossier.banTitle')}
                  >
                    <Ban aria-hidden="true" />
                    <span className="hidden sm:inline">{t('dossier.banButton')}</span>
                  </Button>
                  </DisabledReason>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="iconDense" aria-label={t('dossier.moreActionsAria')} title={t('dossier.moreActionsAria')}>
                        <MoreHorizontal aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[12rem]">
                      {/* Radix runs a DropdownMenuItem's onClick even when it is
                          disabled, so each gated item checks its capability first. */}
                      <DisabledReason className="w-full" reason={!canGmTools ? t('permissions.noGmTools') : null}>
                        <DropdownMenuItem onClick={() => { if (!canGmTools) return; setTeleportDialogOpen(true) }} disabled={!canGmTools}>
                          <MapPin className="me-2 h-4 w-4" aria-hidden="true" />
                          {t('dossier.teleport')}
                        </DropdownMenuItem>
                      </DisabledReason>
                      {selectedIsOnline ? (
                        <DropdownMenuItem asChild>
                          <Link to={`/world-map?player=${encodeURIComponent(selectedOnlineName ?? selectedPlayer)}`}>
                            <MapIcon className="me-2 h-4 w-4" aria-hidden="true" />
                            {t('dossier.showOnMap')}
                          </Link>
                        </DropdownMenuItem>
                      ) : (
                        <DisabledReason className="w-full" reason={t('dossier.showOnMapOffline', { player: selectedPlayer })}>
                          <DropdownMenuItem disabled>
                            <MapIcon className="me-2 h-4 w-4" aria-hidden="true" />
                            {t('dossier.showOnMap')}
                          </DropdownMenuItem>
                        </DisabledReason>
                      )}
                      <DropdownMenuSeparator />
                      <DisabledReason className="w-full" reason={!canGmTools ? t('permissions.noGmTools') : (!bridgeConnected ? t('powers.bridgeRequiredTooltip') : null)}>
                        <DropdownMenuItem
                          onClick={() => { if (!canGmTools) return; setImportExportOpen(true) }}
                          disabled={!bridgeConnected || !canGmTools}
                        >
                          <Download className="me-2 h-4 w-4" aria-hidden="true" />
                          {t('dossier.importExportCharacter')}
                        </DropdownMenuItem>
                      </DisabledReason>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              }
            >
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                {/* flex-wrap, not a horizontal scroller: a scrolling strip
                    clipped "Notes" to a bare "N" on phones (2026-08-31 visual
                    sweep), the same choice as Diagnostics' tab strip. */}
                <TabsList aria-label={t('tabs.listAria', { player: selectedPlayer })} className="flex h-auto flex-wrap items-center justify-start gap-1">
                  <TabsTrigger value="character" className="shrink-0 px-3 text-xs">{t('tabs.character')}</TabsTrigger>
                  <TabsTrigger value="moderation" className="shrink-0 px-3 text-xs">{t('tabs.moderation')}</TabsTrigger>
                  <TabsTrigger value="spawn" className="shrink-0 px-3 text-xs">{t('tabs.spawn')}</TabsTrigger>
                  <TabsTrigger value="powers" className="shrink-0 px-3 text-xs">{t('tabs.powers')}</TabsTrigger>
                  <TabsTrigger value="notes" className="shrink-0 px-3 text-xs">{t('tabs.notes')}</TabsTrigger>
                </TabsList>

              {/* Character Tab -- skills, XP, traits, condition and inventory
                  (GET /api/player-character), live or last known. Replaces
                  the Vitals tab, whose content is its Condition section. */}
              <TabsContent value="character" className="mt-4">
                {canViewCharacter ? (
                  <CharacterTab username={characterTarget} online={isCharacterTargetOnline} state={characterSheet} />
                ) : (
                  <p className="text-sm text-muted-foreground">{t('character.state.noPermission')}</p>
                )}
              </TabsContent>

              {/* Moderation: what this player may do in-game and whether they
                  are on the whitelist. Kick and Ban sit next to the name above;
                  actions that take any name (Unban, SteamID bans, Voice ban,
                  a new whitelist account) are in the page header's menu. */}
              <TabsContent value="moderation" className="mt-4">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
                            {grantableAccessLevels.map((level) => (
                              <SelectItem key={level} value={level}>
                                {accessLevelLabels[level] || level.charAt(0).toUpperCase() + level.slice(1)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {grantableAccessLevels.length < accessLevelOptions.length && (
                          <p className="mt-2 text-xs text-muted-foreground">{t('accessLevelDialog.staffLevelsHint')}</p>
                        )}
                      </div>
                      <DialogFooter>
                        <Button onClick={() => handleSetAccessLevel()} disabled={loading || !accessLevel}>
                          {t('accessLevelDialog.submit')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  </DisabledReason>
                  <DisabledReason className="w-full" reason={!canModerate ? t('permissions.noModerate') : null}>
                    <button
                      type="button"
                      onClick={() => {
                        if (!canModerate) return
                        setAddUserUsername(selectedPlayer)
                        setAddUserPassword('')
                        setAddUserDialogMode('addToWhitelist')
                        setAddUserDialogOpen(true)
                      }}
                      disabled={loading || !canModerate}
                      className="block h-auto w-full p-0 text-start"
                    >
                      <ActionTile
                        icon={<UserPlus className="h-4 w-4" />}
                        label={t('dossier.addToWhitelist')}
                        description={t('actionTiles.addToWhitelistDesc')}
                        disabled={loading || !canModerate}
                      />
                    </button>
                  </DisabledReason>
                  {/* selectedPlayerConfirmedNotWhitelisted disables this once the
                      whitelist has confirmed there is nothing to remove, and says
                      so (Players-UX-sense-check 2026-09-18). */}
                  <DisabledReason
                    className="w-full"
                    reason={
                      !canModerate
                        ? t('permissions.noModerate')
                        : selectedPlayerConfirmedNotWhitelisted
                          ? t('dossier.notOnWhitelistReason', { player: selectedPlayer })
                          : null
                    }
                  >
                    <button
                      type="button"
                      onClick={async () => {
                        if (!canModerate) return
                        const player = selectedPlayer
                        const confirmed = await confirm({
                          title: t('roster.removeFromWhitelistConfirmTitle'),
                          description: t('roster.removeFromWhitelistConfirmDesc', { player }),
                          confirmLabel: t('roster.removeFromWhitelistConfirmButton'),
                          destructive: true,
                        })
                        if (!confirmed) return
                        void handleAction(t('actions.removeFromWhitelist'), () => playersApi.removeFromWhitelist(player), () => { void fetchWhitelist() }, player)
                      }}
                      disabled={loading || !canModerate || selectedPlayerConfirmedNotWhitelisted}
                      className="block h-auto w-full p-0 text-start"
                    >
                      <ActionTile
                        icon={<UserMinus className="h-4 w-4" />}
                        label={t('dossier.removeFromWhitelist')}
                        description={t('actionTiles.removeFromWhitelistDesc')}
                        disabled={loading || !canModerate || selectedPlayerConfirmedNotWhitelisted}
                      />
                    </button>
                  </DisabledReason>
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
                    'group w-full rounded-lg border bg-muted/25 p-3 text-start',
                    'motion-safe:transition-all duration-150',
                    'border-border/60',
                    selectedPlayer && !loading && 'hover:border-primary/50 hover:bg-accent/30',
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
                        <span className="label-micro">
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
                      <span className="font-medium">{t('spawn.browse')}</span>
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
                    'group w-full rounded-lg border bg-muted/25 p-3 text-start',
                    'motion-safe:transition-all duration-150',
                    'border-border/60',
                    !loading && 'hover:border-primary/50 hover:bg-accent/30',
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
                        <span className="label-micro">
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
                      <span className="font-medium">{t('spawn.browse')}</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </div>
                  </div>
                </button>
                </DisabledReason>

                {/* Give XP */}
                <div className="rounded-lg border border-border/60 bg-muted/25 p-3">
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
                      {/* giveXpDescNoPlayer used to read "Grant experience to the
                          selected player" -- accurate as a feature summary but,
                          shown specifically while NO player is selected, it reads
                          like one already is (contradicting its own premise) and
                          never tells the operator what to do next. The sibling
                          Give Items card just above already says "Pick a player
                          first..." for the same no-selection state; Give XP now
                          matches that pattern instead of describing the feature
                          in the abstract. Players-UX-sense-check 2026-09-18. */}
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
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/25 p-3">
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
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/25 p-3">
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
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/25 p-3">
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
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/25 p-3">
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg border border-success/20 bg-success/10 p-2 text-success">
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
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
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

              {/* Notes Tab: the admin note, tags and playtime. The server's
                  activity log is the roster card's Activity list. */}
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
                      <div className="rounded-xl border border-border/70 bg-background/40 p-4">
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
                              <div className="font-medium text-xs">{formatDate(playerStats[selectedPlayer].first_seen)}</div>
                            </div>
                            <div>
                              <div className="text-muted-foreground text-xs">{t('notes.lastSeen')}</div>
                              <div className="font-medium text-xs">{formatDateTime(playerStats[selectedPlayer].last_seen, { seconds: true })}</div>
                            </div>
                          </div>
                      </div>
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
                              disabled={!canModerate}
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
                            disabled={!canModerate}
                          />
                          <Button size="sm" variant="ghost" onClick={addTag} disabled={!canModerate} className="h-8 w-8 p-0" aria-label={t('notes.addTagAria')}>
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
                            <Button variant="outline" size="sm" onClick={() => fetchNotesAndStats({ manual: true })} className="self-start">
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
                        readOnly={!canModerate}
                        aria-label={t('notes.adminNoteLabel')}
                      />
                      <p className="text-xs text-muted-foreground">{t('notes.charCount', { count: currentNote.length })}</p>
                    </div>

                    {/* Actions */}
                    <div className="flex justify-between items-center pt-2">
                      <div className="text-xs text-muted-foreground">
                        {playerNotes[noteKey(selectedPlayer)]?.updated_at && (
                          <span>{t('notes.lastUpdated', { date: formatDateTime(playerNotes[noteKey(selectedPlayer)].updated_at, { seconds: true }) })}</span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        {playerNotes[noteKey(selectedPlayer)] && (
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

              </TabsContent>
              </Tabs>
            </SectionCard>
          )}
        </div>
      </div>

      {/* Kick, Ban and Teleport act on the selected player; the header
          menu's dialogs take any name. Kept here, outside the tabs, so
          each opens from wherever its button is. */}
      <Dialog open={kickDialogOpen} onOpenChange={setKickDialogOpen}>
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
              {banReasonWillBeAltered(kickReason) && (
                <p className="mt-1 text-xs text-warning [overflow-wrap:anywhere]">
                  {previewBanReason(kickReason)
                    ? t('kickDialog.reasonAlteredNote', { preview: previewBanReason(kickReason) })
                    : t('kickDialog.reasonAlteredToEmpty')}
                </p>
              )}
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

      <Dialog open={banDialogOpen} onOpenChange={setBanDialogOpen}>
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
              {banReasonWillBeAltered(banReason) && (
                <p className="mt-1 text-xs text-warning [overflow-wrap:anywhere]">
                  {previewBanReason(banReason)
                    ? t('banDialog.reasonAlteredNote', { preview: previewBanReason(banReason) })
                    : t('banDialog.reasonAlteredToEmpty')}
                </p>
              )}
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

      {/* Teleport (the player menu, gated on players.gm_tools there) --
          requires PanelBridge; syncs via teleportTo + setNetworkTeleportEnabled.
          Note: known unreliable in B42 multiplayer; we still surface the dialog so admins can try. */}
      <Dialog open={teleportDialogOpen} onOpenChange={(open) => {
        setTeleportDialogOpen(open)
        // A target typed over the selected player's name is for this
        // opening only; closing without teleporting drops it.
        if (!open) setTeleportTarget('')
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('teleportDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('teleportDialog.description', { player: selectedPlayer })}
            </DialogDescription>
          </DialogHeader>
          {/* DialogBody: on a landscape phone (853x413) the target,
              presets and X/Y/Z fields are taller than the window, and
              the whole dialog scrolled with Teleport below the fold.
              Only the fields scroll now; the button stays on screen. */}
          <DialogBody className="space-y-4">
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
          </DialogBody>
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

      <Dialog open={voiceBanDialogOpen} onOpenChange={setVoiceBanDialogOpen}>
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
                  }, target)
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

      <Dialog open={steamIdBanDialogOpen} onOpenChange={setSteamIdBanDialogOpen}>
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

      <Dialog open={addUserDialogOpen} onOpenChange={setAddUserDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{addUserDialogMode === 'addToWhitelist' ? t('addUserDialog.titleWhitelist') : t('addUserDialog.title')}</DialogTitle>
            <DialogDescription>
              {addUserDialogMode === 'addToWhitelist'
                ? t('addUserDialog.descriptionWhitelist', { player: addUserUsername })
                : t('addUserDialog.description')}
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
              {addUserDialogMode === 'addToWhitelist' ? t('addUserDialog.submitWhitelist') : t('addUserDialog.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={unbanDialogOpen} onOpenChange={setUnbanDialogOpen}>
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

      <Dialog open={unbanSteamIdDialogOpen} onOpenChange={(open) => {
        setUnbanSteamIdDialogOpen(open)
        if (open) fetchBannedSteamIds()
        else setUnbanSteamId('')
      }}>
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
                        {ban.banned_at && <span className="ms-2 text-xs text-muted-foreground">{formatDate(ban.banned_at)}</span>}
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

      {/* Import/Export Character Dialog + import confirmation */}
      <CharacterImportExportDialog
        open={importExportOpen}
        onOpenChange={setImportExportOpen}
        player={selectedPlayer}
        bridgeConnected={bridgeConnected}
        bridgeStatusLoading={bridgeStatusLoading}
        autoExportEnabled={autoExportEnabled}
        onAutoExportEnabledChange={setAutoExportEnabled}
        savedExports={savedExports}
        onSavedExportsChange={setSavedExports}
      />

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
