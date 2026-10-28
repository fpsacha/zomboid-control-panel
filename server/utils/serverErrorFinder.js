// The Diagnostics page's error finder: turns the active server's latest game
// log (server-console.txt, rewritten at every start) and the panel's own
// recent errors into deduplicated findings, each with what happened, why,
// the mod it belongs to and the fixes the panel can offer. Pure: the route
// (routes/debug.js GET /problems, through services/serverProblems.js) reads
// the files and hands the text in.
//
// Every signature below is the game's own wording, read from the 42.21 jar
// (constant pools of the classes named) or from a real 42 DebugLog:
//   LogSeverity            "LOG  : ", "WARN : ", "ERROR: " line prefixes;
//                          lines are "<LEVEL>: <Category>  f:0, t:<ms>, st:0> <text>",
//                          optionally led by "[dd-mm-yy hh:mm:ss.mmm] " in
//                          the Logs/ copies
//   KahluaThread           "dumping Lua stack trace", then "STACK TRACE",
//                          "Callframe at: ...", and per frame (LuaClosure)
//                          "function: <f> -- file: <file> line # <n> | MOD: <name>"
//                          ("| Vanilla" for the game's own files)
//   DebugLogStream         "<origin>> Exception thrown" + "\t<exception> at <frame>."
//   LuaManager             "Error found in LUA file: <path>"
//   ZomboidFileSystem      required mod "<id>" not found
//   ChooseGameInfo         can't find mod.info in mod dir: "<dir>"
//   GameServerWorkshopItems "Workshop: onItemNotDownloaded itemID=<id> result=<n>",
//                          "Workshop: GetItemInstallFolder() failed ID=<id>"
//                          (utils/workshopLogScan.js reads the same lines)
//   LuaManager$GlobalObject "CheckModsNeedUpdate: Mods need update" (players
//                          then get "Workshop item version is different than
//                          the server's", UI_Error_VersionMismatch)
//   GameServer             "Failed to connect to Steam servers", "*** SERVER STARTED ****"
//   SteamUtils             "SteamUtils started without Steam"
//   UdpEngine              "RakNet.Startup() return code: <n> (0 means success)",
//                          "Connection Startup Failed. Code: <n>" (RakNet's
//                          StartupResult: 5 port already in use, 6 failed to bind)
//   RCONServer             "RCON: error creating socket on port <n>",
//                          "RCON: password doesn't match"
//   IsoChunk               "Error loading chunk <x>,<y>"
//   the JVM                java.lang.OutOfMemoryError (Java heap space, GC
//                          overhead limit exceeded), Exception in thread "main"
//   PanelBridge.lua        "[PanelBridge][ERROR] ...", "[PanelBridge] ERROR: ..."
// Anything else at ERROR level still shows, grouped by its normalised text.

import crypto from "crypto";

export const FINDING_SEVERITIES = Object.freeze(["critical", "warning", "info"]);
export const FINDING_CATEGORIES = Object.freeze(["mods", "server", "network", "panel"]);

export const FINDER_LIMITS = Object.freeze({
  maxLines: 60_000,
  maxFindings: 80,
  maxOtherGroups: 25,
  maxSamples: 3,
  maxSampleLines: 12,
  maxLineChars: 300,
  maxFrameLines: 40,
  maxChunks: 10,
  tailLinesForCrash: 12,
});

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };
const CATEGORY_RANK = { mods: 0, server: 1, network: 2, panel: 3 };

// "[30-03-26 14:38:17.563] ERROR: General      f:0, t:1774895897563, st:0> text"
const ENTRY_RE = /^(?:\[[^\]]{0,40}\]\s*)?(TRACE|NOISE|DEBUG|LOG {2}|WARN |ERROR): (\S+)(.*?)> (.*)$/;
const DATE_PREFIX_RE = /^\[(\d{2})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/;
const ORIGIN_RE = /^([\w.$<>]+)\s*> ?(.*)$/;
const FRAME_RE = /^function: (.*?) -- file: (.*?) line # (\d+)(?: \| (?:MOD: (.*?)|(Vanilla)))?\.?\s*$/;
const EXCEPTION_LINE_RE = /^\s*(?:Caused by: )?([\w$]+(?:\.[\w$]+)+(?:Exception|Error))(?::\s?(.*?))?(?:\s+at [\w.$<>]+\([^)]*\))?\.?\s*$/;
const CAUSED_BY_RE = /^\s*Caused by: ([\w$]+(?:\.[\w$]+)+):?\s*(.*?)\.?\s*$/;
const LUA_TEXT_RE = /attempted index|tried to call|non-table|non-function|__index|KahluaThread|KahluaUtil|LuaCaller/i;

const BRIDGE_NAME = "zomboid control panel bridge";

// ─── Small helpers ────────────────────────────────────────────────────────

const uniq = (list) => [...new Set(list)];

