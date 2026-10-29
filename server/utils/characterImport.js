// A skill's level in the game runs 0..10.
export const CHARACTER_PERK_LEVEL_MAX = 10;

/**
 * Why the bridge should not be sent this character import (an English
 * sentence; routes/panelBridge.js answers it with 400
 * PANELBRIDGE_CHARACTER_PERK_INVALID), or null.
 *
 * SECURITY (2026-10-20): PanelBridge's importPlayerData levels each perk once
 * per level in the file, so a level of 1e9 froze the game server. The bridge
 * clamps the level itself (PanelBridge.lua); the panel refuses such a file
 * outright so the operator learns it is wrong. `perks` must be an object of
 * perk entries, and each entry's level, when it has one, a whole number from
 * 0 to 10. Exports always look like that.
 *
 * @param {unknown} data - The import's `data` object.
 * @returns {string | null}
 */
export function characterImportRefusal(data) {
  const perks = data?.perks;
  if (perks === undefined || perks === null) return null;
  // The bridge's JSON encoder writes every EMPTY Lua table as [] (an export whose
  // skills could not be read has "perks": []): that is "no skills", not bad data.
  if (Array.isArray(perks) && perks.length === 0) return null;
  const refuse = (where) =>
    `Each skill in the character data must have a whole-number level from 0 to ${CHARACTER_PERK_LEVEL_MAX} (${JSON.stringify(String(where).slice(0, 64))}).`;
  if (typeof perks !== "object" || Array.isArray(perks)) return refuse("perks");
  for (const [name, entry] of Object.entries(perks)) {
    if (Array.isArray(entry) && entry.length === 0) continue; // an empty skill entry, same encoder rule
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return refuse(name);
    const level = entry.level;
    if (level === undefined || level === null) continue;
    if (!Number.isInteger(level) || level < 0 || level > CHARACTER_PERK_LEVEL_MAX) return refuse(name);
  }
  return null;
}

// What PanelBridge's importPlayerData reads from an inventory entry.
const IMPORT_ITEM_NUMBER_FIELDS = ["count", "condition", "uses", "jobDelta", "useDelta", "delta"];
// An export lists at most 1000 items (bag contents included); hand-made
// files get twice that.
export const CHARACTER_IMPORT_MAX_ITEMS = 2000;
// The bridge restores bag contents three levels deep and exports four.
const IMPORT_CONTENTS_MAX_DEPTH = 4;
const IMPORT_MAX_PERKS = 256;
const IMPORT_NAME_MAX_LENGTH = 128;

const UNSAFE_NAME_CHARS = new RegExp(`["\\\\${String.fromCharCode(0)}-${String.fromCharCode(0x1f, 0x7f)}]`);

function plainName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= IMPORT_NAME_MAX_LENGTH
    && !UNSAFE_NAME_CHARS.test(value);
}

function importNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 32 && value.trim() !== "" && Number.isFinite(Number(value))) return value;
  return undefined;
}

/**
 * The args to send the bridge for a character import, keeping only what
 * PanelBridge's importPlayerData reads (perks, inventory and two options),
 * or why the import is refused.
 *
 * SECURITY (2026-10-28): the mod parses every command on the game thread,
 * and it tried each listed item up to 100 times whether it existed or not,
 * so a 1 MB import body of made-up items stalled the server. The bridge now
 * stops on a missing item and counts attempts; the panel sends only the
 * fields the bridge uses (an export also carries names, worn items, bag
 * copies, recipes and diagnostics) and refuses more than 2000 items or an
 * item type that is no plain name.
 *
 * @param {{ username: unknown, data: any, options?: any }} input
 * @returns {{ args: object } | { refusal: string, kind: "perks" | "inventory" }}
 */
export function characterImportArgs({ username, data, options }) {
  const perkRefusal = characterImportRefusal(data);
  if (perkRefusal) return { refusal: perkRefusal, kind: "perks" };
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { args: { username, data, ...(options === undefined ? {} : { options }) } };
  }

  const out = {};
  if (data.perks !== undefined && data.perks !== null) {
    if (Array.isArray(data.perks)) {
      out.perks = data.perks;
    } else {
      const perks = {};
      let kept = 0;
      for (const [name, entry] of Object.entries(data.perks)) {
        if (kept >= IMPORT_MAX_PERKS) break;
        if (!plainName(name) || entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
        const perk = {};
        if (Number.isInteger(entry.level)) perk.level = entry.level;
        const xp = importNumber(entry.xp);
        if (xp !== undefined) perk.xp = xp;
        perks[name] = perk;
        kept++;
      }
      out.perks = perks;
    }
  }

  if (data.inventory !== undefined && data.inventory !== null) {
    if (!Array.isArray(data.inventory)) {
      return { refusal: "The character data's inventory must be a list of items.", kind: "inventory" };
    }
    let total = 0;
    let badType = null;
    const copyItems = (list, depth) => {
      const items = [];
      for (const entry of list) {
        if (badType !== null || total > CHARACTER_IMPORT_MAX_ITEMS) return items;
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
        if (entry.fullType === undefined || entry.fullType === null) continue;
        total++;
        if (!plainName(entry.fullType)) {
          badType = String(entry.fullType).slice(0, 64);
          return items;
        }
        const item = { fullType: entry.fullType };
        for (const field of IMPORT_ITEM_NUMBER_FIELDS) {
          const value = importNumber(entry[field]);
          if (value !== undefined) item[field] = value;
        }
        if (Array.isArray(entry.contents) && depth < IMPORT_CONTENTS_MAX_DEPTH) {
          item.contents = copyItems(entry.contents, depth + 1);
        }
        items.push(item);
      }
      return items;
    };
    out.inventory = copyItems(data.inventory, 1);
    if (badType !== null) {
      return {
        refusal: `The character data lists an item type that is not a plain item name (${JSON.stringify(badType)}).`,
        kind: "inventory",
      };
    }
    if (total > CHARACTER_IMPORT_MAX_ITEMS) {
      return {
        refusal: `The character data lists more than ${CHARACTER_IMPORT_MAX_ITEMS} items.`,
        kind: "inventory",
      };
    }
  }

  const args = { username, data: out };
  if (options !== null && typeof options === "object" && !Array.isArray(options)) {
    const kept = {};
    for (const key of ["restorePerks", "restoreInventory"]) {
      if (typeof options[key] === "boolean") kept[key] = options[key];
    }
    args.options = kept;
  }
  return { args };
}
