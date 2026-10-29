// When a start hands the game its admin password, and how.
//
// SECURITY (2026-10-28, audit R1-30/R1-35): the panel used to write
// `-adminpassword <password>` as literal text into StartServer_<name>.bat and
// start-server_<name>.sh, and pass it on EVERY start. On Windows the .bat's
// 0600 mode does nothing (Node only toggles the read-only attribute), so it
// kept the install folder's ACL: readable by every local account. On Linux
// the JVM carried it in argv for its whole uptime, which every local account
// reads through /proc/<pid>/cmdline.
//
// What the game does with it (projectzomboid.jar, ServerWorldDatabase): when
// the "admin" account is missing from <cachedir>/db/<servername>.db it creates
// it with -adminpassword (or asks on stdin, which the panel can't answer);
// when the account exists, -adminpassword replaces its password ("admin
// password changed via -adminpassword option"). So the value is needed on a
// world's first start and on the start after the password changes, never
// otherwise, and the game reads it from its command line only.
//
// Now:
//  - The generated scripts read it from the PZ_PANEL_ADMIN_PASSWORD
//    environment variable, set by the panel for that one launch, and pass
//    -adminpassword only when it is set. The script files carry no password.
//  - The panel sets it only when it is needed (adminPasswordForLaunch()).
//  - A systemd/OpenRC unit can't be handed an environment by the panel, so
//    for one the .sh carries the password as text for exactly those starts
//    and is rewritten without it before the next.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.js";
import { getDataPaths } from "../utils/paths.js";
import { writeFileAtomic } from "../utils/fileWriteQueue.js";
import { serverHasWorldFolder } from "../utils/savesFolder.js";
import { startScriptValueProblem } from "../utils/startScriptQuoting.js";

const log = createLogger("AdminPassword");

export const ADMIN_PASSWORD_ENV = "PZ_PANEL_ADMIN_PASSWORD";

// Per server id: a salted scrypt fingerprint of the password last passed to
// the game, when it was passed, and whether the game has since written its
// account database (proof the start got that far). In the panel's own data
// folder, owner-only, next to db.json -- never next to the scripts.
const APPLIED_FILE = "admin-password-applied.json";
const FINGERPRINT_BYTES = 32;

function appliedFilePath() {
  return path.join(getDataPaths().dataDir, APPLIED_FILE);
}

function readApplied() {
  try {
    const parsed = JSON.parse(fs.readFileSync(appliedFilePath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeApplied(applied) {
  try {
    writeFileAtomic(appliedFilePath(), JSON.stringify(applied, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    // Nothing recorded means the password is passed again next start: the
    // old behaviour, never a start without it.
    log.warn(`Could not record which admin password the game was given: ${error.message}`);
  }
}

function fingerprintOf(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, FINGERPRINT_BYTES);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

function fingerprintMatches(password, stored) {
  if (typeof stored !== "string") return false;
  const [kind, saltHex, hashHex] = stored.split(":");
  if (kind !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== FINGERPRINT_BYTES) return false;
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), FINGERPRINT_BYTES);
  return crypto.timingSafeEqual(actual, expected);
}

// The game's account database for this server, as -cachedir points it.
export function serverAccountDbPath(server) {
  if (!server?.zomboidDataPath || !server?.serverName) return null;
  return path.join(String(server.zomboidDataPath), "db", `${server.serverName}.db`);
}

// Latest write to the account database (SQLite may hold it in the -wal file).
function accountDbWrittenAt(dbPath) {
  let latest = null;
  for (const file of [dbPath, `${dbPath}-wal`]) {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (latest === null || mtime > latest) latest = mtime;
    } catch {
      /* not there */
    }
  }
  return latest;
}

/**
 * The admin password this launch must hand the game, or "" when it must not.
 * Passed when the server has never got past creating its admin account (no
 * account database, or no world folder yet), when the configured password is
 * not the one last passed, and when the start that passed it never reached
 * the account database. Unknown is always "pass it": a start without the
 * password where the game needs it stops at a stdin prompt.
 */
export function adminPasswordForLaunch(server) {
  const password = server?.adminPassword ? String(server.adminPassword) : "";
  if (!password || server?.isRemote) return "";
  // A double quote or a control character is refused where the password is
  // saved (startScriptValues.js): in the .bat it would end the quoted word
  // and run the rest as commands. One saved before that rule is not passed.
  if (startScriptValueProblem(password)) {
    log.warn(
      `Not passing the admin password of "${server.serverName}" to the game: it holds a double quote or a control character, which the start script can't carry. Set a new one on the My Servers page.`,
    );
    return "";
  }
  const dbPath = serverAccountDbPath(server);
  if (!dbPath || server.id == null) return password;
  if (!fs.existsSync(dbPath)) return password;
  if (!serverHasWorldFolder(server.zomboidDataPath, server.serverName)) return password;

  const applied = readApplied();
  const record = applied[String(server.id)];
  if (!record || !fingerprintMatches(password, record.fingerprint)) return password;
  if (record.confirmed) return "";
  const writtenAt = accountDbWrittenAt(dbPath);
  if (writtenAt !== null && Number.isFinite(record.passedAt) && writtenAt > record.passedAt) {
    applied[String(server.id)] = { ...record, confirmed: true };
    writeApplied(applied);
    return "";
  }
  return password;
}

/** Records that this launch hands the game `password` (see above). */
export function recordAdminPasswordPassed(server, password) {
  if (!password || server?.id == null) return;
  const applied = readApplied();
  applied[String(server.id)] = { fingerprint: fingerprintOf(password), passedAt: Date.now(), confirmed: false };
  writeApplied(applied);
}

/**
 * The value of ADMIN_PASSWORD_ENV for `password`. The .bat puts it between
 * double quotes for the Java launcher, which splits its command line by the
 * C runtime's rules: a backslash before the closing quote would escape it, so
 * a run of them at the end is doubled (as quoteForBatch() does). Nothing else
 * needs escaping: cmd.exe does not expand %...% or !...! again in a value it
 * has already expanded, and the script turns delayed expansion off. A double
 * quote or a control character never gets here (startScriptValues.js).
 */
export function adminPasswordEnvValue(password, platform = process.platform) {
  const text = String(password ?? "");
  if (platform !== "win32") return text;
  let end = text.length;
  while (end > 0 && text[end - 1] === "\\") end -= 1;
  return text + text.slice(end);
}

/**
 * `env` for a direct launch of a panel-generated script: ADMIN_PASSWORD_ENV
 * set to `password` (what adminPasswordForLaunch() decided for this launch,
 * from the record as it is now) or removed when it is empty, so a value the
 * panel itself inherited never reaches the game. A password the start script
 * can't carry is never set (see adminPasswordForLaunch()).
 */
export function launchEnvWithAdminPassword(password, env = process.env, platform = process.platform) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.toUpperCase() === ADMIN_PASSWORD_ENV) delete next[key];
  }
  const text = password ? String(password) : "";
  if (text && !startScriptValueProblem(text)) {
    next[ADMIN_PASSWORD_ENV] = adminPasswordEnvValue(text, platform);
  }
  return next;
}
