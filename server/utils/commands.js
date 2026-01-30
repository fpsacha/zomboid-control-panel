// All PZ Admin commands with descriptions and parameters
export const PZ_COMMANDS = {
  // Server Management
  save: {
    command: 'save',
    description: 'Save the current world',
    parameters: [],
    category: 'server'
  },
  quit: {
    command: 'quit',
    description: 'Save and quit the server',
    parameters: [],
    category: 'server'
  },
  servermsg: {
    command: 'servermsg',
    description: 'Broadcast a message to all connected players',
    parameters: [{ name: 'message', type: 'string', required: true }],
    category: 'server'
  },
  reloadoptions: {
    command: 'reloadoptions',
    description: 'Reload server options and send to clients',
    parameters: [],
    category: 'server'
  },
  changeoption: {
    command: 'changeoption',
    description: 'Change a server option',
    parameters: [
      { name: 'optionName', type: 'string', required: true },
      { name: 'newValue', type: 'string', required: true }
    ],
    category: 'server'
  },
  showoptions: {
    command: 'showoptions',
    description: 'Show the list of current server options and values',
    parameters: [],
    category: 'server'
  },
  checkModsNeedUpdate: {
    command: 'checkModsNeedUpdate',
    description: 'Check if any mods need updates',
    parameters: [],
    category: 'server'
  },

  // Player Management
  players: {
    command: 'players',
    description: 'List all connected players',
    parameters: [],
    category: 'players'
  },
  kick: {
    command: 'kick',
    description: 'Kick a player from the server',
    parameters: [
      { name: 'username', type: 'string', required: true },
      { name: 'reason', type: 'string', required: false }
    ],
    category: 'players'
  },
  banuser: {
    command: 'banuser',
    description: 'Ban a user. Can also ban IP with -ip flag',
    parameters: [
      { name: 'username', type: 'string', required: true },
      { name: 'banIp', type: 'boolean', required: false },
      { name: 'reason', type: 'string', required: false }
    ],
    category: 'players'
  },
  unbanuser: {
    command: 'unbanuser',
    description: 'Unban a player',
    parameters: [{ name: 'username', type: 'string', required: true }],
    category: 'players'
  },
  banid: {
    command: 'banid',
    description: 'Ban a SteamID',
    parameters: [{ name: 'steamId', type: 'string', required: true }],
    category: 'players'
  },
  unbanid: {
    command: 'unbanid',
    description: 'Unban a SteamID',
    parameters: [{ name: 'steamId', type: 'string', required: true }],
    category: 'players'
  },
  setaccesslevel: {
    command: 'setaccesslevel',
    description: 'Set access level: admin, moderator, overseer, gm, observer, none',
    parameters: [
      { name: 'username', type: 'string', required: true },
      { name: 'level', type: 'string', required: true }
    ],
    category: 'players'
  },
  voiceban: {
    command: 'voiceban',
    description: 'Block/unblock voice from a user',
    parameters: [
      { name: 'username', type: 'string', required: true },
      { name: 'value', type: 'boolean', required: true }
    ],
    category: 'players'
  },

  // Whitelist
  adduser: {
    command: 'adduser',
    description: 'Add a new user to whitelisted server',
    parameters: [
      { name: 'username', type: 'string', required: true },
      { name: 'password', type: 'string', required: true }
    ],
    category: 'whitelist'
  },
  addusertowhitelist: {
    command: 'addusertowhitelist',
    description: 'Add a connected user to whitelist',
    parameters: [{ name: 'username', type: 'string', required: true }],
    category: 'whitelist'
  },
  removeuserfromwhitelist: {
    command: 'removeuserfromwhitelist',
    description: 'Remove a user from whitelist',
    parameters: [{ name: 'username', type: 'string', required: true }],
    category: 'whitelist'
  },
  addalltowhitelist: {
    command: 'addalltowhitelist',
    description: 'Add all connected users to whitelist',
    parameters: [],
    category: 'whitelist'
  },

  // Teleport
  teleport: {
    command: 'teleport',
    description: 'Teleport to a player or teleport player1 to player2',
    parameters: [
      { name: 'player1', type: 'string', required: true },
      { name: 'player2', type: 'string', required: false }
    ],
    category: 'teleport'
  },
  teleportto: {
    command: 'teleportto',
    description: 'Teleport to coordinates x,y,z',
    parameters: [
      { name: 'x', type: 'number', required: true },
      { name: 'y', type: 'number', required: true },
      { name: 'z', type: 'number', required: true }
    ],
    category: 'teleport'
  },

  // Items and XP
  additem: {
    command: 'additem',
    description: 'Give an item to a player',
    parameters: [
      { name: 'username', type: 'string', required: false },
      { name: 'item', type: 'string', required: true },
      { name: 'count', type: 'number', required: false }
    ],
    category: 'items'
  },
  addxp: {
    command: 'addxp',
    description: 'Give XP to a player',
    parameters: [
      { name: 'username', type: 'string', required: true },
      { name: 'perk', type: 'string', required: true },
      { name: 'amount', type: 'number', required: true }
    ],
    category: 'items'
  },
  addvehicle: {
    command: 'addvehicle',
    description: 'Spawn a vehicle',
    parameters: [
      { name: 'vehicle', type: 'string', required: true },
      { name: 'username', type: 'string', required: false }
    ],
    category: 'items'
  },

  // Weather and Events
  startrain: {
    command: 'startrain',
    description: 'Start rain on the server',
    parameters: [{ name: 'intensity', type: 'number', required: false }],
    category: 'weather'
  },
  stoprain: {
    command: 'stoprain',
    description: 'Stop rain on the server',
    parameters: [],
    category: 'weather'
  },
  startstorm: {
    command: 'startstorm',
    description: 'Start a storm (duration in game hours)',
    parameters: [{ name: 'duration', type: 'number', required: false }],
    category: 'weather'
  },
  stopweather: {
    command: 'stopweather',
    description: 'Stop all weather on the server',
    parameters: [],
    category: 'weather'
  },
  chopper: {
    command: 'chopper',
    description: 'Trigger helicopter event on random player',
    parameters: [],
    category: 'events'
  },
  gunshot: {
    command: 'gunshot',
    description: 'Trigger gunshot sound on random player',
    parameters: [],
    category: 'events'
  },
  lightning: {
    command: 'lightning',
    description: 'Strike lightning on player',
    parameters: [{ name: 'username', type: 'string', required: false }],
    category: 'events'
  },
  thunder: {
    command: 'thunder',
    description: 'Thunder sound on player',
    parameters: [{ name: 'username', type: 'string', required: false }],
    category: 'events'
  },
  alarm: {
    command: 'alarm',
    description: 'Sound building alarm at admin position',
    parameters: [],
    category: 'events'
  },
  createhorde: {
    command: 'createhorde',
    description: 'Spawn a horde near a player',
    parameters: [
      { name: 'count', type: 'number', required: true },
      { name: 'username', type: 'string', required: false }
    ],
    category: 'events'
  },

  // Admin Modes
  godmod: {
    command: 'godmod',
    description: 'Make player invincible',
    parameters: [
      { name: 'username', type: 'string', required: false },
      { name: 'value', type: 'boolean', required: true }
    ],
    category: 'admin'
  },
  invisible: {
    command: 'invisible',
    description: 'Make player invisible to zombies',
    parameters: [
      { name: 'username', type: 'string', required: false },
      { name: 'value', type: 'boolean', required: true }
    ],
    category: 'admin'
  },
  noclip: {
    command: 'noclip',
    description: 'Allow player to pass through walls',
    parameters: [
      { name: 'username', type: 'string', required: false },
      { name: 'value', type: 'boolean', required: true }
    ],
    category: 'admin'
  },

  // Safehouse
  releasesafehouse: {
    command: 'releasesafehouse',
    description: 'Release a safehouse you own',
    parameters: [],
    category: 'safehouse'
  },

  // Lua
  reloadlua: {
    command: 'reloadlua',
    description: 'Reload a Lua script on the server',
    parameters: [{ name: 'filename', type: 'string', required: true }],
    category: 'advanced'
  },

  // Logging
  log: {
    command: 'log',
    description: 'Set log level for a specific type',
    parameters: [
      { name: 'type', type: 'string', required: true },
      { name: 'level', type: 'string', required: true }
    ],
    category: 'advanced'
  },

  // Statistics
  stats: {
    command: 'stats',
    description: 'Set and clear server statistics',
    parameters: [
      { name: 'mode', type: 'string', required: true },
      { name: 'period', type: 'number', required: false }
    ],
    category: 'advanced'
  },

  // Remove zombies
  removezombies: {
    command: 'removezombies',
    description: 'Remove zombies from the server',
    parameters: [],
    category: 'events'
  },

  // Clear console
  clear: {
    command: 'clear',
    description: 'Clear the server console',
    parameters: [],
    category: 'server'
  }
};

