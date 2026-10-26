<#
.SYNOPSIS
    Build and GitHub release pipeline for Zomboid Control Panel.

.DESCRIPTION
    This script automates the release process, self-contained in this repo
    (no external Dev1/ working copy, no \\garage SMB deploy — that
    infrastructure is retired; live deployment now happens separately via
    Docker on the production host):
    0. Pre-flight checks (clean main branch, Docker daemon reachable)
    1. Bumps version in package.json — a date version (YYYY.MM.N) if no -Version given
    2. Builds the client (Vite/React)
    3. Builds Windows + Linux binaries (esbuild + pkg) and packages archives
    4. Builds Docker image
    5. Commits and pushes to GitHub
    6. Creates a GitHub Release with Keep a Changelog format notes

    Steps 1-4 rewrite tracked files and then take a while to build. If any of
    them fails (or the run is interrupted), the files the version bump rewrote
    are put back with git, so a failed run leaves a clean tree for the next one.
    Just before the commit, origin/main is fetched again and the run stops (after
    the same restore) if it moved while the release was building.

.PARAMETER Version
    Release version as YYYY.MM.N (e.g., "2026.10.1"). If omitted, it is the next
    number for the current month: N goes up by one from package.json's version
    when that is in the same month, otherwise it starts at 1.

.PARAMETER ReleaseTitle
    Custom release title. Defaults to "v<Version>".

.PARAMETER ReleaseNotes
    Path to a markdown file with release notes. If omitted, auto-generates from commits.

.PARAMETER PanelBridgeVersion
    PanelBridge version to ship. If omitted, scripts/check-bridge-version.mjs --next
    picks it: the version stays the same while the normalized Lua/mod.info bytes
    match pz-mod/bridge-version.lock.json, and goes up one patch when they changed.
    An explicit value must not be below the lock, and must differ from it exactly
    when the code changed. The release rewrites the lock. It never publishes the
    Steam Workshop item; see scripts/workshop/publish.mjs.

.PARAMETER SkipBuild
    Skip the client and exe build steps (use existing release/ folder).

.PARAMETER SkipGitHub
    Skip git commit/push and GitHub release creation.

.PARAMETER SkipDocker
    Skip building the Docker image.

.PARAMETER DryRun
    Show what would happen without making changes.

.EXAMPLE
    .\release.ps1                                          # Next dated version for this month
    .\release.ps1 -Version "2026.10.1"                     # Explicit version
    .\release.ps1 -Version "2026.10.1" -SkipDocker         # Skip Docker build
    .\release.ps1 -DryRun                                  # Preview all steps
#>

param(
    [string]$Version = "",

    [string]$ReleaseTitle = "",

    [string]$ReleaseNotes = "",

    [string]$PanelBridgeVersion = "",

    [switch]$SkipBuild,
    [switch]$SkipGitHub,
    [switch]$SkipDocker,
    [switch]$DryRun
)

# ============================================
# CONFIGURATION - Edit these paths as needed
# ============================================
$RepoDir          = $PSScriptRoot
$GitHubRepo       = "fpsacha/zomboid-control-panel"

$ReleaseDir       = "release"
$WinExePath       = "release\ZomboidControlPanel.exe"
$LinuxBinPath     = "release\ZomboidControlPanel"
$WinZipPath       = "release\ZomboidControlPanel-windows.zip"
$LinuxTarPath     = "release\ZomboidControlPanel-linux.tar.gz"
$ChecksumsPath    = "release\checksums.txt"

# Every tracked file STEP 1 rewrites (the five version files, the PanelBridge
# Lua and mod.info, and the lock written by check-bridge-version.mjs
# --write-lock). A failed run puts these back; see Restore-ReleaseBumpFiles.
# Build output (release/, client/dist, dist-exe) is gitignored and not listed.
$ReleaseBumpFiles = @(
    "package.json",
    "package-lock.json",
    "client/package.json",
    "client/package-lock.json",
    "pz-mod/PanelBridge/media/lua/server/PanelBridge.lua",
    "pz-mod/PanelBridge/mod.info",
    "pz-mod/bridge-version.lock.json"
)

# ============================================
# HELPERS
# ============================================
$ErrorActionPreference = "Stop"

function Write-Step($step, $msg) {
    Write-Host ""
    Write-Host "[$step] $msg" -ForegroundColor Cyan
    Write-Host ("-" * 60) -ForegroundColor DarkGray
}

function Write-Ok($msg)   { Write-Host "  OK: $msg" -ForegroundColor Green }
function Write-Skip($msg) { Write-Host "  SKIP: $msg" -ForegroundColor Yellow }
function Write-Dry($msg)  { Write-Host "  DRY RUN: $msg" -ForegroundColor Magenta }
function Write-Warn($msg) { Write-Host "  WARN: $msg" -ForegroundColor Yellow }

function Compare-SemVer($left, $right) {
    $leftParts = ([string]$left -split '\.') | ForEach-Object { [int]$_ }
    $rightParts = ([string]$right -split '\.') | ForEach-Object { [int]$_ }
    for ($index = 0; $index -lt 3; $index++) {
        if ($leftParts[$index] -ne $rightParts[$index]) {
            return $leftParts[$index] - $rightParts[$index]
        }
    }
    return 0
}

function Get-LatestGitHubReleaseVersion {
    # Capture the full output first: piping a native command into Select-Object -First
    # stops the pipeline early, which kills gh and leaves a non-zero $LASTEXITCODE.
    $ghOutput = @(& gh release view --repo $GitHubRepo --json tagName --jq '.tagName' 2>$null)
    $ghExit = $LASTEXITCODE
    $tag = ([string]($ghOutput | Select-Object -First 1)).Trim()
    if ($ghExit -ne 0 -or $tag -notmatch '^v\d+\.\d+\.\d+$') {
        throw "Could not determine the latest numeric GitHub release tag"
    }
    return $tag.Substring(1)
}

function Read-BuildMetadata($path, $label) {
    if (-not (Test-Path $path)) {
        throw "$label build-info.json not found at $path"
    }
    try {
        return Get-Content $path -Raw | ConvertFrom-Json
    } catch {
        throw "$label build-info.json is not valid JSON: $path"
    }
}

function Assert-BuildMetadata($metadata, $expected, $label) {
    if ([string]$metadata.panelVersion -ne [string]$expected.version -or
        [string]$metadata.buildSha -ne [string]$expected.buildSha -or
        [int]$metadata.apiContractVersion -ne [int]$expected.apiContractVersion) {
        throw "$label metadata does not match release manifest (version/build SHA/API contract)"
    }
}

