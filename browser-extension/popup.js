/* Zomboid Control Panel — Steam Sync popup script
 *
 * Reads sessionid + steamLoginSecure from steamcommunity.com using the
 * WebExtensions cookies API (works on Firefox/Chrome/Edge/Brave). Then
 * logs into the panel with the saved username/password (or a cached
 * access token) and POSTs the cookies to
 * /api/mods/collection/extension-push.
 *
 * Privacy:
 *   - Only talks to (a) the configured panel URL and (b) Steam (locally,
 *     to read cookies via the cookies API).
 *   - Password is NOT persisted unless the user explicitly ticks
 *     "Remember password". Only the access token is cached by default,
 *     plus the panel's trusted-device token for each panel and username
 *     (see rememberDeviceToken()).
 *   - Never over plain http:// to a host outside the user's own network,
 *     unless they allowed that one origin (urlPolicy.js, loaded first).
 */

const browserAPI = (typeof browser !== 'undefined' && browser.cookies) ? browser : chrome;

const $ = (id) => document.getElementById(id);
const ui = {
  panelUrl: $('panel-url'),
  allowHttpRow: $('allow-http-row'),
  allowHttp: $('allow-http'),
  allowHttpLabel: $('allow-http-label'),
  username: $('username'),
  password: $('password'),
  rememberPassword: $('remember-password'),
  saveBtn: $('save-btn'),
  testBtn: $('test-btn'),
  sendBtn: $('send-btn'),
  setupStatus: $('setup-status'),
  sendStatus: $('send-status'),
};

// accessTokenFor: the panel and username the cached accessToken came from
// (deviceTokenKey()). A token is only ever sent back to that panel, as that
// user: before, the popup kept one token for whatever URL was saved next,
// so changing the URL sent the old panel's token to the new one.
const STORAGE_KEYS = ['panelUrl', 'username', 'password', 'rememberPassword', 'accessToken', 'accessTokenFor'];
// Origins (scheme://host:port) the user allowed over plain http:// although
// they are not on their own network. One entry per origin, never a wildcard.
const INSECURE_ORIGINS_KEY = 'insecureHttpOrigins';

function storageGet(keys) {
  return new Promise((resolve) => {
    try {
      browserAPI.storage.local.get(keys, (items) => resolve(items || {}));
    } catch (e) {
      resolve({});
    }
  });
}

function storageSet(items) {
  return new Promise((resolve) => {
    try {
      browserAPI.storage.local.set(items, () => resolve(true));
    } catch (e) {
      resolve(false);
    }
  });
}

function storageRemove(keys) {
  return new Promise((resolve) => {
    try {
      browserAPI.storage.local.remove(keys, () => resolve(true));
    } catch (e) {
      resolve(false);
    }
  });
}

// The manifest only grants host access to the two Steam domains outright
// (needed for the cookies API). Any other origin — the user's own panel
// URL, which can be anything — is requested at runtime via
// optional_host_permissions instead of a blanket http(s)://*/* grant.
function requestOrigin(origin) {
  return new Promise((resolve) => {
    try {
      browserAPI.permissions.request({ origins: [origin] }, (granted) =>
        resolve(!!granted),
      );
    } catch (e) {
      resolve(false);
    }
  });
}

async function readInsecureOrigins() {
  const stored = await storageGet([INSECURE_ORIGINS_KEY]);
  const origins = stored[INSECURE_ORIGINS_KEY];
  return Array.isArray(origins) ? origins.filter((origin) => typeof origin === 'string') : [];
}

// Every request that carries the password or the Steam cookies goes through
// this first: a URL urlPolicy.js refuses never gets a request.
async function assertPanelUrlAllowed(panelUrl) {
  const result = checkPanelUrl(panelUrl, await readInsecureOrigins());
  if (!result.ok) {
    showHttpOverride(result);
    throw new Error(panelUrlProblem(result));
  }
  return result;
}

// The "Allow plain HTTP" box shows only for the http:// origin in the URL
// field that the policy refuses (or that the user already allowed).
function showHttpOverride(result) {
  if (!ui.allowHttpRow) return;
  const relevant = !!(result && result.origin && (result.reason === 'insecure' || result.insecureAllowed));
  ui.allowHttpRow.hidden = !relevant;
  if (!relevant) return;
  ui.allowHttpRow.dataset.origin = result.origin;
  ui.allowHttp.checked = !!result.insecureAllowed;
  ui.allowHttpLabel.textContent =
    'Allow plain HTTP for ' + result.origin + ': the panel password and your Steam cookies are sent to it ' +
    'unencrypted. Only for a panel on a network you trust.';
}

