// Low-level, sparse-key read/write for a server's .ini and _SandboxVars.lua
// files, used by templateService when applying a template. Deliberately
// narrow: it only ever touches the specific keys a template mentions, never
// attempts a full generic parse/rewrite of either file. This mirrors the
// existing precedent in server/services/serverManager.js (INI) and
// server/routes/serverFiles.js (Lua) of small, independent regex-based
// editors rather than a shared full-fidelity parser.
import fs from "fs";
import path from "path";
import { escapeRegExp } from "./regex.js";
import { writeFileAtomic } from "./fileWriteQueue.js";

function escapeLuaString(str) {
  return String(str).replace(/[\\"'\n\r\t]/g, (c) => {
    const map = { "\\": "\\\\", '"': '\\"', "'": "\\'", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
    return map[c];
  });
}

function formatLuaValue(value) {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `"${escapeLuaString(String(value))}"`;
}

function coerceSandboxValue(raw) {
  const trimmed = raw.trim().replace(/,\s*$/, "");
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return parseFloat(trimmed);
  const quoted = trimmed.match(/^"((?:[^"\\]|\\.)*)"$/);
  return quoted ? quoted[1].replace(/\\(.)/g, "$1") : trimmed;
}

// ---- server.ini ----------------------------------------------------------

// [ \t]* tolerance around both the key and "=" matches the convention
// routes/mods.js settled on 2026-08-27 for its own Mods=/WorkshopItems=/
// Map= writers: a bare `^key=` regex does not match a hand-edited or
// raw-editor-saved "Key = value" line (serverFiles.js's toIni() no longer
// auto-normalizes spacing away on save, see that file's own history), so a
// perfectly real, existing line was invisible to this reader. That matters
// beyond a missed read here -- server/utils/discordMessageRedaction.js's
// readServerJoinPassword() calls this to collect the values
// redactKnownSecrets() scrubs from every Discord-bound message; a spaced
// `Password = ...` line meant the join password silently never entered
// that set, so an RCON response echoing it would have posted to Discord in
// plaintext, defeating the one thing that module exists to prevent. The
// two Lua/SandboxVars siblings below (readSandboxValue/applySandboxValue)
// already tolerated this; only the ini side hadn't been brought in line.
export function readIniValues(content, keys) {
  const values = {};
  for (const key of keys) {
    const match = content.match(new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=(.*)$`, "m"));
    if (match) values[key] = match[1].trim();
  }
  return values;
}

/**
 * Replace or append each key=value pair. Creates the file content if empty.
 *
 * Same [ \t]* tolerance as readIniValues above, and for the same reason on
 * the write side: the old bare `^key=` regex didn't match a spaced
 * "Key = value" line either, so `regex.test(result)` came back false and
 * the else-branch APPENDED a second, unspaced copy of the key instead of
 * replacing the first -- the exact duplicate-key defect routes/mods.js's
 * 2026-08-27 comment describes, reproduced here independently. The
 * replacement line is written back unspaced (`key=value`, no surrounding
 * whitespace), the same normalize-on-write behavior mods.js's own fix uses,
 * not a preserve-the-original-formatting rewrite.
 */
export function mergeIniValues(content, updates) {
  let result = content || "";
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
    const regex = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=.*$`, "m");
    const safeValue = String(value).replace(/[\r\n]/g, "");
    if (regex.test(result)) {
      result = result.replace(regex, `${key}=${safeValue}`);
    } else {
      result += `${result && !result.endsWith("\n") ? "\n" : ""}${key}=${safeValue}\n`;
    }
  }
  return result;
}

// ---- SandboxVars.lua -------------------------------------------------------

function findBlockRange(content, blockName) {
  const start = content.match(new RegExp(`${escapeRegExp(blockName)}\\s*=\\s*\\{`));
  if (!start) return null;
  const openAt = start.index + start[0].length;
  const closeAt = content.indexOf("}", openAt);
  if (closeAt === -1) return null;
  return { start: start.index, openAt, closeAt };
}

/** Read the current value of `key` within `section` ("settings" = top level). */
export function readSandboxValue(content, section, key) {
  if (section !== "settings") {
    const range = findBlockRange(content, section);
    if (!range) return undefined;
    return readFirstMatch(content.slice(range.openAt, range.closeAt), key);
  }

  // Top-level keys can share a name with a nested-block key (e.g. "Farming"
  // and "Strength" both exist under settings AND MultiplierConfig), so a
  // plain whole-file regex could read the wrong section's value. Search only
  // outside the known nested-block byte ranges, same as applySandboxValue.
  const nestedRanges = getKnownSectionRanges(content);
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|[^,\\n}]+)`, "gm");
  let match;
  while ((match = pattern.exec(content)) !== null) {
    if (nestedRanges.some((r) => match.index >= r.start && match.index < r.closeAt)) continue;
    return coerceSandboxValue(match[1]);
  }
  return undefined;
}

function readFirstMatch(scope, key) {
  const match = scope.match(
    new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|[^,\\n}]+)`, "m"),
  );
  return match ? coerceSandboxValue(match[1]) : undefined;
}

