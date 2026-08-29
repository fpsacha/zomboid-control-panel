import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createUpdateDataBackup } from "../services/panelUpdateChecker.js";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("standalone update data safety", () => {
  it("snapshots the active database before an update", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-update-data-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "db.json");
    fs.writeFileSync(dbPath, '{"users":[{"username":"admin"}],"servers":[{"id":"main"}]}');

    const backupPath = createUpdateDataBackup({ dbPath }, "1.2.9");

    expect(backupPath).toMatch(/db\.json\.pre-update-1\.2\.9-/);
    expect(fs.readFileSync(backupPath, "utf8")).toBe(fs.readFileSync(dbPath, "utf8"));
  });

  it("does not create a snapshot for a fresh install", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-update-data-"));
    tempDirs.push(dir);
    expect(createUpdateDataBackup({ dbPath: path.join(dir, "db.json") }, "1.2.9")).toBeNull();
  });
});