// Vehicle types available in PZ
export const VEHICLES = [
  'Base.VanAmbulance',
  'Base.CarLightsPolice',
  'Base.PickUpTruck',
  'Base.PickUpTruckMccoy',
  'Base.StepVan',
  'Base.Van',
  'Base.CarStationWagon',
  'Base.CarStationWagon2',
  'Base.CarNormal',
  'Base.CarNormal2',
  'Base.CarNormal3',
  'Base.CarNormal4',
  'Base.SmallCar',
  'Base.SmallCar02',
  'Base.SportsCar',
  'Base.PickUpVanMccoy',
  'Base.OffRoad',
  'Base.SUV',
  'Base.Taxi',
  'Base.CarTaxi',
  'Base.CarLights',
  'Base.PickUpTruckLights',
  'Base.PickUpTruckLightsFire',
  'Base.VanRadio',
  'Base.VanSeats',
  'Base.CarLightsFireDept',
  'Base.VanSpecial',
  'Base.VanSpiffo',
  'Base.Trailer',
  'Base.TrailerAdvert'
];

// Perks for XP
export const PERKS = [
  'Fitness',
  'Strength',
  'Sprinting',
  'Lightfoot',
  'Nimble',
  'Sneak',
  'Axe',
  'Blunt',
  'SmallBlunt',
  'LongBlade',
  'SmallBlade',
  'Spear',
  'Maintenance',
  'Woodwork',
  'Cooking',
  'Farming',
  'Doctor',
  'Electricity',
  'MetalWelding',
  'Mechanics',
  'Tailoring',
  'Aiming',
  'Reloading',
  'Fishing',
  'Trapping',
  'PlantScavenging'
];

// Access levels
export const ACCESS_LEVELS = [
  'admin',
  'moderator',
  'overseer',
  'gm',
  'observer',
  'none'
];

// Log types for the /log command
export const LOG_TYPES = [
  'General', 'Network', 'Multiplayer', 'Voice', 'Packet', 'NetworkFileDebug',
  'Lua', 'Mod', 'Sound', 'Zombie', 'Combat', 'Objects', 'Fireplace', 'Radio',
  'MapLoading', 'Clothing', 'Animation', 'Asset', 'Script', 'Shader', 'Input',
  'Recipe', 'ActionSystem', 'IsoRegion', 'UniTests', 'FileIO', 'Ownership',
  'Death', 'Damage', 'Statistic', 'Vehicle', 'Checksum'
];

// Log levels
export const LOG_LEVELS = ['Trace', 'Debug', 'General', 'Warning', 'Error'];

// Stats modes
export const STATS_MODES = ['none', 'file', 'console', 'all'];
