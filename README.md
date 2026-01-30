# PZ Server Panel

A web-based management panel for Project Zomboid dedicated servers on Windows.

## Quick Start

**Option 1: Standalone Executable (Recommended)**
- Just double-click `ZomboidControlPanel.exe` - no installation needed!

**Option 2: Development Mode**
- Double-click `Start.bat` (requires Node.js)

The launcher will:
- ✅ Check if Node.js is installed (for dev mode)
- ✅ Install all dependencies automatically (first run only)
- ✅ Start the backend and frontend servers
- ✅ Open your browser to the panel

## Alternative Launchers

| File | Description |
|------|-------------|
| `ZomboidControlPanel.exe` | Standalone executable - No Node.js needed |
| `Start.bat` | Development mode - Best for development |
| `Start-Production.bat` | Production mode - Faster, single server |
| `install.bat` | Manual dependency installation |

## Features

- 🎮 **Server Control** - Start, stop, restart, and save your server
- 👥 **Player Management** - View online players, kick, ban, set access levels
- 📤 **Character Export/Import** - Export and import player XP, perks, skills, recipes
- 💬 **RCON Console** - Execute commands with a real-time terminal interface
- 📦 **Mod Manager** - Track Steam Workshop mods and auto-detect updates
- ⏰ **Scheduler** - Schedule automatic restarts and recurring tasks
- 🔄 **Auto-Restart on Mod Update** - Automatically restart when mods are updated
- 🌧️ **Weather Control** - Change weather conditions in-game
- 🧟 **Event Triggers** - Start helicopter events, hordes, and other game events
- 🤖 **Discord Bot** - Manage your server from Discord
- 🗑️ **Chunk Cleaner** - Remove old/unused chunks to reduce save size
- 🔌 **PanelBridge Lua Mod** - Direct server communication for advanced features
- 🌐 **Network Configuration** - Configure server port and UPnP settings
- 🖥️ **Multi-Server Support** - Manage multiple PZ servers from one panel

## Requirements

### For Standalone Executable
- Windows 10/11
- A Project Zomboid dedicated server with RCON enabled

### For Development Mode
- Node.js 18+ (download from https://nodejs.org/)
- A Project Zomboid dedicated server with RCON enabled
- Windows OS

## First Time Setup

1. **Run the panel** - Double-click `ZomboidControlPanel.exe` (or `Start.bat` for dev mode)
2. **Configure your server** in the Settings page:
   - Set RCON password (must match your server's INI file)
   - Set server paths
3. **Install PanelBridge mod** (optional but recommended):
   - Copy the `pz-mod/PanelBridge` folder to your server's mods directory
   - Add `PanelBridge` to your server's mod list
   - This enables advanced features like player teleporting, character export/import, and more

## Enabling RCON on Your PZ Server

In your server's `.ini` file (usually in `Zomboid/Server/`), set:
```ini
RCONPassword=your_password
RCONPort=27015
```

Then restart your server for changes to take effect.

## PanelBridge Lua Mod

The PanelBridge mod enables advanced server control features that aren't possible through RCON alone:

- **Player Management**: Teleport players, view detailed stats, heal players
- **Character Export/Import**: Backup and restore player XP, perks, skills, and recipes
- **World Control**: Set time, weather effects, spawn items/vehicles
- **Server Info**: Get detailed server status, player lists with positions

### Installing PanelBridge

1. Copy `pz-mod/PanelBridge` to your server's workshop mods folder or custom mods folder
2. Add `PanelBridge` to your server's `Mods=` line in the .ini file
3. Restart your server
4. Configure the bridge in the panel's Settings page

## Network Configuration

When creating a new server, you can configure:
- **Game Port** - The main server port (default: 16261)
- **UPnP** - Automatic port forwarding for home routers (enabled by default)

## Manual Installation (Optional)

If you prefer manual setup:
| `RCON_PORT` | PZ server RCON port | 27015 |
| `RCON_PASSWORD` | RCON password | (required) |
| `SERVER_PATH` | Path to PZ server installation | |
| `ZOMBOID_DATA_PATH` | Path to Zomboid user data folder | |
| `MOD_CHECK_INTERVAL` | Minutes between mod update checks | 30 |

### Server Paths

- **Server Installation**: Where `StartServer64.bat` is located
- **Config Path**: Usually `C:\Users\<Name>\Zomboid\Server`
- **Data Path**: Usually `C:\Users\<Name>\Zomboid`

## Project Structure

```
Dev1/
├── server/
│   ├── index.js           # Express server entry point
│   ├── database/
│   │   └── init.js        # SQLite database setup
│   ├── routes/
│   │   ├── server.js      # Server control endpoints
│   │   ├── players.js     # Player management endpoints
│   │   ├── rcon.js        # RCON command endpoints
│   │   ├── scheduler.js   # Task scheduling endpoints
│   │   ├── mods.js        # Mod tracking endpoints
│   │   └── config.js      # Settings endpoints
│   ├── services/
│   │   ├── rcon.js        # RCON connection service
│   │   ├── serverManager.js  # Server process management
│   │   ├── modChecker.js  # Steam Workshop API integration
│   │   └── scheduler.js   # Cron job management
│   └── utils/
│       ├── logger.js      # Winston logger
│       └── commands.js    # PZ command definitions
├── client/
│   ├── src/
│   │   ├── components/    # React UI components
│   │   ├── pages/         # Page components
│   │   ├── lib/           # API client & utilities
│   │   └── contexts/      # React contexts
│   └── ...
├── data/                  # SQLite database (created at runtime)
└── logs/                  # Application logs
```

## RCON Commands Reference

The panel supports all standard Project Zomboid RCON commands:

- **Server**: `save`, `quit`, `servermsg`
- **Players**: `players`, `kick`, `banuser`, `unbanuser`, `adduser`
- **Admin**: `setaccesslevel`, `grantadmin`, `removeadmin`
- **Weather**: `changeoption`, `rain`, `fog`
- **Events**: `helicopter`, `gunshot`
- **Items**: `additem`, `addxp`, `addvehicle`
- **Cheats**: `godmod`, `invisible`, `noclip`

## PanelBridge Commands (via Lua mod)

When PanelBridge is installed, additional commands are available:

- **Player Info**: Get detailed player stats, inventory, position
- **Teleport**: Move players to coordinates or other players
- **Character Export**: Save player perks, XP, skills to JSON
- **Character Import**: Restore perks, stats, recipes to a player
- **Heal**: Restore player health
- **Give Items**: Spawn items directly in player inventory
- **Spawn Vehicles**: Create vehicles at player location
- **World Time**: Set in-game time and weather

## Troubleshooting

### Can't connect to RCON
1. Make sure your PZ server is running
2. Verify RCON is enabled in your server's .ini file
3. Check that the port isn't blocked by a firewall
4. Ensure the password matches exactly

### PanelBridge not working
1. Make sure the mod is installed in your server's mods folder
2. Verify `PanelBridge` is in your server's `Mods=` line
3. Check that the bridge data path is correctly configured in Settings
4. Restart both the PZ server and the panel after installing

### Mod updates not detecting
1. Verify your Steam Web API key if using one
2. Check that mod Workshop IDs are correct
3. Try syncing mods from server configuration

### Server won't start/stop
1. Make sure SERVER_PATH points to the correct folder
2. Run the panel as Administrator if needed
3. Check Windows Task Manager for zombie processes

### Character export/import issues
1. Make sure PanelBridge mod is installed and running
2. Player must be online for export/import to work
3. Check the panel logs for specific error messages

## License

MIT License - Feel free to modify and use as needed.