async function refreshHttpOverride() {
  const panelUrl = normaliseUrl(ui.panelUrl.value);
  showHttpOverride(panelUrl ? checkPanelUrl(panelUrl, await readInsecureOrigins()) : null);
}

async function setOriginAllowedOverHttp(origin, allowed) {
  const others = (await readInsecureOrigins()).filter((entry) => entry !== origin);
  await storageSet({ [INSECURE_ORIGINS_KEY]: allowed ? [...others, origin] : others });
}

async function ensurePanelPermission(panelUrl) {
  await assertPanelUrlAllowed(panelUrl);
  const origin = new URL(panelUrl).origin + '/*';
  const granted = await requestOrigin(origin);
  if (!granted) {
    throw new Error('Permission to contact the panel URL was not granted.');
  }
}

function cookieGet(details) {
  return new Promise((resolve) => {
    try {
      browserAPI.cookies.get(details, (cookie) => resolve(cookie || null));
    } catch (e) {
      resolve(null);
    }
  });
}

function setStatus(el, msg, kind = 'info') {
  el.textContent = msg || '';
  el.className = 'status ' + (kind || 'info');
}

// Without a scheme: http:// for a host on the user's own network (a LAN
// setup stays short), https:// for anything else.
function normaliseUrl(raw) {
  return normalisePanelUrl(raw);
}

function isSendReady() {
  return !!(
    normaliseUrl(ui.panelUrl.value)
    && ui.username.value.trim()
    && (ui.password.value || true) // password isn't strictly required at this point if a token is cached
  );
}

function refreshSendButton(hasToken) {
  const ready = !!(normaliseUrl(ui.panelUrl.value) && ui.username.value.trim() && (ui.password.value || hasToken));
  ui.sendBtn.disabled = !ready;
}

// The cached access token, only when it came from this panel for this
// username. One saved by an older version names neither: not used.
function cachedAccessToken(stored, panelUrl, username) {
  if (!stored.accessToken || !panelUrl || !String(username || '').trim()) return null;
  return stored.accessTokenFor === deviceTokenKey(panelUrl, username) ? stored.accessToken : null;
}

function rememberAccessToken(panelUrl, username, token) {
  return storageSet({ accessToken: token, accessTokenFor: deviceTokenKey(panelUrl, username) });
}

async function refreshSendButtonFromStorage() {
  const stored = await storageGet(STORAGE_KEYS);
  refreshSendButton(!!cachedAccessToken(stored, normaliseUrl(ui.panelUrl.value), ui.username.value));
}

async function loadSettings() {
  const stored = await storageGet(STORAGE_KEYS);
  ui.panelUrl.value = stored.panelUrl || '';
  ui.username.value = stored.username || '';
  // Only restore the password field if the user previously asked us to.
  ui.rememberPassword.checked = !!stored.rememberPassword;
  ui.password.value = stored.rememberPassword ? (stored.password || '') : '';
  refreshSendButton(!!cachedAccessToken(stored, normaliseUrl(stored.panelUrl), stored.username));
}

async function saveSettings(silent = false) {
  const panelUrl = normaliseUrl(ui.panelUrl.value);
  const remember = !!ui.rememberPassword.checked;
  const items = {
    panelUrl,
    username: ui.username.value.trim(),
    rememberPassword: remember,
  };
  if (remember) {
    items.password = ui.password.value;
  }
  // Another panel or account: the cached token is not for it.
  const before = await storageGet(STORAGE_KEYS);
  if (cachedAccessToken(before, panelUrl, items.username) === null) {
    await storageRemove(['accessToken', 'accessTokenFor']);
  }
  await storageSet(items);
  if (!remember) {
    // Make sure no stale password lingers in storage.
    await storageRemove(['password']);
  }
  ui.panelUrl.value = panelUrl;
  await refreshHttpOverride();
  if (!silent) {
    const check = panelUrl ? checkPanelUrl(panelUrl, await readInsecureOrigins()) : { ok: true };
    if (check.ok) setStatus(ui.setupStatus, 'Saved.', 'success');
    else setStatus(ui.setupStatus, 'Saved, but nothing is sent yet: ' + panelUrlProblem(check), 'error');
  }
}

