#!/usr/bin/env node
// ui-shot-tour.mjs — the standard way to look at what you just built.
//
// THE RULE THIS TOOL EXISTS TO SERVE (operator's own words): "when you build
// a new menu, take a screenshot and use impeccable to make the ui better."
// If you just shipped or changed a page, tab, or section: BUILD YOUR SCREEN,
// SHOOT IT, LOOK AT IT, FIX WHAT LOOKS WRONG, SHOOT IT AGAIN, THEN REPORT.
// That loop is the point -- everything below is just the plumbing for it.
// A rule that costs five minutes and a full-app build gets skipped because
// "this change is too small to bother." A rule that costs one command and
// ~30 seconds does not. That's why single-view mode below is the primary
// use of this script, not the full sweep -- reach for it mid-task, on the
// one screen you just built, not just as an end-of-night audit.
//
// USAGE
//   npm run ui:shot-tour                      # full sweep, every known view
//   npm run ui:shot-tour -- <name>             # ONE view -- the fast, primary path
//   npm run ui:shot-tour -- --list             # print every valid <name>
//
//   <name> is `page` or `page:tab`, matching this app's own routing/tabs --
//   e.g. `players` for the roster, `players:vitals` for the Vitals tab. Get
//   the name wrong (or leave it off with --list) and this prints the full
//   list instead of guessing -- see VIEWS below for the source of truth.
//
//   node scripts/ui-shot-tour.mjs [<name>] [--root <repoPath>] [--out <dir>] [--port <n>] [--keep-server] [--lang <code>]
//
//   --root   Repo to build/serve (must contain client/ and server/index.js).
//            Defaults to this script's own repo. Point this at a detached
//            git worktree to tour a specific commit without touching a
//            dirty working tree (`git worktree add --detach <path> <sha>`)
//            -- useful for an end-of-night full sweep when someone else's
//            change is mid-edit in the shared tree; not needed for the
//            normal single-view case of shooting your own clean checkout.
//   --out    Output directory for PNGs + manifest. Defaults to
//            <this repo>/.ui-tour/output (gitignored) -- NOT Screenshots/,
//            which is the tracked, hand-curated README gallery.
//   --port   Port for the throwaway server. Default 34917.
//   --lang   Locale code (e.g. `ar`) to force every captured page into,
//            via the same localStorage key client/src/i18n/index.ts reads
//            on boot (LANGUAGE_STORAGE_KEY = 'zcp-language'). Omit for the
//            default English sweep -- existing behavior, unaffected.
//   --keep-server   Don't kill the throwaway server on exit (debugging).
//            Spawned detached so it survives this script's own process
//            exiting, not just surviving the finally block's own
//            server.kill() call -- see spawnServer's own comment for why a
//            non-detached child dies with the parent on Windows regardless.
//            Its data dir is deliberately left on disk (the server needs
//            it); clean up both yourself when done (the script prints the
//            exact commands).
//
// WHAT THIS DOES (both modes)
//   1. Builds the client (`vite build`) against whatever repo root it's
//      pointed at (default: this script's own repo). Never `vite dev` --
//      a dev server's HMR would reload other in-flight edits mid-capture.
//   2. Spawns the REAL server (server/index.js) as a throwaway process: a
//      fresh temp data dir, a non-default port, and PANEL_NO_SUPERVISOR=1 --
//      it never touches this machine's real data/db.json or panel.lock. Its
//      demo server profile's RCON target is loopback port 1 (always closed)
//      on purpose -- see the comment in bootstrapAccount() for why that
//      specific port matters and what picking a "normal-looking" port
//      almost cost during this tool's own first run.
//   3. Creates a one-off admin account (via the real /api/auth/setup route,
//      using a per-run SETUP_TOKEN) and one demo server profile, so every
//      page renders its real authenticated content instead of a
//      login/setup screen.
//   4. Drives a real Chromium (Playwright) through the requested view(s) at
//      a desktop width and a narrow mobile width, in both themes -- one PNG
//      per view/viewport/theme combination.
//   5. Writes manifest.json + MANIFEST.md describing exactly what each file
//      shows, and tears the server + browser down.
//
// REQUIREMENTS
//   - `playwright` as a devDependency here (already added) with its
//     Chromium browser downloaded: `npx playwright install chromium`.
//   - Node with global fetch (Node 18+).
//   - Nothing else. No real Project Zomboid server, no real panel-bridge
//     mod connection, no auth setup ahead of time.
//
// A SETTLE CONDITION AND A RATE LIMITER COLLIDE (visual-sweep-2026-08-30,
// step 3) -- both are individually correct, and whoever next makes this
// tour dwell even longer per view needs to know why that can silently
// re-break the sweep. server/index.js:807 applies a real, production-
// necessary rate limit -- 300 req/min per IP, in scope for THAT file, not
// this one -- to every /api/ route, auth included. Once waitForSettle
// (below) started actually waiting for pages to finish loading instead of
// a blind fixed sleep, the run started spending more real time per view,
// which meant more of this tool's own polling/background-refresh requests
// landed inside any given rolling 60s window than before. Nothing about
// the settle condition or the limiter is wrong on its own; the combination
// crossed 300/min by the time a full sweep reached the settings tabs, worse
// on the mobile pass (runs second, inherits the first pass's window
// history). Fixed here, NOT in server/index.js -- that limiter is a
// production safety feature and out of scope to weaken for this tool's
// convenience. See paceForRateLimit below: it reads the RateLimit-Remaining
// / RateLimit-Reset headers express-rate-limit already sends
// (standardHeaders: true, draft-6) on every /api/ response and pauses for
// exactly as long as the server itself says is left, rather than a fixed
// guessed delay -- correct regardless of how many requests some future
// page or interact() step happens to fire.
//
// AN APP FEATURE COMMIT BROKE THIS TOOL'S OWN SELECTORS, AND THE BREAKAGE
// LOOKED LIKE AN APP BUG (visual-sweep-2026-08-30, quality-pass follow-up).
// This is the one worth remembering above the other two collisions in this
// header: those were this tool fighting the app's real, correct behavior
// (a production rate limit, an intentional page-enter fade); this one was
// the app and the tool actively agreeing with each other while still
// producing a wrong result. `getByRole('button', { name: X })` without
// `exact: true` is a case-insensitive SUBSTRING match. Adding a HelpTip
// (components/HelpTip.tsx) next to any control gives that control's row a
// SECOND button whose accessible name is "Help: <label>" -- and if X is (or
// is contained in) that label, the tour's locator for the REAL control now
// resolves to two elements. `.click()` on an ambiguous locator throws a
// strict-mode-violation error; every `.click(...).catch(() => {})` in this
// file (the norm here, since a missing/renamed control shouldn't take the
// whole view down) swallowed it silently. Concretely: the Kill button's row
// got a HelpTip labeled "Kill" (Players.tsx), so its trigger's accessible
// name became "Help: Kill" -- a substring match on this file's own
// `getByRole('button', { name: 'Kill' })` -- so the click that was supposed
// to open the typed-confirm dialog silently did nothing, in EVERY viewport/
// theme combo, for two full capture runs. Fixed by adding `exact: true`
// (below); audited every other `getByRole('button', ...)` name in this file
// against every HelpTip `label` in the app at the time of this fix and
// found no other collision -- but that audit is a snapshot, not a
// guarantee. THE UNDERLYING RISK IS STRUCTURAL AND STAYS: either roster
// (this file's named button/tab/option targets, or the app's HelpTip
// placements) can grow a new collision at any time. This WAS genuinely
// worth fixing, confirmed by reading killButton's own locale string
// (client/src/locales/en/players.json) rather than assumed -- but it was
// NOT the cause of the dimming/washed-out capture symptom multiple
// reviewers reported that same night: a follow-up run with this exact fix
// applied (plus the leaked-dialog and page-transition-fade fixes above,
// and 0 stray overlays / 0 not-settled in that run's own manifest) still
// showed players-notes washed out. Whatever is producing that symptom is
// still open as of this comment -- do not assume it is this file's fault
// just because the ordinal signature matches; it might not be a capture
// artifact at all. See the investigation notes in memory/hive history
// (quality-pass-2026-08-31) before proposing a fifth capture-side theory.
//
// WHAT THIS DOES NOT COVER (be honest about the gap, don't fabricate)
//   - Modal/dialog content (e.g. Scheduler's "Add Task" dialog, confirm
//     dialogs) and multi-step wizards (ServerSetup's install steps beyond
//     its landing view) are not opened. Static top-level views and the
//     tabs/sections listed in VIEWS below are covered; deep interactive
//     flows are not.
//   - Real map tile imagery on World Map: /api/map/resolve is mocked (so
//     the coordinate system and player dossier/markers work), but actual
//     tile PNGs are not faked -- there's no real tile cache, so the canvas
//     will look empty/gray under the markers. That's an honest gap, not a
//     broken feature.
//   - PanelBridge-only live data (zombie count, weather, game time, player
//     vitals, vehicle list) has no live game server to source it from, so
//     those specific endpoints are mocked with realistic canned fixtures
//     (lifted from this repo's own component tests, e.g.
//     Dashboard.zombieWorldStats.test.tsx) purely so the new UI actually
//     renders populated instead of an empty "not connected" state. Every
//     other endpoint is answered by the real server -- most pages show
//     real (if data-less) server responses, not mocks.
//   - `server-finder` is a known crash risk, not a mocked one: loading it
//     makes a real outbound Steam master-server DNS lookup + UDP query
//     (server/routes/serverFinder.js), which has thrown a synchronous,
//     uncaught exception in this environment and killed the whole
//     throwaway server process. That's a real gap in that route's own
//     error handling, unrelated to this tool and out of scope to fix here
//     -- see the comment on its VIEWS entry below. It's kept LAST in the
//     sweep so a crash there costs only that one view.
//   - Setup.tsx (the first-run "create an admin account" screen) is
//     structurally unreachable, not just unaddressed. It isn't a route --
//     App.tsx renders it as a full-screen conditional gated on `needsSetup`,
//     resolved once at boot and permanently false the instant an admin
//     account exists. bootstrapAccount() below creates that account as the
//     very first thing main() does after the server comes up, before any
//     view's interact() ever runs -- so under this script's current single-
//     shared-authenticated-session architecture, no page.goto or click
//     sequence can ever reach it again. Reaching it would need a genuinely
//     different execution mode: a separate browser context opened and
//     captured BEFORE bootstrapAccount() runs (scoped, not built, as
//     ui-tour-never-drives-interactive-state).
//
// BEFORE YOU SHIP A UI FIX (ui-tour-never-drives-interactive-state,
// 2026-08-31): this hunt found three real states -- a permission-denied
// EmptyState, a failed-load EmptyState, an RCON mid-command drop -- that
// sat unphotographed for the app's entire history, because nothing ever
// forced the question "does an existing view actually show this." Four
// checks, cheap enough to run every time:
//   1. Does an existing view already exercise the state your fix changes?
//      Open the actual PNG and look -- don't assume from the view's name.
//   2. If not, and the state needs an error/permission/failure response the
//      real server won't give you on demand: `beforeGoto` (see its own
//      comment in the capture loop) mocks a route before that view's one
//      navigation, for exactly this. Cheap to add; see the `settings:*` and
//      `console:rcon-*` views below for the pattern.
//   3. If the state is genuinely unreachable under this script's current
//      architecture (Setup.tsx is the one confirmed case so far -- see
//      above), that's a real boundary, not a missing interact() step --
//      document it here rather than silently dropping it or forcing a
//      workaround that doesn't actually capture the thing.
//   4. After adding or changing a view, RUN it (`node scripts/ui-shot-
//      tour.mjs -- <name>`) and open the PNG. A view that captures without
//      failing is not proof it captured the right thing.

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, out: null, port: 34917, keepServer: false, view: null, lang: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') out.root = path.resolve(argv[++i])
    else if (a === '--out') out.out = path.resolve(argv[++i])
    else if (a === '--port') out.port = Number(argv[++i])
    else if (a === '--keep-server') out.keepServer = true
    else if (a === '--lang') out.lang = argv[++i]
    else if (a === '--list' || a === '--help' || a === '-h') out.list = true
    else if (!a.startsWith('--')) out.view = a
  }
  if (!out.out) out.out = path.join(DEFAULT_ROOT, '.ui-tour', 'output')
  return out
}

const args = parseArgs(process.argv.slice(2))
const BASE_URL = `http://127.0.0.1:${args.port}`
const SETUP_TOKEN = `ui-tour-${Math.random().toString(16).slice(2)}`
const ADMIN_USER = 'tourop'
const ADMIN_PASS = 'UiTourPassw0rd!7'

