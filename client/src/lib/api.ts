const API_BASE = '/api'

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 5000,
  fetchTimeout: 15000, // 15 second timeout for fetch requests
}

// Exponential backoff with jitter
function getRetryDelay(attempt: number): number {
  const delay = Math.min(
    RETRY_CONFIG.baseDelay * Math.pow(2, attempt),
    RETRY_CONFIG.maxDelay
  )
  // Add jitter (±25%)
  return delay * (0.75 + Math.random() * 0.5)
}

// Check if error is retryable
function isRetryableError(error: unknown, response?: Response): boolean {
  // Network errors are retryable
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return true
  }
  // Abort errors (timeout) are retryable
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true
  }
  // 5xx errors are retryable
  if (response && response.status >= 500) {
    return true
  }
  // 429 Too Many Requests is retryable
  if (response?.status === 429) {
    return true
  }
  return false
}

async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  retries: number = RETRY_CONFIG.maxRetries
): Promise<Response> {
  let lastError: unknown
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Create AbortController for timeout
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), RETRY_CONFIG.fetchTimeout)
      
      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        })
        clearTimeout(timeoutId)
        
        // If response is not retryable error, return it
        if (!isRetryableError(null, response) || attempt === retries) {
          return response
        }
      } catch (error) {
        clearTimeout(timeoutId)
        throw error
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, getRetryDelay(attempt)))
    } catch (error) {
      lastError = error
      
      // Don't retry if it's the last attempt or non-retryable
      if (attempt === retries || !isRetryableError(error)) {
        throw error
      }
      
      console.warn(`Request failed, retrying (${attempt + 1}/${retries})...`, error)
      await new Promise(resolve => setTimeout(resolve, getRetryDelay(attempt)))
    }
  }
  
  throw lastError
}

