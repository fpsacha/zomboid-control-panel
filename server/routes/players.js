import express from 'express';
import { logger } from '../utils/logger.js';
import { 
  logPlayerAction, 
  getPlayerLogs,
  getPlayerNotes,
  getPlayerNote,
  upsertPlayerNote,
  deletePlayerNote,
  getPlayerStats,
  getPlayerStat
} from '../database/init.js';
import { VEHICLES, PERKS, ACCESS_LEVELS } from '../utils/commands.js';

const router = express.Router();

// Validation helpers to prevent RCON command injection
const USERNAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const SAFE_TEXT_REGEX = /^[a-zA-Z0-9\s.,!?_-]{0,256}$/;
const ITEM_REGEX = /^[a-zA-Z0-9_.]{1,128}$/;

function isValidUsername(username) {
  return typeof username === 'string' && USERNAME_REGEX.test(username);
}

function isValidText(text) {
  return typeof text === 'string' && SAFE_TEXT_REGEX.test(text);
}

function isValidItem(item) {
  return typeof item === 'string' && ITEM_REGEX.test(item);
}

function isValidNumber(num, min = -Infinity, max = Infinity) {
  if (num === null || num === undefined || num === '') return false;
  const n = Number(num);
  return Number.isFinite(n) && n >= min && n <= max;
}

