import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// SECURITY (2026-10-28, R1-12): on Windows the panel's 0o600 modes do
// nothing, so jwt.secret, the *.secret files, db.json and its backups took
// their folder's ACL. Under C:\ZomboidPanel (the docs' example) that is
// "every signed-in account may read and change", so another local account
// read jwt.secret and signed itself an admin session. Each secret file now
// keeps only the panel's account, SYSTEM and Administrators.
//
// The suite's per-file data folder is given an inheritable "Everyone: read"
// entry first, as a folder under C:\ has, so a file that merely inherits its
// folder's ACL is readable by everyone and the checks below catch it.

const isWindows = process.platform === "win32";

const icacls = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe");
let scratch;

// The file's DACL as SDDL (no localized account names).
function dacl(file) {
  const out = path.join(scratch, `acl-${Math.random().toString(36).slice(2)}.txt`);
  execFileSync(icacls, [file, "/save", out, "/Q"], { stdio: "ignore", windowsHide: true });
  return fs.readFileSync(out, "utf16le").split(/\r?\n/)[1] || "";
}

function currentUserSid() {
  const out = execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
  });
  return /"(S-1-[0-9-]+)"\s*$/.exec(out.trim())[1];
}

function expectOwnerOnly(file) {
  const sddl = dacl(file);
  expect(sddl, file).toMatch(/^D:P/); // inheritance removed
  expect(sddl, file).not.toMatch(/;ID;/); // no inherited entry left
  expect(sddl, file).not.toMatch(/;;;WD\)/); // not Everyone
  const sids = [...sddl.matchAll(/\(A;[^;]*;[^;]*;;;([^)]+)\)/g)].map((m) => m[1]).sort();
  expect(sids, file).toEqual([currentUserSid(), "BA", "SY"].sort());
}

describe.skipIf(!isWindows)("Windows secret files keep only the panel's account, SYSTEM and Administrators", () => {
  let dataDir;
  let db;

  beforeAll(async () => {
    process.env.PANEL_SECRET_FILE_ACLS = "1";
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-acl-out-"));
    const { getDataPaths } = await import("../utils/paths.js");
    dataDir = getDataPaths().dataDir;
    execFileSync(icacls, [dataDir, "/grant", "*S-1-1-0:(OI)(CI)(R)", "/Q"], { stdio: "ignore" });
    db = await import("../database/init.js");
    await db.getDb();
  });

  afterAll(() => {
    // process.env outlives this file in a shared worker.
    delete process.env.PANEL_SECRET_FILE_ACLS;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("the folder's own entries really reach a file that isn't restricted (control)", () => {
    const plain = path.join(dataDir, "plain.txt");
    fs.writeFileSync(plain, "x");
    expect(dacl(plain)).toMatch(/;ID;[^;]*;;;WD\)/);
  });

  it("jwt.secret", async () => {
    const { loadOrCreateJwtSecret, getJwtSecretPath } = await import("../utils/jwtSecret.js");
    delete process.env.JWT_SECRET;
    delete process.env.JWT_SECRET_FILE;
    const { secret } = await loadOrCreateJwtSecret();
    expectOwnerOnly(getJwtSecretPath());
    expect(fs.readFileSync(getJwtSecretPath(), "utf8")).toBe(secret); // still readable by the panel
  });

  it("a *.secret file, written directly and through the staged replace", async () => {
    const { writeUiSecretFile, replaceUiSecretFiles, readUiSecretFile } = await import("../utils/uiSecretFile.js");
    writeUiSecretFile("discordBotToken", "token-value");
    expectOwnerOnly(path.join(dataDir, "discordBotToken.secret"));
    replaceUiSecretFiles([["oidcClientSecret", "client-secret-value"]]);
    expectOwnerOnly(path.join(dataDir, "oidcClientSecret.secret"));
    expect(readUiSecretFile("oidcClientSecret")).toBe("client-secret-value");
  });

  // Adversary pass: db.json is replaced by a rename on every write, so an ACL
  // set on db.json once would be gone after the next write. It is set on the
  // temporary file the rename moves into place.
  it("db.json after a write, a server's RCON password file, and a backup copy", async () => {
    const server = await db.createServer({
      name: "Acl",
      serverName: "acl",
      installPath: path.join(scratch, "install"),
      rconPassword: "rcon-secret-value",
    });
    await db.setSetting("aclProbe", "1");
    await db.flushWrites();
    expectOwnerOnly(path.join(dataDir, "db.json"));
    const rconFile = fs
      .readdirSync(path.join(dataDir, "server-secrets"))
      .map((name) => path.join(dataDir, "server-secrets", name))
      .find((file) => fs.readFileSync(file, "utf8") === "rcon-secret-value");
    expect(rconFile, `RCON secret for ${server?.id}`).toBeTruthy();
    expectOwnerOnly(rconFile);
    const backup = await db.createDatabaseBackup();
    expect(backup.success).toBe(true);
    expectOwnerOnly(path.join(dataDir, "backups", backup.file));
  });

  // Adversary pass: files an earlier version wrote keep their folder's ACL
  // until the startup sweep.
  it("files an earlier version left behind, at startup", async () => {
    const { restrictExistingSecretFiles } = await import("../utils/secretFileAcl.js");
    const legacy = fs.mkdtempSync(path.join(scratch, "legacy data "));
    fs.mkdirSync(path.join(legacy, "server-secrets"));
    fs.mkdirSync(path.join(legacy, "backups"));
    const files = [
      path.join(legacy, "db.json"),
      path.join(legacy, "jwt.secret"),
      path.join(legacy, "steamLoginSecure.secret"),
      path.join(legacy, "server-secrets", "abc.secret"),
      path.join(legacy, "backups", "db-2026-01-01.json"),
    ];
    for (const file of files) fs.writeFileSync(file, "old");
    await restrictExistingSecretFiles(legacy);
    for (const file of files) expectOwnerOnly(file);
  });

  // Adversary pass: moving the data folder copies every file, and a copy
  // takes its new folder's ACL. (Last: it repoints this file's data folder.)
  it("the copies a data-folder move makes", async () => {
    const { setDataPaths } = await import("../utils/paths.js");
    execFileSync(icacls, [scratch, "/grant", "*S-1-1-0:(OI)(CI)(R)", "/Q"], { stdio: "ignore" });
    const target = path.join(scratch, "moved data");
    const result = await setDataPaths({ dataDir: target }, true);
    expect(result.success, result.error).toBe(true);
    for (const name of ["db.json", "jwt.secret", "discordBotToken.secret"]) {
      expectOwnerOnly(path.join(target, name));
    }
  });
});
