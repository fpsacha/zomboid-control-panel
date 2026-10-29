/**
 * Windows access control for the panel's own secret files: jwt.secret, the
 * *.secret files (Discord token, OIDC client secret, Steam cookies, RCON
 * passwords under server-secrets/), db.json and its backup copies.
 *
 * SECURITY (2026-10-28): the 0o600/0o700 modes the writers set do nothing on
 * Windows, so each file took its folder's ACL. A folder made directly under
 * C:\ (the docs' own C:\ZomboidPanel example) lets every signed-in local
 * account read and change what is in it: another account on a shared host
 * read jwt.secret and signed itself an admin session. Each file now drops the
 * inherited entries and keeps only the panel's own account, SYSTEM and the
 * Administrators group, by SID so it works in every Windows language.
 *
 * Best-effort and never fatal: a file system without ACLs (FAT32, exFAT, some
 * network drives), a missing icacls or a failed account lookup leaves the
 * file as it was. icacls applies the whole change or none of it, so a failure
 * can't lock the panel out of its own file. Only files, never a folder the
 * user chose. A no-op off Windows, and in the test suite unless a test sets
 * PANEL_SECRET_FILE_ACLS=1 (every database write would spawn icacls).
 */

import { execFile, execFileSync } from "child_process";
import path from "path";

const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const TIMEOUT_MS = 5000;

let cachedUserSid;

export function secretFileAclsEnabled() {
  if (process.platform !== "win32") return false;
  if (process.env.VITEST) return process.env.PANEL_SECRET_FILE_ACLS === "1";
  return true;
}

// Full paths: a bare "icacls" is looked up in the current folder first.
function systemTool(name) {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", name);
}

// The SID the panel runs as (`whoami /user`), or null when it can't be read.
function currentUserSid() {
  if (cachedUserSid !== undefined) return cachedUserSid;
  try {
    const out = execFileSync(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /"(S-1-[0-9-]+)"\s*$/.exec(out.trim());
    cachedUserSid = match ? match[1] : null;
  } catch {
    cachedUserSid = null;
  }
  return cachedUserSid;
}

function icaclsArgs(target, sid) {
  return [
    target,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(F)`,
    `*${SYSTEM_SID}:(F)`,
    `*${ADMINISTRATORS_SID}:(F)`,
    "/Q",
  ];
}

/**
 * Restrict one secret file (or an icacls wildcard such as <dir>\*.secret)
 * now. For the rare writes: jwt.secret, a *.secret file, a backup copy.
 * Returns whether it was applied.
 */
export function restrictSecretFileSync(target) {
  if (!secretFileAclsEnabled()) return false;
  const sid = currentUserSid();
  if (!sid) return false;
  try {
    execFileSync(systemTool("icacls.exe"), icaclsArgs(target, sid), {
      timeout: TIMEOUT_MS,
      windowsHide: true,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The same without blocking: for db.json's temporary file, before the rename
 * that makes it db.json (a rename keeps the file's own ACL). Never rejects.
 */
export function restrictSecretFile(target) {
  if (!secretFileAclsEnabled()) return Promise.resolve(false);
  const sid = currentUserSid();
  if (!sid) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      execFile(
        systemTool("icacls.exe"),
        icaclsArgs(target, sid),
        { timeout: TIMEOUT_MS, windowsHide: true },
        (err) => resolve(!err),
      );
    } catch {
      resolve(false);
    }
  });
}

/**
 * Once at startup: the secret files an earlier version left with their
 * folder's ACL. Callers needn't wait; the promise never rejects.
 */
export function restrictExistingSecretFiles(dataDir) {
  if (!secretFileAclsEnabled() || typeof dataDir !== "string" || !dataDir) return Promise.resolve();
  return Promise.all(
    [
      path.join(dataDir, "db.json"),
      path.join(dataDir, "*.secret"),
      path.join(dataDir, "server-secrets", "*.secret"),
      path.join(dataDir, "backups", "*.json"),
    ].map((target) => restrictSecretFile(target)),
  ).then(() => undefined);
}
