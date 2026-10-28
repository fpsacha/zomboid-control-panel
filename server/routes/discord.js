import express from "express";
import { createLogger } from "../utils/logger.js";
import { maskSecretValue, sanitizeError, sanitizeErrorParams } from "../utils/sanitize.js";
import {
  normalizeChatRelayScope,
  START_ALREADY_IN_PROGRESS,
} from "../services/discordBot.js";
import { describeStartFailure } from "../services/discordStartFailure.js";
import { requirePermission, getRoleByName } from "../services/permissions.js";
import { ErrorCode } from "../utils/errorCodes.js";
const log = createLogger("API:Discord");

const router = express.Router();

// Maps each Discord slash command to the panel capability that gates the
// identical action on the panel's own side -- same shape as
// services/scheduler.js's requiredCapabilityForScheduledCommand(): a
// curated action must cost at least as much to hand out as it costs to run.
// `null` means the command has no panel-side capability gate to match
// against (server.js's own GET /status is likewise ungated for every role),
// so retuning its own tier needs nothing beyond integrations.manage itself.
// Checked individually against each command's own real route rather than a
// blanket rule, same discipline as the bridge:saveWorld carve-out earlier
// tonight -- one family rule would have gotten at least "start"/"stop"
// wrong if a future command reused a generic verb.
const DISCORD_COMMAND_CAPABILITY = {
  status: null,
  players: "players.view",
  // The panel's Leaderboard page is players.view too.
  leaderboard: "players.view",
  save: "server.control",
  broadcast: "server.world_events",
  kick: "players.moderate",
  start: "server.control",
  stop: "server.control",
  restart: "server.control",
  rcon: "rcon.execute",
};

// Which capabilities a PUT /config change hands out through Discord, and so
// which ones the caller must already hold (security sweep AUTHZ-3, same rule
// as PUT /permissions below: you cannot hand out an authority through
// Discord that you do not hold yourself in the panel).
// - token / guildId: whoever owns the guild the bot answers in, and its
//   Discord Administrators, pass discordBot.checkPermission() for every
//   command whatever its tier -- swapping in your own bot or guild makes
//   you that owner.
// - adminRoleId: holders of the admin role likewise pass for every command.
// - modRoleId: holders of the mod role pass for the commands currently at
//   the "moderator" tier.
// Any change counts, clearing one included: an unchanged resend (the
// settings page resends every field on each save) never needs anything.
const EVERY_DISCORD_COMMAND_CAPABILITY = [
  ...new Set(Object.values(DISCORD_COMMAND_CAPABILITY).filter(Boolean)),
];

function capabilitiesUnlockedByConfigChange(changed, discordBot) {
  const required = new Set();
  if (changed.includes("token") || changed.includes("guildId") || changed.includes("adminRoleId")) {
    for (const capability of EVERY_DISCORD_COMMAND_CAPABILITY) {
      required.add(capability);
    }
  }
  if (changed.includes("modRoleId")) {
    const commandPermissions = discordBot.getCommandPermissions();
    for (const [command, capability] of Object.entries(DISCORD_COMMAND_CAPABILITY)) {
      if (capability && commandPermissions[command] === "moderator") {
        required.add(capability);
      }
    }
  }
  return [...required];
}

// SECURITY (2026-10-05, HT4b): the chat relay posts what anyone types in
// the channel it listens in into the game as "[Discord] name: text"
// through RCON servermsg -- what the panel's own POST /server/message
// gates behind server.world_events. integrations.manage doesn't include
// it (technician and admin hold both; a custom role can hold one without
// the other), so turning the relay on, or pointing it at another channel,
// needs it too. It listens in the relay channel, or the notification
// channel while none is set, and only while it is on; turning it off or
// leaving the channel as it is needs nothing.
const CHAT_RELAY_CAPABILITY = "server.world_events";

function chatRelayListenChannel({ enabled, relayChannelId, channelId }) {
  if (!enabled) return null;
  return relayChannelId || channelId || null;
}

// SECURITY (2026-10-28, audit R1-23): join, leave and death notifications
// post player names, join and leave times and death coordinates -- what the
// panel shows only to players.view (the "players" socket room). Turning one
// on, changing an enabled one's message, or moving the notification channel
// while one is on needs it too; turning them off needs nothing.
const PLAYER_EVENT_KEYS = ["playerJoin", "playerLeave", "playerDeath"];
const PLAYER_EVENTS_CAPABILITY = "players.view";

