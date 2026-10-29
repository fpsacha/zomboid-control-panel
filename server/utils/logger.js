import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { getDataPaths } from './paths.js';
import { formatLogEntryText } from './logText.js';

// Get paths from central config
const paths = getDataPaths();
const logsDir = paths.logsDir;

// Ensure logs directory exists
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
}

// The log files carry host paths, usernames, IPs and command output, so they
// are private to the account running the panel: the directory 0700, the
// files 0600. Same pattern as dataDir in paths.js: mkdirSync's mode is
// umask-filtered and ignored when the directory already exists, so the
// chmods run on every start. That is what tightens an existing install's
// world-readable logs/ (the shipped systemd unit had no UMask) too.
const LOG_FILE_MODE = 0o600;
const ERROR_LOG = path.join(logsDir, 'error.log');
const COMBINED_LOG = path.join(logsDir, 'combined.log');
for (const [target, mode] of [[logsDir, 0o700], [ERROR_LOG, LOG_FILE_MODE], [COMBINED_LOG, LOG_FILE_MODE]]) {
  try {
    if (fs.existsSync(target)) fs.chmodSync(target, mode);
  } catch {
    /* best-effort: Windows / network shares don't support POSIX modes */
  }
}

// Entries logged with { consoleOnly: true } (the first-run setup token) go
// to the console only: the terminal, or the journal / `docker logs` under a
// service manager. They never reach the log files, which outlive the moment
// and can be readable by other local accounts, nor the in-memory buffer and
// live stream that the Debug page and support bundles read.
const skipConsoleOnly = winston.format((info) => (info.consoleOnly ? false : info));

// Store callbacks for log streaming
const logCallbacks = [];

export function onLog(callback) {
  logCallbacks.push(callback);
  return () => {
    const index = logCallbacks.indexOf(callback);
    if (index > -1) logCallbacks.splice(index, 1);
  };
}

// SECURITY (2026-10-05, H2): every entry, whatever its source, has its C1
// control characters (U+0085 NEL among them) and U+2028/U+2029 escaped
// (utils/logText.js). Some log viewers break a line on them, nothing the
// panel writes contains them, and a request header can: Node's HTTP parser
// hands bytes 0x80-0xFF over as latin1. CR/LF the panel's own messages and
// stack traces use, so they stay, but every line after an entry's first is
// indented (2026-10-28, indentLogContinuationLines): text a request chose
// can't start a line that looks like an entry. Call sites quoting request
// input still use escapeLogText to keep it on one line.

// Custom transport to stream logs to callbacks
class CallbackTransport extends winston.Transport {
  log(info, callback) {
    setImmediate(() => {
      logCallbacks.forEach(cb => {
        try {
          cb({
            level: info.level,
            message: formatLogEntryText(info.message),
            timestamp: info.timestamp || new Date().toISOString(),
            source: info.source || 'server'
          });
        } catch (e) {
          // Ignore callback errors
        }
      });
    });
    callback();
  }
}

// ── Level indicators ──
const levelIcons = {
  error: '✖',
  warn:  '⚠',
  info:  '●',
  debug: '·',
};

// ── Console format (compact, colored, human-friendly) ──
const consolePrintf = winston.format.printf(({ level, message, timestamp, stack, source }) => {
  const time = timestamp;                       // HH:mm:ss only
  const icon = levelIcons[level] || '•';
  const tag  = source ? `[${source}]` : '';
  const msg  = formatLogEntryText(stack || message);
  // e.g.  12:34:56 ● [RCON] Connected on attempt 1
  return `${time} ${icon} ${tag}${tag ? ' ' : ''}${msg}`;
});

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.colorize(),
  consolePrintf
);

// ── File format (full timestamp, structured, no colors) ──
const filePrintf = winston.format.printf(({ level, message, timestamp, stack, source }) => {
  const tag = source ? `[${source}] ` : '';
  return `${timestamp} [${level.toUpperCase()}] ${tag}${formatLogEntryText(stack || message)}`;
});

export const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  filePrintf
);

// Console transport with EPIPE protection — silences itself if the pipe breaks
// (e.g. terminal closed while the exe keeps running) to prevent an infinite
// error → log → error loop that floods the error log and can crash the process.
const consoleTransport = new winston.transports.Console({
  format: consoleFormat,
  handleExceptions: false
});
consoleTransport.on('error', (err) => {
  if (err && err.code === 'EPIPE') {
    consoleTransport.silent = true;
  }
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    consoleTransport,
    new winston.transports.File({
      filename: ERROR_LOG,
      level: 'error',
      format: winston.format.combine(skipConsoleOnly(), fileFormat),
      // mode applies whenever winston creates the file (first run, rotation)
      options: { flags: 'a', mode: LOG_FILE_MODE },
      maxsize: 10 * 1024 * 1024, // 10MB max file size
      maxFiles: 5,
      tailable: true
    }),
    new winston.transports.File({
      filename: COMBINED_LOG,
      format: winston.format.combine(skipConsoleOnly(), fileFormat),
      options: { flags: 'a', mode: LOG_FILE_MODE },
      maxsize: 25 * 1024 * 1024, // 25MB max file size
      maxFiles: 3,
      tailable: true
    }),
    new CallbackTransport({ format: skipConsoleOnly() })
  ]
});

/**
 * Create a tagged child logger for a specific component.
 * Usage:  const log = createLogger('RCON');
 *         log.info('Connected');  → "12:34:56 ● [RCON] Connected"
 */
export function createLogger(source) {
  return logger.child({ source });
}

/**
 * Print a blank line to console (visual spacer).
 */
export function logBlank() {
  console.log('');
}

/**
 * Print a section header to console for grouping startup phases.
 * e.g.  ── Services ─────────────────────────────────────
 */
export function logSection(title) {
  const totalWidth = 50;
  const prefix = `── ${title} `;
  const line = '─'.repeat(Math.max(0, totalWidth - prefix.length));
  console.log(`\n  ${prefix}${line}`);
}

/**
 * Print a startup banner with app name and version.
 */
export function logBanner(version) {
  const title = 'Zomboid Control Panel';
  const ver = version ? `v${version}` : '';
  const content = ver ? `${title}  ${ver}` : title;
  const innerWidth = 49;
  const pad = Math.floor((innerWidth - content.length) / 2);
  const padded = ' '.repeat(pad) + content + ' '.repeat(innerWidth - pad - content.length);

  console.log('');
  console.log(`  ╔${'═'.repeat(innerWidth)}╗`);
  console.log(`  ║${padded}║`);
  console.log(`  ╚${'═'.repeat(innerWidth)}╝`);
}

/**
 * Print the "Ready" box with server URLs.
 * @param {{ label: string, url: string }[]} urls
 */
export function logReady(urls) {
  const lines = urls.map(u => `  ${u.label}   ${u.url}`);
  const maxLen = Math.max(...lines.map(l => l.length));
  const innerWidth = Math.max(maxLen + 2, 45);

  console.log('');
  console.log(`  ┌${'─'.repeat(innerWidth)}┐`);
  for (const line of lines) {
    const padded = line + ' '.repeat(innerWidth - line.length);
    console.log(`  │${padded}│`);
  }
  console.log(`  └${'─'.repeat(innerWidth)}┘`);
  console.log('');
}
