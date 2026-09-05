// Follows every /panel-bridge/* REST route to the bridge action(s) it sends,
// then verifies each against the deployed Lua mod's handler set. Reports
// mismatches, plus (mandatory, see below) every call site it structurally
// cannot check at all.
//
// HONEST CEILING (audit-bridge-routes-blind-to-the-passthrough, 2026-08-31
// bug hunt): the generic passthrough route (POST /command,
// server/routes/panelBridge.js) dispatches via `bridge.sendCommand(action,
// args)` where `action` is a runtime request-body variable, not a string
// literal -- structurally invisible to a literal-string regex, by
// construction, forever. This script used to just silently drop that one
// call site from BOTH its numerator and its denominator: `MISMATCHES: 0`
// printed as if the check were complete, while the route that can reach
// ANY of the ~102 Lua handlers (not just the ~34 named-route ones) had zero
// coverage. That is the exact failure class this whole hunt kept finding --
// "checked actions: 4" sat directly above "MISMATCHES: none" in this
// script's own sibling (audit-bridge-actions.mjs) and nobody compared 4
// against 21. The fix here is the same rule stated twice: (1) report what
// cannot be verified, loudly, never just omit it; (2) then extend real
// coverage where the code makes that possible -- BRIDGE_ACTION_CAPABILITY
// (panelBridge.js) is a closed, named allowlist of exactly the actions this
// codebase bothered to give elevated/replacement gating, and unlike the
// passthrough's fully-dynamic `action` variable, its keys ARE literal and
// checkable. Order matters: (1) alone leaves this honest; (2) alone would
// leave it silently narrow again the same way it just was.
//
// This is still not "every action reachable through the app" -- any of the
// ~85 Lua handlers NOT named in BRIDGE_ACTION_CAPABILITY is technically
// reachable through the passthrough by any role holding plain
// bridge.command, and nothing here (or anywhere else, as of this fix)
// checks THOSE against the Lua handler set. Said explicitly in the output
// below rather than implied by a clean-looking summary.
//
// Also removed: an `executeAction(` search pattern that matched zero real
// call sites in this codebase -- a pattern that can only ever match nothing
// is the same defect as a checker whose corpus went stale, just caught
// before it ever had a false green to give. If a future refactor
// reintroduces a differently-named dispatch function, this script needs a
// new pattern for it, the same as it would need updating for any other
// structural change -- kept simple rather than guarding against a dispatch
// shape that has never existed here.
import fs from "fs";
import path from "path";

const root = path.resolve(process.argv[2] || ".");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const lua = read("pz-mod/PanelBridge/media/lua/server/PanelBridge.lua");
const luaHandlers = new Set(
  [...lua.matchAll(/^\s*handlers\.([a-zA-Z]+)/gm)].map((m) => m[1]),
);

const routes = read("server/routes/panelBridge.js");

// Split the route file per router.<verb>("<path>" so each action reference can
// be attributed to the endpoint that sends it.
const segments = [];
const routeRe = /router\.(get|post|put|delete)\(\s*"([^"]+)"/g;
let match;
const marks = [];
while ((match = routeRe.exec(routes)) !== null) {
  marks.push({ index: match.index, path: match[2] });
}
for (let i = 0; i < marks.length; i++) {
  segments.push({
    path: marks[i].path,
    body: routes.slice(marks[i].index, marks[i + 1]?.index ?? routes.length),
  });
}

const problems = [];
const verified = [];
// Every call site whose first argument isn't a plain quoted literal --
// reported by name, never merged into either count above.
const unverifiable = [];