/**
 * Replace `key`'s value within `section` if that key already exists there.
 * Returns { content, applied }. Keys the file doesn't already define are
 * reported as not applied rather than appended — SandboxVars.lua is always
 * server-generated with every known key present, so a missing key means the
 * file predates this setting and blindly appending risks a malformed table.
 */
export function applySandboxValue(content, section, key, value) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) return { content, applied: false };
  const valuePattern = '("(?:[^"\\\\]|\\\\.)*"|[^,\\n}]+)(,?)';

  if (section === "settings") {
    const nestedRanges = getKnownSectionRanges(content);
    const pattern = new RegExp(`(^\\s*)(${escapeRegExp(key)})(\\s*=\\s*)${valuePattern}`, "gm");
    let applied = false;
    const next = content.replace(pattern, (full, indent, k, eq, oldVal, comma, offset) => {
      if (nestedRanges.some((r) => offset >= r.start && offset < r.closeAt)) return full;
      applied = true;
      return `${indent}${k}${eq}${formatLuaValue(value)}${comma}`;
    });
    return { content: next, applied };
  }

  const blockRange = findBlockRange(content, section);
  if (!blockRange) return { content, applied: false };
  const before = content.slice(0, blockRange.openAt);
  const block = content.slice(blockRange.openAt, blockRange.closeAt);
  const after = content.slice(blockRange.closeAt);
  let applied = false;
  const pattern = new RegExp(`(^(?!\\s*--)[^\\n]*?)(${escapeRegExp(key)})(\\s*=\\s*)${valuePattern}`, "m");
  const nextBlock = block.replace(pattern, (full, prefix, k, eq, oldVal, comma) => {
    applied = true;
    return `${prefix}${k}${eq}${formatLuaValue(value)}${comma}`;
  });
  return { content: before + nextBlock + after, applied };
}

function getKnownSectionRanges(content) {
  return ["ZombieLore", "ZombieConfig", "MultiplierConfig", "Map", "Basement"]
    .map((name) => findBlockRange(content, name))
    .filter(Boolean);
}

/** Apply every key in `sectionUpdates` (shape: { settings: {...}, ZombieLore: {...} }). */
export function mergeSandboxSections(content, sectionUpdates) {
  let result = content;
  const applied = [];
  const skipped = [];
  for (const [section, values] of Object.entries(sectionUpdates || {})) {
    for (const [key, value] of Object.entries(values || {})) {
      const out = applySandboxValue(result, section, key, value);
      result = out.content;
      (out.applied ? applied : skipped).push({ section, key });
    }
  }
  return { content: result, applied, skipped };
}

// ---- Backups ---------------------------------------------------------------

/** Copy `filePath` into a timestamped `.bak` next to it. No-op if missing. */
export function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const dir = path.join(path.dirname(filePath), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // toISOString() is millisecond-resolution; two backups of the same file
  // close together (e.g. two template applies queued back to back through
  // the same withFileLock) can land in the same millisecond, which would
  // make the second silently overwrite the first with no error. Disambiguate
  // with a counter suffix, same pattern as configBackup.js/database/init.js.
  let backupPath = path.join(dir, `${path.basename(filePath)}.${stamp}.bak`);
  if (fs.existsSync(backupPath)) {
    let suffix = 2;
    while (fs.existsSync(`${backupPath}-${suffix}`)) suffix++;
    backupPath = `${backupPath}-${suffix}`;
  }
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

export function writeFile(filePath, content) {
  writeFileAtomic(filePath, content, "utf-8");
}

export function writeFilesTransaction(changes) {
  const written = [];
  try {
    for (const change of changes) {
      writeFile(change.filePath, change.content);
      written.push(change);
    }
  } catch (error) {
    for (const change of written.reverse()) {
      try {
        if (change.existed) {
          writeFile(change.filePath, change.original);
        } else if (fs.existsSync(change.filePath)) {
          fs.unlinkSync(change.filePath);
        }
      } catch {
        // The pre-write backup remains available if rollback itself fails.
      }
    }
    throw error;
  }
}
