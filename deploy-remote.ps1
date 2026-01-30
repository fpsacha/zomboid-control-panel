# Deploy script for copying release to remote server
# This script EXCLUDES db.json to preserve server configuration

param(
    [string]$Destination = "\\garage\pz\Admin_panel"
)

$Source = ".\release"

if (-not (Test-Path $Source)) {
    Write-Error "Release folder not found. Run 'node build.js' first."
    exit 1
}

Write-Host "📦 Deploying to $Destination..." -ForegroundColor Cyan

# Copy all files EXCEPT db.json
Get-ChildItem -Path $Source -Recurse | Where-Object {
    $_.FullName -notlike "*\data\db.json"
} | ForEach-Object {
    $targetPath = $_.FullName.Replace((Resolve-Path $Source).Path, $Destination)
    
    if ($_.PSIsContainer) {
        # Create directory if it doesn't exist
        if (-not (Test-Path $targetPath)) {
            New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
        }
    } else {
        # Copy file
        $targetDir = Split-Path $targetPath -Parent
        if (-not (Test-Path $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        }
        Copy-Item -Path $_.FullName -Destination $targetPath -Force
    }
}

Write-Host "✅ Deployment complete! (db.json preserved)" -ForegroundColor Green
Write-Host ""
Write-Host "Files deployed:" -ForegroundColor Yellow
Write-Host "  - ZomboidControlPanel.exe"
Write-Host "  - client/dist/* (web interface)"
Write-Host "  - pz-mod/* (PanelBridge Lua mod)"
Write-Host "  - Start.bat, README.txt"
Write-Host ""
Write-Host "⚠️  Remember to restart the panel on the remote server!" -ForegroundColor Yellow
