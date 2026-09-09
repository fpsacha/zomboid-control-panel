import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  levenshteinDistance,
  findNearMissTypo,
  triageUnresolvedMods,
} from "../routes/debug.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, "..");
const REPO_ROOT = path.join(SERVER_DIR, "..");
const DEBUG_JS_PATH = path.join(SERVER_DIR, "routes", "debug.js");
const EN_DEBUG_JSON_PATH = path.join(REPO_ROOT, "client/src/locales/en/debug.json");
const FR_DEBUG_JSON_PATH = path.join(REPO_ROOT, "client/src/locales/fr/debug.json");

const STATUS_NAMES = new Set(["ok", "fail", "warn", "skip", "info"]);

/**
 * Every check id whose translation is considered DONE -- the forward
 * completeness assertion below only fires for ids in this list. Grows one
 * batch at a time (see client/src/lib/diagnosticsTranslation.ts /
 * server/routes/debug.js's own comments for the batch plan). An id NOT in
 * this list can exist in source with no locale entry at all -- that's the
 * normal, safe, incremental state (translateDiagnosticCheck() falls back to
 * the server's English text for any id with nothing registered) -- but an
 * id IN this list is a promise: every (status[, variant]) combination the
 * handler can emit for it must have complete en AND fr entries.
 *
 * Adding an id here without matching locale entries is a deliberate,
 * immediate test failure -- that's the self-enforcing half of this file.
 * The OTHER half (no stale locale entries for a check that no longer
 * exists in the handler, or a status/variant that can no longer fire) is
 * unconditional and applies to every check in the locale files regardless
 * of whether it's in this list yet.
 */
const KNOWN_TRANSLATED_IDS = new Set([
  // Batch 1: Core Services
  "server.process",
  "rcon.connected",
  "modChecker",
  "scheduler",
  "discord.bot",
  "services.error",
  // Batch 2: Active Server
  "server.active",
  "server.installPath",
  "server.zomboidData",
  "server.startScript",
  "server.jre",
  "server.ini",
  "server.rconPassword",
  "server.bridgeMod",
  // Batch 3: Storage & Database
  "db.exists",
  "db.writable",
  "db.backup",
  "storage.lockProtection",
  "logs.writable",
  "disk.free",
  "storage.saveSize",
  "storage.error",
  // Batch 4: Runtime & Memory
  "runtime.heap",
  "runtime.hostMem",
  "runtime.uptime",
  "runtime.error",
  "runtime.timeSkew",
  // Batch 5: Updates
  "update.steamApi",
  "update.panel",
  "update.mods",
  "update.rollback",
  "updates.error",
  // Batch 6: PanelBridge IPC
  "bridge.configured",
  "bridge.writable",
  "bridge.heartbeat",
  "bridge.error",
  // Batch 7: Mods (+ server.recentCrash, same try-block as batch 2's
  // Active Server checks, just further down in the file)
  "mods.workshopCrash",
  "server.recentCrash",
  "mods.numericInMods",
  "mods.resolved",
  "mods.orphanWorkshop",
  "mods.duplicates",
  "mods.maps",
  // Batch 8 (final): remaining server.* catch-alls, same try-block again.
  // server.configDrift is DELIBERATELY NOT in this list -- its message is
  // built by joining a variable-length array of independently-phrased
  // clauses (up to 3 possible drift dimensions), which doesn't fit the
  // params/variant mechanism without a wire-shape change (structured
  // clauses instead of one joined string). Left on the English fallback,
  // unchanged from before this file existed -- not a regression, a
  // deliberately deferred id. See the wind-down report for the full reasoning.
  "server.sandboxCorrupt",
  "server.sandboxVars",
  "server.staleLocks",
  "server.jreWorks",
  "server.error",
  // Batch 9: named collector functions (diagnostics-registry-scanner-
  // cannot-see-named-collector-functions, 2026-09-09) -- newly VISIBLE to
  // the scanner, not newly built. rcon.commandRejections::warn::
  // someRejected deliberately has NO hint entry in either locale file:
  // that hint is built by joining a variable-length array of runtime-
  // classified rejection reasons plus a closing line (server/routes/
  // debug.js's RCON_REJECTION_REASON_HINTS), the exact same "variable-
  // length joined clauses" shape server.configDrift is excluded above
  // for. The (id, status, variant) key itself is still required in both
  // locale files -- only the hint field is left on the English fallback,
  // same as before this batch, not a regression.
  "mods.thumbnailResolution",
  "rcon.commandRejections",
]);

