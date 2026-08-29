import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Search, RefreshCw, Loader2, X, AlertCircle, SearchX, LayoutGrid,
  Package, Car, User, Sparkles, Minus, Plus, RotateCw, HelpCircle,
} from 'lucide-react'
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { NumberInput } from '@/components/NumberInput'
import { cn } from '@/lib/utils'
import { panelBridgeApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useToast } from '@/components/ui/use-toast'
import {
  getItemGroup, GROUP_META, VEHICLE_CATEGORIES, fmtWeight,
  type CatalogItem,
} from './ItemPicker'
import {
  getVehicleType, TYPE_ORDER, TYPE_ICON, formatVehicleName,
  type CatalogVehicle,
} from './VehiclePicker'

export type SpawnMode = 'items' | 'vehicles'

interface SpawnBrowserProps {
  mode: SpawnMode
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Player receiving the spawn. Empty string = no player selected (disables spawn for items; vehicles allow it). */
  playerName: string
  /** Perform the spawn. Throws on failure. */
  onSpawn: (id: string, qty?: number) => Promise<void>
}

interface RecentEntry {
  id: string
  name: string
  qty: number
  at: number
}

const MAX_VISIBLE = 220
const MAX_RECENT = 8
const RECENT_KEY_PREFIX = 'pz-spawn-recent-'

/* ---------- shared helpers ---------- */

function loadRecent(mode: SpawnMode): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY_PREFIX + mode)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

function saveRecent(mode: SpawnMode, entries: RecentEntry[]) {
  try {
    localStorage.setItem(RECENT_KEY_PREFIX + mode, JSON.stringify(entries.slice(0, MAX_RECENT)))
  } catch {
    // storage quota / disabled — fine, ephemeral fallback
  }
}

/* ================================================================ */

