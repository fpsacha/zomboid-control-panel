import fs from "fs";
import path from "path";
import { createLogger } from "./logger.js";
import { getSqlJs, SqlJsUnavailableError } from "./sqlJs.js";
import { assertPlainTables, readGameDbFile, withGameDbLoadSlot } from "./gameSqliteFile.js";

const log = createLogger("WhitelistDB");
const ROLE_NAMES = new Map([
  [1, "banned"],
  [2, "user"],
  [3, "priority"],
  [4, "observer"],
  [5, "gm"],
  [6, "moderator"],
  [7, "admin"],
]);
// The tables read here. SECURITY (2026-10-28, vehicles audit R2-21/R2-22):
// the file is the game server's, so it is read through gameSqliteFile.js
// (never a link or FIFO, one of the process-wide load slots) and these must
// be plain tables: a view over an endless recursive CTE would hang sql.js,
// and with it the whole panel.
const QUERIED_TABLES = ["role", "whitelist", "allowedsteamid"];

// Open the server database and run fn on it, inside a load slot.
async function withServerDatabase(dbPath, fn) {
  const SQL = await getSqlJs();
  return withGameDbLoadSlot(async () => {
    const { buffer } = await readGameDbFile(dbPath);
    const db = new SQL.Database(buffer);
    try {
      assertPlainTables(db, path.basename(dbPath), QUERIED_TABLES);
      return fn(db);
    } finally {
      db.close();
    }
  });
}

// The panel's own SQLite engine could not start (see sqlJs.js), as opposed to
// this server's database being unreadable.
const SQLITE_UNAVAILABLE_REASON =
  "The panel's SQLite engine could not start. Update or reinstall the panel, then restart it.";

export function getWhitelistDatabasePath(zomboidDataPath, serverName) {
  if (
    typeof zomboidDataPath !== "string" ||
    !zomboidDataPath ||
    typeof serverName !== "string" ||
    !serverName ||
    serverName === "." ||
    serverName === ".." ||
    /[\\/\0]/.test(serverName)
  ) {
    return null;
  }
  return path.join(zomboidDataPath, "db", `${serverName}.db`);
}

// Roles.getRoles() (see zombie.network.GameServer.changeRole()) is a live,
// DB-backed table, not the fixed ROLE_NAMES defaults above -- an admin can
// rename/add/remove roles at runtime via the in-game role editor. Shared by
// listWhitelistAccounts (resolving a whitelist row's role id to a name) and
// listServerRoleNames (enumerating the access levels this server actually
// has) so both read the exact same table the exact same way.
function loadRoleMap(db) {
  const roles = new Map(ROLE_NAMES);
  const roleResult = db.exec("SELECT id, name FROM role");
  for (const [id, name] of roleResult[0]?.values || []) {
    if (Number.isInteger(Number(id)) && typeof name === "string") {
      roles.set(Number(id), name);
    }
  }
  return roles;
}

export async function listWhitelistAccounts(zomboidDataPath, serverName) {
  const dbPath = getWhitelistDatabasePath(zomboidDataPath, serverName);
  if (!dbPath) {
    return { available: false, accounts: [], reason: "Invalid server database path" };
  }
  if (!fs.existsSync(dbPath)) {
    return { available: false, accounts: [], reason: "Whitelist database not found" };
  }

  try {
    return await withServerDatabase(dbPath, (db) => {
      const accounts = [];
      const allowedSteamIds = [];
      const roles = loadRoleMap(db);

      const statement = db.prepare(
        "SELECT id, username, lastConnection, role, authType, steamid, ownerid, displayName FROM whitelist WHERE world = ? OR world = '' OR world IS NULL ORDER BY lower(COALESCE(username, '')), id",
      );
      try {
        statement.bind([serverName]);
        while (statement.step()) {
          const row = statement.getAsObject();
          accounts.push({
            id: Number(row.id),
            username: row.username || "",
            lastConnection: row.lastConnection || null,
            role: roles.get(Number(row.role)) || `role-${Number(row.role)}`,
            authType: Number(row.authType) || 0,
            steamId: row.steamid || null,
            ownerId: row.ownerid || null,
            displayName: row.displayName || null,
          });
        }
      } finally {
        statement.free();
      }

      try {
        const allowedResult = db.exec("SELECT steamid FROM allowedsteamid ORDER BY steamid");
        for (const [steamId] of allowedResult[0]?.values || []) {
          if (typeof steamId === "string" && /^\d{17}$/.test(steamId)) {
            allowedSteamIds.push(steamId);
          }
        }
      } catch (error) {
        log.debug(`Allowed SteamID table is unavailable in ${dbPath}: ${error.message}`);
      }
      return { available: true, accounts, allowedSteamIds };
    });
  } catch (error) {
    if (error instanceof SqlJsUnavailableError) {
      log.error(error.message);
      return { available: false, accounts: [], reason: SQLITE_UNAVAILABLE_REASON };
    }
    log.warn(`Could not read whitelist database ${dbPath}: ${error.message}`);
    return { available: false, accounts: [], reason: "Whitelist database could not be read" };
  }
}

// The server's real access levels, per access-levels-should-come-from-the-
// server-not-a-hardcoded-array: Roles.getRoles() is a live, DB-backed table
// (this same [role] table, read via getWhitelistDatabasePath -- the name is
// whitelist-specific, the path it resolves is not), not a fixed list, so a
// hardcoded array is wrong in principle even when it happens to be correct
// today. 'none' is deliberately NOT added here -- it is a SetAccessLevelCommand
// special case that never reaches this table (confirmed absent from both a
// real jar read and ROLE_NAMES's own defaults), so callers that need it as a
// selectable level must add it themselves, same as this file already
// requires no other 'none' handling anywhere else in its role-table reads.
export async function listServerRoleNames(zomboidDataPath, serverName) {
  const dbPath = getWhitelistDatabasePath(zomboidDataPath, serverName);
  if (!dbPath) {
    return { available: false, roleNames: [], reason: "Invalid server database path" };
  }
  if (!fs.existsSync(dbPath)) {
    return { available: false, roleNames: [], reason: "Server database not found" };
  }

  try {
    return await withServerDatabase(dbPath, (db) => {
      const roles = loadRoleMap(db);
      return { available: true, roleNames: [...roles.values()] };
    });
  } catch (error) {
    if (error instanceof SqlJsUnavailableError) {
      log.error(error.message);
      return { available: false, roleNames: [], reason: SQLITE_UNAVAILABLE_REASON };
    }
    log.warn(`Could not read role table from ${dbPath}: ${error.message}`);
    return { available: false, roleNames: [], reason: "Server database could not be read" };
  }
}