function run(cmd, cmdArgs, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: true })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${cmdArgs.join(' ')} exited ${code}`))))
  })
}

async function waitForHealth(url, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/health`)
      if (res.ok) return true
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`Server at ${url} did not become healthy within ${timeoutMs}ms`)
}

// ---------------------------------------------------------------------------
// Rate-limit pacing -- see the header comment above ("A SETTLE CONDITION AND
// A RATE LIMITER COLLIDE") for why this exists. Reads the RateLimit-Remaining
// / RateLimit-Reset headers express-rate-limit puts on every /api/ response
// (server/index.js:807, standardHeaders: true -> draft-6) instead of
// tracking or guessing a request count ourselves -- the server already knows
// the exact true answer, so asking it beats reconstructing an estimate that
// would need updating every time a page's own request count changes.
// ---------------------------------------------------------------------------
let rateLimitRemaining = null
let rateLimitResetSeconds = null

// A view's own page.goto + interact() can fire a burst of several requests
// before this script gets to check again, so pacing on "remaining === 0"
// would still let that burst tip the server over into a real 429 mid-view.
// Stopping with headroom to spare keeps the whole burst inside the limit.
//
// 20 was NOT enough headroom -- confirmed empirically, not assumed: a run
// with this floor still produced a real 429 on settings-security (desktop/
// light) in the actual output, with no pacing wait logged in the 3 views
// immediately before it. Root cause: this check only runs once per view
// (right before its goto), but the tracked `rateLimitRemaining` only
// updates when a response actually arrives, so right after a pacing wait
// resets it to null, the next view proceeds ungated until its own first
// response lands -- and a single settings tab observed firing 3+ /api/
// calls on mount (CORS diagnostics, server list, its own tab data) is
// enough on its own to cross a thin floor mid-view. 80 leaves enough
// headroom to absorb several such views' worth of burst between checks
// rather than the single view this was tuned against.
const RATE_LIMIT_SAFE_FLOOR = 80

function trackRateLimitHeaders(response) {
  try {
    if (!response.url().includes('/api/')) return
    const headers = response.headers()
    if (headers['ratelimit-remaining'] !== undefined) rateLimitRemaining = Number(headers['ratelimit-remaining'])
    if (headers['ratelimit-reset'] !== undefined) rateLimitResetSeconds = Number(headers['ratelimit-reset'])
  } catch { /* response headers unavailable (e.g. request aborted) -- next response updates us */ }
}

async function paceForRateLimit() {
  if (rateLimitRemaining === null || rateLimitRemaining > RATE_LIMIT_SAFE_FLOOR) return
  const waitSeconds = Number.isFinite(rateLimitResetSeconds) && rateLimitResetSeconds > 0 ? rateLimitResetSeconds : 60
  const waitMs = waitSeconds * 1000 + 500 // past the server's own reported reset instant, not right up against it
  console.log(`[ui-shot-tour] pacing: only ${rateLimitRemaining} requests left in the server's rate-limit window (server/index.js's 300/min cap) -- waiting ${Math.ceil(waitMs / 1000)}s for it to reset`)
  await new Promise((r) => setTimeout(r, waitMs))
  rateLimitRemaining = null // unknown again until the next response tells us
}

async function buildClient(root) {
  const clientDir = path.join(root, 'client')
  if (!existsSync(path.join(root, 'node_modules'))) {
    console.log('[ui-shot-tour] installing root deps...')
    await run('npm', ['install', '--no-audit', '--no-fund'], root)
  }
  if (!existsSync(path.join(clientDir, 'node_modules'))) {
    console.log('[ui-shot-tour] installing client deps...')
    await run('npm', ['install', '--no-audit', '--no-fund'], clientDir)
  }
  console.log('[ui-shot-tour] building client...')
  await run('npm', ['run', 'build'], clientDir)
}

function spawnServer(root, dataRoot, port, keepServer) {
  const configPath = path.join(dataRoot, 'paths.config.json')
  writeFileSync(configPath, JSON.stringify({
    dataDir: path.join(dataRoot, 'data'),
    logsDir: path.join(dataRoot, 'logs'),
  }, null, 2))
  const env = {
    ...process.env,
    PANEL_PATHS_CONFIG_PATH: configPath,
    PORT: String(port),
    SETUP_TOKEN,
    PANEL_NO_SUPERVISOR: '1',
    NODE_ENV: 'production',
  }

  // --keep-server-outlives-parent (2026-08-31): this branch is the ONLY
  // thing --keep-server changes -- the plain (keepServer falsy) path below
  // is byte-for-byte what every existing caller already runs, so the normal
  // shoot-and-look flow three agents depend on cannot regress from this.
  //
  // Root cause (Kevin's diagnosis): a child spawned WITHOUT `detached: true`
  // is tied into the same Windows job object as this script's own process,
  // so the child dies whenever the parent's process tree is torn down --
  // Ctrl+C, a timeout, or (the actual failure mode here) whatever spawned
  // THIS script reaping its process tree once the foreground command
  // finishes -- regardless of whether anything ever calls server.kill().
  // `detached: true` breaks that association. `windowsHide: true` alongside
  // it is required on Windows or the child pops its own visible console
  // window (Node's own documented behavior for options.detached there).
  // `child.unref()` stops THIS process's event loop waiting on the child,
  // so main() can finish and exit promptly instead of hanging forever
  // "waiting" for a child that is now meant to outlive it.
  //
  // The normal path's stdio: ['ignore', 'pipe', 'pipe'] can't be reused
  // here: an active `.on('data', ...)` pipe listener is itself a handle
  // that would keep this process alive/tied to the child, defeating the
  // whole point. Redirect to real log files instead -- the server's output
  // survives parent exit and stays inspectable, which is the documented
  // purpose of --keep-server ("debugging"). Parent's own copy of the fds is
  // closed right after spawn (the child gets its own duplicated fds from
  // the OS at spawn time, so this doesn't affect its ability to keep
  // writing) purely so this soon-to-exit process doesn't hold them open
  // longer than it needs to.
  if (keepServer) {
    const stdoutLogPath = path.join(dataRoot, 'server-stdout.log')
    const stderrLogPath = path.join(dataRoot, 'server-stderr.log')
    const outFd = openSync(stdoutLogPath, 'a')
    const errFd = openSync(stderrLogPath, 'a')
    const child = spawn('node', ['server/index.js'], {
      cwd: root,
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    })
    closeSync(outFd)
    closeSync(errFd)
    child.unref()
    child.stdoutLogPath = stdoutLogPath
    child.stderrLogPath = stderrLogPath
    return child
  }

  const child = spawn('node', ['server/index.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
  return child
}

async function bootstrapAccount(dataRoot) {
  const setupRes = await fetch(`${BASE_URL}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken: SETUP_TOKEN, username: ADMIN_USER, password: ADMIN_PASS, panelPort: 34917 }),
  })
  if (!setupRes.ok) throw new Error(`Admin setup failed: ${setupRes.status} ${await setupRes.text()}`)
  const { accessToken } = await setupRes.json()

  // rconHost/rconPort MUST NOT be able to reach anything real. 27015 is
  // Project Zomboid's actual default RCON port, and on a machine that also
  // runs a real panel instance, something can genuinely be listening there
  // -- this profile's first boot will open a real TCP connection and run a
  // real (if wrong-password, fail-closed) RCON auth handshake against
  // whatever answers. Port 1 is a privileged, essentially-never-open port on
  // loopback, so this fails fast with ECONNREFUSED instead of reaching a
  // live service. installPath/zomboidDataPath point inside this run's own
  // temp dataRoot for the same reason -- never a path that could resolve to
  // something real on the host.
  const serverRes = await fetch(`${BASE_URL}/api/servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      name: 'Ashenwood', serverName: 'Ashenwood',
      installPath: path.join(dataRoot, 'pz-install'),
      zomboidDataPath: path.join(dataRoot, 'zomboid'),
      rconHost: '127.0.0.1', rconPort: 1,
      rconPassword: 'tourdemo', serverPort: 16261, minMemory: 2048, maxMemory: 4096, isActive: true,
    }),
  })
  if (!serverRes.ok) throw new Error(`Demo server creation failed: ${serverRes.status} ${await serverRes.text()}`)
}

// ---------------------------------------------------------------------------
// Fixtures for the handful of PanelBridge-only endpoints that need a live
// game server to answer for real. Shapes lifted directly from this repo's
// own component tests so they match what the UI actually expects:
//   Dashboard.zombieWorldStats.test.tsx, Events.liveWeatherReadback.test.tsx,
//   Events.timeSpeedReadback.test.tsx, Events.vehicleSirenControl.test.tsx,
//   Players.vitalsTab.test.tsx, WorldMap.dossierPlayerStats.test.tsx
// ---------------------------------------------------------------------------

const VEHICLE = { id: 7, scriptName: 'Base.PickUpVan', x: 100, y: 200, batteryCharge: 0.8, alarmed: false, sirening: false, trunkLocked: true }

const FIXTURES = {
  bridgeStatus: {
    configured: true, isRunning: true, modConnected: true,
    modStatus: { alive: true, version: '1.7.40', serverName: 'Ashenwood', playerCount: 1 },
  },
  zombieCount: { success: true, data: { zombieCount: 142, note: 'Count is for currently loaded cells only' } },
  worldStats: { success: true, data: { serverName: 'Ashenwood', map: 'Muldraugh, KY', zombiesInCell: 142 } },
  weather: {
    success: true,
    data: {
      temperature: 20, humidity: 0.5, windSpeed: 37, windAngle: 214,
      fogIntensity: 0, cloudIntensity: 0.4, precipitationIntensity: 0,
      isRaining: true, isSnowing: false, isThunderStorming: true,
      dayLight: 1, nightStrength: 0, desaturation: 0, viewDistance: 1, ambient: 1,
    },
  },
  gameTime: { success: true, data: { year: 1, month: 7, day: 9, hour: 12, minute: 30, dayOfWeek: 3, worldAgeHours: 120, moonPhase: 0.5, nightsSurvived: 5, multiplier: 10 } },
  serverInfo: { success: true, data: { players: [{ name: 'Kate', x: 10123, y: 9876, hunger: 0.62, thirst: 0.18, fatigue: 0.4 }] } },
  bridgePlayers: {
    success: true,
    data: {
      players: [{ username: 'Kate', displayName: 'Kate', x: 10123, y: 9876, z: 0, accessLevel: 'admin', isAlive: true, hunger: 0.62, thirst: 0.18, fatigue: 0.4, health: 85, isInfected: false }],
    },
  },
  playerDetails: {
    success: true,
    data: {
      x: 10123, y: 9876, z: 0, accessLevel: 'admin', isAsleep: false, isSneaking: false, isRunning: false,
      stats: { hunger: 0.62, thirst: 0.18, fatigue: 0.4, stress: 5, boredom: 0.3, unhappiness: 0.05, pain: 0, endurance: 0.8 },
      health: { overallBodyHealth: 85, isInfected: true, isBleeding: false, temperature: 37, wetness: 0.2 },
    },
  },
  players: { players: [{ name: 'Kate', online: true }] },
  mapResolve: { root: '/tiles', b42Dir: 'b42', b41Path: '/tiles/b41', tileSize: 1024, width: 1157312, height: 509520, maxLevel: 21, renderedMaxLevel: 10 },
  mapVehicles: { vehicles: [{ id: 7, x: 100, y: 200 }] },
  // ui-tour-never-drives-interactive-state (2026-08-31): SystemHealthBanner
  // (components/SystemHealthBanner.tsx) renders unconditionally above every
  // route and fetches GET /api/system/storage-health on mount, UNmocked
  // until now -- a real filesystem check against this run's own throwaway
  // dataRoot, not a canned instant response. Because this script does a
  // full page.goto per view, Layout (and this banner) remounts and
  // re-fetches on EVERY single shot, so whether that real disk check has
  // resolved by capture time was genuine, variable timing, not app state --
  // the banner's presence in any given screenshot was a coin flip
  // independent of whatever the view itself was testing. A fixed, healthy
  // payload (deriveBanner's own logic: no banner renders unless
  // circuitBreaker.open or diskSpace.saveVolume.{warning,critical}) closes
  // the race by construction, same pattern as every other endpoint already
  // mocked here.
  storageHealth: {
    diskSpace: {
      saveVolume: { path: '/data/saves', totalBytes: 500_000_000_000, freeBytes: 400_000_000_000, usedPercent: 20, warning: false, critical: false },
      panelData: { path: '/data', totalBytes: 500_000_000_000, freeBytes: 400_000_000_000, usedPercent: 20, warning: false, critical: false },
    },
    circuitBreaker: { open: false, lastError: null, failCount: 0, cooldownEndsAt: null },
  },
}

function json(body) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

