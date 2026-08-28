/**
 * Browser cookie extractor (Windows)
 * ----------------------------------
 * Reads Steam session cookies (`sessionid`, `steamLoginSecure`) directly from
 * the local browser's cookie store. Saves the user from the DevTools dance.
 *
 * Supported on Windows only for v1:
 *   - Firefox  → cookies.sqlite (unencrypted)
 *   - Chrome   → Cookies SQLite + DPAPI-wrapped AES-GCM (legacy v10 scheme)
 *   - Edge     → identical scheme to Chrome
 *   - Brave    → identical scheme to Chrome
 *
 * Hard limits
 * -----------
 *   - Chrome v127+ "App-Bound Encryption" seals auth cookies to the Chrome
 *     process itself. If steamLoginSecure is bound that way, decryption will
 *     return an empty/garbage string and we surface a clean error.
 *   - Chrome/Edge/Brave keep an exclusive lock on Cookies while the browser
 *     is running. We copy the file to a temp path first to dodge most locks,
 *     but a busy browser can still fail us — error will say "close <browser>".
 *
 * No mutation: we never write to a browser's data directory.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import initSqlJs from 'sql.js';
import { createLogger } from './logger.js';

const log = createLogger('BrowserCookies');
const STEAM_HOSTS = ['steamcommunity.com', '.steamcommunity.com', 'store.steampowered.com', '.steampowered.com'];
// steamcommunity.com is where Workshop writes happen, so its login cookies
// take priority over store.steampowered.com when both are present.
const STEAM_HOST_PRIORITY = (host) => {
  if (!host) return 99;
  if (host === 'steamcommunity.com' || host === '.steamcommunity.com') return 0;
  if (host === 'store.steampowered.com' || host === '.steampowered.com') return 1;
  return 2;
};
const CHROMIUM_EPOCH_OFFSET_US = 11644473600000000n;

function integerTimestamp(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return null;
}

function microsecondsToUnixMs(value, epochOffsetUs = 0n) {
  const timestamp = integerTimestamp(value);
  if (timestamp === null || timestamp <= epochOffsetUs) return null;
  const milliseconds = Number((timestamp - epochOffsetUs) / 1000n);
  return Number.isSafeInteger(milliseconds) && milliseconds > 0
    ? milliseconds
    : null;
}

function secondsToUnixMs(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const milliseconds = Math.trunc(seconds * 1000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

export function normalizeChromiumCookieRow(row, profileId) {
  const persistent = Number(row.is_persistent) === 1;
  return {
    ...row,
    host: row.host_key,
    value: row.value ? String(row.value) : '',
    profileId,
    expiresAt: persistent
      ? microsecondsToUnixMs(row.expires_utc, CHROMIUM_EPOCH_OFFSET_US)
      : null,
    createdAt: microsecondsToUnixMs(row.creation_utc, CHROMIUM_EPOCH_OFFSET_US),
    lastAccessedAt: microsecondsToUnixMs(row.last_access_utc, CHROMIUM_EPOCH_OFFSET_US),
    isSession: !persistent,
  };
}

export function normalizeFirefoxCookieRow(row, profileId) {
  const expiresAt = secondsToUnixMs(row.expiry);
  return {
    ...row,
    host: row.host,
    value: row.value ? String(row.value) : '',
    profileId,
    expiresAt,
    createdAt: microsecondsToUnixMs(row.creationTime),
    lastAccessedAt: microsecondsToUnixMs(row.lastAccessed),
    isSession: expiresAt === null,
  };
}

function steamDomainFamily(host) {
  const normalized = String(host || '').replace(/^\./, '').toLowerCase();
  if (normalized === 'steamcommunity.com') return 'community';
  if (normalized === 'steampowered.com' || normalized === 'store.steampowered.com') return 'store';
  return normalized || 'unknown';
}

function cookieFreshness(cookie) {
  return Number(cookie.lastAccessedAt || cookie.createdAt || 0);
}

let sqlPromise = null;
// In-memory cache: master key per browser id. The key never changes for a
// given Windows user account, so we can avoid re-spawning PowerShell every
// extraction within the panel's lifetime. Cleared on process exit.
const masterKeyCache = new Map();

function locateWasm() {
  const candidates = [];
  if (process.pkg) {
    const execDir = path.dirname(process.execPath);
    candidates.push(path.join(execDir, 'sql-wasm.wasm'));
    candidates.push(path.join(execDir, 'assets', 'sql-wasm.wasm'));
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(here, '../../node_modules/sql.js/dist/sql-wasm.wasm'));
  } catch { /* ignore */ }
  candidates.push(path.resolve(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm'));
  candidates.push(path.resolve(process.cwd(), 'sql-wasm.wasm'));
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

async function getSQL() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: () => locateWasm() || 'sql-wasm.wasm',
    });
  }
  return sqlPromise;
}