// SECURITY (2026-10-05, A1): the trusted-device token the panel hands back
// after a successful sign-in (server/services/auth.js, issueDeviceToken()).
// Sent with later sign-ins to the same panel and username, it makes the
// panel count this extension's failed attempts on their own, so a stranger
// who fills the panel's per-address table, or who shares this browser's
// address (a proxy without TRUST_PROXY), can't get its sign-ins refused --
// the same thing the panel's own login page does. It grants nothing else.
const DEVICE_TOKENS_KEY = 'deviceTokens';
const MAX_DEVICE_TOKENS = 10;
const MAX_DEVICE_TOKEN_LENGTH = 1024;

// Never "__proto__" or another Object.prototype name: it always starts
// with "[".
function deviceTokenKey(panelUrl, username) {
  return JSON.stringify([panelUrl, String(username).trim().toLowerCase()]);
}

async function readDeviceTokens() {
  const { deviceTokens } = await storageGet([DEVICE_TOKENS_KEY]);
  if (!deviceTokens || typeof deviceTokens !== 'object' || Array.isArray(deviceTokens)) return {};
  const entries = {};
  for (const [key, value] of Object.entries(deviceTokens)) {
    if (!key.startsWith('[') || !value || typeof value.token !== 'string') continue;
    entries[key] = { token: value.token, savedAt: Number(value.savedAt) || 0 };
  }
  return entries;
}

async function getDeviceToken(panelUrl, username) {
  return (await readDeviceTokens())[deviceTokenKey(panelUrl, username)]?.token;
}

// Stored newest first; the oldest drop off past MAX_DEVICE_TOKENS.
async function rememberDeviceToken(panelUrl, username, token) {
  if (typeof token !== 'string' || !token || token.length > MAX_DEVICE_TOKEN_LENGTH) return;
  const key = deviceTokenKey(panelUrl, username);
  const entries = await readDeviceTokens();
  delete entries[key];
  const kept = [[key, { token, savedAt: Date.now() }], ...Object.entries(entries)]
    .sort((a, b) => b[1].savedAt - a[1].savedAt)
    .slice(0, MAX_DEVICE_TOKENS);
  await storageSet({ [DEVICE_TOKENS_KEY]: Object.fromEntries(kept) });
}

// SECURITY (2026-10-28, audit R2-31): over plain http:// nothing tells the
// panel from whatever else answers at its address. On another network (a
// hotel, a café, a friend's) a 192.168.x address or a .lan name can be
// anybody, and one click on Send gave it the Steam cookies, then the
// remembered password. Each sign-in now keeps the panel's key for that
// account (server/services/auth.js, extensionPanelKey()); before anything
// is sent to a plain-http:// address that is not this computer, the address
// must answer a fresh challenge with that key (confirmPanelIdentity()).
// Over https:// the certificate already does this. A panel too old to hand
// out a key is used as before.
const PANEL_KEYS_KEY = 'panelKeys';
const MAX_PANEL_KEYS = 10;
const MAX_PANEL_KEY_LENGTH = 256;

async function readPanelKeys() {
  const { panelKeys } = await storageGet([PANEL_KEYS_KEY]);
  if (!panelKeys || typeof panelKeys !== 'object' || Array.isArray(panelKeys)) return {};
  const entries = {};
  for (const [key, value] of Object.entries(panelKeys)) {
    if (!key.startsWith('[') || !value || typeof value.key !== 'string') continue;
    entries[key] = { key: value.key, savedAt: Number(value.savedAt) || 0 };
  }
  return entries;
}

async function getPanelKey(panelUrl, username) {
  return (await readPanelKeys())[deviceTokenKey(panelUrl, username)]?.key;
}

// key: a string to keep, or null to forget the one kept.
async function rememberPanelKey(panelUrl, username, key) {
  const id = deviceTokenKey(panelUrl, username);
  const entries = await readPanelKeys();
  delete entries[id];
  const kept = Object.entries(entries);
  if (typeof key === 'string' && key && key.length <= MAX_PANEL_KEY_LENGTH) {
    kept.unshift([id, { key, savedAt: Date.now() }]);
  }
  kept.sort((a, b) => b[1].savedAt - a[1].savedAt);
  await storageSet({ [PANEL_KEYS_KEY]: Object.fromEntries(kept.slice(0, MAX_PANEL_KEYS)) });
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacBase64url(key, message) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message))));
}

function needsPanelProof(panelUrl) {
  const url = new URL(panelUrl);
  return url.protocol === 'http:' && !isLoopbackHost(url.hostname);
}

class PanelIdentityError extends Error {}