/**
 * Named collector functions: `function name(...) { ... }` declarations
 * that build ONE check via diagOk/Fail/Warn/Skip/Info and are defined
 * OUTSIDE the /diagnostics handler's own textual boundary ON PURPOSE --
 * extracted so they're independently unit-testable without exercising
 * the whole handler (thumbnailResolutionCheck.test.js's own comment).
 * The handler calls each of these (`checks.push(buildXCheck(...))`); the
 * scanner below folds each one's own diag*() calls into the handler's
 * effective source so it sees them exactly like an inline call.
 *
 * Deliberately an explicit, manually-maintained list -- same maintenance
 * model as KNOWN_TRANSLATED_IDS above, not a whole-file scan for every
 * `function` declaration. debug.js has other, much larger top-level
 * functions (collectBundleKnownSecrets alone is 200+KB) that a generic
 * brace-matching body extractor cannot safely delimit -- a regex literal
 * with a quantifier like `/\d{4}/` contains a `{`/`}` that isn't part of
 * a real code block, and a naive counter desyncs on it, silently
 * swallowing everything after. Both functions in this list were read in
 * full when they were added and contain no regex literals, which is what
 * makes brace-matching safe for them specifically -- verify the same
 * before adding a third.
 */
const NAMED_COLLECTOR_FUNCTION_NAMES = [
  "buildThumbnailResolutionCheck",
  "buildRconCommandRejectionsCheck",
];

/**
 * Brace-matched extraction of one named top-level function's body
 * (declaration through its closing `}`) -- see NAMED_COLLECTOR_FUNCTION_
 * NAMES' own comment for why this is scoped to an explicit small list
 * rather than run over the whole file.
 *
 * Skips string/template literals AND `//`/slash-star comments before
 * counting a brace -- comment-blindness here is not hypothetical: this
 * exact function desynced on its own first real use, because a `//`
 * comment describing this very fix contained a plain English apostrophe
 * ("that file's own", "db.backup's"). An unpaired quote character inside
 * a comment is indistinguishable from a real string-literal delimiter to
 * a scanner that doesn't know what a comment is, and it will happily
 * treat everything up to the NEXT stray quote anywhere later in the file
 * as "inside a string" -- silently skipping real braces, including this
 * function's own closing one, until content hundreds of lines away
 * (in this case: past the entire rest of debug.js) restores the count by
 * accident. Caught only because the category-membership test below
 * happened to notice checks from /worldmap leaking in; nothing about the
 * id/status/variant tests would have caught it, since the swallowed text
 * still contained valid diag*() calls with no locale-registry
 * consequence. Comments are common and contractions/possessives are
 * common English -- treat this as the default case to guard against, not
 * an edge case.
 */
function extractNamedFunctionBody(source, name) {
  const declRe = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const declMatch = declRe.exec(source);
  if (!declMatch) return null;

  let i = declMatch.index + declMatch[0].length - 1; // sitting on the parameter list's '('
  let parenDepth = 0;
  for (; i < source.length; i++) {
    if (source[i] === "(") parenDepth++;
    else if (source[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        i++;
        break;
      }
    }
  }
  while (i < source.length && source[i] !== "{") i++;
  const bodyStart = i;
  let braceDepth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i++; // land on the closing '/'; the loop's own i++ steps past it
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "{") braceDepth++;
    else if (ch === "}") {
      braceDepth--;
      if (braceDepth === 0) {
        i++;
        break;
      }
    }
  }
  return source.slice(bodyStart, i);
}

