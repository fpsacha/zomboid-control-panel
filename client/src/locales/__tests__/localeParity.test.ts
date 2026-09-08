import { describe, expect, it } from 'vitest'
import { LANGUAGES, SOURCE_LANGUAGE } from '../../i18n/languages'

// Modeled on V2's locales/localeKeys.ts + locale-parity test (read-only
// reference, not shared code): English is the source of truth, and every
// other shipped locale must resolve every key English has. Without this, a
// locale that's missing a key doesn't fail loudly — it silently falls back
// to i18next's raw dotted key (e.g. "shell:footer.signOut") rendered
// straight onto the screen for a real user, which is exactly the class of
// "wrong state presented confidently" bug this floor has spent all day
// finding elsewhere.
//
// Locales and namespaces are BOTH discovered here, not named — adding a
// third language folder (or a namespace file within an existing one) is
// picked up automatically, so a half-finished translation fails loudly on
// its first commit instead of silently shipping English gaps. See
// client/src/i18n/languages.ts (the one place languages are registered)
// and client/src/locales/README.md (how to add one).
const localeModules = import.meta.glob('../*/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Record<string, unknown>>

const LOCALE_PATH_RE = /\.\.\/([^/]+)\/([^/]+)\.json$/

const byLanguageThenNamespace: Record<string, Record<string, Record<string, unknown>>> = {}
for (const [filePath, mod] of Object.entries(localeModules)) {
  const match = filePath.match(LOCALE_PATH_RE)
  if (!match) continue
  const [, code, namespace] = match
  byLanguageThenNamespace[code] ??= {}
  byLanguageThenNamespace[code][namespace] = mod
}

const namespaces = [
  ...new Set(Object.values(byLanguageThenNamespace).flatMap((r) => Object.keys(r))),
].sort()

const targetLanguages = LANGUAGES.map((l) => l.code).filter((code) => code !== SOURCE_LANGUAGE)

// bug-hunt-2026-09-08 (Arabic plural sweep, step 2): a top-level key
// starting with `__` is reserved tooling data, not a translatable string --
// e.g. `__pendingPluralForms` (scripts/i18n-populate-missing-plural-forms.mjs),
// the greppable marker on a language's mechanically-copied plural forms
// that still need real grammar. i18next never looks these up (nothing in
// the app calls t('__pendingPluralForms')), so they're invisible at
// runtime; excluded here so a namespace that legitimately needs the marker
// isn't flagged as having a stray "extra" key English doesn't have.
function collectKeyPaths(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix]
  return Object.entries(obj as Record<string, unknown>)
    .filter(([key]) => !(prefix === '' && key.startsWith('__')))
    .flatMap(([key, value]) => collectKeyPaths(value, prefix ? `${prefix}.${key}` : key))
}

function getAtPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, segment) => {
    if (acc === null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[segment]
  }, obj)
}

// The key-set/empty-string checks below say nothing about what's INSIDE a
// value that does exist — a translation can drop a {{placeholder}}, invent
// one English doesn't supply, or have a real <b> tag escaped to &lt;b&gt;
// by a translation step, and both checks above stay green. That gap was
// live in shipped French (2026-08-23): a mods.json _one key introduced
// {{plural}} that English's _one form never supplies, so nothing filled it
// and an operator saw the literal text "{{plural}}" on screen.
//
// A placeholder repeated MORE times in the translation than in English is
// deliberately NOT flagged — French and Spanish grammatical agreement
// legitimately reuses one supplied value across a noun and its adjective
// (e.g. fr mods.json's "{{count}} conflit{{plural}} ignoré{{plural}}",
// one {{plural}} value marking both words). Only a placeholder's PRESENCE
// is compared, never its count — see PLACEHOLDER_NAME_RE's sibling in
// client/src/lib/paramTranslation.ts, which resolves the same way.
const PLACEHOLDER_NAME_RE = /\{\{\s*(\w+)\s*\}\}/g

