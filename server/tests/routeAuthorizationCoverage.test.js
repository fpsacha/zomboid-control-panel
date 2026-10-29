import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// sweep-round5 (2026-09-07): Pam's activeServerChangedSweep pattern
// (text-level, one static guard, not N behavioural tests) applied to
// authorization. god's framing: "your sweep is the most perishable
// artifact on this floor right now -- it is correct for exactly as long
// as nobody adds a route." This is what turns a 424-route denominator
// from a snapshot in a chat message into something the suite enforces.
//
// Deliberately cheap and regex-based, not a full AST parse -- same
// convention errorCodeRegistry.test.js already established for the
// identical class of problem (scanning source for a recognizable
// middleware-call SHAPE, not evaluating what it actually does). It
// proves a route is COVERED by *some* capability check, or is a
// documented, reasoned exception -- it cannot verify the check enforces
// the RIGHT capability. That's what the rest of this session's
// route-by-route reading was for; this guard exists so the next 400
// routes don't all need that treatment by hand.
//
// WHAT THIS DOES NOT CATCH, ON PURPOSE (same posture as the errorCode
// registry tests' own documented gaps): a route gated on the WRONG
// capability (wrong string, still a real requirePermission call); a
// capability check performed deep inside a handler body rather than as
// middleware, more than ~6 lines from the route's own declaration; a
// brand-new custom gate-function SHAPE this file's regex has never seen
// (KNOWN_CUSTOM_GATE_NAMES below is a hand-verified allowlist of the
// ones that exist today, not a general detector).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.join(__dirname, "..", "routes");

function listRouteFiles() {
  return fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".js"));
}

