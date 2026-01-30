import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { getDataPaths } from '../utils/paths.js';

// Get paths from central config
const paths = getDataPaths();
const dataDir = paths.dataDir;
const dbPath = paths.dbPath;

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Default data structure
const defaultData = {
  command_history: [],
  scheduled_tasks: [],
  schedule_history: [],
  player_logs: [],
  server_events: [],
  tracked_mods: [],
  servers: [],
  player_notes: [],
  player_stats: [],
  mod_presets: [],
  performance_history: [],
  discord_webhooks: [],
  settings: {}
};

let db = null;

// Write queue to prevent concurrent write issues with LowDB
let writeQueue = Promise.resolve();
let writeQueueLength = 0;
const MAX_QUEUE_LENGTH = 100;

/**
 * Queue a write operation to ensure sequential writes to the database.
 * This prevents race conditions where concurrent writes could overwrite each other.
 */
async function queuedWrite(dbInstance) {
  if (writeQueueLength >= MAX_QUEUE_LENGTH) {
    console.warn('Database write queue is full, waiting for existing writes to complete');
  }
  
  writeQueueLength++;
  
  // Chain the write operation, ensuring errors don't break the queue
  writeQueue = writeQueue
    .catch(() => {
      // Ignore previous errors to keep the chain going
    })
    .then(async () => {
      try {
        await dbInstance.write();
      } catch (err) {
        console.error('Database write error:', err);
        // Don't rethrow - we want the queue to continue
      } finally {
        writeQueueLength--;
      }
    });
  
  return writeQueue;
}

export async function getDb() {
  if (!db) {
    const adapter = new JSONFile(dbPath);
    db = new Low(adapter, defaultData);
    await db.read();
    // Ensure all collections exist
    db.data = { ...defaultData, ...db.data };
    await queuedWrite(db);
  }
  return db;
}

export async function initDatabase() {
  await getDb();
  return db;
}

// Helper to generate unique IDs using UUID to prevent race condition duplicates
function generateId(collection) {
  // Use UUID for guaranteed uniqueness even under concurrent access
  return randomUUID();
}

// Helper to generate sequential numeric IDs (for display purposes only)
function generateNumericId(collection) {
  if (!Array.isArray(collection) || collection.length === 0) return 1;
  return collection.reduce((max, item) => Math.max(max, typeof item.id === 'number' ? item.id : 0), 0) + 1;
}

// Command History
export async function logCommand(command, response, success = true) {
  const db = await getDb();
  // Truncate very long responses to prevent database bloat
  const truncatedResponse = response && response.length > 4096 
    ? response.substring(0, 4096) + '... [truncated]' 
    : response;
  const entry = {
    id: generateId(db.data.command_history),
    command,
    response: truncatedResponse,
    success: success ? 1 : 0,
    executed_at: new Date().toISOString()
  };
  db.data.command_history.unshift(entry);
  // Keep only last 500 commands
  if (db.data.command_history.length > 500) {
    db.data.command_history = db.data.command_history.slice(0, 500);
  }
  await queuedWrite(db);
  return entry;
}

export async function getCommandHistory(limit = 100) {
  const db = await getDb();
  return db.data.command_history.slice(0, limit);
}

// Scheduled Tasks
export async function getScheduledTasks() {
  const db = await getDb();
  return db.data.scheduled_tasks || [];
}

export async function createScheduledTask(name, cronExpression, command) {
  const db = await getDb();
  // Ensure scheduled_tasks is an array
  if (!Array.isArray(db.data.scheduled_tasks)) {
    db.data.scheduled_tasks = [];
  }
  const task = {
    id: generateNumericId(db.data.scheduled_tasks),
    name,
    cron_expression: cronExpression,
    command,
    enabled: 1,
    last_run: null,
    created_at: new Date().toISOString()
  };
  db.data.scheduled_tasks.push(task);
  await queuedWrite(db);
  return task;
}

