// Shared resolution engine for the engine-signature checker (scripts/check-engine-signatures.mjs)
// and its manifest generator (scripts/gen-engine-signatures.mjs). BOTH run this exact code so the
// checker validates the same call sites, with the same variable-type resolution, that the generator
// used to decide which classes to javap. They differ only in how `classProvider` answers a
// (className, methodName) lookup: the generator backs it with live javap output; the checker backs
// it with the committed JSON manifest. See PanelBridge.lua's own PanelBridge.invoke/hasMethod/
// safeCall/safeGet/tryGet helpers (~line 605-678) for the call shapes this extracts.
//
// WHAT THIS DOES: extracts every (receiver-expression, method-name) pair PanelBridge.lua sends into
// the Java engine -- both through the five invoke-family helpers (method name is their 2nd argument,
// a string) and bare Lua `recv:method(...)` syntax used directly (no helper, no pcall) -- and, where
// the receiver's type can be traced back to a known engine class, checks whether that method exists.
//
// WHAT THIS DOES NOT DO: prove a PRESENT method is actually callable through PZ's Kahlua Lua<->Java
// binding (see the generator's own comment for why), resolve every receiver (dynamic method names,
// unseeded globals, and multi-branch control flow are left unresolved rather than guessed), or track
// real Lua scope (a variable name is assumed to hold the same type everywhere in the file -- true for
// every case observed in this file, false in general Lua).

const LONG_BRACKET_OPEN = /^\[(=*)\[/;

/**
 * Blank out `--` and `--[[ ]]` comments (replacing with spaces/newlines, so offsets and line
 * numbers are unchanged) while leaving string literals untouched -- we need the literal text of
 * string arguments (method-name literals) intact.
 */
export function stripLuaComments(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '"' || c === "'") {
      const quote = c;
      out.push(c);
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          out.push(src[i], src[i + 1]);
          i += 2;
          continue;
        }
        out.push(src[i]);
        i++;
      }
      if (i < n) {
        out.push(src[i]);
        i++;
      }
      continue;
    }
    if (c === '-' && c2 === '-') {
      const rest = src.slice(i + 2);
      const longMatch = LONG_BRACKET_OPEN.exec(rest);
      if (longMatch) {
        const eq = longMatch[1];
        const closer = `]${eq}]`;
        const closeIdx = src.indexOf(closer, i + 2 + longMatch[0].length);
        const end = closeIdx === -1 ? n : closeIdx + closer.length;
        for (let p = i; p < end; p++) out.push(src[p] === '\n' ? '\n' : ' ');
        i = end;
        continue;
      }
      let end = src.indexOf('\n', i);
      if (end === -1) end = n;
      for (let p = i; p < end; p++) out.push(' ');
      i = end;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

// 2026-08-31 bug hunt (scripts/**): the Pass-1 assignment regex below (`assignRe`) has no way to
// tell a real Lua assignment (`local cell = getWorld():getCell()`) apart from a TABLE CONSTRUCTOR
// FIELD of the same shape (`{ cell = someExpr, ... }`) -- its only precondition on the character
// before the identifier is "not `.` or a word character", which `{`, `,`, and plain whitespace all
// satisfy, and all three precede table fields constantly. A field whose value is itself a chain
// expression (not a string/number literal, which parseChainAt can't start from) gets recorded into
// `varTypes` exactly like a real assignment -- silently overwriting a REAL variable's correctly
// resolved type with whatever the field's value chain resolves to (frequently null, since return-
// value fields are rarely typed the same as an unrelated in-scope variable that happens to share
// its name). A later REAL use of that variable then walks from the wrong starting type and reports
// `chain-broke-before-end` -- SKIPPED, not checked -- even though the receiver's real type was
// already known moments earlier. Confirmed on the real PanelBridge.lua: 220 non-local `NAME = expr`
// matches collide with a real tracked local-variable name of the same spelling.
//
// Fix: track `{}` nesting depth (string-aware, using the same quote-skipping logic
// stripLuaComments already uses, since a brace inside a string literal must not count) across the
// whole comment-stripped source, and reject any assignRe match whose identifier sits inside an
// unclosed brace -- it's a table field, not a statement-level assignment.
export function computeTableConstructorDepths(src) {
  const depthAtOffset = new Int32Array(src.length + 1);
  let depth = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    depthAtOffset[i] = depth;
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) i += 2;
        else i++;
      }
      i++;
      continue;
    }
    if (c === '{') {
      depth++;
      i++;
      continue;
    }
    if (c === '}') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    i++;
  }
  depthAtOffset[n] = depth;
  return depthAtOffset;
}