function placeholderNames(value: unknown): Set<string> {
  if (typeof value !== 'string') return new Set()
  return new Set([...value.matchAll(PLACEHOLDER_NAME_RE)].map((m) => m[1]))
}

// Catches react-i18next <Trans> component tags (<1>...</1>, <b>...</b>,
// <code>...</code>) being escaped into literal &lt;b&gt; text by a
// translation pass, or a translator dropping/duplicating one. Open and
// close tokens are kept distinct ("<1>" vs "</1>") so a swapped or
// unbalanced pair fails too, not just a missing tag name. Order does NOT
// need to match (a French sentence can reorder the tagged clause), so both
// sides are sorted before comparing — only the multiset matters.
const TAG_TOKEN_RE = /<\/?[\w]+>/g

function tagTokens(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return [...value.matchAll(TAG_TOKEN_RE)].map((m) => m[0]).sort()
}

// Catches a literal "&" (or any other special character) getting escaped to
// an HTML entity by a translation pass — invisible to every other check
// here: valid JSON, correct key set, no placeholder involved, no <tag>
// involved. Live in shipped German (2026-08-23): several fork-generated
// strings turned "apply time & date" into "Zeit &amp; Datum anwenden",
// which renders as the literal text "&amp;" on screen since nothing in this
// app HTML-decodes plain t() output. Matches named entities (&lt; &gt;
// &amp; &quot; &apos; ...) and numeric forms (&#39; decimal, &#x27; hex).
// Deliberately does NOT flag a bare "&" itself — only comparing entities
// against entities means this correctly PASSES scheduler.json's
// bridgeFormatHint, where English's own example syntax deliberately
// contains a literal "&lt;action&gt;" and every locale correctly mirrors
// it verbatim. Order-independent (sorted), same reasoning as tagTokens.
const HTML_ENTITY_RE = /&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g

function entityTokens(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return [...value.matchAll(HTML_ENTITY_RE)].map((m) => m[0]).sort()
}

// bug-hunt-2026-09-08 (Arabic plural sweep): the "exactly the same keys"
// check above compares a target language's key SHAPE against English's --
// correct for ordinary keys, actively wrong for a pluralised one. i18next's
// pluralisation suffixes a base key with a CLDR plural category
// (_zero/_one/_two/_few/_many/_other), and which categories a given
// language NEEDS is a property of THAT language's own grammar, not
// English's. English only ever needs {one, other} (its own CLDR set), so a
// flat "target keys must equal source keys" check does two wrong things at
// once: it never notices Arabic is missing _two/_few/_many/_zero (English
// never had them to compare against), and if a translator correctly ADDS
// one, this same check fails it as "extra... stale/typo?" -- rejecting the
// correct fix. Confirmed empirically, not assumed: a missing plural-
// category key does NOT fall back to that language's own _other at
// runtime (isolated with fallbackLng:false against the real i18next
// resources) -- it falls all the way through to English, rendering literal
// English text inside e.g. an Arabic RTL sentence. See the dedicated
// "has every plural form its own CLDR rule requires" test below, which
// replaces English's shape with `Intl.PluralRules(lang)` -- the browser's
// own real CLDR data, not a hand-maintained table (a hardcoded per-language
// category list would be a second source of truth that goes stale the
// moment CLDR itself revises a language's rule; `Intl` already ships it).
const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/

function pluralBaseOf(key: string): string | null {
  const match = key.match(PLURAL_SUFFIX_RE)
  return match ? key.slice(0, key.length - match[0].length) : null
}

function basesWithPluralSuffix(keys: string[]): Set<string> {
  const bases = new Set<string>()
  for (const key of keys) {
    const base = pluralBaseOf(key)
    if (base) bases.add(base)
  }
  return bases
}

