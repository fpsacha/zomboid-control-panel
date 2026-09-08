import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 2026-09-08: Kevin found five `t(key, { defaultValue: '<hardcoded English
 * sentence>' })` calls in Settings.tsx (the `updates.rollbackFailed*` keys)
 * whose keys existed in NO locale file -- not even `en`. Every locale,
 * English included, bypassed i18next entirely and rendered the same
 * hardcoded English prose, spliced into an otherwise fully-translated page
 * at (arguably) the worst possible moment: reporting a failed update
 * rollback.
 *
 * The 3194-test parity suite passed the whole time, because parity compares
 * locales TO EACH OTHER. A key missing from all nine is perfectly
 * consistent -- the suite is structurally blind to an ABSENCE shared by
 * every locale, as opposed to a DIFFERENCE between them (which is what it
 * was built to catch, and does catch).
 *
 * `defaultValue` is exactly what made this invisible on screen too:
 * i18next never throws or logs on a missing key when a defaultValue is
 * supplied, and the fallback prose read as plausible, correctly-punctuated
 * English -- nothing about the RENDERED page looked broken. A bare
 * `t('typo.key')` with no defaultValue would at least show the raw key
 * string, which is ugly enough to get noticed and filed; this shape doesn't
 * even give you that.
 *
 * SCOPE, DELIBERATELY NARROW: only a `t(...)`-shaped call (any local
 * identifier resolved back to a `useTranslation(<literal namespace>)`
 * destructure -- see resolveNamespaceForCallee) whose KEY argument is a
 * static string literal. A dynamic key (a template literal or an
 * interpolated member/computed expression, e.g. RolesPermissions.tsx's
 * `t(\`capabilities.${cap.key}.label\`, { defaultValue: cap.label })`) is
 * left alone on purpose -- there both the key and the fallback are
 * genuinely data-driven (translate this specific capability if a
 * translation exists, else show its real label), a different and
 * legitimate progressive-enhancement pattern, not a one-off hardcoded
 * sentence that never made it into a locale file. Catching only the static
 * case is exactly Kevin's bug shape and avoids flagging that pattern.
 *
 * Checked against `en` specifically (not full 9-locale parity): en is the
 * source of truth this repo authors keys against first, and the actual
 * failure mode is "never added to ANY locale, en included" -- if a rule
 * required all nine, a key genuinely mid-translation (in en, not yet in the
 * other eight) would falsely trip it; the existing parity suite already
 * owns cross-locale consistency once a key exists in en.
 */

const RULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_EN_DIR = path.join(RULE_DIR, "..", "client", "src", "locales", "en");

// namespace -> parsed en/<namespace>.json, or null if it couldn't be read.
// Module-level cache: locale files don't change mid-lint-run, and this
// avoids re-reading/re-parsing the same JSON file for every t() call site
// in a namespace (Settings.tsx alone has hundreds).
const namespaceCache = new Map();

function loadNamespace(namespace) {
  if (namespaceCache.has(namespace)) return namespaceCache.get(namespace);
  let data = null;
  try {
    const raw = fs.readFileSync(path.join(LOCALES_EN_DIR, `${namespace}.json`), "utf8");
    data = JSON.parse(raw);
  } catch {
    data = null; // unknown/unreadable namespace -- can't verify, don't guess
  }
  namespaceCache.set(namespace, data);
  return data;
}

// i18next's default keySeparator is '.', unconfigured anywhere in this repo
// (grepped: no keySeparator/nsSeparator override) -- so a dotted key walks
// nested objects, matching how every locale JSON in this repo is actually
// shaped (verified against locales/en/settings.json's own updates.* nesting).
function resolveKey(namespaceData, dottedKey) {
  if (!namespaceData) return undefined;
  let cur = namespaceData;
  for (const part of dottedKey.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

// Same "lexical lookup, not full data-flow" idiom as
// no-raw-error-message.js's findVariableInScope -- deliberately only strong
// enough to resolve a destructured binding back to where it was declared.
function findVariableInScope(scope, name) {
  let current = scope;
  while (current) {
    const found = current.variables.find((v) => v.name === name);
    if (found) return found;
    current = current.upper;
  }
  return null;
}

// Resolve a t()-call callee (e.g. `t`, or an aliased `f` as Events.tsx
// uses) back to the i18next namespace it was bound to, by finding its
// declaring VariableDeclarator and checking whether its init is a
// literal-argument useTranslation(...) call. A file can (and does --
// Layout.tsx binds both 'shell' and 'scheduler') hold more than one
// useTranslation() call under different local names at different scopes;
// resolving from the actual call site's scope chain, not the file as a
// whole, is what keeps that correct.
function resolveNamespaceForCallee(context, calleeNode) {
  const scope = context.sourceCode.getScope(calleeNode);
  const variable = findVariableInScope(scope, calleeNode.name);
  if (!variable) return null;
  for (const def of variable.defs) {
    if (def.type !== "Variable" || def.node.type !== "VariableDeclarator") continue;
    const init = def.node.init;
    if (
      init &&
      init.type === "CallExpression" &&
      init.callee.type === "Identifier" &&
      init.callee.name === "useTranslation" &&
      init.arguments.length > 0 &&
      init.arguments[0].type === "Literal" &&
      typeof init.arguments[0].value === "string"
    ) {
      return init.arguments[0].value;
    }
  }
  return null;
}

function findDefaultValueProperty(objectExpression) {
  return objectExpression.properties.find(
    (p) =>
      p.type === "Property" &&
      !p.computed &&
      ((p.key.type === "Identifier" && p.key.name === "defaultValue") ||
        (p.key.type === "Literal" && p.key.value === "defaultValue")),
  );
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a static-key t(key, { defaultValue }) call whose key has no entry in the en locale namespace",
    },
    schema: [],
    messages: {
      orphanKey:
        "t(\"{{key}}\") carries a defaultValue but '{{key}}' has no entry in client/src/locales/en/{{namespace}}.json -- i18next never throws on a missing key when defaultValue is set, so EVERY locale (en included) silently renders the hardcoded fallback instead of a real translation. Add \"{{key}}\" to en/{{namespace}}.json (and the other locales) rather than leaving it as a fallback string. This is the exact updates.rollbackFailed* shape found in Settings.tsx on 2026-09-08 -- see this rule's file header.",
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "Identifier") return;

        const [keyArg, optionsArg] = node.arguments;
        if (!keyArg || keyArg.type !== "Literal" || typeof keyArg.value !== "string") return;
        if (!optionsArg || optionsArg.type !== "ObjectExpression") return;

        const defaultValueProp = findDefaultValueProperty(optionsArg);
        if (!defaultValueProp) return;

        const namespace = resolveNamespaceForCallee(context, callee);
        if (!namespace) return; // can't attribute this call to a real i18next namespace -- don't guess

        const namespaceData = loadNamespace(namespace);
        if (namespaceData === null) return; // namespace file unreadable -- don't guess

        const resolved = resolveKey(namespaceData, keyArg.value);
        if (typeof resolved === "string") return; // real leaf string exists in en -- fine

        context.report({
          node: keyArg,
          messageId: "orphanKey",
          data: { namespace, key: keyArg.value },
        });
      },
    };
  },
};
