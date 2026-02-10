import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Search,
  RefreshCw,
  Users,
  MapPin,
  Lock,
  Shield,
  Server,
  Globe,
  Loader2,
  AlertCircle,
  Filter,
  ArrowUpDown,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { EmptyState } from '@/components/EmptyState'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useToast } from '@/components/ui/use-toast'

interface GameServer {
  name: string
  ip: string
  port: number
  gamePort?: number
  players: number
  maxPlayers: number
  map: string
  version: string
  vac: boolean
  isPrivate: boolean
  os: string
  dedicated?: boolean
  bots?: number
  keywords?: string
  tags?: string[]
  ping?: number | null
}

type SortField = 'name' | 'players' | 'maxPlayers' | 'ping'
type SortDirection = 'asc' | 'desc'

export default function ServerFinder() {
  const [servers, setServers] = useState<GameServer[]>([])
  const [filteredServers, setFilteredServers] = useState<GameServer[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<string>('')
  const [cached, setCached] = useState(false)
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean>(true)
  const [stats, setStats] = useState({ totalPlayers: 0, activeServers: 0, totalCapacity: 0 })
  const [currentPage, setCurrentPage] = useState(1)
  const { toast } = useToast()

  // Filters
  const [searchQuery, setSearchQuery] = useState('')
  const [hideEmpty, setHideEmpty] = useState(false)
  const [hideFull, setHideFull] = useState(false)
  const [hidePrivate, setHidePrivate] = useState(false)
  const [showVacOnly, setShowVacOnly] = useState(false)
  const [versionFilter, setVersionFilter] = useState<string>('all')
  const [filtersOpen, setFiltersOpen] = useState(false)

  // Sorting
  const [sortField, setSortField] = useState<SortField>('players')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  // Pinging
  const [pingingServers, setPingingServers] = useState<Set<string>>(new Set())
  const [serverPings, setServerPings] = useState<Record<string, number | null>>({})
  
  // Pagination (client-side)
  const ITEMS_PER_PAGE = 50

  const fetchServers = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    setError(null)
    setCurrentPage(1) // Reset to page 1 on refresh

    try {
      const url = forceRefresh ? '/api/server-finder?refresh=true' : '/api/server-finder'
      const response = await fetch(url)
      const data = await response.json()

      if (!data.success) {
        throw new Error(data.error || 'Failed to fetch servers')
      }

      setServers(data.servers || [])
      setSource(data.source || 'unknown')
      setCached(data.cached || false)
      setApiKeyConfigured(data.apiKeyConfigured !== false)
      setStats({
        totalPlayers: data.totalPlayers || 0,
        activeServers: data.activeServers || 0,
        totalCapacity: data.totalCapacity || 0,
      })
      
      if (data.servers?.length > 0) {
        toast({
          title: data.cached ? 'Servers loaded (cached)' : 'Servers loaded',
          description: `Found ${data.count} servers with ${data.totalPlayers || 0} players online`,
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setError(message)
      toast({
        title: 'Error',
        description: message,
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [toast])

  // Initial fetch
  useEffect(() => {
    fetchServers()
  }, [fetchServers])

  // Apply filters and sorting
  useEffect(() => {
    let result = [...servers]

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      result = result.filter(
        s =>
          s.name.toLowerCase().includes(query) ||
          s.ip.includes(query) ||
          s.map?.toLowerCase().includes(query) ||
          s.keywords?.toLowerCase().includes(query)
      )
    }

    // Boolean filters
    if (hideEmpty) {
      result = result.filter(s => s.players > 0)
    }
    if (hideFull) {
      result = result.filter(s => s.players < s.maxPlayers)
    }
    if (hidePrivate) {
      result = result.filter(s => !s.isPrivate)
    }
    if (showVacOnly) {
      result = result.filter(s => s.vac)
    }
    // Version filter
    if (versionFilter && versionFilter !== 'all') {
      result = result.filter(s => s.version === versionFilter)
    }

    // Sorting
    result.sort((a, b) => {
      let aVal: number | string
      let bVal: number | string

      switch (sortField) {
        case 'name':
          aVal = a.name.toLowerCase()
          bVal = b.name.toLowerCase()
          break
        case 'players':
          aVal = a.players
          bVal = b.players
          break
        case 'maxPlayers':
          aVal = a.maxPlayers
          bVal = b.maxPlayers
          break
        case 'ping':
          aVal = serverPings[`${a.ip}:${a.port}`] ?? 9999
          bVal = serverPings[`${b.ip}:${b.port}`] ?? 9999
          break
        default:
          return 0
      }

      if (typeof aVal === 'string') {
        return sortDirection === 'asc'
          ? aVal.localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal)
      }

      return sortDirection === 'asc' ? aVal - (bVal as number) : (bVal as number) - aVal
    })

    setFilteredServers(result)
    // Reset to page 1 when filters change
    setCurrentPage(1)
  }, [servers, searchQuery, hideEmpty, hideFull, hidePrivate, showVacOnly, versionFilter, sortField, sortDirection, serverPings])

  // Compute available versions from servers
  const availableVersions = useMemo(() => {
    const versions = new Set<string>()
    servers.forEach(s => {
      if (s.version) versions.add(s.version)
    })
    return Array.from(versions).sort((a, b) => {
      // Sort versions descending (newest first)
      const aParts = a.split('.').map(Number)
      const bParts = b.split('.').map(Number)
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aVal = aParts[i] || 0
        const bVal = bParts[i] || 0
        if (aVal !== bVal) return bVal - aVal
      }
      return 0
    })
  }, [servers])

  // Calculate pagination from filtered servers
  const totalPages = Math.max(1, Math.ceil(filteredServers.length / ITEMS_PER_PAGE))
  const paginatedServers = filteredServers.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  )

  const goToPage = (page: number) => {
    const validPage = Math.max(1, Math.min(page, totalPages))
    setCurrentPage(validPage)
  }

  const pingServer = async (ip: string, port: number) => {
    const key = `${ip}:${port}`
    if (pingingServers.has(key)) return

    setPingingServers(prev => new Set([...prev, key]))

    try {
      const response = await fetch(`/api/server-finder/ping?ip=${ip}&port=${port}`)
      const data = await response.json()

      if (data.success && data.ping !== null) {
        setServerPings(prev => ({ ...prev, [key]: data.ping }))
      } else {
        setServerPings(prev => ({ ...prev, [key]: null }))
      }
    } catch {
      setServerPings(prev => ({ ...prev, [key]: null }))
    } finally {
      setPingingServers(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDirection(field === 'name' ? 'asc' : 'desc')
    }
  }

  const SortButton = ({ field, label }: { field: SortField; label: string }) => (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => toggleSort(field)}
      className="h-8 px-2 flex items-center gap-1"
    >
      {label}
      {sortField === field ? (
        sortDirection === 'asc' ? (
          <ChevronUp className="h-4 w-4" />
        ) : (
          <ChevronDown className="h-4 w-4" />
        )
      ) : (
        <ArrowUpDown className="h-4 w-4 opacity-50" />
      )}
    </Button>
  )

  const getPingColor = (ping: number | null | undefined) => {
    if (ping === null || ping === undefined) return 'text-muted-foreground'
    if (ping < 50) return 'text-green-500'
    if (ping < 100) return 'text-yellow-500'
    if (ping < 200) return 'text-orange-500'
    return 'text-red-500'
  }

  return (
    <div className="space-y-6 page-transition">
      {/* Header */}
      <PageHeader
        title="Server Finder"
        description="Browse Project Zomboid multiplayer servers"
        icon={<Globe className="w-5 h-5" />}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => fetchServers(false)} disabled={loading}>
              {loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              {cached ? 'Cached' : 'Refresh'}
            </Button>
            <Button onClick={() => fetchServers(true)} disabled={loading}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Force Refresh
            </Button>
          </div>
        }
      />

      {/* API Key Warning */}
      {!apiKeyConfigured && !loading && (
        <Card className="border-yellow-500/50 bg-yellow-500/10">
          <CardContent className="flex items-start gap-4 py-4">
            <AlertCircle className="h-6 w-6 text-yellow-500 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-yellow-600 dark:text-yellow-400">Steam API Key Required</p>
              <p className="text-sm text-muted-foreground">
                To browse Project Zomboid servers, you need to configure your Steam API key.
              </p>
              <ol className="text-sm text-muted-foreground list-decimal list-inside space-y-1 mt-2">
                <li>Go to <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Steam API Key page</a> and register for a key</li>
                <li>Go to <a href="/settings" className="text-primary hover:underline">Settings</a> and paste your API key in the "Steam Web API Key" field</li>
                <li>Click "Save Settings" and refresh this page</li>
              </ol>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4 stagger-in">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Servers</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{servers.length.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              {source === 'steam_api' ? 'via Steam API' : 'via Master Server'}
              {cached && ' (cached)'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Servers</CardTitle>
            <Globe className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.activeServers.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">with players online</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Players</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalPlayers.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">playing right now</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Showing</CardTitle>
            <Filter className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{filteredServers.length.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">matching filters</p>
          </CardContent>
        </Card>
      </div>

      {/* Search and Filters */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Search & Filters</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setFiltersOpen(!filtersOpen)}>
              <Filter className="h-4 w-4 mr-2" />
              {filtersOpen ? 'Hide Filters' : 'Show Filters'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, IP, map, or keywords..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {filtersOpen && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="hideEmpty"
                    checked={hideEmpty}
                    onCheckedChange={(checked) => setHideEmpty(checked === true)}
                  />
                  <Label htmlFor="hideEmpty" className="text-sm cursor-pointer">
                    Hide empty servers
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="hideFull"
                    checked={hideFull}
                    onCheckedChange={(checked) => setHideFull(checked === true)}
                  />
                  <Label htmlFor="hideFull" className="text-sm cursor-pointer">
                    Hide full servers
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="hidePrivate"
                    checked={hidePrivate}
                    onCheckedChange={(checked) => setHidePrivate(checked === true)}
                  />
                  <Label htmlFor="hidePrivate" className="text-sm cursor-pointer">
                    Hide private servers
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="showVacOnly"
                    checked={showVacOnly}
                    onCheckedChange={(checked) => setShowVacOnly(checked === true)}
                  />
                  <Label htmlFor="showVacOnly" className="text-sm cursor-pointer">
                    VAC secured only
                  </Label>
                </div>
              </div>

              <Separator className="my-4" />

              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <Label className="text-sm">Version:</Label>
                  <Select value={versionFilter} onValueChange={setVersionFilter}>
                    <SelectTrigger className="w-32">
                      <SelectValue placeholder="All versions" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All versions</SelectItem>
                      {availableVersions.map(v => (
                        <SelectItem key={v} value={v}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                
                <Separator orientation="vertical" className="h-6 hidden md:block" />
                
                <div className="flex items-center gap-2">
                  <Label className="text-sm">Sort by:</Label>
                  <Select value={sortField} onValueChange={(v) => setSortField(v as SortField)}>
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="players">Players</SelectItem>
                      <SelectItem value="name">Name</SelectItem>
                      <SelectItem value="maxPlayers">Max Players</SelectItem>
                      <SelectItem value="ping">Ping</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={sortDirection} onValueChange={(v) => setSortDirection(v as SortDirection)}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="asc">Ascending</SelectItem>
                      <SelectItem value="desc">Descending</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Error State */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="flex items-center gap-4 py-4">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <div>
              <p className="font-medium text-destructive">Failed to load servers</p>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
            <Button variant="outline" onClick={() => fetchServers()} className="ml-auto">
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Server List */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Server List</CardTitle>
            <div className="flex items-center gap-2">
              <SortButton field="name" label="Name" />
              <SortButton field="players" label="Players" />
              <SortButton field="ping" label="Ping" />
            </div>
          </div>
          <CardDescription>
            Click on a server to see more details or copy the address
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <span className="ml-3 text-muted-foreground">Loading servers...</span>
            </div>
          ) : filteredServers.length === 0 ? (
            <div className="text-center py-12">
              {servers.length === 0 ? (
                <EmptyState type="noResults" title="No servers found" description="Make sure your Steam API key is configured" />
              ) : (
                <EmptyState
                  type="noResults"
                  title="No servers match your filters"
                  description="Try adjusting your search filters or refresh the server list"
                  action={
                    <Button variant="link" onClick={() => {
                      setSearchQuery('')
                      setHideEmpty(false)
                      setHideFull(false)
                      setHidePrivate(false)
                      setShowVacOnly(false)
                    }}>
                      Clear all filters
                    </Button>
                  }
                />
              )}
            </div>
          ) : (
            <ScrollArea className="h-[600px]">
              <div className="space-y-2">
                {paginatedServers.map((server, index) => {
                  const serverKey = `${server.ip}:${server.port}`
                  const ping = serverPings[serverKey]
                  const isPinging = pingingServers.has(serverKey)

                  return (
                    <div
                      key={`${serverKey}-${index}`}
                      className="flex items-center gap-4 p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                    >
                      {/* Server Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-medium truncate">{server.name}</h3>
                          {server.isPrivate && (
                            <Tooltip>
                              <TooltipTrigger>
                                <Lock className="h-4 w-4 text-yellow-500" />
                              </TooltipTrigger>
                              <TooltipContent>Password Protected</TooltipContent>
                            </Tooltip>
                          )}
                          {server.vac && (
                            <Tooltip>
                              <TooltipTrigger>
                                <Shield className="h-4 w-4 text-blue-500" />
                              </TooltipTrigger>
                              <TooltipContent>VAC Secured</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Globe className="h-3 w-3" />
                            {server.ip}:{server.gamePort || server.port}
                          </span>
                          {server.map && (
                            <span className="flex items-center gap-1">
                              <MapPin className="h-3 w-3" />
                              {server.map}
                            </span>
                          )}
                          {server.version && (
                            <Badge variant="outline" className="text-xs">
                              v{server.version}
                            </Badge>
                          )}
                        </div>
                        {server.tags && server.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {server.tags.slice(0, 5).map((tag, i) => (
                              <Badge key={i} variant="secondary" className="text-xs px-1.5 py-0">
                                {tag}
                              </Badge>
                            ))}
                            {server.tags.length > 5 && (
                              <Badge variant="secondary" className="text-xs px-1.5 py-0">
                                +{server.tags.length - 5}
                              </Badge>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Players */}
                      <div className="flex items-center gap-2 px-3">
                        <Users className="h-4 w-4 text-muted-foreground" />
                        <span
                          className={
                            server.players >= server.maxPlayers
                              ? 'text-red-500 font-medium'
                              : server.players > 0
                              ? 'text-green-500 font-medium'
                              : 'text-muted-foreground'
                          }
                        >
                          {server.players}/{server.maxPlayers}
                        </span>
                      </div>

                      {/* Ping */}
                      <div className="w-16 text-center">
                        {isPinging ? (
                          <Loader2 className="h-4 w-4 animate-spin mx-auto text-muted-foreground" />
                        ) : ping !== undefined ? (
                          <span className={`text-sm font-medium ${getPingColor(ping)}`}>
                            {ping !== null ? `${ping}ms` : 'N/A'}
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation()
                              pingServer(server.ip, server.port)
                            }}
                            className="h-6 px-2 text-xs"
                          >
                            Ping
                          </Button>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="default"
                              size="sm"
                              className="h-7 px-2"
                              onClick={() => {
                                const addr = `${server.ip}:${server.gamePort || server.port}`
                                window.open(`steam://connect/${addr}`, '_self')
                              }}
                            >
                              Connect
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Launch game and connect to server</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          )}
        </CardContent>

        {/* Pagination Controls - Outside CardContent so always visible */}
        {filteredServers.length > ITEMS_PER_PAGE && (
          <div className="flex items-center justify-between p-4 border-t bg-card">
            <div className="text-sm text-muted-foreground">
              Showing {((currentPage - 1) * ITEMS_PER_PAGE) + 1} - {Math.min(currentPage * ITEMS_PER_PAGE, filteredServers.length)} of {filteredServers.length.toLocaleString()} servers
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(1)}
                disabled={currentPage <= 1}
              >
                <ChevronsLeft className="h-4 w-4" />
                First
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage <= 1}
              >
                <ChevronLeft className="h-4 w-4" />
                Prev
              </Button>
              <div className="flex items-center gap-2 px-2">
                <span className="text-sm font-medium">Page {currentPage} of {totalPages}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage >= totalPages}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(totalPages)}
                disabled={currentPage >= totalPages}
              >
                Last
                <ChevronsRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