export async function updateScheduledTask(id, name, cronExpression, command, enabled) {
  const db = await getDb();
  const index = db.data.scheduled_tasks.findIndex(t => t.id === id);
  if (index !== -1) {
    db.data.scheduled_tasks[index] = {
      ...db.data.scheduled_tasks[index],
      name,
      cron_expression: cronExpression,
      command,
      enabled: enabled ? 1 : 0
    };
    await queuedWrite(db);
    return db.data.scheduled_tasks[index];
  }
  return null;
}

export async function deleteScheduledTask(id) {
  const db = await getDb();
  const index = db.data.scheduled_tasks.findIndex(t => t.id === id);
  if (index !== -1) {
    db.data.scheduled_tasks.splice(index, 1);
    await queuedWrite(db);
    return true;
  }
  return false;
}

export async function updateTaskLastRun(id) {
  const db = await getDb();
  const task = db.data.scheduled_tasks.find(t => t.id === id);
  if (task) {
    task.last_run = new Date().toISOString();
    await queuedWrite(db);
  }
}

// Schedule History (execution log for scheduled tasks)
export async function logScheduleExecution(taskId, taskName, command, success, message = null, duration = null) {
  const db = await getDb();
  if (!db.data.schedule_history) db.data.schedule_history = [];
  
  const entry = {
    id: generateId(db.data.schedule_history),
    task_id: taskId,
    task_name: taskName,
    command,
    success: success ? 1 : 0,
    message,
    duration,
    executed_at: new Date().toISOString()
  };
  db.data.schedule_history.unshift(entry);
  // Keep only last 500 history entries
  if (db.data.schedule_history.length > 500) {
    db.data.schedule_history = db.data.schedule_history.slice(0, 500);
  }
  await queuedWrite(db);
  return entry;
}

export async function getScheduleHistory(limit = 100, taskId = null) {
  const db = await getDb();
  if (!db.data.schedule_history) return [];
  
  let history = db.data.schedule_history;
  if (taskId !== null) {
    history = history.filter(h => h.task_id === taskId);
  }
  return history.slice(0, limit);
}

export async function clearScheduleHistory() {
  const db = await getDb();
  db.data.schedule_history = [];
  await queuedWrite(db);
}

// Player Logs
export async function logPlayerAction(playerName, action, details = null) {
  const db = await getDb();
  const entry = {
    id: generateId(db.data.player_logs),
    player_name: playerName,
    action,
    details,
    logged_at: new Date().toISOString()
  };
  db.data.player_logs.unshift(entry);
  // Keep only last 1000 logs
  if (db.data.player_logs.length > 1000) {
    db.data.player_logs = db.data.player_logs.slice(0, 1000);
  }
  await queuedWrite(db);
  return entry;
}

export async function getPlayerLogs(playerName = null, limit = 100) {
  const db = await getDb();
  let logs = db.data.player_logs;
  if (playerName) {
    logs = logs.filter(l => l.player_name === playerName);
  }
  return logs.slice(0, limit);
}

// Server Events
export async function logServerEvent(eventType, message = null) {
  const db = await getDb();
  const entry = {
    id: generateId(db.data.server_events),
    event_type: eventType,
    message,
    created_at: new Date().toISOString()
  };
  db.data.server_events.unshift(entry);
  // Keep only last 500 events
  if (db.data.server_events.length > 500) {
    db.data.server_events = db.data.server_events.slice(0, 500);
  }
  await queuedWrite(db);
  return entry;
}

export async function getServerEvents(limit = 100) {
  const db = await getDb();
  return db.data.server_events.slice(0, limit);
}

// Tracked Mods
export async function getTrackedMods() {
  const db = await getDb();
  return db.data.tracked_mods;
}

