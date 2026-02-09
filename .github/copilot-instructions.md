# Copilot Instructions — Zomboid Control Panel

> This file is auto-loaded by GitHub Copilot in every new chat session.
> It contains project-specific context, conventions, and procedures.

---

## Project Overview

**Zomboid Control Panel** is a web-based admin panel for Project Zomboid dedicated servers.

| Component | Tech | Location (Dev1) | Purpose |
|-----------|------|-----------------|---------|
| Client | React + TypeScript + Vite + Tailwind + shadcn/ui | `client/` | Web UI |
| Server | Node.js + Express + Socket.IO | `server/` | REST API + WebSocket |
| PanelBridge | Lua (PZ server mod) | `pz-mod/PanelBridge/` | In-game ↔ panel communication |
| Exe | esbuild + pkg | `dist-exe/` → `release/` | Standalone Windows binary |

## Workspace Layout

```
D:\Zomboid_dev_panel\
├── Dev1/                    ← Active development folder (NOT a git repo)
│   ├── client/              ← React app source
│   ├── server/              ← Node.js API
│   │   ├── routes/
│   │   │   ├── panelBridge.js    ← REST endpoints for bridge commands
│   │   │   └── players.js        ← Player routes (RCON only, NOT bridge)
│   │   └── services/
│   │       └── panelBridge.js    ← PanelBridge singleton service class
│   ├── pz-mod/PanelBridge/  ← Lua mod
│   │   └── media/lua/server/PanelBridge.lua
│   ├── release/             ← Build output (exe + client dist + mod)
│   ├── build.js             ← esbuild + pkg build script
│   ├── deploy.ps1           ← Deploy release/ to \\garage\PZ\Admin_panel
│   └── release.ps1          ← Full release pipeline script
│
├── GitHub/                  ← Git working copy (fpsacha/zomboid-control-panel)
│   ├── .github/copilot-instructions.md  ← THIS FILE
│   └── (mirrors Dev1 source files)
│
├── Server_Config_Data/      ← PZ server config & saves
├── ServerB42Files/          ← PZ server binaries
└── SteamCMD/                ← Steam CLI
```

## Key Architecture Details

### PanelBridge Communication Pattern
```
Node.js writes → commands.json → Lua reads & processes
Lua writes    → results.json  → Node.js polls & reads (300ms)
Lua writes    → status.json   → Node.js polls (1s)
```

- The bridge uses **file-based JSON communication**, not TCP/RCON
- Files are written to: `{PZ Server}/Lua/panelbridge/{serverName}/`
- Node.js service: `server/services/panelBridge.js` (~895 lines, singleton PanelBridge class extending EventEmitter)
- Routes: `server/routes/panelBridge.js` (~1598 lines, REST API endpoints)
- **players.js routes use RCON exclusively, NOT the PanelBridge**

### PanelBridge.lua Key Info
- Current version tracked in `PanelBridge.VERSION` at top of file
- Embedded JSON parser (no external deps) — uses bounded `while pos <= #str` loops
- Command handlers are in `local handlers = {}` table
- Uses `pcall` extensively for crash safety
- API-aware: detects B41 vs B42 PZ versions
- Important mappings:
  - Panel route `/chat/alert` sends `{ message, alert }` (the Lua handler reads `args.alert or args.isAlert`)
  - `sendServerMessage` route sends `{ message, color }` — Lua ignores `color`

## Deployment Targets

| Target | Path | What |
|--------|------|------|
| Live PZ Server | `\\garage\pz\Server_Data\DoomerZ_B42V3\media\lua\server\PanelBridge.lua` | PanelBridge Lua mod |
| Live Admin Panel | `\\garage\PZ\Admin_panel\` | Full app (exe + client + mod) |
| GitHub | `fpsacha/zomboid-control-panel` (main branch) | Source code |
| GitHub Releases | Tagged releases with exe asset | Downloadable builds |

## Release Procedure

### Automated (Preferred)
```powershell
# From Dev1 folder:
.\release.ps1 -Version "0.1.5-alpha"

# With custom release notes:
.\release.ps1 -Version "0.1.5-alpha" -ReleaseNotes ".\notes.md"

# Skip build (reuse existing release/ folder):
.\release.ps1 -Version "0.1.5-alpha" -SkipBuild

# Dry run (see what would happen):
.\release.ps1 -Version "0.1.5-alpha" -DryRun
```

### Manual Steps (if script unavailable)
1. Bump version in `Dev1/package.json` AND `GitHub/package.json`
2. `cd Dev1/client && npm run build` (builds Vite client)
3. `cd Dev1 && npm run build:exe` (bundles server + creates exe via pkg)
4. Copy `PanelBridge.lua` to live PZ server path
5. `cd Dev1 && .\deploy.ps1` (deploys release/ to \\garage, preserves db.json)
6. Sync changed files from Dev1 to GitHub folder
7. `cd GitHub && git add -A && git commit -m "Release vX.Y.Z" && git push`
8. `gh release create vX.Y.Z --repo fpsacha/zomboid-control-panel --title "vX.Y.Z" --prerelease --notes-file notes.md "Dev1\release\ZomboidControlPanel.exe"`

**IMPORTANT**: Every release MUST include the .exe as a GitHub Release asset. Do NOT commit the exe to the repo — use GitHub Releases.

## Version Conventions

- **App version**: `package.json` → `"version": "X.Y.Z-alpha"` (e.g., `0.1.4-alpha`)
- **PanelBridge version**: `PanelBridge.lua` → `VERSION = "X.Y.Z"` (e.g., `1.4.3`)
- **Git tags**: `vX.Y.Z-alpha` (matches package.json version)
- Bump PanelBridge version only when modifying PanelBridge.lua
- Bump app version on every release

## Code Conventions

### Lua (PanelBridge.lua)
- All command handlers return `(success: bool, data: table|nil, errorMsg: string|nil)`
- Wrap all PZ Java API calls in `pcall()` — methods may not exist across versions
- Use `PanelBridge.hasMethod(obj, name)` before calling version-specific APIs
- Use `PanelBridge.safeCall(obj, method, ...)` for safe method invocation
- All player lookups use `getPlayerByUsername(username)` local helper (not the global)
- Always nil-check player objects in loops: `local player = list:get(i); if player then`
- JSON parser loops MUST be bounded (`while pos <= #str`), NEVER `while true`

### Node.js
- ES modules (`"type": "module"` in package.json)
- Express routes in `server/routes/`
- Services in `server/services/`
- Bridge commands sent via `bridge.sendCommand(action, args)` or named convenience methods

### Client
- React 18 + TypeScript
- shadcn/ui components (configured via `components.json`)
- Tailwind CSS
- Vite for bundling

## Previous Audit History

30 fixes applied across 4 rounds of PanelBridge.lua auditing:
- Round 1 (v1.4.0→commit d43e601): 7 fixes — null guards, dead code, O(n²) string concat
- Round 2 (commit eb532b1): 9 fixes — startup safety, error handling, player export
- Round 3 (commit 97db9a1): 5 fixes — alert key mismatch, JSON array parser, zombie cleanup
- Round 4 (v1.4.3, commit ecac9eb): 8 fixes — JSON object parser, pcall hardening, giveItem clamp
