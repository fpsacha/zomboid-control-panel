import esbuild from "esbuild";
import archiver from "archiver";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { gzipSync } from "zlib";
import { pathToFileURL } from "url";

const distDir = "./dist-exe";
const releaseDir = "./release";
const linuxArchiveStagingPath = "./ZomboidControlPanel-linux.tar.gz";
const linuxArchivePath = "./release/ZomboidControlPanel-linux.tar.gz";

// Files in the Linux release tree that must carry the executable bit. NTFS
// has no POSIX exec bit, so a Windows host's own fs.chmodSync()/writeFileSync
// mode option is a real no-op here -- whatever ad hoc tool later turns
// release/ into a .tar.gz would have to guess, and every one we tried
// guessed differently (bsdtar strips all exec bits; MSYS tar restores them
// by file-extension heuristic, missing the extensionless binary; a DrvFs
// mount over-grants everything). Packaging in-process with explicit
// per-entry modes removes the guess entirely, on any host.
const LINUX_ARCHIVE_EXECUTABLE_NAMES = new Set([
  "ZomboidControlPanel",
  "start.sh",
  "install-linux-service.sh",
]);

function createLinuxReleaseArchive(sourceDir, archivePath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(archivePath);
    const archive = archiver("tar", { gzip: true });

    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);

    archive.directory(sourceDir, false, (entry) => {
      if (entry.stats.isDirectory()) {
        entry.mode = 0o755;
      } else {
        entry.mode = LINUX_ARCHIVE_EXECUTABLE_NAMES.has(path.basename(entry.name))
          ? 0o755
          : 0o644;
      }
      return entry;
    });

    archive.finalize();
  });
}
const DEFAULT_API_CONTRACT_VERSION = 1;

export function resolveBuildSha(env = process.env) {
  const configured = String(env.GITHUB_SHA || env.PANEL_BUILD_SHA || "").trim();
  if (configured) return configured;
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export function resolveApiContractVersion(env = process.env) {
  const parsed = Number(env.PANEL_API_CONTRACT_VERSION);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_API_CONTRACT_VERSION;
}

export function createEmbeddedClientBundle(clientDist, expectedMetadata) {
  const files = {};
  const walk = (directory, relativeDirectory = "") => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path
        .join(relativeDirectory, entry.name)
        .split(path.sep)
        .join("/");
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files[relativePath] = fs.readFileSync(absolutePath).toString("base64");
      } else {
        throw new Error(`Unsupported client build entry: ${relativePath}`);
      }
    }
  };

  walk(clientDist);
  if (!files["index.html"] || !files["build-info.json"]) {
    throw new Error("Client build is missing index.html or build-info.json");
  }

  let clientMetadata;
  try {
    clientMetadata = JSON.parse(
      Buffer.from(files["build-info.json"], "base64").toString("utf8"),
    );
  } catch (error) {
    throw new Error(`Client build metadata is invalid: ${error.message}`, {
      cause: error,
    });
  }
  if (
    clientMetadata.panelVersion !== expectedMetadata.panelVersion ||
    clientMetadata.buildSha !== expectedMetadata.buildSha ||
    Number(clientMetadata.apiContractVersion) !==
      expectedMetadata.apiContractVersion
  ) {
    throw new Error("Client build metadata does not match the executable build");
  }

  return gzipSync(
    Buffer.from(JSON.stringify({ schemaVersion: 1, files }), "utf8"),
  ).toString("base64");
}

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

export function getClientDistFileHashes(clientDist) {
  const hashes = {};
  const walk = (directory, relativeDirectory = "") => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path
        .join(relativeDirectory, entry.name)
        .split(path.sep)
        .join("/");
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        hashes[relativePath] = sha256File(absolutePath);
      } else {
        throw new Error(`Unsupported client build entry: ${relativePath}`);
      }
    }
  };
  walk(clientDist);
  return hashes;
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
- install-linux-service.sh - explicit systemd installer; run with --enable to start the service
- docker-compose.install.yml - Docker Compose installer (published panel image)
- docs/install/            - Install guides for every platform (see Where To Go Next, above)
- client/dist/             - Web interface copy for manual upgrades and legacy installs
- data/db.json             - Configuration database (created on first run; NEVER overwrite when upgrading — see data/README.txt)
- data/db.example.json     - Reference db structure (safe to delete)
- data/README.txt          - Upgrade-safety notes for the data/ folder
- logs/                    - Application logs
- pz-mod/                  - PanelBridge server-side Lua (drop into Install/media/lua/server)
- checksums.txt            - SHA256 hashes for release archives
- release-manifest.json    - Build metadata for this package

