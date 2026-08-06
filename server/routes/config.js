import express from "express";
import { createLogger } from "../utils/logger.js";
const log = createLogger("API:Config");
import { getAllSettings, setSetting } from "../database/init.js";
import { sanitizeError } from "../utils/sanitize.js";
import net from "net";
import {
  MOD_CHECK_INTERVAL_MINUTES_MAX,
  MOD_CHECK_INTERVAL_MINUTES_MIN,
  minutesToCheckIntervalMs,
} from "../services/modChecker.js";

const router = express.Router();

// Validation helpers
const VALID_SETTINGS_KEYS = [
  "rconHost",
  "rconPort",
  "rconPassword",
  "serverPath",
  "serverConfigPath",
  "zomboidDataPath",
  "steamcmdPath",
  "steamUpdateAccount",
  "steamApiKey",
  "serverName",
  "minMemory",
  "maxMemory",
  "serverPort",
  "modCheckInterval",
  "modAutoRestart",
  "modRestartDelay",
  "serverAutoUpdate",
  "serverAutoUpdateWarningMinutes",
  "darkMode",
  "autoReconnect",
  "reconnectInterval",
  // Discord config is owned by /api/discord (discordBotToken,
  // discordAdminRoleId, ...). The old discordEnabled/discordToken/
  // discordAdminRole keys are deliberately NOT listed: nothing reads them, so
  // allowing them here would accept a write that silently never takes effect.
  "discordGuildId",
  "autoStartServer",
  "panelPort",
  "httpsEnabled",
  "httpsPort",
  "httpsKeyPath",
  "httpsCertPath",
  "corsAllowedOrigins",
  "corsAllowAll",
  "corsAllowPrivateNetworks",
  "corsDebug",
  "panelBridgeAutoUpdate",
  "autoExportOnLogin",
  "autoExportMaxPerPlayer",
  // Opt-in external public-IP lookup (api.ipify.org) shown on the dashboard/
  // panel-info — off by default (see serverManager.fetchPublicIp).
  "enablePublicIpLookup",
  // Workshop collection sync — mirrors tracked mods into a Steam collection.
  // steamSessionId / steamLoginSecure are cookie pairs; treated as secrets.
  "workshopCollectionId",
  "workshopCollectionAutoSync",
  "steamSessionId",
  "steamLoginSecure",
  // Chat page Quick Messages presets — array of strings.
  "chatPresets",
  // Dashboard LAN IP override — pick which detected interface to display
  // when the host has more than one (multiple VPN meshes, etc). Empty
  // string clears it back to auto-detect.
  "lanIpAddress",
  "panelBridgeSftpEnabled",
  "panelBridgeSftpHost",
  "panelBridgeSftpPort",
  "panelBridgeSftpUsername",
  "panelBridgeSftpPassword",
  "panelBridgeSftpBridgePath",
  "panelBridgeSftpPollIntervalSeconds",
  "panelBridgeSftpLogPath",
];

const OPTION_NAME_REGEX = /^[a-zA-Z0-9_]{1,64}$/;
const OPTION_VALUE_REGEX = /^[a-zA-Z0-9_.,:;\/ -]{0,256}$/;
const ORIGIN_DELIMITER_REGEX = /[\n,;]+/;
const MAX_CORS_ALLOWED_ORIGINS_LENGTH = 5000;
const MAX_CORS_ALLOWED_ORIGINS = 100;
const MAX_CORS_ORIGIN_LENGTH = 256;

function isValidOptionName(name) {
  return typeof name === "string" && OPTION_NAME_REGEX.test(name);
}

function isValidOptionValue(value) {
  const strVal = String(value);
  return OPTION_VALUE_REGEX.test(strVal);
}

function validateCorsAllowedOrigins(value) {
  if (typeof value !== "string") {
    return "CORS allowed origins must be a string list";
  }

  if (value.length > MAX_CORS_ALLOWED_ORIGINS_LENGTH) {
    return `CORS allowed origins list is too long (max ${MAX_CORS_ALLOWED_ORIGINS_LENGTH} characters)`;
  }

  const rawOrigins = value
    .split(ORIGIN_DELIMITER_REGEX)
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (rawOrigins.length > MAX_CORS_ALLOWED_ORIGINS) {
    return `Too many CORS origins (max ${MAX_CORS_ALLOWED_ORIGINS})`;
  }

  for (const origin of rawOrigins) {
    if (origin.length > MAX_CORS_ORIGIN_LENGTH) {
      return `Origin is too long (max ${MAX_CORS_ORIGIN_LENGTH} chars): ${origin.slice(0, 40)}...`;
    }
    try {
      const url = new URL(origin);
      if (!["http:", "https:"].includes(url.protocol)) {
        return `Only http/https origins are allowed: ${origin}`;
      }
    } catch {
      return `Invalid origin format: ${origin}`;
    }
  }

  return null;
}

