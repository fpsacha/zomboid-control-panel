import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  Search, RefreshCw, Loader2, X, ChevronDown, AlertCircle, SearchX,
  Sword, Crosshair, UtensilsCrossed, Heart, Shirt, HardHat, Wrench,
  Layers, Cog, Cpu, BookOpen, Package, Sprout, Home, Bomb, Trash2,
  Gamepad2, HelpCircle, LayoutGrid
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { panelBridgeApi } from '@/lib/api'
import { useToast } from '@/components/ui/use-toast'
import { useTranslation } from 'react-i18next'

export interface CatalogItem {
  id: string
  name: string
  category: string
  weight: number
}

interface ItemPickerProps {
  value: string
  onChange: (itemId: string) => void
  disabled?: boolean
  placeholder?: string
}

// PZ categories that are vehicles — filter out of item picker
export const VEHICLE_CATEGORIES = new Set(['Vehicle'])

// Consolidate PZ's 270+ display categories into ~15 usable groups
// Uses prefix matching — order matters (first match wins)
const CATEGORY_RULES: Array<{ match: (c: string) => boolean; group: string }> = [
  { match: c => c.startsWith('Clothing') || c.startsWith('Accessory') || c.startsWith('Frockin') || c === 'Appearance' || c.startsWith('AppearanceOr') || c === 'MaleBody', group: 'Clothing' },
  { match: c => c.startsWith('Weapon') || c.startsWith('Firearm') || c.includes('Weapon') || c.startsWith('BrokenWeapon') || c.startsWith('JunkWeapon'), group: 'Weapons' },
  { match: c => c.startsWith('Food') || c.startsWith('Beverage') || c.startsWith('Cooking') || c === 'Smoking', group: 'Food & Drink' },
  { match: c => c.startsWith('Ammo'), group: 'Ammo' },
  { match: c => c.startsWith('Literature') || c.startsWith('SkillBook') || c === 'Cartography', group: 'Books & Maps' },
  { match: c => c.startsWith('Container'), group: 'Containers' },
  { match: c => c.startsWith('ProtectiveGear'), group: 'Protective Gear' },
  { match: c => c.startsWith('Material'), group: 'Materials' },
  { match: c => c.startsWith('Tool'), group: 'Tools' },
  { match: c => c.startsWith('Electronics') || c === 'Communications' || c === 'Devices' || c === 'LightSource' || c === 'Security' || c === 'FireSource', group: 'Electronics' },
  { match: c => c.startsWith('FirstAid') || c.startsWith('Bandage') || c === 'Wound', group: 'Medical' },
  { match: c => c.startsWith('Gardening') || c === 'Farming' || c.startsWith('Animal') || c === 'Fishing' || c.startsWith('FishingOr') || c === 'Trapping' || c === 'Camping', group: 'Farming & Outdoors' },
  { match: c => c === 'Mechanics' || c.startsWith('VehicleMaintenance') || c === 'Tuning' || c === 'Paint', group: 'Vehicle Parts' },
  { match: c => c.startsWith('Furniture') || c.startsWith('Household') || c.startsWith('Memento') || c === 'Hidden', group: 'Household' },
  { match: c => c === 'Junk' || c.startsWith('JunkOr'), group: 'Junk' },
  { match: c => c.startsWith('Explosive'), group: 'Explosives' },
  { match: c => c === 'Sports' || c.startsWith('SportsOr') || c === 'Instrument' || c.startsWith('InstrumentOr') || c === 'Entertainment' || c === 'KeyRing', group: 'Misc' },
]

export function getItemGroup(rawCategory: string): string {
  if (!rawCategory) return 'Other'
  for (const rule of CATEGORY_RULES) {
    if (rule.match(rawCategory)) return rule.group
  }
  return 'Other'
}

export function fmtWeight(w: number): string {
  return parseFloat(w.toFixed(2)) + 'kg'
}

