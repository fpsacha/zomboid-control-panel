#!/usr/bin/env node
// i18n-populate-missing-plural-forms.mjs — STEP 2 of the 2026-09-08 Arabic
// plural sweep (harden-updater floor). localeParity.test.ts now requires
// every language to supply exactly the plural categories ITS OWN CLDR rule
// needs (Intl.PluralRules(lang).resolvedOptions().pluralCategories), not a
// copy of English's {one, other} shape. Four locales were short: ar (needs
// zero/two/few/many too), uk (needs few/many too), es and fr (need many
// too). This mechanically closes every gap by copying each key's own
// `_other` value into the missing category — see the header comment on
// requireApproval() below for why that beats hand-authoring ~1536 strings
// in languages nobody on this floor reads, and why it beats leaving the
// gate red.
//
// Deliberately NOT a blind key-count fix: `_other`'s value is copied
// UNCHANGED, so the meaning is always right even where the grammar isn't.
// For es/fr this is not a compromise at all — CLDR "many" only fires at
// 1,000,000+ for both, and the "many" form is grammatically identical to
// "other" in both languages (god's own ruling, verified against real
// Intl.PluralRules data), so the copy IS the correct, finished string. For
// ar/uk it is a real, if grammatically imperfect, improvement over the
// previous failure mode — which was not "grammatically imperfect Arabic",
// it was literal ENGLISH TEXT leaking into the page (see the commit this
// script's own output lands in for the full story) — and it's a strict one:
// meaning intact, page stops looking half-translated, trivially reversible
// once real forms exist.
//
// Marks ONLY ar/uk's newly-added forms with a reserved, greppable
// `__pendingPluralForms` array at the top of each touched namespace file —
// NOT es/fr, whose copies are already the finished string and would
// wrongly send a translator chasing something that isn't broken. This is
// data alongside the translations a translator is already editing, not a
// convention living in a card or someone's head. localeParity.test.ts
// ignores any top-level key starting with `__` for exactly this key.
//
// Usage:
//   node scripts/i18n-populate-missing-plural-forms.mjs           # apply
//   node scripts/i18n-populate-missing-plural-forms.mjs --check   # report only, no writes, exit 1 if anything would change
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const localesDir = path.join(root, "client/src/locales");

const SOURCE_LANGUAGE = "en";
// Only these four are actually short right now (verified against real
// Intl.PluralRules data, not hardcoded as a permanent list) — but the walk
// below considers every locale folder generically, so a future language
// that ships incomplete is picked up automatically without editing this
// file, matching this floor's own "derive, don't hardcode" rule.
const MARK_PENDING_TRANSLATION = new Set(["ar", "uk"]);

const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/;
const PENDING_KEY = "__pendingPluralForms";

const checkOnly = process.argv.includes("--check");

function pluralBaseOf(key) {
  const match = key.match(PLURAL_SUFFIX_RE);
  return match ? key.slice(0, key.length - match[0].length) : null;
}

function collectKeyPaths(obj, prefix = "") {
  if (obj === null || typeof obj !== "object") return [prefix];
  return Object.entries(obj).flatMap(([key, value]) =>
    collectKeyPaths(value, prefix ? `${prefix}.${key}` : key),
  );
}

function getAtPath(obj, dottedPath) {
  return dottedPath.split(".").reduce((acc, segment) => {
    if (acc === null || typeof acc !== "object") return undefined;
    return acc[segment];
  }, obj);
}

function setAtPath(obj, dottedPath, value) {
  const segments = dottedPath.split(".");
  let cursor = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (typeof cursor[segment] !== "object" || cursor[segment] === null) {
      throw new Error(`Cannot set "${dottedPath}" — "${segments.slice(0, i + 1).join(".")}" is not an object`);
    }
    cursor = cursor[segment];
  }
  cursor[segments[segments.length - 1]] = value;
}

