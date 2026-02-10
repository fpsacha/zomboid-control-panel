import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { getDataPaths } from '../utils/paths.js';

// ============================================
// Database Configuration
// ============================================

const RETENTION = {
  command_history: 500,
  player_logs: 1000,
  server_events: 500,
  schedule_history: 500,
  performance_history: 1440,   // 24h at 1-min intervals
  player_sessions: 50,         // per player
};

const WRITE_DEBOUNCE_MS = 500;          // Coalesce rapid writes
const BACKUP_INTERVAL_MS = 6 * 3600000; // Auto-backup every 6 hours
const MAX_BACKUPS = 5;

// ============================================
// Paths
// ============================================

const paths = getDataPaths();
const dataDir = paths.dataDir;
const dbPath = paths.dbPath;
const backupDir = path.join(dataDir, 'backups');

// Ensure directories exist
for (const dir of [dataDir, backupDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ============================================
// Default Schema
// ============================================

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

// ============================================
// Write Queue (debounced, crash-safe)
// ============================================

let db = null;
let _writeTimer = null;
let _writePromise = null;
let _dirty = false;
let _backupTimer = null;
let _shutdownRegistered = false;

/**
 * Mark the database as dirty and schedule a debounced write.
 * Multiple rapid mutations coalesce into a single disk write.
 */
function scheduleWrite() {
  _dirty = true;

  // If there's already a pending timer, let it handle the write
  if (_writeTimer) return;

  _writeTimer = setTimeout(async () => {
    _writeTimer = null;
    await flushWrites();
  }, WRITE_DEBOUNCE_MS);
}

/**
 * Immediately flush all pending writes to disk.
 * Safe to call multiple times — deduplicates concurrent flushes.
 */
async function flushWrites() {
  if (!_dirty || !db) return;
  _dirty = false;

  // If a write is already in progress, chain after it
  if (_writePromise) {
    try { await _writePromise; } catch { /* swallow */ }
  }

  _writePromise = (async () => {
    try {
      await db.write();
    } catch (err) {
      console.error('[DB] Write error:', err.message);
      _dirty = true; // Re-mark dirty so next scheduleWrite retries
    }
  })();

  await _writePromise;
  _writePromise = null;
}

// ============================================
// Backup System
// ============================================

function createBackup(label = '') {
  try {
    if (!fs.existsSync(dbPath)) return null;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = label ? `-${label}` : '';
    const backupFile = path.join(backupDir, `db-${timestamp}${suffix}.json`);

    fs.copyFileSync(dbPath, backupFile);
    pruneBackups();
    return backupFile;
  } catch (err) {
    console.error('[DB] Backup failed:', err.message);
    return null;
  }
}

function pruneBackups() {
  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('db-') && f.endsWith('.json'))
      .sort()
      .reverse();

    for (const file of files.slice(MAX_BACKUPS)) {
      fs.unlinkSync(path.join(backupDir, file));
    }
  } catch { /* best effort */ }
}

function getLatestBackup() {
  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('db-') && f.endsWith('.json'))
      .sort()
      .reverse();
    return files.length > 0 ? path.join(backupDir, files[0]) : null;
  } catch {
    return null;
  }
}

function startBackupSchedule() {
  if (_backupTimer) clearInterval(_backupTimer);
  _backupTimer = setInterval(() => {
    createBackup('auto');
  }, BACKUP_INTERVAL_MS);
  if (_backupTimer.unref) _backupTimer.unref();
}

// ============================================
// Graceful Shutdown
// ============================================

