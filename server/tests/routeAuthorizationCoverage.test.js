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

function windowHasKnownGate(window, knownNames) {
  if (INLINE_GATE_RE.test(window)) return true;
  for (const name of knownNames) {
    if (new RegExp(`\\b${name}\\b`).test(window)) return true;
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
  ["auth.js POST /refresh", "pre-session: the refresh token itself is the credential being checked"],
  ["auth.js POST /logout", "pre-session: clears a cookie, no capability model applies to ending your own session"],
  ["auth.js GET /me", "self-scoped via getAuthenticatedUser(req) -- never a caller-supplied id"],
  ["auth.js POST /change-password", "self-scoped via getAuthenticatedUser(req) -- never a caller-supplied id"],
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
  ["mapProxy.js GET /vehicles", "read-only, no secrets"],
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
  // source rather than re-inherited (release-1-2-17, 2026-09-07): NOT
  // confirmed safe. modStatus.path (the mod's own base path on the game
  // server) and modStatus.filePath (the panel's local path to the status
  // file -- for a remote/SFTP server, the local mirror directory) are the
  // same class of unmasked-filesystem-path leak /status had, and
  // modStatus.players is a live username list with no players.view check,
  // unlike every other route that exposes player presence. Reported to god
  // as a likely real hole rather than fixed here -- god's call on whether
  // it lands in v1.2.17 or after. This entry currently documents only that
  // the route remains ungated in the code today; it is not a claim that
  // ungated is correct, and must be removed the moment that changes (same
  // rule that applied to /status above).
  ["panelBridge.js GET /ping", "NOT CONFIRMED SAFE -- known gap, reported not fixed, see comment above"],
  ["panelBridge.js GET /commands", "static hardcoded action list (every field a literal in the handler, nothing derived from req/DB/per-install state) -- re-verified against source, confirmed safe"],

  // --- rcon.js: password explicitly excluded from what's returned ---
  ["rcon.js GET /status", "rconService.getConfig() excludes password by construction (host/port/connected/reconnect fields only)"],
  ["rcon.js GET /health", "connectivity/diagnostic booleans, no credential material"],
  ["rcon.js GET /commands", "static PZ_COMMANDS reference data"],
  ["rcon.js GET /commands/:category", "same static reference data, filtered"],

  // --- server.js ---
  ["server.js GET /status", "rconService.getConfig() excludes password by construction"],
  ["server.js GET /network-interfaces", "local LAN IPs only, documented purpose (a picker for Settings)"],

  // --- servers.js: masked via sanitizeServerResponse(List)() ---
  ["servers.js GET /", "sanitizeServerResponseList() masks RCON password and other sensitive fields"],
  ["servers.js GET /status", "per-server id/status detection result only, never the raw server record"],
  ["servers.js GET /rcon-status", "own comment in source: never returns credential material"],
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
  ["templates.js POST /:id/preview", "read-only diff against a live server's current config, same exclusion"],
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
});
