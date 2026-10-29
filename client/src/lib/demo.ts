import type { ServerProblem, ServerProblemsResult, ServerSetupPlan } from './api'
import { demoConflictSuggestion, demoSmartResponse } from './demoSmart'
import { BRIDGE_MOD_ID, type DeliveryMethod, type DeliveryPlanResponse, type DeliveryStatus } from './bridgeDeliveryTypes'

const DEMO_FLAGS = new Set(['1', 'true', 'yes', 'on'])

export function isDemoMode(): boolean {
  const value = (import.meta.env.VITE_DEMO_MODE || '').toString().trim().toLowerCase()
  return DEMO_FLAGS.has(value)
}

let demoFetchInstalled = false

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

function normalizeApiPath(input: RequestInfo | URL): string {
  const rawUrl = typeof input === 'string'
    ? input
    : input instanceof URL
    ? input.toString()
    : input.url

  try {
    const parsed = new URL(rawUrl, window.location.origin)
    const basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
    if (basePath && parsed.pathname.startsWith(`${basePath}/api/`)) {
      return parsed.pathname.slice(basePath.length)
    }

    const apiIndex = parsed.pathname.indexOf('/api/')
    if (apiIndex >= 0) {
      return parsed.pathname.slice(apiIndex)
    }

    return parsed.pathname
  } catch {
    const apiIndex = rawUrl.indexOf('/api/')
    return apiIndex >= 0 ? rawUrl.slice(apiIndex) : rawUrl
  }
}

const demoTimestamp = '2026-06-24T02:00:00.000Z'

// The demo server's Workshop items, as a 40-odd mod community server has
// them: a few frameworks, a KI5 vehicle stack, quality-of-life mods, maps and
// patches. Each item ships its mod IDs (`require=` from mod.info); `active:
// false` items are tracked but not in WorkshopItems= (the Deactivated view).
interface DemoWorkshopItem {
  workshopId: string
  name: string
  mods: Array<{ id: string; name?: string; require?: string[] }>
  updated: string
  update?: boolean
  active?: boolean
}

const demoWorkshopItems: DemoWorkshopItem[] = [
  { workshopId: '2392709985', name: 'Tsar\'s Common Library 2.0', mods: [{ id: 'TchernoLib' }], updated: '2026-06-23T20:15:00.000Z' },
  { workshopId: '2169435993', name: 'Brita\'s Weapon Pack', mods: [{ id: 'Brita', require: ['TchernoLib', 'Arsenal(26)GunFighter'] }], updated: '2026-06-24T01:10:00.000Z', update: true },
  { workshopId: '2460154811', name: 'Brita\'s Armor Pack', mods: [{ id: 'Brita_2', require: ['Brita'] }], updated: '2026-06-20T17:00:00.000Z' },
  { workshopId: '2004998206', name: 'Raven Creek', mods: [{ id: 'RavenCreek' }], updated: '2026-06-20T09:30:00.000Z' },
  {
    workshopId: '2849247394',
    name: 'Authentic Z',
    mods: [{ id: 'AuthenticZLite', name: 'Authentic Z Lite' }, { id: 'AuthenticZBackpacks', name: 'Authentic Z Backpacks' }],
    updated: '2026-06-18T15:45:00.000Z',
  },
  { workshopId: '2730000101', name: '[KI5] Vehicle Library', mods: [{ id: 'KI5Library' }], updated: '2026-06-22T08:00:00.000Z' },
  { workshopId: '2730000102', name: '[KI5] \'93 Chevrolet K5 Blazer', mods: [{ id: 'KI5_93Blazer', require: ['KI5Library'] }], updated: '2026-06-01T10:00:00.000Z' },
  { workshopId: '2730000103', name: '[KI5] \'87 Chevrolet Suburban', mods: [{ id: 'KI5_87Suburban', require: ['KI5Library'] }], updated: '2026-05-28T10:00:00.000Z' },
  { workshopId: '2730000104', name: '[KI5] M35A2 Truck', mods: [{ id: 'KI5_M35A2', require: ['KI5Library'] }], updated: '2026-05-20T10:00:00.000Z' },
  { workshopId: '2730000105', name: '[KI5] Vehicle Fixes', mods: [{ id: 'KI5Fixes', require: ['KI5Library'] }], updated: '2026-06-23T22:00:00.000Z', update: true },
  { workshopId: '2169435901', name: 'Mod Options (Build 42)', mods: [{ id: 'ModOptions' }], updated: '2026-04-11T12:00:00.000Z' },
  { workshopId: '2169435902', name: 'Better Sorting', mods: [{ id: 'BetterSorting' }], updated: '2026-03-02T12:00:00.000Z' },
  { workshopId: '2169435903', name: 'Better Containers', mods: [{ id: 'BetterContainers' }], updated: '2026-02-14T12:00:00.000Z' },
  { workshopId: '2169435904', name: 'Map Legend UI', mods: [{ id: 'MapLegendUI' }], updated: '2026-01-09T12:00:00.000Z' },
  { workshopId: '2169435905', name: 'Common Sense', mods: [{ id: 'CommonSense' }], updated: '2026-05-30T12:00:00.000Z' },
  { workshopId: '2169435906', name: 'Minimal Display Bars', mods: [{ id: 'MinimalDisplayBars', require: ['ModOptions'] }], updated: '2026-06-05T12:00:00.000Z' },
  { workshopId: '2169435907', name: 'Eris Minimap', mods: [{ id: 'ErisMinimap', require: ['ModOptions'] }], updated: '2026-06-07T12:00:00.000Z' },
  { workshopId: '2169435908', name: 'Fancy Handwork', mods: [{ id: 'FancyHandwork' }], updated: '2026-04-21T12:00:00.000Z' },
  { workshopId: '2169435909', name: 'Proximity Inventory', mods: [{ id: 'ProximityInventory' }], updated: '2026-03-18T12:00:00.000Z' },
  { workshopId: '2169435910', name: 'Craft Helper Continued', mods: [{ id: 'CraftHelperContinued' }], updated: '2026-05-02T12:00:00.000Z' },
  { workshopId: '2169435911', name: 'True Music', mods: [{ id: 'truemusic' }], updated: '2026-02-02T12:00:00.000Z' },
  { workshopId: '2169435912', name: 'True Music Addon - Retro Pack', mods: [{ id: 'truemusic_retro', require: ['truemusic'] }], updated: '2026-02-03T12:00:00.000Z' },
  { workshopId: '2169435913', name: 'True Music Jukebox', mods: [{ id: 'truemusic_jukebox', require: ['truemusic'] }], updated: '2026-02-04T12:00:00.000Z' },
  { workshopId: '2169435914', name: 'Clothing Fix Patch', mods: [{ id: 'ClothingFixPatch' }], updated: '2026-06-10T12:00:00.000Z' },
  {
    workshopId: '2169435915',
    name: 'Better Sorting - Authentic Z Compatibility',
    mods: [{ id: 'BetterSorting_AuthZ_Compat', require: ['BetterSorting', 'AuthenticZLite'] }],
    updated: '2026-06-11T12:00:00.000Z',
  },
  { workshopId: '2169435916', name: 'Bedford Falls', mods: [{ id: 'BedfordFalls' }], updated: '2026-01-20T12:00:00.000Z' },
  { workshopId: '2169435917', name: 'Fort Rock Ridge', mods: [{ id: 'FortRockRidge' }], updated: '2025-12-12T12:00:00.000Z' },
  { workshopId: '2169435918', name: 'Pitstop', mods: [{ id: 'Pitstop' }], updated: '2026-03-03T12:00:00.000Z' },
  { workshopId: '2169435919', name: 'Superb Survivors', mods: [{ id: 'SuperbSurvivors' }], updated: '2025-11-30T12:00:00.000Z' },
  { workshopId: '2169435920', name: 'Water Dispenser', mods: [{ id: 'WaterDispenser' }], updated: '2026-01-05T12:00:00.000Z' },
  { workshopId: '2169435921', name: 'Grapeseed', mods: [{ id: 'grapeseed' }], updated: '2026-04-04T12:00:00.000Z' },
  {
    workshopId: '2169435922',
    name: 'Lifestyle: Hobbies',
    mods: [
      { id: 'Lifestyle', name: 'Lifestyle: Hobbies' },
      { id: 'LifestyleDJ', name: 'Lifestyle: DJ' },
      { id: 'LifestyleDance', name: 'Lifestyle: Dancing' },
      { id: 'LifestyleMeditation', name: 'Lifestyle: Meditation' },
    ],
    updated: '2026-06-19T12:00:00.000Z',
    update: true,
  },
  { workshopId: '2169435923', name: 'Noir\'s Attachments', mods: [{ id: 'noirrsling' }], updated: '2026-02-27T12:00:00.000Z' },
  { workshopId: '2169435924', name: 'Simple Overhaul: Traits and Occupations', mods: [{ id: 'SOTO' }], updated: '2026-05-15T12:00:00.000Z' },
  { workshopId: '2169435925', name: 'More Traits', mods: [{ id: 'ToadTraits' }], updated: '2026-04-30T12:00:00.000Z' },
  { workshopId: '2169435926', name: 'Dynamic Traits', mods: [{ id: 'DynamicTraits' }], updated: '2026-03-25T12:00:00.000Z' },
  { workshopId: '2169435927', name: 'Skill Recovery Journal', mods: [{ id: 'SkillRecoveryJournal' }], updated: '2026-06-02T12:00:00.000Z' },
  { workshopId: '2169435928', name: 'Autotsar Trailers', mods: [{ id: 'autotsartrailers', require: ['TchernoLib'] }], updated: '2026-05-09T12:00:00.000Z' },
  { workshopId: '2169435929', name: 'Ladders', mods: [{ id: 'Ladders' }], updated: '2026-01-29T12:00:00.000Z' },
  { workshopId: '2169435930', name: 'Authentic Z - Spanish Translation', mods: [{ id: 'AuthenticZ_ES', require: ['AuthenticZLite'] }], updated: '2026-06-09T12:00:00.000Z' },
  { workshopId: '3000000003', name: 'Expanded Helicopter Events', mods: [{ id: 'ExpandedHelicopterEvents' }], updated: '2026-06-12T08:10:00.000Z', active: false },
  { workshopId: '3000000004', name: 'Workshop Mod 3000000004', mods: [{ id: 'OldLootTables' }], updated: '2025-10-01T08:10:00.000Z', active: false },
]

const demoTrackedMods = demoWorkshopItems.map((item, index) => ({
  id: index + 1,
  workshop_id: item.workshopId,
  name: item.name,
  last_updated: item.updated,
  last_checked: demoTimestamp,
  update_available: item.update ? 1 : 0,
  created_at: '2026-05-18T12:00:00.000Z',
  active: item.active !== false,
}))

function demoModsStatus() {
  const needing = demoWorkshopItems.filter((item) => item.update)
  return {
    totalModsTracked: demoTrackedMods.length,
    totalModsInWorkshop: demoWorkshopItems.length + 2,
    updatesAvailable: needing.length,
    lastCheck: demoTimestamp,
    lastUpdateDetected: '2026-06-24T01:20:00.000Z',
    autoRestartEnabled: true,
    running: false,
    workshopAcfConfigured: true,
    workshopAcfPath: '/opt/pz/steamapps/workshop/appworkshop_108600.acf',
    checkInterval: 30,
    modsNeedingUpdate: needing.map((item) => ({
      workshopId: item.workshopId,
      name: item.name,
      localTimestamp: '2026-06-23T11:30:00.000Z',
      latestTimestamp: item.updated,
    })),
    restartWarningMinutes: 5,
    delayIfPlayersOnline: true,
    maxDelayMinutes: 30,
    pendingRestart: false,
    steamApiHealthy: true,
    lastSteamApiFailureAt: null,
    removedWorkshopIds: [] as string[],
    unknownWorkshopIds: [] as Array<{ id: string; resultCode: number }>,
  }
}

// The demo server's Mods= order. Mutable so Save Order, group enable/disable
// and "Apply group order" show up for as long as the page lives. Deliberately
// a little messy: a KI5 car above its library, a True Music add-on above True
// Music, the KI5 group spread out, so Auto-sort has real work to show.
const DEMO_INITIAL_LOAD_ORDER = [
  'ModOptions', 'AuthenticZ_ES', 'TchernoLib', 'Brita', 'Brita_2', 'RavenCreek', 'AuthenticZLite', 'KI5_93Blazer', 'KI5Library',
  'BetterSorting', 'BetterContainers', 'KI5_87Suburban', 'MapLegendUI', 'CommonSense', 'MinimalDisplayBars', 'ErisMinimap',
  'KI5_M35A2', 'FancyHandwork', 'truemusic_retro', 'truemusic', 'truemusic_jukebox', 'ClothingFixPatch', 'BedfordFalls',
  'FortRockRidge', 'Pitstop', 'SuperbSurvivors', 'WaterDispenser', 'grapeseed', 'Lifestyle', 'LifestyleDJ', 'LifestyleDance',
  'LifestyleMeditation', 'noirrsling', 'SOTO', 'ToadTraits', 'DynamicTraits', 'SkillRecoveryJournal', 'CraftHelperContinued',
  'ProximityInventory', 'autotsartrailers', 'Ladders', 'KI5Fixes', 'BetterSorting_AuthZ_Compat',
]
let demoModLoadOrder = [...DEMO_INITIAL_LOAD_ORDER]