function Get-DirectoryFileHashes($root) {
    $rootPath = (Resolve-Path -LiteralPath $root).Path.TrimEnd([char[]]@('\', '/'))
    $hashes = @{}
    foreach ($file in Get-ChildItem -LiteralPath $rootPath -Recurse -File) {
        $relative = $file.FullName.Substring($rootPath.Length).TrimStart([char[]]@('\', '/')).Replace('\', '/')
        $hashes[$relative] = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
    }
    return $hashes
}

function Assert-DirectoryMatches($source, $target, $label) {
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        throw "$label source directory not found at $source"
    }
    if (-not (Test-Path -LiteralPath $target -PathType Container)) {
        throw "$label release directory not found at $target"
    }
    $sourceHashes = Get-DirectoryFileHashes $source
    $targetHashes = Get-DirectoryFileHashes $target
    $relativePaths = @($sourceHashes.Keys + $targetHashes.Keys | Sort-Object -Unique)
    foreach ($relative in $relativePaths) {
        if (-not $sourceHashes.ContainsKey($relative) -or -not $targetHashes.ContainsKey($relative)) {
            throw "$label contents differ: missing or extra file $relative"
        }
        if ($sourceHashes[$relative] -ne $targetHashes[$relative]) {
            throw "$label contents differ: file hash mismatch for $relative"
        }
    }
}

function Assert-DirectoryMatchesManifest($source, $manifestFiles, $label) {
    if (-not $manifestFiles) {
        throw "$label file hashes are missing from release-manifest.json"
    }
    $actualHashes = Get-DirectoryFileHashes $source
    $expectedHashes = @{}
    foreach ($property in $manifestFiles.PSObject.Properties) {
        $expectedHashes[$property.Name] = ([string]$property.Value).ToLowerInvariant()
    }
    $relativePaths = @($actualHashes.Keys + $expectedHashes.Keys | Sort-Object -Unique)
    foreach ($relative in $relativePaths) {
        if (-not $actualHashes.ContainsKey($relative) -or -not $expectedHashes.ContainsKey($relative)) {
            throw "$label does not match manifest: missing or extra file $relative"
        }
        if ($actualHashes[$relative] -ne $expectedHashes[$relative]) {
            throw "$label does not match manifest: file hash mismatch for $relative"
        }
    }
}

function Assert-ReleaseVersionParity($expectedPanelVersion, $expectedBridgeVersion) {
    $rootPackage = Get-Content (Join-Path $RepoDir "package.json") -Raw | ConvertFrom-Json
    $rootLock = Get-Content (Join-Path $RepoDir "package-lock.json") -Raw | ConvertFrom-Json -AsHashtable
    $clientPackage = Get-Content (Join-Path $RepoDir "client\package.json") -Raw | ConvertFrom-Json
    $clientLock = Get-Content (Join-Path $RepoDir "client\package-lock.json") -Raw | ConvertFrom-Json -AsHashtable
    $rootLockPackage = $rootLock["packages"][""]
    $clientLockPackage = $clientLock["packages"][""]
    $versions = @(
        @{ Label = "package.json"; Value = $rootPackage.version },
        @{ Label = "package-lock.json"; Value = $rootLock.version },
        @{ Label = "package-lock.json root package"; Value = $rootLockPackage.version },
        @{ Label = "client/package.json"; Value = $clientPackage.version },
        @{ Label = "client/package-lock.json"; Value = $clientLock.version },
        @{ Label = "client/package-lock.json root package"; Value = $clientLockPackage.version }
    )
    foreach ($version in $versions) {
        if ([string]$version.Value -ne [string]$expectedPanelVersion) {
            throw "$($version.Label) is $($version.Value), expected $expectedPanelVersion"
        }
    }

    $luaPath = Join-Path $RepoDir "pz-mod\PanelBridge\media\lua\server\PanelBridge.lua"
    $modInfoPath = Join-Path $RepoDir "pz-mod\PanelBridge\mod.info"
    $lua = Get-Content $luaPath -Raw
    $modInfo = Get-Content $modInfoPath -Raw
    $header = [regex]::Matches($lua, '(?m)^\s*Version:\s*([^\r\n]+)\r?$')
    $runtime = [regex]::Matches($lua, '(?m)^\s*VERSION\s*=\s*"([^"]+)"')
    $manifest = [regex]::Matches($modInfo, '(?m)^modversion=([^\r\n]+)\r?$')
    if ($header.Count -ne 1 -or $runtime.Count -ne 1 -or $manifest.Count -ne 1) {
        throw "PanelBridge version declarations are missing or duplicated"
    }
    if ($header[0].Groups[1].Value.Trim() -ne $expectedBridgeVersion -or
        $runtime[0].Groups[1].Value -ne $expectedBridgeVersion -or
        $manifest[0].Groups[1].Value -ne $expectedBridgeVersion) {
        throw "PanelBridge versions do not match: expected $expectedBridgeVersion"
    }
}

# Extracts the hand-written prose under CHANGELOG.md's "## [$version]" heading,
# up to (not including) the next "## [" heading. Returns $null if the file or
# the heading is missing -- STEP 0 already requires the heading to exist, but
# this stays a soft fallback rather than a hard dependency, since generating a
# GitHub release is not itself changelog maintenance.
function Get-ChangelogSection($changelogPath, $version) {
    if (-not (Test-Path $changelogPath)) { return $null }
    $raw = Get-Content $changelogPath -Raw
    $pattern = "(?ms)^## \[$([regex]::Escape($version))\][^\r\n]*\r?\n(.*?)(?=^## \[|\z)"
    $match = [regex]::Match($raw, $pattern)
    if (-not $match.Success) { return $null }
    return $match.Groups[1].Value.Trim("`r", "`n")
}

# Generated release notes reach gh as a file (--notes-file), never inline with
# --notes. Windows caps a whole command line at 32,767 characters, and one
# CHANGELOG section can come close on its own (1.4.0's is about 28K). Past the
# cap gh cannot even start, and by then step 5 has already pushed main.
function Write-GeneratedReleaseNotes($notes, $tagName) {
    $notesPath = Join-Path ([System.IO.Path]::GetTempPath()) "zcp-$tagName-notes-$([guid]::NewGuid().ToString('N')).md"
    [System.IO.File]::WriteAllText($notesPath, $notes, [System.Text.UTF8Encoding]::new($false))
    return $notesPath
}

# One line that runs the same command again when pasted into PowerShell.
function Format-PowerShellCommandLine($command, $arguments) {
    $parts = @($command) + @($arguments | ForEach-Object {
        $text = [string]$_
        if ($text -eq "" -or $text -match '[\s''"`$;&|(){}@,<>#]') { "'" + ($text -replace "'", "''") + "'" } else { $text }
    })
    return $parts -join " "
}

# STEP 1 rewrites tracked files and nothing but a commit makes that permanent,
# so a real run starts only from main. A dry run writes nothing and may be
# tried on any branch. Called before anything is fetched or written.
function Assert-ReleaseBranch($branch, $isDryRun) {
    if ($isDryRun) { return }
    if ($branch -ne "main") {
        throw "Releases must be run from the main branch; current branch is '$branch'. Nothing was changed (-DryRun previews a release from any branch)."
    }
}

# STEP 4 builds the Docker image after STEP 1 has bumped the version and STEP 3
# has spent minutes on the binaries; a Docker Desktop that was not running used
# to surface only there, as "Docker build failed". Checked in STEP 0 instead.
# A machine without Docker on PATH keeps the old behaviour (STEP 4 skips the
# build with a warning); one that has it but cannot reach the daemon stops here.
function Assert-DockerReady {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Warn "Docker not found on PATH -- STEP 4 will skip the Docker build"
        return
    }
    $dockerReachable = $false
    try {
        & docker info *> $null
        $dockerReachable = ($LASTEXITCODE -eq 0)
    } catch {
        $dockerReachable = $false
    }
    if (-not $dockerReachable) {
        throw "Docker is needed to build the image in STEP 4, but 'docker info' failed (is Docker Desktop running?). Start Docker and run the release again, or pass -SkipDocker to release without building the image. Nothing was changed."
    }
    Write-Ok "Docker daemon is reachable"
}

# Puts back the tracked files STEP 1 rewrote, from HEAD (STEP 0 required a
# clean tree and nothing is staged before STEP 5, so HEAD is what they held).
# Returns the paths it restored. Never throws: it runs while another error is
# already on its way out, and must not replace it.
function Restore-ReleaseBumpFiles($repoDir, $relativePaths) {
    $changed = @()
    try {
        foreach ($relative in $relativePaths) {
            $tracked = @(git -C $repoDir ls-files -- $relative 2>$null)
            if ($tracked.Count -eq 0) { continue }
            $status = @(git -C $repoDir status --porcelain -- $relative 2>$null)
            if ($status.Count -gt 0) { $changed += $relative }
        }
        if ($changed.Count -eq 0) { return @() }
        git -C $repoDir checkout HEAD -- @changed 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "Could not restore the version bump automatically. Run: git checkout HEAD -- $($changed -join ' ')"
            return @()
        }
    } catch {
        Write-Warn "Could not restore the version bump automatically ($($_.Exception.Message)). Run: git checkout HEAD -- $($relativePaths -join ' ')"
        return @()
    }
    return $changed
}

# The commit in STEP 5 is made on the local main that STEP 0 checked against
# origin/main. A release takes long enough for someone else to push meanwhile;
# committing anyway leaves a local "Release vX" commit that cannot be pushed
# and blocks the next run. Fetch again right before committing and stop instead.
function Assert-OriginMainUnchanged($repoDir, $expectedCommit) {
    git -C $repoDir fetch origin main --quiet
    if ($LASTEXITCODE -ne 0) { throw "Could not refresh origin/main before committing the release" }
    $currentCommit = "$(git -C $repoDir rev-parse origin/main 2>$null)".Trim()
    if ($currentCommit -ne $expectedCommit) {
        throw "origin/main moved from $expectedCommit to $currentCommit while the release was building. Nothing was committed or pushed and the version bump was undone. Pull main and run the release again."
    }
}

# ============================================
# AUTO-VERSION: next YYYY.MM.N for this month if no -Version given
# ============================================
if (-not $Version) {
    $pkgContent = Get-Content (Join-Path $RepoDir "package.json") -Raw | ConvertFrom-Json
    $currentVersion = [string]$pkgContent.version
    $today = Get-Date
    $monthPrefix = "$($today.Year).$($today.Month)."
    $lastInMonth = if ($currentVersion -match ('^' + [regex]::Escape($monthPrefix) + '(\d+)$')) { [int]$Matches[1] } else { 0 }
    $Version = "$monthPrefix$($lastInMonth + 1)"
    Write-Host "  Auto-versioned release: $currentVersion -> $Version" -ForegroundColor Magenta
}

$bridgeLuaPath = Join-Path $RepoDir "pz-mod\PanelBridge\media\lua\server\PanelBridge.lua"

# The PanelBridge version follows its code, not the panel version. Every
# published bridge update makes each Steam Workshop server refuse new joins
# until it restarts, so a release whose Lua/mod.info bytes are unchanged must
# keep the version. scripts/check-bridge-version.mjs compares the normalized
# bytes with pz-mod/bridge-version.lock.json (written by this script at every
# release) and owns the rules, so this script and CI can't disagree.
$bridgeVersionCheck = Join-Path $RepoDir "scripts\check-bridge-version.mjs"
if (-not (Test-Path $bridgeVersionCheck)) {
    throw "PanelBridge version checker is missing: $bridgeVersionCheck"
}
$bridgeStateJson = & node $bridgeVersionCheck --print-json
if ($LASTEXITCODE -ne 0) { throw "Could not read the PanelBridge version lock" }
$bridgeState = ($bridgeStateJson | Out-String) | ConvertFrom-Json
if (-not $bridgeState.lockVersion) {
    throw "pz-mod\bridge-version.lock.json is missing or invalid; run: node scripts/check-bridge-version.mjs --write-lock <released PanelBridge version>"
}
if (-not $PanelBridgeVersion) {
    $bridgeNextOutput = & node $bridgeVersionCheck --next
    if ($LASTEXITCODE -ne 0) { throw "Could not compute the next PanelBridge version" }
    $PanelBridgeVersion = ([string]($bridgeNextOutput | Select-Object -Last 1)).Trim()
} else {
    & node $bridgeVersionCheck --validate $PanelBridgeVersion
    if ($LASTEXITCODE -ne 0) { throw "-PanelBridgeVersion $PanelBridgeVersion is not allowed (see above)" }
}
if ($PanelBridgeVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "PanelBridge version is not a numeric SemVer: $PanelBridgeVersion"
}
$bridgeVersionChanged = $PanelBridgeVersion -ne [string]$bridgeState.lockVersion
$bridgePublishedPath = Join-Path $RepoDir "pz-mod\workshop\published.json"
try {
    $bridgePublished = Get-Content $bridgePublishedPath -Raw | ConvertFrom-Json
} catch {
    throw "Could not read the PanelBridge Workshop record ${bridgePublishedPath}: $($_.Exception.Message)"
}
$bridgeWorkshopId = [string]$bridgePublished.workshopId
$bridgeWorkshopVersion = [string]$bridgePublished.publishedVersion
$bridgeWorkshopVersionLabel = if ($bridgeWorkshopVersion) { "v$bridgeWorkshopVersion" } else { "an unrecorded version" }
# Workshop servers run the published item, not the release. A publish that
# was skipped stays owed through later releases that don't move the bridge
# version, so the reminder follows published.json, not just this release.
$bridgeWorkshopBehind = $bridgeWorkshopId -and $bridgeWorkshopVersion -ne $PanelBridgeVersion
if ($bridgeVersionChanged) {
    # node, not npm run: npm echoes the whole command line, so a password
    # typed after the account would reach the screen before publish.mjs could
    # refuse it without showing it.
    Write-Host "  PanelBridge changed -> v$PanelBridgeVersion. Workshop servers get it only after you publish: node scripts/workshop/publish.mjs --steam-user <account>" -ForegroundColor Magenta
    # With no pinned item id yet, the first publish goes through the in-game
    # uploader instead (spec path B): it validates the preview image and sets
    # the tags, which steamcmd may not.
    if (-not $bridgeWorkshopId) {
        Write-Host "  The item has no Workshop id yet, so do this first publish with the in-game uploader instead (steps at the end of this run)" -ForegroundColor Magenta
    }
} else {
    Write-Host "  PanelBridge unchanged, keeping $PanelBridgeVersion" -ForegroundColor Magenta
    if ($bridgeWorkshopBehind) {
        Write-Host "  The Steam Workshop item is at $bridgeWorkshopVersionLabel, not v${PanelBridgeVersion}: publish it (see the end of this run)" -ForegroundColor Yellow
    }
}

$TagName = "v$Version"
if (-not $ReleaseTitle) { $ReleaseTitle = "$TagName" }
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Release version is not a numeric SemVer: $Version"
}
if (-not $DryRun -and -not $SkipGitHub) {
    $latestGitHubVersion = Get-LatestGitHubReleaseVersion
    if ((Compare-SemVer $Version $latestGitHubVersion) -le 0) {
        throw "Release version $Version must be newer than the latest GitHub release $latestGitHubVersion"
    }
    Write-Ok "Release version $Version is newer than GitHub $latestGitHubVersion"
}

