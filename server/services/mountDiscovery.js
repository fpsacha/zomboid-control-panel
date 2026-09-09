// Detect PZ server files at common Docker mount points and env-configured
// paths. The most common panel deployment is Docker with the PZ install and
// save data bind-mounted in — this lets the panel offer a pre-populated
// server profile instead of making the user type paths in blind.
//
// All checks are synchronous (fs.existsSync/statSync). This runs once at
// startup and on-demand from a settings button, never in a hot path, so a
// handful of sync stat calls is cheap even on a slow bind mount.
import fs from "fs";
import os from "os";
import path from "path";

const INI_SUFFIX_BLOCKLIST = [
  "_SandboxVars.ini",
  "_spawnpoints.ini",
  "_spawnregions.ini",
];

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// Distinguishes "genuinely not there" (ENOENT) from "something is there but
// we couldn't read it" (EACCES/EPERM/etc). safeIsDir() collapsed both into
// the same false, which sends an operator with a real-but-unreadable bind
// mount off to check their Docker volume config when the volume is fine and
// the host permissions are not -- exactly the kind of misdiagnosis that
// makes a new operator give up.
function classifyDir(dirPath) {
  if (!dirPath) return "missing";
  try {
    return fs.statSync(dirPath).isDirectory() ? "ok" : "not-a-directory";
  } catch (err) {
    return err && err.code === "ENOENT" ? "missing" : "inaccessible";
  }
}

function safeIsDir(dirPath) {
  return classifyDir(dirPath) === "ok";
}

// Server .ini files under a `Server/` folder, minus the sidecar files PZ
// writes alongside the real config (SandboxVars, spawn tables).
function readServerNames(serverDir) {
  if (!safeIsDir(serverDir)) return [];
  return safeReaddir(serverDir)
    .filter(
      (f) =>
        f.endsWith(".ini") &&
        !INI_SUFFIX_BLOCKLIST.some((suffix) => f.endsWith(suffix)),
    )
    .map((f) => f.replace(/\.ini$/, ""));
}

// Does `installPath` look like a PZ dedicated server install?
export function probeInstallPath(installPath) {
  const dirState = classifyDir(installPath);
  if (dirState !== "ok") {
    return {
      valid: false,
      reason: dirState === "inaccessible" ? "permission-denied" : undefined,
      serverNames: [],
      hasStartScript: false,
      hasPanelBridge: false,
    };
  }

  const entries = safeReaddir(installPath);
  const hasZomboidBinary = entries.some((f) => f.startsWith("ProjectZomboid64"));
  // Two real launcher-script names exist across PZ distributions/versions --
  // zomboidPaths.js's SERVER_INSTALL_ARTIFACTS already lists both for the
  // same reason. Checking only one silently missed installs using the other.
  const hasStartScript =
    fs.existsSync(path.join(installPath, "start-server.sh")) ||
    fs.existsSync(path.join(installPath, "projectzomboid-dedi-server.sh"));
  const hasMediaLua = safeIsDir(path.join(installPath, "media", "lua"));
  const hasSteamapps = safeIsDir(path.join(installPath, "steamapps"));

  return {
    valid: hasZomboidBinary || hasStartScript || hasMediaLua || hasSteamapps,
    serverNames: readServerNames(path.join(installPath, "Server")),
    hasStartScript,
    hasPanelBridge: fs.existsSync(
      path.join(installPath, "media", "lua", "server", "PanelBridge.lua"),
    ),
  };
}

// Does `dataPath` look like a PZ user/save data folder (the `-cachedir`
// target, conventionally named `Zomboid`)?
export function probeDataPath(dataPath) {
  const dirState = classifyDir(dataPath);
  if (dirState !== "ok") {
    return {
      valid: false,
      reason: dirState === "inaccessible" ? "permission-denied" : undefined,
      path: dataPath || null,
      serverNames: [],
    };
  }

  const serverNames = readServerNames(path.join(dataPath, "Server"));
  const hasSaves = safeIsDir(path.join(dataPath, "Saves"));
  const hasLua = safeIsDir(path.join(dataPath, "Lua"));

  return {
    valid: hasSaves || hasLua || serverNames.length > 0,
    path: dataPath,
    serverNames,
  };
}