export async function addTrackedMod(workshopId, name = null) {
  const db = await getDb();
  const existing = db.data.tracked_mods.find(m => m.workshop_id === workshopId);
  if (existing) {
    existing.name = name || existing.name;
    await queuedWrite(db);
    return existing;
  }
  const mod = {
    id: generateId(db.data.tracked_mods),
    workshop_id: workshopId,
    name,
    last_updated: null,
    last_checked: null,
    update_available: 0,
    created_at: new Date().toISOString()
  };
  db.data.tracked_mods.push(mod);
  await queuedWrite(db);
  return mod;
}

export async function updateModTimestamp(workshopId, lastUpdated) {
  const db = await getDb();
  const mod = db.data.tracked_mods.find(m => m.workshop_id === workshopId);
  if (mod) {
    mod.last_updated = lastUpdated;
    mod.last_checked = new Date().toISOString();
    await queuedWrite(db);
  }
}

export async function setModUpdateAvailable(workshopId, available) {
  const db = await getDb();
  const mod = db.data.tracked_mods.find(m => m.workshop_id === workshopId);
  if (mod) {
    mod.update_available = available ? 1 : 0;
    await queuedWrite(db);
  }
}

export async function removeTrackedMod(workshopId) {
  const db = await getDb();
  const index = db.data.tracked_mods.findIndex(m => m.workshop_id === workshopId);
  if (index !== -1) {
    db.data.tracked_mods.splice(index, 1);
    await queuedWrite(db);
    return true;
  }
  return false;
}

export async function clearModUpdates() {
  const db = await getDb();
  db.data.tracked_mods.forEach(m => {
    m.update_available = 0;
  });
  await queuedWrite(db);
}

// Settings
export async function getSetting(key) {
  const db = await getDb();
  return db.data.settings[key] || null;
}

export async function setSetting(key, value) {
  const db = await getDb();
  db.data.settings[key] = value;
  await queuedWrite(db);
}

export async function getAllSettings() {
  const db = await getDb();
  return db.data.settings;
}

// Server Configurations (Multi-server support)
export async function getServers() {
  const db = await getDb();
  return db.data.servers || [];
}

export async function getServer(id) {
  const db = await getDb();
  return db.data.servers.find(s => s.id === id) || null;
}

export async function getActiveServer() {
  const db = await getDb();
  return db.data.servers.find(s => s.isActive) || db.data.servers[0] || null;
}

export async function createServer(serverConfig) {
  const db = await getDb();
  if (!db.data.servers) db.data.servers = [];
  
  // If this is the first server, make it active
  const isFirst = db.data.servers.length === 0;
  
  const server = {
    id: generateId(db.data.servers),
    name: serverConfig.name || serverConfig.serverName,
    serverName: serverConfig.serverName,
    installPath: serverConfig.installPath,
    zomboidDataPath: serverConfig.zomboidDataPath || null,
    serverConfigPath: serverConfig.serverConfigPath || null,
    branch: serverConfig.branch || 'stable',
    rconHost: serverConfig.rconHost || '127.0.0.1',
    rconPort: serverConfig.rconPort || 27015,
    rconPassword: serverConfig.rconPassword || '',
    serverPort: serverConfig.serverPort || 16261,
    minMemory: serverConfig.minMemory || 4,
    maxMemory: serverConfig.maxMemory || 8,
    useNoSteam: serverConfig.useNoSteam || false,
    useDebug: serverConfig.useDebug || false,
    isActive: isFirst,
    createdAt: new Date().toISOString()
  };
  
  db.data.servers.push(server);
  
  // If this is the first/active server, sync to legacy settings
  if (isFirst) {
    db.data.settings.serverPath = server.installPath;
    db.data.settings.serverName = server.serverName;
    db.data.settings.rconHost = server.rconHost;
    db.data.settings.rconPort = server.rconPort;
    db.data.settings.rconPassword = server.rconPassword;
    db.data.settings.serverPort = server.serverPort;
    db.data.settings.minMemory = server.minMemory;
    db.data.settings.maxMemory = server.maxMemory;
    db.data.settings.zomboidDataPath = server.zomboidDataPath;
    db.data.settings.serverConfigPath = server.serverConfigPath;
  }
  
  await queuedWrite(db);
  return server;
}