function defaultProfileRoots() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roamingAppData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return { home, localAppData, roamingAppData };
}

function chromiumProfileDirs(userDataDir) {
  if (!fs.existsSync(userDataDir)) return [];
  const candidates = ['Default'];
  try {
    const entries = fs.readdirSync(userDataDir);
    const numbered = entries
      .filter((n) => /^Profile \d+$/.test(n))
      .sort((a, b) => parseInt(b.match(/\d+/)[0], 10) - parseInt(a.match(/\d+/)[0], 10));
    candidates.push(...numbered);
  } catch { /* ignore */ }
  const profiles = [];
  for (const c of candidates) {
    const dir = path.join(userDataDir, c);
    const networkPath = path.join(dir, 'Network', 'Cookies');
    const legacyPath = path.join(dir, 'Cookies');
    if (fs.existsSync(networkPath)) profiles.push({ profileDir: dir, cookiesPath: networkPath });
    else if (fs.existsSync(legacyPath)) profiles.push({ profileDir: dir, cookiesPath: legacyPath });
  }
  return profiles;
}

function chromiumProfileDir(userDataDir) {
  return chromiumProfileDirs(userDataDir)[0] || null;
}

function firefoxProfilePaths() {
  const { roamingAppData } = defaultProfileRoots();
  const profilesIni = path.join(roamingAppData, 'Mozilla', 'Firefox', 'profiles.ini');
  if (!fs.existsSync(profilesIni)) return [];
  let ini;
  try { ini = fs.readFileSync(profilesIni, 'utf-8'); } catch { return []; }
  const blocks = ini.split(/\r?\n\s*\r?\n/);
  const profiles = [];
  for (const block of blocks) {
    if (!/^\[Profile/.test(block.trim())) continue;
    const pathMatch = block.match(/^Path=(.+)$/m);
    if (!pathMatch) continue;
    const isRel = /^IsRelative=1/m.test(block);
    const rel = pathMatch[1].trim();
    const full = isRel
      ? path.join(roamingAppData, 'Mozilla', 'Firefox', rel)
      : rel;
    const cookiesPath = path.join(full, 'cookies.sqlite');
    if (!fs.existsSync(cookiesPath)) continue;
    profiles.push({
      profileDir: full,
      cookiesPath,
      priority: /^Default=1/m.test(block) ? 0 : /\.default-release$/.test(rel) ? 1 : 2,
    });
  }
  return profiles
    .sort((a, b) => a.priority - b.priority)
    .map(({ profileDir, cookiesPath }) => ({ profileDir, cookiesPath }));
}

function firefoxProfilePath() {
  return firefoxProfilePaths()[0] || null;
}

const BROWSER_DEFS = [
  {
    id: 'firefox',
    label: 'Firefox',
    family: 'firefox',
    find() { return firefoxProfilePath(); },
    findAll() { return firefoxProfilePaths(); },
  },
  {
    id: 'chrome',
    label: 'Chrome',
    family: 'chromium',
    find() {
      const { localAppData } = defaultProfileRoots();
      return chromiumProfileDir(path.join(localAppData, 'Google', 'Chrome', 'User Data'));
    },
    findAll() {
      const { localAppData } = defaultProfileRoots();
      return chromiumProfileDirs(path.join(localAppData, 'Google', 'Chrome', 'User Data'));
    },
    localStatePath() {
      const { localAppData } = defaultProfileRoots();
      return path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Local State');
    },
  },
  {
    id: 'edge',
    label: 'Edge',
    family: 'chromium',
    find() {
      const { localAppData } = defaultProfileRoots();
      return chromiumProfileDir(path.join(localAppData, 'Microsoft', 'Edge', 'User Data'));
    },
    findAll() {
      const { localAppData } = defaultProfileRoots();
      return chromiumProfileDirs(path.join(localAppData, 'Microsoft', 'Edge', 'User Data'));
    },
    localStatePath() {
      const { localAppData } = defaultProfileRoots();
      return path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Local State');
    },
  },
  {
    id: 'brave',
    label: 'Brave',
    family: 'chromium',
    find() {
      const { localAppData } = defaultProfileRoots();
      return chromiumProfileDir(path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data'));
    },
    findAll() {
      const { localAppData } = defaultProfileRoots();
      return chromiumProfileDirs(path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data'));
    },
    localStatePath() {
      const { localAppData } = defaultProfileRoots();
      return path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Local State');
    },
  },
];

export function listAvailableBrowsers() {
  if (process.platform !== 'win32') {
    return { supported: false, platform: process.platform, browsers: [] };
  }
  const browsers = BROWSER_DEFS.map((def) => {
    let found = null;
    try { found = def.find(); } catch { found = null; }
    return {
      id: def.id,
      label: def.label,
      family: def.family,
      detected: !!found,
    };
  });
  return { supported: true, platform: 'win32', browsers };
}

function copyToTemp(srcPath) {
  const tmp = path.join(os.tmpdir(), `zcp-cookies-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.sqlite`);
  fs.copyFileSync(srcPath, tmp);
  return tmp;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * PowerShell fallback for files Chrome/Edge/Brave keep open with restrictive
 * share flags. `[IO.File]::Open` with `FileShare.ReadWrite | Delete` reads
 * past the SQLite WAL exclusive-mode lock without needing the browser to be
 * closed. Slower than fs.copyFileSync — only used when that fails.
 */
async function copyToTempViaPowerShell(srcPath) {
  const tmp = path.join(os.tmpdir(), `zcp-cookies-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.sqlite`);
  const script = `
    $ErrorActionPreference = 'Stop'
    $src = $env:ZCP_SRC
    $dst = $env:ZCP_DST
    $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    $in = [System.IO.File]::Open($src, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
    try {
      $out = [System.IO.File]::Create($dst)
      try { $in.CopyTo($out) } finally { $out.Close() }
    } finally { $in.Close() }
  `;
  await new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], {
      env: { ...process.env, ZCP_SRC: srcPath, ZCP_DST: tmp },
      windowsHide: true,
    });
    let err = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error('PowerShell copy timed out'));
    }, 10000);
    proc.stderr.on('data', (b) => { err += b.toString('utf-8'); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`PowerShell copy failed (exit ${code}): ${err.trim().slice(0, 200)}`));
      }
      resolve();
    });
  });
  return tmp;
}

