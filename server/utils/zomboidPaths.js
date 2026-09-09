// Shared utilities for resolving and probing Zomboid data folders.
//
// Extracted from routes/chunks.js so other path-dependent routes (backups,
// serverFiles, serverFinder) can reuse the same normalization + suggestion
// logic without duplicating env-var / tilde handling and platform probes.

import fs from 'fs';
import os from 'os';
import path from 'path';

// ─── Path normalisation ──────────────────────────────────────────────────

// Normalize a user-supplied path:
//   - trim whitespace
//   - strip surrounding single/double quotes (common copy-paste artefact)
//   - expand a leading "~" to the user's home dir
//   - expand $VAR / ${VAR} (POSIX) and %VAR% (Windows) environment refs
//   - convert empty string back to null
// Defensive only — does NOT validate filesystem state.
export function normalizeUserPath(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
    if (!s) return null;
  }
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    s = path.join(os.homedir(), s.slice(1));
  }
  s = s.replace(/%([^%]+)%/g, (m, name) => process.env[name] || m);
  s = s.replace(/\$\{([^}]+)\}/g, (m, name) => process.env[name] || m);
  s = s.replace(/\$([A-Z_][A-Z0-9_]*)/gi, (m, name) => process.env[name] || m);
  return s;
}

// ─── Candidate probing ───────────────────────────────────────────────────

function computeCandidateZomboidPaths() {
  const home = os.homedir() || '';
  const candidates = [];

  // An explicit env override always wins -- the operator (or their Docker
  // Compose file) said exactly where the save data is, so it goes first
  // regardless of platform. Same PZ_SAVE_PATH server/routes/server.js,
  // servers.js, configMutationGuard.js etc. already fall back to; this
  // function just hadn't been taught to offer it as a candidate too.
  if (process.env.PZ_SAVE_PATH) candidates.push(process.env.PZ_SAVE_PATH);

  if (process.platform === 'win32') {
    // PZ on Windows stores saves under %USERPROFILE%\Zomboid (NOT inside AppData).
    if (home) candidates.push(path.join(home, 'Zomboid'));
    if (process.env.USERPROFILE) candidates.push(path.join(process.env.USERPROFILE, 'Zomboid'));
    if (process.env.PUBLIC) candidates.push(path.join(process.env.PUBLIC, 'Zomboid'));
  } else {
    if (home) {
      candidates.push(path.join(home, 'Zomboid'));
      candidates.push(path.join(home, '.zomboid'));
      candidates.push(path.join(home, 'pzserver', 'Zomboid'));
    }
    candidates.push('/root/Zomboid');
    candidates.push('/opt/pzserver/Zomboid');
    candidates.push('/srv/pz/Zomboid');

    // server-detection-lifecycle-hardening, 2026-09-09: the above are all
    // bare-metal Linux conventions -- nothing here anticipated a
    // CONTAINERISED install, where the save-data folder is whatever a
    // Docker/Unraid bind mount put at a fixed container-internal path, not
    // a path this process's own $HOME has any relationship to. These four
    // are the same, independently-verified conventions
    // mountDiscovery.js's COMMON_MOUNT_CANDIDATES already uses for its
    // paired install+data discovery (this project's own docker-compose.yml
    // /zomboid; ich777's Unraid Project Zomboid template, confirmed against
    // the official Unraid blog setup guide, /serverdata/serverfiles/Zomboid;
    // a generic steam-mount convention /steam/pz/Zomboid) plus the generic
    // single-mount /data, /config, /serverfiles roots a co-located image
    // might nest Zomboid under directly -- kept as separate literal entries
    // here (rather than importing mountDiscovery.js, a higher-level service
    // this lower-level util shouldn't depend on) because this function
    // returns single SAVE-DATA-folder guesses for a different caller
    // shape (chunks.js/debug.js/servers.js editing an EXISTING server's
    // zomboidDataPath) than mountDiscovery.js's install+data PAIRS for
    // creating a new one. If mountDiscovery.js's candidate list changes,
    // check whether this list needs the same update.
    candidates.push('/zomboid');
    candidates.push('/serverdata/serverfiles/Zomboid');
    candidates.push('/steam/pz/Zomboid');
    candidates.push('/data/Zomboid');
    candidates.push('/config/Zomboid');
    candidates.push('/serverfiles/Zomboid');
  }

  const seen = new Set();
  const result = [];
  for (const raw of candidates) {
    const p = path.resolve(raw);
    if (seen.has(p)) continue;
    seen.add(p);
    let exists = false;
    let hasSaves = false;
    try {
      exists = fs.existsSync(p) && fs.statSync(p).isDirectory();
      if (exists) hasSaves = fs.existsSync(path.join(p, 'Saves', 'Multiplayer'));
    } catch { /* ignore */ }
    result.push({ path: p, exists, hasSaves });
  }
  return result;
}

// 30s cache — the candidate set is per-host and per-process; existsSync over
// ~6-9 paths every request is wasteful on slow shares.
let _cache = { ts: 0, value: null };
const CACHE_TTL_MS = 30_000;

export function getCandidateZomboidPaths() {
  const now = Date.now();
  if (_cache.value && (now - _cache.ts) < CACHE_TTL_MS) return _cache.value;
  const value = computeCandidateZomboidPaths();
  _cache = { ts: now, value };
  return value;
}

// Test/development hook to bust the cache (e.g. after the user creates a new
// Zomboid folder and we want fresh probes).
export function invalidateCandidatePathsCache() {
  _cache = { ts: 0, value: null };
}