function registerShutdownHandlers() {
  if (_shutdownRegistered) return;
  _shutdownRegistered = true;

  const shutdown = async (signal) => {
    console.log(`[DB] ${signal} received — flushing writes...`);
    if (_writeTimer) { clearTimeout(_writeTimer); _writeTimer = null; }
    if (_backupTimer) { clearInterval(_backupTimer); _backupTimer = null; }
    await flushWrites();
    createBackup('shutdown');
  };

  process.on('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)));
  process.on('beforeExit', () => shutdown('beforeExit'));
}

// ============================================
// Startup & Initialization
// ============================================

/**
 * Validate and repair the database structure.
 * Ensures all collections exist and have the correct type.
 */
function validateData(data) {
  const repaired = { ...defaultData };

  for (const [key, defaultValue] of Object.entries(defaultData)) {
    if (Array.isArray(defaultValue)) {
      repaired[key] = Array.isArray(data?.[key]) ? data[key] : defaultValue;
    } else if (typeof defaultValue === 'object' && defaultValue !== null) {
      repaired[key] = (typeof data?.[key] === 'object' && !Array.isArray(data?.[key]) && data?.[key] !== null)
        ? data[key]
        : defaultValue;
    } else {
      repaired[key] = data?.[key] ?? defaultValue;
    }
  }

  return repaired;
}

/**
 * Apply retention policies to trim oversized collections.
 */
function compactData(data) {
  const trimArray = (arr, max) => {
    if (Array.isArray(arr) && arr.length > max) return arr.slice(0, max);
    return arr;
  };
  const trimArrayEnd = (arr, max) => {
    if (Array.isArray(arr) && arr.length > max) return arr.slice(-max);
    return arr;
  };

  data.command_history = trimArray(data.command_history, RETENTION.command_history);
  data.player_logs = trimArray(data.player_logs, RETENTION.player_logs);
  data.server_events = trimArray(data.server_events, RETENTION.server_events);
  data.schedule_history = trimArray(data.schedule_history, RETENTION.schedule_history);
  data.performance_history = trimArrayEnd(data.performance_history, RETENTION.performance_history);

  if (Array.isArray(data.player_stats)) {
    for (const stat of data.player_stats) {
      if (Array.isArray(stat.sessions) && stat.sessions.length > RETENTION.player_sessions) {
        stat.sessions = stat.sessions.slice(0, RETENTION.player_sessions);
      }
    }
  }

  return data;
}

export async function getDb() {
  if (!db) {
    // Create startup backup before touching anything
    if (fs.existsSync(dbPath)) {
      createBackup('startup');
    }

    const adapter = new JSONFile(dbPath);
    db = new Low(adapter, defaultData);

    try {
      await db.read();
    } catch (err) {
      console.error('[DB] Failed to read database:', err.message);

      // Attempt recovery from backup
      const backup = getLatestBackup();
      if (backup) {
        console.log(`[DB] Attempting recovery from ${path.basename(backup)}...`);
        try {
          fs.copyFileSync(backup, dbPath);
          await db.read();
          console.log('[DB] Recovery successful!');
        } catch (recoverErr) {
          console.error('[DB] Recovery failed:', recoverErr.message);
          db.data = { ...defaultData };
        }
      } else {
        console.log('[DB] No backup found, starting fresh.');
        db.data = { ...defaultData };
      }
    }

    // Validate structure and compact
    db.data = validateData(db.data);
    db.data = compactData(db.data);
    await db.write();

    // Start periodic backups and register shutdown handlers
    startBackupSchedule();
    registerShutdownHandlers();

    const stats = getDatabaseStatsSync();
    console.log(`[DB] Loaded — ${stats.totalRecords} records, ${stats.fileSizeKB}KB, ${stats.backupCount} backups`);
  }
  return db;
}

export async function initDatabase() {
  await getDb();
  return db;
}

// ============================================
// Database Health & Stats
// ============================================

function getDatabaseStatsSync() {
  const data = db?.data || defaultData;
  let fileSize = 0;
  try { fileSize = fs.statSync(dbPath).size; } catch { /* file may not exist yet */ }

  let backupCount = 0;
  try {
    backupCount = fs.readdirSync(backupDir).filter(f => f.startsWith('db-') && f.endsWith('.json')).length;
  } catch { /* dir may not exist */ }

  return {
    fileSizeBytes: fileSize,
    fileSizeKB: Math.round(fileSize / 1024 * 10) / 10,
    backupCount,
    collections: {
      command_history: data.command_history?.length ?? 0,
      scheduled_tasks: data.scheduled_tasks?.length ?? 0,
      schedule_history: data.schedule_history?.length ?? 0,
      player_logs: data.player_logs?.length ?? 0,
      server_events: data.server_events?.length ?? 0,
      tracked_mods: data.tracked_mods?.length ?? 0,
      servers: data.servers?.length ?? 0,
      player_notes: data.player_notes?.length ?? 0,
      player_stats: data.player_stats?.length ?? 0,
      mod_presets: data.mod_presets?.length ?? 0,
      performance_history: data.performance_history?.length ?? 0,
      discord_webhooks: data.discord_webhooks?.length ?? 0
    },
    totalRecords: Object.values(data).reduce((sum, v) => sum + (Array.isArray(v) ? v.length : 0), 0),
    settingsCount: Object.keys(data.settings || {}).length
  };
}

export async function getDatabaseStats() {
  await getDb();
  return getDatabaseStatsSync();
}

export async function createDatabaseBackup() {
  const file = createBackup('manual');
  return file ? { success: true, file: path.basename(file) } : { success: false };
}

export async function compactDatabase() {
  const db = await getDb();
  const before = getDatabaseStatsSync();
  db.data = compactData(db.data);
  scheduleWrite();
  await flushWrites();
  const after = getDatabaseStatsSync();
  return {
    before: before.totalRecords,
    after: after.totalRecords,
    removed: before.totalRecords - after.totalRecords
  };
}

// ============================================
// ID Generation
// ============================================

function generateId() {
  return randomUUID();
}

function generateNumericId(collection) {
  if (!Array.isArray(collection) || collection.length === 0) return 1;
  return collection.reduce((max, item) => Math.max(max, typeof item.id === 'number' ? item.id : 0), 0) + 1;
}

// ============================================
// Command History
// ============================================

export async function logCommand(command, response, success = true) {
  const db = await getDb();
  const truncatedResponse = response && response.length > 4096
    ? response.substring(0, 4096) + '... [truncated]'
    : response;

  const entry = {
    id: generateId(),
    command,
    response: truncatedResponse,
    success: success ? 1 : 0,
    executed_at: new Date().toISOString()
  };

  db.data.command_history.unshift(entry);
  if (db.data.command_history.length > RETENTION.command_history) {
    db.data.command_history = db.data.command_history.slice(0, RETENTION.command_history);
  }
  scheduleWrite();
  return entry;
}

export async function getCommandHistory(limit = 100) {
  const db = await getDb();
  return db.data.command_history.slice(0, limit);
}

// ============================================
// Scheduled Tasks
// ============================================

export async function getScheduledTasks() {
  const db = await getDb();
  return db.data.scheduled_tasks || [];
}

export async function createScheduledTask(name, cronExpression, command) {
  const db = await getDb();
  if (!Array.isArray(db.data.scheduled_tasks)) db.data.scheduled_tasks = [];

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
  scheduleWrite();
  return task;
}

export async function updateScheduledTask(id, name, cronExpression, command, enabled) {
  const db = await getDb();
  const index = db.data.scheduled_tasks.findIndex(t => t.id === id);
  if (index === -1) return null;

  db.data.scheduled_tasks[index] = {
    ...db.data.scheduled_tasks[index],
    name,
    cron_expression: cronExpression,
    command,
    enabled: enabled ? 1 : 0
  };
  scheduleWrite();
  return db.data.scheduled_tasks[index];
}

export async function deleteScheduledTask(id) {
  const db = await getDb();
  const index = db.data.scheduled_tasks.findIndex(t => t.id === id);
  if (index === -1) return false;

  db.data.scheduled_tasks.splice(index, 1);
  scheduleWrite();
  return true;
}

export async function updateTaskLastRun(id) {
  const db = await getDb();
  const task = db.data.scheduled_tasks.find(t => t.id === id);
  if (task) {
    task.last_run = new Date().toISOString();
    scheduleWrite();
  }
}

// ============================================
// Schedule History
// ============================================

export async function logScheduleExecution(taskId, taskName, command, success, message = null, duration = null) {
  const db = await getDb();
  if (!db.data.schedule_history) db.data.schedule_history = [];

  const entry = {
    id: generateId(),
    task_id: taskId,
    task_name: taskName,
    command,
    success: success ? 1 : 0,
    message,
    duration,
    executed_at: new Date().toISOString()
  };

  db.data.schedule_history.unshift(entry);
  if (db.data.schedule_history.length > RETENTION.schedule_history) {
    db.data.schedule_history = db.data.schedule_history.slice(0, RETENTION.schedule_history);
  }
  scheduleWrite();
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
  scheduleWrite();
}

// ============================================
// Player Logs
// ============================================

export async function logPlayerAction(playerName, action, details = null) {
  const db = await getDb();
  const entry = {
    id: generateId(),
    player_name: playerName,
    action,
    details,
    logged_at: new Date().toISOString()
  };

  db.data.player_logs.unshift(entry);
  if (db.data.player_logs.length > RETENTION.player_logs) {
    db.data.player_logs = db.data.player_logs.slice(0, RETENTION.player_logs);
  }
  scheduleWrite();
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

// ============================================
// Server Events
// ============================================

export async function logServerEvent(eventType, message = null) {
  const db = await getDb();
  const entry = {
    id: generateId(),
    event_type: eventType,
    message,
    created_at: new Date().toISOString()
  };

  db.data.server_events.unshift(entry);
  if (db.data.server_events.length > RETENTION.server_events) {
    db.data.server_events = db.data.server_events.slice(0, RETENTION.server_events);
  }
  scheduleWrite();
  return entry;
}

export async function getServerEvents(limit = 100) {
  const db = await getDb();
  return db.data.server_events.slice(0, limit);
}

// ============================================
// Tracked Mods
// ============================================

export async function getTrackedMods() {
  const db = await getDb();
  return db.data.tracked_mods;
}

export async function addTrackedMod(workshopId, name = null) {
  const db = await getDb();
  const existing = db.data.tracked_mods.find(m => m.workshop_id === workshopId);
  if (existing) {
    existing.name = name || existing.name;
    scheduleWrite();
    return existing;
  }

  const mod = {
    id: generateId(),
    workshop_id: workshopId,
    name,
    last_updated: null,
    last_checked: null,
    update_available: 0,
    created_at: new Date().toISOString()
  };
  db.data.tracked_mods.push(mod);
  scheduleWrite();
  return mod;
}

export async function updateModTimestamp(workshopId, lastUpdated) {
  const db = await getDb();
  const mod = db.data.tracked_mods.find(m => m.workshop_id === workshopId);
  if (mod) {
    mod.last_updated = lastUpdated;
    mod.last_checked = new Date().toISOString();
    scheduleWrite();
  }
}

export async function setModUpdateAvailable(workshopId, available) {
  const db = await getDb();
  const mod = db.data.tracked_mods.find(m => m.workshop_id === workshopId);
  if (mod) {
    mod.update_available = available ? 1 : 0;
    scheduleWrite();
  }
}

export async function removeTrackedMod(workshopId) {
  const db = await getDb();
  const index = db.data.tracked_mods.findIndex(m => m.workshop_id === workshopId);
  if (index === -1) return false;

  db.data.tracked_mods.splice(index, 1);
  scheduleWrite();
  return true;
}

export async function clearModUpdates() {
  const db = await getDb();
  db.data.tracked_mods.forEach(m => { m.update_available = 0; });
  scheduleWrite();
}

// ============================================
// Settings
// ============================================

export async function getSetting(key) {
  const db = await getDb();
  return db.data.settings[key] ?? null;
}

export async function setSetting(key, value) {
  const db = await getDb();
  db.data.settings[key] = value;
  scheduleWrite();
}

export async function getAllSettings() {
  const db = await getDb();
  return db.data.settings;
}

// ============================================
// Server Configurations (Multi-server)
// ============================================

export async function getServers() {
  const db = await getDb();
  return db.data.servers || [];
}

export async function getServer(id) {
  const db = await getDb();
  return db.data.servers.find(s => String(s.id) === String(id)) || null;
}

export async function getActiveServer() {
  const db = await getDb();
  return db.data.servers.find(s => s.isActive) || db.data.servers[0] || null;
}

export async function createServer(serverConfig) {
  const db = await getDb();
  if (!db.data.servers) db.data.servers = [];

  const isFirst = db.data.servers.length === 0;

  const server = {
    id: generateId(),
    name: serverConfig.name || serverConfig.serverName,
    serverName: serverConfig.serverName,
    installPath: serverConfig.installPath || '',
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
    isRemote: serverConfig.isRemote || false,
    isActive: isFirst,
    createdAt: new Date().toISOString()
  };

  db.data.servers.push(server);

  if (isFirst) {
    syncServerToSettings(db, server);
  }

  scheduleWrite();
  return server;
}

export async function updateServer(id, updates) {
  const db = await getDb();
  const index = db.data.servers.findIndex(s => String(s.id) === String(id));
  if (index === -1) return null;

  db.data.servers[index] = {
    ...db.data.servers[index],
    ...updates,
    id,
    updatedAt: new Date().toISOString()
  };
  scheduleWrite();
  return db.data.servers[index];
}

export async function deleteServer(id) {
  const db = await getDb();
  const index = db.data.servers.findIndex(s => String(s.id) === String(id));
  if (index === -1) return false;

  const wasActive = db.data.servers[index].isActive;
  db.data.servers.splice(index, 1);

  if (wasActive && db.data.servers.length > 0) {
    db.data.servers[0].isActive = true;
  }

  scheduleWrite();
  return true;
}

export async function setActiveServer(id) {
  const db = await getDb();
  const server = db.data.servers.find(s => String(s.id) === String(id));
  if (!server) return null;

  db.data.servers.forEach(s => {
    s.isActive = String(s.id) === String(id);
  });

  syncServerToSettings(db, server);
  scheduleWrite();
  return server;
}

/** Sync active server config to legacy flat settings */
function syncServerToSettings(db, server) {
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
    entry.id = generateId();
    entry.created_at = new Date().toISOString();
    db.data.player_notes.push(entry);
  }

  scheduleWrite();
  return entry;
}

export async function deletePlayerNote(playerName) {
  const db = await getDb();
  if (!db.data.player_notes) return false;

  const index = db.data.player_notes.findIndex(
    p => p.player_name.toLowerCase() === playerName.toLowerCase()
  );
  if (index === -1) return false;

  db.data.player_notes.splice(index, 1);
  scheduleWrite();
  return true;
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
      id: generateId(),
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

    if (!playerStat.sessions) playerStat.sessions = [];
    playerStat.sessions.unshift({
      start: playerStat.last_session_start,
      end: now,
      duration_seconds: sessionDuration
    });
    if (playerStat.sessions.length > RETENTION.player_sessions) {
      playerStat.sessions = playerStat.sessions.slice(0, RETENTION.player_sessions);
    }

    playerStat.last_session_start = null;
  }

  scheduleWrite();
  return playerStat;
}

