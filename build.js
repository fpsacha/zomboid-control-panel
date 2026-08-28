import esbuild from "esbuild";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pathToFileURL } from "url";

const distDir = "./dist-exe";
const releaseDir = "./release";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanDir(dir, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 1000,
        });
      }
      return true;
    } catch (error) {
      if (i === maxRetries - 1) {
        console.warn(`Could not fully clean ${dir}: ${error.message}`);
        console.warn("Attempting to continue anyway...");
        return false;
      }
      console.log(`Retry ${i + 1}/${maxRetries} for ${dir}...`);
      await delay(2000);
    }
  }
  return false;
}

function resolveTargets(args) {
  const wantsAll = args.includes("--all");
  const wantsWindows = args.includes("--windows");
  const wantsLinux = args.includes("--linux");

  if (wantsAll || (wantsWindows && wantsLinux)) {
    return ["win", "linux"];
  }

  if (wantsWindows) {
    return ["win"];
  }

  if (wantsLinux) {
    return ["linux"];
  }

  return [process.platform === "win32" ? "win" : "linux"];
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function resolveBuiltBinaryPath(target) {
  const candidates =
    target === "linux"
      ? [
          "./dist-exe/zomboid-control-panel",
          "./dist-exe/zomboid-control-panel-linux",
        ]
      : [
          "./dist-exe/zomboid-control-panel.exe",
          "./dist-exe/zomboid-control-panel-win.exe",
        ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

export function writeReleaseReadme() {
  const readme = `# Zomboid Control Panel

## First 10 Minutes

### Windows
1. Run Start.bat (double-click it — or double-click ZomboidControlPanel.exe directly).
2. Open your browser to http://localhost:3001
3. Create the admin account (first screen you'll see).
4. Open Servers and add your PZ server. You'll need the RCON port and
   password from the server's .ini (RCONPort=... / RCONPassword=...) and
   its install folder path — the panel can't discover these on its own.

### Linux (Ubuntu / Debian / CentOS Stream / Rocky)
1. In a terminal, in this folder: chmod +x start.sh ZomboidControlPanel
   (execute permissions usually survive tar xzf already — this is a safety net)
2. Run: ./start.sh
3. Open your browser to http://localhost:3001
4. Create the admin account.
5. Open Servers and add your PZ server (same RCON port/password/install-path
   info as the Windows step above).

That's it for a first run. Running this as a background service, behind a
firewall, or as a dedicated non-root user is covered in the fuller guide
named below — none of it is required just to see the panel working once.

## If It Doesn't Start

Three things stop most first launches:

- "Port 3001 is in use", or the panel silently starts on a different port —
  something else on this machine already has 3001. Check the console/log
  for which port it actually picked, or free up 3001 and restart.
- Linux "Permission denied" — the execute bit didn't survive extraction.
  Run: chmod +x ZomboidControlPanel start.sh
- Linux: nothing happens, or a glibc error — this binary needs glibc 2.28+
  (Ubuntu 20.04+, Debian 10+, CentOS Stream 8+, Rocky 8+). CentOS 7 (glibc
  2.17) is not supported — use Docker instead.

More symptoms and fixes, organized by what's actually on your screen: see
docs/install/troubleshooting.md — it's in this same folder, no internet
needed. (Path below.)

## Where To Go Next

This file only covers the first ten minutes. The fuller guides are right
here in this folder, so they work with no internet — and also live on
GitHub if you'd rather read them there or check for updates to them:

  docs/install/                                    (this folder, offline)
  https://github.com/fpsacha/zomboid-control-panel  (same guides, online)

- docs/install/windows.md         Windows: running at startup / as a service, firewall.
- docs/install/linux.md           Linux: the bundled systemd service, a non-root
                                   user, SteamCMD's 32-bit library requirements,
                                   firewall (ufw/firewalld), reverse proxies.
- docs/install/docker.md          Docker and Unraid — three setups depending on
                                   where Project Zomboid itself runs. Not needed
                                   for this package; only relevant if you'd
                                   rather switch to Docker instead.
- docs/install/hosted.md          Renting a PZ server from a host (Indifferent
                                   Broccoli and similar) instead of running it
                                   yourself.
- docs/install/troubleshooting.md Symptom-first fixes, organized by what's on
                                   your screen, not by subsystem.

For everything else — PanelBridge, updates, remote access, the full feature
list — see README.md in the GitHub repository (not shipped in this archive,
needs internet).

## Folder Structure
- ZomboidControlPanel.exe - Windows standalone binary
- ZomboidControlPanel      - Linux standalone binary
- Start.bat                - Windows launch script
- start.sh                 - Linux launch script
- zomboid-panel.service    - systemd unit file (Linux) — see docs/install/linux.md, in this folder
- docker-compose.install.yml - Docker Compose installer (published panel image)
- docs/install/            - Install guides for every platform (see Where To Go Next, above)
- client/dist/             - Web interface (required, must stay alongside binary)
- data/db.json             - Configuration database (created on first run; NEVER overwrite when upgrading — see data/README.txt)
- data/db.example.json     - Reference db structure (safe to delete)
- data/README.txt          - Upgrade-safety notes for the data/ folder
- logs/                    - Application logs
- pz-mod/                  - PanelBridge server-side Lua (drop into Install/media/lua/server)
- checksums.txt            - SHA256 hashes for release archives
- release-manifest.json    - Build metadata for this package

Keep every file in this same folder — the binary needs client/dist/ next to
it, and won't start without it.

## Panel Bridge Setup (Optional)
The PanelBridge Lua enables advanced features like weather control. It is a
server-side drop-in, NOT a Workshop mod — there is no client component.
1. Copy pz-mod/PanelBridge/media/lua/server/PanelBridge.lua into your PZ
   dedicated server's install folder: Install/media/lua/server/PanelBridge.lua
2. Restart your PZ server (no .ini changes needed; nothing loads on clients)
3. Go to Settings in the panel and configure the Panel Bridge section

## Upgrading
- The panel auto-update feature handles upgrades safely — prefer it.
- For MANUAL upgrades, do NOT extract the archive over data/. Your db.json
  (admin account + all configs) lives there and the archive must not clobber
  it. Modern releases ship only data/db.example.json inside the archive, so
  a plain extract is safe; back up data/ first if you are unsure. See
  data/README.txt for tar/zip flags.
- If you ever lose db.json, check data/backups/ — the panel keeps the last
  5 auto-snapshots and will restore from the newest on next startup.
`;

  fs.writeFileSync("./release/README.txt", readme);
}

export function generateStartBat() {
  // Start.bat v2 — supervisor + applier.
  //
  // Why a supervisor instead of an in-process helper:
  //   The previous design spawned a detached cmd.exe helper from the panel
  //   right before exit, which had to wait for the panel PID to die, rename
  //   the staged exe into place, and respawn. That design was fragile on
  //   Windows for reasons that bit us repeatedly:
  //     - Defender / ASR silently killed the detached helper before it ran.
  //     - `start "" "panel.exe.new"` has no .new file association, hangs or
  //       no-ops depending on shell config.
  //     - TIME_WAIT on port 3001 made the staged exe fail to bind on restart.
  //     - UNC installs (\\host\share) had inconsistent SMB caching of the
  //       helper's writes.
  //   The supervisor sidesteps all of these by performing the rename BETWEEN
  //   panel runs, in a user-visible batch file the user already trusts.
  //
  // Protocol with the panel (server/services/panelUpdateChecker.js):
  //   1. Panel reads env var PANEL_SUPERVISOR_V=2 to know the supervisor is
  //      live, and uses the supervisor path instead of spawning a helper.
  //   2. When the user clicks "Apply", the panel writes
  //      ZomboidControlPanel.exe-dir\.update-pending  (a small JSON marker)
  //      and exits with code 75.
  //   3. This .bat sees exit 75 OR sees .update-pending and performs the
  //      apply: back up the running .exe and client/dist, activate both staged
  //      artifacts, and retain both backups until the new listener acknowledges.
  //   4. All apply events are logged to logs\supervisor.log for diagnostics.
  //
  // A staged binary is never selected by mtime alone. It is launched only
  // after the matching frontend has been activated by the journaled apply.
  //
  // Crash-loop protection: any exit code other than 0 (clean shutdown) or 75
  // (update requested), with no update marker present, is treated as a crash
  // and relaunched with backoff, up to MAX_RAPID_CRASHES attempts. Past the
  // cap this falls through to the same "stop and show the operator the exit
  // code" behavior every non-zero exit used to have unconditionally -- a
  // real boot loop must still surface itself, not spin forever quietly. A
  // run that stays up at least MIN_STABLE_SECONDS resets the counter, so one
  // crash after hours of uptime is never treated as part of a boot loop. All
  // three tunables are overridable via environment variable (used by
  // server/tests/supervisor-restart.test.js to keep the test fast).
  return `@echo off
setlocal ENABLEDELAYEDEXPANSION
title Zomboid Control Panel
cd /d "%~dp0"

set "PANEL_SUPERVISOR_V=2"
set "INSTALL_DIR=%~dp0"
set "MARKER=%INSTALL_DIR%.update-pending"
set "APPLYING=%INSTALL_DIR%.update-applying"
set "JOURNAL=%INSTALL_DIR%update-bundle.json"
set "BASE_EXE=ZomboidControlPanel.exe"
set "BIN_BACKUP=ZomboidControlPanel.exe.bundle-previous"
set "CLIENT_LIVE=%INSTALL_DIR%client\dist"
set "CLIENT_BACKUP=%INSTALL_DIR%client\dist.previous"
set "LOG_DIR=%INSTALL_DIR%logs"
set "LOG_FILE=%LOG_DIR%\\supervisor.log"

set "MAX_RAPID_CRASHES=5"
set "MIN_STABLE_SECONDS=60"
set "BACKOFF_BASE_SECONDS=2"
set "BACKOFF_CAP_SECONDS=30"
set "CRASH_COUNT=0"
if defined PANEL_SUPERVISOR_MAX_CRASHES set "MAX_RAPID_CRASHES=%PANEL_SUPERVISOR_MAX_CRASHES%"
if defined PANEL_SUPERVISOR_MIN_STABLE_SECONDS set "MIN_STABLE_SECONDS=%PANEL_SUPERVISOR_MIN_STABLE_SECONDS%"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

call :stamp "Supervisor v2 starting"

echo Starting Zomboid Control Panel...
echo (the panel will print the URL to open once it is ready)
echo.

:run_loop
  rem === If an update is pending, apply it before launching. ===
  if exist "%MARKER%" call :apply_update

  rem === A staged binary must never launch by mtime alone: its matching    ===
  rem === frontend is still inactive until the journaled apply transaction. ===
  set "TARGET=%BASE_EXE%"

  if not exist "%INSTALL_DIR%!TARGET!" (
    call :stamp "ERROR no ZomboidControlPanel binary found"
    echo ERROR: No ZomboidControlPanel binary found in this folder.
    echo Expected: ZomboidControlPanel.exe
    pause
    exit /b 1
  )

  for /f "usebackq delims=" %%S in (\`powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()"\`) do set "RUN_START=%%S"

  call :stamp "Launching !TARGET!"
  echo Launching !TARGET!
  echo.
  "%INSTALL_DIR%!TARGET!"
  set "EXITCODE=!ERRORLEVEL!"
  call :stamp "Panel exited with code !EXITCODE!"

  if exist "%APPLYING%" (
    call :stamp "Apply: startup handshake failed; rolling back bundle [startup_handshake_failed]"
    call :rollback_update
    goto run_loop
  )

  rem Exit code 75 = panel requested restart-for-update.
  if "!EXITCODE!"=="75" (
    echo.
    echo Panel requested restart for update. Applying...
    echo.
    goto run_loop
  )

  rem Exit code 78 = another panel instance already holds the lock. The
  rem panel already printed exactly which PID and what to do about it;
  rem retrying is guaranteed to fail identically every time, so this stops
  rem here instead of entering the crash-loop backoff -- retrying (and
  rem eventually "giving up") would misrepresent a working refusal as a
  rem string of crashes.
  if "!EXITCODE!"=="78" (
    echo.
    pause
    exit /b 78
  )

  rem If a marker appeared during runtime (panel wrote it but then crashed
  rem before exiting with 75), apply on the next loop iteration anyway.
  if exist "%MARKER%" (
    echo.
    echo Update marker present after exit. Applying and relaunching...
    echo.
    goto run_loop
  )

  rem Exit code 0 = the operator (or a signal) asked the panel to stop.
  rem Never relaunch a clean shutdown.
  if "!EXITCODE!"=="0" (
    echo.
    echo Panel exited cleanly.
    pause
    exit /b 0
  )

  rem Anything else is an unrecovered crash. Relaunch with backoff, up to a
  rem cap -- past the cap this falls through to the same "stop and show the
  rem operator" behavior every non-zero exit used to have unconditionally.
  for /f "usebackq delims=" %%E in (\`powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()"\`) do set "RUN_END=%%E"
  set /a UPTIME_SECONDS=RUN_END-RUN_START
  if !UPTIME_SECONDS! GEQ !MIN_STABLE_SECONDS! (
    if !CRASH_COUNT! GTR 0 call :stamp "Panel stayed up !UPTIME_SECONDS!s, resetting crash counter"
    set "CRASH_COUNT=0"
  )
  set /a CRASH_COUNT+=1

  if !CRASH_COUNT! GTR !MAX_RAPID_CRASHES! (
    call :stamp "Gave up after !CRASH_COUNT! rapid crashes, last exit code !EXITCODE!"
    echo.
    echo Panel crashed !CRASH_COUNT! times in a row without staying up long enough to recover on its own.
    echo Last exit code: !EXITCODE!. Check logs\\supervisor.log and the panel output above.
    pause
    exit /b !EXITCODE!
  )

  if defined PANEL_SUPERVISOR_BACKOFF_SECONDS (
    set "BACKOFF=!PANEL_SUPERVISOR_BACKOFF_SECONDS!"
  ) else (
    set /a BACKOFF=BACKOFF_BASE_SECONDS*CRASH_COUNT
    if !BACKOFF! GTR !BACKOFF_CAP_SECONDS! set "BACKOFF=!BACKOFF_CAP_SECONDS!"
  )

  call :stamp "Panel crashed, exit !EXITCODE!, relaunch attempt !CRASH_COUNT! of !MAX_RAPID_CRASHES!, waiting !BACKOFF!s"
  echo.
  echo Panel exited unexpectedly, code !EXITCODE!. Relaunch attempt !CRASH_COUNT! of !MAX_RAPID_CRASHES! in !BACKOFF!s...
  echo.
  rem A 0-second backoff (the default override every test in this file uses,
  rem and a real operator could set too) still waited zero seconds before
  rem this -- but paid for a whole powershell.exe startup to do it, adding
  rem one more source of unpredictable subprocess-spawn latency to a script
  rem whose whole job here is recovering quickly. Skipping the spawn changes
  rem no observable timing: same zero seconds waited, same log line, same
  rem relaunch order.
  if !BACKOFF! GTR 0 (
    powershell -NoProfile -Command "Start-Sleep -Seconds !BACKOFF!" >nul 2>&1
  )
  goto run_loop


rem ============================================================
rem :apply_update  — activate the journaled frontend/backend bundle.
rem  - Picks newest of .exe.new / .exe.new2 as the binary source.
rem  - Backs up current .exe and client\dist under fixed transaction names.
rem  - Keeps both backups until the new backend acknowledges listener startup.
rem ============================================================
:apply_update
  call :stamp "Apply: marker present, beginning swap"

  if not exist "%JOURNAL%" (
    call :stamp "Apply: update-bundle.json missing [version_mismatch]"
    del /f /q "%MARKER%" >nul 2>&1
    goto :eof
  )

  set "STAGED_NAME="
  for /f "usebackq delims=" %%F in (\`powershell -NoProfile -Command "Get-ChildItem -LiteralPath '.' -File | Where-Object { $_.Name -match '^ZomboidControlPanel\\.exe\\.new2?$' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty Name"\`) do set "STAGED_NAME=%%F"

  if not defined STAGED_NAME (
    call :stamp "Apply: staged binary missing or quarantined [av_quarantine]"
    del /f /q "%MARKER%" >nul 2>&1
    goto :eof
  )

  set "STAGED_CLIENT="
  for /f "usebackq delims=" %%F in (\`powershell -NoProfile -Command "$j=Get-Content -LiteralPath $env:JOURNAL -Raw | ConvertFrom-Json; $j.paths.stagedClient"\`) do set "STAGED_CLIENT=%%F"
  if not defined STAGED_CLIENT (
    call :stamp "Apply: staged frontend path missing from journal [version_mismatch]"
    goto :eof
  )
  if not exist "!STAGED_CLIENT!\index.html" (
    call :stamp "Apply: staged frontend missing index.html [frontend_swap_failed]"
    goto :eof
  )

  if exist "%BIN_BACKUP%" del /f /q "%BIN_BACKUP%" >nul 2>&1
  if exist "%CLIENT_BACKUP%" rmdir /s /q "%CLIENT_BACKUP%" >nul 2>&1

  if not exist "%BASE_EXE%" goto :do_rename

  call :stamp "Apply: backing up %BASE_EXE% to %BIN_BACKUP%"
  ren "%BASE_EXE%" "%BIN_BACKUP%" >nul 2>&1
  if errorlevel 1 (
    call :stamp "Apply: could not back up running executable [binary_swap_failed]"
    echo ERROR: could not rename %BASE_EXE% — is the panel still running?
    goto :eof
  )

:do_rename
  if exist "%CLIENT_LIVE%" (
    move "%CLIENT_LIVE%" "%CLIENT_BACKUP%" >nul 2>&1
    if errorlevel 1 (
      call :stamp "Apply: could not back up live frontend [frontend_swap_failed]"
      call :rollback_update
      goto :eof
    )
  )
  move "!STAGED_CLIENT!" "%CLIENT_LIVE%" >nul 2>&1
  if errorlevel 1 (
    call :stamp "Apply: could not activate staged frontend [frontend_swap_failed]"
    call :rollback_update
    goto :eof
  )

  call :stamp "Apply: renaming !STAGED_NAME! to %BASE_EXE%"
  ren "!STAGED_NAME!" "%BASE_EXE%" >nul 2>&1
  if errorlevel 1 (
    call :stamp "Apply: executable activation failed [binary_swap_failed]"
    echo ERROR: could not rename !STAGED_NAME! to %BASE_EXE%.
    call :rollback_update
    goto :eof
  )

  move /y "%MARKER%" "%APPLYING%" >nul 2>&1
  if errorlevel 1 (
    call :stamp "Apply: could not move pending marker to applying state [bundle_apply_failed]"
    call :rollback_update
    goto :eof
  )
  if not exist "%APPLYING%" (
    call :stamp "Apply: applying marker missing after state transition [bundle_apply_failed]"
    call :rollback_update
    goto :eof
  )
  call :stamp "Apply: bundle activated; waiting for backend startup acknowledgement"
goto :eof


:rollback_update
  call :stamp "Apply: restoring previous frontend and backend"
  set "ROLLBACK_FAILED=0"
  set "BINARY_RESTORE_OK=1"
  if not exist "%BIN_BACKUP%" (
    call :stamp "Apply: binary restore failed; backup is missing [rollback_failed]"
    set "BINARY_RESTORE_OK=0"
  ) else (
    if exist "%BASE_EXE%" (
      del /f /q "%BASE_EXE%" >nul 2>&1
      if exist "%BASE_EXE%" (
        call :stamp "Apply: binary restore failed; active executable could not be removed [rollback_failed]"
        set "BINARY_RESTORE_OK=0"
      )
    )
    if "!BINARY_RESTORE_OK!"=="1" (
      ren "%BIN_BACKUP%" "%BASE_EXE%" >nul 2>&1
      if errorlevel 1 (
        call :stamp "Apply: binary restore failed; backup could not be activated [rollback_failed]"
        set "BINARY_RESTORE_OK=0"
      )
    )
    if not exist "%BASE_EXE%" set "BINARY_RESTORE_OK=0"
    if exist "%BIN_BACKUP%" set "BINARY_RESTORE_OK=0"
  )
  if "!BINARY_RESTORE_OK!"=="0" set "ROLLBACK_FAILED=1"

  set "CLIENT_RESTORE_OK=1"
  if not exist "%CLIENT_BACKUP%" (
    call :stamp "Apply: frontend restore failed; backup is missing [rollback_failed]"
    set "CLIENT_RESTORE_OK=0"
  ) else (
    if exist "%CLIENT_LIVE%" (
      rmdir /s /q "%CLIENT_LIVE%" >nul 2>&1
      if exist "%CLIENT_LIVE%" (
        call :stamp "Apply: frontend restore failed; active frontend could not be removed [rollback_failed]"
        set "CLIENT_RESTORE_OK=0"
      )
    )
    if "!CLIENT_RESTORE_OK!"=="1" (
      move "%CLIENT_BACKUP%" "%CLIENT_LIVE%" >nul 2>&1
      if errorlevel 1 (
        call :stamp "Apply: frontend restore failed; backup could not be activated [rollback_failed]"
        set "CLIENT_RESTORE_OK=0"
      )
    )
    if not exist "%CLIENT_LIVE%" set "CLIENT_RESTORE_OK=0"
    if exist "%CLIENT_BACKUP%" set "CLIENT_RESTORE_OK=0"
  )
  if "!CLIENT_RESTORE_OK!"=="0" set "ROLLBACK_FAILED=1"

  if "!ROLLBACK_FAILED!"=="1" (
    call :stamp "Apply: rollback incomplete; journal retained for recovery [rollback_failed]"
    echo ERROR: update rollback was incomplete. Recovery files were retained.
    goto :eof
  )

  del /f /q "%MARKER%" "%APPLYING%" >nul 2>&1
  if exist "%MARKER%" (
    call :stamp "Apply: rollback cleanup incomplete; pending marker remains, journal retained [rollback_failed]"
    goto :eof
  )
  if exist "%APPLYING%" (
    call :stamp "Apply: rollback cleanup incomplete; applying marker remains, journal retained [rollback_failed]"
    goto :eof
  )

  del /f /q "%JOURNAL%" >nul 2>&1
  if exist "%JOURNAL%" (
    call :stamp "Apply: rollback restored artifacts but could not remove journal [rollback_failed]"
    goto :eof
  )
  call :stamp "Apply: rollback complete"
goto :eof


:stamp
  rem %~1 = message. Appends a timestamped line to LOG_FILE.
  for /f "usebackq delims=" %%T in (\`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"\`) do set "NOW=%%T"
  >>"%LOG_FILE%" echo [!NOW!] %~1
  goto :eof
`.replace(/\r?\n/g, "\r\n");
}

export function generateStartSh() {
  return `#!/bin/bash
# Zomboid Control Panel — Linux launcher
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Starting Zomboid Control Panel..."
echo ""

if [ ! -f "./ZomboidControlPanel" ]; then
  echo "ERROR: ./ZomboidControlPanel was not found in this folder."
  exit 1
fi

# Check glibc version (panel requires glibc 2.28+)
if command -v ldd >/dev/null 2>&1; then
  GLIBC_VER=$(ldd --version 2>&1 | head -1 | grep -oP '\\d+\\.\\d+$' || true)
  if [ -n "$GLIBC_VER" ]; then
    MAJOR=$(echo "$GLIBC_VER" | cut -d. -f1)
    MINOR=$(echo "$GLIBC_VER" | cut -d. -f2)
    if [ "$MAJOR" -lt 2 ] || { [ "$MAJOR" -eq 2 ] && [ "$MINOR" -lt 28 ]; }; then
      echo "WARNING: glibc $GLIBC_VER detected. This binary requires glibc 2.28+."
      echo "CentOS 7 (glibc 2.17) is not supported. Use CentOS Stream 8+, Rocky 8+, or Docker."
    fi
  fi
fi

# Warn if running as root
if [ "$(id -u)" = "0" ]; then
  echo "WARNING: Running as root is not recommended. Consider creating a dedicated user."
fi

./ZomboidControlPanel
`;
}

async function main() {
  const args = process.argv.slice(2);
  const targets = resolveTargets(args);
  const rootPkg = JSON.parse(fs.readFileSync("./package.json", "utf-8"));
  const panelVersion = rootPkg.version || "0.0.0";
  let buildSha = process.env.GITHUB_SHA || process.env.PANEL_BUILD_SHA || "";
  if (!buildSha) {
    try {
      buildSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    } catch {
      buildSha = "unknown";
    }
  }
  const apiContractVersion = 1;

  await cleanDir(distDir);
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  await cleanDir(releaseDir);
  if (!fs.existsSync(releaseDir)) {
    fs.mkdirSync(releaseDir, { recursive: true });
  }

  console.log("Building client...");
  try {
    execSync("npm run build", {
      cwd: "./client",
      stdio: "inherit",
      env: {
        ...process.env,
        PANEL_BUILD_SHA: buildSha,
        PANEL_API_CONTRACT_VERSION: String(apiContractVersion),
      },
    });
    console.log("Client built successfully");
  } catch (error) {
    console.error("Client build failed:", error.message);
    process.exit(1);
  }

  console.log("Building server bundle...");

  console.log(`Version: ${panelVersion}`);
  console.log(`Build SHA: ${buildSha}`);

  // Read PanelBridge.lua and inline it as a base64 define so it lives INSIDE
  // server.cjs (and therefore inside the pkg binary). pkg's `assets` glob was
  // silently skipping the file, leaving the on-disk pz-mod/ folder as the only
  // source — which goes stale after a binary-only auto-update and is the root
  // cause of the "worldmap blank on Linux / mod version mismatch" bug.
  const luaSourcePath = "./pz-mod/PanelBridge/media/lua/server/PanelBridge.lua";
  let panelBridgeLuaB64 = "";
  if (fs.existsSync(luaSourcePath)) {
    panelBridgeLuaB64 = fs.readFileSync(luaSourcePath).toString("base64");
    const luaVerMatch = fs
      .readFileSync(luaSourcePath, "utf8")
      .match(/VERSION\s*=\s*"([^"]+)"/);
    const luaVer = luaVerMatch ? luaVerMatch[1] : "unknown";
    console.log(
      `Embedding PanelBridge.lua v${luaVer} (${panelBridgeLuaB64.length} base64 chars)`,
    );
  } else {
    console.warn(
      `WARNING: ${luaSourcePath} not found — binary will not be able to auto-update the Lua mod.`,
    );
  }

  await esbuild.build({
    entryPoints: ["./server/index.js"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: "./dist-exe/server.cjs",
    // ssh2's optional native addons are loaded behind try/catch and have
    // JavaScript fallbacks. Keeping .node files external avoids esbuild trying
    // to bundle architecture-specific binaries for the standalone packages.
    external: ["@aws-sdk/client-s3", "*.node"],
    define: {
      "import.meta.url": "import_meta_url",
      PANEL_VERSION: JSON.stringify(panelVersion),
      PANEL_BUILD_SHA: JSON.stringify(buildSha),
      PANEL_API_CONTRACT_VERSION: JSON.stringify(apiContractVersion),
      PANEL_BRIDGE_LUA_B64: JSON.stringify(panelBridgeLuaB64),
    },
    banner: {
      js: "const import_meta_url = require('url').pathToFileURL(__filename).href;",
    },
  });

  console.log("Server bundled successfully");

  const pkgConfig = {
    name: "zomboid-control-panel",
    version: panelVersion,
    bin: "server.cjs",
    pkg: {
      scripts: "server.cjs",
      targets: targets.map((target) => `node22-${target}-x64`),
      outputPath: ".",
    },
  };

  fs.writeFileSync(
    "./dist-exe/package.json",
    JSON.stringify(pkgConfig, null, 2),
  );

  console.log(`Creating executables for: ${targets.join(", ")}`);
  try {
    // @yao-pkg/pkg is the actively maintained fork of vercel/pkg (which is
    // stuck on Node 18.5). Its CLI is also named `pkg`.
    // Build without embedded V8 bytecode cache so binaries remain portable
    // across Linux hosts and don't fail with "V8 rejected the bytecode cache".
    execSync('npx pkg . --compress GZip --public --public-packages "*"', {
      cwd: distDir,
      stdio: "inherit",
    });
  } catch (error) {
    console.error("Failed to create executable(s):", error.message);
    process.exit(1);
  }

  const builtArtifacts = [];
  for (const target of targets) {
    const sourceBinary = resolveBuiltBinaryPath(target);
    const targetBinary =
      target === "linux"
        ? "./release/ZomboidControlPanel"
        : "./release/ZomboidControlPanel.exe";

    if (!sourceBinary) {
      console.error(`Missing build output for target: ${target}`);
      process.exit(1);
    }

    fs.copyFileSync(sourceBinary, targetBinary);
    if (target === "linux") {
      fs.chmodSync(targetBinary, 0o755);
    }

    builtArtifacts.push({
      platform: target,
      fileName: path.basename(targetBinary),
      absolutePath: path.resolve(targetBinary),
    });
  }

  console.log("Creating release package...");

  const clientDist = "./client/dist";
  const targetClientDist = "./release/client/dist";
  if (fs.existsSync(clientDist)) {
    fs.cpSync(clientDist, targetClientDist, { recursive: true });
  } else {
    console.error(
      'Client dist not found. Run "npm run build" in client first.',
    );
    process.exit(1);
  }

  // Ship the install guides IN the archive, not just as GitHub pointers.
  // README.txt's own "Where To Go Next" section names these paths -- on a
  // LAN-only box with no outbound internet, a github.com link is dead
  // weight, so the files themselves have to be sitting right here for that
  // section to be true. release.ps1 zips release/* as-is, so anything
  // copied into release/ ships automatically with no workflow change.
  const installDocsSrc = "./docs/install";
  const installDocsDest = "./release/docs/install";
  if (fs.existsSync(installDocsSrc)) {
    fs.mkdirSync(installDocsDest, { recursive: true });
    const guideFiles = fs
      .readdirSync(installDocsSrc)
      .filter((file) => file.endsWith(".md"));
    for (const file of guideFiles) {
      fs.copyFileSync(
        path.join(installDocsSrc, file),
        path.join(installDocsDest, file),
      );
    }
  } else {
    console.warn(
      "docs/install not found -- release will ship without install guides",
    );
  }

  // IMPORTANT: do NOT ship a real `data/db.json` in the release tarball.
  //
  // Users who extract a new release over an existing install (e.g. `tar xzf`
  // or unzipping into the install directory) would have their live database
  // — admin account, server configs, scheduled tasks, all settings —
  // overwritten by an empty stub. We learned this the hard way from issue #5
  // where a user lost everything on a manual upgrade to v1.0.15.
  //
  // The server creates `data/db.json` automatically on first run via LowDB's
  // `defaultData` (see server/database/init.js). We only ship a reference
  // example file and a README warning so users see what shape the file takes
  // without risking their real data.
  fs.mkdirSync("./release/data", { recursive: true });

  const exampleDbSrc = "./data/db.example.json";
  if (fs.existsSync(exampleDbSrc)) {
    fs.copyFileSync(exampleDbSrc, "./release/data/db.example.json");
  } else {
    // Fallback if the example file isn't present in dev — write a minimal one.
    const defaultDb = {
      settings: {
        serverPath: "",
        serverExe: "",
        rconPassword: "",
        rconPort: 27015,
        adminPassword: "",
      },
      players: [],
      scheduledTasks: [],
      servers: [],
      discord: {
        enabled: false,
        token: "",
        guildId: "",
        channelId: "",
        adminRoleId: "",
      },
    };
    fs.writeFileSync(
      "./release/data/db.example.json",
      JSON.stringify(defaultDb, null, 2),
    );
  }

  // Drop a clear upgrade warning next to the example so anyone poking around
  // the data folder during a manual upgrade understands what NOT to overwrite.
  const dataReadme = `data/ — Panel runtime database
=================================

This folder holds the panel's runtime state:

  db.json          Created automatically on first run. Contains your admin
                   account, server configurations, scheduled tasks, mod
                   tracking data, scheduled task history, and all settings.
                   DO NOT delete or overwrite this file — you will lose all
                   your configuration.

  backups/         Auto-rotating snapshots of db.json (every 6h, last 5 kept).
                   The panel will try to restore from the most recent backup
                   if db.json becomes corrupt.

  db.example.json  Reference structure only. Safe to delete.

UPGRADING THE PANEL
-------------------
When upgrading by extracting a release archive over your existing install,
make sure your archive tool does NOT overwrite \`data/db.json\` (or the
\`data/backups/\` folder). Modern releases ship only \`data/db.example.json\`
inside the archive precisely so a plain extract is safe — but if you are
restoring from an older release that contained a real \`db.json\`, exclude
the data/ folder from extraction.

Recommended safe-upgrade commands:

  Linux:   tar xzf release.tar.gz --exclude='data/db.json' --exclude='data/backups'
  Windows: extract everything EXCEPT the data/ folder, or back up data/ first.
`;
  fs.writeFileSync("./release/data/README.txt", dataReadme);

  fs.mkdirSync("./release/logs", { recursive: true });
  fs.writeFileSync("./release/logs/.gitkeep", "");

  if (fs.existsSync("./pz-mod")) {
    fs.cpSync("./pz-mod", "./release/pz-mod", { recursive: true });
  }

  // Ship the browser extension folder. Users can either "Load unpacked"
  // directly from this folder, or zip it themselves.
  if (fs.existsSync("./browser-extension")) {
    fs.cpSync("./browser-extension", "./release/browser-extension", {
      recursive: true,
    });

    // Best-effort standalone zip for the GitHub release asset. Skipped on
    // platforms without PowerShell (Linux build hosts), which is fine —
    // release.ps1 also builds it as part of step 4.
    if (process.platform === "win32") {
      try {
        execSync(
          'powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path browser-extension/* -DestinationPath release/zomboid-panel-extension.zip -Force"',
          { stdio: "inherit" },
        );
      } catch (err) {
        console.warn("Could not build browser-extension zip:", err.message);
      }
    }
  }

  // Ship the sql.js WASM blob next to the executable. vehiclesDb.js loads it
  // at runtime to delete rows from the save's vehicles.db. The file is tiny
  // (~660 KB) and pkg can't introspect sql.js's dynamic require, so we copy
  // it manually.
  const wasmSrc = "./node_modules/sql.js/dist/sql-wasm.wasm";
  if (fs.existsSync(wasmSrc)) {
    fs.copyFileSync(wasmSrc, "./release/sql-wasm.wasm");
  } else {
    console.warn(
      "sql-wasm.wasm not found in node_modules/sql.js/dist — vehicle cleanup will fail at runtime. Run `npm install` first.",
    );
  }

  if (fs.existsSync("./zomboid-panel.service")) {
    fs.copyFileSync(
      "./zomboid-panel.service",
      "./release/zomboid-panel.service",
    );
  }

  if (fs.existsSync("./docker-compose.install.yml")) {
    fs.copyFileSync(
      "./docker-compose.install.yml",
      "./release/docker-compose.install.yml",
    );
  }

  const startBat = generateStartBat();
  fs.writeFileSync("./release/Start.bat", startBat);

  const startSh = generateStartSh();
  fs.writeFileSync("./release/start.sh", startSh.replace(/\r\n/g, "\n"), {
    mode: 0o755,
  });

  const checksumLines = [];
  const manifestArtifacts = [];
  for (const artifact of builtArtifacts) {
    const checksum = sha256File(artifact.absolutePath);
    checksumLines.push(`${checksum}  ${artifact.fileName}`);
    manifestArtifacts.push({
      platform: artifact.platform,
      file: artifact.fileName,
      sha256: checksum,
    });
  }

  fs.writeFileSync("./release/checksums.txt", `${checksumLines.join("\n")}\n`);
  fs.writeFileSync(
    "./release/release-manifest.json",
    JSON.stringify(
      {
        version: panelVersion,
        buildSha,
        apiContractVersion,
        builtAt: new Date().toISOString(),
        hostPlatform: process.platform,
        targets,
        artifacts: manifestArtifacts,
      },
      null,
      2,
    ),
  );

  writeReleaseReadme();

  console.log("Release package created successfully");
  console.log("Location: ./release/");
  console.log("Contents:");
  for (const artifact of builtArtifacts) {
    console.log(`  - ${artifact.fileName} (${artifact.platform})`);
  }
  console.log("  - Start.bat");
  console.log("  - start.sh");
  console.log("  - checksums.txt");
  console.log("  - release-manifest.json");
  console.log("  - client/dist/");
  console.log("  - data/");
  console.log("  - logs/");
  console.log("  - pz-mod/");
  if (fs.existsSync("./release/docs/install")) {
    console.log("  - docs/install/");
  }
  if (fs.existsSync("./release/zomboid-panel.service")) {
    console.log("  - zomboid-panel.service");
  }
  if (fs.existsSync("./release/docker-compose.install.yml")) {
    console.log("  - docker-compose.install.yml");
  }
  console.log("  - README.txt");
}

const isMainModule =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