The standalone binary embeds the matching web interface and can recover from
an older or missing client/dist folder. Keep client/dist when using the
journaled updater or a manual archive upgrade; it is still retained in the
package for compatibility with older binaries.

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
  //
  // Rollback-retry protection (2026-09-04, god's design review of Angela's
  // :rollback_update proposal): a stuck .update-pending and a stuck
  // .update-applying are NOT the same risk and must not get the same
  // treatment. .update-pending re-triggers a fresh :apply_update on the next
  // restart (run_loop's own `if exist MARKER` check below) -- a genuinely
  // different attempt each time, against possibly-changed external
  // conditions (an AV scan finishing, OneDrive releasing a lock), naturally
  // rate-limited to once per restart, a human-paced action. Retention here
  // is deliberately unbounded and untouched by this change -- Dwight proved
  // it rescues a real transient failure (a relaunch completed his pending
  // update once he released a file lock).
  //
  // .update-applying is different in kind, not just in which file survives.
  // It only exists once :apply_update has ALREADY succeeded and the new
  // binary has ALREADY been launched -- the swap is done, so there is
  // nothing left to retry there. If that binary never acknowledges startup,
  // the handshake check below calls :rollback_update to undo the swap; if
  // THAT also fails, retrying is not a fresh attempt at anything, it is the
  // identical file-restore operation run again against a state nothing has
  // changed about, at crash-loop cadence (every relaunch, seconds apart,
  // not every restart). Two of :rollback_update's three failure shapes
  // ("backup is missing") are permanent -- there is nothing to restore FROM,
  // ever -- and even the plausibly-transient third ("could not be removed" /
  // "could not be activated", the same held-lock class .update-pending's
  // retry can recover from) does not need more than one or two genuine
  // attempts. So: bounded at MAX_ROLLBACK_RETRIES, then halt rather than
  // loop -- and halting is strictly better than looping here, not merely
  // safer, because the panel is ALREADY down in this scenario (the new
  // binary never acknowledged startup); this is a choice between a visible
  // stop and an invisible loop, not between running and stopped. The halt
  // message names the same three files
  // (.update-pending/.update-applying/update-bundle.json) the panel's own
  // Settings.tsx rollback_failed hint already tells the operator to delete
  // by hand, because this is exactly the one case that hint cannot reach --
  // there is no running panel left to render it in.
  //
  // Rollback false-positive fix (2026-09-04, Dwight's finding): the inverse
  // defect from everything above -- the log says broken, the state is fine.
  // :rollback_update used to decide "was a backup made?" by asking only
  // whether %BIN_BACKUP% / %CLIENT_BACKUP% exist on disk. When the backup
  // MOVE step itself is what failed (a locked file inside client\\dist, an
  // AV scan holding a handle), no backup was ever created -- but the live
  // copy was never disturbed either, since a failed move leaves its source
  // in place. That is a completely safe state: nothing to restore, nothing
  // broken. The old code could not tell that apart from a genuinely lost
  // backup (one that existed and then vanished), so it reported the safe
  // case as "[rollback_failed] ... journal retained for recovery" -- an
  // operator reading that would reasonably believe their panel was damaged
  // when it was not. EXE_BACKUP_MADE / CLIENT_BACKUP_MADE below track
  // whether each backup step actually RAN and SUCCEEDED, set once per
  // :apply_update attempt, so :rollback_update can tell "nothing to
  // restore" apart from "backup missing" without weakening the genuine
  // failure path -- a real lost/corrupted backup still trips
  // [rollback_failed] exactly as before.
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
set "CLIENT_LIVE=%INSTALL_DIR%client\\dist"
set "CLIENT_BACKUP=%INSTALL_DIR%client\\dist.previous"
set "LOG_DIR=%INSTALL_DIR%logs"
set "LOG_FILE=%LOG_DIR%\\supervisor.log"