interface DemoModGroup {
  id: string
  name: string
  description: string
  modIds: string[]
  createdAt: string
  updatedAt: string
  color: string | null
  keepTogether: boolean
  // Smart sort's first/last place for the group (null: anywhere).
  placement?: 'first' | 'last' | null
}

function demoPlacement(value: unknown, fallback: 'first' | 'last' | null): 'first' | 'last' | null {
  if (value === null) return null
  return value === 'first' || value === 'last' ? value : fallback
}

// Mod groups, in memory: create / edit / delete / import behave until reload.
// "Survivor gear" starts out of order, "KI5 Vehicles" keeps together but is
// spread out and has a member this server does not have, and "Weapons stack"
// lists a library that is not enabled, so every badge and note shows.
let demoModGroups: DemoModGroup[] = [
  {
    id: 'demo-group-1',
    name: 'Weapons stack',
    description: 'The library first, then the weapon packs.',
    modIds: ['TchernoLib', 'Arsenal(26)GunFighter', 'Brita', 'Brita_2'],
    createdAt: '2026-06-10T18:30:00.000Z',
    updatedAt: '2026-06-10T18:30:00.000Z',
    color: 'red',
    keepTogether: false,
  },
  {
    id: 'demo-group-2',
    name: 'Survivor gear',
    description: 'Authentic Z has to load before Raven Creek.',
    modIds: ['AuthenticZLite', 'RavenCreek'],
    createdAt: '2026-06-12T09:00:00.000Z',
    updatedAt: '2026-06-12T09:00:00.000Z',
    color: 'teal',
    keepTogether: false,
  },
  {
    id: 'demo-group-3',
    name: 'KI5 Vehicles',
    description: 'Library, the cars, then the fixes.',
    modIds: ['KI5Library', 'KI5_93Blazer', 'KI5_87Suburban', 'KI5_M35A2', 'KI5Fixes', 'KI5_Trailers'],
    createdAt: '2026-06-14T16:45:00.000Z',
    updatedAt: '2026-06-14T16:45:00.000Z',
    color: 'amber',
    keepTogether: true,
  },
  {
    id: 'demo-group-4',
    name: 'Quality of life',
    description: 'UI and inventory helpers everyone on the server uses.',
    modIds: ['ModOptions', 'BetterSorting', 'BetterContainers', 'MapLegendUI', 'CommonSense', 'MinimalDisplayBars', 'ErisMinimap', 'FancyHandwork', 'ProximityInventory', 'CraftHelperContinued'],
    createdAt: '2026-06-15T11:00:00.000Z',
    updatedAt: '2026-06-15T11:00:00.000Z',
    color: 'sky',
    keepTogether: false,
  },
  {
    id: 'demo-group-5',
    name: 'Maps',
    description: '',
    modIds: ['RavenCreek', 'BedfordFalls', 'FortRockRidge', 'Pitstop'],
    createdAt: '2026-06-16T11:00:00.000Z',
    updatedAt: '2026-06-16T11:00:00.000Z',
    color: 'lime',
    keepTogether: false,
  },
  {
    id: 'demo-group-6',
    name: 'Patches & fixes',
    description: 'Compatibility patches load after the mods they patch.',
    modIds: ['ClothingFixPatch', 'BetterSorting_AuthZ_Compat'],
    createdAt: '2026-06-17T11:00:00.000Z',
    updatedAt: '2026-06-17T11:00:00.000Z',
    color: 'pink',
    keepTogether: false,
    placement: 'last',
  },
]
let demoModGroupSeq = demoModGroups.length

// Smart sort v2's routes (lib/demoSmart.ts) read the demo's live state.
const demoSmartContext = {
  getOrder: () => demoModLoadOrder,
  setOrder: (order: string[]) => { demoModLoadOrder = order },
  items: demoWorkshopItems,
  getGroups: () => demoModGroups,
}
let demoModGroupsEnforce = false

const DEMO_GROUP_COLORS = new Set(['slate', 'red', 'orange', 'amber', 'lime', 'green', 'teal', 'sky', 'blue', 'violet', 'pink'])
function demoGroupColor(value: unknown, fallback: string | null): string | null {
  if (value === null) return null
  return typeof value === 'string' && DEMO_GROUP_COLORS.has(value) ? value : fallback
}

// Mod notes, keyed by Workshop item id.
const demoModNotes: Record<string, { text: string; updatedAt: string; updatedBy: string | null }> = {
  '2169435993': {
    text: 'Keep this version until Arsenal GunFighter is back on the Workshop: the update needs it.',
    updatedAt: '2026-06-22T19:40:00.000Z',
    updatedBy: 'admin',
  },
  '2730000105': {
    text: 'Must load after every KI5 car. Ask Rowan before removing.',
    updatedAt: '2026-06-18T08:15:00.000Z',
    updatedBy: 'rowan',
  },
}

// Suggested groups, computed by the real server from require= lines, shared
// name prefixes and multi-mod Workshop items.
const demoGroupSuggestions = [
  { key: 'dependency:modoptions', kind: 'dependency', name: 'Mod Options', modIds: ['ModOptions', 'MinimalDisplayBars', 'ErisMinimap'] },
  { key: 'prefix:truemusic', kind: 'prefix', name: 'True Music', modIds: ['truemusic', 'truemusic_retro', 'truemusic_jukebox'] },
  { key: 'workshop-item:2169435922', kind: 'workshop-item', name: 'Lifestyle: Hobbies', modIds: ['Lifestyle', 'LifestyleDJ', 'LifestyleDance', 'LifestyleMeditation'] },
]
const demoDismissedSuggestions = new Set<string>()

function demoModGroupsStatus() {
  const groups = demoModGroups.map((group) => {
    const present = group.modIds.filter(id => demoModLoadOrder.includes(id))
    const positions = present.map(id => demoModLoadOrder.indexOf(id))
    return {
      id: group.id,
      inOrder: positions.every((position, i) => i === 0 || positions[i - 1] < position),
      present: present.length,
      total: group.modIds.length,
      missing: group.modIds.filter(id => !demoModLoadOrder.includes(id)),
    }
  })
  return { groups, inOrder: groups.every(group => group.inOrder), conflicts: [] as string[] }
}

// Puts every group's members back in group order, within the slots they hold now.
function demoApplyModGroups(write: boolean) {
  const order = [...demoModLoadOrder]
  for (let pass = 0; pass <= demoModGroups.length; pass++) {
    for (const group of demoModGroups) {
      const present = group.modIds.filter(id => order.includes(id))
      const slots = present.map(id => order.indexOf(id)).sort((a, b) => a - b)
      present.forEach((id, i) => { order[slots[i]] = id })
    }
  }
  const moved = order.filter((id, i) => demoModLoadOrder[i] !== id)
  if (write && moved.length > 0) demoModLoadOrder = order
  return { changed: moved.length > 0, moved, order, written: write && moved.length > 0, conflicts: [] as string[] }
}

function demoModIdList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map(id => id.trim()) : []
}

function demoCurrentConfig() {
  const active = demoWorkshopItems.filter((item) => item.active !== false)
  const workshopIds = active.map((item) => item.workshopId)
  const modIds = [...demoModLoadOrder]
  const enabled = new Set(modIds)
  const workshopModMap: Record<string, Array<{ id: string; name: string; enabled: boolean; require?: string[] }>> = {}
  for (const item of active) {
    workshopModMap[item.workshopId] = item.mods.map((mod) => ({
      id: mod.id,
      name: mod.name ?? item.name,
      enabled: enabled.has(mod.id),
      ...(mod.require ? { require: mod.require } : {}),
    }))
  }
  return {
    configured: true,
    modIds,
    workshopIds,
    maps: ['Muldraugh, KY', 'RavenCreek', 'BedfordFalls', 'FortRockRidge'],
    totalMods: modIds.length,
    iniPath: '/home/pz/Zomboid/Server/DoomerZDemo.ini',
    workshopModMap,
  }
}

// Enables a group's members that a Workshop item ships, right after the
// nearest earlier member (else at the end), like the real route.
function demoEnableGroup(group: DemoModGroup) {
  const shipped = new Set(demoWorkshopItems.filter((item) => item.active !== false).flatMap((item) => item.mods.map((mod) => mod.id)))
  const alreadyEnabled = group.modIds.filter((id) => demoModLoadOrder.includes(id))
  const wanted = group.modIds.filter((id) => !demoModLoadOrder.includes(id))
  const enabled = wanted.filter((id) => shipped.has(id))
  const missing = wanted.filter((id) => !shipped.has(id))
  const order = [...demoModLoadOrder]
  for (const id of enabled) {
    const before = group.modIds.slice(0, group.modIds.indexOf(id)).reverse().find((member) => order.includes(member))
    order.splice(before ? order.indexOf(before) + 1 : order.length, 0, id)
  }
  demoModLoadOrder = order
  return { enabled, alreadyEnabled, missing, workshopItemsAdded: [] as string[], groupsAdjusted: [] as string[] }
}

// Disables a group's members; with keepShared, a member of another fully
// enabled group stays.
function demoDisableGroup(group: DemoModGroup, keepShared: boolean) {
  const others = demoModGroups.filter((other) => other.id !== group.id)
  const disabled: string[] = []
  const keptShared: string[] = []
  const notEnabled: string[] = []
  for (const id of group.modIds) {
    if (!demoModLoadOrder.includes(id)) {
      notEnabled.push(id)
      continue
    }
    const shared = keepShared && others.some((other) => other.modIds.includes(id) && other.modIds.every((member) => demoModLoadOrder.includes(member)))
    if (shared) keptShared.push(id)
    else disabled.push(id)
  }
  demoModLoadOrder = demoModLoadOrder.filter((id) => !disabled.includes(id))
  return { disabled, keptShared, notEnabled, keptManaged: [] as string[] }
}