// Bug-hunt-2026-08-31 ("error, validation and failure states"): the base
// fixtures above only ever answer 200. Error/permission-denied/failed-save
// states are real, reachable UI (see e.g. Users.tsx's permissionDenied vs.
// loadError EmptyState branches, both gated on ApiError.status === 403 vs.
// anything else) but were structurally invisible to every prior sweep
// because nothing ever made the server answer that way. `errorJson` builds
// a fulfill() body for exactly that: a real HTTP status + the same
// `{success:false, error}`-ish envelope handleResponse()/ApiError expect, so
// the page's own real error-handling branch (not this tool's) runs.
function errorJson(status, message) {
  return { status, contentType: 'application/json', body: JSON.stringify({ error: message }) }
}

// bug-hunt-2026-09-08 (operator screenshot, Arabic UI RTL bidi sweep):
// --lang <code> forces every page in this context to boot already reading
// as that locale, by pre-seeding the exact key client/src/i18n/index.ts
// reads on startup (LANGUAGE_STORAGE_KEY = 'zcp-language') before any of
// the app's own scripts run. addInitScript (not page.evaluate after
// goto) is required here: it re-runs on every document this context
// creates, including reloads (setTheme's own reload-per-theme included),
// so the language sticks for the whole capture run rather than reverting
// on the first navigation after it's set. No effect at all when --lang is
// omitted -- every existing caller of this tool is unaffected.
async function installLanguageOverride(context, lang) {
  if (!lang) return
  await context.addInitScript((code) => {
    try { localStorage.setItem('zcp-language', code) } catch { /* storage unavailable */ }
  }, lang)
}

async function installFixtureRoutes(context) {
  await context.route('**/api/panel-bridge/status', (route) => route.fulfill(json(FIXTURES.bridgeStatus)))
  await context.route('**/api/panel-bridge/zombies/count', (route) => route.fulfill(json(FIXTURES.zombieCount)))
  await context.route('**/api/panel-bridge/world/stats', (route) => route.fulfill(json(FIXTURES.worldStats)))
  await context.route('**/api/panel-bridge/weather', (route) => route.fulfill(json(FIXTURES.weather)))
  await context.route('**/api/panel-bridge/time', (route) => route.fulfill(json(FIXTURES.gameTime)))
  await context.route('**/api/panel-bridge/server-info', (route) => route.fulfill(json(FIXTURES.serverInfo)))
  await context.route('**/api/panel-bridge/players', (route) => route.fulfill(json(FIXTURES.bridgePlayers)))
  await context.route('**/api/panel-bridge/players/*', (route) => route.fulfill(json(FIXTURES.playerDetails)))
  await context.route('**/api/players', (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    return route.fulfill(json(FIXTURES.players))
  })
  await context.route('**/api/map/resolve', (route) => route.fulfill(json(FIXTURES.mapResolve)))
  await context.route('**/api/map/vehicles', (route) => route.fulfill(json(FIXTURES.mapVehicles)))
  await context.route('**/api/system/storage-health', (route) => route.fulfill(json(FIXTURES.storageHealth)))
  await context.route('**/api/panel-bridge/command', async (route) => {
    const req = route.request()
    let action = null
    try { action = JSON.parse(req.postData() || '{}').action } catch { /* ignore */ }
    if (action === 'getVehiclesDetailed') {
      return route.fulfill(json({ success: true, data: { vehicles: [VEHICLE] } }))
    }
    return route.fulfill(json({ success: true, data: { verified: 'confirmed' } }))
  })
}

// ---------------------------------------------------------------------------
// Views to capture. Each has a unique `name` (used in the filename), a
// `path`, and an optional `interact(page)` run once the route has loaded
// (used for in-page tabs/sections that aren't separate routes).
// ---------------------------------------------------------------------------

// View names are addressable as `page` or `page:tab`, matching this app's
// own routing/tab vocabulary rather than an invented scheme -- e.g.
// `players:vitals` for the Vitals tab on the player dossier. Run
// `npm run ui:shot-tour -- <name>` for one view, or with no name for the
// full sweep (see parseArgs/printViewList below).

const SETTINGS_TABS = ['updates', 'https', 'access', 'security', 'users', 'roles', 'sso', 'connection', 'bridge', 'mods', 'backups', 'about']

const DEBUG_TABS = [
  { value: 'worldmap', label: 'World Map' },
  { value: 'bridge', label: 'PanelBridge' },
  { value: 'performance', label: 'Performance' },
  { value: 'activity', label: 'Activity' },
  { value: 'logs', label: 'Logs' },
  { value: 'crashes', label: 'Crashes' },
  { value: 'health', label: 'Health' },
  { value: 'system', label: 'Environment' },
]

const PLAYER_DOSSIER_TABS = [
  { label: 'Moderation', slug: 'moderation' },
  { label: 'Vitals', slug: 'vitals' },
  { label: 'Spawn', slug: 'spawn' },
  { label: 'Powers', slug: 'powers' },
  { label: 'Notes & Log', slug: 'notes' },
]

// quality-pass-2026-08-31 follow-up: Debug's TabsList went flex-wrap ->
// flex-nowrap overflow-x-auto (d3ce7bc7) so a 9-tab strip scrolls instead of
// orphaning a tab off the bottom of a narrow layout -- correct,
// operator-approved app behavior, not a bug (the scroll cue is deliberately
// visible at every width for exactly this). But Playwright's own
// auto-scroll-before-click only reaches an ANCESTOR's ordinary block/
// document scroll; it does not reach a sibling still off to the side inside
// its own horizontally-overflowing container. A real user scrolls the
// strip; this tool didn't, so `debug:worldmap` (the last of 9 tabs) sat
// outside the mobile viewport, and a bare `.click()` retried ~13 times
// reporting exactly "element is outside of the viewport" before timing out.
//
// Fixed at the HELPER, not the one call site that happened to fail first:
// this tool's own `getByRole('tab', ...)` and player-roster-item clicks are
// both locators that COULD live inside a horizontally- or vertically-
// scrolling container, and the next nowrap/overflow-auto region added
// anywhere in the app (a tab strip, a roster list, a card carousel) is
// exactly this same silent failure mode waiting to happen again. Centralize
// the scroll-then-click shape once so every current and future call site
// inherits it, rather than patching `clickTabByRole` alone and leaving
// `selectFirstPlayer` (and anything written after tonight) to rediscover
// the same gap the hard way.
async function clickInView(locator, { timeout = 30000 } = {}) {
  await locator.scrollIntoViewIfNeeded().catch(() => {})
  await locator.click({ timeout })
}

async function clickTabByRole(page, name) {
  // Short timeout: a wrong/stale label should fail this one view in a few
  // seconds, not burn the default 30s per occurrence -- especially in
  // single-view mode, where that 30s is most of the "fast path" budget.
  const tab = page.getByRole('tab', { name, exact: false })
  await clickInView(tab.first(), { timeout: 5000 })
  await page.waitForTimeout(200)
}

async function selectFirstPlayer(page) {
  await clickInView(page.getByText('Kate', { exact: true }).first()).catch(() => {})
  await page.waitForTimeout(300)
}