/**
 * Best-effort copy that retries through Chrome's locking quirks.
 *   1. fs.copyFileSync — fastest, works for Firefox & idle Chromium.
 *   2. brief retry — Chrome occasionally drops the lock between writes.
 *   3. PowerShell shadow open with permissive share flags — works while
 *      Chrome is fully running.
 */
async function snapshotCookiesFile(srcPath) {
  // Attempt 1: native copyFileSync.
  try { return copyToTemp(srcPath); } catch (err) {
    if (err.code !== 'EBUSY' && err.code !== 'EPERM' && err.code !== 'UNKNOWN') {
      throw err;
    }
  }
  // Attempt 2: short backoff + retry. Cheap, sometimes enough.
  await sleep(250);
  try { return copyToTemp(srcPath); } catch (err) {
    if (err.code !== 'EBUSY' && err.code !== 'EPERM' && err.code !== 'UNKNOWN') {
      throw err;
    }
  }
  // Attempt 3: PowerShell with FileShare.ReadWrite | Delete.
  return copyToTempViaPowerShell(srcPath);
}

function safeUnlink(p) { try { fs.unlinkSync(p); } catch { /* ignore */ } }

async function readChromiumCookies(cookiesPath) {
  let tmpPath;
  try { tmpPath = await snapshotCookiesFile(cookiesPath); }
  catch (err) {
    return { ok: false, error: `Could not read cookies file (${err.code || 'locked'}). Try closing the browser and retry, or use the browser extension.` };
  }
  try {
    const SQL = await getSQL();
    const buf = fs.readFileSync(tmpPath);
    const db = new SQL.Database(new Uint8Array(buf));
    const hostList = STEAM_HOSTS.map((h) => `'${h.replace(/'/g, "''")}'`).join(',');
    const res = db.exec(`SELECT host_key, name, value, encrypted_value, expires_utc, creation_utc, last_access_utc, is_persistent FROM cookies WHERE host_key IN (${hostList})`);
    db.close();
    if (!res || !res[0]) return { ok: true, rows: [] };
    const cols = res[0].columns;
    const rows = res[0].values.map((row) => {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = row[i]; });
      return obj;
    });
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: `SQLite read failed: ${err.message}` };
  } finally {
    safeUnlink(tmpPath);
  }
}

