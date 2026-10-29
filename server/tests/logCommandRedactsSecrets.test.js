import { describe, expect, it } from "vitest";
import fs from "fs";

// bug-hunt-2026-08-27: proves the redaction actually reaches disk, not just
// the pure regex in isolation (rconCommandRedaction.test.js covers that).
// REAL, UNMOCKED database/init.js -- same per-file temp dataDir isolation
// as debugDatabaseRoutesRealExecution.test.js (vitest.perFileDataDir.setup.mjs,
// wired via vitest.config.js), so this never touches a real operator's
// db.json. Checks the FILE on disk, not just logCommand's return value --
// the whole point of the original defect was that the secret reached disk.

const { logCommand, getCommandHistory, flushWrites, getDb, compactDatabase } = await import("../database/init.js");
const { getDataPaths } = await import("../utils/paths.js");

describe("logCommand redacts RCON secrets before persisting", () => {
  it("never writes an adduser password to db.json on disk", async () => {
    const secret = "hunter2-super-secret";
    await logCommand(`adduser "Bob" "${secret}"`, "User added", true);
    await flushWrites(); // writes are debounced -- force the real disk write before reading it back

    const { dataDir } = getDataPaths();
    const dbPath = `${dataDir}/db.json`;
    const raw = fs.readFileSync(dbPath, "utf8");

    expect(raw).not.toContain(secret);
    expect(raw).toContain("[REDACTED]");
  });

  it("getCommandHistory (the data GET /history returns) also never surfaces the password", async () => {
    const secret = "another-real-password";
    await logCommand(`adduser "Alice" "${secret}"`, "User added", true);

    const history = await getCommandHistory(10);
    const serialized = JSON.stringify(history);

    expect(serialized).not.toContain(secret);
    expect(history.some((entry) => entry.command === 'adduser "Alice" "[REDACTED]"')).toBe(true);
  });

  it("a password-less adduser (no password argument at all) is stored verbatim -- nothing to redact", async () => {
    await logCommand('adduser "Carol"', "User added", true);

    const history = await getCommandHistory(10);
    expect(history.some((entry) => entry.command === 'adduser "Carol"')).toBe(true);
  });
});

// SECURITY (audit R1-8): unquoted arguments (what Discord /rcon always
// sends) and setpassword reached db.json in clear text, and rows logged
// before this fix are scrubbed when the database is loaded or compacted.
describe("logCommand redacts every password-carrying command form", () => {
  it("redacts the unquoted adduser Discord /rcon runs, and setpassword, on disk", async () => {
    await logCommand("adduser Dave discord-pass-1", "User added", true);
    await logCommand("setpassword Dave reset-pass-2", "Password changed", true);
    await flushWrites();

    const { dataDir } = getDataPaths();
    const raw = fs.readFileSync(`${dataDir}/db.json`, "utf8");
    expect(raw).not.toContain("discord-pass-1");
    expect(raw).not.toContain("reset-pass-2");
    const history = await getCommandHistory(10);
    expect(history.some((entry) => entry.command === 'setpassword Dave "[REDACTED]"')).toBe(true);
  });

  it("scrubs rows an older version stored with the password in clear", async () => {
    const db = await getDb();
    db.data.command_history.unshift({
      id: "old-row",
      server_id: null,
      command: "adduser Erin old-clear-pass",
      response: "echo: setpassword Erin old-clear-pass-2",
      success: 1,
      executed_at: new Date().toISOString(),
    });
    await compactDatabase();

    const { dataDir } = getDataPaths();
    const raw = fs.readFileSync(`${dataDir}/db.json`, "utf8");
    expect(raw).not.toContain("old-clear-pass");
    const row = (await getCommandHistory(50)).find((entry) => entry.id === "old-row");
    expect(row.command).toBe('adduser Erin "[REDACTED]"');
    expect(row.response).toBe('echo: setpassword Erin "[REDACTED]"');
  });
});
