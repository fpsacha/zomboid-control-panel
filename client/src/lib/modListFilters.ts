import type { TrackedMod, WsGroup } from '@/lib/modsShared'

// Search, filters and sorting for the Mod Manager's two big lists: "Installed"
// (tracked Workshop items) and "Active on server" (Workshop items in the server
// config, each with its mod IDs). Pure, so a 600-mod list filters in one pass
// and the rules are unit tested.

// ── Shared ───────────────────────────────────────────────────────────────────

export interface ModLookups {
  /** The note text on a Workshop item, '' when none. */
  noteText: (workshopId: string) => string
  /** The groups a Workshop item belongs to (through any of its mod IDs). */
  groupIdsOf: (workshopId: string) => readonly string[]
}

/** Group filter: every item, items in no group, or items in one group. */
export type GroupFilter = { kind: 'all' } | { kind: 'ungrouped' } | { kind: 'group'; groupId: string }

export const ALL_GROUPS: GroupFilter = { kind: 'all' }

function matchesGroup(workshopId: string, filter: GroupFilter, lookups: ModLookups): boolean {
  if (filter.kind === 'all') return true
  const groups = lookups.groupIdsOf(workshopId)
  return filter.kind === 'ungrouped' ? groups.length === 0 : groups.includes(filter.groupId)
}

/** Reads a stored group filter back; anything unexpected (or a deleted group) reads as "all". */
export function parseGroupFilter(value: unknown, groupIds: readonly string[]): GroupFilter {
  if (!value || typeof value !== 'object') return ALL_GROUPS
  const filter = value as Partial<{ kind: string; groupId: string }>
  if (filter.kind === 'ungrouped') return { kind: 'ungrouped' }
  if (filter.kind === 'group' && typeof filter.groupId === 'string' && groupIds.includes(filter.groupId)) {
    return { kind: 'group', groupId: filter.groupId }
  }
  return ALL_GROUPS
}

const compareNames = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })

// ── Installed ────────────────────────────────────────────────────────────────

export interface InstalledFilters {
  updatesOnly: boolean
  hasNote: boolean
  group: GroupFilter
}

/**
 * The tracked mods the Installed list draws from: the ones in the server
 * config's WorkshopItems= (every tracked mod until the config is read,
 * `configuredWorkshopIds` null). A tracked item missing from the config
 * (Deactivated) is not on the server, so its update is not one either: the
 * Installed update counts (status bar, menu badge, "Updates only" chip)
 * count this set, the list it filters.
 */
export function modsOnServer(
  mods: readonly TrackedMod[],
  configuredWorkshopIds: ReadonlySet<string> | null,
): readonly TrackedMod[] {
  return configuredWorkshopIds === null ? mods : mods.filter((mod) => configuredWorkshopIds.has(mod.workshop_id))
}

export type InstalledSort = 'status' | 'name' | 'updated'
export const INSTALLED_SORTS: readonly InstalledSort[] = ['status', 'name', 'updated']

export function filterInstalledMods(
  mods: readonly TrackedMod[],
  query: string,
  filters: InstalledFilters,
  lookups: ModLookups,
): TrackedMod[] {
  const q = query.trim().toLowerCase()
  return mods.filter((mod) => {
    if (filters.updatesOnly && !mod.update_available) return false
    if (filters.hasNote && !lookups.noteText(mod.workshop_id)) return false
    if (!matchesGroup(mod.workshop_id, filters.group, lookups)) return false
    if (!q) return true
    return (
      (mod.name ?? '').toLowerCase().includes(q) ||
      mod.workshop_id.includes(q) ||
      lookups.noteText(mod.workshop_id).toLowerCase().includes(q)
    )
  })
}

const updatedAt = (mod: TrackedMod) => {
  const time = Date.parse(mod.last_updated ?? '')
  return Number.isFinite(time) ? time : 0
}

/** 'status' keeps the update-status buckets (updates first, then by name); the others sort one flat list. */
export function sortInstalledMods(mods: readonly TrackedMod[], sort: InstalledSort): TrackedMod[] {
  const list = [...mods]
  if (sort === 'updated') return list.sort((a, b) => updatedAt(b) - updatedAt(a) || compareNames(a.name ?? '', b.name ?? ''))
  if (sort === 'name') return list.sort((a, b) => compareNames(a.name ?? '', b.name ?? ''))
  return list.sort((a, b) => (b.update_available - a.update_available) || compareNames(a.name ?? '', b.name ?? ''))
}

// ── Active on server ─────────────────────────────────────────────────────────

export interface ActiveFilters {
  attention: boolean
  multiId: boolean
  notEnabled: boolean
  updates: boolean
  missingDep: boolean
  hasNote: boolean
  group: GroupFilter
  /** Only items with an enabled mod of this kind (smart sort's classification). */
  kind?: string | null
}

export interface ActiveLookups extends ModLookups {
  needsAttention: (item: WsGroup) => boolean
  hasUpdate: (workshopId: string) => boolean
  hasMissingDep: (item: WsGroup) => boolean
  /** The kinds of an item's enabled mods (needed with the kind filter). */
  kindsOf?: (item: WsGroup) => readonly string[]
}

export type ActiveSort = 'config' | 'loadOrder' | 'name' | 'updated'
export const ACTIVE_SORTS: readonly ActiveSort[] = ['config', 'loadOrder', 'name', 'updated']

/** Search over the Workshop ID, every mod ID and name, and the item's note. */
export function matchesActiveSearch(item: WsGroup, query: string, noteText: (workshopId: string) => string): WsGroup | null {
  const q = query.trim().toLowerCase()
  if (!q) return item
  if (item.wsId.includes(q) || noteText(item.wsId).toLowerCase().includes(q)) return item
  const matched = item.mods.filter((mod) => mod.id.toLowerCase().includes(q) || mod.name.toLowerCase().includes(q))
  return matched.length === 0 ? null : { ...item, mods: matched }
}

export function filterActiveItems(items: readonly WsGroup[], filters: ActiveFilters, lookups: ActiveLookups): WsGroup[] {
  return items.filter((item) => {
    if (filters.multiId && item.mods.length < 2) return false
    if (filters.attention && !lookups.needsAttention(item)) return false
    if (filters.notEnabled && item.allEnabled) return false
    if (filters.updates && !lookups.hasUpdate(item.wsId)) return false
    if (filters.missingDep && !lookups.hasMissingDep(item)) return false
    if (filters.hasNote && !lookups.noteText(item.wsId)) return false
    if (filters.kind && !(lookups.kindsOf?.(item) ?? []).includes(filters.kind)) return false
    return matchesGroup(item.wsId, filters.group, lookups)
  })
}

export interface ActiveSortLookups {
  /** Position of the item's first enabled mod ID in Mods= (Infinity when none is enabled). */
  loadIndex: (item: WsGroup) => number
  name: (item: WsGroup) => string
  updatedAt: (workshopId: string) => number
}

/** 'config' is the WorkshopItems= order the list arrives in. */
export function sortActiveItems(items: readonly WsGroup[], sort: ActiveSort, lookups: ActiveSortLookups): WsGroup[] {
  const list = [...items]
  if (sort === 'loadOrder') {
    return list.sort((a, b) => {
      const x = lookups.loadIndex(a)
      const y = lookups.loadIndex(b)
      return x === y ? 0 : x < y ? -1 : 1
    })
  }
  if (sort === 'name') return list.sort((a, b) => compareNames(lookups.name(a), lookups.name(b)))
  if (sort === 'updated') return list.sort((a, b) => lookups.updatedAt(b.wsId) - lookups.updatedAt(a.wsId))
  return list
}
