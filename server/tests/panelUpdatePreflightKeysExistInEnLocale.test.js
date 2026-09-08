import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 2026-09-08, the other half of the class closed by
// eslint-rules/no-orphan-translation-default.js: Kevin found
// `updates.preflight.diskSpaceUnknown` (and one more) rendering hardcoded
// English to every operator in every locale, en included, because it fell
// in the overlap of two otherwise-correct checks' blind spots:
//
//   - The 9-locale parity suite compares locales to EACH OTHER. A key
//     missing from all nine is perfectly consistent -- an ABSENCE, not a
//     difference, and the suite is structurally blind to it.
//   - no-orphan-translation-default.js catches a STATIC t(key, {defaultValue})
//     call site. Settings.tsx's actual call here is
//     `t(detail.key, { ...detail.params, defaultValue: message })` --
//     `detail.key` is RUNTIME DATA (translatePanelUpdateMessages() reads it
//     off panelUpdateChecker.js's blockerDetails/warningDetails/info
//     objects), not a string literal, so that rule correctly leaves it
//     alone -- flagging every dynamic key would also flag
//     RolesPermissions.tsx's legitimate per-capability fallback pattern,
//     which is exactly the false-positive that rule was built to avoid.
//
// Neither tool is wrong. The hole is that nothing checks the PRODUCER: what
// literal keys panelUpdateChecker.js is actually capable of emitting into
// that {key, params} shape, checked against en/settings.json directly.
//
// SCOPE (asked for a count before generalising): panelUpdateChecker.js is
// the ONLY producer of this shape anywhere server-side (grepped the whole
// server/ tree for the "updates.preflight." key prefix -- every other hit
// is one of this feature's own tests, not a second producer), and
// Settings.tsx's translatePanelUpdateMessages call is the ONLY dynamic-key
// t()+defaultValue consumer anywhere client-side outside the two already-
// audited legitimate-fallback shapes (RolesPermissions.tsx, Login.tsx) --
// see no-orphan-translation-default.js's own header for that sweep. One
// producer, one consumer; this does not need to generalise into anything
// broader.
//
// EXTRACTION APPROACH: deliberately NOT parsing addPreflightMessage(...)
// call arguments position-by-position. One real call site assigns the key
// to a local variable through a 3-way ternary
// (folderNotWritableWindows/Linux/Other) before passing it, and another
// passes a 2-way ternary inline (packagedBuildDocker/Git) -- either breaks
// a "read the 3rd argument" extractor outright. Worse, `info.dockerNotChecked`
// is built as a bare `{ key: "...", params, message }` object literal with
// no addPreflightMessage() call at all, and it's real -- Settings.tsx's
// translatePanelUpdateMessages translates it exactly the same way. Scanning
// the whole file for the fixed "updates.preflight.<name>" string-literal
// shape instead of the call syntax catches all three shapes uniformly, and
// keeps working if a fourth producer shape is added later without anyone
// having to touch this test.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRODUCER_PATH = path.join(HERE, "..", "services", "panelUpdateChecker.js");
const EN_SETTINGS_PATH = path.join(HERE, "..", "..", "client", "src", "locales", "en", "settings.json");

const KEY_PATTERN = /"(updates\.preflight\.[A-Za-z0-9]+)"/g;

function extractPreflightKeys(source) {
  const keys = new Set();
  for (const match of source.matchAll(KEY_PATTERN)) {
    keys.add(match[1]);
  }
  return [...keys].sort();
}

// i18next's default keySeparator ('.', unconfigured anywhere in this repo)
// walks nested objects -- same lookup no-orphan-translation-default.js uses.
function resolveKey(namespaceData, dottedKey) {
  let cur = namespaceData;
  for (const part of dottedKey.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

describe("panelUpdateChecker.js's preflight message keys all exist in en/settings.json", () => {
  it("every \"updates.preflight.*\" string literal in the producer resolves to a real string in en", () => {
    const source = fs.readFileSync(PRODUCER_PATH, "utf8");
    const keys = extractPreflightKeys(source);

    // Sanity floor, not a magic number -- proves the regex is actually
    // matching this file's real shape (ternary-assigned, inline-ternary,
    // and bare-object-literal keys all included) rather than silently
    // finding zero and passing vacuously. 19 is today's real count; this
    // only needs to stay comfortably below it forever.
    expect(keys.length).toBeGreaterThanOrEqual(15);

    const enSettings = JSON.parse(fs.readFileSync(EN_SETTINGS_PATH, "utf8"));

    const missing = keys.filter((key) => typeof resolveKey(enSettings, key) !== "string");
    expect(missing).toEqual([]);
  });
});