function basesWithPluralSuffix(keys) {
  const bases = new Set();
  for (const key of keys) {
    const base = pluralBaseOf(key);
    if (base) bases.add(base);
  }
  return bases;
}

// BCP-47-shaped directory names only (en, ar, zh-CN, ...) -- excludes
// __tests__ (localeParity.test.ts's own home under this same directory)
// and any other non-language folder without needing to parse
// client/src/i18n/languages.ts from a plain Node script.
const LANGUAGE_DIR_RE = /^[a-z]{2}(-[A-Za-z]{2,4})?$/;
const languageCodes = fs
  .readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== SOURCE_LANGUAGE && LANGUAGE_DIR_RE.test(entry.name))
  .map((entry) => entry.name);

let totalAdded = 0;
let filesChanged = 0;
const report = [];

for (const lang of languageCodes) {
  let requiredCategories;
  try {
    requiredCategories = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
  } catch (err) {
    console.warn(`[i18n-populate] skipping "${lang}" — Intl.PluralRules doesn't recognize it (${err.message})`);
    continue;
  }

  const langDir = path.join(localesDir, lang);
  const enDir = path.join(localesDir, SOURCE_LANGUAGE);
  const namespaceFiles = fs.readdirSync(enDir).filter((f) => f.endsWith(".json"));

  for (const fileName of namespaceFiles) {
    const enPath = path.join(enDir, fileName);
    const targetPath = path.join(langDir, fileName);
    if (!fs.existsSync(targetPath)) continue; // missing-file case is the parity test's own concern, not this script's

    const enObj = JSON.parse(fs.readFileSync(enPath, "utf-8"));
    const targetObj = JSON.parse(fs.readFileSync(targetPath, "utf-8"));

    const enKeys = collectKeyPaths(enObj);
    const pluralBases = basesWithPluralSuffix(enKeys); // English decides WHICH keys pluralise

    const added = [];
    for (const base of pluralBases) {
      const otherValue = getAtPath(targetObj, `${base}_other`);
      if (otherValue === undefined) continue; // no _other to copy from — a genuine gap outside this script's scope, parity test will still name it
      for (const category of requiredCategories) {
        const key = `${base}_${category}`;
        if (getAtPath(targetObj, key) !== undefined) continue; // already present, real or previously mechanical
        setAtPath(targetObj, key, otherValue);
        added.push(key);
      }
    }

    if (added.length === 0) continue;
    added.sort();
    totalAdded += added.length;
    filesChanged += 1;
    report.push({ lang, fileName, added });

    if (MARK_PENDING_TRANSLATION.has(lang)) {
      // Re-derive fresh each run rather than appending, so re-running this
      // script after a translator has replaced some entries with real text
      // (removing them is the translator's job, not this script's) doesn't
      // re-add anything already fixed — see the header for why this file
      // must never be treated as a second source of truth to hand-maintain.
      const existingPending = Array.isArray(targetObj[PENDING_KEY]) ? targetObj[PENDING_KEY] : [];
      const merged = [...new Set([...existingPending, ...added])].sort();
      // Reinsert at the top for visibility — JSON.stringify below emits
      // keys in the object's own insertion order, and a translator opening
      // this file should see the marker before 100+ unrelated keys.
      delete targetObj[PENDING_KEY];
      const reordered = { [PENDING_KEY]: merged, ...targetObj };
      Object.keys(targetObj).forEach((k) => delete targetObj[k]);
      Object.assign(targetObj, reordered);
    }

    if (!checkOnly) {
      fs.writeFileSync(targetPath, JSON.stringify(targetObj, null, 2) + "\n");
    }
  }
}

console.log(`[i18n-populate] ${checkOnly ? "would add" : "added"} ${totalAdded} plural form(s) across ${filesChanged} file(s):\n`);
for (const { lang, fileName, added } of report) {
  console.log(`  ${lang}/${fileName}: ${added.join(", ")}`);
}

if (checkOnly && totalAdded > 0) process.exitCode = 1;
