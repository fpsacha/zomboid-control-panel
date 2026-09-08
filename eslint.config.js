import js from "@eslint/js";
import globals from "globals";
import requireResultHandling from "./eslint-rules/require-result-handling.js";
import noFailOpenCheckServerRunning from "./eslint-rules/no-fail-open-check-server-running.js";

export default [
  {
    ignores: [
      "node_modules/**",
      "client/**",
      "dist/**",
      "build/**",
      "release/**",
      "coverage/**",
      "pz-mod/**",
      "*.cjs",
    ],
  },
  {
    files: ["server/**/*.js", "eslint-rules/**/*.js", "*.js"],
    plugins: {
      local: {
        rules: {
          "require-result-handling": requireResultHandling,
          "no-fail-open-check-server-running": noFailOpenCheckServerRunning,
        },
      },
    },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
        // Injected by esbuild at build time; guarded with typeof at runtime.
        PANEL_VERSION: "readonly",
        PANEL_BUILD_SHA: "readonly",
        PANEL_API_CONTRACT_VERSION: "readonly",
        PANEL_BRIDGE_LUA_B64: "readonly",
        PANEL_CLIENT_DIST_B64: "readonly",
      },
    },
    rules: {
      ...js.configs.recommended.rules,

      // Much of this codebase reports failure by returning { success: false }
      // rather than by throwing, so a discarded result is a swallowed error.
      "local/require-result-handling": "error",

      // checkServerRunning() collapses a failed detection scan into `false`,
      // indistinguishable from confirmed-stopped -- every destructive-op
      // guard that used it was migrated to getServerProcessDetails() instead.
      // See the rule file's own header for the three audited exceptions.
      "local/no-fail-open-check-server-running": "error",

      // Control chars in regexes are deliberate input sanitization (RCON args,
      // player names, PanelBridge payloads).
      "no-control-regex": "off",

      "no-unused-vars": [
        "warn",
        {
          args: "after-used",
          argsIgnorePattern: "^(_|next$|serverName$|reason$|skipLog$)",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],

      // Triaged 2026-08-04: the one real race (server wipe guard) is fixed.
      // The rest are per-request/per-socket objects and function-local
      // variables, which this rule reports as false positives.
      "require-atomic-updates": "off",

      // Escaping `-` and `[` inside character classes is deliberate defensive
      // style here; rewriting 20 working regexes would risk real bugs.
      "no-useless-escape": "off",

      "no-empty": ["warn", { allowEmptyCatch: false }],
      "no-fallthrough": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-unsafe-optional-chaining": "error",
      "no-self-compare": "error",
      "no-template-curly-in-string": "warn",
      "no-unmodified-loop-condition": "error",
      // Express handlers and service interfaces intentionally remain async,
      // including paths that do not await on every code path.
      "require-await": "off",
    },
  },
  {
    // Test doubles must match the awaited interface they stand in for, so an
    // async stub with no await inside is correct here.
    files: ["server/tests/**/*.js"],
    rules: {
      // A test calls these for their effect on a stub, not for the result.
      "local/require-result-handling": "off",
      // Tests legitimately call checkServerRunning() to exercise the method
      // itself (serverManager.test.js) or build a fake serverManager a
      // route's own guard reads -- the fail-open risk this rule guards
      // against only exists in production call sites that GATE on the
      // result without checking scanFailed.
      "local/no-fail-open-check-server-running": "off",
      "require-await": "off",
      // Test doubles often mirror a wider production interface than the
      // assertion needs, so unused parameters/imports are not useful here.
      "no-unused-vars": "off",
      "no-template-curly-in-string": "off",
    },
  },
];
