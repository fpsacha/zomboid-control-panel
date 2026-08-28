/**
 * Storage for operator-ENTERED credentials that must stay editable through
 * the settings UI (Discord bot token, Steam session cookies) — as opposed
 * to utils/jwtSecret.js, which is panel-generated and invisible to the
 * operator.
 *
 * Same reason to move out of db.json as the JWT key: both backup paths
 * (database/init.js's rotation ring, backupService.js's opt-in zip) copy
 * db.json by literal filename, not a directory sweep, so a sibling file
 * here is excluded from both.
 *
 * Deliberately NOT the same failure posture as jwt.secret. Losing the JWT
 * key means every session is invalid and the panel refuses to start — that
 * is proportionate because there is no other way back in. Losing one of
 * these means the Discord bot stops responding or a Workshop download
 * needs a fresh cookie pasted in from Settings — recoverable through the
 * UI these secrets already live in, with everything else (RCON, the
 * panel's own auth) unaffected. So an unreadable file here logs a warning
 * and is treated as "not configured," it never refuses to start.
 */

import fs from "fs";
import path from "path";
import { getDataPaths } from "./paths.js";

function secretFilePath(name) {
  return path.join(getDataPaths().dataDir, `${name}.secret`);
}

function normalizeUiSecret(value) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim();
  return normalized || null;
}

export function readUiSecretFile(name, log) {
  const filePath = secretFilePath(name);
  if (!fs.existsSync(filePath)) return null;
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    return value || null;
  } catch (err) {
    log?.warn?.(
      `Could not read ${filePath}: ${err.message}. Treating "${name}" as ` +
        "not configured until it is re-entered in Settings.",
    );
    return null;
  }
}

// mode is best-effort: on Windows, fs chmod/mode only toggles the
// read-only attribute, not a real ACL restriction — same documented
// limitation as dataDir/backupDir in database/init.js and jwt.secret,
// not a new gap introduced here.
export function writeUiSecretFile(name, value) {
  const filePath = secretFilePath(name);
  if (value == null || value === "") {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* already absent */
    }
    return;
  }
  fs.writeFileSync(filePath, value, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best-effort: Windows / network shares */
  }
}

/**
 * Replace a related set of UI secrets as one filesystem transaction.
 * Every new value is staged and verified before a live file is touched.
 * Existing files remain available as backups until every replacement has
 * been activated and verified; any failure restores the complete old set.
 */
export function replaceUiSecretFiles(entries) {
  const transactionId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const files = entries.map(([name, value]) => {
    const target = secretFilePath(name);
    return {
      name,
      value: normalizeUiSecret(value),
      target,
      staged: `${target}.tmp-${transactionId}`,
      backup: `${target}.bak-${transactionId}`,
      hadOriginal: fs.existsSync(target),
      backedUp: false,
      activated: false,
    };
  });

  try {
    for (const file of files) {
      if (file.value === null) continue;
      fs.writeFileSync(file.staged, file.value, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      if (fs.readFileSync(file.staged, "utf8").trim() !== file.value) {
        throw new Error(`staged verification failed for ${file.name}`);
      }
    }

    for (const file of files) {
      if (file.hadOriginal) {
        fs.renameSync(file.target, file.backup);
        file.backedUp = true;
      }
    }
    for (const file of files) {
      if (file.value !== null) {
        fs.renameSync(file.staged, file.target);
        file.activated = true;
      }
    }

    for (const file of files) {
      if (readUiSecretFile(file.name) !== file.value) {
        throw new Error(`live verification failed for ${file.name}`);
      }
      if (file.value !== null) {
        try {
          fs.chmodSync(file.target, 0o600);
        } catch {
          /* best-effort: Windows / network shares */
        }
      }
    }

    for (const file of files) {
      try {
        fs.unlinkSync(file.backup);
      } catch {
        /* no previous file */
      }
    }
  } catch (err) {
    const rollbackErrors = [];
    for (const file of files) {
      try {
        if ((file.activated || file.backedUp) && fs.existsSync(file.target)) {
          fs.unlinkSync(file.target);
        }
        if (file.backedUp && fs.existsSync(file.backup)) {
          fs.renameSync(file.backup, file.target);
        }
      } catch (rollbackErr) {
        rollbackErrors.push(`${file.name}: ${rollbackErr.message}`);
      }
      try {
        if (fs.existsSync(file.staged)) fs.unlinkSync(file.staged);
      } catch {
        /* best-effort cleanup */
      }
    }
    const rollbackDetail = rollbackErrors.length
      ? `; rollback incomplete (${rollbackErrors.join(", ")})`
      : "";
    throw new Error(`UI secret transaction failed: ${err.message}${rollbackDetail}`);
  }
}

/**
 * Read a UI-entered secret, migrating a legacy db.json value the first
 * time this runs on an upgraded install. `legacyValue` is whatever the
 * caller's own getSetting(name) already returned — passed in rather than
 * looked up here so this module has no dependency on database/init.js.
 * `clearLegacy` is only called (and awaited) when a migration actually
 * happens, and a failed migration write falls back to using the legacy
 * value for this run rather than losing it or crashing — same
 * non-critical posture as the rest of this file.
 */
export async function loadUiSecret(name, { legacyValue, clearLegacy, log } = {}) {
  const fromFile = readUiSecretFile(name, log);
  if (fromFile) return fromFile;

  if (legacyValue) {
    try {
      writeUiSecretFile(name, legacyValue);
      if (clearLegacy) await clearLegacy();
      log?.warn?.(
        `Moved "${name}" out of db.json into its own file. Same value, safer location.`,
      );
    } catch (err) {
      log?.warn?.(
        `Could not move "${name}" out of db.json (${err.message}); using ` +
          "it from db.json for now, will retry moving it on the next restart.",
      );
    }
    return legacyValue;
  }

  return null;
}
