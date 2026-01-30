import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { 
  Users, 
  UserX, 
  Ban, 
  Shield, 
  UserPlus, 
  UserMinus,
  Car,
  Sparkles,
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
  Zap,
  ChevronRight,
  MoreHorizontal,
  StickyNote,
  Tag,
  X,
  Plus,
  Save,
  Trash2
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { 
  Select, 
  SelectContent, 
  SelectItem, 
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
import { playersApi } from '@/lib/api'

interface Player {
  name: string
  online: boolean
}

const ACCESS_LEVELS = ['admin', 'moderator', 'overseer', 'gm', 'observer', 'none']

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

export default function Players() {
  const [players, setPlayers] = useState<Player[]>([])
  const [vehicles, setVehicles] = useState<string[]>([])
  const [perks, setPerks] = useState<string[]>([])
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

  // Form states
  const [kickReason, setKickReason] = useState('')
  const [banReason, setBanReason] = useState('')
  const [banIp, setBanIp] = useState(false)
  const [accessLevel, setAccessLevel] = useState('')
  const [itemName, setItemName] = useState('')
  const [itemCount, setItemCount] = useState(1)
  const [selectedPerk, setSelectedPerk] = useState('')
  const [xpAmount, setXpAmount] = useState(100)
  const [selectedVehicle, setSelectedVehicle] = useState('')
  const [unbanUsername, setUnbanUsername] = useState('')
  
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
  
  // Ref for copy timeout cleanup
  const copiedTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  
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
  
  // Filter players by search term (memoized to avoid recalculation on every render)
  const filteredPlayers = useMemo(() => 
    players.filter(player => 
      player.name.toLowerCase().includes(playerSearchFilter.toLowerCase())
    ),
    [players, playerSearchFilter]
  )

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
    } catch (error) {
      console.error('Failed to fetch players:', error)
    }
  }, [])
  
  const fetchActivityLogs = useCallback(async (playerFilter?: string) => {
    setLogsLoading(true)
    try {
      const data = await playersApi.getActivityLogs(playerFilter, 200)
      if (data.logs) {
        setActivityLogs(data.logs)
      }
    } catch (error) {
      console.error('Failed to fetch activity logs:', error)
    } finally {
      setLogsLoading(false)
    }
  }, [])
  
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
        statsData.stats.forEach((s: PlayerStat) => { statsMap[s.playerName] = s })
      }
      setPlayerNotes(notesMap)
      setPlayerStats(statsMap)
    } catch (error) {
      console.error('Failed to fetch notes/stats:', error)
    } finally {
      setNotesLoading(false)
    }
  }, [])
  
  const handleSaveNote = async () => {
    if (!selectedPlayer) return
    setSavingNote(true)
    try {
      await playersApi.saveNote(selectedPlayer, currentNote, currentTags)
      toast({
        title: 'Note saved',
        description: `Note for ${selectedPlayer} has been saved`,
        variant: 'success' as const,
      })
      // Update local state
      setPlayerNotes(prev => ({
        ...prev,
        [selectedPlayer]: {
          playerName: selectedPlayer,
          note: currentNote,
          tags: currentTags,
          updated_at: new Date().toISOString()
        }
      }))
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save note',
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
        title: 'Note deleted',
        description: `Note for ${selectedPlayer} has been deleted`,
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
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete note',
        variant: 'destructive',
      })
    } finally {
      setSavingNote(false)
    }
  }
  
  const addTag = () => {
    const tag = newTag.trim().toLowerCase()
    if (tag && !currentTags.includes(tag)) {
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

  const fetchData = useCallback(async () => {
    try {
      const [vehiclesData, perksData] = await Promise.all([
        playersApi.getVehicles(),
        playersApi.getPerks()
      ])
      setVehicles(vehiclesData.vehicles || [])
      setPerks(perksData.perks || [])
    } catch (error) {
      console.error('Failed to fetch data:', error)
    } finally {
      setInitialLoading(false)
    }
  }, [])

  useEffect(() => {
    Promise.all([fetchPlayers(), fetchData(), fetchNotesAndStats()]).catch(err => {
      console.error('Failed to load initial data:', err)
    })
    const interval = setInterval(fetchPlayers, 15000)
    return () => clearInterval(interval)
  }, [fetchPlayers, fetchData, fetchNotesAndStats])
  
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
        title: 'Success',
        description: `${action} completed`,
        variant: 'success' as const,
      })
      fetchPlayers()
      closeDialog?.()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Action failed',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleKick = () => {
    if (!selectedPlayer) return
    handleAction('Kick player', () => playersApi.kick(selectedPlayer, kickReason), () => {
      setKickDialogOpen(false)
      setKickReason('')
    })
  }

  const handleBan = () => {
    if (!selectedPlayer) return
    handleAction('Ban player', () => playersApi.ban(selectedPlayer, banIp, banReason), () => {
      setBanDialogOpen(false)
      setBanConfirmOpen(false)
      setBanReason('')
      setBanIp(false)
    })
  }

  const handleUnban = () => {
    if (!unbanUsername) return
    handleAction('Unban player', () => playersApi.unban(unbanUsername), () => {
      setUnbanUsername('')
      setUnbanDialogOpen(false)
    })
  }

  const handleTeleport = () => {
    if (!teleportTarget || !teleportX || !teleportY) return
    handleAction('Teleport player', () => playersApi.teleport(teleportTarget, `${teleportX},${teleportY},${teleportZ || '0'}`), () => {
      setTeleportDialogOpen(false)
      setTeleportX('')
      setTeleportY('')
      setTeleportZ('0')
    })
  }

  const handleSteamIdBan = () => {
    if (!banSteamId) return
    handleAction('Ban SteamID', async () => {
      const response = await fetch('/api/rcon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: `banid ${banSteamId} ${steamBanReason ? `-r "${steamBanReason}"` : ''}` })
      })
      if (!response.ok) throw new Error('Failed to ban SteamID')
      return response.json()
    }, () => {
      setSteamIdBanDialogOpen(false)
      setBanSteamId('')
      setSteamBanReason('')
    })
  }

  const handleVoiceBan = () => {
    if (!voiceBanUsername) return
    handleAction(voiceBanEnabled ? 'Voice ban' : 'Voice unban', 
      () => playersApi.voiceBan(voiceBanUsername, voiceBanEnabled), () => {
        setVoiceBanDialogOpen(false)
        setVoiceBanUsername('')
      })
  }

  const handleAddUser = () => {
    if (!addUserUsername.trim() || !addUserPassword.trim()) {
      toast({
        title: 'Error',
        description: 'Username and password are required',
        variant: 'destructive',
      })
      return
    }
    if (addUserPassword.length < 4) {
      toast({
        title: 'Error',
        description: 'Password must be at least 4 characters',
        variant: 'destructive',
      })
      return
    }
    handleAction('Add user', () => playersApi.addUser(addUserUsername.trim(), addUserPassword), () => {
      setAddUserDialogOpen(false)
      setAddUserUsername('')
      setAddUserPassword('')
    })
  }

  const handleSetAccessLevel = () => {
    if (!selectedPlayer || !accessLevel) return
    handleAction('Set access level', () => playersApi.setAccessLevel(selectedPlayer, accessLevel))
  }

  const handleAddItem = () => {
    if (!itemName) return
    handleAction('Add item', () => playersApi.addItem(selectedPlayer || null, itemName, itemCount))
    setItemName('')
    setItemCount(1)
  }

  const handleAddXp = () => {
    if (!selectedPlayer || !selectedPerk) return
    handleAction('Add XP', () => playersApi.addXp(selectedPlayer, selectedPerk, xpAmount))
  }

  const handleAddVehicle = () => {
    if (!selectedVehicle) return
    handleAction('Spawn vehicle', () => playersApi.addVehicle(selectedVehicle, selectedPlayer || undefined))
  }

  const handleGodMode = (enabled: boolean) => {
    if (!selectedPlayer) return
    handleAction(enabled ? 'Enable god mode' : 'Disable god mode', 
      async () => {
        await playersApi.setGodMode(selectedPlayer, enabled)
        setPlayerPowers(prev => ({
          ...prev,
          [selectedPlayer]: { ...prev[selectedPlayer], godMode: enabled }
        }))
      })
  }

  const handleInvisible = (enabled: boolean) => {
    if (!selectedPlayer) return
    handleAction(enabled ? 'Enable invisible' : 'Disable invisible',
      async () => {
        await playersApi.setInvisible(selectedPlayer, enabled)
        setPlayerPowers(prev => ({
          ...prev,
          [selectedPlayer]: { ...prev[selectedPlayer], invisible: enabled }
        }))
      })
  }

  const handleNoclip = (enabled: boolean) => {
    if (!selectedPlayer) return
    handleAction(enabled ? 'Enable noclip' : 'Disable noclip',
      async () => {
        await playersApi.setNoclip(selectedPlayer, enabled)
        setPlayerPowers(prev => ({
          ...prev,
          [selectedPlayer]: { ...prev[selectedPlayer], noclip: enabled }
        }))
      })
  }

  // Get selected player's current powers
  const selectedPlayerPowers = selectedPlayer ? playerPowers[selectedPlayer] : null

  return (
    <div className="space-y-6 page-transition">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Players</h1>
          <p className="text-muted-foreground">Manage connected players and their permissions</p>
        </div>
        <div className="flex items-center gap-2">
          {lastRefresh && (
            <span className="text-xs text-muted-foreground">
              Updated {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <Button onClick={fetchPlayers} variant="outline" size="sm" className="gap-2">
            <RefreshCw className="w-4 h-4" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card className="bg-gradient-to-br from-green-500/10 to-green-600/5 border-green-500/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/20">
                <Users className="w-5 h-5 text-green-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{players.length}</p>
                <p className="text-xs text-muted-foreground">Online Now</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="bg-gradient-to-br from-blue-500/10 to-blue-600/5 border-blue-500/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/20">
                <TrendingUp className="w-5 h-5 text-blue-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{peakPlayers}</p>
                <p className="text-xs text-muted-foreground">Peak Today</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="bg-gradient-to-br from-purple-500/10 to-purple-600/5 border-purple-500/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/20">
                <Shield className="w-5 h-5 text-purple-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{selectedPlayer ? '1' : '0'}</p>
                <p className="text-xs text-muted-foreground">Selected</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="bg-gradient-to-br from-amber-500/10 to-amber-600/5 border-amber-500/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/20">
                <Clock className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">15s</p>
                <p className="text-xs text-muted-foreground">Auto Refresh</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Player List */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Users className="w-5 h-5" />
                Online Players
              </CardTitle>
              <Badge variant="secondary">{players.length}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search players..."
                value={playerSearchFilter}
                onChange={(e) => setPlayerSearchFilter(e.target.value)}
                className="pl-9"
              />
            </div>
            
            <ScrollArea className="h-[320px]">
              {initialLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                </div>
              ) : players.length === 0 ? (
                <div className="text-center py-8">
                  <Users className="w-12 h-12 mx-auto text-muted-foreground/30 mb-3" />
                  <p className="text-muted-foreground">No players online</p>
                </div>
              ) : filteredPlayers.length === 0 ? (
                <div className="text-center py-8">
                  <Search className="w-12 h-12 mx-auto text-muted-foreground/30 mb-3" />
                  <p className="text-muted-foreground">No matches for "{playerSearchFilter}"</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {filteredPlayers.map((player) => {
                    const isSelected = selectedPlayer === player.name
                    const powers = playerPowers[player.name]
                    const hasPowers = powers && (powers.godMode || powers.invisible || powers.noclip)
                    const note = playerNotes[player.name]
                    const stat = playerStats[player.name]
                    
                    return (
                      <div
                        key={player.name}
                        role="button"
                        tabIndex={0}
                        className={`group p-3 rounded-lg border cursor-pointer transition-all duration-200 ${
                          isSelected
                            ? 'bg-primary/10 border-primary shadow-sm'
                            : 'hover:bg-muted/50 border-transparent hover:border-border'
                        }`}
                        onClick={() => setSelectedPlayer(player.name)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setSelectedPlayer(player.name)
                          }
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                            <span className="font-medium">{player.name}</span>
                            {note && note.tags && note.tags.length > 0 && (
                              <div className="flex gap-1">
                                {note.tags.slice(0, 2).map(tag => (
                                  <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                                    {tag}
                                  </Badge>
                                ))}
                                {note.tags.length > 2 && (
                                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                                    +{note.tags.length - 2}
                                  </Badge>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            {stat && (
                              <span className="text-[10px] text-muted-foreground mr-1">
                                {formatPlaytime(stat.total_playtime_seconds)}
                              </span>
                            )}
                            {note && (
                              <StickyNote className="w-3 h-3 text-yellow-500" />
                            )}
                            {hasPowers && (
                              <div className="flex gap-0.5">
                                {powers.godMode && (
                                  <Badge variant="outline" className="px-1 py-0 text-[10px] bg-yellow-500/10 text-yellow-500 border-yellow-500/30">
                                    <Ghost className="w-3 h-3" />
                                  </Badge>
                                )}
                                {powers.invisible && (
                                  <Badge variant="outline" className="px-1 py-0 text-[10px] bg-blue-500/10 text-blue-500 border-blue-500/30">
                                    <Eye className="w-3 h-3" />
                                  </Badge>
                                )}
                                {powers.noclip && (
                                  <Badge variant="outline" className="px-1 py-0 text-[10px] bg-purple-500/10 text-purple-500 border-purple-500/30">
                                    <Layers className="w-3 h-3" />
                                  </Badge>
                                )}
                              </div>
                            )}
                            <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${isSelected ? 'rotate-90' : ''}`} />
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </ScrollArea>
            
            {/* Manual entry */}
            <div className="pt-3 border-t space-y-2">
              <Label className="text-xs text-muted-foreground">Or enter username manually:</Label>
              <Input
                placeholder="Username"
                value={selectedPlayer}
                onChange={(e) => setSelectedPlayer(e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        {/* Player Actions */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  {selectedPlayer ? (
                    <>
                      <div className="w-2 h-2 rounded-full bg-green-500" />
                      {selectedPlayer}
                    </>
                  ) : (
                    'Player Actions'
                  )}
                </CardTitle>
                <CardDescription>
                  {selectedPlayer ? 'Manage this player' : 'Select a player to manage'}
                </CardDescription>
              </div>
              
              {/* Quick Actions */}
              {selectedPlayer && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setKickDialogOpen(true)}
                    className="gap-1"
                  >
                    <UserX className="w-4 h-4" />
                    <span className="hidden sm:inline">Kick</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTeleportDialogOpen(true)}
                    className="gap-1"
                  >
                    <MapPin className="w-4 h-4" />
                    <span className="hidden sm:inline">Teleport</span>
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm">
                        <MoreHorizontal className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => handleGodMode(!selectedPlayerPowers?.godMode)}>
                        <Ghost className="w-4 h-4 mr-2" />
                        {selectedPlayerPowers?.godMode ? 'Disable' : 'Enable'} God Mode
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleInvisible(!selectedPlayerPowers?.invisible)}>
                        <Eye className="w-4 h-4 mr-2" />
                        {selectedPlayerPowers?.invisible ? 'Disable' : 'Enable'} Invisible
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleNoclip(!selectedPlayerPowers?.noclip)}>
                        <Layers className="w-4 h-4 mr-2" />
                        {selectedPlayerPowers?.noclip ? 'Disable' : 'Enable'} Noclip
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem 
                        onClick={() => handleAction('Add to whitelist', () => playersApi.addToWhitelist(selectedPlayer))}
                      >
                        <UserPlus className="w-4 h-4 mr-2" />
                        Add to Whitelist
                      </DropdownMenuItem>
                      <DropdownMenuItem 
                        onClick={() => handleAction('Remove from whitelist', () => playersApi.removeFromWhitelist(selectedPlayer))}
                      >
                        <UserMinus className="w-4 h-4 mr-2" />
                        Remove from Whitelist
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem 
                        onClick={() => setBanDialogOpen(true)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Ban className="w-4 h-4 mr-2" />
                        Ban Player
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </div>
            
            {/* Power Status Bar */}
            {selectedPlayer && selectedPlayerPowers && (selectedPlayerPowers.godMode || selectedPlayerPowers.invisible || selectedPlayerPowers.noclip) && (
              <div className="flex items-center gap-2 mt-2">
                <Zap className="w-4 h-4 text-yellow-500" />
                <span className="text-sm text-muted-foreground">Active powers:</span>
                {selectedPlayerPowers.godMode && (
                  <Badge variant="secondary" className="text-xs bg-yellow-500/10 text-yellow-600">God Mode</Badge>
                )}
                {selectedPlayerPowers.invisible && (
                  <Badge variant="secondary" className="text-xs bg-blue-500/10 text-blue-600">Invisible</Badge>
                )}
                {selectedPlayerPowers.noclip && (
                  <Badge variant="secondary" className="text-xs bg-purple-500/10 text-purple-600">Noclip</Badge>
                )}
              </div>
            )}
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="moderation">
              <TabsList className="grid grid-cols-7 w-full h-auto p-1">
                <TabsTrigger value="moderation" className="text-xs px-2">Moderation</TabsTrigger>
                <TabsTrigger value="items" className="text-xs px-2">Items & XP</TabsTrigger>
                <TabsTrigger value="vehicles" className="text-xs px-2">Vehicles</TabsTrigger>
                <TabsTrigger value="powers" className="text-xs px-2">Powers</TabsTrigger>
                <TabsTrigger value="import-export" className="text-xs px-2">Import/Export</TabsTrigger>
                <TabsTrigger value="notes" className="text-xs px-2">Notes</TabsTrigger>
                <TabsTrigger value="activity" className="text-xs px-2" onClick={() => fetchActivityLogs()}>Activity</TabsTrigger>
              </TabsList>

              {/* Moderation Tab */}
              <TabsContent value="moderation" className="space-y-4 mt-4">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {/* Kick */}
                  <Dialog open={kickDialogOpen} onOpenChange={setKickDialogOpen}>
                    <DialogTrigger asChild>
                      <Button variant="outline" disabled={!selectedPlayer} className="h-auto py-3 flex-col gap-1">
                        <UserX className="w-5 h-5" />
                        <span className="text-xs">Kick</span>
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Kick Player</DialogTitle>
                        <DialogDescription>
                          Kick {selectedPlayer} from the server
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label>Reason (optional)</Label>
                          <Input
                            value={kickReason}
                            onChange={(e) => setKickReason(e.target.value)}
                            placeholder="Enter reason..."
                          />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button onClick={handleKick} disabled={loading}>
                          {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                          Kick Player
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {/* Ban */}
                  <Dialog open={banDialogOpen} onOpenChange={setBanDialogOpen}>
                    <DialogTrigger asChild>
                      <Button variant="outline" disabled={!selectedPlayer} className="h-auto py-3 flex-col gap-1 hover:border-destructive hover:text-destructive">
                        <Ban className="w-5 h-5" />
                        <span className="text-xs">Ban</span>
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                          <AlertTriangle className="w-5 h-5 text-destructive" />
                          Ban Player
                        </DialogTitle>
                        <DialogDescription>
                          Ban {selectedPlayer} from the server
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label>Reason (optional)</Label>
                          <Input
                            value={banReason}
                            onChange={(e) => setBanReason(e.target.value)}
                            placeholder="Enter reason..."
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id="banIp"
                            checked={banIp}
                            onCheckedChange={(checked) => setBanIp(checked === true)}
                          />
                          <Label htmlFor="banIp">Also ban IP address</Label>
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant="outline" onClick={() => setBanDialogOpen(false)}>
                          Cancel
                        </Button>
                        <Button variant="destructive" onClick={() => setBanConfirmOpen(true)}>
                          Continue to Ban
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {/* Ban Confirmation */}
                  <AlertDialog open={banConfirmOpen} onOpenChange={setBanConfirmOpen}>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently ban <strong>{selectedPlayer}</strong> from the server
                          {banIp ? ' and their IP address' : ''}.
                          {banReason && <><br />Reason: {banReason}</>}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={handleBan}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                          Yes, Ban Player
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>

                  {/* Unban */}
                  <Dialog open={unbanDialogOpen} onOpenChange={setUnbanDialogOpen}>
                    <DialogTrigger asChild>
                      <Button variant="outline" className="h-auto py-3 flex-col gap-1">
                        <UserPlus className="w-5 h-5" />
                        <span className="text-xs">Unban</span>
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Unban Player</DialogTitle>
                      </DialogHeader>
                      <div>
                        <Label>Username</Label>
                        <Input
                          value={unbanUsername}
                          onChange={(e) => setUnbanUsername(e.target.value)}
                          placeholder="Enter username to unban..."
                        />
                      </div>
                      <DialogFooter>
                        <Button onClick={handleUnban} disabled={loading || !unbanUsername}>
                          Unban Player
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {/* Access Level */}
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button variant="outline" disabled={!selectedPlayer} className="h-auto py-3 flex-col gap-1">
                        <Shield className="w-5 h-5" />
                        <span className="text-xs">Access Level</span>
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Set Access Level</DialogTitle>
                        <DialogDescription>
                          Change access level for {selectedPlayer}
                        </DialogDescription>
                      </DialogHeader>
                      <div>
                        <Label>Access Level</Label>
                        <Select value={accessLevel} onValueChange={setAccessLevel}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select level..." />
                          </SelectTrigger>
                          <SelectContent>
                            {ACCESS_LEVELS.map((level) => (
                              <SelectItem key={level} value={level}>
                                {level.charAt(0).toUpperCase() + level.slice(1)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <DialogFooter>
                        <Button onClick={handleSetAccessLevel} disabled={loading || !accessLevel}>
                          Set Level
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {/* Teleport */}
                  <Dialog open={teleportDialogOpen} onOpenChange={setTeleportDialogOpen}>
                    <DialogTrigger asChild>
                      <Button variant="outline" disabled={!selectedPlayer} className="h-auto py-3 flex-col gap-1">
                        <MapPin className="w-5 h-5" />
                        <span className="text-xs">Teleport</span>
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-md">
                      <DialogHeader>
                        <DialogTitle>Teleport Player</DialogTitle>
                        <DialogDescription>
                          Teleport {selectedPlayer} to coordinates
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label>Target Player</Label>
                          <Input
                            value={teleportTarget || selectedPlayer}
                            onChange={(e) => setTeleportTarget(e.target.value)}
                            placeholder="Player to teleport"
                          />
                        </div>
                        
                        {/* Quick Location Presets */}
                        <div>
                          <Label className="text-xs text-muted-foreground mb-2 block">Quick Locations</Label>
                          <div className="grid grid-cols-4 gap-1">
                            {TELEPORT_PRESETS.map((preset) => (
                              <Button
                                key={preset.name}
                                variant="outline"
                                size="sm"
                                className="text-xs h-8"
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
                            <Label>X</Label>
                            <Input
                              type="number"
                              value={teleportX}
                              onChange={(e) => setTeleportX(e.target.value)}
                              placeholder="10500"
                            />
                          </div>
                          <div>
                            <Label>Y</Label>
                            <Input
                              type="number"
                              value={teleportY}
                              onChange={(e) => setTeleportY(e.target.value)}
                              placeholder="9700"
                            />
                          </div>
                          <div>
                            <Label>Z</Label>
                            <Input
                              type="number"
                              value={teleportZ}
                              onChange={(e) => setTeleportZ(e.target.value)}
                              placeholder="0"
                            />
                          </div>
                        </div>
                      </div>
                      <DialogFooter>
                        <Button 
                          onClick={() => {
                            if (!teleportTarget) setTeleportTarget(selectedPlayer)
                            handleTeleport()
                          }} 
                          disabled={loading || !teleportX || !teleportY}
                        >
                          {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                          Teleport
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {/* Voice Ban */}
                  <Dialog open={voiceBanDialogOpen} onOpenChange={setVoiceBanDialogOpen}>
                    <DialogTrigger asChild>
                      <Button variant="outline" className="h-auto py-3 flex-col gap-1">
                        <MicOff className="w-5 h-5" />
                        <span className="text-xs">Voice Ban</span>
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Voice Ban</DialogTitle>
                        <DialogDescription>
                          Mute or unmute a player's voice chat
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label>Username</Label>
                          <Input
                            value={voiceBanUsername || selectedPlayer}
                            onChange={(e) => setVoiceBanUsername(e.target.value)}
                            placeholder="Enter username..."
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id="voiceBanEnabled"
                            checked={voiceBanEnabled}
                            onCheckedChange={(checked) => setVoiceBanEnabled(checked === true)}
                          />
                          <Label htmlFor="voiceBanEnabled">
                            {voiceBanEnabled ? 'Ban from voice chat' : 'Unban from voice chat'}
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
                            <><MicOff className="w-4 h-4 mr-2" /> Mute</>
                          ) : (
                            <><Mic className="w-4 h-4 mr-2" /> Unmute</>
                          )}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {/* SteamID Ban */}
                  <Dialog open={steamIdBanDialogOpen} onOpenChange={setSteamIdBanDialogOpen}>
                    <DialogTrigger asChild>
                      <Button variant="outline" className="h-auto py-3 flex-col gap-1 hover:border-destructive hover:text-destructive">
                        <Ban className="w-5 h-5" />
                        <span className="text-xs">SteamID Ban</span>
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                          <AlertTriangle className="w-5 h-5 text-destructive" />
                          Ban by SteamID
                        </DialogTitle>
                        <DialogDescription>
                          Ban a player by their Steam ID (useful for offline bans)
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label>Steam ID</Label>
                          <Input
                            value={banSteamId}
                            onChange={(e) => setBanSteamId(e.target.value)}
                            placeholder="76561198XXXXXXXXX"
                          />
                        </div>
                        <div>
                          <Label>Reason (optional)</Label>
                          <Input
                            value={steamBanReason}
                            onChange={(e) => setSteamBanReason(e.target.value)}
                            placeholder="Enter ban reason..."
                          />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant="outline" onClick={() => setSteamIdBanDialogOpen(false)}>
                          Cancel
                        </Button>
                        <Button 
                          variant="destructive" 
                          onClick={handleSteamIdBan}
                          disabled={loading || !banSteamId}
                        >
                          {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                          Ban SteamID
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {/* Add User */}
                  <Dialog open={addUserDialogOpen} onOpenChange={setAddUserDialogOpen}>
                    <DialogTrigger asChild>
                      <Button variant="outline" className="h-auto py-3 flex-col gap-1">
                        <UserPlus className="w-5 h-5" />
                        <span className="text-xs">Add User</span>
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Add User</DialogTitle>
                        <DialogDescription>
                          Create a new user account for whitelist servers
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label>Username</Label>
                          <Input
                            value={addUserUsername}
                            onChange={(e) => setAddUserUsername(e.target.value)}
                            placeholder="Enter username..."
                          />
                        </div>
                        <div>
                          <Label>Password</Label>
                          <Input
                            type="password"
                            value={addUserPassword}
                            onChange={(e) => setAddUserPassword(e.target.value)}
                            placeholder="Enter password (min 4 characters)..."
                          />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant="outline" onClick={() => setAddUserDialogOpen(false)}>
                          Cancel
                        </Button>
                        <Button 
                          onClick={handleAddUser}
                          disabled={loading || !addUserUsername.trim() || addUserPassword.length < 4}
                        >
                          {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                          Add User
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
              </TabsContent>

              {/* Items & XP Tab */}
              <TabsContent value="items" className="space-y-4 mt-4">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Add Item */}
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Sparkles className="w-4 h-4" />
                        Add Item
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="grid grid-cols-3 gap-2">
                        <div className="col-span-2">
                          <Label className="text-xs">Item Name</Label>
                          <Input
                            value={itemName}
                            onChange={(e) => setItemName(e.target.value)}
                            placeholder="e.g., Base.Axe"
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Count</Label>
                          <Input
                            type="number"
                            value={itemCount}
                            onChange={(e) => setItemCount(parseInt(e.target.value) || 1)}
                            min={1}
                          />
                        </div>
                      </div>
                      <Button onClick={handleAddItem} disabled={loading || !itemName} size="sm" className="w-full">
                        <Sparkles className="w-4 h-4 mr-2" />
                        Give Item
                      </Button>
                    </CardContent>
                  </Card>

                  {/* Add XP */}
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <TrendingUp className="w-4 h-4" />
                        Add XP
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label className="text-xs">Perk</Label>
                          <Select value={selectedPerk} onValueChange={setSelectedPerk}>
                            <SelectTrigger>
                              <SelectValue placeholder="Select perk..." />
                            </SelectTrigger>
                            <SelectContent>
                              {perks.map((perk) => (
                                <SelectItem key={perk} value={perk}>
                                  {perk}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label className="text-xs">Amount</Label>
                          <Input
                            type="number"
                            value={xpAmount}
                            onChange={(e) => setXpAmount(parseInt(e.target.value) || 0)}
                            min={1}
                          />
                        </div>
                      </div>
                      <Button 
                        onClick={handleAddXp} 
                        disabled={loading || !selectedPlayer || !selectedPerk}
                        size="sm"
                        className="w-full"
                      >
                        <Sparkles className="w-4 h-4 mr-2" />
                        Give XP
                      </Button>
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>

              {/* Vehicles Tab */}
              <TabsContent value="vehicles" className="mt-4">
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Car className="w-4 h-4" />
                      Spawn Vehicle
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div>
                      <Label className="text-xs">Vehicle Type</Label>
                      <Select value={selectedVehicle} onValueChange={setSelectedVehicle}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select vehicle..." />
                        </SelectTrigger>
                        <SelectContent>
                          {vehicles.map((vehicle) => (
                            <SelectItem key={vehicle} value={vehicle}>
                              {vehicle.replace('Base.', '')}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button onClick={handleAddVehicle} disabled={loading || !selectedVehicle} size="sm">
                      <Car className="w-4 h-4 mr-2" />
                      Spawn Vehicle
                    </Button>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Powers Tab */}
              <TabsContent value="powers" className="space-y-4 mt-4">
                <p className="text-sm text-muted-foreground">
                  Toggle special abilities for {selectedPlayer || 'the selected player'}.
                </p>
                <div className="grid gap-3">
                  {/* God Mode */}
                  <div className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-yellow-500/10">
                        <Ghost className="w-5 h-5 text-yellow-500" />
                      </div>
                      <div>
                        <p className="font-medium">God Mode</p>
                        <p className="text-xs text-muted-foreground">Invulnerable to damage</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {selectedPlayer && selectedPlayerPowers?.godMode !== undefined && (
                        <Badge variant={selectedPlayerPowers.godMode ? 'default' : 'secondary'} className="text-xs">
                          {selectedPlayerPowers.godMode ? 'ON' : 'OFF'}
                        </Badge>
                      )}
                      <Button
                        variant={selectedPlayerPowers?.godMode ? 'default' : 'outline'}
                        size="sm"
                        disabled={!selectedPlayer || loading}
                        onClick={() => handleGodMode(!selectedPlayerPowers?.godMode)}
                      >
                        {selectedPlayerPowers?.godMode ? 'Disable' : 'Enable'}
                      </Button>
                    </div>
                  </div>
                  
                  {/* Invisible */}
                  <div className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-blue-500/10">
                        <Eye className="w-5 h-5 text-blue-500" />
                      </div>
                      <div>
                        <p className="font-medium">Invisible</p>
                        <p className="text-xs text-muted-foreground">Hidden from other players</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {selectedPlayer && selectedPlayerPowers?.invisible !== undefined && (
                        <Badge variant={selectedPlayerPowers.invisible ? 'default' : 'secondary'} className="text-xs">
                          {selectedPlayerPowers.invisible ? 'ON' : 'OFF'}
                        </Badge>
                      )}
                      <Button
                        variant={selectedPlayerPowers?.invisible ? 'default' : 'outline'}
                        size="sm"
                        disabled={!selectedPlayer || loading}
                        onClick={() => handleInvisible(!selectedPlayerPowers?.invisible)}
                      >
                        {selectedPlayerPowers?.invisible ? 'Disable' : 'Enable'}
                      </Button>
                    </div>
                  </div>
                  
                  {/* Noclip */}
                  <div className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-purple-500/10">
                        <Layers className="w-5 h-5 text-purple-500" />
                      </div>
                      <div>
                        <p className="font-medium">Noclip</p>
                        <p className="text-xs text-muted-foreground">Walk through walls</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {selectedPlayer && selectedPlayerPowers?.noclip !== undefined && (
                        <Badge variant={selectedPlayerPowers.noclip ? 'default' : 'secondary'} className="text-xs">
                          {selectedPlayerPowers.noclip ? 'ON' : 'OFF'}
                        </Badge>
                      )}
                      <Button
                        variant={selectedPlayerPowers?.noclip ? 'default' : 'outline'}
                        size="sm"
                        disabled={!selectedPlayer || loading}
                        onClick={() => handleNoclip(!selectedPlayerPowers?.noclip)}
                      >
                        {selectedPlayerPowers?.noclip ? 'Disable' : 'Enable'}
                      </Button>
                    </div>
                  </div>
                </div>
              </TabsContent>

              {/* Import/Export Tab */}
              <TabsContent value="import-export" className="space-y-4 mt-4">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Export */}
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Download className="w-4 h-4" />
                        Export Character
                      </CardTitle>
                      <CardDescription className="text-xs">
                        Export player's XP, perks, and skills
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
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
                              title: 'Character Exported',
                              description: `Exported character data for ${selectedPlayer}`,
                            })
                          } catch (error) {
                            toast({
                              title: 'Export Failed',
                              description: error instanceof Error ? error.message : 'Failed to export character',
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
                        Export {selectedPlayer || 'Player'}
                      </Button>
                      
                      {characterData && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium">Character Data</span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 w-6 p-0"
                              onClick={() => {
                                navigator.clipboard.writeText(characterData)
                                setCopied(true)
                                if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current)
                                copiedTimeoutRef.current = setTimeout(() => setCopied(false), 2000)
                              }}
                            >
                              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                            </Button>
                          </div>
                          <textarea
                            readOnly
                            value={characterData}
                            className="w-full h-32 p-2 text-xs font-mono bg-muted rounded border resize-none"
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
                            Download File
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                  
                  {/* Import */}
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Upload className="w-4 h-4" />
                        Import Character
                      </CardTitle>
                      <CardDescription className="text-xs">
                        Restore XP, perks, and skills
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <textarea
                        value={importCharacterData}
                        onChange={(e) => setImportCharacterData(e.target.value)}
                        placeholder='Paste character JSON here...'
                        className="w-full h-24 p-2 text-xs font-mono bg-background rounded border resize-none"
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
                                title: 'Invalid JSON',
                                description: 'The character data is not valid JSON format',
                                variant: 'destructive',
                              })
                              return
                            }
                            
                            setImporting(true)
                            try {
                              const { panelBridgeApi } = await import('@/lib/api')
                              await panelBridgeApi.importCharacter(selectedPlayer, data)
                              toast({
                                title: 'Character Imported',
                                description: `Applied character data to ${selectedPlayer}`,
                              })
                              setImportCharacterData('')
                            } catch (error) {
                              toast({
                                title: 'Import Failed',
                                description: error instanceof Error ? error.message : 'Failed to import character',
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
                          Apply
                        </Button>
                        <label className="cursor-pointer">
                          <Button variant="outline" size="sm" asChild>
                            <span>
                              <Upload className="w-4 h-4 mr-1" />
                              File
                            </span>
                          </Button>
                          <input
                            type="file"
                            accept=".json"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0]
                              if (file) {
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
                      <p className="text-xs text-muted-foreground">
                        Player must be online. Requires PanelBridge mod.
                      </p>
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>

              {/* Notes & Tags Tab */}
              <TabsContent value="notes" className="space-y-4 mt-4">
                {notesLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  </div>
                ) : !selectedPlayer ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <StickyNote className="w-12 h-12 mx-auto mb-3 opacity-50" />
                    <p>Select a player to view or add notes</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Player Stats Card */}
                    {playerStats[selectedPlayer] && (
                      <Card className="bg-muted/30">
                        <CardContent className="pt-4">
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                            <div className="flex items-center gap-2">
                              <Clock className="w-4 h-4 text-blue-500" />
                              <div>
                                <div className="text-muted-foreground text-xs">Total Playtime</div>
                                <div className="font-medium">{formatPlaytime(playerStats[selectedPlayer].total_playtime_seconds)}</div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <TrendingUp className="w-4 h-4 text-green-500" />
                              <div>
                                <div className="text-muted-foreground text-xs">Sessions</div>
                                <div className="font-medium">{playerStats[selectedPlayer].session_count}</div>
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground text-xs">First Seen</div>
                              <div className="font-medium text-xs">{new Date(playerStats[selectedPlayer].first_seen).toLocaleDateString()}</div>
                            </div>
                            <div>
                              <div className="text-muted-foreground text-xs">Last Seen</div>
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
                        Tags
                      </Label>
                      <div className="flex flex-wrap gap-2 min-h-[32px]">
                        {currentTags.map(tag => (
                          <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                            {tag}
                            <button
                              type="button"
                              onClick={() => removeTag(tag)}
                              className="ml-1 hover:bg-muted rounded p-0.5"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </Badge>
                        ))}
                        <div className="flex items-center gap-1">
                          <Input
                            value={newTag}
                            onChange={(e) => setNewTag(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                addTag()
                              }
                            }}
                            placeholder="Add tag..."
                            className="h-7 w-24 text-xs"
                          />
                          <Button size="sm" variant="ghost" onClick={addTag} className="h-7 w-7 p-0">
                            <Plus className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Common tags: trusted, suspicious, new, vip, builder, griefer, afk
                      </p>
                    </div>
                    
                    {/* Note */}
                    <div className="space-y-2">
                      <Label className="text-sm font-medium flex items-center gap-2">
                        <StickyNote className="w-4 h-4" />
                        Admin Note
                      </Label>
                      <textarea
                        value={currentNote}
                        onChange={(e) => setCurrentNote(e.target.value)}
                        placeholder="Add notes about this player..."
                        className="w-full min-h-[120px] px-3 py-2 text-sm rounded-md border border-input bg-background resize-y"
                      />
                    </div>
                    
                    {/* Actions */}
                    <div className="flex justify-between items-center pt-2">
                      <div className="text-xs text-muted-foreground">
                        {playerNotes[selectedPlayer]?.updated_at && (
                          <span>Last updated: {new Date(playerNotes[selectedPlayer].updated_at).toLocaleString()}</span>
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
                            Delete
                          </Button>
                        )}
                        <Button
                          size="sm"
                          onClick={handleSaveNote}
                          disabled={savingNote || (!currentNote && currentTags.length === 0)}
                        >
                          {savingNote ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
                          Save Note
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </TabsContent>

              {/* Activity Log Tab */}
              <TabsContent value="activity" className="space-y-4 mt-4">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      placeholder="Filter by player name..."
                      value={logPlayerFilter}
                      onChange={(e) => setLogPlayerFilter(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') fetchActivityLogs(logPlayerFilter || undefined)
                      }}
                      className="pl-9"
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fetchActivityLogs(logPlayerFilter || undefined)}
                    disabled={logsLoading}
                  >
                    {logsLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  </Button>
                </div>
                
                <div className="rounded-md border max-h-[350px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr>
                        <th className="text-left p-2 font-medium text-xs">Time</th>
                        <th className="text-left p-2 font-medium text-xs">Player</th>
                        <th className="text-left p-2 font-medium text-xs">Action</th>
                        <th className="text-left p-2 font-medium text-xs">Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {activityLogs.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="p-4 text-center text-muted-foreground text-sm">
                            {logsLoading ? 'Loading...' : 'No activity logs'}
                          </td>
                        </tr>
                      ) : (
                        activityLogs.map((log) => (
                          <tr key={log.id} className="hover:bg-muted/50">
                            <td className="p-2 whitespace-nowrap text-xs text-muted-foreground">
                              {new Date(log.logged_at).toLocaleString()}
                            </td>
                            <td className="p-2 font-medium text-xs">{log.player_name}</td>
                            <td className="p-2">
                              <Badge
                                variant="secondary"
                                className={`text-xs ${
                                  log.action === 'connect' ? 'bg-green-500/20 text-green-600' :
                                  log.action === 'disconnect' ? 'bg-red-500/20 text-red-600' :
                                  log.action === 'kick' ? 'bg-orange-500/20 text-orange-600' :
                                  log.action === 'ban' ? 'bg-red-600/20 text-red-700' :
                                  ''
                                }`}
                              >
                                {log.action}
                              </Badge>
                            </td>
                            <td className="p-2 text-xs text-muted-foreground truncate max-w-[150px]">
                              {log.details || '-'}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
