import esbuild from 'esbuild';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const distDir = './dist-exe';
const releaseDir = './release';

// Simple sleep function
function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait */ }
}

// Clean directories with retry logic for Windows file locks
function cleanDir(dir, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
      }
      return true;
    } catch (e) {
      if (i === maxRetries - 1) {
        console.warn(`⚠️ Could not fully clean ${dir}: ${e.message}`);
        console.warn('  Attempting to continue anyway...');
        return false;
      }
      console.log(`  Retry ${i + 1}/${maxRetries} for ${dir}...`);
      sleep(2000);
    }
  }
}

cleanDir(distDir);
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir);
}

cleanDir(releaseDir);
if (!fs.existsSync(releaseDir)) {
  fs.mkdirSync(releaseDir);
}

console.log('📦 Building server bundle...');

// Bundle the server code
await esbuild.build({
  entryPoints: ['./server/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: './dist-exe/server.cjs',
  external: ['@aws-sdk/client-s3'],
  define: {
    'import.meta.url': 'import_meta_url'
  },
  banner: {
    js: `
const import_meta_url = require('url').pathToFileURL(__filename).href;
`
  }
});

console.log('✅ Server bundled successfully');

// Create package.json for pkg (without assets - we'll ship them separately)
const pkgConfig = {
  name: "zomboid-control-panel",
  version: "1.0.0",
  bin: "server.cjs",
  pkg: {
    scripts: "server.cjs",
    targets: ["node18-win-x64"],
    outputPath: "."
  }
};

fs.writeFileSync('./dist-exe/package.json', JSON.stringify(pkgConfig, null, 2));

console.log('🔨 Creating executable...');

try {
  execSync('npx pkg . --compress GZip', { 
    cwd: distDir, 
    stdio: 'inherit' 
  });
  console.log('✅ Executable created successfully!');
} catch (error) {
  console.error('❌ Failed to create executable:', error.message);
  process.exit(1);
}

// Create release folder structure
console.log('📁 Creating release package...');

// Move exe to release
fs.copyFileSync('./dist-exe/zomboid-control-panel.exe', './release/ZomboidControlPanel.exe');

// Copy client dist
const clientDist = './client/dist';
const targetClientDist = './release/client/dist';

if (fs.existsSync(clientDist)) {
  fs.cpSync(clientDist, targetClientDist, { recursive: true });
  console.log('✅ Client files copied');
} else {
  console.error('❌ Client dist not found! Run "npm run build" in client first.');
  process.exit(1);
}

// Create data folder with default db.json (only if it doesn't exist in release)
fs.mkdirSync('./release/data', { recursive: true });
const releaseDbPath = './release/data/db.json';
if (!fs.existsSync(releaseDbPath)) {
  const defaultDb = {
    settings: {
      serverPath: "",
      serverExe: "StartServer64.bat",
      rconPassword: "",
      rconPort: 27015,
      adminPassword: ""
    },
    players: [],
    scheduledTasks: [],
    servers: [],
    discord: {
      enabled: false,
      token: "",
      guildId: "",
      channelId: "",
      adminRoleId: ""
    }
  };
  fs.writeFileSync(releaseDbPath, JSON.stringify(defaultDb, null, 2));
  console.log('✅ Default db.json created');
} else {
  console.log('ℹ️ Existing db.json preserved in release folder');
}

// Create logs folder
fs.mkdirSync('./release/logs', { recursive: true });
fs.writeFileSync('./release/logs/.gitkeep', '');

// Copy pz-mod folder for Panel Bridge
const pzModDir = './pz-mod';
const targetPzModDir = './release/pz-mod';

if (fs.existsSync(pzModDir)) {
  fs.cpSync(pzModDir, targetPzModDir, { recursive: true });
  console.log('✅ PanelBridge mod copied');
} else {
  console.warn('⚠️ pz-mod folder not found, skipping');
}

// Create a simple start script
const startBat = `@echo off
echo Starting Zomboid Control Panel...
echo.
echo Open your browser to: http://localhost:3001
echo.
ZomboidControlPanel.exe
pause
`;
fs.writeFileSync('./release/Start.bat', startBat);

// Create README
const readme = `# Zomboid Control Panel

## Quick Start
1. Run Start.bat (or double-click ZomboidControlPanel.exe)
2. Open your browser to http://localhost:3001
3. Configure your server paths in Settings

## Folder Structure
- ZomboidControlPanel.exe - Main application
- client/dist/ - Web interface files
- data/db.json - Configuration database
- logs/ - Application logs
- pz-mod/ - PanelBridge mod for advanced features

## Panel Bridge Setup (Optional)
The PanelBridge mod enables advanced features like weather control:
1. Copy the pz-mod/PanelBridge folder to your server's mods folder
2. Add "PanelBridge" to your server's Mods= line in the .ini file
3. Restart your PZ server
4. Go to Settings in the panel and configure the Panel Bridge section

## Notes
- Keep all files in the same folder structure
- The app runs on port 3001 by default
- First run: Go to Settings to configure your PZ server path
`;
fs.writeFileSync('./release/README.txt', readme);

console.log('');
console.log('✅ Release package created successfully!');
console.log('📍 Location: ./release/');
console.log('');
console.log('Contents:');
console.log('  - ZomboidControlPanel.exe');
console.log('  - Start.bat');
console.log('  - client/dist/ (web interface)');
console.log('  - data/ (configuration)');
console.log('  - logs/');
console.log('  - pz-mod/ (PanelBridge mod)');
console.log('  - README.txt');