function anyPlayerEventEnabled(webhookEvents) {
  return PLAYER_EVENT_KEYS.some((key) => webhookEvents?.[key]?.enabled === true);
}

function playerEventsWidened(current, next) {
  return PLAYER_EVENT_KEYS.some((key) => {
    const after = next?.[key];
    if (!after?.enabled) return false;
    const before = current?.[key];
    return before?.enabled !== true || before.template !== after.template;
  });
}

function refusePlayerEvents(res) {
  return res.status(403).json({
    error: `Join, leave and death notifications show player information, which needs ${PLAYER_EVENTS_CAPABILITY}. You don't hold it, so you can't turn them on, change their message, or move the channel they post in.`,
    code: ErrorCode.DISCORD_PLAYER_EVENTS_CAPABILITY_REQUIRED,
    params: sanitizeErrorParams({ detail: PLAYER_EVENTS_CAPABILITY }),
    missing: [PLAYER_EVENTS_CAPABILITY],
  });
}

// SECURITY (2026-10-28, audit R1-51): while panel logins are off every
// request acts as admin, so the AUTHZ-3 checks above all pass. A bot token,
// guild or role ID set then -- or a command tier lowered -- keeps handing out
// bot commands after logins are back on (the guild's owner passes every
// tier), the same "outlives the setting" class requireLoginsOn already
// closes for accounts and roles. Unchanged resends still save.
const COMMAND_TIER_RANK = { everyone: 0, moderator: 1, admin: 2 };

function refuseWhileLoginsOff(res) {
  return res.status(403).json({
    error: "The Discord bot's token, server and admin or moderator roles can't be changed, nor a command's tier lowered, while panel logins are off: whoever set them would keep running bot commands once logins are back on. Remove the authEnabled: false setting from the panel's db.json, restart the panel and sign in first.",
    code: ErrorCode.DISCORD_CHANGES_NEED_LOGINS,
  });
}

// The caller's panel capabilities, for the checks above and below.
async function capabilitiesOfCaller(req) {
  const role = req.user ? await getRoleByName(req.user.role) : null;
  return Array.isArray(role?.capabilities) ? role.capabilities : [];
}

// Bot config/lifecycle/permissions — "config" is technician's job per the
// role brief; moderator has no need to reconfigure the Discord integration.
// Applied once at the router level (matches panelBridge.js's identical
// integration-config routes, already admin+technician) rather than
// per-route. Previously any logged-in role could reach every route here,
// including reconfiguring the webhook and bot permissions.
router.use(requirePermission("integrations.manage"));

