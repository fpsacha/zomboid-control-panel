import { EventEmitter } from "events";
import net from "net";
import { createLogger } from "../utils/logger.js";
const log = createLogger("RCON");
import {
  logCommand,
  getSetting,
  getActiveServer,
  getServer,
} from "../database/init.js";
import { SourceRconClient } from "../utils/sourceRcon.js";
import { readSecret } from "../utils/secrets.js";
import { parseBoundedInteger } from "../utils/queryNumbers.js";
import { redactRconCommandSecrets } from "../utils/rconCommandRedaction.js";
import { ErrorCode } from "../utils/errorCodes.js";

// Ordered classification of the technical error messages execute()'s catch
// block sees, feeding BOTH getUserFriendlyError()'s user-facing prose and
// the RCON_EXECUTE_DISCONNECTED code attached alongside it -- one shared
// source of truth, not two independently-maintained lists. Before this,
// the client (client/src/pages/Console.tsx's RCON_DISCONNECT_PHRASES) kept
// its OWN copy of these same six outcomes as substrings to match against
// the prose below, and a 2026-08-30 audit found it had already silently
// drifted: "Server is not running" was reworded to "Game server is not
// running." here without the client's phrase list ever being told, so a
// real disconnect stopped being detected. A code can't drift the same way
// prose can -- see RCON_EXECUTE_DISCONNECTED's own comment in
// server/utils/errorCodes.js. `disconnect: false` on the authentication
// branch is deliberate, not an oversight: a wrong RCON password is not a
// dropped connection, and must never be reported as one.
const RCON_ERROR_CLASSIFICATIONS = [
  {
    test: (msg) => msg.includes("ECONNREFUSED"),
    message:
      "Cannot connect to server. Is the game server running with RCON enabled?",
    disconnect: true,
  },
  {
    test: (msg) => msg.includes("ETIMEDOUT") || msg.includes("timed out"),
    message:
      "Connection timed out. Server may be unresponsive or firewall is blocking.",
    disconnect: true,
  },
  {
    test: (msg) => msg.includes("ECONNRESET") || msg.includes("EPIPE"),
    message: "Connection was reset. Server may have restarted or crashed.",
    disconnect: true,
  },
  {
    test: (msg) => msg.includes("authentication") || msg.includes("password"),
    message: "Authentication failed. Check RCON password in server settings.",
    disconnect: false,
  },
  {
    test: (msg) => msg.includes("Max reconnection attempts"),
    message:
      "Could not reconnect after multiple attempts. Server may be offline.",
    disconnect: true,
  },
  {
    test: (msg) => msg.includes("not connected"),
    message: "Not connected to server. Please check if server is running.",
    disconnect: true,
  },
  {
    test: (msg) => msg.includes("Server is not running"),
    message: "Game server is not running.",
    disconnect: true,
  },
];

// Common accented Latin letters (French in particular -- this panel ships an
// FR locale) transliterated to their closest plain-ASCII equivalent, for
// foldToRconAscii() below. PZ's RCON can't carry these bytes reliably, so
// dropping them silently used to turn "répété" into "rpt" -- readable-ish by
// accident, not by design. Transliterating first means "repete" instead:
// degraded but recognisable, and consistent regardless of which RCON text
// field (broadcast, ban reason, etc.) the string passes through. Bounded to
// Latin-1 Supplement + Latin Extended-A (players.js's own SAFE_TEXT_REGEX
// accepts exactly this range, À-ɏ) -- other scripts still fall
// through to foldToRconAscii()'s final drop, same as before.
const LATIN_TRANSLITERATION_MAP = {
  à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a",
  À: "A", Á: "A", Â: "A", Ã: "A", Ä: "A", Å: "A",
  ç: "c", Ç: "C",
  è: "e", é: "e", ê: "e", ë: "e",
  È: "E", É: "E", Ê: "E", Ë: "E",
  ì: "i", í: "i", î: "i", ï: "i",
  Ì: "I", Í: "I", Î: "I", Ï: "I",
  ñ: "n", Ñ: "N",
  ò: "o", ó: "o", ô: "o", õ: "o", ö: "o",
  Ò: "O", Ó: "O", Ô: "O", Õ: "O", Ö: "O",
  ù: "u", ú: "u", û: "u", ü: "u",
  Ù: "U", Ú: "U", Û: "U", Ü: "U",
  ý: "y", ÿ: "y", Ý: "Y",
  œ: "oe", Œ: "OE", æ: "ae", Æ: "AE",
};

// Hosts pasted from a game-server-provider panel routinely carry surrounding
// whitespace, which makes DNS resolution fail with ENOTFOUND and looks exactly
// like an unreachable server.
export function normalizeRconHost(host) {
  if (typeof host !== "string") return "127.0.0.1";
  return host.trim() || "127.0.0.1";
}

// docker-unraid-onboarding, 2026-09-09: the panel and PZ are usually
// co-located (same container, or PZ native on the same host), where
// 127.0.0.1 is correct -- but the project's own docker/unraid/
// zomboid-panel.xml documents a second, equally real topology: the panel
// and PZ in TWO SEPARATE containers sharing only the bind-mounted
// install/data volumes, reachable over the Docker network -- and that
// template's own RCON_HOST field says, verbatim, "Never use 127.0.0.1."
// Originated in discovery.js's create-from-discovery (Dwight); shared here
// so every route that writes a freshly-configured server's rconHost --
// install, quick-setup, configure-rcon, discovery -- resolves it the same
// way instead of each hardcoding 127.0.0.1 and silently regressing on this
// topology one call site at a time (server.js:3114/3626/3809, found after
// discovery.js shipped this fix without checking for siblings).
// "CHANGE_ME" is the template's own literal default for a REQUIRED field --
// guarded explicitly in case an Unraid version ever lets a required field
// deploy unedited, so a profile is never created pointed at a host
// literally named "CHANGE_ME".
export function resolveEnvRconHost() {
  const envHost = String(process.env.RCON_HOST || "").trim();
  return envHost && envHost !== "CHANGE_ME" ? envHost : "127.0.0.1";
}

function parseConfiguredRconPort(value) {
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return 27015;
  }
  return parseBoundedInteger(value, null, 1, 65535);
}

