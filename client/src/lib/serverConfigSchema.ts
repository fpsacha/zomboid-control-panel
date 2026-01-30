// Server INI settings schema with descriptions from PZ Wiki
// https://pzwiki.net/wiki/Server_settings

export interface IniSetting {
  key: string
  label: string
  description: string
  type: 'boolean' | 'number' | 'string' | 'select' | 'multiline'
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  default?: string | number | boolean
  category: string
}

export const INI_CATEGORIES = [
  { id: 'general', label: 'General', icon: 'Settings' },
  { id: 'network', label: 'Network & Ports', icon: 'Globe' },
  { id: 'pvp', label: 'PvP & Safety', icon: 'Swords' },
  { id: 'chat', label: 'Chat & Communication', icon: 'MessageSquare' },
  { id: 'players', label: 'Players & Accounts', icon: 'Users' },
  { id: 'safehouse', label: 'Safehouses', icon: 'Home' },
  { id: 'loot', label: 'Loot & Items', icon: 'Package' },
  { id: 'mods', label: 'Mods & Workshop', icon: 'Puzzle' },
  { id: 'steam', label: 'Steam Integration', icon: 'Cloud' },
  { id: 'voice', label: 'Voice Chat', icon: 'Mic' },
  { id: 'discord', label: 'Discord', icon: 'MessageCircle' },
  { id: 'rcon', label: 'RCON', icon: 'Terminal' },
  { id: 'advanced', label: 'Advanced', icon: 'Wrench' },
]

