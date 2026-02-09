<#
.SYNOPSIS
    Full build, deploy, and GitHub release pipeline for Zomboid Control Panel.

.DESCRIPTION
    This script automates the entire release process:
    1. Bumps version in package.json (Dev1 + GitHub)
    2. Builds the client (Vite/React)
    3. Builds the exe (esbuild + pkg)
    4. Deploys PanelBridge.lua to the live PZ server
    5. Deploys the full release to \\garage\PZ\Admin_panel
    6. Syncs files to the GitHub working copy
    7. Commits and pushes to GitHub
    8. Creates a GitHub Release with the exe as a downloadable asset

.PARAMETER Version
    The new version string (e.g., "0.1.5-alpha"). Required.

.PARAMETER ReleaseTitle
    Custom release title. Defaults to "v<Version>".

.PARAMETER ReleaseNotes
    Path to a markdown file with release notes. If omitted, opens $EDITOR for input.

.PARAMETER SkipBuild
    Skip the client and exe build steps (use existing release/ folder).

.PARAMETER SkipDeploy
    Skip deploying to the live server.

.PARAMETER SkipGitHub
    Skip git commit/push and GitHub release creation.

.PARAMETER DryRun
    Show what would happen without making changes.

.EXAMPLE
    .\release.ps1 -Version "0.1.5-alpha"
    .\release.ps1 -Version "0.1.5-alpha" -ReleaseNotes ".\notes.md"
    .\release.ps1 -Version "0.1.5-alpha" -SkipBuild
    .\release.ps1 -Version "0.1.5-alpha" -DryRun
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$Version,

    [string]$ReleaseTitle = "",

    [string]$ReleaseNotes = "",

    [switch]$SkipBuild,
    [switch]$SkipDeploy,
    [switch]$SkipGitHub,
    [switch]$DryRun
)

# ============================================
# CONFIGURATION - Edit these paths as needed
# ============================================
$Dev1Dir          = "D:\Zomboid_dev_panel\Dev1"
$GitHubDir        = "D:\Zomboid_dev_panel\GitHub"
$LivePanelBridge  = "\\garage\pz\Server_Data\DoomerZ_B42V3\media\lua\server\PanelBridge.lua"
$LiveAdminPanel   = "\\garage\PZ\Admin_panel"
$GitHubRepo       = "fpsacha/zomboid-control-panel"

# Source paths (relative to Dev1Dir)
$PanelBridgeSrc   = "pz-mod\PanelBridge\media\lua\server\PanelBridge.lua"
$ReleaseDir       = "release"
$ExePath          = "release\ZomboidControlPanel.exe"

# ============================================
# HELPERS
# ============================================
$ErrorActionPreference = "Stop"
$TagName = "v$Version"

function Write-Step($step, $msg) {
    Write-Host ""
    Write-Host "[$step] $msg" -ForegroundColor Cyan
    Write-Host ("-" * 60) -ForegroundColor DarkGray
}

function Write-Ok($msg)   { Write-Host "  OK: $msg" -ForegroundColor Green }
function Write-Skip($msg) { Write-Host "  SKIP: $msg" -ForegroundColor Yellow }
function Write-Dry($msg)  { Write-Host "  DRY RUN: $msg" -ForegroundColor Magenta }

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
# STEP 1: Bump version in package.json files
# ============================================
Write-Step "1/8" "Bumping version to $Version"

$packageFiles = @(
    (Join-Path $Dev1Dir "package.json"),
    (Join-Path $GitHubDir "package.json")
)

foreach ($pkgFile in $packageFiles) {
    if (Test-Path $pkgFile) {
        $content = Get-Content $pkgFile -Raw
        $newContent = $content -replace '"version":\s*"[^"]*"', "`"version`": `"$Version`""
        if ($DryRun) {
            Write-Dry "Would update $pkgFile"
        } else {
            Set-Content $pkgFile -Value $newContent -NoNewline
            Write-Ok "Updated $pkgFile"
        }
    } else {
        Write-Warning "Package file not found: $pkgFile"
    }
}

