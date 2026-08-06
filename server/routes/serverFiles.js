import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { createLogger } from "../utils/logger.js";
const log = createLogger("API:Files");
import { getActiveServer, getAllSettings } from "../database/init.js";
import { sanitizeError } from "../utils/sanitize.js";
import { withFileLock, writeFileAtomic } from "../utils/fileWriteQueue.js";
import { escapeRegExp } from "../utils/regex.js";

const router = express.Router();

// Block all file operations for remote servers (no local filesystem access)
router.use(async (req, res, next) => {
  try {
    const activeServer = await getActiveServer();
    if (activeServer?.isRemote) {
      return res.status(400).json({
        error:
          "Server file editing is not available for remote servers. The server filesystem is not accessible from this panel.",
      });
    }
    next();
  } catch (err) {
    next(err);
  }
});

// Escape strings for safe interpolation into Lua source code
function escapeLuaString(str) {
  return String(str).replace(/[\\"'\n\r\t\0\[\]]/g, (c) => {
    const escapes = {
      "\\": "\\\\",
      '"': '\\"',
      "'": "\\'",
      "\n": "\\n",
      "\r": "\\r",
      "\t": "\\t",
      "\0": "\\0",
      "[": "\\[",
      "]": "\\]",
    };
    return escapes[c] || c;
  });
}

const LUA_UNESCAPES = {
  "\\": "\\",
  '"': '"',
  "'": "'",
  n: "\n",
  r: "\r",
  t: "\t",
  0: "\0",
  "[": "[",
  "]": "]",
};

// Inverse of escapeLuaString. Parsing must undo what writing escaped, otherwise
// every save re-escapes the same backslashes and doubles them until the file is
// corrupt (seen in the wild: StreetlightGen.ExcludeSprites grew to 16k slashes).
function unescapeLuaString(value) {
  const str = String(value);
  if (!/^"[\s\S]*"$|^'[\s\S]*'$/.test(str)) {
    return str.replace(/^["']|["']$/g, "");
  }
  return str
    .slice(1, -1)
    .replace(/\\([\s\S])/g, (match, c) =>
      Object.prototype.hasOwnProperty.call(LUA_UNESCAPES, c)
        ? LUA_UNESCAPES[c]
        : match,
    );
}

// Get the server config directory path
async function getServerConfigPath() {
  const activeServer = await getActiveServer();

  // First, use explicitly configured serverConfigPath if available
  if (activeServer?.serverConfigPath) {
    return activeServer.serverConfigPath;
  }

  // Fallback to zomboidDataPath + Server
  if (activeServer?.zomboidDataPath) {
    return path.join(activeServer.zomboidDataPath, "Server");
  }

  // Fallback to legacy settings
  const settings = await getAllSettings();
  if (settings.serverConfigPath) {
    return settings.serverConfigPath;
  }
  if (settings.zomboidDataPath) {
    return path.join(settings.zomboidDataPath, "Server");
  }

  // Default path: ~/Zomboid/Server
  return path.join(os.homedir(), "Zomboid", "Server");
}

// Get server name from active server
async function getServerName() {
  const activeServer = await getActiveServer();
  if (activeServer?.serverName) {
    return activeServer.serverName;
  }

  const settings = await getAllSettings();
  return settings.serverName || "servertest";
}

// Backup directory
async function getBackupPath() {
  return path.join(await getServerConfigPath(), "backups");
}

// Create backup before saving
async function createBackup(filename) {
  const configPath = await getServerConfigPath();
  const backupDir = await getBackupPath();
  const filePath = path.join(configPath, filename);

  try {
    // Check file existence asynchronously
    try {
      await fs.promises.access(filePath);
    } catch (e) {
      log.debug(`Config backup source not found: ${filePath} — ${e.message}`);
      return null;
    }

    // Ensure backup directory exists
    await fs.promises.mkdir(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupName = `${filename}.${timestamp}.bak`;
    const backupPath = path.join(backupDir, backupName);

    // Async copy
    await fs.promises.copyFile(filePath, backupPath);
    log.info(`Created backup: ${backupName}`);

    // Cleanup old backups asynchronously
    const files = await fs.promises.readdir(backupDir);
    const backups = files
      .filter((f) => f.startsWith(filename + ".") && f.endsWith(".bak"))
      .sort()
      .reverse();

    if (backups.length > 10) {
      const filesToDelete = backups.slice(10);
      await Promise.all(
        filesToDelete.map((old) =>
          fs.promises
            .unlink(path.join(backupDir, old))
            .catch((e) =>
              log.warn(`Failed to delete old backup ${old}: ${e.message}`),
            ),
        ),
      );
    }

    return backupName;
  } catch (error) {
    log.error(`Backup creation failed: ${error.message}`);
    return null;
  }
}

// Parse INI file to object
function parseIni(content) {
  const result = {};
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      result[key] = value;
    }
  }

  return result;
}

// Convert object back to INI format
function toIni(obj, originalContent = "") {
  // Preserve comments and order from original
  if (originalContent) {
    const lines = originalContent.split(/\r?\n/);
    const result = [];
    const written = new Set();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
        result.push(line);
        continue;
      }

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.substring(0, eqIndex).trim();
        if (key in obj) {
          // Strip newlines from values to prevent INI injection
          const safeValue = String(obj[key]).replace(/[\r\n]/g, "");
          result.push(`${key}=${safeValue}`);
          written.add(key);
        } else {
          result.push(line);
        }
      } else {
        result.push(line);
      }
    }

    // Add any new keys (only if they have a non-empty value)
    for (const [key, value] of Object.entries(obj)) {
      if (!written.has(key)) {
        // Skip empty values for keys that weren't in the original file
        if (value === "" || value === undefined || value === null) continue;
        // Validate key is a safe INI identifier
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          log.warn(`Invalid INI key skipped: ${key}`);
          continue;
        }
        const safeValue = String(value).replace(/[\r\n]/g, "");
        result.push(`${key}=${safeValue}`);
      }
    }

    return result.join("\n");
  }

  // Generate from scratch
  return Object.entries(obj)
    .filter(([key]) => {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        log.warn(`Invalid INI key skipped: ${key}`);
        return false;
      }
      return true;
    })
    .map(([key, value]) => {
      const safeValue = String(value).replace(/[\r\n]/g, "");
      return `${key}=${safeValue}`;
    })
    .join("\n");
}