const VIEWS = [
  { name: 'dashboard', path: '/' },
  { name: 'players', path: '/players' },
  ...PLAYER_DOSSIER_TABS.map(({ label, slug }) => ({
    name: `players:${slug}`,
    path: '/players',
    interact: async (page) => {
      await selectFirstPlayer(page)
      await clickTabByRole(page, label)
    },
  })),
  // killplayer-ui-2026-08-30: a targeted, named exception to the "modal/
  // dialog content... not opened" gap documented above -- the typed-confirm
  // dialog on Kill IS the new UI surface for that card, and there is no way
  // to eyeball a typed-input's REST/WRONG/MATCHING states other than opening
  // it. Kept as its own addressable view (not folded into `players:powers`)
  // so the base Powers-tab shot stays a plain, fast, no-side-effect capture.
  {
    name: 'players:powers-kill-confirm',
    path: '/players',
    dialogExpected: true, // see waitForSettle/dismissOpenDialogs -- this is the
    // one view in the whole sweep whose entire point is an open dialog at
    // capture time, so the generic leaked-overlay defense must not close it
    // before the shot (it still gets swept up afterward like every other
    // view's dialog would, so it can't leak forward into whatever runs next).
    interact: async (page) => {
      await selectFirstPlayer(page)
      await clickTabByRole(page, 'Powers')
      // visual-sweep-2026-08-30 quality-pass follow-up: `name: 'Kill'`
      // without `exact` is a case-insensitive SUBSTRING match, not an
      // equality check -- it silently started matching a SECOND button
      // once the Kill row grew a HelpTip (client/src/pages/Players.tsx,
      // HelpTip coverage card), because HelpTip's own trigger button's
      // aria-label is "Help: <label>" (HelpTip.tsx:38) and this row's
      // label is literally "Kill", so its tooltip trigger's accessible
      // name is "Help: Kill" -- a substring match on 'Kill'. Two matches
      // makes this locator's .click() throw a strict-mode-violation
      // error, which the .catch(() => {}) below swallowed -- so the
      // real Kill button was NEVER clicked, in EVERY viewport/theme
      // combo, and this view silently captured a plain Powers tab
      // instead of its whole reason for existing (the typed-confirm
      // dialog). `exact: true` restricts the match back to the literal
      // "Kill" button; confirmed the fix by reading killButton's own
      // locale string (client/src/locales/en/players.json), not assumed.
      // See the header comment above for why this fix, though genuine,
      // turned out NOT to explain the separate dimming symptom.
      await page.getByRole('button', { name: 'Kill', exact: true }).click({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(300)
    },
  },
  { name: 'console', path: '/console' },
  // impeccable-critique-2026-08-31: closes a coverage gap god flagged --
  // 977225e0's connected-status badge only renders once diagnostics.manage
  // is checked against the "logs" room, which only happens on this tab.
  // The base `console` view above never opens it, so that fix has had zero
  // screenshot coverage since it landed.
  {
    name: 'console:rcon',
    path: '/console',
    interact: async (page) => { await clickTabByRole(page, 'rcon console') },
  },
  // bug-hunt-2026-08-31 ("error, validation and failure states"): a server
  // that stops DURING an operation is a materially different situation from
  // one that was never reachable (this tour's own demo server profile is
  // always the latter -- see bootstrapAccount()'s own comment -- so every
  // capture ever taken of this page's disconnected banner has been the
  // "never worked" case, never the "was working, then dropped" one).
  // Console.tsx's own executeCommand() (~line 607) has a distinct code path
  // for exactly this -- a transport-level drop mid-command
  // (RCON_EXECUTE_DISCONNECTED) resets rconFailureReason to null "so the
  // banner falls back to its unreachable copy rather than showing a stale
  // auth_failed reason" -- but never checked against what that fallback
  // copy actually SAYS for this specific case. Mocks the mount-time probe
  // as a real success (rconConnected starts true, no banner) then the
  // execute call as a disconnect, so interact() drives the exact transition
  // this page has never been asked to render: connected -> mid-command drop.
  {
    name: 'console:rcon-drop-mid-session',
    path: '/console',
    beforeGoto: async (page) => {
      await page.route('**/api/config/test-rcon', (route) => route.fulfill(json({ success: true, connected: true })))
      await page.route('**/api/rcon/execute', (route) => route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Lost connection to the RCON server mid-command.', code: 'RCON_EXECUTE_DISCONNECTED' }),
      }))
    },
    interact: async (page) => {
      await clickTabByRole(page, 'rcon console')
      await page.getByPlaceholder('type a command…').fill('players')
      await page.getByRole('button', { name: 'Execute command' }).click()
      await page.waitForTimeout(600)
    },
  },
  { name: 'chat', path: '/chat' },
  { name: 'events', path: '/events' },
  {
    name: 'events:climate-trim',
    path: '/events',
    interact: async (page) => {
      // role=button, not getByText -- see the events:vehicles comment below
      // for why a plain text match on this sidebar is unreliable here.
      await page.getByRole('button', { name: 'Climate trim' }).click().catch(() => {})
      await page.waitForTimeout(400)
    },
  },
  {
    name: 'events:time-speed',
    path: '/events',
    interact: async (page) => {
      await page.getByRole('button', { name: 'Time speed' }).click().catch(() => {})
      await page.waitForTimeout(400)
    },
  },
  {
    name: 'events:severe',
    path: '/events',
    interact: async (page) => {
      await page.getByRole('button', { name: 'Severe weather' }).click().catch(() => {})
      await page.waitForTimeout(400)
    },
  },
  {
    name: 'events:horde',
    path: '/events',
    interact: async (page) => {
      await page.getByRole('button', { name: 'Spawn horde' }).click().catch(() => {})
      await page.waitForTimeout(400)
    },
  },
  {
    name: 'events:vehicles',
    path: '/events',
    interact: async (page) => {
      // A plain getByText('Bridge tools') is ambiguous and picks the WRONG
      // match: the page's own header description literally reads "Weather,
      // time, sounds, player actions, and bridge tools" and sorts first in
      // DOM order, so .first() silently clicks inert paragraph text and the
      // nav selection never changes -- no error, just the wrong (default)
      // panel in the screenshot. The real nav item is a <button>, so scope
      // to role=button to skip the false match entirely.
      await page.getByRole('button', { name: 'Bridge tools' }).click().catch(() => {})
      await page.waitForTimeout(300)
      // This is a Radix Select (a button with role="combobox" plus a
      // separate popover listbox), not a native <select> -- selectOption()
      // only works on a real <select> element and just hangs here waiting
      // for one that doesn't exist. Drive it the way a real user would:
      // open the trigger, then click the option by its rendered label.
      const trigger = page.getByRole('combobox', { name: 'Select operation' })
      if (await trigger.count()) {
        await trigger.click().catch(() => {})
        await page.getByRole('option', { name: 'List Vehicles', exact: false }).click().catch(() => {})
        await page.waitForTimeout(200)
        await page.getByRole('button', { name: 'Run Operation' }).click().catch(() => {})
        await page.waitForTimeout(500)
      }
    },
  },
  { name: 'world-map', path: '/world-map' },
  {
    name: 'world-map:dossier',
    path: '/world-map',
    interact: async (page) => {
      await page.waitForTimeout(500)
      const panButton = page.getByRole('button', { name: /pan to kate/i })
      if (await panButton.count()) {
        await panButton.first().click().catch(() => {})
        await page.waitForTimeout(400)
      }
    },
  },
  { name: 'server-config', path: '/server-config' },
  { name: 'mods', path: '/mods' },
  { name: 'templates', path: '/templates' },
  { name: 'scheduler', path: '/scheduler' },
  // timezone-picker-searchable-2026-08-31: the Scheduler Timezone card's
  // free-text field became a searchable combobox (client/src/pages/
  // Scheduler.tsx's TimezonePicker) -- the base `scheduler` view above only
  // ever shows it closed, identical to the old plain <Input>. This is the
  // one state that's actually new: focus opens the full grouped dropdown.
  {
    name: 'scheduler:timezone-open',
    path: '/scheduler',
    dialogExpected: true, // not a real dialog, but same reason: the open
    // dropdown IS this view's entire point, so it must survive whatever
    // leaked-overlay defense would otherwise close a stray open panel
    // before the shot (see players:powers-kill-confirm's own comment).
    interact: async (page) => {
      await page.getByLabel('IANA timezone name').click()
      await page.waitForTimeout(200)
    },
  },
  { name: 'backups', path: '/backups' },
  { name: 'chunks', path: '/chunks' },
  { name: 'servers', path: '/servers' },
  // remote-bridge-discoverability-2026-08-30: the Add Remote Server dialog's
  // RCON-only banner used to claim weather/events worked over plain RCON --
  // they don't, PanelBridge needs the SFTP bridge configured first. Kept
  // addressable so the corrected copy (and any future wording pass on it)
  // stays easy to eyeball without adding a real remote server end to end.
  {
    name: 'servers:add-remote',
    path: '/servers',
    // impeccable-critique-2026-08-31: missing dialogExpected meant the
    // generic leaked-overlay defense (dismissOpenDialogs, see its own
    // header) closed this dialog right before the shot every single time --
    // interact() opened it correctly, but the capture always showed the
    // plain Servers list underneath. Same fix as players:powers-kill-confirm
    // above: this view's entire point is an open dialog at capture time.
    dialogExpected: true,
    interact: async (page) => {
      await page.getByRole('button', { name: 'Add Remote Server' }).first().click()
      await page.waitForTimeout(300)
    },
  },
  // Confirms "Configure SFTP Bridge" (Servers.tsx ~1957, gated on
  // server.isRemote) actually renders on a freshly-added remote server's own
  // card -- the affordance the corrected banner above now points to. Fake
  // RCON details are fine here: Add Server only requires
  // name/rconHost/rconPassword to be present, not a successful Test
  // Connection, and this throwaway server has no real RCON target anyway.
  {
    name: 'servers:remote-card',
    path: '/servers',
    interact: async (page) => {
      await page.getByRole('button', { name: 'Add Remote Server' }).first().click()
      const dialog = page.getByRole('dialog')
      await dialog.getByPlaceholder('My Remote PZ Server').fill('Tour Remote Server')
      await dialog.getByPlaceholder('192.168.1.100 or myserver.com').fill('192.168.1.50')
      await dialog.getByPlaceholder("Enter the RCON password set in the server's INI file").fill('tourdemo')
      await dialog.getByRole('button', { name: 'Add Server', exact: true }).click()
      await page.waitForTimeout(3000)
    },
  },
  // impeccable-critique-2026-08-31: closes a coverage gap god flagged --
  // 0f1d6bbf's duplicate-detection-on-Edit fix (Servers.tsx ~1162) has had
  // zero screenshot coverage since it landed; nothing in the sweep opens
  // the Edit dialog, let alone drives it into the blocked-save state. The
  // check returns before closing the dialog or clearing savingEdit (see its
  // own comment), so the dialog + destructive toast are still on screen
  // when this view's interact() returns -- dialogExpected covers both.
  {
    name: 'servers:duplicate-edit',
    path: '/servers',
    dialogExpected: true,
    interact: async (page) => {
      // Idempotent across this run's own per-theme/viewport reloads: server
      // list state persists server-side across a page.goto reload (only the
      // client remounts), so a server this already created on an earlier
      // shot in the same sweep must be skipped, not re-added into a
      // duplicate-of-itself the Add dialog's own check would then reject.
      const addRemoteIfMissing = async (name, host) => {
        if (await page.getByText(name, { exact: true }).count()) return
        await page.getByRole('button', { name: 'Add Remote Server' }).first().click()
        const dialog = page.getByRole('dialog')
        await dialog.getByPlaceholder('My Remote PZ Server').fill(name)
        await dialog.getByPlaceholder('192.168.1.100 or myserver.com').fill(host)
        await dialog.getByPlaceholder("Enter the RCON password set in the server's INI file").fill('tourdemo')
        await dialog.getByRole('button', { name: 'Add Server', exact: true }).click()
        await page.waitForTimeout(1500)
      }
      await addRemoteIfMissing('Duplicate Check A', '192.168.1.60')
      await addRemoteIfMissing('Duplicate Check B', '192.168.1.61')
      await page.getByRole('button', { name: 'Options for Duplicate Check B' }).click()
      await page.getByRole('menuitem', { name: 'Edit' }).click()
      const editDialog = page.getByRole('dialog')
      // No id/placeholder on these fields (getByDisplayValue is a Testing
      // Library API, not Playwright's -- doesn't exist here) -- located by
      // the sibling <Label> text each Input sits directly under instead.
      // Default RCON port is the same (27015) for every server this dialog
      // adds, so matching name + host alone reproduces the collision --
      // port doesn't need touching. The blocked save (see its own comment
      // in Servers.tsx) never persists the rename, so re-opening Edit on a
      // later pass starts from "Duplicate Check B" again -- also idempotent.
      await editDialog.locator('div:has(> label:has-text("Display Name")) input').fill('Duplicate Check A')
      await editDialog.locator('div:has(> label:has-text("RCON host")) input').fill('192.168.1.60')
      await editDialog.getByRole('button', { name: 'Save Changes' }).click()
      await page.waitForTimeout(400)
    },
  },
  // bug-hunt-2026-08-31 ("error, validation and failure states"): the real
  // client-side required-field validation on this dialog (Servers.tsx
  // handleAddExistingServer, ~line 1396, toasts.serverNameRequired etc.) has
  // never been photographed -- every existing servers: view fills every
  // field before submitting. Submitting fully blank was the first attempt
  // here and it FAILED this tool's own click (Playwright timed out retrying
  // -- "element is not enabled"): the submit button's own `disabled` prop
  // (Servers.tsx ~2557) already blocks the click on a truthy check
  // (`!newServer.name`) for the exact same three fields the handler's own
  // toasts guard, so a fully-blank submit can never reach the handler at
  // all -- that toast path is unreachable from an empty dialog, whatever
  // the handler's own code implies. The one gap between the two checks:
  // `disabled` only tests truthiness (a single space is truthy, button
  // stays enabled) while the handler's own checks call `.trim()` first
  // (a single space fails that). A whitespace-only value is the ONLY way a
  // real user reaches this toast -- so that's what this view now types,
  // rather than leaving the fields empty.
  {
    name: 'servers:add-remote-invalid',
    path: '/servers',
    dialogExpected: true,
    interact: async (page) => {
      await page.getByRole('button', { name: 'Add Remote Server' }).first().click()
      const dialog = page.getByRole('dialog')
      await dialog.getByPlaceholder('My Remote PZ Server').fill(' ')
      await dialog.getByPlaceholder('192.168.1.100 or myserver.com').fill(' ')
      await dialog.getByPlaceholder("Enter the RCON password set in the server's INI file").fill(' ')
      await dialog.getByRole('button', { name: 'Add Server', exact: true }).click()
      await page.waitForTimeout(400)
    },
  },
  { name: 'server-setup', path: '/server-setup' },
  { name: 'discord', path: '/discord' },
  { name: 'settings', path: '/settings' },
  ...SETTINGS_TABS.map((tab) => ({ name: `settings:${tab}`, path: `/settings?tab=${tab}` })),
  // bug-hunt-2026-08-31 ("error, validation and failure states"): the base
  // fixture's bridgeStatus (installFixtureRoutes) always answers
  // isRunning:true -- so Settings.tsx's own "Not running - setup flow"
  // block (~line 3859, gated on `!bridgeStatus?.isRunning`) has never been
  // exercised by any sweep, ever. It's a real, substantial branch: an Auto
  // Setup button, a manual bridge-path input, and a numbered getting-
  // started list for a local server -- never photographed. Overrides the
  // real route for this one view's one navigation only (see beforeGoto's
  // own comment above).
  {
    name: 'settings:bridge-not-running',
    path: '/settings?tab=bridge',
    beforeGoto: async (page) => {
      await page.route('**/api/panel-bridge/status', (route) => route.fulfill(json({ configured: false, isRunning: false, modConnected: false })))
    },
  },
  // bug-hunt-2026-08-31 ("error, validation and failure states"): a FAILED
  // SAVE, not just a failed load -- distinct state, never captured. Mocks
  // PUT /api/config/app-settings to fail with a real, uncoded 5xx (no
  // `code` field) so this exercises the exact getUserErrorMessage() ->
  // wrapUncodedServerError() path fixed this pass (365a18ee), this time in
  // its actual toast context rather than an EmptyState -- proof the fix
  // generalizes past the one branch it was found in. Toggles a plain
  // boolean switch (no client-side validation to fight) to make the page
  // dirty, then clicks the header Save button.
  {
    name: 'settings:save-failed',
    // 'Enable public IP lookup' lives in the Access tab's TabsContent
    // (Settings.tsx:2526-2789), not General's (2400-2526) -- both were
    // swept by one grep range on the first pass, which is what pointed
    // this view at the wrong tab initially (verified the hard way: this
    // tool's own click failed the exact same way on all 4 shots, not the
    // usual mixed contention-timeout signature, which is what said "wrong
    // element, not a slow machine" and sent me back to re-check the tab
    // boundary rather than retrying).
    path: '/settings?tab=access',
    beforeGoto: async (page) => {
      await page.route('**/api/config/app-settings', (route) => {
        if (route.request().method() !== 'PUT') return route.continue()
        return route.fulfill(errorJson(500, 'Disk write failed'))
      })
    },
    interact: async (page) => {
      await page.getByRole('switch', { name: 'Enable public IP lookup' }).click()
      await page.getByRole('button', { name: 'Save Settings' }).click()
      await page.waitForTimeout(500)
    },
  },
  // bug-hunt-2026-08-31 ("error, validation and failure states"): Users.tsx
  // (rendered embedded on this tab) has two distinct, real, never-
  // photographed empty states -- permissionDenied (ApiError.status===403)
  // and loadError (anything else) -- both gated on GET /api/auth/users'
  // outcome at mount time (Users.tsx fetchAll(), same real precedent as
  // RolesPermissions.tsx and OidcSettings.tsx: check the actual status the
  // server sent, not a client-side capability guess). Neither branch has
  // ever been exercised by any sweep because the fixture route always
  // answers 200. beforeGoto overrides the real route for this ONE view's
  // ONE navigation (see its own comment in the capture loop above) so
  // Users.tsx's own real error-handling code runs, not this tool's.
  {
    name: 'settings:users-denied',
    path: '/settings?tab=users',
    beforeGoto: async (page) => {
      await page.route('**/api/auth/users', (route) => route.fulfill(errorJson(403, 'Missing required permission: users.manage')))
    },
  },
  {
    name: 'settings:users-load-error',
    path: '/settings?tab=users',
    beforeGoto: async (page) => {
      await page.route('**/api/auth/users', (route) => route.fulfill(errorJson(500, 'Internal server error')))
    },
  },
  // impeccable-critique-2026-08-31: closes a coverage gap god flagged --
  // 76ef3753's About-tab "Up to date" status badge only renders once
  // panelUpdateStatus.latestVersion is populated, and nothing populates it
  // except clicking Check for Updates. This script full-navigates per view
  // (see the shell-async-race card), so no other view's fetch can leave
  // that state behind for this one to inherit -- it has to be driven here.
  // Loads on the Updates tab (where the button lives), clicks it, then
  // switches to About via a plain tab click (client-side, no navigation,
  // so the just-fetched state survives) rather than a second page.goto.
  {
    name: 'settings:about-checked',
    path: '/settings?tab=updates',
    interact: async (page) => {
      await page.getByRole('button', { name: 'Check for Updates' }).click()
      await page.waitForFunction(
        () => !document.body.innerText.includes('Checking...'),
        { timeout: 8000 },
      ).catch(() => {})
      await clickTabByRole(page, 'About')
    },
  },
  { name: 'debug', path: '/debug' },
  ...DEBUG_TABS.map(({ value, label }) => ({
    name: `debug:${value}`,
    path: '/debug',
    interact: async (page) => { await clickTabByRole(page, label) },
  })),
  // EXCLUDED from the default full sweep -- see `unstable` below.
  { name: 'server-finder', path: '/server-finder', unstable: true },
]

