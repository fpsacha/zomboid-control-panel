/**
 * Workshop Collection Sync
 * ------------------------
 * Mirrors the panel's tracked-mod list into a user-owned Steam Workshop
 * collection so admins don't have to maintain two lists by hand.
 *
 * How it works
 * ------------
 * Reading collection contents is public (Steam Web API).
 * Adding / removing items requires the user's logged-in Steam *session*
 * (cookies `sessionid` + `steamLoginSecure`). Steam has no public OAuth
 * for this; the website uses the same cookie pair we ask the user to paste.
 *
 * Security note
 * -------------
 * `steamLoginSecure` is effectively a Steam login token. Treat it like a
 * password: never log it, mask it in API responses (see config.js
 * SENSITIVE_KEYS). Stored in its own file under the data dir now (see
 * utils/uiSecretFile.js), not db.json — same relocation as the JWT signing
 * key and the Discord bot token, for the same reason: db.json is copied
 * wholesale by two backup paths, this file is copied by neither.
 */

import { createLogger } from '../utils/logger.js';
import { getSetting } from '../database/init.js';
import {
  getSteamSessionCredentials,
  setSteamSessionCredentials,
} from './steamSessionCredentials.js';

export { getSteamSessionCredentials, setSteamSessionCredentials };

const log = createLogger('WorkshopCollectionSync');

const STEAM_COMMUNITY = 'https://steamcommunity.com';
const STEAM_API = 'https://api.steampowered.com';
const USER_AGENT = 'ZomboidControlPanel/1.0 (+collection-sync)';
const FETCH_TIMEOUT_MS = 15000;

function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function isValidWorkshopId(id) {
  return typeof id === 'string' && /^\d{1,15}$/.test(id);
}

/**
 * Fetch a public Workshop collection's child items.
 * No credentials required — uses the public ISteamRemoteStorage endpoint.
 * Returns { ok, items: string[], title, error }.
 */
