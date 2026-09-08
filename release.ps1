<#
.SYNOPSIS
    Build and GitHub release pipeline for Zomboid Control Panel.

.DESCRIPTION
    This script automates the release process, self-contained in this repo
    (no external Dev1/ working copy, no \\garage SMB deploy — that
    infrastructure is retired; live deployment now happens separately via
    Docker on the production host):
    0. Pre-flight checks (uncommitted changes)
    1. Bumps version in package.json — auto-increments if no -Version given
    2. Builds the client (Vite/React)
    3. Builds Windows + Linux binaries (esbuild + pkg) and packages archives
    4. Builds Docker image
    5. Commits and pushes to GitHub
    6. Creates a GitHub Release with Keep a Changelog format notes

.PARAMETER Version
    Explicit version string (e.g., "0.9.0"). If omitted, auto-increments based on -Bump.

.PARAMETER Bump
    Auto-increment type when -Version is not provided. Valid: major, minor, patch (default: patch).

.PARAMETER ReleaseTitle
    Custom release title. Defaults to "v<Version>".

.PARAMETER ReleaseNotes
    Path to a markdown file with release notes. If omitted, auto-generates from commits.

.PARAMETER PanelBridgeVersion
    PanelBridge version to ship. If omitted, a new application release increments
    the current PanelBridge patch version; an explicit same-version release keeps it.

.PARAMETER SkipBuild
    Skip the client and exe build steps (use existing release/ folder).

.PARAMETER SkipGitHub
    Skip git commit/push and GitHub release creation.

.PARAMETER SkipDocker
    Skip building the Docker image.

.PARAMETER DryRun
    Show what would happen without making changes.

.EXAMPLE
    .\release.ps1                                          # Auto-increment patch
    .\release.ps1 -Version "0.9.0"                         # Explicit version
    .\release.ps1 -Bump minor                              # Auto-increment minor
    .\release.ps1 -Version "0.9.0" -SkipDocker             # Skip Docker build
    .\release.ps1 -DryRun                                  # Preview all steps
#>