// Parse SandboxVars.lua
function parseSandboxVars(content) {
  const result = {
    VERSION: 4,
    settings: {},
    ZombieLore: {},
    ZombieConfig: {},
    MultiplierConfig: {},
    Map: {},
    Basement: {},
  };

  // Known nested blocks to skip when parsing top-level settings
  const nestedBlocks = [
    "ZombieLore",
    "ZombieConfig",
    "MultiplierConfig",
    "Map",
    "Basement",
  ];

  try {
    // Extract VERSION
    const versionMatch = content.match(/VERSION\s*=\s*(\d+)/);
    if (versionMatch) {
      result.VERSION = parseInt(versionMatch[1], 10);
    }

    // Strip nested block regions from content so the top-level regex
    // doesn't accidentally capture keys that belong inside ZombieLore,
    // ZombieConfig, MultiplierConfig, Map, or Basement.
    let topLevelContent = content;
    for (const blockName of nestedBlocks) {
      const blockPattern = new RegExp(
        escapeRegExp(blockName) + "\\s*=\\s*\\{[\\s\\S]*?\\n\\s*\\}",
        "m",
      );
      topLevelContent = topLevelContent.replace(blockPattern, "");
    }

    // Parse simple key=value pairs (top-level settings only).
    // The value alternation tries a quoted string first so values like
    // WorldItemRemovalList = "Base.Hat,Base.Glasses,..." aren't truncated
    // at the first comma *inside* the quotes.
    const simplePattern =
      /^\s*(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,{}\n]+),?\s*(?:--.*)?$/gm;
    let match;
    while ((match = simplePattern.exec(topLevelContent)) !== null) {
      const key = match[1];
      let value = match[2].trim();

      // Skip nested objects and VERSION
      if (nestedBlocks.includes(key) || key === "VERSION") continue;

      // Parse value type
      if (value === "true") value = true;
      else if (value === "false") value = false;
      else if (!isNaN(parseFloat(value))) value = parseFloat(value);
      else value = unescapeLuaString(value);

      result.settings[key] = value;
    }

    // Helper function to parse a nested block
    function parseNestedBlock(blockName) {
      // Match nested blocks - handle both simple and complex nested structures
      const blockPattern = new RegExp(
        `${blockName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\}`,
        "m",
      );
      const blockMatch = content.match(blockPattern);

      if (blockMatch) {
        const blockContent = blockMatch[1];
        // Strip Lua comment lines to avoid parsing comment text as keys
        // (e.g. "-- 1 = Sprinters" or "-- Default = Random")
        const strippedContent = blockContent.replace(/^\s*--.*$/gm, "");
        const valuePattern = /(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,\n]+)/g;
        let valueMatch;
        while ((valueMatch = valuePattern.exec(strippedContent)) !== null) {
          let value = valueMatch[2].trim();
          // Remove trailing comma if present
          value = value.replace(/,\s*$/, "");

          if (value === "true") value = true;
          else if (value === "false") value = false;
          else if (!isNaN(parseFloat(value))) value = parseFloat(value);
          else value = unescapeLuaString(value);

          result[blockName][valueMatch[1]] = value;
        }
      }
    }

    // Parse all nested blocks
    nestedBlocks.forEach(parseNestedBlock);
  } catch (error) {
    log.error("Failed to parse SandboxVars:", error);
  }

  return result;
}

// Format a number for Lua, preserving the original file's decimal format
function formatLuaNumber(newValue, originalValueStr) {
  const trimmed = originalValueStr
    ? originalValueStr.trim().replace(/,\s*$/, "")
    : "";
  // If the original value had a decimal point and the new value is a whole number, add .0
  if (Number.isInteger(newValue) && trimmed.includes(".")) {
    return newValue.toFixed(1);
  }
  return newValue.toString();
}

// Modify a single value in the SandboxVars file content in-place
// Preserves all comments and file structure
function modifySandboxValue(
  originalContent,
  key,
  newValue,
  nestedBlock = null,
) {
  let content = originalContent;

  // Validate key is a valid identifier (alphanumeric and underscore only)
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
    log.warn(`Invalid sandbox key skipped: ${key}`);
    return content;
  }

  // Format the value for Lua (base format, may be refined by context)
  function formatValue(originalValueStr) {
    if (typeof newValue === "boolean") {
      return newValue.toString();
    } else if (typeof newValue === "number") {
      return formatLuaNumber(newValue, originalValueStr);
    } else {
      return `"${escapeLuaString(String(newValue))}"`;
    }
  }

  // Escape key for use in regex (even though we validate, this is defense in depth)
  const escapedKey = escapeRegExp(key);

  if (nestedBlock) {
    // For nested blocks (ZombieLore, ZombieConfig, etc.)
    // Only match actual assignment lines (not comment lines starting with --)
    const escapedBlock = escapeRegExp(nestedBlock);
    const blockStartPattern = new RegExp(`${escapedBlock}\\s*=\\s*\\{`);
    const blockStartMatch = content.match(blockStartPattern);
    if (blockStartMatch) {
      const blockStart = blockStartMatch.index;
      const blockEnd = content.indexOf(
        "}",
        blockStart + blockStartMatch[0].length,
      );
      if (blockEnd !== -1) {
        const before = content.substring(0, blockStart);
        const blockSection = content.substring(blockStart, blockEnd + 1);
        const after = content.substring(blockEnd + 1);
        // Replace only on non-comment lines within the block.
        // The value alternation matches a full quoted string first so
        // values containing commas (e.g. comma-separated lists) aren't
        // truncated mid-string, which would corrupt the Lua syntax.
        const updatedBlock = blockSection.replace(
          new RegExp(
            `(^(?!\\s*--)[^\\n]*?)(${escapedKey})(\\s*=\\s*)("(?:[^"\\\\]|\\\\.)*"|[^,\\n}]+)(,?)`,
            "m",
          ),
          (_, prefix, k, eq, oldVal, comma) =>
            `${prefix}${k}${eq}${formatValue(oldVal)}${comma}`,
        );
        content = before + updatedBlock + after;
      }
    }
  } else {
    // For top-level settings, only replace occurrences OUTSIDE nested blocks
    // to avoid accidentally modifying keys that share a name with a nested key.
    const knownBlocks = [
      "ZombieLore",
      "ZombieConfig",
      "MultiplierConfig",
      "Map",
      "Basement",
    ];
    const blockRanges = [];
    for (const bn of knownBlocks) {
      const bp = new RegExp(escapeRegExp(bn) + "\\s*=\\s*\\{");
      const bm = content.match(bp);
      if (bm) {
        const start = bm.index;
        const end = content.indexOf("}", start + bm[0].length);
        if (end !== -1) blockRanges.push({ start, end: end + 1 });
      }
    }

    // The value alternation matches a full quoted string first so values
    // containing commas (e.g. comma-separated lists like
    // WorldItemRemovalList) aren't truncated mid-string, which would
    // corrupt the Lua syntax.
    const pattern = new RegExp(
      `(^\\s*)(${escapedKey})(\\s*=\\s*)("(?:[^"\\\\]|\\\\.)*"|[^,\\n}]+)(,?)(\\s*(?:--.*)?$)`,
      "gm",
    );
    content = content.replace(
      pattern,
      (fullMatch, indent, k, eq, oldVal, comma, comment, offset) => {
        // Skip matches inside nested blocks
        for (const range of blockRanges) {
          if (offset >= range.start && offset < range.end) return fullMatch;
        }
        return `${indent}${k}${eq}${formatValue(oldVal)}${comma}${comment}`;
      },
    );
  }

  return content;
}

