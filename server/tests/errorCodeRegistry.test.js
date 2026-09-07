import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ErrorCode } from "../utils/errorCodes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, "..");

// Every `code: "<literal>"` object-literal property across server/routes,
// server/services, server/middleware and server/index.js -- this is the
// "attached to a response" shape (an object property, always
// alongside an `error`/`message`/`success` sibling in every real case
// checked 2026-08-22). Deliberately regex-based, not a full AST parse: the
// pattern is narrow and well-defined enough not to need one, and it avoids
// a permanent, self-enforcing test dependent on @babel/parser or glob --
// neither is a declared dependency of this project (both happen to be
// present transitively today, pulled in by other tooling, which is not
// something a test meant to keep working indefinitely should rely on).
//
// WHAT THIS DOES NOT SCAN, ON PURPOSE: bare `X.code = "<literal>"`
// assignment expressions (no colon) are invisible to this regex by
// construction. That's deliberate, not an oversight -- that shape covers
// both genuinely internal, never-user-facing codes (ETIMEDOUT, an
// internal GitHub-API timeout marker read back by isRetryableGitHubError())
// and at least one real user-facing one (`apply_in_progress` in
// spawnWindowsApplyHelper()) with no structural way to tell them apart
// short of reading intent -- see server/utils/errorCodes.js's own trailing
// comment for the full accounting of that gap. A code introduced that way
// will NOT be caught here if it's missing from the registry.
const CODE_LITERAL_RE = /\bcode:\s*(["'])([^"']+)\1/g;

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
  // Deliberately NOT server/utils: errorCodes.js itself lives there, and
  // its own header comments use illustrative `code: "<literal>"` snippets
  // (the same documentation style this file's own header comments use) --
  // scanning that directory makes CODE_LITERAL_RE match those illustrative
  // strings as if they were real emitted codes. See
  // KNOWN_INTENTIONALLY_UNREFERENCED below for the actual fix to the
  // updateBundle.js "referenced but this scanner can't see it" gap that
  // motivated trying this once (updateBundle.js lives in server/services,
  // already scanned above -- it was never a missing-directory problem).
];

function findCodeLiterals() {
  const found = [];
  for (const file of SCANNED_FILES) {
    const source = fs.readFileSync(file, "utf8");
    const relFile = path.relative(SERVER_DIR, file).replace(/\\/g, "/");
    let match;
    CODE_LITERAL_RE.lastIndex = 0;
    while ((match = CODE_LITERAL_RE.exec(source))) {
      const line = source.slice(0, match.index).split("\n").length;
      found.push({ file: relFile, line, value: match[2] });
    }
  }
  return found;
}

// The OTHER real usage shape alongside `code: "<literal>"` above, and the
// dominant one by volume (336 member-access references vs. 17 literal-string
// ones as of 2026-08-23): `code: ErrorCode.SOME_NAME` -- already
// registry-safe by construction (a typo here is `undefined` at runtime, not
// a silent divergence), which is why the check above doesn't scan for it.
// The orphan check below needs it anyway: a code referenced only this way is
// not unused, and scanning literals alone would falsely flag ~95% of the
// registry as orphaned.
const CODE_MEMBER_RE = /\bErrorCode\.([A-Z][A-Z0-9_]*)\b/g;

function findMemberReferences() {
  const found = new Set();
  for (const file of SCANNED_FILES) {
    const source = fs.readFileSync(file, "utf8");
    let match;
    CODE_MEMBER_RE.lastIndex = 0;
    while ((match = CODE_MEMBER_RE.exec(source))) {
      found.add(match[1]);
    }
  }
  return found;
}

// A THIRD reference shape, for the orphan check below only (findCodeLiterals()
// above stays scoped to the `code:` object-literal property on purpose --
// see its own header comment). server/tests/errorCodeThrownVsRegistered.test.js
// established that this codebase has exactly three local helper functions
// whose whole job is "build an Error carrying a wire `.code`" -- makeRoleError
// (services/auth.js), makeError (services/permissions.js) and updateError
// (services/updateBundle.js), all shape `(code, message, ...) => {
// err.code = code; return err; }` -- and that every coded throw in the files
// defining them goes through one of the three rather than assigning `.code`
// ad hoc. A string-literal first argument to any of them (e.g.
// `updateError("invalid_bundle", ...)`) is therefore a real reference, just
// not the `code:` property or `ErrorCode.NAME` member-access shape the two
// scanners above look for. Without this, every code emitted ONLY that way
// reads as orphaned here regardless of which directory holds the factory's
// call sites -- 2026-09-07: confirmed by trying to fix it via SCANNED_FILES
// instead (widening to include server/utils/ changed nothing, because
// updateBundle.js already lives in server/services/, already scanned; the
// gap was always the call SHAPE, not the directory). Deliberately narrower
// than errorCodeThrownVsRegistered.test.js's own resolution logic (no
// same-file const-alias one-hop-back, no ErrorCode.NAME-as-factory-arg --
// that's already covered by findMemberReferences() above scanning the same
// files): this only needs to prove a value is REFERENCED at all, not resolve
// every call site's argument, so a plain string-literal check is enough to
// close the gap without duplicating that file's more elaborate machinery.
const CODED_ERROR_FACTORIES = ["makeRoleError", "makeError", "updateError"];

function findFactoryLiteralReferences() {
  const found = new Set();
  for (const factory of CODED_ERROR_FACTORIES) {
    const re = new RegExp(`\\b${factory}\\(\\s*(["'])([^"']+)\\1`, "g");
    for (const file of SCANNED_FILES) {
      const source = fs.readFileSync(file, "utf8");
      let match;
      re.lastIndex = 0;
      while ((match = re.exec(source))) {
        found.add(match[2]);
      }
    }
  }
  return found;
}

// Three ErrorCode entries are registered but deliberately never emitted --
// each was split into narrower variants because the original covered
// multiple distinct outcomes behind one message. WRITABLE_PATH_ERROR and
// DIRECTORY_READ_FAILED were split on 2026-08-22 (into
// WRITABLE_PATH_{INSTALL,DATA}_{BAREMETAL,CONTAINER} and
// DIRECTORY_READ_FAILED_{WINDOWS,POSIX} respectively) because each covered
// multiple distinct English sentences behind an unreachable
// {{label}}/{{guidance}} placeholder that never actually received params.
// RCON_CONNECT_FAILED was split on 2026-08-26 into RCON_CONNECT_UNREACHABLE
// / RCON_CONNECT_AUTH_FAILED (server/routes/rcon.js POST /connect) because
// it collapsed "host never reachable" and "reachable, but the password is
// wrong" into one generic message, while POST /rcon/test already told the
// two apart -- see conv install-idiot-proofing-2026-08. The same day,
// server/routes/config.js POST /test-rcon picked up the identical split
// (it had the exact same collapsed-message bug and was never migrated when
// /connect was) and now emits the same two codes as a third call site.
// All three splits
// were additive-only: the original code stays registered, with its own
// explanatory comment at the registry entry (see server/utils/errorCodes.js)
// and its own client/src/locales/en/errors.json key, on purpose -- "kept
// for registry completeness," not an oversight. Verified 2026-08-26: none
// of the three appears as a literal or an ErrorCode.NAME reference anywhere
// in server/routes, server/services, server/middleware or server/index.js.
// Do not remove any of them from this allowlist without first removing the
// registry entry and its locale key in the same commit.
const KNOWN_INTENTIONALLY_UNREFERENCED = new Set([
  "WRITABLE_PATH_ERROR",
  "DIRECTORY_READ_FAILED",
  "RCON_CONNECT_FAILED",

  // The seven updateBundle.js legacy codes (INVALID_BUNDLE_LEGACY etc.,
  // registered by Kevin in 11fe8dea) deliberately do NOT belong in this
  // set, even though they used to fail the orphan check below: they are
  // not dead, and this set is for codes that really are never emitted.
  // findFactoryLiteralReferences() above is the actual fix -- it
  // recognizes updateError("invalid_bundle", ...)'s positional-string-
  // literal shape as a real reference, the same way findMemberReferences()
  // already recognizes ErrorCode.NAME. Putting them here instead would
  // have recorded a false "never emitted" as true just to silence the
  // assertion.
]);

// The mirror image of the above: an errors.json key that exists ONLY on
// the client, with no server-emitted `code:` value behind it at all -- so
// it can never belong in ErrorCode, which this file's own header comment
// scopes to codes the server actually attaches to a response. Each entry
// here must say what synthesizes it and why it has no single emission
// site to cite in server/routes or server/services.
const KNOWN_CLIENT_ONLY_LOCALE_KEYS = new Set([
  // client/src/lib/errorMessage.ts's wrapUncodedServerError() wraps ANY
  // ApiError with status >= 500 and no code that resolves to a registered
  // translation (2026-08-26: the panelBridge.js/server.js generic
  // catch-all convention -- uncoded 500s stay uncoded by design). It
  // exists for every route file's uncoded catch-all at once, so unlike
  // every other entry in this registry it has no single server call site
  // to point at.
  "UNEXPECTED_SERVER_ERROR",
]);

// This is a STRUCTURE check, one level deeper than the fr/en locale parity
// test (client/src/locales/__tests__/localeParity.test.ts), not a MEANING
// check: it proves every code literal the server actually emits is a
// registered ErrorCode member, and (once client/src/locales/en/errors.json
// exists) that every registered member has an English locale entry.
// A green run here proves a key EXISTS for every code -- it says nothing
// about whether the English or French TEXT at that key is the right text
// for that code. That last mile is the same one the locales README already
// names for the fr/en parity test (the shipped nav.items.serverSetup
// incident): a human has to read the rendered string, this test cannot.
//
// A CONSTRAINT THIS EXACT-MATCH CHECK IMPOSES ON errors.json: it compares
// each ErrorCode CONSTANT NAME to a locale key with `===`, so i18next's
// `_one`/`_other` plural-suffixed key convention (e.g. splitting
// ROLE_HAS_MEMBERS into ROLE_HAS_MEMBERS_one / ROLE_HAS_MEMBERS_other)
// fails this test -- the bare constant-name key it looks for is missing,
// even though a real, working pair of plural keys exists. Angela hit this
// for ROLE_HAS_MEMBERS and correctly kept the source text's manual
// "user(s)" style instead, documenting it as a constraint rather than
// fighting the test. This is intentional, not a gap to fix: exact-match is
// what makes this check catch a missing/misspelled key at all, and a
// looser match (prefix, or ignoring _one/_other suffixes) would let a
// genuinely missing bare key hide behind an unrelated plural pair. If a
// future code needs real plural forms, it needs a second, explicit
// mechanism -- not a loosening of this one.
describe("server error codes: registry membership (structure, not meaning)", () => {
  it("every `code:` literal used in server/routes, server/services, server/middleware and server/index.js is a registered ErrorCode value", () => {
    const registryValues = new Set(Object.values(ErrorCode));
    const literals = findCodeLiterals();
    const unregistered = literals.filter((l) => !registryValues.has(l.value));

    expect(
      unregistered,
      unregistered.length
        ? `Found ${unregistered.length} code literal(s) not in server/utils/errorCodes.js -- ` +
            "add each one to the ErrorCode registry (with a comment saying where " +
            "it's used) instead of leaving it a bare string literal:\n" +
            unregistered
              .map((l) => `  ${l.file}:${l.line} -> "${l.value}"`)
              .join("\n")
        : "",
    ).toEqual([]);
  });

  it("sanity check: the scan actually finds the codes known to exist today (guards against the regex silently matching nothing)", () => {
    const literals = findCodeLiterals();
    expect(literals.length).toBeGreaterThan(20);
    expect(literals.map((l) => l.value)).toContain("SETUP_TOKEN_REQUIRED");
    expect(literals.map((l) => l.value)).toContain("server_running");
  });

  // The half people forget: a registry entry no longer referenced anywhere
  // in source -- either dead from the start or orphaned by a later edit.
  // "no entry survives for a code that was removed" applies from BOTH the
  // source side (this) and the locale side (below). Mirrors
  // progressCodeRegistry.test.js's equivalent check; the reference set here
  // is wider (literal OR member access) because ErrorCode, unlike
  // ProgressCode, is genuinely used both ways in this codebase.
  it("every registered ErrorCode value is referenced at least once (as a `code:` literal, an `ErrorCode.NAME` member access, or a known coded-error-factory's literal argument) in server/routes, server/services, server/middleware or server/index.js", () => {
    const literalValues = new Set(findCodeLiterals().map((l) => l.value));
    const memberNames = findMemberReferences();
    const factoryValues = findFactoryLiteralReferences();

    const unused = Object.keys(ErrorCode).filter(
      (name) =>
        !KNOWN_INTENTIONALLY_UNREFERENCED.has(name) &&
        !memberNames.has(name) &&
        !literalValues.has(ErrorCode[name]) &&
        !factoryValues.has(ErrorCode[name]),
    );

    expect(
      unused,
      unused.length
        ? `${unused.length} ErrorCode entr(y/ies) registered but never emitted: ${unused.join(", ")}. ` +
            "Remove from errorCodes.js and its locale entries, or wire it up. If it's " +
            "intentionally kept (e.g. split into narrower variants), add it to " +
            "KNOWN_INTENTIONALLY_UNREFERENCED above with a comment explaining why, the " +
            "way WRITABLE_PATH_ERROR and DIRECTORY_READ_FAILED already are."
        : "",
    ).toEqual([]);
  });

  const localeEnPath = path.join(
    SERVER_DIR,
    "..",
    "client",
    "src",
    "locales",
    "en",
    "errors.json",
  );

  if (fs.existsSync(localeEnPath)) {
    it("every registered ErrorCode has a matching key in client/src/locales/en/errors.json", () => {
      const localeKeys = new Set(
        Object.keys(JSON.parse(fs.readFileSync(localeEnPath, "utf8"))),
      );
      const missing = Object.keys(ErrorCode).filter(
        (name) => !localeKeys.has(name),
      );

      expect(
        missing,
        missing.length
          ? `client/src/locales/en/errors.json is missing an entry for: ${missing.join(", ")}. ` +
              "The locale key is the ErrorCode CONSTANT NAME, not its wire value " +
              "(see server/utils/errorCodes.js for why those two differ for the " +
              "legacy codes)."
          : "",
      ).toEqual([]);
    });

    it("every key in client/src/locales/en/errors.json is a registered ErrorCode value (no stale entries for a removed/renamed code)", () => {
      const localeKeys = Object.keys(
        JSON.parse(fs.readFileSync(localeEnPath, "utf8")),
      );
      const registryNames = new Set(Object.keys(ErrorCode));
      const stale = localeKeys.filter(
        (key) =>
          !registryNames.has(key) && !KNOWN_CLIENT_ONLY_LOCALE_KEYS.has(key),
      );

      expect(
        stale,
        stale.length
          ? `client/src/locales/en/errors.json has entries for removed/renamed codes: ${stale.join(", ")}`
          : "",
      ).toEqual([]);
    });
  } else {
    it.skip(
      "every registered ErrorCode has a matching key in client/src/locales/en/errors.json -- " +
        "SKIPPED: client/src/locales/en/errors.json does not exist yet. This test starts " +
        "enforcing automatically the moment that file is created; no change needed here.",
      () => {},
    );
    it.skip(
      "every key in client/src/locales/en/errors.json is a registered ErrorCode value -- " +
        "SKIPPED: client/src/locales/en/errors.json does not exist yet. This test starts " +
        "enforcing automatically the moment that file is created; no change needed here.",
      () => {},
    );
  }
});
