import express from "express";
import fs from "fs";
import { createLogger } from "../utils/logger.js";
const log = createLogger("API:Config");
import { getAllSettings, getSetting, setSetting } from "../database/init.js";
import {
  sanitizeError,
  sanitizeErrorParams,
  SENSITIVE_FIELD_RE,
  isMaskedSecret,
  maskSensitiveObject,
} from "../utils/sanitize.js";
import net from "net";
import { requirePermission, getRoleByName } from "../services/permissions.js";
import {
  MOD_CHECK_INTERVAL_MINUTES_MAX,
  MOD_CHECK_INTERVAL_MINUTES_MIN,
  minutesToCheckIntervalMs,
} from "../services/modChecker.js";
import {
  checkTcpReachable,
  RCON_UNREACHABLE_DETAIL,
  RCON_AUTH_FAILED_DETAIL,
  RCON_USER_ACTION_TIMEOUT_MS,
} from "../services/rcon.js";
import { ErrorCode } from "../utils/errorCodes.js";
import {
  requireIntInRange,
  BIND_PORT_MIN,
  BIND_PORT_MAX,
  GAME_PORT_MAX,
  DESTINATION_PORT_MIN,
  DESTINATION_PORT_MAX,
  MEMORY_GB_MIN,
  MIN_MEMORY_GB_MAX,
  MAX_MEMORY_GB_MAX,
} from "./server.js";
import { parseBoundedInteger } from "../utils/queryNumbers.js";
import { setSteamSessionCredentials } from "../services/steamSessionCredentials.js";

// Local to this route: autoExportMaxPerPlayer has no counterpart check in
// server.js (or anywhere else), so unlike the port/memory constants above
// there's no cross-file drift risk to guard against -- a plain local
// constant is enough to remove the hand-typed literal. Range matches
// Settings.tsx's own input (min=1 max=50).
const AUTO_EXPORT_MAX_PER_PLAYER_MIN = 1;
const AUTO_EXPORT_MAX_PER_PLAYER_MAX = 50;
const SFTP_POLL_INTERVAL_MIN = 2;
const SFTP_POLL_INTERVAL_MAX = 10;

// Also local: neither of these has a server.js counterpart. Ranges chased
// from their consuming services rather than guessed -- see the comments at
// each call site below for the source. modRestartDelay's floor is 0, not
// Settings.tsx's min=1: the service (modChecker.js's setRestartOptions) is
// the authority on what the system can actually do, and it demonstrably
// accepts 0. Refusing a value here that the consumer handles fine would be
// a NEW disagreement between two layers -- the exact bug class this whole
// thread closed, just pointing the other way (a save that rejects what the
// consumer accepts, instead of a wizard that refuses what /app-settings
// accepts). Settings.tsx keeping min=1 is fine and unrelated: that's a UI
// recommendation, not a claim about server capability, and the two are
// allowed to differ. See 2026-08-23 config.js numeric-field audit part 5.
const MOD_RESTART_DELAY_MIN = 0;
const MOD_RESTART_DELAY_MAX = 30;
const SERVER_AUTO_UPDATE_WARNING_MINUTES_MIN = 0;
const SERVER_AUTO_UPDATE_WARNING_MINUTES_MAX = 60;

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
  "panelBridgeSftpConfigPath",
];

