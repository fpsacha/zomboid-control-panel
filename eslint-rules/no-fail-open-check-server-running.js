/**
 * checkServerRunning() collapses a FAILED process-detection scan into a
 * plain `false` -- indistinguishable from "confirmed stopped". Every
 * destructive-operation guard in server/ that used to call it (wipe,
 * delete-files, restore, chunks delete, templates apply, the
 * config-mutation guards, the auto-update/mod-restart schedulers) was
 * migrated to getServerProcessDetails() instead, which exposes scanFailed
 * so the caller can fail CLOSED (refuse) rather than silently treating "I
 * don't know" as "it's safe".
 *
 * By 2026-09-08 the fix left exactly three live calls to checkServerRunning()
 * anywhere in server/, all audited and confirmed safe (rcon.js's two,
 * purely advisory logging/hints -- every branch still attempts the real
 * connection regardless; debug.js's one, already fail-closed on its own
 * terms and read only by that file's own read-only diagnostics routes).
 * Every OTHER grep hit in server/ is a comment documenting an already-fixed
 * site, and a thirteenth genuine new call would have been one more comment
 * for a human to skim past.
 *
 * This rule flags EVERY call unconditionally -- there is no central
 * allowlist. A central (file, line) allowlist was tried first and rejected:
 * it decays the moment anyone inserts a line above a known-safe site, the
 * decay fails safe (flagged, not silently waved through) but still turns
 * the gate red for a non-problem, and a check that cries wolf gets
 * allowlisted wholesale by whoever is unblocking a release under pressure.
 * A reference that names a POSITION decays; one anchored to the code itself
 * does not. The three known-safe sites are marked in place with
 * `// eslint-disable-next-line local/no-fail-open-check-server-running --
 * <reason>` directly above the call -- the suppression moves with the code
 * if it's ever relocated, and the reason sits where the reader already is
 * instead of in a separate file they have to go find. A SECOND, unaudited
 * call added anywhere else in the same file (including right next to an
 * existing disabled one) is still caught, since the disable comment only
 * covers the one line directly below it.
 *
 * DISABLE_COMMENT_POLICY: adding one of these is not a formality -- it
 * means someone read the call site in full and confirmed either (a) it does
 * not gate a destructive action on the result, or (b) it already converts
 * an ambiguous/failed scan into a fail-closed outcome itself, the same bar
 * this file's own header describes. State which of the two in the comment's
 * own reason text, not just "safe".
 *
 * server/tests/eslintRuleNoFailOpenCheckServerRunning.test.js pins the
 * three real sites two ways: RuleTester proves the rule's own logic, and a
 * separate plain-text check proves each real file still carries BOTH the
 * disable comment and a checkServerRunning() call on the very next line --
 * catching decay (the comment surviving a refactor that removed or moved
 * the call it was meant to cover) as a named, specific test failure rather
 * than a silent gap or a confusing new-violation report.
 */

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a checkServerRunning() call site without an explicit, reasoned eslint-disable-next-line -- it fails open on a failed detection scan",
    },
    schema: [],
    messages: {
      failOpen:
        "checkServerRunning() collapses a FAILED process-detection scan into `false` -- indistinguishable from a confirmed-stopped server. Use serverManager.getServerProcessDetails() instead and check its `scanFailed` field explicitly, failing closed (refuse/503) when detection itself couldn't tell. If this call site is genuinely non-gating (like rcon.js's two) or already reconstructs scanFailed itself (like debug.js's fallback), suppress it with `// eslint-disable-next-line local/no-fail-open-check-server-running -- <reason>` directly above the call, stating which of the two applies and why -- see this rule's own file header for the full policy.",
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;
        const property = node.callee.property;
        if (property.type !== "Identifier" || property.name !== "checkServerRunning") {
          return;
        }

        context.report({ node, messageId: "failOpen" });
      },
    };
  },
};