function demoConflictScan() {
  return {
    totalConflicts: 5,
    identicalSkipped: 14,
    additiveSkipped: 6,
    pzAdditiveSkipped: 4,
    pzAdditiveBreakdown: {
      sandbox: 1,
      scripts: 2,
      clothing: 1,
      fileguidtable: 0,
      translate: 0,
    },
    totalPairs: 4,
    modsScanned: DEMO_INITIAL_LOAD_ORDER.length,
    modsNotFound: 0,
    modsSkippedInactive: 2,
    totalWorkshopIds: demoCurrentConfig().workshopIds.length,
    modLoadOrder: [...DEMO_INITIAL_LOAD_ORDER],
    warnings: ['Demo scan uses static sample data. Run a real scan from a connected panel to inspect your server files.'],
    scanDurationMs: 1834,
    missingDeps: [
      {
        modId: 'Brita',
        modName: 'Brita\'s Weapon Pack',
        workshopId: '2169435993',
        missingDep: 'Arsenal(26)GunFighter',
        resolvedWorkshopId: '2297098490',
        resolvedModName: 'Arsenal GunFighter',
      },
    ],
    steamDeps: [
      {
        parentWorkshopId: '2169435993',
        parentName: 'Brita\'s Weapon Pack',
        childWorkshopId: '2297098490',
        childName: 'Arsenal GunFighter',
        source: 'steam',
      },
    ],
    idCollisions: [
      {
        modId: 'AuthenticZLite',
        active: true,
        sources: [
          { workshopId: '2849247394', modName: 'Authentic Z', active: true },
          { workshopId: '3000000001', modName: 'Authentic Z Mirror', active: false },
        ],
      },
    ],
    pairs: [
      {
        modA: { workshopId: '2169435993', modId: 'Brita', modName: 'Brita\'s Weapon Pack' },
        modB: { workshopId: '2849247394', modId: 'AuthenticZLite', modName: 'Authentic Z Lite' },
        highCount: 1,
        mediumCount: 1,
        lowCount: 0,
        aWins: 1,
        bWins: 1,
        thirdPartyWins: 0,
        unknownWins: 0,
        files: [
          {
            file: 'media/scripts/clothing/demo_vests.txt',
            category: 'scripts',
            categoryLabel: 'Script definitions',
            severity: 'high',
            winner: { workshopId: '2849247394', modId: 'AuthenticZLite', modName: 'Authentic Z Lite' },
            overlap: { kind: 'script-defs', items: ['Base.PoliceVest', 'Base.HolsterDouble'], total: 2 },
          },
          {
            file: 'media/lua/shared/Items/demo_distribution.lua',
            category: 'lua',
            categoryLabel: 'Lua scripts',
            severity: 'medium',
            winner: { workshopId: '2169435993', modId: 'Brita', modName: 'Brita\'s Weapon Pack' },
            overlap: { kind: 'lua-symbols', items: ['OnFillContainer', 'ProceduralDistributions.list.PoliceStorage'], total: 2 },
          },
        ],
      },
      {
        modA: { workshopId: '2392709985', modId: 'TchernoLib', modName: 'Tsar\'s Common Library 2.0' },
        modB: { workshopId: '2169435993', modId: 'Brita', modName: 'Brita\'s Weapon Pack' },
        highCount: 0,
        mediumCount: 0,
        lowCount: 1,
        aWins: 0,
        bWins: 1,
        thirdPartyWins: 0,
        unknownWins: 0,
        files: [
          {
            file: 'media/lua/shared/demo_patch.lua',
            category: 'lua',
            categoryLabel: 'Lua scripts',
            severity: 'low',
            winner: { workshopId: '2169435993', modId: 'Brita', modName: 'Brita\'s Weapon Pack' },
            overlap: { kind: 'lua-shadow', items: [], total: 0 },
          },
        ],
      },
      {
        modA: { workshopId: '2730000104', modId: 'KI5_M35A2', modName: '[KI5] M35A2 Truck' },
        modB: { workshopId: '2730000105', modId: 'KI5Fixes', modName: '[KI5] Vehicle Fixes' },
        highCount: 0,
        mediumCount: 1,
        lowCount: 0,
        aWins: 0,
        bWins: 1,
        thirdPartyWins: 0,
        unknownWins: 0,
        files: [
          {
            file: 'media/scripts/vehicles/m35a2_burnt.txt',
            category: 'scripts',
            categoryLabel: 'Script definitions',
            severity: 'medium',
            winner: { workshopId: '2730000105', modId: 'KI5Fixes', modName: '[KI5] Vehicle Fixes' },
            overlap: { kind: 'script-defs', items: ['Base.M35A2Burnt'], total: 1 },
          },
        ],
      },
      {
        modA: { workshopId: '2169435911', modId: 'truemusic', modName: 'True Music' },
        modB: { workshopId: '2169435912', modId: 'truemusic_retro', modName: 'True Music Addon - Retro Pack' },
        highCount: 0,
        mediumCount: 1,
        lowCount: 0,
        aWins: 1,
        bWins: 0,
        thirdPartyWins: 0,
        unknownWins: 0,
        files: [
          {
            file: 'media/lua/shared/TCMusicDefenitions.lua',
            category: 'lua',
            categoryLabel: 'Lua scripts',
            severity: 'medium',
            winner: { workshopId: '2169435911', modId: 'truemusic', modName: 'True Music' },
            overlap: { kind: 'lua-symbols', items: ['GlobalMusic'], total: 1 },
          },
        ],
      },
    ].map((pair) => {
      const suggestion = demoConflictSuggestion(pair.modA.modId, pair.modB.modId)
      return suggestion ? { ...pair, suggestion } : pair
    }),
    stale: false,
    _workshopIdsSnapshot: demoCurrentConfig().workshopIds,
    _modIdsSnapshot: [...DEMO_INITIAL_LOAD_ORDER],
  }
}

function demoCollectionDiff() {
  return {
    ok: true,
    title: 'DoomerZ Demo Collection',
    inCollection: ['2392709985', '2169435993', '2004998206', '3000000002'],
    toAdd: ['2849247394', '3000000003'],
    toRemove: ['3000000002'],
    items: [
      { workshopId: '2392709985', name: 'Tsar\'s Common Library 2.0', status: 'synced', inTracked: true, inCollection: true },
      { workshopId: '2169435993', name: 'Brita\'s Weapon Pack', status: 'synced', inTracked: true, inCollection: true },
      { workshopId: '2004998206', name: 'Raven Creek', status: 'synced', inTracked: true, inCollection: true },
      { workshopId: '2849247394', name: 'Authentic Z', status: 'to-add', inTracked: true, inCollection: false },
      { workshopId: '3000000003', name: 'Expanded Helicopter Events', status: 'to-add', inTracked: true, inCollection: false },
      { workshopId: '3000000002', name: 'Legacy Vehicle Pack', status: 'to-remove', inTracked: false, inCollection: true },
    ],
    collectionId: '3001234567',
    autoSync: true,
    hasCredentials: true,
    tokenExpiry: Math.floor(Date.now() / 1000) + 3600,
    tokenExpired: false,
    trackedCount: demoTrackedMods.length,
  }
}

function demoWorkshopSearch(query: string) {
  const trimmed = query.trim()
  const lower = trimmed.toLowerCase()
  const arsenal = lower.includes('arsenal') || lower.includes('gunfighter')
  const tomb = lower.includes('tomb') || lower === 'tombbody'
  const results = arsenal
    ? [
        {
          workshopId: '2297098490',
          modId: 'Arsenal(26)GunFighter',
          modName: 'Arsenal GunFighter',
          description: 'Required framework for several weapon packs.',
          subscriberCount: 1260000,
          source: 'local',
          isDownloaded: true,
          matchedVariant: trimmed,
          relevance: 120,
        },
      ]
    : tomb
    ? [
        {
          workshopId: '2997342681',
          modId: 'TombBody',
          modName: "Tomb's Player Body",
          description: 'Exact internal mod ID match from local workshop metadata.',
          subscriberCount: 84000,
          source: 'local',
          isDownloaded: true,
          matchedVariant: trimmed,
          relevance: 140,
        },
      ]
    : [
        {
          workshopId: '2392709985',
          modId: 'TchernoLib',
          modName: 'Tsar\'s Common Library 2.0',
          description: 'Local demo result matched from downloaded metadata.',
          subscriberCount: 990000,
          source: 'local',
          isDownloaded: true,
          matchedVariant: trimmed,
          relevance: 80,
        },
      ]

  return {
    success: true,
    query: trimmed,
    variantsTried: [trimmed].filter(Boolean),
    steamSearchEnabled: false,
    steamSearchAttempted: false,
    results,
    searchUrl: `https://steamcommunity.com/workshop/browse/?appid=108600&searchtext=${encodeURIComponent(trimmed)}`,
  }
}