// Icon + display order for each group
export const GROUP_META: Record<string, { order: number; icon: typeof Sword }> = {
  'Weapons':            { order: 0,  icon: Sword },
  'Ammo':               { order: 1,  icon: Crosshair },
  'Food & Drink':       { order: 2,  icon: UtensilsCrossed },
  'Medical':            { order: 3,  icon: Heart },
  'Clothing':           { order: 4,  icon: Shirt },
  'Protective Gear':    { order: 5,  icon: HardHat },
  'Tools':              { order: 6,  icon: Wrench },
  'Materials':          { order: 7,  icon: Layers },
  'Vehicle Parts':      { order: 8,  icon: Cog },
  'Electronics':        { order: 9,  icon: Cpu },
  'Books & Maps':       { order: 10, icon: BookOpen },
  'Containers':         { order: 11, icon: Package },
  'Farming & Outdoors': { order: 12, icon: Sprout },
  'Household':          { order: 13, icon: Home },
  'Explosives':         { order: 14, icon: Bomb },
  'Junk':               { order: 15, icon: Trash2 },
  'Misc':               { order: 16, icon: Gamepad2 },
  'Other':              { order: 99, icon: HelpCircle },
}

export const GROUP_LABEL_KEYS: Record<string, string> = {
  'Weapons': 'weapons',
  'Ammo': 'ammo',
  'Food & Drink': 'foodDrink',
  'Medical': 'medical',
  'Clothing': 'clothing',
  'Protective Gear': 'protectiveGear',
  'Tools': 'tools',
  'Materials': 'materials',
  'Vehicle Parts': 'vehicleParts',
  'Electronics': 'electronics',
  'Books & Maps': 'booksMaps',
  'Containers': 'containers',
  'Farming & Outdoors': 'farmingOutdoors',
  'Household': 'household',
  'Explosives': 'explosives',
  'Junk': 'junk',
  'Misc': 'misc',
  'Other': 'other',
}

const MAX_VISIBLE = 150