Write-Host ""
Write-Host "============================================" -ForegroundColor White
Write-Host " Zomboid Control Panel - Release Pipeline"   -ForegroundColor White
Write-Host "============================================" -ForegroundColor White
Write-Host " Version:  $Version"
Write-Host " Tag:      $TagName"
Write-Host " Title:    $ReleaseTitle"
Write-Host " DryRun:   $DryRun"
Write-Host ""

# ============================================
# STEP 0: Pre-flight checks
# ============================================
Write-Step "0/6" "Pre-flight checks"

Push-Location $RepoDir
try {
    $gitStatus = git status --porcelain 2>$null
    # Interpolated first: git prints nothing for a branch without an upstream
    # (any feature branch a dry run is tried on) or a detached HEAD, and
    # .Trim() on that empty result (null even through a [string] cast) would
    # abort the dry run instead of reaching the checks below.
    $currentBranch = "$(git branch --show-current 2>$null)".Trim()
    # First thing, before the fetch below and long before STEP 1 writes
    # anything: a real release from another branch stops here.
    Assert-ReleaseBranch $currentBranch $DryRun
    $upstreamBranch = "$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null)".Trim()
    $headCommit = "$(git rev-parse HEAD 2>$null)".Trim()
    $originMainCommit = $null
    $existingRemoteTag = @()
    if (-not $DryRun -and -not $SkipGitHub) {
        git fetch origin main --quiet
        if ($LASTEXITCODE -ne 0) { throw "Could not refresh origin/main before release" }
        $originMainCommit = (git rev-parse origin/main 2>$null).Trim()
        $existingRemoteTag = @(git ls-remote --tags origin "refs/tags/$TagName" 2>$null)
        if ($LASTEXITCODE -ne 0) { throw "Could not check whether $TagName already exists on origin" }
    }
} catch { throw } finally { Pop-Location }
$untrackedFiles = @(git -C $RepoDir ls-files --others --exclude-standard 2>$null)
$trackedStandaloneReleaseNotes = @(git -C $RepoDir ls-files 2>$null | Where-Object { $_ -match '(^|/)release-notes-[^/]+\.md$' })
if ($trackedStandaloneReleaseNotes.Count -gt 0) {
    $trackedStandaloneReleaseNotes | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
    throw "Obsolete standalone release-note files are tracked. Put release prose in CHANGELOG.md instead."
}
if ($ReleaseNotes) {
    $releaseNotesName = Split-Path -Leaf $ReleaseNotes
    if ($releaseNotesName -match '^release-notes-[^/]+\.md$') {
        throw "Do not pass obsolete standalone release-note files to -ReleaseNotes. Put release prose in CHANGELOG.md instead."
    }
}
Write-Ok "No obsolete standalone release-note files"
if (-not $DryRun -and -not $SkipGitHub) {
    if ($upstreamBranch -ne "origin/main") {
        throw "Releases require an origin/main upstream; current upstream is '$upstreamBranch'."
    }
    if ($headCommit -ne $originMainCommit) {
        throw "Local main is not at origin/main. Pull/rebase before releasing."
    }
    if ($existingRemoteTag.Count -gt 0) {
        throw "Remote tag $TagName already exists; refusing to attach a release to an unknown commit."
    }
    Write-Ok "Release source is cleanly based on origin/main"
} elseif ($currentBranch -ne "main") {
    # Only a dry run gets here on another branch (Assert-ReleaseBranch above).
    Write-Warn "Dry run on branch '$currentBranch'; a real release only runs from main"
}
if (-not $DryRun) {
    $packageVersionCheck = Join-Path $RepoDir "scripts\verify-package-version.mjs"
    if (-not (Test-Path $packageVersionCheck)) {
        throw "Package version parity checker is missing: $packageVersionCheck"
    }
    & node $packageVersionCheck
    if ($LASTEXITCODE -ne 0) { throw "Package version parity check failed" }
    Write-Ok "Package and lockfile versions are internally consistent"
}
if ($gitStatus) {
    Write-Warn "Uncommitted changes detected:"
    $gitStatus | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
    if (-not $DryRun) {
        throw "Working tree is dirty. Commit or stash all changes before releasing."
    }
    Write-Warn "Dry run only; uncommitted changes are present."
} else {
    Write-Ok "No uncommitted changes"
}
if ($untrackedFiles.Count -gt 0) {
    $untrackedFiles | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
    throw "Untracked files detected. Stage intentional new source files before releasing; refusing to stage runtime state automatically."
}

