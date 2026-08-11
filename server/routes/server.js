import express from "express";
import { spawn, exec } from "child_process";
import { promisify } from "util";
import https from "https";
import path from "path";
import fs from "fs";
import os from "os";
import { createLogger } from "../utils/logger.js";
const log = createLogger("API:Server");
import {
  logServerEvent,
  setSetting,
  getSetting,
  getActiveServer,
} from "../database/init.js";
import { sanitizeError, sanitizeIniValue } from "../utils/sanitize.js";
import { normalizeMemoryGb } from "../utils/memory.js";
import { withFileLock, writeFileAtomic } from "../utils/fileWriteQueue.js";
import { requireRole } from "../services/auth.js";
import { runManagedLifecycle } from "../services/managedContainer.js";

const router = express.Router();

const isWindows = process.platform === "win32";
const execAsync = promisify(exec);

// Get the SteamCMD executable name for the current platform
function getSteamCmdExe(steamcmdPath) {
  const primary = path.join(
    steamcmdPath,
    isWindows ? "steamcmd.exe" : "steamcmd.sh",
  );
  if (fs.existsSync(primary)) return primary;
  // Fallback: plain 'steamcmd' binary (package-manager installs on Linux)
  const fallback = path.join(steamcmdPath, "steamcmd");
  if (!isWindows && fs.existsSync(fallback)) return fallback;
  // System-wide fallback (CentOS/Ubuntu package manager installs)
  if (!isWindows) {
    for (const sysPath of [
      "/usr/games/steamcmd",
      "/usr/bin/steamcmd",
      "/usr/local/bin/steamcmd",
    ]) {
      if (fs.existsSync(sysPath)) return sysPath;
    }
  }
  return primary; // Return primary path even if not found — let caller handle the error
}