// PUT /app-settings is gated by panel.settings alone, but its real reach
// spans five OTHER capabilities' territory: rconPassword/rconHost/rconPort
// (server.configure), Steam credentials (server.install), PanelBridge SFTP
// including its password (bridge.setup), the Discord guild ID
// (integrations.manage), and Workshop session cookies + collection sync
// (mods.manage). A panel.settings holder cannot silently rewrite any of
// these through this one door without also holding the capability that
// actually governs it -- found in the 2026-08-26 capability-description
// sweep. Every key NOT listed here is the genuinely app-level remainder
// (CORS, dark mode, mod check interval, HTTPS bind config, ...) and needs
// nothing beyond panel.settings itself, which the route is already gated
// on.
//
// serverPath/serverConfigPath/zomboidDataPath are the LEGACY, pre-multi-
// server settings mirror of servers.js's own installPath/serverConfigPath/
// zomboidDataPath fields -- not a separate concept that merely shares a
// name. Confirmed by reading every real consumer, not assumed from the
// label: server.js's getServerConfigPath()/console-log route, chunks.js's
// getZomboidDataPath(), modChecker.js's ACF-path lookup, and updateChecker.js
// all resolve `activeServer?.<field> || getSetting(<legacy key>)` -- a
// PER-FIELD fallback that consults the legacy setting even while a real
// active server exists, whenever that server's own field happens to be
// unset. That makes this the same "one operation, two doors" shape closed
// four other times tonight: servers.js's own writes to these fields are
// gated servers.manage, so this door is mapped to match the sibling write
// path (per the field being genuinely the same one, not the label) rather
// than to server.configure. serverPort is the one exception -- grepped
// every getSetting("serverPort") call site and found none outside this
// file itself; nothing ever reads the legacy value, so it's dead storage
// with no live consumer to create a two-doors risk. Left unmapped
// (panel.settings only) rather than invented a requirement for a value
// nothing acts on.
const SETTINGS_KEY_CAPABILITY = {
  rconHost: "server.configure",
  rconPort: "server.configure",
  rconPassword: "server.configure",
  serverPath: "servers.manage",
  serverConfigPath: "servers.manage",
  zomboidDataPath: "servers.manage",
  steamApiKey: "server.install",
  steamUpdateAccount: "server.install",
  steamcmdPath: "server.install",
  panelBridgeSftpEnabled: "bridge.setup",
  panelBridgeSftpHost: "bridge.setup",
  panelBridgeSftpPort: "bridge.setup",
  panelBridgeSftpUsername: "bridge.setup",
  panelBridgeSftpPassword: "bridge.setup",
  panelBridgeSftpBridgePath: "bridge.setup",
  panelBridgeSftpPollIntervalSeconds: "bridge.setup",
  panelBridgeSftpLogPath: "bridge.setup",
  panelBridgeSftpConfigPath: "bridge.setup",
  discordGuildId: "integrations.manage",
  workshopCollectionId: "mods.manage",
  workshopCollectionAutoSync: "mods.manage",
  steamSessionId: "mods.manage",
  steamLoginSecure: "mods.manage",
};

const ORIGIN_DELIMITER_REGEX = /[\n,;]+/;
const MAX_CORS_ALLOWED_ORIGINS_LENGTH = 5000;
const MAX_CORS_ALLOWED_ORIGINS = 100;
const MAX_CORS_ORIGIN_LENGTH = 256;

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

// Sensitive settings are masked in API responses by pattern (see
// SENSITIVE_FIELD_RE / maskSensitiveObject in utils/sanitize.js) rather than
// an explicit key list, so a newly added secret-shaped setting (jwtSecret,
// discordBotToken, ...) is masked automatically instead of leaking in
// plaintext until someone remembers to list it here.
const maskSensitiveSettings = maskSensitiveObject;

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

