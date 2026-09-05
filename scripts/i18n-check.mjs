// Verifies a translated page against its locale files, and/or audits every
// namespace for French string collisions.
//
// Two failure modes this catches that the test suite does not:
//   1. A t('some.key') call in a page with no matching key in en/<ns>.json or
//      fr/<ns>.json — renders as the raw key string at runtime, silently.
//   2. Two DIFFERENT English source strings translated to the SAME French
//      string within one namespace — the "two nav items, one French phrase"
//      bug that got past a passing parity test. Flagged only when the
//      underlying English values differ; a French duplicate whose English
//      source is also identical (e.g. two "Cancel" buttons) is legitimate
//      reuse, not a bug, and is not reported.
//
// Usage:
//   node scripts/i18n-check.mjs <PageFile.tsx> <namespace>
//     Checks one page's t() usages against its namespace's en/fr JSON, and
//     reports suspicious French duplicate values within that namespace.
//
//   node scripts/i18n-check.mjs --all
//     Skips the page/usage check and audits every namespace under
//     client/src/locales/{en,fr}/*.json for suspicious French duplicates.
//     Use this to gauge the false-positive rate of the duplicate check
//     across the whole app, not just one page.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const enDir = path.join(root, "client/src/locales/en");
const frDir = path.join(root, "client/src/locales/fr");

// Baseline for --all's suspicious-duplicate findings: 43 of the 44 raw
// findings as of 2026-08-31 were individually reviewed and are legitimate
// (see scripts/i18n-duplicates.baseline.json's header for the taxonomy and
// the triage rule). Keyed by namespace+frValue, same class+method-style
// stability as scripts/engine-signatures.baseline.json -- a rename or
// reformat doesn't need a baseline update. Missing baseline file is not a
// hard error; --all just reports everything as NEW in that case.
const BASELINE_PATH = path.join(__dirname, "i18n-duplicates.baseline.json");
let baselineEntries = [];
if (fs.existsSync(BASELINE_PATH)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    baselineEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (err) {
    console.error(`Malformed baseline at ${path.relative(root, BASELINE_PATH)}: ${err.message}`);
    process.exit(1);
  }
}
const baselineKey = (ns, value) => `${ns}::${value}`;
const baselineByKey = new Map(baselineEntries.map((e) => [baselineKey(e.ns, e.value), e]));

function flatten(o, p = "") {
  let out = [];
  for (const k in o) {
    const full = p ? `${p}.${k}` : k;
    if (o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) {
      out.push(...flatten(o[k], full));
    } else {
      out.push([full, o[k]]);
    }
  }
  return out;
}

function loadNamespace(ns) {
  const enPath = path.join(enDir, `${ns}.json`);
  const frPath = path.join(frDir, `${ns}.json`);
  if (!fs.existsSync(enPath) || !fs.existsSync(frPath)) return null;
  const en = JSON.parse(fs.readFileSync(enPath, "utf8"));
  const fr = JSON.parse(fs.readFileSync(frPath, "utf8"));
  return { en, fr, enFlat: flatten(en), frFlat: flatten(fr) };
}

// Normalizes an English source string for the "is this really the same
// source concept" comparison below: case and whitespace differences alone
// (e.g. a Title Case button next to a sentence-case label for the same
// action) are not a translator's invention of two concepts, so they're
// folded together rather than reported.
function normalizeEn(v) {
  return (v || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:!?]+$/, "");
}