export async function updateServer(id, updates) {
  const db = await getDb();
  const index = db.data.servers.findIndex(s => s.id === id);
  if (index !== -1) {
    db.data.servers[index] = {
      ...db.data.servers[index],
      ...updates,
      id, // Prevent id from being overwritten
      updatedAt: new Date().toISOString()
    };
    await queuedWrite(db);
    return db.data.servers[index];
  }
  return null;
}

export async function deleteServer(id) {
  const db = await getDb();
  const index = db.data.servers.findIndex(s => s.id === id);
  if (index !== -1) {
    const wasActive = db.data.servers[index].isActive;
    db.data.servers.splice(index, 1);
    
    // If deleted server was active, make another one active
    if (wasActive && db.data.servers.length > 0) {
      db.data.servers[0].isActive = true;
    }
    
    await queuedWrite(db);
    return true;
  }
  return false;
}

export async function setActiveServer(id) {
  const db = await getDb();
  const server = db.data.servers.find(s => s.id === id);
  if (!server) return null;
  
  // Deactivate all, activate selected
  db.data.servers.forEach(s => {
    s.isActive = s.id === id;
  });
  
  // Also update legacy settings for backwards compatibility
  db.data.settings.serverPath = server.installPath;
  db.data.settings.serverName = server.serverName;
  db.data.settings.rconHost = server.rconHost;
  db.data.settings.rconPort = server.rconPort;
  db.data.settings.rconPassword = server.rconPassword;
  db.data.settings.serverPort = server.serverPort;
  db.data.settings.minMemory = server.minMemory;
  db.data.settings.maxMemory = server.maxMemory;
  db.data.settings.zomboidDataPath = server.zomboidDataPath;
  db.data.settings.serverConfigPath = server.serverConfigPath;
  
  await queuedWrite(db);
  return server;
}

// ============================================
// Player Notes & Tags
// ============================================
export async function getPlayerNotes() {
  const db = await getDb();
  if (!db.data.player_notes) db.data.player_notes = [];
  return db.data.player_notes;
}

export async function getPlayerNote(playerName) {
  const db = await getDb();
  if (!db.data.player_notes) db.data.player_notes = [];
  return db.data.player_notes.find(p => p.player_name.toLowerCase() === playerName.toLowerCase()) || null;
}

export async function upsertPlayerNote(playerName, note, tags = []) {
  const db = await getDb();
  if (!db.data.player_notes) db.data.player_notes = [];
  
  const existingIndex = db.data.player_notes.findIndex(
    p => p.player_name.toLowerCase() === playerName.toLowerCase()
  );
  
  const entry = {
    player_name: playerName,
    note: note || '',
    tags: tags || [],
    updated_at: new Date().toISOString()
  };
  
  if (existingIndex !== -1) {
    db.data.player_notes[existingIndex] = {
      ...db.data.player_notes[existingIndex],
      ...entry
    };
  } else {
    entry.id = generateId(db.data.player_notes);
    entry.created_at = new Date().toISOString();
    db.data.player_notes.push(entry);
  }
  
  await queuedWrite(db);
  return entry;
}

export async function deletePlayerNote(playerName) {
  const db = await getDb();
  if (!db.data.player_notes) return false;
  
  const index = db.data.player_notes.findIndex(
    p => p.player_name.toLowerCase() === playerName.toLowerCase()
  );
  
  if (index !== -1) {
    db.data.player_notes.splice(index, 1);
    await queuedWrite(db);
    return true;
  }
  return false;
}

// ============================================
// Player Stats (playtime tracking)
// ============================================
export async function getPlayerStats() {
  const db = await getDb();
  if (!db.data.player_stats) db.data.player_stats = [];
  return db.data.player_stats;
}

export async function getPlayerStat(playerName) {
  const db = await getDb();
  if (!db.data.player_stats) db.data.player_stats = [];
  return db.data.player_stats.find(p => p.player_name.toLowerCase() === playerName.toLowerCase()) || null;
}