async function readFirefoxCookies(cookiesPath) {
  let tmpPath;
  try { tmpPath = await snapshotCookiesFile(cookiesPath); }
  catch (err) {
    return { ok: false, error: `Could not read cookies file (${err.code || 'locked'}). Try closing Firefox and retry, or use the browser extension.` };
  }
  try {
    const SQL = await getSQL();
    const buf = fs.readFileSync(tmpPath);
    const db = new SQL.Database(new Uint8Array(buf));
    const hostList = STEAM_HOSTS.map((h) => `'${h.replace(/'/g, "''")}'`).join(',');
    const res = db.exec(`SELECT host, name, value, expiry, creationTime, lastAccessed FROM moz_cookies WHERE host IN (${hostList})`);
    db.close();
    if (!res || !res[0]) return { ok: true, rows: [] };
    const cols = res[0].columns;
    const rows = res[0].values.map((row) => {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = row[i]; });
      return obj;
    });
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: `SQLite read failed: ${err.message}` };
  } finally {
    safeUnlink(tmpPath);
  }
}

async function getChromiumMasterKey(localStatePath) {
  if (!fs.existsSync(localStatePath)) {
    throw new Error('Local State file not found');
  }
  let raw;
  try { raw = fs.readFileSync(localStatePath, 'utf-8'); }
  catch (err) { throw new Error(`Could not read Local State: ${err.code || err.message}`); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw new Error(`Local State is not valid JSON: ${err.message}`); }
  const encB64 = parsed?.os_crypt?.encrypted_key;
  if (!encB64) throw new Error('os_crypt.encrypted_key missing from Local State');

  const encBlob = Buffer.from(encB64, 'base64');
  if (encBlob.slice(0, 5).toString('ascii') !== 'DPAPI') {
    throw new Error('Unexpected key prefix (not a DPAPI blob)');
  }
  const dpapiBlob = encBlob.slice(5);

  const script = `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Security
    $b64 = [Console]::In.ReadToEnd().Trim()
    $bytes = [System.Convert]::FromBase64String($b64)
    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
    [Console]::Out.Write([System.Convert]::ToBase64String($plain))
  `;
  const stdout = await new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error('PowerShell DPAPI unwrap timed out'));
    }, 10000);
    proc.stdout.on('data', (b) => { out += b.toString('utf-8'); });
    proc.stderr.on('data', (b) => { err += b.toString('utf-8'); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`DPAPI unwrap failed (exit ${code}): ${err.trim().substring(0, 200)}`));
      resolve(out);
    });
    proc.stdin.write(dpapiBlob.toString('base64'));
    proc.stdin.end();
  });
  const key = Buffer.from(stdout.trim(), 'base64');
  if (key.length !== 32) throw new Error(`Decrypted key has unexpected length ${key.length} (expected 32)`);
  return key;
}

