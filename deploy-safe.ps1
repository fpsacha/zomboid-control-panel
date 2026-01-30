# Safe deploy script - preserves existing db.json on production
$source = "d:\Zomboid_dev_panel\Dev1\release"
$dest = "\\garage\pz\Admin_panel"

# Copy everything except data folder
Copy-Item -Path "$source\ZomboidControlPanel.exe" -Destination $dest -Force
Copy-Item -Path "$source\Start.bat" -Destination $dest -Force
Copy-Item -Path "$source\README.txt" -Destination $dest -Force
Copy-Item -Path "$source\server.cjs" -Destination $dest -Force
Copy-Item -Path "$source\client" -Destination $dest -Recurse -Force
Copy-Item -Path "$source\server" -Destination $dest -Recurse -Force
Copy-Item -Path "$source\pz-mod" -Destination $dest -Recurse -Force
Copy-Item -Path "$source\logs" -Destination $dest -Recurse -Force

# Only copy db.json if it doesn't exist on production
if (-not (Test-Path "$dest\data\db.json")) {
    Copy-Item -Path "$source\data" -Destination $dest -Recurse -Force
    Write-Host "Created new data folder with default db.json"
} else {
    Write-Host "Preserved existing db.json on production"
}

Write-Host "Deploy complete!"