export async function recordPlayerSession(playerName, action) {
  const db = await getDb();
  if (!db.data.player_stats) db.data.player_stats = [];
  
  let playerStat = db.data.player_stats.find(
    p => p.player_name.toLowerCase() === playerName.toLowerCase()
  );
  
  const now = new Date().toISOString();
  
  if (!playerStat) {
    playerStat = {
      id: generateId(db.data.player_stats),
      player_name: playerName,
      total_playtime_seconds: 0,
      session_count: 0,
      first_seen: now,
      last_seen: now,
      last_session_start: null,
      sessions: []
    };
    db.data.player_stats.push(playerStat);
  }
  
  if (action === 'connect') {
    playerStat.last_session_start = now;
    playerStat.last_seen = now;
    playerStat.session_count++;
  } else if (action === 'disconnect' && playerStat.last_session_start) {
    const sessionStart = new Date(playerStat.last_session_start);
    const sessionEnd = new Date(now);
    const sessionDuration = Math.floor((sessionEnd - sessionStart) / 1000);
    
    playerStat.total_playtime_seconds += sessionDuration;
    playerStat.last_seen = now;
    
    // Keep last 50 sessions
    if (!playerStat.sessions) playerStat.sessions = [];
    playerStat.sessions.unshift({
      start: playerStat.last_session_start,
      end: now,
      duration_seconds: sessionDuration
    });
    if (playerStat.sessions.length > 50) {
      playerStat.sessions = playerStat.sessions.slice(0, 50);
    }
    
    playerStat.last_session_start = null;
  }
  
  await queuedWrite(db);
  return playerStat;
}

// ============================================
// Performance History (for graphs)
// ============================================
export async function recordPerformanceSnapshot(snapshot) {
  const db = await getDb();
  if (!db.data.performance_history) db.data.performance_history = [];
  
  const entry = {
    timestamp: new Date().toISOString(),
    ...snapshot
  };
  
  db.data.performance_history.push(entry);
  
  // Keep last 1440 entries (24 hours at 1 minute intervals)
  if (db.data.performance_history.length > 1440) {
    db.data.performance_history = db.data.performance_history.slice(-1440);
  }
  
  await queuedWrite(db);
  return entry;
}

export async function getPerformanceHistory(limit = 60) {
  const db = await getDb();
  if (!db.data.performance_history) return [];
  return db.data.performance_history.slice(-limit);
}

// ============================================
// Mod Presets
// ============================================
export async function getModPresets() {
  const db = await getDb();
  if (!db.data.mod_presets) db.data.mod_presets = [];
  return db.data.mod_presets;
}

export async function createModPreset(name, description, mods, workshopIds, maps) {
  const db = await getDb();
  if (!db.data.mod_presets) db.data.mod_presets = [];
  
  const preset = {
    id: generateId(db.data.mod_presets),
    name,
    description: description || '',
    mods: mods || [],
    workshop_ids: workshopIds || [],
    maps: maps || [],
    created_at: new Date().toISOString()
  };
  
  db.data.mod_presets.push(preset);
  await queuedWrite(db);
  return preset;
}

export async function updateModPreset(id, updates) {
  const db = await getDb();
  if (!db.data.mod_presets) return null;
  
  const index = db.data.mod_presets.findIndex(p => p.id === id);
  if (index !== -1) {
    db.data.mod_presets[index] = {
      ...db.data.mod_presets[index],
      ...updates,
      updated_at: new Date().toISOString()
    };
    await queuedWrite(db);
    return db.data.mod_presets[index];
  }
  return null;
}

export async function deleteModPreset(id) {
  const db = await getDb();
  if (!db.data.mod_presets) return false;
  
  const index = db.data.mod_presets.findIndex(p => p.id === id);
  if (index !== -1) {
    db.data.mod_presets.splice(index, 1);
    await queuedWrite(db);
    return true;
  }
  return false;
}
