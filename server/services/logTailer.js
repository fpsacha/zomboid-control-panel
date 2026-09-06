import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';
const log = createLogger('LogTailer');
import { getActiveServer, getSetting } from '../database/init.js';

// Build 42 creates its built-in chat rooms in a fixed order, so the Q-shout
// room is always id 2 (0 = General, 1 = Say). Both the say and the shout room
// report `chat=Local` in the message payload, so the id is the only thing that
// separates a yell from ordinary talking.
const SHOUT_CHAT_ROOM_ID = 2;

const DELIVERY_LINE = /Message ChatMessage\{chat=([^,]+),\s*author='(.*?)',\s*text='(.*)'\} sent to chat \(id = (\d+)\)/;

export function chatMessageKey(chatType, author, text) {
  return `${chatType}\u0000${author}\u0000${text}`;
}

// PZ logs a message twice: once on receipt (no room id) and once on delivery
// (with the room id). Pair them up so the receipt line can be labelled.
export function collectChatRoomIds(lines) {
  const ids = new Map();
  for (const line of lines) {
    const m = line.match(DELIVERY_LINE);
    if (!m) continue;
    const key = chatMessageKey(m[1].trim(), m[2], m[3]);
    const bucket = ids.get(key);
    if (bucket) bucket.push(Number(m[4]));
    else ids.set(key, [Number(m[4])]);
  }
  return ids;
}

export class LogTailer extends EventEmitter {
  constructor() {
    super();
    this.logPath = null;       // server-console.txt (legacy B41 chat source)
    this.chatLogPath = null;   // B42 dedicated chat log file (Logs/*_chat.txt)
    this.chatLogSize = 0;
    this.currentSize = 0;
    this.userLogPath = null;   // B42 player event log (Logs/*_user.txt) — only deaths are parsed
    this.userLogSize = 0;
    this.isWatching = false;
    this.checkTimer = null;
    this.logsDir = null;       // Path to Logs/ directory for chat/user log discovery
    this.basePath = null;      // Zomboid data dir, kept so paths can be re-resolved
    // Files created after this point are new sessions and must be read whole;
    // files that already existed are skipped to the end so a panel restart
    // doesn't replay history.
    this.watchStartedAt = Date.now();
    // A poll can land mid-line; the tail of each chunk is held back until the
    // rest of the line arrives, otherwise the message is dropped by both reads.
    this.consoleRemainder = '';
    this.chatRemainder = '';
    this.userRemainder = '';
  }

  // Where to start reading a newly discovered file. A file born after we
  // started watching is a fresh session, so every byte in it is unseen.
  //
  // 2026-08-29 (Linux gate flake investigation, second suspect): `born` and
  // `this.watchStartedAt` come from two different clocks -- the filesystem's
  // birthtime and the JS process's Date.now() -- which measured up to ~20ms
  // apart from each other on the same real event on this platform (WSL2),
  // in either direction, not just jitter around zero. Harmless at the scale
  // this actually runs at in production: a real prior session's log predates
  // a fresh watch by however long that session's own downtime was (seconds
  // at an absolute minimum, since PZ itself takes real time to boot before
  // it can write anything), which swamps a ~20ms clock disagreement.
  // Do NOT compare `born` against a Date.now()-derived value at a
  // deliberately tight timescale (a test, a synthetic benchmark) without
  // accounting for this -- it will look racy even though production never
  // operates in the regime where it matters. A prior version of the test
  // covering this constructed the tailer (capturing watchStartedAt) BEFORE
  // creating the "already existing" file it was supposed to represent,
  // which is backwards from how this is ever true in production and is
  // exactly the tight regime where the clock skew becomes visible.
  startOffsetFor(filePath, firstDiscovery) {
    try {
        const stats = fs.statSync(filePath);
        const born = stats.birthtimeMs || 0;
        if (!firstDiscovery || (born > 0 && born >= this.watchStartedAt)) return 0;
        return stats.size;
    } catch (e) {
        log.debug(`LogTailer: stat failed for ${filePath}: ${e.message}`);
        return 0;
    }
  }

  async init() {
    await this.findLogPath();
    // Watch even when nothing was found yet: on a first boot the Logs/ folder
    // and server-console.txt only appear once the game server has started.
    this.startWatching();
  }

