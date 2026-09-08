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
 * By 2026-09-08 the fix left exactly three live calls to
 * checkServerRunning() anywhere in server/ -- both audited in full and
 * confirmed non-gating (rcon.js's two, purely advisory logging/hints; every
 * branch still attempts the real connection regardless) or already
 * fail-closed on its own terms (debug.js's fallback, read-only diagnostics
 * only). This rule is what keeps that "zero fail-open call sites" fact an
 * enforced invariant instead of a fact that was true once: every OTHER
 * grep hit in server/ today is a comment documenting an already-fixed
 * site, and a thirteenth genuine new call would have been one more comment
 * for a human to skim past. A new call anywhere not on this allowlist
 * fails the gate immediately, naming the convention to use instead.
 *
 * ALLOWLIST_UPDATE_POLICY: adding an entry here is not a formality -- it
 * means someone read the new call site in full and confirmed (a) it does
 * not gate a destructive action on the result, or (b) it already converts
 * an ambiguous/failed scan into a fail-closed outcome itself, the same bar
 * this file's own header describes. State which of the two in `reason`.
 */

const ALLOWLIST = [
  {
    file: "server/services/rcon.js",
    line: 507,
    reason:
      "Advisory only -- the boolean only selects which log line is printed ('attempting connection' vs 'probing RCON port anyway'); the real RCON connection attempt happens unconditionally right after, in every branch.",
  },
  {
    file: "server/services/rcon.js",
    line: 898,
    reason:
      "Advisory only -- true/false/error/timeout all fall through to the same 'attempt the real connection anyway' path; the boolean only sets a soft this.connected hint and picks a debug log line.",
  },
  {
    file: "server/routes/debug.js",
    line: 2517,
    reason:
      "Already fail-closed on its own terms: getServerProcessState()'s fallback branch converts anything that isn't a real boolean into { running: null, scanFailed: true } before returning, and its only two callers are both read-only diagnostics routes in this same file -- nothing destructive is gated on the result.",
  },
];

function normalize(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow new checkServerRunning() call sites outside the audited allowlist -- it fails open on a failed detection scan",
    },
    schema: [],
    messages: {
      failOpen:
        "checkServerRunning() collapses a FAILED process-detection scan into `false` -- indistinguishable from a confirmed-stopped server. Use serverManager.getServerProcessDetails() instead and check its `scanFailed` field explicitly, failing closed (refuse/503) when detection itself couldn't tell. If this call site is genuinely non-gating (like rcon.js's two) or already reconstructs scanFailed itself (like debug.js's fallback), add it to ALLOWLIST in eslint-rules/no-fail-open-check-server-running.js with a stated reason -- do not silence this with an eslint-disable comment.",
    },
  },

  create(context) {
    const filename = normalize(context.filename ?? context.getFilename());

    return {
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;
        const property = node.callee.property;
        if (property.type !== "Identifier" || property.name !== "checkServerRunning") {
          return;
        }

        const line = node.loc.start.line;
        const allowed = ALLOWLIST.some(
          (entry) => filename.endsWith(entry.file) && entry.line === line,
        );
        if (allowed) return;

        context.report({ node, messageId: "failOpen" });
      },
    };
  },
};
