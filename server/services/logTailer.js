import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
import { createLogger } from '../utils/logger.js';
const log = createLogger('LogTailer');
import { getActiveServer, getSetting } from '../database/init.js';
import {
    describeRefusal,
    gameLogFolderOf,
    logRefusalOnce,
    zomboidDataFolderHolds,
    zomboidDataFolderRefusal,
} from './zomboidDataPath.js';

// Build 42 creates its built-in chat rooms in a fixed order, so the Q-shout
// room is always id 2 (0 = General, 1 = Say). Both the say and the shout room
// report `chat=Local` in the message payload, so the id is the only thing that
// separates a yell from ordinary talking.
const SHOUT_CHAT_ROOM_ID = 2;

// Lines of the B42 chat log, each matched whole. ZLogger writes
// "[dd-MM-yy HH:mm:ss.SSS]" (see USER_LOG_DEATH_LINE), the level in brackets
// when the game gave one, a space, the text, then a "." of its own.
//
// SECURITY (2026-10-28): chat comes from the delivery line only, and both
// patterns are anchored at both ends.
// - ChatServer writes "Got message:" + the message the moment the packet
//   arrives: before it drops a message for a chat stream the server turned
//   off, and before the bad-word filter masks it. The delivery line
//   ("Message ... sent to chat (id = N) members") is written once the
//   message went out, with the text players saw and the room id.
// - A player's text is copied into both lines verbatim, so the unanchored
//   alert pattern found "Server alert message: '...' sent.." inside an
//   ordinary message (even a faction or whisper one) and relayed it to
//   Discord and the Chat page as the server.
// - The author is whatever the game client sent; the game doesn't check it,
//   so it is only ever shown as a name. A modified client can also put a
//   line break in its text and write whole timestamped lines that no
//   parsing here can tell from real ones; a line still carrying a control
//   character (a lone CR survives the line split) is dropped.
const CHAT_LOG_LINE_START = String.raw`^\[\p{Nd}{2}-\p{Nd}{2}-\p{Nd}{2} \p{Nd}{2}:\p{Nd}{2}:\p{Nd}{2}\.\p{Nd}{3}\](?:\[\w+\])? `;
const DELIVERY_LINE = new RegExp(
  CHAT_LOG_LINE_START + String.raw`Message ChatMessage\{chat=([^,]+),\s*author='(.*?)',\s*text='(.*)'\} sent to chat \(id = (\d+)\) members\.?$`,
  'u',
);
// Tested first: on a line that doesn't end like a delivery (a modified
// client's text can cut one short), DELIVERY_LINE would retry its lazy
// author at every "', text='" in it, quadratic in the line's length.
const DELIVERY_LINE_END = /'\} sent to chat \(id = \d+\) members\.?$/u;
// From RCON servermsg; the in-game command adds " by '<admin>'" before
// " sent", which stays part of the message as it always has.
const SERVER_ALERT_LINE = new RegExp(
  CHAT_LOG_LINE_START + String.raw`Server alert message: '(.+)' sent\.\.$`,
  'u',
);

// One whole B42 user.txt death line, exactly as IsoGameCharacter + ZLogger
// write it: "[" + dd-MM-yy HH:mm:ss.SSS + "] user " + name + " died at (x,y,z)
// (non pvp)." -- see processUserLogData for why both ends are anchored.
// \p{Nd} rather than \d for the timestamp: SimpleDateFormat prints the host
// locale's digits, and a name can't fake this prefix with any digits since
// it can't contain the `.`. The single spaces either side of the name are
// literal, not \s+: \s also matches a no-break space, which the game's
// trim() leaves in a name, so "\u00a0Sacha" dying used to be read as Sacha.
const USER_LOG_DEATH_LINE = /^\[\p{Nd}{2}-\p{Nd}{2}-\p{Nd}{2} \p{Nd}{2}:\p{Nd}{2}:\p{Nd}{2}\.\p{Nd}{3}\] user (.+?) died at \((-?\d+),(-?\d+),(-?\d+)\)\s*(?:\((non\s*pvp|pvp)\))?\.?$/iu;
const USER_LOG_CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