/**
 * Reads DIAG_CATEGORIES' own key set straight from debug.js source --
 * regex-scanned, same discipline as everything else in this file, rather
 * than a second hardcoded copy that could silently drift from the real
 * object. Scoped to the object literal's own top-level (2-space-indented)
 * keys so it can't pick up `label`/`order` from inside a nested value.
 */
function extractDiagCategoryKeys(source) {
  const startMarker = "const DIAG_CATEGORIES = {";
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(
      "Could not locate DIAG_CATEGORIES in debug.js -- this test's category scan depends on " +
        "that declaration staying a literal object.",
    );
  }
  const bodyStart = start + startMarker.length;
  const bodyEnd = source.indexOf("\n};", bodyStart);
  if (bodyEnd === -1) {
    throw new Error("Could not find DIAG_CATEGORIES' closing brace in debug.js.");
  }
  const body = source.slice(bodyStart, bodyEnd);
  const KEY_RE = /^ {2}([A-Za-z_$][A-Za-z0-9_$]*):\s*\{/gm;
  const keys = new Set();
  let m;
  while ((m = KEY_RE.exec(body))) keys.add(m[1]);
  return keys;
}

/**
 * Scans the GET /diagnostics handler (not the separate GET /worldmap
 * handler right after it, which is a different tab with its own checks and
 * out of scope here) for every diagOk/diagFail/diagWarn/diagSkip/diagInfo
 * call, and for every literal `variant: "..."` alongside one.
 *
 * Also collects every literal `category: "..."` value emitted in that same
 * scope -- rcon-command-rejections-check-has-never-rendered-in-any-
 * language, 2026-09-09: a check whose category is not a DIAG_CATEGORIES
 * key renders NOWHERE in the UI (Debug.tsx filters by category===catKey
 * against those keys only) while still running and computing a real
 * result -- the exact same "the system knew and nobody was told" shape as
 * everything else covered by this file, just one field over from id/
 * status/variant. The category-membership test below is what makes this
 * impossible to reintroduce silently.
 *
 * diagnostics-registry-scanner-cannot-see-named-collector-functions,
 * 2026-09-09: a check's diagOk/Fail/Warn() calls don't have to live
 * textually inside the handler to belong to it. The two functions named
 * in NAMED_COLLECTOR_FUNCTION_NAMES above used to be invisible here, so
 * the scanner reported their locale entries as stale even when the code
 * plainly emitted them. The design call here (god's, not re-litigated):
 * extend the scanner to understand named collectors, not inline the
 * calls back into the handler and lose the pure-function testability
 * that was the whole point of extracting them.
 *
 * Deliberately regex-based and positional, not a full parse -- same
 * reasoning as errorCodeRegistry.test.js's CODE_LITERAL_RE: narrow enough
 * not to need @babel/parser, and it keeps every id/status/variant this
 * test can see grep-able as a literal in the source, same discipline
 * server/utils/errorCodes.js documents for `code:` values.
 *
 * A COMPUTED variant is invisible here BY DESIGN, and has shown up in three
 * different spellings while building this file -- watch for all three when
 * adding a new check, not just the first one you happen to remember:
 *   1. A ternary:            variant: isLinux ? "linux" : "windows"
 *   2. A template literal:   variant: `${direction}_${platform}`
 *   3. Trusting a shared LABEL instead of the actual id+status call site --
 *      not a variant-construction bug exactly, but the same root failure:
 *      two genuinely different messages (e.g. db.backup's "unreadable" and
 *      "error" scenarios) can share identical English label text, so
 *      grouping by (id, status, label) instead of by call site silently
 *      collapses two entries into one.
 * All three are fixed the same way: write out separate if/else branches,
 * each with its own literal `variant: "..."` string, and verify by grepping
 * every diagOk/diagFail/diagWarn/diagSkip/diagInfo call for a given id
 * BEFORE writing any locale JSON -- see the comment above the installPath
 * and jre call sites in debug.js for a worked example.
 */
