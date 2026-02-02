# v0.1.2-alpha - Weather & Stability Update

## 🎮 Zomboid Control Panel - v0.1.2-alpha

### 🌤️ Weather & Climate Overhaul
- **Advanced Weather Control**: Trigger specific weather events (Blizzards, Tropical Storms, Thunderstorms).
- **Climate Manipulation**: Direct control over Wind, Temperature, Fog, Clouds, and Ambient Light.
- **Sound Events**: Play world sounds (gunshots, alarms) to attract zombies or create atmosphere.

### 🛠️ Stability & Fixes
- **Command Lock Fix**: Resolved a race condition where the command queue could get stuck in an infinite loop.
- **Type Safety**: Improved numeric parsing for climate controls to prevent API mismatches.
- **Performance**: Increased status update frequency (3s) for snappier panel detection.
- **Compatibility**: Verified B41/B42 cross-compatibility for basic features.

# v0.1.0-alpha - Initial Alpha Release

## 🎮 Zomboid Control Panel - Alpha Release

This is the first public alpha release of the Zomboid Control Panel.

### Features
- **Dashboard** - Real-time server status, player count, RCON and PanelBridge status
- **Server Controls** - Start, stop, restart with warnings, save world, backup
- **Auto-start option** - Automatically start PZ server when panel launches
- **Player Management** - View online players, kick, ban, teleport, give items
- **Mod Management** - Track workshop mods, check for updates, manage presets
- **Server Configuration** - Edit INI and Sandbox settings with templates
- **Scheduler** - Schedule restarts, broadcasts, backups
- **Console** - Send RCON commands, view server logs
- **Backups** - Manual and scheduled backups with restore capability
- **Events Log** - Track player activity, server events
- **Discord Integration** - Webhooks for server events
- **Two Themes** - Modern (clean) and Survivor (Project Zomboid aesthetic)

### Requirements
- Project Zomboid Dedicated Server (Build 42+)
- RCON enabled on the server
- Node.js 18+ (if running from source)

### ⚠️ Alpha Warning
This is an early alpha release. Features may be incomplete or buggy. Use at your own risk and always backup your server data.

### Installation
See README.md for installation instructions.
