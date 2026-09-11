import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActivityType,
  PermissionFlagsBits,
  MessageFlags,
  escapeMarkdown,
} from "discord.js";
import fs from "fs";
import path from "path";
import { request as undiciRequest, Headers as UndiciHeaders } from "undici";
import { STATUS_CODES } from "http";
import { types } from "util";
import { createLogger } from "../utils/logger.js";
const log = createLogger("Discord");
import { getActiveServer, getSetting, setSetting } from "../database/init.js";
import { loadUiSecret, writeUiSecretFile } from "../utils/uiSecretFile.js";
import { sanitizeError } from "../utils/sanitize.js";
import { describeStartFailure } from "./discordStartFailure.js";
import { readIniValues } from "../utils/templateFiles.js";
import { runManagedLifecycle } from "./managedContainer.js";
import { resolveObservedServerRunning } from "../utils/serverStatus.js";
import {
  collectKnownSecretValues,
  redactKnownSecrets,
} from "../utils/discordMessageRedaction.js";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
} from "./lifecycleCoordinator.js";

// Workaround for undici 8.x + Node.js 22+/24+: undici adds Symbol(sensitiveHeaders)
// to response header objects, but the WebIDL ByteString converter in undici's
// Headers constructor throws on Symbol keys instead of skipping them (spec violation).
// Provide a custom makeRequest that filters Symbol-keyed header properties before
// constructing the Headers object.
async function _resolveDiscordBody(body) {
  if (body == null) return null;
  if (typeof body === "string") return body;
  if (types.isUint8Array(body)) return body;
  if (types.isArrayBuffer(body)) return new Uint8Array(body);
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof DataView) return new Uint8Array(body.buffer);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof FormData) return body;
  if (body[Symbol.iterator]) return Buffer.concat([...body]);
  if (body[Symbol.asyncIterator]) {
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  throw new TypeError("Unable to resolve body.");
}

// hunt-wave6-2026-08-29 follow-up 1: this is THE boundary every outbound
// Discord API call passes through -- channel.send(), interaction.reply()/
// editReply(), slash-command registration, everything -- because it's wired
// as the REST transport for the Client itself (see the `rest.makeRequest`
// option in start()) and for every other manually-created REST instance in
// this file. Redacting known secret VALUES here, rather than inside
// handleRcon() or any other individual sender, means the guard covers the
// success branch, the failure branch, and any future sender nobody has
// written yet -- see utils/discordMessageRedaction.js's header for the full
// reasoning (exact-value match, not a shape heuristic).
async function _safeDiscordMakeRequest(url, init) {
  let body = await _resolveDiscordBody(init.body);
  if (typeof body === "string" && body) {
    try {
      const secrets = await collectKnownSecretValues();
      body = redactKnownSecrets(body, secrets);
    } catch (err) {
      // Never let a secrets lookup failure block a send outright, but never
      // send the ORIGINAL unredacted body either if redaction couldn't run --
      // that would silently reopen exactly the leak this exists to close.
      log.error(`Discord outbound redaction check failed, blocking this send: ${err.message}`);
      throw err;
    }
  }
  const res = await undiciRequest(url, {
    ...init,
    body,
  });
  return {
    body: res.body,
    arrayBuffer: () => res.body.arrayBuffer(),
    json: () => res.body.json(),
    text: () => res.body.text(),
    get bodyUsed() {
      return res.body.bodyUsed;
    },
    // Object.entries() only yields string-keyed enumerable properties, filtering
    // out Symbol(sensitiveHeaders) and other Symbol keys that cause the TypeError.
    headers: new UndiciHeaders(Object.fromEntries(Object.entries(res.headers))),
    status: res.statusCode,
    statusText: STATUS_CODES[res.statusCode] ?? "",
    ok: res.statusCode >= 200 && res.statusCode < 300,
  };
}

