import express from 'express';
import { logger } from '../utils/logger.js';
import { getCommandHistory } from '../database/init.js';
import { PZ_COMMANDS } from '../utils/commands.js';

const router = express.Router();

// Execute raw RCON command
router.post('/execute', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { command } = req.body;
    
    if (!command) {
      return res.status(400).json({ error: 'Command is required' });
    }
    
    const result = await rconService.execute(command);
    
    // Emit to connected clients
    const io = req.app.get('io');
    io.to('logs').emit('rcon:response', {
      command,
      response: result.response || result.error,
      success: result.success,
      timestamp: new Date().toISOString()
    });
    
    res.json(result);
  } catch (error) {
    logger.error(`RCON execute failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get RCON connection status
router.get('/status', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const config = rconService.getConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Connect to RCON
router.post('/connect', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { host, port, password } = req.body;
    
    if (host || port || password) {
      rconService.updateConfig(host, port, password);
    }
    
    const connected = await rconService.connect();
    if (connected) {
      res.json({ success: true, message: 'Connected to RCON' });
    } else {
      res.status(503).json({ success: false, error: 'Could not connect to RCON. Is the server running and RCON enabled?' });
    }
  } catch (error) {
    logger.error(`RCON connect failed: ${error.message}`);
    const rconService = req.app.get('rconService');
    const friendlyError = rconService.getUserFriendlyError(error.message);
    res.status(500).json({ success: false, error: friendlyError });
  }
});

// Health check - test if connection is actually alive
router.get('/health', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const health = await rconService.healthCheck();
    if (health.healthy) {
      res.json({ success: true, ...health });
    } else {
      res.status(503).json({ success: false, ...health });
    }
  } catch (error) {
    res.status(500).json({ success: false, reason: error.message });
  }
});

// Disconnect from RCON
router.post('/disconnect', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    await rconService.disconnect();
    res.json({ success: true, message: 'Disconnected from RCON' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get command history
router.get('/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
    const history = await getCommandHistory(limit);
    res.json({ history });
  } catch (error) {
    logger.error(`Failed to get command history: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get available commands
router.get('/commands', (req, res) => {
  res.json({ commands: PZ_COMMANDS });
});

// Get commands by category
router.get('/commands/:category', (req, res) => {
  const { category } = req.params;
  const filtered = Object.entries(PZ_COMMANDS)
    .filter(([_, cmd]) => cmd.category === category)
    .reduce((acc, [key, cmd]) => {
      acc[key] = cmd;
      return acc;
    }, {});
  
  res.json({ commands: filtered });
});

export default router;
