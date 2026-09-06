import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ErrorCode } from "../utils/errorCodes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, "..");

// errorCodeRegistry.test.js proves every `code: "<literal>"` OBJECT-LITERAL
// property is registered. It says nothing about a code that reaches a
// thrown Error's `.code` some other way -- and 2026-09-06 proved that gap is
// real, not hypothetical: auth.js's ff17ee11 throws
// ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES and USER_SELF_ROLE_CHANGE_REFUSED
// as real wire codes (both eventually written to a JSON response body's
// `code` field by routes/auth.js's own catch blocks) that are registered in
// NEITHER errorCodes.js nor any locale file -- and the full gate
// (LINT/RUNNER/CLIENT/CLIENTLINT/TSC, 454 files, 3882 tests) stayed green
// through it, because nothing checked this direction of the join.
//
// A blind static sweep of "every way an error might get thrown" is not
// achievable soundly -- codes are also passed as variables, built by
// helpers, and re-thrown, and a regex broad enough to catch all of that
// would also be too broad to trust. Instead of guessing at throw shapes,
// this targets where the INTENT is already expressed: this codebase has
// exactly three local helper functions whose entire job is "build an Error
// carrying a wire `.code`" -- makeRoleError (services/auth.js), makeError
// (services/permissions.js) and updateError (services/updateBundle.js), all
// three of shape `(code, message, ...) => { err.code = code; return err; }`.
// Every coded throw in the files that define these three goes through one
// of them (confirmed by reading auth.js/permissions.js/updateBundle.js
// end to end) rather than assigning `.code` ad hoc, so scanning THEIR call
// sites is a real choke point for those three files, not a shape-guessing
// grep. See the "factory list is exhaustive" test below for how this stays
// honest if a fourth one is ever added.
//
// WHAT THIS DOES NOT COVER, ON PURPOSE (see the file-level TODO this exists
// to close, and be honest about the rest rather than claim exhaustive
// coverage this can't back up):
//   - Any file that tags `.code` on an error WITHOUT going through one of
//     the three named factories (a bare `err.code = "X"` assignment, a
//     spread from an upstream error, a third-party library's own error).
//   - A factory call whose first argument isn't a string literal, an
//     `ErrorCode.NAME` member access, or a same-file `const`/`let NAME =
//     "literal"` one hop back -- e.g. a template literal, a function
//     parameter's default value, a value built by concatenation, or an
//     import from another module. Each such call site is listed as
//     UNRESOLVED in a thrown assertion message if any appear (see the
//     second test below) rather than silently skipped, so a genuinely new
//     unresolvable shape is visible instead of invisible.
//   - Legacy lowercase wire codes (e.g. "invalid_bundle", "apply_in_progress")
//     are still checked against the SAME registry as everything else here
//     (ErrorCode's VALUES, not just its upper-snake-case KEYS -- see
//     APPLY_IN_PROGRESS_LEGACY's own entry for why those two differ) -- this
//     file does not special-case or exempt them by SHAPE. It does carry one
//     deliberate, hardcoded, shrinking EXCEPTION LIST for seven specific
//     already-known values -- see BASELINE_UNREGISTERED_CODES below for why
//     and for the test that keeps it from silently outliving the debt it
//     records (card: updatebundle-seven-unregistered-codes).

const CODED_ERROR_FACTORIES = ["makeRoleError", "makeError", "updateError"];

// updatebundle-seven-unregistered-codes: these seven wire codes, all thrown
// via services/updateBundle.js's updateError() factory, were found
// genuinely unregistered by this test on 2026-09-06 (commit ec63e4bd).
// Registering each needs a real errorCodes.js entry AND 9 real locale
// translations (63 entries total) -- real work, owned by Kevin as a
// follow-up, not by this test. Baselined here ONLY so the floor's pushes
// aren't blocked on that work landing first (two other commits were
// already stacked behind this test's redness the same day) -- the test's
// ongoing value, catching the NEXT unregistered code, starts the moment
// it's green and doesn't need to wait for this debt to clear.
//
// THIS LIST IS EXPECTED TO SHRINK TO EMPTY, ONE DELETION AT A TIME, AS EACH
// CODE GETS REGISTERED. It is a hardcoded set of these exact seven strings,
// never a pattern and never a file-level skip -- an EIGHTH unregistered
// code appearing in updateBundle.js still fails the test below. And the
// "stays honest" test right after this one fails the moment any of these
// seven actually becomes registered while still listed here, naming which
// one to delete -- so this baseline cannot silently outlive the debt it
// records the way an unmonitored allowlist normally would.
const BASELINE_UNREGISTERED_CODES = new Set([
  "invalid_bundle",
  "version_mismatch",
  "av_quarantine",
  "frontend_swap_failed",
  "hash_unverifiable",
  "binary_swap_failed",
  "rollback_failed",
]);

function listJsFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(dir, f));
}

const SCANNED_FILES = [
  ...listJsFiles(path.join(SERVER_DIR, "routes")),
  ...listJsFiles(path.join(SERVER_DIR, "services")),
  ...listJsFiles(path.join(SERVER_DIR, "middleware")),
  path.join(SERVER_DIR, "index.js"),
];

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// Resolves the FIRST argument of a factory call starting right after its
// opening "(" (callSiteIndex points at that "("). Deliberately narrow: see
// this file's own header comment for exactly what falls outside this.
function resolveFirstArg(fullSource, afterOpenParenIndex, callSiteIndex) {
  const window = stripComments(
    fullSource.slice(afterOpenParenIndex, afterOpenParenIndex + 500),
  ).trimStart();

  const memberMatch = window.match(/^ErrorCode\.([A-Z][A-Z0-9_]*)\b/);
  if (memberMatch) {
    return { kind: "member", name: memberMatch[1] };
  }

  const literalMatch = window.match(/^(["'])((?:\\.|(?!\1)[^\\])*)\1/);
  if (literalMatch) {
    return { kind: "literal", value: literalMatch[2] };
  }

  const identMatch = window.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\b/);
  if (identMatch) {
    const ident = identMatch[1];
    // Single-hop lookback: the nearest same-file `const`/`let NAME = "..."`
    // whose declaration is textually BEFORE this call site. Anything more
    // (a different scope, a reassignment, a value threaded through a
    // parameter) is exactly what "single-hop" excludes -- see header comment.
    const declRe = new RegExp(
      `\\b(?:const|let)\\s+${ident}\\s*=\\s*(["'])((?:\\\\.|(?!\\1)[^\\\\])*)\\1\\s*;`,
      "g",
    );
    let best = null;
    let m;
    while ((m = declRe.exec(fullSource))) {
      if (m.index < callSiteIndex) best = m;
    }
    if (best) {
      return { kind: "literal", value: best[2], viaVariable: ident };
    }
    return { kind: "unresolved", raw: identMatch[1] };
  }

  return { kind: "unresolved", raw: window.slice(0, 60) };
}

function findFactoryCallArgs() {
  const resolved = [];
  const unresolved = [];

  for (const file of SCANNED_FILES) {
    const source = fs.readFileSync(file, "utf8");
    const relFile = path.relative(SERVER_DIR, file).replace(/\\/g, "/");

    for (const factory of CODED_ERROR_FACTORIES) {
      const callRe = new RegExp(`\\b${factory}\\s*\\(`, "g");
      let match;
      while ((match = callRe.exec(source))) {
        // Skip the factory's own declaration line (`function makeRoleError(`)
        // -- its "call site" regex also matches the function signature itself.
        const precedingText = source.slice(Math.max(0, match.index - 10), match.index);
        if (/\bfunction\s*$/.test(precedingText)) continue;

        const afterOpenParenIndex = match.index + match[0].length;
        const line = source.slice(0, match.index).split("\n").length;
        const arg = resolveFirstArg(source, afterOpenParenIndex, match.index);

        if (arg.kind === "unresolved") {
          unresolved.push({ file: relFile, line, factory, raw: arg.raw });
        } else if (arg.kind === "literal") {
          resolved.push({ file: relFile, line, factory, value: arg.value, viaVariable: arg.viaVariable });
        }
        // arg.kind === "member" (ErrorCode.NAME) is registry-safe by
        // construction -- same convention errorCodeRegistry.test.js already
        // relies on for the general codebase-wide scan.
      }
    }
  }

  return { resolved, unresolved };
}

describe("server error codes: thrown-via-known-factory codes must be registered (the reverse join errorCodeRegistry.test.js doesn't cover)", () => {
  it("the known coded-error-factory list is exhaustive -- fails loudly if a new one appears uncounted", () => {
    // Mirrors the shape of makeRoleError/makeError/updateError themselves:
    // a top-level function whose first parameter is literally named `code`.
    // This is the self-check that keeps CODED_ERROR_FACTORIES from silently
    // going stale -- if this ever finds a name not already in the list
    // above, it means a fourth "build a coded Error" helper was added
    // somewhere in scanned server code and this file's own scan is now
    // blind to it until it's added by hand.
    const found = new Set();
    const factoryDeclRe = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*code\s*[,)]/g;
    for (const file of SCANNED_FILES) {
      const source = fs.readFileSync(file, "utf8");
      let match;
      while ((match = factoryDeclRe.exec(source))) {
        found.add(match[1]);
      }
    }

    const uncounted = [...found].filter((name) => !CODED_ERROR_FACTORIES.includes(name));
    expect(
      uncounted,
      uncounted.length
        ? `Found coded-error-factory-shaped function(s) not in CODED_ERROR_FACTORIES: ${uncounted.join(", ")}. ` +
            "Add each to the list at the top of this file so its call sites get scanned too."
        : "",
    ).toEqual([]);
  });

  it("sanity check: the scan actually finds real call sites (guards against the regex silently matching nothing)", () => {
    const { resolved, unresolved } = findFactoryCallArgs();
    expect(resolved.length + unresolved.length).toBeGreaterThan(5);
  });

  // Deliberately informational, not a failure: an UNRESOLVED call site means
  // "this scan cannot tell what code is thrown here" -- it might be fine
  // (an ErrorCode.NAME reference this test didn't need to flag, a value
  // threaded through a parameter) or it might be exactly the next version of
  // this same bug wearing a shape this pass didn't anticipate. Printed so a
  // human can look, rather than silently dropped.
  it("reports (does not fail on) factory call sites this scan could not statically resolve", () => {
    const { unresolved } = findFactoryCallArgs();
    if (unresolved.length > 0) {
      console.warn(
        `errorCodeThrownVsRegistered: ${unresolved.length} factory call site(s) with an unresolvable first argument (not a failure, see this file's header comment):\n` +
          unresolved.map((u) => `  ${u.file}:${u.line} ${u.factory}(${u.raw}...`).join("\n"),
      );
    }
    expect(true).toBe(true);
  });

  it("every statically-resolved code passed to a known coded-error factory is a registered ErrorCode value (baseline debt excepted -- see BASELINE_UNREGISTERED_CODES)", () => {
    const registryValues = new Set(Object.values(ErrorCode));
    const { resolved } = findFactoryCallArgs();
    const unregistered = resolved.filter(
      (r) => !registryValues.has(r.value) && !BASELINE_UNREGISTERED_CODES.has(r.value),
    );

    expect(
      unregistered,
      unregistered.length
        ? `Found ${unregistered.length} code(s) thrown via a known factory that are NOT in server/utils/errorCodes.js's ` +
            "ErrorCode registry (and so have no locale translation either):\n" +
            unregistered
              .map(
                (u) =>
                  `  ${u.file}:${u.line} ${u.factory}(${u.viaVariable ? `${u.viaVariable} = ` : ""}"${u.value}", ...)`,
              )
              .join("\n") +
            "\nRegister each one in errorCodes.js (with its locale entries) -- or if it's " +
            "intentionally not yet wired up, that's a real gap this test exists to surface, not to hide."
        : "",
    ).toEqual([]);
  });

  // The other half of a baseline done responsibly: it must shrink, and
  // nothing here enforces that on its own unless something fails when it
  // doesn't. The moment one of the seven listed codes is actually
  // registered, leaving its entry in BASELINE_UNREGISTERED_CODES stops
  // meaning "known debt" and starts meaning "silently exempted from the
  // real check above forever" -- the exact way an unmonitored allowlist
  // normally goes stale. This fails loudly instead, naming which entry to
  // delete, so the baseline is self-liquidating rather than permanent.
  it("updatebundle-seven-unregistered-codes baseline stays honest: fails the moment a listed code becomes registered (delete it from the list, don't leave it)", () => {
    const registryValues = new Set(Object.values(ErrorCode));
    const nowRegistered = [...BASELINE_UNREGISTERED_CODES].filter((code) =>
      registryValues.has(code),
    );

    expect(
      nowRegistered,
      nowRegistered.length
        ? `${nowRegistered.length} baseline code(s) are now registered but still listed in ` +
            `BASELINE_UNREGISTERED_CODES: ${nowRegistered.join(", ")}. Delete each one from the list -- ` +
            "it's supposed to shrink to empty, not accumulate stale entries."
        : "",
    ).toEqual([]);
  });
});