async function _resolveDiscordApplicationId(token) {
  if (!token) return null;

  const response = await fetch("https://discord.com/api/v10/users/@me", {
    headers: {
      Authorization: `Bot ${token}`,
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Discord identity lookup failed (${response.status})`);
  }

  const user = await response.json();
  return typeof user?.id === "string" && user.id ? user.id : null;
}

// PZ chat channels that are public to every player on the server. Faction,
// safehouse, radio, admin and whisper channels are deliberately absent: they
// are private in game and must stay private in Discord.
const PUBLIC_CHAT_TYPES = new Set([
  "General",
  "Say",
  "Local",
  "Shout",
  "Server Alert",
  "Server chat",
]);
const NO_YELL_CHAT_TYPES = new Set(
  [...PUBLIC_CHAT_TYPES].filter((t) => t !== "Shout"),
);
const GENERAL_ONLY_CHAT_TYPES = new Set(["General"]);
const CHAT_RELAY_SCOPES = new Set(["public", "no-yell", "general"]);

export function normalizeChatRelayScope(value) {
  return CHAT_RELAY_SCOPES.has(value) ? value : "public";
}

export function allowedChatTypesForScope(scope) {
  if (scope === "general") return GENERAL_ONLY_CHAT_TYPES;
  if (scope === "no-yell") return NO_YELL_CHAT_TYPES;
  return PUBLIC_CHAT_TYPES;
}

// Default permission levels for each command
// 'everyone' = no role needed, 'moderator' = mod or admin role, 'admin' = admin role only
const DEFAULT_COMMAND_PERMISSIONS = {
  status: "everyone",
  players: "everyone",
  save: "moderator",
  broadcast: "moderator",
  kick: "moderator",
  start: "admin",
  stop: "admin",
  restart: "admin",
  rcon: "admin",
};

const LIFECYCLE_DEDUPE_WINDOW_MS = 60_000;
const PLAYER_PRESENCE_INTERVAL_MS = 60_000;
// How long a gateway reconnect must persist before getStatus() reports it —
// well above the ~2-3s a real RESUME took in
// server/tests/linuxDiscordGatewayResilience.test.js, so a routine blip
// self-heals silently and only a genuinely stuck reconnect (or a permanent
// shardDisconnect, which never clears on its own) reaches the operator.
const GATEWAY_DEGRADED_THRESHOLD_MS = 30_000;

// start()'s distinguishable return for "a DIFFERENT start() call is already
// in flight, this call was a no-op" (its _starting guard, re-entrancy sweep
// finding #1). Truthy like the plain `true` success return -- POST
// /discord/start's existing `if (started)` still reads it as success with
// no code change needed there, since the bot genuinely is (or is about to
// be) running either way -- but PUT /config's credential-change branch can
// tell it apart from a real reconnect it just performed itself, so it does
// not claim credit for a reconnect this request never attempted.
export const START_ALREADY_IN_PROGRESS = Symbol(
  "discord-start-already-in-progress",
);

export class DiscordBot {
  constructor(rconService, serverManager, scheduler, logTailer = null) {
    this.client = null;
    this.rconService = rconService;
    this.serverManager = serverManager;
    this.scheduler = scheduler;
    this.logTailer = logTailer;
    this.token = null;
    this.guildId = null;
    this.adminRoleId = null;
    this.modRoleId = null;
    this.channelId = null;
    this.isRunning = false;
    // Claimed synchronously at the top of start(), released in a finally --
    // see start()'s own comment for the double-start race this closes.
    this._starting = false;
    // Last start() failure, surfaced through routes/discord.js so a bad
    // token, disallowed privileged intents, and a network timeout stop
    // wearing the same "check configuration" message. Same pattern as
    // DockerClient.lastError.
    this.lastStartError = null;
    // Serializes PUT /config, /webhook-events, and /permissions (all three
    // read this singleton's current persisted config and write back a
    // merge) against each other -- re-entrancy sweep finding #5, same
    // promise-chain-mutex shape as AuthService._withMutex
    // (services/auth.js) and permissions.js's withRoleMutex. Without this,
    // two overlapping saves each read a not-yet-committed value and the
    // second write clobbers a field the first one just changed; it also
    // means PUT /config's own stop()+start() reconnect sequence runs to
    // completion before a second concurrent /config save can begin its
    // own, closing the specific compounding race with finding #1 (two
    // overlapping start() calls) that motivated start()'s _starting guard.
    this._configMutex = Promise.resolve();
    this.webhookEvents = {};
    this.commandPermissions = { ...DEFAULT_COMMAND_PERMISSIONS };
    this.chatRelayEnabled = true;
    this.chatRelayChannelId = null; // null = use main channelId
    this.chatRelayScope = "public"; // 'public' = all open channels, 'general' = General tab only
    this._presenceInterval = null;
    this._presenceUpdateInFlight = null;

    // Notification circuit breaker — avoids log/network spam when Discord
    // is unreachable (DNS failures, transient outages). After N consecutive
    // failures we open the circuit for COOLDOWN_MS and drop sends silently.
    // Tracked per channel: a chat relay pointed at a deleted channel must not
    // silence server notifications going to a perfectly healthy one.
    this._channelBreakers = new Map(); // channelId -> {failures, openUntil, suppressed}

    // hunt-wave6-2026-08-29 suspect 6: getStatus() used to have no field at
    // all for gateway health, so a real (self-healing) heartbeat black hole
    // or a permanent (unrecoverable) shard disconnect both left `running`
    // reporting true throughout — an operator watching the page saw a
    // healthy bot while alerting was actually down, the same gap already
    // fixed for panel update checks. Set on 'shardReconnecting' (any
    // recoverable close, including a zombie connection @discordjs/ws just
    // detected) and 'shardDisconnect' (unrecoverable — never coming back on
    // its own); cleared on 'shardResume' (session preserved) or 'shardReady'
    // (a fresh IDENTIFY succeeded). getStatus() debounces this against
    // GATEWAY_DEGRADED_THRESHOLD_MS before surfacing it — a routine RESUME
    // measured at ~2-3s in server/tests/linuxDiscordGatewayResilience.test.js
    // must not flip this on every blip, or the signal trains the operator to
    // ignore it, which is worse than no signal at all.
    this._gatewayDegradedSince = null;

    // Lifecycle dedupe — serverStart/serverStop webhooks can be triggered
    // from several paths (HTTP /start /stop /force-stop, Discord slash
    // commands, the status watchdog, RCON-disconnect detection). Track the
    // last fired state so duplicate observations within a short window only
    // send one webhook. A missed opposite transition must not suppress future
    // real lifecycle notifications forever.
    this._lastLifecycleState = null; // 'running' | 'stopped' | null
    this._lastLifecycleAt = 0;

    // Throttles the "game server unreachable" reply so a busy Discord channel
    // gets told once rather than once per message.
    this._bridgeOfflineNoticeAt = 0;

    // Serialise registerCommands() — it can be invoked from start() and
    // from updateCommandPermissions() at roughly the same time on a fresh
    // boot; without a lock the two REST.put() calls race and either set
    // can win, leaving Discord in an inconsistent state.
    this._registerInFlight = null;

    // Remember the last guildId we registered commands for so that
    // changing guilds via updateConfig() can clean up the OLD guild's
    // commands instead of leaving them ghosted forever.
    this._registeredGuildId = null;

    // Hold onto the chatMessage listener as a bound reference so we can
    // off() it during stop(). An inline arrow would be anonymous and leak.
    this._onGameChat = null;
    this._chatRelayChain = Promise.resolve();
    this._chatRelayPending = 0;
    this._chatRelayDropped = 0;

    // Setup Chat Bridge listener
    if (this.logTailer) {
      this._onGameChat = (data) => this._queueGameChat(data);
      this.logTailer.on("chatMessage", this._onGameChat);
    }
  }

  // Relay sends are chained so Discord shows messages in the order the game
  // logged them — parallel channel.send() calls routinely land out of order.
  // The queue is capped: if Discord is slower than the server's chat, dropping
  // is better than relaying an ever-growing backlog of stale messages.
  _queueGameChat(data) {
    const MAX_PENDING = 40;
    if (this._chatRelayPending >= MAX_PENDING) {
      this._chatRelayDropped++;
      if (this._chatRelayDropped % 25 === 1) {
        log.warn(
          `Chat relay is behind (${this._chatRelayPending} queued) — dropped ${this._chatRelayDropped} message(s) so far`,
        );
      }
      return;
    }
    this._chatRelayPending++;
    this._chatRelayChain = this._chatRelayChain
      .then(() => this.handleGameChat(data))
      .catch((e) => log.debug(`Game chat relay failed: ${e.message}`))
      .finally(() => {
        this._chatRelayPending--;
        if (this._chatRelayPending === 0 && this._chatRelayDropped > 0) {
          log.info(
            `Chat relay caught up — ${this._chatRelayDropped} message(s) were dropped while behind`,
          );
          this._chatRelayDropped = 0;
        }
      });
  }

  async handleGameChat(data) {
    if (!this.chatRelayEnabled || !this.isRunning || !this.client) return;

    // B42 records ordinary talking as Say/Local and Q shouts as Shout, so
    // filtering down to the General tab silences almost every real message.
    const allowed = allowedChatTypesForScope(this.chatRelayScope);
    if (data?.sourceChatType) {
      if (!allowed.has(data.sourceChatType)) return;
    } else if (this.chatRelayScope === "general") {
      if (data?.type !== "general") return;
    } else if (data?.type !== "general" && data?.type !== "server") {
      return;
    }

    // Discord messages reach PZ through RCON as "[Discord] user: message".
    // The server logs that broadcast as chat, so relaying it back would create
    // an immediate duplicate in the originating Discord channel.
    if (String(data?.message || "").startsWith("[Discord] ")) return;

    // The scheduler's restart countdown ticks as often as once a second near
    // the end — those are aimed at players in game and would flood the relay.
    // The restart's actual outcome (it's happening now, or it was called off)
    // is exactly what players watching Discord expect to see, so those two
    // are let through instead of being silently swallowed with the rest.
    const serverMsg = String(data?.message || "");
    if (data?.type === "server" && serverMsg.startsWith("[SERVER] ")) {
      const isOutcome =
        serverMsg.includes("RESTARTING NOW") || serverMsg.includes("CANCELLED");
      if (!isOutcome) return;
    }

    // Use dedicated chat relay channel if set, otherwise fall back to main channel
    const targetChannelId = this.chatRelayChannelId || this.channelId;
    if (!targetChannelId) return;
    log.debug(
      `Relaying game chat from ${data?.author || "unknown"} to Discord`,
    );

    // maskedLink is off by default, and it is the one that turns a player's
    // chat line into a clickable link pointing anywhere.
    const cleanMessage = escapeMarkdown(
      String(data.message || "")
        .replace(/@everyone/g, "(everyone)")
        .replace(/@here/g, "(here)")
        .slice(0, 1850),
      { maskedLink: true },
    );
    const cleanAuthor = escapeMarkdown(
      String(data.author || "unknown")
        .replace(/[\r\n]+/g, " ")
        .slice(0, 80),
      { maskedLink: true },
    );
    await this._sendToChannel(
      targetChannelId,
      `**<${cleanAuthor}>** ${cleanMessage}`,
      { label: "game chat relay" },
    );
  }

  // Run a critical section serialized against other config-mutex holders.
  // Same shape as AuthService._withMutex (services/auth.js).
  withConfigMutex(fn) {
    const run = this._configMutex.then(fn, fn);
    this._configMutex = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async loadConfig() {
    log.info("Loading Discord bot config...");
    // discordBotToken lives in its own file now, not db.json — see
    // utils/uiSecretFile.js. legacyValue migrates a pre-upgrade value
    // verbatim on first load; every restart after that reads the file.
    this.token = await loadUiSecret("discordBotToken", {
      legacyValue: await getSetting("discordBotToken"),
      clearLegacy: () => setSetting("discordBotToken", null),
      log,
    });
    this.guildId = await getSetting("discordGuildId");
    this.adminRoleId = await getSetting("discordAdminRoleId");
    this.modRoleId = await getSetting("discordModRoleId");
    this.channelId = await getSetting("discordChannelId");

    // Load command permissions
    const savedPerms = await getSetting("discordCommandPermissions");
    if (savedPerms) {
      try {
        const parsed =
          typeof savedPerms === "string" ? JSON.parse(savedPerms) : savedPerms;
        this.commandPermissions = { ...DEFAULT_COMMAND_PERMISSIONS, ...parsed };
      } catch (e) {
        this.commandPermissions = { ...DEFAULT_COMMAND_PERMISSIONS };
      }
    }

    // Load chat relay settings
    const chatRelayEnabled = await getSetting("discordChatRelayEnabled");
    this.chatRelayEnabled = chatRelayEnabled !== false; // default true
    this.chatRelayChannelId =
      (await getSetting("discordChatRelayChannelId")) || null;
    this.chatRelayScope = normalizeChatRelayScope(
      await getSetting("discordChatRelayScope"),
    );

    // Load webhook events
    const savedEvents = await getSetting("discordWebhookEvents");
    this.webhookEvents = {};
    if (savedEvents) {
      try {
        const parsed =
          typeof savedEvents === "string"
            ? JSON.parse(savedEvents)
            : savedEvents;
        // Guard against `null` (valid JSON) and non-object payloads — otherwise
        // `this.webhookEvents[eventType]` later would throw a TypeError.
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          this.webhookEvents = parsed;
        }
      } catch (e) {
        log.warn(`Failed to parse saved webhookEvents: ${e.message}`);
      }
    }
  }

  async saveWebhookEvents(events) {
    this.webhookEvents = events;
    await setSetting("discordWebhookEvents", JSON.stringify(events));
  }

  async sendEventNotification(eventType, variables = {}) {
    if (!this.isRunning || !this.channelId) return;

    // Dedupe lifecycle transitions — these events can fire from multiple
    // code paths for the same real state change (HTTP route + watchdog +
    // RCON-disconnect handler all observe the same stop, etc.).
    const isLifecycle =
      eventType === "serverStart" || eventType === "serverStop";
    let newState = null;
    if (isLifecycle) {
      newState = eventType === "serverStart" ? "running" : "stopped";
      if (
        this._lastLifecycleState === newState &&
        Date.now() - this._lastLifecycleAt < LIFECYCLE_DEDUPE_WINDOW_MS
      ) {
        return; // already notified for this transition
      }
    }

    const event = this.webhookEvents[eventType];
    if (!event || !event.enabled || typeof event.template !== "string") {
      // Update dedupe state even when the event is disabled — otherwise
      // enabling the event later would replay the historical transition.
      if (isLifecycle) {
        this._lastLifecycleState = newState;
        this._lastLifecycleAt = Date.now();
      }
      return;
    }

    // Single-pass substitution: builds one regex over all known variable
    // names and uses a callback so that:
    //   - values containing $1, $&, etc. are NOT interpreted as regex backrefs
    //   - replacement order doesn't matter (no risk of {player} clobbering
    //     the start of {playerCount})
    //   - undefined/null/object values render as empty string
    let message = event.template;
    const keys = Object.keys(variables || {});
    if (keys.length > 0) {
      const escaped = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const re = new RegExp(`\\{(${escaped.join("|")})\\}`, "g");
      message = message.replace(re, (_, k) => {
        const v = variables[k];
        if (v === undefined || v === null) return "";
        return typeof v === "string" ? v : String(v);
      });
    }

    // Prevent @everyone / @here Discord pings triggered by player-supplied variable values
    message = message
      .replace(/@everyone/g, "(everyone)")
      .replace(/@here/g, "(here)")
      .slice(0, 1900);

    // A template that renders to nothing would be rejected by Discord and
    // counted as a channel failure, eventually suppressing every notification.
    if (!message.trim()) {
      log.warn(`Skipping ${eventType} notification: template rendered empty`);
      if (isLifecycle) {
        this._lastLifecycleState = newState;
        this._lastLifecycleAt = Date.now();
      }
      return;
    }

    const sent = await this.sendNotification(message);
    // Only commit lifecycle dedupe state on a successful send. If the send
    // failed (circuit open, missing perms, channel deleted), keep the old
    // state so the next attempt isn't suppressed.
    if (isLifecycle && sent) {
      this._lastLifecycleState = newState;
      this._lastLifecycleAt = Date.now();
    }
  }

  async updateConfig(token, guildId, adminRoleId, channelId, modRoleId) {
    writeUiSecretFile("discordBotToken", token);
    await setSetting("discordGuildId", guildId);
    // adminRoleId normalized the same way modRoleId already is, both here
    // and below -- without this, this.adminRoleId was stored RAW forever
    // (never normalized, not even after this same function ran once), so
    // once an empty adminRoleId had ever been saved, rolesChanged compared
    // "" !== null on every subsequent unrelated config save and spuriously
    // re-registered Discord slash commands every time.
    await setSetting("discordAdminRoleId", adminRoleId || "");
    await setSetting("discordModRoleId", modRoleId || "");
    await setSetting("discordChannelId", channelId || "");

    const previousGuildId = this.guildId;
    const rolesChanged =
      this.adminRoleId !== (adminRoleId || null) ||
      this.modRoleId !== (modRoleId || null);
    this.token = token;
    this.guildId = guildId;
    this.adminRoleId = adminRoleId || null;
    this.modRoleId = modRoleId || null;
    this.channelId = channelId;

    // If we changed guilds and the bot is currently running, clean up the
    // old guild's command list — otherwise the old guild keeps showing
    // ghost slash commands forever.
    if (
      this.isRunning &&
      this.client?.user &&
      previousGuildId &&
      previousGuildId !== guildId
    ) {
      try {
        const rest = new REST({
          version: "10",
          makeRequest: _safeDiscordMakeRequest,
        }).setToken(this.token);
        await rest.put(
          Routes.applicationGuildCommands(this.client.user.id, previousGuildId),
          { body: [] },
        );
        log.info(
          `Cleared slash commands from previous guild ${previousGuildId}`,
        );
      } catch (e) {
        log.warn(
          `Failed to clear commands from previous guild ${previousGuildId}: ${e.message}`,
        );
      }
      this._registeredGuildId = null;
    }

    // Command visibility depends on which roles are configured, so a role
    // change has to be pushed back to Discord.
    if (rolesChanged && this.isRunning && this.client?.user) {
      try {
        await this.registerCommands();
      } catch (e) {
        log.warn(`Failed to re-register commands after role change: ${e.message}`);
      }
    }
  }

  async updateChatRelay(enabled, channelId, scope) {
    this.chatRelayEnabled = enabled;
    this.chatRelayChannelId = channelId || null;
    this.chatRelayScope = normalizeChatRelayScope(scope);
    await setSetting("discordChatRelayEnabled", enabled);
    await setSetting("discordChatRelayChannelId", channelId || "");
    await setSetting("discordChatRelayScope", this.chatRelayScope);
  }

  async resetConfig() {
    const token = this.token;
    const guildId = this.guildId;

    if (token && guildId) {
      try {
        const applicationId =
          this.client?.user?.id || (await _resolveDiscordApplicationId(token));

        if (applicationId) {
          const rest = new REST({
            version: "10",
            makeRequest: _safeDiscordMakeRequest,
          }).setToken(token);
          await rest.put(
            Routes.applicationGuildCommands(applicationId, guildId),
            { body: [] },
          );
          log.info(`Cleared slash commands from guild ${guildId}`);
        }
      } catch (error) {
        log.warn(
          `Failed to clear slash commands during Discord reset: ${error.message}`,
        );
      }
    }

    if (this.isRunning) {
      await this.stop();
    }

    writeUiSecretFile("discordBotToken", "");
    await setSetting("discordGuildId", "");
    await setSetting("discordAdminRoleId", "");
    await setSetting("discordModRoleId", "");
    await setSetting("discordChannelId", "");
    await setSetting("discordAutoStart", true);
    await setSetting("discordChatRelayEnabled", true);
    await setSetting("discordChatRelayChannelId", "");
    await setSetting("discordChatRelayScope", "public");
    await setSetting(
      "discordCommandPermissions",
      JSON.stringify(DEFAULT_COMMAND_PERMISSIONS),
    );
    await setSetting("discordWebhookEvents", JSON.stringify({}));

    this.token = null;
    this.guildId = null;
    this.adminRoleId = null;
    this.modRoleId = null;
    this.channelId = null;
    this.webhookEvents = {};
    this.commandPermissions = { ...DEFAULT_COMMAND_PERMISSIONS };
    this.chatRelayEnabled = true;
    this.chatRelayChannelId = null;
    this.chatRelayScope = "public";
    this._registeredGuildId = null;
    this._channelBreakers.clear();
    this._lastLifecycleState = null;
    this._lastLifecycleAt = 0;
  }

  async updateCommandPermissions(permissions) {
    // Validate: only allow known commands and valid levels
    const validLevels = ["everyone", "moderator", "admin"];
    const validCommands = Object.keys(DEFAULT_COMMAND_PERMISSIONS);
    const cleaned = {};
    for (const [cmd, level] of Object.entries(permissions)) {
      if (validCommands.includes(cmd) && validLevels.includes(level)) {
        cleaned[cmd] = level;
      }
    }
    this.commandPermissions = { ...DEFAULT_COMMAND_PERMISSIONS, ...cleaned };
    await setSetting(
      "discordCommandPermissions",
      JSON.stringify(this.commandPermissions),
    );

    // Re-register commands to update Discord-side default permissions
    if (this.isRunning && this.client?.user) {
      await this.registerCommands();
    }
    return this.commandPermissions;
  }

  getCommandPermissions() {
    return { ...this.commandPermissions };
  }

  getCommands() {
    const commands = [
      {
        builder: new SlashCommandBuilder()
          .setName("status")
          .setDescription("Get the current server status"),
        name: "status",
      },
      {
        builder: new SlashCommandBuilder()
          .setName("players")
          .setDescription("List online players"),
        name: "players",
      },
      {
        builder: new SlashCommandBuilder()
          .setName("start")
          .setDescription("Start the Project Zomboid server"),
        name: "start",
      },
      {
        builder: new SlashCommandBuilder()
          .setName("stop")
          .setDescription("Stop the server (with save)"),
        name: "stop",
      },
      {
        builder: new SlashCommandBuilder()
          .setName("restart")
          .setDescription("Restart the server with warning")
          .addIntegerOption((option) =>
            option
              .setName("minutes")
              .setDescription("Warning time in minutes before restart")
              .setRequired(false)
              .setMinValue(0)
              .setMaxValue(30),
          ),
        name: "restart",
      },
      {
        builder: new SlashCommandBuilder()
          .setName("save")
          .setDescription("Save the world"),
        name: "save",
      },
      {
        builder: new SlashCommandBuilder()
          .setName("broadcast")
          .setDescription("Send a message to all players")
          .addStringOption((option) =>
            option
              .setName("message")
              .setDescription("Message to broadcast")
              .setRequired(true),
          ),
        name: "broadcast",
      },
      {
        builder: new SlashCommandBuilder()
          .setName("kick")
          .setDescription("Kick a player from the server")
          .addStringOption((option) =>
            option
              .setName("player")
              .setDescription("Player name to kick")
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("reason")
              .setDescription("Reason for kick")
              .setRequired(false),
          ),
        name: "kick",
      },
      {
        builder: new SlashCommandBuilder()
          .setName("rcon")
          .setDescription("Execute a custom RCON command")
          .addStringOption((option) =>
            option
              .setName("command")
              .setDescription("RCON command to execute")
              .setRequired(true),
          ),
        name: "rcon",
      },
    ];

    // Discord-side defaults are only a fallback for when no role is configured
    // here. Setting them unconditionally hid the command from the very roles the
    // panel was told to trust, so the Admin/Moderator role settings did nothing
    // unless the role also held Discord's Administrator permission. When a role
    // is configured we leave the command visible and let checkPermission() answer,
    // which replies with a clear refusal instead of hiding the command.
    for (const cmd of commands) {
      const level = this.commandPermissions[cmd.name] || "admin";
      if (level === "admin" && !this.adminRoleId) {
        cmd.builder.setDefaultMemberPermissions(
          PermissionFlagsBits.Administrator,
        );
      } else if (level === "moderator" && !this.modRoleId && !this.adminRoleId) {
        cmd.builder.setDefaultMemberPermissions(
          PermissionFlagsBits.ManageMessages,
        );
      }
      // 'everyone' = no restriction set
    }

    return commands.map((c) => c.builder);
  }

  async registerCommands() {
    if (!this.token || !this.guildId) {
      throw new Error("Discord token and guild ID are required");
    }

    if (!this.client || !this.client.user) {
      throw new Error("Discord client not ready");
    }

    // Serialise concurrent registrations — a fresh boot can hit this via
    // both start() and updateCommandPermissions() within the same tick.
    if (this._registerInFlight) {
      return this._registerInFlight;
    }

    const targetGuildId = this.guildId;
    const targetUserId = this.client.user.id;
    const rest = new REST({
      version: "10",
      makeRequest: _safeDiscordMakeRequest,
    }).setToken(this.token);
    const commands = this.getCommands().map((cmd) => cmd.toJSON());

    this._registerInFlight = (async () => {
      try {
        log.info("Registering Discord slash commands...");
        await rest.put(
          Routes.applicationGuildCommands(targetUserId, targetGuildId),
          { body: commands },
        );
        this._registeredGuildId = targetGuildId;
        log.info(`Registered ${commands.length} Discord commands`);
      } catch (error) {
        log.error(
          `Failed to register Discord commands: ${error.stack || error.message}`,
        );
        throw error;
      } finally {
        this._registerInFlight = null;
      }
    })();

    return this._registerInFlight;
  }

  hasRole(interaction, roleId) {
    if (!roleId) return false;
    const member = interaction.member;
    if (!member) return false;
    if (member.roles && member.roles.cache) {
      return member.roles.cache.has(roleId);
    }
    // Uncached guilds hand back the raw API member, whose roles are a plain
    // array of IDs. Without this a moderator is silently denied.
    if (Array.isArray(member.roles)) {
      return member.roles.includes(roleId);
    }
    return false;
  }

  checkPermission(interaction, commandName) {
    const level = this.commandPermissions[commandName] || "admin";

    if (level === "everyone") return true;

    // Server owner always has full access
    if (interaction.guild && interaction.guild.ownerId === interaction.user.id)
      return true;

    // Discord Administrator permission holders can use everything
    if (
      interaction.member &&
      typeof interaction.member.permissions?.has === "function" &&
      interaction.member.permissions.has(PermissionFlagsBits.Administrator)
    )
      return true;

    // Admin role holders can use everything
    if (this.adminRoleId && this.hasRole(interaction, this.adminRoleId))
      return true;

    if (level === "moderator") {
      // Moderator commands: need mod role or admin role
      if (!this.modRoleId && !this.adminRoleId) return false;
      if (this.modRoleId && this.hasRole(interaction, this.modRoleId))
        return true;
      return false;
    }

    if (level === "admin") {
      // Admin commands: need admin role
      if (!this.adminRoleId) return false;
      return false; // Already checked above
    }

    return false;
  }

  async handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    log.info(
      `Discord command: /${commandName} by ${interaction.user?.tag || "unknown"}`,
    );

    // Check permission based on command's configured tier
    if (!this.checkPermission(interaction, commandName)) {
      const level = this.commandPermissions[commandName] || "admin";
      const roleName = level === "admin" ? "Admin" : "Moderator";
      await interaction.reply({
        content: `❌ You need the **${roleName}** role to use this command.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      switch (commandName) {
        case "status":
          await this.handleStatus(interaction);
          break;
        case "players":
          await this.handlePlayers(interaction);
          break;
        case "start":
          await this.handleStart(interaction);
          break;
        case "stop":
          await this.handleStop(interaction);
          break;
        case "restart":
          await this.handleRestart(interaction);
          break;
        case "save":
          await this.handleSave(interaction);
          break;
        case "broadcast":
          await this.handleBroadcast(interaction);
          break;
        case "kick":
          await this.handleKick(interaction);
          break;
        case "rcon":
          await this.handleRcon(interaction);
          break;
        default:
          await interaction.reply({
            content: "Unknown command",
            flags: MessageFlags.Ephemeral,
          });
      }
    } catch (error) {
      log.error(`command error: ${error.stack || error.message}`);
      try {
        const content = `❌ Error: ${sanitizeError(error.message)}`;
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({
            content,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
      } catch (replyError) {
        log.error(
          `Failed to send error reply: ${replyError.stack || replyError.message}`,
        );
      }
    }
  }

  async handleStatus(interaction) {
    await interaction.deferReply();

    // getServerStatus() is still the source for uptime/etc, but its OWN
    // .running/.scanFailed come from the local process scan alone -- wrong
    // for a split-container/docker-managed setup where PZ is genuinely up
    // but not locally visible (GH#114). resolveObservedServerRunning() is
    // the same OR-of-every-signal verdict the dashboard badge and the
    // status watchdog use, so this can't disagree with either of them.
    const status = await this.serverManager.getServerStatus();
    const observedRunning = await resolveObservedServerRunning(
      this.serverManager,
      this.rconService,
    );
    const isRunning = observedRunning === true;
    const statusUnknown = observedRunning === null;

    // Format uptime from seconds
    let uptimeStr = "N/A";
    if (status.uptime && status.uptime > 0) {
      const hours = Math.floor(status.uptime / 3600);
      const minutes = Math.floor((status.uptime % 3600) / 60);
      uptimeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    }

    const embed = new EmbedBuilder()
      .setTitle("🧟 Project Zomboid Server Status")
      .setColor(statusUnknown ? 0xffaa00 : isRunning ? 0x00ff00 : 0xff0000)
      .addFields(
        {
          name: "Status",
          value: statusUnknown
            ? "🟡 Unknown (detection failed)"
            : isRunning
              ? "🟢 Online"
              : "🔴 Offline",
          inline: true,
        },
        { name: "Uptime", value: uptimeStr, inline: true },
      )
      .setTimestamp();

    if (isRunning) {
      try {
        const players = await this.rconService.getPlayers();
        if (players.success) {
          embed.addFields({
            name: "Players Online",
            value: `${players.players?.length || 0}`,
            inline: true,
          });
        }
      } catch (e) {
        log.debug(`Discord status: RCON error for player count: ${e.message}`);
      }
    }

    await interaction.editReply({ embeds: [embed] });
  }

  async handlePlayers(interaction) {
    await interaction.deferReply();

    // See handleStatus()'s comment: the raw local scan alone can't see a
    // split-container/docker-managed server, so this asks the same
    // OR-every-signal question the dashboard badge and watchdog do.
    const observedRunning = await resolveObservedServerRunning(
      this.serverManager,
      this.rconService,
    );
    if (observedRunning === null) {
      await interaction.editReply(
        "🟡 Unable to verify server status — try again shortly.",
      );
      return;
    }
    if (!observedRunning) {
      await interaction.editReply("🔴 Server is offline");
      return;
    }

    if (!this.rconService?.connected) {
      await interaction.editReply(
        "❌ RCON is not connected — cannot list players.",
      );
      return;
    }

    const result = await this.rconService.getPlayers();

    if (!result.success) {
      await interaction.editReply(
        `❌ Failed to get players: ${sanitizeError(result.error)}`,
      );
      return;
    }

    const players = result.players || [];

    // Discord embed description is hard-capped at 4096 chars. Build the
    // list incrementally and stop just shy of the cap, appending a
    // truncation footer instead of crashing the editReply call.
    const MAX_DESC = 4000; // leave room for the truncation suffix
    let description;
    if (players.length === 0) {
      description = "No players online";
    } else {
      const lines = [];
      let total = 0;
      let truncated = 0;
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        const line = `• ${escapeMarkdown(String(typeof p === "object" ? (p.name ?? "") : p))}`;
        if (total + line.length + 1 > MAX_DESC) {
          truncated = players.length - i;
          break;
        }
        lines.push(line);
        total += line.length + 1;
      }
      if (truncated > 0) lines.push(`… and ${truncated} more`);
      description = lines.join("\n");
    }

    const embed = new EmbedBuilder()
      .setTitle("👥 Online Players")
      .setColor(0x3498db)
      .setDescription(description)
      .setFooter({ text: `${players.length} player(s)` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }

  async handleStart(interaction) {
    await interaction.deferReply();
    // Fetched before acquiring the lock (a pure DB read) so a refusal from
    // a concurrent operation can name which server it's for -- see
    // lifecycleCoordinator.js's comment.
    const activeServerForLock = await getActiveServer();
    const lifecycleLock = acquireLifecycleLock(
      "discord-start",
      activeServerForLock?.id ?? null,
    );
    if (!lifecycleLock) {
      await interaction.editReply(lifecycleInProgressResponse().error);
      return;
    }

    try {
      const activeServer = activeServerForLock;
      // Use the shared provider-aware verdict so split-container servers do
      // not look stopped merely because their process is outside this host.
      const observedRunning = await resolveObservedServerRunning(
        this.serverManager,
        this.rconService,
      );
      if (observedRunning === null) {
        await interaction.editReply(
          "⚠️ Unable to verify whether the server is already running — refusing to start to avoid launching a second process. Check the panel UI directly.",
        );
        return;
      }
      if (observedRunning) {
        await interaction.editReply("⚠️ Server is already running");
        return;
      }

      // A container-managed server starts through Docker — the panel has no
      // process to spawn inside another container.
      const managed = await runManagedLifecycle("start", {
        serverId: activeServer?.id ?? null,
      });
      const started = managed.handled
        ? managed
        : await this.serverManager.startServer({
            serverId: activeServer?.id ?? null,
          });
      if (!started?.success) {
        await interaction.editReply(
          `❌ Failed to start the server: ${sanitizeError(started?.error || started?.message)}`,
        );
        return;
      }
      await interaction.editReply(
        started.alreadyRunning ? "✅ Server is already running" : "🚀 Server is starting...",
      );
      if (started.alreadyRunning) return;

      // Send notification to channel
      const safeTag = escapeMarkdown(String(interaction.user.tag));
      await this.sendNotification(`🚀 **Server started** by ${safeTag}`);
    } finally {
      lifecycleLock.release();
    }
  }

  async handleStop(interaction) {
    await interaction.deferReply();
    // See handleStart's comment above for why this is fetched before the lock.
    const activeServerForLock = await getActiveServer();
    const lifecycleLock = acquireLifecycleLock(
      "discord-stop",
      activeServerForLock?.id ?? null,
    );
    if (!lifecycleLock) {
      await interaction.editReply(lifecycleInProgressResponse().error);
      return;
    }
    try {
      const activeServer = activeServerForLock;
      const observedRunning = await resolveObservedServerRunning(
        this.serverManager,
        this.rconService,
      );
      if (observedRunning === null) {
        await interaction.editReply(
          "⚠️ Unable to verify whether the server is running. Check the panel UI directly before retrying.",
        );
        return;
      }
      if (!observedRunning) {
        await interaction.editReply("⚠️ Server is not running");
        return;
      }

      if (!this.rconService?.connected) {
        await interaction.editReply(
          "❌ RCON is not connected — cannot gracefully stop the server. Use the panel UI to force-stop if needed.",
        );
        return;
      }

      // Quitting after a failed save would discard everything since the last one.
      const saved = await this.rconService.save();
      if (!saved?.success) {
        await interaction.editReply(
          `❌ Save failed, so the server was left running: ${sanitizeError(saved?.error)}`,
        );
        return;
      }
      // A container-managed server must go down through Docker: RCON quit kills
      // PID 1, the container exits, and its restart policy brings the world back.
      const managed = await runManagedLifecycle("stop", {
        serverId: activeServer?.id ?? null,
      });
      const quit = managed.handled
        ? managed
        : await this.rconService.quit();
      if (!quit?.success) {
        await interaction.editReply(
          `❌ The world was saved, but the shutdown command failed: ${sanitizeError(quit?.error)}`,
        );
        return;
      }

      await interaction.editReply("🛑 Server is stopping...");
      const safeTag = escapeMarkdown(String(interaction.user.tag));
      await this.sendNotification(`🛑 **Server stopped** by ${safeTag}`);
    } finally {
      lifecycleLock.release();
    }
  }

  async handleRestart(interaction) {
    await interaction.deferReply();
    // See handleStart's comment above for why this is fetched before the
    // lock -- this.serverManager?.serverName was a display name (or a stale
    // one, if serverManager hadn't loaded any config yet), not the server DB
    // id normalize-lifecycle-lock-server-identifier standardized on.
    const activeServerForLock = await getActiveServer();
    const lifecycleLock = acquireLifecycleLock(
      "discord-restart",
      activeServerForLock?.id ?? null,
    );
    if (!lifecycleLock) {
      await interaction.editReply(lifecycleInProgressResponse().error);
      return;
    }

    try {
      const minutes = interaction.options.getInteger("minutes") ?? 5;

      // See handleStart()'s comment: the raw local scan alone can't see a
      // split-container/docker-managed server.
      const observedRunning = await resolveObservedServerRunning(
        this.serverManager,
        this.rconService,
      );
      if (observedRunning === null) {
        await interaction.editReply(
          "⚠️ Unable to verify whether the server is running. Check the panel UI directly before retrying.",
        );
        return;
      }
      if (!observedRunning) {
        await interaction.editReply(
          "⚠️ Server is not running. Use /start to start the server.",
        );
        return;
      }

      if (!this.rconService?.connected) {
        await interaction.editReply(
          "❌ RCON is not connected — cannot send the restart warning. Try again once RCON reconnects.",
        );
        return;
      }

      // The scheduler opens its own countdown with the same warning, so an
      // extra notice here only doubles it in game — and unlike the scheduler's
      // it lacks the [SERVER] prefix, so it leaks back into the chat relay.
      await interaction.editReply(
        `🔄 Server restart initiated (${minutes} min warning)`,
      );
      const safeTag = escapeMarkdown(String(interaction.user.tag));
      await this.sendNotification(
        `🔄 **Server restart** initiated by ${safeTag}`,
      );

      // Use scheduler for proper restart with the specified warning time
      try {
        // performRestart reports refusal and failure by return value rather than
        // by throwing, so without this the command always claims it worked.
        const result = await this.scheduler.performRestart(minutes, {
          lifecycleLock,
        });
        if (!result?.success) {
          await this._reportRestartOutcome(
            interaction,
            `❌ Restart did not complete: ${sanitizeError(result?.message || "unknown error")}`,
          );
        }
      } catch (error) {
        log.error(`restart failed: ${error.message}`);
        await this._reportRestartOutcome(
          interaction,
          `❌ Server restart failed: ${sanitizeError(error.message)}`,
        );
      }
    } finally {
      lifecycleLock.release();
    }
  }

  // A long warning can outlive the 15-minute interaction token, so fall back
  // to the notification channel rather than losing the outcome entirely.
  async _reportRestartOutcome(interaction, text) {
    try {
      await interaction.editReply(text);
    } catch {
      await this.sendNotification(text);
    }
  }

  async handleSave(interaction) {
    await interaction.deferReply();

    if (!this.rconService?.connected) {
      await interaction.editReply("❌ RCON is not connected — cannot save.");
      return;
    }

    const result = await this.rconService.save();

    if (result.success) {
      await interaction.editReply("💾 World saved successfully");
    } else {
      await interaction.editReply(
        `❌ Save failed: ${sanitizeError(result.error)}`,
      );
    }
  }

  async handleBroadcast(interaction) {
    const message = interaction.options.getString("message");

    await interaction.deferReply();

    if (!this.rconService?.connected) {
      await interaction.editReply(
        "❌ RCON is not connected — cannot broadcast.",
      );
      return;
    }

    // Cap at 200 chars — PZ chat UI gets cluttered with very long messages
    // and overlong RCON payloads can stall the server briefly.
    const safeMessage = String(message)
      .replace(/[\r\n]+/g, " ")
      .slice(0, 200);

    const result = await this.rconService.serverMessage(safeMessage);

    if (result.success) {
      await interaction.editReply(
        `📢 Broadcast sent: "${escapeMarkdown(safeMessage)}"`,
      );
    } else {
      await interaction.editReply(
        `❌ Broadcast failed: ${sanitizeError(result.error)}`,
      );
    }
  }

  async handleKick(interaction) {
    const player = interaction.options.getString("player");
    const reason = interaction.options.getString("reason") || "No reason given";

    await interaction.deferReply();

    if (!this.rconService?.connected) {
      await interaction.editReply("❌ RCON is not connected — cannot kick.");
      return;
    }

    // Sanitize inputs to prevent command injection
    const safePlayer = this.rconService.sanitize(player);
    if (!safePlayer) {
      await interaction.editReply("❌ Invalid player name.");
      return;
    }
    // Project Zomboid RCON only supports 'kickuser' and no reason flag
    const result = await this.rconService.execute(`kickuser "${safePlayer}"`);

    if (result.success) {
      const safeName = escapeMarkdown(String(player));
      const safeTag = escapeMarkdown(String(interaction.user.tag));
      const safeReason = escapeMarkdown(String(reason));
      await interaction.editReply(`👢 Kicked ${safeName}: ${safeReason}`);
      await this.sendNotification(
        `👢 **${safeName}** was kicked by ${safeTag}\nReason: ${safeReason}`,
      );
    } else {
      await interaction.editReply(
        `❌ Kick failed: ${sanitizeError(result.error)}`,
      );
    }
  }

  async handleRcon(interaction) {
    const command = interaction.options.getString("command");

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!this.rconService?.connected) {
      await interaction.editReply("❌ RCON is not connected.");
      return;
    }

    // Cap RCON commands at 500 chars — anything longer is almost certainly
    // accidental (copy-paste) and risks tripping RCON packet limits.
    const trimmed = String(command).slice(0, 500);
    const safeCommand = this.rconService.sanitize(trimmed);
    if (!safeCommand) {
      await interaction.editReply("❌ Empty or invalid command.");
      return;
    }
    const result = await this.rconService.execute(safeCommand);

    // Discord message bodies cap at 2000 chars; trim response to keep room
    // for the code-fence wrapper. Strip ``` from the response — leaving them
    // in would break the surrounding triple-backtick code fence.
    const rawResponse = String(result.response || "No response")
      .replace(/`{3,}/g, "\u02cb\u02cb\u02cb")
      .slice(0, 1800);
    const response = result.success
      ? `✅ **Response:**\n\`\`\`${rawResponse}\`\`\``
      : `❌ **Error:** ${sanitizeError(result.error)}`;

    await interaction.editReply(response);
  }

  async sendNotification(message) {
    if (!this.channelId || !this.client) return false;
    log.info(
      `Sending Discord notification: ${String(message).substring(0, 80)}`,
    );
    return await this._sendToChannel(this.channelId, message, {
      label: "notification",
    });
  }

  // Centralized channel send with circuit-breaker. All Discord-bound message
  // sends (notifications, webhook events, chat relay) should go through here
  // so a Discord outage doesn't spam logs from multiple code paths.
  async _sendToChannel(channelId, message, { label = "message" } = {}) {
    if (!channelId || !this.client) return false;

    const FAILURE_THRESHOLD = 3;
    const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
    // @discordjs/rest retries a 429 indefinitely with NO attempt cap: its
    // runRequest() re-recurses on every 429 response without ever
    // incrementing the same `retries` counter a non-429 failure uses (that
    // path IS capped, at options.retries = 3). Confirmed empirically against
    // a real (mocked) Discord API that returns 429 on every attempt:
    // channel.send() sat unresolved past 60s with nothing logged, because
    // the catch block below — and the circuit breaker it drives — is never
    // reached while the promise never settles. A sustained rate limit is a
    // real scenario (global rate limit, temporary token flag), and without
    // this bound it silently wedges every future send the same way, forever
    // — the exact "reports nothing, reaches nobody" shape this bot exists to
    // avoid. This does not change discord.js's own retry behavior; it only
    // stops US from waiting on it past a sane ceiling so the breaker can do
    // its job. See server/tests/linuxDiscordSendTimeout.test.js.
    const SEND_TIMEOUT_MS = 30 * 1000;
    const now = Date.now();
    const breaker = this._breakerFor(channelId);

    if (now < breaker.openUntil) {
      breaker.suppressed++;
      return false;
    }

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased?.() || typeof channel.send !== "function") {
        throw new Error("Configured channel is not a sendable text channel");
      }
      const sendPromise = channel.send(message);
      // If the timeout wins the race, the original send is still pending
      // somewhere inside discord.js's retry loop — swallow whatever it
      // eventually does so it can't surface as an unhandled rejection long
      // after we've stopped waiting on it.
      sendPromise.catch(() => {});
      await Promise.race([
        sendPromise,
        new Promise((_resolve, reject) =>
          setTimeout(() => {
            const timeoutError = new Error(
              `Discord send timed out after ${SEND_TIMEOUT_MS}ms (ETIMEDOUT)`,
            );
            timeoutError.code = "ETIMEDOUT";
            reject(timeoutError);
          }, SEND_TIMEOUT_MS),
        ),
      ]);
      if (breaker.failures > 0 || breaker.suppressed > 0) {
        if (breaker.suppressed > 0) {
          log.info(
            `Discord channel ${channelId} recovered — ${breaker.suppressed} send(s) were suppressed during the outage`,
          );
        }
        breaker.failures = 0;
        breaker.suppressed = 0;
      }
      return true;
    } catch (error) {
      breaker.failures++;
      // A 5xx is Discord's own outage, not our configuration — classify it
      // alongside the network-level codes below rather than lumping it in
      // with "channel deleted / missing perms", which used to give a
      // transient Discord-side outage the same 30-minute (mis)treatment as
      // a real config problem, AND logged a misleading "misconfigured"
      // reason for something an admin can't fix by touching settings.
      // error.status is set by both of @discordjs/rest's own error classes
      // (DiscordAPIError, HTTPError) — checking it is exact, unlike sniffing
      // error.message for a status-shaped substring.
      const transient =
        (typeof error.status === "number" &&
          error.status >= 500 &&
          error.status < 600) ||
        /EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|Connect Timeout|fetch failed|UND_ERR/i.test(
          error.message || "",
        );

      // Open the circuit on N consecutive failures of ANY kind. For
      // non-transient errors (channel deleted, missing perms, invalid token)
      // we hold the breaker longer since retries won't help — only an admin
      // fixing config will. For transient network errors, COOLDOWN_MS is
      // enough for a typical DNS/route blip to resolve.
      if (breaker.failures >= FAILURE_THRESHOLD) {
        const cooldown = transient ? COOLDOWN_MS : COOLDOWN_MS * 6; // 5 min vs 30 min
        breaker.openUntil = now + cooldown;
        const kind = transient
          ? "unreachable"
          : "misconfigured (likely channel/perms)";
        log.error(
          `Discord ${kind} for channel ${channelId} (${breaker.failures} consecutive failures): ${error.message}. Suppressing ${label} sends for ${Math.round(cooldown / 60000)} min.`,
        );
      } else {
        log.error(`Failed to send Discord ${label}: ${error.message}`);
      }
      return false;
    }
  }

  _breakerFor(channelId) {
    let breaker = this._channelBreakers.get(channelId);
    if (!breaker) {
      breaker = { failures: 0, openUntil: 0, suppressed: 0 };
      this._channelBreakers.set(channelId, breaker);
    }
    return breaker;
  }

  async getConfiguredMaxPlayers() {
    try {
      const activeServer = await getActiveServer();
      const serverName = activeServer?.serverName || (await getSetting("serverName"));
      const configPath =
        activeServer?.serverConfigPath ||
        (activeServer?.zomboidDataPath
          ? path.join(activeServer.zomboidDataPath, "Server")
          : await getSetting("serverConfigPath")) ||
        ((await getSetting("zomboidDataPath"))
          ? path.join(await getSetting("zomboidDataPath"), "Server")
          : null);

      if (
        !configPath ||
        !serverName ||
        typeof serverName !== "string" ||
        path.basename(serverName) !== serverName ||
        serverName.includes("..")
      ) {
        return null;
      }

      const iniPath = path.join(configPath, `${serverName}.ini`);
      if (!fs.existsSync(iniPath)) return null;

      const content = fs.readFileSync(iniPath, "utf8");
      const maxPlayers = Number.parseInt(
        readIniValues(content, ["MaxPlayers"]).MaxPlayers,
        10,
      );
      return Number.isInteger(maxPlayers) && maxPlayers > 0 ? maxPlayers : null;
    } catch (error) {
      log.debug(`Could not read MaxPlayers for Discord presence: ${error.message}`);
      return null;
    }
  }

  async updatePlayerPresence() {
    if (!this.isRunning || !this.client?.user || !this.serverManager) return;
    if (this._presenceUpdateInFlight) return this._presenceUpdateInFlight;

    this._presenceUpdateInFlight = (async () => {
      let activity = "Server offline";
      try {
        // See handleStart()'s comment: the raw local scan alone can't see a
        // split-container/docker-managed server, and this presence text was
        // stuck on "Server offline" forever for that topology even with
        // RCON connected.
        const observedRunning = await resolveObservedServerRunning(
          this.serverManager,
          this.rconService,
        );
        if (observedRunning === null) {
          activity = "Status unknown";
        } else if (observedRunning) {
          if (this.rconService?.connected) {
            const result = await this.rconService.getPlayers();
            if (result?.success) {
              const count = Array.isArray(result.players)
                ? result.players.length
                : 0;
              const maxPlayers = await this.getConfiguredMaxPlayers();
              activity = maxPlayers ? `${count}/${maxPlayers}` : `${count} online`;
            } else {
              activity = "Players unavailable";
            }
          } else {
            activity = "Players unavailable";
          }
        }

        if (this.isRunning && this.client?.user) {
          await this.client.user.setActivity(activity, {
            type: ActivityType.Playing,
          });
        }
      } catch (error) {
        log.debug(`Discord presence update failed: ${error.message}`);
      } finally {
        this._presenceUpdateInFlight = null;
      }
    })();

    return this._presenceUpdateInFlight;
  }

  _startPresenceUpdates() {
    if (this._presenceInterval || !this.client?.user) return;
    void this.updatePlayerPresence();
    this._presenceInterval = setInterval(() => {
      void this.updatePlayerPresence();
    }, PLAYER_PRESENCE_INTERVAL_MS);
  }

  _stopPresenceUpdates() {
    if (this._presenceInterval) {
      clearInterval(this._presenceInterval);
      this._presenceInterval = null;
    }
  }

  async start() {
    // Guard against double-start — calling start() twice would attach a
    // second messageCreate listener and double-relay every Discord message
    // into the game. Caller should stop() first if they want to restart.
    if (this.isRunning || this.client) {
      log.warn("start() called while bot is already running — ignoring");
      return true;
    }

    // re-entrancy sweep, 2026-09-10 (HIGH #1): the check above is not
    // enough on its own to stop a SECOND, near-simultaneous start() call --
    // this.client isn't assigned until well after the first await
    // (loadConfig(), right below) and this.isRunning not until later still
    // (post-login, clientReady). Two overlapping start() calls both pass
    // the check above before either assigns this.client, and both go on to
    // create a Client and attach their own messageCreate listener, doubling
    // every in-game chat relay message. Reachable two ways: a POST
    // /discord/start double-click, AND PUT /discord/config's own internal
    // restart-on-credential-change (routes/discord.js) calling start() a
    // second way -- a guard covering only one of the two callers would
    // still leave the other live, so this is claimed once, synchronously,
    // right here in start() itself (both callers go through this same
    // method), before the first await -- mirrors panelUpdateChecker.js's
    // isDownloading.
    if (this._starting) {
      log.warn("start() called while a previous start() call is still in flight — ignoring");
      return START_ALREADY_IN_PROGRESS;
    }
    this._starting = true;
    try {
      return await this._doStart();
    } finally {
      this._starting = false;
    }
  }

  async _doStart() {
    await this.loadConfig();

    // If a previous stop() detached the chatMessage listener, reattach it
    // now so the freshly started bot can relay in-game chat again.
    if (this.logTailer && !this._onGameChat) {
      this._onGameChat = (data) => this._queueGameChat(data);
      this.logTailer.on("chatMessage", this._onGameChat);
    }

    if (!this.token) {
      log.info("bot not configured (no token)");
      this.lastStartError = { kind: "NoToken", message: "No bot token is configured." };
      return false;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers, // Required for role checks
        GatewayIntentBits.MessageContent, // Required for reading chat messages
      ],
      // Never let bot-sent content ping anyone. The game->Discord chat relay
      // and the {player} event notifications (join/leave/death/kick) carry
      // player-controlled text. Literal @everyone/@here are already replaced
      // with neutral text, but role/user mention syntax (<@&roleId>, <@userId>)
      // is NOT — escapeMarkdown() doesn't touch it — so without this a player
      // named "<@&adminRole>" (or typing it in chat) could ping Discord roles.
      // The bot never needs to ping, so disable all mention parsing globally.
      allowedMentions: { parse: [] },
      // Route the client's INTERNAL REST (login, message sends, interaction
      // replies, chat relay, notifications) through the same undici-safe
      // wrapper used for slash-command registration. Without this, only the
      // manually-created REST instances were patched, so any dashboard-driven
      // action (Send Test Message, event notifications, Discord→game relay)
      // still hit the undici 8.x Symbol(sensitiveHeaders) crash on Node 22+/24+.
      rest: { makeRequest: _safeDiscordMakeRequest },
    });

    // Two-way Chat Bridge: Discord -> Server
    // Rate-limited per Discord user to prevent in-game chat spam: max 5
    // messages per 10-second window. Excess messages are silently dropped.
    const CHAT_BRIDGE_LIMIT = 5;
    const CHAT_BRIDGE_WINDOW_MS = 10_000;
    const chatBridgeRate = new Map(); // userId -> [timestamps]
    this.client.on("messageCreate", async (message) => {
      // Ignore stats from bots (including self) or if bot is stopped
      if (!this.isRunning || message.author.bot) return;
      // Ignore Discord system messages (pin notifications, member joins,
      // boost messages, etc.) — these have empty content and would relay
      // as `<username>: ` to in-game chat.
      if (message.system) return;

      // The relay switch covers the whole bridge. Leaving this direction live
      // meant turning the relay off still piped Discord chatter into the game.
      if (!this.chatRelayEnabled) return;

      // Use the dedicated relay channel in both directions when configured.
      const relayChannelId = this.chatRelayChannelId || this.channelId;
      if (!relayChannelId) return;
      if (message.channelId === relayChannelId) {
        try {
          // Check if RCON is connected
          if (this.rconService && this.rconService.connected) {
            const user = message.author.username;
            const userId = message.author.id;
            // Sanitize content: remove newlines and double quotes to prevent command injection/formatting issues
            let content = message.content;
            if (!content) return; // Ignore empty messages (images etc)

            // Rate-limit per Discord user
            const now = Date.now();
            const hits = (chatBridgeRate.get(userId) || []).filter(
              (t) => now - t < CHAT_BRIDGE_WINDOW_MS,
            );
            if (hits.length >= CHAT_BRIDGE_LIMIT) {
              log.debug(`Chat bridge rate-limited user ${user} (${userId})`);
              return;
            }
            hits.push(now);
            chatBridgeRate.set(userId, hits);
            // Opportunistic GC so the map doesn't grow unbounded
            if (chatBridgeRate.size > 200) {
              for (const [id, ts] of chatBridgeRate) {
                if (!ts.some((t) => now - t < CHAT_BRIDGE_WINDOW_MS))
                  chatBridgeRate.delete(id);
              }
            }

            // Resolve Discord mention/channel/emoji tokens to readable text
            // so PZ in-game chat doesn't show ugly `<@123456789>` blobs.
            let resolved = content
              // User mentions: <@id> or <@!id>
              .replace(/<@!?(\d+)>/g, (_, id) => {
                const u = message.mentions?.users?.get(id);
                return u ? `@${u.username}` : "@user";
              })
              // Role mentions: <@&id>
              .replace(/<@&(\d+)>/g, (_, id) => {
                const r = message.mentions?.roles?.get(id);
                return r ? `@${r.name}` : "@role";
              })
              // Channel mentions: <#id>
              .replace(/<#(\d+)>/g, (_, id) => {
                const c = message.mentions?.channels?.get(id);
                return c ? `#${c.name}` : "#channel";
              })
              // Custom emoji: <:name:id> or <a:name:id>
              .replace(/<a?:([^:>]+):\d+>/g, ":$1:");

            // serverMessage() sanitizes control chars internally; we cap lengths here
            // to prevent overlong RCON messages from high-entropy Discord usernames/content
            const safeUser = user.slice(0, 50);
            const safeMsg = resolved.replace(/[\r\n]+/g, " ").slice(0, 200);
            if (!safeMsg.trim()) return; // mentions-only message after stripping
            const relayed = await this.rconService.serverMessage(
              `[Discord] ${safeUser}: ${safeMsg}`,
            );
            // Being connected is not the same as the command succeeding, and a
            // silent drop is exactly what the offline notice exists to prevent.
            if (!relayed?.success) {
              const now = Date.now();
              if (now - this._bridgeOfflineNoticeAt > 60_000) {
                this._bridgeOfflineNoticeAt = now;
                await message.reply(
                  "⚠️ The game server rejected that message, so it was not delivered in-game.",
                );
              }
            }
          } else {
            const now = Date.now();
            if (now - this._bridgeOfflineNoticeAt > 60_000) {
              this._bridgeOfflineNoticeAt = now;
              await message.reply(
                "⚠️ The game server is unreachable right now, so that message was not delivered in-game.",
              );
            }
          }
        } catch (e) {
          log.warn(`Failed to bridge message to server: ${e.message}`);
        }
      }
    });

    this.client.on("interactionCreate", async (interaction) => {
      try {
        await this.handleInteraction(interaction);
      } catch (error) {
        log.error(`interaction handler error: ${error.message}`);
      }
    });

    this.client.on("error", (error) => {
      log.error(`client error: ${error.stack || error.message}`);
    });

    // See the _gatewayDegradedSince comment in the constructor for why these
    // four specifically (not shardError, which fires for transport errors
    // that don't necessarily change connection state on their own).
    this.client.on("shardReconnecting", () => {
      if (!this._gatewayDegradedSince) this._gatewayDegradedSince = Date.now();
    });
    this.client.on("shardDisconnect", (event) => {
      if (!this._gatewayDegradedSince) this._gatewayDegradedSince = Date.now();
      log.error(
        `Discord gateway shard disconnected and will not reconnect on its own (code ${event?.code}).`,
      );
    });
    this.client.on("shardResume", () => {
      this._gatewayDegradedSince = null;
    });
    this.client.on("shardReady", () => {
      this._gatewayDegradedSince = null;
    });

    try {
      // Await the 'clientReady' event so that isRunning === true before start() returns.
      // client.login() resolves when the WebSocket authenticates; 'clientReady' fires after.
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const timeoutError = new Error("Bot ready timeout after 30s");
          timeoutError.code = "ReadyTimeout";
          reject(timeoutError);
        }, 30000);
        this.client.once("clientReady", async () => {
          clearTimeout(timeout);
          log.info(`bot logged in as ${this.client.user.tag}`);
          try {
            await this.registerCommands();
          } catch (e) {
            log.warn(`Failed to register slash commands: ${e.message}`);
          }
          this.isRunning = true;
          this.lastStartError = null;
          this._startPresenceUpdates();
          resolve();
        });
        this.client.login(this.token).catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
      return true;
    } catch (error) {
      log.error(`Failed to start Discord bot: ${error.message}`);
      // "kind", not "code" -- this never reaches the client as a response
      // code (routes/discord.js only reads it to choose which plain-text
      // message to send), so it's outside the ErrorCode registry's remit
      // (server/utils/errorCodes.js) despite mirroring discord.js's own
      // internal error codes (TokenInvalid, DisallowedIntents, ...).
      this.lastStartError = { kind: error.code || null, message: error.message };
      if (this.logTailer && this._onGameChat) {
        try {
          this.logTailer.off("chatMessage", this._onGameChat);
        } catch {
          /* noop */
        }
        this._onGameChat = null;
      }
      if (this.client) {
        try {
          this.client.destroy();
        } catch (destroyError) {
          log.debug(`Discord client destroy failed: ${destroyError.message}`);
        }
        this.client = null;
      }
      this.isRunning = false;
      this._stopPresenceUpdates();
      return false;
    }
  }
  async stop() {
    this._stopPresenceUpdates();
    // Detach the chatMessage listener so a swapped LogTailer (e.g. a
    // restart of the panel-managed game-server changes the tailer instance)
    // doesn't leak handlers across bot lifecycles. Done outside the client
    // check because a failed start() leaves the listener attached with no
    // client to go with it.
    if (this.logTailer && this._onGameChat) {
      try {
        this.logTailer.off("chatMessage", this._onGameChat);
      } catch {
        /* noop */
      }
      this._onGameChat = null;
    }
    if (this.client) {
      await this.client.destroy();
      this.client = null;
      this.isRunning = false;
      // Reset lifecycle dedupe so the next bot session can fire a fresh
      // serverStart/serverStop without being suppressed by the previous run.
      this._lastLifecycleState = null;
      this._lastLifecycleAt = 0;
      // Reset breaker state too — stale failure counts shouldn't carry over.
      this._channelBreakers.clear();
      this._gatewayDegradedSince = null;
      this._chatRelayChain = Promise.resolve();
      this._chatRelayPending = 0;
      this._chatRelayDropped = 0;
      // Drop registration tracking; a fresh start() should re-register.
      this._registerInFlight = null;
      this._registeredGuildId = null;
      log.info("bot stopped");
    }
  }

  getStatus() {
    // Debounced, not raw: a shardReconnecting-to-shardResume/shardReady
    // round trip well under this threshold is exactly what a healthy
    // connection recovering from a normal blip looks like (see suspect 4's
    // proof) — surfacing that to the operator every time would train them
    // to ignore the signal, which is worse than not having it.
    const gatewayIssue = Boolean(
      this._gatewayDegradedSince &&
        Date.now() - this._gatewayDegradedSince >= GATEWAY_DEGRADED_THRESHOLD_MS,
    );
    return {
      running: this.isRunning,
      configured: !!this.token,
      username: this.client?.user?.tag || null,
      guildId: this.guildId,
      channelId: this.channelId,
      modRoleId: this.modRoleId || null,
      // Persists past the one-time toast POST /start already shows, so a
      // user who navigates away and comes back still sees why the last
      // start attempt failed -- cleared the moment a start actually
      // succeeds (see the clientReady handler in start()).
      lastStartError: this.lastStartError
        ? { kind: this.lastStartError.kind, message: describeStartFailure(this.lastStartError) }
        : null,
      // gatewayDegradedSince is the raw episode-start timestamp (ISO string,
      // or null when healthy) -- the client uses it as the dismissal key so
      // dismissing THIS episode doesn't silence a later, different one.
      gatewayIssue,
      gatewayDegradedSince: gatewayIssue
        ? new Date(this._gatewayDegradedSince).toISOString()
        : null,
    };
  }
}