// Matches `router.<method>(` followed by its path string, allowing at most
// one line break between the open paren and the path -- covers every
// multi-line route declaration found in this codebase today (auth.js's
// PATCH /users/:id/role and POST /regenerate-jwt-secret, servers.js's two
// lifecycle routes, debug.js's POST /fix-writability). A declaration split
// across MORE than one line before the path string would be invisible to
// this regex -- acceptable for the same reason errorCodeRegistry.test.js
// accepts its own regex's blind spots: the shape is narrow, well-defined,
// and this test's sanity check (below) proves the regex still finds real
// routes in real files, so a systemic drift would show up as a route-count
// collapse, not a silent zero.
const ROUTE_DECL_RE =
  /router\.(get|post|put|patch|delete)\(\s*(?:\r?\n\s*)?(["'`])((?:\\.|(?!\2)[^\r\n])*)\2/g;

// A route's own gate is searched for in a bounded window starting at the
// route declaration -- long enough to cover every multi-line declaration
// found (longest is 4 lines), short enough that it can't accidentally
// match a NEXT route's unrelated gate.
const GATE_WINDOW_CHARS = 400;

// Recognized inline-gate call shapes. requireCapabilityInline is the
// conditional-gate helper used by rcon.js (POST /connect, only when the
// request overrides host/port/password) and scheduler.js (per-command,
// layered on top of that file's router.use blanket) -- confirmed by
// reading both call sites, not assumed from the name.
const INLINE_GATE_RE = /require(Permission|AnyPermission|Role|CapabilityInline)\(/;

// A route's own gate argument is often a NAMED CONST, not a literal call --
// e.g. backup.js's `const requireAnyBackupCapability = requireAnyPermission(...)`
// then `router.get("/status", requireAnyBackupCapability, ...)`. The literal
// call lives at the const's DEFINITION, not at the route site, so
// INLINE_GATE_RE alone misses it (confirmed the hard way: this test failed
// on backup.js's own three routes on first run, against the fix landed
// earlier in this same session -- a real gap in the detector, not a false
// alarm about the routes themselves). Auto-detected per file: any
// `const NAME = requirePermission(...)` / `requireAnyPermission(...)`
// assignment anywhere in the file adds NAME to that file's known-gate-names.
const NAMED_GATE_CONST_RE = /const\s+(\w+)\s*=\s*require(?:Permission|AnyPermission)\(/g;

// Custom gate FUNCTIONS that don't fit the const-assignment shape above --
// hand-verified once, by reading the function body, not assumed from its
// name. panelBridge.js's requireBridgeCommandUnlessGmToolsOnly: for the
// twelve GM-tools/endanger-or-impersonate actions it calls next()
// immediately (enforced instead by a verified inline per-action capability
// check further down the same handler, against BRIDGE_ACTION_CAPABILITY);
// for every other action it delegates to requireBridgeCommand, itself
// requirePermission("bridge.command").
const KNOWN_CUSTOM_GATE_FUNCTIONS = {
  "panelBridge.js": ["requireBridgeCommandUnlessGmToolsOnly"],
};

function knownGateNamesFor(file, source) {
  const names = new Set(KNOWN_CUSTOM_GATE_FUNCTIONS[file] || []);
  let match;
  NAMED_GATE_CONST_RE.lastIndex = 0;
  while ((match = NAMED_GATE_CONST_RE.exec(source))) {
    names.add(match[1]);
  }
  return names;
}

// Comments are left out: a handler that only MENTIONS requirePermission()
// in a comment (auth.js GET /me does) has no gate.
function withoutComments(window) {
  return window
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\/\/|\/?\*).*$/, "").replace(/\s\/\/.*$/, ""))
    .join("\n");
}

function windowHasKnownGate(window, knownNames) {
  const code = withoutComments(window);
  if (INLINE_GATE_RE.test(code)) return true;
  for (const name of knownNames) {
    if (new RegExp(`\\b${name}\\b`).test(code)) return true;
  }
  return false;
}

// Hand-verified once, by reading each file directly (not relayed from a
// sub-agent): a single router.use(...) call that gates EVERY route
// registered after it in that file. `mustContain` is the exact substring
// that must still be present -- if a future refactor removes or rewords
// the blanket, this string vanishes and the whole file's routes fall
// through to individual inline-gate checking, which will then fail loudly
// naming every route that lost its gate, rather than silently trusting a
// gate that's no longer there.
const BLANKET_GATED_FILES = {
  "discord.js": { mustContain: 'router.use(requirePermission("integrations.manage"));' },
  "scheduler.js": { mustContain: "router.use(requirePermission('automation.manage'));" },
  "serverFinder.js": { mustContain: "router.use(requirePermission('server.install'));" },
  "serverFiles.js": { mustContain: 'router.use(requirePermission("serverfiles.manage"));' },
  "files.js": { mustContain: 'router.use(requirePermission("files.manage"));' },
  "permissions.js": { mustContain: 'router.use(requirePermission("roles.manage"));' },
  // Wrapped, not a direct call: gates every route EXCEPT /thumbnail/* (see
  // that route's own entry in UNGATED_BY_DESIGN below) via a
  // previously-constructed requirePermission("mods.manage") reference.
  // Both substrings must survive together, or the exemption logic itself
  // may have changed shape.
  "mods.js": {
    mustContain: "router.use((req, res, next) => {",
    alsoMustContain: 'return requireModsManage(req, res, next);',
  },
};

// Every route with no inline gate, in a file with no blanket gate (or the
// one documented exception inside a blanket-gated file), keyed by
// "file METHOD /path". A route here with no real reason is a hole; an
// entry missing from here for a genuinely ungated route is a route this
// test doesn't know about and will fail on -- which is the point.
//
// Re-derived directly from source for this test (not transcribed from the
// sweep's own sub-agent summaries), after those summaries were found to
// contain a real counting error (auth.js's ungated total) and one
// misattribution (panelBridge.js's GET /status credited with a
// password-excluding getConfig() call it never actually makes -- see
// memory.md / the outbox report for that finding, reported separately and
// NOT fixed in this commit; its entry below notes the caveat rather than
// hiding it).
const UNGATED_BY_DESIGN = new Map([
  // --- auth.js: pre-session flows and self-scoped-by-req.user routes ---
  ["auth.js GET /status", "pre-session: tells the client whether setup/login is needed before any session exists"],
  ["auth.js POST /setup", "pre-session: first-run account creation, only works when no users exist yet"],
  ["auth.js POST /login", "pre-session: this IS how a session begins"],
  ["auth.js POST /extension-proof", "pre-session: the Steam Sync extension checks a plain-http:// address is the panel before it signs in; answers only an HMAC of the caller's own challenge, rate-limited"],
  ["auth.js POST /refresh", "pre-session: the refresh token itself is the credential being checked"],
  ["auth.js POST /logout", "pre-session: clears a cookie, no capability model applies to ending your own session"],
  ["auth.js GET /me", "self-scoped via getAuthenticatedUser(req) -- never a caller-supplied id"],
  ["auth.js POST /change-password", "self-scoped via getAuthenticatedUser(req) -- never a caller-supplied id"],
  ["auth.js POST /sessions/revoke-all", "self-scoped via getAuthenticatedUser(req) -- never a caller-supplied id"],
  ["auth.js GET /reset-status", "pre-session: part of the no-admin-account recovery flow"],
  ["auth.js GET /recovery-status", "pre-session: same recovery flow"],
  ["auth.js POST /recover-with-code", "pre-session: same recovery flow, rate-limited"],
  ["auth.js POST /reset-token/local", "pre-session: same recovery flow, rate-limited"],
  ["auth.js POST /reset-password", "pre-session: same recovery flow, rate-limited"],

  // --- backup.js ---
  ["backup.js GET /info", "static description text (what a backup contains) -- no per-install data"],

  // --- config.js ---
  ["config.js GET /app-settings", "response passed through maskSensitiveObject() before returning"],

  // --- debug.js ---
  ["debug.js POST /client-errors", "must be reachable pre-auth (the login page itself can crash); rate-limited 30/min/IP, log-only, no state mutation"],

  // --- mapProxy.js: hardcoded proxy target, validated path segments, no secrets ---
  ["mapProxy.js GET /resolve", "read-only map geometry, no secrets"],
  // GET /vehicles left this list 2026-10-20 (access-control audit): saved
  // vehicle positions are world-position data, now players.view's.
  ["mapProxy.js GET /tiles/:level/:tile", "exempted from authentication entirely (an <img> tag load carries no auth header); proxy target host is a hardcoded constant, level/floor/tile are strictly bounded/regex-validated"],
  ["mapProxy.js GET /toptiles/:level/:tile", "same as /tiles -- img-tag exemption, hardcoded host, validated path segments"],
  ["mapProxy.js GET /b41tiles/:level/:tile", "same as /tiles -- img-tag exemption, hardcoded host, validated path segments"],

  // --- mods.js: the one exception inside an otherwise-blanket-gated file ---
  ["mods.js GET /thumbnail/:workshopId", "exempted from both the mods.manage blanket AND authentication entirely -- documented regression guard citing a real prior incident (9c6ce2e/v1.2.0); workshopId is regex-validated, cache path is confined to its own directory"],

  // --- oidc.js: pre-session OIDC login flow ---
  ["oidc.js GET /status", "pre-session: tells the client whether OIDC login is offered"],
  ["oidc.js GET /login", "pre-session: starts the OIDC redirect"],
  ["oidc.js GET /callback", "pre-session: the OIDC provider redirects back here before a local session exists"],

  // --- panelBridge.js ---
  // GET /status used to be in this list (a documented caveat: leaked
  // bridgePath/cachePath/remotePath/remoteDirectories to any authenticated
  // user). Follow-up landed: cachePath/remotePath/remoteDirectories were
  // never read anywhere in client/src (grepped, not assumed) and were
  // removed from the response entirely (services/panelBridgeSftp.js);
  // bridgePath and statusFile.path ARE genuinely rendered in Settings.tsx,
  // so the route itself is now gated requireAnyPermission("bridge.setup",
  // "bridge.diagnostics") instead -- see its own route-level comment. It
  // is intentionally NOT an entry here any more: removing it re-enables
  // this test's per-route gate check on this exact route, which is the
  // point -- an exclusion that outlives the gap it documented is a stale
  // pass, not a record.
  // GET /ping's old reason here ("returns only mod connectivity +
  // modStatus, no secrets") was written the same day, by the same author,
  // under the same "the other two in this group are obviously fine too"
  // judgement that turned out wrong for /status above. Re-verified against
  // source: NOT actually safe as shipped -- bridge.ping() spread the FULL
  // this.modStatus into its response, including modStatus.path/filePath
  // (the same class of unmasked filesystem paths /status leaked) and
  // modStatus.players, a live online-username list with no players.view
  // check, unlike every other route that exposes player presence.
  // THIRD-PARTY data (the players, not the operator), which is why god
  // reversed the initial "path leak, ship tomorrow" call specifically for
  // this one and had it fixed same-day instead. Fixed in
  // services/panelBridge.js: ping() now merges an explicit allow-listed
  // pingModStatusView() (serverName only -- the one field Settings.tsx's
  // handlePingMod actually reads) instead of the raw modStatus object.
  // Deliberately an allow-list, not a delete-list, and deliberately scoped
  // to the RESPONSE, not this.modStatus itself (still passed whole to
  // getStatus() and other legitimate consumers) -- see
  // panelBridgePingModStatusLeak.test.js for the dedicated regression
  // coverage, including an explicit assert-ABSENT check for
  // players/path/filePath/stats/queue, not just assert-present for
  // serverName. GET /ping then left this list too (2026-10-20, access-
  // control audit): a ping still queues a command to the game, so it now
  // takes a bridge capability (see its route-level comment).
  ["panelBridge.js GET /commands", "static hardcoded action list (every field a literal in the handler, nothing derived from req/DB/per-install state) -- re-verified against source, confirmed safe"],

  // --- rcon.js: password explicitly excluded from what's returned ---
  ["rcon.js GET /status", "rconService.getConfig() excludes password by construction; host/port only go to rcon.execute or servers.manage, everyone else gets connected/reconnect fields only"],
  ["rcon.js GET /health", "connectivity/diagnostic booleans, no credential material"],
  ["rcon.js GET /commands", "static PZ_COMMANDS reference data"],
  ["rcon.js GET /commands/:category", "same static reference data, filtered"],

  // --- server.js ---
  ["server.js GET /status", "rconService.getConfig() excludes password by construction"],
  ["server.js GET /network-interfaces", "local LAN IPs only, documented purpose (a picker for Settings)"],

  // --- servers.js: masked via sanitizeServerResponse(List)() ---
  ["servers.js GET /", "sanitizeServerResponseList() masks RCON password and other sensitive fields"],
  ["servers.js GET /status", "per-server id/status detection result only, never the raw server record"],
  ["servers.js GET /lifecycle", "the lifecycle lock's operation and server name only, never the raw server record"],
  // GET /rcon-status left this list: it is gated (servers.manage or
  // rcon.execute), which the stale entry kept from being checked.
  ["servers.js GET /updates", "per-server mod names and game build numbers only, never the raw server record"],
  ["servers.js GET /active", "sanitizeServerResponse() masks sensitive fields"],
  ["servers.js GET /:id", "sanitizeServerResponse() masks sensitive fields"],

  // --- serverStatus.js ---
  ["serverStatus.js GET /active/status", "read-only status every role needs, no secrets"],

  // --- system.js: dashboard-wide diagnostics, no per-install secrets ---
  ["system.js GET /disk-space", "dashboard-wide warning, no secrets"],
  ["system.js GET /runtime", "dashboard-wide, no secrets"],
  ["system.js GET /storage-health", "dashboard-wide, no secrets"],

  // --- templates.js: templates structurally exclude RCON/network fields ---
  ["templates.js GET /", "non-secret catalog read -- templates structurally exclude RCONPassword/port/ServerName via resolveIniExclusions() (2026-08-24 conv-template-privesc)"],
  ["templates.js GET /:id", "same -- a single template's contents, same exclusion"],
  ["templates.js GET /:id/export", "same data as GET /:id, delivered as a download"],
  // POST /:id/preview left this list: it is gated (templates.manage) since
  // the 2026-10-20 access-control fix, and an entry here skipped its check.

  // --- index.js: the app-level routes (see the index.js scan below) ---
  ["index.js GET /api/health", "pre-session: version, build and boot id only, the liveness probe Docker and the updater poll"],
  ["index.js GET /api/panel-info", "login-only on purpose: the panel's own LAN address and port, shown to every role"],
  ["index.js GET /api/panel/update-status", "login-only on purpose (Layout and Dashboard poll it for every role); redactUpdateStatus() leaves out the panel.settings fields for other roles (#193)"],
]);

function extractRoutes(source) {
  const routes = [];
  let match;
  ROUTE_DECL_RE.lastIndex = 0;
  while ((match = ROUTE_DECL_RE.exec(source))) {
    routes.push({
      method: match[1].toUpperCase(),
      routePath: match[3],
      index: match.index,
    });
  }
  return routes;
}

// The gate window of routes[i]: from its declaration to the next route's,
// at most GATE_WINDOW_CHARS (see the per-file test below for why both).
function gateWindow(source, routes, i) {
  const nextRouteIndex = i + 1 < routes.length ? routes[i + 1].index : source.length;
  return source.slice(routes[i].index, Math.min(routes[i].index + GATE_WINDOW_CHARS, nextRouteIndex));
}

// --- server/index.js: the routes declared on the app itself ---
// /api/panel/restart, the panel update routes, /api/panel-info and
// /api/health live in index.js as app.<verb>(...), which the router scan
// above never saw: an ungated app.post("/api/...") there passed silently.
// Same regex shape as ROUTE_DECL_RE, for `app.` (not `req.app.`), and only
// /api/ paths (the SPA catch-all is a path-less app.use()).
const INDEX_FILE = path.join(__dirname, "..", "index.js");
const APP_ROUTE_DECL_RE =
  /(?<![\w.$])app\.(get|post|put|patch|delete)\(\s*(?:\r?\n\s*)?(["'`])(\/api\/(?:\\.|(?!\2)[^\r\n])*)\2/g;
// index.js also hangs a route-specific rate limiter on a router's path
// (`app.delete("/api/backup/:name", strictLimiter);`): a middleware for the
// route the router file declares and gates, not a route of its own.
const LIMITER_ONLY_RE = /^\s*,\s*\w+Limiter\s*\)\s*;/;
// A route whose path is a constant, not a literal, is invisible to the
// regex above. The known ones are FILES_TEXT_SAVE_ROUTE's two hooks (they
// mark and parse the Server Files text save, then pass it on to the files
// router, which is blanket-gated): a new one fails the test below until it
// is looked at and listed.
const APP_ROUTE_CONST_PATH_RE = /(?<![\w.$])app\.(get|post|put|patch|delete)\(\s*([A-Za-z_$][\w$]*)\s*,/g;
const KNOWN_CONST_PATH_APP_ROUTES = new Set(["FILES_TEXT_SAVE_ROUTE"]);

function extractAppRoutes(source) {
  const routes = [];
  let match;
  APP_ROUTE_DECL_RE.lastIndex = 0;
  while ((match = APP_ROUTE_DECL_RE.exec(source))) {
    const rest = source.slice(match.index + match[0].length, match.index + match[0].length + 200);
    if (LIMITER_ONLY_RE.test(rest)) continue;
    routes.push({ method: match[1].toUpperCase(), routePath: match[3], index: match.index });
  }
  return routes;
}

// Every route the scans see, keyed like UNGATED_BY_DESIGN, with whether its
// own window holds a gate (a blanket gate is not counted: the one entry
// inside a blanket-gated file is exempted from that blanket by name).
function allRoutesWithInlineGates() {
  const all = new Map();
  for (const file of listRouteFiles()) {
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf-8");
    const routes = extractRoutes(source);
    const knownNames = knownGateNamesFor(file, source);
    routes.forEach((route, i) => {
      all.set(`${file} ${route.method} ${route.routePath}`, windowHasKnownGate(gateWindow(source, routes, i), knownNames));
    });
  }
  const indexSource = fs.readFileSync(INDEX_FILE, "utf-8");
  const appRoutes = extractAppRoutes(indexSource);
  appRoutes.forEach((route, i) => {
    all.set(`index.js ${route.method} ${route.routePath}`, windowHasKnownGate(gateWindow(indexSource, appRoutes, i), new Set()));
  });
  return all;
}

describe("server/routes/ authorization coverage: every route is gated, blanket-covered, or a documented exclusion", () => {
  const files = listRouteFiles();

  it("sanity check: the scan actually finds real routes (guards against the regex silently matching nothing)", () => {
    let total = 0;
    for (const file of files) {
      const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf-8");
      total += extractRoutes(source).length;
    }
    // Known-real denominator from this session's own route-by-route read,
    // re-verified via this same regex (424 total; +2 for the routes that
    // matched with the multi-line pattern but weren't in the original
    // single-line-only scan draft). A collapse here means the regex
    // stopped matching, not that routes disappeared.
    expect(total).toBeGreaterThanOrEqual(420);
  });

  it("no UNGATED_BY_DESIGN entry has an empty reason -- an exclusion with no reason is not documentation", () => {
    for (const [key, reason] of UNGATED_BY_DESIGN) {
      expect(reason, `${key} has no reason`).toEqual(expect.any(String));
      expect(reason.length, `${key}'s reason is empty`).toBeGreaterThan(10);
    }
  });

  it("every BLANKET_GATED_FILES entry's marker string(s) are still present in that file", () => {
    for (const [file, spec] of Object.entries(BLANKET_GATED_FILES)) {
      const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf-8");
      expect(
        source.includes(spec.mustContain),
        `${file}: expected blanket-gate marker not found -- "${spec.mustContain}". ` +
          `If this file's router.use() gate was refactored, update BLANKET_GATED_FILES ` +
          `to match, or every route in this file now needs its own inline check.`,
      ).toBe(true);
      if (spec.alsoMustContain) {
        expect(
          source.includes(spec.alsoMustContain),
          `${file}: expected second blanket-gate marker not found -- "${spec.alsoMustContain}"`,
        ).toBe(true);
      }
    }
  });

  for (const file of files) {
    it(`${file}: every route is gated, blanket-covered, or a documented exclusion`, () => {
      const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf-8");
      const routes = extractRoutes(source);
      expect(routes.length, `${file}: found 0 routes -- regex may not match this file's style`).toBeGreaterThan(0);

      const blanket = BLANKET_GATED_FILES[file];
      const blanketIndex = blanket ? source.indexOf(blanket.mustContain) : -1;
      const knownNames = knownGateNamesFor(file, source);

      const uncovered = [];
      for (let i = 0; i < routes.length; i++) {
        const route = routes[i];
        const key = `${file} ${route.method} ${route.routePath}`;
        if (UNGATED_BY_DESIGN.has(key)) continue;

        if (blanket && blanketIndex !== -1 && route.index > blanketIndex) {
          continue; // covered by this file's router-wide gate
        }

        // Bounded by the NEXT route's own start, not just a fixed char
        // count -- a fixed-size window alone can bleed into the next
        // route's gate and produce a false "covered," missing a real
        // missing gate on THIS route. Caught by this test's own
        // break-verify (see the commit message): removing templates.js
        // POST /'s gate still passed, silently, until this bound was
        // added, because POST /'s short handler body put the very next
        // route's requirePermission() call inside a naive 400-char window.
        const nextRouteIndex = i + 1 < routes.length ? routes[i + 1].index : source.length;
        const windowEnd = Math.min(route.index + GATE_WINDOW_CHARS, nextRouteIndex);
        const window = source.slice(route.index, windowEnd);
        if (windowHasKnownGate(window, knownNames)) continue;

        uncovered.push(key);
      }

      expect(
        uncovered,
        uncovered.length
          ? `${uncovered.length} route(s) in ${file} have no gate, no blanket coverage, and no ` +
              `UNGATED_BY_DESIGN entry. Either add a requirePermission()/requireAnyPermission() ` +
              `call, or add an entry to UNGATED_BY_DESIGN with a real reason -- never a silent skip.`
          : "",
      ).toEqual([]);
    });
  }

  it("index.js: every app-level /api route is gated or a documented exclusion", () => {
    const source = fs.readFileSync(INDEX_FILE, "utf-8");
    const routes = extractAppRoutes(source);
    // panel/restart, update-check, -status, -preflight, -apply-log,
    // -download, panel-info, health: a drop means the regex stopped matching.
    expect(routes.length).toBeGreaterThanOrEqual(8);

    const uncovered = [];
    routes.forEach((route, i) => {
      const key = `index.js ${route.method} ${route.routePath}`;
      if (UNGATED_BY_DESIGN.has(key)) return;
      if (!windowHasKnownGate(gateWindow(source, routes, i), new Set())) uncovered.push(key);
    });
    expect(
      uncovered,
      uncovered.length
        ? `${uncovered.length} app-level route(s) in index.js have no gate and no UNGATED_BY_DESIGN entry.`
        : "",
    ).toEqual([]);
  });

  it("index.js: no app-level route hides its path in a constant this scan can't read", () => {
    const source = fs.readFileSync(INDEX_FILE, "utf-8");
    const unknown = [];
    let match;
    APP_ROUTE_CONST_PATH_RE.lastIndex = 0;
    while ((match = APP_ROUTE_CONST_PATH_RE.exec(source))) {
      if (!KNOWN_CONST_PATH_APP_ROUTES.has(match[2])) unknown.push(`app.${match[1]}(${match[2]}, ...)`);
    }
    expect(unknown).toEqual([]);
  });

  // An exclusion that outlives the gap it documented is a stale pass: the
  // route's own gate is never checked while its entry is here.
  it("every UNGATED_BY_DESIGN entry names a route that exists and still has no gate of its own", () => {
    const routes = allRoutesWithInlineGates();
    const stale = [];
    for (const key of UNGATED_BY_DESIGN.keys()) {
      if (!routes.has(key)) stale.push(`${key}: no such route`);
      else if (routes.get(key)) stale.push(`${key}: gated now -- remove the entry`);
    }
    expect(stale).toEqual([]);
  });
});
