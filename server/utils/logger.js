import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { getDataPaths } from './paths.js';

// Get paths from central config
const paths = getDataPaths();
const logsDir = paths.logsDir;

// Ensure logs directory exists
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Store callbacks for log streaming
const logCallbacks = [];

export function onLog(callback) {
  logCallbacks.push(callback);
  return () => {
    const index = logCallbacks.indexOf(callback);
    if (index > -1) logCallbacks.splice(index, 1);
  };
}

// Custom transport to stream logs to callbacks
class CallbackTransport extends winston.Transport {
  log(info, callback) {
    setImmediate(() => {
      logCallbacks.forEach(cb => {
        try {
          cb({
            level: info.level,
            message: info.message,
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

// Shared printf format for all transports
const printfFormat = winston.format.printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level.toUpperCase()}]: ${stack || message}`;
});

// Format for console (with colors)
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.colorize(),
  printfFormat
);

// Format for file transports (no colors)
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  printfFormat
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    new winston.transports.Console({
      format: consoleFormat
    }),
    new winston.transports.File({ 
      filename: path.join(logsDir, 'error.log'), 
      level: 'error',
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10MB max file size
      maxFiles: 5,
      tailable: true
    }),
    new winston.transports.File({ 
      filename: path.join(logsDir, 'combined.log'),
      format: fileFormat,
      maxsize: 25 * 1024 * 1024, // 25MB max file size
      maxFiles: 3,
      tailable: true
    }),
    new CallbackTransport()
  ]
});