// A `Zomboid` folder living directly under the install path — the layout
// used by images that bind-mount only one path instead of setting
// PZ_SAVE_PATH separately.
export function findDataPath(installPath) {
  if (!installPath) return null;
  const candidate = path.join(installPath, "Zomboid");
  return safeIsDir(candidate) ? candidate : null;
}

const COMMON_MOUNT_CANDIDATES = [
  { install: "/pz-server", data: "/zomboid", source: "common-mount" },
  {
    install: "/serverdata/serverfiles",
    data: "/serverdata/serverfiles/Zomboid",
    source: "ich777-mount",
  },
  { install: "/steam/pz", data: "/steam/pz/Zomboid", source: "steam-mount" },
  // server-detection-lifecycle-hardening, 2026-09-09: generic single-mount
  // container conventions -- an image that bind-mounts ONE volume for
  // everything (install + data co-located, no separate PZ_SAVE_PATH) rather
  // than this project's own two-mount /pz-server + /zomboid split. No
  // explicit `data` here on purpose: resolveDataPathCandidate()'s existing
  // "Zomboid folder nested under install" fallback (findDataPath) already
  // handles the co-located case correctly for these, exactly as it does for
  // the bare-metal Linux candidates below.
  { install: "/data", source: "generic-single-mount" },
  { install: "/config", source: "generic-single-mount" },
  { install: "/serverfiles", source: "generic-single-mount" },
];

function envCandidates() {
  return [
    {
      install: process.env.PZ_SERVER_PATH,
      data: process.env.PZ_SAVE_PATH,
      source: "environment",
    },
  ];
}

// COMMON_MOUNT_CANDIDATES above are container-internal Docker bind-mount
// conventions -- they only ever exist inside a container built to that
// convention. The panel also runs bare-metal on Linux (the packaged
// build), where a genuine SteamCMD install lives at one of a few
// well-known real host paths instead. zomboidPaths.js's
// computeCandidateZomboidPaths() has anticipated exactly these roots on
// the save-data side for a long time (~/pzserver/Zomboid, /opt/pzserver/
// Zomboid, /srv/pz/Zomboid) -- discoverMounts() never had the matching
// install-side candidates, so a bare-metal Linux operator's "Discover"
// scan came up empty no matter how standard their layout was. Confirmed
// on real ext4: a SteamCMD install at ~/pzserver with data at PZ's own
// actual default cachedir (~/Zomboid -- NOT nested under the install,
// see resolveDataPathCandidate below) was invisible before this fix.
function bareMetalLinuxCandidates() {
  if (process.platform === "win32") return [];
  const home = os.homedir();
  const roots = [];
  if (home) roots.push(path.join(home, "pzserver"));
  roots.push("/opt/pzserver");
  roots.push("/srv/pz");
  return roots.map((install) => ({ install, source: "linux-bare-metal" }));
}

function allCandidates() {
  return [
    ...envCandidates(),
    ...COMMON_MOUNT_CANDIDATES,
    ...bareMetalLinuxCandidates(),
  ];
}

// Resolves in priority order: an explicit candidate.data (Docker
// conventions where install and data are two separate bind mounts) ->
// a `Zomboid` folder nested directly under the install (co-located
// layouts) -> for a bare-metal Linux candidate specifically, the game's
// own real default cachedir ($HOME/Zomboid, independent of where the
// server binary lives). That last fallback is scoped to
// source === "linux-bare-metal" rather than applied to every candidate,
// so the already-covered Docker candidates' behavior is unchanged.
function resolveDataPathCandidate(candidate) {
  if (candidate.data) return candidate.data;
  const nested = findDataPath(candidate.install);
  if (nested) return nested;
  if (candidate.source === "linux-bare-metal") {
    const home = os.homedir();
    return home ? path.join(home, "Zomboid") : null;
  }
  return null;
}