# v1.2.6 shipped with its changelog entries still sitting under [Unreleased] --
# nothing in this script or in CI ever promoted them to a numbered heading, and
# the one thing that looked like a check (release-artifacts.yml's CHANGELOG
# read) sits in a code path this script's own STEP 6 makes unreachable in the
# normal flow. This is the fix: block here, before any work happens, rather
# than auto-writing a heading -- the heading's PRESENCE is mechanical to check,
# but what goes under it is prose with one writer, not this script's to author.
$changelogFile = Join-Path $RepoDir "CHANGELOG.md"
if (Test-Path $changelogFile) {
    $changelogContent = Get-Content $changelogFile -Raw
    $headingPattern = "(?m)^## \[$([regex]::Escape($Version))\]"
    if ($changelogContent -notmatch $headingPattern) {
        throw "CHANGELOG.md has no '## [$Version]' section. Promote the [Unreleased] entries to '## [$Version] - $(Get-Date -Format yyyy-MM-dd)' and open a fresh [Unreleased] section before releasing."
    } else {
        Write-Ok "CHANGELOG.md has a '## [$Version]' section"
    }
} else {
    Write-Warning "CHANGELOG.md not found -- skipping changelog heading check"
}

# Last pre-flight check, so a stopped Docker fails here and not after STEP 3.
if (-not $SkipDocker -and -not $DryRun) {
    Assert-DockerReady
}

