import express from 'express';
import { createLogger } from '../utils/logger.js';
const log = createLogger('API:Discord');

const router = express.Router();

// Get Discord bot status
router.get('/status', async (req, res) => {
  try {
    const discordBot = req.app.get('discordBot');
    if (!discordBot) {
      return res.json({ 
        running: false, 
        configured: false,
        error: 'Discord bot not initialized'
      });
    }
    
    const status = discordBot.getStatus();
    res.json(status);
  } catch (error) {
    log.error(`Failed to get Discord bot status: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get Discord bot config
router.get('/config', async (req, res) => {
  try {
    const discordBot = req.app.get('discordBot');
    if (!discordBot) {
      return res.status(500).json({ error: 'Discord bot not initialized' });
    }
    
    await discordBot.loadConfig();
    
    res.json({
      token: discordBot.token ? '••••••••' + discordBot.token.slice(-4) : null,
      hasToken: !!discordBot.token,
      guildId: discordBot.guildId,
      adminRoleId: discordBot.adminRoleId,
      channelId: discordBot.channelId
    });
  } catch (error) {
    log.error(`Failed to get Discord config: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Update Discord bot config
router.put('/config', async (req, res) => {
  try {
    const { token, guildId, adminRoleId, channelId } = req.body;
    
    const discordBot = req.app.get('discordBot');
    if (!discordBot) {
      return res.status(500).json({ error: 'Discord bot not initialized' });
    }
    
    // Load current config to check for existing token
    await discordBot.loadConfig();
    
    // Handle KEEP_EXISTING token marker
    const finalToken = (token === 'KEEP_EXISTING' && discordBot.token) ? discordBot.token : token;
    
    if (!finalToken || !guildId) {
      return res.status(400).json({ error: 'Token and Guild ID are required' });
    }
    
    await discordBot.updateConfig(finalToken, guildId, adminRoleId, channelId);
    
    // Restart bot if it was running
    if (discordBot.isRunning) {
      await discordBot.stop();
      await discordBot.start();
    }
    
    res.json({ 
      success: true, 
      message: 'Discord bot configuration updated' 
    });
  } catch (error) {
    log.error(`Failed to update Discord config: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Start Discord bot
router.post('/start', async (req, res) => {
  try {
    const discordBot = req.app.get('discordBot');
    if (!discordBot) {
      return res.status(500).json({ error: 'Discord bot not initialized' });
    }
    
    if (discordBot.isRunning) {
      return res.json({ success: true, message: 'Bot is already running' });
    }
    
    const started = await discordBot.start();
    
    if (started) {
      res.json({ success: true, message: 'Discord bot started' });
    } else {
      res.status(400).json({ error: 'Failed to start bot - check configuration' });
    }
  } catch (error) {
    log.error(`Failed to start Discord bot: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Stop Discord bot
router.post('/stop', async (req, res) => {
  try {
    const discordBot = req.app.get('discordBot');
    if (!discordBot) {
      return res.status(500).json({ error: 'Discord bot not initialized' });
    }
    
    if (!discordBot.isRunning) {
      return res.json({ success: true, message: 'Bot is not running' });
    }
    
    await discordBot.stop();
    res.json({ success: true, message: 'Discord bot stopped' });
  } catch (error) {
    log.error(`Failed to stop Discord bot: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Test Discord connection
router.post('/test', async (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }
    
    // Try to validate token by making a test request
    const response = await fetch('https://discord.com/api/v10/users/@me', {
      headers: {
        'Authorization': `Bot ${token}`
      }
    });
    
    if (!response.ok) {
      return res.status(400).json({ error: 'Invalid token' });
    }
    
    const userData = await response.json();
    
    res.json({ 
      success: true, 
      bot: {
        username: userData.username,
        id: userData.id,
        discriminator: userData.discriminator
      }
    });
  } catch (error) {
    log.error(`Discord test failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Send test message
router.post('/test-message', async (req, res) => {
  try {
    const discordBot = req.app.get('discordBot');
    
    if (!discordBot.isRunning) {
      return res.status(400).json({ error: 'Bot is not running' });
    }
    
    await discordBot.sendNotification('🧪 **Test message** from PZ Server Manager');
    res.json({ success: true, message: 'Test message sent' });
  } catch (error) {
    log.error(`Failed to send test message: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get webhook events configuration
router.get('/webhook-events', async (req, res) => {
  try {
    const discordBot = req.app.get('discordBot');
    if (!discordBot) {
      return res.json({ events: {} });
    }
    
    // Default events - all disabled
    const defaultEvents = {
      serverStart: { enabled: false, template: '🟢 **Server Started**\nThe Project Zomboid server is now online!' },
      serverStop: { enabled: false, template: '🔴 **Server Stopped**\nThe server has been shut down.' },
      playerJoin: { enabled: false, template: '👋 **{player}** joined the server' },
      playerLeave: { enabled: false, template: '👋 **{player}** left the server' },
      scheduledRestart: { enabled: false, template: '⏰ **Scheduled Restart**\nServer will restart in {minutes} minutes' },
      backupComplete: { enabled: false, template: '💾 **Backup Complete**\nBackup created successfully' },
      playerDeath: { enabled: false, template: '💀 **{player}** has died' }
    };
    
    const savedEvents = discordBot.webhookEvents || {};
    const events = { ...defaultEvents, ...savedEvents };
    
    res.json({ events });
  } catch (error) {
    log.error(`Failed to get webhook events: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Update webhook events configuration
router.put('/webhook-events', async (req, res) => {
  try {
    const discordBot = req.app.get('discordBot');
    if (!discordBot) {
      return res.status(500).json({ error: 'Discord bot not initialized' });
    }
    
    const { events } = req.body;
    if (!events) {
      return res.status(400).json({ error: 'Events configuration required' });
    }
    
    discordBot.webhookEvents = events;
    await discordBot.saveWebhookEvents(events);
    
    res.json({ success: true, message: 'Webhook events updated' });
  } catch (error) {
    log.error(`Failed to update webhook events: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;
