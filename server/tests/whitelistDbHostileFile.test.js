import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { pathToFileURL } from "url";
import initSqlJs from "sql.js";
import { listServerRoleNames, listWhitelistAccounts } from "../utils/whitelistDb.js";

// vehicles audit (2026-10-28, R2-21/R2-22): db/<server>.db is the game
// server's file. A `role` or `whitelist` VIEW over an endless recursive CTE
// hung the panel (sql.js can't be interrupted), and a FIFO at that name
// pinned a libuv threadpool thread on every Players poll.

const IS_WIN = process.platform === "win32";
const MODULE_URL = pathToFileURL(path.resolve("server/utils/whitelistDb.js")).href;
const SERVER = "Hostile";

let SQL;
let root;

beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: (file) => path.resolve("node_modules/sql.js/dist", file),
  });
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-wldb-hostile-"));
  fs.mkdirSync(path.join(root, "db"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ENDLESS = "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c)";

function writeDb(sql) {
  const db = new SQL.Database();
  db.exec(sql);
  fs.writeFileSync(path.join(root, "db", `${SERVER}.db`), Buffer.from(db.export()));
  db.close();
}

function inChild(fnName) {
  const script = path.join(root, "probe.mjs");
  fs.writeFileSync(
    script,
    `import * as m from ${JSON.stringify(MODULE_URL)};
     const out = await m[${JSON.stringify(fnName)}](process.argv[2], process.argv[3]);
     process.stdout.write("\\nRESULT:" + JSON.stringify(out) + "\\n");
     process.exit(0);`,
  );
  const result = spawnSync(process.execPath, [script, root, SERVER], { encoding: "utf8", timeout: 20000 });
  const line = (result.stdout || "").split("\n").find((l) => l.startsWith("RESULT:"));
  return line ? JSON.parse(line.slice(7)) : { timedOut: true };
}

const WHITELIST_TABLE =
  "CREATE TABLE whitelist (id INTEGER, world TEXT, username TEXT, password TEXT, lastConnection TEXT, role INTEGER, authType INTEGER, steamid TEXT, ownerid TEXT, displayName TEXT)";

describe("server database with a hostile schema", () => {
  it("a `role` VIEW over an endless CTE is refused, not run", () => {
    writeDb(`${WHITELIST_TABLE}; CREATE VIEW role AS ${ENDLESS} SELECT n AS id, 'r' || n AS name FROM c`);
    const out = inChild("listServerRoleNames");
    expect(out.timedOut).toBeUndefined();
    expect(out).toMatchObject({ available: false, roleNames: [] });
  });

  it("a `whitelist` VIEW that never yields a row is refused, not run", () => {
    writeDb(
      `CREATE TABLE role (id INTEGER, name TEXT);
       CREATE VIEW whitelist AS ${ENDLESS} SELECT n AS id, 'w' || n AS world, NULL AS username, NULL AS lastConnection,
         2 AS role, 1 AS authType, NULL AS steamid, NULL AS ownerid, NULL AS displayName FROM c`,
    );
    const out = inChild("listWhitelistAccounts");
    expect(out.timedOut).toBeUndefined();
    expect(out).toMatchObject({ available: false, accounts: [] });
  });

  // Adversary: the optional allowedsteamid table as a view (its read is
  // wrapped in its own try/catch, which can't help against a hang).
  it("an `allowedsteamid` VIEW is refused too", () => {
    writeDb(
      `CREATE TABLE role (id INTEGER, name TEXT); ${WHITELIST_TABLE};
       CREATE VIEW AllowedSteamId AS ${ENDLESS} SELECT '7656119' || n AS steamid FROM c WHERE n < 0`,
    );
    const out = inChild("listWhitelistAccounts");
    expect(out.timedOut).toBeUndefined();
    expect(out).toMatchObject({ available: false, accounts: [] });
  });

  it("legit: plain tables still read", async () => {
    writeDb(
      `CREATE TABLE role (id INTEGER, name TEXT); ${WHITELIST_TABLE};
       INSERT INTO role VALUES (7, 'admin');
       INSERT INTO whitelist VALUES (1, '${SERVER}', 'Alice', 'pw', NULL, 7, 1, NULL, NULL, NULL);`,
    );
    expect(await listServerRoleNames(root, SERVER)).toMatchObject({ available: true });
    const accounts = await listWhitelistAccounts(root, SERVER);
    expect(accounts.available).toBe(true);
    expect(accounts.accounts).toEqual([expect.objectContaining({ username: "Alice", role: "admin" })]);
  });
});

describe("server database that is not a plain file", () => {
  it.skipIf(IS_WIN)("a FIFO is skipped without blocking a threadpool thread", async () => {
    const made = spawnSync("mkfifo", [path.join(root, "db", `${SERVER}.db`)]);
    expect(made.status).toBe(0);

    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => listServerRoleNames(root, SERVER)),
      ...Array.from({ length: 4 }, () => listWhitelistAccounts(root, SERVER)),
    ]);
    for (const r of results) expect(r.available).toBe(false);
    await fs.promises.readFile(path.resolve("package.json"));
  }, 10000);

  it.skipIf(IS_WIN)("a symlink is not followed", async () => {
    const elsewhere = path.join(root, "elsewhere.db");
    const db = new SQL.Database();
    db.exec("CREATE TABLE role (id INTEGER, name TEXT); INSERT INTO role VALUES (9, 'linked')");
    fs.writeFileSync(elsewhere, Buffer.from(db.export()));
    db.close();
    fs.symlinkSync(elsewhere, path.join(root, "db", `${SERVER}.db`));

    expect(await listServerRoleNames(root, SERVER)).toMatchObject({ available: false });
  });
});
