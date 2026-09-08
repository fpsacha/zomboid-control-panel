import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

// 2026-09-08, kevin-third-instance-ms-named-artifacts sweep, god's follow-up:
// database/init.js's two corruption-forensics writers (pre-repair-<ts>.json
// in validateData(), corrupt-<ts>.json in getDb()'s db-read catch block) use
// the same bare-timestamp shape as every other collision-prone backup in
// this codebase, but are currently unreachable twice per process -- getDb()'s
// own `if (!db)` guard means the whole init sequence either sits inside runs
// at most once, and nothing resets the module-level `db` back to null to
// re-enter it. Fixed defensively anyway: unlike an ordinary backup, a
// collision here would silently destroy the ONLY record of the FIRST
// corruption -- exactly the evidence a user asking "what happened to my
// database" would need -- so it gets the same counter-suffix convention as
// every other timestamped backup rather than relying on that guard never
// changing (a repair route, a retry, a future refactor).
//
// This file tests validateData() DIRECTLY (exported for exactly this test)
// with a mocked Date.prototype.toISOString, rather than exercising the full
// getDb() singleton -- the singleton genuinely cannot be made to hit this
// path twice in one process, which is the whole point being defended
// against, not a gap in this test.
const { getDataPaths } = await import("../utils/paths.js");
const { dataDir } = getDataPaths();
const backupDir = path.join(dataDir, "backups");

function wrongTypedData(marker) {
  // `servers` defaults to an array -- passing a string forces validateData()
  // into its replacedKeys branch (the one that writes the pre-repair
  // snapshot), and the marker proves which call's DATA ended up in which
  // file.
  return { servers: `not-an-array-${marker}` };
}

describe("validateData() -- pre-repair forensics snapshot collision", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("two repairs detected in the same millisecond get distinct snapshot files, and neither overwrites the other", async () => {
    const { validateData } = await import("../database/init.js");
    fs.mkdirSync(backupDir, { recursive: true });
    for (const f of fs.readdirSync(backupDir)) {
      if (f.startsWith("pre-repair-")) fs.unlinkSync(path.join(backupDir, f));
    }

    const toISOString = vi
      .spyOn(Date.prototype, "toISOString")
      .mockReturnValue("2026-09-08T00-00-00-000Z");

    validateData(wrongTypedData("first"));
    validateData(wrongTypedData("second"));

    const snapshots = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith("pre-repair-") && f.endsWith(".json"))
      .sort();
    expect(snapshots).toHaveLength(2);

    const contents = snapshots.map((f) =>
      JSON.parse(fs.readFileSync(path.join(backupDir, f), "utf-8")),
    );
    expect(contents.map((c) => c.servers)).toEqual(
      expect.arrayContaining(["not-an-array-first", "not-an-array-second"]),
    );

    toISOString.mockRestore();
  });
});

describe("getDb() -- corrupt-db forensics snapshot collision", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Same defense as above, but for the OTHER forensics writer, and exercised
  // through two real (simulated) process boots rather than two direct calls
  // -- the realistic way this guard could ever actually matter is a repeat
  // corruption across restarts landing in the same mocked/frozen instant,
  // not two calls inside one live process.
  it("two corrupt-db.json boots in the same millisecond get distinct forensic copies, and neither overwrites the other", async () => {
    const { dbPath } = getDataPaths();
    fs.mkdirSync(backupDir, { recursive: true });
    for (const f of fs.readdirSync(backupDir)) {
      if (f.startsWith("corrupt-")) fs.unlinkSync(path.join(backupDir, f));
    }

    const toISOString = vi
      .spyOn(Date.prototype, "toISOString")
      .mockReturnValue("2026-09-08T00-00-00-000Z");

    fs.writeFileSync(dbPath, '{"servers": [ not valid json first', "utf-8");
    vi.resetModules();
    const { getDb: bootOne } = await import("../database/init.js");
    await bootOne();

    fs.writeFileSync(dbPath, '{"servers": [ not valid json second', "utf-8");
    vi.resetModules();
    const { getDb: bootTwo } = await import("../database/init.js");
    await bootTwo();

    const snapshots = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith("corrupt-") && f.endsWith(".json"))
      .sort();
    expect(snapshots).toHaveLength(2);

    const contents = snapshots.map((f) =>
      fs.readFileSync(path.join(backupDir, f), "utf-8"),
    );
    expect(contents).toEqual(
      expect.arrayContaining([
        '{"servers": [ not valid json first',
        '{"servers": [ not valid json second',
      ]),
    );

    toISOString.mockRestore();
  });
});