// Count { / } in a SandboxVars.lua content string. A healthy file always has
// an equal number of each with the running depth never going negative. This
// is the cheapest possible syntax sanity check we can do without a real Lua
// parser, but it happens to catch the exact class of corruption PZ's own
// dedicated server crashes on: an orphaned/dropped block header that leaves
// a dangling closing brace (see "Exiting due to errors loading ..." crashes
// with a KahluaException "'}' expected").
export function checkSandboxBraceBalance(content) {
  let depth = 0;
  let wentNegative = false;
  for (const ch of content) {
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) wentNegative = true;
    }
  }
  return { balanced: depth === 0 && !wentNegative, depth };
}

// Attempt to auto-repair the most common SandboxVars.lua corruption pattern:
// a nested block's "<Name> = {" header line (and the trailing comma on the
// first entry) got dropped somewhere upstream (mod schema migration, manual
// editing, etc.), leaving an orphaned scalar entry at a shallower indent
// than its former siblings — with the original closing "}" still present
// further down. That desyncs the whole file's brace count and makes PZ's
// Lua loader refuse to parse the file at all.
//
// Repair strategy: whenever a scalar "key = value" line (no trailing comma)
// is immediately followed by a more-deeply-indented entry line, treat it as
// an orphaned block opener. Add the missing comma and synthesize a wrapper
// table around it so the existing (now-dangling) closing brace has
// something to match again. This is deliberately conservative — it never
// deletes or reinterprets existing content, only restores brace balance —
// and every attempt is re-validated for balance before anything is written.
export function repairSandboxSyntax(content) {
  const before = checkSandboxBraceBalance(content);
  if (before.balanced) {
    return { content, fixed: false, changes: [] };
  }

  const lines = content.split(/\r?\n/);
  const changes = [];
  const scalarLine =
    /^(\s*)(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|true|false|-?\d+(?:\.\d+)?)\s*(--.*)?$/;
  const entryLine = /^(\s*)(\w+)\s*=\s*/;
  let syntheticCounter = 0;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(scalarLine);
    if (!m) continue;
    const indent = m[1];

    // Find the next non-blank, non-comment line.
    let j = i + 1;
    while (
      j < lines.length &&
      (lines[j].trim() === "" || /^\s*--/.test(lines[j]))
    ) {
      j++;
    }
    if (j >= lines.length) continue;

    const nextEntry = lines[j].match(entryLine);
    if (!nextEntry) continue;
    if (nextEntry[1].length <= indent.length) continue; // normal sibling/closing — not orphaned

    syntheticCounter += 1;
    changes.push(
      `Line ${i + 1}: '${m[2]} = ${m[3]}' looked like an orphaned block entry (missing block header and comma) — wrapped it in a synthetic '_RepairedBlock${syntheticCounter}' table so the file parses again.`,
    );
    lines[i] =
      `${indent}_RepairedBlock${syntheticCounter} = {\n${indent}    ${m[2]} = ${m[3]},`;
  }

  const repaired = lines.join("\n");
  const after = checkSandboxBraceBalance(repaired);
  return {
    content: repaired,
    fixed: after.balanced && changes.length > 0,
    changes,
  };
}

// Apply multiple sandbox changes to file content in-place
function applySandboxChanges(originalContent, changes) {
  let content = originalContent;

  // Apply settings changes
  if (changes.settings) {
    for (const [key, value] of Object.entries(changes.settings)) {
      content = modifySandboxValue(content, key, value, null);
    }
  }

  // Apply ZombieLore changes
  if (changes.ZombieLore) {
    for (const [key, value] of Object.entries(changes.ZombieLore)) {
      content = modifySandboxValue(content, key, value, "ZombieLore");
    }
  }

  // Apply ZombieConfig changes
  if (changes.ZombieConfig) {
    for (const [key, value] of Object.entries(changes.ZombieConfig)) {
      content = modifySandboxValue(content, key, value, "ZombieConfig");
    }
  }

  // Apply MultiplierConfig changes
  if (changes.MultiplierConfig) {
    for (const [key, value] of Object.entries(changes.MultiplierConfig)) {
      content = modifySandboxValue(content, key, value, "MultiplierConfig");
    }
  }

  // Apply Map changes
  if (changes.Map) {
    for (const [key, value] of Object.entries(changes.Map)) {
      content = modifySandboxValue(content, key, value, "Map");
    }
  }

  // Apply Basement changes
  if (changes.Basement) {
    for (const [key, value] of Object.entries(changes.Basement)) {
      content = modifySandboxValue(content, key, value, "Basement");
    }
  }

  return content;
}

function createSandboxVars(sandbox) {
  const sections = [
    "settings",
    "ZombieLore",
    "ZombieConfig",
    "MultiplierConfig",
    "Map",
    "Basement",
  ];
  const lines = ["SandboxVars = {"];
  const version = Number.isInteger(sandbox.VERSION) ? sandbox.VERSION : 4;
  lines.push(`    VERSION = ${version},`);

  const formatValue = (value) => {
    if (typeof value === "boolean") return String(value);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return `"${escapeLuaString(String(value))}"`;
  };

  for (const sectionName of sections) {
    const values = sandbox[sectionName];
    if (!values || typeof values !== "object") continue;

    if (sectionName === "settings") {
      for (const [key, value] of Object.entries(values)) {
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          lines.push(`    ${key} = ${formatValue(value)},`);
        }
      }
      continue;
    }

    lines.push(`    ${sectionName} = {`);
    for (const [key, value] of Object.entries(values)) {
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        lines.push(`        ${key} = ${formatValue(value)},`);
      }
    }
    lines.push("    },");
  }

  lines.push("}");
  return lines.join("\n") + "\n";
}

// Parse spawn points lua - handles profession-based structure
function parseSpawnPoints(content) {
  const professions = {};

  try {
    // First, find profession blocks like: unemployed = { ... }
    // The format is: professionName = { { worldX = ..., ... }, { worldX = ..., ... } }
    const professionPattern = /(\w+)\s*=\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
    let profMatch;

    while ((profMatch = professionPattern.exec(content)) !== null) {
      const profName = profMatch[1];
      const profContent = profMatch[2];

      // Skip 'return' as it's not a profession
      if (profName === "return") continue;

      const points = [];
      // Match spawn point entries - posZ is optional
      const pointPattern =
        /\{\s*worldX\s*=\s*(\d+)\s*,\s*worldY\s*=\s*(\d+)\s*,\s*posX\s*=\s*([\d.]+)\s*,\s*posY\s*=\s*([\d.]+)(?:\s*,\s*posZ\s*=\s*(\d+))?\s*\}/g;
      let pointMatch;

      while ((pointMatch = pointPattern.exec(profContent)) !== null) {
        points.push({
          worldX: parseInt(pointMatch[1], 10),
          worldY: parseInt(pointMatch[2], 10),
          posX: parseFloat(pointMatch[3]),
          posY: parseFloat(pointMatch[4]),
          posZ: pointMatch[5] ? parseInt(pointMatch[5], 10) : 0,
        });
      }

      if (points.length > 0) {
        professions[profName] = points;
      }
    }
  } catch (error) {
    log.error("Failed to parse spawn points:", error);
  }

  return professions;
}