function extractDiagnosticsChecks(source) {
  const startMarker = 'router.get("/diagnostics"';
  const endMarker = 'router.get("/worldmap"';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    throw new Error(
      "Could not locate the GET /diagnostics ... GET /worldmap boundaries in debug.js -- " +
        "this test's scan range depends on both route registrations staying literal strings.",
    );
  }
  const handlerSource = source.slice(start, end);

  // Fold each named collector's own body into the source this function
  // scans, but only for names the handler actually calls -- so a
  // collector that stops being used (or is renamed) is caught by the "was
  // found in the handler" sanity check below rather than silently still
  // contributing stale entries.
  const namedCollectorBodies = [];
  for (const name of NAMED_COLLECTOR_FUNCTION_NAMES) {
    const calledRe = new RegExp(`\\b${name}\\s*\\(`);
    if (!calledRe.test(handlerSource)) {
      throw new Error(
        `NAMED_COLLECTOR_FUNCTION_NAMES lists "${name}" but the /diagnostics handler never calls ` +
          `it -- renamed, removed, or no longer used. Update NAMED_COLLECTOR_FUNCTION_NAMES.`,
      );
    }
    const body = extractNamedFunctionBody(source, name);
    if (!body) {
      throw new Error(
        `NAMED_COLLECTOR_FUNCTION_NAMES lists "${name}" but no top-level function declaration for ` +
          `it was found anywhere in debug.js.`,
      );
    }
    namedCollectorBodies.push(body);
  }
  const effectiveSource = namedCollectorBodies.length
    ? `${handlerSource}\n${namedCollectorBodies.join("\n")}`
    : handlerSource;

  const CALL_RE = /diag(Ok|Fail|Warn|Skip|Info)\(\s*"([^"]+)"/g;
  const calls = [];
  let m;
  while ((m = CALL_RE.exec(effectiveSource))) {
    calls.push({ index: m.index, status: m[1].toLowerCase(), id: m[2] });
  }

  const VARIANT_RE = /variant:\s*"([^"]+)"/g;
  const variantOccurrences = [];
  while ((m = VARIANT_RE.exec(effectiveSource))) {
    variantOccurrences.push({ index: m.index, variant: m[1] });
  }

  const CATEGORY_RE = /category:\s*"([^"]+)"/g;
  const categories = new Set();
  while ((m = CATEGORY_RE.exec(effectiveSource))) {
    categories.add(m[1]);
  }

  // Attach each variant literal to the nearest preceding diag*() call --
  // reliable here because `variant:` only ever appears inside the options
  // object of the call it belongs to, which starts after that call's id.
  const callIndicesWithVariant = new Set();
  const withVariant = new Set(); // "id::status::variant"
  for (const v of variantOccurrences) {
    let owner = null;
    for (const call of calls) {
      if (call.index <= v.index && (!owner || call.index > owner.index)) owner = call;
    }
    if (!owner) {
      throw new Error(
        `Found a variant: "${v.variant}" literal in the /diagnostics handler with no preceding ` +
          `diagOk/diagFail/diagWarn/diagSkip/diagInfo call to attach it to (offset ${v.index}).`,
      );
    }
    callIndicesWithVariant.add(owner.index);
    withVariant.add(`${owner.id}::${owner.status}::${v.variant}`);
  }

  // A call requires a PLAIN (non-variant) locale entry only if that
  // specific call site has no variant of its own -- a call whose id+status
  // is ONLY ever emitted with a variant (e.g. server.jre's "warn", always
  // linux or windows) must never demand a plain entry that was never written.
  const plain = new Set(); // "id::status"
  for (const call of calls) {
    if (!callIndicesWithVariant.has(call.index)) {
      plain.add(`${call.id}::${call.status}`);
    }
  }

  return { plain, withVariant, categories };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function looksLikeCheckLeaf(node) {
  return (
    node &&
    typeof node === "object" &&
    !Array.isArray(node) &&
    (typeof node.label === "string" || typeof node.message === "string")
  );
}

