import i18n, { getCurrentLanguage, isRTL } from '@/i18n'

export type TranslationParams = Record<string, string | number>

// bug-hunt-2026-09-08 (Arabic render pass): confirmed against a real disk
// (952.8 GB total, 196.2 GB free) that a registered message like "{{free}}
// free of {{total}}." renders with the two values effectively scrambled in
// Arabic -- verified the server-side params were correct (free is really
// free, total is really total) before concluding this, so it's a pure
// rendering defect, not a swapped-arguments bug. This resolver interpolates
// into a PLAIN STRING (`translated.message` is text, not JSX), so the
// `<bdi>` element this floor uses everywhere else doesn't apply here --
// U+2066 FIRST STRONG ISOLATE / U+2069 POP DIRECTIONAL ISOLATE are the same
// isolation mechanism `<bdi>` uses under the hood, invisible, zero-width,
// and safe to embed directly in a string that ends up as React text
// content. Applied here, at the one shared interpolation point every
// registered-translation consumer already goes through, rather than at
// each call site -- this is a systemic shape (disk space, heap, host
// memory, and any future diagnostic message all interpolate a pre-
// formatted "value + unit" string next to another one), not a one-off.
const BIDI_ISOLATE_START = '⁦' // FIRST STRONG ISOLATE
const BIDI_ISOLATE_END = '⁩' // POP DIRECTIONAL ISOLATE

const PLACEHOLDER_NAME_RE = /\{\{\s*(\w+)\s*\}\}/g

function requiredParamNames(template: string): string[] {
  const names = new Set<string>()
  for (const match of template.matchAll(PLACEHOLDER_NAME_RE)) {
    names.add(match[1])
  }
  return [...names]
}

// Strict by design: any params shape other than a flat string|number map is
// treated as entirely absent, never partially trusted. A param that's
// present but wrong-typed must behave exactly like a missing one — see
// resolveRegisteredTranslation for why.
export function extractTranslationParams(candidate: unknown): TranslationParams | undefined {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined

  const out: TranslationParams = {}
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value
  }
  return out
}

// Only trust a registered translation when it needs no interpolation data
// we don't have. Several locale entries carry a {{placeholder}} for data
// the server doesn't always send as structured params — translating one
// without a value would put the literal text "{{name}}" in front of a
// user, which is worse than the untranslated passthrough it would replace.
// This is the backstop shared by every consumer of this module: a key with
// no placeholders translates unconditionally; a key with placeholders only
// translates once every required name is present in `params` with a
// usable (string|number) value, and returns null (the caller's fallback)
// otherwise. `resolveParamValue`, when given, lets a caller translate a
// param's VALUE through a second lookup before interpolating (see
// errorMessage.ts's capability-key resolution) — it must return the raw
// value unchanged for anything it doesn't specifically know how to resolve.
export function resolveRegisteredTranslation(
  ns: string,
  key: string,
  params: TranslationParams | undefined,
  resolveParamValue?: (name: string, value: string | number) => string | number,
): string | null {
  if (!i18n.exists(key, { ns })) return null

  const template = i18n.getResource(getCurrentLanguage(), ns, key)
  if (typeof template !== 'string') return null

  const required = requiredParamNames(template)
  if (required.length === 0) return i18n.t(key, { ns })

  const available = params ?? {}
  if (!required.every((name) => Object.prototype.hasOwnProperty.call(available, name))) return null

  // The reorder this isolates against is an RTL-paragraph effect (a run of
  // bidi-neutral characters between two LTR-anchored values gets laid out
  // right-to-left) -- it cannot happen in an LTR document at all. Scoping
  // to isRTL() keeps every LTR locale's output byte-identical to before
  // this fix (confirmed against the existing test suite, which asserts
  // exact interpolated strings) instead of embedding invisible-but-present
  // marks into text nobody needed protected.
  const shouldIsolate = isRTL(getCurrentLanguage())

  const resolved: TranslationParams = {}
  for (const name of required) {
    const value = available[name]
    const resolvedValue = resolveParamValue ? resolveParamValue(name, value) : value
    // `count` must reach i18next as a genuine, unwrapped number -- it
    // drives CLDR plural-category selection (Intl.PluralRules), not just
    // display, and isolate marks would turn it into a string i18next can
    // no longer use to pick _one/_few/_other. Every other param here is a
    // pre-formatted, standalone display value (a size, a path, a version)
    // that's safe -- and, per the sweep that found this, often necessary --
    // to isolate from whatever RTL template text surrounds it.
    resolved[name] =
      shouldIsolate && name !== 'count'
        ? `${BIDI_ISOLATE_START}${resolvedValue}${BIDI_ISOLATE_END}`
        : resolvedValue
  }
  return i18n.t(key, { ns, ...resolved })
}