export function SpawnBrowser({ mode, open, onOpenChange, playerName, onSpawn }: SpawnBrowserProps) {
  const isItems = mode === 'items'
  const { t, i18n } = useTranslation(['spawnBrowser', 'itemPicker', 'vehiclePicker'])
  const { toast } = useToast()

  // Catalog state
  const [items, setItems] = useState<CatalogItem[]>([])
  const [vehicles, setVehicles] = useState<CatalogVehicle[]>([])
  const [initialLoad, setInitialLoad] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scannedAt, setScannedAt] = useState<string | null>(null)

  // UI state
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [qty, setQty] = useState(1)
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const [spawning, setSpawning] = useState(false)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [recent, setRecent] = useState<RecentEntry[]>([])

  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const flashTimer = useRef<NodeJS.Timeout | null>(null)

  /* ---------- Data load ---------- */

  const loadCatalog = useCallback(async (signal?: AbortSignal) => {
    try {
      if (isItems) {
        const data = await panelBridgeApi.getCatalogItems()
        if (signal?.aborted) return
        setItems(data.items || [])
        setScannedAt(data.scannedAt)
      } else {
        const data = await panelBridgeApi.getCatalogVehicles()
        if (signal?.aborted) return
        setVehicles(data.vehicles || [])
        setScannedAt(data.scannedAt)
      }
    } catch {
      // No catalog yet — empty state will prompt a scan
    } finally {
      if (!signal?.aborted) setInitialLoad(false)
    }
  }, [isItems])

  // Lazy load on first open; also reset ephemeral state each open
  useEffect(() => {
    if (!open) return
    const ctrl = new AbortController()
    setInitialLoad(true)
    setScanError(null)
    setSearch('')
    setActiveCategory(null)
    setSelectedId(null)
    setQty(1)
    setHighlightIndex(-1)
    setRecent(loadRecent(mode))
    void loadCatalog(ctrl.signal)
    return () => ctrl.abort()
  }, [open, mode, loadCatalog])

  // Autofocus search on open (slight delay so Radix mounts first)
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => searchRef.current?.focus(), 80)
    return () => clearTimeout(timer)
  }, [open])

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current)
  }, [])

  useEffect(() => { setHighlightIndex(-1) }, [search, activeCategory])

  /* ---------- Scan ---------- */

  const handleScan = useCallback(async () => {
    if (scanning) return
    setScanning(true)
    setScanError(null)
    try {
      if (isItems) {
        const data = await panelBridgeApi.scanCatalogItems()
        setItems(data.items || [])
        setScannedAt(data.scannedAt)
        toast({ title: t('toastCatalogUpdatedTitle', { ns: 'itemPicker' }), description: t('toastCatalogUpdatedDesc', { ns: 'itemPicker', count: data.count || 0 }) })
      } else {
        const data = await panelBridgeApi.scanCatalogVehicles()
        setVehicles(data.vehicles || [])
        setScannedAt(data.scannedAt)
        toast({ title: t('toastCatalogUpdatedTitle', { ns: 'vehiclePicker' }), description: t('toastCatalogUpdatedDesc', { ns: 'vehiclePicker', count: data.count || 0 }) })
      }
    } catch (err: unknown) {
      const msg = getUserErrorMessage(err, t('scanFailed', { ns: isItems ? 'itemPicker' : 'vehiclePicker' }))
      setScanError(msg)
      toast({
        title: t('toastScanFailedTitle', { ns: isItems ? 'itemPicker' : 'vehiclePicker' }),
        description: msg.includes('Bridge not running')
          ? t('bridgeNotRunning', { ns: isItems ? 'itemPicker' : 'vehiclePicker' })
          : msg,
        variant: 'destructive',
      })
    } finally {
      setScanning(false)
    }
  }, [scanning, isItems, toast, t])

  /* ---------- Derived: non-vehicle items / category summary / filter ---------- */

  const nonVehicleItems = useMemo(
    () => items.filter(it => !VEHICLE_CATEGORIES.has(it.category)),
    [items]
  )

  const itemCategories = useMemo(() => {
    if (!isItems) return []
    const counts = new Map<string, number>()
    for (const it of nonVehicleItems) {
      const g = getItemGroup(it.category)
      counts.set(g, (counts.get(g) || 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([group, count]) => {
        const meta = GROUP_META[group] || GROUP_META['Other']
        return { raw: group, label: t(`groups.${group}`, { ns: 'itemPicker' }), order: meta.order, count, Icon: meta.icon }
      })
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
  }, [nonVehicleItems, isItems, t])

  const vehicleCategories = useMemo(() => {
    if (isItems) return []
    const counts = new Map<string, number>()
    for (const v of vehicles) {
      const vt = getVehicleType(v)
      counts.set(vt, (counts.get(vt) || 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([type, count]) => ({
        raw: type,
        label: t(`types.${type}`, { ns: 'vehiclePicker' }),
        order: TYPE_ORDER[type] ?? 99,
        count,
        Icon: TYPE_ICON[type] || Car,
      }))
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
  }, [vehicles, isItems, t])

  const categories = isItems ? itemCategories : vehicleCategories

  const { rows, totalFiltered, capped } = useMemo(() => {
    const q = search.toLowerCase().trim()

    if (isItems) {
      let filtered = nonVehicleItems
      if (activeCategory) filtered = filtered.filter(it => getItemGroup(it.category) === activeCategory)
      if (q) filtered = filtered.filter(it => it.id.toLowerCase().includes(q) || it.name.toLowerCase().includes(q))
      const total = filtered.length
      const isCapped = total > MAX_VISIBLE
      const sliced = [...(isCapped ? filtered.slice(0, MAX_VISIBLE) : filtered)]
      sliced.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
      return { rows: sliced.map(it => ({ kind: 'item' as const, it })), totalFiltered: total, capped: isCapped }
    } else {
      let filtered = vehicles
      if (activeCategory) filtered = filtered.filter(v => getVehicleType(v) === activeCategory)
      if (q) filtered = filtered.filter(v => v.id.toLowerCase().includes(q) || v.name.toLowerCase().includes(q))
      const total = filtered.length
      const isCapped = total > MAX_VISIBLE
      const sliced = [...(isCapped ? filtered.slice(0, MAX_VISIBLE) : filtered)]
      sliced.sort((a, b) => formatVehicleName(a).localeCompare(formatVehicleName(b)))
      return { rows: sliced.map(v => ({ kind: 'veh' as const, v })), totalFiltered: total, capped: isCapped }
    }
  }, [isItems, nonVehicleItems, vehicles, search, activeCategory])

  /* ---------- Selection lookups ---------- */

  const selectedRow = useMemo(() => {
    if (!selectedId) return null
    if (isItems) {
      const it = items.find(x => x.id === selectedId)
      return it ? { kind: 'item' as const, it } : null
    }
    const v = vehicles.find(x => x.id === selectedId)
    return v ? { kind: 'veh' as const, v } : null
  }, [selectedId, isItems, items, vehicles])

  /* ---------- Keyboard ---------- */

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (search) {
        e.preventDefault()
        setSearch('')
        return
      }
      // otherwise let Radix close
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIndex(prev => Math.min(prev + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIndex(prev => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter' && !e.shiftKey) {
      // If a selection is locked in and nothing is highlighted, spawn it directly
      if (highlightIndex < 0 && selectedId) {
        e.preventDefault()
        void handleSpawn(selectedId, isItems ? qty : undefined)
        return
      }
      const row = highlightIndex >= 0 ? rows[highlightIndex] : rows[0]
      if (row) {
        e.preventDefault()
        const id = row.kind === 'item' ? row.it.id : row.v.id
        setSelectedId(id)
        // Enter-enter to spawn: if already selected and nothing new, spawn
        if (selectedId === id) void handleSpawn(id, isItems ? qty : undefined)
      }
    } else if (e.key === 'Home') {
      e.preventDefault()
      setHighlightIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setHighlightIndex(rows.length - 1)
    }
  }

  useEffect(() => {
    if (highlightIndex < 0 || !listRef.current) return
    const el = listRef.current.querySelector(`[data-row-index="${highlightIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  /* ---------- Spawn action ---------- */

  const canSpawnItem = isItems && !!playerName
  const canSpawnVehicle = !isItems // vehicles don't strictly require playerName in current API
  const canSpawn = (isItems ? canSpawnItem : canSpawnVehicle) && !!selectedId && !spawning

  const handleSpawn = async (overrideId?: string, overrideQty?: number) => {
    const id = overrideId || selectedId
    if (!id || spawning) return
    if (isItems && !playerName) return

    const effectiveQty = overrideQty ?? (isItems ? qty : undefined)
    setSpawning(true)
    try {
      await onSpawn(id, effectiveQty)
      // success — keep dialog open, pulse the row, clear selection, refocus search
      const name = (() => {
        if (isItems) {
          const it = items.find(x => x.id === id)
          return it?.name || id
        }
        const v = vehicles.find(x => x.id === id)
        return v ? formatVehicleName(v) : id
      })()

      // flash the spawned row
      setFlashId(id)
      if (flashTimer.current) clearTimeout(flashTimer.current)
      flashTimer.current = setTimeout(() => setFlashId(null), 900)

      // update recents
      const entry: RecentEntry = { id, name, qty: effectiveQty || 1, at: Date.now() }
      const next = [entry, ...recent.filter(r => r.id !== id)].slice(0, MAX_RECENT)
      setRecent(next)
      saveRecent(mode, next)

      // clear selection so user can pick next — but keep qty so repeat giveaways are fast
      setSelectedId(null)
      searchRef.current?.focus()
      searchRef.current?.select()
    } catch {
      // parent shows its own toast via handleAction — keep selection so user can retry
    } finally {
      setSpawning(false)
    }
  }

  /* ---------- Render ---------- */

  const Hero = isItems ? Package : Car
  const modeLabel = isItems ? t('giveItemsTitle') : t('spawnVehicleTitle')
  const catalogEmpty = isItems ? nonVehicleItems.length === 0 : vehicles.length === 0
  const contextVerb = isItems ? t('givingTo') : t('spawningNear')
  const contextPlayer = playerName || '—'
  const activeCategoryLabel = categories.find(c => c.raw === activeCategory)?.label
  const activeLabel = activeCategoryLabel || (isItems ? t('allItems') : t('allVehicles'))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'p-0 gap-0 overflow-hidden border-border/70',
          'w-[min(1200px,95vw)] max-w-[min(1200px,95vw)]',
          'h-[min(780px,90vh)]',
          'grid grid-rows-[auto_auto_1fr_auto]'
        )}
        onKeyDown={handleKeyDown}
      >
        {/* ========== HEADER ========== */}
        <header className="flex items-center gap-3 border-b border-border/70 bg-card/60 px-5 h-14 shrink-0">
          <div className="flex items-center justify-center w-9 h-9 rounded-md border border-primary/25 bg-primary/10 text-primary shrink-0">
            <Hero className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground font-semibold leading-none">
              {modeLabel}
            </DialogTitle>
            <DialogDescription className="text-sm font-medium text-foreground leading-tight mt-0.5 flex items-center gap-1.5 min-w-0">
              <User className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
              <span className="text-muted-foreground text-[13px] shrink-0">{contextVerb}</span>
              <span className={cn(
                'truncate font-semibold',
                playerName ? 'text-primary' : 'text-muted-foreground/50'
              )}>
                {contextPlayer}
              </span>
              {scannedAt && (
                <span className="ml-auto text-[11px] text-muted-foreground/50 tabular-nums shrink-0 hidden sm:inline">
                  {t('scannedOn', { date: new Date(scannedAt).toLocaleDateString(i18n.language) })}
                </span>
              )}
            </DialogDescription>
          </div>
        </header>

        {/* ========== SEARCH BAR ========== */}
        <div className="flex items-center gap-2 border-b border-border/70 px-4 h-12 shrink-0 bg-background/50">
          <Search className="w-4 h-4 text-muted-foreground/60 shrink-0" />
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={
              catalogEmpty
                ? (isItems ? t('loadToScanItems') : t('loadToScanVehicles'))
                : (isItems
                  ? t('searchNItems', { count: nonVehicleItems.length.toLocaleString(i18n.language) })
                  : t('searchNVehicles', { count: vehicles.length.toLocaleString(i18n.language) }))
            }
            className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
            aria-label={isItems ? t('searchItemsAria') : t('searchVehiclesAria')}
            disabled={catalogEmpty}
          />
          {search && (
            <button
              type="button"
              onClick={() => { setSearch(''); searchRef.current?.focus() }}
              className="flex items-center justify-center w-6 h-6 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={t('clearSearchAria')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <div className="h-5 w-px bg-border/60 mx-1" aria-hidden />
          <Button
            variant="ghost"
            size="sm"
            onClick={handleScan}
            disabled={scanning}
            className="h-8 px-2.5 text-xs"
            // eslint-disable-next-line local/no-dead-disabled-title -- pure hint; disables only while a scan is already in flight (the spinner is the self-evident why). Triaged 2026-08-27.
            title={t('rescanTitle')}
          >
            {scanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            <span className="ml-1.5 hidden sm:inline">{catalogEmpty ? t('scan') : t('rescan')}</span>
          </Button>
        </div>

        {/* ========== BODY ========== */}
        <div className="grid grid-cols-[220px_1fr] min-h-0">
          {/* ----- Category sidebar ----- */}
          <aside className="border-r border-border/70 bg-card/40 overflow-y-auto overscroll-contain">
            <div className="sticky top-0 z-10 bg-card/80 backdrop-blur-sm px-3 pt-3 pb-1.5 text-[10px] uppercase tracking-[0.2em] font-semibold text-muted-foreground/60">
              {t('categories')}
            </div>

            <button
              type="button"
              onClick={() => setActiveCategory(null)}
              className={cn(
                'w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-left border-l-[3px]',
                'motion-safe:transition-colors duration-100',
                !activeCategory
                  ? 'bg-primary/12 text-primary border-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/10 border-transparent'
              )}
            >
              <LayoutGrid className="w-4 h-4 shrink-0" />
              <span className="flex-1 min-w-0 font-medium">
                {isItems ? t('allItems') : t('allVehicles')}
              </span>
              <span className="text-[10px] tabular-nums opacity-60">
                {(isItems ? nonVehicleItems.length : vehicles.length).toLocaleString(i18n.language)}
              </span>
            </button>

            <div className="h-px bg-border/40 mx-3 my-1.5" />

            {categories.map(cat => {
              const Icon = cat.Icon
              const isActive = activeCategory === cat.raw
              return (
                <button
                  key={cat.raw}
                  type="button"
                  onClick={() => setActiveCategory(cat.raw)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-left border-l-[3px]',
                    'motion-safe:transition-colors duration-100',
                    isActive
                      ? 'bg-primary/12 text-primary border-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent/10 border-transparent'
                  )}
                >
                  <Icon className={cn('w-4 h-4 shrink-0', isActive ? 'opacity-100' : 'opacity-70')} />
                  <span className="flex-1 min-w-0 truncate">{cat.label}</span>
                  <span className="text-[10px] tabular-nums opacity-50">{cat.count.toLocaleString(i18n.language)}</span>
                </button>
              )
            })}
          </aside>

          {/* ----- Results ----- */}
          <section className="flex flex-col min-h-0 min-w-0">
            {/* Active category ribbon */}
            <div className="flex items-center gap-2 border-b border-border/50 px-4 h-9 bg-muted/30 shrink-0">
              <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-muted-foreground/60">
                {activeLabel}
              </span>
              <span className="text-[11px] text-muted-foreground/40 tabular-nums">
                {t('resultsCount', { count: totalFiltered })}
              </span>
              {capped && (
                <span className="text-[10px] uppercase tracking-wider text-warning/80 font-semibold ml-auto">
                  {t('showingFirstN', { max: MAX_VISIBLE })}
                </span>
              )}
            </div>

            {/* Body scroll region */}
            <div
              ref={listRef}
              className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
              role="listbox"
              aria-label={isItems ? t('itemCatalogAria') : t('vehicleCatalogAria')}
            >
              {initialLoad ? (
                <div className="h-full flex items-center justify-center text-muted-foreground text-sm gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('loadingCatalog')}
                </div>
              ) : catalogEmpty ? (
                <EmptyCatalog
                  mode={mode}
                  scanning={scanning}
                  scanError={scanError}
                  onScan={handleScan}
                />
              ) : totalFiltered === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground py-10 px-6 text-center">
                  <SearchX className="w-8 h-8 mb-2 opacity-30" />
                  <p className="text-sm">
                    {search ? (isItems ? t('noItemsMatch', { search }) : t('noVehiclesMatch', { search })) : t('noResults')}
                  </p>
                  {activeCategory && (
                    <button
                      type="button"
                      onClick={() => setActiveCategory(null)}
                      className="mt-3 text-xs text-primary hover:underline"
                    >
                      {t('searchAcrossAllCategories')}
                    </button>
                  )}
                </div>
              ) : (
                <div>
                  {rows.map((row, idx) => {
                    const id = row.kind === 'item' ? row.it.id : row.v.id
                    const isSelected = id === selectedId
                    const isHighlighted = idx === highlightIndex
                    const isFlashing = id === flashId
                    return (
                      <ResultRow
                        key={id}
                        row={row}
                        index={idx}
                        isSelected={isSelected}
                        isHighlighted={isHighlighted}
                        isFlashing={isFlashing}
                        showCategoryIcon={!activeCategory}
                        onSelect={() => {
                          setSelectedId(id)
                          setHighlightIndex(idx)
                        }}
                        onDoubleSpawn={() => void handleSpawn(id, isItems ? qty : undefined)}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* ========== FOOTER / ACTION BAR ========== */}
        <footer className="border-t border-border/70 bg-card/50 shrink-0 min-w-0">
          {/* Recent rail */}
          {recent.length > 0 && (
            <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-4 h-10 overflow-x-auto overscroll-contain">
              <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-muted-foreground/60 shrink-0">
                {t('recent')}
              </span>
              <div className="flex items-center gap-1.5 min-w-0 w-max">
                {recent.map(r => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      if (isItems) setQty(r.qty)
                      void handleSpawn(r.id, isItems ? r.qty : undefined)
                    }}
                    disabled={spawning || (isItems && !playerName)}
                    className={cn(
                      'group flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-[11px] shrink-0',
                      'border-border/60 bg-background/40 text-foreground/90 hover:bg-primary/10 hover:border-primary/40 hover:text-primary',
                      'motion-safe:transition-colors duration-100',
                      'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-background/40 disabled:hover:border-border/60 disabled:hover:text-foreground/90'
                    )}
                    // eslint-disable-next-line local/no-dead-disabled-title -- pure hint naming the action ("Spawn X again"); when disabled for the isItems-without-a-player case, the actual reason is already surfaced visibly in this dialog's own hint row below (t('pickPlayerFirst')), so nothing is hidden. Triaged 2026-08-27.
                    title={isItems ? t('spawnAgainTitleWithQty', { name: r.name, qty: r.qty }) : t('spawnAgainTitle', { name: r.name })}
                  >
                    <RotateCw className="w-3 h-3 opacity-50 motion-safe:group-hover:opacity-100 motion-safe:transition-opacity" />
                    <span className="truncate max-w-[160px]">{r.name}</span>
                    {isItems && r.qty > 1 && (
                      <span className="tabular-nums text-muted-foreground/70 group-hover:text-primary/80">× {r.qty}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Action row */}
          <div className="flex items-center gap-3 px-4 py-3">
            {/* Selection summary */}
            <div className="flex-1 min-w-0">
              {selectedRow ? (
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-muted-foreground/60 leading-none">
                    {t('selected')}
                  </span>
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-sm font-medium truncate text-foreground">
                      {selectedRow.kind === 'item'
                        ? (selectedRow.it.name || selectedRow.it.id)
                        : formatVehicleName(selectedRow.v)}
                    </span>
                    <span className="text-[11px] font-mono text-muted-foreground/50 truncate">
                      {selectedRow.kind === 'item' ? selectedRow.it.id : selectedRow.v.id}
                    </span>
                  </div>
                </div>
              ) : (
                <span className="text-sm text-muted-foreground/60">
                  {catalogEmpty ? t('noCatalogLoadedYet') : t('pickSomethingFromList')}
                </span>
              )}
            </div>

            {/* Quantity stepper (items only) */}
            {isItems && (
              <div className="flex items-center gap-0 border border-border/70 rounded-md overflow-hidden shrink-0 bg-background/60">
                <button
                  type="button"
                  onClick={() => setQty(q => Math.max(1, q - 1))}
                  disabled={qty <= 1 || spawning}
                  className="h-9 w-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/10 disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:bg-accent/10"
                  aria-label={t('decreaseQuantityAria')}
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <NumberInput
                  value={qty}
                  onChange={n => {
                    if (Number.isFinite(n)) setQty(n)
                  }}
                  clamp={n => Math.max(1, Math.min(100, n))}
                  min={1}
                  max={100}
                  disabled={spawning}
                  className="h-9 w-12 rounded-none border-x border-y-0 border-border/70 bg-transparent px-0 text-center text-sm shadow-none tabular-nums focus-visible:bg-accent/10 focus-visible:ring-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  aria-label={t('quantityAria')}
                />
                <button
                  type="button"
                  onClick={() => setQty(q => Math.min(100, q + 1))}
                  disabled={qty >= 100 || spawning}
                  className="h-9 w-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/10 disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:bg-accent/10"
                  aria-label={t('increaseQuantityAria')}
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Spawn CTA */}
            <Button
              onClick={() => void handleSpawn()}
              disabled={!canSpawn}
              size="default"
              className="shrink-0 min-w-[140px] h-9"
            >
              {spawning ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t('sending')}
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-2" />
                  {isItems ? (qty > 1 ? t('giveWithQty', { qty }) : t('give')) : t('spawn')}
                </>
              )}
            </Button>
          </div>

          {/* Hint row */}
          <div className="flex items-center justify-between gap-3 px-4 pb-2 text-[10px] text-muted-foreground/50">
            <span>
              {isItems && !playerName
                ? t('pickPlayerFirst')
                : t('dialogStaysOpen')}
            </span>
            <span className="tabular-nums hidden sm:inline">
              {t('keyboardHint')}
            </span>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  )
}

/* ================================================================ */

interface ResultRowProps {
  row:
    | { kind: 'item'; it: CatalogItem }
    | { kind: 'veh'; v: CatalogVehicle }
  index: number
  isSelected: boolean
  isHighlighted: boolean
  isFlashing: boolean
  showCategoryIcon: boolean
  onSelect: () => void
  onDoubleSpawn: () => void
}

function ResultRow({
  row, index, isSelected, isHighlighted, isFlashing,
  showCategoryIcon, onSelect, onDoubleSpawn,
}: ResultRowProps) {
  const { t } = useTranslation('vehiclePicker')
  const isItem = row.kind === 'item'
  const id = isItem ? row.it.id : row.v.id

  // Icon for the row (item group icon, or vehicle type icon)
  const Icon = isItem
    ? (GROUP_META[getItemGroup(row.it.category)]?.icon || HelpCircle)
    : (TYPE_ICON[getVehicleType(row.v)] || Car)

  const name = isItem ? (row.it.name || row.it.id) : formatVehicleName(row.v)

  return (
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      data-row-index={index}
      onClick={onSelect}
      onDoubleClick={onDoubleSpawn}
      className={cn(
        'w-full flex items-center gap-3 px-4 py-2 text-left border-l-[3px]',
        'motion-safe:transition-colors duration-75',
        isSelected
          ? 'bg-primary/15 border-primary'
          : isHighlighted
            ? 'bg-accent/15 border-transparent'
            : 'border-transparent hover:bg-accent/10',
        isFlashing && 'motion-safe:animate-spawn-flash'
      )}
    >
      {showCategoryIcon && (
        <Icon className={cn(
          'w-4 h-4 shrink-0',
          isSelected ? 'text-primary' : 'text-muted-foreground/40'
        )} />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn(
            'text-sm font-medium truncate',
            isSelected ? 'text-primary' : 'text-foreground'
          )}>
            {name}
          </span>
          {isItem && row.it.weight > 0 && (
            <span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0 px-1.5 py-0.5 rounded bg-muted/40">
              {fmtWeight(row.it.weight)}
            </span>
          )}
          {!isItem && row.v.seats > 0 && (
            <span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0 px-1.5 py-0.5 rounded bg-muted/40">
              {t('seatsTitle', { count: row.v.seats })}
            </span>
          )}
          {!isItem && row.v.mass > 0 && (
            <span className="text-[10px] text-muted-foreground/50 tabular-nums shrink-0">
              {(row.v.mass / 1000).toFixed(1)}t
            </span>
          )}
        </div>
        <span className="text-[11px] text-muted-foreground/40 font-mono truncate block mt-0.5">
          {id}
        </span>
      </div>
    </button>
  )
}

/* ================================================================ */

interface EmptyCatalogProps {
  mode: SpawnMode
  scanning: boolean
  scanError: string | null
  onScan: () => void
}

function EmptyCatalog({ mode, scanning, scanError, onScan }: EmptyCatalogProps) {
  const { t } = useTranslation('spawnBrowser')
  const isItems = mode === 'items'
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-8 py-10">
      <div className="w-12 h-12 rounded-md border border-border/60 bg-muted/20 flex items-center justify-center mb-4">
        {isItems ? <Package className="w-5 h-5 text-muted-foreground/60" /> : <Car className="w-5 h-5 text-muted-foreground/60" />}
      </div>
      <p className="text-sm font-medium text-foreground mb-1">
        {isItems ? t('noItemsCachedYet') : t('noVehiclesCachedYet')}
      </p>
      <p className="text-[12px] text-muted-foreground max-w-xs leading-snug mb-4">
        {isItems ? t('scanItemsBody') : t('scanVehiclesBody')}
      </p>
      <Button onClick={onScan} disabled={scanning} size="sm">
        {scanning ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
        {scanning ? t('scanning') : (isItems ? t('scanItems') : t('scanVehicles'))}
      </Button>
      {scanError && (
        <p className="mt-3 text-[11px] text-destructive flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          {scanError}
        </p>
      )}
    </div>
  )
}