// Get Discord bot status
router.get("/status", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.json({
        running: false,
        configured: false,
        error: "Discord bot not initialized",
      });
    }

    const status = discordBot.getStatus();
    res.json(status);
  } catch (error) {
    log.error(`Failed to get Discord bot status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get Discord bot config
router.get("/config", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.status(500).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    await discordBot.loadConfig();

    // Load auto-start setting
    const { getSetting } = await import("../database/init.js");
    const autoStart = await getSetting("discordAutoStart");

    res.json({
      // Says only that a token is set, like every other masked secret
      // (utils/sanitize.js maskSecretValue): no part of the bot token.
      token: discordBot.token ? maskSecretValue(discordBot.token) : null,
      hasToken: !!discordBot.token,
      guildId: discordBot.guildId,
      adminRoleId: discordBot.adminRoleId,
      modRoleId: discordBot.modRoleId,
      channelId: discordBot.channelId,
      autoStart: autoStart !== false, // default true
      chatRelayEnabled: discordBot.chatRelayEnabled !== false,
      chatRelayChannelId: discordBot.chatRelayChannelId || "",
      chatRelayScope: normalizeChatRelayScope(discordBot.chatRelayScope),
    });
  } catch (error) {
    log.error(`Failed to get Discord config: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Update Discord bot config
router.put("/config", async (req, res) => {
  try {
    const {
      token,
      guildId,
      adminRoleId,
      modRoleId,
      channelId,
      autoStart,
      chatRelayEnabled,
      chatRelayChannelId: sentChatRelayChannelId,
      chatRelayScope,
    } = req.body;
    // SECURITY (2026-10-05, M1): "" or null clears the relay channel, so the
    // relay goes back to the notification channel -- a change of the channel
    // it listens in, gated below (HT4b) exactly as setting one is. Left out,
    // it keeps its value. The settings page used to leave it out when the
    // field was emptied, so a relay channel could never be cleared.
    const chatRelayChannelId =
      sentChatRelayChannelId === null ? "" : sentChatRelayChannelId;
    log.info(
      `PUT /config: guildId=${guildId}, token=${token ? (token === "KEEP_EXISTING" ? "KEEP" : "***") : "none"}, autoStart=${autoStart}`,
    );

    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.status(500).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    // re-entrancy sweep finding #5: everything from here on reads and
    // writes this singleton's persisted config (loadConfig() refreshes it,
    // updateConfig()/updateChatRelay() write it, the credential-change
    // branch below tears down and restarts the live connection), so the
    // whole thing is one critical section serialized against any other
    // concurrent /config, /webhook-events, or /permissions save via
    // discordBot.withConfigMutex(). Without this, two overlapping /config
    // saves could each read a not-yet-committed value from the other and
    // could each run their own stop()+start() sequence concurrently --
    // the exact scenario that made start()'s own _starting guard
    // (finding #1) necessary. Validation stays inside too: it depends on
    // discordBot.token from the loadConfig() call right below.
    await discordBot.withConfigMutex(async () => {
      // Load current config to check for existing token
      await discordBot.loadConfig();

      // Handle KEEP_EXISTING token marker. With no token saved there is
      // nothing to keep: the marker is a placeholder the page sends, never a
      // token, and used to be stored as one (and then logged in with).
      const finalToken =
        token === "KEEP_EXISTING"
          ? discordBot.token || null
          : token;

      if (!finalToken || !guildId) {
        return res.status(400).json({
          error: "Token and Guild ID are required",
          code: ErrorCode.DISCORD_TOKEN_AND_GUILD_REQUIRED,
        });
      }

      // Validate Discord Snowflake format for IDs
      const SNOWFLAKE = /^\d{15,21}$/;
      if (!SNOWFLAKE.test(guildId)) {
        return res.status(400).json({
          error: "Invalid Guild ID format (must be a Discord Snowflake)",
          code: ErrorCode.DISCORD_INVALID_GUILD_ID,
        });
      }
      if (adminRoleId && !SNOWFLAKE.test(adminRoleId)) {
        return res.status(400).json({
          error: "Invalid Admin Role ID format",
          code: ErrorCode.DISCORD_INVALID_ADMIN_ROLE_ID,
        });
      }
      if (modRoleId && !SNOWFLAKE.test(modRoleId)) {
        return res.status(400).json({
          error: "Invalid Mod Role ID format",
          code: ErrorCode.DISCORD_INVALID_MOD_ROLE_ID,
        });
      }
      if (channelId && !SNOWFLAKE.test(channelId)) {
        return res.status(400).json({
          error: "Invalid Channel ID format",
          code: ErrorCode.DISCORD_INVALID_CHANNEL_ID,
        });
      }
      if (chatRelayChannelId && !SNOWFLAKE.test(chatRelayChannelId)) {
        return res.status(400).json({
          error: "Invalid Chat Relay Channel ID format",
          code: ErrorCode.DISCORD_INVALID_CHAT_RELAY_CHANNEL_ID,
        });
      }
      if (
        chatRelayScope !== undefined &&
        chatRelayScope !== "public" &&
        chatRelayScope !== "no-yell" &&
        chatRelayScope !== "general"
      ) {
        return res.status(400).json({
          error: "Invalid Chat Relay Scope",
          code: ErrorCode.DISCORD_INVALID_CHAT_RELAY_SCOPE,
        });
      }

      // Snapshot current auth credentials before overwriting them so we know
      // whether a full Discord reconnection is actually needed.
      const prevToken = discordBot.token;
      const prevGuildId = discordBot.guildId;

      // Refuse before anything is written: see
      // capabilitiesUnlockedByConfigChange() above. Role IDs compare
      // normalized because updateConfig() stores a missing one as "" and
      // loadConfig() reads it back as "".
      const changed = [];
      if (prevToken !== finalToken) changed.push("token");
      if ((prevGuildId || null) !== (guildId || null)) changed.push("guildId");
      if ((discordBot.adminRoleId || null) !== (adminRoleId || null)) {
        changed.push("adminRoleId");
      }
      if ((discordBot.modRoleId || null) !== (modRoleId || null)) {
        changed.push("modRoleId");
      }
      if (changed.length > 0 && req.user?.authDisabled) {
        return refuseWhileLoginsOff(res);
      }
      const requiredCapabilities = capabilitiesUnlockedByConfigChange(
        changed,
        discordBot,
      );
      if (requiredCapabilities.length > 0) {
        const callerCapabilities = await capabilitiesOfCaller(req);
        const missing = requiredCapabilities.filter(
          (capability) => !callerCapabilities.includes(capability),
        );
        if (missing.length > 0) {
          const detail = missing.join(", ");
          return res.status(403).json({
            error: `Changing these Discord settings would let people run bot commands that need ${detail}, which you don't hold yourself.`,
            code: ErrorCode.DISCORD_CONFIG_CAPABILITY_REQUIRED,
            params: sanitizeErrorParams({ detail }),
            changed,
            missing,
          });
        }
      }

      // HT4b: see chatRelayListenChannel() above. updateConfig() below
      // stores a missing channelId as "", and a relay field left out of the
      // body keeps its value.
      const relayListensIn = chatRelayListenChannel({
        enabled: discordBot.chatRelayEnabled !== false,
        relayChannelId: discordBot.chatRelayChannelId,
        channelId: discordBot.channelId,
      });
      const relayWillListenIn = chatRelayListenChannel({
        enabled:
          typeof chatRelayEnabled === "boolean"
            ? chatRelayEnabled
            : discordBot.chatRelayEnabled !== false,
        relayChannelId:
          typeof chatRelayChannelId === "string"
            ? chatRelayChannelId
            : discordBot.chatRelayChannelId,
        channelId,
      });
      if (relayWillListenIn && relayWillListenIn !== relayListensIn) {
        const callerCapabilities = await capabilitiesOfCaller(req);
        if (!callerCapabilities.includes(CHAT_RELAY_CAPABILITY)) {
          return res.status(403).json({
            error: `The chat relay posts what people type in its Discord channel in game, which needs ${CHAT_RELAY_CAPABILITY}. You don't hold it, so you can't turn the relay on or change the channel it listens in (the notification channel, while no relay channel is set).`,
            code: ErrorCode.DISCORD_CHAT_RELAY_CAPABILITY_REQUIRED,
            params: sanitizeErrorParams({ detail: CHAT_RELAY_CAPABILITY }),
            missing: [CHAT_RELAY_CAPABILITY],
          });
        }
      }

      // R1-23: see refusePlayerEvents() above. updateConfig() stores a
      // missing channelId as "".
      if (
        (discordBot.channelId || null) !== (channelId || null) &&
        anyPlayerEventEnabled(discordBot.webhookEvents)
      ) {
        const callerCapabilities = await capabilitiesOfCaller(req);
        if (!callerCapabilities.includes(PLAYER_EVENTS_CAPABILITY)) {
          return refusePlayerEvents(res);
        }
      }

      await discordBot.updateConfig(
        finalToken,
        guildId,
        adminRoleId,
        channelId,
        modRoleId,
      );

      // Save auto-start preference
      if (typeof autoStart === "boolean") {
        const { setSetting } = await import("../database/init.js");
        await setSetting("discordAutoStart", autoStart);
      }

      // Save chat relay settings
      if (
        typeof chatRelayEnabled === "boolean" ||
        typeof chatRelayChannelId === "string" ||
        typeof chatRelayScope === "string"
      ) {
        await discordBot.updateChatRelay(
          typeof chatRelayEnabled === "boolean"
            ? chatRelayEnabled
            : discordBot.chatRelayEnabled,
          typeof chatRelayChannelId === "string"
            ? chatRelayChannelId
            : discordBot.chatRelayChannelId,
          typeof chatRelayScope === "string"
            ? chatRelayScope
            : discordBot.chatRelayScope,
        );
      }

      // Only reconnect if authentication-relevant credentials (token or guild ID)
      // changed. channelId, role IDs, and autoStart are hot-applied by updateConfig()
      // and do not require tearing down the Discord WebSocket connection.
      const credentialsChanged =
        prevToken !== finalToken || prevGuildId !== (guildId || null);
      if (discordBot.isRunning && credentialsChanged) {
        await discordBot.stop();
        // start()'s return value used to be discarded here even though the
        // sibling route POST /start (below) already checks it correctly --
        // start() genuinely returns false (not a throw) on a bad token or a
        // ready-timeout, so a failed reconnect looked identical to a
        // successful one. The saved config really is correct either way
        // (that part doesn't depend on the reconnect), so this stays
        // success:true and surfaces the reconnect outcome separately rather
        // than conflating "your settings were saved" with "the bot is now
        // running".
        const started = await discordBot.start();
        if (started === START_ALREADY_IN_PROGRESS) {
          // Cannot happen from a route any more: the mutex above serializes
          // /config saves, and POST /start and /stop take it too (HT4d).
          // Kept for a start() some other caller began outside it. Say so
          // rather than claiming a reconnect this request never performed.
          return res.json({
            success: true,
            message:
              "Discord bot configuration saved. A start/stop request from elsewhere was already in progress, so this request did not itself reconnect the bot -- check the bot status to confirm it is running with the new configuration.",
            botStarted: null,
          });
        }
        if (!started) {
          return res.json({
            success: true,
            message: "Discord bot configuration saved, but the bot failed to reconnect.",
            botStarted: false,
            botStartError: describeStartFailure(discordBot.lastStartError),
          });
        }
      }

      res.json({
        success: true,
        message: "Discord bot configuration updated",
      });
    });
  } catch (error) {
    log.error(`Failed to update Discord config: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Start Discord bot
//
// SECURITY (2026-10-05, HT4d): under the config mutex, like /config and
// /reset. start() reads the token, then logs in for up to 30s; a wipe that
// landed in between cleared the token and found no running bot to stop
// (isRunning comes true only once the login is done), so the client logged
// in with the old token stayed connected afterwards. /stop takes the mutex
// for the same reason: a stop that lands while /config reconnects or a
// wipe runs waits for it instead of answering "not running".
router.post("/start", async (req, res) => {
  try {
    log.info("POST /start — starting Discord bot");
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.status(500).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    await discordBot.withConfigMutex(async () => {
      if (discordBot.isRunning) {
        return res.json({ success: true, message: "Bot is already running" });
      }

      const started = await discordBot.start();

      if (started) {
        res.json({ success: true, message: "Discord bot started" });
      } else {
        // "check configuration" used to be the ENTIRE message for every cause
        // -- a bad token, a network timeout, and privileged intents not being
        // enabled in the Discord Developer Portal (the classic one: correct
        // token and IDs, still fails, and no amount of re-checking credentials
        // would ever find it) all looked identical. discordBot.lastStartError
        // carries the real discord.js error code now; describeStartFailure()
        // is the same mapping getStatus() uses for the persistent version of
        // this same message, so the toast here and the record that survives a
        // page refresh never say two different things about the same failure.
        const reason = describeStartFailure(discordBot.lastStartError);
        res.status(400).json({
          error: reason,
          code: ErrorCode.DISCORD_START_FAILED,
          params: sanitizeErrorParams({ reason }),
        });
      }
    });
  } catch (error) {
    log.error(`Failed to start Discord bot: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Stop Discord bot
router.post("/stop", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.status(500).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    // HT4d: under the config mutex, see POST /start above.
    await discordBot.withConfigMutex(async () => {
      if (!discordBot.isRunning) {
        // A stop request also ends a boot-time start retry still waiting.
        discordBot.cancelAutoStartRetry?.();
        return res.json({ success: true, message: "Bot is not running" });
      }

      await discordBot.stop();
      res.json({ success: true, message: "Discord bot stopped" });
    });
  } catch (error) {
    log.error(`Failed to stop Discord bot: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Reset Discord bot configuration
//
// SECURITY (2026-10-05, D1): a wipe puts a command's tier back to its
// default only where the caller could have made that change through PUT
// /permissions: the command has no capability (status), or the caller
// holds it. Every other tier is kept as it is. A wipe used to reset every
// tier, so an integrations.manage holder without players.moderate could
// undo an admin raising /kick to "admin" -- the next setup came back with
// /kick at "moderator" and nobody had chosen that.
// The token, guild, role and channel IDs are still cleared: clearing them
// only narrows who can run commands (with no token the bot can't run at
// all), and entering a new token already needs every command's capability
// (capabilitiesUnlockedByConfigChange() above). Under the config mutex so
// the tiers checked here are the tiers resetConfig() writes back.
router.post("/reset", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.status(500).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    await discordBot.withConfigMutex(async () => {
      const callerCapabilities = await capabilitiesOfCaller(req);
      const commandTiersToReset = Object.entries(DISCORD_COMMAND_CAPABILITY)
        .filter(
          ([, capability]) =>
            !capability || callerCapabilities.includes(capability),
        )
        .map(([command]) => command);
      const keptCommandPermissions = await discordBot.resetConfig({
        commandTiersToReset,
      });
      res.json({
        success: true,
        message:
          keptCommandPermissions.length > 0
            ? `Discord bot settings wiped. These commands kept their tier because changing it needs a capability you don't hold: ${keptCommandPermissions.map((command) => `/${command}`).join(", ")}.`
            : "Discord bot settings wiped. Setup can start from scratch.",
        keptCommandPermissions,
      });
    });
  } catch (error) {
    log.error(`Failed to reset Discord config: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Test Discord connection
router.post("/test", async (req, res) => {
  try {
    const { token } = req.body || {};

    if (typeof token !== "string" || token.length === 0 || token.length > 200) {
      return res.status(400).json({
        error: "Token must be a non-empty string (max 200 chars)",
        code: ErrorCode.DISCORD_TEST_TOKEN_INVALID_INPUT,
      });
    }
    // Discord bot tokens are URL-safe base64-ish: letters/digits/_-./
    if (!/^[A-Za-z0-9._-]+$/.test(token)) {
      return res.status(400).json({
        error: "Invalid token format",
        code: ErrorCode.DISCORD_TEST_TOKEN_INVALID_FORMAT,
      });
    }

    // Try to validate token by making a test request
    const response = await fetch("https://discord.com/api/v10/users/@me", {
      headers: {
        Authorization: `Bot ${token}`,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      // Discord's own status distinguishes "this token is wrong" from "this
      // token is fine, Discord just isn't answering right now" -- collapsing
      // every non-2xx into "Invalid token" sent people rotating a token that
      // was never wrong.
      if (response.status === 429) {
        return res.status(429).json({
          error: "Discord is rate-limiting this request. Wait a moment and try again.",
          code: ErrorCode.DISCORD_TEST_RATE_LIMITED,
        });
      }
      if (response.status >= 500) {
        const message = `Discord's API is unavailable right now (HTTP ${response.status}). This isn't your token -- try again shortly.`;
        return res.status(502).json({
          error: message,
          code: ErrorCode.DISCORD_TEST_API_UNAVAILABLE,
          params: sanitizeErrorParams({ status: response.status }),
        });
      }
      if (response.status !== 401) {
        const message = `Discord rejected the request (HTTP ${response.status}).`;
        return res.status(400).json({
          error: message,
          code: ErrorCode.DISCORD_TEST_REQUEST_REJECTED,
          params: sanitizeErrorParams({ status: response.status }),
        });
      }
      return res.status(400).json({
        error: "Invalid token",
        code: ErrorCode.DISCORD_TEST_TOKEN_INVALID,
      });
    }

    const userData = await response.json();

    // Build invite URL with required permissions
    // VIEW_CHANNEL(1024) + SEND_MESSAGES(2048) + EMBED_LINKS(16384) + READ_MESSAGE_HISTORY(65536)
    const permissions = 84992;
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${userData.id}&permissions=${permissions}&scope=bot%20applications.commands`;

    res.json({
      success: true,
      bot: {
        username: userData.username,
        id: userData.id,
        discriminator: userData.discriminator,
        avatar: userData.avatar
          ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png?size=128`
          : null,
      },
      inviteUrl,
    });
  } catch (error) {
    log.error(`Discord test failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Send test message
router.post("/test-message", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");

    if (!discordBot) {
      return res.status(400).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    if (!discordBot.isRunning) {
      return res.status(400).json({
        error: "Bot is not running",
        code: ErrorCode.DISCORD_BOT_NOT_RUNNING,
      });
    }

    // probe: sent even while the channel's circuit breaker is open, so a
    // fixed channel can be confirmed right away (and the breaker closes).
    const sent = await discordBot.sendNotification(
      "🧪 **Test message** from PZ Server Manager",
      { probe: true },
    );
    if (!sent) {
      // SECURITY (2026-10-05, M2): the bot posts only in a channel of the
      // configured guild now. Say so, rather than that Discord rejected it.
      if (discordBot.wasSendRefusedOutsideGuild(discordBot.channelId)) {
        return res.status(400).json({
          error:
            "The notification channel isn't in the Discord server set up here, so the bot won't post in it. Use a channel of the server whose Guild ID is set, or correct the Guild ID.",
          code: ErrorCode.DISCORD_CHANNEL_OUTSIDE_GUILD,
        });
      }
      return res.status(502).json({
        error:
          "Discord rejected the message. Check the notification channel ID and that the bot can post there.",
        code: ErrorCode.DISCORD_TEST_MESSAGE_REJECTED,
      });
    }
    res.json({ success: true, message: "Test message sent" });
  } catch (error) {
    log.error(`Failed to send test message: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get webhook events configuration
router.get("/webhook-events", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.json({ events: {} });
    }

    // Default events - all disabled
    const defaultEvents = {
      serverStart: {
        enabled: false,
        template:
          "🟢 **Server Started**\nThe Project Zomboid server is now online!",
      },
      serverStop: {
        enabled: false,
        template: "🔴 **Server Stopped**\nThe server has been shut down.",
      },
      playerJoin: {
        enabled: false,
        template: "👋 **{player}** joined the server",
      },
      playerLeave: {
        enabled: false,
        template: "👋 **{player}** left the server",
      },
      scheduledRestart: {
        enabled: false,
        template:
          "⏰ **Scheduled Restart**\nServer will restart in {minutes} minutes",
      },
      backupComplete: {
        enabled: false,
        template: "💾 **Backup Complete**\nBackup created successfully",
      },
      playerDeath: { enabled: false, template: "💀 **{player}** has died" },
    };

    const savedEvents = discordBot.webhookEvents || {};
    const events = { ...defaultEvents, ...savedEvents };

    res.json({ events });
  } catch (error) {
    log.error(`Failed to get webhook events: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Update webhook events configuration
router.put("/webhook-events", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.status(500).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    const { events } = req.body;
    if (!events || typeof events !== "object") {
      return res.status(400).json({
        error: "Events configuration required",
        code: ErrorCode.DISCORD_EVENTS_CONFIG_REQUIRED,
      });
    }

    // Whitelist allowed event keys to prevent arbitrary data storage
    const VALID_EVENT_KEYS = [
      "serverStart",
      "serverStop",
      "playerJoin",
      "playerLeave",
      "scheduledRestart",
      "backupComplete",
      "playerDeath",
    ];

    const sanitizedEvents = {};
    for (const key of VALID_EVENT_KEYS) {
      if (events[key] && typeof events[key] === "object") {
        const template =
          typeof events[key].template === "string"
            ? events[key].template.slice(0, 500)
            : "";
        sanitizedEvents[key] = {
          // An enabled event with a blank template would send an empty message,
          // which Discord rejects and which counts against the circuit breaker.
          enabled: !!events[key].enabled && template.trim().length > 0,
          template,
        };
      }
    }

    // Merge rather than replace so a partial update can't silently wipe the
    // events it didn't mention -- reading discordBot.webhookEvents and
    // saving the merge is one critical section serialized via
    // withConfigMutex() (re-entrancy sweep finding #5), so a concurrent
    // save can't read this request's not-yet-committed merge and clobber
    // it with its own.
    const saved = await discordBot.withConfigMutex(async () => {
      // R1-23: see refusePlayerEvents() above.
      if (
        playerEventsWidened(discordBot.webhookEvents, sanitizedEvents) &&
        !(await capabilitiesOfCaller(req)).includes(PLAYER_EVENTS_CAPABILITY)
      ) {
        refusePlayerEvents(res);
        return false;
      }
      const merged = {
        ...(discordBot.webhookEvents || {}),
        ...sanitizedEvents,
      };
      await discordBot.saveWebhookEvents(merged);
      return true;
    });
    if (!saved) return;

    res.json({ success: true, message: "Webhook events updated" });
  } catch (error) {
    log.error(`Failed to update webhook events: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get command permissions
router.get("/permissions", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.status(500).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    res.json({ permissions: discordBot.getCommandPermissions() });
  } catch (error) {
    log.error(`Failed to get command permissions: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Update command permissions
router.put("/permissions", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.status(500).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    const { permissions } = req.body;
    if (!permissions || typeof permissions !== "object") {
      return res.status(400).json({
        error: "Permissions object required",
        code: ErrorCode.DISCORD_PERMISSIONS_OBJECT_REQUIRED,
      });
    }

    // Retuning a command's Discord tier is handing out an authority through
    // a second, unaudited door (Discord's own role check, not the panel's)
    // -- an integrations.manage holder cannot grant an authority they do
    // not themselves hold in the panel, e.g. dropping /rcon to "everyone"
    // without holding rcon.execute. Only a tier that would actually CHANGE
    // is checked: the settings UI may resend every tier on each save
    // (Settings' PUT /app-settings and serverFiles.js's PUT /ini hit this
    // same shape earlier tonight), and re-submitting an unchanged value
    // must never require a capability the caller never needed for the
    // status quo.
    // discordBot.updateCommandPermissions() merges the submitted object
    // onto the current tiers, so a command left out of the body keeps its
    // tier and the per-command check below sees every tier that changes.
    // It used to merge onto DEFAULT_COMMAND_PERMISSIONS instead, so a
    // partial body (even `{}`) reset raised tiers with no check at all --
    // e.g. /save, /broadcast and /kick back to the moderator tier right
    // after a mod role was set (security sweep 2026-10-04, adversary pass
    // on AUTHZ-3). A stale client snapshot still overwrites a newer tier
    // it does send, so a config-mutex cannot close that lost update here
    // the way it closes /config's and /webhook-events'. Still wrapped in the same mutex as /config and /webhook-events
    // so this write, the capability check's `current` read just below, and
    // /config's loadConfig() (which also reads discordCommandPermissions)
    // can't interleave with each other.
    await discordBot.withConfigMutex(async () => {
      const current = discordBot.getCommandPermissions();
      // R1-51: see refuseWhileLoginsOff() above. Raising a tier still saves;
      // a value that isn't a known tier counts as lowering it.
      if (req.user?.authDisabled) {
        const lowered = Object.entries(permissions).some(
          ([command, tier]) =>
            command in current &&
            current[command] !== tier &&
            !(COMMAND_TIER_RANK[tier] >= COMMAND_TIER_RANK[current[command]]),
        );
        if (lowered) return refuseWhileLoginsOff(res);
      }
      const missing = [];
      let callerCapabilities = null;
      for (const [command, tier] of Object.entries(permissions)) {
        const requiredCapability = DISCORD_COMMAND_CAPABILITY[command];
        if (!requiredCapability) continue; // unmapped/no-op key, or status (null)
        if (!(command in current) || current[command] === tier) continue;
        if (callerCapabilities === null) {
          callerCapabilities = await capabilitiesOfCaller(req);
        }
        if (!callerCapabilities.includes(requiredCapability)) {
          missing.push({ command, requiredCapability });
        }
      }
      if (missing.length > 0) {
        const detail = missing
          .map((m) => `"${m.command}" needs ${m.requiredCapability}`)
          .join(", ");
        return res.status(403).json({
          error: `Cannot change the Discord tier for ${detail} without holding that capability yourself.`,
          code: ErrorCode.DISCORD_PERMISSIONS_CAPABILITY_REQUIRED,
          params: sanitizeErrorParams({ detail }),
          missing,
        });
      }

      const { permissions: updated, commandsRegistered } =
        await discordBot.updateCommandPermissions(permissions);
      // The tiers are saved either way. When pushing them to Discord failed,
      // say so (the page shows a warning) instead of reporting a failed save.
      res.json({
        success: true,
        permissions: updated,
        ...(commandsRegistered === false ? { commandsRegistered: false } : {}),
      });
    });
  } catch (error) {
    log.error(`Failed to update command permissions: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