# ============================================
# STEP 2: Build client
# ============================================
Write-Step "2/8" "Building client (Vite/React)"

if ($SkipBuild) {
    Write-Skip "Build skipped (-SkipBuild)"
} elseif ($DryRun) {
    Write-Dry "Would run: cd client && npm run build"
} else {
    Push-Location (Join-Path $Dev1Dir "client")
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "Client build failed" }
        Write-Ok "Client built successfully"
    } finally {
        Pop-Location
    }
}

# ============================================
# STEP 3: Build exe
# ============================================
Write-Step "3/8" "Building executable (esbuild + pkg)"

if ($SkipBuild) {
    Write-Skip "Build skipped (-SkipBuild)"
} elseif ($DryRun) {
    Write-Dry "Would run: npm run build:exe"
} else {
    Push-Location $Dev1Dir
    try {
        npm run build:exe
        if ($LASTEXITCODE -ne 0) { throw "Exe build failed" }
        
        $exe = Join-Path $Dev1Dir $ExePath
        if (-not (Test-Path $exe)) { throw "Exe not found at $exe" }
        
        $size = [math]::Round((Get-Item $exe).Length / 1MB, 1)
        Write-Ok "Exe built: $size MB"
    } finally {
        Pop-Location
    }
}

# ============================================
# STEP 4: Deploy PanelBridge.lua to live PZ server
# ============================================
Write-Step "4/8" "Deploying PanelBridge.lua to live server"

if ($SkipDeploy) {
    Write-Skip "Deploy skipped (-SkipDeploy)"
} elseif ($DryRun) {
    Write-Dry "Would copy PanelBridge.lua to $LivePanelBridge"
} else {
    $src = Join-Path $Dev1Dir $PanelBridgeSrc
    Copy-Item $src $LivePanelBridge -Force
    Write-Ok "PanelBridge.lua deployed to live server"
}

# ============================================
# STEP 5: Deploy full release to Admin Panel
# ============================================
Write-Step "5/8" "Deploying release to $LiveAdminPanel"

if ($SkipDeploy) {
    Write-Skip "Deploy skipped (-SkipDeploy)"
} elseif ($DryRun) {
    Write-Dry "Would run deploy.ps1"
} else {
    Push-Location $Dev1Dir
    try {
        & ".\deploy.ps1"
        Write-Ok "Release deployed to $LiveAdminPanel"
    } finally {
        Pop-Location
    }
}

# ============================================
# STEP 6: Sync files to GitHub working copy
# ============================================
Write-Step "6/8" "Syncing files to GitHub folder"

if ($SkipGitHub) {
    Write-Skip "GitHub sync skipped (-SkipGitHub)"
} elseif ($DryRun) {
    Write-Dry "Would sync Dev1 files to GitHub folder"
} else {
    # Sync key files from Dev1 to GitHub (excluding node_modules, .env, db.json, dist, release)
    $syncItems = @(
        "server",
        "pz-mod",
        "client\src",
        "client\public",
        "client\index.html",
        "client\package.json",
        "client\tsconfig.json",
        "client\vite.config.ts",
        "client\tailwind.config.js",
        "client\postcss.config.js",
        "client\components.json",
        "package.json",
        "build.js",
        "bundle-server.js",
        "server.cjs",
        "nodemon.json",
        "Start.bat",
        "deploy.ps1",
        "deploy-safe.ps1",
        "deploy-remote.ps1",
        "release.ps1",
        "README.md",
        "LICENSE"
    )
    
    foreach ($item in $syncItems) {
        $srcPath = Join-Path $Dev1Dir $item
        $dstPath = Join-Path $GitHubDir $item
        
        if (Test-Path $srcPath) {
            $dstDir = Split-Path $dstPath -Parent
            if (-not (Test-Path $dstDir)) {
                New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
            }
            
            if ((Get-Item $srcPath).PSIsContainer) {
                # It's a directory - use robocopy for mirror
                robocopy $srcPath $dstPath /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
            } else {
                Copy-Item $srcPath $dstPath -Force
            }
        }
    }
    
    # Always sync PanelBridge.lua specifically
    $pbSrc = Join-Path $Dev1Dir $PanelBridgeSrc
    $pbDst = Join-Path $GitHubDir $PanelBridgeSrc
    $pbDstDir = Split-Path $pbDst -Parent
    if (-not (Test-Path $pbDstDir)) { New-Item -ItemType Directory -Path $pbDstDir -Force | Out-Null }
    Copy-Item $pbSrc $pbDst -Force
    
    Write-Ok "Files synced to GitHub folder"
}