export function ItemPicker({ value, onChange, disabled, placeholder }: ItemPickerProps) {
  const { t } = useTranslation('mods')
  const placeholderText = placeholder || t('picker.itemPlaceholder')
  const [items, setItems] = useState<CatalogItem[]>([])
  const [initialLoad, setInitialLoad] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const [scannedAt, setScannedAt] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [dropUp, setDropUp] = useState(false)
  const { toast } = useToast()

  // Load cached catalog on mount
  useEffect(() => {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const data = await panelBridgeApi.getCatalogItems()
        if (ctrl.signal.aborted) return
        setItems(data.items || [])
        setScannedAt(data.scannedAt)
      } catch {
        // No catalog yet
      } finally {
        if (!ctrl.signal.aborted) setInitialLoad(false)
      }
    })()
    return () => ctrl.abort()
  }, [])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => { setHighlightIndex(-1) }, [search, activeCategory])

  useEffect(() => {
    if (!open || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    setDropUp(window.innerHeight - rect.bottom < 420)
  }, [open])

  const handleScan = useCallback(async () => {
    if (scanning) return
    setScanning(true)
    setScanError(null)
    try {
      const data = await panelBridgeApi.scanCatalogItems()
      setItems(data.items || [])
      setScannedAt(data.scannedAt)
      toast({ title: t('picker.catalogUpdated'), description: t('picker.itemsFound', { count: data.count || 0 }) })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('picker.scanFailed')
      setScanError(msg)
      toast({
        title: t('picker.itemScanFailed'),
        description: msg.includes('Bridge not running')
          ? t('picker.bridgeRequired')
          : msg,
        variant: 'destructive',
      })
    } finally {
      setScanning(false)
    }
  }, [scanning, t, toast])

  // Filter out vehicles
  const nonVehicleItems = useMemo(
    () => items.filter(item => !VEHICLE_CATEGORIES.has(item.category)),
    [items]
  )

  // Build category sidebar data — consolidate 270+ raw categories into groups
  const categorySummary = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of nonVehicleItems) {
      const group = getItemGroup(item.category)
      counts.set(group, (counts.get(group) || 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([group, count]) => {
        const meta = GROUP_META[group] || GROUP_META['Other']
        return {
          raw: group,
          label: t(`picker.categories.${GROUP_LABEL_KEYS[group] || 'other'}`),
          order: meta.order,
          count,
          Icon: meta.icon,
        }
      })
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
  }, [nonVehicleItems, t])

  // Filter by search + category group
  const { visibleItems, totalFiltered, capped } = useMemo(() => {
    const q = search.toLowerCase().trim()
    let filtered = nonVehicleItems

    if (activeCategory) {
      filtered = filtered.filter(item => getItemGroup(item.category) === activeCategory)
    }
    if (q) {
      filtered = filtered.filter(
        item => item.id.toLowerCase().includes(q) || item.name.toLowerCase().includes(q)
      )
    }

    const total = filtered.length
    const isCapped = total > MAX_VISIBLE
    const visible = isCapped ? filtered.slice(0, MAX_VISIBLE) : filtered
    visible.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))

    return { visibleItems: visible, totalFiltered: total, capped: isCapped }
  }, [nonVehicleItems, search, activeCategory])

  const selectedItem = useMemo(() => items.find(i => i.id === value), [items, value])

  const handleSelect = (itemId: string) => {
    onChange(itemId)
    setOpen(false)
    setSearch('')
    setActiveCategory(null)
    setHighlightIndex(-1)
  }

  const handleClear = () => {
    onChange('')
    setSearch('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightIndex(prev => Math.min(prev + 1, visibleItems.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightIndex(prev => Math.max(prev - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (highlightIndex >= 0 && highlightIndex < visibleItems.length) {
          handleSelect(visibleItems[highlightIndex].id)
        } else if (visibleItems.length > 0) {
          handleSelect(visibleItems[0].id)
        }
        break
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        setHighlightIndex(-1)
        break
      case 'Home':
        e.preventDefault()
        setHighlightIndex(0)
        break
      case 'End':
        e.preventDefault()
        setHighlightIndex(visibleItems.length - 1)
        break
    }
  }

  // Scroll highlighted into view
  useEffect(() => {
    if (highlightIndex < 0 || !listRef.current) return
    const el = listRef.current.querySelector(`[data-item-index="${highlightIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  if (initialLoad) {
    return (
      <div className="flex items-center gap-2 h-11 sm:h-9 rounded-md border border-input bg-background px-3 text-sm">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground shrink-0" />
        <span className="text-muted-foreground truncate">{t('loadingCatalog')}</span>
      </div>
    )
  }

  if (nonVehicleItems.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex gap-2">
          <Input
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={t('picker.itemExample')}
            disabled={disabled || scanning}
            className="flex-1 min-w-0"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleScan}
            disabled={scanning || disabled}
            title={t('picker.scanItemsTitle')}
            className="shrink-0"
          >
            {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            <span className="ml-1.5 hidden sm:inline">{t('scan')}</span>
          </Button>
        </div>
        {scanError ? (
          <p className="text-[11px] text-destructive flex items-center gap-1">
            <AlertCircle className="w-3 h-3 shrink-0" />
            <span className="truncate">{scanError}</span>
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {scanning ? t('picker.scanningItems') : t('picker.enterItemOrScan')}
          </p>
        )}
      </div>
    )
  }

  const activeCategoryLabel = activeCategory
    ? t(`picker.categories.${GROUP_LABEL_KEYS[activeCategory] || 'other'}`)
    : t('picker.categories.all')
  const ActiveIcon = activeCategory ? (GROUP_META[activeCategory]?.icon || HelpCircle) : LayoutGrid

  return (
    <div ref={containerRef} className="relative" onKeyDown={handleKeyDown}>
      {/* Trigger */}
      <div
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? 'itempicker-listbox' : undefined}
        aria-activedescendant={highlightIndex >= 0 && visibleItems[highlightIndex] ? `itempicker-opt-${highlightIndex}` : undefined}
        aria-label={t('picker.selectItem')}
        tabIndex={disabled ? -1 : 0}
        className={cn(
          'flex items-center gap-2 h-11 sm:h-9 rounded-md border border-input bg-background px-3 text-sm cursor-pointer',
          'motion-safe:transition-colors duration-150',
          'hover:border-primary/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          open && 'border-primary/60 ring-1 ring-primary/20',
          disabled && 'opacity-50 cursor-not-allowed pointer-events-none'
        )}
        onClick={() => !disabled && setOpen(!open)}
      >
        <Package className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
        {selectedItem ? (
          <span className="flex-1 min-w-0 truncate">
            <span className="font-medium">{selectedItem.name || selectedItem.id}</span>
            {selectedItem.weight > 0 && (
              <span className="text-muted-foreground ml-1.5 text-xs">{fmtWeight(selectedItem.weight)}</span>
            )}
          </span>
        ) : value ? (
          <span className="flex-1 min-w-0 truncate text-foreground">{value}</span>
        ) : (
          <span className="flex-1 min-w-0 truncate text-muted-foreground">{placeholderText}</span>
        )}
        {value && !disabled && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); handleClear() }}
            className="-mr-1 flex items-center justify-center w-6 h-6 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring shrink-0 motion-safe:transition-colors"
            aria-label={t('picker.clearSelection')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        <ChevronDown
          className={cn(
            'w-3.5 h-3.5 text-muted-foreground shrink-0 motion-safe:transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </div>

      {/* Dropdown with category sidebar */}
      {open && (
        <div
          className={cn(
            'absolute z-50 rounded-lg border border-border bg-popover shadow-xl shadow-black/30',
            'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-[0.98] motion-safe:duration-150',
            dropUp ? 'bottom-full mb-1 motion-safe:slide-in-from-bottom-1' : 'top-full mt-1 motion-safe:slide-in-from-top-1'
          )}
          style={{ width: 'min(90vw, 760px)', minWidth: '100%' }}
        >
          {/* Search bar */}
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('picker.searchItems', { count: nonVehicleItems.length.toLocaleString() })}
              className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
              aria-label={t('picker.filterItems')}
              autoFocus
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-foreground shrink-0 motion-safe:transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={e => { e.stopPropagation(); handleScan() }}
              disabled={scanning}
              className="h-8 w-8 p-0 shrink-0"
              title={t('picker.rescanItems')}
            >
              {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            </Button>
          </div>

          {/* Category sidebar + item list */}
          <div className="flex" style={{ maxHeight: 'min(520px, 60vh)' }}>
            {/* Sidebar */}
            <div className="w-[210px] shrink-0 border-r border-border/50 overflow-y-auto overscroll-contain py-1.5">
              <button
                type="button"
                onClick={() => setActiveCategory(null)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2.5 text-[13px]',
                  'motion-safe:transition-colors duration-100',
                  !activeCategory
                    ? 'bg-primary/12 text-primary border-l-[3px] border-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/8 border-l-[3px] border-transparent'
                )}
              >
                <LayoutGrid className="w-4 h-4 shrink-0" />
                <span className="flex-1 min-w-0 font-medium">{t('allItems')}</span>
                <span className="text-[11px] tabular-nums opacity-60">{nonVehicleItems.length.toLocaleString()}</span>
              </button>

              <div className="h-px bg-border/30 mx-3 my-1.5" />

              {categorySummary.map(cat => {
                const CatIcon = cat.Icon
                return (
                  <button
                    key={cat.raw}
                    type="button"
                    onClick={() => setActiveCategory(cat.raw)}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-3 py-2 text-[13px]',
                      'motion-safe:transition-colors duration-100',
                      activeCategory === cat.raw
                        ? 'bg-primary/12 text-primary border-l-[3px] border-primary'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent/8 border-l-[3px] border-transparent'
                    )}
                  >
                    <CatIcon className="w-4 h-4 shrink-0 opacity-70" />
                    <span className="flex-1 min-w-0">{cat.label}</span>
                    <span className="text-[11px] tabular-nums opacity-50">{cat.count.toLocaleString()}</span>
                  </button>
                )
              })}
            </div>

            {/* Items */}
            <div className="flex-1 min-w-0 overflow-y-auto overscroll-contain" role="listbox" id="itempicker-listbox" aria-label={t('picker.itemList')}>
              {/* Category header */}
              <div className="sticky top-0 z-10 flex items-center gap-2.5 px-4 py-2 bg-muted/80 backdrop-blur-sm border-b border-border/30">
                <ActiveIcon className="w-3.5 h-3.5 text-muted-foreground/70" />
                <span className="text-xs font-semibold text-muted-foreground tracking-wide uppercase">{activeCategoryLabel}</span>
                <span className="text-xs text-muted-foreground/40 tabular-nums ml-auto">{t('picker.itemsCount', { count: totalFiltered.toLocaleString() })}</span>
              </div>

              {totalFiltered === 0 ? (
                <div className="py-14 text-center text-muted-foreground">
                  <SearchX className="w-7 h-7 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">
                    {search ? t('picker.noItemsMatch', { query: search }) : t('picker.noItemsCategory')}
                  </p>
                  {search && activeCategory && (
                    <button
                      type="button"
                      onClick={() => setActiveCategory(null)}
                      className="mt-3 text-xs text-primary hover:underline"
                    >
                      {t('picker.searchAllCategories')}
                    </button>
                  )}
                </div>
              ) : (
                <div ref={listRef} className="py-1">
                  {visibleItems.map((item, idx) => {
                    const group = getItemGroup(item.category)
                    const ItemGroupIcon = GROUP_META[group]?.icon || HelpCircle
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="option"
                        id={`itempicker-opt-${idx}`}
                        aria-selected={item.id === value}
                        data-item-index={idx}
                        onClick={() => handleSelect(item.id)}
                        className={cn(
                          'w-full flex items-start gap-3 px-4 py-2.5 text-left group',
                          'motion-safe:transition-colors duration-75',
                          'hover:bg-accent/10',
                          item.id === value && 'bg-primary/10',
                          idx === highlightIndex && 'bg-accent/15 outline-none'
                        )}
                      >
                        {!activeCategory && (
                          <ItemGroupIcon className="w-4 h-4 text-muted-foreground/30 shrink-0 mt-0.5" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              'text-sm font-medium truncate',
                              item.id === value ? 'text-primary' : 'text-foreground'
                            )}>
                              {item.name || item.id}
                            </span>
                            {item.weight > 0 && (
                              <span className="text-[10px] text-muted-foreground/50 tabular-nums shrink-0 px-1.5 py-0.5 rounded bg-muted/50">{fmtWeight(item.weight)}</span>
                            )}
                          </div>
                          <span className="text-[11px] text-muted-foreground/40 font-mono block mt-0.5 truncate">{item.id}</span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="border-t border-border/40 px-4 py-2 flex items-center justify-between gap-4 text-[11px] text-muted-foreground">
            <span className="shrink-0 tabular-nums">
              {capped
                ? t('picker.cappedItems', { limit: MAX_VISIBLE, count: totalFiltered.toLocaleString() })
                : activeCategory
                  ? t('picker.itemsInCategory', { count: totalFiltered.toLocaleString(), category: activeCategoryLabel })
                  : t('picker.itemsCount', { count: totalFiltered.toLocaleString() })}
            </span>
            <div className="flex items-center gap-4 text-[10px] opacity-50">
              <span>{t('picker.navigate')}</span>
              <span>{t('picker.select')}</span>
              <span>{t('escClose')}</span>
            </div>
            {scannedAt && (
              <span className="text-right opacity-40 tabular-nums">
                {new Date(scannedAt).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