// Suspicious French duplicates: same FR string, meaningfully different EN
// source string (not just case/whitespace/trailing punctuation), both plain
// strings (arrays like presets.default are exempt — a French preset list can
// coincidentally share an entry with another key without it meaning
// anything). This is a heuristic, not a proof — read the flagged pairs
// yourself; see the false-positive-rate note in the module comment.
function findSuspiciousDuplicates(ns, { en, frFlat }) {
  const enMap = new Map(flatten(en));
  const byValue = new Map();
  for (const [key, val] of frFlat) {
    if (typeof val !== "string" || val.trim() === "") continue;
    if (!byValue.has(val)) byValue.set(val, []);
    byValue.get(val).push(key);
  }
  const suspicious = [];
  for (const [value, keys] of byValue) {
    if (keys.length < 2) continue;
    const enValues = keys.map((k) => enMap.get(k));
    const distinctRaw = new Set(enValues);
    if (distinctRaw.size <= 1) continue; // identical EN source too — legitimate reuse
    const distinctNormalized = new Set(enValues.map(normalizeEn));
    if (distinctNormalized.size <= 1) continue; // case/whitespace-only EN difference
    suspicious.push({ ns, value, keys, enValues: [...distinctRaw] });
  }
  return suspicious;
}

function checkPage(pageFile, ns) {
  const pagePath = path.join(root, "client/src/pages", pageFile);
  if (!fs.existsSync(pagePath)) {
    console.error(`Page not found: ${pagePath}`);
    process.exit(1);
  }
  const page = fs.readFileSync(pagePath, "utf8");
  const nsData = loadNamespace(ns);
  if (!nsData) {
    console.error(`Namespace not found: en/fr locales/${ns}.json`);
    process.exit(1);
  }
  const { enFlat, frFlat } = nsData;
  const enKeys = new Set(enFlat.map(([k]) => k));
  const frKeys = new Set(frFlat.map(([k]) => k));

  // Collect t('...') usages, and normalize plural bases (foo.bar_one /
  // foo.bar_other resolve foo.bar at runtime) so they don't false-positive.
  const used = new Set();
  const re = /\bt\(\s*['"`]([a-zA-Z0-9_.]+)['"`]/g;
  let m;
  while ((m = re.exec(page))) used.add(m[1]);

  const hasKeyOrPlural = (keySet, base) =>
    keySet.has(base) || keySet.has(`${base}_one`) || keySet.has(`${base}_other`);

  const missingEn = [...used].filter((k) => !hasKeyOrPlural(enKeys, k));
  const missingFr = [...used].filter((k) => !hasKeyOrPlural(frKeys, k));

  console.log(`${pageFile}: ${used.size} t() keys referenced`);
  if (missingEn.length) console.log("MISSING IN EN:", missingEn);
  if (missingFr.length) console.log("MISSING IN FR:", missingFr);
  if (!missingEn.length && !missingFr.length) {
    console.log("OK: every t() usage has a matching en + fr key.");
  }
  console.log(
    "Note: Trans i18nKey=\"...\" usages are not t() calls and are not scanned — check those by eye.",
  );

  const suspicious = findSuspiciousDuplicates(ns, nsData);
  reportSuspicious(suspicious);
  return { missingEn, missingFr, suspicious };
}

function reportSuspicious(suspicious) {
  if (!suspicious.length) {
    console.log("No suspicious French duplicates (same FR value, different EN source).");
    return;
  }
  console.log(`${suspicious.length} SUSPICIOUS FRENCH DUPLICATE(S):`);
  for (const s of suspicious) {
    console.log(`  [${s.ns}] "${s.value}" used for ${s.keys.length} keys with different English source:`);
    console.log(`    keys: ${s.keys.join(", ")}`);
    console.log(`    english sources: ${s.enValues.map((v) => JSON.stringify(v)).join(" vs ")}`);
  }
}

function checkAllNamespaces() {
  const files = fs.readdirSync(enDir).filter((f) => f.endsWith(".json"));

  // Fail loudly rather than silently narrow (checker script audit,
  // 2026-09-05, ci-pipefail-and-dead-tests hunt): --all's whole contract is
  // "no NEW suspicious duplicate across every namespace" -- zero namespaces
  // scanned makes that vacuously true, which prints an identical-looking
  // PASS. Mutation-verified: pointing enDir at an empty directory reproduced
  // "Namespaces scanned: 0" and still printed "PASS: no NEW suspicious
  // French duplicates" before this guard existed. Baseline on the real
  // locales tree: 57 namespaces. Same ~55% floor as this repo's other
  // checker MIN_* guards (audit-bridge-actions.mjs, check-engine-signatures.mjs).
  const MIN_NAMESPACES = 30;
  if (files.length < MIN_NAMESPACES) {
    console.error(
      `ERROR: found only ${files.length} namespace(s) under ${path.relative(root, enDir)} ` +
      `(expected at least ${MIN_NAMESPACES}). enDir is almost certainly wrong, empty, or the locales ` +
      `tree moved -- fix it before trusting this script's output.`,
    );
    process.exit(1);
  }

  let totalIdenticalEn = 0;
  let totalCaseOnlyEn = 0;
  const allBaselined = [];
  const allNew = [];
  const matchedBaselineKeys = new Set();
  for (const f of files) {
    const ns = f.replace(/\.json$/, "");
    const nsData = loadNamespace(ns);
    if (!nsData) continue;
    const suspicious = findSuspiciousDuplicates(ns, nsData);
    // Re-derive the two benign buckets for context on the overall ratio.
    const enMap = new Map(flatten(nsData.en));
    const byValue = new Map();
    for (const [key, val] of nsData.frFlat) {
      if (typeof val !== "string" || val.trim() === "") continue;
      if (!byValue.has(val)) byValue.set(val, []);
      byValue.get(val).push(key);
    }
    for (const [, keys] of byValue) {
      if (keys.length < 2) continue;
      const enValues = keys.map((k) => enMap.get(k));
      if (new Set(enValues).size <= 1) {
        totalIdenticalEn++;
      } else if (new Set(enValues.map(normalizeEn)).size <= 1) {
        totalCaseOnlyEn++;
      }
    }
    for (const s of suspicious) {
      const key = baselineKey(ns, s.value);
      const entry = baselineByKey.get(key);
      if (entry) {
        matchedBaselineKeys.add(key);
        allBaselined.push({ s, entry });
      } else {
        allNew.push(s);
      }
    }
  }

  console.log("");
  if (allNew.length) {
    console.log(`${allNew.length} NEW SUSPICIOUS FRENCH DUPLICATE(S) (not in ${path.relative(root, BASELINE_PATH)}):`);
    reportSuspicious(allNew);
  }
  if (allBaselined.length) {
    console.log(`already-baselined: ${allBaselined.length} duplicate group(s)`);
  }
  const unmatched = baselineEntries.filter((e) => !matchedBaselineKeys.has(baselineKey(e.ns, e.value)));
  if (unmatched.length) {
    console.log(
      `NOTE: ${unmatched.length} baseline entr${unmatched.length === 1 ? "y" : "ies"} matched nothing this run ` +
      `(does not fail the gate -- the duplicate may have been fixed or reworded; safe to delete once confirmed):`,
    );
    for (const e of unmatched) console.log(`  [${e.ns}] ${JSON.stringify(e.value)}`);
  }

  console.log("");
  console.log(`Namespaces scanned: ${files.length}`);
  console.log(`Benign duplicate groups, identical EN source: ${totalIdenticalEn}`);
  console.log(`Benign duplicate groups, EN differs only by case/whitespace: ${totalCaseOnlyEn}`);
  console.log(`Suspicious duplicate groups, EN differs meaningfully: ${allBaselined.length + allNew.length} (${allBaselined.length} baselined, ${allNew.length} new)`);

  if (allNew.length) {
    console.error(`\nFAIL: ${allNew.length} suspicious French duplicate(s) not accounted for by the baseline.`);
    process.exit(1);
  }
  console.log(`\nPASS: no NEW suspicious French duplicates (${allBaselined.length} previously-reviewed finding(s) accounted for by the baseline).`);
}

const args = process.argv.slice(2);
if (args[0] === "--all") {
  checkAllNamespaces();
} else if (args.length === 2) {
  checkPage(args[0], args[1]);
} else {
  console.error("Usage: node scripts/i18n-check.mjs <PageFile.tsx> <namespace>");
  console.error("       node scripts/i18n-check.mjs --all");
  process.exit(1);
}
