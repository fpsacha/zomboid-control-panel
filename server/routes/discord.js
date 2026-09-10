import express from "express";
import { createLogger } from "../utils/logger.js";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.js";
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
  save: "server.control",
  broadcast: "server.world_events",
  kick: "players.moderate",
  start: "server.control",
  stop: "server.control",
  restart: "server.control",
  rcon: "rcon.execute",
};

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
      token: discordBot.token ? "••••••••" + discordBot.token.slice(-4) : null,
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
      chatRelayChannelId,
      chatRelayScope,
    } = req.body;
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

      // Handle KEEP_EXISTING token marker
      const finalToken =
        token === "KEEP_EXISTING" && discordBot.token
          ? discordBot.token
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
          // Cannot happen from a second /config save any more -- the mutex
          // above already serializes those. Only reachable if a separate
          // POST /discord/start landed in the narrow window between this
          // request's own stop() and start() (outside this mutex, on
          // purpose -- widening the mutex to cover /start and /stop is a
          // different, unrequested change). Say so rather than claiming a
          // reconnect this request never performed.
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

    if (!discordBot.isRunning) {
      return res.json({ success: true, message: "Bot is not running" });
    }

    await discordBot.stop();
    res.json({ success: true, message: "Discord bot stopped" });
  } catch (error) {
    log.error(`Failed to stop Discord bot: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Reset Discord bot configuration
router.post("/reset", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.status(500).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    await discordBot.resetConfig();
    res.json({
      success: true,
      message: "Discord bot settings wiped. Setup can start from scratch.",
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

    const sent = await discordBot.sendNotification(
      "🧪 **Test message** from PZ Server Manager",
    );
    if (!sent) {
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
    await discordBot.withConfigMutex(async () => {
      const merged = {
        ...(discordBot.webhookEvents || {}),
        ...sanitizedEvents,
      };
      await discordBot.saveWebhookEvents(merged);
    });

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
    // discordBot.updateCommandPermissions() does not itself read-merge
    // against this.commandPermissions (it merges the submitted object onto
    // DEFAULT_COMMAND_PERMISSIONS, relying on the settings UI to resend
    // every command's tier each save, same as the comment above already
    // notes) -- verified before fixing, per the card's instruction, since
    // this route was pattern-matched to /config and /webhook-events but
    // not confirmed: it does NOT share their server-side unguarded
    // read-merge-then-save mechanism, so a config-mutex cannot close a
    // stale-CLIENT-snapshot lost update here the way it closes the other
    // two. Still wrapped in the same mutex as /config and /webhook-events
    // so this write, the capability check's `current` read just below, and
    // /config's loadConfig() (which also reads discordCommandPermissions)
    // can't interleave with each other.
    await discordBot.withConfigMutex(async () => {
      const current = discordBot.getCommandPermissions();
      const missing = [];
      let callerCapabilities = null;
      for (const [command, tier] of Object.entries(permissions)) {
        const requiredCapability = DISCORD_COMMAND_CAPABILITY[command];
        if (!requiredCapability) continue; // unmapped/no-op key, or status (null)
        if (!(command in current) || current[command] === tier) continue;
        if (callerCapabilities === null) {
          const role = req.user ? await getRoleByName(req.user.role) : null;
          callerCapabilities = Array.isArray(role?.capabilities)
            ? role.capabilities
            : [];
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

      const updated = await discordBot.updateCommandPermissions(permissions);
      res.json({ success: true, permissions: updated });
    });
  } catch (error) {
    log.error(`Failed to update command permissions: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