// Convert spawn points to Lua - handles profession-based structure
function toSpawnPoints(professions, serverName) {
  const lines = [`function SpawnPoints()`];
  lines.push(`\treturn {`);

  for (const [profName, points] of Object.entries(professions)) {
    // Validate profession name is a safe Lua identifier
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(profName)) {
      log.warn(`Invalid profession name skipped in spawnpoints: ${profName}`);
      continue;
    }
    lines.push(`\t\t${profName} = {`);
    for (const p of points) {
      // Validate coordinates are finite numbers to prevent Lua injection
      const wx = Number.isFinite(Number(p.worldX)) ? Number(p.worldX) : 0;
      const wy = Number.isFinite(Number(p.worldY)) ? Number(p.worldY) : 0;
      const px = Number.isFinite(Number(p.posX)) ? Number(p.posX) : 0;
      const py = Number.isFinite(Number(p.posY)) ? Number(p.posY) : 0;
      const pz = Number.isFinite(Number(p.posZ)) ? Number(p.posZ) : 0;
      if (pz && pz !== 0) {
        lines.push(
          `\t\t\t{ worldX = ${wx}, worldY = ${wy}, posX = ${px}, posY = ${py}, posZ = ${pz} }`,
        );
      } else {
        lines.push(
          `\t\t\t{ worldX = ${wx}, worldY = ${wy}, posX = ${px}, posY = ${py} }`,
        );
      }
    }
    lines.push(`\t\t}`);
  }

  lines.push(`\t}`);
  lines.push(`end`);
  return lines.join("\n");
}

// Parse spawn regions lua
function parseSpawnRegions(content) {
  const regions = [];

  try {
    // Match patterns like { name = "Muldraugh, KY", file = "path" } or { name = "...", serverfile = "..." }
    // Handle both 'file' and 'serverfile' keys
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      // Skip comments
      if (line.trim().startsWith("--")) continue;

      // Try to match file or serverfile
      const nameMatch = line.match(/name\s*=\s*"([^"]+)"/);
      const fileMatch = line.match(/(?:server)?file\s*=\s*"([^"]+)"/);

      if (nameMatch && fileMatch) {
        regions.push({
          name: nameMatch[1],
          file: fileMatch[1],
          isServerFile: line.includes("serverfile"),
        });
      }
    }
  } catch (error) {
    log.error("Failed to parse spawn regions:", error);
  }

  return regions;
}

// Convert spawn regions to Lua
function toSpawnRegions(regions, serverName) {
  const lines = [`function SpawnRegions()`];
  lines.push(`        return {`);

  for (const r of regions) {
    const safeName = escapeLuaString(r.name);
    const safeFile = escapeLuaString(r.file);
    if (r.isServerFile) {
      lines.push(
        `                { name = "${safeName}", serverfile = "${safeFile}" },`,
      );
    } else {
      lines.push(
        `                { name = "${safeName}", file = "${safeFile}" },`,
      );
    }
  }

  lines.push(`        }`);
  lines.push(`end`);
  return lines.join("\n");
}

// ===== ROUTES =====

