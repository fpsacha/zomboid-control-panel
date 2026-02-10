# 🎮 Zomboid Control Panel

A web-based admin panel for managing Project Zomboid dedicated servers on Windows.  
Control your server, manage players, track mods, schedule tasks, and more — all from your browser.

![Dashboard](Screenshots/Main_Dashboard.png)

---

## Quick Start

1. Download the [latest release](https://github.com/fpsacha/zomboid-control-panel/releases/latest)
2. Extract and run **`ZomboidControlPanel.exe`** — no installation needed
3. Open **http://localhost:3001** in your browser
4. Add your server and configure your RCON password

> Alternatively, run `Start.bat` for development mode (requires Node.js 18+).

---

## Features

### Server Management
- 🎮 **Server Control** — Start, stop, restart, and save your server with one click
- 🖥️ **Multi-Server Support** — Manage multiple PZ servers from a single panel
- 🌐 **Remote RCON Servers** — Connect to remote servers via RCON (no local install needed)
- ⏰ **Task Scheduler** — Schedule automatic restarts, messages, and recurring tasks
- 🔄 **Auto-Restart on Mod Update** — Automatically restart when Steam Workshop mods are updated
- 📡 **Auto-Start** — Optionally launch your server when the panel starts

### Players & Chat
- 👥 **Player Management** — View online players, kick, ban, teleport, set access levels
- 📤 **Character Export/Import** — Backup and restore player XP, perks, skills, and recipes
- 💬 **In-Game Chat** — Read and send messages directly from the panel
- 💬 **RCON Console** — Full terminal interface for executing server commands

### World & Mods
- 📦 **Workshop Mod Manager** — Track installed mods, detect updates, manage mod presets
- 🌤️ **Weather & Climate Control** — Trigger storms, blizzards, and manipulate temperature, wind, fog, and more
- 🧟 **Event Triggers** — Start helicopter events, hordes, and sound events
- 🗑️ **Chunk Cleaner** — Remove old/unused chunks to reduce save file size
- 💾 **World Backups** — Create and manage server backups

### Configuration
- ⚙️ **INI Settings Editor** — Edit your server's configuration directly from the panel
- 🔧 **Sandbox Editor** — Modify sandbox/world settings
- 🔌 **Panel Settings** — Change panel port, view panel address for sharing with co-admins
- 🤖 **Discord Bot** — Control your server from Discord
- 🔌 **PanelBridge** — Server-side Lua script for advanced features (weather, teleport, character export)
- 🌐 **Server Finder** — Browse public PZ servers

---

## Requirements

- **Windows 10/11**
- A Project Zomboid dedicated server with **RCON enabled**
- Node.js 18+ *(only for development mode — not needed for the exe)*

---

## First Time Setup

1. Run **`ZomboidControlPanel.exe`**
2. Go to **My Servers** and add your server:
   - **Local server** — Set the server install path and RCON password
   - **Remote server** — Enter the RCON host, port, and password
3. Set your RCON password to match your server's `.ini` file
4. *(Optional)* Install **PanelBridge** for advanced features — see below

---

## PanelBridge

**PanelBridge** is a Lua script that runs on your PZ server to enable advanced panel features. It is **not** a Workshop mod.

### What it enables:
- Player teleportation and detailed stats
- Character XP/perk export & import
- Weather & climate control (blizzards, storms, fog, temperature)
- Sound events (gunshots, alarms) at any location
- Real-time player positions

### Installation (Recommended)
1. Open the panel → **Panel Settings**
2. Scroll to **PanelBridge** section
3. Click **"Install to Active Server"**
4. Set `DoLuaChecksum=false` in your server's `.ini` file
5. Restart the PZ server

### Manual Installation
Copy `pz-mod/PanelBridge/media/lua/server/PanelBridge.lua` to:
```
YOUR_SERVER_INSTALL_PATH/media/lua/server/PanelBridge.lua
```

> ⚠️ Do **not** add PanelBridge to your `Mods=` line — it's not a mod.  
> Re-install after game updates, as updates may overwrite the `lua/server/` folder.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Can't connect to RCON | Verify RCON is enabled in your `.ini`, password matches, and port isn't firewalled |
| PanelBridge not working | Check that `PanelBridge.lua` is in `media/lua/server/`, `DoLuaChecksum=false` is set, and server was restarted |
| Mod updates not detecting | Verify Workshop IDs are correct, try syncing from server config |
| Server won't start/stop | Check server path is correct, try running as Administrator |
| Character export/import fails | PanelBridge must be installed and the player must be online |

---

## Tech Stack

- **Frontend** — React, TypeScript, Tailwind CSS, shadcn/ui
- **Backend** — Node.js, Express, Socket.IO
- **Database** — SQLite (via better-sqlite3)
- **Packaging** — pkg (standalone Windows executable)

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

*Built with the assistance of [Claude](https://www.anthropic.com/) and [GitHub Copilot](https://github.com/features/copilot).*