export const INI_SCHEMA: IniSetting[] = [
  // General
  {
    key: 'PublicName',
    label: 'Server Name',
    description: 'Your server name as shown to the public.',
    type: 'string',
    default: '',
    category: 'general'
  },
  {
    key: 'PublicDescription',
    label: 'Server Description',
    description: 'The description that people can see while browsing your server.',
    type: 'multiline',
    default: '',
    category: 'general'
  },
  {
    key: 'Public',
    label: 'Public Server',
    description: 'Can your server be seen on Steam server browser.',
    type: 'boolean',
    default: true,
    category: 'general'
  },
  {
    key: 'Open',
    label: 'Open (No Whitelist)',
    description: 'Open to all players without requiring whitelist.',
    type: 'boolean',
    default: true,
    category: 'general'
  },
  {
    key: 'Password',
    label: 'Server Password',
    description: 'Password required to join the server. Leave empty for no password.',
    type: 'string',
    default: '',
    category: 'general'
  },
  {
    key: 'MaxPlayers',
    label: 'Max Players',
    description: 'Maximum allowed number of players.',
    type: 'number',
    min: 1,
    max: 100,
    default: 16,
    category: 'general'
  },
  {
    key: 'PauseEmpty',
    label: 'Pause When Empty',
    description: 'The server will pause when no players are logged in.',
    type: 'boolean',
    default: true,
    category: 'general'
  },
  {
    key: 'ServerWelcomeMessage',
    label: 'Welcome Message',
    description: 'The welcome message displayed to players after connecting. Use <LINE> for new lines.',
    type: 'multiline',
    default: 'Welcome to Project Zomboid Multiplayer!',
    category: 'general'
  },
  {
    key: 'Map',
    label: 'Map',
    description: 'The map you\'re playing on. Default is Muldraugh, KY.',
    type: 'string',
    default: 'Muldraugh, KY',
    category: 'general'
  },
  {
    key: 'SaveWorldEveryMinutes',
    label: 'Auto-Save Interval',
    description: 'Auto-save world every X minutes. 0 = never.',
    type: 'number',
    min: 0,
    max: 60,
    default: 0,
    category: 'general'
  },
  {
    key: 'AnnounceDeath',
    label: 'Announce Deaths',
    description: 'Server-wide announcement when a character dies.',
    type: 'boolean',
    default: false,
    category: 'general'
  },

  // Network & Ports
  {
    key: 'DefaultPort',
    label: 'Game Port',
    description: 'The port players will use to connect to your server. Must be open on your router.',
    type: 'number',
    min: 1024,
    max: 65535,
    default: 16261,
    category: 'network'
  },
  {
    key: 'UPnP',
    label: 'Enable UPnP',
    description: 'Enable UPnP for automatic port forwarding.',
    type: 'boolean',
    default: true,
    category: 'network'
  },
  {
    key: 'PingFrequency',
    label: 'Ping Frequency',
    description: 'How often the server checks connection to players (seconds).',
    type: 'number',
    min: 1,
    max: 60,
    default: 10,
    category: 'network'
  },
  {
    key: 'PingLimit',
    label: 'Ping Limit',
    description: 'Ping limit before being kicked (milliseconds). 100 to disable.',
    type: 'number',
    min: 100,
    max: 1000,
    default: 250,
    category: 'network'
  },
  {
    key: 'DenyLoginOnOverloadedServer',
    label: 'Deny Login When Overloaded',
    description: 'Prevent new connections when server is overloaded.',
    type: 'boolean',
    default: true,
    category: 'network'
  },
  {
    key: 'SpeedLimit',
    label: 'Speed Limit',
    description: 'Maximum movement speed allowed.',
    type: 'number',
    min: 10,
    max: 200,
    default: 70,
    category: 'network'
  },
  {
    key: 'UseTCPForMapDownloads',
    label: 'Use TCP for Map Downloads',
    description: 'Use TCP instead of UDP for map downloads.',
    type: 'boolean',
    default: false,
    category: 'network'
  },

  // PvP & Safety
  {
    key: 'PVP',
    label: 'Enable PvP',
    description: 'Allow player vs player combat (each player can still toggle their own PvP).',
    type: 'boolean',
    default: true,
    category: 'pvp'
  },
  {
    key: 'SafetySystem',
    label: 'Safety System',
    description: 'If PvP is enabled, allows players to toggle their own PvP on/off.',
    type: 'boolean',
    default: true,
    category: 'pvp'
  },
  {
    key: 'ShowSafety',
    label: 'Show Safety Status',
    description: 'Show skull icon for players with safety off.',
    type: 'boolean',
    default: true,
    category: 'pvp'
  },
  {
    key: 'SafetyToggleTimer',
    label: 'Safety Toggle Timer',
    description: 'Time in seconds to switch between PvP on and off.',
    type: 'number',
    min: 0,
    max: 60,
    default: 2,
    category: 'pvp'
  },
  {
    key: 'SafetyCooldownTimer',
    label: 'Safety Cooldown Timer',
    description: 'Time in seconds before you can toggle safety again.',
    type: 'number',
    min: 0,
    max: 60,
    default: 3,
    category: 'pvp'
  },
  {
    key: 'PVPMeleeWhileHitReaction',
    label: 'Melee While Hit Reaction',
    description: 'Allow melee attacks during hit reaction in PvP.',
    type: 'boolean',
    default: false,
    category: 'pvp'
  },
  {
    key: 'PVPMeleeDamageModifier',
    label: 'PvP Melee Damage %',
    description: 'Melee damage modifier for PvP (percentage).',
    type: 'number',
    min: 0,
    max: 500,
    default: 30,
    category: 'pvp'
  },
  {
    key: 'PVPFirearmDamageModifier',
    label: 'PvP Firearm Damage %',
    description: 'Firearm damage modifier for PvP (percentage).',
    type: 'number',
    min: 0,
    max: 500,
    default: 50,
    category: 'pvp'
  },
  {
    key: 'PlayerBumpPlayer',
    label: 'Player Collision',
    description: 'Players can bump into each other.',
    type: 'boolean',
    default: false,
    category: 'pvp'
  },

  // Chat & Communication
  {
    key: 'GlobalChat',
    label: 'Enable Global Chat',
    description: 'Enable /all command for server-wide chat.',
    type: 'boolean',
    default: true,
    category: 'chat'
  },
  {
    key: 'ChatStreams',
    label: 'Chat Streams',
    description: 'Enabled chat streams: s=say, r=radio, a=admin, w=whisper, y=yell, sh=safehouse, f=faction, all=global.',
    type: 'string',
    default: 's,r,a,w,y,sh,f,all',
    category: 'chat'
  },
  {
    key: 'DisplayUserName',
    label: 'Display Usernames',
    description: 'Show player usernames above their heads and in chat.',
    type: 'boolean',
    default: true,
    category: 'chat'
  },
  {
    key: 'ShowFirstAndLastName',
    label: 'Show Character Names',
    description: 'Display character first and last name instead of username.',
    type: 'boolean',
    default: false,
    category: 'chat'
  },
  {
    key: 'MouseOverToSeeDisplayName',
    label: 'Mouse Over for Name',
    description: 'Require mouse hover to see player names.',
    type: 'boolean',
    default: true,
    category: 'chat'
  },
  {
    key: 'HidePlayersBehindYou',
    label: 'Hide Players Behind You',
    description: 'Hide player names for players behind your character.',
    type: 'boolean',
    default: true,
    category: 'chat'
  },
  {
    key: 'AllowNonAsciiUsername',
    label: 'Allow Non-ASCII Usernames',
    description: 'Allow usernames with non-ASCII characters.',
    type: 'boolean',
    default: false,
    category: 'chat'
  },
  {
    key: 'BanKickGlobalSound',
    label: 'Ban/Kick Sound',
    description: 'Play global sound when a player is banned or kicked.',
    type: 'boolean',
    default: true,
    category: 'chat'
  },

  // Players & Accounts
  {
    key: 'AutoCreateUserInWhiteList',
    label: 'Auto-Create Users',
    description: 'Automatically add new users to whitelist when they join.',
    type: 'boolean',
    default: false,
    category: 'players'
  },
  {
    key: 'MaxAccountsPerUser',
    label: 'Max Accounts Per User',
    description: 'Limit accounts per Steam user. 0 = unlimited.',
    type: 'number',
    min: 0,
    max: 10,
    default: 0,
    category: 'players'
  },
  {
    key: 'DropOffWhiteListAfterDeath',
    label: 'Remove From Whitelist On Death',
    description: 'Remove player from whitelist if their character dies.',
    type: 'boolean',
    default: false,
    category: 'players'
  },
  {
    key: 'KickFastPlayers',
    label: 'Kick Speed Hackers',
    description: 'Kick players moving faster than possible. May be buggy.',
    type: 'boolean',
    default: false,
    category: 'players'
  },
  {
    key: 'SpawnPoint',
    label: 'Spawn Point',
    description: 'Custom spawn point coordinates (X,Y,Z). 0,0,0 for default.',
    type: 'string',
    default: '0,0,0',
    category: 'players'
  },
  {
    key: 'SpawnItems',
    label: 'Spawn Items',
    description: 'Items new characters spawn with (comma-separated, e.g., Base.BaseballBat,Base.WaterBottleFull).',
    type: 'string',
    default: '',
    category: 'players'
  },
  {
    key: 'SleepAllowed',
    label: 'Allow Sleep',
    description: 'Whether sleeping is allowed.',
    type: 'boolean',
    default: false,
    category: 'players'
  },
  {
    key: 'SleepNeeded',
    label: 'Sleep Required',
    description: 'Whether players need to sleep when exhausted.',
    type: 'boolean',
    default: false,
    category: 'players'
  },
  {
    key: 'PlayerRespawnWithSelf',
    label: 'Respawn at Death Location',
    description: 'Allow respawning at death location.',
    type: 'boolean',
    default: false,
    category: 'players'
  },
  {
    key: 'PlayerRespawnWithOther',
    label: 'Respawn with Partner',
    description: 'Enable spawning at splitscreen partner location.',
    type: 'boolean',
    default: false,
    category: 'players'
  },
  {
    key: 'PlayerSaveOnDamage',
    label: 'Save on Damage',
    description: 'Save player state when they take damage.',
    type: 'boolean',
    default: true,
    category: 'players'
  },
  {
    key: 'MinutesPerPage',
    label: 'Minutes Per Page',
    description: 'In-game minutes needed to read a single page.',
    type: 'number',
    min: 0.1,
    max: 10,
    default: 1.0,
    category: 'players'
  },

  // Safehouses
  {
    key: 'PlayerSafehouse',
    label: 'Enable Safehouses',
    description: 'Allow players to claim safehouses.',
    type: 'boolean',
    default: true,
    category: 'safehouse'
  },
  {
    key: 'AdminSafehouse',
    label: 'Admin Safehouses',
    description: 'Allow admins to have safehouses.',
    type: 'boolean',
    default: false,
    category: 'safehouse'
  },
  {
    key: 'SafehouseAllowTrepass',
    label: 'Allow Trespass',
    description: 'Allow non-members to enter safehouses without invite.',
    type: 'boolean',
    default: true,
    category: 'safehouse'
  },
  {
    key: 'SafehouseAllowFire',
    label: 'Allow Fire Damage',
    description: 'Allow fire to damage safehouses.',
    type: 'boolean',
    default: true,
    category: 'safehouse'
  },
  {
    key: 'SafehouseAllowLoot',
    label: 'Allow Looting',
    description: 'Allow non-members to take items from safehouses.',
    type: 'boolean',
    default: true,
    category: 'safehouse'
  },
  {
    key: 'SafehouseAllowRespawn',
    label: 'Allow Safehouse Respawn',
    description: 'Players can respawn in their safehouse.',
    type: 'boolean',
    default: false,
    category: 'safehouse'
  },
  {
    key: 'SafehouseDaySurvivedToClaim',
    label: 'Days to Claim Safehouse',
    description: 'Days a player must survive before claiming a safehouse.',
    type: 'number',
    min: 0,
    max: 365,
    default: 0,
    category: 'safehouse'
  },
  {
    key: 'SafeHouseRemovalTime',
    label: 'Safehouse Removal Time',
    description: 'Real-time hours of inactivity before removal from safehouse.',
    type: 'number',
    min: 0,
    max: 720,
    default: 144,
    category: 'safehouse'
  },
  {
    key: 'DisableSafehouseWhenPlayerConnected',
    label: 'Disable When Owner Online',
    description: 'Disable safehouse protection when owner is connected.',
    type: 'boolean',
    default: false,
    category: 'safehouse'
  },

  // Loot & Items
  {
    key: 'HoursForLootRespawn',
    label: 'Loot Respawn Hours',
    description: 'In-game hours before loot can respawn. 0 = never.',
    type: 'number',
    min: 0,
    max: 8760,
    default: 0,
    category: 'loot'
  },
  {
    key: 'MaxItemsForLootRespawn',
    label: 'Max Items for Respawn',
    description: 'Max items in container before respawn is blocked.',
    type: 'number',
    min: 0,
    max: 100,
    default: 4,
    category: 'loot'
  },
  {
    key: 'ConstructionPreventsLootRespawn',
    label: 'Construction Blocks Respawn',
    description: 'Player constructions near containers prevent loot respawn.',
    type: 'boolean',
    default: true,
    category: 'loot'
  },
  {
    key: 'HoursForWorldItemRemoval',
    label: 'World Item Removal Hours',
    description: 'Hours before corpses/items on ground disappear. 0 = never.',
    type: 'number',
    min: 0,
    max: 8760,
    default: 0,
    category: 'loot'
  },
  {
    key: 'ItemNumbersLimitPerContainer',
    label: 'Container Item Limit',
    description: 'Max items per container. 0 = unlimited.',
    type: 'number',
    min: 0,
    max: 1000,
    default: 0,
    category: 'loot'
  },
  {
    key: 'TrashDeleteAll',
    label: 'Delete All Trash',
    description: 'Delete all items when placed in trash.',
    type: 'boolean',
    default: false,
    category: 'loot'
  },
  {
    key: 'BloodSplatLifespanDays',
    label: 'Blood Splat Lifespan',
    description: 'Days before blood splats disappear. 0 = never.',
    type: 'number',
    min: 0,
    max: 365,
    default: 0,
    category: 'loot'
  },
  {
    key: 'RemovePlayerCorpsesOnCorpseRemoval',
    label: 'Remove Player Corpses',
    description: 'Remove player corpses when corpse removal runs.',
    type: 'boolean',
    default: false,
    category: 'loot'
  },
  {
    key: 'AllowDestructionBySledgehammer',
    label: 'Sledgehammer Destruction',
    description: 'Allow players to destroy world objects with sledgehammer.',
    type: 'boolean',
    default: true,
    category: 'loot'
  },
  {
    key: 'NoFire',
    label: 'Disable Fire',
    description: 'Disable all fires except campfires.',
    type: 'boolean',
    default: false,
    category: 'loot'
  },

  // Factions & Trading
  {
    key: 'Faction',
    label: 'Enable Factions',
    description: 'Allow creation and use of factions.',
    type: 'boolean',
    default: true,
    category: 'players'
  },
  {
    key: 'FactionDaySurvivedToCreate',
    label: 'Days to Create Faction',
    description: 'Days a player must survive to create a faction.',
    type: 'number',
    min: 0,
    max: 365,
    default: 0,
    category: 'players'
  },
  {
    key: 'FactionPlayersRequiredForTag',
    label: 'Players for Faction Tag',
    description: 'Players required in faction to show tag.',
    type: 'number',
    min: 1,
    max: 50,
    default: 1,
    category: 'players'
  },
  {
    key: 'AllowTradeUI',
    label: 'Allow Trading',
    description: 'Allow players to directly trade with one another.',
    type: 'boolean',
    default: true,
    category: 'players'
  },

  // Mods & Workshop
  {
    key: 'Mods',
    label: 'Mods',
    description: 'List of installed mod IDs (semicolon-separated).',
    type: 'multiline',
    default: '',
    category: 'mods'
  },
  {
    key: 'WorkshopItems',
    label: 'Workshop Items',
    description: 'Steam Workshop item IDs to download (semicolon-separated).',
    type: 'multiline',
    default: '',
    category: 'mods'
  },
  {
    key: 'DoLuaChecksum',
    label: 'Lua Checksum',
    description: 'Verify client Lua matches server. Disable if getting kicked with mods.',
    type: 'boolean',
    default: true,
    category: 'mods'
  },

  // Steam Integration
  {
    key: 'SteamPort1',
    label: 'Steam Port 1',
    description: 'First Steam port.',
    type: 'number',
    min: 1024,
    max: 65535,
    default: 8766,
    category: 'steam'
  },
  {
    key: 'SteamPort2',
    label: 'Steam Port 2',
    description: 'Second Steam port.',
    type: 'number',
    min: 1024,
    max: 65535,
    default: 8767,
    category: 'steam'
  },
  {
    key: 'SteamScoreboard',
    label: 'Steam Scoreboard',
    description: 'Show Steam usernames and avatars. true/false/admin.',
    type: 'select',
    options: [
      { value: 'true', label: 'Everyone' },
      { value: 'false', label: 'No One' },
      { value: 'admin', label: 'Admins Only' }
    ],
    default: 'true',
    category: 'steam'
  },
  {
    key: 'SteamVAC',
    label: 'VAC Ban Check',
    description: 'Check if connecting players have VAC bans.',
    type: 'boolean',
    default: true,
    category: 'steam'
  },

  // Voice Chat
  {
    key: 'VoiceEnable',
    label: 'Enable Voice Chat',
    description: 'Enable in-game voice chat.',
    type: 'boolean',
    default: true,
    category: 'voice'
  },
  {
    key: 'Voice3D',
    label: '3D Voice',
    description: 'Enable 3D positional voice chat.',
    type: 'boolean',
    default: true,
    category: 'voice'
  },
  {
    key: 'VoiceMinDistance',
    label: 'Voice Min Distance',
    description: 'Minimum voice distance.',
    type: 'number',
    min: 1,
    max: 100,
    default: 10,
    category: 'voice'
  },
  {
    key: 'VoiceMaxDistance',
    label: 'Voice Max Distance',
    description: 'Maximum voice distance.',
    type: 'number',
    min: 10,
    max: 1000,
    default: 300,
    category: 'voice'
  },

  // Discord
  {
    key: 'DiscordEnable',
    label: 'Enable Discord',
    description: 'Enable built-in Discord integration.',
    type: 'boolean',
    default: false,
    category: 'discord'
  },
  {
    key: 'DiscordToken',
    label: 'Discord Token',
    description: 'Discord bot token.',
    type: 'string',
    default: '',
    category: 'discord'
  },
  {
    key: 'DiscordChannel',
    label: 'Discord Channel',
    description: 'Discord channel name.',
    type: 'string',
    default: '',
    category: 'discord'
  },
  {
    key: 'DiscordChannelID',
    label: 'Discord Channel ID',
    description: 'Discord channel ID.',
    type: 'string',
    default: '',
    category: 'discord'
  },

  // RCON
  {
    key: 'RCONPort',
    label: 'RCON Port',
    description: 'Port for RCON connections.',
    type: 'number',
    min: 1024,
    max: 65535,
    default: 27015,
    category: 'rcon'
  },
  {
    key: 'RCONPassword',
    label: 'RCON Password',
    description: 'Password for RCON connections.',
    type: 'string',
    default: '',
    category: 'rcon'
  },

  // Advanced
  {
    key: 'ResetID',
    label: 'Reset ID',
    description: 'Removing this resets zombies and loot (not time).',
    type: 'string',
    default: '',
    category: 'advanced'
  },
  {
    key: 'ServerPlayerID',
    label: 'Server Player ID',
    description: 'Identifies if character is from another server.',
    type: 'string',
    default: '',
    category: 'advanced'
  },
  {
    key: 'PhysicsDelay',
    label: 'Physics Delay',
    description: 'Physics update delay in milliseconds.',
    type: 'number',
    min: 100,
    max: 2000,
    default: 500,
    category: 'advanced'
  },
  {
    key: 'FastForwardMultiplier',
    label: 'Fast Forward Multiplier',
    description: 'Speed multiplier when fast-forwarding.',
    type: 'number',
    min: 1,
    max: 100,
    default: 40,
    category: 'advanced'
  },
  {
    key: 'CarEngineAttractionModifier',
    label: 'Car Engine Attraction',
    description: 'Modifier for zombie attraction to car engines.',
    type: 'number',
    min: 0,
    max: 10,
    default: 0.5,
    category: 'advanced'
  },
  {
    key: 'ZombieUpdateMaxHighPriority',
    label: 'Zombie High Priority Updates',
    description: 'Max high priority zombie updates per tick.',
    type: 'number',
    min: 10,
    max: 200,
    default: 50,
    category: 'advanced'
  },
  {
    key: 'ZombieUpdateDelta',
    label: 'Zombie Update Delta',
    description: 'Zombie update time delta.',
    type: 'number',
    min: 0.1,
    max: 2,
    default: 0.5,
    category: 'advanced'
  },
]

