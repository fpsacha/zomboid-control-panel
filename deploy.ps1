# Deploy to server, excluding database file
$source = "D:\Zomboid_dev_panel\Dev1\release"
$dest = "\\garage\PZ\Admin_panel"

# Files/folders to exclude from overwriting
$exclude = @(
    "data\db.json"
)

Write-Host "Deploying from $source to $dest..." -ForegroundColor Cyan
Write-Host "Excluding: $($exclude -join ', ')" -ForegroundColor Yellow

Get-ChildItem -Path $source -Recurse | ForEach-Object {
    $relativePath = $_.FullName.Substring($source.Length + 1)
    $destPath = Join-Path $dest $relativePath
    
    # Check if this file should be excluded
    $shouldExclude = $false
    foreach ($ex in $exclude) {
        if ($relativePath -eq $ex -or $relativePath -like "$ex\*") {
            $shouldExclude = $true
            break
        }
    }
    
    if ($shouldExclude) {
        Write-Host "  Skipping: $relativePath" -ForegroundColor DarkGray
        return
    }
    
    if ($_.PSIsContainer) {
        if (-not (Test-Path $destPath)) {
            New-Item -ItemType Directory -Path $destPath -Force | Out-Null
        }
    } else {
        try {
            Copy-Item -Path $_.FullName -Destination $destPath -Force -ErrorAction Stop
            Write-Host "  Copied: $relativePath" -ForegroundColor Green
        } catch {
            Write-Host "  FAILED: $relativePath - $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

Write-Host "`nDeployment complete!" -ForegroundColor Cyan
