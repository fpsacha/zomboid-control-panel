import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { reportClientError } from '@/lib/client-errors'
import { useTranslation } from 'react-i18next'


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
import { SpawnBrowser } from '@/components/SpawnBrowser'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'
import { PageHeader } from '@/components/PageHeader'
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

const ACCESS_LEVELS = ['admin', 'moderator', 'overseer', 'gm', 'observer', 'user', 'none']

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
}: {
  icon: React.ReactNode
  label: string
  value: string | number
  tone?: 'default' | 'success' | 'warning' | 'danger'
  caption?: string
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
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/75">{label}</p>
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
        'group flex w-full items-center gap-3 rounded-md border text-left transition-colors',
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
        {description && !compact ? (
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </div>
  )
}

export default function Players() {
  const { t } = useTranslation('players')
  
  
  
  
  
  const [players, setPlayers] = useState<Player[]>([])
  const [perks, setPerks] = useState<PerkChoice[]>([])
  const [selectedPlayer, setSelectedPlayer] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const { toast } = useToast()

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
  const [playersLoadError, setPlayersLoadError] = useState<string | null>(null)
  const [toolsLoadError, setToolsLoadError] = useState<string | null>(null)
  const [notesError, setNotesError] = useState<string | null>(null)
  const [logsError, setLogsError] = useState<string | null>(null)

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
  const [rosterTab, setRosterTab] = useState<'online' | 'roster' | 'banned'>('online')
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

  // Update peak players
  useEffect(() => {
    if (players.length > peakPlayers) {
      setPeakPlayers(players.length)
    }
  }, [players.length, peakPlayers])

  const fetchPlayers = useCallback(async () => {
    try {
      const data = await playersApi.getPlayers()
      if (data.players) {
        setPlayers(data.players)
        setLastRefresh(new Date())
      }
      setPlayersLoadError(null)
    } catch (error) {
      reportClientError('Failed to fetch players.', error)
      setPlayersLoadError(getErrorMessage(error, t('errorMessages.failedToLoadPlayers')))
    }
  }, [t])

  const fetchActivityLogs = useCallback(async (playerFilter?: string) => {
    setLogsLoading(true)
    try {
      const data = await playersApi.getActivityLogs(playerFilter, 200)
      if (data.logs) {
        setActivityLogs(data.logs)
      }
      setLogsError(null)
    } catch (error) {
      reportClientError('Failed to fetch activity logs.', error)
      setLogsError(getErrorMessage(error, t('errorMessages.failedToLoadActivityLogs')))
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
      setNotesError(getErrorMessage(error, t('errorMessages.failedToLoadNotesAndStats')))
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
        title: t('messages.noteSaved'),
        description: t('messages.noteSavedDescription', { player: selectedPlayer }),
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
        title: t('messages.error'),
        description: error instanceof Error ? error.message : t('messages.failedToSaveNote'),
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
        title: t('messages.noteDeleted'),
        description: t('messages.noteDeletedDescription', { player: selectedPlayer }),
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
        title: t('messages.error'),
        description: error instanceof Error ? error.message : t('messages.failedToDeleteNote'),
        variant: 'destructive',
      })
    } finally {
      setSavingNote(false)
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
          (perksData.perks || []).map((id: string) => ({ id, label: id, category: 'Skills' })),
      )
      setToolsLoadError(null)
    } catch (error) {
      reportClientError('Failed to fetch player data.', error)
      setToolsLoadError(getErrorMessage(error, t('errorMessages.failedToLoadPlayerData')))
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

  useEffect(() => {
    Promise.all([fetchPlayers(), fetchData(), fetchNotesAndStats(), fetchBannedSteamIds()]).catch(err => {
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
    const interval = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      fetchPlayers()
    }, 15000)
    return () => {
      isMounted = false
      clearInterval(interval)
    }
  }, [fetchPlayers, fetchData, fetchNotesAndStats, fetchBannedSteamIds])

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

  const handleAction = async (action: string, fn: () => Promise<unknown>, closeDialog?: () => void) => {
    setLoading(true)
    try {
      await fn()
      toast({
        title: t('messages.actionSuccess'),
        description: `${action} ${t('messages.actionCompleted')}`,
        variant: 'success' as const,
      })
      fetchPlayers()
      closeDialog?.()
    } catch (error) {
      toast({
        title: t('messages.error'),
        description: error instanceof Error ? error.message : t('messages.actionFailed'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleKick = () => {
    if (!selectedPlayer) return
    handleAction(t('actions.kick'), () => playersApi.kick(selectedPlayer, kickReason), () => {
      setKickDialogOpen(false)
      setKickReason('')
      setSelectedPlayer('')
      searchInputRef.current?.focus()
    })
  }

  const handleBan = () => {
    if (!selectedPlayer) return
    handleAction(t('actions.ban'), () => playersApi.ban(selectedPlayer, banIp, banReason), () => {
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
    handleAction(t('actions.unban'), () => playersApi.unban(unbanUsername), () => {
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

  const handleTeleport = (targetOverride?: string) => {
    const target = (targetOverride ?? teleportTarget ?? '').trim() || selectedPlayer
    if (!target || !teleportX || !teleportY) return
    handleAction(t('actions.teleport'), () => playersApi.teleport(target, {
      x: Number(teleportX),
      y: Number(teleportY),
      z: Number(teleportZ || '0')
    }), () => {
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
    handleAction(t('actions.steamIdBan'), () => playersApi.banSteamId(steamId, reason), () => {
      setSteamIdBanDialogOpen(false)
      setBanSteamId('')
      setSteamBanReason('')
      void fetchBannedSteamIds()
    })
  }

  const handleVoiceBan = () => {
    if (!voiceBanUsername) return
    handleAction(voiceBanEnabled ? t('actions.voiceBan') : t('actions.voiceUnban'),
      () => playersApi.voiceBan(voiceBanUsername, voiceBanEnabled), () => {
        setVoiceBanDialogOpen(false)
        setVoiceBanUsername('')
      })
  }

  const handleAddUser = () => {
    if (!addUserUsername.trim() || !addUserPassword.trim()) {
      toast({
        title: t('messages.error'),
        description: t('messages.usernameAndPasswordRequired'),
        variant: 'destructive',
      })
      return
    }
    if (addUserPassword.length < 4) {
      toast({
        title: t('messages.error'),
        description: t('messages.passwordTooShort'),
        variant: 'destructive',
      })
      return
    }
    handleAction(t('actions.addUser'), () => playersApi.addUser(addUserUsername.trim(), addUserPassword), () => {
      setAddUserDialogOpen(false)
      setAddUserUsername('')
      setAddUserPassword('')
    })
  }

  const handleSetAccessLevel = () => {
    if (!selectedPlayer || !accessLevel) return
    handleAction(t('actions.accessLevel'), () => playersApi.setAccessLevel(selectedPlayer, accessLevel))
  }

  // Direct spawn handlers used by the SpawnBrowser dialog. They intentionally
  // rethrow on failure so the dialog keeps the current selection (user can retry),
  // and resolve silently on success so the dialog shows its own in-place confirmation.
  const spawnItemFromBrowser = async (id: string, qty?: number) => {
    if (!selectedPlayer) throw new Error(t('empty.noTargetSelected'))
    const count = qty ?? 1
    setLoading(true)
    try {
      await playersApi.addItem(selectedPlayer, id, count)
      toast({
        title: t('messages.itemGiven'),
        description: `${id.replace(/^Base\./, '')}${count > 1 ? ` × ${count}` : ''} → ${selectedPlayer}`,
        variant: 'success' as const,
      })
      fetchPlayers()
    } catch (error) {
      toast({
        title: t('messages.giveItemFailed'),
        description: error instanceof Error ? error.message : t('messages.couldNotDeliverItem'),
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
      toast({
        title: t('messages.vehicleSpawned'),
        description: selectedPlayer
          ? t('messages.vehicleSpawnedDescription', { vehicle: id.replace(/^Base\./, ''), player: selectedPlayer })
          : t('messages.vehicleSpawnedDescriptionNoPlayer', { vehicle: id.replace(/^Base\./, '') }),
        variant: 'success' as const,
      })
      fetchPlayers()
    } catch (error) {
      toast({
        title: t('messages.vehicleSpawnFailed'),
        description: error instanceof Error ? error.message : t('messages.couldNotSpawnVehicle'),
        variant: 'destructive',
      })
      throw error
    } finally {
      setLoading(false)
    }
  }

  const handleAddXp = () => {
    if (!selectedPlayer || !selectedPerk) return
    handleAction(t('actions.addXP'), () => playersApi.addXp(selectedPlayer, selectedPerk, xpAmount))
  }

  const handleGodMode = (enabled: boolean) => {
    const player = selectedPlayer
    if (!player) return
    handleAction(enabled ? t('powers.enableGodMode') : t('powers.disableGodMode'),
      async () => {
        await panelBridgeApi.sendCommand('setGodMode', { username: player, enabled })
        setPlayerPowers(prev => ({
          ...prev,
          [player]: { ...prev[player], godMode: enabled }
        }))
      })
  }

  const handleInvisible = (enabled: boolean) => {
    const player = selectedPlayer
    if (!player) return
    handleAction(enabled ? t('powers.enableInvisible') : t('powers.disableInvisible'),
      async () => {
        await panelBridgeApi.sendCommand('setInvisible', { username: player, enabled })
        setPlayerPowers(prev => ({
          ...prev,
          [player]: { ...prev[player], invisible: enabled }
        }))
      })
  }

  const handleNoclip = (enabled: boolean) => {
    const player = selectedPlayer
    if (!player) return
    handleAction(enabled ? t('powers.enableNoclip') : t('powers.disableNoclip'),
      async () => {
        await panelBridgeApi.sendCommand('setNoclip', { username: player, enabled })
        setPlayerPowers(prev => ({
          ...prev,
          [player]: { ...prev[player], noclip: enabled }
        }))
      })
  }

  const handleHealPlayer = () => {
    const player = selectedPlayer
    if (!player) return
    handleAction(t('heal'),
      async () => {
        await panelBridgeApi.sendCommand('healPlayer', { username: player })
      })
  }

  // Get selected player's current powers
  const selectedPlayerPowers = useMemo(() =>
    selectedPlayer ? playerPowers[selectedPlayer] : null,
    [selectedPlayer, playerPowers]
  )

  return (
    <div className="space-y-6 page-transition">
      {/* Header */}
      <PageHeader
        title={t('title')}
        description={t('pageHeader.description')}
        icon={<Users className="w-5 h-5 text-primary" />}
        actions={
          <div className="flex items-center gap-2">
            {lastRefresh && (
              <span className="text-xs text-muted-foreground">
                {t('notes.lastUpdated')} {lastRefresh.toLocaleTimeString()}
              </span>
            )}
            <Button onClick={fetchPlayers} variant="outline" size="sm" className="gap-2">
              <RefreshCw className="w-4 h-4" />
              {t('actions.refresh')}
            </Button>
          </div>
        }
      />

      {(playersLoadError || toolsLoadError) && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t('playersPageIsPartiallyUnavailable')}</AlertTitle>
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
              <RefreshCw className="mr-2 h-4 w-4" /> {t('common:actions.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Stats summary — tactical signal strip */}
      <div className="flex flex-col gap-2 stagger-in sm:flex-row sm:flex-wrap">
        <SummaryCard
          icon={<Users className="h-4 w-4" />}
          label={t('filters.online')}
          value={players.length}
          tone={players.length > 0 ? 'success' : 'default'}
          caption={players.length === 1 ? t('stats.player') : t('stats.players')}
        />
        <SummaryCard
          icon={<TrendingUp className="h-4 w-4" />}
          label={t('stats.peakToday')}
          value={peakPlayers}
          tone="default"
        />
        <SummaryCard
          icon={<Users className="h-4 w-4" />}
          label={t('stats.roster')}
          value={offlineRoster.length}
          caption={t('stats.seen')}
        />
        {bannedSteamIds.length > 0 && (
          <button
            type="button"
            onClick={() => setUnbanSteamIdDialogOpen(true)}
            className="group relative flex flex-1 items-center gap-3 overflow-hidden rounded-md border border-border/55 bg-card/70 px-4 py-3 text-left shadow-sm transition-colors hover:border-destructive/45 hover:bg-destructive/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
            aria-label={t('aria.viewBannedSteamIds', { count: bannedSteamIds.length })}
          >
            <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[2px] bg-destructive/60" />
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-destructive/30 bg-destructive/10 text-destructive">
              <Ban className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5">
                <p className="text-xl font-semibold tabular-nums leading-none tracking-tight">{bannedSteamIds.length}</p>
                <span className="text-xs font-medium text-muted-foreground/70">{t('manage')}</span>
              </div>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.22em] text-destructive/80">{t('bannedSteamids')}</p>
            </div>
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Player List */}
        <Card className="lg:col-span-1 overflow-hidden border-border/55 bg-card/70">
          <div className="flex items-center justify-between border-b border-border/40 bg-muted/20 px-4 py-2">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
              <span className="text-primary/80">//</span>
              <span>{t('roster')}</span>
              <span className="text-muted-foreground/50">·</span>
              <span>
                {rosterTab === 'online' ? t('rosterTabs.live') : rosterTab === 'roster' ? t('rosterTabs.history') : t('rosterTabs.bans')}
              </span>
            </div>
            <span className="font-mono text-[11px] tabular-nums text-foreground/80">
              {rosterTab === 'online' ? players.length : rosterTab === 'roster' ? offlineRoster.length : bannedSteamIds.length}
            </span>
          </div>
          <CardHeader className="space-y-3 pb-3 pt-4">
            {/* Tab strip: online / roster / banned */}
            <div className="grid grid-cols-3 gap-1 rounded-md border border-border/55 bg-muted/30 p-1">
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
                <span>{t('online')}</span>
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
                <span>{t('roster')}</span>
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
                <span>{t('banned')}</span>
                <span className="tabular-nums text-foreground/70">{bannedSteamIds.length}</span>
              </button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                placeholder={
                  rosterTab === 'online'
                    ? t('placeholders.searchOnline')
                    : rosterTab === 'roster'
                      ? t('placeholders.searchRoster')
                      : t('placeholders.searchBans')
                }
                value={playerSearchFilter}
                onChange={(e) => setPlayerSearchFilter(e.target.value)}
                className="pl-9"
                aria-label={t('filters.search')}
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
                    <p className="mt-3 text-sm font-medium">{t('noPlayersOnline')}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('empty.playersAppearWhenConnected')}
                    </p>
                    {offlineRoster.length > 0 && (
                      <Button variant="ghost" size="sm" className="mt-4 text-xs text-muted-foreground" onClick={() => setRosterTab('roster')}>
                        <Users className="mr-1.5 h-3.5 w-3.5" />
                        {t('empty.seePreviouslySeen', { count: offlineRoster.length })}
                      </Button>
                    )}
                    {bannedSteamIds.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-1 text-xs text-muted-foreground"
                        onClick={() => setRosterTab('banned')}
                      >
                        <Ban className="mr-1.5 h-3.5 w-3.5" />
                        {t('empty.reviewBanned', { count: bannedSteamIds.length })}
                      </Button>
                    )}
                  </div>
                ) : filteredPlayers.length === 0 ? (
                  <EmptyState type="noResults" title={t('empty.noMatchesFor', { term: playerSearchFilter })} description={t('empty.description2')} compact />
                ) : (
                  <div className="space-y-1">
                    {filteredPlayers.map((player) => {
                      const isSelected = selectedPlayer === player.name
                      const powers = playerPowers[player.name]
                      const hasPowers = powers && (powers.godMode || powers.invisible || powers.noclip)
                      const note = playerNotes[player.name]
                      const stat = playerStats[player.name]

                      return (
                        <button
                          key={player.name}
                          type="button"
                          className={`group w-full text-left p-3 rounded-lg border cursor-pointer transition-[background-color,border-color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 ${
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
                              <span className="sr-only">{t('online')}</span>
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
                              {stat && (
                                <span className="text-xs text-muted-foreground mr-1">
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
                      {playerSearchFilter ? t('empty.noMatches') : t('empty.rosterIsEmpty')}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {playerSearchFilter
                        ? t('empty.tryDifferentSearch')
                        : t('empty.rosterHint')}
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
                          className={`w-full text-left p-3 rounded-lg border transition-[background-color,border-color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 ${
                            isSelected
                              ? 'bg-primary/10 border-primary shadow-sm'
                              : 'hover:bg-muted/50 border-transparent hover:border-border'
                          }`}
                          onClick={() => setSelectedPlayer(name)}
                          title={lastSeen
                            ? t('titles.lastSeen', { time: lastSeen.toLocaleString() })
                            : t('titles.lastSeenUnknown')}
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
                            <div className="flex flex-col items-end text-right">
                              <span className="text-xs text-muted-foreground">
                                {formatPlaytime(stat.total_playtime_seconds)}
                              </span>
                              {lastSeen && (
                                <span className="text-[10px] text-muted-foreground/70">
                                  {lastSeen.toLocaleDateString()}
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
                      {playerSearchFilter ? t('empty.noMatches') : t('empty.noSteamIdBans')}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {playerSearchFilter
                        ? t('empty.tryDifferentSearch')
                        : t('empty.bannedAppearHere')}
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
                                {ban.banned_at ? new Date(ban.banned_at).toLocaleDateString() : ''}
                              </p>
                            )}
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            onClick={() => {
                              setUnbanSteamId(ban.steamId)
                              setUnbanSteamIdDialogOpen(true)
                            }}
                            title={`${t('actions.unban')} ${ban.steamId}`}
                          >
                            {t('actions.unban')}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              )}
            </ScrollArea>

            {/* Manual entry — for offline or unlisted usernames */}
            <div className="space-y-1.5 border-t border-border/40 pt-3">
              <Label className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/80">
                <span className="text-primary/70">›</span> {t('manualTarget')}
              </Label>
              <Input
                placeholder={t('placeholders.enterUsername')}
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
              <span>{t('dossier')}</span>
              <span className="text-muted-foreground/50">·</span>
              <span className={selectedPlayer ? 'text-foreground/85' : 'text-amber-400/85'}>
                {selectedPlayer ? t('dossierStatus.acquired') : t('dossierStatus.standby')}
              </span>
            </div>
            {selectedPlayer && (
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/70">
                {(() => {
                  const online = players.some(p => p.name === selectedPlayer)
                  return online ? t('playerStatus.online') : t('playerStatus.offline')
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
                      <span aria-hidden="true" className="pointer-events-none absolute -left-px -top-px h-3 w-3 border-l-2 border-t-2 border-primary/40" />
                      <span aria-hidden="true" className="pointer-events-none absolute -right-px -top-px h-3 w-3 border-r-2 border-t-2 border-primary/40" />
                      <span aria-hidden="true" className="pointer-events-none absolute -left-px -bottom-px h-3 w-3 border-b-2 border-l-2 border-primary/40" />
                      <span aria-hidden="true" className="pointer-events-none absolute -right-px -bottom-px h-3 w-3 border-b-2 border-r-2 border-primary/40" />
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
                              {isOnline ? t('playerStatus.connected') : t('playerStatus.lastSeen')}
                            </span>
                          </div>
                          {/* Inline stats */}
                          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground/85">
                            {stat ? (
                              <>
                                <span className="flex items-center gap-1.5">
                                  <Clock className="h-3 w-3 text-primary/70" />
                                  <span className="tabular-nums text-foreground/85">{formatPlaytime(stat.total_playtime_seconds)}</span>
                                  <span className="text-muted-foreground/70">{t('played')}</span>
                                </span>
                                <span className="flex items-center gap-1.5">
                                  <TrendingUp className="h-3 w-3 text-primary/70" />
                                  <span className="tabular-nums text-foreground/85">{stat.session_count}</span>
                                  <span className="text-muted-foreground/70">{t('sessions')}</span>
                                </span>
                                {stat.last_seen && (
                                  <span className="text-muted-foreground/70">
                                    {t('playerStatus.last')} <span className="text-foreground/80">{new Date(stat.last_seen).toLocaleDateString()}</span>
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="text-muted-foreground/60">{t('noHistoryRecordedYet')}</span>
                            )}
                          </div>
                          {/* Tags + powers row */}
                          {((note?.tags && note.tags.length > 0) || (selectedPlayerPowers && (selectedPlayerPowers.godMode || selectedPlayerPowers.invisible || selectedPlayerPowers.noclip))) && (
                            <div className="mt-3 flex flex-wrap items-center gap-1.5">
                              {selectedPlayerPowers?.godMode && (
                                <Badge variant="outline" className="gap-1 border-primary/40 bg-primary/10 px-1.5 py-0 text-[10px] font-mono uppercase tracking-wider text-primary">
                                  <Ghost className="h-3 w-3" /> {t('powers.godBadge')}
                                </Badge>
                              )}
                              {selectedPlayerPowers?.invisible && (
                                <Badge variant="outline" className="gap-1 border-primary/40 bg-primary/10 px-1.5 py-0 text-[10px] font-mono uppercase tracking-wider text-primary">
                                  <Eye className="h-3 w-3" /> {t('powers.invisibleBadge')}
                                </Badge>
                              )}
                              {selectedPlayerPowers?.noclip && (
                                <Badge variant="outline" className="gap-1 border-primary/40 bg-primary/10 px-1.5 py-0 text-[10px] font-mono uppercase tracking-wider text-primary">
                                  <Layers className="h-3 w-3" /> {t('powers.noclipBadge')}
                                </Badge>
                              )}
                              {note?.tags?.map(tag => (
                                <Badge key={tag} variant="secondary" className="px-1.5 py-0 text-[10px] font-mono uppercase tracking-wider">
                                  {tag}
                                </Badge>
                              ))}
                              {note?.note && (
                                <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                                  <StickyNote className="h-3 w-3" /> {t('notes.badge')}
                                </Badge>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Quick danger actions */}
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setKickDialogOpen(true)}
                            className="h-8 gap-1.5 border-amber-500/40 text-xs font-medium text-amber-300 hover:border-amber-500/60 hover:bg-amber-500/10 hover:text-amber-200"
                            title={t('titles.kickPlayer')}
                          >
                            <UserX className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">{t('kick')}</span>
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setBanDialogOpen(true)}
                            className="h-8 gap-1.5 border-destructive/45 text-xs font-medium text-destructive hover:border-destructive/65 hover:bg-destructive/10"
                            title={t('titles.banPlayer')}
                          >
                            <Ban className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">{t('ban')}</span>
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="outline" size="sm" className="h-8 w-8 p-0" aria-label={t('actions.morePlayerActions')}>
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleGodMode(!selectedPlayerPowers?.godMode)} disabled={loading}>
                                <Ghost className="w-4 h-4 mr-2" />
                                {selectedPlayerPowers?.godMode ? t('powers.disableGodMode') : t('powers.enableGodMode')}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleInvisible(!selectedPlayerPowers?.invisible)} disabled={loading}>
                                <Eye className="w-4 h-4 mr-2" />
                                {selectedPlayerPowers?.invisible ? t('powers.disableInvisible') : t('powers.enableInvisible')}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleNoclip(!selectedPlayerPowers?.noclip)} disabled={loading}>
                                <Layers className="w-4 h-4 mr-2" />
                                {selectedPlayerPowers?.noclip ? t('powers.disableNoclip') : t('powers.enableNoclip')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => handleAction(t('actions.addToWhitelist'), () => playersApi.addToWhitelist(selectedPlayer))}
                                disabled={loading}
                              >
                                <UserPlus className="w-4 h-4 mr-2" />
                                {t('actions.addToWhitelist')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => handleAction(t('actions.removeFromWhitelist'), () => playersApi.removeFromWhitelist(selectedPlayer))}
                                disabled={loading}
                              >
                                <UserMinus className="w-4 h-4 mr-2" />
                                {t('actions.removeFromWhitelist')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => setImportExportOpen(true)}
                                disabled={!bridgeConnected}
                              >
                                <Download className="w-4 h-4 mr-2" />
                                {t('actions.importExportCharacter')}
                              </DropdownMenuItem>
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
                <span aria-hidden="true" className="pointer-events-none absolute -left-px -top-px h-3 w-3 border-l-2 border-t-2 border-border/60" />
                <span aria-hidden="true" className="pointer-events-none absolute -right-px -top-px h-3 w-3 border-r-2 border-t-2 border-border/60" />
                <span aria-hidden="true" className="pointer-events-none absolute -left-px -bottom-px h-3 w-3 border-b-2 border-l-2 border-border/60" />
                <span aria-hidden="true" className="pointer-events-none absolute -right-px -bottom-px h-3 w-3 border-b-2 border-r-2 border-border/60" />
                <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/70">
                  {t('empty.noTargetSelected')}
                </p>
                <p className="mx-auto mt-3 max-w-xs text-sm text-muted-foreground">
                  {t('empty.pickPlayerHint')}
                </p>
              </div>
            )}
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="moderation">
              <div className="overflow-x-auto pb-1">
                <TabsList className="inline-flex h-auto min-w-max gap-1 rounded-md border border-border/55 bg-muted/30 p-1">
                  <TabsTrigger value="moderation" className="min-h-8 shrink-0 px-3 text-xs font-medium">{t('tabs.moderation')}</TabsTrigger>
                  <TabsTrigger value="spawn" className="min-h-8 shrink-0 px-3 text-xs font-medium">{t('tabs.spawn')}</TabsTrigger>
                  <TabsTrigger value="powers" className="min-h-8 shrink-0 px-3 text-xs font-medium">{t('tabs.powers')}</TabsTrigger>
                  <TabsTrigger value="notes" className="min-h-8 shrink-0 px-3 text-xs font-medium" onClick={() => fetchActivityLogs()}>{t('tabs.notesLog')}</TabsTrigger>
                </TabsList>
              </div>

              {/* Moderation Tab */}
              <TabsContent value="moderation" className="space-y-4 mt-4">
                {/* Primary actions — visible when a player is selected */}
                {selectedPlayer ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                  {/* Kick */}
                  <Dialog open={kickDialogOpen} onOpenChange={setKickDialogOpen}>
                    <DialogTrigger asChild>
                      <button type="button" disabled={!selectedPlayer} className="block h-auto w-full p-0 text-left">
                        <ActionTile icon={<UserX className="w-4 h-4" />} label={t('actions.kick')} description={t('descriptions.kickReason')} disabled={!selectedPlayer} emphasis="warning" />
                      </button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{t('actions.kick')}</DialogTitle>
                        <DialogDescription>
                          {t('descriptions.kickFromServer', { player: selectedPlayer })}
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label htmlFor="kick-reason">{t('labels.reasonOptional')}</Label>
                          <Input
                            id="kick-reason"
                            value={kickReason}
                            onChange={(e) => setKickReason(e.target.value)}
                            placeholder={t('placeholders.enterReason')}
                          />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant="destructive" onClick={handleKick} disabled={loading}>
                          {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                          {t('actions.kick')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {/* Ban */}
                  <Dialog open={banDialogOpen} onOpenChange={setBanDialogOpen}>
                    <DialogTrigger asChild>
                      <button type="button" disabled={!selectedPlayer} className="block h-auto w-full p-0 text-left">
                        <ActionTile icon={<Ban className="w-4 h-4" />} label={t('actions.ban')} description={t('descriptions.banPermanent')} disabled={!selectedPlayer} emphasis="danger" />
                      </button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                          <AlertTriangle className="w-5 h-5 text-destructive" />
                          {t('actions.ban')}
                        </DialogTitle>
                        <DialogDescription>
                          {t('descriptions.banFromServer', { player: selectedPlayer })}
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label htmlFor="ban-reason">{t('labels.reasonOptional')}</Label>
                          <Input
                            id="ban-reason"
                            value={banReason}
                            onChange={(e) => setBanReason(e.target.value)}
                            placeholder={t('placeholders.enterReason')}
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id="banIp"
                            checked={banIp}
                            onCheckedChange={(checked) => setBanIp(checked === true)}
                          />
                          <Label htmlFor="banIp">{t('labels.alsoBanIp')}</Label>
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant="outline" onClick={() => setBanDialogOpen(false)}>
                          {t('common:actions.cancel')}
                        </Button>
                        <Button variant="destructive" onClick={() => setBanConfirmOpen(true)}>
                          {t('dialogs.continueToBan')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {/* Ban Confirmation */}
                  <AlertDialog open={banConfirmOpen} onOpenChange={setBanConfirmOpen}>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t('areYouAbsolutelySure')}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {t('dialogs.banConfirmDescription', { player: selectedPlayer, banIp: banIp ? t('dialogs.andTheirIp') : '' })}
                          {banReason && <><br />{t('dialogs.reasonLabel')} {banReason}</>}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={handleBan}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                          {t('actions.confirmBan')}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>

                  {/* Access Level */}
                  <Dialog>
                    <DialogTrigger asChild>
                      <button type="button" disabled={!selectedPlayer} className="block h-auto w-full p-0 text-left">
                        <ActionTile icon={<Shield className="w-4 h-4" />} label={t('actions.accessLevel')} description={t('descriptions.accessLevelTypes')} disabled={!selectedPlayer} emphasis="primary" />
                      </button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{t('setAccessLevel')}</DialogTitle>
                        <DialogDescription>
                          {t('dialogs.changeAccessLevelFor', { player: selectedPlayer })}
                        </DialogDescription>
                      </DialogHeader>
                      <div>
                        <Label htmlFor="access-level">{t('accessLevel')}</Label>
                        <Select value={accessLevel} onValueChange={setAccessLevel}>
                          <SelectTrigger id="access-level">
                            <SelectValue placeholder={t('placeholders.selectLevel')} />
                          </SelectTrigger>
                          <SelectContent>
                            {ACCESS_LEVELS.map((level) => (
                              <SelectItem key={level} value={level}>
                                {t(`accessLevels.${level}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <DialogFooter>
                        <Button onClick={handleSetAccessLevel} disabled={loading || !accessLevel}>
                          {t('dialogs.setLevel')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {/* Teleport — requires PanelBridge; syncs via teleportTo + setNetworkTeleportEnabled.
                      Note: known unreliable in B42 multiplayer; we still surface the dialog so admins can try. */}
                  <Dialog open={teleportDialogOpen} onOpenChange={(open) => {
                    setTeleportDialogOpen(open)
                    if (open && !teleportTarget) setTeleportTarget(selectedPlayer)
                  }}>
                    <DialogTrigger asChild>
                      <button type="button" className="block h-auto w-full p-0 text-left">
                        <ActionTile icon={<MapPin className="w-4 h-4" />} label={t('actions.teleport')} description={t('labels.b42Mp')} />
                      </button>
                    </DialogTrigger>
                    <DialogContent className="max-w-md">
                      <DialogHeader>
                        <DialogTitle>{t('teleportPlayer')}</DialogTitle>
                        <DialogDescription>
                          {t('dialogs.teleportToCoordinates', { player: selectedPlayer })}
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label htmlFor="teleport-target">{t('targetPlayer')}</Label>
                          <Input
                            id="teleport-target"
                            value={teleportTarget || selectedPlayer}
                            onChange={(e) => setTeleportTarget(e.target.value)}
                            placeholder={t('placeholders.playerToTeleport')}
                          />
                        </div>

                        {/* Quick Location Presets */}
                        <div>
                          <Label className="text-xs text-muted-foreground mb-2 block">{t('quickLocations')}</Label>
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
                            <Label htmlFor="teleport-x">X</Label>
                            <Input
                              id="teleport-x"
                              type="number"
                              value={teleportX}
                              onChange={(e) => setTeleportX(e.target.value)}
                              placeholder={t('placeholders.x')}
                              min={0}
                              max={24000}
                            />
                          </div>
                          <div>
                            <Label htmlFor="teleport-y">Y</Label>
                            <Input
                              id="teleport-y"
                              type="number"
                              value={teleportY}
                              onChange={(e) => setTeleportY(e.target.value)}
                              placeholder={t('placeholders.y')}
                              min={0}
                              max={24000}
                            />
                          </div>
                          <div>
                            <Label htmlFor="teleport-z">Z</Label>
                            <Input
                              id="teleport-z"
                              type="number"
                              value={teleportZ}
                              onChange={(e) => setTeleportZ(e.target.value)}
                              placeholder={t('placeholders.z')}
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
                          {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                          {t('actions.teleport')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
                ) : null}

                {/* Secondary actions — less frequent operations */}
                <div className="pt-4 mt-2 border-t border-border/30">
                  <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground/80">
                    <span className="text-primary/70">//</span>
                    <span>{t('standaloneOps')}</span>
                    <span className="h-px flex-1 bg-border/40" aria-hidden="true" />
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  {/* Voice Ban */}
                  <Dialog open={voiceBanDialogOpen} onOpenChange={setVoiceBanDialogOpen}>
                    <DialogTrigger asChild>
                      <button type="button" title={t('actions.voiceBanTooltip')} className="block h-auto w-full p-0 text-left">
                        <ActionTile icon={<MicOff className="w-4 h-4" />} label={t('actions.voiceBan')} compact />
                      </button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{t('voiceBan')}</DialogTitle>
                        <DialogDescription>
                          {t('dialogs.voiceBanDescription')}
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label>{t('labels.username')}</Label>
                          <Input
                            value={voiceBanUsername || selectedPlayer}
                            onChange={(e) => setVoiceBanUsername(e.target.value)}
                            placeholder={t('placeholders.enterUsername')}
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id="voiceBanEnabled"
                            checked={voiceBanEnabled}
                            onCheckedChange={(checked) => setVoiceBanEnabled(checked === true)}
                          />
                          <Label htmlFor="voiceBanEnabled">
                            {voiceBanEnabled ? t('dialogs.banFromVoice') : t('dialogs.unbanFromVoice')}
                          </Label>
                        </div>
                      </div>
                      <DialogFooter>
                        <Button
                          onClick={() => {
                            if (!voiceBanUsername) setVoiceBanUsername(selectedPlayer)
                            handleVoiceBan()
                          }}
                          disabled={loading || (!voiceBanUsername && !selectedPlayer)}
                        >
                          {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                          {voiceBanEnabled ? (
                            <><MicOff className="w-4 h-4 mr-2" /> {t('dialogs.mute')}</>
                          ) : (
                            <><Mic className="w-4 h-4 mr-2" /> {t('dialogs.unmute')}</>
                          )}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {/* SteamID Ban */}
                  <Dialog open={steamIdBanDialogOpen} onOpenChange={setSteamIdBanDialogOpen}>
                    <DialogTrigger asChild>
                      <button type="button" title={t('actions.steamIdBanTooltip')} className="block h-auto w-full p-0 text-left">
                        <ActionTile icon={<Ban className="w-4 h-4" />} label={t('actions.steamIdBan')} emphasis="danger" compact />
                      </button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                          <AlertTriangle className="w-5 h-5 text-destructive" />
                          {t('dialogs.banBySteamId')}
                        </DialogTitle>
                        <DialogDescription>
                          {t('dialogs.banBySteamIdDescription')}
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label>{t('steamId')}</Label>
                          <Input
                            value={banSteamId}
                            onChange={(e) => setBanSteamId(e.target.value)}
                            placeholder={t('placeholders.steamId')}
                          />
                        </div>
                        <div>
                          <Label>{t('labels.reasonOptional')}</Label>
                          <Input
                            value={steamBanReason}
                            onChange={(e) => setSteamBanReason(e.target.value)}
                            placeholder={t('placeholders.banReason')}
                          />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant="outline" onClick={() => setSteamIdBanDialogOpen(false)}>
                          {t('common:actions.cancel')}
                        </Button>
                        <Button
                          variant="destructive"
                          onClick={handleSteamIdBan}
                          disabled={loading || !banSteamId}
                        >
                          {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                          {t('dialogs.banSteamId')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {/* Add User */}
                  <Dialog open={addUserDialogOpen} onOpenChange={setAddUserDialogOpen}>
                    <DialogTrigger asChild>
                      <button type="button" title={t('actions.createUserTooltip')} className="block h-auto w-full p-0 text-left">
                        <ActionTile icon={<UserPlus className="w-4 h-4" />} label={t('actions.addUser')} compact />
                      </button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{t('actions.addUser')}</DialogTitle>
                        <DialogDescription>
                          {t('descriptions.createUserAccount')}
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label>{t('labels.username')}</Label>
                          <Input
                            value={addUserUsername}
                            onChange={(e) => setAddUserUsername(e.target.value)}
                            placeholder={t('placeholders.enterUsername')}
                            maxLength={64}
                          />
                        </div>
                        <div>
                          <Label>{t('labels.password')}</Label>
                          <Input
                            type="password"
                            value={addUserPassword}
                            onChange={(e) => setAddUserPassword(e.target.value)}
                            placeholder={t('placeholders.enterPassword')}
                            maxLength={128}
                          />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant="outline" onClick={() => setAddUserDialogOpen(false)}>
                          {t('common:actions.cancel')}
                        </Button>
                        <Button
                          onClick={handleAddUser}
                          disabled={loading || !addUserUsername.trim() || addUserPassword.length < 4}
                        >
                          {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                          {t('actions.addUser')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {/* Unban */}
                  <Dialog open={unbanDialogOpen} onOpenChange={setUnbanDialogOpen}>
                    <DialogTrigger asChild>
                      <button type="button" title={t('actions.unbanUsernameTooltip')} className="block h-auto w-full p-0 text-left">
                        <ActionTile icon={<UserPlus className="w-4 h-4" />} label={t('actions.unban')} compact />
                      </button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{t('actions.unban')}</DialogTitle>
                      </DialogHeader>
                      <div>
                        <Label htmlFor="unban-username">{t('labels.username')}</Label>
                        <Input
                          id="unban-username"
                          value={unbanUsername}
                          onChange={(e) => setUnbanUsername(e.target.value)}
                          placeholder={t('placeholders.usernameToUnban')}
                        />
                      </div>
                      <DialogFooter>
                        <Button onClick={handleUnban} disabled={loading || !unbanUsername}>
                          {t('actions.unban')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {/* Unban SteamID */}
                  <Dialog open={unbanSteamIdDialogOpen} onOpenChange={(open) => {
                    setUnbanSteamIdDialogOpen(open)
                    if (open) fetchBannedSteamIds()
                    else setUnbanSteamId('')
                  }}>
                    <DialogTrigger asChild>
                      <button type="button" title={t('actions.unbanSteamIdTooltip')} className="block h-auto w-full p-0 text-left">
                        <ActionTile icon={<UserPlus className="w-4 h-4" />} label={t('actions.unbanSteamId')} compact />
                      </button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{t('unbanSteamid')}</DialogTitle>
                      </DialogHeader>
                      <div className="space-y-3">
                        {bannedSteamIds.length > 0 && (
                          <div>
                            <Label>{t('selectBannedSteamid')}</Label>
                            <Select value={unbanSteamId} onValueChange={setUnbanSteamId}>
                              <SelectTrigger>
                                <SelectValue placeholder={loadingBans ? t('common:actions.loading') : t('placeholders.selectBannedSteamId')} />
                              </SelectTrigger>
                              <SelectContent>
                                {bannedSteamIds.map((ban) => (
                                  <SelectItem key={ban.steamId} value={ban.steamId}>
                                    {ban.steamId}
                                    {ban.banned_at && <span className="ml-2 text-xs text-muted-foreground">{new Date(ban.banned_at).toLocaleDateString()}</span>}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                        <div>
                          <Label htmlFor="unban-steamid">{bannedSteamIds.length > 0 ? t('dialogs.orEnterManually') : t('steamId')}</Label>
                          <Input
                            id="unban-steamid"
                            value={unbanSteamId}
                            onChange={(e) => setUnbanSteamId(e.target.value)}
                            placeholder={t('placeholders.steamIdToUnban')}
                          />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button onClick={handleUnbanSteamId} disabled={loading || !unbanSteamId}>
                          {t('actions.unbanSteamId')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
                </div>
              </TabsContent>
              {/* Spawn Tab — Items, Vehicles, XP */}
              <TabsContent value="spawn" className="space-y-3 mt-4">
                {/* Give Item */}
                <button
                  type="button"
                  onClick={() => setItemBrowserOpen(true)}
                  disabled={!selectedPlayer || loading}
                  className={cn(
                    'group w-full rounded-xl border bg-card/50 p-4 text-left',
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
                        {t('spawn.giveItems')}
                        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60 font-semibold">
                          {t('spawn.browser')}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {selectedPlayer
                          ? t('spawn.giveItemsDescription', { player: selectedPlayer })
                          : t('spawn.giveItemsDescriptionNoPlayer')}
                      </p>
                    </div>
                    <div className={cn(
                      'flex items-center gap-1 text-xs shrink-0',
                      'motion-safe:transition-all duration-150',
                      selectedPlayer && !loading
                        ? 'text-muted-foreground/60 group-hover:text-primary group-hover:translate-x-0.5'
                        : 'text-muted-foreground/30'
                    )}>
                      <span className="uppercase tracking-wider text-[10px] font-semibold">{t('browse')}</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </div>
                  </div>
                </button>

                {/* Spawn Vehicle */}
                <button
                  type="button"
                  onClick={() => setVehicleBrowserOpen(true)}
                  disabled={loading}
                  className={cn(
                    'group w-full rounded-xl border bg-card/50 p-4 text-left',
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
                        {t('spawn.spawnVehicles')}
                        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60 font-semibold">
                          {t('spawn.browser')}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {selectedPlayer
                          ? t('spawn.spawnVehiclesDescription', { player: selectedPlayer })
                          : t('spawn.spawnVehiclesDescriptionNoPlayer')}
                      </p>
                    </div>
                    <div className={cn(
                      'flex items-center gap-1 text-xs shrink-0',
                      'motion-safe:transition-all duration-150',
                      !loading
                        ? 'text-muted-foreground/60 group-hover:text-primary group-hover:translate-x-0.5'
                        : 'text-muted-foreground/30'
                    )}>
                      <span className="uppercase tracking-wider text-[10px] font-semibold">{t('browse')}</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </div>
                  </div>
                </button>

                {/* Give XP */}
                <div className="rounded-xl border border-border/60 bg-card/50 p-4 transition-colors">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="rounded-lg border border-primary/20 bg-primary/10 p-2 text-primary">
                      <TrendingUp className="w-5 h-5" />
                    </div>
                    <div>
                      <p className="font-medium">{t('giveXp')}</p>
                      <p className="text-xs text-muted-foreground">
                        {selectedPlayer ? t('spawn.grantExperienceTo', { player: selectedPlayer }) : t('spawn.grantExperienceToNoPlayer')}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-2">
                    <div className="flex-1 min-w-0">
                      <Select value={selectedPerk} onValueChange={setSelectedPerk}>
                        <SelectTrigger>
                          <SelectValue placeholder={t('placeholders.selectPerk')} />
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
                      <Label className="text-xs text-muted-foreground">{t('amount')}</Label>
                      <Input
                        type="number"
                        value={xpAmount}
                        onChange={(e) => setXpAmount(parseInt(e.target.value) || 0)}
                        min={1}
                        max={10000}
                      />
                    </div>
                    <Button
                      onClick={handleAddXp}
                      disabled={loading || !selectedPlayer || !selectedPerk}
                      size="sm"
                      className="shrink-0 sm:min-w-[100px]"
                    >
                      <TrendingUp className="w-4 h-4 mr-2" />
                      {t('spawn.giveXpButton')}
                    </Button>
                  </div>
                </div>
              </TabsContent>

              {/* Powers Tab */}
              <TabsContent value="powers" className="space-y-4 mt-4">
                <p className="text-sm text-muted-foreground">
                  {t('powers.toggleDescription', { player: selectedPlayer || t('empty.selectPlayer') })}
                </p>
                <div className="grid gap-3">
                  {/* God Mode */}
                  <div className="flex items-center justify-between rounded-xl border border-border/60 bg-card/50 p-4 transition-colors hover:bg-accent/30">
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg border border-primary/20 bg-primary/10 p-2 text-primary">
                        <Ghost className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="font-medium">{t('godMode')}</p>
                        <p className="text-xs text-muted-foreground">{t('invulnerableToDamage')}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {selectedPlayer && selectedPlayerPowers?.godMode !== undefined && (
                        <Badge variant={selectedPlayerPowers.godMode ? 'default' : 'secondary'} className="text-xs">
                          {selectedPlayerPowers.godMode ? t('powers.on') : t('powers.off')}
                        </Badge>
                      )}
                      <Button
                        variant={selectedPlayerPowers?.godMode ? 'default' : 'outline'}
                        size="sm"
                        disabled={!selectedPlayer || loading}
                        onClick={() => handleGodMode(!selectedPlayerPowers?.godMode)}
                      >
                        {selectedPlayerPowers?.godMode ? t('powers.disable') : t('powers.enable')}
                      </Button>
                    </div>
                  </div>

                  {/* Invisible */}
                  <div className="flex items-center justify-between rounded-xl border border-border/60 bg-card/50 p-4 transition-colors hover:bg-accent/30">
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg border border-primary/20 bg-primary/10 p-2 text-primary">
                        <Eye className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="font-medium">{t('invisible')}</p>
                        <p className="text-xs text-muted-foreground">{t('hiddenFromOtherPlayers')}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {selectedPlayer && selectedPlayerPowers?.invisible !== undefined && (
                        <Badge variant={selectedPlayerPowers.invisible ? 'default' : 'secondary'} className="text-xs">
                          {selectedPlayerPowers.invisible ? t('powers.on') : t('powers.off')}
                        </Badge>
                      )}
                      <Button
                        variant={selectedPlayerPowers?.invisible ? 'default' : 'outline'}
                        size="sm"
                        disabled={!selectedPlayer || loading}
                        onClick={() => handleInvisible(!selectedPlayerPowers?.invisible)}
                      >
                        {selectedPlayerPowers?.invisible ? t('powers.disable') : t('powers.enable')}
                      </Button>
                    </div>
                  </div>

                  {/* Noclip */}
                  <div className="flex items-center justify-between rounded-xl border border-border/60 bg-card/50 p-4 transition-colors hover:bg-accent/30">
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg border border-primary/20 bg-primary/10 p-2 text-primary">
                        <Layers className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="font-medium">{t('noclip')}</p>
                        <p className="text-xs text-muted-foreground">{t('walkThroughWalls')}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {selectedPlayer && selectedPlayerPowers?.noclip !== undefined && (
                        <Badge variant={selectedPlayerPowers.noclip ? 'default' : 'secondary'} className="text-xs">
                          {selectedPlayerPowers.noclip ? t('powers.on') : t('powers.off')}
                        </Badge>
                      )}
                      <Button
                        variant={selectedPlayerPowers?.noclip ? 'default' : 'outline'}
                        size="sm"
                        disabled={!selectedPlayer || loading}
                        onClick={() => handleNoclip(!selectedPlayerPowers?.noclip)}
                      >
                        {selectedPlayerPowers?.noclip ? t('powers.disable') : t('powers.enable')}
                      </Button>
                    </div>
                  </div>

                  {/* Heal */}
                  <div className="flex items-center justify-between rounded-xl border border-border/60 bg-card/50 p-4 transition-colors hover:bg-accent/30">
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg border border-green-500/20 bg-green-500/10 p-2 text-green-500">
                        <Heart className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="font-medium">{t('heal')}</p>
                        <p className="text-xs text-muted-foreground">{t('restoreFullHealthStats')}</p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!selectedPlayer || loading}
                      onClick={handleHealPlayer}
                    >
                      {t('heal')}
                    </Button>
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
                  <EmptyState type="noData" title={t('empty.selectPlayer')} />
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
                                <div className="text-muted-foreground text-xs">{t('totalPlaytime')}</div>
                                <div className="font-medium">{formatPlaytime(playerStats[selectedPlayer].total_playtime_seconds)}</div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <TrendingUp className="w-4 h-4 text-primary" />
                              <div>
                                <div className="text-muted-foreground text-xs">{t('sessions')}</div>
                                <div className="font-medium">{playerStats[selectedPlayer].session_count}</div>
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground text-xs">{t('firstSeen')}</div>
                              <div className="font-medium text-xs">{new Date(playerStats[selectedPlayer].first_seen).toLocaleDateString()}</div>
                            </div>
                            <div>
                              <div className="text-muted-foreground text-xs">{t('lastSeen')}</div>
                              <div className="font-medium text-xs">{new Date(playerStats[selectedPlayer].last_seen).toLocaleString()}</div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    )}

                    {/* Tags */}
                    <div className="space-y-2">
                      <Label className="text-sm font-medium flex items-center gap-2">
                        <Tag className="w-4 h-4" />
                        {t('notes.tags')}
                      </Label>
                      <div className="flex flex-wrap gap-2 min-h-[32px]">
                        {currentTags.map(tag => (
                          <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                            {tag}
                            <button
                              type="button"
                              onClick={() => removeTag(tag)}
                              className="ml-1 rounded p-1.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                              aria-label={t('aria.removeTag', { tag })}
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
                            placeholder={t('placeholders.addTag')}
                            className="h-8 w-28 text-xs"
                            maxLength={24}
                          />
                          <Button size="sm" variant="ghost" onClick={addTag} className="h-8 w-8 p-0" aria-label={t('actions.addTag')}>
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
                          <AlertTitle>{t('notesCouldNotBeLoaded')}</AlertTitle>
                          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <span className="min-w-0 break-words">{notesError}</span>
                            <Button variant="outline" size="sm" onClick={() => fetchNotesAndStats()} className="self-start">
                              <RefreshCw className="mr-2 h-4 w-4" /> {t('common:actions.retry')}
                            </Button>
                          </AlertDescription>
                        </Alert>
                      )}
                      <Label className="text-sm font-medium flex items-center gap-2">
                        <StickyNote className="w-4 h-4" />
                        {t('notes.adminNote')}
                      </Label>
                      <Textarea
                        value={currentNote}
                        onChange={(e) => setCurrentNote(e.target.value.slice(0, 1000))}
                        placeholder={t('placeholders.addNotes')}
                        className="min-h-[120px] resize-y"
                        maxLength={1000}
                      />
                      <p className="text-xs text-muted-foreground">{currentNote.length}/1000 {t('notes.characters')}</p>
                    </div>

                    {/* Actions */}
                    <div className="flex justify-between items-center pt-2">
                      <div className="text-xs text-muted-foreground">
                        {playerNotes[selectedPlayer]?.updated_at && (
                          <span>{t('notes.lastUpdated')} {new Date(playerNotes[selectedPlayer].updated_at).toLocaleString()}</span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        {playerNotes[selectedPlayer] && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleDeleteNote}
                            disabled={savingNote}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="w-4 h-4 mr-1" />
                            {t('common:actions.delete')}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          onClick={handleSaveNote}
                          disabled={savingNote || (!currentNote.trim() && currentTags.length === 0)}
                        >
                          {savingNote ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
                          {t('notes.saveNote')}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Activity Log */}
                <div className="pt-4 border-t space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium flex items-center gap-2">
                      <Clock className="w-4 h-4" />
                      {t('notes.activityLog')}
                    </h4>
                  </div>
                  {logsError && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>{t('activityLogUnavailable')}</AlertTitle>
                      <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <span className="min-w-0 break-words">{logsError}</span>
                        <Button variant="outline" size="sm" onClick={() => fetchActivityLogs(logPlayerFilter || undefined)} className="self-start">
                          <RefreshCw className="mr-2 h-4 w-4" /> {t('common:actions.retry')}
                        </Button>
                      </AlertDescription>
                    </Alert>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        placeholder={t('placeholders.filterByName')}
                        value={logPlayerFilter}
                        onChange={(e) => setLogPlayerFilter(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') fetchActivityLogs(logPlayerFilter || undefined)
                        }}
                        className="pl-9"
                        aria-label={t('actions.filterActivityLogs')}
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
                          <th className="text-left p-2 font-medium text-xs">{t('time')}</th>
                          <th className="text-left p-2 font-medium text-xs">{t('player')}</th>
                          <th className="text-left p-2 font-medium text-xs">{t('action')}</th>
                          <th className="text-left p-2 font-medium text-xs hidden sm:table-cell">{t('details')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {activityLogs.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="p-4 text-center text-muted-foreground text-sm">
                              {logsLoading ? t('common:actions.loading') : t('notes.noActivityLogs')}
                            </td>
                          </tr>
                        ) : (
                          activityLogs.map((log) => (
                            <tr key={log.id} className="hover:bg-muted/50">
                              <td className="p-2 whitespace-nowrap text-xs text-muted-foreground">
                                {new Date(log.logged_at).toLocaleString()}
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
                              </td>
                              <td className="max-w-[220px] p-2 text-xs text-muted-foreground break-words hidden sm:table-cell">
                                {log.details || '-'}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
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
              <AlertTitle className="text-warning">{t('bridgeOffline')}</AlertTitle>
              <AlertDescription>
                {t('importExport.bridgeRequired')}{' '}
                <Link to="/settings" className="text-primary underline hover:text-foreground">{t('openBridgeSetup')}</Link>
              </AlertDescription>
            </Alert>
          )}
          <div className={cn("grid grid-cols-1 md:grid-cols-2 gap-4", !bridgeConnected && 'opacity-60 pointer-events-none')}>
            {/* Export */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium flex items-center gap-2">
                <Download className="w-4 h-4" />
                {t('importExport.exportCharacter')}
              </h4>
              <p className="text-xs text-muted-foreground">{t('importExport.exportDescription')}</p>
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
                      title: t('importExport.exportSuccess'),
                      description: t('importExport.exportSuccessDescription', { player: selectedPlayer }),
                    })
                  } catch (error) {
                    toast({
                      title: t('importExport.exportFailed'),
                      description: error instanceof Error ? error.message : t('importExport.exportFailedDescription'),
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
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Download className="w-4 h-4 mr-2" />
                )}
                {selectedPlayer ? t('importExport.exportPlayer', { player: selectedPlayer }) : t('importExport.exportPlayerFallback')}
              </Button>

              {characterData && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">{t('characterData')}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
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
                    <Download className="w-4 h-4 mr-2" />
                    {t('importExport.downloadFile')}
                  </Button>
                </div>
              )}
            </div>

            {/* Import */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium flex items-center gap-2">
                <Upload className="w-4 h-4" />
                {t('importExport.importCharacter')}
              </h4>
              <p className="text-xs text-muted-foreground">{t('importExport.importDescription')}</p>
              <Textarea
                value={importCharacterData}
                onChange={(e) => setImportCharacterData(e.target.value)}
                placeholder={t('importExport.pasteJsonPlaceholder')}
                className="h-24 resize-none font-mono text-xs"
              />
              <div className="flex gap-2">
                <Button
                  disabled={importing || !selectedPlayer || !importCharacterData.trim()}
                  onClick={async () => {
                    let data
                    try {
                      data = JSON.parse(importCharacterData)
                    } catch {
                      toast({
                        title: t('importExport.invalidJson'),
                        description: t('importExport.invalidJsonDescription'),
                        variant: 'destructive',
                      })
                      return
                    }

                    setImporting(true)
                    try {
                      const { panelBridgeApi } = await import('@/lib/api')
                      await panelBridgeApi.importCharacter(selectedPlayer, data)
                      toast({
                        title: t('importExport.importSuccess'),
                        description: t('importExport.importSuccessDescription', { player: selectedPlayer }),
                      })
                      setImportCharacterData('')
                    } catch (error) {
                      toast({
                        title: t('importExport.importFailed'),
                        description: error instanceof Error ? error.message : t('importExport.importFailedDescription'),
                        variant: 'destructive',
                      })
                    } finally {
                      setImporting(false)
                    }
                  }}
                  size="sm"
                  className="flex-1"
                >
                  {importing ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Upload className="w-4 h-4 mr-2" />
                  )}
                  {t('importExport.apply')}
                </Button>
                <label className="cursor-pointer">
                  <Button variant="outline" size="sm" asChild>
                    <span>
                      <Upload className="w-4 h-4 mr-1" />
                      {t('importExport.file')}
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
                            title: t('importExport.fileTooLarge'),
                            description: t('importExport.fileTooLargeDescription'),
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
              <p className="text-xs text-muted-foreground">{t('playerMustBeOnline')}</p>
            </div>
          </div>

          {/* Auto-export on login */}
          <div className="border-t border-border/40 pt-4 mt-2 space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <h4 className="text-sm font-medium">{t('autoexportOnLogin')}</h4>
                <p className="text-xs text-muted-foreground">{t('automaticallySaveACharacterBackupWhenPlayersJoinTheServer')}</p>
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
                    toast({ title: t('importExport.failedToUpdateSetting'), variant: 'destructive' })
                  }
                }}
              />
            </div>

            {savedExports.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-medium text-muted-foreground">{t('importExport.savedExports', { count: savedExports.length })}</h4>
                <ScrollArea className="max-h-[180px]">
                  <div className="space-y-1">
                    {savedExports.map((exp) => (
                      <div key={`${exp.username}-${exp.filename}`} className="flex items-center justify-between gap-2 rounded-md border border-border/40 px-3 py-1.5 text-xs">
                        <div className="min-w-0 flex-1">
                          <span className="font-medium">{exp.username}</span>
                          <span className="text-muted-foreground ml-2">{new Date(exp.timestamp).toLocaleString()}</span>
                          <span className="text-muted-foreground ml-2">({(exp.size / 1024).toFixed(1)} KB)</span>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            title={t('titles.download')}
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
                                toast({ title: t('importExport.downloadFailed'), variant: 'destructive' })
                              }
                            }}
                          >
                            <Download className="w-3 h-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                            title={t('actions.delete')}
                            onClick={async () => {
                              try {
                                await playersApi.deleteExport(exp.username, exp.filename)
                                setSavedExports(prev => prev.filter(e => e.filename !== exp.filename || e.username !== exp.username))
                              } catch {
                                toast({ title: t('importExport.deleteFailed'), variant: 'destructive' })
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
