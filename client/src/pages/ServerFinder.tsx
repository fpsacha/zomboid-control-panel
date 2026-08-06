import { useTranslation } from 'react-i18next';
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
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


import { apiFetch } from '@/lib/api'

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
  const { t } = useTranslation('serverFinder');
  
  
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
  const debouncedSearch = useDebouncedValue(searchQuery, 200)
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
      const response = await apiFetch(url.replace('/api', ''))
      const data = await response.json()

      if (!data.success) {
        throw new Error(data.error || t('errors.fetchFailed'))
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

      if (data.apiKeyConfigured === false) {
        setError(t('errors.steamApiKeyMissing'))
      }
      
      if (data.servers?.length > 0) {
        toast({
          title: data.cached ? t('toast.serversLoadedCached') : t('toast.serversLoaded'),
          description: t('toast.serversLoadedDescription', { count: data.count, players: data.totalPlayers || 0 }),
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t('errors.unknown')
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  // Initial fetch
  useEffect(() => {
    fetchServers()
  }, [fetchServers])

  // Apply filters and sorting
  useEffect(() => {
    let result = [...servers]

    // Search filter
    if (debouncedSearch) {
      const query = debouncedSearch.toLowerCase()
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
    // Only reset to page 1 when actual filters/sort change, not when pings update
  }, [servers, debouncedSearch, hideEmpty, hideFull, hidePrivate, showVacOnly, versionFilter, sortField, sortDirection]) // eslint-disable-line react-hooks/exhaustive-deps -- serverPings intentionally excluded to avoid pagination reset on ping updates

  useEffect(() => {
    setCurrentPage(1)
  }, [debouncedSearch, hideEmpty, hideFull, hidePrivate, showVacOnly, versionFilter, sortField, sortDirection])

  // Re-sort when pings arrive without resetting the current page
  useEffect(() => {
    if (sortField !== 'ping') return
    setFilteredServers(prev => {
      const sorted = [...prev]
      sorted.sort((a, b) => {
        const aVal = serverPings[`${a.ip}:${a.port}`] ?? 9999
        const bVal = serverPings[`${b.ip}:${b.port}`] ?? 9999
        return sortDirection === 'asc' ? aVal - bVal : bVal - aVal
      })
      return sorted
    })
  }, [serverPings, sortField, sortDirection])

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

  useEffect(() => {
    setCurrentPage(prev => Math.min(prev, totalPages))
  }, [totalPages])

  const paginatedServers = useMemo(() => filteredServers.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  ), [filteredServers, currentPage])

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
      aria-label={sortField === field
        ? t('labels.sortAriaCurrent', { label, direction: sortDirection === 'asc' ? t('labels.ascending') : t('labels.descending') })
        : t('labels.sortAria', { label })}
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
    if (ping < 50) return 'text-primary'
    if (ping < 100) return 'text-warning'
    if (ping < 200) return 'text-warning'
    return 'text-destructive'
  }

  return (
    <div className="space-y-6 page-transition">
      {/* Header */}
      <PageHeader
        title={t("title")}
        description={t("description")}
        icon={<Globe className="w-5 h-5" />}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => fetchServers(false)} disabled={loading}>
              {loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              {t('actions.refreshList')}
            </Button>
            <Button onClick={() => fetchServers(true)} disabled={loading}>
              <RefreshCw className="h-4 w-4 mr-2" />
              {t('actions.reloadFromSteam')}
            </Button>
          </div>
        }
      />

      {/* API Key Warning */}
      {!apiKeyConfigured && !loading && (
        <Card className="border-warning/40 bg-warning/10 shadow-sm">
          <CardContent className="flex items-start gap-4 py-4">
            <AlertCircle className="h-6 w-6 text-warning shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-warning">{t('errors.steamApiKeyMissing')}</p>
              <p className="text-sm text-muted-foreground">
                {t('errors.addApiKeyHint')}
              </p>
              <ol className="text-sm text-muted-foreground list-decimal list-inside space-y-1 mt-2">
                <li>{t('errors.goTo')} <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t('errors.registerKey')} <span className="sr-only">{t('errors.opensInNewTab')}</span></a> {t('errors.andRegister')}</li>
                <li>{t('errors.apiKeyInstructions', { Link: '/settings' })}</li>
                <li>{t('errors.saveAndRefresh')}</li>
              </ol>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      {(() => {
        const isFiltered = filteredServers.length !== servers.length
        const tiles = [
          {
            icon: Server,
            label: t('stats.totalServers'),
            value: servers.length.toLocaleString(),
            sub: `${source === 'steam_api' ? t('stats.viaSteamApi') : t('stats.viaMasterServer')}${cached ? ` · ${t('stats.cached')}` : ''}`,
            tone: 'muted' as const,
          },
          {
            icon: Globe,
            label: t('stats.activeServers'),
            value: stats.activeServers.toLocaleString(),
            sub: t('stats.withPlayersOnline'),
            tone: 'primary' as const,
          },
          {
            icon: Users,
            label: t('stats.totalPlayers'),
            value: stats.totalPlayers.toLocaleString(),
            sub: t('stats.playingNow'),
            tone: 'primary' as const,
          },
          {
            icon: Filter,
            label: t('stats.showing'),
            value: filteredServers.length.toLocaleString(),
            sub: isFiltered ? t('stats.filteredOf', { count: servers.length.toLocaleString() }) : t('stats.matchingFilters'),
            tone: isFiltered ? ('warning' as const) : ('muted' as const),
          },
        ]
        const toneClass = (tone: 'primary' | 'warning' | 'muted') =>
          tone === 'primary'
            ? 'border-primary/30 bg-primary/[0.06] text-primary'
            : tone === 'warning'
            ? 'border-warning/40 bg-warning/10 text-warning'
            : 'border-border/55 bg-muted/30 text-muted-foreground'
        return (
          <div className="grid gap-3 md:grid-cols-4 stagger-in">
            {tiles.map(({ icon: Icon, label, value, sub, tone }) => (
              <Card key={label}>
                <CardContent className="flex items-center gap-3 p-4">
                  <div className={`grid place-items-center w-10 h-10 rounded-md border shrink-0 ${toneClass(tone)}`} aria-hidden="true">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
                    <p className="text-xl font-semibold leading-tight tabular-nums">{value}</p>
                    {sub && <p className="text-[11px] text-muted-foreground/80 truncate">{sub}</p>}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )
      })()}

      {/* Search and Filters */}
      <Card className="border-border/70 bg-card/92 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">{t('filters.title')}</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setFiltersOpen(!filtersOpen)}>
              <Filter className="h-4 w-4 mr-2" />
              {filtersOpen ? t('filters.hide') : t('filters.show')}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('placeholders.search')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9"
              aria-label={t('labels.search')}
              maxLength={128}
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
                    {t('filters.hideEmpty')}
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="hideFull"
                    checked={hideFull}
                    onCheckedChange={(checked) => setHideFull(checked === true)}
                  />
                  <Label htmlFor="hideFull" className="text-sm cursor-pointer">
                    {t('filters.hideFull')}
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="hidePrivate"
                    checked={hidePrivate}
                    onCheckedChange={(checked) => setHidePrivate(checked === true)}
                  />
                  <Label htmlFor="hidePrivate" className="text-sm cursor-pointer">
                    {t('filters.hidePrivate')}
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="showVacOnly"
                    checked={showVacOnly}
                    onCheckedChange={(checked) => setShowVacOnly(checked === true)}
                  />
                  <Label htmlFor="showVacOnly" className="text-sm cursor-pointer">
                    {t('filters.vacOnly')}
                  </Label>
                </div>
              </div>

              <Separator className="my-4" />

              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <Label className="text-sm">{t('labels.version')}:</Label>
                  <Select value={versionFilter} onValueChange={setVersionFilter}>
                    <SelectTrigger className="w-32">
                      <SelectValue placeholder={t('placeholders.version')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('placeholders.version')}</SelectItem>
                      {availableVersions.map(v => (
                        <SelectItem key={v} value={v}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                
                <Separator orientation="vertical" className="h-6 hidden md:block" />
                
                <div className="flex items-center gap-2">
                  <Label className="text-sm">{t('labels.sortBy')}:</Label>
                  <Select value={sortField} onValueChange={(v) => setSortField(v as SortField)}>
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="players">{t('labels.players')}</SelectItem>
                      <SelectItem value="name">{t('labels.name')}</SelectItem>
                      <SelectItem value="maxPlayers">{t('labels.maxPlayers')}</SelectItem>
                      <SelectItem value="ping">{t('labels.ping')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={sortDirection} onValueChange={(v) => setSortDirection(v as SortDirection)}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="asc">{t('labels.ascending')}</SelectItem>
                      <SelectItem value="desc">{t('labels.descending')}</SelectItem>
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
        <Card className="border-destructive/40 bg-destructive/10 shadow-sm">
          <CardContent className="flex items-center gap-4 py-4">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <div>
              <p className="font-medium text-destructive">{t('errors.loadFailed')}</p>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
            <Button variant="outline" onClick={() => fetchServers()} className="ml-auto">
              {t('actions.tryAgain')}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Server List */}
      <Card className="border-border/70 bg-card/92 shadow-sm">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{t('serverList.title')}</CardTitle>
            <div className="flex items-center gap-2">
              <SortButton field="name" label={t('labels.name')} />
              <SortButton field="players" label={t('labels.players')} />
              <SortButton field="ping" label={t('labels.ping')} />
            </div>
          </div>
          <CardDescription>
            {t('serverList.description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <span className="ml-3 text-muted-foreground">{t('status.loading')}</span>
            </div>
          ) : filteredServers.length === 0 ? (
            <div className="text-center py-12">
              {servers.length === 0 ? (
                <EmptyState
                  type="noResults"
                  title={apiKeyConfigured ? t('empty.noPublicServers') : t('errors.steamApiKeyMissing')}
                  description={apiKeyConfigured ? t('empty.refreshLater') : t('empty.addApiKey')}
                />
              ) : (
                <EmptyState
                  type="noResults"
                  title={t('empty.noServers')}
                  description={t('empty.tryAdjusting')}
                  action={{
                    label: t('filters.clearAll'),
                    onClick: () => {
                      setSearchQuery('')
                      setHideEmpty(false)
                      setHideFull(false)
                      setHidePrivate(false)
                      setShowVacOnly(false)
                    }
                  }}
                />
              )}
            </div>
          ) : (
            <ScrollArea className="h-[400px] sm:h-[600px]">
              <div className="space-y-2">
                {paginatedServers.map((server, index) => {
                  const serverKey = `${server.ip}:${server.port}`
                  const ping = serverPings[serverKey]
                  const isPinging = pingingServers.has(serverKey)
                  const isFull = server.players >= server.maxPlayers && server.maxPlayers > 0
                  const hasPlayers = server.players > 0 && !isFull
                  const statusTone = isFull
                    ? 'border-destructive/40 bg-destructive/[0.08] text-destructive'
                    : hasPlayers
                    ? 'border-primary/30 bg-primary/[0.07] text-primary'
                    : 'border-border/50 bg-muted/40 text-muted-foreground'

                  return (
                    <div
                      key={`${serverKey}-${index}`}
                      className="flex items-center gap-3 p-3 rounded-lg border border-border/60 bg-card/70 hover:border-primary/30 hover:bg-accent/20 transition-colors"
                    >
                      {/* Leading status tile */}
                      <div className={`grid place-items-center w-9 h-9 rounded-md border shrink-0 ${statusTone}`} aria-hidden="true">
                        <Server className="h-4 w-4" />
                      </div>

                      {/* Server Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-medium truncate">{server.name}</h3>
                          {server.isPrivate && (
                            <Tooltip>
                              <TooltipTrigger>
                                <Lock className="h-4 w-4 text-warning" />
                              </TooltipTrigger>
                              <TooltipContent>{t('labels.passwordProtected')}</TooltipContent>
                            </Tooltip>
                          )}
                          {server.vac && (
                            <Tooltip>
                              <TooltipTrigger>
                                <Shield className="h-4 w-4 text-primary" />
                              </TooltipTrigger>
                              <TooltipContent>{t('labels.vacSecured')}</TooltipContent>
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
                              <MapPin className="h-3 w-3 shrink-0" />
                              <span className="truncate">{server.map}</span>
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
                              <Badge key={i} variant="secondary" className="text-xs px-1.5 py-0 max-w-[150px] truncate">
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
                                ? 'text-destructive font-medium'
                              : server.players > 0
                                ? 'text-primary font-medium'
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
                            {ping !== null ? `${ping}ms` : t('labels.notAvailable')}
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation()
                              pingServer(server.ip, server.port)
                            }}
                            className="h-9 px-3 text-xs"
                          >
                            {t('labels.pingAction')}
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
                              {t('labels.connect')}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{t('labels.connectTooltip')}</TooltipContent>
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
              {t('pagination.showing', { start: ((currentPage - 1) * ITEMS_PER_PAGE) + 1, end: Math.min(currentPage * ITEMS_PER_PAGE, filteredServers.length), count: filteredServers.length.toLocaleString() })}
            </div>
            <nav aria-label={t('labels.pagination')} className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(1)}
                disabled={currentPage <= 1}
                aria-label={t('labels.firstPage')}
              >
                <ChevronsLeft className="h-4 w-4" />
                {t('pagination.first')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage <= 1}
                aria-label={t('labels.prevPage')}
              >
                <ChevronLeft className="h-4 w-4" />
                {t('pagination.previous')}
              </Button>
              <div className="flex items-center gap-2 px-2" aria-current="page">
                <span className="text-sm font-medium">{t('pagination.page', { current: currentPage, total: totalPages })}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage >= totalPages}
                aria-label={t('labels.nextPage')}
              >
                {t('pagination.next')}
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(totalPages)}
                disabled={currentPage >= totalPages}
                aria-label={t('labels.lastPage')}
              >
                {t('pagination.last')}
                <ChevronsRight className="h-4 w-4" />
              </Button>
            </nav>
          </div>
        )}
      </Card>
    </div>
  )
}