// Self-heal "SteamCMD not found": downloads, extracts and first-time
// initializes SteamCMD into `installPath` on Linux, mirroring the same
// steps as POST /steamcmd/download. Called from /install and /update when
// the configured steamcmdPath is empty — e.g. a fresh volume, or a
// previous install attempt that never finished (permission error, network
// blip, container restarted mid-download, etc.) instead of hard-failing
// with a 400 and making the user manually re-run the setup wizard.
// Windows is intentionally out of scope here (existing callers already
// keep their own hard-fail for isWindows before calling this).
async function ensureSteamCmdLinux(installPath, io) {
  const steamcmdExe = getSteamCmdExe(installPath);
  if (fs.existsSync(steamcmdExe)) return steamcmdExe;

  const emit = (event, payload) => {
    try {
      io?.emit(event, payload);
    } catch {
      /* best effort */
    }
  };

  log.warn(
    `SteamCMD not found at ${steamcmdExe}; auto-downloading to ${installPath}...`,
  );
  emit("steamcmd:status", {
    status: "downloading",
    message: "SteamCMD missing — downloading it now...",
  });

  if (!fs.existsSync(installPath)) {
    fs.mkdirSync(installPath, { recursive: true });
  }

  const tarUrl =
    "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz";
  const tarPath = path.join(installPath, "steamcmd_linux.tar.gz");
  const safeTarPath = tarPath.replace(/'/g, "'\\''");
  const safeTarUrl = tarUrl.replace(/'/g, "'\\''");
  const safeInstallPath = installPath.replace(/'/g, "'\\''");

  try {
    await execAsync(`curl -sSL -o '${safeTarPath}' '${safeTarUrl}'`, {
      timeout: 120000,
    });
  } catch (curlErr) {
    log.warn(`curl download failed (${curlErr.message}), trying wget...`);
    await execAsync(`wget -q -O '${safeTarPath}' '${safeTarUrl}'`, {
      timeout: 120000,
    });
  }

  emit("steamcmd:status", {
    status: "extracting",
    message: "Extracting SteamCMD...",
  });
  await execAsync(`tar -xzf '${safeTarPath}' -C '${safeInstallPath}'`, {
    timeout: 30000,
  });
  try {
    fs.unlinkSync(tarPath);
  } catch {
    /* ignore */
  }
  try {
    fs.chmodSync(path.join(installPath, "steamcmd.sh"), 0o755);
  } catch {
    /* ignore */
  }
  try {
    fs.chmodSync(path.join(installPath, "steamcmd"), 0o755);
  } catch {
    /* ignore */
  }

  emit("steamcmd:status", {
    status: "initializing",
    message: "Initializing SteamCMD (first run)...",
  });
  const ldPaths = [
    path.join(installPath, "linux32"),
    path.join(installPath, "linux64"),
    installPath,
    process.env.LD_LIBRARY_PATH || "",
  ]
    .filter(Boolean)
    .join(":");

  await new Promise((resolve, reject) => {
    const proc = spawn(steamcmdExe, ["+quit"], {
      cwd: installPath,
      env: { ...process.env, LD_LIBRARY_PATH: ldPaths },
    });
    proc.stdout.on("data", (d) =>
      emit("steamcmd:log", { type: "stdout", text: d.toString() }),
    );
    proc.stderr.on("data", (d) =>
      emit("steamcmd:log", { type: "stderr", text: d.toString() }),
    );
    proc.on("close", (code) => {
      if (code === 0 || code === 7) {
        resolve();
      } else {
        reject(new Error(`SteamCMD first-run setup exited with code ${code}`));
      }
    });
    proc.on("error", reject);
  });

  if (!fs.existsSync(steamcmdExe)) {
    throw new Error(
      `SteamCMD download completed but ${steamcmdExe} still missing`,
    );
  }

  emit("steamcmd:status", {
    status: "complete",
    message: "SteamCMD installed successfully!",
    path: installPath,
  });
  log.info(`SteamCMD auto-installed to ${installPath}`);
  return steamcmdExe;
}

function normalizeSteamBranch(branch) {
  return !branch || branch === "stable" || branch === "public"
    ? "public"
    : branch;
}

function recoverMismatchedSteamBranchManifest(installPath, selectedBranch) {
  const manifestPath = path.join(
    installPath,
    "steamapps",
    "appmanifest_380870.acf",
  );
  if (!fs.existsSync(manifestPath)) return null;

  const manifest = fs.readFileSync(manifestPath, "utf-8");
  const mountedBranch = manifest.match(
    /"MountedConfig"\s*\{[\s\S]*?"BetaKey"\s*"([^"]+)"/,
  )?.[1];
  const targetBranch = normalizeSteamBranch(selectedBranch);
  if (!mountedBranch || mountedBranch === targetBranch) return null;

  const backupPath = `${manifestPath}.bak-${Date.now()}`;
  fs.copyFileSync(manifestPath, backupPath);
  fs.unlinkSync(manifestPath);
  return { mountedBranch, targetBranch, backupPath };
}

async function findSteamCmdPath() {
  const configuredPath = await getSetting("steamcmdPath");
  const candidates = [
    configuredPath,
    process.env.STEAMCMD_PATH,
    "/home/steam/steamcmd",
    "/home/steam/Steam/steamcmd",
    "/opt/steamcmd",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(getSteamCmdExe(candidate))) return candidate;
  }

  return null;
}

// Track active Steam operations to prevent concurrent runs on the same path
const activeSteamOperations = new Map();

function hasActiveSteamOperation(normalizedPath) {
  const operation = activeSteamOperations.get(normalizedPath);
  if (!operation) return false;

  if (Number.isInteger(operation.pid)) {
    try {
      process.kill(operation.pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") {
        activeSteamOperations.delete(normalizedPath);
        log.warn(
          `Cleared stale Steam ${operation.type} operation for ${normalizedPath}`,
        );
        return false;
      }
    }
  }

  return true;
}

// Helper to auto-configure RCON in the server's .ini file
// Called BEFORE server starts to ensure PZ reads the correct RCON credentials on boot.
// If the INI file doesn't exist yet (first run), creates the directory + a minimal INI
// so PZ will merge its defaults with our RCON settings instead of generating a blank password.
async function ensureRconConfigured() {
  try {
    const activeServer = await getActiveServer();
    if (!activeServer) {
      log.debug("ensureRconConfigured: No active server");
      return false;
    }

    const serverConfigPath =
      activeServer.serverConfigPath ||
      (activeServer.zomboidDataPath
        ? path.join(activeServer.zomboidDataPath, "Server")
        : null);
    const serverName = activeServer.serverName;
    const rconPassword = activeServer.rconPassword;
    const rconPort = activeServer.rconPort || 27015;

    if (!serverConfigPath || !serverName) {
      log.debug("ensureRconConfigured: Missing serverConfigPath or serverName");
      return false;
    }

    if (!rconPassword) {
      log.debug("ensureRconConfigured: No RCON password configured");
      return false;
    }

    const iniPath = path.join(serverConfigPath, `${serverName}.ini`);

    // Locked per-path: two overlapping calls (e.g. a start request racing a
    // settings save) must not interleave their read-modify-write of the INI.
    return await withFileLock(iniPath, async () => {
      // If the INI doesn't exist, pre-create it with RCON settings so PZ reads them on first boot
      if (!fs.existsSync(iniPath)) {
        log.info(
          `ensureRconConfigured: INI not found — pre-creating ${iniPath} with RCON settings`,
        );
        try {
          // Ensure the Server/ directory exists
          if (!fs.existsSync(serverConfigPath)) {
            fs.mkdirSync(serverConfigPath, { recursive: true });
            log.info(`Created server config directory: ${serverConfigPath}`);
          }
          const safePassword = sanitizeIniValue(rconPassword);
          // Create minimal INI — PZ will fill in all other defaults on first boot
          const minimalIni = `# Auto-generated by Zomboid Control Panel\n# PZ will add remaining default settings on first server start\nRCONPort=${rconPort}\nRCONPassword=${safePassword}\n`;
          writeFileAtomic(iniPath, minimalIni, {
            encoding: "utf-8",
            mode: 0o600,
          });
          log.info(`Pre-created INI with RCON settings (port: ${rconPort})`);
          return true;
        } catch (createError) {
          log.error(`Failed to pre-create INI file: ${createError.message}`);
          return false;
        }
      }

      // INI exists — check if RCON is already configured correctly
      let content = fs.readFileSync(iniPath, "utf-8").replace(/\r\n/g, "\n");
      const hasCorrectPassword = content.includes(
        `RCONPassword=${rconPassword}`,
      );
      const hasCorrectPort = content.includes(`RCONPort=${rconPort}`);

      if (hasCorrectPassword && hasCorrectPort) {
        log.debug("ensureRconConfigured: RCON already configured correctly");
        return true;
      }

      // Update RCON settings in the .ini file
      log.info(`Auto-configuring RCON in ${iniPath}`);

      // Update RCONPassword (sanitize to prevent INI injection via newlines)
      const safePassword = sanitizeIniValue(rconPassword);
      if (content.includes("RCONPassword=")) {
        content = content.replace(
          /RCONPassword=.*/g,
          () => `RCONPassword=${safePassword}`,
        );
      } else {
        content += `\nRCONPassword=${safePassword}`;
      }

      // Update RCONPort
      if (content.includes("RCONPort=")) {
        content = content.replace(/RCONPort=.*/g, () => `RCONPort=${rconPort}`);
      } else {
        content += `\nRCONPort=${rconPort}`;
      }

      writeFileAtomic(iniPath, content, { encoding: "utf-8", mode: 0o600 });
      log.info("RCON auto-configured successfully in server .ini file");
      return true;
    });
  } catch (error) {
    log.error(`ensureRconConfigured error: ${error.message}`);
    return false;
  }
}

// Helper functions for multi-server support
async function getServerConfigPath() {
  const activeServer = await getActiveServer();
  if (activeServer?.serverConfigPath) {
    return activeServer.serverConfigPath;
  }
  const legacyPath = await getSetting("serverConfigPath");
  return legacyPath || null;
}

async function getServerName() {
  const activeServer = await getActiveServer();
  if (activeServer?.serverName) {
    return activeServer.serverName;
  }
  const legacyName = await getSetting("serverName");
  return legacyName || "servertest";
}

// Security: Sanitize string for use in batch files/commands
function sanitizeForBatch(str) {
  if (!str) return "";
  // Remove or escape dangerous characters for batch files
  return String(str)
    .replace(/[&|<>^%"`;$(){}[\]!]/g, "") // Remove shell metacharacters
    .replace(/\.\./g, "") // Remove path traversal
    .trim();
}

// Security: Validate server name (alphanumeric, underscore, hyphen, space allowed)
// Spaces are permitted mid-name to match PZ server names like "The Gang Goes To Louisville".
// Leading/trailing spaces are trimmed before validation.
function isValidServerName(name) {
  if (!name || typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 64) return false;
  // Must start and end with alphanumeric/underscore/hyphen; spaces allowed in the middle.
  return /^[a-zA-Z0-9_-][a-zA-Z0-9_\- ]*[a-zA-Z0-9_-]$|^[a-zA-Z0-9_-]$/.test(
    trimmed,
  );
}

// Security: Validate path is safe (no traversal, absolute path)
function isValidPath(inputPath) {
  if (!inputPath || typeof inputPath !== "string") return false;
  const normalized = path.normalize(inputPath);
  // Check for path traversal attempts
  if (normalized.includes("..")) return false;
  // Must be absolute path
  if (!path.isAbsolute(normalized)) return false;
  return true;
}

function resolveZomboidPaths(installPath, zomboidDataPath) {
  const defaultZomboidDataPath =
    process.env.PZ_SAVE_PATH || `${installPath}_Data`;
  const zomboidPath = zomboidDataPath || defaultZomboidDataPath;

  return {
    zomboidPath,
    serverConfigPath: path.join(zomboidPath, "Server"),
    usesEnvironmentDataPath:
      !zomboidDataPath && Boolean(process.env.PZ_SAVE_PATH),
  };
}

function ensureWritableDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
  fs.accessSync(directoryPath, fs.constants.W_OK);
}

function formatWritablePathError(label, directoryPath) {
  const isContainer =
    !isWindows &&
    (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv"));
  const baseMessage = `${label} is not writable: ${directoryPath}.`;

  if (isContainer) {
    return (
      `${baseMessage} In Docker, bind-mount a writable host folder at this path ` +
      `and make it owned by the panel container UID/GID.`
    );
  }

  return `${baseMessage} Choose a folder writable by the panel process.`;
}

// Security: INI sanitization imported from shared util
// sanitizeIniValue strips \r\n;= to prevent injection

// Security: Validate integer in range
function validateInt(value, min, max, defaultVal) {
  const num = parseInt(value, 10);
  if (isNaN(num) || num < min || num > max) return defaultVal;
  return num;
}

// Build the Java classpath entries for launching the dedicated server.
// PZ's required classpath varies significantly by build/version — Build 41
// needs ~15 separate library jars listed individually under java/ (guava,
// lwjgl, javacord, sqlite-jdbc, etc.), while Build 42's shaded jar only
// needs projectzomboid.jar. Hardcoding either list breaks the other build
// with a NoClassDefFoundError (see GitHub issue #14). Instead, scan the
// java/ folder that SteamCMD actually downloaded and include every jar
// present, so the classpath always matches the installed build.
function buildClasspathEntries(installPath) {
  const entries = ["java/."];
  try {
    const javaDir = path.join(installPath, "java");
    if (fs.existsSync(javaDir)) {
      const jars = fs
        .readdirSync(javaDir)
        .filter((f) => f.toLowerCase().endsWith(".jar"))
        .sort();
      for (const jar of jars) {
        entries.push(`java/${jar}`);
      }
    }
  } catch (e) {
    log.warn(`Could not enumerate java/ jars for classpath: ${e.message}`);
  }
  // Fallback if the java/ folder wasn't found/readable (e.g. install not
  // finished yet) — matches the previous hardcoded behavior.
  if (entries.length === 1) {
    entries.push("java/projectzomboid.jar");
  }
  return entries;
}

// Generate a custom startup script with configured options
// Returns { bat: string, sh: string } with both Windows and Linux scripts
function generateStartupScripts(options) {
  const {
    installPath,
    serverName,
    minMemory = 4,
    maxMemory = 8,
    zomboidDataPath,
    adminPassword,
    serverPort = 16261,
    useNoSteam = false,
    useDebug = false,
  } = options;

  // Sanitize inputs
  const safeServerName = sanitizeForBatch(serverName);
  const safeAdminPassword = adminPassword
    ? sanitizeForBatch(adminPassword)
    : "";
  const safeZomboidDataPath = zomboidDataPath
    ? sanitizeForBatch(zomboidDataPath)
    : "";
  const normalizedMinMemory = normalizeMemoryGb(minMemory, 4);
  const normalizedMaxMemory = normalizeMemoryGb(maxMemory, 8);

  // ZGC grows the heap to -Xmx and is in no hurry to give it back, so a
  // generous max quietly turns into the resident set. SoftMaxHeapSize is the
  // pressure valve: GC aims to stay under it and only spends the rest of -Xmx
  // on real spikes, which keeps PZ from crowding out everything else on the
  // host. 60% of max leaves a wide burst margin.
  const softMaxMemory = Math.max(1, Math.round(normalizedMaxMemory * 0.6));

  // Build JVM arguments (shared between both platforms)
  // IgnoreUnrecognizedVMOptions first: the Linux script falls back to a system
  // JVM when jre64/ is missing, and the newer flags below are fatal on older
  // JVMs unless they're allowed to no-op.
  const jvmArgs = [
    "-XX:+IgnoreUnrecognizedVMOptions",
    "-Djava.awt.headless=true",
    useNoSteam ? "-Dzomboid.steam=0" : "-Dzomboid.steam=1",
    "-Dzomboid.znetlog=1",
    "-XX:+UseZGC",
    `-XX:SoftMaxHeapSize=${softMaxMemory}g`,
    // Return freed heap to the OS in 2 minutes instead of the 5-minute default.
    "-XX:ZUncommitDelay=120",
    // JDK 25+: 8-byte object headers. PZ's heap is millions of small objects
    // (grid squares, tile properties, items), so this is a real footprint win.
    "-XX:+UseCompactObjectHeaders",
    // Scripts/tiles/item names load a lot of duplicate strings.
    "-XX:+UseStringDeduplication",
    "-XX:-CreateCoredumpOnCrash",
    "-XX:-OmitStackTraceInFastThrow",
    `-Xms${normalizedMinMemory}g`,
    `-Xmx${normalizedMaxMemory}g`,
  ];

  if (useDebug) {
    jvmArgs.push("-Ddebug");
  }

  // Linux-only additions. THP cuts TLB misses on ZGC's large heap; it needs the
  // host's transparent_hugepage set to "madvise" or "always" to do anything, and
  // just logs a notice otherwise. urandom keeps startup from blocking on entropy.
  const linuxJvmArgs = [
    ...jvmArgs,
    "-XX:+UseTransparentHugePages",
    "-Djava.security.egd=file:/dev/urandom",
  ];

  // Build game arguments (shared)
  const gameArgs = [`-servername "${safeServerName}"`];

  if (safeZomboidDataPath) {
    gameArgs.push(`-cachedir="${safeZomboidDataPath}"`);
  }

  if (safeAdminPassword) {
    gameArgs.push(`-adminpassword "${safeAdminPassword}"`);
  }

  if (serverPort !== 16261) {
    gameArgs.push(`-port ${serverPort}`);
  }

  if (useNoSteam) {
    gameArgs.push("-nosteam");
  }

  const classpathEntries = buildClasspathEntries(installPath);

  // Windows batch file
  const batchContent = `@echo off
@setlocal enableextensions
@cd /d "%~dp0"

REM =====================================================
REM Project Zomboid Server Startup Script
REM Generated by PZ Server Manager
REM Server Name: ${safeServerName}
REM Memory: ${normalizedMinMemory}GB - ${normalizedMaxMemory}GB
REM =====================================================

SET PZ_CLASSPATH=${classpathEntries.join(";")}

".\\jre64\\bin\\java.exe" ${jvmArgs.join(" ")} -Djava.library.path=natives/;natives/win64/;. -cp %PZ_CLASSPATH% zombie.network.GameServer ${gameArgs.join(" ")}

PAUSE
`;

  // Linux shell script
  const shellContent = `#!/bin/bash
cd "\$(dirname "\$0")"

# =====================================================
# Project Zomboid Server Startup Script
# Generated by PZ Server Manager
# Server Name: ${safeServerName}
# Memory: ${normalizedMinMemory}GB - ${normalizedMaxMemory}GB
# =====================================================

PZ_CLASSPATH="${classpathEntries.join(":")}"

JAVA_CMD="./jre64/bin/java"
if [ ! -f "$JAVA_CMD" ]; then
  # Try common system Java locations (CentOS, Ubuntu, etc.)
  for JPATH in /usr/bin/java /usr/local/bin/java /usr/lib/jvm/jre/bin/java; do
    if [ -f "$JPATH" ]; then
      JAVA_CMD="$JPATH"
      break
    fi
  done
  if [ ! -f "$JAVA_CMD" ]; then
    JAVA_CMD="java"
  fi
fi

# Verify Java is actually available
if ! command -v "$JAVA_CMD" >/dev/null 2>&1; then
  echo "ERROR: Java not found. Install OpenJDK: sudo yum install java-17-openjdk (CentOS) or sudo apt install openjdk-17-jre (Ubuntu)"
  exit 1
fi

INSTDIR="$(dirname "$0")"
export LD_LIBRARY_PATH="\${INSTDIR}/natives/:\${INSTDIR}/natives/linux64/:\${INSTDIR}/linux64/:\${INSTDIR}:\${INSTDIR}/jre64/lib/amd64:\${INSTDIR}/jre64/lib/x86_64:/usr/lib64:\${LD_LIBRARY_PATH}"

"$JAVA_CMD" ${linuxJvmArgs.join(" ")} -Djava.library.path=natives/:natives/linux64/:linux64/:. -cp "$PZ_CLASSPATH" zombie.network.GameServer ${gameArgs.join(" ")}
`;

  return { bat: batchContent, sh: shellContent };
}

// Get server status
router.get("/status", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    const rconService = req.app.get("rconService");
    log.debug("GET /status");

    const status = await serverManager.getServerStatus();
    const rconStatus = rconService.getConfig();

    res.json({
      ...status,
      rcon: rconStatus,
    });
  } catch (error) {
    log.error(`Failed to get server status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// List every non-internal IPv4 address the host currently has (one per
// network adapter/VPN mesh) so Settings can offer a picker instead of the
// dashboard guessing which one to show.
router.get("/network-interfaces", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    res.json({ interfaces: serverManager.listNetworkInterfaces() });
  } catch (error) {
    log.error(`Failed to list network interfaces: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Start server
router.post("/start", async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    log.info(
      `POST /start (server=${activeServer?.name || "unknown"}, remote=${activeServer?.isRemote || false})`,
    );
    if (activeServer?.isRemote) {
      return res.status(400).json({
        error:
          "Cannot start a remote server. Remote servers are managed externally — use RCON to interact.",
      });
    }

    const serverManager = req.app.get("serverManager");
    const rconService = req.app.get("rconService");

    // A container-managed server is started through Docker: the panel has no
    // process to spawn, and after a `docker stop` there is nothing left running
    // for it to reattach to.
    const managed = await runManagedLifecycle("start");
    if (managed.handled && !managed.success) {
      return res.status(502).json({ error: sanitizeError(managed.error) });
    }

    // Pre-configure RCON in the INI BEFORE starting the server process.
    // PZ reads the INI at startup, so we must write the password first.
    // On first run this also pre-creates the INI file with RCON settings.
    try {
      const rconReady = await ensureRconConfigured();
      if (rconReady) {
        log.info("RCON pre-configured in INI before server start");
      } else {
        log.warn(
          "Could not pre-configure RCON — will retry during startup polling",
        );
      }
    } catch (rconErr) {
      log.warn(`RCON pre-configuration failed: ${rconErr.message}`);
    }

    // Regenerate startup scripts so any config changes (admin password, memory, etc.) take effect.
    // Skipped for a managed container: its image owns the launch command.
    if (
      !managed.handled &&
      activeServer &&
      !activeServer.startCommand &&
      activeServer.installPath
    ) {
      try {
        const scripts = generateStartupScripts({
          installPath: activeServer.installPath,
          serverName: activeServer.serverName,
          minMemory: activeServer.minMemory || 4,
          maxMemory: activeServer.maxMemory || 8,
          zomboidDataPath: activeServer.zomboidDataPath || "",
          adminPassword: activeServer.adminPassword || "",
          serverPort: activeServer.serverPort || 16261,
          useNoSteam: activeServer.useNoSteam || false,
          useDebug: activeServer.useDebug || false,
        });
        const batPath = path.join(
          activeServer.installPath,
          `StartServer_${activeServer.serverName}.bat`,
        );
        writeFileAtomic(batPath, scripts.bat, "utf8");
        const shPath = path.join(
          activeServer.installPath,
          `start-server_${activeServer.serverName}.sh`,
        );
        writeFileAtomic(shPath, scripts.sh.replace(/\r\n/g, "\n"), {
          encoding: "utf8",
          mode: 0o750,
        });
        log.info("Regenerated startup scripts with current server config");
      } catch (scriptErr) {
        log.warn(`Could not regenerate startup scripts: ${scriptErr.message}`);
      }
    }

    const result = managed.handled
      ? { success: true, message: managed.message || "Container starting" }
      : await serverManager.startServer();

    // Emit status update via Socket.IO
    const io = req.app.get("io");

    // Set flag to prevent RCON reconnect attempts during startup
    // Use setServerStarting which has a 5-minute failsafe timeout
    if (rconService.setServerStarting) {
      rconService.setServerStarting(true);
    } else {
      rconService.serverStarting = true;
    }

    // Poll for server to actually be running (takes a few seconds to start)
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds max
    let pollCleared = false;

    const pollInterval = setInterval(async () => {
      if (pollCleared) return; // Safety check
      try {
        attempts++;
        const isRunning = await serverManager.checkServerRunning();

        if (isRunning) {
          pollCleared = true;
          clearInterval(pollInterval);
          if (io) io.emit("server:status", { running: true });
          log.info("Server detected as running");

          // Wait for RCON to be ready (PZ takes 60-180s to fully start)
          // Look for open port instead of blindly waiting
          // Keep serverStarting=true the whole time to block auto-reconnect
          log.info("Waiting for RCON to be ready - starting port polling...");

          await rconService.loadConfig(); // Ensure clean config
          const rconHost = rconService.config.host || "127.0.0.1";
          const rconPort = rconService.config.port || 27015;
          log.info(
            `Monitoring TCP port ${rconHost}:${rconPort} for activity...`,
          );

          let rconConnected = false;
          let rconConfigured = false;
          let portOpen = false;

          // Poll port for up to 5 minutes (300 seconds) - checking every 5 seconds
          const maxPollAttempts = 60;

          for (let i = 0; i < maxPollAttempts; i++) {
            // 1. Check if port is open (if not already found)
            if (!portOpen) {
              portOpen = await rconService.checkPortOpen(rconHost, rconPort);

              if (!portOpen) {
                log.debug(
                  `RCON startup: Port ${rconHost}:${rconPort} not yet open (poll ${i + 1}/${maxPollAttempts})...`,
                );
                // Wait 5 seconds before next check
                await new Promise((r) => setTimeout(r, 5000));

                // Periodically try to configure RCON (Wait for .ini to appear)
                if (!rconConfigured && i % 3 === 0) {
                  // Every 15s (3 * 5s)
                  rconConfigured = await ensureRconConfigured();
                  if (rconConfigured) {
                    log.info(
                      "RCON settings auto-configured in server .ini file during startup wait",
                    );
                  }
                }
                continue;
              }
              log.info(
                `RCON port ${rconHost}:${rconPort} is now open! Initiating connection...`,
              );
            }

            // 2. Port is open, try to connect
            // Reset connection state before attempt to clear any stalled state
            if (rconService.forceResetConnectionState) {
              rconService.forceResetConnectionState();
            }

            try {
              // Attempt connection with a 15s timeout
              const connectPromise = rconService.connect();
              const timeoutPromise = new Promise((_, reject) =>
                setTimeout(
                  () =>
                    reject(new Error("Connection attempt timed out after 15s")),
                  15000,
                ),
              );

              await Promise.race([connectPromise, timeoutPromise]);

              if (rconService.connected) {
                log.info("RCON connected successfully after server startup");
                rconConnected = true;
                break;
              } else {
                log.warn(
                  `RCON connected to port but authentication/handshake failed. Retrying...`,
                );
                // Wait a bit before retry if port is open but auth fails (service might be starting up)
                await new Promise((r) => setTimeout(r, 5000));
              }
            } catch (e) {
              log.warn(`RCON connection attempt failed: ${e.message}`);
              await new Promise((r) => setTimeout(r, 5000));
            }
          }

          // Log completion status
          if (rconConnected) {
            log.info("RCON startup sequence completed - connected");
            req.app
              .get("discordBot")
              ?.sendEventNotification("serverStart", {})
              .catch((err) =>
                log.debug(
                  `Discord serverStart notification failed: ${err.message}`,
                ),
              );
          } else {
            log.warn(
              "RCON startup sequence completed - NOT connected (auto-reconnect will keep trying every 30s)",
            );
          }

          // Clear the flag when done - now auto-reconnect can take over
          if (rconService.setServerStarting) {
            rconService.setServerStarting(false);
          } else {
            rconService.serverStarting = false;
          }
        } else if (attempts >= maxAttempts) {
          pollCleared = true;
          clearInterval(pollInterval);
          if (rconService.setServerStarting) {
            rconService.setServerStarting(false);
          } else {
            rconService.serverStarting = false;
          }
          log.warn("Server start polling timed out");
        }
      } catch (err) {
        // Clear interval on error to prevent memory leak
        pollCleared = true;
        clearInterval(pollInterval);
        if (rconService.setServerStarting) {
          rconService.setServerStarting(false);
        } else {
          rconService.serverStarting = false;
        }
        log.error(`Server status poll failed: ${err.message}`);
      }
    }, 1000);

    // Send immediate response
    res.json(result);
  } catch (error) {
    log.error(`Failed to start server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Stop server (graceful via RCON)
router.post("/stop", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    log.info("POST /stop — graceful shutdown requested");

    // Check if RCON is connected first
    if (!rconService.connected) {
      return res
        .status(400)
        .json({ error: "RCON not connected. Cannot gracefully stop server." });
    }

    // Save first — quitting after a failed save discards everything since
    // the last one.
    const saved = await rconService.save();
    if (!saved?.success) {
      return res.status(502).json({
        error: `Save failed, so the server was left running: ${sanitizeError(saved?.error)}`,
      });
    }

    // A container-managed server must go down through Docker. RCON quit kills
    // PID 1 inside the container, which exits the container and lets its
    // restart policy bring the world straight back up.
    const managed = await runManagedLifecycle("stop");
    if (managed.handled && !managed.success) {
      return res.status(502).json({
        error: `The world was saved, but the container could not be stopped: ${sanitizeError(managed.error)}`,
      });
    }

    const result = managed.handled
      ? { success: true, message: managed.message || "Container stopping" }
      : await rconService.quit();

    const io = req.app.get("io");
    if (io) io.to("server-status").emit("server:status", { running: false });

    await logServerEvent("server_stop", "Server stopped via web UI");
    req.app
      .get("discordBot")
      ?.sendEventNotification("serverStop", {})
      .catch((err) =>
        log.debug(`Discord serverStop notification failed: ${err.message}`),
      );
    res.json(result);
  } catch (error) {
    log.error(`Failed to stop server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Force stop server
router.post("/force-stop", async (req, res) => {
  try {
    log.info("POST /force-stop — force kill requested");
    const activeServer = await getActiveServer();
    if (activeServer?.isRemote) {
      return res.status(400).json({
        error:
          "Cannot force-stop a remote server. The process is not managed by this panel.",
      });
    }

    // Killing the PID of a containerized server just triggers its restart
    // policy. Docker's stop escalates SIGTERM to SIGKILL on its own and, unlike
    // a process kill, keeps the container down afterwards.
    const managed = await runManagedLifecycle("stop");
    if (managed.handled && !managed.success) {
      return res.status(502).json({ error: sanitizeError(managed.error) });
    }

    const serverManager = req.app.get("serverManager");
    const result = managed.handled
      ? {
          success: true,
          message:
            managed.message ||
            "Container stopped. Docker ran the container's own shutdown handler before killing it.",
        }
      : await serverManager.stopServer(false);

    const io = req.app.get("io");
    if (io) io.to("server-status").emit("server:status", { running: false });

    res.json(result);
  } catch (error) {
    log.error(`Failed to force stop server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Restart server
router.post("/restart", async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    if (activeServer?.isRemote) {
      return res.status(400).json({
        error:
          "Cannot restart a remote server. The process is not managed by this panel.",
      });
    }

    const scheduler = req.app.get("scheduler");
    // Parse and clamp warningMinutes to 0-60 (matches /api/scheduler/restart-now)
    let warningMinutes = parseInt(req.body.warningMinutes, 10);
    if (isNaN(warningMinutes) || warningMinutes < 0) {
      warningMinutes = 5; // Default
    } else if (warningMinutes > 60) {
      warningMinutes = 60; // Cap at 60 minutes
    }

    // Run restart in background with specified warning time
    scheduler.performRestart(warningMinutes).catch((err) => {
      log.error(`Restart failed: ${err.message}`);
    });

    res.json({
      success: true,
      message:
        warningMinutes > 0
          ? `Restart initiated with ${warningMinutes} minute warning`
          : "Immediate restart initiated",
    });
  } catch (error) {
    log.error(`Failed to restart server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Save world
router.post("/save", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.save();
    res.json(result);
  } catch (error) {
    log.error(`Failed to save world: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Send server message
router.post("/message", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    if (typeof message !== "string" || message.length > 1000) {
      return res
        .status(400)
        .json({ error: "Message must be a string under 1000 characters" });
    }

    // Strip newlines/carriage returns to prevent RCON protocol injection
    const safeMessage = message.replace(/[\r\n]/g, " ");

    const result = await rconService.serverMessage(safeMessage);
    res.json(result);
  } catch (error) {
    log.error(`Failed to send message: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Weather controls
router.post("/weather/start-rain", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { intensity } = req.body;
    const result = await rconService.startRain(intensity);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/stop-rain", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.stopRain();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/start-storm", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { duration } = req.body;
    const result = await rconService.startStorm(duration);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/stop", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.stopWeather();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Events
router.post("/events/chopper", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.triggerChopper();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/events/gunshot", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.triggerGunshot();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/events/lightning", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { username } = req.body;
    if (username && (typeof username !== "string" || username.length > 64)) {
      return res.status(400).json({ error: "Invalid username" });
    }
    const result = await rconService.triggerLightning(username);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/events/thunder", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { username } = req.body;
    if (username && (typeof username !== "string" || username.length > 64)) {
      return res.status(400).json({ error: "Invalid username" });
    }
    const result = await rconService.triggerThunder(username);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/events/horde", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { count, username } = req.body;
    const safeCount = validateInt(count, 1, 500, 50);
    if (username && (typeof username !== "string" || username.length > 64)) {
      return res.status(400).json({ error: "Invalid username" });
    }
    const result = await rconService.createHorde(safeCount, username);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Fallback branches if dynamic fetch fails
// These are the known valid Steam branches for PZ Dedicated Server (App ID 380870)
const FALLBACK_BRANCHES = [
  { name: "public", description: "Current stable release. Recommended for most servers." },
  { name: "unstable", description: "Build 42 testing branch, including multiplayer. Back up saves and expect mod incompatibilities." },
  { name: "iwbums", description: "Experimental testing branch. Back up saves before switching." },
  { name: "legacy41", description: "Legacy Build 41 branch for older worlds and mods." },
];

router.get("/steamcmd/detect", async (_req, res) => {
  try {
    const steamcmdPath = await findSteamCmdPath();
    if (!steamcmdPath) {
      return res.json({ found: false, message: "SteamCMD was not found automatically" });
    }

    const configuredPath = await getSetting("steamcmdPath");
    if (configuredPath !== steamcmdPath) {
      await setSetting("steamcmdPath", steamcmdPath);
    }

    res.json({
      found: true,
      path: steamcmdPath,
      executable: getSteamCmdExe(steamcmdPath),
      message: "SteamCMD found automatically",
    });
  } catch (error) {
    log.warn(`Failed to detect SteamCMD: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get available Steam branches for PZ Dedicated Server (App ID 380870)
router.get("/branches", async (req, res) => {
  try {
    const steamcmdPath =
      req.query.steamcmdPath || (await getSetting("steamcmdPath"));
    log.info(
      `GET /branches (steamcmdPath=${steamcmdPath || "not configured"})`,
    );

    if (!steamcmdPath) {
      // Return fallback branches if no SteamCMD configured
      return res.json({
        branches: FALLBACK_BRANCHES,
        source: "fallback",
        message: "SteamCMD path not configured, using fallback branches",
      });
    }

    const steamcmdExe = getSteamCmdExe(steamcmdPath);
    if (!fs.existsSync(steamcmdExe)) {
      return res.json({
        branches: FALLBACK_BRANCHES,
        source: "fallback",
        message: "SteamCMD not found, using fallback branches",
      });
    }

    // Run SteamCMD to get app info
    const steamcmdArgs = [
      "+login",
      "anonymous",
      "+app_info_update",
      "1",
      "+app_info_print",
      "380870",
      "+quit",
    ];

    const result = await new Promise((resolve, reject) => {
      // On Linux, set LD_LIBRARY_PATH for SteamCMD's 32-bit libraries
      const branchSpawnOpts = { cwd: steamcmdPath, timeout: 60000 };
      if (!isWindows) {
        const ldPaths = [
          path.join(steamcmdPath, "linux32"),
          path.join(steamcmdPath, "linux64"),
          steamcmdPath,
          process.env.LD_LIBRARY_PATH || "",
        ]
          .filter(Boolean)
          .join(":");
        branchSpawnOpts.env = { ...process.env, LD_LIBRARY_PATH: ldPaths };
      }
      const steamcmd = spawn(steamcmdExe, steamcmdArgs, branchSpawnOpts);

      let stdout = "";
      let stderr = "";
      let completed = false;

      // Timeout after 30 seconds
      const timeoutId = setTimeout(() => {
        if (!completed) {
          completed = true;
          steamcmd.kill();
          reject(new Error("SteamCMD timed out"));
        }
      }, 30000);

      steamcmd.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      steamcmd.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      steamcmd.on("close", (code) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);
          resolve({ code, stdout, stderr });
        }
      });

      steamcmd.on("error", (err) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
    });

    // Parse the output to find branches
    const branches = parseSteamBranches(result.stdout);

    if (branches.length === 0) {
      return res.json({
        branches: FALLBACK_BRANCHES,
        source: "fallback",
        message: "Could not parse branches from SteamCMD output",
      });
    }

    res.json({
      branches,
      source: "steam",
      message: "Branches fetched from Steam",
    });
  } catch (error) {
    log.warn(`Failed to fetch Steam branches: ${error.message}`);
    res.json({
      branches: FALLBACK_BRANCHES,
      source: "fallback",
      message: `Error: ${sanitizeError(error.message)}`,
    });
  }
});

// Parse Steam app_info output to extract branches
function parseSteamBranches(output) {
  const branches = [];

  try {
    // Look for the "branches" section in VDF format
    // Format is like:
    // "branches"
    // {
    //   "public"
    //   {
    //     "buildid" "12345"
    //     "timeupdated" "1234567890"
    //   }
    //   "unstable"
    //   {
    //     "buildid" "12346"
    //     "description" "Build 42"
    //     ...
    //   }
    // }

    const branchesMatch = output.match(/"branches"\s*\{([^]*?)\n\t\t\}/);
    const altMatch = !branchesMatch
      ? output.match(/"branches"\s*\{([^]*?)\}\s*"installedrepots"/i)
      : null;

    if (!branchesMatch && !altMatch) {
      return branches;
    }

    const branchesSection = (branchesMatch || altMatch)[1];

    // Extract individual branch names and their properties
    // Match pattern: "branchname" followed by { ... }
    const branchRegex = /^\s*"([^"]+)"\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/gm;
    let match;

    while ((match = branchRegex.exec(branchesSection)) !== null) {
      const branchName = match[1];
      const branchContent = match[2];

      // Skip password-protected branches
      if (
        branchContent.includes('"pwdrequired"') &&
        branchContent.includes('"1"')
      ) {
        continue;
      }

      // Extract description if available
      const descMatch = branchContent.match(/"description"\s+"([^"]+)"/);
      const description = descMatch
        ? descMatch[1]
        : branchName === "public"
          ? "Default stable branch"
          : "";

      // Extract buildid for reference
      const buildMatch = branchContent.match(/"buildid"\s+"(\d+)"/);
      const buildId = buildMatch ? buildMatch[1] : null;

      // Extract time updated
      const timeMatch = branchContent.match(/"timeupdated"\s+"(\d+)"/);
      const timeUpdated = timeMatch
        ? new Date(parseInt(timeMatch[1], 10) * 1000).toISOString()
        : null;

      branches.push({
        name: branchName,
        description: description || branchName,
        buildId,
        timeUpdated,
      });
    }

    // Sort: public first, then alphabetically
    branches.sort((a, b) => {
      if (a.name === "public") return -1;
      if (b.name === "public") return 1;
      return a.name.localeCompare(b.name);
    });
  } catch (err) {
    log.warn(`Failed to parse Steam branches: ${err.message}`);
  }

  return branches;
}

// Helper to build Steam beta arguments as array
function getBetaArgs(branch) {
  if (!branch || branch === "stable" || branch === "public") return [];
  // Backwards compatibility: treat boolean true as 'unstable'
  if (branch === true) return ["-beta", "unstable"];
  // Allow any branch name - Steam will validate it
  return ["-beta", branch];
}

async function getSteamLoginArgs() {
  const account = String((await getSetting("steamUpdateAccount")) || "").trim();
  return ["+login", account || "anonymous"];
}

// SteamCMD Installation endpoint
router.post("/install", async (req, res) => {
  try {
    const {
      steamcmdPath,
      installPath,
      serverName,
      branch,
      useUnstable, // Legacy support
      // New options
      zomboidDataPath,
      minMemory = 4,
      maxMemory = 8,
      adminPassword,
      serverPort = 16261,
      useUpnp = true,
      useNoSteam = false,
      useDebug = false,
      // RCON settings
      rconPassword,
      rconPort = 27015,
    } = req.body;

    // Determine branch - support both new 'branch' param and legacy 'useUnstable'
    const selectedBranch = branch || (useUnstable ? "unstable" : "stable");
    log.info(
      `POST /install (steamcmd=${steamcmdPath}, install=${installPath}, server=${serverName}, branch=${selectedBranch}, noSteam=${useNoSteam}, debug=${useDebug})`,
    );

    // Validate paths - Security check for path traversal
    if (!steamcmdPath || !installPath || !serverName) {
      return res.status(400).json({
        error: "Missing required fields: steamcmdPath, installPath, serverName",
      });
    }

    if (!isValidPath(steamcmdPath)) {
      return res.status(400).json({ error: "Invalid SteamCMD path" });
    }

    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: "Invalid install path" });
    }

    if (!isValidServerName(serverName)) {
      return res.status(400).json({
        error:
          "Invalid server name. Use only letters, numbers, underscores, hyphens, and spaces (max 64 chars)",
      });
    }

    if (zomboidDataPath && !isValidPath(zomboidDataPath)) {
      return res.status(400).json({ error: "Invalid Zomboid data path" });
    }

    const { zomboidPath, serverConfigPath, usesEnvironmentDataPath } =
      resolveZomboidPaths(installPath, zomboidDataPath);

    try {
      ensureWritableDirectory(installPath);
    } catch (directoryError) {
      return res.status(400).json({
        error: formatWritablePathError("Installation path", installPath),
      });
    }

    try {
      ensureWritableDirectory(serverConfigPath);
    } catch (directoryError) {
      return res.status(400).json({
        error: formatWritablePathError("Zomboid data folder", zomboidPath),
      });
    }

    // Validate numeric inputs
    const safeMinMemory = validateInt(minMemory, 1, 64, 4);
    const safeMaxMemory = validateInt(maxMemory, 1, 128, 8);
    const safeServerPort = validateInt(serverPort, 1024, 65535, 16261);
    const safeRconPort = validateInt(rconPort, 1024, 65535, 27015);

    // Sanitize string inputs for batch file
    const safeAdminPassword = sanitizeForBatch(adminPassword);

    // Check if steamcmd exists — auto-download it on Linux instead of
    // hard-failing (see ensureSteamCmdLinux for why: fresh volumes, or a
    // previous install that never finished, shouldn't force a manual
    // re-run of the setup wizard).
    let steamcmdExe = getSteamCmdExe(steamcmdPath);
    if (!fs.existsSync(steamcmdExe)) {
      if (isWindows) {
        return res
          .status(400)
          .json({ error: `SteamCMD not found at: ${steamcmdExe}` });
      }
      try {
        steamcmdExe = await ensureSteamCmdLinux(
          steamcmdPath,
          req.app.get("io"),
        );
      } catch (dlErr) {
        return res.status(500).json({
          error: `SteamCMD not found and auto-download failed: ${sanitizeError(dlErr.message)}`,
        });
      }
    }

    // Prevent concurrent operations on the same install path
    const normalizedPath = path.normalize(installPath).toLowerCase();
    if (hasActiveSteamOperation(normalizedPath)) {
      return res.status(409).json({
        error:
          "A Steam operation is already in progress for this path. Please wait for it to complete.",
      });
    }

    log.info(
      `Starting PZ server installation to ${installPath} (branch: ${selectedBranch})`,
    );

    // Mark operation as active
    activeSteamOperations.set(normalizedPath, {
      type: "install",
      startTime: Date.now(),
      branch: selectedBranch,
      serverName,
    });

    // Build SteamCMD command
    // App ID 380870 is Project Zomboid Dedicated Server
    const betaArgs = getBetaArgs(selectedBranch);
    const loginArgs = await getSteamLoginArgs();
    const steamcmdArgs = [
      "+force_install_dir",
      installPath,
      ...loginArgs,
      "+app_update",
      "380870",
      ...betaArgs,
      "validate",
      "+quit",
    ];

    const io = req.app.get("io");

    // Spawn SteamCMD process
    // On Linux, set LD_LIBRARY_PATH so SteamCMD can find its 32-bit libraries
    const spawnOpts = { cwd: steamcmdPath };
    if (!isWindows) {
      const ldPaths = [
        path.join(steamcmdPath, "linux32"),
        path.join(steamcmdPath, "linux64"),
        steamcmdPath,
        process.env.LD_LIBRARY_PATH || "",
      ]
        .filter(Boolean)
        .join(":");
      spawnOpts.env = { ...process.env, LD_LIBRARY_PATH: ldPaths };
    }
    const steamcmd = spawn(steamcmdExe, steamcmdArgs, spawnOpts);
    activeSteamOperations.get(normalizedPath).pid = steamcmd.pid;

    let output = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";

    steamcmd.stdout.on("data", (data) => {
      const text = data.toString();
      output += text;
      stdoutBuffer += text;

      // Split by newlines and emit each line for real-time streaming
      const lines = stdoutBuffer.split(/\r?\n/);
      // Keep the last incomplete line in the buffer
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          io.emit("install:log", { type: "stdout", text: line });
          log.info(`SteamCMD: ${line}`);
        }
      }
    });

    steamcmd.stderr.on("data", (data) => {
      const text = data.toString();
      output += text;
      stderrBuffer += text;

      // Split by newlines and emit each line for real-time streaming
      const lines = stderrBuffer.split(/\r?\n/);
      // Keep the last incomplete line in the buffer
      stderrBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          io.emit("install:log", { type: "stderr", text: line });
          log.warn(`SteamCMD stderr: ${line}`);
        }
      }
    });

    steamcmd.on("close", async (code) => {
      // Flush any remaining buffered output
      if (stdoutBuffer.trim()) {
        io.emit("install:log", { type: "stdout", text: stdoutBuffer.trim() });
        log.info(`SteamCMD: ${stdoutBuffer.trim()}`);
      }
      if (stderrBuffer.trim()) {
        io.emit("install:log", { type: "stderr", text: stderrBuffer.trim() });
        log.warn(`SteamCMD stderr: ${stderrBuffer.trim()}`);
      }

      if (code === 0) {
        log.info("PZ server installation completed successfully");

        // Auto-update settings with new paths
        await setSetting("serverPath", installPath);
        await setSetting("serverName", serverName);
        await setSetting("minMemory", minMemory);
        await setSetting("maxMemory", maxMemory);
        await setSetting("serverPort", serverPort);
        await setSetting("useUpnp", useUpnp);

        if (zomboidDataPath) {
          await setSetting("zomboidDataPath", zomboidDataPath);
        } else {
          await setSetting("zomboidDataPath", zomboidPath);
          io.emit("install:log", {
            type: "stdout",
            text: `Using ${usesEnvironmentDataPath ? "configured" : "isolated"} data folder: ${zomboidPath}`,
          });
        }

        await setSetting("serverConfigPath", serverConfigPath);

        // Re-check after the download in case a mounted path changed while
        // SteamCMD was running.
        try {
          ensureWritableDirectory(serverConfigPath);
        } catch (dirError) {
          log.error(
            `Data folder is not writable: ${zomboidPath} (${dirError.message})`,
          );
          io.emit("install:complete", {
            success: false,
            message:
              `Server files installed, but the data folder is not writable: ${zomboidPath} (${dirError.code || dirError.message}). ` +
              `Create it with the correct owner before starting the server, e.g. on Linux: ` +
              `sudo install -d -m 0755 -o "$(whoami)" -g "$(whoami)" "${zomboidPath}", then retry.`,
            installPath,
            serverName,
          });
          activeSteamOperations.delete(normalizedPath);
          return;
        }

        // Save RCON settings for later use
        if (rconPassword) {
          await setSetting("rconPassword", rconPassword);
          await setSetting("rconPort", rconPort);
          await setSetting("rconHost", "127.0.0.1");
          io.emit("install:log", {
            type: "stdout",
            text: `RCON settings saved (port: ${rconPort})`,
          });

          // Pre-create INI with RCON settings so PZ reads them on first boot
          // (PZ reads the INI at startup - if we wait until after, the password won't take effect)
          try {
            const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
            if (!fs.existsSync(iniPath)) {
              if (!fs.existsSync(serverConfigPath)) {
                fs.mkdirSync(serverConfigPath, { recursive: true });
              }
              const safeRconPw = sanitizeIniValue(rconPassword);
              const minimalIni = `# Auto-generated by Zomboid Control Panel\n# PZ will add remaining default settings on first server start\nRCONPort=${safeRconPort}\nRCONPassword=${safeRconPw}\n`;
              writeFileAtomic(iniPath, minimalIni, {
                encoding: "utf-8",
                mode: 0o600,
              });
              log.info(`Pre-created INI with RCON settings at ${iniPath}`);
              io.emit("install:log", {
                type: "stdout",
                text: "Pre-created server INI with RCON credentials",
              });
            }
          } catch (iniError) {
            log.warn(`Failed to pre-create INI: ${iniError.message}`);
          }
        }

        // Generate custom startup scripts (both .bat and .sh)
        try {
          const scripts = generateStartupScripts({
            installPath,
            serverName,
            minMemory: safeMinMemory,
            maxMemory: safeMaxMemory,
            zomboidDataPath: zomboidPath,
            adminPassword: safeAdminPassword,
            serverPort: safeServerPort,
            useNoSteam,
            useDebug,
          });

          const batchPath = path.join(
            installPath,
            `StartServer_${serverName}.bat`,
          );
          writeFileAtomic(batchPath, scripts.bat, "utf8");
          log.info(`Created custom startup batch: ${batchPath}`);

          const shellPath = path.join(
            installPath,
            `start-server_${serverName}.sh`,
          );
          writeFileAtomic(shellPath, scripts.sh.replace(/\r\n/g, "\n"), {
            encoding: "utf8",
            mode: 0o750,
          });
          log.info(`Created custom startup script: ${shellPath}`);

          const scriptName =
            process.platform === "win32"
              ? `StartServer_${serverName}.bat`
              : `start-server_${serverName}.sh`;
          io.emit("install:log", {
            type: "stdout",
            text: `Created custom startup script: ${scriptName}`,
          });
        } catch (batchError) {
          log.warn(`Failed to create startup scripts: ${batchError.message}`);
        }

        logServerEvent(
          "server_install",
          `Installed PZ server to ${installPath} (${selectedBranch} branch)`,
        );

        // Auto-install PanelBridge mod to the server
        try {
          const possibleModPaths = [
            path.join(process.cwd(), "pz-mod", "PanelBridge"),
            path.join(path.dirname(process.execPath), "pz-mod", "PanelBridge"),
          ];

          let modSourcePath = null;
          for (const p of possibleModPaths) {
            if (fs.existsSync(p)) {
              modSourcePath = p;
              break;
            }
          }

          if (modSourcePath) {
            const sourceLuaFile = path.join(
              modSourcePath,
              "media",
              "lua",
              "server",
              "PanelBridge.lua",
            );
            const destLuaDir = path.join(installPath, "media", "lua", "server");
            const destLuaFile = path.join(destLuaDir, "PanelBridge.lua");

            if (fs.existsSync(sourceLuaFile)) {
              if (!fs.existsSync(destLuaDir)) {
                fs.mkdirSync(destLuaDir, { recursive: true });
              }
              fs.copyFileSync(sourceLuaFile, destLuaFile);
              io.emit("install:log", {
                type: "stdout",
                text: "PanelBridge mod installed automatically",
              });
              log.info("PanelBridge mod auto-installed to server");
            }
          }
        } catch (modError) {
          log.warn(
            `Failed to auto-install PanelBridge mod: ${modError.message}`,
          );
        }

        io.emit("install:complete", {
          success: true,
          message: "Server installed successfully",
          installPath,
          serverName,
          zomboidDataPath: zomboidPath, // Send back the computed data path
          serverConfigPath,
          branch: selectedBranch,
          rconPort: safeRconPort,
          hasRconPassword: !!rconPassword,
          serverPort: safeServerPort,
          minMemory: safeMinMemory,
          maxMemory: safeMaxMemory,
        });
      } else {
        log.error(`SteamCMD exited with code ${code}`);
        io.emit("install:complete", {
          success: false,
          message: `Installation failed with exit code ${code}`,
          output,
        });
      }

      // Clear active operation
      activeSteamOperations.delete(normalizedPath);
    });

    steamcmd.on("error", (error) => {
      // Clear active operation on error
      activeSteamOperations.delete(normalizedPath);

      log.error(`SteamCMD error: ${error.message}`);
      io.emit("install:complete", {
        success: false,
        message: `Failed to run SteamCMD: ${sanitizeError(error.message)}`,
      });
    });

    // Return immediately - progress is sent via Socket.IO
    res.json({
      success: true,
      message: "Installation started. Check the log for progress.",
      installPath,
      branch: selectedBranch,
    });
  } catch (error) {
    log.error(`Installation error: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Quick Setup - Create new server config using existing files (no SteamCMD download)
router.post("/quick-setup", async (req, res) => {
  try {
    const {
      installPath,
      serverName,
      zomboidDataPath,
      minMemory = 4,
      maxMemory = 8,
      adminPassword,
      serverPort = 16261,
      useUpnp = true,
      useNoSteam = false,
      useDebug = false,
      rconPassword,
      rconPort = 27015,
    } = req.body;

    // Validate inputs
    if (!installPath || !serverName) {
      return res
        .status(400)
        .json({ error: "Missing required fields: installPath, serverName" });
    }

    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: "Invalid install path" });
    }

    if (!isValidServerName(serverName)) {
      return res.status(400).json({
        error:
          "Invalid server name. Use only letters, numbers, underscores, hyphens, and spaces (max 64 chars)",
      });
    }

    if (zomboidDataPath && !isValidPath(zomboidDataPath)) {
      return res.status(400).json({ error: "Invalid Zomboid data path" });
    }

    const { zomboidPath, serverConfigPath, usesEnvironmentDataPath } =
      resolveZomboidPaths(installPath, zomboidDataPath);

    // Check if server files exist
    const startServerBat = path.join(installPath, "StartServer64.bat");
    const startServerSh = path.join(installPath, "start-server.sh");
    const javaFolder = path.join(installPath, "jre64");

    if (
      !fs.existsSync(startServerBat) &&
      !fs.existsSync(startServerSh) &&
      !fs.existsSync(javaFolder)
    ) {
      return res.status(400).json({
        error:
          "Server files not found. Make sure the path contains Project Zomboid dedicated server files.",
      });
    }

    try {
      ensureWritableDirectory(installPath);
    } catch (directoryError) {
      return res.status(400).json({
        error: formatWritablePathError("Installation path", installPath),
      });
    }

    try {
      ensureWritableDirectory(serverConfigPath);
    } catch (directoryError) {
      return res.status(400).json({
        error: formatWritablePathError("Zomboid data folder", zomboidPath),
      });
    }

    // Validate numeric inputs
    const safeMinMemory = validateInt(minMemory, 1, 64, 4);
    const safeMaxMemory = validateInt(maxMemory, 1, 128, 8);
    const safeServerPort = validateInt(serverPort, 1024, 65535, 16261);
    const safeRconPort = validateInt(rconPort, 1024, 65535, 27015);
    const safeAdminPassword = sanitizeForBatch(adminPassword);

    log.info(
      `Quick setup: Creating server config for ${serverName} using files from ${installPath}`,
    );

    // Update settings
    await setSetting("serverPath", installPath);
    await setSetting("serverName", serverName);
    await setSetting("minMemory", safeMinMemory);
    await setSetting("maxMemory", safeMaxMemory);
    await setSetting("serverPort", safeServerPort);
    await setSetting("useUpnp", useUpnp);

    if (zomboidDataPath) {
      await setSetting("zomboidDataPath", zomboidDataPath);
    } else {
      await setSetting("zomboidDataPath", zomboidPath);
      log.info(
        `Using ${usesEnvironmentDataPath ? "configured" : "isolated"} data folder: ${zomboidPath}`,
      );
    }

    await setSetting("serverConfigPath", serverConfigPath);

    // Re-check immediately before creating configuration files in case the
    // selected mount changed during setup.
    try {
      ensureWritableDirectory(serverConfigPath);
    } catch (dirError) {
      log.error(
        `Data folder is not writable: ${zomboidPath} (${dirError.message})`,
      );
      throw new Error(
        `Server files found, but the data folder is not writable: ${zomboidPath} (${dirError.code || dirError.message}). ` +
          `Create it with the correct owner before starting the server, e.g. on Linux: ` +
          `sudo install -d -m 0755 -o "$(whoami)" -g "$(whoami)" "${zomboidPath}", then retry.`,
      );
    }

    // Save RCON settings
    if (rconPassword) {
      await setSetting("rconPassword", rconPassword);
      await setSetting("rconPort", safeRconPort);
      await setSetting("rconHost", "127.0.0.1");

      // Pre-create INI with RCON settings so PZ reads them on first boot
      try {
        const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
        if (!fs.existsSync(iniPath)) {
          if (!fs.existsSync(serverConfigPath)) {
            fs.mkdirSync(serverConfigPath, { recursive: true });
          }
          const safeRconPw = sanitizeIniValue(rconPassword);
          const minimalIni = `# Auto-generated by Zomboid Control Panel\n# PZ will add remaining default settings on first server start\nRCONPort=${safeRconPort}\nRCONPassword=${safeRconPw}\n`;
          writeFileAtomic(iniPath, minimalIni, {
            encoding: "utf-8",
            mode: 0o600,
          });
          log.info(`Pre-created INI with RCON settings at ${iniPath}`);
        }
      } catch (iniError) {
        log.warn(`Failed to pre-create INI: ${iniError.message}`);
      }
    }

    // Generate custom startup scripts
    const scripts = generateStartupScripts({
      installPath,
      serverName,
      minMemory: safeMinMemory,
      maxMemory: safeMaxMemory,
      zomboidDataPath: zomboidPath,
      adminPassword: safeAdminPassword,
      serverPort: safeServerPort,
      useNoSteam,
      useDebug,
    });

    const batchPath = path.join(installPath, `StartServer_${serverName}.bat`);
    writeFileAtomic(batchPath, scripts.bat, "utf8");
    log.info(`Created custom startup batch: ${batchPath}`);

    const shellPath = path.join(installPath, `start-server_${serverName}.sh`);
    writeFileAtomic(shellPath, scripts.sh.replace(/\r\n/g, "\n"), {
      encoding: "utf8",
      mode: 0o750,
    });
    log.info(`Created custom startup script: ${shellPath}`);

    const startupScript =
      process.platform === "win32"
        ? `StartServer_${serverName}.bat`
        : `start-server_${serverName}.sh`;

    // Auto-install PanelBridge mod to the server
    let panelBridgeInstalled = false;
    try {
      const possibleModPaths = [
        path.join(process.cwd(), "pz-mod", "PanelBridge"),
        path.join(path.dirname(process.execPath), "pz-mod", "PanelBridge"),
      ];

      let modSourcePath = null;
      for (const p of possibleModPaths) {
        if (fs.existsSync(p)) {
          modSourcePath = p;
          break;
        }
      }

      if (modSourcePath) {
        const sourceLuaFile = path.join(
          modSourcePath,
          "media",
          "lua",
          "server",
          "PanelBridge.lua",
        );
        const destLuaDir = path.join(installPath, "media", "lua", "server");
        const destLuaFile = path.join(destLuaDir, "PanelBridge.lua");

        if (fs.existsSync(sourceLuaFile)) {
          if (!fs.existsSync(destLuaDir)) {
            fs.mkdirSync(destLuaDir, { recursive: true });
          }
          fs.copyFileSync(sourceLuaFile, destLuaFile);
          panelBridgeInstalled = true;
          log.info("PanelBridge mod auto-installed to server");
        }
      }
    } catch (modError) {
      log.warn(`Failed to auto-install PanelBridge mod: ${modError.message}`);
    }

    await logServerEvent(
      "server_quick_setup",
      `Created server config for ${serverName} using existing files at ${installPath}`,
    );

    res.json({
      success: true,
      message: "Server configuration created successfully",
      installPath,
      serverName,
      zomboidDataPath: zomboidPath, // Send back the computed data path
      serverConfigPath,
      batchFile: startupScript,
      rconPort: safeRconPort,
      hasRconPassword: !!rconPassword,
      serverPort: safeServerPort,
      minMemory: safeMinMemory,
      maxMemory: safeMaxMemory,
      panelBridgeInstalled,
    });
  } catch (error) {
    log.error(`Quick setup error: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Configure RCON in server's .ini file
router.post("/configure-rcon", async (req, res) => {
  try {
    const { rconPassword, rconPort: rawRconPort = 27015 } = req.body;
    const rconPort = validateInt(rawRconPort, 1024, 65535, 27015);

    if (!rconPassword) {
      return res.status(400).json({ error: "RCON password is required" });
    }

    // Get the server config path from active server or settings
    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();

    if (!serverConfigPath) {
      return res.status(400).json({
        error: "Server config path not set. Please run installation first.",
      });
    }

    const iniPath = path.join(serverConfigPath, `${serverName}.ini`);

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: `Server config not found at ${iniPath}. Start the server once first to generate the config file.`,
      });
    }

    // Read and update the ini file. Locked per-path so this can't interleave
    // with ensureRconConfigured() or another config-save racing the same file.
    await withFileLock(iniPath, async () => {
      let content = fs.readFileSync(iniPath, "utf-8").replace(/\r\n/g, "\n");

      // Update RCONPassword (sanitize to prevent INI injection via newlines)
      const safePassword = sanitizeIniValue(rconPassword);
      if (content.includes("RCONPassword=")) {
        content = content.replace(
          /RCONPassword=.*/g,
          () => `RCONPassword=${safePassword}`,
        );
      } else {
        content += `\nRCONPassword=${safePassword}`;
      }

      // Update RCONPort
      if (content.includes("RCONPort=")) {
        content = content.replace(/RCONPort=.*/g, () => `RCONPort=${rconPort}`);
      } else {
        content += `\nRCONPort=${rconPort}`;
      }

      writeFileAtomic(iniPath, content, { encoding: "utf-8", mode: 0o600 });
    });

    // Also save to app settings
    await setSetting("rconPassword", rconPassword);
    await setSetting("rconPort", rconPort);
    await setSetting("rconHost", "127.0.0.1");

    log.info(`RCON configured in ${iniPath}`);
    res.json({
      success: true,
      message: `RCON configured successfully. Restart the server for changes to take effect.`,
      iniPath,
    });
  } catch (error) {
    log.error(`Failed to configure RCON: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Configure server network settings (port, UPnP) in .ini file
router.post("/configure-network", async (req, res) => {
  try {
    const { serverPort: rawServerPort = 16261, useUpnp = true } = req.body;
    const serverPort = validateInt(rawServerPort, 1024, 65535, 16261);

    // Get the server config path from active server or settings
    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();

    if (!serverConfigPath) {
      return res.status(400).json({
        error: "Server config path not set. Please run installation first.",
      });
    }

    const iniPath = path.join(serverConfigPath, `${serverName}.ini`);

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: `Server config not found at ${iniPath}. Start the server once first to generate the config file.`,
      });
    }

    // Read and update the ini file. Locked per-path for the same reason as
    // the RCON-config endpoint above.
    await withFileLock(iniPath, async () => {
      let content = fs.readFileSync(iniPath, "utf-8").replace(/\r\n/g, "\n");

      // Update DefaultPort
      if (content.includes("DefaultPort=")) {
        content = content.replace(
          /DefaultPort=.*/g,
          `DefaultPort=${serverPort}`,
        );
      } else {
        content += `\nDefaultPort=${serverPort}`;
      }

      // Update UDPPort (DefaultPort + 1)
      if (content.includes("UDPPort=")) {
        content = content.replace(/UDPPort=.*/g, `UDPPort=${serverPort + 1}`);
      } else {
        content += `\nUDPPort=${serverPort + 1}`;
      }

      // Update UPnP
      const upnpValue = useUpnp ? "true" : "false";
      if (content.includes("UPnP=")) {
        content = content.replace(/UPnP=.*/g, `UPnP=${upnpValue}`);
      } else {
        content += `\nUPnP=${upnpValue}`;
      }

      writeFileAtomic(iniPath, content, { encoding: "utf-8", mode: 0o600 });
    });

    // Also save to app settings
    await setSetting("serverPort", serverPort);
    await setSetting("useUpnp", useUpnp);

    log.info(
      `Network settings configured in ${iniPath}: port=${serverPort}, UPnP=${useUpnp ? "true" : "false"}`,
    );
    res.json({
      success: true,
      message: `Network settings configured successfully. Restart the server for changes to take effect.`,
      iniPath,
      settings: {
        defaultPort: serverPort,
        udpPort: serverPort + 1,
        upnp: useUpnp,
      },
    });
  } catch (error) {
    log.error(`Failed to configure network settings: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Alarm - sound building alarm
router.post("/alarm", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.alarm();
    await logServerEvent("alarm");
    res.json(result);
  } catch (error) {
    log.error(`Failed to trigger alarm: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Remove zombies
router.post("/removezombies", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.removeZombies();
    await logServerEvent("removezombies");
    res.json(result);
  } catch (error) {
    log.error(`Failed to remove zombies: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Reload Lua script
router.post("/reloadlua", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { filename } = req.body;

    if (!filename) {
      return res.status(400).json({ error: "Filename is required" });
    }

    // Validate filename - allow alphanumeric, underscores, dots, and forward slashes only
    // Block backslashes and '..' to prevent path traversal
    if (!/^[a-zA-Z0-9_/.\-]+\.lua$/.test(filename) || filename.includes("..")) {
      return res.status(400).json({ error: "Invalid filename format" });
    }

    const result = await rconService.reloadLua(filename);
    await logServerEvent("reloadlua", filename);
    res.json(result);
  } catch (error) {
    log.error(`Failed to reload Lua: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set log level
router.post("/log", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { type, level } = req.body;

    if (!type || !level) {
      return res.status(400).json({ error: "Type and level are required" });
    }

    const validTypes = [
      "General",
      "Network",
      "Multiplayer",
      "Voice",
      "Packet",
      "NetworkFileDebug",
      "Lua",
      "Mod",
      "Sound",
      "Zombie",
      "Combat",
      "Objects",
      "Fireplace",
      "Radio",
      "MapLoading",
      "Clothing",
      "Animation",
      "Asset",
      "Script",
      "Shader",
      "Input",
      "Recipe",
      "ActionSystem",
      "IsoRegion",
      "UniTests",
      "FileIO",
      "Ownership",
      "Death",
      "Damage",
      "Statistic",
      "Vehicle",
      "Checksum",
    ];

    const validLevels = ["Trace", "Debug", "General", "Warning", "Error"];

    if (!validTypes.includes(type)) {
      return res
        .status(400)
        .json({ error: `Invalid log type. Valid: ${validTypes.join(", ")}` });
    }

    if (!validLevels.includes(level)) {
      return res
        .status(400)
        .json({ error: `Invalid log level. Valid: ${validLevels.join(", ")}` });
    }

    const result = await rconService.setLogLevel(type, level);
    res.json(result);
  } catch (error) {
    log.error(`Failed to set log level: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Server statistics
router.post("/stats", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { mode, period } = req.body;

    if (!mode) {
      return res.status(400).json({ error: "Mode is required" });
    }

    const validModes = ["none", "file", "console", "all"];
    if (!validModes.includes(mode.toLowerCase())) {
      return res
        .status(400)
        .json({ error: `Invalid mode. Valid: ${validModes.join(", ")}` });
    }

    const validPeriod = period ? validateInt(period, 1, 3600, null) : null;

    const result = await rconService.setStats(mode, validPeriod);
    res.json(result);
  } catch (error) {
    log.error(`Failed to set stats: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Release safehouse
router.post("/releasesafehouse", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.releaseSafehouse();
    res.json(result);
  } catch (error) {
    log.error(`Failed to release safehouse: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Update server using SteamCMD
router.post("/steam-update", async (req, res) => {
  try {
    let {
      steamcmdPath,
      installPath,
      branch,
      useUnstable = false,
      validateFiles = false,
    } = req.body;

    // Determine branch - support both new 'branch' param and legacy 'useUnstable'
    const selectedBranch = branch || (useUnstable ? "unstable" : "stable");

    // Auto-load steamcmdPath from settings if not provided
    if (!steamcmdPath) {
      steamcmdPath = await getSetting("steamcmdPath");
    }

    if (!steamcmdPath || !installPath) {
      return res
        .status(400)
        .json({ error: "Missing required fields: steamcmdPath, installPath" });
    }

    if (!isValidPath(steamcmdPath)) {
      return res.status(400).json({ error: "Invalid SteamCMD path" });
    }

    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: "Invalid install path" });
    }

    // Check if server is running - cannot update while running
    const serverManager = req.app.get("serverManager");
    try {
      const isRunning = await serverManager.checkServerRunning();
      if (isRunning) {
        return res.status(400).json({
          error:
            "Server is currently running. Please stop the server before updating.",
        });
      }
    } catch (e) {
      log.warn(`Could not verify server status before update: ${e.message}`);
      // Continue anyway - user may be updating a different server
    }

    // Prevent concurrent operations on the same install path
    const normalizedPath = path.normalize(installPath).toLowerCase();
    if (hasActiveSteamOperation(normalizedPath)) {
      return res.status(409).json({
        error:
          "A Steam operation is already in progress for this server. Please wait for it to complete.",
      });
    }

    // Auto-download SteamCMD on Linux instead of hard-failing — see
    // ensureSteamCmdLinux.
    let steamcmdExe = getSteamCmdExe(steamcmdPath);
    if (!fs.existsSync(steamcmdExe)) {
      if (isWindows) {
        return res
          .status(400)
          .json({ error: `SteamCMD not found at: ${steamcmdExe}` });
      }
      try {
        steamcmdExe = await ensureSteamCmdLinux(
          steamcmdPath,
          req.app.get("io"),
        );
      } catch (dlErr) {
        return res.status(500).json({
          error: `SteamCMD not found and auto-download failed: ${sanitizeError(dlErr.message)}`,
        });
      }
    }

    try {
      const recovery = recoverMismatchedSteamBranchManifest(
        installPath,
        selectedBranch,
      );
      if (recovery) {
        log.warn(
          `Reset stale SteamCMD branch manifest (${recovery.mountedBranch} -> ${recovery.targetBranch}); backup: ${recovery.backupPath}`,
        );
      }
    } catch (error) {
      log.warn(`Could not inspect SteamCMD branch manifest: ${error.message}`);
    }

    const operation = validateFiles ? "verification" : "update";
    log.info(`Starting PZ server ${operation} (branch: ${selectedBranch})...`);

    // Mark operation as active
    activeSteamOperations.set(normalizedPath, {
      type: operation,
      startTime: Date.now(),
      branch: selectedBranch,
    });

    // Build SteamCMD command
    const betaArgs = getBetaArgs(selectedBranch);
    const loginArgs = await getSteamLoginArgs();
    const steamcmdArgs = [
      "+force_install_dir",
      installPath,
      ...loginArgs,
      "+app_update",
      "380870",
      ...betaArgs,
      "validate",
      "+quit",
    ];

    const io = req.app.get("io");

    // Emit start event
    io.emit("steam:start", {
      type: validateFiles ? "verify" : "update",
      message: validateFiles ? "Verifying game files..." : "Updating server...",
    });

    // On Linux, set LD_LIBRARY_PATH so SteamCMD can find its 32-bit libraries
    const updateSpawnOpts = { cwd: steamcmdPath };
    if (!isWindows) {
      const ldPaths = [
        path.join(steamcmdPath, "linux32"),
        path.join(steamcmdPath, "linux64"),
        steamcmdPath,
        process.env.LD_LIBRARY_PATH || "",
      ]
        .filter(Boolean)
        .join(":");
      updateSpawnOpts.env = { ...process.env, LD_LIBRARY_PATH: ldPaths };
    }
    const steamcmd = spawn(steamcmdExe, steamcmdArgs, updateSpawnOpts);
    activeSteamOperations.get(normalizedPath).pid = steamcmd.pid;

    let output = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";

    steamcmd.stdout.on("data", (data) => {
      const text = data.toString();
      output += text;
      stdoutBuffer += text;

      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          io.emit("steam:log", { type: "stdout", text: line });
          log.info(`SteamCMD: ${line}`);
        }
      }
    });

    steamcmd.stderr.on("data", (data) => {
      const text = data.toString();
      output += text;
      stderrBuffer += text;

      // Buffer stderr lines like stdout for consistent output
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          io.emit("steam:log", { type: "stderr", text: line });
          log.warn(`SteamCMD stderr: ${line}`);
        }
      }
    });

    steamcmd.on("close", (code) => {
      // Flush remaining buffers
      if (stdoutBuffer.trim()) {
        io.emit("steam:log", { type: "stdout", text: stdoutBuffer.trim() });
      }
      if (stderrBuffer.trim()) {
        io.emit("steam:log", { type: "stderr", text: stderrBuffer.trim() });
      }

      // Clear active operation
      activeSteamOperations.delete(normalizedPath);

      const success = code === 0;
      const steamDepotAccessDenied =
        /app ['"]?380870['"]? state is 0x6/i.test(output) ||
        /manifest.*access denied/i.test(output);
      const failureMessage = steamDepotAccessDenied
        ? "SteamCMD could not access a Project Zomboid depot manifest. Your installed server files were not changed. Retry later; if it persists, update using a Steam account that owns Project Zomboid."
        : `Server ${operation} failed with code ${code}`;

      io.emit("steam:complete", {
        success,
        message: success
          ? `Server ${operation} completed successfully`
          : failureMessage,
      });

      // After successful update, re-check update status so banner clears
      if (success) {
        try {
          const updateChecker = req.app.get("updateChecker");
          if (updateChecker) {
            setTimeout(() => updateChecker.checkForUpdates(true), 3000);
          }
        } catch (e) {
          // Non-critical
        }
      }

      logServerEvent(
        success ? "server_update" : "server_update_failed",
        `Server ${operation} ${success ? "completed" : "failed"}`,
      ).catch((e) => log.error("Failed to log server event:", e));

      log.info(`SteamCMD ${operation} finished with code ${code}`);
    });

    steamcmd.on("error", (error) => {
      // Clear active operation on error
      activeSteamOperations.delete(normalizedPath);

      io.emit("steam:complete", {
        success: false,
        message: `Failed to run SteamCMD: ${sanitizeError(error.message)}`,
      });
      log.error(`SteamCMD error: ${error.message}`);
    });

    res.json({
      success: true,
      message: `Server ${operation} started`,
    });
  } catch (error) {
    log.error(`Steam update failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Auto-download and install SteamCMD
router.post("/steamcmd/download", async (req, res) => {
  try {
    log.info(`POST /steamcmd/download (platform=${process.platform})`);
    const defaultPath = isWindows
      ? "C:\\SteamCMD"
      : [
          "/usr/games",
          "/usr/bin",
          path.join(os.homedir(), "steamcmd"),
          "/opt/steamcmd",
          "/usr/local/bin",
        ].find(
          (p) =>
            fs.existsSync(path.join(p, "steamcmd.sh")) ||
            fs.existsSync(path.join(p, "steamcmd")),
        ) || path.join(os.homedir(), "steamcmd");
    const { installPath = defaultPath } = req.body;

    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: "Invalid installation path" });
    }

    const io = req.app.get("io");

    // Create directory if it doesn't exist
    if (!fs.existsSync(installPath)) {
      fs.mkdirSync(installPath, { recursive: true });
    }

    if (isWindows) {
      // Windows: Download and extract zip
      const unzipper = await import("unzipper");
      const steamcmdUrl =
        "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip";
      const zipPath = path.join(installPath, "steamcmd.zip");

      io.emit("steamcmd:status", {
        status: "downloading",
        message: "Downloading SteamCMD...",
      });
      log.info(`Downloading SteamCMD to ${installPath}`);

      const file = fs.createWriteStream(zipPath);

      const handleDownloadError = (err) => {
        file.close();
        fs.unlink(zipPath, () => {});
        io.emit("steamcmd:status", {
          status: "error",
          message: `Download failed: ${err.message}`,
        });
        log.error(`SteamCMD download failed: ${err.message}`);
      };

      const downloadAndExtract = (url) => {
        https
          .get(url, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
              downloadAndExtract(response.headers.location);
              return;
            }
            if (response.statusCode !== 200) {
              handleDownloadError(new Error(`HTTP ${response.statusCode}`));
              return;
            }
            response.pipe(file);
            file.on("close", async () => {
              await extractAndSetup(zipPath);
            });
          })
          .on("error", handleDownloadError);
      };

      downloadAndExtract(steamcmdUrl);

      async function extractAndSetup(zipFile) {
        try {
          io.emit("steamcmd:status", {
            status: "extracting",
            message: "Extracting SteamCMD...",
          });
          log.info("Extracting SteamCMD...");

          await fs
            .createReadStream(zipFile)
            .pipe(unzipper.default.Extract({ path: installPath }))
            .promise();

          fs.unlinkSync(zipFile);
          runFirstTimeSetup();
        } catch (extractError) {
          io.emit("steamcmd:status", {
            status: "error",
            message: `Extraction failed: ${sanitizeError(extractError.message)}`,
          });
          log.error(`SteamCMD extraction failed: ${extractError.message}`);
        }
      }
    } else {
      // Linux: Download and extract tar.gz, then make executable
      const execCb = exec;
      const tarUrl =
        "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz";
      const tarPath = path.join(installPath, "steamcmd_linux.tar.gz");

      io.emit("steamcmd:status", {
        status: "downloading",
        message: "Downloading SteamCMD for Linux...",
      });
      log.info(`Downloading SteamCMD (Linux) to ${installPath}`);

      // Try curl first, fall back to wget (CentOS minimal may lack curl)
      const safeTarPath = tarPath.replace(/'/g, "'\\''");
      const safeTarUrl = tarUrl.replace(/'/g, "'\\''");
      const curlCmd = `curl -sSL -o '${safeTarPath}' '${safeTarUrl}'`;
      const wgetCmd = `wget -q -O '${safeTarPath}' '${safeTarUrl}'`;

      const tryDownload = (cmd, fallbackCmd) => {
        execCb(cmd, { timeout: 120000 }, (dlErr) => {
          if (dlErr && fallbackCmd) {
            log.warn(
              `Download with ${cmd.split(" ")[0]} failed, trying fallback...`,
            );
            tryDownload(fallbackCmd, null);
            return;
          }
          if (dlErr) {
            io.emit("steamcmd:status", {
              status: "error",
              message: `Download failed: ${dlErr.message}. Ensure curl or wget is installed.`,
            });
            log.error(`SteamCMD download failed: ${dlErr.message}`);
            return;
          }
          afterDownload();
        });
      };

      tryDownload(curlCmd, wgetCmd);

      function afterDownload() {
        io.emit("steamcmd:status", {
          status: "extracting",
          message: "Extracting SteamCMD...",
        });
        log.info("Extracting SteamCMD...");

        const safeInstallPath = installPath.replace(/'/g, "'\\''");
        execCb(
          `tar -xzf '${safeTarPath}' -C '${safeInstallPath}'`,
          { timeout: 30000 },
          (tarErr) => {
            // Clean up tar file regardless
            try {
              fs.unlinkSync(tarPath);
            } catch (e) {
              /* ignore */
            }

            if (tarErr) {
              io.emit("steamcmd:status", {
                status: "error",
                message: `Extraction failed: ${tarErr.message}`,
              });
              log.error(`SteamCMD extraction failed: ${tarErr.message}`);
              return;
            }

            // Make steamcmd.sh executable
            const steamcmdSh = path.join(installPath, "steamcmd.sh");
            try {
              fs.chmodSync(steamcmdSh, 0o755);
            } catch (e) {
              /* ignore */
            }
            // Also make the actual binary executable
            const steamcmdBin = path.join(installPath, "steamcmd");
            try {
              fs.chmodSync(steamcmdBin, 0o755);
            } catch (e) {
              /* ignore */
            }

            // Install 32-bit libraries if missing (SteamCMD requires them on 64-bit CentOS/RHEL)
            log.info(
              "Checking for required 32-bit libraries (SteamCMD dependency)...",
            );
            execCb(
              "ldconfig -p | grep -c libc.so.6",
              { timeout: 5000 },
              (ldErr) => {
                if (ldErr) {
                  log.warn(
                    "Could not verify 32-bit libraries. SteamCMD may fail if glibc.i686 / lib32gcc is not installed.",
                  );
                  io.emit("steamcmd:log", {
                    type: "stderr",
                    text: "Warning: Could not verify 32-bit libraries. If SteamCMD fails, install: yum install glibc.i686 libstdc++.i686 (CentOS/RHEL) or apt install lib32gcc-s1 (Debian/Ubuntu)",
                  });
                }
                runFirstTimeSetup();
              },
            );
          },
        );
      }
    }

    function runFirstTimeSetup() {
      io.emit("steamcmd:status", {
        status: "initializing",
        message: "Initializing SteamCMD (first run)...",
      });
      log.info("Running SteamCMD first-time setup...");

      const steamcmdExe = getSteamCmdExe(installPath);
      // On Linux, set LD_LIBRARY_PATH for SteamCMD's 32-bit libraries
      const firstRunOpts = { cwd: installPath };
      if (!isWindows) {
        const ldPaths = [
          path.join(installPath, "linux32"),
          path.join(installPath, "linux64"),
          installPath,
          process.env.LD_LIBRARY_PATH || "",
        ]
          .filter(Boolean)
          .join(":");
        firstRunOpts.env = { ...process.env, LD_LIBRARY_PATH: ldPaths };
      }
      const steamcmd = spawn(steamcmdExe, ["+quit"], firstRunOpts);

      steamcmd.stdout.on("data", (data) => {
        io.emit("steamcmd:log", { type: "stdout", text: data.toString() });
      });

      steamcmd.stderr.on("data", (data) => {
        io.emit("steamcmd:log", { type: "stderr", text: data.toString() });
      });

      steamcmd.on("close", (code) => {
        if (code === 0 || code === 7) {
          io.emit("steamcmd:status", {
            status: "complete",
            message: "SteamCMD installed successfully!",
            path: installPath,
          });
          log.info(`SteamCMD installed successfully to ${installPath}`);
        } else {
          io.emit("steamcmd:status", {
            status: "error",
            message: `SteamCMD setup failed with code ${code}`,
          });
          log.error(`SteamCMD first-run failed with code ${code}`);
        }
      });

      steamcmd.on("error", (error) => {
        io.emit("steamcmd:status", {
          status: "error",
          message: `Failed to run SteamCMD: ${sanitizeError(error.message)}`,
        });
        log.error(`SteamCMD run error: ${error.message}`);
      });
    }

    res.json({ success: true, message: "SteamCMD download started" });
  } catch (error) {
    log.error(`SteamCMD download failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Check if SteamCMD exists at a path
router.get("/steamcmd/check", async (req, res) => {
  try {
    const { path: checkPath } = req.query;

    if (!checkPath || !isValidPath(checkPath)) {
      return res.json({ exists: false, message: "Invalid path" });
    }

    const steamcmdExe = getSteamCmdExe(checkPath);
    const exists = fs.existsSync(steamcmdExe);

    res.json({
      exists,
      path: checkPath,
      executable: steamcmdExe,
      message: exists
        ? "SteamCMD found"
        : "SteamCMD not found at this location",
    });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Delete server files (used when removing a server from panel with file deletion)
router.post("/delete-files", requireRole("admin"), async (req, res) => {
  try {
    const { path: deletePath } = req.body;

    if (!deletePath || !isValidPath(deletePath)) {
      return res.status(400).json({ error: "Invalid path" });
    }

    // Safety check: path must exist and contain PZ server files
    if (!fs.existsSync(deletePath)) {
      return res.status(404).json({ error: "Path does not exist" });
    }

    // Check for known PZ server markers to prevent accidental deletion of wrong folders
    // Require one of the PZ-specific files (not just generic dirs like 'java')
    const pzSpecificMarkers = [
      "ProjectZomboid64.json",
      "ProjectZomboid32.json",
      "StartServer64.bat",
      "StartServer32.bat",
      "start-server.sh",
    ];
    const hasPzFiles = pzSpecificMarkers.some((marker) =>
      fs.existsSync(path.join(deletePath, marker)),
    );

    // Also reject paths containing '..' after normalization
    const normalizedDelete = path.normalize(deletePath);
    if (normalizedDelete.includes("..")) {
      return res.status(400).json({ error: "Invalid path" });
    }

    if (!hasPzFiles) {
      return res.status(400).json({
        error:
          "This does not appear to be a Project Zomboid server installation. Refusing to delete for safety.",
      });
    }

    log.warn(`Deleting server files at: ${deletePath}`);

    // Use recursive delete
    fs.rmSync(deletePath, { recursive: true, force: true });

    log.info(`Successfully deleted server files at: ${deletePath}`);
    res.json({ success: true, message: "Server files deleted" });
  } catch (error) {
    log.error(`Failed to delete server files: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// List directory contents for the in-app folder browser
router.post("/list-directory", async (req, res) => {
  try {
    const { dirPath } = req.body;

    // If no path provided, return available drives (Windows) or root (Linux)
    if (!dirPath) {
      if (isWindows) {
        // List available drive letters
        const drives = [];
        for (let i = 65; i <= 90; i++) {
          const letter = String.fromCharCode(i);
          const drivePath = `${letter}:\\`;
          try {
            fs.accessSync(drivePath, fs.constants.R_OK);
            let label = `Local Disk (${letter}:)`;
            try {
              const stats = fs.statfsSync(drivePath);
              const totalGB = (
                (stats.bsize * stats.blocks) /
                1024 ** 3
              ).toFixed(1);
              const freeGB = ((stats.bsize * stats.bfree) / 1024 ** 3).toFixed(
                1,
              );
              label = `${letter}: — ${freeGB} GB free of ${totalGB} GB`;
            } catch (e) {
              log.debug(`Drive stat failed for ${letter}: ${e.message}`);
            }
            drives.push({
              name: `${letter}:`,
              path: drivePath,
              label,
              isDrive: true,
            });
          } catch (e) {
            // Drive not accessible
          }
        }
        return res.json({
          entries: drives,
          currentPath: null,
          parentPath: null,
        });
      } else {
        // Linux: start at root
        return res.json({
          entries: [{ name: "/", path: "/", label: "/", isDrive: true }],
          currentPath: null,
          parentPath: null,
        });
      }
    }

    // Validate the requested path
    if (!isValidPath(dirPath)) {
      return res.status(400).json({ error: "Invalid path" });
    }

    const normalized = path.normalize(dirPath);

    if (!fs.existsSync(normalized)) {
      return res.status(404).json({ error: "Path does not exist" });
    }

    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: "Path is not a directory" });
    }

    // Read directory entries — only folders
    let items;
    try {
      items = fs.readdirSync(normalized, { withFileTypes: true });
    } catch (e) {
      const code = e && typeof e === "object" && "code" in e ? e.code : "UNKNOWN";
      const guidance = isWindows
        ? "Run the panel as an account that can read this folder."
        : "The panel service account needs read and execute permission on this folder and every parent folder.";
      return res.status(403).json({
        error: `Cannot read ${normalized} (${code}). ${guidance}`,
      });
    }

    const folders = [];
    for (const item of items) {
      if (!item.isDirectory()) continue;
      // Skip hidden/system folders
      if (
        item.name.startsWith(".") ||
        item.name === "$RECYCLE.BIN" ||
        item.name === "System Volume Information"
      )
        continue;
      folders.push({
        name: item.name,
        path: path.join(normalized, item.name),
      });
    }

    // Sort alphabetically, case-insensitive
    folders.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

    // Parent path
    const parentPath = path.dirname(normalized);
    const hasParent = parentPath !== normalized; // at root when dirname === self

    res.json({
      entries: folders,
      currentPath: normalized,
      parentPath: hasParent ? parentPath : null,
    });
  } catch (error) {
    log.error(`List directory failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Open folder browser dialog (uses PowerShell on Windows, zenity/kdialog on Linux)
router.post("/browse-folder", async (req, res) => {
  try {
    const { initialPath, description = "Select a folder" } = req.body;

    // Strict validation for description — alphanumeric, spaces, and basic punctuation only
    if (
      typeof description !== "string" ||
      description.length > 100 ||
      !/^[a-zA-Z0-9 _.\-:()]+$/.test(description)
    ) {
      return res.status(400).json({ error: "Invalid description parameter" });
    }

    if (!isWindows) {
      // Linux: try zenity, then kdialog, then return unsupported
      const execCb = exec;
      const safeDesc = description.replace(/'/g, "'\\''");
      const safePath =
        initialPath && isValidPath(initialPath)
          ? initialPath.replace(/'/g, "'\\''")
          : "";

      // Try zenity first (GNOME/GTK)
      const zenityCmd = `zenity --file-selection --directory --title='${safeDesc}'${safePath ? ` --filename='${safePath}/'` : ""}`;
      execCb(zenityCmd, { timeout: 120000 }, (zenErr, zenOut) => {
        if (!zenErr && zenOut && zenOut.trim()) {
          return res.json({
            success: true,
            path: zenOut.trim(),
            cancelled: false,
          });
        }
        // If zenity returned exit code 1 (user cancelled), return cancelled
        if (zenErr && zenErr.code === 1) {
          return res.json({ success: false, path: null, cancelled: true });
        }
        // Try kdialog (KDE)
        const kdialogCmd = `kdialog --getexistingdirectory '${safePath || "~"}' --title '${safeDesc}'`;
        execCb(kdialogCmd, { timeout: 120000 }, (kdErr, kdOut) => {
          if (!kdErr && kdOut && kdOut.trim()) {
            return res.json({
              success: true,
              path: kdOut.trim(),
              cancelled: false,
            });
          }
          if (kdErr && kdErr.code === 1) {
            return res.json({ success: false, path: null, cancelled: true });
          }
          // No GUI dialog available
          return res.status(501).json({
            error:
              "No folder browser available. Install zenity or kdialog, or enter the path manually.",
          });
        });
      });
      return;
    }

    const safePath =
      initialPath && isValidPath(initialPath)
        ? initialPath.replace(/'/g, "''")
        : "";
    const safeDesc = description.replace(/'/g, "''");

    // Simple FolderBrowserDialog — needs -STA for COM, no RootFolder restriction
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '${safeDesc}'
$dialog.UseDescriptionForTitle = $true
$dialog.ShowNewFolderButton = $true
${safePath ? `if (Test-Path '${safePath}') { $dialog.SelectedPath = '${safePath}' }` : ""}
$result = $dialog.ShowDialog()
if ($result -eq 'OK') { Write-Output $dialog.SelectedPath } else { Write-Output '' }
`;

    const powershell = spawn(
      "powershell",
      ["-NoProfile", "-STA", "-Command", psScript],
      {
        windowsHide: false,
      },
    );

    let output = "";
    let errorOutput = "";

    powershell.stdout.on("data", (data) => {
      output += data.toString();
    });

    powershell.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    powershell.on("close", (code) => {
      const selectedPath = output.trim();

      if (code !== 0 || errorOutput) {
        log.warn(`Folder browser had issues: ${errorOutput}`);
      }

      res.json({
        success: !!selectedPath,
        path: selectedPath || null,
        cancelled: !selectedPath,
      });
    });

    powershell.on("error", (error) => {
      log.error(`Folder browser error: ${error.message}`);
      res.status(500).json({ error: "Failed to open folder browser" });
    });
  } catch (error) {
    log.error(`Browse folder failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ============================================
// Server Console Log (server-console.txt)
// ============================================

// Filter patterns for console log - patterns to exclude (noise)
const CONSOLE_LOG_EXCLUDE_PATTERNS = [
  // Duplicate sprites/textures (very spammy)
  /IsoSpriteManager\.AddSprite > duplicate texture/,
  // PlayerHitZombie packet spam (not consistent packets)
  /The packet PlayerHitZombie is not consistent/,
  // Missing icons for build items (cosmetic only)
  /XuiSkin\$EntityUiStyle\.Load > Could not find icon:/,
  /XuiSkin\$EntityUiStyle\.LoadComponentInfo> Could not find icon:/,
  // Recursive require warnings (usually harmless)
  /LuaManager\.RunLua > recursive require\(\)/,
  // AnimalPacket/AnimalEventPacket class warnings (known issue)
  /The AnimalPacket class doesn't have PacketSetting attributes/,
  /The AnimalEventPacket class doesn't have PacketSetting attributes/,
];

// Patterns for errors (always show these)
const CONSOLE_LOG_ERROR_PATTERNS = [
  /^ERROR\[/,
  /Exception thrown/,
  /Stack trace:/,
  /java\.lang\.\w+Exception/,
  /KahluaThread\.flushErrorMessage/,
];

// Patterns for important info (always show these)
const CONSOLE_LOG_IMPORTANT_PATTERNS = [
  /^\[PanelBridge\]/,
  /SERVER STARTED/,
  /fully-connected/,
  /player-connect/,
  /connection-lost/,
  /disconnect/,
  /Steam client .* is initiating/,
  /RCON:/,
  /Recipe AutoLearned/,
  /Reduce Head Condition/,
  /ISBuildIsoEntity/,
];

/**
 * Filter console log lines based on filter level
 * @param {string[]} lines - Array of log lines
 * @param {string} filterLevel - 'all' | 'filtered' | 'important' | 'errors'
 * @returns {string[]} Filtered lines
 */
function filterConsoleLogLines(lines, filterLevel = "filtered") {
  if (filterLevel === "all") {
    return lines;
  }

  return lines.filter((line) => {
    if (!line.trim()) return false;

    // Always include error lines
    const isError = CONSOLE_LOG_ERROR_PATTERNS.some((pattern) =>
      pattern.test(line),
    );
    if (isError) return true;

    // Always include important lines
    const isImportant = CONSOLE_LOG_IMPORTANT_PATTERNS.some((pattern) =>
      pattern.test(line),
    );
    if (isImportant) return true;

    // For 'errors' level, only show errors
    if (filterLevel === "errors") {
      return isError;
    }

    // For 'important' level, show errors + important
    if (filterLevel === "important") {
      return isError || isImportant;
    }

    // For 'filtered' level (default), exclude noise patterns
    const isNoise = CONSOLE_LOG_EXCLUDE_PATTERNS.some((pattern) =>
      pattern.test(line),
    );
    return !isNoise;
  });
}

// Get server console log content
router.get("/console-log", async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    // server-console.txt is in zomboidDataPath (where Server/, Saves/, Logs/ are)
    const zomboidDataPath =
      activeServer?.zomboidDataPath ||
      activeServer?.installPath ||
      (await getSetting("zomboidDataPath")) ||
      (await getSetting("serverPath"));

    if (!zomboidDataPath) {
      return res.status(400).json({ error: "Server data path not configured" });
    }

    const consoleLogPath = path.join(zomboidDataPath, "server-console.txt");

    if (!fs.existsSync(consoleLogPath)) {
      return res.json({
        success: true,
        content: "",
        lines: [],
        exists: false,
        path: consoleLogPath,
      });
    }

    // Filter level: 'all' | 'filtered' | 'important' | 'errors'
    const filterLevel = req.query.filter || "filtered";

    // Read last N lines (default 500, max 2000)
    const maxLines = Math.min(parseInt(req.query.lines, 10) || 500, 2000);

    // Read only the tail of the file to prevent DoS with large log files
    const stats = fs.statSync(consoleLogPath);
    const MAX_READ_BYTES = 5 * 1024 * 1024; // 5MB cap
    let content;
    if (stats.size > MAX_READ_BYTES) {
      const fd = fs.openSync(consoleLogPath, "r");
      const readStart = stats.size - MAX_READ_BYTES;
      const buffer = Buffer.alloc(MAX_READ_BYTES);
      try {
        fs.readSync(fd, buffer, 0, MAX_READ_BYTES, readStart);
      } finally {
        try {
          fs.closeSync(fd);
        } catch (_) {
          /* ignore */
        }
      }
      // Skip first partial line after seeking
      const raw = buffer.toString("utf-8");
      const firstNewline = raw.indexOf("\n");
      content = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
    } else {
      content = fs.readFileSync(consoleLogPath, "utf-8");
    }
    const allLines = content.split("\n");

    // Apply filtering
    const filteredLines = filterConsoleLogLines(allLines, filterLevel);
    const lines = filteredLines.slice(-maxLines);

    res.json({
      success: true,
      content: lines.join("\n"),
      lines,
      totalLines: allLines.length,
      filteredCount: filteredLines.length,
      filterLevel,
      exists: true,
      path: consoleLogPath,
      lastModified: stats.mtime.toISOString(),
      size: stats.size,
    });
  } catch (error) {
    log.error(`Failed to read server console log: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// How many errors the game has thrown, so the dashboard can stop being calm
// while the server is screaming. Counted from the most recent "SERVER STARTED"
// marker when one is present in the sampled tail, otherwise across the sample.
let errorCountCache = { at: 0, value: null };
const ERROR_COUNT_TTL_MS = 20000;

router.get("/console-log/error-count", async (req, res) => {
  try {
    const now = Date.now();
    if (errorCountCache.value && now - errorCountCache.at < ERROR_COUNT_TTL_MS) {
      return res.json(errorCountCache.value);
    }

    const activeServer = await getActiveServer();
    const zomboidDataPath =
      activeServer?.zomboidDataPath ||
      activeServer?.installPath ||
      (await getSetting("zomboidDataPath")) ||
      (await getSetting("serverPath"));

    if (!zomboidDataPath) {
      return res.json({ exists: false, count: 0, sinceStart: false });
    }

    const consoleLogPath = path.join(zomboidDataPath, "server-console.txt");
    if (!fs.existsSync(consoleLogPath)) {
      return res.json({ exists: false, count: 0, sinceStart: false });
    }

    // Only ever read the tail. This endpoint is polled, so it must stay cheap
    // no matter how large the log has grown.
    const MAX_READ_BYTES = 2 * 1024 * 1024;
    const stats = fs.statSync(consoleLogPath);
    let content;
    let truncated = false;
    if (stats.size > MAX_READ_BYTES) {
      truncated = true;
      const fd = fs.openSync(consoleLogPath, "r");
      const buffer = Buffer.alloc(MAX_READ_BYTES);
      try {
        fs.readSync(fd, buffer, 0, MAX_READ_BYTES, stats.size - MAX_READ_BYTES);
      } finally {
        try {
          fs.closeSync(fd);
        } catch (_) {
          /* ignore */
        }
      }
      const raw = buffer.toString("utf-8");
      const firstNewline = raw.indexOf("\n");
      content = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
    } else {
      content = fs.readFileSync(consoleLogPath, "utf-8");
    }

    const lines = content.split("\n");
    let startIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/SERVER STARTED/.test(lines[i])) {
        startIndex = i;
        break;
      }
    }
    const scanned = startIndex >= 0 ? lines.slice(startIndex) : lines;
    const count = scanned.filter((line) =>
      CONSOLE_LOG_ERROR_PATTERNS.some((pattern) => pattern.test(line)),
    ).length;

    const payload = {
      exists: true,
      count,
      sinceStart: startIndex >= 0,
      truncated,
      lastModified: stats.mtime.toISOString(),
    };
    errorCountCache = { at: now, value: payload };
    res.json(payload);
  } catch (error) {
    log.error(`Failed to count console log errors: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Stream server console log (long-polling for new content)
router.get("/console-log/stream", async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    // server-console.txt is in zomboidDataPath (where Server/, Saves/, Logs/ are)
    const zomboidDataPath =
      activeServer?.zomboidDataPath ||
      activeServer?.installPath ||
      (await getSetting("zomboidDataPath")) ||
      (await getSetting("serverPath"));

    if (!zomboidDataPath) {
      return res.status(400).json({ error: "Server data path not configured" });
    }

    const consoleLogPath = path.join(zomboidDataPath, "server-console.txt");

    if (!fs.existsSync(consoleLogPath)) {
      return res.json({ success: true, newLines: [], exists: false });
    }

    // Filter level: 'all' | 'filtered' | 'important' | 'errors'
    const filterLevel = req.query.filter || "filtered";

    // Get the last known position from client
    const lastSize = Math.max(0, parseInt(req.query.lastSize, 10) || 0);
    const stats = fs.statSync(consoleLogPath);

    // If file is smaller than last known size, it was likely rotated/cleared
    if (stats.size < lastSize) {
      const content = fs.readFileSync(consoleLogPath, "utf-8");
      const allLines = content.split("\n").filter((l) => l.trim());
      const lines = filterConsoleLogLines(allLines, filterLevel);
      return res.json({
        success: true,
        newLines: lines,
        currentSize: stats.size,
        rotated: true,
        filterLevel,
        lastModified: stats.mtime.toISOString(),
      });
    }

    // If no new content, return empty
    if (stats.size === lastSize) {
      return res.json({
        success: true,
        newLines: [],
        currentSize: stats.size,
        filterLevel,
        lastModified: stats.mtime.toISOString(),
      });
    }

    // Read only new content from the last known position
    const fd = fs.openSync(consoleLogPath, "r");
    const newBytes = stats.size - lastSize;
    const buffer = Buffer.alloc(newBytes);
    try {
      fs.readSync(fd, buffer, 0, newBytes, lastSize);
    } finally {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* ignore */
      }
    }

    const newContent = buffer.toString("utf-8");
    const allNewLines = newContent.split("\n").filter((l) => l.trim());
    const newLines = filterConsoleLogLines(allNewLines, filterLevel);

    res.json({
      success: true,
      newLines,
      currentSize: stats.size,
      filterLevel,
      lastModified: stats.mtime.toISOString(),
    });
  } catch (error) {
    log.error(`Failed to stream server console log: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Clear server console log
router.post("/console-log/clear", async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    // server-console.txt is in zomboidDataPath (where Server/, Saves/, Logs/ are)
    const zomboidDataPath =
      activeServer?.zomboidDataPath ||
      activeServer?.installPath ||
      (await getSetting("zomboidDataPath")) ||
      (await getSetting("serverPath"));

    if (!zomboidDataPath) {
      return res.status(400).json({ error: "Server data path not configured" });
    }

    const consoleLogPath = path.join(zomboidDataPath, "server-console.txt");

    if (fs.existsSync(consoleLogPath)) {
      fs.writeFileSync(consoleLogPath, "");
      log.info("Server console log cleared");
    }

    res.json({ success: true });
  } catch (error) {
    log.error(`Failed to clear server console log: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ==================== UPDATE CHECKER ROUTES ====================

// Check for server updates
router.get("/update-check", async (req, res) => {
  try {
    const updateChecker = req.app.get("updateChecker");
    if (!updateChecker) {
      return res.status(503).json({ error: "Update checker not available" });
    }

    const forceCheck = req.query.force === "true";

    if (forceCheck) {
      const result = await updateChecker.checkForUpdates(true);
      res.json(result || { error: "Could not check for updates" });
    } else {
      res.json(updateChecker.getStatus());
    }
  } catch (error) {
    log.error(`Update check failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get update checker status
router.get("/update-check/status", async (req, res) => {
  try {
    const updateChecker = req.app.get("updateChecker");
    if (!updateChecker) {
      return res.status(503).json({ error: "Update checker not available" });
    }

    res.json(updateChecker.getStatus());
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set update check interval
router.post("/update-check/interval", async (req, res) => {
  try {
    const updateChecker = req.app.get("updateChecker");
    if (!updateChecker) {
      return res.status(503).json({ error: "Update checker not available" });
    }

    const { minutes } = req.body;
    if (!minutes || typeof minutes !== "number") {
      return res.status(400).json({ error: "minutes must be a number" });
    }

    await updateChecker.setInterval(minutes);
    res.json({ success: true, intervalMinutes: minutes });
  } catch (error) {
    log.error(`Failed to set update check interval: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ── Server Wipe ──────────────────────────────────────────────────────────────

// Guard against concurrent wipe operations
let wipeInProgress = false;

// Preview what will be wiped (dry-run)
router.post("/wipe/preview", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    await serverManager.loadConfig();

    const { targets } = req.body; // e.g. ["map", "players", "world"]
    if (!Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({
        error:
          "targets must be a non-empty array of: map, players, world, accounts",
      });
    }

    // "accounts" lives outside the save folder, so it is not part of the sweep
    const SAVE_TARGETS = ["map", "players", "world"];
    const allowedTargets = [...SAVE_TARGETS, "accounts"];
    const invalid = targets.filter((t) => !allowedTargets.includes(t));
    if (invalid.length > 0) {
      return res.status(400).json({
        error: `Invalid targets: ${invalid.join(", ")}. Allowed: ${allowedTargets.join(", ")}`,
      });
    }

    const savePath = serverManager.savePath;
    const serverName = serverManager.serverName || "servertest";
    if (!savePath) {
      return res.status(400).json({ error: "No zomboid data path configured" });
    }
    // Reject server names with path separators
    if (/[/\\]/.test(serverName)) {
      return res.status(400).json({ error: "Invalid server name" });
    }

    const saveDir = path.join(savePath, "Saves", "Multiplayer", serverName);
    if (!fs.existsSync(saveDir)) {
      return res
        .status(404)
        .json({ error: `Save directory not found: ${serverName}` });
    }

    const preview = {};
    let totalFiles = 0;
    let totalSize = 0;

    const countDir = (dir) => {
      let files = 0;
      let size = 0;
      if (!fs.existsSync(dir)) return { files: 0, size: 0 };
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const sub = countDir(fullPath);
            files += sub.files;
            size += sub.size;
          } else {
            files++;
            try {
              size += fs.statSync(fullPath).size;
            } catch (e) {
              log.debug(`Stat failed for ${fullPath}: ${e.message}`);
            }
          }
        }
      } catch (e) {
        log.debug(`countDir readdir failed for ${dir}: ${e.message}`);
      }
      return { files, size };
    };

    // Directories belonging to each target
    const MAP_DIRS = [
      "map",
      "chunkdata",
      "isoregiondata",
      "zpop",
      "apop",
      "metagrid",
      "map_visited_server",
    ];
    const WORLD_DIRS = ["radio"];
    // Player files in save root
    const PLAYER_ROOT_FILES =
      /^(players\.db|players\.db-journal|vehicles\.db|vehicles\.db-journal|map_p\.bin|map_zone\.bin)$/i;
    // World state files in save root (everything that isn't player data or directories)
    // This covers WorldDictionary.bin, map_meta.bin, map_t.bin, entity_data.bin,
    // global_mod_data.bin, reanimated.bin, iTrack.bin, gos_*.bin, map_*.bin (except map_zone/map_p),
    // z_outfits.bin, recorded_media.bin, erosion.ini, WorldDictionary*.lua, etc.
    const WORLD_ROOT_FILES =
      /^(WorldDictionary.*|map_meta\.bin|map_t\.bin|map_worldgen\.bin|map_animals\.bin|map_basements\.bin|entity_data\.bin|global_mod_data\.bin|reanimated\.bin|iTrack\.bin|gos_.*\.bin|id_manager_data\.bin|important_area_data\.bin|z_outfits\.bin|recorded_media\.bin|servermap_symbols\.bin|map_sand\.bin|hidden_authors\.ini|erosion\.ini)$/i;

    if (targets.includes("map")) {
      let mapFiles = 0;
      let mapSize = 0;
      for (const dirName of MAP_DIRS) {
        const dir = path.join(saveDir, dirName);
        if (fs.existsSync(dir)) {
          const sub = countDir(dir);
          mapFiles += sub.files;
          mapSize += sub.size;
        }
      }
      preview.map = { files: mapFiles, size: mapSize };
      totalFiles += mapFiles;
      totalSize += mapSize;
    }

    if (targets.includes("players")) {
      let playerFiles = 0;
      let playerSize = 0;
      try {
        const rootEntries = fs.readdirSync(saveDir, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (!entry.isDirectory() && PLAYER_ROOT_FILES.test(entry.name)) {
            playerFiles++;
            try {
              playerSize += fs.statSync(path.join(saveDir, entry.name)).size;
            } catch (e) {
              log.debug(
                `Stat failed for player file ${entry.name}: ${e.message}`,
              );
            }
          }
        }
      } catch (e) {
        log.debug(`Player file scan failed: ${e.message}`);
      }
      preview.players = { files: playerFiles, size: playerSize };
      totalFiles += playerFiles;
      totalSize += playerSize;
    }

    if (targets.includes("world")) {
      let worldFiles = 0;
      let worldSize = 0;
      // Count world directories
      for (const dirName of WORLD_DIRS) {
        const dir = path.join(saveDir, dirName);
        if (fs.existsSync(dir)) {
          const sub = countDir(dir);
          worldFiles += sub.files;
          worldSize += sub.size;
        }
      }
      // Count world root files
      try {
        const rootEntries = fs.readdirSync(saveDir, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (!entry.isDirectory() && WORLD_ROOT_FILES.test(entry.name)) {
            worldFiles++;
            try {
              worldSize += fs.statSync(path.join(saveDir, entry.name)).size;
            } catch (e) {
              log.debug(
                `Stat failed for world file ${entry.name}: ${e.message}`,
              );
            }
          }
        }
      } catch (e) {
        log.debug(`World file scan failed: ${e.message}`);
      }
      preview.world = { files: worldFiles, size: worldSize };
      totalFiles += worldFiles;
      totalSize += worldSize;
    }

    // Selecting every target means a total wipe, so account for anything the
    // per-target lists don't recognise (mod files, stale backups, new formats).
    if (SAVE_TARGETS.every((t) => targets.includes(t))) {
      const claimed = new Set([...MAP_DIRS, ...WORLD_DIRS]);
      let extraFiles = 0;
      let extraSize = 0;
      try {
        for (const entry of fs.readdirSync(saveDir, { withFileTypes: true })) {
          if (claimed.has(entry.name)) continue;
          if (
            !entry.isDirectory() &&
            (PLAYER_ROOT_FILES.test(entry.name) ||
              WORLD_ROOT_FILES.test(entry.name))
          ) {
            continue;
          }
          const fullPath = path.join(saveDir, entry.name);
          if (entry.isDirectory()) {
            const sub = countDir(fullPath);
            extraFiles += sub.files;
            extraSize += sub.size;
          } else {
            extraFiles++;
            try {
              extraSize += fs.statSync(fullPath).size;
            } catch (e) {
              log.debug(`Stat failed for ${entry.name}: ${e.message}`);
            }
          }
        }
      } catch (e) {
        log.debug(`Leftover scan failed: ${e.message}`);
      }
      preview.leftovers = { files: extraFiles, size: extraSize };
      totalFiles += extraFiles;
      totalSize += extraSize;
    }

    if (targets.includes("accounts")) {
      let accountFiles = 0;
      let accountSize = 0;
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        const dbFile = path.join(savePath, "db", `${serverName}.db${suffix}`);
        if (fs.existsSync(dbFile)) {
          accountFiles++;
          try {
            accountSize += fs.statSync(dbFile).size;
          } catch (e) {
            log.debug(`Stat failed for ${dbFile}: ${e.message}`);
          }
        }
      }
      preview.accounts = { files: accountFiles, size: accountSize };
      totalFiles += accountFiles;
      totalSize += accountSize;
    }

    res.json({
      success: true,
      serverName,
      saveDir,
      targets,
      preview,
      totalFiles,
      totalSize,
    });
  } catch (error) {
    log.error(`Wipe preview failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Execute server wipe
router.post("/wipe", requireRole("admin"), async (req, res) => {
  // Claim the guard before the first await: awaiting between the check and the
  // assignment lets a second concurrent request pass the check and run a
  // parallel destructive wipe of the same save directory.
  if (wipeInProgress) {
    return res.status(409).json({
      error: "A wipe operation is already in progress. Please wait.",
    });
  }
  wipeInProgress = true;

  try {
    const serverManager = req.app.get("serverManager");
    await serverManager.loadConfig();

    // Safety: server must be stopped
    const isRunning = await serverManager.checkServerRunning();
    if (isRunning) {
      return res.status(400).json({
        error: "Server must be stopped before wiping. Stop the server first.",
      });
    }

    const { targets, confirm } = req.body;
    if (confirm !== true) {
      return res.status(400).json({ error: "Wipe requires confirm: true" });
    }
    if (!Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({
        error:
          "targets must be a non-empty array of: map, players, world, accounts",
      });
    }

    // "accounts" lives outside the save folder, so it is not part of the sweep
    const SAVE_TARGETS = ["map", "players", "world"];
    const allowedTargets = [...SAVE_TARGETS, "accounts"];
    const invalid = targets.filter((t) => !allowedTargets.includes(t));
    if (invalid.length > 0) {
      return res
        .status(400)
        .json({ error: `Invalid targets: ${invalid.join(", ")}` });
    }

    const savePath = serverManager.savePath;
    const serverName = serverManager.serverName || "servertest";
    if (!savePath) {
      return res.status(400).json({ error: "No zomboid data path configured" });
    }
    if (/[/\\]/.test(serverName)) {
      return res.status(400).json({ error: "Invalid server name" });
    }

    const saveDir = path.join(savePath, "Saves", "Multiplayer", serverName);
    if (!fs.existsSync(saveDir)) {
      return res
        .status(404)
        .json({ error: `Save directory not found: ${serverName}` });
    }

    // Path traversal safety
    const normalizedSaveDir = path.normalize(saveDir);
    if (normalizedSaveDir.includes("..")) {
      return res.status(400).json({ error: "Invalid path" });
    }

    const results = {};

    // Same directory/file lists as preview
    const MAP_DIRS = [
      "map",
      "chunkdata",
      "isoregiondata",
      "zpop",
      "apop",
      "metagrid",
      "map_visited_server",
    ];
    const WORLD_DIRS = ["radio"];
    const PLAYER_ROOT_FILES =
      /^(players\.db|players\.db-journal|vehicles\.db|vehicles\.db-journal|map_p\.bin|map_zone\.bin)$/i;
    const WORLD_ROOT_FILES =
      /^(WorldDictionary.*|map_meta\.bin|map_t\.bin|map_worldgen\.bin|map_animals\.bin|map_basements\.bin|entity_data\.bin|global_mod_data\.bin|reanimated\.bin|iTrack\.bin|gos_.*\.bin|id_manager_data\.bin|important_area_data\.bin|z_outfits\.bin|recorded_media\.bin|servermap_symbols\.bin|map_sand\.bin|hidden_authors\.ini|erosion\.ini)$/i;

    try {
      if (targets.includes("map")) {
        let deletedCount = 0;
        for (const dirName of MAP_DIRS) {
          const dir = path.join(saveDir, dirName);
          if (fs.existsSync(dir)) {
            log.warn(`WIPE: Deleting ${dirName}/ at ${dir}`);
            fs.rmSync(dir, { recursive: true, force: true });
            deletedCount++;
          }
        }
        results.map =
          deletedCount > 0
            ? `deleted ${deletedCount} directories`
            : "not found";
      }

      if (targets.includes("players")) {
        let deletedCount = 0;
        try {
          const rootEntries = fs.readdirSync(saveDir, { withFileTypes: true });
          for (const entry of rootEntries) {
            if (!entry.isDirectory() && PLAYER_ROOT_FILES.test(entry.name)) {
              log.warn(`WIPE: Deleting player file ${entry.name}`);
              fs.unlinkSync(path.join(saveDir, entry.name));
              deletedCount++;
            }
          }
        } catch (e) {
          log.warn(`WIPE: Failed to clean player files: ${e.message}`);
        }
        results.players =
          deletedCount > 0 ? `deleted ${deletedCount} files` : "not found";
      }

      if (targets.includes("world")) {
        let deletedCount = 0;
        // Delete world directories
        for (const dirName of WORLD_DIRS) {
          const dir = path.join(saveDir, dirName);
          if (fs.existsSync(dir)) {
            log.warn(`WIPE: Deleting ${dirName}/ at ${dir}`);
            fs.rmSync(dir, { recursive: true, force: true });
            deletedCount++;
          }
        }
        // Delete world root files
        try {
          const rootEntries = fs.readdirSync(saveDir, { withFileTypes: true });
          for (const entry of rootEntries) {
            if (!entry.isDirectory() && WORLD_ROOT_FILES.test(entry.name)) {
              log.warn(`WIPE: Deleting world file ${entry.name}`);
              fs.unlinkSync(path.join(saveDir, entry.name));
              deletedCount++;
            }
          }
        } catch (e) {
          log.warn(`WIPE: Failed to clean world files: ${e.message}`);
        }
        results.world =
          deletedCount > 0 ? `deleted ${deletedCount} items` : "not found";
      }

      // Selecting every target means a total wipe: remove whatever the
      // per-target lists don't recognise so nothing from the old world survives.
      if (SAVE_TARGETS.every((t) => targets.includes(t))) {
        let leftovers = 0;
        for (const entry of fs.readdirSync(saveDir, { withFileTypes: true })) {
          log.warn(`WIPE: Deleting leftover ${entry.name}`);
          fs.rmSync(path.join(saveDir, entry.name), {
            recursive: true,
            force: true,
          });
          leftovers++;
        }
        results.leftovers =
          leftovers > 0 ? `deleted ${leftovers} remaining items` : "none";
      }

      if (targets.includes("accounts")) {
        let deletedCount = 0;
        for (const suffix of ["", "-journal", "-wal", "-shm"]) {
          const dbFile = path.join(savePath, "db", `${serverName}.db${suffix}`);
          if (fs.existsSync(dbFile)) {
            log.warn(`WIPE: Deleting account database ${dbFile}`);
            fs.rmSync(dbFile, { force: true });
            deletedCount++;
          }
        }
        results.accounts =
          deletedCount > 0 ? `deleted ${deletedCount} files` : "not found";
      }
    } finally {
      wipeInProgress = false;
    }

    log.warn(
      `WIPE COMPLETE: server=${serverName}, targets=${targets.join(",")}, results=${JSON.stringify(results)}`,
    );
    await logServerEvent("wipe", `Server wiped: ${targets.join(", ")}`, {
      targets,
      results,
    });

    res.json({
      success: true,
      serverName,
      targets,
      results,
      message: `Server "${serverName}" wiped: ${targets.join(", ")}`,
    });
  } catch (error) {
    log.error(`Wipe failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    wipeInProgress = false;
  }
});

export default router;
