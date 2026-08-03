import express from 'express';
import { createLogger } from '../utils/logger.js';
const log = createLogger('API:Players');
import {
  logPlayerAction,
  getPlayerLogs,
  getPlayerNotes,
  getPlayerNote,
  upsertPlayerNote,
  deletePlayerNote,
  getPlayerStats,
  getPlayerStat,
  getSteamIdBans,
  addSteamIdBan,
  removeSteamIdBan
} from '../database/init.js';
import { VEHICLES, PERKS, PERK_CATALOG, ACCESS_LEVELS } from '../utils/commands.js';
import { sanitizeError } from '../utils/sanitize.js';
import bridge from '../services/panelBridge.js';

const router = express.Router();

// Validation helpers to prevent RCON command injection
// Allow normal in-game names (spaces/symbols) but block control chars and quote/backslash.
const USERNAME_REGEX = /^[^\x00-\x1F\x7F"\\]{1,64}$/;
const SAFE_TEXT_REGEX = /^[a-zA-Z0-9\s.,!?'":;()@#&+=%_\-\u00C0-\u024F]{0,256}$/;
// Mirrors the add-vehicle check below: item names legitimately start with a
// digit (all rifle ammunition, and mod vehicle parts named by model year) and
// weapon-attachment mods use - and &. Quotes, backslashes and whitespace stay
// excluded, which is what matters for the RCON command this is spliced into.
const ITEM_REGEX = /^[A-Za-z0-9_]+\.[A-Za-z0-9_&-]+$/;

function isValidUsername(username) {
  if (typeof username !== 'string') return false;
  const trimmed = username.trim();
  return trimmed.length > 0 && USERNAME_REGEX.test(trimmed);
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

// B42's godmod/invisible commands only accept the "-true" value form and ignore
// a target username, so over RCON — which has no player of its own — they are
// a no-op. PanelBridge sets the flag on the player object instead.
async function setPlayerMode(req, bridgeAction, rconMethod, username, enabled) {
  if (bridge.isRunning) {
    const result = await bridge.sendCommand(bridgeAction, { username, enabled: enabled === true });
    return { ...result, via: 'bridge' };
  }
  const result = await req.app.get('rconService')[rconMethod](username, enabled);
  return {
    ...result,
    via: 'rcon',
    warning: 'PanelBridge is offline; RCON cannot target another player for this command.',
  };
}

// Get player activity logs
router.get('/activity', async (req, res) => {
  try {
    const { player, limit = 100 } = req.query;
    const logs = await getPlayerLogs(player || null, parseInt(limit, 10));
    res.json({ success: true, logs });
  } catch (error) {
    log.error(`Failed to get player activity logs: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get all connected players
router.get('/', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const result = await rconService.getPlayers();

    const io = req.app.get('io');
    if (io && result.success) {
      io.to('players').emit('players:update', result.players);
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to get players: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
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
    log.info(`POST /kick: ${username} (reason=${reason || 'none'})`);
    await logPlayerAction(username, 'kick', reason);

    res.json(result);
  } catch (error) {
    log.error(`Failed to kick player: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
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
    log.info(`POST /ban: ${username} (banIp=${banIp}, reason=${reason || 'none'})`);
    await logPlayerAction(username, 'ban', `IP: ${banIp}, Reason: ${reason}`);

    res.json(result);
  } catch (error) {
    log.error(`Failed to ban player: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
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
    log.info(`POST /unban: ${username}`);
    await logPlayerAction(username, 'unban', null);

    res.json(result);
  } catch (error) {
    log.error(`Failed to unban player: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
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
    log.info(`POST /access-level: ${username} → ${level}`);
    await logPlayerAction(username, 'access_level', level);

    res.json(result);
  } catch (error) {
    log.error(`Failed to set access level: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
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
    log.info(`POST /whitelist/add: ${username}`);
    await logPlayerAction(username, 'whitelist_add', null);

    res.json(result);
  } catch (error) {
    log.error(`Failed to add to whitelist: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
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
    log.info(`POST /whitelist/remove: ${username}`);
    await logPlayerAction(username, 'whitelist_remove', null);

    res.json(result);
  } catch (error) {
    log.error(`Failed to remove from whitelist: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Teleport player
router.post('/teleport', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    let { player1, player2, x, y, z } = req.body;

    // Backward compatibility: allow coordinates to be sent as "x,y,z" in player2
    if ((x === undefined || y === undefined || z === undefined) && typeof player2 === 'string' && player2.includes(',')) {
      const parts = player2.split(',').map(part => part.trim());
      if (parts.length >= 2) {
        [x, y] = parts;
        z = parts[2] ?? '0';
        player2 = undefined;
      }
    }

    let result;
    if (x !== undefined && y !== undefined && z !== undefined) {
      // Validate coordinates. B42 vanilla map extends past 16800 and modded maps
      // (Normandy, etc.) go further, so cap at 24000 to match the Lua handler.
      // z is floor level 0-8.
      if (!isValidNumber(x, 0, 24000) || !isValidNumber(y, 0, 24000) || !isValidNumber(z, 0, 8)) {
        return res.status(400).json({ error: 'Invalid coordinates (x/y: 0 to 24000, z: 0 to 8)' });
      }
      if (player1) {
        log.info(`POST /teleport: ${player1} → coords(${x}, ${y}, ${z}) via PanelBridge`);
        // Teleport a specific player to coordinates — requires PanelBridge
        // (RCON 'teleportto' is a self-teleport and doesn't accept a target player)
        if (!isValidUsername(player1)) {
          return res.status(400).json({ error: 'Invalid player1 username format' });
        }
        if (!bridge.isRunning) {
          return res.status(503).json({ error: 'PanelBridge is not running — cannot teleport a player to coordinates without it' });
        }
        result = await bridge.teleportPlayer(player1, Number(x), Number(y), Number(z));
      } else {
        // No target player — admin self-teleport via RCON
        result = await rconService.teleportTo(x, y, z);
      }
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
    log.error(`Failed to teleport: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
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

    if (count !== undefined && !isValidNumber(count, 1, 100)) {
      return res.status(400).json({ error: 'Invalid count (1-100)' });
    }
    const itemCount = count !== undefined ? Math.min(Math.floor(Number(count)), 100) : 1;

    if (!username) {
      return res.status(400).json({ error: 'A player must be selected to give items' });
    }

    let result;
    // Use RCON for additem — PZ handles inventory sync to client correctly via RCON
    // PanelBridge's inventory:AddItem() works server-side but client doesn't see items until relog
    result = await rconService.addItem(username, item, itemCount);
    log.info(`POST /add-item: ${item} x${itemCount} to ${username} via RCON`);
    if (username) {
      await logPlayerAction(username, 'add_item', `${item} x${itemCount}`);
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to add item: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Add XP to player
router.post('/add-xp', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, perk, amount } = req.body;

    if (!username || !perk || amount === undefined || amount === null) {
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
    log.info(`POST /add-xp: ${perk}=${amount} to ${username}`);
    await logPlayerAction(username, 'add_xp', `${perk}=${amount}`);

    res.json(result);
  } catch (error) {
    log.error(`Failed to add XP: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
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

    // Validate vehicle ID format (e.g., "Base.CarNormal", "mod.VehicleName")
    // Allows catalog-scanned vehicles beyond the static VEHICLES list
    if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(vehicle)) {
      return res.status(400).json({ error: 'Invalid vehicle ID format' });
    }

    if (username && !isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }

    const result = await rconService.addVehicle(vehicle, username);
    log.info(`POST /add-vehicle: ${vehicle} for ${username || 'self'}`);
    if (username) {
      await logPlayerAction(username, 'add_vehicle', vehicle);
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to spawn vehicle: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// God mode
router.post('/godmode', async (req, res) => {
  try {
    const { username, enabled } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }

    const result = await setPlayerMode(req, 'setGodMode', 'setGodMode', username, enabled);
    log.info(`POST /godmode: ${username} → ${enabled ? 'ON' : 'OFF'} via ${result.via}`);
    await logPlayerAction(username, 'godmode', enabled ? 'enabled' : 'disabled');

    res.json(result);
  } catch (error) {
    log.error(`Failed to set godmode: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Invisible
router.post('/invisible', async (req, res) => {
  try {
    const { username, enabled } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }

    const result = await setPlayerMode(req, 'setInvisible', 'setInvisible', username, enabled);
    log.info(`POST /invisible: ${username} → ${enabled ? 'ON' : 'OFF'} via ${result.via}`);
    await logPlayerAction(username, 'invisible', enabled ? 'enabled' : 'disabled');

    res.json(result);
  } catch (error) {
    log.error(`Failed to set invisible: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Noclip
router.post('/noclip', async (req, res) => {
  try {
    const { username, enabled } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }

    const result = await setPlayerMode(req, 'setNoclip', 'setNoclip', username, enabled);
    log.info(`POST /noclip: ${username} → ${enabled ? 'ON' : 'OFF'} via ${result.via}`);
    await logPlayerAction(username, 'noclip', enabled ? 'enabled' : 'disabled');

    res.json(result);
  } catch (error) {
    log.error(`Failed to set noclip: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get available vehicles
router.get('/vehicles', (req, res) => {
  res.json({ vehicles: VEHICLES });
});

// Get available perks
router.get('/perks', (req, res) => {
  res.json({ perks: PERKS, catalog: PERK_CATALOG });
});

// Get access levels
router.get('/access-levels', (req, res) => {
  res.json({ levels: ACCESS_LEVELS });
});

// Get banned SteamIDs
router.get('/steamid-bans', async (req, res) => {
  try {
    const bans = await getSteamIdBans();
    res.json({ bans });
  } catch (error) {
    log.error(`Failed to get SteamID bans: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Ban by SteamID
router.post('/banid', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { steamId, reason } = req.body;
    const normalizedReason = typeof reason === 'string' ? reason.trim() : '';

    if (!steamId) {
      return res.status(400).json({ error: 'SteamID is required' });
    }

    // SteamIDs are numeric strings
    if (!/^\d{17}$/.test(steamId)) {
      return res.status(400).json({ error: 'Invalid SteamID format (must be 17 digits)' });
    }

    if (normalizedReason && !isValidText(normalizedReason)) {
      return res.status(400).json({ error: 'Invalid reason format' });
    }

    const result = await rconService.banSteamId(steamId);
    log.info(`POST /banid: SteamID ${steamId}`);
    await addSteamIdBan(steamId, normalizedReason || null);
    await logPlayerAction(steamId, 'banid', normalizedReason || null);

    res.json(result);
  } catch (error) {
    log.error(`Failed to ban SteamID: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
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
    log.info(`POST /unbanid: SteamID ${steamId}`);
    await removeSteamIdBan(steamId);
    await logPlayerAction(steamId, 'unbanid', null);

    res.json(result);
  } catch (error) {
    log.error(`Failed to unban SteamID: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
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
    log.info(`POST /voiceban: ${username} → ${enabled ? 'ON' : 'OFF'}`);
    await logPlayerAction(username, 'voiceban', enabled ? 'enabled' : 'disabled');

    res.json(result);
  } catch (error) {
    log.error(`Failed to set voice ban: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
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
    log.error(`Failed to add user: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Add all connected players to whitelist
router.post('/whitelist/addall', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const result = await rconService.addAllToWhitelist();

    res.json(result);
  } catch (error) {
    log.error(`Failed to add all to whitelist: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
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
    log.error(`Failed to get player notes: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get note for specific player
router.get('/notes/:playerName', async (req, res) => {
  try {
    const note = await getPlayerNote(req.params.playerName);
    res.json({ success: true, note });
  } catch (error) {
    log.error(`Failed to get player note: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
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
    log.error(`Failed to save player note: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Delete player note
router.delete('/notes/:playerName', async (req, res) => {
  try {
    const success = await deletePlayerNote(req.params.playerName);
    res.json({ success });
  } catch (error) {
    log.error(`Failed to delete player note: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
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
    log.error(`Failed to get player stats: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get stats for specific player
router.get('/stats/:playerName', async (req, res) => {
  try {
    const stat = await getPlayerStat(req.params.playerName);
    res.json({ success: true, stat });
  } catch (error) {
    log.error(`Failed to get player stat: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ============================================
// Character export history
// ============================================
import fs from 'fs';
import path from 'path';
import { getDataPaths } from '../utils/paths.js';

// List all auto-exports (optionally filtered by username)
router.get('/exports', async (req, res) => {
  try {
    const { username } = req.query;
    const { dataDir } = getDataPaths();
    const exportsRoot = path.join(dataDir, 'exports');

    if (!fs.existsSync(exportsRoot)) {
      return res.json({ exports: [] });
    }

    const results = [];

    const players = username
      ? [username.replace(/[^a-zA-Z0-9_-]/g, '_')]
      : fs.readdirSync(exportsRoot).filter(f => {
          try { return fs.statSync(path.join(exportsRoot, f)).isDirectory(); } catch { return false; }
        });

    for (const playerDir of players) {
      const dirPath = path.join(exportsRoot, playerDir);
      if (!fs.existsSync(dirPath)) continue;
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json')).sort().reverse();
      for (const file of files) {
        const stat = fs.statSync(path.join(dirPath, file));
        results.push({
          username: playerDir,
          filename: file,
          size: stat.size,
          timestamp: stat.mtime.toISOString(),
        });
      }
    }

    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    res.json({ exports: results });
  } catch (error) {
    log.error(`Failed to list exports: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Download a specific export file
router.get('/exports/:username/:filename', async (req, res) => {
  try {
    const { username, filename } = req.params;
    // Validate to prevent path traversal
    if (!/^[a-zA-Z0-9_-]+$/.test(username) || !/^[a-zA-Z0-9_.-]+\.json$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }

    const { dataDir } = getDataPaths();
    const filePath = path.join(dataDir, 'exports', username, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Export not found' });
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json(data);
  } catch (error) {
    log.error(`Failed to get export: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Delete a specific export file
router.delete('/exports/:username/:filename', async (req, res) => {
  try {
    const { username, filename } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(username) || !/^[a-zA-Z0-9_.-]+\.json$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }

    const { dataDir } = getDataPaths();
    const filePath = path.join(dataDir, 'exports', username, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Export not found' });
    }

    fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (error) {
    log.error(`Failed to delete export: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