# STEPS 1-4 rewrite tracked files (STEP 1) and then spend minutes building. A
# failure anywhere in them used to leave the bump behind: a dirty tree, which
# STEP 0 of the next run refuses ("Working tree is dirty"). However this block
# is left before it completes (a throw, or Ctrl+C), the finally puts the
# rewritten files back and says so.
$releaseStepsDone = $false
try {
    # ============================================
    # STEP 1: Bump version in package.json
    # ============================================
    Write-Step "1/6" "Bumping version to $Version"

    $pkgFile = Join-Path $RepoDir "package.json"
    if (Test-Path $pkgFile) {
        $content = Get-Content $pkgFile -Raw
        $newContent = $content -replace '"version":\s*"[^"]*"', "`"version`": `"$Version`""
        if ($DryRun) {
            Write-Dry "Would update $pkgFile"
        } else {
            # Set-Content intermittently throws "Stream was not readable" in some
            # shells even when the file is writable; direct file I/O is reliable.
            [System.IO.File]::WriteAllText($pkgFile, $newContent, [System.Text.UTF8Encoding]::new($false))
            Write-Ok "Updated $pkgFile"
        }
    } else {
        Write-Warning "Package file not found: $pkgFile"
    }

    $rootLockFile = Join-Path $RepoDir "package-lock.json"
    if (Test-Path $rootLockFile) {
        $rootLockContent = Get-Content $rootLockFile -Raw
        $rootLockPattern = '("name":\s*"pz-server-manager",\s*\r?\n\s*"version":\s*")[^"]*(")'
        $rootLockMatchCount = [regex]::Matches($rootLockContent, $rootLockPattern).Count
        if ($rootLockMatchCount -ne 2) {
            throw "Expected exactly 2 root package version occurrences in $rootLockFile, found $rootLockMatchCount"
        }
        $newRootLockContent = [regex]::Replace($rootLockContent, $rootLockPattern, "`${1}$Version`${2}")
        if ($DryRun) {
            Write-Dry "Would update $rootLockFile ($rootLockMatchCount occurrences)"
        } else {
            [System.IO.File]::WriteAllText($rootLockFile, $newRootLockContent, [System.Text.UTF8Encoding]::new($false))
            Write-Ok "Updated $rootLockFile ($rootLockMatchCount occurrences)"
        }
    } else {
        throw "Package lock file not found: $rootLockFile"
    }

    # client/package.json drifted from root for four releases (1.2.2 while root
    # reached 1.2.6) because this step never touched it -- bump it in the same
    # step as root so there's no window where they can disagree. A test
    # (server/tests/clientVersionMatchesRoot.test.js) asserts they match, but
    # this is the fix at the one place versions actually get bumped; the test is
    # the backstop for every OTHER way they could still drift (a hand-edit, a
    # merge like the one that didn't cause this drift but could have).
    $clientPkgFile = Join-Path $RepoDir "client\package.json"
    if (Test-Path $clientPkgFile) {
        $clientContent = Get-Content $clientPkgFile -Raw
        $newClientContent = $clientContent -replace '"version":\s*"[^"]*"', "`"version`": `"$Version`""
        if ($DryRun) {
            Write-Dry "Would update $clientPkgFile"
        } else {
            [System.IO.File]::WriteAllText($clientPkgFile, $newClientContent, [System.Text.UTF8Encoding]::new($false))
            Write-Ok "Updated $clientPkgFile"
        }
    } else {
        Write-Warning "Package file not found: $clientPkgFile"
    }

    # client/package-lock.json carries the version TWICE (top-level, and again
    # under packages[""]) -- a blind "replace every version string" would also
    # clobber unrelated dependencies that happen to share the same version
    # number (e.g. a dependency pinned to the same "1.2.x" string). Anchor on
    # the package's own name, which appears nowhere else in the file, so only
    # the two real occurrences move.
    $clientLockFile = Join-Path $RepoDir "client\package-lock.json"
    if (Test-Path $clientLockFile) {
        $lockContent = Get-Content $clientLockFile -Raw
        $lockPattern = '("name":\s*"pz-server-manager-client",\s*\r?\n\s*"version":\s*")[^"]*(")'
        # ${1}/${2}, not $1/$2 -- .NET tries to parse digits immediately after a
        # bare $N as part of the group number, and $Version starts with a digit,
        # so "$1" + "9.9.9" reads as "reference group 19" (which doesn't exist)
        # and silently drops the whole backreference instead of falling back to
        # group 1. Caught this only by actually running it against a scratch
        # copy -- the pattern read correctly, the substitution didn't.
        $newLockContent = [regex]::Replace($lockContent, $lockPattern, "`${1}$Version`${2}")
        $matchCount = [regex]::Matches($lockContent, $lockPattern).Count
        if ($matchCount -ne 2) {
            Write-Warning "Expected exactly 2 version occurrences anchored to pz-server-manager-client in $clientLockFile, found $matchCount -- skipping automatic edit, update it by hand"
        } elseif ($DryRun) {
            Write-Dry "Would update $clientLockFile ($matchCount occurrences)"
        } else {
            [System.IO.File]::WriteAllText($clientLockFile, $newLockContent, [System.Text.UTF8Encoding]::new($false))
            Write-Ok "Updated $clientLockFile ($matchCount occurrences)"
        }
    } else {
        Write-Warning "Package lock file not found: $clientLockFile"
    }

    $bridgeModInfoPath = Join-Path $RepoDir "pz-mod\PanelBridge\mod.info"
    if (-not (Test-Path $bridgeModInfoPath)) {
        throw "PanelBridge manifest not found: $bridgeModInfoPath"
    }
    $bridgeLuaContent = Get-Content $bridgeLuaPath -Raw
    $bridgeModInfoContent = Get-Content $bridgeModInfoPath -Raw
    $bridgeHeaderPattern = '(?m)^    Version:\s*[^\r\n]+'
    $bridgeRuntimePattern = '(?m)^    VERSION\s*=\s*"[^"]+"'
    $bridgeModVersionPattern = '(?m)^modversion=[^\r\n]+'
    # Unreleased bridge changes are described under "vNEXT Changes:" in the Lua
    # header (feature branches never bump VERSION); the release names the block.
    $bridgeNextChangesPattern = '(?m)^(\s*)vNEXT Changes:'
    $bridgeHeaderMatches = [regex]::Matches($bridgeLuaContent, $bridgeHeaderPattern)
    $bridgeRuntimeMatches = [regex]::Matches($bridgeLuaContent, $bridgeRuntimePattern)
    $bridgeModVersionMatches = [regex]::Matches($bridgeModInfoContent, $bridgeModVersionPattern)
    if ($bridgeHeaderMatches.Count -ne 1 -or $bridgeRuntimeMatches.Count -ne 1 -or $bridgeModVersionMatches.Count -ne 1) {
        throw "Expected exactly one PanelBridge header, runtime, and manifest version"
    }
    $bridgeHeaderReplacement = "    Version: $PanelBridgeVersion"
    $bridgeRuntimeReplacement = '    VERSION = "' + $PanelBridgeVersion + '"'
    $bridgeModVersionReplacement = "modversion=$PanelBridgeVersion"
    # Rewrite only when a declaration actually moves: rewriting unchanged files
    # would still churn their bytes (line endings, BOM) for a no-op release.
    $bridgeNeedsRewrite = $bridgeHeaderMatches[0].Value.TrimEnd() -ne $bridgeHeaderReplacement -or
        $bridgeRuntimeMatches[0].Value -ne $bridgeRuntimeReplacement -or
        $bridgeModVersionMatches[0].Value.TrimEnd() -ne $bridgeModVersionReplacement -or
        [regex]::IsMatch($bridgeLuaContent, $bridgeNextChangesPattern)
    if (-not $bridgeNeedsRewrite) {
        Write-Ok "PanelBridge Lua and mod.info already declare $PanelBridgeVersion; left untouched"
    } else {
        $newBridgeLuaContent = $bridgeLuaContent -replace $bridgeHeaderPattern, $bridgeHeaderReplacement
        $newBridgeLuaContent = $newBridgeLuaContent -replace $bridgeRuntimePattern, $bridgeRuntimeReplacement
        $newBridgeLuaContent = [regex]::Replace($newBridgeLuaContent, $bridgeNextChangesPattern, "`${1}v$PanelBridgeVersion Changes:")
        $newBridgeModInfoContent = $bridgeModInfoContent -replace $bridgeModVersionPattern, $bridgeModVersionReplacement
        if ($DryRun) {
            Write-Dry "Would update PanelBridge to $PanelBridgeVersion in Lua and mod.info"
        } else {
            [System.IO.File]::WriteAllText($bridgeLuaPath, $newBridgeLuaContent, [System.Text.UTF8Encoding]::new($false))
            [System.IO.File]::WriteAllText($bridgeModInfoPath, $newBridgeModInfoContent, [System.Text.UTF8Encoding]::new($false))
            Write-Ok "Updated PanelBridge Lua and mod.info to $PanelBridgeVersion"
        }
    }

    $bridgeWorkshopCheck = Join-Path $RepoDir "scripts\workshop\build-item.mjs"
    if ($DryRun) {
        Write-Dry "Would run: node scripts/check-bridge-version.mjs --write-lock $PanelBridgeVersion"
    } else {
        Assert-ReleaseVersionParity $Version $PanelBridgeVersion
        Write-Ok "All package, lockfile, and PanelBridge versions are synchronized"
        & node $bridgeVersionCheck --write-lock $PanelBridgeVersion
        if ($LASTEXITCODE -ne 0) { throw "Could not write pz-mod\bridge-version.lock.json" }
        Write-Ok "PanelBridge version lock records $PanelBridgeVersion"
    }
    # Read-only, so a dry run runs it too: it previews what the real release would
    # reject (in a dry run, against the files before the version rewrite).
    & node $bridgeWorkshopCheck --check
    if ($LASTEXITCODE -ne 0) { throw "PanelBridge Steam Workshop item check failed" }
    Write-Ok "PanelBridge Steam Workshop item passes its checks"

    # ============================================
    # STEP 2: Build client
    # ============================================
    Write-Step "2/6" "Building client (Vite/React)"

    if ($SkipBuild) {
        Write-Skip "Build skipped (-SkipBuild)"
    } elseif ($DryRun) {
        Write-Dry "Would run: cd client && npm run build"
    } else {
        Push-Location (Join-Path $RepoDir "client")
        try {
            npm run build
            if ($LASTEXITCODE -ne 0) { throw "Client build failed" }
            Write-Ok "Client built successfully"
        } finally {
            Pop-Location
        }
    }

    # ============================================
    # STEP 3: Build binaries
    # ============================================
    Write-Step "3/6" "Building Windows + Linux binaries (esbuild + pkg)"

    if ($SkipBuild) {
        Write-Skip "Build skipped (-SkipBuild)"
    } elseif ($DryRun) {
        Write-Dry "Would run: npm run build:exe:all, then create ZomboidControlPanel-windows.zip"
    } else {
        Push-Location $RepoDir
        try {
            npm run build:exe:all
            if ($LASTEXITCODE -ne 0) { throw "Binary build failed" }

            $winExe = Join-Path $RepoDir $WinExePath
            $linuxBin = Join-Path $RepoDir $LinuxBinPath
            $checksums = Join-Path $RepoDir $ChecksumsPath

            if (-not (Test-Path $winExe)) { throw "Windows binary not found at $winExe" }
            if (-not (Test-Path $linuxBin)) { throw "Linux binary not found at $linuxBin" }
            if (-not (Test-Path $checksums)) { throw "Checksums file not found at $checksums" }

            $winSize = [math]::Round((Get-Item $winExe).Length / 1MB, 1)
            $linuxSize = [math]::Round((Get-Item $linuxBin).Length / 1MB, 1)
            Write-Ok "Windows binary built: $winSize MB"
            Write-Ok "Linux binary built: $linuxSize MB"
            Write-Ok "Checksums and manifest generated"

            # Package Windows release archive (full folder with client/dist, pz-mod, scripts etc.)
            # Belt-and-braces: explicitly exclude data/db.json and data/backups so a stray
            # runtime database from local testing can never end up in a public release
            # (issue #5: clobbering users' admin/server config on extract).
            $zipPath = Join-Path $RepoDir $WinZipPath
            if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
            $releaseFolder = Join-Path $RepoDir $ReleaseDir
            $strayDb = Join-Path $releaseFolder "data\db.json"
            if (Test-Path $strayDb) {
                Write-Warn "Removing stray data\db.json from release\ before archiving"
                Remove-Item $strayDb -Force
            }
            $strayBackups = Join-Path $releaseFolder "data\backups"
            if (Test-Path $strayBackups) {
                Write-Warn "Removing stray data\backups\ from release\ before archiving"
                Remove-Item $strayBackups -Recurse -Force
            }
            Compress-Archive -Path "$releaseFolder\*" -DestinationPath $zipPath
            $zipSize = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
            Write-Ok "Windows archive created: ZomboidControlPanel-windows.zip ($zipSize MB)"

            # build.js already created the Linux archive with explicit per-entry
            # modes. Do not recreate it with Windows tar: bsdtar strips the
            # executable bit from the extensionless binary and shell scripts.
            $tarPath = Join-Path $RepoDir $LinuxTarPath
            if (-not (Test-Path $tarPath)) {
                throw "Linux archive not found at $tarPath"
            }
            $tarSize = [math]::Round((Get-Item $tarPath).Length / 1MB, 1)
            Write-Ok "Linux archive verified: ZomboidControlPanel-linux.tar.gz ($tarSize MB)"

            $releaseArtifacts = @(
                @{ platform = "win";   kind = "binary"; file = "ZomboidControlPanel.exe";          path = $winExe },
                @{ platform = "linux"; kind = "binary"; file = "ZomboidControlPanel";              path = $linuxBin },
                @{ platform = "win";   kind = "archive"; file = "ZomboidControlPanel-windows.zip"; path = $zipPath },
                @{ platform = "linux"; kind = "archive"; file = "ZomboidControlPanel-linux.tar.gz"; path = $tarPath },
                @{ platform = "browser"; kind = "extension"; file = "zomboid-panel-extension.zip"; path = (Join-Path $RepoDir "release\zomboid-panel-extension.zip") },
                @{ platform = "docker"; kind = "compose"; file = "docker-compose.install.yml";     path = (Join-Path $RepoDir "docker-compose.install.yml") },
                @{ platform = "docker"; kind = "dockerfile"; file = "Dockerfile";                  path = (Join-Path $RepoDir "Dockerfile") }
            )

            $checksumLines = @()
            foreach ($artifact in $releaseArtifacts) {
                $hash = (Get-FileHash -Algorithm SHA256 -Path $artifact.path).Hash.ToLowerInvariant()
                $checksumLines += "$hash  $($artifact.file)"
            }
            Set-Content -Path $checksums -Value ($checksumLines -join "`n") -NoNewline
            Add-Content -Path $checksums -Value ""
            Write-Ok "Checksums updated for binaries + archives + Docker files"
        } finally {
            Pop-Location
        }

        # Post-build verification
        $clientDist = Join-Path $RepoDir "client\dist"
        if (-not (Test-Path $clientDist) -or (Get-ChildItem $clientDist -Recurse -File).Count -eq 0) {
            throw "Build verification failed: client/dist/ is empty or missing"
        }
        Write-Ok "Build verification passed (exe + client/dist validated)"
    }

    if (-not $DryRun) {
        $manifestPath = Join-Path $RepoDir "release\release-manifest.json"
        if (-not (Test-Path $manifestPath)) {
            throw "Release manifest not found at $manifestPath. Build the release artifacts before publishing."
        }
        try {
            $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
        } catch {
            throw "Release manifest is not valid JSON: $manifestPath"
        }
        if ([string]$manifest.version -ne $Version) {
            throw "Release artifact version mismatch: requested v$Version but release-manifest.json contains v$($manifest.version). Rebuild the artifacts; refusing to publish stale binaries."
        }
        $metadataExpected = [pscustomobject]@{
            version = $manifest.version
            buildSha = $manifest.buildSha
            apiContractVersion = $manifest.apiContractVersion
        }
        $sourceClientMetadata = Read-BuildMetadata (Join-Path $RepoDir "client\dist\build-info.json") "Source client"
        $releaseClientMetadata = Read-BuildMetadata (Join-Path $RepoDir "release\client\dist\build-info.json") "Release client"
        Assert-BuildMetadata $sourceClientMetadata $metadataExpected "Source client"
        Assert-BuildMetadata $releaseClientMetadata $metadataExpected "Release client"
        Assert-DirectoryMatches (Join-Path $RepoDir "client\dist") (Join-Path $RepoDir "release\client\dist") "Release client"
        Assert-DirectoryMatchesManifest (Join-Path $RepoDir "client\dist") $manifest.clientFiles "Source client"
        foreach ($binary in @(
            @{ Path = (Join-Path $RepoDir $WinExePath); File = "ZomboidControlPanel.exe" },
            @{ Path = (Join-Path $RepoDir $LinuxBinPath); File = "ZomboidControlPanel" }
        )) {
            if (-not (Test-Path $binary.Path)) {
                throw "Release binary not found at $($binary.Path)"
            }
            $manifestArtifact = @($manifest.artifacts | Where-Object { [string]$_.file -eq $binary.File }) | Select-Object -First 1
            if (-not $manifestArtifact) {
                throw "Release manifest is missing the $($binary.File) artifact"
            }
            $actualHash = (Get-FileHash -Algorithm SHA256 -Path $binary.Path).Hash.ToLowerInvariant()
            if ($actualHash -ne [string]$manifestArtifact.sha256.ToLowerInvariant()) {
                throw "Release binary hash mismatch for $($binary.File); rebuild the artifacts before publishing"
            }
        }
        Write-Ok "Release artifact version verified: v$Version"
        Write-Ok "Release frontend and binary metadata verified: build $($manifest.buildSha)"
    }

    # ============================================
    # STEP 4: Build Docker image
    # ============================================
    Write-Step "4/6" "Building Docker image"

    if ($SkipDocker) {
        Write-Skip "Docker build skipped (-SkipDocker)"
    } elseif ($DryRun) {
        Write-Dry "Would run: docker build -t zomboid-panel:$TagName"
    } else {
        $dockerAvailable = Get-Command docker -ErrorAction SilentlyContinue
        if ($dockerAvailable) {
            Push-Location $RepoDir
            try {
                docker build -t "zomboid-panel:$TagName" -t "zomboid-panel:latest" .
                if ($LASTEXITCODE -ne 0) { throw "Docker build failed" }
                Write-Ok "Docker image built: zomboid-panel:$TagName"
            } finally {
                Pop-Location
            }
        } else {
            Write-Warn "Docker not found on PATH — skipping Docker build"
        }
    }

    # Right before the commit: has main moved while the release was building?
    if (-not $DryRun -and -not $SkipGitHub) {
        Assert-OriginMainUnchanged $RepoDir $originMainCommit
        Write-Ok "origin/main has not moved since the release started"
    }
    $releaseStepsDone = $true
} finally {
    if (-not $releaseStepsDone -and -not $DryRun) {
        $restoredFiles = @(Restore-ReleaseBumpFiles $RepoDir $ReleaseBumpFiles)
        if ($restoredFiles.Count -gt 0) {
            Write-Warn "The release did not finish. Restored the files the version bump rewrote (git checkout HEAD -- ...), so the working tree is clean again: $($restoredFiles -join ', ')"
        }
    }
}