async function readJsonBody(init?: RequestInit): Promise<Record<string, unknown>> {
  if (!init?.body || typeof init.body !== 'string') return {}
  try {
    const value = JSON.parse(init.body)
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function demoServer() {
  return {
    id: 'demo-server',
    name: 'Demo Server',
    serverName: 'DoomerZDemo',
    installPath: '/opt/pz',
    zomboidDataPath: '/home/pz/Zomboid',
    serverConfigPath: '/home/pz/Zomboid/Server',
    rconHost: '127.0.0.1',
    rconPort: 27015,
    rconPassword: '',
    serverPort: 16261,
    minMemory: 2,
    maxMemory: 4,
    useNoSteam: false,
    useDebug: false,
    isRemote: false,
    isActive: true,
    createdAt: new Date().toISOString(),
  }
}

function demoIniSettings(): Record<string, string> {
  return {
    PublicName: 'Demo Server',
    PublicDescription: 'GitHub Pages demo mode (no backend connection)',
    MaxPlayers: '16',
    PauseEmpty: 'true',
    Open: 'true',
    PVP: 'false',
    RCONPort: '27015',
    RCONPassword: 'demo-password',
    Mods: 'DemoMod1;DemoMod2',
    WorkshopItems: '1234567890;0987654321',
    DoLuaChecksum: 'false',
  }
}

const demoTemplateExclusions = [
  'RCONPassword',
  'Password',
  'ServerName',
  'PublicName',
  'DefaultPort',
  'UDPPort',
  'RCONPort',
  'server_browser_announced_ip',
]

const demoTemplates = [
  {
    schemaVersion: 1,
    meta: {
      id: 'vanilla-apocalypse',
      name: 'Vanilla Apocalypse',
      description: 'A clean Build 42 baseline with the classic survival rules.',
      tags: ['vanilla', 'balanced'],
      pzBuild: '42',
    },
    sandboxVars: {},
    serverIni: {},
    iniExclusions: demoTemplateExclusions,
    mods: [],
    map: { mapId: 'Muldraugh, KY' },
    difficulty: { level: 'standard' },
    isBuiltin: true,
  },
  {
    schemaVersion: 1,
    meta: {
      id: 'first-week-friendly',
      name: 'First Week Friendly',
      description: 'A forgiving starting week for a co-op server finding its feet.',
      tags: ['beginner', 'co-op'],
      pzBuild: '42',
    },
    sandboxVars: {
      ZombieLore: { Speed: 2, Strength: 2 },
      World: { ElecShut: 3, WaterShut: 3 },
    },
    serverIni: { PauseEmpty: true, PVP: false },
    iniExclusions: demoTemplateExclusions,
    mods: [],
    map: { mapId: 'Muldraugh, KY' },
    difficulty: { level: 'easy' },
    isBuiltin: true,
  },
  {
    schemaVersion: 1,
    meta: {
      id: 'hardcore-survivor',
      name: 'Hardcore Survivor',
      description: 'A harsher ruleset for experienced survivors who want pressure.',
      tags: ['hardcore', 'challenge'],
      pzBuild: '42',
    },
    sandboxVars: {
      ZombieLore: { Speed: 3, Strength: 3 },
      World: { ElecShut: 1, WaterShut: 1 },
    },
    serverIni: { PauseEmpty: false, PVP: false },
    iniExclusions: demoTemplateExclusions,
    mods: [],
    map: { mapId: 'West Point, KY' },
    difficulty: { level: 'hard' },
    isBuiltin: true,
  },
]

function demoTemplateDiff() {
  return {
    serverIni: [],
    sandboxVars: [],
    summary: { iniChanges: 0, sandboxChanges: 0, totalChanges: 0 },
  }
}

export function getDemoTemplates() {
  return { templates: demoTemplates }
}

// Settings › PanelBridge's delivery block in the demo: the panel-installed
// bridge on a local server, with the Workshop option shown the way every
// panel build shows it until the item is published ("Not available yet").
export function getDemoBridgeDelivery(): DeliveryStatus {
  const server = demoServer()
  return {
    serverId: server.id,
    serverName: server.name,
    method: 'local',
    ownMethod: 'local',
    state: 'local-ok',
    access: 'automatic',
    remote: false,
    hostOs: 'linux',
    sharedWith: [],
    switch: null,
    release: {
      status: 'not-published',
      source: 'none',
      modId: BRIDGE_MOD_ID,
      workshopId: null,
      visibility: null,
      publishedVersion: null,
      publishedAt: null,
      serverLuaSha256: null,
      preview: true,
      linuxChecksumVerified: false,
    },
    effectiveWorkshopId: null,
    switchAvailability: {
      toWorkshop: { available: false, reason: 'notPublished', warnings: [] },
      toLocal: { available: false, reason: 'sameMethod', warnings: [] },
    },
    serverRunning: true,
    restartedSinceSwitch: null,
    live: null,
    disk: {
      installDir: server.installPath,
      looseFiles: [{ path: `${server.installPath}/media/lua/server/PanelBridge.lua`, kind: 'server', recognized: true }],
      iniPath: `${server.serverConfigPath}/${server.serverName}.ini`,
      iniEntries: { mods: false, workshopItems: false },
      workshopItem: null,
    },
    lastStartFailure: null,
    steamReportsUnavailable: false,
    steamModeOff: false,
    modAutoRestart: false,
    bundledVersion: null,
    checksum: {
      current: false,
      canTurnOn: false,
      turnOnBlockers: ['notWorkshop'],
      playersBlocked: false,
      requiresLinuxAck: true,
    },
  }
}

// POST /api/panel-bridge/delivery in the demo: the preview of a switch the
// demo status above doesn't allow, so the dialog shows the block reason and
// never offers an apply.
export function getDemoBridgeDeliveryPlan(to: DeliveryMethod): DeliveryPlanResponse {
  const status = getDemoBridgeDelivery()
  return {
    serverId: status.serverId,
    from: status.method,
    to,
    access: status.access,
    blocked: { reason: to === 'workshop' ? 'notPublished' : 'sameMethod' },
    steps: [],
    warnings: [],
    sharedWith: [],
    manual: null,
    applied: false,
    restartRequired: false,
    backups: [],
    status,
  }
}

// Server Setup in the demo: the demo server is the one local profile, so
// the wizard shows how it sets up another server beside it. The catch-all
// reply this replaced had no usedPorts, and the page crashed on it.
export function getDemoSetupPlan(): ServerSetupPlan {
  const server = demoServer()
  return {
    usedPorts: [
      {
        id: server.id,
        name: server.name,
        serverName: server.serverName,
        installPath: server.installPath,
        dataPath: server.zomboidDataPath,
        gamePort: server.serverPort,
        udpPort: server.serverPort + 1,
        rconPort: server.rconPort,
      },
    ],
    suggestedPorts: { gamePort: server.serverPort + 2, rconPort: server.rconPort + 1, withinPublishedRange: null },
    allInOne: null,
    hostLayout: { serversRoot: '/opt', separator: '/' },
    serversRootEntries: ['pz'],
    environmentDataPath: null,
  }
}

function demoStorageHealth() {
  return {
    diskSpace: {
      saveVolume: null,
      panelData: {
        path: null,
        totalBytes: 0,
        freeBytes: 0,
        usedPercent: 0,
        warning: false,
        critical: false,
      },
    },
    circuitBreaker: {
      open: false,
      lastError: null,
      failCount: 0,
      cooldownEndsAt: null,
    },
  }
}

// ---- A live demo server: up for a few hours with four survivors online
// around Knox County, so the Dashboard, Players and Debug pages show what a
// running server looks like rather than an empty, stopped one.
const DEMO_SERVER_UPTIME_MS = (5 * 60 + 12) * 60_000
const demoServerStartedAt = Date.now() - DEMO_SERVER_UPTIME_MS

const DEMO_ONLINE_PLAYERS = [
  { username: 'marlow_k', displayName: 'Marlow K', x: 10_627, y: 9_640, z: 0, health: 92, accessLevel: 'admin', joinedMinutesAgo: 184 },
  { username: 'jess.rae', displayName: 'Jess Rae', x: 11_932, y: 6_885, z: 1, health: 78, accessLevel: 'none', joinedMinutesAgo: 96 },
  { username: 'tomasz', displayName: 'Tomasz W', x: 8_143, y: 11_612, z: 0, health: 100, accessLevel: 'moderator', joinedMinutesAgo: 41 },
  { username: 'wren', displayName: 'Wren', x: 6_398, y: 5_297, z: 0, health: 64, accessLevel: 'none', joinedMinutesAgo: 12 },
]

function demoServerStatus() {
  const now = Date.now()
  return {
    running: true,
    scanFailed: false,
    startTime: new Date(demoServerStartedAt).toISOString(),
    serverTime: new Date(now).toISOString(),
    uptime: Math.floor((now - demoServerStartedAt) / 1000),
    serverPath: '/opt/pz',
    serverPathConfigured: true,
    localIp: '127.0.0.1',
    port: 16261,
    rcon: { host: '127.0.0.1', port: 27015, connected: true },
  }
}

function demoComposedStatus() {
  return {
    provider: 'native',
    selected: true,
    host: { status: 'running', label: 'Process', detail: null },
    server: { status: 'connected', label: 'RCON', detail: null },
    bridge: { status: 'active', label: 'PanelBridge', detail: null },
    summary: 'Demo server is running',
  }
}

function demoPlayerActivity() {
  const now = Date.now()
  return DEMO_ONLINE_PLAYERS.map((player, index) => ({
    id: index + 1,
    player_name: player.username,
    action: 'connect',
    details: null,
    logged_at: new Date(now - player.joinedMinutesAgo * 60_000).toISOString(),
  })).sort((a, b) => b.logged_at.localeCompare(a.logged_at))
}

// One snapshot a minute (server/index.js's perf sampler), six hours of it:
// player count follows the joins above, CPU and memory move with it.
export function getDemoPerformanceHistory(limit: number, now: number = Date.now()) {
  const GB = 1024 * 1024 * 1024
  const count = Math.max(1, Math.min(limit, 360))
  const history = []
  for (let i = count - 1; i >= 0; i--) {
    const minutesAgo = i
    const t = now - minutesAgo * 60_000
    const sinceStart = (t - demoServerStartedAt) / 60_000
    const running = sinceStart >= 0
    const players = running ? DEMO_ONLINE_PLAYERS.filter((p) => p.joinedMinutesAgo >= minutesAgo).length + (minutesAgo > 200 && minutesAgo < 290 ? 2 : 0) : 0
    const wave = Math.sin(minutesAgo / 9) * 4 + Math.sin(minutesAgo / 2.3) * 2
    history.push({
      timestamp: new Date(t).toISOString(),
      playerCount: players,
      maxPlayers: 16,
      serverRunning: running,
      memoryUsed: running ? Math.round((2.6 + players * 0.35 + wave * 0.04) * GB) : 0,
      pzMemUsed: running ? Math.round((3.1 + players * 0.4 + wave * 0.05) * GB) : undefined,
      cpuUsage: running ? Math.max(3, Math.round(14 + players * 6 + wave)) : 2,
      hostMemUsed: Math.round((running ? 9.4 + players * 0.4 : 5.2) * GB),
      hostMemTotal: 32 * GB,
      hostDiskUsed: Math.round(312 * GB),
      hostDiskTotal: Math.round(931 * GB),
      hostSwapUsed: 0,
      hostSwapTotal: 4 * GB,
    })
  }
  return { history }
}

const DEMO_CRASH_LOGS = [
  {
    name: 'hs_err_pid48211.log',
    minutesAgo: 60 * 26 + 14,
    content: [
      '#',
      '# A fatal error has been detected by the Java Runtime Environment:',
      '#',
      '#  SIGSEGV (0xb) at pc=0x00007f3a8c41e2d0, pid=48211, tid=48290',
      '#',
      '# JRE version: OpenJDK Runtime Environment (25.0.1+8) (build 25.0.1+8-LTS)',
      '# Java VM: OpenJDK 64-Bit Server VM (25.0.1+8-LTS, mixed mode, sharing, tiered, compressed oops, g1 gc, linux-amd64)',
      '# Problematic frame:',
      '# C  [libPZBullet64.so+0x8e2d0]  btCollisionWorld::updateSingleAabb(btCollisionObject*)+0x40',
      '#',
      '---------------  S U M M A R Y ------------',
      '',
      'Command Line: -Xms8g -Xmx8g -Dzomboid.steam=1 -Dzomboid.znetlog=1 zombie.network.GameServer -servername DoomerZDemo',
      'Host: AMD Ryzen 7 5800X 8-Core Processor, 16 cores, 31G, Ubuntu 24.04.1 LTS',
      'Time: elapsed time: 41873.204 seconds (0d 11h 37m 53s)',
      '',
      '---------------  T H R E A D  ---------------',
      '',
      'Current thread (0x00007f3a14d8a000):  JavaThread "MainThread" [_thread_in_native, id=48290]',
      '',
      'Java frames: (J=compiled Java code, j=interpreted, Vv=VM code)',
      'j  zombie.core.physics.Bullet.stepSimulation(FII)V+0',
      'J 14203 c2 zombie.core.physics.WorldSimulation.update()V (412 bytes)',
      'J 13877 c2 zombie.network.GameServer.main([Ljava/lang/String;)V (2204 bytes)',
    ].join('\n'),
  },
  {
    name: 'hs_err_pid31907.log',
    minutesAgo: 60 * 24 * 4 + 95,
    content: [
      '#',
      '# There is insufficient memory for the Java Runtime Environment to continue.',
      '# Native memory allocation (mmap) failed to map 268435456 bytes for G1 virtual space',
      '# Possible reasons:',
      '#   The system is out of physical RAM or swap space',
      '#',
      '# JRE version: OpenJDK Runtime Environment (25.0.1+8) (build 25.0.1+8-LTS)',
      '#',
      '---------------  S U M M A R Y ------------',
      '',
      'Command Line: -Xms12g -Xmx12g -Dzomboid.steam=1 zombie.network.GameServer -servername DoomerZDemo',
      'Host: AMD Ryzen 7 5800X 8-Core Processor, 16 cores, 31G, Ubuntu 24.04.1 LTS',
      'Time: elapsed time: 3.118 seconds (0d 0h 0m 3s)',
    ].join('\n'),
  },
]

function demoCrashLogList(now: number = Date.now()) {
  return {
    crashLogs: DEMO_CRASH_LOGS.map((log) => ({
      name: log.name,
      path: `/opt/pz/${log.name}`,
      size: log.content.length,
      modified: new Date(now - log.minutesAgo * 60_000).toISOString(),
    })),
    totalCount: DEMO_CRASH_LOGS.length,
  }
}

// ---- World Backups: scheduled backups every 6 hours, ten kept, the last run
// fine. GET /backup/status is backupService.getStatus() plus the route's own
// fields (server/routes/backup.js); the catch-all reply this replaced had no
// schedule, and the Backups page crashed on it.

const DEMO_BACKUP_SCHEDULE = '0 */6 * * *'
const DEMO_SAVES_PATH = '/home/pz/Zomboid/Saves/Multiplayer/DoomerZDemo'
const DEMO_BACKUPS_PATH = '/home/pz/Zomboid/backups'

// Newest first, as backupService.listBackups() sorts them; named the way
// createBackup() names them.
const demoBackupFiles: Array<[created: string, size: number]> = [
  ['2026-06-24T00:00:00.000Z', 412_381_204],
  ['2026-06-23T19:42:17.000Z', 411_906_552],
  ['2026-06-23T18:00:00.000Z', 411_772_918],
  ['2026-06-23T12:00:00.000Z', 409_315_066],
  ['2026-06-23T06:00:00.000Z', 406_840_311],
]
const demoBackups = demoBackupFiles.map(([created, size]) => {
  const name = `DoomerZDemo_${created.replace(/[:.]/g, '-').slice(0, 23)}.zip`
  return { name, path: `${DEMO_BACKUPS_PATH}/${name}`, size, created }
})

// Matches '*', '*/n', 'a-b', 'n' and comma lists of them -- every preset on
// the Backups page and the usual custom expressions.
function cronFieldMatches(field: string, value: number): boolean {
  return field.split(',').some((part) => {
    if (part === '*') return true
    const step = /^\*\/(\d+)$/.exec(part)
    if (step) return value % Number(step[1]) === 0
    const range = /^(\d+)-(\d+)$/.exec(part)
    if (range) return value >= Number(range[1]) && value <= Number(range[2])
    return /^\d+$/.test(part) && Number(part) === value
  })
}

// The next time a five-field cron fires, in UTC, looked for minute by minute
// over the coming week; null when it doesn't fire in that time (or isn't a
// five-field cron).
function demoNextRun(cron: string): string | null {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, day, month, weekday] = fields
  const first = Math.floor(Date.now() / 60_000) + 1
  for (let at = first; at < first + 7 * 24 * 60; at++) {
    const date = new Date(at * 60_000)
    if (
      cronFieldMatches(minute, date.getUTCMinutes()) &&
      cronFieldMatches(hour, date.getUTCHours()) &&
      cronFieldMatches(day, date.getUTCDate()) &&
      cronFieldMatches(month, date.getUTCMonth() + 1) &&
      cronFieldMatches(weekday, date.getUTCDay())
    ) {
      return date.toISOString()
    }
  }
  return null
}

export function getDemoBackupStatus() {
  return {
    enabled: true,
    schedule: DEMO_BACKUP_SCHEDULE,
    maxBackups: 10,
    includeDb: true,
    backupInProgress: false,
    restoreInProgress: false,
    currentRestore: null,
    lastRestore: null,
    lastBackup: demoBackups[0],
    backupCount: demoBackups.length,
    savesPath: DEMO_SAVES_PATH,
    backupsPath: DEMO_BACKUPS_PATH,
    savesExists: true,
    lastScheduledBackupAttempt: {
      success: true,
      message: null,
      messageKey: null,
      messageParams: null,
      executedAt: '2026-06-24T00:00:00.000Z',
      skipReason: null,
      recoveredAt: null,
    },
    backupNextRun: demoNextRun(DEMO_BACKUP_SCHEDULE),
    restartOverlaps: [],
    backupDeferredSince: null,
  }
}

export function getDemoBackupList() {
  return { backups: demoBackups }
}

// GET /api/panel-bridge/leaderboard in the demo. Times are relative to now so
// the "updated" and "last read" lines never look months old. One row has no
// read time (a player the bridge has only seen die), which is what shows the
// "Not read yet" badge. The shape is getLeaderboard's in api.ts.
export function getDemoLeaderboard(now: number = Date.now()) {
  const ago = (minutes: number) => now - minutes * 60_000
  const day = 24 * 60
  const player = (
    id: string,
    username: string,
    displayName: string,
    stats: {
      online: boolean
      currentKills: number
      allTimeKills: number
      currentDays: number
      bestDays: number
      deaths: number
      favoriteWeapon: string | null
      favoriteWeaponKills: number
      lastSeenAt: number
      lastSampledAt?: number
      lastSampleSource?: string
      everRead: boolean
      aliases?: string[]
      awaitingNewLife?: boolean
    },
  ) => ({ id: `steam:${id}`, username, displayName, aliases: [], awaitingNewLife: false, ...stats })
  return {
    success: true,
    data: {
      players: [
        player('76561198000000101', 'marlow_k', 'Marlow K', {
          online: true, currentKills: 312, allTimeKills: 4218, currentDays: 18.4, bestDays: 61.7, deaths: 9,
          favoriteWeapon: 'Baseball Bat', favoriteWeaponKills: 1536,
          lastSeenAt: ago(0), lastSampledAt: ago(0.5), lastSampleSource: 'sweep', everRead: true,
        }),
        player('76561198000000102', 'jess.rae', 'Jess Rae', {
          online: true, currentKills: 148, allTimeKills: 2977, currentDays: 9.2, bestDays: 44, deaths: 14,
          favoriteWeapon: 'Crowbar', favoriteWeaponKills: 801,
          lastSeenAt: ago(0), lastSampledAt: ago(0.5), lastSampleSource: 'sweep', everRead: true,
          aliases: ['jessrae_alt'],
        }),
        player('76561198000000103', 'tomasz', 'Tomasz W', {
          online: false, currentKills: 0, allTimeKills: 3560, currentDays: 0, bestDays: 52.3, deaths: 11,
          favoriteWeapon: 'Sledgehammer', favoriteWeaponKills: 1189,
          lastSeenAt: ago(190), lastSampledAt: ago(195), lastSampleSource: 'death', everRead: true,
          awaitingNewLife: true,
        }),
        player('76561198000000104', 'wren', 'Wren', {
          online: false, currentKills: 76, allTimeKills: 1204, currentDays: 5.8, bestDays: 22.5, deaths: 6,
          favoriteWeapon: 'Hand Axe', favoriteWeaponKills: 402,
          lastSeenAt: ago(day + 95), lastSampledAt: ago(day + 100), lastSampleSource: 'sweep', everRead: true,
        }),
        player('76561198000000105', 'ghostrider_77', 'GhostRider77', {
          online: false, currentKills: 410, allTimeKills: 1890, currentDays: 27.9, bestDays: 27.9, deaths: 3,
          favoriteWeapon: 'Pistol', favoriteWeaponKills: 655,
          lastSeenAt: ago(2 * day + 30), lastSampledAt: ago(2 * day + 35), lastSampleSource: 'sweep', everRead: true,
        }),
        // Seen once, never read: only the death was counted.
        player('76561198000000106', 'nate_b', 'Nate B', {
          online: false, currentKills: 0, allTimeKills: 0, currentDays: 0, bestDays: 0, deaths: 1,
          favoriteWeapon: null, favoriteWeaponKills: 0,
          lastSeenAt: ago(5 * day), everRead: false,
        }),
      ],
      generatedAt: now,
      trackingStartedAt: ago(38 * day),
      diagnostics: {
        bridgeVersion: '1.7.74',
        sweepIntervalMs: 60_000,
        lastSweepAt: ago(0.4),
        sweepCount: 2314,
        lastSweepPlayers: 2,
        loadedFrom: 'leaderboard.json',
        flushSeq: 2301,
        resets: [],
      },
    },
  }
}

function demoBackupHistory() {
  const server = demoServer()
  return {
    records: demoBackups.map((backup, index) => ({
      id: `demo-backup-${index + 1}`,
      fileName: backup.name,
      createdAt: backup.created,
      size: backup.size,
      serverId: server.id,
      serverName: server.name,
    })),
  }
}

function demoBackupSnapshot(name: string) {
  const backup = demoBackups.find((item) => item.name === name)
  if (!backup) return null
  // A snapshot never carries passwords (backupService's safe snapshot).
  const serverIni = Object.fromEntries(Object.entries(demoIniSettings()).filter(([key]) => !/password/i.test(key)))
  return {
    success: true,
    snapshot: {
      schemaVersion: 1,
      createdAt: backup.created,
      server: { id: 'demo-server', name: 'Demo Server', provider: 'native' },
      serverIni,
      sandboxVars: { 'ZombieLore.Speed': 2, 'ZombieLore.Strength': 2, WaterShut: 2, ElecShut: 2, StartMonth: 7 },
    },
  }
}

// POST /backup/validate-schedule: the next run in UTC for anything the demo
// can follow, otherwise the server's own "invalid" verdict.
function demoValidateBackupSchedule(schedule: unknown) {
  const nextRun = typeof schedule === 'string' ? demoNextRun(schedule) : null
  if (!nextRun) {
    return { valid: false, error: 'Invalid cron expression format', code: 'SCHEDULER_INVALID_CRON_EXPRESSION' }
  }
  return { valid: true, nextRun, bothDayFieldsRestricted: false, timezone: 'UTC', restartOverlaps: [] }
}

// ---- Settings > Users and Roles & Permissions: the three seeded roles
// (server/database/init.js) and an account in each. The catch-all reply had
// no lists, and both tabs crashed on it. The capability catalogue mirrors
// server/services/permissions.js; the pages show each one's translated
// label by key, so the English here is only their fallback.

const demoCapabilityGroups: Array<[string, Array<[string, string]>]> = [
  ['Users & Roles', [['users.manage', 'Manage user accounts'], ['roles.manage', 'Manage roles & permissions']]],
  ['Backups', [['backups.manage', 'Create, delete & configure backups'], ['backups.download', 'Download a backup archive'], ['backups.restore', 'Restore a backup']]],
  ['Server Lifecycle', [
    ['server.control', 'Start, stop, restart & save the server'],
    ['server.install', 'Install & update the server'],
    ['server.configure', 'Edit server configuration'],
    ['server.wipe', 'Wipe the world'],
    ['server.world_events', 'Run world events'],
  ]],
  ['RCON', [['rcon.execute', 'Run RCON commands']]],
  ['Server Setup & Fleet', [
    ['servers.manage', 'Add, edit & remove configured servers'],
    ['servers.discover', 'Auto-discover servers on this machine'],
    ['templates.manage', 'Manage server templates'],
  ]],
  ['PanelBridge Integration', [
    ['bridge.setup', 'Connect & configure PanelBridge'],
    ['bridge.diagnostics', 'PanelBridge diagnostics'],
    ['bridge.command', 'Run any PanelBridge action'],
  ]],
  ['Player Authority', [
    ['players.moderate', 'Discipline players'],
    ['players.gm_tools', 'Game-master tools'],
    ['players.view', 'View player info'],
    ['players.endanger_or_impersonate', 'Endanger or impersonate a player'],
  ]],
  ['Mods', [['mods.manage', 'Manage mods']]],
  ['Automation', [['automation.manage', 'Manage scheduled tasks']]],
  ['Integrations', [['integrations.manage', 'Manage integrations']]],
  ['Infrastructure', [
    ['docker.manage', 'Manage the Docker container'],
    ['chunks.manage', 'Manage map chunks'],
    ['serverfiles.manage', 'Edit server config files'],
    ['files.manage', 'Manage server files'],
  ]],
  ['Panel Diagnostics & Settings', [['diagnostics.manage', 'View panel diagnostics'], ['panel.settings', 'Manage panel-wide settings']]],
]

function demoCapabilities() {
  return {
    groups: demoCapabilityGroups.map(([group, capabilities]) => ({
      group,
      capabilities: capabilities.map(([key, label]) => ({ key, label, description: label })),
    })),
  }
}

const DEMO_MODERATOR_CAPABILITIES = ['players.moderate', 'players.gm_tools', 'players.view', 'server.world_events']
const DEMO_TECHNICIAN_CAPABILITIES = [
  'backups.manage', 'backups.download', 'server.control', 'server.install', 'server.configure', 'server.world_events',
  'rcon.execute', 'servers.manage', 'templates.manage', 'bridge.setup', 'bridge.diagnostics', 'players.moderate',
  'players.gm_tools', 'players.view', 'mods.manage', 'automation.manage', 'integrations.manage', 'docker.manage',
  'chunks.manage', 'serverfiles.manage',
]

const demoUsers = [
  { id: 'demo-user-1', username: 'admin', role: 'admin', roleId: 'role-admin', createdAt: '2026-05-18T11:55:00.000Z', lastLogin: demoTimestamp },
  { id: 'demo-user-2', username: 'tech_rosa', role: 'technician', roleId: 'role-technician', createdAt: '2026-05-20T09:30:00.000Z', lastLogin: '2026-06-23T21:12:00.000Z' },
  { id: 'demo-user-3', username: 'mod_kenji', role: 'moderator', roleId: 'role-moderator', createdAt: '2026-06-02T17:45:00.000Z', lastLogin: '2026-06-22T19:03:00.000Z' },
  { id: 'demo-user-4', username: 'mod_alex', role: 'moderator', roleId: 'role-moderator', createdAt: '2026-06-11T14:20:00.000Z', lastLogin: null },
]

function demoRoles() {
  const allCapabilities = demoCapabilityGroups.flatMap(([, capabilities]) => capabilities.map(([key]) => key))
  const seeded: Array<[id: string, name: string, capabilities: string[]]> = [
    ['role-admin', 'admin', allCapabilities],
    ['role-technician', 'technician', DEMO_TECHNICIAN_CAPABILITIES],
    ['role-moderator', 'moderator', DEMO_MODERATOR_CAPABILITIES],
  ]
  return {
    roles: seeded.map(([id, name, capabilities]) => ({
      id,
      name,
      capabilities,
      isSeeded: true,
      createdAt: '2026-05-18T11:55:00.000Z',
      memberCount: demoUsers.filter((user) => user.roleId === id).length,
    })),
  }
}

// ---- Server Files (spec §A14.6): one local profile, its Zomboid folder's
// top level, the Server folder and one .ini. Every change is refused with
// FM_PATH_PROTECTED, so the demo shows the real refusal path.

type DemoFileEntry = {
  name: string
  path: string
  type: 'file' | 'dir'
  size: number | null
  modifiedAt: string
  mode: string
  etag: string
  protection: { level: 'listOnly'; area: 'panelBackups' } | null
  flags: { editable: boolean; binaryHint: boolean; secretBearing: boolean; executable: boolean; worldState: boolean; unsupportedName: boolean }
}

const DEMO_INI = [
  'PVP=true',
  'PauseEmpty=true',
  'GlobalChat=true',
  'Open=true',
  'ServerWelcomeMessage=Welcome to the DoomerZ demo server.',
  'Password=•••',
  'RCONPassword=•••',
  'Mods=TchernoLib;Brita;RavenCreek;AuthenticZLite',
  'WorkshopItems=2392709985;2169435993;2004998206;2849247394',
  'MaxPlayers=16',
  '',
].join('\n')

function demoFileEntry(path: string, type: 'file' | 'dir', size: number | null, extra: Partial<DemoFileEntry> = {}): DemoFileEntry {
  const name = path.split('/').pop() || path
  const editable = type === 'file' && /\.(ini|lua|txt|json)$/i.test(name)
  return {
    name,
    path,
    type,
    size,
    modifiedAt: demoTimestamp,
    mode: type === 'dir' ? '0755' : '0644',
    etag: `s:${size ?? 0}-1750730400000`,
    protection: null,
    flags: { editable, binaryHint: type === 'file' && !editable, secretBearing: name.endsWith('.ini'), executable: false, worldState: false, unsupportedName: false },
    ...extra,
  }
}

const DEMO_DATA_TREE: Record<string, DemoFileEntry[]> = {
  '': [
    demoFileEntry('Logs', 'dir', null),
    demoFileEntry('Saves', 'dir', null),
    demoFileEntry('Server', 'dir', null),
    demoFileEntry('backups', 'dir', null, { protection: { level: 'listOnly', area: 'panelBackups' } }),
    demoFileEntry('db', 'dir', null),
    demoFileEntry('mods', 'dir', null),
    demoFileEntry('console.txt', 'file', 184_320),
  ],
  Server: [
    demoFileEntry('Server/DoomerZDemo.ini', 'file', DEMO_INI.length),
    demoFileEntry('Server/DoomerZDemo_SandboxVars.lua', 'file', 18_944),
    demoFileEntry('Server/DoomerZDemo_spawnpoints.lua', 'file', 412),
    demoFileEntry('Server/DoomerZDemo_spawnregions.lua', 'file', 1_280),
  ],
}

const DEMO_INSTALL_TREE: Record<string, DemoFileEntry[]> = {
  '': [
    demoFileEntry('java', 'dir', null),
    demoFileEntry('media', 'dir', null),
    demoFileEntry('ProjectZomboid64.json', 'file', 2_048),
  ],
}

function demoFilesProfile(withState: boolean) {
  const root = (id: 'install' | 'data', displayPath: string) => ({
    id,
    backend: 'local',
    displayPath,
    available: true,
    writable: true,
    freeBytes: 320_000_000_000,
    totalBytes: 500_000_000_000,
    warnings: [],
    trashItemCount: 0,
  })
  return {
    id: 'demo-server',
    name: 'Demo Server',
    serverName: 'DoomerZDemo',
    isActive: true,
    provider: 'native',
    remote: null,
    roots: [root('install', '/opt/pz'), root('data', '/home/pz/Zomboid')],
    bookmarks: [
      { rootId: 'data', path: 'Server', kind: 'serverSettings' },
      { rootId: 'data', path: 'Logs', kind: 'logs' },
    ],
    ...(withState ? { serverState: 'stopped', serverStateCheckedAt: demoTimestamp } : {}),
  }
}

const DEMO_NOT_FOUND = { error: 'That file or folder is gone. Refresh the list.', code: 'FM_NOT_FOUND' }

export function getDemoFilesResponse(url: URL, method: string): Response {
  const path = url.pathname.slice(url.pathname.indexOf('/api/files') + '/api/files'.length)
  if (method !== 'GET') {
    return jsonResponse({
      error: "This belongs to the panel or PanelBridge and can't be changed here.",
      code: 'FM_PATH_PROTECTED',
      params: { area: 'panelData', level: 'sealed' },
    }, 403)
  }
  if (path === '/profiles') return jsonResponse({ profiles: [demoFilesProfile(false)] })
  if (path === '/audit') return jsonResponse({ entries: [] })
  const match = /^\/profiles\/[^/]+(\/[a-z/]+)?$/.exec(path)
  if (!match) return jsonResponse(DEMO_NOT_FOUND, 404)
  const sub = match[1] ?? ''
  const tree = url.searchParams.get('root') === 'install' ? DEMO_INSTALL_TREE : DEMO_DATA_TREE
  const rel = url.searchParams.get('path') || ''
  const all = Object.values(tree).flat()
  if (sub === '') return jsonResponse({ profile: demoFilesProfile(true) })
  if (sub === '/list') {
    const entries = tree[rel] ?? []
    return jsonResponse({
      dir: demoFileEntry(rel || '.', 'dir', null),
      entries,
      total: entries.length,
      offset: 0,
      limit: 500,
      sortLimited: false,
      truncated: false,
      dirEtag: `demo:${rel}`,
    })
  }
  if (sub === '/stat') {
    const entry = all.find((item) => item.path === rel)
    return entry ? jsonResponse({ entry }) : jsonResponse(DEMO_NOT_FOUND, 404)
  }
  if (sub === '/search') {
    const q = (url.searchParams.get('q') || '').toLowerCase()
    const results = all.filter((item) => item.path.startsWith(rel) && item.name.toLowerCase().includes(q))
    return jsonResponse({ results, truncated: false, scanned: all.length })
  }
  if (sub === '/text') {
    const entry = all.find((item) => item.path === rel)
    if (!entry) return jsonResponse(DEMO_NOT_FOUND, 404)
    const isIni = rel.endsWith('.ini')
    return jsonResponse({
      entry,
      content: isIni ? DEMO_INI : `-- ${entry.name}\n-- Demo mode: no backend is connected.\n`,
      etag: 'h:demo',
      bom: false,
      eol: 'lf',
      masked: isIni,
      truncated: false,
      readOnly: false,
      readOnlyReason: null,
      hints: isIni ? ['restartToApply', 'panelRewritesKeys', 'secretsMasked'] : ['restartToApply'],
      serverState: 'stopped',
    })
  }
  if (sub === '/trash') return jsonResponse({ items: [], totalBytes: 0 })
  return jsonResponse(DEMO_NOT_FOUND, 404)
}

// "Problems found" on Diagnostics: one of each fix kind, matching the demo
// mod list (Brita needs the missing Arsenal(26)GunFighter, so its Mods
// health fix resolves).
export function getDemoProblems(now: number = Date.now()): ServerProblemsResult {
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()
  const base = { source: 'game' as const, timesFromLog: true, modId: null, workshopId: null, mod: null, params: {}, samples: [] }
  const findings: ServerProblem[] = [
    {
      ...base,
      id: 'outOfMemory-6d1f0c2a9b3e4f50',
      kind: 'outOfMemory',
      category: 'server',
      severity: 'critical',
      count: 1,
      firstSeen: at(42),
      lastSeen: at(42),
      message: 'Exception in thread "Thread-31" java.lang.OutOfMemoryError: Java heap space',
      cause: 'The server ran out of memory.',
      params: { detail: 'Java heap space' },
      samples: ['Exception in thread "Thread-31" java.lang.OutOfMemoryError: Java heap space'],
      fixes: [
        { id: 'raiseMemory', type: 'action', action: 'raiseMemory', params: { serverId: 'demo-server', currentGb: 6, nextGb: 8 }, capability: 'servers.manage', safe: true, confirm: false, undo: true, restartNeeded: true },
        { id: 'restartServer', type: 'action', action: 'restartServer', params: {}, capability: 'server.control', safe: false, confirm: true, undo: false },
        { id: 'openServers', type: 'link', to: '/servers', safe: false, confirm: false, undo: false },
      ],
    },
    {
      ...base,
      id: 'modRequiredMissing-2b7c4e91a0d35f68',
      kind: 'modRequiredMissing',
      category: 'mods',
      severity: 'critical',
      count: 2,
      firstSeen: at(58),
      lastSeen: at(57),
      message: 'ZomboidFileSystem.loadMod> required mod "Arsenal(26)GunFighter" not found',
      cause: 'A mod needs "Arsenal(26)GunFighter", which is not installed.',
      params: { missingModId: 'Arsenal(26)GunFighter' },
      samples: ['ERROR: Mod          f:0, t:1774895890000, st:0> ZomboidFileSystem.loadMod> required mod "Arsenal(26)GunFighter" not found'],
      fixes: [
        { id: 'modsHealth', type: 'action', action: 'modsHealthFix', params: { kinds: ['requiredNotInstalled', 'requiredLoadedImplicitly'], modId: 'Arsenal(26)GunFighter' }, capability: 'mods.manage', safe: true, confirm: false, undo: true },
        { id: 'openModsHealth', type: 'link', to: '/mods?view=health', safe: false, confirm: false, undo: false },
      ],
    },
    {
      ...base,
      id: 'luaError-91f3d0a6c2b84e17',
      kind: 'luaError',
      category: 'mods',
      severity: 'warning',
      count: 14,
      firstSeen: at(55),
      lastSeen: at(3),
      message: 'attempted index: getModData of non-table: null',
      cause: 'A Lua script of the mod "Brita\'s Weapon Pack" failed.',
      modId: 'Brita',
      workshopId: '2169435993',
      mod: { id: 'Brita', name: "Brita's Weapon Pack", workshopId: '2169435993', enabled: true },
      params: { modName: "Brita's Weapon Pack", file: 'BritaGunsTooltip.lua', line: 88, function: 'onTooltip', vanilla: false },
      samples: [
        [
          'ERROR: General      f:0, t:1774895897563, st:0> KahluaThread.flushErrorMessage      > dumping Lua stack trace',
          '-----------------------------------------',
          'STACK TRACE',
          '-----------------------------------------',
          "function: onTooltip -- file: BritaGunsTooltip.lua line # 88 | MOD: Brita's Weapon Pack",
          'ERROR: General      f:0, t:1774895897564, st:0> ExceptionLogger.logException> Exception thrown',
          '\tjava.lang.RuntimeException: attempted index: getModData of non-table: null at KahluaThread.tableget(KahluaThread.java:1540).',
        ].join('\n'),
      ],
      fixes: [
        { id: 'disableMod', type: 'action', action: 'disableMod', params: { modId: 'Brita' }, capability: 'mods.manage', safe: false, confirm: true, undo: true },
        { id: 'openMods', type: 'link', to: '/mods?view=active', safe: false, confirm: false, undo: false },
      ],
    },
    {
      ...base,
      id: 'workshopOutdated-0c8e5b7d3a1f2946',
      kind: 'workshopOutdated',
      category: 'mods',
      severity: 'warning',
      count: 1,
      firstSeen: at(9),
      lastSeen: at(9),
      message: 'CheckModsNeedUpdate: Mods need update',
      cause: 'A Workshop mod was updated after the server started.',
      samples: ['LOG  : General      f:0, t:1774895990000, st:0> CheckModsNeedUpdate: Mods need update'],
      fixes: [
        { id: 'restartServer', type: 'action', action: 'restartServer', params: {}, capability: 'server.control', safe: false, confirm: true, undo: false },
        { id: 'openMods', type: 'link', to: '/mods?view=active', safe: false, confirm: false, undo: false },
      ],
    },
    {
      ...base,
      id: 'rconAuth-5e2a9c17b04d8f63',
      kind: 'rconAuth',
      category: 'network',
      severity: 'warning',
      source: 'panel',
      count: 3,
      firstSeen: at(30),
      lastSeen: at(12),
      message: 'Authentication failed. Check RCON password in server settings.',
      cause: 'An RCON connection used the wrong password.',
      params: { from: 'panel' },
      samples: ['[RCON] Authentication failed. Check RCON password in server settings.'],
      fixes: [{ id: 'openServers', type: 'link', to: '/servers', safe: false, confirm: false, undo: false }],
    },
    {
      ...base,
      id: 'other-a4c81f06e9d2b375',
      kind: 'other',
      category: 'server',
      severity: 'info',
      count: 6,
      firstSeen: at(59),
      lastSeen: at(59),
      message: 'CellLoader> missing tile vegetation_groundcover_01_19',
      cause: 'The game logged an error.',
      params: { origin: null },
      samples: ['ERROR: General      f:0> CellLoader> missing tile vegetation_groundcover_01_19'],
      fixes: [{ id: 'openLogs', type: 'link', to: '/debug?tab=logs', safe: false, confirm: false, undo: false }],
    },
  ]
  const counts = { critical: 0, warning: 0, info: 0, total: findings.length }
  for (const finding of findings) counts[finding.severity]++
  return {
    scannedAt: new Date(now).toISOString(),
    server: { id: 'demo-server', name: 'Demo Server', running: true },
    counts,
    findings,
    checked: {
      gameLogLines: 18_412,
      serverStarted: true,
      panelErrors: 3,
      mods: 42,
      hiddenFindings: 0,
      modList: true,
      gameLog: { found: true, file: 'server-console.txt', modified: at(1), partial: false, bytes: 2_310_144 },
    },
  }
}

export function installDemoFetchShim(): void {
  if (!isDemoMode() || demoFetchInstalled) return

  const originalFetch = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = normalizeApiPath(input)
    if (!path.startsWith('/api/')) {
      return originalFetch(input, init)
    }

    const method = (init?.method || 'GET').toUpperCase()

    if (path === '/api/auth/status') {
      return jsonResponse({ needsSetup: false, authEnabled: false })
    }
    if (path === '/api/health') {
      return jsonResponse({
        version: `${(typeof __PANEL_VERSION__ !== 'undefined' ? __PANEL_VERSION__ : '0.0.0')}-demo`,
        panelVersion: typeof __PANEL_VERSION__ !== 'undefined' ? __PANEL_VERSION__ : '0.0.0',
        buildSha: typeof __PANEL_BUILD_SHA__ !== 'undefined' ? __PANEL_BUILD_SHA__ : 'unknown',
        apiContractVersion: typeof __PANEL_API_CONTRACT_VERSION__ !== 'undefined' ? __PANEL_API_CONTRACT_VERSION__ : 1,
      })
    }
    if (path === '/api/system/storage-health') {
      return jsonResponse(demoStorageHealth())
    }
    if (path === '/api/system/runtime') {
      return jsonResponse({
        platform: 'linux',
        family: 'posix',
        pathSeparator: '/',
        temporaryDirectory: '/tmp',
        serviceManager: 'none',
        restartAssessment: {
          gameServers: 'preserved',
          requiresConfirmation: false,
          reason: 'detached-linux-process',
        },
      })
    }
    if (path === '/api/server/status') {
      return jsonResponse(demoServerStatus())
    }
    if (path === '/api/server/setup-plan') {
      return jsonResponse(getDemoSetupPlan())
    }
    if (path === '/api/debug/problems') {
      return jsonResponse(getDemoProblems())
    }
    if (path === '/api/servers/active/status') {
      return jsonResponse(demoComposedStatus())
    }
    if (path === '/api/players') {
      return jsonResponse({ success: true, players: DEMO_ONLINE_PLAYERS.map((p) => ({ name: p.username, online: true })) })
    }
    if (path === '/api/players/activity') {
      return jsonResponse({ success: true, logs: demoPlayerActivity() })
    }
    if (path === '/api/panel-bridge/status') {
      return jsonResponse({
        configured: true,
        bridgePath: '/home/pz/Zomboid/Lua/panelbridge/DoomerZDemo',
        isRunning: true,
        pendingCommands: 0,
        modConnected: true,
        modStatus: { version: '1.7.79', alive: DEMO_ONLINE_PLAYERS.length, lastUpdate: Date.now() },
      })
    }
    if (path === '/api/panel-bridge/players') {
      return jsonResponse({
        success: true,
        data: {
          players: DEMO_ONLINE_PLAYERS.map(({ joinedMinutesAgo: _joined, ...p }) => ({
            ...p, isAlive: true, isInfected: false, hunger: 0.2, thirst: 0.15, fatigue: 0.3,
          })),
        },
      })
    }
    if (path === '/api/panel-bridge/zombies/count') {
      return jsonResponse({ success: true, data: { zombieCount: 1_284, note: 'Loaded cells only' } })
    }
    if (path === '/api/panel-bridge/world/stats') {
      return jsonResponse({ success: true, data: { serverName: 'DoomerZDemo', map: 'Muldraugh, KY', zombiesInCell: 1_284 } })
    }
    if (path === '/api/debug/performance-history') {
      const limit = Number(new URL(String(input instanceof Request ? input.url : input), 'http://demo.local').searchParams.get('limit')) || 60
      return jsonResponse(getDemoPerformanceHistory(limit))
    }
    if (path === '/api/debug/crash-logs') {
      return jsonResponse(demoCrashLogList())
    }
    if (path.startsWith('/api/debug/crash-logs/')) {
      const name = decodeURIComponent(path.slice('/api/debug/crash-logs/'.length))
      const log = DEMO_CRASH_LOGS.find((entry) => entry.name === name)
      return log ? jsonResponse({ content: log.content }) : jsonResponse({ error: 'Not found' }, 404)
    }
    if (path === '/api/panel-bridge/leaderboard') {
      return jsonResponse(getDemoLeaderboard())
    }
    if (path === '/api/panel-bridge/delivery') {
      if (method === 'GET') return jsonResponse(getDemoBridgeDelivery())
      const body = await readJsonBody(init)
      return jsonResponse(getDemoBridgeDeliveryPlan(body.method === 'workshop' ? 'workshop' : 'local'))
    }
    if (path === '/api/panel-info') {
      return jsonResponse({ localIp: '127.0.0.1', port: 3001, url: 'http://demo.local:3001' })
    }
    if (path === '/api/servers') {
      return jsonResponse({ servers: [demoServer()] })
    }
    if (path === '/api/servers/active') {
      return jsonResponse({ server: demoServer() })
    }
    if (path === '/api/servers/lifecycle') {
      return jsonResponse({ lock: null, servers: [] })
    }
    if (path.startsWith('/api/servers/') && path.endsWith('/activate') && method === 'POST') {
      return jsonResponse({ success: true, message: 'Demo mode: active server updated locally only.', server: demoServer() })
    }
    if (path === '/api/server/update/status') {
      return jsonResponse({
        updateAvailable: {
          updateAvailable: false,
          currentVersion: '0.6.0-demo',
        },
      })
    }
    if (path === '/api/server/update-check/status') {
      return jsonResponse({
        updateAvailable: {
          updateAvailable: false,
          installed: { buildId: '21143703', branch: 'unstable', lastUpdated: new Date().toISOString() },
          latest: { buildId: '21143703', branch: 'unstable', timeUpdated: null, description: null },
          lastCheck: new Date().toISOString(),
        },
        gameVersion: '42.15.2',
        lastCheck: new Date().toISOString(),
        intervalMinutes: 30,
        isChecking: false,
      })
    }

    if (path === '/api/backup/status') {
      return jsonResponse(getDemoBackupStatus())
    }
    if (path === '/api/backup/list') {
      return jsonResponse(getDemoBackupList())
    }
    if (path === '/api/backup/history') {
      return jsonResponse(demoBackupHistory())
    }
    if (path === '/api/backup/validate-schedule' && method === 'POST') {
      const body = await readJsonBody(init)
      return jsonResponse(demoValidateBackupSchedule(body.schedule))
    }
    if (path.startsWith('/api/backup/') && path.endsWith('/snapshot')) {
      const name = decodeURIComponent(path.slice('/api/backup/'.length, -'/snapshot'.length))
      const snapshot = demoBackupSnapshot(name)
      return snapshot ? jsonResponse(snapshot) : jsonResponse({ success: false, message: 'Backup not found' }, 404)
    }
    if (path === '/api/auth/users' && method === 'GET') {
      return jsonResponse({ users: demoUsers })
    }
    if (path === '/api/permissions/roles' && method === 'GET') {
      return jsonResponse(demoRoles())
    }
    if (path === '/api/permissions/capabilities') {
      return jsonResponse(demoCapabilities())
    }

    if (path.startsWith('/api/files/')) {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      return getDemoFilesResponse(new URL(rawUrl, window.location.origin), method)
    }

    if (path === '/api/server-files/paths') {
      return jsonResponse({
        configPath: '/home/pz/Zomboid/Server',
        serverName: 'DoomerZDemo',
        files: {
          ini: '/home/pz/Zomboid/Server/DoomerZDemo.ini',
          sandbox: '/home/pz/Zomboid/Server/DoomerZDemo_SandboxVars.lua',
          spawnpoints: '/home/pz/Zomboid/Server/spawnpoints.lua',
          spawnregions: '/home/pz/Zomboid/Server/spawnregions.lua',
        },
        exists: {
          ini: true,
          sandbox: true,
          spawnpoints: true,
          spawnregions: true,
        },
      })
    }
    if (path === '/api/server-files/ini') {
      return jsonResponse({ settings: demoIniSettings(), path: '/home/pz/Zomboid/Server/DoomerZDemo.ini' })
    }
    if (path === '/api/server-files/sandbox') {
      return jsonResponse({
        sandbox: {
          ZombieLore: { Speed: 2, Strength: 2 },
          World: { WaterShut: 2, ElecShut: 2 },
          StartYear: 1,
          StartMonth: 7,
          StartDay: 9,
        },
        path: '/home/pz/Zomboid/Server/DoomerZDemo_SandboxVars.lua',
      })
    }
    if (path === '/api/server-files/spawnpoints') {
      return jsonResponse({
        spawnpoints: {
          unemployed: [{ worldX: 40, worldY: 22, posX: 130, posY: 100, posZ: 0 }],
          fireofficer: [{ worldX: 40, worldY: 23, posX: 140, posY: 180, posZ: 0 }],
        },
        path: '/home/pz/Zomboid/Server/spawnpoints.lua',
      })
    }
    if (path === '/api/server-files/spawnregions') {
      return jsonResponse({
        spawnregions: [
          { name: 'Muldraugh, KY', file: 'media/maps/Muldraugh, KY/spawnpoints.lua' },
          { name: 'West Point, KY', file: 'media/maps/West Point, KY/spawnpoints.lua' },
        ],
        path: '/home/pz/Zomboid/Server/spawnregions.lua',
      })
    }
    if (path.startsWith('/api/server-files/raw/')) {
      const type = path.split('/').pop() || 'ini'
      return jsonResponse({
        content: `-- Demo mode raw file for ${type}\n-- No backend is connected on GitHub Pages.\n`,
        path: `/home/pz/Zomboid/Server/${type}.demo`,
        filename: `${type}.demo`,
      })
    }
    if (path === '/api/server-files/backups') {
      return jsonResponse({ backups: [], path: '/home/pz/Zomboid/Server/backups' })
    }
    if (path === '/api/server-files/templates') {
      return jsonResponse({ templates: [] })
    }
    if (path === '/api/templates') {
      return jsonResponse(getDemoTemplates())
    }
    if (path === '/api/templates/hidden') {
      return jsonResponse({ templates: [] })
    }
    if (path.startsWith('/api/templates/') && path.endsWith('/preview') && method === 'POST') {
      return jsonResponse({ success: true, diff: demoTemplateDiff() })
    }

    if (path === '/api/mods/status') {
      return jsonResponse(demoModsStatus())
    }
    if (path === '/api/mods/tracked') {
      return jsonResponse({ mods: demoTrackedMods })
    }
    if (path === '/api/mods/current-config') {
      return jsonResponse(demoCurrentConfig())
    }
    if (path === '/api/mods/server-mods') {
      return jsonResponse({
        workshopIds: demoCurrentConfig().workshopIds,
        modIds: demoCurrentConfig().modIds,
        maps: demoCurrentConfig().maps,
      })
    }
    if (path === '/api/mods/workshop-status') {
      return jsonResponse({
        configured: true,
        path: '/opt/pz/steamapps/workshop/appworkshop_108600.acf',
        workshopItems: demoTrackedMods.length + 3,
        lastModified: demoTimestamp,
      })
    }
    if (path === '/api/mods/ignored') {
      return jsonResponse([
        { workshop_id: '3000000001', name: 'Authentic Z Mirror', ignored_at: '2026-06-21T11:20:00.000Z' },
      ])
    }
    if (path === '/api/mods/ignored-pairs') {
      return jsonResponse([
        {
          mod_a: 'TchernoLib',
          mod_b: 'Brita',
          reason: 'Known library dependency, kept visible as low priority in demo scan.',
          server_id: 'demo-server',
          ignored_at: '2026-06-22T19:15:00.000Z',
        },
      ])
    }
    if (path === '/api/mods/conflicts' || path === '/api/mods/conflicts/cached') {
      return jsonResponse(demoConflictScan())
    }
    if (path === '/api/mods/disk-only') {
      return jsonResponse({
        mods: [
          { workshop_id: '2719327441', name: 'Mod Manager: Server' },
          { workshop_id: '3000000002', name: 'Legacy Vehicle Pack' },
        ],
      })
    }
    if (path === '/api/mods/presets') {
      return jsonResponse({
        presets: [
          { id: 1, name: 'Weekend PVE', description: 'Stable collection used for normal sessions.', mod_count: 4, created_at: '2026-06-01T12:00:00.000Z' },
          { id: 2, name: 'Event Night', description: 'Adds heavier loot and vehicle mods for short events.', mod_count: 7, created_at: '2026-06-10T18:30:00.000Z' },
        ],
      })
    }
    if (path === '/api/mods/groups' && method === 'GET') {
      return jsonResponse({ groups: demoModGroups, enforce: demoModGroupsEnforce })
    }
    if (path === '/api/mods/groups' && method === 'POST') {
      const body = await readJsonBody(init)
      const modIds = demoModIdList(body.modIds)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name || modIds.length === 0) {
        return jsonResponse({ error: 'A group needs a name and mod IDs.', code: 'MODS_GROUP_INVALID' }, 400)
      }
      const now = new Date().toISOString()
      const group: DemoModGroup = {
        id: `demo-group-${++demoModGroupSeq}`,
        name,
        description: typeof body.description === 'string' ? body.description.trim() : '',
        modIds,
        createdAt: now,
        updatedAt: now,
        color: demoGroupColor(body.color, null),
        keepTogether: body.keepTogether === true,
        placement: demoPlacement(body.placement, null),
      }
      demoModGroups = [...demoModGroups, group]
      return jsonResponse({ group }, 201)
    }
    if (path === '/api/mods/groups/suggestions' && method === 'GET') {
      const existing = demoModGroups.map((group) => new Set(group.modIds))
      const suggestions = demoGroupSuggestions.filter((suggestion) =>
        !demoDismissedSuggestions.has(suggestion.key) &&
        !existing.some((members) => suggestion.modIds.every((id) => members.has(id))))
      return jsonResponse({ suggestions })
    }
    if (path === '/api/mods/groups/suggestions/dismiss' && method === 'POST') {
      const body = await readJsonBody(init)
      if (typeof body.key === 'string') demoDismissedSuggestions.add(body.key)
      return jsonResponse({ success: true })
    }
    const groupAction = path.match(/^\/api\/mods\/groups\/([^/]+)\/(enable|disable)$/)
    if (groupAction && method === 'POST') {
      const group = demoModGroups.find((entry) => entry.id === decodeURIComponent(groupAction[1]))
      if (!group) return jsonResponse({ error: 'Group not found.', code: 'MODS_GROUP_NOT_FOUND' }, 404)
      if (groupAction[2] === 'enable') return jsonResponse(demoEnableGroup(group))
      const body = await readJsonBody(init)
      return jsonResponse(demoDisableGroup(group, body.keepShared !== false))
    }
    if (path === '/api/mods/notes' && method === 'GET') {
      return jsonResponse({ notes: demoModNotes })
    }
    if (path.startsWith('/api/mods/notes/') && method === 'PUT') {
      const workshopId = decodeURIComponent(path.slice('/api/mods/notes/'.length))
      const body = await readJsonBody(init)
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (text.length > 1000) {
        return jsonResponse({ error: 'A mod note can be at most 1000 characters', code: 'MODS_NOTE_TOO_LONG', params: { max: 1000 } }, 400)
      }
      if (!text) {
        delete demoModNotes[workshopId]
        return jsonResponse({ note: null })
      }
      demoModNotes[workshopId] = { text, updatedAt: new Date().toISOString(), updatedBy: 'admin' }
      return jsonResponse({ note: demoModNotes[workshopId] })
    }
    if (path === '/api/mods/groups/status' && method === 'GET') {
      return jsonResponse(demoModGroupsStatus())
    }
    if (path === '/api/mods/groups/apply' && method === 'POST') {
      const body = await readJsonBody(init)
      return jsonResponse(demoApplyModGroups(body.preview !== true))
    }
    if (path === '/api/mods/groups/enforce' && method === 'PUT') {
      const body = await readJsonBody(init)
      demoModGroupsEnforce = body.enforce === true
      return jsonResponse({ enforce: demoModGroupsEnforce })
    }
    if (path === '/api/mods/groups/import' && method === 'POST') {
      const body = await readJsonBody(init)
      const doc = (body.document && typeof body.document === 'object' ? body.document : {}) as Record<string, unknown>
      const modIds = demoModIdList(doc.modIds)
      const name = typeof doc.name === 'string' ? doc.name.trim() : ''
      if (doc.kind !== 'zcp-mod-group' || !name || modIds.length === 0) {
        return jsonResponse({ error: 'This is not a mod group export.', code: 'MODS_GROUP_IMPORT_INVALID' }, 400)
      }
      const now = new Date().toISOString()
      const group: DemoModGroup = {
        id: `demo-group-${++demoModGroupSeq}`,
        name,
        description: typeof doc.description === 'string' ? doc.description.trim() : '',
        modIds,
        createdAt: now,
        updatedAt: now,
        color: demoGroupColor(doc.color, null),
        keepTogether: doc.keepTogether === true,
        placement: demoPlacement(doc.placement, null),
      }
      demoModGroups = [...demoModGroups, group]
      return jsonResponse({ group }, 201)
    }
    if (path.startsWith('/api/mods/groups/') && (method === 'PUT' || method === 'DELETE')) {
      const id = decodeURIComponent(path.slice('/api/mods/groups/'.length))
      const existing = demoModGroups.find(group => group.id === id)
      if (!existing) return jsonResponse({ error: 'Group not found.', code: 'MODS_GROUP_NOT_FOUND' }, 404)
      if (method === 'DELETE') {
        demoModGroups = demoModGroups.filter(group => group.id !== id)
        return jsonResponse({ success: true })
      }
      const body = await readJsonBody(init)
      const modIds = body.modIds === undefined ? existing.modIds : demoModIdList(body.modIds)
      const name = typeof body.name === 'string' ? body.name.trim() : existing.name
      if (!name || modIds.length === 0) {
        return jsonResponse({ error: 'A group needs a name and mod IDs.', code: 'MODS_GROUP_INVALID' }, 400)
      }
      const group: DemoModGroup = {
        ...existing,
        name,
        description: typeof body.description === 'string' ? body.description.trim() : existing.description,
        modIds,
        color: body.color === undefined ? existing.color : demoGroupColor(body.color, existing.color),
        keepTogether: typeof body.keepTogether === 'boolean' ? body.keepTogether : existing.keepTogether,
        placement: body.placement === undefined ? existing.placement ?? null : demoPlacement(body.placement, existing.placement ?? null),
        updatedAt: new Date().toISOString(),
      }
      demoModGroups = demoModGroups.map(entry => (entry.id === id ? group : entry))
      return jsonResponse({ group })
    }
    if ((path === '/api/mods/toggle-mod-id' || path === '/api/mods/batch-toggle-mod-ids') && method === 'POST') {
      const body = await readJsonBody(init)
      const changes = path.endsWith('batch-toggle-mod-ids')
        ? (Array.isArray(body.changes) ? body.changes : []) as Array<{ modId?: unknown; enabled?: unknown }>
        : [{ modId: body.modId, enabled: body.enabled }]
      for (const change of changes) {
        if (typeof change.modId !== 'string') continue
        if (change.enabled === true && !demoModLoadOrder.includes(change.modId)) demoModLoadOrder = [...demoModLoadOrder, change.modId]
        if (change.enabled === false) demoModLoadOrder = demoModLoadOrder.filter((id) => id !== change.modId)
      }
      return jsonResponse({ success: true, changed: changes.length, modIds: demoModLoadOrder })
    }
    if (path === '/api/mods/save-order' && method === 'POST') {
      const body = await readJsonBody(init)
      const modIds = demoModIdList(body.modIds)
      if (modIds.length > 0) demoModLoadOrder = modIds
      const adjusted = demoModGroupsEnforce ? demoApplyModGroups(true).moved : []
      return jsonResponse({
        message: 'Mod load order saved successfully',
        modCount: demoModLoadOrder.length,
        groupsAdjusted: adjusted,
        groupConflicts: [],
      })
    }
    if (path === '/api/mods/search-workshop-mods' && method === 'POST') {
      const body = await readJsonBody(init)
      return jsonResponse(demoWorkshopSearch(typeof body.query === 'string' ? body.query : ''))
    }
    if (path === '/api/mods/discover-mod-ids' && method === 'POST') {
      const body = await readJsonBody(init)
      const workshopId = typeof body.workshopId === 'string' && body.workshopId ? body.workshopId : '2849247394'
      return jsonResponse({
        success: true,
        workshopId,
        name: workshopId === '2849247394' ? 'Authentic Z' : `Workshop Mod ${workshopId}`,
        description: 'Demo mode discovery result from static metadata.',
        modIds: workshopId === '2849247394' ? ['AuthenticZLite', 'AuthenticZBackpacks'] : ['DemoModId'],
        hasMultipleModIds: workshopId === '2849247394',
        sources: workshopId === '2849247394'
          ? [
              { modId: 'AuthenticZLite', source: 'mod.info' },
              { modId: 'AuthenticZBackpacks', source: 'mod.info' },
            ]
          : [{ modId: 'DemoModId', source: 'mod.info' }],
        isMap: false,
        mapFolders: [],
        isDownloaded: true,
        tags: ['Demo', 'Workshop'],
      })
    }
    if (path === '/api/mods/import-collection' && method === 'POST') {
      return jsonResponse({
        success: true,
        collectionTitle: 'DoomerZ Demo Collection',
        imported: demoTrackedMods.length,
        skipped: 1,
        mods: demoTrackedMods,
        message: 'Demo mode: collection import preview acknowledged.',
      })
    }
    if (path === '/api/mods/get-mod-info' && method === 'POST') {
      const body = await readJsonBody(init)
      const workshopId = typeof body.workshopId === 'string' ? body.workshopId : '2849247394'
      const known = demoTrackedMods.find(mod => mod.workshop_id === workshopId)
      return jsonResponse({
        success: true,
        workshopId,
        name: known?.name || `Workshop Mod ${workshopId}`,
        title: known?.name || `Workshop Mod ${workshopId}`,
        description: 'Demo mode Workshop metadata.',
      })
    }
    if (path === '/api/mods/collection/diff') {
      return jsonResponse(demoCollectionDiff())
    }
    if (path === '/api/mods/collection/test' && method === 'POST') {
      return jsonResponse({
        success: true,
        collectionId: '3001234567',
        title: 'DoomerZ Demo Collection',
        itemCount: 4,
        message: 'Demo mode: collection credentials look ready.',
      })
    }
    if (path === '/api/mods/collection/sync' && method === 'POST') {
      return jsonResponse({
        success: true,
        collectionId: '3001234567',
        added: ['2849247394', '3000000003'],
        removed: ['3000000002'],
        errors: [],
        message: 'Demo mode: collection would be brought back in sync.',
      })
    }
    if (path === '/api/mods/collection/browsers') {
      return jsonResponse({
        supported: true,
        platform: 'demo',
        browsers: [
          { id: 'firefox', label: 'Firefox', family: 'firefox', detected: true },
          { id: 'chrome', label: 'Chrome', family: 'chromium', detected: false },
        ],
      })
    }
    if (path === '/api/mods/collection/extract-cookies' && method === 'POST') {
      // Matches the real route's response shape: the server saves the
      // credentials itself and reports success, it never echoes them back.
      return jsonResponse({
        ok: true,
        browser: 'firefox',
        saved: true,
        notes: ['Demo mode does not read browser cookies.'],
      })
    }
    if (path === '/api/mods/collection/items' && method === 'POST') {
      const body = await readJsonBody(init)
      return jsonResponse({ ok: true, workshopId: body.workshopId || 'demo', action: 'add' })
    }
    if (path.startsWith('/api/mods/collection/items/') && method === 'DELETE') {
      return jsonResponse({ ok: true, workshopId: path.split('/').pop(), action: 'remove' })
    }
    if (path === '/api/mods/resolve-missing-deps' && method === 'POST') {
      return jsonResponse({
        success: true,
        resolvedCount: 1,
        deps: [
          { missingDep: 'Arsenal(26)GunFighter', resolvedWorkshopId: '2297098490', resolvedModName: 'Arsenal GunFighter' },
        ],
      })
    }
    if (path === '/api/mods/add-missing-dep' && method === 'POST') {
      return jsonResponse({
        success: true,
        workshopId: '2297098490',
        modId: 'Arsenal(26)GunFighter',
        wsAdded: true,
        modIdAdded: true,
        mapFolders: [],
        message: 'Demo mode: dependency would be added to the server INI.',
      })
    }
    if (path === '/api/mods/add-all-resolved-deps' && method === 'POST') {
      return jsonResponse({
        success: true,
        total: 1,
        wsAdded: 1,
        modIdsAdded: 1,
        mapFolders: [],
        message: 'Demo mode: resolved dependencies would be added.',
      })
    }
    if (path === '/api/mods/enable-disk-mod' && method === 'POST') {
      const body = await readJsonBody(init)
      return jsonResponse({ success: true, workshopId: body.workshopId || 'demo', modIdsAdded: 1 })
    }
    if (path === '/api/mods/delete-disk-mod' && method === 'POST') {
      const body = await readJsonBody(init)
      return jsonResponse({ success: true, workshopId: body.workshopId || 'demo', deletedFromDisk: true, modIdsStripped: 1 })
    }
    if (path === '/api/mods/batch-delete-disk-mods' && method === 'POST') {
      const body = await readJsonBody(init)
      const ids = Array.isArray(body.workshopIds) ? body.workshopIds : []
      return jsonResponse({
        success: true,
        total: ids.length,
        deletedFromDisk: ids.length,
        modIdsStripped: ids.length,
        results: ids.map(workshopId => ({ workshopId, deletedFromDisk: true })),
      })
    }
    if (path.startsWith('/api/mods/presets/') && method === 'POST') {
      return jsonResponse({ success: true, message: 'Demo mode: preset would be applied.' })
    }
    if (path === '/api/mods/add-mod-advanced' && method === 'POST') {
      const body = await readJsonBody(init)
      const selectedModIds = Array.isArray(body.selectedModIds) ? body.selectedModIds : ['DemoModId']
      return jsonResponse({
        success: true,
        workshopId: body.workshopId || 'demo',
        addedModIds: selectedModIds,
        totalModIdsInConfig: demoCurrentConfig().modIds.length + selectedModIds.length,
        workshopAlreadyExisted: false,
        mapFoldersAdded: [],
        message: 'Demo mode: selected mod IDs would be written to the INI.',
      })
    }
    if (path === '/api/mods/add-to-ini-bulk' && method === 'POST') {
      const body = await readJsonBody(init)
      const mods: Array<{ workshopId?: unknown }> = Array.isArray(body.mods) ? body.mods : []
      return jsonResponse({
        success: true,
        total: mods.length,
        added: mods.length,
        alreadyConfigured: 0,
        workshopOnly: 0,
        invalid: 0,
        mapFoldersAdded: [],
        results: mods.map((mod) => ({
          workshopId: String(mod.workshopId ?? 'demo'),
          status: 'added',
          addedModIds: ['DemoModId'],
          alternativeModIds: [],
          mapFoldersAdded: [],
          workshopAlreadyExisted: false,
          detectionSource: 'local-files',
        })),
      })
    }
    if (path.startsWith('/api/mods/')) {
      const smart = demoSmartResponse(demoSmartContext, path, method, method === 'GET' || method === 'DELETE' ? {} : await readJsonBody(init))
      if (smart) return jsonResponse(smart.payload, smart.status)
    }
    if (path.startsWith('/api/mods/') && method !== 'GET') {
      return jsonResponse({ success: true, message: 'Demo mode: mod action acknowledged (no backend connected).' })
    }

    if (method !== 'GET') {
      return jsonResponse({ success: true, message: 'Demo mode: action acknowledged (no backend connected).' })
    }

    return jsonResponse({ success: true, demo: true })
  }

  demoFetchInstalled = true
}
