/**
 * RCON passwords out of db.json, WITHOUT changing the in-memory data
 * model every other file in the codebase already reads and writes
 * (db.data.servers[].rconPassword, db.data.settings.rconPassword via
 * getSetting/setSetting).
 *
 * Unlike the JWT key or the Discord/Steam scalars, rconPassword is not a
 * single top-level setting — it's a field on every row of
 * db.data.servers[] (this panel manages multiple server profiles), plus a
 * duplicated mirror in db.data.settings for legacy pre-multi-server
 * installs. A sibling file (the JWT/Discord/Steam playbook) doesn't fit an
 * array of records. So instead of relocating the field itself — which
 * would mean rewriting every read/write site in routes/servers.js,
 * routes/server.js, services/rcon.js, services/serverManager.js,
 * routes/debug.js, routes/discovery.js and their ~40 existing tests, all
 * of which assume the field lives directly on the in-memory record — this
 * redacts ONLY at the disk-serialization boundary:
 *
 *   - redactRconSecretsForWrite() runs inside database/init.js's
 *     flushWrites(), right before JSON.stringify. It persists any
 *     in-memory rconPassword to its own file and returns a CLONE with
 *     those fields omitted for serialization. The real db.data object is
 *     never mutated — every existing reader keeps seeing rconPassword
 *     exactly as before, in memory.
 *   - rehydrateRconSecrets() runs once per load (every startup — NOT
 *     gated by schema version like runMigrations(), since db.json itself
 *     never carries these values once a single write has happened): fills
 *     in any server's rconPassword from its sibling file when the
 *     in-memory value is missing. A value that's still present (a
 *     pre-upgrade db.json, or any server not yet through a write cycle
 *     after upgrading) is left as-is — the very next write persists it to
 *     its own file and strips it from disk, so migration happens for free
 *     on the first write rather than needing a separate one-time step.
 *
 * db.data.settings.rconPassword (the legacy global mirror) is treated as
 * its own independent scalar via utils/uiSecretFile.js — same mechanism
 * as discordBotToken/steamSessionId — because some installs carry a
 * rconPassword in settings with NO corresponding server row at all (see
 * services/rcon.js loadConfig()'s "legacy settings" fallback), so it
 * can't simply be recomputed from an active server.
 */

import fs from "fs";
import path from "path";
import { getDataPaths } from "./paths.js";
import { readUiSecretFile, writeUiSecretFile } from "./uiSecretFile.js";
import { restrictSecretFileSync } from "./secretFileAcl.js";

function secretsDir() {
  return path.join(getDataPaths().dataDir, "server-secrets");
}

// Server ids are our own randomUUID()s, never operator-supplied — sanitized
// anyway so a malformed id can never escape the secrets directory.
function serverSecretPath(serverId) {
  const safeId = String(serverId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(secretsDir(), `${safeId}.secret`);
}

function ensureSecretsDir() {
  const dir = secretsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best-effort: Windows / network shares */
  }
}

function readServerSecret(serverId, log) {
  const filePath = serverSecretPath(serverId);
  if (!fs.existsSync(filePath)) return null;
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    return value || null;
  } catch (err) {
    log?.warn?.(
      `Could not read the RCON password file for server ${serverId} ` +
        `(${filePath}): ${err.message}. Treating it as unset — re-enter ` +
        "it in the server's settings.",
    );
    return null;
  }
}

// Skips the write (and the mtime/chmod churn) when the value hasn't
// actually changed — flushWrites() runs roughly once a minute in steady
// state (see the performance_history comment in database/init.js), and
// rconPassword rarely does.
function writeServerSecret(serverId, value) {
  const filePath = serverSecretPath(serverId);
  if (value == null || value === "") {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* already absent */
    }
    return;
  }
  try {
    if (fs.readFileSync(filePath, "utf8") === value) return; // unchanged
  } catch {
    /* doesn't exist yet or unreadable — fall through and write it */
  }
  ensureSecretsDir();
  fs.writeFileSync(filePath, value, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best-effort: Windows / network shares */
  }
  restrictSecretFileSync(filePath); // the Windows equivalent (utils/secretFileAcl.js)
}

/** Called when a server profile is deleted, so its password file isn't orphaned. */
export function deleteServerSecret(serverId) {
  try {
    fs.unlinkSync(serverSecretPath(serverId));
  } catch {
    /* already absent, fine */
  }
}

/**
 * Run once per load (see database/init.js — outside runMigrations, which
 * is schema-version-gated and would only run this once ever). Mutates and
 * returns `data` in place; safe to call unconditionally on every startup.
 */
export function rehydrateRconSecrets(data, log) {
  for (const server of data.servers || []) {
    if (!server.rconPassword && server.id) {
      const fromFile = readServerSecret(server.id, log);
      if (fromFile) server.rconPassword = fromFile;
    }
  }
  if (!data.settings) data.settings = {};
  if (!data.settings.rconPassword) {
    const fromFile = readUiSecretFile("rconPassword", log);
    if (fromFile) data.settings.rconPassword = fromFile;
  }
  return data;
}

/**
 * Called inside flushWrites(), immediately before JSON.stringify. Returns
 * a shallow clone of `data` with rconPassword fields omitted for
 * serialization — `data` itself (and every server object it contains) is
 * NEVER mutated, so every other reader in the codebase keeps seeing
 * rconPassword on the real in-memory objects exactly as it does today.
 */
export function redactRconSecretsForWrite(data) {
  // `server.rconPassword !== undefined`, not a truthiness check: a truthy
  // check treated an explicit "" (operator clears the password via PUT
  // /servers/:id, which accepts and persists an empty string same as any
  // other value -- see routes/servers.js's rconPassword validation) the
  // same as the field never having been touched at all, so
  // writeServerSecret() -- the only thing that ever deletes the sibling
  // .secret file -- was never called. The stale file survived on disk,
  // and the very next load's rehydrateRconSecrets() read it back in,
  // silently undoing the clear on the next restart. `!== undefined` still
  // skips servers that never had this key touched (no unnecessary
  // unlink-of-nothing on every flushWrites() cycle), but now reaches ""
  // and null the same way writeServerSecret()'s own guard already expects.
  // Found bughunt-2026-08-31-c (server/utils sweep), same shape in both
  // branches below -- the legacy settings.rconPassword mirror had it too.
  const redactedServers = (data.servers || []).map((server) => {
    if (server.rconPassword !== undefined) {
      writeServerSecret(server.id, server.rconPassword);
      const { rconPassword: _rconPassword, ...rest } = server;
      return rest;
    }
    return server;
  });

  let redactedSettings = data.settings;
  if (data.settings && data.settings.rconPassword !== undefined) {
    writeUiSecretFile("rconPassword", data.settings.rconPassword);
    const { rconPassword: _rconPassword, ...rest } = data.settings;
    redactedSettings = rest;
  }

  return { ...data, servers: redactedServers, settings: redactedSettings };
}