# ============================================
# STEP 5: Git commit and push
# ============================================
Write-Step "5/6" "Committing and pushing to GitHub"

$releaseCommit = $headCommit

if ($SkipGitHub) {
    Write-Skip "GitHub push skipped (-SkipGitHub)"
} elseif ($DryRun) {
    Write-Dry "Would commit and push to $GitHubRepo"
} else {
    Push-Location $RepoDir
    try {
        git add -u
        # Named explicitly: -u only stages files git already tracks, and the
        # release commit must carry the lock describing the bridge it ships.
        git add -- "pz-mod/bridge-version.lock.json"
        if ($LASTEXITCODE -ne 0) { throw "Could not stage pz-mod/bridge-version.lock.json" }

        # Check if there are changes to commit
        $status = git status --porcelain
        if ($status) {
            git commit -m "Release $TagName"
            if ($LASTEXITCODE -ne 0) { throw "Git commit failed" }

            git push origin main
            if ($LASTEXITCODE -ne 0) { throw "Git push failed" }

            $releaseCommit = (git rev-parse HEAD).Trim()

            Write-Ok "Committed and pushed to GitHub"
        } else {
            Write-Ok "No changes to commit (already up to date)"
        }
    } finally {
        Pop-Location
    }
}

# ============================================
# STEP 6: Create GitHub Release with archives
# ============================================
Write-Step "6/6" "Creating GitHub Release $TagName"