// Sends only the username and a random challenge. Throws, before anything
// else goes out, when the address can't prove it is the panel this
// extension signed in to.
async function confirmPanelIdentity(panelUrl, username) {
  if (!needsPanelProof(panelUrl)) return;
  const key = await getPanelKey(panelUrl, username);
  if (!key) return;
  await assertPanelUrlAllowed(panelUrl);
  const challenge = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const res = await fetch(panelUrl + '/api/auth/extension-proof', {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, challenge }),
  });
  let body = null;
  try { body = await res.json(); } catch (_) {}
  if (!res.ok) {
    const detail = body && typeof body.error === 'string' ? body.error : '';
    throw new Error(`Panel check failed (${res.status})${detail ? ': ' + detail : ''}. Nothing was sent.`);
  }
  const expected = await hmacBase64url(key, 'zcp-steam-sync-proof-v1:' + challenge);
  if (!body || body.proof !== expected) {
    throw new PanelIdentityError(
      new URL(panelUrl).host + ' did not prove it is the panel you signed in to, so nothing was sent. Over plain ' +
      'http:// another network can answer at the same address: are you on the panel\'s own network?',
    );
  }
}

// replacePanelKey: a sign-in the user started (Test login) also forgets a
// kept key the panel no longer hands out.
async function loginToPanel(panelUrl, username, password, { replacePanelKey = false } = {}) {
  await assertPanelUrlAllowed(panelUrl);
  // Undefined (never signed in from here) is dropped by JSON.stringify.
  const deviceToken = await getDeviceToken(panelUrl, username);
  const res = await fetch(panelUrl + '/api/auth/login', {
    method: 'POST',
    // A redirect would re-send the password wherever it points (a 307 to an
    // http:// address or another host), past the check above. The panel
    // never redirects its API.
    redirect: 'error',
    // Default credentials mode on purpose: a proxy in front of the panel that
    // signs people in itself (Basic auth, Cloudflare Access, Authelia, a
    // client certificate) needs the browser's credentials for this request.
    // The panel sets no refresh cookie for an extension Origin, so this
    // sign-in can't replace the panel tab's own.
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, rememberMe: false, deviceToken, wantsPanelKey: true }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch (_) {}
    throw new Error(`Login failed (${res.status})${detail ? ': ' + detail : ''}`);
  }
  const data = await res.json();
  if (!data.accessToken) throw new Error('Login response missing accessToken');
  await rememberDeviceToken(panelUrl, username, data.deviceToken);
  if (typeof data.panelKey === 'string' || replacePanelKey) {
    await rememberPanelKey(panelUrl, username, typeof data.panelKey === 'string' ? data.panelKey : null);
  }
  return data.accessToken;
}

async function readSteamCookies() {
  // steamcommunity.com first — that's where Workshop write requests go, so
  // its cookies are the canonical ones. store.steampowered.com is a
  // fallback in case the user is only logged in there.
  const tryHosts = ['https://steamcommunity.com', 'https://store.steampowered.com'];
  let sessionid = null;
  let steamLoginSecure = null;
  for (const url of tryHosts) {
    if (!sessionid) {
      const c = await cookieGet({ url, name: 'sessionid' });
      if (c?.value) sessionid = c.value;
    }
    if (!steamLoginSecure) {
      const c = await cookieGet({ url, name: 'steamLoginSecure' });
      if (c?.value) steamLoginSecure = c.value;
    }
    if (sessionid && steamLoginSecure) break;
  }
  return { sessionid, steamLoginSecure };
}