// Raw TCP reachability probe used by testRconConnection() below — separate
// from RconService.checkPortOpen() because that method has a fixed 2s
// timeout tuned for the background auto-reconnect loop, while a
// user-initiated "Test Connection" click can afford (and benefits from) a
// longer 5s window before reporting the host unreachable.
export function checkTcpReachable(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

// Default timeout for a user-initiated connection attempt: this function's
// own probe, and POST /connect's follow-up reachability check below (routes/
// rcon.js) when reused for the same purpose. Longer than checkPortOpen()'s
// 2s background-loop timeout, same reasoning as that method's comment.
export const RCON_USER_ACTION_TIMEOUT_MS = 5000;

// The two canonical detail strings for a first-time RCON handshake failure.
// Exported so POST /connect (routes/rcon.js) can report the exact same
// wording for the exact same two classes /test already distinguishes,
// instead of maintaining a second, independently-drifting mapping.
export const RCON_UNREACHABLE_DETAIL = "Unreachable: check host and port";
export const RCON_AUTH_FAILED_DETAIL = "Authentication failed: check RCON password";

// Tests arbitrary RCON credentials without touching the shared RconService
// singleton's connection state — used by the "Test Connection" UI so a user
// can validate host/port/password before saving them.
export async function testRconConnection({ host, port, password, timeoutMs = RCON_USER_ACTION_TIMEOUT_MS }) {
  const reachable = await checkTcpReachable(host, port, timeoutMs);
  if (!reachable) {
    return {
      success: false,
      error: "unreachable",
      detail: RCON_UNREACHABLE_DETAIL,
    };
  }

  const client = new SourceRconClient({ host, port, timeout: timeoutMs });
  try {
    await client.authenticate(password || "");
    return { success: true, detail: "Connected" };
  } catch {
    return {
      success: false,
      error: "auth_failed",
      detail: RCON_AUTH_FAILED_DETAIL,
    };
  } finally {
    client.disconnect();
  }
}

// Response texts the real B42 dedicated server sends back for a command it
// accepted but refused to run -- each confirmed verbatim against the actual
// server jar (D:/Zomboid_dev_panel/ServerB42Files/java/projectzomboid.jar,
// zombie/commands/serverCommands/*.class: GodModePlayerCommand.class /
// InvisiblePlayerCommand.class for "Wrong arguments!", NoClipCommand.class
// for "Not enough rights", ReleaseSafehouseCommand.class for "...can be
// executed only from the game"), not guessed. A normal RCON reply carrying
// one of these means the command did NOT do what it says, so without this
// check it's indistinguishable from a real success.
//
// Deliberately a denylist of PROVEN rejection shapes, not a success
// allowlist: a success allowlist would need every one of this file's ~40
// commands' real success text enumerated with confidence, which static
// bytecode reading can't give, and would fail closed on every command
// whose success text isn't in it.
//
// 2026-08-29, players.js moderation/GM-tools hunt: every pattern here MUST
// be anchored to a position a player's own (attacker-controlled) in-game
// name cannot reach. classifyRconResponse() below runs an UNANCHORED
// .test() against the whole response, and PZ's SUCCESS messages for these
// same commands interpolate the target player's name -- kickuser's success
// is `User <name> kicked.`, setaccesslevel's is `<name> granted <level>
// access level on <server>`. A player who names themselves text containing
// a rejection fragment (e.g. "Not enough rights") would have their own
// SUCCESSFUL kick misclassified as a failure the instant that fragment
// appeared anywhere in the response -- including inside their own name.
// The three pre-existing non-anchored patterns below had this exact defect
// in shipped code; confirmed each one's PZ source is a bare, non-
// interpolated literal (no player name can ever appear inside "Wrong
// arguments!" or "Not enough rights" themselves), so anchoring them to the
// full trimmed string is a strict tightening, not a behavior change for
// any genuine rejection. Every new pattern added below is anchored the
// same way: full-string where the PZ text has no interpolation at all, or
// bounded by fixed text immediately before/after the interpolated portion
// where it does (e.g. `Invalid username "<name>"` is bounded by the
// literal quote+prefix before the name and the literal closing quote
// after it -- a success response's own fixed text can never coincidentally
// reproduce both boundaries regardless of what the name in between is).
//
// Sourced from server/__fixtures__/pzRconRejectionStrings.json (a
// decompiled catalog of the actual PZ B42 server jar's command classes,
// confirmed verbatim -- not guessed) except where noted otherwise.
export const KNOWN_RCON_REJECTIONS = [
  {
    pattern: /^\s*Unknown command\b/i,
    describe: (text) => `${text}. This command is not available on this server build.`,
  },
  {
    // GodModePlayerCommand.class / InvisiblePlayerCommand.class: bare,
    // non-interpolated literal.
    pattern: /^\s*Wrong arguments!?\s*$/i,
    describe: () =>
      "Wrong arguments. This command's syntax may have changed on this server build.",
  },
  {
    // NoClipCommand.class: bare, non-interpolated literal.
    pattern: /^\s*Not enough rights\.?\s*$/i,
    describe: () =>
      "Not enough rights. The RCON account's role does not have permission to run this command.",
  },
  {
    // ReleaseSafehouseCommand.class, per this array's original citation --
    // not reachable from any command players.js currently exposes. Exact
    // full text/interpolation not present in the checked-in fixture (only
    // the class name citation above is available); end-anchored as the
    // best available tightening without a confirmed complete template.
    pattern: /can be executed only from the game\.?\s*$/i,
    describe: (text) => `${text}. This command can only be run from in-game, not over RCON.`,
  },
  {
    // KickUserCommand.class: target not currently connected. Success for
    // this same command is "User <name> kicked." -- the fixed suffix here
    // (" doesn't exist.") can never be produced by a genuine success
    // response regardless of what the interpolated name contains.
    pattern: /^User .+ doesn't exist\.\s*$/i,
    describe: () =>
      "User doesn't exist. They may have disconnected, or the name may be misspelled.",
  },
  {
    // KickUserCommand.class: target holds the CantBeKickedByUser
    // capability (e.g. another admin). Bare, non-interpolated literal.
    pattern: /^\s*This user can't be kicked\.\s*$/i,
    describe: () => "This user can't be kicked (protected account).",
  },
  {
    // Shared across AddItemCommand, AddXPCommand, TeleportCommand,
    // TeleportPlayerCommand, AddVehicleCommand, VoiceBanCommand -- all
    // resolve their target via GameServer.getPlayerByUserNameForCommand,
    // which prints this exact, non-interpolated literal when the name
    // doesn't match a currently connected player.
    pattern: /^\s*No such user\s*$/i,
    describe: () => "No such user. They must be currently connected for this command.",
  },
  {
    // setaccesslevel (GameServer.changeRole): bad username argument.
    // Bounded by the fixed `Invalid username "` prefix and the closing
    // `"` immediately after the name, both literal PZ text -- setaccesslevel's
    // own success message ("<name> granted...") never produces this shape.
    pattern: /^Invalid username ".*"\s*$/i,
    describe: (text) => `${text}. That username was not recognized.`,
  },
  {
    // setaccesslevel: bad access-level argument. The interpolated value
    // here is the admin-typed level string, already validated client-side
    // against ACCESS_LEVELS before reaching RCON -- not player-controlled.
    pattern: /^Access Level '.+' unknown, list of access level:/i,
    describe: (text) => `${text}. That access level is not recognized on this server build.`,
  },
  {
    // setaccesslevel: RCON-connected admin's OWN role lacks the rights to
    // grant this level (a role-hierarchy check, distinct from the
    // RCON-account-level "Not enough rights" above). Bare, non-interpolated
    // literal.
    pattern: /^You do not have sufficient rights to set this access level\.\s*$/i,
    describe: () => "You do not have sufficient rights to set this access level.",
  },
  {
    // setaccesslevel: target has no whitelist/server account at all.
    // Bounded the same way as "Invalid username" above.
    pattern: /^User ".*" is not in the whitelist nor the server, use \/adduser first\s*$/i,
    describe: (text) => `${text}.`,
  },
  // 2026-08-29, hunt-wave11 (Kevin's Pass 4, docs/qa/kevin-b42-jar-audits.md):
  // banuser / unbanuser / adduser / removeuserfromwhitelist each delegate
  // their entire result string to zombie/network/BanSystem or
  // zombie/network/ServerWorldDatabase -- their own command classes carry no
  // rejection text at all, which is why these four still reported a genuine
  // failure as a success even after the anchoring fix above. Same anchoring
  // discipline as every entry above: full-string where the PZ text has no
  // interpolation, bounded by fixed text immediately before/after the
  // interpolated portion where it does. Confidence tiers below are Kevin's
  // own (constant-pool string presence, not bytecode-traced return values --
  // a literal being in the class is not proof of which exact call site
  // returns it) -- the tier reflects certainty about WHICH COMMAND triggers
  // a string, not whether the string itself is real or the anchoring below
  // is safe: every pattern here is anchored the same strict way regardless
  // of tier.
  {
    // HIGH -- BanSystem.class (BanUser): target holds the CantBeBannedByUser
    // capability. Bare, non-interpolated literal, same shape as
    // KickUserCommand's "This user can't be kicked." above. Applies to
    // banuser.
    pattern: /^\s*This user can't be banned\.\s*$/i,
    describe: () => "This user can't be banned (protected account).",
  },
  {
    // HIGH -- BanSystem.class (BanUserByIP, the -ip flag path): the target
    // IP is a Steam Relay shared address, so there's no real IP to ban.
    // Interpolated value is an IP the RCON-connected ADMIN typed as an
    // argument, not the target player's chosen name -- not
    // attacker-controlled the way a display name is, but anchored the same
    // strict way regardless. Applies to banuser -ip.
    pattern: /^Cannot ban IP .+ \(Steam Relay shared address\)\. Use bansteamid or banuser instead\.\s*$/i,
    describe: (text) => `${text}`,
  },
  {
    // HIGH -- BanSystem.class (BanUserByIP): same Steam-Relay case, but the
    // player's real IP genuinely isn't available at all. Bounded by the
    // literal quotes around the interpolated player name, same shape as
    // "Invalid username" above -- a success response's own fixed text can
    // never reproduce both boundaries. Applies to banuser -ip.
    pattern: /^Cannot ban IP for player '.+' \(Steam Relay, real IP unavailable\)\. Use bansteamid or banuser without -ip\.\s*$/i,
    describe: (text) => `${text}`,
  },
  {
    // HIGH -- ServerWorldDatabase.class (addUser): target username is
    // already whitelisted. Bare, non-interpolated literal. Applies to
    // adduser.
    pattern: /^\s*A user with this name already exists\.?\s*$/i,
    describe: () => "A user with this name already exists.",
  },
  {
    // MEDIUM -- ServerWorldDatabase.class: target isn't whitelisted at all.
    // DELIBERATELY KEPT SEPARATE from the setaccesslevel pattern above
    // ("...is not in the whitelist NOR THE SERVER, use /adduser first",
    // confirmed still verbatim in GameServer.class) -- this is a shorter,
    // differently-worded literal from a different class. Do not broaden
    // one pattern to cover both; that is the exact direction that
    // reintroduces the false positives the anchoring fix above eliminated.
    // Bounded by the literal quotes around the interpolated name, same
    // shape as "Invalid username" above. Most plausibly applies to
    // unbanuser / removeuserfromwhitelist against a name that was never
    // whitelisted (attribution inferred from context, not bytecode-traced
    // -- the string and its anchoring are still fully verified).
    pattern: /^User ".*" is not in the whitelist, use \/adduser first\s*$/i,
    describe: (text) => `${text}.`,
  },
  {
    // MEDIUM -- ServerWorldDatabase.class: target username not found.
    // Distinct from both "User <name> doesn't exist." (KickUserCommand,
    // requires the trailing period + different wording) and "No such user"
    // (GameServer.getPlayerByUserNameForCommand, a different literal
    // entirely) -- a genuinely separate rejection shape. Bounded by the
    // fixed "User " prefix and " not found" suffix. Attribution to a
    // specific command inferred, not bytecode-traced.
    pattern: /^User .+ not found\s*$/i,
    describe: () => "User not found.",
  },
  {
    // MEDIUM -- BanSystem.class (BanUser): a second, redundant capability
    // check inside BanUser itself, on top of whatever the RCON
    // @RequiredCapability annotation already gates -- Kevin's own framing:
    // "worth having as a backstop pattern even if it's not expected to
    // normally fire." Bare, non-interpolated literal -- no anchoring risk
    // regardless of the backstop framing. Applies to banuser/unbanuser.
    pattern: /^\s*You don't have capability to ban\/unban users\.\s*$/i,
    describe: () => "You don't have capability to ban/unban users.",
  },
  // NOT added, named as the residual rather than left implicit: BanSystem.class
  // also carries "Connection not found" and "Player not found" -- Kevin's
  // Pass 4 rated these LOW confidence ("plausible RCON-reply shape but could
  // equally be internal-console-only text", not bytecode-traced to a
  // ban/unban call site at all). Two rejection shapes for
  // banuser/unbanuser/adduser/removeuserfromwhitelist remain genuinely
  // unrecognized after this fix -- inventing an attribution for either would
  // be worse than leaving them out (same standard Pam's original commit
  // held to for these same four commands).
];

export class RconService extends EventEmitter {
  constructor() {
    super();
    // Increase max listeners to prevent warnings during rapid reconnection cycles
    this.setMaxListeners(20);

    this.client = null;
    this.connected = false;
    this.connecting = false; // Mutex to prevent concurrent connection attempts
    this.connectPromise = null; // Store ongoing connection promise
    this.passwordFromSecretFile = Boolean(process.env.RCON_PASSWORD_FILE);
    this.config = {
      host: process.env.RCON_HOST || "127.0.0.1",
      port: parseInt(process.env.RCON_PORT, 10) || 27015,
      password: readSecret("RCON_PASSWORD") || "",
    };
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.baseReconnectDelay = 2000; // Start at 2s
    this.maxReconnectDelay = 60000; // Max 60s

    // Throttle connection failure logging to avoid spam while the game server
    // is intentionally offline. Reconnect attempts continue independently.
    this.lastConnectionErrorLog = 0;
    this.connectionErrorLogCooldown = 5 * 60 * 1000; // Only log once per 5 minutes
    this.configLoaded = false;
    this.serverManager = null; // Reference to ServerManager for server status checks

    // Periodic auto-reconnect when server is running but RCON disconnected
    this.autoReconnectInterval = null;
    this.autoReconnectDelay = 60000; // Try to reconnect every 60s if disconnected
    this.lastSuccessfulCommand = null; // Track when last command succeeded
    this.serverStarting = false; // Flag to prevent reconnects during server startup
    this.serverStartingTimeout = null; // Failsafe timeout to clear serverStarting flag
    this.connectionVersion = 0; // Version counter to invalidate stale connection attempts
    this.reconnecting = false; // Mutex to prevent concurrent reconnection attempts
    this.reconnectPromise = null; // Store ongoing reconnection promise

    // Connection timeout - how long to wait for authenticate() before giving up.
    // timeout-handling-consistency-sweep, 2026-09-10: authenticate() itself
    // runs SourceRconClient's connect phase and auth phase SEQUENTIALLY,
    // each capped at that client's own `timeout` constructor option
    // (5000ms, set where `new SourceRconClient(...)` is constructed below) --
    // a worst case of ~10000ms, an exact tie with this outer ceiling
    // measured from the same t=0. A tie leaves zero margin for scheduling
    // or network jitter: this outer timer can fire moments before the
    // inner one would have reported the real (slower but genuine) auth
    // failure, same shape as tonight's bridge bug before
    // BRIDGE_SLOW_ENUMERATION_TIMEOUT_MS gave it real headroom. Widened
    // past the inner worst case with margin; a healthy connection settles
    // in milliseconds and is unaffected.
    this.connectionTimeout = 13000;
    this.commandTimeout = 10000; // 10 seconds execution timeout for commands

    // Periodic health check to detect stale connections
    this.healthCheckInterval = null;
    this.healthCheckDelay = 60000; // Check every 60s
    this.lastHealthCheck = null;
    this.consecutiveHealthFailures = 0;
    this.maxHealthFailures = 3; // Disconnect after 3 consecutive failures

    // Track pending clients to ensure cleanup (prevents memory leaks)
    this.pendingClients = new Set();
  }

  // Set serverStarting flag with automatic timeout failsafe
  setServerStarting(value) {
    this.serverStarting = value;

    // Clear any existing timeout
    if (this.serverStartingTimeout) {
      clearTimeout(this.serverStartingTimeout);
      this.serverStartingTimeout = null;
    }

    // If setting to true, set a failsafe timeout to clear it after 5 minutes
    if (value) {
      this.serverStartingTimeout = setTimeout(
        () => {
          if (this.serverStarting) {
            log.warn(
              "serverStarting flag was stuck for 5 minutes, clearing it",
            );
            this.serverStarting = false;
          }
        },
        5 * 60 * 1000,
      ); // 5 minutes
    }
  }

  // Set reference to ServerManager (called after both services are instantiated)
  setServerManager(serverManager) {
    this.serverManager = serverManager;
  }

  // Start periodic auto-reconnection attempts
  startAutoReconnect() {
    if (this.autoReconnectInterval) return;

    this.autoReconnectInterval = setInterval(async () => {
      // Skip if server is starting - startup sequence handles connections
      if (this.serverStarting) {
        log.debug("Skipping - server is starting");
        return;
      }

      // Skip if already connected
      if (this.connected) {
        return;
      }

      // Skip if any connection attempt is already in progress
      if (this.connecting || this.reconnecting) {
        log.debug("Skipping - connection already in progress");
        return;
      }

      try {
        if (this.serverManager) {
          try {
            // eslint-disable-next-line local/no-fail-open-check-server-running -- advisory only: the boolean only selects which log line is printed below ("attempting connection" vs "probing RCON port anyway"); the real RCON connection attempt happens unconditionally right after, in every branch.
            const isRunning = await this.serverManager.checkServerRunning();
            if (isRunning) {
              log.info("Server is running, attempting connection...");
            } else {
              log.debug(
                "Process check did not confirm server; probing RCON port anyway",
              );
            }
          } catch (e) {
            log.debug(`Server check error: ${e.message}`);
          }
        }

        const result = await this.connect();
        if (result) {
          log.info("Successfully connected!");
        }
      } catch (e) {
        // During server startup, only log at debug level to reduce noise
        if (this.serverStarting) {
          log.debug(`Connection failed during startup, retrying: ${e.message}`);
        } else {
          log.warn(
            `Connection failed, retrying in ${this.autoReconnectDelay}ms: ${e.message}`,
          );
        }
        // This loop intentionally uses a fixed interval (autoReconnectDelay),
        // not exponential backoff — the separate reconnect() method below
        // implements real backoff (baseReconnectDelay * attempt, capped) for
        // its own bounded retry sequence. A previous `currentReconnectDelay`
        // field here was computed on every failure but never actually fed
        // into this setInterval's delay, so it was pure dead weight that
        // made the log message above lie about the real retry timing.
      }
    }, this.autoReconnectDelay);
    if (this.autoReconnectInterval.unref) this.autoReconnectInterval.unref();

    // Start health check interval to detect stale connections
    this.startHealthCheck();

    log.debug("auto-reconnect enabled (60s interval)");
  }

  // Start periodic health checks to detect dead connections
  startHealthCheck() {
    if (this.healthCheckInterval) return;

    this.healthCheckInterval = setInterval(async () => {
      // Only check if we think we're connected
      if (!this.connected || !this.client) {
        this.consecutiveHealthFailures = 0;
        return;
      }

      // Skip during server startup
      if (this.serverStarting) {
        return;
      }

      try {
        const result = await this.healthCheck();
        this.lastHealthCheck = Date.now();

        if (result.healthy) {
          this.consecutiveHealthFailures = 0;
          log.debug("health check: OK");
        } else {
          this.consecutiveHealthFailures++;
          log.warn(
            `health check failed (${this.consecutiveHealthFailures}/${this.maxHealthFailures}): ${result.reason}`,
          );

          if (this.consecutiveHealthFailures >= this.maxHealthFailures) {
            log.error("health check: Too many failures, forcing disconnect");
            this.forceResetConnectionState();
          }
        }
      } catch (e) {
        this.consecutiveHealthFailures++;
        log.warn(
          `health check error (${this.consecutiveHealthFailures}/${this.maxHealthFailures}): ${e.message}`,
        );

        if (this.consecutiveHealthFailures >= this.maxHealthFailures) {
          log.error("health check: Too many errors, forcing disconnect");
          this.forceResetConnectionState();
        }
      }
    }, this.healthCheckDelay);
    if (this.healthCheckInterval.unref) this.healthCheckInterval.unref();

    log.debug("health check enabled (60s interval)");
  }

  // Stop periodic health checks
  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      this.consecutiveHealthFailures = 0;
    }
  }

  // Stop periodic auto-reconnection
  stopAutoReconnect() {
    if (this.autoReconnectInterval) {
      clearInterval(this.autoReconnectInterval);
      this.autoReconnectInterval = null;
      log.info("auto-reconnect disabled");
    }
    this.stopHealthCheck();
  }

  // Load RCON settings from active server first, then fallback to legacy settings
  // `serverId`: load config for a SPECIFIC server instead of "whichever is
  // active". Used by the Scheduler to run a task against a server that
  // isn't the currently-active one, via a throwaway RconService instance —
  // the shared singleton (called with no args, as always) keeps following
  // the active server exactly as before.
  async loadConfig(serverId = null) {
    if (this.configLoaded) return;
    try {
      const targetServer = serverId
        ? await getServer(serverId)
        : await getActiveServer();
      if (targetServer) {
        // A configured server's host and port are the right target
        // regardless of whether it has an RCON password set yet — a freshly
        // added PZ server with no password configured is a completely
        // normal state. Silently falling back to a different host/port here
        // would make "wrong/missing password" and "no server configured at
        // all" indistinguishable: both used to fall through to the
        // hardcoded default and probe whatever else happened to be
        // listening there. Whether we can authenticate is decided
        // separately, below — it never changes WHERE we try to connect.
        this.config.host = normalizeRconHost(targetServer.rconHost);
        this.config.port = parseConfiguredRconPort(targetServer.rconPort);

        if (targetServer.rconPassword) {
          if (!this.passwordFromSecretFile) {
            this.config.password = targetServer.rconPassword;
          }
        } else if (!this.passwordFromSecretFile) {
          // Don't carry over a stale password from a previously loaded
          // server (e.g. after reloadConfig() on server switch) — a missing
          // password is a real, visible state to report, not a value to
          // silently inherit from whatever this instance last connected to.
          this.config.password = "";
          log.warn(
            serverId
              ? `Server ${serverId} has no RCON password set — connection attempts will fail authentication until one is configured`
              : "Active server has no RCON password set — connection attempts will fail authentication until one is configured",
          );
        }

        log.info(
          serverId
            ? `config loaded for server ${serverId}`
            : "config loaded from active server",
        );
        this.configLoaded = true;
        return;
      }

      // Fallback to legacy (global) settings — only meaningful when no
      // specific serverId was requested. Falling back to the global/active
      // settings for a targeted serverId lookup would silently connect to
      // the wrong server instead of failing loudly on a misconfigured one.
      if (!serverId) {
        const dbHost = await getSetting("rconHost");
        const dbPort = await getSetting("rconPort");
        const dbPassword = await getSetting("rconPassword");

        if (dbPassword && !this.passwordFromSecretFile) {
          this.config.password = dbPassword;
          log.info("password loaded from legacy settings");
        }
        if (dbPort !== undefined && dbPort !== null && dbPort !== "") {
          this.config.port = parseConfiguredRconPort(dbPort);
        }
        if (dbHost) {
          this.config.host = normalizeRconHost(dbHost);
        }
      } else {
        log.warn(`No RCON config found for server ${serverId}`);
      }
      this.configLoaded = true;
    } catch (error) {
      log.debug(`Could not load RCON config from database: ${error.message}`);
    }
  }

  // Is there an actual RCON target on record — a server row (any server ever
  // added, active or not) or the legacy global rcon* settings some installs
  // still rely on? Deliberately NEVER memoized, unlike loadConfig()/
  // configLoaded above: this is checked fresh on every connection attempt so
  // that adding a first server while the panel is already running is picked
  // up on the very next reconnect tick, without needing reloadConfig() to be
  // called by whatever route created it, or a panel restart.
  // Without this check, "nothing configured" and "configured but wrong"
  // are indistinguishable to a caller — both used to fall through to the
  // hardcoded default host/port and attempt authentication against whatever
  // unrelated process happened to be listening there.
  async hasConfiguredTarget() {
    try {
      if (await getActiveServer()) return true;
    } catch (e) {
      log.debug(`hasConfiguredTarget: active server lookup failed: ${e.message}`);
    }
    try {
      const [dbHost, dbPort, dbPassword] = await Promise.all([
        getSetting("rconHost"),
        getSetting("rconPort"),
        getSetting("rconPassword"),
      ]);
      return Boolean(dbHost || dbPort || dbPassword);
    } catch (e) {
      log.debug(`hasConfiguredTarget: legacy settings lookup failed: ${e.message}`);
      return false;
    }
  }

  // Force reload config (called when active server changes)
  async reloadConfig(serverId = null) {
    this.configLoaded = false;
    // Disconnect if connected since credentials may have changed
    if (this.connected) {
      await this.disconnect();
    }
    await this.loadConfig(serverId);
  }

  // Force reset connection state (called when a connection attempt times out)
  // This aggressively destroys everything to ensure next attempt starts completely fresh
  forceResetConnectionState() {
    // Increment version to invalidate any in-flight connection attempts
    this.connectionVersion++;
    const version = this.connectionVersion;
    log.info(`Force resetting connection state (version ${version})`);

    this.connecting = false;
    this.connectPromise = null;
    this.reconnecting = false;
    this.reconnectPromise = null;
    this.reconnectAttempts = 0;
    this.connected = false;
    this.consecutiveHealthFailures = 0;

    // Clear serverStarting timeout to prevent memory leak
    if (this.serverStartingTimeout) {
      clearTimeout(this.serverStartingTimeout);
      this.serverStartingTimeout = null;
    }
    this.serverStarting = false;

    // Clean up all pending clients to prevent memory leaks
    this._cleanupAllPendingClients();

    // Clean up main client
    this._cleanupClient();

    log.info(`Connection state forcibly reset (ready for new attempt)`);
    this.emit("disconnected");
  }

  // Helper to clean up the RCON client socket - the new SourceRconClient owns
  // its own socket lifecycle entirely (single persistent listener set,
  // cleaned up inside its own disconnect()), so this no longer needs to
  // reach into private internals (client.connection/.socket/._socket) the
  // way the old rcon-srcds-based client required.
  _cleanupClient(clientToClean = null) {
    const client = clientToClean || this.client;
    if (!client) return;

    // Remove from pending clients set
    this.pendingClients.delete(client);

    try {
      client.disconnect();
    } catch (e) {
      // Ignore cleanup errors
    }

    // Only null out main client if we're cleaning the main client
    if (client === this.client) {
      this.client = null;
    }
  }

  // Clean up all pending clients (called during force reset)
  _cleanupAllPendingClients() {
    for (const client of this.pendingClients) {
      this._cleanupClient(client);
    }
    this.pendingClients.clear();
  }

  async connect() {
    // If already connected, return immediately
    if (this.connected && this.client) {
      return true;
    }

    // If a connection attempt is already in progress, wait for it
    if (this.connecting && this.connectPromise) {
      return this.connectPromise;
    }

    // Set mutex and create promise for concurrent callers to await
    this.connecting = true;
    const connectPromise = this._doConnect();
    this.connectPromise = connectPromise;

    try {
      const result = await connectPromise;
      return result;
    } finally {
      if (this.connectPromise === connectPromise) {
        this.connecting = false;
        this.connectPromise = null;
      }
    }
  }

  // Helper to check if RCON port is actually open
  async checkPortOpen(host, port) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(2000); // 2s timeout

      const onConnect = () => {
        socket.destroy();
        resolve(true);
      };

      const onError = () => {
        socket.destroy();
        resolve(false);
      };

      socket.once("connect", onConnect);
      socket.once("timeout", onError);
      socket.once("error", onError);

      try {
        socket.connect(port, host);
      } catch (e) {
        onError();
      }
    });
  }

  async _doConnect() {
    // Capture current version at start - if it changes, this attempt is stale
    const startVersion = this.connectionVersion;

    // Nothing to connect to yet — the normal state for a fresh install, and
    // for the 60s auto-reconnect interval every time it ticks before a
    // server has been added. Checked before loadConfig() so we never even
    // populate this.config with the hardcoded default in this case, let
    // alone probe/authenticate against whatever else might hold that port.
    if (!(await this.hasConfiguredTarget())) {
      log.debug(
        "No RCON server configured yet — skipping connection attempt",
      );
      return false;
    }

    // Load config from database before connecting
    await this.loadConfig();

    if (!Number.isInteger(this.config.port) || this.config.port < 1 || this.config.port > 65535) {
      log.warn("RCON port configuration is invalid; skipping connection attempt");
      return false;
    }

    // Check if version changed (connection was force reset)
    if (this.connectionVersion !== startVersion) {
      log.info("Connection attempt cancelled (force reset occurred)");
      return false;
    }

    // Check if server is running before attempting connection (skip if disabled)
    // This check can be slow on some systems, so we allow bypassing it
    const skipServerCheck = process.env.RCON_SKIP_SERVER_CHECK === "true";

    if (!skipServerCheck && this.serverManager) {
      // ... serverManager check code ...
      let timeoutId;
      try {
        // Add a shorter timeout for the server check to avoid long waits
        // eslint-disable-next-line local/no-fail-open-check-server-running -- advisory only: true/false/error/timeout all fall through to the same "attempt the real connection anyway" path below; the boolean only sets a soft this.connected hint and picks a debug log line.
        const checkPromise = this.serverManager.checkServerRunning();
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("Server check timeout")),
            5000,
          );
        });

        const isServerRunning = await Promise.race([
          checkPromise,
          timeoutPromise,
        ]);
        clearTimeout(timeoutId);
        if (!isServerRunning) {
          log.debug(
            "Process check did not detect the server; continuing with RCON port probe",
          );
          this.connected = false;
        }
      } catch (error) {
        clearTimeout(timeoutId);
        // On timeout or error, proceed with connection attempt anyway
        log.debug(
          `Server check failed (${error.message}), attempting connection anyway...`,
        );
      }
    }

    // Check if RCON port is actually open/listening
    // This prevents premature connection attempts (e.g. while server is still booting)
    try {
      const isOpen = await this.checkPortOpen(
        this.config.host,
        this.config.port,
      );
      if (!isOpen) {
        // Throttled to one line a minute: this used to be debug-only, so a
        // wrong host or a closed port produced no diagnosis at all.
        const now = Date.now();
        if (now - this.lastConnectionErrorLog > this.connectionErrorLogCooldown) {
          this.lastConnectionErrorLog = now;
          log.warn(
            `RCON ${this.config.host}:${this.config.port} is not reachable - check the host, port, and that RCON is enabled on the server`,
          );
        }
        return false;
      }
    } catch (e) {
      log.debug(`Port check error: ${e.message}`);
      return false;
    }

    // Check if version changed again
    if (this.connectionVersion !== startVersion) {
      log.info("Connection attempt cancelled (force reset occurred)");
      return false;
    }

    // Double-check in case connection completed while waiting
    if (this.connected && this.client) {
      return true;
    }

    let newClient = null;
    try {
      // Clean up any existing client before creating new one
      if (this.client) {
        try {
          this.client.disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
        this.client = null;
      }

      log.info(
        `Creating new client for ${this.config.host}:${this.config.port} (version ${startVersion})`,
      );

      newClient = new SourceRconClient({
        host: this.config.host,
        port: this.config.port,
        timeout: 5000,
      });

      // Track this client so it can be cleaned up if connection is force reset
      this.pendingClients.add(newClient);
      this.client = newClient;

      log.info("Calling authenticate()...");

      // Wrap authenticate() with a timeout to prevent hanging forever
      let authTimeoutId;
      const authPromise = this.client.authenticate(this.config.password);
      const timeoutPromise = new Promise((_, reject) => {
        authTimeoutId = setTimeout(() => {
          reject(
            new Error(
              `Authentication timed out after ${this.connectionTimeout}ms`,
            ),
          );
        }, this.connectionTimeout);
      });

      try {
        await Promise.race([authPromise, timeoutPromise]);
      } finally {
        clearTimeout(authTimeoutId);
      }

      // Check if version changed during authenticate (which can hang)
      if (this.connectionVersion !== startVersion) {
        log.info(
          "Connection succeeded but version changed - discarding stale connection",
        );
        this._cleanupClient(newClient);
        return false;
      }

      // Connection successful - remove from pending and keep as main client
      this.pendingClients.delete(newClient);
      this.connected = true;
      this.reconnectAttempts = 0;
      this.consecutiveHealthFailures = 0;

      log.info(`connected to ${this.config.host}:${this.config.port}`);
      // Emit connected event for other services (like PanelBridge) to react
      this.emit("connected");
      return true;
    } catch (error) {
      const ownsCurrentClient = newClient && this.client === newClient;
      // Clean up only the client created by this attempt. A reset or a newer
      // connection may have installed a different client while authentication
      // was waiting; clearing that newer socket here would resurrect the same
      // connection storm this state machine is meant to prevent.
      if (newClient) {
        this._cleanupClient(newClient);
      } else if (this.connectionVersion === startVersion && !this.connecting) {
        this._cleanupClient();
      }
      if (
        ownsCurrentClient ||
        (!newClient && this.connectionVersion === startVersion)
      ) {
        this.connected = false;
      }

      // Throttle connection failure logs to avoid spam when server is offline
      const now = Date.now();
      if (now - this.lastConnectionErrorLog > this.connectionErrorLogCooldown) {
        this.lastConnectionErrorLog = now;
        // During server startup, suppress warnings to reduce noise
        if (this.serverStarting) {
          log.debug(`connection failed during startup: ${error.message}`);
        } else if (
          error.message.includes("ECONNREFUSED") ||
          error.message.includes("ETIMEDOUT") ||
          error.message.includes("timed out")
        ) {
          log.warn(
            `connection failed (server may be offline): ${error.message}`,
          );
        } else {
          log.error(`connection failed: ${error.message}`);
        }
      }
      throw error;
    }
  }

  async disconnect() {
    const wasConnected = this.connected;

    if (this.client) {
      this._cleanupClient();
    }

    this.connected = false;
    this.lastSuccessfulCommand = null;

    if (wasConnected) {
      log.info("disconnected");
      // Emit disconnected event
      this.emit("disconnected");
    }
  }

  async reconnect() {
    // Don't attempt reconnect during server startup - the startup sequence handles it
    if (this.serverStarting) {
      log.debug("reconnect: Skipping - server is starting");
      return false;
    }

    const reconnectStartVersion = this.connectionVersion;

    // If already connected, no need to reconnect
    if (this.connected) {
      log.debug("reconnect: Already connected");
      return true;
    }

    // If a reconnection is already in progress, wait for it instead of starting a new one
    if (this.reconnecting && this.reconnectPromise) {
      log.debug(
        "reconnect: Already in progress, waiting for existing attempt...",
      );
      return this.reconnectPromise;
    }

    // If a connection is in progress, wait for it
    if (this.connecting && this.connectPromise) {
      log.debug("reconnect: Connection in progress, waiting...");
      try {
        const result = await this.connectPromise;
        return this.connectionVersion === reconnectStartVersion ? result : false;
      } catch (e) {
        // Connection failed, continue to reconnect
      }
    }

    // Set mutex and create promise for concurrent callers to await
    this.reconnecting = true;
    const reconnectPromise = this._doReconnect();
    this.reconnectPromise = reconnectPromise;

    try {
      const result = await reconnectPromise;
      return result;
    } finally {
      if (this.reconnectPromise === reconnectPromise) {
        this.reconnecting = false;
        this.reconnectPromise = null;
      }
    }
  }

  async _doReconnect() {
    // Capture version at start - if it changes, we should abort
    const startVersion = this.connectionVersion;

    await this.disconnect();

    while (this.reconnectAttempts < this.maxReconnectAttempts) {
      // Check if force reset happened - abort immediately
      if (this.connectionVersion !== startVersion) {
        log.debug("reconnect: Version changed (force reset), aborting");
        this.reconnectAttempts = 0;
        return false;
      }

      this.reconnectAttempts++;
      log.info(`reconnecting... Attempt ${this.reconnectAttempts}`);

      // Exponential backoff with cap: 5s, 10s, 15s, 20s, 25s, then stay at 30s
      const delay = Math.min(
        this.baseReconnectDelay * this.reconnectAttempts,
        30000,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));

      // Check again after delay
      if (this.connectionVersion !== startVersion) {
        log.debug("reconnect: Version changed (force reset), aborting");
        this.reconnectAttempts = 0;
        return false;
      }

      // Check if server startup began while we were waiting
      if (this.serverStarting) {
        log.debug("reconnect: Server starting, aborting reconnect loop");
        this.reconnectAttempts = 0;
        return false;
      }

      // If already connected (by another path), we're done
      if (this.connected) {
        log.debug("reconnect: Already connected, stopping");
        this.reconnectAttempts = 0;
        return true;
      }

      try {
        const result = await this.connect();
        if (this.connectionVersion !== startVersion) {
          this.reconnectAttempts = 0;
          return false;
        }
        if (result) {
          // Reset attempts on successful reconnection
          this.reconnectAttempts = 0;
          log.info("reconnected successfully");
          return true;
        }
        // If connect returns false (server not running), don't retry
        log.debug("reconnect: Server not running, stopping attempts");
        this.reconnectAttempts = 0;
        return false;
      } catch (error) {
        // Connection failed, will retry in next loop iteration
        log.debug(
          `reconnect attempt ${this.reconnectAttempts} failed: ${error.message}`,
        );
      }
    }

    // Max attempts reached
    log.warn(
      `reconnect: Max attempts (${this.maxReconnectAttempts}) reached, giving up. Auto-reconnect will retry later.`,
    );
    this.reconnectAttempts = 0;
    return false;
  }

  // Checks a raw RCON response against KNOWN_RCON_REJECTIONS -- returns
  // {error, response} if it matches a proven rejection shape, null
  // otherwise (including for empty/non-string responses, which are the
  // normal shape for most commands that don't echo anything back).
  classifyRconResponse(response) {
    if (typeof response !== "string" || !response) return null;
    const trimmed = response.trim();
    for (const { pattern, describe } of KNOWN_RCON_REJECTIONS) {
      if (pattern.test(trimmed)) {
        return { error: describe(trimmed), response: trimmed };
      }
    }
    return null;
  }

  // Execute a command with optional skipLog to avoid polluting command history with automatic commands
  async execute(
    command,
    { skipLog = false, retryOnConnectionError = false } = {},
  ) {
    let commandClient = null;
    let commandSent = false;
    try {
      // If server is starting, don't try to connect yet
      if (this.serverStarting) {
        return { success: false, error: "Server is starting, please wait..." };
      }

      if (!this.connected) {
        const connectResult = await this.connect();
        // If connect returns false, server is not running
        if (connectResult === false) {
          // Raw literal, not routed through getUserFriendlyError() -- kept
          // exactly as-is (quit()'s own comparison below depends on this
          // exact string), with the code attached directly here instead.
          return {
            success: false,
            error: "Server is not running",
            code: ErrorCode.RCON_EXECUTE_DISCONNECTED,
          };
        }
      }

      log.debug(`executing: ${redactRconCommandSecrets(command)}`);

      // Execute with timeout
      commandClient = this.client;
      if (!commandClient || typeof commandClient.execute !== "function") {
        throw new Error("RCON not connected");
      }
      commandSent = true;
      let timeoutId;
      const executePromise = commandClient.execute(command);
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Command execution timed out")),
          this.commandTimeout,
        );
      });

      let response;
      try {
        response = await Promise.race([executePromise, timeoutPromise]);
      } finally {
        clearTimeout(timeoutId);
      }

      // Track successful command for connection health monitoring
      if (this.client === commandClient && this.connected) {
        this.lastSuccessfulCommand = Date.now();
        this.consecutiveHealthFailures = 0;
      }

      log.debug(`response: ${response}`);

      // The server answers a command it refuses to run with a normal RCON
      // reply, so without this check -- and without checking it BEFORE the
      // database log below -- the refusal looks like success both to the
      // caller and in the panel's own persisted command history.
      const rejection = this.classifyRconResponse(response);

      // Log to database (unless skipLog is set for automatic commands)
      if (!skipLog) {
        logCommand(command, rejection ? rejection.error : response, !rejection);
      }

      if (rejection) {
        log.warn(`Server rejected command: ${redactRconCommandSecrets(command)} (${rejection.response})`);
        return { success: false, error: rejection.error, response: rejection.response };
      }

      return {
        success: true,
        response: response || "Command executed successfully",
      };
    } catch (error) {
      const errorMsg = error.message || "Unknown error";

      // Categorize errors for better handling
      const isConnectionError =
        errorMsg.includes("ECONNREFUSED") ||
        errorMsg.includes("ETIMEDOUT") ||
        errorMsg.includes("ECONNRESET") ||
        errorMsg.includes("EPIPE") ||
        errorMsg.includes("not connected") ||
        errorMsg.includes("timeout") ||
        errorMsg.includes("timed out") ||
        errorMsg.includes("socket");

      const isServerOffline = errorMsg.includes("Server is not running");

      // Use debug for connection-related failures to avoid log spam
      if (isConnectionError || isServerOffline) {
        log.debug(
          `command skipped (${isServerOffline ? "server offline" : "connection error"}): ${command}`,
        );
      } else {
        log.warn(`command failed: ${errorMsg}`);
      }

      // Mark as disconnected on connection errors
      if (isConnectionError) {
        const wasCurrentClient = commandClient && this.client === commandClient;
        if (commandClient) {
          this._cleanupClient(commandClient);
        } else {
          this._cleanupClient();
        }
        if (wasCurrentClient || !commandClient) {
          this.connected = false;
        }

        // Don't try to reconnect during server startup - the startup sequence handles it
        if (this.serverStarting) {
          if (!skipLog) {
            logCommand(command, "Server is starting...", false);
          }
          return {
            success: false,
            error: "Server is starting, please wait...",
          };
        }

        if (!retryOnConnectionError) {
          const friendlyError = this.getUserFriendlyError(errorMsg);
          if (!skipLog) {
            logCommand(command, friendlyError, false);
          }
          return {
            success: false,
            error: friendlyError,
            commandSent:
              commandSent && !/^RCON not connected$/i.test(errorMsg.trim()),
            transportError: true,
          };
        }

        // Try to reconnect and retry the command
        try {
          await this.reconnect();
          // Retry the command after reconnection (if reconnect succeeded)
          const retryClient = this.client;
          if (this.connected && retryClient) {
            // Execute with timeout for retry as well
            let retryTimeoutId;
            const retryExecutePromise = retryClient.execute(command);
            const retryTimeoutPromise = new Promise((_, reject) => {
              retryTimeoutId = setTimeout(
                () => reject(new Error("Command execution timed out")),
                this.commandTimeout,
              );
            });

            let response;
            try {
              response = await Promise.race([
                retryExecutePromise,
                retryTimeoutPromise,
              ]);
            } catch (retryError) {
              const retryWasCurrentClient = this.client === retryClient;
              this._cleanupClient(retryClient);
              if (retryWasCurrentClient) this.connected = false;
              const retryMsg = this.getUserFriendlyError(retryError.message);
              if (!skipLog) {
                logCommand(command, retryMsg, false);
              }
              return {
                success: false,
                error: retryMsg,
                commandSent:
                  !/^RCON not connected$/i.test(retryError.message.trim()),
                transportError: true,
              };
            } finally {
              clearTimeout(retryTimeoutId);
            }

            if (this.client === retryClient && this.connected) {
              this.lastSuccessfulCommand = Date.now();
            }

            // Same rejection check as the primary attempt above -- a retry
            // that reconnects successfully but gets a refusal back must not
            // report success just because the connection came back up.
            const rejection = this.classifyRconResponse(response);
            if (!skipLog) {
              logCommand(command, rejection ? rejection.error : response, !rejection);
            }
            if (rejection) {
              log.warn(`Server rejected command on retry: ${redactRconCommandSecrets(command)} (${rejection.response})`);
              return { success: false, error: rejection.error, response: rejection.response };
            }
            return {
              success: true,
              response: response || "Command executed successfully",
            };
          } else {
            // Reconnect returned false or didn't connect -- an ordinary,
            // unambiguous disconnect (the server is genuinely offline, not
            // an unexpected error), same shape as the connectResult===false
            // branch above, so the code is attached directly here rather
            // than routed through getRconDisconnectCode(), which classifies
            // an error MESSAGE and there isn't one on this path -- reconnect()
            // resolved without throwing. Without this, Console.tsx's
            // isRconDisconnectError() never fires for this branch and the
            // "connection dropped" banner silently never appears for the
            // most ordinary case it exists to cover.
            if (!skipLog) {
              logCommand(command, "Connection failed", false);
            }
            return {
              success: false,
              error: "RCON reconnection failed",
              code: ErrorCode.RCON_EXECUTE_DISCONNECTED,
              commandSent,
              transportError: true,
            };
          }
        } catch (reconnectError) {
          const reconnectMsg = this.getUserFriendlyError(
            reconnectError.message,
          );
          if (!skipLog) {
            logCommand(command, reconnectMsg, false);
          }
          return {
            success: false,
            error: reconnectMsg,
            code: this.getRconDisconnectCode(reconnectError.message),
            commandSent,
            transportError: true,
          };
        }
      }

      const friendlyError = this.getUserFriendlyError(errorMsg);
      if (!skipLog) {
        logCommand(command, friendlyError, false);
      }
      return {
        success: false,
        error: friendlyError,
        code: this.getRconDisconnectCode(errorMsg),
      };
    }
  }

  // Convert technical errors to user-friendly messages
  getUserFriendlyError(errorMsg) {
    if (!errorMsg) return "Unknown error occurred";
    const match = RCON_ERROR_CLASSIFICATIONS.find((c) => c.test(errorMsg));
    return match ? match.message : errorMsg;
  }

  // The code counterpart to getUserFriendlyError() above, classified from
  // the exact same table so the two can never disagree about which
  // outcomes are a disconnect. Returns null for a non-disconnect failure
  // (including an unrecognized error and the authentication-failure
  // branch) -- callers attach this alongside the prose from
  // getUserFriendlyError(), not instead of it.
  getRconDisconnectCode(errorMsg) {
    if (!errorMsg) return null;
    const match = RCON_ERROR_CLASSIFICATIONS.find((c) => c.test(errorMsg));
    return match?.disconnect ? ErrorCode.RCON_EXECUTE_DISCONNECTED : null;
  }

  // Sanitize input for RCON commands to prevent injection
  sanitize(input) {
    if (input === null || input === undefined) return "";
    // Remove quotes, backslashes, AND control characters (newlines, tabs, etc)
    return String(input).replace(/["\\]|[\x00-\x1F\x7F]/g, "");
  }

  sanitizeQuotedArg(input, label = "RCON argument", maxLength = 128) {
    if (input === null || input === undefined) {
      throw new Error(`${label} is required`);
    }
    const value = String(input).trim();
    if (!value) {
      throw new Error(`${label} is required`);
    }
    if (value.length > maxLength) {
      throw new Error(`${label} is too long`);
    }
    if (/["\\]|[\x00-\x1F\x7F]/.test(value)) {
      throw new Error(`${label} contains unsupported characters`);
    }
    return value;
  }

  // Shared text-folding step for every free-text field that ends up inside
  // an RCON command string (broadcasts, ban reasons, ...): normalize the
  // punctuation PZ's RCON silently mishandles (curly quotes/dashes/
  // ellipsis) to plain ASCII, transliterate common accented Latin letters,
  // then drop anything still outside printable ASCII. Used to be
  // reimplemented separately per call site with different character-class
  // rules (see docs/qa/kevin-adversarial-findings.md Finding 2) -- the same
  // French text folded differently depending on which RCON call carried it,
  // and the caller had no way to know its text had been altered. One
  // implementation now; callers that need a narrower character set (e.g.
  // sanitizeForBanReason()'s punctuation whitelist) apply that on top of
  // this, not instead of it.
  foldToRconAscii(input) {
    return String(input ?? "")
      .replace(/[\u2018\u2019]/g, "'") // curly single quotes -> '
      .replace(/[\u201C\u201D]/g, '"') // curly double quotes -> "
      .replace(/[\u2013\u2014]/g, "-") // en/em dash -> -
      .replace(/[\u2026]/g, "...") // ellipsis
      .replace(/[\u00C0-\u024F]/g, (ch) => LATIN_TRANSLITERATION_MAP[ch] ?? "") // transliterate known accented Latin
      .replace(/[^\x20-\x7E]/g, "") // drop everything else outside printable ASCII
      .replace(/\s+/g, " ")
      .trim();
  }

  sanitizeServerMessage(input) {
    return this.sanitize(String(input ?? "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/\u2026/g, "..."))
      .replace(/\p{So}|\p{Sk}|\p{Sm}|\p{Sc}|\u200D|\uFE0E|\uFE0F/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Server commands
  async save({ skipLog = false, retryOnConnectionError = false } = {}) {
    return this.execute("save", { skipLog, retryOnConnectionError });
  }

  async quit({ skipLog = false, retryOnConnectionError = false } = {}) {
    // The quit command will shutdown the server and close the connection.
    // This may result in connection errors, which are expected -- but
    // execute() has its own try/catch spanning its whole body that never
    // rethrows (every failure path, including every connection-error
    // branch, resolves {success:false, ...} instead of rejecting), so a
    // try/catch here around the await could never actually catch anything.
    // A quit whose connection reset mid-shutdown -- the normal case --
    // reported success:false, indistinguishable from a quit that never
    // reached the server (e.g. scheduler.js's performRestart() used to
    // treat every clean auto-restart quit as a failure and fall back to a
    // forced stop). Inspect the RESULT instead of a thrown error. The two
    // guard messages below mean execute() never actually sent "quit" at all
    // (server already stopped / still starting) -- those stay real
    // failures; anything else execute() can fail with for "quit"
    // specifically is the server closing the connection as it exits.
    const quitClient = this.client;
    const result = await this.execute("quit", {
      skipLog,
      retryOnConnectionError,
    });
    // Mark as disconnected since server is shutting down
    if (this.client === quitClient) {
      this.connected = false;
      this._cleanupClient(quitClient);
    }
    if (
      !result.success &&
      result.commandSent === true &&
      result.transportError === true
    ) {
      return { success: true, response: "Server shutting down" };
    }
    return result;
  }

  async serverMessage(message, { skipLog = false } = {}) {
    const safeMessage = this.sanitizeServerMessage(message);
    if (!safeMessage) {
      log.warn(
        "serverMessage: message reduced to empty after sanitization, skipping",
      );
      return { success: false, response: "Empty message after sanitization" };
    }
    const result = await this.execute(`servermsg "${safeMessage}"`, {
      skipLog,
    });
    // Detect the case where PZ returns the help text instead of broadcasting
    if (
      result?.success &&
      typeof result.response === "string" &&
      /Use:\s*\/servermsg/i.test(result.response)
    ) {
      log.warn(
        `servermsg appears to have been rejected by PZ (help text returned). Message was: ${safeMessage.substring(0, 80)}`,
      );
      return { success: false, response: result.response, rejected: true };
    }
    return result;
  }

  async getPlayers() {
    // Skip logging for automatic player polling to avoid cluttering command history
    const result = await this.execute("players", {
      skipLog: true,
      retryOnConnectionError: true,
    });
    if (result.success) {
      return {
        success: true,
        players: this.parsePlayers(result.response),
      };
    }
    return result;
  }

  parsePlayers(response) {
    // Parse the players response
    // Format typically: "Players connected (X):\n-username\n-username2"
    const players = [];
    if (!response) return players;

    const lines = response.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("-")) {
        players.push({
          name: trimmed.substring(1).trim(),
          online: true,
        });
      }
    }
    return players;
  }

  // Player commands
  async kickPlayer(username, reason = "") {
    const safeUser = this.sanitizeQuotedArg(username, "Username", 64);
    const safeReason = this.sanitizeForBanReason(reason);
    let cmd = `kickuser "${safeUser}"`;
    if (safeReason) cmd += ` -r "${safeReason}"`;
    return this.execute(cmd);
  }

  sanitizeForBanReason(input) {
    if (!input) return "";
    // Fold first (curly quotes/accents), THEN apply the ban-reason-specific
    // whitelist on top -- alphanumeric, spaces, and basic punctuation only.
    // No quotes/backslash here even though foldToRconAscii() would let a
    // straight one through: banuser's own `-r "..."` wrapping can't carry
    // one safely, same reasoning as sanitize() elsewhere in this file.
    return this.foldToRconAscii(input)
      .replace(/[^a-zA-Z0-9\s.,!?'-]/g, "")
      .substring(0, 100);
  }

  async banPlayer(username, banIp = false, reason = "") {
    const safeUser = this.sanitizeQuotedArg(username, "Username", 64);
    const safeReason = this.sanitizeForBanReason(reason);
    let cmd = `banuser "${safeUser}"`;
    if (banIp) cmd += " -ip";
    if (safeReason) cmd += ` -r "${safeReason}"`;
    const result = await this.execute(cmd);
    // sentReason is what actually reached the server -- may differ from the
    // caller's original `reason` (folding/whitelisting can alter or drop
    // characters PZ's RCON can't carry). Callers that persist their own
    // record of the ban (e.g. players.js's activity log) should log THIS,
    // not the original input, so the panel's own record matches reality.
    // See docs/qa/kevin-adversarial-findings.md Finding 2.
    return { ...result, sentReason: safeReason };
  }

  async unbanPlayer(username) {
    return this.execute(
      `unbanuser "${this.sanitizeQuotedArg(username, "Username", 64)}"`,
    );
  }

  async setAccessLevel(username, level) {
    return this.execute(
      `setaccesslevel "${this.sanitizeQuotedArg(username, "Username", 64)}" "${this.sanitizeQuotedArg(level, "Access level", 32)}"`,
    );
  }

  async addToWhitelist(username, password) {
    const safeUser = this.sanitizeQuotedArg(username, "Username", 64);
    if (password === undefined || password === null || password === "") {
      return this.execute(`adduser "${safeUser}"`);
    }
    const safePassword = this.sanitizeQuotedArg(password, "Password", 128);
    return this.execute(`adduser "${safeUser}" "${safePassword}"`);
  }

  async removeFromWhitelist(username) {
    return this.execute(
      `removeuserfromwhitelist "${this.sanitizeQuotedArg(username, "Username", 64)}"`,
    );
  }

  async teleportPlayer(player1, player2 = null) {
    const safeP1 = this.sanitizeQuotedArg(player1, "Username", 64);
    if (player2) {
      return this.execute(
        `teleport "${safeP1}" "${this.sanitizeQuotedArg(player2, "Target username", 64)}"`,
      );
    }
    return this.execute(`teleport "${safeP1}"`);
  }

  async teleportTo(x, y, z) {
    const nx = Number(x),
      ny = Number(y),
      nz = Number(z);
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) {
      throw new Error("Coordinates must be valid numbers");
    }
    return this.execute(`teleportto ${nx},${ny},${nz}`);
  }

  // Items and XP
  async addItem(username, item, count = 1) {
    const safeItem = this.sanitizeQuotedArg(item, "Item ID", 128);
    const n = Math.min(Math.max(Math.floor(Number(count)) || 1, 1), 100);
    if (username) {
      return this.execute(
        `additem "${this.sanitizeQuotedArg(username, "Username", 64)}" "${safeItem}" ${n}`,
      );
    }
    return this.execute(`additem "${safeItem}" ${n}`);
  }

  async addXp(username, perk, amount) {
    const n = Number(amount);
    if (!Number.isFinite(n)) throw new Error("amount must be a number");
    // The perk must NOT be quoted: PZ tokenises `"Axe"=100` as two arguments
    // and then fails to split it on `=`, so it silently prints usage instead.
    if (!/^[A-Za-z]+$/.test(String(perk))) {
      throw new Error("Perk must be alphabetic");
    }
    return this.execute(
      `addxp "${this.sanitizeQuotedArg(username, "Username", 64)}" ${perk}=${n}`,
    );
  }

  async addVehicle(vehicle, username = null) {
    const safeVehicle = this.sanitizeQuotedArg(vehicle, "Vehicle ID", 128);
    if (username) {
      return this.execute(
        `addvehicle "${safeVehicle}" "${this.sanitizeQuotedArg(username, "Username", 64)}"`,
      );
    }
    return this.execute(`addvehicle "${safeVehicle}"`);
  }

  async addVehicleAt(vehicle, x, y, z = 0) {
    const safeVehicle = this.sanitizeQuotedArg(vehicle, "Vehicle ID", 128);
    const coordinates = [x, y, z].map(Number);
    if (!coordinates.every(Number.isFinite)) {
      throw new Error("Coordinates must be valid numbers");
    }
    return this.execute(
      `addvehicle "${safeVehicle}" "${coordinates.map(Math.floor).join(",")}"`,
    );
  }

  // Weather
  async startRain(intensity = null) {
    if (intensity !== null && intensity !== undefined) {
      const n = Number(intensity);
      if (!Number.isFinite(n) || n < 0 || n > 1)
        throw new Error("intensity must be 0-1");
      return this.execute(`startrain ${n}`);
    }
    return this.execute("startrain");
  }

  async stopRain() {
    return this.execute("stoprain");
  }

  // 2026-08-26 bug hunt: this used to send a bare "startstorm" with no
  // duration when the caller omitted one, leaving PZ's own internal default
  // to decide the length -- an internal default this panel has no way to
  // read, and one that PanelBridge's triggerStorm Lua handler does NOT
  // share, since it explicitly defaults an omitted duration to 2.0 hours.
  // Two controls both labeled "Storm" could silently run for different
  // lengths depending on which one was pressed, with nothing surfacing that
  // they could disagree. Fixed by always sending an explicit duration here
  // too -- 2.0 hours, matching PanelBridge's own existing default exactly,
  // rather than inventing a new number or trying to guess PZ's hidden one
  // (unverifiable from this repo, and not the point: the fix is making both
  // paths agree with EACH OTHER, not with a number neither of us can see).
  async startStorm(duration = null) {
    const n = duration === null || duration === undefined ? 2.0 : Number(duration);
    if (!Number.isFinite(n) || n < 0 || n > 168)
      throw new Error("duration must be 0-168");
    return this.execute(`startstorm ${n}`);
  }

  async stopWeather() {
    return this.execute("stopweather");
  }

  // Events
  async triggerChopper() {
    return this.execute("chopper");
  }

  async triggerGunshot() {
    return this.execute("gunshot");
  }

  async triggerLightning(username = null) {
    if (username) {
      return this.execute(
        `lightning "${this.sanitizeQuotedArg(username, "Username", 64)}"`,
      );
    }
    return this.execute("lightning");
  }

  async triggerThunder(username = null) {
    if (username) {
      return this.execute(
        `thunder "${this.sanitizeQuotedArg(username, "Username", 64)}"`,
      );
    }
    return this.execute("thunder");
  }

  async createHorde(count, username = null) {
    const n = Math.min(Math.max(Math.floor(Number(count)) || 50, 1), 500);
    if (username) {
      return this.execute(
        `createhorde ${n} "${this.sanitizeQuotedArg(username, "Username", 64)}"`,
      );
    }
    return this.execute(`createhorde ${n}`);
  }

  // Admin modes. B42 splits each of these into a self-only command (bare
  // godmod/invisible, ToggleGodModHimself/ToggleInvisibleHimself capability,
  // no username argument) and a separate other-player command
  // (godmodplayer/invisibleplayer, ToggleGodModEveryone/ToggleInvisibleEveryone
  // capability, required username) -- confirmed from the real B42 dedicated
  // server jar's GodModeCommand/GodModePlayerCommand/InvisibleCommand/
  // InvisiblePlayerCommand classes. Sending a username to the self-only
  // command doesn't target that player -- there is no "self" over RCON.
  async setGodMode(username, enabled) {
    const value = enabled ? "-true" : "-false";
    if (username) {
      return this.execute(
        `godmodplayer "${this.sanitizeQuotedArg(username, "Username", 64)}" ${value}`,
      );
    }
    return this.execute(`godmod ${value}`);
  }

  async setInvisible(username, enabled) {
    const value = enabled ? "-true" : "-false";
    if (username) {
      return this.execute(
        `invisibleplayer "${this.sanitizeQuotedArg(username, "Username", 64)}" ${value}`,
      );
    }
    return this.execute(`invisible ${value}`);
  }

  async setNoclip(username, enabled) {
    const value = enabled ? "-true" : "-false";
    if (username) {
      return this.execute(
        `noclip "${this.sanitizeQuotedArg(username, "Username", 64)}" ${value}`,
      );
    }
    return this.execute(`noclip ${value}`);
  }

  // Mod check
  async checkModsNeedUpdate() {
    return this.execute("checkModsNeedUpdate", { retryOnConnectionError: true });
  }

  // Options
  async showOptions() {
    return this.execute("showoptions", { retryOnConnectionError: true });
  }

  async reloadOptions() {
    return this.execute("reloadoptions");
  }

  async changeOption(optionName, newValue) {
    // Options are pre-validated in routes, but validate+quote here too
    // (defense in depth) — optionName is a fixed, never-empty PZ option name
    // so throw-on-bad-input is safe; newValue is left lenient (sanitize()
    // strips rather than throws) since clearing an option to '' is valid.
    const safeName = this.sanitizeQuotedArg(optionName, "Option name", 64);
    return this.execute(
      `changeoption "${safeName}" "${this.sanitize(newValue)}"`,
    );
  }

  // Ban by SteamID
  async banSteamId(steamId) {
    const safeId = String(steamId ?? "").trim();
    if (!/^\d{17}$/.test(safeId)) {
      throw new Error("Steam ID must be a 17-digit number");
    }
    return this.execute(`banid ${safeId}`);
  }

  async unbanSteamId(steamId) {
    const safeId = String(steamId ?? "").trim();
    if (!/^\d{17}$/.test(safeId)) {
      throw new Error("Steam ID must be a 17-digit number");
    }
    return this.execute(`unbanid ${safeId}`);
  }

  async addAllowedSteamId(steamId) {
    return this.execute(`addSteamID ${this.sanitizeQuotedArg(steamId, "SteamID", 17)}`);
  }

  async removeAllowedSteamId(steamId) {
    return this.execute(`removeSteamID ${this.sanitizeQuotedArg(steamId, "SteamID", 17)}`);
  }

  // Voice ban
  async voiceBan(username, enabled) {
    const value = enabled ? "-true" : "-false";
    return this.execute(
      `voiceban "${this.sanitizeQuotedArg(username, "Username", 64)}" ${value}`,
    );
  }

  // Whitelist management
  async addUser(username, password) {
    const safeUser = this.sanitizeQuotedArg(username, "Username", 64);
    if (password === undefined || password === null || password === "") {
      return this.execute(`adduser "${safeUser}"`);
    }
    return this.execute(
      `adduser "${safeUser}" "${this.sanitizeQuotedArg(password, "Password", 128)}"`,
    );
  }

  async addAllToWhitelist() {
    // No Build 42 equivalent exists; fail loudly instead of sending a command
    // the server will silently reject.
    throw new Error(
      "Build 42 removed the bulk whitelist command. Add players individually with a username and password.",
    );
  }

  // Events
  async alarm() {
    return this.execute("alarm");
  }

  // Lua
  async reloadLua(filename) {
    return this.execute(`reloadlua "${this.sanitize(filename)}"`);
  }

  // Logging
  async setLogLevel(type, level) {
    const safeType = this.sanitizeQuotedArg(type, "Log type", 32);
    const safeLevel = this.sanitizeQuotedArg(String(level), "Log level", 32);
    return this.execute(`log "${safeType}" "${safeLevel}"`);
  }

  // Statistics
  async setStats(mode, period = null) {
    const safeMode = this.sanitizeQuotedArg(mode, "Stats mode", 32);
    if (period !== null && period !== undefined && period !== "") {
      const n = Number(period);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error("period must be a non-negative number");
      }
      return this.execute(`stats "${safeMode}" ${n}`, {
        retryOnConnectionError: true,
      });
    }
    return this.execute(`stats "${safeMode}"`, {
      retryOnConnectionError: true,
    });
  }

  // Remove zombies
  async removeZombies() {
    return this.execute("removezombies");
  }

  // Safehouse
  async releaseSafehouse() {
    // ReleaseSafehouseCommand.class (real B42 dedicated server jar) calls
    // isCommandComeFromServerConsole() and refuses with "...can be executed
    // only from the game" for ANY console/RCON caller -- a hardcoded
    // rejection keyed on connection type, not a syntax issue this panel
    // could work around. Sending "releasesafehouse" here would always be
    // rejected by the real server, and execute()'s failure detection
    // doesn't recognise that rejection text, so it would report success
    // while doing nothing. Refuse up front instead of lying about it.
    throw new Error(
      "Releasing a safehouse can only be done from in-game -- Project Zomboid's server refuses this over RCON, even from an admin console.",
    );
  }

  // Test if connection is actually alive by sending a simple command
  async healthCheck() {
    if (!this.connected || !this.client) {
      return { healthy: false, reason: "Not connected" };
    }

    const healthClient = this.client;
    let timeoutId;
    try {
      // Use 'players' command as a lightweight health check (with timeout)
      await Promise.race([
        healthClient.execute("players"),
        new Promise((_, reject) =>
          (timeoutId = setTimeout(
            () => reject(new Error("Health check timed out")),
            10000,
          )),
        ),
      ]);
      if (this.client !== healthClient || !this.connected) {
        return { healthy: false, reason: "Connection changed" };
      }
      this.lastSuccessfulCommand = Date.now();
      return { healthy: true, lastCommand: this.lastSuccessfulCommand };
    } catch (error) {
      if (this.client !== healthClient) {
        return { healthy: false, reason: "Connection changed" };
      }
      // Connection is dead, mark as disconnected
      this.connected = false;
      this._cleanupClient(healthClient);
      log.warn(`health check failed: ${error.message}`);
      this.emit("disconnected");
      return { healthy: false, reason: error.message };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Status check
  isConnected() {
    return this.connected;
  }

  getConfig() {
    return {
      host: this.config.host,
      port: this.config.port,
      connected: this.connected,
      lastSuccessfulCommand: this.lastSuccessfulCommand,
      reconnectAttempts: this.reconnectAttempts,
      autoReconnectEnabled: !!this.autoReconnectInterval,
    };
  }

  async updateConfig(host, port, password) {
    this.config.host = host !== undefined ? host : this.config.host;
    this.config.port = port !== undefined ? port : this.config.port;
    this.config.password =
      password !== undefined ? password : this.config.password;

    // Reconnect with new config
    if (this.connected) {
      await this.disconnect();
    }
  }
}
