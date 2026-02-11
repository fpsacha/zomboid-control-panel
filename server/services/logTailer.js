import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';
const log = createLogger('LogTailer');
import { getActiveServer, getSetting } from '../database/init.js';

export class LogTailer extends EventEmitter {
  constructor() {
    super();
    this.logPath = null;
    this.watcher = null;
    this.currentSize = 0;
    this.isWatching = false;
    this.checkTimer = null;
    this.debounceTimer = null;
  }

  async init() {
    await this.findLogPath();
    if (this.logPath) {
        this.startWatching();
    }
  }

  async findLogPath() {
    try {
        const activeServer = await getActiveServer();
        // Default Zomboid path logic
        let basePath = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Zomboid') : '';
        
        // Use explicitly configured Zomboid path if available
        if (activeServer?.zomboidDataPath) {
            basePath = activeServer.zomboidDataPath;
        } else {
            const settingPath = await getSetting('zomboidDataPath');
            if (settingPath) basePath = settingPath;
        }

        const serverName = activeServer?.serverName || await getSetting('serverName') || 'servertest';
        
        // Target: .../Zomboid/Server/serverName_chat.txt (Clean chat log)
        // Or: .../Zomboid/server-console.txt (noisy console log)
        
        // Priority 1: dedicated chat log (usually simpler to parse)
        // Note: Project Zomboid logs chat to dedicated SQLite db since B41.60 usually, 
        // but often text logs are still enabled or can be enabled.
        // Let's stick to server-console.txt as it's the most reliable source of truth for console output
        // which includes [chat] messages if configured.
        
        // The server-console.txt is often in the UserHome/Zomboid folder, OR custom -cachedir
        const consoleLogPath = path.join(basePath, 'server-console.txt');
        
        // Also check "Logs" folder? PZ puts dated logs in /Logs/
        // But we want the LIVE log.
        
        if (fs.existsSync(consoleLogPath)) {
            this.logPath = consoleLogPath;
            log.info(`Found console log at ${consoleLogPath}`);
        } else {
            log.warn(`Could not find server-console.txt at ${consoleLogPath}`);
            this.logPath = null;
        }

    } catch (e) {
        log.error(`Error finding log path: ${e.message}`);
    }
  }

  async startWatching() {
    if (this.isWatching || !this.logPath) return;

    try {
        // Get initial size
        // We use sync here just for immediate initialization
        if (fs.existsSync(this.logPath)) {
            const stats = fs.statSync(this.logPath);
            this.currentSize = stats.size;
        } else {
            this.currentSize = 0;
        }

        log.info(`Started watching ${this.logPath} (start size: ${this.currentSize})`);
        
        this.isWatching = true;
        this.checkLoop();
    } catch (e) {
        log.error(`Failed to watch file: ${e.message}`);
        this.isWatching = false;
    }
  }

  stopWatching() {
     if (this.checkTimer) {
         clearTimeout(this.checkTimer);
         this.checkTimer = null;
     }
     this.isWatching = false;
  }

  async checkLoop() {
      if (!this.isWatching) return;
      
      await this.checkFile();
      
      if (this.isWatching) {
          // Schedule next check
          this.checkTimer = setTimeout(() => this.checkLoop(), 2000);
      }
  }

  async checkFile() {
     try {
         // Async stat to avoid blocking event loop
         let stats;
         try {
             stats = await fs.promises.stat(this.logPath);
         } catch (e) {
             // File access error or not found
             return;
         }
         
         if (stats.size > this.currentSize) {
             // File grew - read the new chunk
             const bytesToRead = stats.size - this.currentSize;
             
             // Avoid reading massive chunks if file grew too much (e.g. rotation reused file)
             if (bytesToRead > 1024 * 1024) { // 1MB limit per tick
                 log.warn('Log grew too fast, skipping to end');
                 this.currentSize = stats.size;
                 return;
             }

             await new Promise((resolve) => {
                 const stream = fs.createReadStream(this.logPath, {
                     start: this.currentSize,
                     end: stats.size
                 });
                 
                 let data = '';
                 stream.on('data', chunk => data += chunk);
                 stream.on('end', () => {
                     this.currentSize = stats.size;
                     try {
                         this.processNewData(data);
                     } catch (e) {
                         log.error(`Error processing log data: ${e.message}`);
                     }
                     resolve();
                 });
                 stream.on('error', (err) => {
                     // Only log read errors if we are debugging
                     resolve();
                 });
             });
             
         } else if (stats.size < this.currentSize) {
             // File rotated/truncated
             this.currentSize = 0; // Check next time from 0
             log.info('Log file truncated/rotated');
         }
     } catch (e) {
         // General polling errors
     }
  }

  processNewData(data) {
    const lines = data.split(/\r?\n/);
    for (const line of lines) {
        if (!line.trim()) continue;
        
        // Parse Chat Messages
        // Format roughly: [13-02-22 18:20:15.123] [chat] [Safehouse] <User> Message
        // Or: [chat] <User> Message
        
        if (line.includes('[chat]')) {
            this.parseChatLine(line);
        }
    }
  }

  parseChatLine(line) {
      // Regex to extract user and message
      // Removing timestamps first if present
      const cleanLine = line.replace(/^\[.*?\]\s*/, ''); // Remove first timestamp [xx-xx-xx]
      
      if (!cleanLine.includes('[chat]')) return;
      
      // Look for <User> Message
      const match = cleanLine.match(/<([^>]+)>\s+(.*)/);
      if (match) {
          const author = match[1];
          const message = match[2];
          
          this.emit('chatMessage', {
              author,
              message,
              timestamp: new Date()
          });
      }
  }
}