// Sandbox settings schema
export interface SandboxSetting {
  key: string
  label: string
  description: string
  type: 'boolean' | 'number' | 'select'
  options?: { value: number; label: string }[]
  min?: number
  max?: number
  default?: number | boolean
  category: string
  section?: 'settings' | 'ZombieLore' | 'ZombieConfig'
}

export const SANDBOX_CATEGORIES = [
  { id: 'time', label: 'Time & Season', icon: 'Clock' },
  { id: 'population', label: 'Population', icon: 'Users' },
  { id: 'loot', label: 'Loot & Resources', icon: 'Package' },
  { id: 'environment', label: 'Environment', icon: 'Cloud' },
  { id: 'survival', label: 'Survival', icon: 'Heart' },
  { id: 'zombieLore', label: 'Zombie Behavior', icon: 'Skull' },
  { id: 'zombiePopulation', label: 'Zombie Population', icon: 'TrendingUp' },
]

export const SANDBOX_SCHEMA: SandboxSetting[] = [
  // Time & Season
  {
    key: 'DayLength',
    label: 'Day Length',
    description: 'How long a day lasts.',
    type: 'select',
    options: [
      { value: 1, label: '15 minutes' },
      { value: 2, label: '30 minutes' },
      { value: 3, label: '1 hour' },
      { value: 4, label: '2 hours' },
      { value: 5, label: '3 hours' },
      { value: 6, label: '4 hours' },
      { value: 7, label: '5 hours' },
      { value: 8, label: '12 hours' },
      { value: 9, label: 'Real-time' }
    ],
    default: 3,
    category: 'time',
    section: 'settings'
  },
  {
    key: 'StartYear',
    label: 'Start Year',
    description: 'Which year the game starts in.',
    type: 'number',
    min: 1,
    max: 100,
    default: 1,
    category: 'time',
    section: 'settings'
  },
  {
    key: 'StartMonth',
    label: 'Start Month',
    description: 'Which month the game starts in (1=Jan, 12=Dec).',
    type: 'select',
    options: [
      { value: 1, label: 'January' },
      { value: 2, label: 'February' },
      { value: 3, label: 'March' },
      { value: 4, label: 'April' },
      { value: 5, label: 'May' },
      { value: 6, label: 'June' },
      { value: 7, label: 'July' },
      { value: 8, label: 'August' },
      { value: 9, label: 'September' },
      { value: 10, label: 'October' },
      { value: 11, label: 'November' },
      { value: 12, label: 'December' }
    ],
    default: 7,
    category: 'time',
    section: 'settings'
  },
  {
    key: 'StartDay',
    label: 'Start Day',
    description: 'Which day of the month the game starts on.',
    type: 'number',
    min: 1,
    max: 28,
    default: 9,
    category: 'time',
    section: 'settings'
  },
  {
    key: 'StartTime',
    label: 'Start Time',
    description: 'What time of day the game starts.',
    type: 'select',
    options: [
      { value: 1, label: '7 AM' },
      { value: 2, label: '9 AM' },
      { value: 3, label: '12 PM (Noon)' },
      { value: 4, label: '2 PM' },
      { value: 5, label: '5 PM' },
      { value: 6, label: '9 PM' },
      { value: 7, label: '12 AM (Midnight)' },
      { value: 8, label: '2 AM' },
      { value: 9, label: '5 AM' }
    ],
    default: 2,
    category: 'time',
    section: 'settings'
  },

  // Population
  {
    key: 'Zombies',
    label: 'Zombie Count',
    description: 'Initial zombie population level.',
    type: 'select',
    options: [
      { value: 1, label: 'Insane' },
      { value: 2, label: 'Very High' },
      { value: 3, label: 'High' },
      { value: 4, label: 'Normal' },
      { value: 5, label: 'Low' },
      { value: 6, label: 'None' }
    ],
    default: 4,
    category: 'population',
    section: 'settings'
  },
  {
    key: 'Distribution',
    label: 'Distribution',
    description: 'How zombies are distributed.',
    type: 'select',
    options: [
      { value: 1, label: 'Urban Focused' },
      { value: 2, label: 'Uniform' }
    ],
    default: 1,
    category: 'population',
    section: 'settings'
  },

  // Loot
  {
    key: 'FoodLoot',
    label: 'Food Loot',
    description: 'Amount of food found in containers.',
    type: 'select',
    options: [
      { value: 1, label: 'Extremely Rare' },
      { value: 2, label: 'Rare' },
      { value: 3, label: 'Normal' },
      { value: 4, label: 'Common' },
      { value: 5, label: 'Abundant' }
    ],
    default: 3,
    category: 'loot',
    section: 'settings'
  },
  {
    key: 'WeaponLoot',
    label: 'Weapon Loot',
    description: 'Amount of weapons found in containers.',
    type: 'select',
    options: [
      { value: 1, label: 'Extremely Rare' },
      { value: 2, label: 'Rare' },
      { value: 3, label: 'Normal' },
      { value: 4, label: 'Common' },
      { value: 5, label: 'Abundant' }
    ],
    default: 3,
    category: 'loot',
    section: 'settings'
  },
  {
    key: 'OtherLoot',
    label: 'Other Loot',
    description: 'Amount of other items found in containers.',
    type: 'select',
    options: [
      { value: 1, label: 'Extremely Rare' },
      { value: 2, label: 'Rare' },
      { value: 3, label: 'Normal' },
      { value: 4, label: 'Common' },
      { value: 5, label: 'Abundant' }
    ],
    default: 3,
    category: 'loot',
    section: 'settings'
  },

  // Environment
  {
    key: 'WaterShut',
    label: 'Water Shutoff',
    description: 'When water shuts off.',
    type: 'select',
    options: [
      { value: 1, label: 'Instant' },
      { value: 2, label: '0-30 Days' },
      { value: 3, label: '0-2 Months' },
      { value: 4, label: '0-6 Months' },
      { value: 5, label: '0-1 Year' },
      { value: 6, label: '0-5 Years' },
      { value: 7, label: 'Never' }
    ],
    default: 2,
    category: 'environment',
    section: 'settings'
  },
  {
    key: 'ElecShut',
    label: 'Electricity Shutoff',
    description: 'When electricity shuts off.',
    type: 'select',
    options: [
      { value: 1, label: 'Instant' },
      { value: 2, label: '0-30 Days' },
      { value: 3, label: '0-2 Months' },
      { value: 4, label: '0-6 Months' },
      { value: 5, label: '0-1 Year' },
      { value: 6, label: '0-5 Years' },
      { value: 7, label: 'Never' }
    ],
    default: 2,
    category: 'environment',
    section: 'settings'
  },
  {
    key: 'Temperature',
    label: 'Temperature',
    description: 'Overall temperature modifier.',
    type: 'select',
    options: [
      { value: 1, label: 'Very Cold' },
      { value: 2, label: 'Cold' },
      { value: 3, label: 'Normal' },
      { value: 4, label: 'Hot' },
      { value: 5, label: 'Very Hot' }
    ],
    default: 3,
    category: 'environment',
    section: 'settings'
  },
  {
    key: 'Rain',
    label: 'Rainfall',
    description: 'How often it rains.',
    type: 'select',
    options: [
      { value: 1, label: 'Very Dry' },
      { value: 2, label: 'Dry' },
      { value: 3, label: 'Normal' },
      { value: 4, label: 'Rainy' },
      { value: 5, label: 'Very Rainy' }
    ],
    default: 3,
    category: 'environment',
    section: 'settings'
  },
  {
    key: 'ErosionSpeed',
    label: 'Nature Reclaims',
    description: 'How fast nature takes over.',
    type: 'select',
    options: [
      { value: 1, label: 'Very Fast (20 days)' },
      { value: 2, label: 'Fast (50 days)' },
      { value: 3, label: 'Normal (100 days)' },
      { value: 4, label: 'Slow (200 days)' },
      { value: 5, label: 'Very Slow (500 days)' }
    ],
    default: 3,
    category: 'environment',
    section: 'settings'
  },

  // Survival
  {
    key: 'XpMultiplier',
    label: 'XP Multiplier',
    description: 'Experience gain multiplier.',
    type: 'number',
    min: 0.1,
    max: 100,
    default: 1.0,
    category: 'survival',
    section: 'settings'
  },
  {
    key: 'StatsDecrease',
    label: 'Stats Decrease',
    description: 'How fast needs (hunger, thirst, etc.) decrease.',
    type: 'select',
    options: [
      { value: 1, label: 'Very Fast' },
      { value: 2, label: 'Fast' },
      { value: 3, label: 'Normal' },
      { value: 4, label: 'Slow' },
      { value: 5, label: 'Very Slow' }
    ],
    default: 3,
    category: 'survival',
    section: 'settings'
  },
  {
    key: 'FoodRotSpeed',
    label: 'Food Rot Speed',
    description: 'How fast food rots.',
    type: 'select',
    options: [
      { value: 1, label: 'Very Fast' },
      { value: 2, label: 'Fast' },
      { value: 3, label: 'Normal' },
      { value: 4, label: 'Slow' },
      { value: 5, label: 'Very Slow' }
    ],
    default: 3,
    category: 'survival',
    section: 'settings'
  },
  {
    key: 'StarterKit',
    label: 'Starter Kit',
    description: 'Give players a starter kit.',
    type: 'boolean',
    default: false,
    category: 'survival',
    section: 'settings'
  },
  {
    key: 'Alarm',
    label: 'House Alarms',
    description: 'Frequency of house alarms.',
    type: 'select',
    options: [
      { value: 1, label: 'Never' },
      { value: 2, label: 'Extremely Rare' },
      { value: 3, label: 'Rare' },
      { value: 4, label: 'Sometimes' },
      { value: 5, label: 'Often' },
      { value: 6, label: 'Very Often' }
    ],
    default: 4,
    category: 'survival',
    section: 'settings'
  },
  {
    key: 'LockedHouses',
    label: 'Locked Houses',
    description: 'Frequency of locked houses.',
    type: 'select',
    options: [
      { value: 1, label: 'Never' },
      { value: 2, label: 'Extremely Rare' },
      { value: 3, label: 'Rare' },
      { value: 4, label: 'Sometimes' },
      { value: 5, label: 'Often' },
      { value: 6, label: 'Very Often' }
    ],
    default: 4,
    category: 'survival',
    section: 'settings'
  },

  // Zombie Lore (Behavior)
  {
    key: 'Speed',
    label: 'Zombie Speed',
    description: 'How fast zombies move.',
    type: 'select',
    options: [
      { value: 1, label: 'Sprinters' },
      { value: 2, label: 'Fast Shamblers' },
      { value: 3, label: 'Shamblers' }
    ],
    default: 3,
    category: 'zombieLore',
    section: 'ZombieLore'
  },
  {
    key: 'Strength',
    label: 'Zombie Strength',
    description: 'How strong zombies are.',
    type: 'select',
    options: [
      { value: 1, label: 'Superhuman' },
      { value: 2, label: 'Normal' },
      { value: 3, label: 'Weak' }
    ],
    default: 2,
    category: 'zombieLore',
    section: 'ZombieLore'
  },
  {
    key: 'Toughness',
    label: 'Zombie Toughness',
    description: 'How tough zombies are to kill.',
    type: 'select',
    options: [
      { value: 1, label: 'Tough' },
      { value: 2, label: 'Normal' },
      { value: 3, label: 'Fragile' }
    ],
    default: 2,
    category: 'zombieLore',
    section: 'ZombieLore'
  },
  {
    key: 'Transmission',
    label: 'Infection Transmission',
    description: 'How the infection spreads.',
    type: 'select',
    options: [
      { value: 1, label: 'Blood + Saliva' },
      { value: 2, label: 'Saliva Only' },
      { value: 3, label: 'Everyone\'s Infected' },
      { value: 4, label: 'None' }
    ],
    default: 1,
    category: 'zombieLore',
    section: 'ZombieLore'
  },
  {
    key: 'Mortality',
    label: 'Infection Mortality',
    description: 'How deadly the infection is.',
    type: 'select',
    options: [
      { value: 1, label: 'Instant' },
      { value: 2, label: '0-30 seconds' },
      { value: 3, label: '0-1 minute' },
      { value: 4, label: '0-12 hours' },
      { value: 5, label: '2-3 days' },
      { value: 6, label: '1-2 weeks' }
    ],
    default: 5,
    category: 'zombieLore',
    section: 'ZombieLore'
  },
  {
    key: 'Cognition',
    label: 'Zombie Intelligence',
    description: 'How smart zombies are.',
    type: 'select',
    options: [
      { value: 1, label: 'Navigate + Use Doors' },
      { value: 2, label: 'Navigate' },
      { value: 3, label: 'Basic Navigation' }
    ],
    default: 3,
    category: 'zombieLore',
    section: 'ZombieLore'
  },
  {
    key: 'Memory',
    label: 'Zombie Memory',
    description: 'How long zombies remember.',
    type: 'select',
    options: [
      { value: 1, label: 'Long' },
      { value: 2, label: 'Normal' },
      { value: 3, label: 'Short' },
      { value: 4, label: 'None' }
    ],
    default: 2,
    category: 'zombieLore',
    section: 'ZombieLore'
  },
  {
    key: 'Sight',
    label: 'Zombie Sight',
    description: 'How well zombies can see.',
    type: 'select',
    options: [
      { value: 1, label: 'Eagle-eyed' },
      { value: 2, label: 'Normal' },
      { value: 3, label: 'Poor' }
    ],
    default: 2,
    category: 'zombieLore',
    section: 'ZombieLore'
  },
  {
    key: 'Hearing',
    label: 'Zombie Hearing',
    description: 'How well zombies can hear.',
    type: 'select',
    options: [
      { value: 1, label: 'Pinpoint' },
      { value: 2, label: 'Normal' },
      { value: 3, label: 'Poor' }
    ],
    default: 2,
    category: 'zombieLore',
    section: 'ZombieLore'
  },

  // Zombie Config (Population)
  {
    key: 'PopulationMultiplier',
    label: 'Population Multiplier',
    description: 'Overall zombie population multiplier.',
    type: 'number',
    min: 0,
    max: 4,
    default: 1.0,
    category: 'zombiePopulation',
    section: 'ZombieConfig'
  },
  {
    key: 'PopulationStartMultiplier',
    label: 'Start Multiplier',
    description: 'Zombie population at game start.',
    type: 'number',
    min: 0,
    max: 4,
    default: 1.0,
    category: 'zombiePopulation',
    section: 'ZombieConfig'
  },
  {
    key: 'PopulationPeakMultiplier',
    label: 'Peak Multiplier',
    description: 'Zombie population at peak day.',
    type: 'number',
    min: 0,
    max: 4,
    default: 1.5,
    category: 'zombiePopulation',
    section: 'ZombieConfig'
  },
  {
    key: 'PopulationPeakDay',
    label: 'Peak Day',
    description: 'Day when zombie population peaks.',
    type: 'number',
    min: 1,
    max: 365,
    default: 28,
    category: 'zombiePopulation',
    section: 'ZombieConfig'
  },
  {
    key: 'RespawnHours',
    label: 'Respawn Hours',
    description: 'Hours before zombies respawn. 0 = disabled.',
    type: 'number',
    min: 0,
    max: 8760,
    default: 72,
    category: 'zombiePopulation',
    section: 'ZombieConfig'
  },
  {
    key: 'RespawnUnseenHours',
    label: 'Unseen Hours',
    description: 'Hours a chunk must be unseen before respawn.',
    type: 'number',
    min: 0,
    max: 8760,
    default: 16,
    category: 'zombiePopulation',
    section: 'ZombieConfig'
  },
  {
    key: 'RespawnMultiplier',
    label: 'Respawn Multiplier',
    description: 'Fraction of population that respawns.',
    type: 'number',
    min: 0,
    max: 1,
    default: 0.1,
    category: 'zombiePopulation',
    section: 'ZombieConfig'
  },
]

// Helper to get setting by key
export function getIniSetting(key: string): IniSetting | undefined {
  return INI_SCHEMA.find(s => s.key === key)
}

export function getSandboxSetting(key: string): SandboxSetting | undefined {
  return SANDBOX_SCHEMA.find(s => s.key === key)
}

// Group settings by category
export function groupByCategory<T extends { category: string }>(settings: T[]): Record<string, T[]> {
  return settings.reduce((acc, setting) => {
    if (!acc[setting.category]) {
      acc[setting.category] = []
    }
    acc[setting.category].push(setting)
    return acc
  }, {} as Record<string, T[]>)
}