// Get player activity logs
router.get('/activity', async (req, res) => {
  try {
    const { player, limit = 100 } = req.query;
    const logs = await getPlayerLogs(player || null, parseInt(limit, 10));
    res.json({ success: true, logs });
  } catch (error) {
    logger.error(`Failed to get player activity logs: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get all connected players
router.get('/', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const result = await rconService.getPlayers();
    
    const io = req.app.get('io');
    if (result.success) {
      io.to('players').emit('players:update', result.players);
    }
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to get players: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Kick player
router.post('/kick', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, reason } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    
    if (reason && !isValidText(reason)) {
      return res.status(400).json({ error: 'Invalid reason format' });
    }
    
    const result = await rconService.kickPlayer(username, reason);
    await logPlayerAction(username, 'kick', reason);
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to kick player: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Ban player
router.post('/ban', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, banIp, reason } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    
    if (reason && !isValidText(reason)) {
      return res.status(400).json({ error: 'Invalid reason format' });
    }
    
    const result = await rconService.banPlayer(username, banIp, reason);
    await logPlayerAction(username, 'ban', `IP: ${banIp}, Reason: ${reason}`);
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to ban player: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Unban player
router.post('/unban', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    
    const result = await rconService.unbanPlayer(username);
    await logPlayerAction(username, 'unban', null);
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to unban player: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Set access level
router.post('/access-level', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, level } = req.body;
    
    if (!username || !level) {
      return res.status(400).json({ error: 'Username and level are required' });
    }
    
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    
    if (!ACCESS_LEVELS.includes(level.toLowerCase())) {
      return res.status(400).json({ error: `Invalid access level. Valid: ${ACCESS_LEVELS.join(', ')}` });
    }
    
    const result = await rconService.setAccessLevel(username, level);
    await logPlayerAction(username, 'access_level', level);
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to set access level: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Add to whitelist
router.post('/whitelist/add', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    
    const result = await rconService.addToWhitelist(username);
    await logPlayerAction(username, 'whitelist_add', null);
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to add to whitelist: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Remove from whitelist
router.post('/whitelist/remove', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    
    const result = await rconService.removeFromWhitelist(username);
    await logPlayerAction(username, 'whitelist_remove', null);
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to remove from whitelist: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Teleport player
router.post('/teleport', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { player1, player2, x, y, z } = req.body;
    
    let result;
    if (x !== undefined && y !== undefined && z !== undefined) {
      // Validate coordinates
      if (!isValidNumber(x) || !isValidNumber(y) || !isValidNumber(z)) {
        return res.status(400).json({ error: 'Invalid coordinates' });
      }
      result = await rconService.teleportTo(x, y, z);
    } else if (player1) {
      if (!isValidUsername(player1)) {
        return res.status(400).json({ error: 'Invalid player1 username format' });
      }
      if (player2 && !isValidUsername(player2)) {
        return res.status(400).json({ error: 'Invalid player2 username format' });
      }
      result = await rconService.teleportPlayer(player1, player2);
    } else {
      return res.status(400).json({ error: 'Player name or coordinates required' });
    }
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to teleport: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Add item to player
router.post('/add-item', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, item, count } = req.body;
    
    if (!item) {
      return res.status(400).json({ error: 'Item is required' });
    }
    
    if (!isValidItem(item)) {
      return res.status(400).json({ error: 'Invalid item format' });
    }
    
    if (username && !isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    
    if (count !== undefined && !isValidNumber(count, 1, 10000)) {
      return res.status(400).json({ error: 'Invalid count (1-10000)' });
    }
    
    const result = await rconService.addItem(username, item, count || 1);
    if (username) {
      await logPlayerAction(username, 'add_item', `${item} x${count || 1}`);
    }
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to add item: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Add XP to player
router.post('/add-xp', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, perk, amount } = req.body;
    
    if (!username || !perk || !amount) {
      return res.status(400).json({ error: 'Username, perk, and amount are required' });
    }
    
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    
    if (!PERKS.includes(perk)) {
      return res.status(400).json({ error: `Invalid perk. Valid: ${PERKS.join(', ')}` });
    }
    
    if (!isValidNumber(amount, 0, 100000)) {
      return res.status(400).json({ error: 'Invalid XP amount (0-100000)' });
    }
    
    const result = await rconService.addXp(username, perk, amount);
    await logPlayerAction(username, 'add_xp', `${perk}=${amount}`);
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to add XP: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Spawn vehicle
router.post('/add-vehicle', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { vehicle, username } = req.body;
    
    if (!vehicle) {
      return res.status(400).json({ error: 'Vehicle is required' });
    }
    
    if (!VEHICLES.includes(vehicle)) {
      return res.status(400).json({ error: 'Invalid vehicle type' });
    }
    
    if (username && !isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    
    const result = await rconService.addVehicle(vehicle, username);
    if (username) {
      await logPlayerAction(username, 'add_vehicle', vehicle);
    }
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to spawn vehicle: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// God mode
router.post('/godmode', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, enabled } = req.body;
    
    if (username && !isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    
    const result = await rconService.setGodMode(username, enabled);
    if (username) {
      await logPlayerAction(username, 'godmode', enabled ? 'enabled' : 'disabled');
    }
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to set godmode: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Invisible
router.post('/invisible', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, enabled } = req.body;
    
    if (username && !isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    
    const result = await rconService.setInvisible(username, enabled);
    if (username) {
      await logPlayerAction(username, 'invisible', enabled ? 'enabled' : 'disabled');
    }
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to set invisible: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Noclip
router.post('/noclip', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, enabled } = req.body;
    
    if (username && !isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    
    const result = await rconService.setNoclip(username, enabled);
    if (username) {
      await logPlayerAction(username, 'noclip', enabled ? 'enabled' : 'disabled');
    }
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to set noclip: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get available vehicles
router.get('/vehicles', (req, res) => {
  res.json({ vehicles: VEHICLES });
});

// Get available perks
router.get('/perks', (req, res) => {
  res.json({ perks: PERKS });
});

// Get access levels
router.get('/access-levels', (req, res) => {
  res.json({ levels: ACCESS_LEVELS });
});

// Ban by SteamID
router.post('/banid', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { steamId } = req.body;
    
    if (!steamId) {
      return res.status(400).json({ error: 'SteamID is required' });
    }
    
    // SteamIDs are numeric strings
    if (!/^\d{17}$/.test(steamId)) {
      return res.status(400).json({ error: 'Invalid SteamID format (must be 17 digits)' });
    }
    
    const result = await rconService.banSteamId(steamId);
    await logPlayerAction(steamId, 'banid', null);
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to ban SteamID: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Unban by SteamID
router.post('/unbanid', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { steamId } = req.body;
    
    if (!steamId) {
      return res.status(400).json({ error: 'SteamID is required' });
    }
    
    if (!/^\d{17}$/.test(steamId)) {
      return res.status(400).json({ error: 'Invalid SteamID format (must be 17 digits)' });
    }
    
    const result = await rconService.unbanSteamId(steamId);
    await logPlayerAction(steamId, 'unbanid', null);
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to unban SteamID: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Voice ban
router.post('/voiceban', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, enabled } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    
    const result = await rconService.voiceBan(username, enabled);
    await logPlayerAction(username, 'voiceban', enabled ? 'enabled' : 'disabled');
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to set voice ban: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Add user to whitelist server (with password)
router.post('/adduser', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    
    // Password validation - alphanumeric and some special chars
    if (!/^[a-zA-Z0-9!@#$%^&*_-]{4,64}$/.test(password)) {
      return res.status(400).json({ error: 'Invalid password format' });
    }
    
    const result = await rconService.addUser(username, password);
    await logPlayerAction(username, 'adduser', null);
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to add user: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Add all connected players to whitelist
router.post('/whitelist/addall', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const result = await rconService.addAllToWhitelist();
    
    res.json(result);
  } catch (error) {
    logger.error(`Failed to add all to whitelist: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Player Notes & Tags
// ============================================

// Get all player notes
router.get('/notes', async (req, res) => {
  try {
    const notes = await getPlayerNotes();
    res.json({ success: true, notes });
  } catch (error) {
    logger.error(`Failed to get player notes: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get note for specific player
router.get('/notes/:playerName', async (req, res) => {
  try {
    const note = await getPlayerNote(req.params.playerName);
    res.json({ success: true, note });
  } catch (error) {
    logger.error(`Failed to get player note: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Create or update player note
router.post('/notes', async (req, res) => {
  try {
    const { playerName, note } = req.body;
    const tags = req.body.tags || [];
    
    if (!playerName) {
      return res.status(400).json({ error: 'Player name is required' });
    }
    
    // Validate note length
    if (note && note.length > 10000) {
      return res.status(400).json({ error: 'Note too long (max 10000 characters)' });
    }
    
    // Validate tags array and individual tag format
    if (!Array.isArray(tags)) {
      return res.status(400).json({ error: 'Tags must be an array' });
    }
    if (tags.some(t => typeof t !== 'string' || t.length > 50)) {
      return res.status(400).json({ error: 'Tags must be strings (max 50 chars each)' });
    }
    
    const result = await upsertPlayerNote(playerName, note, tags);
    res.json({ success: true, note: result });
  } catch (error) {
    logger.error(`Failed to save player note: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Delete player note
router.delete('/notes/:playerName', async (req, res) => {
  try {
    const success = await deletePlayerNote(req.params.playerName);
    res.json({ success });
  } catch (error) {
    logger.error(`Failed to delete player note: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Player Stats (playtime tracking)
// ============================================

// Get all player stats
router.get('/stats', async (req, res) => {
  try {
    const stats = await getPlayerStats();
    res.json({ success: true, stats });
  } catch (error) {
    logger.error(`Failed to get player stats: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get stats for specific player
router.get('/stats/:playerName', async (req, res) => {
  try {
    const stat = await getPlayerStat(req.params.playerName);
    res.json({ success: true, stat });
  } catch (error) {
    logger.error(`Failed to get player stat: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;
