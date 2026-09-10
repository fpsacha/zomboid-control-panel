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

interface Finding {
  callShape: "wrapper" | "direct";
  wrapperName?: string;
  file: string;
  ns: string;
  key: string;
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

function findWrapperCallSites(source: string, wrapperName: string): string[] {
  const callRe = new RegExp(`(?<!function )\\b${wrapperName}\\(\\s*['"]([^'"]+)['"]`, "g");
  const keys: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source))) {
    keys.push(m[1]);
  }
  return keys;
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
function findDirectLiteralCallSites(source: string): Array<{ ns: string; key: string }> {
  const callRe = /resolveRegisteredTranslation\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g;
  const out: Array<{ ns: string; key: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source))) {
    out.push({ ns: m[1], key: m[2] });
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
    for (const key of findWrapperCallSites(source, wrapperName)) {
      out.push({ callShape: "wrapper", wrapperName, file: relFile, ns, key });
    }
  }

  for (const { ns, key } of findDirectLiteralCallSites(source)) {
    out.push({ callShape: "direct", file: relFile, ns, key });
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
});
