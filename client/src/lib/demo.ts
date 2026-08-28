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

const demoTrackedMods = [
  {
    id: 1,
    workshop_id: '2392709985',
    name: 'Tsar\'s Common Library 2.0',
    last_updated: '2026-06-23T20:15:00.000Z',
    last_checked: demoTimestamp,
    update_available: 0,
    created_at: '2026-05-18T12:00:00.000Z',
    active: true,
  },
  {
    id: 2,
    workshop_id: '2169435993',
    name: 'Brita\'s Weapon Pack',
    last_updated: '2026-06-24T01:10:00.000Z',
    last_checked: demoTimestamp,
    update_available: 1,
    created_at: '2026-05-18T12:05:00.000Z',
    active: true,
  },
  {
    id: 3,
    workshop_id: '2004998206',
    name: 'Raven Creek',
    last_updated: '2026-06-20T09:30:00.000Z',
    last_checked: demoTimestamp,
    update_available: 0,
    created_at: '2026-05-18T12:10:00.000Z',
    active: true,
  },
  {
    id: 4,
    workshop_id: '2849247394',
    name: 'Authentic Z',
    last_updated: '2026-06-18T15:45:00.000Z',
    last_checked: demoTimestamp,
    update_available: 0,
    created_at: '2026-05-18T12:15:00.000Z',
    active: true,
  },
  {
    id: 5,
    workshop_id: '3000000003',
    name: 'Expanded Helicopter Events',
    last_updated: '2026-06-12T08:10:00.000Z',
    last_checked: demoTimestamp,
    update_available: 0,
    created_at: '2026-05-25T14:00:00.000Z',
    active: false,
  },
]

const demoWorkshopModMap = {
  '2392709985': [{ id: 'TchernoLib', name: 'Tsar\'s Common Library 2.0', enabled: true }],
  '2169435993': [{ id: 'Brita', name: 'Brita\'s Weapon Pack', enabled: true, require: ['TchernoLib', 'Arsenal(26)GunFighter'] }],
  '2004998206': [{ id: 'RavenCreek', name: 'Raven Creek', enabled: true }],
  '2849247394': [
    { id: 'AuthenticZLite', name: 'Authentic Z Lite', enabled: true },
    { id: 'AuthenticZBackpacks', name: 'Authentic Z Backpacks', enabled: false },
  ],
}

function demoModsStatus() {
  return {
    totalModsTracked: demoTrackedMods.length,
    totalModsInWorkshop: 7,
    updatesAvailable: 1,
    lastCheck: demoTimestamp,
    lastUpdateDetected: '2026-06-24T01:20:00.000Z',
    autoRestartEnabled: true,
    running: false,
    workshopAcfConfigured: true,
    workshopAcfPath: '/opt/pz/steamapps/workshop/appworkshop_108600.acf',
    checkInterval: 30,
    modsNeedingUpdate: [
      {
        workshopId: '2169435993',
        name: 'Brita\'s Weapon Pack',
        localTimestamp: '2026-06-23T11:30:00.000Z',
        latestTimestamp: '2026-06-24T01:10:00.000Z',
      },
    ],
    restartWarningMinutes: 5,
    delayIfPlayersOnline: true,
    maxDelayMinutes: 30,
    pendingRestart: false,
  }
}

function demoCurrentConfig() {
  const workshopIds = demoTrackedMods.filter(mod => mod.active !== false).map(mod => mod.workshop_id)
  const modIds = ['TchernoLib', 'Brita', 'RavenCreek', 'AuthenticZLite']
  return {
    configured: true,
    modIds,
    workshopIds,
    maps: ['Muldraugh, KY', 'RavenCreek'],
    totalMods: modIds.length,
    iniPath: '/home/pz/Zomboid/Server/DoomerZDemo.ini',
    workshopModMap: demoWorkshopModMap,
  }
}

function demoConflictScan() {
  return {
    totalConflicts: 3,
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
    totalPairs: 2,
    modsScanned: 4,
    modsNotFound: 0,
    modsSkippedInactive: 1,
    totalWorkshopIds: demoCurrentConfig().workshopIds.length,
    modLoadOrder: ['TchernoLib', 'Brita', 'RavenCreek', 'AuthenticZLite'],
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
    ],
    stale: false,
    _workshopIdsSnapshot: demoCurrentConfig().workshopIds,
    _modIdsSnapshot: ['TchernoLib', 'Brita', 'RavenCreek', 'AuthenticZLite'],
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
    minMemory: 2048,
    maxMemory: 4096,
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

function demoServerStatus() {
  return {
    running: false,
    startTime: null,
    uptime: 0,
    serverPath: '/opt/pz',
    configured: true,
    localIp: '127.0.0.1',
    port: 16261,
    rcon: { host: '127.0.0.1', port: 27015, connected: false },
  }
}

function demoComposedStatus() {
  return {
    provider: 'native',
    selected: true,
    host: { status: 'stopped', label: 'Stopped', detail: null },
    server: { status: 'disconnected', label: 'Disconnected', detail: null },
    bridge: { status: 'offline', label: 'Offline', detail: null },
    summary: 'Demo server is offline',
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
    if (path === '/api/server/status') {
      return jsonResponse(demoServerStatus())
    }
    if (path === '/api/servers/active/status') {
      return jsonResponse(demoComposedStatus())
    }
    if (path === '/api/players') {
      return jsonResponse({ players: [] })
    }
    if (path === '/api/panel-bridge/status') {
      return jsonResponse({ configured: true, isRunning: false, modConnected: false, modStatus: null })
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