/** Precomputed newline offsets so line-of-offset lookups are O(log n) instead of re-scanning. */
export function buildLineIndex(src) {
  const offsets = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

export function lineOfOffset(lineIndex, offset) {
  let lo = 0;
  let hi = lineIndex.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineIndex[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;
const WS = /\s/;

/**
 * Parse a postfix chain (Name ('(' args ')' | ':' Name '(' args ')' | '.' Name)*) starting exactly
 * at `startIdx`. Handles arbitrary depth (e.g. `getWorld():getCell():getGridSquare(x,y,z)`,
 * `item:getItem():getFullType()`) by walking forward and skipping balanced parens for call args
 * without parsing their contents (arg contents are re-parsed independently when THEY are visited as
 * their own chain starts, e.g. for helper receiver arguments -- see extractHelperCallSites).
 * Returns null if `startIdx` isn't the start of an identifier.
 */
export function parseChainAt(src, startIdx) {
  let i = startIdx;
  const n = src.length;
  if (!IDENT_START.test(src[i] || '')) return null;

  function skipWs() {
    while (i < n && WS.test(src[i])) i++;
  }
  function readIdent() {
    const s = i;
    while (i < n && IDENT_CHAR.test(src[i])) i++;
    return i > s ? src.slice(s, i) : null;
  }
  function skipBalancedParens() {
    // src[i] === '('
    let depth = 0;
    do {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    } while (i < n && depth > 0);
  }

  const firstName = readIdent();
  if (firstName === null) return null;
  let called = false;
  skipWs();
  if (src[i] === '(') {
    skipBalancedParens();
    called = true;
  }
  const steps = [{ sep: null, name: firstName, called, offset: startIdx }];

  for (;;) {
    const before = i;
    skipWs();
    if (src[i] === ':' || src[i] === '.') {
      const sep = src[i];
      const sepIdx = i;
      i++;
      skipWs();
      const nameOffset = i;
      const name = readIdent();
      if (name === null) {
        i = before;
        break;
      }
      let stepCalled = false;
      skipWs();
      if (src[i] === '(') {
        skipBalancedParens();
        stepCalled = true;
      }
      steps.push({ sep, name, called: stepCalled, offset: sepIdx, nameOffset });
      continue;
    }
    i = before;
    break;
  }
  return { steps, endIndex: i };
}

/** Scan the whole (comment-stripped) source for every top-level postfix chain. */
export function findAllChains(src) {
  const chains = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    if (IDENT_START.test(src[i])) {
      let p = i - 1;
      while (p >= 0 && (src[p] === ' ' || src[p] === '\t')) p--;
      const prevChar = p >= 0 ? src[p] : '';
      if (prevChar === '.' || prevChar === ':' || IDENT_CHAR.test(prevChar)) {
        i++;
        continue;
      }
      const result = parseChainAt(src, i);
      if (result) {
        chains.push(result);
        i = Math.max(result.endIndex, i + 1);
        continue;
      }
    }
    i++;
  }
  return chains;
}

/** Every ':name(' step in a chain is a real Lua method-call site (':' always implies a call). */
export function directCallStepsFromChain(chain) {
  const sites = [];
  for (let k = 1; k < chain.steps.length; k++) {
    const step = chain.steps[k];
    if (step.sep === ':' && step.called) {
      sites.push({ receiverSteps: chain.steps.slice(0, k), methodName: step.name, offset: step.nameOffset });
    }
  }
  return sites;
}

function findMatchingParen(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split the text between a call's outer parens into top-level (paren/bracket/brace/string aware) args. */
function splitTopLevelArgs(text) {
  const args = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  if (start < n || n === 0) args.push(text.slice(start));
  return args.map((s) => s.trim()).filter((s) => s.length > 0);
}

const HELPER_NAMES = ['invoke', 'hasMethod', 'safeCall', 'safeGet', 'tryGet', 'invokeOnceIfAbsent'];
const HELPER_CALL_RE = new RegExp(`PanelBridge\\.(${HELPER_NAMES.join('|')})\\s*\\(`, 'g');

/**
 * Extract every PanelBridge.<invoke|hasMethod|safeCall|safeGet|tryGet>(receiver, "methodName", ...)
 * call site. `receiver` is parsed as its own chain (it can itself be a multi-hop expression, though
 * in this file it is always a bare local variable). `methodName` is only captured when it's a
 * string literal -- a dynamic (variable) method-name argument is reported as unresolvable, never
 * guessed.
 */
export function extractHelperCallSites(src) {
  const sites = [];
  let m;
  HELPER_CALL_RE.lastIndex = 0;
  while ((m = HELPER_CALL_RE.exec(src))) {
    const helperName = m[1];
    const openIdx = HELPER_CALL_RE.lastIndex - 1;
    const closeIdx = findMatchingParen(src, openIdx);
    if (closeIdx === -1) continue;
    const argsText = src.slice(openIdx + 1, closeIdx);
    const args = splitTopLevelArgs(argsText);
    if (args.length < 2) continue;
    const receiverText = args[0];
    const methodArgText = args[1];
    const litMatch = /^["']([A-Za-z_]\w*)["']$/.exec(methodArgText);
    sites.push({
      kind: 'helper',
      helperName,
      startOffset: m.index,
      receiverText,
      methodNameLiteral: litMatch ? litMatch[1] : null,
      methodArgRaw: methodArgText,
      offset: openIdx,
    });
    HELPER_CALL_RE.lastIndex = closeIdx;
  }
  return sites;
}

/**
 * Hand-curated map of PZ global accessor functions (bare Lua globals injected by the engine, e.g.
 * `getWorld()`) to the Java class they return. Each entry is a CANDIDATE -- the generator verifies
 * it against the real jar (class exists) AND against a fingerprint of every method name this file
 * actually invokes on a variable assigned from that global (coverage must clear
 * MIN_SEED_FINGERPRINT_COVERAGE, see gen-engine-signatures.mjs) before trusting it. A seed that
 * fails verification is dropped, not forced -- see that script's report for what got rejected.
 */
export const SEED_GLOBALS = {
  getWorld: { class: 'zombie.iso.IsoWorld' },
  getClimateManager: { class: 'zombie.iso.weather.ClimateManager' },
  getGameTime: { class: 'zombie.GameTime' },
  getPlayerByUsername: { class: 'zombie.characters.IsoPlayer' },
  getSpecificPlayer: { class: 'zombie.characters.IsoPlayer' },
  getOnlinePlayers: { class: 'java.util.ArrayList', elementType: 'zombie.characters.IsoPlayer' },
  getSandboxOptions: { class: 'zombie.SandboxOptions' },
  getCell: { class: 'zombie.iso.IsoCell' },
  getZombiePopManager: { class: 'zombie.popman.ZombiePopulationManager' },
  getGameServer: { class: 'zombie.network.GameServer' },
};

/**
 * A handful of engine singletons are reached via a Java-style static accessor
 * (`GameTime.getInstance()`) rather than a bare Lua global -- same idea as SEED_GLOBALS (a
 * verified candidate, not a guess forced through), but the call syntax is `.` (Lua's plain
 * namespaced call) instead of `:` (self-call sugar), which resolveChainType special-cases for.
 * The two definition classes are static lookups (`CharacterTraitDefinition.
 * getCharacterTraitDefinition(trait)`), used by getCharacterSheet.
 */
export const STATIC_CLASS_SEEDS = {
  GameTime: 'zombie.GameTime',
  CharacterTraitDefinition: 'zombie.characters.traits.CharacterTraitDefinition',
  CharacterProfessionDefinition: 'zombie.characters.professions.CharacterProfessionDefinition',
};

const LUA_KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in', 'local',
  'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
]);

/**
 * Resolve every call site in the file: build a whole-file variable -> engine-class table from
 * `local NAME = EXPR` / `NAME = EXPR` assignments (single forward pass, so a variable's type is
 * whatever its most recent preceding assignment resolved to -- this file reuses names like
 * `player`/`climate`/`item` consistently for the same real type everywhere, so a single flat table
 * is sufficient; see the module doc comment for the known limitation this implies), then walk every
 * helper-wrapped and direct call site's receiver chain through `classProvider` to a final type.
 *
 * `classProvider(className, methodName)` must return either:
 *   - null                                          if className itself is unknown to the provider
 *   - { exists: false }                             if className is known but methodName is not on it
 *   - { exists: true, returnClass, elementClass }    if methodName exists (returnClass/elementClass
 *                                                     may be null when the return type isn't a
 *                                                     resolvable engine class, e.g. boolean/void/String)
 */
export function resolveAllCallSites(rawSrc, classProvider) {
  const src = stripLuaComments(rawSrc);
  const lineIndex = buildLineIndex(rawSrc);
  const tableDepth = computeTableConstructorDepths(src);
  const varTypes = new Map(); // name -> { type, elementType }

  // Every `PanelBridge.<helper>(...)` call site, indexed by the source offset of "PanelBridge" --
  // lets a chain that STARTS with one of these (e.g. the RHS of `local stats =
  // PanelBridge.tryGet(player, "getStats")`) be resolved as "whatever that call returns" rather
  // than as a plain `.`-namespaced field access (which correctly resolves to nothing, since
  // PanelBridge itself is never a `local` variable with a tracked engine type).
  const helperSites = extractHelperCallSites(src);
  const helperSitesByOffset = new Map(helperSites.map((s) => [s.startOffset, s]));

  /** Continue walking `:name(...)`/`.name` steps from an already-known (type, elementType). */
  function walkStepsFrom(steps, startIndex, currentType, elementType) {
    for (let k = startIndex; k < steps.length; k++) {
      const step = steps[k];
      if (step.sep === '.') {
        currentType = null;
        elementType = null;
        continue;
      }
      if (step.sep === ':' && step.called) {
        if (currentType == null) continue;
        // IMPORTANT: `get` is not special-cased into skipping the real lookup. A collection typed
        // as java.util.Set (no get(int) declared) must still be checked for real -- that is
        // exactly the class of bug this tool exists to catch (getVehicles() returning a Set with
        // no get(int), from the audit this tool replaces). The `elementType` hint (only ever set
        // by a seed or a manifest-derived generic return type, e.g. ArrayList<IsoPlayer>) is
        // applied ONLY after classProvider confirms the method genuinely exists.
        const info = classProvider(currentType, step.name);
        if (info && info.exists) {
          if (step.name === 'get' && elementType) {
            currentType = elementType;
            elementType = null;
          } else {
            currentType = info.returnClass || null;
            elementType = info.elementClass || null;
          }
        } else {
          currentType = null;
          elementType = null;
        }
      }
    }
    return { type: currentType, elementType, reason: currentType ? null : 'chain-broke-before-end' };
  }

  /** Resolve a `PanelBridge.<helper>(receiver, "method", ...)` call to the type its result holds. */
  function resolveHelperResultType(site) {
    if (!site.methodNameLiteral) return { type: null, elementType: null, reason: 'dynamic method name' };
    const receiverChain = parseChainAt(site.receiverText, 0);
    const receiverResolved = receiverChain
      ? walkStepsFrom(receiverChain.steps, 1, ...startState(receiverChain.steps[0]))
      : { type: null };
    if (!receiverResolved.type) return { type: null, elementType: null, reason: 'helper receiver unresolved' };
    const info = classProvider(receiverResolved.type, site.methodNameLiteral);
    if (!info || !info.exists) return { type: null, elementType: null, reason: 'helper method not found' };
    return { type: info.returnClass || null, elementType: info.elementClass || null, reason: null };
  }

  function startState(first) {
    if (first.called) {
      const seed = SEED_GLOBALS[first.name];
      return seed ? [seed.class, seed.elementType || null] : [null, null];
    }
    const known = varTypes.get(first.name);
    return known ? [known.type, known.elementType || null] : [null, null];
  }

  function resolveChainType(steps) {
    if (!steps || steps.length === 0) return { type: null, elementType: null, reason: 'empty-chain' };
    const first = steps[0];
    // The chain's own first step may itself start a PanelBridge.<helper>(...) call (first.called is
    // false here -- "PanelBridge" alone has no parens; it's steps[1], the ".helper(...)" access,
    // that does) -- resolve the helper's result, then keep walking any further steps after it.
    if (!first.called && first.name === 'PanelBridge' && helperSitesByOffset.has(first.offset)) {
      const site = helperSitesByOffset.get(first.offset);
      const helperResult = resolveHelperResultType(site);
      if (!helperResult.type) return helperResult;
      return walkStepsFrom(steps, 2, helperResult.type, helperResult.elementType);
    }
    // Java-style static singleton accessor, e.g. `GameTime.getInstance()` (steps[1] is the
    // ".getInstance(...)" call -- Lua's plain namespaced-call syntax, not the `:` self-call sugar
    // walkStepsFrom otherwise requires, so resolve this one step by hand before falling through).
    if (!first.called && STATIC_CLASS_SEEDS[first.name] && steps[1] && steps[1].sep === '.' && steps[1].called) {
      const info = classProvider(STATIC_CLASS_SEEDS[first.name], steps[1].name);
      if (!info || !info.exists) return { type: null, elementType: null, reason: `${first.name}.${steps[1].name}() not found` };
      return walkStepsFrom(steps, 2, info.returnClass || null, info.elementClass || null);
    }
    if (first.called) {
      if (!SEED_GLOBALS[first.name]) return { type: null, elementType: null, reason: `unseeded global '${first.name}()'` };
    } else {
      const known = varTypes.get(first.name);
      if (!known) return { type: null, elementType: null, reason: `unresolved variable '${first.name}'` };
    }
    return walkStepsFrom(steps, 1, ...startState(first));
  }

  // Pass 1: build the variable type table (single forward pass, source order).
  const assignRe = /(?:^|[^.\w])(?:local\s+)?([A-Za-z_]\w*)\s*=(?!=)\s*/gm;
  let m;
  while ((m = assignRe.exec(src))) {
    const name = m[1];
    if (LUA_KEYWORDS.has(name)) continue;
    // Table-constructor field, not a real assignment -- see computeTableConstructorDepths' own
    // comment for why this guard exists and what it fixes.
    if (tableDepth[m.index] > 0) continue;
    const exprStart = m.index + m[0].length;
    let chain = parseChainAt(src, exprStart);
    if (!chain) continue;
    // `local cell = world and PanelBridge.tryGet(world, "getCell")` -- a common Lua guard idiom.
    // The type-relevant operand is the one after `and` (assuming the guard holds); walk through
    // as many `and`-joined steps as appear, since the guard chain itself typically resolves to a
    // truthy/falsy check on the SAME variable and carries no type information of its own.
    for (;;) {
      let after = chain.endIndex;
      while (after < src.length && (src[after] === ' ' || src[after] === '\t')) after++;
      if (src.slice(after, after + 4) === 'and ' && IDENT_START.test(src[after + 4] || '')) {
        const next = parseChainAt(src, after + 4);
        if (!next) break;
        chain = next;
        continue;
      }
      break;
    }
    // Only trust this as a real assignment RHS if the chain is immediately followed by a
    // statement boundary (newline, ')', ',', end of buffer) -- guards against e.g. `x = a + b`
    // where `a` alone would otherwise be recorded as if it were the whole RHS.
    let after = chain.endIndex;
    while (after < src.length && (src[after] === ' ' || src[after] === '\t')) after++;
    const nextChar = src[after] || '\n';
    if (!/[\n\r),;]/.test(nextChar)) continue;
    const resolved = resolveChainType(chain.steps);
    varTypes.set(name, { type: resolved.type, elementType: resolved.elementType });
  }

  // Pass 2: helper-wrapped call sites.
  const callSites = [];
  for (const site of helperSites) {
    const line = lineOfOffset(lineIndex, site.offset);
    if (!site.methodNameLiteral) {
      callSites.push({
        kind: 'helper', helperName: site.helperName, line, methodName: null,
        receiverExpr: site.receiverText, receiverType: null, resolved: false,
        skipReason: `dynamic method name (${site.methodArgRaw})`,
      });
      continue;
    }
    const chain = parseChainAt(site.receiverText, 0);
    const resolved = chain ? resolveChainType(chain.steps) : { type: null, reason: 'unparseable receiver' };
    const receiverType = resolved.type;
    let methodInfo = null;
    if (receiverType) methodInfo = classProvider(receiverType, site.methodNameLiteral);
    callSites.push({
      kind: 'helper', helperName: site.helperName, line, methodName: site.methodNameLiteral,
      receiverExpr: site.receiverText, receiverType, resolved: !!receiverType,
      skipReason: receiverType ? null : resolved.reason, methodInfo,
    });
  }

  // Pass 3: direct `recv:method(...)` call sites.
  for (const chain of findAllChains(src)) {
    for (const site of directCallStepsFromChain(chain)) {
      const line = lineOfOffset(lineIndex, site.offset);
      const resolved = resolveChainType(site.receiverSteps);
      const receiverType = resolved.type;
      let methodInfo = null;
      if (receiverType) methodInfo = classProvider(receiverType, site.methodName);
      const receiverExpr = site.receiverSteps
        .map((s, idx) => (idx === 0 ? s.name + (s.called ? '()' : '') : `${s.sep}${s.name}${s.called ? '()' : ''}`))
        .join('');
      callSites.push({
        kind: 'direct', helperName: null, line, methodName: site.methodName,
        receiverExpr, receiverType, resolved: !!receiverType,
        skipReason: receiverType ? null : resolved.reason, methodInfo,
      });
    }
  }

  callSites.sort((a, b) => a.line - b.line);
  return { callSites, varTypes };
}