# ============================================
# STEP 7: Git commit and push
# ============================================
Write-Step "7/8" "Committing and pushing to GitHub"

if ($SkipGitHub) {
    Write-Skip "GitHub push skipped (-SkipGitHub)"
} elseif ($DryRun) {
    Write-Dry "Would commit and push to $GitHubRepo"
} else {
    Push-Location $GitHubDir
    try {
        git add -A
        
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
# STEP 8: Create GitHub Release with exe
# ============================================
Write-Step "8/8" "Creating GitHub Release $TagName"

if ($SkipGitHub) {
    Write-Skip "GitHub release skipped (-SkipGitHub)"
} elseif ($DryRun) {
    Write-Dry "Would create release $TagName on $GitHubRepo with exe"
} else {
    $exe = Join-Path $Dev1Dir $ExePath
    
    if (-not (Test-Path $exe)) {
        Write-Warning "Exe not found at $exe - skipping release asset upload"
        $exe = $null
    }
    
    # Build gh release command
    $ghArgs = @(
        "release", "create", $TagName,
        "--repo", $GitHubRepo,
        "--title", $ReleaseTitle,
        "--prerelease"
    )
    
    # Add release notes
    if ($ReleaseNotes -and (Test-Path $ReleaseNotes)) {
        $ghArgs += "--notes-file"
        $ghArgs += $ReleaseNotes
    } else {
        # Auto-generate basic release notes from git log
        $lastTag = git -C $GitHubDir tag --sort=-creatordate | Select-Object -First 1
        if ($lastTag -and $lastTag -ne $TagName) {
            $log = git -C $GitHubDir log "$lastTag..HEAD" --oneline --no-merges 2>$null
            $autoNotes = "## $ReleaseTitle`n`n### Changes`n"
            if ($log) {
                foreach ($line in $log) {
                    $autoNotes += "- $line`n"
                }
            }
            $autoNotes += "`n### Downloads`n- **ZomboidControlPanel.exe** - Standalone Windows executable`n"
            $ghArgs += "--notes"
            $ghArgs += $autoNotes
        } else {
            $ghArgs += "--generate-notes"
        }
    }
    
    # Add exe as asset
    if ($exe) {
        $ghArgs += $exe
    }
    
    & gh @ghArgs
    
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "GitHub release creation failed. You can retry with:"
        Write-Host "  gh release create $TagName --repo $GitHubRepo --title `"$ReleaseTitle`" --prerelease `"$exe`"" -ForegroundColor Yellow
    } else {
        Write-Ok "GitHub Release $TagName created with exe"
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
if (-not $SkipBuild)  { Write-Host "   [x] Client built" -ForegroundColor Green }
if (-not $SkipBuild)  { Write-Host "   [x] Exe created" -ForegroundColor Green }
if (-not $SkipDeploy) { Write-Host "   [x] PanelBridge.lua deployed to PZ server" -ForegroundColor Green }
if (-not $SkipDeploy) { Write-Host "   [x] Release deployed to Admin Panel" -ForegroundColor Green }
if (-not $SkipGitHub) { Write-Host "   [x] Pushed to GitHub" -ForegroundColor Green }
if (-not $SkipGitHub) { Write-Host "   [x] GitHub Release created with exe" -ForegroundColor Green }
Write-Host ""