// Get server configuration
router.get("/", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    const config = await serverManager.getServerConfig();
    res.json({ config });
  } catch (error) {
    log.error(`Failed to get config: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Update server configuration
router.put("/", async (req, res) => {
  try {
    log.info("PUT /config — saving server config");
    const serverManager = req.app.get("serverManager");
    const { config } = req.body;

    if (!config) {
      return res.status(400).json({ error: "Config is required" });
    }

    const saved = await serverManager.saveServerConfig(config);
    if (!saved?.success) {
      return res.status(500).json({
        error: sanitizeError(saved?.error || "Configuration could not be written"),
      });
    }
    res.json({ success: true, message: "Configuration saved" });
  } catch (error) {
    log.error(`Failed to save config: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Reload server options via RCON
router.post("/reload", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.reloadOptions();
    res.json(result);
  } catch (error) {
    log.error(`Failed to reload options: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get server options via RCON
router.get("/options", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.showOptions();
    res.json(result);
  } catch (error) {
    log.error(`Failed to get options: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Change a specific option via RCON
router.post("/option", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { name, value } = req.body;
    log.info(`POST /option: ${name}=${value}`);

    if (!name || value === undefined) {
      return res
        .status(400)
        .json({ error: "Option name and value are required" });
    }

    // Validate option name and value to prevent command injection
    if (!isValidOptionName(name)) {
      return res.status(400).json({ error: "Invalid option name format" });
    }

    if (!isValidOptionValue(value)) {
      return res.status(400).json({ error: "Invalid option value format" });
    }

    const result = await rconService.changeOption(name, value);
    res.json(result);
  } catch (error) {
    log.error(`Failed to change option: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Sensitive keys that should be masked in API responses
const SENSITIVE_KEYS = [
  "rconPassword",
  // Retained so any value left in an existing db.json stays masked, even
  // though this key is no longer writable.
  "discordToken",
  "steamApiKey",
  "steamSessionId",
  "steamLoginSecure",
  "panelBridgeSftpPassword",
];

// Detect a value that is just the bullet-mask we send to the client.
// If the user saves Settings without re-pasting a sensitive value, the
// masked string would otherwise overwrite the real secret in the DB.
// Accepts the canonical "•••...xxxx" sentinel from maskSensitiveSettings
// as well as values that are entirely bullets / asterisks (defence in
// depth in case the mask format changes).
export function isMaskedSecret(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("••••••••")) return true;
  if (/^[•*\u2022\u25CF\u25CB]+$/.test(value)) return true;
  return false;
}

function maskSensitiveSettings(settings) {
  const masked = { ...settings };
  for (const key of SENSITIVE_KEYS) {
    if (
      masked[key] &&
      typeof masked[key] === "string" &&
      masked[key].length > 0
    ) {
      masked[key] = "••••••••" + masked[key].slice(-4);
    }
  }
  return masked;
}

// Get application settings
router.get("/app-settings", async (req, res) => {
  try {
    const settings = await getAllSettings();
    res.json({ settings: maskSensitiveSettings(settings) });
  } catch (error) {
    log.error(`Failed to get app settings: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Update application settings
router.put("/app-settings", async (req, res) => {
  try {
    const { settings } = req.body;
    log.info(
      `PUT /app-settings — updating ${settings ? Object.keys(settings).length : 0} keys: [${settings ? Object.keys(settings).join(", ") : ""}]`,
    );

    if (!settings || typeof settings !== "object") {
      return res.status(400).json({ error: "Settings are required" });
    }

    // Only allow valid setting keys to prevent prototype pollution
    const validEntries = [];
    for (const [key, value] of Object.entries(settings)) {
      if (!VALID_SETTINGS_KEYS.includes(key)) {
        log.warn(`Invalid setting key rejected: ${key}`);
        continue;
      }

      if (key === "corsAllowedOrigins") {
        const corsValidationError = validateCorsAllowedOrigins(value);
        if (corsValidationError) {
          return res.status(400).json({ error: corsValidationError });
        }
      }

      if (
        key === "modCheckInterval" &&
        minutesToCheckIntervalMs(value) === null
      ) {
        return res.status(400).json({
          error: `modCheckInterval must be a whole number of minutes from ${MOD_CHECK_INTERVAL_MINUTES_MIN} to ${MOD_CHECK_INTERVAL_MINUTES_MAX}`,
        });
      }

      if (key === "lanIpAddress" && value !== "" && net.isIP(value) !== 4) {
        return res
          .status(400)
          .json({ error: "lanIpAddress must be an IPv4 address or empty" });
      }

      if (
        [
          "corsAllowAll",
          "corsAllowPrivateNetworks",
          "corsDebug",
          "panelBridgeAutoUpdate",
          "autoExportOnLogin",
          "enablePublicIpLookup",
        ].includes(key) &&
        typeof value !== "boolean"
      ) {
        return res.status(400).json({ error: `${key} must be true or false` });
      }

      if (key === "chatPresets") {
        // Array of short strings, max 50 entries, each <=500 chars.
        if (!Array.isArray(value)) {
          return res
            .status(400)
            .json({ error: "chatPresets must be an array" });
        }
        if (value.length > 50) {
          return res
            .status(400)
            .json({ error: "chatPresets supports up to 50 entries" });
        }
        if (!value.every((v) => typeof v === "string" && v.length <= 500)) {
          return res.status(400).json({
            error: "chatPresets entries must be strings up to 500 characters",
          });
        }
      }

      validEntries.push([key, value]);
    }

    // Never overwrite a stored secret with the masked sentinel we send to
    // the client. Without this guard, clicking Save after a page reload
    // (where the input pre-fills with •••...) would silently corrupt
    // RCON passwords, Discord tokens, and Steam cookies. See workshop
    // collection "cookies not configured" bug for the symptom.
    const filtered = validEntries.filter(([key, value]) => {
      if (SENSITIVE_KEYS.includes(key) && isMaskedSecret(value)) {
        log.info(
          `Preserving stored value for sensitive key "${key}" (masked input ignored)`,
        );
        return false;
      }
      return true;
    });

    for (const [key, value] of filtered) {
      if (key === "modCheckInterval") continue;
      await setSetting(key, value);
    }

    const modCheckIntervalEntry = filtered.find(
      ([key]) => key === "modCheckInterval",
    );
    if (modCheckIntervalEntry) {
      const [, minutes] = modCheckIntervalEntry;
      const modChecker = req.app.get("modChecker");
      if (modChecker?.setCheckIntervalMinutes) {
        await modChecker.setCheckIntervalMinutes(minutes);
      } else {
        await setSetting("modCheckInterval", Number(minutes));
      }
    }

    const modChecker = req.app.get("modChecker");
    const autoRestartEntry = filtered.find(
      ([key]) => key === "modAutoRestart",
    );
    if (autoRestartEntry && modChecker?.setUpdateCallback) {
      const [, enabled] = autoRestartEntry;
      await modChecker.setUpdateCallback(
        enabled
          ? async (updatedMods) => modChecker.handleModUpdate(updatedMods)
          : null,
      );
    }

    const restartDelayEntry = filtered.find(
      ([key]) => key === "modRestartDelay",
    );
    if (restartDelayEntry && modChecker?.setRestartOptions) {
      const [, warningMinutes] = restartDelayEntry;
      await modChecker.setRestartOptions({ warningMinutes });
    }

    // Reload serverManager and rconService configs after settings change
    const serverManager = req.app.get("serverManager");
    const rconService = req.app.get("rconService");
    const reloadWarnings = [];
    if (serverManager?.reloadConfig) {
      try {
        await serverManager.reloadConfig();
      } catch (reloadErr) {
        log.warn(
          `serverManager reload failed after settings save: ${reloadErr.message}`,
        );
        reloadWarnings.push(
          "Server manager failed to reload — restart may be required",
        );
      }
    }
    if (rconService?.loadConfig) {
      try {
        rconService.configLoaded = false;
        await rconService.loadConfig();
      } catch (reloadErr) {
        log.warn(
          `rconService reload failed after settings save: ${reloadErr.message}`,
        );
        reloadWarnings.push(
          "RCON service failed to reload — reconnect may be required",
        );
      }
    }
    const refreshCorsConfig = req.app.get("refreshCorsConfig");
    if (typeof refreshCorsConfig === "function") {
      try {
        await refreshCorsConfig();
      } catch (reloadErr) {
        log.warn(
          `CORS config reload failed after settings save: ${reloadErr.message}`,
        );
        reloadWarnings.push(
          "CORS settings could not be reloaded — panel restart may be required",
        );
      }
    }

    const response = { success: true, message: "Settings saved" };
    if (reloadWarnings.length) response.warnings = reloadWarnings;
    res.json(response);
  } catch (error) {
    log.error(`Failed to save app settings: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// CORS diagnostics for remote access troubleshooting
router.get("/cors-debug", async (req, res) => {
  try {
    const getCorsDebugSnapshot = req.app.get("getCorsDebugSnapshot");
    if (typeof getCorsDebugSnapshot !== "function") {
      return res
        .status(500)
        .json({ error: "CORS diagnostics are not available" });
    }
    res.json({ diagnostics: getCorsDebugSnapshot() });
  } catch (error) {
    log.error(`Failed to get CORS diagnostics: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/cors-debug/reload", async (req, res) => {
  try {
    const refreshCorsConfig = req.app.get("refreshCorsConfig");
    if (typeof refreshCorsConfig !== "function") {
      return res
        .status(500)
        .json({ error: "CORS config reload is not available" });
    }
    const diagnostics = await refreshCorsConfig();
    res.json({ success: true, diagnostics });
  } catch (error) {
    log.error(`Failed to reload CORS config: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete("/cors-debug/blocked", async (req, res) => {
  try {
    const clearCorsBlockedOrigins = req.app.get("clearCorsBlockedOrigins");
    const getCorsDebugSnapshot = req.app.get("getCorsDebugSnapshot");
    if (
      typeof clearCorsBlockedOrigins !== "function" ||
      typeof getCorsDebugSnapshot !== "function"
    ) {
      return res
        .status(500)
        .json({ error: "CORS diagnostics are not available" });
    }

    clearCorsBlockedOrigins();
    res.json({ success: true, diagnostics: getCorsDebugSnapshot() });
  } catch (error) {
    log.error(`Failed to clear blocked CORS origins: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get paths configuration
router.get("/paths", async (req, res) => {
  try {
    res.json({
      serverPath: process.env.PZ_SERVER_PATH || "",
      savePath: process.env.PZ_SAVE_PATH || "",
      serverBat:
        process.env.PZ_SERVER_BAT ||
        (process.platform === "win32"
          ? "StartServer64.bat"
          : "start-server.sh"),
    });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Update paths (runtime only - doesn't persist to .env)
router.put("/paths", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    const { serverPath, savePath } = req.body;

    // Validate paths
    if (serverPath !== undefined) {
      if (
        typeof serverPath !== "string" ||
        serverPath.length > 500 ||
        serverPath.includes("..")
      ) {
        return res.status(400).json({ error: "Invalid server path" });
      }
    }
    if (savePath !== undefined) {
      if (
        typeof savePath !== "string" ||
        savePath.length > 500 ||
        savePath.includes("..")
      ) {
        return res.status(400).json({ error: "Invalid save path" });
      }
    }

    serverManager.updatePaths(serverPath, savePath);

    res.json({ success: true, message: "Paths updated" });
  } catch (error) {
    log.error(`Failed to update paths: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get RCON configuration
router.get("/rcon", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const config = rconService.getConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Validation for RCON config
const RCON_HOST_REGEX = /^[a-zA-Z0-9.-]{1,255}$/;
const RCON_PASSWORD_MAX_LENGTH = 256;

// Update RCON configuration
router.put("/rcon", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { host, port, password } = req.body;

    // Validate host (if provided)
    if (host !== undefined) {
      if (typeof host !== "string" || !RCON_HOST_REGEX.test(host)) {
        return res.status(400).json({ error: "Invalid host format" });
      }
    }

    // Validate port (if provided)
    if (port !== undefined) {
      const portNum = parseInt(port, 10);
      if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        return res
          .status(400)
          .json({ error: "Invalid port number (must be 1-65535)" });
      }
    }

    // Validate password length (if provided)
    if (password !== undefined) {
      if (
        typeof password !== "string" ||
        password.length > RCON_PASSWORD_MAX_LENGTH
      ) {
        return res.status(400).json({ error: "Invalid password format" });
      }
    }

    rconService.updateConfig(host, port, password);

    res.json({ success: true, message: "RCON configuration updated" });
  } catch (error) {
    log.error(`Failed to update RCON config: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Test RCON connection
router.post("/test-rcon", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");

    // Try to connect
    const connected = await rconService.connect();

    if (connected) {
      // Try a lightweight command to verify the connection is alive
      // Avoid 'help' — PZ dumps a huge response that can overflow RCON packets and hang
      try {
        // execute() reports a failed command by return value, so the catch
        // below only ever saw transport-level errors.
        const probe = await rconService.execute("players", { skipLog: true });
        if (!probe?.success) {
          res.json({
            success: true,
            message:
              "Connected but command failed: " + sanitizeError(probe?.error),
            connected: true,
            warning: true,
          });
          return;
        }
        res.json({
          success: true,
          message: "RCON connection successful",
          connected: true,
        });
      } catch (cmdError) {
        res.json({
          success: true,
          message:
            "Connected but command failed: " + sanitizeError(cmdError.message),
          connected: true,
          warning: true,
        });
      }
    } else {
      res.json({
        success: false,
        message: "Failed to connect to RCON",
        connected: false,
      });
    }
  } catch (error) {
    log.error(`RCON test failed: ${error.message}`);
    res.status(500).json({
      success: false,
      error: sanitizeError(error.message),
      connected: false,
    });
  }
});

export default router;