async function handleResponse(response: Response) {
  let data
  try {
    data = await response.json()
  } catch {
    // Non-JSON response (e.g., HTML error page, empty body)
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`)
    }
    throw new Error('Invalid JSON response from server')
  }
  if (!response.ok) {
    throw new Error(data.error || 'Request failed')
  }
  return data
}

// Helper for GET requests with retry
function apiGet(endpoint: string) {
  return fetchWithRetry(`${API_BASE}${endpoint}`).then(handleResponse)
}

// Helper for POST requests with retry
function apiPost(endpoint: string, body?: unknown) {
  return fetchWithRetry(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(handleResponse)
}

// Helper for DELETE requests with retry
function apiDelete(endpoint: string) {
  return fetchWithRetry(`${API_BASE}${endpoint}`, { method: 'DELETE' }).then(handleResponse)
}

// Helper for PUT requests with retry
function apiPut(endpoint: string, body?: unknown) {
  return fetchWithRetry(`${API_BASE}${endpoint}`, {
    method: 'PUT',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(handleResponse)
}

// Steam branch info
export interface SteamBranch {
  name: string
  description: string
  buildId?: string | null
  timeUpdated?: string | null
}

// Character export/import types
export interface PerkData {
  level: number
  xp: number
}

export interface CharacterStats {
  hunger?: number
  thirst?: number
  fatigue?: number
  stress?: number
  boredom?: number
  endurance?: number
  health?: number
  panic?: number
  unhappyness?: number
}

export interface CharacterExportData {
  username: string
  exportedAt: string
  perks: Record<string, PerkData>
  stats: CharacterStats
  recipes: string[]
  traits?: string[]
  health?: {
    overall: number
    infection?: number
    bodyParts?: Array<{
      type: string
      health: number
      isBleeding: boolean
      isBandaged: boolean
      hasScratch: boolean
      hasBite: boolean
      isBurnt: boolean
      isCut: boolean
    }>
  }
}

export interface CharacterExportResponse {
  success: boolean
  data: CharacterExportData
  error?: string
}

export interface CharacterImportData {
  perks?: Record<string, PerkData>
  stats?: CharacterStats
  recipes?: string[]
}

export interface CharacterImportResponse {
  success: boolean
  data: {
    message: string
    restored: {
      perks: number
      stats: boolean
      recipes: number
    }
    note: string
  }
  error?: string
}

// Server API
export const serverApi = {
  getStatus: () => apiGet('/server/status'),
  start: () => apiPost('/server/start'),
  stop: () => apiPost('/server/stop'),
  forceStop: () => apiPost('/server/force-stop'),
  restart: (warningMinutes?: number) => apiPost('/server/restart', { warningMinutes }),
  restartNow: () => apiPost('/server/restart', { warningMinutes: 0 }),
  save: () => apiPost('/server/save'),
  sendMessage: (message: string) => apiPost('/server/message', { message }),
  
  // Get available Steam branches
  getBranches: (steamcmdPath?: string) => 
    apiGet(`/server/branches${steamcmdPath ? `?steamcmdPath=${encodeURIComponent(steamcmdPath)}` : ''}`) as Promise<{ branches: SteamBranch[]; source: string; message: string }>,
  
  // SteamCMD Installation
  install: (config: { steamcmdPath: string; installPath: string; serverName: string; branch?: string }) =>
    apiPost('/server/install', config),
  
  // Configure RCON in server ini file
  configureRcon: (config: { rconPassword: string; rconPort?: number }) =>
    apiPost('/server/configure-rcon', config),
  
  // Configure network settings (port, UPnP) in server ini file
  configureNetwork: (config: { serverPort?: number; useUpnp?: boolean }) =>
    apiPost('/server/configure-network', config),
  
  // SteamCMD auto-download
  downloadSteamCmd: (installPath?: string) => apiPost('/server/steamcmd/download', { installPath }),
  checkSteamCmd: (path: string) => apiGet(`/server/steamcmd/check?path=${encodeURIComponent(path)}`),
  
  // Folder browser
  browseFolder: (initialPath?: string, description?: string) => 
    apiPost('/server/browse-folder', { initialPath, description }),
  
  // Weather
  startRain: (intensity?: number) => apiPost('/server/weather/start-rain', { intensity }),
  stopRain: () => apiPost('/server/weather/stop-rain'),
  startStorm: (duration?: number) => apiPost('/server/weather/start-storm', { duration }),
  stopWeather: () => apiPost('/server/weather/stop'),

  // Events
  triggerChopper: () => apiPost('/server/events/chopper'),
  triggerGunshot: () => apiPost('/server/events/gunshot'),
  triggerLightning: (username?: string) => apiPost('/server/events/lightning', { username }),
  triggerThunder: (username?: string) => apiPost('/server/events/thunder', { username }),
  createHorde: (count: number, username?: string) => apiPost('/server/events/horde', { count, username }),
  
  // Additional events
  alarm: () => apiPost('/server/alarm'),
  removeZombies: () => apiPost('/server/removezombies'),
  
  // Lua
  reloadLua: (filename: string) => apiPost('/server/reloadlua', { filename }),
  
  // Logging
  setLogLevel: (type: string, level: string) => apiPost('/server/log', { type, level }),
  
  // Statistics
  setStats: (mode: string, period?: number) => apiPost('/server/stats', { mode, period }),
  
  // Safehouse
  releaseSafehouse: () => apiPost('/server/releasesafehouse'),
  
  // Server Console Log (server-console.txt)
  getConsoleLog: (lines?: number) => apiGet(`/server/console-log${lines ? `?lines=${lines}` : ''}`),
  streamConsoleLog: (lastSize: number) => apiGet(`/server/console-log/stream?lastSize=${lastSize}`),
  clearConsoleLog: () => apiPost('/server/console-log/clear'),
}

// Players API
export const playersApi = {
  getPlayers: () => apiGet('/players'),
  kick: (username: string, reason?: string) => apiPost('/players/kick', { username, reason }),
  ban: (username: string, banIp?: boolean, reason?: string) => apiPost('/players/ban', { username, banIp, reason }),
  unban: (username: string) => apiPost('/players/unban', { username }),
  setAccessLevel: (username: string, level: string) => apiPost('/players/access-level', { username, level }),
  addToWhitelist: (username: string) => apiPost('/players/whitelist/add', { username }),
  removeFromWhitelist: (username: string) => apiPost('/players/whitelist/remove', { username }),
  teleport: (player1: string, player2?: string) => apiPost('/players/teleport', { player1, player2 }),
  addItem: (username: string | null, item: string, count?: number) => apiPost('/players/add-item', { username, item, count }),
  addXp: (username: string, perk: string, amount: number) => apiPost('/players/add-xp', { username, perk, amount }),
  addVehicle: (vehicle: string, username?: string) => apiPost('/players/add-vehicle', { vehicle, username }),
  setGodMode: (username: string | null, enabled: boolean) => apiPost('/players/godmode', { username, enabled }),
  setInvisible: (username: string | null, enabled: boolean) => apiPost('/players/invisible', { username, enabled }),
  setNoclip: (username: string | null, enabled: boolean) => apiPost('/players/noclip', { username, enabled }),
  getVehicles: () => apiGet('/players/vehicles'),
  getPerks: () => apiGet('/players/perks'),
  getAccessLevels: () => apiGet('/players/access-levels'),
  // Ban/unban by SteamID
  banSteamId: (steamId: string) => apiPost('/players/banid', { steamId }),
  unbanSteamId: (steamId: string) => apiPost('/players/unbanid', { steamId }),
  // Voice ban
  voiceBan: (username: string, enabled: boolean) => apiPost('/players/voiceban', { username, enabled }),
  // Add user with password (for whitelist servers)
  addUser: (username: string, password: string) => apiPost('/players/adduser', { username, password }),
  // Add all connected to whitelist
  addAllToWhitelist: () => apiPost('/players/whitelist/addall'),
  // Activity logs
  getActivityLogs: (player?: string, limit?: number) => apiGet(`/players/activity?${player ? `player=${encodeURIComponent(player)}&` : ''}limit=${limit || 100}`),
  // Player Notes
  getNotes: () => apiGet('/players/notes'),
  getNote: (playerName: string) => apiGet(`/players/notes/${encodeURIComponent(playerName)}`),
  saveNote: (playerName: string, note: string, tags: string[]) => apiPost('/players/notes', { playerName, note, tags }),
  deleteNote: (playerName: string) => apiDelete(`/players/notes/${encodeURIComponent(playerName)}`),
  // Player Stats (playtime tracking)
  getStats: () => apiGet('/players/stats'),
  getStat: (playerName: string) => apiGet(`/players/stats/${encodeURIComponent(playerName)}`),
}

// RCON API
export const rconApi = {
  execute: (command: string) => apiPost('/rcon/execute', { command }),
  getStatus: () => apiGet('/rcon/status'),
  connect: (host?: string, port?: number, password?: string) => apiPost('/rcon/connect', { host, port, password }),
  disconnect: () => apiPost('/rcon/disconnect'),
  getHistory: (limit?: number) => apiGet(`/rcon/history?limit=${limit || 100}`),
  getCommands: () => apiGet('/rcon/commands'),
}

// Scheduler API
export interface ScheduleHistoryEntry {
  id: number
  task_id: number | null
  task_name: string
  command: string
  success: number
  message: string | null
  duration: number | null
  executed_at: string
}

export const schedulerApi = {
  getStatus: () => apiGet('/scheduler/status'),
  getTasks: () => apiGet('/scheduler/tasks'),
  createTask: (name: string, cronExpression: string, command: string) =>
    apiPost('/scheduler/tasks', { name, cronExpression, command }),
  updateTask: (id: number, name: string, cronExpression: string, command: string, enabled: boolean) =>
    apiPut(`/scheduler/tasks/${id}`, { name, cronExpression, command, enabled }),
  deleteTask: (id: number) => apiDelete(`/scheduler/tasks/${id}`),
  restartNow: (warningMinutes?: number) => apiPost('/scheduler/restart-now', { warningMinutes }),
  getCronPresets: () => apiGet('/scheduler/cron-presets'),
  validateCron: (cronExpression: string) => 
    apiPost('/scheduler/validate-cron', { cronExpression }) as Promise<{ valid: boolean; error?: string }>,
  getHistory: (limit?: number, taskId?: number) => {
    const params = new URLSearchParams()
    if (limit) params.set('limit', limit.toString())
    if (taskId) params.set('taskId', taskId.toString())
    const query = params.toString()
    return apiGet(`/scheduler/history${query ? `?${query}` : ''}`) as Promise<{ history: ScheduleHistoryEntry[] }>
  },
  clearHistory: () => apiDelete('/scheduler/history'),
}

// Mods API
export const modsApi = {
  getStatus: () => apiGet('/mods/status'),
  getTrackedMods: () => apiGet('/mods/tracked'),
  trackMod: (workshopId: string) => apiPost('/mods/track', { workshopId }),
  untrackMod: (workshopId: string) => apiDelete(`/mods/track/${workshopId}`),
  checkUpdates: () => apiPost('/mods/check-updates'),
  getServerMods: () => apiGet('/mods/server-mods'),
  syncFromServer: () => apiPost('/mods/sync-from-server'),
  clearUpdates: () => apiPost('/mods/clear-updates'),
  start: () => apiPost('/mods/start'),
  stop: () => apiPost('/mods/stop'),
  setAutoRestart: (enabled: boolean) => apiPost('/mods/auto-restart', { enabled }),
  setRestartOptions: (options: { warningMinutes?: number; delayIfPlayersOnline?: boolean; maxDelayMinutes?: number; checkInterval?: number }) =>
    apiPut('/mods/restart-options', options),
  cancelPendingRestart: () => apiPost('/mods/cancel-pending-restart'),
  getWorkshopStatus: () => apiGet('/mods/workshop-status'),
  
  // Import a Steam Workshop collection
  importCollection: (collectionUrl: string) => apiPost('/mods/import-collection', { collectionUrl }),
  
  // Get info for a single mod
  getModInfo: (workshopId: string) => apiPost('/mods/get-mod-info', { workshopId }),
  
  // Write mods configuration to server .ini file
  writeToIni: (mods: Array<{ workshopId: string; modId: string }>, mapFolders?: string[]) =>
    apiPost('/mods/write-to-ini', { mods, mapFolders }),
  
  // Get current mod configuration from .ini file
  getCurrentConfig: () => apiGet('/mods/current-config'),
  
  // Add a single mod to server .ini file (appends to existing)
  addToIni: (workshopId: string, modId?: string) => apiPost('/mods/add-to-ini', { workshopId, modId }),
  
  // Remove a single mod from server .ini file (removes from both WorkshopItems= and Mods=)
  removeFromIni: (workshopId: string, modId?: string) => apiPost('/mods/remove-from-ini', { workshopId, modId }),
  
  // Sync mod IDs from downloaded workshop mods - reads mod.info files and updates Mods= in ini
  syncModIds: () => apiPost('/mods/sync-mod-ids'),
  
  // Discover all mod IDs from a workshop item (for mods with multiple IDs)
  discoverModIds: (workshopId?: string, workshopUrl?: string) => 
    apiPost('/mods/discover-mod-ids', { workshopId, workshopUrl }) as Promise<{
      success: boolean
      workshopId: string
      name: string
      description: string | null
      modIds: string[]
      hasMultipleModIds: boolean
      sources: Array<{ modId: string; source: string }>
      isMap: boolean
      mapFolders: string[]
      isDownloaded: boolean
      tags: string[]
    }>,
  
  // Add mod with specific mod IDs selected (for multi-ID mods)
  addModAdvanced: (workshopId: string, selectedModIds?: string[], includeAllModIds?: boolean) =>
    apiPost('/mods/add-mod-advanced', { workshopId, selectedModIds, includeAllModIds }) as Promise<{
      success: boolean
      workshopId: string
      addedModIds: string[]
      totalModIdsInConfig: number
      workshopAlreadyExisted: boolean
      mapFoldersAdded: string[]
      message: string
    }>,
  
  // Mod Presets
  getPresets: () => apiGet('/mods/presets'),
  createPreset: (name: string, description?: string) => apiPost('/mods/presets', { name, description }),
  updatePreset: (id: number, data: { name?: string; description?: string; workshopIds?: string[]; modIds?: string[] }) =>
    apiPut(`/mods/presets/${id}`, data),
  deletePreset: (id: number) => apiDelete(`/mods/presets/${id}`),
  applyPreset: (id: number) => apiPost(`/mods/presets/${id}/apply`),
  
  // Mod Load Order
  saveModOrder: (modIds: string[]) => apiPost('/mods/save-order', { modIds }),
}

// Chunks API (Chunk Cleaner)
export const chunksApi = {
  getSaves: () => apiGet('/chunks/saves'),
  getChunks: (saveName: string) => apiGet(`/chunks/chunks/${encodeURIComponent(saveName)}`),
  getStats: (saveName: string) => apiGet(`/chunks/stats/${encodeURIComponent(saveName)}`),
  deleteChunks: (saveName: string, chunks: Array<{ file: string; x: number; y: number; source?: string }>, createBackup: boolean = true) =>
    apiPost('/chunks/delete-chunks', { saveName, chunks, createBackup }),
  deleteRegion: (saveName: string, minX: number, maxX: number, minY: number, maxY: number, createBackup: boolean = true, invert: boolean = false) =>
    apiPost('/chunks/delete-region', { saveName, minX, maxX, minY, maxY, createBackup, invert }),
}

// Config API
export const configApi = {
  getServerConfig: () => apiGet('/config'),
  updateServerConfig: (config: Record<string, string>) => apiPut('/config', { config }),
  reloadOptions: () => apiPost('/config/reload'),
  getAppSettings: () => apiGet('/config/app-settings'),
  updateAppSettings: (settings: Record<string, string>) => apiPut('/config/app-settings', { settings }),
  getPaths: () => apiGet('/config/paths'),
  updatePaths: (serverPath: string, savePath: string) => apiPut('/config/paths', { serverPath, savePath }),
  getRconConfig: () => apiGet('/config/rcon'),
  updateRconConfig: (host: string, port: number, password: string) => apiPut('/config/rcon', { host, port, password }),
  testRcon: () => apiPost('/config/test-rcon'),
}

// Discord API
export const discordApi = {
  getStatus: () => apiGet('/discord/status'),
  getConfig: () => apiGet('/discord/config'),
  updateConfig: (token: string, guildId: string, adminRoleId?: string, channelId?: string) =>
    apiPut('/discord/config', { token, guildId, adminRoleId, channelId }),
  start: () => apiPost('/discord/start'),
  stop: () => apiPost('/discord/stop'),
  testToken: (token: string) => apiPost('/discord/test', { token }),
  sendTestMessage: () => apiPost('/discord/test-message'),
  getWebhookEvents: () => apiGet('/discord/webhook-events'),
  updateWebhookEvents: (events: Record<string, { enabled: boolean; template: string }>) =>
    apiPut('/discord/webhook-events', { events }),
}

// Server Instance Type
export interface ServerInstance {
  id: number
  name: string
  serverName: string
  installPath: string
  zomboidDataPath: string | null
  serverConfigPath: string | null
  branch?: string
  rconHost: string
  rconPort: number
  rconPassword: string
  serverPort: number
  minMemory: number
  maxMemory: number
  useNoSteam: boolean
  useDebug: boolean
  isActive: boolean
  createdAt: string
}

// Servers API (multi-server management)
export const serversApi = {
  getAll: () => apiGet('/servers') as Promise<{ servers: ServerInstance[] }>,
  getActive: () => apiGet('/servers/active') as Promise<{ server: ServerInstance }>,
  get: (id: number) => apiGet(`/servers/${id}`) as Promise<{ server: ServerInstance }>,
  create: (config: Partial<ServerInstance>) =>
    apiPost('/servers', config) as Promise<{ server: ServerInstance; message: string }>,
  update: (id: number, updates: Partial<ServerInstance>) =>
    apiPut(`/servers/${id}`, updates) as Promise<{ server: ServerInstance; message: string }>,
  delete: (id: number) =>
    apiDelete(`/servers/${id}`) as Promise<{ success: boolean; message: string }>,
  activate: (id: number) =>
    apiPost(`/servers/${id}/activate`) as Promise<{ server: ServerInstance; message: string }>,
  steamUpdate: (steamcmdPath: string, installPath: string, branch: string = 'stable') =>
    apiPost('/server/steam-update', { steamcmdPath, installPath, branch, validateFiles: false }) as Promise<{ success: boolean; message: string }>,
  steamVerify: (steamcmdPath: string, installPath: string, branch: string = 'stable') =>
    apiPost('/server/steam-update', { steamcmdPath, installPath, branch, validateFiles: true }) as Promise<{ success: boolean; message: string }>,
}

// Server Files API (INI, Sandbox, Spawn Points)
export interface SpawnPoint {
  worldX: number
  worldY: number
  posX: number
  posY: number
  posZ?: number
}

// Spawn points are organized by profession (e.g., unemployed, policeofficer, etc.)
export type SpawnPointsByProfession = Record<string, SpawnPoint[]>

export interface SpawnRegion {
  name: string
  file: string
  isServerFile?: boolean
}

export interface SandboxData {
  VERSION: number
  settings: Record<string, string | number | boolean>
  ZombieLore: Record<string, string | number | boolean>
  ZombieConfig: Record<string, string | number | boolean>
}

export interface BackupFile {
  filename: string
  size: number
  created: string
}

export interface ConfigTemplate {
  id: string
  name: string
  description: string
  type: 'ini' | 'sandbox' | 'both'
  created: string
  modified: string
  hasIni: boolean
  hasSandbox: boolean
}

export interface ConfigTemplateDetail extends ConfigTemplate {
  ini?: Record<string, string>
  iniRaw?: string
  sandboxRaw?: string
  serverName?: string
}

export const serverFilesApi = {
  // Paths
  getPaths: () => apiGet('/server-files/paths') as Promise<{
    configPath: string
    serverName: string
    files: { ini: string; sandbox: string; spawnpoints: string; spawnregions: string }
    exists: { ini: boolean; sandbox: boolean; spawnpoints: boolean; spawnregions: boolean }
  }>,

  // INI
  getIni: () => apiGet('/server-files/ini') as Promise<{
    settings: Record<string, string>
    path: string
  }>,
  saveIni: (settings: Record<string, string>) => apiPut('/server-files/ini', { settings }),

  // Sandbox
  getSandbox: () => apiGet('/server-files/sandbox') as Promise<{
    sandbox: SandboxData
    path: string
  }>,
  saveSandbox: (sandbox: SandboxData) => apiPut('/server-files/sandbox', { sandbox }),

  // Spawn Points (keyed by profession)
  getSpawnPoints: () => apiGet('/server-files/spawnpoints') as Promise<{
    spawnpoints: SpawnPointsByProfession
    path: string
  }>,
  saveSpawnPoints: (spawnpoints: SpawnPointsByProfession) => apiPut('/server-files/spawnpoints', { spawnpoints }),

  // Spawn Regions
  getSpawnRegions: () => apiGet('/server-files/spawnregions') as Promise<{
    spawnregions: SpawnRegion[]
    path: string
  }>,
  saveSpawnRegions: (spawnregions: SpawnRegion[]) => apiPut('/server-files/spawnregions', { spawnregions }),

  // Raw file access
  getRaw: (type: 'ini' | 'sandbox' | 'spawnpoints' | 'spawnregions') =>
    apiGet(`/server-files/raw/${type}`) as Promise<{
      content: string
      path: string
      filename: string
    }>,
  saveRaw: (type: 'ini' | 'sandbox' | 'spawnpoints' | 'spawnregions', content: string) =>
    apiPut(`/server-files/raw/${type}`, { content }),

  // Backups
  getBackups: () => apiGet('/server-files/backups') as Promise<{
    backups: BackupFile[]
    path: string
  }>,
  restoreBackup: (filename: string) => apiPost(`/server-files/restore/${filename}`),

  // Reload options
  saveAndReload: () => apiPost('/server-files/save-and-reload'),

  // Config Templates
  getTemplates: () => apiGet('/server-files/templates') as Promise<{
    templates: ConfigTemplate[]
  }>,
  getTemplate: (id: string) => apiGet(`/server-files/templates/${id}`) as Promise<ConfigTemplateDetail>,
  saveAsTemplate: (data: { name: string; description?: string; includeIni?: boolean; includeSandbox?: boolean }) =>
    apiPost('/server-files/templates', data) as Promise<{ success: boolean; id: string; name: string; message: string }>,
  applyTemplate: (id: string, options?: { applyIni?: boolean; applySandbox?: boolean }) =>
    apiPost(`/server-files/templates/${id}/apply`, options || {}) as Promise<{ success: boolean; applied: string[]; message: string }>,
  updateTemplate: (id: string, data: { name?: string; description?: string }) =>
    apiPut(`/server-files/templates/${id}`, data),
  deleteTemplate: (id: string) => apiDelete(`/server-files/templates/${id}`),
}

// Panel Bridge API (for direct Lua mod communication)
export const panelBridgeApi = {
  // Get bridge status
  getStatus: () => apiGet('/panel-bridge/status') as Promise<{
    configured: boolean
    bridgePath: string | null
    isRunning: boolean
    pendingCommands: number
    modConnected: boolean
    consecutiveFailures?: number
    hasFileWatcher?: boolean
    config?: {
      statusStaleMs: number
      pollIntervalMs: number
      statusCheckMs: number
    }
    statusFile?: {
      exists: boolean
      path?: string
      size?: number
      modified?: string
      age?: number
      ageSeconds?: number
      error?: string
    }
    modStatus: {
      alive: boolean
      version: string
      serverName: string
      playerCount: number
      players: string[]
      path: string
      timestamp: number
      age?: number
      error?: string
    } | null
    detectedPaths: {
      serverName: string
      installPath: string
      zomboidDataPath: string
    } | null
  }>,

  // Auto-configure bridge from active server (uses db settings)
  autoConfigure: () => apiPost('/panel-bridge/auto-configure'),

  // Auto-detect bridge path from server name (manual entry)
  autoDetect: (serverName: string, zomboidUserFolder?: string) => 
    apiPost('/panel-bridge/auto-detect', { serverName, zomboidUserFolder }),

  // Configure the bridge with Zomboid save path
  configure: (zomboidSavePath: string) => apiPost('/panel-bridge/configure', { zomboidSavePath }),

  // Start the bridge
  start: () => apiPost('/panel-bridge/start'),

  // Stop the bridge
  stop: () => apiPost('/panel-bridge/stop'),

  // Refresh bridge state (restart with fresh state)
  refresh: () => apiPost('/panel-bridge/refresh'),

  // Scan for all panelbridge folders
  scanPaths: () => apiGet('/panel-bridge/scan-paths') as Promise<{
    foundBridges: Array<{
      path: string
      serverName: string
      baseDir: string
      hasStatus: boolean
      hasInit: boolean
      statusAge: number | null
      modVersion: string | null
      isActive: boolean
    }>
    scannedDirs: string[]
    currentPath: string | null
    isRunning: boolean
    modConnected: boolean
  }>,

  // Ping the mod
  ping: () => apiGet('/panel-bridge/ping'),

  // Send a command to the game
  sendCommand: (action: string, args?: Record<string, unknown>) =>
    apiPost('/panel-bridge/command', { action, args }),

  // Get weather info
  getWeather: () => apiGet('/panel-bridge/weather'),

  // Get server info from mod
  getServerInfo: () => apiGet('/panel-bridge/server-info'),

  // Weather controls
  triggerBlizzard: (duration?: number) => apiPost('/panel-bridge/weather/blizzard', { duration }),
  triggerTropicalStorm: (duration?: number) => apiPost('/panel-bridge/weather/tropical-storm', { duration }),
  triggerStorm: (duration?: number) => apiPost('/panel-bridge/weather/storm', { duration }),
  stopWeather: () => apiPost('/panel-bridge/weather/stop'),
  setSnow: (enabled: boolean) => apiPost('/panel-bridge/weather/snow', { enabled }),
  
  // Rain & Lightning (v1.1.0)
  startRain: (intensity?: number) => apiPost('/panel-bridge/weather/rain/start', { intensity }),
  stopRain: () => apiPost('/panel-bridge/weather/rain/stop'),
  triggerLightning: (x?: number, y?: number, strike?: boolean, light?: boolean, rumble?: boolean) =>
    apiPost('/panel-bridge/weather/lightning', { x, y, strike, light, rumble }),

  // Climate controls (v1.1.0)
  getClimateFloats: () => apiGet('/panel-bridge/climate/floats') as Promise<{
    success: boolean
    data: {
      floats: Array<{
        id: number
        name: string
        actualName: string
        value: number
        min: number
        max: number
        isAdminEnabled: boolean
      }>
    }
  }>,
  setClimateFloat: (floatId: number, value: number, enable?: boolean) =>
    apiPost('/panel-bridge/climate/float', { floatId, value, enable }),
  resetClimateOverrides: () => apiPost('/panel-bridge/climate/reset'),

  // Game time controls (v1.1.0)
  getGameTime: () => apiGet('/panel-bridge/time') as Promise<{
    success: boolean
    data: {
      year: number
      month: number
      day: number
      hour: number
      minute: number
      dayOfWeek: number
      worldAgeHours: number
      moonPhase: number
      nightsSurvived: number
    }
  }>,
  setGameTime: (options: { hour?: number; day?: number; month?: number; year?: number }) =>
    apiPost('/panel-bridge/time', options),

  // World controls (v1.1.0)
  getWorldStats: () => apiGet('/panel-bridge/world/stats'),
  saveWorld: () => apiPost('/panel-bridge/world/save'),

  // Player controls (v1.1.0)
  getAllPlayerDetails: () => apiGet('/panel-bridge/players') as Promise<{
    success: boolean
    data: {
      players: Array<{
        username: string
        displayName: string
        x: number
        y: number
        z: number
        accessLevel: string
        isAlive: boolean
        hunger?: number
        thirst?: number
        fatigue?: number
        health?: number
        isInfected?: boolean
      }>
    }
  }>,
  getPlayerDetails: (username: string) => apiGet(`/panel-bridge/players/${encodeURIComponent(username)}`),
  teleportPlayerBridge: (username: string, x: number, y: number, z?: number) =>
    apiPost(`/panel-bridge/players/${encodeURIComponent(username)}/teleport`, { x, y, z }),

  // Server message (v1.1.0)
  sendServerMessage: (message: string, color?: string) =>
    apiPost('/panel-bridge/message', { message, color }),

  // Chat system (v1.4.0) - uses ChatServer API
  sendToServerChat: (message: string, alert?: boolean) =>
    apiPost('/panel-bridge/chat/alert', { message, alert: alert ?? false }),
  
  sendToAdminChat: (message: string) =>
    apiPost('/panel-bridge/chat/admin', { message }),
  
  sendToGeneralChat: (message: string, author?: string) =>
    apiPost('/panel-bridge/chat/general', { message, author: author ?? 'Server' }),

  // Sandbox options (v1.1.0)
  getSandboxOptions: () => apiGet('/panel-bridge/sandbox'),

  // Get available commands
  getCommands: () => apiGet('/panel-bridge/commands') as Promise<{
    commands: Array<{
      action: string
      description: string
      args: Record<string, string>
    }>
  }>,

  // Get mod installation info (includes suggested install path)
  getModPath: () => apiGet('/panel-bridge/mod-path') as Promise<{
    modPath: string
    exists: boolean
    files: string[]
    suggestedInstallPath: string | null
  }>,

  // Auto-install mod to active server's Lua folder
  installModAuto: () => apiPost('/panel-bridge/install-mod-auto'),

  // Install mod to server (manual path - Lua folder)
  installMod: (serverLuaPath: string) => apiPost('/panel-bridge/install-mod', { serverLuaPath }),

  // =============================================
  // V1.2.0 SOUND/NOISE CONTROLS
  // =============================================

  // Play sound at world coordinates (attracts zombies)
  playWorldSound: (x: number, y: number, z?: number, radius?: number, volume?: number) =>
    apiPost('/panel-bridge/sound/world', { x, y, z: z ?? 0, radius: radius ?? 50, volume: volume ?? 100 }),

  // Play sound near a player's location
  playSoundNearPlayer: (username: string, radius?: number, volume?: number) =>
    apiPost('/panel-bridge/sound/near-player', { username, radius: radius ?? 50, volume: volume ?? 100 }),

  // Trigger a gunshot sound (high radius)
  triggerGunshotBridge: (options: { x?: number; y?: number; z?: number; username?: string }) =>
    apiPost('/panel-bridge/sound/gunshot', options),

  // Trigger an alarm sound
  triggerAlarmBridge: (options: { x?: number; y?: number; z?: number; username?: string }) =>
    apiPost('/panel-bridge/sound/alarm', options),

  // Create custom noise
  createNoise: (options: { x?: number; y?: number; z?: number; radius?: number; volume?: number; username?: string }) =>
    apiPost('/panel-bridge/sound/noise', options),

  // =============================================
  // V1.4.0 INFRASTRUCTURE (POWER/WATER) CONTROLS
  // =============================================

  // Get utilities (power/water) status
  getUtilitiesStatus: () => apiGet('/panel-bridge/utilities/status') as Promise<{
    success: boolean
    data: {
      hydroPowerOn: boolean
      powerOn: boolean
      waterOn: boolean
      elecShut: string
      waterShut: string
      elecShutModifier: number
      waterShutModifier: number
    }
  }>,

  // Restore utilities (turn power/water back on)
  restoreUtilities: (power?: boolean, water?: boolean) =>
    apiPost('/panel-bridge/utilities/restore', { power: power !== false, water: water !== false }),

  // Shut off utilities
  shutOffUtilities: (power?: boolean, water?: boolean) =>
    apiPost('/panel-bridge/utilities/shutoff', { power: power !== false, water: water !== false }),

  // =============================================
  // V1.5.0 CHARACTER EXPORT/IMPORT
  // =============================================

  // Export character data (XP, perks, skills, traits)
  exportCharacter: (username: string): Promise<CharacterExportResponse> =>
    apiPost('/panel-bridge/character/export', { username }),

  // Import character data (apply XP, perks to player)
  importCharacter: (username: string, data: CharacterImportData): Promise<CharacterImportResponse> =>
    apiPost('/panel-bridge/character/import', { username, data }),
}

// =============================================
// BACKUP API
// =============================================
export interface BackupSettings {
  enabled: boolean
  schedule: string
  maxBackups: number
  includeDb: boolean
}

export interface BackupStatus extends BackupSettings {
  backupInProgress: boolean
  restoreInProgress: boolean
  lastBackup: {
    name: string
    path: string
    size: number
    created: string
  } | null
  backupCount: number
  savesPath: string | null
  backupsPath: string | null
  savesExists: boolean
}

export interface BackupFile {
  name: string
  path: string
  size: number
  created: string
}

export interface BackupContentsInfo {
  description: string
  includes: string[]
  location: string
  note: string
}

export const backupApi = {
  // Get backup status and settings
  getStatus: (): Promise<BackupStatus> => apiGet('/backup/status'),

  // Get info about what backups contain
  getInfo: (): Promise<BackupContentsInfo> => apiGet('/backup/info'),

  // Get list of backups
  listBackups: (): Promise<{ backups: BackupFile[] }> => apiGet('/backup/list'),

  // Update backup settings
  updateSettings: (settings: Partial<BackupSettings>): Promise<{ success: boolean; settings: BackupSettings }> =>
    apiPost('/backup/settings', settings),

  // Create a manual backup
  createBackup: (options?: { includeDb?: boolean }): Promise<{
    success: boolean
    backup?: BackupFile
    duration?: number
    message?: string
  }> => apiPost('/backup/create', options || {}),

  // Delete a backup
  deleteBackup: (name: string): Promise<{ success: boolean; message?: string }> =>
    fetchWithRetry(`${API_BASE}/backup/${encodeURIComponent(name)}`, { method: 'DELETE' }).then(handleResponse),

  // Restore a backup
  restoreBackup: (name: string, options?: { createPreRestoreBackup?: boolean }): Promise<{
    success: boolean
    message?: string
    duration?: number
  }> => apiPost(`/backup/restore/${encodeURIComponent(name)}`, options || {}),

  // Delete backups older than X days
  deleteOlderThan: (days: number): Promise<{
    success: boolean
    deleted?: number
    failed?: number
    deletedNames?: string[]
    message?: string
  }> => apiPost('/backup/delete-older-than', { days }),

  // Get download URL for a backup
  getDownloadUrl: (name: string): string => `${API_BASE}/backup/download/${encodeURIComponent(name)}`,
}

// Update Checker API
export interface UpdateStatus {
  updateAvailable: boolean
  installed: {
    buildId: string
    branch: string
    lastUpdated: string | null
  }
  latest: {
    buildId: string
    branch: string
    timeUpdated: string | null
    description: string | null
  }
  lastCheck: string
}

export interface UpdateCheckerStatus {
  updateAvailable: UpdateStatus | null
  lastCheck: string | null
  intervalMinutes: number
  isChecking: boolean
}

export const updateApi = {
  // Check for updates (force = true to refresh from Steam)
  check: (force: boolean = false): Promise<UpdateStatus | UpdateCheckerStatus> =>
    apiGet(`/server/update-check?force=${force}`),
  
  // Get current status without checking
  getStatus: (): Promise<UpdateCheckerStatus> =>
    apiGet('/server/update-check/status'),
  
  // Set check interval in minutes
  setInterval: (minutes: number): Promise<{ success: boolean; intervalMinutes: number }> =>
    apiPost('/server/update-check/interval', { minutes }),
}
