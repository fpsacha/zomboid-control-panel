import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../../eslint-rules/require-result-handling.js";

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: "module" },
});

describe("require-result-handling", () => {
  it("flags only discarded results", () => {
    ruleTester.run("require-result-handling", rule, {
      valid: [
        "const r = await rcon.save(); if (!r.success) throw new Error(r.error);",
        "function f() { return rcon.quit(); }",
        "rcon.save().then((r) => r.success);",
        "void rcon.serverMessage('hi');",
        "await other.somethingElse();",
        "await rcon.save;",
      ],
      invalid: [
        {
          code: "await rcon.save();",
          errors: [{ messageId: "discarded" }],
        },
        {
          code: "this.rconService.quit();",
          errors: [{ messageId: "discarded" }],
        },
        {
          code: "async function f() { await serverManager.startServer(); }",
          errors: [{ messageId: "discarded" }],
        },
      ],
    });
  });
});