// Get server file paths info
router.get("/paths", async (req, res) => {
  try {
    log.info("GET /paths");
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();

    const files = {
      ini: path.join(configPath, `${serverName}.ini`),
      sandbox: path.join(configPath, `${serverName}_SandboxVars.lua`),
      spawnpoints: path.join(configPath, `${serverName}_spawnpoints.lua`),
      spawnregions: path.join(configPath, `${serverName}_spawnregions.lua`),
    };

    const exists = {
      ini: fs.existsSync(files.ini),
      sandbox: fs.existsSync(files.sandbox),
      spawnpoints: fs.existsSync(files.spawnpoints),
      spawnregions: fs.existsSync(files.spawnregions),
    };

    res.json({ configPath, serverName, files, exists });
  } catch (error) {
    log.error("Failed to get paths:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get INI file (parsed)
router.get("/ini", async (req, res) => {
  try {
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}.ini`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "INI file not found" });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = parseIni(content);

    res.json({ settings: parsed });
  } catch (error) {
    log.error("Failed to read INI:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Save INI file
router.put("/ini", async (req, res) => {
  try {
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    log.info(
      `PUT /ini: serverName=${serverName}, keys=${Object.keys(req.body.settings || {}).length}`,
    );
    const filePath = path.join(configPath, `${serverName}.ini`);
    const { settings } = req.body;

    if (!settings || typeof settings !== "object") {
      return res.status(400).json({ error: "Settings object required" });
    }

    // Guard against prototype pollution
    if (
      Object.prototype.hasOwnProperty.call(settings, "__proto__") ||
      Object.prototype.hasOwnProperty.call(settings, "constructor") ||
      Object.prototype.hasOwnProperty.call(settings, "prototype")
    ) {
      return res.status(400).json({ error: "Invalid settings" });
    }

    // Read original to preserve comments/structure. Locked per-path so two
    // overlapping PUTs to the same INI can't interleave their read-modify-write.
    await withFileLock(filePath, async () => {
      let originalContent = "";
      if (fs.existsSync(filePath)) {
        originalContent = fs.readFileSync(filePath, "utf-8");
        await createBackup(`${serverName}.ini`);
      }

      const content = toIni(settings, originalContent);
      writeFileAtomic(filePath, content, "utf-8");
      return content;
    });

    log.info("Saved INI file");
    res.json({ success: true, message: "Settings saved" });
  } catch (error) {
    log.error("Failed to save INI:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get SandboxVars (parsed)
router.get("/sandbox", async (req, res) => {
  try {
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "SandboxVars file not found" });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = parseSandboxVars(content);

    res.json({ sandbox: parsed });
  } catch (error) {
    log.error("Failed to read SandboxVars:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Save SandboxVars
router.put("/sandbox", async (req, res) => {
  try {
    log.info("PUT /sandbox");
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);
    const { sandbox } = req.body;

    if (!sandbox || typeof sandbox !== "object") {
      return res.status(400).json({ error: "Sandbox object required" });
    }

    // Guard against prototype pollution
    if (
      Object.prototype.hasOwnProperty.call(sandbox, "__proto__") ||
      Object.prototype.hasOwnProperty.call(sandbox, "constructor") ||
      Object.prototype.hasOwnProperty.call(sandbox, "prototype")
    ) {
      return res.status(400).json({ error: "Invalid sandbox data" });
    }

    // Guard nested sections against prototype pollution
    for (const section of Object.values(sandbox)) {
      if (section && typeof section === "object") {
        if (
          Object.prototype.hasOwnProperty.call(section, "__proto__") ||
          Object.prototype.hasOwnProperty.call(section, "constructor") ||
          Object.prototype.hasOwnProperty.call(section, "prototype")
        ) {
          return res.status(400).json({ error: "Invalid sandbox data" });
        }
      }
    }

    // Size limit: reject payloads > 1MB
    const payloadSize = JSON.stringify(sandbox).length;
    if (payloadSize > 1024 * 1024) {
      return res
        .status(400)
        .json({ error: "Sandbox data too large (max 1MB)" });
    }

    // Modify an existing file in-place to preserve comments and structure.
    // On a fresh server, create a valid sandbox file from the submitted schema
    // values so the editor works before the game's first boot.
    let fileExists;
    await withFileLock(filePath, async () => {
      fileExists = fs.existsSync(filePath);
      const newContent = fileExists
        ? applySandboxChanges(fs.readFileSync(filePath, "utf-8"), sandbox)
        : createSandboxVars(sandbox);
      if (fileExists) {
        await createBackup(`${serverName}_SandboxVars.lua`);
      }
      writeFileAtomic(filePath, newContent, "utf-8");
    });

    log.info(`${fileExists ? "Saved" : "Created"} SandboxVars file`);
    res.json({
      success: true,
      created: !fileExists,
      message: fileExists ? "Sandbox settings saved" : "SandboxVars file created",
    });
  } catch (error) {
    log.error("Failed to save SandboxVars:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Write one option into SandboxVars.lua. Mod options live in blocks the
// sandbox schema knows nothing about, so they are addressed as "Block.Key" and
// rewritten in place; a key that is not already in the file is left alone,
// since PZ regenerates those from the mod's own defaults.
router.put("/sandbox-option", async (req, res) => {
  try {
    const { name, value } = req.body || {};

    if (typeof name !== "string" || !name) {
      return res.status(400).json({ error: "Option name required" });
    }
    if (!["string", "number", "boolean"].includes(typeof value)) {
      return res.status(400).json({ error: "Option value must be a primitive" });
    }

    const parts = name.split(".");
    const isIdentifier = (p) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p);
    if (parts.length > 2 || !parts.every(isIdentifier)) {
      return res.status(400).json({ error: "Invalid option name" });
    }
    const block = parts.length === 2 ? parts[0] : null;
    const key = parts.length === 2 ? parts[1] : parts[0];

    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error:
          "SandboxVars file not found. Start the server once to generate it.",
      });
    }

    let persisted = false;
    await withFileLock(filePath, async () => {
      const originalContent = fs.readFileSync(filePath, "utf-8");
      const newContent = modifySandboxValue(originalContent, key, value, block);
      if (newContent === originalContent) return;
      await createBackup(`${serverName}_SandboxVars.lua`);
      writeFileAtomic(filePath, newContent, "utf-8");
      persisted = true;
    });

    log.info(`Sandbox option ${name} persisted: ${persisted}`);
    res.json({ success: true, persisted });
  } catch (error) {
    log.error("Failed to save sandbox option:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Write top-level sandbox keys straight to disk. The in-game bridge can only
// change SandboxOptions in memory, so without this every change is lost on the
// next server start.
export async function persistSandboxValues(values) {
  const entries = Object.entries(values || {});
  if (entries.length === 0) return { persisted: false, reason: "nothing to do" };

  const activeServer = await getActiveServer();
  if (activeServer?.isRemote) {
    return { persisted: false, reason: "remote server filesystem" };
  }

  const configPath = await getServerConfigPath();
  const serverName = await getServerName();
  const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);
  if (!fs.existsSync(filePath)) {
    return { persisted: false, reason: "SandboxVars.lua not found" };
  }

  let persisted = false;
  let reason = null;
  await withFileLock(filePath, async () => {
    const originalContent = fs.readFileSync(filePath, "utf-8");
    let content = originalContent;

    // modifySandboxValue only rewrites existing assignments, so a key that
    // isn't in the file would no-op and look like "already correct".
    const missing = entries
      .map(([key]) => key)
      .filter(
        (key) => !new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "m").test(content),
      );
    if (missing.length > 0) {
      reason = `not present in SandboxVars.lua: ${missing.join(", ")}`;
      return;
    }

    for (const [key, value] of entries) {
      content = modifySandboxValue(content, key, value, null);
    }
    if (content === originalContent) {
      reason = "values already match";
      return;
    }
    await createBackup(`${serverName}_SandboxVars.lua`);
    writeFileAtomic(filePath, content, "utf-8");
    persisted = true;
  });

  return { persisted, reason };
}

// Check whether SandboxVars.lua is syntactically well-formed (brace balance
// only — we don't have a real Lua parser). A corrupt file here is a classic
// cause of "server won't boot, no obvious reason" reports.
router.get("/sandbox/validate", async (req, res) => {
  try {
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "SandboxVars file not found" });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const { balanced, depth } = checkSandboxBraceBalance(content);
    res.json({ valid: balanced, braceDepth: depth });
  } catch (error) {
    log.error("Failed to validate SandboxVars:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Attempt to auto-repair SandboxVars.lua. Always backs up the existing file
// first, and refuses to write anything unless the repaired content is
// verified brace-balanced — if the corruption doesn't match a known
// pattern, nothing is written and the caller is told to fix it manually.
router.post("/sandbox/repair", async (req, res) => {
  try {
    log.info("POST /sandbox/repair");
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "SandboxVars file not found" });
    }

    const result = await withFileLock(filePath, async () => {
      const originalContent = fs.readFileSync(filePath, "utf-8");
      const before = checkSandboxBraceBalance(originalContent);
      if (before.balanced) {
        return { alreadyValid: true };
      }

      const {
        content: repaired,
        fixed,
        changes,
      } = repairSandboxSyntax(originalContent);
      if (!fixed) {
        return {
          alreadyValid: false,
          repaired: false,
          error:
            "Could not automatically repair this file — the corruption doesn't match a known pattern. Restore from a backup or fix it manually.",
        };
      }

      await createBackup(`${serverName}_SandboxVars.lua`);
      writeFileAtomic(filePath, repaired, "utf-8");
      return { alreadyValid: false, repaired: true, changes };
    });

    if (result.alreadyValid) {
      return res.json({
        success: true,
        alreadyValid: true,
        message: "SandboxVars.lua is already valid — no repair needed.",
      });
    }
    if (!result.repaired) {
      return res.status(422).json({ success: false, error: result.error });
    }

    log.info(
      `Repaired SandboxVars.lua: ${result.changes.length} fix(es) applied`,
    );
    res.json({
      success: true,
      repaired: true,
      changes: result.changes,
      message: `Repaired ${result.changes.length} issue${result.changes.length === 1 ? "" : "s"} in SandboxVars.lua. A backup of the broken file was saved first.`,
    });
  } catch (error) {
    log.error("Failed to repair SandboxVars:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get spawn points
router.get("/spawnpoints", async (req, res) => {
  try {
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}_spawnpoints.lua`);

    if (!fs.existsSync(filePath)) {
      return res
        .status(404)
        .json({ error: "Spawn points file not found", path: filePath });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const points = parseSpawnPoints(content);

    res.json({ spawnpoints: points, path: filePath });
  } catch (error) {
    log.error("Failed to read spawn points:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Save spawn points
router.put("/spawnpoints", async (req, res) => {
  try {
    log.info("PUT /spawnpoints");
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}_spawnpoints.lua`);
    const { spawnpoints } = req.body;

    if (!spawnpoints || typeof spawnpoints !== "object") {
      return res
        .status(400)
        .json({ error: "Spawn points object required (keyed by profession)" });
    }

    await withFileLock(filePath, async () => {
      if (fs.existsSync(filePath)) {
        await createBackup(`${serverName}_spawnpoints.lua`);
      }

      const newContent = toSpawnPoints(spawnpoints, serverName);
      writeFileAtomic(filePath, newContent, "utf-8");
    });

    log.info("Saved spawn points file");
    res.json({ success: true, message: "Spawn points saved" });
  } catch (error) {
    log.error("Failed to save spawn points:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get spawn regions
router.get("/spawnregions", async (req, res) => {
  try {
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}_spawnregions.lua`);

    if (!fs.existsSync(filePath)) {
      return res
        .status(404)
        .json({ error: "Spawn regions file not found", path: filePath });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const regions = parseSpawnRegions(content);

    res.json({ spawnregions: regions, path: filePath });
  } catch (error) {
    log.error("Failed to read spawn regions:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Save spawn regions
router.put("/spawnregions", async (req, res) => {
  try {
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}_spawnregions.lua`);
    const { spawnregions } = req.body;

    if (!Array.isArray(spawnregions)) {
      return res.status(400).json({ error: "Spawn regions array required" });
    }

    await withFileLock(filePath, async () => {
      if (fs.existsSync(filePath)) {
        await createBackup(`${serverName}_spawnregions.lua`);
      }

      const newContent = toSpawnRegions(spawnregions, serverName);
      writeFileAtomic(filePath, newContent, "utf-8");
    });

    log.info("Saved spawn regions file");
    res.json({ success: true, message: "Spawn regions saved" });
  } catch (error) {
    log.error("Failed to save spawn regions:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get raw file content
router.get("/raw/:type", async (req, res) => {
  log.info(`GET /raw/${req.params.type}`);
  try {
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const type = req.params.type;

    const fileMap = {
      ini: `${serverName}.ini`,
      sandbox: `${serverName}_SandboxVars.lua`,
      spawnpoints: `${serverName}_spawnpoints.lua`,
      spawnregions: `${serverName}_spawnregions.lua`,
    };

    if (!fileMap[type]) {
      return res.status(400).json({ error: "Invalid file type" });
    }

    const filePath = path.join(configPath, fileMap[type]);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    res.json({ content, filename: fileMap[type] });
  } catch (error) {
    log.error("Failed to read raw file:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Save raw file content
router.put("/raw/:type", async (req, res) => {
  try {
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const type = req.params.type;
    const { content } = req.body;
    log.info(`PUT /raw/${type}: contentLength=${content?.length || 0}`);

    const fileMap = {
      ini: `${serverName}.ini`,
      sandbox: `${serverName}_SandboxVars.lua`,
      spawnpoints: `${serverName}_spawnpoints.lua`,
      spawnregions: `${serverName}_spawnregions.lua`,
    };

    if (!fileMap[type]) {
      return res.status(400).json({ error: "Invalid file type" });
    }

    if (typeof content !== "string") {
      return res.status(400).json({ error: "Content string required" });
    }

    if (content.length > 512 * 1024) {
      return res.status(400).json({ error: "Content too large (max 512KB)" });
    }

    const filePath = path.join(configPath, fileMap[type]);

    await withFileLock(filePath, async () => {
      if (fs.existsSync(filePath)) {
        await createBackup(fileMap[type]);
      }

      writeFileAtomic(filePath, content, "utf-8");
    });

    log.info(`Saved raw file: ${fileMap[type]}`);
    res.json({ success: true, message: "File saved" });
  } catch (error) {
    log.error("Failed to save raw file:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// List backups
router.get("/backups", async (req, res) => {
  try {
    const backupDir = await getBackupPath();

    if (!fs.existsSync(backupDir)) {
      return res.json({ backups: [] });
    }

    const fileList = await fs.promises.readdir(backupDir);
    const files = (
      await Promise.all(
        fileList
          .filter((f) => f.endsWith(".bak"))
          .map(async (filename) => {
            try {
              const stats = await fs.promises.stat(
                path.join(backupDir, filename),
              );
              return {
                filename,
                size: stats.size,
                created: stats.birthtime,
              };
            } catch (e) {
              log.debug(
                `Stat failed for backup file ${filename}: ${e.message}`,
              );
              return null;
            }
          }),
      )
    )
      .filter((f) => f !== null)
      .sort((a, b) => {
        // Handle invalid dates gracefully
        const dateA = new Date(a.created);
        const dateB = new Date(b.created);
        if (isNaN(dateA.getTime())) return 1;
        if (isNaN(dateB.getTime())) return -1;
        return dateB - dateA;
      });

    res.json({ backups: files, path: backupDir });
  } catch (error) {
    log.error("Failed to list backups:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Restore from backup
router.post("/restore/:filename", async (req, res) => {
  try {
    const backupDir = await getBackupPath();
    const configPath = await getServerConfigPath();

    // Sanitize filename to prevent path traversal
    const filename = path.basename(req.params.filename);
    log.info(`POST /restore: filename=${filename}`);

    if (!filename.endsWith(".bak")) {
      return res.status(400).json({ error: "Invalid backup file extension" });
    }

    const backupPath = path.join(backupDir, filename);

    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: "Backup not found" });
    }

    // Extract original filename from backup name (e.g., "servertest.ini.2024-01-01T12-00-00.bak")
    const parts = filename.split(".");
    if (parts.length < 3) {
      return res.status(400).json({ error: "Invalid backup filename" });
    }

    // Get original filename (everything before the timestamp)
    const bakIndex = filename.lastIndexOf(".bak");
    const timestampStart = filename.lastIndexOf(".", bakIndex - 1);
    const originalName = filename.substring(0, timestampStart);

    const targetPath = path.join(configPath, originalName);

    // Create backup of current before restoring
    if (fs.existsSync(targetPath)) {
      await createBackup(originalName);
    }

    await fs.promises.copyFile(backupPath, targetPath);

    log.info(`Restored from backup: ${filename} -> ${originalName}`);
    res.json({
      success: true,
      message: `Restored ${originalName} from backup`,
    });
  } catch (error) {
    log.error("Failed to restore backup:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Save and reload (calls RCON reloadoptions)
router.post("/save-and-reload", async (req, res) => {
  try {
    log.info("POST /save-and-reload");
    const rconService = req.app.get("rconService");

    if (!rconService || !rconService.isConnected()) {
      return res
        .status(400)
        .json({ error: "RCON not connected. Changes saved but not reloaded." });
    }

    const result = await rconService.reloadOptions();
    res.json({ success: true, message: "Options reloaded", result });
  } catch (error) {
    log.error("Failed to reload options:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ===== CONFIG TEMPLATES =====

// Get templates directory
async function getTemplatesPath() {
  const configPath = await getServerConfigPath();
  return path.join(configPath, "templates");
}

// Ensure templates directory exists
async function ensureTemplatesDir() {
  const templatesPath = await getTemplatesPath();
  if (!fs.existsSync(templatesPath)) {
    fs.mkdirSync(templatesPath, { recursive: true });
  }
  return templatesPath;
}

// GET /templates - List all saved templates
router.get("/templates", async (req, res) => {
  try {
    const templatesPath = await ensureTemplatesDir();

    const files = fs
      .readdirSync(templatesPath)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const filePath = path.join(templatesPath, f);
          const stats = fs.statSync(filePath);
          const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          return {
            id: f.replace(".json", ""),
            name: content.name || f.replace(".json", ""),
            description: content.description || "",
            type: content.type || "both", // 'ini', 'sandbox', or 'both'
            created: content.created || stats.birthtime.toISOString(),
            modified: stats.mtime.toISOString(),
            hasIni: !!content.ini,
            hasSandbox: !!content.sandbox,
          };
        } catch (e) {
          log.debug(`Template read failed for ${f}: ${e.message}`);
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.modified) - new Date(a.modified));

    res.json({ templates: files });
  } catch (error) {
    log.error("Failed to list templates:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// GET /templates/:id - Get a specific template
router.get("/templates/:id", async (req, res) => {
  try {
    // Sanitize template ID to prevent path traversal
    const safeId = path.basename(req.params.id).replace(/[^a-z0-9_-]/gi, "");
    if (!safeId || safeId !== req.params.id) {
      return res.status(400).json({ error: "Invalid template ID" });
    }

    const templatesPath = await getTemplatesPath();
    const templateFile = path.join(templatesPath, `${safeId}.json`);

    if (!fs.existsSync(templateFile)) {
      return res.status(404).json({ error: "Template not found" });
    }

    const content = JSON.parse(fs.readFileSync(templateFile, "utf-8"));
    res.json(content);
  } catch (error) {
    log.error("Failed to get template:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// POST /templates - Save current config as a template
router.post("/templates", async (req, res) => {
  log.info("POST /templates (create)");
  try {
    const {
      name,
      description,
      includeIni = true,
      includeSandbox = true,
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Template name is required" });
    }

    const templatesPath = await ensureTemplatesDir();
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();

    // Generate safe filename from name with uniqueness check
    const baseId = name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_")
      .substring(0, 50);
    let safeId = baseId;
    let counter = 1;
    while (fs.existsSync(path.join(templatesPath, `${safeId}.json`))) {
      safeId = `${baseId}_${counter++}`;
      if (counter > 100) {
        return res
          .status(400)
          .json({ error: "Too many templates with similar names" });
      }
    }
    const templateFile = path.join(templatesPath, `${safeId}.json`);

    const template = {
      name,
      description: description || "",
      type:
        includeIni && includeSandbox ? "both" : includeIni ? "ini" : "sandbox",
      created: new Date().toISOString(),
      serverName,
    };

    // Read current INI settings
    if (includeIni) {
      const iniPath = path.join(configPath, `${serverName}.ini`);
      if (fs.existsSync(iniPath)) {
        const iniContent = fs.readFileSync(iniPath, "utf-8");
        template.ini = parseIni(iniContent);
        template.iniRaw = iniContent;
      }
    }

    // Read current Sandbox settings
    if (includeSandbox) {
      const sandboxPath = path.join(
        configPath,
        `${serverName}_SandboxVars.lua`,
      );
      if (fs.existsSync(sandboxPath)) {
        template.sandboxRaw = fs.readFileSync(sandboxPath, "utf-8");
      }
    }

    fs.writeFileSync(templateFile, JSON.stringify(template, null, 2));
    log.info(`Created template: ${name} (${safeId})`);

    res.json({
      success: true,
      id: safeId,
      name,
      message: `Template "${name}" saved successfully`,
    });
  } catch (error) {
    log.error("Failed to save template:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// POST /templates/:id/apply - Apply a template to current config
router.post("/templates/:id/apply", async (req, res) => {
  log.info(`POST /templates/${req.params.id}/apply`);
  try {
    // Sanitize template ID to prevent path traversal
    const safeId = path.basename(req.params.id).replace(/[^a-z0-9_-]/gi, "");
    if (!safeId || safeId !== req.params.id) {
      return res.status(400).json({ error: "Invalid template ID" });
    }

    const { applyIni = true, applySandbox = true } = req.body;

    const templatesPath = await getTemplatesPath();
    const templateFile = path.join(templatesPath, `${safeId}.json`);

    if (!fs.existsSync(templateFile)) {
      return res.status(404).json({ error: "Template not found" });
    }

    const template = JSON.parse(fs.readFileSync(templateFile, "utf-8"));
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();

    const applied = [];

    // Apply INI settings
    if (applyIni && template.iniRaw) {
      const iniPath = path.join(configPath, `${serverName}.ini`);

      // Create backup first
      await createBackup(`${serverName}.ini`);

      // Write the template INI
      fs.writeFileSync(iniPath, template.iniRaw);
      applied.push("INI");
      log.info(`Applied INI from template: ${template.name}`);
    }

    // Apply Sandbox settings
    if (applySandbox && template.sandboxRaw) {
      const sandboxPath = path.join(
        configPath,
        `${serverName}_SandboxVars.lua`,
      );

      // Create backup first
      await createBackup(`${serverName}_SandboxVars.lua`);

      // Write the template sandbox
      fs.writeFileSync(sandboxPath, template.sandboxRaw);
      applied.push("Sandbox");
      log.info(`Applied Sandbox from template: ${template.name}`);
    }

    if (applied.length === 0) {
      return res
        .status(400)
        .json({ error: "No settings to apply from this template" });
    }

    res.json({
      success: true,
      applied,
      message: `Applied ${applied.join(" and ")} settings from "${template.name}"`,
    });
  } catch (error) {
    log.error("Failed to apply template:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// PUT /templates/:id - Update template metadata
router.put("/templates/:id", async (req, res) => {
  try {
    // Sanitize template ID to prevent path traversal
    const safeId = path.basename(req.params.id).replace(/[^a-z0-9_-]/gi, "");
    if (!safeId || safeId !== req.params.id) {
      return res.status(400).json({ error: "Invalid template ID" });
    }

    const { name, description } = req.body;

    const templatesPath = await getTemplatesPath();
    const templateFile = path.join(templatesPath, `${safeId}.json`);

    if (!fs.existsSync(templateFile)) {
      return res.status(404).json({ error: "Template not found" });
    }

    const template = JSON.parse(fs.readFileSync(templateFile, "utf-8"));

    if (name) template.name = name;
    if (description !== undefined) template.description = description;
    template.modified = new Date().toISOString();

    fs.writeFileSync(templateFile, JSON.stringify(template, null, 2));

    res.json({ success: true, message: "Template updated" });
  } catch (error) {
    log.error("Failed to update template:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// DELETE /templates/:id - Delete a template
router.delete("/templates/:id", async (req, res) => {
  log.info(`DELETE /templates/${req.params.id}`);
  try {
    // Sanitize template ID to prevent path traversal
    const safeId = path.basename(req.params.id).replace(/[^a-z0-9_-]/gi, "");
    if (!safeId || safeId !== req.params.id) {
      return res.status(400).json({ error: "Invalid template ID" });
    }

    const templatesPath = await getTemplatesPath();
    const templateFile = path.join(templatesPath, `${safeId}.json`);

    if (!fs.existsSync(templateFile)) {
      return res.status(404).json({ error: "Template not found" });
    }

    fs.unlinkSync(templateFile);
    log.info(`Deleted template: ${req.params.id}`);

    res.json({ success: true, message: "Template deleted" });
  } catch (error) {
    log.error("Failed to delete template:", error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ===== FILE BROWSER (for image path fields) =====

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".webp",
]);

/**
 * Build the list of directories the file browser is allowed to access.
 * Restricts browsing to the server config path, server install path,
 * and Zomboid data path — prevents arbitrary filesystem traversal.
 */
async function getAllowedBrowseRoots() {
  const roots = [];
  const activeServer = await getActiveServer();
  if (activeServer?.serverConfigPath)
    roots.push(path.resolve(activeServer.serverConfigPath));
  if (activeServer?.zomboidDataPath)
    roots.push(path.resolve(activeServer.zomboidDataPath));
  if (activeServer?.serverPath)
    roots.push(path.resolve(activeServer.serverPath));
  const settings = await getAllSettings();
  if (settings.serverConfigPath)
    roots.push(path.resolve(settings.serverConfigPath));
  if (settings.zomboidDataPath)
    roots.push(path.resolve(settings.zomboidDataPath));
  // Always allow the default Zomboid config directory
  const defaultConfig = path.join(os.homedir(), "Zomboid");
  roots.push(path.resolve(defaultConfig));
  // De-duplicate
  return [...new Set(roots)];
}

/**
 * Check whether `target` is equal to or inside one of `allowedRoots`.
 * Returns the resolved target if allowed, or null if it escapes all roots.
 */
function confineToRoots(target, allowedRoots) {
  const resolved = path.resolve(target);
  for (const root of allowedRoots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return resolved;
    }
  }
  return null;
}

// GET /browse-files - List directories and files at a given path
router.get("/browse-files", async (req, res) => {
  try {
    const browsePath = req.query.path ? String(req.query.path) : null;
    const filterExts = req.query.extensions
      ? String(req.query.extensions)
          .split(",")
          .map((e) => e.toLowerCase().trim())
      : null;

    const allowedRoots = await getAllowedBrowseRoots();
    let targetPath;
    if (browsePath) {
      targetPath = confineToRoots(browsePath, allowedRoots);
      if (!targetPath) {
        return res.status(403).json({
          error: "Access denied: path is outside allowed server directories",
        });
      }
    } else {
      // Default to the server config directory
      const configPath = await getServerConfigPath();
      targetPath = configPath || "";
    }

    if (!targetPath) {
      return res
        .status(400)
        .json({ error: "No path provided and server config path not set" });
    }

    if (!fs.existsSync(targetPath)) {
      return res.status(400).json({ error: "Path does not exist" });
    }

    const stat = await fs.promises.stat(targetPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: "Path is not a directory" });
    }

    const entries = await fs.promises.readdir(targetPath, {
      withFileTypes: true,
    });

    const directories = [];
    const files = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Skip hidden/system directories
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
          directories.push(entry.name);
        }
      } else {
        // Treat everything that's not a directory as a potential file
        // (avoids issues with pkg/Dirent.isFile() not working for some entries)
        const ext = path.extname(entry.name).toLowerCase();
        // If extension filter is provided, only show matching files
        if (filterExts) {
          if (filterExts.includes(ext)) {
            files.push({ name: entry.name, ext });
          }
        } else {
          // Default: show image files only
          if (IMAGE_EXTENSIONS.has(ext)) {
            files.push({ name: entry.name, ext });
          }
        }
      }
    }

    directories.sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
    files.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

    res.json({
      currentPath: targetPath,
      parent:
        path.dirname(targetPath) !== targetPath &&
        confineToRoots(path.dirname(targetPath), allowedRoots)
          ? path.dirname(targetPath)
          : null,
      directories,
      files,
    });
  } catch (error) {
    log.error(`Failed to browse files: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// GET /image-preview - Serve an image file for preview (limited to image types, max 5MB)
router.get("/image-preview", async (req, res) => {
  try {
    const filePath = req.query.path ? String(req.query.path) : null;
    if (!filePath) {
      return res.status(400).json({ error: "Path is required" });
    }

    const allowedRoots = await getAllowedBrowseRoots();
    const resolved = confineToRoots(filePath, allowedRoots);
    if (!resolved) {
      return res.status(403).json({
        error: "Access denied: path is outside allowed server directories",
      });
    }

    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: "File not found" });
    }

    const ext = path.extname(resolved).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      return res.status(400).json({ error: "Not an image file" });
    }

    const stat = await fs.promises.stat(resolved);
    if (stat.size > 5 * 1024 * 1024) {
      return res.status(400).json({ error: "Image file exceeds 5MB limit" });
    }

    const mimeMap = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".bmp": "image/bmp",
      ".webp": "image/webp",
    };
    const contentType = mimeMap[ext] || "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=60");
    const previewStream = fs.createReadStream(resolved);
    previewStream.on("error", (err) => {
      log.error(`Image preview stream error: ${err.message}`);
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    previewStream.pipe(res);
  } catch (error) {
    log.error(`Failed to serve image preview: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