set "MAX_RAPID_CRASHES=5"
set "MIN_STABLE_SECONDS=60"
set "BACKOFF_BASE_SECONDS=2"
set "BACKOFF_CAP_SECONDS=30"
set "CRASH_COUNT=0"
if defined PANEL_SUPERVISOR_MAX_CRASHES set "MAX_RAPID_CRASHES=%PANEL_SUPERVISOR_MAX_CRASHES%"
if defined PANEL_SUPERVISOR_MIN_STABLE_SECONDS set "MIN_STABLE_SECONDS=%PANEL_SUPERVISOR_MIN_STABLE_SECONDS%"

rem === See "Rollback-retry protection" above. In-memory only (mirrors    ===
rem === CRASH_COUNT's own choice) -- resets on a full supervisor restart, ===
rem === a legitimately fresh context worth one more shot.                 ===
set "MAX_ROLLBACK_RETRIES=2"
set "ROLLBACK_RETRY_COUNT=0"
if defined PANEL_SUPERVISOR_MAX_ROLLBACK_RETRIES set "MAX_ROLLBACK_RETRIES=%PANEL_SUPERVISOR_MAX_ROLLBACK_RETRIES%"

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
    if !ROLLBACK_RETRY_COUNT! GEQ !MAX_ROLLBACK_RETRIES! goto rollback_retry_exhausted
    set /a ROLLBACK_RETRY_COUNT+=1
    call :stamp "Apply: startup handshake failed; rolling back bundle, retry !ROLLBACK_RETRY_COUNT! of !MAX_ROLLBACK_RETRIES! [startup_handshake_failed]"
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

rem "exit /b" inside a parenthesized block nested two deep (the "if exist
rem APPLYING ( if !COUNT! GEQ !CAP! ( ... exit /b 1 ) ... )" shape) does not
rem reliably propagate its exit code back to the parent "cmd.exe /c" process
rem -- confirmed empirically (a minimal repro returned 0 instead of 1 from
rem inside such a block; moving the same exit /b to an unnested label reached
rem via goto returned 1 correctly every time). This label exists so the halt
rem below runs unnested, the same way the "no exe found" halt above does
rem (single level of nesting, which does not hit this problem).
:rollback_retry_exhausted
  call :stamp "Apply: startup handshake failed again after !ROLLBACK_RETRY_COUNT! rollback retries -- halting rather than looping [rollback_retry_exhausted]"
  echo.
  echo ERROR: The panel update failed to apply, and the automatic rollback
  echo could not fully recover after !ROLLBACK_RETRY_COUNT! attempts. To avoid
  echo repeating the same failure forever, the panel will not restart itself.
  echo.
  echo To recover manually, delete these files from this folder, then run
  echo Start.bat again:
  echo   .update-pending
  echo   .update-applying
  echo   update-bundle.json
  pause
  exit /b 1


rem ============================================================
rem :apply_update  — activate the journaled frontend/backend bundle.
rem  - Picks newest of .exe.new / .exe.new2 as the binary source.
rem  - Backs up current .exe and client\\dist under fixed transaction names.
rem  - Keeps both backups until the new backend acknowledges listener startup.
rem ============================================================
:apply_update
  call :stamp "Apply: marker present, beginning swap"
  rem See "Rollback false-positive fix" above. Reset per attempt -- these
  rem must never carry a stale value into a later :rollback_update call.
  set "EXE_BACKUP_MADE=0"
  set "CLIENT_BACKUP_MADE=0"

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

  rem Presence alone (the STAGED_NAME lookup above) does not catch a file
  rem that exists under the right name but was partially written or
  rem corrupted after staging -- the 1-2 second window Dwight measured
  rem between the last presence check and this rename. journal.hashes
  rem .binarySha256 is already computed and written for both platforms by
  rem stageUpdateBundle() (updateBundle.js); the Linux apply path
  rem (applyUpdateBundle()) already verifies against it before touching
  rem anything. This mirrors that check on Windows, with the same
  rem [av_quarantine] failure code Linux uses for a hash mismatch.
  rem main-is-red, 2026-09-05: this check reports [MISMATCH] on a genuinely
  rem uncorrupted staged binary on a clean, unprivileged GitHub windows-2022
  rem runner -- reproduced 5/5 times across every test that reaches this
  rem line, never once locally. The status string below now carries the
  rem actual/expected hashes (or the exception message, if Get-FileHash
  rem itself throws) into the log line instead of a bare MISMATCH, so the
  rem next run says WHICH of those it actually is instead of requiring
  rem another round trip to find out.
  set "STAGED_HASH_STATUS="
  for /f "usebackq delims=" %%F in (\`powershell -NoProfile -Command "$j = Get-Content -LiteralPath $env:JOURNAL -Raw | ConvertFrom-Json; $expected = $j.hashes.binarySha256; if (-not $expected) { 'NOHASH' } else { try { $actual = (Get-FileHash -LiteralPath $env:STAGED_NAME -Algorithm SHA256).Hash; if ($actual -ieq $expected) { 'OK' } else { 'MISMATCH actual=' + $actual + ' expected=' + $expected } } catch { 'ERROR ' + $_.Exception.Message } }"\`) do set "STAGED_HASH_STATUS=%%F"

  if not "!STAGED_HASH_STATUS!"=="OK" (
    call :stamp "Apply: staged binary hash check [!STAGED_HASH_STATUS!] -- refusing to apply [av_quarantine]"
    del /f /q "%MARKER%" >nul 2>&1
    goto :eof
  )

  set "STAGED_CLIENT="
  for /f "usebackq delims=" %%F in (\`powershell -NoProfile -Command "$j=Get-Content -LiteralPath $env:JOURNAL -Raw | ConvertFrom-Json; $j.paths.stagedClient"\`) do set "STAGED_CLIENT=%%F"
  if not defined STAGED_CLIENT (
    call :stamp "Apply: staged frontend path missing from journal [version_mismatch]"
    goto :eof
  )
  if not exist "!STAGED_CLIENT!\\index.html" (
    call :stamp "Apply: staged frontend missing index.html [frontend_swap_failed]"
    goto :eof
  )

  rem Mirrors the staged-binary hash check above, for the frontend bundle.
  rem Content integrity here was never checked on either platform (only the
  rem binary was ever hashed) -- confirmed while researching this: the
  rem journal.hashes.clientFiles map that looked like a ready-made answer is
  rem a *different* artifact (release-manifest.json, for GitHub releases,
  rem read by release.ps1), never written into this runtime journal.
  rem journal.hashes.clientSha256 is a single combined hash over every staged
  rem client file (relative path + per-file sha256, ordinal-sorted, then
  rem hashed together) computed by stageUpdateBundle() (updateBundle.js) and
  rem verified there before every apply on Linux; this reproduces the exact
  rem same value on Windows, same [av_quarantine] failure code as the binary.
  set "STAGED_CLIENT_HASH_STATUS="
  for /f "usebackq delims=" %%F in (\`powershell -NoProfile -Command "$j = Get-Content -LiteralPath $env:JOURNAL -Raw | ConvertFrom-Json; $expected = $j.hashes.clientSha256; if (-not $expected) { 'NOHASH' } else { $root = (Resolve-Path -LiteralPath $env:STAGED_CLIENT).Path; $pairs = @(Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object { $rel = $_.FullName.Substring($root.Length + 1).Replace([char]92,[char]47); $h = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); $rel + '|' + $h }); [System.Array]::Sort($pairs, [System.StringComparer]::Ordinal); $nul = [char]0; $nl = [char]10; $combined = ($pairs | ForEach-Object { $p = $_.Split('|',2); $p[0] + $nul + $p[1] + $nl }) -join ''; $bytes = [System.Text.Encoding]::UTF8.GetBytes($combined); $actual = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-','').ToLowerInvariant(); if ($actual -ieq $expected) { 'OK' } else { 'MISMATCH' } }"\`) do set "STAGED_CLIENT_HASH_STATUS=%%F"

  if not "!STAGED_CLIENT_HASH_STATUS!"=="OK" (
    call :stamp "Apply: staged frontend hash check [!STAGED_CLIENT_HASH_STATUS!] -- refusing to apply [av_quarantine]"
    del /f /q "%MARKER%" >nul 2>&1
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
  set "EXE_BACKUP_MADE=1"

:do_rename
  if exist "%CLIENT_LIVE%" (
    move "%CLIENT_LIVE%" "%CLIENT_BACKUP%" >nul 2>&1
    if errorlevel 1 (
      call :stamp "Apply: could not back up live frontend [frontend_swap_failed]"
      call :rollback_update
      goto :eof
    )
    set "CLIENT_BACKUP_MADE=1"
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
  rem A fresh, successfully-activated bundle is a new incident, not a
  rem continuation of whatever handshake failures a PREVIOUS bundle may have
  rem hit -- reset here so an old, already-resolved retry count can never
  rem count against an unrelated later update.
  set "ROLLBACK_RETRY_COUNT=0"
  call :stamp "Apply: bundle activated; waiting for backend startup acknowledgement"
goto :eof


:rollback_update
  call :stamp "Apply: restoring previous frontend and backend"
  set "ROLLBACK_FAILED=0"
  set "BINARY_RESTORE_OK=1"
  if "!EXE_BACKUP_MADE!"=="0" goto :rollback_binary_skip
  if not exist "%BIN_BACKUP%" (
    call :stamp "Apply: binary restore failed; backup is missing [rollback_failed]"
    set "BINARY_RESTORE_OK=0"
    goto :rollback_binary_done
  )
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
  goto :rollback_binary_done

:rollback_binary_skip
  call :stamp "Apply: binary restore skipped; backup step never ran, executable untouched"

:rollback_binary_done
  if "!BINARY_RESTORE_OK!"=="0" set "ROLLBACK_FAILED=1"

  set "CLIENT_RESTORE_OK=1"
  if "!CLIENT_BACKUP_MADE!"=="0" goto :rollback_client_skip
  if not exist "%CLIENT_BACKUP%" (
    call :stamp "Apply: frontend restore failed; backup is missing [rollback_failed]"
    set "CLIENT_RESTORE_OK=0"
    goto :rollback_client_done
  )
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
  goto :rollback_client_done

:rollback_client_skip
  call :stamp "Apply: frontend restore skipped; backup step never ran, live frontend untouched"

:rollback_client_done
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
# Zomboid Control Panel — Linux supervisor
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

export PANEL_SUPERVISOR_V=2
export PANEL_PRESERVE_GAME_SERVERS=1

PANEL_PID=""
STOPPING=0
CRASH_COUNT=0
MAX_RAPID_CRASHES="\${PANEL_SUPERVISOR_MAX_CRASHES:-5}"
# 2026-09-04, Dwight's finding: this used to be a flat BACKOFF_SECONDS
# (default 2, no escalation), while Start.bat's crash-loop protection has
# always ramped BACKOFF_BASE_SECONDS*CRASH_COUNT up to BACKOFF_CAP_SECONDS --
# so a Windows install got up to ~30s of spaced-out retries across its
# MAX_RAPID_CRASHES attempts before giving up, and a Linux install got only
# ~10s (5 attempts x a flat 2s) for the identical fault. Same tunable names
# and defaults as Start.bat now, including the PANEL_SUPERVISOR_BACKOFF_SECONDS
# escape hatch (still an explicit FIXED override when set, same as Windows --
# tests use this to force a 0s backoff for speed).
MIN_STABLE_SECONDS="\${PANEL_SUPERVISOR_MIN_STABLE_SECONDS:-60}"
BACKOFF_BASE_SECONDS="\${PANEL_SUPERVISOR_BACKOFF_BASE_SECONDS:-2}"
BACKOFF_CAP_SECONDS="\${PANEL_SUPERVISOR_BACKOFF_CAP_SECONDS:-30}"

stop_panel() {
  STOPPING=1
  if [ -n "$PANEL_PID" ] && kill -0 "$PANEL_PID" 2>/dev/null; then
    # The panel has its own session. Its detached Project Zomboid process has
    # another process group, so this signal cannot stop the game server.
    kill -TERM -- "-$PANEL_PID" 2>/dev/null || kill -TERM "$PANEL_PID" 2>/dev/null || true
  fi
}

trap 'stop_panel TERM' TERM
trap 'stop_panel INT' INT

echo "Starting Zomboid Control Panel..."
echo ""

if [ ! -f "./ZomboidControlPanel" ]; then
  echo "ERROR: ./ZomboidControlPanel was not found in this folder."
  exit 1
fi

if ! command -v setsid >/dev/null 2>&1; then
  echo "ERROR: setsid is required to isolate panel restarts from Project Zomboid."
  echo "Install the util-linux package and try again."
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

while true; do
  if [ "$STOPPING" = "1" ]; then
    exit 0
  fi

  PANEL_STARTED_AT=$(date +%s)
  setsid ./ZomboidControlPanel &
  PANEL_PID=$!
  wait "$PANEL_PID"
  EXIT_CODE=$?
  PANEL_PID=""
  PANEL_RUNTIME=$(($(date +%s) - PANEL_STARTED_AT))

  if [ "$STOPPING" = "1" ]; then
    exit 0
  fi

  # A clean exit is an operator-requested stop. Exit code 75 is the explicit
  # updater hand-off; non-zero exits are restarted with a bounded backoff.
  if [ "$EXIT_CODE" = "0" ]; then
    exit 0
  fi

  if [ "$EXIT_CODE" = "75" ]; then
    CRASH_COUNT=0
    echo "Panel requested a supervised restart."
    continue
  fi

  if [ "$PANEL_RUNTIME" -ge "$MIN_STABLE_SECONDS" ]; then
    CRASH_COUNT=0
  fi
  CRASH_COUNT=$((CRASH_COUNT + 1))
  if [ "$CRASH_COUNT" -gt "$MAX_RAPID_CRASHES" ]; then
    echo "ERROR: Panel exited $CRASH_COUNT times; giving up (last exit $EXIT_CODE)."
    exit "$EXIT_CODE"
  fi

  if [ -n "\${PANEL_SUPERVISOR_BACKOFF_SECONDS:-}" ]; then
    BACKOFF="$PANEL_SUPERVISOR_BACKOFF_SECONDS"
  else
    BACKOFF=$((BACKOFF_BASE_SECONDS * CRASH_COUNT))
    if [ "$BACKOFF" -gt "$BACKOFF_CAP_SECONDS" ]; then
      BACKOFF="$BACKOFF_CAP_SECONDS"
    fi
  fi

  echo "Panel exited with code $EXIT_CODE; relaunch attempt $CRASH_COUNT of $MAX_RAPID_CRASHES, restarting in $BACKOFF second(s)..."
  sleep "$BACKOFF" &
  SLEEP_PID=$!
  wait "$SLEEP_PID" || true
done
`;
}

async function main() {
  const args = process.argv.slice(2);
  const targets = resolveTargets(args);
  const rootPkg = JSON.parse(fs.readFileSync("./package.json", "utf-8"));
  const panelVersion = rootPkg.version || "0.0.0";
  const buildSha = resolveBuildSha({
    GITHUB_SHA: process.env.GITHUB_SHA,
    PANEL_BUILD_SHA: process.env.PANEL_BUILD_SHA,
  });
  const apiContractVersion = resolveApiContractVersion();

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

  const embeddedClientDistB64 = createEmbeddedClientBundle("./client/dist", {
    panelVersion,
    buildSha,
    apiContractVersion,
  });
  const clientDistFileHashes = getClientDistFileHashes("./client/dist");
  console.log(
    `Embedded client bundle prepared (${embeddedClientDistB64.length} base64 chars)`,
  );

  console.log("Building server bundle...");

  console.log(
    `Version: ${panelVersion} (build ${buildSha}, API contract ${apiContractVersion})`,
  );

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
      PANEL_CLIENT_DIST_B64: JSON.stringify(embeddedClientDistB64),
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
  if (fs.existsSync("./install-linux-service.sh")) {
    fs.copyFileSync(
      "./install-linux-service.sh",
      "./release/install-linux-service.sh",
    );
    fs.chmodSync("./release/install-linux-service.sh", 0o755);
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
        clientFiles: clientDistFileHashes,
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
  if (fs.existsSync("./release/install-linux-service.sh")) {
    console.log("  - install-linux-service.sh");
  }
  if (fs.existsSync("./release/docker-compose.install.yml")) {
    console.log("  - docker-compose.install.yml");
  }
  console.log("  - README.txt");

  if (targets.includes("linux")) {
    console.log("Packaging Linux release archive...");
    // The archive must be created outside sourceDir: placing it inside the
    // tree being archived makes tar include its own output indefinitely.
    await createLinuxReleaseArchive(releaseDir, linuxArchiveStagingPath);
    fs.renameSync(linuxArchiveStagingPath, linuxArchivePath);
    console.log(`Wrote ${linuxArchivePath}`);
  }
}

const isMainModule =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