$githubReleaseFailed = $false
if ($SkipGitHub) {
    Write-Skip "GitHub release skipped (-SkipGitHub)"
} elseif ($DryRun) {
    Write-Dry "Would create release $TagName on $GitHubRepo with all build artifacts"
} else {
    # Both raw binaries (.exe and the Linux ELF) are uploaded separately so the
    # in-app auto-updater can pull them directly — it refuses archives by design.
    # release-manifest.json is intentionally NOT published: nothing reads it at
    # runtime, it was pure noise for anyone doing a manual install.
    $assetPaths = @(
        (Join-Path $RepoDir $WinZipPath),
        (Join-Path $RepoDir $LinuxTarPath),
        (Join-Path $RepoDir $WinExePath),
        (Join-Path $RepoDir $LinuxBinPath),
        (Join-Path $RepoDir $ChecksumsPath),
        (Join-Path $RepoDir "release\zomboid-panel-extension.zip"),
        (Join-Path $RepoDir "docker-compose.install.yml"),
        (Join-Path $RepoDir "Dockerfile")
    )

    foreach ($asset in $assetPaths) {
        if (-not (Test-Path $asset)) {
            throw "Required release asset missing: $asset"
        }
    }

    # Build gh release command
    $ghArgs = @(
        "release", "create", $TagName,
        "--repo", $GitHubRepo,
        "--title", $ReleaseTitle,
        "--latest",
        "--target", $releaseCommit
    )

    # Add release notes, always as a file (see Write-GeneratedReleaseNotes)
    $generatedNotesFile = $null
    if ($ReleaseNotes -and (Test-Path $ReleaseNotes)) {
        $ghArgs += "--notes-file"
        $ghArgs += $ReleaseNotes
    } else {
        $emdash = [char]0x2014
        $lastTag = git -C $RepoDir tag --sort=-creatordate | Select-Object -First 1
        $changelogSection = Get-ChangelogSection $changelogFile $Version

        if ($changelogSection) {
            # Prefer the changelog's own hand-written prose -- it is what a
            # human actually reads on the release page, unlike a dump of
            # commit subjects (internal shorthand like ":do_rename" or a
            # session's own file names means nothing to a user).
            $autoNotes = "## $ReleaseTitle`n`n$changelogSection`n`n---`n"
            $autoNotes += "`n### Downloads`n"
            $autoNotes += "- **ZomboidControlPanel-windows.zip** $emdash Windows full package (extract and run Start.bat)`n"
            $autoNotes += "- **ZomboidControlPanel-linux.tar.gz** $emdash Linux full package (extract and run ./start.sh)`n"
            $autoNotes += "- **checksums.txt** $emdash SHA256 verification hashes`n"
            if ($lastTag -and $lastTag -ne $TagName) {
                $autoNotes += "`n**Full Changelog**: https://github.com/$GitHubRepo/compare/$lastTag...$TagName`n"
            }
            $generatedNotesFile = Write-GeneratedReleaseNotes $autoNotes $TagName
            $ghArgs += "--notes-file"
            $ghArgs += $generatedNotesFile
        } elseif ($lastTag -and $lastTag -ne $TagName) {
            # Fallback: CHANGELOG.md has no section for this version (STEP 0
            # normally prevents this) -- auto-generate Keep a Changelog format
            # from commit messages instead of falling through to gh's raw
            # commit-subject dump.
            $log = git -C $RepoDir log "$lastTag..HEAD" --format="%s" --no-merges 2>$null

            # Categorize commits by prefix
            $added = @()
            $fixed = @()
            $changed = @()
            $removed = @()
            $deprecated = @()
            $security = @()
            $breaking = @()
            $skipped = @("docs:", "chore:", "style:")

            if ($log) {
                foreach ($line in $log) {
                    $msg = $line.Trim()
                    # Skip docs/chore/style commits
                    $skip = $false
                    foreach ($prefix in $skipped) {
                        if ($msg -match "^${prefix}") { $skip = $true; break }
                    }
                    if ($skip) { continue }

                    # Strip prefix and categorize
                    if ($msg -match "^breaking:\s*(.+)") { $breaking += $Matches[1] }
                    elseif ($msg -match "^feat:\s*(.+)")     { $added += $Matches[1] }
                    elseif ($msg -match "^add:\s*(.+)")      { $added += $Matches[1] }
                    elseif ($msg -match "^fix:\s*(.+)")      { $fixed += $Matches[1] }
                    elseif ($msg -match "^security:\s*(.+)") { $security += $Matches[1] }
                    elseif ($msg -match "^remove:\s*(.+)")   { $removed += $Matches[1] }
                    elseif ($msg -match "^deprecate:\s*(.+)"){ $deprecated += $Matches[1] }
                    elseif ($msg -match "^change:\s*(.+)")   { $changed += $Matches[1] }
                    elseif ($msg -match "^refactor:\s*(.+)") { $changed += $Matches[1] }
                    elseif ($msg -match "^perf:\s*(.+)")     { $changed += $Matches[1] }
                    else { $changed += $msg }
                }
            }

            # Build Keep a Changelog format
            $autoNotes = "## $ReleaseTitle`n"
            if ($breaking.Count -gt 0) {
                $autoNotes += "`n### BREAKING CHANGES`n"
                foreach ($item in $breaking) { $autoNotes += "- $item`n" }
            }
            if ($added.Count -gt 0) {
                $autoNotes += "`n### Added`n"
                foreach ($item in $added) { $autoNotes += "- $item`n" }
            }
            if ($changed.Count -gt 0) {
                $autoNotes += "`n### Changed`n"
                foreach ($item in $changed) { $autoNotes += "- $item`n" }
            }
            if ($fixed.Count -gt 0) {
                $autoNotes += "`n### Fixed`n"
                foreach ($item in $fixed) { $autoNotes += "- $item`n" }
            }
            if ($removed.Count -gt 0) {
                $autoNotes += "`n### Removed`n"
                foreach ($item in $removed) { $autoNotes += "- $item`n" }
            }
            if ($deprecated.Count -gt 0) {
                $autoNotes += "`n### Deprecated`n"
                foreach ($item in $deprecated) { $autoNotes += "- $item`n" }
            }
            if ($security.Count -gt 0) {
                $autoNotes += "`n### Security`n"
                foreach ($item in $security) { $autoNotes += "- $item`n" }
            }
            $autoNotes += "`n---`n"
            $autoNotes += "`n### Downloads`n"
            $autoNotes += "- **ZomboidControlPanel-windows.zip** $emdash Windows full package (extract and run Start.bat)`n"
            $autoNotes += "- **ZomboidControlPanel-linux.tar.gz** $emdash Linux full package (extract and run ./start.sh)`n"
            $autoNotes += "- **checksums.txt** $emdash SHA256 verification hashes`n"
            $generatedNotesFile = Write-GeneratedReleaseNotes $autoNotes $TagName
            $ghArgs += "--notes-file"
            $ghArgs += $generatedNotesFile
        } else {
            $ghArgs += "--generate-notes"
        }
    }

    # Add release assets
    $ghArgs += $assetPaths

    # main is already pushed at this point, so a failure here has to end in
    # the exact command that finishes the release. A gh that can't start (not
    # installed, or a command line Windows refuses) throws under
    # ErrorActionPreference=Stop instead of setting $LASTEXITCODE.
    $ghFailure = $null
    try {
        & gh @ghArgs
        if ($LASTEXITCODE -ne 0) { $ghFailure = "gh exited with code $LASTEXITCODE" }
    } catch {
        $ghFailure = $_.Exception.Message
    }

    if ($ghFailure) {
        $githubReleaseFailed = $true
        Write-Warning "GitHub release creation failed: $ghFailure"
        Write-Host "  main already has the release commit. Create the release with:" -ForegroundColor Yellow
        Write-Host "  $(Format-PowerShellCommandLine 'gh' $ghArgs)" -ForegroundColor Yellow
        if ($generatedNotesFile) {
            Write-Host "  (the release notes stay in $generatedNotesFile for that command)" -ForegroundColor Yellow
        }
    } else {
        if ($generatedNotesFile) {
            Remove-Item -LiteralPath $generatedNotesFile -Force -ErrorAction SilentlyContinue
        }
        Write-Ok "GitHub Release $TagName created with all assets uploaded"
    }
}