// startOffsetFor's watchStartedAt (Date.now()) vs a file's birthtimeMs come
// from two different clock sources measured up to ~20ms apart on this stack
// (see startOffsetFor's own comment). This is 5x that measured figure as a
// safety margin, not a guess -- see start-offset-replays-the-whole-file-on-
// every-non-first-rotation, 2026-09-09.
const BIRTHTIME_CLOCK_SKEW_GRACE_MS = 100;

// A tab is the one control character a pasted chat message may honestly hold.
function hasLineControlChar(text) {
  return USER_LOG_CONTROL_CHAR.test(text.replaceAll('\t', ' '));
}

// The legacy (B41-style) console chat line once its leading timestamp is
// stripped: "[chat] <name> text", nothing before the marker.
const LEGACY_CONSOLE_CHAT_LINE = /^\[chat\]\s*<([^<>]+)>\s+(.*)$/u;

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
    // Every path this tailer has ever selected as chatLogPath/userLogPath --
    // see findLatestChatLog/findLatestUserLog's double-tie tiebreak below.
    this.everTrackedChatPaths = new Set();
    this.everTrackedUserPaths = new Set();
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
  //
  // 2026-09-09 (start-offset-replays-the-whole-file-on-every-non-first-
  // rotation): `firstDiscovery` used to gate the birthtime check at all --
  // any switch mid-polling unconditionally returned 0, on the assumption
  // that only a genuinely fresh, near-empty file ever wins that comparison.
  // Reachable counterexample, confirmed by direct measurement (see
  // logTailerStartOffsetReplay.test.js): this application never writes into
  // Logs/ itself, but nothing stops an external actor (an admin's `touch`,
  // a backup/volume-restore tool, an NFS/SMB remount) from bumping an old,
  // already-populated file's mtime past the currently-tailed file's while
  // the panel keeps running with no reloadConfig()-triggering event. That
  // file then wins the plain `b.mtime - a.mtime` sort -- no tie needed, so
  // this predates tonight's tie-break work entirely -- and firstDiscovery
  // was false (chatLogPath/userLogPath was already set), so its entire
  // existing content got replayed as brand-new chat/user events on the
  // next poll. Fixed by dropping the firstDiscovery gate and applying the
  // SAME born-vs-watchStartedAt rule to every discovery, not just the
  // first: a file that predates this tailer's watch start is never new
  // content, however it ends up winning the "latest" comparison.
  //
  // Gate failure on that same commit, same day: extending the check to
  // every discovery means the already-documented ~20ms cross-clock skew
  // above (previously only ever exercised by the ONE first-discovery
  // decision, which in every real deployment has seconds of margin to
  // spare) is now also exercised by every switch -- and a switch can
  // legitimately happen within a few ms of watchStartedAt (a fast test
  // with no real elapsed time between constructing the tailer and the
  // next file appearing; in production, any rotation landing unusually
  // soon after the tailer starts watching). `born` reading a few ms
  // EARLIER than watchStartedAt purely from clock disagreement, for a
  // file that was actually created AFTER, misclassifies it as
  // pre-existing and skips its real (in this case: brand new) content.
  // A grace margin absorbs the measured skew with room to spare, and
  // costs nothing against a truly pre-existing file, whose gap is always
  // orders of magnitude larger (seconds at an absolute minimum, per the
  // comment above).
  startOffsetFor(filePath) {
    try {
        const stats = fs.statSync(filePath);
        const born = stats.birthtimeMs || 0;
        if (born > 0 && born >= this.watchStartedAt - BIRTHTIME_CLOCK_SKEW_GRACE_MS) return 0;
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
  // findLogPath's own startOffsetFor logic means we pick up the new
  // server's current log tail rather than replaying its history.
  async reloadConfig() {
    this.basePath = null;
    this.logsDir = null;
    this.logPath = null;
    this.chatLogPath = null;
    this.chatLogSize = 0;
    this.currentSize = 0;
    this.userLogPath = null;
    this.userLogSize = 0;
    // Belongs to the server being pointed at, not to the process -- a
    // switch to a different server's logsDir must not carry over which
    // paths the OLD server's tailing ever settled on.
    this.everTrackedChatPaths = new Set();
    this.everTrackedUserPaths = new Set();
    this.consoleRemainder = '';
    this.chatRemainder = '';
    this.userRemainder = '';
    // "Files created after this point are new sessions": this is a fresh watch
    // (a different server, or the same one after an edit), so the constructor's
    // boot time is stale. Left alone, any log born after the panel booted --
    // the current session's chat and user logs once the panel had run a while
    // -- looked brand new here and was read from byte zero, replaying the whole
    // chat to Discord and the Chat page and logging old deaths again.
    this.watchStartedAt = Date.now();
    await this.findLogPath();
    log.info(`LogTailer repointed (console: ${this.logPath || 'none'}, chatLog: ${this.chatLogPath || 'none'}, userLog: ${this.userLogPath || 'none'})`);
  }

  async findLogPath() {
    try {
        const activeServer = await getActiveServer();
        const homeDir = os.homedir();
        let basePath = process.env.PZ_SAVE_PATH || (homeDir ? path.join(homeDir, 'Zomboid') : '');

        // SECURITY (2026-10-05, PATHS-1 verifier pass 2): this tails
        // server-console.txt and Logs/*_chat.txt, *_user.txt under the
        // folder below and passes their lines on (chat, deaths, the
        // console). A remote server's data folder is never judged when
        // saved (it names a folder on its own host), and the legacy
        // settings copy used to take a remote server's too, so a technician
        // could point this at any folder here. The folder used is now held
        // to the data-folder rule (services/zomboidDataPath.js); refused,
        // nothing is tailed. One on another host isn't here, so nothing
        // changes for it.
        if (activeServer?.zomboidDataPath) {
            basePath = activeServer.zomboidDataPath;
        } else {
            const settingPath = await getSetting('zomboidDataPath');
            if (settingPath) basePath = settingPath;
        }
        if (basePath && !zomboidDataFolderHolds(basePath)) {
            // PT3/PT5: why, with its code and what to set; once per folder at
            // warn, then debug.
            logRefusalOnce(log, `Not tailing the server's logs in ${basePath}: ${describeRefusal(zomboidDataFolderRefusal())}`);
            basePath = null;
        }
        // PT2 (verifier round 1): a 1.4.5 Saves/Multiplayer data folder's
        // logs can be in the Zomboid folder it sits in (gameLogFolderOf()).
        if (basePath) basePath = gameLogFolderOf(basePath);
        this.basePath = basePath;
        if (!basePath) return;

        // server-console.txt (B41 chat via [chat] markers, also general log tailing)
        const consoleLogPath = path.join(basePath, 'server-console.txt');
        if (fs.existsSync(consoleLogPath)) {
            // Verify we can actually read the file (ownership/permissions may differ on Linux)
            try {
                fs.accessSync(consoleLogPath, fs.constants.R_OK);
                this.logPath = consoleLogPath;
                // reloadConfig() zeroes currentSize, so without this a repointed
                // tailer re-read the whole console log (init() overwrites it in
                // startWatching(), which is why only a repoint showed it).
                this.currentSize = this.startOffsetFor(consoleLogPath);
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
            this.currentSize = this.startOffsetFor(consoleLogPath);
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
  //
  // 2026-09-09 (log-tailer-tie-break-is-not-airtight-on-coarse-filesystems):
  // that residual gap is real, not just theoretical -- linuxLogTailerRotation
  // .test.js's own double-tie test only distinguishes the two files by
  // forcing a real 50ms wait, which is exactly a timestamp-resolution race
  // against whatever the underlying filesystem/CI host actually honours, and
  // is the likely cause of that test going red on a loaded gate run and
  // green on a quieter re-run.
  //
  // A first attempt at a third tie-break keyed on "is this the currently
  // tracked path" (current path loses the tie). god caught, by measurement,
  // that this OSCILLATES forever while a tie holds: poll 1, A is current so
  // B wins; poll 2, B is now current so A wins back; repeat indefinitely --
  // and every switch resets chatLogSize to 0 (see startOffsetFor), so each
  // flip replays the ENTIRE file again as new chat. The predicate was a
  // property of the last decision, not of the file, so it inverted itself.
  //
  // Fixed by keying on a monotonic, per-file property instead:
  // everTrackedChatPaths remembers every path ever selected as chatLogPath,
  // and a tie is won by whichever file has NEVER been tracked before over
  // one that has (a genuinely new file beats a stale one) -- this can only
  // fire once per file, since selecting it immediately adds it to the set.
  // Once BOTH tied files have been tracked before (poll 2 onward, same
  // scenario), that clause no longer discriminates, so a second fallback
  // clause holds the current path steady (an already-known file does not
  // unseat the one already active). Neither clause needs any elapsed time.
  findLatestChatLog() {
    if (!this.logsDir) return;
    try {
        const currentPath = this.chatLogPath;
        const tracked = this.everTrackedChatPaths;
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
            .sort((a, b) => (b.mtime - a.mtime) || (b.birthtime - a.birthtime)
                || ((tracked.has(a.path) ? 1 : 0) - (tracked.has(b.path) ? 1 : 0))
                || ((a.path === currentPath ? 0 : 1) - (b.path === currentPath ? 0 : 1)));

        if (files.length > 0) {
            const latest = files[0].path;
            if (latest !== this.chatLogPath) {
                this.chatLogPath = latest;
                this.everTrackedChatPaths.add(latest);
                this.chatRemainder = '';
                this.chatLogSize = this.startOffsetFor(latest);
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
  // birthtimeMs, not filename order, and for the 2026-09-09 everTracked +
  // current-path tie-break (replacing an oscillating first attempt) added
  // below.
  findLatestUserLog() {
    if (!this.logsDir) return;
    try {
        const currentPath = this.userLogPath;
        const tracked = this.everTrackedUserPaths;
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
            .sort((a, b) => (b.mtime - a.mtime) || (b.birthtime - a.birthtime)
                || ((tracked.has(a.path) ? 1 : 0) - (tracked.has(b.path) ? 1 : 0))
                || ((a.path === currentPath ? 0 : 1) - (b.path === currentPath ? 0 : 1)));

        if (files.length > 0) {
            const latest = files[0].path;
            if (latest !== this.userLogPath) {
                this.userLogPath = latest;
                this.everTrackedUserPaths.add(latest);
                this.userRemainder = '';
                this.userLogSize = this.startOffsetFor(latest);
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

  // Bytes [start, end) of the file as text. Decoded with a StringDecoder kept
  // per file across reads: `data += chunk` decoded every 64 KB chunk on its
  // own, and each poll's read ends wherever the game had got to, so a
  // Cyrillic or CJK character split across either boundary came out as two
  // U+FFFD (a player's name or chat line mangled on Discord). The decoder
  // carries the partial character to the next read when that read starts
  // where this one ended; any other start (a new file, a truncation, a
  // skipped burst) begins a fresh one.
  readChunk(filePath, start, end) {
    return new Promise((resolve) => {
        // `end` is inclusive in createReadStream, so read up to end-1 or the
        // byte at `end` gets replayed as the first byte of the next chunk.
        if (end <= start) return resolve(null);
        if (!this._decoders) this._decoders = new Map();
        let state = this._decoders.get(filePath);
        if (!state || state.offset !== start) {
          state = { offset: start, decoder: new StringDecoder('utf8') };
          this._decoders.set(filePath, state);
          // Only the files being tailed now: a rotated-away log's entry goes.
          if (this._decoders.size > 8) this._decoders.delete(this._decoders.keys().next().value);
        }
        const stream = fs.createReadStream(filePath, { start, end: end - 1 });
        let data = '';
        let bytesRead = 0;
        stream.on('data', (chunk) => {
          bytesRead += chunk.length;
          data += state.decoder.write(chunk);
        });
        stream.on('end', () => {
          state.offset = start + bytesRead;
          resolve(data);
        });
        stream.on('error', () => {
          this._decoders.delete(filePath);
          resolve(null);
        });
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

  // Parse server-console.txt lines (B41-style [chat] markers).
  //
  // SECURITY (2026-10-28): a B42 server started with -debug copies every
  // chat log line into this file, player text included, so "[chat] <Admin>
  // ..." typed into any chat (a whisper too) came out here as public chat
  // from Admin. Chat is read from Logs/*_chat.txt whenever there is one, so
  // this only runs without it, and only on a line that is the marker itself
  // once the timestamp is stripped.
  processConsoleData(data) {
    const lines = this._splitLines(data, 'consoleRemainder');
    if (this.chatLogPath) return;
    for (const line of lines) {
        if (!line.includes('[chat]') || hasLineControlChar(line)) continue;
        const cleanLine = line.replace(/^\[.*?\]\s*/, '');
        const match = cleanLine.match(LEGACY_CONSOLE_CHAT_LINE);
        if (!match) continue;
        this.emit('chatMessage', {
            author: match[1],
            message: match[2],
            type: 'general',
            timestamp: new Date()
        });
    }
  }

  // Parse B42 dedicated chat log lines (see DELIVERY_LINE for why only the
  // delivery line is read)
  // Formats:
  //   Receipt:     [DD-MM-YY HH:MM:SS.mmm][info] Got message:ChatMessage{chat=General, author='user', text='hello'}.
  //   Delivery:    [DD-MM-YY HH:MM:SS.mmm][info] Message ChatMessage{chat=Local, author='user', text='HEY!'} sent to chat (id = 2) members.
  //   Server msg:  [DD-MM-YY HH:MM:SS.mmm] Server alert message: 'text' sent..
  processChatLogData(data) {
    const lines = this._splitLines(data, 'chatRemainder');
    for (const line of lines) {
        if (!line.trim()) continue;

        // Nothing the game writes holds a control character, so one is a
        // player's (a lone CR survives the split). Checked before matching:
        // `.` stops at a CR or U+2028, which made DELIVERY_LINE retry too.
        if (hasLineControlChar(line)) {
            log.debug('LogTailer: ignoring a chat log line that carries a control character');
            continue;
        }

        // Player/admin chat messages
        // Author is matched lazily rather than as "anything but a quote" so a
        // name like O'Brien doesn't fail the whole line.
        const msgMatch = DELIVERY_LINE_END.test(line) && line.match(DELIVERY_LINE);
        if (msgMatch) {
            const chatType = msgMatch[1].trim();
            const author = msgMatch[2];
            const text = msgMatch[3];
            // PZ names both the say and the shout room "Local"; only the room
            // id tells them apart.
            const roomId = Number(msgMatch[4]);
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
        const alertMatch = line.match(SERVER_ALERT_LINE);
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
  //
  // The whole line is anchored (USER_LOG_DEATH_LINE): a PZ username may
  // contain a newline (ServerWorldDatabase.isValidUserName doesn't reject
  // one), so the game's own death line for a player named "q\nuser Sacha"
  // splits into "[ts] user q" + "user Sacha died at (...)". The old
  // unanchored match read that second half as Sacha's death -- a Discord
  // death notice and a player-history entry for someone who never died.
  // A bare `^\[[^\]]+\]` anchor isn't enough either, since `[` and `]` are
  // legal in names, so the strict ZLogger timestamp is required. A name still
  // carrying a control character (a lone CR survives the line split) is
  // dropped outright rather than reported under a mangled name.
  //
  // That only stops an account name: isValidUserName refuses `.`, so one
  // can't hold a whole line. A co-op (split-screen) player's name never
  // goes through that check (ConnectCoopPacket only compares it with the
  // names already connected), so it can carry complete, timestamped,
  // '.'-terminated death lines for anyone, which no parsing here can tell
  // from real ones. That is why index.js ignores these deaths while
  // PanelBridge reports deaths itself (services/playerDeathEvents.js); this
  // parser is the fallback when there is no bridge.
  processUserLogData(data) {
    const lines = this._splitLines(data, 'userRemainder');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const deathMatch = trimmed.match(USER_LOG_DEATH_LINE);
        if (deathMatch) {
            const player = deathMatch[1];
            if (USER_LOG_CONTROL_CHAR.test(player)) {
                log.warn('LogTailer: ignoring a user.txt death line whose player name contains a control character');
                continue;
            }
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
