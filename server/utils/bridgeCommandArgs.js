// Size and nesting limits for the args of a PanelBridge command.
//
// SECURITY (2026-10-28): the mod reads each inbox command file on the game
// server's main thread, and every byte costs time there (PanelBridge.lua's
// json.decode runs through Kahlua, a few microseconds per token). Args used
// to go to the mod unchecked, so a role allowed to send one command could
// queue a megabyte of it, and the deeply nested args a 1 MB JSON body can
// carry made JSON.stringify throw while the panel logged and saved them.
// Real commands are far smaller: everything but a character import stays
// under a few KB, and an import of a full 1000-item inventory (the export's
// own cap) is about 230 KB as exported and about half that once
// utils/characterImport.js keeps only what the mod reads.

export const BRIDGE_ARGS_MAX_DEPTH = 32;
export const BRIDGE_ARGS_MAX_BYTES = 64 * 1024;
export const BRIDGE_IMPORT_ARGS_MAX_BYTES = 512 * 1024;

export function bridgeArgsMaxBytes(action) {
  return action === "importPlayerData" ? BRIDGE_IMPORT_ARGS_MAX_BYTES : BRIDGE_ARGS_MAX_BYTES;
}

// Containers nested in `value`, counted without recursion (a body nested
// 100,000 deep would overflow the stack of a recursive walk).
export function bridgeArgsNestingDepth(value, limit = BRIDGE_ARGS_MAX_DEPTH) {
  if (value === null || typeof value !== "object") return 0;
  const stack = [[value, 1]];
  let deepest = 0;
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (depth > deepest) {
      deepest = depth;
      if (deepest > limit) return deepest;
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
    }
  }
  return deepest;
}

/**
 * Why these args must not reach the bridge, or null.
 * @param {string} action
 * @param {unknown} args
 * @returns {null | { reason: "depth" | "size" | "unserializable", limit: number }}
 */
export function bridgeArgsRefusal(action, args) {
  if (args === undefined || args === null) return null;
  if (bridgeArgsNestingDepth(args) > BRIDGE_ARGS_MAX_DEPTH) {
    return { reason: "depth", limit: BRIDGE_ARGS_MAX_DEPTH };
  }
  let text;
  try {
    text = JSON.stringify(args);
  } catch {
    return { reason: "unserializable", limit: 0 };
  }
  const limit = bridgeArgsMaxBytes(action);
  if (typeof text === "string" && Buffer.byteLength(text, "utf8") > limit) {
    return { reason: "size", limit };
  }
  return null;
}

export function bridgeArgsRefusalMessage(refusal) {
  if (refusal.reason === "depth") {
    return `Command arguments are nested more than ${refusal.limit} levels deep.`;
  }
  if (refusal.reason === "size") {
    return `Command arguments are larger than ${Math.round(refusal.limit / 1024)} KB.`;
  }
  return "Command arguments can't be sent to PanelBridge.";
}