for (const segment of segments) {
  // Captures the raw first-argument EXPRESSION (not just literals), so a
  // variable/property/template-literal call site is caught here instead of
  // vanishing from the count entirely.
  const literalActions = new Set();
  for (const m of segment.body.matchAll(/sendCommand\(\s*([^,)]+)/g)) {
    const raw = m[1].trim();
    const literal = raw.match(/^["']([a-zA-Z]+)["']$/);
    if (literal) {
      literalActions.add(literal[1]);
    } else {
      unverifiable.push(`${segment.path} -> sendCommand(${raw}, ...)`);
    }
  }
  for (const action of literalActions) {
    if (luaHandlers.has(action)) verified.push(`${segment.path} -> ${action}`);
    else problems.push(`${segment.path} -> ${action}  (NO LUA HANDLER)`);
  }
}

// Extends real coverage to the passthrough: BRIDGE_ACTION_CAPABILITY names
// every action this codebase gives its own elevated/replacement permission
// check, and its keys are literal object properties -- checkable the same
// way a named route's action is, unlike the passthrough's dynamic `action`
// variable itself. Anchored on the export (not a hardcoded line range) so a
// reformat doesn't quietly break this the way audit-bridge-actions.mjs's
// old indent-depth anchor did.
const capabilityAnchor = "export const BRIDGE_ACTION_CAPABILITY = {";
const capabilityIdx = routes.indexOf(capabilityAnchor);
const capabilityActions = [];
if (capabilityIdx !== -1) {
  const block = routes.slice(capabilityIdx + capabilityAnchor.length);
  const closeIdx = block.indexOf("\n};");
  const body = closeIdx === -1 ? block : block.slice(0, closeIdx);
  for (const m of body.matchAll(/^\s*([a-zA-Z]+):\s*"/gm)) {
    capabilityActions.push(m[1]);
  }
}

// Same "fail loudly rather than silently narrow" rule audit-bridge-actions.mjs
// was just fixed to follow: an anchor that's found but yields an implausibly
// small key count means the extraction itself has gone stale, not that the
// map genuinely shrank to almost nothing.
const MIN_CAPABILITY_KEYS = 10;
if (capabilityIdx === -1) {
  console.error(
    "ERROR: could not find BRIDGE_ACTION_CAPABILITY in server/routes/panelBridge.js at all -- " +
    "it was renamed, moved, or removed. Fix the anchor before trusting this script's output.",
  );
  process.exit(1);
}
if (capabilityActions.length < MIN_CAPABILITY_KEYS) {
  console.error(
    `ERROR: found BRIDGE_ACTION_CAPABILITY but extracted only ${capabilityActions.length} key(s) ` +
    `(expected at least ${MIN_CAPABILITY_KEYS}). The extraction regex is almost certainly stale -- ` +
    `fix it before trusting this script's output.`,
  );
  process.exit(1);
}

// Kept in its OWN array, not pushed into `verified` -- a checker script
// audit (2026-09-05, ci-pipefail-and-dead-tests hunt) found that mixing
// capability-derived hits into the same bucket as route-segment-derived
// hits let the route extraction above (the `segments`/`marks` loop) collapse
// to zero real matches -- e.g. a refactor from `router.get("path", ...)` to
// `router.route("path").get(...)`, mutation-verified locally -- while this
// script kept reporting a plausible-looking non-zero "route->action pairs
// checked" number and exiting 0, because that number was silently ALL
// BRIDGE_ACTION_CAPABILITY hits and zero real route hits. Same failure
// class as the two MIN_* guards below; this one had none.
const capabilityVerified = [];
const capabilityMissingHandler = [];
for (const action of capabilityActions) {
  if (luaHandlers.has(action)) capabilityVerified.push(`BRIDGE_ACTION_CAPABILITY -> ${action}`);
  else capabilityMissingHandler.push(action);
}

// Same "fail loudly rather than silently narrow" rule as MIN_CAPABILITY_KEYS
// below, for the OTHER denominator this script has (the route-segment
// extraction can go stale independently of the capability-map extraction --
// they read different anchors in the same file). Baseline on a real
// checkout: 34 (this was previously invisible -- the pre-fix print conflated
// it with BRIDGE_ACTION_CAPABILITY's 17 into a combined "51", see above).
// Same ~59% floor as MIN_CAPABILITY_KEYS/MIN_TEMPLATE_KEYS elsewhere in this
// file's family. Mutation-verified (2026-09-05): renaming every
// `router.<verb>("path"` to `router.route("path").<verb>(` collapses this
// to 0 with no other symptom -- MISMATCHES still printed 0 and the script
// still exited 0 before this guard existed.
const MIN_ROUTE_ACTION_PAIRS = 20;
const routeActionPairs = verified.length + problems.length;
if (routeActionPairs < MIN_ROUTE_ACTION_PAIRS) {
  console.error(
    `ERROR: found only ${routeActionPairs} route->action pair(s) via the router.<verb>("path" anchor ` +
    `(expected at least ${MIN_ROUTE_ACTION_PAIRS}). The route-splitting regex is almost certainly stale -- ` +
    `server/routes/panelBridge.js's route declarations changed shape. Fix it before trusting this script's output.`,
  );
  process.exit(1);
}

console.log(`lua handlers implemented:              ${luaHandlers.size}`);
console.log(`route->action pairs checked (literal):  ${routeActionPairs}`);
console.log(`BRIDGE_ACTION_CAPABILITY keys checked:   ${capabilityActions.length} (${capabilityVerified.length} verified against a lua handler)`);
console.log(`UNVERIFIABLE call sites (non-literal action, cannot be checked): ${unverifiable.length}`);
for (const u of unverifiable) console.log(`  ${u}`);
console.log(`MISMATCHES:                              ${problems.length + capabilityMissingHandler.length}`);
for (const p of problems) console.log(`  ${p}`);
for (const a of capabilityMissingHandler) console.log(`  BRIDGE_ACTION_CAPABILITY -> ${a}  (NO LUA HANDLER)`);
if (unverifiable.length) {
  console.log(
    `\nNOTE: ${unverifiable.length} call site(s) above dispatch a non-literal action and are NOT covered ` +
    `by the counts above. This script also cannot enumerate every action reachable through the generic ` +
    `passthrough (POST /command) beyond BRIDGE_ACTION_CAPABILITY's own named keys -- any other Lua handler ` +
    `is technically reachable by a role holding plain bridge.command and is unverified by this tool.`,
  );
}

// wire-up-the-unrun-checkers (2026-08-31 bug hunt): this script had no
// caller anywhere in the repo until this pass -- npm script + CI job added
// alongside this exit code. Confirmed zero mismatches on HEAD before adding
// this. Only real MISMATCHES fail the build -- the UNVERIFIABLE count above
// is a permanent, honest ceiling (the generic passthrough's dynamic action
// argument), not a regression signal, and must never gate the build on its
// own.
if (problems.length + capabilityMissingHandler.length > 0) {
  process.exit(1);
}