param(
    [string]$Version = "",

    [ValidateSet("major", "minor", "patch")]
    [string]$Bump = "patch",

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

function Get-NextPatchVersion($currentVersion, $label) {
    $match = [regex]::Match([string]$currentVersion, '^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$')
    if (-not $match.Success) {
        throw "$label version is not a numeric SemVer: $currentVersion"
    }
    return "$($match.Groups['major'].Value).$($match.Groups['minor'].Value).$([int]$match.Groups['patch'].Value + 1)"
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

# ============================================
# AUTO-VERSION: Increment from current package.json if no -Version given
# ============================================
$versionWasProvided = -not [string]::IsNullOrWhiteSpace($Version)
$originalPanelVersion = (Get-Content (Join-Path $RepoDir "package.json") -Raw | ConvertFrom-Json).version
if (-not $Version) {
    $pkgContent = Get-Content (Join-Path $RepoDir "package.json") -Raw | ConvertFrom-Json
    $currentVersion = $pkgContent.version
    # Strip any pre-release suffix for numeric parsing
    $numericPart = ($currentVersion -split '-')[0]
    $parts = $numericPart -split '\.'
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    $patch = [int]($parts[2] -replace '[^0-9]', '')

    switch ($Bump) {
        "major" { $major++; $minor = 0; $patch = 0 }
        "minor" { $minor++; $patch = 0 }
        "patch" { $patch++ }
    }
    $Version = "$major.$minor.$patch"
    Write-Host "  Auto-incremented version: $currentVersion -> $Version (bump: $Bump)" -ForegroundColor Magenta
}

$bridgeLuaPath = Join-Path $RepoDir "pz-mod\PanelBridge\media\lua\server\PanelBridge.lua"
$bridgeLuaBeforeRelease = Get-Content $bridgeLuaPath -Raw
$bridgeRuntimeMatch = [regex]::Match($bridgeLuaBeforeRelease, '(?m)^\s*VERSION\s*=\s*"([^"]+)"')
if (-not $bridgeRuntimeMatch.Success) {
    throw "PanelBridge runtime VERSION declaration not found"
}
if (-not $PanelBridgeVersion) {
    $PanelBridgeVersion = if ($versionWasProvided -and $Version -eq $originalPanelVersion) {
        $bridgeRuntimeMatch.Groups[1].Value
    } else {
        Get-NextPatchVersion $bridgeRuntimeMatch.Groups[1].Value "PanelBridge"
    }
}

$TagName = "v$Version"
if (-not $ReleaseTitle) { $ReleaseTitle = "$TagName" }

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
try { $gitStatus = git status --porcelain 2>$null } catch { $gitStatus = $null }
$untrackedFiles = @(git ls-files --others --exclude-standard 2>$null)
Pop-Location
if ($gitStatus) {
    Write-Warn "Uncommitted changes detected:"
    $gitStatus | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
    Write-Warn "Continuing with uncommitted changes."
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
$bridgeHeaderPattern = '(?m)^    Version:\s*[^\r\n]+'
$bridgeRuntimePattern = '(?m)^    VERSION\s*=\s*"[^"]+"'
$bridgeModVersionPattern = '(?m)^modversion=[^\r\n]+'
if ([regex]::Matches($bridgeLuaContent, $bridgeHeaderPattern).Count -ne 1 -or
    [regex]::Matches($bridgeLuaContent, $bridgeRuntimePattern).Count -ne 1 -or
    [regex]::Matches((Get-Content $bridgeModInfoPath -Raw), $bridgeModVersionPattern).Count -ne 1) {
    throw "Expected exactly one PanelBridge header, runtime, and manifest version"
}
$newBridgeLuaContent = $bridgeLuaContent -replace $bridgeHeaderPattern, "    Version: $PanelBridgeVersion"
$bridgeRuntimeReplacement = '    VERSION = "' + $PanelBridgeVersion + '"'
$newBridgeLuaContent = $newBridgeLuaContent -replace $bridgeRuntimePattern, $bridgeRuntimeReplacement
$newBridgeModInfoContent = (Get-Content $bridgeModInfoPath -Raw) -replace $bridgeModVersionPattern, "modversion=$PanelBridgeVersion"
if ($DryRun) {
    Write-Dry "Would update PanelBridge to $PanelBridgeVersion in Lua and mod.info"
} else {
    [System.IO.File]::WriteAllText($bridgeLuaPath, $newBridgeLuaContent, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($bridgeModInfoPath, $newBridgeModInfoContent, [System.Text.UTF8Encoding]::new($false))
    Write-Ok "Updated PanelBridge Lua and mod.info to $PanelBridgeVersion"
    Assert-ReleaseVersionParity $Version $PanelBridgeVersion
    Write-Ok "All package, lockfile, and PanelBridge versions are synchronized"
}

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

# ============================================
# STEP 5: Git commit and push
# ============================================
Write-Step "5/6" "Committing and pushing to GitHub"

if ($SkipGitHub) {
    Write-Skip "GitHub push skipped (-SkipGitHub)"
} elseif ($DryRun) {
    Write-Dry "Would commit and push to $GitHubRepo"
} else {
    Push-Location $RepoDir
    try {
        git add -u

        # Check if there are changes to commit
        $status = git status --porcelain
        if ($status) {
            git commit -m "Release $TagName"
            if ($LASTEXITCODE -ne 0) { throw "Git commit failed" }

            git push
            if ($LASTEXITCODE -ne 0) { throw "Git push failed" }

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
        "--latest"
    )

    # Add release notes
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
            $ghArgs += "--notes"
            $ghArgs += $autoNotes
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
            $ghArgs += "--notes"
            $ghArgs += $autoNotes
        } else {
            $ghArgs += "--generate-notes"
        }
    }

    # Add release assets
    $ghArgs += $assetPaths

    & gh @ghArgs

    if ($LASTEXITCODE -ne 0) {
        Write-Warning "GitHub release creation failed. You can retry with:"
        Write-Host "  gh release create $TagName --repo $GitHubRepo --title `"$ReleaseTitle`" --prerelease <asset paths>" -ForegroundColor Yellow
    } else {
        Write-Ok "GitHub Release $TagName created with all assets uploaded"
    }
}

# ============================================
# DONE
# ============================================
Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host " Release $TagName complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host " Checklist:" -ForegroundColor White
Write-Host "   [x] Pre-flight checks passed" -ForegroundColor Green
if (-not $SkipBuild)  { Write-Host "   [x] Client built" -ForegroundColor Green }
if (-not $SkipBuild)  { Write-Host "   [x] Windows + Linux binaries created" -ForegroundColor Green }
if (-not $SkipBuild)  { Write-Host "   [x] Windows + Linux archives packaged" -ForegroundColor Green }
if (-not $SkipDocker) { Write-Host "   [x] Docker image built" -ForegroundColor Green }
if (-not $SkipGitHub) { Write-Host "   [x] Pushed to GitHub" -ForegroundColor Green }
if (-not $SkipGitHub) { Write-Host "   [x] GitHub Release created (Keep a Changelog format)" -ForegroundColor Green }
Write-Host ""
Write-Host " Note: live deployment to production (Docker on the game host) is" -ForegroundColor DarkGray
Write-Host " a separate manual step, not part of this script." -ForegroundColor DarkGray
Write-Host ""