// ============================================
// Performance History
// ============================================

export async function recordPerformanceSnapshot(snapshot) {
  const db = await getDb();
  if (!db.data.performance_history) db.data.performance_history = [];

  const entry = {
    timestamp: new Date().toISOString(),
    ...snapshot
  };

  db.data.performance_history.push(entry);
  if (db.data.performance_history.length > RETENTION.performance_history) {
    db.data.performance_history = db.data.performance_history.slice(-RETENTION.performance_history);
  }

  scheduleWrite();
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
    id: generateId(),
    name,
    description: description || '',
    mods: mods || [],
    workshop_ids: workshopIds || [],
    maps: maps || [],
    created_at: new Date().toISOString()
  };

  db.data.mod_presets.push(preset);
  scheduleWrite();
  return preset;
}

export async function updateModPreset(id, updates) {
  const db = await getDb();
  if (!db.data.mod_presets) return null;

  const index = db.data.mod_presets.findIndex(p => p.id === id);
  if (index === -1) return null;

  db.data.mod_presets[index] = {
    ...db.data.mod_presets[index],
    ...updates,
    updated_at: new Date().toISOString()
  };
  scheduleWrite();
  return db.data.mod_presets[index];
}

export async function deleteModPreset(id) {
  const db = await getDb();
  if (!db.data.mod_presets) return false;

  const index = db.data.mod_presets.findIndex(p => p.id === id);
  if (index === -1) return false;

  db.data.mod_presets.splice(index, 1);
  scheduleWrite();
  return true;
}