  // Repoint at the (new) active server's log paths. Without this, switching
  // the active server left every path (basePath, logPath, chatLogPath,
  // userLogPath) pinned to whichever server was active when they were first
  // resolved: reresolvePaths() and findLatestChatLog/findLatestUserLog only
  // rescan for a *newer* file inside the current logsDir, so they keep
  // faithfully following the OLD server's own log rotations forever,
  // showing every sign of working while the operator has switched to a
  // different server. Nulling the discovery state before re-running
  // findLogPath() forces it to re-read the (now updated) active server's
  // zomboidDataPath and rediscover everything under it, and reusing
  // findLogPath's own firstDiscovery/startOffsetFor logic means we pick up
  // the new server's current log tail rather than replaying its history.
  async reloadConfig() {
    this.basePath = null;
    this.logsDir = null;
    this.logPath = null;
    this.chatLogPath = null;
    this.chatLogSize = 0;
    this.currentSize = 0;
    this.userLogPath = null;
    this.userLogSize = 0;
    this.consoleRemainder = '';
    this.chatRemainder = '';
    this.userRemainder = '';
    await this.findLogPath();
    log.info(`LogTailer repointed (console: ${this.logPath || 'none'}, chatLog: ${this.chatLogPath || 'none'}, userLog: ${this.userLogPath || 'none'})`);
  }

  async findLogPath() {
    try {
        const activeServer = await getActiveServer();
        const homeDir = os.homedir();
        let basePath = process.env.PZ_SAVE_PATH || (homeDir ? path.join(homeDir, 'Zomboid') : '');

        if (activeServer?.zomboidDataPath) {
            basePath = activeServer.zomboidDataPath;
        } else {
            const settingPath = await getSetting('zomboidDataPath');
            if (settingPath) basePath = settingPath;
        }
        this.basePath = basePath;

        // server-console.txt (B41 chat via [chat] markers, also general log tailing)
        const consoleLogPath = path.join(basePath, 'server-console.txt');
        if (fs.existsSync(consoleLogPath)) {
            // Verify we can actually read the file (ownership/permissions may differ on Linux)
            try {
                fs.accessSync(consoleLogPath, fs.constants.R_OK);
                this.logPath = consoleLogPath;
                log.info(`Found console log at ${consoleLogPath}`);
            } catch (e) {
                log.warn(`Console log exists but is not readable (check permissions): ${consoleLogPath}`);
            }
        } else {
            log.warn(`Could not find server-console.txt at ${consoleLogPath}`);
        }

        // B42 dedicated logs: Logs/*_chat.txt + Logs/*_user.txt
        const logsDir = path.join(basePath, 'Logs');
        if (fs.existsSync(logsDir)) {
            this.logsDir = logsDir;
            this.findLatestChatLog();
            this.findLatestUserLog();
        }

    } catch (e) {
        log.error(`Error finding log path: ${e.stack || e.message}`);
    }
  }

  // The console log and the Logs/ folder are created by the game server, which
  // may not have started yet when the panel boots.
  reresolvePaths() {
    if (!this.basePath) return;
    if (!this.logPath) {
        const consoleLogPath = path.join(this.basePath, 'server-console.txt');
        try {
            fs.accessSync(consoleLogPath, fs.constants.R_OK);
            this.logPath = consoleLogPath;
            this.currentSize = this.startOffsetFor(consoleLogPath, true);
            log.info(`Found console log at ${consoleLogPath}`);
        } catch {
            /* not there yet */
        }
    }
    if (!this.logsDir) {
        const logsDir = path.join(this.basePath, 'Logs');
        if (fs.existsSync(logsDir)) {
            this.logsDir = logsDir;
            log.info(`Found Logs directory at ${logsDir}`);
        }
    }
  }

