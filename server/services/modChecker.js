import { createLogger } from "../utils/logger.js";
const log = createLogger("Mods");
import {
  getTrackedMods,
  updateModTimestamp,
  logServerEvent,
  getSetting,
  setSetting,
  addTrackedMod,
  getActiveServer,
  isModIgnored,
  markModsChecked,
} from "../database/init.js";
import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import { sanitizeError } from "../utils/sanitize.js";
import { ErrorCode } from "../utils/errorCodes.js";
import panelBridge from "./panelBridge.js";

export const MOD_CHECK_INTERVAL_MINUTES_MIN = 1;
export const MOD_CHECK_INTERVAL_MINUTES_MAX = 120;
const MOD_CHECK_INTERVAL_DEFAULT_MS = 5 * 60 * 1000;

export function minutesToCheckIntervalMs(minutes) {
  const value = Number(minutes);
  if (
    !Number.isInteger(value) ||
    value < MOD_CHECK_INTERVAL_MINUTES_MIN ||
    value > MOD_CHECK_INTERVAL_MINUTES_MAX
  ) {
    return null;
  }
  return value * 60 * 1000;
}

export function getWorkshopAcfCandidates(installPath) {
  if (typeof installPath !== "string" || !installPath.trim()) return [];

  const rawPath = installPath.trim();
  const baseRoot = path.normalize(rawPath);
  const roots = [];
  const extension = path.extname(rawPath).toLowerCase();
  let currentRoot = [".bat", ".cmd", ".exe", ".sh"].includes(extension)
    ? path.dirname(baseRoot)
    : baseRoot;
  for (let depth = 0; depth < 5; depth += 1) {
    roots.push(currentRoot);
    const parentRoot = path.dirname(currentRoot);
    if (parentRoot === currentRoot) break;
    currentRoot = parentRoot;
  }

  const candidates = [];
  const seen = new Set();
  const addCandidate = (candidate) => {
    const normalized = path.normalize(candidate);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      candidates.push(normalized);
    }
  };

  for (const root of roots) {
    addCandidate(
      path.join(root, "steamapps", "workshop", "appworkshop_108600.acf"),
    );
    addCandidate(path.join(root, "workshop", "appworkshop_108600.acf"));
    addCandidate(path.join(root, "appworkshop_108600.acf"));
    addCandidate(
      path.join(root, "..", "steamapps", "workshop", "appworkshop_108600.acf"),
    );
  }

  return candidates;
}

export async function refreshWorkshopChecker(modChecker) {
  if (!modChecker?.findWorkshopAcfPath) return null;

  const workshopAcfPath = await modChecker.findWorkshopAcfPath();
  if (workshopAcfPath) {
    if (!modChecker.isRunning) modChecker.start();
  } else if (modChecker.isRunning) {
    modChecker.stop();
  }
  return workshopAcfPath;
}

// Older API endpoints stored milliseconds while Settings stored minutes.
// Accept both on startup, then rewrite legacy milliseconds as minutes.
export function normalizeStoredCheckInterval(value) {
  const minutesInterval = minutesToCheckIntervalMs(value);
  if (minutesInterval !== null)
    return {
      intervalMs: minutesInterval,
      minutes: Number(value),
      legacy: false,
    };

  const intervalMs = Number(value);
  if (
    Number.isInteger(intervalMs) &&
    intervalMs >= MOD_CHECK_INTERVAL_MINUTES_MIN * 60 * 1000 &&
    intervalMs <= MOD_CHECK_INTERVAL_MINUTES_MAX * 60 * 1000 &&
    intervalMs % (60 * 1000) === 0
  ) {
    return { intervalMs, minutes: intervalMs / (60 * 1000), legacy: true };
  }
  return null;
}

// Legacy mod-restart settings were persisted with mixed types (real booleans
// alongside strings like "5"), so migration has to accept both shapes.
export function parseLegacyBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return null;
}

// Number(null) and Number("") are both 0, which would silently migrate an
// unset warning delay into "restart with no countdown".
export function parseLegacyMinutes(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return minutes;
}

function parseModInfoVersionFolder(folderName) {
  if (!/^\d+(?:\.\d+)*$/.test(folderName)) return null;
  return folderName.split(".").map((part) => Number.parseInt(part, 10));
}

function compareModInfoCandidates(leftCandidate, rightCandidate) {
  const leftVersion = leftCandidate.version;
  const rightVersion = rightCandidate.version;

  if (leftVersion && !rightVersion) return -1;
  if (!leftVersion && rightVersion) return 1;

  if (leftVersion && rightVersion) {
    const maxParts = Math.max(leftVersion.length, rightVersion.length);
    for (let partIndex = 0; partIndex < maxParts; partIndex++) {
      const leftPart = leftVersion[partIndex] || 0;
      const rightPart = rightVersion[partIndex] || 0;
      if (leftPart !== rightPart) return rightPart - leftPart;
    }
  }

  return leftCandidate.order - rightCandidate.order;
}

export class ModChecker extends EventEmitter {
  constructor() {
    super();
    this.checkInterval =
      normalizeStoredCheckInterval(process.env.MOD_CHECK_INTERVAL)
        ?.intervalMs || MOD_CHECK_INTERVAL_DEFAULT_MS;
    this.intervalId = null;
    this.initialCheckTimeout = null;
    this.lastCheck = null;
    // Whether the most recent checkForUpdates() actually got data back from
    // the Steam Web API, vs. silently degrading to the smaller, less
    // complete ACF-only comparison (see the `steamData.size === 0` branch
    // below). Without this, a Steam outage/rate-limit/network block looks
    // identical to "checked, 0 updates" everywhere getStatus() is read.
    this.steamApiHealthy = true;
    this.lastSteamApiFailureAt = null;
    this.modsNeedingUpdate = [];
    this.onUpdateCallback = null;
    this.autoRestartEnabled = false; // Track auto-restart state
    this.scheduler = null; // Will be set by init()
    this.serverManager = null; // Will be set by init()
    this.io = null; // Socket.io instance for emitting events
    this.workshopAcfPath = null; // Path to appworkshop_108600.acf

    // Track the last reported set of mods needing updates so we don't
    // re-emit the same news on every 5-minute poll. Without this, a stale
    // backlog of 3 mods quietly logs ~288 duplicate events per day and
    // floods socket clients with redundant `mods:updates_available` blasts.
    this._lastReportedUpdateKey = "";

    // Advanced options
    this.restartWarningMinutes = 5; // Minutes to warn before restart
    this.delayIfPlayersOnline = false; // Wait for players to leave before restart
    this.maxDelayMinutes = 30; // Maximum wait time if delaying for players
    this.lastUpdateDetected = null; // Timestamp of last update detection
    this.pendingRestart = false; // Whether a restart is pending (waiting for players)
    this.playerCheckInterval = null; // Interval for checking player count

    // Performance: Cache mod names to avoid repeated disk reads
    this.modNameCache = new Map(); // WorkshopID -> { name, timestamp }
    this.checkInProgress = false; // Prevent concurrent update checks
    this.lastSteamTimestamps = new Map(); // Cache Steam API results between checks
    // workshopId -> { resultCode, reason } for the most recent fetchSteamTimestamps()
    // call, for every id Steam answered with a NON-1 result (item.result !== 1).
    // Populated alongside lastSteamTimestamps so a caller can tell "Steam
    // confirmed this item is gone" (reason: "removed", Steam EResult 9 --
    // FileNotFound, the documented code for a deleted/private workshop item)
    // apart from "this batch got no answer at all" (absent from BOTH maps --
    // a network failure, timeout, or rate-limit; see steamApiHealthy).
    // Anything else non-1 is recorded with reason: "unknown" and its raw
    // code preserved rather than silently dropped, so the denominator of
    // codes this class recognizes stays honest as Steam's API evolves.
    this.lastUnavailableWorkshopIds = new Map();

    // Startup grace period — skip auto-restart triggers for the first N seconds after start()
    this.startupGraceMs = 120000; // 2 minutes grace period after start()
    this.startedAt = null; // Set when start() is called

    // Update dedup — track which mod+timestamp combos have already triggered a restart
    // Prevents the same stale update from re-triggering every poll cycle
    this.processedUpdates = new Map(); // workshopId -> steamTimestamp that was already handled
  }