// Probe env-configured and common Docker bind-mount locations for PZ server
// files, returning one entry per valid install found.
export function discoverMounts() {
  const candidates = [];
  const seen = new Set();

  for (const candidate of allCandidates()) {
    if (!candidate.install || seen.has(candidate.install)) continue;
    seen.add(candidate.install);

    const installResult = probeInstallPath(candidate.install);
    if (!installResult.valid) continue;

    const dataPath = resolveDataPathCandidate(candidate);
    const dataResult = probeDataPath(dataPath);

    candidates.push({
      installPath: candidate.install,
      dataPath: dataResult.valid ? dataResult.path : dataPath || null,
      source: candidate.source,
      serverNames: dataResult.serverNames.length
        ? dataResult.serverNames
        : installResult.serverNames,
      hasStartScript: installResult.hasStartScript,
      hasPanelBridge: installResult.hasPanelBridge,
    });
  }

  return candidates;
}

// Human-readable text for scanAllCandidates()'s per-candidate `reason`,
// keyed by `status`. server-detection-lifecycle-hardening, 2026-09-09: the
// operator's own words -- "people are fucking stupid... we need to remove
// pain points" -- translate to "given no way to succeed". A validator that
// says "path not found" for a path that demonstrably exists (the Docker/
// Unraid case: the user's real host path and the panel's own bind-mount
// view of it are two different strings for the same directory) is the bug
// being fixed here. Every candidate below gets a sentence a non-technical
// user can act on, not a boolean.
const CANDIDATE_STATUS_REASON = {
  ready:
    "Found a complete Project Zomboid server here -- server files and save data both present.",
  "install-only":
    "Server files found here, but no matching save-data folder yet -- it may still be initializing, or the save-data mount is missing.",
  "data-only":
    "Save data found here, but no server install files at this path.",
  "permission-denied":
    "This path exists but the panel doesn't have permission to read it -- check the file/folder permissions on this mount, or the container's user (PUID/PGID).",
  empty:
    "Nothing here yet -- this path exists but doesn't look like a Project Zomboid server or save folder.",
  "not-mounted":
    "Not mounted -- this container path doesn't exist. If you're on Docker or Unraid, check the volume/bind-mount mapping for this path in your container's settings.",
};

// Rank order, best candidate first -- the UI is expected to render in this
// order rather than re-sort, so "the top of the list is usually right" is a
// server-side guarantee, not a client-side judgment call.
const STATUS_RANK = [
  "ready",
  "install-only",
  "data-only",
  "permission-denied",
  "empty",
  "not-mounted",
];

function classifyCandidate(candidate) {
  const installState = classifyDir(candidate.install);

  if (installState === "inaccessible") {
    return { status: "permission-denied", installResult: null, dataPath: null, dataResult: null };
  }

  if (installState !== "ok") {
    // Install path itself isn't there -- still worth checking whether an
    // explicit data-side candidate (env PZ_SAVE_PATH, or a Docker template's
    // separate data mount) exists on its own, since a user can legitimately
    // have only ONE of the two paths mounted at a time while setting the
    // other up.
    const dataPath = candidate.data || null;
    if (dataPath) {
      const dataState = classifyDir(dataPath);
      if (dataState === "inaccessible") {
        return { status: "permission-denied", installResult: null, dataPath, dataResult: null };
      }
      if (dataState === "ok") {
        const dataResult = probeDataPath(dataPath);
        if (dataResult.valid) {
          return { status: "data-only", installResult: null, dataPath, dataResult };
        }
      }
    }
    return { status: "not-mounted", installResult: null, dataPath, dataResult: null };
  }

  const installResult = probeInstallPath(candidate.install);
  const dataPath = resolveDataPathCandidate(candidate);
  const dataResult = dataPath ? probeDataPath(dataPath) : null;

  if (!installResult.valid) {
    if (dataResult?.valid) {
      return { status: "data-only", installResult, dataPath, dataResult };
    }
    return { status: "empty", installResult, dataPath, dataResult };
  }

  if (dataResult?.valid) {
    return { status: "ready", installResult, dataPath, dataResult };
  }
  if (dataPath && classifyDir(dataPath) === "inaccessible") {
    return { status: "permission-denied", installResult, dataPath, dataResult };
  }
  return { status: "install-only", installResult, dataPath, dataResult };
}