function decryptChromiumValue(encrypted, key) {
  if (!encrypted || encrypted.length === 0) return { ok: false, reason: 'empty' };
  const prefix = encrypted.slice(0, 3).toString('ascii');
  if (prefix === 'v20') {
    return { ok: false, reason: 'app-bound (v20) — Chrome 127+ seals this cookie to the Chrome process; install the panel browser extension instead' };
  }
  if (prefix !== 'v10' && prefix !== 'v11') {
    return { ok: false, reason: `unsupported scheme "${prefix}"` };
  }
  try {
    const nonce = encrypted.slice(3, 15);
    const tagStart = encrypted.length - 16;
    const ciphertext = encrypted.slice(15, tagStart);
    const tag = encrypted.slice(tagStart);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { ok: true, value: plain.toString('utf-8') };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export async function extractSteamCookies(browserId) {
  if (process.platform !== 'win32') {
    return { ok: false, browser: browserId, error: 'Only supported on Windows for now — use the browser extension on Linux/Mac' };
  }
  const def = BROWSER_DEFS.find((b) => b.id === browserId);
  if (!def) return { ok: false, browser: browserId, error: 'Unknown browser id' };
  const profiles = def.findAll ? def.findAll() : [def.find()].filter(Boolean);
  if (profiles.length === 0) return { ok: false, browser: browserId, error: `${def.label} profile not found on this machine` };

  if (def.family === 'firefox') {
    const cookies = [];
    const readErrors = [];
    for (const profile of profiles) {
      const result = await readFirefoxCookies(profile.cookiesPath);
      if (!result.ok) {
        readErrors.push(result.error);
        continue;
      }
      cookies.push(...result.rows.map((row) => normalizeFirefoxCookieRow(row, profile.profileDir)));
    }
    if (cookies.length === 0 && readErrors.length === profiles.length) {
      return { ok: false, browser: browserId, error: readErrors[0] };
    }
    const notes = readErrors.length > 0
      ? [`Could not inspect ${readErrors.length} ${def.label} profile(s); selection used the readable profiles only.`]
      : [];
    return pickSteamCookies(browserId, cookies, notes);
  }

  const rowsByProfile = [];
  const readErrors = [];
  for (const profile of profiles) {
    const result = await readChromiumCookies(profile.cookiesPath);
    if (!result.ok) {
      readErrors.push(result.error);
      continue;
    }
    rowsByProfile.push(...result.rows.map((row) => ({ row, profileId: profile.profileDir })));
  }
  if (rowsByProfile.length === 0 && readErrors.length === profiles.length) {
    return { ok: false, browser: browserId, error: readErrors[0] };
  }

  let key = masterKeyCache.get(browserId);
  if (!key) {
    try {
      key = await getChromiumMasterKey(def.localStatePath());
      masterKeyCache.set(browserId, key);
    } catch (err) {
      log.warn(`${def.label} master key extraction failed: ${err.message}`);
      return { ok: false, browser: browserId, error: `Could not unwrap ${def.label}'s cookie key: ${err.message}` };
    }
  }

  const decoded = [];
  const notes = readErrors.length > 0
    ? [`Could not inspect ${readErrors.length} ${def.label} profile(s); selection used the readable profiles only.`]
    : [];
  let appBoundCount = 0;
  for (const { row, profileId } of rowsByProfile) {
    const normalized = normalizeChromiumCookieRow(row, profileId);
    if (row.value && row.value.length > 0) {
      decoded.push(normalized);
      continue;
    }
    const enc = row.encrypted_value;
    if (!enc || enc.length === 0) continue;
    const buf = Buffer.isBuffer(enc) ? enc : Buffer.from(enc);
    const dec = decryptChromiumValue(buf, key);
    if (dec.ok) {
      decoded.push({ ...normalized, value: dec.value });
    } else {
      if (dec.reason && dec.reason.startsWith('app-bound')) appBoundCount += 1;
      log.debug(`Skipped ${row.name}@${row.host_key}: ${dec.reason}`);
    }
  }
  if (appBoundCount > 0) {
    notes.push(`${appBoundCount} cookie(s) are sealed by Chrome 127+ App-Bound Encryption and cannot be extracted from outside Chrome. Install the panel's browser extension instead if steamLoginSecure is missing below.`);
  }
  return pickSteamCookies(browserId, decoded, notes);
}

export function pickSteamCookies(browserId, cookies, notes = [], now = Date.now()) {
  const outputNotes = [...notes];
  const valid = cookies.filter((cookie) => {
    if (!cookie.value || !['sessionid', 'steamLoginSecure'].includes(cookie.name)) {
      return false;
    }
    const noExpiry = cookie.expiresAt === null || cookie.expiresAt === undefined || cookie.expiresAt === 0;
    const sessionCookie = cookie.isSession === true || (cookie.isSession !== false && noExpiry);
    return sessionCookie || Number(cookie.expiresAt) > now;
  });
  const sessions = valid.filter((cookie) => cookie.name === 'sessionid');
  const logins = valid.filter((cookie) => cookie.name === 'steamLoginSecure');

  for (const [name, matches] of [['sessionid', sessions], ['steamLoginSecure', logins]]) {
    if (new Set(matches.map((cookie) => cookie.value)).size > 1) {
      outputNotes.push(`Conflicting valid ${name} cookies were found; selected the newest compatible pair without exposing cookie values.`);
    }
  }

  const pairs = [];
  for (const session of sessions) {
    for (const login of logins) {
      const sessionProfile = session.profileId || browserId;
      const loginProfile = login.profileId || browserId;
      const sessionDomain = steamDomainFamily(session.host);
      const loginDomain = steamDomainFamily(login.host);
      pairs.push({
        session,
        login,
        sameProfile: sessionProfile === loginProfile,
        sameDomain: sessionDomain === loginDomain,
        domainPriority: sessionDomain === loginDomain
          ? Math.min(STEAM_HOST_PRIORITY(session.host), STEAM_HOST_PRIORITY(login.host))
          : Math.min(STEAM_HOST_PRIORITY(session.host), STEAM_HOST_PRIORITY(login.host)) + 10,
        freshness: Math.min(cookieFreshness(session), cookieFreshness(login)),
        newestMember: Math.max(cookieFreshness(session), cookieFreshness(login)),
      });
    }
  }
  pairs.sort((a, b) => {
    if (a.sameProfile !== b.sameProfile) return a.sameProfile ? -1 : 1;
    if (a.sameDomain !== b.sameDomain) return a.sameDomain ? -1 : 1;
    if (a.domainPriority !== b.domainPriority) return a.domainPriority - b.domainPriority;
    if (a.freshness !== b.freshness) return b.freshness - a.freshness;
    return b.newestMember - a.newestMember;
  });

  const selected = pairs[0] || null;
  const newest = (matches) => [...matches].sort((a, b) => {
    const priority = STEAM_HOST_PRIORITY(a.host) - STEAM_HOST_PRIORITY(b.host);
    return priority || cookieFreshness(b) - cookieFreshness(a);
  })[0] || null;
  const selectedSession = selected?.session || newest(sessions);
  const selectedLogin = selected?.login || newest(logins);
  if (selected && !selected.sameProfile) {
    outputNotes.push('Warning: selected Steam cookies from different browser profiles because no same-profile pair was available.');
  }
  if (selected && !selected.sameDomain) {
    outputNotes.push('Warning: selected a cross-domain Steam cookie fallback pair because no same-domain pair was available.');
  }

  const sessionid = selectedSession?.value || null;
  const steamLoginSecure = selectedLogin?.value || null;
  const missing = [];
  if (!sessionid) missing.push('sessionid');
  if (!steamLoginSecure) missing.push('steamLoginSecure');
  return {
    ok: !!(sessionid && steamLoginSecure),
    browser: browserId,
    sessionid: sessionid || null,
    steamLoginSecure: steamLoginSecure || null,
    missing,
    notes: outputNotes,
    error: missing.length > 0
      ? `Missing ${missing.join(' + ')} — make sure you're logged into Steam in this browser`
      : null,
  };
}