  // Find the most recently modified *_chat.txt in the Logs/ directory.
  //
  // 2026-08-29 (Linux gate flake investigation): two files sharing the exact
  // same mtimeMs is real, not theoretical -- confirmed on real ext4 with
  // fs.utimesSync forcing a tie, which is a realistic stand-in for PZ
  // touching an outgoing session's log and a new session's log within the
  // same filesystem timestamp tick at a restart boundary. When mtime ties,
  // `b.mtime - a.mtime` is 0 for that pair, and the sort falls back to
  // Array.prototype.sort's stability, i.e. whichever order fs.readdirSync
  // happened to return -- an OS/filesystem implementation detail this code
  // never decided and cannot rely on, confirmed to pick the OLDER file in
  // that reproduction. Silently: no error, nothing in the UI, chat/admin
  // view just stops updating -- the tailer keeps reading the ended session's
  // file forever, since nothing ever notices the swap should have happened.
  //
  // Tiebreak is birthtimeMs, not filename: PZ's real log-naming format
  // could not be verified against actual game source in this environment
  // (no PZ install/jar available to check), so a filename-based tiebreak
  // would be relying on an assumption this investigation could not confirm
  // is lexicographically sane. birthtimeMs is something this file already
  // trusts (see startOffsetFor above) and needs no format assumption: it
  // directly answers "which of these two files came into existence more
  // recently", which for two different PZ sessions' log files reflects a
  // real gap (however long that session ran), even on the rarer occasions
  // their mtimes coincide. Confirmed by reproduction: birthtimeMs alone can
  // ALSO tie for two files created microseconds apart with no real elapsed
  // time between them (this platform's timestamp resolution is coarser than
  // that), but does not tie once even a small (tens-of-ms) real gap
  // separates the two files' creation -- which is what distinguishes two
  // genuinely different PZ sessions' logs in practice.
  findLatestChatLog() {
    if (!this.logsDir) return;
    try {
        const files = fs.readdirSync(this.logsDir)
            .filter(f => f.endsWith('_chat.txt'))
            .map(f => {
                const full = path.join(this.logsDir, f);
                try {
                    const stats = fs.statSync(full);
                    return { path: full, mtime: stats.mtimeMs, birthtime: stats.birthtimeMs };
                }
                catch { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => (b.mtime - a.mtime) || (b.birthtime - a.birthtime));

        if (files.length > 0) {
            const latest = files[0].path;
            if (latest !== this.chatLogPath) {
                const firstDiscovery = !this.chatLogPath;
                this.chatLogPath = latest;
                this.chatRemainder = '';
                this.chatLogSize = this.startOffsetFor(latest, firstDiscovery);
                log.info(`Tailing B42 chat log: ${latest}`);
            }
        }
    } catch (e) {
        log.debug(`Error scanning chat logs: ${e.message}`);
    }
  }

  // Find the most recently modified *_user.txt in the Logs/ directory
  // (PZ records player join/leave/death events here). Same mtime-tie
  // tiebreak as findLatestChatLog above -- see its comment for why
  // birthtimeMs, not filename order.
  findLatestUserLog() {
    if (!this.logsDir) return;
    try {
        const files = fs.readdirSync(this.logsDir)
            .filter(f => f.endsWith('_user.txt'))
            .map(f => {
                const full = path.join(this.logsDir, f);
                try {
                    const stats = fs.statSync(full);
                    return { path: full, mtime: stats.mtimeMs, birthtime: stats.birthtimeMs };
                }
                catch { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => (b.mtime - a.mtime) || (b.birthtime - a.birthtime));

        if (files.length > 0) {
            const latest = files[0].path;
            if (latest !== this.userLogPath) {
                const firstDiscovery = !this.userLogPath;
                this.userLogPath = latest;
                this.userRemainder = '';
                this.userLogSize = this.startOffsetFor(latest, firstDiscovery);
                log.info(`Tailing B42 user log: ${latest}`);
            }
        }
    } catch (e) {
        log.debug(`Error scanning user logs: ${e.message}`);
    }
  }

  async startWatching() {
    if (this.isWatching) return;

    try {
        if (this.logPath && fs.existsSync(this.logPath)) {
            const stats = fs.statSync(this.logPath);
            this.currentSize = stats.size;
        }

        log.info(`Started watching (console: ${this.logPath || 'none'}, chatLog: ${this.chatLogPath || 'none'}, userLog: ${this.userLogPath || 'none'})`);

        this.isWatching = true;
        this.checkLoop();
    } catch (e) {
        log.error(`Failed to start watching: ${e.message}`);
        this.isWatching = false;
    }
  }

  stopWatching() {
     log.info('LogTailer stopping...');
     if (this.checkTimer) {
         clearTimeout(this.checkTimer);
         this.checkTimer = null;
     }
     this.isWatching = false;
  }

  async checkLoop() {
      if (!this.isWatching) return;

      this.reresolvePaths();
      await this.checkConsoleLog();
      await this.checkChatLog();
      await this.checkUserLog();

      if (this.isWatching) {
          this.checkTimer = setTimeout(() => this.checkLoop(), 2000);
      }
  }

  // Tail server-console.txt (legacy B41 [chat] lines)
  async checkConsoleLog() {
     if (!this.logPath) return;
     try {
         let stats;
         try { stats = await fs.promises.stat(this.logPath); } catch (e) {
           log.debug(`LogTailer: console log stat failed: ${e.message}`);
           return;
         }

         if (stats.size > this.currentSize) {
             const bytesToRead = stats.size - this.currentSize;
             if (bytesToRead > 1024 * 1024) {
                 log.warn(`Console log grew by ${Math.round(bytesToRead / 1024)}KB since the last poll — skipping the burst`);
                 this.currentSize = stats.size;
                 this.consoleRemainder = '';
                 return;
             }
             const data = await this.readChunk(this.logPath, this.currentSize, stats.size);
             this.currentSize = stats.size;
             if (data) this.processConsoleData(data);
         } else if (stats.size < this.currentSize) {
             this.currentSize = 0;
             this.consoleRemainder = '';
         }
     } catch (e) {
       log.debug(`LogTailer: console log polling error: ${e.message}`);
     }
  }

  // Tail the active B42 *_chat.txt file
  async checkChatLog() {
     // Re-discover latest chat log periodically (PZ creates new ones on restart)
     if (this.logsDir) {
       const prevChatLog = this.chatLogPath;
       this.findLatestChatLog();
       if (this.chatLogPath && this.chatLogPath !== prevChatLog) {
         log.info(`LogTailer: new chat log discovered: ${this.chatLogPath}`);
       }
     }
     if (!this.chatLogPath) return;

     try {
         let stats;
         try { stats = await fs.promises.stat(this.chatLogPath); } catch (e) {
           log.debug(`LogTailer: chat log stat failed: ${e.message}`);
           return;
         }

         if (stats.size > this.chatLogSize) {
             const bytesToRead = stats.size - this.chatLogSize;
             if (bytesToRead > 1024 * 1024) {
                 log.warn(`Chat log grew by ${Math.round(bytesToRead / 1024)}KB since the last poll — skipping the burst, those messages will not reach Discord`);
                 this.chatLogSize = stats.size;
                 this.chatRemainder = '';
                 return;
             }
             const data = await this.readChunk(this.chatLogPath, this.chatLogSize, stats.size);
             this.chatLogSize = stats.size;
             if (data) this.processChatLogData(data);
         } else if (stats.size < this.chatLogSize) {
             this.chatLogSize = 0;
             this.chatRemainder = '';
         }
     } catch (e) {
       log.debug(`LogTailer: chat log polling error: ${e.message}`);
     }
  }

  readChunk(filePath, start, end) {
    return new Promise((resolve) => {
        // `end` is inclusive in createReadStream, so read up to end-1 or the
        // byte at `end` gets replayed as the first byte of the next chunk.
        if (end <= start) return resolve(null);
        const stream = fs.createReadStream(filePath, { start, end: end - 1 });
        let data = '';
        stream.on('data', chunk => data += chunk);
        stream.on('end', () => resolve(data));
        stream.on('error', () => resolve(null));
    });
  }

  // Splits a chunk into complete lines, holding any trailing partial line back
  // until the rest of it is written. The cap stops a newline-free file from
  // growing the buffer without limit.
  _splitLines(data, remainderKey) {
    const lines = (this[remainderKey] + data).split(/\r?\n/);
    let remainder = lines.pop() ?? '';
    if (remainder.length > 64 * 1024) remainder = '';
    this[remainderKey] = remainder;
    return lines;
  }

  // Parse server-console.txt lines (B41-style [chat] markers)
  processConsoleData(data) {
    const lines = this._splitLines(data, 'consoleRemainder');
    for (const line of lines) {
        if (!line.trim()) continue;
        if (line.includes('[chat]')) {
            const cleanLine = line.replace(/^\[.*?\]\s*/, '');
            if (!cleanLine.includes('[chat]')) continue;
            const match = cleanLine.match(/<([^>]+)>\s+(.*)/);
            if (match) {
                this.emit('chatMessage', {
                    author: match[1],
                    message: match[2],
                    type: 'general',
                    timestamp: new Date()
                });
            }
        }
    }
  }

  // Parse B42 dedicated chat log lines
  // Formats:
  //   Player msg:  [DD-MM-YY HH:MM:SS.mmm][info] Got message:ChatMessage{chat=General, author='user', text='hello'}.
  //   Delivery:    [DD-MM-YY HH:MM:SS.mmm][info] Message ChatMessage{chat=Local, author='user', text='HEY!'} sent to chat (id = 2) members.
  //   Server msg:  [DD-MM-YY HH:MM:SS.mmm] Server alert message: 'text' sent..
  processChatLogData(data) {
    const lines = this._splitLines(data, 'chatRemainder');
    const chatIds = collectChatRoomIds(lines);
    for (const line of lines) {
        if (!line.trim()) continue;

        // Player/admin chat messages
        // Author is matched lazily rather than as "anything but a quote" so a
        // name like O'Brien doesn't fail the whole line.
        const msgMatch = line.match(/Got message:ChatMessage\{chat=([^,]+),\s*author='(.*?)',\s*text='(.*)'\}/);
        if (msgMatch) {
            const chatType = msgMatch[1].trim();
            const author = msgMatch[2];
            const text = msgMatch[3];
            // PZ names both the say and the shout room "Local"; only the room
            // id on the delivery line tells them apart.
            const roomIds = chatIds.get(chatMessageKey(chatType, author, text));
            const roomId = roomIds && roomIds.length ? roomIds.shift() : null;
            const sourceChatType =
                chatType === 'Local' && roomId === SHOUT_CHAT_ROOM_ID
                    ? 'Shout'
                    : chatType;
            // Map PZ chat types to our types
            let type = 'general';
            if (chatType === 'Admin chat') type = 'admin';
            else if (chatType === 'Server Alert' || chatType === 'Server chat') type = 'server';
            else if (chatType === 'Local') type = 'general';
            else if (chatType === 'Shout') type = 'general';

            this.emit('chatMessage', {
                author,
                message: text,
                type,
                sourceChatType,
                timestamp: new Date()
            });
            continue;
        }

        // Server alert messages (from RCON servermsg)
        const alertMatch = line.match(/Server alert message: '(.+)' sent\.\./);
        if (alertMatch) {
            this.emit('chatMessage', {
                author: 'Server',
                message: alertMatch[1],
                type: 'server',
                timestamp: new Date()
            });
        }
    }
  }

    // Tail the active B42 *_user.txt file. It records joins and leaves too,
    // but only deaths are parsed — presence comes from PanelBridge and RCON.
  async checkUserLog() {
     if (this.logsDir) {
       const prev = this.userLogPath;
       this.findLatestUserLog();
       if (this.userLogPath && this.userLogPath !== prev) {
         log.info(`LogTailer: new user log discovered: ${this.userLogPath}`);
       }
     }
     if (!this.userLogPath) return;

     try {
         let stats;
         try { stats = await fs.promises.stat(this.userLogPath); } catch (e) {
           log.debug(`LogTailer: user log stat failed: ${e.message}`);
           return;
         }

         if (stats.size > this.userLogSize) {
             const bytesToRead = stats.size - this.userLogSize;
             if (bytesToRead > 1024 * 1024) {
                 log.warn(`User log grew by ${Math.round(bytesToRead / 1024)}KB since the last poll — skipping the burst`);
                 this.userLogSize = stats.size;
                 this.userRemainder = '';
                 return;
             }
             const data = await this.readChunk(this.userLogPath, this.userLogSize, stats.size);
             this.userLogSize = stats.size;
             if (data) this.processUserLogData(data);
         } else if (stats.size < this.userLogSize) {
             this.userLogSize = 0;
             this.userRemainder = '';
         }
     } catch (e) {
       log.debug(`LogTailer: user log polling error: ${e.message}`);
     }
  }

  // Parse B42 user.txt lines.
  // Death format example:
  //   [29-05-26 17:42:08.123] user Bob died at (2384,5923,0) (non pvp).
  //   [29-05-26 17:42:08.123] user Bob died at (2384,5923,0) (pvp).
  // Username may contain spaces; we anchor on the " died at " marker.
  processUserLogData(data) {
    const lines = this._splitLines(data, 'userRemainder');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const deathMatch = trimmed.match(/user\s+(.+?)\s+died at\s+\((-?\d+),(-?\d+),(-?\d+)\)\s*(?:\((non\s*pvp|pvp)\))?/i);
        if (deathMatch) {
            const player = deathMatch[1];
            const x = parseInt(deathMatch[2], 10);
            const y = parseInt(deathMatch[3], 10);
            const z = parseInt(deathMatch[4], 10);
            const pvp = (deathMatch[5] || '').toLowerCase() === 'pvp';
            this.emit('playerDeath', {
                player,
                x, y, z,
                pvp,
                location: `${x},${y},${z}`,
                timestamp: new Date(),
            });
        }
    }
  }
}