// A narrow, individually-reviewed exception list — NOT a blanket "_one keys
// may omit {{count}}" rule, which would hide a future _one key that drops
// {{count}} by accident instead of by design. Each entry here was checked
// against its English source and its own language's _other sibling before
// being added (2026-08-23 French placeholder-parity sweep): the count is
// always 1 on the `_one` branch, and the language's own grammar already
// marks singular without restating the numeral, so the omission is the
// deliberately better translation, not a gap. `key` is `lang/namespace:path`.
//
//   fr/backups.json mainCard.allSelectedLabel_one
//     en: "All {{count}} selected · click to clear"
//     fr: "La sauvegarde sélectionnée · cliquer pour désélectionner"
//     (fr's own _other: "Les {{count}} sauvegardes sélectionnées · ..." —
//     English reuses one string for both forms; French correctly does not.)
//   fr/chunkCleaner.json deleteDialog.title_one
//     en: "Delete {{count}} selected chunk?"
//     fr: "Supprimer le chunk sélectionné ?"
//     (fr's own _other: "Supprimer les {{count}} chunks sélectionnés ?" —
//     same reasoning.)
//
// Add a new entry here only after checking it against the _other sibling
// the same way — an omission that ISN'T a genuine singular/plural split is
// exactly the class of bug this whole check exists to catch.
const ALLOWED_PLACEHOLDER_OMISSIONS = new Set<string>([
  'fr/backups.json:mainCard.allSelectedLabel_one',
  'fr/chunkCleaner.json:deleteDialog.title_one',
])

const ALLOWLIST_ENTRY_RE = /^([^/]+)\/([^:]+)\.json:(.+)$/