// Every env-configured and common Docker/Unraid bind-mount candidate this
// module knows about, PROBED AND REPORTED REGARDLESS OF OUTCOME -- unlike
// discoverMounts() below (which silently drops anything that isn't a
// complete, ready-to-use server, the existing contract every current
// caller of discoverMounts() already depends on and must not change), this
// is the "show your work" version: ranked best-first, each entry carrying a
// `status` and a plain-language `reason`, including the paths that are
// empty or simply not mounted at all. Lets the UI show "we checked X
// places and here's what we found at each", not a silent list of only the
// places that already worked.
export function scanAllCandidates() {
  const results = [];
  const seen = new Set();

  for (const candidate of allCandidates()) {
    if (!candidate.install && !candidate.data) continue;
    const key = candidate.install || candidate.data;
    if (seen.has(key)) continue;
    seen.add(key);

    const { status, installResult, dataPath, dataResult } = classifyCandidate(candidate);

    results.push({
      installPath: candidate.install || null,
      dataPath: dataResult?.valid ? dataResult.path : dataPath || null,
      source: candidate.source,
      status,
      reason: CANDIDATE_STATUS_REASON[status],
      serverNames: dataResult?.serverNames?.length
        ? dataResult.serverNames
        : installResult?.serverNames || [],
      hasStartScript: Boolean(installResult?.hasStartScript),
      hasPanelBridge: Boolean(installResult?.hasPanelBridge),
    });
  }

  results.sort((a, b) => STATUS_RANK.indexOf(a.status) - STATUS_RANK.indexOf(b.status));
  return results;
}

// Common-mount candidates that exist but couldn't be read (permission
// denied), as opposed to candidates that simply aren't mounted at all --
// discoverMounts() silently treats both the same way (skip), which is
// correct for "not mounted" (the normal case for most of the candidate
// list) but wrong for "mounted, unreadable" (the operator's Docker volume
// IS there and misconfigured host permissions are the actual problem). Kept
// separate from discoverMounts() so its return shape stays a plain array of
// valid mounts for every existing caller.
export function discoverMountIssues() {
  const issues = [];
  const seen = new Set();

  for (const candidate of allCandidates()) {
    if (!candidate.install || seen.has(candidate.install)) continue;
    seen.add(candidate.install);

    const installResult = probeInstallPath(candidate.install);
    if (installResult.reason === "permission-denied") {
      issues.push({
        path: candidate.install,
        source: candidate.source,
        reason: "permission-denied",
      });
      continue;
    }
    if (!installResult.valid) continue;

    const dataPath = resolveDataPathCandidate(candidate);
    if (probeDataPath(dataPath).reason === "permission-denied") {
      issues.push({
        path: dataPath,
        source: candidate.source,
        reason: "permission-denied",
      });
    }
  }

  return issues;
}

function parseIni(content) {
  const result = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex > 0) {
      result[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
    }
  }
  return result;
}

function parsePort(value, fallback, max = 65535) {
  if (value === undefined || value === null || value.trim() === "") {
    return fallback;
  }
  if (!/^\d+$/.test(value.trim())) return null;
  const port = Number(value.trim());
  return Number.isInteger(port) && port >= 1 && port <= max ? port : null;
}

// Read RCON/port/name settings out of a discovered server's
// `Server/<name>.ini` so create-from-discovery can pre-fill a profile
// instead of leaving RCON blank.
export function readServerIniSettings(dataPath, serverName) {
  const iniPath = path.join(dataPath, "Server", `${serverName}.ini`);
  // codeql[js/path-injection] dataPath/serverName here come from discovery.js's POST /create-from-discovery, which only passes through discovered.dataPath (matched from the server-computed discoverMounts() list, never the raw request value) and a serverName that passed both a strict identifier regex and membership in the discovered mount's own serverNames list.
  if (!fs.existsSync(iniPath)) return null;

  let settings;
  try {
    // codeql[js/path-injection] dataPath/serverName here come from discovery.js's POST /create-from-discovery, which only passes through discovered.dataPath (matched from the server-computed discoverMounts() list, never the raw request value) and a serverName that passed both a strict identifier regex and membership in the discovered mount's own serverNames list.
    settings = parseIni(fs.readFileSync(iniPath, "utf-8"));
  } catch {
    return null;
  }

  const rconPort = parsePort(settings.RCONPort, 27015);
  const serverPort = parsePort(settings.DefaultPort, 16261, 65534);
  if (rconPort === null || serverPort === null) return null;

  return {
    rconPort,
    rconPassword: settings.RCONPassword || "",
    serverPort,
    publicName: settings.PublicName || serverName,
  };
}