  // Initialize with scheduler and restore saved settings
  async init(scheduler, serverManager = null, io = null) {
    this.scheduler = scheduler;
    this.serverManager = serverManager;
    this.io = io;

    // Find the workshop ACF file path
    await this.findWorkshopAcfPath();

    // Restore all saved settings from database
    try {
      let savedAutoRestart = await getSetting("modAutoRestartEnabled");
      let savedWarningMinutes = await getSetting("modRestartWarningMinutes");
      // Settings.tsx historically persisted these values under shorter names.
      // Accept and migrate them so existing installs do not silently lose
      // mod-update restart behavior after a panel restart.
      if (savedAutoRestart === null) {
        const legacyAutoRestart = parseLegacyBoolean(
          await getSetting("modAutoRestart"),
        );
        if (legacyAutoRestart !== null) {
          savedAutoRestart = legacyAutoRestart;
          await setSetting("modAutoRestartEnabled", legacyAutoRestart);
        }
      }
      if (savedWarningMinutes === null) {
        const legacyWarningMinutes = parseLegacyMinutes(
          await getSetting("modRestartDelay"),
        );
        if (legacyWarningMinutes !== null) {
          savedWarningMinutes = legacyWarningMinutes;
          await setSetting("modRestartWarningMinutes", legacyWarningMinutes);
        }
      }
      const savedDelayIfPlayers = await getSetting("modDelayIfPlayersOnline");
      const savedMaxDelay = await getSetting("modMaxDelayMinutes");
      const savedCheckInterval = await getSetting("modCheckInterval");

      if (savedWarningMinutes !== null)
        this.restartWarningMinutes = savedWarningMinutes;
      if (savedDelayIfPlayers !== null)
        this.delayIfPlayersOnline = savedDelayIfPlayers;
      if (savedMaxDelay !== null) this.maxDelayMinutes = savedMaxDelay;
      if (savedCheckInterval !== null) {
        const normalizedInterval =
          normalizeStoredCheckInterval(savedCheckInterval);
        if (normalizedInterval) {
          this.checkInterval = normalizedInterval.intervalMs;
          if (normalizedInterval.legacy) {
            await setSetting("modCheckInterval", normalizedInterval.minutes);
            log.info(
              `Migrated legacy mod check interval to ${normalizedInterval.minutes} minute(s)`,
            );
          }
        } else {
          log.warn(
            `Ignoring invalid saved mod check interval: ${savedCheckInterval}`,
          );
        }
      }

      log.info(
        `Mod checker settings restored: autoRestart=${savedAutoRestart}, warning=${this.restartWarningMinutes}min, delayIfPlayers=${this.delayIfPlayersOnline}, maxDelay=${this.maxDelayMinutes}min, checkInterval=${this.checkInterval}ms`,
      );

      if (savedAutoRestart === true) {
        this.autoRestartEnabled = true;
        if (this.scheduler) {
          this.onUpdateCallback = async (updatedMods) => {
            const handled = await this.handleModUpdate(updatedMods);
            if (!handled?.success) {
              log.warn(
                `Mod update handling failed: ${handled?.error || handled?.message || "unknown error"}`,
              );
            }
            // Without this, checkForUpdates()'s markProcessed dedup check
            // always sees undefined here (a block-bodied async function
            // resolves undefined unless it explicitly returns), so a
            // successful immediate restart was never recorded as processed
            // and the same update could retrigger another restart on the
            // next check cycle. routes/config.js's bulk-save path already
            // gets this right with an implicit-return arrow.
            return handled;
          };
          log.info("Auto-restart on mod update restored from settings");
        }
      }
    } catch (error) {
      log.warn(`Failed to restore mod checker settings: ${error.message}`);
    }

    // Auto-sync mods from workshop ACF file
    await this.autoSyncModsOnStartup();
  }

  // Find the workshop ACF file path from server config
  async findWorkshopAcfPath() {
    try {
      this.workshopAcfPath = null;

      // Allow manual override from settings
      const manualPath = await getSetting("modWorkshopAcfPath");
      if (manualPath && fs.existsSync(manualPath)) {
        this.workshopAcfPath = manualPath;
        log.info(`Using configured workshop ACF: ${manualPath}`);
        return manualPath;
      }

      const activeServer = await getActiveServer();
      let installPath = activeServer?.installPath;

      if (!installPath) {
        installPath = await getSetting("serverPath");
      }

      // The all-in-one Docker image has a fixed server path before the
      // first panel server record is created.
      if (!installPath) {
        installPath = process.env.PZ_SERVER_PATH;
      }

      if (!installPath) {
        log.debug("Server install path not configured");
        return null;
      }

      for (const acfPath of getWorkshopAcfCandidates(installPath)) {
        if (fs.existsSync(acfPath)) {
          this.workshopAcfPath = acfPath;
          log.info(`Found workshop ACF at ${acfPath}`);
          return acfPath;
        }
      }

      log.debug(`Workshop ACF not found for install path ${installPath}`);
      return null;
    } catch (error) {
      log.warn(`Failed to find workshop ACF: ${error.message}`);
      return null;
    }
  }

  // Parse Steam's VDF/ACF format (robust stack-based parser)
  parseAcfFile(content) {
    const result = {
      installedMods: {},
      modDetails: {},
    };

    if (!content) return result;

    try {
      // VDF Parser — handles both "Key" { (same line) and "Key"\n{ (separate lines)
      const lines = content.split(/\r?\n/);
      const stack = [];
      let current = {};
      const root = current;
      let pendingKey = null; // Key waiting for opening brace on next line

      for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith("//")) continue;

        // Lone opening brace — use pending key from previous line
        if (line === "{") {
          const key = pendingKey || "unknown";
          pendingKey = null;
          const newObj = {};
          current[key] = newObj;
          stack.push(current);
          current = newObj;
          continue;
        }

        // "Key" { on the same line
        if (line.endsWith("{")) {
          pendingKey = null;
          const keyMatch = line.match(/"([^"]+)"/);
          const key = keyMatch ? keyMatch[1] : "unknown";
          const newObj = {};
          current[key] = newObj;
          stack.push(current);
          current = newObj;
          continue;
        }

        // Closing brace
        if (line === "}") {
          pendingKey = null;
          if (stack.length > 0) {
            current = stack.pop();
          }
          continue;
        }