async function pushCookies(panelUrl, token, sessionid, steamLoginSecure) {
  await assertPanelUrlAllowed(panelUrl);
  const res = await fetch(panelUrl + '/api/mods/collection/extension-push', {
    method: 'POST',
    // Same as loginToPanel(): the Steam cookies never follow a redirect.
    redirect: 'error',
    // Default credentials mode for an authenticating proxy; see loginToPanel().
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: JSON.stringify({ sessionid, steamLoginSecure }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch (_) {}
    const err = new Error(`Push failed (${res.status})${detail ? ': ' + detail : ''}`);
    err.status = res.status;
    throw err;
  }
  return await res.json();
}

async function obtainToken(panelUrl, username, password, cachedToken) {
  // We don't bother validating cached tokens up front — the push endpoint
  // will reject expired tokens with 401 and we'll re-login then.
  if (cachedToken) return { token: cachedToken, fromCache: true };
  if (!password) throw new Error('Password is required for the first login. Tick "Remember password" to skip this next time.');
  const token = await loginToPanel(panelUrl, username, password);
  return { token, fromCache: false };
}

// After a failed panel check, the panel and username a second Test login
// click may sign in to anyway (a reinstalled panel, or one whose sign-in
// secret was reset, has a new key). This popup only, never Send.
let signInAgainAllowedFor = null;

async function doTest() {
  setStatus(ui.setupStatus, 'Testing login…', 'info');
  try {
    const panelUrl = normaliseUrl(ui.panelUrl.value);
    if (!panelUrl) throw new Error('Panel URL is required');
    if (!ui.username.value.trim()) throw new Error('Username is required');
    if (!ui.password.value) throw new Error('Password is required');
    await ensurePanelPermission(panelUrl);
    const username = ui.username.value.trim();
    const target = deviceTokenKey(panelUrl, username);
    if (signInAgainAllowedFor !== target) {
      try {
        await confirmPanelIdentity(panelUrl, username);
      } catch (err) {
        if (err instanceof PanelIdentityError) {
          signInAgainAllowedFor = target;
          throw new Error(err.message + ' If it is your panel and it was reinstalled or its sign-in secret was reset, click Test login again to sign in to it anyway.');
        }
        throw err;
      }
    }
    signInAgainAllowedFor = null;
    const token = await loginToPanel(panelUrl, username, ui.password.value, { replacePanelKey: true });
    await saveSettings(true);
    await rememberAccessToken(panelUrl, username, token);
    setStatus(ui.setupStatus, 'Login OK — settings saved.', 'success');
    refreshSendButton(true);
  } catch (err) {
    setStatus(ui.setupStatus, err.message, 'error');
  }
}

async function doSend() {
  ui.sendBtn.disabled = true;
  setStatus(ui.sendStatus, 'Reading Steam cookies…', 'info');
  try {
    const stored = await storageGet(STORAGE_KEYS);
    const panelUrl = normaliseUrl(stored.panelUrl || ui.panelUrl.value);
    const username = (stored.username || ui.username.value || '').trim();
    const password = ui.password.value || stored.password || '';
    if (!panelUrl || !username) {
      throw new Error('Configure Panel URL + username first.');
    }
    await ensurePanelPermission(panelUrl);
    // Before the cookies, a cached token or a remembered password go out.
    await confirmPanelIdentity(panelUrl, username);

    const { sessionid, steamLoginSecure } = await readSteamCookies();
    if (!sessionid || !steamLoginSecure) {
      throw new Error('Steam cookies not found — sign in at steamcommunity.com first.');
    }

    let { token } = await obtainToken(panelUrl, username, password, cachedAccessToken(stored, panelUrl, username));
    setStatus(ui.sendStatus, 'Sending cookies to panel…', 'info');
    try {
      await pushCookies(panelUrl, token, sessionid, steamLoginSecure);
    } catch (err) {
      if (err.status === 401 && password) {
        // Cached token rejected — log in again with the password we have.
        setStatus(ui.sendStatus, 'Session expired, re-authenticating…', 'info');
        token = await loginToPanel(panelUrl, username, password);
        await rememberAccessToken(panelUrl, username, token);
        await pushCookies(panelUrl, token, sessionid, steamLoginSecure);
      } else {
        throw err;
      }
    }
    await rememberAccessToken(panelUrl, username, token);

    setStatus(ui.sendStatus, 'Cookies sent. Workshop sync is ready.', 'success');
  } catch (err) {
    setStatus(ui.sendStatus, err.message, 'error');
  } finally {
    ui.sendBtn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await refreshHttpOverride();
  ui.saveBtn.addEventListener('click', () => saveSettings());
  ui.testBtn.addEventListener('click', doTest);
  ui.sendBtn.addEventListener('click', doSend);
  // Re-enable the send button live as the user types — beats showing a
  // confusing "Configure …" error after they click.
  const refresh = refreshSendButtonFromStorage;
  ui.panelUrl.addEventListener('input', refresh);
  ui.panelUrl.addEventListener('input', refreshHttpOverride);
  ui.allowHttp.addEventListener('change', async () => {
    const origin = ui.allowHttpRow.dataset.origin;
    if (!origin) return;
    await setOriginAllowedOverHttp(origin, ui.allowHttp.checked);
    await refreshHttpOverride();
  });
  ui.username.addEventListener('input', refresh);
  ui.password.addEventListener('input', refresh);
  ui.rememberPassword.addEventListener('change', async () => {
    if (!ui.rememberPassword.checked) {
      // Tearing down the remember toggle clears the stored password immediately.
      await storageRemove(['password']);
    }
  });
});