# ============================================
# DONE
# ============================================
$doneColor = if ($githubReleaseFailed) { "Yellow" } else { "Green" }
Write-Host ""
Write-Host "============================================" -ForegroundColor $doneColor
if ($githubReleaseFailed) {
    Write-Host " Release $TagName is pushed, but has no GitHub Release yet" -ForegroundColor Yellow
} else {
    Write-Host " Release $TagName complete!" -ForegroundColor Green
}
Write-Host "============================================" -ForegroundColor $doneColor
Write-Host ""
Write-Host " Checklist:" -ForegroundColor White
Write-Host "   [x] Pre-flight checks passed" -ForegroundColor Green
if (-not $SkipBuild)  { Write-Host "   [x] Client built" -ForegroundColor Green }
if (-not $SkipBuild)  { Write-Host "   [x] Windows + Linux binaries created" -ForegroundColor Green }
if (-not $SkipBuild)  { Write-Host "   [x] Windows + Linux archives packaged" -ForegroundColor Green }
if (-not $SkipDocker) { Write-Host "   [x] Docker image built" -ForegroundColor Green }
if (-not $SkipGitHub) { Write-Host "   [x] Pushed to GitHub" -ForegroundColor Green }
if ($githubReleaseFailed) {
    Write-Host "   [ ] GitHub Release not created: run the gh command printed in step 6" -ForegroundColor Yellow
} elseif (-not $SkipGitHub) {
    Write-Host "   [x] GitHub Release created (Keep a Changelog format)" -ForegroundColor Green
}
if ($bridgeWorkshopBehind) {
    Write-Host "   [ ] PanelBridge v$PanelBridgeVersion is not on the Steam Workshop yet (the item is at $bridgeWorkshopVersionLabel). Publish it from this tagged tree:" -ForegroundColor Yellow
    Write-Host "       node scripts/workshop/publish.mjs --steam-user <account>, then commit pz-mod/workshop/published.json" -ForegroundColor Yellow
} elseif ($bridgeVersionChanged -and -not $bridgeWorkshopId) {
    # The staged copy stays in the game's Workshop folder after the upload,
    # and with Steam on the engine loads staged items ahead of the Workshop
    # downloads (see stagedCopyWarning in scripts/workshop/lib.mjs). A push to
    # main that touches pz-mod/ republishes the aio Docker image, so a new
    # item id waits for the live test.
    Write-Host "   [ ] PanelBridge v$PanelBridgeVersion is not on the Steam Workshop yet, and the item has never been published." -ForegroundColor Yellow
    Write-Host "       First publish, from this tagged tree, with the in-game uploader:" -ForegroundColor Yellow
    Write-Host "       1. npm run workshop:build -- --out ~/Zomboid/Workshop" -ForegroundColor Yellow
    Write-Host "       2. In Project Zomboid: Workshop > Upload, pick ZCPB, submit and confirm the upload warning" -ForegroundColor Yellow
    Write-Host "       3. node scripts/workshop/publish.mjs record --from-staged ~/Zomboid/Workshop/ZCPB --visibility unlisted" -ForegroundColor Yellow
    Write-Host "       4. Move ~/Zomboid/Workshop/ZCPB out of ~/Zomboid/Workshop before testing on this machine." -ForegroundColor Yellow
    Write-Host "          While it is there, the game and any Steam-mode server that uses this Zomboid folder load that staged copy" -ForegroundColor Yellow
    Write-Host "          instead of the downloaded Workshop item, now and after every later publish. To upload in-game again," -ForegroundColor Yellow
    Write-Host "          recreate it with its id: npm run workshop:build -- --out ~/Zomboid/Workshop" -ForegroundColor Yellow
    Write-Host "       5. Run the live test with the recorded pz-mod/workshop/published.json, then commit it" -ForegroundColor Yellow
    Write-Host "          (a push to main that touches pz-mod/ republishes the aio Docker image with this item id)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host " Note: live deployment to production (Docker on the game host) is" -ForegroundColor DarkGray
Write-Host " a separate manual step, not part of this script." -ForegroundColor DarkGray
Write-Host ""
if ($githubReleaseFailed) { exit 1 }