function hash16(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** The stable id of a finding: its kind and a hash of its grouping key. */
export function findingId(kind, key) {
  return `${kind}-${hash16(`${kind}\n${key}`)}`;
}

/** Text with the parts that vary between two copies of one error made alike. */
export function normaliseMessage(text) {
  return String(text ?? "")
    .replace(/[A-Za-z]:[\\/][^\s"'<>|]*/g, "<path>")
    .replace(/(?:\/[\w.@+-]+){2,}\/?/g, "<path>")
    .replace(/\b0x[0-9a-f]+\b/gi, "#")
    .replace(/@[0-9a-f]{4,}\b/gi, "@#")
    .replace(/"[^"\n]{1,160}"/g, '"…"')
    .replace(/'[^'\n]{1,160}'/g, "'…'")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const IPV6_RE = /\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi;
const STEAM_ID_RE = /\b7656119\d{10}\b/g;
const SECRET_PAIR_RE = /\b(password|passwd|pwd|token|secret|api[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;

/**
 * A log line made fit for the page: IP addresses, Steam IDs and anything
 * written as password=/token=/secret=/apikey= go, then `redact` (the
 * route's known-secret and log-secret scrubbers) runs, then the line is cut.
 */
export function redactLine(line, redact = null) {
  let out = String(line ?? "")
    .replace(STEAM_ID_RE, "[STEAM-ID]")
    .replace(IPV4_RE, "[IP]")
    .replace(IPV6_RE, "[IP]")
    .replace(SECRET_PAIR_RE, (_m, key, sep) => `${key}${sep}[REDACTED]`);
  if (typeof redact === "function") {
    try {
      const next = redact(out);
      if (typeof next === "string") out = next;
    } catch {
      /* keep the built-in redaction */
    }
  }
  return out.length > FINDER_LIMITS.maxLineChars ? `${out.slice(0, FINDER_LIMITS.maxLineChars)}…` : out;
}

function entryTime(meta, raw) {
  const t = /\bt:(\d{12,14})\b/.exec(meta || "");
  if (t) {
    const ms = Number(t[1]);
    if (ms > 1.4e12 && ms < 4.2e12) return ms;
  }
  const d = DATE_PREFIX_RE.exec(raw || "");
  if (d) {
    const [, dd, mm, yy, h, mi, s, ms] = d;
    const date = new Date(2000 + Number(yy), Number(mm) - 1, Number(dd), Number(h), Number(mi), Number(s), Number(ms || 0));
    const value = date.getTime();
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/** One log line read as a DebugLog entry, or null for a continuation line. */
export function parseEntry(raw) {
  const m = ENTRY_RE.exec(raw);
  if (!m) return null;
  const level = m[1].trim();
  let text = m[4];
  let origin = null;
  const o = ORIGIN_RE.exec(text);
  if (o && /[.$]/.test(o[1])) {
    origin = o[1];
    text = o[2];
  }
  return { level, category: m[2], origin, text: text.trim(), time: entryTime(m[3], raw) };
}

// ─── Mods ─────────────────────────────────────────────────────────────────

const normPath = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** What the finder knows about the installed mods, for attributing a line. */
export function buildModIndex(mods = [], enabledModIds = []) {
  const enabled = new Set(enabledModIds);
  const byName = new Map();
  const byId = new Map();
  const byFolder = new Map();
  const dirs = [];
  for (const raw of mods) {
    if (!raw || typeof raw.id !== "string") continue;
    const mod = {
      id: raw.id,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : raw.id,
      workshopId: raw.workshopId ? String(raw.workshopId) : null,
      folder: typeof raw.folder === "string" ? raw.folder : null,
      source: raw.source || null,
      enabled: enabled.has(raw.id),
    };
    if (!byId.has(mod.id)) byId.set(mod.id, mod);
    for (const key of uniq([mod.name.toLowerCase(), mod.id.toLowerCase()])) {
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(mod);
    }
    if (mod.folder) {
      const key = `${mod.workshopId || mod.source || ""}/${mod.folder.toLowerCase()}`;
      if (!byFolder.has(key)) byFolder.set(key, mod);
      if (!byFolder.has(`*/${mod.folder.toLowerCase()}`)) byFolder.set(`*/${mod.folder.toLowerCase()}`, mod);
    }
    if (raw.dir) dirs.push({ dir: normPath(raw.dir), mod });
  }
  dirs.sort((a, b) => b.dir.length - a.dir.length);
  return { byName, byId, byFolder, dirs, enabled };
}

const preferEnabled = (list) => (list || []).find((m) => m.enabled) || (list || [])[0] || null;

/** The installed mod a Lua frame's "| MOD: <name>" names. */
export function modByName(index, name) {
  if (!name) return null;
  const key = String(name).trim().replace(/\.$/, "").toLowerCase();
  return preferEnabled(index.byName.get(key)) || null;
}

/** The installed mod (or at least the Workshop item) a game path belongs to. */
export function modByPath(index, rawPath) {
  const p = normPath(rawPath);
  if (!p) return { mod: null, workshopId: null, folder: null };
  for (const { dir, mod } of index.dirs) {
    if (p === dir || p.startsWith(`${dir}/`)) return { mod, workshopId: mod.workshopId, folder: mod.folder };
  }
  const ws = /workshop\/content\/108600\/(\d{1,15})(?:\/mods\/([^/]+))?/.exec(p);
  if (ws) {
    const folder = ws[2] || null;
    const mod = folder ? index.byFolder.get(`${ws[1]}/${folder}`) || null : null;
    return { mod, workshopId: ws[1], folder };
  }
  const staged = /\/workshop\/([^/]+)\/contents\/mods\/([^/]+)/.exec(p);
  if (staged) {
    const mod = index.byFolder.get(`staged/${staged[2]}`) || index.byFolder.get(`*/${staged[2]}`) || null;
    return { mod, workshopId: mod?.workshopId || null, folder: staged[2] };
  }
  const local = /\/mods\/([^/]+)/.exec(p);
  if (local) {
    const mod = index.byFolder.get(`local/${local[1]}`) || index.byFolder.get(`*/${local[1]}`) || null;
    return { mod, workshopId: mod?.workshopId || null, folder: local[1] };
  }
  return { mod: null, workshopId: null, folder: null };
}

function isBridgeMod(mod, bridgeModId) {
  if (!mod) return false;
  return mod.id === bridgeModId || mod.name.toLowerCase() === BRIDGE_NAME;
}

const modRef = (mod) => (mod ? { id: mod.id, name: mod.name, workshopId: mod.workshopId, enabled: mod.enabled } : null);

// ─── Fixes ────────────────────────────────────────────────────────────────

// Every fix names an EXISTING panel action (the client runs it through the
// route that already does it, with that route's own checks) or a page that
// holds the fix. `safe` ones may run in "Fix all safe issues"; the others
// ask first. `capability` is the one the action's route requires.
const fixes = {
  disableMod: (mod) => ({
    id: "disableMod",
    type: "action",
    action: "disableMod",
    params: { modId: mod.id },
    capability: "mods.manage",
    safe: false,
    confirm: true,
    undo: true,
  }),
  modsHealth: (kinds, subject) => ({
    id: "modsHealth",
    type: "action",
    action: "modsHealthFix",
    params: { kinds, ...subject },
    capability: "mods.manage",
    safe: true,
    confirm: false,
    undo: true,
  }),
  raiseMemory: (server, currentGb, nextGb) => ({
    id: "raiseMemory",
    type: "action",
    action: "raiseMemory",
    params: { serverId: server.id, currentGb, nextGb },
    capability: "servers.manage",
    safe: true,
    confirm: false,
    undo: true,
    restartNeeded: true,
  }),
  power: (server) => ({
    id: server.running ? "restartServer" : "startServer",
    type: "action",
    action: server.running ? "restartServer" : "startServer",
    params: {},
    capability: "server.control",
    safe: false,
    confirm: true,
    undo: false,
  }),
  link: (id, to) => ({ id, type: "link", to, safe: false, confirm: false, undo: false }),
};

const LINKS = {
  modsHealth: () => fixes.link("openModsHealth", "/mods?view=health"),
  mods: () => fixes.link("openMods", "/mods?view=active"),
  servers: () => fixes.link("openServers", "/servers"),
  bridge: () => fixes.link("openBridge", "/settings?tab=bridge"),
  chunks: () => fixes.link("openChunks", "/chunks"),
  logs: () => fixes.link("openLogs", "/debug?tab=logs"),
  console: () => fixes.link("openConsole", "/console"),
};

/** The memory step an out-of-memory crash asks for: +2 GB, never past the host minus 2 GB. */
export function nextMemoryGb(currentGb, hostGb) {
  const current = Number(currentGb);
  if (!Number.isFinite(current) || current <= 0) return null;
  const want = Math.floor(current) + 2;
  const cap = Number.isFinite(Number(hostGb)) && Number(hostGb) > 0 ? Math.floor(Number(hostGb)) - 2 : want;
  const next = Math.min(want, cap);
  return next > current ? next : null;
}

function fixesFor(kind, finding, ctx) {
  const { server } = ctx;
  const mod = finding.modRecord;
  const canPower = server && server.id != null && !server.isRemote && server.running !== null;
  const out = [];
  switch (kind) {
    case "luaError":
    case "luaFileError":
      if (mod && mod.enabled) out.push(fixes.disableMod(mod));
      if (mod) out.push(LINKS.mods());
      else out.push(LINKS.logs());
      break;
    case "modRequiredMissing":
      out.push(fixes.modsHealth(["requiredNotInstalled", "requiredLoadedImplicitly"], { modId: finding.params.missingModId }));
      out.push(LINKS.modsHealth());
      break;
    case "modInfoMissing":
      out.push(fixes.modsHealth(["b41Only", "notInstalled", "modInfoBroken"], {
        ...(mod ? { modId: mod.id } : {}),
        ...(finding.workshopId ? { workshopId: finding.workshopId } : {}),
      }));
      out.push(LINKS.modsHealth());
      break;
    case "workshopDownload":
      out.push(fixes.modsHealth(["notInstalled", "unusedWorkshopItem", "requiredWorkshopItemMissing"], { workshopId: finding.workshopId }));
      if (canPower) out.push(fixes.power(server));
      out.push(LINKS.mods());
      break;
    case "workshopOutdated":
    case "steamUnreachable":
      if (canPower) out.push(fixes.power(server));
      if (kind === "workshopOutdated") out.push(LINKS.mods());
      break;
    case "steamOff":
    case "portInUse":
    case "rconPortInUse":
    case "rconAuth":
      out.push(LINKS.servers());
      if (kind === "portInUse" && canPower) out.push(fixes.power(server));
      break;
    case "outOfMemory": {
      const next = server && !server.isRemote && server.memoryManaged !== false ? nextMemoryGb(server.maxMemoryGb, server.hostMemoryGb) : null;
      if (next !== null && server.id != null) out.push(fixes.raiseMemory(server, Number(server.maxMemoryGb), next));
      if (canPower) out.push(fixes.power(server));
      out.push(LINKS.servers());
      break;
    }
    case "chunkLoad":
      out.push(LINKS.chunks());
      break;
    case "panelBridge":
      out.push(LINKS.bridge());
      break;
    case "startupCrash":
      if (canPower && !server.running) out.push(fixes.power(server));
      out.push(LINKS.console());
      break;
    case "panelError":
      out.push(LINKS.logs());
      break;
    case "processScanFailing":
      // Nothing to click: the panel already works around it.
      break;
    default:
      out.push(LINKS.logs());
  }
  return out;
}

// ─── Signatures ───────────────────────────────────────────────────────────

const KIND_META = {
  luaError: { category: "mods", severity: "warning" },
  luaFileError: { category: "mods", severity: "warning" },
  modRequiredMissing: { category: "mods", severity: "critical" },
  modInfoMissing: { category: "mods", severity: "warning" },
  workshopDownload: { category: "mods", severity: "critical" },
  workshopOutdated: { category: "mods", severity: "warning" },
  steamUnreachable: { category: "network", severity: "critical" },
  steamOff: { category: "network", severity: "warning" },
  portInUse: { category: "network", severity: "critical" },
  rconPortInUse: { category: "network", severity: "warning" },
  rconAuth: { category: "network", severity: "warning" },
  outOfMemory: { category: "server", severity: "critical" },
  chunkLoad: { category: "server", severity: "warning" },
  startupCrash: { category: "server", severity: "critical" },
  javaException: { category: "server", severity: "warning" },
  other: { category: "server", severity: "info" },
  panelBridge: { category: "panel", severity: "warning" },
  panelError: { category: "panel", severity: "warning" },
  processScanFailing: { category: "panel", severity: "warning" },
};

// ServerManager's warning when a Windows process scan fails; this many in the
// panel's recent log make one finding (a 1.5.0 support bundle had 2,057).
// SECURITY (2026-10-28): anchored to the start of ServerManager's own line.
// The log also holds text a stranger chose (POST /api/debug/client-errors
// takes reports before sign-in, logged as "[ClientError] <message>"), and an
// unanchored match let such a report raise this warning in Problems found.
const PROCESS_SCAN_FAILED_RE = /^getServerProcessDetails: Windows process scan failed \((.*)\)/;
export const PROCESS_SCAN_FAILURES_FOR_FINDING = 3;

export const FINDING_KINDS = Object.freeze(Object.keys(KIND_META));

// Single-line signatures, first match wins. `make` returns { key, params,
// message?, path? } or null to let the line fall through.
const LINE_SIGNATURES = [
  {
    kind: "outOfMemory",
    re: /java\.lang\.OutOfMemoryError(?::\s*([^\n]*))?/,
    make: (m) => ({ key: "oom", params: { detail: (m[1] || "").trim().replace(/\.$/, "") || null } }),
  },
  {
    kind: "workshopDownload",
    re: /Workshop:\s+onItemNotDownloaded\s+itemID=(\d{1,15})\s+result=(\d+)/,
    make: (m) => ({ key: m[1], workshopId: m[1], params: { result: Number(m[2]) } }),
  },
  {
    kind: "workshopDownload",
    re: /Workshop:\s+GetItemInstallFolder\(\) failed ID=(\d{1,15})(?!\d)/,
    make: (m) => ({ key: m[1], workshopId: m[1], params: { result: null } }),
  },
  { kind: "workshopOutdated", re: /CheckModsNeedUpdate: Mods need update/, make: () => ({ key: "outdated", params: {} }) },
  { kind: "steamUnreachable", re: /Failed to connect to Steam servers/, make: () => ({ key: "steam", params: {} }) },
  {
    kind: "steamOff",
    re: /SteamUtils started without Steam/,
    make: (_m, ctx) => (ctx.workshopItems.length > 0 ? { key: "nosteam", params: { items: ctx.workshopItems.length } } : null),
  },
  {
    kind: "portInUse",
    re: /RakNet\.Startup\(\) return code: (-?\d+) \(0 means success\)/,
    make: (m, ctx) => (m[1] === "0" ? null : { key: "raknet", params: { code: Number(m[1]), port: ctx.server?.defaultPort ?? null } }),
  },
  {
    kind: "portInUse",
    re: /Connection Startup Failed\. Code: (-?\w+)/,
    make: (m, ctx) => ({ key: "raknet", params: { code: /^-?\d+$/.test(m[1]) ? Number(m[1]) : m[1], port: ctx.server?.defaultPort ?? null } }),
  },
  {
    kind: "rconPortInUse",
    re: /RCON: error creating socket on port (\d{1,5})/,
    make: (m) => ({ key: m[1], params: { port: Number(m[1]) } }),
  },
  { kind: "rconAuth", re: /RCON: password doesn't match/, make: () => ({ key: "rcon", params: { from: "game" } }) },
  {
    kind: "modRequiredMissing",
    re: /required mod "([^"]{1,200})" not found/,
    make: (m) => ({ key: m[1], params: { missingModId: m[1] } }),
  },
  {
    kind: "modInfoMissing",
    re: /can't find mod\.info in mod dir: "([^"]{1,500})"/,
    make: (m) => ({ key: normPath(m[1]), path: m[1], params: {} }),
  },
  {
    kind: "luaFileError",
    re: /Error found in LUA file: (.{1,500}?)\s*$/,
    make: (m) => ({ key: normPath(m[1]), path: m[1], params: { file: m[1].replace(/\\/g, "/").split("/").slice(-3).join("/") } }),
  },
  {
    kind: "chunkLoad",
    re: /Error loading chunk (-?\d+),(-?\d+)/,
    make: (m) => ({ key: "chunks", params: { chunk: `${m[1]},${m[2]}` } }),
  },
  {
    kind: "panelBridge",
    re: /\[PanelBridge\](?:\[ERROR\]\s*|\s+(?:ERROR:|Error:|Error writing:|JSON parse error:)\s*)(.*)$/,
    make: (m) => ({ key: normaliseMessage(m[1]), params: {} }),
  },
  {
    kind: "javaException",
    re: /Exception in thread "main" ([\w.$]+)(?::\s*(.*))?/,
    make: (m) => ({ key: `main|${m[1]}|${normaliseMessage(m[2])}`, params: { exception: m[1].split(".").pop() }, severity: "critical" }),
  },
];

// ─── Scanning ─────────────────────────────────────────────────────────────

function splitLines(logs) {
  const lines = [];
  for (const log of logs || []) {
    if (!log || typeof log.text !== "string" || !log.text) continue;
    let parts = log.text.split(/\r?\n/);
    if (log.partialStart && parts.length > 1) parts = parts.slice(1);
    if (lines.length && log.gapBefore) lines.push(null);
    for (const part of parts) {
      if (lines.length >= FINDER_LIMITS.maxLines) break;
      lines.push(part);
    }
  }
  return lines;
}

// The Lua error that starts at `i` (a "dumping Lua stack trace" line): its
// frames, its message (the flushErrorMessage line before, else the exception
// after, else its "Caused by:"), and every line it used.
function readLuaError(lines, i, entries) {
  const used = [i];
  const frames = [];
  let j = i + 1;
  for (; j < lines.length && j - i <= FINDER_LIMITS.maxFrameLines; j++) {
    const line = lines[j];
    if (line === null || entries[j]) break;
    used.push(j);
    const f = FRAME_RE.exec(line.trim());
    if (f) frames.push({ fn: f[1], file: f[2], line: Number(f[3]), mod: f[4] ? f[4].trim().replace(/\.$/, "") : null, vanilla: Boolean(f[5]) });
  }
  let message = null;
  const before = i > 0 ? entries[i - 1] : null;
  if (before && before.origin === "KahluaThread.flushErrorMessage" && !/dumping Lua stack trace/.test(before.text)) {
    message = before.text.replace(/\.$/, "");
    used.push(i - 1);
  }
  // The "Exception thrown" entry right after the frames, and its lines.
  if (j < lines.length && entries[j] && /Exception thrown/.test(entries[j].text)) {
    used.push(j);
    let exception = null;
    let cause = null;
    for (let k = j + 1; k < lines.length && k - j <= 120; k++) {
      if (lines[k] === null || entries[k]) break;
      used.push(k);
      const c = CAUSED_BY_RE.exec(lines[k]);
      if (c && !cause) cause = `${c[1].split(".").pop()}: ${c[2]}`.replace(/: $/, "");
      if (exception === null) {
        const e = EXCEPTION_LINE_RE.exec(lines[k]);
        if (e) exception = (e[2] || "").trim();
      }
    }
    // An InvocationTargetException says nothing: its "Caused by:" does.
    if (!message) message = exception || cause || null;
  }
  return { frames, message: message || null, used };
}

function sampleOf(lines, indices, redact) {
  const out = [];
  for (const k of [...new Set(indices)].sort((a, b) => a - b)) {
    if (lines[k] === null || lines[k] === undefined) continue;
    const text = lines[k].replace(/\s+$/, "");
    if (!text) continue;
    out.push(redactLine(text, redact));
    if (out.length >= FINDER_LIMITS.maxSampleLines) break;
  }
  return out.join("\n");
}

/**
 * @param {object} input
 * @param {{ text: string, partialStart?: boolean, gapBefore?: boolean }[]} input.logs
 *   the latest game log, in file order (a head and a tail when it is long)
 * @param {Date|string|number|null} input.logMtime  when the log was last written
 * @param {{ level: string, message: unknown, timestamp?: string, source?: string }[]} input.panelLog
 * @param {object[]} input.mods  installed mods: { id, name, workshopId, folder, dir, source }
 * @param {string[]} input.enabledModIds  Mods=
 * @param {string[]} input.workshopItems  WorkshopItems=
 * @param {object|null} input.server  { id, running (true|false|null), isRemote, maxMemoryGb, hostMemoryGb, defaultPort }
 * @param {string} [input.bridgeModId]
 * @param {(text: string) => string} [input.redact]
 * @returns {{ findings: object[], counts: object, checked: object }}
 */
export function findServerErrors(input = {}) {
  const {
    logs = [],
    logMtime = null,
    panelLog = [],
    mods = [],
    enabledModIds = [],
    workshopItems = [],
    server = null,
    bridgeModId = "ZCPB",
    redact = null,
  } = input;
  const index = buildModIndex(mods, enabledModIds);
  const ctx = { server, workshopItems: Array.isArray(workshopItems) ? workshopItems : [], index };
  const lines = splitLines(logs);
  const entries = lines.map((line) => (line === null ? null : parseEntry(line)));
  const groups = new Map();
  const used = new Set();
  const fallbackTime = logMtime ? new Date(logMtime).getTime() : null;

  const record = (kind, key, { at, time, sample, params = {}, mod = null, workshopId = null, message = null, severity = null, source = "game" }) => {
    const id = findingId(kind, key);
    let group = groups.get(id);
    if (!group) {
      const meta = KIND_META[kind];
      group = {
        id,
        kind,
        category: meta.category,
        severity: severity || meta.severity,
        source,
        count: 0,
        firstSeen: null,
        lastSeen: null,
        firstLine: at,
        message: message ? redactLine(message, redact) : null,
        params: { ...params },
        modRecord: mod,
        workshopId: workshopId || mod?.workshopId || null,
        samples: [],
        chunks: [],
      };
      groups.set(id, group);
    }
    group.count++;
    if (Number.isFinite(time)) {
      if (group.firstSeen === null || time < group.firstSeen) group.firstSeen = time;
      if (group.lastSeen === null || time > group.lastSeen) group.lastSeen = time;
    }
    if (kind === "chunkLoad" && params.chunk && group.chunks.length < FINDER_LIMITS.maxChunks && !group.chunks.includes(params.chunk)) {
      group.chunks.push(params.chunk);
    }
    if (sample) {
      group.samples.push(sample);
      if (group.samples.length > FINDER_LIMITS.maxSamples) group.samples.shift();
    }
    return group;
  };

  // The time of the entry a line belongs to.
  const timeAt = (i) => {
    for (let k = i; k >= 0 && i - k < 200; k--) {
      if (entries[k]) return entries[k].time;
      if (lines[k] === null) break;
    }
    return null;
  };

  // Lua errors first: the stack the game dumps, the message line before it
  // and the exception after it (none of which may count again below).
  // The game often dumps one error's stack twice in a row, the second time
  // with no message: that second dump is not a second error.
  let prevLua = null;
  for (let i = 0; i < lines.length; i++) {
    const entry = entries[i];
    if (entry && /dumping Lua stack trace/.test(entry.text)) {
      const lua = readLuaError(lines, i, entries);
      for (const k of lua.used) used.add(k);
      const framesKey = lua.frames.map((f) => `${f.file}:${f.line}:${f.fn}`).join("|");
      const repeat = !lua.message && prevLua && prevLua.framesKey === framesKey && i - prevLua.end <= 3;
      prevLua = { framesKey, end: Math.max(i, ...lua.used) };
      if (repeat) continue;
      const owner = lua.frames.find((f) => f.mod) || null;
      const top = lua.frames[0] || null;
      const mod = owner ? modByName(index, owner.mod) : null;
      const bridge = (mod && isBridgeMod(mod, bridgeModId))
        || (owner && owner.mod.toLowerCase() === BRIDGE_NAME)
        || lua.frames.some((f) => /^panelbridge\.lua$/i.test(f.file));
      const where = owner || top;
      const message = lua.message || (where ? `${where.fn} (${where.file} line ${where.line})` : "Lua error");
      const kind = bridge ? "panelBridge" : "luaError";
      const modKey = mod ? `id:${mod.id}` : owner ? `name:${owner.mod.toLowerCase()}` : "vanilla";
      // One error per place in one mod: its message can vary with the data.
      const key = `${modKey}|${where ? `${where.file}:${where.line}:${where.fn}` : normaliseMessage(lua.message || "")}`;
      const group = record(kind, key, {
        at: i,
        time: entry.time,
        sample: sampleOf(lines, lua.used, redact),
        message,
        mod,
        params: {
          modName: mod ? mod.name : owner ? owner.mod : null,
          file: where ? where.file : null,
          line: where ? where.line : null,
          function: where ? where.fn : null,
          vanilla: !owner,
        },
      });
      if (kind === "luaError" && !owner) group.category = "server";
      if (lua.message && group.messageFallback) {
        group.message = redactLine(lua.message, redact);
        group.messageFallback = false;
      } else if (group.count === 1 && !lua.message) {
        group.messageFallback = true;
      }
    }
  }

  let started = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === null || used.has(i)) continue;
    if (!started && /\*\*\* SERVER STARTED \*\*\*|> SERVER STARTED\b/.test(line)) started = true;
    const entry = entries[i];

    // One-line signatures (anywhere in the line: a Lua print() lands inside
    // a "LOG  : Lua" entry).
    let matched = false;
    for (const sig of LINE_SIGNATURES) {
      const m = sig.re.exec(line);
      if (!m) continue;
      const made = sig.make(m, ctx);
      if (!made) {
        matched = true;
        break;
      }
      let mod = null;
      let workshopId = made.workshopId || null;
      if (made.path) {
        const found = modByPath(index, made.path);
        mod = found.mod;
        workshopId = workshopId || found.workshopId;
        if (!mod && found.folder) made.params.folder = found.folder;
      }
      if (sig.kind === "workshopDownload") {
        const owners = mods.filter((x) => String(x?.workshopId || "") === workshopId);
        if (owners.length) made.params.modNames = uniq(owners.map((x) => x.name || x.id)).slice(0, 5);
      }
      if (mod) made.params.modName = mod.name;
      const kind = sig.kind === "luaFileError" && mod && isBridgeMod(mod, bridgeModId) ? "panelBridge" : sig.kind;
      const group = record(kind, made.key, {
        at: i,
        time: entry ? entry.time : timeAt(i),
        sample: sampleOf(lines, [i, i + 1, i + 2].filter((k) => k === i || (lines[k] !== null && k < lines.length && !entries[k])), redact),
        params: made.params,
        mod,
        workshopId,
        message: entry ? entry.text : line.trim(),
        severity: made.severity || null,
      });
      if (sig.kind === "luaFileError" && !mod) group.category = "server";
      used.add(i);
      matched = true;
      break;
    }
    if (matched || !entry || entry.level !== "ERROR") continue;

    // Anything else at ERROR level: an exception by its class and message,
    // other text by its normalised self.
    if (/^Exception thrown/.test(entry.text)) {
      let exception = null;
      const idx = [i];
      for (let k = i + 1; k < lines.length && k - i <= 6; k++) {
        if (lines[k] === null || entries[k]) break;
        idx.push(k);
        const e = EXCEPTION_LINE_RE.exec(lines[k]);
        if (e && !exception) exception = { cls: e[1], text: e[2] };
      }
      const cls = exception ? exception.cls.split(".").pop() : "Exception";
      const text = exception ? exception.text : "";
      const lua = LUA_TEXT_RE.test(text);
      const group = record(lua ? "luaError" : "javaException", `${cls}|${normaliseMessage(text)}|${entry.origin || ""}`, {
        at: i,
        time: entry.time,
        sample: sampleOf(lines, idx, redact),
        message: text ? `${cls}: ${text}` : cls,
        params: { exception: cls, origin: entry.origin, vanilla: lua ? true : undefined },
      });
      if (lua) group.category = "server";
      continue;
    }
    record("other", normaliseMessage(`${entry.origin || ""} ${entry.text}`), {
      at: i,
      time: entry.time,
      sample: sampleOf(lines, [i], redact),
      message: entry.text,
      params: { origin: entry.origin },
    });
  }

  // A start that never reached SERVER STARTED, by a server that is not
  // running, with an error near the end: the server crashed while starting.
  const realLines = lines.filter((l) => l !== null && l.trim() !== "");
  if (server && server.running === false && realLines.length > 0 && !started) {
    const tail = [];
    for (let k = lines.length - 1; k >= 0 && tail.length < FINDER_LIMITS.tailLinesForCrash; k--) {
      if (lines[k] === null) break;
      if (lines[k].trim()) tail.unshift(k);
    }
    const tailHasError = tail.some((k) => (entries[k] && entries[k].level === "ERROR") || /Exception|Error\b|FATAL/.test(lines[k]));
    if (tailHasError) {
      const lastError = [...tail].reverse().map((k) => entries[k]).find((e) => e && e.level === "ERROR");
      record("startupCrash", "startup", {
        at: lines.length,
        time: timeAt(tail[tail.length - 1]),
        sample: sampleOf(lines, tail, redact),
        message: lastError ? lastError.text : lines[tail[tail.length - 1]].trim(),
        params: {},
      });
    }
  }

  // The panel's own errors, from its in-memory log.
  let panelEntries = 0;
  const scanFailures = [];
  for (const raw of Array.isArray(panelLog) ? panelLog : []) {
    if (!raw) continue;
    const text = typeof raw.message === "string" ? raw.message : JSON.stringify(raw.message ?? "");
    const first = String(text).split(/\r?\n/)[0];
    const time = raw.timestamp ? new Date(raw.timestamp).getTime() : null;
    // Failed Windows process scans are warnings, one per poll: counted
    // into the one finding below, not listed one by one.
    if (PROCESS_SCAN_FAILED_RE.test(first)) {
      scanFailures.push({ first, time });
      continue;
    }
    if (raw.level !== "error") continue;
    panelEntries++;
    const source = typeof raw.source === "string" ? raw.source : "server";
    const rcon = /rcon/i.test(source) && /authenticat|auth_failed|password/i.test(first);
    record(rcon ? "rconAuth" : "panelError", rcon ? "rcon" : `${source}|${normaliseMessage(first)}`, {
      at: Number.MAX_SAFE_INTEGER,
      time: Number.isFinite(time) ? time : null,
      sample: redactLine(`[${source}] ${first}`, redact),
      message: first,
      params: rcon ? { from: "panel" } : { source },
      source: "panel",
    });
  }
  if (scanFailures.length >= PROCESS_SCAN_FAILURES_FOR_FINDING) {
    const last = scanFailures[scanFailures.length - 1];
    const group = record("processScanFailing", "windows", {
      at: Number.MAX_SAFE_INTEGER,
      time: Number.isFinite(last.time) ? last.time : null,
      sample: redactLine(last.first, redact),
      message: last.first,
      params: {
        n: scanFailures.length,
        timedOut: scanFailures.some((entry) => /timed out/i.test(PROCESS_SCAN_FAILED_RE.exec(entry.first)[1])),
      },
      source: "panel",
    });
    group.count = scanFailures.length;
    const first = scanFailures.find((entry) => Number.isFinite(entry.time));
    if (first) group.firstSeen = first.time;
  }

  // Shape the findings: the "other" groups capped to the most frequent.
  let list = [...groups.values()];
  const others = list.filter((g) => g.kind === "other").sort((a, b) => b.count - a.count || a.firstLine - b.firstLine);
  const keepOthers = new Set(others.slice(0, FINDER_LIMITS.maxOtherGroups).map((g) => g.id));
  const droppedOthers = others.length - keepOthers.size;
  list = list.filter((g) => g.kind !== "other" || keepOthers.has(g.id));

  const findings = list.map((g) => {
    const params = { ...g.params };
    if (g.kind === "chunkLoad") {
      params.chunks = g.chunks;
      delete params.chunk;
    }
    for (const key of Object.keys(params)) if (params[key] === undefined) delete params[key];
    const finding = {
      id: g.id,
      kind: g.kind,
      category: g.category,
      severity: g.severity,
      source: g.source,
      count: g.count,
      firstSeen: g.firstSeen !== null ? new Date(g.firstSeen).toISOString() : null,
      lastSeen: g.lastSeen !== null ? new Date(g.lastSeen).toISOString() : g.source === "game" && Number.isFinite(fallbackTime) ? new Date(fallbackTime).toISOString() : null,
      timesFromLog: g.lastSeen !== null,
      message: g.message,
      cause: causeOf(g.kind, params),
      modId: g.modRecord ? g.modRecord.id : null,
      workshopId: g.workshopId || null,
      mod: modRef(g.modRecord),
      params,
      samples: g.samples,
    };
    finding.fixes = fixesFor(g.kind, { ...finding, modRecord: g.modRecord }, ctx);
    return finding;
  });

  findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] ||
      b.count - a.count ||
      a.id.localeCompare(b.id),
  );
  const shown = findings.slice(0, FINDER_LIMITS.maxFindings);
  const counts = { critical: 0, warning: 0, info: 0, total: shown.length };
  for (const f of shown) counts[f.severity]++;
  return {
    findings: shown,
    counts,
    checked: {
      gameLogLines: realLines.length,
      serverStarted: started,
      panelErrors: panelEntries,
      mods: index.byId.size,
      hiddenFindings: findings.length - shown.length + Math.max(0, droppedOthers),
    },
  };
}

// Plain-English "why", for API readers and logs; the page shows its own
// translated text per kind.
function causeOf(kind, params) {
  switch (kind) {
    case "luaError":
      return params.modName
        ? `A Lua script of the mod "${params.modName}" failed. The rest of that script stops running, so part of the mod does not work.`
        : "A Lua script failed: part of the game or of a mod does not work.";
    case "luaFileError":
      return "The game could not load a Lua file, usually a syntax error in a mod or a file from another game version.";
    case "modRequiredMissing":
      return `A mod needs "${params.missingModId}", which is not installed, so the mod that needs it is skipped.`;
    case "modInfoMissing":
      return "A mod folder has no mod.info the game can read: the download is incomplete or the mod is not made for this game version.";
    case "workshopDownload":
      return "The server could not download a Workshop item (removed, private, or Steam refused it). The server stops while starting.";
    case "workshopOutdated":
      return "A Workshop mod was updated after the server started. Players get the new version and cannot join until the server restarts.";
    case "steamUnreachable":
      return "The server could not reach Steam while starting and stopped.";
    case "steamOff":
      return "The server started without Steam, so it loads no Workshop item.";
    case "portInUse":
      return "The game could not open its network port. Another program, often a second copy of this server, is using it.";
    case "rconPortInUse":
      return "The RCON port is already in use, so RCON does not work.";
    case "rconAuth":
      return "An RCON connection used the wrong password.";
    case "outOfMemory":
      return "The server ran out of memory. Java stops the server or it freezes.";
    case "chunkLoad":
      return "Some map chunks could not be read. They may be damaged.";
    case "startupCrash":
      return "The server stopped while starting. The last lines of its log say why.";
    case "javaException":
      return "The game reported an unexpected error.";
    case "panelBridge":
      return "PanelBridge, the panel's in-game helper, reported an error.";
    case "panelError":
      return "The panel itself reported an error.";
    case "processScanFailing":
      return `The panel's check for the server process failed ${params.n} times, usually because the PC is slow or antivirus software scans each PowerShell check. The panel waits longer for it; Start and restarts also accept the RCON port closing plus the game log's shutdown lines as proof the server stopped, and Start asks you to confirm when it still can't tell.`;
    default:
      return "The game logged an error.";
  }
}