/**
 * Flattens debug.json's diagnostics.checks tree back into the same
 * "id::status" / "id::status::variant" shape extractDiagnosticsChecks()
 * produces from source, so the two can be diffed directly in both
 * directions. Check ids are recovered from the id-path segments walked to
 * reach a known status name (ok/fail/warn/skip/info); a variant is any
 * sibling of label/message/hint under a status node that itself looks like
 * a check leaf (installPath's "fail" node has both its own label/message
 * for the "missing" case AND nested netMount/local variant leaves -- this
 * walk records all three).
 */
function flattenLocaleChecks(checksNode) {
  const plain = new Map(); // "id::status" -> entry
  const withVariant = new Map(); // "id::status::variant" -> entry

  function walk(node, idSegments) {
    for (const [key, value] of Object.entries(node)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;

      if (STATUS_NAMES.has(key)) {
        const id = idSegments.join(".");
        if (looksLikeCheckLeaf(value)) {
          plain.set(`${id}::${key}`, value);
        }
        for (const [variantKey, variantValue] of Object.entries(value)) {
          if (variantKey === "label" || variantKey === "message" || variantKey === "hint") continue;
          if (looksLikeCheckLeaf(variantValue)) {
            withVariant.set(`${id}::${key}::${variantKey}`, variantValue);
          }
        }
      } else {
        walk(value, [...idSegments, key]);
      }
    }
  }

  walk(checksNode, []);
  return { plain, withVariant };
}

function loadChecksNode(localePath) {
  const raw = JSON.parse(fs.readFileSync(localePath, "utf8"));
  const checks = { ...(raw?.diagnostics?.checks ?? {}) };
  // The "worldmap" branch belongs to GET /worldmap, scanned and enforced
  // separately by server/tests/worldMapCheckRegistry.test.js -- it shares
  // this same locale file/tree (translateDiagnosticCheck() hardcodes the
  // "debug" namespace and "diagnostics.checks" prefix for every check id,
  // worldmap.* included, so there's no separate file to put it in) but this
  // test's source scan deliberately stops at `router.get("/worldmap")` and
  // will never see a worldmap.* id -- so it must not treat that branch as
  // stale here either. Delete it before flattening so the two tests' id
  // sets never overlap or collide.
  delete checks.worldmap;
  return checks;
}

const debugJsSource = fs.readFileSync(DEBUG_JS_PATH, "utf8");
const source = extractDiagnosticsChecks(debugJsSource);
const diagCategoryKeys = extractDiagCategoryKeys(debugJsSource);
const en = flattenLocaleChecks(loadChecksNode(EN_DEBUG_JSON_PATH));
const fr = flattenLocaleChecks(loadChecksNode(FR_DEBUG_JSON_PATH));

