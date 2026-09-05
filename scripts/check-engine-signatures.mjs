#!/usr/bin/env node
// Sixth gate check, alongside LINT/RUNNER/CLIENT/CLIENTLINT/TSC: validates every engine method call
// PanelBridge.lua makes (both through the PanelBridge.invoke/hasMethod/safeCall/safeGet/tryGet
// helper family and bare `recv:method(...)` calls) against scripts/engine-signatures.manifest.json,
// a real jar-derived record of what methods actually exist on each Java class (see
// scripts/gen-engine-signatures.mjs, which builds that manifest, and scripts/lib/
// engine-signature-core.mjs, the resolution engine both scripts share).
//
// No JDK is needed here -- the manifest is committed, and this script only reads it. Regenerating
// the manifest (a local JDK + the game jar) is a separate, manual step; see gen-engine-signatures.mjs.
//
// PASS/FAIL contract (operator-confirmed 2026-08-30, see gen-engine-signatures.mjs's header for the
// full reasoning): a call site whose receiver resolves to a known class AND whose method is absent
// from that class's full inheritance chain in the manifest is a DEFINITE bug -- FAILS the gate. Any
// other outcome (receiver unresolved, method name dynamic, class not in the manifest, method
// present) PASSES -- presence is evidence the call is plausible, never proof it is callable through
// PZ's Kahlua Lua<->Java binding, so this script only ever fails on the ABSENT side of that
// asymmetry, never claims success beyond it.
//
// Coverage is reported every run, unconditionally: call sites found, receivers resolved, and why
// the rest were not -- a checker that quietly resolves 3 sites and passes looks identical to one
// that resolves 300 and passes, which is exactly the failure mode this tool exists to not repeat.
//
// BASELINE (operator-requested 2026-08-30, after this check would otherwise have shipped
// permanently red): a fresh checkout of PanelBridge.lua already has 15 ABSENT findings, and they
// were individually reviewed, not rubber-stamped -- see scripts/engine-signatures.baseline.json's
// own header for the full reasoning. A check that is red from the moment it lands, on findings its
// own author already called harmless, teaches everyone to stop reading it -- and the day it lands a
// GENUINE new regression, nobody notices, which defeats the entire point of building this. So:
// findings are matched against the baseline by CLASS+METHOD, not by line number (an edit that only
// shifts lines shouldn't need a baseline update) and not by call site (so a second, later call to an
// already-baselined absent pair doesn't need its own entry either) -- chosen over per-site keying
// because the failure mode of a wrong choice is asymmetric: per-site keying breaks (spuriously RED)
// on every unrelated edit near a baselined call, which is exactly the "everyone stops reading it"
// outcome this baseline exists to prevent; class+method keying's failure mode is instead a NEW call
// to an already-baselined absent method absorbing silently -- worse in principle, but the baseline's
// own match count is printed every run specifically so that absorption stays visible rather than
// silent (see "already-baselined" below). A method NOT in the baseline that is ABSENT still fails
// the gate exactly as before -- the baseline only covers the 10 specific (class, method) pairs
// reviewed and recorded in that file, nothing broader.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveAllCallSites, SEED_GLOBALS, STATIC_CLASS_SEEDS } from './lib/engine-signature-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : null;
}

// --lua/--manifest/--baseline exist for break-verification (point the checker at a synthetic
// fixture instead of the real files) -- normal use (local, CI) always takes the defaults.
const LUA_PATH = argValue('--lua') || path.join(ROOT, 'pz-mod/PanelBridge/media/lua/server/PanelBridge.lua');
const MANIFEST_PATH = argValue('--manifest') || path.join(__dirname, 'engine-signatures.manifest.json');
const BASELINE_PATH = argValue('--baseline') || path.join(__dirname, 'engine-signatures.baseline.json');

