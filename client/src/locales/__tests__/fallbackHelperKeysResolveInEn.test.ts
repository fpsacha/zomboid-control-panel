import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// i18n-debt, 2026-09-10 (new-sandbox-toggle-and-banner-strings-are-english-
// in-all-nine-locales). Several files independently grew a local
// "translate-if-registered-else-hardcoded-English" helper the same night --
// `function NAME(key: string, fallback: string): string { return
// resolveRegisteredTranslation(NS, key, ...) ?? fallback }` -- plus a
// handful of call sites that skip the helper and call
// resolveRegisteredTranslation(NS_LITERAL, KEY_LITERAL, ...) directly. Both
// shapes are a DELIBERATE, legitimate escape hatch from same-day locale-file
// updates -- IF the key is also mirrored into en (and, per
// serverConfigSchema.ts's own documented convention, into every other
// shipped locale too, as an explicit English placeholder) so the debt stays
// greppable.
//
// It stops being fine, silently, the moment a key is passed that was never
// mirrored anywhere: every locale then renders the exact same hardcoded
// fallback string forever, indistinguishable at runtime from a real (if
// not-yet-translated) key -- and localeParity.test.ts has nothing to catch
// it with, because that test only diffs keys found INSIDE the locale JSON
// files. A key that's in zero files was never in its universe to begin
// with. That is exactly what happened to the sandbox-tab toggle and banner
// strings this card exists to fix -- see memory.md for the full diagnosis.
//
// This test closes that blind spot GENERICALLY: it discovers every wrapper
// function of that exact shape, and every direct literal-keyed call, by
// reading client/src from disk (same discipline as server/tests/
// diagnosticsCheckRegistry.test.js and errorCodeRegistry.test.js -- a
// hardcoded second copy of "the keys/helpers that exist" is the next thing
// to drift), then fails the moment one of those keys does not resolve to a
// non-empty string in en.
//
// SCOPE, deliberately narrow and named so a future reader knows what this
// does NOT cover:
//  - Only STRING-LITERAL key arguments ('...'/"..." immediately at the call
//    site). A TEMPLATE-LITERAL key (`` `iniSettings.${cat}.${key}.label` ``)
//    or a computed/ternary/identifier key (`result.code`,
//    `GENERIC_SERVER_ERROR_KEY`, `value ? "on" : "off"`) names a whole
//    FAMILY of keys or defers to a value declared elsewhere, not one
//    nameable string at this call site -- auditing those needs to walk the
//    data source (a schema array, an error-code registry) that generates
//    them, a different and already-separately-covered job (see
//    serverConfigSchema.ts's own "mirrored into en/serverconfig.json"
//    convention for the schema-driven family, and errorCodeRegistry-style
//    tests for the `errors` namespace lookups).
//  - Only same-file wrapper call sites: every wrapper this scan has found
//    so far is an unexported, module-private function, so a call site in a
//    DIFFERENT file could only reach it by import -- if one ever does, this
//    scan's per-file scoping would miss it. Flagged here rather than
//    guarded against, since a private function suddenly being imported
//    elsewhere is a bigger structural change than this test's job.