// server-finder makes a real outbound Steam master-server DNS lookup + UDP
// query (server/routes/serverFinder.js queryMasterServer()). Confirmed the
// hard way, TWICE, that this can throw a synchronous, uncaught exception
// from inside socket.send() (observed: "RangeError [ERR_SOCKET_BAD_PORT]")
// that Node treats as fatal and kills the WHOLE throwaway server process --
// not intermittently rare either: it survived one call in testing and
// crashed on the very next one a few seconds later, taking every
// remaining view in the sweep down with it (92 of 184 lost in one run).
// That looks like a real gap in serverFinder.js's own error handling (a
// synchronous throw from a dgram callback escapes both its Promise
// executor and its 'error' listener) -- independent of this tool, and out
// of scope to fix here. Rather than gamble the whole baseline on it,
// `unstable` views are skipped by the default (no-argument) full sweep;
// capture one deliberately with `npm run ui:shot-tour -- server-finder`
// (single-view mode also isolates the blast radius to that one run).
// ui-tour-never-drives-interactive-state (2026-08-31): Setup.tsx is
// structurally unreachable through the normal VIEWS loop below -- it
// isn't a route, and needsSetup resolves permanently false the instant
// bootstrapAccount() creates the admin account, which happens before any
// VIEWS entry's interact() ever gets a chance (see the header's WHAT THIS
// DOES NOT COVER section for the full story). Captured instead through a
// separate, throwaway browser context opened and closed BEFORE
// bootstrapAccount() runs (see capturePreAuthViews below).
//
// Two views, not three -- decided and endorsed 2026-08-31. A third,
// tempting candidate (the post-submit `errors.invalidPort` text) was
// considered and dropped: 6d514160 added `!panelPortValid` to the Submit
// button's own `disabled` expression, so an out-of-range port disables the
// button before handleSubmit -- and therefore that error text -- can ever
// run. Same shape as the Add Remote Server blank-submit toast found
// earlier this hunt: the validation TEXT is unreachable by construction,
// but the DISABLED BUTTON next to an otherwise-fully-valid form is real,
// reachable, and had zero coverage since 6d514160 shipped -- that's what
// setup:invalid-port captures.
const PRE_AUTH_VIEWS = [
  { name: 'setup', path: '/' },
  {
    name: 'setup:invalid-port',
    path: '/',
    interact: async (page) => {
      await page.locator('#setupToken').fill('tour-setup-token')
      await page.locator('#username').fill('admin')
      await page.locator('#panelPort').fill('80')
      await page.locator('#password').fill('ValidPassw0rd!7')
      await page.locator('#confirmPassword').fill('ValidPassw0rd!7')
    },
  },
]

const VIEW_NAMES = [...VIEWS, ...PRE_AUTH_VIEWS].map((v) => v.name)
const SWEEP_VIEWS = VIEWS.filter((v) => !v.unstable)

function printViewList() {
  console.log('Valid view names (use `page` for the top-level view, `page:tab` for a specific tab):\n')
  console.log(VIEW_NAMES.map((n) => `  ${n}`).join('\n'))
  console.log(`\nUsage:\n  npm run ui:shot-tour                 # capture every view above\n  npm run ui:shot-tour -- <name>       # capture just one, e.g. players:vitals`)
}

const VIEWPORTS = [
  { key: 'desktop', width: 1440, height: 900 },
  { key: 'mobile', width: 390, height: 844 },
]
const THEMES = ['survival', 'light']

// bug-hunt-2026-09-08 (--lang support): a bare chromium.launch() crashed the
// renderer ("Page crashed" / "Target crashed", not a timeout -- confirmed
// intermittent across three otherwise-identical runs, so this is not a
// --lang-specific bug) on this run's own execution environment. --no-sandbox
// + --disable-dev-shm-usage + --disable-gpu is the standard, well-precedented
// fix for exactly this crash class in a constrained/headless/CI-shaped
// environment, and costs nothing for a normal desktop run -- this launches a
// throwaway browser against a throwaway localhost server with no untrusted
// content, so the isolation --no-sandbox gives up is not protecting anything
// here anyway.
const CHROMIUM_LAUNCH_OPTIONS = { args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] }

async function login(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await page.getByLabel(/username/i).fill(ADMIN_USER).catch(async () => {
    await page.locator('input[name="username"], input#username').first().fill(ADMIN_USER)
  })
  await page.getByLabel(/password/i).fill(ADMIN_PASS).catch(async () => {
    await page.locator('input[name="password"], input#password, input[type="password"]').first().fill(ADMIN_PASS)
  })
  // bug-hunt-2026-09-08 (--lang support): the English-name role match below
  // has no fallback, unlike the two fields above -- under --lang ar this
  // button's accessible name is the Arabic translation of "Sign In", so the
  // match (and the whole capture run) timed out here, first confirmed the
  // hard way. Login.tsx's login form (`id="login-form"`) has exactly one
  // `button[type="submit"]` (its sibling reset-password form has its own,
  // never both mounted at once -- confirmed by reading the file, resetMode
  // ? (...) : (...) are mutually exclusive branches) -- a stable,
  // locale-independent fallback, same shape as the two fields above.
  await page.getByRole('button', { name: /sign in|log in|login/i }).click().catch(async () => {
    await page.locator('#login-form button[type="submit"]').click()
  })
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(500)
}

// wired-no-ui-2026-08-30 mobile-shot follow-up: page.screenshot({fullPage:
// true}) only expands to the OUTER page's own document bounds -- it has no
// way to know a page's real scrolling happens inside a nested overflow:auto
// element instead. This app's shell (client/src/components/Layout.tsx) puts
// EVERY page's content inside a single `<main id="main-content"
// class="... overflow-auto ...">`, and that element -- not <body> or
// <html> -- is the actual scroll container on every route. The tell, if you
// hit this again on some other app: document.body.scrollHeight equals
// window.innerHeight (the document itself never scrolls) while some
// descendant's own scrollHeight is much larger than its clientHeight.
// Confirmed the hard way on events:climate-trim at 390x844: the selected
// panel's own heading was already in the DOM at getBoundingClientRect().
// top=1164 -- past the fold -- before touching anything; setting
// mainEl.scrollTop = mainEl.scrollHeight (what a real scroll gesture does)
// moved it to top=147, fully visible, with the real content ("fog") now in
// document.body.innerText. The panel was never missing -- fullPage just
// never scrolled the container that actually holds it, on EVERY view this
// tool has ever captured on mobile, not just Events.
//
// Fix: immediately before the screenshot, override #main-content's overflow
// and height with inline styles so its content flows naturally into the
// page instead of scrolling inside its own box -- the outer document then
// grows to include all of it, which is exactly what fullPage needs. Restore
// the original inline style right after so the live page (and the next
// interact() step, if any) is untouched. Harmless when the container
// doesn't overflow: same content, same layout, just no scrollbar for an
// instant. Applied to every capture (both viewports), not just mobile --
// desktop pages fit today, but there's no guarantee that stays true, and
// this costs nothing when there's nothing to expand.
//
// mobile-full-pass-2026-08-30 follow-up -- the fix above has a WIDTH side
// effect that produced a false-positive "renders at desktop width" on every
// settings:* view, including settings:about, which has no fixed-width
// content of its own. #main-content is `flex-1` inside Layout.tsx's flex
// shell; with its normal `overflow-auto`, any value other than 'visible' on
// overflow-x/overflow-y resets that axis's *automatic minimum size* to 0,
// which is what lets a flex item shrink below its content's intrinsic
// (min-content) width in the first place. Flipping the whole `overflow`
// shorthand to 'visible' resets BOTH axes' automatic minimum size back to
// content-based -- so if any view has a horizontally-scrolling descendant
// with its own (perfectly correct) `overflow-x-auto` -- Settings' tab strip,
// 13 buttons wide, ~1280px unwrapped -- #main-content's own automatic
// min-width becomes that descendant's full min-content width, and the flex
// layout genuinely grows the box to 1280px. That's not a paint artifact:
// scrollWidth/clientWidth on #main-content itself become 1280 the instant
// this runs, so fullPage faithfully (and wrongly) captures a 1280px-wide
// mobile screenshot for a page a real 390px-viewport user never sees wider
// than 390px.
//
// The obvious-looking fix -- set only `overflow-y: visible`, leave
// overflow-x untouched -- does NOT work; verified empirically, not assumed.
// Per the CSS Overflow spec, if overflow-x and overflow-y disagree and
// exactly one of them is 'visible', the 'visible' one is *computed as
// 'auto'* instead. So `overflow-y: visible` next to an unset overflow-x
// (still 'auto' from the Tailwind class) silently becomes `overflow-y:
// auto` -- no different from doing nothing -- and the original vertical
// truncation comes right back (confirmed: docScrollHeight stayed pinned to
// the viewport height instead of growing to the real content height).
//
// What actually works: capture #main-content's current (correct, clipped)
// width BEFORE touching overflow, then pin it back with an explicit inline
// `width` at the same time overflow flips to 'visible'. An explicit width
// overrides the flex algorithm's content-based sizing outright, so the box
// can no longer grow to fit a wide descendant's min-content -- while height
// is still `auto`/`max-height: none` with overflow fully 'visible', so
// vertical content still flows out into the document exactly as before.
// Verified on both known repro cases: events:climate-trim (390x844) still
// reveals its full height (844 -> 1861), and settings:mods no longer
// balloons in either dimension (stays 390 wide; height now correctly
// reflects true 390px-wide wrapping -- 3236, MORE accurate than the old
// buggy capture's 2546, which undercounted height too because reflowing
// text into a false 1280px-wide box also shortens it).
// quality-pass-2026-08-31 round 3: expanding only #main-content itself left
// an adjacent, structurally identical gap one level deeper -- the same
// shape of miss as the two animation fixes right above this function (each
// closed one specific scope/timing gap while a sibling gap of the same
// class survived). Confirmed on chunks__desktop__survival.png: ChunkCleaner
// .tsx's "canvas" Card has its own fixed Tailwind height (`h-[24rem]
// min-h-[320px] sm:h-[30rem] lg:h-[36rem]` -- 36rem/576px at desktop width)
// wrapping an inner `h-full overflow-y-auto` content div for the "no saves
// found" panel. #main-content's own overflow/height were already
// 'visible'/'auto' -- nothing left to fix there -- but fullPage:true only
// ever grows the OUTER document; it has no way to reach into a nested
// element that is ITSELF still clipping its own content via a real
// scrollbar. Survival theme's real "no saves found" copy is long enough
// (an extra "TRY A COMMON LOCATION" section the shorter remote-disabled
// message in light theme never shows) to overflow that fixed-height Card,
// so it got clipped at exactly 576px + padding, not the 900px viewport --
// coincidentally close enough to the viewport height in this one case that
// the truncation read as "hit the viewport edge" until measured.
//
// Generalized rather than special-cased to this one Card: walk every
// descendant of #main-content and expand ANY element that is currently
// clipping its own content (scrollHeight meaningfully taller than
// clientHeight) the same way #main-content itself is expanded, marking
// each one via a data attribute so restoreMainAfterCapture can revert
// exactly the set this run actually touched. Trade-off, accepted
// deliberately: a page with a live, intentionally-bounded scroll region
// (a console/log panel, a long activity table) will now render its FULL
// content in the capture instead of a clipped viewport-sized window onto
// it. For a tool whose entire purpose is a human quality-review screenshot,
// showing more real content is strictly better than silently clipping some
// of it -- which is the exact failure mode this whole function exists to
// close, not a new one to reintroduce by special-casing only the one Card
// that happened to get caught this time.
async function expandMainForCapture(page) {
  await page.evaluate(() => {
    const expand = (el) => {
      if (el.hasAttribute('data-tour-expanded')) return // already handled, e.g. as another clipping element's ancestor
      if (el.hasAttribute('style')) el.setAttribute('data-tour-prev-style', el.getAttribute('style'))
      else el.setAttribute('data-tour-no-prev-style', '1')
      const width = el.getBoundingClientRect().width
      el.style.setProperty('width', `${width}px`, 'important')
      el.style.setProperty('overflow', 'visible', 'important')
      el.style.setProperty('height', 'auto', 'important')
      el.style.setProperty('max-height', 'none', 'important')
      el.setAttribute('data-tour-expanded', '1')
    }
    const root = document.getElementById('main-content')
    if (!root) return
    expand(root)
    for (const el of root.querySelectorAll('*')) {
      if (el.scrollHeight > el.clientHeight + 2) {
        // tour-expandmainforcapture-defeats-intentional-clamping
        // (2026-08-31): `-webkit-line-clamp` truncation IS overflow:hidden-
        // based (Tailwind's `.line-clamp-N` emits `display:-webkit-box;
        // -webkit-box-orient:vertical; -webkit-line-clamp:N;
        // overflow:hidden` -- confirmed against the real compiled CSS, see
        // Players.tsx's own comment on this exact defect), so a clamped
        // element trips this SAME scrollHeight>clientHeight check by
        // design every time there's more text than N lines allow -- the
        // "overflow" here is the intentionally-cut text, not clipped-but-
        // wanted content this function exists to reveal. Forcing
        // overflow:visible on it un-clips the truncation entirely and
        // shows the full, un-cut string no real user or browser ever
        // renders -- which is not merely a missed check, it ACTIVELY
        // produces a false finding (text appearing to spill/overlap into
        // the next element) that already cost real, correct copy in six
        // languages before it was traced back to this function and
        // reverted. Skip: an element that is itself actively line-
        // clamping is never a candidate to unclip, no matter how far its
        // scrollHeight exceeds its clientHeight -- that gap is the
        // feature, not a gap in the capture.
        if (getComputedStyle(el).webkitLineClamp !== 'none') continue
        // Expand the clipping element AND every ancestor up to
        // #main-content, not just the element itself: found by direct code
        // reading after the desktop fix alone produced a NEW mobile defect
        // one level up -- ChunkCleaner's "no saves found" panel sits inside
        // `<div class="h-full overflow-y-auto">` (the clipping element, now
        // correctly unclipped) which itself sits inside a `<Card
        // class="... h-[24rem] ... lg:h-[36rem]">` (a plain, non-scrolling,
        // explicit-height wrapper -- its own scrollHeight already equals its
        // clientHeight, so it never trips the check above on its own).
        // Expanding only the inner div left the Card's box unchanged; the
        // div's newly-tall content then overflowed OUT of that still-fixed
        // box instead of growing it, visually bleeding into the sibling
        // "Save" panel below it in normal flow -- confirmed by reasoning
        // through the CSS (Card's own height stays an explicit Tailwind
        // class untouched by any inline style), not observed live, because
        // this exact repro state could not be reproduced twice in a row
        // under tonight's shared-machine load (see the fix's own commit
        // message for the honest caveat). Walking every ancestor up to
        // #main-content closes this the same way #main-content's own
        // expansion already does for the outermost case.
        for (let node = el; node && node !== root.parentElement; node = node.parentElement) {
          expand(node)
        }
      }
    }
  })
}

