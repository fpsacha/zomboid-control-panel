import express from 'express';
import { logger } from '../utils/logger.js';
import { getAllSettings, setSetting } from '../database/init.js';

const router = express.Router();

// Validation helpers
const VALID_SETTINGS_KEYS = [
  'rconHost', 'rconPort', 'rconPassword',
  'serverPath', 'serverConfigPath', 'zomboidDataPath',
  'steamcmdPath', 'steamApiKey', 'serverName', 'minMemory', 'maxMemory', 'serverPort',
  'modCheckInterval', 'modAutoRestart', 'modRestartDelay',
  'darkMode', 'autoReconnect', 'reconnectInterval',
  'discordEnabled', 'discordToken', 'discordGuildId', 'discordAdminRole',
  'autoStartServer',
  'panelPort'
];

const OPTION_NAME_REGEX = /^[a-zA-Z0-9_]{1,64}$/;
const OPTION_VALUE_REGEX = /^[a-zA-Z0-9_.,:;\/ -]{0,256}$/;

function isValidOptionName(name) {
  return typeof name === 'string' && OPTION_NAME_REGEX.test(name);
}

function isValidOptionValue(value) {
  const strVal = String(value);
  return OPTION_VALUE_REGEX.test(strVal);
}

// Get server configuration
router.get('/', async (req, res) => {
  try {
    const serverManager = req.app.get('serverManager');
    const config = await serverManager.getServerConfig();
    res.json({ config });
  } catch (error) {
    logger.error(`Failed to get config: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Update server configuration
router.put('/', async (req, res) => {
  try {
    const serverManager = req.app.get('serverManager');
    const { config } = req.body;
    
    if (!config) {
      return res.status(400).json({ error: 'Config is required' });
    }
    
    await serverManager.saveServerConfig(config);
    res.json({ success: true, message: 'Configuration saved' });
  } catch (error) {
    logger.error(`Failed to save config: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Reload server options via RCON
router.post('/reload', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const result = await rconService.reloadOptions();
    res.json(result);
  } catch (error) {
    logger.error(`Failed to reload options: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get server options via RCON
router.get('/options', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const result = await rconService.showOptions();
    res.json(result);
  } catch (error) {
    logger.error(`Failed to get options: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Change a specific option via RCON
router.post('/option', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { name, value } = req.body;
    
    if (!name || value === undefined) {
      return res.status(400).json({ error: 'Option name and value are required' });
    }
    
    // Validate option name and value to prevent command injection
    if (!isValidOptionName(name)) {
      return res.status(400).json({ error: 'Invalid option name format' });
    }
    
    if (!isValidOptionValue(value)) {
      return res.status(400).json({ error: 'Invalid option value format' });
    }
    
    const result = await rconService.changeOption(name, value);
    res.json(result);
  } catch (error) {
    logger.error(`Failed to change option: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get application settings
router.get('/app-settings', async (req, res) => {
  try {
    const settings = await getAllSettings();
    res.json({ settings });
  } catch (error) {
    logger.error(`Failed to get app settings: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Update application settings
router.put('/app-settings', async (req, res) => {
  try {
    const { settings } = req.body;
    
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'Settings are required' });
    }
    
    // Only allow valid setting keys to prevent prototype pollution
    for (const [key, value] of Object.entries(settings)) {
      if (!VALID_SETTINGS_KEYS.includes(key)) {
        logger.warn(`Invalid setting key rejected: ${key}`);
        continue;
      }
      await setSetting(key, value);
    }
    
    // Reload serverManager and rconService configs after settings change
    const serverManager = req.app.get('serverManager');
    const rconService = req.app.get('rconService');
    if (serverManager?.reloadConfig) {
      await serverManager.reloadConfig();
    }
    if (rconService?.loadConfig) {
      rconService.configLoaded = false;
      await rconService.loadConfig();
    }
    
    res.json({ success: true, message: 'Settings saved' });
  } catch (error) {
    logger.error(`Failed to save app settings: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get paths configuration
router.get('/paths', async (req, res) => {
  try {
    res.json({
      serverPath: process.env.PZ_SERVER_PATH || '',
      savePath: process.env.PZ_SAVE_PATH || '',
      serverBat: process.env.PZ_SERVER_BAT || 'StartServer64.bat'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update paths (runtime only - doesn't persist to .env)
router.put('/paths', async (req, res) => {
  try {
    const serverManager = req.app.get('serverManager');
    const { serverPath, savePath } = req.body;
    
    serverManager.updatePaths(serverPath, savePath);
    
    res.json({ success: true, message: 'Paths updated' });
  } catch (error) {
    logger.error(`Failed to update paths: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get RCON configuration
router.get('/rcon', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const config = rconService.getConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Validation for RCON config
const RCON_HOST_REGEX = /^[a-zA-Z0-9.-]{1,255}$/;
const RCON_PASSWORD_MAX_LENGTH = 256;

// Update RCON configuration
router.put('/rcon', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { host, port, password } = req.body;
    
    // Validate host (if provided)
    if (host !== undefined) {
      if (typeof host !== 'string' || !RCON_HOST_REGEX.test(host)) {
        return res.status(400).json({ error: 'Invalid host format' });
      }
    }
    
    // Validate port (if provided)
    if (port !== undefined) {
      const portNum = parseInt(port, 10);
      if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        return res.status(400).json({ error: 'Invalid port number (must be 1-65535)' });
      }
    }
    
    // Validate password length (if provided)
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length > RCON_PASSWORD_MAX_LENGTH) {
        return res.status(400).json({ error: 'Invalid password format' });
      }
    }
    
    rconService.updateConfig(host, port, password);
    
    res.json({ success: true, message: 'RCON configuration updated' });
  } catch (error) {
    logger.error(`Failed to update RCON config: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Test RCON connection
router.post('/test-rcon', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    
    // Try to connect
    const connected = await rconService.connect();
    
    if (connected) {
      // Try a simple command to verify
      try {
        await rconService.execute('help');
        res.json({ 
          success: true, 
          message: 'RCON connection successful',
          connected: true 
        });
      } catch (cmdError) {
        res.json({ 
          success: true, 
          message: 'Connected but command failed: ' + cmdError.message,
          connected: true,
          warning: true
        });
      }
    } else {
      res.json({ 
        success: false, 
        message: 'Failed to connect to RCON',
        connected: false 
      });
    }
  } catch (error) {
    logger.error(`RCON test failed: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      connected: false 
    });
  }
});

export default router;
