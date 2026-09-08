import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { RuleTester } from "eslint";
import rule from "../../eslint-rules/no-fail-open-check-server-running.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");

// god's explicit condition on this whole card: "Verify it BOTH WAYS: it must
// pass on main as-is, AND actually fire when you add a fourth call. A rule
// that has never been seen to fail is not a rule -- we already found three
// node:test files tonight that were run by NOTHING."
//
// First draft of this rule kept a central (file, line) allowlist -- rejected
// after god's follow-up: a position-keyed reference decays the moment
// anyone inserts a line above a known-safe site, and the decay fails safe
// (flagged, not silently waved through) but still turns the gate red for a
// non-problem. Switched to `eslint-disable-next-line` at each real call
// site instead -- it moves with the code, and a second unaudited call added
// anywhere else (including right next to an already-disabled one) is still
// caught, since the disable comment only covers the one line below it.
//
// That mechanism swaps one decay risk for a DIFFERENT one this file's
// second describe block exists to catch: the comment surviving a refactor
// that moved or removed the call it was meant to cover, silently going
// stale. RuleTester alone can't see that -- it only proves the rule's own
// logic, not that the real files still look the way the rule assumes.

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: "module" },
});

describe("no-fail-open-check-server-running (rule logic, via RuleTester)", () => {
  it("flags every call site with no suppression -- there is no central allowlist to fall back on", () => {
    ruleTester.run("no-fail-open-check-server-running", rule, {
      valid: [],
      invalid: [
        {
          code: "const running = await serverManager.checkServerRunning();",
          errors: [{ messageId: "failOpen" }],
        },
        // Same shape as a real allowlisted site, but with NO disable
        // comment -- proves the rule has no memory of file/line at all
        // anymore, only of the comment directly above the call.
        {
          code: "const isRunning = await this.serverManager.checkServerRunning();",
          filename: "server/services/rcon.js",
          errors: [{ messageId: "failOpen" }],
        },
      ],
    });
  });

  // RuleTester registers whatever rule you pass it internally as
  // "rule-to-test/<name>" regardless of the name string given to
  // ruleTester.run() -- that internal name, not the real project's
  // "local/..." plugin prefix, is what an inline eslint-disable comment
  // must reference for RuleTester to honor it. The real source files use
  // "local/..." (matching eslint.config.js's actual plugin registration);
  // only this in-memory test needs the different, RuleTester-specific name.
  const DISABLE_COMMENT_FOR_RULE_TESTER =
    "// eslint-disable-next-line rule-to-test/no-fail-open-check-server-running -- test reason\n";

  it("does not flag a call with a correctly-placed eslint-disable-next-line for this exact rule", () => {
    ruleTester.run("no-fail-open-check-server-running", rule, {
      valid: [
        {
          code:
            DISABLE_COMMENT_FOR_RULE_TESTER +
            "const running = await serverManager.checkServerRunning();",
        },
      ],
      invalid: [],
    });
  });

  it("a disable comment covers only the ONE line below it -- a second call right after is still caught", () => {
    ruleTester.run("no-fail-open-check-server-running", rule, {
      valid: [],
      invalid: [
        {
          code:
            DISABLE_COMMENT_FOR_RULE_TESTER +
            "const a = await serverManager.checkServerRunning();\n" +
            "const b = await serverManager.checkServerRunning();",
          errors: [{ messageId: "failOpen" }],
        },
      ],
    });
  });
});

// The mechanism above is only as good as the real files actually looking
// the way it assumes. Reads the two real source files directly (not a
// re-description of their content) and asserts each of the three known
// disable comments is immediately followed by a line that still contains
// an actual checkServerRunning() call -- so a future refactor that moves,
// renames, or deletes one of these calls without touching its suppression
// comment fails HERE, by name, as "stale disable comment", rather than
// either silently leaving a dead comment behind or (worse) suppressing a
// completely different, unaudited call that happened to land on the same
// line.
describe("no-fail-open-check-server-running (decay check: the three real sites still match what the rule assumes)", () => {
  const DISABLE_COMMENT =
    "eslint-disable-next-line local/no-fail-open-check-server-running";

  function assertCommentImmediatelyPrecedesCall(filePath) {
    const fullPath = path.join(REPO_ROOT, filePath);
    const lines = fs.readFileSync(fullPath, "utf-8").split(/\r?\n/);
    const commentLineIndexes = [];
    lines.forEach((line, i) => {
      if (line.includes(DISABLE_COMMENT)) commentLineIndexes.push(i);
    });
    return { lines, commentLineIndexes };
  }

  it("rcon.js still has exactly two disable comments, each immediately followed by a checkServerRunning() call", () => {
    const { lines, commentLineIndexes } = assertCommentImmediatelyPrecedesCall(
      "server/services/rcon.js",
    );
    expect(commentLineIndexes).toHaveLength(2);
    for (const i of commentLineIndexes) {
      expect(lines[i + 1]).toMatch(/\.checkServerRunning\(\)/);
    }
  });

  it("debug.js still has exactly one disable comment, immediately followed by a checkServerRunning() call", () => {
    const { lines, commentLineIndexes } = assertCommentImmediatelyPrecedesCall(
      "server/routes/debug.js",
    );
    expect(commentLineIndexes).toHaveLength(1);
    expect(lines[commentLineIndexes[0] + 1]).toMatch(/\.checkServerRunning\(\)/);
  });

  // The reverse direction: every REAL checkServerRunning() call in these two
  // files must be immediately preceded by this exact disable comment -- so
  // a fourth, unaudited call added to either file (not just a brand-new
  // file) is caught here too, independent of what the real npm run
  // lint:server gate command would also catch.
  it("every checkServerRunning() call in rcon.js and debug.js is immediately preceded by the disable comment -- no uncovered calls slipped in", () => {
    for (const filePath of ["server/services/rcon.js", "server/routes/debug.js"]) {
      const fullPath = path.join(REPO_ROOT, filePath);
      const lines = fs.readFileSync(fullPath, "utf-8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!/\.checkServerRunning\(\)/.test(line)) return;
        expect(
          lines[i - 1],
          `${filePath}:${i + 1} calls checkServerRunning() with no disable comment on the line above`,
        ).toContain(DISABLE_COMMENT);
      });
    }
  });
});