if (!fs.existsSync(MANIFEST_PATH)) {
  console.error(`Missing ${path.relative(ROOT, MANIFEST_PATH)} -- run scripts/gen-engine-signatures.mjs (needs a local JDK) and commit its output.`);
  process.exit(1);
}
if (!fs.existsSync(LUA_PATH)) {
  console.error(`Missing ${path.relative(ROOT, LUA_PATH)}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const rawSrc = fs.readFileSync(LUA_PATH, 'utf8');

// Missing baseline file is NOT a hard error (unlike a missing manifest) -- an empty baseline is a
// valid, if maximally strict, starting state; every ABSENT finding just fails until reviewed and
// added. Malformed JSON, on the other hand, is a real authoring mistake and should say so loudly
// rather than silently behaving as if the baseline were empty.
let baselineEntries = [];
if (fs.existsSync(BASELINE_PATH)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    baselineEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (err) {
    console.error(`Malformed baseline at ${path.relative(ROOT, BASELINE_PATH)}: ${err.message}`);
    process.exit(1);
  }
}
const baselineKey = (className, methodName) => `${className}#${methodName}`;
const baselineByKey = new Map(baselineEntries.map((e) => [baselineKey(e.class, e.method), e]));

// Resolve using exactly the seeds the manifest was generated with -- not whatever
// SEED_GLOBALS/STATIC_CLASS_SEEDS happen to contain in this checkout's copy of the shared module.
// A seed added to the module since this manifest was generated has no javap data behind it yet;
// treating it as live here would silently resolve call sites against classes the manifest never
// actually covers.
for (const key of Object.keys(SEED_GLOBALS)) delete SEED_GLOBALS[key];
Object.assign(SEED_GLOBALS, manifest.seedGlobals || {});
for (const key of Object.keys(STATIC_CLASS_SEEDS)) delete STATIC_CLASS_SEEDS[key];
Object.assign(STATIC_CLASS_SEEDS, manifest.staticClassSeeds || {});

function classProvider(className, methodName) {
  const info = manifest.classes[className];
  if (!info) return null; // class not in the manifest -- unknown, not absent (see header comment)
  const sigs = info.methods[methodName];
  if (!sigs || sigs.length === 0) return { exists: false };
  return { exists: true, returnClass: sigs[0].returnClass, elementClass: sigs[0].elementClass };
}

const { callSites } = resolveAllCallSites(rawSrc, classProvider);

const resolved = callSites.filter((s) => s.resolved);
const unresolved = callSites.filter((s) => !s.resolved);
const absent = resolved.filter((s) => s.methodInfo && s.methodInfo.exists === false);
const staleClassLookups = resolved.filter((s) => s.methodInfo === null); // receiver type known, but not in manifest

const skipReasonCounts = new Map();
for (const s of unresolved) {
  skipReasonCounts.set(s.skipReason, (skipReasonCounts.get(s.skipReason) || 0) + 1);
}

// Fail loudly rather than silently narrow (checker script audit, 2026-09-05,
// ci-pipefail-and-dead-tests hunt): this gate's whole contract is "no NEW
// absent engine call" -- an empty/near-empty callSites list makes that
// vacuously true, which reads identically to a real pass. Mutation-verified:
// pointing --lua at a file with no real engine call sites reproduces
// `call sites found: 0` / `receivers resolved: 0` and still printed
// "PASS: no NEW definitively absent engine method calls" before this guard
// existed. Baseline on the real PanelBridge.lua: 367 call sites found, 201
// resolved -- same ~55% floor as the MIN_* guards in this script's sibling
// checkers (audit-bridge-actions.mjs, audit-bridge-routes.mjs).
const MIN_CALL_SITES = 200;
if (callSites.length < MIN_CALL_SITES) {
  console.error(
    `ERROR: found only ${callSites.length} engine call site(s) in ${path.relative(ROOT, LUA_PATH)} ` +
    `(expected at least ${MIN_CALL_SITES}). resolveAllCallSites()'s extraction is almost certainly broken ` +
    `or was pointed at the wrong/an empty file -- fix it before trusting this script's output.`,
  );
  process.exit(1);
}

console.log('=== engine signature check (scripts/check-engine-signatures.mjs) ===');
console.log(`manifest:              ${path.relative(ROOT, MANIFEST_PATH)} (generated ${manifest.generatedAt}, ${manifest.jarBasename})`);
console.log(`source:                ${path.relative(ROOT, LUA_PATH)}`);

const currentSha = crypto.createHash('sha256').update(rawSrc).digest('hex');
if (manifest.sourceFileSha256 && manifest.sourceFileSha256 !== currentSha) {
  console.log('');
  console.log('WARNING: PanelBridge.lua has changed since the manifest was generated.');
  console.log('  This does NOT fail the gate (regenerating needs a local JDK + the game jar, not');
  console.log('  available in CI) -- it means any NEW call site this edit introduced is checked only');
  console.log('  if it happens to reuse a class already in the manifest. Run');
  console.log('  `node scripts/gen-engine-signatures.mjs` locally and commit the refreshed manifest.');
}

console.log('');
console.log(`call sites found:      ${callSites.length}`);
console.log(`receivers resolved:    ${resolved.length}`);
console.log(`  of which in manifest:      ${resolved.length - staleClassLookups.length}`);
console.log(`  of which stale (class not in manifest, not checked): ${staleClassLookups.length}`);
console.log(`skipped (unresolved):  ${unresolved.length}`);
for (const [reason, count] of [...skipReasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${reason}`);
}
console.log(`ABSENT methods found:  ${absent.length}`);

const baselined = [];
const newAbsent = [];
const matchedBaselineKeys = new Set();
for (const f of absent) {
  const entry = baselineByKey.get(baselineKey(f.receiverType, f.methodName));
  if (entry) {
    baselined.push({ finding: f, entry });
    matchedBaselineKeys.add(baselineKey(entry.class, entry.method));
  } else {
    newAbsent.push(f);
  }
}

if (baselined.length > 0) {
  const byCategory = new Map();
  for (const { finding, entry } of baselined) {
    const list = byCategory.get(entry.category) || [];
    list.push({ finding, entry });
    byCategory.set(entry.category, list);
  }
  console.log('');
  console.log(`already-baselined (see ${path.relative(ROOT, BASELINE_PATH)}): ${baselined.length} call site(s) across ${matchedBaselineKeys.size} entries`);
  for (const [category, items] of byCategory) {
    console.log(`  ${category} (${items.length} site(s)):`);
    for (const { finding, entry } of items) {
      console.log(`    PanelBridge.lua:${finding.line}  ${finding.receiverExpr} (${finding.receiverType}) has no ${finding.methodName}() -- ${entry.reason}`);
    }
  }
}

const unmatchedBaselineEntries = baselineEntries.filter((e) => !matchedBaselineKeys.has(baselineKey(e.class, e.method)));
if (unmatchedBaselineEntries.length > 0) {
  console.log('');
  console.log(`NOTE: ${unmatchedBaselineEntries.length} baseline entr${unmatchedBaselineEntries.length === 1 ? 'y' : 'ies'} matched nothing this run (does not fail the gate -- the call site may have been removed or fixed; safe to delete from the baseline once confirmed):`);
  for (const e of unmatchedBaselineEntries) {
    console.log(`  ${e.class}#${e.method}`);
  }
}

if (newAbsent.length > 0) {
  console.log('');
  console.log('NEW (not in the baseline) -- javap confirms no such method anywhere in the class chain:');
  for (const f of newAbsent) {
    console.log(`  PanelBridge.lua:${f.line}  ${f.receiverExpr} (${f.receiverType}) has no ${f.methodName}()`);
  }
  console.log('');
  console.log(`FAIL: ${newAbsent.length} newly-absent engine method call(s), not covered by the reviewed baseline. Either this is a real regression (fix PanelBridge.lua), or it's a call site worth the same review the rest of ${path.relative(ROOT, BASELINE_PATH)} got (add it there with a reason, in the right category) -- never add an entry just to make the gate pass. See scripts/engine-signatures.manifest.json for the source of truth, and scripts/gen-engine-signatures.mjs's header for what "definitely absent" does and does not prove.`);
  process.exit(1);
}

console.log('');
console.log(`PASS: no NEW definitively absent engine method calls (${baselined.length} previously-reviewed finding(s) accounted for by the baseline).`);
process.exit(0);