async function restoreMainAfterCapture(page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-tour-expanded]')) {
      if (el.hasAttribute('data-tour-no-prev-style')) el.removeAttribute('style')
      else el.setAttribute('style', el.getAttribute('data-tour-prev-style'))
      el.removeAttribute('data-tour-expanded')
      el.removeAttribute('data-tour-prev-style')
      el.removeAttribute('data-tour-no-prev-style')
    }
  })
}

// The manifest's own `settled`/`strayOverlay` flags say whether the PAGE
// was ready -- neither has ever recorded whether the CAPTURE itself came
// out complete. chunks__desktop__survival.png shipped with settled:true,
// no stray overlay, and was still truncated: a manifest schema with no
// field for "did the screenshot's actual height match what the page really
// needed" cannot fail on that defect class by construction, no matter how
// correct the settle/overlay checks are. Reads the PNG's real pixel height
// straight from its IHDR chunk (bytes 16-20, big-endian -- same
// browser-free technique used to diagnose this exact bug by hand before
// this fix existed) and compares it against the page's own
// document.documentElement.scrollHeight at the moment of capture, so a
// future regression of this class -- in ANY view, not just the one caught
// this time -- shows up as a named, greppable manifest flag instead of a
// silent gap someone has to notice by eye again.
function readPngHeight(filePath) {
  const buf = readFileSync(filePath)
  return buf.readUInt32BE(20)
}

// quality-pass-2026-08-31: expandMainForCapture's own forced overflow/
// height/width change on #main-content -- the very style mutation the
// function above exists to make -- re-triggers the `.page-transition`
// wrapper's `pageEnter` keyframe (index.css, 0.3s opacity 0->1) on every
// single view, every single time, confirmed by dumping getAnimations() and
// per-element computed opacity in a standalone harness DURING the mutation
// window: opacity read 0.49-0.56 with pageEnter `playState: "running"`
// right after expandMainForCapture ran, despite that same element reading
// opacity ~1 (animation absent) one line earlier. waitForSettle's own
// animation check (below) cannot catch this -- it runs BEFORE
// expandMainForCapture, so it settles on a page that hasn't been mutated
// yet and has no way to see an animation this function is about to cause.
// This produced the washed-out/dimmed captures four separate agents
// reported across three different lanes (players, events, discord) over
// several hours tonight, each read as a leaked dialog, then a leaked
// overlay, then eventually (wrongly, if persuasively) as a bug that
// "starts at some ordinal capture position and never recovers" -- a
// measured re-test (same standalone harness) found the SAME dip magnitude
// at every view including the first, meaning the clean-early/dim-later
// split reviewers saw was just where each shot happened to land inside the
// 300ms re-triggered fade, not a state that starts and persists.
//
// Fix, and why it isn't a wait: an early attempt waited for
// `.page-transition`'s OWN getAnimations() to go quiet (the same pattern
// waitForSettle already uses), positioned after expandMainForCapture
// instead of before. That fixed 4 of 6 views tested (players, moderation,
// vitals, spawn) but NOT Powers or Notes & Log -- both still captured
// dimmed even after the wait reported clean. Root cause of THAT: Powers
// and Notes each stagger their row elements in with their OWN separate
// `springFadeIn` animation per row (3 of them), and `el.getAnimations()`
// only returns animations targeting THAT element, not its descendants --
// so a `.page-transition`-scoped wait can correctly report "my own
// animation is done" while 3 child rows are still mid-fade underneath it.
// Waiting for the right thing in the wrong scope reports clean forever, so
// this doesn't wait at all: it forces every non-infinite animation on the
// page to its end state via the Web Animations API's own `.finish()`
// (document.getAnimations(), not scoped to one element), right before the
// shot. Infinite/looping ones (compressHeader, brand-led-pulse, the
// connection-status `pulse` dot) throw on `.finish()` since they have no
// natural end state -- expected, caught per-animation, left running; they
// were never the problem (a permanently-running decorative pulse doesn't
// dim a screenshot, an animation caught mid-fade does). Deterministic
// regardless of how many elements are affected or when they were
// triggered, unlike a wait that has to correctly enumerate every affected
// element up front.
async function finishRunningAnimations(page) {
  await page
    .evaluate(() => {
      for (const a of document.getAnimations()) {
        try { a.finish() } catch { /* infinite/looping animation -- no end state, leave it running */ }
      }
    })
    .catch(() => {})
}

// visual-sweep-2026-08-30 follow-up: the tour used to capture after a fixed
// wait with no idea whether the page had actually finished loading. That
// missed a real failure mode -- a page that fires SEVERAL parallel mount
// fetches can be briefly interactive-looking between two of them (one
// spinner has already unmounted, the next hasn't mounted yet), so even a
// generous fixed sleep can land in that gap and capture something that
// LOOKS settled but isn't. Confirmed the hard way on this exact bug:
// Scheduler.tsx fires five API calls on mount and came out as a bare
// spinner in all four viewport/theme combos, which every reviewer
// (correctly) read as "identical across combos = not a timing race" --
// backwards. A fixed sleep against a fixed fetch produces the same wrong
// result every time; reproducibility distinguishes a race from a flake, not
// a bug from a too-short wait. god verified Scheduler.tsx:226 and
// Templates.tsx:48 both clear their loading flag from a `finally` (runs on
// success AND failure) and that a real failure path renders a distinct
// error alert -- absent from the shots -- before asking for this fix, so
// the pages themselves were never in question, only this script's timing.
//
// Three independent signals (a third, the page-enter CSS fade, was added
// after the first two shipped -- see its own inline comment below), chosen
// from what's ALREADY a real, load-bearing convention in this codebase
// rather than invented for this script:
//   - `[aria-busy="true"]` -- PageSkeleton (components/PageSkeleton.tsx)
//     puts this on its wrapping element for every one of its variants
//     (dashboard/list/form/console/map/default), and it's what a whole-page
//     initial-load skeleton looks like across this app.
//   - `.animate-spin` -- the Loader2/RefreshCw spinner icon used for every
//     in-flight async action this script's own grep could find (initial
//     loads, saves, refreshes, restores). Verified this actually matches
//     Scheduler's own spinner (`<Loader2 className="w-8 h-8 animate-spin
//     .../>`  at initialLoading) and Templates' (same pattern) before
//     relying on it.
// Deliberately NOT `.animate-pulse` alone -- Skeleton's own primitive uses
// it (components/ui/skeleton.tsx), but so does a live-connection status dot
// used as PERMANENT decor on Chat/Console/Events/WorldMap/Players/
// ServerConfig (a pulsing "connected" indicator that is never meant to
// stop). A bare `.animate-pulse` selector would never settle on any of
// those pages even once fully loaded. `aria-busy` already covers the one
// place Skeleton's animate-pulse actually signals "still loading" (the
// PageSkeleton wrapper), without inheriting its false positives.
//
// Requires the busy/spin signal to be ABSENT continuously for `quietMs`,
// not just absent at one poll -- a single instantaneous check is exactly
// what would fall into the gap between two parallel fetches described
// above. Polls rather than a single `waitForFunction` so the quiet window
// is actually re-verified, not just "was true once."
async function waitForSettle(page, { timeoutMs = 8000, quietMs = 500, pollMs = 150 } = {}) {
  const start = Date.now()
  let quietSince = null
  while (Date.now() - start < timeoutMs) {
    const busy = await page
      .evaluate(() => {
        if (document.querySelector('[aria-busy="true"], .animate-spin')) return true
        // A THIRD tour-only artifact, found while chasing down the dimming
        // reported in three lanes as a leaked dialog: `.page-transition`
        // (index.css) plays a 0.3s opacity 0->1 `pageEnter` fade on mount,
        // applied on nearly every page's own root div. Real users never
        // notice a 300ms fade; a screenshot taken mid-fade freezes it as a
        // permanently washed-out page. This reproduced specifically on the
        // FIRST authenticated view of a session (cold JIT/paint/font costs
        // push the fade's start later than a warm navigation's), which is
        // exactly the position-1-only pattern this repo's own settings
        // capture showed even after the leaked-dialog fix below found zero
        // stray dialogs -- ruling out AlertDialogOverlay's `bg-background/78`
        // scrim as the (only) explanation for that specific case. Waited
        // out via the Web Animations API rather than a fixed extra sleep,
        // for the same reason the busy/spin check above polls instead of
        // guessing a duration: an animation genuinely still running is a
        // fact, not an estimate.
        const transitioning = document.querySelector('.page-transition')
        if (transitioning?.getAnimations().some((a) => a.playState === 'running')) return true
        return false
      })
      .catch(() => false) // page mid-navigation/crashed -- treat as not-busy, let the outer timeout/catch handle it
    if (busy) {
      quietSince = null
    } else {
      if (quietSince === null) quietSince = Date.now()
      if (Date.now() - quietSince >= quietMs) return true
    }
    await page.waitForTimeout(pollMs)
  }
  return false
}

