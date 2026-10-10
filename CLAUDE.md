# Zomboid Control Panel: working notes for Claude

Panel for Project Zomboid (Build 42) dedicated servers. Node/Express 5 + Socket.IO in `server/`, React/Vite/Tailwind 3 in `client/`, the in-game Lua mod "PanelBridge" in `pz-mod/PanelBridge/`, exe/Docker builds from `build.js`. Repo: fpsacha/zomboid-control-panel. The maintainer is on Windows; prefers short answers and merges green PRs/closes issues promptly.

## Commands (run from the repo root unless noted)
- Server tests: `npx vitest run server/tests/<file>.test.js`. **One file at a time**: several files time out under concurrent runs. Whole suite: `npx vitest run server/tests --exclude ".claude/**"`.
- Client: `cd client && npx vitest run <paths>`, typecheck `npx tsc -p tsconfig.json --noEmit` (never `tsc -b`), lint `npx eslint <files>`.
- Preview without a backend: `VITE_DEMO_MODE=true npx vite` in `client/` (mocks in `client/src/lib/demo.ts`; hash routes like `#/scheduler`).
- Built exe smoke test: `node build.js --windows`, copy only `release/ZomboidControlPanel.exe` to an empty folder (data dir = exe folder).
- Design checks on UI changes: `node .claude/skills/impeccable/scripts/detect.mjs --json <files>`.

## Releasing
1. Promote `## [Unreleased]` in `CHANGELOG.md` to `## [x.y.z] - date` (one-line TL;DR entries) via a PR; `release.ps1` refuses without it.
2. From a clean `main` (never another branch, never switch branches while it runs): `npm ci` in root and `client/`, then `.\release.ps1 -Version x.y.z -SkipDocker`. It commits and pushes to main and tags; CI (`release-artifacts.yml`) rebuilds and replaces the per-platform downloads.
3. If `PanelBridge.lua` changed, the script bumps the mod version; publish to the Workshop afterwards: `node scripts/workshop/publish.mjs --steam-user fpsacha --steamcmd "D:\SteamCMD\steamcmd.exe"` (cached login only; never type a password or Steam Guard code), check https://steamcommunity.com/sharedfiles/filedetails/changelog/3809901056, then commit `pz-mod/workshop/published.json`.
- A push to `main` publishes the Docker images. `main` has strict branch protection; admin merges (`gh pr merge --admin`) are used for CHANGELOG-only PRs.

## Gotchas that cost time before
- Several worktrees share git refs and the stash: **never `git stash`** in parallel work; create worktrees with `git worktree add` and junction `node_modules` and `client/node_modules` to the main checkout (remove the junctions with `rmdir` before `git worktree remove`).
- Shell quoting on Windows mangles backslashes and `\u` escapes in inline `node -e`; write scripts to a file or use the Edit tool for anything with regexes or backslashes.
- New error codes: `server/utils/errorCodes.js` plus a translation in all 10 `client/src/locales/*/errors.json` (en de fr es pt-BR uk zh-CN zh-TW ar ht). Locale JSON often has compact lines; insert by line, don't re-serialize.
- Tests using fixed fake-clock dates age out (the Trash retention is 7 days): freeze at "now".
- The Windows packaged build can fail on a pkg network error: `gh run rerun <id> --failed`. `fileManagerSftpOpenssh` / `panelBridgeSftpOpenssh` timing tests are load-sensitive.
- Process detection reads `pgrep -af`, which drops quotes: values with spaces (server names) must be matched by prefix (`scoreServerProcessOwnership`).

## Architecture pointers
- `server/index.js` wires everything; `server/services/` holds logic (`serverManager.js`, `auth.js`, `discordBot.js`, `panelBridge.js`), `server/routes/` the API, `server/utils/` helpers. Auth/SSO: `services/auth.js`, `services/oidc.js`, `routes/oidc.js` (OIDC only; no SAML).
- The data-folder rule is `server/services/zomboidDataPath.js`: strict on purpose (security), covered by `dataFolder*.test.js`.
- PanelBridge talks to the panel through files under `<Zomboid>/Lua/panelbridge/<server>/`; engine facts (events that do and don't fire on a dedicated server) are in `ARCHITECTURE.md` and the Lua header comments.
- Live-testing the mod on a real 42.21 server is possible but slow (see the maintainer's notes); fengari-based Lua tests (`server/tests/helpers/panelBridgeLua.js`) cover most logic.