describe(`locale parity (${SOURCE_LANGUAGE} is the source of truth)`, () => {
  it('every registered language has a locale folder with at least one namespace file', () => {
    for (const code of [SOURCE_LANGUAGE, ...targetLanguages]) {
      expect(byLanguageThenNamespace[code], `no locale files found for registered language "${code}"`).toBeDefined()
    }
  })

  // The other half people forget (same shape as debug.json's
  // diagnosticsCheckRegistry.test.js KNOWN_TRANSLATED_IDS): an allowlist
  // entry that outlives its reason is a permanent blind spot with a
  // comment on it, not a documented exception. If fr/backups.json's
  // mainCard.allSelectedLabel_one is ever edited to include {{count}}
  // again, this entry must stop existing — otherwise it silently excuses
  // a genuine future omission on that exact key forever. This makes the
  // allowlist self-cleaning: the moment an exemption stops being needed,
  // the test names it and fails instead of staying quiet.
  it('ALLOWED_PLACEHOLDER_OMISSIONS has no stale entries (the key must still omit a placeholder its English source supplies)', () => {
    const stale = [...ALLOWED_PLACEHOLDER_OMISSIONS].filter((entry) => {
      const match = entry.match(ALLOWLIST_ENTRY_RE)
      if (!match) return true // malformed entry, can't verify it — treat as stale
      const [, lang, ns, key] = match
      const sourceObj = byLanguageThenNamespace[SOURCE_LANGUAGE]?.[ns] ?? {}
      const targetObj = byLanguageThenNamespace[lang]?.[ns] ?? {}
      const sourceNames = placeholderNames(getAtPath(sourceObj, key))
      const targetNames = placeholderNames(getAtPath(targetObj, key))
      const stillOmitsSomething = [...sourceNames].some((name) => !targetNames.has(name))
      return !stillOmitsSomething
    })
    expect(
      stale,
      'ALLOWED_PLACEHOLDER_OMISSIONS has entries that no longer omit anything their English source supplies — delete them, the exemption is no longer needed',
    ).toEqual([])
  })

  for (const lang of targetLanguages) {
    for (const ns of namespaces) {
      const sourceObj = byLanguageThenNamespace[SOURCE_LANGUAGE]?.[ns] ?? {}
      const targetObj = byLanguageThenNamespace[lang]?.[ns] ?? {}

      it(`${lang}/${ns}.json has exactly the same keys as ${SOURCE_LANGUAGE}/${ns}.json (pluralised keys excluded, see the dedicated CLDR test below)`, () => {
        const sourceKeys = collectKeyPaths(sourceObj)
        const targetKeys = collectKeyPaths(targetObj)
        // Pluralised base keys are governed by each language's OWN CLDR
        // category set (the dedicated test right below), not by matching
        // English's key shape -- excluded here from both directions so a
        // language correctly needing MORE categories than English (Arabic,
        // Ukrainian, French, Spanish all do) isn't flagged "extra... stale/
        // typo?", and one needing categories English can't express isn't
        // silently un-checked by never appearing as "missing" either. A
        // base counts as plural-controlled if EITHER side has any suffixed
        // form of it, so a target's legitimately-added category (once
        // populated) doesn't fall through and get flagged as a stray extra
        // key just because English has no equivalent suffix to match it.
        const pluralBases = new Set([
          ...basesWithPluralSuffix(sourceKeys),
          ...basesWithPluralSuffix(targetKeys),
        ])
        const isPluralKey = (key: string) => {
          const base = pluralBaseOf(key)
          return base !== null && pluralBases.has(base)
        }
        const sourceKeySet = new Set(sourceKeys)
        const targetKeySet = new Set(targetKeys)
        const sourcePlainKeys = sourceKeys.filter((k) => !isPluralKey(k)).sort()
        const targetPlainKeys = targetKeys.filter((k) => !isPluralKey(k)).sort()

        const missing = sourcePlainKeys.filter((k) => !targetKeySet.has(k))
        const extra = targetPlainKeys.filter((k) => !sourceKeySet.has(k))

        expect(missing, `${lang}/${ns}.json is missing keys present in ${SOURCE_LANGUAGE}`).toEqual([])
        expect(extra, `${lang}/${ns}.json has keys not present in ${SOURCE_LANGUAGE} (stale/typo?)`).toEqual([])
      })

      // bug-hunt-2026-09-08 (Arabic plural sweep): the required suffix set
      // for THIS language is `Intl.PluralRules(lang).resolvedOptions()
      // .pluralCategories` -- real CLDR data, derived, not a hardcoded
      // per-language table (see the header comment above pluralBaseOf for
      // why deriving beats hand-maintaining one). "other" is always a
      // member of every language's set, so this is never vacuous. A
      // language whose own CLDR set happens to equal English's {one, other}
      // (German, Haitian Creole -- checked against real Intl data, not
      // assumed) requires nothing beyond what the same-keys test above
      // already enforces; this test is a genuine no-op for them, not a
      // special case.
      it(`${lang}/${ns}.json has every plural form ${lang}'s own CLDR rule requires, on every key ${SOURCE_LANGUAGE} pluralises`, () => {
        const sourceKeys = collectKeyPaths(sourceObj)
        const targetKeySet = new Set(collectKeyPaths(targetObj))
        // English decides WHICH keys are plural-controlled at all (a key
        // with zero suffixed forms in English was never meant to pluralise
        // and isn't this test's concern) -- only the SET OF CATEGORIES for
        // an already-plural key is lang-specific, not whether it pluralises
        // in the first place.
        const pluralBasesFromSource = basesWithPluralSuffix(sourceKeys)
        const requiredCategories = new Intl.PluralRules(lang).resolvedOptions().pluralCategories
        const missing = [...pluralBasesFromSource].flatMap((base) =>
          requiredCategories
            .filter((category) => !targetKeySet.has(`${base}_${category}`))
            .map((category) => `${base}_${category}`),
        ).sort()

        expect(
          missing,
          `${lang}/${ns}.json is missing plural forms its own language's grammar requires ` +
            `(Intl.PluralRules("${lang}").resolvedOptions().pluralCategories = [${requiredCategories.join(', ')}]) -- ` +
            `a missing category does NOT fall back to this language's own _other at runtime, it falls through to ` +
            `${SOURCE_LANGUAGE} and renders that language's text instead`,
        ).toEqual([])
      })

      it(`${lang}/${ns}.json has no empty string values`, () => {
        const emptyKeys = collectKeyPaths(targetObj).filter((path) => getAtPath(targetObj, path) === '')
        expect(emptyKeys, `${lang}/${ns}.json has keys with an empty string value`).toEqual([])
      })

      // Only keys present on both sides are checked here — a missing/extra
      // key is already the first test's failure to report, and comparing a
      // placeholder/tag set against `undefined` would just be noise on top
      // of a failure that test already names.
      const sharedKeys = collectKeyPaths(sourceObj).filter((key) => collectKeyPaths(targetObj).includes(key))

      const omittedPlaceholders = sharedKeys.flatMap((key) => {
        if (ALLOWED_PLACEHOLDER_OMISSIONS.has(`${lang}/${ns}.json:${key}`)) return []
        const sourceNames = placeholderNames(getAtPath(sourceObj, key))
        const targetNames = placeholderNames(getAtPath(targetObj, key))
        return [...sourceNames].filter((name) => !targetNames.has(name)).map((name) => `${key}: {{${name}}}`)
      })
      const introducedPlaceholders = sharedKeys.flatMap((key) => {
        const sourceNames = placeholderNames(getAtPath(sourceObj, key))
        const targetNames = placeholderNames(getAtPath(targetObj, key))
        return [...targetNames].filter((name) => !sourceNames.has(name)).map((name) => `${key}: {{${name}}}`)
      })
      const tagMismatches = sharedKeys.flatMap((key) => {
        const sourceTags = tagTokens(getAtPath(sourceObj, key))
        const targetTags = tagTokens(getAtPath(targetObj, key))
        if (JSON.stringify(sourceTags) === JSON.stringify(targetTags)) return []
        return [`${key}: ${SOURCE_LANGUAGE}=${JSON.stringify(sourceTags)} vs ${lang}=${JSON.stringify(targetTags)}`]
      })
      const entityMismatches = sharedKeys.flatMap((key) => {
        const sourceEntities = entityTokens(getAtPath(sourceObj, key))
        const targetEntities = entityTokens(getAtPath(targetObj, key))
        if (JSON.stringify(sourceEntities) === JSON.stringify(targetEntities)) return []
        return [
          `${key}: ${SOURCE_LANGUAGE}=${JSON.stringify(sourceEntities)} vs ${lang}=${JSON.stringify(targetEntities)}`,
        ]
      })

      it(`${lang}/${ns}.json supplies every {{placeholder}} that ${SOURCE_LANGUAGE}/${ns}.json uses for the same key`, () => {
        expect(
          omittedPlaceholders,
          `${lang}/${ns}.json drops a placeholder ${SOURCE_LANGUAGE} supplies for that key — nothing will fill it at render time`,
        ).toEqual([])
      })

      it(`${lang}/${ns}.json does not introduce a {{placeholder}} that ${SOURCE_LANGUAGE}/${ns}.json does not supply for the same key`, () => {
        expect(
          introducedPlaceholders,
          `${lang}/${ns}.json uses a placeholder ${SOURCE_LANGUAGE} never supplies for that key — it will render as the literal "{{name}}" text`,
        ).toEqual([])
      })

      it(`${lang}/${ns}.json has the same multiset of HTML/Trans tags as ${SOURCE_LANGUAGE}/${ns}.json for the same key`, () => {
        expect(
          tagMismatches,
          `${lang}/${ns}.json has a tag mismatch vs ${SOURCE_LANGUAGE}/${ns}.json (missing/extra/escaped <tag>)`,
        ).toEqual([])
      })

      it(`${lang}/${ns}.json has the same multiset of HTML entities as ${SOURCE_LANGUAGE}/${ns}.json for the same key`, () => {
        expect(
          entityMismatches,
          `${lang}/${ns}.json has an HTML-entity mismatch vs ${SOURCE_LANGUAGE}/${ns}.json (a literal character got escaped, e.g. "&" became "&amp;", and will render as literal entity text on screen)`,
        ).toEqual([])
      })
    }
  }
})