// visual-sweep-2026-08-30 defect 2: three agents independently reported a
// dimmed/washed-out capture in three unrelated lanes (players, events,
// discord), each reading it as a bug in their own page. god's diagnosis,
// proven by ORDER rather than guessed: within one page's run of sub-views
// (e.g. players -> moderation -> vitals -> spawn -> powers -> notes ->
// kill-confirm), the dimming starts at some position and never recovers --
// a real page bug follows the PAGE, this followed the ORDINAL POSITION.
// This script never pressed Escape or closed a dialog anywhere, and a
// Radix Dialog/AlertDialog's Overlay+Content are portaled onto
// document.body -- outside whatever DOM subtree a client-side tab switch
// replaces -- so once something opens one, it can silently outlive
// everything after it in the same browser tab, across routes, not just
// sub-views. Ruled out as a REAL (non-tour) bug before writing this fix,
// not assumed: grepped for the actual banner behind the one confirmed
// correlation (a disk-space warning showing up alongside the scrim in
// several lanes) -- SystemHealthBanner.tsx renders a plain non-portaled
// <div>, no overlay, no z-index, no backdrop, so it cannot be the source
// for a real user either. The correlation was two symptoms of the same
// stale session, not one causing the other.
//
// Every Dialog/AlertDialog Content in this codebase (ui/dialog.tsx,
// ui/alert-dialog.tsx) is Radix's own primitive with no onEscapeKeyDown
// override that blocks it, so Escape is a safe, generic dismissal that
// doesn't need to know which specific dialog might be open -- this fix
// doesn't need to find (and isn't trying to find) whichever page actually
// leaves one open; it makes the TOUR immune regardless of which page does.
async function detectOpenDialog(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[role="dialog"], [role="alertdialog"]')
    if (!el) return null
    const label =
      el.getAttribute('aria-label') ||
      el.querySelector('h1, h2, [id$="title" i]')?.textContent ||
      el.textContent?.slice(0, 60) ||
      '(unlabeled dialog)'
    return label.trim()
  })
}

async function dismissOpenDialogs(page, { maxAttempts = 3 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const open = await detectOpenDialog(page)
    if (!open) return null
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(200)
  }
  return detectOpenDialog(page) // still non-null after every attempt -- genuinely stuck
}

async function setTheme(page, theme) {
  await page.evaluate((t) => localStorage.setItem('pz-panel-theme', t), theme)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(300)
}

// ui-tour-never-drives-interactive-state (2026-08-31): captures
// PRE_AUTH_VIEWS through their own throwaway context, opened and closed
// BEFORE bootstrapAccount() runs -- the only way to see Setup.tsx at all
// (see PRE_AUTH_VIEWS' own comment). Deliberately NOT the shared
// per-view logic the main loop below uses (no fixture routes, no
// dialogExpected/dismissOpenDialogs, no beforeGoto, no rate-limit pacing --
// none of those apply pre-auth, and reaching for the same helper would mean
// widening it to tolerate a mode it was never built for). Still reuses
// waitForSettle/expandMainForCapture/finishRunningAnimations/readPngHeight
// so a pre-auth capture is checked for the same completeness signals as
// every other one, and pushes into the SAME manifest shape so MANIFEST.md's
// existing summary code needs no changes to include these.
async function capturePreAuthViews(browser, views, manifest) {
  const context = await browser.newContext({ viewport: VIEWPORTS[0] })
  await installLanguageOverride(context, args.lang)
  const page = await context.newPage()
  // setTheme's localStorage.setItem throws SecurityError on the page's
  // initial about:blank (an opaque origin, no localStorage access at all --
  // confirmed the hard way, first run) -- the authenticated main loop below
  // never hits this because login(page) always navigates first. One real
  // navigation before the loop starts gives every view a real origin to set
  // theme against, same as the authenticated path gets from login().
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    for (const theme of THEMES) {
      await setTheme(page, theme)
      for (const view of views) {
        try {
          await page.goto(BASE_URL + view.path, { waitUntil: 'domcontentloaded' })
          await page.waitForTimeout(600)
          if (view.interact) await view.interact(page)
          const settled = await waitForSettle(page)
          const fileName = `${view.name.replace(/:/g, '-')}__${viewport.key}__${theme}.png`
          const filePath = path.join(args.out, fileName)
          await expandMainForCapture(page)
          await finishRunningAnimations(page)
          const expectedHeight = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => null)
          await page.screenshot({ path: filePath, fullPage: true, animations: 'disabled' })
          await restoreMainAfterCapture(page)
          const capturedHeight = readPngHeight(filePath)
          const heightTruncated = expectedHeight !== null && capturedHeight < expectedHeight - 4
          manifest.push({
            file: fileName, view: view.name, path: view.path, viewport: viewport.key, theme,
            width: viewport.width, height: viewport.height, settled, strayOverlay: null,
            heightTruncated, capturedHeight, expectedHeight,
          })
          const flags = [
            settled ? '' : ' -- NOT SETTLED (spinner/skeleton still present after timeout)',
            heightTruncated ? ` -- HEIGHT TRUNCATED (captured ${capturedHeight}px, page needed ${expectedHeight}px)` : '',
          ].join('')
          console.log(`[ui-shot-tour] captured ${fileName} (pre-auth)${flags}`)
        } catch (err) {
          console.error(`[ui-shot-tour] FAILED ${view.name} (${viewport.key}/${theme}, pre-auth): ${err.message}`)
          manifest.push({ file: null, view: view.name, path: view.path, viewport: viewport.key, theme, error: err.message })
        }
      }
    }
  }
  await context.close()
}

