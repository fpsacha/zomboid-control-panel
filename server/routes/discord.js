import express from "express";
import { createLogger } from "../utils/logger.js";
import { sanitizeError } from "../utils/sanitize.js";
const log = createLogger("API:Discord");

const router = express.Router();

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
      return res.status(500).json({ error: "Discord bot not initialized" });
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
      chatRelayScope:
        discordBot.chatRelayScope === "general" ? "general" : "public",
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
      return res.status(500).json({ error: "Discord bot not initialized" });
    }

    // Load current config to check for existing token
    await discordBot.loadConfig();

    // Handle KEEP_EXISTING token marker
    const finalToken =
      token === "KEEP_EXISTING" && discordBot.token ? discordBot.token : token;

    if (!finalToken || !guildId) {
      return res.status(400).json({ error: "Token and Guild ID are required" });
    }

    // Validate Discord Snowflake format for IDs
    const SNOWFLAKE = /^\d{15,21}$/;
    if (!SNOWFLAKE.test(guildId)) {
      return res.status(400).json({
        error: "Invalid Guild ID format (must be a Discord Snowflake)",
      });
    }
    if (adminRoleId && !SNOWFLAKE.test(adminRoleId)) {
      return res.status(400).json({ error: "Invalid Admin Role ID format" });
    }
    if (modRoleId && !SNOWFLAKE.test(modRoleId)) {
      return res.status(400).json({ error: "Invalid Mod Role ID format" });
    }
    if (channelId && !SNOWFLAKE.test(channelId)) {
      return res.status(400).json({ error: "Invalid Channel ID format" });
    }
    if (chatRelayChannelId && !SNOWFLAKE.test(chatRelayChannelId)) {
      return res
        .status(400)
        .json({ error: "Invalid Chat Relay Channel ID format" });
    }
    if (
      chatRelayScope !== undefined &&
      chatRelayScope !== "public" &&
      chatRelayScope !== "general"
    ) {
      return res.status(400).json({ error: "Invalid Chat Relay Scope" });
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
      await discordBot.start();
    }

    res.json({
      success: true,
      message: "Discord bot configuration updated",
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
      return res.status(500).json({ error: "Discord bot not initialized" });
    }

    if (discordBot.isRunning) {
      return res.json({ success: true, message: "Bot is already running" });
    }

    const started = await discordBot.start();

    if (started) {
      res.json({ success: true, message: "Discord bot started" });
    } else {
      res
        .status(400)
        .json({ error: "Failed to start bot - check configuration" });
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
      return res.status(500).json({ error: "Discord bot not initialized" });
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
      return res.status(500).json({ error: "Discord bot not initialized" });
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
      return res
        .status(400)
        .json({ error: "Token must be a non-empty string (max 200 chars)" });
    }
    // Discord bot tokens are URL-safe base64-ish: letters/digits/_-./
    if (!/^[A-Za-z0-9._-]+$/.test(token)) {
      return res.status(400).json({ error: "Invalid token format" });
    }

    // Try to validate token by making a test request
    const response = await fetch("https://discord.com/api/v10/users/@me", {
      headers: {
        Authorization: `Bot ${token}`,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return res.status(400).json({ error: "Invalid token" });
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
      return res.status(400).json({ error: "Discord bot not initialized" });
    }

    if (!discordBot.isRunning) {
      return res.status(400).json({ error: "Bot is not running" });
    }

    const sent = await discordBot.sendNotification(
      "🧪 **Test message** from PZ Server Manager",
    );
    if (!sent) {
      return res.status(502).json({
        error:
          "Discord rejected the message. Check the notification channel ID and that the bot can post there.",
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
      return res.status(500).json({ error: "Discord bot not initialized" });
    }

    const { events } = req.body;
    if (!events || typeof events !== "object") {
      return res.status(400).json({ error: "Events configuration required" });
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
    // events it didn't mention.
    const merged = { ...(discordBot.webhookEvents || {}), ...sanitizedEvents };
    await discordBot.saveWebhookEvents(merged);

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
      return res.status(500).json({ error: "Discord bot not initialized" });
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
      return res.status(500).json({ error: "Discord bot not initialized" });
    }

    const { permissions } = req.body;
    if (!permissions || typeof permissions !== "object") {
      return res.status(400).json({ error: "Permissions object required" });
    }

    const updated = await discordBot.updateCommandPermissions(permissions);
    res.json({ success: true, permissions: updated });
  } catch (error) {
    log.error(`Failed to update command permissions: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