describe("diagnostics check locale registry (self-enforcing, mirrors errorCodeRegistry.test.js)", () => {
  it("found at least the checks batches 1 and 2 are known to have added (sanity check on the scan itself)", () => {
    // If this fails, the regex/boundary scan broke, not the translations --
    // fix extractDiagnosticsChecks() before trusting any other test below.
    expect(source.plain.has("server.process::ok")).toBe(true);
    expect(source.withVariant.has("server.installPath::fail::netMount")).toBe(true);
    expect(source.withVariant.has("server.jre::warn::linux")).toBe(true);
  });

  // diagnostics-registry-scanner-cannot-see-named-collector-functions,
  // 2026-09-09: the actual regression this card exists to fix -- these two
  // ids are built entirely inside buildThumbnailResolutionCheck() /
  // buildRconCommandRejectionsCheck(), physically outside the handler's own
  // [start, end) text. If NAMED_COLLECTOR_FUNCTION_NAMES or
  // extractNamedFunctionBody() regresses, this is the test that catches it.
  it("sees every check emitted by a named collector function, not just calls textually inside the handler", () => {
    expect(source.withVariant.has("mods.thumbnailResolution::warn::statusUnavailable")).toBe(true);
    expect(source.withVariant.has("mods.thumbnailResolution::ok::allResolvingSome")).toBe(true);
    expect(source.withVariant.has("mods.thumbnailResolution::ok::allResolvingNone")).toBe(true);
    expect(source.withVariant.has("mods.thumbnailResolution::warn::someFailing")).toBe(true);
    expect(source.plain.has("mods.thumbnailResolution::fail")).toBe(true);
    expect(source.withVariant.has("rcon.commandRejections::warn::statusUnavailable")).toBe(true);
    expect(source.plain.has("rcon.commandRejections::ok")).toBe(true);
    expect(source.withVariant.has("rcon.commandRejections::warn::someRejected")).toBe(true);
  });

  // The failure to fear here is a scanner that PASSES WHILE SEEING LESS
  // than it used to -- a regression in extractNamedFunctionBody() or the
  // boundary scan could easily make one of these true by accident while
  // still reporting green everywhere else. Deliberately checks an id the
  // scanner already handled BEFORE this fix (a plain, boundary-inside
  // call), not one of the two new ones -- proving the new capability works
  // says nothing about whether the old one still does.
  it("still catches an id it already handled before this fix, not just the newly-visible ones", () => {
    expect(source.plain.has("server.process::ok")).toBe(true);
    expect(en.plain.get("server.process::ok")).toBeTruthy();
  });

  // rcon-command-rejections-check-has-never-rendered-in-any-language,
  // 2026-09-09: a check's `category` value is only ever read at render
  // time (Debug.tsx groups by category===catKey over DIAG_CATEGORIES'
  // keys) -- there is no server-side error, no client-side error, nothing
  // in either locale-completeness check above, if a category simply isn't
  // one of those keys. The check runs, computes a real result, and is
  // filtered out before any human sees it. This is the test that turns
  // that specific invisible mistake into a red one the moment it happens.
  //
  // Do NOT "fix" a failure here by adding the offending value to
  // DIAG_CATEGORIES -- that is how six categories stop meaning anything.
  // A check whose subject genuinely doesn't fit services/bridge/server/
  // storage/runtime/updates is a design question, not a red-test-clearing
  // exercise.
  it("every emitted check category is a real DIAG_CATEGORIES key", () => {
    const orphans = [...source.categories].filter((c) => !diagCategoryKeys.has(c));
    expect(orphans, `categories with no DIAG_CATEGORIES entry: ${orphans.join(", ")}`).toEqual([]);
  });

  for (const id of KNOWN_TRANSLATED_IDS) {
    describe(`"${id}" (in KNOWN_TRANSLATED_IDS)`, () => {
      const plainForId = [...source.plain].filter((key) => key.startsWith(`${id}::`));
      const variantForId = [...source.withVariant].filter((key) => key.startsWith(`${id}::`));

      if (plainForId.length === 0 && variantForId.length === 0) {
        it("was found in the /diagnostics handler at all", () => {
          throw new Error(
            `KNOWN_TRANSLATED_IDS lists "${id}" but no diagOk/diagFail/diagWarn/diagSkip/diagInfo ` +
              `call for it was found in the /diagnostics handler -- renamed, removed, or the id ` +
              `string in source no longer matches. Update KNOWN_TRANSLATED_IDS or the source.`,
          );
        });
      }

      for (const key of plainForId) {
        it(`${key} has complete en and fr entries`, () => {
          const enEntry = en.plain.get(key);
          const frEntry = fr.plain.get(key);
          expect(enEntry, `client/src/locales/en/debug.json is missing diagnostics.checks.${key.replace(/::/g, ".")}`).toBeTruthy();
          expect(frEntry, `client/src/locales/fr/debug.json is missing diagnostics.checks.${key.replace(/::/g, ".")}`).toBeTruthy();
          expect(isNonEmptyString(enEntry?.label)).toBe(true);
          expect(isNonEmptyString(enEntry?.message)).toBe(true);
          expect(isNonEmptyString(frEntry?.label)).toBe(true);
          expect(isNonEmptyString(frEntry?.message)).toBe(true);
        });
      }

      for (const key of variantForId) {
        it(`${key} has complete en and fr entries`, () => {
          const enEntry = en.withVariant.get(key);
          const frEntry = fr.withVariant.get(key);
          const dotted = key.replace(/::/g, ".");
          expect(enEntry, `client/src/locales/en/debug.json is missing diagnostics.checks.${dotted}`).toBeTruthy();
          expect(frEntry, `client/src/locales/fr/debug.json is missing diagnostics.checks.${dotted}`).toBeTruthy();
          expect(isNonEmptyString(enEntry?.label)).toBe(true);
          expect(isNonEmptyString(enEntry?.message)).toBe(true);
          expect(isNonEmptyString(frEntry?.label)).toBe(true);
          expect(isNonEmptyString(frEntry?.message)).toBe(true);
        });
      }
    });
  }

  // The half people forget: a locale entry that no longer corresponds to
  // anything the handler can emit. Unconditional -- applies to every
  // check.* entry in either locale file, not just KNOWN_TRANSLATED_IDS,
  // because a stale entry is stale regardless of whether its id was ever
  // formally "done".
  describe("no stale locale entries (check removed or renamed in source, translation left behind)", () => {
    it("every en debug.json diagnostics.checks entry (plain) still exists in the handler", () => {
      const stale = [...en.plain.keys()].filter((key) => !source.plain.has(key));
      expect(stale, `stale en entries: ${stale.join(", ")}`).toEqual([]);
    });
    it("every en debug.json diagnostics.checks entry (variant) still exists in the handler", () => {
      const stale = [...en.withVariant.keys()].filter((key) => !source.withVariant.has(key));
      expect(stale, `stale en variant entries: ${stale.join(", ")}`).toEqual([]);
    });
    it("every fr debug.json diagnostics.checks entry (plain) still exists in the handler", () => {
      const stale = [...fr.plain.keys()].filter((key) => !source.plain.has(key));
      expect(stale, `stale fr entries: ${stale.join(", ")}`).toEqual([]);
    });
    it("every fr debug.json diagnostics.checks entry (variant) still exists in the handler", () => {
      const stale = [...fr.withVariant.keys()].filter((key) => !source.withVariant.has(key));
      expect(stale, `stale fr variant entries: ${stale.join(", ")}`).toEqual([]);
    });
  });

  // en/fr must agree on which (id,status[,variant]) combinations exist,
  // independent of whether the source still emits them -- a translation
  // added to only one language is worse than missing, it's silently
  // asymmetric (French falls back to English sometimes, English never does).
  it("en and fr define exactly the same set of plain check entries", () => {
    const enOnly = [...en.plain.keys()].filter((key) => !fr.plain.has(key));
    const frOnly = [...fr.plain.keys()].filter((key) => !en.plain.has(key));
    expect(enOnly, `in en only: ${enOnly.join(", ")}`).toEqual([]);
    expect(frOnly, `in fr only: ${frOnly.join(", ")}`).toEqual([]);
  });

  it("en and fr define exactly the same set of variant check entries", () => {
    const enOnly = [...en.withVariant.keys()].filter((key) => !fr.withVariant.has(key));
    const frOnly = [...fr.withVariant.keys()].filter((key) => !en.withVariant.has(key));
    expect(enOnly, `in en only: ${enOnly.join(", ")}`).toEqual([]);
    expect(frOnly, `in fr only: ${frOnly.join(", ")}`).toEqual([]);
  });
});