// Update application settings. Admin-gated: this endpoint can flip
// corsAllowAll (disables CORS origin checking panel-wide) and other
// security-relevant settings, so any authenticated-but-unprivileged
// account must not be able to write it.
router.put("/app-settings", requirePermission("panel.settings"), async (req, res) => {
  try {
    const { settings } = req.body || {};
    log.info(
      `PUT /app-settings — updating ${settings ? Object.keys(settings).length : 0} keys: [${settings ? Object.keys(settings).join(", ") : ""}]`,
    );

    if (!settings || typeof settings !== "object") {
      return res.status(400).json({ error: "Settings are required", code: ErrorCode.CONFIG_APP_SETTINGS_REQUIRED });
    }

    // Fields whose validation only matters while a companion feature flag
    // is on -- built as ONE table, not N copies of "if (key === X &&
    // effectiveFlagEnabled)". GitHub #118 was exactly this bug for
    // panelBridgeSftpPort alone; the 2026-08-26 bug hunt (findings 4/9-12)
    // found FOUR more fields with the identical shape (httpsCertPath/
    // httpsKeyPath/httpsPort gated by httpsEnabled, modRestartDelay by
    // modAutoRestart, serverAutoUpdateWarningMinutes by serverAutoUpdate,
    // autoExportMaxPerPlayer by autoExportOnLogin, reconnectInterval by
    // autoReconnect) sitting unfixed right next to the one that got fixed --
    // the exact "sibling that was never hardened" pattern this whole floor
    // spent the day on. Five hand-written copies of the same guard
    // disagreeing with each other by the next release is the predictable
    // outcome of writing it five times; one table can't drift from itself.
    // An unused field must never block an unrelated save, regardless of
    // which feature it belongs to.
    const FEATURE_GATED_FIELDS = {
      panelBridgeSftpPort: "panelBridgeSftpEnabled",
      panelBridgeSftpPollIntervalSeconds: "panelBridgeSftpEnabled",
      httpsCertPath: "httpsEnabled",
      httpsKeyPath: "httpsEnabled",
      httpsPort: "httpsEnabled",
      modRestartDelay: "modAutoRestart",
      serverAutoUpdateWarningMinutes: "serverAutoUpdate",
      autoExportMaxPerPlayer: "autoExportOnLogin",
      reconnectInterval: "autoReconnect",
    };

    // What a gating flag will actually BE once this save lands -- not what
    // it currently is in the database. Preferring the payload's own value
    // (when this save touches the flag at all) matters both ways: a user
    // turning a feature OFF and fixing one of its fields in the same save
    // must not have the old, now-irrelevant field block them, and a user
    // turning a feature ON in the same save that also sets one of its
    // fields must still have that field validated -- reading only the
    // stored value would validate against the state this save is about to
    // replace, not the state it's about to create. Falls back to stored
    // state only when this payload doesn't mention the flag at all (a
    // partial update that never touches it shouldn't have to resend it just
    // to stay validated correctly). Lazy and memoized PER FLAG: most saves
    // touch at most one or two of these features, and a stored-state lookup
    // should only happen for the flags actually needed -- an unconditional
    // getSetting() for every gated flag on every save would be several
    // unnecessary DB round trips per save, every time, forever.
    const effectiveFlagCache = new Map();
    function getEffectiveFlag(flagKey) {
      if (!effectiveFlagCache.has(flagKey)) {
        effectiveFlagCache.set(
          flagKey,
          Object.prototype.hasOwnProperty.call(settings, flagKey)
            ? Promise.resolve(Boolean(settings[flagKey]))
            : getSetting(flagKey).then(Boolean),
        );
      }
      return effectiveFlagCache.get(flagKey);
    }

    // Only allow valid setting keys to prevent prototype pollution
    const validEntries = [];
    for (const [key, value] of Object.entries(settings)) {
      if (!VALID_SETTINGS_KEYS.includes(key)) {
        log.warn(`Invalid setting key rejected: ${key}`);
        continue;
      }

      // Skip validation entirely for a field whose feature won't be on
      // after this save -- still saved (a disabled field's stale value is
      // harmless sitting in storage; refusing to even SAVE it would be its
      // own new bug), just not checked. This one check replaces what used
      // to be five separate "&& effectiveXEnabled" conditions bolted onto
      // five separate validation blocks below.
      const gateFlag = FEATURE_GATED_FIELDS[key];
      if (gateFlag && !(await getEffectiveFlag(gateFlag))) {
        validEntries.push([key, value]);
        continue;
      }

      if (key === "corsAllowedOrigins") {
        const corsValidationError = validateCorsAllowedOrigins(value);
        if (corsValidationError) {
          return res.status(400).json({
            error: corsValidationError,
            code: ErrorCode.CONFIG_INVALID_CORS_ORIGINS,
            params: sanitizeErrorParams({ reason: corsValidationError }),
          });
        }
      }

      // serverName is interpolated into filesystem paths downstream
      // (serverManager.js's getServerConfig/saveServerConfig build
      // `${serverName}.ini`, and the same value names the launched
      // StartServer_<name>.bat/start-server_<name>.sh script) via the
      // legacy-settings fallback in serverManager.js's loadConfig(). The
      // modern multi-server profile path (routes/servers.js's
      // SERVER_NAME_REGEX) already rejects anything but a traversal-
      // incapable name at write time for exactly this reason -- this
      // endpoint is the one write path that never got the same check
      // (2026-08-26 bug hunt finding 13). Same whitelist, kept local
      // rather than imported since route files in this codebase don't
      // currently import from one another (servers.js/server.js each keep
      // their own copy of this same regex already).
      if (
        key === "serverName" &&
        !/^[a-zA-Z0-9_-][a-zA-Z0-9_\- ]*[a-zA-Z0-9_-]$|^[a-zA-Z0-9_-]$/.test(
          String(value),
        )
      ) {
        return res.status(400).json({
          error:
            "Server name may only contain letters, numbers, spaces, underscores and hyphens (and can't start or end with a space).",
          code: ErrorCode.CONFIG_INVALID_SERVER_NAME,
        });
      }

      if (
        key === "modCheckInterval" &&
        minutesToCheckIntervalMs(value) === null
      ) {
        return res.status(400).json({
          error: `modCheckInterval must be a whole number of minutes from ${MOD_CHECK_INTERVAL_MINUTES_MIN} to ${MOD_CHECK_INTERVAL_MINUTES_MAX}`,
          code: ErrorCode.CONFIG_INVALID_MOD_CHECK_INTERVAL,
        });
      }

      // Bound chased from the consuming service (modChecker.js's
      // setRestartOptions: `Math.max(0, Math.min(30, val))`): [0, 30].
      // Settings.tsx's own input says min=1, a real discrepancy -- flagged
      // rather than resolved silently, and the ruling went with the
      // service's floor, not the client's: the service is the authority on
      // what the system can do, and refusing 0 here while the consumer
      // accepts it fine would be a NEW save-vs-consumer disagreement, the
      // same bug class this whole thread closed. Settings.tsx keeping min=1
      // is fine and unrelated -- a UI recommendation, not a capability
      // claim. See 2026-08-23 config.js numeric-field audit part 5. Gated
      // by modAutoRestart via FEATURE_GATED_FIELDS above (2026-08-26 bug
      // hunt finding 9) -- only reached when the feature will be on.
      if (key === "modRestartDelay") {
        const modRestartDelayCheck = requireIntInRange(
          value,
          MOD_RESTART_DELAY_MIN,
          MOD_RESTART_DELAY_MAX,
          "Mod restart delay (minutes)",
        );
        if (!modRestartDelayCheck.ok) {
          return res.status(400).json({ error: modRestartDelayCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: modRestartDelayCheck.message }) });
        }
      }

      // Bound chased from the consuming service (updateChecker.js's
      // parseAutoUpdateWarningMinutes: `Math.min(60, Math.max(0, ...))`,
      // default 15) -- matches Settings.tsx's own input (min=0 max=60)
      // exactly, no discrepancy to report for this one. Gated by
      // serverAutoUpdate via FEATURE_GATED_FIELDS above (2026-08-26 bug
      // hunt finding 10).
      if (key === "serverAutoUpdateWarningMinutes") {
        const warningMinutesCheck = requireIntInRange(
          value,
          SERVER_AUTO_UPDATE_WARNING_MINUTES_MIN,
          SERVER_AUTO_UPDATE_WARNING_MINUTES_MAX,
          "Server auto-update warning (minutes)",
        );
        if (!warningMinutesCheck.ok) {
          return res.status(400).json({ error: warningMinutesCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: warningMinutesCheck.message }) });
        }
      }

      if (key === "lanIpAddress" && value !== "" && net.isIP(value) !== 4) {
        return res
          .status(400)
          .json({ error: "lanIpAddress must be an IPv4 address or empty", code: ErrorCode.CONFIG_INVALID_LAN_IP });
      }

      if (
        [
          "corsAllowAll",
          "corsAllowPrivateNetworks",
          "corsDebug",
          "panelBridgeAutoUpdate",
          "autoExportOnLogin",
          "enablePublicIpLookup",
          // The other 8 boolean-shaped keys in VALID_SETTINGS_KEYS, added in
          // the same pass as rconPort/serverPort/min+maxMemory/panelPort
          // below -- accepted any truthy/falsy JS value with no gate at all
          // until now. See 2026-08-23 config.js numeric-field audit.
          "modAutoRestart",
          "serverAutoUpdate",
          "darkMode",
          "autoReconnect",
          "httpsEnabled",
          "autoStartServer",
          "workshopCollectionAutoSync",
          "panelBridgeSftpEnabled",
        ].includes(key) &&
        typeof value !== "boolean"
      ) {
        return res.status(400).json({
          error: `${key} must be true or false`,
          code: ErrorCode.CONFIG_INVALID_BOOLEAN_FIELD,
          params: sanitizeErrorParams({ field: key }),
        });
      }

      // httpsCertPath/httpsKeyPath used to be accepted as any string and
      // only ever checked at panel BOOT (utils/certs.js), where a bad value
      // (directory instead of file, unreadable) crashed the whole process
      // via an unguarded fs.readFileSync -- see that file's own fix for the
      // other half of this. Rejecting a bad value here, immediately, is
      // what actually prevents an operator from saving one in the first
      // place; the boot-time fix alone only stops the crash for a value
      // that goes bad AFTER being saved (moved/deleted/permissions changed
      // later), which is a real but separate case this can't catch.
      //
      // GitHub #118 sibling (2026-08-26 bug hunt, finding 4), REPRODUCIBLE:
      // Settings.tsx never clears these fields when HTTPS is toggled off
      // (only its one-click "Enable HTTPS" quick-setup resets them), so an
      // operator who set a cert path, disabled HTTPS, and later had that
      // file move/get deleted/lose permissions would find every UNRELATED
      // settings save failing on a field doing nothing -- the exact SFTP
      // bug, for a field with a much easier real-world path to a stale
      // value. Handled generically above via FEATURE_GATED_FIELDS: this
      // block is only reached at all when HTTPS will be on after this save.
      // `value !== ""` here is a SEPARATE, orthogonal exemption -- clearing
      // the field back to empty (auto-generated cert) must work even while
      // HTTPS is enabled, which the feature-gate above does not cover.
      if (
        (key === "httpsCertPath" || key === "httpsKeyPath") &&
        value !== ""
      ) {
        if (typeof value !== "string") {
          return res.status(400).json({
            error: `${key} must be a string`,
            code: ErrorCode.CONFIG_HTTPS_PATH_NOT_STRING,
            params: sanitizeErrorParams({ field: key }),
          });
        }
        let stat;
        try {
          stat = fs.statSync(value);
        } catch {
          return res.status(400).json({
            error: `${key} does not point to a file that exists: ${value}`,
            code: ErrorCode.CONFIG_HTTPS_PATH_NOT_FOUND,
            params: sanitizeErrorParams({ field: key, value }),
          });
        }
        if (!stat.isFile()) {
          return res.status(400).json({
            error: `${key} must be a file, not a directory: ${value}`,
            code: ErrorCode.CONFIG_HTTPS_PATH_NOT_A_FILE,
            params: sanitizeErrorParams({ field: key, value }),
          });
        }
        try {
          fs.accessSync(value, fs.constants.R_OK);
        } catch {
          return res.status(400).json({
            error: `${key} exists but is not readable by the panel: ${value}`,
            code: ErrorCode.CONFIG_HTTPS_PATH_NOT_READABLE,
            params: sanitizeErrorParams({ field: key, value }),
          });
        }
      }

      // GitHub #118 sibling (2026-08-26 bug hunt, finding 4): this used a
      // hand-rolled parseBoundedInteger floor of 1 and never joined the
      // BIND_PORT_MIN family, even though HTTPS is unambiguously a bind
      // port -- the panel itself opens and listens on it, exactly like
      // panelPort three blocks below. Brought in now for the same reason
      // panelPort uses it: one shared range instead of a second hand-typed
      // copy that can silently drift from it. Disabled-feature skip is
      // handled generically above via FEATURE_GATED_FIELDS.
      if (key === "httpsPort") {
        const httpsPortCheck = requireIntInRange(value, BIND_PORT_MIN, BIND_PORT_MAX, "HTTPS port");
        if (!httpsPortCheck.ok) {
          return res.status(400).json({ error: httpsPortCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: httpsPortCheck.message }) });
        }
        const panelPort = await getSetting("panelPort");
        if (panelPort && httpsPortCheck.value === Number(panelPort)) {
          return res.status(400).json({
            error: `HTTPS port cannot be the same as the panel's HTTP port (${panelPort})`,
            code: ErrorCode.CONFIG_HTTPS_PORT_MATCHES_PANEL_PORT,
            params: sanitizeErrorParams({ panelPort }),
          });
        }
      }

      // Same missing-range-check shape httpsPort/reconnectInterval closed
      // above, but this one IS the lockout case, not the mild one: panelPort
      // sat in this same allowed-keys list, two lines from httpsPort, with
      // no case at all here. An out-of-range value saved silently (200,
      // no error), index.js only discovers it can't bind at the NEXT
      // restart and falls back to 3001 -- but the Restart Panel button has
      // already sent the browser to the port the operator typed, which
      // nothing is listening on. Range matches auth.js's /setup check for
      // the same field (ErrorCode.SETUP_PANEL_PORT_INVALID) -- reusing
      // server.js's requireIntInRange rather than a third hand-rolled
      // range check. See 2026-08-23 validateInt-coerces / config.js
      // numeric-field audit.
      //
      // The collision check below is bidirectional on purpose: httpsPort's
      // check above only compared a new httpsPort against the STORED
      // panelPort. Left one-directional, the exact collision that guard
      // exists to prevent was still reachable by approaching from the other
      // side -- setting panelPort to whatever httpsPort already is. A guard
      // reachable by walking around it from the other direction isn't a
      // guard, it's a speed bump on one approach.
      if (key === "panelPort") {
        // Bind: the panel itself listens on this. See the bind-vs-
        // destination rule at server.js's BIND_PORT_MIN/DESTINATION_PORT_MIN.
        const panelPortCheck = requireIntInRange(value, BIND_PORT_MIN, BIND_PORT_MAX, "Panel port");
        if (!panelPortCheck.ok) {
          return res.status(400).json({ error: panelPortCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: panelPortCheck.message }) });
        }
        const httpsPort = await getSetting("httpsPort");
        if (httpsPort && panelPortCheck.value === Number(httpsPort)) {
          return res.status(400).json({
            error: `panelPort cannot be the same as the panel's HTTPS port (${httpsPort})`,
            code: ErrorCode.CONFIG_PANEL_PORT_MATCHES_HTTPS_PORT,
            params: sanitizeErrorParams({ httpsPort }),
          });
        }
      }

      // The exact four fields server.js's /install, /quick-setup,
      // /configure-rcon and /configure-network now refuse out-of-range on
      // (2026-08-23 validateInt-coerces audit, commit 39f836f) were also
      // reachable through THIS route with zero validation -- a second door
      // onto the same four values, invisible from inside server.js since it
      // lives in a completely different file. Same ranges as server.js's
      // checks so the two doors can't disagree with each other.
      if (key === "rconPort") {
        // This key is the legacy/single-active-server RCON target that
        // /configure-rcon (server.js) hardcodes to rconHost 127.0.0.1 --
        // always local, so it stays on the bind floor like server.js's own
        // rconPort checks, not the destination floor RCON gets in
        // servers.js's per-server (and genuinely remote-capable) model.
        // See the full bind-vs-destination writeup at server.js's
        // BIND_PORT_MIN/DESTINATION_PORT_MIN (GitHub #118).
        const rconPortCheck = requireIntInRange(value, BIND_PORT_MIN, BIND_PORT_MAX, "RCON port");
        if (!rconPortCheck.ok) {
          return res.status(400).json({ error: rconPortCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: rconPortCheck.message }) });
        }
      }

      if (key === "serverPort") {
        const serverPortCheck = requireIntInRange(value, BIND_PORT_MIN, GAME_PORT_MAX, "Game port");
        if (!serverPortCheck.ok) {
          return res.status(400).json({ error: serverPortCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: serverPortCheck.message }) });
        }
      }

      // Destination, not bind: SFTP is a service on someone ELSE's machine
      // that this panel connects out to -- 22, its standard port, is why
      // this floor was the actual bug (GitHub #118). The disabled-feature
      // skip is handled generically above via FEATURE_GATED_FIELDS -- by
      // the time we reach here, either SFTP will be on after this save, or
      // this line was never reached at all for this key.
      if (key === "panelBridgeSftpPort") {
        const sftpPortCheck = requireIntInRange(
          value,
          DESTINATION_PORT_MIN,
          DESTINATION_PORT_MAX,
          "SFTP port",
        );
        if (!sftpPortCheck.ok) {
          return res.status(400).json({ error: sftpPortCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: sftpPortCheck.message }) });
        }
      }

      if (key === "panelBridgeSftpPollIntervalSeconds") {
        const sftpPollCheck = requireIntInRange(
          value,
          SFTP_POLL_INTERVAL_MIN,
          SFTP_POLL_INTERVAL_MAX,
          "SFTP sync interval (seconds)",
        );
        if (!sftpPollCheck.ok) {
          return res.status(400).json({ error: sftpPollCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: sftpPollCheck.message }) });
        }
      }

      if (key === "minMemory") {
        const minMemoryCheck = requireIntInRange(value, MEMORY_GB_MIN, MIN_MEMORY_GB_MAX, "Minimum memory (GB)");
        if (!minMemoryCheck.ok) {
          return res.status(400).json({ error: minMemoryCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: minMemoryCheck.message }) });
        }
      }

      if (key === "maxMemory") {
        const maxMemoryCheck = requireIntInRange(value, MEMORY_GB_MIN, MAX_MEMORY_GB_MAX, "Maximum memory (GB)");
        if (!maxMemoryCheck.ok) {
          return res.status(400).json({ error: maxMemoryCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: maxMemoryCheck.message }) });
        }
      }

      // Lower priority than the fields above -- a garbage value here
      // doesn't misdirect anything, it self-heals to 3 via `Number(...) ||
      // 3` the next time it's read (see index.js's export-rotation code).
      // But an unvalidated garbage value would still sit in the database
      // forever, unreadable by that fallback's intent, as a trap for
      // whoever next reads that column expecting a real number. Range
      // matches Settings.tsx's own input (min=1 max=50). Gated by
      // autoExportOnLogin via FEATURE_GATED_FIELDS above (2026-08-26 bug
      // hunt finding 11).
      if (key === "autoExportMaxPerPlayer") {
        const autoExportMaxCheck = requireIntInRange(value, AUTO_EXPORT_MAX_PER_PLAYER_MIN, AUTO_EXPORT_MAX_PER_PLAYER_MAX, "Auto-export copies kept");
        if (!autoExportMaxCheck.ok) {
          return res.status(400).json({ error: autoExportMaxCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: autoExportMaxCheck.message }) });
        }
      }

      // Same missing-range-check shape as httpsPort above, but the worst
      // case if it slips through is a too-fast/too-slow reconnect timer,
      // not a lockout -- worth closing anyway since it's one check in the
      // same loop, not worth its own investigation. Gated by autoReconnect
      // via FEATURE_GATED_FIELDS above (2026-08-26 bug hunt finding 12).
      if (key === "reconnectInterval") {
        const interval = parseBoundedInteger(value, null, 1, 60);
        if (interval === null) {
          const message = "reconnectInterval must be a whole number from 1 to 60";
          return res.status(400).json({
            error: message,
            code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD,
            params: sanitizeErrorParams({ message }),
          });
        }
      }

      if (key === "chatPresets") {
        // Array of short strings, max 50 entries, each <=500 chars.
        if (!Array.isArray(value)) {
          return res
            .status(400)
            .json({ error: "chatPresets must be an array", code: ErrorCode.CONFIG_CHAT_PRESETS_NOT_ARRAY });
        }
        if (value.length > 50) {
          return res
            .status(400)
            .json({ error: "chatPresets supports up to 50 entries", code: ErrorCode.CONFIG_CHAT_PRESETS_TOO_MANY });
        }
        if (!value.every((v) => typeof v === "string" && v.length <= 500)) {
          return res.status(400).json({
            error: "chatPresets entries must be strings up to 500 characters",
            code: ErrorCode.CONFIG_CHAT_PRESETS_INVALID_ENTRY,
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
      if (SENSITIVE_FIELD_RE.test(key) && isMaskedSecret(value)) {
        log.info(
          `Preserving stored value for sensitive key "${key}" (masked input ignored)`,
        );
        return false;
      }
      return true;
    });

    // A key whose real, effective value would actually CHANGE requires the
    // capability that governs it, not just panel.settings. Compared against
    // the CURRENTLY STORED value (via getAllSettings(), not the masked
    // response GET returns) rather than mere presence in the request:
    // Settings.tsx's Save button resends the entire settings object on
    // every save, so gating on presence alone would refuse every save by
    // anyone who isn't already an admin -- Angela hit this identical trap
    // in the ini editor a few hours earlier tonight. `filtered` already
    // excludes a masked-placeholder resend of an untouched secret, so this
    // only ever fires for a value genuinely different from what's stored.
    const touchesGovernedKey = filtered.some(
      ([key]) => key in SETTINGS_KEY_CAPABILITY,
    );
    const currentSettings = touchesGovernedKey ? await getAllSettings() : null;
    const missingCapabilities = [];
    let callerCapabilities = null;
    for (const [key, value] of filtered) {
      const requiredCapability = SETTINGS_KEY_CAPABILITY[key];
      if (!requiredCapability) continue;
      if (JSON.stringify(currentSettings[key]) === JSON.stringify(value)) {
        continue;
      }
      if (callerCapabilities === null) {
        const role = req.user ? await getRoleByName(req.user.role) : null;
        callerCapabilities = Array.isArray(role?.capabilities)
          ? role.capabilities
          : [];
      }
      if (!callerCapabilities.includes(requiredCapability)) {
        missingCapabilities.push({ key, requiredCapability });
      }
    }
    if (missingCapabilities.length > 0) {
      const detail = missingCapabilities
        .map((m) => `"${m.key}" needs ${m.requiredCapability}`)
        .join(", ");
      return res.status(403).json({
        error: `Cannot change ${detail} without holding that capability yourself.`,
        code: ErrorCode.CONFIG_APP_SETTINGS_CAPABILITY_REQUIRED,
        params: sanitizeErrorParams({ detail }),
        missing: missingCapabilities,
      });
    }

    const steamSessionIdEntry = filtered.find(
      ([key]) => key === "steamSessionId",
    );
    const steamLoginSecureEntry = filtered.find(
      ([key]) => key === "steamLoginSecure",
    );
    if (steamSessionIdEntry || steamLoginSecureEntry) {
      await setSteamSessionCredentials(
        steamSessionIdEntry?.[1],
        steamLoginSecureEntry?.[1],
      );
    }

    for (const [key, value] of filtered) {
      if (
        key === "modCheckInterval" ||
        key === "steamSessionId" ||
        key === "steamLoginSecure"
      ) continue;
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

// CORS diagnostics for remote access troubleshooting. Admin-only, same tier
// as debug.js: this is internal panel/network diagnostic surface, not a
// server-operation task, and can mutate CORS state (clearing the blocked
// list, forcing a reload).
router.get("/cors-debug", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const getCorsDebugSnapshot = req.app.get("getCorsDebugSnapshot");
    if (typeof getCorsDebugSnapshot !== "function") {
      return res
        .status(500)
        .json({ error: "CORS diagnostics are not available", code: ErrorCode.CONFIG_CORS_DIAGNOSTICS_UNAVAILABLE });
    }
    res.json({ diagnostics: getCorsDebugSnapshot() });
  } catch (error) {
    log.error(`Failed to get CORS diagnostics: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/cors-debug/reload", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const refreshCorsConfig = req.app.get("refreshCorsConfig");
    if (typeof refreshCorsConfig !== "function") {
      return res
        .status(500)
        .json({ error: "CORS config reload is not available", code: ErrorCode.CONFIG_CORS_RELOAD_UNAVAILABLE });
    }
    const diagnostics = await refreshCorsConfig();
    res.json({ success: true, diagnostics });
  } catch (error) {
    log.error(`Failed to reload CORS config: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete("/cors-debug/blocked", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const clearCorsBlockedOrigins = req.app.get("clearCorsBlockedOrigins");
    const getCorsDebugSnapshot = req.app.get("getCorsDebugSnapshot");
    if (
      typeof clearCorsBlockedOrigins !== "function" ||
      typeof getCorsDebugSnapshot !== "function"
    ) {
      return res
        .status(500)
        .json({ error: "CORS diagnostics are not available", code: ErrorCode.CONFIG_CORS_DIAGNOSTICS_UNAVAILABLE });
    }

    clearCorsBlockedOrigins();
    res.json({ success: true, diagnostics: getCorsDebugSnapshot() });
  } catch (error) {
    log.error(`Failed to clear blocked CORS origins: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Test RCON connection
router.post("/test-rcon", requirePermission("server.configure"), async (req, res) => {
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
      // Same reachability split as /rcon/test and /rcon/connect (see
      // 0714d91): without this, EVERY failure -- host genuinely unreachable
      // OR host reachable but the saved password is wrong -- collapsed into
      // one generic message, which Console.tsx's banner then rendered as
      // "host unreachable" even for a stale password. That told a user with
      // a correct host/port to go debug their network for a problem that
      // was actually a wrong password one screen away. Reuses the same
      // canonical detail strings and error codes as those two routes
      // (services/rcon.js) rather than a third, independently-drifting
      // mapping -- this is the same failed-handshake outcome, just reached
      // from a third call site.
      const { host: configuredHost, port: configuredPort } =
        rconService.getConfig();
      const reachable = await checkTcpReachable(
        configuredHost,
        configuredPort,
        RCON_USER_ACTION_TIMEOUT_MS,
      );
      if (!reachable) {
        return res.json({
          success: false,
          error: "unreachable",
          detail: RCON_UNREACHABLE_DETAIL,
          message: RCON_UNREACHABLE_DETAIL,
          connected: false,
          code: ErrorCode.RCON_CONNECT_UNREACHABLE,
        });
      }
      res.json({
        success: false,
        error: "auth_failed",
        detail: RCON_AUTH_FAILED_DETAIL,
        message: RCON_AUTH_FAILED_DETAIL,
        connected: false,
        code: ErrorCode.RCON_CONNECT_AUTH_FAILED,
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