async function main() {
  if (args.list) {
    printViewList()
    return
  }

  // ui-tour-never-drives-interactive-state: PRE_AUTH_VIEWS are captured
  // through a separate path (capturePreAuthViews, before bootstrapAccount)
  // -- kept out of targetViews/SWEEP_VIEWS so the normal authenticated loop
  // below never sees them. Both default to empty (not SWEEP_VIEWS) so a
  // single pre-auth-view request doesn't also drag in the entire
  // authenticated sweep -- only the else branch (no args.view -- the full
  // run) turns both on.
  let targetViews = []
  let targetPreAuthViews = []
  if (args.view) {
    const preAuthMatch = PRE_AUTH_VIEWS.find((v) => v.name === args.view)
    if (preAuthMatch) {
      targetPreAuthViews = [preAuthMatch]
    } else {
      const match = VIEWS.find((v) => v.name === args.view)
      if (!match) {
        console.error(`Unknown view "${args.view}".\n`)
        printViewList()
        process.exitCode = 1
        return
      }
      targetViews = [match]
    }
  } else {
    targetViews = SWEEP_VIEWS
    targetPreAuthViews = PRE_AUTH_VIEWS
    const skipped = VIEWS.length - SWEEP_VIEWS.length
    if (skipped) console.log(`[ui-shot-tour] skipping ${skipped} unstable view(s) in the default sweep (see the VIEWS comment) -- capture by name explicitly if you need one`)
  }

  console.log(`[ui-shot-tour] root=${args.root} out=${args.out} port=${args.port} views=${args.view || `all (${VIEWS.length + PRE_AUTH_VIEWS.length})`}`)
  mkdirSync(args.out, { recursive: true })

  await buildClient(args.root)

  const dataRoot = mkdtempSync(path.join(tmpdir(), 'ui-shot-tour-'))
  mkdirSync(path.join(dataRoot, 'data'), { recursive: true })
  mkdirSync(path.join(dataRoot, 'logs'), { recursive: true })

  const server = spawnServer(args.root, dataRoot, args.port, args.keepServer)
  const manifest = []
  let browser = null

  try {
    await waitForHealth(BASE_URL)

    if (targetPreAuthViews.length) {
      // MUST run before bootstrapAccount(): needsSetup (App.tsx) resolves
      // permanently false the instant that account exists, and there is no
      // going back within this process's lifetime -- see PRE_AUTH_VIEWS'
      // own comment.
      browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS)
      await capturePreAuthViews(browser, targetPreAuthViews, manifest)
    }

    await bootstrapAccount(dataRoot)

    if (targetViews.length) {
      if (!browser) browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS)
      const context = await browser.newContext({ viewport: VIEWPORTS[0] })
      await installLanguageOverride(context, args.lang)
      await installFixtureRoutes(context)
      context.on('response', trackRateLimitHeaders)
      const page = await context.newPage()
      await login(page)

      for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      for (const theme of THEMES) {
        try {
          await paceForRateLimit()
          await setTheme(page, theme)
        } catch (err) {
          // Most likely the throwaway server itself died mid-run (a page
          // triggered a real, uncaught server-side crash -- confirmed once:
          // loading /server-finder crashes server/routes/serverFinder.js
          // with ERR_SOCKET_BAD_PORT in its dgram query, and Node's default
          // behavior for an uncaught exception is to exit the process).
          // Record it and move on rather than losing every remaining view
          // (and the manifest) to one uncaught rejection -- see the
          // top-level catch below for why the manifest write must survive
          // this either way.
          console.error(`[ui-shot-tour] setTheme failed for ${theme} (${viewport.key}) -- server may have died: ${err.message}`)
          for (const view of targetViews) {
            manifest.push({ file: null, view: view.name, path: view.path, viewport: viewport.key, theme, error: `setTheme failed, likely server crash: ${err.message}` })
          }
          continue
        }
        for (const view of targetViews) {
          try {
            // Bug-hunt-2026-08-31: page-level route overrides a view sets up
            // via beforeGoto (see its own comment below) are scoped to ONE
            // page.goto -- Playwright's page.route persists across
            // navigations otherwise, and this same `page` object is reused
            // for every remaining view in the sweep. Cleared unconditionally
            // at the TOP of every iteration (not just the one that set them)
            // so a view that throws mid-capture still can't leak its error
            // fixture forward into the next view's otherwise-normal load.
            await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {})
            // A handful of views need the server to answer an error BEFORE
            // the page's own mount-time fetch fires (permission-denied,
            // failed-load empty states) -- too late to arrange from
            // `interact()`, which only runs after page.goto has already
            // resolved and the component has already mounted and fetched.
            if (view.beforeGoto) await view.beforeGoto(page)
            // NOT waitUntil:'networkidle' -- this app holds a live
            // Socket.IO connection open from the moment it authenticates,
            // so "0 network connections for 500ms" never happens and every
            // goto would just eat its full timeout. Real fetches against
            // this throwaway server are still all localhost round-trips
            // (fast), but a heavy page firing many of them in parallel
            // (Dashboard: ~17) can still be mid-fetch after a short fixed
            // wait -- confirmed the hard way: an earlier run with a 400ms
            // wait captured Dashboard's "Establishing link…" loading state
            // instead of the real tile grid. 1200ms covers that
            // comfortably; the loading-text wait below is an extra,
            // bounded safety net for any page that takes longer.
            await paceForRateLimit()
            await page.goto(`${BASE_URL}${view.path}`, { waitUntil: 'domcontentloaded' })
            await page.waitForTimeout(1200)
            await page.waitForFunction(
              () => !document.body.innerText.includes('Establishing link'),
              { timeout: 4000 },
            ).catch(() => {})
            if (view.interact) await view.interact(page)
            // Real settle condition (see waitForSettle's own header) instead
            // of a bare fixed sleep -- `settled` records whether it actually
            // cleared or timed out still busy, so a capture that never
            // finished loading says so in the manifest instead of silently
            // passing as an ordinary success.
            const settled = await waitForSettle(page)
            // Leaked-overlay defense (see dismissOpenDialogs' own header):
            // any view NOT deliberately capturing an open dialog gets one
            // dismissed before the shot, and `strayOverlay` records the
            // dialog's own label when three Escape presses couldn't close
            // it -- a genuinely stuck dialog, not a false alarm from this
            // check misfiring on a view that wants one open.
            const strayOverlay = view.dialogExpected ? null : await dismissOpenDialogs(page)
            // `:` is a reserved path character on Windows (NTFS Alternate
            // Data Stream syntax, `base:stream`) -- a filename built
            // straight from an addressable name like `players:vitals` does
            // NOT error, it silently writes into a hidden stream on a file
            // literally named `players`, and every tab of the same page
            // collides into streams on that one file. Confirmed the hard
            // way: this tool's own first full-sweep run "captured" every
            // `page:tab` view with no error, but only the colon-free base
            // views existed as real, visible PNGs afterward. `-` is not
            // reserved on Windows or POSIX, so the addressable name (used
            // for the CLI and the manifest's `view` field) and the on-disk
            // filename now deliberately differ.
            const fileName = `${view.name.replace(/:/g, '-')}__${viewport.key}__${theme}.png`
            const filePath = path.join(args.out, fileName)
            await expandMainForCapture(page)
            await finishRunningAnimations(page)
            // quality-pass-2026-08-31, round 2: finishRunningAnimations
            // above -- called as late as possible, right before this line
            // -- still wasn't enough on its own. Confirmed on a full 204-
            // view run: players-notes/powers (tall, fixed by the call
            // above) came out clean, but events__desktop__light and
            // discord__desktop__light (also taller than the 900px
            // viewport) still captured dimmed. The remaining gap: for a
            // page taller than the viewport, Playwright's own fullPage
            // handling resizes/reflows the page AS PART OF this
            // screenshot() call, and that reflow can retrigger
            // `.page-transition`'s pageEnter animation AFTER
            // finishRunningAnimations already ran -- one step later than
            // any pre-check can reach, no matter how late that check runs.
            // `animations: 'disabled'` is Playwright's own option for
            // exactly this: it fast-forwards finite CSS animations/
            // transitions to completion and freezes infinite ones, for the
            // FULL DURATION of the screenshot operation itself (including
            // its internal reflow), not just at one instant beforehand --
            // closing the gap structurally instead of chasing the trigger
            // one step later each round. Kept finishRunningAnimations too:
            // cheap, still correct, and narrows what this option has to
            // paper over.
            // Measured immediately before the shot, while #main-content and
            // every clipping descendant are still forced open by
            // expandMainForCapture -- this is "how tall the page really is"
            // for the height check right below.
            const expectedHeight = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => null)
            await page.screenshot({ path: filePath, fullPage: true, animations: 'disabled' })
            await restoreMainAfterCapture(page)
            // See readPngHeight's own header: a manifest field that can
            // fail on a short capture, not just an unsettled or overlaid
            // one. `+4` tolerance for the same reason readPngHeight reads
            // whole pixels off the IHDR -- sub-pixel layout rounding is
            // real and not a truncation.
            const capturedHeight = readPngHeight(filePath)
            const heightTruncated = expectedHeight !== null && capturedHeight < expectedHeight - 4
            // Unconditional cleanup, even for a `dialogExpected` view whose
            // own dialog was deliberately left open for the shot just taken
            // -- this is the half of the fix that actually stops a leak
            // reaching the NEXT view, as opposed to the check above, which
            // only asserts one didn't already leak in from the last one.
            await dismissOpenDialogs(page)
            manifest.push({
              file: fileName, view: view.name, path: view.path, viewport: viewport.key, theme,
              width: viewport.width, height: viewport.height, settled, strayOverlay,
              heightTruncated, capturedHeight, expectedHeight,
            })
            const flags = [
              settled ? '' : ' -- NOT SETTLED (spinner/skeleton still present after timeout)',
              strayOverlay ? ` -- STRAY OVERLAY LEAKED IN ("${strayOverlay}")` : '',
              heightTruncated ? ` -- HEIGHT TRUNCATED (captured ${capturedHeight}px, page needed ${expectedHeight}px)` : '',
            ].join('')
            console.log(`[ui-shot-tour] captured ${fileName}${flags}`)
          } catch (err) {
            console.error(`[ui-shot-tour] FAILED ${view.name} (${viewport.key}/${theme}): ${err.message}`)
            manifest.push({ file: null, view: view.name, path: view.path, viewport: viewport.key, theme, error: err.message })
          }
        }
      }
    }
    } // end if (targetViews.length) -- indentation of the block above is
      // intentionally left as it was before this wrap (not re-flowed) to
      // keep this diff reviewable as "one guard added, nothing else
      // touched" rather than a whitespace-only rewrite of ~170 lines that
      // would hide a real content change inside it just as easily as show
      // one wasn't made.

  } catch (err) {
    // A fatal, unrecovered error (server bootstrap failed, browser crashed,
    // etc.) must still fall through to writing whatever the manifest
    // already has -- losing the manifest on top of losing the rest of the
    // run is strictly worse, and gives no record of what succeeded before
    // the failure.
    console.error('[ui-shot-tour] fatal during capture, writing partial manifest:', err.message)
    manifest.push({ file: null, view: '(fatal)', path: null, viewport: null, theme: null, error: err.message })
  } finally {
    await browser?.close().catch(() => {})
    if (!args.keepServer) {
      server.kill()
      rmSync(dataRoot, { recursive: true, force: true })
    } else {
      // Deleting dataRoot here would pull the data/logs dir and
      // paths.config.json out from under a server this branch just went to
      // the trouble of keeping alive -- it would still hold the PID, but
      // break for real on its next disk read/write (db.json, DiskMonitor's
      // periodic poll, etc.). Left in place deliberately; the operator is
      // responsible for cleaning it up when done debugging.
      console.log(`[ui-shot-tour] --keep-server: leaving server up at ${BASE_URL} (pid ${server.pid})`)
      console.log(`[ui-shot-tour] --keep-server: data dir left in place (server needs it): ${dataRoot}`)
      console.log(`[ui-shot-tour] --keep-server: server logs: ${server.stdoutLogPath} / ${server.stderrLogPath}`)
      console.log(`[ui-shot-tour] --keep-server: clean up when done -- Windows: taskkill /PID ${server.pid} /F && rmdir /s /q "${dataRoot}"`)
    }
  }

  writeFileSync(path.join(args.out, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const okCount = manifest.filter((m) => m.file).length
  const failCount = manifest.length - okCount
  const capturedFiles = manifest.filter((m) => m.file)
  // quality-pass-2026-08-31: merging a handful of freshly-recaptured entries
  // (with a NEW field) into an existing manifest whose other entries predate
  // that field exposed a false clean, not just for heightTruncated but by
  // the same construction for settled too -- `m.heightTruncated ? ... :
  // 'ok'` and `m.settled === false ? ... : 'yes'` both render an entry that
  // was NEVER MEASURED for that check identically to one that was measured
  // and passed. Caught it directly: a 4-entry chunks recapture merged into
  // the other 200 pre-existing entries rendered ALL 200 as "Height: ok" in
  // MANIFEST.md, though the height check had never run on them. This is the
  // exact "settled/strayOverlay could never express this class BY
  // CONSTRUCTION" gap heightTruncated itself was built to close -- except
  // this time it was wrongly EXPRESSED as clean instead of silently absent,
  // which is worse: a missing signal makes you go look; a confident "ok"
  // stops you looking. Every boolean-valued check below now has three
  // states -- true, false, and "never measured" (field absent, e.g. an
  // older manifest.json's entries merged in unchanged) -- and unmeasured is
  // never folded into the passing bucket for either the table or the
  // summary line.
  const settledMeasured = capturedFiles.filter((m) => typeof m.settled === 'boolean')
  const settledUnmeasured = capturedFiles.filter((m) => typeof m.settled !== 'boolean')
  // A captured file whose own settle condition timed out (still busy/
  // spinning when the timeout hit) is NOT a failure -- the screenshot
  // exists and might even be fine -- but it must not read as an ordinary
  // success either. visual-sweep-2026-08-30: a "204 captured / 0 failed"
  // summary that silently included several still-loading pages is what
  // sent two reviewers chasing bugs that were actually this script's own
  // too-short wait.
  const unsettled = settledMeasured.filter((m) => m.settled === false)
  // visual-sweep-2026-08-30 defect 2: a stray dialog that Escape couldn't
  // close within dismissOpenDialogs' own retry budget -- distinct from the
  // ordinary case (leaked in, one Escape closed it, capture is clean) which
  // never reaches here at all.
  const strayOverlays = capturedFiles.filter((m) => m.strayOverlay)
  // See readPngHeight's own header: a captured file that is settled, has no
  // stray overlay, and is STILL wrong -- the actual PNG is shorter than the
  // page needed at capture time. chunks__desktop__survival.png was exactly
  // this: settled:true, strayOverlay:null, and truncated anyway.
  const heightMeasured = capturedFiles.filter((m) => typeof m.heightTruncated === 'boolean')
  const heightUnmeasured = capturedFiles.filter((m) => typeof m.heightTruncated !== 'boolean')
  const truncated = heightMeasured.filter((m) => m.heightTruncated)
  const md = [
    '# UI shot tour manifest',
    '',
    `Captured ${okCount} views (${failCount} failed, ${unsettled.length} not settled${settledUnmeasured.length ? ` [${settledUnmeasured.length} never measured for settle]` : ''}, ${strayOverlays.length} with a stray overlay, ${truncated.length} height-truncated of ${heightMeasured.length} measured${heightUnmeasured.length ? ` [${heightUnmeasured.length} never measured for height]` : ''}) from \`${args.root}\` against \`${BASE_URL}\`.`,
    ...(unsettled.length ? ['', '**Not settled means the capture may show a mid-load spinner or skeleton, not the real page -- verify before treating it as a finding.**'] : []),
    ...(strayOverlays.length ? ['', '**Stray overlay means a leaked dialog from an earlier view survived three Escape presses -- the capture may be dimmed by its backdrop with the dialog itself off-screen or unrendered. Verify before treating it as a finding.**'] : []),
    ...(truncated.length ? ['', '**Height-truncated means the captured PNG is shorter than the page actually needed -- content below the cutoff is missing from the image entirely. Verify before treating it as a finding.**'] : []),
    ...(settledUnmeasured.length || heightUnmeasured.length ? ['', '**"never measured" means this entry predates that check (e.g. merged in from an older manifest.json) -- it is NOT the same as passing, and is never counted as clean above.**'] : []),
    '',
    '| File | View | Route | Viewport | Theme | Settled | Stray overlay | Height |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...capturedFiles.map((m) => `| ${m.file} | ${m.view} | \`${m.path}\` | ${m.viewport} | ${m.theme} | ${typeof m.settled !== 'boolean' ? '❔ not measured' : m.settled === false ? '⚠️ NO' : 'yes'} | ${m.strayOverlay ? `⚠️ ${m.strayOverlay}` : '--'} | ${typeof m.heightTruncated !== 'boolean' ? '❔ not measured' : m.heightTruncated ? `⚠️ ${m.capturedHeight}px < ${m.expectedHeight}px` : 'ok'} |`),
    ...(failCount ? ['', '## Failed captures', '', ...manifest.filter((m) => !m.file).map((m) => `- **${m.view}** (${m.viewport}/${m.theme}, \`${m.path}\`): ${m.error}`)] : []),
    ...(unsettled.length ? ['', '## Captured but not settled', '', 'Spinner or skeleton (`[aria-busy="true"]` / `.animate-spin`) was still present when the timeout hit -- the file exists but may not show the real page.', '', ...unsettled.map((m) => `- **${m.view}** (${m.viewport}/${m.theme}): \`${m.file}\``)] : []),
    ...(strayOverlays.length ? ['', '## Captured with a stray overlay', '', 'A dialog leaked in from an earlier view and three Escape presses did not close it before the shot.', '', ...strayOverlays.map((m) => `- **${m.view}** (${m.viewport}/${m.theme}): \`${m.file}\` -- "${m.strayOverlay}"`)] : []),
    ...(truncated.length ? ['', '## Height-truncated captures', '', 'The captured PNG is shorter than `document.documentElement.scrollHeight` measured at the same instant -- content below the cutoff is missing from the image entirely, not just off-screen.', '', ...truncated.map((m) => `- **${m.view}** (${m.viewport}/${m.theme}): \`${m.file}\` -- captured ${m.capturedHeight}px, page needed ${m.expectedHeight}px`)] : []),
    ...(heightUnmeasured.length ? ['', '## Never measured for height', '', 'These entries predate the heightTruncated check (typically merged in from an older manifest.json) -- the check has not run on them at all. Re-capture to get a real answer; do not read their "not measured" Height cell as a pass.', '', ...heightUnmeasured.map((m) => `- **${m.view}** (${m.viewport}/${m.theme}): \`${m.file}\``)] : []),
  ].join('\n')
  writeFileSync(path.join(args.out, 'MANIFEST.md'), md)

  console.log(`[ui-shot-tour] done. ${okCount} captured, ${failCount} failed, ${unsettled.length} not settled, ${strayOverlays.length} with a stray overlay, ${truncated.length} height-truncated of ${heightMeasured.length} measured${heightUnmeasured.length ? ` (${heightUnmeasured.length} never measured)` : ''}. Output: ${args.out}`)
  if (failCount) process.exitCode = 1
}

main().catch((err) => {
  console.error('[ui-shot-tour] fatal:', err)
  process.exitCode = 1
})