// mods.resolved per-ID triage (mods-unresolved-2026-08-31): classifies WHY
// each unresolved Mods= entry failed instead of leaving the operator with a
// bare list. Mirrors the sibling mods.orphanWorkshop triage's own test
// coverage expectations -- one case per cause, plus the ordering rule that a
// typo match wins even when a Steam operation happens to be active too.
describe("triageUnresolvedMods (mods.resolved per-ID triage)", () => {
  describe("levenshteinDistance", () => {
    it("is 0 for identical strings and the length for one empty string", () => {
      expect(levenshteinDistance("abc", "abc")).toBe(0);
      expect(levenshteinDistance("", "abc")).toBe(3);
      expect(levenshteinDistance("abc", "")).toBe(3);
    });
    it("counts a single substitution as distance 1", () => {
      expect(levenshteinDistance("Footprint", "Footprant")).toBe(1);
    });
  });

  describe("findNearMissTypo", () => {
    it("finds a one-character typo of an installed mod ID", () => {
      expect(findNearMissTypo("Footprnt", ["Footprint", "OtherMod"])).toBe(
        "Footprint",
      );
    });
    it("treats a pure case difference as a match", () => {
      expect(
        findNearMissTypo("quartermaster", ["Quartermaster", "OtherMod"]),
      ).toBe("Quartermaster");
    });
    it("does not match an installed ID that's merely similar-length but unrelated", () => {
      expect(findNearMissTypo("Quartermaster", ["Footprint"])).toBeNull();
    });
    it("scales its threshold with ID length so a single slip in a long ID still counts as near", () => {
      expect(
        findNearMissTypo("RepairAnyClothesSearchModeAPI42", [
          "RepairAnyClothesSearchModeAPI41",
        ]),
      ).toBe("RepairAnyClothesSearchModeAPI41");
    });
    it("returns null when the ID isn't close to anything installed", () => {
      expect(findNearMissTypo("TotallyUnrelatedModId", ["Footprint"])).toBeNull();
    });
  });

  describe("triageUnresolvedMods", () => {
    it("classifies a near-miss typo even while a Steam operation is active (typo wins)", () => {
      const result = triageUnresolvedMods(
        ["Footprnt"],
        ["Footprint"],
        { steamOperationActive: true, anyWorkshopMissingFromDisk: true },
      );
      expect(result).toEqual([
        { modId: "Footprnt", cause: "typo", suggestion: "Footprint" },
      ]);
    });
    it("classifies stillDownloading when a Steam operation is active and there's no typo match", () => {
      const result = triageUnresolvedMods(
        ["Quartermaster"],
        ["SomeOtherMod"],
        { steamOperationActive: true, anyWorkshopMissingFromDisk: false },
      );
      expect(result).toEqual([
        { modId: "Quartermaster", cause: "stillDownloading" },
      ]);
    });
    it("classifies workshopNotOnDisk when nothing is downloading but a WorkshopItems= folder is missing", () => {
      const result = triageUnresolvedMods(
        ["RepairAnyClothesSearchModeAPI41"],
        ["SomeOtherMod"],
        { steamOperationActive: false, anyWorkshopMissingFromDisk: true },
      );
      expect(result).toEqual([
        {
          modId: "RepairAnyClothesSearchModeAPI41",
          cause: "workshopNotOnDisk",
        },
      ]);
    });
    it("classifies absent when there's no typo, no active download, and nothing missing from disk", () => {
      const result = triageUnresolvedMods(
        ["TotallyMadeUpModId"],
        ["SomeOtherMod"],
        { steamOperationActive: false, anyWorkshopMissingFromDisk: false },
      );
      expect(result).toEqual([{ modId: "TotallyMadeUpModId", cause: "absent" }]);
    });
  });
});