        // Key-Value pair: "Key" "Value"
        const kvMatch = line.match(/"([^"]+)"\s+"([^"]*)"/);
        if (kvMatch) {
          pendingKey = null;
          current[kvMatch[1]] = kvMatch[2];
          continue;
        }

        // Standalone quoted key — opening brace expected on next line
        const keyOnly = line.match(/^"([^"]+)"$/);
        if (keyOnly) {
          pendingKey = keyOnly[1];
        }
      }

      // Navigate structure to find relevant sections
      // The root usually contains "AppState" or "AppWorkshop"
      const appState = root.AppState || root.AppWorkshop || root;

      if (appState) {
        // Extract WorkshopItemsInstalled
        if (appState.WorkshopItemsInstalled) {
          for (const [id, data] of Object.entries(
            appState.WorkshopItemsInstalled,
          )) {
            // In some VDF formats, the ID is the key, in others it might be indexed
            if (typeof data === "object") {
              result.installedMods[id] = {
                size: parseInt(data.size || 0, 10),
                timeupdated: parseInt(data.timeupdated || 0, 10),
              };
            }
          }
        }

        // Extract WorkshopItemDetails
        if (appState.WorkshopItemDetails) {
          for (const [id, data] of Object.entries(
            appState.WorkshopItemDetails,
          )) {
            if (typeof data === "object") {
              result.modDetails[id] = {
                timeupdated: parseInt(data.timeupdated || 0, 10),
                latest_timeupdated: parseInt(data.latest_timeupdated || 0, 10),
              };
            }
          }
        }
      }
    } catch (error) {
      log.error(`Failed to parse ACF file: ${error.message}`);
    }

    return result;
  }

  // Helper: Try to resolve mod name from disk
  resolveModNameFromDisk(workshopId, skipCache = false) {
    // Check cache first (with size limit)
    if (!skipCache && this.modNameCache.has(workshopId)) {
      return this.modNameCache.get(workshopId).name;
    }

    // Evict oldest entries if cache exceeds limit
    if (this.modNameCache.size > 500) {
      const firstKey = this.modNameCache.keys().next().value;
      this.modNameCache.delete(firstKey);
    }

    try {
      if (!this.workshopAcfPath) return null;

      // ACF path: .../steamapps/workshop/appworkshop_108600.acf
      // Content path: .../steamapps/workshop/content/108600/<ID>
      const workshopDir = path.dirname(this.workshopAcfPath);
      const contentDir = path.join(
        workshopDir,
        "content",
        "108600",
        workshopId,
      );

      if (!fs.existsSync(contentDir)) return null;

      // Inside workshop folder, there is usually 'mods/ModName/mod.info'
      // OR sometimes just 'mods/ModName'. B42 mods may also put mod.info
      // under a versioned subdirectory: 'mods/ModName/common/mod.info',
      // 'mods/ModName/42/mod.info', 'mods/ModName/42.0/mod.info', etc.
      // We probe the mod root and every direct subdirectory.
      const modsDir = path.join(contentDir, "mods");
      if (fs.existsSync(modsDir)) {
        const modFolders = fs
          .readdirSync(modsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort((leftName, rightName) =>
            leftName.localeCompare(rightName, undefined, {
              numeric: true,
              sensitivity: "base",
            }),
          );
        // Just take the first valid mod found in the package
        for (const folder of modFolders) {
          const modFolderPath = path.join(modsDir, folder);
          const candidatePaths = [
            {
              path: path.join(modFolderPath, "mod.info"),
              version: null,
              order: 0,
            },
          ];
          try {
            const subfolders = fs
              .readdirSync(modFolderPath, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name)
              .sort((leftName, rightName) =>
                leftName.localeCompare(rightName, undefined, {
                  numeric: true,
                  sensitivity: "base",
                }),
              );
            for (const [subIndex, subfolder] of subfolders.entries()) {
              candidatePaths.push({
                path: path.join(modFolderPath, subfolder, "mod.info"),
                version: parseModInfoVersionFolder(subfolder),
                order: subIndex + 1,
              });
            }
          } catch {
            // Not a directory or unreadable — fall through
          }
          const modInfoPath = candidatePaths
            .filter((candidate) => fs.existsSync(candidate.path))
            .sort(compareModInfoCandidates)[0]?.path;
          if (modInfoPath) {
            let content = fs.readFileSync(modInfoPath, "utf-8");
            if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
            const nameMatch = content.match(/^\s*name\s*=\s*(.+)$/m);
            if (nameMatch && nameMatch[1]) {
              const name = nameMatch[1].trim();
              // Update cache
              this.modNameCache.set(workshopId, {
                name,
                timestamp: Date.now(),
              });
              return name;
            }
          }
        }
        // Fallback: If no mod.info found but folder exists, use folder name
        if (modFolders.length > 0) {
          const name = modFolders[0];
          this.modNameCache.set(workshopId, { name, timestamp: Date.now() });
          return name;
        }
      }

      return null;
    } catch (e) {
      if (e.code === "EACCES" || e.code === "EPERM") {
        log.warn(
          `Permission denied resolving mod name for ${workshopId}: ${e.message}`,
        );
      } else {
        log.debug(
          `Could not resolve mod name from disk for ${workshopId}: ${e.code || e.message}`,
        );
      }
      return null;
    }
  }

  // Auto-sync mods from workshop ACF file on startup
  async autoSyncModsOnStartup() {
    try {
      if (!this.workshopAcfPath || !fs.existsSync(this.workshopAcfPath)) {
        log.debug("No workshop ACF file, skipping auto-sync");
        return;
      }

      const trackedMods = (await getTrackedMods()) || [];

      // Only auto-sync if no mods are tracked
      if (trackedMods.length > 0) {
        log.debug(
          `${trackedMods.length} mods already tracked, skipping auto-sync`,
        );
        return;
      }

      // Read and parse the ACF file
      let content = fs.readFileSync(this.workshopAcfPath, "utf-8");
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
      const parsed = this.parseAcfFile(content);

      const acfWorkshopIds = Object.keys(parsed.installedMods);

      if (acfWorkshopIds.length === 0) {
        log.debug("No mods found in workshop ACF");
        return;
      }

      // appworkshop_108600.acf is SteamCMD's own shared Workshop content
      // cache, not scoped per configured panel server -- a host that has
      // run more than one server through the same SteamCMD install can have
      // ACF entries left behind by a PREVIOUS server. This is the write-side
      // half of the same bug e4de1518 fixed on the read side (see
      // checkForUpdates()'s own relevantWorkshopIds comment): that fix
      // trusts getTrackedMods() as "already server-scoped, unlike the ACF",
      // which is true by schema but was false in practice here -- this
      // function used to bulk-import EVERY ACF entry into the active
      // server's own tracked_mods the moment that server had zero tracked
      // mods (true for any brand-new server), permanently mislabeling a
      // previous server's mods as this one's and defeating the read-side
      // filter at its source. Only auto-track an ACF entry the active
      // server's own ini WorkshopItems= actually lists -- the one signal
      // that's genuinely per-server before anything's been manually tracked
      // yet. With no ini signal at all (a brand-new server before its first
      // full config write), there's no way to tell which ACF entries are
      // even this server's own, so this skips syncing entirely rather than
      // guessing from a cache shared with every other server on the host.
      const iniWorkshopIds = await this.getConfiguredWorkshopIds();
      if (!iniWorkshopIds || iniWorkshopIds.size === 0) {
        log.debug(
          "No server INI workshop IDs configured yet -- skipping ACF auto-sync rather than trusting the shared cache",
        );
        return;
      }
      const workshopIds = acfWorkshopIds.filter((id) =>
        iniWorkshopIds.has(id),
      );

      if (workshopIds.length === 0) {
        log.debug(
          "No ACF entries match this server's own INI -- nothing to auto-sync",
        );
        return;
      }

      // Add all mods to tracking
      let synced = 0;
      for (const id of workshopIds) {
        // Skip mods the user previously ignored
        if (await isModIgnored(id)) {
          log.debug(`Skipping ignored mod ${id} during auto-sync`);
          continue;
        }
        // Try to get name from disk
        const nameFromDisk = this.resolveModNameFromDisk(id);
        const name = nameFromDisk || `Workshop Mod ${id}`;

        await addTrackedMod(id, name);
        synced++;
      }

      if (synced > 0) {
        log.info(`Auto-synced ${synced} mods from workshop ACF`);
      }
    } catch (error) {
      log.error(`Failed to auto-sync mods: ${error.message}`);
    }
  }

  // Diagnostic helper used by /api/debug — true when polling is active.
  // Without this getter the debug page always reported "Mod update checker stopped"
  // because no field named isRunning existed on this class.
  get isRunning() {
    return !!this.intervalId;
  }

  start({ resetGracePeriod = true } = {}) {
    // Check if we have the workshop ACF file
    if (!this.workshopAcfPath) {
      log.warn(
        "Workshop ACF file not configured - mod update checking disabled. Configure server install path first.",
      );
      return false;
    }

    if (!fs.existsSync(this.workshopAcfPath)) {
      log.warn(`Workshop ACF file not found at ${this.workshopAcfPath}`);
      return false;
    }

    // Clear existing timers to prevent double-start leaks and stale delayed checks.
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    if (this.initialCheckTimeout) {
      clearTimeout(this.initialCheckTimeout);
    }

    // performance.now(), not Date.now(): startedAt only ever feeds the
    // elapsed-time grace-period check below, never displayed or crossing a
    // process boundary. A wall-clock step BACKWARD between this line and a
    // later runScheduledCheck() (NTP correction, DST, manual clock change)
    // would make `Date.now() - this.startedAt` stay small/negative forever,
    // wedging inGracePeriod true permanently -- auto-restart-on-mod-update
    // would silently never fire again until real wall-clock time closed
    // whatever gap the jump introduced. performance.now() is monotonic and
    // cannot step backward. bug hunt 2026-09-07 (round 6, files-nobody-
    // opened sweep), same fix as services/panelBridge.js's
    // tryResyncOutboxCursor and routes/mods.js's acquireScanLock.
    if (resetGracePeriod || !this.startedAt) this.startedAt = performance.now();
    this.intervalId = setInterval(
      () => this.runScheduledCheck(),
      this.checkInterval,
    );
    log.info(
      `Mod checker started - checking every ${Math.round(this.checkInterval / 1000)}s (grace period: ${this.startupGraceMs / 1000}s)`,
    );

    // Run initial check after a short delay (30s) to let RCON connect first
    // The grace period still prevents auto-restart triggers during the first 2 minutes
    this.initialCheckTimeout = setTimeout(() => {
      this.initialCheckTimeout = null;
      this.runScheduledCheck();
    }, 30000);
    return true;
  }

  runScheduledCheck() {
    this.checkForUpdates().catch((error) => {
      log.error(`Scheduled mod update check failed: ${error.message}`);
    });
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      log.info("Mod checker stopped");
    }
    if (this.initialCheckTimeout) {
      clearTimeout(this.initialCheckTimeout);
      this.initialCheckTimeout = null;
    }
    if (this.playerCheckInterval) {
      clearInterval(this.playerCheckInterval);
      this.playerCheckInterval = null;
    }
  }

  async setUpdateCallback(callback) {
    this.onUpdateCallback = callback;
    this.autoRestartEnabled = !!callback;
    log.info(
      `Mod auto-restart ${this.autoRestartEnabled ? "enabled" : "disabled"}`,
    );
    // Persist to database
    await setSetting("modAutoRestartEnabled", this.autoRestartEnabled);
  }

  // Configure restart options
  async setRestartOptions(options) {
    if (options.warningMinutes !== undefined) {
      const val = Number(options.warningMinutes);
      if (!isNaN(val)) {
        this.restartWarningMinutes = Math.max(0, Math.min(30, val));
        await setSetting(
          "modRestartWarningMinutes",
          this.restartWarningMinutes,
        );
      }
    }
    if (options.delayIfPlayersOnline !== undefined) {
      this.delayIfPlayersOnline = !!options.delayIfPlayersOnline;
      await setSetting("modDelayIfPlayersOnline", this.delayIfPlayersOnline);
    }
    if (options.maxDelayMinutes !== undefined) {
      const val = Number(options.maxDelayMinutes);
      if (!isNaN(val)) {
        this.maxDelayMinutes = Math.max(5, Math.min(120, val));
        await setSetting("modMaxDelayMinutes", this.maxDelayMinutes);
      }
    }
    if (options.checkInterval !== undefined)
      await this.setCheckInterval(options.checkInterval);

    log.info(
      `Mod restart options updated: warning=${this.restartWarningMinutes}min, delayIfPlayers=${this.delayIfPlayersOnline}, maxDelay=${this.maxDelayMinutes}min`,
    );
  }

  // Handle mod update detection
  async handleModUpdate(updatedMods) {
    // Guard against re-entry — don't start duplicate restarts
    if (this.pendingRestart) {
      log.info("Restart already pending, ignoring handleModUpdate");
      return;
    }

    log.info(
      `handleModUpdate called with ${updatedMods.length} mod(s): ${updatedMods.map((m) => m.name).join(", ")}`,
    );

    // Set flag immediately to prevent concurrent calls from slipping through
    this.pendingRestart = true;

    this.lastUpdateDetected = new Date();

    // Emit socket event
    if (this.io) {
      this.io.emit("mods:update_detected", {
        mods: updatedMods,
        timestamp: this.lastUpdateDetected.toISOString(),
        autoRestart: this.autoRestartEnabled,
        warningMinutes: this.restartWarningMinutes,
      });
    }
    this.emit("update_detected", updatedMods);

    if (!this.scheduler) {
      log.warn("Scheduler not available, cannot trigger restart");
      this.pendingRestart = false;
      return { success: false, retry: true, reason: "scheduler_unavailable" };
    }

    // Check if we should delay for players
    if (this.delayIfPlayersOnline && this.serverManager) {
      try {
        const playerCount = await this.getOnlinePlayerCount();

        if (playerCount > 0) {
          log.info(
            `${playerCount} players online, delaying restart (max ${this.maxDelayMinutes} min)`,
          );
          await this.scheduler.rconService?.serverMessage(
            `🔧 Mod updates detected! Restart pending - waiting for players to leave (max ${this.maxDelayMinutes} min).`,
          );

          if (this.io) {
            this.io.emit("mods:restart_pending", {
              reason: "waiting_for_players",
              playerCount,
              maxDelayMinutes: this.maxDelayMinutes,
            });
          }

          // Start player count monitoring
          this.startPlayerMonitoring(updatedMods);
          return {
            success: true,
            pending: true,
            markProcessed: true,
            reason: "waiting_for_players",
          };
        }
      } catch (error) {
        log.warn(`Failed to check player count: ${error.message}`);
      }
    }

    // No delay, trigger restart immediately
    try {
      return await this.triggerModRestart(updatedMods);
    } catch (e) {
      log.error(`handleModUpdate: triggerModRestart threw: ${e.message}`);
      this.pendingRestart = false;
      return { success: false, retry: true, reason: "restart_error" };
    }
  }

  // Get online player count. Returns null when the count is unknown, which is
  // NOT the same as an empty server.
  async getOnlinePlayerCount() {
    if (!this.scheduler?.rconService) return null;

    try {
      const result = await this.scheduler.rconService.getPlayers();
      if (result.success && result.players) {
        return result.players.length;
      }
    } catch (error) {
      log.debug(`Failed to get player count: ${error.message}`);
    }
    return null;
  }

  // Monitor player count and restart when empty
  startPlayerMonitoring(updatedMods) {
    if (this.playerCheckInterval) {
      clearInterval(this.playerCheckInterval);
    }

    this.pendingRestart = true;
    // performance.now(), not Date.now(): this is purely an in-process
    // elapsed-time marker (never displayed, never crosses a process
    // boundary) feeding a MAX-WAIT SAFETY NET -- the whole point of
    // maxWaitMs is "restart forcibly no matter what, don't wait for
    // players forever." A wall-clock step backward between this line and
    // a later tick would keep `elapsed` small/negative forever, wedging
    // the safety net open exactly when a populated server (players never
    // hit 0) needs it most. performance.now() is monotonic and cannot
    // step backward. bug hunt 2026-09-07 (round 6, files-nobody-opened
    // sweep) -- same class as the startup grace-period gate above.
    const startTime = performance.now();
    const maxWaitMs = this.maxDelayMinutes * 60 * 1000;

    this.playerCheckInterval = setInterval(async () => {
      try {
        const elapsed = performance.now() - startTime;

        // Check if max delay exceeded
        if (elapsed >= maxWaitMs) {
          log.info("Max delay exceeded, forcing restart");
          clearInterval(this.playerCheckInterval);
          this.playerCheckInterval = null;
          try {
            const result = await this.triggerModRestart(updatedMods);
            // A refusal comes back as a result, and leaving pendingRestart set
            // would block every later mod-update restart.
            if (!result?.success) {
              log.error(
                `Player monitor: mod restart did not run: ${result?.error || result?.message || "unknown error"}`,
              );
              this.pendingRestart = false;
            }
          } catch (e) {
            log.error(`Player monitor: triggerModRestart threw: ${e.message}`);
            this.pendingRestart = false;
          }
          return;
        }

        // Check player count
        const playerCount = await this.getOnlinePlayerCount();

        if (playerCount === null) {
          const remainingMin = Math.round((maxWaitMs - elapsed) / 60000);
          log.warn(
            `Player count unavailable (RCON); keeping restart on hold, ${remainingMin} min remaining`,
          );
        } else if (playerCount === 0) {
          log.info("No players online, triggering restart");
          clearInterval(this.playerCheckInterval);
          this.playerCheckInterval = null;
          try {
            const result = await this.triggerModRestart(updatedMods);
            if (!result?.success) {
              log.error(
                `Player monitor: mod restart did not run: ${result?.error || result?.message || "unknown error"}`,
              );
              this.pendingRestart = false;
            }
          } catch (e) {
            log.error(`Player monitor: triggerModRestart threw: ${e.message}`);
            this.pendingRestart = false;
          }
        } else {
          const remainingMin = Math.round((maxWaitMs - elapsed) / 60000);
          log.debug(
            `${playerCount} players still online, ${remainingMin} min remaining`,
          );
        }
      } catch (error) {
        log.error(`Player monitoring error: ${error.message}`);
        clearInterval(this.playerCheckInterval);
        this.playerCheckInterval = null;
        this.pendingRestart = false;
      }
    }, 120000); // Check every 2 minutes
  }

  // Trigger the actual restart
  async triggerModRestart(updatedMods) {
    log.info(`Triggering restart for ${updatedMods.length} updated mod(s)`);

    // RCON readiness gate — verify RCON is connected before attempting restart
    const rconService = this.scheduler?.rconService;
    if (!rconService || !rconService.connected) {
      // Default to "running" (the safe assumption: don't silently drop a
      // pending restart) unless detection positively confirms the server is
      // stopped. checkServerRunning() used to collapse a failed detection
      // scan into `false` -- indistinguishable from a confirmed-stopped
      // server -- which meant a scan failure while the server was actually
      // running would mark this mod update "processed" and never retry it.
      let confirmedOffline = false;
      if (
        this.serverManager &&
        typeof this.serverManager.getServerProcessDetails === "function"
      ) {
        try {
          const details = await this.serverManager.getServerProcessDetails();
          confirmedOffline = !details.running && !details.scanFailed;
        } catch (error) {
          log.debug(
            `Could not verify server process before mod restart retry decision: ${error.message}`,
          );
        }
      }

      if (confirmedOffline) {
        log.info(
          "Mod updates detected while the PZ server is offline — no restart needed until the server is running.",
        );
        this.pendingRestart = false;
        return {
          success: true,
          skipped: true,
          markProcessed: true,
          reason: "server_offline",
        };
      }

      log.warn(
        "RCON not connected while server appears to be running — cannot trigger mod restart safely. Will retry on next check cycle.",
      );
      // Clear processed updates so they'll be re-detected on next cycle when RCON may be ready
      for (const m of updatedMods) {
        this.processedUpdates.delete(m.workshopId);
      }
      this.pendingRestart = false;
      return { success: false, retry: true, reason: "rcon_disconnected" };
    }

    const modNames = updatedMods
      .map((m) => String(m.name || "Unknown").replace(/[\r\n]/g, ""))
      .join(", ");

    if (this.io) {
      this.io.emit("mods:restart_starting", {
        mods: updatedMods,
        warningMinutes: this.restartWarningMinutes,
      });
    }

    try {
      // Send warning message — use both PanelBridge (rich, UTF-8 safe) and RCON
      // (always-on global broadcast). PZ's RCON does not handle non-ASCII so the
      // RCON path strips emoji/unicode automatically inside serverMessage().
      const trimmedNames =
        modNames.length > 100 ? `${modNames.substring(0, 100)}...` : modNames;
      const warningMessage = `🔧 Mod updates detected: ${trimmedNames}. Server will restart in ${this.restartWarningMinutes} minute(s).`;
      log.info(
        `Sending mod-restart warning: ${trimmedNames} — restart in ${this.restartWarningMinutes} min`,
      );

      let rconBroadcastOk = false;
      try {
        const rconResult =
          await this.scheduler.rconService?.serverMessage(warningMessage);
        if (rconResult?.success && !rconResult.rejected) {
          rconBroadcastOk = true;
        } else if (rconResult?.rejected) {
          log.warn(
            "RCON servermsg was rejected by PZ — will rely on PanelBridge fallback",
          );
        }
      } catch (rconErr) {
        log.warn(`RCON serverMessage failed: ${rconErr?.message || rconErr}`);
      }

      // Always also try PanelBridge if available — it can render the full
      // unicode message in chat and acts as a fallback if RCON was rejected.
      try {
        if (panelBridge?.isRunning && panelBridge?.isModConnected?.()) {
          await panelBridge.sendCommand("sendToServerChat", {
            message: warningMessage,
            alert: true,
          });
        } else if (!rconBroadcastOk) {
          log.warn(
            "Mod restart warning: neither RCON broadcast nor PanelBridge succeeded — players may not see the warning",
          );
        }
      } catch (bridgeErr) {
        log.warn(
          `PanelBridge sendToServerChat failed: ${bridgeErr?.message || bridgeErr}`,
        );
      }

      // Perform restart with configured warning time
      log.info(
        `Calling scheduler.performRestart(${this.restartWarningMinutes})`,
      );
      const result = await this.scheduler.performRestart(
        this.restartWarningMinutes,
      );

      if (result && result.success === false) {
        log.warn(
          `Mod restart did not complete: ${result.message || "unknown reason"}`,
        );
        if (this.io) {
          this.io.emit("mods:restart_failed", {
            error: result.message || "Restart did not complete",
          });
        }
        // Clear processed updates so we can retry on next cycle
        for (const m of updatedMods) {
          this.processedUpdates.delete(m.workshopId);
        }
        return { success: false, retry: true, reason: "restart_incomplete" };
      }

      log.info(
        `Mod restart completed successfully for: ${modNames.substring(0, 200)}`,
      );
      await logServerEvent(
        "mod_update_restart",
        `Restarted for mod updates: ${modNames}`,
      );

      if (this.io) {
        this.io.emit("mods:restart_complete", { mods: updatedMods });
      }
      return { success: true, markProcessed: true, reason: "restart_complete" };
    } catch (error) {
      log.error(`Restart failed: ${error.message}`);
      if (this.io) {
        this.io.emit("mods:restart_failed", {
          error: sanitizeError(error.message),
        });
      }
      // Clear processed updates so we can retry on next cycle
      for (const m of updatedMods) {
        this.processedUpdates.delete(m.workshopId);
      }
      return { success: false, retry: true, reason: "restart_error" };
    } finally {
      // Always clear pendingRestart when triggerModRestart finishes
      this.pendingRestart = false;
    }
  }

  // Read the active server's INI WorkshopItems list as a Set of strings.
  // Returns null if the config can't be loaded so callers can choose to
  // fail open (don't filter) rather than fail closed (drop everything).
  async getConfiguredWorkshopIds() {
    if (
      !this.serverManager ||
      typeof this.serverManager.getServerConfig !== "function"
    ) {
      return null;
    }
    try {
      const config = await this.serverManager.getServerConfig();
      if (!config || !config.WorkshopItems) return null;
      const ids = String(config.WorkshopItems)
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      return new Set(ids);
    } catch (err) {
      log.debug(`getConfiguredWorkshopIds failed: ${err.message}`);
      return null;
    }
  }

  // Check for mod updates using local workshop ACF file
  // This compares timeupdated vs latest_timeupdated in Steam's cache
  // Query Steam Web API for latest workshop item timestamps
  // Uses ISteamRemoteStorage/GetPublishedFileDetails (no API key required)
  async fetchSteamTimestamps(workshopIds) {
    const result = new Map(); // workshopId -> { time_updated, title }
    // workshopId -> { resultCode, reason }, for every id Steam answered with
    // a non-1 result this call. See the field's own comment on the
    // constructor for what "reason" values mean and why this exists.
    const unavailable = new Map();
    if (!workshopIds.length) {
      this.lastUnavailableWorkshopIds = unavailable;
      return result;
    }

    // Steam API accepts batches — process in chunks of 100
    const BATCH = 100;
    // Backoff between batches if Steam rate-limits us. Reset on success.
    let backoffMs = 0;
    const MAX_BACKOFF_MS = 60_000;
    for (let i = 0; i < workshopIds.length; i += BATCH) {
      const batch = workshopIds.slice(i, i + BATCH);
      let timeout;
      if (backoffMs > 0) {
        log.warn(
          `Steam API backoff: sleeping ${backoffMs}ms before next batch`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
      try {
        const params = new URLSearchParams();
        params.set("itemcount", String(batch.length));
        batch.forEach((id, idx) => params.set(`publishedfileids[${idx}]`, id));

        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), 15000);

        const res = await fetch(
          "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
          { method: "POST", body: params, signal: controller.signal },
        );
        clearTimeout(timeout);
        timeout = null;

        if (!res.ok) {
          log.warn(
            `Steam API returned ${res.status} for batch ${i / BATCH + 1}`,
          );
          // Honor Retry-After on 429/503; otherwise exponential backoff up to MAX_BACKOFF_MS.
          if (res.status === 429 || res.status === 503) {
            const retryAfter = parseInt(
              res.headers.get("retry-after") || "",
              10,
            );
            if (Number.isFinite(retryAfter) && retryAfter > 0) {
              backoffMs = Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
            } else {
              backoffMs = Math.min(
                Math.max(backoffMs * 2, 2000),
                MAX_BACKOFF_MS,
              );
            }
          }
          continue;
        }

        // Successful response — reset backoff.
        backoffMs = 0;

        const data = await res.json();
        const items = data?.response?.publishedfiledetails || [];
        for (const item of items) {
          if (!item.publishedfileid) continue;
          if (item.result === 1) {
            result.set(item.publishedfileid, {
              time_updated: item.time_updated || 0,
              title: item.title || null,
              file_type: item.file_type ?? 0,
              creator_app_id: item.creator_app_id || 0,
              preview_url:
                typeof item.preview_url === "string" ? item.preview_url : null,
            });
          } else {
            // Steam answered FOR this specific item -- this is not a batch-
            // level failure (that path never reaches here at all; see !res.ok
            // and the catch block below, neither of which touch `unavailable`).
            // EResult 9 (k_EResultFileNotFound) is Steam's documented code
            // for a deleted or made-private workshop item -- the one case
            // this class currently distinguishes by name. Any other non-1
            // code is still recorded (not silently dropped), tagged
            // "unknown" with its raw code kept, rather than assumed to mean
            // the same thing as 9.
            unavailable.set(item.publishedfileid, {
              resultCode: item.result,
              reason: item.result === 9 ? "removed" : "unknown",
            });
          }
        }
      } catch (err) {
        if (timeout) clearTimeout(timeout);
        if (err.name === "AbortError") {
          log.warn(`Steam API timeout for batch ${i / BATCH + 1}`);
        } else {
          log.warn(
            `Steam API error for batch ${i / BATCH + 1}: ${err.message}`,
          );
        }
      }
    }

    if (result.size > 0 && result.size < workshopIds.length) {
      log.debug(
        `Steam API returned data for ${result.size}/${workshopIds.length} mods (partial)`,
      );
    }

    this.lastUnavailableWorkshopIds = unavailable;
    const removedIds = [...unavailable.entries()]
      .filter(([, info]) => info.reason === "removed")
      .map(([id]) => id);
    if (removedIds.length > 0) {
      log.warn(
        `Steam confirms ${removedIds.length} workshop item(s) no longer exist (removed or made private): ${removedIds.join(", ")}`,
      );
    }

    return result;
  }

  async checkForUpdates() {
    // Prevent concurrent checks (interval can fire while API call is in flight)
    if (this.checkInProgress) {
      log.debug("Update check already in progress, skipping");
      return { updated: false, mods: [], skipped: true };
    }
    this.checkInProgress = true;

    try {
      // Make sure we have the ACF path
      if (!this.workshopAcfPath) {
        await this.findWorkshopAcfPath();
      }

      if (!this.workshopAcfPath || !fs.existsSync(this.workshopAcfPath)) {
        // This is the normal, permanent state for a non-Steam/GOG install
        // (GitHub #148) -- there is no Workshop ACF file to find, ever, and
        // that's not a misconfiguration. It's also indistinguishable from a
        // legitimate SteamCMD install that has never had a Workshop mod
        // downloaded, so this deliberately does NOT try to guess which case
        // it is (see MODS_CHECK_UPDATES_ACF_NOT_FOUND's own comment) --
        // `code` lets the client show an accurate, non-alarming message
        // instead of a raw "not found" string in a red error toast.
        log.warn("Workshop ACF file not found - cannot check for updates");
        return {
          updated: false,
          mods: [],
          error: "Workshop ACF file not found",
          code: ErrorCode.MODS_CHECK_UPDATES_ACF_NOT_FOUND,
        };
      }

      // Read and parse the ACF file for local timestamps
      let content = fs.readFileSync(this.workshopAcfPath, "utf-8");
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
      const parsed = this.parseAcfFile(content);

      // Build local timestamp map from WorkshopItemsInstalled (most complete section)
      // Fall back to WorkshopItemDetails if a mod only exists there
      const localTimestamps = new Map(); // workshopId -> timeupdated (local)
      for (const [id, data] of Object.entries(parsed.installedMods)) {
        localTimestamps.set(id, data.timeupdated);
      }
      for (const [id, data] of Object.entries(parsed.modDetails)) {
        if (!localTimestamps.has(id)) {
          localTimestamps.set(id, data.timeupdated);
        }
      }

      const modCount = localTimestamps.size;
      if (modCount === 0) {
        log.debug("No workshop mods found in ACF file");
        return { updated: false, mods: [] };
      }

      log.debug(
        `Checking ${modCount} workshop mods for updates via Steam API...`,
      );

      const updatedMods = [];
      const trackedMods = (await getTrackedMods()) || [];
      const trackedMap = new Map();
      for (const mod of trackedMods) {
        trackedMap.set(mod.workshop_id, mod);
      }

      // Which mods actually belong to the CURRENTLY ACTIVE server. The
      // Workshop ACF being read (this.workshopAcfPath) is SteamCMD's own
      // content cache, not something scoped per configured panel server --
      // on a host that has ever run more than one server through the same
      // SteamCMD install, it can carry entries for servers that aren't this
      // one at all. A real user hit this: "My mods list insists I have 24
      // updates ready despite the fact I setup a NEW server and these are
      // all freshly installed" -- his new server's real, current mods were
      // being compared against whatever a PREVIOUS server had left in the
      // same shared ACF.
      //
      // Relevance is the UNION of the active server's .ini WorkshopItems=
      // list and its own tracked mods (getTrackedMods() is already
      // server-scoped, unlike the ACF) -- deliberately not "prefer the ini,
      // only fall back to tracked when the ini is unreadable": a mod that
      // was just tracked (added via the UI, downloaded) but whose ini
      // hasn't been regenerated yet is a normal, transient state, and
      // treating "not yet in the ini" as "not relevant" would silently
      // suppress a real update for it -- a failure mode no user would ever
      // think to report, unlike the noisy phantom-mod flood this whole fix
      // exists for. The accepted tradeoff, ruled on explicitly: a mod the
      // operator deliberately removed from the ini but never explicitly
      // untracked can still report an update it can't actually apply until
      // restart -- narrower and more visible (an operator SEES a stale
      // "restart pending" for a specific named mod they recognize) than the
      // wrong-server flood this fix closes, and the existing "remove from
      // tracking" action is the way out of it. With NEITHER the ini NOR any
      // tracked mods, there's no signal for what belongs to this server at
      // all, so this falls all the way back to no filtering rather than
      // confidently reporting zero updates for a modChecker that simply
      // hasn't been wired to a live server config yet.
      const iniWorkshopIds = await this.getConfiguredWorkshopIds();
      const trackedWorkshopIds = new Set(
        trackedMods.map((mod) => String(mod?.workshop_id ?? "")).filter(Boolean),
      );
      const relevantWorkshopIdsUnion = new Set([
        ...(iniWorkshopIds || []),
        ...trackedWorkshopIds,
      ]);
      const relevantWorkshopIds =
        relevantWorkshopIdsUnion.size > 0 ? relevantWorkshopIdsUnion : null;

      // Query Steam Web API for latest timestamps.
      // Include tracked mods that aren't in the ACF (e.g. INI lists the ID
      // but the file isn't downloaded yet, or the ACF entry is missing).
      // Without this, those mods stay "Never checked" forever because the
      // checked-set below is built from this same query list.
      const queryIds = new Set(localTimestamps.keys());
      for (const mod of trackedMods) {
        if (mod.workshop_id && /^\d{1,15}$/.test(mod.workshop_id)) {
          queryIds.add(mod.workshop_id);
        }
      }
      const workshopIds = [...queryIds];
      const steamData = await this.fetchSteamTimestamps(workshopIds);

      // Cache steam data for getStatus() / getWorkshopInfo()
      if (steamData.size > 0) {
        this.lastSteamTimestamps = steamData;

        // Persist preview_url on tracked mods (lazy import to avoid cycles).
        try {
          const { setModPreviewUrl } = await import("../database/init.js");
          for (const mod of trackedMods) {
            const steam = steamData.get(mod.workshop_id);
            if (
              steam &&
              steam.preview_url &&
              mod.preview_url !== steam.preview_url
            ) {
              await setModPreviewUrl(mod.workshop_id, steam.preview_url);
            }
          }
        } catch (err) {
          log.debug(`Failed to persist mod preview URLs: ${err.message}`);
        }
      }

      // Empty result with nothing queried isn't a failure -- there was
      // nothing to ask Steam about. Empty result with IDs queried AND no
      // confirmed-unavailable answers either means the API call itself
      // failed (see fetchSteamTimestamps): every batch network-errored,
      // timed out, or got rate-limited. A non-empty lastUnavailableWorkshopIds
      // means Steam DID answer -- just that every queried item happened to
      // come back non-1 (e.g. everything tracked got removed upstream at
      // once) -- which is a real answer, not an outage, and must not be
      // conflated with one.
      this.steamApiHealthy =
        steamData.size > 0 ||
        this.lastUnavailableWorkshopIds.size > 0 ||
        workshopIds.length === 0;
      this.lastSteamApiFailureAt = this.steamApiHealthy
        ? this.lastSteamApiFailureAt
        : new Date();

      if (steamData.size === 0) {
        // API failed entirely — fall back to ACF-only comparison
        log.warn("Steam API returned no data, falling back to ACF-only check");
        for (const [workshopId, details] of Object.entries(parsed.modDetails)) {
          const { timeupdated, latest_timeupdated } = details;
          if (latest_timeupdated > timeupdated) {
            if (
              relevantWorkshopIds &&
              !relevantWorkshopIds.has(String(workshopId))
            ) {
              continue;
            }
            // Skip mods the user explicitly removed from tracking
            if (
              !trackedMap.has(workshopId) &&
              (await isModIgnored(workshopId))
            ) {
              log.debug(
                `Skipping ignored mod ${workshopId} during ACF-only update check`,
              );
              continue;
            }
            const trackedMod = trackedMap.get(workshopId);
            const nameFromDisk = this.resolveModNameFromDisk(workshopId);
            const modName =
              nameFromDisk || trackedMod?.name || `Workshop Mod ${workshopId}`;
            log.info(`Mod update available (ACF): ${modName} (${workshopId})`);
            updatedMods.push({
              workshopId,
              name: modName,
              localTimestamp: new Date(timeupdated * 1000),
              latestTimestamp: new Date(latest_timeupdated * 1000),
            });
          }
        }
      } else {
        // Compare local timestamps against Steam API timestamps
        for (const [workshopId, localTime] of localTimestamps) {
          const steam = steamData.get(workshopId);
          if (!steam) continue; // Not found on Steam (deleted/hidden)

          if (steam.time_updated > localTime) {
            if (
              relevantWorkshopIds &&
              !relevantWorkshopIds.has(String(workshopId))
            ) {
              continue;
            }
            const trackedMod = trackedMap.get(workshopId);

            // Skip mods the user explicitly removed from tracking
            if (!trackedMod && (await isModIgnored(workshopId))) {
              log.debug(
                `Skipping ignored mod ${workshopId} during update check`,
              );
              continue;
            }

            const nameFromDisk = this.resolveModNameFromDisk(workshopId);
            const modName =
              nameFromDisk ||
              steam.title ||
              trackedMod?.name ||
              `Workshop Mod ${workshopId}`;

            // Update tracked mod name if we resolved a better one
            if (
              trackedMod &&
              nameFromDisk &&
              trackedMod.name !== nameFromDisk
            ) {
              trackedMod.name = nameFromDisk;
              await addTrackedMod(workshopId, nameFromDisk);
            }

            log.info(
              `Mod update available: ${modName} (${workshopId}) - local: ${localTime}, steam: ${steam.time_updated}`,
            );

            updatedMods.push({
              workshopId,
              name: modName,
              localTimestamp: new Date(localTime * 1000),
              latestTimestamp: new Date(steam.time_updated * 1000),
            });

            if (!trackedMod) {
              await addTrackedMod(workshopId, modName);
              trackedMap.set(workshopId, {
                workshop_id: workshopId,
                name: modName,
              });
            }

            if (this.modNameCache.has(workshopId)) {
              this.modNameCache.delete(workshopId);
            }
          }
        }
      }

      this.lastCheck = new Date();

      // The old "drop phantom updates not listed in the server's INI" pass
      // used to live here, as a post-hoc filter over `updatedMods` re-reading
      // the ini a second time. It's now redundant, not just moved: both
      // comparison loops above already skip anything relevantWorkshopIds
      // rules out (ini first, this server's own tracked mods as fallback)
      // BEFORE pushing into updatedMods or auto-tracking it via
      // addTrackedMod() -- catching the original "removed from INI, stuck in
      // a Restart Pending loop" case AND, further up the fallback chain, the
      // "mods belong to a different server on this host" case a real user
      // hit (see relevantWorkshopIds' own comment above).
      this.modsNeedingUpdate = updatedMods;

      // Batch-mark every mod we successfully queried as "just checked".
      // Without this, individual rows in the UI keep showing "Never checked"
      // even after the global timestamp updates, making the button feel broken.
      try {
        const updatesById = new Map(updatedMods.map((m) => [m.workshopId, 1]));
        let checkedIds;
        if (steamData.size > 0) {
          // Steam API succeeded — every queried id was definitively checked
          checkedIds = new Set(steamData.keys());
        } else {
          // ACF-only fallback — every locally-installed mod was compared.
          // Also mark tracked-but-not-in-ACF mods as checked so the row
          // doesn't stick on "Never checked" through ACF-only runs.
          checkedIds = new Set([
            ...localTimestamps.keys(),
            ...trackedMap.keys(),
          ]);
        }
        await markModsChecked(checkedIds, updatesById);
      } catch (markErr) {
        log.warn(`Failed to mark mods as checked: ${markErr.message}`);
      }

      if (updatedMods.length > 0) {
        // Build a stable key from the current set of needs-update mods so we
        // can dedupe across polls. Key = sorted (workshopId, latestTimestamp)
        // pairs — so a NEWER update to the same mod still re-fires.
        const updateKey = updatedMods
          .map((m) => `${m.workshopId}@${m.latestTimestamp?.getTime?.() || 0}`)
          .sort()
          .join(",");
        const isNewReport = updateKey !== this._lastReportedUpdateKey;
        this._lastReportedUpdateKey = updateKey;

        if (isNewReport) {
          log.info(`${updatedMods.length} mod(s) have updates available`);
          await logServerEvent(
            "mod_update_detected",
            JSON.stringify(updatedMods.map((m) => m.name)),
          );

          if (this.io) {
            this.io.emit("mods:updates_available", {
              count: updatedMods.length,
              mods: updatedMods,
            });
          }
        } else {
          log.debug(
            `${updatedMods.length} mod(s) still need updates (unchanged set, skipping re-notify)`,
          );
        }

        // Filter out mods whose exact steam timestamp was already processed (dedup)
        const newUpdates = updatedMods.filter((m) => {
          const steamTs = m.latestTimestamp?.getTime?.() || 0;
          const prevTs = this.processedUpdates.get(m.workshopId);
          if (prevTs && prevTs === steamTs) {
            log.debug(
              `Skipping already-processed update for ${m.name} (${m.workshopId}) — steam ts: ${steamTs}`,
            );
            return false;
          }
          return true;
        });

        if (newUpdates.length === 0 && updatedMods.length > 0) {
          log.info(
            `All ${updatedMods.length} update(s) already processed — skipping callback`,
          );
        }

        // Check startup grace period — don't trigger auto-restart too soon after startup
        const inGracePeriod =
          this.startedAt &&
          performance.now() - this.startedAt < this.startupGraceMs;
        if (inGracePeriod && newUpdates.length > 0) {
          const remaining = Math.round(
            (this.startupGraceMs - (performance.now() - this.startedAt)) / 1000,
          );
          log.info(
            `Startup grace period active (${remaining}s remaining) — skipping auto-restart for ${newUpdates.length} update(s)`,
          );
          newUpdates.length = 0; // Clear — don't trigger callback during grace
        }

        // Only trigger callback if NOT already pending a restart AND there are genuinely new updates
        if (
          this.onUpdateCallback &&
          !this.pendingRestart &&
          newUpdates.length > 0
        ) {
          try {
            log.info(
              `Triggering auto-restart callback for ${newUpdates.length} new update(s)`,
            );
            const callbackResult = await this.onUpdateCallback(newUpdates);
            // Mark updates only when work actually happened or no restart is needed.
            // Transient aborts, such as a running server with disconnected RCON, retry.
            if (this.pendingRestart || callbackResult?.markProcessed === true) {
              for (const m of newUpdates) {
                const steamTs = m.latestTimestamp?.getTime?.() || 0;
                if (steamTs) {
                  this.processedUpdates.set(m.workshopId, steamTs);
                }
              }
              if (callbackResult?.reason) {
                log.debug(
                  `Marked mod updates processed after ${callbackResult.reason}`,
                );
              }
            } else {
              log.info(
                "Restart did not proceed (likely aborted) — keeping updates eligible for retry on next cycle",
              );
            }
          } catch (callbackError) {
            log.error(`Mod update callback failed: ${callbackError.message}`);
          }
        } else if (this.pendingRestart) {
          log.debug("Restart already pending, skipping callback");
        }
      } else {
        // Set is empty — clear the dedupe key so the next non-empty set
        // re-fires the notification (e.g. user updated mods, then a new
        // update appears later).
        if (this._lastReportedUpdateKey !== "") {
          this._lastReportedUpdateKey = "";
          // A previously-nonzero count just dropped to zero. Nothing else
          // tells subscribed clients this -- the nav badge only refetches
          // on mods:updates_available/mods:update_detected, so without an
          // explicit emit here it stays stuck at its last nonzero count
          // for the rest of the session.
          if (this.io) {
            this.io.emit("mods:updates_available", { count: 0, mods: [] });
          }
        }
        log.debug("No mod updates available");
      }

      return {
        updated: updatedMods.length > 0,
        mods: updatedMods,
        source: this.steamApiHealthy ? "steam" : "acf-only",
      };
    } catch (error) {
      log.error(`Mod update check failed: ${error.message}`);
      return { updated: false, mods: [], error: error.message, source: "error" };
    } finally {
      this.checkInProgress = false;
    }
  }

  // Get workshop info from ACF file, enriched with cached Steam API data
  async getWorkshopInfo() {
    if (!this.workshopAcfPath || !fs.existsSync(this.workshopAcfPath)) {
      return {};
    }

    try {
      let content = fs.readFileSync(this.workshopAcfPath, "utf-8");
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
      const parsed = this.parseAcfFile(content);

      const result = {};
      for (const [workshopId, installed] of Object.entries(
        parsed.installedMods,
      )) {
        const details = parsed.modDetails[workshopId] || {};
        const steamInfo = this.lastSteamTimestamps.get(workshopId);
        // Prefer Steam API timestamp, fall back to ACF latest_timeupdated
        const latestTime =
          steamInfo?.time_updated ||
          details.latest_timeupdated ||
          installed.timeupdated;
        result[workshopId] = {
          size: installed.size,
          timeupdated: installed.timeupdated,
          latest_timeupdated: latestTime,
          needsUpdate: latestTime > installed.timeupdated,
        };
      }

      return result;
    } catch (error) {
      log.error(`Failed to read workshop ACF: ${error.message}`);
      return {};
    }
  }

  async addModToTrack(workshopId) {
    try {
      const { addTrackedMod } = await import("../database/init.js");

      // Try to resolve the real name from mod.info on disk
      const nameFromDisk = this.resolveModNameFromDisk(workshopId);
      const modName = nameFromDisk || `Workshop Mod ${workshopId}`;

      // Try to get mod info from local ACF file
      const allInfo = await this.getWorkshopInfo();
      const modInfo = allInfo[workshopId];

      if (modInfo) {
        await addTrackedMod(workshopId, modName);
        if (modInfo.timeupdated) {
          await updateModTimestamp(
            workshopId,
            new Date(modInfo.timeupdated * 1000).toISOString(),
          );
        }
        return {
          success: true,
          name: modName,
          needsUpdate: modInfo.needsUpdate,
        };
      } else {
        // Mod not in ACF (not subscribed on this server) - still add to tracking
        await addTrackedMod(workshopId, modName);
        return {
          success: true,
          name: modName,
          note: "Mod not found in Steam Workshop cache - may not be subscribed",
        };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getStatus() {
    const trackedMods = (await getTrackedMods()) || [];
    const trackedWorkshopIds = new Set(
      trackedMods
        .map((mod) => String(mod?.workshop_id ?? "").trim())
        .filter(Boolean),
    );
    const workshopInfo = await this.getWorkshopInfo();
    // Only count updates for mods that actually belong to the ACTIVE server.
    // Same UNION-of-ini-and-tracked relevance as checkForUpdates() (see its
    // own comment for the full reasoning, including the deliberate tradeoff
    // on a tracked-but-ini-absent mod): mods downloaded into the (possibly
    // host-shared) Workshop folder but neither configured nor tracked for
    // THIS server either trigger the "flags out of sync" banner for nothing,
    // or -- the shape a real user hit -- flood a brand-new server with
    // "updates ready" for mods belonging to a previous server on the host.
    let iniWorkshopIds = null;
    try {
      iniWorkshopIds = await this.getConfiguredWorkshopIds();
    } catch {
      /* fall through — leave null, union still has trackedWorkshopIds */
    }
    const relevantWorkshopIdsUnion = new Set([
      ...(iniWorkshopIds || []),
      ...trackedWorkshopIds,
    ]);
    const relevantWorkshopIds =
      relevantWorkshopIdsUnion.size > 0 ? relevantWorkshopIdsUnion : null;
    const modsWithUpdates = Object.entries(workshopInfo).filter(
      ([id, info]) => {
        if (!info.needsUpdate) return false;
        if (relevantWorkshopIds && !relevantWorkshopIds.has(String(id)))
          return false;
        return true;
      },
    ).length;

    return {
      running: !!this.intervalId,
      lastCheck:
        this.lastCheck instanceof Date
          ? this.lastCheck.toISOString()
          : this.lastCheck || null,
      lastUpdateDetected:
        this.lastUpdateDetected instanceof Date
          ? this.lastUpdateDetected.toISOString()
          : this.lastUpdateDetected || null,
      checkInterval: this.checkInterval,
      modsNeedingUpdate: this.modsNeedingUpdate,
      workshopAcfConfigured:
        !!this.workshopAcfPath && fs.existsSync(this.workshopAcfPath),
      workshopAcfPath: this.workshopAcfPath,
      totalModsInWorkshop: Object.keys(workshopInfo).length,
      totalModsTracked: Array.isArray(trackedMods) ? trackedMods.length : 0,
      updatesAvailable: modsWithUpdates,
      // False only after a check that actually queried Steam and got
      // nothing back (outage/rate-limit/network block) -- true before the
      // first check ever runs, so this isn't itself a false alarm on a
      // freshly-started panel.
      steamApiHealthy: this.steamApiHealthy,
      lastSteamApiFailureAt: this.lastSteamApiFailureAt
        ? this.lastSteamApiFailureAt.toISOString()
        : null,
      // Only surface IDs that are still tracked. The ACF can retain a dead
      // subscription after the operator removes it, so exposing the raw
      // Steam-result cache here would keep the warning alive forever.
      removedWorkshopIds: [...this.lastUnavailableWorkshopIds.entries()]
        .filter(
          ([id, info]) =>
            info.reason === "removed" && trackedWorkshopIds.has(String(id)),
        )
        .map(([id]) => id),
      // Workshop IDs Steam answered with a non-1, non-9 result -- neither
      // confirmed working nor confirmed removed. Deliberately not folded
      // into either of the other two categories: a surface that shows a
      // healthy indicator plus a removed-mods list implies those are the
      // only two outcomes, so an id stuck here would otherwise read as
      // fine by omission rather than as unclassified. Keeps the raw
      // resultCode rather than just the id -- "unknown" isn't answerable
      // from a support ticket, "result code 15" is.
      unknownWorkshopIds: [...this.lastUnavailableWorkshopIds.entries()]
        .filter(
          ([id, info]) =>
            info.reason === "unknown" && trackedWorkshopIds.has(String(id)),
        )
        .map(([id, info]) => ({ id, resultCode: info.resultCode })),
      autoRestartEnabled: this.autoRestartEnabled,
      // Restart options
      restartWarningMinutes: this.restartWarningMinutes,
      delayIfPlayersOnline: this.delayIfPlayersOnline,
      maxDelayMinutes: this.maxDelayMinutes,
      pendingRestart: this.pendingRestart,
    };
  }

  async setCheckInterval(intervalMs) {
    const normalizedInterval = normalizeStoredCheckInterval(intervalMs);
    if (!normalizedInterval || normalizedInterval.legacy === false) {
      throw new RangeError(
        `Check interval must be ${MOD_CHECK_INTERVAL_MINUTES_MIN}-${MOD_CHECK_INTERVAL_MINUTES_MAX} whole minutes in milliseconds`,
      );
    }

    this.checkInterval = normalizedInterval.intervalMs;
    await setSetting("modCheckInterval", normalizedInterval.minutes);
    if (this.intervalId) {
      this.start({ resetGracePeriod: false });
    }
    return this.checkInterval;
  }

  async setCheckIntervalMinutes(minutes) {
    const intervalMs = minutesToCheckIntervalMs(minutes);
    if (intervalMs === null) {
      throw new RangeError(
        `Check interval must be ${MOD_CHECK_INTERVAL_MINUTES_MIN}-${MOD_CHECK_INTERVAL_MINUTES_MAX} whole minutes`,
      );
    }
    return this.setCheckInterval(intervalMs);
  }

  // Cancel pending restart (if waiting for players)
  cancelPendingRestart() {
    if (this.playerCheckInterval) {
      clearInterval(this.playerCheckInterval);
      this.playerCheckInterval = null;
    }
    this.pendingRestart = false;
    // Clear the dedup map so the same mod updates can re-trigger a restart
    // on the next check cycle. Without this, cancelling marks every pending
    // mod as "already processed" forever, so auto-restart silently stays
    // dormant until Steam republishes a newer version of each mod.
    this.processedUpdates.clear();
    // Also cancel any in-progress scheduler countdown
    this.scheduler?.cancelRestart();
    log.info("Pending restart cancelled");

    if (this.io) {
      this.io.emit("mods:restart_cancelled", {});
    }
  }
}