export async function getCollectionContents(collectionId) {
  if (!isValidWorkshopId(collectionId)) {
    return { ok: false, items: [], error: 'Invalid collection ID' };
  }
  try {
    const body = new URLSearchParams();
    body.set('collectioncount', '1');
    body.set('publishedfileids[0]', collectionId);
    const res = await fetchWithTimeout(`${STEAM_API}/ISteamRemoteStorage/GetCollectionDetails/v1/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: body.toString(),
    });
    if (!res.ok) {
      return { ok: false, items: [], error: `Steam API HTTP ${res.status}` };
    }
    const json = await res.json();
    const detail = json?.response?.collectiondetails?.[0];
    if (!detail) {
      return { ok: false, items: [], error: 'Empty Steam response' };
    }
    if (Number(detail.result) !== 1) {
      return { ok: false, items: [], error: `Steam result code ${detail.result}` };
    }
    // Exclude sub-collection children (filetype 2, Steam's own enum for
    // k_EWorkshopFileTypeCollection) -- see the matching comment in
    // routes/mods.js's /import-collection. A sub-collection id can never
    // be legally added as a child of another collection via addchild, so
    // it must never be surfaced as a syncable item here either.
    const items = Array.isArray(detail.children)
      ? detail.children
          .filter((c) => Number(c.filetype) !== 2)
          .map((c) => String(c.publishedfileid))
      : [];
    return { ok: true, items, title: detail.title || null };
  } catch (err) {
    return { ok: false, items: [], error: err.message || 'Network error' };
  }
}

/**
 * Resolve human-readable titles for a list of Workshop item IDs.
 * Uses the public ISteamRemoteStorage/GetPublishedFileDetails endpoint
 * (no credentials). Batched in a single POST. Returns Map<id, title>.
 *
 * Resilient: any failure returns an empty Map rather than throwing —
 * the UI still works (just shows raw IDs) when Steam is unreachable.
 */
export async function fetchPublishedFileTitles(workshopIds) {
  const out = new Map();
  const ids = (Array.isArray(workshopIds) ? workshopIds : [])
    .map(String)
    .filter(isValidWorkshopId);
  if (ids.length === 0) return out;
  // GetPublishedFileDetails supports many IDs per call. Be defensive and
  // chunk at 200 to stay well under any Steam-side limit.
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    try {
      const body = new URLSearchParams();
      body.set('itemcount', String(slice.length));
      slice.forEach((id, idx) => body.set(`publishedfileids[${idx}]`, id));
      const res = await fetchWithTimeout(
        `${STEAM_API}/ISteamRemoteStorage/GetPublishedFileDetails/v1/`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
          },
          body: body.toString(),
        },
      );
      if (!res.ok) continue;
      const json = await res.json();
      const list = json?.response?.publishedfiledetails;
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const id = item?.publishedfileid ? String(item.publishedfileid) : null;
        const title = typeof item?.title === 'string' ? item.title.trim() : '';
        if (id && title) out.set(id, title);
      }
    } catch (err) {
      log.warn(`fetchPublishedFileTitles chunk failed: ${err.message}`);
    }
  }
  return out;
}

/**
 * Read the Steam session cookie pair, migrating a legacy db.json value the
 * first time this runs on an upgraded install. See utils/uiSecretFile.js.
 * The only exported reader — every call site (here and routes/mods.js)
 * goes through this instead of getSetting directly, so the migration logic
 * lives in one place.
 */
/**
 * Build the cookie header from settings. Returns null if either piece is missing.
 */
async function buildAuthCookies() {
  const { sessionId, loginSecure } = await getSteamSessionCredentials();
  if (typeof sessionId !== 'string' || sessionId.trim().length < 8) return null;
  if (typeof loginSecure !== 'string' || loginSecure.trim().length < 16) return null;
  const sid = sessionId.trim();
  const tok = loginSecure.trim();
  // Defence in depth: reject values containing CR/LF or other control
  // characters that would split the Cookie header. These can never appear
  // in a real Steam cookie, so any presence indicates corruption or abuse.
  if (/[\r\n\0;]/.test(sid) || /[\r\n\0;]/.test(tok)) {
    log.warn('Refusing to build cookie header: control character in stored value');
    return null;
  }
  return {
    sessionId: sid,
    cookie: `sessionid=${sid}; steamLoginSecure=${tok}`,
  };
}

// Steam's own EResult enum (partial) -- only the codes this endpoint has
// been observed to return for addchild/removechild.
const STEAM_ERESULT_NAMES = {
  2: 'generic failure',
  8: 'invalid parameter',
  11: 'invalid state',
  15: 'access denied',
  16: 'timed out',
  42: 'not found',
};
const WORKSHOP_FILE_TYPE_COLLECTION = 2;

/**
 * Turn Steam's raw sharedfiles/<action> failure body into something a
 * human can act on. The raw body used to be dumped verbatim into the
 * user-facing error ("Steam returned non-success (success=8, body=...)"),
 * which reads as protocol noise and sent a real user chasing his session
 * cookies for days when the actual, nameable problem was that the id he
 * was adding was itself a Workshop collection (Steam echoes that back as
 * `fileType: 2` on the childId, its own enum value for a collection).
 */
function describeSharedfilesFailure(action, json) {
  const verb = action === 'addchild' ? 'add' : 'remove';
  if (Number(json?.fileType) === WORKSHOP_FILE_TYPE_COLLECTION) {
    return `Steam rejected this: that Workshop item is itself a collection, not a mod. A collection can't be nested inside another collection this way.`;
  }
  const name = STEAM_ERESULT_NAMES[Number(json?.success)];
  if (name) {
    return `Steam rejected the ${verb} (${name}) — the item may not exist, may have been removed by its author, or you may not have permission to edit this collection.`;
  }
  return `Steam rejected the ${verb} (unrecognized response).`;
}

/**
 * POST to a /sharedfiles/<action> endpoint. Steam returns either JSON
 * `{ success: 1 }` or HTML — both are handled.
 */
async function postSharedfilesAction(action, collectionId, childId) {
  const auth = await buildAuthCookies();
  if (!auth) {
    return { ok: false, error: 'Steam session cookies not configured' };
  }
  if (!isValidWorkshopId(collectionId) || !isValidWorkshopId(childId)) {
    return { ok: false, error: 'Invalid Workshop ID' };
  }
  const body = new URLSearchParams();
  body.set('id', collectionId);
  body.set('childid', childId);
  body.set('sessionid', auth.sessionId);

  try {
    const res = await fetchWithTimeout(`${STEAM_COMMUNITY}/sharedfiles/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        'Cookie': auth.cookie,
        'Referer': `${STEAM_COMMUNITY}/sharedfiles/filedetails/?id=${collectionId}`,
        'Origin': STEAM_COMMUNITY,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
      redirect: 'manual',
    });

    // Steam responds 302 to the login page when cookies are bad.
    if (res.status === 302 || res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Steam session expired — paste fresh cookies' };
    }
    if (!res.ok) {
      return { ok: false, error: `Steam HTTP ${res.status}` };
    }
    const text = await res.text();
    // The endpoint usually returns `{"success":1}` for AJAX-style requests.
    try {
      const json = JSON.parse(text);
      if (json && (json.success === 1 || json.success === true)) {
        return { ok: true };
      }
      // Keep the raw protocol body in the log for us; give the caller a
      // message they can actually act on (see describeSharedfilesFailure).
      log.warn(
        `[WorkshopCollectionSync] ${action} ${childId} → ${collectionId}: ` +
          `Steam returned non-success (success=${json?.success}, body=${text.slice(0, 200)})`,
      );
      return { ok: false, error: describeSharedfilesFailure(action, json) };
    } catch {
      // Sometimes it returns HTML (full page) on success too. If we see the
      // child id reflected back, treat as success; otherwise fail loudly.
      if (text.includes(childId)) {
        return { ok: true };
      }
      return { ok: false, error: 'Steam returned unexpected response' };
    }
  } catch (err) {
    return { ok: false, error: err.message || 'Network error' };
  }
}

export function addItemToCollection(collectionId, childId) {
  return postSharedfilesAction('addchild', collectionId, childId);
}

export function removeItemFromCollection(collectionId, childId) {
  return postSharedfilesAction('removechild', collectionId, childId);
}

/**
 * Compute the diff between the tracked-mod list and the collection.
 * Does NOT mutate anything.
 */
export async function computeDiff(trackedWorkshopIds) {
  const collectionId = await getSetting('workshopCollectionId');
  if (!isValidWorkshopId(collectionId)) {
    return { ok: false, error: 'Collection ID not configured', toAdd: [], toRemove: [], inCollection: [] };
  }
  const collection = await getCollectionContents(collectionId);
  if (!collection.ok) {
    return { ok: false, error: collection.error, toAdd: [], toRemove: [], inCollection: [] };
  }
  const trackedSet = new Set(trackedWorkshopIds.map(String));
  const collectionSet = new Set(collection.items);
  const toAdd = [...trackedSet].filter((id) => !collectionSet.has(id));
  // A Steam collection may intentionally contain optional mods that are not
  // tracked by this server. Sync only adds missing tracked mods; it never
  // prunes collection-only entries.
  const collectionOnly = [...collectionSet].filter((id) => !trackedSet.has(id));
  return {
    ok: true,
    title: collection.title,
    inCollection: [...collectionSet],
    toAdd,
    toRemove: [],
    collectionOnly,
  };
}

/**
 * Auto-sync hook — called after track / untrack operations. Best-effort:
 * never throws, always logs. Skips entirely if auto-sync is disabled or
 * credentials aren't set.
 */
export async function syncSingleChange(action, workshopId) {
  try {
    if (!isValidWorkshopId(String(workshopId))) return { skipped: true, reason: 'invalid id' };
    const enabled = await getSetting('workshopCollectionAutoSync');
    if (!enabled) return { skipped: true, reason: 'auto-sync disabled' };
    const collectionId = await getSetting('workshopCollectionId');
    if (!isValidWorkshopId(collectionId)) return { skipped: true, reason: 'no collection id' };
    const auth = await buildAuthCookies();
    if (!auth) return { skipped: true, reason: 'no credentials' };

    const fn = action === 'add' ? addItemToCollection : removeItemFromCollection;
    const result = await fn(collectionId, String(workshopId));
    if (result.ok) {
      log.info(`Auto-sync ${action} ${workshopId} \u2192 collection ${collectionId} OK`);
    } else {
      log.warn(`Auto-sync ${action} ${workshopId} \u2192 collection ${collectionId} failed: ${result.error}`);
    }
    return result;
  } catch (err) {
    log.error(`Auto-sync ${action} ${workshopId} crashed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
