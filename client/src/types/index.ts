// Server Status Types
export interface ServerStatus {
  running: boolean
  players: number
  maxPlayers: number
  uptime: string
  memory: string
  cpu: string
  version: string
  serverName: string
}

// Player Types
export interface Player {
  username: string
  steamId?: string
  ping?: number
  accessLevel?: string
  online?: boolean
  lastSeen?: string
  x?: number
  y?: number
  z?: number
}

export interface PlayerAction {
  type: 'kick' | 'ban' | 'unban' | 'setAccess' | 'teleport' | 'heal' | 'godmode'
  username: string
  reason?: string
  accessLevel?: string
  coords?: { x: number; y: number; z: number }
}

// RCON Types
export interface RconCommand {
  command: string
  response?: string
  timestamp?: string
  success?: boolean
}

export interface CommandHistory {
  id: number
  command: string
  response: string
  executed_at: string
  success: number
}

// Scheduler Types
export interface ScheduledTask {
  id: number
  name: string
  cron_expression: string
  command: string
  enabled: number
  last_run: string | null
  created_at: string
}

export interface CronPreset {
  name: string
  cron: string
}

// Mod Types
export interface TrackedMod {
  id: number
  workshop_id: string
  name: string
  last_updated: string
  last_checked: string | null
  update_available: number
  created_at: string
}

export interface ModStatus {
  totalMods: number
  updatesAvailable: number
  lastCheck: string | null
  autoRestartEnabled: boolean
}

// Settings Types
export interface AppSettings {
  rconHost: string
  rconPort: string
  rconPassword: string
  serverPath: string
  serverConfigPath: string
  zomboidDataPath: string
  modCheckInterval: string
  modAutoRestart: boolean
  modRestartDelay: string
  darkMode: boolean
  autoReconnect: boolean
  reconnectInterval: string
}

// API Response Types
export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

// Event Types
export interface ServerEvent {
  type: 'player_join' | 'player_leave' | 'restart' | 'save' | 'error' | 'warning' | 'info'
  message: string
  timestamp: string
  data?: Record<string, unknown>
}

// Vehicle Types
export interface VehicleInfo {
  id: string
  name: string
  category: string
}

// Weather Types
export type WeatherType = 'sunny' | 'rain' | 'storm' | 'fog' | 'cloudy'

// Access Levels
export type AccessLevel = 'none' | 'observer' | 'gm' | 'overseer' | 'moderator' | 'admin'

export const ACCESS_LEVELS: AccessLevel[] = ['none', 'observer', 'gm', 'overseer', 'moderator', 'admin']

// PZ Command Categories
export interface CommandCategory {
  name: string
  commands: string[]
}

export const COMMAND_CATEGORIES: CommandCategory[] = [
  {
    name: 'Server',
    commands: ['save', 'quit', 'servermsg', 'setaccesslevel', 'reloadoptions']
  },
  {
    name: 'Players',
    commands: ['players', 'kick', 'banuser', 'banid', 'unbanuser', 'unbanid', 'adduser']
  },
  {
    name: 'Admin',
    commands: ['grantadmin', 'removeadmin', 'setaccesslevel', 'invisible', 'godmod', 'noclip']
  },
  {
    name: 'Items',
    commands: ['additem', 'addxp', 'addvehicle', 'createhorde', 'gunshot']
  },
  {
    name: 'Weather',
    commands: ['changeoption', 'startrain', 'stoprain', 'startstorm']
  },
  {
    name: 'World',
    commands: ['chopper', 'helicopter', 'lightning', 'thunder']
  }
]
