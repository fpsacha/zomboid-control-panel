import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../../eslint-rules/no-fail-open-check-server-running.js";

// god's explicit condition on this whole card: "Verify it BOTH WAYS: it must
// pass on main as-is, AND actually fire when you add a fourth call. A rule
// that has never been seen to fail is not a rule -- we already found three
// node:test files tonight that were run by NOTHING." RuleTester's `filename`
// option lets each case assert against the SAME allowlist the real rule
// ships with, rather than a re-description of it.

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: "module" },
});

// Pads `line` with leading blank lines so `code`'s own text lands at that
// exact line number -- real files, real line numbers, not a description of
// where they are. `line` is 1-indexed, matching ESLint's own loc.line.
function atLine(line, code) {
  return "\n".repeat(line - 1) + code;
}

describe("no-fail-open-check-server-running", () => {
  it("flags a new call site not on the allowlist", () => {
    ruleTester.run("no-fail-open-check-server-running", rule, {
      valid: [],
      invalid: [
        // The fourth call, anywhere not on the allowlist -- this is the
        // direction that matters most: a rule nobody has watched fail is
        // not a rule.
        {
          code: "const running = await serverManager.checkServerRunning();",
          filename: "server/routes/server.js",
          errors: [{ messageId: "failOpen" }],
        },
        // A brand-new file entirely.
        {
          code: "serverManager.checkServerRunning();",
          filename: "server/routes/chunks.js",
          errors: [{ messageId: "failOpen" }],
        },
      ],
    });
  });

  it("keys the allowlist on (file, line) TOGETHER, not file alone -- a second, unaudited call added anywhere else in an allowlisted file is still caught", () => {
    ruleTester.run("no-fail-open-check-server-running", rule, {
      valid: [],
      invalid: [
        {
          code: atLine(510, "const x = serverManager.checkServerRunning();"),
          filename: "server/services/rcon.js",
          errors: [{ messageId: "failOpen" }],
        },
        {
          code: atLine(1, "serverManager.checkServerRunning();"),
          filename: "server/routes/debug.js",
          errors: [{ messageId: "failOpen" }],
        },
      ],
    });
  });

  // The three sites currently on the allowlist, at their REAL recorded
  // lines -- proves the rule passes on `main` as it stands today, not just
  // in the abstract, and fails this test by name (not some other case in
  // the same run) if either file's line ever drifts without the allowlist
  // being updated to match.
  it("allows rcon.js's two real sites at their exact recorded lines (507, 898)", () => {
    ruleTester.run("no-fail-open-check-server-running", rule, {
      valid: [
        {
          code: atLine(
            507,
            "const isRunning = await this.serverManager.checkServerRunning();",
          ),
          filename: "server/services/rcon.js",
        },
        {
          code: atLine(
            898,
            "const checkPromise = this.serverManager.checkServerRunning();",
          ),
          filename: "server/services/rcon.js",
        },
      ],
      invalid: [],
    });
  });

  it("allows debug.js's one real site at its exact recorded line (2517)", () => {
    ruleTester.run("no-fail-open-check-server-running", rule, {
      valid: [
        {
          code: atLine(
            2517,
            "Promise.resolve().then(() => serverManager.checkServerRunning());",
          ),
          filename: "server/routes/debug.js",
        },
      ],
      invalid: [],
    });
  });
});