// ─── Heuristics for "does this look like a Zomboid data folder?" ─────────

const SAVE_ARTIFACTS = [
  'map',                  // B42 layout / B41 region dir
  'map_sand.bin',
  'map_meta.bin',
  'players.db',
  'serverlog.txt',
  'SandboxVars.lua',
  'WorldDictionary.bin',
  'global_mod_data.bin',
  'reanimated.bin',
];

// Files that mean "this is a PZ server install folder, NOT a user data folder".
const SERVER_INSTALL_ARTIFACTS = [
  'ProjectZomboid64.exe',
  'ProjectZomboid32.exe',
  'ProjectZomboid64.json',
  'ProjectZomboid32.json',
  'projectzomboid-dedi-server.sh',
  'start-server.sh',
  'steam_appid.txt',
];

function looksLikeSaveDir(dir) {
  try {
    return SAVE_ARTIFACTS.some(f => fs.existsSync(path.join(dir, f)));
  } catch { return false; }
}

function looksLikeServerInstall(dir) {
  try {
    return SERVER_INSTALL_ARTIFACTS.some(f => fs.existsSync(path.join(dir, f)));
  } catch { return false; }
}

// server-detection-lifecycle-hardening, 2026-09-09: Jim found in the real
// production support bundle that `looksLikeInstall:false` sitting next to
// `ok:true` in a raw dump means nothing to a reader who isn't the person
// who wrote `checks` -- debug.js's buildZomboidPaths() embeds this whole
// object verbatim into the support bundle for a human to read. This turns
// the boolean soup into ONE plain-language sentence a non-technical user
// (or a support reader who isn't this codebase's author) can act on,
// picking the single most specific true signal rather than listing every
// flag. `reason`'s existing machine slugs ('install-folder' /
// 'no-zomboid-markers') are UNCHANGED below -- routes/servers.js and
// routes/chunks.js already branch on those exact string values to build
// their own messages; this is additive, not a replacement.
function describeVerdict(checks) {
  if (checks.hasSavesDir) return "Has a Saves folder — this looks like the right place.";
  if (checks.hasMultiplayerDir) return "Has a Multiplayer folder — this looks like the right place.";
  if (checks.hasSaveArtifacts) return "Contains Project Zomboid save data (map/world files) found here or just inside.";
  if (checks.isInsideSavesDir) return "This path is inside a Saves folder.";
  if (checks.hasZomboidMarker) return "The folder name looks like a Zomboid folder, but no save files were found inside yet — it may be empty or newly created.";
  return null;
}

// Inspect a resolved path and return a structured verdict. Caller decides
// whether to accept or reject — this lets the route surface per-check
// diagnostics in the debug payload instead of just a generic "rejected".
//
// Returns:
//   {
//     ok: boolean,
//     reason?: 'install-folder' | 'no-zomboid-markers',
//     message: string,   // human-readable, always present -- see describeVerdict()
//     checks: { hasSavesDir, hasMultiplayerDir, isInsideSavesDir,
//               hasZomboidMarker, hasSaveArtifacts, looksLikeInstall },
//     parentSuggestion?: string,   // e.g. user pointed at .../Saves
//   }
export function inspectZomboidPath(normalized) {
  const lower = normalized.toLowerCase().replace(/\\/g, '/');
  const basename = path.basename(normalized);

  const checks = {
    hasSavesDir: fs.existsSync(path.join(normalized, 'Saves')),
    hasMultiplayerDir: fs.existsSync(path.join(normalized, 'Multiplayer')),
    isInsideSavesDir: /\/saves(\/|$)/.test(lower),
    hasZomboidMarker: lower.includes('zomboid') || lower.includes('projectzomboid'),
    hasSaveArtifacts: false,
    looksLikeInstall: looksLikeServerInstall(normalized),
  };

  checks.hasSaveArtifacts = looksLikeSaveDir(normalized);
  if (!checks.hasSaveArtifacts) {
    try {
      const entries = fs.readdirSync(normalized, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (looksLikeSaveDir(path.join(normalized, e.name))) {
          checks.hasSaveArtifacts = true;
          break;
        }
      }
    } catch { /* ignore */ }
  }

  // Server install folder → reject early with a specific message.
  if (checks.looksLikeInstall && !checks.hasSavesDir && !checks.hasMultiplayerDir) {
    return {
      ok: false,
      reason: 'install-folder',
      message: "This looks like the Project Zomboid server INSTALL folder (game files), not the save-data folder. Point at the save-data folder instead — it's usually called \"Zomboid\" and contains a Saves folder.",
      checks,
    };
  }

  // User pointed at a "Saves" or "Multiplayer" folder — suggest the parent.
  let parentSuggestion = null;
  if (basename === 'Saves' || basename === 'Multiplayer') {
    const parent = path.dirname(normalized);
    if (parent && parent !== normalized) parentSuggestion = parent;
  }

  const accepted = checks.hasSavesDir || checks.hasMultiplayerDir ||
                   checks.isInsideSavesDir || checks.hasZomboidMarker ||
                   checks.hasSaveArtifacts;

  if (!accepted) {
    const base = "This doesn't look like a Project Zomboid save-data folder — no Saves or Multiplayer folder, no matching name, and no save files found here.";
    return {
      ok: false,
      reason: 'no-zomboid-markers',
      message: parentSuggestion
        ? `${base} You pointed at a Saves/Multiplayer folder itself — try its parent folder instead.`
        : base,
      checks,
      parentSuggestion,
    };
  }
  return { ok: true, message: describeVerdict(checks), checks, parentSuggestion };
}