const SRC_ROOT = path.resolve(process.cwd(), "src");
const LOCALE_ROOT = path.resolve(process.cwd(), "src/locales");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function readNamespaceJson(locale: string, ns: string): Record<string, unknown> | null {
  const filePath = path.join(LOCALE_ROOT, locale, `${ns}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getAtPath(obj: unknown, dottedKey: string): unknown {
  return dottedKey.split(".").reduce<unknown>((value, segment) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment];
  }, obj);
}

// i18n-debt follow-up, 2026-09-10 (god's HOLD on the first version of this
// guard): registering a key CHANGES WHICH BRANCH RUNS the moment it
// resolves for the active language -- resolveRegisteredTranslation starts
// returning non-null instead of null, so the caller's `?? fallback` stops
// firing. For a key whose registered text has no {{placeholder}}, that's
// harmless. For one that does, the call site must actually forward
// `params` with matching names, or the key can never resolve to anything
// but the caller's own JS fallback -- for ANY language, forever, including
// a real translation written into it later. That happened to
// unrecognizedSandboxOptionWarning: its call passed no params at all, so
// even the just-mirrored en text (identical to the JS fallback) could never
// actually be the thing that renders -- the registered path was
// permanently unreachable. resolveRegisteredTranslation's own backstop
// (paramTranslation.ts) means this does NOT show a literal "{{name}}" to
// users -- it silently falls through to the JS fallback instead, which is
// why it survived this guard's first version undetected: "does the key
// resolve in en" was true, and truth stopped there.
//
// findCallArgsText below recovers the FULL argument list text for a given
// call (wrapper or direct) by string/template-literal-aware paren matching,
// so a params object passed after the key/fallback arguments can be found
// reliably even when the fallback argument is itself a template literal
// containing its own `${...}` braces (naively matching the first `{` in the
// args text would find THAT brace, not a real trailing params object --
// confirmed as a real trap while writing this, not a hypothetical one).

// String/template-literal-aware: treats a whole quoted or backtick-quoted
// run as one opaque unit so a `{`/`(` inside a JS template's `${...}`
// interpolation, or inside any string value, is never mistaken for real
// source structure.
function skipStringLiteral(text: string, i: number): number {
  const quote = text[i];
  i++;
  while (i < text.length && text[i] !== quote) {
    if (text[i] === "\\") i++;
    i++;
  }
  return i;
}

function findMatchingClose(text: string, openIndex: number, openChar: string, closeChar: string): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStringLiteral(text, i);
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// The raw text between a call's own opening and closing parens, given the
// index of its opening "(". Used to look for a trailing params object
// without being fooled by braces inside an earlier string/template
// argument.
function findCallArgsText(source: string, openParenIndex: number): string {
  const closeIndex = findMatchingClose(source, openParenIndex, "(", ")");
  if (closeIndex === -1) return "";
  return source.slice(openParenIndex + 1, closeIndex);
}

// The key names an object-literal argument supplies, found by locating the
// first TOP-LEVEL "{" in `argsText` (string/template-literal-aware, so a
// `${...}` inside an earlier template-literal argument is skipped rather
// than mistaken for the params object) and reading `name:` keys out of its
// balanced contents. Returns an empty set when no object-literal argument
// is present at all -- the same outcome as one being explicitly omitted.
function suppliedParamNames(argsText: string): Set<string> {
  let braceIndex = -1;
  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStringLiteral(argsText, i);
      continue;
    }
    if (ch === "{") {
      braceIndex = i;
      break;
    }
  }
  if (braceIndex === -1) return new Set();
  const closeIndex = findMatchingClose(argsText, braceIndex, "{", "}");
  if (closeIndex === -1) return new Set();
  const objectText = argsText.slice(braceIndex, closeIndex + 1);
  const names = new Set<string>();
  const KEY_RE = /['"]?([A-Za-z_$][\w$]*)['"]?\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = KEY_RE.exec(objectText))) names.add(m[1]);
  return names;
}

// Same placeholder-name extraction localeParity.test.ts uses (kept as an
// independent literal here rather than importing across the locales/lib
// boundary, matching this file's existing "read from source, don't share a
// second copy of logic that could itself drift silently" discipline for
// unrelated concerns -- the regex ITSELF, {{name}}, is i18next's own fixed
// interpolation syntax, not something this codebase defines and could
// rename).
const PLACEHOLDER_NAME_RE = /\{\{\s*(\w+)\s*\}\}/g;

function requiredParamNames(template: string): string[] {
  const names = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER_NAME_RE)) names.add(m[1]);
  return [...names];
}

interface Finding {
  callShape: "wrapper" | "direct";
  wrapperName?: string;
  file: string;
  ns: string;
  key: string;
  argsText: string;
}

// Auto-discovers every `function NAME(key: string, fallback: string): string
// { ... resolveRegisteredTranslation(LITERAL_NS, key, ...) ?? fallback ... }`
// wrapper defined in `source`, returning name -> ns. Deliberately requires
// the exact key-forwarding shape (the wrapper's OWN `key` parameter passed
// straight through, not re-derived) so a more complex function that merely
// happens to call resolveRegisteredTranslation somewhere in its body isn't
// misidentified as a simple wrapper (translatedSandboxLabel in
// serverConfigSchema.ts is exactly this case -- it conditionally falls
// through to a SECOND namespace and is deliberately NOT treated as a
// literal-key wrapper here; its own call sites are template-literal keyed
// anyway, so excluding it costs nothing).
function findWrapperDefinitions(source: string): Map<string, string> {
  const wrappers = new Map<string, string>();
  const DEF_RE = /function\s+(\w+)\(key: string, fallback: string\): string\s*\{\s*return resolveRegisteredTranslation\(\s*['"]([^'"]+)['"]\s*,\s*key\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = DEF_RE.exec(source))) {
    wrappers.set(m[1], m[2]);
  }
  return wrappers;
}

function findWrapperCallSites(source: string, wrapperName: string): Array<{ key: string; argsText: string }> {
  const callRe = new RegExp(`(?<!function )\\b${wrapperName}\\(\\s*['"]([^'"]+)['"]`, "g");
  const out: Array<{ key: string; argsText: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source))) {
    const openParenIndex = m.index + wrapperName.length;
    out.push({ key: m[1], argsText: findCallArgsText(source, openParenIndex) });
  }
  return out;
}

// Direct resolveRegisteredTranslation(NS, KEY, ...) calls where BOTH ns and
// key are plain string literals immediately at the call site -- catches the
// shape a caller uses when it only needs one or two ad hoc keys and doesn't
// bother defining its own named wrapper (serverConfigSchema.ts's
// getSandboxOutOfRangeAllowedBody, bridgeVersionStaleness.ts's three body
// getters, templateLabels.ts's two). Naturally excludes every wrapper
// FUNCTION DEFINITION itself, since a wrapper's own internal call passes
// its `key` PARAMETER (a bare identifier), never a literal, as the second
// argument.
function findDirectLiteralCallSites(source: string): Array<{ ns: string; key: string; argsText: string }> {
  const marker = "resolveRegisteredTranslation";
  const callRe = /resolveRegisteredTranslation\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g;
  const out: Array<{ ns: string; key: string; argsText: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source))) {
    const openParenIndex = m.index + marker.length;
    out.push({ ns: m[1], key: m[2], argsText: findCallArgsText(source, openParenIndex) });
  }
  return out;
}

const sourceFiles = listSourceFiles(SRC_ROOT);

const findings: Finding[] = sourceFiles.flatMap((file) => {
  const source = fs.readFileSync(file, "utf8");
  const relFile = path.relative(SRC_ROOT, file);
  const out: Finding[] = [];

  const wrappers = findWrapperDefinitions(source);
  for (const [wrapperName, ns] of wrappers) {
    for (const { key, argsText } of findWrapperCallSites(source, wrapperName)) {
      out.push({ callShape: "wrapper", wrapperName, file: relFile, ns, key, argsText });
    }
  }

  for (const { ns, key, argsText } of findDirectLiteralCallSites(source)) {
    out.push({ callShape: "direct", file: relFile, ns, key, argsText });
  }

  return out;
});

describe("every literal-keyed translatedOrFallback-shaped call resolves in en", () => {
  // Scanner smoke test: proves the regex machinery actually found real
  // call sites in real source (not silently zero because a signature
  // changed underneath it), the same role diagnosticsCheckRegistry.test.js's
  // own "found at least the checks batches 1 and 2 are known to have added"
  // check plays for its scanner.
  it("found at least one wrapper-shaped helper and at least one direct literal call site (sanity check on the scan itself)", () => {
    const wrapperFindings = findings.filter((f) => f.callShape === "wrapper");
    const directFindings = findings.filter((f) => f.callShape === "direct");
    expect(wrapperFindings.length, "no wrapper-shaped helper call sites found at all -- regex or naming convention changed?").toBeGreaterThan(0);
    expect(directFindings.length, "no direct literal-keyed resolveRegisteredTranslation calls found at all -- regex changed?").toBeGreaterThan(0);
  });

  it("every literal key found resolves to a non-empty string in en", () => {
    const missing = findings
      .filter(({ ns, key }) => {
        const enNs = readNamespaceJson("en", ns);
        const value = enNs ? getAtPath(enNs, key) : undefined;
        return typeof value !== "string" || value.trim().length === 0;
      })
      .map(
        ({ callShape, wrapperName, file, ns, key }) =>
          `${callShape === "wrapper" ? `${wrapperName}('${key}')` : `resolveRegisteredTranslation('${ns}', '${key}')`} in ${file} -> en/${ns}.json:${key}`,
      )
      .sort();

    expect(
      missing,
      `${missing.length} translatedOrFallback-shaped call(s) name a key with no matching en locale ` +
        "entry -- every locale silently renders the hardcoded fallback string forever, and " +
        "localeParity.test.ts cannot see it because the key was never mirrored into any locale file. " +
        "Add the key (with the exact English literal already hardcoded at the call site) to en, and " +
        "as an explicit English placeholder in every other shipped locale, per serverConfigSchema.ts's " +
        "own documented convention.",
    ).toEqual([]);
  });

  // i18n-debt follow-up, 2026-09-10: the previous test only asks "does the
  // key resolve in en" -- true even for a key whose registered text has a
  // {{placeholder}} the call site never supplies params for, because
  // resolveRegisteredTranslation's own backstop quietly returns null (and
  // the caller's `?? fallback` takes over) whenever a required param name
  // is missing. That is SAFE at runtime (no literal "{{name}}" leaks to a
  // user) but it is a permanently inert registration: the key can never
  // resolve to anything but the caller's JS fallback, for any language,
  // including a real translation written into it later -- defeating the
  // entire point of registering it. unrecognizedSandboxOptionWarning was
  // exactly this case; see i18nDebtFallbackParamsResolve.test.ts for the
  // live proof (an injected non-English bundle that never took effect until
  // this was fixed).
  it("every registered key that has a {{placeholder}} in its en text is called with params covering every placeholder name", () => {
    const uncovered = findings
      .filter(({ ns, key }) => {
        const enNs = readNamespaceJson("en", ns);
        const value = enNs ? getAtPath(enNs, key) : undefined;
        return typeof value === "string" && requiredParamNames(value).length > 0;
      })
      .flatMap(({ callShape, wrapperName, file, ns, key, argsText }) => {
        const enNs = readNamespaceJson("en", ns)!;
        const template = getAtPath(enNs, key) as string;
        const required = requiredParamNames(template);
        const supplied = suppliedParamNames(argsText);
        const missingNames = required.filter((name) => !supplied.has(name));
        if (missingNames.length === 0) return [];
        const callDesc = callShape === "wrapper" ? `${wrapperName}('${key}', ...)` : `resolveRegisteredTranslation('${ns}', '${key}', ...)`;
        return [`${callDesc} in ${file} -- en/${ns}.json:${key} needs {{${missingNames.join("}}, {{")}}} but the call site's params don't supply ${missingNames.length === 1 ? "it" : "them"}`];
      })
      .sort();

    expect(
      uncovered,
      `${uncovered.length} registered key(s) have a {{placeholder}} their own call site can never satisfy -- ` +
        "the key silently and permanently falls back to its JS fallback string for every language " +
        "(resolveRegisteredTranslation's own backstop returns null whenever a required param is missing, " +
        "so this is not a visible \"{{name}}\" leak, just a translation that can never take effect). " +
        "Thread the missing value(s) through as a params object at the call site (add an optional params " +
        "argument to the wrapper if it's a wrapper call, matching serverConfigSchema.ts's translatedOrFallback).",
    ).toEqual([]);
  });
});
